import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import {
  claimPendingInputs,
  clearPendingInputs,
  countPendingInputs,
  queueInput,
  renderPendingInputs,
} from '../../src/core/agent/steering.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider, listMessages } from '../../src/core/store/repo.ts';
import { SCHEMA_VERSION, migrate } from '../../src/core/store/schema.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

/**
 * A3 steering 通道（`D1@L638`）。
 *
 * 判据只有一句话，但要分几层钉：**运行时提醒可以进"请求"，绝不能进"历史"**。
 *
 * 为什么这么严：本项目的核心承诺是"库里原文逐字不变"。一条 AI 自己写的
 * `role='user'` 落库之后，`recall` 会把它当成用户真的说过的话回读、
 * 导出会带上它、下轮压缩会把它当用户意图写进摘要 —— 从此再也分不清。
 * `D1@L637`（A2）把这条明确列为反模式。
 */

function withDb(run: (db: ReturnType<typeof openDatabase>, dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alkaid-steering-'));
    const db = openDatabase(join(dir, 'test.db'));
    migrate(db);
    try {
      await run(db, dir);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function withConversation(db: ReturnType<typeof openDatabase>): string {
  const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
  return insertConversation(db, { providerId: provider.id, model: 'm' }).id;
}

// ───────────────────────── 表与语义 ─────────────────────────

test('★ v14 建了 pending_inputs 表（schema 版本现在由迁移清单推导）', withDb(async (db) => {
  // ★ 不再断言"等于 14"：SCHEMA_VERSION 已改成从 MIGRATIONS 推导（防止手写常量与
  //   迁移清单漂移 —— 这个坑 2026-11-10 真踩过），后续加迁移会让它继续变大。
  assert.ok(SCHEMA_VERSION >= 14, 'pending_inputs 从 v14 开始存在');
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_inputs'")
    .get() as { name: string } | undefined;
  assert.ok(row !== undefined, 'v14 该建 pending_inputs 表');
}));

test('★★ 一条只能领一次（否则每步重复注入同一句提醒，模型会把重复当强调）', withDb(async (db) => {
  const conversationId = withConversation(db);
  queueInput(db, { conversationId, source: 'repeat-tool-reminder', content: '换个做法' });

  const first = claimPendingInputs(db, conversationId, 1);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.content, '换个做法');

  const second = claimPendingInputs(db, conversationId, 2);
  assert.deepEqual(second, [], '同一条被领了第二次');

  // 但消费之后计数要归零，且不影响之后再排新的
  assert.equal(countPendingInputs(db, conversationId), 0);
  queueInput(db, { conversationId, source: 'system-note', content: '第二条' });
  assert.equal(claimPendingInputs(db, conversationId, 3).length, 1);
}));

test('★ 按入队顺序领取（顺序是语义：先提醒"注意"，再提醒"停手"）', withDb(async (db) => {
  const conversationId = withConversation(db);
  queueInput(db, { conversationId, source: 'system-note', content: 'A' });
  queueInput(db, { conversationId, source: 'system-note', content: 'B' });
  const claimed = claimPendingInputs(db, conversationId, 1);
  assert.deepEqual(claimed.map((item) => item.content), ['A', 'B']);
}));

test('★ 不同会话互不串台', withDb(async (db) => {
  const a = withConversation(db);
  const b = withConversation(db);
  queueInput(db, { conversationId: a, source: 'system-note', content: '只给 A' });

  assert.equal(countPendingInputs(db, b), 0);
  assert.deepEqual(claimPendingInputs(db, b, 1), []);
  assert.equal(claimPendingInputs(db, a, 1).length, 1);
}));

test('★★ 渲染必须标明来源：系统提醒不能说成"用户说的"', () => {
  const asUser = renderPendingInputs([
    { id: '1', conversationId: 'c', source: 'user', content: '顺便看下日志', createdAt: '' },
  ]);
  assert.match(String(asUser), /用户/);

  const asSystem = renderPendingInputs([
    { id: '2', conversationId: 'c', source: 'repeat-tool-reminder', content: '换个做法', createdAt: '' },
  ]);
  assert.match(String(asSystem), /运行时提醒/);
  assert.match(String(asSystem), /不是用户发言/);
  assert.notEqual(asUser, asSystem, '两种来源必须渲染成不同的话，否则模型分不清该听谁的');
});

test('★ 空列表渲染成 null（不是空串，避免往请求里塞一条空消息）', () => {
  assert.equal(renderPendingInputs([]), null);
});

test('★ 校验：空内容 / 超长 / 缺 source 都拒绝', withDb(async (db) => {
  const conversationId = withConversation(db);
  assert.throws(() => queueInput(db, { conversationId, source: 'system-note', content: '   ' }), /不能为空/);
  assert.throws(() => queueInput(db, { conversationId, source: 'system-note', content: 'x'.repeat(2001) }), /过长/);
  assert.throws(() => queueInput(db, { conversationId, source: '', content: 'x' }), /source 必填/);
}));

test('★ clearPendingInputs 只清未消费的', withDb(async (db) => {
  const conversationId = withConversation(db);
  queueInput(db, { conversationId, source: 'system-note', content: 'A' });
  queueInput(db, { conversationId, source: 'system-note', content: 'B' });
  claimPendingInputs(db, conversationId, 1); // 两条都领掉
  queueInput(db, { conversationId, source: 'system-note', content: 'C' });

  assert.equal(clearPendingInputs(db, conversationId), 1);
  assert.equal(countPendingInputs(db, conversationId), 0);
}));

// ───────────────────────── 与主循环的接线 ─────────────────────────

test('★★ 接线：排一条输入 ⇒ 下一步请求的末尾能看到它，且**不进消息表**', withDb(async (db) => {
  const conversationId = withConversation(db);
  const requests: ChatRequest[] = [];
  let queued = false;

  const provider: Provider = {
    id: 'fake',
    async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      requests.push(req);
      if (!queued) {
        queued = true;
        // 第一步跑的同时，外部排一条输入
        queueInput(db, { conversationId, source: 'user', content: '顺便把日志也看一下' });
      }
      yield { type: 'text', delta: '好' };
      yield { type: 'finish', reason: 'stop' };
    },
  };

  const events: TurnEvent[] = [];
  for await (const event of runTurn({
    db,
    conversationId,
    userText: '开始',
    provider,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }

  // 第一条请求发出时它还没入队，所以只有一条请求 —— 这里改排"下一个 turn"来验
  assert.equal(requests.length, 1);

  // 再跑一轮：这次入队的输入必须在**第一条**请求里就出现
  const second: ChatRequest[] = [];
  const provider2: Provider = {
    id: 'fake2',
    async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      second.push(req);
      yield { type: 'text', delta: '看到了' };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  for await (const event of runTurn({
    db,
    conversationId,
    userText: '继续',
    provider: provider2,
    signal: new AbortController().signal,
  })) {
    void event;
  }

  const tail = second[0]?.messages.at(-1);
  assert.equal(tail?.role, 'user');
  assert.match(String(tail?.content), /顺便把日志也看一下/);

  // ★ 关键：消息表里仍然只有两条真人发言（开始 / 继续），没有被注入的内容
  const users = listMessages(db, conversationId).filter((row) => row.role === 'user');
  assert.deepEqual(
    users.map((row) => row.content),
    ['开始', '继续'],
    '注入的内容进了消息表 —— 那会污染 recall 与导出的逐字原文',
  );
}));
