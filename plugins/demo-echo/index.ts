/**
 * 演示插件：用来验证三件事（对应任务书 §11 测试六）
 *
 * 1. `echo` —— 工具能注册进内核，能被调用；
 * 2. `boom` —— 插件进程**真的死掉**时，内核聊天不受影响；
 * 3. 生命周期事件 —— 内核会推 `conversation.created` / `message.completed` / `turn.finished`。
 *
 * 注意：插件进程拥有当前用户的完整权限，内核的路径围栏管不到它。
 * 所以插件工具只在**完全权限**档可见。装插件 = 信任作者。
 */
import { definePlugin } from '../_sdk/plugin.ts';

definePlugin({
  name: 'demo-echo',
  version: '0.1.0',
  tools: [
    {
      name: 'echo',
      description: '把收到的文本原样回声回来（用于验证插件工具注册与调用）',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回声的文本' } },
        required: ['text'],
        additionalProperties: false,
      },
      run(args) {
        const text = typeof (args as { text?: unknown }).text === 'string' ? (args as { text: string }).text : '';
        return `echo: ${text}`;
      },
    },
    {
      name: 'whoami',
      description: '返回插件进程看到的调用上下文（会话、权限档、工作区）',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run(_args, ctx) {
        return JSON.stringify(ctx);
      },
    },
    {
      name: 'boom',
      description: '故意让插件进程崩溃 —— 用来验证"插件崩溃不会带崩内核"',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        // 直接退出，模拟插件被自己写崩
        process.exit(1);
      },
    },
  ],
  onEvent(name, payload) {
    // 只写 stderr：stdout 是协议通道，不能污染
    process.stderr.write(`[demo-echo] event ${name}: ${JSON.stringify(payload)}\n`);
  },
});
