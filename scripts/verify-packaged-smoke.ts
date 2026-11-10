/**
 * **打包版真二进制冒烟**：在临时家上真启动 `YaoGuang.exe`，确认 v16 真的跑得起来。
 *
 * ★ 判据（全部来自真实 HTTP，不看源码）：
 * ① 起得来，schema = 16（程序真的从迁移清单推导，不是硬编码旧值）；
 * ② 新端点真的在：`/api/conversations/:id/delegations` 200；
 * ③ 子代理设置真的能读：`delegateAllowedModels` / `delegateAllowParentModel` 是默认值；
 * ④ 委派工具在工具表里（说明注册链路通了，不是"代码有了但没接上"）。
 *
 * ★ 全程临时家，绝不碰 `%APPDATA%\alkaid\data`。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const binary = join(root, 'release/YaoGuang-win32-x64/YaoGuang.exe');
const REAL_HOME = process.env['APPDATA'] === undefined ? null : join(process.env['APPDATA'], 'alkaid', 'data');
const realPath = REAL_HOME === null ? null : join(REAL_HOME, 'alkaid.db');
const realMtime = realPath !== null ? statSync(realPath).mtimeMs : null;

const home = mkdtempSync(join(tmpdir(), 'alkaid-smoke-v16-'));
mkdirSync(join(home, 'empty-plugins'));

const probe = createServer();
await new Promise((done) => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));

const child = spawn(binary, [join(root, 'src/main.ts')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ALKAID_HOME: home,
    ALKAID_PORT: String(port),
    ALKAID_PLUGINS: join(home, 'empty-plugins'),
  },
});

const url = `http://127.0.0.1:${port}`;
let health;
try {
  for (let i = 0; i < 300; i += 1) {
    if (child.exitCode !== null) throw new Error(`内核提前退出 code=${String(child.exitCode)}`);
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await delay(100);
  }
  assert.ok(health !== undefined, '打包版起不来');
  assert.equal(health.schemaVersion, 16, `打包版 schema 应为 16，实际 ${String(health.schemaVersion)}`);

  // ② 新端点
  const provider = await (
    await fetch(`${url}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '冒烟（不计费）',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'placeholder',
        defaultModel: 'offline',
      }),
    })
  ).json();
  const conversation = await (
    await fetch(`${url}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: provider.id, model: 'offline' }),
    })
  ).json();

  const boardRes = await fetch(`${url}/api/conversations/${conversation.id}/delegations`);
  assert.equal(boardRes.status, 200, '委派看板端点不在（说明路由没接上）');
  const board = await boardRes.json();
  assert.deepEqual(board.entries, []);

  // ③ 子代理设置
  const settings = await (await fetch(`${url}/api/settings`)).json();
  assert.equal(settings.general.delegateAllowedModels, null);
  assert.equal(settings.general.delegateAllowParentModel, true);

  // ④ 委派工具在表里
  const tools = await (await fetch(`${url}/api/tools`)).json();
  const names = JSON.stringify(tools);
  assert.ok(names.includes('delegate'), 'delegate 工具没注册进工具表');
  assert.ok(names.includes('team_tasks'), 'team_tasks 工具没注册进工具表');

  // ⑤ 能力广告里的信任姿态（B1/B3 也在这一版里）
  assert.equal(typeof health.trust, 'object');
  assert.equal(health.trust.bind, '127.0.0.1');
  assert.equal(health.trust.requireOrigin, false);

  console.log(
    JSON.stringify({
      smoke: 'pass',
      schemaVersion: health.schemaVersion,
      delegationBoard: 'ok',
      delegateSettings: settings.general.delegateAllowedModels === null ? 'unlimited(default)' : 'custom',
      toolsRegistered: { delegate: true, teamTasks: true },
      trust: health.trust,
    }),
  );
} finally {
  if (child.exitCode === null) {
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  }
  if (realPath !== null && realMtime !== null) {
    assert.equal(statSync(realPath).mtimeMs, realMtime, '用户真实库被改动了');
  }
  rmSync(home, { recursive: true, force: true });
}
