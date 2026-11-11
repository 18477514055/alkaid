import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeSecrets } from '../../src/core/secrets.ts';
import { hardenDataHome } from '../../src/core/security/harden-data-home.ts';

/**
 * ★★ 验收缺口回归（2026-11-11）：`secrets.json` 与 `alkaid.db` 必须**对 Low 完整性进程不可读**。
 *
 * 为什么这条必须有：上一轮交付只给 `local-auth-…` 凭证目录打了 NRNW，
 * 我用真 Low 进程实测 `Get-Content secrets.json` 拿到 **LEAKED:76**（全部 API Key 明文）、
 * `alkaid.db` 拿到 **LEAKED_DB:4095** —— `ALK-CRIT-02` 的头号危害当时**没被修**。
 *
 * 判据（缺一不可）：
 * 1. Low 进程读 `secrets.json` ⇒ 被拒；
 * 2. Low 进程读 `alkaid.db` ⇒ 被拒；
 * 3. **正对照**：同一个 Low 进程读一个普通临时文件 ⇒ 成功
 *    （否则"全部被拒"也可能是沙箱整体坏掉的假绿）；
 * 4. Medium 宿主自己仍能读写这两个文件（加固不能把功能弄坏）。
 */

const WINDOWS = process.platform === 'win32';
const PS = `${process.env['SystemRoot']}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

async function runAsLow(sandbox: string, command: string): Promise<string> {
  const { spawnConfined } = await import('../../src/core/sandbox/win32-confine.ts');
  // ★ 必须带 `-ErrorAction Stop`：PowerShell 的「拒绝访问」是**非终止错误**，
  //   不带它时 try/catch 抓不住，脚本会继续跑并打印出误导性的结果。
  const result = await spawnConfined({
    file: PS,
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
    cwd: tmpdir(),
    outputDir: sandbox,
    timeoutMs: 60_000,
  });
  return `${result.stdout}${result.stderr}`;
}

/** 读得到就打印内容长度（LEAKED:n），读不到打印 DENIED —— 用于"必须被拒"的判据。 */
async function readDeniedProbe(sandbox: string, path: string): Promise<string> {
  return await runAsLow(sandbox, `try { $c = Get-Content -LiteralPath '${path}' -Raw -ErrorAction Stop; "LEAKED:$($c.Length)" } catch { 'DENIED' }`);
}

/** 直接打印内容 —— 用于正对照（要断言"确实读到了 CONTROL_OK"）。 */
async function readContentProbe(sandbox: string, path: string): Promise<string> {
  return await runAsLow(sandbox, `try { Get-Content -LiteralPath '${path}' -Raw -ErrorAction Stop } catch { 'DENIED' }`);
}

test('数据目录加固：Low 进程读不到 secrets.json 与 alkaid.db（含正对照）', { skip: !WINDOWS }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-harden-'));
  const sandbox = join(tmpdir(), `alkaid-harden-low-${Date.now()}`);
  try {
    mkdirSync(home, { recursive: true });
    writeSecrets(join(home, 'secrets.json'), { demo: 'sk-must-not-leak' });
    const dbPath = join(home, 'alkaid.db');
    writeFileSync(dbPath, 'SQLite format 3\0fake-db-for-label-test', 'utf8');

    // 加固：目录 + 既有敏感文件
    hardenDataHome(home, () => undefined);

    // ④ 宿主（Medium）仍能读写
    assert.match(readFileSync(join(home, 'secrets.json'), 'utf8'), /sk-must-not-leak/, 'Medium 必须仍能读到自己的凭据');
    assert.match(readFileSync(dbPath, 'utf8'), /SQLite format 3/, 'Medium 必须仍能读到自己的库');

    // ① / ② Low 读两个敏感文件都必须被拒
    const secrets = await readDeniedProbe(sandbox, join(home, 'secrets.json'));
    assert.match(secrets, /DENIED/, `Low 不应读到 secrets.json：${secrets.slice(0, 200)}`);
    assert.doesNotMatch(secrets, /LEAKED/, 'Low 读到了 secrets.json —— 加固没生效');

    const database = await readDeniedProbe(sandbox, dbPath);
    assert.match(database, /DENIED/, `Low 不应读到 alkaid.db：${database.slice(0, 200)}`);
    assert.doesNotMatch(database, /LEAKED/, 'Low 读到了 alkaid.db —— 加固没生效');

    // ③ 正对照：同一个沙箱读普通文件必须成功（证明上面两条不是沙箱坏掉的假绿）
    const control = join(tmpdir(), `alkaid-harden-control-${Date.now()}.txt`);
    writeFileSync(control, 'CONTROL_OK', 'utf8');
    try {
      const controlOut = await readContentProbe(sandbox, control);
      assert.match(controlOut, /CONTROL_OK/, `正对照失败：沙箱本身读不了普通文件（${controlOut.slice(0, 160)}）`);
    } finally {
      rmSync(control, { force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});
