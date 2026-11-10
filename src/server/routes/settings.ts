import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

import { getProject } from '../../core/store/repo.ts';
import {
  getGeneralSettings,
  getPanelSettings,
  setGeneralSettings,
  setPanelSettings,
} from '../../core/settings/service.ts';

/**
 * 应用设置。两条作用域：
 * - `GET/PATCH /api/settings`            —— 通用设置 + **无项目对话**的右栏设置
 * - `GET/PATCH /api/projects/:id/settings` —— 某项目自己的右栏设置（覆盖全局）
 *
 * ★ 为什么不放 localStorage：桌面壳每次启动换随机端口 ⇒ origin 变 ⇒ 设置每次重启归零。
 *   放服务端后跟着家目录走，更新与重启都不再丢。
 */
export function registerSettingsRoutes(app: FastifyInstance, deps: { db: DatabaseSync }): void {
  const { db } = deps;

  app.get('/api/settings', async () => ({
    general: getGeneralSettings(db),
    // 无项目对话用的右栏设置（同样是新项目的初始值）
    panel: getPanelSettings(db, null),
  }));

  app.patch<{ Body: unknown }>('/api/settings', async (request) => {
    const body = (request.body ?? {}) as { general?: unknown; panel?: unknown };
    return {
      general: body.general === undefined ? getGeneralSettings(db) : setGeneralSettings(db, body.general),
      panel: body.panel === undefined ? getPanelSettings(db, null) : setPanelSettings(db, null, body.panel),
    };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/settings', async (request, reply) => {
    const project = getProject(db, request.params.id);
    if (project === undefined) return reply.code(404).send({ error: '项目不存在' });
    return { panel: getPanelSettings(db, project.id) };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/settings', async (request, reply) => {
    const project = getProject(db, request.params.id);
    if (project === undefined) return reply.code(404).send({ error: '项目不存在' });
    const body = (request.body ?? {}) as { panel?: unknown };
    return { panel: body.panel === undefined ? getPanelSettings(db, project.id) : setPanelSettings(db, project.id, body.panel) };
  });
}
