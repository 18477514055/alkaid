import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CapsuleQuote, CheckpointChoice, MemoryCapsule, MemoryCheckpoint, MemoryContextState, WaterlineWarning } from '../../shared/memory-context.ts';
import { getConversation, listMessages } from '../store/repo.ts';

function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
function conversation(db: DatabaseSync, id: string) {
 const row = getConversation(db, id); if (!row) fail('Conversation not found', 404); return row;
}
export function containsCredentials(value: string): boolean {
 return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"']{6,}/i.test(value);
}
/** Called only after memory_read has actually delivered a complete revision, never by UI reads. */
export function recordReadReceipt(db: DatabaseSync, conversationId: string, recordId: string, revision: number): void {
 const conv = conversation(db, conversationId);
 if (!conv.projectId || !Number.isSafeInteger(revision) || revision < 1) fail('Invalid read receipt');
 const current = db.prepare('SELECT revision FROM memory_records WHERE project_id=? AND record_id=? AND deleted=0').get(conv.projectId, recordId);
 if (!current || Number(current['revision']) !== revision) fail('Read revision is not current', 409);
 if (hasReadReceipt(db, conversationId, conv.projectId, recordId, revision)) return;
 db.prepare('INSERT INTO memory_read_receipts VALUES (?,?,?,?,?)').run(conversationId, conv.projectId, recordId, revision, new Date().toISOString());
}
export function hasReadReceipt(db: DatabaseSync, conversationId: string, projectId: string, recordId: string, revision: number): boolean {
 return !!db.prepare('SELECT 1 FROM memory_read_receipts WHERE conversation_id=? AND project_id=? AND record_id=? AND revision=?').get(conversationId, projectId, recordId, revision);
}
/** The loop calls this only for ok=true write/edit outcomes, using the resolved execution path. */
export function recordSuccessfulFileTouch(db: DatabaseSync, conversationId: string, seq: number, tool: 'write' | 'edit', path: string): void {
 if (!path || containsCredentials(path)) return;
 db.prepare('INSERT INTO memory_file_touches VALUES (?,?,?,?,?,?)').run(randomUUID(), conversationId, seq, tool, path, new Date().toISOString());
}
function quote(seq: number, messageId: string, text: string): CapsuleQuote {
 return containsCredentials(text)
  ? { seq, messageId, text: null, protected: true, notice: '凭据保护：未复制正文。原消息保留；请按messageId/seq在原会话安全查阅，不可称为逐字副本。' }
  : { seq, messageId, text, protected: false };
}
/** Dedicated immutable evidence, not an audit/error log. Saved BEFORE constructing a compact request. */
export function saveCapsule(db: DatabaseSync, conversationId: string, fromSeq: number, toSeq: number): MemoryCapsule {
 conversation(db, conversationId);
 if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq < 1 || toSeq < fromSeq) fail('Invalid capsule range');
 const old = queryCapsules(db, conversationId, { fromSeq, toSeq }).find(c => c.fromSeq === fromSeq && c.toSeq === toSeq);
 if (old) return old;
 const users: CapsuleQuote[] = []; const errors: CapsuleQuote[] = [];
 for (const msg of listMessages(db, conversationId, fromSeq - 1).filter(m => m.seq <= toSeq)) {
  if (msg.role === 'user') users.push(quote(msg.seq, msg.id, msg.content ?? ''));
  if (msg.role === 'tool' && msg.content) {
   try { if ((JSON.parse(msg.content) as { ok?: unknown }).ok === false) errors.push(quote(msg.seq, msg.id, msg.content)); } catch { /* Unstructured output is not fabricated into an error. */ }
  }
 }
 const files = db.prepare('SELECT seq,tool,path FROM memory_file_touches WHERE conversation_id=? AND seq BETWEEN ? AND ? ORDER BY seq,id').all(conversationId, fromSeq, toSeq)
  .map(r => ({ seq: Number(r['seq']), tool: r['tool'] as 'write' | 'edit', path: String(r['path']) }));
 const id = randomUUID(); const createdAt = new Date().toISOString();
 const body = { users, errors, files, coverage: '用户原话与结构化失败工具回执来自原消息；文件仅包含本机制已确认成功的write/edit。shell、外部编辑、启用前未跟踪的写入覆盖未知；不把尝试当成功。凭据正文仅保留原消息指针。' };
 db.prepare('INSERT INTO memory_capsules VALUES (?,?,?,?,?,?)').run(id, conversationId, fromSeq, toSeq, JSON.stringify(body), createdAt);
 return { id, capsuleId: id, conversationId, fromSeq, toSeq, createdAt, ...body };
}
export function queryCapsules(db: DatabaseSync, conversationId: string, query: { capsuleId?: string; fromSeq?: number; toSeq?: number } = {}): MemoryCapsule[] {
 conversation(db, conversationId);
 return db.prepare(`SELECT * FROM memory_capsules WHERE conversation_id=? AND (? IS NULL OR id=?) AND to_seq>=? AND from_seq<=? ORDER BY from_seq,id`).all(
  conversationId, query.capsuleId ?? null, query.capsuleId ?? null, query.fromSeq ?? 1, query.toSeq ?? Number.MAX_SAFE_INTEGER,
 ).map(r => ({ id: String(r['id']), capsuleId: String(r['id']), conversationId, fromSeq: Number(r['from_seq']), toSeq: Number(r['to_seq']), createdAt: String(r['created_at']), ...JSON.parse(String(r['content'])) as Pick<MemoryCapsule, 'users' | 'errors' | 'files' | 'coverage'> }));
}
export function waterlineWarning(tokens: number, window: number): WaterlineWarning {
 const ratio = tokens / Math.max(1, window);
 if (ratio >= .95) return { level: 'urgent', threshold: .95, message: '上下文水位≥95%：不要开始大批读取或新任务；先固化台账、日志、分流。任何压缩仍须三层成功，没有紧急旁路。' };
 if (ratio >= .8) return { level: 'warn', threshold: .8, message: '上下文水位≥80%：先保留约束和进展；是否自动压缩遵循使用者设定的水位线和开关，手动与自动都先通过三层义务检查。' };
 if (ratio >= .6) return { level: 'early', threshold: .6, message: '上下文水位≥60%：建议在自然停止点请求检查点（不记录/只记录/记录并压缩/记录并交接）。不得代选。' };
 return { level: 'safe', threshold: null, message: '' };
}
export function observeWaterline(db: DatabaseSync, conversationId: string, tokens: number, window: number): WaterlineWarning {
 const warning = waterlineWarning(tokens, window);
 db.prepare(`INSERT INTO memory_waterlines VALUES (?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET context_tokens=excluded.context_tokens,context_window=excluded.context_window,level=excluded.level,updated_at=excluded.updated_at`).run(conversationId, Math.max(0, Math.ceil(tokens)), Math.max(1, Math.ceil(window)), warning.level, new Date().toISOString());
 return warning;
}
export function recordTurnProgress(db: DatabaseSync, conversationId: string, userSeq: number, code: 'progress_not_recorded' | 'progress_recorded' | 'checkpoint_skip'): void {
 const old = db.prepare('SELECT code FROM memory_turn_debts WHERE conversation_id=? AND user_seq=? ORDER BY id DESC LIMIT 1').get(conversationId, userSeq);
 if (old?.['code'] === code || (code === 'progress_not_recorded' && old && old['code'] !== 'progress_not_recorded')) return;
 db.prepare('INSERT INTO memory_turn_debts(conversation_id,user_seq,code,created_at) VALUES (?,?,?,?)').run(conversationId, userSeq, code, new Date().toISOString());
}
export function latestUserSeq(db: DatabaseSync, conversationId: string): number {
 return Number(db.prepare("SELECT MAX(seq) AS seq FROM messages WHERE conversation_id=? AND role='user'").get(conversationId)?.['seq'] ?? 0);
}
function checkpointFrom(db: DatabaseSync, row: Record<string, unknown>): MemoryCheckpoint {
 const event = db.prepare('SELECT * FROM memory_checkpoint_events WHERE checkpoint_id=? ORDER BY id DESC LIMIT 1').get(String(row['id']));
 return { id: String(row['id']), conversationId: String(row['conversation_id']), userSeq: Number(row['user_seq']), createdAt: String(row['created_at']), status: (event?.['status'] ?? 'pending') as MemoryCheckpoint['status'], choice: (event?.['choice'] ?? null) as CheckpointChoice | null, proposalId: (event?.['proposal_id'] ?? null) as string | null, handoffId: (event?.['handoff_id'] ?? null) as string | null, code: String(event?.['code'] ?? 'checkpoint_open') };
}
export function getCheckpoint(db: DatabaseSync, conversationId: string, checkpointId?: string): MemoryCheckpoint | null {
 const row = checkpointId ? db.prepare('SELECT * FROM memory_checkpoints WHERE conversation_id=? AND id=?').get(conversationId, checkpointId)
  : db.prepare('SELECT * FROM memory_checkpoints WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(conversationId);
 return row ? checkpointFrom(db, row) : null;
}
export function openCheckpoint(db: DatabaseSync, conversationId: string): MemoryCheckpoint {
 conversation(db, conversationId);
 const old = getCheckpoint(db, conversationId); const seq = latestUserSeq(db, conversationId);
 if (old && old.userSeq === seq && old.status !== 'resolved') return old;
 const id = randomUUID(); db.prepare('INSERT INTO memory_checkpoints VALUES (?,?,?,?)').run(id, conversationId, seq, new Date().toISOString());
 return getCheckpoint(db, conversationId, id)!;
}
export function appendCheckpointEvent(db: DatabaseSync, checkpoint: MemoryCheckpoint, status: MemoryCheckpoint['status'], choice: CheckpointChoice, code: string, proposalId: string | null = null, handoffId: string | null = null): MemoryCheckpoint {
 db.prepare('INSERT INTO memory_checkpoint_events(checkpoint_id,status,choice,proposal_id,handoff_id,code,created_at) VALUES (?,?,?,?,?,?,?)').run(checkpoint.id, status, choice, proposalId, handoffId, code, new Date().toISOString());
 return getCheckpoint(db, checkpoint.conversationId, checkpoint.id)!;
}
export function getMemoryState(db: DatabaseSync, conversationId: string, estimate?: { contextTokens: number; contextWindow: number }): MemoryContextState {
 conversation(db, conversationId);
 const row = db.prepare('SELECT * FROM memory_waterlines WHERE conversation_id=?').get(conversationId);
 const tokens = estimate?.contextTokens ?? Number(row?.['context_tokens'] ?? 0); const window = estimate?.contextWindow ?? Number(row?.['context_window'] ?? 128000);
 const debt = db.prepare('SELECT * FROM memory_turn_debts WHERE conversation_id=? ORDER BY user_seq DESC,id DESC LIMIT 1').get(conversationId);
 return { contextTokens: tokens, contextWindow: window, contextRatio: tokens / Math.max(1, window), warning: waterlineWarning(tokens, window), checkpoint: getCheckpoint(db, conversationId), debt: debt ? { outstanding: debt['code'] === 'progress_not_recorded', userSeq: Number(debt['user_seq']), code: String(debt['code']) } : null };
}
export function renderContextSignal(state: MemoryContextState): string | null {
 const parts = [state.warning.message];
 const compression=state.compaction;
 if(compression?.due) parts.push(`已超过使用者设定的自动压缩线${compression.thresholdPercent}%。压缩前必须分别成功完成三层义务：memory_propose更新台账，memory_stage(action=intent)记录进展日志，最后memory_stage(action=triage)分流；一份日志不能兼任台账。当前缺少${compression.missing.join('、')||'无'}。先通过工具真实补齐再继续业务；程序统一压缩，原文可recall逐字回读，不在正文播报维护。`);
 const rhythm = state.rhythm;
 if (rhythm?.enabled) parts.push(rhythm.due
  ? `台账整理间隔已到：自上次成功整理新增约${rhythm.addedTokens} tokens，超过上下文窗口的${rhythm.thresholdPercent}%。结束前请更新真实进展并分流；可用memory_propose或memory_stage(intent/triage)。确无新增时可memory_disposition说明，不伪造记忆。`
  : `尚未达到台账整理间隔（${rhythm.thresholdPercent}%），短交流本轮无需强制记账或声明无新增。有重要进展可主动更新台账和分流，不必等到阈值。`);
 if (!rhythm?.enabled && state.debt?.outstanding) parts.push('上轮进展尚未固化（可观测欠账）。有实质成果必须提交进展与分流；最终合并需独立审阅。不得为消欠账伪造记录。');
 if (state.obligationSummary && (state.obligationSummary.incomplete || state.obligationSummary.needsReview)) parts.push(`全项目未完成义务${state.obligationSummary.incomplete}项，旧待复核${state.obligationSummary.needsReview}项；本轮完成不得掩盖旧项，按需在右栏处理，不擅自替用户跳过。`);
 const current = state.currentObligation;
 if ((!rhythm?.enabled || rhythm.due) && current && (current.status === 'required' || current.status === 'repairing')) parts.push(`本轮项目义务userSeq=${current.userSeq}，缺少${current.missing.map(item => item === 'progress' ? '进展提案' : '分流提案').join('、')}；必须在结束前成功暂存两项，或仅在确无新增时用memory_disposition给出真实原因。系统最多补收尾一次，不能把未完成说成已记录。`);
 if (state.checkpoint && state.checkpoint.status !== 'resolved') parts.push(`检查点待用户选择，id=${state.checkpoint.id}；不得代用户选择，但等待不阻塞其他工作。`);
 return parts.filter(Boolean).join('\n') || null;
}
