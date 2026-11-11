import { realpathSync, statSync } from 'node:fs';
import { isInside, normalizePath } from '../paths.ts';

/** Process-wide, deliberately independent of conversation roots/mode. Never expose secrets via host tools. */
const privateDirectories = new Map<symbol, readonly string[]>();

export function registerPrivateDirectory(path: string): () => void {
  const id = Symbol('private-directory');
  privateDirectories.set(id, [normalizePath(path), normalizePath(realpathSync.native(path))]);
  return () => { privateDirectories.delete(id); };
}

const privateFiles = new Map<symbol, string>();
const identity = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;

/** Register the opened empty file before its first secret byte, including hard-link aliases outside its directory. */
export function registerPrivateFile(path: string): () => void {
  const id = Symbol('private-file');
  privateFiles.set(id, identity(statSync(path, { bigint: true })));
  return () => { privateFiles.delete(id); };
}

export function hasPrivateDirectories(): boolean { return privateDirectories.size !== 0 || privateFiles.size !== 0; }

/**
 * `path` 是否落在私密目录内，或**私密目录落在 `path` 内**（`path` 是私密目录的祖先）。
 *
 * ★ 2026-11-11 审计 `ALK-CRIT-02`（本机令牌任务内）：`ensureLowLabel` 用 `icacls (OI)(CI)`
 *   给目录打**继承**标签。若目标是被诱导出来的私密目录**祖先**，继承标签会波及 `local-auth-*`
 *   目录、把 `NO_READ_UP|NO_WRITE_UP` 破坏成 Low 可读。所以这里要双向判：既挡「目标在私密域内」，
 *   也挡「目标是私密域的祖先」。
 */
export function isPrivatePathOrAncestor(path: string): boolean {
  const lexical = normalizePath(path);
  let real = lexical;
  try {
    real = normalizePath(realpathSync.native(path));
  } catch {
    /* 路径不存在时保留词法结果继续判 */
  }
  for (const roots of privateDirectories.values()) {
    for (const root of roots) {
      if (isInside(lexical, root) || isInside(root, lexical) || isInside(real, root) || isInside(root, real)) {
        return true;
      }
    }
  }
  return false;
}

/** Caller must also check the canonical target, including links and nonexistent descendants. */
export function isPrivatePath(path: string): boolean {
  for (const paths of privateDirectories.values()) {
    if (paths.some((root) => isInside(path, root))) return true;
  }
  if (privateFiles.size !== 0) {
    try {
      const target = identity(statSync(path, { bigint: true }));
      if ([...privateFiles.values()].includes(target)) return true;
    } catch { /* Missing targets are checked by canonical ancestor resolution in guard.ts. */ }
  }
  return false;
}
