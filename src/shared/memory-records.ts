import type { MemoryKind, MemoryProposal, MemoryRecord } from './memory.ts';

export type GoalState = 'root' | 'active' | 'paused' | 'done' | 'dropped';
export type GoalContent = {
  parentId: string | null; state: GoalState; keyResults: string[]; lessons: string[]; body?: string;
};
export const LESSON_CATEGORIES = ['尺子错', '夹具错', '守卫错', '假设错', '记录错', '其他'] as const;
export const EXPERIENCE_CATEGORIES = ['机制', '入口', '约定', '速查', '其他'] as const;
export type LessonContent = {
  type: 'lesson' | 'experience'; category: string; body: string; fix: string;
  rootCause?: string; source?: string; symptom?: string; scope?: string;
};
export type NoteContent = {
  type: 'problem' | 'research' | 'other'; body: string; rootCause?: string;
  conclusion?: string; documentName?: string;
};
export type RecordIssue = { recordId: string; code: string; message: string };
export type GoalNode = {
  record: MemoryRecord; data: GoalContent | null; childrenIds: string[]; depth: number | null; weight: number;
};
export type GoalTree = { projectId: string; nodes: GoalNode[]; roots: string[]; issues: RecordIssue[] };
export type LessonEntry = { record: MemoryRecord; data: LessonContent | null; rendered: string; issues: RecordIssue[] };
export type LessonSearch = { projectId: string; entries: LessonEntry[]; issues: RecordIssue[] };
export type ArchiveEntry = {
  id: string; projectId: string; recordId: string; projectRevision: number;
  before: MemoryRecord | null; after: MemoryRecord; sourceId: string; createdAt: string;
};
export type ArchiveQuery = { recordId?: string; from?: string; to?: string; revision?: number; limit?: number; offset?: number };
export type ArchivePage = { entries: ArchiveEntry[]; total: number; limit: number; offset: number };
export type ArchiveSnapshot = { entry: ArchiveEntry; side: 'before' | 'after'; snapshot: MemoryRecord | null };
export type MemoryIndexRow = {
  recordId: string; kind: MemoryKind; title: string; score: number;
  ranks: { importance: number; recency: number; stability: number; references: number; volume: number };
};
export type MemoryIndex = { projectId: string; rows: MemoryIndexRow[]; diagnosticOnly: true };
export type PreservedEntry = {
  id: string; projectId: string; recordId: string; proposalId: string;
  current: MemoryRecord; sourceId: string | null; sourceConversationIds: string[];
  proposal: MemoryProposal; createdAt: string;
  resolution: { mergeProposalId: string; createdAt: string } | null;
};
export type PreservedView = { projectId: string; entries: PreservedEntry[] };
/** Produces a new pending proposal at the CURRENT revision. Acceptance is separate. */
export type MergePreservedInput = {
  preservedIds: string[]; conversationId: string; recordId: string;
  title: string; content: string; reason: string; idempotencyKey: string;
};
