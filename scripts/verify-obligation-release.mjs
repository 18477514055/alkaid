import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertDesktopClosed } from './release-guard.mjs';

const root=resolve(import.meta.dirname,'..');assertDesktopClosed();
const packaged=join(root,'release/YaoGuang-win32-x64/resources/app');
if(!/export const SCHEMA_VERSION = 10;/.test(readFileSync(join(packaged,'src/core/store/schema.ts'),'utf8')))throw new Error('Requires original v10 program baseline; receipt was not replaced. Use explicit saved rollback/reapply rather than redeploying blindly.');
const home=mkdtempSync(join(tmpdir(),'alkaid-obligation-release-'));mkdirSync(join(home,'empty-plugins'));
const binary=join(root,'release/YaoGuang-win32-x64/YaoGuang.exe');
let child;let calls=0;let closureCalls=0;let projectId,conversationId,expectedRecords,expectedMessages;const stages=[];
const fake=createHttpServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);calls++;
 res.writeHead(200,{'content-type':'text/event-stream'});
 const frame=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`);
 if(String(body.messages[0].content).includes('MEMORY_TURN_CLOSURE')){
  closureCalls++;
  const values=[['memory_propose',{recordId:'release-obligation-fact',kind:'active',title:'Release exact fact',operation:'upsert',content:'v11自动采集的逐字事实。\nrollback must preserve 🙂',baseRevision:0,reason:'isolated real transport',idempotencyKey:'release-progress'}],['memory_stage',{action:'triage',payload:{keep:[{what:'v11逐字keep跨版本保留'}],stash:[],drop:[]},reason:'isolated real transport',idempotencyKey:'release-triage'}]];
  values.forEach(([name,args],index)=>frame({tool_calls:[{index,id:`release-call-${index}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}));frame({},'tool_calls');
 }else{frame({content:'发布内核真实生成业务回复。'});frame({},'stop');}
 res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:90,completion_tokens:20}})}\n\n`);res.end('data: [DONE]\n\n');
});
await new Promise(done=>fake.listen(0,'127.0.0.1',done));const fakePort=fake.address().port;
async function sync(mode){const p=spawn(process.execPath,[join(root,'scripts/sync-release-safe.mjs'),mode],{cwd:root,stdio:'inherit'});const[code]=await once(p,'exit');assert.equal(code,0,mode);}
async function port(){const p=createServer();await new Promise(done=>p.listen(0,'127.0.0.1',done));const n=p.address().port;await new Promise(done=>p.close(done));return n;}
async function stop(){if(!child)return;const owned=child;child=undefined;if(owned.exitCode!==null)return;const exit=once(owned,'exit');owned.kill();await exit;}
async function check(stage,newCode){
 const p=await port(),url=`http://127.0.0.1:${p}`;
 child=spawn(binary,[join(packaged,'src/main.ts')],{cwd:packaged,stdio:'inherit',windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ALKAID_HOME:home,ALKAID_PORT:String(p),ALKAID_PLUGINS:join(home,'empty-plugins')}});
 let health;for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error('Owned kernel exited');try{const r=await fetch(url+'/api/healthz');if(r.ok){health=await r.json();break;}}catch{}await delay(100);}
 assert.equal(health?.schemaVersion,11);assert.throws(()=>assertDesktopClosed(),/running or ownership is unknown/,'real owned YaoGuang process must block every release mode');
 async function request(path,method='GET',body,status=200){const r=await fetch(url+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await r.text();assert.equal(r.status,status,`${stage} ${path}: ${text.slice(0,160)}`);return JSON.parse(text);}
 if(!projectId){
  const project=await request('/api/projects','POST',{name:'release obligation isolation only'},201);projectId=project.id;
  const provider=await request('/api/providers','POST',{name:'local offline release model',baseUrl:`http://127.0.0.1:${fakePort}/v1`,apiKey:'offline-placeholder-not-real',defaultModel:'local-release'},201);
  const conv=await request('/api/conversations','POST',{providerId:provider.id,model:'local-release',projectId,permissionMode:'project'},201);conversationId=conv.id;
  const r=await fetch(`${url}/api/conversations/${conversationId}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'验证发布版自动收尾，不预先人工塞提案。'})});assert.equal(r.status,200);await r.text();
  const prefix=`/api/projects/${projectId}/memory`;const view=await request(prefix);assert.equal(view.records.length,0);assert.equal(view.proposals.length,2);assert.equal(calls,2);assert.equal(closureCalls,1);
  const duties=await request(prefix+'/obligations?includeResolved=true');assert.equal(duties.entries[0].status,'staged');assert.equal(duties.entries[0].evidence.length,2);
  for(const proposal of view.proposals)await request(`${prefix}/proposals/${proposal.id}/accept`,'POST',{});
  expectedRecords=(await request(prefix)).records;expectedMessages=await request(`/api/conversations/${conversationId}/messages`);
 }
 const prefix=`/api/projects/${projectId}/memory`;const view=await request(prefix);assert.equal(view.config.enabled,false);assert.deepEqual(view.records,expectedRecords);
 assert.deepEqual(await request(`/api/conversations/${conversationId}/messages`),expectedMessages);
 const duty=await fetch(`${url}${prefix}/obligations?includeResolved=true`);assert.equal(duty.status,newCode?200:404);
 if(newCode){const body=await duty.json();assert.equal(body.entries[0].status,'staged');assert.equal(body.entries[0].evidence.length,2);assert.ok(body.entries[0].evidence.every(row=>row.proposalStatus==='applied'));}
 stages.push({stage,schemaVersion:health.schemaVersion,obligationStatus:duty.status,fullRecordsPreserved:true,allMessagesPreserved:true,realBundledNode:true,runningProcessGuardVerified:true});await stop();
}
try{
 await sync('deploy');await check('forward-v11',true);
 await sync('rollback');await check('rollback-v10-program-on-v11-data',false);
 await sync('reapply');await check('reapplied-v11',true);
 const report={verifiedAt:new Date().toISOString(),binary,stages,calls,closureCalls,automaticMaintenanceCalls:0,realUserHomeUntouched:true,note:'All generations used only loopback fake model. Rollback never downgraded or deleted the v11 database.'};
 const output=resolve(root,'../docs/验收-项目义务闭环-发布.json');writeFileSync(output,JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({verified:true,...report,output}));
}finally{await stop();await new Promise(done=>fake.close(done));assert.ok(resolve(home).startsWith(resolve(tmpdir(),'alkaid-obligation-release-')));rmSync(home,{recursive:true,force:true});}
