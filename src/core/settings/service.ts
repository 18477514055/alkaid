import type { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_GENERAL,
  DEFAULT_PANEL,
  PANEL_TABS_WITHOUT_PROJECT,
  normalizeGeneral,
  normalizePanel,
  type GeneralSettings,
  type PanelSettings,
} from '../../shared/settings.ts';

/**
 * 应用设置的读写（唯一碰 `app_settings` 的地方）。
 *
 * ★ 为什么在服务端而不是 `localStorage`：桌面壳每次启动都换随机端口 ⇒ origin 每次都变
 *   ⇒ `localStorage` 每次重启归零。家目录是稳定的，所以设置跟着家走才不会丢。
 *
 * ★ 三条判据：
 *  1. **读永远能容错**：库里的 JSON 坏了、字段是旧版本的、键不存在 —— 一律回落默认，
 *     绝不让一个坏字段把整个设置面板打不开。
 *  2. **写只做"合并 + 归一化"**：调用方只发它改的字段，其余保持；
 *     非法值回落默认而不是 400 —— 但**结构性错误**（比如 `visibleTabs` 不是数组）也按默认处理。
 *  3. **作用域明确**：`global` 与 `project` 分开存，项目覆盖不污染全局。
 */

const GENERAL_KEY = 'general';
const PANEL_KEY = 'panel';

type SettingsScope = 'global' | 'project';

function readJson(db: DatabaseSync, scope: SettingsScope, scopeId: string, key: string): unknown {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE scope=? AND scope_id=? AND key=?')
    .get(scope, scopeId, key) as { value?: string } | undefined;
  if (row === undefined || typeof row.value !== 'string') return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    // 库里的 JSON 坏了 ⇒ 当作没设过（下次写入会覆盖成合法值）
    return undefined;
  }
}

function writeJson(db: DatabaseSync, scope: SettingsScope, scopeId: string, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_settings (scope, scope_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(scope, scopeId, key, JSON.stringify(value), new Date().toISOString());
}

/* ------------------------------- 通用设置 ------------------------------- */

export function getGeneralSettings(db: DatabaseSync): GeneralSettings {
  return normalizeGeneral(readJson(db, 'global', '', GENERAL_KEY) ?? DEFAULT_GENERAL);
}

/**
 * 合并式写入：只传要改的字段。
 * @returns 写完之后的**完整**设置（前端据此刷新，不用自己猜合并结果）
 */
export function setGeneralSettings(db: DatabaseSync, patch: unknown): GeneralSettings {
  const current = getGeneralSettings(db);
  const incoming = (patch ?? {}) as Record<string, unknown>;
  // ★ 只允许已知字段参与合并：把外部传进来的杂键丢掉，避免它们被存进库。
  // 自动压缩开关/百分比同样经 DEFAULT_GENERAL 白名单 + normalizeGeneral 持久化；
  // 旧版本缺字段由默认值补齐，单项修改不重置步数 null、子代理与其他既有设置。
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(DEFAULT_GENERAL)) {
    if (incoming[key] !== undefined) merged[key] = incoming[key];
  }
  const next = normalizeGeneral(merged);
  writeJson(db, 'global', '', GENERAL_KEY, next);
  return next;
}

/* ------------------------------- 右栏设置 ------------------------------- */

/** 该项目能用哪些页签：没有项目时台账/原则是项目域的，用不了。 */
export function allowedPanelTabs(projectId: string | null): readonly ('work' | 'memory' | 'logs' | 'principles')[] {
  return projectId === null ? PANEL_TABS_WITHOUT_PROJECT : ['work', 'memory', 'logs', 'principles'];
}

/**
 * 读右栏设置。**两套作用域互相独立**（2026-11-09 实测踩到坑后改的）：
 * - `projectId = null` ⇒ 全局那份，且**只允许 work / logs**（无项目对话没有台账/原则）；
 * - 传项目 id ⇒ 该项目自己的覆盖；**没设过就用 DEFAULT_PANEL，不继承全局**。
 *
 * ★ 为什么不继承：全局那份读出来时已经按"无项目"过滤过（只剩工作/日志），
 *   一旦让它当项目的初始值，**每个项目都只显示两个页签** —— 实测就是这个现象。
 *   用户说的是"单独开一个项目设置"，本来就该是两套独立的东西。
 */
export function getPanelSettings(db: DatabaseSync, projectId: string | null): PanelSettings {
  const allowed = allowedPanelTabs(projectId);
  if (projectId === null) {
    return normalizePanel(readJson(db, 'global', '', PANEL_KEY) ?? DEFAULT_PANEL, allowed);
  }
  const own = readJson(db, 'project', projectId, PANEL_KEY);
  return normalizePanel(own ?? DEFAULT_PANEL, allowed);
}

export function setPanelSettings(db: DatabaseSync, projectId: string | null, patch: unknown): PanelSettings {
  const allowed = allowedPanelTabs(projectId);
  const current = getPanelSettings(db, projectId);
  const incoming = (patch ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(DEFAULT_PANEL)) {
    if (incoming[key] !== undefined) merged[key] = incoming[key];
  }
  const next = normalizePanel(merged, allowed);

  if (projectId === null) writeJson(db, 'global', '', PANEL_KEY, next);
  else writeJson(db, 'project', projectId, PANEL_KEY, next);
  return next;
}

/** 项目删除时清掉它的设置行（避免 scope_id 变成悬空垃圾） */
export function deleteProjectSettings(db: DatabaseSync, projectId: string): void {
  db.prepare("DELETE FROM app_settings WHERE scope='project' AND scope_id=?").run(projectId);
}
