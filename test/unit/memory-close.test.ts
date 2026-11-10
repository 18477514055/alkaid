import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { runTurn, type RunTurnOptions } from '../../src/core/agent/loop.ts';
import { MEMORY_CLOSE_MAX_INPUT_CHARS } from '../../src/core/agent/memory-close.ts';
import { setMemoryPolicy } from '../../src/core/memory/rhythm.ts';
import { projectMemoryBlock } from '../../src/core/agent/prompt/memory.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { insertProject, insertProvider, insertConversation, listMessages, getConversation, updateConversation } from '../../src/core/store/repo.ts';
import { listStepEvents } from '../../src/core/store/audit.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import { setToolMode } from '../../src/core/tools/settings.ts';
import { getMemoryView, applyProposalManually, rejectProposal } from '../../src/core/memory/store.ts';
import { queryObligations, readObligation } from '../../src/core/memory/obligations.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

type Call = [string, Record<string, unknown>];
const progress = (key='one'): Call => ['memory_propose',{recordId:`fact-${key}`,kind:'active',title:'真实调查结论',operation:'upsert',content:`VERIFIED_FACT_${key}`,baseRevision:0,reason:'本轮工具证据',idempotencyKey:`progress-${key}`}];
const triage = (key='one'): Call => ['memory_stage',{action:'triage',payload:{keep:[{what:`KEEP_${key}`}],stash:[],drop:[]},idempotencyKey:`triage-${key}`,reason:'本轮分流'}];
async function* calls(items: Call[]): AsyncGenerator<ChatEvent> {
 for(const [index,[name,args]] of items.entries()) yield {type:'tool_call',index,id:`call-${index}`,name,argsDelta:JSON.stringify(args)};
 yield {type:'finish',reason:'tool_calls'};
}
async function* text(value='业务答复不重述'): AsyncGenerator<ChatEvent> { yield {type:'text',delta:value};yield {type:'finish',reason:'stop'}; }
function scripted(run:(request:ChatRequest,index:number,signal:AbortSignal)=>AsyncGenerator<ChatEvent>) {
 const requests:ChatRequest[]=[];
 const provider:Provider={id:'local-test',stream(request,signal){const i=requests.length;requests.push(request);return run(request,i,signal);}};
 return {requests,provider};
}
function fixture(t:TestContext) {
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');migrate(db);
 const dir=mkdtempSync(join(tmpdir(),'alkaid-close-test-'));
 const p=insertProject(db,{id:'p',name:'P',sharedDir:dir});
 // Preserve per-turn closure safety independently of the production 5% rhythm.
 setMemoryPolicy(db,p.id,{thresholdPercent:0});
 const provider=insertProvider(db,{name:'local-test',baseUrl:'http://127.0.0.1:1'});
 const a=insertConversation(db,{providerId:provider.id,model:'chosen-existing-model',projectId:p.id,permissionMode:'full'});
 const b=insertConversation(db,{providerId:provider.id,model:'chosen-existing-model',projectId:p.id,permissionMode:'full'});
 const tools=createDefaultRegistry(db);
 tools.register({name:'inspect_facts',description:'读取已验证事实',modes:['full','readonly'],kind:'read_only',parameters:{type:'object',properties:{}},async execute(){return {ok:true,content:'verified evidence, not a new filesystem mutation'};}});
 t.after(()=>{db.close();assert.ok(dir.startsWith(join(tmpdir(),'alkaid-close-test-')));rmSync(dir,{recursive:true,force:true});});
 const run=async(provider:Provider,patch:Partial<RunTurnOptions>={})=>{const out=[];for await(const event of runTurn({db,conversationId:a.id,userText:'完成本轮工作',provider,tools,workspacePath:dir,signal:new AbortController().signal,...patch}))out.push(event);return out;};
 return{db,dir,p,a,b,tools,run};
}
const isClose=(request:ChatRequest)=>request.messages.some(message=>String(message.content).includes('MEMORY_TURN_CLOSURE'));
const visible=(events:Awaited<ReturnType<ReturnType<typeof fixture>['run']>>)=>events.filter(event=>event.type==='text').map(event=>event.type==='text'?event.delta:'').join('');

test('closure: omitted obligations trigger one real provider continuation, two verified pending proposals, then peer can read only after independent review',async t=>{
 const f=fixture(t);const s=scripted((_r,n)=>n===0?text():calls([progress(),triage()]));
 const events=await f.run(s.provider);assert.equal(s.requests.length,2);assert.equal(s.requests.filter(isClose).length,1);assert.equal(visible(events),'业务答复不重述');
 const repair=s.requests[1]!;assert.doesNotMatch(String(repair.messages[0]?.content),/MEMORY_TURN_CLOSURE/);assert.equal(repair.messages[0]?.content,s.requests[0]?.messages[0]?.content,'closure must preserve the first system bytes');assert.ok(repair.messages.some(message=>message.role==='user'&&String(message.content).includes('MEMORY_TURN_CLOSURE')));assert.equal(repair.model,'chosen-existing-model');assert.equal(repair.maxAttempts,1);assert.equal(repair.maxTokens,4096);assert.ok(repair.tools?.some(tool=>tool.name==='memory_stage'));assert.ok(repair.tools?.every(tool=>tool.name.startsWith('memory_')));
 const stage=repair.tools!.find(tool=>tool.name==='memory_stage')!;
 assert.deepEqual(stage.parameters.required,['action','payload','idempotencyKey','reason']);
 assert.deepEqual((stage.parameters.properties as Record<string,{enum?:string[]}>).action!.enum,['intent','triage']);
 assert.equal(listMessages(f.db,f.a.id).filter(row=>row.role==='user').length,1,'internal continuation is not a fake user turn');
 const obligation=readObligation(f.db,f.a.id,1)!;assert.equal(obligation.status,'staged');assert.equal(obligation.repairAttempt,1);assert.equal(obligation.evidence.length,2);assert.deepEqual(obligation.missing,[]);
 const view=getMemoryView(f.db,f.p.id);assert.equal(view.proposals.length,2);assert.ok(view.proposals.every(p=>p.status==='pending'));assert.equal(view.records.length,0);assert.doesNotMatch(projectMemoryBlock(f.db,f.b.id)!,/VERIFIED_FACT_one|KEEP_one/);
 for(const proposal of view.proposals)applyProposalManually(f.db,f.p.id,proposal.id);
 assert.match(projectMemoryBlock(f.db,f.b.id)!,/VERIFIED_FACT_one/);assert.match(projectMemoryBlock(f.db,f.b.id)!,/KEEP_one/);assert.equal(getConversation(f.db,f.a.id)?.state,'idle');
});
test('closure: primary completes both duties proactively, no repair charge or prose replay',async t=>{
 const f=fixture(t);const s=scripted((_r,n)=>n===0?calls([progress(),triage()]):text('只显示业务结果'));
 const events=await f.run(s.provider);assert.equal(s.requests.length,2);assert.equal(s.requests.filter(isClose).length,0);assert.equal(visible(events),'只显示业务结果');assert.equal(readObligation(f.db,f.a.id,1)?.status,'staged');assert.equal(readObligation(f.db,f.a.id,1)?.repairAttempt,0);
 assert.ok(readObligation(f.db,f.a.id,1)?.events.some(event=>event.type==='finish'&&event.code==='OBLIGATION_STAGED'));
 rejectProposal(f.db,'p',readObligation(f.db,f.a.id,1)!.progress!.proposalId);
 assert.equal(readObligation(f.db,f.a.id,1)?.status,'incomplete');
 assert.equal(readObligation(f.db,f.a.id,1)?.code,'OBLIGATION_EVIDENCE_INVALID');
});
test('closure: a progress-only turn is incomplete until the single continuation actually submits triage',async t=>{
 const f=fixture(t);const s=scripted((_r,n)=>n===0?calls([progress()]):n===1?text():calls([triage()]));
 await f.run(s.provider);assert.equal(s.requests.length,3);assert.equal(s.requests.filter(isClose).length,1);assert.equal(readObligation(f.db,f.a.id,1)?.status,'staged');assert.equal(getMemoryView(f.db,f.p.id).proposals.length,2);
});
test('closure: later read-only business activity makes BOTH previous duty receipts stale, requires fresh successful proposals',async t=>{
 const f=fixture(t);const s=scripted((_r,n)=>n===0?calls([progress(),triage(),['inspect_facts',{}]]):n===1?text():calls([progress('fresh'),triage('fresh')]));
 await f.run(s.provider);const duty=readObligation(f.db,f.a.id,1)!;assert.equal(duty.status,'staged');assert.equal(duty.evidence.length,4);assert.equal(duty.evidence.filter(row=>row.stale).length,2);assert.equal(duty.progress?.stale,false);assert.equal(duty.triage?.stale,false);
});
test('closure: genuine no-progress is explicit model exemption, not fabricated memory or a human skip',async t=>{
 const f=fixture(t);const s=scripted((_r,n)=>n===0?calls([['memory_disposition',{reason:'本轮只是问候，未产生新的项目事实'}]]):text('你好'));
 await f.run(s.provider,{userText:'你好'});const duty=readObligation(f.db,f.a.id,1)!;assert.equal(duty.status,'exempt');assert.equal(duty.code,'OBLIGATION_NO_PROGRESS');assert.equal(duty.reasonSource,'model');assert.equal(duty.semanticProof,false);assert.equal(s.requests.filter(isClose).length,0);assert.equal(getMemoryView(f.db,'p').proposals.length,0);
});
test('closure: early no-progress followed by actual file write becomes required; repair cannot use another no-progress to escape',async t=>{
 const f=fixture(t);const path=join(f.dir,'actual.txt');const s=scripted((_r,n)=>n===0?calls([['memory_disposition',{reason:'尚未执行新工作'}],['write',{path,content:'actual successful change'}]]):n===1?text():calls([['memory_disposition',{reason:'不能用无新增掩盖实际成功写入'}]]));
 await f.run(s.provider);assert.equal(readFileSync(path,'utf8'),'actual successful change');const duty=readObligation(f.db,f.a.id,1)!;assert.equal(duty.status,'incomplete');assert.equal(duty.mutated,true);assert.equal(duty.repairAttempt,1);assert.equal(getMemoryView(f.db,'p').proposals.length,0);
});
test('closure: a model that ignores the reminder stays visibly incomplete after ONE continuation, never loops',async t=>{
 const f=fixture(t);const s=scripted((_r,n)=>text(n?'不要在正文复述的维护废话':'原业务结果'));
 const events=await f.run(s.provider);assert.equal(s.requests.length,2);assert.equal(visible(events),'原业务结果');const duty=readObligation(f.db,f.a.id,1)!;assert.equal(duty.status,'incomplete');assert.equal(duty.code,'OBLIGATION_REPAIR_EXHAUSTED');assert.equal(duty.repairAttempt,1);assert.equal(queryObligations(f.db,'p').summary.incomplete,1);assert.doesNotMatch(JSON.stringify(listMessages(f.db,f.a.id)),/维护废话/);
});
test('closure: automatic continuation cannot execute business tools or propose principles',async t=>{
 const f=fixture(t);let executed=0;f.tools.register({name:'dangerous_business',description:'must not execute',modes:['full'],kind:'external',parameters:{type:'object',properties:{}},async execute(){executed++;return {ok:true,content:'bad'};}});
 const s=scripted((_r,n)=>n===0?text():calls([['dangerous_business',{}],['memory_stage',{action:'principle_propose',payload:{recordId:'p',title:'bad',content:'bad',operation:'upsert',baseRevision:0}}]]));
 await f.run(s.provider);assert.equal(executed,0);assert.equal(getMemoryView(f.db,'p').proposals.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_principle_proposals').get()?.['n'],0);assert.equal(readObligation(f.db,f.a.id,1)?.status,'incomplete');
});
test('closure: partial arguments after provider error never execute, useful failure code only in diagnostics',async t=>{
 const f=fixture(t);const s=scripted(async function*(_r,n){if(!n){yield*text();return;}yield{type:'tool_call',index:0,id:'partial',name:'memory_propose',argsDelta:JSON.stringify(progress()[1])};yield{type:'error',message:'PRIVATE_UPSTREAM_BODY api_key=DO_NOT_PERSIST_123456',retryable:true};});
 await f.run(s.provider);assert.equal(s.requests.length,2);assert.equal(getMemoryView(f.db,'p').proposals.length,0);assert.equal(readObligation(f.db,f.a.id,1)?.code,'OBLIGATION_REPAIR_FAILED');assert.doesNotMatch(JSON.stringify(listStepEvents(f.db,f.a.id)),/PRIVATE_UPSTREAM|DO_NOT_PERSIST/);
});
test('closure: reported usage from a failed repair remains in message-backed stats without raw text or partial tools',async t=>{
 const f=fixture(t);const s=scripted(async function*(_r,n){if(!n){yield*text();return;}yield{type:'usage',usage:{input:73,output:19}};yield{type:'error',message:'PRIVATE_RESPONSE_NOT_TO_STORE',retryable:false};});
 await f.run(s.provider);const rows=listMessages(f.db,f.a.id);assert.equal(rows.reduce((sum,row)=>sum+(row.usage?.input??0),0),73);assert.equal(rows.reduce((sum,row)=>sum+(row.usage?.output??0),0),19);
 assert.ok(rows.some(row=>row.displayChannel==='maintenance'&&row.finishReason==='error'&&row.usage?.input===73));assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_RESPONSE_NOT_TO_STORE/);
});
test('closure: uncooperative hanging continuation times out once and returns without background mutation',async t=>{
 const f=fixture(t);const s=scripted(async function*(_r,n){if(!n){yield*text();return;}await new Promise<void>(()=>{});});
 await f.run(s.provider,{memoryClosureTimeoutMs:20});assert.equal(s.requests.length,2);assert.equal(readObligation(f.db,f.a.id,1)?.code,'OBLIGATION_REPAIR_TIMEOUT');assert.equal(getMemoryView(f.db,'p').proposals.length,0);
});
test('closure: malformed or duplicate repair call identities cannot poison persisted protocol or execute',async t=>{
 for(const kind of ['missing','duplicate','bad-name']) {
  const f=fixture(t);const s=scripted(async function*(_r,n){if(!n){yield*text();return;}
   yield{type:'tool_call',index:0,id:kind==='missing'?'':'same',name:kind==='bad-name'?'memory.propose':'memory_propose',argsDelta:JSON.stringify(progress()[1])};
   if(kind==='duplicate')yield{type:'tool_call',index:1,id:'same',name:'memory_stage',argsDelta:JSON.stringify(triage()[1])};
   yield{type:'finish',reason:'tool_calls'};
  });
  await f.run(s.provider);assert.equal(getMemoryView(f.db,'p').proposals.length,0);assert.equal(readObligation(f.db,f.a.id,1)?.code,'OBLIGATION_REPAIR_FAILED');
  assert.equal(listMessages(f.db,f.a.id).filter(row=>row.toolCalls?.length).length,0);
 }
});
test('closure: over-budget source is NOT truncated or sent, no extra provider call',async t=>{
 const f=fixture(t);const sourceChars=MEMORY_CLOSE_MAX_INPUT_CHARS+1;const s=scripted(()=>text('x'.repeat(sourceChars)));const events=await f.run(s.provider);assert.equal(visible(events).length,sourceChars);assert.equal(s.requests.length,1);assert.equal(readObligation(f.db,f.a.id,1)?.code,'OBLIGATION_REPAIR_INPUT_LIMIT');
});
test('closure: provider failure before work is exempt, but failure after a successful write is unfinished and does not cause a paid repair',async t=>{
 const f=fixture(t);const failing=scripted(async function*(){yield{type:'error',message:'private body',retryable:false};});await f.run(failing.provider);assert.equal(failing.requests.length,1);assert.equal(readObligation(f.db,f.a.id,1)?.status,'exempt');
 const path=join(f.dir,'partial.txt');const s=scripted(async function*(_r,n){if(!n){yield*calls([['write',{path,content:'partial work'}]]);return;}yield{type:'error',message:'private body',retryable:false};});await f.run(s.provider,{conversationId:f.b.id});assert.equal(s.requests.length,2);assert.equal(readObligation(f.db,f.b.id,1)?.status,'incomplete');assert.equal(readObligation(f.db,f.b.id,1)?.mutated,true);
});
test('closure: readonly still repairs both duties once; missing registry and disabled tools remain explicit no-bypass exemptions',async t=>{
 const f=fixture(t);updateConversation(f.db,f.a.id,{permissionMode:'readonly'});
 let s=scripted((_r,n)=>n===0?text():calls([progress('readonly'),triage('readonly')]));
 const events=await f.run(s.provider);assert.equal(s.requests.length,2);assert.equal(s.requests.filter(isClose).length,1);assert.equal(visible(events),'业务答复不重述');
 const readonlyDuty=readObligation(f.db,f.a.id,1)!;assert.equal(readonlyDuty.status,'staged');assert.equal(readonlyDuty.repairAttempt,1);assert.equal(readonlyDuty.evidence.length,2);assert.deepEqual(readonlyDuty.missing,[]);assert.notEqual(readonlyDuty.code,'OBLIGATION_READONLY');
 assert.ok(readonlyDuty.evidence.every(row=>row.valid&&!row.stale));assert.equal(getMemoryView(f.db,'p').proposals.length,2);assert.ok(getMemoryView(f.db,'p').proposals.every(row=>row.status==='pending'));assert.equal(getMemoryView(f.db,'p').records.length,0,'readonly capture is staged, never a direct formal write');
 s=scripted(()=>text());await f.run(s.provider,{conversationId:f.b.id,tools:undefined});assert.equal(s.requests.length,1);assert.equal(readObligation(f.db,f.b.id,1)?.code,'OBLIGATION_REGISTRY_MISSING');
 updateConversation(f.db,f.a.id,{permissionMode:'full'});setToolMode(f.db,'memory_stage','disabled');s=scripted(()=>text());await f.run(s.provider);const seq=listMessages(f.db,f.a.id).filter(row=>row.role==='user').at(-1)!.seq;assert.equal(s.requests.length,1);assert.equal(readObligation(f.db,f.a.id,seq)?.code,'OBLIGATION_TOOLS_DISABLED');
 assert.equal(getMemoryView(f.db,'p').proposals.length,2,'unavailable capture tools cannot create bypass proposals');
});
test('closure: unbound conversations never get project obligations or maintenance generation',async t=>{
 const f=fixture(t);updateConversation(f.db,f.a.id,{projectId:null});const s=scripted(()=>text());await f.run(s.provider);assert.equal(s.requests.length,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_obligations').get()?.['n'],0);
});
