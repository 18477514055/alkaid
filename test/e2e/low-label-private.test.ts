import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLocalAuth } from '../../src/server/token.ts';

/**
 * ★ 2026-11-11 本机令牌任务 · task-6：防止 Low 进程经 junction 别名诱导
 *   Medium 宿主把私密目录的 NRNW 标签降成 Low 可读。
 *
 * 攻击形状（隔离实测成立）：前一次 shell 结束后，Low 进程把 tempDir 里某个
 * Low 可写段换成指向 local-auth-* 的 junction；下一次 ensureLowLabel 若跟随
 * junction，icacls (OI)(CI)Low 会把私密目录降成 Low，token/pair 变得 Low 可读。
 *
 * 这里的回归只断言「防护行为」：遇到 reparse point 段或私密域，打标签必须抛错，
 * 且事后私密文件仍只能 Medium 读（用标签写读断言，不打印秘密）。
 */

function makeJunction(target: string, link: string): void {
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
}

test('ensureLowLabel 拒绝任何 reparse point 段（junction 别名不可降标签）', { skip: process.platform !== 'win32' }, async () => {
  const { ensureLowLabel, clearLowLabel } = await import('../../src/core/sandbox/win32-confine.ts');
  const root = mkdtempSync(join(tmpdir(), 'alkaid-lowlabel-link-'));
  const real = join(root, 'real-sandbox');
  const aliasDir = join(root, 'alias-parent');
  mkdirSync(real, { recursive: true });
  mkdirSync(aliasDir, { recursive: true });
  const alias = join(aliasDir, 'shell-sandbox');
  try {
    makeJunction(real, alias); // alias -> real（中间段是 junction）
    assert.throws(
      () => ensureLowLabel(alias),
      /junction|符号链接|reparse/i,
      'junction 别名必须被拒，不能跟随它给真实目录打标签',
    );
    // 目标是 junction 本身，不经过跟随；真实目录没有被降标签。
    assert.ok(!existsSync(join(real, 'was-labelled')));
  } finally {
    clearLowLabel(real);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ensureLowLabel 拒绝私密目录本身及其祖先（继承标签不得波及 NRNW）', { skip: process.platform !== 'win32' }, async () => {
  const { ensureLowLabel, clearLowLabel } = await import('../../src/core/sandbox/win32-confine.ts');
  const root = mkdtempSync(join(tmpdir(), 'alkaid-lowlabel-private-'));
  const home = join(root, 'home');
  const out = join(root, 'output');
  mkdirSync(out, { recursive: true });
  const auth = createLocalAuth(home);
  try {
    // 私密目录本身
    assert.throws(() => ensureLowLabel(home), /私密域|private|本机令牌/i, '私密目录不得被降标签');
    // 私密目录的祖先（继承标签会波及 local-auth-*）
    assert.throws(() => ensureLowLabel(root), /私密域|private|本机令牌/i, '私密目录的祖先不得被降标签（继承会波及）');
  } finally {
    auth.close();
    clearLowLabel(out);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('clearLowLabel 拒绝进入私密域（恢复 Medium 也不得破坏 NRNW）', { skip: process.platform !== 'win32' }, async () => {
  const { clearLowLabel } = await import('../../src/core/sandbox/win32-confine.ts');
  const root = mkdtempSync(join(tmpdir(), 'alkaid-clearlabel-private-'));
  const home = join(root, 'home');
  const auth = createLocalAuth(home);
  try {
    // clearLowLabel 是尽力而为、失败不抛；这里只断言它不抛也不改变私密文件的 NRNW。
    assert.doesNotThrow(() => clearLowLabel(home));
    assert.doesNotThrow(() => clearLowLabel(root));
    // 私密文件仍在，且 Medium 宿主仍能读（说明标签未被破坏成不可读）。
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(auth.tokenPath, 'utf8'), auth.token);
  } finally {
    auth.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
