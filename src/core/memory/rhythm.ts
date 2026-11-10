import type { DatabaseSync } from 'node:sqlite';
import { estimateTokens } from '../context/compact.ts';
import { getConversation, getProject, getProvider, listMessages } from '../store/repo.ts';
import { readObligation } from './obligations.ts';

export const MEMORY_RHYTHM_SCHEMA_SQL = `
CREATE TABLE memory_policies (
 project_id TEXT PRIMARY KEY, threshold_percent REAL NOT NULL CHECK(threshold_percent BETWEEN 0 AND 50)
);
CREATE TABLE memory_rhythm_checkpoints (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 message_seq INTEGER NOT NULL, user_seq INTEGER, kind TEXT NOT NULL CHECK(kind IN ('seed','fulfilled','deferred')),
 created_at TEXT NOT NULL
);
CREATE INDEX memory_rhythm_source ON memory_rhythm_checkpoints(project_id,conversation_id,id);
INSERT INTO memory_rhythm_checkpoints(project_id,conversation_id,message_seq,user_seq,kind,created_at)
 SELECT project_id,id,last_seq,NULL,'seed',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM conversations WHERE project_id IS NOT NULL;
CREATE TRIGGER memory_rhythm_no_update BEFORE UPDATE ON memory_rhythm_checkpoints BEGIN SELECT RAISE(ABORT,'Rhythm checkpoints are append-only'); END;
CREATE TRIGGER memory_rhythm_no_delete BEFORE DELETE ON memory_rhythm_checkpoints BEGIN SELECT RAISE(ABORT,'Rhythm checkpoints are append-only'); END;
CREATE TRIGGER memory_rhythm_no_replace BEFORE INSERT ON memory_rhythm_checkpoints WHEN EXISTS(SELECT 1 FROM memory_rhythm_checkpoints WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Rhythm checkpoints cannot be replaced'); END;
`;
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
export function getMemoryPolicy(db: DatabaseSync, projectId: string): { thresholdPercent: number } {
 if (!getProject(db, projectId)) fail('Project not found',404);
 return { thresholdPercent: Number(db.prepare('SELECT threshold_percent FROM memory_policies WHERE project_id=?').get(projectId)?.['threshold_percent'] ?? 5) };
}
export function setMemoryPolicy(db: DatabaseSync, projectId: string, value: unknown) {
 const project = getProject(db, projectId); if (!project) fail('Project not found',404);
 if (project.archivedAt) fail('Project is archived',409);
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('thresholdPercent' in value)) fail('Only thresholdPercent is accepted');
 const percent = (value as {thresholdPercent:unknown}).thresholdPercent;
 if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 50) fail('thresholdPercent must be between 0 and 50');
 db.prepare('INSERT INTO memory_policies VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET threshold_percent=excluded.threshold_percent').run(projectId,percent);
 return getMemoryPolicy(db,projectId);
}
export type MemoryRhythm = { thresholdPercent: number; addedTokens: number; contextWindow: number; baselineSeq: number; due: boolean; enabled: boolean };
/** Original message bytes counted once. Not billed usage, not resent history, not context waterline differences. */
export function getMemoryRhythm(db: DatabaseSync, conversationId: string): MemoryRhythm {
 const conv = getConversation(db,conversationId); if (!conv) fail('Conversation not found',404);
 const contextWindow = getProvider(db,conv.providerId)?.contextWindow ?? 1_000_000;
 const disabled = { thresholdPercent:5, addedTokens:0, contextWindow, baselineSeq:0, due:false, enabled:false };
 if (!conv.projectId || conv.agentRole === 'subagent') return disabled;
 // Keep old program rollback/inspection safe. GET never migrates or writes.
 if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_policies'").get()) return disabled;
 const {thresholdPercent} = getMemoryPolicy(db,conv.projectId);
 const checkpoints = db.prepare('SELECT * FROM memory_rhythm_checkpoints WHERE project_id=? AND conversation_id=? ORDER BY id DESC').all(conv.projectId,conversationId);
 let baselineSeq=0;
 for (const checkpoint of checkpoints) {
  if (checkpoint['kind']==='deferred') continue;
  if (checkpoint['kind']==='seed') { baselineSeq=Number(checkpoint['message_seq']); break; }
  const obligation=readObligation(db,conversationId,Number(checkpoint['user_seq']));
  if (obligation?.status==='staged') { baselineSeq=Number(checkpoint['message_seq']); break; }
 }
 const addedTokens=listMessages(db,conversationId,baselineSeq).reduce((sum,row)=> {
  if (row.displayChannel==='maintenance' || row.role==='system') return sum;
  const calls=row.toolCalls?.filter(call=>!call.name.startsWith('memory_')&&call.name!=='execution_board');
  // Reasoning is part of our assembled ChatMessage context; billable usage is not.
  return sum+estimateTokens(row.content??'')+estimateTokens(row.reasoning??'')+(calls?.length?estimateTokens(JSON.stringify(calls)):0)+4;
 },0);
 return { thresholdPercent,addedTokens,contextWindow,baselineSeq,due:thresholdPercent===0||addedTokens>contextWindow*thresholdPercent/100,enabled:true };
}
/** Voluntary partial notes under the interval are not missed obligations. No baseline reset. */
export function deferMemoryTurn(db:DatabaseSync,conversationId:string,userSeq:number):void {
 const conv=getConversation(db,conversationId);
 if (!conv?.projectId || conv.agentRole==='subagent') return;
 if (db.prepare("SELECT 1 FROM memory_rhythm_checkpoints WHERE conversation_id=? AND user_seq=? AND kind='deferred'").get(conversationId,userSeq)) return;
 db.prepare("INSERT INTO memory_rhythm_checkpoints(project_id,conversation_id,message_seq,user_seq,kind,created_at) VALUES (?,?,?,?,'deferred',?)").run(conv.projectId,conversationId,conv.lastSeq,userSeq,new Date().toISOString());
}
/** No-progress declarations, user skips, queued principles and invalid proposals never reset the interval. */
export function recordMemoryFulfillment(db: DatabaseSync,conversationId:string,userSeq:number):void {
 const obligation=readObligation(db,conversationId,userSeq);
 if (obligation?.status!=='staged'||!obligation.progress||!obligation.triage) return;
 const messageSeq=Math.max(obligation.progress.messageSeq,obligation.triage.messageSeq);
 if (db.prepare("SELECT 1 FROM memory_rhythm_checkpoints WHERE project_id=? AND conversation_id=? AND user_seq=? AND kind='fulfilled'").get(obligation.projectId,conversationId,userSeq)) return;
 db.prepare("INSERT INTO memory_rhythm_checkpoints(project_id,conversation_id,message_seq,user_seq,kind,created_at) VALUES (?,?,?,?,'fulfilled',?)").run(obligation.projectId,conversationId,messageSeq,userSeq,new Date().toISOString());
}
