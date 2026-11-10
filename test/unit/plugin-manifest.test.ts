import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ManifestParseError, setManifestEnabled, withFileLock, writeJsonAtomic } from '../../src/core/plugin/manifest.ts';

/**
 * 插件清单的原子写 + 锁（阶段一第 5 条）。
 *
 * ★ 这条的起点不是"改一半断电会损坏"，而是一个**更日常**的 bug：
 *   `setEnabled()` 只改内存里的 `runtime.status`，`loadAll()` 读的却是 `plugin.json`
 *   的 `enabled` ⇒ **在界面上关掉的插件，重启后又活了**。
 *   一次关窗口、一次断电，用户的决定就没了。
 *   所以要原子写之前，先得有"写"。这里钉住四件事：
 *   ① 写进去能读回来（真的落盘了）；
 *   ② 写的**不是**半截文件（`.tmp` + rename，进程内没有中间态可被读到）；
 *   ③ 清单坏了**不许覆盖**（宁可报错，也不要拿"我理解的结构"吃掉"我读不懂的结构"）；
 *   ④ 锁拿不到会超时报错，残留锁会被清掉（否则那个插件从此改不了 enabled）。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'alkaid-manifest-'));
}

const MANIFEST = {
  id: 'demo',
  name: '演示',
  entry: 'index.ts',
  enabled: true,
};

test('★ 原子写：内容真的落盘，且不留 .tmp 残留', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'plugin.json');
    writeJsonAtomic(path, MANIFEST);

    const readBack = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(readBack['id'], 'demo');
    assert.equal(readBack['enabled'], true);

    // 目录里除了 plugin.json 不该有别的东西（.tmp 必须被 rename 掉）
    assert.deepEqual(readdirSync(dir), ['plugin.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 原子写：JSON 里的中文不会被写坏（UTF-8 无 BOM）', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'plugin.json');
    writeJsonAtomic(path, MANIFEST);
    const bytes = readFileSync(path);
    // 无 BOM
    assert.notEqual(bytes[0], 0xef);
    const text = bytes.toString('utf8');
    assert.ok(text.includes('演示'), '中文被写坏了');
    assert.ok(text.includes('锟') === false, '出现了替换字符');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ setManifestEnabled：改 enabled 且**不动其他字段**', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'plugin.json');
    // 故意多带一个未来字段 —— 它必须原样活下来（不然以后加字段就被吃掉）
    writeFileSync(path, JSON.stringify({ ...MANIFEST, futureField: 'keep-me' }, null, 2), 'utf8');

    await setManifestEnabled(path, false);

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(after['enabled'], false);
    assert.equal(after['futureField'], 'keep-me', '未涉及的字段被吃掉了');
    assert.equal(after['id'], 'demo');
    assert.equal(after['entry'], 'index.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 清单坏了（半截 JSON）⇒ 拒绝写，并抛 ManifestParseError（不许覆盖）', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'plugin.json');
    const broken = '{"id": "demo", "entry": "index.ts", "enabled": tr';
    writeFileSync(path, broken, 'utf8');

    await assert.rejects(
      () => setManifestEnabled(path, false),
      (error: unknown) => error instanceof ManifestParseError,
    );
    // 原文一个字都不能动 —— 用户手改到一半的内容是唯一副本
    assert.equal(readFileSync(path, 'utf8'), broken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ withFileLock：并发拿同一把锁必须排队，不能同时进门', async () => {
  const dir = tempDir();
  try {
    const lockPath = join(dir, 'x.lock');
    const events: string[] = [];
    let inside = 0;
    let maxInside = 0;

    const job = (tag: string): Promise<void> =>
      withFileLock(lockPath, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        events.push(`enter ${tag}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push(`exit ${tag}`);
        inside -= 1;
      });

    await Promise.all([job('a'), job('b')]);
    assert.equal(maxInside, 1, '两个任务同时进了临界区（锁没起作用）');
    assert.equal(events.length, 4);
    // 锁释放后不该留下文件
    assert.equal(existsSync(lockPath), false, '锁文件没被释放');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ withFileLock：残留锁（上次进程被强杀）会被清掉，不是永久卡死', async () => {
  const dir = tempDir();
  try {
    const lockPath = join(dir, 'stale.lock');
    writeFileSync(lockPath, '', 'utf8');
    // 把 mtime 推到很久以前 —— 模拟"上次进程已经死了"
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    let ran = false;
    await withFileLock(lockPath, () => {
      ran = true;
    });
    assert.equal(ran, true, '残留锁把正常的写永久挡住了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ withFileLock：fn 抛错时锁也必须释放（否则一次失败毁掉这个插件）', async () => {
  const dir = tempDir();
  try {
    const lockPath = join(dir, 'err.lock');
    await assert.rejects(
      () =>
        withFileLock(lockPath, () => {
          throw new Error('写的时候炸了');
        }),
      /炸了/,
    );

    assert.equal(existsSync(lockPath), false, '抛错路径上锁没释放');
    // 还能再拿到
    let ok = false;
    await withFileLock(lockPath, () => {
      ok = true;
    });
    assert.equal(ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
