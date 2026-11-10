import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { assembleContext, compactRange, CompactionError, COMPACTION_SECTIONS, getCompactionState, insertCompaction, listCompactionEvents, listCompactions, planCompaction, recordCompactionBlocked } from '../../src/core/context/compact.ts';
import { COMPACTION_SCHEMA_SQL } from '../../src/core/context/compaction-schema.ts';
import { queryCapsules } from '../../src/core/memory/context.ts';
import { getCompactionDuties, getLatestCompactionCheckpoint } from '../../src/core/memory/duties.ts';
import { beginObligation, noteObligationProposal } from '../../src/core/memory/obligations.ts';
import { submitProposal, rejectProposal } from '../../src/core/memory/store.ts';
import { makeArtifactInput } from '../../src/core/memory/workbench.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { appendMessage, insertConversation, insertProject, insertProvider, listMessages } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { ChatRequest } from '../../src/shared/types.ts';
import type { CompactionSource } from '../../src/shared/compaction.ts';

function fixture(t:TestContext,path=':memory:'){
 const db=new DatabaseSync(path);migrate(db);
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='compaction_attempts'").get())db.exec(COMPACTION_SCHEMA_SQL);
 const provider=insertProvider(db,{name:'offline',baseUrl:'http://127.0.0.1:1',contextWindow:10000});
 const project=insertProject(db,{id:randomUUID(),name:'engine',sharedDir:'D:/engine'});
 const conv=insertConversation(db,{providerId:provider.id,model:'chosen-existing',projectId:project.id,permissionMode:'full'});
 // Full originals include a sentinel beyond the OLD 1500-char per-message clipping boundary.
 for(let i=0;i<40;i++)appendMessage(db,{conversationId:conv.id,role:i%2?'assistant':'user',content:i===0?'x'.repeat(1800)+'ORIGINAL_BEYOND_1500':`history-${i} `+'x'.repeat(300)});
 const user=appendMessage(db,{conversationId:conv.id,role:'user',content:'finish verified work'});beginObligation(db,conv.id,user.seq);
 t.after(()=>{if(db.isOpen)db.close();});
 function receipt(kind:'ledger'|'log'|'triage'){
  const value=kind==='ledger'?{recordId:`active-${randomUUID()}`,title:'verified current',content:'actual verified progress'}:makeArtifactInput(kind==='log'?'intent':'triage',kind==='log'?{conversationId:conv.id,goal:'goal',did:'did',issues:'',next:'next'}:{keep:[{what:'verified keep'}],stash:[],drop:[]});
  const name=kind==='ledger'?'memory_propose':'memory_stage',callId=randomUUID();
  appendMessage(db,{conversationId:conv.id,role:'assistant',displayChannel:'maintenance',toolCalls:[{id:callId,name,arguments:'{}',displayChannel:'maintenance'}]});
  const proposal=submitProposal(db,{conversationId:conv.id,recordId:value.recordId,kind:kind==='ledger'?'active':'note',title:value.title,content:value.content,operation:'upsert',baseRevision:0,reason:'genuine saved tool evidence',idempotencyKey:randomUUID()});
  const msg=appendMessage(db,{conversationId:conv.id,role:'tool',displayChannel:'maintenance',toolCallId:callId,content:JSON.stringify({ok:true,content:JSON.stringify({proposal})})});
  noteObligationProposal(db,conv.id,user.seq,proposal.id,msg.seq);return proposal;
 }
 const complete=()=>[receipt('ledger'),receipt('log'),receipt('triage')];
 return{db,provider,project,conv,user,receipt,complete};
}
const signal=()=>new AbortController().signal;
function provider(reply='concise verified recap',inspect?:(req:ChatRequest)=>void):Provider{return{id:'offline',async *stream(req){inspect?.(req);yield{type:'text',delta:reply};yield{type:'usage',usage:{input:10,cached:20,cachedWrite:30,output:5}};yield{type:'finish',reason:'stop'};}};}
const failure=(code:string)=>(error:unknown)=>error instanceof CompactionError&&error.code===code;

for(const origin of ['manual','auto','checkpoint'] as CompactionSource[])for(const missing of ['ledger','log','triage'] as const){
 test(`engine ${origin}: missing ${missing} is blocked BEFORE lazy provider or capsule`,async t=>{
  const f=fixture(t);for(const kind of ['ledger','log','triage'] as const)if(kind!==missing)f.receipt(kind);
  assert.equal(getCompactionDuties(f.db,f.conv.id).complete,false);let calls=0;
  await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,source:origin,createProvider:()=>{calls++;return provider();},signal:signal()}),failure('blocked'));
  assert.equal(calls,0);assert.equal(queryCapsules(f.db,f.conv.id).length,0);assert.equal(listCompactions(f.db,f.conv.id).length,0);
  const last=listCompactionEvents(f.db,f.conv.id).entries[0]!;assert.equal(last.phase,'blocked');assert.equal(last.code,'COMPACTION_BLOCKED_DUTIES');assert.ok(last.missing.includes(missing));
 });
}
test('engine planning is PURE, caps at latest three-duty boundary, retains >=10% window, and keepRecent can only shrink range',t=>{
 const f=fixture(t);f.complete();assert.equal(getCompactionDuties(f.db,f.conv.id).complete,true);
 const before=f.db.prepare('SELECT total_changes() AS n').get()!['n'];const a=planCompaction(f.db,f.conv.id),b=planCompaction(f.db,f.conv.id,{keepRecent:1}),c=planCompaction(f.db,f.conv.id,{keepRecent:25});
 assert.equal(a.status,'ready');assert.deepEqual(a,b);assert.ok((c.toSeq??0)<=a.toSeq!);assert.ok(a.retainedTokens>=1000);assert.ok(a.toSeq!<=getLatestCompactionCheckpoint(f.db,f.conv.id)!.safeCutSeq);
 assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!['n'],before);
});
test('engine success: capsule BEFORE inference, FULL source beyond 1500, fixed eight sections, one transport, real model and total input buckets',async t=>{
 const f=fixture(t);f.complete();const originals=JSON.stringify(listMessages(f.db,f.conv.id));let calls=0;
 const row=await compactRange({db:f.db,conversationId:f.conv.id,createProvider:()=>{calls++;assert.equal(queryCapsules(f.db,f.conv.id).length,1);return provider('verified recap',req=>{
  assert.match(JSON.stringify(req),/ORIGINAL_BEYOND_1500/);assert.equal(req.model,'chosen-existing');assert.equal(req.maxTokens,4096);assert.equal(req.maxAttempts,1);
 });},signal:signal()});
 assert.equal(calls,1);assert.ok(row);for(const section of COMPACTION_SECTIONS)assert.ok(row.summary.includes(`## ${section}\n`));
 assert.equal(row.model,'chosen-existing');assert.equal(row.inputTokens,60);assert.equal(JSON.stringify(listMessages(f.db,f.conv.id)),originals);
 assert.equal(getCompactionState(f.db,f.conv.id).lastAttempt!.state,'succeeded');
 const events=listCompactionEvents(f.db,f.conv.id);assert.equal(events.entries[0]!.phase,'success');assert.equal(events.entries[1]!.phase,'start');assert.equal(events.entries[0]!.timestamp,events.entries[0]!.createdAt);
});
test('engine capsule insertion failure prevents lazy provider creation and persists fixed failure',async t=>{
 const f=fixture(t);f.complete();f.db.exec("CREATE TRIGGER fail_capsule BEFORE INSERT ON memory_capsules BEGIN SELECT RAISE(ABORT,'simulated private source failure'); END");let calls=0;
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,createProvider:()=>{calls++;return provider();},signal:signal()}),failure('capsule'));
 assert.equal(calls,0);assert.equal(listCompactionEvents(f.db,f.conv.id).entries[0]!.code,'COMPACTION_CAPSULE_FAILED');assert.equal(getCompactionState(f.db,f.conv.id).running,false);
});
test('engine all entry points share the same durable running lease and process mutex',async t=>{
 const f=fixture(t);f.complete();let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});let calls=0;
 const first=compactRange({db:f.db,conversationId:f.conv.id,source:'manual',createProvider:()=>{calls++;return{id:'offline',async *stream(){await wait;yield{type:'text',delta:'summary'};yield{type:'finish',reason:'stop'};}};},signal:signal()});
 try{await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,source:'checkpoint',createProvider:()=>{calls++;return provider();},signal:signal()}),failure('busy'));assert.equal(calls,1);}finally{release();}
 assert.ok(await first);assert.equal(listCompactions(f.db,f.conv.id).length,1);
});
test('engine durable lease blocks an independent claimant before any inference; expired leases recover visibly',async t=>{
 const f=fixture(t);f.complete();const plan=planCompaction(f.db,f.conv.id);const id=randomUUID();
 f.db.prepare("INSERT INTO compaction_attempts(id,conversation_id,project_id,anchor_id,source,state,from_seq,to_seq,plan_hash,lease_until,started_at) VALUES(?,?,?,?,?,'running',?,?,?,?,?)").run(id,f.conv.id,f.project.id,plan.anchorId!,'manual',plan.fromSeq!,plan.toSeq!,plan.fingerprint!,Date.now()+10000,new Date().toISOString());let calls=0;
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,createProvider:()=>{calls++;return provider();},signal:signal()}),failure('busy'));assert.equal(calls,0);
 f.db.prepare('UPDATE compaction_attempts SET lease_until=0 WHERE id=?').run(id);
 assert.ok(await compactRange({db:f.db,conversationId:f.conv.id,provider:provider(),signal:signal()}));assert.ok(listCompactionEvents(f.db,f.conv.id).entries.some(e=>e.code==='COMPACTION_LEASE_EXPIRED'));
});
test('engine auto attempts are once-per-anchor even after FAILURE and database reopen, manual retry stays explicit',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'alkaid-compaction-engine-'));const path=join(dir,'test.db');const f=fixture(t,path);f.complete();let calls=0;
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,source:'auto',createProvider:()=>{calls++;return provider('');},signal:signal()}),failure('summary'));f.db.close();
 const db=new DatabaseSync(path);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 await assert.rejects(()=>compactRange({db,conversationId:f.conv.id,source:'auto',createProvider:()=>{calls++;return provider();},signal:signal()}),failure('auto_duplicate'));assert.equal(calls,1);
 assert.ok(await compactRange({db,conversationId:f.conv.id,source:'manual',createProvider:()=>{calls++;return provider();},signal:signal()}));assert.equal(calls,2);
});
test('engine crashed auto lease is recovered locally but NEVER retried for the same anchor',async t=>{
 const f=fixture(t);f.complete();const plan=planCompaction(f.db,f.conv.id);const id=randomUUID();
 f.db.prepare("INSERT INTO compaction_attempts(id,conversation_id,project_id,anchor_id,source,state,from_seq,to_seq,plan_hash,lease_until,started_at) VALUES(?,?,?,?,?,'running',?,?,?,?,?)").run(id,f.conv.id,f.project.id,plan.anchorId!,'auto',plan.fromSeq!,plan.toSeq!,plan.fingerprint!,0,new Date().toISOString());let calls=0;
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,source:'auto',createProvider:()=>{calls++;return provider();},signal:signal()}),failure('auto_duplicate'));
 assert.equal(calls,0);assert.equal(getCompactionState(f.db,f.conv.id).lastAttempt!.state,'failed');assert.ok(listCompactionEvents(f.db,f.conv.id).entries.some(e=>e.code==='COMPACTION_LEASE_EXPIRED'));
 assert.throws(()=>f.db.prepare('DELETE FROM compaction_attempts WHERE id=?').run(id),/cannot be deleted/);
 assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO compaction_attempts SELECT * FROM compaction_attempts WHERE id=?').run(id),/cannot be replaced/);
 assert.throws(()=>f.db.prepare("UPDATE compaction_attempts SET state='running' WHERE id=?").run(id),/immutable/);
});
test('engine noncooperative provider times out promptly, releases lease, and cannot commit late text',async t=>{
 const f=fixture(t);f.complete();const start=Date.now();
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,provider:{id:'never',async *stream(){await new Promise(()=>{});yield{type:'text',delta:'late'};}},timeoutMs:20,signal:signal()}),failure('timeout'));
 assert.ok(Date.now()-start<2000);assert.equal(getCompactionState(f.db,f.conv.id).running,false);assert.equal(listCompactions(f.db,f.conv.id).length,0);assert.equal(listCompactionEvents(f.db,f.conv.id).entries[0]!.code,'COMPACTION_TIMEOUT');
});
test('engine abort before factory and while noncooperative generation never commits or retries',async t=>{
 const f=fixture(t);f.complete();const pre=new AbortController();pre.abort();let calls=0;
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,createProvider:()=>{calls++;return provider();},signal:pre.signal}),failure('cancelled'));assert.equal(calls,0);
 const during=new AbortController();const running=compactRange({db:f.db,conversationId:f.conv.id,provider:{id:'never',async *stream(){await new Promise(()=>{});yield{type:'text',delta:'late'};}},signal:during.signal});during.abort();await assert.rejects(()=>running,failure('cancelled'));assert.equal(listCompactions(f.db,f.conv.id).length,0);
});
test('engine output overflow, upstream error and empty summary fail closed with body-free diagnostic codes',async t=>{
 const f=fixture(t);f.complete();
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,provider:provider('x'.repeat(20100)),signal:signal()}),failure('output_limit'));
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,provider:{id:'error',async *stream(){yield{type:'error',message:'UPSTREAM_PRIVATE_BODY api_key=SECRET_KEY_123456789',retryable:true};}},signal:signal()}),failure('summary'));
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,provider:provider('   '),signal:signal()}),failure('summary'));
 assert.equal(listCompactions(f.db,f.conv.id).length,0);assert.doesNotMatch(JSON.stringify(listCompactionEvents(f.db,f.conv.id)),/UPSTREAM_PRIVATE_BODY|SECRET_KEY|verified current|finish verified work/);
});
test('engine headings-only and all-placeholder recaps fail closed, leaving full live history intact',async t=>{
 const f=fixture(t);f.complete();const before=assembleContext(f.db,f.conv.id);
 for(const body of [COMPACTION_SECTIONS.map(s=>`## ${s}`).join('\n\n'),COMPACTION_SECTIONS.map(s=>`## ${s}\n未提供，需按原文指针核对。`).join('\n\n')]){
  await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,provider:provider(body),signal:signal()}),failure('summary'));
  assert.deepEqual(assembleContext(f.db,f.conv.id),before);assert.equal(listCompactions(f.db,f.conv.id).length,0);
 }
 assert.equal(listCompactionEvents(f.db,f.conv.id).entries.filter(e=>e.phase==='success').length,0);
});
test('engine reasoning floods count toward the same bounded output budget',async t=>{
 const f=fixture(t);f.complete();
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,provider:{id:'reasoning',async *stream(){yield{type:'reasoning',delta:'x'.repeat(20001)};yield{type:'text',delta:'summary'};}},signal:signal()}),failure('output_limit'));
 assert.equal(listCompactions(f.db,f.conv.id).length,0);
});
test('engine synchronous empty-event flood cannot starve the wall-clock deadline',async t=>{
 const f=fixture(t);f.complete();const start=Date.now();
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,provider:{id:'flood',async *stream(){for(;;)yield{type:'reasoning',delta:''};}},timeoutMs:20,signal:signal()}),failure('timeout'));
 assert.ok(Date.now()-start<2000);assert.equal(getCompactionState(f.db,f.conv.id).running,false);
});
test('engine input budget checks complete request and never slices oversized originals or constructs provider',async t=>{
 const f=fixture(t);f.complete();let calls=0;
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,maxInputChars:100,createProvider:()=>{calls++;return provider();},signal:signal()}),failure('input_limit'));
 assert.equal(calls,0);assert.equal(queryCapsules(f.db,f.conv.id).length,0);assert.equal(listCompactionEvents(f.db,f.conv.id).entries[0]!.code,'COMPACTION_BLOCKED_INPUT_LIMIT');
});
test('engine rejects a changed original, old summary or rejected duty after generation before commit',async t=>{
 for(const change of ['original','summary','duty'] as const){
  const f=fixture(t);const proposals=f.complete();
  await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,provider:provider('fresh',()=>{
   if(change==='original')f.db.prepare("UPDATE messages SET content='changed source' WHERE conversation_id=? AND seq=1").run(f.conv.id);
   if(change==='summary')insertCompaction(f.db,{conversationId:f.conv.id,fromSeq:1,toSeq:2,summary:'concurrent legacy summary'});
   if(change==='duty')rejectProposal(f.db,f.project.id,proposals[0]!.id);
  }),signal:signal()}),failure('changed'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compaction_metadata').get()!['n'],0);
 }
});
test('engine transaction rolls back summary, metadata and success event together on real SQL failure',async t=>{
 const f=fixture(t);f.complete();f.db.exec("CREATE TRIGGER fail_metadata BEFORE INSERT ON compaction_metadata BEGIN SELECT RAISE(ABORT,'simulated private SQL text'); END");
 await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,provider:provider(),signal:signal()}),failure('commit'));
 assert.equal(listCompactions(f.db,f.conv.id).length,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compaction_metadata').get()!['n'],0);
 assert.equal(listCompactionEvents(f.db,f.conv.id).entries.filter(e=>e.phase==='success').length,0);assert.equal(listCompactionEvents(f.db,f.conv.id).entries[0]!.code,'COMPACTION_COMMIT_FAILED');
 assert.equal(queryCapsules(f.db,f.conv.id).length,1,'already persisted original capsule is intentionally retained');
});
test('engine latest cumulative recap merges prior effective summaries once, keeps legacy originals and bounded active projection',async t=>{
 const f=fixture(t);f.complete();insertCompaction(f.db,{conversationId:f.conv.id,fromSeq:1,toSeq:2,summary:'LEGACY_FACT_KEEP'});
 const legacy=listCompactions(f.db,f.conv.id)[0]!;
 const first=await compactRange({db:f.db,conversationId:f.conv.id,provider:provider('CUMULATIVE_ONE',req=>{
  const body=JSON.parse(req.messages[1]!.content!);assert.equal(body.previousRecaps.length,1);assert.equal(body.previousRecaps[0].summary,'LEGACY_FACT_KEEP');
 }),signal:signal()});assert.ok(first);assert.equal(assembleContext(f.db,f.conv.id).summaries.length,1);assert.equal(listCompactions(f.db,f.conv.id).find(row=>row.id===legacy.id)!.summary,'LEGACY_FACT_KEEP');
 // New genuine turn with enough growth and three fresh duties; all old summary rows stay immutable/readable.
 for(let i=0;i<20;i++)appendMessage(f.db,{conversationId:f.conv.id,role:'assistant',content:'new growth '+'y'.repeat(400)});
 const user=appendMessage(f.db,{conversationId:f.conv.id,role:'user',content:'new complete turn'});beginObligation(f.db,f.conv.id,user.seq);
 for(const kind of ['ledger','log','triage'] as const){
  const artifact=kind==='ledger'?{recordId:randomUUID(),title:'next',content:'next fact'}:makeArtifactInput(kind==='log'?'intent':'triage',kind==='log'?{conversationId:f.conv.id,goal:'g',did:'d',issues:'',next:'n'}:{keep:[{what:'keep'}],stash:[],drop:[]});
  const name=kind==='ledger'?'memory_propose':'memory_stage',id=randomUUID();appendMessage(f.db,{conversationId:f.conv.id,role:'assistant',displayChannel:'maintenance',toolCalls:[{id,name,arguments:'{}',displayChannel:'maintenance'}]});
  const p=submitProposal(f.db,{conversationId:f.conv.id,recordId:artifact.recordId,kind:kind==='ledger'?'active':'note',title:artifact.title,content:artifact.content,operation:'upsert',baseRevision:0,reason:'verified new turn',idempotencyKey:randomUUID()});const msg=appendMessage(f.db,{conversationId:f.conv.id,role:'tool',displayChannel:'maintenance',toolCallId:id,content:JSON.stringify({ok:true,content:JSON.stringify({proposal:p})})});noteObligationProposal(f.db,f.conv.id,user.seq,p.id,msg.seq);
 }
 const second=await compactRange({db:f.db,conversationId:f.conv.id,provider:provider('CUMULATIVE_TWO',req=>{const old=JSON.parse(req.messages[1]!.content!).previousRecaps;assert.equal(old.length,1);assert.ok(old[0].summary.includes('CUMULATIVE_ONE'));assert.doesNotMatch(old[0].summary,/LEGACY_FACT_KEEP/);}),signal:signal()});
 assert.ok(second);assert.equal(assembleContext(f.db,f.conv.id).summaries.length,1);assert.equal(listCompactions(f.db,f.conv.id).length,3);
 assert.throws(()=>f.db.prepare('UPDATE compaction_metadata SET covers_from_seq=0').run(),/append-only/);assert.throws(()=>f.db.prepare('DELETE FROM compaction_events').run(),/append-only/);
 assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO compaction_metadata SELECT * FROM compaction_metadata LIMIT 1').run(),/replaced/);
});
test('engine safe selection does not split assistant/tool results and does not delete malformed raw history',t=>{
 const f=fixture(t);f.complete();const messages=listMessages(f.db,f.conv.id);const plan=planCompaction(f.db,f.conv.id);
 assert.equal(plan.status,'ready');for(let i=0;i<messages.length;i++){const row=messages[i]!;if(!row.toolCalls?.length)continue;let end=i;while(messages[end+1]?.role==='tool')end++;assert.ok(!(row.seq<=plan.toSeq!&&messages[end]!.seq>plan.toSeq!));}
 const snapshot=JSON.stringify(messages);assembleContext(f.db,f.conv.id);assert.equal(JSON.stringify(listMessages(f.db,f.conv.id)),snapshot);
});
test('engine token tail landing inside a real tool batch retreats BEFORE the assistant call',t=>{
 const f=fixture(t);const id=randomUUID();
 const assistant=appendMessage(f.db,{conversationId:f.conv.id,role:'assistant',toolCalls:[{id,name:'read',arguments:'{}'}]});
 appendMessage(f.db,{conversationId:f.conv.id,role:'tool',toolCallId:id,content:JSON.stringify({ok:true,content:'y'.repeat(5000)})});
 f.complete();const plan=planCompaction(f.db,f.conv.id);
 assert.equal(plan.status,'ready');assert.ok(plan.toSeq!<assistant.seq,'must retain BOTH the call and its large result');assert.ok(plan.retainedTokens>=1000);
});
test('engine invalid numeric overrides cannot turn off bounded output, input or deadline guards',async t=>{
 const f=fixture(t);f.complete();let calls=0;
 for(const override of [{maxOutputChars:NaN},{maxOutputChars:0},{maxInputChars:-1},{timeoutMs:Infinity}])await assert.rejects(()=>compactRange({db:f.db,conversationId:f.conv.id,...override,createProvider:()=>{calls++;return provider();},signal:signal()}),TypeError);
 assert.equal(calls,0);
});
test('engine subagents and projectless conversations cannot satisfy the gate using a parent anchor',async t=>{
 const f=fixture(t);f.complete();let calls=0;
 for(const conv of [insertConversation(f.db,{providerId:f.provider.id,model:'m'}),insertConversation(f.db,{providerId:f.provider.id,model:'m',projectId:f.project.id,agentRole:'subagent'})]){
  await assert.rejects(()=>compactRange({db:f.db,conversationId:conv.id,createProvider:()=>{calls++;return provider();},signal:signal()}),failure('blocked'));
 }
 assert.equal(calls,0);
});
test('engine caller preflight records blocked diagnostics idempotently without starting an attempt or accepting memory',t=>{
 const f=fixture(t);f.receipt('ledger');const plan=planCompaction(f.db,f.conv.id,{source:'checkpoint'});
 assert.equal(plan.status,'blocked');recordCompactionBlocked(f.db,plan);recordCompactionBlocked(f.db,plan);
 assert.equal(listCompactionEvents(f.db,f.conv.id).total,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compaction_attempts').get()!['n'],0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE status='applied'").get()!['n'],0);
 assert.throws(()=>recordCompactionBlocked(f.db,{...plan,status:'ready'}),TypeError);
});
test('engine no safe candidate is a visible non-generation and event pages are pure bounded reads',async t=>{
 const f=fixture(t);f.complete();let calls=0;const row=await compactRange({db:f.db,conversationId:f.conv.id,keepRecent:10000,createProvider:()=>{calls++;return provider();},signal:signal()});assert.equal(row,null);assert.equal(calls,0);
 const changes=f.db.prepare('SELECT total_changes() AS n').get()!['n'];const page=listCompactionEvents(f.db,f.conv.id,1,0);assert.equal(page.total,1);assert.equal(page.entries[0]!.code,'COMPACTION_BLOCKED_NO_CANDIDATE');assert.equal(listCompactionEvents(f.db,f.conv.id,1,1).entries.length,0);getCompactionState(f.db,f.conv.id);assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!['n'],changes);
});
