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

/**
 * 保留上限（审计 `ALK-P3-⑦`）。
 *
 * 这张表**每步插一条**，而且此前**从不删除**：用得越久库越大，备份/同步/迁移全都变慢。
 * 它只是诊断用的流水，不是证据链（真正的历史在消息表与胶囊里），所以可以裁剪。
 *
 * 取 20 万行：按"一轮 40 步、每天 50 轮"估算约等于**三个多月**的可查窗口，
 * 远超实际排查需要，同时把库的大小钉在一个可预期的量级。
 */
export const STEP_EVENT_RETENTION = 200_000;

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

/**
 * 把超出保留上限的旧事件裁掉（审计 `ALK-P3-⑦`）。
 *
 * 判据：按 `id` 保留最新的 `STEP_EVENT_RETENTION` 条，更早的删掉。
 * ★ 为什么按 id 不按时间：id 是单调递增的插入序，不受时钟回拨影响；
 *   而且它天然与"最近用过什么"的查询口径一致。
 * ★ 刻意**不**做成定时器：每次启动跑一次 + 每 N 次插入跑一次就够，
 *   高频裁剪会白白吃 IO（写放大比省下的空间更贵）。
 */
export function pruneStepEvents(db: DatabaseSync, keep: number = STEP_EVENT_RETENTION): number {
  const result = db
    .prepare('DELETE FROM step_events WHERE id <= (SELECT MAX(id) - ? FROM step_events)')
    .run(keep);
  return Number(result.changes ?? 0);
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