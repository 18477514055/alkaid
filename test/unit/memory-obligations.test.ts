import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../../src/core/store/schema.ts';
import { appendMessage, insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { submitProposal } from '../../src/core/memory/store.ts';
import { MEMORY_OBLIGATIONS_SCHEMA_SQL } from '../../src/core/memory/obligations-schema.ts';
import {
  beginObligation, exemptObligation, finishObligation, markObligationRepair, noteObligationBusiness,
  noteObligationProposal, queryObligations, readObligation, resolveObligation,
} from '../../src/core/memory/obligations.ts';
import type { MemoryProposal, SubmitMemoryProposal } from '../../src/shared/memory.ts';
import type { ObligationFinishCode } from '../../src/shared/memory-obligations.ts';

function fixture(run: (f: ReturnType<typeof setup>) => void): void { const f = setup(); try { run(f); } finally { f.db.close(); } }
function setup() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db); db.exec(MEMORY_OBLIGATIONS_SCHEMA_SQL);
  insertProject(db, { id: 'ob-project', name: 'Project', sharedDir: 'unused' });
  insertProject(db, { id: 'ob-other', name: 'Other', sharedDir: 'unused' });
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  const a = insertConversation(db, { projectId: 'ob-project', providerId: provider.id, model: 'offline' }).id;
  const b = insertConversation(db, { projectId: 'ob-project', providerId: provider.id, model: 'offline' }).id;
  const foreign = insertConversation(db, { projectId: 'ob-other', providerId: provider.id, model: 'offline' }).id;
  function start(conv = a, text = 'User requested verified work') { const u = appendMessage(db, { conversationId: conv, role: 'user', content: text }); beginObligation(db, conv, u.seq); return u.seq; }
  function result(name: string, payload: object, conv = a, maintenance = name.startsWith('memory_')) {
    const call = randomUUID(); appendMessage(db, { conversationId: conv, role: 'assistant', toolCalls: [{ id: call, name, arguments: '{}' }] });
    return appendMessage(db, { conversationId: conv, role: 'tool', toolCallId: call, displayChannel: maintenance ? 'maintenance' : 'chat', content: JSON.stringify(payload) }).seq;
  }
  function proposal(type: 'progress' | 'triage', conv = a, patch: Partial<SubmitMemoryProposal> = {}) {
    const call = randomUUID(), name = type === 'triage' ? 'memory_stage' : 'memory_propose';
    appendMessage(db, { conversationId: conv, role: 'assistant', toolCalls: [{ id: call, name, arguments: '{}' }] });
    const p = submitProposal(db, { conversationId: conv, recordId: type === 'triage' ? `artifact:triage:${randomUUID()}` : `progress-${randomUUID()}`, kind: type === 'triage' ? 'note' : 'active', title: type,
      operation: 'upsert', content: type === 'triage' ? JSON.stringify({ $memory: 'triage', keep: [{ what: 'Validated keep' }], stash: [], drop: [] }) : 'Actual persisted progress',
      baseRevision: 0, reason: 'verified evidence', idempotencyKey: randomUUID(), ...patch });
    const messageSeq = appendMessage(db, { conversationId: conv, role: 'tool', displayChannel: 'maintenance', toolCallId: call, content: JSON.stringify({ ok: true, content: JSON.stringify({ proposal: p, staged: true, applied: false }) }) }).seq;
    return { p, messageSeq };
  }
  function note(userSeq: number, evidence: ReturnType<typeof proposal>, conv = a) { return noteObligationProposal(db, conv, userSeq, evidence.p.id, evidence.messageSeq); }
  return { db, a, b, foreign, provider: provider.id, start, result, proposal, note };
}
const status = (n: number) => (e: unknown) => e instanceof Error && (e as Error & { statusCode?: number }).statusCode === n;

test('obligations: begin binds actual user/project and is idempotent, without forging messages', () => fixture(f => {
  assert.throws(() => beginObligation(f.db, f.a, 1), status(404));
  const u = f.start(); const old = readObligation(f.db, f.a, u)!;
  assert.equal(old.status, 'required'); assert.deepEqual(old.missing, ['progress','triage']);
  assert.equal(beginObligation(f.db, f.a, u)?.id, old.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_obligations').get()?.['n'], 1);
  const assistant = appendMessage(f.db, { conversationId: f.a, role: 'assistant', content: 'not a user' });
  assert.throws(() => beginObligation(f.db, f.a, assistant.seq), status(404));
  const noProject = insertConversation(f.db, { providerId: f.provider, model: 'offline' }).id;
  const user = appendMessage(f.db, { conversationId: noProject, role: 'user', content: 'standalone' });
  assert.equal(beginObligation(f.db, noProject, user.seq), null);
}));

test('obligations: explicit user skip can close saved original-project history after source deletion or rebinding, never reconcile across projects', () => {
 for(const mode of ['deleted','rebound']) fixture(f => {
  const u=f.start();finishObligation(f.db,f.a,u,'incomplete');
  if(mode==='deleted')f.db.prepare('DELETE FROM conversations WHERE id=?').run(f.a);
  else f.db.prepare('UPDATE conversations SET project_id=? WHERE id=?').run('ob-other',f.a);
  assert.equal(queryObligations(f.db,'ob-project').summary.incomplete,1);
  assert.throws(()=>resolveObligation(f.db,'ob-other',{conversationId:f.a,userSeq:u,action:'skip',reason:'wrong project'}),status(404));
  assert.throws(()=>resolveObligation(f.db,'ob-project',{conversationId:f.a,userSeq:u,action:'reconcile',proposalIds:['a','b']}),status(409));
  const result=resolveObligation(f.db,'ob-project',{conversationId:f.a,userSeq:u,action:'skip',reason:'来源已删除或改绑，用户明确免除此旧项'});
  assert.equal(result.obligation.status,'exempt');assert.equal(result.obligation.reasonSource,'user');assert.equal(result.summary.incomplete,0);
 });
});
test('obligations: actual persisted dual progress+triage is staged, not formally applied', () => fixture(f => {
  const u = f.start(); const p = f.proposal('progress');
  assert.deepEqual(f.note(u, p).missing, ['triage']);
  assert.equal(finishObligation(f.db, f.a, u, 'complete').status, 'incomplete');
  const t = f.proposal('triage'); const saved = f.note(u, t);
  assert.equal(saved.status, 'staged'); assert.deepEqual(saved.missing, []);
  assert.equal(saved.progress?.proposalId, p.p.id); assert.equal(saved.triage?.proposalId, t.p.id);
  assert.equal(finishObligation(f.db, f.a, u, 'complete').status, 'staged');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get()?.['n'], 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE status='pending'").get()?.['n'], 2);
  const priorEvents = saved.events.length; assert.equal(f.note(u, t).events.length, priorEvents + 1, 'only the explicit finish added one event, evidence replay itself adds none');
}));

test('obligations: triage cannot double-count progress; extension artifacts and principles are not progress', () => fixture(f => {
  const u = f.start(); const triage = f.proposal('triage');
  assert.deepEqual(f.note(u, triage).missing, ['progress']);
  const second = f.proposal('triage'); f.note(u, second);
  assert.equal(finishObligation(f.db, f.a, u, 'complete').status, 'incomplete');
  const p = f.proposal('progress'); f.db.prepare("UPDATE memory_proposals SET kind='principle' WHERE id=?").run(p.p.id);
  assert.throws(() => f.note(u, p), status(400));
  f.db.prepare("UPDATE memory_proposals SET kind='note',record_id='artifact:extension-entry:cannot',content=? WHERE id=?").run(JSON.stringify({ $memory: 'extension-entry' }), p.p.id);
  assert.throws(() => f.note(u, p), status(400));
}));

test('obligations: ordinary kinds plus intent/handoff count only as progress, never as triage', () => {
  for (const [kind, content, recordId] of [
    ['active','Active verified','ordinary-a'], ['decision','Decision verified','ordinary-d'],
    ['goal',JSON.stringify({ parentId: null, state: 'root', keyResults: [], lessons: [] }),'ordinary-g'],
    ['lesson',JSON.stringify({ type: 'experience', category: '机制', body: 'Body', fix: 'Fix', source: 'fixture.ts:1' }),'ordinary-l'],
    ['note','Ordinary note','ordinary-n'],
    ['note',JSON.stringify({ $memory: 'intent', conversationId: 'REPLACED', goal: 'Goal', did: 'Did', issues: '', next: 'Next' }),'artifact:intent:intent1'],
    ['note',JSON.stringify({ $memory: 'handoff', title: 'Handoff', did: 'Did', state: 'State', next: 'Next', files: [], blocked: '' }),'artifact:handoff:handoff1'],
  ] as const) fixture(f => {
    const u = f.start(); const p = f.proposal('progress', f.a, { kind, recordId, content: content.replace('REPLACED', f.a) });
    assert.deepEqual(f.note(u, p).missing, ['triage'], kind);
  });
});

test('obligations: fake IDs, failed or forged receipts, wrong message roles and rejected/conflict proposals never count', () => fixture(f => {
  const u = f.start(); const p = f.proposal('progress');
  assert.throws(() => noteObligationProposal(f.db, f.a, u, 'not-persisted', p.messageSeq), status(404));
  f.db.prepare('UPDATE messages SET content=? WHERE conversation_id=? AND seq=?').run(JSON.stringify({ ok: false, message: 'failed' }), f.a, p.messageSeq);
  assert.throws(() => f.note(u, p), status(409));
  f.db.prepare('UPDATE messages SET content=? WHERE conversation_id=? AND seq=?').run(JSON.stringify({ ok: true, content: JSON.stringify({ proposal: { id: 'fake' } }) }), f.a, p.messageSeq);
  assert.throws(() => f.note(u, p), status(409));
  f.db.prepare('UPDATE messages SET content=? WHERE conversation_id=? AND seq=?').run(JSON.stringify({ ok: true, content: JSON.stringify({ proposal: p.p }) }), f.a, p.messageSeq);
  for (const s of ['rejected','conflict']) { f.db.prepare('UPDATE memory_proposals SET status=? WHERE id=?').run(s, p.p.id); assert.throws(() => f.note(u, p), status(409)); }
  const assistant = appendMessage(f.db, { conversationId: f.a, role: 'assistant', content: 'claim' });
  assert.throws(() => noteObligationProposal(f.db, f.a, u, p.p.id, assistant.seq), status(409));
  assert.equal(readObligation(f.db, f.a, u)?.evidence.length, 0);
}));

test('obligations: source project/conversation, pre-begin proposals, cross-turn reuse and receipt replay are rejected', () => fixture(f => {
  const old = f.proposal('progress'); const u = f.start();
  const replaySeq = f.result('memory_propose', { ok: true, content: JSON.stringify({ proposal: old.p }) });
  assert.throws(() => noteObligationProposal(f.db, f.a, u, old.p.id, replaySeq), status(409));
  f.start(f.b); const other = f.proposal('progress', f.b);
  assert.throws(() => noteObligationProposal(f.db, f.a, u, other.p.id, replaySeq), status(409));
  f.start(f.foreign); const foreign = f.proposal('progress', f.foreign);
  assert.throws(() => noteObligationProposal(f.db, f.a, u, foreign.p.id, replaySeq), status(409));
  const p = f.proposal('progress'); f.note(u, p);
  const repeated = f.result('memory_propose', { ok: true, content: JSON.stringify({ proposal: p.p }) });
  assert.throws(() => noteObligationProposal(f.db, f.a, u, p.p.id, repeated), status(409));
  const next = f.start();
  assert.throws(() => noteObligationProposal(f.db, f.a, next, p.p.id, repeated), status(409));
  assert.throws(() => noteObligationBusiness(f.db, f.a, u, f.result('read', { ok: true, content: 'later turn' }), false), status(409));
}));

test('obligations: later readonly business invalidates BOTH earlier evidences, and both must be refreshed', () => fixture(f => {
  const u = f.start(); const p = f.proposal('progress'), t = f.proposal('triage'); f.note(u, p); f.note(u, t);
  const businessSeq = f.result('read', { ok: true, content: 'new knowledge' });
  const stale = noteObligationBusiness(f.db, f.a, u, businessSeq, false);
  assert.equal(stale.status, 'required'); assert.equal(stale.stale, true); assert.deepEqual(stale.missing, ['progress','triage']);
  assert.equal(stale.lastBusinessSeq, businessSeq); assert.equal(stale.mutated, false);
  const freshP = f.proposal('progress'); assert.deepEqual(f.note(u, freshP).missing, ['triage']);
  const freshT = f.proposal('triage'); assert.equal(f.note(u, freshT).status, 'staged');
  assert.equal(readObligation(f.db, f.a, u)?.stale, false);
}));

test('obligations: no_progress is an auditable model declaration, revoked by later business, never allowed after mutation/progress', () => fixture(f => {
  const u = f.start(); const reason = 'This turn only clarified the request, with no new reusable conclusion.';
  const exempt = exemptObligation(f.db, f.a, u, reason);
  assert.equal(exempt.status, 'exempt'); assert.equal(exempt.reasonSource, 'model'); assert.equal(exempt.semanticProof, false);
  assert.equal(exempt.reason, reason); assert.equal(finishObligation(f.db, f.a, u, 'complete').status, 'exempt');
  const read = f.result('read', { ok: true, content: 'new observation' });
  assert.equal(noteObligationBusiness(f.db, f.a, u, read, false).status, 'required');
  const write = f.result('write', { ok: true, content: 'success' }); noteObligationBusiness(f.db, f.a, u, write, true);
  assert.throws(() => exemptObligation(f.db, f.a, u, 'nothing changed'), status(409));
  assert.equal(finishObligation(f.db, f.a, u, 'error').status, 'incomplete');
  const next = f.start(); const p = f.proposal('progress');
  assert.throws(() => exemptObligation(f.db, f.a, next, 'cannot bypass missing triage'), status(409), 'even an unregistered persisted progress proposal blocks no_progress');
  f.note(next, p); assert.throws(() => exemptObligation(f.db, f.a, next, 'cannot bypass'), status(409));
}));

test('obligations: system codes are closed; errors/aborts without mutations may exempt, with mutations stay incomplete', () => {
  for (const code of ['error','abort','readonly','registry_missing','tools_disabled'] as ObligationFinishCode[]) fixture(f => {
    const u = f.start(); assert.equal(finishObligation(f.db, f.a, u, code).status, 'exempt', code);
    const next = f.start(); const s = f.result('write', { ok: true, content: 'actual change' }); noteObligationBusiness(f.db, f.a, next, s, true);
    assert.equal(finishObligation(f.db, f.a, next, code).status, 'incomplete', code);
  });
  fixture(f => { const u = f.start(); assert.throws(() => finishObligation(f.db, f.a, u, 'UPSTREAM_FULL_BODY' as ObligationFinishCode), status(400)); });
});

test('obligations: repair is an atomic one-time claim, failures keep debt and never downgrade fresh staged/exempt', () => fixture(f => {
  const u = f.start(); assert.equal(markObligationRepair(f.db, f.a, u), true);
  assert.equal(readObligation(f.db, f.a, u)?.status, 'repairing'); assert.equal(markObligationRepair(f.db, f.a, u), false);
  for (const code of ['repair_failed','repair_timeout','repair_input_limit','repair_exhausted'] as ObligationFinishCode[]) {
    const debt = finishObligation(f.db, f.a, u, code); assert.equal(debt.status, 'incomplete'); assert.equal(debt.repairAttempt, 1); assert.equal(markObligationRepair(f.db, f.a, u), false);
  }
  f.note(u, f.proposal('progress')); f.note(u, f.proposal('triage'));
  assert.equal(finishObligation(f.db, f.a, u, 'repair_failed').status, 'staged');
  const next = f.start(); exemptObligation(f.db, f.a, next, 'Clarification only, no reusable project conclusion.');
  assert.equal(finishObligation(f.db, f.a, next, 'repair_timeout').status, 'exempt');
}));

test('obligations: rejected saved evidence invalidates a staged outcome without editing immutable evidence', () => fixture(f => {
  const u = f.start(); const p = f.proposal('progress'), t = f.proposal('triage'); f.note(u, p); f.note(u, t); finishObligation(f.db, f.a, u, 'complete');
  f.db.prepare("UPDATE memory_proposals SET status='rejected' WHERE id=?").run(p.p.id);
  const view = readObligation(f.db, f.a, u)!; assert.equal(view.status, 'incomplete'); assert.equal(view.code, 'OBLIGATION_EVIDENCE_INVALID'); assert.deepEqual(view.missing, ['progress']);
  assert.equal(view.evidence.length, 2);
}));

test('obligations: aggregate keeps old debt visible across new exempt turns, with full-project counts independent of pages', () => fixture(f => {
  const old = f.start(); finishObligation(f.db, f.a, old, 'incomplete');
  const next = f.start(); exemptObligation(f.db, f.a, next, 'No new reusable knowledge in this clarification.');
  const b = f.start(f.b); markObligationRepair(f.db, f.b, b);
  const page = queryObligations(f.db, 'ob-project', { conversationId: f.a, limit: 1 });
  assert.equal(page.total, 1); assert.equal(page.entries[0]?.userSeq, old);
  assert.equal(page.summary.exempt, 1); assert.equal(page.summary.repairing, 1); assert.equal(page.summary.incomplete, 1); assert.equal(page.summary.total, 3);
  assert.equal(queryObligations(f.db, 'ob-project', { includeResolved: true }).total, 3);
  assert.equal(queryObligations(f.db, 'ob-project', { status: 'repairing', includeResolved: true }).total, 1);
  assert.equal(queryObligations(f.db, 'ob-other').summary.total, 0);
  assert.throws(() => queryObligations(f.db, 'ob-project', { conversationId: f.foreign }), status(404));
}));

test('obligations: legacy errors/claimed progress project read-only as needs_review, never automatically real missing work', () => fixture(f => {
  const user = appendMessage(f.db, { conversationId: f.a, role: 'user', content: 'Historical provider failed' });
  for (const [u, code] of [[user.seq, 'progress_not_recorded'], [99, 'progress_recorded'], [0, 'progress_not_recorded']] as const) {
    f.db.prepare('INSERT INTO memory_turn_debts(conversation_id,user_seq,code,created_at) VALUES(?,?,?,?)').run(f.a, u, code, new Date().toISOString());
  }
  const before = f.db.prepare('SELECT total_changes() AS n').get()?.['n'];
  const projected = queryObligations(f.db, 'ob-project');
  assert.equal(projected.summary.needsReview, 3); assert.equal(projected.summary.incomplete, 0);
  assert.ok(projected.entries.every(e => e.legacy && e.needsReview && e.code === 'OBLIGATION_LEGACY_REVIEW' && !e.missing.length));
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.['n'], before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_obligations').get()?.['n'], 0);
  const skipped = resolveObligation(f.db, 'ob-project', { conversationId: f.a, userSeq: 0, action: 'skip', reason: 'Reviewed legacy failed turn; no further recording requested.' });
  assert.equal(skipped.obligation.status, 'exempt'); assert.equal(skipped.obligation.legacy, true); assert.equal(skipped.obligation.needsReview, false);
  assert.equal(skipped.summary.needsReview, 2); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_obligations').get()?.['n'], 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_turn_debts').get()?.['n'], 3);
}));

test('obligations: explicit user skip requires safe reason and nonrunning source; reconcile must validate genuine dual receipts', () => fixture(f => {
  const u = f.start(); f.db.prepare("UPDATE conversations SET state='running' WHERE id=?").run(f.a);
  assert.throws(() => resolveObligation(f.db, 'ob-project', { conversationId: f.a, userSeq: u, action: 'skip', reason: 'Skip reviewed' }), status(409));
  f.db.prepare("UPDATE conversations SET state='idle' WHERE id=?").run(f.a);
  for (const reason of ['', 'x'.repeat(301), 'api_key=SYNTHETIC_SECRET_12345', 'User requested verified work']) assert.throws(() => resolveObligation(f.db, 'ob-project', { conversationId: f.a, userSeq: u, action: 'skip', reason }), status(400));
  assert.throws(() => resolveObligation(f.db, 'ob-other', { conversationId: f.a, userSeq: u, action: 'skip', reason: 'wrong project' }), status(404));
  const p = f.proposal('progress'), t = f.proposal('triage');
  assert.throws(() => resolveObligation(f.db, 'ob-project', { conversationId: f.a, userSeq: u, action: 'reconcile', proposalIds: [p.p.id, 'fake'] }), status(404));
  assert.equal(readObligation(f.db, f.a, u)?.evidence.length, 0, 'failed reconcile rolls back first evidence');
  const saved = resolveObligation(f.db, 'ob-project', { conversationId: f.a, userSeq: u, action: 'reconcile', proposalIds: [p.p.id, t.p.id] });
  assert.equal(saved.obligation.status, 'staged'); assert.equal(saved.obligation.code, 'OBLIGATION_RECONCILED');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get()?.['n'], 0);
  const next = f.start(); const skipped = resolveObligation(f.db, 'ob-project', { conversationId: f.a, userSeq: next, action: 'skip', reason: 'User explicitly declines recording this turn.' });
  assert.equal(skipped.obligation.status, 'exempt'); assert.equal(skipped.obligation.reasonSource, 'user');
}));

test('obligations: legacy reconciliation needs real historical user and successful receipts, GET never materializes it', () => fixture(f => {
  const user = appendMessage(f.db, { conversationId: f.a, role: 'user', content: 'Old real work' });
  const p = f.proposal('progress'), t = f.proposal('triage');
  f.db.prepare('INSERT INTO memory_turn_debts(conversation_id,user_seq,code,created_at) VALUES(?,?,?,?)').run(f.a, user.seq, 'progress_not_recorded', new Date().toISOString());
  assert.equal(readObligation(f.db, f.a, user.seq)?.needsReview, true);
  const fixed = resolveObligation(f.db, 'ob-project', { conversationId: f.a, userSeq: user.seq, action: 'reconcile', proposalIds: [p.p.id, t.p.id] });
  assert.equal(fixed.obligation.status, 'staged'); assert.equal(fixed.obligation.legacy, true); assert.equal(fixed.obligation.needsReview, false);
  assert.equal(fixed.summary.needsReview, 0);
}));

test('obligations: business attempts must be persisted and maintenance cannot impersonate business; failed mutation is not success', () => fixture(f => {
  const u = f.start();
  assert.throws(() => noteObligationBusiness(f.db, f.a, u, u + 1, true), status(409));
  const failure = f.result('write', { ok: false, code: 'failed', message: 'not stored in diagnostic' });
  assert.throws(() => noteObligationBusiness(f.db, f.a, u, failure, true), status(409));
  const failedRead = noteObligationBusiness(f.db, f.a, u, failure, false); assert.equal(failedRead.mutated, false);
  const maintenance = f.result('memory_read', { ok: true, content: '{}' });
  assert.throws(() => noteObligationBusiness(f.db, f.a, u, maintenance, false), status(400));
}));

test('obligations: events/evidence/repair/explanations and legacy skips are immutable even INSERT OR REPLACE', () => fixture(f => {
  f.db.exec('PRAGMA recursive_triggers=OFF');
  const u = f.start(); markObligationRepair(f.db, f.a, u); exemptObligation(f.db, f.a, u, 'Clarification only; no reusable conclusion declared.');
  f.note(u, f.proposal('progress'));
  f.db.prepare('INSERT INTO memory_turn_debts(conversation_id,user_seq,code,created_at) VALUES(?,?,?,?)').run(f.a, 0, 'progress_not_recorded', new Date().toISOString());
  resolveObligation(f.db, 'ob-project', { conversationId: f.a, userSeq: 0, action: 'skip', reason: 'Reviewed erroneous legacy row.' });
  for (const table of ['memory_obligations','memory_obligation_events','memory_obligation_evidence','memory_obligation_repairs','memory_obligation_explanations','memory_obligation_legacy_resolutions']) {
    const before = f.db.prepare(`SELECT * FROM ${table}`).all(); assert.ok(before.length);
    assert.throws(() => f.db.exec(`UPDATE ${table} SET created_at=created_at`), /append-only/);
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /append-only/);
    assert.throws(() => f.db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`), /append-only|cannot be replaced|only once/);
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), before);
  }
}));

test('obligations: real SQL failure rolls back evidence and repair reservation with diagnostic events', () => fixture(f => {
  const u = f.start(); const p = f.proposal('progress');
  f.db.exec("CREATE TRIGGER obligation_test_fail BEFORE INSERT ON memory_obligation_events WHEN NEW.type IN ('proposal','repair') BEGIN SELECT RAISE(ABORT,'injected obligation failure'); END;");
  assert.throws(() => f.note(u, p), /injected obligation failure/);
  assert.equal(readObligation(f.db, f.a, u)?.evidence.length, 0);
  assert.throws(() => markObligationRepair(f.db, f.a, u), /injected obligation failure/);
  assert.equal(readObligation(f.db, f.a, u)?.repairAttempt, 0);
}));

test('obligations: diagnostics contain only fixed codes/pointers, not business/proposal/error/user body copies', () => fixture(f => {
  const u = f.start(f.a, 'USER_FULL_BODY_SENTINEL');
  const business = f.result('read', { ok: true, content: 'BUSINESS_FULL_BODY_SENTINEL' }); noteObligationBusiness(f.db, f.a, u, business, false);
  f.note(u, f.proposal('progress', f.a, { content: 'PROGRESS_FULL_BODY_SENTINEL', reason: 'PROPOSAL_REASON_SENTINEL' }));
  finishObligation(f.db, f.a, u, 'repair_timeout');
  assert.throws(() => finishObligation(f.db, f.a, u, 'UPSTREAM_BODY_SENTINEL' as ObligationFinishCode), status(400));
  const stored = JSON.stringify(f.db.prepare('SELECT * FROM memory_obligation_events').all()) + JSON.stringify(f.db.prepare('SELECT * FROM memory_obligation_evidence').all());
  assert.doesNotMatch(stored, /USER_FULL_BODY|BUSINESS_FULL_BODY|PROGRESS_FULL_BODY|PROPOSAL_REASON|UPSTREAM_BODY/);
}));
