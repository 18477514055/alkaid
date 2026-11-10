import type { ChatEvent, ToolCall } from '../../shared/types.ts';

/**
 * 工具调用增量聚合器（★ 设计稿 §6.2 坑 6）。
 *
 * ChatMobile 的 MVP 明确没做这件事（它没有工具），所以这是我们必须自己补的一层。
 * 流式形状：同一个 `index` 会来多帧，`id`/`name` 通常只在**首帧**，
 * `arguments` 是**逐段拼接**的字符串（不是一次到齐的 JSON）。
 */
export class ToolCallAggregator {
  #slots = new Map<number, { id: string; name: string; args: string }>();

  apply(event: Extract<ChatEvent, { type: 'tool_call' }>): void {
    const existing = this.#slots.get(event.index);
    const slot = existing ?? { id: '', name: '', args: '' };

    if (event.id !== undefined && event.id.length > 0) slot.id = event.id;
    if (event.name !== undefined && event.name.length > 0) slot.name = event.name;
    if (event.argsDelta !== undefined) slot.args += event.argsDelta;

    this.#slots.set(event.index, slot);
  }

  /** 按 index 升序返回 —— 顺序必须确定，否则工具执行顺序每次随机 */
  list(): ToolCall[] {
    return [...this.#slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, slot]) => ({ id: slot.id, name: slot.name, arguments: slot.args }));
  }

  get size(): number {
    return this.#slots.size;
  }
}
