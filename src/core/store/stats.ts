import type { DatabaseSync } from 'node:sqlite';

/**
 * 会话统计 —— 底部状态栏那三样东西的唯一数据源。
 *
 * ★ 口径（写在函数里，免得以后各算各的）：
 * - **轮**：用户消息条数（一条 user = 一轮）。
 * - **步**：助手消息条数（主循环每调一次模型 = 一步，见 `agent/loop.ts` 的 `step`）。
 * - **tok/s**：总输出 tokens ÷ 生成总耗时。耗时用「每条助手消息的 created_at 减去它前一条消息的
 *   created_at」累加 —— 这是**能从库里还原**的近似值，不含网络往返以外的等待，
 *   比"拿整个会话墙钟时间去除"诚实得多（后者会被用户思考时间稀释）。
 * - **输入三桶**：`未缓存输入` + `缓存读取`(cached) + `缓存写入`(cachedWrite)。三者是**并列**的桶，
 *   加起来 = 该步的输入总量 = 上游账单口径的 `prompt_tokens`。
 * - **累计 tok**：输入总量 + 输出。★ 输入总量按三桶之和算 —— **不只算未缓存的 input**，
 *   否则改口径会把历史总量改小（见下面的归一化说明）。
 * - **缓存命中**：cached ÷ 输入总量（= 三桶之和，含缓存写入）。厂商没回 cached 时按 0 计，不编。
 * - **上下文水位**：未压缩上下文 tokens ÷ 该 provider 声明的窗口。
 *
 * ★ 为什么都在**服务端**算：这些是跨消息的聚合，前端要算就得把所有消息拉下来再遍历，
 *   而且口径会分叉（前端一份、看板一份）。
 */

export type ConversationStats = {
  /** 用户消息条数 */
  readonly turns: number;
  /** 助手步骤数（每次模型调用） */
  readonly steps: number;
  /**
   * 累计**输入总量**（未缓存输入 + 缓存读取 + 缓存写入，三桶之和）。
   * ★ 名字沿用旧字段以免动前端；语义是「输入总量」，**不是**未命中缓存的那部分。
   */
  readonly totalInput: number;
  /** 累计**未命中缓存**的输入 tokens（三桶里的第一桶；`totalInput` 是三者之和） */
  readonly totalUncachedInput: number;
  /** 累计输出 tokens（`reasoning` 已含在内，不另加） */
  readonly totalOutput: number;
  /** 累计缓存**读取** tokens */
  readonly totalCached: number;
  /** 累计缓存**写入** tokens；**没有任何一步报过就是 null**（不拿 0 冒充） */
  readonly totalCachedWrite: number | null;
  /** 平均输出速度（tokens/秒）；没有可测耗时则为 null */
  readonly tokensPerSecond: number | null;
  /** 累计 tokens（输入总量 + 输出） */
  readonly totalTokens: number;
  /** 缓存命中率 0–1 = cached ÷ 输入总量；输入总量为 0 时为 null */
  readonly cacheHitRate: number | null;
};

type UsageRow = { usage: string | null; created_at: string; role: string };

/** 一步归一化之后的用量：桶是桶、总量是总量，调用方不用再猜口径。 */
type NormalizedUsage = {
  /** 该步的输入总量（= 三桶之和，上游 `prompt_tokens` 口径） */
  inputTotal: number;
  /** 未命中缓存的输入（`Usage.input` 的新语义） */
  uncachedInput: number;
  output: number;
  cached: number;
  /** 缓存写入；该步没报过就是 undefined（不是 0） */
  cachedWrite: number | undefined;
};

/**
 * 从库里那一行 usage JSON 还原用量，并**把新旧两种口径归一成同一种**。
 *
 * ★★ 为什么需要归一（这是本文件最要紧的一段，别删）：
 *
 *   库里历史 usage JSON 是**旧口径** —— `input` **含**缓存命中（当年直接抄的上游
 *   `prompt_tokens`）。而 `openai-parse.ts` 现在写的是**新口径** —— `input` 已扣掉缓存。
 *   两行 JSON 的形状一模一样，光看数字**区分不开**：
 *
 *     {"input":200,"output":200,"cached":800}  ← 新：200 未缓存 + 800 命中，总量 1000
 *     {"input":800,"output":200,"cached":800}  ← 旧：总量 800 里命中 800，未缓存 0
 *
 *   所以新数据在 JSON 里带一个判别标记 `inputExcludesCached: true`（见 `shared/types.ts`
 *   的 `Usage`）。有标记 ⇒ 按新口径读（`inputTotal = input + cached + cachedWrite`）；
 *   没标记 ⇒ 是历史数据，按旧口径读（`input` 本身就是总量，`inputTotal = input + cachedWrite`，
 *   **绝不再加 cached**，否则缓存在旧数据里被算两遍）。
 *
 * ★ 历史 JSON 一个字都没改（原文逐字不变的承诺），兼容只发生在这一层读取侧。
 * ★ 没有缓存数字的行不带标记 —— 那也无所谓：`input + 0 === input`，两种解释数值相同。
 */
function parseUsage(raw: string | null): NormalizedUsage | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as {
      input?: unknown;
      output?: unknown;
      cached?: unknown;
      cachedWrite?: unknown;
      inputExcludesCached?: unknown;
    };
    const input = typeof parsed.input === 'number' ? parsed.input : 0;
    const output = typeof parsed.output === 'number' ? parsed.output : 0;
    const cached = typeof parsed.cached === 'number' ? parsed.cached : 0;
    const cachedWrite = typeof parsed.cachedWrite === 'number' ? parsed.cachedWrite : undefined;
    const write = cachedWrite ?? 0;

    /**
     * ★ 判别标记只认 `=== true`：历史数据里没有这个键（undefined），
     *   万一以后有别的写法规避，也一律按旧口径（更保守：不会把缓存重复计入总量）。
     */
    const excludesCached = parsed.inputExcludesCached === true;

    const inputTotal = excludesCached ? input + cached + write : input + write;
    const uncachedInput = Math.max(inputTotal - cached - write, 0);

    return { inputTotal, uncachedInput, output, cached, cachedWrite };
  } catch {
    return null;
  }
}

export function conversationStats(db: DatabaseSync, conversationId: string): ConversationStats {
  const rows = db
    .prepare('SELECT role, usage, created_at FROM messages WHERE conversation_id = ? ORDER BY seq ASC')
    .all(conversationId) as UsageRow[];

  let turns = 0;
  let steps = 0;
  let totalInput = 0;
  /** 输入三桶的第一桶：未命中缓存那部分（单独累加，免得前端靠减法反推） */
  let totalUncachedInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  /** 缓存写入：只有真的有那么一步报过才不为 null（0 与「没报」必须能分开） */
  let totalCachedWrite: number | null = null;
  let elapsedMs = 0;
  /** 只累计「耗时可用」那几步的输出 —— 分母没算它的时间，分子也不该算它的 token */
  let measuredOutput = 0;

  let previousAt: number | null = null;
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    if (row.role === 'user') turns += 1;

    if (row.role === 'assistant') {
      steps += 1;
      const usage = parseUsage(row.usage);
      if (usage !== null) {
        // ★ 这里加的是**输入总量**（三桶之和），不是未缓存的 input —— 改口径不能把总量改小
        totalInput += usage.inputTotal;
        totalUncachedInput += usage.uncachedInput;
        totalOutput += usage.output;
        totalCached += usage.cached;
        if (usage.cachedWrite !== undefined) totalCachedWrite = (totalCachedWrite ?? 0) + usage.cachedWrite;

        // 生成耗时：本条助手消息 - 它前一条消息（用户消息或上一步的产出）
        // ★ 与明细同一条尺子：间隔太短不算（那是同一批写入，不是真实生成耗时）
        const gapMs = previousAt !== null && Number.isFinite(at) && at > previousAt ? at - previousAt : null;
        if (gapMs !== null && gapMs >= MIN_MEASURABLE_MS) {
          elapsedMs += gapMs;
          measuredOutput += usage.output;
        }
      }
    }

    previousAt = Number.isFinite(at) ? at : previousAt;
  }

  const tokensPerSecond =
    elapsedMs > 0 && measuredOutput > 0 ? Math.round((measuredOutput / (elapsedMs / 1000)) * 10) / 10 : null;

  return {
    turns,
    steps,
    totalInput,
    totalUncachedInput,
    totalOutput,
    totalCached,
    totalCachedWrite,
    tokensPerSecond,
    /**
     * ★ 输入总量（三桶之和）+ 输出。**`reasoning` 不加**——它本来就是 output 的子集。
     * ★ 这个数在改口径前后必须逐位相同：旧式是「含缓存的 input + output」，
     *   新式是「未缓存 input + cached + cachedWrite + output」，两者恒等（见 `parseUsage`）。
     */
    totalTokens: totalInput + totalOutput,
    /**
     * 命中率分母 = **输入总量**（`totalInput` = 未缓存输入 + 缓存读取 + 缓存写入），
     * 不是「未缓存的 input」也不是「含缓存的 prompt_tokens 减掉什么」。
     * 用输入总量做分母，命中率才等于「输入里有多大比例走了缓存」。
     */
    cacheHitRate: totalInput > 0 ? totalCached / totalInput : null,
  };
}

/**
 * 每一步的用量明细 —— 底部那三样「点开看详情」用的。
 *
 * ★ 为什么要单独一个函数而不是塞进 `ConversationStats`：
 *   状态栏每回合都要读聚合值（便宜），明细只在**用户点开面板时**才需要（可能几百行）。
 *   把明细常驻在 dashboard 里等于每次都白传一遍。
 */
/** 低于这个耗时的样本不算速度 —— 毫秒级间隔会算出几万 tok/s 这种明显不是真的数 */
const MIN_MEASURABLE_MS = 200;

export type StepUsage = {
  readonly seq: number;
  readonly at: string;
  readonly finishReason: string | null;
  /**
   * 这一步的**输入总量**（未缓存输入 + 缓存读取 + 缓存写入，三桶之和，上游 `prompt_tokens` 口径）。
   * ★ 沿用旧字段名以免动前端表格；**不是**未命中缓存的那部分（那部分是 `uncachedInput`）。
   */
  readonly input: number;
  /** 这一步**未命中缓存**的输入量（新口径 `Usage.input` 的语义） */
  readonly uncachedInput: number;
  readonly output: number;
  /** 缓存**读取**量 */
  readonly cached: number;
  /** 缓存**写入**量；这一步没报过就没有这个字段（不拿 0 冒充） */
  readonly cachedWrite?: number;
  /** 这一步的生成耗时（毫秒）；没法测则为 null */
  readonly durationMs: number | null;
  /** 这一步的输出速度；**耗时过短或没有输出时为 null**（宁可空着，不给假数） */
  readonly tokensPerSecond: number | null;
};

export type UsageDetail = {
  readonly stats: ConversationStats;
  /** 按 seq 升序；只回最近 `limit` 步，避免长会话把响应撑大 */
  readonly steps: readonly StepUsage[];
  /** 总步数（可能大于 `steps.length`） */
  readonly stepCount: number;
  /** 生成总耗时（毫秒），与聚合里的 tokensPerSecond 同源 */
  readonly elapsedMs: number;
};

type DetailRow = { seq: number; role: string; usage: string | null; created_at: string; finish_reason: string | null };

export function conversationUsageDetail(db: DatabaseSync, conversationId: string, limit = 200): UsageDetail {
  const rows = db
    .prepare(
      'SELECT seq, role, usage, created_at, finish_reason FROM messages WHERE conversation_id = ? ORDER BY seq ASC',
    )
    .all(conversationId) as DetailRow[];

  const allSteps: StepUsage[] = [];
  let elapsedMs = 0;
  let previousAt: number | null = null;

  for (const row of rows) {
    const at = Date.parse(row.created_at);
    const valid = Number.isFinite(at);

    if (row.role === 'assistant') {
      const usage = parseUsage(row.usage);
      // 耗时与聚合口径一致：本条 - 上一条
      const gapMs = previousAt !== null && valid && at > previousAt ? at - previousAt : null;
      if (usage !== null && gapMs !== null) elapsedMs += gapMs;

      if (usage !== null) {
        /**
         * ★ 两步之间只隔几十毫秒时，那不是「生成很快」，而是**两条消息是同一批写入的**
         *   （例如假模型一次吐完、或历史数据是批量插入的）。
         *   拿它算速度会得到「32000 tok/s」这种一眼假的数 —— 宁可显示「—」。
         */
        const measurable = gapMs !== null && gapMs >= MIN_MEASURABLE_MS;
        allSteps.push({
          seq: row.seq,
          at: row.created_at,
          finishReason: row.finish_reason,
          // ★ input 是**输入总量**（三桶之和），uncachedInput 才是未命中缓存那部分
          input: usage.inputTotal,
          uncachedInput: usage.uncachedInput,
          output: usage.output,
          cached: usage.cached,
          // 可选字段：没报过就真的不写（exactOptionalPropertyTypes 关着，这里用展开更明确）
          ...(usage.cachedWrite === undefined ? {} : { cachedWrite: usage.cachedWrite }),
          durationMs: gapMs,
          tokensPerSecond:
            measurable && usage.output > 0 ? Math.round((usage.output / (gapMs / 1000)) * 10) / 10 : null,
        });
      }
    }

    previousAt = valid ? at : previousAt;
  }

  return {
    stats: conversationStats(db, conversationId),
    steps: allSteps.slice(-limit),
    stepCount: allSteps.length,
    elapsedMs,
  };
}
