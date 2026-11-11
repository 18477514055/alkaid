import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { getMemoryView } from '../../src/core/memory/store.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';
import type { MemoryProposal } from '../../src/shared/memory.ts';
import type { ArchivePage, ArchiveSnapshot, GoalTree, LessonSearch, MemoryIndex, PreservedView } from '../../src/shared/memory-records.ts';

async function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db);
  insertProject(db, { id: 'http-p', name: 'HTTP project', sharedDir: 'unused' });
  insertProject(db, { id: 'http-other', name: 'Other', sharedDir: 'unused' });
  const provider = insertProvider(db, { name: 'never-called', baseUrl: 'https://never-contact.invalid' });
  const a = insertConversation(db, { projectId: 'http-p', providerId: provider.id, model: 'offline' }).id;
  const b = insertConversation(db, { projectId: 'http-p', providerId: provider.id, model: 'offline' }).id;
  const foreign = insertConversation(db, { projectId: 'http-other', providerId: provider.id, model: 'offline' }).id;
  // No home is created: memory is the real in-memory SQLite database, not workspace files.
  const config = loadConfig({ ALKAID_HOME: join(tmpdir(), `unused-memory-record-http-${randomUUID()}`) });
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ db, config });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await app.close(); db.close(); });
  const base = '/api/projects/http-p/memory';
  async function request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; value: T }> {
    const response = await fetch(`${origin}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as T };
  }
  async function propose(patch: Record<string, unknown> = {}, expected = 201): Promise<MemoryProposal> {
    const result = await request<MemoryProposal>('POST', `${base}/proposals`, {
      conversationId: a, recordId: 'note', kind: 'note', title: 'Note', operation: 'upsert', content: 'Full original HTTP note',
      baseRevision: 0, reason: 'Explicit user confirmation', idempotencyKey: randomUUID(), ...patch,
    });
    assert.equal(result.status, expected, JSON.stringify(result.value)); return result.value;
  }
  async function accept(id: string) {
    const response = await request('POST', `${base}/proposals/${id}/accept`);
    assert.equal(response.status, 200, JSON.stringify(response.value));
  }
  return { db, a, b, foreign, base, origin, request, propose, accept };
}

test('HTTP archive: five full versions, exact before snapshot, time/version paging and mutation refusal', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) { const p = await f.propose({ content: `HTTP完整第${i + 1}版\n${'正文尾部🙂'.repeat(10)}`, baseRevision: i }); await f.accept(p.id); }
  const list = await f.request<ArchivePage>('GET', `${f.base}/archive?recordId=note&revision=3&limit=1&offset=0`);
  assert.equal(list.status, 200); assert.equal(list.value.total, 1);
  const id = list.value.entries[0]!.id;
  const full = await f.request<ArchiveSnapshot>('GET', `${f.base}/archive/${id}?side=before`);
  assert.equal(full.status, 200);
  assert.equal(full.value.snapshot?.content, `HTTP完整第2版\n${'正文尾部🙂'.repeat(10)}`);
  for (const method of ['DELETE', 'PUT', 'PATCH']) {
    const refused = await f.request<{ error: string }>(method, `${f.base}/archive/${id}`);
    assert.equal(refused.status, 409); assert.match(refused.value.error, /只允许追加/);
  }
  const time = await f.request<ArchivePage>('GET', `${f.base}/archive?from=2000-01-01&to=2100-01-01`);
  assert.equal(time.value.total, 5);
  assert.equal((await f.request('GET', `${f.base}/archive?limit=201`)).status, 400);
  assert.equal((await f.request('GET', `${f.base}/archive/${id}?side=invalid`)).status, 400);
  assert.equal((await f.request('GET', `/api/projects/http-other/memory/archive/${id}`)).status, 404);
});

test('HTTP goals/lessons: structured proposals require independent acceptance; trees and full searchable entries work', async t => {
  const f = await fixture(t);
  for (const [id, parent, state] of [['root', null, 'root'], ['child', 'root', 'active'], ['grand', 'child', 'done']] as const) {
    const p = await f.propose({ recordId: id, kind: 'goal', content: JSON.stringify({ parentId: parent, state, keyResults: ['可验证结果'], lessons: state === 'done' ? ['保留重要教训'] : [] }) });
    if (id === 'root') assert.equal((await f.request<GoalTree>('GET', `${f.base}/goals`)).value.nodes.length, 0);
    await f.accept(p.id);
  }
  const tree = await f.request<GoalTree>('GET', `${f.base}/goals`);
  assert.equal(tree.status, 200); assert.equal(tree.value.nodes.find(n => n.record.id === 'grand')?.depth, 2);
  assert.deepEqual(tree.value.issues, []);
  const p = await f.propose({ recordId: 'lesson', kind: 'lesson', content: JSON.stringify({ type: 'lesson', category: '记录错', rootCause: '把代理证据当成运行验证', body: '完整正文只在这里出现的HTTP特殊词', fix: '运行真实请求链' }) });
  await f.accept(p.id);
  const search = await f.request<LessonSearch>('GET', `${f.base}/lessons?type=lesson&category=${encodeURIComponent('记录错')}&q=${encodeURIComponent('HTTP特殊词')}`);
  assert.equal(search.status, 200); assert.equal(search.value.entries.length, 1);
  assert.match(search.value.entries[0]!.rendered, /代理证据/);
  assert.match(search.value.entries[0]!.rendered, /完整正文/);
  assert.equal((await f.request<LessonSearch>('GET', '/api/projects/http-other/memory/lessons')).value.entries.length, 0);
});

test('HTTP validation: Chinese root cause/source/conclusion errors and no cross-project source writes', async t => {
  const f = await fixture(t);
  for (const [kind, content, pattern] of [
    ['lesson', { type: 'lesson', category: '其他', body: 'a', fix: 'b' }, /根因/],
    ['lesson', { type: 'experience', category: '其他', body: 'a', fix: 'b' }, /出处/],
    ['note', { type: 'problem', body: 'a' }, /根因/],
    ['note', { type: 'research', body: 'a' }, /结论/],
  ] as const) {
    const response = await f.request<{ error: string }>('POST', `${f.base}/proposals`, {
      conversationId: f.a, recordId: randomUUID(), kind, title: 'Invalid', content: JSON.stringify(content), operation: 'upsert', baseRevision: 0, reason: 'Evidence', idempotencyKey: randomUUID(),
    });
    assert.equal(response.status, 400); assert.match(response.value.error, pattern);
  }
  await f.propose({ conversationId: f.foreign }, 400);
  await f.propose({ conversationId: 'missing' }, 404);
  await f.propose({ kind: 'principle' }, 400);
  const p = await f.propose({ content: JSON.stringify({ type: 'problem', body: 'Failure', rootCause: 'Verified root cause' }) });
  assert.match(JSON.parse(p.content).documentName, /^\d{4}-\d{2}-\d{2}-Note-.+\.md$/);
  assert.equal(getMemoryView(f.db, 'http-p').records.length, 0);
});

test('HTTP note download: official structured Markdown and UTF8 system name only, no pending or foreign export', async t => {
  const f = await fixture(t);
  const p = await f.propose({ recordId: 'note:中文', title: '中文问题笔记', content: JSON.stringify({ type: 'problem', body: '完整笔记正文🙂', rootCause: '已验证的根因' }) });
  const path = `${f.base}/notes/${encodeURIComponent(p.recordId)}/download`;
  assert.equal((await fetch(`${f.origin}${path}`)).status, 404);
  await f.accept(p.id);
  const revision = getMemoryView(f.db, 'http-p').revision;
  const download = await fetch(`${f.origin}${path}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type')!, /text\/markdown.*charset=utf-8/i);
  const disposition = download.headers.get('content-disposition')!;
  assert.match(disposition, /attachment;.*filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!), JSON.parse(p.content).documentName);
  const markdown = await download.text();
  assert.match(markdown, /# 中文问题笔记/); assert.match(markdown, /完整笔记正文🙂/); assert.match(markdown, /根因：已验证的根因/);
  assert.equal(getMemoryView(f.db, 'http-p').revision, revision);
  assert.equal(getMemoryView(f.db, 'http-p').jobs.length, 0);
  assert.equal((await fetch(`${f.origin}/api/projects/http-other/memory/notes/${encodeURIComponent(p.recordId)}/download`)).status, 404);
  const plain = await f.propose({ recordId: 'plain', content: 'unstructured legacy note' }); await f.accept(plain.id);
  assert.equal((await fetch(`${f.origin}${f.base}/notes/plain/download`)).status, 400);
  const deleted = await f.propose({ recordId: p.recordId, baseRevision: 1, operation: 'delete', content: '' }); await f.accept(deleted.id);
  assert.equal((await fetch(`${f.origin}${path}`)).status, 404);
});

test('HTTP preserved A/B: distinct provenance, fresh pending merge then accept clears active region without deleting originals', async t => {
  const f = await fixture(t);
  const A = 'A完整HTTP正文\n原文最后一字🙂'; const B = 'B完整HTTP正文\n并发进展';
  const first = await f.propose({ content: A }); await f.accept(first.id);
  const second = await f.propose({ conversationId: f.b, content: B });
  assert.equal((await f.request('POST', `${f.base}/proposals/${second.id}/accept`)).status, 409);
  const preserved = await f.request<PreservedView>('GET', `${f.base}/preserved`);
  assert.equal(preserved.status, 200); assert.equal(preserved.value.entries.length, 1);
  const entry = preserved.value.entries[0]!;
  assert.equal(entry.current.content, A); assert.equal(entry.proposal.content, B);
  assert.deepEqual(entry.sourceConversationIds, [f.a]); assert.equal(entry.proposal.conversationId, f.b);
  const merged = await f.request<MemoryProposal>('POST', `${f.base}/preserved/merge`, {
    preservedIds: [entry.id], conversationId: f.b, recordId: 'note', title: 'Merged', content: `${A}\n\n${B}`, reason: 'Reviewed both originals', idempotencyKey: 'merge',
  });
  assert.equal(merged.status, 201); assert.equal(merged.value.baseRevision, 1); assert.equal(merged.value.status, 'pending');
  assert.equal(getMemoryView(f.db, 'http-p').records[0]?.content, A);
  await f.accept(merged.value.id);
  assert.equal((await f.request<PreservedView>('GET', `${f.base}/preserved`)).value.entries.length, 0);
  const history = await f.request<PreservedView>('GET', `${f.base}/preserved?includeResolved=true`);
  assert.equal(history.value.entries[0]?.current.content, A); assert.equal(history.value.entries[0]?.proposal.content, B);
  assert.equal(history.value.entries[0]?.resolution?.mergeProposalId, merged.value.id);
  assert.equal(getMemoryView(f.db, 'http-p').records[0]?.content, `${A}\n\n${B}`);
});

test('HTTP index and archive/structure reads are deterministic, local and never create AI jobs', async t => {
  const f = await fixture(t);
  await f.accept((await f.propose({ recordId: 'b' })).id);
  await f.accept((await f.propose({ recordId: 'a', kind: 'decision' })).id);
  const index = await f.request<MemoryIndex>('GET', `${f.base}/index`);
  assert.equal(index.status, 200); assert.equal(index.value.rows.length, 2);
  assert.deepEqual((await f.request<MemoryIndex>('GET', `${f.base}/index`)).value, index.value);
  for (const path of ['archive', 'goals', 'lessons', 'index', 'preserved']) assert.equal((await f.request('GET', `${f.base}/${path}`)).status, 200);
  assert.equal(getMemoryView(f.db, 'http-p').jobs.length, 0);
  assert.equal((await f.request('GET', '/api/projects/unknown/memory/index')).status, 404);
});
