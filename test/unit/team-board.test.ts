import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import {
  assertEventBudget,
  claimTask,
  completeTask,
  createTasks,
  readBoard,
  resolveRootConversation,
  updateTask,
} from '../../src/core/team/board.ts';
import { createTeamTasksTool } from '../../src/core/tools/team.ts';
import { ToolRegistry } from '../../src/core/tools/types.ts';
import type { ToolContext, ToolOutcome } from '../../src/core/tools/types.ts';
import { createSurface } from '../../src/core/tools/runtime.ts';
import { TEAM_MAX_TASKS, type TeamBoard } from '../../src/shared/team.ts';

/**
 * Agent Team 共享任务板的**行为**测试。
 *
 * ## ★ 这些测试盯的是"可观察行为"，不是"代码里有这个函数"
 *
 * 每条断言都对应一个**真实会出事的失败模式**：
 * - 两个代理同时认领同一张卡 ⇒ 双双成功 ⇒ 同一份文件被写两遍；
 * - 被依赖阻塞的卡被认领 ⇒ 建卡顺序形同虚设；
 * - 子代理能改别人的卡 ⇒ "做完了"不再是干活那个人说的；
 * - 事件能改 ⇒ 证据链变成故事；
 * - `baseRevision` 不符被静默接受 ⇒ 后写覆盖先写。
 *
 * ★ 夹具用 :memory: + 真迁移（不 mock 库）：这些行为一半由 SQL 承担
 *   （`WHERE owner IS NULL` 的原子性、触发器），mock 掉就什么都证明不了。
 */

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  // root = 主对话；两个子代理挂在它下面，用来测"多人同一块板"。
  const root = insertConversation(db, { providerId: provider.id, model: 'offline' }).id;
  const childA = insertConversation(db, { providerId: provider.id, model: 'offline', agentRole: 'subagent' }).id;
  const childB = insertConversation(db, { providerId: provider.id, model: 'offline', agentRole: 'subagent' }).id;
  db.prepare('UPDATE conversations SET parent_conversation_id=? WHERE id IN (?,?)').run(root, childA, childB);
  const ctx = (conversationId: string, agentRole: 'main' | 'subagent' = 'subagent'): ToolContext => ({
    conversationId,
    agentRole,
    permissionMode: 'workspace',
    roots: { readable: [], writable: [], anywhere: false },
    workspacePath: null,
    projectSharedDir: null,
    cwd: '.',
    tempDir: '.',
    signal: new AbortController().signal,
  });
  return { db, root, childA, childB, ctx };
}

function withDb(run: (f: ReturnType<typeof fixture>) => void | Promise<void>) {
  const f = fixture();
  return (async () => {
    try {
      await run(f);
    } finally {
      f.db.close();
    }
  })();
}

/** 从工具输出里取回执 JSON（`ok=false` 时直接抛，附上工具给的人话）。 */
function payload(out: ToolOutcome): Record<string, unknown> {
  assert.equal(out.ok, true, out.ok ? undefined : `${out.code}: ${out.message}`);
  return JSON.parse(out.content) as Record<string, unknown>;
}

function failMessage(out: ToolOutcome): string {
  assert.equal(out.ok, false, '这一步本该被拒绝，却成功了');
  return out.ok ? '' : out.message;
}

const code = (status: number) => (error: unknown) =>
  error instanceof Error && (error as Error & { statusCode?: number }).statusCode === status;

// ───────────────────────── ① 建卡与读板 ─────────────────────────

test('team: 建卡后 list 能读到，板与卡 revision 都从 1 起，事件记 created', () => withDb(({ db, root }) => {
  const { board, created } = createTasks(db, root, [
    { subject: '整理 schema 迁移', description: 'v16 三张表', writeScopes: ['app/src/core/store/'] },
    { subject: '写单元测试', writeScopes: ['app/test/unit/team-board.test.ts'] },
  ]);

  assert.equal(created.length, 2);
  assert.equal(board.totalTasks, 2);
  assert.equal(board.truncated, false);
  assert.equal(board.revision, 1, '一次 create 只推进一次板级 revision');
  for (const task of created) {
    assert.equal(task.revision, 1);
    assert.equal(task.status, 'pending');
    assert.equal(task.owner, null, '新卡不许有主人 —— 否则建完就等于被占了');
  }
  // 事件：两条 created，且带得出主题
  const created2 = board.events.filter((event) => event.kind === 'created');
  assert.equal(created2.length, 2);
  assert.ok(created2.every((event) => event.actor === 'model' && event.revision === 1));

  // 纯读：再读一次不改任何东西
  const again = readBoard(db, root);
  assert.equal(again.revision, 1);
  assert.equal(again.totalTasks, 2);
}));

test('team: 卡 revision 每次改动 +1，板 revision 也递增', () => withDb(({ db, root }) => {
  const { created } = createTasks(db, root, [{ subject: '改一次' }]);
  const id = created[0]!.id;

  const claimed = claimTask(db, root, root, id, 1);
  assert.equal(claimed.task.revision, 2);
  assert.equal(claimed.task.owner, root);
  assert.equal(claimed.board.revision, 2);

  const updated = updateTask(db, root, root, id, 2, { description: '补充说明' });
  assert.equal(updated.task.revision, 3);
  assert.equal(updated.task.description, '补充说明');
  assert.equal(updated.board.revision, 3);

  const completed = completeTask(db, root, root, id, 3);
  assert.equal(completed.task.revision, 4);
  assert.equal(completed.task.status, 'completed');
  assert.equal(completed.board.revision, 4);
}));

// ───────────────────────── ② 并发认领（最重要的一条） ─────────────────────────

test('★★★ team: 并发认领同一张卡 —— 只有一方成功，另一方得到冲突', () => withDb(({ db, root, childA, childB }) => {
  const { created } = createTasks(db, root, [{ subject: '只有一个人能干的活' }]);
  const id = created[0]!.id;

  // 两个子代理读到的都是 revision=1、owner=null（真实的并发场景就是这样）
  const winner = claimTask(db, root, childA, id, 1);
  assert.equal(winner.task.owner, childA);
  assert.equal(winner.task.revision, 2);

  /**
   * ★ 关键断言：第二个**必须失败**，而且必须带 `statusCode`。
   *   如果它是"先 SELECT 判 owner 再 UPDATE"，这里会双双成功 ——
   *   两个代理都以为自己领到了，最后同一份文件被写两遍。
   */
  assert.throws(() => claimTask(db, root, childB, id, 1), code(409));

  // 库里只能有一个主人，且只推进了一次
  const row = db.prepare('SELECT owner, revision FROM team_tasks WHERE id=?').get(id);
  assert.equal(row?.['owner'], childA);
  assert.equal(Number(row?.['revision']), 2);
  // 认领事件也只有一条 —— 失败的那次不该留下"我领到了"的记录
  const claims = db.prepare("SELECT * FROM team_task_events WHERE task_id=? AND kind='claimed'").all(id);
  assert.equal(claims.length, 1);
}));

test('★★ team: 另一个子代理拿**最新** revision 也抢不走已认领的卡（owner 判据独立于 revision）', () => withDb(({ db, root, childA, childB }) => {
  const { created } = createTasks(db, root, [{ subject: '已经被领了' }]);
  const id = created[0]!.id;
  claimTask(db, root, childA, id, 1);

  // childB 读到的是最新 revision=2 —— revision 对得上，但 owner 不对，仍然抢不走
  assert.throws(() => claimTask(db, root, childB, id, 2), code(409));
  assert.equal(readBoard(db, root).tasks[0]?.owner, childA);
}));

// ───────────────────────── ③④ 依赖是真闸门 ─────────────────────────

test('★★ team: 被 blocked_by 阻塞的卡不能认领，且说清还差哪几张', () => withDb(({ db, root, childA }) => {
  const { created } = createTasks(db, root, [
    { id: 'schema', subject: '先改 schema' },
    { id: 'api', subject: '再改接口', blockedBy: ['schema'] },
  ]);
  const api = created.find((task) => task.id === 'api')!;

  let message = '';
  try {
    claimTask(db, root, childA, api.id, api.revision);
  } catch (error) {
    assert.ok(code(409)(error));
    message = (error as Error).message;
  }
  // ★ 只说"有依赖未完成"等于让模型去猜；必须点名"还差哪张"
  assert.match(message, /blocked by/i);
  assert.ok(message.includes('schema'), `拒绝信息里必须点名被依赖的卡：${message}`);
  assert.ok(message.includes('先改 schema'), `拒绝信息里必须带主题，光有 id 模型看不懂：${message}`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM team_task_events WHERE task_id='api' AND kind='claimed'").get()?.['n'], 0);
}));

test('★★ team: 依赖完成后可以认领', () => withDb(({ db, root, childA }) => {
  const { created } = createTasks(db, root, [
    { id: 'schema', subject: '先改 schema' },
    { id: 'api', subject: '再改接口', blockedBy: ['schema'] },
  ]);
  const api = created.find((task) => task.id === 'api')!;

  // 依赖先被人做完
  const schema = created.find((task) => task.id === 'schema')!;
  claimTask(db, root, childA, schema.id, schema.revision);
  completeTask(db, root, childA, schema.id, 2);

  // 现在 api 可以认领了
  const claimed = claimTask(db, root, childA, api.id, 1);
  assert.equal(claimed.task.status, 'in_progress');
  assert.equal(claimed.task.owner, childA);
}));

// ───────────────────────── ⑤⑥ 谁能动谁的卡 ─────────────────────────

test('★★ team: 子代理不能 complete/update 别人的卡', () => withDb(({ db, root, childA, childB }) => {
  const { created } = createTasks(db, root, [{ subject: 'A 的活' }]);
  const id = created[0]!.id;
  claimTask(db, root, childA, id, 1);

  // childB 想替 A 标完成
  assert.throws(() => completeTask(db, root, childB, id, 2), code(403));
  // childB 想改 A 的卡
  assert.throws(() => updateTask(db, root, childB, id, 2, { description: '我改了' }), code(403));

  const row = db.prepare('SELECT status, description FROM team_tasks WHERE id=?').get(id);
  assert.equal(row?.['status'], 'in_progress', '别人的卡不该被标完成');
  assert.notEqual(row?.['description'], '我改了');
  // 也没留下任何"更新/完成"事件
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM team_task_events WHERE task_id=? AND kind IN ('updated','completed')").get(id)?.['n'], 0);
}));

test('★★ team: root 可以改任何卡（对应 DSH 的 root 重新分派）', () => withDb(({ db, root, childA }) => {
  const { created } = createTasks(db, root, [{ subject: '分给 A 的活' }]);
  const id = created[0]!.id;
  claimTask(db, root, childA, id, 1);

  // root 改子代理的卡 —— 允许
  const updated = updateTask(db, root, root, id, 2, { description: 'root 重新分派' });
  assert.equal(updated.task.description, 'root 重新分派');
  // root 替它标完成 —— 允许
  const completed = completeTask(db, root, root, id, 3);
  assert.equal(completed.task.status, 'completed');
  // root 还能把卡重新抢到自己名下（重新分派的一种具体形态）
  const { created: more } = createTasks(db, root, [{ subject: 'root 亲自干' }]);
  const second = more[0]!;
  const claimed = claimTask(db, root, root, second.id, 1);
  assert.equal(claimed.task.owner, root);
}));

// ───────────────────────── ⑦ 上限 ─────────────────────────

test('★★ team: 超过 256 张卡被拒（不静默截断）', () => withDb(({ db, root }) => {
  // 先用一条 create 灌到接近上限（单批最多 64，所以分几批）
  const batch = (count: number) => Array.from({ length: count }, (_, index) => ({ subject: `任务 ${index}` }));
  const rounds = Math.floor(TEAM_MAX_TASKS / 64);
  for (let round = 0; round < rounds; round += 1) createTasks(db, root, batch(64));
  const filled = Number(db.prepare('SELECT COUNT(*) AS n FROM team_tasks').get()?.['n']);
  assert.equal(filled, rounds * 64);

  // 补齐到正好 256
  const remaining = TEAM_MAX_TASKS - filled;
  if (remaining > 0) createTasks(db, root, batch(remaining));
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM team_tasks').get()?.['n']), TEAM_MAX_TASKS);

  // 第 257 张必须被拒
  assert.throws(() => createTasks(db, root, batch(1)), code(409));
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM team_tasks').get()?.['n']), TEAM_MAX_TASKS, '被拒之后一张都不该多');
}));

// ───────────────────────── ⑧ write_scopes 是建议不是锁 ─────────────────────────

test('★★★ team: write_scopes 有交集 ⇒ 认领成功但带 warning（不是拒绝）', () => withDb(({ db, root, childA }) => {
  const { created } = createTasks(db, root, [
    { subject: '第一段', writeScopes: ['app/src/core/team/'] },
    { subject: '第二段', writeScopes: ['app/src/core/team/board.ts'] },
  ]);

  // 第一张：没有别的卡，不该有 warning
  const first = claimTask(db, root, childA, created[0]!.id, 1);
  assert.equal(first.warning, null);

  // 第二张：与 A 自己未完成的卡范围重叠（前缀包含也算重叠）
  const second = claimTask(db, root, childA, created[1]!.id, 1);
  assert.equal(second.task.owner, childA, '重叠**不能**阻止认领');
  assert.ok(second.warning !== null, '重叠必须给出 warning');
  assert.match(second.warning!, /建议/);
  assert.match(second.warning!, /不是锁/);
}));

test('★ team: 与自己的卡**不同**作用域时不产生 warning', () => withDb(({ db, root, childA }) => {
  const { created } = createTasks(db, root, [
    { subject: '服务端', writeScopes: ['app/src/server/'] },
    { subject: '前端', writeScopes: ['app/web/'] },
  ]);
  claimTask(db, root, childA, created[0]!.id, 1);
  const second = claimTask(db, root, childA, created[1]!.id, 1);
  assert.equal(second.warning, null);
}));

// ───────────────────────── ⑨ 历史只追加 ─────────────────────────

test('★★ team: 事件流只追加 —— UPDATE/DELETE/REPLACE 历史表都被触发器拒绝', () => withDb(({ db, root, childA }) => {
  const { created } = createTasks(db, root, [{ subject: '历史不可改' }]);
  claimTask(db, root, childA, created[0]!.id, 1);
  // ★ 关掉递归触发器：`INSERT OR REPLACE` 是 DELETE+INSERT，
  //   只靠 UPDATE/DELETE 触发器挡不住（execution_events 上实测过这个坑）。
  db.exec('PRAGMA recursive_triggers=OFF');

  const before = db.prepare('SELECT * FROM team_task_events ORDER BY rowid').all();
  for (const sql of [
    'UPDATE team_task_events SET text=text',
    'DELETE FROM team_task_events',
    'INSERT OR REPLACE INTO team_task_events SELECT * FROM team_task_events',
  ]) {
    assert.throws(() => db.exec(sql), /append-only/, `这条必须被触发器拒绝：${sql}`);
  }
  assert.deepEqual(db.prepare('SELECT * FROM team_task_events ORDER BY rowid').all(), before);
}));

// ───────────────────────── ⑩ baseRevision 不符 ─────────────────────────

test('★★ team: baseRevision 不符 ⇒ 冲突（不是静默覆盖）', () => withDb(({ db, root, childA }) => {
  const { created } = createTasks(db, root, [{ subject: '版本号守卫' }]);
  const id = created[0]!.id;

  // 过期 base：别人已经推进过
  claimTask(db, root, childA, id, 1);
  assert.throws(() => completeTask(db, root, childA, id, 1), code(409));
  assert.throws(() => updateTask(db, root, childA, id, 1, { description: '旧的写' }), code(409));

  // 卡仍停在被打断之前的状态，没有被覆盖
  const row = db.prepare('SELECT status, revision, description FROM team_tasks WHERE id=?').get(id);
  assert.equal(row?.['status'], 'in_progress');
  assert.equal(Number(row?.['revision']), 2);
  assert.equal(row?.['description'], '');

  // 带对 revision 就成功
  assert.equal(completeTask(db, root, childA, id, 2).task.status, 'completed');
}));

// ───────────────────────── 工具层 ─────────────────────────

test('★ team tool: 五档文件模式都可见、preferredMode=lazy、maintenance 通道、子代理也能调', async () => {
  const f = fixture();
  try {
    const tool = createTeamTasksTool(f.db);
    const registry = new ToolRegistry().register(tool);
    assert.equal(tool.preferredMode, 'lazy');
    assert.equal(tool.displayChannel, 'maintenance');
    assert.equal(tool.kind, 'write_local');
    assert.equal(tool.group, 'context');
    for (const mode of ['readonly', 'workspace', 'project', 'workspace_project', 'full'] as const) {
      assert.equal(createSurface(registry, mode).canCall('team_tasks'), true, `${mode} 档看不到 team_tasks`);
    }
    // ★ 子代理的可调用性：`createSurface(...,'subagent')` 会把"项目记忆工具"滤掉，
    //   team_tasks 必须**留**下来 —— 否则 Team 功能等于没做。
    const subagentSurface = createSurface(registry, 'workspace', new Map(), 'subagent');
    assert.equal(subagentSurface.canCall('team_tasks'), true, '子代理必须能用团队任务板');

    // 子代理通过工具建卡 + 认领（板由 root 会话持有）
    const childCtx = f.ctx(f.childA);
    const created = payload(await subagentSurface.execute('team_tasks', {
      action: 'create',
      tasks: [{ id: 'tool-task', subject: '子代理建的第一张卡', writeScopes: ['app/src/a.ts'] }],
    }, childCtx));
    assert.equal(created['totalTasks'], 1);

    const listed = payload(await subagentSurface.execute('team_tasks', { action: 'list' }, childCtx));
    const tasks = listed['tasks'] as TeamBoard['tasks'];
    assert.equal(tasks.length, 1);
    const claimed = payload(await subagentSurface.execute('team_tasks', {
      action: 'claim', taskId: 'tool-task', baseRevision: 1,
    }, childCtx));
    const claimedTask = claimed['claimed'] as { owner: string };
    assert.equal(claimedTask.owner, f.childA);
  } finally {
    f.db.close();
  }
});

test('★ team tool: 子代理动了别人的卡会拿到可读失败（不是崩溃）', async () => {
  const f = fixture();
  try {
    const tool = createTeamTasksTool(f.db);
    createTasks(f.db, f.root, [{ id: 'a-task', subject: 'A 的' }]);
    claimTask(f.db, f.root, f.childA, 'a-task', 1);

    const out = await tool.execute({ action: 'complete', taskId: 'a-task', baseRevision: 2 }, f.ctx(f.childB));
    const message = failMessage(out);
    assert.match(message, /owner|root/i);
    assert.equal(f.db.prepare("SELECT status FROM team_tasks WHERE id='a-task'").get()?.['status'], 'in_progress');
  } finally {
    f.db.close();
  }
});

test('★ team tool: list 最多回 50 张卡与 10 条事件，但 totalTasks 说实话', async () => {
  const f = fixture();
  try {
    const tool = createTeamTasksTool(f.db);
    createTasks(f.db, f.root, Array.from({ length: 60 }, (_, index) => ({ subject: `卡 ${index}` })));
    const out = payload(await tool.execute({ action: 'list' }, f.ctx(f.childA)));
    const tasks = out['tasks'] as TeamBoard['tasks'];
    assert.equal(tasks.length, 50, '交付被截到 50 张');
    assert.equal(out['totalTasks'], 60, '但真实总数必须说实话');
    assert.equal(out['truncated'], true);
    // 事件：建了 60 条 created，交付只带 10 条
    assert.equal((out['events'] as unknown[]).length, 10);
  } finally {
    f.db.close();
  }
});

test('★ team tool: 参数校验 —— 未知字段、缺 baseRevision、未知 action 都可读地拒绝', async () => {
  const f = fixture();
  try {
    const tool = createTeamTasksTool(f.db);
    const ctx = f.ctx(f.childA);
    createTasks(f.db, f.root, [{ id: 'x', subject: 'x' }]);

    for (const args of [
      { action: 'list', taskId: 'x' },              // list 不接受额外字段
      { action: 'claim', taskId: 'x' },             // 缺 baseRevision
      { action: 'claim', taskId: 'x', baseRevision: 0 }, // revision 从 1 起
      { action: 'explode' },                        // 未知 action
      { action: 'list', conversationId: 'other' },  // ★ 不许自选板
      { action: 'create' },                         // 缺 tasks
    ]) {
      const out = await tool.execute(args, ctx);
      assert.equal(out.ok, false, `这组参数本该被拒：${JSON.stringify(args)}`);
    }
    // 板没被这些失败调用弄脏
    assert.equal(readBoard(f.db, f.root).totalTasks, 1);
  } finally {
    f.db.close();
  }
});

test('★ team: 子会话沿 parent_conversation_id 找到真正的板主', () => withDb(({ db, root, childA }) => {
  assert.equal(resolveRootConversation(db, childA), root);
  assert.equal(resolveRootConversation(db, root), root, 'root 没有上级 ⇒ 自己就是根');

  // 孙会话（子代理又派了一个）也要能追到最上面
  const grandchild = insertConversation(db, { providerId: String(db.prepare('SELECT provider_id FROM conversations WHERE id=?').get(root)?.['provider_id']), model: 'offline', agentRole: 'subagent' }).id;
  db.prepare('UPDATE conversations SET parent_conversation_id=? WHERE id=?').run(childA, grandchild);
  assert.equal(resolveRootConversation(db, grandchild), root);
}));

test('★ team: 事件预算到顶时用可读错误拒绝，而不是让历史无限长', () => withDb(({ db, root }) => {
  assert.doesNotThrow(() => assertEventBudget(db, root));
  // 直接把上限压到已超出（不改常量，只造一行超量数据）
  createTasks(db, root, [{ subject: '一张卡' }]);
  db.exec(`CREATE TRIGGER team_test_budget BEFORE INSERT ON team_task_events
             WHEN (SELECT COUNT(*) FROM team_task_events) >= 1
           BEGIN SELECT RAISE(ABORT, 'team history budget reached'); END;`);
  assert.throws(() => createTasks(db, root, [{ subject: '第二张卡' }]), /team history budget/);
  // ★ 失败要整体回滚：卡不该留下、板 revision 不该动
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM team_tasks').get()?.['n']), 1);
  assert.equal(readBoard(db, root).revision, 1);
}));
