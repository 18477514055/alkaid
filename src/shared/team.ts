/**
 * Agent Team 共享任务板的**跨层契约**（纯类型 + 常量，无副作用）。
 *
 * ## ★ 为什么板归属于 **root 会话**，而不是项目/工作区
 *
 * 板要回答的是"这一摊活谁在干什么"。这个"谁"是**主对话**，
 * 不是项目（项目是长期记忆的作用域，跨很多轮甚至很多天），
 * 也不是工作区（一个工作区可以同时有很多不相关的活）。
 * 子代理是临时工：它们加入主对话那块板，而不是各开一块。
 *
 * ## ★★ 为什么 `write_scopes` 只是**建议**
 *
 * DSH 原话："Write-scope overlap is advisory, not a lock."
 * 真锁的代价：两个代理在同一串文件上互相等待，谁都不肯先动，活直接卡死；
 * 而"谁认领了什么、谁完成了什么"的记账价值**并不依赖**锁。
 * ⇒ 认领时发现重叠只回一条 `warning`，**绝不拒绝**。
 *
 * ## ★ 为什么模型侧只有一个 `team_tasks` 工具
 *
 * 工具表里的**每个条目都吃缓存前缀**（每一轮都要重发）。
 * 拆成 create/claim/complete/list/update 五个工具 = 同一段 schema 发五遍。
 * ⇒ 用 `action` 分派，和 `execution_board` 完全一致的做法。
 */

/** 卡片状态。`pending`（没人干，可被认领）/ `in_progress`（已被认领）/ `completed`。 */
export const TEAM_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

/** 事件的操作者。`model` = 模型（含子代理）；`user` = 真人通过界面/接口改的。 */
export const TEAM_EVENT_ACTORS = ['model', 'user'] as const;
export type TeamEventActor = (typeof TEAM_EVENT_ACTORS)[number];

/**
 * 事件种类 —— 与状态变化一一对应。
 *
 * ★ `kind` 只有这四种：状态机是**建卡 → 认领 → 完成**，中间的任何改动都算 `updated`。
 *   多一个 kind 就多一份"历史上到底发生过什么"的解释成本。
 */
export const TEAM_EVENT_KINDS = ['created', 'claimed', 'updated', 'completed'] as const;
export type TeamEventKind = (typeof TEAM_EVENT_KINDS)[number];

/**
 * 一块板最多这么多张卡（对齐 DSH 的 `DEFAULT_MAX_TASKS = 256`，`team/agent-team/src/index.ts:32`）。
 *
 * ★ 为什么要有上限：板上每张卡都会被 `list` 读出来发给模型。
 *   无上限时，"256 张卡"与"3000 张卡"在模型眼里都是"一坨"，但它付的钱不一样。
 */
export const TEAM_MAX_TASKS = 256;

/** 单次 `create` 最多建几张（避免一次工具调用把整块板塞满）。 */
export const TEAM_MAX_CREATE_BATCH = 64;

export const TEAM_MAX_SUBJECT = 200;
export const TEAM_MAX_DESCRIPTION = 2000;
export const TEAM_MAX_WRITE_SCOPES = 20;
export const TEAM_MAX_SCOPE = 200;
export const TEAM_MAX_BLOCKED_BY = 20;
export const TEAM_MAX_ACTIVITY = 500;
export const TEAM_MAX_TASK_ID = 64;

/** `list` 最多回多少张卡：优先回**未完成**的，再回最近的已完成。 */
export const TEAM_DELIVERED_TASKS = 50;
/** 工具交付时只带最近这么多条事件（完整历史留在库里）。 */
export const TEAM_DELIVERED_EVENTS = 10;
/** `readBoard` 默认读最近这么多条事件。 */
export const TEAM_STORED_EVENTS = 30;
/** 单块板的事件上限（历史只追加，所以必须有天花板）。 */
export const TEAM_MAX_EVENTS = 5000;

/** 一张卡。`owner` 是**会话 id**，不是人、不是项目。 */
export type TeamTask = {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TeamTaskStatus;
  readonly owner: string | null;
  /** 每次改动 +1；改动前必须带 `baseRevision`，不符即冲突。 */
  readonly revision: number;
  /** 真依赖：这些卡全部 completed 之后，本卡才可被认领。 */
  readonly blockedBy: readonly string[];
  /** **建议**的写作用域（文件/目录前缀）。重叠只警告，不阻止。 */
  readonly writeScopes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type TeamTaskEvent = {
  readonly id: string;
  readonly taskId: string;
  readonly revision: number;
  readonly actor: TeamEventActor;
  readonly kind: TeamEventKind;
  readonly text: string;
  readonly createdAt: string;
};

export type TeamBoard = {
  readonly rootConversationId: string;
  /** 板级 revision：任何一次改动 +1（便于"这条回执是不是最新的"这种粗判）。 */
  readonly revision: number;
  /** 卡片，未完成在前、其余按 `created_at`；**可能被截到 50 张**。 */
  readonly tasks: readonly TeamTask[];
  /** 板上真实卡数 —— 与 `tasks.length` 不一致就说明被截了。 */
  readonly totalTasks: number;
  readonly truncated: boolean;
  readonly events: readonly TeamTaskEvent[];
  readonly updatedAt: string | null;
};

/** `create` 时一条新卡。`id` 可省（自动生成）；给了才能在同批 `blockedBy` 里被引用。 */
export type NewTeamTask = {
  readonly id?: string;
  readonly subject: string;
  readonly description?: string;
  readonly blockedBy?: readonly string[];
  readonly writeScopes?: readonly string[];
};

/** `update` 能改的字段（工具侧只开放 `status`，核心层保留完整补丁面）。 */
export type TeamTaskPatch = {
  readonly subject?: string;
  readonly description?: string;
  readonly blockedBy?: readonly string[];
  readonly writeScopes?: readonly string[];
  readonly status?: TeamTaskStatus;
};
