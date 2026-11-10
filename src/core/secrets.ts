import { readFileSync, writeFileSync } from 'node:fs';

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

export function writeSecrets(path: string, secrets: Secrets): void {
  // 0o600 = 仅当前用户可读写。Windows 上 chmod 语义弱，但不会更糟。
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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
