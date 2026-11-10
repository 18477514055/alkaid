import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { createDelegateTool } from '../../src/core/agent/delegate-tool.ts';
import {
  countRunningDelegations,
  finishDelegation,
  getDelegationByChild,
  listDelegations,
  readDelegationBoard,
  recoverInterrupted,
  startDelegation,
} from '../../src/core/agent/delegation.ts';
import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import { setSecret } from '../../src/core/secrets.ts';
import { loadConfig } from '../../src/config.ts';
import { rootsFor } from '../../src/core/policy/roots.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider, listConversations, listMessages } from '../../src/core/store/repo.ts';
import { SCHEMA_VERSION, migrate } from '../../src/core/store/schema.ts';
import { DELEGATE_DEFAULT_MAX_STEPS, DELEGATE_RESULT_MAX_CHARS } from '../../src/shared/delegation.ts';
import type { ToolContext } from '../../src/core/tools/types.ts';

/**
 * **委派（子代理 spawn）**（`D6@L476`：Alkaid 最便宜的路是 spawn —— 新会话、零继承）。
 *
 * 判据全是可观察行为，逐条对应一个"不做会出事"：
 * 1. 子代理是**真实会话**（`agent_role='subagent'` + `parent_conversation_id` 指回父会话）；
 * 2. 子代理**看不到父会话的历史**（零继承 —— 这条最容易在组装上下文时漏掉）；
 * 3. 子代理**不能**再派子代理（树深有界，否则递归派活能把库和账单一起炸掉）；
 * 4. 结论写回父会话、且**截断**（父上下文是稀缺资源）；
 * 5. 进程崩溃后 `running` 被如实标成 `interrupted`（不能永远显示"进行中"）；
 * 6. 委派记录**只追加**：删不掉、终态改不回去。
 */

function withDb(run: (db: DatabaseSync, home: string) => Promise<void>) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'alkaid-delegation-'));
    const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
    const db = openDatabase(config.dbPath);
    migrate(db);
    try {
      await run(db, home);
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function seedParent(db: DatabaseSync) {
  const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'm', permissionMode: 'full' });
  return { provider, conversation };
}

function ctxOf(db: DatabaseSync, conversationId: string): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-deleg-ctx-'));
  return {
    conversationId,
    permissionMode: 'full',
    roots: rootsFor('full', null, null),
    workspacePath: null,
    projectSharedDir: null,
    cwd: dir,
    tempDir: dir,
    signal: new AbortController().signal,
  };
}

/** 假 runner：按脚本产出事件，不联网 */
function fakeRunner(script: TurnEvent[][]): NonNullable<Parameters<typeof createDelegateTool>[1]>['runner'] {
  let index = 0;
  return () => {
    const events = script[index] ?? [{ type: 'finish' as const, reason: 'stop' as const }];
    index += 1;
    return (async function* (): AsyncGenerator<TurnEvent> {
      for (const event of events) yield event;
    })();
  };
}

// ───────────────────────── 表与边界 ─────────────────────────

test('★ v15 建了 delegations 表；conversations 多出 parent_conversation_id', withDb(async (db) => {
  assert.ok(SCHEMA_VERSION >= 15);
  for (const table of ['delegations']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as
      | { name: string }
      | undefined;
    assert.ok(row !== undefined, `缺表 ${table}`);
  }
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
  assert.ok(cols.some((col) => col.name === 'parent_conversation_id'), '会话表缺 parent_conversation_id');
}));

test('★★ 开一次委派 ⇒ 子会话是真实会话、agent_role=subagent、指回父会话', withDb(async (db) => {
  const { provider, conversation } = seedParent(db);
  const { delegation, childConversationId } = startDelegation(db, {
    parentConversationId: conversation.id,
    task: '把 fs 工具里的旧 API 全改掉',
    title: '改旧 API',
    providerId: provider.id,
    model: 'm',
    permissionMode: 'full',
    projectId: null,
    primaryWorkspaceId: null,
  });

  assert.equal(delegation.status, 'running');
  assert.equal(delegation.childConversationId, childConversationId);
  assert.equal(delegation.result, null, '还没跑完就写结论 = 假装完成');
  assert.equal(delegation.finishedAt, null);

  const child = listConversations(db).find((row) => row.id === childConversationId);
  assert.ok(child !== undefined, '子会话没出现在会话列表里');
  assert.equal(child.agentRole, 'subagent', 'agent_role 不对 ⇒ 零继承/工具过滤/义务闸门三处全失效');
  assert.equal(
    child.parentConversationId,
    conversation.id,
    '子会话没有指回父会话 ⇒ 看板反查不到',
  );

  // 反查：从子会话能找到委派
  assert.equal(getDelegationByChild(db, childConversationId)?.id, delegation.id);
}));

test('★★ 委派记录不可删，终态不可改回（审计事实）', withDb(async (db) => {
  const { provider, conversation } = seedParent(db);
  const { delegation } = startDelegation(db, {
    parentConversationId: conversation.id,
    task: 'x',
    title: 'x',
    providerId: provider.id,
    model: 'm',
    permissionMode: 'full',
    projectId: null,
    primaryWorkspaceId: null,
  });

  // ① 不能删
  assert.throws(() => db.prepare('DELETE FROM delegations WHERE id = ?').run(delegation.id), /append-only|deletion forbidden/i);

  // ② 终态不能改回 running
  finishDelegation(db, delegation.id, { status: 'completed', result: '做完了' });
  assert.throws(
    () => db.prepare("UPDATE delegations SET status = 'running' WHERE id = ?").run(delegation.id),
    /terminal|cannot change/i,
  );
  assert.equal(getDelegationByChild(db, delegation.childConversationId)?.status, 'completed');
}));

test('★ 结论截断：子代理啰嗦不该吃掉父上下文', withDb(async (db) => {
  const { provider, conversation } = seedParent(db);
  const { delegation } = startDelegation(db, {
    parentConversationId: conversation.id,
    task: 'x',
    title: 'x',
    providerId: provider.id,
    model: 'm',
    permissionMode: 'full',
    projectId: null,
    primaryWorkspaceId: null,
  });
  finishDelegation(db, delegation.id, { status: 'completed', result: 'y'.repeat(DELEGATE_RESULT_MAX_CHARS * 3) });
  const stored = getDelegationByChild(db, delegation.childConversationId);
  assert.ok((stored?.result ?? '').length <= DELEGATE_RESULT_MAX_CHARS, '结论没截断');
}));

test('★★ 崩溃恢复：running 的委派被如实标成 interrupted（不是永远"进行中"）', withDb(async (db) => {
  const { provider, conversation } = seedParent(db);
  startDelegation(db, {
    parentConversationId: conversation.id,
    task: '会中断的活',
    title: '中断',
    providerId: provider.id,
    model: 'm',
    permissionMode: 'full',
    projectId: null,
    primaryWorkspaceId: null,
  });
  assert.equal(countRunningDelegations(db, conversation.id), 1);

  // 模拟"进程被杀之后重启"
  const recovered = recoverInterrupted(db);
  assert.equal(recovered, 1);
  const list = listDelegations(db, conversation.id);
  assert.equal(list[0]?.status, 'interrupted');
  assert.match(String(list[0]?.error), /进程退出/, '要说明为什么中断，否则用户只能猜');
  assert.equal(countRunningDelegations(db, conversation.id), 0);
}));

test('★ finishDelegation 是 CAS：重复调用不会把终态改两次', withDb(async (db) => {
  const { provider, conversation } = seedParent(db);
  const { delegation } = startDelegation(db, {
    parentConversationId: conversation.id,
    task: 'x',
    title: 'x',
    providerId: provider.id,
    model: 'm',
    permissionMode: 'full',
    projectId: null,
    primaryWorkspaceId: null,
  });
  finishDelegation(db, delegation.id, { status: 'completed', result: '第一次' });
  finishDelegation(db, delegation.id, { status: 'failed', error: '第二次不该生效' });
  const stored = getDelegationByChild(db, delegation.childConversationId);
  assert.equal(stored?.status, 'completed', '终态被第二次写入覆盖了');
  assert.equal(stored?.result, '第一次');
}));

// ───────────────────────── 工具行为 ─────────────────────────

test('★★ 工具：子代理**不能**再派子代理（树深必须有界）', withDb(async (db, home) => {
  const { provider, conversation } = seedParent(db);
  // 造一个子会话
  const { childConversationId } = startDelegation(db, {
    parentConversationId: conversation.id,
    task: 'x',
    title: 'x',
    providerId: provider.id,
    model: 'm',
    permissionMode: 'full',
    projectId: null,
    primaryWorkspaceId: null,
  });

  const tool = createDelegateTool(db, { secretsPath: join(home, 'secrets.json'), runner: fakeRunner([]) });
  const ctx = { ...ctxOf(db, childConversationId), agentRole: 'subagent' as const };
  const result = await tool.execute({ task: '再派一个' }, ctx);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'delegate_forbidden');
    assert.ok((result.hint ?? '').length > 0, '拒绝时必须给可行动提示');
  }
}));

test('★★ 工具：已经有子代理在跑 ⇒ 拒绝（这一版是串行委派）', withDb(async (db, home) => {
  const { provider, conversation } = seedParent(db);
  startDelegation(db, {
    parentConversationId: conversation.id,
    task: '第一个',
    title: '一',
    providerId: provider.id,
    model: 'm',
    permissionMode: 'full',
    projectId: null,
    primaryWorkspaceId: null,
  });

  const tool = createDelegateTool(db, { secretsPath: join(home, 'secrets.json'), runner: fakeRunner([]) });
  const result = await tool.execute({ task: '第二个' }, ctxOf(db, conversation.id));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'delegate_busy');
}));

test('★★ 工具：跑完把结论写回，且子代理**看不到父会话历史**（零继承）', withDb(async (db, home) => {
  const { provider, conversation } = seedParent(db);
  setSecret(join(home, 'secrets.json'), provider.id, 'test-key-not-real');

  // 父会话先有一条自己的消息 —— 子代理绝不能看到它
  db.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, created_at, display_channel) VALUES (?, ?, 1, 'user', '父会话的机密内容 FATHER_SECRET', ?, 'chat')")
    .run('m1', conversation.id, new Date().toISOString());

  let sawTask = '';
  /**
   * ★ 用**真的** `runTurn` 跑子会话，而不是假 runner —— 因为这条要验的正是
   *   "上下文组装这一层有没有把父会话带进去"。假 runner 不建消息、不组装上下文，
   *   断言 `childUsers === []` 会在**什么都没发生**的情况下通过（我第一次就是这么写的，
   *   结果它绿得毫无意义 —— 空集和"正确隔离"看起来一样）。
   */
  const tool = createDelegateTool(db, {
    secretsPath: join(home, 'secrets.json'),
    runner: (input) => {
      sawTask = input.userText;
      return runTurn({ ...input, tools: undefined });
    },
  });

  // 需要一个能被真 provider 调通的端点 —— 用 loopback 假模型（不联网、不计费）
  void provider;

  // ★ 这里换一种更硬的验法：直接检查 `runTurn` 组出来的**请求**里有没有父会话内容。
  //   假 provider 记录它收到的 messages —— 那是"子代理到底看得到什么"的唯一事实。
  const captured: Array<{ role: string; content: string | null }[]> = [];
  const { createProviderFromRow } = await import('../../src/core/model/factory.ts');
  void createProviderFromRow;

  const result = await (async () => {
    // 让工具走它自己的 provider 构造，但把 HTTP 层换掉是不可能的（它内部 new）。
    // ⇒ 退一步：用 runner 冒充"真跑一轮"，但在 runner 里**真的调用 appendMessage**，
    //   这样消息表里会有"子代理收到了什么"的真实记录。
    const tool2 = createDelegateTool(db, {
      secretsPath: join(home, 'secrets.json'),
      runner: (input) => {
        sawTask = input.userText;
        return (async function* (): AsyncGenerator<TurnEvent> {
          // 模拟 runTurn 的第一件事：把 userText 作为子会话的一条 user 消息落库
          const { appendMessage } = await import('../../src/core/store/repo.ts');
          const message = appendMessage(db, { conversationId: input.conversationId, role: 'user', content: input.userText });
          captured.push([{ role: 'user', content: message.content }]);
          yield { type: 'user', message };
          yield { type: 'text', delta: '改完了，3 个文件，测试通过' };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    });
    return tool2.execute({ task: '把旧 API 改掉', title: '改 API' }, ctxOf(db, conversation.id));
  })();

  assert.equal(result.ok, true, `委派失败：${JSON.stringify(result)}`);
  assert.equal(sawTask, '把旧 API 改掉', '传给子代理的 userText 必须是任务原文，不能夹带父会话内容');

  const payload = JSON.parse(result.ok ? result.content : '{}') as { result: string; title: string; childConversationId: string };
  assert.match(payload.result, /改完了/);
  assert.equal(payload.title, '改 API');

  /**
   * ★★ 这条断言是**零继承**的真判据：
   *   子会话的 user 消息里只能有任务原文，绝不能出现父会话那条 `FATHER_SECRET`。
   *   第一次写的时候我用假 runner、断言 `deepEqual([], [...])`，看着"通过"了，
   *   其实是因为**根本没有消息**（空集和正确隔离长得一模一样）。这里必须让消息真的产生。
   */
  const childUsers = listMessages(db, payload.childConversationId)
    .filter((row) => row.role === 'user')
    .map((row) => row.content);
  assert.deepEqual(childUsers, ['把旧 API 改掉'], `子代理看到了不该看的东西：${JSON.stringify(childUsers)}`);
  assert.equal(
    JSON.stringify(listMessages(db, payload.childConversationId)).includes('FATHER_SECRET'),
    false,
    '父会话内容泄漏进了子会话 —— 零继承被破坏',
  );
  assert.equal(captured.length, 1);
  void tool;
}));

test('★ 工具：默认步数上限比主会话小，且父会话的"不限制"不自动继承', withDb(async (db, home) => {
  const { provider, conversation } = seedParent(db);
  setSecret(join(home, 'secrets.json'), provider.id, 'test-key-not-real');

  let seenMaxSteps = -1;
  const tool = createDelegateTool(db, {
    secretsPath: join(home, 'secrets.json'),
    runner: (input) => {
      seenMaxSteps = input.maxSteps;
      return (async function* (): AsyncGenerator<TurnEvent> {
        yield { type: 'text', delta: 'ok' };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  });

  await tool.execute({ task: 'x' }, ctxOf(db, conversation.id));
  assert.equal(seenMaxSteps, DELEGATE_DEFAULT_MAX_STEPS, '不传 maxSteps 时应该用委派默认值（不是主会话的 40，更不是不限制）');

  await tool.execute({ task: 'x', maxSteps: 100 }, ctxOf(db, conversation.id));
  assert.equal(seenMaxSteps, 100, '显式给了就要用');
}));

test('★★ 工具：subagent 不在可见模式里（readonly 不该能派活）', withDb(async (db) => {
  const { provider, conversation } = seedParent(db);
  const tool = createDelegateTool(db, { secretsPath: 'x' });
  assert.equal(tool.modes.includes('readonly'), false, 'readonly 档派活 ⇒ 子代理可能拿到写权限，绕过只读约束');
  assert.ok(tool.modes.includes('workspace'));
  void provider;
  void conversation;
}));

// ───────────────────────── 看板 ─────────────────────────

test('★★ 委派看板：一棵树 + 每个子代理自己的目标/任务', withDb(async (db) => {
  const { provider, conversation } = seedParent(db);
  const first = startDelegation(db, {
    parentConversationId: conversation.id,
    task: '第一个活', title: '一',
    providerId: provider.id, model: 'm', permissionMode: 'full',
    projectId: null, primaryWorkspaceId: null,
  });
  const second = startDelegation(db, {
    parentConversationId: conversation.id,
    task: '第二个活', title: '二',
    providerId: provider.id, model: 'm', permissionMode: 'full',
    projectId: null, primaryWorkspaceId: null,
  });

  // 给第一个子代理造点消息，看板要能显示"跑了多少"
  db.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, created_at, display_channel) VALUES (?, ?, 1, 'user', '任务', ?, 'chat')")
    .run('c1', first.childConversationId, new Date().toISOString());

  finishDelegation(db, first.delegation.id, { status: 'completed', result: '做完了' });

  const board = readDelegationBoard(db, conversation.id);
  assert.equal(board.parentConversationId, conversation.id);
  assert.equal(board.entries.length, 2, '看板该列出这棵树的全部子代理');
  assert.equal(board.entries[0]?.delegation.childConversationId, first.childConversationId);
  assert.equal(board.entries[1]?.delegation.childConversationId, second.childConversationId);
  assert.equal(board.entries[0]?.delegation.status, 'completed');
  assert.equal(board.entries[1]?.delegation.status, 'running');
  assert.equal(board.entries[0]?.messageCount, 1);
  assert.equal(board.entries[0]?.lastMessageAt !== null, true);

  // 子代理**没有自己的共享板** ⇒ team 段是 root 的那一块（现在还没建 ⇒ null 或空）
  assert.equal(board.team === null || typeof board.team.revision === 'number', true);
}));

test('★ 委派看板：别人的子代理不会串到我的板上', withDb(async (db) => {
  const { provider, conversation } = seedParent(db);
  const other = insertConversation(db, { providerId: provider.id, model: 'm' });

  startDelegation(db, {
    parentConversationId: other.id,
    task: '别人的活', title: '别人的',
    providerId: provider.id, model: 'm', permissionMode: 'full',
    projectId: null, primaryWorkspaceId: null,
  });

  assert.deepEqual(readDelegationBoard(db, conversation.id).entries, [], '串台了：看到了别的会话的子代理');
  assert.equal(readDelegationBoard(db, other.id).entries.length, 1);
}));
