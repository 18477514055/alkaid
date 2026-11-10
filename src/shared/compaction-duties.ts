/** Three independent SUCCESSFUL saved receipts, not execution-board updates or tool-call intentions. */
export type DutyKind = 'ledger' | 'log' | 'triage';
export type DutyReceipt = { proposalId: string; messageSeq: number };
export type DutyCheckpoint = {
  /** Deterministic SHA-256 identity of the scoped triplet and its safe source boundary. */
  id: string; projectId: string; conversationId: string; userSeq: number;
  ledger: DutyReceipt; log: DutyReceipt; triage: DutyReceipt;
  /** Before earliest assistant tool_calls batch of these receipts; whole duty group stays verbatim. */
  safeCutSeq: number;
};
export type DutyState = {
  complete: boolean; missing: DutyKind[]; checkpoint: DutyCheckpoint | null;
  reason: 'ready' | 'missing' | 'stale' | 'subagent' | 'no_project';
};
