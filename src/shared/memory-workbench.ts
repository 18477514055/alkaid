import type { MemoryRecord } from './memory.ts';

export type TriageItem = { what: string; why?: string; where?: string };
export type TriageArtifact = { $memory: 'triage'; keep: TriageItem[]; stash: TriageItem[]; drop: TriageItem[]; releaseKeepIds?: string[] };
export type HandoffArtifact = { $memory: 'handoff'; title: string; did: string; state: string; next: string; files: string[]; blocked: string };
export type IntentArtifact = { $memory: 'intent'; conversationId: string; goal: string; did: string; issues: string; next: string };
export type ExtensionEntryArtifact = { $memory: 'extension-entry'; extensionId: string; key: string; action: 'append' | 'replace' | 'delete'; content: string };
export type WorkbenchArtifact = TriageArtifact | HandoffArtifact | IntentArtifact | ExtensionEntryArtifact;
export type ArtifactType = WorkbenchArtifact['$memory'];
export type TriageEntry = TriageItem & { id: string; bucket: 'keep' | 'stash' | 'drop'; sourceId: string; createdAt: string };
export type TriageView = { keep: TriageEntry[]; stash: TriageEntry[]; drop: TriageEntry[]; releasedKeepIds: string[]; counts: { keep: number; stash: number; drop: number } };
export type Handoff = HandoffArtifact & { id: string; recordId: string; sourceId: string; createdAt: string };
export type IntentEntry = IntentArtifact & { id: string; sourceId: string; createdAt: string };
export type ExtensionDefinition = { id: string; name: string; description: string; mode: 'cards' | 'single'; appendOnly: boolean; createdAt: string; entryCount: number; location: string };
export type ExtensionEntry = { id: string; extensionId: string; key: string; action: 'append' | 'replace' | 'delete'; content: string; sourceId: string; createdAt: string };
export type PrincipleReviewCheck = {
  code: 'shape' | 'credentials' | 'baseline' | 'pending_conflict' | 'change' | 'semantic';
  status: 'pass' | 'warning' | 'unknown'; message: string;
};
/** Ready means ready for HUMAN review, never semantic approval or automatic application. */
export type PrincipleProgramReview = {
  processor: 'program'; status: 'ready' | 'needs_attention'; summary: string;
  currentRevision: number; checks: PrincipleReviewCheck[];
};
export type PrincipleProposal = { id: string; recordId: string; title: string; content: string; operation: 'upsert' | 'delete'; baseRevision: number; status: 'pending' | 'approved' | 'rejected'; createdAt: string; resolvedAt: string | null; review?: PrincipleProgramReview };
export type PrincipleAudit = { id: string; proposalId: string; recordId: string; operation: 'approve' | 'reject'; actor: 'human'; summary: string; createdAt: string };
export type PrincipleCurrent = { records: MemoryRecord[]; text: string; approvals: PrincipleAudit[] };
export type UserQuote = { conversationId: string; messageId: string; seq: number; content: string; createdAt: string };
export type UserQuoteGroup = { conversationId: string; messages: UserQuote[] };
export type WorkbenchView = {
  counts: { keep: number; stash: number; drop: number; handoffs: number; pendingPrinciples: number; intents: number; extensions: number };
  triage: TriageView; handoffs: Handoff[]; principles: PrincipleCurrent; pending: PrincipleProposal[]; intents: IntentEntry[]; extensions: ExtensionDefinition[];
};
