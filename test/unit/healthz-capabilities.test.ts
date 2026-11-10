import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

/**
 * B3「诚实能力广告」（`D7@L361`）。
 *
 * ★ 判据不是"healthz 里有几个字段"，而是**"一个人能不能靠它看懂自己这台机器的姿态"**。
 *   最有代表性的是 `trust` 段：把 `ALKAID_HOST` 改成 `0.0.0.0` 之后，
 *   打开 healthz 就该看到"现在要求 Origin、白名单是这些"。
 *   文档不会跟着部署变，这个会。
 *
 * ★ 同时钉住反面：**不许回显密钥/路径/provider 名**。
 *   healthz 是最容易被随手截图发出去的一个端点。
 */

async function healthz(
  host: string,
  trustedHosts: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-healthz-'));
  const config = { ...loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv), host, trustedHosts };
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ config, db });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/healthz', headers: { host: '127.0.0.1' } });
    assert.equal(res.statusCode, 200);
    return res.json() as Record<string, unknown>;
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test('★ healthz 报出能力（streaming / compact / 工具数），不是只有 ok', async () => {
  const body = await healthz('127.0.0.1');
  const caps = body['capabilities'] as { streaming: boolean; compact: boolean; tools: { count: number } };
  assert.equal(caps.streaming, true);
  assert.equal(caps.compact, true);
  assert.ok(caps.tools.count > 0, `工具数应该是真的（现注册 ${String(caps.tools.count)} 个）`);
});

test('★★ 绑回环时 trust 段说"不要求 Origin"（与本机部署的事实一致）', async () => {
  const body = await healthz('127.0.0.1');
  const trust = body['trust'] as { bind: string; requireOrigin: boolean; description: string };
  assert.equal(trust.bind, '127.0.0.1');
  assert.equal(trust.requireOrigin, false);
  assert.match(trust.description, /仅本机/);
});

test('★★ 绑 0.0.0.0 时 trust 段必须说"要求 Origin"（部署一变，广告就变）', async () => {
  const body = await healthz('0.0.0.0', ['alkaid.lan']);
  const trust = body['trust'] as { bind: string; requireOrigin: boolean; allowedHosts: string[] };
  assert.equal(trust.requireOrigin, true, '对外监听却在 healthz 里说不需要 Origin —— 这就是在骗人');
  assert.ok(trust.allowedHosts.includes('alkaid.lan'));
});

test('★ healthz 不回显密钥、不列 provider 名、不报密码类字段', async () => {
  const body = await healthz('127.0.0.1');
  const serialized = JSON.stringify(body);
  assert.equal(/sk-|api[_-]?key|secret|password|bearer/i.test(serialized), false, `healthz 里出现了敏感字样：${serialized}`);
});
