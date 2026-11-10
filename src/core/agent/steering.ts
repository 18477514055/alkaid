import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * **steering 通道**（A3 / `D1@L638`）：把"临时插一句"与"写进历史"彻底分开。
 *
 * ## ★★ 为什么不能直接 `appendMessage(role='user')`
 *
 * 本项目的核心承诺之一是**库里的原文逐字不变** —— 证据胶囊、`recall` 工具、
 * 审计三处都依赖这个事实。如果系统提醒以 `role='user'` 落库：
 *
 * 1. `recall` 会把"模型自己写的提醒"当成**用户真的说过的话**回读给模型；
 * 2. 导出的 transcript / 交接单会带上它，读的人以为用户要求过那件事；
 * 3. 下一轮压缩会把它当用户意图写进摘要，从此永久固化。
 *
 * `D1@L637`（A2）把这条明确列为**反模式**。所以：
 * **待注入内容单独一张表，注入是"临时拼进这一步的请求"，不是"写进历史"。**
 *
 * ## ★ 三条判据
 *
 * 1. **一条只能领一次**（`consumed_at`）。重复注入同一句提醒比不注入更糟：
 *    模型会把重复理解成强调，然后做出过激反应（例如把文件删了"以绝后患"）。
 * 2. **`source` 必填且语义严格**：只有 `'user'` 表示真人发言。其余一律是系统生成，
 *    渲染时必须**明确标注**它不是用户的话。
 * 3. **领取是原子的**：用 `UPDATE ... WHERE consumed_at IS NULL` 拿到 `changes`，
 *    并发时只有一方能领到（否则两条流会各注入一次）。
 */

/** 系统生成的提醒来源（非真人）。加新来源时**不要**用 `'user'`。 */
export const SYSTEM_INPUT_SOURCES = [
  'repeat-tool-reminder',
  'time-context',
  'system-note',
] as const;

export type PendingInputSource = 'user' | (typeof SYSTEM_INPUT_SOURCES)[number];

export type PendingInput = {
  readonly id: string;
  readonly conversationId: string;
  readonly source: string;
  readonly content: string;
  readonly createdAt: string;
};

type Raw = Record<string, unknown>;

function toPendingInput(row: Raw): PendingInput {
  return {
    id: String(row['id']),
    conversationId: String(row['conversation_id']),
    source: String(row['source']),
    content: String(row['content']),
    createdAt: String(row['created_at']),
  };
}

/**
 * 排一条待注入输入。
 *
 * ★ 长度上限 2000：这不是"怕模型读不完"，而是**防止有人把整份文档塞进提醒里** ——
 *   那样它就成了绕过压缩与摘要的暗通道（每步都进上下文、却不在历史里）。
 */
export function queueInput(
  db: DatabaseSync,
  input: { readonly conversationId: string; readonly source: string; readonly content: string },
): PendingInput {
  const content = input.content.trim();
  if (content.length === 0) throw new Error('待注入内容不能为空');
  if (content.length > 2_000) throw new Error(`待注入内容过长（${content.length} > 2000），请不要用它搬运行长文`);
  if (input.source.length === 0) throw new Error('source 必填（用 user 表示真人发言）');

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO pending_inputs (id, conversation_id, source, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.conversationId, input.source, content, now);

  return { id, conversationId: input.conversationId, source: input.source, content, createdAt: now };
}

/**
 * 领取**当前所有未消费**的输入，并标记为已用。
 *
 * @returns 按入队顺序；没有就返回空数组
 *
 * ★ 为什么一次全领而不是"逐个领"：这些内容是"到这一步为止该让模型看到的东西"，
 *   分两批注入会让同一 step 的请求体取决于调用次数 —— 那种不确定性最难查。
 */
export function claimPendingInputs(
  db: DatabaseSync,
  conversationId: string,
  step: number,
): PendingInput[] {
  const rows = db
    .prepare(
      'SELECT * FROM pending_inputs WHERE conversation_id = ? AND consumed_at IS NULL ORDER BY created_at ASC, rowid ASC',
    )
    .all(conversationId) as Raw[];
  if (rows.length === 0) return [];

  const now = new Date().toISOString();
  const claimed: PendingInput[] = [];
  const update = db.prepare(
    'UPDATE pending_inputs SET consumed_at = ?, consumed_step = ? WHERE id = ? AND consumed_at IS NULL',
  );
  for (const row of rows) {
    const item = toPendingInput(row);
    const result = update.run(now, step, item.id);
    // ★ 并发时别人先领走了：跳过，不重复注入
    if (Number(result.changes) !== 1) continue;
    claimed.push(item);
  }
  return claimed;
}

/** 只看还有多少条没领（给 UI 显示"有 N 条待插话"，不消费） */
export function countPendingInputs(db: DatabaseSync, conversationId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM pending_inputs WHERE conversation_id = ? AND consumed_at IS NULL')
    .get(conversationId) as { n: number | bigint } | undefined;
  return row === undefined ? 0 : Number(row.n);
}

/**
 * 把领到的输入渲染成**发给模型的文本**。
 *
 * ★ 关键：**每条都标明来源**。`user` 与系统提醒在措辞上必须分得开 ——
 *   模型需要知道"这是用户说的"还是"这是运行时提醒的"，两者的服从程度不同。
 *   报告 `D1@L205`（§2.5）就是把这个当契约在用。
 */
export function renderPendingInputs(inputs: readonly PendingInput[]): string | null {
  if (inputs.length === 0) return null;
  const lines = inputs.map((item) =>
    item.source === 'user'
      ? `[用户在该轮进行中补充] ${item.content}`
      : `[运行时提醒 · 不是用户发言] ${item.content}`,
  );
  return lines.join('\n\n');
}

/** 清掉某会话的未消费输入（用户取消/切走时用）。返回删掉的条数 */
export function clearPendingInputs(db: DatabaseSync, conversationId: string): number {
  const result = db
    .prepare('DELETE FROM pending_inputs WHERE conversation_id = ? AND consumed_at IS NULL')
    .run(conversationId);
  return Number(result.changes);
}
