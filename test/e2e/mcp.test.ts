import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';

import { KEEP_EXISTING, mcpToolName, type McpServerDto } from '../../src/shared/mcp.ts';
import { loadConfig } from '../../src/config.ts';
import { MemoryMaintainer } from '../../src/core/memory/maintainer.ts';
import { disposeMcpManager } from '../../src/core/mcp/registry.ts';
import { createMcpConfigureTool, getMcpServer } from '../../src/core/mcp/store.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createSurface } from '../../src/core/tools/runtime.ts';
import { setToolMode, toolModeMap } from '../../src/core/tools/settings.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { ToolContext, ToolRegistry } from '../../src/core/tools/types.ts';
import { registerMcpRoutes } from '../../src/server/routes/mcp.ts';

/**
 * MCP 子系统的**端到端**测试：真实 HTTP（`app.inject`）+ 真实库 + 真实子进程。
 *
 * ★ 为什么这里不 `buildServer()`：
 *   `server/app.ts` 里注册 MCP 路由的那一行由装配方接线（本任务不改 app.ts）。
 *   测试直接装配一个最小 Fastify 并挂上 `registerMcpRoutes` —— 这样它
 *   **在接线之前和之后都能跑**（否则 app.ts 一接线，这里就会重复注册路由）。
 *
 * ★ 不连外网：stdio 用本测试写出来的极小假服务器，http 用 `node:http` 在本机起。
 */

const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** 极小的假 MCP 服务器（stdio）。有 echo / split / boom 与一个名字带非法字符的工具。 */
const FAKE_SERVER_SOURCE = String.raw`
let buffer = '';
const send = (message) => { process.stdout.write(JSON.stringify(message) + '\n'); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-e2e', version: '1.0.0' },
      } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'echo', description: '回显给定文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'split', description: '返回两个文本块', inputSchema: { type: 'object', properties: {} } },
        { name: 'boom', description: '总是失败', inputSchema: { type: 'object', properties: {} } },
        { name: 'weird.name/with:chars', description: '名字里带非法字符', inputSchema: { type: 'object', properties: {} } },
      ] } });
    } else if (message.method === 'tools/call') {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      if (name === 'echo') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo: ' + String(args.text) }] } });
      } else if (name === 'split') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [
          { type: 'text', text: '第一行' },
          { type: 'text', text: '第二行' },
        ] } });
      } else if (name === 'boom') {
        send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: '服务端说这次失败' }] } });
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool: ' + String(name) } });
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

type Ctx = {
  readonly home: string;
  readonly db: DatabaseSync;
  readonly app: FastifyInstance;
  readonly registry: ToolRegistry;
  readonly scriptPath: string;
};

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

/** 本机假 MCP HTTP 服务器（记下收到的 header，用来验证凭证真的发出去了）。 */
async function startHttpMcpServer(): Promise<{
  server: Server;
  url: string;
  seen: Array<{ method: string; headers: Record<string, string | string[] | undefined> }>;
}> {
  const seen: Array<{ method: string; headers: Record<string, string | string[] | undefined> }> = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const method = typeof body['method'] === 'string' ? body['method'] : '';
      seen.push({ method, headers: request.headers });
      const id = body['id'];

      if (id === undefined || id === null) {
        response.writeHead(202);
        response.end();
        return;
      }
      if (method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-e2e' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http' } },
          }),
        );
        return;
      }
      if (method === 'tools/list') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'remote_echo',
                  description: '远端回显',
                  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
                },
              ],
            },
          }),
        );
        return;
      }
      if (method === 'tools/call') {
        const params = (body['params'] ?? {}) as Record<string, unknown>;
        const args = (params['arguments'] ?? {}) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `http echo: ${String(args['text'])}` }] } }),
        );
        return;
      }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } }));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(address.port)}/mcp`, seen };
}

function withMcpServer(run: (ctx: Ctx) => Promise<void>) {
  return async (): Promise<void> => {
    const home = mkdtempSync(join(tmpdir(), 'alkaid-mcp-e2e-'));
    const config = { ...loadConfig(), home, dbPath: join(home, 'db.sqlite'), secretsPath: join(home, 'secrets.json') };
    const db = openDatabase(config.dbPath);
    migrate(db);
    const registry = createDefaultRegistry(db);
    const memory = new MemoryMaintainer({ db, config });
    const app = Fastify({ logger: false });
    registerMcpRoutes(app, { config, db, tools: registry, memory });

    const scriptPath = join(home, 'mcp-fake-server.mjs');
    writeFileSync(scriptPath, FAKE_SERVER_SOURCE, 'utf8');

    try {
      await run({ home, db, app, registry, scriptPath });
    } finally {
      // ★ 先收子进程再删临时目录：Windows 上进程没退干净会 EBUSY
      await disposeMcpManager(registry);
      await app.close();
      await memory.close();
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function stdioPayload(scriptPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: [scriptPath],
    ...overrides,
  };
}

function toolContext(mode: 'readonly' | 'workspace' | 'project' | 'workspace_project' | 'full' = 'full'): ToolContext {
  return {
    conversationId: 'c1',
    permissionMode: mode,
    roots: { readable: [], writable: [], anywhere: mode === 'full' },
    workspacePath: null,
    projectSharedDir: null,
    cwd: '.',
    tempDir: '.',
    signal: new AbortController().signal,
  };
}

async function createFakeServer(ctx: Ctx, overrides: Record<string, unknown> = {}): Promise<McpServerDto> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/mcp/servers',
    payload: stdioPayload(ctx.scriptPath, overrides),
  });
  assert.equal(response.statusCode, 201, `创建失败：${response.body}`);
  return response.json() as McpServerDto;
}

// ───────────────────────── 新增 / 列表 / 凭据 ─────────────────────────

test('★★ POST 新增 stdio 服务器：真连上、工具注册、只在完全权限档可见、凭据不回显', withMcpServer(async (ctx) => {
  const SECRET = 'sk-e2e-secret-token-42';
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/mcp/servers',
    payload: stdioPayload(ctx.scriptPath, { env: { FAKE_TOKEN: SECRET } }),
  });
  assert.equal(response.statusCode, 201);
  const dto = response.json() as McpServerDto;

  assert.equal(dto.status, 'ready', `连接应当成功：${dto.error ?? ''}`);
  assert.equal(dto.transport, 'stdio');
  assert.deepEqual(dto.envKeys, ['FAKE_TOKEN']);
  assert.deepEqual(dto.headerKeys, []);
  assert.ok(dto.toolNames.includes('mcp_fake_echo'), `工具没注册：${dto.toolNames.join(',')}`);

  // ★★ 凭据永不下发
  assert.equal(response.body.includes(SECRET), false, `响应体里泄漏了 token：${response.body}`);

  // 注册表里真的在
  assert.equal(ctx.registry.has('mcp_fake_echo'), true);
  const fullNames = ctx.registry.toProviderTools('full').map((tool) => tool.name);
  assert.ok(fullNames.includes('mcp_fake_echo'));

  // ★ 与插件一致：MCP 工具只在 full 档可见
  for (const mode of ['readonly', 'workspace', 'project', 'workspace_project'] as const) {
    const names = ctx.registry.toProviderTools(mode).map((tool) => tool.name);
    assert.equal(names.some((name) => name.startsWith('mcp_')), false, `${mode} 档不该看到 MCP 工具`);
  }
}));

test('GET 列表：列出服务器，且响应里没有任何凭据值', withMcpServer(async (ctx) => {
  const SECRET = 'sk-list-secret-77';
  await createFakeServer(ctx, { env: { FAKE_TOKEN: SECRET } });

  const response = await ctx.app.inject({ method: 'GET', url: '/api/mcp/servers' });
  assert.equal(response.statusCode, 200);
  const servers = response.json() as McpServerDto[];
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.name, 'fake');
  assert.deepEqual(servers[0]?.envKeys, ['FAKE_TOKEN']);
  assert.equal(response.body.includes(SECRET), false);
}));

// ───────────────────────── 校验 ─────────────────────────

test('校验：name 必填 / 唯一（409）、transport 必填字段匹配（400）', withMcpServer(async (ctx) => {
  const missingName = await ctx.app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { transport: 'stdio', command: 'node' } });
  assert.equal(missingName.statusCode, 400);
  assert.match((missingName.json() as { error: string }).error, /name/);

  await createFakeServer(ctx);

  const duplicate = await ctx.app.inject({ method: 'POST', url: '/api/mcp/servers', payload: stdioPayload(ctx.scriptPath) });
  assert.equal(duplicate.statusCode, 409);
  assert.match((duplicate.json() as { error: string }).error, /唯一/);

  const noCommand = await ctx.app.inject({
    method: 'POST',
    url: '/api/mcp/servers',
    payload: { name: 'no-command', transport: 'stdio' },
  });
  assert.equal(noCommand.statusCode, 400);
  assert.match((noCommand.json() as { error: string }).error, /command/);

  const noUrl = await ctx.app.inject({ method: 'POST', url: '/api/mcp/servers', payload: { name: 'no-url', transport: 'http' } });
  assert.equal(noUrl.statusCode, 400);
  assert.match((noUrl.json() as { error: string }).error, /url/);
}));

test('连接不上也返回 201 + status=error（配错一台服务器不该让整个请求 500）', withMcpServer(async (ctx) => {
  const SECRET = 'sk-broken-secret-9';
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/mcp/servers',
    payload: {
      name: 'broken',
      transport: 'stdio',
      command: join(ctx.home, 'definitely-missing-server.exe'),
      env: { TOKEN: SECRET },
    },
  });

  assert.equal(response.statusCode, 201);
  const dto = response.json() as McpServerDto;
  assert.equal(dto.status, 'error');
  assert.ok((dto.error ?? '').length > 0, '必须给出错误原因');
  assert.deepEqual(dto.toolNames, []);
  assert.equal(response.body.includes(SECRET), false, '错误消息里泄漏了凭据');
}));

// ───────────────────────── PATCH / KEEP_EXISTING ─────────────────────────

test('★★ PATCH：KEEP_EXISTING 保住原值（库里验证），响应里仍不含值', withMcpServer(async (ctx) => {
  const SECRET = 'sk-keep-secret-123';
  const created = await createFakeServer(ctx, { env: { API_TOKEN: SECRET, OTHER: 'v1' } });

  const response = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mcp/servers/${created.id}`,
    payload: { env: { API_TOKEN: KEEP_EXISTING, EXTRA: 'v2' } },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes(SECRET), false, 'PATCH 响应里泄漏了 token');

  // ★ 不看响应，直接查库
  const record = getMcpServer(ctx.db, created.id);
  assert.ok(record !== undefined);
  assert.equal(record.env['API_TOKEN'], SECRET, 'KEEP_EXISTING 没保住原值');
  assert.equal(record.env['EXTRA'], 'v2');
  assert.equal(record.env['OTHER'], undefined, '整表替换语义：没列出的键应当被删掉');

  // 工具还活着（连接参数没变，不该重启进程）
  assert.equal(ctx.registry.has('mcp_fake_echo'), true);
}));

test('PATCH 改名会重连并换掉工具名（旧的必须摘掉）', withMcpServer(async (ctx) => {
  const created = await createFakeServer(ctx);
  assert.equal(ctx.registry.has('mcp_fake_echo'), true);

  const response = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mcp/servers/${created.id}`,
    payload: { name: 'renamed' },
  });
  assert.equal(response.statusCode, 200);
  const dto = response.json() as McpServerDto;
  assert.equal(dto.name, 'renamed');
  assert.equal(dto.status, 'ready', dto.error ?? '');

  assert.equal(ctx.registry.has('mcp_fake_echo'), false, '旧名字的工具没被摘掉');
  assert.equal(ctx.registry.has('mcp_renamed_echo'), true, '新名字的工具没注册上');
}));

// ───────────────────────── 组模式批量 ─────────────────────────

test('★★★ 组模式批量：把该服务器当前全部工具写进 tool_settings', withMcpServer(async (ctx) => {
  const created = await createFakeServer(ctx);
  assert.ok(created.toolNames.length >= 3);
  assert.equal(toolModeMap(ctx.db).size, 0, '只是连接不该写三态配置');

  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/mcp/servers/${created.id}/mode`,
    payload: { mode: 'resident' },
  });
  assert.equal(response.statusCode, 200);
  const dto = response.json() as McpServerDto;
  assert.equal(dto.groupMode, 'resident');

  const modes = toolModeMap(ctx.db);
  for (const name of created.toolNames) {
    assert.equal(modes.get(name), 'resident', `${name} 没有被写进 tool_settings`);
  }

  // 非法模式要 400（不是静默成功）
  const bad = await ctx.app.inject({
    method: 'POST',
    url: `/api/mcp/servers/${created.id}/mode`,
    payload: { mode: 'sometimes' },
  });
  assert.equal(bad.statusCode, 400);
}));

test('★★★ 单工具既有覆盖不被组模式覆盖（并且目录里真的按覆盖生效）', withMcpServer(async (ctx) => {
  const created = await createFakeServer(ctx);

  // 用户先单独关掉一个危险工具
  setToolMode(ctx.db, 'mcp_fake_split', 'disabled', 'mcp');

  const resident = await ctx.app.inject({
    method: 'POST',
    url: `/api/mcp/servers/${created.id}/mode`,
    payload: { mode: 'resident' },
  });
  assert.equal(resident.statusCode, 200);

  const lazy = await ctx.app.inject({
    method: 'POST',
    url: `/api/mcp/servers/${created.id}/mode`,
    payload: { mode: 'lazy' },
  });
  assert.equal(lazy.statusCode, 200);

  const modes = toolModeMap(ctx.db);
  assert.equal(modes.get('mcp_fake_split'), 'disabled', '用户单独关掉的工具被批量动作覆盖了');
  assert.equal(modes.get('mcp_fake_echo'), 'lazy', '其余工具应当跟着整组变成按需');

  // ★ 不只看库：真正发给模型的那份工具表也要按覆盖来
  const surface = createSurface(ctx.registry, 'full', toolModeMap(ctx.db));
  assert.equal(surface.canCall('mcp_fake_split'), false, '被单独关掉的工具不该可调用');
  assert.equal(surface.canCall('mcp_fake_echo'), true);
  assert.equal(
    surface.tools.some((tool) => tool.name === 'mcp_fake_echo'),
    false,
    '按需工具不该带完整 schema 常驻',
  );
}));

// ───────────────────────── 工具调用 ─────────────────────────

test('★★ 工具调用：tools/call 的 content 拼成文本；失败要有可读回执', withMcpServer(async (ctx) => {
  await createFakeServer(ctx);

  const echo = await ctx.registry.execute('mcp_fake_echo', { text: '你好' }, toolContext());
  assert.equal(echo.ok, true);
  if (echo.ok) assert.equal(echo.content, 'echo: 你好');

  const split = await ctx.registry.execute('mcp_fake_split', {}, toolContext());
  assert.equal(split.ok, true);
  if (split.ok) assert.equal(split.content, '第一行\n第二行');

  // isError 的调用必须是失败（不能当成功文本喂给模型）
  const boom = await ctx.registry.execute('mcp_fake_boom', {}, toolContext());
  assert.equal(boom.ok, false);
  if (!boom.ok) {
    assert.equal(boom.code, 'mcp_error');
    assert.match(boom.message, /服务端说这次失败/);
  }

  // 低权限档：工具不可见 = 不存在（可见性即权限）
  const denied = await ctx.registry.execute('mcp_fake_echo', { text: 'x' }, toolContext('workspace'));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, 'tool_not_found');
}));

test('★ 工具名清洗：带空格/点号的服务器名与工具名注册后满足上游字符集', withMcpServer(async (ctx) => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/mcp/servers',
    payload: { name: 'weird name.server', transport: 'stdio', command: process.execPath, args: [ctx.scriptPath] },
  });
  assert.equal(response.statusCode, 201);
  const dto = response.json() as McpServerDto;
  assert.equal(dto.status, 'ready', dto.error ?? '');

  const expected = mcpToolName('weird name.server', 'weird.name/with:chars');
  assert.ok(dto.toolNames.includes(expected), `清洗后的名字不对：${dto.toolNames.join(',')}`);
  assert.match(expected, WIRE_NAME);
  assert.equal(ctx.registry.has(expected), true);

  for (const name of dto.toolNames) {
    assert.match(name, WIRE_NAME, `工具名 "${name}" 会让整轮请求 400`);
    assert.equal(name.includes('.'), false);
  }
}));

// ───────────────────────── http 传输 ─────────────────────────

test('★★ http 传输：真发起请求、带自定义 header、凭据不回显', withMcpServer(async (ctx) => {
  const SECRET = 'Bearer http-secret-e2e';
  const fake = await startHttpMcpServer();

  try {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'remote', transport: 'http', url: fake.url, headers: { authorization: SECRET } },
    });
    assert.equal(response.statusCode, 201);
    const dto = response.json() as McpServerDto;
    assert.equal(dto.status, 'ready', dto.error ?? '');
    assert.deepEqual(dto.headerKeys, ['authorization']);
    assert.equal(response.body.includes(SECRET), false, '响应体里泄漏了 header 的值');
    assert.ok(dto.toolNames.includes('mcp_remote_remote_echo'), `工具没注册：${dto.toolNames.join(',')}`);

    // 自定义 header 真的发出去了
    const initialized = fake.seen.find((entry) => entry.method === 'initialize');
    assert.ok(initialized !== undefined);
    assert.equal(initialized.headers['authorization'], SECRET);

    // 工具真能调用
    const outcome = await ctx.registry.execute('mcp_remote_remote_echo', { text: 'hi' }, toolContext());
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.content, 'http echo: hi');
  } finally {
    await closeServer(fake.server);
  }
}));

// ───────────────────────── 重连 / 删除 ─────────────────────────

test('reconnect：重新拉起并重新注册工具', withMcpServer(async (ctx) => {
  const created = await createFakeServer(ctx);

  const response = await ctx.app.inject({ method: 'POST', url: `/api/mcp/servers/${created.id}/reconnect` });
  assert.equal(response.statusCode, 200);
  const dto = response.json() as McpServerDto;
  assert.equal(dto.status, 'ready', dto.error ?? '');
  assert.ok(dto.toolNames.includes('mcp_fake_echo'));
  assert.equal(ctx.registry.has('mcp_fake_echo'), true);
}));

test('DELETE：删行 + 立刻把工具从注册表摘掉', withMcpServer(async (ctx) => {
  const created = await createFakeServer(ctx);
  assert.equal(ctx.registry.has('mcp_fake_echo'), true);

  const response = await ctx.app.inject({ method: 'DELETE', url: `/api/mcp/servers/${created.id}` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });

  assert.equal(ctx.registry.has('mcp_fake_echo'), false, '删除后工具还在注册表里');
  assert.equal(ctx.registry.has('mcp_fake_split'), false);

  // 重复删除是 404，不是"静默成功"
  const again = await ctx.app.inject({ method: 'DELETE', url: `/api/mcp/servers/${created.id}` });
  assert.equal(again.statusCode, 404);

  const listed = await ctx.app.inject({ method: 'GET', url: '/api/mcp/servers' });
  assert.equal((listed.json() as McpServerDto[]).length, 0);
}));

// ───────────────────────── 给模型的配置通道 ─────────────────────────

test('★★★ mcp_configure：upsert → mode → list → remove 全链路，且从不回显凭据', withMcpServer(async (ctx) => {
  const SECRET = 'sk-configure-secret-5';
  const tool = createMcpConfigureTool(ctx.db, ctx.registry);

  const upsert = await tool.execute(
    {
      action: 'upsert',
      name: 'configured',
      transport: 'stdio',
      command: process.execPath,
      args: [ctx.scriptPath],
      env: { API_TOKEN: SECRET },
      groupMode: 'lazy',
    },
    toolContext(),
  );
  assert.equal(upsert.ok, true, upsert.ok ? '' : upsert.message);
  if (upsert.ok) {
    assert.equal(upsert.content.includes(SECRET), false, 'mcp_configure 回显了 env 的值');
    assert.ok(upsert.content.includes('API_TOKEN'));
    assert.ok(upsert.content.includes('mcp_configured_echo'));
  }
  assert.equal(ctx.registry.has('mcp_configured_echo'), true);

  const list = await tool.execute({ action: 'list' }, toolContext());
  assert.equal(list.ok, true);
  if (list.ok) {
    assert.equal(list.content.includes(SECRET), false);
    assert.ok(list.content.includes('configured'));
  }

  const mode = await tool.execute({ action: 'mode', name: 'configured', mode: 'disabled' }, toolContext());
  assert.equal(mode.ok, true);
  for (const name of ['mcp_configured_echo', 'mcp_configured_split']) {
    assert.equal(toolModeMap(ctx.db).get(name), 'disabled', `${name} 没被批量设成关闭`);
  }

  const remove = await tool.execute({ action: 'remove', name: 'configured' }, toolContext());
  assert.equal(remove.ok, true);
  assert.equal(ctx.registry.has('mcp_configured_echo'), false);
  const remaining = await ctx.app.inject({ method: 'GET', url: '/api/mcp/servers' });
  assert.equal((remaining.json() as McpServerDto[]).length, 0, '移除后库里不该还有这一台');
}));

test('mcp_configure：找不到目标时给出可行动的提示', withMcpServer(async (ctx) => {
  const tool = createMcpConfigureTool(ctx.db, ctx.registry);
  const outcome = await tool.execute({ action: 'reconnect', name: 'nothing-here' }, toolContext());
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, 'mcp_not_found');
    assert.ok((outcome.hint ?? '').includes('MCP'), '提示里应当说明当前有没有配置');
  }
}));
