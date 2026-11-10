import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { clearLowLabel, ensureLowLabel, spawnConfined } from '../../src/core/sandbox/win32-confine.ts';

/**
 * Low 完整性受限执行 —— 这是"把 shell 下放到 workspace 档"的**唯一依据**。
 *
 * 判据（缺一不可）：
 * ① 打标签的目录里能写；
 * ② 没打标签的目录写不进去，且**文件确实不存在**（不能只信返回值）；
 * ③ 输出能读回来（否则工具对模型等于半盲）；
 * ④ 超时真的能结束进程。
 */

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function sandboxDir(): string {
  return mkdtempSync(join(tmpdir(), 'alkaid-sbx-'));
}

function cleanup(root: string, dirs: readonly string[]): void {
  for (const dir of dirs) clearLowLabel(dir);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 临时目录，删不掉不阻塞测试 */
  }
}

function writeScript(path: string): string {
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Set-Content -LiteralPath '${path}' -Value 'x' -Encoding UTF8; Write-Output 'ok'`;
}

test('受限进程：打标签的目录能写，输出能读回', async () => {
  const root = sandboxDir();
  const allowed = join(root, 'allowed');
  const out = join(root, 'out');
  mkdirSync(allowed, { recursive: true });

  try {
    ensureLowLabel(allowed);

    const result = await spawnConfined({
      file: POWERSHELL,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', writeScript(join(allowed, 'a.txt'))],
      cwd: allowed,
      outputDir: out,
      timeoutMs: 30_000,
    });

    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /ok/);
    assert.equal(existsSync(join(allowed, 'a.txt')), true);
    assert.equal(readFileSync(join(allowed, 'a.txt'), 'utf8').trim(), 'x');
  } finally {
    cleanup(root, [allowed, out]);
  }
});

test('受限进程：没打标签的目录写不进去，且文件确实不存在', async () => {
  const root = sandboxDir();
  const allowed = join(root, 'allowed');
  const denied = join(root, 'denied');
  const out = join(root, 'out');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(denied, { recursive: true });

  try {
    ensureLowLabel(allowed);

    const result = await spawnConfined({
      file: POWERSHELL,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', writeScript(join(denied, 'b.txt'))],
      cwd: allowed,
      outputDir: out,
      timeoutMs: 30_000,
    });

    // ★ 只信磁盘：文件不能存在
    assert.equal(existsSync(join(denied, 'b.txt')), false, '越权写入居然成功了 —— 沙箱没有生效');
    // PowerShell 会把 AccessDenied 写到 stderr（非终止错误，退出码仍是 0）
    assert.match(result.stderr, /访问被拒绝|Access is denied/i);
  } finally {
    cleanup(root, [allowed, out]);
  }
});

test('受限进程：超时会真的结束，并标 timedOut', async () => {
  const root = sandboxDir();
  const allowed = join(root, 'allowed');
  const out = join(root, 'out');
  mkdirSync(allowed, { recursive: true });

  try {
    ensureLowLabel(allowed);

    const result = await spawnConfined({
      file: POWERSHELL,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'],
      cwd: allowed,
      outputDir: out,
      timeoutMs: 1_500,
    });

    assert.equal(result.timedOut, true);
    assert.ok(result.ms < 20_000, `超时返回太晚：${result.ms}ms`);
  } finally {
    cleanup(root, [allowed, out]);
  }
});
