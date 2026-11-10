import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

import { NO_PROJECT_SCOPE, readExecutionBoard, updateExecutionBoard } from '../../core/memory/execution.ts';
import { getConversation } from '../../core/store/repo.ts';
import type { UpdateExecutionBoard } from '../../shared/execution.ts';

/**
 * 执行看板（本主对话的目标 / 任务 / 动态）。
 *
 * 两套入口，**同一种数据**：
 * - 项目级：`/api/projects/:id/execution/:conversationId`（原来就有）
 * - **会话级**：`/api/conversations/:id/execution`（2026-11-09 新增）
 *   ★ 为什么需要它：用户要求「没有项目的对话，右侧显示所有不需要项目也能显示和使用的功能」。
 *     执行看板本质是**某个主对话的当前工作状态**，它不需要项目也能存在 ——
 *     所以项目无关的对话用 `project_id = ''` 这个**空串哨兵**存（表上 project_id 是 TEXT NOT NULL，
 *     没有外键，空串不会被误认为任何真实项目）。
 *   ★ 会话级入口**从会话行反查** projectId，所以调用方不能伪造归属：
 *     拿 A 会话的 id 也只能读写 A 自己的看板。
 */
export function registerExecutionRoutes(app: FastifyInstance, deps: { db: DatabaseSync }): void {
  const path = '/api/projects/:id/execution/:conversationId';
  app.get<{ Params: { id: string; conversationId: string } }>(path, async request => readExecutionBoard(deps.db, request.params.id, request.params.conversationId));
  app.patch<{ Params: { id: string; conversationId: string }; Body: unknown }>(path, async request => updateExecutionBoard(deps.db,
    request.params.id, request.params.conversationId, request.body as UpdateExecutionBoard, 'user'));

  /** 会话级：projectId 由会话行决定（无项目 ⇒ 哨兵空串） */
  const own = '/api/conversations/:id/execution';
  const scopeOf = (id: string): { projectId: string } | null => {
    const conversation = getConversation(deps.db, id);
    if (conversation === undefined) return null;
    return { projectId: conversation.projectId ?? NO_PROJECT_SCOPE };
  };

  app.get<{ Params: { id: string } }>(own, async (request, reply) => {
    const scope = scopeOf(request.params.id);
    if (scope === null) return reply.code(404).send({ error: '会话不存在' });
    return readExecutionBoard(deps.db, scope.projectId, request.params.id);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(own, async (request, reply) => {
    const scope = scopeOf(request.params.id);
    if (scope === null) return reply.code(404).send({ error: '会话不存在' });
    return updateExecutionBoard(
      deps.db,
      scope.projectId,
      request.params.id,
      request.body as UpdateExecutionBoard,
      'user',
    );
  });
}
