import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

/**
 * 回归守卫：**正文必须边生成边到达**。
 *
 * 事故背景（2026-11-07）：为了让"维护类工具"的输出不进聊天，主循环曾经用
 * 「注册表里有没有 maintenance 通道的工具」决定是否缓冲正文。而生产路径
 * `createDefaultRegistry(db)` 一定会注册 `memory_read`/`memory_propose`，
 * 于是判据恒为真 ⇒ **所有档位、所有步骤**的正文都被压到步末才吐出（实测首字 11ms → 618ms）。
 *
 * 这个测试用**闸门**而不是计时来钉它：假模型吐第一个字后就等闸门，
 * 只有当消费者真的收到了这个字，闸门才会打开。若正文被缓冲，就永远打不开 ⇒ 超时失败。
 */

function makeWorld(): { dir: string; db: ReturnType<typeof openDatabase>; conversationId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-stream-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const provider = insertProvider(db, { name: 'p', baseUrl: 'http://127.0.0.1:1/v1' });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'm', permissionMode: 'full' });
  return { dir, db, conversationId: conversation.id };
}

test('生产注册表（含 memory 工具）下，正文仍然流式到达', async () => {
  const { dir, db, conversationId } = makeWorld();
  const registry = createDefaultRegistry(db); // ★ 关键：带 db，memory 工具会被注册
  assert.ok(
    registry.list().some((tool) => tool.definition.displayChannel === 'maintenance'),
    '前提不成立：这个注册表里没有 maintenance 通道的工具，测不到要守的东西',
  );

  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  const provider: Provider = {
    id: 'fake',
    async *stream(_request: ChatRequest): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: '甲' };
      await gate; // ← 只有消费者收到「甲」之后才放行
      yield { type: 'text', delta: '乙' };
      yield { type: 'finish', reason: 'stop' };
    },
  };

  let firstTextAt: number | null = null;
  const started = Date.now();
  const watchdog = setTimeout(() => openGate(), 3000); // 防止测试自己挂死

  try {
    for await (const event of runTurn({
      db,
      conversationId,
      userText: 'hi',
      provider,
      tools: registry,
      signal: new AbortController().signal,
      workspacePath: dir,
    })) {
      if (event.type === 'text' && firstTextAt === null) {
        firstTextAt = Date.now() - started;
        openGate(); // 收到就放行，含缓冲的实现永远走不到这里
      }
    }
  } finally {
    clearTimeout(watchdog);
  }

  assert.notEqual(firstTextAt, null, '正文被缓冲了：整个回合结束前一个 text 事件都没收到');
  assert.ok(firstTextAt! < 1500, `首字太晚（${firstTextAt}ms），说明正文被压到步末才放出`);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('调用维护类工具的那一步：后续正文不再实时透出，且消息标成 maintenance', async () => {
  const { dir, db, conversationId } = makeWorld();
  const registry = createDefaultRegistry(db);

  const provider: Provider = {
    id: 'fake',
    async *stream(): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: '先查一下记忆。' };
      yield { type: 'tool_call', index: 0, id: 'c1', name: 'memory_read', argsDelta: '{}' };
      yield { type: 'text', delta: '（这段不该实时出现）' };
      yield { type: 'finish', reason: 'stop' };
    },
  };

  const streamed: string[] = [];
  const channels: Array<string | undefined> = [];
  for await (const event of runTurn({
    db,
    conversationId,
    userText: 'hi',
    provider,
    tools: registry,
    signal: new AbortController().signal,
    workspacePath: dir,
  })) {
    if (event.type === 'text') streamed.push(event.delta);
    // 只统计第一步（后面几步是工具结果回灌后的续跑，与本次守卫无关）
    if (event.type === 'assistant' && channels.length === 0) {
      channels.push((event.message as unknown as { displayChannel?: string }).displayChannel);
    }
  }

  assert.equal(streamed[0], '先查一下记忆。', '维护调用**之前**的正文必须照常流式');
  assert.equal(
    streamed.includes('（这段不该实时出现）'),
    false,
    `维护调用之后的正文不该实时透出，实际收到：${JSON.stringify(streamed)}`,
  );
  assert.equal(channels[0], 'maintenance', '这一步应当被标成 maintenance 通道');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
