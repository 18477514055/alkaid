import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { fitToolName, sanitizeToolChars } from '../../shared/tool-name.ts';
import type { PermissionMode } from '../policy/mode.ts';
import type { ToolDefinition, ToolOutcome, ToolRegistry } from '../tools/types.ts';
import { readManifestFile, setManifestEnabled } from './manifest.ts';
import {
  PLUGIN_PROTOCOL_VERSION,
  encodeLine,
  type HostToPlugin,
  type PluginCallContext,
  type PluginManifest,
  type PluginToHost,
  type PluginToolDecl,
} from './protocol.ts';

/**
 * 插件宿主。
 *
 * 三条底线：
 * 1. **崩溃隔离**：插件进程退出只让**它的工具**不可用，聊天照常继续进行。
 * 2. **超时**：握手 5s、工具调用 30s；超时就杀掉子进程，不挂在那儿等。
 * 3. **插件工具算「完全权限」级能力**：插件进程拥有当前用户完整权限，进程内围栏管不到它
 *    ⇒ 它的工具只在 full 档可见（与 shell 同一个理由）。装插件 = 信任作者。
 *
 * 实现上只用一个"等待者队列"：每条请求挂一个谓词，来消息时找第一个匹配的。
 * 比按 callId 建映射简单，且天然支持 `ready` 这种没有 id 的回复。
 */

const DEFAULT_INIT_TIMEOUT_MS = 5_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export type PluginStatus = 'ready' | 'failed' | 'disabled';

type Waiter = {
  readonly matches: (message: PluginToHost) => boolean;
  readonly resolve: (message: PluginToHost) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

type Runtime = {
  /** ★ 可变：`setEnabled` 会把 `enabled` 改掉并落盘（旧版只改内存，重启就丢） */
  manifest: PluginManifest;
  readonly dir: string;
  status: PluginStatus;
  error: string | null;
  child: ChildProcess | null;
  tools: PluginToolDecl[];
  waiters: Waiter[];
  seq: number;
};

export type PluginHostOptions = {
  readonly dir: string;
  readonly execPath?: string;
  readonly initTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  /** 用来注册/注销工具；不传就只做生命周期管理 */
  readonly registry?: ToolRegistry;
};

export type PluginInfo = {
  readonly id: string;
  readonly name: string;
  readonly status: PluginStatus;
  readonly error: string | null;
  readonly toolNames: readonly string[];
};

export class PluginHost {
  #runtimes = new Map<string, Runtime>();
  #dir: string;
  #execPath: string;
  #initTimeoutMs: number;
  #toolTimeoutMs: number;
  #registry: ToolRegistry | undefined;
  #disposed = false;

  constructor(options: PluginHostOptions) {
    this.#dir = options.dir;
    this.#execPath = options.execPath ?? process.execPath;
    this.#initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.#toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#registry = options.registry;
  }

  list(): PluginInfo[] {
    return [...this.#runtimes.values()].map((runtime) => ({
      id: runtime.manifest.id,
      name: runtime.manifest.name,
      status: runtime.status,
      error: runtime.error,
      toolNames: runtime.tools.map((tool) => toolName(runtime, tool.name)),
    }));
  }

  async loadAll(): Promise<PluginInfo[]> {
    if (!existsSync(this.#dir)) return [];

    for (const manifest of readManifests(this.#dir)) {
      this.#runtimes.set(manifest.id, {
        manifest,
        dir: join(this.#dir, manifest.id),
        status: manifest.enabled === false ? 'disabled' : 'failed',
        error: null,
        child: null,
        tools: [],
        waiters: [],
        seq: 0,
      });
    }

    const toStart = [...this.#runtimes.values()].filter((runtime) => runtime.manifest.enabled !== false);
    await Promise.all(toStart.map((runtime) => this.start(runtime.manifest.id)));
    return this.list();
  }

  /**
   * ★★ 2026-11-11 审计 `ALK-MED-10`：同一个插件**串行启动**。
   *
   * `start()` 是 `await #stop(runtime)` 之后再 `spawn`。两次并发调用（双击「重新连接」、
   * 或者「保存设置」与「重连」同时到）会交错：A 停完 → B 停（此时没东西可停）→ B 起 →
   * A 起 ⇒ **两个宿主进程同时活着**，各自注册一遍工具、各自发一遍事件。
   * 症状是工具列表里出现重复项、工具调用被处理两次。
   *
   * 判据：每个插件一条串行链。后到的调用排队等前一个结束，绝不并行。
   */
  readonly #starting = new Map<string, Promise<void>>();

  async start(id: string): Promise<void> {
    const runtime = this.#runtimes.get(id);
    if (runtime === undefined || this.#disposed) return;

    const previous = this.#starting.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#startOnce(runtime));
    this.#starting.set(id, next);
    try {
      await next;
    } finally {
      // 只有还是自己这条链时才清掉，避免把后来者的链删了
      if (this.#starting.get(id) === next) this.#starting.delete(id);
    }
  }

  async #startOnce(runtime: Runtime): Promise<void> {
    if (this.#disposed) return;

    await this.#stop(runtime);
    this.#unregisterTools(runtime);

    const entryPath = resolve(runtime.dir, runtime.manifest.entry);
    if (!existsSync(entryPath)) {
      runtime.status = 'failed';
      runtime.error = `入口文件不存在：${entryPath}`;
      return;
    }

    const child = spawn(this.#execPath, [entryPath], {
      cwd: runtime.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ALKAID_PLUGIN: '1' },
    });

    runtime.child = child;
    runtime.status = 'failed';
    runtime.error = '握手未完成';
    runtime.tools = [];

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index === -1) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) this.#onMessage(runtime, line);
      }
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1_000);
    });

    child.on('exit', (code) => {
      runtime.child = null;
      this.#rejectAll(runtime, new Error(`插件进程已退出（code=${String(code)}）`));
      if (runtime.status === 'ready') {
        runtime.status = 'failed';
        runtime.error = `插件进程意外退出（code=${String(code)}）${stderr.trim().length > 0 ? `：${stderr.trim().slice(0, 200)}` : ''}`;
        this.#unregisterTools(runtime);
      }
    });

    child.on('error', (error) => {
      runtime.status = 'failed';
      runtime.error = `启动失败：${error.message}`;
    });

    try {
      const ready = await this.#wait(runtime, (message) => message.type === 'ready', this.#initTimeoutMs, () =>
        this.#send(runtime, { type: 'initialize', protocolVersion: PLUGIN_PROTOCOL_VERSION }),
      );
      if (ready.type !== 'ready') throw new Error('握手没有返回 ready');

      runtime.tools = [...ready.tools];
      runtime.status = 'ready';
      runtime.error = null;
      this.#registerTools(runtime);
    } catch (error) {
      runtime.status = 'failed';
      runtime.error = error instanceof Error ? error.message : String(error);
      await this.#stop(runtime);
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const runtime = this.#runtimes.get(id);
    if (runtime === undefined) throw new Error(`没有这个插件：${id}`);

    if (enabled) {
      await this.start(id);
      // ★ 先落盘再算数：start 可能失败（入口文件丢了 / 握手超时），
      //   但用户"我要它启用"的意图仍然要留住 —— 否则他每次重启都得再点一遍。
      await this.#persistEnabled(runtime, true);
      return;
    }

    this.#unregisterTools(runtime);
    await this.#stop(runtime);
    runtime.status = 'disabled';
    runtime.error = null;
    await this.#persistEnabled(runtime, false);
  }

  /**
   * 把 `enabled` 写回 `plugin.json`（持锁 + 原子写）。
   *
   * ★★ 为什么这条必须补（阶段一第 5 条的真实症状）：旧版的 `setEnabled` **只改内存**，
   *   而 `loadAll()` 读的是清单里的 `enabled` ⇒ **在界面上关掉的插件，重启后又活了**。
   *   一次关窗口、一次断电，用户的决定就没了。
   *
   * ★ 写失败要**抛**，不能吞：用户点了"停用"、界面回 200、实际没写进去，
   *   那比直接报错更糟（他会以为自己已经关掉了 —— 插件下次启动还带着完整权限跑）。
   *   内存状态保持已改（插件确实停了），并把 `error` 写清楚，让界面能显示"已停用但没保存成功"。
   */
  async #persistEnabled(runtime: Runtime, enabled: boolean): Promise<void> {
    const path = join(runtime.dir, 'plugin.json');
    try {
      await setManifestEnabled(path, enabled);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.error = `已${enabled ? '启用' : '停用'}，但清单写入失败（重启后会恢复原状态）：${message}`;
      throw new Error(runtime.error);
    }
    runtime.manifest = { ...runtime.manifest, enabled };
    // ★ 只清"写盘失败"这一类错误：启用时 `start()` 可能刚把「入口文件不存在」
    //   写进 `runtime.error`，这里若无条件置 null，用户会看到一个"启用成功"的假象。
    if (runtime.status !== 'failed') runtime.error = null;
  }

  /** 生命周期事件是**单向通知**：插件写失败也不影响主流程 */
  broadcast(name: string, payload: unknown): void {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.status !== 'ready' || runtime.child === null) continue;
      try {
        runtime.child.stdin?.write(encodeLine({ type: 'event', name, payload }));
      } catch {
        /* 忽略 */
      }
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const runtime of this.#runtimes.values()) {
      this.#unregisterTools(runtime);
      await this.#stop(runtime);
    }
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  #registerTools(runtime: Runtime): void {
    const registry = this.#registry;
    if (registry === undefined) return;

    for (const decl of runtime.tools) {
      const name = toolName(runtime, decl.name);
      const definition: ToolDefinition = {
        name,
        description: `${decl.description}（来自插件 ${runtime.manifest.name}）`,
        parameters: decl.parameters,
        modes: ['full'] as readonly PermissionMode[],
        // ── 元信息：让设置页能按来源分组、按需加载 ──
        // ★ 插件工具**默认按需**：数量不可控（可能上百），且大部分时候用不到。
        //   常驻它们会把每一轮的缓存前缀吃掉。
        source: 'plugin',
        kind: 'external',
        group: 'plugin',
        displayName: `${runtime.manifest.name} · ${decl.name}`,
        summary: `来自插件 ${runtime.manifest.name}`,
        oneLiner: decl.description,
        preferredMode: 'lazy',
        execute: async (rawArgs, ctx): Promise<ToolOutcome> => {
          if (runtime.status !== 'ready') {
            return {
              ok: false,
              code: 'plugin_unavailable',
              message: `插件 ${runtime.manifest.name} 当前不可用（${runtime.status}）`,
              hint: '不要重试；告诉用户插件已停用或崩溃，需要重新启用。',
            };
          }

          const callId = `${runtime.manifest.id}-${(runtime.seq += 1)}`;
          const callCtx: PluginCallContext = {
            conversationId: ctx.conversationId,
            permissionMode: ctx.permissionMode,
            workspacePath: ctx.workspacePath,
            projectSharedDir: ctx.projectSharedDir,
          };

          try {
            const reply = await this.#wait(
              runtime,
              (message) => message.type === 'tool.result' && message.callId === callId,
              this.#toolTimeoutMs,
              () =>
                this.#send(runtime, {
                  type: 'tool.call',
                  callId,
                  tool: decl.name,
                  args: rawArgs,
                  ctx: callCtx,
                }),
            );

            if (reply.type !== 'tool.result') {
              return { ok: false, code: 'plugin_bad_reply', message: '插件回复了无法识别的消息' };
            }
            if (reply.ok) return { ok: true, content: reply.content ?? '' };
            return {
              ok: false,
              code: 'plugin_error',
              message: reply.error ?? '插件返回失败但没有说明原因',
              hint: '这是插件自身的问题；不要用同样参数重试，把错误告诉用户。',
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const timedOut = message.includes('超时');
            if (timedOut) await this.#stop(runtime);
            return {
              ok: false,
              code: timedOut ? 'plugin_timeout' : 'plugin_crashed',
              message: `插件 ${runtime.manifest.name} 调用失败：${message}`,
              hint: '这是插件的问题，不是你的参数问题；不要重试，直接告诉用户。',
            };
          }
        },
      };

      registry.unregister(name);
      registry.register(definition);
    }
  }

  #unregisterTools(runtime: Runtime): void {
    const registry = this.#registry;
    if (registry === undefined) return;
    for (const decl of runtime.tools) registry.unregister(toolName(runtime, decl.name));
  }

  #send(runtime: Runtime, message: HostToPlugin): void {
    const stdin = runtime.child?.stdin;
    if (stdin === null || stdin === undefined) throw new Error('插件进程不可用');
    stdin.write(encodeLine(message));
  }

  /** 挂一个等待者，然后执行 `send`；超时或进程退出都会 reject */
  #wait(
    runtime: Runtime,
    matches: (message: PluginToHost) => boolean,
    timeoutMs: number,
    send: () => void,
  ): Promise<PluginToHost> {
    return new Promise<PluginToHost>((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        const index = runtime.waiters.findIndex((waiter) => waiter.resolve === resolveWait);
        if (index >= 0) runtime.waiters.splice(index, 1);
        rejectWait(new Error(`插件响应超时（${timeoutMs}ms）`));
      }, timeoutMs);

      runtime.waiters.push({ matches, resolve: resolveWait, reject: rejectWait, timer });

      try {
        send();
      } catch (error) {
        clearTimeout(timer);
        const index = runtime.waiters.findIndex((waiter) => waiter.resolve === resolveWait);
        if (index >= 0) runtime.waiters.splice(index, 1);
        rejectWait(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #onMessage(runtime: Runtime, line: string): void {
    let message: PluginToHost;
    try {
      message = JSON.parse(line) as PluginToHost;
    } catch {
      return; // 插件打的普通日志，忽略
    }

    const index = runtime.waiters.findIndex((waiter) => waiter.matches(message));
    if (index === -1) return;

    const waiter = runtime.waiters[index];
    if (waiter === undefined) return;
    runtime.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  #rejectAll(runtime: Runtime, error: Error): void {
    const waiters = runtime.waiters;
    runtime.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  async #stop(runtime: Runtime): Promise<void> {
    const child = runtime.child;
    runtime.child = null;
    if (child === null || child.killed) return;

    this.#rejectAll(runtime, new Error('插件已停止'));

    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolveStop();
      }, 1_000);

      child.once('exit', () => {
        clearTimeout(timer);
        resolveStop();
      });

      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolveStop();
      }
    });
  }
}

/**
 * 插件工具名的前缀与分隔符。
 *
 * ★ 真事故（2026-11-08）：原来用 `p.<插件id>.<工具名>`，而 **OpenAI 兼容网关要求工具名
 *   匹配 `^[a-zA-Z0-9_-]+$`** —— 点号不合法。一旦装了任何插件，工具表里就带点号，
 *   上游会把整轮请求判为 400（`Invalid 'tools[N].name': string does not match pattern`），
 *   **整个应用从此不能用**，而错误文案经常被网关翻译成毫不相干的 "missing role field"。
 *   ⇒ 分隔符一律用下划线，且最终名必须过 `sanitizeToolName` 的同一套字符集。
 */
const PLUGIN_TOOL_PREFIX = 'p_';

/**
 * 把任意字符串压成上游接受的**字符集**（只留字母数字下划线连字符）。
 *
 * ★ 只做字符集，**不做长度** —— 长度与撞名由 {@link toolName} 统一处理
 *   （那里才知道"完整的原始标识"是什么）。见 `shared/tool-name.ts` 的三条判据。
 */
export function sanitizeToolName(raw: string): string {
  return sanitizeToolChars(raw);
}

/**
 * 插件工具的线上名字：`p_<插件id>_<工具名>`，**截断到 64 且不撞名**。
 *
 * ★★ 2026-11-08 那次 400 事故修的是**字符集**；**长度**这个口子当时还在：
 *   id 40 字符 + 工具名 40 字符 ⇒ 83 字符 > 上游 64 上限 ⇒ 同样整轮 400。
 *   而且单纯截断会让两个前缀相同的工具**撞成同一个名字**（工具表静默少一个）。
 *   ⇒ 统一走 `fitToolName`：超长时保留 51 字符 + `_` + 12 位稳定哈希，
 *   哈希的输入是**原始 id 与原始工具名**（不是清洗后的串 —— 否则 `a.b` 与 `a/b`
 *   这种清洗后同形的来源仍会撞）。
 */
function toolName(runtime: Runtime, tool: string): string {
  return pluginToolName(runtime.manifest.id, tool);
}

/**
 * 插件工具的线上名字（导出以便单测直接钉住契约，不必起子进程）。
 *
 * ★ 判据同 {@link toolName}：哈希的输入必须是**原始** id 与工具名。
 */
export function pluginToolName(pluginId: string, tool: string): string {
  return fitToolName(`${PLUGIN_TOOL_PREFIX}${pluginId}_${tool}`, `${pluginId}\0${tool}`);
}

function readManifests(dir: string): PluginManifest[] {
  const out: PluginManifest[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name);
  } catch {
    return out;
  }

  for (const name of entries) {
    // ★ 读侧与写侧共用同一套解析（`manifest.ts`）：两边各写一份的话，
    //   "写进去的字段"与"读得懂的字段"迟早分叉 —— 那就是"设置存了但没生效"那一类事故。
    const manifest = readManifestFile(join(dir, name, 'plugin.json'));
    if (manifest !== null) out.push(manifest);
  }
  return out;
}
