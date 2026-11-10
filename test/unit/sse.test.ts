import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SseFrameParser } from '../../src/core/model/sse.ts';

test('一整块里的两帧都吐出来', () => {
  const parser = new SseFrameParser();
  const out = parser.push('data: {"a":1}\n\ndata: {"b":2}\n\n');
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('一帧被切成三块也能拼回来（真实网络就是这样给的）', () => {
  const parser = new SseFrameParser();
  assert.deepEqual(parser.push('da'), []);
  assert.deepEqual(parser.push('ta: {"choi'), []);
  assert.deepEqual(parser.push('ces":[]}\n'), []);
  assert.deepEqual(parser.push('\n'), ['{"choices":[]}']);
});

test('CRLF 行尾同样处理', () => {
  const parser = new SseFrameParser();
  assert.deepEqual(parser.push('data: hello\r\n\r\n'), ['hello']);
});

test('注释行（keep-alive）被忽略', () => {
  const parser = new SseFrameParser();
  assert.deepEqual(parser.push(': ping\n\n'), []);
  assert.deepEqual(parser.push('data: x\n\n'), ['x']);
});

test('同一个事件里的多行 data 用换行连接（不能只取第一行）', () => {
  const parser = new SseFrameParser();
  const out = parser.push('data: line1\ndata: line2\n\n');
  assert.deepEqual(out, ['line1\nline2']);
});

test('流结束时没有末尾空行，flush 也要把残帧交出来', () => {
  const parser = new SseFrameParser();
  assert.deepEqual(parser.push('data: tail'), []);
  assert.deepEqual(parser.flush(), ['tail']);
});
