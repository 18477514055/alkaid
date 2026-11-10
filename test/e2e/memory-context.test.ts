import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { loadConfig } from '../../src/config.ts';
import { projectMemoryBlock } from '../../src/core/agent/prompt/memory.ts';
import { queryCapsules, recordReadReceipt, recordTurnProgress, saveCapsule } from '../../src/core/memory/context.ts';
import { MemoryMaintainer } from '../../src/core/memory/maintainer.ts';
import { applyProposalManually, getMemoryView, submitProposal } from '../../src/core/memory/store.ts';
import { getLatestHandoff, queryIntents } from '../../src/core/memory/workbench.ts';
import { appendMessage, insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import { registerConversationRoutes } from '../../src/server/routes/conversations.ts';
import { registerMemoryContextRoutes } from '../../src/server/routes/memory-context.ts';
import type { ServerDeps } from '../../src/server/app.ts';
import type { MemoryCheckpoint, MemoryContextState } from '../../src/shared/memory-context.ts';
import type { ChatRequest } from '../../src/shared/types.ts';
import { addCompactionDuties } from '../helpers/compaction-fixture.ts';

function fixture(t:TestContext) {
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');migrate(db);
 const home=mkdtempSync(join(tmpdir(),'alkaid-context-http-'));const config=loadConfig({ALKAID_HOME:home});
 const provider=insertProvider(db,{name:'offline',baseUrl:'http://127.0.0.1:1'});
 const project=insertProject(db,{id:'checkpoint-project',name:'checkpoint',sharedDir:'C:/checkpoint'});
 const conv=insertConversation(db,{providerId:provider.id,model:'chosen-existing-model',projectId:project.id});
 const memory=new MemoryMaintainer({db,config});const tools=createDefaultRegistry(db);
 const app=Fastify({logger:false});const deps:ServerDeps={db,config,memory,tools};const requests:ChatRequest[]=[];
 registerConversationRoutes(app,deps);
 let providerCreates=0;
 registerMemoryContextRoutes(app,deps,{createProvider:()=>{providerCreates++;return {id:provider.id,async *stream(req){
  assert.ok(queryCapsules(db,conv.id).length>0,'immutable capsule must exist before compression inference');
  requests.push(req);yield{type:'text',delta:'offline compact summary'};yield{type:'finish',reason:'stop'};
 }};}});
 app.setErrorHandler((error:{statusCode?:number;message:string},_req,reply)=>reply.code(error.statusCode??500).send({error:error.message}));
 t.after(async()=>{await app.close();await memory.close();db.close();rmSync(home,{recursive:true,force:true});});
 const url=`/api/conversations/${conv.id}`;
 const open=async()=>{const r=await app.inject({method:'POST',url:`${url}/checkpoint`,payload:{}});assert.equal(r.statusCode,200,r.body);return r.json().checkpoint as MemoryCheckpoint;};
 const resolve=async(payload:Record<string,unknown>)=>await app.inject({method:'POST',url:`${url}/checkpoint/resolve`,payload});
 return {db,app,conv,project,provider,requests,url,open,resolve,providerCreates:()=>providerCreates};
}
const intent={goal:'user-confirmed goal',did:'verified actual work',issues:'',next:'next verified action'};
const handoff={title:'handoff reviewed by user',did:'done',state:'working/unfinished',next:'run next test',files:['D:/absolute/source.ts'],blocked:''};

test('10.3 choice skip: real HTTP records skip action, creates no memory, compaction or handoff and exempts debt',async t=>{
 const f=fixture(t);appendMessage(f.db,{conversationId:f.conv.id,role:'user',content:'work'});recordTurnProgress(f.db,f.conv.id,1,'progress_not_recorded');
 const checkpoint=await f.open();
 // One real TCP request verifies the registered endpoint, not merely the existence of a route function.
 const address=await f.app.listen({port:0,host:'127.0.0.1'});
 const response=await fetch(`${address}${f.url}/checkpoint/resolve`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({checkpointId:checkpoint.id,choice:'skip'})});
 assert.equal(response.status,200);const body=await response.json() as {checkpoint:MemoryCheckpoint};assert.equal(body.checkpoint.status,'resolved');
 assert.equal(getMemoryView(f.db,f.project.id).records.length,0);assert.equal(getMemoryView(f.db,f.project.id).proposals.length,0);
 assert.equal(f.requests.length,0);assert.equal(getLatestHandoff(f.db,f.project.id),null);
 const state=(await f.app.inject(`${f.url}/memory-state`)).json() as MemoryContextState;assert.equal(state.debt!.outstanding,false);assert.equal(state.debt!.code,'checkpoint_skip');
});
test('10.3 choice record: explicit proposal THEN independent human accept, never direct formal write or model call',async t=>{
 const f=fixture(t);const checkpoint=await f.open();
 const first=await f.resolve({checkpointId:checkpoint.id,choice:'record',intent});assert.equal(first.statusCode,200,first.body);
 const staged=first.json().checkpoint as MemoryCheckpoint;assert.equal(staged.status,'recorded');assert.ok(staged.proposalId);
 assert.equal(queryIntents(f.db,f.project.id).length,0);assert.equal(getMemoryView(f.db,f.project.id).records.length,0);
 const approved=await f.resolve({checkpointId:checkpoint.id,choice:'record',accept:true});assert.equal(approved.statusCode,200,approved.body);
 assert.equal(approved.json().checkpoint.status,'resolved');assert.equal(queryIntents(f.db,f.project.id)[0]!.did,intent.did);
 assert.equal(f.requests.length,0);assert.equal(getLatestHandoff(f.db,f.project.id),null);
 assert.doesNotMatch(projectMemoryBlock(f.db,f.conv.id)!,/user-confirmed goal|verified actual work/,'intent is history, not injected current state');
});
test('10.3 choice record_compact: only explicit stage-two accept invokes existing model; immutable capsule precedes request',async t=>{
 const f=fixture(t);for(let i=0;i<9;i++)appendMessage(f.db,{conversationId:f.conv.id,role:i%2===0?'user':'assistant',content:`original ${i}\nexact`});
 const checkpoint=await f.open();const first=await f.resolve({checkpointId:checkpoint.id,choice:'record_compact',intent});
 assert.equal(first.statusCode,200,first.body);assert.equal(f.requests.length,0);
 const staged=first.json().checkpoint as MemoryCheckpoint;
 const blocked=await f.resolve({checkpointId:checkpoint.id,choice:'record_compact',accept:true,keepRecent:2});
 assert.equal(blocked.statusCode,409,blocked.body);assert.equal(blocked.json().compacted,false);assert.equal(blocked.json().code,'duties_incomplete');
 assert.deepEqual(blocked.json().missing,['ledger','log','triage'],'a standalone checkpoint intent is not a three-layer receipt');
 assert.equal(getMemoryView(f.db,f.project.id).proposals.find(p=>p.id===staged.proposalId)!.status,'pending','preflight must run BEFORE independent acceptance');
 assert.equal(getMemoryView(f.db,f.project.id).records.length,0);assert.equal(queryIntents(f.db,f.project.id).length,0);
 assert.equal(f.requests.length,0);assert.equal(f.providerCreates(),0,'preflight must not prepare a paid model');
 f.db.prepare('UPDATE providers SET context_window=4000 WHERE id=?').run(f.provider.id);
 const duties=await addCompactionDuties(f.db,f.conv.id);
 assert.ok(duties.receipts.ledger.proposalId);assert.ok(duties.receipts.log.proposalId);assert.ok(duties.receipts.triage.proposalId);
 const second=await f.resolve({checkpointId:checkpoint.id,choice:'record_compact',accept:true,keepRecent:2+duties.addedMessages});assert.equal(second.statusCode,200,second.body);
 assert.equal(second.json().compacted,true);assert.equal(second.json().checkpoint.status,'resolved');assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.model,'chosen-existing-model');
 assert.equal(second.json().compaction.fromSeq,1);assert.equal(second.json().compaction.toSeq,7,'only the original prefix is selected; fresh receipts remain verbatim');
 assert.equal(getMemoryView(f.db,f.project.id).proposals.find(p=>p.id===staged.proposalId)!.status,'applied');
 assert.equal(queryCapsules(f.db,f.conv.id,{fromSeq:1,toSeq:7})[0]!.users[0]!.text,'original 0\nexact');
 const again=await f.resolve({checkpointId:checkpoint.id,choice:'record_compact',accept:true});assert.equal(again.statusCode,200);assert.equal(f.requests.length,1,'retrying resolved request cannot double-charge');
});
test('10.3 choice record_handoff: reviewed handoff proposal becomes five-section immutable DB handoff, never compacted',async t=>{
 const f=fixture(t);const checkpoint=await f.open();
 const first=await f.resolve({checkpointId:checkpoint.id,choice:'record_handoff',handoff});assert.equal(first.statusCode,200,first.body);
 assert.equal(getLatestHandoff(f.db,f.project.id),null);assert.equal(f.requests.length,0);
 const second=await f.resolve({checkpointId:checkpoint.id,choice:'record_handoff',accept:true});assert.equal(second.statusCode,200,second.body);
 const saved=getLatestHandoff(f.db,f.project.id)!;assert.equal(saved.did,handoff.did);assert.equal(saved.state,handoff.state);assert.equal(saved.next,handoff.next);assert.deepEqual(saved.files,handoff.files);assert.equal(saved.blocked,'');
 assert.equal(second.json().checkpoint.handoffId,saved.id);assert.equal(f.requests.length,0);
 assert.match(projectMemoryBlock(f.db,f.conv.id)!,new RegExp(saved.id));assert.doesNotMatch(projectMemoryBlock(f.db,f.conv.id)!,/working\/unfinished/,'handoff pointer only');
});
test('checkpoint endpoints reject unauthorized principle fields, out-of-order accept, content replacement, and cross-conversation pointers',async t=>{
 const f=fixture(t);const checkpoint=await f.open();
 const bypass=await f.resolve({checkpointId:checkpoint.id,choice:'record',accept:true});assert.equal(bypass.statusCode,409);
 const forged=await f.resolve({checkpointId:checkpoint.id,choice:'record',intent,kind:'principle',content:'forged official rule'});assert.equal(forged.statusCode,400);
 assert.equal((await f.resolve({checkpointId:checkpoint.id,choice:'record',intent})).statusCode,200);
 const replacement=await f.resolve({checkpointId:checkpoint.id,choice:'record',accept:true,intent:{...intent,did:'unreviewed'}});assert.equal(replacement.statusCode,400);
 const other=insertConversation(f.db,{providerId:f.provider.id,model:'offline',projectId:f.project.id});
 const foreign=await f.app.inject({method:'POST',url:`/api/conversations/${other.id}/checkpoint/resolve`,payload:{checkpointId:checkpoint.id,choice:'record',accept:true}});assert.equal(foreign.statusCode,404);
 assert.equal(getMemoryView(f.db,f.project.id).records.filter(r=>r.kind==='principle').length,0);assert.equal(f.requests.length,0);
});
test('capsule/material-map APIs preserve exact quotes, enforce project scope and do not mark UI reads as model receipts',async t=>{
 const f=fixture(t);const raw='original 用户原话\n  unchanged';appendMessage(f.db,{conversationId:f.conv.id,role:'user',content:raw});
 const capsule=saveCapsule(f.db,f.conv.id,1,1);
 const p=submitProposal(f.db,{conversationId:f.conv.id,recordId:'current',kind:'active',title:'Current',content:'current exact body',baseRevision:0,operation:'upsert',reason:'test',idempotencyKey:'http-receipt'});applyProposalManually(f.db,f.project.id,p.id);
 const base=`/api/projects/${f.project.id}/memory`;
 const quotes=await f.app.inject(`${base}/capsules?conversationId=${f.conv.id}&fromSeq=1&toSeq=1&capsuleId=${capsule.id}`);assert.equal(quotes.statusCode,200);assert.equal(quotes.json().capsules[0].users[0].text,raw);
 assert.equal((await f.app.inject(`/api/projects/another-project/memory/capsules?conversationId=${f.conv.id}`)).statusCode,404);
 const map=await f.app.inject(`${base}/material-map?conversationId=${f.conv.id}`);assert.equal(map.statusCode,200);assert.equal(map.json().materials[0].read,false);
 assert.equal((await f.app.inject(`${base}/material-map?conversationId=${f.conv.id}`)).json().materials[0].read,false);
 recordReadReceipt(f.db,f.conv.id,'current',1);
 assert.equal((await f.app.inject(`${base}/material-map?conversationId=${f.conv.id}`)).json().materials[0].read,true);
});
test('memory-state and prompt viewer expose same waterline signal; GET does not invoke a model',async t=>{
 const f=fixture(t);const stable=await f.app.inject(`${f.url}/prompt`);assert.equal(stable.statusCode,200);
 f.db.prepare('UPDATE providers SET context_window=100 WHERE id=?').run(f.provider.id);
 const state=await f.app.inject(`${f.url}/memory-state`);assert.equal(state.statusCode,200);assert.equal(state.json().warning.level,'urgent');
 const prompt=await f.app.inject(`${f.url}/prompt`);assert.equal(prompt.statusCode,200);
 assert.equal(prompt.json().text,stable.json().text,'changing waterline must not rewrite the first system cache prefix');
 assert.doesNotMatch(prompt.json().text,/上下文水位≥95%/);assert.match(JSON.stringify(prompt.json().contextMessages),/上下文水位≥95%/);
 const dashboard=await f.app.inject(`${f.url}/dashboard`);assert.equal(dashboard.statusCode,200);
 assert.equal(dashboard.json().contextTokens,state.json().contextTokens,'bottom bar and right board share the same prompt/tool/history estimate');
 assert.equal(dashboard.json().contextRatio,state.json().contextRatio);
 assert.equal(f.requests.length,0);
});
