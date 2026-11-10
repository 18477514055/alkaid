import type { ChatRole } from './types.ts';

/** Pagination counts JavaScript UTF-16 code units, not UTF-8 bytes or Unicode code points. */
export type RecallIndexQuery = { fromSeq?: number; toSeq?: number; offset?: number; limit?: number };
export type RecallMessageQuery = { seq: number; charOffset?: number; maxChars?: number };
export type RecallIndexEntry = { seq: number; id: string; role: ChatRole; createdAt: string; totalChars: number };
export type RecallIndex = { conversationId: string; entries: RecallIndexEntry[]; total: number; offset: number; limit: number };
/** Concatenate text pages in nextOffset order, then JSON.parse once to recover the complete MessageRow.
 * Never parse an individual page as JSON. Even a maxChars=1 split through an emoji
 * is lossless after concatenation because offsets and text retain every UTF-16 code unit.
 */
export type RecallMessagePage = {
  conversationId: string; seq: number; serialization: 'JSON(MessageRow)'; text: string;
  totalChars: number; charOffset: number; nextOffset: number | null; done: boolean;
};
