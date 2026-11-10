/** Durable local project obligations. Evidence contains pointers, never message/proposal bodies. */
export const OBLIGATION_STATUSES = ['required', 'repairing', 'staged', 'exempt', 'incomplete'] as const;
export type ObligationStatus = typeof OBLIGATION_STATUSES[number];
export const OBLIGATION_FINISH_CODES = ['complete', 'error', 'abort', 'readonly', 'registry_missing', 'tools_disabled', 'repair_exhausted', 'repair_failed', 'repair_timeout', 'repair_input_limit', 'incomplete'] as const;
export type ObligationFinishCode = typeof OBLIGATION_FINISH_CODES[number];
export const OBLIGATION_CODES = [
  'OBLIGATION_INTERVAL_NOT_DUE', 'OBLIGATION_REQUIRED', 'OBLIGATION_BUSINESS', 'OBLIGATION_PROPOSAL', 'OBLIGATION_REPAIRING',
  'OBLIGATION_STAGED', 'OBLIGATION_INCOMPLETE', 'OBLIGATION_REPAIR_EXHAUSTED',
  'OBLIGATION_REPAIR_FAILED', 'OBLIGATION_REPAIR_TIMEOUT', 'OBLIGATION_REPAIR_INPUT_LIMIT',
  'OBLIGATION_NO_PROGRESS', 'OBLIGATION_ERROR', 'OBLIGATION_ABORT', 'OBLIGATION_READONLY',
  'OBLIGATION_REGISTRY_MISSING', 'OBLIGATION_TOOLS_DISABLED', 'OBLIGATION_USER_SKIP',
  'OBLIGATION_RECONCILED', 'OBLIGATION_LEGACY_REVIEW', 'OBLIGATION_EVIDENCE_INVALID', 'OBLIGATION_EVIDENCE_STALE',
] as const;
export type ObligationCode = typeof OBLIGATION_CODES[number];
export type ObligationEvidence = {
  proposalId: string; type: 'progress' | 'triage'; messageSeq: number;
  proposalStatus: 'pending' | 'applied' | 'rejected' | 'conflict' | null;
  stale: boolean; valid: boolean; createdAt: string;
};
export type ObligationEvent = {
  id: number; type: 'begin' | 'business' | 'proposal' | 'repair' | 'finish' | 'exempt' | 'user_skip' | 'user_reconcile';
  code: ObligationCode; messageSeq: number | null; proposalId: string | null; createdAt: string;
};
export type MemoryObligation = {
  id: string; projectId: string; conversationId: string; userSeq: number;
  status: ObligationStatus; code: ObligationCode;
  missing: ('progress' | 'triage')[]; stale: boolean; lastBusinessSeq: number;
  /** Successful side-effect-capable business tool observed; shell's exact file changes remain unknown. */
  mutated: boolean; repairAttempt: 0 | 1; progress: ObligationEvidence | null;
  triage: ObligationEvidence | null; evidence: ObligationEvidence[];
  legacy: boolean; needsReview: boolean; running: boolean;
  reason: string | null; reasonSource: 'model' | 'user' | 'system' | null; semanticProof: false;
  createdAt: string; updatedAt: string; events: ObligationEvent[];
};
export type ObligationQuery = {
  conversationId?: string; status?: ObligationStatus | 'needs_review';
  limit?: number; offset?: number; includeResolved?: boolean;
};
/** Counts are whole-project, independent of filters/pagination. total below is FILTERED rows. */
export type ObligationSummary = {
  incomplete: number; repairing: number; staged: number; exempt: number; needsReview: number; total: number;
};
export type ObligationPage = {
  projectId: string; summary: ObligationSummary; entries: MemoryObligation[];
  total: number; limit: number; offset: number;
};
export type ResolveObligationInput = {
  conversationId: string; userSeq: number; action: 'skip' | 'reconcile'; reason?: string; proposalIds?: string[];
};
export type ResolveObligationResult = { obligation: MemoryObligation; summary: ObligationSummary };
