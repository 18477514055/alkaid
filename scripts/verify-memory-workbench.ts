/** Complete local memory-workbench acceptance fixture. No production home or network credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import fastifyStatic from '@fastify/static';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/core/store/db.ts';
import { migrate, SCHEMA_VERSION } from '../src/core/store/schema.ts';
import { appendMessage, insertConversation, insertProvider } from '../src/core/store/repo.ts';
import { createProject } from '../src/core/project/service.ts';
import { setSecret } from '../src/core/secrets.ts';
import { buildServer } from '../src/server/app.ts';
import { projectMemoryBlock } from '../src/core/agent/prompt/memory.ts';
import { createDefaultRegistry } from '../src/core/tools/index.ts';
import { getCompactionDuties } from '../src/core/memory/duties.ts';

const home = mkdtempSync(join(tmpdir(), 'alkaid-workbench-review-'));
const config = { ...loadConfig(), home, dbPath: join(home, 'alkaid.db'), secretsPath: join(home, 'secrets.json'), projectsDir: join(home, 'projects'), logsDir: join(home, 'logs') };
for (const dir of [config.projectsDir, config.logsDir, join(home, 'empty-plugins')]) mkdirSync(dir, { recursive: true });
let generationCalls = 0; let compactionCalls = 0; let maintenanceCalls = 0; let primaryCalls = 0;
let firstBusinessSystem: string | undefined;
const fake = createServer(async (req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'offline-workbench-model' }] })); return; }
  let body = ''; for await (const part of req) body += part;
  const request = JSON.parse(body);
  generationCalls++;
  const system = String(request.messages?.[0]?.content ?? '');
  const compacting = system.includes('上下文压缩器');
  const maintaining = system.startsWith('You maintain project memory');
  const closure = request.messages.some((message:any) => String(message.content ?? '').includes('MEMORY_TURN_CLOSURE'));
  if (compacting) compactionCalls++;
  else if (maintaining) maintenanceCalls++;
  else {
    primaryCalls++; assert.equal(closure, false, 'checkpoint proof is proactive, not an accidental repair request');
    assert.doesNotMatch(system, /MEMORY_TURN_CLOSURE/);
    if (firstBusinessSystem === undefined) firstBusinessSystem = system;
    else assert.equal(system, firstBusinessSystem, 'business steps retain the first system prefix');
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = (delta: unknown, reason: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  const call = (index:number,name:string,args:object) => frame({ tool_calls:[{index,id:`workbench-proof-${generationCalls}-${index}`,type:'function',function:{name,arguments:JSON.stringify(args)}}] });
  const lastUser = [...request.messages].reverse().find((message:any) => message.role === 'user');
  let finish = 'stop';
  if (compacting) frame({ content: '隔离压缩摘要：用户要求正式使用前补齐本地记忆工作台；所有原文可按指针回读。' });
  else if (String(lastUser?.content ?? '').includes('[CHECKPOINT_READY]') && request.messages.at(-1)?.role === 'user') {
    const key=`checkpoint-proof-${generationCalls}`;
    call(0,'memory_propose',{recordId:key,kind:'active',title:'已核验的工作台进展',operation:'upsert',content:'归档、目标树、人工审批和项目隔离已通过本次真实HTTP验收。',baseRevision:0,reason:'本夹具此前成功HTTP请求与断言',idempotencyKey:key});
    call(1,'memory_stage',{action:'intent',payload:{goal:'保留工作台验收进展',did:'已完成真实HTTP读取与审批隔离验证',issues:'真实模型未接入',next:'人工复核后按统一引擎压缩'},idempotencyKey:`log-${key}`,reason:'本轮核验的进展日志，不兼任台账'});
    call(2,'memory_stage',{action:'triage',payload:{keep:[],stash:[{what:'工作台压缩前台账、进展日志、分流三份成功回执已按顺序产生。'}],drop:[]},idempotencyKey:`triage-${key}`,reason:'台账与日志提交后的新鲜分流'});
    finish='tool_calls';
  } else { frame({ content: '流式首段：' }); await delay(400); frame({ content: '业务结果已完成。' }); }
  frame({}, finish); res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } })}\n\n`); res.end('data: [DONE]\n\n');
});
await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
const address = fake.address(); if (!address || typeof address === 'string') throw new Error('Fake model bind failed');
const db = openDatabase(config.dbPath); migrate(db);
const provider = insertProvider(db, { name: '工作台隔离模型（本地不计费）', baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: 'offline-workbench-model' });
setSecret(config.secretsPath, provider.id, 'test-only-local-fixture');
const project = createProject(db, config, { name: '记忆工作台 · 正式使用前验收' });
const other = createProject(db, config, { name: '隔离项目 B（不得串读）' });
const a = insertConversation(db, { providerId: provider.id, model: 'offline-workbench-model', projectId: project.id, title: '工作台验收 · A', permissionMode: 'project' });
const b = insertConversation(db, { providerId: provider.id, model: 'offline-workbench-model', projectId: project.id, title: '工作台验收 · B', permissionMode: 'project' });
insertConversation(db, { providerId: provider.id, model: 'offline-workbench-model', projectId: other.id, title: '项目 B 的对话', permissionMode: 'project' });
const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });
await app.register(fastifyStatic, { root: resolve('dist/web'), prefix: '/' });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await app.close(); await new Promise<void>(r => fake.close(() => r())); db.close();
  if (!resolve(home).startsWith(resolve(tmpdir(), 'alkaid-workbench-review-'))) throw new Error('Unexpected fixture cleanup target');
  rmSync(home, { recursive: true, force: true });
}
app.get('/__verify/status', async () => ({ generationCalls, compactionCalls, maintenanceCalls, primaryCalls, projectId: project.id, otherProjectId: other.id, conversationA: a.id, conversationB: b.id }));
app.post('/__verify/stop', async () => { setTimeout(() => { void close(); }, 50); return { stopping: true }; });
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const prefix = `/api/projects/${project.id}/memory`;
let serial = 0;
async function request(path: string, method = 'GET', payload?: unknown, expected = 200, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`${url}${path}`, { method, headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const text = await response.text(); assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 300)}`);
  const jsonType = response.headers.get('content-type')?.includes('application/json'); return jsonType ? JSON.parse(text) : text;
}
async function stage(recordId: string, kind: string, content: unknown, baseRevision = 0, conversationId = a.id, title = recordId): Promise<any> {
  return request(`${prefix}/proposals`, 'POST', { conversationId, recordId, kind, title, operation: 'upsert', content: typeof content === 'string' ? content : JSON.stringify(content), baseRevision, reason: '本地隔离验收证据', idempotencyKey: `review-${++serial}` }, 201);
}
async function accept(id: string) { await request(`${prefix}/proposals/${id}/accept`, 'POST', {}); }
async function publish(recordId: string, kind: string, content: unknown, baseRevision = 0, conversationId = a.id, title = recordId) { const p = await stage(recordId, kind, content, baseRevision, conversationId, title); await accept(p.id); return p; }
async function artifact(type: string, payload: unknown, conversationId = a.id) { const p = await request(`${prefix}/artifacts`, 'POST', { conversationId, idempotencyKey: `artifact-review-${++serial}`, type, payload }, 201); await accept(p.id); return p; }
async function userApprove(proposalId: string) {
  const headers = { origin: url, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-alkaid-human-intent': 'principle-approval' };
  const cap = await request(`${prefix}/principles/proposals/${proposalId}/approval-intent`, 'POST', { operation: 'approve' }, 200, headers);
  await request(`${prefix}/principles/proposals/${proposalId}/approve`, 'POST', { capability: cap.capability }, 200, headers);
}
const checks: Record<string, boolean> = {};
try {
  for (let version = 1; version <= 5; version++) await publish('active-current', 'active', `第${version}版：逐字归档原文\n第二行 preserved-${version}`, version - 1);
  const beforePrompt = projectMemoryBlock(db, a.id);
  const archive = await request(`${prefix}/archive?recordId=active-current&limit=50`);
  assert.equal(archive.total, 5);
  const third = archive.entries.find((r: any) => r.after.revision === 3);
  const beforeThird = await request(`${prefix}/archive/${third.id}?side=before`);
  assert.equal(beforeThird.snapshot.content, '第2版：逐字归档原文\n第二行 preserved-2');
  await request(`${prefix}/archive/${third.id}`, 'DELETE', undefined, 409);
  assert.equal(projectMemoryBlock(db, a.id), beforePrompt); checks.archive = true;
  const goal = (parentId: string | null, state: string, lessons: string[] = []) => ({ parentId, state, keyResults: ['验收能够复现'], lessons, body: '正式使用前补齐真实机制' });
  await publish('goal-root', 'goal', goal(null, 'root'), 0, a.id, '正式使用前补齐记忆');
  await publish('goal-child', 'goal', goal('goal-root', 'active'), 0, a.id, '右栏可直接理解与操作');
  await publish('goal-grandchild', 'goal', goal('goal-child', 'done', ['有标签不等于有机制']), 0, a.id, '完整归档可回读');
  const tree = await request(`${prefix}/goals`); assert.equal(tree.nodes.find((n: any) => n.record.id === 'goal-grandchild').depth, 2); checks.goals = true;
  await request(`${prefix}/proposals`, 'POST', { conversationId: a.id, recordId: 'lesson-invalid', kind: 'lesson', title: '必须有根因', operation: 'upsert', content: JSON.stringify({ type: 'lesson', category: '假设错', body: 'body', fix: 'fix' }), baseRevision: 0, reason: 'fixture', idempotencyKey: 'bad-lesson' }, 400);
  await publish('lesson-root-cause', 'lesson', { type: 'lesson', category: '假设错', body: '不能把goal标签当作目标树机制。', rootCause: '只核对名字，未验证状态/父子/权重', fix: '逐项测试真实机制与异常路径', source: 'docs/任务单-记忆模块还缺什么.md:68' }, 0, a.id, '标签不等于机制');
  await publish('experience-entry', 'lesson', { type: 'experience', category: '机制', body: '全局注册维护工具不代表本轮实际调用。', source: 'app/src/core/agent/loop.ts:192', fix: '只在实际调用后抑制维护后续文字' }, 0, a.id, '保留真正的流式输出');
  const lessons = await request(`${prefix}/lessons?category=${encodeURIComponent('假设错')}&q=${encodeURIComponent('状态')}`); assert.equal(lessons.entries.length, 1); checks.lessons = true;
  await publish('note-1', 'note', { type: 'problem', body: '用户不应再去数据目录寻找材料。', rootCause: '缺少看板读取入口' }, 0, a.id, '工作台问题笔记');
  await publish('note-2', 'note', { type: 'research', body: '相同标题的笔记仍应各自保留。', conclusion: '系统生成独立日期文件名并可直接读取。' }, 0, a.id, '工作台问题笔记');
  checks.notes = true;
  const keepText = '逐字keep：不可覆盖他人进展。\n下一轮必须知道本项目只在本地存储。';
  await artifact('triage', { keep: [{ what: keepText, why: '下一轮不可丢' }], stash: [{ what: 'stash_unique_probe_材料细节', where: 'docs/任务单-记忆模块还缺什么.md' }], drop: [{ what: '旧的全局缓冲方案', why: '会破坏流式输出' }] });
  const triage = await request(`${prefix}/triage?q=stash_unique_probe`); assert.equal(triage.stash.length, 1); assert.ok(projectMemoryBlock(db, a.id)?.includes(keepText)); assert.ok(!projectMemoryBlock(db, a.id)?.includes('stash_unique_probe')); checks.triage = true;
  const handoff = { title: '正式使用前交接', did: '归档与目标树、结构教训机制已完成隔离验收。', state: '当前工作台可读；真实模型与旧资料未接入。', next: '选择真实维护模型并复核后，再确认旧资料导入。', files: [join(process.cwd(), 'docs', '任务单-记忆模块还缺什么.md')], blocked: '等待用户选择与确认，不擅自付费。' };
  await artifact('handoff', handoff); await artifact('handoff', handoff);
  const bench = await request(`${prefix}/workbench`); assert.equal(bench.handoffs.length, 2);
  const materialized1 = await request(`${prefix}/handoffs/${bench.handoffs[0].id}/materialize`, 'POST', {});
  const hash1 = createHash('sha256').update(readFileSync(materialized1.path)).digest('hex');
  const materialized2 = await request(`${prefix}/handoffs/${bench.handoffs[1].id}/materialize`, 'POST', {});
  assert.notEqual(materialized1.path, materialized2.path); assert.equal(createHash('sha256').update(readFileSync(materialized1.path)).digest('hex'), hash1);
  const handoffBody = await request(`${prefix}/handoffs/${bench.handoffs[0].id}/download`); for (const part of ['做了什么', '当前状态', '下一步', '文件', '阻塞']) assert.ok(handoffBody.includes(part)); checks.handoffs = true;
  const principle = await request(`${prefix}/principles/proposals`, 'POST', { recordId: 'principle-local', title: '本地与人工审批', content: '不得把记忆上传云端；原则只能由用户明确批准。', operation: 'upsert', baseRevision: 0 }, 201);
  assert.equal((await request(`${prefix}/principles/current`)).records.length, 0);
  await request(`${prefix}/principles/proposals/${principle.id}/approve`, 'POST', { actor: 'human' }, 403);
  await userApprove(principle.id); assert.equal((await request(`${prefix}/principles/current`)).records.length, 1);
  await request(`${prefix}/principles/proposals`, 'POST', { recordId: 'principle-review', title: '待用户复核的原则', content: '后续增加其他维护资源前应明确其权限和费用边界。', operation: 'upsert', baseRevision: 0 }, 201); checks.principles = true;
  const ext = await request(`${prefix}/extensions`, 'POST', { name: '本项目附加核查', description: '不替代内置记忆的只追加记录', mode: 'single', appendOnly: true }, 201);
  await artifact('extension-entry', { extensionId: ext.id, key: 'main', action: 'append', content: '追加条目一：工作台已可直接读取材料。' });
  await request(`${prefix}/artifacts`, 'POST', { conversationId: a.id, idempotencyKey: 'bad-replace', type: 'extension-entry', payload: { extensionId: ext.id, key: 'main', action: 'replace', content: '不得覆盖' } }, 400);
  checks.extensions = true;
  await artifact('intent', { conversationId: a.id, goal: '正式使用前补齐本地工作台', did: '逐项实测而不是只添加类型标签', issues: '真实模型及资料导入待用户选择', next: '在右栏完成核对与审批' });
  appendMessage(db, { conversationId: a.id, role: 'user', content: '逐字用户原话：请把当前情况简明地展示在右侧看板。\n保留换行。' });
  // The unified engine retains at least 10% of the declared context window.
  // Provide enough actual source text for a safe old prefix; never weaken that gate.
  for (let i = 0; i < 9; i++) appendMessage(db, { conversationId: a.id, role: i % 2 ? 'assistant' : 'user', content: `隔离历史第${i}条：用于逐字胶囊与检查点压缩验收。\n${'这是逐字可核验的本地隔离历史。'.repeat(300)}` });
  appendMessage(db, { conversationId: a.id, role: 'tool', content: JSON.stringify({ ok: false, code: 'fixture_error', message: '可取回的工具报错原文（非上游响应体）' }) });
  const users = await request(`${prefix}/logs?view=users&conversationId=${a.id}`); assert.ok(users[0].messages.some((q: any) => q.content.includes('保留换行。'))); checks.logs = true;
  const checkpoint = (await request(`/api/conversations/${a.id}/checkpoint`, 'POST', {})).checkpoint;
  const pending = await request(`/api/conversations/${a.id}/checkpoint/resolve`, 'POST', { checkpointId: checkpoint.id, choice: 'record_compact', intent: { goal: '固化进展再压缩', did: '完成本地工作台验收', issues: '', next: '复核模型与导入设置' } });
  assert.equal(pending.requiresAcceptance, true); assert.equal(generationCalls, 0);
  // Manual acceptance cannot manufacture the three real compaction duty receipts.
  const blocked = await request(`/api/conversations/${a.id}/checkpoint/resolve`, 'POST', { checkpointId: checkpoint.id, choice: 'record_compact', accept: true }, 409);
  assert.equal(blocked.compacted, false); assert.equal(compactionCalls, 0); assert.equal(generationCalls, 0); checks.checkpointBlockedWithoutTripleEvidence = true;
  const proofSse = await request(`/api/conversations/${a.id}/messages`, 'POST', { content: '[CHECKPOINT_READY] 根据此前本地核验成果，先分别提交台账和进展日志，最后分流，然后继续业务答复。' });
  const proofEvents = String(proofSse).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.ok(proofEvents.some((event:any) => event.type === 'finish' && event.reason === 'stop'));
  assert.deepEqual(proofEvents.flatMap((event:any) => event.type === 'assistant' ? (event.message.toolCalls ?? []).map((call:any) => call.name) : []), ['memory_propose','memory_stage','memory_stage']);
  const duties = getCompactionDuties(db,a.id); assert.equal(duties.complete,true); assert.ok(duties.checkpoint);
  assert.equal(new Set([duties.checkpoint.ledger.proposalId,duties.checkpoint.log.proposalId,duties.checkpoint.triage.proposalId]).size,3); checks.actualToolTripleBeforeCheckpoint = true;
  assert.equal(primaryCalls,2); assert.equal(compactionCalls,0);
  const accepted = await request(`/api/conversations/${a.id}/checkpoint/resolve`, 'POST', { checkpointId: checkpoint.id, choice: 'record_compact', accept: true });
  assert.equal(accepted.checkpoint.status, 'resolved'); assert.equal(compactionCalls, 1);
  const capsules = await request(`${prefix}/capsules?conversationId=${a.id}`); assert.ok(capsules.capsules.some((c: any) => c.users.some((q: any) => q.text?.includes('保留换行。')))); assert.ok(projectMemoryBlock(db, a.id)?.includes(keepText)); checks.capsuleAndCheckpoint = true;
  const mapBefore = await request(`${prefix}/material-map?conversationId=${a.id}`); assert.equal(mapBefore.materials.find((m: any) => m.recordId === 'lesson-root-cause').read, false);
  const registry = createDefaultRegistry(db);
  await registry.execute('memory_read', { recordId: 'lesson-root-cause' }, { conversationId: a.id, permissionMode: 'project', roots: { readable: [], writable: [], anywhere: false }, cwd: project.sharedDir, tempDir: home, workspacePath: null, projectSharedDir: project.sharedDir, signal: new AbortController().signal });
  const mapAfter = await request(`${prefix}/material-map?conversationId=${a.id}`); assert.equal(mapAfter.materials.find((m: any) => m.recordId === 'lesson-root-cause').read, true); checks.materialMap = true;
  assert.deepEqual(await request(`${prefix}/index`), await request(`${prefix}/index`)); checks.index = true;
  const stale = await stage('active-current', 'active', '会话B的独立进展：没有覆盖A的旧原文。', 3, b.id);
  const preserved = await request(`${prefix}/preserved`); const keep = preserved.entries.find((e: any) => e.proposalId === stale.id); assert.ok(keep);
  const combined = `${keep.current.content}\n${keep.proposal.content}`;
  const merge = await request(`${prefix}/preserved/merge`, 'POST', { preservedIds: [keep.id], conversationId: a.id, recordId: 'active-current', title: '双方进展整合', content: combined, reason: '保留双方逐字内容', idempotencyKey: 'merge-review' }, 201);
  await accept(merge.id); assert.equal((await request(`${prefix}/preserved`)).entries.length, 0); checks.preserved = true;
  // Leave useful pending records for real UI operations, without any automatic generation.
  await stage('active-current', 'active', '另一条待审的B进展，尚未合并。', 0, b.id);
  await stage('ui-pending', 'active', '等待用户在看板接受或拒绝的记录。', 0, a.id, '待审界面演示');
  const foreign = await request(`/api/projects/${other.id}/memory`); assert.deepEqual(foreign.records, []);
  assert.equal(generationCalls, 3); assert.equal(primaryCalls, 2); assert.equal(compactionCalls, 1); assert.equal(maintenanceCalls, 0); checks.noUnrelatedGeneration = true;
  const report = { verifiedAt: new Date().toISOString(), baseURL: url, schema: SCHEMA_VERSION, projectId: project.id, conversationA: a.id, conversationB: b.id, checks, generationCalls, compactionCalls, automaticMaintenanceCalls: maintenanceCalls, primaryCalls, fixtureOnly: true };
  // ★ 报告默认写 docs/（证据留档）；门禁会把 ALKAID_VERIFY_REPORT_DIR 指到临时目录，
//   否则每跑一次门禁就刷新一次 `docs/验收-*.json` ⇒ 工作树永远是脏的。见 gate.mjs 的说明。
const reportPath = process.env['ALKAID_VERIFY_REPORT_DIR']
  ? resolve(process.env['ALKAID_VERIFY_REPORT_DIR'], '验收-记忆工作台-HTTP.json')
  : resolve('../docs/验收-记忆工作台-HTTP.json'); writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ready: true, ...report, reportPath }));
  if (!process.argv.includes('--serve')) await close();
} catch (error) { await close(); throw error; }
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
