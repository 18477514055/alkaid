import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { getRecallIndex, getRecallMessage } from '../../src/core/context/recall.ts';
import { insertCompaction } from '../../src/core/context/compact.ts';
import { appendMessage, insertConversation, insertProvider, listMessages } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import { createRecallTool } from '../../src/core/tools/recall.ts';
import { createSurface } from '../../src/core/tools/runtime.ts';
import { PERMISSION_MODES } from '../../src/core/policy/mode.ts';
import { buildServer } from '../../src/server/app.ts';
import type { RecallIndex, RecallIndexQuery, RecallMessagePage, RecallMessageQuery } from '../../src/shared/recall.ts';
import type { ToolContext, ToolOutcome } from '../../src/core/tools/types.ts';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'); migrate(db);
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  const a = insertConversation(db, { providerId: provider.id, model: 'offline' });
  const b = insertConversation(db, { providerId: provider.id, model: 'offline' });
  const child = insertConversation(db, { providerId: provider.id, model: 'offline', agentRole: 'subagent' });
  const tools = createDefaultRegistry(db);
  const ctx = (conversationId = a.id): ToolContext => ({ conversationId, permissionMode: 'readonly', roots: { readable: [], writable: [], anywhere: false }, workspacePath: null, projectSharedDir: null, cwd: '.', tempDir: '.', signal: new AbortController().signal });
  t.after(() => db.close());
  return { db, a, b, child, tools, ctx };
}
function body<T>(outcome: ToolOutcome): T {
  assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
  return JSON.parse(outcome.ok ? outcome.content : '{}') as T;
}
function reassemble(db: DatabaseSync, conversationId: string, seq: number, maxChars = 4096): string {
  let offset = 0, result = '', pages = 0;
  for (;;) {
    const page = getRecallMessage(db, conversationId, { seq, charOffset: offset, maxChars });
    assert.equal(page.serialization, 'JSON(MessageRow)'); assert.equal(page.charOffset, offset);
    assert.ok(page.text.length <= maxChars); assert.ok(++pages < 10_000);
    // Simulate each independent HTTP/tool JSON transport, including lone UTF-16 surrogates.
    result += (JSON.parse(JSON.stringify(page)) as RecallMessagePage).text;
    if (page.done) { assert.equal(page.nextOffset, null); assert.equal(result.length, page.totalChars); return result; }
    assert.ok(page.nextOffset !== null && page.nextOffset > offset);
    offset = page.nextOffset!;
  }
}
const badRequest = (error: unknown) => (error as { statusCode?: number }).statusCode === 400;
const notFound = (error: unknown) => (error as { statusCode?: number }).statusCode === 404;

test('recall pages reassemble complete pre-compaction long messages, reasoning, tool protocol and usage byte-for-byte as MessageRow JSON', t => {
  const f = fixture(t);
  const user = '  用户 original\n中英 🧭 emoji \r\n'.repeat(1600) + 'USER_TAIL_BEYOND_20000';
  const reasoning = '原始推理 reasoning 🧩\n'.repeat(1800) + 'REASONING_TAIL';
  const argumentsText = JSON.stringify({ path: 'D:/原文/source.ts', content: 'tool arg\n🧭'.repeat(2300), tail: 'ARGUMENT_TAIL' });
  appendMessage(f.db, { conversationId: f.a.id, role: 'user', content: user });
  appendMessage(f.db, { conversationId: f.a.id, role: 'assistant', displayChannel: 'maintenance', content: 'assistant text', reasoning,
    toolCalls: [{ id: 'original-call', name: 'write', arguments: argumentsText, displayChannel: 'chat' }],
    usage: { input: 9, output: 12, cached: 24, cachedWrite: 8, reasoning: 4, inputExcludesCached: true }, finishReason: 'tool_calls' });
  appendMessage(f.db, { conversationId: f.a.id, role: 'tool', toolCallId: 'original-call', content: JSON.stringify({ ok: true, text: '结果\n🧩'.repeat(5000), tail: 'TOOL_RESULT_TAIL' }) });
  const originals = listMessages(f.db, f.a.id);
  assert.ok(originals[0]!.content!.length > 20_000); assert.ok(originals[1]!.reasoning!.length > 20_000);
  const defaultPage = getRecallMessage(f.db, f.a.id, { seq: 1 });
  assert.equal(defaultPage.done, false); assert.ok(defaultPage.text.length >= 11_999 && defaultPage.text.length <= 12_000, 'default page is 12000 UTF-16 units, with at most one surrogate boundary adjustment');
  insertCompaction(f.db, { conversationId: f.a.id, fromSeq: 1, toSeq: 3, summary: 'summary does not replace originals' });
  const before = JSON.stringify(listMessages(f.db, f.a.id));
  for (const original of originals) {
    const assembled = reassemble(f.db, f.a.id, original.seq);
    assert.equal(assembled, JSON.stringify(original)); assert.deepEqual(JSON.parse(assembled), original);
  }
  const index = getRecallIndex(f.db, f.a.id);
  assert.deepEqual(index.entries.map(entry => entry.totalChars), originals.map(row => JSON.stringify(row).length));
  assert.doesNotMatch(JSON.stringify(index), /USER_TAIL|REASONING_TAIL|ARGUMENT_TAIL|TOOL_RESULT_TAIL|assistant text/);
  assert.equal(JSON.stringify(listMessages(f.db, f.a.id)), before);
});

test('recall message slices cover emoji boundaries and final empty offset without losing UTF-16 code units', t => {
  const f = fixture(t); appendMessage(f.db, { conversationId: f.a.id, role: 'user', content: 'before🧭after\n尾部' });
  const original = JSON.stringify(listMessages(f.db, f.a.id)[0]!); const emoji = original.indexOf('🧭'); assert.ok(emoji > 0);
  const high = getRecallMessage(f.db, f.a.id, { seq: 1, charOffset: emoji, maxChars: 1 });
  const low = getRecallMessage(f.db, f.a.id, { seq: 1, charOffset: high.nextOffset!, maxChars: 1 });
  assert.equal(high.text.length, 1); assert.equal(low.text.length, 1);
  assert.equal(JSON.parse(JSON.stringify(high)).text + JSON.parse(JSON.stringify(low)).text, '🧭');
  const safe = getRecallMessage(f.db, f.a.id, { seq: 1, charOffset: emoji - 2, maxChars: 3 });
  assert.equal(safe.text.length, 2, 'ordinary pages avoid splitting the surrogate pair'); assert.equal(safe.nextOffset, emoji);
  assert.equal(reassemble(f.db, f.a.id, 1, 1), original);
  const end = getRecallMessage(f.db, f.a.id, { seq: 1, charOffset: original.length });
  assert.equal(end.text, ''); assert.equal(end.done, true); assert.equal(end.nextOffset, null);
});

test('recall index pages are stable bounded metadata only with inclusive seq ranges and no gist', t => {
  const f = fixture(t);
  for (let i = 1; i <= 107; i++) appendMessage(f.db, { conversationId: f.a.id, role: i % 2 ? 'user' : 'assistant', content: `BODY_NOT_IN_INDEX_${i}` });
  const first = getRecallIndex(f.db, f.a.id); assert.equal(first.entries.length, 50); assert.equal(first.limit, 50); assert.equal(first.offset, 0); assert.equal(first.total, 107);
  const second = getRecallIndex(f.db, f.a.id, { offset: 50, limit: 100 }); assert.equal(second.entries[0]?.seq, 51); assert.equal(second.entries.at(-1)?.seq, 107);
  const ranged = getRecallIndex(f.db, f.a.id, { fromSeq: 10, toSeq: 20, offset: 3, limit: 4 });
  assert.equal(ranged.total, 11); assert.deepEqual(ranged.entries.map(entry => entry.seq), [13, 14, 15, 16]);
  assert.deepEqual(getRecallIndex(f.db, f.a.id, { offset: 1000 }).entries, []);
  assert.doesNotMatch(JSON.stringify(first), /BODY_NOT_IN_INDEX|content|reasoning|gist|toolCalls/);
  assert.deepEqual(Object.keys(first.entries[0]!).sort(), ['createdAt', 'id', 'role', 'seq', 'totalChars']);
});

test('recall queries reject invalid bounds, fractions, nulls, foreign fields and nonexistent own messages', t => {
  const f = fixture(t); appendMessage(f.db, { conversationId: f.a.id, role: 'user', content: 'own' });
  const invalidIndexes: unknown[] = [{ fromSeq: 0 }, { toSeq: -1 }, { fromSeq: 2, toSeq: 1 }, { fromSeq: 1.5 }, { offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }, { limit: null }, { fromSeq: null }, { conversationId: f.b.id }, { projectId: 'foreign' }];
  for (const query of invalidIndexes) assert.throws(() => getRecallIndex(f.db, f.a.id, query as RecallIndexQuery), badRequest, JSON.stringify(query));
  const length = getRecallMessage(f.db, f.a.id, { seq: 1 }).totalChars;
  const invalidMessages: unknown[] = [{ seq: 0 }, { seq: 1.5 }, { seq: 1, charOffset: -1 }, { seq: 1, charOffset: length + 1 }, { seq: 1, charOffset: 0.5 }, { seq: 1, maxChars: 0 }, { seq: 1, maxChars: 20001 }, { seq: 1, maxChars: null }, { seq: 1, charOffset: null }, { seq: 1, maxChars: NaN }, { seq: 1, conversationId: f.b.id }];
  for (const query of invalidMessages) assert.throws(() => getRecallMessage(f.db, f.a.id, query as RecallMessageQuery), badRequest);
  assert.throws(() => getRecallMessage(f.db, f.a.id, { seq: 99 }), notFound);
  assert.throws(() => getRecallIndex(f.db, 'unknown'), notFound);
  assert.deepEqual(getRecallIndex(f.db, f.b.id).entries, []);
});

test('legacy range text stays compatible but explicitly marks truncation and points to complete JSON pages', async t => {
  const f = fixture(t); const content = '先前正文\n'.repeat(6000) + 'HIDDEN_LONG_TAIL';
  appendMessage(f.db, { conversationId: f.a.id, role: 'user', content });
  const range = await createRecallTool(f.db).execute({ from_seq: 1, to_seq: 1 }, f.ctx()); assert.equal(range.ok, true);
  assert.ok(range.ok && range.truncated); assert.ok(range.ok && range.content.includes('[seq 1] 用户：'));
  if (range.ok) { assert.match(range.content, /截断|并非完整原文/); assert.match(range.content, /mode="index"/); assert.match(range.content, /mode="message"/); assert.match(range.content, /nextOffset/); assert.doesNotMatch(range.content, /HIDDEN_LONG_TAIL/); }
  const index = body<RecallIndex>(await f.tools.execute('recall', { mode: 'index' }, f.ctx())); assert.equal(index.total, 1);
  let text = '', offset = 0;
  for (;;) { const page = body<RecallMessagePage>(await f.tools.execute('recall', { mode: 'message', seq: 1, charOffset: offset, maxChars: 20_000 }, f.ctx())); text += page.text; if (page.done) break; offset = page.nextOffset!; }
  assert.equal(JSON.parse(text).content, content);
  for (const args of [{ from_seq: 1, to_seq: 1, conversationId: f.b.id }, { mode: 'index', projectId: 'foreign' }, { mode: 'message', seq: 1, messageId: 'foreign' }, { mode: null, from_seq: 1, to_seq: 1 }]) {
    const denied = await f.tools.execute('recall', args, f.ctx()); assert.equal(denied.ok, false);
  }
});

test('recall keeps full tool-call arguments and orphan results rather than applying provider sanitization', t => {
  const f = fixture(t);
  appendMessage(f.db, { conversationId: f.a.id, role: 'assistant', reasoning: '  original hidden reasoning\n', toolCalls: [{ id: 'partial', name: 'write', arguments: '{"unfinished":', displayChannel: 'chat' }], finishReason: 'error' });
  appendMessage(f.db, { conversationId: f.a.id, role: 'tool', toolCallId: 'orphan', content: 'original unmatched result' });
  const expected = listMessages(f.db, f.a.id);
  assert.deepEqual(JSON.parse(reassemble(f.db, f.a.id, 1)), expected[0]);
  assert.deepEqual(JSON.parse(reassemble(f.db, f.a.id, 2)), expected[1]);
});

test('recall is lazy read-only in all business permission modes and persisted children can read only their own messages', async t => {
  const f = fixture(t); appendMessage(f.db, { conversationId: f.a.id, role: 'user', content: 'PARENT_PRIVATE' });
  appendMessage(f.db, { conversationId: f.child.id, role: 'user', content: 'CHILD_OWN_TEXT' });
  const tool = createRecallTool(f.db); assert.equal(tool.kind, 'read_only'); assert.equal(tool.preferredMode, 'lazy');
  for (const mode of PERMISSION_MODES) assert.equal(createSurface(f.tools, mode).canCall('recall'), true);
  const surface = createSurface(f.tools, 'readonly', new Map(), 'subagent'); assert.equal(surface.canCall('recall'), true);
  const own = body<RecallMessagePage>(await surface.execute('recall', { mode: 'message', seq: 1 }, { ...f.ctx(f.child.id), agentRole: 'subagent' }));
  assert.match(own.text, /CHILD_OWN_TEXT/); assert.doesNotMatch(own.text, /PARENT_PRIVATE/);
  const escape = await surface.execute('recall', { mode: 'message', seq: 1, conversationId: f.a.id }, { ...f.ctx(f.child.id), agentRole: 'subagent' }); assert.equal(escape.ok, false);
});

test('runtime child sharing a main ID cannot use recall to retrieve pre-delegation parent history', async t => {
  const f = fixture(t); appendMessage(f.db, { conversationId: f.a.id, role: 'user', content: 'OLD_MAIN_PRIVATE' });
  const current = appendMessage(f.db, { conversationId: f.a.id, role: 'user', content: 'CURRENT_DELEGATION' });
  const ctx: ToolContext = { ...f.ctx(), agentRole: 'subagent', turnUserSeq: current.seq };
  const surface = createSurface(f.tools, 'readonly', new Map(), 'subagent');
  const index = body<RecallIndex>(await surface.execute('recall', { mode: 'index' }, ctx)); assert.equal(index.total, 1); assert.equal(index.entries[0]?.seq, current.seq);
  const old = await surface.execute('recall', { mode: 'message', seq: 1 }, ctx); assert.equal(old.ok, false);
  const range = await surface.execute('recall', { from_seq: 1, to_seq: 2 }, ctx); assert.equal(range.ok, true); if (range.ok) { assert.match(range.content, /CURRENT_DELEGATION/); assert.doesNotMatch(range.content, /OLD_MAIN_PRIVATE/); }
  const own = body<RecallMessagePage>(await surface.execute('recall', { mode: 'message', seq: current.seq }, ctx)); assert.match(own.text, /CURRENT_DELEGATION/);
  const noBoundary = await surface.execute('recall', { mode: 'index' }, { ...f.ctx(), agentRole: 'subagent' }); assert.equal(noBoundary.ok, false);
});

test('recall service and tool repeated reads produce zero SQLite writes and no model requests', async t => {
  const f = fixture(t); appendMessage(f.db, { conversationId: f.a.id, role: 'user', content: 'original read-only data' });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected model request'); });
  const before = Number(f.db.prepare('SELECT total_changes() AS n').get()?.n);
  for (let i = 0; i < 3; i++) { getRecallIndex(f.db, f.a.id); getRecallMessage(f.db, f.a.id, { seq: 1 }); await f.tools.execute('recall', { mode: 'message', seq: 1 }, f.ctx()); }
  assert.equal(Number(f.db.prepare('SELECT total_changes() AS n').get()?.n), before); assert.equal(fetchMock.mock.callCount(), 0);
});

test('GET recall index and message pages are purely local, preserve source rows and cannot substitute a foreign conversation field', async t => {
  const f = fixture(t); appendMessage(f.db, { conversationId: f.a.id, role: 'user', content: 'HTTP_ORIGINAL_LONG_'.repeat(2000) + 'HTTP_LONG_TAIL' });
  appendMessage(f.db, { conversationId: f.b.id, role: 'user', content: 'FOREIGN_HTTP_PRIVATE' });
  const config = loadConfig({ ALKAID_HOME: join(tmpdir(), `alkaid-recall-unused-${randomUUID()}`) }); const app = buildServer({ db: f.db, config });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  try {
    const beforeRows = JSON.stringify(listMessages(f.db, f.a.id)); const before = Number(f.db.prepare('SELECT total_changes() AS n').get()?.n);
    const index = await app.inject({ url: `/api/conversations/${f.a.id}/recall?mode=index` }); assert.equal(index.statusCode, 200, index.body); assert.equal((index.json() as RecallIndex).total, 1); assert.doesNotMatch(index.body, /HTTP_ORIGINAL_LONG|FOREIGN_HTTP_PRIVATE/);
    let result = '', offset = 0;
    for (;;) { const response = await app.inject({ url: `/api/conversations/${f.a.id}/recall?mode=message&seq=1&charOffset=${offset}&maxChars=10000` }); assert.equal(response.statusCode, 200, response.body); const page = response.json() as RecallMessagePage; result += page.text; if (page.done) break; offset = page.nextOffset!; }
    assert.equal(result, JSON.stringify(listMessages(f.db, f.a.id)[0]));
    const forbidden = await app.inject({ url: `/api/conversations/${f.a.id}/recall?mode=message&seq=1&conversationId=${f.b.id}` }); assert.equal(forbidden.statusCode, 400);
    assert.equal(Number(f.db.prepare('SELECT total_changes() AS n').get()?.n), before); assert.equal(JSON.stringify(listMessages(f.db, f.a.id)), beforeRows); assert.equal(fetchMock.mock.callCount(), 0);
  } finally { await app.close(); }
});
