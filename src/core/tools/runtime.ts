import type { ToolDef } from '../../shared/types.ts';
import type { PermissionMode } from '../policy/mode.ts';
import { buildCatalog, DESCRIBE_TOOL_NAME, type BuiltCatalog, type ToolModeMap } from './catalog.ts';
import { createDescribeTool } from './describe.ts';
import { ToolRegistry, isProjectMemoryTool, type ToolContext, type ToolOutcome } from './types.ts';

/**
 * **工具运行时** —— 主循环与 HTTP 面**唯一**该碰的东西。
 *
 * ## ★★★ 为什么需要这一层（否则会踩的三个坑）
 *
 * 1. **`describe_tool` 不能进注册表**。
 *    它一旦被 `registry.register()`，`visible()` 就会把它算进常驻工具 ——
 *    于是"没有任何按需工具"时它也会被发给模型，白白占一段缓存前缀（它描述的是空表）。
 *    ⇒ 它**只在需要时由 `buildCatalog` 注入 spec，由本层拦截执行**。
 *
 * 2. **"发什么"与"能执行什么"必须是同一个对象算出来的**。
 *    如果发工具用一份配置、执行用另一份（比如执行时重新查库），
 *    就会出现"模型看到了但调不动"或反过来 —— 这类不一致在生产里最难查。
 *    ⇒ 本对象在一次构造里把档位、配置、目录**一起冻结**。
 *
 * 3. **召回判据必须是 `enabled ∪ lazy`**（对应 `ToolRegistry.execute` 那条）。
 *    只放行常驻的话，懒加载工具"描述得出来、调不动"，机制就是个坏的死循环。
 *
 * ## 生命周期
 * 一次构造对应**一轮对话**（或一次 HTTP 请求）。配置突变不会中途生效 ——
 * 那是刻意的：同一轮里工具集变了，审计就解释不通。
 */
export class ToolSurface {
  readonly #registry: ToolRegistry;
  readonly #mode: PermissionMode;
  readonly #modes: ToolModeMap;
  readonly #catalog: BuiltCatalog;
  readonly #describe:

    | ReturnType<typeof createDescribeTool>
    | null;

  constructor(registry: ToolRegistry, mode: PermissionMode, modes: ToolModeMap = new Map(), agentRole: 'main' | 'subagent' = 'main') {
    this.#registry = agentRole === 'subagent' ? new ToolRegistry() : registry;
    if (agentRole === 'subagent') for (const tool of registry.list()) {
      if (!isProjectMemoryTool(tool)) this.#registry.register(tool.definition);
    }
    this.#mode = mode;
    this.#modes = modes;
    this.#catalog = buildCatalog(this.#registry, mode, modes);
    // ★ 没有按需工具时不构造它 —— 它没有任何用武之地
    this.#describe = this.#catalog.lazy.length > 0 ? createDescribeTool(this.#registry, mode, modes) : null;
  }

  get catalog(): BuiltCatalog {
    return this.#catalog;
  }

  /** 直接发给 `tools` 字段；空数组时调用方**不发该字段**（发空数组有些网关 400） */
  get tools(): readonly ToolDef[] {
    return this.#catalog.tools;
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  /** 当前这一轮模型**看得见**的工具名（常驻 + 按需，不含被关掉的） */
  get visibleNames(): string[] {
    return [...this.#catalog.resident, ...this.#catalog.lazy];
  }

  /** 名字是否属于本轮的可见集合（含按需） */
  canCall(name: string): boolean {
    if (name === DESCRIBE_TOOL_NAME && this.#describe !== null) return true;
    return this.visibleNames.includes(name);
  }

  displayChannel(name: string): 'chat' | 'maintenance' {
    return this.#registry.get(name)?.definition.displayChannel ?? 'chat';
  }

  /**
   * 执行一次工具调用。
   *
   * ★ 坏 JSON 在这里就变成**可读回执**，不往上抛 —— 模型据此能自我修正。
   */
  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    // describe_tool 走拦截（它不在注册表里）
    if (name === DESCRIBE_TOOL_NAME) {
      if (this.#describe === null) {
        return {
          ok: false,
          code: 'tool_not_found',
          message: '当前没有按需加载的工具，因此不需要（也不存在）describe_tool。',
          hint: '所有可见工具的参数都已经在工具定义里了，直接调用即可。',
        };
      }
      const startedAt = performance.now();
      const outcome = await this.#describe.execute(rawArgs, ctx);
      return { ...outcome, durationMs: Math.round(performance.now() - startedAt) };
    }

    // 其余走注册表（那里负责三态里的 disabled 与档位校验）
    return this.#registry.execute(name, rawArgs, { ...ctx, toolModes: this.#modes });
  }
}

/** 便捷构造 */
export function createSurface(
  registry: ToolRegistry,
  mode: PermissionMode,
  modes: ToolModeMap = new Map(),
  agentRole: 'main' | 'subagent' = 'main',
): ToolSurface {
  return new ToolSurface(registry, mode, modes, agentRole);
}
