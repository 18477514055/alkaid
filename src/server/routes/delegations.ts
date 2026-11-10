import type { FastifyInstance } from 'fastify';

import { readDelegationBoard, recoverInterrupted } from '../../core/agent/delegation.ts';
import type { ServerDeps } from '../app.ts';

/**
 * **委派看板**（子代理概览）。
 *
 * ## ★ 为什么这是**一个**端点而不是三个
 *
 * 用户的要求（2026-11-10）：「一张看板就同时看到各个子代理当前的工作进度、目标和任务，
 * 同时还有他们之间的共享任务看板。」
 *
 * ⇒ 前端打一次就够。如果拆成"子代理列表 / 各自执行板 / 共享板"三个请求，
 *   前端必须自己拼、自己处理"其中一个失败"，而且每加一项数据都要改前端。
 *   在服务端一次拼好，代价是这里多写 30 行，收益是前端只渲染。
 *
 * ## ★ 只读取，不写入
 *
 * 看板是**投影**：所有写入都走工具（模型）或既有路由（用户）。这里没有 PATCH ——
 * 让看板可写会造成"两套写入路径"，它们的校验规则迟早分叉。
 */
export function registerDelegationRoutes(app: FastifyInstance, deps: Pick<ServerDeps, 'db'>): void {
  app.get<{ Params: { id: string } }>('/api/conversations/:id/delegations', async (request, reply) => {
    const { id } = request.params;
    const conversation = deps.db.prepare('SELECT id, agent_role FROM conversations WHERE id = ?').get(id) as
      | { id: string; agent_role: string }
      | undefined;
    if (conversation === undefined) return reply.code(404).send({ error: '会话不存在' });

    /**
     * ★ 子代理**没有自己的委派树** —— 它不会派别人（`delegate` 工具会拒绝）。
     *   所以对子会话请求这个端点，如实回一个空树 + 说明它属于谁，
     *   而不是假装它有一棵树（那会让前端在子会话里显示一个永远空的区块）。
     */
    if (conversation.agent_role === 'subagent') {
      const parent = deps.db
        .prepare('SELECT parent_conversation_id FROM conversations WHERE id = ?')
        .get(id) as { parent_conversation_id: string | null } | undefined;
      return {
        parentConversationId: id,
        entries: [],
        team: null,
        note: '这是子代理会话：它不能再派子代理（树深有界），共享任务板属于派它出来的那个主对话。',
        parentConversationIdOfThisSubagent: parent?.parent_conversation_id ?? null,
      };
    }

    return readDelegationBoard(deps.db, id);
  });

  /**
   * 启动时的**脏状态修复**：进程崩过之后，`running` 的委派其实已经不可能还在跑。
   *
   * ★ 做成一个显式端点（而不是在 `main.ts` 里偷偷跑一次）：这样"什么时候清了什么"
   *   是可查的。`main.ts` 会在监听前调它一次，日志里能看到清了几条。
   */
  app.post('/api/delegations/recover', async () => ({ recovered: recoverInterrupted(deps.db) }));
}
