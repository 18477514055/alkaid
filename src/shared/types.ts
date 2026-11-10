/**
 * 跨层共享的**纯类型**。这个文件不允许有副作用，也不允许 import core/。
 *
 * ★ 事件形状是 UI 与主循环共用的合同（设计稿 §6.1）—— 改它等于改协议。
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 一轮**为什么结束**。
 *
 * ★ 语义分工（`completed` 与 `stop` 是两件事，别合并）：
 * - `stop`      —— 上游模型自然停（`finish_reason: stop`，且这一轮没再要工具）。
 *                 它只说明"模型这一步不想再说话"，**不证明活干完了**。
 * - `completed` —— **工具主动宣告"干完了"**（`ToolOutcome.conclude`，A1 / `D1@L641`）。
 *                 这是比 `stop` 更强、也更该被信任的收敛信号：由干活的那一方宣告。
 *                 有了它，"没有步数上限"才有一个不依赖模型自愿闭嘴的出口。
 * - `length`    —— 单轮步数上限用尽（`maxSteps` 到达）。
 *                 注意：这是**唯一的"预算类"终态**，DSH 的 `TurnEndReasonMap` 里没有对应项
 *                 （`D1@L162-174`），所以它在本项目是本地约定，不要往上游映射。
 * - `error` / `abort` / `tool_calls`（后者只在中间步骤里出现）见各自调用点。
 */
export type FinishReason = 'stop' | 'completed' | 'length' | 'tool_calls' | 'error' | 'abort';

export type ToolCall = {
  readonly id: string;
  readonly name: string;
  /** 参数是**字符串**，因为流式到达时只能是字符串；用的时候再 JSON.parse */
  readonly arguments: string;
  /** Presentation only; stripped by provider serializers, retained in local history. */
  readonly displayChannel?: 'chat' | 'maintenance';
};

export type ToolDef = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema（object 根） */
  readonly parameters: Record<string, unknown>;
};

export type ChatMessage = {
  readonly role: ChatRole;
  readonly content: string | null;
  readonly reasoning?: string | null;
  readonly toolCalls?: readonly ToolCall[] | null;
  readonly toolCallId?: string | null;
};

export type ChatRequest = {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDef[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Internal transport cap; never sent to the provider wire body. Closure requests use 1. */
  readonly maxAttempts?: number;
  /** 厂商私有参数的逃生舱（`thinking`、`enable_search` 等），并入请求体顶层 */
  readonly extraBody?: Record<string, unknown>;
};

/**
 * 用量 —— ★ **三桶口径**：
 *
 *   输入侧三桶 = `input`（未命中缓存的输入）+ `cached`（缓存读取）+ `cachedWrite`（缓存写入）
 *   输出侧     = `output`（`reasoning` 是它的子集，**已含在里面**，绝不另加）
 *
 * ★ 为什么 `input` 要扣掉缓存：上游 OpenAI 的 `prompt_tokens` 是**含**缓存命中的，
 *   拿它当"输入"会让「输入 + 输出」与「命中 + 未命中」两套账混在一起，看板上
 *   既算不清钱也算不清命中率。扣掉之后，三桶之和 = 上游账单口径的输入总量，一比一对得上。
 *
 * ★ 向后兼容：库里 2026-11 之前写入的 usage JSON 是旧口径（`input` 含缓存）。
 *   判别靠 `inputExcludesCached` 标记（见下），**不迁移历史数据**。
 */
export type Usage = {
  /** 输入 tokens —— ★ **未命中缓存的输入量**（上游 `prompt_tokens` 减去缓存命中部分）。 */
  readonly input: number;
  /** 输出 tokens。★ `reasoning` 是它的**子集**，已包含在这里。 */
  readonly output: number;
  /**
   * prompt **缓存读取**量（OpenAI `cached_tokens` / DeepSeek `prompt_cache_hit_tokens`）。
   * ★ 它**不在** `input` 里 —— 输入侧是三个并列的桶，不是层层包含的关系。
   */
  readonly cached?: number;
  /**
   * prompt **缓存写入**量（Anthropic 语义：`cache_creation_input_tokens`）。
   * ★ 厂商没报就**不写这个字段**，绝不填 0 冒充 —— 「写了 0」和「没报」是两件事，
   *   前者进求和，后者只能让界面显示「—」。
   */
  readonly cachedWrite?: number;
  /** 推理 tokens。★ 是 `output` 的**子集**，不参与任何求和（加进来就是重复计费）。 */
  readonly reasoning?: number;
  /**
   * 口径判别标记：**有这个字段 = 新口径**（`input` 已扣缓存）。
   *
   * ★ 为什么必须有它：新旧两种 JSON 的单行形状完全一样，光看数字区分不了 ——
   *   `{"input":200,"output":200,"cached":800}` 既可能是「新增：200 未缓存 + 800 命中」，
   *   也可能是「历史：1000 含缓存里命中 800」。没有标记就必须二选一猜，猜错一边就差一整桶。
   *   所以历史数据（没有这个字段）在读取侧（`core/store/stats.ts`）按旧口径解释，
   *   新数据按新口径解释 —— 历史 JSON 一个字都不用改，混排总量也不会重复计算。
   */
  readonly inputExcludesCached?: true;
};

export type ChatEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'reasoning'; readonly delta: string }
  /** 工具调用增量：**按 index 聚合**，`id`/`name` 可能只在首帧出现 */
  | {
      readonly type: 'tool_call';
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argsDelta?: string;
    }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'finish'; readonly reason: FinishReason }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly retryable: boolean;
      /** 上游 HTTP 状态（非 HTTP 错误时没有）。用于诊断，不含响应正文 */
      readonly status?: number;
      /** 粗分类，便于界面与审计给出可行动提示 */
      readonly kind?: 'http' | 'timeout' | 'network' | 'stream' | 'abort' | 'parse' | 'other';
    };
