import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runTurn } from '../../src/core/agent/loop.ts';
import { PromptBuilder } from '../../src/core/agent/prompt/builder.ts';
import { builtinSources } from '../../src/core/agent/prompt/builtin.ts';
import { memoryAwarePrompt, projectMaterialMap, projectMemoryBlock } from '../../src/core/agent/prompt/memory.ts';
import { compactRange } from '../../src/core/context/compact.ts';
import { getMemoryState, observeWaterline, openCheckpoint, queryCapsules, recordReadReceipt, recordSuccessfulFileTouch, recordTurnProgress, saveCapsule, waterlineWarning } from '../../src/core/memory/context.ts';
import { applyProposalManually, submitProposal } from '../../src/core/memory/store.ts';
import { getTriage, makeArtifactInput } from '../../src/core/memory/workbench.ts';
import { queryObligations, readObligation } from '../../src/core/memory/obligations.ts';
import { setMemoryPolicy } from '../../src/core/memory/rhythm.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { listStepEvents } from '../../src/core/store/audit.ts';
import { appendMessage, insertConversation, insertProject, insertProvider, listMessages } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { ChatRequest } from '../../src/shared/types.ts';
import { addCompactionDuties } from '../helpers/compaction-fixture.ts';

function fixture() {
 const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db);
 const provider = insertProvider(db, { name: 'offline', baseUrl: 'http://127.0.0.1:1' });
 const project = insertProject(db, { id: 'context-project', name: 'context', sharedDir: 'C:/context' });
 const conv = insertConversation(db, { providerId: provider.id, model: 'existing-user-selected', projectId: project.id, permissionMode: 'full' });
 return { db, provider, project, conv };
}
function formal(f: ReturnType<typeof fixture>, recordId: string, content: string, kind: 'active' | 'note' = 'active', baseRevision = 0) {
 const p = submitProposal(f.db, { conversationId: f.conv.id, recordId, kind, title: `title ${recordId}`, content, operation: 'upsert', baseRevision, reason: 'test evidence', idempotencyKey: randomUUID() });
 applyProposalManually(f.db, f.project.id, p.id); return p;
}
function artifact(f: ReturnType<typeof fixture>, type: 'triage' | 'intent' | 'handoff', payload: unknown) {
 const value = makeArtifactInput(type, payload);
 const p = submitProposal(f.db, { conversationId: f.conv.id, recordId: value.recordId, kind: 'note', title: value.title, content: value.content, operation: 'upsert', baseRevision: 0, reason: 'explicit test review', idempotencyKey: randomUUID() });
 applyProposalManually(f.db, f.project.id, p.id); return p;
}
/** Small explicit test window; the real duty receipts fill the mandatory recent tail. */
async function prepareCompaction(f: ReturnType<typeof fixture>) {
 f.db.prepare('UPDATE providers SET context_window=4000 WHERE id=?').run(f.provider.id);
 return await addCompactionDuties(f.db,f.conv.id);
}
const signal = () => new AbortController().signal;
const offline: Provider = { id: 'offline', async *stream() { yield { type: 'text', delta: 'business final unchanged' }; yield { type: 'finish', reason: 'stop' }; } };

test('9.1 total budget includes headers/directory; only COMPLETE bodies, plus unread catalogue', () => {
 const f = fixture(); try {
  formal(f, 'small', 'COMPLETE_SMALL_BLOCK');
  formal(f, 'too-large', 'LARGE_START' + 'x'.repeat(12000) + 'LARGE_END');
  for (let i=0;i<20;i++) formal(f, `reference-${i}`, 'reference body '.repeat(100), 'note');
  const block = projectMemoryBlock(f.db, f.conv.id)!;
  assert.ok(block.length <= 10000); assert.match(block, /完整正文.*small/); assert.match(block, /COMPLETE_SMALL_BLOCK/);
  assert.match(block, /未读目录/); assert.match(block, /\[未读\]/); assert.match(block, /recordId=/); assert.match(block, /字符/);
  assert.doesNotMatch(block, /LARGE_START|LARGE_END|节选/);
  const prompt = new PromptBuilder(builtinSources()).assemble({ conversationId:f.conv.id,permissionMode:'full',workspacePath:null,projectSharedDir:null,toolNames:[],userInstructions:null,summaryBlock:null,projectMemory:block });
  assert.equal(prompt.sections.find(s=>s.id==='project-memory')!.text, block);
 } finally { f.db.close(); }
});
test('9.2 material map has stable grouped order, actual read receipts and revision invalidation; UI-style reads are pure', () => {
 const f = fixture(); try {
  formal(f,'a','alpha'); formal(f,'b','beta','note');
  const before = projectMaterialMap(f.db,f.conv.id); assert.deepEqual(before,projectMaterialMap(f.db,f.conv.id));
  assert.ok(before.every(r=>!r.read));
  projectMemoryBlock(f.db,f.conv.id); assert.ok(projectMaterialMap(f.db,f.conv.id).every(r=>!r.read));
  recordReadReceipt(f.db,f.conv.id,'a',1); recordReadReceipt(f.db,f.conv.id,'a',1);
  assert.equal(projectMaterialMap(f.db,f.conv.id).find(r=>r.recordId==='a')!.read,true);
  formal(f,'a','new alpha','active',1);
  assert.equal(projectMaterialMap(f.db,f.conv.id).find(r=>r.recordId==='a')!.read,false);
  assert.throws(()=>recordReadReceipt(f.db,f.conv.id,'a',1),/not current/);
 } finally { f.db.close(); }
});
test('9 archive additions and intent/stash/drop changes never change project prompt bytes', () => {
 const f = fixture(); try {
  formal(f,'a','current'); const before = projectMemoryBlock(f.db,f.conv.id);
  artifact(f,'intent',{conversationId:f.conv.id,goal:'INTENT_ONLY',did:'did',issues:'',next:'next'});
  artifact(f,'triage',{keep:[],stash:[{what:'STASH_ONLY'}],drop:[{what:'DROP_ONLY'}]});
  assert.equal(projectMemoryBlock(f.db,f.conv.id),before);
  const map = projectMaterialMap(f.db,f.conv.id); assert.equal(map.length,1);
  // A snapshot of identical current content adds archive evidence without changing current bytes.
  formal(f,'a','current','active',1);
  const afterRevision = projectMemoryBlock(f.db,f.conv.id)!;
  assert.doesNotMatch(afterRevision,/INTENT_ONLY|STASH_ONLY|DROP_ONLY/);
  const historyBefore = f.db.prepare('SELECT COUNT(*) AS n FROM memory_history').get()!['n'];
  assert.ok(Number(historyBefore)>=2);
  const archive = f.db.prepare('SELECT * FROM memory_history LIMIT 1').get();
  assert.ok(archive);
  // Add an archive-only snapshot, not a current-record mutation: bytes must be EXACTLY identical.
  f.db.prepare('INSERT INTO memory_history SELECT ?,project_id,record_id,project_revision,before_json,after_json,source_id,created_at FROM memory_history LIMIT 1').run(randomUUID());
  assert.equal(projectMemoryBlock(f.db,f.conv.id),afterRevision);
 } finally { f.db.close(); }
});
test('9.3 capsule saved BEFORE model request; unicode/newlines and failure originals survive compression unchanged', async () => {
 const f = fixture(); try {
  const raw = '用户逐字：  空格\n换行 🧭 不得改写。';
  appendMessage(f.db,{conversationId:f.conv.id,role:'user',content:raw});
  const errorRaw = JSON.stringify({ok:false,code:'test_failure',message:'原始报错\nline 2'});
  appendMessage(f.db,{conversationId:f.conv.id,role:'tool',toolCallId:'failure',content:errorRaw});
  appendMessage(f.db,{conversationId:f.conv.id,role:'assistant',content:'recent'});
  const duties=await prepareCompaction(f);
  assert.ok(duties.receipts.ledger.proposalId); assert.ok(duties.receipts.log.proposalId); assert.ok(duties.receipts.triage.proposalId);
  let called = 0;
  const provider: Provider = {id:'offline',async *stream(request) {
   called++; const capsules = queryCapsules(f.db,f.conv.id,{fromSeq:1,toSeq:2});
   assert.equal(capsules[0]!.users[0]!.text,raw); assert.equal(capsules[0]!.errors[0]!.text,errorRaw);
   assert.equal(request.model,'existing-user-selected'); yield {type:'text',delta:'summary'}; yield {type:'finish',reason:'stop'};
  }};
  const row=await compactRange({db:f.db,conversationId:f.conv.id,provider,keepRecent:1+duties.addedMessages,signal:signal()});
  assert.ok(row);assert.equal(row.fromSeq,1);assert.equal(row.toSeq,2,'fresh duty batch remains verbatim in the retained tail');
  assert.equal(called,1); assert.equal(listMessages(f.db,f.conv.id)[0]!.content,raw);
  const capsule = queryCapsules(f.db,f.conv.id,{fromSeq:1,toSeq:2})[0]!;
  assert.equal(queryCapsules(f.db,f.conv.id,{capsuleId:capsule.capsuleId})[0]!.users[0]!.text,raw);
  assert.throws(()=>f.db.prepare('UPDATE memory_capsules SET content=? WHERE id=?').run('tamper',capsule.id),/append-only/);
  assert.throws(()=>f.db.prepare('DELETE FROM memory_capsules WHERE id=?').run(capsule.id),/append-only/);
  assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO memory_capsules SELECT * FROM memory_capsules WHERE id=?').run(capsule.id),/append-only/);
 } finally { f.db.close(); }
});
test('capsule credential protection keeps pointers and explicit disclosure rather than a fake verbatim copy', () => {
 const f = fixture(); try {
  const msg = appendMessage(f.db,{conversationId:f.conv.id,role:'user',content:'api_key=TEST_CREDENTIAL_NOT_TO_COPY_1234'});
  const capsule = saveCapsule(f.db,f.conv.id,1,1); const quote = capsule.users[0]!;
  assert.equal(quote.text,null); assert.equal(quote.protected,true); assert.equal(quote.messageId,msg.id); assert.match(quote.notice!,/未复制正文/);
  assert.doesNotMatch(String(f.db.prepare('SELECT content FROM memory_capsules').get()!['content']),/TEST_CREDENTIAL/);
  assert.match(listMessages(f.db,f.conv.id)[0]!.content!,/TEST_CREDENTIAL/,'source remains, no deletion');
 } finally { f.db.close(); }
});
test('capsule file list counts only successful executed write/edit, never failed attempts or shell guesses', async () => {
 const f = fixture(); const dir=mkdtempSync(join(tmpdir(),'alkaid-context-files-')); try {
  let n=0;
  const provider:Provider={id:'offline',async *stream() {
   if(n++===0) {
    yield {type:'tool_call',index:0,id:'ok',name:'write',argsDelta:JSON.stringify({path:'actual.txt',content:'success'})};
    yield {type:'tool_call',index:1,id:'bad',name:'edit',argsDelta:JSON.stringify({path:'missing.txt',old_string:'x',new_string:'y'})};
    yield {type:'finish',reason:'tool_calls'};
   } else {yield {type:'text',delta:'done'};yield {type:'finish',reason:'stop'};}
  }};
  for await(const _ of runTurn({db:f.db,conversationId:f.conv.id,userText:'edit',provider,workspacePath:dir,tools:createDefaultRegistry(f.db),signal:signal()})) { /* drain */ }
  const capsule=saveCapsule(f.db,f.conv.id,1,100);
  assert.deepEqual(capsule.files.map(r=>r.path),[join(dir,'actual.txt')]); assert.match(capsule.coverage,/shell.*未知/);
  assert.equal(capsule.errors.length,1);
 } finally {f.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('approved keep is verbatim in prompt before AND after compaction, stash/drop never injected', async () => {
 const f=fixture();try {
  const raw='  KEEP exact\n二行 🧩  ';
  artifact(f,'triage',{keep:[{what:raw}],stash:[{what:'STASH_NO_INJECT'}],drop:[{what:'DROP_NO_INJECT'}]});
  appendMessage(f.db,{conversationId:f.conv.id,role:'user',content:'old'});appendMessage(f.db,{conversationId:f.conv.id,role:'assistant',content:'recent'});
  const before=projectMemoryBlock(f.db,f.conv.id)!;assert.ok(before.includes(raw));
  const duties=await prepareCompaction(f);
  const row=await compactRange({db:f.db,conversationId:f.conv.id,provider:offline,keepRecent:1+duties.addedMessages,signal:signal()});
  assert.ok(row,'real three-layer receipts must permit actual compaction, not an empty no-op');
  assert.equal(getTriage(f.db,f.project.id).keep[0]!.what,raw);
  const block=projectMemoryBlock(f.db,f.conv.id)!;assert.equal(block,before,'compression and pending duty proposals cannot rewrite approved injection bytes');assert.ok(block.includes(raw));assert.doesNotMatch(block,/STASH_NO_INJECT|DROP_NO_INJECT/);
 }finally{f.db.close();}
});
test('60/80/95 waterlines each produce a distinct model-visible signal and observable state; no generation needed',()=>{
 const f=fixture();try {
  assert.equal(waterlineWarning(59,100).level,'safe');
  for(const [tokens,level,threshold] of [[60,'early',.6],[80,'warn',.8],[95,'urgent',.95]] as const){
   const warning=observeWaterline(f.db,f.conv.id,tokens,100);assert.equal(warning.level,level);assert.equal(warning.threshold,threshold);assert.match(warning.message,new RegExp(`${tokens}%`));
   assert.equal(getMemoryState(f.db,f.conv.id).warning.level,level);
  }
  f.db.prepare('UPDATE providers SET context_window=100 WHERE id=?').run(f.provider.id);
  const context={conversationId:f.conv.id,permissionMode:'full' as const,workspacePath:null,projectSharedDir:null,toolNames:[],userInstructions:'x'.repeat(400),summaryBlock:null,projectMemory:projectMemoryBlock(f.db,f.conv.id)};
  const result=memoryAwarePrompt(f.db,f.conv.id,new PromptBuilder(builtinSources()),context);
  assert.doesNotMatch(result.text,/上下文水位≥95%/,'waterline is runtime context, never a stable system rewrite');
  assert.match(JSON.stringify(result.contextMessages),/上下文水位≥95%/);assert.equal(result.state.warning.level,'urgent');
  f.db.prepare('UPDATE providers SET context_window=1000000 WHERE id=?').run(f.provider.id);
  const low=memoryAwarePrompt(f.db,f.conv.id,new PromptBuilder(builtinSources()),context);
  assert.equal(low.text,result.text,'waterline changes must leave the exact system cache prefix stable');
  assert.doesNotMatch(JSON.stringify(low.contextMessages),/上下文水位≥95%/);
 }finally{f.db.close();}
});
test('10.2 business final is unchanged; a missing registry is explicitly exempt, not fake captured progress',async()=>{
 const f=fixture();try {
  setMemoryPolicy(f.db,f.project.id,{thresholdPercent:0}); // Explicit every-turn obligation fixture, not production rhythm.
  const events=[];
  for await(const event of runTurn({db:f.db,conversationId:f.conv.id,userText:'do work',provider:offline,signal:signal()}))events.push(event);
  assert.equal(events.filter(e=>e.type==='text').map(e=>e.type==='text'?e.delta:'').join(''),'business final unchanged');
  assert.equal(getMemoryState(f.db,f.conv.id).debt,null);
  assert.equal(readObligation(f.db,f.conv.id,1)?.status,'exempt');
  assert.equal(readObligation(f.db,f.conv.id,1)?.code,'OBLIGATION_REGISTRY_MISSING');
  recordTurnProgress(f.db,f.conv.id,1,'checkpoint_skip');recordTurnProgress(f.db,f.conv.id,1,'progress_not_recorded');
  assert.equal(getMemoryState(f.db,f.conv.id).debt!.outstanding,false);
 }finally{f.db.close();}
});
test('progress alone cannot discharge dual duties; a later legitimate exemption does not hide the older incomplete turn',async()=>{
 const f=fixture();try {
  setMemoryPolicy(f.db,f.project.id,{thresholdPercent:0}); // Keep this dual-duty regression in forced mode only.
  formal(f,'old','old');
  let n=0;const provider:Provider={id:'offline',async *stream(){
   if(n++===0){yield{type:'tool_call',index:0,id:'propose',name:'memory_propose',argsDelta:JSON.stringify({recordId:'new',kind:'active',title:'new',content:'new progress',baseRevision:0,operation:'upsert',reason:'verified',idempotencyKey:'new-progress'})};yield{type:'finish',reason:'tool_calls'};}
   else{yield{type:'text',delta:'done'};yield{type:'finish',reason:'stop'};}
  }};
  for await(const _ of runTurn({db:f.db,conversationId:f.conv.id,userText:'new work',provider,tools:createDefaultRegistry(f.db),signal:signal()})){}
  assert.equal(getMemoryState(f.db,f.conv.id).debt!.outstanding,true,'进展提案不能冒充已完成分流');
  assert.deepEqual(readObligation(f.db,f.conv.id,1)?.missing,['triage']);
  for await(const _ of runTurn({db:f.db,conversationId:f.conv.id,userText:'another work',provider:offline,signal:signal()})){}
  assert.equal(getMemoryState(f.db,f.conv.id).debt!.outstanding,true);
  const summary=queryObligations(f.db,f.project.id,{includeResolved:true}).summary;
  assert.equal(summary.incomplete,1);assert.equal(summary.exempt,1);
 }finally{f.db.close();}
});
test('resolving an old checkpoint cannot hide a newer turn debt',()=>{
 const f=fixture();try {
  recordTurnProgress(f.db,f.conv.id,1,'progress_not_recorded');
  recordTurnProgress(f.db,f.conv.id,3,'progress_not_recorded');
  recordTurnProgress(f.db,f.conv.id,1,'checkpoint_skip');
  const debt=getMemoryState(f.db,f.conv.id).debt!;
  assert.equal(debt.userSeq,3);assert.equal(debt.outstanding,true);
 }finally{f.db.close();}
});
test('provider failure event persists fixed diagnostic code only, never upstream text or key',async()=>{
 const f=fixture();try {
  const provider:Provider={id:'offline',async *stream(){yield{type:'error',message:'UPSTREAM_BODY api_key=NOT_LOGGED_123456',retryable:true};}};
  const events=[];for await(const event of runTurn({db:f.db,conversationId:f.conv.id,userText:'work',provider,signal:signal()}))events.push(event);
  const audit=JSON.stringify(listStepEvents(f.db,f.conv.id,100));assert.match(audit,/provider_request_failed/);assert.doesNotMatch(audit,/UPSTREAM_BODY|NOT_LOGGED|api_key/);
  assert.doesNotMatch(JSON.stringify(events),/UPSTREAM_BODY|NOT_LOGGED/);
 }finally{f.db.close();}
});
test('9.1 maximum 40/6000 keep plus long artifact IDs and handoff still fits the TOTAL injection budget', () => {
 const f = fixture(); try {
  const expected: string[] = [];
  for (let batch=0;batch<4;batch++) {
   const keep=Array.from({length:10},(_,i)=>({what:`KEEP-${batch}-${i} exact\n`.padEnd(150,'界')}));
   expected.push(...keep.map(row=>row.what));
   const p=submitProposal(f.db,{conversationId:f.conv.id,recordId:`artifact:triage:${String(batch).padStart(100,'0')}`,kind:'note',title:'max keep',content:JSON.stringify({$memory:'triage',keep,stash:[],drop:[]}),operation:'upsert',baseRevision:0,reason:'boundary',idempotencyKey:`max-${batch}`});
   applyProposalManually(f.db,f.project.id,p.id);
  }
  artifact(f,'handoff',{title:'handoff',did:'did',state:'state',next:'next',files:['D:/test/source.ts'],blocked:''});
  formal(f,'small','COMPLETE_SMALL_BLOCK');
  const block=projectMemoryBlock(f.db,f.conv.id)!;
  assert.ok(block.length<=10000,`actual ${block.length}`);
  for(const text of expected) assert.ok(block.includes(text),'every approved keep must be verbatim');
  assert.match(block,/未读目录/);assert.match(block,/最新交接单/);
 } finally {f.db.close();}
});
test('checkpoint opening is local and immutable, repeated opens return same pending checkpoint',()=>{
 const f=fixture();try{const a=openCheckpoint(f.db,f.conv.id),b=openCheckpoint(f.db,f.conv.id);assert.equal(a.id,b.id);assert.equal(a.status,'pending');
  assert.throws(()=>f.db.prepare('DELETE FROM memory_checkpoints WHERE id=?').run(a.id),/append-only/);
 }finally{f.db.close();}
});
