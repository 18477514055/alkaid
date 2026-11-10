import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { ToolCallAggregator } from '../../src/core/model/aggregate.ts';
import { createOpenAiProvider } from '../../src/core/model/openai.ts';
import type { Provider, ProviderConfig } from '../../src/core/model/provider.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

/**
 * 端到端：**真 HTTP + 真 SSE 字节流**，不 mock fetch。
 * 理由（D8 §2.7）：mock 出来的绿不能证明"流真的能解析"。
 */

type FakeState = {
  requests: number;
  lastHeaders: IncomingMessage['headers'] | undefined;
  lastBody: string;
};

type FakeServer = {
  baseUrl: string;
  state: FakeState;
  close: () => Promise<void>;
};

async function startFakeServer(
  handler: (res: ServerResponse, attempt: number) => void,
): Promise<FakeServer> {
  const state: FakeState = { requests: 0, lastHeaders: undefined, lastBody: '' };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    state.requests += 1;
    state.lastHeaders = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      state.lastBody = Buffer.concat(chunks).toString('utf8');
      handler(res, state.requests);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const API_KEY = 'sk-test-abcdefghijklmnop';

function makeProvider(baseUrl: string, overrides: Partial<Parameters<typeof createOpenAiProvider>[0]> = {}): Provider {
  const config: ProviderConfig = {
    id: 'p1',
    name: 'fake',
    baseUrl,
    apiKey: API_KEY,
    chatPath: 'chat/completions',
    modelsPath: 'models',
  };
  return createOpenAiProvider({
    config,
    maxAttempts: 3,
    firstByteTimeoutMs: 2_000,
    backoffBaseMs: 1,
    sleep: async () => {},
    ...overrides,
  });
}

const REQ: ChatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: '你好' }],
};

async function collect(provider: Provider, req: ChatRequest, signal: AbortSignal): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of provider.stream(req, signal)) events.push(event);
  return events;
}

function sse(res: ServerResponse, payload: string): void {
  res.write(`data: ${payload}\n\n`);
}

test('正常流：三段增量 + 用量 + finish(stop)', async () => {
  const server = await startFakeServer((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, '{"choices":[{"delta":{"content":"你"}}]}');
    sse(res, '{"choices":[{"delta":{"content":"好"}}]}');
    sse(res, '{"choices":[{"delta":{"content":"呀"}}]}');
    sse(res, '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}');
    sse(res, '[DONE]');
    res.end();
  });

  try {
    const events = await collect(makeProvider(server.baseUrl), REQ, new AbortController().signal);
    assert.deepEqual(
      events.map((event) => event.type),
      ['text', 'text', 'text', 'usage', 'finish'],
    );
    assert.equal(
      events
        .filter((event): event is Extract<ChatEvent, { type: 'text' }> => event.type === 'text')
        .map((event) => event.delta)
        .join(''),
      '你好呀',
    );
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
    assert.equal(server.state.requests, 1);
  } finally {
    await server.close();
  }
});

test('密钥只在 Authorization 头，绝不进请求体', async () => {
  const server = await startFakeServer((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, '[DONE]');
    res.end();
  });

  try {
    await collect(makeProvider(server.baseUrl), REQ, new AbortController().signal);
    assert.equal(server.state.lastHeaders?.['authorization'], `Bearer ${API_KEY}`);
    assert.ok(!server.state.lastBody.includes(API_KEY), '密钥出现在请求体里了');
    const body = JSON.parse(server.state.lastBody) as { stream?: boolean; stream_options?: unknown };
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  } finally {
    await server.close();
  }
});

test('429 会重试并最终成功（且只重试一次就够）', async () => {
  const server = await startFakeServer((res, attempt) => {
    if (attempt === 1) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"rate limited"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, '{"choices":[{"delta":{"content":"重试成功"}}]}');
    sse(res, '[DONE]');
    res.end();
  });

  try {
    const events = await collect(makeProvider(server.baseUrl), REQ, new AbortController().signal);
    assert.equal(server.state.requests, 2);
    assert.equal(events[0]?.type, 'text');
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  } finally {
    await server.close();
  }
});

test('400 不重试（密钥/参数错了，重试没有意义）', async () => {
  const server = await startFakeServer((res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":"bad request"}');
  });

  try {
    const events = await collect(makeProvider(server.baseUrl), REQ, new AbortController().signal);
    assert.equal(server.state.requests, 1, '400 不该被重试');
    assert.equal(events.length, 1);
    const error = events[0];
    assert.equal(error?.type, 'error');
    assert.equal(error !== undefined && error.type === 'error' && error.retryable, false);
  } finally {
    await server.close();
  }
});

test('吐过内容后断流：不重试，且明说截断', async () => {
  const server = await startFakeServer((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, '{"choices":[{"delta":{"content":"说到一半"}}]}');
    res.end(); // ★ 没有 finish_reason，也没有 [DONE]
  });

  try {
    const events = await collect(makeProvider(server.baseUrl), REQ, new AbortController().signal);
    assert.equal(server.state.requests, 1, '吐过内容就不该重试');
    assert.equal(events[0]?.type, 'text');
    const error = events.at(-2);
    assert.equal(error?.type, 'error');
    assert.equal(error !== undefined && error.type === 'error' && error.retryable, false);
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'error' });
  } finally {
    await server.close();
  }
});

test('tool_calls 端到端：增量拼出完整参数，finish 为 tool_calls', async () => {
  const server = await startFakeServer((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}');
    sse(res, '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}');
    sse(res, '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}');
    sse(res, '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
    sse(res, '[DONE]');
    res.end();
  });

  try {
    const events = await collect(makeProvider(server.baseUrl), REQ, new AbortController().signal);
    const aggregator = new ToolCallAggregator();
    for (const event of events) if (event.type === 'tool_call') aggregator.apply(event);
    assert.deepEqual(aggregator.list(), [
      { id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
    ]);
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'tool_calls' });
  } finally {
    await server.close();
  }
});

test('已被中止的 signal：直接以 finish(abort) 收场，不发请求也不抛异常', async () => {
  const controller = new AbortController();
  controller.abort();

  const provider = makeProvider('http://127.0.0.1:1', { maxAttempts: 1 });
  const events = await collect(provider, REQ, controller.signal);
  assert.deepEqual(events, [{ type: 'finish', reason: 'abort' }]);
});
