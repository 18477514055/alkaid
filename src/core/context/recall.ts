import type { DatabaseSync } from 'node:sqlite';
import type { RecallIndex, RecallIndexQuery, RecallMessagePage, RecallMessageQuery } from '../../shared/recall.ts';
import type { ToolCall, Usage } from '../../shared/types.ts';
import { getConversation, type MessageRow } from '../store/repo.ts';

export const RECALL_INDEX_DEFAULT_LIMIT = 50;
export const RECALL_INDEX_MAX_LIMIT = 100;
export const RECALL_MESSAGE_DEFAULT_CHARS = 12_000;
export const RECALL_MESSAGE_MAX_CHARS = 20_000;
type Row = Record<string, unknown>;
function fail(statusCode: 400 | 404, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function integer(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail(400, `Invalid recall ${name}`);
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(400, 'Invalid recall query fields');
}
function conversation(db: DatabaseSync, conversationId: string): void {
  if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 200 || /[\x00-\x1f]/.test(conversationId)) fail(400, 'Invalid recall conversation');
  if (!getConversation(db, conversationId)) fail(404, 'Recall conversation not found');
}
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function json<T>(value: unknown): T | null {
  if (typeof value !== 'string' || !value.length) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}
/** Matches the repository MessageRow projection, without request-side tool-pair
 * sanitization, text trimming, snippet construction or presentation filtering.
 * Selecting bounded rows here avoids loading a conversation's entire message bodies.
 */
function message(row: Row): MessageRow {
  return {
    id: row.id as string, conversationId: row.conversation_id as string, seq: Number(row.seq),
    role: row.role as MessageRow['role'], displayChannel: row.display_channel === 'maintenance' ? 'maintenance' : 'chat',
    content: text(row.content), reasoning: text(row.reasoning), toolCalls: json<ToolCall[]>(row.tool_calls),
    toolCallId: text(row.tool_call_id), usage: json<Usage>(row.usage), finishReason: text(row.finish_reason), createdAt: row.created_at as string,
  };
}

/** Local read-only index. totalChars always measures the same JSON(MessageRow)
 * representation used by getRecallMessage, never just content.length.
 */
export function getRecallIndex(db: DatabaseSync, conversationId: string, query: RecallIndexQuery = {}): RecallIndex {
  conversation(db, conversationId); fields(query, ['fromSeq', 'toSeq', 'offset', 'limit']);
  const from = query.fromSeq === undefined ? 1 : query.fromSeq, to = query.toSeq === undefined ? Number.MAX_SAFE_INTEGER : query.toSeq;
  const offset = query.offset === undefined ? 0 : query.offset, limit = query.limit === undefined ? RECALL_INDEX_DEFAULT_LIMIT : query.limit;
  integer(from, 'fromSeq', 1); integer(to, 'toSeq', from); integer(offset, 'offset', 0); integer(limit, 'limit', 1, RECALL_INDEX_MAX_LIMIT);
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND seq>=? AND seq<=?').get(conversationId, from, to)?.n ?? 0);
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq>=? AND seq<=? ORDER BY seq ASC LIMIT ? OFFSET ?').all(conversationId, from, to, limit, offset);
  return { conversationId, entries: rows.map(row => {
    const value = message(row);
    return { seq: value.seq, id: value.id, role: value.role, createdAt: value.createdAt, totalChars: JSON.stringify(value).length };
  }), total, offset, limit };
}

/** Entire original MessageRow is addressable, including tails beyond 20k.
 * charOffset/maxChars/nextOffset are UTF-16 code-unit offsets. Concatenation is
 * exact even at caller-selected surrogate boundaries; maxChars=1 must still advance.
 */
export function getRecallMessage(db: DatabaseSync, conversationId: string, query: RecallMessageQuery): RecallMessagePage {
  conversation(db, conversationId); fields(query, ['seq', 'charOffset', 'maxChars']);
  integer(query.seq, 'seq', 1);
  const charOffset = query.charOffset === undefined ? 0 : query.charOffset, maxChars = query.maxChars === undefined ? RECALL_MESSAGE_DEFAULT_CHARS : query.maxChars;
  integer(charOffset, 'charOffset', 0); integer(maxChars, 'maxChars', 1, RECALL_MESSAGE_MAX_CHARS);
  const row = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq=?').get(conversationId, query.seq);
  if (!row) fail(404, 'Recall message not found in this conversation');
  const serialized = JSON.stringify(message(row));
  integer(charOffset, 'charOffset', 0, serialized.length);
  let end = Math.min(serialized.length, charOffset + maxChars);
  if (end < serialized.length && end - charOffset > 1) {
    const left = serialized.charCodeAt(end - 1), right = serialized.charCodeAt(end);
    if (left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF) end--;
  }
  const done = end === serialized.length;
  return { conversationId, seq: query.seq, serialization: 'JSON(MessageRow)', text: serialized.slice(charOffset, end), totalChars: serialized.length, charOffset, nextOffset: done ? null : end, done };
}
