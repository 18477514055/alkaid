import { PERMISSION_MODE_SPEC } from '../../policy/mode.ts';
import type { PromptContext, PromptSection, PromptSource } from './types.ts';
import { memorySource } from './memory.ts';

/**
 * 内置三段：身份 / 硬规则 / 运行环境。
 *
 * ★ 这三段的内容**故意写得短**。长一句就多占缓存前缀，且模型对"规则"的注意力会被稀释；
 *   真正需要细节的东西应该走工具（模型自己查），而不是塞进提示词。
 */

export const identitySource: PromptSource = {
  id: 'builtin.identity',
  description: '你是谁、当前在哪台机器上、能做什么',
  sections: () => [
    {
      id: 'identity',
      title: '',
      stability: 'static',
      priority: 10,
      render() {
        return '你是**瑶光**（Alkaid），一个运行在用户本机的个人 AI Agent。你不是云端服务：你的每一次工具调用都发生在用户自己的电脑上。';
      },
    },
  ],
};

export const rulesSource: PromptSource = {
  id: 'builtin.rules',
  description: '硬规则：权限、真实性、输出风格',
  sections: () => [
    {
      id: 'rules',
      title: '硬规则',
      stability: 'static',
      priority: 20,
      render() {
        return [
          '1. 权限由程序强制执行，不靠你自觉。被拒绝时读返回的 `reason` 与 `hint`，**不要用同样的参数重试**。',
          '2. 不确定的事先查证（用工具去看），**不要编造**文件内容、命令输出或执行结果。',
          '3. 没有真正执行过的操作，不要声称已经执行过。',
          '4. 只做用户要求的事；超出范围的改动先问。',
          '5. 回复用中文，简洁直接，先给结论再给依据。',
        ].join('\n');
      },
    },
  ],
};

export const environmentSource: PromptSource = {
  id: 'builtin.environment',
  description: '当前权限模式、工作区、项目共享目录与可用工具',
  sections: () => [
    {
      id: 'environment',
      title: '当前运行环境',
      stability: 'session',
      priority: 10,
      render(context: PromptContext) {
        const spec = PERMISSION_MODE_SPEC[context.permissionMode];
        const tools =
          context.toolNames.length > 0 ? context.toolNames.join(', ') : '无（本阶段尚未注册任何工具）';
        return [
          `- 权限模式：${spec.promptValue}（${spec.hint}）`,
          `- 工作区：${context.workspacePath ?? '未绑定'}`,
          `- 项目共享目录：${context.projectSharedDir ?? '无'}`,
          `- 可用工具：${tools}`,
        ].join('\n');
      },
    },
  ],
};

/**
 * 用户自定义指令（会话级）。
 *
 * ★ 单独成段而不是拼进规则里：用户写的东西要**原样**进提示，
 *   不能让我们的编号规则把它挤变形，也不能被模型当成"系统硬规则"。
 */
export const userInstructionsSource: PromptSource = {
  id: 'builtin.user-instructions',
  description: '用户在会话里写的自定义指令',
  sections: () => [
    {
      id: 'user-instructions',
      title: '用户自定义指令',
      stability: 'session',
      priority: 50,
      render(context: PromptContext) {
        const text = context.userInstructions?.trim() ?? '';
        if (text.length === 0) return null;
        return `以下是用户为本会话指定的额外要求，**优先级高于上面的输出风格**，但仍不得违反硬规则：\n\n${text}`;
      },
    },
  ],
};

/**
 * 已压缩历史的摘要。
 *
 * ★ 放 `turn` 但排在最末：压缩一旦发生前缀就变了，这是不可避免的；
 *   只要它始终在最后，就不会连带把前面的缓存打掉。
 */
export const summarySource: PromptSource = {
  id: 'builtin.compaction-summary',
  description: '已压缩区间的摘要（带 seq 指针，可用 recall 取回原文）',
  sections: () => [
    {
      id: 'compaction-summary',
      title: '',
      stability: 'turn',
      priority: 900,
      render(context: PromptContext) {
        const block = context.summaryBlock?.trim() ?? '';
        return block.length > 0 ? block : null;
      },
    },
  ],
};

export const memoryContextSource: PromptSource = {
  id: 'builtin.memory-context', description: '上下文水线、检查点与未固化进展欠账（不自动调用模型）',
  sections: () => [{ id: 'memory-context', title: '上下文状态信号', stability: 'turn', priority: 950,
    render: context => context.memoryContextSignal ?? null }],
};
export function builtinSources(): PromptSource[] {
  return [identitySource, rulesSource, environmentSource, userInstructionsSource, memorySource, summarySource, memoryContextSource];
}

export type { PromptSection };
