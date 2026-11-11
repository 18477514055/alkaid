import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { isInside, normalizePath, toAbsolute } from '../paths.ts';
import type { Roots } from './roots.ts';
import { hasPrivateDirectories, isPrivatePath } from '../security/private-paths.ts';

/**
 * 文件访问围栏。
 *
 * 两条判定（都是必须的，缺一条就有洞）：
 *
 * **① 词法判定** —— 规范化后是否落在授权根里。挡住 `..` 穿越、"同前缀不同目录"、大小写差异。
 *
 * **② 真实路径复核** —— 只做词法是不够的：Windows 上一个 `mklink /J` 就能在工作区里放一个
 *    指向 `C:\Users\...` 的 junction，词法上它在工作区里，实际写的是外面。
 *    这正是 2026 年 Claude Code `CVE-2026-39861` 的形状（沙箱内建链接、沙箱外进程跟随写入）。
 *    所以：把目标解析成**真实路径**之后再判一次，并且后续操作用的是这个真实路径
 *    （照 DSH fs-sandbox 的说法："被变更的正是这个新目标"）。
 *
 * ★ 已知边界（诚实写下来）：解析与系统调用之间仍有 TOCTOU 窗口，缩小了但没有消除。
 *   真正严密需要内核原语（openat2 那一类），V0.1 不做 —— 见设计稿 §14。
 */

export type AccessOp = 'read' | 'write';

export type GuardResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly code: 'denied_by_policy';
      readonly message: string;
      readonly hint: string;
      readonly allowedRoots: readonly string[];
    };

/** 相对路径按 cwd 解析成绝对路径（词法），不碰文件系统 */
export function resolveToolPath(input: string, cwd: string): string {
  return toAbsolute(input, cwd);
}

/**
 * 求真实路径：找到**最近的已存在祖先**做 `realpath`，再把剩下的段接回去。
 * 这样"要新建的文件"和"已存在的目录"走同一套判定。
 *
 * ★★ 2026-11-11 审计 `CRITICAL-01`：原来这里写死 `depth < 64`，耗尽后**返回未解析的词法路径**
 *   （fail-open）。攻击面很具体：`ws/link_out/` 是个指向 `~/.ssh` 的 Junction，
 *   只要在它下面编出 65 层**不存在**的子目录，回溯 64 次后 `current` 停在 `ws/link_out/d1`（仍不存在），
 *   循环结束返回词法路径 ⇒ `isInside(canonical, ws)` 判定通过 ⇒ 实际写入跑到工作区外面。
 *
 * 现在的判据：
 * 1. **不设固定深度**，一直回溯到文件系统根（`parent === current`）。根一定存在，所以必然终止；
 * 2. 到根还解析不出来 ⇒ **抛错（fail-closed）**，让上层按"拒绝访问"处理，
 *    绝不再"返回原路径"当作通过 —— 那正是漏洞的形态。
 *
 * ★★ 2026-11-11 审计 `ALK-CRIT-03`：只去掉深度上限**还不够**。
 *   `realpathSync` 对**悬空链接**（指向尚不存在目标的 symlink/junction）也抛 `ENOENT` ——
 *   而那个 `catch` 分不清"这一层不存在"和"这一层是个指向外面的链接"，于是把它当普通文件名剥掉，
 *   回退到父目录后就返回"看起来在工作区里"的路径。实测（`_probe-dangling.mjs`）：
 *   `ws/escape` 是指向 `工作区外/new-dir` 的悬空 junction 时，`checkAccess(..., 'write', 'ws/escape/pwn.txt')`
 *   返回 **ALLOWED** —— 一步就能把写入送到外面，连 64 层都不需要。
 *
 *   判据：每剥一段之前，先 `lstatSync` 看它**本身**是不是链接。是 ⇒ 读 `readlinkSync` 把目标
 *   解成绝对路径后**递归规范化那个目标**（带跳数上限防环），再拼回剩余段。这样悬空链接会被
 *   解析成它真正指向的位置，随后 `checkAccess` 一眼就能看出它在外面。
 */
export function canonicalize(path: string, linkHops = 40): string {
  if (linkHops <= 0) throw new Error(`符号链接解析跳数过多（疑似环，fail-closed）：${path}`);
  let current = normalizePath(path);
  const trailing: string[] = [];

  for (;;) {
    try {
      const real = normalizePath(realpathSync.native(current));
      return trailing.length === 0 ? real : normalizePath(join(real, ...trailing.reverse()));
    } catch {
      /**
       * ★ 关键：先看这一层**是不是链接本身**。悬空链接会让 `realpathSync` 抛 ENOENT，
       *   但 `lstatSync` 仍能看到它 —— 这时绝不能把它当"不存在的普通文件名"剥掉。
       */
      let linkTarget: string | null = null;
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) linkTarget = readlinkSync(current);
      } catch {
        // lstat 也看不到 ⇒ 这一段确实不存在，可以安全上溯
      }
      if (linkTarget !== null) {
        // Windows junction 的 readlink 给的是绝对路径；符号链接可能是相对的 ⇒ resolve 兜住
        const resolvedTarget = normalizePath(resolve(dirname(current), linkTarget));
        const base = canonicalize(resolvedTarget, linkHops - 1);
        return trailing.length === 0 ? base : normalizePath(join(base, ...trailing.reverse()));
      }

      const parent = dirname(current);
      if (parent === current || parent.length === 0) {
        // 走到根还解析不出来：宁可拒绝，也不放行
        throw new Error(`无法解析路径的真实位置（fail-closed）：${path}`);
      }
      trailing.push(basename(current));
      current = parent;
    }
  }
}

const OP_LABEL: Record<AccessOp, string> = { read: '读取', write: '写入' };

function deny(op: AccessOp, target: string, allowed: readonly string[], extra: string): GuardResult {
  const list = allowed.length > 0 ? allowed.join('、') : '（无）';
  return {
    ok: false,
    code: 'denied_by_policy',
    message: `${OP_LABEL[op]}被拒绝：${target} 不在授权范围内${extra}`,
    hint:
      allowed.length > 0
        ? `当前权限模式下允许${OP_LABEL[op]}的根：${list}。把目标放到这些目录里，或请用户切换权限模式；不要用同样的路径重试。`
        : `当前权限模式下不允许${OP_LABEL[op]}任何路径。请直接告诉用户需要切换权限模式，不要重试。`,
    allowedRoots: allowed,
  };
}

/**
 * 判定一次访问。
 * @param target 已解析成绝对路径的目标（`resolveToolPath` 的结果）
 */
export function checkAccess(roots: Roots, op: AccessOp, target: string): GuardResult {
  const allowed = op === 'read' ? roots.readable : roots.writable;

  const lexical = normalizePath(target);
  // Host tools run at Medium integrity. Even full mode must not act as a credential-reading deputy.
  // Check lexical paths, canonical link targets AND registered file identities (hard-link aliases).
  // Keep ordinary full-mode behavior unchanged when no private directory is registered.
  if (hasPrivateDirectories()) {
    const privateDeny = (): GuardResult => ({
      ok: false, code: 'denied_by_policy',
      message: '访问被拒绝：该路径属于进程私密凭证域（所有工具权限模式均禁止读写）',
      hint: '这是宿主凭证保护，不可通过切换 full、上层遍历或链接绕过。请用户在可信界面完成配对。',
      allowedRoots: allowed,
    });
    if (isPrivatePath(lexical)) return privateDeny();
    try {
      if (isPrivatePath(canonicalize(lexical))) return privateDeny();
    } catch {
      return deny(op, lexical, allowed, '（无法解析该路径的真实位置，已拒绝）');
    }
  }
  // Full remains unrestricted for ordinary paths, but never bypasses the private-domain rule above.
  if (roots.anywhere) return { ok: true, path: lexical };
  if (allowed.length === 0) return deny(op, lexical, allowed, '');
  if (!allowed.some((root) => isInside(lexical, root))) return deny(op, lexical, allowed, '');

  // 词法过了还不够：真实路径也必须落在（真实路径的）根里
  /**
   * ★ `canonicalize` 现在是 **fail-closed**（解析不出来就抛）——
   *   这里接住并转成"拒绝访问"，把失败变成一个正常的 GuardResult，
   *   而不是让异常冒到工具层变成一个看不懂的 500。
   */
  let canonical: string;
  let canonicalRoots: string[];
  try {
    canonical = canonicalize(lexical);
    canonicalRoots = allowed.map((root) => canonicalize(root));
  } catch {
    return deny(op, lexical, allowed, '（无法解析该路径的真实位置，已拒绝）');
  }
  if (!canonicalRoots.some((root) => isInside(canonical, root))) {
    return deny(op, canonical, allowed, '（该路径经真实路径解析后指向了授权范围之外，疑似链接/junction 逃逸）');
  }

  return { ok: true, path: canonical };
}

/** 只判定不抛：给工具层统一用的包装 */
export function requireAccess(roots: Roots, op: AccessOp, target: string): { ok: true; path: string } | { ok: false; result: GuardResult } {
  const result = checkAccess(roots, op, target);
  return result.ok ? { ok: true, path: result.path } : { ok: false, result };
}
