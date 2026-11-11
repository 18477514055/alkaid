import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { observeWaterline, recordSuccessfulFileTouch, recordTurnProgress } from '../memory/context.ts';
import { autoApproveOnTurnEnd } from '../memory/store.ts';

import type { ChatMessage, ChatRequest, FinishReason, Usage } from '../../shared/types.ts';
import { assembleContext, renderSummaries, sanitizeToolPairs } from '../context/compact.ts';
import { ToolCallAggregator } from '../model/aggregate.ts';
import type { Provider } from '../model/provider.ts';
import { withThinking } from '../model/thinking.ts';
import { usageInputTotal } from '../model/usage.ts';
import { resolvePermissionMode } from '../policy/mode.ts';
import { rootsFor } from '../policy/roots.ts';
import {
  appendMessage,
  getConversation,
  listMessages,
  updateConversation,
  type MessageRow,
} from '../store/repo.ts';
import { recordStepEvent } from '../store/audit.ts';
import { createSurface, type ToolSurface } from '../tools/runtime.ts';
import { recordToolUse } from '../tools/settings.ts';
import { effectiveToolModes } from '../tools/gate.ts';
import type { ToolContext, ToolOutcome, ToolRegistry } from '../tools/types.ts';
import { PromptBuilder } from './prompt/builder.ts';
import { builtinSources } from './prompt/builtin.ts';
import { canonicalCallSignature } from './canonical.ts';
import { memoryAwarePrompt, projectMemoryBlock } from './prompt/memory.ts';
import { projectRequestMessages } from './prompt/projection.ts';
import { autoCompactionDue,maybeAutoCompact } from './auto-compaction.ts';
import { beginObligation, finishObligation, readObligation } from '../memory/obligations.ts';
import { captureObligationTool, repairProjectMemory } from './memory-close.ts';
import { deferMemoryTurn, getMemoryRhythm, recordMemoryFulfillment } from '../memory/rhythm.ts';
import { claimPendingInputs, queueInput, renderPendingInputs } from './steering.ts';

/**
 * 主循环（设计稿 §7）。以 **step** 为单位，不以"一次 API 调用"为单位。
 *
 * 做成 async generator：路由层直接把它接到 SSE 上，不需要中间缓冲。
 * 每一步都落库 —— 所以进程被杀掉，历史仍然是完整的（除了正在生成的那部分）。
 */

export type TurnEvent =
  | { readonly type: 'user'; readonly message: MessageRow }
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'reasoning'; readonly delta: string }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'assistant'; readonly message: MessageRow }
  | { readonly type: 'tool'; readonly message: MessageRow }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean }
  | { readonly type: 'finish'; readonly reason: FinishReason };

export type RunTurnOptions = {
  readonly db: DatabaseSync;
  readonly conversationId: string;
  readonly userText: string;
  readonly provider: Provider;
  readonly workspacePath?: string | null;
  readonly projectSharedDir?: string | null;
  /**
   * 单轮步数上限。
   * - `undefined` ⇒ 默认 40
   * - 数字 ⇒ 夹到 [1, MAX_STEPS_CEILING]
   * - `null` ⇒ **不限制**（设置里明确关掉了上限）
   */
  readonly maxSteps?: number | null;
  /**
   * 单个工具输出上限（字符）。
   * - `undefined` ⇒ 用各工具自己的默认值
   * - 数字 ⇒ 覆盖默认值
   * - `null` ⇒ **不限制**（用户明确关掉了截断）
   */
  readonly maxToolOutputChars?: number | null;
  readonly signal: AbortSignal;
  /** 工具注册表；不传就是"没有任何工具"（V0.1 之前的行为） */
  readonly tools?: ToolRegistry;
  /** 会话私有临时目录（shell 的 TMP/TEMP 用它） */
  readonly tempDir?: string;
  /**
   * provider 的 `thinking_shape`（吃哪种思考参数形状）。
   * ★ 不从 `provider` 对象上读：`Provider` 接口只有 `id` + `stream`，
   *   而 shape 是**配置**不是**能力**。让调用方显式传，测试里也好替换。
   */
  readonly thinkingShape?: string | null;
  /** Internal/test override bounded by the production 30s closure cap; not an HTTP option. */
  readonly memoryClosureTimeoutMs?: number;
  /** Internal delegation boundary; not accepted from public message bodies. */
  readonly agentRole?: 'main' | 'subagent';
};

const DEFAULT_MAX_STEPS = 40;
/**
 * 数字型步数上限的**安全上限**。
 * ★ 2026-11-09：用户嫌 40 步不够，先是把它做成可调（10–200）；
 *   随后又要求「允许关闭步数上限」——现在是三态：
 *   - 不传 / `undefined` ⇒ 默认 40
 *   - 数字 ⇒ 夹到 [1, MAX_STEPS_CEILING]
 *   - `null` ⇒ **不限制**（用户显式关掉）
 * ★ 关闭上限意味着**理论上可能无限调用上游**（= 无限账单）。这是用户显式选的，
 *   但界面必须写清代价；空转检测（同工具同参数 3 次）仍然生效，能挡住最常见的死循环。
 */
const MAX_STEPS_CEILING = 1000;

/**
 * 抖动防护的三档（A4 / `D1@L637`）。
 *
 * - 到 `DOOM_LOOP_REPEATS`（第 3 次）⇒ **插提醒**，继续跑；
 * - 到 `DOOM_LOOP_ESCALATE`（第 5 次）⇒ **换更强的措辞**，仍继续；
 * - 到 `DOOM_LOOP_HARD_STOP`（第 9 次）⇒ 才中止。
 *
 * ★ 为什么不再"第 3 次就停"：同工具同参数第 3 次未必是空转 —— 可能是正常重试
 *   （读刚被写过的文件、等还在生成的结果、第一次参数传错正在纠正）。硬停会误杀这些。
 *   参数化而非硬编码，是因为这几个数**以后还会调**，散在判断里就没人敢动。
 */
const DOOM_LOOP_REPEATS = 3;
const DOOM_LOOP_ESCALATE = 5;
const DOOM_LOOP_HARD_STOP = 9;

/** 把上游失败翻译成**人负责能行动**的一句话（不含任何响应正文） */
function describeProviderFailure(event: { status?: number; kind?: string }): string {
  const status = event.status;
  if (status !== undefined) {
    if (status === 401 || status === 403) return `HTTP ${status} 密钥被拒绝或无权访问`;
    if (status === 404) return `HTTP ${status} 接口路径不对（检查 baseUrl / 模型名）`;
    if (status === 429) return `HTTP ${status} 上游限流或额度用尽`;
    if (status === 400 || status === 422) return `HTTP ${status} 上游认为请求不合法`;
    if (status === 413) return `HTTP ${status} 请求体过大（上下文或工具表超限）`;
    if (status >= 500) return `HTTP ${status} 上游服务端错误`;
    return `HTTP ${status}`;
  }
  switch (event.kind) {
    case 'timeout':
      return '首字节超时';
    case 'network':
      return '网络错误（连不上上游）';
    case 'stream':
      return '流在结束前断了';
    case 'abort':
      return '请求被中止';
    case 'parse':
      return '上游返回了无法解析的流';
    default:
      return '未知原因';
  }
}

function toChatMessage(row: MessageRow): ChatMessage {  return {
    role: row.role,
    content: row.content,
    reasoning: row.reasoning,
    toolCalls: row.toolCalls,
    toolCallId: row.toolCallId,
  };
}

/** 工具参数是模型生成的 JSON 字符串 —— 坏 JSON 必须变成**可读回执**，不能抛 */
function parseToolArguments(raw: string): { value: unknown } | { error: string } {
  if (raw.trim().length === 0) return { value: {} };
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function runToolCall(
  surface: ToolSurface | undefined,
  call: { readonly id: string; readonly name: string; readonly arguments: string },
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  if (surface === undefined) {
    return {
      ok: false,
      code: 'tool_not_found',
      message: '当前没有注册任何工具',
      hint: '直接用文字回答用户，不要重复调用工具。',
    };
  }

  const parsed = parseToolArguments(call.arguments);
  if ('error' in parsed) {
    return {
      ok: false,
      code: 'invalid_arguments',
      message: `arguments 不是合法 JSON：${parsed.error}`,
      hint: '重新调用这个工具，arguments 必须是完整的 JSON 对象。',
    };
  }

  const outcome: ToolOutcome = await surface.execute(call.name, parsed.value, ctx);
  if (outcome.ok) {
    return {
      ok: true,
      content: outcome.content,
      ...(outcome.truncated === true ? { truncated: true } : {}),
      ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
      // ★ 透传"工具说干完了" —— 由循环在**写完 tool 消息之后**处理（见 ⑤ 之后的收轮判据）。
      ...(outcome.conclude === true ? { conclude: true } : {}),
    };
  }
  return {
    ok: false,
    code: outcome.code,
    message: outcome.message,
    ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
  };
}

export async function* runTurn(options: RunTurnOptions): AsyncGenerator<TurnEvent> {
  const { db, conversationId, provider, signal } = options;

  const conversation = getConversation(db, conversationId);
  if (conversation === undefined) throw new Error(`会话不存在：${conversationId}`);

  /**
   * 步数上限：三态。
   * ★ `null` = 用户显式关闭上限 ⇒ 用 `Number.POSITIVE_INFINITY` 表示"永不触发"，
   *   **不要**用 0 或一个超大魔数：0 会让第一步就中止，魔数会在报错文案里露出假数字。
   */
  const maxSteps =
    options.maxSteps === null
      ? Number.POSITIVE_INFINITY
      : Math.min(Math.max(1, Math.trunc(options.maxSteps ?? DEFAULT_MAX_STEPS)), MAX_STEPS_CEILING);
  const agentRole = conversation.agentRole === 'subagent' || options.agentRole === 'subagent' ? 'subagent' : 'main';
  const memoryEnabled = agentRole === 'main' && !!conversation.projectId;
  const permissionMode = resolvePermissionMode(conversation.permissionMode);
  const workspacePath = options.workspacePath ?? null;
  const projectSharedDir = options.projectSharedDir ?? null;
  const roots = rootsFor(permissionMode, workspacePath, projectSharedDir);

  // ★ 工具可见性与"发什么"由**同一个对象**决定（ToolSurface）：
  //   它一次冻结「权限档 + 用户三态配置 + 目录构建」，
  //   所以"模型看到的工具"与"执行时放行的工具"不可能不一致。
  //   ★ v18 起三态是**三层合并**：会话覆盖 → 全局设置 → 定义默认。
  //     不传 conversationId 的调用方（子代理/维护）自然退回全局，行为与以前一致。
  const toolModes = effectiveToolModes(db, conversationId);
  const surface =
    options.tools === undefined ? undefined : createSurface(options.tools, permissionMode, toolModes, agentRole);
  const providerTools = surface?.tools ?? [];
  const toolNames = surface?.visibleNames ?? [];

  // ★ 系统提示走**分段装配**：内置段 + 用户自定义指令 + 压缩摘要，各自独立、按稳定度排序。
  //   未来要加新的注入来源（记忆、项目文件、技能、插件）只需 register 一个 PromptSource，
  //   不用动这里。
  const promptBuilder = new PromptBuilder(builtinSources());
  const projectMemory = memoryEnabled ? projectMemoryBlock(db, conversationId) : null;

  const userMessage = appendMessage(db, { conversationId, role: 'user', content: options.userText });
  // Short exchanges do not manufacture obligations or no-progress paperwork.
  let obligation = memoryEnabled && getMemoryRhythm(db, conversationId).due ? beginObligation(db, conversationId, userMessage.seq) : null;
  const ensureObligation = () => {
    if (obligation || !memoryEnabled) return;
    obligation = beginObligation(db, conversationId, userMessage.seq);
    // A turn may cross the interval after earlier work. Replay its saved receipts,
    // not inferred call intent, so a prior write cannot be excused as no-progress.
    const names = new Map<string,string>();
    for (const row of listMessages(db, conversationId, userMessage.seq)) {
      for (const call of row.toolCalls ?? []) names.set(call.id,call.name);
      if (row.role === 'tool' && row.toolCallId && names.has(row.toolCallId)) {
        try { const result = JSON.parse(row.content ?? '{}') as Record<string,unknown>;
          captureObligationTool(db,conversationId,userMessage.seq,row.seq,names.get(row.toolCallId)!,result,options.tools);
        } catch { /* malformed saved data is never successful evidence */ }
      }
    }
  };
  updateConversation(db, conversationId, { state: 'running' });
  yield { type: 'user', message: userMessage };

  let finalReason: FinishReason = 'error';
  let lastSignature: string | null = null;
  let repeats = 0;
  let lastStep = 0;
  let lastSystemText = '';
  let lastContextMessages: readonly ChatMessage[] = [];
  let autoCompactionFailed = false;
  /** 本轮是否有工具宣告了"干完了"（A1）。它是"没有步数上限"时唯一不靠模型自愿闭嘴的出口。 */
  let concluded = false;

  try {
    for (let step = 1; ; step += 1) {
      lastStep = step;
      if (step > maxSteps) {
        // ★ 说清"这是可调的" —— 否则用户只看到一句"中止"，不知道下一步该做什么
        yield {
          type: 'error',
          message: `达到单轮步数上限 ${maxSteps}，本轮中止（这一步已经做了不少工作，结果都已保存）。想让它继续跑更久：设置 → 通用 → 单轮步数上限，最高 ${MAX_STEPS_CEILING}；或者直接说「继续」让它接着干。`,
          retryable: false,
        };
        finalReason = 'length';
        break;
      }

      if (memoryEnabled && options.tools && !autoCompactionFailed) {
        const result = await maybeAutoCompact({db,conversationId,tools:options.tools,provider,signal});
        if (result === 'failed') autoCompactionFailed = true; // no automatic paid retry in this turn
      }
      // ① 组装上下文：system 在最前（稳定前缀）；已被压缩的区间换成"摘要 + 指针"
      // A runtime delegated call must not inherit the main conversation's old
      // maintenance replies or summaries. Real child conversations retain their own history.
      const assembled = agentRole === 'subagent' && conversation.agentRole !== 'subagent'
        ? { messages: listMessages(db,conversationId,userMessage.seq - 1), summaries: [] }
        : assembleContext(db, conversationId);
      // Summaries replace history only; they never enter the cached system prefix.
      const prompt = memoryAwarePrompt(db, conversationId, promptBuilder, {
        conversationId,
        agentRole,
        permissionMode,
        workspacePath,
        projectSharedDir,
        toolNames,
        userInstructions: conversation.instructions,
        projectMemory,
        summaryBlock: null,
      }, providerTools);
      lastSystemText = prompt.text;
      lastContextMessages = prompt.contextMessages;
      if (memoryEnabled) observeWaterline(db, conversationId, prompt.state.contextTokens, prompt.state.contextWindow);
      const messages: ChatMessage[] = [
        ...projectRequestMessages(prompt,assembled),
        /**
         * ★ A3 steering：把这一步之前排队的**运行时输入**临时拼在最后一条消息之后。
         *
         * 三条判据（都在 `core/agent/steering.ts` 的注释里展开了）：
         * 1. **只在请求里出现，不进库** —— 库里的原文与 `recall` 必须逐字不变；
         * 2. **一条只领一次** —— 重复注入同一句提醒，模型会把重复当强调；
         * 3. **来源必须标出来** —— 模型要能分清"用户说的"与"运行时提醒的"。
         *
         * ★ 为什么放在 `sanitizeToolPairs` **之后**：它是追加的临时尾部内容，
         *   不参与工具配对判定。放在前面会被当成"一条多余的消息"，语义上也不对。
         */
        ...(() => {
          const injected = renderPendingInputs(claimPendingInputs(db, conversationId, step));
          return injected === null ? [] : [{ role: 'user' as const, content: injected }];
        })(),
      ];

      const aggregator = new ToolCallAggregator();
      let text = '';
      let reasoning = '';
      let usage: Usage | null = null;
      let stepReason: FinishReason = 'error';
      let sawError = false;
      /**
       * ★ 流式判据是「**这一步真的调用了维护类工具**」，不是「注册表里有维护工具」。
       *   上一版用后者：`createDefaultRegistry(db)` 一定会注册 memory_read/memory_propose，
       *   于是这个判断恒为真 ⇒ **所有档位、所有步骤的正文都被缓冲到步末才吐出**，
       *   首字从 11ms 变成 600ms+（实测）。工具调用是流式到达的，所以可以边看边判：
       *   一旦出现维护类调用就停止转发后续正文，避免把"我要记账了"这类话漏到聊天里。
       */
      let suppressStream = false;

      // ② 跑一步
      const request: ChatRequest = withThinking(
        {
          model: conversation.model,
          messages,
          ...(providerTools.length > 0 ? { tools: providerTools } : {}),
        },
        // ★ 思考强度的来源是**会话**（用户在输入框右下角选的），不是 provider 默认值：
        //   同一个连接换模型时，用户希望"我上次设的强度"继续生效。
        options.thinkingShape,
        conversation.thinkingEffort as 'off' | 'low' | 'medium' | 'high' | null,
      );
      for await (const event of provider.stream(request, signal)) {
        if (event.type === 'text') {
          text += event.delta;
          if (!suppressStream) yield { type: 'text', delta: event.delta };
        } else if (event.type === 'reasoning') {
          reasoning += event.delta;
          if (!suppressStream) yield { type: 'reasoning', delta: event.delta };
        } else if (event.type === 'tool_call') {
          aggregator.apply(event);
          if (event.name !== undefined && surface?.displayChannel(event.name) === 'maintenance') suppressStream = true;
        } else if (event.type === 'usage') {
          usage = event.usage;
          yield { type: 'usage', usage: event.usage };
        } else if (event.type === 'finish') {
          stepReason = event.reason;
        } else {
          sawError = true;
          // ★ 只落**结构化最小信息**：HTTP 状态 + 粗分类。
          //   上游响应体/提示词/密钥一个字都不进库 —— 但也不能像上一版那样只剩一个码，
          //   否则用户看到"模型请求失败"、我这边查日志也查不出是 401 还是 429（2026-11-08 真事）。
          recordStepEvent(db, {
            conversationId,
            stepNo: step,
            kind: 'provider_error',
            payload: {
              retryable: event.retryable,
              code: 'provider_request_failed',
              ...(event.status === undefined ? {} : { status: event.status }),
              ...(event.kind === undefined ? {} : { failureKind: event.kind }),
            },
          });
          yield {
            type: 'error',
            message: `模型请求失败（${describeProviderFailure(event)}）；上游正文未持久化。`,
            retryable: event.retryable,
          };
        }
      }

      // ③ 落库（即便这一轮出错，已经生成的部分也要留住）
      // 正文已经边生成边转发过了，这里**不再补发**（补发会重复显示）。
      const calls = aggregator.list().map(call => ({ ...call, displayChannel: surface?.displayChannel(call.name) ?? 'chat' as const }));
      const displayChannel = calls.length > 0 && calls.every(call => call.displayChannel === 'maintenance') ? 'maintenance' : 'chat';
      const assistantMessage = appendMessage(db, {
        conversationId,
        role: 'assistant',
        displayChannel,
        content: text.length > 0 ? text : null,
        reasoning: reasoning.length > 0 ? reasoning : null,
        toolCalls: calls.length > 0 ? calls : null,
        usage,
        finishReason: stepReason,
      });
      yield { type: 'assistant', message: assistantMessage };

      recordStepEvent(db, {
        conversationId,
        stepNo: step,
        kind: 'step_end',
        payload: {
          finishReason: stepReason,
          // ★ `input` 记的是**输入总量**（三桶之和）。2026-11-09 改成三桶口径后
          //   `usage.input` 只剩未命中的那部分，直接用会让审计里的输入量静默变小。
          //   见 `core/model/usage.ts` 的注释。
          ...(usage === null ? {} : { input: usageInputTotal(usage), output: usage.output }),
          ...(calls.length > 0 ? { toolCalls: calls.length } : {}),
        },
      });

      // ④ 终止判据（三类兜底：错误 / 中止 / 没有工具调用）
      if (sawError) {
        finalReason = 'error';
        break;
      }
      if (stepReason === 'abort') {
        finalReason = 'abort';
        break;
      }
      if (calls.length === 0) {
        finalReason = stepReason;
        break;
      }

      // ⑤ 抖动防护：同样的调用反复出现 ⇒ **先提醒、再升级、最后才中止**（A4 / `D1@L637`）
      // ★ 签名必须走**规范化**（A2 / `D1@L639`）：`call.arguments` 是模型生成的 JSON 串，
      //   直接 JSON.stringify 会保留字段顺序 ⇒ 模型把 `{"a":1,"b":2}` 写成 `{"b":2,"a":1}`
      //   就得到新签名，守卫永远数不到 3（真机踩过：maxSteps=null 时无限循环）。
      const signature = canonicalCallSignature(calls);
      if (signature === lastSignature) {
        repeats += 1;
      } else {
        lastSignature = signature;
        repeats = 1;
      }
      /**
       * ★★ 为什么不再"第 3 次就硬停"（`D1@L637` A2，对照 DSH 的 repeat-tool-reminder）：
       *
       * 原来 `repeats >= 3` 直接 `break`。但"同工具同参数第 3 次"未必是空转 ——
       * 完全可能是**正常的重试**：读一个刚被别的进程写完的文件、等一个还在生成的结果、
       * 或者模型第一次传错了参数正在纠正。硬停会把这些正常路径一刀切掉，用户看到的是
       * "莫名其妙就说空转中止"。
       *
       * DSH 的做法是**只插提醒、不否决**（`D1@L616` G3）。我们取中间态：
       * - 第 3 次 ⇒ 插一条运行时提醒（走 A3 的通道，**不进库**），继续跑；
       * - 第 5 / 8 次 ⇒ 升级措辞，仍然继续；
       * - 超过 8 次 ⇒ 才真停。到那时候"这不是重试而是真空转"已经有充分证据了。
       *
       * ★ 提醒走 `queueInput` 而不是 `yield {type:'error'}`：后者会让前端把这一轮标红，
       *   而这时**还没有错**，只是需要模型换个做法。
       */
      if (repeats >= DOOM_LOOP_HARD_STOP) {
        yield {
          type: 'error',
          message: `连续 ${String(repeats)} 次完全相同的工具调用，已中止（防止空转烧钱）。如果这确实是必要的重试，请换个做法：先读一次确认状态，或换一个工具。`,
          retryable: false,
        };
        finalReason = 'error';
        break;
      }
      if (repeats >= DOOM_LOOP_REPEATS) {
        queueInput(db, {
          conversationId,
          source: 'repeat-tool-reminder',
          content:
            repeats >= DOOM_LOOP_ESCALATE
              ? `你已经连续 ${String(repeats)} 次用完全相同的参数调用同一个工具，结果不会再变。请**换一个做法**（换工具、先读状态核对、或直接向用户说明卡在哪），不要再用同样的参数重复调用。`
              : `注意：你刚用完全相同的参数连续调用了同一个工具 ${String(repeats)} 次。如果不是有意的重试，请换一种做法；如果是，请说明你要等什么。`,
        });
      }

      // ⑥ 执行工具。可见性/档位在 registry 里判；denial 与 failure 都是**结构化结果**喂回模型
      const ctx: ToolContext = {
        conversationId,
        agentRole,
        permissionMode,
        roots,
        workspacePath,
        projectSharedDir,
        cwd: workspacePath ?? projectSharedDir ?? options.tempDir ?? process.cwd(),
        tempDir: options.tempDir ?? join(tmpdir(), 'alkaid-tmp'),
        signal,
        turnUserSeq: userMessage.seq,
        ...(options.maxToolOutputChars === undefined ? {} : { maxToolOutputChars: options.maxToolOutputChars }),
      };

      for (const call of calls) {
        if (['memory_propose','memory_stage','memory_disposition'].includes(call.name)) {
          const parsed = parseToolArguments(call.arguments);
          const principleOnly = call.name === 'memory_stage' && 'value' in parsed && parsed.value && typeof parsed.value === 'object' && (parsed.value as Record<string,unknown>)['action'] === 'principle_propose';
          if (!principleOnly) ensureObligation();
        }
        const result = await runToolCall(surface, call, ctx);
        const toolMessage = appendMessage(db, {
          conversationId,
          role: 'tool',
          displayChannel: call.displayChannel,
          toolCallId: call.id,
          content: JSON.stringify(result),
        });

        if (memoryEnabled && result['ok'] === true && (call.name === 'write' || call.name === 'edit')) {
          const parsed = parseToolArguments(call.arguments);
          const path = 'value' in parsed && parsed.value !== null && typeof parsed.value === 'object'
            ? (parsed.value as Record<string, unknown>)['path'] : undefined;
          if (typeof path === 'string') recordSuccessfulFileTouch(db, conversationId, toolMessage.seq, call.name, resolve(ctx.cwd, path));
        }

        if (obligation) captureObligationTool(db, conversationId, userMessage.seq, toolMessage.seq, call.name, result, options.tools);

        // ★ 记一次"真的用过了"（做将来"建议改为按需"的数据基础）。
        //   只在执行后记，被权限拒绝的不算用过 —— 否则冷门工具会因为"试过一次"而显得热门。
        if (result['code'] !== 'tool_not_found' && result['code'] !== 'tool_disabled') {
          recordToolUse(db, call.name);
        }

        // 审计：只记"哪个工具、什么结果"，**不记参数原文**（参数里可能是密钥/源码）
        const ok = result['ok'] === true;
        const code = typeof result['code'] === 'string' ? result['code'] : undefined;
        recordStepEvent(db, {
          conversationId,
          stepNo: step,
          kind: ok ? 'tool_call' : code === 'denied_by_policy' ? 'policy_denied' : 'tool_error',
          payload: {
            tool: call.name,
            ...(code === undefined ? {} : { code }),
            ...(ok ? { resultChars: String(result['content'] ?? '').length } : {}),
            // ★ 耗时与截断进审计（不含参数原文，所以仍然安全），
            //   界面要显示"跑了多久 / 结果被截过"就不必再从中文里正则抠。
            ...(typeof result['durationMs'] === 'number' ? { durationMs: result['durationMs'] } : {}),
            ...(result['truncated'] === true ? { truncated: true } : {}),
          },
        });

        yield { type: 'tool', message: toolMessage };

        /**
         * ★ A1：**工具主动宣告收轮**（`D1@L641`，对应 DSH 的 `exec.concludeTurn()`）。
         *
         * 判据顺序是刻意的：**先把 tool 消息写完并 yield 出去，再收轮**。
         * 反过来做的话，模型下一轮会看到「上一次调了工具、但没有结果」——
         * 那正是我们要用 `sanitizeToolPairs` 兜的那类毒化历史。
         *
         * ★ 为什么 `concluded` 只在**成功**时认：失败的工具不可能"宣告干完了"，
         *   认它等于让一次报错提前终结整轮，用户会以为事情做完了。
         */
        if (result['ok'] === true && result['conclude'] === true) {
          concluded = true;
        }
      }

      /**
       * ★ A1 收轮出口：只要**这一批里有一个工具宣告了干完了**，就不再追加模型请求。
       *
       * ★ 为什么放在"所有 call 都执行完"之后，而不是碰到第一个就 break：
       *   同一批里可能还有别的 call（模型常一次发好几个）。中途 break 会让后面的 call
       *   **有 tool_calls 却没有 tool 回复** ⇒ 下一轮请求必 400（2026-11-08 真事故）。
       *   所以：先跑完整批、全部落库，再收轮。
       *
       * ★ 为什么 `finalReason` 用 `completed` 而不是 `stop`：
       *   `stop` 是"模型自然停"，容易被误读成"活干完了"；`completed` 明确表示
       *   **由工具宣告完成**。两者在审计与 UI 上必须分得开（见 `shared/types.ts` 的注释）。
       */
      if (concluded) {
        finalReason = 'completed';
        break;
      }
    }
    // Pre-finish gate: normal business has streamed, but the turn remains owned/running
    // until evidence is checked and at most one bounded maintenance-only continuation settles.
    const compressionDue = memoryEnabled && !!options.tools && !autoCompactionFailed && autoCompactionDue(db,conversationId,options.tools);
    if (memoryEnabled && (getMemoryRhythm(db, conversationId).due || compressionDue)) ensureObligation();
    if (obligation) {
      const state = readObligation(db, conversationId, userMessage.seq);
      if (!getMemoryRhythm(db, conversationId).due && !compressionDue && state?.status !== 'staged') deferMemoryTurn(db,conversationId,userMessage.seq);
      else if (signal.aborted || finalReason === 'abort') finishObligation(db, conversationId, userMessage.seq, 'abort');
      /**
       * ★ 只有**正常收轮**才允许走"补记忆"这条正路：`stop` 与 `completed` 都算正常
       *   （前者是模型自然停，后者是工具宣告完成）。把 `completed` 漏在这句外面，
       *   工具一宣告完成反而会被记成 `error` 分支 —— 那是 A1 落地时最容易埋的坑。
       */
      else if (finalReason !== 'stop' && finalReason !== 'completed') finishObligation(db, conversationId, userMessage.seq, 'error');
      else if (!options.tools || !surface) finishObligation(db, conversationId, userMessage.seq, 'registry_missing');
      else if (!surface.canCall('memory_propose') || !surface.canCall('memory_stage')) finishObligation(db, conversationId, userMessage.seq, 'tools_disabled');
      else {
        yield* repairProjectMemory({ db, conversationId, userSeq: userMessage.seq,
          model: conversation.model, provider, registry: options.tools, surface,
          context: { conversationId, agentRole, permissionMode, roots, workspacePath, projectSharedDir,
            cwd: workspacePath ?? projectSharedDir ?? options.tempDir ?? process.cwd(),
            tempDir: options.tempDir ?? join(tmpdir(), 'alkaid-tmp'), signal, turnUserSeq: userMessage.seq },
          stepNo: lastStep + 1, systemText: lastSystemText, signal, thinkingShape: options.thinkingShape,
          timeoutMs: options.memoryClosureTimeoutMs,
          requireLog: compressionDue, contextMessages: lastContextMessages,
          historyAfterSeq: getMemoryRhythm(db, conversationId).baselineSeq,
        });
      }
    }
    if (memoryEnabled && options.tools && !autoCompactionFailed && !signal.aborted && (finalReason === 'stop' || finalReason === 'completed')) {
      await maybeAutoCompact({db,conversationId,tools:options.tools,provider,signal});
    }
  } finally {
    if (obligation) {
      let state = readObligation(db, conversationId, userMessage.seq);
      if (state && (state.status === 'required' || state.status === 'repairing')) {
        state = finishObligation(db, conversationId, userMessage.seq, signal.aborted ? 'abort' : 'incomplete');
      }
      // Legacy debt remains a compatibility projection; exemptions are NOT forged as user skips.
      if (state?.status === 'staged') {
        recordTurnProgress(db, conversationId, userMessage.seq, 'progress_recorded');
        recordMemoryFulfillment(db, conversationId, userMessage.seq);
      }
      else if (state?.status === 'incomplete') recordTurnProgress(db, conversationId, userMessage.seq, 'progress_not_recorded');
    }
    // ★★★ 用户开关（`MaintainerConfig.autoApproveOnTurnEnd`）：**本轮正常结束**后，
    //   把本项目里"不会冲突"的 pending 暂存提案自动应用（原则永远除外）。
    //
    //   判据与冲突口径全在 `core/memory/store.ts`（那里有完整注释与测试）：
    //   ① CAS 通过；② 同一批里没有两条改同一条记录；③ kind 不是 principle。
    //
    //   ★ 为什么判据放在 `finally` 而不是循环内部：收尾动作必须在**业务答复已经落库、
    //     义务也已结算之后**才发生，且**任何情况下都不能改变本轮结果** ——
    //     所以只认 `stop` / `completed`（见上文"正常收轮"的同一判据），
    //     异常/中止/步数超限一律不做；自动批准自己失败也只吞掉，不重试。
    if (conversation.projectId !== null && !signal.aborted
      && (finalReason === 'stop' || finalReason === 'completed')) {
      try {
        // ★ 只批准**本对话**自己提交的提案（审计 `ALK-HIGH-05`）：
        //   别人的留给维护 AI 的多作者合并审查，否则那个机制被静默绕过。
        autoApproveOnTurnEnd(db, conversation.projectId, conversationId);
      } catch {
        // 失败不重试、不影响本轮结果。审计也尽力而为 —— 绝不能让它再抛一次。
        try {
          recordStepEvent(db, {
            conversationId, stepNo: lastStep, kind: 'tool_error',
            payload: { phase: 'memory_auto_approve', code: 'MEMORY_AUTO_APPROVE_FAILED' },
          });
        } catch { /* 连审计都写不进时，静默收尾 */ }
      }
    }
    updateConversation(db, conversationId, { state: 'idle' });
  }

  yield { type: 'finish', reason: finalReason };
}
