import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider, listMessages } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { ToolRegistry, type ToolDefinition } from '../../src/core/tools/types.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

/**
 * A1（`conclude` 语义）+ A2（抖动签名规范化）的**行为**判据。
 *
 * ★ 这两条都是"没有步数上限时凭什么停"的一部分（`D1@L585` 前提 1）。
 *   A1 让**工具**能宣告完成（不靠模型自愿闭嘴）；
 *   A2 让空转守卫真的数得到重复（原来换个参数顺序就绕过去了）。
 *   所以这里的断言全是**可观察行为**：跑几轮请求、看 finalReason、看请求条数。
 */

type Captured = { requests: ChatRequest[] };

function fakeProvider(script: ChatEvent[][], captured: Captured): Provider {
  return {
    id: 'fake',
    async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      captured.requests.push(req);
      const events = script.shift() ?? [{ type: 'finish', reason: 'stop' }];
      for (const event of events) yield event;
    },
  };
}

/** 一次工具调用事件 */
function toolCall(name: string, args: unknown, id = `call-${name}`): ChatEvent[] {
  return [
    {
      type: 'tool_call',
      index: 0,
      id,
      name,
      // ★ 线上事件用的是 `argsDelta`（流式增量），不是 `arguments`
      argsDelta: JSON.stringify(args),
    },
    { type: 'finish', reason: 'tool_calls' },
  ];
}

function withDb(run: (db: ReturnType<typeof openDatabase>) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alkaid-conclude-'));
    const db = openDatabase(join(dir, 'test.db'));
    migrate(db);
    try {
      await run(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function registryWith(conclude: boolean, calls: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  const tool: ToolDefinition = {
    name: 'finish_job',
    description: '干完了',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    modes: ['full'],
    async execute() {
      calls.push('finish_job');
      return { ok: true as const, content: '已完成', ...(conclude ? { conclude: true as const } : {}) };
    },
  };
  registry.register(tool);
  return registry;
}

async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

test('★★ A1：工具返回 conclude ⇒ 本轮立刻以 completed 收轮，**不再追加模型请求**', withDb(async (db) => {
  const providerRow = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
  const conversation = insertConversation(db, { providerId: providerRow.id, model: 'm', permissionMode: 'full' });
  const calls: string[] = [];
  const captured: Captured = { requests: [] };

  // 假模型：第一步调工具（它自己没打算停），脚本给足 5 步 —— 若 conclude 不生效会继续跑
  const provider = fakeProvider(
    [
      toolCall('finish_job', {}, 'c1'),
      toolCall('finish_job', {}, 'c2'),
      toolCall('finish_job', {}, 'c3'),
    ],
    captured,
  );

  const events = await collect(
    runTurn({
      db,
      conversationId: conversation.id,
      userText: '把这个活干完',
      provider,
      signal: new AbortController().signal,
      tools: registryWith(true, calls),
    }),
  );

  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'completed' });
  assert.equal(captured.requests.length, 1, 'conclude 之后不该再发模型请求（每多发一次都是钱）');
  assert.deepEqual(calls, ['finish_job']);

  // ★ 顺序判据：tool 消息必须**先落库**再收轮。否则下一轮请求里会出现
  //   「assistant 带 tool_calls 却没有 tool 回复」⇒ 上游必 400（2026-11-08 真事故）。
  const rows = listMessages(db, conversation.id);
  const assistant = rows.find((row) => row.role === 'assistant' && (row.toolCalls?.length ?? 0) > 0);
  assert.ok(assistant !== undefined, '没有落库的 assistant(tool_calls)');
  const reply = rows.find((row) => row.role === 'tool' && row.toolCallId === 'c1');
  assert.ok(reply !== undefined, 'conclude 收轮时把工具结果吞掉了 —— 这会让下一轮请求 400');
}));

test('★ A1：工具**不**宣告 conclude ⇒ 照旧继续（不能把正常的多步工作误杀）', withDb(async (db) => {
  const providerRow = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
  const conversation = insertConversation(db, { providerId: providerRow.id, model: 'm', permissionMode: 'full' });
  const calls: string[] = [];
  const captured: Captured = { requests: [] };

  const provider = fakeProvider(
    [
      toolCall('finish_job', {}, 'a'),
      toolCall('finish_job', {}, 'b'),
      // 第三步：不再调工具，自然收敛
      [{ type: 'text', delta: '好了' }, { type: 'finish', reason: 'stop' }],
    ],
    captured,
  );

  const events = await collect(
    runTurn({
      db,
      conversationId: conversation.id,
      userText: '慢慢做',
      provider,
      signal: new AbortController().signal,
      tools: registryWith(false, calls),
    }),
  );

  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  assert.equal(captured.requests.length, 3, '没 conclude 就该继续跑完三步');
  assert.deepEqual(calls, ['finish_job', 'finish_job']);
}));

test('★ A1：同一批里有多个 call ⇒ 全部执行完才收轮（中途 break 会造成"有调用没回复"）', withDb(async (db) => {
  const providerRow = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
  const conversation = insertConversation(db, { providerId: providerRow.id, model: 'm', permissionMode: 'full' });
  const calls: string[] = [];
  const captured: Captured = { requests: [] };

  const registry = registryWith(true, calls);
  registry.register({
    name: 'other_job',
    description: '另一件事',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    modes: ['full'],
    async execute() {
      calls.push('other_job');
      return { ok: true as const, content: 'ok' };
    },
  });

  // 一批两个 call：第一个 conclude，第二个不是
  const provider = fakeProvider(
    [
      [
        { type: 'tool_call', index: 0, id: 'k1', name: 'finish_job', argsDelta: '{}' },
        { type: 'tool_call', index: 1, id: 'k2', name: 'other_job', argsDelta: '{}' },
        { type: 'finish', reason: 'tool_calls' },
      ],
    ],
    captured,
  );

  const events = await collect(
    runTurn({
      db,
      conversationId: conversation.id,
      userText: '两件事',
      provider,
      signal: new AbortController().signal,
      tools: registry,
    }),
  );

  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'completed' });
  assert.deepEqual(calls.sort(), ['finish_job', 'other_job'], '同批的第二个 call 被 conclude 吞掉了');

  const rows = listMessages(db, conversation.id);
  for (const id of ['k1', 'k2']) {
    assert.ok(rows.some((row) => row.role === 'tool' && row.toolCallId === id), `call ${id} 没有落库回复`);
  }
}));

/**
 * ★★ A2：参数只换字段顺序 ⇒ 守卫**必须认得出这是重复**。
 *
 * ★ 注意这条的判据在 A4 之后变过一次，值得记下来：
 *   A4 把"第 3 次硬停"改成"第 3 次插提醒、第 9 次才停"，所以**不能再靠"第 3 次就 error"
 *   来证明 A2 生效** —— 那会让 A2 的测试与 A4 的设计互相打架（我在这一轮真撞上了）。
 *   ⇒ 改成直接断言**可观察的产物**：第 4 步的请求末尾出现了那句「连续 N 次」提醒。
 *     它只可能来自 `repeats` 计数 —— 而计数只可能在签名相同的时候增长。
 *
 *   反证："旧签名绕过了守卫"这一点由 `canonical-signature.test.ts` 里的
 *   "旧写法确实得到两个不同串"钉住，不在这里重复。
 */
test('★★ A2：参数只换字段顺序 ⇒ 守卫仍认得出重复（第 4 步请求里出现提醒）', withDb(async (db) => {
  const providerRow = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
  const conversation = insertConversation(db, { providerId: providerRow.id, model: 'm', permissionMode: 'full' });
  const captured: Captured = { requests: [] };

  // 三步都在读同一个文件，只是参数书写顺序每次不同 —— 语义上完全是重复调用
  const orders = ['{"path":"a.txt","limit":10}', '{"limit":10,"path":"a.txt"}', '{"path":"a.txt","limit":10}'];
  const script: ChatEvent[][] = [
    ...orders.map((args, index): ChatEvent[] => [
      { type: 'tool_call', index: 0, id: `r${String(index)}`, name: 'read', argsDelta: args },
      { type: 'finish', reason: 'tool_calls' },
    ]),
    // 第 4 步自然收敛，让本轮结束（不靠熔断）
    [{ type: 'text', delta: '换个做法' }, { type: 'finish', reason: 'stop' }],
  ];

  const registry = new ToolRegistry();
  registry.register({
    name: 'read',
    description: '读文件',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    modes: ['full'],
    async execute() {
      return { ok: true as const, content: '内容' };
    },
  });

  await collect(
    runTurn({
      db,
      conversationId: conversation.id,
      userText: '读一下',
      provider: fakeProvider(script, captured),
      signal: new AbortController().signal,
      tools: registry,
    }),
  );

  assert.equal(captured.requests.length, 4, '应该跑到第 4 步');
  const tail = captured.requests[3]?.messages.at(-1);
  assert.equal(tail?.role, 'user');
  assert.match(
    String(tail?.content),
    /连续/,
    '换参数顺序就绕过了空转守卫 —— 第 4 步请求里没有提醒，说明 repeats 根本没涨（这正是 A2 要修的 bug）',
  );
  assert.match(String(tail?.content), /运行时提醒/, '提醒必须标明不是用户发言');
}));
