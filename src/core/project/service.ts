import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { Config } from '../../config.ts';
import { insertProject, getProject, type ProjectRow } from '../store/repo.ts';

/**
 * 项目服务。
 *
 * ★ 共享目录由**程序创建**（用户选的方案）：`<数据根>/projects/<projectId>/shared`。
 *   好处是"项目共享数据不随单个对话删除"（任务书 §10.2 C）天然成立 ——
 *   目录根本不在工作区里，删对话碰不到它。
 */

export type CreateProjectInput = {
  readonly name: string;
  readonly description?: string | null;
};

export function createProject(db: DatabaseSync, config: Config, input: CreateProjectInput): ProjectRow {
  const id = randomUUID();
  const sharedDir = join(config.projectsDir, id, 'shared');

  // 先建目录再写行：目录建不出来就不该有一条指向不存在路径的项目
  mkdirSync(sharedDir, { recursive: true });

  return insertProject(db, {
    id,
    name: input.name,
    description: input.description ?? null,
    sharedDir,
  });
}

/** 删项目是破坏性动作 ⇒ V0.1 只提供"归档"，文件与历史都留着 */
export function assertProjectExists(db: DatabaseSync, projectId: string): ProjectRow {
  const project = getProject(db, projectId);
  if (project === undefined) throw new Error(`项目不存在：${projectId}`);
  return project;
}
