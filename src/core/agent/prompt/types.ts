import type { PermissionMode } from '../../policy/mode.ts';

/**
 * 系统提示的**分段模型**。
 *
 * 为什么要分段，而不是拼一个大字符串：
 * 1. **可注入**：未来各种来源（记忆、项目文件、技能、插件、用户自定义指令）都要往里加东西。
 *    每加一种就改一次 `buildSystemPrompt` 的字符串，是最容易出事的写法 —— 顺序与去重全靠人记。
 * 2. **可检查**：界面要能"看清系统提示到底长什么样、哪一段占了多少字"。
 *    分段之后，每一段自带 id/标题/字数，模型看到什么一目了然。
 * 3. **可保住缓存**：prompt cache 命中的前提是**前缀不变**。分段之后可以按"稳定度"排序，
 *    把永不变的放最前，每轮都变的放最后 —— 这是结构保证，而不是靠写代码时记得。
 */

/**
 * 稳定度（决定排序，直接决定缓存命中率）：
 * - `static`  永不变化（身份、硬规则）→ 最前
 * - `session` 会话级（权限档、工作区、工具集）→ 次之
 * - `turn`    每轮可能变（压缩摘要、记忆召回、时间）→ 最后
 */
export type PromptStability = 'static' | 'session' | 'turn';

export type PromptContext = {
  readonly conversationId: string;
  readonly agentRole?: 'main' | 'subagent';
  readonly permissionMode: PermissionMode;
  readonly workspacePath: string | null;
  readonly projectSharedDir: string | null;
  readonly toolNames: readonly string[];
  /** 用户自定义指令（会话级） */
  readonly userInstructions: string | null;
  /** 已压缩历史的摘要文本（可为空） */
  readonly summaryBlock: string | null;
  /** Official project snapshot, frozen for a turn. Never includes pending proposal bodies. */
  readonly projectMemory?: string | null;
  /** Model-visible waterline/debt/checkpoint signal, shared with the prompt viewer. */
  readonly memoryContextSignal?: string | null;
};

export type PromptSection = {
  /** 段的稳定标识，用于去重与界面展示 */
  readonly id: string;
  /** 段标题（渲染成 `## 标题`；空字符串表示不加标题） */
  readonly title: string;
  readonly stability: PromptStability;
  /** 同稳定度内的顺序，小的在前 */
  readonly priority: number;
  /** 返回 null / 空串表示这一段这次不出现 */
  render(context: PromptContext): string | null;
};

/**
 * **注入源**（injection stream）。
 *
 * 任何未来要往系统提示里加内容的东西，实现这一个接口即可接入 ——
 * 不用改主循环、不用知道别人排在哪儿。
 *
 * ★ 约束：`sections` 必须**纯函数**（同样 context 两次调用必须得到同样结果），
 *   否则缓存前缀会被随机打散。
 */
export type PromptSource = {
  readonly id: string;
  /** 这个源为什么存在（一句话，界面上显示；便于以后判断哪些该关掉） */
  readonly description: string;
  sections(context: PromptContext): readonly PromptSection[];
};
