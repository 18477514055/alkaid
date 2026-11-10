import type { FastifyInstance } from 'fastify';

import { createProject, assertProjectExists } from '../../core/project/service.ts';
import { deleteProject } from '../../core/project/lifecycle.ts';
import {
  getConversation,
  listConversations,
  listProjects,
  updateProject,
} from '../../core/store/repo.ts';
import type { ServerDeps } from '../app.ts';

export function registerProjectRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/projects', async (request) => {
    const query = request.query as { includeArchived?: string };
    return listProjects(deps.db, query.includeArchived === '1');
  });

  app.post('/api/projects', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; description?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length === 0) return reply.code(400).send({ error: 'name 必填' });

    const project = createProject(deps.db, deps.config, {
      name,
      description: typeof body.description === 'string' ? body.description : null,
    });
    deps.plugins?.broadcast('project.updated', { projectId: project.id });
    return reply.code(201).send(project);
  });

  app.get('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return assertProjectExists(deps.db, id);
    } catch {
      return reply.code(404).send({ error: '项目不存在' });
    }
  });

  app.patch('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (deps.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) === undefined) {
      return reply.code(404).send({ error: '项目不存在' });
    }
    const body = (request.body ?? {}) as { name?: unknown; description?: unknown; archived?: unknown; pinned?: unknown };

    const updated = updateProject(deps.db, id, {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.description === 'string' || body.description === null
        ? { description: body.description as string | null }
        : {}),
      ...(typeof body.archived === 'boolean' ? { archived: body.archived } : {}),
      ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
    });
    return updated ?? reply.code(404).send({ error: '项目不存在' });
  });

  /**
   * 删除项目。**默认只删登记，不动文件**；要删文件必须显式 `?deleteFiles=1`。
   * ★ 文件删除有严格守卫（见 `core/project/lifecycle.ts`）：只删程序自己在
   *   `<home>/projects/<id>/shared` 建的那一份，路径对不上就拒绝删文件、只删登记。
   */
  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { deleteFiles?: string };
    const result = deleteProject(deps.db, deps.config, id, { deleteFiles: query.deleteFiles === '1' });
    if (result === undefined) return reply.code(404).send({ error: '项目不存在' });
    deps.plugins?.broadcast('project.updated', { projectId: id });
    return result;
  });

  app.get('/api/projects/:id/conversations', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      assertProjectExists(deps.db, id);
    } catch {
      return reply.code(404).send({ error: '项目不存在' });
    }
    return listConversations(deps.db, { projectId: id });
  });

  // 只是为了让"对话属于哪个项目"这件事可查（前端用）
  app.get('/api/conversations/:id/project', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = getConversation(deps.db, id);
    if (conversation === undefined) return reply.code(404).send({ error: '会话不存在' });
    if (conversation.projectId === null) return { project: null };
    try {
      return { project: assertProjectExists(deps.db, conversation.projectId) };
    } catch {
      return { project: null };
    }
  });
}
