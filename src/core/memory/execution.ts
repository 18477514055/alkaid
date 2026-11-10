import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { containsCredentials } from './context.ts';
import { EXECUTION_GOAL_STATUSES, EXECUTION_TASK_STATUSES } from '../../shared/execution.ts';
import type { ExecutionBoard, ExecutionEvent, ExecutionGoal, ExecutionTask, UpdateExecutionBoard } from '../../shared/execution.ts';

function fail(statusCode: 400 | 403 | 404 | 409, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function text(value: unknown, field: string, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(400, `Invalid execution ${field}`);
  if (containsCredentials(value)) fail(400, 'Execution state must not contain credentials');
}
function shape(value: unknown, fields: string[], required: string[] = fields): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail(400, 'Invalid execution fields');
}
/**
 * 无项目作用域的 projectId 哨兵。
 * ★ 执行看板本质是「某个主对话的当前工作状态」，与项目无关（用户 2026-11-09 要求
 *   没有项目的对话右侧也要显示能用的功能）。表上 `project_id` 是 `TEXT NOT NULL` 且无外键，
 *   空串不会撞上任何真实项目 id。**不要**改成 NULL：那会让唯一约束失效
 *   （SQLite 里 NULL 互不相等，同一会话能插出无数行）。
 */
export const NO_PROJECT_SCOPE = '';

function binding(db: DatabaseSync, projectId: string, conversationId: string, write = false): void {
  text(conversationId, 'conversationId', 200);
  /**
   * 无项目作用域：不查 projects 表（空串不是项目），改为**要求该会话确实没有项目**。
   * 这一条是必须的 —— 否则可以把"无项目看板"挂到一个有项目的会话上，
   * 于是同一个会话出现两份看板，谁也说不清哪份是正式状态。
   */
  if (projectId === NO_PROJECT_SCOPE) {
    const conversation = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
    if (!conversation) fail(404, 'Conversation not found');
    if (conversation['project_id'] !== null) fail(409, 'This conversation belongs to a project; use the project execution board');
    return;
  }
  text(projectId, 'projectId', 200);
  const project = db.prepare('SELECT archived_at FROM projects WHERE id=?').get(projectId);
  if (!project) fail(404, 'Project not found');
  const conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND project_id=?').get(conversationId, projectId);
  if (!conversation) fail(404, 'Main conversation not found in project');
  if (write && project['archived_at'] !== null) fail(409, 'Project is archived');
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  const nested = db.isTransaction, point = `execution_${randomUUID().replaceAll('-', '')}`;
  db.exec(nested ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
  try { const result = work(); db.exec(nested ? `RELEASE ${point}` : 'COMMIT'); return result; }
  catch (error) { if (nested) { db.exec(`ROLLBACK TO ${point}`); db.exec(`RELEASE ${point}`); } else db.exec('ROLLBACK'); throw error; }
}
function validate(input: unknown): asserts input is UpdateExecutionBoard {
  shape(input, ['baseRevision','goal','tasks','activity'], ['baseRevision']);
  if (!Number.isSafeInteger(input['baseRevision']) || Number(input['baseRevision']) < 0) fail(400, 'Invalid execution baseRevision');
  if (!['goal','tasks','activity'].some(k => Object.hasOwn(input, k))) fail(400, 'Execution update must change a goal, tasks or activity');
  if (Object.hasOwn(input, 'goal') && input['goal'] !== null) {
    shape(input['goal'], ['title','status','summary']);
    text(input['goal']['title'], 'goal title', 200);
    text(input['goal']['summary'], 'goal summary', 2000, true);
    if (!(EXECUTION_GOAL_STATUSES as readonly unknown[]).includes(input['goal']['status'])) fail(400, 'Invalid execution goal status');
  }
  if (Object.hasOwn(input, 'tasks')) {
    if (!Array.isArray(input['tasks']) || input['tasks'].length > 50) fail(400, 'Execution tasks must contain at most 50 entries');
    const ids = new Set<string>();
    for (const task of input['tasks']) {
      shape(task, ['id','content','status']); text(task['id'], 'task id', 100); text(task['content'], 'task content', 500);
      if (ids.has(task['id'])) fail(400, 'Duplicate execution task id'); ids.add(task['id']);
      if (!(EXECUTION_TASK_STATUSES as readonly unknown[]).includes(task['status'])) fail(400, 'Invalid execution task status');
    }
  }
  if (Object.hasOwn(input, 'activity')) text(input['activity'], 'activity', 500);
}
/** Pure local read. An empty board is not persisted and is not a model-invented goal. */
export function readExecutionBoard(db: DatabaseSync, projectId: string, conversationId: string): ExecutionBoard {
  binding(db, projectId, conversationId);
  const saved = db.prepare('SELECT * FROM execution_boards WHERE project_id=? AND conversation_id=?').get(projectId, conversationId);
  if (!saved) return { projectId, conversationId, revision: 0, goal: null, tasks: [], events: [], updatedAt: null };
  const state = JSON.parse(String(saved['state_json'])) as { goal: ExecutionGoal | null; tasks: ExecutionTask[] };
  const events = db.prepare('SELECT id,kind,text,created_at FROM execution_events WHERE project_id=? AND conversation_id=? ORDER BY revision DESC LIMIT 30').all(projectId, conversationId)
    .map(e => ({ id: String(e['id']), kind: e['kind'] as ExecutionEvent['kind'], text: String(e['text']), createdAt: String(e['created_at']) }));
  return { projectId, conversationId, revision: Number(saved['revision']), ...state, events, updatedAt: String(saved['updated_at']) };
}
/** Runtime execution state only: no proposal, goal-tree, obligation, memory record, or model request. */
export function updateExecutionBoard(db: DatabaseSync, projectId: string, conversationId: string, input: UpdateExecutionBoard, actor: 'model' | 'user'): ExecutionBoard {
  validate(input);
  if (actor !== 'model' && actor !== 'user') fail(400, 'Invalid execution actor');
  return transaction(db, () => {
    binding(db, projectId, conversationId, true);
    const before = readExecutionBoard(db, projectId, conversationId);
    if (before.revision !== input.baseRevision) fail(409, 'Execution board revision changed; read the board before updating');
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM execution_events WHERE project_id=? AND conversation_id=?').get(projectId, conversationId)?.['n']);
    if (count >= 2000) fail(409, 'Execution history limit reached; existing history is preserved');
    const projectCount = Number(db.prepare('SELECT COUNT(*) AS n FROM execution_events WHERE project_id=?').get(projectId)?.['n']);
    if (projectCount >= 20_000) fail(409, 'Project execution history limit reached; existing history is preserved');
    const state = { goal: Object.hasOwn(input, 'goal') ? input.goal! : before.goal, tasks: Object.hasOwn(input, 'tasks') ? input.tasks! : before.tasks };
    const afterJson = JSON.stringify(state), beforeJson = JSON.stringify({ goal: before.goal, tasks: before.tasks });
    if (afterJson.length > 40_000) fail(400, 'Execution state size limit exceeded');
    const revision = before.revision + 1, createdAt = new Date().toISOString();
    const goal = Object.hasOwn(input, 'goal'), tasks = Object.hasOwn(input, 'tasks'), activity = Object.hasOwn(input, 'activity');
    const fields = Number(goal) + Number(tasks) + Number(activity);
    const kind: ExecutionEvent['kind'] = fields > 1 ? 'update' : goal ? 'goal' : tasks ? 'tasks' : 'activity';
    const message = input.activity ?? (goal && tasks ? '更新当前执行目标与任务' : goal ? input.goal === null ? '清除当前执行目标' : '更新当前执行目标' : '更新当前执行任务');
    if (before.revision === 0) db.prepare('INSERT INTO execution_boards VALUES(?,?,?,?,?)').run(projectId, conversationId, revision, afterJson, createdAt);
    else {
      const result = db.prepare('UPDATE execution_boards SET revision=?,state_json=?,updated_at=? WHERE project_id=? AND conversation_id=? AND revision=?')
        .run(revision, afterJson, createdAt, projectId, conversationId, input.baseRevision);
      if (Number(result.changes) !== 1) fail(409, 'Execution board revision changed');
    }
    db.prepare('INSERT INTO execution_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), projectId, conversationId, revision, actor, kind, message, beforeJson, afterJson, createdAt);
    return readExecutionBoard(db, projectId, conversationId);
  });
}
