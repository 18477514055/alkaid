import type { ToolDef } from '../../shared/types.ts';
import type { PermissionMode } from '../policy/mode.ts';
import { ToolRegistry, TOOL_GROUP_LABEL, TOOL_GROUP_ORDER, type ResolvedTool, type ToolMode } from './types.ts';

/**
 * **工具目录**（catalog）—— 懒加载机制的纯逻辑核心。
 *
 * ## ★★★ 为什么要有这个东西
 *
 * 工具定义在请求里排在**最前面**（缓存顺序是 `tools → system → messages`），
 * 所以它每轮都要全量发送，并且**每个 token 都按输入价计费**：
 *
 * | 工具数 | 全量暴露 | 目录模式 |
 * |---|---|---|
 * | 10 | ~2000 字符 | ~800 字符 |
 * | 50 | ~10000 字符 | ~1000 字符 |
 * | 200（MCP 铺开后） | ~40000 字符 | ~1200 字符 |
 *
 * ⇒ **工具越多，省得越狠**。而现在正是建接口的时候：等 MCP 接进来再改，
 *   所有调用位置都要动一遍。
 *
 * ## ★★★ 三种模式，不是两种
 *
 * 见 `types.ts` 的 {@link ToolMode}。核心判据：**`disabled` 不能混进 `lazy`**。
 *
 * ## ★★ 缓存友好的两个结构保证（不是靠自觉）
 *
 * 1. `describe_tool` **永远排第一**（位置固定）—— 它是"入口"，排后面模型容易想不起来用。
 * 2. 常驻工具按 **name 排序**追加，分组标题按 `TOOL_GROUP_ORDER` 固定顺序输出。
 *    ⇒ 同样的配置永远产出同样的字节前缀。
 */

/** `describe_tool` 这个元工具的名字。 */
export const DESCRIBE_TOOL_NAME = 'describe_tool';

/** 一次目录构建的结果。 */
export type BuiltCatalog = {
  /** 直接发给 `tools` 字段的数组（空数组 = 不发该字段） */
  readonly tools: readonly ToolDef[];
  /** 常驻（完整 schema 已包含在 tools 里） */
  readonly resident: readonly string[];
  /** 按需（只在 describe_tool 的描述里出现） */
  readonly lazy: readonly string[];
  /** 被用户关闭的（**完全不出现**，也不会进目录） */
  readonly disabled: readonly string[];
  readonly hasAny: boolean;
};

/** 名字 → 三态。缺省时用工具的 `preferredMode`。 */
export type ToolModeMap = ReadonlyMap<string, ToolMode>;

function modeOf(tool: ResolvedTool, modes: ToolModeMap): ToolMode {
  return modes.get(tool.name) ?? tool.preferredMode;
}

/**
 * 构建「发给模型的那份工具表」。
 *
 * ★ 纯函数、无 IO —— 因此可以完整单测，包括"哪些进了目录、哪些进了常驻"。
 *
 * @param registry 工具注册表
 * @param mode 当前权限档（**可见性在这里先过一遍**，配置不能越权）
 * @param modes 用户配置（名字 → 三态）
 */
export function buildCatalog(registry: ToolRegistry, mode: PermissionMode, modes: ToolModeMap = new Map()): BuiltCatalog {
  const visible = registry.visible(mode);
  const resident: ResolvedTool[] = [];
  const lazy: ResolvedTool[] = [];
  const disabled: string[] = [];

  for (const tool of visible) {
    const state = modeOf(tool, modes);
    if (state === 'disabled') {
      disabled.push(tool.name);
    } else if (state === 'lazy') {
      lazy.push(tool);
    } else {
      resident.push(tool);
    }
  }

  // ★ 没有懒加载工具时，describe_tool 是纯浪费 —— 它描述的是一张空表。
  const needDescribe = lazy.length > 0;

  const specs: ToolDef[] = [];
  if (needDescribe) specs.push(describeToolSpec(lazy));
  for (const tool of resident) {
    specs.push({
      name: tool.name,
      description: tool.fullDescription,
      parameters: tool.definition.parameters,
    });
  }

  return {
    tools: specs,
    resident: resident.map((tool) => tool.name),
    lazy: lazy.map((tool) => tool.name),
    disabled,
    hasAny: specs.length > 0,
  };
}

/**
 * 生成 `describe_tool` 的定义。
 *
 * ★★★ 这个工具的 **description 里必须带目录**，否则：
 *   模型只知道"有个 describe_tool"，却不知道**有哪些工具可以描述** ——
 *   它得先盲猜一个名字，猜错再试，往往两三次就放弃了。
 *
 * ★ 这也是整个机制里**唯一的常驻开销**，所以每条都压到一句话。
 */
function describeToolSpec(lazyTools: readonly ResolvedTool[]): ToolDef {
  const byGroup = new Map<string, ResolvedTool[]>();
  for (const tool of lazyTools) {
    const bucket = byGroup.get(tool.group) ?? [];
    bucket.push(tool);
    byGroup.set(tool.group, bucket);
  }

  const catalogLines: string[] = [];
  for (const group of TOOL_GROUP_ORDER) {
    const items = byGroup.get(group);
    if (items === undefined || items.length === 0) continue;
    catalogLines.push(`[${TOOL_GROUP_LABEL[group]}]`);
    for (const tool of items.sort((a, b) => a.name.localeCompare(b.name))) {
      catalogLines.push(`- ${tool.name}: ${tool.oneLiner}`);
    }
  }

  const description = [
    'Look up the full definition (all parameters and usage rules) of tools that are listed but not yet loaded.',
    'IMPORTANT: calling this costs one round-trip, so only use it when you are actually going to call those tools.',
    'You may ask for SEVERAL tools at once via `names` — always do that when you already know you need more than one.',
    'If you do NOT know the exact name, pass `query` with what you want to do and the best matching tools are returned.',
    '',
    'Available tools (grouped for readability; every group is always reachable):',
    ...catalogLines,
    '',
    'After this call succeeds, the returned tools become callable with their full schemas.',
  ].join('\n');

  return {
    name: DESCRIBE_TOOL_NAME,
    description,
    parameters: {
      type: 'object',
      properties: {
        // ★ `names` 是**首选**，`name` 只为兼容保留。
        //   官方两家都默认一次返回多个（Anthropic 默认 5 个、OpenAI 可整批加载 namespace），
        //   一次只返回 1 个的话，模型查 3 个工具就多 2 次往返 —— 每次都是完整模型调用。
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more exact tool names from the list above. Prefer this over `name` when you need more than one.',
        },
        name: {
          type: 'string',
          description: 'A single exact tool name from the list above. Kept for compatibility; use `names` when you need several.',
        },
        query: {
          type: 'string',
          description:
            'What you want to do, in your own words. Returns the closest matching tools. Use this when you are not sure of the exact name.',
        },
      },
      // ★ 都不设必填，由执行器校验「至少给一个」——
      //   设成 required 会逼模型在只用一个时也得传数组，白白多写一层。
      additionalProperties: false,
    },
  };
}

/**
 * 渲染**一个**工具的完整定义（`describe_tool` 的返回体）。
 *
 * ★ 返回的是**完整参数表**而不是"我记住了，你可以调了" ——
 *   模型没有跨轮记忆，这一次返回值就是它唯一的信息来源。
 */
export function renderToolDefinition(tool: ResolvedTool): string {
  const lines: string[] = [];
  lines.push(`Tool: ${tool.name}`);
  lines.push(`What it does: ${tool.oneLiner}`);
  lines.push('');
  // ★ 走 fullDescription —— 与常驻工具序列化**同一个入口**，
  //   否则懒加载工具永远拿不到使用示例。
  lines.push('Full description:');
  lines.push(tool.fullDescription);
  lines.push('');

  const properties = (tool.definition.parameters['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const required = (tool.definition.parameters['required'] ?? []) as string[];
  const entries = Object.entries(properties);

  lines.push('Parameters:');
  if (entries.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [name, spec] of entries) {
      const type = typeof spec['type'] === 'string' ? spec['type'] : 'any';
      const isRequired = required.includes(name);
      const desc = typeof spec['description'] === 'string' ? spec['description'] : '';
      const enumValues = Array.isArray(spec['enum']) ? ` Allowed values: ${(spec['enum'] as unknown[]).join(' | ')}` : '';
      lines.push(`  - ${name} (${type}, ${isRequired ? 'required' : 'optional'}): ${desc}${enumValues}`);
    }
  }

  lines.push('');
  lines.push(`Call it exactly like: {"name":"${tool.name}","arguments":{...}}`);
  return lines.join('\n');
}
