import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { protectWindowsPrivateFile } from './security/windows-private.ts';

/**
 * 凭据存取。**单独一个文件，不进项目目录、不进 git、不进日志**（任务书 §10.2 A）。
 *
 * ★ 诚实标注（设计稿 §4）：V0.1 这里是"隔离存放 + 遮蔽"，**不是加密**。
 *   `~/.alkaid/secrets.json` 的访问控制依赖操作系统对用户家目录的权限。
 *   DPAPI 加密是 V0.2 的事 —— 不要在文档里把它说成"加密存储"。
 */

export type Secrets = Record<string, string>;

export function readSecrets(path: string): Secrets {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const out: Secrets = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    // 文件不存在 / 内容坏了，都当"还没有凭据"，不抛 —— 否则首次启动就崩
    return {};
  }
}

/**
 * 写凭据文件。
 *
 * ★ **原子写**（2026-11-11 审计 `MEDIUM-05`）：原来是 `writeFileSync(path, …)` 直接覆盖。
 *   写到一半断电/被杀 ⇒ 得到一个**截断的 JSON** ⇒ `readSecrets` 把它当"没有凭据"
 *   （它故意不抛错），于是所有 API Key 静默消失，而且看起来像"上游鉴权失败"，
 *   排查方向会被带偏很远。
 *
 * 做法：先写同目录的临时文件（同盘才能 rename），再 `renameSync` 原子替换；
 * 失败时清掉临时文件，**不动原文件**。`mode: 0o600` 在临时文件上先设好，
 * 避免"先可读再收紧"那一小段窗口。
 */
export function writeSecrets(path: string, secrets: Secrets): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    // 0o600 = 仅当前用户可读写。Windows 上 chmod 语义弱，但不会更糟。
    writeFileSync(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    /**
     * ★★ 验收缺口修复（2026-11-11）：**先保护，再让它出现在正式路径上**。
     *
     * 顺序很重要：在 `renameSync` **之前**给临时文件施加「仅属主 DACL + Medium NRNW」，
     * 这样 `rename` 之后落到 `secrets.json` 的就是**已经受保护**的那个文件 ——
     * 不存在"文件已经可读、标签还没打上"的窗口。
     * 失败就删掉临时文件并抛错：**写不进一个受保护的位置，就不要把明文 Key 落盘**。
     */
    if (process.platform === 'win32') protectWindowsPrivateFile(tmp);
    renameSync(tmp, path);
    if (process.platform === 'win32') {
      // rename 同卷保留安全描述符；这里再读回校验一次，防止"设了但没生效"。
      protectWindowsPrivateFile(path);
    }
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不该盖住真正的错 */
    }
    throw error;
  }
}

export function setSecret(path: string, providerId: string, apiKey: string): void {
  const secrets = readSecrets(path);
  secrets[providerId] = apiKey;
  writeSecrets(path, secrets);
}

export function removeSecret(path: string, providerId: string): void {
  const secrets = readSecrets(path);
  if (!(providerId in secrets)) return;
  delete secrets[providerId];
  writeSecrets(path, secrets);
}

export function getSecret(path: string, providerId: string): string | undefined {
  const value = readSecrets(path)[providerId];
  return value === undefined || value.length === 0 ? undefined : value;
}
