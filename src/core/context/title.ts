import type { DatabaseSync } from 'node:sqlite';

import type { Provider } from '../model/provider.ts';
import { getConversation, listMessages, updateConversation } from '../store/repo.ts';

/**
 * 让模型给会话起一个短标题。
 *
 * ★ 为什么要单独一个模块，而不是塞进 loop：
 *   起标题是**旁路**调用（一次小请求），失败**绝不能让本轮对话失败**。
 *   塞进主循环就等于给主链路加了一个可失败的分支，收益远小于风险。
 *
 * ★ 什么时候起：
 *   - 只在该会话「还没有用户起的名字」时自动起（`title` 为 null 或等于占位名）。
 *   - 只用**第一轮**的用户消息 + 助手回复作为素材（后面的话题会漂移，标题就不准了）。
 *   - 已有标题就一条都不再起 —— 用户改过的名字不能被模型覆盖。
 *
 * ★ 失败怎么办：什么都不做，标题保持原样。**不重试、不抛错、不写半截**。
 *
 * ★★ 长度控制是**两层**，这是照 DSH 的做法学的（`@deepseek-ai/dsh-session-title`）：
 *   ① 提示词里给**目标**（Aim for …），措辞是"尽量"，不假装是硬约束；
 *   ② 拿到输出后按**UTF-8 字节预算**硬截（`truncateTitleUtf8`），并在截断前
 *      洗掉控制字符 / 方向字符 / ANSI 序列（`cleanTitleText`）。
 *   只靠 ① 不行：模型经常不听（真见过要求 15 字、回来 30 字寒暄）。
 *   只靠 ② 不行：硬截会把句子截成半截话，先洗再截、优先在句读处断效果最好。
 */

/**
 * 目标长度（写进提示词，是"尽量"）。
 * ★ 取 12：侧栏一行大约放得下 14–16 个汉字，留出省略号余量。
 */
const TARGET_CJK_CHARS = 12;
/** 非中文语言的目标词数 */
const TARGET_WORDS = 6;

const TITLE_SYSTEM_PROMPT = [
  'Create a concise title for an AI assistant session from the supplied human messages.',
  'Return only the title on one line, in plain text, with no quotes, prefix, explanation, Markdown, or terminal control codes.',
  'Use the language of the messages.',
  `Aim for about ${TARGET_CJK_CHARS} CJK characters (or ${TARGET_WORDS} words in non-CJK languages). Aim, not a hard limit, but prefer shorter.`,
  'If the messages give little to name, still return a short best-effort title instead of explaining.',
  'Do not start with "用户", "助手", "对话", "User", "Assistant", or "Conversation".',
].join('\n');

/**
 * 硬预算（UTF-8 字节）。
 * ★ 为什么按**字节**而不是按"字符数"：一个汉字 3 字节、一个 emoji 4 字节、
 *   一个 ASCII 字母 1 字节。按字符数限 24 时，24 个 emoji 会撑到 96 字节，
 *   侧栏照样爆。按字节限才对所有文字一视同仁。
 * ★ 48 字节 ≈ 16 个汉字 / 48 个 ASCII 字符 —— 比目标宽一点，给"模型稍微超一点"留余地，
 *   但绝不允许它交一整句话上来。
 */
const MAX_TITLE_BYTES = 48;

/** 提示词里给的"素材"上限：标题只看开头，给多了反被后文带偏 */
const MAX_MATERIAL_CHARS = 600;

/**
 * 占位标题：前端新建会话时用的「对话 N」这类名字。
 * ★ 判据写成函数而不是正则写死在这里 —— 前端改文案时只改一处。
 */
export function isPlaceholderTitle(title: string | null): boolean {
  if (title === null) return true;
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  // 「对话 1」「新对话」「未命名」都算占位
  return /^(对话|新对话|未命名|新的对话)\s*\d*$/u.test(trimmed);
}

/**
 * 洗掉会让人看不出真面目的字符。
 *
 * ★ 这些都是**实测会出问题**的：
 *   - ANSI 转义（`\u001b[31m` 之类）：模型偶尔会带颜色码，显示成一堆乱码；
 *   - C0/C1 控制字符：退格之类会把一行标题拆开；
 *   - 方向控制符（U+202A–U+202E、U+200E/F）：能让标题**显示成与实际内容不同**，
 *     这是纯视觉欺骗，必须删（DSH 的 `normalize.js` 里也是同一类处理）；
 *   - 零宽字符与 BOM：看不见，但会让"看起来一样"的两个标题不相等。
 *
 * ★ **不动换行**：换行是"哪一行才是标题"的判据，必须在取第一行之后才归一成空格。
 *   上一版在这里就把 `\n` 压成空格，导致 `甲\n丙` 变成 `甲 丙` —— 把该丢的第二行粘了回来。
 */
function cleanTitleText(input: string): string {
  return input
    // OSC 序列（含未闭合）
    .replace(/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu, '')
    // CSI 序列（SGR 颜色等）
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
    // 其余两字节 ESC 序列
    .replace(/\u001B[@-_]/gu, '')
    // 控制字符（★ 保留 \t \n \r，交给后面的"取第一行 / 归一空格"处理）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
    // 方向与不可见控制符
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '');
}

/** 把一行里的制表/多空格压成单个空格（**不跨行**） */
function squeezeSpaces(line: string): string {
  return line.replace(/[ \t\u00A0]+/gu, ' ').trim();
}

/**
 * 按 UTF-8 字节预算截断，**不切断 Unicode 码点**。
 * ★ 用 `for…of` 逐码点走：一个 emoji 由多个 UTF-16 码元组成，
 *   按 `slice` 截会在中间劈开，产生半个代理对（显示成 �）。
 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let used = 0;
  let output = '';
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/** 把模型可能夹带的引号/前缀洗掉，只留一行短标题（已含洗字符 + 字节预算） */
export function normalizeTitle(raw: string): string {
  // ① 先洗不可见/欺骗字符（★ 保留换行）
  const cleaned = cleanTitleText(raw);
  // ② 再取第一行（模型经常"标题 + 解释"，第一行才是标题）
  const firstLine = squeezeSpaces((cleaned.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? '').trim());

  // ③ 去掉 markdown 标题、列表符号、整行包裹的引号/星号
  let value = firstLine.replace(/^#{1,6}\s*/u, '');
  value = value.replace(/^[-*•]\s*/u, '');
  value = value.replace(/^["'「『《\u002A]{1,3}(.+?)["'」』》\u002A]{1,3}$/u, '$1');
  value = squeezeSpaces(value);
  if (Buffer.byteLength(value, 'utf8') <= MAX_TITLE_BYTES) {
    return value.replace(/[。，；：、！？,;:.!?\s]+$/u, '');
  }

  // ④ 超预算：优先在句读处断（尽量多留内容），断不出来才硬截
  const head = truncateTitleUtf8(value, MAX_TITLE_BYTES);
  let cut = -1;
  for (const mark of ['。', '，', '；', '：', '！', '？']) {
    const index = head.lastIndexOf(mark);
    if (index > cut) cut = index;
  }
  const trimmed = (cut >= 4 ? head.slice(0, cut) : head).trim();
  return trimmed.replace(/[。，；：、！？,;:.!?\s]+$/u, '');
}

/**
 * 确定性回退：模型失败时用第一句用户消息的开头凑一个标题。
 * ★ 有它才不会出现"会话永远叫『新的对话』"——DSH 也是这么做的
 *   （`fallbackSessionTitle`：先按词数取，再按字节截）。
 * ★ 它只能兜住"没标题"，不能代替模型：读起来生硬，但比空着强。
 */
export function fallbackTitle(firstUserText: string): string | null {
  const cleaned = cleanTitleText(firstUserText);
  // 与 normalizeTitle 同一条尺子：先取第一行，再判空
  const firstLine = squeezeSpaces((cleaned.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? '').trim());
  if (firstLine.length === 0) return null;
  const head = truncateTitleUtf8(firstLine, MAX_TITLE_BYTES);
  const stop = Math.max(...['。', '，', '；', '！', '？', '.', ',', ';', '!', '?'].map((m) => head.indexOf(m)));
  const cut = stop >= 4 ? head.slice(0, stop) : head;
  const result = cut.trim().replace(/[。，；：、！？,;:.!?\s]+$/u, '');
  return result.length === 0 ? null : result;
}

export type TitleResult = {
  readonly title: string | null;
  /** 没起标题的原因（诊断用，不进用户可见文案） */
  readonly skipped: 'has_title' | 'no_material' | 'failed' | 'empty' | null;
};

/**
 * 真的发一次请求去起标题。调用方负责"要不要起"的判断与失败兜底。
 */
export async function generateConversationTitle(options: {
  readonly db: DatabaseSync;
  readonly conversationId: string;
  readonly provider: Provider;
  readonly signal: AbortSignal;
  /** 显式指定模型；不给就用会话当前模型 */
  readonly model?: string;
}): Promise<TitleResult> {
  const { db, conversationId, provider, signal } = options;
  const conversation = getConversation(db, conversationId);
  if (conversation === undefined) return { title: null, skipped: 'no_material' };
  if (!isPlaceholderTitle(conversation.title)) return { title: null, skipped: 'has_title' };

  const messages = listMessages(db, conversationId);
  const firstUser = messages.find((message) => message.role === 'user' && (message.content ?? '').trim().length > 0);
  if (firstUser === undefined) return { title: null, skipped: 'no_material' };
  const firstUserText = firstUser.content ?? '';

  const firstAssistant = messages.find(
    (message) =>
      message.role === 'assistant' &&
      message.displayChannel === 'chat' &&
      (message.content ?? '').trim().length > 0,
  );

  // 素材给足上下文但别太长：题目只看前两轮就够，给多了反而被后文带偏
  const material = [
    `用户：${firstUserText.slice(0, MAX_MATERIAL_CHARS)}`,
    ...(firstAssistant === undefined
      ? []
      : [`助手：${(firstAssistant.content ?? '').slice(0, MAX_MATERIAL_CHARS)}`]),
  ].join('\n\n');

  /**
   * ★ 确定性回退先算好放着，不等到失败才现算。
   *   照 DSH 的做法（`fallbackSessionTitle`）：**先有回退，再去请求**。
   *   这样即使模型超时/没回，会话也不会一直叫「新的对话」。
   */
  const fallback = fallbackTitle(firstUserText);

  let raw = '';
  try {
    for await (const event of provider.stream(
      {
        model: options.model ?? conversation.model,
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          { role: 'user', content: `给下面这段对话起一个标题：\n\n${material}` },
        ],
      },
      signal,
    )) {
      if (event.type === 'text') raw += event.delta;
      else if (event.type === 'error') return commitTitle(db, conversationId, fallback, 'failed');
    }
  } catch {
    // ★ 起标题失败不是错误 —— 网络抖动、超时、上游 400 都不该让用户看到任何东西
    return commitTitle(db, conversationId, fallback, 'failed');
  }

  const title = normalizeTitle(raw);
  // 模型回了空（只回了空白/纯标点）⇒ 用回退
  if (title.length === 0) return commitTitle(db, conversationId, fallback, 'empty');

  const committed = commitTitle(db, conversationId, title, null);
  return committed.title === null ? committed : committed;
}

/**
 * 落标题，并做最后一次"用户没在这一秒手改过"的确认。
 *
 * ★ 有回退就直接用回退（`skipped` 保留失败原因，方便诊断）；
 *   连回退都没有（用户第一句是空白/纯符号）才真的放弃。
 */
function commitTitle(
  db: DatabaseSync,
  conversationId: string,
  title: string | null,
  reason: 'failed' | 'empty' | null,
): TitleResult {
  if (title === null || title.length === 0) return { title: null, skipped: reason ?? 'empty' };

  const fresh = getConversation(db, conversationId);
  if (fresh === undefined || !isPlaceholderTitle(fresh.title)) {
    return { title, skipped: 'has_title' };
  }

  updateConversation(db, conversationId, { title });
  return { title, skipped: reason };
}
