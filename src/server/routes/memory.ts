import type { FastifyInstance } from 'fastify';

import {
  applyProposalManually, getMemoryView, rejectProposal, setMaintainerConfig, updatePendingProposalText,
} from '../../core/memory/store.ts';
import type { MaintainerConfig, ProposalTextPatch } from '../../shared/memory.ts';
import type { ServerDeps } from '../app.ts';

type ProjectParams = { id: string };
type ProposalParams = ProjectParams & { proposalId: string };

/** Thin project-scoped HTTP adapter. Reading memory never wakes the maintainer. */
export function registerMemoryRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Params: ProjectParams }>('/api/projects/:id/memory', async (request) => {
    return getMemoryView(deps.db, request.params.id);
  });

  app.patch<{ Params: ProjectParams; Body: unknown }>('/api/projects/:id/memory/config', async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Configuration must be an object' });
    }
    // The store validates every field, rejects unknown fields and bumps project CAS.
    const saved = setMaintainerConfig(deps.db, request.params.id, body as Partial<MaintainerConfig>);
    deps.memory.notifyProject(request.params.id);
    return saved;
  });

  app.post<{ Params: ProposalParams }>('/api/projects/:id/memory/proposals/:proposalId/accept', async (request) => {
    const { id, proposalId } = request.params;
    applyProposalManually(deps.db, id, proposalId);
    // Manual resolution cancels stale generations, but never starts a generation.
    deps.memory.projectBusy(id);
    return { ok: true };
  });

  app.post<{ Params: ProposalParams }>('/api/projects/:id/memory/proposals/:proposalId/reject', async (request) => {
    const { id, proposalId } = request.params;
    rejectProposal(deps.db, id, proposalId);
    deps.memory.projectBusy(id);
    return { ok: true };
  });

  /**
   * ★★ 对话改**自己**暂存提案的文本（无需审批）。
   *
   * 语义（实现全在 `core/memory/store.ts` 的 `updatePendingProposalText`）：
   * - 只改 `title` / `content`；带 `kind`/`recordId`/`baseRevision`/`status` ⇒ 400；
   * - 请求方由 `body.conversationId` 声明（本项目没有鉴权层，工具提交路径同样用
   *   这个字段声明来源，所以这里保持同一信任模型）；别人的对话 ⇒ 403；
   * - 非 pending ⇒ 409；不存在 ⇒ 404；
   * - `baseRevision` 不变、状态仍是 pending —— 这条路径不参与审批，也不应用提案。
   *
   * 返回**最新提案 DTO**（状态仍是 pending），前端据此直接刷新那一行。
   */
  app.patch<{ Params: ProposalParams; Body: unknown }>('/api/projects/:id/memory/proposals/:proposalId', async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Proposal patch must be an object' });
    }
    // 字段白名单与全部语义校验都在 store 里（路由只做形状判断，别在这里复写规则）。
    const updated = updatePendingProposalText(
      deps.db, request.params.id, request.params.proposalId, body as ProposalTextPatch,
    );
    // 队列指纹变了：取消陈旧生成，但**不**启动新一轮生成。
    deps.memory.projectBusy(request.params.id);
    return updated;
  });

  app.post<{ Params: ProjectParams }>('/api/projects/:id/memory/retry', async (request, reply) => {
    // Existence/archival checks happen in store. Still requires two authors, all
    // conversations idle, credentials and an entire quiet interval after this click.
    getMemoryView(deps.db, request.params.id);
    deps.memory.retryProject(request.params.id);
    return reply.code(202).send(getMemoryView(deps.db, request.params.id));
  });
}
