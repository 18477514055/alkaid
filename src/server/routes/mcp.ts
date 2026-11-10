import type { FastifyInstance, FastifyReply } from 'fastify';

import type { McpServerDto } from '../../shared/mcp.ts';
import { mcpManager } from '../../core/mcp/registry.ts';
import {
  McpValidationError,
  deleteMcpServer,
  getMcpServer,
  insertMcpServer,
  isMcpGroupMode,
  listMcpServers,
  sameConnection,
  toMcpServerDto,
  updateMcpServer,
  type McpServerRecord,
} from '../../core/mcp/store.ts';
import type { ServerDeps } from '../app.ts';

/**
 * MCP 管理面（`/api/mcp/servers`）。
 *
 * ## ★ 薄壳三件事：校验、错误映射、拼 DTO
 *
 * 真实逻辑在 `core/mcp/`：读写库在 `store.ts`，连接与工具注册在 `registry.ts`，
 * 协议在 `client.ts`。这里**不碰** `child_process`、也不碰 SQL。
 *
 * ## ★★ 三条判据
 *
 * 1. **新增/修改不因连不上而失败**。配错一台服务器是常态 —— 返回 201/200 并把
 *    `status: 'error'` 与原因放进 DTO，用户才能在面板里看到"到底哪一步错了"。
 * 2. **凭据永不下发**。响应体一律走 `toMcpServerDto`（只有 `envKeys` / `headerKeys`）。
 * 3. **改连接参数才重连**。只改整组模式时不重启进程（服务器状态不该因为点了个开关就丢）。
 */

function dto(deps: ServerDeps, record: McpServerRecord): McpServerDto {
  return toMcpServerDto(record, mcpManager(deps.db, deps.tools).runtime(record));
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof McpValidationError) {
    const code = error.status === 409 ? 409 : error.status === 404 ? 404 : 400;
    return reply.code(code).send({ error: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  // ★ 不带任何 env / headers 值：错误消息里的凭据在更下层（client / registry）已经抹掉了
  return reply.code(500).send({ error: `MCP 操作失败：${message}` });
}

export function registerMcpRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /** 列出全部服务器（含运行期状态与已注册的工具名） */
  app.get('/api/mcp/servers', async (): Promise<McpServerDto[]> => {
    return listMcpServers(deps.db).map((record) => dto(deps, record));
  });

  app.post('/api/mcp/servers', async (request, reply) => {
    try {
      const record = insertMcpServer(deps.db, request.body ?? {});
      // 先连一次：新增完就能看到 ready / error，而不是要用户再点一次「重新连接」
      const info = await mcpManager(deps.db, deps.tools).connect(record);
      return reply.code(201).send(toMcpServerDto(record, info));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/api/mcp/servers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const before = getMcpServer(deps.db, id);
      if (before === undefined) return reply.code(404).send({ error: `没有 id 为「${id}」的 MCP 服务器` });

      const after = updateMcpServer(deps.db, id, request.body ?? {});
      const manager = mcpManager(deps.db, deps.tools);

      if (!sameConnection(before, after) || before.enabled !== after.enabled) {
        // 连接参数（或启停）变了 ⇒ 必须重连：工具名可能跟着服务器名一起变
        const info = await manager.connect(after);
        return reply.send(toMcpServerDto(after, info));
      }

      if (after.groupMode !== before.groupMode) {
        // 只改了整组默认 ⇒ 不重启进程，只按新默认重新注册（tool_settings 一行不动）
        return reply.send(toMcpServerDto(after, manager.relevel(after)));
      }

      return reply.send(toMcpServerDto(after, manager.runtime(after)));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/mcp/servers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      // 先断连接再删行：反过来的话，工具会留在一个已经不存在的服务器名下
      await mcpManager(deps.db, deps.tools).disconnect(id);
      if (!deleteMcpServer(deps.db, id)) {
        return reply.code(404).send({ error: `没有 id 为「${id}」的 MCP 服务器` });
      }
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** 重连 + 重新拉工具列表并重新注册 */
  app.post('/api/mcp/servers/:id/reconnect', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const record = getMcpServer(deps.db, id);
      if (record === undefined) return reply.code(404).send({ error: `没有 id 为「${id}」的 MCP 服务器` });
      const info = await mcpManager(deps.db, deps.tools).connect(record);
      return reply.send(toMcpServerDto(record, info));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** 整组批量设模式：该服务器的全部工具一次写入 tool_settings */
  app.post('/api/mcp/servers/:id/mode', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const record = getMcpServer(deps.db, id);
      if (record === undefined) return reply.code(404).send({ error: `没有 id 为「${id}」的 MCP 服务器` });

      const body = (request.body ?? {}) as { mode?: unknown };
      if (!isMcpGroupMode(body.mode)) {
        return reply
          .code(400)
          .send({ error: "mode 必须是 'resident' / 'lazy' / 'disabled' 之一", received: typeof body.mode });
      }

      const info = await mcpManager(deps.db, deps.tools).setGroupMode(record, body.mode);
      // 落库后回读，不用入参拼 DTO
      const updated = getMcpServer(deps.db, id) ?? record;
      return reply.send(toMcpServerDto(updated, info));
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
