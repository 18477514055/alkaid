import { DESCRIBE_TOOL_NAME, renderToolDefinition, type ToolModeMap } from './catalog.ts';
import { searchTools } from './search.ts';
import type { PermissionMode } from '../policy/mode.ts';
import type { ToolDefinition, ToolOutcome, ToolRegistry } from './types.ts';

/** 一次最多召回几个（对齐 Anthropic 默认 5 个的量级，省往返也省上下文）。 */
const MAX_DESCRIBE_BATCH = 8;

/**
 * `describe_tool` —— 按需把工具定义**展开**给模型。
 *
 * ## ★★★ 这个工具为什么必须存在，且为什么必须在执行期才有定义
 *
 * 它是懒加载机制的**唯一出口**：模型在目录里看到 `foo`，但不能凭空知道 `foo` 的参数，
 * 必须调它拿完整定义。所以它的 `modes` 必须覆盖所有档位，
 * 且它的**放行判据是 `enabled ∪ lazy`**（见 `ToolRegistry.execute`）——
 * 只看"常驻集合"的话，召回成功后再调一次就会被拒 ⇒ 整个机制是坏的死循环。
 *
 * ## ★★ 三件容易写错的事
 *
 * 1. **参数校验要一次性说清**：`names` / `name` / `query` 至少给一个。
 *    报错要告诉模型"你可以怎么给"，否则它会原样重试。
 * 2. **`names` 与 `name` 要合并**，不是二选一 —— 模型有时两个都给。
 * 3. **找不到名字时要给出可用清单 + 建议走 `query`** —— 这是唯一的自纠路径。
 */
export function createDescribeTool(registry: ToolRegistry, mode: PermissionMode, modes: ToolModeMap): ToolDefinition {
  return {
    name: DESCRIBE_TOOL_NAME,
    // description 的真实内容由 catalog.ts 生成（它要带目录）；这里只是兜底，
    // 正常路径上模型看到的是 buildCatalog 产出的那一份。
    description: 'Look up the full definition of tools that are listed but not yet loaded.',
    modes: ['readonly', 'workspace', 'project', 'workspace_project', 'full'],
    source: 'builtin',
    kind: 'read_only',
    displayName: '展开工具定义',
    summary: '按需查看工具的完整参数与用法（懒加载的唯一出口）',
    oneLiner: 'Look up the full definition of a listed tool.',
    preferredMode: 'resident',
    group: 'setup',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'One or more exact tool names.' },
        name: { type: 'string', description: 'A single exact tool name.' },
        query: { type: 'string', description: 'Natural-language description of what you want to do.' },
      },
      // 三个都非必填 —— 由执行器校验「至少给一个」
      additionalProperties: false,
    },

    async execute(rawArgs, ctx): Promise<ToolOutcome> {
      const args = (rawArgs ?? {}) as { names?: unknown; name?: unknown; query?: unknown };
      const currentMode = ctx.permissionMode ?? mode;
      const currentModes = ctx.toolModes ?? modes;

      /** 只在"档位可见且没被关闭"里找 —— 召回一个用不了的工具毫无意义 */
      const callable = registry
        .visible(currentMode)
        .filter((tool) => (currentModes.get(tool.name) ?? tool.preferredMode) !== 'disabled');

      const requested = collectNames(args);
      const hits: string[] = [];

      for (const name of requested) {
        if (callable.some((tool) => tool.name === name)) {
          hits.push(name);
        } else if (!hits.includes(name)) {
          // 名字给了但不可用：不要静默丢弃，模型会以为拿到了
          hits.push(`__missing__:${name}`);
        }
      }

      // 没点名（或点名全落空）时走检索
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query.length > 0) {
        const docs = callable.map((tool) => ({
          name: tool.name,
          oneLiner: tool.oneLiner,
          // description 也参与检索，但要**截断** —— 每条都几百词会淹没 oneLiner
          description: tool.definition.description.slice(0, 300),
        }));
        for (const scored of searchTools(docs, query, MAX_DESCRIBE_BATCH)) {
          if (!hits.includes(scored.name)) hits.push(scored.name);
        }
      }

      const found = hits.filter((name) => !name.startsWith('__missing__'));
      const missing = hits.filter((name) => name.startsWith('__missing__')).map((name) => name.slice(12));

      if (found.length === 0 && missing.length === 0) {
        return {
          ok: false,
          code: 'describe_nothing_requested',
          message: '没有给出要展开的工具。',
          hint:
            '传 `names`（数组，可一次多个）或 `query`（自然语言描述你想做什么）。' +
            `当前可展开的工具：${callable.map((tool) => tool.name).join(', ') || '无'}。`,
        };
      }

      if (found.length === 0) {
        return {
          ok: false,
          code: 'describe_not_found',
          message: `没有这些工具：${missing.join(', ')}`,
          hint:
            `当前可展开的工具：${callable.map((tool) => tool.name).join(', ') || '无'}。` +
            '名字要完全一致；不确定就传 `query` 用自然语言描述你要做什么。',
        };
      }

      const blocks: string[] = [];
      for (const name of found.slice(0, MAX_DESCRIBE_BATCH)) {
        const tool = callable.find((item) => item.name === name);
        if (tool !== undefined) blocks.push(renderToolDefinition(tool));
      }

      const tail =
        missing.length > 0
          ? `\n\n[注意] 下面这些名字不存在，不要调用它们：${missing.join(', ')}`
          : '';

      return {
        ok: true,
        content: `${blocks.join('\n\n---\n\n')}${tail}`,
      };
    },
  };
}

/** 合并 `names`（数组）与 `name`（单值）。三种写法都要认 —— 模型对"数组"的写法很不统一。 */
function collectNames(args: { names?: unknown; name?: unknown }): string[] {
  const out: string[] = [];

  const { names } = args;
  if (Array.isArray(names)) {
    for (const item of names) {
      if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim());
    }
  } else if (typeof names === 'string' && names.trim().length > 0) {
    // ★ 模型常把数组写成单个字符串，或用逗号分隔
    for (const piece of names.split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }

  if (typeof args.name === 'string' && args.name.trim().length > 0) {
    out.push(args.name.trim());
  }

  return [...new Set(out)];
}
