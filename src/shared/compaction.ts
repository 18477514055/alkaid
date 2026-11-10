/** Unified engine contract. Diagnostics contain pointers/numbers only, never summary or input bodies. */
export const COMPACTION_SOURCES = ['manual','auto','checkpoint'] as const;
export type CompactionSource = typeof COMPACTION_SOURCES[number];
export const COMPACTION_BLOCK_REASONS = ['duties','no_project','subagent','no_checkpoint','no_candidate','input_limit','busy','auto_duplicate','unavailable'] as const;
export type CompactionBlockReason = typeof COMPACTION_BLOCK_REASONS[number];
export type CompactionDuty = 'ledger' | 'log' | 'triage';
export type CompactionPlan = {
 status: 'ready' | 'blocked'; source: CompactionSource; conversationId: string; projectId: string | null;
 reason: CompactionBlockReason | null; missing: CompactionDuty[]; anchorId: string | null;
 fromSeq: number | null; toSeq: number | null;
 candidate: { messageCount: number; inputTokens: number; inputChars: number } | null;
 contextWindow: number; retainedTokens: number; fingerprint: string | null;
};
export const COMPACTION_EVENT_CODES = [
 'COMPACTION_BLOCKED_DUTIES','COMPACTION_BLOCKED_NO_PROJECT','COMPACTION_BLOCKED_SUBAGENT',
 'COMPACTION_BLOCKED_NO_CHECKPOINT','COMPACTION_BLOCKED_NO_CANDIDATE','COMPACTION_BLOCKED_INPUT_LIMIT',
 'COMPACTION_BLOCKED_BUSY','COMPACTION_BLOCKED_AUTO_DUPLICATE','COMPACTION_BLOCKED_UNAVAILABLE',
 'COMPACTION_STARTED','COMPACTION_SUCCEEDED','COMPACTION_CANCELLED','COMPACTION_TIMEOUT',
 'COMPACTION_CHANGED','COMPACTION_SUMMARY_FAILED','COMPACTION_OUTPUT_LIMIT','COMPACTION_CAPSULE_FAILED',
 'COMPACTION_PROVIDER_FAILED','COMPACTION_COMMIT_FAILED','COMPACTION_PERSISTENCE_FAILED','COMPACTION_LEASE_EXPIRED',
] as const;
export type CompactionEventCode = typeof COMPACTION_EVENT_CODES[number];
export type CompactionEvent = {
 id: number; attemptId: string | null; conversationId: string; source: CompactionSource;
 phase: 'blocked' | 'start' | 'success' | 'failure'; code: CompactionEventCode;
 fromSeq: number | null; toSeq: number | null; anchorId: string | null;
 inputTokens: number | null; outputTokens: number | null; durationMs: number | null;
 missing: CompactionDuty[]; timestamp: string; createdAt: string;
};
export type CompactionEventPage = { entries: CompactionEvent[]; total: number; limit: number; offset: number };
export type CompactionState = {
 running: boolean; lastAttempt: { id: string; source: CompactionSource; state: 'running' | 'succeeded' | 'failed';
  anchorId: string; fromSeq: number; toSeq: number; leaseUntil: number; code: CompactionEventCode | null } | null;
 events: CompactionEventPage;
};
