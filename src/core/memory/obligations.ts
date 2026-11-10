import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { containsCredentials } from './context.ts';
import { OBLIGATION_FINISH_CODES, OBLIGATION_STATUSES } from '../../shared/memory-obligations.ts';
import type {
  MemoryObligation, ObligationCode, ObligationEvent, ObligationEvidence, ObligationFinishCode,
  ObligationPage, ObligationQuery, ObligationStatus, ObligationSummary, ResolveObligationInput, ResolveObligationResult,
} from '../../shared/memory-obligations.ts';

type Row = Record<string, unknown>;
const MAX_TURNS = 50_000;
const MAX_EVENTS = 512;
const MAX_EVIDENCE = 128;
function fail(statusCode: 400 | 404 | 409, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function id(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) fail(400, `Invalid ${name}`);
}
function seq(value: unknown, name: string, min = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min) fail(400, `Invalid ${name}`);
}
function object(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function json(value: unknown): Row | null {
  if (typeof value !== 'string' || value.length > 1_000_000) return null;
  try { const parsed: unknown = JSON.parse(value); return object(parsed) ? parsed : null; } catch { return null; }
}
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const nested = db.isTransaction, savepoint = `obligation_${randomUUID().replaceAll('-', '')}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try { const out = fn(); db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT'); return out; }
  catch (error) { if (nested) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); } else db.exec('ROLLBACK'); throw error; }
}
function project(db: DatabaseSync, projectId: string, write = false): void {
  id(projectId, 'projectId'); const p = db.prepare('SELECT archived_at FROM projects WHERE id=?').get(projectId);
  if (!p) fail(404, 'Project not found');
  if (write && p['archived_at'] !== null) fail(409, 'Project is archived');
}
function conversation(db: DatabaseSync, conversationId: string, write = false): Row {
  id(conversationId, 'conversationId');
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
  if (!conv) fail(404, 'Conversation not found');
  if (typeof conv['project_id'] === 'string' && conv['project_id']) project(db, conv['project_id'], write);
  return conv;
}
function turnRow(db: DatabaseSync, conversationId: string, userSeq: number): Row | undefined {
  return db.prepare('SELECT * FROM memory_obligations WHERE conversation_id=? AND user_seq=?').get(conversationId, userSeq);
}
function requireTurn(db: DatabaseSync, conversationId: string, userSeq: number): Row {
  id(conversationId, 'conversationId'); seq(userSeq, 'userSeq');
  const row = turnRow(db, conversationId, userSeq); if (!row) fail(404, 'Obligation not found');
  project(db, String(row['project_id']), true);
  const conv = conversation(db, conversationId, true);
  if (conv['project_id'] !== row['project_id']) fail(409, 'Conversation project changed; obligation needs review');
  return row;
}
function userMessage(db: DatabaseSync, conversationId: string, userSeq: number): Row {
  seq(userSeq, 'userSeq');
  const row = db.prepare("SELECT * FROM messages WHERE conversation_id=? AND seq=? AND role='user'").get(conversationId, userSeq);
  if (!row) fail(404, 'Source user message not found'); return row;
}
function nextUser(db: DatabaseSync, conversationId: string, userSeq: number): number {
  return Number(db.prepare("SELECT MIN(seq) AS seq FROM messages WHERE conversation_id=? AND role='user' AND seq>?").get(conversationId, userSeq)?.['seq'] ?? Number.MAX_SAFE_INTEGER);
}
function addEvent(db: DatabaseSync, row: Row, type: ObligationEvent['type'], status: ObligationStatus, code: ObligationCode,
  messageSeq: number | null = null, proposalId: string | null = null, mutating = false): void {
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_obligation_events WHERE conversation_id=? AND user_seq=?').get(String(row['conversation_id']), Number(row['user_seq']))?.['n']);
  if (n >= MAX_EVENTS) fail(409, 'Obligation event limit reached');
  db.prepare(`INSERT INTO memory_obligation_events(conversation_id,user_seq,type,status,code,message_seq,proposal_id,mutating,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(String(row['conversation_id']), Number(row['user_seq']), type, status, code, messageSeq, proposalId, mutating ? 1 : 0, new Date().toISOString());
}
function createTurn(db: DatabaseSync, conv: Row, userSeq: number, legacy = false): Row {
  const user = userMessage(db, String(conv['id']), userSeq);
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_obligations WHERE project_id=?').get(String(conv['project_id']))?.['n']);
  if (n >= MAX_TURNS) fail(409, 'Project obligation storage limit reached');
  const base = legacy ? 0 : Number(db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM memory_proposals').get()?.['n']);
  db.prepare('INSERT INTO memory_obligations VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), String(conv['project_id']), String(conv['id']), userSeq, String(user['id']), base, legacy ? 1 : 0, new Date().toISOString());
  const row = turnRow(db, String(conv['id']), userSeq)!;
  addEvent(db, row, 'begin', 'required', 'OBLIGATION_REQUIRED'); return row;
}
/** Called immediately after the actual user message is persisted, before any business/tool work. */
export function beginObligation(db: DatabaseSync, conversationId: string, userSeq: number): MemoryObligation | null {
  return transaction(db, () => {
    const conv = conversation(db, conversationId, true); userMessage(db, conversationId, userSeq);
    if (!conv['project_id']) return null;
    const old = turnRow(db, conversationId, userSeq);
    if (old && old['project_id'] !== conv['project_id']) fail(409, 'Conversation project changed; obligation needs review');
    return derive(db, old ?? createTurn(db, conv, userSeq));
  });
}
function evidenceType(p: Row): 'progress' | 'triage' | null {
  if (p['kind'] === 'principle') return null;
  const recordId = String(p['record_id']);
  if (!recordId.startsWith('artifact:')) return ['active','decision','goal','lesson','note'].includes(String(p['kind'])) ? 'progress' : null;
  if (p['kind'] !== 'note' || p['operation'] !== 'upsert') return null;
  const payload = json(p['content']);
  if (/^artifact:triage:[A-Za-z0-9_-]+$/.test(recordId) && payload?.['$memory'] === 'triage') return 'triage';
  if (/^artifact:(intent|handoff):[A-Za-z0-9_-]+$/.test(recordId) && payload?.['$memory'] === recordId.split(':')[1]) return 'progress';
  return null;
}
function resultProposal(message: Row): string | null {
  const result = json(message['content']); if (result?.['ok'] !== true) return null;
  const payload = json(result['content']);
  return object(payload?.['proposal']) && typeof payload['proposal']['id'] === 'string' ? payload['proposal']['id'] : null;
}
function callName(db: DatabaseSync, conversationId: string, userSeq: number, message: Row): string | null {
  if (typeof message['tool_call_id'] !== 'string') return null;
  const assistants = db.prepare("SELECT tool_calls FROM messages WHERE conversation_id=? AND role='assistant' AND seq>? AND seq<? AND tool_calls IS NOT NULL ORDER BY seq DESC LIMIT 256")
    .all(conversationId, userSeq, Number(message['seq']));
  for (const assistant of assistants) {
    try {
      const calls: unknown = JSON.parse(String(assistant['tool_calls']));
      if (!Array.isArray(calls)) continue;
      for (const c of calls) if (object(c) && c['id'] === message['tool_call_id'] && typeof c['name'] === 'string') return c['name'];
    } catch { /* malformed persisted call is not evidence */ }
  }
  return null;
}
function actualToolMessage(db: DatabaseSync, row: Row, messageSeq: number): Row {
  seq(messageSeq, 'messageSeq');
  const convId = String(row['conversation_id']), u = Number(row['user_seq']);
  if (messageSeq <= u || messageSeq >= nextUser(db, convId, u)) fail(409, 'Evidence message is outside the source turn');
  const msg = db.prepare("SELECT * FROM messages WHERE conversation_id=? AND seq=? AND role='tool'").get(convId, messageSeq);
  if (!msg || !callName(db, convId, u, msg)) fail(409, 'Actual persisted tool result required');
  return msg;
}
export function noteObligationBusiness(db: DatabaseSync, conversationId: string, userSeq: number, messageSeq: number, mutating: boolean): MemoryObligation {
  if (typeof mutating !== 'boolean') fail(400, 'Invalid mutating flag');
  return transaction(db, () => {
    const row = requireTurn(db, conversationId, userSeq), msg = actualToolMessage(db, row, messageSeq);
    const name = callName(db, conversationId, userSeq, msg)!;
    if (/^memory_/.test(name) || msg['display_channel'] === 'maintenance') fail(400, 'Maintenance tools are not business activity');
    if (mutating && json(msg['content'])?.['ok'] !== true) fail(409, 'A failed result cannot prove a successful mutation');
    const old = db.prepare("SELECT mutating FROM memory_obligation_events WHERE conversation_id=? AND user_seq=? AND type='business' AND message_seq=?").get(conversationId, userSeq, messageSeq);
    if (old) { if (Boolean(old['mutating']) !== mutating) fail(409, 'Business evidence has different parameters'); return derive(db, row); }
    addEvent(db, row, 'business', 'required', 'OBLIGATION_BUSINESS', messageSeq, null, mutating);
    return derive(db, row);
  });
}
function verifyProposal(db: DatabaseSync, row: Row, proposalId: string, messageSeq: number): 'progress' | 'triage' {
  id(proposalId, 'proposalId');
  const p = db.prepare('SELECT rowid AS source_rowid,* FROM memory_proposals WHERE id=?').get(proposalId);
  if (!p) fail(404, 'Persisted proposal not found');
  if (p['project_id'] !== row['project_id'] || p['conversation_id'] !== row['conversation_id']) fail(409, 'Proposal source does not match this project and conversation');
  if (Number(p['source_rowid']) <= Number(row['base_proposal_rowid'])) fail(409, 'Old proposal cannot satisfy a new turn');
  if (!['pending','applied'].includes(String(p['status']))) fail(409, 'Only pending or applied successful proposals count');
  const type = evidenceType(p); if (!type) fail(400, 'This proposal is not progress or triage evidence');
  const msg = actualToolMessage(db, row, messageSeq);
  const tool = callName(db, String(row['conversation_id']), Number(row['user_seq']), msg);
  if (!['memory_propose','memory_stage'].includes(tool ?? '') || resultProposal(msg) !== proposalId) fail(409, 'Successful persisted proposal receipt required');
  const user = userMessage(db, String(row['conversation_id']), Number(row['user_seq']));
  if (String(p['created_at']) < String(user['created_at']) || String(p['created_at']) > String(msg['created_at'])) fail(409, 'Proposal creation is outside its source turn');
  // Replaying the same saved proposal in another tool result must not refresh stale evidence.
  const earlier = db.prepare("SELECT * FROM messages WHERE conversation_id=? AND role='tool' AND seq<? AND content LIKE ? ORDER BY seq")
    .all(String(row['conversation_id']), messageSeq, `%${proposalId}%`);
  if (earlier.some(m => resultProposal(m) === proposalId)) fail(409, 'Replayed proposal cannot refresh obligation evidence');
  return type;
}
export function noteObligationProposal(db: DatabaseSync, conversationId: string, userSeq: number, proposalId: string, messageSeq: number): MemoryObligation {
  return transaction(db, () => {
    const row = requireTurn(db, conversationId, userSeq);
    const old = db.prepare('SELECT * FROM memory_obligation_evidence WHERE proposal_id=?').get(proposalId);
    if (old) {
      if (old['conversation_id'] !== conversationId || Number(old['user_seq']) !== userSeq || Number(old['message_seq']) !== messageSeq) fail(409, 'Proposal evidence is already owned by another turn or receipt');
      return derive(db, row);
    }
    const type = verifyProposal(db, row, proposalId, messageSeq);
    const n = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_obligation_evidence WHERE conversation_id=? AND user_seq=?').get(conversationId, userSeq)?.['n']);
    if (n >= MAX_EVIDENCE) fail(409, 'Obligation evidence limit reached');
    db.prepare('INSERT INTO memory_obligation_evidence VALUES(?,?,?,?,?,?,?)').run(randomUUID(), conversationId, userSeq, proposalId, type, messageSeq, new Date().toISOString());
    addEvent(db, row, 'proposal', 'required', 'OBLIGATION_PROPOSAL', messageSeq, proposalId);
    return derive(db, row);
  });
}
function derive(db: DatabaseSync, row: Row): MemoryObligation {
  const conversationId = String(row['conversation_id']), userSeq = Number(row['user_seq']);
  const eventsRaw = db.prepare('SELECT * FROM memory_obligation_events WHERE conversation_id=? AND user_seq=? ORDER BY id').all(conversationId, userSeq);
  const last = eventsRaw.at(-1);
  const lastBusinessSeq = eventsRaw.filter(e => e['type'] === 'business').reduce((max, e) => Math.max(max, Number(e['message_seq'])), userSeq);
  const evidence: ObligationEvidence[] = db.prepare(`SELECT e.*,p.status AS proposal_status,p.project_id AS source_project,p.conversation_id AS source_conversation
    FROM memory_obligation_evidence e LEFT JOIN memory_proposals p ON p.id=e.proposal_id
    WHERE e.conversation_id=? AND e.user_seq=? ORDER BY e.message_seq,e.id`).all(conversationId, userSeq).map(e => ({
      proposalId: String(e['proposal_id']), type: e['type'] as 'progress' | 'triage', messageSeq: Number(e['message_seq']),
      proposalStatus: (e['proposal_status'] ?? null) as ObligationEvidence['proposalStatus'], stale: Number(e['message_seq']) <= lastBusinessSeq,
      valid: ['pending','applied'].includes(String(e['proposal_status'])) && e['source_project'] === row['project_id'] && e['source_conversation'] === conversationId,
      createdAt: String(e['created_at']),
    }));
  const progress = evidence.findLast(e => e.type === 'progress' && e.valid && !e.stale) ?? null;
  const triage = evidence.findLast(e => e.type === 'triage' && e.valid && !e.stale) ?? null;
  let status = (last?.['status'] ?? 'required') as ObligationStatus;
  let code = (last?.['code'] ?? 'OBLIGATION_REQUIRED') as ObligationCode;
  let missing: ('progress' | 'triage')[] = [...(progress ? [] : ['progress' as const]), ...(triage ? [] : ['triage' as const])];
  const stale = missing.some(type => evidence.some(e => e.type === type && e.stale && e.valid));
  if (status !== 'exempt') {
    if (!missing.length && !(status === 'incomplete' && ['OBLIGATION_ERROR','OBLIGATION_ABORT'].includes(code))) { status = 'staged'; if (code !== 'OBLIGATION_RECONCILED') code = 'OBLIGATION_STAGED'; }
    else if (status === 'staged') { status = 'incomplete'; code = stale ? 'OBLIGATION_EVIDENCE_STALE' : 'OBLIGATION_EVIDENCE_INVALID'; }
    else if (stale && status !== 'repairing' && last?.['type'] !== 'finish') code = 'OBLIGATION_EVIDENCE_STALE';
  } else missing = [];
  // V12 interval deferrals are explicit scheduling decisions, never a claim of no progress.
  if (status !== 'staged' && status !== 'exempt' && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_rhythm_checkpoints'").get()) {
    const deferred = db.prepare("SELECT message_seq FROM memory_rhythm_checkpoints WHERE project_id=? AND conversation_id=? AND user_seq=? AND kind='deferred' ORDER BY id DESC LIMIT 1").get(String(row['project_id']),conversationId,userSeq);
    if (deferred && Number(deferred['message_seq']) >= lastBusinessSeq) { status='exempt';code='OBLIGATION_INTERVAL_NOT_DUE';missing=[]; }
  }
  const reason = db.prepare('SELECT source,reason FROM memory_obligation_explanations WHERE conversation_id=? AND user_seq=? ORDER BY rowid DESC LIMIT 1').get(conversationId, userSeq);
  const running = db.prepare('SELECT state FROM conversations WHERE id=?').get(conversationId)?.['state'] === 'running';
  const events: ObligationEvent[] = eventsRaw.map(e => ({ id: Number(e['id']), type: e['type'] as ObligationEvent['type'], code: e['code'] as ObligationCode,
    messageSeq: e['message_seq'] === null ? null : Number(e['message_seq']), proposalId: e['proposal_id'] as string | null, createdAt: String(e['created_at']) }));
  return { id: String(row['id']), projectId: String(row['project_id']), conversationId, userSeq, status, code, missing, stale, lastBusinessSeq,
    mutated: eventsRaw.some(e => e['mutating'] === 1), repairAttempt: db.prepare('SELECT 1 FROM memory_obligation_repairs WHERE conversation_id=? AND user_seq=?').get(conversationId, userSeq) ? 1 : 0,
    progress, triage, evidence, legacy: row['legacy_origin'] === 1, needsReview: false, running,
    reason: reason ? String(reason['reason']) : null, reasonSource: reason ? reason['source'] as 'model' | 'user' : status === 'exempt' ? 'system' : null,
    semanticProof: false, createdAt: String(row['created_at']), updatedAt: String(last?.['created_at'] ?? row['created_at']), events };
}
function legacyEntry(db: DatabaseSync, conv: Row, debt: Row): MemoryObligation {
  const resolution = db.prepare('SELECT reason,created_at FROM memory_obligation_legacy_resolutions WHERE project_id=? AND conversation_id=? AND user_seq=?')
    .get(String(conv['project_id']), String(conv['id']), Number(debt['user_seq']));
  const skipped = debt['code'] === 'checkpoint_skip' || !!resolution;
  return { id: `legacy:${String(conv['id'])}:${Number(debt['user_seq'])}`, projectId: String(conv['project_id']), conversationId: String(conv['id']), userSeq: Number(debt['user_seq']),
    status: skipped ? 'exempt' : 'incomplete', code: skipped ? 'OBLIGATION_USER_SKIP' : 'OBLIGATION_LEGACY_REVIEW', missing: [], stale: false,
    lastBusinessSeq: Number(debt['user_seq']), mutated: false, repairAttempt: 0, progress: null, triage: null, evidence: [], legacy: true,
    needsReview: !skipped, running: conv['state'] === 'running', reason: resolution ? String(resolution['reason']) : null, reasonSource: skipped ? 'user' : null, semanticProof: false,
    createdAt: String(debt['created_at']), updatedAt: String(resolution?.['created_at'] ?? debt['created_at']), events: [] };
}
export function readObligation(db: DatabaseSync, conversationId: string, userSeq: number): MemoryObligation | null {
  id(conversationId, 'conversationId'); seq(userSeq, 'userSeq', 0);
  const row = turnRow(db, conversationId, userSeq); if (row) { project(db, String(row['project_id'])); return derive(db, row); }
  const conv = conversation(db, conversationId); if (!conv['project_id']) return null;
  const debt = db.prepare('SELECT * FROM memory_turn_debts WHERE conversation_id=? AND user_seq=? ORDER BY id DESC LIMIT 1').get(conversationId, userSeq);
  return debt ? legacyEntry(db, conv, debt) : null;
}
export function markObligationRepair(db: DatabaseSync, conversationId: string, userSeq: number, requireThreeDuties = false): boolean {
  return transaction(db, () => {
    const row = requireTurn(db, conversationId, userSeq), current = derive(db, row);
    if (current.repairAttempt || current.status === 'staged' && !requireThreeDuties || current.status === 'exempt') return false;
    db.prepare('INSERT INTO memory_obligation_repairs VALUES(?,?,?)').run(conversationId, userSeq, new Date().toISOString());
    addEvent(db, row, 'repair', 'repairing', 'OBLIGATION_REPAIRING'); return true;
  });
}
const FINISH_MAP: Record<ObligationFinishCode, ObligationCode> = {
  complete: 'OBLIGATION_STAGED', error: 'OBLIGATION_ERROR', abort: 'OBLIGATION_ABORT', readonly: 'OBLIGATION_READONLY',
  registry_missing: 'OBLIGATION_REGISTRY_MISSING', tools_disabled: 'OBLIGATION_TOOLS_DISABLED', repair_exhausted: 'OBLIGATION_REPAIR_EXHAUSTED',
  repair_failed: 'OBLIGATION_REPAIR_FAILED', repair_timeout: 'OBLIGATION_REPAIR_TIMEOUT', repair_input_limit: 'OBLIGATION_REPAIR_INPUT_LIMIT', incomplete: 'OBLIGATION_INCOMPLETE',
};
export function finishObligation(db: DatabaseSync, conversationId: string, userSeq: number, code: ObligationFinishCode): MemoryObligation {
  if (!(OBLIGATION_FINISH_CODES as readonly unknown[]).includes(code)) fail(400, 'Unknown obligation finish code');
  return transaction(db, () => {
    const row = requireTurn(db, conversationId, userSeq), current = derive(db, row);
    if (current.status === 'exempt' || current.status === 'staged' && code !== 'complete') return current;
    const system = ['error','abort','readonly','registry_missing','tools_disabled'].includes(code);
    const hasProgress = current.evidence.some(e => e.type === 'progress');
    const status: ObligationStatus = system ? current.mutated || hasProgress ? 'incomplete' : 'exempt' : current.missing.length ? 'incomplete' : 'staged';
    const diagnostic = code === 'complete' && status === 'incomplete' ? 'OBLIGATION_INCOMPLETE' : FINISH_MAP[code];
    const last = db.prepare('SELECT status,code FROM memory_obligation_events WHERE conversation_id=? AND user_seq=? ORDER BY id DESC LIMIT 1').get(conversationId, userSeq);
    if (last?.['status'] !== status || last['code'] !== diagnostic) addEvent(db, row, 'finish', status, diagnostic);
    return derive(db, row);
  });
}
function validateReason(reason: unknown): asserts reason is string {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 300 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(reason) || containsCredentials(reason)) fail(400, 'Reason must be a short credential-free explanation (1-300 characters), not a message body');
}
function explanation(db: DatabaseSync, row: Row, reason: unknown, source: 'model' | 'user'): string {
  validateReason(reason);
  const u = Number(row['user_seq']), conv = String(row['conversation_id']);
  const messages = db.prepare('SELECT content FROM messages WHERE conversation_id=? AND seq>=? AND seq<? AND content IS NOT NULL').all(conv, u, nextUser(db, conv, u));
  if (messages.some(m => { const body = String(m['content']).trim(); return body === reason.trim() || body.length >= 32 && reason.includes(body); })) fail(400, 'Do not copy complete source messages into obligation explanations');
  db.prepare('INSERT INTO memory_obligation_explanations VALUES(?,?,?,?,?,?,?)').run(randomUUID(), conv, u, source, reason, createHash('sha256').update(reason).digest('hex'), new Date().toISOString());
  return reason;
}
/** Model declaration only, not a semantic proof. Cannot excuse mutations or submitted progress. */
export function exemptObligation(db: DatabaseSync, conversationId: string, userSeq: number, reason: string): MemoryObligation {
  return transaction(db, () => {
    const row = requireTurn(db, conversationId, userSeq), current = derive(db, row);
    const submitted = db.prepare('SELECT * FROM memory_proposals WHERE conversation_id=? AND rowid>?').all(conversationId, Number(row['base_proposal_rowid']));
    if (nextUser(db, conversationId, userSeq) !== Number.MAX_SAFE_INTEGER) fail(409, 'Model disposition may only describe the active turn');
    if (current.mutated || current.evidence.some(e => e.type === 'progress') || submitted.some(p => evidenceType(p) === 'progress')) fail(409, 'no_progress cannot excuse a successful mutation or already submitted progress; triage is still required');
    if (current.status === 'exempt' && current.code === 'OBLIGATION_NO_PROGRESS' && current.reason === reason) return current;
    explanation(db, row, reason, 'model'); addEvent(db, row, 'exempt', 'exempt', 'OBLIGATION_NO_PROGRESS'); return derive(db, row);
  });
}
function allEntries(db: DatabaseSync, projectId: string): MemoryObligation[] {
  const current = db.prepare('SELECT * FROM memory_obligations WHERE project_id=? ORDER BY created_at DESC,conversation_id,user_seq DESC').all(projectId).map(r => derive(db, r));
  const old = db.prepare(`SELECT d.*,c.id AS source_conversation,c.project_id,c.state FROM memory_turn_debts d JOIN conversations c ON c.id=d.conversation_id
    WHERE c.project_id=? AND d.id=(SELECT MAX(x.id) FROM memory_turn_debts x WHERE x.conversation_id=d.conversation_id AND x.user_seq=d.user_seq)
    AND NOT EXISTS(SELECT 1 FROM memory_obligations n WHERE n.conversation_id=d.conversation_id AND n.user_seq=d.user_seq)`).all(projectId)
    .map(r => legacyEntry(db, { id: r['source_conversation'], project_id: r['project_id'], state: r['state'] }, r));
  return [...current,...old].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.conversationId.localeCompare(b.conversationId) || b.userSeq - a.userSeq);
}
function summary(entries: MemoryObligation[]): ObligationSummary {
  return { incomplete: entries.filter(e => !e.needsReview && ['required','incomplete'].includes(e.status)).length,
    repairing: entries.filter(e => !e.needsReview && e.status === 'repairing').length, staged: entries.filter(e => !e.needsReview && e.status === 'staged').length,
    exempt: entries.filter(e => !e.needsReview && e.status === 'exempt').length, needsReview: entries.filter(e => e.needsReview).length, total: entries.length };
}
export function queryObligations(db: DatabaseSync, projectId: string, query: ObligationQuery = {}): ObligationPage {
  project(db, projectId);
  if (!object(query)) fail(400, 'Invalid obligation query');
  const limit = query.limit ?? 20, offset = query.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) fail(400, 'Invalid obligation pagination');
  if (query.includeResolved !== undefined && typeof query.includeResolved !== 'boolean') fail(400, 'Invalid includeResolved');
  if (query.status !== undefined && !(OBLIGATION_STATUSES as readonly unknown[]).includes(query.status) && query.status !== 'needs_review') fail(400, 'Invalid obligation status');
  if (query.conversationId !== undefined) { const conv = conversation(db, query.conversationId); if (conv['project_id'] !== projectId) fail(404, 'Conversation not found in project'); }
  const all = allEntries(db, projectId);
  const filtered = all.filter(e => (!query.conversationId || e.conversationId === query.conversationId)
    && (query.includeResolved === true || !['staged','exempt'].includes(e.status))
    && (!query.status || (query.status === 'needs_review' ? e.needsReview : !e.needsReview && e.status === query.status)));
  return { projectId, summary: summary(all), entries: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
}
function findReceipt(db: DatabaseSync, conversationId: string, proposalId: string): number {
  if (!db.prepare('SELECT id FROM memory_proposals WHERE id=?').get(proposalId)) fail(404, 'Persisted proposal not found');
  const rows = db.prepare("SELECT * FROM messages WHERE conversation_id=? AND role='tool' AND content LIKE ? ORDER BY seq").all(conversationId, `%${proposalId}%`);
  const first = rows.find(m => resultProposal(m) === proposalId); if (!first) fail(409, 'No successful persisted tool receipt for this proposal'); return Number(first['seq']);
}
/** Human-only HTTP adapter uses this; no model generation or formal memory application. */
export function resolveObligation(db: DatabaseSync, projectId: string, input: ResolveObligationInput): ResolveObligationResult {
  return transaction(db, () => {
    project(db, projectId, true);
    if (!object(input)) fail(400, 'Invalid obligation resolution');
    id(input.conversationId, 'conversationId'); seq(input.userSeq, 'userSeq', 0);
    if (!['skip','reconcile'].includes(input.action)) fail(400, 'Invalid obligation action');
    const saved = turnRow(db, input.conversationId, input.userSeq);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(input.conversationId);
    // A deleted/rebound source cannot make its immutable project history impossible to dismiss.
    // Only explicit human skip may use the SAVED project binding; reconciliation still needs a live same-project source.
    if (saved ? saved['project_id'] !== projectId : !conv || conv['project_id'] !== projectId) fail(404, 'Conversation not found in project');
    if (conv?.['state'] === 'running') fail(409, 'Wait until the conversation stops before resolving obligations');
    if (input.action === 'reconcile' && (!conv || conv['project_id'] !== projectId)) fail(409, 'Source conversation is unavailable for evidence reconciliation');
    const previous = readObligation(db, input.conversationId, input.userSeq);
    if (!previous) fail(404, 'Obligation not found');
    let row = turnRow(db, input.conversationId, input.userSeq);
    if (!row && input.action === 'skip') {
      if (input.proposalIds !== undefined) fail(400, 'Skip does not reconcile or approve proposals');
      validateReason(input.reason);
      const old = db.prepare('SELECT reason FROM memory_obligation_legacy_resolutions WHERE conversation_id=? AND user_seq=?').get(input.conversationId, input.userSeq);
      if (old && old['reason'] !== input.reason) fail(409, 'Legacy skip already has a different explanation');
      if (!old) db.prepare('INSERT INTO memory_obligation_legacy_resolutions VALUES(?,?,?,?,?,?,?)').run(randomUUID(), projectId, input.conversationId, input.userSeq, input.reason, createHash('sha256').update(input.reason).digest('hex'), new Date().toISOString());
      return { obligation: readObligation(db, input.conversationId, input.userSeq)!, summary: summary(allEntries(db, projectId)) };
    }
    if (!row) {
      // Explicit user action may reconcile a historical projection; GET NEVER materializes it.
      if (input.userSeq === 0) fail(409, 'Legacy debt has no real user message; cannot fabricate turn evidence');
      if (!conv) fail(404, 'Source conversation is unavailable');
      row = createTurn(db, conv, input.userSeq, true);
    }
    if (input.action === 'skip') {
      if (input.proposalIds !== undefined) fail(400, 'Skip does not reconcile or approve proposals');
      if (previous.code === 'OBLIGATION_USER_SKIP' && previous.reason === input.reason) return { obligation: previous, summary: summary(allEntries(db, projectId)) };
      explanation(db, row, input.reason, 'user'); addEvent(db, row, 'user_skip', 'exempt', 'OBLIGATION_USER_SKIP');
    } else {
      if (input.reason !== undefined) fail(400, 'Reconciliation relies on evidence, not a declaration');
      if (!Array.isArray(input.proposalIds) || input.proposalIds.length < 2 || input.proposalIds.length > MAX_EVIDENCE || new Set(input.proposalIds).size !== input.proposalIds.length) fail(400, 'Reconcile requires distinct saved progress and triage proposal IDs');
      for (const proposalId of input.proposalIds) { id(proposalId, 'proposalId'); noteObligationProposal(db, input.conversationId, input.userSeq, proposalId, findReceipt(db, input.conversationId, proposalId)); }
      const current = derive(db, row); if (!current.progress || !current.triage) fail(409, 'Saved evidence is stale or does not cover both progress and triage');
      addEvent(db, row, 'user_reconcile', 'staged', 'OBLIGATION_RECONCILED');
    }
    return { obligation: derive(db, row), summary: summary(allEntries(db, projectId)) };
  });
}
