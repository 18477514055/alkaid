import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrate } from '../../src/core/store/schema.ts';
import { appendMessage,getConversation,insertProject,insertProvider,insertConversation,listMessages,updateConversation } from '../../src/core/store/repo.ts';
import { getMemoryRhythm,getMemoryPolicy,setMemoryPolicy } from '../../src/core/memory/rhythm.ts';
import { insertCompaction } from '../../src/core/context/compact.ts';
import { runTurn } from '../../src/core/agent/loop.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import { createSurface } from '../../src/core/tools/runtime.ts';
import { buildConversationPrompt } from '../../src/core/agent/prompt/session.ts';
import { applyProposalManually,getMemoryView,rejectProposal,submitProposal } from '../../src/core/memory/store.ts';
import { readObligation } from '../../src/core/memory/obligations.ts';
import type { ChatEvent,ChatRequest } from '../../src/shared/types.ts';
import type { Provider } from '../../src/core/model/provider.ts';

/**
 * 子代理**禁止**使用的项目记忆工具（写语义）。
 * ★ 2026-11-11 审计 `CRITICAL-01` 之后，判据从"整族 memory_* + execution_board 全禁"
 *   改成"只禁写"：读工具（`memory_read` / `memory_records` / `memory_material_map`）与
 *   `execution_board`（只写自己那一行）按用户裁定对子代理放行。
 */
const SUBAGENT_WRITE_TOOLS: readonly string[] = [
  'memory_propose', 'memory_stage', 'memory_disposition',
];
function fixture(t:TestContext,window=1_000_000) {
 const db=new DatabaseSync(':memory:');migrate(db);t.after(()=>db.close());
 insertProject(db,{id:'p',name:'P',sharedDir:'C:/owned/p'});
 const p=insertProvider(db,{name:'fake',baseUrl:'http://127.0.0.1:1',contextWindow:window});
 const a=insertConversation(db,{providerId:p.id,model:'fake',projectId:'p',permissionMode:'readonly'});
 const tools=createDefaultRegistry(db);const requests:ChatRequest[]=[];
 async function run(text:string,script:(request:ChatRequest,index:number)=>AsyncGenerator<ChatEvent>=async function*(){yield {type:'text',delta:'业务回复'};yield {type:'finish',reason:'stop'};},id=a.id,agentRole?:'subagent') {
  const provider:Provider={id:'offline',stream(request){const i=requests.length;requests.push(request);return script(request,i);}};
  const events=[];for await(const event of runTurn({db,conversationId:id,userText:text,tools,provider,signal:new AbortController().signal,...(agentRole?{agentRole}:{})}))events.push(event);return events;
 }
 return{db,a,p,tools,run,requests};
}
async function* dual(key:string):AsyncGenerator<ChatEvent> {
 const values=[['memory_propose',{recordId:`active-${key}`,kind:'active',title:'真实进展',operation:'upsert',content:'已核实事实',baseRevision:0,reason:'原会话工具证据',idempotencyKey:`p-${key}`}],['memory_stage',{action:'triage',payload:{keep:[{what:'保留已核实事实'}],stash:[],drop:[]},reason:'取舍依据',idempotencyKey:`t-${key}`}]] as const;
 for(const [index,[name,args]] of values.entries())yield {type:'tool_call',index,id:`${key}-${index}`,name,argsDelta:JSON.stringify(args)};
 yield {type:'finish',reason:'tool_calls'};
}
const close=(r:ChatRequest)=>r.messages.some(message=>String(message.content).includes('MEMORY_TURN_CLOSURE'));
test('rhythm: default 5%, repeated short exchanges make no obligations, no extra requests and GET/prompt stays pure',async t=>{
 const f=fixture(t);assert.deepEqual(getMemoryPolicy(f.db,'p'),{thresholdPercent:5});
 for(let i=0;i<3;i++)await f.run('短交流');
 assert.equal(f.requests.length,3);assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_obligations').get()?.['n'],0);
 const before=f.db.prepare('SELECT total_changes() AS n').get()?.['n'];
 for(let i=0;i<3;i++){getMemoryRhythm(f.db,f.a.id);buildConversationPrompt(f.db,f.a.id,f.tools);}
 assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.['n'],before);
 assert.ok(f.requests[0]!.messages.some(message=>message.role==='user'&&/不是项目长期目标树/.test(message.content??'')));assert.ok(f.requests[0]!.messages.some(message=>message.role==='user'&&/短交流本轮无需强制/.test(message.content??'')));
 assert.doesNotMatch(f.requests[0]!.messages[0]!.content!,/台账整理间隔|短交流本轮无需强制|MEMORY_TURN_CLOSURE/);assert.ok(f.requests.every(request=>request.messages[0]?.content===f.requests[0]?.messages[0]?.content),'short turns preserve exact first-system bytes');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_rhythm_checkpoints').get()?.['n'],0);
});
test('rhythm: STRICT greater-than boundary counts original tokens once, ignores billing/maintenance, and compression cannot erase growth',t=>{
 const f=fixture(t,1000);appendMessage(f.db,{conversationId:f.a.id,role:'user',content:'x'.repeat(184),usage:{input:100000,output:100000}});
 assert.equal(getMemoryRhythm(f.db,f.a.id).addedTokens,50);assert.equal(getMemoryRhythm(f.db,f.a.id).due,false);
 appendMessage(f.db,{conversationId:f.a.id,role:'assistant',displayChannel:'maintenance',content:'y'.repeat(5000)});
 assert.equal(getMemoryRhythm(f.db,f.a.id).addedTokens,50);
 appendMessage(f.db,{conversationId:f.a.id,role:'assistant',content:'x'});assert.equal(getMemoryRhythm(f.db,f.a.id).due,true);
 const before=getMemoryRhythm(f.db,f.a.id).addedTokens;
 insertCompaction(f.db,{conversationId:f.a.id,fromSeq:1,toSeq:3,summary:'short'});
 assert.equal(getMemoryRhythm(f.db,f.a.id).addedTokens,before);
});
test('rhythm: 0% explicitly enables legacy every-turn capture; success resets only from real dual evidence and rejection invalidates checkpoint',async t=>{
 const f=fixture(t);setMemoryPolicy(f.db,'p',{thresholdPercent:0});
 await f.run('完成真实调查',async function*(r){if(close(r))yield*dual('first');else {yield{type:'text',delta:'业务已答复'};yield{type:'finish',reason:'stop'};}});
 assert.equal(f.requests.filter(close).length,1);assert.equal(readObligation(f.db,f.a.id,1)?.status,'staged');
 const closure=f.requests.find(close)!;assert.equal(closure.messages[0]?.content,f.requests[0]?.messages[0]?.content);assert.doesNotMatch(String(closure.messages[0]?.content),/MEMORY_TURN_CLOSURE/);assert.ok(closure.messages.some(message=>message.role==='user'&&String(message.content).includes('MEMORY_TURN_CLOSURE')));
 setMemoryPolicy(f.db,'p',{thresholdPercent:5});const rhythm=getMemoryRhythm(f.db,f.a.id);assert.ok(rhythm.baselineSeq>0);assert.equal(rhythm.addedTokens,0);
 const progress=readObligation(f.db,f.a.id,1)!.progress!.proposalId;rejectProposal(f.db,'p',progress);
 assert.equal(getMemoryRhythm(f.db,f.a.id).baselineSeq,0);assert.ok(getMemoryRhythm(f.db,f.a.id).addedTokens>0);
});
test('rhythm: crossing interval within a turn repairs once and receives previous short-turn material, next short turn remains free',async t=>{
 const f=fixture(t);await f.run('EARLY_VERIFIED_CONTEXT');setMemoryPolicy(f.db,'p',{thresholdPercent:0.01});
 await f.run('继续调查',async function*(r){if(close(r)){assert.ok(r.messages.some(m=>m.content?.includes('EARLY_VERIFIED_CONTEXT')));yield*dual('cross');}else{yield{type:'text',delta:'中'.repeat(150)};yield{type:'finish',reason:'stop'};}});
 assert.equal(f.requests.filter(close).length,1);const n=f.requests.length;await f.run('收到');assert.equal(f.requests.length,n+1);assert.equal(f.requests.filter(close).length,1);
});
test('rhythm: voluntary partial progress below interval never forces triage or resets growth',async t=>{
 const f=fixture(t);await f.run('自愿保存一个事实',async function*(_r,n){if(n===0){yield{type:'tool_call',index:0,id:'p',name:'memory_propose',argsDelta:JSON.stringify({recordId:'one',kind:'active',title:'事实',operation:'upsert',content:'真实进展',baseRevision:0,reason:'本轮调查',idempotencyKey:'one'})};yield{type:'finish',reason:'tool_calls'};}else{yield{type:'text',delta:'业务结果'};yield{type:'finish',reason:'stop'};}});
 assert.equal(f.requests.length,2);assert.equal(f.requests.filter(close).length,0);assert.equal(getMemoryView(f.db,'p').proposals.length,1);
 assert.equal(readObligation(f.db,f.a.id,1)?.code,'OBLIGATION_INTERVAL_NOT_DUE');assert.equal(getMemoryRhythm(f.db,f.a.id).baselineSeq,0);assert.ok(getMemoryRhythm(f.db,f.a.id).addedTokens>0);
});
test('rhythm: runtime and persisted subagents have no project injection, tool definitions, checkpoints, obligations or memory writes',async t=>{
 const f=fixture(t);setMemoryPolicy(f.db,'p',{thresholdPercent:0});
 const child=insertConversation(f.db,{providerId:f.p.id,model:'fake',projectId:'p',agentRole:'subagent'});
 await f.run('委派任务',undefined,child.id);await f.run('委派任务',undefined,f.a.id,'subagent');
 assert.equal(f.requests.length,2);
 for(const r of f.requests){assert.doesNotMatch(r.messages[0]!.content!,/项目记忆（当前正式版本）|台账整理间隔|项目收尾义务/);assert.ok(r.tools?.every(tool=>!SUBAGENT_WRITE_TOOLS.includes(tool.name)));}
 for(const table of ['memory_obligations','memory_rhythm_checkpoints','memory_waterlines','memory_file_touches'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n'],0);
 const surface=createSurface(f.tools,'readonly',new Map(),'subagent');
 // ★ 看板对子代理**可见**（它只能写自己那一行）；写台账的工具仍然不可见
 assert.equal(surface.canCall('execution_board'),true);
 assert.equal(surface.canCall('memory_propose'),false);
 assert.equal(surface.canCall('memory_stage'),false);
 const ctx={conversationId:child.id,permissionMode:'readonly' as const,roots:{readable:[],writable:[],anywhere:false},workspacePath:null,projectSharedDir:null,cwd:'.',tempDir:'.',signal:new AbortController().signal};
 assert.equal((await f.tools.execute('memory_stage',{action:'principle_propose',payload:{}},ctx)).ok,false);
 assert.equal(buildConversationPrompt(f.db,child.id,f.tools).state.rhythm,undefined);
 assert.equal(listMessages(f.db,child.id).length,2);
});
test('rhythm: rebind starts a new project interval without importing old source, checkpoint history resists replacement',t=>{
 const f=fixture(t);appendMessage(f.db,{conversationId:f.a.id,role:'user',content:'OLD_PROJECT_MATERIAL'});
 insertProject(f.db,{id:'new-project',name:'New',sharedDir:'C:/owned/new'});
 updateConversation(f.db,f.a.id,{projectId:'new-project'});const state=getMemoryRhythm(f.db,f.a.id);
 assert.equal(state.baselineSeq,1);assert.equal(state.addedTokens,0);
 const row=f.db.prepare('SELECT * FROM memory_rhythm_checkpoints').get()!;
 assert.throws(()=>f.db.prepare('UPDATE memory_rhythm_checkpoints SET message_seq=0 WHERE id=?').run(Number(row['id'])));
 assert.throws(()=>f.db.prepare('DELETE FROM memory_rhythm_checkpoints WHERE id=?').run(Number(row['id'])));
 assert.throws(()=>f.db.prepare("INSERT OR REPLACE INTO memory_rhythm_checkpoints(id,project_id,conversation_id,message_seq,user_seq,kind,created_at) VALUES (?,?,?,0,NULL,'seed','now')").run(Number(row['id']),'new-project',f.a.id));
 assert.equal(getMemoryRhythm(f.db,f.a.id).baselineSeq,1);
});
test('rhythm: policy accepts decimal/zero, rejects NaN/out-of-range/extra fields, remains project-scoped and never charges a model',t=>{
 const f=fixture(t);setMemoryPolicy(f.db,'p',{thresholdPercent:2.5});assert.equal(getMemoryPolicy(f.db,'p').thresholdPercent,2.5);
 for(const value of [{thresholdPercent:NaN},{thresholdPercent:-1},{thresholdPercent:51},{thresholdPercent:5,extra:1},{thresholdPercent:'5'}])assert.throws(()=>setMemoryPolicy(f.db,'p',value));
 assert.equal(getMemoryPolicy(f.db,'p').thresholdPercent,2.5);assert.throws(()=>setMemoryPolicy(f.db,'foreign',{thresholdPercent:5}));assert.equal(f.requests.length,0);
});

test('rhythm: runtime child on a main ID cannot inherit old maintenance replies or compaction summaries; persisted child source cannot submit',async t=>{
 const f=fixture(t);setMemoryPolicy(f.db,'p',{thresholdPercent:0});
 const maintenanceSentinel='OLD_MAIN_MAINTENANCE_ONLY_SENTINEL';
 const summarySentinel='OLD_MAIN_COMPACTION_ONLY_SENTINEL';
 const original=submitProposal(f.db,{conversationId:f.a.id,recordId:'main-private',kind:'active',title:'Main project knowledge',operation:'upsert',content:maintenanceSentinel,baseRevision:0,reason:'trusted test evidence',idempotencyKey:'main-private'});
 applyProposalManually(f.db,'p',original.id);
 appendMessage(f.db,{conversationId:f.a.id,role:'user',content:'Old main business input'});
 appendMessage(f.db,{conversationId:f.a.id,role:'assistant',content:'Old main business answer'});
 insertCompaction(f.db,{conversationId:f.a.id,fromSeq:1,toSeq:2,summary:summarySentinel});
 appendMessage(f.db,{conversationId:f.a.id,role:'assistant',displayChannel:'maintenance',toolCalls:[{id:'old-memory-read',name:'memory_read',arguments:'{}',displayChannel:'maintenance'}]});
 const ctx={conversationId:f.a.id,permissionMode:'readonly' as const,roots:{readable:[],writable:[],anywhere:false},workspacePath:null,projectSharedDir:null,cwd:'.',tempDir:'.',signal:new AbortController().signal};
 const read=await f.tools.execute('memory_read',{},ctx);assert.equal(read.ok,true);assert.ok(read.ok&&read.content.includes(maintenanceSentinel));
 appendMessage(f.db,{conversationId:f.a.id,role:'tool',displayChannel:'maintenance',toolCallId:'old-memory-read',content:JSON.stringify(read)});
 const delegatedTask='  CURRENT_DELEGATED_TASK\n只处理这份委派的真实输入  ';
 await f.run(delegatedTask,undefined,f.a.id,'subagent');
 assert.equal(f.requests.length,1);const request=f.requests[0]!;
 assert.doesNotMatch(JSON.stringify(request),/OLD_MAIN_MAINTENANCE_ONLY_SENTINEL|OLD_MAIN_COMPACTION_ONLY_SENTINEL|old-memory-read/);
 assert.deepEqual(request.messages.filter(message=>message.role==='user').map(message=>message.content),[delegatedTask]);
 assert.equal(request.messages.length,2,'only the system and current delegated user input, not main history');
 assert.equal(request.messages.flatMap(message=>message.toolCalls??[]).length,0);
 assert.ok(request.tools?.every(tool=>!SUBAGENT_WRITE_TOOLS.includes(tool.name)));
 assert.ok(listMessages(f.db,f.a.id).some(message=>message.role==='tool'&&message.content?.includes(maintenanceSentinel)),'source history must remain intact');
 assert.equal(f.db.prepare('SELECT summary FROM compactions WHERE conversation_id=?').get(f.a.id)?.['summary'],summarySentinel);
 const child=insertConversation(f.db,{providerId:f.p.id,model:'fake',projectId:'p',agentRole:'subagent'});
 assert.throws(()=>submitProposal(f.db,{conversationId:child.id,recordId:'child-write',kind:'active',title:'Denied child write',operation:'upsert',content:'must never stage',baseRevision:0,reason:'direct source guard test',idempotencyKey:'child-denied'}),/Subagents/);
 assert.equal(getMemoryView(f.db,'p').proposals.length,1);assert.equal(getMemoryView(f.db,'p').records.length,1);
 for(const table of ['memory_obligations','memory_rhythm_checkpoints','memory_waterlines','memory_file_touches'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n'],0);
});

test('rhythm: failed rebind seed insertion rolls back the project and preserves old incremental accounting',t=>{
 const f=fixture(t);appendMessage(f.db,{conversationId:f.a.id,role:'user',content:'OLD_PROJECT_GROWTH_MUST_REMAIN'});
 insertProject(f.db,{id:'new-project',name:'New',sharedDir:'C:/owned/new'});
 const before=getMemoryRhythm(f.db,f.a.id);assert.ok(before.addedTokens>0);
 const original=getConversation(f.db,f.a.id)!;
 f.db.exec("CREATE TRIGGER fail_rebind_seed BEFORE INSERT ON memory_rhythm_checkpoints WHEN NEW.kind='seed' BEGIN SELECT RAISE(ABORT,'simulated seed storage failure'); END;");
 assert.throws(()=>updateConversation(f.db,f.a.id,{projectId:'new-project',title:'must roll back'}),/simulated seed storage failure/);
 assert.equal(f.db.isTransaction,false);assert.equal(getConversation(f.db,f.a.id)?.projectId,'p');assert.equal(getConversation(f.db,f.a.id)?.title,original.title);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_rhythm_checkpoints').get()?.['n'],0);
 assert.deepEqual(getMemoryRhythm(f.db,f.a.id),before,'failed rebind must neither reset nor move old accounting');
});

test('rhythm: nested rebind failure rolls back only its savepoint, and successful nested rebind respects outer rollback',t=>{
 const f=fixture(t);appendMessage(f.db,{conversationId:f.a.id,role:'user',content:'OLD_PROJECT_GROWTH_IN_NESTED_TRANSACTION'});
 insertProject(f.db,{id:'new-project',name:'New',sharedDir:'C:/owned/new'});
 const before=getMemoryRhythm(f.db,f.a.id);
 f.db.exec("CREATE TRIGGER fail_nested_seed BEFORE INSERT ON memory_rhythm_checkpoints WHEN NEW.kind='seed' BEGIN SELECT RAISE(ABORT,'simulated nested seed failure'); END;");
 f.db.exec('BEGIN IMMEDIATE');
 try {
  updateConversation(f.db,f.a.id,{title:'outer edit must survive'});
  assert.throws(()=>updateConversation(f.db,f.a.id,{projectId:'new-project',title:'inner edit must roll back'}),/simulated nested seed failure/);
  assert.equal(f.db.isTransaction,true,'rebind must not roll back its caller transaction');
  assert.equal(getConversation(f.db,f.a.id)?.projectId,'p');assert.equal(getConversation(f.db,f.a.id)?.title,'outer edit must survive');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_rhythm_checkpoints').get()?.['n'],0);assert.deepEqual(getMemoryRhythm(f.db,f.a.id),before);
  f.db.exec('COMMIT');
 } finally {if(f.db.isTransaction)f.db.exec('ROLLBACK');}
 assert.equal(getConversation(f.db,f.a.id)?.title,'outer edit must survive');
 f.db.exec('DROP TRIGGER fail_nested_seed');f.db.exec('BEGIN IMMEDIATE');
 try {
  updateConversation(f.db,f.a.id,{projectId:'new-project'});assert.equal(f.db.isTransaction,true);
  assert.equal(getConversation(f.db,f.a.id)?.projectId,'new-project');assert.equal(getMemoryRhythm(f.db,f.a.id).addedTokens,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_rhythm_checkpoints').get()?.['n'],1);
 } finally {f.db.exec('ROLLBACK');}
 assert.equal(getConversation(f.db,f.a.id)?.projectId,'p');assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_rhythm_checkpoints').get()?.['n'],0);assert.deepEqual(getMemoryRhythm(f.db,f.a.id),before);
});
