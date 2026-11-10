import type { ChatEvent, ChatRequest } from '../../shared/types.ts';

/**
 * 厂商协议族。V0.1 只实现 OpenAI 兼容；另两个只留枚举位，
 * `ProviderFactory` 遇到未实现的会**明确报错**，不静默降级
 * （否则 UI 以为在用 Anthropic，实际走了 OpenAI 协议 —— ChatMobile 的裁决）。
 */
export type ProviderKind = 'openai_compatible' | 'anthropic' | 'gemini';

/**
 * 「思考」参数在请求体里的形态 —— 开关与强度是**两件事**：
 * `thinking.type` / `enable_thinking` 管开不开，`reasoning_effort` 管开多大。
 * 只传强度不传开关，在部分模型上是**静默无效**。
 *
 * ★ 这里只决定**字段怎么摆**，不决定**能填什么值**（值域不写死）。
 */
export type ThinkingShape =
  | 'effort_only'
  | 'effort_plus_thinking_switch'
  | 'enable_thinking'
  | 'reasoning_object'
  | 'none';

export type ProviderConfig = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly chatPath: string;
  readonly modelsPath: string;
  readonly defaultModel?: string | null;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly thinkingShape?: ThinkingShape;
  /** 个别网关不支持 `stream_options.include_usage`（会 400），可关 */
  readonly supportsStreamUsage?: boolean;
  /** OpenAI 新模型与 Groq 认 `max_completion_tokens`，老兼容网关只认 `max_tokens` */
  readonly usesMaxCompletionTokens?: boolean;
};

export type Provider = {
  readonly id: string;
  /** ★ 契约：**永不 throw**，所有失败都是 `error` 事件（设计稿 §6.1） */
  stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent>;
};

/**
 * 拼相对路径。**不要用 `new URL('models', 'https://x/v1')`** ——
 * 它会把 `v1` 当文件名吃掉，得到 `https://x/models`（经典坑）。
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const rel = path.trim().replace(/^\/+/, '');
  if (base.length === 0) return rel.length === 0 ? '/' : `/${rel}`;
  if (rel.length === 0) return base;
  return `${base}/${rel}`;
}

/** 把密钥从任意文本里抹掉。太短的串不替换（易误伤正常文本）。 */
export function redact(text: string, secret: string): string {
  if (secret.length < 6 || !text.includes(secret)) return text;
  return text.split(secret).join('***');
}
