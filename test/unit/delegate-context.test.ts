import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { setSecret } from '../../src/core/secrets.ts';
import { createDelegateTool } from '../../src/core/agent/delegate-tool.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { ToolContext } from '../../src/core/tools/types.ts';
import type { TurnEvent } from '../../src/core/agent/loop.ts';

/**
 * ★ 审计 `CRITICAL-02`：`delegate` 真的把**工具面与目录**交给子代理了吗？
 *
 * 原来 `delegate-tool` 调 `runner` 时只传了 db / conversationId / userText / provider / signal / maxSteps，
 * `options.tools` 是 undefined ⇒ `runTurn` 里 `createSurface` 不建 ⇒ **子代理零工具**，
 * 工作区与项目目录也全是空。症状是"派出去的活什么也没干"，而界面上看不出异常。
 *
 * 为什么以前的测试没抓到：全都注入了假 runner，且只断言"没继承父历史"。
 * 这条测试用**捕获型 runner** 直接检查它收到的入参。
 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-delegate-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });
  setSecret(join(home, 'secrets.json'), provider.id, 'test-key-not-real');
  return { db, home, provider, conversation };
}

const ctxOf = (conversationId: string): ToolContext => ({
  conversationId,
  agentRole: 'main',
  permissionMode: 'workspace',
  roots: { readable: [], writable: [], anywhere: false },
  workspacePath: '/ws/demo',
  projectSharedDir: '/shared/demo',
  cwd: '.',
  tempDir: '/tmp/alkaid',
  signal: new AbortController().signal,
});

test('★★ delegate 传给子代理的 runner 入参里必须有 tools 与三个目录', async () => {
  const { db, home, conversation } = fixture();
  try {
    const registry = createDefaultRegistry(db);
    let captured: Record<string, unknown> | null = null;

    const tool = createDelegateTool(db, {
      secretsPath: join(home, 'secrets.json'),
      getTools: () => registry,
      // 只收参数、立刻结束（不起网、不烧钱）
      runner: (input) => {
        captured = input as unknown as Record<string, unknown>;
        return (async function* (): AsyncGenerator<TurnEvent> {
          yield { type: 'finish', reason: 'stop' } as TurnEvent;
        })();
      },
    });

    const result = await tool.execute({ task: '读一下 README', title: '读 README' }, ctxOf(conversation.id));
    assert.equal(result.ok, true, `委派应当成功：${JSON.stringify(result).slice(0, 200)}`);
    assert.ok(captured !== null, 'runner 没被调用');
    const input = captured as unknown as Record<string, unknown>;
    assert.ok(input['tools'] !== undefined, '子代理拿不到工具面（CRITICAL-02 回归）');
    assert.equal(input['workspacePath'], '/ws/demo');
    assert.equal(input['projectSharedDir'], '/shared/demo');
    assert.equal(input['tempDir'], '/tmp/alkaid');
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('★★ 子代理真的能用这些工具：read 在它的工具面里、delegate 不在', async () => {
  const { db, home, conversation } = fixture();
  try {
    const registry = createDefaultRegistry(db);
    const { createSurface } = await import('../../src/core/tools/runtime.ts');
    const { effectiveToolModes } = await import('../../src/core/tools/gate.ts');
    const surface = createSurface(registry, 'workspace', effectiveToolModes(db), 'subagent');
    assert.equal(surface.canCall('read'), true, '子代理没有 read —— 就是 CRITICAL-02 的症状');
    assert.equal(surface.canCall('delegate'), false, '子代理不能再派');
    void conversation;
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
