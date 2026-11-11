import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';
import { checkRequestTrust, trustPolicyFor } from '../../src/server/trust.ts';

/**
 * B1 浏览器信任围栏（`D7@L358`）。**这是上生产前的硬前提。**
 *
 * 判语原文（`D7@L341`）：**无入站鉴权**，只有出站 `Authorization: Bearer <provider key>`。
 * ⇒ 把 `ALKAID_HOST` 改成 `0.0.0.0`，整个局域网就能借你的 Key 调模型、读全部会话、
 *   在 full 档下用 shell/fs 工具改你的文件。
 *
 * 这组测试分两半，**两半都必须过**：
 * ① **坏请求必须被拒**（否则护栏是假的）；
 * ② **正常请求一个都不能被拒**（否则护栏会把应用打死 —— 这比没有护栏更糟）。
 */

async function withServer(
  host: string,
  run: (ctx: { app: ReturnType<typeof buildServer> }) => Promise<void>,
  trustedHosts: readonly string[] = [],
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-trust-'));
  const config = { ...loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv), host, trustedHosts };
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });
  try {
    await run({ app });
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

// ───────────────────────── 策略推导（纯函数） ─────────────────────────

test('策略：绑回环 ⇒ 只查 Host，不强制 Origin', () => {
  const policy = trustPolicyFor('127.0.0.1');
  assert.equal(policy.requireOrigin, false);
  assert.ok(policy.allowedHosts.has('127.0.0.1'));
  assert.ok(policy.allowedHosts.has('localhost'));
  assert.match(policy.description, /仅本机/);
});

test('★★ 策略：绑 0.0.0.0 ⇒ 必须同时查 Origin（此时局域网都能连）', () => {
  const policy = trustPolicyFor('0.0.0.0');
  assert.equal(policy.requireOrigin, true, '对外监听时放松 Origin 校验 = 裸奔');
  // 通配地址本身不该被当成可信 Host（没人会把它写进 Host）
  assert.equal(policy.allowedHosts.has('0.0.0.0'), false);
  assert.match(policy.description, /对外监听/);
});

test('策略：绑具体网卡 IP ⇒ 该 IP 自动可信，仍要求 Origin', () => {
  const policy = trustPolicyFor('192.168.1.5');
  assert.equal(policy.requireOrigin, true);
  assert.ok(policy.allowedHosts.has('192.168.1.5'), '绑定地址本身必须可信，否则自己都访问不了');
});

test('策略：白名单里的主机名会被加进来（用域名访问的场景）', () => {
  const policy = trustPolicyFor('0.0.0.0', ['alkaid.lan', '  My.Phone ']);
  assert.ok(policy.allowedHosts.has('alkaid.lan'));
  assert.ok(policy.allowedHosts.has('my.phone'), '白名单要归一成小写，否则大小写不同就访问不了');
});

// ───────────────────────── 坏请求必须被拒 ─────────────────────────

test('★★ 对外监听时，不带 Origin 的**写**请求必须被拒（审计 ALK-CRIT-01）', async () => {
  await withServer('0.0.0.0', async ({ app }) => {
    // 读：放行（curl 看健康、桌面壳轮询都不带 Origin）
    const read = await app.inject({ method: 'GET', url: '/api/healthz', headers: { host: '127.0.0.1' } });
    assert.equal(read.statusCode, 200, '读请求不该被拦');

    // 写：没有 Origin ⇒ 403（否则绑 0.0.0.0 等于把 API 交给整个局域网）
    const write = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: { host: '127.0.0.1' },
      payload: { name: 'x', baseUrl: 'http://127.0.0.1:9/v1' },
    });
    assert.equal(write.statusCode, 403, '写请求没带 Origin 却被放行');
  });
});

test('★ 绑回环时，不带 Origin 的写请求仍然放行（CLI / 门禁夹具 / 桌面壳）', async () => {
  await withServer('127.0.0.1', async ({ app }) => {
    const write = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: { host: '127.0.0.1' },
      payload: { name: 'p-ro', baseUrl: 'http://127.0.0.1:9/v1' },
    });
    assert.notEqual(write.statusCode, 403, '回环绑定不该要求 Origin');
  });
});

test('★★ 伪造 Origin ⇒ 403（跨站请求伪造）', async () => {
  await withServer('0.0.0.0', async ({ app }) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/healthz',
      headers: { host: '127.0.0.1:8787', origin: 'https://evil.example' },
    });
    assert.equal(res.statusCode, 403, '恶意 Origin 居然被放行了');
    const body = res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'trust/forbidden');
    assert.match(body.error.message, /evil\.example/);
  });
});

test('★★ 对外监听时 Host 必须是已知地址（防 DNS rebinding）', async () => {
  await withServer('0.0.0.0', async ({ app }) => {
    // 攻击者把自己的域名解析到 127.0.0.1，再从浏览器访问 —— Origin 看起来完全同源
    const res = await app.inject({
      method: 'GET',
      url: '/api/healthz',
      headers: { host: 'evil.example:8787', origin: 'http://evil.example:8787' },
    });
    assert.equal(res.statusCode, 403, 'DNS rebinding 没被拦住 —— 只查 Origin 是查不出它的');
  });
});

test('★ 绑回环时，连 Host 冒充外部地址也要拒（DNS rebinding 在 loopback 上同样成立）', async () => {
  await withServer('127.0.0.1', async ({ app }) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/healthz',
      headers: { host: 'evil.example', origin: 'http://evil.example' },
    });
    assert.equal(res.statusCode, 403);
  });
});

test('★ 缺 Host 头 ⇒ 403（不是"放行"）', async () => {
  const policy = trustPolicyFor('127.0.0.1');
  const verdict = checkRequestTrust(policy, { host: undefined });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /缺少 Host/);
});

test('★ Origin 是非法 URL ⇒ 403（不是抛异常）', () => {
  const policy = trustPolicyFor('0.0.0.0');
  const verdict = checkRequestTrust(policy, { host: '127.0.0.1', origin: 'not a url' });
  assert.equal(verdict.ok, false);
});

test('★ 对外监听时 Origin 端口不符 ⇒ 403', () => {
  const policy = trustPolicyFor('192.168.1.5');
  const verdict = checkRequestTrust(policy, { host: '192.168.1.5:8787', origin: 'http://192.168.1.5:9999' }, 8787);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /端口/);
});

// ───────────────────────── 正常请求一个都不能被拒 ─────────────────────────

test('★★ 正常本机访问（带 Origin）必须放行', async () => {
  await withServer('127.0.0.1', async ({ app }) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/healthz',
      headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' },
    });
    assert.equal(res.statusCode, 200, '正常访问被自己的护栏拦了 —— 这比没有护栏更糟');
  });
});

test('★★ 不带 Origin 的请求必须放行（curl / CLI / 桌面壳 / 夹具都不带它）', async () => {
  await withServer('127.0.0.1', async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz', headers: { host: '127.0.0.1:8787' } });
    assert.equal(res.statusCode, 200, '不带 Origin 就拒 ⇒ 会把 gate 夹具与桌面端壳全打挂');
  });
});

test('★ localhost 与 ::1 都算本机', async () => {
  await withServer('127.0.0.1', async ({ app }) => {
    for (const host of ['localhost:8787', '[::1]:8787', '127.0.0.1:8787']) {
      const res = await app.inject({ method: 'GET', url: '/api/healthz', headers: { host } });
      assert.equal(res.statusCode, 200, `${host} 被拦了`);
    }
  });
});

test('★ 绑 0.0.0.0 + 白名单域名 ⇒ 该域名带正确 Origin 时放行', async () => {
  await withServer(
    '0.0.0.0',
    async ({ app }) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/healthz',
        headers: { host: 'alkaid.lan:8787', origin: 'http://alkaid.lan:8787' },
      });
      assert.equal(res.statusCode, 200, '白名单里的域名被拦了 —— 那这个白名单就没用');

      // 但白名单外的域名仍然拒
      const bad = await app.inject({
        method: 'GET',
        url: '/api/healthz',
        headers: { host: 'other.lan:8787', origin: 'http://other.lan:8787' },
      });
      assert.equal(bad.statusCode, 403);
    },
    ['alkaid.lan'],
  );
});

test('★★ 围栏挂在 onRequest 上：连 404 路径也过检查（守卫不能只在业务路由里）', async () => {
  await withServer('0.0.0.0', async ({ app }) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: { host: 'evil.example', origin: 'http://evil.example' },
    });
    assert.equal(res.statusCode, 403, '不存在的路径先返回了 404 ⇒ 说明围栏没覆盖全部请求');
  });
});

test('★ 认证头/密钥不会被围栏回显（403 正文里不许出现请求头原文）', async () => {
  await withServer('0.0.0.0', async ({ app }) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/healthz',
      headers: {
        host: 'evil.example',
        origin: 'http://evil.example',
        authorization: 'Bearer sk-super-secret-should-not-leak',
      },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.includes('sk-super-secret'), false, '403 正文里漏了凭据');
  });
});
