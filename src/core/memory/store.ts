import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MEMORY_KINDS } from '../../shared/memory.ts';
import { normalizeMemoryDiagnostic } from '../../shared/memory-diagnostics.ts';
import type { MergePreservedInput } from '../../shared/memory-records.ts';
import {
  linkPreservedMerge, prepareStructuredProposalContent, preserveConcurrentRecord,
  resolvePreservedMerge, validatePreservedMerge, validateStructuredApplication,
} from './records.ts';
import { applyWorkbenchArtifact, validateWorkbenchArtifact } from './workbench.ts';
import { THINKING_EFFORTS, isThinkingEffort } from '../model/thinking.ts';
import type {
  MaintainerConfig, MemoryJob, MemoryKind, MemoryProposal, MemoryRecord, MemoryView,
  MergeDecision, MergePlan, ProposalTextPatch, SubmitMemoryProposal,
} from '../../shared/memory.ts';

type Row = Record<string, unknown>;
export type MemoryUsage = { inputTokens?: number; outputTokens?: number };
/**
 * ★ 谁批准了这次应用。**只有人点「接受」才是 `human`**；另外两条自动路径必须写自己的身份，
 *   不能拿 `human` 冒充用户（用户原话：要能看出是"自动批准"）。
 * - `system:merge-job`            —— 维护 AI 的合并任务（`applyMergePlan`）
 * - `system:auto-approve-on-turn-end` —— 用户开关打开的"轮末自动批准"
 */
type ProposalResolver = 'human' | 'system:merge-job' | 'system:auto-approve-on-turn-end';
const AUTO_RESOLVER: ProposalResolver = 'system:auto-approve-on-turn-end';
const DEFAULT_CONFIG: MaintainerConfig = {
  enabled: false, providerId: null, model: null, quietMs: 15_000,
  maxInputChars: 64_000, maxOutputTokens: 4096,
  // `null` = 不干预，用该模型自己的默认档位（维护请求与聊天会话是两个独立选择）
  thinkingEffort: null,
  // ★ 默认关闭：这是"替用户按接受"的动作，必须由用户显式勾选才生效。
  autoApproveOnTurnEnd: false,
};
const MAX_PENDING = 200;
const MAX_RECORDS = 2000;
const MAX_PROPOSALS = 10_000;
const MAX_JOBS = 10_000;
const MAX_HISTORY = 50_000;
const MAX_EVENTS = 100_000;

function fail(statusCode: 400 | 403 | 404 | 409, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
function text(value: unknown, name: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) {
    fail(400, `Invalid ${name}`);
  }
}
function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(400, `Invalid ${name}`);
}
function kind(value: unknown): asserts value is MemoryKind {
  if (!MEMORY_KINDS.includes(value as MemoryKind)) fail(400, 'Invalid memory kind');
}
function safeContent(value: string): void {
  // Do not retain obvious credentials even in audit reasons. No filesystem access occurs here.
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"']{8,}/i.test(value)) {
    fail(400, 'Memory must not contain credentials');
  }
}
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const nested = db.isTransaction;
  const savepoint = `memory_${randomUUID().replaceAll('-', '')}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (nested) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); }
    else db.exec('ROLLBACK');
    throw error;
  }
}
function project(db: DatabaseSync, projectId: string, writable = false): void {
  text(projectId, 'projectId', 200);
  const row = db.prepare('SELECT archived_at FROM projects WHERE id = ?').get(projectId);
  if (!row) fail(404, 'Project not found');
  if (writable && row['archived_at'] !== null) fail(409, 'Project is archived');
}
function ensureState(db: DatabaseSync, projectId: string): void {
  db.prepare('INSERT OR IGNORE INTO memory_projects(project_id, revision, config) VALUES (?, 0, ?)')
    .run(projectId, JSON.stringify(DEFAULT_CONFIG));
}
function revision(db: DatabaseSync, projectId: string): number {
  return Number(db.prepare('SELECT revision FROM memory_projects WHERE project_id = ?').get(projectId)?.['revision'] ?? 0);
}
function config(db: DatabaseSync, projectId: string): MaintainerConfig {
  const row = db.prepare('SELECT config FROM memory_projects WHERE project_id = ?').get(projectId);
  if (!row) return { ...DEFAULT_CONFIG };
  let stored: unknown;
  try {
    stored = JSON.parse(row['config'] as string);
  } catch {
    // 坏掉的 JSON 不是"用户配置"，回落默认值比把异常一路抛给 GET 更安全。
    return { ...DEFAULT_CONFIG };
  }
  const parsed = stored !== null && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as Partial<MaintainerConfig>
    : {};
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    // ★ 逐字段收口新开关：老库没有这个键 ⇒ false；存的不是布尔 ⇒ false。
    //   绝不能让它变成 `undefined`（`undefined` 在 `if` 里是假，但在 DTO/JSON 里会消失，
    //   前端只能靠"字段不存在"猜默认值）。
    autoApproveOnTurnEnd: parsed.autoApproveOnTurnEnd === true,
  };
}
function countBelow(db: DatabaseSync, table: string, projectId: string, limit: number, additional = 1): void {
  // table is an internal constant, never user input.
  const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId)?.['n']);
  if (n + additional > limit) fail(409, `Memory storage limit reached: ${table}`);
}
function toRecord(row: Row): MemoryRecord {
  return {
    id: row['record_id'] as string, kind: row['kind'] as MemoryKind, title: row['title'] as string,
    content: row['content'] as string, revision: Number(row['revision']), deleted: row['deleted'] === 1,
    updatedAt: row['updated_at'] as string,
  };
}
function record(db: DatabaseSync, projectId: string, recordId: string): MemoryRecord | undefined {
  const row = db.prepare('SELECT * FROM memory_records WHERE project_id = ? AND record_id = ?').get(projectId, recordId);
  return row ? toRecord(row) : undefined;
}
function toProposal(row: Row): MemoryProposal {
  return {
    id: row['id'] as string, projectId: row['project_id'] as string, conversationId: row['conversation_id'] as string,
    resourceType: 'ledger', recordId: row['record_id'] as string, kind: row['kind'] as MemoryKind,
    title: row['title'] as string, operation: row['operation'] as MemoryProposal['operation'],
    content: row['content'] as string, baseRevision: Number(row['base_revision']), reason: row['reason'] as string,
    status: row['status'] as MemoryProposal['status'], createdAt: row['created_at'] as string,
    resolvedAt: row['resolved_at'] as string | null,
  };
}
function proposal(db: DatabaseSync, projectId: string, id: string): MemoryProposal {
  text(id, 'proposalId', 200);
  const row = db.prepare('SELECT * FROM memory_proposals WHERE project_id = ? AND id = ?').get(projectId, id);
  if (!row) fail(404, 'Proposal not found');
  return toProposal(row);
}
function toJob(row: Row): MemoryJob {
  return {
    id: row['id'] as string, projectId: row['project_id'] as string, fingerprint: row['fingerprint'] as string,
    state: row['state'] as MemoryJob['state'], providerId: row['provider_id'] as string, model: row['model'] as string,
    createdAt: row['created_at'] as string, finishedAt: row['finished_at'] as string | null,
    error: row['error'] as string | null, inputTokens: row['input_tokens'] as number | null,
    outputTokens: row['output_tokens'] as number | null,
  };
}
function event(db: DatabaseSync, projectId: string, sourceId: string, action: string, detail: object): void {
  countBelow(db, 'memory_events', projectId, MAX_EVENTS);
  db.prepare('INSERT INTO memory_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    randomUUID(), projectId, revision(db, projectId), sourceId, action, JSON.stringify(detail), new Date().toISOString(),
  );
}
function pending(p: MemoryProposal): void {
  if (p.status !== 'pending') fail(409, 'Proposal is no longer pending');
}
function noPrinciple(p: { kind: MemoryKind }, current?: MemoryRecord): void {
  if (p.kind === 'principle' || current?.kind === 'principle') fail(400, 'Principles are human-maintained only');
}
function provider(db: DatabaseSync, providerId: string): void {
  text(providerId, 'providerId', 200);
  if (!db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId)) fail(400, 'Provider does not exist');
}

export function getProjectRevision(db: DatabaseSync, projectId: string): number {
  project(db, projectId);
  return revision(db, projectId);
}
export function getMemoryView(db: DatabaseSync, projectId: string): MemoryView {
  project(db, projectId);
  return {
    projectId, revision: revision(db, projectId), config: config(db, projectId),
    records: db.prepare('SELECT * FROM memory_records WHERE project_id = ? ORDER BY record_id LIMIT 2000').all(projectId).map(toRecord),
    // Pending proposals must never be hidden by a page of old applied proposals.
    proposals: db.prepare("SELECT * FROM memory_proposals WHERE project_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id LIMIT 400").all(projectId).map(toProposal),
    jobs: db.prepare('SELECT * FROM memory_jobs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(projectId).map(toJob),
  };
}
export function submitProposal(db: DatabaseSync, input: SubmitMemoryProposal): MemoryProposal {
  if (!input || typeof input !== 'object') fail(400, 'Invalid proposal');
  text(input.conversationId, 'conversationId', 200);
  text(input.recordId, 'recordId', 200);
  text(input.idempotencyKey, 'idempotencyKey', 200);
  kind(input.kind);
  text(input.title, 'title', 200);
  text(input.content, 'content', 20_000, input.operation === 'delete');
  text(input.reason, 'reason', 2000);
  integer(input.baseRevision, 'baseRevision');
  if (!['upsert', 'delete'].includes(input.operation)) fail(400, 'Invalid proposal operation');
  safeContent(`${input.title}\n${input.content}\n${input.reason}`);
  const normalized = JSON.stringify({
    conversationId: input.conversationId, recordId: input.recordId, kind: input.kind, title: input.title,
    operation: input.operation, content: input.content, baseRevision: input.baseRevision,
    reason: input.reason, idempotencyKey: input.idempotencyKey,
  });
  return transaction(db, () => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(input.conversationId);
    if (!conv) fail(404, 'Source conversation not found');
    if (conv['agent_role'] === 'subagent') fail(409, 'Subagents return work to their main conversation; they cannot submit project memory');
    if (typeof conv['project_id'] !== 'string' || !conv['project_id'].trim()) fail(400, 'Source conversation has no project');
    const projectId = conv['project_id'];
    project(db, projectId, true);
    const existing = db.prepare('SELECT * FROM memory_proposals WHERE conversation_id = ? AND idempotency_key = ?')
      .get(input.conversationId, input.idempotencyKey);
    if (existing) {
      if (existing['project_id'] !== projectId || existing['input_json'] !== normalized) fail(409, 'Idempotency key has different parameters');
      return toProposal(existing);
    }
    const current = record(db, projectId, input.recordId);
    noPrinciple(input, current);
    validateWorkbenchArtifact(db, projectId, input.recordId, input.kind, input.operation, input.content);
    const storedContent = prepareStructuredProposalContent(db, projectId, input.recordId, input.title, input.kind, input.operation, input.content);
    countBelow(db, 'memory_proposals', projectId, MAX_PROPOSALS);
    const n = Number(db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE project_id = ? AND status = 'pending'").get(projectId)?.['n']);
    if (n >= MAX_PENDING) fail(409, 'Too many pending proposals');
    ensureState(db, projectId);
    const id = randomUUID();
    db.prepare(`INSERT INTO memory_proposals
      (id,project_id,conversation_id,idempotency_key,input_json,record_id,kind,title,operation,content,base_revision,reason,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(
      id, projectId, input.conversationId, input.idempotencyKey, normalized, input.recordId,
      input.kind, input.title, input.operation, storedContent, input.baseRevision, input.reason, new Date().toISOString(),
    );
    const created = proposal(db, projectId, id);
    preserveConcurrentRecord(db, projectId, created, current);
    event(db, projectId, id, 'proposal.submit', { conversationId: input.conversationId, recordId: input.recordId });
    return created;
  });
}
export function setMaintainerConfig(db: DatabaseSync, projectId: string, patch: Partial<MaintainerConfig>): MaintainerConfig {
  return transaction(db, () => {
    project(db, projectId, true);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'Invalid configuration');
    if (Object.keys(patch).some(key => !Object.hasOwn(DEFAULT_CONFIG, key))) fail(400, 'Unknown configuration field');
    const next = { ...config(db, projectId), ...patch };
    if (typeof next.enabled !== 'boolean') fail(400, 'Invalid enabled');
    if (next.providerId !== null) provider(db, next.providerId);
    if (next.model !== null) { text(next.model, 'model', 200); safeContent(next.model); }
    if (next.enabled && (!next.providerId || !next.model)) fail(400, 'Enabled maintainer requires provider and model');
    integer(next.quietMs, 'quietMs', 1000, 300_000);
    integer(next.maxInputChars, 'maxInputChars', 1000, 64_000);
    integer(next.maxOutputTokens, 'maxOutputTokens', 256, 4096);
    if (typeof next.autoApproveOnTurnEnd !== 'boolean') fail(400, 'Invalid autoApproveOnTurnEnd');
    // 思考强度：null = 交给模型默认；其余必须落在白名单里（防止把任意串塞进上游请求体）
    if (next.thinkingEffort !== null && !isThinkingEffort(next.thinkingEffort)) {
      fail(400, `thinkingEffort 必须是 ${THINKING_EFFORTS.join(' / ')} 之一或 null`);
    }
    ensureState(db, projectId);
    const serialized = JSON.stringify(next);
    if (serialized !== JSON.stringify(config(db, projectId))) {
      db.prepare('UPDATE memory_projects SET config = ?, revision = revision + 1 WHERE project_id = ?').run(serialized, projectId);
      event(db, projectId, projectId, 'config.update', next);
    }
    return next;
  });
}
export function rejectProposal(db: DatabaseSync, projectId: string, proposalId: string): void {
  transaction(db, () => {
    project(db, projectId, true);
    const p = proposal(db, projectId, proposalId);
    if (p.status === 'rejected') return;
    if (p.status !== 'pending' && p.status !== 'conflict') fail(409, 'Proposal is already applied');
    db.prepare("UPDATE memory_proposals SET status = 'rejected', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), p.id);
    event(db, projectId, p.id, 'proposal.reject', { recordId: p.recordId });
  });
}
function commitRecord(db: DatabaseSync, projectId: string, sourceId: string, d: MergeDecision, resolver: ProposalResolver): void {
  const operation = d.action === 'delete' ? 'delete' : 'upsert';
  validateStructuredApplication(db, projectId, d.recordId, d.kind, operation, d.content);
  validateWorkbenchArtifact(db, projectId, d.recordId, d.kind, operation, d.content);
  applyWorkbenchArtifact(db, projectId, sourceId, d.recordId, d.kind, operation, d.content);
  const before = record(db, projectId, d.recordId);
  if (!before) countBelow(db, 'memory_records', projectId, MAX_RECORDS);
  countBelow(db, 'memory_history', projectId, MAX_HISTORY);
  const after: MemoryRecord = {
    id: d.recordId, kind: d.kind, title: d.title, content: d.action === 'delete' ? before?.content ?? '' : d.content,
    revision: (before?.revision ?? 0) + 1, deleted: d.action === 'delete', updatedAt: new Date().toISOString(),
  };
  db.prepare(`INSERT INTO memory_records VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project_id,record_id)
    DO UPDATE SET kind=excluded.kind,title=excluded.title,content=excluded.content,revision=excluded.revision,deleted=excluded.deleted,updated_at=excluded.updated_at`)
    .run(projectId, after.id, after.kind, after.title, after.content, after.revision, after.deleted ? 1 : 0, after.updatedAt);
  db.prepare('INSERT INTO memory_history VALUES (?,?,?,?,?,?,?,?)').run(
    randomUUID(), projectId, d.recordId, revision(db, projectId), before ? JSON.stringify(before) : null,
    JSON.stringify(after), sourceId, after.updatedAt,
  );
  event(db, projectId, sourceId, `record.${d.action}`, {
    recordId: d.recordId, proposalIds: d.proposalIds, code: 'MEMORY_RECORD_COMMITTED',
    // ★ 留痕：`human` 只有人点「接受」才会出现；自动批准写自己的身份。
    resolvedBy: resolver,
  });
  resolvePreservedMerge(db, projectId, d.proposalIds);
}
/**
 * ★ 唯一的应用路径（人点接受 / 维护 AI 合并 / 轮末自动批准共用）。
 *
 * 为什么抽出来而不是给自动批准另写一套：**"等价于人工批准的内部路径"** 是用户的
 * 明确要求 —— 另写一套会立刻分叉出两套 CAS、两套审计、两套 kind 守卫，
 * 下一次改其中一套就会静默绕过另一套。
 *
 * 只在**已开启的事务里**调用（自己不开事务：调用方决定批次边界与 savepoint）。
 */
function applyPendingProposal(db: DatabaseSync, projectId: string, p: MemoryProposal, resolver: ProposalResolver): void {
  pending(p);
  const current = record(db, projectId, p.recordId);
  noPrinciple(p, current);
  if (p.baseRevision !== (current?.revision ?? 0)) fail(409, 'Record revision changed');
  if (p.operation === 'delete' && (p.kind === 'decision' || current?.kind === 'decision')) fail(409, 'Decision deletion needs conflict review');
  if (current && current.kind !== p.kind) fail(409, 'Record kind cannot be changed');
  ensureState(db, projectId);
  db.prepare('UPDATE memory_projects SET revision = revision + 1 WHERE project_id = ?').run(projectId);
  commitRecord(db, projectId, p.id, { ...p, proposalIds: [p.id], action: p.operation }, resolver);
  db.prepare("UPDATE memory_proposals SET status = 'applied', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), p.id);
  if (resolver !== 'human') {
    // 自动批准必须**自己留一条痕**：`proposal.auto_approve` + actor。
    // 人工接受不写这条 —— 人工动作已经由「谁点了」这件事本身表示，不需要伪造一条事件。
    event(db, projectId, p.id, 'proposal.auto_approve', {
      proposalId: p.id, recordId: p.recordId, actor: resolver, code: 'MEMORY_PROPOSAL_AUTO_APPROVED',
    });
  }
}
export function applyProposalManually(db: DatabaseSync, projectId: string, proposalId: string): void {
  transaction(db, () => {
    project(db, projectId, true);
    applyPendingProposal(db, projectId, proposal(db, projectId, proposalId), 'human');
  });
}

export type AutoApproveSkip = { recordId: string; proposalIds: string[]; reason: string };
export type AutoApproveOutcome = { applied: string[]; skipped: AutoApproveSkip[] };

/**
 * ★★ 轮末自动批准：用户开关 `autoApproveOnTurnEnd` 打开时，在一轮对话**正常结束**后调用。
 *
 * ## 什么叫「不会相互冲突」（三条判据，缺一不可）
 *
 * 1. **CAS 通过**：提案的 `baseRevision` 必须等于它目标记录**当前**的 `revision`
 *    （记录不存在时以 0 为准）。不一致 = 这条提案基于旧版本，自动应用会覆盖别人的新内容。
 * 2. **同一批里没有两条提案改同一条记录**：按 `recordId` 分组，组里 ≥2 条就**整条记录跳过**，
 *    一条都不应用。为什么不挑一条应用？因为"哪条才是用户想要的"没有任何可靠判据，
 *    半途应用等于替用户做这个决定。
 * 3. **`kind` 不是 `principle`**：原则永远由人维护。提案自己是 principle、或目标记录
 *    已经是 principle，都跳过 —— **开关为 true 也一样**（这是用户明确加括号强调的那一条）。
 *
 * ## 其余行为
 *
 * - 与人工接受走**同一条内部路径**（`applyPendingProposal`），不另写一套应用逻辑。
 * - 留痕：记录事件写 `resolvedBy`，提案写 `proposal.auto_approve` + `actor`，
 *   **绝不**把自动批准记成 `human`。
 * - 全批次一个事务；每条记录一个 savepoint ⇒ 一条失败既不会回滚别人，
 *   也不会把某条记录应用一半（要么整条应用，要么整条留在 pending）。
 * - 失败不重试、不把提案改成 conflict/rejected、不抛出（调用方还会再兜一层 catch）。
 * - 开关关闭时**一条写都不发生**，连事务都不开。
 */
export function autoApproveOnTurnEnd(
  db: DatabaseSync,
  projectId: string,
  /**
   * ★ 只批准**这个对话自己提交的**提案（2026-11-11 审计 `ALK-HIGH-05`）。
   *
   * 原来不传时是本项目**全部** pending 一起自动应用 —— 那等于绕过了维护 AI 的
   * "多作者合并审查"：维护 AI 存在的理由就是等项目里 ≥2 个对话都结束、再把不同作者的
   * 提案**合并**处理；轮末自动批准把别人的提案先一步应用掉，
   * 维护 AI 看到的就是"已经生效了"，合并语义直接消失，而且用户完全不知道。
   *
   * 现在的判据：**只动本轮这个对话自己写的**。别人的留给维护 AI / 人工。
   * 不传则退回原来的项目级行为（测试与显式调用方仍可整体批准）。
   */
  onlyConversationId?: string,
): AutoApproveOutcome {
  const outcome: AutoApproveOutcome = { applied: [], skipped: [] };
  if (!config(db, projectId).autoApproveOnTurnEnd) return outcome;
  transaction(db, () => {
    project(db, projectId, true);
    // ★ 有**在租约内**的合并任务时整批不动：那个任务已经认领了这批提案，
    //   抢在它前面应用会让它的 `applyMergePlan` 看到"已不是 pending"而整单失败。
    //   租约过期的孤儿任务不算（它下一步会被 recoverExpiredMergeJobs / claim 收掉），
    //   否则一次崩溃就会永久堵住自动批准。
    if (db.prepare("SELECT 1 FROM memory_jobs WHERE project_id = ? AND state = 'running' AND created_at > ?")
      .get(projectId, new Date(Date.now() - 180_000).toISOString())) return;
    const pendingRows = db.prepare(
      "SELECT * FROM memory_proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at, id",
    ).all(projectId).map(toProposal)
      // ★ 只保留本轮对话自己提交的（见上面 `onlyConversationId` 的说明）
      .filter((p) => onlyConversationId === undefined || p.conversationId === onlyConversationId);
    const groups = new Map<string, MemoryProposal[]>();
    for (const p of pendingRows) {
      const group = groups.get(p.recordId);
      if (group === undefined) groups.set(p.recordId, [p]);
      else group.push(p);
    }
    for (const [recordId, group] of groups) {
      const skip = (reason: string): void => {
        outcome.skipped.push({ recordId, proposalIds: group.map(p => p.id), reason });
      };
      const p = group[0]!;
      const current = record(db, projectId, recordId);
      if (group.length !== 1) { skip('record-has-multiple-pending-proposals'); continue; }
      if (p.kind === 'principle' || current?.kind === 'principle') { skip('principle-is-never-auto-approved'); continue; }
      if (p.baseRevision !== (current?.revision ?? 0)) { skip('stale-base-revision'); continue; }
      if (p.operation === 'delete' && (p.kind === 'decision' || current?.kind === 'decision')) {
        skip('decision-deletion-needs-review'); continue;
      }
      if (current !== undefined && current.kind !== p.kind) { skip('record-kind-mismatch'); continue; }
      try {
        transaction(db, () => applyPendingProposal(db, projectId, p, AUTO_RESOLVER));
        outcome.applied.push(p.id);
      } catch {
        // 存储层的其余守卫（结构校验、制品校验、配额）拒绝时就跳过：状态不改、不重试。
        skip('apply-rejected-by-store-guards');
      }
    }
  });
  return outcome;
}

/**
 * ★★ 对话改自己暂存提案的**文本**（无需审批）。
 *
 * 规则（用户原话：「某个对话可以修改任何来源于他的在暂存区的文本（无需审批）」）：
 * - 只允许 `title` / `content`。带 `kind` / `recordId` / `baseRevision` / `status`
 *   之类字段一律 400 —— 改文本不能变成改身份、改目标或改版本。
 * - 只有**提案自己的来源对话**能改（`proposal.conversationId === 请求方 conversationId`），
 *   别人改 403；不存在 404；非 pending 409。
 * - `base_revision` **一个字都不动**：否则改文本就成了绕过 CAS 的后门。
 * - 改完仍是 `pending` —— 这条路径不参与任何审批，也不把提案变成已应用。
 * - 审计写 `memory_events(proposal.edit)`，只记字段名与长度，**不记正文**
 *   （事件表和 `memory_events` 的其他记录一样，不能变成正文的第二份拷贝）。
 */
export function updatePendingProposalText(
  db: DatabaseSync, projectId: string, proposalId: string, patch: ProposalTextPatch,
): MemoryProposal {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'Invalid proposal patch');
  const allowed = new Set(['conversationId', 'title', 'content']);
  if (Object.keys(patch).some(key => !allowed.has(key))) fail(400, 'Only title and content may be edited');
  text(patch.conversationId, 'conversationId', 200);
  if (patch.title === undefined && patch.content === undefined) fail(400, 'Nothing to update');
  if (patch.title !== undefined) text(patch.title, 'title', 200);
  return transaction(db, () => {
    project(db, projectId, true);
    const p = proposal(db, projectId, proposalId);
    const conv = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(patch.conversationId);
    if (!conv) fail(404, 'Source conversation not found');
    if (conv['project_id'] !== projectId || p.conversationId !== patch.conversationId) {
      fail(403, 'Only the proposal\'s own conversation may edit it');
    }
    pending(p);
    const title = patch.title ?? p.title;
    // delete 提案的正文本来就允许为空（与 submitProposal 同一判据）。
    if (patch.content !== undefined) text(patch.content, 'content', 20_000, p.operation === 'delete');
    const rawContent = patch.content ?? p.content;
    safeContent(`${title}\n${rawContent}`);
    /**
     * ★★ 2026-11-11 审计 `ALK-HIGH-04`：这里**必须**和 `submitProposal` 过同一道校验。
     *
     * 原来编辑暂存文本只做了「标题 + 正文非空 / 长度」检查，跳过了
     * `validateWorkbenchArtifact` —— 于是结构化制品（分流三桶 / 交接单 / 意图 / 扩展）可以被改成
     * 结构不合法的东西**顺利写到库里**，等维护 AI 应用时才炸；而应用层还有一条更硬的规则
     * （`结构制品只能逐字应用单个来源提案`，见 applyProposal 里那段），
     * 两处判据不一致 ⇒ 用户看到的是一句"莫名其妙的失败"。
     * 现在编辑与提交走同一套规范化 + 同一套制品校验。
     */
    validateWorkbenchArtifact(db, projectId, p.recordId, p.kind, p.operation, rawContent);
    // 与提交时同一套规范化：结构化 kind 的正文是"被校验过的 JSON 字符串"，
    // 绕过它直接写库会让这条提案在应用时被存储层拒绝（用户看到的是莫名其妙的失败）。
    const storedContent = prepareStructuredProposalContent(db, projectId, p.recordId, title, p.kind, p.operation, rawContent);
    /**
     * ★★ 2026-11-11 审计 `ALK-HIGH-04`（第二半）：**不要**改写 `input_json`。
     *
     * `input_json` 是 `submitProposal` 的**幂等指纹**（`existing.input_json !== normalized ⇒ 409`）。
     * 原来这里把 title/content 拼回 `input_json`，于是"编辑过文本的提案"指纹被永久改掉：
     * 之后任何用**原参数**重试的提交都会被判成"同一 key 不同参数"→ 409，
     * 而按新参数重试又不是同一个 key —— 两条路都走不通，重放保护变成了死锁。
     *
     * 判据：编辑改的是**内容**（`title` / `content` 两列），不该动**提交指纹**。
     * 编辑本身有 `proposal.edit` 事件留痕，审计上看得到"谁在什么时候改了什么"。
     */
    // ★ 注意 SET 列表里**没有 base_revision**，也**没有 input_json**：都是刻意的。
    db.prepare(`UPDATE memory_proposals SET title = ?, content = ?
      WHERE project_id = ? AND id = ?`).run(title, storedContent, projectId, p.id);
    event(db, projectId, p.id, 'proposal.edit', {
      proposalId: p.id, conversationId: patch.conversationId,
      fields: [...(patch.title === undefined ? [] : ['title']), ...(patch.content === undefined ? [] : ['content'])],
      titleChars: title.length, contentChars: rawContent.length, code: 'MEMORY_PROPOSAL_TEXT_EDITED',
    });
    return proposal(db, projectId, p.id);
  });
}

/** Local crash recovery only; never releases deduplication or makes an AI call. */
export function recoverExpiredMergeJobs(db: DatabaseSync, projectId: string): number {
  return transaction(db, () => {
    project(db, projectId, true);
    return Number(db.prepare(`UPDATE memory_jobs SET state='failed',finished_at=?,error='MEMORY_JOB_LEASE_EXPIRED'
      WHERE project_id=? AND state='running' AND created_at<=?`).run(
      new Date().toISOString(), projectId, new Date(Date.now() - 180_000).toISOString(),
    ).changes);
  });
}
export function claimMergeJob(db: DatabaseSync, projectId: string, fingerprint: string, providerId: string, model: string): MemoryJob | null {
  text(fingerprint, 'fingerprint', 300);
  text(model, 'model', 200);
  safeContent(model);
  return transaction(db, () => {
    project(db, projectId, true);
    provider(db, providerId);
    const expired = db.prepare(`UPDATE memory_jobs SET state='failed',finished_at=?,error='MEMORY_JOB_LEASE_EXPIRED'
      WHERE project_id=? AND state='running' AND created_at<=?`).run(
      new Date().toISOString(), projectId, new Date(Date.now() - 180_000).toISOString(),
    );
    if (Number(expired.changes)) return null;
    if (db.prepare('SELECT id FROM memory_jobs WHERE project_id=? AND (fingerprint=? OR state=\'running\')').get(projectId, fingerprint)) return null;
    const ids = db.prepare("SELECT id FROM memory_proposals WHERE project_id=? AND status='pending' ORDER BY id").all(projectId).map(row => row['id'] as string);
    if (!ids.length) return null;
    countBelow(db, 'memory_jobs', projectId, MAX_JOBS);
    const id = randomUUID();
    db.prepare(`INSERT INTO memory_jobs(id,project_id,fingerprint,state,provider_id,model,proposal_ids,created_at)
      VALUES (?,?,?,'running',?,?,?,?)`).run(id, projectId, fingerprint, providerId, model, JSON.stringify(ids), new Date().toISOString());
    return toJob(db.prepare('SELECT * FROM memory_jobs WHERE id=?').get(id)!);
  });
}
export function finishMergeJob(db: DatabaseSync, jobId: string, state: MemoryJob['state'], error?: string, usage?: MemoryUsage): void {
  text(jobId, 'jobId', 200);
  if (!['applied', 'failed', 'deferred', 'conflict'].includes(state)) fail(400, 'Invalid terminal job state');
  // Never persist free-form provider errors: they can echo whole prompts/responses.
  if (error !== undefined && typeof error !== 'string') fail(400, 'Invalid diagnostic');
  const diagnostic = normalizeMemoryDiagnostic(error, state);
  if (usage?.inputTokens !== undefined) integer(usage.inputTokens, 'inputTokens');
  if (usage?.outputTokens !== undefined) integer(usage.outputTokens, 'outputTokens');
  transaction(db, () => {
    const row = db.prepare('SELECT * FROM memory_jobs WHERE id=?').get(jobId);
    if (!row) fail(404, 'Job not found');
    if (row['state'] !== 'running' && row['state'] !== state) fail(409, 'Job is already finished');
    // A successful state can only be reached atomically through applyMergePlan.
    if (row['state'] === 'running' && (state === 'applied' || state === 'conflict')) fail(409, 'Use applyMergePlan to commit job');
    db.prepare(`UPDATE memory_jobs SET state=?,finished_at=COALESCE(finished_at,?),error=?,
      input_tokens=COALESCE(?,input_tokens),output_tokens=COALESCE(?,output_tokens) WHERE id=?`).run(
      state, new Date().toISOString(), diagnostic ?? row['error'] as string | null, usage?.inputTokens ?? null, usage?.outputTokens ?? null, jobId,
    );
  });
}
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
}
function validateDecision(d: MergeDecision): void {
  if (!d || typeof d !== 'object') fail(400, 'Invalid merge decision');
  text(d.recordId, 'recordId', 200);
  kind(d.kind);
  noPrinciple(d);
  if (!['upsert', 'delete', 'conflict'].includes(d.action)) fail(400, 'Invalid merge action');
  text(d.title, 'title', 200);
  text(d.content, 'content', 20_000, d.action !== 'upsert');
  text(d.reason, 'reason', 2000);
  safeContent(`${d.title}\n${d.content}\n${d.reason}`);
  if (!Array.isArray(d.proposalIds) || !d.proposalIds.length || d.proposalIds.length > MAX_PENDING) fail(400, 'Invalid decision proposalIds');
  d.proposalIds.forEach(id => text(id, 'proposalId', 200));
}
export function applyMergePlan(db: DatabaseSync, projectId: string, jobId: string, expectedProjectRevision: number, proposalIds: string[], plan: MergePlan): void {
  integer(expectedProjectRevision, 'expectedProjectRevision');
  text(jobId, 'jobId', 200);
  if (!Array.isArray(proposalIds) || !proposalIds.length || proposalIds.length > MAX_PENDING) fail(400, 'Invalid proposalIds');
  proposalIds.forEach(id => text(id, 'proposalId', 200));
  if (!plan || !Array.isArray(plan.decisions) || !plan.decisions.length || plan.decisions.length > MAX_PENDING) fail(400, 'Invalid merge plan');
  plan.decisions.forEach(validateDecision);
  const referenced = plan.decisions.flatMap(d => d.proposalIds);
  if (!sameIds(proposalIds, referenced) || new Set(plan.decisions.map(d => d.recordId)).size !== plan.decisions.length) fail(400, 'Plan must cover each proposal exactly once and group each record');
  transaction(db, () => {
    project(db, projectId, true);
    const job = db.prepare('SELECT * FROM memory_jobs WHERE project_id=? AND id=?').get(projectId, jobId);
    if (!job) fail(404, 'Job not found');
    if (job['state'] !== 'running') fail(409, 'Job is no longer running');
    if (Date.parse(job['created_at'] as string) <= Date.now() - 180_000) fail(409, 'Job lease expired');
    if (revision(db, projectId) !== expectedProjectRevision) fail(409, 'Project revision changed');
    if (!sameIds(proposalIds, JSON.parse(job['proposal_ids'] as string) as string[])) fail(409, 'Only the job claimed proposals may be committed');
    const selected = new Map(proposalIds.map(id => {
      const p = proposal(db, projectId, id); pending(p); return [id, p];
    }));
    for (const d of plan.decisions) {
      const current = record(db, projectId, d.recordId);
      noPrinciple(d, current);
      const sources = d.proposalIds.map(id => selected.get(id)!);
      if (sources.some(p => p.recordId !== d.recordId || p.kind !== d.kind)) fail(400, 'Plan may only change source proposal records and kinds');
      if (sources.some(p => p.kind === 'principle')) fail(400, 'Principles are human-maintained only');
      if (current && current.kind !== d.kind) fail(409, 'Record kind cannot be changed');
      if (d.action !== 'conflict') {
        if (d.recordId.startsWith('artifact:') && (sources.length !== 1 || d.action !== 'upsert' || d.content !== sources[0]!.content)) {
          fail(400, '结构制品只能逐字应用单个来源提案，不能由维护AI改写或拼接');
        }
        if (sources.some(p => p.baseRevision !== (current?.revision ?? 0))) fail(409, 'Stale proposals must be marked conflict');
        if (d.action === 'delete' && (d.kind === 'decision' || current?.kind === 'decision')) fail(409, 'Decision deletion must be marked conflict');
        if (d.action === 'delete' && sources.some(p => p.operation !== 'delete')) fail(400, 'Plan cannot invent a deletion');
        if (d.action === 'upsert' && sources.every(p => p.operation === 'delete')) fail(400, 'Plan cannot turn deletion-only proposals into an upsert');
      }
    }
    ensureState(db, projectId);
    db.prepare('UPDATE memory_projects SET revision=revision+1 WHERE project_id=?').run(projectId);
    for (const d of plan.decisions) {
      if (d.action !== 'conflict') commitRecord(db, projectId, jobId, d, 'system:merge-job');
      else event(db, projectId, jobId, 'record.conflict', { recordId: d.recordId, proposalIds: d.proposalIds, code: 'MEMORY_RECORD_CONFLICT' });
      for (const id of d.proposalIds) db.prepare('UPDATE memory_proposals SET status=?,resolved_at=? WHERE id=?')
        .run(d.action === 'conflict' ? 'conflict' : 'applied', new Date().toISOString(), id);
    }
    db.prepare('UPDATE memory_jobs SET state=?,finished_at=? WHERE id=?').run(
      plan.decisions.some(d => d.action === 'conflict') ? 'conflict' : 'applied', new Date().toISOString(), jobId,
    );
  });
}
/** Explicit preserve merge creates a fresh proposal, never silently accepts or overwrites. */
export function submitPreservedMerge(db: DatabaseSync, projectId: string, input: MergePreservedInput): MemoryProposal {
  return transaction(db, () => {
    project(db, projectId, true);
    if (!input || typeof input !== 'object') fail(400, 'Invalid preserved merge');
    text(input.conversationId, 'conversationId', 200);
    text(input.idempotencyKey, 'idempotencyKey', 200);
    const source = db.prepare('SELECT project_id FROM conversations WHERE id=?').get(input.conversationId);
    if (!source) fail(404, 'Source conversation not found');
    if (source['project_id'] !== projectId) fail(400, 'Conversation belongs to another project');
    const prior = db.prepare('SELECT * FROM memory_proposals WHERE conversation_id=? AND idempotency_key=?').get(input.conversationId, input.idempotencyKey);
    if (prior) {
      const linked = db.prepare('SELECT preserved_id FROM memory_preserved_merges WHERE project_id=? AND proposal_id=?').all(projectId, prior['id'] as string).map(r => r['preserved_id'] as string);
      if (!Array.isArray(input.preservedIds) || !sameIds(linked, input.preservedIds)) fail(409, 'Idempotency key has different preserved entries');
      return submitProposal(db, { conversationId: input.conversationId, recordId: input.recordId,
        kind: prior['kind'] as MemoryKind, title: input.title, content: input.content, operation: 'upsert',
        baseRevision: Number(prior['base_revision']), reason: input.reason, idempotencyKey: input.idempotencyKey });
    }
    const prepared = validatePreservedMerge(db, projectId, input);
    const created = submitProposal(db, { conversationId: input.conversationId, recordId: input.recordId,
      kind: prepared.kind, title: input.title, content: input.content, operation: 'upsert',
      baseRevision: prepared.baseRevision, reason: input.reason, idempotencyKey: input.idempotencyKey });
    linkPreservedMerge(db, projectId, created.id, input.preservedIds);
    return created;
  });
}
/** Explicit user retry only. Preserve failed job history while releasing its fingerprint. */
export function retryFailedMergeJobs(db: DatabaseSync, projectId: string): void {
  transaction(db, () => {
    project(db, projectId, true);
    const rows = db.prepare("SELECT id FROM memory_jobs WHERE project_id=? AND state IN ('failed','deferred') AND fingerprint NOT LIKE 'retired:%'").all(projectId);
    for (const row of rows) db.prepare('UPDATE memory_jobs SET fingerprint=? WHERE id=?').run(`retired:${row['id'] as string}`, row['id'] as string);
    if (rows.length) event(db, projectId, projectId, 'job.retry', { count: rows.length });
  });
}
