/**
 * SSE 分帧（**纯逻辑，不碰网络**）。
 *
 * 为什么单独抽出来：分帧是最容易被"测试数据写错"骗过的一层。
 * ChatMobile 的踩坑记录写得很明确 —— 把多行 JSON 塞进一个 `data:` 帧，
 * 第二行会被当未知字段丢掉，你得到半截 JSON，报错看起来像"解析器有 bug"。
 * 所以这里按规范实现：**多行 `data:` 用 `\n` 连接**，其它字段忽略。
 */

const CR = '\r';
const LF = '\n';

/**
 * 增量分帧器。push 任意切分的块，返回**已经完整**的事件 data 串列表。
 *
 * 必须能扛住"一帧被切成两半"——真实网络就是这样给的。
 */
export class SseFrameParser {
  #buffer = '';
  #dataLines: string[] = [];

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const out: string[] = [];

    for (;;) {
      const nl = this.#buffer.indexOf(LF);
      if (nl === -1) break;

      let line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line.endsWith(CR)) line = line.slice(0, -1);

      this.#consumeLine(line, out);
    }
    return out;
  }

  /** 流结束时把残帧吐出来（有的服务端最后不带换行） */
  flush(): string[] {
    const out: string[] = [];
    if (this.#buffer.length > 0) {
      let line = this.#buffer;
      this.#buffer = '';
      if (line.endsWith(CR)) line = line.slice(0, -1);
      this.#consumeLine(line, out);
    }
    this.#dispatch(out);
    return out;
  }

  #consumeLine(line: string, out: string[]): void {
    // 空行 = 事件边界
    if (line.length === 0) {
      this.#dispatch(out);
      return;
    }
    // 以 ':' 开头是注释（常见的 keep-alive `: ping`）
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    // 只关心 data；event:/id:/retry: 在 OpenAI 兼容接口里无用
    if (field === 'data') this.#dataLines.push(value);
  }

  #dispatch(out: string[]): void {
    if (this.#dataLines.length === 0) return;
    out.push(this.#dataLines.join(LF));
    this.#dataLines = [];
  }
}
