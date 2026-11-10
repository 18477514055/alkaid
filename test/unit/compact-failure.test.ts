import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import {
  COMPACTION_FAILURE_META,
  CompactionError,
  compactRange,
  insertCompaction,
  listCompactions,
  sanitizeToolPairs,
  type CompactionFailureCode,
} from '../../src/core/context/compact.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { appendMessage, insertConversation, insertProject, insertProvider, type MessageRow } from '../../src/core/store/repo.ts';
import { addCompactionDuties } from '../helpers/compaction-fixture.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { ChatEvent } from '../../src/shared/types.ts';

/**
 * 阶段一第 3 条与第 7 条：
 *
 * ① 补齐占位的文案必须带**判据三要素**（未知 / 只读或幂等 / 先核实）。
 *    只写"重新调用一次"的文案会让模型对 `write`/`pwsh` 盲目重放。
 * ② 压缩失败是**封闭枚举**：每类一句人话 + 一个 retryable，且并发有真闸。
 */

function withDb(run: (db: DatabaseSync, conversationId: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-compact-failure-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);

  return (async () => {
    try {
      const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1', contextWindow: 4000 });
      const project = insertProject(db, { id: 'compact-failure-project', name: 'Real compaction fixture', sharedDir: join(dir, 'unused-shared') });
      const conversation = insertConversation(db, { providerId: provider.id, model: 'm', projectId: project.id });
      await run(db, conversation.id);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

async function seed(db: DatabaseSync, conversationId: string, count: number) {
  for (let index = 1; index <= count; index += 1) {
    appendMessage(db, {
      conversationId,
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: `第 ${index} 条消息的内容`,
    });
  }
  return addCompactionDuties(db, conversationId);
}

function fakeProvider(reply: ChatEvent[]): Provider {
  return {
    id: 'fake',
    async *stream(): AsyncGenerator<ChatEvent> {
      for (const event of reply) yield event;
    },
  };
}

/** 抓一次 CompactionError；不是它就直接失败（避免把别的异常当成通过）。 */
async function expectFailure(run: () => Promise<unknown>): Promise<CompactionError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof CompactionError, `期望 CompactionError，实际是 ${String(error)}`);
    return error;
  }
  throw new Error('期望抛出 CompactionError，但它成功返回了');
}

function mk(over: Partial<MessageRow> & { seq: number; role: MessageRow['role'] }): MessageRow {
  return {
    id: `m${over.seq}`,
    conversationId: 'c1',
    seq: over.seq,
    role: over.role,
    content: over.content ?? null,
    reasoning: null,
    toolCalls: over.toolCalls ?? null,
    toolCallId: over.toolCallId ?? null,
    usage: null,
    finishReason: over.finishReason ?? null,
    createdAt: '2026-11-09T00:00:00.000Z',
  };
}

// ── 第 3 条：占位 hint 必须是判据句 ───────────────────────────────────────────

test('补齐占位的 hint 含判据三要素：未知 / 只读或幂等 / 先核实', () => {
  const messages = [
    mk({ seq: 1, role: 'user', content: 'hi' }),
    mk({ seq: 2, role: 'assistant', toolCalls: [{ id: 'c1', name: 'pwsh', arguments: '{}' }] }),
  ];

  const filler = sanitizeToolPairs(messages).find((message) => message.role === 'tool');
  assert.ok(filler !== undefined, '必须补出一条 tool 消息');
  const body = JSON.parse(filler.content!) as { ok: boolean; code: string; message: string; hint: string };

  assert.equal(body.ok, false, '占位必须说明"没结果"，不能伪装成功');
  assert.equal(body.code, 'tool_result_missing');
  // ★ 三要素一个都不能少。少任何一条，模型都会失去"该不该重试"的判据。
  assert.match(body.hint, /未知/, '必须说明结果是**未知**，不是"失败"');
  assert.match(body.hint, /只读或幂等/, '必须给出"只读或幂等可以直接重试"这一侧');
  assert.match(body.hint, /先核实/, '必须有副作用操作"先核实外部状态"这一侧');
  // ★ 不许再出现旧文案那句无条件的"重新调用一次"（它正是要修的坑）。
  assert.doesNotMatch(body.hint, /就重新调用一次/);
});

test('有副作用的工具也要拿到同一句判据（不能按工具名分流成含糊文案）', () => {
  const messages = [
    mk({ seq: 1, role: 'user', content: 'hi' }),
    mk({
      seq: 2,
      role: 'assistant',
      toolCalls: [
        { id: 'a', name: 'read', arguments: '{}' },
        { id: 'b', name: 'write', arguments: '{}' },
      ],
    }),
  ];

  const fillers = sanitizeToolPairs(messages).filter((message) => message.role === 'tool');
  assert.equal(fillers.length, 2);
  for (const filler of fillers) {
    const hint = (JSON.parse(filler.content!) as { hint: string }).hint;
    assert.match(hint, /未知/);
    assert.match(hint, /只读或幂等/);
    assert.match(hint, /先核实/);
  }
});

// ── 第 7 条：封闭枚举 + retryable ─────────────────────────────────────────────

test('六类失败都有 meta（人话 + retryable），且 busy / cancelled / persistence 不可重试', () => {
  const codes: CompactionFailureCode[] = ['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence'];
  for (const code of codes) {
    const meta = COMPACTION_FAILURE_META[code];
    assert.ok(meta !== undefined, `${code} 缺少 meta`);
    assert.ok(meta.message.length > 0, `${code} 缺少人话`);
    assert.equal(typeof meta.retryable, 'boolean');
  }
  // 判据：busy（再撞闸 + 重复计费）、cancelled（人的决定）、persistence（已落库，重试会插重复）
  assert.equal(COMPACTION_FAILURE_META.busy.retryable, false);
  assert.equal(COMPACTION_FAILURE_META.cancelled.retryable, false);
  assert.equal(COMPACTION_FAILURE_META.persistence.retryable, false);
  // 判据：changed（重新压缩按最新历史算新区间）、summary/commit（失败即无落库，重发是干净的）
  assert.equal(COMPACTION_FAILURE_META.changed.retryable, true);
  assert.equal(COMPACTION_FAILURE_META.summary.retryable, true);
  assert.equal(COMPACTION_FAILURE_META.commit.retryable, true);
});

test('模型没返回摘要 ⇒ code === summary，且没有写入任何压缩记录', async () => {
  await withDb(async (db, conversationId) => {
    const duties = await seed(db, conversationId, 8);

    // 只给 finish、不给 text —— 复刻"模型这一轮什么都没产"
    const failure = await expectFailure(() =>
      compactRange({
        db,
        conversationId,
        provider: fakeProvider([{ type: 'finish', reason: 'stop' }]),
        keepRecent: 4 + duties.addedMessages,
        signal: new AbortController().signal,
      }),
    );

    assert.equal(failure.code, 'summary');
    assert.equal(failure.retryable, true);
    assert.equal(listCompactions(db, conversationId).length, 0, '失败时不许留下半条记录');
  });
});

test('provider 发 error 事件 ⇒ code === summary（不是伪装的成功，也不是取消）', async () => {
  await withDb(async (db, conversationId) => {
    const duties = await seed(db, conversationId, 8);
    const failure = await expectFailure(() =>
      compactRange({
        db,
        conversationId,
        provider: fakeProvider([
          { type: 'error', message: 'upstream 500', retryable: true, kind: 'http' },
          { type: 'finish', reason: 'error' },
        ]),
        keepRecent: 4 + duties.addedMessages,
        signal: new AbortController().signal,
      }),
    );
    assert.equal(failure.code, 'summary');
  });
});

test('signal 已 aborted ⇒ code === cancelled（不能算成 summary）', async () => {
  await withDb(async (db, conversationId) => {
    const duties = await seed(db, conversationId, 8);
    const controller = new AbortController();
    controller.abort();

    const failure = await expectFailure(() =>
      compactRange({
        db,
        conversationId,
        provider: fakeProvider([{ type: 'text', delta: '不该被调用' }, { type: 'finish', reason: 'stop' }]),
        keepRecent: 4 + duties.addedMessages,
        signal: controller.signal,
      }),
    );

    // ★ 这两条断言是本次要防的回归：取消被归成 summary 时，界面会把
    //   "用户自己按了取消"显示成"模型没给摘要、可以重试" —— 重试就等于无视取消。
    assert.equal(failure.code, 'cancelled');
    assert.equal(failure.retryable, false);
    assert.equal(listCompactions(db, conversationId).length, 0);
  });
});

test('provider 把 AbortError 抛出来（违约）⇒ 也归 cancelled，并发闸已释放', async () => {
  await withDb(async (db, conversationId) => {
    const duties = await seed(db, conversationId, 8);

    const exploding: Provider = {
      id: 'exploding',
      // provider 契约是"永不 throw"，但实测有网关会让 undici 直接抛 —— 必须认成取消。
      async *stream(): AsyncGenerator<ChatEvent> {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    };

    const failure = await expectFailure(() =>
      compactRange({ db, conversationId, provider: exploding, keepRecent: 4 + duties.addedMessages, signal: new AbortController().signal }),
    );
    assert.equal(failure.code, 'cancelled');

    // ★ finally 必须放闸：否则这条会话被永久锁死在 busy 上。
    const ok = await compactRange({
      db,
      conversationId,
      provider: fakeProvider([{ type: 'text', delta: '摘要' }, { type: 'finish', reason: 'stop' }]),
      keepRecent: 4 + duties.addedMessages,
      signal: new AbortController().signal,
    });
    assert.ok(ok !== null, '失败之后必须还能再压一次');
  });
});

test('同一会话并发两次压缩 ⇒ 第二次 code === busy 且 retryable === false', async () => {
  await withDb(async (db, conversationId) => {
    const duties = await seed(db, conversationId, 8);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking: Provider = {
      id: 'blocking',
      async *stream(): AsyncGenerator<ChatEvent> {
        await gate;
        yield { type: 'text', delta: '并发测试的摘要' };
        yield { type: 'finish', reason: 'stop' };
      },
    };

    // 不 await：第一次会停在 provider 的 await 上，此时闸是**占用**状态
    const first = compactRange({
      db,
      conversationId,
      provider: blocking,
      keepRecent: 4 + duties.addedMessages,
      signal: new AbortController().signal,
    });

    // ★ 先把第一次收回来再断言：否则断言一抛，first 变成无人 await 的悬挂 Promise，
    //   会在 withDb 关库之后才结算 ⇒ 报一个"database is not open"的假线索。
    let failure: CompactionError;
    try {
      failure = await expectFailure(() =>
        compactRange({
          db,
          conversationId,
          provider: fakeProvider([{ type: 'text', delta: '第二次不该真的发出请求' }, { type: 'finish', reason: 'stop' }]),
          keepRecent: 4 + duties.addedMessages,
          signal: new AbortController().signal,
        }),
      );
    } finally {
      release();
    }

    const row = await first;
    assert.ok(row !== null, '第一次压缩应当正常完成');

    // ★ retryable=false 的判据：立刻重试只会再撞一次闸；要排队两次就等于两次都真调了模型。
    assert.equal(failure.code, 'busy');
    assert.equal(failure.retryable, false);
    assert.match(failure.message, /已经有一次压缩/);
    // 只允许一条记录：闸挡住了第二次，所以没有"同一区间两条摘要"。
    assert.equal(listCompactions(db, conversationId).length, 1);

    // ★ 放闸之后可以再压：不能因为刚才有过一次 busy 就把会话永久锁死。
    const after = await compactRange({
      db,
      conversationId,
      provider: fakeProvider([{ type: 'text', delta: '放闸后的摘要' }, { type: 'finish', reason: 'stop' }]),
      keepRecent: 2 + duties.addedMessages,
      signal: new AbortController().signal,
    });
    assert.ok(after !== null);
  });
});

test('压缩期间区间被并发改动 ⇒ code === changed（可重试），且不写记录', async () => {
  await withDb(async (db, conversationId) => {
    const duties = await seed(db, conversationId, 10);

    // 模型"想了很久"：这段时间里别处把前 4 条压掉了 ⇒ 本次要压的前缀已经不存在
    const racing: Provider = {
      id: 'racing',
      async *stream(): AsyncGenerator<ChatEvent> {
        insertCompaction(db, { conversationId, fromSeq: 1, toSeq: 4, summary: '并发压缩留下的摘要' });
        yield { type: 'text', delta: '这次算出来的摘要已经过期' };
        yield { type: 'finish', reason: 'stop' };
      },
    };

    const failure = await expectFailure(() =>
      compactRange({ db, conversationId, provider: racing, keepRecent: 6 + duties.addedMessages, signal: new AbortController().signal }),
    );

    assert.equal(failure.code, 'changed');
    // 可重试的判据：重新压缩会按**最新**历史算新区间（已覆盖的不进候选），不会插同一条区间。
    assert.equal(failure.retryable, true);
    assert.equal(listCompactions(db, conversationId).length, 1, '只应有并发那次的那一条');

    // 真重试：新原文候选必须从5开始；累计回顾另携此前1-4的有效摘要，而不是重送旧原文。
    const previous = listCompactions(db, conversationId)[0]!;
    let retriedOriginalSeqs: number[] = [];
    let retriedPreviousIds: string[] = [];
    const retryProvider: Provider = { id: 'retrying', async *stream(request) {
      const payload = JSON.parse(request.messages[1]!.content!) as { originalMessages: Array<{ seq: number }>; previousRecaps: Array<{ id: string }> };
      retriedOriginalSeqs = payload.originalMessages.map(message => message.seq);
      retriedPreviousIds = payload.previousRecaps.map(recap => recap.id);
      yield { type: 'text', delta: '第二轮的摘要' }; yield { type: 'finish', reason: 'stop' };
    } };
    const row = await compactRange({
      db,
      conversationId,
      provider: retryProvider,
      keepRecent: 4 + duties.addedMessages,
      signal: new AbortController().signal,
    });
    assert.ok(row !== null);
    assert.deepEqual(retriedOriginalSeqs, [5, 6], '重试必须按最新历史重算原文候选，不能重复取已覆盖1-4');
    assert.deepEqual(retriedPreviousIds, [previous.id], '此前回顾必须参与累计，不能静默丢掉');
    assert.equal(row.fromSeq, 1, '累计回顾显式覆盖此前摘要与本次新原文，起点不是仅本次候选5');
    assert.equal(row.toSeq, 6);
    assert.equal(listCompactions(db, conversationId).length, 2, '旧记录只追加保留，失败尝试没有插入第三份');
    assert.equal(listCompactions(db, conversationId).find(compaction => compaction.id === previous.id)?.summary, previous.summary);
  });
});

test('CompactionError 带 code / retryable / 人话，且 instanceof Error', () => {
  const error = new CompactionError('summary');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'CompactionError');
  assert.equal(error.code, 'summary');
  assert.equal(error.retryable, true);
  assert.equal(error.message, COMPACTION_FAILURE_META.summary.message);
});
