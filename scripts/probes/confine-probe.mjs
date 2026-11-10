// 验证：Low 完整性受限进程 —— 写标签目录能成、写别处被拒、输出能读回
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureLowLabel, spawnConfined } from '../../src/core/sandbox/win32-confine.ts';

const root = mkdtempSync(join(tmpdir(), 'alkaid-confine-'));
const allowed = join(root, 'allowed');
const denied = join(root, 'denied');
const outDir = join(root, 'out');
mkdirSync(allowed, { recursive: true });
mkdirSync(denied, { recursive: true });

ensureLowLabel(allowed);
console.log('[1] 已给 allowed 打 Low 标签');

const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const script = (path) =>
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Set-Content -LiteralPath '${path}' -Value 'x' -Encoding UTF8; Write-Output 'ok'`;

const inside = await spawnConfined({
  file: ps,
  args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script(join(allowed, 'a.txt'))],
  cwd: allowed,
  outputDir: outDir,
  timeoutMs: 20_000,
});
console.log('[2] write allowed ->', JSON.stringify({ code: inside.code, out: inside.stdout.trim(), err: inside.stderr.trim().slice(0, 200) }));
console.log('    file exists:', existsSync(join(allowed, 'a.txt')));

const outside = await spawnConfined({
  file: ps,
  args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script(join(denied, 'b.txt'))],
  cwd: allowed,
  outputDir: outDir,
  timeoutMs: 20_000,
});
console.log('[3] write denied  ->', JSON.stringify({ code: outside.code, out: outside.stdout.trim(), err: outside.stderr.trim().slice(0, 300) }));
console.log('    file exists:', existsSync(join(denied, 'b.txt')));

const timed = await spawnConfined({
  file: ps,
  args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'],
  cwd: allowed,
  outputDir: outDir,
  timeoutMs: 2_000,
});
console.log('[4] timeout       ->', JSON.stringify({ timedOut: timed.timedOut, ms: timed.ms }));

rmSync(root, { recursive: true, force: true });
