import type { ChatEvent, FinishReason, Usage } from '../../shared/types.ts';

/**
 * 单帧解析（**纯函数**）。设计稿 §6.2 的六个坑，前五个都落在这个文件里。
 *
 * 调用方负责分帧（`sse.ts`）与网络（`openai.ts`）—— 所以这里的每条逻辑
 * 都能用普通单测钉死，不需要为"一帧怎么解"去起 HTTP 服务器。
 */

/** 跨帧共享的解析状态。一帧的信息不完整（`finish_reason` 常在最后一帧）。 */
export type FrameState = {
  finishReason: FinishReason | null;
  sawDone: boolean;
  sawToolCall: boolean;
};

export function createFrameState(): FrameState {
  return { finishReason: null, sawDone: false, sawToolCall: false };
}

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  // 少数网关会发这几个，统一当 error，别让未知值流到上层
  content_filter: 'error',
  function_call: 'tool_calls',
};

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 归一化用量。★ 各家字段名不同，读不到的就不读（不要填 0 冒充）。
 *
 * ★★ **三桶口径**（本文件是新增数据的唯一入口，口径改在这里）：
 *   上游 `prompt_tokens` 是**输入总量**（含缓存命中），所以要把缓存那两桶**减出去**：
 *
 *     input        = prompt_tokens − cached − cachedWrite   ← 真正花钱按原价算的那部分
 *     cached       = 缓存**读取**量
 *     cachedWrite  = 缓存**写入**量（Anthropic 语义；拿不到就不写这个字段）
 *
 *   于是 `input + cached + cachedWrite` 恒等于上游的 `prompt_tokens`，
 *   三桶之和就是上游账单口径的输入总量 —— 求和不会多也不会少。
 *
 * ★ `reasoning` 是 `completion_tokens`（= `output`）的**子集**，只记录、不参与任何求和；
 *   把它加到 output 上就是重复计费。
 */
function parseUsage(usage: Json): Usage | undefined {
  const promptTokens = asNumber(usage['prompt_tokens']);
  const output = asNumber(usage['completion_tokens']);
  if (promptTokens === undefined && output === undefined) return undefined;

  const promptDetails = asRecord(usage['prompt_tokens_details']);
  const completionDetails = asRecord(usage['completion_tokens_details']);

  const cached =
    asNumber(promptDetails?.['cached_tokens']) ??
    asNumber(usage['prompt_cache_hit_tokens']) ?? // DeepSeek
    asNumber(usage['cached_tokens']);

  /**
   * 缓存**写入**量。OpenAI 兼容网关基本不报，这里只认几种明确写法（读不到就不写字段）：
   * Anthropic 原生的 `cache_creation_input_tokens`，以及个别代理翻译过来的
   * `cache_write_tokens` / `prompt_tokens_details.cache_creation_tokens`。
   */
  const cachedWrite =
    asNumber(usage['cache_creation_input_tokens']) ??
    asNumber(usage['cache_write_tokens']) ??
    asNumber(promptDetails?.['cache_creation_tokens']) ??
    asNumber(promptDetails?.['cache_write_tokens']);

  const reasoning =
    asNumber(completionDetails?.['reasoning_tokens']) ?? asNumber(usage['reasoning_tokens']);

  const promptTotal = promptTokens ?? 0;
  const cachedRead = cached ?? 0;
  const cachedWriteTokens = cachedWrite ?? 0;

  const result: {
    input: number;
    output: number;
    cached?: number;
    cachedWrite?: number;
    reasoning?: number;
    inputExcludesCached?: true;
  } = {
    // 三桶口径：input 只留未命中缓存的那部分（上游 prompt_tokens 减掉两个缓存桶）
    input: Math.max(promptTotal - cachedRead - cachedWriteTokens, 0),
    output: output ?? 0,
  };
  if (cached !== undefined) result.cached = cached;
  if (cachedWrite !== undefined) result.cachedWrite = cachedWrite;
  if (reasoning !== undefined) result.reasoning = reasoning;
  /**
   * ★ 口径判别标记：**只在真的出现缓存数字时才写**。
   *
   *   没有缓存时「input 含不含缓存」是同一件事（`input + 0 === input`），
   *   标不标都不影响任何求和；而库里历史 JSON 一律没有这个字段，
   *   于是读取侧（`core/store/stats.ts`）就能无歧义地区分新旧两种行：
   *   有标记 ⇒ `input` 已扣缓存；没标记 ⇒ 历史数据，`input` 含缓存。
   */
  if (cached !== undefined || cachedWrite !== undefined) result.inputExcludesCached = true;
  return result;
}

/** 提取文本增量。多模态里 `content` 可能是数组，只取其中的文本片段。 */
function parseContentDelta(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct !== undefined) return direct;
  if (!Array.isArray(value)) return undefined;

  const parts: string[] = [];
  for (const part of value) {
    const rec = asRecord(part);
    const text = asString(rec?.['text']);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

/**
 * 解析一条 SSE `data:` 内容，返回这一帧产生的事件（可能是 0..n 个）。
 *
 * ★ 坑 2/3：`choices` 与 `usage` **互相独立**读取 ——
 *   空 `choices` 的帧仍要能读出用量；DeepSeek 还会把 `usage` 骑在内容帧上。
 * ★ 坑 4：推理字段先看 `reasoning_content`（DeepSeek/Kimi），再看 `reasoning`（OpenRouter）。
 * ★ 坑 6：`tool_calls` 增量按 `index` 上报，`id`/`name` 可能只在首帧，`arguments` 逐段拼。
 */
export function parseOpenAiDataFrame(raw: string, state: FrameState): ChatEvent[] {
  const data = raw.trim();
  if (data.length === 0) return [];

  // ★ 坑 1：`[DONE]` 不是 JSON
  if (data === '[DONE]') {
    state.sawDone = true;
    const reason: FinishReason =
      state.finishReason ?? (state.sawToolCall ? 'tool_calls' : 'stop');
    return [{ type: 'finish', reason }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new SseParseError(`SSE 帧不是合法 JSON：${data.slice(0, 200)}`);
  }

  const frame = asRecord(parsed);
  if (frame === undefined) return [];

  const events: ChatEvent[] = [];

  // ① 用量：与 choices 无关，先读
  const usage = asRecord(frame['usage']);
  if (usage !== undefined) {
    const parsedUsage = parseUsage(usage);
    if (parsedUsage !== undefined) events.push({ type: 'usage', usage: parsedUsage });
  }

  // ② 内容增量
  const choices = frame['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return events;

  const choice = asRecord(choices[0]);
  if (choice === undefined) return events;

  const delta = asRecord(choice['delta']);
  if (delta !== undefined) {
    const text = parseContentDelta(delta['content']);
    if (text !== undefined) events.push({ type: 'text', delta: text });

    const reasoning =
      parseContentDelta(delta['reasoning_content']) ?? parseContentDelta(delta['reasoning']);
    if (reasoning !== undefined) events.push({ type: 'reasoning', delta: reasoning });

    const toolCalls = delta['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const rawCall of toolCalls) {
        const call = asRecord(rawCall);
        if (call === undefined) continue;

        const fn = asRecord(call['function']);
        const index = asNumber(call['index']) ?? 0;
        const id = asString(call['id']);
        const name = asString(fn?.['name']);
        const argsDelta = asString(fn?.['arguments']);

        state.sawToolCall = true;
        const event: {
          type: 'tool_call';
          index: number;
          id?: string;
          name?: string;
          argsDelta?: string;
        } = { type: 'tool_call', index };
        if (id !== undefined) event.id = id;
        if (name !== undefined) event.name = name;
        if (argsDelta !== undefined) event.argsDelta = argsDelta;
        events.push(event);
      }
    }
  }

  // ③ 结束原因：只记录，事件留到 [DONE] 或流结束再发（保证 usage 先于 finish）
  const finishReason = asString(choice['finish_reason']);
  if (finishReason !== undefined) {
    state.finishReason = FINISH_REASONS[finishReason] ?? 'error';
  }

  return events;
}

/** 帧本身坏了（不是网络问题）——这类错误**不该重试**。 */
export class SseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseParseError';
  }
}
