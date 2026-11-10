/**
 * **工具检索** —— 目录从「精确点名」升级为「自然语言检索」。
 *
 * ## ★★★ 为什么需要它（有据可依）
 *
 * 目录是**全量罗列**：把所有按需工具的「名字 + 一句话」列在 `describe_tool` 的描述里。
 * 十几个工具没问题，但：
 * - Anthropic 官方明确：**工具数超过 30–50 个，模型选对的准确率开始下降**；
 * - 一旦 MCP 接进来，工具数轻易破百 ⇒ 目录会从"有用"变成"噪音"。
 *
 * ⇒ 工具上百之后，目录不能再靠罗列，必须**按当前问题检索**。
 *
 * ## ★★★ 为什么是 BM25，不是向量模型（这是最有价值的一个判断）
 *
 * 依据是 **ToolRet**（ACL 2025，7,615 条检索任务 / 43,215 个工具，且**不预先标注**相关工具）：
 *
 * | 模型 | nDCG@10（带检索指令） |
 * |---|---|
 * | NV-Embed-v1（7B，最强） | 42.71 |
 * | **BM25s（纯词法）** | **36.46** |
 * | bge-base-en-v1.5 | 34.77 |
 * | e5-small-v2 | 31.14 |
 * | ColBERT | 23.79 |
 * | all-MiniLM-L6-v2（~22M） | 25.53 |
 *
 * 三个反直觉的结论：
 * 1. **BM25 不输甚至优于 ColBERT**（36.46 vs 23.79）；
 * 2. **能被端侧塞进去的小 embedding 模型反而不如 BM25**（25–31 vs 36）；
 * 3. 论文解释：工具查询与工具文档的 ROUGE-L 重叠只有 **0.06**（普通问答是 0.31），
 *    这个任务既不是"语义相似"也不是"字面匹配"，传统 IR 词法方法恰好是性价比最高的。
 *
 * ⇒ **用 BM25 起步就够了，不必先上向量**。这也意味着它可以是**零依赖、可完整单测**的。
 *
 * ## 参数取值
 * `k1 = 1.2` / `b = 0.75` 是 BM25 的经典默认值（论文与 Lucene 的常用取值），
 * 不是为本项目调出来的 —— 我**没有**实测过最优值，所以不写"已调优"。
 */

/** BM25 词频饱和参数（经典默认值）。 */
const K1 = 1.2;

/** BM25 文档长度归一化参数（经典默认值）。 */
const B = 0.75;

/** 参与检索的一条工具文档。 */
export type ToolDoc = {
  readonly name: string;
  readonly oneLiner: string;
  readonly description?: string;
};

export type Scored = { readonly name: string; readonly score: number };

/**
 * 检索。
 *
 * @param docs 候选工具（调用方已过滤掉 disabled）
 * @param query 自然语言或关键词
 * @param limit 最多返回几条
 * @param minScore 低于它的不返回（查不到就返回空，好过返回一堆不相干的）
 * @returns 命中的名字，**按相关度降序**；无命中返回空数组
 */
export function searchTools(
  docs: readonly ToolDoc[],
  query: string,
  limit = 5,
  minScore = 0,
): Scored[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || docs.length === 0) return [];
  const querySet = new Set(queryTerms);

  // 工具名权重更高：模型常常直接用近似名字的说法，而工具名本身是最强信号。
  // 做法是把名字**重复三次**放进文档 —— 比给每个字段单独设权重简单，效果一样。
  const tokenizedDocs = docs.map((doc) => {
    const text = `${doc.name} ${doc.name} ${doc.name} ${doc.oneLiner} ${doc.description ?? ''}`;
    return tokenize(text);
  });

  const totalLength = tokenizedDocs.reduce((sum, terms) => sum + terms.length, 0);
  const avgLength = tokenizedDocs.length === 0 ? 0 : totalLength / tokenizedDocs.length;
  const n = docs.length;

  // 文档频率：只统计 query 里出现过的词
  const docFreq = new Map<string, number>();
  for (const terms of tokenizedDocs) {
    const seen = new Set<string>();
    for (const term of terms) {
      if (querySet.has(term) && !seen.has(term)) {
        seen.add(term);
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
  }

  const scored: Scored[] = [];
  for (let index = 0; index < docs.length; index += 1) {
    const terms = tokenizedDocs[index] ?? [];
    if (terms.length === 0) continue;

    const termFreq = new Map<string, number>();
    for (const term of terms) {
      if (!querySet.has(term)) continue;
      termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
    }
    if (termFreq.size === 0) continue;

    let score = 0;
    for (const [term, freq] of termFreq) {
      const df = docFreq.get(term) ?? 0;
      if (df === 0) continue;
      // IDF 加 1 防负值：出现次数超过一半的词在经典公式里会变成负数，
      // 那会让"含有该词"反而扣分 —— 对工具检索是很糟的行为。
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const norm = 1 - B + (B * terms.length) / (avgLength === 0 ? 1 : avgLength);
      score += (idf * (freq * (K1 + 1))) / (freq + K1 * norm);
    }

    const doc = docs[index];
    if (doc !== undefined && score > minScore) scored.push({ name: doc.name, score });
  }

  return scored
    // ★ 同分时按名字排 —— 结果必须**确定**：不确定的排序会让同一问题两次检索给出不同工具，
    //   模型的行为就随机了。
    .sort((a, b) => (b.score === a.score ? a.name.localeCompare(b.name) : b.score - a.score))
    .slice(0, limit);
}

/**
 * 停用词。
 *
 * ★★★ 为什么必须有这个（这是实测出来的坑，不是理论上应该加）
 *
 * 第一版没有停用词表，结果查询 `"download a web page"` 会命中一个"记住这件事"的工具 ——
 * 因为它的描述里有 "…for **a** durable fact…"，那个 `a` 贡献了一点点分数，
 * 而只要分数 > 0 就被返回。
 *
 * 后果很实际：模型问"怎么下载网页"，却拿回来一个「记住这件事」的定义 ——
 * **比什么都没搜到更糟**，因为它会以为自己找对了。
 *
 * ⇒ 规则：英文**单字符与常见虚词**一律丢弃；中文单字**保留**（中文单字有实义）。
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'are',
  'be', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they',
  'do', 'does', 'did', 'can', 'should', 'would', 'will', 'with', 'by', 'as', 'from',
  'if', 'then', 'than', 'so', 'not', 'no', 'but', 'my', 'me', 'your', 'our',
  // 客套话也是纯噪声
  'please', 'pls', 'kindly', 'just', 'some', 'any',
]);

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 中日韩统一表意文字
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0xac00 && code <= 0xd7af) // 韩文音节
  );
}

/**
 * 分词。
 *
 * ★ 刻意**保持简单**：小写 + 按非字母数字切分。
 *
 * 两个刻意的取舍：
 * 1. **不做英文词干化**（stemming）—— 工具检索恰恰需要区分 `read_file` 与 `read_dir`；
 *    词干化会引入"read / reading / reads 全等价"这种噪声。
 * 2. **中文按单字切**（不引入词典/分词器）—— 不该为了工具检索背一个中文分词器。
 *    单字召回率够用，精确度由 BM25 的 IDF 兜底。★ 这是权衡，不是最优解。
 *
 * ★ 下划线/连字符**当分隔符**：`read_file` → `read` + `file`。
 *   这看着像"丢失信息"，实际是**增益** —— 用户说 "read a file" 时能命中 `read_file`。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let current = '';

  for (const ch of text) {
    const isAlnum = /[\p{L}\p{N}]/u.test(ch);
    if (isAlnum) {
      // 中日韩字符**单独成词**（每个字一个 token），否则一整句中文会变成一个巨大的 token
      if (isCjk(ch)) {
        if (current.length > 0) {
          out.push(current);
          current = '';
        }
        out.push(ch.toLowerCase());
      } else {
        current += ch.toLowerCase();
      }
    } else if (current.length > 0) {
      out.push(current);
      current = '';
    }
  }
  if (current.length > 0) out.push(current);

  // 单字符：英文的 "a" / "I" 是噪声，中文的 "搜" / "读" 是实义 ⇒ 只丢前者。
  return out.filter((term) => (term.length > 1 ? !STOPWORDS.has(term) : isCjk(term)));
}
