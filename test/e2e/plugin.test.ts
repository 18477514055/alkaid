import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { PluginHost } from '../../src/core/plugin/host.ts';
import { rootsFor } from '../../src/core/policy/roots.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { ToolContext } from '../../src/core/tools/types.ts';
import type { ChatEvent } from '../../src/shared/types.ts';

/**
 * §11 测试六：插件独立性。
 *
 * 三条要求（任务书原文）：
 * ① 加载一个测试插件，验证工具注册；
 * ② 禁用插件后，核心聊天仍然正常；
 * ③ 模拟插件异常，确认不会导致整个 Agent 崩溃。
 *
 * ★ 这里是真的 spawn 子进程跑 `plugins/demo-echo`，不是模拟。
 */

const PLUGINS_DIR = join(import.meta.dirname, '..', '..', 'plugins');

function makeContext(): ToolContext {
  const tempDir = mkdtempSync(join(tmpdir(), 'alkaid-plugin-'));
  return {
    conversationId: 'c1',
    permissionMode: 'full',
    roots: rootsFor('full', null, null),
    workspacePath: null,
    projectSharedDir: null,
    cwd: tempDir,
    tempDir,
    signal: new AbortController().signal,
  };
}

test('§11 测试六①：插件加载后工具注册进表，且只在完全权限档可见', async () => {
  const registry = createDefaultRegistry();
  const host = new PluginHost({ dir: PLUGINS_DIR, registry });

  try {
    const plugins = await host.loadAll();
    const demo = plugins.find((plugin) => plugin.id === 'demo-echo');
    assert.ok(demo !== undefined, '没有加载到 demo-echo');
    assert.equal(demo.status, 'ready', `插件没就绪：${demo.error ?? ''}`);
    assert.ok(demo.toolNames.includes('p_demo-echo_echo'), `工具没注册：${demo.toolNames.join(',')}`);

    const fullTools = registry.toProviderTools('full').map((tool) => tool.name);
    assert.ok(fullTools.includes('p_demo-echo_echo'));

    // ★ 插件拥有宿主权限 ⇒ 只在完全权限档可见
    for (const mode of ['readonly', 'workspace', 'project', 'workspace_project'] as const) {
      const names = registry.toProviderTools(mode).map((tool) => tool.name);
      assert.ok(!names.some((name) => name.startsWith('p.')), `${mode} 档不该看到插件工具`);
    }

    const ctx = makeContext();
    const result = await registry.execute('p_demo-echo_echo', { text: '你好' }, ctx);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.content, 'echo: 你好');
    rmSync(ctx.tempDir, { recursive: true, force: true });
  } finally {
    await host.dispose();
  }
});

test('§11 测试六②：禁用插件后工具消失，重新启用又回来', async () => {
  const registry = createDefaultRegistry();
  const host = new PluginHost({ dir: PLUGINS_DIR, registry });

  try {
    await host.loadAll();
    assert.equal(registry.has('p_demo-echo_echo'), true);

    await host.setEnabled('demo-echo', false);
    assert.equal(registry.has('p_demo-echo_echo'), false, '禁用后工具还在表里');
    const afterDisable = host.list().find((plugin) => plugin.id === 'demo-echo');
    assert.equal(afterDisable?.status, 'disabled');

    const ctx = makeContext();
    const denied = await registry.execute('p_demo-echo_echo', { text: 'x' }, ctx);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, 'tool_not_found');
    rmSync(ctx.tempDir, { recursive: true, force: true });

    await host.setEnabled('demo-echo', true);
    assert.equal(registry.has('p_demo-echo_echo'), true, '重新启用后工具没回来');
  } finally {
    await host.dispose();
  }
});

test('§11 测试六③：插件崩溃只让它的工具失效，核心聊天照常', async () => {
  const registry = createDefaultRegistry();
  const host = new PluginHost({ dir: PLUGINS_DIR, registry });
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-plugin-core-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);

  try {
    await host.loadAll();

    const ctx = makeContext();
    const boom = await registry.execute('p_demo-echo_boom', {}, ctx);
    assert.equal(boom.ok, false, 'boom 居然成功了');
    if (!boom.ok) {
      assert.equal(boom.code, 'plugin_crashed');
      assert.ok((boom.hint ?? '').length > 0, '拒绝/失败必须给出可行动提示');
    }
    rmSync(ctx.tempDir, { recursive: true, force: true });

    // 崩溃之后：插件状态是 failed，工具从表里消失
    const afterCrash = host.list().find((plugin) => plugin.id === 'demo-echo');
    assert.equal(afterCrash?.status, 'failed');
    assert.equal(registry.has('p_demo-echo_echo'), false, '崩溃后工具没被摘掉');

    // ★ 核心聊天仍然可用：完整跑一轮对话
    const providerRow = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: providerRow.id, model: 'm' });
    const fake: Provider = {
      id: 'fake',
      async *stream(): AsyncGenerator<ChatEvent> {
        yield { type: 'text', delta: '插件崩了但我还在。' };
        yield { type: 'finish', reason: 'stop' };
      },
    };

    const events: TurnEvent[] = [];
    for await (const event of runTurn({
      db,
      conversationId: conversation.id,
      userText: '还在吗',
      provider: fake,
      signal: new AbortController().signal,
      tools: registry,
    })) {
      events.push(event);
    }

    const text = events
      .filter((event): event is Extract<TurnEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.delta)
      .join('');
    assert.equal(text, '插件崩了但我还在。');
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  } finally {
    await host.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
