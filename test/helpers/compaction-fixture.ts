import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { beginObligation, noteObligationProposal } from '../../src/core/memory/obligations.ts';
import { getCompactionDuties } from '../../src/core/memory/duties.ts';
import { resolvePermissionMode } from '../../src/core/policy/mode.ts';
import { appendMessage, getConversation, listMessages } from '../../src/core/store/repo.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { ToolContext } from '../../src/core/tools/types.ts';
import type { MemoryProposal } from '../../src/shared/memory.ts';
import type { DutyKind } from '../../src/shared/compaction-duties.ts';

export type CompactionFixtureReceipt = { proposalId: string; messageSeq: number; batchSeq: number };
export type CompactionFixtureDuties = {
  userSeq: number; receipts: Record<DutyKind, CompactionFixtureReceipt>; addedMessages: number;
};
/**
 * Real fixture work, not a mocked gate: new USER turn, three independent persisted
 * model tools and their original successful replies, then immutable obligation evidence.
 * Requires a real bound main project; never creates projects/migrations, changes provider
 * windows, approves memory or bypasses the compaction gate. Usually adds 7 messages.
 */
export async function addCompactionDuties(db: DatabaseSync, conversationId: string): Promise<CompactionFixtureDuties> {
  const conversation = getConversation(db, conversationId);
  assert.ok(conversation?.projectId, 'Compaction fixture needs a real project-bound conversation');
  assert.notEqual(conversation.agentRole, 'subagent', 'Subagents must not fill project duties');
  const before = listMessages(db, conversationId).length;
  const user = appendMessage(db, { conversationId, role: 'user', content: '测试夹具：为已准备的历史材料真实保存台账、进展日志与分流；三项待独立审核，不修改正式记忆。' });
  beginObligation(db, conversationId, user.seq);
  const tools = createDefaultRegistry(db);
  const ctx: ToolContext = { conversationId, agentRole: 'main', permissionMode: resolvePermissionMode(conversation.permissionMode),
    roots: { readable: [], writable: [], anywhere: false }, workspacePath: null, projectSharedDir: null,
    cwd: '.', tempDir: '.', signal: new AbortController().signal, turnUserSeq: user.seq, maxToolOutputChars: null };
  const receipts = {} as Record<DutyKind, CompactionFixtureReceipt>;
  for (const kind of ['ledger','log','triage'] as const) {
    const key = randomUUID();
    const name = kind === 'ledger' ? 'memory_propose' : 'memory_stage';
    const args = kind === 'ledger'
      ? { recordId: `fixture-compaction-${key}`, kind: 'active', title: '压缩测试材料与边界', operation: 'upsert', content: '已准备并保留原始历史材料；本测试核验摘要提交、逐字回读与安全保留边界。', baseRevision: 0,
          reason: '本测试数据库中的已保存消息及真实工具回执', idempotencyKey: key }
      : { action: kind === 'log' ? 'intent' : 'triage', payload: kind === 'log'
          ? { goal: '核验安全压缩与原文回读', did: '准备真实历史与三层独立持久提案', issues: '', next: '请求压缩并验证原断言' }
          : { keep: [{ what: '原始消息不可删除；履责工具调用批次必须整组保留。' }], stash: [], drop: [] }, reason: '由测试准备的真实消息和工具成功结果核对', idempotencyKey: key };
    const callId = randomUUID();
    const assistant = appendMessage(db, { conversationId, role: 'assistant', displayChannel: 'maintenance', toolCalls: [{ id: callId, name, arguments: JSON.stringify(args), displayChannel: 'maintenance' }] });
    const outcome = await tools.execute(name, args, ctx);
    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
    const message = appendMessage(db, { conversationId, role: 'tool', displayChannel: 'maintenance', toolCallId: callId, content: JSON.stringify(outcome) });
    const payload = JSON.parse(outcome.ok ? outcome.content : '{}') as { proposal?: MemoryProposal };
    assert.ok(payload.proposal?.id, 'Actual successful tool must return a persisted proposal');
    noteObligationProposal(db, conversationId, user.seq, payload.proposal.id, message.seq);
    receipts[kind] = { proposalId: payload.proposal.id, messageSeq: message.seq, batchSeq: assistant.seq };
  }
  const duties = getCompactionDuties(db, conversationId, user.seq);
  assert.equal(duties.complete, true, `Actual fixture duties incomplete: ${duties.reason}/${duties.missing.join(',')}`);
  assert.equal(duties.checkpoint?.safeCutSeq, receipts.ledger.batchSeq - 1);
  assert.equal(new Set(Object.values(receipts).map(r => r.proposalId)).size, 3);
  return { userSeq: user.seq, receipts, addedMessages: listMessages(db, conversationId).length - before };
}
