/**
 * **工具名的线上契约**（唯一真源）。
 *
 * ## ★ 为什么要有这个文件
 *
 * 2026-11-08 真事故：插件工具名曾拼成 `p.<插件id>.<工具名>`，而 OpenAI 兼容网关要求
 * 工具名匹配 `^[a-zA-Z0-9_-]+$`。装了任何插件之后，工具表里就带点号 ⇒
 * **每一轮请求都被判 400，整个应用从此不能用**（`Invalid 'tools[N].name': string does not
 * match pattern`），而错误文案经常被网关翻译成毫不相干的 `missing role field`，
 * 排查方向被带偏很久。
 *
 * 那次修的是**字符集**。**长度**这个口子当时还在：上游同样有 64 字符上限，
 * 而插件工具名是 `p_<插件id>_<工具名>` —— id 40 + 工具名 40 就能拼到 83 字符。
 *
 * ## ★★ 三条判据（缺一条就会复发）
 *
 * 1. **字符集**：不符合的字符一律换成 `_`（不拒绝，因为 id 是用户给的）。
 * 2. **长度**：超过 {@link WIRE_TOOL_NAME_MAX} 必须截断。
 * 3. **截断不得造成撞名** —— 这是最容易漏的一条：`a` 和 `b` 两个工具若前 51 字符相同，
 *    单纯截断会让它们变成**同一个名字**，工具表里**静默少一个**（而且不报错，
 *    只有模型"怎么调都调不到那个工具"时才会被发现）。
 *    ⇒ 截断时追加一段**由原始标识算出的稳定哈希**，不同来源必然得到不同后缀。
 *
 * ★ 为什么把这三条放在 shared：插件侧（`core/plugin/host.ts`）与 MCP 侧
 * （`shared/mcp.ts`）各写一份的话，下一次只修一边就会重演同一类事故。
 * 真正兜底的是 `ToolRegistry.register()` 的断言 —— 那是**唯一**入口。
 *
 * ★★ 为什么这里不用 `node:crypto`（看似更"正"的选择）：
 *   这个文件会被**前端 tsconfig 一起编**（`web/src` 通过 `shared/mcp.ts` 间接引到它），
 *   而 `tsconfig.web.json` 的 `types: []` 里没有 node 类型 ⇒ `node:crypto` 直接编不过。
 *   更要紧的是**判据**：工具名必须在服务端与能算名字的任何一侧得到**逐字相同**的结果
 *   （名字一变，prompt cache 整段失效）。⇒ 只用纯 JS 的确定性哈希，两端必然一致。
 */

/** 上游（OpenAI 兼容网关）接受的最长工具名 */
export const WIRE_TOOL_NAME_MAX = 64;

/** 上游（OpenAI 兼容网关）接受的工具名字符集与长度 */
export const WIRE_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 截断后追加的哈希长度（12 个 hex = 48 bit，撞名概率对工具表量级而言可忽略） */
const HASH_LEN = 12;

/** 保留给 `_<hash>` 的空间 */
const KEEP = WIRE_TOOL_NAME_MAX - HASH_LEN - 1;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64 位（纯 JS / BigInt，两端一致） */
function fnv1a64(text: string, offset: bigint): bigint {
  let hash = offset;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/**
 * 把任意身份串压成 12 个 hex 字符。
 *
 * 两趟不同初值的 FNV-1a + 末尾一次雪崩混合 ⇒ 得到 48 bit。
 * ★ 这不是密码学哈希，也不需要是：这里防的是「**无意**撞名」（两个工具前 51 字符恰好相同），
 *   不是防恶意构造。真要防构造，得先有人能控制工具名 —— 那已经是"装插件 = 信任作者"的前提。
 */
function hashSuffix(identity: string): string {
  const a = fnv1a64(identity, FNV_OFFSET);
  const b = fnv1a64(identity, FNV_OFFSET ^ 0x9e3779b97f4a7c15n);
  // 雪崩：让相邻字符串（只差一个字符）的后缀完全不同，避免"看起来像序号"
  let mixed = (a ^ (b << 1n) ^ (a >> 17n)) & MASK64;
  mixed = (mixed * FNV_PRIME) & MASK64;
  mixed ^= mixed >> 29n;
  return mixed.toString(16).padStart(16, '0').slice(0, HASH_LEN);
}

/** 把任意字符串压成上游接受的**字符集**（只留字母数字下划线连字符） */
export function sanitizeToolChars(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 生成一个**必定**满足线上契约的工具名。
 *
 * @param raw 清洗后要用的名字（例如 `p_<id>_<tool>`）
 * @param identity 用来算碰撞哈希的**原始标识**。默认用 `raw`；
 *   插件侧应传 `插件id + '\0' + 工具名` —— 这样即便两个插件的 id 前 51 字符相同，
 *   也不会因为截断而撞成同一个名字。
 *
 * ★ 为什么 identity 要能单独给：`raw` 已经被 `_` 替换过，两个不同的原始名
 *   可能清洗成同一个 `raw`（例如 `a.b` 与 `a/b`）；拿清洗后的串去算哈希，
 *   这两者仍会撞。拿原始标识算才对得上"不同来源不同后缀"。
 */
export function fitToolName(raw: string, identity: string = raw): string {
  const cleaned = sanitizeToolChars(raw);
  if (cleaned.length === 0) return 'unnamed';
  if (cleaned.length <= WIRE_TOOL_NAME_MAX) return cleaned;
  return `${cleaned.slice(0, KEEP)}_${hashSuffix(identity)}`;
}

/** 名字是否满足线上契约 */
export function isWireToolName(name: string): boolean {
  return WIRE_TOOL_NAME_RE.test(name);
}

/**
 * 断言一个工具名可以直接发给上游。
 *
 * ★ 抛错而不是"就地改好"：走到这里说明**某个生产者**漏了清洗。
 *   悄悄改好会掩盖 bug（而且改了之后模型调用的还是旧名字，查不下去）。
 */
export function assertWireToolName(name: string): void {
  if (isWireToolName(name)) return;
  const reason =
    name.length === 0
      ? '名字为空'
      : name.length > WIRE_TOOL_NAME_MAX
        ? `超长（${name.length} > ${WIRE_TOOL_NAME_MAX}）`
        : '含有非法字符';
  throw new Error(
    `工具名不合法：${JSON.stringify(name)} —— ${reason}。` +
      `上游要求匹配 ${WIRE_TOOL_NAME_RE.source}；带点号或超长的名字会让**每一轮请求**都被判 400（2026-11-08 真事故）。` +
      '生产工具名的地方请统一走 fitToolName()。',
  );
}
