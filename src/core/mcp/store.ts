import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  KEEP_EXISTING,
  MCP_GROUP_MODES,
  MCP_TRANSPORTS,
  type McpGroupMode,
  type McpServerDto,
  type McpStatus,
  type McpTransport,
} from '../../shared/mcp.ts';
import type { ToolContext, ToolDefinition, ToolOutcome, ToolRegistry } from '../tools/types.ts';
import { mcpManager } from './registry.ts';

/**
 * `mcp_servers` 的**唯一**读写入口（含凭据掩码规则）+ 给模型用的 `mcp_configure` 工具。
 *
 * ## ★★★ 凭据规则（这个文件的存在理由）
 *
 * `env` / `headers` 的值就是 token。三条纪律：
 *
 * 1. **对外只给键名**。{@link toMcpServerDto} 只输出 `envKeys` / `headerKeys`，
 *    值连"掩码后的形状"都不给（`len` 也别给 —— 那本身就是信息）。
 * 2. **PATCH 用占位符保留**。值传 {@link KEEP_EXISTING} 表示"这一项保持原值"。
 *    整张表传 `{}` 表示**清空**；字段整个不传表示**不动**。三种语义必须分清。
 * 3. **任何错误消息都不带值**。校验失败只说"哪一项不对"，绝不回显传进来的字符串
 *    （否则一次参数错误就把 token 写进了界面、日志和模型上下文）。
 *
 * ## ★★ 为什么表里的 `args` / `env` / `headers` 存 JSON 文本
 *
 * schema 是这么定的（v13）。读的时候一律用 `safeParse` 兜底：手工改过库、
 * 或者老版本写坏了一行，都不该让整个设置页打不开。
 */

// ────────────────────────────── 类型 ──────────────────────────────

/** 库里的一行（**含凭据值**，只在服务端内部流转，绝不直接下发）。 */
export type McpServerRecord = {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | null;
  readonly url: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly groupMode: McpGroupMode;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** 运行期状态（由 registry 的连接管理器提供，库里不存）。 */
export type McpRuntimeInfo = {
  readonly status: McpStatus;
  readonly error: string | null;
  /** 已注册进注册表的工具名（已清洗、已加 `mcp_` 前缀） */
  readonly toolNames: readonly string[];
};

/** 校验/查找失败。`status` 直接就是该回给 HTTP 的状态码。 */
export class McpValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'McpValidationError';
    this.status = status;
  }
}

type RawRow = {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  env: string | null;
  cwd: string | null;
  url: string | null;
  headers: string | null;
  enabled: number | bigint;
  group_mode: string;
  created_at: string;
  updated_at: string;
};

// ────────────────────────────── 解析小工具 ──────────────────────────────

function parseStringArray(text: string | null): string[] {
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function parseStringMap(text: string | null): Record<string, string> {
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function encodeOptions(value: Readonly<Record<string, string>>): string | null {
  return Object.keys(value).length === 0 ? null : JSON.stringify(value);
}

function encodeArgs(value: readonly string[]): string | null {
  return value.length === 0 ? null : JSON.stringify(value);
}

function toGroupMode(value: string): McpGroupMode {
  return value === 'resident' || value === 'disabled' ? value : 'lazy';
}

function toTransport(value: string): McpTransport {
  return value === 'http' ? 'http' : 'stdio';
}

function rowToRecord(row: RawRow): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    transport: toTransport(row.transport),
    command: row.command,
    args: parseStringArray(row.args),
    env: parseStringMap(row.env),
    cwd: row.cwd,
    url: row.url,
    headers: parseStringMap(row.headers),
    enabled: Number(row.enabled) === 1,
    groupMode: toGroupMode(row.group_mode),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpValidationError(`${label}必须是一个 JSON 对象（例如 {"name":"…","transport":"stdio"}）`);
  }
  return value as Record<string, unknown>;
}

// ────────────────────────────── 校验 ──────────────────────────────

export function isMcpGroupMode(value: unknown): value is McpGroupMode {
  return typeof value === 'string' && (MCP_GROUP_MODES as readonly string[]).includes(value);
}

function assertGroupMode(value: unknown, field = 'groupMode'): McpGroupMode {
  if (value === undefined || value === null) return 'lazy';
  if (!isMcpGroupMode(value)) {
    throw new McpValidationError(`${field} 必须是 'resident' / 'lazy' / 'disabled' 之一（收到 ${JSON.stringify(value)}）`);
  }
  return value;
}

function assertTransport(value: unknown): McpTransport {
  if (typeof value !== 'string' || !(MCP_TRANSPORTS as readonly string[]).includes(value)) {
    throw new McpValidationError("transport 必须是 'stdio'（本地子进程）或 'http'（streamable-http）之一");
  }
  return value === 'http' ? 'http' : 'stdio';
}

function assertEnabled(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'boolean') throw new McpValidationError('enabled 必须是 true / false');
  return value;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new McpValidationError(`${field} 必须是字符串`);
  return value;
}

function trimOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const text = assertString(value, field).trim();
  return text.length === 0 ? null : text;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new McpValidationError(`${field} 必须是字符串数组（例如 ["-y","@modelcontextprotocol/server-filesystem"]）`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new McpValidationError(`${field}[${String(index)}] 必须是字符串`);
    return item;
  });
}

/** 名字索引：小写名 → 已有记录（大小写不同也算重名，避免界面上两个"看起来一样"的服务器）。 */
function nameIndex(db: DatabaseSync, selfId: string | null = null): Map<string, { id: string; name: string }> {
  const rows = db.prepare('SELECT id, name FROM mcp_servers').all() as unknown as Array<{ id: string; name: string }>;
  const index = new Map<string, { id: string; name: string }>();
  for (const row of rows) {
    if (row.id === selfId) continue;
    index.set(row.name.trim().toLowerCase(), { id: row.id, name: row.name });
  }
  return index;
}

function assertName(value: unknown, index: Map<string, { id: string; name: string }>): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpValidationError('name 不能为空：给这个 MCP 服务器起一个名字（例如 filesystem、github）');
  }
  const name = value.trim();
  if (name.length > 64) throw new McpValidationError('name 最多 64 个字符');
  const clash = index.get(name.toLowerCase());
  if (clash !== undefined) {
    throw new McpValidationError(`已有同名 MCP 服务器「${clash.name}」，name 必须唯一（换个名字，或直接编辑已有的那一台）`, 409);
  }
  return name;
}

/**
 * 校验「传输方式与必填字段」是否匹配。
 * ★ 错误文案必须**能指导修正** —— 只说"参数错误"等于让用户去猜。
 */
function assertTransportFields(transport: McpTransport, command: string | null, url: string | null): void {
  if (transport === 'stdio' && (command === null || command.length === 0)) {
    throw new McpValidationError(
      'transport=stdio 时必须提供 command（要启动的可执行文件，例如 node / npx / C:\\…\\server.exe）；如果是远端服务，请改用 transport=http + url',
    );
  }
  if (transport === 'http') {
    if (url === null || url.length === 0) {
      throw new McpValidationError('transport=http 时必须提供 url（完整地址，例如 http://127.0.0.1:3000/mcp）；如果是本地进程，请改用 transport=stdio + command');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new McpValidationError('url 不是合法地址：需要以 http:// 或 https:// 开头，并包含主机名');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new McpValidationError('url 只支持 http:// 或 https://');
    }
  }
}

/**
 * PATCH 时合并凭据。
 *
 * 三态语义（写在这里，避免以后改回去）：
 * - 整个字段**不传** ⇒ 保持原样
 * - 传 `{}` ⇒ **清空**
 * - 传某键且值是 {@link KEEP_EXISTING} ⇒ 保留该键原值（原来没有这个键就忽略）
 */
export function mergeSecretMap(
  existing: Readonly<Record<string, string>>,
  incoming: Record<string, unknown> | undefined,
  field: string,
): Record<string, string> {
  if (incoming === undefined) return { ...existing };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    const trimmedKey = key.trim();
    if (trimmedKey.length === 0) continue;
    if (typeof value !== 'string') {
      // ★ 不回显 value：它可能就是 token。
      throw new McpValidationError(`${field} 里键「${trimmedKey}」的值必须是字符串`);
    }
    if (value === KEEP_EXISTING) {
      const kept = existing[key] ?? existing[trimmedKey];
      if (kept !== undefined) out[trimmedKey] = kept;
      continue;
    }
    out[trimmedKey] = value;
  }
  return out;
}

function readSecretMap(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new McpValidationError(`${field} 必须是对象（键 → 值），不是字符串或数组`);
  }
  return value as Record<string, unknown>;
}

// ────────────────────────────── 读 ──────────────────────────────

const SELECT_ALL = 'SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE';

export function listMcpServers(db: DatabaseSync): McpServerRecord[] {
  return (db.prepare(SELECT_ALL).all() as unknown as RawRow[]).map(rowToRecord);
}

export function getMcpServer(db: DatabaseSync, id: string): McpServerRecord | undefined {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as unknown as RawRow | undefined;
  return row === undefined ? undefined : rowToRecord(row);
}

export function getMcpServerByName(db: DatabaseSync, name: string): McpServerRecord | undefined {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE lower(name) = lower(?)').get(name.trim()) as unknown as
    | RawRow
    | undefined;
  return row === undefined ? undefined : rowToRecord(row);
}

// ────────────────────────────── 写 ──────────────────────────────

/**
 * 新增一台服务器。
 *
 * `input` 用 `unknown` 而不是 `UpsertMcpServerInput`：两个调用点（HTTP body 与模型给的工具参数）
 * 都是不可信输入，让校验函数承担类型收窄，比在调用点各写一遍 cast 更安全。
 */
export function insertMcpServer(db: DatabaseSync, input: unknown): McpServerRecord {
  const raw = readObject(input, '请求体');

  const name = assertName(raw['name'], nameIndex(db));
  const transport = assertTransport(raw['transport']);
  const command = trimOrNull(raw['command'], 'command');
  const cwd = trimOrNull(raw['cwd'], 'cwd');
  const url = trimOrNull(raw['url'], 'url');
  const args = assertStringArray(raw['args'], 'args');
  const env = mergeSecretMap({}, readSecretMap(raw['env'], 'env'), 'env');
  const headers = mergeSecretMap({}, readSecretMap(raw['headers'], 'headers'), 'headers');
  const enabled = assertEnabled(raw['enabled']);
  const groupMode = assertGroupMode(raw['groupMode']);

  assertTransportFields(transport, command, url);

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, command, args, env, cwd, url, headers, enabled, group_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    transport,
    command,
    encodeArgs(args),
    encodeOptions(env),
    cwd,
    url,
    encodeOptions(headers),
    enabled ? 1 : 0,
    groupMode,
    now,
    now,
  );

  // ★ 落库后**立刻回读**：不从入参拼 DTO。这是"设置存了但没生效"那类事故的唯一防线。
  const record = getMcpServer(db, id);
  if (record === undefined) throw new Error('MCP 服务器写入后回读失败（库里没有这一行）');
  return record;
}

export function updateMcpServer(db: DatabaseSync, id: string, patch: unknown): McpServerRecord {
  const existing = getMcpServer(db, id);
  if (existing === undefined) throw new McpValidationError(`没有 id 为「${id}」的 MCP 服务器`, 404);

  const raw = readObject(patch, '请求体');
  const name = raw['name'] === undefined ? existing.name : assertName(raw['name'], nameIndex(db, id));
  const transport = raw['transport'] === undefined ? existing.transport : assertTransport(raw['transport']);
  const command = raw['command'] === undefined ? existing.command : trimOrNull(raw['command'], 'command');
  const cwd = raw['cwd'] === undefined ? existing.cwd : trimOrNull(raw['cwd'], 'cwd');
  const url = raw['url'] === undefined ? existing.url : trimOrNull(raw['url'], 'url');
  const args = raw['args'] === undefined ? [...existing.args] : assertStringArray(raw['args'], 'args');
  const env = mergeSecretMap(existing.env, readSecretMap(raw['env'], 'env'), 'env');
  const headers = mergeSecretMap(existing.headers, readSecretMap(raw['headers'], 'headers'), 'headers');
  const enabled = raw['enabled'] === undefined ? existing.enabled : assertEnabled(raw['enabled']);
  const groupMode = raw['groupMode'] === undefined ? existing.groupMode : assertGroupMode(raw['groupMode']);

  assertTransportFields(transport, command, url);

  db.prepare(
    `UPDATE mcp_servers
        SET name = ?, transport = ?, command = ?, args = ?, env = ?, cwd = ?, url = ?, headers = ?,
            enabled = ?, group_mode = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    name,
    transport,
    command,
    encodeArgs(args),
    encodeOptions(env),
    cwd,
    url,
    encodeOptions(headers),
    enabled ? 1 : 0,
    groupMode,
    new Date().toISOString(),
    id,
  );

  const record = getMcpServer(db, id);
  if (record === undefined) throw new Error('MCP 服务器更新后回读失败（库里没有这一行）');
  return record;
}

export function deleteMcpServer(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

/** 只改整组默认模式（批量写 `tool_settings` 是连接管理器的活，见 registry.ts）。 */
export function setMcpServerGroupMode(db: DatabaseSync, id: string, mode: McpGroupMode): McpServerRecord {
  if (!isMcpGroupMode(mode)) {
    throw new McpValidationError("mode 必须是 'resident' / 'lazy' / 'disabled' 之一");
  }
  const result = db.prepare('UPDATE mcp_servers SET group_mode = ?, updated_at = ? WHERE id = ?').run(
    mode,
    new Date().toISOString(),
    id,
  );
  if (Number(result.changes) === 0) throw new McpValidationError(`没有 id 为「${id}」的 MCP 服务器`, 404);
  const record = getMcpServer(db, id);
  if (record === undefined) throw new Error('MCP 服务器更新后回读失败（库里没有这一行）');
  return record;
}

// ────────────────────────────── DTO ──────────────────────────────

/** 从没连过时的运行期状态：启用着就是 `idle`，停用了就是 `disabled`。 */
export function idleRuntime(record: McpServerRecord): McpRuntimeInfo {
  return record.enabled
    ? { status: 'idle', error: null, toolNames: [] }
    : { status: 'disabled', error: null, toolNames: [] };
}

/**
 * 记录 → 对外的 DTO。
 *
 * ★★★ 这个函数是**凭据防线的最后一关**：它只输出 `envKeys` / `headerKeys`。
 *   新增字段时先问一句：这个字段会不会把 token 带出去？
 */
export function toMcpServerDto(record: McpServerRecord, runtime: McpRuntimeInfo): McpServerDto {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    command: record.command,
    args: [...record.args],
    cwd: record.cwd,
    url: record.url,
    envKeys: Object.keys(record.env).sort(),
    headerKeys: Object.keys(record.headers).sort(),
    enabled: record.enabled,
    groupMode: record.groupMode,
    status: runtime.status,
    error: runtime.error,
    toolNames: [...runtime.toolNames],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** 两份记录还连不连得上同一台服务器（名字变了工具名也会变，所以也算变更）。 */
export function sameConnection(a: McpServerRecord, b: McpServerRecord): boolean {
  return (
    a.name === b.name &&
    a.transport === b.transport &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.url === b.url &&
    sameStringArray(a.args, b.args) &&
    // ★ 不拼字符串比较（那会把 token 拼进内存里的一个大串）；逐键比对。
    sameStringMap(a.env, b.env) &&
    sameStringMap(a.headers, b.headers)
  );
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function sameStringMap(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (!sameStringArray(aKeys, bKeys)) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

// ────────────────────────────── 给模型的配置通道 ──────────────────────────────

const CONFIGURE_ACTIONS = ['list', 'upsert', 'remove', 'mode', 'reconnect'] as const;

type ConfigureAction = (typeof CONFIGURE_ACTIONS)[number];

function isConfigureAction(value: unknown): value is ConfigureAction {
  return typeof value === 'string' && (CONFIGURE_ACTIONS as readonly string[]).includes(value);
}

function findTarget(db: DatabaseSync, args: Record<string, unknown>): McpServerRecord | undefined {
  const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
  if (id.length > 0) {
    const byId = getMcpServer(db, id);
    if (byId !== undefined) return byId;
  }
  const name = typeof args['name'] === 'string' ? args['name'].trim() : '';
  if (name.length > 0) return getMcpServerByName(db, name);
  return undefined;
}

function namesHint(db: DatabaseSync): string {
  const names = listMcpServers(db).map((record) => record.name);
  return names.length === 0 ? '当前一台 MCP 服务器都没有配置。' : `当前已配置：${names.join('、')}。`;
}

/** 把模型给的 upsert 参数整理成 `insert/update` 吃的对象（**只搬运，不校验**——校验在那边）。 */
function configureUpsertInput(args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { name: args['name'] };
  for (const field of ['transport', 'command', 'cwd', 'url', 'args', 'env', 'headers', 'enabled', 'groupMode'] as const) {
    if (args[field] !== undefined) input[field] = args[field];
  }
  return input;
}

/**
 * `mcp_configure` —— 用户明确要求的"为模型加一个配置 MCP 的通道"。
 *
 * ## ★★★ 三条纪律
 *
 * 1. **绝不回显 `env` / `headers` 的值**。`list` 只给键名；`upsert` 的返回值也是键名。
 *    要保留原值就传 {@link KEEP_EXISTING}，模型因此永远不需要"读一次再写回去"。
 * 2. **`modes: ['full']`**。配置 MCP = 决定这台机器跑什么进程、连什么外网，
 *    与插件同级，只在完全权限档可见。
 * 3. 注册由调用方负责（`createDefaultRegistry` 之外单独接线），本函数只导出定义。
 */
export function createMcpConfigureTool(db: DatabaseSync, registry: ToolRegistry): ToolDefinition {
  const manager = (): ReturnType<typeof mcpManager> => mcpManager(db, registry);

  return {
    name: 'mcp_configure',
    description: [
      '配置 MCP（Model Context Protocol）服务器。MCP 服务器把外部能力（文件系统、数据库、SaaS API）以工具的形式接进来。',
      '',
      '动作：',
      '- list：列出已配置的服务器（只给 env/headers 的**键名**，值永远不会返回给你）。',
      '- upsert：新增或修改。已存在（同名或同 id）就更新，否则新建。新值直接覆盖；要保留某个凭据原值，把它的值传 "<KEEP_EXISTING>"。',
      '- remove：删除（会把它的工具一并从工具表里摘掉）。',
      '- mode：把该服务器的**全部工具**一次设成 resident（常驻）/ lazy（按需）/ disabled（关闭）。',
      '- reconnect：重新拉起进程并重新拉取工具列表（改了配置或服务器崩了之后用）。',
      '',
      '两种传输：stdio（本地子进程，需要 command，可选 args/cwd/env）与 http（远端 streamable-http，需要 url，可选 headers）。',
      '★ 新建/修改之后，工具要下一轮对话才会出现在工具表里（本轮快照已冻结）。',
      '★ 凭据值**不要**让用户贴进对话；能用环境变量/已有配置保留的就保留。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...CONFIGURE_ACTIONS],
          description: 'list | upsert | remove | mode | reconnect',
        },
        id: { type: 'string', description: '服务器的稳定 id（upsert 时可选；与 name 二选一定位）' },
        name: { type: 'string', description: '服务器名（upsert 时必填；其他动作用它定位）' },
        transport: { type: 'string', enum: [...MCP_TRANSPORTS], description: 'stdio 或 http' },
        command: { type: 'string', description: 'stdio 必填：要启动的可执行文件，例如 node / npx' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio：启动参数数组' },
        cwd: { type: 'string', description: 'stdio：子进程工作目录（可选）' },
        url: { type: 'string', description: 'http 必填：完整地址（http:// 或 https://）' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'stdio：环境变量键值对。值会原样保存且**永远不会再返回给你**；要保留已有值就传 "<KEEP_EXISTING>"；传 {} 表示清空。',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'http：请求头键值对。值会原样保存且**永远不会再返回给你**；要保留已有值就传 "<KEEP_EXISTING>"；传 {} 表示清空。',
        },
        enabled: { type: 'boolean', description: '是否启用（默认 true）' },
        groupMode: { type: 'string', enum: [...MCP_GROUP_MODES], description: '新建时的默认整组模式（默认 lazy）' },
        mode: { type: 'string', enum: [...MCP_GROUP_MODES], description: 'action=mode 时必填：要批量设成的模式' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    modes: ['full'] as const,
    source: 'builtin',
    kind: 'write_local',
    group: 'setup',
    displayName: 'MCP 配置',
    summary: '列出 / 新增 / 删除 MCP 服务器，并批量设置它们的工具模式',
    oneLiner: '配置 MCP 服务器：列出、新增、删除、批量设模式、重连',
    // ★ 配置类工具常年用不上，默认按需：常驻它每轮都要付 token。
    preferredMode: 'lazy',
    execute: async (rawArgs: unknown, _ctx: ToolContext): Promise<ToolOutcome> => {
      const args = rawArgs === null || typeof rawArgs !== 'object' ? {} : (rawArgs as Record<string, unknown>);
      const action = args['action'];

      if (!isConfigureAction(action)) {
        return {
          ok: false,
          code: 'invalid_action',
          message: `action 必须是 ${CONFIGURE_ACTIONS.join(' / ')} 之一`,
          hint: '先用 action="list" 看看现在配置了什么。',
        };
      }

      try {
        switch (action) {
          case 'list': {
            const servers = listMcpServers(db).map((record) => toMcpServerDto(record, manager().runtime(record)));
            return { ok: true, content: JSON.stringify({ servers }, null, 2) };
          }

          case 'upsert': {
            const existing = findTarget(db, args);
            const record = existing === undefined
              ? insertMcpServer(db, configureUpsertInput(args))
              : updateMcpServer(db, existing.id, configureUpsertInput(args));
            const info = await manager().connect(record);
            return {
              ok: true,
              content: JSON.stringify({ server: toMcpServerDto(record, info) }, null, 2),
            };
          }

          case 'remove': {
            const target = findTarget(db, args);
            if (target === undefined) {
              return {
                ok: false,
                code: 'mcp_not_found',
                message: `没有找到要删除的 MCP 服务器${typeof args['name'] === 'string' ? `「${args['name']}」` : ''}`,
                hint: namesHint(db),
              };
            }
            await manager().disconnect(target.id);
            deleteMcpServer(db, target.id);
            return { ok: true, content: JSON.stringify({ ok: true, removed: target.name }, null, 2) };
          }

          case 'mode': {
            const target = findTarget(db, args);
            if (target === undefined) {
              return {
                ok: false,
                code: 'mcp_not_found',
                message: '没有找到要改模式的 MCP 服务器',
                hint: namesHint(db),
              };
            }
            const mode = args['mode'];
            if (!isMcpGroupMode(mode)) {
              return {
                ok: false,
                code: 'invalid_mode',
                message: "mode 必须是 'resident' / 'lazy' / 'disabled' 之一",
                hint: '常驻=完整 schema 每轮都发；按需=只留一句话；关闭=模型完全看不到。',
              };
            }
            const info = await manager().setGroupMode(target, mode);
            const updated = getMcpServer(db, target.id) ?? target;
            return {
              ok: true,
              content: JSON.stringify({ server: toMcpServerDto(updated, info) }, null, 2),
            };
          }

          case 'reconnect': {
            const target = findTarget(db, args);
            if (target === undefined) {
              return {
                ok: false,
                code: 'mcp_not_found',
                message: '没有找到要重连的 MCP 服务器',
                hint: namesHint(db),
              };
            }
            const info = await manager().connect(target);
            return {
              ok: true,
              content: JSON.stringify({ server: toMcpServerDto(target, info) }, null, 2),
            };
          }
        }
      } catch (error) {
        if (error instanceof McpValidationError) {
          return { ok: false, code: 'invalid_args', message: error.message };
        }
        return {
          ok: false,
          code: 'mcp_configure_failed',
          message: error instanceof Error ? error.message : String(error),
          hint: '这是配置或连接层面的问题；把这句话原样告诉用户，不要反复重试。',
        };
      }
    },
  };
}
