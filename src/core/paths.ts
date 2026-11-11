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

  /**
   * ★ 2026-11-11 审计 `ALK-MED-01`：三种 Windows 路径形状要区别对待，否则围栏判据会被糊弄：
   * - `C:\x`（盘符绝对）⇒ `C:/x`
   * - `C:`（**盘符相对**，含义是"我在 C 盘上的当前目录"）⇒ 绝不能当成 `C:/`。
   *   原来当成盘符根了：`C:` 与 `C:/` 同形，一个"写当前目录"的请求会被当成"写盘符根"。
   * - `\\server\share\x`（UNC）⇒ 保留 `//server/share/x` 两个斜杠。
   *   原来被压成 `/server/share/x`，看起来像"本地根下的一个普通绝对路径"，
   *   与本地根比较时既可能误判在里、也可能误判在外。
   */
  const isDriveRoot = /^[A-Za-z]:[\\/]$/.test(unified) || /^[A-Za-z]:$/.test(unified);
  const isDriveBare = /^[A-Za-z]:$/.test(unified);
  const isUnc = /^\/\//.test(unified);

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
  const drive = unified.slice(0, 2);
  // 盘符相对（`C:`）：原样保留盘符，**不**补成盘符根
  if (isDriveBare && body === '') return drive;
  if (isDriveAbsolute) return body === drive ? `${drive}/` : body;
  // UNC：保留 `//`
  if (isUnc) return body.length === 0 ? '//' : `//${body}`;
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
