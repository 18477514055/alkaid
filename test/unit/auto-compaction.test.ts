import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { runTurn } from '../../src/core/agent/loop.ts';
import { autoCompactionDue, maybeAutoCompact, readCompactionStatus } from '../../src/core/agent/auto-compaction.ts';
import { buildConversationPrompt } from '../../src/core/agent/prompt/session.ts';
import { getCompactionDuties } from '../../src/core/memory/duties.ts';
import { listCompactions, listCompactionEvents } from '../../src/core/context/compact.ts';
import { setGeneralSettings, getGeneralSettings } from '../../src/core/settings/service.ts';
import { setMemoryPolicy } from '../../src/core/memory/rhythm.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { appendMessage, insertProvider, insertProject, insertConversation, listMessages } from '../../src/core/store/repo.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

function fixture(t:TestContext) {
 const db=new DatabaseSync(':memory:');migrate(db);
 const provider=insertProvider(db,{name:'offline',baseUrl:'http://127.0.0.1:1',contextWindow:20000});
 const project=insertProject(db,{id:'auto-project',name:'Auto',sharedDir:'D:/auto-test'});
 const conv=insertConversation(db,{providerId:provider.id,model:'chosen-existing',projectId:project.id,permissionMode:'full'});
 const tools=createDefaultRegistry(db);
 for(let i=0;i<40;i++)appendMessage(db,{conversationId:conv.id,role:i%2?'assistant':'user',content:`OLD_VERBATIM_${i}\n`+'x'.repeat(1200)});
 t.after(()=>db.close());
 return{db,provider,project,conv,tools};
}
const signal=()=>new AbortController().signal;
type Call=[string,Record<string,unknown>];
const ledger=(key='one'):Call=>['memory_propose',{recordId:`active-${key}`,kind:'active',title:'Verified work',content:'Completed actual inspection',operation:'upsert',baseRevision:0,reason:'verified evidence',idempotencyKey:`ledger-${key}`}];
const log=(key='one'):Call=>['memory_stage',{action:'intent',payload:{goal:'inspect',did:'completed inspection',issues:'',next:'test'},reason:'verified evidence',idempotencyKey:`log-${key}`}];
const triage=(key='one'):Call=>['memory_stage',{action:'triage',payload:{keep:[{what:'Inspection completed, tests next'}],stash:[],drop:[]},reason:'verified evidence',idempotencyKey:`triage-${key}`}];
async function* calls(items:Call[]):AsyncGenerator<ChatEvent>{for(const[index,[name,args]]of items.entries())yield{type:'tool_call',index,id:`call-${index}`,name,argsDelta:JSON.stringify(args)};yield{type:'finish',reason:'tool_calls'};}
async function* text(value='BUSINESS_FINAL'):AsyncGenerator<ChatEvent>{yield{type:'text',delta:value};yield{type:'finish',reason:'stop'};}
const compactRequest=(req:ChatRequest)=>String(req.messages[0]?.content).startsWith('你是上下文压缩器');
const closureRequest=(req:ChatRequest)=>req.messages.some(m=>m.content?.includes('MEMORY_TURN_CLOSURE'));
async function drain(f:ReturnType<typeof fixture>,provider:Provider){const events=[];for await(const event of runTurn({db:f.db,conversationId:f.conv.id,userText:'Complete the actual inspection',provider,tools:f.tools,signal:signal(),maxSteps:5}))events.push(event);return events;}

test('auto main loop: default 80%, real three receipts, compression between complete batches; system/tools remain byte-identical',async t=>{
 const f=fixture(t);assert.equal(getGeneralSettings(f.db).compactThresholdPercent,80);
 assert.ok(autoCompactionDue(f.db,f.conv.id,f.tools),'fixture really crosses default 80%');
 const originals=listMessages(f.db,f.conv.id);const requests:ChatRequest[]=[];let business=0,compactions=0;
 const provider:Provider={id:'offline',async *stream(req){requests.push(req);if(compactRequest(req)){compactions++;assert.equal(getCompactionDuties(f.db,f.conv.id).complete,true);assert.equal(listMessages(f.db,f.conv.id).filter(r=>r.role==='tool').length,3,'all replies persisted before inference');yield*text('Verified cumulative recap');return;}if(closureRequest(req))throw new Error('proactive triple must need no repair');if(business++===0)yield*calls([ledger(),log(),triage()]);else yield*text();}};
 const events=await drain(f,provider);assert.equal(compactions,1);assert.equal(business,2);
 const main=requests.filter(r=>!compactRequest(r));assert.equal(main[0]!.messages[0]!.content,main[1]!.messages[0]!.content);assert.equal(JSON.stringify(main[0]!.tools),JSON.stringify(main[1]!.tools));
 assert.doesNotMatch(main[0]!.messages[0]!.content!,/runtime_compaction|上下文水位|当前执行目标/);
 assert.match(JSON.stringify(main[1]!.messages),/runtime_compaction/);assert.doesNotMatch(JSON.stringify(main[1]!.messages),/OLD_VERBATIM_0/);
 assert.deepEqual(listMessages(f.db,f.conv.id).slice(0,originals.length),originals,'authoritative originals untouched');
 assert.equal(listMessages(f.db,f.conv.id).filter(r=>r.role==='user').length,21,'derived context is not persisted as a human');
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.type==='text'?e.delta:'').join(''),'BUSINESS_FINAL','recap and maintenance never leak into business deltas');
 assert.equal(listCompactions(f.db,f.conv.id).length,1);assert.equal(listCompactionEvents(f.db,f.conv.id).entries.filter(e=>e.phase==='success').length,1);
});

test('auto disabled and threshold changes take effect immediately without GET writes or model calls',async t=>{
 const f=fixture(t);setGeneralSettings(f.db,{autoCompactEnabled:false,compactThresholdPercent:50.25});
 let calls=0;const provider:Provider={id:'offline',async *stream(){calls++;yield*text();}};
 assert.equal(await maybeAutoCompact({db:f.db,conversationId:f.conv.id,tools:f.tools,provider,signal:signal()}),'none');
 assert.equal(calls,0);assert.equal(listCompactionEvents(f.db,f.conv.id).total,0);
 setGeneralSettings(f.db,{autoCompactEnabled:true,compactThresholdPercent:99});assert.equal(autoCompactionDue(f.db,f.conv.id,f.tools),false);
 setGeneralSettings(f.db,{compactThresholdPercent:50.25});assert.equal(autoCompactionDue(f.db,f.conv.id,f.tools),true);
 const before=f.db.prepare('SELECT total_changes() AS n').get()!['n'];const status=readCompactionStatus(f.db,f.conv.id,f.tools);
 assert.equal(status.settings.thresholdPercent,50.25);assert.ok(Array.isArray(status.events.entries));assert.equal(status.plan.status,'blocked');
 assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!['n'],before);assert.equal(calls,0);
});

test('auto failures charge only once per turn/anchor, stay out of business text, and preserve first system/tools',async t=>{
 const f=fixture(t);let business=0,compactions=0;const mains:ChatRequest[]=[];
 const provider:Provider={id:'offline',async *stream(req){if(compactRequest(req)){compactions++;yield{type:'error',message:'PRIVATE_UPSTREAM_BODY',retryable:true};return;}mains.push(req);if(business++===0)yield*calls([ledger(),log(),triage()]);else yield*text();}};
 const events=await drain(f,provider);assert.equal(compactions,1);assert.equal(listCompactions(f.db,f.conv.id).length,0);
 assert.equal(mains[0]!.messages[0]!.content,mains[1]!.messages[0]!.content);assert.equal(JSON.stringify(mains[0]!.tools),JSON.stringify(mains[1]!.tools));
 assert.doesNotMatch(JSON.stringify(events),/PRIVATE_UPSTREAM_BODY/);assert.equal(listCompactionEvents(f.db,f.conv.id).entries.filter(e=>e.phase==='failure').length,1);
});

test('first default-80% crossing repairs from complete recent evidence instead of deadlocking on old history budget',async t=>{
 const f=fixture(t);const original=listMessages(f.db,f.conv.id);let repairs=0,compactions=0;
 const business='新核验事实'.repeat(1000);
 const provider:Provider={id:'offline',async *stream(req){
  if(compactRequest(req)){compactions++;yield*text('Verified recap');return;}
  if(closureRequest(req)){repairs++;const raw=JSON.stringify(req.messages);assert.match(raw,/maintenance_evidence_scope/);assert.match(raw,/未读取这些原文/);assert.ok(raw.includes(business),'complete current turn is retained, not per-message clipped');assert.doesNotMatch(raw,/OLD_VERBATIM_0/);yield*calls([ledger(),log(),triage()]);return;}
  yield*text(business);
 }};
 await drain(f,provider);assert.equal(repairs,1);assert.equal(compactions,1);assert.equal(getCompactionDuties(f.db,f.conv.id).complete,true);
 assert.deepEqual(listMessages(f.db,f.conv.id).slice(0,original.length),original);assert.ok(listMessages(f.db,f.conv.id).some(row=>row.content===business));
});

test('auto repair explicitly requests three duties when configurable compression line crosses before 5% interval',async t=>{
 const f=fixture(t);setMemoryPolicy(f.db,f.project.id,{thresholdPercent:50});
 // A genuine migration-style seed is only the rhythm baseline, never three-duty evidence.
 f.db.prepare("INSERT INTO memory_rhythm_checkpoints(project_id,conversation_id,message_seq,user_seq,kind,created_at) VALUES(?,?,?,NULL,'seed',?)").run(f.project.id,f.conv.id,40,new Date().toISOString());
 // A larger window keeps the complete repair evidence within its 80% input budget.
 f.db.prepare('UPDATE providers SET context_window=40000 WHERE id=?').run(f.provider.id);setGeneralSettings(f.db,{compactThresholdPercent:35});
 let repairs=0,compactions=0;const provider:Provider={id:'offline',async *stream(req){if(compactRequest(req)){compactions++;yield*text('Verified recap');return;}if(closureRequest(req)){repairs++;assert.match(JSON.stringify(req.messages),/三层义务必须分别成功/);yield*calls([ledger(),log(),triage()]);return;}yield*text();}};
 await drain(f,provider);assert.equal(repairs,1);assert.equal(compactions,1);assert.equal(getCompactionDuties(f.db,f.conv.id).complete,true);
 const prompt=buildConversationPrompt(f.db,f.conv.id,f.tools);assert.doesNotMatch(prompt.text,/MEMORY_TURN_CLOSURE|runtime_compaction/);assert.ok(prompt.messages.some(m=>m.content?.includes('runtime_compaction')));
});
