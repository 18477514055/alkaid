import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { EXECUTION_SCHEMA_SQL } from '../../src/core/memory/execution-schema.ts';
import { readExecutionBoard, updateExecutionBoard } from '../../src/core/memory/execution.ts';
import { createExecutionBoardTool } from '../../src/core/tools/execution.ts';
import { ToolRegistry } from '../../src/core/tools/types.ts';
import type { ToolContext, ToolOutcome } from '../../src/core/tools/types.ts';
import { createSurface } from '../../src/core/tools/runtime.ts';
import type { ExecutionBoard, UpdateExecutionBoard } from '../../src/shared/execution.ts';

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db); db.exec(EXECUTION_SCHEMA_SQL);
  insertProject(db, { id: 'execute-a', name: 'A', sharedDir: 'unused' }); insertProject(db, { id: 'execute-b', name: 'B', sharedDir: 'unused' });
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  const a = insertConversation(db, { projectId: 'execute-a', providerId: provider.id, model: 'offline' }).id;
  const peer = insertConversation(db, { projectId: 'execute-a', providerId: provider.id, model: 'offline' }).id;
  const other = insertConversation(db, { projectId: 'execute-b', providerId: provider.id, model: 'offline' }).id;
  const ctx: ToolContext = { conversationId: a, permissionMode: 'readonly', roots: { readable: [], writable: [], anywhere: false }, workspacePath: null, projectSharedDir: null, cwd: '.', tempDir: '.', signal: new AbortController().signal, turnUserSeq: 1 };
  return { db, a, peer, other, ctx };
}
function withDb(run: (f: ReturnType<typeof fixture>) => void) { const f = fixture(); try { run(f); } finally { f.db.close(); } }
const active = { title: 'User-confirmed current goal', status: 'active' as const, summary: '' };
const tasks = [{ id: 'verify', content: 'Run focused tests', status: 'in_progress' as const }];
const code = (status: number) => (e: unknown) => e instanceof Error && (e as Error & { statusCode?: number }).statusCode === status;
function board(out: ToolOutcome): ExecutionBoard { assert.equal(out.ok, true, out.ok ? undefined : out.message); return JSON.parse(out.ok ? out.content : '{}') as ExecutionBoard; }

test('execution: empty GET is pure, has no invented goal and never creates formal memory or obligations', () => withDb(({ db, a }) => {
  const before = db.prepare('SELECT total_changes() AS n').get()?.['n'];
  assert.deepEqual(readExecutionBoard(db, 'execute-a', a), { projectId: 'execute-a', conversationId: a, revision: 0, goal: null, tasks: [], events: [], updatedAt: null });
  assert.equal(db.prepare('SELECT total_changes() AS n').get()?.['n'], before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_boards').get()?.['n'], 0);
  updateExecutionBoard(db, 'execute-a', a, { baseRevision: 0, activity: 'User requested inspection; no execution goal chosen yet.' }, 'model');
  assert.equal(readExecutionBoard(db, 'execute-a', a).goal, null);
  for (const table of ['memory_records','memory_proposals','memory_obligations','memory_obligation_events']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n'], 0);
}));

test('execution: user/model goal/task/activity updates CAS with immutable before/after history and no cross-conversation overwrite', () => withDb(({ db, a, peer, other }) => {
  const first = updateExecutionBoard(db, 'execute-a', a, { baseRevision: 0, goal: active, tasks, activity: '验证开始🙂\n保留原文' }, 'model');
  assert.equal(first.revision, 1); assert.equal(first.events[0]?.kind, 'update'); assert.equal(first.events[0]?.text, '验证开始🙂\n保留原文');
  const second = updateExecutionBoard(db, 'execute-a', a, { baseRevision: 1, goal: { ...active, status: 'paused' } }, 'user');
  assert.equal(second.revision, 2); assert.equal(second.goal?.status, 'paused'); assert.deepEqual(second.tasks, tasks);
  updateExecutionBoard(db, 'execute-a', peer, { baseRevision: 0, goal: { ...active, title: 'Peer independent goal' } }, 'user');
  assert.equal(readExecutionBoard(db, 'execute-a', a).goal?.title, active.title); assert.equal(readExecutionBoard(db, 'execute-a', peer).revision, 1);
  assert.equal(readExecutionBoard(db, 'execute-b', other).revision, 0);
  assert.throws(() => readExecutionBoard(db, 'execute-b', a), code(404));
  assert.throws(() => updateExecutionBoard(db, 'execute-a', a, { baseRevision: 1, activity: 'stale overwrite' }, 'user'), code(409));
  const history = db.prepare('SELECT * FROM execution_events WHERE conversation_id=? ORDER BY revision').all(a);
  assert.equal(history.length, 2); assert.equal(history[0]?.['actor'], 'model'); assert.equal(history[1]?.['actor'], 'user');
  assert.equal(JSON.parse(history[1]?.['before_json'] as string).goal.status, 'active'); assert.equal(JSON.parse(history[1]?.['after_json'] as string).goal.status, 'paused');
  const final = updateExecutionBoard(db, 'execute-a', a, { baseRevision: 2, goal: null, tasks: [] }, 'user');
  assert.equal(final.goal, null); assert.deepEqual(final.tasks, []); assert.equal(final.revision, 3);
}));

test('execution: statuses, duplicate task IDs, unknown fields, empty updates, bounds and credentials are validated', () => withDb(({ db, a }) => {
  const invalid: unknown[] = [null, [], {}, { baseRevision: 0 }, { baseRevision: -1, goal: active }, { baseRevision: .5, goal: active },
    { baseRevision: 0, goal: { ...active, status: 'root' } }, { baseRevision: 0, goal: { ...active, title: '' } }, { baseRevision: 0, goal: { ...active, title: 'a'.repeat(201) } },
    { baseRevision: 0, goal: { ...active, summary: 'a'.repeat(2001) } }, { baseRevision: 0, tasks: [tasks[0],tasks[0]] },
    { baseRevision: 0, tasks: [{ ...tasks[0], status: 'done' }] }, { baseRevision: 0, tasks: Array.from({ length: 51 }, (_, i) => ({ id: `${i}`, content: 'Task', status: 'pending' })) },
    { baseRevision: 0, tasks: [{ ...tasks[0], content: 'a'.repeat(501) }] }, { baseRevision: 0, activity: '' }, { baseRevision: 0, activity: 'a'.repeat(501) },
    { baseRevision: 0, activity: 'Bearer SYNTHETIC_CREDENTIAL_123456789' }, { baseRevision: 0, goal: { ...active, summary: 'api_key=SYNTHETIC_KEY_123456' } },
    { baseRevision: 0, activity: 'valid', projectId: 'execute-b' }, { baseRevision: 0, goal: undefined }, { baseRevision: 0, tasks: undefined }];
  for (const input of invalid) assert.throws(() => updateExecutionBoard(db, 'execute-a', a, input as UpdateExecutionBoard, 'user'), code(400));
  assert.equal(readExecutionBoard(db, 'execute-a', a).revision, 0);
  assert.throws(() => updateExecutionBoard(db, 'execute-a', a, { baseRevision: 0, goal: active }, 'subagent' as 'user'), code(400));
}));

test('execution: history is append-only including REPLACE with recursive triggers disabled', () => withDb(({ db, a }) => {
  updateExecutionBoard(db, 'execute-a', a, { baseRevision: 0, goal: active }, 'user'); db.exec('PRAGMA recursive_triggers=OFF');
  const before = db.prepare('SELECT * FROM execution_events').all();
  for (const sql of ['UPDATE execution_events SET text=text', 'DELETE FROM execution_events', 'INSERT OR REPLACE INTO execution_events SELECT * FROM execution_events']) assert.throws(() => db.exec(sql), /append-only/);
  assert.deepEqual(db.prepare('SELECT * FROM execution_events').all(), before);
}));

test('execution: event failure rolls back current board insert/update and CAS revision atomically', () => withDb(({ db, a }) => {
  db.exec("CREATE TRIGGER execution_test_fail BEFORE INSERT ON execution_events WHEN NEW.kind='tasks' BEGIN SELECT RAISE(ABORT,'injected execution history failure'); END;");
  assert.throws(() => updateExecutionBoard(db, 'execute-a', a, { baseRevision: 0, tasks }, 'user'), /injected execution/);
  assert.equal(readExecutionBoard(db, 'execute-a', a).revision, 0);
  updateExecutionBoard(db, 'execute-a', a, { baseRevision: 0, goal: active }, 'user');
  assert.throws(() => updateExecutionBoard(db, 'execute-a', a, { baseRevision: 1, tasks }, 'model'), /injected execution/);
  assert.equal(readExecutionBoard(db, 'execute-a', a).revision, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_events').get()?.['n'], 1);
}));

/**
 * ★★ 权限判据（用户 2026-11-10 明确定下）：
 *   「子代理可以只读所有东西 —— 不能改除了自己的看板之外的任何东西」
 *
 * 这条测试原来断言的是**旧的**「子代理一律 403」。现在改成按**所有权**判：
 * 子代理能读能写**自己那一行**，但它没有别的会话 id ⇒ 天然碰不到别人的板。
 * ⇒ 这里要证明的是两件事：
 * ① 它自己的板能正常读写（否则看板上看不到它的进度，那正是用户要的东西）；
 * ② 它**无法**用任何参数指到别处 —— 工具不接受 conversationId / projectId 参数，
 *    `binding()` 也只按"这个会话自己属于谁"解析。
 */
test('execution: 子代理能读写**自己**的看板（不能碰别人的），归档项目仍然拒写', () => withDb(({ db, a, other }) => {
  db.prepare("UPDATE conversations SET agent_role='subagent' WHERE id=?").run(a);
  // ① 自己的板：能读、能写
  assert.equal(readExecutionBoard(db, 'execute-a', a).revision, 0);
  const written = updateExecutionBoard(db, 'execute-a', a, { baseRevision: 0, goal: active }, 'user');
  assert.equal(written.revision, 1, '子代理写不了自己的看板 ⇒ 看板上看不到它的进度');
  assert.equal(written.conversationId, a, '写完之后归属必须是它自己');

  // ② 别人的板：换一个不存在的会话 id ⇒ 必须读不到（不是静默给一个空板）
  assert.throws(() => readExecutionBoard(db, 'execute-a', other), code(404), '"别人的看板"必须读不到');

  db.prepare("UPDATE conversations SET agent_role='main' WHERE id=?").run(a);
  db.prepare("UPDATE projects SET archived_at=? WHERE id='execute-a'").run(new Date().toISOString());
  assert.equal(readExecutionBoard(db, 'execute-a', a).revision, 1, '归档只挡写，不挡读');
  assert.throws(() => updateExecutionBoard(db, 'execute-a', a, { baseRevision: 1, goal: active }, 'user'), code(409));
}));

test('execution: service returns recent events only while every original snapshot stays stored', () => withDb(({ db, a }) => {
  for (let i = 0; i < 35; i++) updateExecutionBoard(db, 'execute-a', a, { baseRevision: i, activity: `Activity ${i}` }, 'user');
  const out = readExecutionBoard(db, 'execute-a', a);
  assert.equal(out.events.length, 30); assert.equal(out.events[0]?.text, 'Activity 34');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_events').get()?.['n'], 35);
  assert.equal(db.prepare('SELECT text FROM execution_events WHERE revision=1').get()?.['text'], 'Activity 0');
}));

test('execution tool: resident maintenance is callable in all FIVE file modes and does not alter formal memory', async () => {
  const f = fixture(); try {
    const tool = createExecutionBoardTool(f.db), registry = new ToolRegistry(); registry.register(tool);
    assert.equal(tool.preferredMode, 'resident'); assert.equal(tool.displayChannel, 'maintenance');
    let revision = 0;
    for (const mode of ['readonly','workspace','project','workspace_project','full'] as const) {
      assert.equal(createSurface(registry, mode).canCall('execution_board'), true);
      const ctx = { ...f.ctx, permissionMode: mode, turnUserSeq: revision + 1 };
      assert.equal(board(await tool.execute({ action: 'read' }, ctx)).revision, revision);
      const saved = board(await tool.execute({ action: 'update', baseRevision: revision, goal: active, activity: `Update under ${mode}` }, ctx));
      assert.equal(saved.revision, ++revision);
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get()?.['n'], 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_obligation_events').get()?.['n'], 0);
  } finally { f.db.close(); }
});

test('execution tool: model must read in current conversation/turn before every update and reread after user CAS conflict', async () => {
  const f = fixture(); try {
    const tool = createExecutionBoardTool(f.db);
    assert.equal((await tool.execute({ action: 'update', baseRevision: 0, goal: active }, f.ctx)).ok, false);
    board(await tool.execute({ action: 'read' }, f.ctx));
    const nextTurn = { ...f.ctx, turnUserSeq: 2 };
    assert.equal((await tool.execute({ action: 'update', baseRevision: 0, goal: active }, nextTurn)).ok, false);
    assert.equal(board(await tool.execute({ action: 'update', baseRevision: 0, goal: active }, f.ctx)).revision, 1);
    assert.equal((await tool.execute({ action: 'update', baseRevision: 1, activity: 'Without read' }, f.ctx)).ok, false);
    board(await tool.execute({ action: 'read' }, f.ctx));
    updateExecutionBoard(f.db, 'execute-a', f.a, { baseRevision: 1, goal: { ...active, status: 'completed' } }, 'user');
    const stale = await tool.execute({ action: 'update', baseRevision: 1, activity: 'Old model base' }, f.ctx);
    assert.equal(stale.ok, false); if (!stale.ok) assert.match(stale.message, /revision changed/);
    assert.equal((await tool.execute({ action: 'update', baseRevision: 2, activity: 'No fresh read' }, f.ctx)).ok, false);
    assert.equal(board(await tool.execute({ action: 'read' }, f.ctx)).revision, 2);
    assert.equal(board(await tool.execute({ action: 'update', baseRevision: 2, activity: 'Read fresh user goal' }, f.ctx)).revision, 3);
  } finally { f.db.close(); }
});

/**
 * ★★ 权限判据（用户 2026-11-10）：「子代理可以只读所有东西 —— 不能改除了自己的看板之外的任何东西」。
 *
 * 这条原来断言"子代理一律被拒"。现在改成按**归属**判，要同时钉住两半：
 * - 子代理**能**操作自己那一行（否则它的目标/任务永远不会出现在看板上）；
 * - 它**不能**指到别处 —— `conversationId` / `projectId` 参数一律不被接受，
 *   所以它连"点名要改别人的板"这条路都没有。
 */
test('execution tool: 子代理能读写自己的板，但不能用参数指到别的会话/项目', async () => {
  const f = fixture(); try {
    const tool = createExecutionBoardTool(f.db);

    // ① 运行时角色是 subagent ⇒ **照常可用**（它写的永远是 ctx.conversationId 那一行）
    const sub = { ...f.ctx, agentRole: 'subagent' as const };
    const readBySub = await tool.execute({ action: 'read' }, sub);
    assert.equal(readBySub.ok, true, '子代理读不了自己的板 ⇒ 看板里看不到它的进度');
    const written = board(await tool.execute({ action: 'update', baseRevision: 0, goal: active }, sub));
    assert.equal(written.conversationId, f.a, '归属必须是它自己');
    assert.equal(written.revision, 1);

    // ② 库里 agent_role=subagent 也一样可用（运行时标记不是唯一判据）
    f.db.prepare("UPDATE conversations SET agent_role='subagent' WHERE id=?").run(f.a);
    assert.equal((await tool.execute({ action: 'read' }, f.ctx)).ok, true);
    f.db.prepare("UPDATE conversations SET agent_role='main' WHERE id=?").run(f.a);

    // ③ ★ 关键：**不接受**指定别人 —— 参数里塞 conversationId / projectId 一律被拒
    assert.equal((await tool.execute({ action: 'read', conversationId: f.peer }, f.ctx)).ok, false);
    assert.equal(
      (await tool.execute({ action: 'update', baseRevision: 1, projectId: 'execute-b', goal: active }, f.ctx)).ok,
      false,
    );
    // ④ 别人的板一个字节都没被碰
    assert.equal(readExecutionBoard(f.db, 'execute-a', f.peer).revision, 0);
  } finally { f.db.close(); }
});
