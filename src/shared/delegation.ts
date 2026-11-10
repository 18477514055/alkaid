/**
 * **子代理（spawn 模式）的共享契约** —— 服务端 / 工具 / 前端看板共用。
 *
 * ## ★ 为什么只做 spawn，不做 fork
 *
 * `reports/dsh/D6-plugin-system-subagents.md` §2.7.3（`D6@L476`）的结论原文：
 * > Alkaid 最便宜的路是 **spawn 模式**（新会话、零继承），因为 `runTurn(db, conversationId, ...)`
 * > 已经是"给一个会话跑一轮"的无状态函数…**fork 模式对 Alkaid 是禁区**：消息表里没有
 * > "seed 前缀"概念，fork 必然要在数据库里复制一份历史。
 *
 * 所以我们只做 spawn：子代理 = **一个真实的新会话**（`agent_role='subagent'`），
 * 零继承父上下文，干完把结论作为一条 tool 结果写回父会话。
 *
 * ## ★★ 结果怎么回来：不是返回值，是**一条消息**
 *
 * DSH 的做法（`D6@L472`）：`tool-subagent` 只返回 child id，**runtime own result delivery**
 * —— 子代理完成时由 runtime 往父会话追加一条消息。
 * 这是刻意的：委派一旦可以"跑很久"，工具调用就不能同步等它（那会把父轮次钉死）。
 * Alkaid 的做法与之同构，但**更简单**：子代理跑完后，把结论作为**父会话的一条 tool 消息**
 * 写回去（父会话下一轮就能看到），同时把完整子会话留在库中可查。
 *
 * ## ★ 三条边界（都是"不做会出事"的）
 *
 * 1. **零继承**：子代理看不到父会话的任何历史（`loop.ts` 已经对 `agentRole='subagent'`
 *    做了隔离：不带摘要、不带项目记忆、不带义务闸门）。这条不能松 ——
 *    一旦继承，父会话的压缩摘要/台账就会被子代理的结论污染。
 * 2. **不写项目记忆 / 不登记台账 / 不操作执行看板**：这些是"主对话的身份"，
 *    子代理只交出结果。多处代码已经按 `agentRole` 排除了（`tools/index.ts`、`execution.ts`、
 *    `memory/store.ts`），本文件只把这条写进契约文档。
 * 3. **必须可收敛**：子代理继承父会话的步数上限设置，且**默认更小**（见 `DELEGATE_DEFAULT_MAX_STEPS`）。
 *    理由：委派是"把一件事交出去"，不是"再开一个可以无限跑的自己"。
 */

/** 子代理状态。`running` 只有真在跑时才是；进程崩溃后停在 `running` 的会被当 `interrupted` 处理 */
export const DELEGATION_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

export const DELEGATION_STATUS_LABEL: Readonly<Record<DelegationStatus, string>> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '中断（进程退出）',
};

/**
 * 一次委派。
 *
 * ★ `childConversationId` 是**真实会话**的 id —— 点开它就是完整的子代理过程（消息全在库里）。
 *   这不是"日志"，是可以像任何会话那样读的历史。看板靠它给出"子代理当前在干什么"。
 */
export type Delegation = {
  readonly id: string;
  /** 派活的父会话 */
  readonly parentConversationId: string;
  /** 子代理自己的会话（agent_role='subagent'） */
  readonly childConversationId: string;
  /** 委派时给的任务说明（父会话里那句原文，便于看板显示"让它干什么"） */
  readonly task: string;
  /** 简报式标题（模型给的一句话，给看板用） */
  readonly title: string;
  readonly status: DelegationStatus;
  /** 子代理的最终结论（截断后）；未完成为 null */
  readonly result: string | null;
  /** 失败/中断原因；成功为 null */
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 结束时写入 */
  readonly finishedAt: string | null;
};

/**
 * 看板用的聚合视图：**一棵委派树 + 各自的目标/任务**。
 *
 * ★ 为什么要有这一层：用户的要求是「一张看板同时看到各个子代理的当前工作进度、
 *   目标和任务，以及它们之间的共享任务板」。前端不该打好几个请求再自己拼 ——
 *   那样每加一处数据就要改一次前端。这里在服务端一次拼好。
 */
export type DelegationBoardEntry = {
  readonly delegation: Delegation;
  /** 子代理会话的当前执行看板（目标/任务/动态）—— 它自己的"我在干什么" */
  readonly execution: {
    readonly goal: { readonly title: string; readonly status: string; readonly summary: string } | null;
    readonly tasks: readonly { readonly id: string; readonly content: string; readonly status: string }[];
    readonly revision: number;
  } | null;
  /** 子代理消息条数（一眼看出"跑了多少"） */
  readonly messageCount: number;
  /** 最后一条消息的时间（用来判断"是不是卡住了"） */
  readonly lastMessageAt: string | null;
};

export type DelegationBoard = {
  readonly parentConversationId: string;
  /** 这一棵委派树全部子代理（按创建时间） */
  readonly entries: readonly DelegationBoardEntry[];
  /** 共享任务板的快照（Team）；没有就是 null —— **子代理自己没有共享板**，见下 */
  readonly team: {
    readonly revision: number;
    readonly tasks: readonly {
      readonly id: string;
      readonly subject: string;
      readonly status: string;
      readonly owner: string | null;
      readonly ownerKind: 'main' | 'subagent' | 'unknown';
    }[];
  } | null;
};

/**
 * 子代理**没有自己的共享任务板**。
 *
 * ★ 用户的原话（2026-11-10）：「子代理似乎就没有共享任务看板这个东西。」
 *   **这条是对的，而且是设计使然，不是漏做**：
 *   共享任务板的语义是"**一棵委派树的根**拥有它，多个代理在同一块板上认领互不重叠的活"。
 *   子代理是**被派出去的**，它自己再派活属于新的一层树；如果每个子代理都能开一块板，
 *   那就退化成"每人一本账"，谁也看不到全局 —— 与"共享"两字正好相反。
 *   ⇒ 子代理只**认领/完成** root 那块板上的卡，**不能**建板。
 *   这条在 `core/team/board.ts` 里以"只有 main 会话能建板"的形式实现。
 */
export const SUBAGENTS_HAVE_NO_OWN_BOARD = true;

/**
 * 委派默认步数上限。
 *
 * ★ 判据：委派是"把一件事交出去"，不是"再开一个可以无限跑的自己"。
 *   父会话可能被用户设成"不限制"（`maxStepsPerTurn: null`），但**不自动传递** ——
 *   否则一次委派就可能烧掉没有上限的钱。子代理要更长就显式传。
 */
export const DELEGATE_DEFAULT_MAX_STEPS = 24;

/** 同一条消息里最多能派几个（防止模型一口气 fan-out 出几十个会话把库撑爆） */
export const DELEGATE_MAX_PER_TURN = 4;

/** 子代理结论写回父会话时，最多保留多少字符（父上下文是稀缺资源） */
export const DELEGATE_RESULT_MAX_CHARS = 4_000;
