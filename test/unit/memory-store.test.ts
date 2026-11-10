import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { MEMORY_SCHEMA_SQL } from '../../src/core/memory/schema.ts';
import {
  applyMergePlan, applyProposalManually, claimMergeJob, finishMergeJob, getMemoryView,
  getProjectRevision, recoverExpiredMergeJobs, rejectProposal, retryFailedMergeJobs, setMaintainerConfig, submitProposal,
} from '../../src/core/memory/store.ts';
import type { MemoryProposal, MergeDecision, SubmitMemoryProposal } from '../../src/shared/memory.ts';

function fixture(run: (f: { db: DatabaseSync; conv: string; other: string; provider: string }) => void): void {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  db.exec(MEMORY_SCHEMA_SQL);
  db.exec(MEMORY_SCHEMA_SQL); // Migration fragment is safe for fresh/repeated integration.
  const now = new Date().toISOString();
  for (const id of ['a', 'b']) db.prepare('INSERT INTO projects(id,name,shared_dir,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, id, 'unused', now, now);
  const provider = insertProvider(db, { name: 'test', baseUrl: 'https://invalid.test' }).id;
  const conv = insertConversation(db, { projectId: 'a', providerId: provider, model: 'test' }).id;
  const other = insertConversation(db, { projectId: 'b', providerId: provider, model: 'test' }).id;
  try { run({ db, conv, other, provider }); } finally { db.close(); }
}
function input(conv: string, patch: Partial<SubmitMemoryProposal> = {}): SubmitMemoryProposal {
  return {
    conversationId: conv, recordId: 'r', kind: 'note', title: 'Note', operation: 'upsert',
    content: 'Supported fact', baseRevision: 0, reason: 'User explicitly confirmed in this conversation',
    idempotencyKey: 'key', ...patch,
  };
}
function decision(p: MemoryProposal, patch: Partial<MergeDecision> = {}): MergeDecision {
  return { recordId: p.recordId, proposalIds: [p.id], action: p.operation, kind: p.kind, title: p.title, content: p.content, reason: p.reason, ...patch };
}
function status(code: number): (e: unknown) => boolean {
  return e => e instanceof Error && (e as Error & { statusCode: number }).statusCode === code;
}

test('memory: project isolation, proposal-only submission, readonly storage accepts pending, idempotency', () => fixture(({ db, conv, other }) => {
  db.prepare("UPDATE conversations SET permission_mode='readonly' WHERE id=?").run(conv);
  const p = submitProposal(db, input(conv));
  assert.equal(p.resourceType, 'ledger');
  assert.equal(p.status, 'pending');
  assert.deepEqual(getMemoryView(db, 'a').records, []);
  assert.equal(getProjectRevision(db, 'a'), 0);
  assert.equal(submitProposal(db, input(conv)).id, p.id);
  assert.throws(() => submitProposal(db, input(conv, { content: 'changed' })), status(409));
  submitProposal(db, input(other)); // Same key and record ID in another conversation/project are legal.
  assert.equal(getMemoryView(db, 'a').proposals.length, 1);
  assert.equal(getMemoryView(db, 'b').proposals.length, 1);
  applyProposalManually(db, 'a', p.id);
  assert.equal(getMemoryView(db, 'a').records[0]?.revision, 1);
  assert.equal(getMemoryView(db, 'b').records.length, 0);
  assert.throws(() => applyProposalManually(db, 'b', p.id), status(404));
}));

test('memory: manual CAS conflict, history before/after, soft deletion', () => fixture(({ db, conv }) => {
  const p = submitProposal(db, input(conv));
  applyProposalManually(db, 'a', p.id);
  const stale = submitProposal(db, input(conv, { idempotencyKey: 'stale', content: 'stale' }));
  assert.throws(() => applyProposalManually(db, 'a', stale.id), status(409));
  const del = submitProposal(db, input(conv, { idempotencyKey: 'del', operation: 'delete', baseRevision: 1, content: '' }));
  applyProposalManually(db, 'a', del.id);
  const view = getMemoryView(db, 'a');
  assert.equal(view.revision, 2);
  assert.equal(view.records[0]?.deleted, true);
  assert.equal(view.records[0]?.content, 'Supported fact');
  assert.equal(view.records[0]?.revision, 2);
  const history = db.prepare('SELECT * FROM memory_history ORDER BY project_revision').all();
  assert.equal(history.length, 2);
  assert.equal(history[0]?.['before_json'], null);
  assert.equal(JSON.parse(history[1]?.['before_json'] as string).revision, 1);
  assert.equal(JSON.parse(history[1]?.['after_json'] as string).deleted, true);
}));

test('memory: source must exist, bind to active project; deletion preserves submitted evidence and formal memory', () => fixture(({ db, conv, provider }) => {
  assert.throws(() => submitProposal(db, input('missing')), status(404));
  const orphan = insertConversation(db, { providerId: provider, model: 'm' }).id;
  assert.throws(() => submitProposal(db, input(orphan)), status(400));
  db.prepare("UPDATE projects SET archived_at=? WHERE id='a'").run(new Date().toISOString());
  assert.throws(() => submitProposal(db, input(conv)), status(409));
  db.exec("UPDATE projects SET archived_at=NULL WHERE id='a'");
  const p = submitProposal(db, input(conv));
  applyProposalManually(db, 'a', p.id);
  db.prepare('DELETE FROM conversations WHERE id=?').run(conv);
  assert.equal(getMemoryView(db, 'a').proposals[0]?.conversationId, conv);
  db.exec("DELETE FROM projects WHERE id='a'");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_records WHERE project_id='a'").get()?.['n'], 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE project_id='a'").get()?.['n'], 1);
}));

test('memory: kinds, principles, decision deletion and content limits are guarded', () => fixture(({ db, conv }) => {
  assert.throws(() => submitProposal(db, input(conv, { kind: 'unknown' as 'note' })), status(400));
  assert.throws(() => submitProposal(db, input(conv, { kind: 'principle' })), status(400));
  assert.throws(() => submitProposal(db, input(conv, { content: 'x'.repeat(20_001) })), status(400));
  assert.throws(() => submitProposal(db, input(conv, { reason: '' })), status(400));
  assert.throws(() => submitProposal(db, input(conv, { content: 'Bearer testcredential123456789' })), status(400));
  db.prepare('INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?)').run('a', 'human', 'principle', 'Human', 'Rule', 1, 0, new Date().toISOString());
  assert.throws(() => submitProposal(db, input(conv, { recordId: 'human' })), status(400));
  const p = submitProposal(db, input(conv, { kind: 'decision' }));
  applyProposalManually(db, 'a', p.id);
  const del = submitProposal(db, input(conv, { kind: 'decision', operation: 'delete', content: '', baseRevision: 1, idempotencyKey: 'del' }));
  assert.throws(() => applyProposalManually(db, 'a', del.id), status(409));
}));

test('memory: config validates existing provider, required model, numeric bounds, and project revision', () => fixture(({ db, provider }) => {
  assert.throws(() => setMaintainerConfig(db, 'a', { enabled: true }), status(400));
  assert.throws(() => setMaintainerConfig(db, 'a', { providerId: 'missing' }), status(400));
  assert.throws(() => setMaintainerConfig(db, 'a', { maxOutputTokens: 4097 }), status(400));
  assert.throws(() => setMaintainerConfig(db, 'a', { maxInputChars: 64001 }), status(400));
  assert.throws(() => setMaintainerConfig(db, 'a', { quietMs: 999 }), status(400));
  const patch = { enabled: true, providerId: provider, model: 'm' };
  assert.equal(setMaintainerConfig(db, 'a', patch).enabled, true);
  assert.equal(getProjectRevision(db, 'a'), 1);
  setMaintainerConfig(db, 'a', patch);
  assert.equal(getProjectRevision(db, 'a'), 1);
}));

test('memory: job uniqueness, failed fingerprint dedup, explicit retry and expired lease recovery', () => fixture(({ db, conv, provider }) => {
  submitProposal(db, input(conv));
  const job = claimMergeJob(db, 'a', 'fingerprint', provider, 'm')!;
  assert.equal(job.state, 'running');
  assert.equal(claimMergeJob(db, 'a', 'different', provider, 'm'), null);
  assert.throws(() => finishMergeJob(db, job.id, 'applied'), status(409));
  finishMergeJob(db, job.id, 'failed', 'upstream unavailable', { inputTokens: 10, outputTokens: 2 });
  assert.equal(claimMergeJob(db, 'a', 'fingerprint', provider, 'm'), null);
  retryFailedMergeJobs(db, 'a');
  const next = claimMergeJob(db, 'a', 'fingerprint', provider, 'm')!;
  assert.ok(next);
  db.prepare('UPDATE memory_jobs SET created_at=? WHERE id=?').run(new Date(Date.now() - 180_001).toISOString(), next.id);
  assert.equal(claimMergeJob(db, 'a', 'different', provider, 'm'), null);
  assert.equal(db.prepare('SELECT state FROM memory_jobs WHERE id=?').get(next.id)?.['state'], 'failed');
  assert.equal(claimMergeJob(db, 'a', 'fingerprint', provider, 'm'), null);
  assert.equal(getMemoryView(db, 'a').jobs.length, 2);
  retryFailedMergeJobs(db, 'a');
  const recovered = claimMergeJob(db, 'a', 'fingerprint', provider, 'm')!;
  assert.equal(recoverExpiredMergeJobs(db, 'a'), 0);
  db.prepare('UPDATE memory_jobs SET created_at=? WHERE id=?').run(new Date(Date.now() - 180_001).toISOString(), recovered.id);
  assert.equal(recoverExpiredMergeJobs(db, 'a'), 1);
  assert.equal(claimMergeJob(db, 'a', 'fingerprint', provider, 'm'), null);
  assert.equal(getMemoryView(db, 'a').jobs.length, 3);
}));

test('memory: merge plan groups same record, exactly covers claimed proposals, forbids invented targets', () => fixture(({ db, conv, provider }) => {
  const p = submitProposal(db, input(conv));
  const q = submitProposal(db, input(conv, { idempotencyKey: 'second', content: 'second' }));
  const job = claimMergeJob(db, 'a', 'f', provider, 'm')!;
  const ids = [p.id, q.id];
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, ids, { decisions: [decision(p)] }), status(400));
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, ids, { decisions: [decision(p), decision(q)] }), status(400));
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, ids, { decisions: [decision(p, { proposalIds: ids, recordId: 'invented' })] }), status(400));
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, ids, { decisions: [decision(p, { proposalIds: [p.id, p.id] })] }), status(400));
  applyMergePlan(db, 'a', job.id, 0, ids, { decisions: [decision(p, { proposalIds: ids, content: 'Merged' })] });
  assert.equal(getMemoryView(db, 'a').records[0]?.content, 'Merged');
  assert.ok(getMemoryView(db, 'a').proposals.every(p => p.status === 'applied'));
  finishMergeJob(db, job.id, 'applied', undefined, { inputTokens: 8, outputTokens: 3 });
  assert.equal(getMemoryView(db, 'a').jobs[0]?.inputTokens, 8);
  assert.throws(() => applyMergePlan(db, 'a', job.id, 1, ids, { decisions: [decision(p, { proposalIds: ids })] }), status(409));
}));

test('memory: newly submitted or unclaimed proposals cannot be smuggled into a running job', () => fixture(({ db, conv, provider }) => {
  const p = submitProposal(db, input(conv));
  const job = claimMergeJob(db, 'a', 'f', provider, 'm')!;
  const q = submitProposal(db, input(conv, { idempotencyKey: 'later', recordId: 'other' }));
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, [p.id, q.id], { decisions: [decision(p), decision(q)] }), status(409));
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, [q.id], { decisions: [decision(q)] }), status(409));
  applyMergePlan(db, 'a', job.id, 0, [p.id], { decisions: [decision(p)] });
  assert.equal(getMemoryView(db, 'a').proposals.find(x => x.id === q.id)?.status, 'pending');
}));

test('memory: revision races reject, stale record proposal only accepts conflict without overwriting', () => fixture(({ db, conv, provider }) => {
  const first = submitProposal(db, input(conv));
  applyProposalManually(db, 'a', first.id);
  const stale = submitProposal(db, input(conv, { idempotencyKey: 'stale', content: 'overwrite' }));
  const job = claimMergeJob(db, 'a', 'f', provider, 'm')!;
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, [stale.id], { decisions: [decision(stale)] }), status(409));
  assert.throws(() => applyMergePlan(db, 'a', job.id, 1, [stale.id], { decisions: [decision(stale)] }), status(409));
  applyMergePlan(db, 'a', job.id, 1, [stale.id], { decisions: [decision(stale, { action: 'conflict' })] });
  const view = getMemoryView(db, 'a');
  assert.equal(view.records[0]?.content, 'Supported fact');
  assert.equal(view.proposals.find(x => x.id === stale.id)?.status, 'conflict');
  assert.equal(view.jobs[0]?.state, 'conflict');
}));

test('memory: invalid plan cannot mutate principle or delete decision, and pending state is rechecked', () => fixture(({ db, conv, provider }) => {
  const p = submitProposal(db, input(conv, { kind: 'decision', operation: 'delete', content: '' }));
  const job = claimMergeJob(db, 'a', 'f', provider, 'm')!;
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, [p.id], { decisions: [decision(p, { kind: 'principle' })] }), status(400));
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, [p.id], { decisions: [decision(p)] }), status(409));
  rejectProposal(db, 'a', p.id);
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, [p.id], { decisions: [decision(p, { action: 'conflict' })] }), status(409));
  assert.equal(getMemoryView(db, 'a').records.length, 0);
}));

test('memory: principles created after submission still cannot be changed manually or by merge', () => fixture(({ db, conv, provider }) => {
  const p = submitProposal(db, input(conv));
  const job = claimMergeJob(db, 'a', 'f', provider, 'm')!;
  db.prepare('INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?)').run('a', 'r', 'principle', 'Human rule', 'Never overwrite', 1, 0, new Date().toISOString());
  assert.throws(() => applyProposalManually(db, 'a', p.id), status(400));
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, [p.id], { decisions: [decision(p, { action: 'conflict' })] }), status(400));
  assert.equal(getMemoryView(db, 'a').records[0]?.content, 'Never overwrite');
}));

test('memory: pending queue is bounded and all pending proposals remain visible', () => fixture(({ db, conv }) => {
  for (let i = 0; i < 200; i++) submitProposal(db, input(conv, { idempotencyKey: `key-${i}` }));
  assert.equal(getMemoryView(db, 'a').proposals.filter(p => p.status === 'pending').length, 200);
  assert.throws(() => submitProposal(db, input(conv, { idempotencyKey: 'overflow' })), status(409));
  const old = getMemoryView(db, 'a').proposals[0]!;
  rejectProposal(db, 'a', old.id);
  submitProposal(db, input(conv, { idempotencyKey: 'next' }));
  assert.equal(getMemoryView(db, 'a').proposals.filter(p => p.status === 'pending').length, 200);
}));

test('memory: actual SQLite write failure rolls back records, revisions, history, proposal states and job', () => fixture(({ db, conv, provider }) => {
  const p = submitProposal(db, input(conv));
  const q = submitProposal(db, input(conv, { idempotencyKey: 'second', recordId: 'z-fail' }));
  const job = claimMergeJob(db, 'a', 'f', provider, 'm')!;
  db.exec(`CREATE TRIGGER reject_test_record BEFORE INSERT ON memory_records
    WHEN NEW.record_id='z-fail' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`);
  assert.throws(() => applyMergePlan(db, 'a', job.id, 0, [p.id, q.id], { decisions: [decision(p), decision(q)] }), /injected write failure/);
  assert.equal(getProjectRevision(db, 'a'), 0);
  assert.equal(getMemoryView(db, 'a').records.length, 0);
  assert.ok(getMemoryView(db, 'a').proposals.every(p => p.status === 'pending'));
  assert.equal(getMemoryView(db, 'a').jobs[0]?.state, 'running');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_history').get()?.['n'], 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_events WHERE action LIKE 'record.%'").get()?.['n'], 0);
  assert.throws(() => applyProposalManually(db, 'a', q.id), /injected write failure/);
  assert.equal(getProjectRevision(db, 'a'), 0);
}));
