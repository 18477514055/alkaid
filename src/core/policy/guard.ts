import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isInside, normalizePath, toAbsolute } from '../paths.ts';
import type { Roots } from './roots.ts';

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
 */
export function canonicalize(path: string): string {
  let current = normalizePath(path);
  const trailing: string[] = [];

  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = normalizePath(realpathSync.native(current));
      return trailing.length === 0 ? real : normalizePath(join(real, ...trailing.reverse()));
    } catch {
      const parent = dirname(current);
      if (parent === current || parent.length === 0) return path;
      trailing.push(basename(current));
      current = parent;
    }
  }
  return path;
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

  // 完全权限：不设根限制，但仍返回词法规范化后的路径
  if (roots.anywhere) return { ok: true, path: normalizePath(target) };

  const lexical = normalizePath(target);
  if (allowed.length === 0) return deny(op, lexical, allowed, '');
  if (!allowed.some((root) => isInside(lexical, root))) return deny(op, lexical, allowed, '');

  // 词法过了还不够：真实路径也必须落在（真实路径的）根里
  const canonical = canonicalize(lexical);
  const canonicalRoots = allowed.map((root) => canonicalize(root));
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
