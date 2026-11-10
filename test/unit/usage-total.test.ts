import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import { compactRange, listCompactions } from '../../src/core/context/compact.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { usageInputTotal } from '../../src/core/model/usage.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { appendMessage, insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { addCompactionDuties } from '../helpers/compaction-fixture.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { ChatEvent, Usage } from '../../src/shared/types.ts';

/**
 * ★★ 三桶口径改了之后，**落库的两处数字**要跟着改（阶段一第 6 条的收尾）。
 *
 * 2026-11-09 之前 `Usage.input` 就是上游 `prompt_tokens`（**含**缓存）。改成三桶之后
 * `Usage.input` 只剩"未命中缓存的那部分"，于是这两处原本写着 `usage.input` 的代码
 * **语义静默变了**：
 *
 * - `core/context/compact.ts` → `compactions.input_tokens`（这一次压缩花了多少输入）
 * - `core/agent/loop.ts` → `step_end` 审计事件的 `payload.input`
 *
 * 它们要的都是**输入总量**（账单口径），不是"未命中多少"。语义一变，数字变小、
 * **不报错**、事后也查不出来 —— 典型"改一处口径、烂两处账"。
 * ⇒ 统一走 `usageInputTotal()`，并用这组测试把两处**真的落库的值**钉住。
 */

function withDb(fn: (db: ReturnType<typeof openDatabase>, dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alkaid-usage-total-'));
    const db = openDatabase(join(dir, 'test.db'));
    migrate(db);
    try {
      await fn(db, dir);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ───────────────────────── 纯函数 ─────────────────────────

test('usageInputTotal = 三桶之和；reasoning 不参与', () => {
  const usage: Usage = { input: 100, output: 500, cached: 900, cachedWrite: 50, reasoning: 400 };
  assert.equal(usageInputTotal(usage), 1050, '100 未缓存 + 900 命中 + 50 写入');
  // reasoning 是 output 的子集，加进来就多 400
  assert.notEqual(usageInputTotal(usage), 1450);
});

test('usageInputTotal：没报缓存写入时只加已有的桶（不把 undefined 算成 0 之外的数）', () => {
  assert.equal(usageInputTotal({ input: 100, output: 10 }), 100);
  assert.equal(usageInputTotal({ input: 100, output: 10, cached: 20 }), 120);
  assert.equal(usageInputTotal({ input: 0, output: 10, cached: 0 }), 0);
});

// ───────────────────────── 落库：压缩记录 ─────────────────────────

test('★★ 压缩记录的 input_tokens 是**输入总量**，不是未命中量', withDb(async (db) => {
  const providerRow = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1', contextWindow: 4000 });
  const project = insertProject(db, { id: 'usage-compaction-project', name: 'Usage fixture', sharedDir: 'unused' });
  const conversation = insertConversation(db, { providerId: providerRow.id, model: 'm', projectId: project.id });

  for (let index = 0; index < 10; index += 1) {
    appendMessage(db, {
      conversationId: conversation.id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${String(index)} 条`,
    });
  }

  const fake: Provider = {
    id: 'fake',
    async *stream(): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: '摘要正文' };
      // ★ 关键：上游报的是 prompt_tokens=1000 里有 900 命中 ⇒ 三桶 input=100/cached=900
      yield { type: 'usage', usage: { input: 100, output: 60, cached: 900 } };
      yield { type: 'finish', reason: 'stop' };
    },
  };

  const duties = await addCompactionDuties(db, conversation.id);
  const row = await compactRange({
    db,
    conversationId: conversation.id,
    provider: fake,
    keepRecent: 4 + duties.addedMessages,
    signal: new AbortController().signal,
  });
  assert.ok(row !== null);

  assert.equal(row.inputTokens, 1000, '必须记输入总量；只记 100 就是把压缩成本少算九成');
  assert.equal(row.outputTokens, 60);
  // 再从库里读一遍，确认不是只在返回对象上对
  const stored = listCompactions(db, conversation.id)[0];
  assert.equal(stored?.inputTokens, 1000);
}));

// ───────────────────────── 落库：审计事件 ─────────────────────────

test('★★ step_end 审计事件的 input 也是**输入总量**', withDb(async (db) => {
  const providerRow = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
  const conversation = insertConversation(db, { providerId: providerRow.id, model: 'm' });

  const fake: Provider = {
    id: 'fake',
    async *stream(): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: '好' };
      yield { type: 'usage', usage: { input: 100, output: 60, cached: 900 } };
      yield { type: 'finish', reason: 'stop' };
    },
  };

  const events: TurnEvent[] = [];
  for await (const event of runTurn({
    db,
    conversationId: conversation.id,
    userText: '你好',
    provider: fake,
    signal: new AbortController().signal,
    tools: createDefaultRegistry(db),
  })) {
    events.push(event);
  }

  const row = db
    .prepare("SELECT payload FROM step_events WHERE conversation_id = ? AND kind = 'step_end' ORDER BY rowid ASC")
    .get(conversation.id) as { payload: string } | undefined;
  assert.ok(row !== undefined, '没有 step_end 事件');

  const payload = JSON.parse(row.payload) as { input?: number; output?: number };
  assert.equal(payload.input, 1000, '审计里的输入量必须是总量，不是未命中量');
  assert.equal(payload.output, 60);
}));
