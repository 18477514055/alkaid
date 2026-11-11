import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { EXECUTION_SCHEMA_SQL } from '../../src/core/memory/execution-schema.ts';
import { buildServer } from '../../src/server/app.ts';
import type { ExecutionBoard } from '../../src/shared/execution.ts';

async function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db); db.exec(EXECUTION_SCHEMA_SQL);
  insertProject(db, { id: 'execution-http', name: 'Project', sharedDir: 'unused' }); insertProject(db, { id: 'execution-other', name: 'Other', sharedDir: 'unused' });
  const p = insertProvider(db, { name: 'never-called', baseUrl: 'https://never-contact.invalid' });
  const a = insertConversation(db, { projectId: 'execution-http', providerId: p.id, model: 'offline', permissionMode: 'readonly' }).id;
  const peer = insertConversation(db, { projectId: 'execution-http', providerId: p.id, model: 'offline' }).id;
  const foreign = insertConversation(db, { projectId: 'execution-other', providerId: p.id, model: 'offline' }).id;
  const home = join(tmpdir(), `unused-execution-http-${randomUUID()}`);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ db, config: loadConfig({ ALKAID_HOME: home }) });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); db.close(); });
  const url = `/api/projects/execution-http/execution/${a}`;
  async function request<T = ExecutionBoard>(method: string, body?: unknown, path = url) {
    const response = await fetch(`${origin}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  return { db, a, peer, foreign, home, url, request };
}
const goal = { title: '用户指定本轮执行目标', status: 'active', summary: '' };
const tasks = [{ id: 'one', content: '开始核验真实HTTP', status: 'in_progress' }];

test('HTTP execution: initial GET is zero-write without invented goal, no model request or filesystem home', async t => {
  const f = await fixture(t); const before = f.db.prepare('SELECT total_changes() AS n').get()?.['n'];
  const empty = await f.request('GET'); assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { projectId: 'execution-http', conversationId: f.a, revision: 0, goal: null, tasks: [], events: [], updatedAt: null });
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.['n'], before);
  assert.equal((await f.request('GET')).body.revision, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM execution_boards').get()?.['n'], 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get()?.['n'], 0); assert.equal(existsSync(f.home), false);
});

test('HTTP execution: readonly FILE mode main conversation immediately updates goal/tasks/activity, independently from formal memory', async t => {
  const f = await fixture(t);
  const first = await f.request('PATCH', { baseRevision: 0, goal, tasks, activity: '已开始执行，尚未写正式记忆🙂' });
  assert.equal(first.status, 200); assert.equal(first.body.revision, 1);
  assert.equal(first.body.goal?.title, goal.title); assert.deepEqual(first.body.tasks, tasks); assert.equal(first.body.events[0]?.text, '已开始执行，尚未写正式记忆🙂');
  const second = await f.request('PATCH', { baseRevision: 1, goal: { ...goal, status: 'completed' }, tasks: [{ ...tasks[0], status: 'completed' }], activity: '当前任务完成' });
  assert.equal(second.status, 200); assert.equal(second.body.revision, 2); assert.equal(second.body.goal?.status, 'completed');
  const read = await f.request('GET'); assert.deepEqual(read.body, second.body);
  assert.equal(f.db.prepare('SELECT permission_mode FROM conversations WHERE id=?').get(f.a)?.['permission_mode'], 'readonly');
  for (const table of ['memory_records','memory_proposals','memory_jobs','memory_obligations','memory_obligation_events','messages']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n'], 0, table);
  assert.equal(existsSync(f.home), false);
});

test('HTTP execution: CAS and validation reject stale/empty/credential/duplicate inputs without changing current or history', async t => {
  const f = await fixture(t); assert.equal((await f.request('PATCH', { baseRevision: 0, goal })).status, 200);
  assert.equal((await f.request('PATCH', { baseRevision: 0, goal: null })).status, 409);
  for (const invalid of [{ baseRevision: 1 }, { goal }, { baseRevision: 1, activity: '' }, { baseRevision: 1, tasks: [tasks[0],tasks[0]] },
    { baseRevision: 1, goal: { ...goal, status: 'root' } }, { baseRevision: 1, activity: 'api_key=SYNTHETIC_CREDENTIAL_123456' },
    { baseRevision: 1, actor: 'model', activity: 'cannot choose actor' }]) {
    const bad = await f.request<{ error: string }>('PATCH', invalid); assert.equal(bad.status, 400); assert.doesNotMatch(bad.body.error, /SYNTHETIC_CREDENTIAL/);
  }
  assert.equal((await f.request('GET')).body.revision, 1); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM execution_events').get()?.['n'], 1);
  const clear = await f.request('PATCH', { baseRevision: 1, goal: null, tasks: [], activity: '用户明确清空执行板' });
  assert.equal(clear.status, 200); assert.equal(clear.body.goal, null); assert.deepEqual(clear.body.tasks, []);
});

test('HTTP execution: two main conversations never overwrite each other and cross-project IDs are scoped', async t => {
  const f = await fixture(t); assert.equal((await f.request('PATCH', { baseRevision: 0, goal })).status, 200);
  const peerUrl = `/api/projects/execution-http/execution/${f.peer}`;
  assert.equal((await f.request('GET', undefined, peerUrl)).body.revision, 0);
  const peer = await f.request('PATCH', { baseRevision: 0, goal: { ...goal, title: '另一个主对话的独立目标' } }, peerUrl);
  assert.equal(peer.status, 200); assert.equal(peer.body.conversationId, f.peer);
  assert.equal((await f.request('GET')).body.goal?.title, goal.title);
  assert.equal((await f.request('GET', undefined, `/api/projects/execution-other/execution/${f.a}`)).status, 404);
  assert.equal((await f.request('PATCH', { baseRevision: 0, goal }, `/api/projects/execution-http/execution/${f.foreign}`)).status, 404);
  assert.equal((await f.request('GET', undefined, `/api/projects/missing/execution/${f.a}`)).status, 404);
});

/**
 * ★★ 权限判据（用户 2026-11-10）：「子代理可以只读所有东西 —— 不能改除了自己的看板之外的任何东西」。
 *
 * 原来这条断言子代理 403。现在按**归属**判：子代理能读写自己那一行（这正是看板要显示的
 * "它的目标与任务"），但 HTTP 面能拿到的路径 id 就是它自己的会话 —— 它无法指到别处。
 * 后半段（历史只追加）原样保留：那条跟角色无关。
 */
test('HTTP execution: 子代理能读写自己的看板，历史仍然只追加不可改', async t => {
  const f = await fixture(t); assert.equal((await f.request('PATCH', { baseRevision: 0, goal })).status, 200);
  f.db.prepare("UPDATE conversations SET agent_role='subagent' WHERE id=?").run(f.a);
  // ① 读自己的板：正常（否则看板上什么都看不到）
  const readBySub = await f.request('GET'); assert.equal(readBySub.status, 200);
  assert.equal(readBySub.body.conversationId, f.a, '归属必须是它自己');
  // ② 写自己的板：正常
  const writeBySub = await f.request('PATCH', { baseRevision: 1, activity: 'subagent progress' });
  assert.equal(writeBySub.status, 200, '子代理写不了自己的进度 ⇒ 看板永远停在它开始前的样子');
  assert.equal(writeBySub.body.revision, 2);

  // ③ ★ 关键：它**指不到别人**。HTTP 路径的 conversationId 就是它自己；
  //    换一个 id 就是换一条路径 —— 那条路径按那个会话自己的归属解析，不会"代写"。
  f.db.prepare("UPDATE conversations SET agent_role='main' WHERE id=?").run(f.a);
  assert.equal((await f.request('GET')).body.revision, 2, '刚才那次写入确实落在它自己那一行');
  f.db.exec('PRAGMA recursive_triggers=OFF');
  const before = f.db.prepare('SELECT * FROM execution_events').all();
  for (const sql of ['DELETE FROM execution_events', 'UPDATE execution_events SET text=text', 'INSERT OR REPLACE INTO execution_events SELECT * FROM execution_events']) assert.throws(() => f.db.exec(sql), /append-only/);
  assert.deepEqual(f.db.prepare('SELECT * FROM execution_events').all(), before);
});
