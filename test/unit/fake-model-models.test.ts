import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * 假模型的 `GET /v1/models` 端点。
 *
 * ★ 这个端点曾经不存在：脚本把所有请求都当聊天流处理，问一次目录就返回一段 SSE 正文。
 *   后果不是"假模型不好用"，而是**设置页那条白名单链路根本没法验** ——
 *   `catalog` 永远是空的，勾选区永远是"没有拉到模型目录"，
 *   于是"我只配了一个 deepseek，为什么对话里能选到几十个"这个问题的修复没有任何方法证伪。
 *
 * ★ 所以这里钉两件事：
 *   ① 目录端点回的是 JSON 模型数组（不是 SSE）；
 *   ② 它回的**比实际配置多** —— 那正是白名单过滤得以被观察到的前提。
 */

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForListening(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (response.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`假模型 ${timeoutMs}ms 内没起来（端口 ${port}）`);
}

test('假模型提供 GET /v1/models：回 JSON 目录，而且比配置的模型多', async () => {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [join(import.meta.dirname, '..', '..', 'scripts', 'fake-model.ts'), String(port)], {
    stdio: 'ignore',
  });

  try {
    await waitForListening(port);

    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(response.status, 200);

    // ① 必须是 JSON —— 以前这里回的是 text/event-stream
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);

    const body = (await response.json()) as { object?: string; data?: Array<{ id?: string }> };
    assert.equal(body.object, 'list');
    const ids = (body.data ?? []).map((item) => item.id);
    assert.deepEqual(ids, ['fake-model', 'fake-model-large', 'fake-model-reasoning']);

    // ② 目录比 defaultModel 多 ⇒ 「白名单过滤」才有东西可滤
    assert.ok(ids.length > 1, '目录至少要有 2 个模型，否则测不出过滤');
    assert.ok(ids.includes('fake-model'), '真实配置用的那个必须在目录里');
  } finally {
    child.kill();
  }
});

test('假模型仍然正常接受聊天请求（加了 /models 没把聊天路径带坏）', async () => {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [join(import.meta.dirname, '..', '..', 'scripts', 'fake-model.ts'), String(port)], {
    stdio: 'ignore',
  });

  try {
    await waitForListening(port);

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        messages: [{ role: 'user', content: '你好' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const text = await response.text();
    assert.ok(text.includes('data: '), '应该是 SSE 流');
    assert.ok(text.includes('[DONE]'), '流要以 [DONE] 收尾');
    assert.ok(text.includes('假模型'), '正文应来自 PLAIN_REPLY');
  } finally {
    child.kill();
  }
});
