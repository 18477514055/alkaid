/** Real HTTP/SSE + browser fixture for automatic obligations. Only a new temp home + loopback fake model. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import fastifyStatic from '@fastify/static';
import { loadConfig, ensureHome } from '../src/config.ts';
import { openDatabase } from '../src/core/store/db.ts';
import { migrate, SCHEMA_VERSION } from '../src/core/store/schema.ts';
import { setMemoryPolicy } from '../src/core/memory/rhythm.ts';
import { insertConversation, insertProvider, listMessages } from '../src/core/store/repo.ts';
import { createProject } from '../src/core/project/service.ts';
import { setSecret } from '../src/core/secrets.ts';
import { buildServer } from '../src/server/app.ts';
import { recordTurnProgress } from '../src/core/memory/context.ts';

const home=mkdtempSync(join(tmpdir(),'alkaid-obligation-review-'));
const config=loadConfig({ALKAID_HOME:home});ensureHome(config);mkdirSync(join(home,'empty-plugins'));
const factFile=join(home,'verified-facts.txt');writeFileSync(factFile,'共享事实：本轮读取的隔离文件逐字证据。\n只读工具也能产生值得保存的新知识。','utf8');
let primaryCalls=0,closureCalls=0,maintenanceCalls=0,allCalls=0;
let firstBusinessSystem:string|undefined;
const fake=createServer(async(req,res)=>{
 if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'local-obligation-model'}]}));return;}
 let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);allCalls++;
 const system=String(body.messages?.[0]?.content??'');
 const maintenance=system.startsWith('You maintain project memory');const closure=body.messages.some((message:any)=>String(message.content??'').includes('MEMORY_TURN_CLOSURE'));
 if(!maintenance){assert.doesNotMatch(system,/MEMORY_TURN_CLOSURE/);if(firstBusinessSystem===undefined)firstBusinessSystem=system;else assert.equal(system,firstBusinessSystem,'business and closure preserve identical first-system bytes');}
 const lastUser=[...body.messages].reverse().find((message:any)=>message.role==='user');const text=String(lastUser?.content??'');
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const frame=(delta:unknown,finish_reason:string|null=null)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`);
 const call=(index:number,name:string,args:object)=>frame({tool_calls:[{index,id:`fixture-${allCalls}-${index}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 let reason='stop';
 if(maintenance){
  maintenanceCalls++;const data=JSON.parse(body.messages[1].content);
  frame({content:JSON.stringify({decisions:data.proposals.map((p:any)=>({recordId:p.recordId,proposalIds:[p.id],action:p.operation==='delete'?'delete':'upsert',kind:p.kind,title:p.title,content:p.content,reason:'隔离验收：逐字应用独立提案'}))})});
 }else if(closure){
  closureCalls++;
  if(text.includes('[遗漏拒交]'))frame({content:'模拟仍不履责，程序必须保留未完成，不无限抽起。'});
  else if(text.includes('[无新增]')){call(0,'memory_disposition',{reason:'此轮仅确认已知结论，没有新的项目事实需要保存'});reason='tool_calls';}
  else{
   const key=`closure-${allCalls}`;
   call(0,'memory_propose',{recordId:key,kind:'active',title:'跨对话共享的已验证事实',operation:'upsert',content:`共享事实：本轮已实际读取隔离文件。来源${key}，不是提前人工塞入的提案。`,baseRevision:0,reason:`工具read已成功，文件${factFile}`,idempotencyKey:key});
   call(1,'memory_stage',{action:'triage',payload:{keep:[{what:`必须保留的共享事实 ${key}`}],stash:[{what:`该轮文件证据${factFile}`}],drop:[]},idempotencyKey:`triage-${key}`,reason:'本轮成功工具结果后的三桶取舍'});reason='tool_calls';
  }
 }else{
  primaryCalls++;
  if(text.includes('[无新增]'))frame({content:'已确认，这是一个没有新项目成果的简单问答。'});
  else if(body.messages.at(-1)?.role!=='tool'){call(0,'read',{path:factFile});reason='tool_calls';}
  else{frame({content:'业务首段：'});await delay(200);frame({content:'隔离调查完成，已核实文件中的共享事实。'});}
 }
 frame({},reason);res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:30}})}\n\n`);res.end('data: [DONE]\n\n');
});
await new Promise<void>(done=>fake.listen(0,'127.0.0.1',done));const address=fake.address();if(!address||typeof address==='string')throw new Error('fake bind');
const db=openDatabase(config.dbPath);migrate(db);
const provider=insertProvider(db,{name:'闭环验收：本地模型，不计费',baseUrl:`http://127.0.0.1:${address.port}/v1`,defaultModel:'local-obligation-model'});setSecret(config.secretsPath,provider.id,'local-test-placeholder');
const project=createProject(db,config,{name:'项目义务闭环 · 多对话共享验收'});const foreign=createProject(db,config,{name:'隔离项目B'});
// This verifier retains the original ten every-turn closure checks. Production
// default 5% rhythm is covered by the separate rhythm acceptance fixture.
setMemoryPolicy(db,project.id,{thresholdPercent:0});
setMemoryPolicy(db,foreign.id,{thresholdPercent:0});
const conv=(title:string)=>insertConversation(db,{providerId:provider.id,model:'local-obligation-model',projectId:project.id,permissionMode:'full',title});
const a=conv('A · 有成果但故意漏交');const b=conv('B · 共享读取与无新增');const c=conv('C · 模拟拒交后待处理');const legacy=conv('旧版欠账 · 只待复核');
recordTurnProgress(db,legacy.id,0,'progress_not_recorded');
const app=buildServer({config,db});await app.register(fastifyStatic,{root:resolve('dist/web'),prefix:'/'});
let stopping=false;async function close(){if(stopping)return;stopping=true;await app.close();await new Promise<void>(done=>fake.close(()=>done()));db.close();assert.ok(resolve(home).startsWith(resolve(tmpdir(),'alkaid-obligation-review-')));rmSync(home,{recursive:true,force:true});}
app.get('/__verify/status',async()=>({allCalls,primaryCalls,closureCalls,maintenanceCalls,projectId:project.id,foreignProjectId:foreign.id,a:a.id,b:b.id,c:c.id,legacy:legacy.id}));
app.post('/__verify/stop',async()=>{setTimeout(()=>void close(),50);return{stopping:true};});
const url=await app.listen({host:'127.0.0.1',port:0});const base=`/api/projects/${project.id}/memory`;
async function request(path:string,method='GET',body?:unknown,status=200):Promise<any>{const response=await fetch(url+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();assert.equal(response.status,status,`${method} ${path}: ${text.slice(0,250)}`);return JSON.parse(text);}
async function send(id:string,text:string){const response=await fetch(`${url}/api/conversations/${id}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:text})});assert.equal(response.status,200);const data=await response.text();return data.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));}
const checks:Record<string,boolean>={};
try{
 const events=await send(a.id,'[有成果] 读取证据并完成调查，但模拟主模型忘记提交项目记忆。');
 const aDuty=(await request(`${base}/obligations?conversationId=${a.id}&includeResolved=true`)).entries[0];assert.equal(aDuty.status,'staged');assert.equal(aDuty.repairAttempt,1);assert.equal(aDuty.evidence.length,2);assert.ok(aDuty.evidence.every((e:any)=>e.valid&&!e.stale));checks.realSseTriggersAutomaticDualCapture=true;
 assert.equal(events.filter((e:any)=>e.type==='text').map((e:any)=>e.delta).join(''),'业务首段：隔离调查完成，已核实文件中的共享事实。');assert.equal(listMessages(db,a.id).filter(m=>m.role==='user').length,1);checks.noBusinessReplayOrFakeUser=true;
 let view=await request(base);assert.equal(view.records.length,0);assert.equal(view.proposals.length,2);checks.pendingIsNotFormal=true;
 await request(`${base}/config`,'PATCH',{enabled:true,providerId:provider.id,model:'local-obligation-model',quietMs:1000});
 await delay(1100);assert.equal(maintenanceCalls,0);checks.singleAuthorStillZeroMaintenance=true;
 await send(c.id,'[遗漏拒交] 模拟业务有输出，补收尾仍不交作业。');const cDuty=(await request(`${base}/obligations?conversationId=${c.id}`)).entries[0];assert.equal(cDuty.status,'incomplete');assert.equal(cDuty.repairAttempt,1);assert.equal(cDuty.code,'OBLIGATION_REPAIR_EXHAUSTED');checks.ignoredReminderIsBoundedAndVisible=true;
 await send(b.id,'[无新增] 简单确认已知结论。');let page=await request(`${base}/obligations?includeResolved=true`);assert.equal(page.summary.incomplete,1);assert.equal(page.summary.exempt,1);assert.equal(page.summary.needsReview,1);checks.newExemptionDoesNotHideOldDebt=true;
 await send(b.id,'[有成果] B也读取证据并产生独立来源的进展。');
 const until=Date.now()+8000;for(;;){view=await request(base);if(view.jobs.some((job:any)=>job.state==='applied'))break;if(Date.now()>until)throw new Error('maintenance not applied after real quiet interval');await delay(30);}
 assert.equal(maintenanceCalls,1);assert.equal(view.records.length,4);assert.ok(view.proposals.every((p:any)=>p.status==='applied'));checks.twoAuthorsIdleQuietThenOneIndependentMerge=true;
 const read=await app.inject({method:'GET',url:`/api/conversations/${b.id}/prompt`});assert.equal(read.statusCode,200);assert.ok(read.body.includes('共享事实'));checks.peerPromptReadsFormalSharedMemory=true;
 page=await request(`${base}/obligations?includeResolved=true`);assert.equal(page.summary.staged,2);assert.equal(page.summary.incomplete,1);assert.equal(page.summary.exempt,1);assert.equal(page.summary.needsReview,1);
 const before=Number(db.prepare('SELECT total_changes() AS n').get()?.['n']);const callsBefore=allCalls;await request(`${base}/obligations?limit=1`);await request(`${base}/obligations?includeResolved=true&limit=20`);assert.equal(Number(db.prepare('SELECT total_changes() AS n').get()?.['n']),before);assert.equal(allCalls,callsBefore);checks.getIsLocalAndReadOnly=true;
 await request(`/api/projects/${foreign.id}/memory/obligations?conversationId=${a.id}`,'GET',undefined,404);checks.projectIsolation=true;
 const report={verifiedAt:new Date().toISOString(),baseURL:url,schema:SCHEMA_VERSION,thresholdPercent:0,fixtureOnly:true,projectId:project.id,conversations:{a:a.id,b:b.id,c:c.id,legacy:legacy.id},checks,allCalls,primaryCalls,closureCalls,maintenanceCalls,summary:page.summary,counts:checks.realSseTriggersAutomaticDualCapture?'through actual HTTP SSE and model tools, not manually seeded proposals':'FAILED'};
 // ★ 报告默认写 docs/（证据留档）；门禁把 ALKAID_VERIFY_REPORT_DIR 指到临时目录，
 //   否则每跑一次门禁就刷新一次 `docs/验收-*.json` ⇒ 工作树永远是脏的。见 gate.mjs 的说明。
 writeFileSync(process.env['ALKAID_VERIFY_REPORT_DIR']?resolve(process.env['ALKAID_VERIFY_REPORT_DIR'],'验收-项目义务闭环-HTTP.json'):resolve('../docs/验收-项目义务闭环-HTTP.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({ready:true,...report}));
 if(!process.argv.includes('--serve'))await close();
}catch(error){await close();throw error;}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
