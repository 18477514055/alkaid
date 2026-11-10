/**
 * 插件协议（JSONL over stdio）。
 *
 * 为什么是**子进程 + 逐行 JSON**，而不是进程内 import：
 * 任务书 §10.2 F 要求"插件异常时核心聊天仍然可用"。进程内做不到 —— 一次 throw、
 * 一个死循环、一次 process.exit 就能带走宿主。这不是防御性编程问题，是**边界位置**问题。
 *
 * 协议刻意做得很小：五条消息。插件作者不需要理解内核。
 */

export const PLUGIN_PROTOCOL_VERSION = 1;

/** 插件在 `ready` 里声明的工具 */
export type PluginToolDecl = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema（object 根） */
  readonly parameters: Record<string, unknown>;
};

/** 调用插件工具时带给它的上下文（只读信息，不含任何密钥） */
export type PluginCallContext = {
  readonly conversationId: string;
  readonly permissionMode: string;
  readonly workspacePath: string | null;
  readonly projectSharedDir: string | null;
};

export type HostToPlugin =
  | { readonly type: 'initialize'; readonly protocolVersion: number }
  | {
      readonly type: 'tool.call';
      readonly callId: string;
      readonly tool: string;
      readonly args: unknown;
      readonly ctx: PluginCallContext;
    }
  | { readonly type: 'event'; readonly name: string; readonly payload: unknown };

export type PluginToHost =
  | {
      readonly type: 'ready';
      readonly name: string;
      readonly version?: string;
      readonly tools: readonly PluginToolDecl[];
    }
  | {
      readonly type: 'tool.result';
      readonly callId: string;
      readonly ok: boolean;
      readonly content?: string;
      readonly error?: string;
    };

/** 插件清单：`plugins/<name>/plugin.json` */
export type PluginManifest = {
  readonly id: string;
  readonly name: string;
  /** 相对插件目录的入口文件（.ts / .js 都行，Node 24 能直接跑 .ts） */
  readonly entry: string;
  readonly enabled?: boolean;
};

export function encodeLine(message: HostToPlugin | Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}
