import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PluginHost } from '../../src/core/plugin/host.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';

/**
 * ★★ 「在界面上关掉插件，重启后又活了」—— 阶段一第 5 条的真问题。
 *
 * 旧实现：`setEnabled()` 只改内存里的 `runtime.status` / `runtime.error`，
 * 而 `loadAll()` 读的是 `plugin.json` 里的 `enabled`。
 * ⇒ 用户在插件页点了「停用」，界面回 200、工具也确实摘掉了，
 *   但**关掉窗口再打开，那个插件带着完整宿主权限又起来了** —— 而且是静默的。
 *
 * 这组测试钉住的判据只有一条：**"停用"必须活过一次重启**（这里是新建一个 host 实例）。
 * 顺带钉住反方向：重新启用之后也要活过重启（不然就只有半个功能）。
 */

const SDK_DIR = join(import.meta.dirname, '..', '..', 'plugins', '_sdk');

/** 造一个临时的插件目录（复制一份 demo-echo）+ 一个能跑的最小插件 */
function makePluginDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-plugin-persist-'));
  mkdirSync(join(dir, '_sdk'), { recursive: true });
  copyFileSync(join(SDK_DIR, 'plugin.ts'), join(dir, '_sdk', 'plugin.ts'));

  mkdirSync(join(dir, 'demo-echo'), { recursive: true });
  writeFileSync(
    join(dir, 'demo-echo', 'plugin.json'),
    `${JSON.stringify({ id: 'demo-echo', name: '演示插件', entry: 'index.ts', enabled: true }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'demo-echo', 'index.ts'),
    [
      "import { definePlugin } from '../_sdk/plugin.ts';",
      'definePlugin({',
      "  name: 'demo-echo',",
      "  tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: {}, additionalProperties: false },",
      '    run: (args) => `echo: ${JSON.stringify(args)}` }],',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('★★ 停用一个插件 ⇒ 清单真的被改写，**新建的 host 也认这个决定**（重启不复活）', async () => {
  const { dir, cleanup } = makePluginDir();
  try {
    // 第一次"启动"
    const first = new PluginHost({ dir, registry: createDefaultRegistry() });
    try {
      const loaded = await first.loadAll();
      assert.equal(loaded.find((plugin) => plugin.id === 'demo-echo')?.status, 'ready');

      await first.setEnabled('demo-echo', false);
      assert.equal(first.list().find((plugin) => plugin.id === 'demo-echo')?.status, 'disabled');
    } finally {
      await first.dispose();
    }

    // ★ 关键断言：**磁盘上**的清单变了（不是只改了内存）
    const onDisk = JSON.parse(readFileSync(join(dir, 'demo-echo', 'plugin.json'), 'utf8')) as { enabled?: boolean };
    assert.equal(onDisk.enabled, false, '清单没被改写 —— 重启后插件会复活');

    // 第二次"启动"（模拟关掉窗口再打开）
    const second = new PluginHost({ dir, registry: createDefaultRegistry() });
    try {
      const loaded = await second.loadAll();
      const demo = loaded.find((plugin) => plugin.id === 'demo-echo');
      assert.equal(demo?.status, 'disabled', '重启后插件又活了');
      // 停用的插件不该起进程、也不该注册工具
      assert.deepEqual(demo?.toolNames, []);
    } finally {
      await second.dispose();
    }
  } finally {
    cleanup();
  }
});

test('★★ 重新启用也活过重启（否则只有半个功能）', async () => {
  const { dir, cleanup } = makePluginDir();
  try {
    const first = new PluginHost({ dir, registry: createDefaultRegistry() });
    try {
      await first.loadAll();
      await first.setEnabled('demo-echo', false);
      await first.setEnabled('demo-echo', true);
    } finally {
      await first.dispose();
    }

    const onDisk = JSON.parse(readFileSync(join(dir, 'demo-echo', 'plugin.json'), 'utf8')) as { enabled?: boolean };
    assert.equal(onDisk.enabled, true);

    const second = new PluginHost({ dir, registry: createDefaultRegistry() });
    try {
      const loaded = await second.loadAll();
      assert.equal(loaded.find((plugin) => plugin.id === 'demo-echo')?.status, 'ready');
    } finally {
      await second.dispose();
    }
  } finally {
    cleanup();
  }
});

test('★ 清单写坏（半截 JSON）⇒ 停用**报错**，而不是悄悄回 200 却没保存', async () => {
  const { dir, cleanup } = makePluginDir();
  try {
    const registry = createDefaultRegistry();
    const host = new PluginHost({ dir, registry });
    try {
      await host.loadAll();

      // 模拟"用户手改到一半"或"磁盘写到一半"：把清单改成非法 JSON
      const path = join(dir, 'demo-echo', 'plugin.json');
      const broken = '{"id": "demo-echo", "entry": "index.ts", "enabled": tr';
      writeFileSync(path, broken, 'utf8');

      await assert.rejects(() => host.setEnabled('demo-echo', false), /清单写入失败/);
      // 用户手改的原文一个字都不能被吃掉
      assert.equal(readFileSync(path, 'utf8'), broken);
      // 但内存里的状态是对的：插件确实停了（否则用户以为关掉了、实际还在跑）
      assert.equal(host.list().find((plugin) => plugin.id === 'demo-echo')?.status, 'disabled');
    } finally {
      await host.dispose();
    }
  } finally {
    cleanup();
  }
});
