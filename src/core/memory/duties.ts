import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readObligation } from './obligations.ts';
import type { DutyCheckpoint, DutyKind, DutyReceipt, DutyState } from '../../shared/compaction-duties.ts';

type Row = Record<string, unknown>;
type Call = { name: string; batchSeq: number; maintenance: boolean };
type Candidate = DutyReceipt & { kind: DutyKind; batchSeq: number };
const KINDS: DutyKind[] = ['ledger','log','triage'];
const IGNORED_FAILURES = new Set(['tool_not_found','tool_disabled','denied_by_policy']);
function fail(statusCode: 400 | 404, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function object(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function json(value: unknown): Row | null {
  if (typeof value !== 'string') return null;
  try { const out: unknown = JSON.parse(value); return object(out) ? out : null; } catch { return null; }
}
function unavailable(reason: DutyState['reason'], missing = KINDS): DutyState { return { complete: false, missing: [...missing], checkpoint: null, reason }; }
function conversation(db: DatabaseSync, conversationId: string): Row {
  if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 200) fail(400, 'Invalid duty conversationId');
  const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
  if (!row) fail(404, 'Duty source conversation not found'); return row;
}
function callsOf(row: Row): { id: string; name: string; maintenance: boolean }[] {
  try {
    const values: unknown = JSON.parse(String(row['tool_calls'] ?? 'null')); if (!Array.isArray(values)) return [];
    return values.flatMap(value => object(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string'
      ? [{ id: value['id'], name: value['name'], maintenance: value['displayChannel'] === 'maintenance' || row['display_channel'] === 'maintenance' }] : []);
  } catch { return []; }
}
function savedProposalId(message: Row): string | null {
  const result = json(message['content']); if (result?.['ok'] !== true) return null;
  const payload = json(result['content']);
  return object(payload?.['proposal']) && typeof payload['proposal']['id'] === 'string' && payload['pendingHumanApproval'] !== true ? payload['proposal']['id'] : null;
}
function dutyKind(proposal: Row, conversationId: string): DutyKind | null {
  if (proposal['kind'] === 'principle') return null;
  const id = String(proposal['record_id']);
  if (!id.startsWith('artifact:')) return ['active','decision','goal','lesson','note'].includes(String(proposal['kind'])) ? 'ledger' : null;
  if (proposal['kind'] !== 'note' || proposal['operation'] !== 'upsert') return null;
  const payload = json(proposal['content']);
  if (/^artifact:intent:[A-Za-z0-9_-]+$/.test(id) && payload?.['$memory'] === 'intent' && payload['conversationId'] === conversationId) return 'log';
  if (/^artifact:triage:[A-Za-z0-9_-]+$/.test(id) && payload?.['$memory'] === 'triage') return 'triage';
  if (/^artifact:handoff:[A-Za-z0-9_-]+$/.test(id) && payload?.['$memory'] === 'handoff') return 'ledger';
  return null;
}
/**
 * GET-only projection. Same turn/project/conversation, three different persisted proposals,
 * successful original tool receipts, all AFTER latest business and triage AFTER ledger/log.
 * No deferred/seed/exempt/skip marker can substitute for any of these three actual receipts.
 */
export function getCompactionDuties(db: DatabaseSync, conversationId: string, userSeq?: number): DutyState {
  const conv = conversation(db, conversationId);
  if (conv['agent_role'] === 'subagent') return unavailable('subagent');
  const projectId = conv['project_id'];
  if (typeof projectId !== 'string' || !projectId || !db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) return unavailable('no_project');
  if (userSeq !== undefined && (!Number.isSafeInteger(userSeq) || userSeq < 0)) fail(400, 'Invalid duty userSeq');
  const currentUserSeq = userSeq ?? Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE conversation_id=? AND role='user'").get(conversationId)?.['seq']);
  if (!currentUserSeq) return unavailable('missing');
  const user = db.prepare("SELECT * FROM messages WHERE conversation_id=? AND seq=? AND role='user'").get(conversationId, currentUserSeq);
  if (!user) return unavailable('missing');
  const turn = db.prepare('SELECT * FROM memory_obligations WHERE conversation_id=? AND user_seq=?').get(conversationId, currentUserSeq);
  if (!turn || turn['project_id'] !== projectId || turn['user_message_id'] !== user['id']) return unavailable('missing');
  const obligation = readObligation(db, conversationId, currentUserSeq);
  if (!obligation || obligation.projectId !== projectId) return unavailable('missing');

  // Read original messages, not a compacted surface or tool/call intentions. Also inspect
  // later turns without an obligation: a later chat read is still NEW business knowledge.
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq').all(conversationId);
  const bySeq = new Map(messages.map(m => [Number(m['seq']), m]));
  const resultCalls = new Map<number, Call>();
  const pendingCalls = new Map<string, Call>();
  const firstSuccessfulReceipt = new Map<string, number>();
  let nextUserSeq = Number.MAX_SAFE_INTEGER, lastBusinessSeq = currentUserSeq;
  for (const message of messages) {
    const seq = Number(message['seq']);
    if (message['role'] === 'assistant') for (const call of callsOf(message)) pendingCalls.set(call.id, { name: call.name, batchSeq: seq, maintenance: call.maintenance });
    if (message['role'] === 'user' && seq > currentUserSeq) nextUserSeq = Math.min(nextUserSeq, seq);
    if (message['role'] !== 'tool') continue;
    const callId = message['tool_call_id'];
    const call = typeof callId === 'string' ? pendingCalls.get(callId) : undefined;
    if (call) resultCalls.set(seq, call);
    const proposalId = savedProposalId(message);
    if (proposalId && !firstSuccessfulReceipt.has(proposalId)) firstSuccessfulReceipt.set(proposalId, seq);
    if (seq <= currentUserSeq || message['display_channel'] === 'maintenance' || call?.maintenance) continue;
    if (call?.name === 'describe_tool' || call?.name.startsWith('memory_') || call?.name === 'execution_board') continue;
    const result = json(message['content']);
    if (result && IGNORED_FAILURES.has(String(result['code']))) continue;
    // Unknown/damaged chat tool replies cannot silently make older evidence fresh.
    // Other failed actual tools count as activity, matching captureObligationTool.
    lastBusinessSeq = Math.max(lastBusinessSeq, seq);
  }

  const candidates: Candidate[] = [];
  const latestAttempt: Record<DutyKind, number> = { ledger: 0, log: 0, triage: 0 };
  for (const evidence of obligation.evidence) {
    if (evidence.messageSeq <= currentUserSeq || evidence.messageSeq >= nextUserSeq) continue;
    const p = db.prepare('SELECT rowid AS source_rowid,* FROM memory_proposals WHERE id=?').get(evidence.proposalId);
    if (!p) {
      // A lost latest source must not resurrect an older checkpoint as if nothing changed.
      for (const k of evidence.type === 'triage' ? ['triage'] as const : ['ledger','log'] as const) latestAttempt[k] = Math.max(latestAttempt[k], evidence.messageSeq);
      continue;
    }
    if (p['project_id'] !== projectId || p['conversation_id'] !== conversationId) continue;
    const declaredKind = dutyKind(p, conversationId);
    if (declaredKind) latestAttempt[declaredKind] = Math.max(latestAttempt[declaredKind], evidence.messageSeq);
    if (!evidence.valid || !['pending','applied'].includes(String(p['status']))) continue;
    if (Number(p['source_rowid']) <= Number(turn['base_proposal_rowid'])) continue;
    const message = bySeq.get(evidence.messageSeq), call = resultCalls.get(evidence.messageSeq);
    if (!message || !call || call.batchSeq <= currentUserSeq || call.batchSeq >= evidence.messageSeq || !['memory_propose','memory_stage'].includes(call.name)) continue;
    if (savedProposalId(message) !== evidence.proposalId || firstSuccessfulReceipt.get(evidence.proposalId) !== evidence.messageSeq) continue;
    if (String(p['created_at']) < String(user['created_at']) || String(p['created_at']) > String(message['created_at'])) continue;
    const kind = dutyKind(p, conversationId); if (!kind) continue;
    if ((kind === 'triage') !== (evidence.type === 'triage')) continue;
    candidates.push({ kind, proposalId: evidence.proposalId, messageSeq: evidence.messageSeq, batchSeq: call.batchSeq });
  }
  candidates.sort((a, b) => b.messageSeq - a.messageSeq || a.proposalId.localeCompare(b.proposalId));
  const ledger = candidates.find(c => c.kind === 'ledger' && c.messageSeq === latestAttempt.ledger && c.messageSeq > lastBusinessSeq);
  const log = candidates.find(c => c.kind === 'log' && c.messageSeq === latestAttempt.log && c.messageSeq > lastBusinessSeq);
  const triage = ledger && log ? candidates.find(c => c.kind === 'triage' && c.messageSeq === latestAttempt.triage && c.messageSeq > Math.max(lastBusinessSeq, ledger.messageSeq, log.messageSeq)) : undefined;
  const missing: DutyKind[] = [...(ledger ? [] : ['ledger' as const]), ...(log ? [] : ['log' as const]), ...(triage ? [] : ['triage' as const])];
  if (!ledger || !log || !triage) {
    const stale = candidates.some(c => c.messageSeq <= lastBusinessSeq) || !!(ledger && log && candidates.some(c => c.kind === 'triage'));
    return unavailable(stale ? 'stale' : 'missing', missing);
  }
  if (new Set([ledger.proposalId,log.proposalId,triage.proposalId]).size !== 3) return unavailable('missing');
  const receipt = (c: Candidate): DutyReceipt => ({ proposalId: c.proposalId, messageSeq: c.messageSeq });
  const source = { projectId, conversationId, userSeq: currentUserSeq, ledger: receipt(ledger), log: receipt(log), triage: receipt(triage),
    safeCutSeq: Math.min(ledger.batchSeq, log.batchSeq, triage.batchSeq) - 1 };
  const checkpoint: DutyCheckpoint = { id: createHash('sha256').update(JSON.stringify(source)).digest('hex'), ...source };
  return { complete: true, missing: [], checkpoint, reason: 'ready' };
}
/** Latest actual user turn only: never fall back to an old anchor to disguise a new gap/stale proof. */
export function getLatestCompactionCheckpoint(db: DatabaseSync, conversationId: string): DutyCheckpoint | null {
  return getCompactionDuties(db, conversationId).checkpoint;
}
