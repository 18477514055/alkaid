import { realpathSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { normalizePath, samePath, toAbsolute } from '../paths.ts';
import { insertWorkspace, listWorkspaces, type WorkspaceRow } from '../store/repo.ts';

/**
 * 工作区服务。
 *
 * 工作区 = **经过用户授权的文件系统目录**（任务书 §3.3）。
 * 登记时要把它变成一个"可以拿来比较的根"：绝对化 → 存在性检查 → 真实路径 → 去重。
 */

export type WorkspaceErrorCode = 'invalid_name' | 'not_found' | 'not_directory' | 'duplicate';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export type RegisterWorkspaceInput = {
  readonly name: string;
  readonly path: string;
};

export function registerWorkspace(db: DatabaseSync, input: RegisterWorkspaceInput): WorkspaceRow {
  const name = input.name.trim();
  if (name.length === 0) throw new WorkspaceError('invalid_name', '工作区名称不能为空');

  const absolute = toAbsolute(input.path.trim());

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new WorkspaceError('not_found', `目录不存在：${absolute}`);
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceError('not_directory', `不是目录：${absolute}`);
  }

  // ★ 用真实路径当根：junction / 符号链接的不同写法会在这里合并成同一个根，
  //   否则同一个目录能被登记两次，权限判定也会因为别名而对不上。
  let rootPath = absolute;
  try {
    rootPath = normalizePath(realpathSync.native(absolute));
  } catch {
    /* 解析失败就用词法结果 —— 不因为解析失败而拒绝一个真实存在的目录 */
  }

  const duplicate = listWorkspaces(db).find((workspace) => samePath(workspace.rootPath, rootPath));
  if (duplicate !== undefined) {
    throw new WorkspaceError('duplicate', `这个目录已经登记过了：${duplicate.name}`);
  }

  return insertWorkspace(db, { name, rootPath });
}
