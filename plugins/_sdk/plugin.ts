/**
 * 插件 SDK —— 让插件作者只写业务逻辑，不用手写 JSONL 协议。
 *
 * 用法：
 * ```ts
 * import { definePlugin } from '../_sdk/plugin.ts';
 * definePlugin({
 *   name: 'my-plugin',
 *   tools: [{ name: 'hello', description: '...', parameters: {…}, run: (args) => '...' }],
 * });
 * ```
 *
 * 协议本体见 `src/core/plugin/protocol.ts`。这里的每条消息都必须以**整行 JSON** 写出，
 * 且 stdout 只能写协议消息 —— 插件自己的调试输出要走 stderr。
 */

export type PluginToolContext = {
  readonly conversationId: string;
  readonly permissionMode: string;
  readonly workspacePath: string | null;
  readonly projectSharedDir: string | null;
};

export type PluginTool = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema（object 根） */
  readonly parameters: Record<string, unknown>;
  run(args: unknown, ctx: PluginToolContext): Promise<string> | string;
};

export type PluginDefinition = {
  readonly name: string;
  readonly version?: string;
  readonly tools: readonly PluginTool[];
  /** 生命周期事件回调（单向通知，不用回） */
  readonly onEvent?: (name: string, payload: unknown) => void;
};

type Incoming =
  | { type: 'initialize'; protocolVersion: number }
  | { type: 'tool.call'; callId: string; tool: string; args: unknown; ctx: PluginToolContext }
  | { type: 'event'; name: string; payload: unknown };

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function definePlugin(definition: PluginDefinition): void {
  const tools = new Map(definition.tools.map((tool) => [tool.name, tool]));

  let buffer = '';
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;

      let message: Incoming;
      try {
        message = JSON.parse(line) as Incoming;
      } catch {
        continue;
      }

      if (message.type === 'initialize') {
        write({
          type: 'ready',
          name: definition.name,
          version: definition.version ?? '0.0.0',
          tools: definition.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        });
        continue;
      }

      if (message.type === 'event') {
        definition.onEvent?.(message.name, message.payload);
        continue;
      }

      if (message.type === 'tool.call') {
        const tool = tools.get(message.tool);
        if (tool === undefined) {
          write({ type: 'tool.result', callId: message.callId, ok: false, error: `插件里没有工具：${message.tool}` });
          continue;
        }

        void (async () => {
          try {
            const content = await tool.run(message.args, message.ctx);
            write({ type: 'tool.result', callId: message.callId, ok: true, content: String(content) });
          } catch (error) {
            write({
              type: 'tool.result',
              callId: message.callId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      }
    }
  });
}
