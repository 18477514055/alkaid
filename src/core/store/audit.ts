import type { DatabaseSync } from 'node:sqlite';

/**
 * 步骤审计（`step_events` 表）。
 *
 * ★ 纪律（D8 §2.5）：**默认不记 prompt 正文、不记工具参数原文**。
 *   只记"发生了什么"：哪个工具、结果状态、拒绝原因码、用量、结束原因。
 *   prompt 里必然含源码与可能的密钥，记了就等于把它们写进数据库。
 */

export const AUDIT_KINDS = ['tool_call', 'policy_denied', 'tool_error', 'provider_error', 'step_end'] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export type StepEvent = {
  readonly id: number;
  readonly conversationId: string;
  readonly stepNo: number;
  readonly kind: AuditKind;
  readonly payload: Record<string, unknown> | null;
  readonly createdAt: string;
};

export type RecordStepInput = {
  readonly conversationId: string;
  readonly stepNo: number;
  readonly kind: AuditKind;
  readonly payload?: Record<string, unknown>;
};

export function recordStepEvent(db: DatabaseSync, input: RecordStepInput): void {
  db.prepare(
    'INSERT INTO step_events (conversation_id, step_no, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    input.conversationId,
    input.stepNo,
    input.kind,
    input.payload === undefined ? null : JSON.stringify(input.payload),
    new Date().toISOString(),
  );
}

export function listStepEvents(db: DatabaseSync, conversationId: string, limit = 200): StepEvent[] {
  const rows = db
    .prepare('SELECT * FROM step_events WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(conversationId, limit) as Array<Record<string, unknown>>;

  return rows.reverse().map((row) => ({
    id: Number(row['id']),
    conversationId: String(row['conversation_id']),
    stepNo: Number(row['step_no']),
    kind: row['kind'] as AuditKind,
    payload: typeof row['payload'] === 'string' ? (JSON.parse(row['payload']) as Record<string, unknown>) : null,
    createdAt: String(row['created_at']),
  }));
}
