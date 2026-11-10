/**
 * 工具调用的**规范签名**（A2 / `D1@L639`）。
 *
 * ## ★ 这个文件治的是什么
 *
 * 空转守卫（`loop.ts` 的 `DOOM_LOOP_REPEATS`）靠"这一批调用的签名是否和上一次相同"来判断
 * 模型在原地打转。原来的签名是：
 *
 * ```ts
 * JSON.stringify(calls.map(call => [call.name, call.arguments]))
 * ```
 *
 * **`call.arguments` 是模型生成的 JSON 字符串**，而 `JSON.stringify` 保留**字段顺序**。
 * 于是模型只要把同样的参数换个书写顺序：
 *
 * ```json
 * {"path":"a.txt","content":"x"}   →   {"content":"x","path":"a.txt"}
 * ```
 *
 * 就得到**两个不同的签名** ⇒ 守卫永远数不到 3 ⇒ **空转永不触发**。
 * 这不是理论问题：`D1@L617`（G4）记的就是这条设计差异，我写 `maxSteps: null`
 * 的行为测试时也真踩到了（假模型每次换参数顺序，进程无限循环只能 kill）。
 *
 * ⇒ 签名必须**规范化**：把参数 JSON 深度排序后再序列化。
 *
 * ## ★★ 三条判据
 *
 * 1. **解析失败就退回原文**（不抛）。参数是模型生成的，坏 JSON 是常态；
 *    签名函数不能因为坏 JSON 就炸掉整轮 —— 那比空转更糟。坏 JSON 原样参与比较，
 *    反正两次一模一样的坏 JSON 也确实算重复。
 * 2. **数组保持顺序**。`[1,2]` 与 `[2,1]` 是**不同**的参数（多数 API 语义如此），
 *    排序它们会误判"不同调用 = 重复"⇒ 反而更容易误杀。
 * 3. **只排序对象键**，且是**递归**的（嵌套对象也一样）。
 */

/** 把任意 JSON 值转成"键有序"的规范形态（数组顺序不动） */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // ★ 用 code unit 排序（`<`），不用 localeCompare —— 后者的结果依赖运行环境的 locale，
    //   同一份参数在不同机器上可能得到不同签名，那会让守卫在别人的机器上失效。
    for (const key of Object.keys(source).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * 一批工具调用的规范签名：**同一次调用的不同书写顺序必须得到同一个字符串**。
 *
 * @param calls 按模型给出的原顺序（这一层不动 —— 调用次序本身是有意义的）
 */
export function canonicalCallSignature(
  calls: readonly { readonly name: string; readonly arguments: string }[],
): string {
  return JSON.stringify(
    calls.map((call) => [call.name, canonicalArguments(call.arguments)]),
  );
}

/**
 * 规范化单个调用的参数串。
 *
 * 解析失败 ⇒ 返回原文（见文件头判据 1）。注意返回的是**字符串**，外面会再 JSON 一次 ——
 * 这样"有效 JSON"与"坏 JSON"两种形态在签名里不会互相混淆。
 */
export function canonicalArguments(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '{}';
  try {
    return JSON.stringify(canonicalize(JSON.parse(trimmed) as unknown));
  } catch {
    return `!!unparsed::${trimmed}`;
  }
}
