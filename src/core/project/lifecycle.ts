import { existsSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { Config } from '../../config.ts';
import { deleteProjectSettings } from '../settings/service.ts';
import { getProject, type ProjectRow } from '../store/repo.ts';

/**
 * 删除项目。**破坏性动作，所以要分成两件事说清楚**：
 * - `deleteFiles: false` ⇒ 只删登记（对话变成"无项目"，共享目录里的文件原地留着）
 * - `deleteFiles: true`  ⇒ 连同**本项目共享目录**一起删
 *
 * ★ 三条判据（写在这里，避免以后被改回去）：
 * 1. **只删自己建的目录**。项目共享目录由程序创建在 `<home>/projects/<id>/shared`；
 *    删除前必须 verify 它确实在 `config.projectsDir` 底下、且第一层目录名就是项目 id。
 *    否则（路径被改过、被手改成用户自己的目录）**拒绝删文件**，只删登记 ——
 *    宁可留垃圾，也不能把用户的工作资料删掉。
 * 2. **只追加的历史不删**。`execution_events` 等表带 `BEFORE DELETE` 触发器和
 *    "history is append-only" 的约束 —— 那是审计证据，删项目也不该抹掉。
 *    所以这里按 `sqlite_master` 里的触发器**自动跳过**这类表，不硬碰。
 * 3. **项目设置跟着项目走**。`app_settings` 里 `scope='project'` 的行必须清掉，
 *    否则同一 id 复用时会让新项目"继承"旧设置。
 */

export type DeleteProjectResult = {
  readonly deleted: boolean;
  /** 实际删掉的文件目录（没删就是 null） */
  readonly removedFilesDir: string | null;
  /** 想删但因为不像程序自建目录而拒绝时的说明 */
  readonly filesRefusedReason: string | null;
  /** 因为"只追加"而保留的表 */
  readonly retainedAppendOnlyTables: readonly string[];
};

/** 表是否有 `BEFORE DELETE` 触发器（有 = 只追加，不能删） */
function hasDeleteTrigger(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND upper(sql) LIKE '%BEFORE DELETE%'")
    .get(table) as { n?: number | bigint } | undefined;
  return Number(row?.n ?? 0) > 0;
}

/** 表有没有 `project_id` 列 */
function hasProjectIdColumn(db: DatabaseSync, table: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name?: string }>;
  return rows.some((r) => r.name === 'project_id');
}

/**
 * 只删**能删的**项目域数据；只追加的留着。
 * ★ 用 `PRAGMA table_info` + `sqlite_master` 现场判定，而不是硬编码表名清单 ——
 *   以后新增记忆表不用回来补这里，也不会漏删。
 */
function purgeProjectRows(db: DatabaseSync, projectId: string): readonly string[] {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name?: string;
    }>
  )
    .map((r) => r.name)
    .filter((n): n is string => typeof n === 'string')

  const retained: string[] = [];
  for (const table of tables) {
    if (!hasProjectIdColumn(db, table)) continue;
    /**
     * ★★ `conversations` **必须排除**（2026-11-11 审计 `CRITICAL-03`，数据毁灭级）。
     *
     * 这张表有 `project_id` 列，且**没有** BEFORE DELETE 触发器，于是原来那句
     * `DELETE FROM <table> WHERE project_id = ?` 会把它整片删掉 ——
     * 连带 `messages` / `step_events` / `compactions` 全部级联消失。
     * 症状：用户右键项目→删除（**即使没勾"删文件"**），该项目下所有对话历史**永久蒸发**；
     * 而如果这些对话派过子代理，外键级联到 `delegations` 又会撞上只追加触发器，直接 500。
     *
     * 设计意图（本文件下面那段注释也写着）：对话与项目是**解耦**的 ——
     * 删项目只应让对话**降级成"无项目会话"**，历史一条不少。
     */
    if (table === 'conversations') {
      db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(projectId);
      continue;
    }
    if (hasDeleteTrigger(db, table)) {
      retained.push(table);
      continue;
    }
    db.prepare(`DELETE FROM ${JSON.stringify(table)} WHERE project_id = ?`).run(projectId);
  }
  return retained;
}

/**
 * 校验共享目录确实是"程序自己建的"。
 * @returns 可以删就返回 resolve 后的路径，否则 null
 */
function safeProjectsDir(config: Config, project: ProjectRow): string | null {
  const projectsRoot = resolve(config.projectsDir);
  const target = resolve(project.sharedDir);
  // 必须在 <projectsDir>/<projectId>/ 底下
  const expectedPrefix = resolve(projectsRoot, project.id) + sep;
  if (!target.startsWith(expectedPrefix)) return null;
  // 再挡一次：路径里不能借 .. 逃出去（resolve 之后仍要复核前缀，上面已做，这里是显式断言）
  if (!target.startsWith(projectsRoot + sep)) return null;
  return target;
}

export function deleteProject(
  db: DatabaseSync,
  config: Config,
  projectId: string,
  options: { deleteFiles: boolean },
): DeleteProjectResult | undefined {
  const project = getProject(db, projectId);
  if (project === undefined) return undefined;

  const filesDir = options.deleteFiles ? safeProjectsDir(config, project) : null;
  const refused = options.deleteFiles && filesDir === null
    ? '共享目录不在程序自建的位置下（可能已被手动改过），只删登记、不动文件'
    : null;

  db.exec('BEGIN');
  let retained: readonly string[] = [];
  try {
    retained = purgeProjectRows(db, projectId);
    deleteProjectSettings(db, projectId);
    // 项目行本身最后删：conversations.project_id 是 ON DELETE SET NULL，
    // 删完它们会变成"无项目对话"，消息与历史一条不少。
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  let removedFilesDir: string | null = null;
  if (filesDir !== null && existsSync(filesDir)) {
    // 删的是 <projectsDir>/<id>/shared；父目录 <projectsDir>/<id> 顺手清掉（为空才删得动）
    rmSync(filesDir, { recursive: true, force: true });
    removedFilesDir = filesDir;
    const parent = resolve(filesDir, '..');
    if (existsSync(parent)) {
      try {
        rmSync(parent, { recursive: true, force: true });
      } catch {
        // 父目录里有别的东西（比如同项目的其他子目录）就留着，不算失败
      }
    }
  }

  return { deleted: true, removedFilesDir, filesRefusedReason: refused, retainedAppendOnlyTables: retained };
}
