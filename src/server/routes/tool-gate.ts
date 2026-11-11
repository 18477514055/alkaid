import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../app.ts';
import { resolvePermissionMode } from '../../core/policy/mode.ts';
import { listToolViews, setToolMode } from '../../core/tools/settings.ts';
import { mcpManager } from '../../core/mcp/registry.ts';
import { listMcpServers } from '../../core/mcp/store.ts';
import {
  applyToolTemplateToConversation, applyToolTemplateToGlobal, clearAllConversationToolModes,
  clearConversationToolMode, createToolTemplate, deleteToolTemplate, effectiveToolModes,
  getToolTemplate, isToolMode, listConversationToolModes, listToolTemplates,
  setConversationToolMode, setDefaultToolTemplate, snapshotModes,
} from '../../core/tools/gate.ts';

/**
 * 工具门控（v18）：**全局默认** + **会话级工具集** + **模板**。
 *
 * ## 为什么单独一个路由文件
 * 老的 `/api/tools` 语义是"全局那张表"，已经被前端与测试依赖。硬把会话维度塞进去，
 * 会让"不传 conversationId 就等于全局"这种隐式规则散落在各处。
 * 这里显式：**有没有 `conversationId`，决定改的是哪一层**。
 *
 * ## 统计口径（用户要的 个数 / 体积 / tokens / 最近使用）
 * - 体积 = 该工具 `parameters` 的 JSON 字符数（模型实际要读的那份）
 * - tokens ≈ 体积 / 3.5（粗估；界面标 `~`，不当成真账单）
 * - 最近使用取 `tool_settings.last_used_at`（真实调用才记）
 *
 * ## 判据
 * - `GET` 只读：不会"顺手补齐默认值"（否则"没配过"变成"配过"）
 * - `PATCH` 一次只改一个工具（两个窗口各改一个，不会互相覆盖）
 * - 会话覆盖**只存差异**：删掉覆盖即回到"跟随全局"
 */
const TOKENS_PER_CHAR = 3.5;

export function registerToolGateRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /** 一次拿全：工具（带体积/用量）+ 会话覆盖 + 生效值 + 模板 */
  app.get('/api/tool-gate', async (request, reply) => {
    const query = request.query as { mode?: string; conversationId?: string };
    const conversationId = typeof query.conversationId === 'string' && query.conversationId.length > 0
      ? query.conversationId
      : null;
    if (conversationId !== null && deps.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId) === undefined) {
      return reply.code(404).send({ error: '会话不存在' });
    }

    const permissionMode = resolvePermissionMode(query.mode);
    const views = listToolViews(deps.db, deps.tools, permissionMode);
    const effective = effectiveToolModes(deps.db, conversationId);
    const overrides = conversationId === null ? new Map() : listConversationToolModes(deps.db, conversationId);

    const definitions = new Map(deps.tools.list().map((tool) => [tool.name, tool.definition]));
    const shapes = new Map(
      deps.tools.list().map((tool) => [tool.name, JSON.stringify(tool.definition.parameters).length]),
    );

    /**
     * ★★ **归属由服务端说，前端不要猜**（2026-11-11 审计 `ALK-HIGH-09`）。
     *
     * 上一版前端按 `__` 切分工子名——可工具名的真实形状是
     * `mcp_<服务器>_<工具>` 与 `p_<插件id>_<工具>`（**单下划线**，且服务器名里本来就可能带下划线，
     * 还可能在超长时被截断+哈希）。于是所有 MCP 工具都坍进一个叫 "mcp" 的组，
     * 所有插件坍进 "plugin" —— 用户没法按服务器看体积、按组开关。
     *
     * 现在在这里用**注册表知道的**对应关系（MCP 的 toolNames / 插件的 toolNames）反查，
     * 前端只认 `ownerKey/ownerLabel`。
     */
    const owners = new Map<string, { key: string; label: string; hint: string }>();
    try {
      const manager = mcpManager(deps.db, deps.tools);
      for (const record of listMcpServers(deps.db)) {
        for (const name of manager.runtime(record).toolNames) {
          owners.set(name, { key: `mcp:${record.name}`, label: record.name, hint: 'MCP 服务器' });
        }
      }
    } catch {
      // MCP 子系统没起来不该拖垮工具面板
    }
    for (const info of deps.plugins?.list() ?? []) {
      for (const name of info.toolNames) {
        owners.set(name, { key: `plugin:${info.id}`, label: info.name, hint: '插件' });
      }
    }

    const tools = views.map((view) => {
      const sizeChars = shapes.get(view.name) ?? 0;
      const owner = owners.get(view.name);
      return {
        name: view.name,
        displayName: view.displayName,
        oneLiner: view.oneLiner,
        group: view.group,
        kind: view.kind,
        source: view.source,
        /** ★ 归属（服务端算好的）：MCP 服务器 / 插件；内置工具为 null，按 `group` 分 */
        ownerKey: owner?.key ?? null,
        ownerLabel: owner?.label ?? null,
        ownerHint: owner?.hint ?? null,
        available: definitions.has(view.name),
        /** 全局那一层的值 */
        globalMode: view.mode,
        /** 这个会话有没有自己的覆盖 */
        overridden: overrides.has(view.name),
        /** 这一轮真正生效的值 */
        mode: effective.get(view.name) ?? view.mode,
        defaultMode: view.defaultMode,
        visibleInMode: view.visibleInMode,
        sizeChars,
        tokens: Math.round(sizeChars / TOKENS_PER_CHAR),
        useCount: view.useCount,
        lastUsedAt: view.lastUsedAt,
      };
    });

    return {
      permissionMode,
      conversationId,
      tools,
      templates: listToolTemplates(deps.db),
      summary: {
        total: tools.length,
        visible: tools.filter((tool) => tool.visibleInMode).length,
        overridden: tools.filter((tool) => tool.overridden).length,
        residentChars: tools.filter((tool) => tool.visibleInMode && tool.mode === 'resident').reduce((sum, tool) => sum + tool.sizeChars, 0),
        lazyChars: tools.filter((tool) => tool.visibleInMode && tool.mode === 'lazy').reduce((sum, tool) => sum + tool.sizeChars, 0),
        disabledChars: tools.filter((tool) => tool.visibleInMode && tool.mode === 'disabled').reduce((sum, tool) => sum + tool.sizeChars, 0),
      },
    };
  });

  /**
   * 改一个工具。
   * body：`{ name, mode }` 或 `{ name, reset: true }`；带 `conversationId` 就改会话层，否则改全局。
   */
  app.patch('/api/tool-gate', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (name.length === 0) return reply.code(400).send({ error: 'name 必填' });
    const conversationId = typeof body['conversationId'] === 'string' && body['conversationId'].length > 0
      ? body['conversationId']
      : null;
    if (conversationId !== null && deps.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId) === undefined) {
      return reply.code(404).send({ error: '会话不存在' });
    }
    /** ★ 不存在的工具要 404：静默成功会让界面显示"已保存"而其实什么都没发生 */
    const known = deps.tools.list().some((tool) => tool.name === name)
      || deps.db.prepare('SELECT 1 FROM tool_settings WHERE name = ?').get(name) !== undefined;
    if (!known) return reply.code(404).send({ error: `没有这个工具：${name}` });

    if (body['reset'] === true) {
      if (conversationId === null) {
        deps.db.prepare('DELETE FROM tool_settings WHERE name = ?').run(name);
      } else {
        clearConversationToolMode(deps.db, conversationId, name);
      }
      return { ok: true, name, reset: true, conversationId };
    }

    const mode = body['mode'];
    if (!isToolMode(mode)) return reply.code(400).send({ error: 'mode 必须是 resident / lazy / disabled' });
    if (conversationId === null) setToolMode(deps.db, name, mode);
    else setConversationToolMode(deps.db, conversationId, name, mode);
    return { ok: true, name, mode, conversationId };
  });

  /** 清空某个会话的全部覆盖 ⇒ 它整体回到跟随全局 */
  app.post('/api/tool-gate/reset-conversation', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const conversationId = typeof body['conversationId'] === 'string' ? body['conversationId'] : '';
    if (conversationId.length === 0) return reply.code(400).send({ error: 'conversationId 必填' });
    if (deps.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId) === undefined) {
      return reply.code(404).send({ error: '会话不存在' });
    }
    return { cleared: clearAllConversationToolModes(deps.db, conversationId) };
  });

  /** 把「现在这一套」存成模板（会话维度存会话生效值；不传会话则存全局） */
  app.post('/api/tool-gate/templates', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'] : '';
    const conversationId = typeof body['conversationId'] === 'string' && body['conversationId'].length > 0
      ? body['conversationId']
      : null;
    try {
      const template = createToolTemplate(deps.db, name, snapshotModes(deps.db, conversationId));
      return reply.code(201).send(template);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 套用模板：带 conversationId 套到那个会话，不带则套到全局 */
  app.post('/api/tool-gate/templates/:id/apply', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (getToolTemplate(deps.db, id) === undefined) return reply.code(404).send({ error: '模板不存在' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const conversationId = typeof body['conversationId'] === 'string' && body['conversationId'].length > 0
      ? body['conversationId']
      : null;
    if (conversationId !== null && deps.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId) === undefined) {
      return reply.code(404).send({ error: '会话不存在' });
    }
    const changed = conversationId === null
      ? applyToolTemplateToGlobal(deps.db, id)
      : applyToolTemplateToConversation(deps.db, conversationId, id);
    return { ok: true, changed, conversationId };
  });

  /** 设/取消默认模板 */
  app.patch('/api/tool-gate/templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (getToolTemplate(deps.db, id) === undefined) return reply.code(404).send({ error: '模板不存在' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body['isDefault'] === true) {
      setDefaultToolTemplate(deps.db, id);
      return { ok: true, id, isDefault: true };
    }
    return reply.code(400).send({ error: '只有 isDefault: true 支持（取消默认请设另一个为默认）' });
  });

  app.delete('/api/tool-gate/templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (getToolTemplate(deps.db, id) === undefined) return reply.code(404).send({ error: '模板不存在' });
    return { deleted: deleteToolTemplate(deps.db, id) };
  });
}
