import type { PermissionMode } from './mode.ts';

/**
 * 授权根集合 —— **五档权限落到具体路径上的唯一出口**。
 *
 * ★ 为什么必须集中在一处：DSH 的 fs 围栏与 shell runner 都从一个 `writableRoots()`
 *   派生可写集合，理由写在它的 README 里 —— "在其他位置定义可写集合的 runner profile
 *   会发生漂移"。我们照抄这条：文件工具和 shell 工具都只认这里返回的根。
 */

export type Roots = {
  /** 允许读取的根（空 + anywhere=false 表示什么都不许读） */
  readonly readable: readonly string[];
  /** 允许写入的根 */
  readonly writable: readonly string[];
  /** 完全权限：不受根限制 */
  readonly anywhere: boolean;
};

export function rootsFor(
  mode: PermissionMode,
  workspacePath: string | null,
  projectSharedDir: string | null,
): Roots {
  const readable: string[] = [];
  const writable: string[] = [];

  // 三档（readonly / workspace / full）都能读工作区；project 档工作区也只读
  if (workspacePath !== null && workspacePath.length > 0) {
    readable.push(workspacePath);
    if (mode === 'workspace' || mode === 'workspace_project' || mode === 'full') writable.push(workspacePath);
  }

  if (projectSharedDir !== null && projectSharedDir.length > 0) {
    readable.push(projectSharedDir);
    if (mode === 'project' || mode === 'workspace_project' || mode === 'full') writable.push(projectSharedDir);
  }

  return { readable, writable, anywhere: mode === 'full' };
}
