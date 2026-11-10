import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { containsCredentials } from '../memory/context.ts';
import {
  TEAM_DELIVERED_TASKS,
  TEAM_MAX_ACTIVITY,
  TEAM_MAX_BLOCKED_BY,
  TEAM_MAX_DESCRIPTION,
  TEAM_MAX_EVENTS,
  TEAM_MAX_SCOPE,
  TEAM_MAX_SUBJECT,
  TEAM_MAX_TASK_ID,
  TEAM_MAX_TASKS,
  TEAM_MAX_WRITE_SCOPES,
  TEAM_STORED_EVENTS,
  TEAM_TASK_STATUSES,
  type NewTeamTask,
  type TeamBoard,
  type TeamEventActor,
  type TeamEventKind,
  type TeamTask,
  type TeamTaskEvent,
  type TeamTaskPatch,
  type TeamTaskStatus,
} from '../../shared/team.ts';

/**
 * **Agent Team 共享任务板**的读写。
 *
 * ## ★★★ 核心判据：Team 不是"多几个助手"，而是**一块谁都能看、谁做了什么写得清**的板
 *
 * 这条判据决定了好几个看起来"可以简化"的地方实际不能省：
 *
 * 1. **`owner` 必须落库**。只在内存里记"谁在干什么"，进程一重启就全没了 ——
 *    而那正是子代理崩溃时最需要知道的东西。
 * 2. **认领必须是原子 CAS**（`UPDATE ... WHERE owner IS NULL`）。两个代理同时认领
 *    同一张卡，只能有一个成功。第二个必须拿到**冲突**，不能静默覆盖 ——
 *    否则两边都以为自己领到了，最后同一份文件被写两遍。
 * 3. **`revision` 每次 +1，改之前带 `baseRevision`**。这是"我看到的状态是不是最新的"
 *    唯一可判定的依据（照 `execution_board` 的既有做法）。
 * 4. **历史只追加**（`team_task_events` + 触发器）。删得掉的历史等于没有历史。
 *
 * ## ★★ `blocked_by` 与 `write_scopes` 是两种东西，别弄混
 *
 * - `blocked_by`：**真依赖**。没完成 ⇒ 认领被**拒绝**，并且要说清还差哪几张。
 * - `write_scopes`：**建议**。重叠 ⇒ 认领**照旧成功**，只附一条 `warning`。
 *   DSH 原话："Write-scope overlap is advisory, not a lock."
 *   真锁会让两个代理在共享文件上互相等待、活直接卡死；记账价值并不依赖锁。
 *
 * ## ★ 为什么板归属 root 会话，而不是项目
 *
 * 见 `shared/team.ts` 的注释。这里只强调实现后果：`root_conversation_id`
 * 是**逻辑引用**（无外键），会话被删了卡还在，只是再也认领不到。
 */

type Raw = Record<string, unknown>;

function fail(statusCode: 400 | 403 | 404 | 409, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

/** 文本校验：长度 + 控制字符 + **凭据**（板上不许出现密钥，它会进模型上下文）。 */
function text(value: unknown, field: string, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    fail(400, `Invalid team ${field}`);
  }
  if (containsCredentials(value)) fail(400, 'Team board must not contain credentials');
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  // ★ 嵌套时用 SAVEPOINT：工具可能已在别人的事务里（例：一轮写入的批量落库）。
  //   直接 BEGIN 会在嵌套场景抛 "cannot start a transaction within a transaction"。
  const nested = db.isTransaction;
  const point = `team_${randomUUID().replaceAll('-', '')}`;
  db.exec(nested ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec(nested ? `RELEASE ${point}` : 'COMMIT');
    return result;
  } catch (error) {
    if (nested) {
      db.exec(`ROLLBACK TO ${point}`);
      db.exec(`RELEASE ${point}`);
    } else {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}

function parseList(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    // ★ 库里是坏 JSON 时**不抛**：读板必须永远能读出来，否则一条坏数据让整块板打不开。
    return [];
  }
}

function toTask(row: Raw): TeamTask {
  return {
    id: String(row['id']),
    subject: String(row['subject']),
    description: String(row['description']),
    status: String(row['status']) as TeamTaskStatus,
    owner: typeof row['owner'] === 'string' ? row['owner'] : null,
    revision: Number(row['revision']),
    blockedBy: parseList(row['blocked_by']),
    writeScopes: parseList(row['write_scopes']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function toEvent(row: Raw): TeamTaskEvent {
  return {
    id: String(row['id']),
    taskId: String(row['task_id']),
    revision: Number(row['revision']),
    actor: String(row['actor']) as TeamEventActor,
    kind: String(row['kind']) as TeamEventKind,
    text: String(row['text']),
    createdAt: String(row['created_at']),
  };
}

/**
 * 沿着 `parent_conversation_id` 往上找**这块板的真正主人**。
 *
 * ★ 为什么要有它：子代理只知道自己的会话 id。它要加入主对话那块板，
 *   就必须能算出"我的根是谁"。判据放在这里而不是让模型自己传
 *   —— 模型传 rootId 等于让它自选权限（能挑任意一块板），那是漏洞不是功能。
 *
 * ★ 环路保护：`parent_conversation_id` 由运行时写入、本不该成环，
 *   但坏数据不该让工具死循环 —— 走够 64 层就当没有上级。
 */
export function resolveRootConversation(db: DatabaseSync, conversationId: string): string {
  let current = conversationId;
  for (let depth = 0; depth < 64; depth += 1) {
    const row = db.prepare('SELECT parent_conversation_id FROM conversations WHERE id=?').get(current);
    const parent = row?.['parent_conversation_id'];
    if (typeof parent !== 'string' || !parent) return current;
    current = parent;
  }
  return current;
}

function assertBoardRoot(db: DatabaseSync, rootConversationId: string): void {
  text(rootConversationId, 'root conversation id', 200);
  const exists = db.prepare('SELECT 1 AS hit FROM conversations WHERE id=?').get(rootConversationId);
  if (!exists) fail(404, 'Team board root conversation not found');
}

/** 板级 revision 自增（没有行就先建一行）。 */
function touchBoard(db: DatabaseSync, rootConversationId: string, at: string): number {
  const existing = db.prepare('SELECT revision FROM team_boards WHERE root_conversation_id=?').get(rootConversationId);
  if (!existing) {
    db.prepare('INSERT INTO team_boards VALUES(?,?,?,?)').run(rootConversationId, 1, at, at);
    return 1;
  }
  const revision = Number(existing['revision']) + 1;
  db.prepare('UPDATE team_boards SET revision=?, updated_at=? WHERE root_conversation_id=?').run(revision, at, rootConversationId);
  return revision;
}

/** 事件文本：动词 + 标题，外加可选的模型自述（`activity`）。 */
function eventText(verb: string, subject: string, note: string | undefined): string {
  if (note === undefined || note.trim().length === 0) return `${verb}：${subject}`;
  return `${verb}：${subject}｜${note.trim()}`;
}

/** 事件只能追加。**这是唯一写入口** —— 绕过它就等于绕过"历史不可改"的承诺。 */
function appendEvent(
  db: DatabaseSync,
  rootConversationId: string,
  taskId: string,
  revision: number,
  actor: TeamEventActor,
  kind: TeamEventKind,
  message: string,
): void {
  // ★ 500 是 DB CHECK 的硬上限。这里**截断而不是抛**：事件是记账，
  //   长标题不该让一次已经成功的状态变更整体回滚（那会留下"卡改了但没记录"）。
  const body = message.length > 500 ? message.slice(0, 500) : message;
  db.prepare('INSERT INTO team_task_events VALUES(?,?,?,?,?,?,?,?)').run(
    randomUUID(),
    rootConversationId,
    taskId,
    revision,
    actor,
    kind,
    body.trim().length === 0 ? kind : body,
    new Date().toISOString(),
  );
}

/**
 * 读板。
 *
 * ★ 纯读：不会建行、不会改 revision（`execution_board` 的空板也是这个语义）。
 * ★ 交付上限 `TEAM_DELIVERED_TASKS`：**未完成优先**。理由很实际 ——
 *   已完成卡越积越多时，"只按 created_at 截前 50 张"会让新派的活**看不见**，
 *   于是代理以为板是空的、又建一批重复卡。而 `totalTasks`/`truncated`
 *   两个字段让调用方知道"你看到的不是全部"。
 */
export function readBoard(db: DatabaseSync, rootConversationId: string): TeamBoard {
  assertBoardRoot(db, rootConversationId);
  const board = db.prepare('SELECT revision,updated_at FROM team_boards WHERE root_conversation_id=?').get(rootConversationId);
  const total = Number(
    db.prepare('SELECT COUNT(*) AS n FROM team_tasks WHERE root_conversation_id=?').get(rootConversationId)?.['n'] ?? 0,
  );
  const rows = db
    .prepare(
      `SELECT * FROM team_tasks WHERE root_conversation_id=?
       ORDER BY CASE status WHEN 'completed' THEN 1 ELSE 0 END, created_at, id
       LIMIT ?`,
    )
    .all(rootConversationId, TEAM_DELIVERED_TASKS) as Raw[];
  const events = db
    .prepare('SELECT * FROM team_task_events WHERE root_conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(rootConversationId, TEAM_STORED_EVENTS) as Raw[];
  return {
    rootConversationId,
    revision: board ? Number(board['revision']) : 0,
    tasks: rows.map(toTask),
    totalTasks: total,
    truncated: total > rows.length,
    events: events.map(toEvent),
    updatedAt: board ? String(board['updated_at']) : null,
  };
}

function validateScopes(scopes: unknown): string[] {
  if (scopes === undefined) return [];
  if (!Array.isArray(scopes) || scopes.length > TEAM_MAX_WRITE_SCOPES) fail(400, 'Invalid team writeScopes');
  const out: string[] = [];
  for (const scope of scopes) {
    text(scope, 'write scope', TEAM_MAX_SCOPE);
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

function validateBlockedBy(blocked: unknown): string[] {
  if (blocked === undefined) return [];
  if (!Array.isArray(blocked) || blocked.length > TEAM_MAX_BLOCKED_BY) fail(400, 'Invalid team blockedBy');
  const out: string[] = [];
  for (const id of blocked) {
    text(id, 'blockedBy id', TEAM_MAX_TASK_ID);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function taskRow(db: DatabaseSync, rootConversationId: string, taskId: string): Raw {
  const row = db.prepare('SELECT * FROM team_tasks WHERE id=? AND root_conversation_id=?').get(taskId, rootConversationId);
  if (!row) fail(404, 'Team task not found on this board');
  return row;
}

/**
 * 建卡。
 *
 * ★ 同一批里可以用 `id` 互相引用（B 依赖 A），所以**先全量校验 id、再插** ——
 *   边插边校验会让"B 依赖后面的 A"这种合法写法莫名失败。
 * ★ 依赖成环直接拒绝：环上的卡永远等不到完成，等于一块板上永久躺着几张
 *   谁也动不了的卡。这种错要在**建的时候**报，不能等到认领时才发现。
 */
export function createTasks(
  db: DatabaseSync,
  rootConversationId: string,
  tasks: readonly NewTeamTask[],
  actor: TeamEventActor = 'model',
  note?: string,
): { board: TeamBoard; created: readonly TeamTask[] } {
  if (note !== undefined) text(note, 'activity', TEAM_MAX_ACTIVITY);
  if (!Array.isArray(tasks) || tasks.length === 0) fail(400, 'Team create requires at least one task');
  if (tasks.length > TEAM_MAX_TASKS) fail(400, `Team create accepts at most ${String(TEAM_MAX_TASKS)} tasks`);
  return transaction(db, () => {
    assertBoardRoot(db, rootConversationId);
    const existing = Number(
      db.prepare('SELECT COUNT(*) AS n FROM team_tasks WHERE root_conversation_id=?').get(rootConversationId)?.['n'] ?? 0,
    );
    if (existing + tasks.length > TEAM_MAX_TASKS) {
      fail(409, `Team board limit reached (${String(TEAM_MAX_TASKS)} tasks); complete or archive existing tasks instead of adding more`);
    }

    const at = new Date().toISOString();
    // ① 先确定每张卡的 id（同批引用要能解析），并检出批内重复
    const ids: string[] = [];
    for (const input of tasks) {
      const id = input.id === undefined ? randomUUID().replaceAll('-', '').slice(0, 16) : input.id;
      text(id, 'task id', TEAM_MAX_TASK_ID);
      if (ids.includes(id)) fail(400, `Duplicate team task id: ${id}`);
      ids.push(id);
    }

    // ② 校验字段 + 依赖存在性（本批新建的 id 与板上已有的 id 都算合法）
    const prepared: Array<{ id: string; subject: string; description: string; blockedBy: string[]; writeScopes: string[] }> = [];
    for (const [index, input] of tasks.entries()) {
      const id = ids[index]!;
      const subject = input.subject;
      text(subject, 'subject', TEAM_MAX_SUBJECT);
      const description = input.description ?? '';
      text(description, 'description', TEAM_MAX_DESCRIPTION, true);
      const blockedBy = validateBlockedBy(input.blockedBy);
      const writeScopes = validateScopes(input.writeScopes);
      if (blockedBy.includes(id)) fail(400, 'A team task cannot block on itself');
      for (const dependency of blockedBy) {
        if (ids.includes(dependency)) continue;
        const found = db.prepare('SELECT 1 AS hit FROM team_tasks WHERE id=? AND root_conversation_id=?').get(dependency, rootConversationId);
        if (!found) fail(400, `Team task ${id} blocks on unknown task ${dependency} on this board`);
      }
      prepared.push({ id, subject, description, blockedBy, writeScopes });
    }
    assertNoDependencyCycle(prepared);

    // ③ 落库（建卡即 `pending`；`owner` 必须为空 —— 否则就等于"建完就被某人占了"）
    for (const item of prepared) {
      db.prepare(
        `INSERT INTO team_tasks (id,root_conversation_id,subject,description,status,owner,revision,blocked_by,write_scopes,created_at,updated_at)
         VALUES (?,?,?,?,'pending',NULL,1,?,?,?,?)`,
      ).run(item.id, rootConversationId, item.subject, item.description, JSON.stringify(item.blockedBy), JSON.stringify(item.writeScopes), at, at);
      appendEvent(db, rootConversationId, item.id, 1, actor, 'created', eventText('创建任务', item.subject, note));
    }
    touchBoard(db, rootConversationId, at);
    const created = prepared.map((item) => toTask(taskRow(db, rootConversationId, item.id)));
    return { board: readBoard(db, rootConversationId), created };
  });
}

/** 批内依赖成环检测（DFS 三色标记）。只在建卡时跑，成本可忽略。 */
function assertNoDependencyCycle(items: readonly { id: string; blockedBy: readonly string[] }[]): void {
  const graph = new Map(items.map((item) => [item.id, item.blockedBy]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): void => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) fail(400, 'Team task dependencies contain a cycle');
    if (mark === 2) return;
    state.set(id, 1);
    for (const dependency of graph.get(id) ?? []) if (graph.has(dependency)) visit(dependency);
    state.set(id, 2);
  };
  for (const item of items) visit(item.id);
}

/**
 * 未完成的依赖 —— 认领的**真闸门**。
 *
 * ★ 返回的是**卡本身**而不是 id 列表：拒绝信息里必须能说清"还差哪几张"。
 *   只说"有依赖未完成"等于让模型去猜，它下一步多半会乱试一遍。
 */
function pendingDependencies(db: DatabaseSync, rootConversationId: string, task: TeamTask): TeamTask[] {
  const out: TeamTask[] = [];
  for (const id of task.blockedBy) {
    const row = db.prepare('SELECT * FROM team_tasks WHERE id=? AND root_conversation_id=?').get(id, rootConversationId);
    // ★ 依赖卡不存在时**也算未完成**：那是坏数据，放行就等于绕过了闸门。
    if (!row) {
      out.push({
        id, subject: '(missing)', description: '', status: 'pending', owner: null, revision: 0,
        blockedBy: [], writeScopes: [], createdAt: '', updatedAt: '',
      });
      continue;
    }
    const dependency = toTask(row);
    if (dependency.status !== 'completed') out.push(dependency);
  }
  return out;
}

/** 两个写作用域是否真的重叠（前缀包含关系也算：`src/` 与 `src/core/x.ts`）。 */
function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const normalize = (scope: string): string => scope.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  for (const left of a.map(normalize)) {
    for (const right of b.map(normalize)) {
      if (!left || !right) continue;
      if (left === right) return true;
      if (left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) return true;
    }
  }
  return false;
}

/**
 * 写作用域重叠的**建议性**提示。
 *
 * ★ 只说、不拦。这是 DSH 的明确语义（"advisory, not a lock"）：
 *   真锁会让两个代理在共享文件上互相等待、活卡死；而"谁领了什么"的记账
 *   价值并不依赖锁。所以这条 warning 是**给模型看的信息**，不是拒绝理由。
 */
function overlapWarning(db: DatabaseSync, rootConversationId: string, task: TeamTask, owner: string): string | null {
  if (task.writeScopes.length === 0) return null;
  const rows = db
    .prepare("SELECT * FROM team_tasks WHERE root_conversation_id=? AND owner=? AND id<>? AND status<>'completed'")
    .all(rootConversationId, owner, task.id) as Raw[];
  const clashes: string[] = [];
  for (const row of rows) {
    const other = toTask(row);
    if (scopesOverlap(task.writeScopes, other.writeScopes)) clashes.push(other.subject);
  }
  if (clashes.length === 0) return null;
  return `write_scopes 与你自己尚未完成的卡重叠（${clashes.join('、')}）：这只是建议，不是锁，仍然可以继续；但同一段文件被两处改容易冲突，建议串行或先调整范围。`;
}

export type ClaimResult = { task: TeamTask; warning: string | null; board: TeamBoard };

/**
 * 认领 —— **本文件最要紧的一个函数**。
 *
 * ## ★★★ 原子性来自一条 WHERE，而不是"先查再写"
 *
 * ```sql
 * UPDATE team_tasks SET owner=?, status='in_progress', revision=revision+1, updated_at=?
 *  WHERE id=? AND root_conversation_id=? AND revision=? AND (owner IS NULL OR owner=?)
 * ```
 *
 * 判据全部塞进 WHERE：`revision` 挡住"我看到的是旧状态"，
 * `owner IS NULL OR owner=?` 挡住"这张已经是别人的了"。
 * 然后看 `changes === 1`。**一次读写都不分开** ——
 * 先 `SELECT` 判 owner 再 `UPDATE` 是错的：两步之间另一个代理就能抢走，
 * 两个都成功，同一份文件被写两遍。
 *
 * ## ★ 为什么冲突要分类报
 *
 * 三种失败对模型的动作完全不同：
 * - 卡不存在 ⇒ 别重试，重新 list；
 * - revision 不符 ⇒ **重读板再决定**；
 * - 已有主人 ⇒ 换一张卡（或让 root 重新分派）。
 * 只回一句"认领失败"，模型只会拿同样的参数再试一次。
 */
export function claimTask(
  db: DatabaseSync,
  rootConversationId: string,
  callerConversationId: string,
  taskId: string,
  baseRevision: number,
  actor: TeamEventActor = 'model',
  note?: string,
): ClaimResult {
  if (note !== undefined) text(note, 'activity', TEAM_MAX_ACTIVITY);
  text(taskId, 'task id', TEAM_MAX_TASK_ID);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) fail(400, 'Invalid team baseRevision');
  return transaction(db, () => {
    assertBoardRoot(db, rootConversationId);
    const before = toTask(taskRow(db, rootConversationId, taskId));
    const isRoot = callerConversationId === rootConversationId;

    if (before.status === 'completed') fail(409, 'Team task is already completed; reopen with update before claiming');
    /**
     * ★ 已被别人认领 ⇒ **409 冲突，不是 403 权限错误**。
     *
     * 这两种失败对模型的动作完全不同，而 403 会把它引到错的方向：
     * - 403 读作"你没资格"⇒ 它会去求 root、或者干脆放弃这张卡所在的整片工作；
     * - 409 读作"状态变了"⇒ 它会重新 list、挑另一张 ready 的卡，这正是该做的。
     *
     * 而且这正是**并发认领**的那个场景：两个代理同时读板时都看到 owner=null，
     * 第二个走到这里时别人刚领走 —— 那不是权限问题，是竞争结果。
     */
    if (before.owner !== null && before.owner !== callerConversationId && !isRoot) {
      fail(409, `Team task was claimed by another conversation (${before.owner}); re-read the board and pick another task`);
    }
    // ★ 依赖是**真闸门**：被阻塞就拒绝，并且说清还差哪几张。
    //   放在 CAS 之前：被阻塞的卡再重试多少次都不会变，早拒早说清。
    const missing = pendingDependencies(db, rootConversationId, before);
    if (missing.length > 0) {
      const names = missing.map((task) => `${task.id}（${task.subject}）`).join('、');
      fail(409, `Team task is blocked by ${String(missing.length)} incomplete task(s): ${names}`);
    }

    const at = new Date().toISOString();
    const revision = before.revision + 1;
    /**
     * ★ 核心一条：所有判据在**同一个 WHERE** 里，看 `changes`。
     * - `revision=?` 挡"我看到的是旧状态"；
     * - `status<>'completed'` 防并发里被别的路径标完成；
     * - owner 那一半：**root 可以重新分派**（DSH 的 "root can reassign tasks to
     *   itself or any continuable descendant"），其余人只能抢没人认领的或自己已认领的。
     *   所以 owner 条件按调用者身份二选一，而不是一律 `owner IS NULL` ——
     *   否则 root 的重新分派会在 CAS 这层被自己挡住（上层放行、下层拒绝，最难查的那种）。
     */
    const params: Array<string | number> = [callerConversationId, at, taskId, rootConversationId, baseRevision];
    const ownerClause = isRoot ? '1=1' : '(owner IS NULL OR owner=?)';
    if (!isRoot) params.push(callerConversationId);
    const result = db
      .prepare(
        `UPDATE team_tasks SET owner=?, status='in_progress', revision=revision+1, updated_at=?
          WHERE id=? AND root_conversation_id=? AND revision=?
            AND ${ownerClause}
            AND status<>'completed'`,
      )
      .run(...params);
    if (Number(result.changes) !== 1) {
      // 到这一步说明并发/过期：**重读**再判断是哪一种，别猜。
      const now = toTask(taskRow(db, rootConversationId, taskId));
      if (now.revision !== baseRevision) {
        fail(409, `Team task revision changed (expected ${String(baseRevision)}, now ${String(now.revision)}); re-read the board and retry`);
      }
      fail(409, 'This team task was claimed by another conversation; re-read the board and pick another task');
    }

    appendEvent(db, rootConversationId, taskId, revision, actor, 'claimed', eventText('认领任务', before.subject, note));
    touchBoard(db, rootConversationId, at);
    const task = toTask(taskRow(db, rootConversationId, taskId));
    return { task, warning: overlapWarning(db, rootConversationId, task, callerConversationId), board: readBoard(db, rootConversationId) };
  });
}

/** 给自己之外的卡的改动权限判据：root 通吃，其余只能动自己的。 */
function assertCanMutate(boardRoot: string, caller: string, task: TeamTask, verb: string): void {
  if (caller === boardRoot) return;
  if (task.owner !== caller) fail(403, `Only the board root or the task owner may ${verb} this team task`);
}

/**
 * 完成一张卡。
 *
 * ★ 不校验依赖：**完成**不该被依赖拦住（依赖管的是"能不能开工"）。
 *   反过来拦会让"我这边做完了但前面那张卡还没标完成"变成无解死局。
 */
export function completeTask(
  db: DatabaseSync,
  rootConversationId: string,
  callerConversationId: string,
  taskId: string,
  baseRevision: number,
  actor: TeamEventActor = 'model',
  note?: string,
): { task: TeamTask; board: TeamBoard } {
  text(taskId, 'task id', TEAM_MAX_TASK_ID);
  if (note !== undefined) text(note, 'activity', TEAM_MAX_ACTIVITY);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) fail(400, 'Invalid team baseRevision');
  return transaction(db, () => {
    assertBoardRoot(db, rootConversationId);
    const before = toTask(taskRow(db, rootConversationId, taskId));
    assertCanMutate(rootConversationId, callerConversationId, before, 'complete');
    if (before.status === 'completed') fail(409, 'Team task is already completed');

    const at = new Date().toISOString();
    const revision = before.revision + 1;
    const result = db
      .prepare(
        `UPDATE team_tasks SET status='completed', revision=revision+1, updated_at=?
          WHERE id=? AND root_conversation_id=? AND revision=? AND status<>'completed'`,
      )
      .run(at, taskId, rootConversationId, baseRevision);
    if (Number(result.changes) !== 1) {
      const now = toTask(taskRow(db, rootConversationId, taskId));
      fail(409, `Team task revision changed (expected ${String(baseRevision)}, now ${String(now.revision)}); re-read the board and retry`);
    }
    appendEvent(db, rootConversationId, taskId, revision, actor, 'completed', eventText('完成任务', before.subject, note));
    touchBoard(db, rootConversationId, at);
    return { task: toTask(taskRow(db, rootConversationId, taskId)), board: readBoard(db, rootConversationId) };
  });
}

/**
 * 更新一张卡（不含认领/完成 —— 那两个有自己的原子语义，混进来会让 CAS 说不清）。
 *
 * ★ 允许 root 改任何卡：对应 DSH 的 "root can reassign tasks to itself or any
 *   continuable descendant"，也就是主对话可以重新分派。
 */
export function updateTask(
  db: DatabaseSync,
  rootConversationId: string,
  callerConversationId: string,
  taskId: string,
  baseRevision: number,
  patch: TeamTaskPatch,
  actor: TeamEventActor = 'model',
  note?: string,
): { task: TeamTask; warning: string | null; board: TeamBoard } {
  text(taskId, 'task id', TEAM_MAX_TASK_ID);
  if (note !== undefined) text(note, 'activity', TEAM_MAX_ACTIVITY);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) fail(400, 'Invalid team baseRevision');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'Invalid team patch');
  const allowed = ['subject', 'description', 'blockedBy', 'writeScopes', 'status'] as const;
  if (Object.keys(patch).some((key) => !(allowed as readonly string[]).includes(key))) fail(400, 'Invalid team patch fields');
  if (Object.keys(patch).length === 0) fail(400, 'Team update must change at least one field');

  return transaction(db, () => {
    assertBoardRoot(db, rootConversationId);
    const before = toTask(taskRow(db, rootConversationId, taskId));
    assertCanMutate(rootConversationId, callerConversationId, before, 'update');

    let subject = before.subject;
    if (patch.subject !== undefined) {
      text(patch.subject, 'subject', TEAM_MAX_SUBJECT);
      subject = patch.subject;
    }
    let description = before.description;
    if (patch.description !== undefined) {
      text(patch.description, 'description', TEAM_MAX_DESCRIPTION, true);
      description = patch.description;
    }
    const blockedBy = patch.blockedBy === undefined ? before.blockedBy : validateBlockedBy(patch.blockedBy);
    const writeScopes = patch.writeScopes === undefined ? before.writeScopes : validateScopes(patch.writeScopes);
    if (blockedBy.includes(taskId)) fail(400, 'A team task cannot block on itself');
    for (const dependency of blockedBy) {
      if (dependency === taskId) continue;
      const found = db.prepare('SELECT 1 AS hit FROM team_tasks WHERE id=? AND root_conversation_id=?').get(dependency, rootConversationId);
      if (!found) fail(400, `Team task blocks on unknown task ${dependency} on this board`);
    }

    let status: TeamTaskStatus = before.status;
    let owner = before.owner;
    if (patch.status !== undefined) {
      if (!(TEAM_TASK_STATUSES as readonly unknown[]).includes(patch.status)) fail(400, 'Invalid team task status');
      status = patch.status;
      // ★ 退回未开工时必须**同时放开 owner**：`pending` 却仍被占着，
      //   别人认领会被 owner 挡住，这张卡就永远没人能接。
      if (status === 'pending') owner = null;
      if (status === 'in_progress' && owner === null) owner = callerConversationId;
    }

    const at = new Date().toISOString();
    const revision = before.revision + 1;
    const result = db
      .prepare(
        `UPDATE team_tasks SET subject=?, description=?, status=?, owner=?, revision=revision+1,
           blocked_by=?, write_scopes=?, updated_at=?
         WHERE id=? AND root_conversation_id=? AND revision=?`,
      )
      .run(subject, description, status, owner, JSON.stringify(blockedBy), JSON.stringify(writeScopes), at, taskId, rootConversationId, baseRevision);
    if (Number(result.changes) !== 1) {
      const now = toTask(taskRow(db, rootConversationId, taskId));
      fail(409, `Team task revision changed (expected ${String(baseRevision)}, now ${String(now.revision)}); re-read the board and retry`);
    }
    const kind: TeamEventKind = status === 'completed' && before.status !== 'completed' ? 'completed' : 'updated';
    appendEvent(db, rootConversationId, taskId, revision, actor, kind, eventText('更新任务', subject, note));
    touchBoard(db, rootConversationId, at);
    const task = toTask(taskRow(db, rootConversationId, taskId));
    return {
      task,
      warning: owner === null ? null : overlapWarning(db, rootConversationId, task, owner),
      board: readBoard(db, rootConversationId),
    };
  });
}

/**
 * 事件上限的守卫（由 `createTasks` 的调用方按需调用）。
 *
 * ★ 为什么单列一个函数：上限检查只有在**真要写**的时候才该跑，
 *   而读板是纯读、绝不能因为它失败。历史只追加 ⇒ 必须有天花板，
 *   否则一块板能无限长，`list` 每次都要扫全表。
 */
export function assertEventBudget(db: DatabaseSync, rootConversationId: string): void {
  const count = Number(
    db.prepare('SELECT COUNT(*) AS n FROM team_task_events WHERE root_conversation_id=?').get(rootConversationId)?.['n'] ?? 0,
  );
  if (count >= TEAM_MAX_EVENTS) {
    fail(409, `Team history limit reached (${String(TEAM_MAX_EVENTS)} events); existing history is preserved`);
  }
}
