/** Project memory DTO contract. No credentials, filesystem paths, or host objects. */
export const MEMORY_KINDS = ['active', 'decision', 'goal', 'lesson', 'principle', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryRecord = {
  id: string; kind: MemoryKind; title: string; content: string; revision: number;
  deleted: boolean; updatedAt: string;
};
export type MemoryProposal = {
  id: string; projectId: string; conversationId: string; resourceType: 'ledger';
  recordId: string; kind: MemoryKind; title: string; operation: 'upsert' | 'delete';
  content: string; baseRevision: number; reason: string;
  status: 'pending' | 'applied' | 'rejected' | 'conflict'; createdAt: string; resolvedAt: string | null;
};
export type MaintainerConfig = {
  enabled: boolean; providerId: string | null; model: string | null; quietMs: number;
  maxInputChars: number; maxOutputTokens: number;
  /**
   * 维护模型自己的思考强度（`null` = 用该模型的默认）。
   * ★ 用户要求「允许调整维护模型的思考强度」—— 维护请求是**独立的**上游调用，
   *   它该不该开思考、开到多高，与聊天里那个会话的选择是两件事。
   */
  thinkingEffort: string | null;
  /**
   * ★ 用户开关（默认 **false**）：一轮对话**正常结束**后，把本项目里「不会冲突」的
   * pending 暂存提案自动批准并应用。
   *
   * 判据（三条同时满足才算"不会冲突"，实现在 `core/memory/store.ts`）：
   * ① `baseRevision` 与该记录当前 `revision` 一致（CAS 通过）；
   * ② 同一批里**没有两条提案改同一条记录**（有就整条记录跳过，不半途应用）；
   * ③ `kind` 不是 `principle` —— **原则永远不自动批准**，开关为 true 也一样。
   *
   * ★ 必须显式回落 false：老库的 config JSON 里没有这个键，缺省值不能是 undefined。
   */
  autoApproveOnTurnEnd: boolean;
};
export type MemoryJob = {
  id: string; projectId: string; fingerprint: string;
  state: 'running' | 'applied' | 'failed' | 'deferred' | 'conflict';
  providerId: string; model: string; createdAt: string; finishedAt: string | null;
  error: string | null; inputTokens: number | null; outputTokens: number | null;
};
export type MemoryView = {
  projectId: string; revision: number; records: MemoryRecord[]; proposals: MemoryProposal[];
  jobs: MemoryJob[]; config: MaintainerConfig;
};
export type SubmitMemoryProposal = {
  conversationId: string; recordId: string; kind: MemoryKind; title: string;
  operation: 'upsert' | 'delete'; content: string; baseRevision: number;
  reason: string; idempotencyKey: string;
};
/**
 * 对话改自己**暂存区提案文本**的请求体（`PATCH /api/projects/:id/memory/proposals/:proposalId`）。
 *
 * ★ 只有这两个文本字段可改。`kind` / `recordId` / `baseRevision` / `status` 不在契约里，
 *   传了就是 400 —— 改文本不能变成改身份、改目标或改版本。
 * ★ `conversationId` 是**请求方身份**：必须等于提案的来源对话，否则 403。
 */
export type ProposalTextPatch = { conversationId: string; title?: string; content?: string };
export type MergeDecision = {
  recordId: string; proposalIds: string[]; action: 'upsert' | 'delete' | 'conflict';
  kind: MemoryKind; title: string; content: string; reason: string;
};
export type MergePlan = { decisions: MergeDecision[] };
