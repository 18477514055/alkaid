import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import { DESCRIBE_TOOL_NAME } from '../../src/core/tools/catalog.ts';
import { createSurface } from '../../src/core/tools/runtime.ts';
import { listToolViews, setToolMode, toolModeMap } from '../../src/core/tools/settings.ts';
import type { ToolContext, ToolMode } from '../../src/core/tools/types.ts';
import { buildServer } from '../../src/server/app.ts';

/**
 * 工具**管理面**的端到端测试（真实 HTTP + 真实库）。
 *
 * ★ 与 `test/e2e/fs-tools.test.ts` 的分工：
 *   那边测「工具被正确调用且不越权」，这里测「工具被管理」。
 *   两类必须分开 —— 混在一起会让人以为 116 条绿就代表了管理层可用。
 */

function withServer(run: (ctx: { home: string; db: ReturnType<typeof openDatabase>; app: ReturnType<typeof buildServer> }) => Promise<void>) {
  return async (): Promise<void> => {
    const home = mkdtempSync(join(tmpdir(), 'alkaid-tools-'));
    const config = { ...loadConfig(), home, dbPath: join(home, 'db.sqlite'), secretsPath: join(home, 'secrets.json') };
    const db = openDatabase(config.dbPath);
    migrate(db);
    const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db, tools: createDefaultRegistry(db) });
    try {
      await run({ home, db, app });
    } finally {
      await app.close();
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function ctx(mode: 'readonly' | 'workspace' | 'project' | 'workspace_project' | 'full', modes?: Map<string, ToolMode>): ToolContext {
  return {
    conversationId: 'c1',
    permissionMode: mode,
    // ★ Roots 的真实形状是 { readable, writable, anywhere }
    roots: { readable: [], writable: [], anywhere: mode === 'full' },
    workspacePath: null,
    projectSharedDir: null,
    cwd: '.',
    tempDir: 'C:\\tmp',
    signal: new AbortController().signal,
    ...(modes === undefined ? {} : { toolModes: modes }),
  };
}

// ───────────────────── GET /api/tools ─────────────────────

test('GET /api/tools：列出全部工具，带三态、默认值、来源与可见性', withServer(async ({ app }) => {
  const response = await app.inject({ method: 'GET', url: '/api/tools?mode=workspace' });
  assert.equal(response.statusCode, 200);

  const body = response.json() as {
    permissionMode: string;
    tools: Array<{ name: string; mode: string; defaultMode: string; available: boolean; source: string; visibleInMode: boolean }>;
    summary: { resident: number; lazy: number; disabled: number; toolTableChars: number };
  };

  assert.equal(body.permissionMode, 'workspace');
  assert.ok(body.tools.length >= 7, `工具数不对：${body.tools.length}`);

  // 每个工具都必须带完整元信息（设置页要靠它渲染）
  for (const tool of body.tools) {
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0);
    assert.ok(['resident', 'lazy', 'disabled'].includes(tool.mode), `非法三态：${tool.mode}`);
    assert.equal(tool.available, true);
    assert.ok(['builtin', 'plugin', 'mcp'].includes(tool.source));
  }

  // ★ 和 = 总数：三态是完备划分，不能有工具既不是常驻也不是按需也不是关闭
  assert.equal(body.summary.resident + body.summary.lazy + body.summary.disabled, body.tools.length);
  assert.ok(body.summary.toolTableChars > 0);
}));

test('★ GET /api/tools：readonly 档下 pwsh 标为不可见（权限挡的，不是被关的）', withServer(async ({ app }) => {
  const response = await app.inject({ method: 'GET', url: '/api/tools?mode=readonly' });
  const body = response.json() as { tools: Array<{ name: string; visibleInMode: boolean; mode: string }> };

  const pwsh = body.tools.find((tool) => tool.name === 'pwsh');
  assert.ok(pwsh !== undefined);
  assert.equal(pwsh.visibleInMode, false, 'readonly 档不该看见 pwsh');
  assert.notEqual(pwsh.mode, 'disabled', '不可见 ≠ 被关闭 —— 这两件事必须能区分开');
}));

// ───────────────────── PATCH /api/tools/:name ─────────────────────

test('★★ PATCH 改三态：落库并立刻回读验证', withServer(async ({ app, db }) => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/tools/glob',
    payload: { mode: 'lazy' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { ok: boolean; name: string; mode: string };
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'lazy');

  // ★ 从库里独立再读一次 —— 不能只信返回值
  assert.equal(toolModeMap(db).get('glob'), 'lazy');
}));

test('PATCH 非法三态被拒（不是静默成功）', withServer(async ({ app }) => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/tools/glob',
    payload: { mode: 'sometimes' },
  });
  assert.equal(response.statusCode, 400);
}));

test('★ PATCH 不存在的工具返回 404（静默成功是最难查的 bug）', withServer(async ({ app }) => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/tools/no-such-tool',
    payload: { mode: 'lazy' },
  });
  assert.equal(response.statusCode, 404);
}));

test('PATCH reset 回到代码默认，且提示默认值', withServer(async ({ app, db }) => {
  setToolMode(db, 'glob', 'disabled');
  assert.equal(toolModeMap(db).get('glob'), 'disabled');

  const response = await app.inject({ method: 'PATCH', url: '/api/tools/glob', payload: { reset: true } });
  assert.equal(response.statusCode, 200);
  assert.equal(toolModeMap(db).has('glob'), false, 'reset 后库里不该留下这一行');
}));

test('POST /api/tools/reset：一次清空全部配置', withServer(async ({ app, db }) => {
  setToolMode(db, 'glob', 'lazy');
  setToolMode(db, 'grep', 'disabled');
  assert.equal(toolModeMap(db).size, 2);

  const response = await app.inject({ method: 'POST', url: '/api/tools/reset' });
  assert.equal(response.statusCode, 200);
  assert.equal((response.json() as { cleared: number }).cleared, 2);
  assert.equal(toolModeMap(db).size, 0);
}));

// ───────────────── 配置真的影响发出去的工具表 ─────────────────

test('★★★ 把工具设为 lazy 之后，工具表真的变小（省 token 不是口头承诺）', withServer(async ({ db }) => {
  const registry = createDefaultRegistry(db);

  // 基线：全部常驻（这是"不做懒加载"的形态）
  const allResident = new Map<string, ToolMode>();
  for (const name of registry.list().map((tool) => tool.name)) allResident.set(name, 'resident');

  const before = createSurface(registry, 'workspace', allResident);
  const beforeChars = JSON.stringify(before.tools).length;

  // 改成：只留 read/pwsh 常驻，其余按需
  const after = new Map<string, ToolMode>();
  for (const name of registry.list().map((tool) => tool.name)) after.set(name, 'lazy');
  after.set('read', 'resident');
  after.set('pwsh', 'resident');

  const surface = createSurface(registry, 'workspace', after);
  const afterChars = JSON.stringify(surface.tools).length;

  assert.equal(surface.tools.some((tool) => tool.name === 'grep'), false, 'grep 不该再带完整 schema');
  assert.ok(afterChars < beforeChars, `工具表应当变小：${beforeChars} → ${afterChars}`);

  // ★ 目录必须在，否则模型不知道有这些工具
  const describe = surface.tools.find((tool) => tool.name === DESCRIBE_TOOL_NAME);
  assert.ok(describe !== undefined, '有按需工具时必须有 describe_tool');
  assert.ok(describe.description.includes('grep'));
  assert.ok(describe.description.includes('glob'));
}));

test('★★ 关掉工具后：它既不出现，也调不动（并且理由是"被关闭"）', withServer(async ({ db }) => {
  const registry = createDefaultRegistry(db);
  const modes = new Map<string, ToolMode>([['glob', 'disabled']]);
  const surface = createSurface(registry, 'workspace', modes);

  assert.equal(surface.tools.some((tool) => tool.name === 'glob'), false);
  assert.equal(surface.canCall('glob'), false);

  const outcome = await surface.execute('glob', { pattern: '**/*.ts' }, ctx('workspace', modes));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'tool_disabled');
}));

// ───────────────── describe_tool 的真实闭环 ─────────────────

test('★★★ 懒加载闭环：目录 → describe_tool 召回 → 拿到的工具真能调用', withServer(async ({ home, db }) => {
  const registry = createDefaultRegistry(db);
  const modes = new Map<string, ToolMode>([['glob', 'lazy']]);
  const surface = createSurface(registry, 'workspace', modes);

  // ★ 授权根必须真的包含 home —— 否则 glob 会被围栏拒掉（那是对的，不是 bug）。
  //   这里要验的是"召回后能不能调"，不是"围栏会不会拦"，所以把 home 给它。
  const workspaceCtx = { ...ctx('workspace', modes), workspacePath: home, roots: { readable: [home], writable: [home], anywhere: false }, cwd: home };

  // ① 目录里有它，但没有完整 schema
  const describeSpec = surface.tools.find((tool) => tool.name === DESCRIBE_TOOL_NAME);
  assert.ok(describeSpec !== undefined);
  assert.ok(describeSpec.description.includes('glob'));
  assert.equal(surface.tools.some((tool) => tool.name === 'glob'), false);

  // ② 召回它
  const recalled = await surface.execute(DESCRIBE_TOOL_NAME, { names: ['glob'] }, workspaceCtx);
  assert.equal(recalled.ok, true);
  if (recalled.ok) {
    assert.ok(recalled.content.includes('Tool: glob'));
    // ★ 必须给出完整参数表，而不是"你可以调了"
    assert.ok(recalled.content.includes('pattern'));
  }

  // ③ ★★★ 最关键的一步：召回成功后必须**真的能调用**。
  //    只放行常驻的话，这里会拿到 tool_disabled / tool_not_found —— 机制就是死的。
  const executed = await surface.execute('glob', { pattern: '*.sqlite' }, workspaceCtx);
  assert.equal(executed.ok, true, `召回后应当可调用，实际：${JSON.stringify(executed)}`);
  if (executed.ok) assert.ok(executed.content.includes('db.sqlite'), `应当找到 db.sqlite：${executed.content}`);
}));

test('describe_tool 支持一次要多个（省往返）', withServer(async ({ db }) => {
  const registry = createDefaultRegistry(db);
  const modes = new Map<string, ToolMode>([
    ['glob', 'lazy'],
    ['grep', 'lazy'],
  ]);
  const surface = createSurface(registry, 'workspace', modes);

  const recalled = await surface.execute(DESCRIBE_TOOL_NAME, { names: ['glob', 'grep'] }, ctx('workspace', modes));
  assert.equal(recalled.ok, true);
  if (recalled.ok) {
    assert.ok(recalled.content.includes('Tool: glob'));
    assert.ok(recalled.content.includes('Tool: grep'));
  }
}));

test('describe_tool 支持自然语言 query（不知道名字时的出路）', withServer(async ({ db }) => {
  const registry = createDefaultRegistry(db);
  const modes = new Map<string, ToolMode>([
    ['glob', 'lazy'],
    ['grep', 'lazy'],
    ['recall', 'lazy'],
  ]);
  const surface = createSurface(registry, 'workspace', modes);

  const recalled = await surface.execute(DESCRIBE_TOOL_NAME, { query: 'search file contents by regex' }, ctx('workspace', modes));
  assert.equal(recalled.ok, true);
  if (recalled.ok) assert.ok(recalled.content.includes('Tool: grep'), `没检索到 grep：${recalled.content.slice(0, 200)}`);
}));

test('★ describe_tool 要不到东西时，报错里带可用清单（自纠路径）', withServer(async ({ db }) => {
  const registry = createDefaultRegistry(db);
  const modes = new Map<string, ToolMode>([['glob', 'lazy']]);
  const surface = createSurface(registry, 'workspace', modes);

  const empty = await surface.execute(DESCRIBE_TOOL_NAME, {}, ctx('workspace', modes));
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.code, 'describe_nothing_requested');
    assert.ok(empty.hint !== undefined && empty.hint.includes('glob'), '提示里必须列出可展开的工具');
  }

  const wrong = await surface.execute(DESCRIBE_TOOL_NAME, { names: ['nope'] }, ctx('workspace', modes));
  assert.equal(wrong.ok, false);
  if (!wrong.ok) {
    assert.equal(wrong.code, 'describe_not_found');
    assert.ok(wrong.hint !== undefined && wrong.hint.includes('glob'));
  }
}));

test('没有按需工具时：describe_tool 根本不存在（不占缓存前缀）', withServer(async ({ db }) => {
  const registry = createDefaultRegistry(db);

  // ★ 默认配置里 glob/grep/recall 本来就是按需的，所以这里必须**显式全部设为常驻**，
  //   才是"没有按需工具"那个场景。不设的话测的是另一件事。
  const modes = new Map<string, ToolMode>();
  for (const name of registry.list().map((tool) => tool.name)) modes.set(name, 'resident');

  const surface = createSurface(registry, 'workspace', modes);
  assert.equal(surface.catalog.lazy.length, 0, '前置条件：必须真的没有按需工具');
  assert.equal(surface.tools.some((tool) => tool.name === DESCRIBE_TOOL_NAME), false);

  const outcome = await surface.execute(DESCRIBE_TOOL_NAME, { names: ['glob'] }, ctx('workspace', modes));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'tool_not_found');
}));

// ───────────────── 设置持久化的边界 ─────────────────

test('★ 配置行在工具消失后仍保留（插件卸载后用户的选择不该被静默遗忘）', withServer(async ({ db }) => {
  setToolMode(db, 'p.gone.tool', 'disabled', 'plugin');

  const registry = createDefaultRegistry(db);
  const views = listToolViews(db, registry, 'full');
  const ghost = views.find((view) => view.name === 'p.gone.tool');

  assert.ok(ghost !== undefined, '库里有配置、注册表里没有的工具也必须列出来');
  assert.equal(ghost.available, false);
  assert.equal(ghost.source, 'plugin');
  assert.equal(ghost.mode, 'disabled');
}));

test('没配置过的工具不写库（默认值来自代码，不冻结成用户选择）', withServer(async ({ db }) => {
  const registry = createDefaultRegistry(db);
  const views = listToolViews(db, registry, 'workspace');

  assert.ok(views.length > 0);
  assert.equal(toolModeMap(db).size, 0, '只是查看设置不该写库');
  for (const view of views) {
    assert.equal(view.mode, view.defaultMode, '没配置过时 mode 必须等于代码默认');
  }
}));
