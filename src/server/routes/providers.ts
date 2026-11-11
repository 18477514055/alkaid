import type { FastifyInstance } from 'fastify';

import { probeModels } from '../../core/model/list-models.ts';
import { checkOutboundTarget } from '../../core/net/target-guard.ts';
import { listPresets } from '../../core/model/presets.ts';
import { getSecret, readSecrets, removeSecret, setSecret } from '../../core/secrets.ts';
import {
  deleteProvider,
  getProvider,
  insertProvider,
  listProviders,
  updateProvider,
  updateProviderContextWindow,
  type ProviderRow,
} from '../../core/store/repo.ts';
import type { ServerDeps } from '../app.ts';

/**
 * 模型连接的 HTTP 面。**永远不返回密钥** —— 只返回 `hasKey` 布尔值。
 */

type PublicProvider = Omit<ProviderRow, 'extraHeaders'> & {
  readonly hasKey: boolean;
  readonly extraHeaders?: Record<string, string> | null;
};

function toPublic(row: ProviderRow, hasKey: boolean): PublicProvider {
  return { ...row, hasKey };
}

/**
 * 这条连接在对话里**允许选**哪些模型。
 *
 * ★ 三层回退，顺序不能乱：
 *   ① `enabledModels` 有值（含空数组）⇒ 就用它（空数组 = 一个都不给，用户显式清空了）
 *   ② `null`（没设过）⇒ 回退到 `defaultModel`
 *   ③ `defaultModel` 也没有 ⇒ 空集合（让界面进入手填模式，而不是把整份目录倒出来）
 */
function allowedModels(row: ProviderRow): Set<string> {
  if (row.enabledModels !== null) return new Set(row.enabledModels);
  if (row.defaultModel !== null && row.defaultModel.length > 0) return new Set([row.defaultModel]);
  return new Set();
}

type CreateProviderBody = {
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  kind?: unknown;
  chatPath?: unknown;
  modelsPath?: unknown;
  defaultModel?: unknown;
  extraHeaders?: unknown;
  thinkingShape?: unknown;
  supportsStreamUsage?: unknown;
  usesMaxCompletionTokens?: unknown;
  /** 需要「按对话固定」的会话头名（如 x-opencode-session），值在请求时用 conversationId 填 */
  sessionHeader?: unknown;
  contextWindow?: unknown;
};

export function registerProviderRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const secretPath = deps.config.secretsPath;

  /** 内置服务商目录（46 家，只含 OpenAI 兼容端点；不含密钥，可随包分发） */
  app.get('/api/providers/presets', async () => listPresets());

  app.get('/api/providers', async () => {
    const secrets = readSecrets(secretPath);
    return listProviders(deps.db).map((row) => toPublic(row, (secrets[row.id] ?? '').length > 0));
  });

  /**
   * 探针：给**还没保存**的配置试一次 `GET /models`。
   * 有了它，用户可以在点"保存"之前就知道 key 对不对 —— 而不是保存完发消息才发现 401。
   */
  app.post('/api/providers/probe', async (request, reply) => {
    const body = (request.body ?? {}) as { baseUrl?: unknown; apiKey?: unknown; modelsPath?: unknown };
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

    if (!/^https?:\/\//i.test(baseUrl)) {
      return reply.code(400).send({ error: 'baseUrl 必须以 http:// 或 https:// 开头' });
    }
    if (apiKey.length === 0) return reply.code(400).send({ error: 'apiKey 必填' });

    /**
     * ★ 2026-11-11 审计 `ALK-HIGH-07`（SSRF）：这里会**由服务端**去请求调用方填的任意地址，
     *   不判目标就等于让调用者借我们的网络位置访问内网 / 云元数据 / 我们自己的管理面。
     */
    const probeTarget = checkOutboundTarget(baseUrl, deps.config.port);
    if (!probeTarget.ok) return reply.code(400).send({ error: probeTarget.reason });

    return probeModels({
      baseUrl,
      apiKey,
      modelsPath: typeof body.modelsPath === 'string' ? body.modelsPath : null,
    });
  });

  /** 对**已保存**的连接拉模型列表（改完 key 想复核时用） */
  /**
   * 拉模型目录。
   *
   * ★ `models` 是**过滤后**的：只回 enabledModels 里的（没设过就只回 defaultModel）。
   *   `catalog` 是网关那边的完整目录，供设置页挑选。
   *
   * ★ 为什么必须分开回：用户只配了 deepseek-v4.1-flash，但 OpenCode 一条订阅能列出几十个模型。
   *   之前输入框右下角直接读目录 ⇒ 冒出一堆"我根本没配过的模型"，
   *   选了一个未配置的模型会在下一次请求里直接报错。
   */
  app.get('/api/providers/:id/models', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getProvider(deps.db, id);
    if (row === undefined) return reply.code(404).send({ error: 'provider 不存在' });

    const apiKey = getSecret(secretPath, id);
    if (apiKey === undefined) return reply.code(412).send({ error: '这条连接没有保存 API Key' });

    const probe = await probeModels({ baseUrl: row.baseUrl, apiKey, modelsPath: row.modelsPath });
    if (!probe.ok) return probe;

    const allowed = allowedModels(row);
    return {
      ...probe,
      catalog: probe.models.map((item) => item.id),
      models: probe.models.filter((item) => allowed.has(item.id)),
    };
  });

  app.post('/api/providers', async (request, reply) => {
    const body = (request.body ?? {}) as CreateProviderBody;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

    if (name.length === 0) return reply.code(400).send({ error: 'name 必填' });
    if (!/^https?:\/\//i.test(baseUrl)) {
      return reply.code(400).send({ error: 'baseUrl 必须以 http:// 或 https:// 开头' });
    }
    if (apiKey.length === 0) return reply.code(400).send({ error: 'apiKey 必填' });

    const row = insertProvider(deps.db, {
      name,
      baseUrl,
      kind: typeof body.kind === 'string' ? body.kind : 'openai_compatible',
      ...(typeof body.chatPath === 'string' ? { chatPath: body.chatPath } : {}),
      ...(typeof body.modelsPath === 'string' ? { modelsPath: body.modelsPath } : {}),
      defaultModel: typeof body.defaultModel === 'string' ? body.defaultModel : null,
      thinkingShape: typeof body.thinkingShape === 'string' ? body.thinkingShape : 'effort_only',
      supportsStreamUsage: body.supportsStreamUsage !== false,
      usesMaxCompletionTokens: body.usesMaxCompletionTokens === true,
      ...(typeof body.sessionHeader === 'string' ? { sessionHeader: body.sessionHeader } : {}),
      ...(typeof body.contextWindow === 'number' ? { contextWindow: body.contextWindow } : {}),
      ...(typeof body.extraHeaders === 'object' && body.extraHeaders !== null
        ? { extraHeaders: body.extraHeaders as Record<string, string> }
        : {}),
    });

    setSecret(secretPath, row.id, apiKey);
    return reply.code(201).send(toPublic(row, true));
  });

  /**
   * 改名 / 改 baseUrl / 改模型列表路径 / 改默认模型 / 改上下文窗口。
   *
   * ★ baseUrl 与 modelsPath **只接受探针验过的值** —— 这是路由层无法强制的约定，
   *   所以前端流程是"先探针成功 → 再 PATCH"。宁可多一次请求，也不要"保存成功但连不上"。
   */
  app.patch('/api/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      contextWindow?: unknown;
      name?: unknown;
      baseUrl?: unknown;
      modelsPath?: unknown;
      defaultModel?: unknown;
      apiKey?: unknown;
      sessionHeader?: unknown;
      /** 对话里可选的模型白名单；null = 清掉（回退 defaultModel） */
      enabledModels?: unknown;
    };

    if (getProvider(deps.db, id) === undefined) return reply.code(404).send({ error: 'provider 不存在' });

    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length === 0)) {
      return reply.code(400).send({ error: 'name 不能为空' });
    }
    if (body.baseUrl !== undefined && (typeof body.baseUrl !== 'string' || !/^https?:\/\//i.test(body.baseUrl.trim()))) {
      return reply.code(400).send({ error: 'baseUrl 必须以 http:// 或 https:// 开头' });
    }
    if (body.modelsPath !== undefined && typeof body.modelsPath !== 'string') {
      return reply.code(400).send({ error: 'modelsPath 必须是字符串' });
    }

    let row: ProviderRow | undefined;
    if (
      body.name !== undefined ||
      body.baseUrl !== undefined ||
      body.modelsPath !== undefined ||
      body.defaultModel !== undefined ||
      body.sessionHeader !== undefined ||
      body.enabledModels !== undefined
    ) {
      // 白名单：只接受字符串数组或 null（null = 清掉，回退 defaultModel）
      let enabledModels: string[] | null | undefined;
      if (body.enabledModels === null) {
        enabledModels = null;
      } else if (Array.isArray(body.enabledModels)) {
        const cleaned = body.enabledModels
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        // ★ 去重：同一个模型在目录里重复出现是常见事，存两遍会让界面出现两个一样的选项
        enabledModels = [...new Set(cleaned)];
      } else if (body.enabledModels !== undefined) {
        return reply.code(400).send({ error: 'enabledModels 必须是字符串数组或 null' });
      }

      row = updateProvider(deps.db, id, {
        ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
        ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl.trim() } : {}),
        ...(typeof body.modelsPath === 'string' ? { modelsPath: body.modelsPath.trim() } : {}),
        ...(body.sessionHeader === null
          ? { sessionHeader: null }
          : typeof body.sessionHeader === 'string'
            ? { sessionHeader: body.sessionHeader.trim().length === 0 ? null : body.sessionHeader.trim() }
            : {}),
        ...(body.defaultModel === null
          ? { defaultModel: null }
          : typeof body.defaultModel === 'string'
            ? { defaultModel: body.defaultModel }
            : {}),
        ...(enabledModels !== undefined ? { enabledModels } : {}),
      });
    }

    if (typeof body.apiKey === 'string' && body.apiKey.trim().length > 0) {
      setSecret(secretPath, id, body.apiKey.trim());
    }

    if (body.contextWindow !== undefined) {
      const value = body.contextWindow;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 10_000_000) {
        return reply.code(400).send({ error: 'contextWindow 必须是 1000–10000000 之间的整数' });
      }
      row = updateProviderContextWindow(deps.db, id, value);
    }

    const updated = row ?? getProvider(deps.db, id);
    if (updated === undefined) return reply.code(404).send({ error: 'provider 不存在' });

    const secrets = readSecrets(secretPath);
    return toPublic(updated, (secrets[updated.id] ?? '').length > 0);
  });

  app.delete('/api/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = deleteProvider(deps.db, id);
    removeSecret(secretPath, id);
    if (!removed) return reply.code(404).send({ error: 'provider 不存在' });
    return { ok: true };
  });
}
