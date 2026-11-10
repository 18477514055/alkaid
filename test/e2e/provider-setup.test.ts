import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { probeModels, resolveModelsUrl } from '../../src/core/model/list-models.ts';
import { findPreset, listPresets } from '../../src/core/model/presets.ts';
import { setSecret } from '../../src/core/secrets.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

/**
 * 模型接入：目录 + 探针 + 保存/编辑。
 *
 * 这里验的是"用户能不能不用背模型名":目录要够用、探针要把 401/404 分开说清楚、
 * 保存之后能改能删。全部走真 HTTP（本地假服务端），不 mock fetch。
 */

test('内置目录：46 家，含多接入点与常见模型', () => {
  const presets = listPresets();
  assert.ok(presets.length >= 40, `预设太少：${presets.length}`);

  const deepseek = findPreset('deepseek');
  assert.ok(deepseek !== undefined, '缺少 deepseek 预设');
  assert.equal(deepseek?.endpoints[0]?.baseUrl.includes('api.deepseek.com'), true);
  assert.ok((deepseek?.commonModels.length ?? 0) > 0, 'deepseek 应该有常见模型名');

  // 多接入点必须保留（通义 5 个 / 小米 4 个）—— 这是"真实存在的不同途径"，不是重复配置
  const qwen = findPreset('qwen');
  assert.ok((qwen?.endpoints.length ?? 0) >= 3, `通义接入点应 >=3，实际 ${qwen?.endpoints.length ?? 0}`);
});

test('模型列表 URL 解析：默认 / 相对路径 / 绝对覆盖', () => {
  assert.equal(resolveModelsUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/models');
  assert.equal(resolveModelsUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/models');
  assert.equal(resolveModelsUrl('https://x.com/v1', 'openai/v1/models'), 'https://x.com/v1/openai/v1/models');
  assert.equal(resolveModelsUrl('https://x.com/inference/openai/v1', 'https://x.com/inference/v1/models'), 'https://x.com/inference/v1/models');
});

function startFakeGateway(handler: (url: string, res: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    handler(req.url ?? '/', res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

test('探针：200 解析出模型列表；401 / 404 给的是不同的、可行动的提示', async () => {
  const okGateway = await startFakeGateway((_url, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-chat', owned_by: 'deepseek' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] }));
  });
  const deniedGateway = await startFakeGateway((_url, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"invalid api key"}}');
  });
  const missingGateway = await startFakeGateway((_url, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });

  try {
    const ok = await probeModels({ baseUrl: `http://127.0.0.1:${okGateway.port}/v1`, apiKey: 'k' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.models.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner'], '应去重并保序');
    assert.equal(ok.models[0]?.ownedBy, 'deepseek');

    const denied = await probeModels({ baseUrl: `http://127.0.0.1:${deniedGateway.port}/v1`, apiKey: 'bad' });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 401);
    assert.match(denied.hint ?? '', /密钥被拒绝/);

    const missing = await probeModels({ baseUrl: `http://127.0.0.1:${missingGateway.port}/v1`, apiKey: 'k' });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    assert.match(missing.hint ?? '', /模型列表|路径/);
    // ★ 两种失败的提示必须不是同一句，否则等于没说
    assert.notEqual(denied.hint, missing.hint);
  } finally {
    await okGateway.close();
    await deniedGateway.close();
    await missingGateway.close();
  }
});

test('会话头：OpenCode 那类网关要求按对话固定的 x-opencode-session，缺了直接 400', async () => {
  // 假网关：不带会话头就照抄 OpenCode 的真实报错
  const seen: Array<string | undefined> = [];
  const gateway = await startFakeGateway((_url, res) => {
    // 这个 handler 拿不到 req，用闭包外部变量记；真实断言在下面的 echo 服务器里
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  await gateway.close();

  const captured: Array<Record<string, string | string[] | undefined>> = [];
  const echo = createServer((req, res) => {
    captured.push(req.headers);
    const session = req.headers['x-opencode-session'];
    if (typeof session !== 'string' || session.length === 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '收到会话 ' + session } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', () => resolve()));
  const { port } = echo.address() as AddressInfo;

  const home = mkdtempSync(join(tmpdir(), 'alkaid-session-header-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ config, db });

  try {
    const provider = insertProvider(db, {
      name: 'OpenCode Go',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      sessionHeader: 'x-opencode-session',
    });
    setSecret(config.secretsPath, provider.id, 'sk-opencode-test');
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: '你好' },
    });

    assert.equal(sent.statusCode, 200);
    assert.ok(captured.length > 0, '请求没发出去');
    // ★ 头必须有，且必须是**这个对话的 id**（稳定值，不是随机串）
    assert.equal(captured[0]?.['x-opencode-session'], conversation.id);
    assert.doesNotMatch(sent.body, /MissingSessionID/);
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});

test('HTTP 面：预设目录 / 探针 / 保存后改名改模型 / 删除', async () => {
  const gateway = await startFakeGateway((_url, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }));
  });

  const home = mkdtempSync(join(tmpdir(), 'alkaid-setup-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ config, db });

  try {
    const presets = await app.inject({ method: 'GET', url: '/api/providers/presets' });
    assert.equal(presets.statusCode, 200);
    assert.ok((presets.json() as unknown[]).length >= 40);

    const baseUrl = `http://127.0.0.1:${gateway.port}/v1`;

    // 保存前的探针
    const probe = await app.inject({ method: 'POST', url: '/api/providers/probe', payload: { baseUrl, apiKey: 'k' } });
    assert.equal(probe.statusCode, 200);
    const probeBody = probe.json() as { ok: boolean; models: Array<{ id: string }> };
    assert.equal(probeBody.ok, true);
    assert.equal(probeBody.models.length, 2);

    // 保存
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { name: '我的网关', baseUrl, apiKey: 'sk-test-123456', defaultModel: 'm-one' },
    });
    assert.equal(created.statusCode, 201);
    const provider = created.json() as { id: string; defaultModel: string | null; hasKey: boolean };
    assert.equal(provider.defaultModel, 'm-one');
    assert.equal(provider.hasKey, true);

    /*
     * 已保存连接的模型列表。
     * ★ 语义已经变了（V10）：`models` 是**对话里可选的**（按白名单过滤），
     *   `catalog` 才是网关那边的完整目录。
     *   这条连接没设 enabledModels ⇒ 回退到 defaultModel，所以只有 1 个。
     *   完整目录仍然是 2 个 —— 两个都要断言，否则测不出"过滤到底有没有发生"。
     */
    const models = await app.inject({ method: 'GET', url: `/api/providers/${provider.id}/models` });
    assert.equal(models.statusCode, 200);
    const modelsBody = models.json() as { models: Array<{ id: string }>; catalog?: string[] };
    assert.deepEqual(modelsBody.models.map((item) => item.id), ['m-one'], '没设白名单时只给默认模型');
    assert.equal(modelsBody.catalog?.length, 2, 'catalog 仍应是网关完整目录');

    // 设了白名单 ⇒ 只回白名单里的（且去重）
    const withAllow = await app.inject({
      method: 'PATCH',
      url: `/api/providers/${provider.id}`,
      payload: { enabledModels: ['m-two', 'm-two', 'm-one'] },
    });
    assert.equal(withAllow.statusCode, 200);
    assert.deepEqual((withAllow.json() as { enabledModels: string[] }).enabledModels, ['m-two', 'm-one'], '去重');
    const afterAllow = await app.inject({ method: 'GET', url: `/api/providers/${provider.id}/models` });
    assert.equal(
      (afterAllow.json() as { models: unknown[] }).models.length,
      2,
      '白名单里两个都在 ⇒ 回两个',
    );

    // 白名单按网关顺序过滤（m-one 在前），不是按白名单书写顺序
    assert.deepEqual(
      (afterAllow.json() as { models: Array<{ id: string }> }).models.map((item) => item.id),
      ['m-one', 'm-two'],
    );

    // 清空（[]）⇒ 一个都不给
    await app.inject({ method: 'PATCH', url: `/api/providers/${provider.id}`, payload: { enabledModels: [] } });
    const emptied = await app.inject({ method: 'GET', url: `/api/providers/${provider.id}/models` });
    assert.equal((emptied.json() as { models: unknown[] }).models.length, 0, '显式清空 = 一个都不给');

    // 非法值要挡住
    const badModels = await app.inject({
      method: 'PATCH',
      url: `/api/providers/${provider.id}`,
      payload: { enabledModels: 'm-one' },
    });
    assert.equal(badModels.statusCode, 400);

    // 还原成一个，供后面的断言继续用
    await app.inject({
      method: 'PATCH',
      url: `/api/providers/${provider.id}`,
      payload: { enabledModels: null },
    });

    // 改名 + 换模型 + 改窗口
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/providers/${provider.id}`,
      payload: { name: '改过名字', defaultModel: 'm-two', contextWindow: 200_000 },
    });
    assert.equal(patched.statusCode, 200);
    const patchedBody = patched.json() as { name: string; defaultModel: string | null; contextWindow: number; hasKey: boolean };
    assert.equal(patchedBody.name, '改过名字');
    assert.equal(patchedBody.defaultModel, 'm-two');
    assert.equal(patchedBody.contextWindow, 200_000);
    assert.equal(patchedBody.hasKey, true, '改别的字段不能把密钥弄丢');

    // 非法 baseUrl 要挡住
    const bad = await app.inject({ method: 'PATCH', url: `/api/providers/${provider.id}`, payload: { baseUrl: 'ftp://x' } });
    assert.equal(bad.statusCode, 400);

    // 删除
    const removed = await app.inject({ method: 'DELETE', url: `/api/providers/${provider.id}` });
    assert.equal(removed.statusCode, 200);
    const after = await app.inject({ method: 'GET', url: '/api/providers' });
    assert.equal((after.json() as unknown[]).length, 0);
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await gateway.close();
  }
});
