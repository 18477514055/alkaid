import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider, listMessages } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

/**
 * 主循环的行为测试。用假 provider（不进网络），重点验三件事：
 * ① system 提示里真的带上了工作区/共享目录
 * ② 工具调用的回绝是**可读的结构化 JSON**（不是一句 denied）
 * ③ 同样的调用连续 3 次会**先插提醒**（A4），到第 9 次才熔断
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

function withDb(run: (db: DatabaseSync) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-loop-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return (async () => {
    try {
      await run(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

async function collect(events: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const TOOL_CALL_EVENTS: ChatEvent[] = [
  { type: 'tool_call', index: 0, id: 'call_1', name: 'read', argsDelta: '{"path":"a.txt"}' },
  { type: 'finish', reason: 'tool_calls' },
];

test('system 提示里带着工作区与项目共享目录，且排在历史最前面', async () => {
  await withDb(async (db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    const captured: Captured = { requests: [] };
    const events = await collect(
      runTurn({
        db,
        conversationId: conversation.id,
        userText: '你好',
        provider: fakeProvider([[{ type: 'text', delta: '嗨' }, { type: 'finish', reason: 'stop' }]], captured),
        signal: new AbortController().signal,
        workspacePath: 'C:/work/demo',
        projectSharedDir: 'C:/data/projects/p1/shared',
      }),
    );

    const system = captured.requests[0]?.messages[0];
    assert.equal(system?.role, 'system');
    assert.match(String(system?.content), /C:\/work\/demo/);
    assert.match(String(system?.content), /C:\/data\/projects\/p1\/shared/);
    // 权限档的字面值必须出现在提示里（否则模型要猜）
    assert.match(String(system?.content), /workspace/);

    assert.equal(events.at(-1)?.type, 'finish');
  });
});

test('没有注册工具时，工具调用得到结构化回绝，然后模型继续说着陆', async () => {
  await withDb(async (db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    const captured: Captured = { requests: [] };
    const events = await collect(
      runTurn({
        db,
        conversationId: conversation.id,
        userText: '读一下 a.txt',
        provider: fakeProvider(
          [TOOL_CALL_EVENTS, [{ type: 'text', delta: '我没有工具，直接回答。' }, { type: 'finish', reason: 'stop' }]],
          captured,
        ),
        signal: new AbortController().signal,
      }),
    );

    assert.equal(captured.requests.length, 2, '工具回绝后应该再来一步让模型收场');

    const messages = listMessages(db, conversation.id);
    const toolMessage = messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage !== undefined, '缺 role=tool 的回绝消息');
    const payload = JSON.parse(String(toolMessage.content)) as Record<string, unknown>;
    assert.equal(payload['code'], 'tool_not_found');
    // ★ 可读 denial：必须说清"是什么事、下一步干什么"，而不是只有一句 denied
    assert.ok(typeof payload['message'] === 'string' && String(payload['message']).length > 0);
    assert.ok(typeof payload['hint'] === 'string' && String(payload['hint']).length > 0);

    // 第二步的请求里，历史应当包含那条 tool 消息
    const secondRequestRoles = captured.requests[1]?.messages.map((message) => message.role);
    assert.ok(secondRequestRoles?.includes('tool'));

    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  });
});

/**
 * ★★ A4（`D1@L637`）：抖动防护已从"第 3 次硬停"改成**先提醒、再升级、最后才停**。
 *
 * 为什么改：同工具同参数第 3 次未必是空转 —— 可能是正常重试（读刚被写过的文件、
 * 等还在生成的结果、第一次参数传错正在纠正）。硬停会误杀这些正常路径，
 * 用户看到的是"莫名其妙就说空转中止"。
 *
 * 现在的三档（`loop.ts` 的 DOOM_LOOP_*）：
 * - 第 3 次 ⇒ 插一条**运行时提醒**（走 steering 通道，**不进库**），继续跑；
 * - 第 5 次 ⇒ 换更强措辞，继续；
 * - 第 9 次 ⇒ 才中止。
 *
 * 这条测试钉前三档里的前两档 + "提醒真的进了请求" —— 这才是可观察行为：
 * 光断言"没中止"不够，还得证明**模型确实收到了那句话**，否则提醒就是个摆设。
 */
test('★★ 同样的工具调用连续 3 次 ⇒ 不再硬停，而是往下一步请求里插提醒', async () => {
  await withDb(async (db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    const captured: Captured = { requests: [] };
    const events = await collect(
      runTurn({
        db,
        conversationId: conversation.id,
        userText: '循环',
        // 3 次相同调用 + 第 4 步自然收敛：前两次正常，第 3 次插提醒后**继续**跑第 4 步
        provider: fakeProvider(
          [
            TOOL_CALL_EVENTS,
            TOOL_CALL_EVENTS,
            TOOL_CALL_EVENTS,
            [{ type: 'text', delta: '换个做法了' }, { type: 'finish', reason: 'stop' }],
          ],
          captured,
        ),
        signal: new AbortController().signal,
      }),
    );

    // ① 不再第 3 次就熔断：第 4 步照常跑（脚本用完后 fakeProvider 会补一个 stop）
    assert.ok(captured.requests.length >= 4, `第 3 次仍硬停 ⇒ A4 没生效（只发了 ${String(captured.requests.length)} 次请求）`);
    assert.equal(events.some((event) => event.type === 'error'), false, '这一轮不该被判成错误');

    // ② 提醒真的进了**第 4 步**的请求（第 3 次判定后才入队，所以最早出现在下一次请求里）
    const lastRequest = captured.requests.at(-1);
    const tail = lastRequest?.messages.at(-1);
    assert.equal(tail?.role, 'user');
    assert.match(String(tail?.content), /连续/, '第 4 步的请求里没有那句提醒 —— 提醒等于没插');
    assert.match(String(tail?.content), /运行时提醒/, '提醒必须标明它不是用户发言');

    // ③ ★ 最关键的一条：提醒**不落库**。库里的原文是"用户真的说过的话"的唯一凭据，
    //    往里塞 AI 自己写的 user 消息会让 recall / 导出 / 摘要全部失真（D1@L637 反模式）。
    const rows = listMessages(db, conversation.id);
    assert.equal(
      rows.some((row) => row.role === 'user' && String(row.content).includes('运行时提醒')),
      false,
      '提醒被写进了消息表 —— 那会污染 recall 与导出的逐字原文',
    );
  });
});

test('步数上限会兜底（模型一直要调工具也不会跑飞）', async () => {
  await withDb(async (db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    const captured: Captured = { requests: [] };
    // 每次都给**不同**参数的调用，绕开 doom_loop，逼出步数上限
    const script: ChatEvent[][] = [];
    for (let index = 0; index < 5; index += 1) {
      script.push([
        { type: 'tool_call', index: 0, id: `call_${index}`, name: 'read', argsDelta: `{"path":"f${index}.txt"}` },
        { type: 'finish', reason: 'tool_calls' },
      ]);
    }

    const events = await collect(
      runTurn({
        db,
        conversationId: conversation.id,
        userText: '一直调工具',
        provider: fakeProvider(script, captured),
        signal: new AbortController().signal,
        maxSteps: 2,
      }),
    );

    assert.equal(captured.requests.length, 2);
    // ★ 文案在 2026-11-09 改过：从"达到最大步数"改成"单轮步数上限 N"，并说明这是可调的。
    //   断言随之放宽到「提到步数上限」且「说得出可调」，不再绑死旧措辞。
    const limitError = events.find((event) => event.type === 'error' && /步数上限/.test(event.message));
    assert.ok(limitError, `应当报步数上限，实际：${JSON.stringify(events.filter((e) => e.type === 'error'))}`);
    assert.match((limitError as { message: string }).message, /设置/, '提示里要告诉用户这个上限可调');
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'length' });
  });
});

test('模型流里给出 abort ⇒ 本轮以 abort 收场，已生成内容仍然落库', async () => {
  await withDb(async (db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    const captured: Captured = { requests: [] };
    const events = await collect(
      runTurn({
        db,
        conversationId: conversation.id,
        userText: '说一半',
        provider: fakeProvider([[{ type: 'text', delta: '说到一' }, { type: 'finish', reason: 'abort' }]], captured),
        signal: new AbortController().signal,
      }),
    );

    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'abort' });
    const messages = listMessages(db, conversation.id);
    const assistant = messages.find((message) => message.role === 'assistant');
    assert.equal(assistant?.content, '说到一', '被中止的那一步，已生成的内容也要留住');
  });
});
