import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createDefaultRegistry } from '../src/core/tools/index.ts';
import { buildConversationPrompt } from '../src/core/agent/prompt/session.ts';
import { listToolViews } from '../src/core/tools/settings.ts';

// Read-only production audit: no server, migrations, secrets, provider construction or generation.
// Do not serialize message bodies, reasoning, tool arguments, or complete system prompts.
const dbPath = resolve(process.argv[2]);
const output = process.argv[3] ? resolve(process.argv[3]) : null;
const db = new DatabaseSync(dbPath, { readOnly: true });
const parse = value => { try { return JSON.parse(value ?? 'null'); } catch { return null; } };
const group = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
const names = calls => (Array.isArray(calls) ? calls : []).map(call => call.name ?? call.function?.name ?? '(unknown)');
const all = (sql, ...args) => db.prepare(sql).all(...args);
const exists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const registry = createDefaultRegistry(db);
const counts = Object.fromEntries(['memory_records','memory_proposals','memory_jobs','memory_history','memory_intents','memory_handoffs','memory_triage_entries','memory_checkpoints','memory_read_receipts'].map(table => [table, exists(table) ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) : null]));
const projects = all('SELECT id,name,archived_at FROM projects').map(project => {
  const config = exists('memory_projects') ? parse(db.prepare('SELECT config FROM memory_projects WHERE project_id=?').get(project.id)?.config) : null;
  return { ...project, enabled: config?.enabled ?? false, model: config?.model ?? null,
    proposals: exists('memory_proposals') ? all('SELECT status,COUNT(*) AS n,COUNT(DISTINCT conversation_id) AS authors FROM memory_proposals WHERE project_id=? GROUP BY status', project.id) : [],
    jobs: exists('memory_jobs') ? all('SELECT state,COUNT(*) AS n FROM memory_jobs WHERE project_id=? GROUP BY state', project.id) : [] };
});
const conversations = all('SELECT id,title,project_id,permission_mode,state,created_at,updated_at,archived_at FROM conversations').map(conv => {
  const messages = all('SELECT id,seq,role,tool_calls,content,finish_reason,created_at FROM messages WHERE conversation_id=? ORDER BY seq', conv.id);
  const calls = messages.flatMap(message => names(parse(message.tool_calls)).map(name => ({ seq: message.seq, name })));
  const turns = [];
  for (let index=0;index<messages.length;index++) {
    const first = messages[index]; if (first.role !== 'user') continue;
    const rest = messages.slice(index+1); const next = rest.findIndex(message => message.role === 'user');
    const range = next < 0 ? rest : rest.slice(0,next);
    const toolNames = range.flatMap(message => names(parse(message.tool_calls)));
    const assistants = range.filter(message => message.role === 'assistant');
    const results = range.filter(message => message.role === 'tool').map(message => parse(message.content));
    turns.push({ userSeq: first.seq, createdAt: first.created_at, lastSeq: range.at(-1)?.seq ?? first.seq,
      assistantMessages: assistants.length, finalFinish: assistants.at(-1)?.finish_reason ?? null,
      businessReplyChars: assistants.reduce((sum,message)=>sum+(message.content?.length??0),0),
      tools: group(toolNames), memoryCalls: toolNames.filter(name=>name.startsWith('memory_')).length,
      successfulToolResults: results.filter(value=>value?.ok===true).length,
      toolFailures: group(results.filter(value=>value?.ok===false).map(value=>typeof value.code==='string'&&/^[a-z0-9_-]{1,80}$/i.test(value.code)?value.code:'unclassified')) });
  }
  const projection = buildConversationPrompt(db,conv.id,registry);
  const memory = projection.sections.find(section=>section.id==='project-memory')?.text ?? '';
  const views = listToolViews(db,registry,conv.permission_mode ?? 'workspace');
  return { ...conv, messageRoles: group(messages.map(message=>message.role)), userTurns: turns.length,
    tools: group(calls.map(call=>call.name)), memoryCalls: calls.filter(call=>call.name.startsWith('memory_')),
    memoryToolAvailabilityNow: views.filter(tool=>tool.name.startsWith('memory_')).map(tool=>({name:tool.name,mode:tool.mode,visible:tool.visibleInMode})),
    currentPromptProjection: { chars:projection.text.length,sha256:createHash('sha256').update(projection.text).digest('hex'),projectMemorySection:!!memory,projectMemoryChars:memory.length,hasMemoryPropose:memory.includes('memory_propose'),obligationUsesOptionalCan:memory.includes('有实质新进展可memory_propose'),hasDebtSignal:projection.text.includes('上轮进展尚未固化'),hasRecordedWarning:projection.text.includes('不得为消欠账伪造记录'),notHistoricalPromptProof:true },
    debtEvents: exists('memory_turn_debts') ? all('SELECT user_seq,code,created_at FROM memory_turn_debts WHERE conversation_id=? ORDER BY id',conv.id) : [],
    proposals: exists('memory_proposals') ? all('SELECT id,record_id,kind,status,created_at FROM memory_proposals WHERE conversation_id=? ORDER BY created_at',conv.id) : [],
    turns };
});
const appRoot=resolve(import.meta.dirname,'..');
const comparedFiles=['core/agent/loop.ts','core/agent/prompt/memory.ts','core/tools/memory.ts','core/memory/context.ts','core/memory/maintainer.ts'];
const sourcePackagedComparison=comparedFiles.map(file=>{
 const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
 const source=hash(resolve(appRoot,'src',file));
 const packaged=hash(resolve(appRoot,'release/YaoGuang-win32-x64/resources/app/src',file));
 return {file,sourceSha256:source,packagedSha256:packaged,match:source===packaged};
});
const report = { auditedAt:new Date().toISOString(),dbPath,readOnly:true,noNetworkOrModelRequests:true,sourcePackagedComparison,
  schema:Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version),
  counts,projects,conversations,
  limitations:['Current prompt/tool projection is reconstructed from current code and saved settings, not a saved proof of exact historical provider requests.','Successful tool result count is not by itself a count of file writes; tool names must be inspected together.','No message, reasoning, tool argument, credential or complete system prompt body is included.'] };
db.close();
const text=JSON.stringify(report,null,2);
if(output) writeFileSync(output,text,'utf8');
console.log(output ? JSON.stringify({auditedAt:report.auditedAt,schema:report.schema,readOnly:true,counts,projects,conversations:conversations.map(conv=>({id:conv.id,title:conv.title,userTurns:conv.userTurns,memoryCallCount:conv.memoryCalls.length,debtCount:conv.debtEvents.length,memoryToolAvailabilityNow:conv.memoryToolAvailabilityNow,currentPromptProjection:conv.currentPromptProjection})),sourcePackagedComparison,report:output},null,2) : text);
