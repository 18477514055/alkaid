import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { ToolCall, Usage } from '../../shared/types.ts';

/**
 * 仓储层：**唯一碰 SQL 的地方**。上层的业务代码拿到的都是普通对象。
 *
 * 约定：
 * - 所有时间存 ISO8601 字符串（UTC），排序就直接是时间序。
 * - 所有 ID 是 `randomUUID()`，不拿文件名/序号当身份（任务书 §十二.8）。
 * - JSON 列（tool_calls / usage / extra_headers）在这里序列化，上层永远拿对象。
 */

export type ProviderRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly baseUrl: string;
  readonly chatPath: string;
  readonly modelsPath: string;
  readonly defaultModel: string | null;
  readonly extraHeaders: Record<string, string> | null;
  readonly thinkingShape: string;
  readonly supportsStreamUsage: boolean;
  readonly usesMaxCompletionTokens: boolean;
  /** 该模型声明的上下文窗口（tokens）。V3 起有值；老库升级后是默认 128000 */
  readonly contextWindow: number;
  /**
   * 需要「按对话固定」的会话头名（如 `x-opencode-session`）。V4 起有值。
   * ★ 只存**头名**，值在请求时用 conversationId 填 —— 随机值比不带更糟（路由与缓存全失效）。
   */
  readonly sessionHeader: string | null;
  /** 对话里可选的模型白名单；`null` = 没设过（回退 defaultModel），`[]` = 显式清空 */
  readonly enabledModels: string[] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ConversationRow = {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly primaryWorkspaceId: string | null;
  readonly providerId: string;
  readonly model: string;
  readonly permissionMode: string;
  readonly state: string;
  readonly lastSeq: number;
  /** Runtime-owned identity. Public conversation APIs cannot create/elevate subagents. */
  readonly agentRole: 'main' | 'subagent';
  /**
   * 派它出来的父会话（只有子代理才有；主对话为 `null`）。
   *
   * ★ 为什么放在**会话行**而不只存在 `delegations` 表：会话列表、看板、孤儿清理
   *   都要能"从子会话直接知道它的父亲"，多一次 join 就多一处可能漏。
   *   `delegations` 记的是"这次委派"（含任务、状态、结论），这一列记的是"归属"。
   */
  readonly parentConversationId: string | null;
  /** 会话级用户自定义指令（注入 system 提示的独立段） */
  readonly instructions: string | null;
  /** 非空 = 已置顶（值是置顶时刻，用来在多个置顶之间排序） */
  readonly pinnedAt: string | null;
  /** 非空 = 已归档（软删；消息与审计全留着，只是默认不在主列表出现） */
  readonly archivedAt: string | null;
  /** 思考强度；null = 用 provider/模型默认 */
  readonly thinkingEffort: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type MessageRow = {
  readonly id: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly displayChannel?: 'chat' | 'maintenance';
  readonly content: string | null;
  readonly reasoning: string | null;
  readonly toolCalls: readonly ToolCall[] | null;
  readonly toolCallId: string | null;
  readonly usage: Usage | null;
  readonly finishReason: string | null;
  readonly createdAt: string;
};

type Raw = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function int(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toProvider(row: Raw): ProviderRow {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    kind: row['kind'] as string,
    baseUrl: row['base_url'] as string,
    chatPath: row['chat_path'] as string,
    modelsPath: row['models_path'] as string,
    defaultModel: text(row['default_model']),
    extraHeaders: parseJson<Record<string, string>>(row['extra_headers']),
    thinkingShape: row['thinking_shape'] as string,
    supportsStreamUsage: int(row['supports_stream_usage']) === 1,
    usesMaxCompletionTokens: int(row['uses_max_completion_tokens']) === 1,
    contextWindow: row['context_window'] === undefined || row['context_window'] === null ? 128_000 : int(row['context_window']),
    sessionHeader: text(row['session_header']),
    /**
     * 对话里可选的模型白名单。
     * ★ `null` 与 `[]` 语义不同（见 schema.ts 的 V10 注释）：
     *   null = 没设过 ⇒ 回退到 defaultModel；[] = 用户显式清空 ⇒ 一个都不给。
     *   所以这里不能把 null 也归一成 []，否则"没设过"会变成"被清空"。
     */
    enabledModels: parseJson<string[]>(row['enabled_models']),
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function toConversation(row: Raw): ConversationRow {
  return {
    id: row['id'] as string,
    projectId: text(row['project_id']),
    title: text(row['title']),
    primaryWorkspaceId: text(row['primary_workspace_id']),
    providerId: row['provider_id'] as string,
    model: row['model'] as string,
    permissionMode: row['permission_mode'] as string,
    state: row['state'] as string,
    lastSeq: int(row['last_seq']),
    agentRole: row['agent_role'] === 'subagent' ? 'subagent' : 'main',
    // ★ 老库（V15 之前）没有这一列 ⇒ 取到 null，不猜成"有父会话"
    parentConversationId: text(row['parent_conversation_id']),
    instructions: text(row['instructions']),
    // ★ 老库（V9 之前）取不到这几列时给 null，不给空串 —— 空串会被前端当成"有值"
    pinnedAt: text(row['pinned_at']),
    archivedAt: text(row['archived_at']),
    thinkingEffort: text(row['thinking_effort']),
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function toMessage(row: Raw): MessageRow {
  return {
    id: row['id'] as string,
    conversationId: row['conversation_id'] as string,
    seq: int(row['seq']),
    role: row['role'] as MessageRole,
    displayChannel: row['display_channel'] === 'maintenance' ? 'maintenance' : 'chat',
    content: text(row['content']),
    reasoning: text(row['reasoning']),
    toolCalls: parseJson<ToolCall[]>(row['tool_calls']),
    toolCallId: text(row['tool_call_id']),
    usage: parseJson<Usage>(row['usage']),
    finishReason: text(row['finish_reason']),
    createdAt: row['created_at'] as string,
  };
}

// ─────────────────────────── providers ───────────────────────────

export type NewProvider = {
  readonly name: string;
  readonly baseUrl: string;
  readonly kind?: string;
  readonly chatPath?: string;
  readonly modelsPath?: string;
  readonly defaultModel?: string | null;
  readonly extraHeaders?: Record<string, string> | null;
  readonly thinkingShape?: string;
  readonly supportsStreamUsage?: boolean;
  readonly usesMaxCompletionTokens?: boolean;
  readonly contextWindow?: number;
  readonly sessionHeader?: string | null;
};

export function insertProvider(db: DatabaseSync, input: NewProvider): ProviderRow {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO providers (id, name, kind, base_url, chat_path, models_path, default_model,
       extra_headers, thinking_shape, supports_stream_usage, uses_max_completion_tokens,
       context_window, session_header, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.kind ?? 'openai_compatible',
    input.baseUrl,
    input.chatPath ?? 'chat/completions',
    input.modelsPath ?? 'models',
    input.defaultModel ?? null,
    input.extraHeaders === undefined || input.extraHeaders === null ? null : JSON.stringify(input.extraHeaders),
    input.thinkingShape ?? 'effort_only',
    input.supportsStreamUsage === false ? 0 : 1,
    input.usesMaxCompletionTokens === true ? 1 : 0,
    input.contextWindow ?? 128_000,
    input.sessionHeader === undefined || input.sessionHeader === null || input.sessionHeader.length === 0
      ? null
      : input.sessionHeader,
    now,
    now,
  );

  const created = getProvider(db, id);
  if (created === undefined) throw new Error('插入 provider 后读不回来');
  return created;
}

export function getProvider(db: DatabaseSync, id: string): ProviderRow | undefined {
  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? undefined : toProvider(row);
}

export function listProviders(db: DatabaseSync): ProviderRow[] {
  const rows = db.prepare('SELECT * FROM providers ORDER BY created_at ASC').all() as Raw[];
  return rows.map(toProvider);
}

export function deleteProvider(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

/** 改 provider 的可编辑字段。目前只开放上下文窗口 —— 其余字段（baseUrl 等）改了要重验，不在这里做。 */
export function updateProviderContextWindow(db: DatabaseSync, id: string, contextWindow: number): ProviderRow | undefined {
  db.prepare('UPDATE providers SET context_window = ?, updated_at = ? WHERE id = ?').run(
    contextWindow,
    new Date().toISOString(),
    id,
  );
  return getProvider(db, id);
}

/**
 * 改连接的基本信息（名称 / baseUrl / 模型列表路径 / 默认模型）。
 *
 * ★ 只接受**已经过探针验证**的 baseUrl —— 调用方（路由层）必须先跑一次 `/models` 探针再落库，
 *   否则就会出现"界面显示保存成功、实际连不上"的老问题。
 */
export type ProviderPatch = {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly modelsPath?: string;
  readonly defaultModel?: string | null;
  readonly sessionHeader?: string | null;
  /** `null` = 清掉白名单（回到"回退 defaultModel"）；数组 = 只允许这几个 */
  readonly enabledModels?: string[] | null;
};

export function updateProvider(db: DatabaseSync, id: string, patch: ProviderPatch): ProviderRow | undefined {
  const current = getProvider(db, id);
  if (current === undefined) return undefined;

  const next = {
    name: patch.name ?? current.name,
    baseUrl: patch.baseUrl ?? current.baseUrl,
    modelsPath: patch.modelsPath ?? current.modelsPath,
    defaultModel: patch.defaultModel === undefined ? current.defaultModel : patch.defaultModel,
    sessionHeader: patch.sessionHeader === undefined ? current.sessionHeader : patch.sessionHeader,
    enabledModels: patch.enabledModels === undefined ? current.enabledModels : patch.enabledModels,
  };

  db.prepare(
    'UPDATE providers SET name = ?, base_url = ?, models_path = ?, default_model = ?, session_header = ?, enabled_models = ?, updated_at = ? WHERE id = ?',
  ).run(
    next.name,
    next.baseUrl,
    next.modelsPath,
    next.defaultModel,
    next.sessionHeader,
    next.enabledModels === null ? null : JSON.stringify(next.enabledModels),
    new Date().toISOString(),
    id,
  );
  return getProvider(db, id);
}

// ────────────────────────── conversations ──────────────────────────

export type NewConversation = {
  readonly agentRole?: 'main' | 'subagent';
  readonly providerId: string;
  readonly model: string;
  readonly title?: string | null;
  readonly projectId?: string | null;
  readonly primaryWorkspaceId?: string | null;
  readonly permissionMode?: string;
};

export function insertConversation(db: DatabaseSync, input: NewConversation): ConversationRow {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversations (id, project_id, title, primary_workspace_id, provider_id, model,
       permission_mode, state, last_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', 0, ?, ?)`,
  ).run(
    id,
    input.projectId ?? null,
    input.title ?? null,
    input.primaryWorkspaceId ?? null,
    input.providerId,
    input.model,
    input.permissionMode ?? 'workspace',
    now,
    now,
  );

  if (input.agentRole === 'subagent') db.prepare("UPDATE conversations SET agent_role='subagent' WHERE id=?").run(id);
  const created = getConversation(db, id);
  if (created === undefined) throw new Error('插入 conversation 后读不回来');
  return created;
}

export function getConversation(db: DatabaseSync, id: string): ConversationRow | undefined {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? undefined : toConversation(row);
}

/** 改会话级用户自定义指令（注入 system 提示；空串等于清空） */
export function updateConversationInstructions(
  db: DatabaseSync,
  id: string,
  instructions: string | null,
): ConversationRow | undefined {
  db.prepare('UPDATE conversations SET instructions = ?, updated_at = ? WHERE id = ?').run(
    instructions,
    new Date().toISOString(),
    id,
  );
  return getConversation(db, id);
}

/**
 * 列会话。
 *
 * ★ 排序是**三段**，不是简单的 `updated_at DESC`：
 *   ① 置顶的在最前（按置顶时刻倒序 —— 最近置顶的更靠上）
 *   ② 其余按最近更新
 *   ③ 归档的沉到最后（`archived_at IS NULL` 排前面）
 *   这样侧栏不用自己做排序，前端也不会和"归档"打架。
 *
 * ★ `includeArchived` 默认 false：主列表不显示归档。
 *   要看归档列表就显式传 true（侧栏「已归档」分组用）。
 */
export function listConversations(
  db: DatabaseSync,
  options: { projectId?: string; includeArchived?: boolean } = {},
): ConversationRow[] {
  const where: string[] = [];
  const params: Array<string> = [];
  if (options.projectId !== undefined) {
    where.push('project_id = ?');
    params.push(options.projectId);
  }
  if (options.includeArchived !== true) {
    where.push('archived_at IS NULL');
  }

  const rows = db
    .prepare(
      `SELECT * FROM conversations
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (archived_at IS NOT NULL) ASC,
                (pinned_at IS NULL) ASC,
                pinned_at DESC,
                updated_at DESC`,
    )
    .all(...params) as Raw[];
  return rows.map(toConversation);
}

export type ConversationPatch = {
  readonly title?: string | null;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly primaryWorkspaceId?: string | null;
  readonly projectId?: string | null;
  readonly state?: string;
  /** 置顶：传时刻（置顶）或 null（取消）。★ 传具体时刻而不是布尔，是为了多个置顶之间能排序 */
  readonly pinnedAt?: string | null;
  /** 归档：传时刻（归档）或 null（还原） */
  readonly archivedAt?: string | null;
  /** 思考强度；null = 用默认 */
  readonly thinkingEffort?: string | null;
};

export function updateConversation(
  db: DatabaseSync,
  id: string,
  patch: ConversationPatch,
): ConversationRow | undefined {
  const sets: string[] = [];
  const values: Array<string | null> = [];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    values.push(patch.title);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    values.push(patch.model);
  }
  if (patch.permissionMode !== undefined) {
    sets.push('permission_mode = ?');
    values.push(patch.permissionMode);
  }
  if (patch.primaryWorkspaceId !== undefined) {
    sets.push('primary_workspace_id = ?');
    values.push(patch.primaryWorkspaceId);
  }
  if (patch.projectId !== undefined) {
    sets.push('project_id = ?');
    values.push(patch.projectId);
  }
  if (patch.state !== undefined) {
    sets.push('state = ?');
    values.push(patch.state);
  }
  if (patch.pinnedAt !== undefined) {
    sets.push('pinned_at = ?');
    values.push(patch.pinnedAt);
  }
  if (patch.archivedAt !== undefined) {
    sets.push('archived_at = ?');
    values.push(patch.archivedAt);
  }
  if (patch.thinkingEffort !== undefined) {
    sets.push('thinking_effort = ?');
    values.push(patch.thinkingEffort);
  }
  if (sets.length === 0) return getConversation(db, id);

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const previousProject = patch.projectId === undefined ? undefined : getConversation(db,id)?.projectId;
  const rebinding = patch.projectId !== undefined && previousProject !== patch.projectId;
  const nested = db.isTransaction, point = `binding_${randomUUID().replaceAll('-','')}`;
  if (rebinding) db.exec(nested ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    // Binding and its new interval are atomic: a checkpoint failure must not import
    // the old project's material into the new project's unrecorded growth.
    if (patch.projectId && rebinding && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_rhythm_checkpoints'").get()) {
      const current = getConversation(db,id);
      if (current) db.prepare("INSERT INTO memory_rhythm_checkpoints(project_id,conversation_id,message_seq,user_seq,kind,created_at) VALUES (?,?,?,NULL,'seed',?)").run(patch.projectId,id,current.lastSeq,new Date().toISOString());
    }
    if (rebinding) db.exec(nested ? `RELEASE ${point}` : 'COMMIT');
  } catch (error) {
    if (rebinding) {
      if (nested) { db.exec(`ROLLBACK TO ${point}`); db.exec(`RELEASE ${point}`); } else db.exec('ROLLBACK');
    }
    throw error;
  }
  return getConversation(db, id);
}

export function deleteConversation(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

// ───────────────────────────── messages ─────────────────────────────

export type NewMessage = {
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly displayChannel?: 'chat' | 'maintenance';
  readonly content?: string | null;
  readonly reasoning?: string | null;
  readonly toolCalls?: readonly ToolCall[] | null;
  readonly toolCallId?: string | null;
  readonly usage?: Usage | null;
  readonly finishReason?: string | null;
};

/**
 * 追加一条消息。`seq` 由会话的 `last_seq` 原子递增而来 ——
 * 这样多路写入也不会出现重复/跳号（`UNIQUE(conversation_id, seq)` 是最后一道保险）。
 */
export function appendMessage(db: DatabaseSync, input: NewMessage): MessageRow {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT last_seq FROM conversations WHERE id = ?').get(input.conversationId) as
      | { last_seq: number | bigint }
      | undefined;
    if (current === undefined) throw new Error(`会话不存在：${input.conversationId}`);

    const seq = Number(current.last_seq) + 1;

    db.prepare('UPDATE conversations SET last_seq = ?, updated_at = ? WHERE id = ?').run(
      seq,
      now,
      input.conversationId,
    );

    db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, role, content, reasoning, tool_calls,
         tool_call_id, usage, finish_reason, created_at, display_channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.conversationId,
      seq,
      input.role,
      input.content ?? null,
      input.reasoning ?? null,
      input.toolCalls === undefined || input.toolCalls === null ? null : JSON.stringify(input.toolCalls),
      input.toolCallId ?? null,
      input.usage === undefined || input.usage === null ? null : JSON.stringify(input.usage),
      input.finishReason ?? null,
      now,
      input.displayChannel ?? 'chat',
    );

    db.exec('COMMIT');

    return {
      id,
      conversationId: input.conversationId,
      seq,
      role: input.role,
      displayChannel: input.displayChannel ?? 'chat',
      content: input.content ?? null,
      reasoning: input.reasoning ?? null,
      toolCalls: input.toolCalls ?? null,
      toolCallId: input.toolCallId ?? null,
      usage: input.usage ?? null,
      finishReason: input.finishReason ?? null,
      createdAt: now,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listMessages(db: DatabaseSync, conversationId: string, afterSeq = 0): MessageRow[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC')
    .all(conversationId, afterSeq) as Raw[];
  return rows.map(toMessage);
}

// ──────────────────────────── projects ────────────────────────────

export type ProjectRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly sharedDir: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  /** 置顶时刻；`null` = 未置顶 */
  readonly pinnedAt: string | null;
};

function toProject(row: Raw): ProjectRow {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: text(row['description']),
    sharedDir: row['shared_dir'] as string,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    archivedAt: text(row['archived_at']),
    pinnedAt: text(row['pinned_at']),
  };
}

export type NewProject = {
  /** 由服务层生成 —— 这样目录名和行 id 是对得上的同一个东西 */
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly sharedDir: string;
};

export function insertProject(db: DatabaseSync, input: NewProject): ProjectRow {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO projects (id, name, description, shared_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.id, input.name, input.description ?? null, input.sharedDir, now, now);

  const created = getProject(db, input.id);
  if (created === undefined) throw new Error('插入 project 后读不回来');
  return created;
}

export function getProject(db: DatabaseSync, id: string): ProjectRow | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? undefined : toProject(row);
}

/** 默认只列未归档的；`includeArchived` 用于回溯 */
export function listProjects(db: DatabaseSync, includeArchived = false): ProjectRow[] {
  // ★ 置顶优先：`pinned_at IS NULL` 排序把未置顶的排到后面（SQLite 里 0 < 1），
  //   再按置顶时刻倒序 —— 后置顶的排更前，与会话列表一致。
  const order = 'ORDER BY pinned_at IS NULL, pinned_at DESC, created_at ASC';
  const rows = (
    includeArchived
      ? db.prepare(`SELECT * FROM projects ${order}`).all()
      : db.prepare(`SELECT * FROM projects WHERE archived_at IS NULL ${order}`).all()
  ) as Raw[];
  return rows.map(toProject);
}

export type ProjectPatch = {
  readonly name?: string;
  readonly description?: string | null;
  /** 归档：保留共享目录里的文件，只是不再出现在默认列表里（删项目是破坏性动作，V0.1 不提供硬删） */
  readonly archived?: boolean;
  /**
   * 置顶。`true` ⇒ 打上当前时刻；`false` ⇒ 清空。
   * ★ 与会话一致，**存时刻不存布尔**：取消即 NULL，多个置顶之间天然能按时间排出先后。
   */
  readonly pinned?: boolean;
};

export function updateProject(db: DatabaseSync, id: string, patch: ProjectPatch): ProjectRow | undefined {
  const sets: string[] = [];
  const values: Array<string | null> = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    values.push(patch.description);
  }
  if (patch.archived !== undefined) {
    sets.push('archived_at = ?');
    values.push(patch.archived ? new Date().toISOString() : null);
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned_at = ?');
    values.push(patch.pinned ? new Date().toISOString() : null);
  }
  if (sets.length === 0) return getProject(db, id);

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getProject(db, id);
}

// ─────────────────────────── workspaces ───────────────────────────

export type WorkspaceRow = {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 置顶时刻；`null` = 未置顶 */
  readonly pinnedAt: string | null;
};

function toWorkspace(row: Raw): WorkspaceRow {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    rootPath: row['root_path'] as string,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    pinnedAt: text(row['pinned_at']),
  };
}

export function insertWorkspace(db: DatabaseSync, input: { name: string; rootPath: string }): WorkspaceRow {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.name, input.rootPath, now, now);

  const created = getWorkspace(db, id);
  if (created === undefined) throw new Error('插入 workspace 后读不回来');
  return created;
}

export function getWorkspace(db: DatabaseSync, id: string): WorkspaceRow | undefined {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? undefined : toWorkspace(row);
}

export function listWorkspaces(db: DatabaseSync): WorkspaceRow[] {
  // 置顶优先，语义与项目/会话一致（存时刻不存布尔）
  const rows = db
    .prepare('SELECT * FROM workspaces ORDER BY pinned_at IS NULL, pinned_at DESC, created_at ASC')
    .all() as Raw[];
  return rows.map(toWorkspace);
}

export type WorkspacePatch = {
  readonly name?: string;
  /** 置顶：`true` 打当前时刻，`false` 清空 */
  readonly pinned?: boolean;
};

/** 重命名 / 置顶。**改的是登记，不动磁盘上的目录**。 */
export function updateWorkspace(db: DatabaseSync, id: string, patch: WorkspacePatch): WorkspaceRow | undefined {
  const sets: string[] = [];
  const values: Array<string | null> = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned_at = ?');
    values.push(patch.pinned ? new Date().toISOString() : null);
  }
  if (sets.length === 0) return getWorkspace(db, id);

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getWorkspace(db, id);
}

/** 删工作区**只删登记**，不碰磁盘上的文件（任务书 §3.3：工作区是独立资源） */
export function deleteWorkspace(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

// ──────────────────── conversation ↔ workspace ────────────────────

export function attachWorkspace(
  db: DatabaseSync,
  conversationId: string,
  workspaceId: string,
  isPrimary = true,
): void {
  db.prepare(
    `INSERT INTO conversation_workspaces (conversation_id, workspace_id, is_primary)
     VALUES (?, ?, ?)
     ON CONFLICT (conversation_id, workspace_id) DO UPDATE SET is_primary = excluded.is_primary`,
  ).run(conversationId, workspaceId, isPrimary ? 1 : 0);

  if (isPrimary) {
    db.prepare('UPDATE conversations SET primary_workspace_id = ?, updated_at = ? WHERE id = ?').run(
      workspaceId,
      new Date().toISOString(),
      conversationId,
    );
  }
}

export function listConversationWorkspaces(db: DatabaseSync, conversationId: string): WorkspaceRow[] {
  const rows = db
    .prepare(
      `SELECT w.* FROM workspaces w
       JOIN conversation_workspaces cw ON cw.workspace_id = w.id
       WHERE cw.conversation_id = ?
       ORDER BY cw.is_primary DESC, w.created_at ASC`,
    )
    .all(conversationId) as Raw[];
  return rows.map(toWorkspace);
}

