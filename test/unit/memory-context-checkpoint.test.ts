import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { loadConfig } from '../../src/config.ts';
import { MemoryMaintainer } from '../../src/core/memory/maintainer.ts';
import { applyProposalManually, getMemoryView, submitProposal } from '../../src/core/memory/store.ts';
import { getLatestHandoff, makeArtifactInput } from '../../src/core/memory/workbench.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import { registerMemoryContextRoutes } from '../../src/server/routes/memory-context.ts';

function fixture(t:TestContext){
 const db=new DatabaseSync(':memory:');migrate(db);
 const home=mkdtempSync(join(tmpdir(),'alkaid-checkpoint-regression-'));const config=loadConfig({ALKAID_HOME:home});
 const provider=insertProvider(db,{name:'offline',baseUrl:'http://127.0.0.1:1'});
 const project=insertProject(db,{id:'checkpoint-regression',name:'regression',sharedDir:'D:/test'});
 const conv=insertConversation(db,{providerId:provider.id,model:'offline',projectId:project.id});
 const app=Fastify({logger:false});const memory=new MemoryMaintainer({db,config});let providerCreates=0;
 registerMemoryContextRoutes(app,{db,config,memory,tools:createDefaultRegistry(db)},{createProvider:()=>{providerCreates++;return{id:'offline',async *stream(){yield{type:'text',delta:'summary'};}};}});
 app.setErrorHandler((err:{statusCode?:number;message:string},_req,reply)=>reply.code(err.statusCode??500).send({error:err.message}));
 t.after(async()=>{await app.close();await memory.close();db.close();rmSync(home,{recursive:true,force:true});});
 const url=`/api/conversations/${conv.id}/checkpoint`;
 const open=async()=>{const r=await app.inject({method:'POST',url,payload:{}});assert.equal(r.statusCode,200,r.body);return r.json().checkpoint as {id:string;proposalId:string|null};};
 const resolve=async(payload:Record<string,unknown>)=>await app.inject({method:'POST',url:`${url}/resolve`,payload});
 return{db,app,project,conv,open,resolve,providerCreates:()=>providerCreates};
}
const handoff={title:'checkpoint handoff',did:'done A',state:'state A',next:'next A',files:['D:/test/source.ts'],blocked:''};
test('checkpoint handoff resolves its own proposal, not a later handoff published by another concurrent approval',async t=>{
 const f=fixture(t);const checkpoint=await f.open();
 const first=await f.resolve({checkpointId:checkpoint.id,choice:'record_handoff',handoff});assert.equal(first.statusCode,200,first.body);
 const proposalId=first.json().checkpoint.proposalId as string;
 applyProposalManually(f.db,f.project.id,proposalId);
 const original=getLatestHandoff(f.db,f.project.id)!;
 const next=makeArtifactInput('handoff',{...handoff,title:'another concurrent handoff',did:'done B'});
 const p=submitProposal(f.db,{conversationId:f.conv.id,recordId:next.recordId,kind:'note',title:next.title,content:next.content,operation:'upsert',baseRevision:0,reason:'another explicit approval',idempotencyKey:'other-handoff'});
 applyProposalManually(f.db,f.project.id,p.id);
 assert.notEqual(getLatestHandoff(f.db,f.project.id)!.id,original.id);
 const response=await f.resolve({checkpointId:checkpoint.id,choice:'record_handoff',accept:true});assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().handoff.id,original.id);assert.equal(response.json().checkpoint.handoffId,original.id);
 assert.equal(response.json().handoff.did,'done A');
});
test('invalid compact keepRecent is rejected before accepting a proposal or preparing any provider',async t=>{
 const f=fixture(t);const checkpoint=await f.open();
 const first=await f.resolve({checkpointId:checkpoint.id,choice:'record_compact',intent:{goal:'goal',did:'did',issues:'',next:'next'}});assert.equal(first.statusCode,200,first.body);
 const proposalId=first.json().checkpoint.proposalId as string;
 const response=await f.resolve({checkpointId:checkpoint.id,choice:'record_compact',accept:true,keepRecent:0});assert.equal(response.statusCode,400,response.body);
 assert.equal(getMemoryView(f.db,f.project.id).proposals.find(p=>p.id===proposalId)!.status,'pending');
 assert.equal(getMemoryView(f.db,f.project.id).records.length,0);assert.equal(f.providerCreates(),0);
});
