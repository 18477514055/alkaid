import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { readSecrets } from '../../src/core/secrets.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

/**
 * §11 测试一（基本对话）的**端到端**版本：
 * 真 HTTP 入口 → 真 SSE 出 → 真 SQLite 落库。
 * 唯一被替换的是"厂商"，用一个本地假 SSE 服务器扮演（它发的字节形状与 OpenAI 一致）。
 */

type Harness = {
  app: ReturnType<typeof buildServer>;
  home: string;
  db: ReturnType<typeof openDatabase>;
  secretsPath: string;
  close: () => Promise<void>;
};

async function withHarness(run: (ctx: Harness) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-chat-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);

  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });

  try {
    await run({
      app,
      home,
      db,
      secretsPath: config.secretsPath,
      close: async () => {
        await app.close();
        db.close();
        rmSync(home, { recursive: true, force: true });
      },
    });
  } finally {
    try {
      await app.close();
    } catch {
      /* 已关闭 */
    }
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(home, { recursive: true, force: true });
  }
}

async function startFakeModel(
  handler: (res: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.on('error', () => {});
    handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function sse(res: ServerResponse, payload: string): void {
  res.write(`data: ${payload}\n\n`);
}

function parseEvents(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const frame of body.split('\n\n')) {
    const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
    if (line === undefined) continue;
    events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
  }
  return events;
}

test('§11 测试一：配置模型 → 创建对话 → 收到流式回复 → 历史可恢复', async () => {
  const model = await startFakeModel((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, '{"choices":[{"delta":{"content":"你"}}]}');
    sse(res, '{"choices":[{"delta":{"content":"好"}}]}');
    sse(res, '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2}}');
    sse(res, '[DONE]');
    res.end();
  });

  await withHarness(async ({ app, secretsPath, close }) => {
    try {
      // ① 配置模型连接
      const providerRes = await app.inject({
        method: 'POST',
        url: '/api/providers',
        payload: { name: '本地假模型', baseUrl: model.baseUrl, apiKey: 'sk-fake-1234567890' },
      });
      assert.equal(providerRes.statusCode, 201);
      const provider = providerRes.json() as { id: string; hasKey: boolean };
      assert.equal(provider.hasKey, true);

      // ② 创建对话
      const conversationRes = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { providerId: provider.id, model: 'test-model', title: '第一次对话' },
      });
      assert.equal(conversationRes.statusCode, 201);
      const conversation = conversationRes.json() as { id: string; permissionMode: string };
      assert.equal(conversation.permissionMode, 'workspace');

      // ③ 发消息，响应就是 SSE 流
      const streamRes = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/messages`,
        payload: { content: '你好' },
      });
      assert.equal(streamRes.statusCode, 200);
      assert.match(streamRes.headers['content-type'] as string, /text\/event-stream/);

      const events = parseEvents(streamRes.body);
      const types = events.map((event) => event['type']);

      assert.equal(types[0], 'user', '第一个事件必须是把用户消息落库后的回执');
      assert.ok(types.includes('text'), '没有拿到 text 增量');
      assert.equal(types.at(-1), 'finish');

      const text = events
        .filter((event) => event['type'] === 'text')
        .map((event) => String(event['delta']))
        .join('');
      assert.equal(text, '你好');

      const finish = events.at(-1) as { reason: string };
      assert.equal(finish.reason, 'stop');

      const usageEvent = events.find((event) => event['type'] === 'usage') as
        | { usage: { input: number; output: number } }
        | undefined;
      assert.deepEqual(usageEvent?.usage, { input: 12, output: 2 });

      // ④ 历史恢复
      const historyRes = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversation.id}/messages`,
      });
      const history = historyRes.json() as Array<{ role: string; content: string | null; seq: number }>;
      assert.equal(history.length, 2);
      assert.deepEqual(
        history.map((message) => [message.seq, message.role, message.content]),
        [
          [1, 'user', '你好'],
          [2, 'assistant', '你好'],
        ],
      );

      // ⑤ 密钥落在 secrets.json 里，但**没进**任何 API 响应
      assert.equal(readSecrets(secretsPath)[provider.id], 'sk-fake-1234567890');
      const providersRes = await app.inject({ method: 'GET', url: '/api/providers' });
      assert.ok(!providersRes.body.includes('sk-fake-1234567890'), '密钥泄漏到 API 响应里了');
    } finally {
      await model.close();
      await close();
    }
  });
});

test('模型连接没有 Key 时，发消息被 412 挡住（不是静默失败）', async () => {
  await withHarness(async ({ app, db, close }) => {
    try {
      // 绕过 API 直接插一条 provider（因此 secrets.json 里没有它的 key）
      const provider = insertProvider(db, { name: '无 key', baseUrl: 'http://127.0.0.1:9/v1' });
      const conversationRes = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { providerId: provider.id, model: 'm' },
      });
      const conversation = conversationRes.json() as { id: string };

      const res = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/messages`,
        payload: { content: '你好' },
      });
      assert.equal(res.statusCode, 412);
      assert.match(res.body, /API Key/);
    } finally {
      await close();
    }
  });
});

test('未知会话 / 空内容 / 非法权限模式都返回 4xx', async () => {
  await withHarness(async ({ app, close }) => {
    try {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/conversations/not-exist/messages',
        payload: { content: '你好' },
      });
      assert.equal(missing.statusCode, 404);

      const providerRes = await app.inject({
        method: 'POST',
        url: '/api/providers',
        payload: { name: 'p', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-abcdefgh' },
      });
      const provider = providerRes.json() as { id: string };

      const emptyContent = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { providerId: provider.id, model: 'm' },
      });
      const conversation = emptyContent.json() as { id: string };

      const bad = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/messages`,
        payload: { content: '   ' },
      });
      assert.equal(bad.statusCode, 400);

      const badMode = await app.inject({
        method: 'PATCH',
        url: `/api/conversations/${conversation.id}`,
        payload: { permissionMode: '乱写的' },
      });
      assert.equal(badMode.statusCode, 400);
    } finally {
      await close();
    }
  });
});
