import type { DatabaseSync } from 'node:sqlite';

import type { ToolMode, ToolRegistry, ToolSource } from './types.ts';

/**
 * 工具三态配置的持久化（唯一碰 `tool_settings` 的地方）。
 *
 * ## ★★★ 三条判据（写在这里，避免以后改回去）
 *
 * 1. **没配置过的工具不写行**。
 *    默认值来自 `ToolDefinition.preferredMode` —— 那是**代码里的默认**，
 *    一写进库就冻结成"用户的选择"，将来改默认值对老库无效。
 *    ⇒ 读的时候用 `LEFT JOIN` 的思路：库里没有就用默认。
 *
 * 2. **工具消失后行要保留**（插件卸载 / MCP 断开）。
 *    否则"用户关掉过它"这件事会被静默遗忘，重装后行为莫名改变。
 *    ⇒ 读配置时把"库里有、注册表里没有"的也返回（标记为 `available: false`）。
 *
 * 3. **`disabled` 与 `lazy` 绝不合并**（见 `types.ts` 的 ToolMode）。
 */

export type ToolSettingRow = {
  readonly name: string;
  readonly mode: ToolMode;
  readonly source: ToolSource;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
  readonly useCount: number;
};

type RawRow = {
  name: string;
  mode: string;
  source: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number | bigint;
};

function toMode(value: string): ToolMode {
  return value === 'lazy' || value === 'disabled' ? value : 'resident';
}

function toSource(value: string): ToolSource {
  return value === 'plugin' || value === 'mcp' ? value : 'builtin';
}

/** 读出全部配置行（名字 → 设置）。**只读**。 */
export function listToolSettings(db: DatabaseSync): Map<string, ToolSettingRow> {
  const rows = db.prepare('SELECT * FROM tool_settings ORDER BY name').all() as unknown as RawRow[];
  const out = new Map<string, ToolSettingRow>();
  for (const row of rows) {
    out.set(row.name, {
      name: row.name,
      mode: toMode(row.mode),
      source: toSource(row.source),
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      useCount: Number(row.use_count),
    });
  }
  return out;
}

/**
 * 读成「名字 → 三态」，直接喂给 `buildCatalog` / `ToolSurface`。
 *
 * ★ 这是**主循环唯一该用的入口** —— 它返回的 Map 就是那一轮的三态快照。
 */
export function toolModeMap(db: DatabaseSync): Map<string, ToolMode> {
  const out = new Map<string, ToolMode>();
  for (const [name, setting] of listToolSettings(db)) out.set(name, setting.mode);
  return out;
}

/** 写一个工具的三态。返回是否真的落库。 */
export function setToolMode(
  db: DatabaseSync,
  name: string,
  mode: ToolMode,
  source: ToolSource = 'builtin',
): boolean {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_settings (name, mode, source, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  ).run(name, mode, source, now);
  return true;
}

/** 抹掉一个工具的配置（回到代码默认）。插件卸载时**不要**调它 —— 见文件头判据 2。 */
export function clearToolSetting(db: DatabaseSync, name: string): boolean {
  const result = db.prepare('DELETE FROM tool_settings WHERE name = ?').run(name);
  return Number(result.changes) > 0;
}

/**
 * 记一次真实调用（`last_used_at` / `use_count`）。
 *
 * ★ 只在**工具真的被执行**时调，不要在执行前调 —— 被权限拒绝的不算"用过"。
 * ★ 失败也要记（模型确实试过了），但只记次数不记参数（审计纪律）。
 */
export function recordToolUse(db: DatabaseSync, name: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_settings (name, mode, source, updated_at, last_used_at, use_count)
     VALUES (?, 'resident', 'builtin', ?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET last_used_at = excluded.last_used_at, use_count = use_count + 1`,
  ).run(name, now, now);
}

// ─────────────────────── 设置页需要的合并视图 ───────────────────────

export type ToolView = {
  readonly name: string;
  readonly displayName: string;
  readonly summary: string;
  readonly oneLiner: string;
  readonly kind: string;
  readonly group: string;
  readonly source: ToolSource;
  /** 用户当前的选择（没配置过就是代码默认） */
  readonly mode: ToolMode;
  /** 代码里的默认值 —— 设置页用它显示"已改过/默认" */
  readonly defaultMode: ToolMode;
  /** 是否**真的存在**于当前注册表（false = 插件卸载了但配置还留着） */
  readonly available: boolean;
  /** 这一档看得见吗（不可见 = 权限挡住，与三态无关） */
  readonly visibleInMode: boolean;
  readonly useCount: number;
  readonly lastUsedAt: string | null;
};

/**
 * 合并「注册表里的工具」与「库里的配置」成一张设置页用的表。
 *
 * ★ 三种情况都要出现，不能只列表里的：
 *   ① 注册表有、库里没有 ⇒ 用代码默认（`configured: false`）
 *   ② 两边都有 ⇒ 用库里的
 *   ③ 库里有、注册表没有 ⇒ `available: false`（工具卸载了，配置留着）
 */
export function listToolViews(db: DatabaseSync, registry: ToolRegistry, mode: Parameters<ToolRegistry['visible']>[0]): ToolView[] {
  const settings = listToolSettings(db);
  const registered = new Map(registry.list().map((tool) => [tool.name, tool]));
  const visibleNames = new Set(registry.visible(mode).map((tool) => tool.name));
  const views: ToolView[] = [];

  for (const tool of registry.list()) {
    const saved = settings.get(tool.name);
    views.push({
      name: tool.name,
      displayName: tool.displayName,
      summary: tool.summary,
      oneLiner: tool.oneLiner,
      kind: tool.kind,
      group: tool.group,
      source: tool.source,
      mode: saved?.mode ?? tool.preferredMode,
      defaultMode: tool.preferredMode,
      available: true,
      visibleInMode: visibleNames.has(tool.name),
      useCount: saved?.useCount ?? 0,
      lastUsedAt: saved?.lastUsedAt ?? null,
    });
  }

  // ③ 配置还留着但工具不在 —— 必须展示，否则用户无法清理
  for (const [name, saved] of settings) {
    if (registered.has(name)) continue;
    views.push({
      name,
      displayName: name,
      summary: `这个工具当前不在注册表里（来源：${saved.source}）。配置已保留。`,
      oneLiner: '（工具已不可用）',
      kind: 'external',
      group: saved.source === 'plugin' || saved.source === 'mcp' ? saved.source : 'setup',
      source: saved.source,
      mode: saved.mode,
      defaultMode: saved.mode,
      available: false,
      visibleInMode: false,
      useCount: saved.useCount,
      lastUsedAt: saved.lastUsedAt,
    });
  }

  // 稳定的展示顺序：先按来源（内建 → 插件 → MCP），再按名字
  const sourceOrder: Record<ToolSource, number> = { builtin: 0, plugin: 1, mcp: 2 };
  return views.sort((a, b) => {
    const bySource = sourceOrder[a.source] - sourceOrder[b.source];
    return bySource !== 0 ? bySource : a.name.localeCompare(b.name);
  });
}
