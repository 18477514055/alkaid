import type { DatabaseSync } from 'node:sqlite';

import {
  DELEGATE_DEFAULT_MAX_STEPS,
  DELEGATE_MAX_PER_TURN,
  DELEGATE_RESULT_MAX_CHARS,
  type Delegation,
} from '../../shared/delegation.ts';
import { runTurn, type TurnEvent } from './loop.ts';
import { countRunningDelegations, finishDelegation, getDelegation, listDelegations, startDelegation } from './delegation.ts';
import { getConversation, getProvider } from '../store/repo.ts';
import { getSecret } from '../secrets.ts';
import { createProviderFromRow } from '../model/factory.ts';
import { delegateModelKey } from '../../shared/settings.ts';
import { getGeneralSettings } from '../settings/service.ts';
import type { ToolDefinition, ToolRegistry } from '../tools/types.ts';

/**
 * **`delegate` 工具** —— 模型侧唯一的委派入口（spawn 模式）。
 *
 * ## ★ 为什么只有一个工具，而不是 "spawn / send / wait / cancel" 四个
 *
 * DSH 那边是 `tool-subagent` 一个工具 + 一套 runtime（`D6@L455`：一个模型侧工具，
 * 背后 `ctx.subagents` provider 管生命周期）。我们照这个形状做，但**刻意更窄**：
 *
 * - **不支持"给子代理发后续消息"**：DSH 的 `sendMessage` 是给"同一棵子代理树里
 *   持续交互"用的（`D6@L474`）。那需要 activation 状态机 + inbox，是 Team 那一层的活。
 *   现在做等于先把一半的 Team 造出来，而用户要的 Team 是**共享任务板**形态。
 * - **不支持后台跑**：`delegate` 同步等子代理跑完（有步数上限保证它会结束）。
 *   理由：Alkaid 是单进程单线程跑 SSE，后台任务需要 job 系统 + 完成通知 + 孤儿清理，
 *   是另一笔账。现在同步跑，语义最简单：**工具返回时，结果已经是真的**。
 *
 * ## ★★ 三条边界（不做会出事的那种）
 *
 * 1. **子代理的结论必须写回父会话**（作为那条 tool 结果）—— 这是"结果交付"的契约。
 *    工具返回值本身就是回执，所以父会话下一轮就能看到。
 * 2. **单轮最多派 `DELEGATE_MAX_PER_TURN` 个**：防止模型一口气 fan-out 出几十个会话
 *    把库撑爆（每次委派都是一个真会话 + 若干消息）。
 * 3. **默认步数上限比主会话小**：委派是"把一件事交出去"，不是"再开一个能无限跑的自己"。
 *    父会话设了"不限制"也**不自动继承** —— 否则一次委派能烧掉没有上限的钱。
 */

export type DelegateOptions = {
  /** 用来给子代理签发 provider；不传则从库里取 */
  readonly secretsPath?: string;
  /**
   * **子代理允许用的模型白名单**（读自全局设置，2026-11-10 用户要求）。
   *
   * 三态语义见 `shared/settings.ts` 的 `delegateAllowedModels`：
   * `null` = 不限制、`[]` = 一个都不许（只能跟主对话同模型）、非空 = 只允许这些。
   *
   * ★ 为什么做成**读时传入**而不是工具自己去查库：
   *   工具在 `createDefaultRegistry` 里构造，那时还没有会话上下文；
   *   而白名单是**全局设置**，一次构造时读一次就够（同一轮里不会变）。
   *   更重要的是：把它作为参数传进来，测试就能直接覆盖三态而不用造设置行。
   */
  readonly allowedModels?: readonly string[] | null;
  /**
   * 是否允许把**主对话自己在用的那个模型**派给子代理（默认 `true`）。
   * ★ 与 `allowedModels` 是两个独立的旋钮：见 `shared/settings.ts` 的组合判据表。
   */
  readonly allowParentModel?: boolean;
  /**
   * ★ 工具注册表 **getter**（2026-11-11 审计 `CRITICAL-02`）。
   *
   * 为什么是 getter 而不是直接给注册表：`delegate` 这个工具本身是在
   * `createDefaultRegistry` 里被注册进去的 —— 构造它的时候注册表还没建完，
   * 直接传会拿到 undefined（或者要先造一个空壳再往里塞，更难读）。
   * 闭包到变量上、调用时再取，就绕开了这个先有鸡还是先有蛋。
   */
  readonly getTools?: () => ToolRegistry;
  /** 测试替换点：真实实现是 `runTurn` */
  readonly runner?: (input: {
    readonly db: DatabaseSync;
    readonly conversationId: string;
    readonly userText: string;
    readonly provider: ReturnType<typeof createProviderFromRow>;
    readonly signal: AbortSignal;
    readonly maxSteps: number;
    readonly agentRole: 'subagent';
    /** 子代理要用的工具面（与主对话同一个注册表，`createSurface` 会按 subagent 过滤） */
    readonly tools?: ToolRegistry;
    readonly workspacePath?: string | null;
    readonly projectSharedDir?: string | null;
    readonly tempDir?: string;
    /** 思考字段形状（跟随所选连接）——漏传会让上游 400 或把 reasoning 当正文 */
    readonly thinkingShape?: string | null;
    /** 工具输出截断上限（跟随主对话的设置）——漏传会退回默认值，与用户设置不一致 */
    readonly maxToolOutputChars?: number | null;
  }) => AsyncGenerator<TurnEvent>;
};

/** 从子代理的事件流里抽取"最终结论" */
function collectResult(events: readonly TurnEvent[]): { text: string; reason: string } {
  let text = '';
  let reason = 'error';
  for (const event of events) {
    if (event.type === 'text') text += event.delta;
    else if (event.type === 'assistant') {
      // 子代理最后一条 assistant 的正文是它"交上来的东西"
      if (event.message.content !== null && event.message.content.length > 0) text = event.message.content;
    } else if (event.type === 'finish') reason = event.reason;
  }
  return { text, reason };
}

export function createDelegateTool(db: DatabaseSync, options: DelegateOptions = {}): ToolDefinition {
  const runner = options.runner ?? ((input) => runTurn(input));

  return {
    name: 'delegate',
    displayName: '派一个子代理去做',
    source: 'builtin',
    group: 'context',
    kind: 'write_local',
    // ★ 按需：它不常被调用，而工具定义占缓存前缀
    preferredMode: 'lazy',
    oneLiner: '把一个独立、可交付的任务交给子代理去做，等它做完拿回结论；子代理看不到当前对话',
    description: [
      '把一个**独立、自洽、能一次做完**的任务交给子代理。子代理是一个真实的独立会话：',
      '它有自己干净的上下文（**看不到当前对话的任何内容**）、自己的工具表，干完把结论交回来。',
      '',
      '什么时候该用：任务可以整块交出去、不需要来回确认、做完能一句话说清结果',
      '（例如"把这三个文件里的旧 API 全部改成新 API 并跑测试"、"调研 X 并写出结论"）。',
      '什么时候不该用：需要与用户来回确认的、要改当前对话正在改的同一批文件的（会和你自己打架）、',
      '或者你只是想读一个文件（直接用 read，不要为一个读操作开一个会话）。',
      '',
      '★ 子代理**不能**：写项目记忆、登记台账、操作执行看板、再派子代理。它只交结果。',
      '★ 任务描述要**自足**：它看不到你的对话，所以文件路径、验收标准、约束都要写进 task。',
      '★ 这条调用会**等**子代理跑完才返回（所以别指望靠它并行做很多事；单轮最多派 4 个）。',
      '★ 想让它更久地干，显式给 maxSteps；不给就用默认值。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          minLength: 1,
          maxLength: 4_000,
          description: '要它做的完整任务说明。必须自足：它看不到当前对话。',
        },
        title: {
          type: 'string',
          maxLength: 200,
          description: '给看板看的一句话标题（例如"改完 fs 工具的旧 API"）。不给就取 task 前 40 字。',
        },
        maxSteps: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: `这个子代理最多跑几步。默认 ${String(DELEGATE_DEFAULT_MAX_STEPS)}。`,
        },
        /**
         * ★ 2026-11-10 用户要求：主对话**可以给子代理选别的模型**（不只是自己那个）。
         *   两个字段都要给全 —— 只给 model 不知道是哪家连接；
         *   而不同连接下可能有同名模型，只按名字解析会把请求发错地方。
         *   不给就沿用主对话的 provider + model。
         */
        providerId: {
          type: 'string',
          maxLength: 200,
          description: '子代理用哪个已注册的模型连接。不给就沿用当前对话的连接。必须与 model 一起给。',
        },
        model: {
          type: 'string',
          maxLength: 200,
          description: '子代理用哪个模型。不给就沿用当前对话的模型。受设置里的「子代理模型白名单」限制。',
        },
      },
    },
    modes: ['workspace', 'project', 'workspace_project', 'full'],
    async execute(rawArgs, ctx) {
      if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        return { ok: false, code: 'invalid_arguments', message: 'delegate 需要一个对象参数' };
      }
      const args = rawArgs as Record<string, unknown>;
      const allowed = new Set(['task', 'title', 'maxSteps', 'providerId', 'model']);
      for (const key of Object.keys(args)) {
        if (!allowed.has(key)) {
          return { ok: false, code: 'invalid_arguments', message: `delegate 不接受参数 ${key}` };
        }
      }

      // ★ providerId 与 model 必须成对：只给一半无法定位到具体模型（不同连接可有同名模型）
      const wantProvider = typeof args['providerId'] === 'string' ? args['providerId'].trim() : '';
      const wantModel = typeof args['model'] === 'string' ? args['model'].trim() : '';
      if ((wantProvider.length === 0) !== (wantModel.length === 0)) {
        return {
          ok: false,
          code: 'invalid_arguments',
          message: 'providerId 与 model 必须一起给（只给一半无法确定具体模型：不同连接下可以有同名模型）。',
          hint: '都不给就沿用当前对话的模型；要给就两个都写。',
        };
      }

      const task = typeof args['task'] === 'string' ? args['task'].trim() : '';
      if (task.length === 0) return { ok: false, code: 'invalid_arguments', message: 'task 必填' };
      if (task.length > 4_000) {
        return {
          ok: false,
          code: 'invalid_arguments',
          message: `task 过长（${String(task.length)} > 4000）。请把细节写进文件，task 里只给要点与路径。`,
        };
      }

      // ★ 子代理不能再派子代理：树的深度必须有界，否则一次"递归派活"能把库和账单一起炸掉。
      //   判据来自会话行本身（`agent_role`），不信任调用方传来的任何东西。
      if (ctx.agentRole === 'subagent' || getConversation(db, ctx.conversationId)?.agentRole === 'subagent') {
        return {
          ok: false,
          code: 'delegate_forbidden',
          message: '子代理不能再派子代理。请把这件事做完并把结论交回父对话，由父对话决定是否继续拆分。',
          hint: '不要重复尝试；直接做你能做的那部分，其余在结论里说明。',
        };
      }

      // ★ 单轮最多派几个：防止一口气 fan-out 出几十个会话
      const running = countRunningDelegations(db, ctx.conversationId);
      if (running >= 1) {
        return {
          ok: false,
          code: 'delegate_busy',
          message: '已经有一个子代理在跑了。这一版是**串行**委派：等它回来再派下一个。',
          hint: '不要重试；先看已有子代理的结论，再决定要不要继续派。',
        };
      }
      /**
       * ★ 单轮扇出上限（2026-11-11 审计 `HIGH-04` 修的）。
       *
       * 原来这里是 `const perTurn = listDelegations(...).length; void perTurn; void DELEGATE_MAX_PER_TURN;`
       * —— 常量被 `void` 掉，等于**这条限制从未生效**（模型可以一轮里无限串行地派）。
       *
       * 判据必须是**这一轮**派了几个，而不是"历史上派过几个"：
       * 用 `ctx.turnUserSeq` 找到本轮那条 user 消息的时刻，只数它之后建的委派。
       * 拿不到 seq（理论上不该发生）就退化成"最近一分钟"，宁可多放行也不要误伤正常委派。
       */
      const turnStart = (() => {
        if (ctx.turnUserSeq === undefined) return new Date(Date.now() - 60_000).toISOString();
        const row = db.prepare('SELECT created_at FROM messages WHERE conversation_id = ? AND seq = ?')
          .get(ctx.conversationId, ctx.turnUserSeq) as { created_at?: string } | undefined;
        return row?.created_at ?? new Date(Date.now() - 60_000).toISOString();
      })();
      const perTurn = (db.prepare(
        'SELECT COUNT(*) AS n FROM delegations WHERE parent_conversation_id = ? AND created_at >= ?',
      ).get(ctx.conversationId, turnStart) as { n: number }).n;
      if (perTurn >= DELEGATE_MAX_PER_TURN) {
        return {
          ok: false,
          code: 'delegate_limit',
          message: `这一轮已经派了 ${String(perTurn)} 个子代理，达到上限 ${String(DELEGATE_MAX_PER_TURN)}。`,
          hint: '把剩下的事合并成更少的委派，或等这一轮结束后再派。',
        };
      }

      const conversation = getConversation(db, ctx.conversationId);
      if (conversation === undefined) {
        return { ok: false, code: 'conversation_missing', message: '当前会话不存在' };
      }

      /**
       * ★★ 选哪个模型（2026-11-10 用户要求：主对话可以给子代理选**别的**已注册模型）。
       *
       * 判据顺序是刻意的：
       * 1. 没指定 ⇒ 沿用主对话（原来的行为，零回归）；
       * 2. 指定了 ⇒ 先查白名单，再查连接是否存在、有没有 Key。
       *    **白名单先查**：否则模型会从"找不到连接"里读出"这个模型不存在"，
       *    然后换个名字再试 —— 而真实原因是它不在允许范围内。
       */
      let childProviderId = conversation.providerId;
      let childModel = conversation.model;
      if (wantProvider.length > 0 && wantModel.length > 0) {
        const key = delegateModelKey(wantProvider, wantModel);
        /**
         * ★ 2026-11-11 审计 `HIGH-02` 修的：**调用时**才去读设置。
         *
         * 原来只认构造时传进来的 `options.allowedModels`，而 `main.ts` 压根没传
         * ⇒ 生产环境的白名单永远是"不限制"，且运行期改了设置也不生效（闭包是旧的）。
         * 现在：显式传入（测试覆盖三态用）> 库里的全局设置 > 不限制。
         */
        const liveGeneral = options.allowedModels === undefined ? getGeneralSettings(db) : null;
        const allow = options.allowedModels !== undefined
          ? options.allowedModels
          : liveGeneral?.delegateAllowedModels ?? null;
        /**
         * 白名单三态：
         * - `null` ⇒ 不限制（默认）
         * - `[]` ⇒ 一个都不许（只能跟主对话同模型）—— 与"不限制"必须分得开
         * - 非空 ⇒ 只允许列出的键
         */
        if (allow !== null) {
          /**
           * ★★ "主对话自己在用的那一对"是否特殊对待（用户 2026-11-10 的独立开关）：
           *   `delegateAllowParentModel === true`（默认）⇒ 它**永远视作在白名单内**；
           *   `false` ⇒ 它像别的模型一样必须过白名单（空数组时就不许）。
           *
           * 判据为什么这样定：用户设空数组的意图是"别乱选"，不是"让我连自己都在用的
           * 模型都选不了" —— 所以默认放行自己那一对。但用户明确关掉这个开关时，
           * 他要的就是"连我自己也不给"，那必须照办。
           */
          const sameAsParent = wantProvider === conversation.providerId && wantModel === conversation.model;
          // ★ 同理（HIGH-02）：没显式传就**当场**读设置，而不是沿用构造时的快照
          const allowParentModel = options.allowParentModel
            ?? liveGeneral?.delegateAllowParentModel
            ?? true;
          const parentExempt = allowParentModel && sameAsParent;
          if (!parentExempt && !allow.includes(key)) {
            return {
              ok: false,
              code: 'delegate_model_not_allowed',
              message:
                allow.length === 0
                  ? '设置里的「子代理模型」白名单是空的：子代理只能用当前对话自己的模型。不要换模型，或让用户去设置里加白名单。'
                  : `模型 ${wantModel}（连接 ${wantProvider}）不在「子代理模型」白名单里。可选的只有设置中列出的那些。`,
              hint: '不要反复换模型试；要么沿用当前对话的模型（不传 providerId/model），要么让用户加白名单。',
            };
          }
        }

        const wanted = getProvider(db, wantProvider);
        if (wanted === undefined) {
          return {
            ok: false,
            code: 'provider_missing',
            message: `指定的模型连接不存在：${wantProvider}`,
            hint: '用「设置 → 模型」里已有的连接 id。不要猜。',
          };
        }
        /**
         * ★ 连接若设了 `enabledModels` 白名单，子代理也要遵守它 ——
         *   否则「连接只允许 3 个模型」这个限制会被一条委派轻松绕过。
         */
        if (wanted.enabledModels !== null && !wanted.enabledModels.includes(wantModel)) {
          return {
            ok: false,
            code: 'delegate_model_not_allowed',
            message: `这个连接（${wanted.name}）只允许这些模型：${wanted.enabledModels.join(', ')}。${wantModel} 不在其中。`,
          };
        }
        childProviderId = wanted.id;
        childModel = wantModel;
      }

      const providerRow = getProvider(db, childProviderId);
      if (providerRow === undefined) {
        return { ok: false, code: 'provider_missing', message: '当前会话绑定的模型连接不存在' };
      }
      if (options.secretsPath === undefined) {
        return {
          ok: false,
          code: 'delegate_unavailable',
          message: '委派需要一个 API Key 路径；服务端没有配置（这是实现问题，不是你的参数问题）。',
        };
      }
      const apiKey = getSecret(options.secretsPath, providerRow.id);
      if (apiKey === undefined) {
        return { ok: false, code: 'provider_missing', message: '模型连接缺少 API Key，无法为子代理签发调用' };
      }

      const maxSteps =
        typeof args['maxSteps'] === 'number' && Number.isInteger(args['maxSteps']) && args['maxSteps'] > 0
          ? Math.min(args['maxSteps'], 200)
          : DELEGATE_DEFAULT_MAX_STEPS;
      const title = typeof args['title'] === 'string' && args['title'].trim().length > 0 ? args['title'].trim() : '';

      let started: { delegation: Delegation; childConversationId: string };
      try {
        started = startDelegation(db, {
          parentConversationId: ctx.conversationId,
          task,
          title,
          providerId: providerRow.id,
          // ★ 用选定的子代理模型（可能是主对话之外的那个），不是 `conversation.model`
          model: childModel,
          permissionMode: conversation.permissionMode,
          projectId: conversation.projectId,
          primaryWorkspaceId: conversation.primaryWorkspaceId,
        });
      } catch (error) {
        return {
          ok: false,
          code: 'delegate_failed',
          message: `没能创建子代理会话：${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const provider = createProviderFromRow(providerRow, apiKey, started.childConversationId);
      const events: TurnEvent[] = [];
      try {
        for await (const event of runner({
          db,
          conversationId: started.childConversationId,
          userText: task,
          provider,
          // ★ 子代理继承父会话的取消信号：用户点停止，子代理也停 —— 否则他会看到一个
          //   "已经停了但还在烧钱"的后台进程。
          signal: ctx.signal,
          maxSteps,
          agentRole: 'subagent',
          /**
           * ★★ 2026-11-11 审计 `CRITICAL-02`：这四样**必须**一起传下去。
           *
           * `runTurn` 不会自己去库里反查工作区/项目目录，也不自己建工具面 —— 它只认 `options`。
           * 原来这里只传了 db/conversationId/userText/provider/signal/maxSteps，
           * 结果**生产环境里的子代理是一个没有任何工具、没有任何目录的裸聊机器人**
           * （`surface === undefined` ⇒ `providerTools = []` ⇒ 系统提示里写着"当前可调用工具：无"）。
           *
           * 为什么单元测试没抓到：它们全都注入了假 `runner`，或者只断言"没继承父历史"，
           * 没有一条用真实注册表跑过子代理能不能调 `read`。
           */
          tools: options.getTools?.(),
          workspacePath: ctx.workspacePath,
          projectSharedDir: ctx.projectSharedDir,
          tempDir: ctx.tempDir,
          /**
           * ★ 这两项漏了会有真实后果（2026-11-11 审计 `ALK-HIGH-03`）：
           * - `thinkingShape`：子代理拿不到父连接声明的思考字段形状 ⇒ 上游可能 400 或把
           *   reasoning 当正文回显；
           * - `maxToolOutputChars`：子代理会退回默认上限，与用户在设置里调的值不一致 ——
           *   同样的命令在主对话里被截断、在子代理里不截断，排查时非常误导。
           */
          thinkingShape: providerRow.thinkingShape,
          maxToolOutputChars: ctx.maxToolOutputChars,
        })) {
          events.push(event);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = finishDelegation(db, started.delegation.id, {
          status: ctx.signal.aborted ? 'cancelled' : 'failed',
          error: message,
        });
        return {
          ok: false,
          code: 'delegate_failed',
          message: `子代理没跑完：${message}`,
          hint: '这是子代理自己的过程出错，不是你的参数问题；看板里能看到它做到哪一步。',
          ...(failed === undefined ? {} : {}),
        };
      }

      const { text, reason } = collectResult(events);
      if (ctx.signal.aborted || reason === 'abort') {
        finishDelegation(db, started.delegation.id, { status: 'cancelled', error: '用户中止了这一轮' });
        return {
          ok: false,
          code: 'delegate_cancelled',
          message: '子代理被中止了（这一轮被取消）。它的过程仍在库里，可点开看做到哪一步。',
        };
      }
      if (reason === 'error') {
        finishDelegation(db, started.delegation.id, { status: 'failed', error: '子代理这一轮以错误结束' });
        return { ok: false, code: 'delegate_failed', message: '子代理这一轮以错误结束，没有可用结论。' };
      }

      const resultText = text.trim();
      finishDelegation(db, started.delegation.id, { status: 'completed', result: resultText });

      /**
       * ★ 返给模型的内容要**够用且不啰嗦**：
       *   它已经知道任务是什么（那是它自己写的），所以只回标题 + 结论 + 去哪看全过程。
       *   截断在 `DELEGATE_RESULT_MAX_CHARS` 之内（父上下文是稀缺资源）。
       */
      const clipped = resultText.length > DELEGATE_RESULT_MAX_CHARS ? `${resultText.slice(0, DELEGATE_RESULT_MAX_CHARS)}\n…（结论过长已截断，完整内容在子会话里）` : resultText;
      return {
        ok: true,
        // ★ `conclude` 不在这里用：子代理干完不等于**父对话**这一轮干完了
        //   （父对话通常还要汇总/继续），那是 A1 的语义边界，别越界。
        content: JSON.stringify({
          delegationId: started.delegation.id,
          childConversationId: started.childConversationId,
          title: started.delegation.title,
          status: 'completed',
          result: clipped,
          note: '这是子代理交回的结论。它的完整过程在 childConversationId 对应的会话里；右侧看板能看到它的目标与任务。',
        }),
      };
    },
  };
}

/** 供看板/路由复用 */
export { getDelegation };
