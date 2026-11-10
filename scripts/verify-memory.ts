/** Isolated real HTTP + browser fixture. Never opens the user's application home or provider keys. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import fastifyStatic from '@fastify/static';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/core/store/db.ts';
import { migrate } from '../src/core/store/schema.ts';
import { insertProvider, insertConversation, listMessages, updateConversation } from '../src/core/store/repo.ts';
import { createProject } from '../src/core/project/service.ts';
import { setSecret } from '../src/core/secrets.ts';
import { getMemoryView, submitProposal } from '../src/core/memory/store.ts';
import { buildServer } from '../src/server/app.ts';

const home = mkdtempSync(join(tmpdir(), 'alkaid-memory-review-'));
let calls = 0; let primaryCalls = 0;
let releaseB!: () => void;
const pauseB = new Promise<void>(resolve => { releaseB = resolve; });
let startedB!: () => void;
const bStarted = new Promise<void>(resolve => { startedB = resolve; });
let bId = '';
const fake = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part;
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'offline-review-model' }] })); return; }
    const body = JSON.parse(raw);
    const maintenance = String(body.messages[0]?.content).startsWith('You maintain project memory');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (maintenance) {
      calls++;
      const material = JSON.parse(body.messages[1].content);
      assert.equal(material.proposals.length, 2);
      assert.equal(body.max_completion_tokens ?? body.max_tokens, 4096);
      const decision = { recordId: 'active-current', proposalIds: material.proposals.map((p: { id: string }) => p.id), action: 'upsert', kind: 'active', title: '双会话工作进展', content: '会话 A：接口核查完成。\n会话 B：回归验证完成。', reason: '本地HTTP假模型合并两项互补事实' };
      frame({ content: JSON.stringify({ decisions: [decision] }) });
    } else {
      primaryCalls++;
      const last = body.messages.at(-1);
      if (last.role === 'tool') frame({ content: '业务结果：本轮核查已完成。' });
      else {
        const fromB = req.headers['x-review-session'] === bId;
        if (fromB) { startedB(); await pauseB; }
        frame({ content: 'MAINTENANCE_ONLY_DO_NOT_SHOW' });
        frame({ tool_calls: [{ index: 0, id: `stage-${fromB ? 'b' : 'a'}`, type: 'function', function: { name: 'memory_propose', arguments: JSON.stringify({ recordId: 'active-current', kind: 'active', title: '双会话工作进展', operation: 'upsert', content: fromB ? '会话 B：回归验证完成。' : '会话 A：接口核查完成。', baseRevision: 0, reason: '隔离HTTP验收，不含用户真实资料', idempotencyKey: fromB ? 'review-b' : 'review-a' }) } }] });
      }
    }
    const toolFinish = !maintenance && body.messages.at(-1).role !== 'tool';
    frame({}, toolFinish ? 'tool_calls' : 'stop');
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 60 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch { res.destroy(); }
});
await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
const address = fake.address(); if (!address || typeof address === 'string') throw new Error('fake bind failed');
const config = { ...loadConfig(), home, dbPath: join(home, 'alkaid.db'), secretsPath: join(home, 'secrets.json'), projectsDir: join(home, 'projects'), logsDir: join(home, 'logs') };
mkdirSync(config.projectsDir, { recursive: true });
const db = openDatabase(config.dbPath); migrate(db);
const provider = insertProvider(db, { name: '隔离本地模型（不计费）', baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: 'offline-review-model', sessionHeader: 'x-review-session' });
setSecret(config.secretsPath, provider.id, 'test-only-not-a-real-key');
const project = createProject(db, config, { name: '台账集成 · 隔离验收' });
const a = insertConversation(db, { title: '验收 A · 接口', providerId: provider.id, model: 'offline-review-model', projectId: project.id, permissionMode: 'project' });
const b = insertConversation(db, { title: '验收 B · 测试', providerId: provider.id, model: 'offline-review-model', projectId: project.id, permissionMode: 'project' }); bId = b.id;
const solo = insertConversation(db, { title: '未绑定项目', providerId: provider.id, model: 'offline-review-model' });
const app = buildServer({ config, db });
await app.register(fastifyStatic, { root: resolve('dist/web'), prefix: '/' });
app.get('/__verify/status', async () => ({ maintenanceCalls: calls, primaryCalls, projectId: project.id, conversationA: a.id, conversationB: b.id, solo: solo.id }));
const baseURL = await app.listen({ host: '127.0.0.1', port: 0 });
async function json(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseURL}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `HTTP ${response.status}: ${path}`); return response.json();
}
async function turn(id: string) {
  const response = await fetch(`${baseURL}/api/conversations/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '完成核查并保存有依据的进展。' }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const frames = text.split('\n\n').filter(p => p.startsWith('data: ')).map(p => JSON.parse(p.slice(6)));
  assert.equal(frames.filter(p => p.type === 'text').map(p => p.delta).join(''), '业务结果：本轮核查已完成。');
  assert.equal(frames.some(p => p.type === 'text' && p.delta.includes('MAINTENANCE_ONLY')), false);
}
await json(`/api/projects/${project.id}/memory/config`, 'PATCH', { enabled: true, providerId: provider.id, model: 'offline-review-model', quietMs: 1000 });
await turn(a.id); await delay(1200); assert.equal(calls, 0);
for (let i = 0; i < 3; i++) await json(`/api/projects/${project.id}/memory`);
assert.equal(calls, 0);
const bTurn = turn(b.id); await bStarted; await delay(1200); assert.equal(calls, 0);
assert.equal((await json(`/api/conversations/${b.id}`)).state, 'running');
for (const [method, path, payload] of [
  ['POST', `/api/conversations/${b.id}/messages`, { content: 'duplicate while active' }],
  ['PATCH', `/api/conversations/${b.id}`, { projectId: null }],
  ['DELETE', `/api/conversations/${b.id}`, undefined],
] as const) {
  const blocked = await fetch(`${baseURL}${path}`, { method, ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) });
  assert.equal(blocked.status, 409, `active turn guard ${method}`);
}
releaseB(); await bTurn;
assert.equal(calls, 0, 'quiet gate must not fire immediately after turn end');
await delay(1400);
const merged = getMemoryView(db, project.id);
assert.equal(calls, 1); assert.equal(merged.records.length, 1); assert.equal(merged.proposals.filter(p => p.status === 'applied').length, 2);
assert.match(merged.records[0]!.content, /会话 A/); assert.match(merged.records[0]!.content, /会话 B/);
assert.equal(listMessages(db, a.id).filter(m => m.displayChannel === 'maintenance').length, 2);
await json(`/api/conversations/${a.id}/prompt`); await json(`/api/conversations/${b.id}/dashboard`); await delay(1200); assert.equal(calls, 1);
// One pending author is left deliberately for before/after UI verification; no AI request.
submitProposal(db, { conversationId: a.id, recordId: 'active-current', kind: 'active', title: '双会话工作进展', operation: 'upsert', content: '下一步：等待人工确认的新提案（尚未生效）。', baseRevision: merged.records[0]!.revision, reason: '展示暂存与正式记录分离，不自动覆盖', idempotencyKey: 'review-pending-ui' });
const evidence = { verifiedAt: new Date().toISOString(), baseURL, projectId: project.id, conversationA: a.id, conversationB: b.id, maintenanceCalls: calls, primaryCalls,
  checks: ['single-author: 0 generation requests', 'project busy: 0 generation requests', 'quiet interval: not immediate', 'two idle authors: 1 generation request', 'GETs do not request generation', 'repeated idle does not repeat generation', 'official merge includes both sources', 'maintenance deltas absent from chat SSE', 'maintenance tool history retained', 'single-author UI draft is not official'],
  fixtureHome: home, note: 'All traffic is loopback fake model. No real credentials, real providers or existing project memory read.' };
const out = resolve('../docs/验收-项目记忆-隔离.json');
const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
writeFileSync(out, JSON.stringify({ ...evidence, ...(previous.browserVerification ? { browserVerification: previous.browserVerification } : {}) }, null, 2), 'utf8');
console.log(JSON.stringify({ ready: true, ...evidence, evidence: out }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await app.close(); await new Promise<void>(r => fake.close(() => r())); db.close();
  if (!resolve(home).startsWith(resolve(tmpdir(), 'alkaid-memory-review-'))) throw new Error('Unexpected fixture cleanup target');
  rmSync(home, { recursive: true, force: true }); process.exit(0);
}
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
if (process.argv.includes('--once')) await close();
