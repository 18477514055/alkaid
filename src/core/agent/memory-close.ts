import type { DatabaseSync } from 'node:sqlite';
import type { ChatEvent, ChatRequest, ToolDef, Usage } from '../../shared/types.ts';
import type { TurnEvent } from './loop.ts';
import type { Provider } from '../model/provider.ts';
import { withThinking } from '../model/thinking.ts';
import { ToolCallAggregator } from '../model/aggregate.ts';
import { sanitizeToolPairs, estimateTokens } from '../context/compact.ts';
import { getMemoryRhythm } from '../memory/rhythm.ts';
import { appendMessage, listMessages } from '../store/repo.ts';
import { recordStepEvent } from '../store/audit.ts';
import { recordToolUse } from '../tools/settings.ts';
import type { ToolContext, ToolRegistry } from '../tools/types.ts';
import type { ToolSurface } from '../tools/runtime.ts';
import { finishObligation, markObligationRepair, noteObligationBusiness, noteObligationProposal, readObligation } from '../memory/obligations.ts';
import { getCompactionDuties } from '../memory/duties.ts';
import { projectRequestMessages } from './prompt/projection.ts';
import type { ChatMessage } from '../../shared/types.ts';

export const MEMORY_CLOSE_MAX_INPUT_CHARS = 240_000;
export const MEMORY_CLOSE_MAX_OUTPUT_CHARS = 16_000;
export const MEMORY_CLOSE_MAX_TOKENS = 4096;
export const MEMORY_CLOSE_TIMEOUT_MS = 30_000;
const ALLOWED = new Set(['memory_propose', 'memory_stage', 'memory_disposition']);
const parse = (value: string): unknown => { try { return JSON.parse(value); } catch { return null; } };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Only a SUCCESSFUL persisted tool reply can discharge an obligation; call intent is not proof. */
export function captureObligationTool(db: DatabaseSync, conversationId: string, userSeq: number, messageSeq: number,
  name: string, result: Record<string, unknown>, registry: ToolRegistry | undefined): void {
  if (!readObligation(db, conversationId, userSeq)) return;
  const tool = registry?.get(name);
  try {
    if (result.ok === true && (name === 'memory_propose' || name === 'memory_stage')) {
      const body = typeof result.content === 'string' ? parse(result.content) : null;
      if (object(body) && object(body.proposal) && typeof body.proposal.id === 'string' && body.pendingHumanApproval !== true) {
        noteObligationProposal(db, conversationId, userSeq, body.proposal.id, messageSeq);
      }
    } else if (tool && tool.definition.displayChannel !== 'maintenance' && name !== 'describe_tool'
      && !['tool_not_found', 'tool_disabled', 'denied_by_policy'].includes(String(result.code))) {
      noteObligationBusiness(db, conversationId, userSeq, messageSeq, result.ok === true && tool.kind !== 'read_only');
    }
  } catch {
    // Do not erase the business reply or persist arbitrary validation text.
    recordStepEvent(db, { conversationId, stepNo: 0, kind: 'tool_error', payload: { tool: name, code: 'memory_evidence_rejected' } });
  }
}

/** Abort promptly even when an injected provider never observes its signal. No detached writer owns a capability. */
async function* boundedStream(provider: Provider, request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  if (signal.aborted) return;
  let abort!: () => void;
  const stop = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('memory_closure_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  const stream = provider.stream(request, signal);
  try {
    for (;;) {
      const next = await Promise.race([stream.next(), stop]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    void stream.return(undefined).catch(() => {});
  }
}

type CloseOptions = {
  db: DatabaseSync; conversationId: string; userSeq: number; model: string; provider: Provider;
  registry: ToolRegistry; surface: ToolSurface; context: ToolContext; stepNo: number;
  systemText: string; signal: AbortSignal; thinkingShape?: string | null; timeoutMs?: number;
  historyAfterSeq?: number;
  requireLog?: boolean;
  contextMessages?: readonly ChatMessage[];
};

/** Exactly ONE provider request, no business tools, no user message or business prose replay. */
export async function* repairProjectMemory(options: CloseOptions): AsyncGenerator<TurnEvent> {
  const { db, conversationId, userSeq, surface, registry } = options;
  const initial = readObligation(db, conversationId, userSeq);
  if (!initial) return;
  const strict = options.requireLog ? getCompactionDuties(db,conversationId,userSeq) : null;
  const needsTriple = strict !== null && !strict.complete;
  if (initial.status === 'staged' && !needsTriple || initial.status === 'exempt') {
    // Seal a proactive completion too, so later rejected evidence is visibly INVALID,
    // not reinterpreted as a never-finished 'required' turn. This makes no provider request.
    finishObligation(db, conversationId, userSeq, 'complete');
    return;
  }
  if (!markObligationRepair(db, conversationId, userSeq, needsTriple)) return;
  const specs: ToolDef[] = [...ALLOWED].filter(name => surface.canCall(name)).flatMap(name => {
    const tool = registry.get(name);
    if (!tool) return [];
    // The one-shot repair surface must describe ONLY the actions it will actually execute.
    // Do not advertise principles/extensions/handoffs here and then hope the model ignores them.
    const parameters = name === 'memory_stage' ? {
      ...tool.definition.parameters,
      properties: { ...(tool.definition.parameters.properties as Record<string, unknown>), action: { type: 'string', enum: ['intent', 'triage'] } },
      required: ['action', 'payload', 'idempotencyKey', 'reason'],
    } : tool.definition.parameters;
    return [{ name, description: name === 'memory_stage'
      ? '只暂存本轮两类制品：intent的payload为{goal,did,issues,next}；triage的payload为{keep:[{what,why?,where?}],stash:[{what,why?,where?}],drop:[{what,why?}]}。分别调用，带稳定idempotencyKey和证据reason；不会正式应用，不支持其他子动作。'
      : tool.fullDescription, parameters }];
  });
  const control = [
    '\n\n## MEMORY_TURN_CLOSURE — 系统内部的本轮收尾校验，不是新用户请求',
    `本轮userSeq=${userSeq}；缺项=${(strict?.missing??initial.missing).join(',') || '需要重新固化'}。你已经给出了业务答复，不得再重述、预告或补业务说明。`,
    options.requireLog ? '压缩前三层义务必须分别成功：①memory_propose提交真实台账进展（不是artifact:intent）；②memory_stage(action=intent)记录进展日志{goal,did,issues,next}；③最后memory_stage(action=triage)分流keep/stash/drop。三份不同提案，一份日志不能兼任台账；补日志后，过早的旧triage必须重新提交。只有这些真实成功后程序才会压缩，手动也不旁路。' : '本项目义务为：①用memory_propose提交真实进展，或memory_stage(action=intent)提交目标/实际完成/卡点/下一步；②memory_stage(action=triage)分流。仅暂存，仍须独立审核。',
    '只补缺项，既有成功且未过时的提案不要重复提交。本次只有一次生成机会，请在同一回复里同时发出所需的多个工具调用，不要先输出计划再等待下一轮。',
    `新进展可使用recordId=${JSON.stringify(`turn-${conversationId}-${userSeq}`)}、baseRevision=0、idempotencyKey=${JSON.stringify(`progress-${userSeq}`)}；已有记录更新须遵守真实revision，禁止猜。`,
    `日志提案idempotencyKey可用${JSON.stringify(`log-${userSeq}`)}；三桶提案idempotencyKey可用${JSON.stringify(`triage-${userSeq}${options.requireLog?'-compact':''}`)}，各桶是{what,why?,where?}数组，可留空桶，但不能用全空三桶冒充有效分流。只保留可核实材料，禁止为了消欠账编造。`,
    '如果本轮确实只是问候/重复确认而没有新增成果，调用memory_disposition给出真实简短原因；已发生业务写入或已有进展提案不能宣称无新增。',
    '下面提供自上次成功整理以来的对话与工具证据；请覆盖这些轮次的真实新增进展，不仅最后一句。若不足以核实就保留未完成。严禁调用业务文件/shell/网络工具，严禁修改原则或批准提案。',
  ].join('\n');
  const history = listMessages(db, conversationId, Math.min(options.historyAfterSeq ?? userSeq - 1, userSeq - 1));
  const buildRequest = (start: number): ChatRequest => withThinking({
    model: options.model, maxTokens: MEMORY_CLOSE_MAX_TOKENS, maxAttempts: 1,
    messages: projectRequestMessages({text:options.systemText,sections:[],contextMessages:[...(options.contextMessages??[]),
      ...(start > 0 ? [{role:'user' as const,content:`[maintenance_evidence_scope — 仅本次收尾的证据范围，不是对话压缩]\n更早的 seq ${history[0]!.seq}-${history[start - 1]!.seq} 原文未删除、未生成摘要，本请求未读取这些原文；可随后用 recall 按区间逐字核对。不要声称已总结未读范围，不从指针推断事实；只记录本请求中可核实的新进展，把较早未复核范围明确列入下一步/待查。`}] : []),
      {role:'user',content:control}]},{messages:history.slice(start),summaries:[]}),
    tools: specs,
  }, options.thinkingShape, 'off');
  const withinBudget = (request: ChatRequest): boolean => {
    const serialized = JSON.stringify(request);
    return serialized.length <= MEMORY_CLOSE_MAX_INPUT_CHARS && estimateTokens(serialized) <= getMemoryRhythm(db,conversationId).contextWindow * .8;
  };
  let request = buildRequest(0);
  let evidenceStart = 0;
  // Crossing the compression line must not make the three-duty repair itself
  // impossible. Restrict ONLY this maintenance request to complete recent turns;
  // no original row or business-context projection is changed before duties pass.
  // Keep the current real user and every subsequent tool batch intact. If even
  // that complete turn does not fit, fail closed rather than clip its evidence.
  if (options.requireLog && !withinBudget(request)) {
    for (let index = 1; index < history.length; index++) {
      if (history[index]!.role !== 'user' || history[index]!.seq > userSeq) continue;
      const candidate = buildRequest(index);
      if (withinBudget(candidate)) { request = candidate; evidenceStart = index; break; }
    }
  }
  if (!withinBudget(request)) {
    finishObligation(db, conversationId, userSeq, 'repair_input_limit');
    return;
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? MEMORY_CLOSE_TIMEOUT_MS);
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, timeout, controller.signal]);
  const aggregator = new ToolCallAggregator();
  let outputChars = 0; let usage: Usage | null = null; let failure = false; let finish = ''; let assistantPersisted = false;
  try {
    for await (const event of boundedStream(options.provider, request, signal)) {
      if (event.type === 'tool_call') { outputChars += (event.argsDelta?.length ?? 0) + (event.name?.length ?? 0); aggregator.apply(event); }
      else if (event.type === 'text' || event.type === 'reasoning') outputChars += event.delta.length;
      else if (event.type === 'usage') { usage = event.usage; yield { type: 'usage', usage: event.usage }; }
      else if (event.type === 'finish') finish = event.reason;
      else if (event.type === 'error') failure = true;
      if (outputChars > MEMORY_CLOSE_MAX_OUTPUT_CHARS || aggregator.size > 8) { failure = true; controller.abort(); break; }
    }
    // Partial tool arguments after errors, cancellation or length termination NEVER execute.
    if (failure || signal.aborted || !['stop', 'tool_calls'].includes(finish)) {
      finishObligation(db, conversationId, userSeq, timeout.aborted ? 'repair_timeout' : 'repair_failed');
      return;
    }
    const calls = aggregator.list().map(call => ({ ...call, displayChannel: 'maintenance' as const }));
    // Do not poison future requests with malformed/duplicate tool-call identities.
    if (calls.some(call => !call.id || call.id.length > 200 || !ALLOWED.has(call.name) || !surface.canCall(call.name) || !/^[a-zA-Z0-9_-]+$/.test(call.name)) || new Set(calls.map(call => call.id)).size !== calls.length) {
      finishObligation(db, conversationId, userSeq, 'repair_failed');
      return;
    }
    const assistant = appendMessage(db, { conversationId, role: 'assistant', displayChannel: 'maintenance',
      content: null, reasoning: null, toolCalls: calls.length ? calls : null, usage, finishReason: finish as 'stop' | 'tool_calls' });
    assistantPersisted = true;
    yield { type: 'assistant', message: assistant };
    for (const call of calls) {
      if (signal.aborted) break;
      let result: Record<string, unknown>;
      const args = parse(call.arguments);
      // Even a valid memory_stage has a principle-propose subaction: never permit it in automatic repair.
      const allowedAction = call.name !== 'memory_stage' || object(args) && ['intent', 'triage'].includes(String(args.action));
      if (!ALLOWED.has(call.name) || !surface.canCall(call.name) || !allowedAction) result = { ok: false, code: 'memory_closure_tool_denied', message: '自动收尾仅允许本轮进展、分流或无新增声明，不执行其他动作。' };
      else if (!object(args)) result = { ok: false, code: 'invalid_arguments', message: '收尾参数不是完整对象。' };
      else {
        const outcome = await surface.execute(call.name, args, { ...options.context, signal, turnUserSeq: userSeq });
        result = outcome.ok ? { ok: true, content: outcome.content } : { ok: false, code: outcome.code, message: outcome.message };
        recordToolUse(db, call.name);
      }
      const tool = appendMessage(db, { conversationId, role: 'tool', displayChannel: 'maintenance', toolCallId: call.id, content: JSON.stringify(result) });
      captureObligationTool(db, conversationId, userSeq, tool.seq, call.name, result, registry);
      recordStepEvent(db, { conversationId, stepNo: options.stepNo, kind: result.ok === true ? 'tool_call' : 'tool_error', payload: { tool: call.name, phase: 'memory_closure', ...(result.ok === true ? {} : { code: result.code }) } });
      yield { type: 'tool', message: tool };
    }
    const state = readObligation(db, conversationId, userSeq);
    finishObligation(db, conversationId, userSeq, state?.status === 'staged' || state?.status === 'exempt' ? 'complete' : 'repair_exhausted');
  } catch {
    finishObligation(db, conversationId, userSeq, timeout.aborted ? 'repair_timeout' : 'repair_failed');
  } finally {
    // Failed or cancelled generations may still report billable usage. Preserve numbers in
    // the same message-backed stats source without storing partial calls or upstream prose.
    if (usage && !assistantPersisted) appendMessage(db, { conversationId, role: 'assistant', displayChannel: 'maintenance', content: null, reasoning: null, toolCalls: null, usage, finishReason: 'error' });
    const state = readObligation(db, conversationId, userSeq);
    recordStepEvent(db, { conversationId, stepNo: options.stepNo, kind: 'step_end', payload: { phase: 'memory_closure', code: state?.code ?? 'OBLIGATION_INCOMPLETE', status: state?.status ?? 'incomplete', ...(evidenceStart > 0 ? { evidenceFromSeq: history[evidenceStart]!.seq, omittedToSeq: history[evidenceStart - 1]!.seq } : {}), ...(usage ? { input: usage.input, output: usage.output } : {}) } });
  }
}
