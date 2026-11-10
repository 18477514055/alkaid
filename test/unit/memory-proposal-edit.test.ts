import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  applyProposalManually, getMemoryView, rejectProposal, submitProposal, updatePendingProposalText,
} from '../../src/core/memory/store.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { MemoryProposal, SubmitMemoryProposal } from '../../src/shared/memory.ts';

/**
 * ② 「某个对话可以修改任何来源于他的在暂存区的文本（无需审批）」—— 存储层语义。
 *
 * 钉住四件事：
 * - 本人 pending 可改（title/content），改完仍是 pending、**baseRevision 不变**；
 * - 别人的对话 403、非 pending 409、不存在 404；
 * - 只能改文本：kind / recordId / baseRevision / status 一律 400；
 * - 改文本**不能**变成绕过 CAS 的后门（改完再接受，CAS 该失败还是失败）。
 */

type Fixture = { db: DatabaseSync; project: string; other: string; conv: string; conv2: string; foreign: string };

function withDb(run: (f: Fixture) => void): void {
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
    run({ db, project, other, conv, conv2, foreign });
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

function status(code: number): (error: unknown) => boolean {
  return error => error instanceof Error && (error as Error & { statusCode: number }).statusCode === code;
}

function proposalById(db: DatabaseSync, projectId: string, id: string): MemoryProposal | undefined {
  return getMemoryView(db, projectId).proposals.find(proposal => proposal.id === id);
}

test('② 本人 pending 提案可改文本：改后仍是 pending、baseRevision 不变、写审计但不记正文', () => withDb(({ db, project, conv }) => {
  const before = submitProposal(db, input(conv, { baseRevision: 0 }));
  const updated = updatePendingProposalText(db, project, before.id, {
    conversationId: conv, title: 'Edited title', content: 'Edited content',
  });
  assert.equal(updated.id, before.id);
  assert.equal(updated.title, 'Edited title');
  assert.equal(updated.content, 'Edited content');
  // ★ 三条硬断言：状态没被"顺手"改、修订号没被"顺手"动、目标没变。
  assert.equal(updated.status, 'pending');
  assert.equal(updated.baseRevision, before.baseRevision);
  assert.equal(updated.recordId, before.recordId);
  assert.equal(updated.kind, before.kind);
  assert.equal(updated.resolvedAt, null);
  // 这条路径不应用任何东西。
  assert.equal(getMemoryView(db, project).records.length, 0);
  // 读回来也是新的（不是只在返回值里改）。
  assert.equal(proposalById(db, project, before.id)?.content, 'Edited content');
  // 审计：一条 proposal.edit，只记字段名与长度，不把正文抄进事件表。
  const rows = db.prepare("SELECT detail FROM memory_events WHERE action = 'proposal.edit'").all();
  assert.equal(rows.length, 1);
  const detail = rows[0]?.['detail'] as string;
  assert.deepEqual(JSON.parse(detail)['fields'], ['title', 'content']);
  assert.doesNotMatch(detail, /Edited content|Edited title/);
}));

test('② 只允许改文本：kind / recordId / baseRevision / status 一律 400；空 patch 也是 400', () => withDb(({ db, project, conv }) => {
  const proposal = submitProposal(db, input(conv));
  for (const patch of [
    { conversationId: conv, kind: 'decision' },
    { conversationId: conv, recordId: 'other-record' },
    { conversationId: conv, baseRevision: 7 },
    { conversationId: conv, status: 'applied' },
    { conversationId: conv, operation: 'delete' },
    { conversationId: conv }, // 什么也没给
    { title: 'no conversation' },
  ]) {
    assert.throws(() => updatePendingProposalText(db, project, proposal.id, patch as never), status(400), JSON.stringify(patch));
  }
  // 一次失败的 patch 不能留下任何痕迹。
  const view = getMemoryView(db, project);
  assert.equal(view.proposals.find(p => p.id === proposal.id)?.title, proposal.title);
  assert.equal(view.proposals.find(p => p.id === proposal.id)?.status, 'pending');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_events WHERE action = 'proposal.edit'").get()?.['n'], 0);
  // 文本字段自身的边界仍然生效。
  assert.throws(() => updatePendingProposalText(db, project, proposal.id, { conversationId: conv, title: '   ' }), status(400));
  assert.throws(() => updatePendingProposalText(db, project, proposal.id, { conversationId: conv, content: 'x'.repeat(20_001) }), status(400));
}));

test('② 别人的提案 403；别的项目的对话也 403；不存在的对话 404；不存在的提案 404', () => withDb(({ db, project, other, conv, conv2, foreign }) => {
  const proposal = submitProposal(db, input(conv));
  // 同项目、另一个对话：不是来源 ⇒ 403。
  assert.throws(() => updatePendingProposalText(db, project, proposal.id, { conversationId: conv2, content: 'hijack' }), status(403));
  // 别的项目的对话：连项目都对不上 ⇒ 403。
  assert.throws(() => updatePendingProposalText(db, project, proposal.id, { conversationId: foreign, content: 'hijack' }), status(403));
  assert.throws(() => updatePendingProposalText(db, project, proposal.id, { conversationId: 'missing-conversation', content: 'x' }), status(404));
  assert.throws(() => updatePendingProposalText(db, project, 'missing-proposal', { conversationId: conv, content: 'x' }), status(404));
  // 别的项目的提案：本项目里查不到 ⇒ 404（不是 403：不该泄露"别处有这条提案"）。
  const elsewhere = submitProposal(db, input(foreign));
  assert.throws(() => updatePendingProposalText(db, project, elsewhere.id, { conversationId: foreign, content: 'x' }), status(404));
  // 被拒绝的那几次一个字都没改。
  assert.equal(proposalById(db, project, proposal.id)?.content, proposal.content);
  assert.equal(proposalById(db, other, elsewhere.id)?.content, elsewhere.content);
}));

test('② 非 pending（已应用 / 已拒绝）409，且状态不会被改回去', () => withDb(({ db, project, conv }) => {
  const applied = submitProposal(db, input(conv, { recordId: 'applied' }));
  applyProposalManually(db, project, applied.id);
  assert.throws(() => updatePendingProposalText(db, project, applied.id, { conversationId: conv, content: 'too late' }), status(409));
  const rejected = submitProposal(db, input(conv, { recordId: 'rejected', idempotencyKey: 'rej' }));
  rejectProposal(db, project, rejected.id);
  assert.throws(() => updatePendingProposalText(db, project, rejected.id, { conversationId: conv, content: 'too late' }), status(409));
  const view = getMemoryView(db, project);
  assert.equal(view.proposals.find(p => p.id === applied.id)?.status, 'applied');
  assert.equal(view.proposals.find(p => p.id === applied.id)?.content, 'Supported fact');
  assert.equal(view.proposals.find(p => p.id === rejected.id)?.status, 'rejected');
}));

test('② 改文本不是绕过 CAS 的后门：stale 提案改完再接受仍然 409', () => withDb(({ db, project, conv }) => {
  const first = submitProposal(db, input(conv, { recordId: 'r', content: 'v1' }));
  applyProposalManually(db, project, first.id); // 记录 revision = 1
  const stale = submitProposal(db, input(conv, { recordId: 'r', baseRevision: 0, idempotencyKey: 'stale', content: 'v2' }));
  const edited = updatePendingProposalText(db, project, stale.id, { conversationId: conv, content: 'v2 rewritten' });
  assert.equal(edited.baseRevision, 0); // 仍然是 0：文本改了，版本基准没改
  assert.equal(edited.content, 'v2 rewritten');
  assert.throws(() => applyProposalManually(db, project, stale.id), status(409));
  assert.equal(getMemoryView(db, project).records[0]?.content, 'v1');
}));

test('② input_json 跟着文本走：同 key 同新文本幂等返回，旧文本则 409', () => withDb(({ db, project, conv }) => {
  const proposal = submitProposal(db, input(conv, { content: 'original text' }));
  updatePendingProposalText(db, project, proposal.id, { conversationId: conv, content: 'edited text' });
  // 同一把 idempotencyKey + 同一份（已编辑的）参数 ⇒ 还是同一条提案。
  assert.equal(submitProposal(db, input(conv, { content: 'edited text' })).id, proposal.id);
  // 参数确实变了 ⇒ 仍然按既有规则拒绝，不会被"编辑过"这件事洗白。
  assert.throws(() => submitProposal(db, input(conv, { content: 'original text' })), status(409));
}));
