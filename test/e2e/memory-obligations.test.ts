import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { beginObligation, exemptObligation, finishObligation, noteObligationBusiness } from '../../src/core/memory/obligations.ts';
import { MEMORY_OBLIGATIONS_SCHEMA_SQL } from '../../src/core/memory/obligations-schema.ts';
import { submitProposal } from '../../src/core/memory/store.ts';
import { appendMessage, insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';
import type { ObligationPage, ResolveObligationResult } from '../../src/shared/memory-obligations.ts';

async function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db); db.exec(MEMORY_OBLIGATIONS_SCHEMA_SQL);
  insertProject(db, { id: 'ob-http', name: 'HTTP project', sharedDir: 'unused' });
  insertProject(db, { id: 'ob-http-other', name: 'Other', sharedDir: 'unused' });
  const p = insertProvider(db, { name: 'never-called', baseUrl: 'https://never-contact.invalid' });
  const a = insertConversation(db, { projectId: 'ob-http', providerId: p.id, model: 'offline' }).id;
  const b = insertConversation(db, { projectId: 'ob-http', providerId: p.id, model: 'offline' }).id;
  const foreign = insertConversation(db, { projectId: 'ob-http-other', providerId: p.id, model: 'offline' }).id;
  const app = buildServer({ db, config: loadConfig({ ALKAID_HOME: join(tmpdir(), `unused-ob-http-${randomUUID()}`) }) });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await app.close(); db.close(); });
  const base = '/api/projects/ob-http/memory/obligations';
  async function request<T>(path = base, method = 'GET', body?: unknown) {
    const response = await fetch(`${origin}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  function start(conv = a) { const u = appendMessage(db, { conversationId: conv, role: 'user', content: 'Actual user work, not copied into obligation events.' }); beginObligation(db, conv, u.seq); return u.seq; }
  function save(type: 'progress' | 'triage', conv = a) {
    const call = randomUUID(), name = type === 'progress' ? 'memory_propose' : 'memory_stage';
    appendMessage(db, { conversationId: conv, role: 'assistant', toolCalls: [{ id: call, name, arguments: '{}' }] });
    const proposal = submitProposal(db, { conversationId: conv, recordId: type === 'progress' ? randomUUID() : `artifact:triage:${randomUUID()}`, kind: type === 'progress' ? 'active' : 'note', title: type,
      operation: 'upsert', content: type === 'progress' ? 'Progress full body' : JSON.stringify({ $memory: 'triage', keep: [{ what: 'Keep full body' }], stash: [], drop: [] }), baseRevision: 0, reason: 'verified', idempotencyKey: randomUUID() });
    const receipt = appendMessage(db, { conversationId: conv, role: 'tool', toolCallId: call, displayChannel: 'maintenance', content: JSON.stringify({ ok: true, content: JSON.stringify({ proposal, staged: true, applied: false }) }) });
    return { proposal, messageSeq: receipt.seq };
  }
  return { db, app, a, b, foreign, base, request, start, save };
}

test('HTTP obligations: project aggregate keeps old debt, later exemption cannot hide it, GET is zero-write with no body copies', async t => {
  const f = await fixture(t); const old = f.start(); finishObligation(f.db, f.a, old, 'incomplete');
  const next = f.start(); exemptObligation(f.db, f.a, next, 'Clarification only; model declaration, not a semantic proof.');
  const before = f.db.prepare('SELECT total_changes() AS n').get()?.['n'];
  const page = await f.request<ObligationPage>(); assert.equal(page.status, 200);
  assert.equal(page.body.total, 1); assert.equal(page.body.entries[0]?.userSeq, old); assert.equal(page.body.summary.exempt, 1);
  assert.equal(page.body.summary.incomplete, 1); assert.equal(page.body.summary.total, 2);
  const repeats = await f.request<ObligationPage>(); assert.deepEqual(repeats.body, page.body);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.['n'], before);
  assert.doesNotMatch(JSON.stringify(page.body), /Actual user work|Progress full body|Keep full body/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get()?.['n'], 0);
});

test('HTTP obligations: user skip requires explicit short reason, waits for idle, and never applies or generates memory', async t => {
  const f = await fixture(t); const u = f.start();
  f.db.prepare("UPDATE conversations SET state='running' WHERE id=?").run(f.a);
  assert.equal((await f.request(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: u, action: 'skip', reason: 'User reviewed and skips this old obligation.' })).status, 409);
  f.db.prepare("UPDATE conversations SET state='idle' WHERE id=?").run(f.a);
  for (const reason of [undefined, '', 'api_key=SYNTHETIC_CREDENTIAL_12345']) {
    const response = await f.request<{ error: string }>(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: u, action: 'skip', reason });
    assert.equal(response.status, 400); assert.doesNotMatch(response.body.error, /SYNTHETIC_CREDENTIAL/);
  }
  const saved = await f.request<ResolveObligationResult>(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: u, action: 'skip', reason: 'User explicitly declines recording this reviewed turn.' });
  assert.equal(saved.status, 200); assert.equal(saved.body.obligation.status, 'exempt'); assert.equal(saved.body.obligation.reasonSource, 'user');
  assert.equal(saved.body.summary.exempt, 1); assert.equal((await f.request<ObligationPage>()).body.total, 0);
  for (const table of ['memory_proposals','memory_records','memory_jobs']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n'], 0);
});

test('HTTP obligations: reconcile rejects fake IDs atomically, accepts genuine saved dual receipts pending independent review', async t => {
  const f = await fixture(t); const u = f.start(); const p = f.save('progress'), triage = f.save('triage');
  const bad = await f.request(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: u, action: 'reconcile', proposalIds: [p.proposal.id, 'fake'] });
  assert.equal(bad.status, 404); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_obligation_evidence').get()?.['n'], 0);
  const saved = await f.request<ResolveObligationResult>(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: u, action: 'reconcile', proposalIds: [p.proposal.id, triage.proposal.id] });
  assert.equal(saved.status, 200); assert.equal(saved.body.obligation.status, 'staged'); assert.equal(saved.body.summary.staged, 1);
  assert.deepEqual(saved.body.obligation.missing, []);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get()?.['n'], 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE status='pending'").get()?.['n'], 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get()?.['n'], 0);
});

test('HTTP obligations: later readonly work makes both prior proposal receipts stale; reconcile cannot just declare completed', async t => {
  const f = await fixture(t); const u = f.start(); const p = f.save('progress'), triage = f.save('triage');
  const call = randomUUID(); appendMessage(f.db, { conversationId: f.a, role: 'assistant', toolCalls: [{ id: call, name: 'read', arguments: '{}' }] });
  const message = appendMessage(f.db, { conversationId: f.a, role: 'tool', toolCallId: call, content: JSON.stringify({ ok: true, content: 'additional factual observation' }) });
  noteObligationBusiness(f.db, f.a, u, message.seq, false);
  const no = await f.request(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: u, action: 'reconcile', proposalIds: [p.proposal.id, triage.proposal.id] });
  assert.equal(no.status, 409); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_obligation_evidence').get()?.['n'], 0);
  const freshP = f.save('progress'), freshT = f.save('triage');
  const ok = await f.request<ResolveObligationResult>(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: u, action: 'reconcile', proposalIds: [freshP.proposal.id, freshT.proposal.id] });
  assert.equal(ok.status, 200); assert.equal(ok.body.obligation.status, 'staged');
});

test('HTTP obligations: legacy errors and zero-user debt project as needs_review, explicit skip preserves source without GET migration', async t => {
  const f = await fixture(t);
  for (const [u, code] of [[0,'progress_not_recorded'],[99,'progress_recorded']] as const) f.db.prepare('INSERT INTO memory_turn_debts(conversation_id,user_seq,code,created_at) VALUES(?,?,?,?)').run(f.a, u, code, new Date().toISOString());
  const before = f.db.prepare('SELECT total_changes() AS n').get()?.['n'];
  const page = await f.request<ObligationPage>(`${f.base}?status=needs_review`);
  assert.equal(page.body.total, 2); assert.equal(page.body.summary.needsReview, 2);
  assert.ok(page.body.entries.every(e => e.legacy && e.needsReview && e.missing.length === 0));
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.['n'], before);
  const skip = await f.request<ResolveObligationResult>(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: 0, action: 'skip', reason: 'User reviewed the historic failure and requests no follow-up.' });
  assert.equal(skip.status, 200); assert.equal(skip.body.obligation.legacy, true); assert.equal(skip.body.obligation.needsReview, false);
  assert.equal(skip.body.summary.needsReview, 1); assert.equal(skip.body.summary.exempt, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_obligations').get()?.['n'], 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_turn_debts').get()?.['n'], 2);
});

test('HTTP obligations: filters and pages do not narrow whole-project summary, and all project/source IDs are scoped', async t => {
  const f = await fixture(t); const a = f.start(); finishObligation(f.db, f.a, a, 'incomplete');
  const b = f.start(f.b); exemptObligation(f.db, f.b, b, 'Only clarified the request without reusable project knowledge.');
  const page = await f.request<ObligationPage>(`${f.base}?includeResolved=true&conversationId=${f.b}&status=exempt&limit=1&offset=0`);
  assert.equal(page.status, 200); assert.equal(page.body.total, 1); assert.equal(page.body.entries[0]?.conversationId, f.b);
  assert.equal(page.body.summary.incomplete, 1); assert.equal(page.body.summary.exempt, 1); assert.equal(page.body.summary.total, 2);
  assert.equal((await f.request(`${f.base}?conversationId=${f.foreign}`)).status, 404);
  assert.equal((await f.request(`/api/projects/ob-http-other/memory/obligations/resolve`, 'POST', { conversationId: f.a, userSeq: a, action: 'skip', reason: 'foreign' })).status, 404);
  for (const suffix of ['?status=fake','?limit=101','?offset=-1','?includeResolved=1','?unknown=1']) assert.equal((await f.request(`${f.base}${suffix}`)).status, 400);
  assert.equal((await f.request(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: a, action: 'retry_model' })).status, 400);
  assert.equal((await f.request(`${f.base}/resolve`, 'POST', { conversationId: f.a, userSeq: a, action: 'skip', reason: 'user', actor: 'model' })).status, 400);
});
