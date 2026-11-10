import { resolve as resolvePath } from 'node:path';

/**
 * 路径判定工具（纯函数，可完整单测）。
 *
 * ★ 为什么不用 `path.resolve` 代替 `normalizePath`：`resolve` 会**访问文件系统之外**的
 *   语义（当前工作目录、盘符推断），而权限判定需要的是**纯词法**结果 ——
 *   文件是否存在不应该改变"这个路径算不算在工作区里"。
 *
 * ★ 为什么大小写比较要按平台：Windows 文件系统大小写不敏感，
 *   `C:/Users/X` 和 `c:/users/x` 是同一个目录；不处理等于留一个绕过口子。
 */

const CASE_INSENSITIVE = process.platform === 'win32';

/** 词法规范化：统一分隔符为 `/`、消掉 `.` 与 `..`、去掉多余斜杠；保留绝对性。 */
export function normalizePath(input: string): string {
  const unified = input.trim().replace(/\\/g, '/');
  if (unified.length === 0) return '';

  const isDriveAbsolute = /^[A-Za-z]:($|\/)/.test(unified);
  const isAbsolute = unified.startsWith('/') || isDriveAbsolute;

  const out: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..' && !/^[A-Za-z]:$/.test(out[out.length - 1] ?? '')) {
        out.pop();
      } else if (!isAbsolute) {
        out.push('..');
      }
      continue;
    }
    out.push(segment);
  }

  const body = out.join('/');
  if (isDriveAbsolute) return body.length === 0 ? `${unified.slice(0, 2)}/` : body;
  if (isAbsolute) return `/${body}`;
  return body;
}

function comparable(path: string): string {
  return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

/** `target` 是否在 `root` 之内（含 root 自身）。已处理 `..` 穿越与"前缀相同但不是同一目录"。 */
export function isInside(target: string, root: string): boolean {
  const t = comparable(normalizePath(target));
  const r = comparable(normalizePath(root));
  if (r.length === 0) return false;
  if (t === r) return true;
  return t.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** 两个路径是否指向同一个位置（大小写按平台） */
export function samePath(a: string, b: string): boolean {
  return comparable(normalizePath(a)) === comparable(normalizePath(b));
}

/** 相对基准目录解析成绝对路径，再词法规范化。 */
export function toAbsolute(input: string, base?: string): string {
  const resolved = base === undefined ? resolvePath(input) : resolvePath(base, input);
  return normalizePath(resolved);
}
