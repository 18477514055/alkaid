import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { KEEP_EXISTING, mcpToolName } from '../../src/shared/mcp.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import {
  McpValidationError,
  createMcpConfigureTool,
  deleteMcpServer,
  getMcpServer,
  insertMcpServer,
  listMcpServers,
  mergeSecretMap,
  sameConnection,
  setMcpServerGroupMode,
  toMcpServerDto,
  updateMcpServer,
} from '../../src/core/mcp/store.ts';
import { ToolRegistry, type ToolContext } from '../../src/core/tools/types.ts';

/**
 * `mcp_servers` 的读写与凭据规则（纯库操作，不起任何进程）。
 *
 * ★ 本文件的重点不是 CRUD，而是**凭据边界**：
 *   DTO 里只有键名；PATCH 用 `KEEP_EXISTING` 保留；错误消息不回显值。
 */

const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function withDb(run: (db: DatabaseSync) => Promise<void> | void) {
  return async (): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'alkaid-mcp-store-'));
    const db = openDatabase(join(dir, 'test.db'));
    migrate(db);
    try {
      await run(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function ctx(): ToolContext {
  return {
    conversationId: 'c1',
    permissionMode: 'full',
    roots: { readable: [], writable: [], anywhere: true },
    workspacePath: null,
    projectSharedDir: null,
    cwd: '.',
    tempDir: '.',
    signal: new AbortController().signal,
  };
}

// ────────────────────────────── 校验 ──────────────────────────────

test('name 必填：空 / 纯空白 / 非字符串都是 400', withDb((db) => {
  for (const name of ['', '   ', undefined, 42]) {
    assert.throws(
      () => insertMcpServer(db, { name, transport: 'stdio', command: 'node' }),
      (error: unknown) => {
        assert.ok(error instanceof McpValidationError, `应当是 McpValidationError：${String(error)}`);
        assert.equal(error.status, 400);
        assert.match(error.message, /name/);
        return true;
      },
    );
  }
}));

test('name 唯一：重名 409，大小写不同也算重名', withDb((db) => {
  insertMcpServer(db, { name: 'filesystem', transport: 'stdio', command: 'node' });

  assert.throws(
    () => insertMcpServer(db, { name: 'filesystem', transport: 'stdio', command: 'node' }),
    (error: unknown) => {
      assert.ok(error instanceof McpValidationError);
      assert.equal(error.status, 409);
      assert.match(error.message, /必须唯一/);
      return true;
    },
  );

  // 大小写不同：界面上会像两台"同名"的服务器，直接挡住
  assert.throws(() => insertMcpServer(db, { name: 'FileSystem', transport: 'stdio', command: 'node' }), /必须唯一/);
}));

test('transport 与必填字段必须匹配，且错误消息能指导修正', withDb((db) => {
  assert.throws(
    () => insertMcpServer(db, { name: 's1', transport: 'stdio' }),
    (error: unknown) => {
      assert.ok(error instanceof McpValidationError);
      assert.match(error.message, /command/);
      assert.match(error.message, /transport=http/); // 给出另一条出路
      return true;
    },
  );

  assert.throws(
    () => insertMcpServer(db, { name: 's2', transport: 'http' }),
    (error: unknown) => {
      assert.ok(error instanceof McpValidationError);
      assert.match(error.message, /url/);
      assert.match(error.message, /transport=stdio/);
      return true;
    },
  );

  assert.throws(() => insertMcpServer(db, { name: 's3', transport: 'http', url: 'not-a-url' }), /url 不是合法地址/);
  assert.throws(() => insertMcpServer(db, { name: 's4', transport: 'http', url: 'ftp://x/y' }), /http:\/\/ 或 https:\/\//);
  assert.throws(() => insertMcpServer(db, { name: 's5', transport: 'carrier-pigeon', command: 'x' }), /transport/);
}));

test('groupMode / enabled / args 的类型校验收紧（不是静默忽略）', withDb((db) => {
  assert.throws(() => insertMcpServer(db, { name: 'g1', transport: 'stdio', command: 'n', groupMode: 'sometimes' }), /groupMode/);
  assert.throws(() => insertMcpServer(db, { name: 'g2', transport: 'stdio', command: 'n', enabled: 'yes' }), /enabled/);
  assert.throws(() => insertMcpServer(db, { name: 'g3', transport: 'stdio', command: 'n', args: 'a b c' }), /args/);
  assert.throws(() => insertMcpServer(db, { name: 'g4', transport: 'stdio', command: 'n', args: [1] }), /args\[0\]/);
}));

// ────────────────────────────── 凭据 ──────────────────────────────

test('★★ DTO 里永远只有键名，绝不含 env / headers 的值', withDb((db) => {
  const token = 'sk-live-super-secret-value-42';
  const header = 'Bearer another-secret-value-99';
  const record = insertMcpServer(db, {
    name: 'secure',
    transport: 'stdio',
    command: 'node',
    env: { API_TOKEN: token, LOG_LEVEL: 'info' },
    headers: { authorization: header },
  });

  const dto = toMcpServerDto(record, { status: 'ready', error: null, toolNames: ['mcp_secure_echo'] });
  const serialized = JSON.stringify(dto);

  assert.deepEqual(dto.envKeys, ['API_TOKEN', 'LOG_LEVEL']);
  assert.deepEqual(dto.headerKeys, ['authorization']);
  assert.equal(serialized.includes(token), false, `DTO 里出现了 env 的值：${serialized}`);
  assert.equal(serialized.includes(header), false, `DTO 里出现了 header 的值：${serialized}`);
  /**
   * 连"值有多长"这类形状也不给。
   *
   * ★★ 这一条原来是 `serialized.includes(String(token.length))` —— 即拿 `"29"` 去
   *   grep 整个 DTO JSON。**那是个假断言而且会偶发红**：DTO 里有随机 UUID 和
   *   毫秒时间戳，实测（本机 20000 次采样）单次命中率 **17.1%** ⇒ 大约每 6 次跑
   *   就有 1 次失败，而它跟"token 泄漏"一点关系都没有。
   *   这类测试比没有测试更糟：它训练人无视红。
   *
   * ⇒ 判据改成**钉住形状本身**：泄漏长度的正确做法是"值不出现"，而"长度不出现"
   *   这件事只能对**确定属于凭据的那一段**断言 —— 这里用 `API_TOKEN` 这个键名
   *   周围的内容（`"API_TOKEN":"`）作锚点，UUID/时间戳不可能与它同形。
   *   再补一条：键名的**值位**必须是占位，不能是任何看起来像凭据的串。
   */
  assert.equal(serialized.includes('"API_TOKEN":"'), false, `DTO 里出现了 env 的键值对：${serialized}`);
  assert.equal(serialized.includes('"authorization":"'), false, `DTO 里出现了 header 的键值对：${serialized}`);
  // 键名本身必须在（否则上面两条会因为"键根本不在"而假绿）
  assert.equal(serialized.includes('API_TOKEN'), true);
  assert.equal(serialized.includes('authorization'), true);
}));

test('★★ KEEP_EXISTING 保留原值；{} 清空；整个字段不传则不动', withDb((db) => {
  const token = 'keep-me-please-777';
  const created = insertMcpServer(db, {
    name: 'keeper',
    transport: 'stdio',
    command: 'node',
    env: { API_TOKEN: token, OTHER: 'v1' },
  });
  assert.equal(created.env['API_TOKEN'], token);

  // ① 值传 KEEP_EXISTING ⇒ 保留原值（同时可以新增另一个键）
  const kept = updateMcpServer(db, created.id, { env: { API_TOKEN: KEEP_EXISTING, EXTRA: 'v2' } });
  assert.equal(kept.env['API_TOKEN'], token, 'KEEP_EXISTING 没有保住原值');
  assert.equal(kept.env['EXTRA'], 'v2');
  // ★ 整张表替换语义：没列出的键被删掉（OTHER 不在入参里）
  assert.equal(kept.env['OTHER'], undefined);

  // ② 整块传 {} ⇒ 清空
  const cleared = updateMcpServer(db, created.id, { env: {} });
  assert.deepEqual(cleared.env, {});

  // ③ 整个字段不传 ⇒ 保持现状
  const untouched = updateMcpServer(db, created.id, { cwd: '/tmp' });
  assert.deepEqual(untouched.env, {});

  // ④ 原来没有这个键时，KEEP_EXISTING 被忽略（不会存进一个字面量占位符）
  const readded = updateMcpServer(db, created.id, { env: { ONLY_KEEP: KEEP_EXISTING } });
  assert.equal(readded.env['ONLY_KEEP'], undefined);
  assert.equal(JSON.stringify(readded.env).includes(KEEP_EXISTING), false);
}));

test('库里的 env / headers / args 存 JSON 文本（与 schema v13 的列类型一致）', withDb((db) => {
  const record = insertMcpServer(db, {
    name: 'raw',
    transport: 'stdio',
    command: 'node',
    args: ['server.js', '--stdio'],
    env: { A: '1' },
    headers: { B: '2' },
  });

  const row = db.prepare('SELECT args, env, headers FROM mcp_servers WHERE id = ?').get(record.id) as {
    args: string;
    env: string;
    headers: string;
  };
  assert.deepEqual(JSON.parse(row.args), ['server.js', '--stdio']);
  assert.deepEqual(JSON.parse(row.env), { A: '1' });
  assert.deepEqual(JSON.parse(row.headers), { B: '2' });
}));

test('mergeSecretMap：值可以是空字符串（那是"清掉这一项的值"，不是"保留"）', () => {
  assert.deepEqual(mergeSecretMap({ A: 'secret-a' }, { A: '' }, 'env'), { A: '' });
  assert.deepEqual(mergeSecretMap({ A: 'secret-a' }, { A: KEEP_EXISTING }, 'env'), { A: 'secret-a' });
  assert.deepEqual(mergeSecretMap({ A: 'x' }, undefined, 'env'), { A: 'x' });
  // 错误消息里不回显值
  assert.throws(
    () => mergeSecretMap({}, { A: 12345 }, 'env'),
    (error: unknown) => {
      assert.ok(error instanceof McpValidationError);
      assert.equal(error.message.includes('12345'), false, '校验错误里泄漏了值');
      assert.match(error.message, /字符串/);
      return true;
    },
  );
});

// ────────────────────────────── 工具名 ──────────────────────────────

test('★★ mcpToolName 清洗后一定匹配 ^[a-zA-Z0-9_-]{1,64}$', () => {
  const cases: Array<[string, string]> = [
    ['filesystem', 'read_file'],
    ['中文服务器', '读文件'],
    ['weird name.with:dots', 'a.b/c:d'],
    ['x'.repeat(80), 'y'.repeat(80)],
  ];
  for (const [server, tool] of cases) {
    const name = mcpToolName(server, tool);
    assert.match(name, WIRE_NAME, `工具名不合法：${name}`);
    assert.ok(name.length <= 64);
    assert.ok(name.startsWith('mcp_'));
  }
  // 同一对输入必须稳定（工具名变化会让 prompt cache 整段失效）
  assert.equal(mcpToolName('a', 'b'), mcpToolName('a', 'b'));
});

// ────────────────────────────── CRUD / 定位 ──────────────────────────────

test('round-trip：写入后回读的每个字段都对得上；更新不存在的 id 是 404', withDb((db) => {
  const created = insertMcpServer(db, {
    name: 'roundtrip',
    transport: 'stdio',
    command: 'node',
    args: ['a.js'],
    cwd: '/work',
    env: { K: 'v' },
    enabled: false,
    groupMode: 'resident',
  });

  const read = getMcpServer(db, created.id);
  assert.ok(read !== undefined);
  assert.equal(read.name, 'roundtrip');
  assert.equal(read.transport, 'stdio');
  assert.equal(read.command, 'node');
  assert.deepEqual(read.args, ['a.js']);
  assert.equal(read.cwd, '/work');
  assert.deepEqual(read.env, { K: 'v' });
  assert.equal(read.enabled, false);
  assert.equal(read.groupMode, 'resident');

  assert.throws(() => updateMcpServer(db, 'nope', { name: 'x' }), (error: unknown) => {
    assert.ok(error instanceof McpValidationError);
    assert.equal(error.status, 404);
    return true;
  });

  // 删除：存在返回 true，重复删除返回 false（调用方据此回 404）
  assert.equal(deleteMcpServer(db, created.id), true);
  assert.equal(deleteMcpServer(db, created.id), false);
  assert.equal(listMcpServers(db).length, 0);
}));

test('组模式落库 + 非法模式被拒；sameConnection 能识别连接参数变化', withDb((db) => {
  const created = insertMcpServer(db, { name: 'mode', transport: 'stdio', command: 'node' });
  assert.equal(created.groupMode, 'lazy', '默认按需');

  const resident = setMcpServerGroupMode(db, created.id, 'resident');
  assert.equal(resident.groupMode, 'resident');
  assert.equal(getMcpServer(db, created.id)?.groupMode, 'resident');

  assert.throws(() => setMcpServerGroupMode(db, created.id, 'sometimes' as never), /mode/);

  assert.equal(sameConnection(created, resident), true, '只改模式不算连接参数变化');

  const renamed = updateMcpServer(db, created.id, { name: 'mode-2' });
  assert.equal(sameConnection(created, renamed), false, '改了名字必须重连（工具名会跟着变）');

  const envChanged = updateMcpServer(db, created.id, { env: { TOKEN: 'abc' } });
  assert.equal(sameConnection(renamed, envChanged), false, '改了凭据必须重连');

  const enabledChanged = updateMcpServer(db, created.id, { enabled: false });
  assert.equal(sameConnection(envChanged, enabledChanged), true, '启停不算连接参数（由路由单独判断）');
}));

// ────────────────────────────── 给模型的配置通道 ──────────────────────────────

test('★★ mcp_configure：全权限、内置来源，且 list 不回显任何凭据值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-mcp-configure-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const registry = new ToolRegistry();

  try {
    const token = 'tool-secret-token-abc';
    const created = insertMcpServer(db, {
      name: 'listed',
      transport: 'stdio',
      command: 'node',
      env: { API_TOKEN: token },
      headers: { authorization: 'Bearer header-secret-xyz' },
      enabled: false, // 不连接，纯看输出
    });

    const tool = createMcpConfigureTool(db, registry);
    assert.equal(tool.name, 'mcp_configure');
    assert.equal(tool.source, 'builtin');
    assert.deepEqual([...(tool.modes ?? [])], ['full'], '配置 MCP 等于决定跑什么进程，只在完全权限档可见');
    assert.equal(tool.group, 'setup');
    assert.equal(tool.preferredMode, 'lazy');

    const outcome = await tool.execute({ action: 'list' }, ctx());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.content.includes(token), false, 'mcp_configure list 泄漏了 env 的值');
    assert.equal(outcome.content.includes('header-secret-xyz'), false, 'mcp_configure list 泄漏了 header 的值');
    assert.ok(outcome.content.includes('API_TOKEN'), '应当给出键名');
    assert.ok(outcome.content.includes(created.id));

    // 非法动作：给出可行动的清单
    const bad = await tool.execute({ action: 'destroy-everything' }, ctx());
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.message, /list/);
  } finally {
    registry.list();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
