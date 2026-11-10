import type { MemoryObligation, ObligationSummary } from './memory-obligations.ts';

export type WaterlineLevel = 'safe' | 'early' | 'warn' | 'urgent';
export type WaterlineWarning = { level: WaterlineLevel; threshold: number | null; message: string };
export type CheckpointChoice = 'skip' | 'record' | 'record_compact' | 'record_handoff';
export type MemoryCheckpoint = {
 id: string; conversationId: string; userSeq: number; createdAt: string;
 status: 'pending' | 'recorded' | 'resolved' | 'failed'; choice: CheckpointChoice | null;
 proposalId: string | null; handoffId: string | null; code: string;
};
export type MemoryContextState = {
 contextTokens: number; contextWindow: number; contextRatio: number;
 warning: WaterlineWarning; checkpoint: MemoryCheckpoint | null;
 debt: { outstanding: boolean; userSeq: number; code: string } | null;
 rhythm?: { thresholdPercent:number; addedTokens:number; contextWindow:number; baselineSeq:number; due:boolean; enabled:boolean };
 compaction?: { enabled:boolean;thresholdPercent:number;due:boolean;missing:('ledger'|'log'|'triage')[] };
  /** Whole-project aggregate; legacy debt above is only a compatibility latest-turn view. */
  obligationSummary?: ObligationSummary;
  currentObligation?: Pick<MemoryObligation, 'userSeq' | 'status' | 'code' | 'missing' | 'repairAttempt'> | null;
};
export type CapsuleQuote = {
 seq: number; messageId: string; text: string | null;
 protected: boolean; notice?: string;
};
export type MemoryCapsule = {
 id: string; capsuleId: string; conversationId: string; fromSeq: number; toSeq: number; createdAt: string;
 users: CapsuleQuote[]; errors: CapsuleQuote[];
 files: { seq: number; tool: 'write' | 'edit'; path: string }[];
 coverage: string;
};
