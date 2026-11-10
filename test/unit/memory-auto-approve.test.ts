import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import {
  applyProposalManually, autoApproveOnTurnEnd, claimMergeJob, getMemoryView, setMaintainerConfig, submitProposal,
} from '../../src/core/memory/store.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { SubmitMemoryProposal } from '../../src/shared/memory.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

/**
 * 轮末自动批准（`MaintainerConfig.autoApproveOnTurnEnd`）的行为测试。
 *
 * 用户原话：「添加选项，勾选后任何不相互冲突的台账会在对话结束后自动审批通过（不包括原则！）」
 * ⇒ 这里钉住四件事：
 * ① 开关关 ⇒ 一条都不动；开关开 ⇒ 非冲突 pending 被应用，且**留痕写明是自动**；
 * ② **原则提案即使开关打开也不自动批准**（最重要的一条）；
 * ③ 同一条记录有两条 pending ⇒ **整条记录**跳过（不半途应用）；
 * ④ CAS 不过的（stale）提案不动。
 *
 * 另外还验"接线"：`runTurn` **正常收轮**后才触发；上游报错的一轮不触发。
 */

type Fixture = {
  db: DatabaseSync; project: string; other: string; conv: string; conv2: string; foreign: string; provider: string;
};

async function withDb(run: (f: Fixture) => Promise<void> | void): Promise<void> {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  const provider = insertProvider(db, { name: 'fake', baseUrl: 'https://invalid.test' }).id;
  const project = insertProject(db, { id: 'p1', name: 'p1', sharedDir: 'unused' }).id;
  const other = insertProject(db, { id: 'p2', name: 'p2', sharedDir: 'unused' }).id;
  const conv = insertConversation(db, { projectId: project, providerId: provider, model: 'fake' }).id;
  const conv2 = insertConversation(db, { projectId: project, providerId: provider, model: 'fake' }).id;
  const foreign = insertConversation(db, { projectId: other, providerId: provider, model: 'fake' }).id;
  try {
    await run({ db, project, other, conv, conv2, foreign, provider });
  } finally {
    db.close();
  }
}

function input(conversationId: string, patch: Partial<SubmitMemoryProposal> = {}): SubmitMemoryProposal {
  return {
    conversationId, recordId: 'r', kind: 'note', title: 'Note', operation: 'upsert',
    content: 'Supported fact', baseRevision: 0, reason: 'User explicitly confirmed in this conversation',
    idempotencyKey: 'key', ...patch,
  };
}

/** 直接插一条 pending 提案（绕过 submitProposal 的 kind 守卫，用来构造 principle 场景）。 */
function insertRawProposal(db: DatabaseSync, projectId: string, conversationId: string, patch: {
  id: string; recordId: string; kind: string; title?: string; content?: string;
  operation?: 'upsert' | 'delete'; baseRevision?: number;
}): void {
  db.prepare(`INSERT INTO memory_proposals
    (id,project_id,conversation_id,idempotency_key,input_json,record_id,kind,title,operation,content,base_revision,reason,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(
    patch.id, projectId, conversationId, `raw-${patch.id}`, '{}', patch.recordId, patch.kind,
    patch.title ?? 'Raw', patch.operation ?? 'upsert', patch.content ?? 'Raw content', patch.baseRevision ?? 0,
    'constructed for the auto-approve guard test', new Date().toISOString(),
  );
}

function events(db: DatabaseSync, action: string): Record<string, unknown>[] {
  return db.prepare('SELECT detail FROM memory_events WHERE action = ? ORDER BY created_at, id').all(action)
    .map(row => JSON.parse(row['detail'] as string) as Record<string, unknown>);
}

function fakeProvider(script: ChatEvent[][]): Provider {
  return {
    id: 'fake',
    async *stream(_request: ChatRequest): AsyncGenerator<ChatEvent> {
      const events = script.shift() ?? [{ type: 'finish', reason: 'stop' }];
      for (const event of events) yield event;
    },
  };
}

async function drain(generator: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of generator) out.push(event);
  return out;
}

test('① 开关关闭（默认）：pending 提案一条都不动，连审计事件都不写', async () => {
  await withDb(({ db, project, conv }) => {
    const p = submitProposal(db, input(conv));
    // 默认值必须是 false —— 这是"替用户按接受"的动作，不能默认开。
    assert.equal(getMemoryView(db, project).config.autoApproveOnTurnEnd, false);
    const outcome = autoApproveOnTurnEnd(db, project);
    assert.deepEqual(outcome, { applied: [], skipped: [] });
    const view = getMemoryView(db, project);
    assert.equal(view.records.length, 0);
    assert.equal(view.proposals.find(x => x.id === p.id)?.status, 'pending');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_events WHERE action = 'proposal.auto_approve'").get()?.['n'], 0);
  });
});

test('① 老库的 config JSON 里没有这个键 ⇒ 回落 false（不是 undefined）', async () => {
  await withDb(({ db, project }) => {
    // 造一个"升级前写下的" config：完全没有 autoApproveOnTurnEnd。
    db.prepare('INSERT INTO memory_projects(project_id, revision, config) VALUES (?, 0, ?)').run(project, JSON.stringify({
      enabled: false, providerId: null, model: null, quietMs: 15_000, maxInputChars: 64_000, maxOutputTokens: 4096,
    }));
    const view = getMemoryView(db, project);
    assert.equal(view.config.autoApproveOnTurnEnd, false);
    const raw = JSON.parse(db.prepare('SELECT config FROM memory_projects WHERE project_id = ?').get(project)?.['config'] as string) as Record<string, unknown>;
    assert.equal(Object.hasOwn(raw, 'autoApproveOnTurnEnd'), false);
    assert.equal(autoApproveOnTurnEnd(db, project).applied.length, 0);
  });
});

test('① 开关打开：非冲突 pending 被应用，留痕写明「自动批准」而不是 human', async () => {
  await withDb(({ db, project, conv, conv2 }) => {
    setMaintainerConfig(db, project, { autoApproveOnTurnEnd: true });
    const a = submitProposal(db, input(conv, { recordId: 'note-a', content: 'auto approved fact' }));
    const b = submitProposal(db, input(conv2, { recordId: 'note-b', content: 'second fact' }));
    const outcome = autoApproveOnTurnEnd(db, project);
    assert.deepEqual([...outcome.applied].sort(), [a.id, b.id].sort());
    assert.deepEqual(outcome.skipped, []);

    const view = getMemoryView(db, project);
    assert.deepEqual(
      view.records.map(record => [record.id, record.content, record.revision]).sort(),
      [['note-a', 'auto approved fact', 1], ['note-b', 'second fact', 1]],
    );
    assert.ok(view.proposals.every(p => p.status === 'applied' && p.resolvedAt !== null));
    // 两条提案都要能追溯：哪一条被自动批准了。
    const autoEvents = events(db, 'proposal.auto_approve');
    assert.equal(autoEvents.length, 2);
    for (const detail of autoEvents) {
      assert.equal(detail['actor'], 'system:auto-approve-on-turn-end');
      assert.equal(detail['code'], 'MEMORY_PROPOSAL_AUTO_APPROVED');
    }
    // 记录侧也要写明来源：**绝不能是 human**。
    const recordEvents = events(db, 'record.upsert');
    assert.equal(recordEvents.length, 2);
    for (const detail of recordEvents) assert.equal(detail['resolvedBy'], 'system:auto-approve-on-turn-end');

    // 对照：人工接受写的是 human，且**不写** proposal.auto_approve。
    const manual = submitProposal(db, input(conv, { recordId: 'note-c', idempotencyKey: 'manual', content: 'human fact' }));
    applyProposalManually(db, project, manual.id);
    const manualEvents = events(db, 'record.upsert').filter(detail => detail['resolvedBy'] !== 'system:auto-approve-on-turn-end');
    assert.deepEqual(manualEvents.map(detail => detail['resolvedBy']), ['human']);
    assert.deepEqual(events(db, 'proposal.auto_approve').map(detail => detail['proposalId']).sort(), [a.id, b.id].sort());
  });
});

test('① 原则提案：开关打开也**绝不**自动批准（提案自己是 principle，或目标记录是 principle）', async () => {
  await withDb(({ db, project, conv }) => {
    setMaintainerConfig(db, project, { autoApproveOnTurnEnd: true });
    // (a) 提案自己是 principle —— 正常提交路径是禁止的，所以直接构一条（模拟历史/异常数据）。
    insertRawProposal(db, project, conv, { id: 'principle-proposal', recordId: 'rule-proposed', kind: 'principle' });
    // (b) 目标记录**已经是** principle —— 提案 kind 是 note，也不能动原则。
    db.prepare('INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?)').run(
      project, 'human-rule', 'principle', 'Human rule', 'Never auto edit', 1, 0, new Date().toISOString(),
    );
    insertRawProposal(db, project, conv, { id: 'note-on-principle', recordId: 'human-rule', kind: 'note', content: 'overwrite attempt' });
    // (c) 同一批里一条普通提案：必须照常应用，证明"只排除原则"而不是整批放弃。
    const normal = submitProposal(db, input(conv, { recordId: 'ordinary', content: 'ordinary fact' }));

    const outcome = autoApproveOnTurnEnd(db, project);
    assert.deepEqual(outcome.applied, [normal.id]);
    const skipped = outcome.skipped.map(item => [item.recordId, item.reason]).sort();
    assert.deepEqual(skipped, [
      ['human-rule', 'principle-is-never-auto-approved'],
      ['rule-proposed', 'principle-is-never-auto-approved'],
    ]);

    const view = getMemoryView(db, project);
    // 原则记录原文一个字都没变，也没有为它新建记录。
    assert.equal(view.records.find(record => record.id === 'human-rule')?.content, 'Never auto edit');
    assert.equal(view.records.find(record => record.id === 'human-rule')?.revision, 1);
    assert.equal(view.records.find(record => record.id === 'rule-proposed'), undefined);
    // 两条原则相关提案仍然 pending（不是 applied / conflict / rejected）。
    assert.equal(view.proposals.find(p => p.id === 'principle-proposal')?.status, 'pending');
    assert.equal(view.proposals.find(p => p.id === 'note-on-principle')?.status, 'pending');
    assert.equal(view.proposals.find(p => p.id === normal.id)?.status, 'applied');
  });
});

test('① 同一条记录有两条 pending ⇒ 整条记录跳过，绝不半途应用', async () => {
  await withDb(({ db, project, conv, conv2 }) => {
    setMaintainerConfig(db, project, { autoApproveOnTurnEnd: true });
    const first = submitProposal(db, input(conv, { recordId: 'dup', idempotencyKey: 'k1', content: 'first version' }));
    const second = submitProposal(db, input(conv2, { recordId: 'dup', idempotencyKey: 'k2', content: 'second version' }));
    const solo = submitProposal(db, input(conv, { recordId: 'solo', idempotencyKey: 'k3', content: 'unambiguous' }));

    const outcome = autoApproveOnTurnEnd(db, project);
    assert.deepEqual(outcome.applied, [solo.id]);
    assert.equal(outcome.skipped.length, 1);
    assert.equal(outcome.skipped[0]?.recordId, 'dup');
    assert.equal(outcome.skipped[0]?.reason, 'record-has-multiple-pending-proposals');
    assert.deepEqual([...(outcome.skipped[0]?.proposalIds ?? [])].sort(), [first.id, second.id].sort());

    const view = getMemoryView(db, project);
    assert.deepEqual(view.records.map(record => record.id), ['solo']);
    // 冲突记录**一条都没应用**（不能挑一条"看起来更像的"）。
    assert.equal(view.proposals.find(p => p.id === first.id)?.status, 'pending');
    assert.equal(view.proposals.find(p => p.id === second.id)?.status, 'pending');
  });
});

test('① baseRevision 不过（stale）的提案不自动应用，也不改已有记录', async () => {
  await withDb(({ db, project, conv }) => {
    setMaintainerConfig(db, project, { autoApproveOnTurnEnd: true });
    const accepted = submitProposal(db, input(conv, { recordId: 'r', content: 'v1' }));
    applyProposalManually(db, project, accepted.id);
    const stale = submitProposal(db, input(conv, { recordId: 'r', baseRevision: 0, idempotencyKey: 'stale', content: 'v2' }));
    const outcome = autoApproveOnTurnEnd(db, project);
    assert.deepEqual(outcome.applied, []);
    assert.deepEqual(outcome.skipped.map(item => item.reason), ['stale-base-revision']);
    const view = getMemoryView(db, project);
    assert.equal(view.records[0]?.content, 'v1');
    assert.equal(view.proposals.find(p => p.id === stale.id)?.status, 'pending');
  });
});

test('① 有在租约内的合并任务时整批不动（不抢已被 AI 认领的提案）', async () => {
  await withDb(({ db, project, conv, provider }) => {
    setMaintainerConfig(db, project, { autoApproveOnTurnEnd: true });
    const claimed = submitProposal(db, input(conv, { recordId: 'in-job', content: 'claimed by merge job' }));
    const job = claimMergeJob(db, project, 'fingerprint', provider, 'fake');
    assert.ok(job);
    assert.equal(autoApproveOnTurnEnd(db, project).applied.length, 0);
    assert.equal(getMemoryView(db, project).proposals.find(p => p.id === claimed.id)?.status, 'pending');
    assert.equal(getMemoryView(db, project).records.length, 0);
    // 任务结束后（失败/过期）自动批准恢复工作 —— 一次崩溃不能永久堵住它。
    db.prepare("UPDATE memory_jobs SET state='failed' WHERE id = ?").run(job.id);
    assert.deepEqual(autoApproveOnTurnEnd(db, project).applied, [claimed.id]);
  });
});

test('① 接线：runTurn **正常收轮**才自动批准；上游报错的一轮不批准', async () => {
  await withDb(async ({ db, project, conv }) => {
    setMaintainerConfig(db, project, { autoApproveOnTurnEnd: true });
    const normal = submitProposal(db, input(conv, { recordId: 'turn-ok', content: 'turn end fact' }));

    const events = await drain(runTurn({
      db, conversationId: conv, userText: 'hello',
      provider: fakeProvider([[{ type: 'text', delta: 'hi' }, { type: 'finish', reason: 'stop' }]]),
      signal: new AbortController().signal,
    }));
    assert.equal(events.at(-1)?.type, 'finish');
    assert.equal(getMemoryView(db, project).proposals.find(p => p.id === normal.id)?.status, 'applied');
    assert.equal(getMemoryView(db, project).records[0]?.content, 'turn end fact');

    // 非正常结束（上游报错）：提案必须原地不动。
    const failing = submitProposal(db, input(conv, { recordId: 'turn-bad', idempotencyKey: 'failing', content: 'must stay pending' }));
    const failed = await drain(runTurn({
      db, conversationId: conv, userText: 'hello again',
      provider: fakeProvider([[{ type: 'error', message: 'offline', retryable: false }]]),
      signal: new AbortController().signal,
    }));
    assert.equal(failed.at(-1)?.type, 'finish');
    const view = getMemoryView(db, project);
    assert.equal(view.proposals.find(p => p.id === failing.id)?.status, 'pending');
    assert.equal(view.records.find(record => record.id === 'turn-bad'), undefined);
    assert.equal(view.records.length, 1);
  });
});
