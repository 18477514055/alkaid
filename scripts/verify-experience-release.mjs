import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertDesktopClosed } from './release-guard.mjs';
const root=resolve(import.meta.dirname,'..'),packaged=join(root,'release/YaoGuang-win32-x64/resources/app');
const binary=join(root,'release/YaoGuang-win32-x64/YaoGuang.exe');
const publishing=process.argv.includes('--publish');
// Read the old installed program; never change a running user's program in isolated mode.
if(!/export const SCHEMA_VERSION = 11;/.test(readFileSync(join(packaged,'src/core/store/schema.ts'),'utf8')))throw new Error('Requires current installed v11 baseline. Do not redeploy blindly or overwrite a rollback receipt.');
if(publishing)assertDesktopClosed();
const home=mkdtempSync(join(tmpdir(),'alkaid-experience-release-'));mkdirSync(join(home,'empty-plugins'));
let child,projectId,conversationId,expectedRecords,expectedMessages,expectedBoard;let calls=0,closureCalls=0;const stages=[];
const fake=httpServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);calls++;
 res.writeHead(200,{'content-type':'text/event-stream'});
 const frame=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`);
 const call=(index,name,args)=>frame({tool_calls:[{index,id:`release-${calls}-${index}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 if(String(body.messages[0].content).includes('MEMORY_TURN_CLOSURE')){
  closureCalls++;
  call(0,'memory_propose',{recordId:'release-fact',kind:'active',title:'隔离打包事实',operation:'upsert',content:'v12隔离内核的逐字事实。\n回退仍保留 🙂',baseRevision:0,reason:'真实回环请求',idempotencyKey:'release-progress'});
  call(1,'memory_stage',{action:'triage',payload:{keep:[{what:'v12分流跨程序回退保留'}],stash:[],drop:[]},reason:'真实回环请求',idempotencyKey:'release-triage'});frame({},'tool_calls');
 }else{
  const userIndex=body.messages.findLastIndex(m=>m.role==='user'),recent=body.messages.slice(userIndex+1);
  const results=recent.filter(m=>m.role==='tool');
  if(!results.length){call(0,'execution_board',{action:'read'});frame({},'tool_calls');}
  else if(results.length===1){const result=JSON.parse(results[0].content),board=JSON.parse(result.content);call(0,'execution_board',{action:'update',baseRevision:board.revision,goal:{title:'完成打包回退验证',status:'active',summary:'当前执行目标，不是长期目标树'},tasks:[{id:'one',content:'验证逐字历史与看板',status:'in_progress'}],activity:'模型通过真实工具建立执行看板'});frame({},'tool_calls');}
  else{frame({content:'业务答复已完成。'});frame({},'stop');}
 }
 res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:90,completion_tokens:20}})}\n\n`);res.end('data: [DONE]\n\n');
});
await new Promise(done=>fake.listen(0,'127.0.0.1',done));const fakePort=fake.address().port;
async function sync(mode){const p=spawn(process.execPath,[join(root,'scripts/sync-release-safe.mjs'),mode],{cwd:root,stdio:'inherit'});const[code]=await once(p,'exit');assert.equal(code,0,mode);}
async function port(){const p=createServer();await new Promise(done=>p.listen(0,'127.0.0.1',done));const n=p.address().port;await new Promise(done=>p.close(done));return n;}
async function stop(){if(!child)return;const owned=child;child=undefined;if(owned.exitCode!==null)return;const exit=once(owned,'exit');owned.kill();await exit;}
async function check(stage,program,newCode){
 const p=await port(),url=`http://127.0.0.1:${p}`;
 child=spawn(binary,[join(program,'src/main.ts')],{cwd:program,stdio:'inherit',windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ALKAID_HOME:home,ALKAID_PORT:String(p),ALKAID_PLUGINS:join(home,'empty-plugins')}});
 let health;for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error('Owned kernel exited');try{const r=await fetch(url+'/api/healthz');if(r.ok){health=await r.json();break;}}catch{}await delay(100);}
 assert.equal(health?.schemaVersion,12);assert.throws(()=>assertDesktopClosed(),/running or ownership is unknown/);
 async function request(path,method='GET',body,status=200){const r=await fetch(url+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await r.text();assert.equal(r.status,status,`${stage} ${path}: ${text.slice(0,160)}`);return JSON.parse(text);}
 if(!projectId){
  const project=await request('/api/projects','POST',{name:'release experience isolation only'},201);projectId=project.id;
  const provider=await request('/api/providers','POST',{name:'offline release model',baseUrl:`http://127.0.0.1:${fakePort}/v1`,apiKey:'offline-placeholder-not-real',defaultModel:'local-release',contextWindow:1000000},201);
  const conv=await request('/api/conversations','POST',{providerId:provider.id,model:'local-release',projectId,permissionMode:'readonly'},201);conversationId=conv.id;
  await request(`/api/projects/${projectId}/memory/policy`,'PATCH',{thresholdPercent:0});
  const r=await fetch(`${url}/api/conversations/${conversationId}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'验证实际模型工具建板与双记录，不预塞看板。'})});assert.equal(r.status,200);await r.text();
  const prefix=`/api/projects/${projectId}/memory`;const view=await request(prefix);assert.equal(view.records.length,0);assert.equal(view.proposals.length,2);assert.equal(calls,4);assert.equal(closureCalls,1);
  for(const proposal of view.proposals)await request(`${prefix}/proposals/${proposal.id}/accept`,'POST',{});
  expectedRecords=(await request(prefix)).records;expectedMessages=await request(`/api/conversations/${conversationId}/messages`);
  expectedBoard=await request(`/api/projects/${projectId}/execution/${conversationId}`);assert.equal(expectedBoard.goal.title,'完成打包回退验证');assert.equal(expectedBoard.tasks.length,1);assert.equal(expectedBoard.revision,1);
 }
 assert.deepEqual((await request(`/api/projects/${projectId}/memory`)).records,expectedRecords);
 assert.deepEqual(await request(`/api/conversations/${conversationId}/messages`),expectedMessages);
 const board=await fetch(`${url}/api/projects/${projectId}/execution/${conversationId}`);assert.equal(board.status,newCode?200:404);
 if(newCode){assert.deepEqual(await board.json(),expectedBoard);assert.deepEqual(await request(`/api/projects/${projectId}/memory/policy`),{thresholdPercent:0});}
 stages.push({stage,schemaVersion:health.schemaVersion,executionStatus:board.status,fullRecordsPreserved:true,allMessagesPreserved:true,executionStatePreserved:newCode?true:'retained-not-exposed-by-old-code',realBundledNode:true,runningProcessGuardVerified:true});await stop();
}
try{
 if(publishing){await sync('deploy');await check('deployed-v12',packaged,true);await sync('rollback');await check('rollback-v11-program-on-v12-data',packaged,false);await sync('reapply');await check('reapplied-v12',packaged,true);}
 else{await check('source-v12-with-bundled-node',root,true);await check('installed-v11-program-on-v12-data',packaged,false);await check('source-v12-restored-with-bundled-node',root,true);}
 const report={verifiedAt:new Date().toISOString(),binary,published:publishing,stages,calls,closureCalls,automaticMaintenanceCalls:0,realUserHomeUntouched:true,note:'All generations use loopback fake model. No database downgrade or deletion. Isolated mode never changes installed program; --publish requires a closed desktop and v11 baseline.'};
 const output=resolve(root,publishing?'../docs/验收-简明工作看板-发布.json':'../docs/验收-简明工作看板-隔离回退.json');writeFileSync(output,JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({verified:true,...report,output}));
}finally{await stop();await new Promise(done=>fake.close(done));assert.ok(resolve(home).startsWith(resolve(tmpdir(),'alkaid-experience-release-')));rmSync(home,{recursive:true,force:true});}
