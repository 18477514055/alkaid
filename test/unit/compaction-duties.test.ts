import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../../src/core/store/schema.ts';
import { appendMessage, insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { applyProposalManually, submitProposal } from '../../src/core/memory/store.ts';
import { beginObligation, exemptObligation, noteObligationProposal, readObligation } from '../../src/core/memory/obligations.ts';
import { getCompactionDuties, getLatestCompactionCheckpoint } from '../../src/core/memory/duties.ts';
import type { DutyKind } from '../../src/shared/compaction-duties.ts';
import type { SubmitMemoryProposal } from '../../src/shared/memory.ts';

function fixture(run: (f: ReturnType<typeof setup>) => void) { const f = setup(); try { run(f); } finally { f.db.close(); } }
function setup() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db);
  insertProject(db, { id: 'duties-a', name: 'A', sharedDir: 'unused' }); insertProject(db, { id: 'duties-b', name: 'B', sharedDir: 'unused' });
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'http://127.0.0.1:1' });
  const a = insertConversation(db, { projectId: 'duties-a', providerId: provider.id, model: 'offline' }).id;
  const b = insertConversation(db, { projectId: 'duties-a', providerId: provider.id, model: 'offline' }).id;
  const foreign = insertConversation(db, { projectId: 'duties-b', providerId: provider.id, model: 'offline' }).id;
  const start = (conv = a, begin = true) => { const user = appendMessage(db, { conversationId: conv, role: 'user', content: 'User requests concrete work' }); if (begin) beginObligation(db, conv, user.seq); return user.seq; };
  function batch(kinds: DutyKind[], userSeq: number, conv = a, register = true, patch: Partial<SubmitMemoryProposal> = {}) {
    const calls = kinds.map(kind => ({ id: randomUUID(), name: kind === 'ledger' ? 'memory_propose' : 'memory_stage', arguments: '{}', displayChannel: 'maintenance' as const }));
    const assistant = appendMessage(db, { conversationId: conv, role: 'assistant', toolCalls: calls, displayChannel: 'maintenance' });
    return kinds.map((kind, i) => {
      const suffix = randomUUID();
      const p = submitProposal(db, { conversationId: conv, recordId: kind === 'ledger' ? `active-${suffix}` : `artifact:${kind === 'log' ? 'intent' : 'triage'}:${suffix}`,
        kind: kind === 'ledger' ? 'active' : 'note', title: kind, operation: 'upsert', baseRevision: 0, reason: 'Verified source receipts', idempotencyKey: randomUUID(),
        content: kind === 'ledger' ? 'Verified work and next action' : kind === 'log' ? JSON.stringify({ $memory: 'intent', conversationId: conv, goal: 'Goal', did: 'Actual work', issues: '', next: 'Next' })
          : JSON.stringify({ $memory: 'triage', keep: [{ what: 'Exact retained source\n🙂' }], stash: [], drop: [] }), ...patch });
      const result = appendMessage(db, { conversationId: conv, role: 'tool', toolCallId: calls[i]!.id, displayChannel: 'maintenance', content: JSON.stringify({ ok: true, content: JSON.stringify({ proposal: p, staged: true, applied: false }) }) });
      if (register) noteObligationProposal(db, conv, userSeq, p.id, result.seq);
      return { p, resultSeq: result.seq, batchSeq: assistant.seq };
    });
  }
  function business(name = 'read', result: object = { ok: true, content: 'New business fact' }, conv = a, maintenance = false) {
    const call = { id: randomUUID(), name, arguments: '{}', displayChannel: maintenance ? 'maintenance' as const : 'chat' as const };
    const assistant = appendMessage(db, { conversationId: conv, role: 'assistant', toolCalls: [call], displayChannel: maintenance ? 'maintenance' : 'chat' });
    const message = appendMessage(db, { conversationId: conv, role: 'tool', toolCallId: call.id, displayChannel: maintenance ? 'maintenance' : 'chat', content: JSON.stringify(result) });
    return { assistantSeq: assistant.seq, resultSeq: message.seq };
  }
  return { db, a, b, foreign, provider: provider.id, start, batch, business };
}

test('compaction duties: no user/seed/defer/exempt/skip alone is never ready; GET is pure and creates no tables', () => fixture(f => {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  assert.equal(getCompactionDuties(f.db, f.a).complete, false); assert.equal(getLatestCompactionCheckpoint(f.db, f.a), null);
  const u = f.start();
  f.db.prepare("INSERT INTO memory_rhythm_checkpoints(project_id,conversation_id,message_seq,user_seq,kind,created_at) VALUES(?,?,?,?,'deferred',?)").run('duties-a',f.a,u,u,new Date().toISOString());
  assert.equal(readObligation(f.db,f.a,u)?.status,'exempt');
  const before = f.db.prepare('SELECT total_changes() AS n').get()?.['n'];
  assert.deepEqual(getCompactionDuties(f.db, f.a, u).missing, ['ledger','log','triage']);
  assert.equal(getLatestCompactionCheckpoint(f.db, f.a), null);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.['n'], before);
  assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), tables);
  const next=f.start();exemptObligation(f.db,f.a,next,'Only clarified existing requirements without reusable new progress.');
  assert.equal(getCompactionDuties(f.db,f.a).complete,false);
  f.db.prepare("INSERT INTO memory_turn_debts(conversation_id,user_seq,code,created_at) VALUES(?,99,'checkpoint_skip',?)").run(f.a,new Date().toISOString());
  assert.equal(getCompactionDuties(f.db,f.a,99).complete,false);
}));

test('compaction duties: three distinct real saved receipts are required, intent is LOG not ledger or double duty', () => fixture(f => {
  const u=f.start();f.batch(['log','triage'],u);
  const partial=getCompactionDuties(f.db,f.a);assert.equal(partial.complete,false);assert.ok(partial.missing.includes('ledger'));
  const ledger=f.batch(['ledger'],u)[0]!;
  assert.equal(getCompactionDuties(f.db,f.a).complete,false,'earlier triage must be repeated after latest ledger');
  const triage=f.batch(['triage'],u)[0]!;
  const state=getCompactionDuties(f.db,f.a);assert.equal(state.reason,'ready');assert.equal(state.complete,true);
  assert.equal(state.checkpoint?.ledger.proposalId,ledger.p.id);assert.equal(state.checkpoint?.triage.proposalId,triage.p.id);
  assert.equal(new Set([state.checkpoint!.ledger.proposalId,state.checkpoint!.log.proposalId,state.checkpoint!.triage.proposalId]).size,3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get()?.['n'],0);
}));

test('compaction duties: pending/applied accepted, deterministic hash and GET do not modify durable proof', () => fixture(f => {
  const u=f.start();const all=f.batch(['ledger','log','triage'],u);const first=getCompactionDuties(f.db,f.a).checkpoint!;
  assert.match(first.id,/^[a-f0-9]{64}$/);assert.deepEqual(getLatestCompactionCheckpoint(f.db,f.a),first);
  const before=f.db.prepare('SELECT total_changes() AS n').get()?.['n'];
  assert.deepEqual(getCompactionDuties(f.db,f.a,u).checkpoint,first);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.['n'],before);
  for(const saved of all)applyProposalManually(f.db,'duties-a',saved.p.id);
  assert.deepEqual(getCompactionDuties(f.db,f.a).checkpoint,first,'review status changes do not invent a new source checkpoint');
}));

test('compaction duties: same assistant batch boundary stays intact and single long turn can compact earlier business', () => fixture(f => {
  const u=f.start();const work=f.business();
  const all=f.batch(['ledger','log','triage'],u);
  const checkpoint=getCompactionDuties(f.db,f.a).checkpoint!;
  assert.ok(checkpoint);assert.equal(new Set(all.map(x=>x.batchSeq)).size,1);
  assert.equal(checkpoint.safeCutSeq,all[0]!.batchSeq-1);
  assert.equal(checkpoint.safeCutSeq,work.resultSeq);assert.ok(checkpoint.safeCutSeq>u,'not the unusable userSeq-1 boundary for a long single turn');
  assert.ok(all.every(x=>x.resultSeq>checkpoint.safeCutSeq));
}));

test('compaction duties: triage must follow ledger and log, including when all calls share a batch', () => fixture(f => {
  const u=f.start();f.batch(['triage','ledger','log'],u);
  const state=getCompactionDuties(f.db,f.a);assert.equal(state.complete,false);assert.equal(state.reason,'stale');assert.deepEqual(state.missing,['triage']);
  f.batch(['triage'],u);assert.equal(getCompactionDuties(f.db,f.a).complete,true);
}));

test('compaction duties: later ledger/log changes invalidate an earlier triage without any business tool', () => fixture(f => {
  const u=f.start();f.batch(['ledger','log','triage'],u);const original=getLatestCompactionCheckpoint(f.db,f.a)!;
  f.batch(['log'],u);assert.deepEqual(getCompactionDuties(f.db,f.a).missing,['triage']);assert.equal(getLatestCompactionCheckpoint(f.db,f.a),null);
  f.batch(['triage'],u);assert.notEqual(getLatestCompactionCheckpoint(f.db,f.a)?.id,original.id);
}));

test('compaction duties: readonly chat business in later non-obligation turn makes old triplet stale, never falls back', () => fixture(f => {
  const u=f.start();f.batch(['ledger','log','triage'],u);assert.ok(getLatestCompactionCheckpoint(f.db,f.a));
  const next=f.start(f.a,false);f.business('read');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_obligations WHERE user_seq=?').get(next)?.['n'],0);
  const prior=getCompactionDuties(f.db,f.a,u);assert.equal(prior.reason,'stale');assert.deepEqual(prior.missing,['ledger','log','triage']);
  assert.equal(getLatestCompactionCheckpoint(f.db,f.a),null);assert.equal(getCompactionDuties(f.db,f.a).complete,false);
}));

test('compaction duties: describe_tool/maintenance/denial do not invalidate, other actual failures DO invalidate', () => {
  for(const [name,result,maintenance,stale] of [
    ['describe_tool',{ok:true,content:'Definition'},false,false],['memory_read',{ok:true,content:'{}'},false,false],
    ['execution_board',{ok:true,content:'{}'},false,false],['custom_context',{ok:true,content:'{}'},true,false],
    ['read',{ok:false,code:'denied_by_policy'},false,false],['read',{ok:false,code:'tool_disabled'},false,false],['unknown',{ok:false,code:'tool_not_found'},false,false],
    ['read',{ok:false,code:'read_io_failed'},false,true],
  ] as const) fixture(f=>{const u=f.start();f.batch(['ledger','log','triage'],u);f.business(name,result,f.a,maintenance);assert.equal(getCompactionDuties(f.db,f.a).complete,!stale,name);});
});

test('compaction duties: forged IDs, failed/call-only receipts, mismatched returned ID and unknown call never count', () => {
  for(const mode of ['fake-id','failed','wrong-id','call-only','wrong-tool'])fixture(f=>{
    const u=f.start();const saved=f.batch(['ledger','log','triage'],u);const log=saved[1]!;
    if(mode==='fake-id')f.db.prepare('DELETE FROM memory_proposals WHERE id=?').run(log.p.id);
    else if(mode==='failed')f.db.prepare('UPDATE messages SET content=? WHERE conversation_id=? AND seq=?').run(JSON.stringify({ok:false,code:'failed'}),f.a,log.resultSeq);
    else if(mode==='wrong-id')f.db.prepare('UPDATE messages SET content=? WHERE conversation_id=? AND seq=?').run(JSON.stringify({ok:true,content:JSON.stringify({proposal:{id:'different'}})}),f.a,log.resultSeq);
    else if(mode==='call-only')f.db.prepare('DELETE FROM messages WHERE conversation_id=? AND seq=?').run(f.a,log.resultSeq);
    else f.db.prepare('UPDATE messages SET tool_calls=? WHERE conversation_id=? AND seq=?').run(JSON.stringify([{id:'unknown-call',name:'memory_stage',arguments:'{}'}]),f.a,log.batchSeq);
    assert.equal(getCompactionDuties(f.db,f.a).complete,false,mode);assert.ok(getCompactionDuties(f.db,f.a).missing.includes('log'),mode);
  });
});

test('compaction duties: rejected/conflict latest proofs cannot be replaced by an older checkpoint', () => {
  for(const status of ['rejected','conflict'])fixture(f=>{
    const u=f.start();const first=f.batch(['ledger','log','triage'],u);const later=f.batch(['ledger','log','triage'],u);assert.ok(getCompactionDuties(f.db,f.a).complete);
    // An earlier still-pending log must not replace the latest rejected/conflicting log.
    f.db.prepare('UPDATE memory_proposals SET status=? WHERE id=?').run(status,later[1]!.p.id);
    assert.equal(first[1]!.p.status,'pending');
    assert.equal(getLatestCompactionCheckpoint(f.db,f.a),null);assert.ok(getCompactionDuties(f.db,f.a).missing.includes('log'));
  });
});

test('compaction duties: original source receipt is necessary; old/replayed/cross-turn forged evidence cannot refresh a checkpoint', () => fixture(f=>{
  const oldUser=f.start();const old=f.batch(['ledger','log','triage'],oldUser,f.a,false);
  const now=f.start();const modern=f.batch(['ledger','triage'],now);
  const replayCall=randomUUID();appendMessage(f.db,{conversationId:f.a,role:'assistant',displayChannel:'maintenance',toolCalls:[{id:replayCall,name:'memory_stage',arguments:'{}'}]});
  const replay=appendMessage(f.db,{conversationId:f.a,role:'tool',displayChannel:'maintenance',toolCallId:replayCall,content:JSON.stringify({ok:true,content:JSON.stringify({proposal:old[1]!.p})})});
  f.db.prepare('INSERT INTO memory_obligation_evidence VALUES(?,?,?,?,?,?,?)').run(randomUUID(),f.a,now,old[1]!.p.id,'progress',replay.seq,new Date().toISOString());
  assert.equal(getCompactionDuties(f.db,f.a).complete,false);assert.ok(getCompactionDuties(f.db,f.a).missing.includes('log'));
  assert.ok(modern.length===2);
}));

test('compaction duties: other-conversation/project and rebound sources never provide a checkpoint', () => fixture(f=>{
  const u=f.start();f.batch(['ledger','log','triage'],u);assert.ok(getLatestCompactionCheckpoint(f.db,f.a));
  const b=f.start(f.b);assert.deepEqual(getCompactionDuties(f.db,f.b).missing,['ledger','log','triage']);
  const foreign=f.start(f.foreign);const alien=f.batch(['log'],foreign,f.foreign,false)[0]!;
  f.db.prepare('INSERT INTO memory_obligation_evidence VALUES(?,?,?,?,?,?,?)').run(randomUUID(),f.b,b,alien.p.id,'progress',alien.resultSeq,new Date().toISOString());
  assert.equal(getCompactionDuties(f.db,f.b).complete,false);
  f.db.prepare("UPDATE conversations SET project_id='duties-b' WHERE id=?").run(f.a);
  assert.equal(getCompactionDuties(f.db,f.a,u).complete,false);assert.equal(getLatestCompactionCheckpoint(f.db,f.a),null);
}));

test('compaction duties: subagents and unbound conversations are explicitly unavailable, not asked to fill memory', () => fixture(f=>{
  const u=f.start();f.batch(['ledger','log','triage'],u);
  f.db.prepare("UPDATE conversations SET agent_role='subagent' WHERE id=?").run(f.a);
  assert.equal(getCompactionDuties(f.db,f.a).reason,'subagent');assert.equal(getLatestCompactionCheckpoint(f.db,f.a),null);
  const detached=insertConversation(f.db,{providerId:f.provider,model:'offline'}).id;
  assert.equal(getCompactionDuties(f.db,detached).reason,'no_project');assert.equal(getLatestCompactionCheckpoint(f.db,detached),null);
}));

test('compaction duties: handoff is ledger only; extension/principle/non-intent artifact cannot substitute for progress log', () => fixture(f=>{
  const u=f.start();const handoff=f.batch(['ledger'],u,f.a,true,{recordId:'artifact:handoff:sample',kind:'note',content:JSON.stringify({$memory:'handoff',title:'Handoff',did:'Did',state:'State',next:'Next',files:[],blocked:''})})[0]!;
  f.batch(['triage'],u);const state=getCompactionDuties(f.db,f.a);assert.ok(!state.missing.includes('ledger'));assert.ok(state.missing.includes('log'));assert.equal(state.complete,false);
  for(const [kind,recordId,content] of [['principle','principle','Cannot count'],['note','artifact:extension-entry:sample',JSON.stringify({$memory:'extension-entry'})],['note','artifact:intent:sample',JSON.stringify({$memory:'not-intent',conversationId:f.a})]] as const){
    f.db.prepare('UPDATE memory_proposals SET kind=?,record_id=?,content=? WHERE id=?').run(kind,recordId,content,handoff.p.id);
    const invalid=getCompactionDuties(f.db,f.a);assert.equal(invalid.complete,false);assert.ok(invalid.missing.includes('ledger'));assert.ok(invalid.missing.includes('log'));
  }
}));
