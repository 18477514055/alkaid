/** v16 -> v17 acceptance. New isolated home, actual packaged Node executable; never opens the user's DB.
 * Default verifies source against the currently packaged v16 baseline without changing release files.
 * --publish additionally deploys, boots, rolls back to v16 against the v17 DB, then reapplies and boots.
 * Historical v7-v16 scripts and reports remain untouched. Never stops an existing desktop process.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { assertDesktopClosed } from './release-guard.mjs';

const root=resolve(import.meta.dirname,'..');
const packaged=join(root,'release/YaoGuang-win32-x64/resources/app');
const binary=join(root,'release/YaoGuang-win32-x64/YaoGuang.exe');
const publishing=process.argv.includes('--publish');
const report=resolve(root,'../docs',publishing?'验收-发布-v17.json':'验收-发布-v17-隔离.json');
const realDb=process.env.APPDATA?join(process.env.APPDATA,'alkaid/data/alkaid.db'):null;
const realMtime=realDb&&existsSync(realDb)?statSync(realDb).mtimeMs:null;
if(publishing)assertDesktopClosed();
assert.ok(existsSync(binary),'Packaged executable required');
const home=mkdtempSync(join(tmpdir(),'alkaid-release-v17-'));mkdirSync(join(home,'empty-plugins'));
const stages=[];let child;let deployed=false;let rolledBack=false;let baselineRows;
async function stop(){if(!child)return;const owned=child;child=undefined;if(owned.exitCode!==null)return;const done=once(owned,'exit');owned.kill();await done;}
async function runNode(args,options={}){
 const proc=spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true,...options});
 let stdout='',stderr='';proc.stdout.on('data',x=>stdout+=x);proc.stderr.on('data',x=>stderr+=x);
 const[code]=await once(proc,'exit');assert.equal(code,0,`Child failed: ${stdout}\n${stderr}`);return{stdout,stderr};
}
async function freePort(){const srv=createServer();await new Promise(r=>srv.listen(0,'127.0.0.1',r));const p=srv.address().port;await new Promise(r=>srv.close(r));return p;}
async function boot(program,schema,label){
 const port=await freePort(),url=`http://127.0.0.1:${port}`;
 child=spawn(binary,[join(program,'src/main.ts')],{cwd:program,stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ALKAID_HOME:home,ALKAID_PORT:String(port),ALKAID_PLUGINS:join(home,'empty-plugins')}});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 let health;
 for(let i=0;i<200;i++){
  if(child.exitCode!==null)throw new Error(`${label} exited: ${stdout}\n${stderr}`);
  try{const res=await fetch(`${url}/api/healthz`);if(res.ok){health=await res.json();break;}}catch{}
  await delay(100);
 }
 assert.ok(health,`${label}: no health response\n${stdout}\n${stderr}`);assert.equal(health.schemaVersion,schema,`${label}: baseline/schema mismatch; refusing to overwrite another release`);
 async function request(path,method='GET',body,status=200){const r=await fetch(url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const text=await r.text();assert.equal(r.status,status,`${label} ${path}: ${text.slice(0,400)}`);return text?JSON.parse(text):null;}
 return{request,diagnostics:()=>({stderr,stdout})};
}
function rows(){const db=new DatabaseSync(join(home,'alkaid.db'),{readOnly:true});try{return db.prepare('SELECT * FROM messages ORDER BY conversation_id,seq').all();}finally{db.close();}}
function counts(){const db=new DatabaseSync(join(home,'alkaid.db'),{readOnly:true});try{return{schema:Number(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n),messages:Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n),tables:Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n),newTables:db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('compaction_attempts','compaction_events','compaction_metadata') ORDER BY name").all().map(r=>r.name)};}finally{db.close();}}
async function sync(mode){await runNode(['scripts/sync-release-safe.mjs',mode]);}
function checkOriginals(){assert.deepEqual(rows(),baselineRows,'Migration/rollback changed authoritative original bytes or structured fields');}
async function verify(program,label,conv){
 const server=await boot(program,17,label);checkOriginals();const c=counts();assert.equal(c.messages,4);assert.equal(c.newTables.length,3);
 const settings=await server.request('/api/settings');assert.equal(settings.general.autoCompactEnabled,true);assert.equal(settings.general.compactThresholdPercent,80);assert.equal(settings.general.maxStepsPerTurn,null);assert.equal(settings.general.delegateAllowParentModel,false);
 const status=await server.request(`/api/conversations/${conv}/compaction-status`);assert.equal(status.plan.status,'blocked');assert.equal(status.plan.reason,'no_project');assert.ok(Array.isArray(status.events.entries));
 const blocked=await server.request(`/api/conversations/${conv}/compact`,'POST',{},409);assert.equal(blocked.compacted,false);assert.equal(blocked.code,'no_project');
 const events=await server.request(`/api/conversations/${conv}/compaction-events`);assert.ok(events.entries.some(e=>e.code==='COMPACTION_BLOCKED_NO_PROJECT'));
 const index=await server.request(`/api/conversations/${conv}/recall?mode=index`);assert.equal(index.total,4);
 let offset=0,text='',chunks=0;for(;;){const part=await server.request(`/api/conversations/${conv}/recall?mode=message&seq=1&charOffset=${offset}&maxChars=4096`);text+=part.text;chunks++;if(part.done)break;assert.ok(part.nextOffset>offset);offset=part.nextOffset;}
 const original=JSON.parse(text);assert.ok(original.content.endsWith('TAIL_原文 🧭'));assert.ok(original.content.length>20000);assert.ok(chunks>5);
 const messages=await server.request(`/api/conversations/${conv}/messages`);assert.equal(messages.length,4);assert.equal(messages[1].toolCalls[0].name,'read');assert.equal(messages[3].reasoning,'old reasoning preserved');
 await stop();const diag=server.diagnostics();assert.doesNotMatch(diag.stderr,/SyntaxError|TypeError|ReferenceError|ERR_MODULE_NOT_FOUND|UnhandledPromiseRejection/);checkOriginals();
 stages.push({stage:label,...c,originalBytesUnchanged:true,recallChunks:chunks,oldSettingsPreserved:true,newRoutes:true,stderr:diag.stderr});
}
try{
 const baseline=await boot(packaged,16,'baseline-v16');
 const provider=await baseline.request('/api/providers','POST',{name:'offline isolated release',baseUrl:'http://127.0.0.1:1/v1',apiKey:'offline-not-a-real-secret',defaultModel:'offline'},201);
 const conv=await baseline.request('/api/conversations','POST',{providerId:provider.id,model:'offline'},201);
 await baseline.request('/api/settings','PATCH',{general:{maxStepsPerTurn:null,delegateAllowParentModel:false}});await stop();
 const seed=`import {DatabaseSync} from 'node:sqlite';import {appendMessage} from ${JSON.stringify(pathToFileURL(join(packaged,'src/core/store/repo.ts')).href)};const db=new DatabaseSync(${JSON.stringify(join(home,'alkaid.db'))});const id=${JSON.stringify(conv.id)};appendMessage(db,{conversationId:id,role:'user',content:'ORIGINAL_'+'原'.repeat(22000)+'TAIL_原文 🧭'});appendMessage(db,{conversationId:id,role:'assistant',content:null,toolCalls:[{id:'legacy-read',name:'read',arguments:'{"path":"safe.txt"}'}],finishReason:'tool_calls'});appendMessage(db,{conversationId:id,role:'tool',toolCallId:'legacy-read',content:'{"ok":false,"code":"legacy_error"}'});appendMessage(db,{conversationId:id,role:'assistant',content:'legacy reply',reasoning:'old reasoning preserved',usage:{input:5,cached:7,cachedWrite:3,output:2},finishReason:'stop'});db.close();`;
 await runNode(['--input-type=module','--eval',seed]);baselineRows=rows();assert.equal(baselineRows.length,4);stages.push({stage:'baseline-v16',...counts(),nonemptyProtocolFixture:true});
 if(!publishing)await verify(root,'source-v17',conv.id);
 else{
  assertDesktopClosed();await sync('deploy');deployed=true;await verify(packaged,'deployed-v17',conv.id);
  await sync('rollback');rolledBack=true;const old=await boot(packaged,17,'rollback-v16-on-v17-db');checkOriginals();const oldSettings=await old.request('/api/settings');assert.equal(oldSettings.general.maxStepsPerTurn,null);assert.equal(oldSettings.general.delegateAllowParentModel,false);const oldMessages=await old.request(`/api/conversations/${conv.id}/messages`);assert.equal(oldMessages.length,4);await stop();const diag=old.diagnostics();assert.doesNotMatch(diag.stderr,/SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/);stages.push({stage:'rollback-v16-on-v17-db',...counts(),oldProgramReadsUpgradedDb:true,originalBytesUnchanged:true,stderr:diag.stderr});
  await sync('reapply');rolledBack=false;await verify(packaged,'reapplied-v17',conv.id);
 }
 assert.equal(realDb&&existsSync(realDb)?statSync(realDb).mtimeMs:null,realMtime,'Real user DB mtime changed externally; not safe to claim untouched');
 const result={createdAt:new Date().toISOString(),mode:publishing?'published':'isolated',allPass:true,realDatabaseNotOpened:true,realDatabaseMtimeUnchanged:true,stages};mkdirSync(resolve(report,'..'),{recursive:true});writeFileSync(report,JSON.stringify(result,null,2));console.log(JSON.stringify({allPass:true,mode:result.mode,report,stages:stages.map(({stderr,...x})=>x)},null,2));
}catch(error){await stop();if(publishing&&deployed&&!rolledBack){try{await sync('rollback');console.error('New release failed; restored verified v16 program artifacts (DB remains additive v17).');}catch(recovery){console.error('Automatic rollback failed; stop and inspect release receipt.',recovery);}}throw error;}
finally{await stop();const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir(),'alkaid-release-v17-')));rmSync(absolute,{recursive:true,force:true});}
