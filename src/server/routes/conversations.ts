import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runTurn } from '../../core/agent/loop.ts';
import { countPendingInputs, queueInput } from '../../core/agent/steering.ts';
import { buildConversationPrompt } from '../../core/agent/prompt/session.ts';
import { assertPersisted, CompactionError, compactRange, listCompactions } from '../../core/context/compact.ts';
import { generateConversationTitle, isPlaceholderTitle } from '../../core/context/title.ts';
import { THINKING_EFFORTS, isThinkingEffort, type ThinkingEffort } from '../../core/model/thinking.ts';
import { createProviderFromRow } from '../../core/model/factory.ts';
import { PERMISSION_MODES, isPermissionMode } from '../../core/policy/mode.ts';
import { getSecret } from '../../core/secrets.ts';
import { getGeneralSettings } from '../../core/settings/service.ts';
import { listStepEvents } from '../../core/store/audit.ts';
import { conversationStats, conversationUsageDetail } from '../../core/store/stats.ts';
import {
  appendMessage,
  attachWorkspace,
  deleteConversation,
  getConversation,
  getProject,
  getProvider,
  getWorkspace,
  insertConversation,
  listConversations,
  listMessages,
  updateConversation,
  updateConversationInstructions,
} from '../../core/store/repo.ts';
import type { ServerDeps } from '../app.ts';

type CreateBody = {
  providerId?: unknown;
  model?: unknown;
  title?: unknown;
  permissionMode?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
};

/**
 * 思考强度的**唯一定义处**在 `core/model/thinking.ts` —— 那里同时管"怎么变成请求体字段"。
 * 这里只 re-export，让路由层与测试不必知道它住在哪。
 */
export { THINKING_EFFORTS, isThinkingEffort, type ThinkingEffort } from '../../core/model/thinking.ts';

export function registerConversationRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Runtime ownership, not persisted state: a crashed previous process can leave
  // state=running, which must not permanently block resuming that conversation.
  const activeTurns = new Set<string>();
  /**
   * 正在跑的那一轮的中止器。
   * ★ 为什么要单独存：用户要求「模型输出时发送键变停止键」。原来的中止只有一条路 ——
   *   客户端断开连接（`reply.raw.on('close')`）。但要"点一下就停"必须能从**另一个请求**掐断，
   *   所以按 conversationId 留一个句柄，`POST /stop` 直接 abort 它。
   */
  const activeAborts = new Map<string, AbortController>();
  app.get('/api/conversations', async (request) => {
    const query = request.query as { projectId?: string; includeArchived?: string };
    return listConversations(deps.db, {
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      // ★ 默认不返回归档；侧栏「已归档」分组显式传 ?includeArchived=1
      includeArchived: query.includeArchived === '1' || query.includeArchived === 'true',
    });
  });

  app.post('/api/conversations', async (request, reply) => {
    const body = (request.body ?? {}) as CreateBody;
    const providerId = typeof body.providerId === 'string' ? body.providerId : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';

    if (providerId.length === 0) return reply.code(400).send({ error: 'providerId 必填' });
    if (model.length === 0) return reply.code(400).send({ error: 'model 必填' });
    if (getProvider(deps.db, providerId) === undefined) {
      return reply.code(400).send({ error: 'providerId 指向的模型连接不存在' });
    }
    if (body.permissionMode !== undefined && !isPermissionMode(body.permissionMode)) {
      return reply.code(400).send({ error: `permissionMode 必须是 ${PERMISSION_MODES.join(' / ')}` });
    }

    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    if (projectId !== null && getProject(deps.db, projectId) === undefined) {
      return reply.code(400).send({ error: 'projectId 指向的项目不存在' });
    }

    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;
    if (workspaceId !== null && getWorkspace(deps.db, workspaceId) === undefined) {
      return reply.code(400).send({ error: 'workspaceId 指向的工作区不存在' });
    }

    const conversation = insertConversation(deps.db, {
      providerId,
      model,
      title: typeof body.title === 'string' ? body.title : null,
      projectId,
      primaryWorkspaceId: workspaceId,
      permissionMode: isPermissionMode(body.permissionMode) ? body.permissionMode : 'workspace',
    });
    if (workspaceId !== null) attachWorkspace(deps.db, conversation.id, workspaceId, true);

    deps.plugins?.broadcast('conversation.created', { conversationId: conversation.id, projectId });

    return reply.code(201).send(conversation);
  });

  /**
   * 从某个会话的某条消息处「分支」出一个新会话。
   *
   * ★ 语义（**故意保守**）：
   *   - 复制 `seq <= uptoSeq` 的对话消息（`display_channel='chat'`）；
   *   - **只复制 user / assistant 的正文**，工具调用与工具输出**不复制** ——
   *     分支出来的是一个干净的对话上下文，不是把工具链一起搬过去。
   *     搬过去会立刻踩「assistant 带 tool_calls 却没有对应 tool 回复」那个坑（11-08 真事故）。
   *   - 原会话**一个字不动**（不是剪切也不是分叉存储）。
   *   - 新会话的 provider/model/权限/工作区/项目全部继承原会话，只有 title 是新的。
   */
  app.post('/api/conversations/:id/branch', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { uptoSeq?: unknown };

    const source = getConversation(deps.db, id);
    if (source === undefined) return reply.code(404).send({ error: '会话不存在' });

    const upto = typeof body.uptoSeq === 'number' && Number.isInteger(body.uptoSeq) && body.uptoSeq > 0 ? body.uptoSeq : source.lastSeq;
    const sourceMessages = listMessages(deps.db, id).filter(
      (message) => message.seq <= upto && message.displayChannel === 'chat' && (message.role === 'user' || message.role === 'assistant'),
    );
    if (sourceMessages.length === 0) {
      return reply.code(400).send({ error: '这条消息之前没有可复制的对话内容' });
    }

    const created = insertConversation(deps.db, {
      providerId: source.providerId,
      model: source.model,
      title: source.title === null ? null : `${source.title}（分支）`,
      projectId: source.projectId,
      primaryWorkspaceId: source.primaryWorkspaceId,
      permissionMode: source.permissionMode,
    });
    if (source.primaryWorkspaceId !== null) {
      attachWorkspace(deps.db, created.id, source.primaryWorkspaceId, true);
    }

    for (const message of sourceMessages) {
      appendMessage(deps.db, {
        conversationId: created.id,
        role: message.role,
        content: message.content,
        reasoning: message.reasoning,
      });
    }

    // 思考强度也继承 —— 用户在那个会话里调过档，分支出来不该被重置
    if (source.thinkingEffort !== null) {
      updateConversation(deps.db, created.id, { thinkingEffort: source.thinkingEffort });
    }

    const result = getConversation(deps.db, created.id) ?? created;
    deps.plugins?.broadcast('conversation.created', { conversationId: created.id, projectId: source.projectId });
    return reply.code(201).send(result);
  });

  app.get('/api/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = getConversation(deps.db, id);
    if (conversation === undefined) return reply.code(404).send({ error: '会话不存在' });
    return conversation;
  });

  /**
   * ★ 关键约束（任务书 §3.4）：改工作区**不改变项目身份**，改项目**不迁移工作区**。
   *   这两个字段在这里就是各自独立的，没有任何联动代码 —— 这是刻意的。
   */
  app.patch('/api/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    const current = getConversation(deps.db, id);
    if (current === undefined) return reply.code(404).send({ error: '会话不存在' });
    if (activeTurns.has(id)) return reply.code(409).send({ error: '当前轮仍在运行，结束后再修改会话绑定与配置' });
    if (body['permissionMode'] !== undefined && !isPermissionMode(body['permissionMode'])) {
      return reply.code(400).send({ error: `permissionMode 必须是 ${PERMISSION_MODES.join(' / ')}` });
    }

    let workspaceId: string | null | undefined;
    if (body['workspaceId'] === null) {
      workspaceId = null;
    } else if (typeof body['workspaceId'] === 'string') {
      if (getWorkspace(deps.db, body['workspaceId']) === undefined) {
        return reply.code(400).send({ error: 'workspaceId 指向的工作区不存在' });
      }
      workspaceId = body['workspaceId'];
    }

    let projectId: string | null | undefined;
    if (body['projectId'] === null) {
      projectId = null;
    } else if (typeof body['projectId'] === 'string') {
      if (getProject(deps.db, body['projectId']) === undefined) {
        return reply.code(400).send({ error: 'projectId 指向的项目不存在' });
      }
      projectId = body['projectId'];
    }

    /**
     * 切换连接（模型选择器里按提供商分组后，可以选中另一个连接下的模型）。
     * ★ 必须校验连接存在；并且**若该连接设了模型白名单，新模型也要在白名单里** ——
     *   否则"这连接只允许 3 个模型"被一次 PATCH 绕过（和委派那条是同一类缺口）。
     */
    let nextProviderId: string | undefined;
    if (typeof body['providerId'] === 'string') {
      const target = getProvider(deps.db, body['providerId']);
      if (target === undefined) return reply.code(400).send({ error: 'providerId 指向的模型连接不存在' });
      const wantedModel = typeof body['model'] === 'string' ? body['model'] : null;
      if (wantedModel !== null && target.enabledModels !== null && !target.enabledModels.includes(wantedModel)) {
        return reply.code(400).send({ error: `该连接未开放模型「${wantedModel}」，请先在连接设置里勾选` });
      }
      nextProviderId = target.id;
    } else if (body['providerId'] !== undefined && body['providerId'] !== null) {
      return reply.code(400).send({ error: 'providerId 必须是字符串' });
    }

    /**
     * 置顶 / 归档 / 思考强度 —— 三个都是"会话级偏好"，一起在这里收。
     *
     * ★ 置顶与归档收的是**时刻**不是布尔：`null` 表示取消，字符串表示"这一刻置顶/归档"。
     *   前端只要传 `null` 或 `new Date().toISOString()` 即可，不必自己编时间戳。
     *   这里允许传任意合法时刻是为了「跨设备/批量操作恢复原顺序」，但**非法值一律 400**。
     */
    const stamp = (value: unknown): string | null | undefined => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      if (typeof value === 'string') {
        if (value.trim().length === 0) return null; // 空串当取消，别让它变成"1970 年置顶"
        const at = Date.parse(value);
        return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
      }
      return undefined;
    };

    const pinnedAt = stamp(body['pinnedAt']);
    if (body['pinnedAt'] !== undefined && pinnedAt === undefined) {
      return reply.code(400).send({ error: 'pinnedAt 必须是 ISO 时刻、null 或空串' });
    }
    const archivedAt = stamp(body['archivedAt']);
    if (body['archivedAt'] !== undefined && archivedAt === undefined) {
      return reply.code(400).send({ error: 'archivedAt 必须是 ISO 时刻、null 或空串' });
    }

    // 思考强度：null = 用默认；字符串必须落在白名单里（防止把任意串塞进请求体）
    let thinkingEffort: ThinkingEffort | null | undefined;
    if (body['thinkingEffort'] === null) {
      thinkingEffort = null;
    } else if (isThinkingEffort(body['thinkingEffort'])) {
      thinkingEffort = body['thinkingEffort'];
    } else if (body['thinkingEffort'] !== undefined) {
      return reply.code(400).send({ error: `thinkingEffort 必须是 ${THINKING_EFFORTS.join(' / ')} 之一或 null` });
    }

    const updated = updateConversation(deps.db, id, {
      ...(typeof body['title'] === 'string' || body['title'] === null
        ? { title: body['title'] as string | null }
        : {}),
      ...(typeof body['model'] === 'string' ? { model: body['model'] } : {}),
      ...(nextProviderId !== undefined ? { providerId: nextProviderId } : {}),
      ...(isPermissionMode(body['permissionMode']) ? { permissionMode: body['permissionMode'] } : {}),
      ...(workspaceId !== undefined ? { primaryWorkspaceId: workspaceId } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(pinnedAt !== undefined ? { pinnedAt } : {}),
      ...(archivedAt !== undefined ? { archivedAt } : {}),
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    });

    if (workspaceId !== undefined && workspaceId !== null) {
      attachWorkspace(deps.db, id, workspaceId, true);
    }

    // 会话级用户自定义指令（注入 system 提示的独立段）
    if (body['instructions'] !== undefined) {
      if (body['instructions'] !== null && typeof body['instructions'] !== 'string') {
        return reply.code(400).send({ error: 'instructions 必须是字符串或 null' });
      }
      updateConversationInstructions(deps.db, id, body['instructions'] as string | null);
    }

    if (updated === undefined) return reply.code(404).send({ error: '会话不存在' });
    return getConversation(deps.db, id) ?? updated;
  });

  /**
   * 停止正在生成的那一轮。
   *
   * ★ 语义刻意做成**幂等**：没有在跑的一轮就返回 `{stopped:false}` 而不是报错 ——
   *   停止键会被人连点，报错只会制造噪音。
   * ★ 只 abort 这一轮的 signal，不删数据：已经写进库的消息与工具结果都留着（原文逐字不变）。
   */
  /**
   * 插话（steering）：模型正在输出时，用户的话可以递进去，**下一个 step 之前**注入。
   *
   * ★ 为什么不直接走 `POST /messages`：那条路会开**新的一轮**，而插话是"把话塞进**当前**这一轮"。
   * ★ 为什么不用 `role='user'` 的假消息：那会让 recall / 导出 / 摘要把系统提醒和真人发言混在一起。
   *   这里走 A3 的 `pending_inputs` 通道，`source='user'` 标明是真人说的。
   * ★ 上限 2000 字符由 `queueInput` 强制：它不是搬运行长文的暗通道（每步都进上下文却不在历史里）。
   */
  app.post('/api/conversations/:id/steer', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (getConversation(deps.db, id) === undefined) return reply.code(404).send({ error: '会话不存在' });
    const body = (request.body ?? {}) as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (content.length === 0) return reply.code(400).send({ error: '插话内容不能为空' });
    try {
      queueInput(deps.db, { conversationId: id, source: 'user', content });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    return { queued: countPendingInputs(deps.db, id) };
  });

  app.post('/api/conversations/:id/stop', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (getConversation(deps.db, id) === undefined) return reply.code(404).send({ error: '会话不存在' });
    const abort = activeAborts.get(id);
    if (abort === undefined) return { stopped: false, reason: 'no_active_turn' };
    abort.abort();
    return { stopped: true };
  });

  app.get('/api/conversations/:id/compactions', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (getConversation(deps.db, id) === undefined) return reply.code(404).send({ error: '会话不存在' });
    return {
      compactions: listCompactions(deps.db, id),
      contextTokens: buildConversationPrompt(deps.db, id, deps.tools).state.contextTokens,
    };
  });

  /** 手动压缩：把较早的历史压成带指针的摘要（原文不动，可用 recall 取回） */
  app.post('/api/conversations/:id/compact', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { keepRecent?: unknown };

    const conversation = getConversation(deps.db, id);
    if (conversation === undefined) return reply.code(404).send({ error: '会话不存在' });

    if (activeTurns.has(id)) return reply.code(409).send({error:{code:'busy',message:'当前轮仍在运行；请在工作结束后手动压缩。',retryable:false}});
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key=>key!=='keepRecent') || body.keepRecent!==undefined && (!Number.isSafeInteger(body.keepRecent)||Number(body.keepRecent)<1)) return reply.code(400).send({error:'Invalid compaction fields'});
    try {
      assertPersisted(deps.db, id);
      const row = await compactRange({
        db: deps.db, conversationId: id, source:'manual',
        createProvider:()=>{
          const providerRow=getProvider(deps.db,conversation.providerId);
          if(!providerRow)throw new Error('conversation_provider_unavailable');
          const key=getSecret(deps.config.secretsPath,providerRow.id);
          if(!key)throw new Error('conversation_credentials_unavailable');
          return createProviderFromRow(providerRow,key,id);
        },
        ...(typeof body.keepRecent==='number'?{keepRecent:body.keepRecent}:{}),
        signal: AbortSignal.timeout(120_000),
      });
      if (row === null) return { compacted: false, reason: '没有符合履责边界与近期保留要求的可压缩内容' };
      return { compacted: true, compaction: row, contextTokens: buildConversationPrompt(deps.db, id, deps.tools).state.contextTokens };
    } catch (error) {
      // ★ 压缩失败是**封闭枚举**（六类，各带一句人话 + 能否重试）⇒ 回结构化错误，
      //   前端才能判"要不要给重试按钮"。其余错误保持原来的 `{ error: string }` 形态不变
      //   —— 别处还在读裸字符串，全改掉会打断既有契约。
      if (error instanceof CompactionError) {
        return reply.code(error.code==='blocked'||error.code==='busy'?409:502).send({
          compacted:false,blocked:error.code==='blocked',code:error.reason==='duties'||error.reason==='no_checkpoint'?'duties_incomplete':error.reason??error.code,missing:error.missing,
          error: { code: error.code, message: error.message, retryable: error.retryable },
        });
      }
      return reply.code(502).send({ error:'compaction_unavailable' });
    }
  });

  /** 看板数据：一次拿全，前端不用打三四个请求 */
  app.get('/api/conversations/:id/dashboard', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = getConversation(deps.db, id);
    if (conversation === undefined) return reply.code(404).send({ error: '会话不存在' });

    const messageCount = (
      deps.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id) as
        | { n: number | bigint }
        | undefined
    )?.n;

    const kindRows = deps.db
      .prepare('SELECT kind, COUNT(*) AS n FROM step_events WHERE conversation_id = ? GROUP BY kind')
      .all(id) as Array<{ kind: string; n: number | bigint }>;

    const counts: Record<string, number> = {};
    for (const row of kindRows) counts[row.kind] = Number(row.n);

    const workspace =
      conversation.primaryWorkspaceId === null ? undefined : getWorkspace(deps.db, conversation.primaryWorkspaceId);
    const project = conversation.projectId === null ? undefined : getProject(deps.db, conversation.projectId);
    const providerRow = getProvider(deps.db, conversation.providerId);
    const stats = conversationStats(deps.db, id);
    const used = buildConversationPrompt(deps.db, id, deps.tools).state.contextTokens;
    // ★ 窗口大小是 provider 的属性；provider 被删了也要给个数，否则前端水位算不出来
    const contextWindow = providerRow?.contextWindow ?? 128_000;

    return {
      conversation,
      messageCount: Number(messageCount ?? 0),
      contextTokens: used,
      contextWindow,
      contextRatio: contextWindow > 0 ? used / contextWindow : null,
      stats,
      compactions: listCompactions(deps.db, id),
      counts,
      events: listStepEvents(deps.db, id, 20),
      workspace: workspace ?? null,
      project: project ?? null,
    };
  });

  /**
   * 底部状态栏「点开看详情」用。
   * ★ 单独一个端点而不是塞进 dashboard：明细可能几百行，只有用户点开时才需要。
   */
  app.get('/api/conversations/:id/usage', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (getConversation(deps.db, id) === undefined) return reply.code(404).send({ error: '会话不存在' });

    const query = request.query as { limit?: string };
    const raw = query.limit === undefined ? 200 : Number.parseInt(query.limit, 10);
    const limit = Number.isInteger(raw) && raw > 0 && raw <= 1000 ? raw : 200;

    return conversationUsageDetail(deps.db, id, limit);
  });

  /**
   * 系统提示**长什么样**（只读）。
   * ★ 有了它，"模型实际收到什么"不用猜 —— 分段列出，每段来源、稳定度、字数都在。
   */
  app.get('/api/conversations/:id/prompt', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = getConversation(deps.db, id);
    if (conversation === undefined) return reply.code(404).send({ error: '会话不存在' });

    const result = buildConversationPrompt(deps.db, id, deps.tools);
    return { text: result.text, sections: result.sections, sources: result.sources, instructions: result.instructions,
      contextMessages:result.contextMessages, recoveryMessages:result.messages.filter(message=>message.role==='user' && message.content?.startsWith('[runtime_compaction')) };
  });

  app.delete('/api/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (activeTurns.has(id)) return reply.code(409).send({ error: '当前轮仍在运行，不能删除会话' });
    // 删对话**不碰**项目、不碰工作区、不碰共享目录（外键是 SET NULL / CASCADE 到消息）
    if (!deleteConversation(deps.db, id)) return reply.code(404).send({ error: '会话不存在' });
    return { ok: true };
  });

  /**
   * 让模型给会话起一个标题（第一轮结束后由前端调用）。
   *
   * ★ 为什么**不塞进** `/messages` 那条 SSE 流：
   *   起标题是**旁路**请求。塞进主流意味着：
   *   ① 每轮对话都多一次上游调用（哪怕已经有标题）；
   *   ② 它一旦慢/失败就会拖住"本轮结束"这件事；
   *   ③ 主流的请求集合被污染 —— 已经有测试断言"这一轮只发了 N 次请求"，多一次就误报。
   *   所以做成独立端点，由前端在收到 `finish` 之后**非阻塞**地调一次。
   *
   * ★ 语义（都是"什么都不做"而不是报错）：
   *   - 已经有非占位标题 ⇒ `{ titled:false, reason:'has_title' }`，**不覆盖用户起的名字**
   *   - 还没消息 ⇒ `no_material`
   *   - 上游失败/超时 ⇒ `failed`，**标题保持原样**（HTTP 仍 200，这又不是用户的错）
   */
  app.post('/api/conversations/:id/title', async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = getConversation(deps.db, id);
    if (conversation === undefined) return reply.code(404).send({ error: '会话不存在' });

    const body = (request.body ?? {}) as { force?: unknown };
    // force: 用户手动点"重新起名"时用 —— 允许覆盖现有标题
    if (body.force === true) updateConversation(deps.db, id, { title: null });

    /**
     * ★ 先判"要不要起"，**再**去找 provider 与 key。
     *   顺序反了会出现很荒谬的结果：标题明明是用户自己起的（根本不会改名），
     *   却因为"模型连接缺 Key"回一个 412 —— 用户会以为是自己起的名字出了问题。
     */
    const fresh = getConversation(deps.db, id) ?? conversation;
    if (!isPlaceholderTitle(fresh.title)) {
      return { titled: false, title: null, reason: 'has_title' };
    }

    const providerRow = getProvider(deps.db, conversation.providerId);
    if (providerRow === undefined) return reply.code(412).send({ error: '会话绑定的模型连接不存在' });
    const apiKey = getSecret(deps.config.secretsPath, providerRow.id);
    if (apiKey === undefined) return reply.code(412).send({ error: '模型连接缺少 API Key' });

    const result = await generateConversationTitle({
      db: deps.db,
      conversationId: id,
      provider: createProviderFromRow(providerRow, apiKey, id),
      signal: AbortSignal.timeout(20_000),
    });

    return { titled: result.title !== null, title: result.title, reason: result.skipped };
  });

  app.get('/api/conversations/:id/messages', async (request, reply) => {    const { id } = request.params as { id: string };
    const query = request.query as { after?: string };
    const conversation = getConversation(deps.db, id);
    if (conversation === undefined) return reply.code(404).send({ error: '会话不存在' });

    const after = query.after === undefined ? 0 : Number.parseInt(query.after, 10);
    return listMessages(deps.db, id, Number.isInteger(after) && after > 0 ? after : 0);
  });

  /**
   * 发一条消息 ⇒ 响应就是 SSE 流（设计稿 §10）。
   *
   * ★ 这里用 `reply.hijack()` 接管原始响应：Fastify 不能再往这个响应上写东西，
   *   所有字节都由 `runTurn` 的事件决定。
   */
  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { content?: unknown; maxSteps?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';

    if (content.length === 0) return reply.code(400).send({ error: 'content 必填' });
    const conversation = getConversation(deps.db, id);
    if (conversation === undefined) return reply.code(404).send({ error: '会话不存在' });
    if (activeTurns.has(id)) return reply.code(409).send({ error: '该对话当前轮尚未结束' });

    const providerRow = getProvider(deps.db, conversation.providerId);
    if (providerRow === undefined) {
      return reply.code(412).send({ error: '会话绑定的模型连接不存在，请重新选择' });
    }
    const apiKey = getSecret(deps.config.secretsPath, providerRow.id);
    if (apiKey === undefined) {
      return reply.code(412).send({ error: '模型连接缺少 API Key' });
    }

    // 会话 → 工作区根 / 项目共享目录（两个互相独立的东西，任务书 §3.4）
    const workspace =
      conversation.primaryWorkspaceId === null ? undefined : getWorkspace(deps.db, conversation.primaryWorkspaceId);
    const project = conversation.projectId === null ? undefined : getProject(deps.db, conversation.projectId);
    const generalSettings = getGeneralSettings(deps.db);

    const provider = createProviderFromRow(providerRow, apiKey, id);
    const abort = new AbortController();
    activeAborts.set(id, abort);

    // 会话私有临时目录：shell 的 TMP/TEMP 指到这里，命令产生的临时文件不外散
    const tempDir = join(deps.config.home, 'tmp', id);
    mkdirSync(tempDir, { recursive: true });
    if (conversation.projectId !== null) deps.memory.projectBusy(conversation.projectId);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    // 客户端断开 ⇒ 中止这一轮（否则模型会继续白烧 token）。
    // ★ 监听的是**响应**的 close，并且用 writableEnded 排除"我们自己正常收尾"那一次：
    //   监听 IncomingMessage 的 close 会在这条请求读完时就触发，等于开跑前就自杀。
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abort.abort();
    });

    const write = (payload: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    activeTurns.add(id);
    try {
      for await (const event of runTurn({
        db: deps.db,
        conversationId: id,
        userText: content,
        provider,
        signal: abort.signal,
        workspacePath: workspace?.rootPath ?? null,
        projectSharedDir: project?.sharedDir ?? null,
        tools: deps.tools,
        tempDir,
        thinkingShape: providerRow.thinkingShape,
        /**
         * ★ 步数上限与工具输出上限**从服务端设置读**，不再信请求体：
         *   设置已经从 localStorage 搬到服务端（`app_settings`），它才是唯一真源。
         *   两者都支持 `null` = 不限制（用户在设置里显式关掉）。
         */
        maxSteps: generalSettings.maxStepsPerTurn,
        maxToolOutputChars: generalSettings.maxToolOutputChars,
      })) {
        write(event);
      }
    } catch (error) {
      write({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
      write({ type: 'finish', reason: 'error' });
    } finally {
      activeTurns.delete(id);
      activeAborts.delete(id);
      reply.raw.end();
      // 生命周期事件：单向通知，插件挂了也不影响这里
      deps.plugins?.broadcast('message.completed', { conversationId: id });
      deps.plugins?.broadcast('turn.finished', { conversationId: id });
      if (conversation.projectId !== null) deps.memory.notifyProject(conversation.projectId);
    }
  });
}
