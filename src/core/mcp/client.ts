import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type { McpTransport } from '../../shared/mcp.ts';

/**
 * 结束一个 MCP stdio 子进程，**连同它的整棵进程树**（审计 `ALK-MED-09`）。
 *
 * 为什么不能只 `child.kill()`：典型配置是 `npx @scope/server` 或 `node launcher.js`，
 * 真正干活的进程是**孙子**。父进程一死，孙子变孤儿，继续占端口/内存/句柄；
 * 用户反复「重新连接」就会积一堆看不见的 node 进程。
 *
 * Windows 用 `taskkill /T /F`（`/T` = 树，`/F` = 强制）；POSIX 上退回"负 pid 杀进程组"，
 * 失败再退回普通 kill —— 三步都失败就算了，不能因为清理失败影响主流程。
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      /* 进程可能已经退出，退回普通 kill */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* 不是进程组组长时会抛，退回普通 kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经死了 */
  }
}

/**
 * MCP 协议客户端（**零新依赖**，只用 `child_process` 与 `fetch`）。
 *
 * ## ★ 两种传输，一套 JSON-RPC 2.0
 *
 * | 传输 | 帧格式 | 通道 |
 * |---|---|---|
 * | `stdio` | 一行一条 JSON（newline-delimited） | 子进程 stdin/stdout |
 * | `http` | 一个 POST 一个响应（`streamable-http`） | HTTP |
 *
 * ## ★★★ 四条硬约束（都是"不这么做就会静默挂住"的地方）
 *
 * 1. **必须有超时**。stdio 的服务器可能启动成功却永不回包（比如它在等一个交互提示），
 *    HTTP 的对端可能接受了连接却不发响应。没有超时 = 整个对话卡死在工具调用上。
 * 2. **必须检测进程退出**。子进程死了但请求还挂在 `pending` 里，是最难查的那类假死：
 *    界面显示"调用中"，其实是永远不会有回音。⇒ 退出时把全部 pending 明确拒绝。
 * 3. **stdout 上的非 JSON 行要忽略**。不少 MCP 服务器会往 stdout 打日志（严格说违反协议，
 *    但现实里很常见）。解析失败就当日志丢掉，绝不能让一行噪声搞崩整条连接。
 * 4. **错误消息里不能出现凭据**。`env` / `headers` 的值就是 token，服务器进程的 stderr
 *    可能把它们回显出来 ⇒ 所有外发文本都过一遍 {@link redactSecrets}。
 */

/** 请求的协议版本。服务器可以回它自己支持的版本，我们只记录、不强制。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** 默认超时：30s（与插件宿主的工具调用超时一致）。 */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

const CLIENT_INFO = { name: 'alkaid', version: '0.1.0' } as const;

/** `tools/list` 的分页上限 —— 防止一个坏实现用 nextCursor 把我们拖进死循环。 */
const MAX_TOOL_PAGES = 20;

/** stderr 只留尾部这么多字符（用于退出原因），再多就是噪声。 */
const STDERR_TAIL_CHARS = 2_000;
/** stdout 单帧上限（审计 `ALK-MED-09`）：正常帧远小于它，超过说明对端坏了 */
const MAX_STDOUT_BUFFER_CHARS = 32 * 1024 * 1024;

export type McpToolInfo = {
  /** 服务器声明的**原始**工具名（未清洗；注册进注册表时才加前缀并清洗） */
  readonly name: string;
  readonly description: string;
  /** JSON Schema（object 根）；服务器没给就用一个空 object */
  readonly inputSchema: Record<string, unknown>;
};

export type McpConnectInput = {
  /** 服务器名，只用于错误消息 */
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string | null;
  readonly args?: readonly string[] | null;
  readonly env?: Readonly<Record<string, string>> | null;
  readonly cwd?: string | null;
  readonly url?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  /** 覆盖默认 30s（测试用） */
  readonly timeoutMs?: number;
};

/** 一条已建立（已 initialize）的 MCP 连接。 */
export type McpConnection = {
  readonly serverName: string;
  readonly transport: McpTransport;
  /** `tools/list`（会跟随 `nextCursor` 翻页，最多 20 页） */
  listTools(): Promise<McpToolInfo[]>;
  /** `tools/call`，把 `content` 数组拼成文本；`isError: true` 会抛错 */
  callTool(name: string, args: unknown): Promise<string>;
  close(): Promise<void>;
  /** 连接**意外**断开时通知（主动 `close()` 不触发）。一个连接可以有多个监听者。 */
  onClose(listener: (reason: string) => void): void;
};

// ────────────────────────────── 错误类型 ──────────────────────────────

/** 请求超时。单独一个类型，好让上层给出"可以重连"的建议而不是"参数错了"。 */
export class McpTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`MCP 请求超时（${method}，${timeoutMs}ms 没有响应）`);
    this.name = 'McpTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

// ────────────────────────────── 脱敏 ──────────────────────────────

/**
 * 把已知的凭据值从文本里抹掉。
 *
 * ★ 为什么必须做：`env` 的值就是 token；服务器进程的 stderr 完全可能把它回显出来，
 *   而 stderr 尾部会被拼进"进程已退出"的错误消息，那条消息会进 DTO、进界面、进模型上下文。
 *   一次回显 = 一次泄漏，所以**任何外发文本**都要先过这里。
 * ★ 太短的值（< 4 字符）不处理：像 `1` / `on` 这种值会把正常文案打成筛子。
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

function collectSecrets(input: McpConnectInput): string[] {
  const values: string[] = [];
  for (const map of [input.env, input.headers]) {
    if (map === null || map === undefined) continue;
    for (const value of Object.values(map)) if (typeof value === 'string') values.push(value);
  }
  return values;
}

// ────────────────────────────── JSON-RPC 基础 ──────────────────────────────

type JsonRpcError = { readonly code?: number; readonly message?: string };

type JsonRpcMessage = {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
};

type Pending = {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 把服务器给的 inputSchema 规整成能直接当工具 `parameters` 用的对象。 */
function normalizeSchema(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw);
  if (record === null) return { type: 'object', properties: {}, additionalProperties: false };
  if (record['type'] === 'object') return record;
  return { ...record, type: 'object', properties: asRecord(record['properties']) ?? {} };
}

function normalizeTool(raw: unknown): McpToolInfo | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (name.length === 0) return null;
  const description = typeof record['description'] === 'string' ? record['description'] : '';
  return {
    name,
    description,
    inputSchema: normalizeSchema(record['inputSchema'] ?? record['input_schema']),
  };
}

/**
 * 把 `tools/call` 的结果拼成人能读的文本。
 *
 * ★ 只取 `text` 是刻意的：图片/音频二进制塞进对话既费 token 又没用。
 *   但要**留下痕迹**（`[image …]`），否则模型会以为工具什么都没返回。
 */
export function extractToolText(result: unknown): string {
  const record = asRecord(result);
  if (record === null) return result === undefined || result === null ? '' : JSON.stringify(result);

  const parts: string[] = [];
  const content = record['content'];
  if (Array.isArray(content)) {
    for (const item of content) {
      const block = asRecord(item);
      if (block === null) {
        parts.push(typeof item === 'string' ? item : JSON.stringify(item));
        continue;
      }
      const type = typeof block['type'] === 'string' ? block['type'] : '';
      if (type === 'text' && typeof block['text'] === 'string') {
        parts.push(block['text']);
      } else if (type === 'image') {
        const mime = typeof block['mimeType'] === 'string' ? ` ${block['mimeType']}` : '';
        parts.push(`[image${mime} 未展开]`);
      } else if (type === 'audio') {
        parts.push('[audio 未展开]');
      } else if (type === 'resource') {
        const resource = asRecord(block['resource']);
        const uri = resource !== null && typeof resource['uri'] === 'string' ? resource['uri'] : '';
        parts.push(uri.length > 0 ? `[resource ${uri}]` : '[resource]');
      } else {
        parts.push(JSON.stringify(block));
      }
    }
  }

  if (parts.length === 0 && record['structuredContent'] !== undefined) {
    parts.push(JSON.stringify(record['structuredContent']));
  }

  const text = parts.join('\n');

  if (record['isError'] === true) {
    throw new Error(text.length > 0 ? text : 'MCP 工具返回了 isError，但没有给出任何说明');
  }
  return text;
}

// ────────────────────────────── 抽象基类 ──────────────────────────────

/**
 * 两种传输共用的**协议动作**：`initialize` → `notifications/initialized` → `tools/list` / `tools/call`。
 * 子类只需要实现"怎么把一条消息发出去 / 怎么收回来"。
 */
abstract class BaseConnection implements McpConnection {
  readonly serverName: string;
  readonly transport: McpTransport;
  protected readonly timeoutMs: number;
  protected readonly secrets: readonly string[];

  #closedReason: string | null = null;
  #closeListeners: Array<(reason: string) => void> = [];

  constructor(input: { serverName: string; transport: McpTransport; timeoutMs: number; secrets: readonly string[] }) {
    this.serverName = input.serverName;
    this.transport = input.transport;
    this.timeoutMs = input.timeoutMs;
    this.secrets = input.secrets;
  }

  /** 当前是否已经因为异常而不可用（子类用它决定还能不能写） */
  protected get closedReason(): string | null {
    return this.#closedReason;
  }

  /** 标记连接异常关闭，并通知监听者。重复调用只有第一次生效。 */
  protected markClosed(reason: string): void {
    if (this.#closedReason !== null) return;
    this.#closedReason = reason;
    for (const listener of this.#closeListeners) {
      try {
        listener(reason);
      } catch {
        /* 监听者自己炸了不该影响连接收尾 */
      }
    }
  }

  onClose(listener: (reason: string) => void): void {
    this.#closeListeners.push(listener);
  }

  async initialize(): Promise<void> {
    // ★ 顺序是协议硬要求：initialize 得到响应之后才能发 notifications/initialized，
    //   否则服务器会拒绝后续请求（"session not initialized"）。
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = asRecord(await this.request('tools/list', cursor === undefined ? {} : { cursor }));
      const rawTools = result === null ? [] : result['tools'];
      if (Array.isArray(rawTools)) {
        for (const raw of rawTools) {
          const tool = normalizeTool(raw);
          if (tool !== null) tools.push(tool);
        }
      }
      const next = result === null ? undefined : result['nextCursor'];
      if (typeof next === 'string' && next.length > 0) {
        cursor = next;
        continue;
      }
      break;
    }
    return tools;
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args ?? {} });
    return extractToolText(result);
  }

  protected abstract request(method: string, params: unknown): Promise<unknown>;
  protected abstract notify(method: string, params: unknown): Promise<void>;
  abstract close(): Promise<void>;
}

// ────────────────────────────── stdio ──────────────────────────────

type StdioConnectInput = {
  serverName: string;
  timeoutMs: number;
  secrets: readonly string[];
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string | null;
};

/**
 * Windows 上 `npx` / `uvx` 这类命令其实是 `.cmd` 垫片，直接 spawn 会 EINVAL。
 * ⇒ 只对 `.cmd` / `.bat` 走 shell，其余一律直接 spawn（不经 shell，路径里的空格与中文都不会被拆坏）。
 */
function spawnSpecification(command: string, args: readonly string[]): { command: string; args: string[]; shell: boolean } {
  const isWindows = process.platform === 'win32';
  if (isWindows && /\.(cmd|bat)$/i.test(command)) {
    // shell:true 时 Node 把 command 与 args 用空格拼接，所以引号得自己加。
    // ★ 已知限制：参数内部含双引号时不保证正确 —— 这种情况请写成 .exe 或用包装脚本。
    const quote = (value: string): string => (value.length === 0 ? '""' : /[\s"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
    return { command: [command, ...args].map(quote).join(' '), args: [], shell: true };
  }
  return { command, args: [...args], shell: false };
}

class StdioConnection extends BaseConnection {
  #child: ChildProcess;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = '';
  #stderr = '';
  #closing = false;

  constructor(input: StdioConnectInput) {
    super({
      serverName: input.serverName,
      transport: 'stdio',
      timeoutMs: input.timeoutMs,
      secrets: input.secrets,
    });

    const spec = spawnSpecification(input.command, input.args);
    this.#child = spawn(spec.command, spec.args, {
      ...(input.cwd === null ? {} : { cwd: input.cwd }),
      // ★ 用用户给的环境变量**叠加**在宿主环境上：MCP 服务器常常需要 PATH / SystemRoot 才能启动。
      env: { ...process.env, ...input.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(spec.shell ? { shell: true } : {}),
    });

    const decoder = new StringDecoder('utf8');
    // ★ 管道错误必须有人接：服务器进程秒退时，往 stdin 写会 EPIPE，
    //   不接就是一个未捕获异常（进程被拉起来又立刻死掉是常态，不是异常情况）。
    this.#child.stdin?.on('error', () => {
      /* 退出事件会给出真正的原因 */
    });
    this.#child.stdout?.on('error', () => {
      /* 同上 */
    });
    this.#child.stderr?.on('error', () => {
      /* 同上 */
    });

    this.#child.stdout?.on('data', (chunk: Buffer) => {
      this.#buffer += decoder.write(chunk);
      /**
       * ★★ 2026-11-11 审计 `ALK-MED-09`（第二半）：**单行缓冲必须有上限**。
       *
       * `#buffer` 只在遇到换行时被消费。一个吐了 200MB 却**没有换行**的服务器
       * （或一个把整个文件当作"一行"发出来的实现）会让这个字符串一路涨到把进程撑死 ——
       * 而它来自**我们对端**的行为，不是我们能控制的。
       * 上限取 32MB：正常 MCP 帧远小于它，超过就说明对端坏了，报错比 OOM 好。
       */
      if (this.#buffer.length > MAX_STDOUT_BUFFER_CHARS) {
        this.#buffer = '';
        this.#fail(`MCP 服务器输出的单帧超过上限（${String(MAX_STDOUT_BUFFER_CHARS)} 字符），已断开`);
        return;
      }
      this.#drain();
    });
    this.#child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_CHARS);
    });

    this.#child.on('error', (error) => {
      if (this.#closing) return;
      this.#fail(`无法启动 MCP 服务器进程（${input.command}）：${error.message}`);
    });

    this.#child.on('exit', (code, signal) => {
      if (this.#closing) return;
      const tail = this.#stderr.trim().length > 0 ? `；stderr：${this.#stderr.trim().slice(0, 400)}` : '';
      this.#fail(
        `MCP 服务器进程已退出（code=${String(code)}${signal === null ? '' : `, signal=${signal}`}）${tail}`,
      );
    });
  }

  protected request(method: string, params: unknown): Promise<unknown> {
    const closed = this.closedReason;
    if (closed !== null) return Promise.reject(new Error(closed));

    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = this.timeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new McpTimeoutError(`${this.serverName} · ${method}`, timeoutMs);
        // 超时视为这条连接已经不可用：把子进程收掉，避免"半死"状态下后续调用继续排队。
        this.#fail(error.message);
        reject(error);
      }, timeoutMs);

      this.#pending.set(id, { method, resolve, reject, timer });

      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  protected async notify(method: string, params: unknown): Promise<void> {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#rejectAll('MCP 连接已关闭');
    const child = this.#child;
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        killTree(child);
        resolveClose();
      }, 1_000);

      child.once('exit', () => {
        clearTimeout(timer);
        resolveClose();
      });

      try {
        child.stdin?.end();
        /**
         * ★★ 2026-11-11 审计 `ALK-MED-09`：**连进程树一起杀**。
         *
         * `child.kill()` 只结束**直接子进程**。而 MCP 的典型配置是 `npx @scope/server`
         * 或 `node launcher.js` —— 真正干活的进程是**孙子**。父进程死了它变成孤儿，
         * 继续占着端口、内存与句柄；反复重连就积一堆。
         * Windows 上用 `taskkill /T /F`（`/T` = 整棵树），其它平台退回到杀进程组。
         */
        killTree(child);
      } catch {
        clearTimeout(timer);
        resolveClose();
      }
    });
  }

  // ── 内部 ──

  #write(message: JsonRpcMessage): void {
    const closed = this.closedReason;
    if (closed !== null) throw new Error(closed);
    const stdin = this.#child.stdin;
    if (stdin === null || stdin === undefined || stdin.destroyed) {
      throw new Error(`MCP 服务器「${this.serverName}」的标准输入不可用（进程可能已退出）`);
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  #drain(): void {
    for (;;) {
      const index = this.#buffer.indexOf('\n');
      if (index === -1) break;
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      // ★ 空行、以及服务器打在 stdout 上的普通日志，都直接跳过（解析失败 = 日志）
      if (line.length > 0) this.#onLine(line);
    }
  }

  #onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    // 服务器发来的**请求**（有 id 又有 method）：我们不支持 sampling / roots，
    // 明确回一个错误。不回的话对端会一直等，双方都挂住。
    if (message.id !== undefined && message.id !== null && typeof message.method === 'string') {
      try {
        this.#write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not supported by the Alkaid MCP client' },
        });
      } catch {
        /* 写不进去说明已经断了，退出事件会处理 */
      }
      return;
    }

    if (message.id === undefined || message.id === null) return; // 通知，忽略
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    if (!Number.isFinite(id)) return;

    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    if (message.error !== undefined) {
      const detail = typeof message.error.message === 'string' ? message.error.message : '未知错误';
      pending.reject(new Error(`MCP 服务器返回错误（${pending.method}）：${detail}`));
      return;
    }
    pending.resolve(message.result);
  }

  #rejectAll(reason: string): void {
    const pending = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
    }
  }

  #fail(rawReason: string): void {
    if (this.closedReason !== null) return;
    const reason = redactSecrets(rawReason, this.secrets);
    this.markClosed(reason);
    this.#rejectAll(reason);
    killTree(this.#child);
  }
}

// ────────────────────────────── http ──────────────────────────────

type HttpConnectInput = {
  serverName: string;
  timeoutMs: number;
  secrets: readonly string[];
  url: string;
  headers: Readonly<Record<string, string>>;
};

/** 逐行取 `data:`（SSE）。一个事件可能有多行 `data:`，按规范用换行拼接。 */
function parseSseMessages(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  let dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n').trim();
    dataLines = [];
    if (payload.length === 0) return;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed !== null && typeof parsed === 'object') messages.push(parsed as JsonRpcMessage);
    } catch {
      /* 不是 JSON 的事件（比如服务器的心跳注释）忽略 */
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue; // 注释 / 心跳
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return messages;
}

function parseJsonMessage(text: string): JsonRpcMessage[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is JsonRpcMessage => item !== null && typeof item === 'object');
    if (parsed !== null && typeof parsed === 'object') return [parsed as JsonRpcMessage];
  } catch {
    /* 非 JSON 响应体 */
  }
  return [];
}

class HttpConnection extends BaseConnection {
  #url: string;
  #headers: Record<string, string>;
  /** `initialize` 响应头里可能给会话 id，后续请求必须带上（streamable-http 的要求） */
  #sessionId: string | null = null;
  #protocolVersion: string | null = null;
  #nextId = 1;
  #closed = false;

  constructor(input: HttpConnectInput) {
    super({
      serverName: input.serverName,
      transport: 'http',
      timeoutMs: input.timeoutMs,
      secrets: input.secrets,
    });
    this.#url = input.url;
    this.#headers = { ...input.headers };
  }

  protected async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error('MCP 连接已关闭');
    const id = this.#nextId;
    this.#nextId += 1;

    const reply = await this.#post({ jsonrpc: '2.0', id, method, params }, method);
    if (reply === null) throw new Error(`MCP HTTP 服务器没有返回「${method}」的响应`);
    if (reply.error !== undefined) {
      const detail = typeof reply.error.message === 'string' ? reply.error.message : '未知错误';
      throw new Error(`MCP 服务器返回错误（${method}）：${detail}`);
    }
    return reply.result;
  }

  protected async notify(method: string, params: unknown): Promise<void> {
    if (this.#closed) return;
    // 通知的响应通常是 202 空体，直接丢掉。
    await this.#post({ jsonrpc: '2.0', method, params }, method);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  async #post(message: JsonRpcMessage, method: string): Promise<JsonRpcMessage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // ★ 必须是两个都声明：只报 application/json 的服务器会走普通 JSON，
        //   只回声明的服务器才会用 SSE 流式返回。
        accept: 'application/json, text/event-stream',
        ...this.#headers,
        ...(this.#sessionId === null ? {} : { 'mcp-session-id': this.#sessionId }),
        ...(this.#protocolVersion === null ? {} : { 'mcp-protocol-version': this.#protocolVersion }),
      };

      const response = await fetch(this.#url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      const session = response.headers.get('mcp-session-id');
      if (session !== null && session.length > 0) this.#sessionId = session;
      const protocol = response.headers.get('mcp-protocol-version');
      if (protocol !== null && protocol.length > 0) this.#protocolVersion = protocol;

      if (response.status === 202 || response.status === 204) return null;

      const text = await response.text();
      if (!response.ok) {
        const detail = text.trim().length > 0 ? `：${text.trim().slice(0, 300)}` : '';
        throw new Error(`MCP HTTP 服务器返回 ${String(response.status)} ${response.statusText}${detail}`);
      }
      if (text.trim().length === 0) return null;

      const contentType = response.headers.get('content-type') ?? '';
      const messages = contentType.includes('text/event-stream')
        ? parseSseMessages(text)
        : parseJsonMessage(text);

      const wanted = typeof message.id === 'number' ? message.id : null;
      if (wanted !== null) {
        for (const candidate of messages) {
          const candidateId = typeof candidate.id === 'number' ? candidate.id : Number(candidate.id);
          if (Number.isFinite(candidateId) && candidateId === wanted) return candidate;
        }
      }
      // 有些实现直接把结果体放在响应里（不回 id）；只有一条消息时就认它。
      if (messages.length === 1) return messages[0] ?? null;
      // 通知的响应（没有 id）在这里返回 null。
      if (wanted === null) return null;

      throw new Error(`MCP HTTP 服务器返回了 ${String(messages.length)} 条消息，但没有一条匹配请求 id=${String(wanted)}`);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new McpTimeoutError(`${this.serverName} · ${method}`, this.timeoutMs);
      }
      // ★ 这里绝不能带上 headers/env（是 token）；URL 与错误自身文案可以。
      throw new Error(redactSecrets(`MCP HTTP 调用失败（${method}）：${errorText(error)}`, this.secrets));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ────────────────────────────── 对外入口 ──────────────────────────────

/**
 * 建立一条 MCP 连接并完成握手（`initialize` + `notifications/initialized`）。
 *
 * ★ 失败时会**先把子进程收掉**再抛错 —— 否则配置错一次就留一个僵尸进程。
 * ★ `tools/list` 不在这里做：连接成功 ≠ 能列工具，两者失败原因不同，
 *   上层需要分别展示（"连不上" vs "连上了但列不出来"）。
 */
export async function connectMcpServer(input: McpConnectInput): Promise<McpConnection> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const secrets = collectSecrets(input);

  // 用内部基类类型：`initialize()` 只在握手阶段用，不该出现在对外的 McpConnection 契约里
  let connection: BaseConnection;
  if (input.transport === 'stdio') {
    const command = (input.command ?? '').trim();
    if (command.length === 0) throw new Error(`MCP 服务器「${input.name}」是 stdio 传输，但没有 command`);
    connection = new StdioConnection({
      serverName: input.name,
      timeoutMs,
      secrets,
      command,
      args: [...(input.args ?? [])],
      env: input.env ?? {},
      cwd: input.cwd ?? null,
    });
  } else {
    const url = (input.url ?? '').trim();
    if (url.length === 0) throw new Error(`MCP 服务器「${input.name}」是 http 传输，但没有 url`);
    connection = new HttpConnection({
      serverName: input.name,
      timeoutMs,
      secrets,
      url,
      headers: input.headers ?? {},
    });
  }

  try {
    await connection.initialize();
  } catch (error) {
    await connection.close();
    throw error instanceof Error ? error : new Error(String(error));
  }
  return connection;
}
