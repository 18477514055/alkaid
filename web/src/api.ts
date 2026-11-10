/**
 * 前端只经 HTTP 访问内核，**不 import 任何 core 代码**（设计稿 §3 的依赖方向）。
 */

import type { MaintainerConfig, MemoryView, MemoryProposal, SubmitMemoryProposal } from '../../src/shared/memory.ts';
import type { ArchivePage, ArchiveQuery, ArchiveSnapshot, GoalTree, LessonSearch, MemoryIndex, MergePreservedInput, PreservedView } from '../../src/shared/memory-records.ts';
import type { ArtifactType, WorkbenchArtifact, WorkbenchView, TriageView, PrincipleCurrent, PrincipleProposal, IntentEntry, UserQuoteGroup, Handoff, ExtensionDefinition, ExtensionEntry, HandoffArtifact } from '../../src/shared/memory-workbench.ts';
import type { MemoryContextState, MemoryCheckpoint, CheckpointChoice, MemoryCapsule } from '../../src/shared/memory-context.ts';
import type { ObligationPage, ObligationQuery, ResolveObligationInput, ResolveObligationResult } from '../../src/shared/memory-obligations.ts';
import type { ExecutionBoard, UpdateExecutionBoard } from '../../src/shared/execution.ts';
import type { CompactionDuty, CompactionPlan, CompactionState, CompactionEventPage } from '../../src/shared/compaction.ts';
import type { RecallIndex, RecallIndexQuery, RecallMessagePage, RecallMessageQuery } from '../../src/shared/recall.ts';
import type { DutyState } from '../../src/shared/compaction-duties.ts';
import type { ChatMessage } from '../../src/shared/types.ts';
export type * from '../../src/shared/compaction.ts';
export type * from '../../src/shared/recall.ts';
import type { DelegationBoard } from '../../src/shared/delegation.ts';
import type { GeneralSettings, PanelSettings } from '../../src/shared/settings.ts';
import type { McpGroupMode, McpServerDto, PatchMcpServerInput, UpsertMcpServerInput } from '../../src/shared/mcp.ts';
export type { GeneralSettings, PanelSettings } from '../../src/shared/settings.ts';
// ★ 委派看板要的类型也从这里转出（组件只 import api.ts，不直接跨层 import shared/）
export type { Delegation, DelegationBoard, DelegationBoardEntry, DelegationStatus } from '../../src/shared/delegation.ts';
export type * from '../../src/shared/mcp.ts';

/** `GET/PATCH /api/settings` 的返回：通用设置 + 无项目对话的右栏设置 */
export type AppSettingsDto = { general: GeneralSettings; panel: PanelSettings };

/** `DELETE /api/projects/:id` 的返回 */
export type DeleteProjectResultDto = {
  deleted: boolean;
  removedFilesDir: string | null;
  filesRefusedReason: string | null;
  retainedAppendOnlyTables: readonly string[];
};
export type * from '../../src/shared/execution.ts';
export type * from '../../src/shared/memory-obligations.ts';
export type * from '../../src/shared/memory-records.ts';
export type * from '../../src/shared/memory-workbench.ts';
export type * from '../../src/shared/memory-context.ts';
export type { MaintainerConfig, MemoryJob, MemoryKind, MemoryProposal, MemoryRecord, MemoryView } from '../../src/shared/memory.ts';

export type ProviderDto = {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string | null;
  hasKey: boolean;
  /** 该模型声明的上下文窗口（tokens） */
  contextWindow: number;
  /** 对话里可选的模型白名单；`null` = 没设过（回退 defaultModel） */
  enabledModels: string[] | null;
  /** 模型列表路径（默认 models；有些网关 chat 与 models 前缀不同） */
  modelsPath?: string;
};

/** 内置服务商目录的一条（46 家，来自参照项目的 ProviderPreset 数据） */
export type PresetEndpointDto = {
  label: string;
  baseUrl: string;
  note: string;
  recommended: boolean;
};

export type ProviderPresetDto = {
  id: string;
  displayName: string;
  endpoints: PresetEndpointDto[];
  commonModels: string[];
  supportsModelList: boolean;
  modelsPathOverride: string;
  /** 静态默认请求头（不含密钥） */
  defaultHeaders: Record<string, string>;
  /** 需要「按对话固定」值的头名（空 = 不需要），如 x-opencode-session */
  sessionHeaderName: string;
  docUrl: string;
  note: string;
};

export type ModelInfoDto = { id: string; ownedBy: string | null };

export type ModelProbeDto = {
  ok: boolean;
  /**
   * **过滤后**的模型（只含这条连接在对话里允许选的）。
   * ★ 与 `catalog` 的区别很重要：用户只配了 1 个模型，但网关能列出几十个。
   *   对话里的选择器读 `models`，设置页挑选读 `catalog`。
   */
  models: ModelInfoDto[];
  /** 网关返回的**完整**目录（设置页用来勾选启用哪些） */
  catalog?: string[];
  latencyMs: number;
  status: number | null;
  error: string | null;
  hint: string | null;
  url: string;
};

/** 系统提示里的一段（界面用来回答"模型到底收到了什么"） */
export type PromptSectionDto = {
  id: string;
  sourceId: string;
  title: string;
  stability: 'static' | 'session' | 'turn';
  priority: number;
  chars: number;
  text: string;
};

export type PromptInfoDto = {
  text: string;
  sections: PromptSectionDto[];
  sources: Array<{ id: string; description: string; sectionIds: string[] }>;
  instructions: string | null;
  /** 程序派生的动态附加 user 消息；不是首条 system，也不是新的用户发言。 */
  contextMessages?: readonly ChatMessage[];
  /** 仅派生压缩回顾，不包含全部原始历史；原文应按需 recall。 */
  recoveryMessages?: readonly ChatMessage[];
};

export type ConversationDto = {
  id: string;
  title: string | null;
  providerId: string;
  model: string;
  permissionMode: string;
  state: string;
  lastSeq: number;
  projectId: string | null;
  primaryWorkspaceId: string | null;
  /** 非空 = 已置顶（值是置顶时刻） */
  pinnedAt: string | null;
  /** 非空 = 已归档 */
  archivedAt: string | null;
  /** 思考强度；null = 用默认 */
  thinkingEffort: string | null;
  /** ★ `'subagent'` = 这是某个主对话派出去的子代理（2026-11-10） */
  agentRole: 'main' | 'subagent';
  /** ★ 派它出来的父会话；主对话为 null。看板与「回主对话」都靠它 */
  parentConversationId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 会话可选项（置顶/归档/思考强度）—— 与后端 PATCH 的字段一一对应 */
export type ConversationPreferencePatch = {
  title?: string | null;
  model?: string;
  /** 传 ISO 时刻 = 置顶；传 null = 取消 */
  pinnedAt?: string | null;
  /** 传 ISO 时刻 = 归档；传 null = 还原 */
  archivedAt?: string | null;
  /** null = 用默认 */
  thinkingEffort?: string | null;
};

export type PluginDto = {
  id: string;
  name: string;
  status: 'ready' | 'failed' | 'disabled';
  error: string | null;
  toolNames: string[];
};

export type DisplayChannel = 'chat' | 'maintenance';
export type ToolCallDto = { id: string; name: string; arguments: string; displayChannel?: DisplayChannel };

/** 工具三态（与内核 `ToolMode` 一一对应） */
export type ToolModeDto = 'resident' | 'lazy' | 'disabled';

export type ToolSettingDto = {
  name: string;
  displayName: string;
  summary: string;
  oneLiner: string;
  kind: string;
  group: string;
  source: 'builtin' | 'plugin' | 'mcp';
  /** 用户当前的选择 */
  mode: ToolModeDto;
  /** 代码里的默认（用来标"已改过 / 默认"） */
  defaultMode: ToolModeDto;
  /** 工具是否真的存在于注册表（false = 插件卸载了但配置还留着） */
  available: boolean;
  /** 当前权限档下看不看得见（看不见 = 权限挡的，与三态无关） */
  visibleInMode: boolean;
  useCount: number;
  lastUsedAt: string | null;
};

export type ToolListDto = {
  permissionMode: string;
  tools: ToolSettingDto[];
  summary: { resident: number; lazy: number; disabled: number; toolTableChars: number };
};

export type ProjectDto = {
  id: string;
  name: string;
  description: string | null;
  sharedDir: string;
  archivedAt: string | null;
  /** 置顶时刻；`null` = 未置顶 */
  pinnedAt?: string | null;
};

export type WorkspaceDto = {
  id: string;
  name: string;
  rootPath: string;
  /** 置顶时刻；`null` = 未置顶 */
  pinnedAt?: string | null;
};

export type MessageDto = {
  id: string;
  seq: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning: string | null;
  toolCalls: ToolCallDto[] | null;
  /**
   * 工具消息对应的调用 id（`role === 'tool'` 时有值）。
   * ★ 后端一直在返回它，只是这个类型没跟上 —— 结果前端只能把「调用」和「输出」
   *   当成两条互不相干的消息分别渲染。有了它才能合成**一行**：展开看到输入与输出。
   */
  toolCallId?: string | null;
  usage: { input: number; output: number; cached?: number } | null;
  finishReason: string | null;
  createdAt: string;
  /** 展示分流不改变底层历史；缺省仍是普通对话。 */
  displayChannel?: DisplayChannel;
};

export type TurnEvent =
  | { type: 'user'; message: MessageDto }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'usage'; usage: { input: number; output: number } }
  | { type: 'assistant'; message: MessageDto }
  | { type: 'tool'; message: MessageDto }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'finish'; reason: string };

/**
 * 压缩失败的封闭枚举（与后端 `core/context/compact.ts` 的 `CompactionFailureCode` 一一对应）。
 *
 * ★ 为什么不直接吃后端的中文字符串：前端要回答的是"**要不要给重试**"，
 *   这只能由 `retryable` 决定；文案可以改，枚举不能。
 */
export type CompactionFailureCode = 'busy' | 'cancelled' | 'changed' | 'summary' | 'commit' | 'persistence' | 'blocked';

export type CompactionFailureDto = { code: CompactionFailureCode; message: string; retryable: boolean };

const COMPACTION_FAILURE_CODES: readonly string[] = ['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence', 'blocked'];
export type CompactionBlockedDto = { code: 'duties_incomplete'; missing: CompactionDuty[] };
export const COMPACTION_DUTY_LABEL: Readonly<Record<CompactionDuty, string>> = { ledger: '台账更新', log: '进展日志', triage: '分流（triage）' };
export type CompactResultDto = { compacted: boolean; reason?: string; compaction?: CompactionDto; blocked?: boolean; code?: 'duties_incomplete'; missing?: CompactionDuty[] };
export type CompactionStatusDto = {
  settings: { enabled: boolean; thresholdPercent: number }; contextTokens: number; contextWindow: number; ratio: number;
  duties: DutyState; plan: CompactionPlan;
} & CompactionState;
function compactionBlock(body: unknown): CompactionBlockedDto | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (raw.blocked !== true || raw.code !== 'duties_incomplete' || !Array.isArray(raw.missing)) return null;
  const kinds = ['ledger', 'log', 'triage'];
  if (!raw.missing.every((kind: unknown) => typeof kind === 'string' && kinds.includes(kind))) return null;
  return { code: 'duties_incomplete', missing: raw.missing as CompactionDuty[] };
}

export class ApiError extends Error {
  /** 后端回了结构化压缩失败（`{ error: { code, message, retryable } }`）时才有 */
  readonly compactionFailure: CompactionFailureDto | null;
  readonly compactionBlocked: CompactionBlockedDto | null;

  constructor(message: string, readonly status: number, compactionFailure: CompactionFailureDto | null = null, blocked: CompactionBlockedDto | null = null) {
    super(message);
    this.name = 'ApiError';
    this.compactionFailure = compactionFailure;
    this.compactionBlocked = blocked;
  }
}

/**
 * 解析错误响应体。**两种形态都要认**：
 * - `{ error: string }` —— 既有契约，多数路由还是这样；
 * - `{ error: { code, message, retryable } }` —— 压缩失败的结构化形态。
 */
function parseErrorBody(body: unknown): { message: string; failure: CompactionFailureDto | null } {
  if (typeof body !== 'object' || body === null || !('error' in body)) return { message: '', failure: null };
  const raw = (body as { error: unknown }).error;
  if (typeof raw === 'string') return { message: raw, failure: null };
  if (typeof raw !== 'object' || raw === null) return { message: String(raw), failure: null };
  const fields = raw as Record<string, unknown>;
  const message = typeof fields['message'] === 'string' ? fields['message'] : '';
  const code = fields['code'];
  if (typeof code !== 'string' || !COMPACTION_FAILURE_CODES.includes(code)) {
    // 认不出 code 就别假装认得出：只取人话，`retryable` 交给调用方按"未知"处理。
    return { message, failure: null };
  }
  return {
    message: message === '' ? code : message,
    failure: { code: code as CompactionFailureCode, message: message === '' ? code : message, retryable: fields['retryable'] === true },
  };
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}));
    const parsed = parseErrorBody(body);
    const message = parsed.message === '' ? `HTTP ${response.status}` : parsed.message;
    throw new ApiError(message, response.status, parsed.failure, compactionBlock(body));
  }
  return (await response.json()) as T;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<T>);
}

export type StepEventDto = {
  id: number;
  stepNo: number;
  kind: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

export type CompactionDto = {
  id: string;
  fromSeq: number;
  toSeq: number;
  summary: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
};

export type ConversationStatsDto = {
  turns: number;
  steps: number;
  /** 输入**总量** = 未缓存输入 + 缓存读取 + 缓存写入（上游 prompt_tokens 口径） */
  totalInput: number;
  /** 未命中缓存的输入量（三桶第一桶）；旧版后端没有这个字段 */
  totalUncachedInput?: number;
  totalOutput: number;
  /** 缓存**读取**量 */
  totalCached: number;
  /** 缓存**写入**量；没有任何一步报过就是 null（不拿 0 冒充）。旧版后端没有这个字段 */
  totalCachedWrite?: number | null;
  tokensPerSecond: number | null;
  totalTokens: number;
  cacheHitRate: number | null;
};

export type DashboardDto = {
  conversation: ConversationDto;
  messageCount: number;
  contextTokens: number;
  /** 该模型声明的上下文窗口 */
  contextWindow: number;
  /** 已用 / 窗口；窗口为 0 时是 null */
  contextRatio: number | null;
  stats: ConversationStatsDto;
  compactions: CompactionDto[];
  counts: Record<string, number>;
  events: StepEventDto[];
  workspace: { id: string; name: string; rootPath: string } | null;
  project: { id: string; name: string; sharedDir: string } | null;
};

export type StepUsageDto = {
  seq: number;
  at: string;
  finishReason: string | null;
  /** 输入**总量**（三桶之和） */
  input: number;
  /** 未命中缓存的输入量；旧版后端没有这个字段 */
  uncachedInput?: number;
  output: number;
  cached: number;
  /** 缓存写入量；没报过就没有这个字段 */
  cachedWrite?: number;
  durationMs: number | null;
  tokensPerSecond: number | null;
};

export type UsageDetailDto = {
  stats: ConversationStatsDto;
  steps: StepUsageDto[];
  stepCount: number;
  elapsedMs: number;
};

export type ArtifactInput = {
  [K in ArtifactType]: { conversationId: string; idempotencyKey: string; type: K; payload: Omit<Extract<WorkbenchArtifact, { $memory: K }>, '$memory'> }
}[ArtifactType];

function memoryUrl(projectId: string, path: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/memory${path}`;
}
function queryString(values: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.size ? `?${params}` : '';
}

export type MemoryCounts = { counts: WorkbenchView['counts'] & { preserved?: number; activeGoals?: number } };
export type MaterialMapDto = { materials: Array<{ recordId: string; kind: string; title: string; revision: number; chars: number; location: string; read: boolean; suggestedOrder: number }>; coverage: string };
export type CheckpointInput = { checkpointId: string; choice: CheckpointChoice; accept?: true; intent?: { goal: string; did: string; issues: string; next: string }; handoff?: Omit<HandoffArtifact, '$memory'> };
export type CheckpointResult = { checkpoint: MemoryCheckpoint; proposal?: MemoryProposal; compacted?: boolean; compaction?: CompactionDto; handoff?: unknown; blocked?: boolean; code?: 'duties_incomplete'; missing?: CompactionDuty[] };
export type LogQuery = { conversationId?: string; from?: string; to?: string; q?: string; limit?: number };

/** capability 仅在确认按钮的点击处理器中申请/消费，不存储、不预取。 */
async function humanPrincipleDecision(projectId: string, proposalId: string, operation: 'approve' | 'reject'): Promise<{ ok: true }> {
  const root = memoryUrl(projectId, `/principles/proposals/${encodeURIComponent(proposalId)}`);
  const options = { method: 'POST', mode: 'same-origin' as const, credentials: 'same-origin' as const,
    headers: { 'content-type': 'application/json', 'X-Alkaid-Human-Intent': 'principle-approval' } };
  const intent = await fetch(`${root}/approval-intent`, { ...options, body: JSON.stringify({ operation }) }).then(json<{ capability: string; expiresAt: string }>);
  return fetch(`${root}/${operation}`, { ...options, body: JSON.stringify({ capability: intent.capability }) }).then(json<{ ok: true }>);
}

export const api = {
  listProviders: (): Promise<ProviderDto[]> => fetch('/api/providers').then(json<ProviderDto[]>),

  /** 内置 46 家服务商目录（baseUrl / 常见模型 / 是否支持拉取模型列表） */
  listPresets: (): Promise<ProviderPresetDto[]> =>
    fetch('/api/providers/presets').then(json<ProviderPresetDto[]>),

  /** 对**未保存**的配置试一次 GET /models —— 保存前就知道 key 对不对 */
  probeProvider: (input: {
    baseUrl: string;
    apiKey: string;
    modelsPath?: string;
  }): Promise<ModelProbeDto> => postJson<ModelProbeDto>('/api/providers/probe', input),

  /** 对已保存的连接拉模型列表 */
  listModels: (providerId: string): Promise<ModelProbeDto> =>
    fetch(`/api/providers/${providerId}/models`).then(json<ModelProbeDto>),

  createProvider: (input: {
    name: string;
    baseUrl: string;
    apiKey: string;
    defaultModel?: string;
    modelsPath?: string;
    sessionHeader?: string;
    extraHeaders?: Record<string, string>;
  }): Promise<ProviderDto> => postJson<ProviderDto>('/api/providers', input),

  patchProvider: (
    providerId: string,
    patch: {
      name?: string;
      baseUrl?: string;
      modelsPath?: string;
      defaultModel?: string | null;
      apiKey?: string;
      contextWindow?: number;
      /** `null` = 清掉白名单（回退 defaultModel）；数组 = 只允许这几个 */
      enabledModels?: string[] | null;
    },
  ): Promise<ProviderDto> =>
    fetch(`/api/providers/${providerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<ProviderDto>),

  /** 只改上下文窗口 —— 底部状态栏「水位」用的那个数字 */
  patchProviderContextWindow: (providerId: string, contextWindow: number): Promise<ProviderDto> =>
    fetch(`/api/providers/${providerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contextWindow }),
    }).then(json<ProviderDto>),

  deleteProvider: (providerId: string): Promise<{ ok: boolean }> =>
    fetch(`/api/providers/${providerId}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),

  listConversations: (includeArchived?: boolean): Promise<ConversationDto[]> =>
    fetch(`/api/conversations${includeArchived === true ? '?includeArchived=1' : ''}`).then(
      json<ConversationDto[]>,
    ),

  listPlugins: (): Promise<PluginDto[]> => fetch('/api/plugins').then(json<PluginDto[]>),

  /** 工具清单与三态（设置页用）。`mode` 用来算「这一档看不看得见」 */
  listTools: (mode: string): Promise<ToolListDto> =>
    fetch(`/api/tools?mode=${encodeURIComponent(mode)}`).then(json<ToolListDto>),

  /** 改一个工具的三态。**只发一个名字 + 一个 mode**，不要整表提交 */
  setToolMode: (name: string, mode: ToolModeDto): Promise<{ ok: boolean; name: string; mode: ToolModeDto }> =>
    fetch(`/api/tools/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    }).then(json<{ ok: boolean; name: string; mode: ToolModeDto }>),

  /** 回到代码默认（删掉这一行配置） */
  resetToolMode: (name: string): Promise<{ ok: boolean; name: string; mode: ToolModeDto }> =>
    fetch(`/api/tools/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    }).then(json<{ ok: boolean; name: string; mode: ToolModeDto }>),

  /** 全部恢复默认 */
  resetAllTools: (): Promise<{ ok: boolean; cleared: number }> =>
    fetch('/api/tools/reset', { method: 'POST' }).then(json<{ ok: boolean; cleared: number }>),

  createConversation: (input: {
    providerId: string;
    model: string;
    title?: string;
    projectId?: string | null;
    workspaceId?: string | null;
    permissionMode?: string;
  }): Promise<ConversationDto> => postJson<ConversationDto>('/api/conversations', input),

  patchConversation: (
    conversationId: string,
    patch: ConversationPreferencePatch & {
      permissionMode?: string;
      projectId?: string | null;
      workspaceId?: string | null;
    },
  ): Promise<ConversationDto> =>
    fetch(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<ConversationDto>),

  /**
   * 修改**自己的**暂存提案文本（无需审批）。
   * ★ 只能改 title / content；`baseRevision`、kind、目标记录都不可改（服务端会 400）——
   *   否则"改文本"就成了绕过 CAS 与"改性质"的后门。
   * ★ 别人对话的提案 403、非 pending 409。
   */
  patchMemoryProposalText: (
    projectId: string,
    proposalId: string,
    conversationId: string,
    patch: { title?: string; content?: string },
  ): Promise<MemoryProposal> =>
    fetch(
      `/api/projects/${encodeURIComponent(projectId)}/memory/proposals/${encodeURIComponent(proposalId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, ...patch }),
      },
    ).then(json<MemoryProposal>),

  /**
   * 停止正在生成的那一轮。
   * ★ 幂等：没有在跑的一轮时服务端回 `{stopped:false}`，不报错（停止键会被连点）。
   * ★ 只中止这一轮，不动已落库的消息。
   */
  stopTurn: (conversationId: string): Promise<{ stopped: boolean }> =>
    postJson<{ stopped: boolean }>(`/api/conversations/${conversationId}/stop`, {}),

  /**
   * 排队一条"插话"：模型正在输出时用户还能把话递进去，下一个 step 之前注入。
   * ★ 上限 2000 字符（服务端定的），超了会被服务端拒绝 —— 它不是搬长文的通道。
   */
  queueSteering: (conversationId: string, content: string): Promise<{ queued: number }> =>
    postJson<{ queued: number }>(`/api/conversations/${conversationId}/steer`, { content }),


  /**
   * 从某条消息处分支出一个新会话。
   * ★ 只复制 user/assistant 正文（工具链不搬）—— 搬过去会立刻制造
   *   「assistant 带 tool_calls 却没有 tool 回复」那种坏历史。
   */
  branchConversation: (conversationId: string, uptoSeq: number): Promise<ConversationDto> =>
    postJson<ConversationDto>(`/api/conversations/${conversationId}/branch`, { uptoSeq }),

  /** 删除会话（不可恢复：消息、审计、压缩档案一起删） */
  deleteConversation: (conversationId: string): Promise<{ ok: boolean }> =>
    fetch(`/api/conversations/${conversationId}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),

  /** 让模型给会话起标题。
   * ★ `force: true` = 用户手动点「重新起名」，允许覆盖现有标题。
   * ★ 后端在「已有标题 / 没消息 / 上游失败」时都回 200 但不改名，所以这里不抛错。
   */
  generateTitle: (
    conversationId: string,
    force?: boolean,
  ): Promise<{ titled: boolean; title: string | null; reason: string | null }> =>
    postJson('/api/conversations/' + conversationId + '/title', force === true ? { force: true } : {}),

  getExecutionBoard: (projectId: string, conversationId: string, signal?: AbortSignal): Promise<ExecutionBoard> =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/execution/${encodeURIComponent(conversationId)}`, { signal }).then(json<ExecutionBoard>),
  patchExecutionBoard: (projectId: string, conversationId: string, input: UpdateExecutionBoard): Promise<ExecutionBoard> =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/execution/${encodeURIComponent(conversationId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(json<ExecutionBoard>),

  /**
   * 会话级执行看板：**没有项目的对话**也能有"当前目标 / 任务 / 动态"。
   * 服务端从会话行反查项目归属（无项目用空串哨兵），所以调用方不能伪造归属。
   */
  getConversationExecution: (conversationId: string, signal?: AbortSignal): Promise<ExecutionBoard> =>
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/execution`, { signal }).then(json<ExecutionBoard>),
  patchConversationExecution: (conversationId: string, input: UpdateExecutionBoard): Promise<ExecutionBoard> =>
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/execution`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(json<ExecutionBoard>),

  /**
   * ★ 委派看板：**一次请求拿全**——子代理树 + 每个子代理自己的目标/任务 + 共享任务板。
   *
   * 为什么不在前端拼：用户要求「一张看板同时看到各个子代理的进度、目标和任务」。
   * 拆成三个请求的话，前端要自己处理"其中一个失败"、自己算合并态，
   * 而且每加一项数据都要改前端。服务端一次拼好，前端只渲染。
   */
  getDelegations: (conversationId: string, signal?: AbortSignal): Promise<DelegationBoard> =>
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/delegations`, { signal }).then(json<DelegationBoard>),

  getMemoryPolicy: (projectId: string, signal?: AbortSignal): Promise<{ thresholdPercent: number }> =>
    fetch(memoryUrl(projectId, '/policy'), { signal }).then(json<{ thresholdPercent: number }>),
  patchMemoryPolicy: (projectId: string, thresholdPercent: number): Promise<{ thresholdPercent: number }> =>
    fetch(memoryUrl(projectId, '/policy'), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thresholdPercent }) }).then(json<{ thresholdPercent: number }>),

  /** 全项目历史义务：纯本地读取，summary 不受分页/来源筛选影响。 */
  getMemoryObligations: (projectId: string, query: ObligationQuery, signal?: AbortSignal): Promise<ObligationPage> =>
    fetch(memoryUrl(projectId, '/obligations') + queryString(query), { signal }).then(json<ObligationPage>),
  resolveMemoryObligation: (projectId: string, input: ResolveObligationInput): Promise<ResolveObligationResult> =>
    postJson<ResolveObligationResult>(memoryUrl(projectId, '/obligations/resolve'), input),

  getMemoryCounts: (projectId: string, signal?: AbortSignal): Promise<MemoryCounts> =>
    fetch(memoryUrl(projectId, '/workbench?view=counts'), { signal }).then(json<MemoryCounts>),
  getMemoryTriage: (projectId: string, q: string, signal?: AbortSignal): Promise<TriageView> =>
    fetch(memoryUrl(projectId, '/triage') + queryString({ q }), { signal }).then(json<TriageView>),
  getMemoryPrinciples: (projectId: string, signal?: AbortSignal): Promise<PrincipleCurrent> =>
    fetch(memoryUrl(projectId, '/principles/current'), { signal }).then(json<PrincipleCurrent>),
  getMemoryPrincipleProposals: (projectId: string, signal?: AbortSignal): Promise<PrincipleProposal[]> =>
    fetch(memoryUrl(projectId, '/principles/proposals'), { signal }).then(json<PrincipleProposal[]>),
  proposeMemoryPrinciple: (projectId: string, input: Pick<PrincipleProposal, 'recordId' | 'title' | 'content' | 'operation' | 'baseRevision'>): Promise<PrincipleProposal> =>
    postJson<PrincipleProposal>(memoryUrl(projectId, '/principles/proposals'), input),
  decideMemoryPrinciple: humanPrincipleDecision,
  getMemoryIntentLogs: (projectId: string, query: LogQuery, signal?: AbortSignal): Promise<IntentEntry[]> =>
    fetch(memoryUrl(projectId, '/logs') + queryString({ ...query, view: 'intents' }), { signal }).then(json<IntentEntry[]>),
  getMemoryUserQuotes: (projectId: string, query: LogQuery, signal?: AbortSignal): Promise<UserQuoteGroup[]> =>
    fetch(memoryUrl(projectId, '/logs') + queryString({ ...query, view: 'users' }), { signal }).then(json<UserQuoteGroup[]>),
  getMemoryHandoff: (projectId: string, handoffId: string, signal?: AbortSignal): Promise<Handoff> =>
    fetch(memoryUrl(projectId, `/handoffs/${encodeURIComponent(handoffId)}`), { signal }).then(json<Handoff>),
  memoryHandoffDownloadUrl: (projectId: string, handoffId: string): string =>
    memoryUrl(projectId, `/handoffs/${encodeURIComponent(handoffId)}/download`),
  memoryNoteDownloadUrl: (projectId: string, recordId: string): string =>
    memoryUrl(projectId, `/notes/${encodeURIComponent(recordId)}/download`),
  createMemoryExtension: (projectId: string, input: Pick<ExtensionDefinition, 'name' | 'description' | 'mode' | 'appendOnly'>): Promise<ExtensionDefinition> =>
    postJson<ExtensionDefinition>(memoryUrl(projectId, '/extensions'), input),
  getMemoryExtensionEntries: (projectId: string, extensionId: string, q: string, signal?: AbortSignal): Promise<ExtensionEntry[]> =>
    fetch(memoryUrl(projectId, `/extensions/${encodeURIComponent(extensionId)}/entries`) + queryString({ q, limit: 100 }), { signal }).then(json<ExtensionEntry[]>),
  getCompactionStatus: (conversationId: string, signal?: AbortSignal): Promise<CompactionStatusDto> =>
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/compaction-status`, { signal }).then(json<CompactionStatusDto>),
  getCompactionEvents: (conversationId: string, query: { limit?: number; offset?: number }, signal?: AbortSignal): Promise<CompactionEventPage> =>
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/compaction-events` + queryString(query), { signal }).then(json<CompactionEventPage>),
  recallIndex: (conversationId: string, query: RecallIndexQuery, signal?: AbortSignal): Promise<RecallIndex> =>
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/recall` + queryString({ mode: 'index', ...query }), { signal }).then(json<RecallIndex>),
  recallMessage: (conversationId: string, query: RecallMessageQuery, signal?: AbortSignal): Promise<RecallMessagePage> =>
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/recall` + queryString({ mode: 'message', ...query }), { signal }).then(json<RecallMessagePage>),
  getMemoryContextState: (conversationId: string, signal?: AbortSignal): Promise<MemoryContextState> =>
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/memory-state`, { signal }).then(json<MemoryContextState>),
  openMemoryCheckpoint: (conversationId: string): Promise<{ checkpoint: MemoryCheckpoint }> =>
    postJson<{ checkpoint: MemoryCheckpoint }>(`/api/conversations/${encodeURIComponent(conversationId)}/checkpoint`, {}),
  resolveMemoryCheckpoint: (conversationId: string, input: CheckpointInput): Promise<CheckpointResult> =>
    postJson<CheckpointResult>(`/api/conversations/${encodeURIComponent(conversationId)}/checkpoint/resolve`, input),
  getMemoryCapsules: (projectId: string, query: { conversationId?: string; fromSeq?: number; toSeq?: number; capsuleId?: string }, signal?: AbortSignal): Promise<{ capsules: MemoryCapsule[] }> =>
    fetch(memoryUrl(projectId, '/capsules') + queryString(query), { signal }).then(json<{ capsules: MemoryCapsule[] }>),
  getMemoryMaterialMap: (projectId: string, conversationId: string, signal?: AbortSignal): Promise<MaterialMapDto> =>
    fetch(memoryUrl(projectId, '/material-map') + queryString({ conversationId }), { signal }).then(json<MaterialMapDto>),
  getMemoryWorkbench: (projectId: string, signal?: AbortSignal): Promise<WorkbenchView> =>
    fetch(memoryUrl(projectId, '/workbench'), { signal }).then(json<WorkbenchView>),
  getMemoryArchive: (projectId: string, query: ArchiveQuery, signal?: AbortSignal): Promise<ArchivePage> =>
    fetch(memoryUrl(projectId, '/archive') + queryString(query), { signal }).then(json<ArchivePage>),
  getMemoryArchiveSnapshot: (projectId: string, historyId: string, side: 'before' | 'after', signal?: AbortSignal): Promise<ArchiveSnapshot> =>
    fetch(memoryUrl(projectId, `/archive/${encodeURIComponent(historyId)}`) + queryString({ side }), { signal }).then(json<ArchiveSnapshot>),
  getMemoryGoals: (projectId: string, signal?: AbortSignal): Promise<GoalTree> =>
    fetch(memoryUrl(projectId, '/goals'), { signal }).then(json<GoalTree>),
  getMemoryLessons: (projectId: string, query: { type?: 'lesson' | 'experience'; category?: string; q?: string }, signal?: AbortSignal): Promise<LessonSearch> =>
    fetch(memoryUrl(projectId, '/lessons') + queryString(query), { signal }).then(json<LessonSearch>),
  getMemoryIndex: (projectId: string, signal?: AbortSignal): Promise<MemoryIndex> =>
    fetch(memoryUrl(projectId, '/index'), { signal }).then(json<MemoryIndex>),
  getMemoryPreserved: (projectId: string, includeResolved = false, signal?: AbortSignal): Promise<PreservedView> =>
    fetch(memoryUrl(projectId, '/preserved') + queryString({ includeResolved }), { signal }).then(json<PreservedView>),
  submitMemoryProposal: (projectId: string, input: SubmitMemoryProposal): Promise<MemoryProposal> =>
    postJson<MemoryProposal>(memoryUrl(projectId, '/proposals'), input),
  mergeMemoryPreserved: (projectId: string, input: MergePreservedInput): Promise<MemoryProposal> =>
    postJson<MemoryProposal>(memoryUrl(projectId, '/preserved/merge'), input),
  submitMemoryArtifact: (projectId: string, input: ArtifactInput): Promise<MemoryProposal> =>
    postJson<MemoryProposal>(memoryUrl(projectId, '/artifacts'), input),

  /** 本地项目记忆投影；读取与轮询不调用模型。 */
  getMemory: (projectId: string, signal?: AbortSignal): Promise<MemoryView> =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/memory`, { signal }).then(json<MemoryView>),

  patchMemoryConfig: (projectId: string, config: MaintainerConfig): Promise<MaintainerConfig> =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/memory/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }).then(json<MaintainerConfig>),

  acceptMemoryProposal: (projectId: string, proposalId: string): Promise<{ ok: true }> =>
    postJson<{ ok: true }>(`/api/projects/${encodeURIComponent(projectId)}/memory/proposals/${encodeURIComponent(proposalId)}/accept`, {}),

  rejectMemoryProposal: (projectId: string, proposalId: string): Promise<{ ok: true }> =>
    postJson<{ ok: true }>(`/api/projects/${encodeURIComponent(projectId)}/memory/proposals/${encodeURIComponent(proposalId)}/reject`, {}),

  retryMemory: (projectId: string): Promise<MemoryView> =>
    postJson<MemoryView>(`/api/projects/${encodeURIComponent(projectId)}/memory/retry`, {}),

  listProjects: (): Promise<ProjectDto[]> => fetch('/api/projects').then(json<ProjectDto[]>),

  createProject: (input: { name: string; description?: string }): Promise<ProjectDto> =>
    postJson<ProjectDto>('/api/projects', input),

  listWorkspaces: (): Promise<WorkspaceDto[]> => fetch('/api/workspaces').then(json<WorkspaceDto[]>),

  createWorkspace: (input: { name: string; path: string }): Promise<WorkspaceDto> =>
    postJson<WorkspaceDto>('/api/workspaces', input),

  /** 重命名 / 置顶工作区。★ 只改登记，不动磁盘目录。 */
  updateWorkspace: (id: string, patch: { name?: string; pinned?: boolean }): Promise<WorkspaceDto> =>
    fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<WorkspaceDto>),

  /** ★ 只删登记，磁盘文件一律不动 */
  deleteWorkspace: (id: string): Promise<{ ok: true }> =>
    fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(json<{ ok: true }>),

  listArchivedProjects: (): Promise<ProjectDto[]> =>
    fetch('/api/projects?includeArchived=1').then(json<ProjectDto[]>),

  /** 重命名 / 归档 / 置顶项目 */
  updateProject: (
    id: string,
    patch: { name?: string; description?: string | null; archived?: boolean; pinned?: boolean },
  ): Promise<ProjectDto> =>
    fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<ProjectDto>),

  /**
   * 删除项目。`deleteFiles` 决定是否连共享目录一起删（默认 false = 只删登记）。
   * ★ 服务端有路径守卫：共享目录若不在程序自建位置，会拒绝删文件并在
   *   `filesRefusedReason` 里说明 —— 界面上要把这句话显示出来。
   */
  deleteProject: (id: string, deleteFiles = false): Promise<DeleteProjectResultDto> =>
    fetch(`/api/projects/${encodeURIComponent(id)}${deleteFiles ? '?deleteFiles=1' : ''}`, {
      method: 'DELETE',
    }).then(json<DeleteProjectResultDto>),

  /* ------------------------------ 应用设置 ------------------------------ */

  getSettings: (): Promise<AppSettingsDto> => fetch('/api/settings').then(json<AppSettingsDto>),

  patchSettings: (patch: {
    general?: Partial<GeneralSettings>;
    panel?: Partial<PanelSettings>;
  }): Promise<AppSettingsDto> =>
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<AppSettingsDto>),

  getProjectSettings: (projectId: string): Promise<{ panel: PanelSettings }> =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/settings`).then(json<{ panel: PanelSettings }>),

  patchProjectSettings: (projectId: string, panel: Partial<PanelSettings>): Promise<{ panel: PanelSettings }> =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panel }),
    }).then(json<{ panel: PanelSettings }>),

  /* -------------------------------- MCP -------------------------------- */

  listMcpServers: (): Promise<McpServerDto[]> => fetch('/api/mcp/servers').then(json<McpServerDto[]>),

  createMcpServer: (input: UpsertMcpServerInput): Promise<McpServerDto> =>
    postJson<McpServerDto>('/api/mcp/servers', input),

  patchMcpServer: (id: string, patch: PatchMcpServerInput): Promise<McpServerDto> =>
    fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<McpServerDto>),

  deleteMcpServer: (id: string): Promise<{ ok: true }> =>
    fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(json<{ ok: true }>),

  /** 重新连接并重新注册该服务器的工具 */
  reconnectMcpServer: (id: string): Promise<McpServerDto> =>
    postJson<McpServerDto>(`/api/mcp/servers/${encodeURIComponent(id)}/reconnect`, {}),

  /** ★ 批量：把该服务器的**全部工具**一次设成同一模式（一个 MCP 动辄几十个工具） */
  setMcpGroupMode: (id: string, mode: McpGroupMode): Promise<McpServerDto> =>
    postJson<McpServerDto>(`/api/mcp/servers/${encodeURIComponent(id)}/mode`, { mode }),

  listMessages: (conversationId: string): Promise<MessageDto[]> =>
    fetch(`/api/conversations/${conversationId}/messages`).then(json<MessageDto[]>),

  getDashboard: (conversationId: string): Promise<DashboardDto> =>
    fetch(`/api/conversations/${conversationId}/dashboard`).then(json<DashboardDto>),

  /** 系统提示的实际内容与分段构成（只读） */
  getPrompt: (conversationId: string, signal?: AbortSignal): Promise<PromptInfoDto> =>
    fetch(`/api/conversations/${conversationId}/prompt`, { signal }).then(json<PromptInfoDto>),

  /** 会话级用户自定义指令（注入 system 提示的独立段） */
  updateInstructions: (conversationId: string, instructions: string | null): Promise<ConversationDto> =>
    fetch(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instructions }),
    }).then(json<ConversationDto>),

  /** 底部状态栏「点开看详情」：逐步用量明细（默认最近 200 步） */
  getUsage: (conversationId: string, limit?: number): Promise<UsageDetailDto> =>
    fetch(
      `/api/conversations/${conversationId}/usage${limit === undefined ? '' : `?limit=${String(limit)}`}`,
    ).then(json<UsageDetailDto>),

  /**
   * 手动压缩。
   * ★ 成功时 `{ compacted, reason?, compaction? }`；失败时抛 `ApiError`，
   *   若后端给的是结构化压缩失败，`ApiError.compactionFailure` 里有 `{ code, message, retryable }`。
   */
  compact: (
    conversationId: string,
    keepRecent?: number,
  ): Promise<CompactResultDto> =>
    postJson<CompactResultDto>(
      `/api/conversations/${conversationId}/compact`,
      keepRecent === undefined ? {} : { keepRecent },
    ),
};

/**
 * 发一条消息并消费 SSE 流。
 * 解析规则与后端同源：`data: <json>`，事件之间用空行分隔。
 */
export async function sendMessage(
  conversationId: string,
  content: string,
  onEvent: (event: TurnEvent) => void,
): Promise<void> {
  /**
   * ★ 不再由前端传 `maxSteps`：上限现在由**服务端设置**决定
   *   （`app_settings` 的 `general.maxStepsPerTurn`，支持 `null` = 不限制）。
   *   前端传一份、服务端存一份会立刻分叉 —— 用户改了设置但这一轮还用旧值。
   */
  const response = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (!response.ok || response.body === null) {
    const body: unknown = await response.json().catch(() => ({}));
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    onEvent({ type: 'error', message, retryable: false });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
      if (line === undefined) continue;
      try {
        onEvent(JSON.parse(line.slice(6)) as TurnEvent);
      } catch {
        // 半个帧不该发生（服务端保证整帧写出），静默跳过比崩掉好
      }
    }
  }
}
