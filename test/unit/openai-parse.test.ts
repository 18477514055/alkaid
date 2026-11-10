import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ToolCallAggregator } from '../../src/core/model/aggregate.ts';
import {
  SseParseError,
  createFrameState,
  parseOpenAiDataFrame,
} from '../../src/core/model/openai-parse.ts';
import type { ChatEvent } from '../../src/shared/types.ts';

function collect(frames: string[]): { events: ChatEvent[]; done: boolean } {
  const state = createFrameState();
  const events: ChatEvent[] = [];
  for (const frame of frames) events.push(...parseOpenAiDataFrame(frame, state));
  return { events, done: state.sawDone };
}

test('坑 1：`[DONE]` 不是 JSON，要被当结束哨兵而不是解析异常', () => {
  const { events, done } = collect(['[DONE]']);
  assert.equal(done, true);
  assert.deepEqual(events, [{ type: 'finish', reason: 'stop' }]);
});

test('坑 2：空 choices 的帧不崩，且用量照样读出来', () => {
  const { events } = collect([
    '{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}',
  ]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'usage', usage: { input: 12, output: 3 } });
});

test('坑 3：DeepSeek 把 usage 骑在内容帧上 —— 正文与用量都要出来', () => {
  const { events } = collect([
    '{"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"prompt_cache_hit_tokens":4}}',
  ]);
  assert.deepEqual(events, [
    // ★ 三桶口径：上游 prompt_tokens=5 里命中缓存 4 ⇒ 未缓存输入 = 5 − 4 = 1
    { type: 'usage', usage: { input: 1, output: 1, cached: 4, inputExcludesCached: true } },
    { type: 'text', delta: '好' },
  ]);
});

test('坑 4：推理字段两种写法都归一到 reasoning', () => {
  const a = collect(['{"choices":[{"delta":{"reasoning_content":"想A"}}]}']);
  assert.deepEqual(a.events, [{ type: 'reasoning', delta: '想A' }]);

  const b = collect(['{"choices":[{"delta":{"reasoning":"想B"}}]}']);
  assert.deepEqual(b.events, [{ type: 'reasoning', delta: '想B' }]);
});

test('坑 5：finish_reason 被记录，finish 事件留到 DONE 才发（保证 usage 在前）', () => {
  const state = createFrameState();
  const first = parseOpenAiDataFrame('{"choices":[{"delta":{},"finish_reason":"length"}]}', state);
  assert.deepEqual(first, [], 'finish_reason 帧本身不该发 finish 事件');
  const done = parseOpenAiDataFrame('[DONE]', state);
  assert.deepEqual(done, [{ type: 'finish', reason: 'length' }]);
});

test('坑 6：tool_calls 三段增量能拼出完整 JSON 参数', () => {
  const state = createFrameState();
  const events: ChatEvent[] = [];
  const frames = [
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '[DONE]',
  ];
  for (const frame of frames) events.push(...parseOpenAiDataFrame(frame, state));

  const aggregator = new ToolCallAggregator();
  for (const event of events) {
    if (event.type === 'tool_call') aggregator.apply(event);
  }

  assert.deepEqual(aggregator.list(), [
    { id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
  ]);
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'tool_calls' });
});

test('多个工具调用按 index 稳定排序（顺序必须确定）', () => {
  const state = createFrameState();
  const events: ChatEvent[] = [];
  for (const frame of [
    '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"grep","arguments":"{}"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{}"}}]}}]}',
  ]) {
    events.push(...parseOpenAiDataFrame(frame, state));
  }

  const aggregator = new ToolCallAggregator();
  for (const event of events) if (event.type === 'tool_call') aggregator.apply(event);
  assert.deepEqual(
    aggregator.list().map((call) => call.name),
    ['read', 'grep'],
  );
});

test('坏帧抛 SseParseError（不是静默吞掉）', () => {
  const state = createFrameState();
  assert.throws(() => parseOpenAiDataFrame('{not json', state), SseParseError);
});

// ───────────────────────── token 三桶口径 ─────────────────────────

/** 取这一批帧里唯一的 usage 事件（拿不到就抛，避免断言静默通过） */
function usageOf(frames: string[]): NonNullable<Extract<ChatEvent, { type: 'usage' }>['usage']> {
  const { events } = collect(frames);
  const usage = events.find((event) => event.type === 'usage');
  assert.ok(usage !== undefined && usage.type === 'usage', '这批帧里没有 usage 事件');
  return usage.usage;
}

test('三桶口径①：含缓存命中的真实 usage ⇒ 三桶之和 = 上游 prompt_tokens（账单口径）', () => {
  // OpenAI 形状：prompt_tokens 是**输入总量**，缓存命中额外报在 prompt_tokens_details 里
  const usage = usageOf([
    '{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":80,' +
      '"prompt_tokens_details":{"cached_tokens":900}}}',
  ]);

  assert.equal(usage.input, 300, '未缓存输入 = 1200 − 900');
  assert.equal(usage.cached, 900, '缓存读取原样保留');
  assert.equal(usage.inputExcludesCached, true, '新口径必须带判别标记');

  // ★ 判据：三桶之和 == 上游 prompt_tokens，一比一对得上账
  assert.equal(usage.input + (usage.cached ?? 0), 1200);
  assert.equal(usage.input + (usage.cached ?? 0) + (usage.cachedWrite ?? 0), 1200);
});

test('三桶口径②：reasoning 是 output 的子集，绝不参与求和（不能重复计费）', () => {
  const usage = usageOf([
    '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":500,' +
      '"prompt_tokens_details":{"cached_tokens":40},' +
      '"completion_tokens_details":{"reasoning_tokens":400}}}',
  ]);

  assert.equal(usage.output, 500);
  assert.equal(usage.reasoning, 400);
  // ★ reasoning 已经含在 output 里；再加一次就成了 900，那是重复计费
  assert.equal(usage.output, 500, 'output 不因 reasoning 而变大');
  assert.equal(usage.output + usage.input + (usage.cached ?? 0), 600, '求和只用三桶 + output');
});

test('三桶口径③：cachedWrite（Anthropic 语义）单列且计入总和；没报就真的不写这个字段', () => {
  // Anthropic 原生形状：input 总量 = input + cache_read + cache_creation
  const withWrite = usageOf([
    '{"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":100,' +
      '"cache_creation_input_tokens":500,' +
      '"prompt_tokens_details":{"cached_tokens":1000}}}',
  ]);
  assert.equal(withWrite.input, 500, '2000 − 1000 缓存读 − 500 缓存写');
  assert.equal(withWrite.cached, 1000);
  assert.equal(withWrite.cachedWrite, 500);
  assert.equal(withWrite.input + (withWrite.cached ?? 0) + (withWrite.cachedWrite ?? 0), 2000);

  // OpenAI 兼容网关一般不报缓存写入 —— 这里必须**没有这个键**，不能是 0
  const noWrite = usageOf(['{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}']);
  assert.equal(noWrite.cachedWrite, undefined, '没回报 = 没有字段（不是 0）');
  assert.equal(Object.hasOwn(noWrite, 'cachedWrite'), false, '不能拿 0 冒充「没报」');
  assert.equal(Object.hasOwn(noWrite, 'inputExcludesCached'), false, '没有缓存数字时不必打标记');
});

test('三桶口径④：缓存量异常（大于 prompt_tokens）时 input 夹到 0，不会出负数', () => {
  // 个别网关会把 cached_tokens 报成累计值或口径错位，宁可得 0 也不要负数进账单
  const usage = usageOf([
    '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,' +
      '"prompt_tokens_details":{"cached_tokens":100}}}',
  ]);
  assert.equal(usage.input, 0);
  assert.equal(usage.cached, 100);

  const overflow = usageOf([
    '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,' +
      '"prompt_tokens_details":{"cached_tokens":160}}}',
  ]);
  assert.equal(overflow.input, 0, '夹到 0，不出现负的未缓存输入');
});
