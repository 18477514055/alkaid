import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { protectWindowsPrivateDirectory, protectWindowsPrivateFile } from './windows-private.ts';

/**
 * 把**应用数据目录里的敏感资产**降成「当前用户 + Medium NRNW」（验收缺口修复）。
 *
 * ## 为什么需要这一步（实测结论，不是推测）
 * 上一轮交付只给 `local-auth-…` 那个凭证目录施加了 NRNW。我用**真 Low 完整性**进程实测：
 * ```
 * Get-Content <home>/secrets.json  → LEAKED:76      ← 全部厂商 API Key 明文
 * Get-Content <home>/alkaid.db     → LEAKED_DB:4095 ← 全部会话
 * ```
 * 也就是说：`workspace` 档（默认）下，模型只要跑一次 `pwsh` 就能把用户的 Key 全部拿走 ——
 * 这正是 `ALK-CRIT-02` 的头号危害，而它当时**没被修**（NRNW 只覆盖了令牌）。
 *
 * ## 判据
 * - **目录**：给数据目录本身打可继承的 NRNW + 仅属主 DACL ⇒ 之后新建的
 *   `alkaid.db-wal` / `-shm`、导出的文件都会**自动继承**，不用逐个点名；
 * - **既有文件**：目录标签对**已存在**的子孙不保证回溯生效（不同 Windows 版本传播行为不一致），
 *   所以对 `secrets.json` / `alkaid.db` / `-wal` / `-shm` **显式再打一次**，并读回校验。
 *
 * ## 失败怎么办（刻意分级，不是一刀切）
 * - 目录打标签失败 ⇒ **只记警告**：目录所在卷可能不支持 ACL（FAT/exFAT/网络盘），
 *   这时让应用起不来比"读得到 Key"更糟，且用户会立刻发现所有功能都坏。
 * - `secrets.json` 打标签失败 ⇒ **由 `writeSecrets` 抛错**（见 `secrets.ts`）：
 *   写不进一个**受保护的**位置，就不要把明文 Key 落盘。
 */
export function hardenDataHome(home: string, warn: (message: string) => void = (m) => console.warn(m)): void {
  if (process.platform !== 'win32') return; // POSIX 上靠 0700/0600 做用户隔离
  try {
    protectWindowsPrivateDirectory(home);
  } catch (error) {
    warn(`[alkaid] 数据目录未能降为 NRNW（${error instanceof Error ? error.message : String(error)}）；低完整性进程可能仍能读到该目录下的文件。`);
    return;
  }
  for (const name of ['secrets.json', 'alkaid.db', 'alkaid.db-wal', 'alkaid.db-shm']) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    try {
      protectWindowsPrivateFile(path);
    } catch (error) {
      warn(`[alkaid] ${name} 未能降为 NRNW（${error instanceof Error ? error.message : String(error)}）。`);
    }
  }
}
