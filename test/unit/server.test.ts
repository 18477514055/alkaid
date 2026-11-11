import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { SCHEMA_VERSION, migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

async function withServer(
  run: (ctx: { app: ReturnType<typeof buildServer>; home: string }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-server-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);

  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });
  try {
    await run({ app, home });
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test('GET /api/healthz 返回 ok 与真实库结构版本', async () => {
  await withServer(async ({ app, home }) => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    assert.equal(res.statusCode, 200);

    const body = res.json() as { ok: boolean; schemaVersion: number; home: string; app: string };
    assert.equal(body.ok, true);
    assert.equal(body.app, 'alkaid');
    // ★ 断言的是"读到的库版本"，不是硬编码的字符串 —— 数据来源必须真是那次 migrate
    assert.equal(body.schemaVersion, SCHEMA_VERSION);
    assert.equal(body.home, home);
  });
});

test('未知路由返回 404（不是把 HTML 兜底页当 JSON 回）', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(res.statusCode, 404);
  });
});

test('loadConfig 拒绝非法端口', () => {
  assert.throws(() => loadConfig({ ALKAID_PORT: 'abc' } as NodeJS.ProcessEnv), /不是合法端口/);
  assert.throws(() => loadConfig({ ALKAID_PORT: '70000' } as NodeJS.ProcessEnv), /不是合法端口/);
});

test('loadConfig 默认只绑回环，且数据目录可覆盖', () => {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.host, '127.0.0.1');
  assert.ok(config.home.endsWith('.alkaid'), `默认 home 不对：${config.home}`);
});
