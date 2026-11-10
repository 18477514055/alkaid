import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../app.ts';

/**
 * 插件管理面。
 *
 * ★ 这里**不提供"安装插件"接口**：V0.1 的插件是放在插件目录里的本地代码，
 *   装插件 = 把代码放进去 = 信任作者。在线安装/市场是任务书 §10.2 F 明确排除的。
 */
export function registerPluginRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/plugins', async () => deps.plugins?.list() ?? []);

  app.patch('/api/plugins/:id', async (request, reply) => {
    const host = deps.plugins;
    if (host === undefined) return reply.code(503).send({ error: '插件宿主未启用' });

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled 必须是 true / false' });
    }

    try {
      await host.setEnabled(id, body.enabled);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }

    return host.list().find((plugin) => plugin.id === id) ?? null;
  });

  app.post('/api/plugins/:id/restart', async (request, reply) => {
    const host = deps.plugins;
    if (host === undefined) return reply.code(503).send({ error: '插件宿主未启用' });

    const { id } = request.params as { id: string };
    await host.start(id);
    return host.list().find((plugin) => plugin.id === id) ?? null;
  });
}
