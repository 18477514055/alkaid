import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';

import type { Config } from '../config.ts';
import type { PluginHost } from '../core/plugin/host.ts';
import { currentVersion } from '../core/store/schema.ts';
import { MemoryMaintainer } from '../core/memory/maintainer.ts';
import { registerMemoryRoutes } from './routes/memory.ts';
import { registerMemoryRecordRoutes } from './routes/memory-records.ts';
import { registerMemoryWorkbenchRoutes } from './routes/memory-workbench.ts';
import { registerMemoryContextRoutes } from './routes/memory-context.ts';
import { registerMemoryObligationRoutes } from './routes/memory-obligations.ts';
import { registerCompactionRoutes } from './routes/compaction.ts';
import { registerMemoryPolicyRoutes } from './routes/memory-policy.ts';
import { registerExecutionRoutes } from './routes/execution.ts';
import { getGeneralSettings } from '../core/settings/service.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerMcpRoutes } from './routes/mcp.ts';
import { createDefaultRegistry } from '../core/tools/index.ts';
import type { ToolRegistry } from '../core/tools/types.ts';
import { registerConversationRoutes } from './routes/conversations.ts';
import { registerPluginRoutes } from './routes/plugins.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerProviderRoutes } from './routes/providers.ts';
import { registerToolRoutes } from './routes/tools.ts';
import { registerWorkspaceRoutes } from './routes/workspaces.ts';
import { registerDelegationRoutes } from './routes/delegations.ts';
import { checkRequestTrust, trustPolicyFor } from './trust.ts';

export type ServerDeps = {
  readonly config: Config;
  readonly db: DatabaseSync;
  /** 工具注册表（测试可注入替身） */
  readonly tools: ToolRegistry;
  readonly memory: MemoryMaintainer;
  /** 插件宿主；不传就是"没有插件" */
  readonly plugins?: PluginHost;
};

export type BuildServerInput = {
  readonly config: Config;
  readonly db: DatabaseSync;
  readonly tools?: ToolRegistry;
  readonly memory?: MemoryMaintainer;
  readonly plugins?: PluginHost;
};

/**
 * 装配 HTTP 面。**薄壳**：只做路由、入参校验、错误映射，业务在 `core/`。
 *
 * 返回实例而不直接 listen —— 测试用 `app.inject()` 就能跑完整请求链，
 * 不需要占端口、也不会有"端口被占用"这类假失败。
 */
export function buildServer(input: BuildServerInput): FastifyInstance {
  const deps: ServerDeps = {
    config: input.config,
    db: input.db,
    /**
     * ★ 必须把 `secretsPath` 传进去：`delegate` 工具要用它给子代理签发 provider。
     *   不传的话工具还在表里（这很好 —— 界面能看出"有这个能力"），但每次调用都回
     *   `delegate_unavailable`。这类"功能在但没配好"的**静默失效**最难查，
     *   所以宁可在这里传对，而不是让用户对着一个永远失败的按钮猜。
     *
     * ★ 也要传 `delegateAllowedModels`：用户在「设置 → 子代理」里选的白名单
     *   必须真的约束工具，否则设置面板就是个摆设。
     */
    tools:
      input.tools ??
      (() => {
        const general = getGeneralSettings(input.db);
        return createDefaultRegistry(input.db, {
          secretsPath: input.config.secretsPath,
          delegateAllowedModels: general.delegateAllowedModels,
          delegateAllowParentModel: general.delegateAllowParentModel,
        });
      })(),
    memory: input.memory ?? new MemoryMaintainer({ db: input.db, config: input.config }),
    ...(input.plugins === undefined ? {} : { plugins: input.plugins }),
  };

  // logger:false ⇒ 不装 pino，也就不需要 disableRequestLogging（该选项在 fastify 6 已废弃）
  const app = Fastify({ logger: false });

  const trust = trustPolicyFor(deps.config.host, deps.config.trustedHosts);

  app.get('/api/healthz', async () => {
    // 真查一次库：健康检查若只回 {ok:true} 而不碰依赖，等于没检查
    const schemaVersion = currentVersion(deps.db);
    /**
     * ★ B3「诚实能力广告」(`D7@L361`)：把**这一台**实际的能力与安全姿态写进 healthz，
     *   而不是让前端/接手的人靠猜。
     *
     *   最要紧的是 `trust` 这一段：一个人把 `ALKAID_HOST` 改成 `0.0.0.0` 之后，
     *   打开 healthz 就能看到"现在是双重校验、白名单有哪些" ——
     *   这比在文档里写一句"注意安全"有用得多（文档不会跟着他的部署变）。
     *
     * ★ 这里**只报布尔与数量**，不报密钥、不报文件路径、不报 provider 名。
     */
    return {
      ok: schemaVersion > 0,
      app: 'alkaid',
      version: '0.1.0',
      schemaVersion,
      home: deps.config.home,
      capabilities: {
        streaming: true,
        compact: true,
        tools: { count: deps.tools.list().length },
      },
      trust: {
        bind: deps.config.host,
        requireOrigin: trust.requireOrigin,
        allowedHosts: [...trust.allowedHosts],
        description: trust.description,
      },
    };
  });

  /**
   * ★★ 浏览器信任围栏（B1 / `D7@L358`）：**上生产前的硬前提**。
   *
   * 为什么必须挂在 `onRequest` 而不是某个路由里：
   * 现有的 11 组路由 + 未来新增的路由都会经过它。挂在路由里等于"以后每加一组就要记得加一次"，
   * 那种守卫一定会漏。`onRequest` 最早、且**所有**请求（含 404）都过。
   *
   * 为什么不必担心误伤：策略由 `config.host` 推导 —— 绑回环时只校验 `Host`
   * （正常浏览器访问 `127.0.0.1:8787` 一定带对），绑对外地址时才额外要 `Origin` 同源。
   * 详见 `server/trust.ts` 的文件头。
   */
  app.addHook('onRequest', async (request, reply) => {
    /**
     * ★★ 端口取**请求实际到达的那个端口**（`request.socket.localPort`），不是 `config.port`。
     *
     * 这一条是我自己踩出来的：夹具（`scripts/verify-*.ts`）用
     * `app.listen({ port: 0 })` 拿随机端口，而 `config.port` 仍是默认 8787 ⇒
     * 用配置值比端口会让**每一条夹具请求都 403**，门禁直接红。
     *
     * 更重要的是**判据本身**：比端口的目的是"确认这个 Origin 指的是我自己"，
     * 那唯一可靠的依据就是"这个连接进到我监听的哪个口"。
     * `config.port` 只是"我以为我该在哪个口"，它可能是 0（随机）或已经被改过。
     * 拿"以为"去比"实际"，只会制造假 403 —— 而假 403 会训练人关掉整个围栏。
     */
    const localPort = request.socket.localPort;
    const verdict = checkRequestTrust(
      trust,
      {
        host: typeof request.headers.host === 'string' ? request.headers.host : undefined,
        origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
      },
      typeof localPort === 'number' && localPort > 0 ? localPort : null,
    );
    if (verdict.ok) return;
    /**
     * ★ 拒绝时**不回显**策略细节之外的东西（不回显 key、不回显路径），但要把原因说清：
     *   自建部署的人看到 "Host 不在允许列表" 才知道该加 `ALKAID_TRUSTED_HOSTS`，
     *   否则只会以为服务坏了。
     */
    await reply.code(403).send({ error: { code: 'trust/forbidden', message: `请求来源不受信任：${verdict.reason}` } });
  });

  registerProviderRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerPluginRoutes(app, deps);
  registerToolRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerMemoryRecordRoutes(app, deps);
  registerMemoryWorkbenchRoutes(app, deps);
  registerMemoryContextRoutes(app, deps);
  registerMemoryObligationRoutes(app, deps);
  registerCompactionRoutes(app, deps);
  registerMemoryPolicyRoutes(app, deps);
  registerExecutionRoutes(app, deps);
  registerDelegationRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerMcpRoutes(app, deps);
  app.addHook('onClose', async () => { await deps.memory.close(); });

  app.setErrorHandler((error: { statusCode?: number; message: string }, _request, reply) => {
    const status = error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500;
    void reply.code(status).send({ error: error.message });
  });

  return app;
}
