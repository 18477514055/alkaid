import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { Delegation, DelegationBoard, DelegationBoardEntry, DelegationStatus } from '../../shared/delegation.ts';
import { DELEGATE_RESULT_MAX_CHARS } from '../../shared/delegation.ts';
import { readExecutionBoard } from '../memory/execution.ts';
import { NO_PROJECT_SCOPE } from '../memory/execution.ts';
import { getConversation, insertConversation, listMessages } from '../store/repo.ts';

/**
 * **委派**（子代理 spawn）的读写。
 *
 * ## ★★ 为什么"子代理"是一个真实会话，而不是一个进程
 *
 * DSH 的 spawn provider 是"同进程、自己的会话、自己的系统提示、零父上下文"
 * （`D6@L443`）。我们照这条做，但**不新起进程** —— Alkaid 的 `runTurn()` 本来就是
 * "给一个 conversationId 跑一轮"的无状态函数（`loop.ts:191`）。所以：
 *
 * 子代理 = 新建一个 `agent_role='subagent'` 的会话 + 对它跑一次 `runTurn` + 把结论写回父会话。
 *
 * 这样做的好处全都是可验证的：
 * - 子代理的**完整过程**在库里，点开那个会话就能像任何会话一样读（不是一段日志）；
 * - 进程崩了也不会"丢一个子代理"——它的消息已经落库，委派行停在 `running`，
 *   重启时由 `recoverInterrupted()` 标成 `interrupted` 并说明原因；
 * - 不需要新的 IPC / 管道 / 生命周期协议。**共享同一个 SQLite 就是共享状态**。
 *
 * 代价（必须承认）：**崩溃不隔离**。子代理里一个死循环会把整个内核拖住。
 * 所以我们给了它更小的默认步数上限，并且委派是**串行**的（`DELEGATE_MAX_PER_TURN`
 * 限制单轮能派几个，不是同时跑几十个）。
 *
 * ## ★ 零继承是怎么保证的
 *
 * 不是靠"记得别传"，而是靠 `loop.ts` 里已有的三条：
 * 1. `agentRole === 'subagent'` ⇒ `memoryEnabled = false`（不写项目记忆、不进义务闸门）；
 * 2. 上下文组装走 `assembleContext`，子会话**自己**没有历史 ⇒ 天然零继承；
 * 3. `createSurface(..., 'subagent')` 会把 `isProjectMemoryTool` 全部滤掉。
 * 本文件只负责**建会话时就把 agent_role 写对**，否则上面三条全失效。
 */

type Raw = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toDelegation(row: Raw): Delegation {
  return {
    id: String(row['id']),
    parentConversationId: String(row['parent_conversation_id']),
    childConversationId: String(row['child_conversation_id']),
    task: String(row['task']),
    title: String(row['title']),
    status: String(row['status']) as DelegationStatus,
    result: text(row['result']),
    error: text(row['error']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    finishedAt: text(row['finished_at']),
  };
}

export type StartDelegationInput = {
  readonly parentConversationId: string;
  readonly task: string;
  readonly title: string;
  /** 子会话继承的 provider/model/permission 与项目/工作区绑定 */
  readonly providerId: string;
  readonly model: string;
  readonly permissionMode: string;
  readonly projectId: string | null;
  readonly primaryWorkspaceId: string | null;
};

/**
 * 开一次委派：**建子会话 + 建委派行**，返回两者。
 *
 * ★ 为什么一个函数做两件事：如果先建会话再建委派行，中间崩了就会留下
 *   "一个没人认领的子会话"（agent_role='subagent' 但没有任何父会话），
 *   它会在会话列表里显示成一个怪东西。这两件事必须在**同一个事务**里。
 */
export function startDelegation(
  db: DatabaseSync,
  input: StartDelegationInput,
): { readonly delegation: Delegation; readonly childConversationId: string } {
  const task = input.task.trim();
  if (task.length === 0) throw new Error('委派任务不能为空');
  if (task.length > 4_000) throw new Error(`委派任务过长（${task.length} > 4000）—— 请把细节写进文件，任务里只给要点`);
  const title = input.title.trim().slice(0, 200) || task.slice(0, 40);

  db.exec('BEGIN');
  let childId = '';
  let delegationId = '';
  try {
    const child = insertConversation(db, {
      providerId: input.providerId,
      model: input.model,
      title: `子代理 · ${title}`,
      projectId: input.projectId,
      primaryWorkspaceId: input.primaryWorkspaceId,
      permissionMode: input.permissionMode,
      // ★ 必须是 'subagent'：它决定 memoryEnabled / 工具表 / 义务闸门三处行为
      agentRole: 'subagent',
    });
    childId = child.id;
    // ★ 把"谁派的"写进子会话行：看板、孤儿清理、审计都要靠它反查。
    //   不放在 delegations 一张表里就够 —— 因为**会话列表**也要能显示"这是谁的子代理"。
    db.prepare('UPDATE conversations SET parent_conversation_id = ? WHERE id = ?').run(input.parentConversationId, childId);
    delegationId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO delegations (id, parent_conversation_id, child_conversation_id, task, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(delegationId, input.parentConversationId, childId, task, title, now, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const created = getDelegation(db, delegationId);
  if (created === undefined) throw new Error('插入委派后读不回来');
  return { delegation: created, childConversationId: childId };
}

export function getDelegation(db: DatabaseSync, id: string): Delegation | undefined {
  const row = db.prepare('SELECT * FROM delegations WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? undefined : toDelegation(row);
}

export function getDelegationByChild(db: DatabaseSync, childConversationId: string): Delegation | undefined {
  const row = db.prepare('SELECT * FROM delegations WHERE child_conversation_id = ?').get(childConversationId) as
    | Raw
    | undefined;
  return row === undefined ? undefined : toDelegation(row);
}

export function listDelegations(db: DatabaseSync, parentConversationId: string): Delegation[] {
  const rows = db
    .prepare('SELECT * FROM delegations WHERE parent_conversation_id = ? ORDER BY created_at ASC')
    .all(parentConversationId) as Raw[];
  return rows.map(toDelegation);
}

/** 还在跑的委派（同一条父会话单轮内最多几个由调用方控制） */
export function countRunningDelegations(db: DatabaseSync, parentConversationId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM delegations WHERE parent_conversation_id = ? AND status = 'running'")
    .get(parentConversationId) as { n: number | bigint } | undefined;
  return row === undefined ? 0 : Number(row.n);
}

/**
 * 把一次委派标成终态。
 *
 * ★ 结论要截断：父上下文是稀缺资源，一个啰嗦的子代理不该吃掉半窗。
 *   完整结论在子会话里，看板与消息都能点开看 —— 这里只留"够用的一段"。
 * ★ 用 `WHERE status = 'running'` 做 CAS：重复调用（例如 SSE 结束与 catch 都触发）
 *   不会把同一个终态写两次，也不会把 failed 覆盖成 completed。
 */
export function finishDelegation(
  db: DatabaseSync,
  id: string,
  outcome:
    | { readonly status: 'completed'; readonly result: string }
    | { readonly status: 'failed' | 'cancelled' | 'interrupted'; readonly error: string },
): Delegation | undefined {
  const now = new Date().toISOString();
  if (outcome.status === 'completed') {
    const result = outcome.result.trim().slice(0, DELEGATE_RESULT_MAX_CHARS);
    db.prepare(
      `UPDATE delegations SET status = 'completed', result = ?, error = NULL, finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(result.length === 0 ? '（子代理没有产出可用的结论）' : result, now, now, id);
  } else {
    const reason = outcome.error.trim().slice(0, DELEGATE_RESULT_MAX_CHARS) || '未说明原因';
    db.prepare(
      `UPDATE delegations SET status = ?, result = NULL, error = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(outcome.status, reason, now, now, id);
  }
  return getDelegation(db, id);
}

/**
 * 启动时修一次脏状态：进程崩了之后，`running` 的委派其实已经不可能还在跑。
 *
 * ★ 这是"崩溃不隔离"这个代价的**补偿**：既然不能从崩溃中恢复那个子代理，
 *   至少不能让看板永远显示"进行中"（那会让用户等一个永远不会来的结果）。
 *   如实标成 `interrupted` 并写清原因，用户才知道要重派一次。
 */
export function recoverInterrupted(db: DatabaseSync): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE delegations SET status = 'interrupted', error = '内核进程退出，这个子代理没有跑完（它的消息仍在库里，可点开查看做到哪一步）',
       finished_at = ?, updated_at = ? WHERE status = 'running'`,
    )
    .run(now, now);
  return Number(result.changes);
}

/**
 * 拼**委派看板**：一棵树 + 每个子代理自己的执行看板 + 共享任务板。
 *
 * ★ 用户 2026-11-10 的要求：「一张看板同时看到各个子代理当前的工作进度、目标和任务，
 *   以及它们之间的共享任务板。子代理也是同理的。」
 *   ⇒ 服务端一次拼好，前端不再自己组合。**子代理没有自己的共享板**（见
 *   `shared/delegation.ts` 的 `SUBAGENTS_HAVE_NO_OWN_BOARD`），所以 team 段只有 root 的那一块。
 */
export function readDelegationBoard(db: DatabaseSync, parentConversationId: string): DelegationBoard {
  const entries: DelegationBoardEntry[] = listDelegations(db, parentConversationId).map((delegation) => {
    const child = getConversation(db, delegation.childConversationId);
    const projectId = child?.projectId ?? NO_PROJECT_SCOPE;

    let execution: DelegationBoardEntry['execution'] = null;
    try {
      const board = readExecutionBoard(db, projectId, delegation.childConversationId);
      execution = { goal: board.goal, tasks: board.tasks, revision: board.revision };
    } catch {
      // 执行看板读失败不该让整个委派看板挂掉 —— 它只是"附加信息"
      execution = null;
    }

    const messages = listMessages(db, delegation.childConversationId);
    const last = messages.at(-1);
    return {
      delegation,
      execution,
      messageCount: messages.length,
      lastMessageAt: last?.createdAt ?? null,
    };
  });

  // ★ 共享任务板：只有 root 有。表不存在（旧库还没迁到 v15）时返回 null 而不是抛。
  let team: DelegationBoard['team'] = null;
  try {
    const exists = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'team_tasks'")
      .get() as { ok: number | bigint } | undefined;
    if (exists !== undefined) {
      const board = db
        .prepare('SELECT revision FROM team_boards WHERE root_conversation_id = ?')
        .get(parentConversationId) as { revision: number | bigint } | undefined;
      const tasks = db
        .prepare(
          `SELECT t.id, t.subject, t.status, t.owner, c.agent_role AS owner_role
           FROM team_tasks t LEFT JOIN conversations c ON c.id = t.owner
           WHERE t.root_conversation_id = ? ORDER BY t.created_at ASC`,
        )
        .all(parentConversationId) as Raw[];
      team = {
        revision: board === undefined ? 0 : Number(board.revision),
        tasks: tasks.map((row) => ({
          id: String(row['id']),
          subject: String(row['subject']),
          status: String(row['status']),
          owner: text(row['owner']),
          ownerKind: row['owner_role'] === 'subagent' ? 'subagent' : row['owner_role'] === 'main' ? 'main' : 'unknown',
        })),
      };
    }
  } catch {
    team = null;
  }

  return { parentConversationId, entries, team };
}
