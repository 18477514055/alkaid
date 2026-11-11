import { existsSync } from 'node:fs';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';

import { ensureHome, loadConfig } from './config.ts';
import { recoverInterrupted } from './core/agent/delegation.ts';
import { disposeMcpManager, loadMcpServers } from './core/mcp/registry.ts';
import { createMcpConfigureTool, listMcpServers } from './core/mcp/store.ts';
import { PluginHost } from './core/plugin/host.ts';
import { hardenDataHome } from './core/security/harden-data-home.ts';
import { openDatabase } from './core/store/db.ts';
import { migrate } from './core/store/schema.ts';
import { createDefaultRegistry } from './core/tools/index.ts';
import { buildServer, getLocalAuth } from './server/app.ts';
import { pruneStepEvents } from './core/store/audit.ts';

const config = loadConfig();
ensureHome(config);

const db = openDatabase(config.dbPath);
const schemaVersion = migrate(db);

/**
 * ★★ 验收缺口修复（2026-11-11）：把数据目录与其中的敏感文件降为「仅属主 + Medium NRNW」。
 *
 * 实测过：只保护 `local-auth-…` 凭证目录时，**真 Low 进程**仍能读到
 * `secrets.json`（全部 API Key 明文）与 `alkaid.db`（全部会话）——
 * 而 `workspace` 档（默认）下模型只要跑一次 `pwsh` 就能读走。
 * 放在 `migrate` 之后：那时库文件与 WAL 都已生成，显式再打一次标签才覆盖得到。
 */
hardenDataHome(config.home);

// 工具注册表在插件之前建好 —— 插件把工具注册进同一个表
const tools = createDefaultRegistry(db, { secretsPath: config.secretsPath });

/**
 * ★ 启动时修一次"崩溃留下的脏状态"：上一次进程被杀时，还在跑的委派会停在 `running`。
 *   它们**不可能**还在跑（进程都没了），但看板会因此永远显示"进行中"，
 *   用户会一直等一个不会来的结果。
 *
 *   这一步必须在**为任何会话服务之前**做完，否则前端第一次拉看板就会拿到脏数据。
 */
const interrupted = recoverInterrupted(db);
if (interrupted > 0) console.log(`[alkaid] 修复 ${String(interrupted)} 条被中断的委派（上次进程退出时还在跑）`);

/**
 * ★ 裁剪步骤审计表（审计 `ALK-P3-⑦`）：这张表每步插一条、此前永不删除。
 * 在**启动时**裁一次就够 —— 它只是诊断流水，不是证据链；高频裁剪的写放大比省下的空间更贵。
 */
try {
  const pruned = pruneStepEvents(db);
  if (pruned > 0) console.log(`[alkaid] 裁剪 ${String(pruned)} 条过旧的步骤审计`);
} catch (error) {
  // 裁剪失败绝不能拦住启动（老库/只读句柄等极端情况）
  console.warn('[alkaid] 步骤审计裁剪失败（忽略）：', error instanceof Error ? error.message : String(error));
}

const pluginsDir = process.env['ALKAID_PLUGINS']?.trim() ?? join(config.home, 'plugins');
const plugins = new PluginHost({ dir: pluginsDir, registry: tools });
const loaded = await plugins.loadAll();

/**
 * MCP 两件事必须在**监听之前**做完：
 * 1. 注册 `mcp_configure` —— 给模型的配置通道（只在完全权限档可见，绝不回显凭据）。
 * 2. 连接已启用的服务器并注册它们的工具。
 * ★ 不连就重启，注册表里没有这些工具，模型连名字都看不到，「重新连接」也没得点。
 * ★ 单个服务器连不上**不能拦住启动** —— loadMcpServers 内部逐个 try/catch，失败只记状态。
 */
tools.register(createMcpConfigureTool(db, tools));
await loadMcpServers(db, tools);

const app = buildServer({ config, db, tools, plugins });

// 生产形态：把构建好的前端一起发出去（开发时用 `pnpm web:dev` 的 vite 反代）
const webDist = join(import.meta.dirname, '..', 'dist', 'web');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
}

await app.listen({ host: config.host, port: config.port });

const listening = app.server.address();
if (listening === null || typeof listening === 'string') throw new Error('Expected TCP listener');
const localAuth = getLocalAuth(app);
// Private parent/child IPC only: never stdout, argv, env or renderer bootstrap payloads.
if (typeof process.send === 'function') {
  process.send({ type: 'alkaid:ready', url: `http://127.0.0.1:${String(listening.port)}`, localToken: localAuth?.token ?? null });
}
if (localAuth === null) {
  console.warn('[alkaid] WARNING: ALKAID_DISABLE_LOCAL_TOKEN=1 — 本机令牌鉴权已禁用。');
} else {
  console.log(`[alkaid] 本机授权已启用；tokenPath=${localAuth.tokenPath}`);
  console.log(`[alkaid] 浏览器首次访问需手工输入一次性配对码（10分钟、单次）；pairingPath=${localAuth.pairingPath}`);
}
console.log(`[alkaid] listening on http://${config.host}:${String(listening.port)}`);
console.log(`[alkaid] home=${config.home} schema=v${schemaVersion}`);
console.log(`[alkaid] web=${existsSync(webDist) ? webDist : '未构建（用 pnpm web:dev 开发）'}`);
console.log(`[alkaid] plugins=${pluginsDir}`);
for (const plugin of loaded) {
  console.log(`[alkaid]   - ${plugin.id}: ${plugin.status}${plugin.error === null ? '' : `（${plugin.error}）`}`);
}
{
  // MCP 连接结果：失败不该拦住启动，但必须**看得见**（面板里也有同一份状态）
  const servers = listMcpServers(db);
  for (const server of servers) {
    console.log(`[alkaid]   mcp ${server.name}: group=${server.groupMode} enabled=${String(server.enabled)}`);
  }
  if (servers.length === 0) console.log('[alkaid]   mcp: 未配置服务器');
}

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  console.log(`[alkaid] ${signal} → closing`);
  try {
    await plugins.dispose();
    // ★ 必须在 db.close() 之前：MCP 是子进程，留着就会变成孤儿进程
    await disposeMcpManager(tools);
    await app.close();
  } finally {
    db.close();
  }
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
