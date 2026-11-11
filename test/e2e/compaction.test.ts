import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { runTurn } from '../../src/core/agent/loop.ts';
import {
  assembleContext,
  compactRange,
  contextTokens,
  insertCompaction,
  listCompactions,
  renderSummaries,
} from '../../src/core/context/compact.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { rootsFor } from '../../src/core/policy/roots.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { appendMessage, insertConversation, insertProject, insertProvider, listMessages } from '../../src/core/store/repo.ts';
import { addCompactionDuties } from '../helpers/compaction-fixture.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { ChatEvent } from '../../src/shared/types.ts';
import { buildServer } from '../../src/server/app.ts';

/**
 * 压缩与逐字回读。
 *
 * 要证明三件事：
 * ① 压缩只改变"发给模型什么"，**原文一条都不少**；
 * ② 摘要**带 seq 指针**，`recall` 能用它取回原文（= 可逆）；
 * ③ 压缩之后新一轮请求里，确实只剩「摘要 + 最近原文」。
 */

function withDb(run: (db: DatabaseSync, conversationId: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-compact-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);

  return (async () => {
    try {
      const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1', contextWindow: 4000 });
      const project = insertProject(db, { id: 'compact-project', name: 'Real compaction fixture', sharedDir: join(dir, 'unused-shared') });
      const conversation = insertConversation(db, { providerId: provider.id, model: 'm', projectId: project.id });
      await run(db, conversation.id);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

function seed(db: DatabaseSync, conversationId: string, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    appendMessage(db, {
      conversationId,
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: `第 ${index} 条消息的内容`,
    });
  }
}

function fakeProvider(reply: ChatEvent[]): Provider {
  return {
    id: 'fake',
    async *stream(): AsyncGenerator<ChatEvent> {
      for (const event of reply) yield event;
    },
  };
}

test('没有压缩记录时，上下文就是全部消息', async () => {
  await withDb(async (db, conversationId) => {
    seed(db, conversationId, 4);
    const assembled = assembleContext(db, conversationId);
    assert.equal(assembled.summaries.length, 0);
    assert.deepEqual(
      assembled.messages.map((message) => message.seq),
      [1, 2, 3, 4],
    );
  });
});

test('有压缩记录后，被覆盖的区间不再进上下文，其余原文照发', async () => {
  await withDb(async (db, conversationId) => {
    seed(db, conversationId, 6);
    insertCompaction(db, { conversationId, fromSeq: 1, toSeq: 4, summary: '前四条讲了目标与约束' });

    const assembled = assembleContext(db, conversationId);
    assert.deepEqual(
      assembled.messages.map((message) => message.seq),
      [5, 6],
    );
    assert.equal(assembled.summaries.length, 1);
    assert.equal(assembled.summaries[0]?.fromSeq, 1);
    assert.equal(assembled.summaries[0]?.toSeq, 4);

    const rendered = renderSummaries(assembled.summaries);
    assert.match(rendered, /seq 1-4/);
    // ★ 摘要里必须给出可回读的指针，否则等于不可逆
    assert.match(rendered, /recall/);
  });
});

test('压缩只影响发送内容，消息表一条都不删', async () => {
  await withDb(async (db, conversationId) => {
    seed(db, conversationId, 10);
    const duties = await addCompactionDuties(db, conversationId);
    const before = listMessages(db, conversationId).length;

    const row = await compactRange({
      db,
      conversationId,
      provider: fakeProvider([
        { type: 'text', delta: '要点：目标是把 A 做完；约束是不要动 B。' },
        { type: 'usage', usage: { input: 100, output: 20 } },
        { type: 'finish', reason: 'stop' },
      ]),
      keepRecent: 4 + duties.addedMessages,
      signal: new AbortController().signal,
    });

    assert.ok(row !== null, '没有生成压缩记录');
    assert.equal(row?.fromSeq, 1);
    assert.equal(row?.toSeq, 6, '保留原最近4条业务消息，并额外完整保留三层履责批次');
    assert.equal(row?.outputTokens, 20);

    // ★ 原文仍在
    assert.equal(listMessages(db, conversationId).length, before);

    const assembled = assembleContext(db, conversationId);
    assert.deepEqual(
      assembled.messages.map((message) => message.seq),
      [7, 8, 9, 10, ...Array.from({ length: duties.addedMessages }, (_, index) => duties.userSeq + index)],
    );
    assert.equal(listCompactions(db, conversationId).length, 1);
  });
});

test('recall 能按 seq 区间逐字取回被压缩的原文（压缩可逆）', async () => {
  await withDb(async (db, conversationId) => {
    seed(db, conversationId, 8);
    // 先压到第 1-4 条
    insertCompaction(db, { conversationId, fromSeq: 1, toSeq: 4, summary: '摘要' });

    const registry = createDefaultRegistry(db);
    const result = await registry.execute(
      'recall',
      { from_seq: 1, to_seq: 4 },
      {
        conversationId,
        permissionMode: 'readonly',
        roots: rootsFor('readonly', null, null),
        workspacePath: null,
        projectSharedDir: null,
        cwd: tmpdir(),
        tempDir: tmpdir(),
        signal: new AbortController().signal,
      },
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.content, /第 1 条消息的内容/);
      assert.match(result.content, /第 4 条消息的内容/);
      assert.doesNotMatch(result.content, /第 5 条消息/);
    }
  });
});

test('contextTokens 会随着压缩下降', async () => {
  await withDb(async (db, conversationId) => {
    seed(db, conversationId, 20);
    const before = contextTokens(db, conversationId);
    insertCompaction(db, { conversationId, fromSeq: 1, toSeq: 16, summary: '很短的摘要' });
    const after = contextTokens(db, conversationId);
    assert.ok(after < before, `压缩后 token 没降：${before} → ${after}`);
  });
});

test('端到端：POST /compact 之后，新一轮请求只剩「摘要 + 最近原文」', async () => {
  const captured: Array<{ system: string; messageCount: number; messages: Array<{ role: string; content: string | null }> }> = [];

  const model = createServer((req, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      const system = body.messages.find((message) => message.role === 'system')?.content ?? '';
      captured.push({ system, messageCount: body.messages.length, messages: body.messages });

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = system.includes('上下文压缩器')
        ? '【摘要】用户要完成 A；约束是不动 B；已完成 3 项，剩 2 项。'
        : '明白。';
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', () => resolve()));
  const { port } = model.address() as AddressInfo;

  const home = mkdtempSync(join(tmpdir(), 'alkaid-compact-http-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });

  try {
    const project = insertProject(db, { id: 'compact-http-project', name: 'HTTP compaction fixture', sharedDir: join(home, 'unused-shared') });
    const providerRes = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { name: 'fake', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-compact-123456', contextWindow: 4000 },
    });
    const provider = providerRes.json() as { id: string };

    const conversationRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { providerId: provider.id, model: 'fake-model', projectId: project.id },
    });
    const conversation = conversationRes.json() as { id: string };

    // 造 8 条历史（绕过 HTTP，直接写库）
    seed(db, conversation.id, 8);
    const duties = await addCompactionDuties(db, conversation.id);

    const compactRes = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/compact`,
      payload: { keepRecent: 4 + duties.addedMessages },
    });
    assert.equal(compactRes.statusCode, 200, compactRes.body);
    const compactBody = compactRes.json() as { compacted: boolean; compaction?: { fromSeq: number; toSeq: number } };
    assert.equal(compactBody.compacted, true);
    assert.equal(compactBody.compaction?.fromSeq, 1);
    assert.equal(compactBody.compaction?.toSeq, 4);

    // 只为本次手动压缩使用小窗口；后续业务轮恢复大窗口，避免测试意外触发整理/自动压缩。
    db.prepare('UPDATE providers SET context_window=? WHERE id=?').run(1_000_000, provider.id);
    // 压缩后发一条新消息：抓取这次请求的形状
    captured.length = 0;
    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: '继续' },
    });
    assert.equal(sent.statusCode, 200);

    const request = captured.at(-1);
    assert.ok(request !== undefined);
    // ① 回顾与逐字指针仍真实送达，但迁到派生user载体，不能污染稳定system缓存前缀。
    assert.doesNotMatch(request.system, /已压缩区间 seq 1-4/);
    const recovery = request.messages.find(message => message.role === 'user' && message.content?.startsWith('[runtime_compaction'));
    assert.ok(recovery, '新轮请求必须带派生历史回顾，不可只写库不交付');
    assert.match(recovery.content!, /已压缩区间 seq 1-4/);
    assert.match(recovery.content!, /recall/);
    // ② 原来的最近4条业务消息仍在，被压前4条不再作为独立原始消息重送。
    const business = request.messages.filter(message => /^第 \d+ 条消息的内容$/.test(message.content ?? ''));
    assert.deepEqual(business.map(message => message.content), [5, 6, 7, 8].map(seq => `第 ${seq} 条消息的内容`));
    assert.equal(request.messages.filter(message => message.content === '继续').length, 1);
    const derived = request.messages.filter(message => message.role === 'user' && (message.content?.startsWith('[runtime_context:') || message.content?.startsWith('[runtime_compaction')));
    assert.equal(request.messageCount, 1 + derived.length + 4 + duties.addedMessages + 1,
      '只能增加明确派生载体和整组三层证据，不能重复发送旧原文或漏近期历史');

    // ③ 原文与压缩记录都还在
    const compactionsRes = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}/compactions`,
    });
    const compactionsBody = compactionsRes.json() as { compactions: unknown[]; contextTokens: number };
    assert.equal(compactionsBody.compactions.length, 1);
    assert.ok(compactionsBody.contextTokens > 0);
    assert.equal(listMessages(db, conversation.id).length, 8 + duties.addedMessages + 2);
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
});

test('消息太少时压缩是空操作（返回 null，不写记录）', async () => {
  await withDb(async (db, conversationId) => {
    seed(db, conversationId, 3);
    const duties = await addCompactionDuties(db, conversationId);
    const row = await compactRange({
      db,
      conversationId,
      provider: fakeProvider([{ type: 'text', delta: '不该被调用' }, { type: 'finish', reason: 'stop' }]),
      keepRecent: 6 + duties.addedMessages,
      signal: new AbortController().signal,
    });
    assert.equal(row, null);
    assert.equal(listCompactions(db, conversationId).length, 0);
  });
});
