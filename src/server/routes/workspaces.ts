import type { FastifyInstance } from 'fastify';

import { WorkspaceError, registerWorkspace } from '../../core/workspace/service.ts';
import { deleteWorkspace, getWorkspace, listWorkspaces, updateWorkspace } from '../../core/store/repo.ts';
import type { ServerDeps } from '../app.ts';

export function registerWorkspaceRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/workspaces', async () => listWorkspaces(deps.db));

  app.post('/api/workspaces', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; path?: unknown };
    const name = typeof body.name === 'string' ? body.name : '';
    const path = typeof body.path === 'string' ? body.path : '';
    if (path.trim().length === 0) return reply.code(400).send({ error: 'path 必填' });

    try {
      const workspace = registerWorkspace(deps.db, { name: name.trim().length > 0 ? name : path, path });
      return reply.code(201).send(workspace);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        // 4xx 而不是 500：这是用户输入问题，而且**错误信息要能指导修正**
        return reply.code(error.code === 'duplicate' ? 409 : 400).send({
          error: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  });

  app.get('/api/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = getWorkspace(deps.db, id);
    if (workspace === undefined) return reply.code(404).send({ error: '工作区不存在' });
    return workspace;
  });

  /** 重命名 / 置顶。★ 只改登记，不动磁盘上的目录。 */
  app.patch('/api/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (getWorkspace(deps.db, id) === undefined) return reply.code(404).send({ error: '工作区不存在' });

    const body = (request.body ?? {}) as { name?: unknown; pinned?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    if (name !== undefined && name.length === 0) return reply.code(400).send({ error: 'name 不能为空' });

    const updated = updateWorkspace(deps.db, id, {
      ...(name === undefined ? {} : { name }),
      ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
    });
    return updated ?? reply.code(404).send({ error: '工作区不存在' });
  });

  app.delete('/api/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deleteWorkspace(deps.db, id)) return reply.code(404).send({ error: '工作区不存在' });
    // ★ 只删登记，不删磁盘文件（任务书 §3.3：工作区是独立资源）
    return { ok: true };
  });
}
