/**
 * 五档权限的**唯一定义处**（设计稿 §5）。
 *
 * ★ 为什么单独一个文件：`promptValue` 会出现在给模型的提示词里，而执行层要比对的
 *   也是它。两处各写一遍 `when(str)` 就是"提示词说能写、执行器说不能写"的起源
 *   （ChatMobile 的 `WorkspacePermission` 注释里踩过这个坑，这里直接把它固化成一张表）。
 */

export const PERMISSION_MODES = ['readonly', 'workspace', 'project', 'workspace_project', 'full'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type ModeSpec = {
  /** 给人看的中文名（**不要**拿它去和模型对话） */
  readonly label: string;
  /** 给模型看的字面值 —— 与执行层比对的是同一个串 */
  readonly promptValue: string;
  /** 附在提示词后的一句边界说明 */
  readonly hint: string;
  readonly workspaceRead: boolean;
  readonly workspaceWrite: boolean;
  readonly projectRead: boolean;
  readonly projectWrite: boolean;
  /** 能否碰授权范围之外的任意路径 */
  readonly anywhere: boolean;
};

export const PERMISSION_MODE_SPEC: Record<PermissionMode, ModeSpec> = {
  readonly: {
    label: '只读',
    promptValue: 'read-only',
    hint: '你可以读取工作区与项目共享目录中的文件，但任何新建/修改/删除都会被拒绝',
    workspaceRead: true,
    workspaceWrite: false,
    projectRead: true,
    projectWrite: false,
    anywhere: false,
  },
  workspace: {
    label: '工作区',
    promptValue: 'workspace',
    hint: '你可以读写工作区内的文件；项目共享目录只读；工作区外一律拒绝',
    workspaceRead: true,
    workspaceWrite: true,
    projectRead: true,
    projectWrite: false,
    anywhere: false,
  },
  project: {
    label: '项目',
    promptValue: 'project',
    hint: '你可以读写项目共享目录；工作区只读；两者之外一律拒绝',
    workspaceRead: true,
    workspaceWrite: false,
    projectRead: true,
    projectWrite: true,
    anywhere: false,
  },
  workspace_project: {
    label: '工作区和项目',
    promptValue: 'workspace-project',
    hint: '你可以读写工作区与项目共享目录；授权范围之外一律拒绝',
    workspaceRead: true,
    workspaceWrite: true,
    projectRead: true,
    projectWrite: true,
    anywhere: false,
  },
  full: {
    label: '完全权限',
    promptValue: 'full',
    hint: '你可以读写任意路径（仍受工具开关与操作系统权限限制）',
    workspaceRead: true,
    workspaceWrite: true,
    projectRead: true,
    projectWrite: true,
    anywhere: true,
  },
};

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'workspace';

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** 认不出的模式**回退到默认档**，绝不回退到最宽的那一档 */
export function resolvePermissionMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;
}
