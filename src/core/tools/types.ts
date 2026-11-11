import type { ToolDef } from '../../shared/types.ts';
import { assertWireToolName } from '../../shared/tool-name.ts';
import type { PermissionMode } from '../policy/mode.ts';
import type { Roots } from '../policy/roots.ts';

/**
 * 工具层的契约。
 *
 * ## ★ 一条硬规则：**工具的可见性也是权限的一部分**
 *
 * `modes` 里没列的模式，模型**在工具清单里根本看不到**这个工具 ——
 * 而不是"看得到但调不动"。后者会让模型反复试，白白烧回合（D1「静默拒绝」）。
 *
 * ## ★★ 三层关注点，刻意分开（否则会互相污染）
 *
 * | 层 | 谁负责 | 回答什么 |
 * |---|---|---|
 * | **权限** | `ToolDefinition.modes` + `PermissionMode` | 这个档位下**允不允许**用它 |
 * | **发送** | `catalog.ts` 的 `buildCatalog()` | 这一轮**发什么**给模型（完整 schema / 只在目录 / 完全不发） |
 * | **配置** | `settings.ts` 的 `tool_settings` 表 | **用户**希望它常驻、按需、还是关闭 |
 *
 * ★ 三者相乘才是最终结果。把它们揉进一个字段是错的 ——
 *   权限是程序强制的，配置是用户选的，发送策略是优化，混在一起就没法单独测试。
 */

export type ToolContext = {
  readonly conversationId: string;
  /** Main conversation owns project memory; delegated agents do not inherit it. */
  readonly agentRole?: 'main' | 'subagent';
  readonly permissionMode: PermissionMode;
  readonly roots: Roots;
  readonly workspacePath: string | null;
  readonly projectSharedDir: string | null;
  /** 命令/文件操作的默认工作目录 */
  readonly cwd: string;
  /** 会话私有临时目录（shell 的 TMP/TEMP 会被指到这里） */
  readonly tempDir: string;
  readonly signal: AbortSignal;
  /** Runtime-owned user message seq; models cannot choose another turn's obligation. */
  readonly turnUserSeq?: number;
  /**
   * 用户对这一轮的工具配置（名字 → 三态）。缺省时按 `preferredMode`。
   *
   * ★ 为什么放在 context 而不是让工具自己去查库：
   *   执行一个工具时已经知道会话与档位了，再多一次库查询既慢又可能读到不一致的快照。
   *   一轮开始读一次，整轮复用 —— 同一轮里设置突变会让审计难以解释。
   */
  readonly toolModes?: ReadonlyMap<string, ToolMode>;
  /**
   * 单个工具输出上限（字符）。
   * - `undefined` ⇒ 各工具用自己的默认值
   * - 数字 ⇒ 覆盖默认值
   * - `null` ⇒ **不限制**（用户在设置里明确关掉了截断）
   * ★ 用 `null` 而不是大数表示"不限制"：大数会在文案里露出假数字，
   *   而且真正的"不限制"要求工具**跳过截断逻辑**，不是把阈值调大。
   */
  readonly maxToolOutputChars?: number | null;
};

// ─────────────────────────────── 元信息 ───────────────────────────────

/** 工具来源 —— 决定"谁拥有它"，也决定默认档位与分组。 */
export type ToolSource = 'builtin' | 'plugin' | 'mcp';

/**
 * 按**副作用**分级，不按功能分组。
 *
 * ★ 用户关心的是「它会不会动我的东西」，不是字母序。设置页据此分三组展示。
 */
export type ToolKind = 'read_only' | 'write_local' | 'external';

/**
 * 目录分组 —— OpenAI `namespace` 的等价物（但**不构成筛选**）。
 *
 * ★ 参照项目（66-ChatMobile）调研报告明确警告过「选错组 = 死路」这个失败模式：
 *   分层路由让模型看不到正确工具、无法自纠。所以在几十个工具的量级上，
 *   分组**只用来组织目录的显示结构**（每组一个小标题），工具名依然全部可见。
 */
export type ToolGroup = 'files' | 'shell' | 'context' | 'history' | 'plugin' | 'mcp' | 'setup';

/** 分组的中文标题（目录里给模型看，与工具描述的语言保持一致）。 */
export const TOOL_GROUP_LABEL: Record<ToolGroup, string> = {
  files: '文件',
  shell: '命令',
  context: '上下文',
  history: '历史',
  plugin: '插件',
  mcp: 'MCP',
  setup: '配置',
};

/** 目录里分组出现的顺序 —— **固定**，否则前缀每次变化就白丢缓存。 */
export const TOOL_GROUP_ORDER: readonly ToolGroup[] = [
  'files',
  'shell',
  'context',
  'history',
  'mcp',
  'plugin',
  'setup',
];

/**
 * 一条**工具使用示例**。
 *
 * ## ★ 为什么这个字段值钱（有出处）
 *
 * Anthropic 官方实测：加上工具使用示例后，**复杂参数的准确率从 72% 提升到 90%**
 * （`input_examples`）。原因是 JSON Schema 表达不了「怎么用」：
 * 某个参数什么时候该省、两个参数的组合约定、某个开关什么时候该翻成 true。
 *
 * ## ★★ 为什么只给少数工具加，不是全加
 *
 * 示例**永久占据每一轮的输入 token**（工具定义在缓存前缀里）。
 * 纪律：**只给"模型真的会传错"的工具加**，判断依据是有没有真实的踩坑场景。
 *
 * ## ★★★ 为什么拼进 description，而不是当成 tools JSON 的新字段
 *
 * OpenAI function calling 的 `function` 对象只有 `name`/`description`/`parameters`/`strict`；
 * Anthropic 的 `input_examples` 是它自己 API 专有的。我们接 46 家厂商，
 * 多塞一个它们不认识的字段，严格的网关会直接 400。
 * ⇒ **只能写进 description 文本里**，这是唯一在所有厂商都安全的位置。
 */
export type ToolExample = {
  /** 什么时候该这样传参数（一句话，写场景不写语法） */
  readonly whenTo: string;
  /** 完整、可直接复制的参数对象（**必须能真的解析**，有测试钉住） */
  readonly args: Record<string, unknown>;
};

/**
 * 工具的三态 —— 「关掉」与「按需」是两件事。
 *
 * | 模式 | 在请求里 | 模型能看到 | 典型用途 |
 * |---|---|---|---|
 * | `resident` | 完整 schema | 全部参数 | 高频工具（读文件、执行命令） |
 * | `lazy` | 只有名字 + 一句话 | 要用时先 `describe_tool` | 低频工具 / MCP |
 * | `disabled` | 完全不出现 | 看不到 | 用户不想给的能力 |
 *
 * ★ 把 `disabled` 混进 `lazy` 是常见错误 —— 那样模型会"发现"一个用户明确关掉的工具，
 *   然后反复尝试调用，最后只能报"该工具未启用"。
 */
export type ToolMode = 'resident' | 'lazy' | 'disabled';

export const TOOL_MODES: readonly ToolMode[] = ['resident', 'lazy', 'disabled'];

export function isToolMode(value: unknown): value is ToolMode {
  return typeof value === 'string' && (TOOL_MODES as readonly string[]).includes(value);
}

// ─────────────────────────────── 定义 ───────────────────────────────

/**
 * 一个工具。
 *
 * ★ 元信息（source/displayName/summary/kind/oneLiner/preferredMode/group/examples）
 *   **全部可选**，缺省由 {@link resolveTool} 补齐。
 *   理由：插件与测试构造工具时不该被迫填一堆展示字段；
 *   但**内置工具必须显式声明**，有测试钉住（见 `test/unit/tool-catalog.test.ts`）。
 */
export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema（object 根） */
  readonly parameters: Record<string, unknown>;
  /** Display routing is independent of tool visibility and execution permissions. */
  readonly displayChannel?: 'chat' | 'maintenance';
  /** 哪些权限档位下这个工具**可见**；不在列表里的档位，模型看不到它 */
  readonly modes: readonly PermissionMode[];

  // ── 元信息（可选，有默认值） ──
  readonly source?: ToolSource;
  /** 设置页显示的名字（中文）。默认用 `name` */
  readonly displayName?: string;
  /** 设置页显示的一句话说明（给人看）。默认取 description 首句 */
  readonly summary?: string;
  readonly kind?: ToolKind;
  /**
   * **一句话**说明 —— 懒加载时写进工具目录的那一行。
   *
   * ★ 为什么单独一个字段，而不是截取 description：
   *   目录里塞不下长文。10 个工具 × 100 字就是 1000 字，等于没省。
   * ★ 判据：这句话里**不能有"如何调用"**（那是 describe 之后才需要的），
   *   只能有**用途**。写调用方式等于把懒加载又变回常驻。
   */
  readonly oneLiner?: string;
  /** 默认常驻还是按需。缺省 `resident`（保持"没配置过就全给"的旧行为） */
  readonly preferredMode?: ToolMode;
  readonly group?: ToolGroup;
  readonly examples?: readonly ToolExample[];

  execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome>;
};

/** 补齐默认值之后的工具（内部一律用它，避免各调用点各写一份默认逻辑）。 */
export type ResolvedTool = {
  readonly definition: ToolDefinition;
  readonly name: string;
  readonly source: ToolSource;
  readonly displayName: string;
  readonly summary: string;
  readonly kind: ToolKind;
  readonly oneLiner: string;
  readonly preferredMode: ToolMode;
  readonly group: ToolGroup;
  readonly examples: readonly ToolExample[];
  /** 发给模型的完整描述 = description + 示例（**唯一入口**） */
  readonly fullDescription: string;
};

/** 取 description 的第一句（中文句号/换行都算边界），并截到 80 字。 */
function firstSentence(text: string, maxChars = 80): string {
  const flat = text.replaceAll('\n', ' ').trim();
  const cut = flat.search(/[。！？.!?]/);
  const head = cut > 0 ? flat.slice(0, cut) : flat;
  return head.length > maxChars ? `${head.slice(0, maxChars)}…` : head;
}

/**
 * 拼出「发给模型的完整描述」。
 *
 * ★★★ 两个消费点都**必须**走这个函数，不许各自拼：
 *   - `catalog.buildCatalog()`（常驻工具进 `tools` 数组）
 *   - `describe_tool`（懒加载工具被召回时）
 * 各自拼一次就会重演「设置存了但没生效」那类事故（数据加在一处、消费点在另一处）。
 */
function composeFullDescription(description: string, examples: readonly ToolExample[]): string {
  if (examples.length === 0) return description;
  const lines = examples.map((example) => `- ${example.whenTo}: ${JSON.stringify(example.args)}`);
  return `${description}\n\nExamples (each line is a complete arguments object you can copy):\n${lines.join('\n')}`;
}

export function resolveTool(definition: ToolDefinition): ResolvedTool {
  const examples = definition.examples ?? [];
  const summary = definition.summary ?? firstSentence(definition.description);
  return {
    definition,
    name: definition.name,
    source: definition.source ?? 'builtin',
    displayName: definition.displayName ?? definition.name,
    summary,
    kind: definition.kind ?? 'read_only',
    oneLiner: definition.oneLiner ?? summary,
    preferredMode: definition.preferredMode ?? 'resident',
    group: definition.group ?? 'context',
    examples,
    fullDescription: composeFullDescription(definition.description, examples),
  };
}

// ─────────────────────────────── 结果 ───────────────────────────────

/**
 * 执行结果：成功 / 失败，两态分开建模（拒绝也是一种**可读的失败**）。
 *
 * ★ `durationMs` 由 {@link ToolRegistry.execute} 统一测量后附加 ——
 *   不让每个工具各自算（十种算法就有十个口径，且工具里的计时点不一定对）。
 * ★ `truncated` 由工具自己标：只有它知道结果是不是被截过。
 */
export type ToolOutcome =
  | {
      readonly ok: true;
      readonly content: string;
      /** 结果是否被截断（超长工具输出） */
      readonly truncated?: boolean;
      readonly durationMs?: number;
      /**
       * **工具主动宣告"这一轮到此为止"**（A1 / `D1@L641`）。
       *
       * ★ 为什么需要它：没有步数上限时，唯一的收敛信号是"模型这一轮没再调工具"。
       *   那要求模型自愿闭嘴 —— 而一个正在连续调工具干活的模型很可能不会。
       *   有了这个字段，"干完了"可以由**工具**宣告：例如 `task_done` 一类的工具
       *   返回 `conclude: true`，循环立刻以 `completed` 收轮，**不再追加一次模型请求**
       *   （那一次请求既费钱又可能让模型又编出新活干）。
       *
       * ★ 判据：只有**真的做完了**才置 true。它不打断工具结果落库 ——
       *   仍然先写 tool 消息、再收轮，否则模型下一轮会看到"调了工具却没结果"。
       */
      readonly conclude?: boolean;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
      readonly durationMs?: number;
    };

// ─────────────────────────────── 注册表 ───────────────────────────────

/**
 * 子代理**绝对不许**碰的项目记忆**写**工具。
 *
 * ★ 2026-11-11 审计（`CRITICAL-01`）修的就是这里：原来这个判据叫 `isProjectMemoryTool`，
 *   把 `memory_*` **整族**连同 `execution_board` 一起挡在子代理外面。可用户 2026-11-10 的裁定是
 *   「子代理可以只读所有东西，不能改除了自己的看板之外的任何东西」——
 *   ⇒ **读**工具（`memory_read` / `memory_query`）与**自己的看板**（`execution_board`）
 *   本来就该给子代理。挡住它们导致：子代理看不见 `execution_board`，于是主对话右侧委派看板里
 *   每个子代理的「目标与任务」永远是空的。
 *
 * 判据按**动作**分，不按名字前缀分：
 * - 写台账（提案 / 制品暂存 / 无新增声明）⇒ 子代理禁用（只读准则）
 * - 读（`memory_read` / `memory_query`）⇒ 放行
 * - `execution_board` ⇒ 放行（它自己那一行；工具参数里根本没有 conversationId，写不到别人的板）
 */
export function isSubagentForbiddenMemoryTool(tool: ResolvedTool): boolean {
  if (tool.source !== 'builtin') return false;
  /**
   * ★ 这份名单只放**写**语义的工具。逐个确认过（不是按前缀猜）：
   * - `memory_propose`：正式台账提案
   * - `memory_stage`：制品/材料暂存（`memory-workbench.ts` 里唯一标 `write = true` 的）
   * - `memory_disposition`：无新增/丢弃声明
   *
   * ★★ 2026-11-11 审计 `ALK-HIGH-03` 打回的正是这里：上一版顺手把 `memory_checkpoint`
   *   与 `memory_workbench` 也塞进了封禁名单，可它们**都是只读**——
   *   `memory_checkpoint` 只是"请用户选一下检查点"（不写库），
   *   `memory_workbench` 是"读已审核分流三桶/交接单/意图日志"。
   *   封掉它们 = 子代理连自己这一轮的交接单都读不到，而用户的裁定是"子代理可以只读所有东西"。
   *   ⇒ 判据只能是**工具自己声明的写语义**，不是我按名字感觉。
   */
  return (
    tool.name === 'memory_propose' ||
    tool.name === 'memory_stage' ||
    tool.name === 'memory_disposition'
  );
}

export class ToolRegistry {
  #tools = new Map<string, ResolvedTool>();

  /**
   * 注册一个工具。
   *
   * ## ★★ 为什么不在这里"顺手把名字改好"，而是**直接抛错**
   *
   * 工具名是发给上游的**线上契约**（`^[a-zA-Z0-9_-]{1,64}$`）。2026-11-08 真事故：
   * 插件工具名带点号 ⇒ **每一轮请求都 400，整个应用不能用**，而网关还把错误改写成
   * 似是而非的 `missing role field`。那次之后字符集修了，但**长度**这个口子还在
   * （`p_<插件id>_<工具名>` 能到 83 字符）。
   *
   * 之前的守卫散在**生产者**那里（插件一处、MCP 一处）⇒ 未来任何**新名字来源**
   * （用户自定义工具、网关下发的模型名之类）都绕得过去。这里是**唯一入口**，
   * 所以断言放在这里：*任何*要进工具表的名字，都必须先过线上契约。
   *
   * ★ 抛错而不悄悄修：走到这一步说明某个生产者漏了清洗。悄悄改好会掩盖 bug ——
   *   而且改了之后模型调用时用的仍是它自己以为的旧名字，问题更难查。
   *   生产者该统一走 `shared/tool-name.ts` 的 `fitToolName()`。
   */
  register(tool: ToolDefinition): this {
    assertWireToolName(tool.name);
    if (this.#tools.has(tool.name)) throw new Error(`工具重名：${tool.name}`);
    this.#tools.set(tool.name, resolveTool(tool));
    return this;
  }

  /** 全部已注册工具（**不过滤权限**）—— 设置页与检索用它 */
  list(): ResolvedTool[] {
    return [...this.#tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 当前档位下**可见**的工具，按 name 排序。
   *
   * ★ 稳定顺序是硬要求：工具清单顺序变化会让 prompt cache 整段失效。
   */
  visible(mode: PermissionMode): ResolvedTool[] {
    return this.list().filter((tool) => tool.definition.modes.includes(mode));
  }

  /**
   * 把**全部可见工具**以完整 schema 发给模型 —— **不分三态**。
   *
   * ★ 这是"没有配置时的等价物"，保留它有两个用途：
   *   ① 兼容/诊断（`/prompt` 里要列出"这一档能看到哪些工具名"）；
   *   ② 老测试的断言基准（可见性本身不该被三态掩盖）。
   * ★ **主循环不要用它** —— 主循环走 `catalog.buildCatalog()`，
   *   否则懒加载配置会被静默忽略（那就成了"设置存了但没生效"）。
   */
  toProviderTools(mode: PermissionMode): ToolDef[] {
    return this.visible(mode).map((tool) => ({
      name: tool.name,
      description: tool.fullDescription,
      parameters: tool.definition.parameters,
    }));
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): ResolvedTool | undefined {
    return this.#tools.get(name);
  }

  /** 注销一个工具（插件停用/崩溃时用）；返回是否真的删掉了 */
  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  /**
   * 执行一个工具调用。
   *
   * ## 判据（三条，缺一不可）
   *
   * 1. 工具存在 —— 不存在就回 `tool_not_found` + 当前可用清单；**不抛异常**。
   * 2. 当前档位可见 —— 不可见 = 不存在（模型若硬调，得到的是"没有这个工具"）。
   * 3. 没被用户关闭 —— `disabled` 才拒；**`lazy` 必须放行**。
   *
   * ★★★ 第 3 条是懒加载机制的生死线：只看"常驻集合"的话，懒加载工具
   *   **"描述得出来、调不动"** —— 整个机制是坏的死循环。有契约测试钉住。
   */
  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.#tools.get(name);
    if (ctx.agentRole === 'subagent' && tool && isSubagentForbiddenMemoryTool(tool)) return {
      ok: false, code: 'tool_not_found', message: '子智能体不参与项目台账；请将工作结果返回主对话。',
    };
    if (tool === undefined || !tool.definition.modes.includes(ctx.permissionMode)) {
      const available = this.visible(ctx.permissionMode).map((item) => item.name);
      return {
        ok: false,
        code: 'tool_not_found',
        message: `当前权限模式（${ctx.permissionMode}）下没有名为 "${name}" 的工具`,
        hint:
          available.length > 0
            ? `当前可用工具：${available.join(', ')}。不要重复调用不存在的工具。`
            : '当前没有任何可用工具；请直接用文字回答用户。',
      };
    }

    const mode = ctx.toolModes?.get(name) ?? tool.preferredMode;
    if (mode === 'disabled') {
      return {
        ok: false,
        code: 'tool_disabled',
        message: `工具 "${name}" 已被用户关闭`,
        hint: '不要重试，也不要假装调用过它；直接用已有信息回答，或告诉用户该工具被关掉了。',
      };
    }

    const startedAt = performance.now();
    try {
      const outcome = await tool.definition.execute(rawArgs, ctx);
      return { ...outcome, durationMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      return {
        ok: false,
        code: 'tool_crashed',
        message: error instanceof Error ? error.message : String(error),
        hint: '这是工具自身的问题，不是你的参数问题；不要用同样的参数重试。',
        durationMs: Math.round(performance.now() - startedAt),
      };
    }
  }
}
