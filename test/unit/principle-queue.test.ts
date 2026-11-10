import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ensureHome, loadConfig } from '../../src/config.ts';
import { HumanApprovalBroker, getCurrentPrinciples, getWorkbenchView, listPrincipleProposals, proposePrinciple } from '../../src/core/memory/workbench.ts';
import { applyProposalManually, getMemoryView, getProjectRevision, submitProposal } from '../../src/core/memory/store.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProject, insertProvider, updateConversation } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';
import type { PrincipleProposal } from '../../src/shared/memory-workbench.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-principle-queue-'));
  const config = loadConfig({ ALKAID_HOME: home }); ensureHome(config);
  const db = openDatabase(config.dbPath); migrate(db);
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  const project = insertProject(db, { id: randomUUID(), name: 'A', sharedDir: join(home, 'never-write-workspace') });
  const other = insertProject(db, { id: randomUUID(), name: 'B', sharedDir: join(home, 'never-write-other') });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'offline', projectId: project.id });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Principle queue must never request a model'); });
  t.after(() => { assert.equal(fetchMock.mock.callCount(), 0); db.close(); rmSync(home, { recursive: true, force: true }); });
  const input = { recordId: 'P1', title: 'Human rule', content: '  Exact proposed wording\n原文不改  ', operation: 'upsert' as const, baseRevision: 0 };
  return { db, config, project, other, conversation, input };
}

function approve(f: ReturnType<typeof fixture>, proposal: PrincipleProposal): void {
  const broker = new HumanApprovalBroker();
  broker.resolve(f.db, f.project.id, proposal.id, 'approve', broker.issueIntent(f.db, f.project.id, proposal.id, 'approve').capability);
}

test('program checks and queues a single-source principle without models or official writes', t => {
  const f = fixture(t); updateConversation(f.db, f.conversation.id, { state: 'running' });
  const revision = getProjectRevision(f.db, f.project.id);
  const proposal = proposePrinciple(f.db, f.project.id, f.input);
  assert.equal(proposal.status, 'pending'); assert.equal(proposal.content, f.input.content);
  assert.equal(proposal.review?.processor, 'program'); assert.equal(proposal.review?.status, 'ready');
  assert.equal(proposal.review?.currentRevision, 0);
  assert.deepEqual(proposal.review?.checks.map(row => [row.code, row.status]), [
    ['shape', 'pass'], ['credentials', 'pass'], ['baseline', 'pass'], ['pending_conflict', 'pass'], ['change', 'pass'], ['semantic', 'unknown'],
  ]);
  assert.match(proposal.review?.summary ?? '', /等待用户最终审批/);
  assert.match(proposal.review?.checks.find(row => row.code === 'semantic')?.message ?? '', /暂不审批不影响当前任务/);
  assert.equal(getProjectRevision(f.db, f.project.id), revision);
  assert.equal(getCurrentPrinciples(f.db, f.project.id).text, '');
  assert.equal(getMemoryView(f.db, f.project.id).jobs.length, 0);
  assert.equal(getMemoryView(f.db, f.project.id).records.length, 0);
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM memory_events').all()), /Exact proposed wording/);
});

test('same pending request is idempotent across repeated calls and key order while remaining project-scoped', t => {
  const f = fixture(t);
  const first = proposePrinciple(f.db, f.project.id, f.input);
  const second = proposePrinciple(f.db, f.project.id, { baseRevision: 0, operation: 'upsert', content: f.input.content, title: f.input.title, recordId: 'P1' });
  const third = proposePrinciple(f.db, f.project.id, f.input);
  assert.equal(first.id, second.id); assert.equal(second.id, third.id);
  assert.equal(first.createdAt, third.createdAt); assert.equal(listPrincipleProposals(f.db, f.project.id).length, 1);
  const elsewhere = proposePrinciple(f.db, f.other.id, f.input);
  assert.notEqual(elsewhere.id, first.id);
  assert.equal(getWorkbenchView(f.db, f.project.id).counts.pendingPrinciples, 1);
  assert.equal(getWorkbenchView(f.db, f.other.id).counts.pendingPrinciples, 1);
  assert.deepEqual(first.review, third.review);
});

test('empty fields, credentials, invalid targets and unknown input fields are rejected before queue insertion', t => {
  const f = fixture(t);
  for (const input of [
    { ...f.input, title: '   ' }, { ...f.input, content: '' }, { ...f.input, recordId: '' },
    { ...f.input, content: 'api_key=0123456789testfixture' }, { ...f.input, recordId: 'artifact:handoff:fake' },
    { ...f.input, actor: 'human' }, { ...f.input, operation: 'approve' },
  ]) assert.throws(() => proposePrinciple(f.db, f.project.id, input), (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
  assert.equal(listPrincipleProposals(f.db, f.project.id).length, 0);
  assert.equal(getCurrentPrinciples(f.db, f.project.id).records.length, 0);
});

test('different requests for one target are visibly flagged, not semantically selected or approved', t => {
  const f = fixture(t);
  const first = proposePrinciple(f.db, f.project.id, f.input);
  const second = proposePrinciple(f.db, f.project.id, { ...f.input, content: 'Different proposed rule' });
  assert.notEqual(first.id, second.id); assert.equal(second.review?.status, 'needs_attention');
  const queue = listPrincipleProposals(f.db, f.project.id);
  assert.equal(queue.length, 2);
  assert.ok(queue.every(row => row.review?.checks.find(check => check.code === 'pending_conflict')?.status === 'warning'));
  assert.ok(queue.every(row => row.review?.checks.find(check => check.code === 'semantic')?.status === 'unknown'));
  assert.equal(getCurrentPrinciples(f.db, f.project.id).text, '');
});

test('review rechecks current baseline and human approval retains final CAS', t => {
  const f = fixture(t);
  const first = proposePrinciple(f.db, f.project.id, f.input);
  const stale = proposePrinciple(f.db, f.project.id, { ...f.input, content: 'Stale request stays pending' });
  approve(f, first);
  const refreshed = listPrincipleProposals(f.db, f.project.id)[0]!;
  assert.equal(refreshed.id, stale.id); assert.equal(refreshed.review?.currentRevision, 1);
  assert.equal(refreshed.review?.status, 'needs_attention');
  assert.equal(refreshed.review?.checks.find(row => row.code === 'baseline')?.status, 'warning');
  assert.throws(() => approve(f, refreshed), /revision changed/);
  assert.equal(getCurrentPrinciples(f.db, f.project.id).records[0]?.content, f.input.content);
  assert.equal(listPrincipleProposals(f.db, f.project.id)[0]?.id, stale.id);
  assert.equal(getCurrentPrinciples(f.db, f.project.id).approvals.length, 1);
});

test('no-op and missing deletion targets are clearly marked for attention, never silently dropped', t => {
  const f = fixture(t); approve(f, proposePrinciple(f.db, f.project.id, f.input));
  const unchanged = proposePrinciple(f.db, f.project.id, { ...f.input, baseRevision: 1 });
  const missing = proposePrinciple(f.db, f.project.id, { ...f.input, recordId: 'missing', operation: 'delete', content: '' });
  for (const proposal of [unchanged, missing]) {
    assert.equal(proposal.review?.status, 'needs_attention');
    assert.equal(proposal.review?.checks.find(row => row.code === 'change')?.status, 'warning');
    assert.equal(proposal.status, 'pending');
  }
  assert.equal(listPrincipleProposals(f.db, f.project.id).length, 2);
});

test('deferred human decision does not block normal memory progress or require two conversations', t => {
  const f = fixture(t); proposePrinciple(f.db, f.project.id, f.input);
  const ordinary = submitProposal(f.db, { conversationId: f.conversation.id, recordId: 'active-progress', kind: 'active', title: 'Current work', content: 'Continue the actual task while the user decides', operation: 'upsert', baseRevision: 0, reason: 'ordinary task progress', idempotencyKey: 'normal-progress' });
  applyProposalManually(f.db, f.project.id, ordinary.id);
  assert.equal(getMemoryView(f.db, f.project.id).records.find(row => row.id === 'active-progress')?.content, ordinary.content);
  assert.equal(listPrincipleProposals(f.db, f.project.id).length, 1);
  assert.equal(getCurrentPrinciples(f.db, f.project.id).records.length, 0);
  assert.equal(getMemoryView(f.db, f.project.id).jobs.length, 0);
});

test('existing HTTP propose and list return program review without adding a model endpoint', async t => {
  const f = fixture(t); const app = buildServer({ db: f.db, config: f.config });
  try {
    const url = `/api/projects/${f.project.id}/memory/principles/proposals`;
    const first = await app.inject({ method: 'POST', url, payload: f.input });
    assert.equal(first.statusCode, 201, first.body);
    const replay = await app.inject({ method: 'POST', url, payload: f.input });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal((first.json() as PrincipleProposal).id, (replay.json() as PrincipleProposal).id);
    const listed = await app.inject({ method: 'GET', url });
    const queue = listed.json() as PrincipleProposal[];
    assert.equal(queue.length, 1); assert.equal(queue[0]?.review?.processor, 'program');
    assert.equal(queue[0]?.review?.checks.find(row => row.code === 'semantic')?.status, 'unknown');
    const denied = await app.inject({ method: 'POST', url: `${url}/${queue[0]!.id}/approve`, payload: { actor: 'human' } });
    assert.equal(denied.statusCode, 403);
    assert.equal(getCurrentPrinciples(f.db, f.project.id).text, '');
  } finally { await app.close(); }
});
