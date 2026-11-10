import type { ChatEvent, ChatMessage, ChatRequest } from '../../shared/types.ts';
import { createFrameState, parseOpenAiDataFrame } from './openai-parse.ts';
import { joinUrl, redact, type Provider, type ProviderConfig } from './provider.ts';
import { HttpError, TimeoutError, backoffDelay, classifyError, type ErrorClass } from './retry.ts';
import { SseFrameParser } from './sse.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type OpenAIProviderOptions = {
  readonly config: ProviderConfig;
  readonly fetchImpl?: FetchLike;
  readonly maxAttempts?: number;
  /** 首字节看门狗：一直不吐任何事件就中止。**一旦开始吐 token 就取消** */
  readonly firstByteTimeoutMs?: number;
  readonly backoffBaseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
};

/** 这几个键由本层自己管，`extraBody` 不许覆盖（覆盖会让流式解析失效） */
const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'stream', 'stream_options', 'maxAttempts']);

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content ?? '' };
  }
  if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls !== null && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content ?? '' };
}

export function buildRequestBody(req: ChatRequest, config: ProviderConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(toWireMessage),
    stream: true,
  };

  if (config.supportsStreamUsage !== false) {
    body['stream_options'] = { include_usage: true };
  }

  if (req.tools !== undefined && req.tools.length > 0) {
    body['tools'] = req.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  if (req.temperature !== undefined) body['temperature'] = req.temperature;

  if (req.maxTokens !== undefined) {
    body[config.usesMaxCompletionTokens === true ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
  }

  if (req.extraBody !== undefined) {
    for (const [key, value] of Object.entries(req.extraBody)) {
      if (!PROTECTED_BODY_KEYS.has(key)) body[key] = value;
    }
  }

  return body;
}

export function buildHeaders(config: ProviderConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    // ★ 密钥只走这个头，绝不进请求体（有测试守着）
    authorization: `Bearer ${config.apiKey}`,
    ...config.extraHeaders,
  };
}

/**
 * OpenAI 兼容适配器。
 *
 * 六个坑的处理位置见设计稿 §6.2：
 * 1. `[DONE]` → `openai-parse.ts`
 * 2. 空 `choices` → `openai-parse.ts`
 * 3. `usage` 独立读 → `openai-parse.ts`
 * 4. 推理字段归一 → `openai-parse.ts`
 * 5. 长连接与首字节看门狗 → 本文件
 * 6. `tool_calls` 增量 → `aggregate.ts`（本文件只透传事件）
 */
export function createOpenAiProvider(options: OpenAIProviderOptions): Provider {
  const { config } = options;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const maxAttempts = options.maxAttempts ?? 3;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? 120_000;
  const backoffBaseMs = options.backoffBaseMs ?? 400;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  async function* stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const url = joinUrl(config.baseUrl, config.chatPath);
    const body = JSON.stringify(buildRequestBody(req, config));
    const headers = buildHeaders(config);
    // A bounded maintenance continuation must not inherit normal chat's retry budget.
    // Clamp downward only: a caller cannot increase a provider-level cap.
    const requestAttempts = req.maxAttempts === undefined ? maxAttempts
      : Math.max(1, Math.min(maxAttempts, Math.floor(req.maxAttempts) || 1));

    /** 一旦吐出过内容就不再重试（半句话 + 从头再来比报错更糟） */
    let emittedAny = false;

    for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
      const controller = new AbortController();
      const onOuterAbort = (): void => controller.abort();
      signal.addEventListener('abort', onOuterAbort, { once: true });

      let producedThisAttempt = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, firstByteTimeoutMs);

        const response = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new HttpError(response.status, redact(detail.slice(0, 500), config.apiKey));
        }
        if (response.body === null) {
          throw new Error('响应没有 body');
        }

        const parser = new SseFrameParser();
        const state = createFrameState();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;

            const chunk = decoder.decode(value, { stream: true });
            if (chunk.length === 0) continue;

            for (const data of parser.push(chunk)) {
              for (const event of parseOpenAiDataFrame(data, state)) {
                if (!producedThisAttempt) {
                  producedThisAttempt = true;
                  emittedAny = true;
                  if (timer !== undefined) {
                    clearTimeout(timer);
                    timer = undefined;
                  }
                }
                yield event;
                if (event.type === 'finish') return;
              }
            }
          }

          // 流结束了，把可能残留的半帧也处理掉
          for (const data of parser.flush()) {
            for (const event of parseOpenAiDataFrame(data, state)) {
              producedThisAttempt = true;
              emittedAny = true;
              yield event;
              if (event.type === 'finish') return;
            }
          }
        } finally {
          reader.releaseLock();
        }

        // ★ 到这儿说明流正常结束但**没给 finish** ⇒ 按截断处理，且不重试
        yield { type: 'error', message: '流在 finish 之前结束（疑似截断），不自动重试', retryable: false, kind: 'stream' };
        yield { type: 'finish', reason: 'error' };
        return;
      } catch (error) {
        if (signal.aborted) {
          yield { type: 'finish', reason: 'abort' };
          return;
        }

        const classified: ErrorClass = timedOut
          ? { message: `首字节等待超时（${firstByteTimeoutMs}ms 内没有收到任何事件）`, retryable: true, kind: 'timeout' }
          : classifyError(error, config.apiKey);

        const canRetry = !producedThisAttempt && !emittedAny && classified.retryable && attempt < requestAttempts;
        if (canRetry) {
          await sleep(backoffDelay(attempt, backoffBaseMs, random));
          continue;
        }

        yield {
          type: 'error',
          message: classified.message,
          retryable: classified.retryable,
          kind: classified.kind,
          ...(classified.status === undefined ? {} : { status: classified.status }),
        };
        return;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onOuterAbort);
      }
    }
  }

  return { id: config.id, stream };
}

export { TimeoutError };
