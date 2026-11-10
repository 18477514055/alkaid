import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { mcpToolName } from '../../src/shared/mcp.ts';
import {
  MCP_PROTOCOL_VERSION,
  McpTimeoutError,
  connectMcpServer,
  redactSecrets,
  type McpConnection,
} from '../../src/core/mcp/client.ts';

/**
 * MCP 客户端的两条传输（stdio / http）都要**真跑**，不 mock。
 *
 * ★ 三条纪律（本文件就是它们的守门员）：
 * 1. stdio 必须真的起子进程，走完 `initialize` → `notifications/initialized` → `tools/list`。
 * 2. 进程退出 / 请求超时都必须**明确报错**，不能静默挂住。
 * 3. 凭据值绝不能出现在错误消息里（`env` / `headers` 的值就是 token）。
 */

const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 一个极小的假 MCP 服务器（stdio，newline-delimited JSON-RPC 2.0）。
 * 刻意做了三件"真实服务器会做的事"：
 * - 往 stdout 打一行**非 JSON 日志**（很多实现都这么干，客户端必须忽略它）
 * - 返回一个**名字带非法字符**的工具（验证清洗规则）
 * - 提供一个 `isError: true` 的工具（验证失败路径）
 */
const FAKE_STDIO_SERVER = String.raw`
let buffer = '';
const send = (message) => { process.stdout.write(JSON.stringify(message) + '\n'); };
process.stdout.write('fake mcp server booting (this line is NOT json)\n');
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
        serverInfo: { name: 'fake-stdio', version: '1.0.0' },
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
          { type: 'image', mimeType: 'image/png', data: 'AA==' },
        ] } });
      } else if (name === 'boom') {
        send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: '工具执行失败的原因' }] } });
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool: ' + String(name) } });
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const EXITING_SERVER = 'process.exit(3);';
const SILENT_SERVER = String.raw`
process.stdin.on('data', () => { /* 永远不回包：模拟一个卡住的服务器 */ });
setInterval(() => {}, 1000);
`;

function stdioArgs(script: string): string[] {
  return ['-e', script];
}

/** 起一个本地假 MCP HTTP 服务器（不连外网、不花钱）。 */
async function startFakeHttpServer(): Promise<{ server: Server; url: string; base: string; seen: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> }> {
  const seen: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];

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
      seen.push({ headers: request.headers, body });

      const method = typeof body['method'] === 'string' ? body['method'] : '';
      const id = body['id'];
      const isNotification = id === undefined || id === null;

      if (isNotification) {
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end();
        return;
      }

      if (method === 'initialize') {
        response.writeHead(200, {
          'content-type': 'application/json',
          // 会话 id：后续请求必须带上（streamable-http 的要求，客户端要支持）
          'mcp-session-id': 'sess-1',
        });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'fake-http' } },
          }),
        );
        return;
      }

      // 故意用 SSE 回 tools/list：真实服务器经常这么干
      if (method === 'tools/list') {
        const payload = JSON.stringify({
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
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`event: message\ndata: ${payload}\n\n`);
        return;
      }

      if (method === 'tools/call') {
        const params = (body['params'] ?? {}) as Record<string, unknown>;
        const args = (params['arguments'] ?? {}) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `http echo: ${String(args['text'])}` }] },
          }),
        );
        return;
      }

      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } }));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(address.port)}`;
  return { server, url: `${base}/mcp`, base, seen };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

// ────────────────────────────── stdio ──────────────────────────────

test('stdio：真起子进程完成 initialize + tools/list，且忽略 stdout 上的非 JSON 日志', async () => {
  const connection = await connectMcpServer({
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: stdioArgs(FAKE_STDIO_SERVER),
  });

  try {
    const tools = await connection.listTools();
    assert.equal(tools.length, 4, `应当拿到 4 个工具，实际：${tools.map((tool) => tool.name).join(',')}`);
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('echo'));
    assert.ok(names.includes('weird.name/with:chars'), '带非法字符的原始工具名应当原样保留');
    const echo = tools.find((tool) => tool.name === 'echo');
    assert.ok(echo !== undefined);
    assert.equal(echo.description, '回显给定文本');
    // 参数表原样透传（注册进注册表时要当 parameters 用）
    assert.equal(echo.inputSchema['type'], 'object');
  } finally {
    await connection.close();
  }
});

test('stdio：tools/call 的 content 数组拼成文本（多块 + 图片留痕迹）', async () => {
  const connection = await connectMcpServer({
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: stdioArgs(FAKE_STDIO_SERVER),
  });

  try {
    assert.equal(await connection.callTool('echo', { text: '你好' }), 'echo: 你好');

    const text = await connection.callTool('split', {});
    assert.equal(text, '第一行\n第二行\n[image image/png 未展开]');
  } finally {
    await connection.close();
  }
});

test('stdio：isError 的结果必须变成错误（不能当成功文本喂给模型）', async () => {
  const connection = await connectMcpServer({
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: stdioArgs(FAKE_STDIO_SERVER),
  });

  try {
    await assert.rejects(() => connection.callTool('boom', {}), /工具执行失败的原因/);
    await assert.rejects(() => connection.callTool('no-such-tool', {}), /Unknown tool/);
  } finally {
    await connection.close();
  }
});

test('★ 工具名清洗后必须匹配 ^[a-zA-Z0-9_-]{1,64}$（带点号会让整轮请求 400）', () => {
  const cleaned = mcpToolName('weird name.server', 'weird.name/with:chars');
  assert.match(cleaned, WIRE_NAME);
  assert.equal(cleaned.includes('.'), false, `工具名里不该有点号：${cleaned}`);
  assert.ok(cleaned.startsWith('mcp_'));
  // 超长也要被截到 64
  const long = mcpToolName('server'.repeat(20), 'tool'.repeat(20));
  assert.ok(long.length <= 64, `长度必须 ≤ 64，实际 ${String(long.length)}`);
  assert.match(long, WIRE_NAME);
});

test('★ 进程退出必须明确报错（不能静默挂住）', async () => {
  await assert.rejects(
    () =>
      connectMcpServer({
        name: 'dies',
        transport: 'stdio',
        command: process.execPath,
        args: stdioArgs(EXITING_SERVER),
        timeoutMs: 10_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /退出/);
      assert.match(error.message, /code=3/);
      return true;
    },
  );
});

test('★ 请求超时要报 McpTimeoutError，并把子进程收掉', async () => {
  await assert.rejects(
    () =>
      connectMcpServer({
        name: 'silent',
        transport: 'stdio',
        command: process.execPath,
        args: stdioArgs(SILENT_SERVER),
        timeoutMs: 400,
      }),
    (error: unknown) => {
      assert.ok(error instanceof McpTimeoutError, `应当是 McpTimeoutError，实际：${String(error)}`);
      assert.match(error.message, /超时/);
      return true;
    },
  );
});

test('★ 凭据值不会出现在错误消息里（stderr 回显也必须被抹掉）', async () => {
  const SECRET = 'sk-super-secret-token-12345';
  const noisy = String.raw`
console.error('boot failed, env token = ' + (process.env.FAKE_TOKEN || 'no-env'));
process.exit(7);
`;
  await assert.rejects(
    () =>
      connectMcpServer({
        name: 'noisy',
        transport: 'stdio',
        command: process.execPath,
        args: stdioArgs(noisy),
        env: { FAKE_TOKEN: SECRET },
        timeoutMs: 10_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(SECRET), false, `错误消息里泄漏了 token：${error.message}`);
      assert.match(error.message, /\*\*\*/);
      return true;
    },
  );

  // 纯函数层面再钉一次
  assert.equal(redactSecrets(`token=${SECRET}`, [SECRET]).includes(SECRET), false);
});

// ────────────────────────────── http ──────────────────────────────

test('http：JSON 响应能走通（initialize + tools/list + tools/call + 会话头）', async () => {
  const fake = await startFakeHttpServer();
  let connection: McpConnection | null = null;

  try {
    connection = await connectMcpServer({
      name: 'remote',
      transport: 'http',
      url: fake.url,
      headers: { authorization: 'Bearer http-token-abcdef' },
      timeoutMs: 10_000,
    });

    // ★ 工具列表走的是 SSE 响应（真实服务器常见的形态）
    const tools = await connection.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, 'remote_echo');

    assert.equal(await connection.callTool('remote_echo', { text: 'hi' }), 'http echo: hi');

    // ① 自定义 header 真的发出去了 ② Accept 同时声明两种响应 ③ 会话 id 被回带
    const init = fake.seen.find((entry) => entry.body['method'] === 'initialize');
    assert.ok(init !== undefined);
    assert.equal(init.headers['authorization'], 'Bearer http-token-abcdef');
    assert.match(String(init.headers['accept']), /application\/json/);
    assert.match(String(init.headers['accept']), /text\/event-stream/);

    const list = fake.seen.find((entry) => entry.body['method'] === 'tools/list');
    assert.ok(list !== undefined);
    assert.equal(list.headers['mcp-session-id'], 'sess-1', '后续请求必须带上服务器给的会话 id');

    // 初始化后紧接着的 notifications/initialized（协议要求）
    const notified = fake.seen.find((entry) => entry.body['method'] === 'notifications/initialized');
    assert.ok(notified !== undefined);
  } finally {
    if (connection !== null) await connection.close();
    await closeServer(fake.server);
  }
});

test('http：连不上时错误消息里不能带 headers 里的 token', async () => {
  const SECRET = 'bearer-secret-token-xyz';
  // 127.0.0.1:1 基本不会有人监听
  await assert.rejects(
    () =>
      connectMcpServer({
        name: 'dead',
        transport: 'http',
        url: 'http://127.0.0.1:1/mcp',
        headers: { authorization: `Bearer ${SECRET}` },
        timeoutMs: 2_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(SECRET), false, `错误消息里泄漏了 token：${error.message}`);
      return true;
    },
  );
});
