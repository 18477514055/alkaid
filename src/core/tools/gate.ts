/**
 * 工具门控的**读写规则**（v18）。
 *
 * 三层优先级：`会话覆盖 → 全局设置 → 定义里的 preferredMode`。
 *
 * ★ 为什么只存"差异行"：如果给每个会话复制一份完整快照，之后你在设置里改了全局默认，
 *   所有已有会话都还压在旧副本上 —— 表现就是"我明明改了，怎么没反应"。
 *   只存差异 ⇒ 全局改动立刻对没覆盖过的工具生效。
 *
 * ★ 为什么模板存整份快照：模板的语义就是"把自己当前这套整体搬过去"，
 *   这时**就是要覆盖**（包括把某些工具改回默认），所以它必须是一份完整映射。
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import type { ToolMode } from './types.ts';
import { listToolSettings, setToolMode } from './settings.ts';

const MODES: readonly ToolMode[] = ['resident', 'lazy', 'disabled'];

export function isToolMode(value: unknown): value is ToolMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/** 一个会话独有的那些工具设置（只有差异行） */
export function listConversationToolModes(
  db: DatabaseSync,
  conversationId: string,
): Map<string, ToolMode> {
  const rows = db
    .prepare('SELECT name, mode FROM conversation_tool_settings WHERE conversation_id = ?')
    .all(conversationId) as { name: string; mode: string }[];
  const out = new Map<string, ToolMode>();
  for (const row of rows) if (isToolMode(row.mode)) out.set(row.name, row.mode);
  return out;
}

/**
 * 这一轮真正生效的「工具名 → 三态」。
 *
 * ★ 主循环该用的**唯一入口**（`runTurn` 里传 conversationId 进来）。
 *   不传 conversationId 时等同于全局表 —— 子代理/维护这类没有会话语境的调用照旧工作。
 */
export function effectiveToolModes(db: DatabaseSync, conversationId?: string | null): Map<string, ToolMode> {
  const out = new Map<string, ToolMode>();
  for (const [name, setting] of listToolSettings(db)) out.set(name, setting.mode);
  if (conversationId !== undefined && conversationId !== null) {
    for (const [name, mode] of listConversationToolModes(db, conversationId)) out.set(name, mode);
  }
  return out;
}

export function setConversationToolMode(
  db: DatabaseSync,
  conversationId: string,
  name: string,
  mode: ToolMode,
): void {
  if (!isToolMode(mode)) throw new Error(`非法工具模式：${String(mode)}`);
  db.prepare(
    `INSERT INTO conversation_tool_settings (conversation_id, name, mode, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id, name) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  ).run(conversationId, name, mode, new Date().toISOString());
}

/** 抹掉会话对某个工具的覆盖 ⇒ 它回到"跟随全局" */
export function clearConversationToolMode(db: DatabaseSync, conversationId: string, name: string): boolean {
  return Number(
    db.prepare('DELETE FROM conversation_tool_settings WHERE conversation_id = ? AND name = ?').run(conversationId, name).changes,
  ) > 0;
}

/** 清空某个会话的全部覆盖（= 完全跟随全局） */
export function clearAllConversationToolModes(db: DatabaseSync, conversationId: string): number {
  return Number(db.prepare('DELETE FROM conversation_tool_settings WHERE conversation_id = ?').run(conversationId).changes);
}

// ── 模板 ────────────────────────────────────────────────────────────────

export type ToolTemplate = {
  readonly id: string;
  readonly name: string;
  readonly modes: Readonly<Record<string, ToolMode>>;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type TemplateRow = { id: string; name: string; modes: string; is_default: number; created_at: string; updated_at: string };

function parseModes(raw: string): Record<string, ToolMode> {
  const out: Record<string, ToolMode> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      for (const [name, mode] of Object.entries(parsed as Record<string, unknown>)) {
        if (isToolMode(mode)) out[name] = mode;
      }
    }
  } catch {
    // 坏 JSON 当作空模板：宁可套不出东西，也不要抛错把整个面板打死
  }
  return out;
}

function toTemplate(row: TemplateRow): ToolTemplate {
  return {
    id: row.id,
    name: row.name,
    modes: parseModes(row.modes),
    isDefault: Number(row.is_default) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listToolTemplates(db: DatabaseSync): ToolTemplate[] {
  return (db.prepare('SELECT * FROM tool_templates ORDER BY is_default DESC, name').all() as TemplateRow[]).map(toTemplate);
}

export function getToolTemplate(db: DatabaseSync, id: string): ToolTemplate | undefined {
  const row = db.prepare('SELECT * FROM tool_templates WHERE id = ?').get(id) as TemplateRow | undefined;
  return row === undefined ? undefined : toTemplate(row);
}

/**
 * 存模板。`modes` 是整份快照。
 * ★ 重名直接报错而不是覆盖：模板是"我调好的一套"，静默覆盖另一套是数据丢失。
 */
export function createToolTemplate(
  db: DatabaseSync,
  name: string,
  modes: Readonly<Record<string, ToolMode>>,
): ToolTemplate {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('模板名不能为空');
  if (trimmed.length > 40) throw new Error('模板名过长（>40 字符）');
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO tool_templates (id, name, modes, is_default, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(id, trimmed, JSON.stringify(modes), now, now);
  return getToolTemplate(db, id) as ToolTemplate;
}

export function deleteToolTemplate(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM tool_templates WHERE id = ?').run(id).changes) > 0;
}

/**
 * 设默认模板。
 * ★ 先全部清零再置一：部分唯一索引不允许两行同时 `is_default = 1`，
 *   直接 UPDATE 会撞索引；两步放在同一事务里才安全。
 */
export function setDefaultToolTemplate(db: DatabaseSync, id: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE tool_templates SET is_default = 0, updated_at = ? WHERE is_default = 1').run(new Date().toISOString());
    db.prepare('UPDATE tool_templates SET is_default = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 把一个模板套到**全局**（每个工具逐个落库）。
 * ★ 套用时**不再走差异逻辑**：模板就是要整体搬，包括把已改过的工具搬回模板里的值。
 */
export function applyToolTemplateToGlobal(db: DatabaseSync, id: string): number {
  const template = getToolTemplate(db, id);
  if (template === undefined) throw new Error('模板不存在');
  let changed = 0;
  for (const [name, mode] of Object.entries(template.modes)) {
    setToolMode(db, name, mode);
    changed += 1;
  }
  return changed;
}

/** 把模板套到**某个会话**（写成会话覆盖；不影响其它会话与全局） */
export function applyToolTemplateToConversation(db: DatabaseSync, conversationId: string, id: string): number {
  const template = getToolTemplate(db, id);
  if (template === undefined) throw new Error('模板不存在');
  let changed = 0;
  for (const [name, mode] of Object.entries(template.modes)) {
    setConversationToolMode(db, conversationId, name, mode);
    changed += 1;
  }
  return changed;
}

/** 把当前生效的一套导出成模板快照（"把现在这套存为模板"） */
export function snapshotModes(db: DatabaseSync, conversationId?: string | null): Record<string, ToolMode> {
  const out: Record<string, ToolMode> = {};
  for (const [name, mode] of effectiveToolModes(db, conversationId)) out[name] = mode;
  return out;
}
