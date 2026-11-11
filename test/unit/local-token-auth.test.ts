import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import fastifyStatic from '@fastify/static';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { getConversation, insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer, getLocalAuth } from '../../src/server/app.ts';
import { checkRequestTrust, requestAuthenticated, trustPolicyFor } from '../../src/server/trust.ts';

const fixtureToken = `fixture-local-${randomUUID()}`;
const expectedBrowserCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function assertBrowserHeaders(response: WireReply): void {
  assert.equal(response.headers['content-security-policy'], expectedBrowserCsp);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
}

type WireReply = { status: number; headers: IncomingHttpHeaders; body: string };
function wire(url: string, method = 'GET', headers: Record<string, string | undefined> = {}, body?: string): Promise<WireReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fixture(t: TestContext, localToken: string | null | undefined = fixtureToken,
  beforeListen?: (app: ReturnType<typeof buildServer>, home: string) => void | Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-local-auth-http-'));
  const config = loadConfig({ ALKAID_HOME: home });
  ensureHome(config);
  const db = openDatabase(':memory:');
  migrate(db);
  const app = buildServer({ config, db, ...(localToken === 'secure-default' ? {} : { localToken }) });
  t.after(async () => { await app.close(); db.close(); rmSync(home, { recursive: true, force: true }); });
  await beforeListen?.(app, home);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, db, home, config, origin, call: (path: string, method = 'GET', headers: Record<string, string | undefined> = {}, body?: unknown) =>
    wire(`${origin}${path}`, method, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body === undefined ? undefined : JSON.stringify(body)) };
}

// undefined is intentionally requested here: never change the production default to suit legacy fixtures.
async function secureFixture(t: TestContext) {
  const prior = process.env['ALKAID_DISABLE_LOCAL_TOKEN'];
  delete process.env['ALKAID_DISABLE_LOCAL_TOKEN'];
  try { return await fixture(t, 'secure-default'); }
  finally { if (prior === undefined) delete process.env['ALKAID_DISABLE_LOCAL_TOKEN']; else process.env['ALKAID_DISABLE_LOCAL_TOKEN'] = prior; }
}

for (const enabled of [true, false]) test(`real HTTP browser confinement (${enabled ? 'enabled' : 'disabled'} auth): static index/assets, HEAD, errors and raw streams always carry strict origin CSP`, async t => {
  let writes = 0;
  const f = await fixture(t, enabled ? fixtureToken : null, async (app, home) => {
    const root = join(home, 'test-public');
    mkdirSync(root);
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>security fixture</title></head><body>static-index</body></html>', 'utf8');
    writeFileSync(join(root, 'fixture.js'), '/* same-origin static resource */', 'utf8');
    await app.register(fastifyStatic, { root, prefix: '/' });
    app.get('/__headers-error', async () => { throw new Error('fixture-error'); });
    app.post('/__headers-write', async () => { writes += 1; return { ok: true }; });
    app.get('/__raw-security', async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.end('data: done\n\n');
    });
  });
  for (const [path, expectedStatus] of [['/', 200], ['/index.html', 200], ['/fixture.js', 200],
    ['/api/healthz', 200], ['/api/auth/status', 200], ['/api/auth/pair', 405],
    ['/__raw-security', 200], ['/__headers-error', 500], ['/missing-static-file', 404]] as const) {
    for (const method of ['GET', 'HEAD']) {
      const response = await f.call(path, method);
      assert.equal(response.status, expectedStatus, `${method} ${path}`);
      assertBrowserHeaders(response);
      assert.equal(response.headers['set-cookie'], undefined);
      if (method === 'HEAD') assert.equal(response.body, '');
      if (path === '/' && method === 'GET') assert.match(response.body, /static-index/);
    }
  }
  const index = await f.call('/index.html');
  assert.equal(typeof index.headers.etag, 'string');
  const notModified = await f.call('/index.html', 'GET', { 'if-none-match': index.headers.etag as string });
  assert.equal(notModified.status, 304);
  assertBrowserHeaders(notModified);
  const validHeaders = { 'x-alkaid-token': fixtureToken, origin: f.origin };
  const accepted = await f.call('/__headers-write', 'POST', validHeaders, {});
  assert.equal(accepted.status, 200);
  assertBrowserHeaders(accepted);
  assert.equal(writes, 1);
  const noTicket = await f.call('/__headers-write', 'POST', {}, {});
  assert.equal(noTicket.status, enabled ? 403 : 200, 'CSP must not alter local-token enforcement or the explicit escape hatch');
  assertBrowserHeaders(noTicket);
  assert.equal(writes, enabled ? 1 : 2);
  const malformed = await wire(`${f.origin}/__headers-write`, 'POST', { ...validHeaders, 'content-type': 'application/json' }, '{broken');
  assert.equal(malformed.status, 400);
  assertBrowserHeaders(malformed);
  const badPair = await f.call('/api/auth/pair', 'POST', {}, { code: 'invalid' });
  assert.equal(badPair.status, 403);
  assertBrowserHeaders(badPair);
  for (const headers of [{ ...validHeaders, host: 'evil.invalid' }, { ...validHeaders, origin: 'https://evil.invalid' },
    { ...validHeaders, origin: 'http://127.0.0.1:1' }]) {
    const rejected = await f.call('/__headers-write', 'POST', headers, {});
    assert.equal(rejected.status, 403, 'neither CSP nor disabled auth may weaken the original Host/Origin fence');
    assertBrowserHeaders(rejected);
  }
});

test('local token: header/cookie possession, duplicate cookies and constant-size comparisons', () => {
  assert.equal(requestAuthenticated({}, fixtureToken), false);
  assert.equal(requestAuthenticated({ 'x-alkaid-token': '' }, fixtureToken), false);
  assert.equal(requestAuthenticated({ 'x-alkaid-token': 'wrong' }, fixtureToken), false);
  assert.equal(requestAuthenticated({ 'x-alkaid-token': fixtureToken }, fixtureToken), true);
  assert.equal(requestAuthenticated({ cookie: `other=x; alkaid_local=${fixtureToken}` }, fixtureToken), true);
  assert.equal(requestAuthenticated({ cookie: `alkaid_local=${fixtureToken}; alkaid_local=wrong` }, fixtureToken), false);
  assert.equal(requestAuthenticated({ cookie: `alkaid_local_suffix=${fixtureToken}` }, fixtureToken), false);
  assert.equal(requestAuthenticated({}, null), true);
  const verdict = checkRequestTrust(trustPolicyFor('127.0.0.1'), { host: '127.0.0.1' }, null, 'POST', { localToken: fixtureToken });
  assert.equal(verdict.ok, false, 'missing Origin on loopback must not bypass local authorization');
});

test('real HTTP: every public GET/HEAD/OPTIONS is ticket-free and never issues Set-Cookie', async t => {
  const f = await fixture(t);
  for (const [path, method] of [['/api/healthz', 'GET'], ['/api/auth/status', 'GET'], ['/api/conversations', 'GET'], ['/api/healthz', 'HEAD'], ['/api/auth/status', 'HEAD'], ['/api/healthz', 'OPTIONS']]) {
    const response = await f.call(path!, method!);
    assert.notEqual(response.status, 403);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.body.includes(fixtureToken), false);
    if (path === '/api/auth/status') assert.equal(response.headers['cache-control'], 'no-store');
  }
  const status = await f.call('/api/auth/status');
  assert.deepEqual(JSON.parse(status.body), { authenticated: false, enabled: true, pairingPath: null, pairingExpiresAt: null });
  for (const headers of [{ 'x-alkaid-token': fixtureToken }, { cookie: `alkaid_local=${fixtureToken}` }]) {
    const authenticated = await f.call('/api/auth/status', 'GET', headers);
    assert.equal(JSON.parse(authenticated.body).authenticated, true);
    assert.equal(authenticated.headers['set-cookie'], undefined);
  }
});

test('real HTTP: all write methods stop before body parsing/handler; fabricated Sec-Fetch cannot authorize', async t => {
  let handled = 0;
  const f = await fixture(t, fixtureToken, app => {
    app.all('/__guard', async () => { handled += 1; return { ok: true }; });
  });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'PROPFIND', 'SEARCH']) {
    for (const headers of [{}, { 'x-alkaid-token': '' }, { 'x-alkaid-token': 'wrong' }, { cookie: 'alkaid_local=wrong' }]) {
      const response = await wire(`${f.origin}/__guard`, method, {
        origin: f.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors',
        'content-type': 'application/json', ...headers,
      }, '{malformed-json');
      assert.equal(response.status, 403, `${method} must reject before body parsing`);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.body.includes('wrong'), false);
    }
    assert.equal(handled, 0);
  }
  for (const headers of [{ 'x-alkaid-token': fixtureToken }, { cookie: `alkaid_local=${fixtureToken}` }]) {
    const accepted = await f.call('/__guard', 'PATCH', headers, {});
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers['set-cookie'], undefined);
  }
  assert.equal(handled, 2);
  for (const path of ['/api/auth/pairing', '/api/auth/pair/other', '/api/auth/pair/', '/api/auth/%70air', '/not-found']) {
    assert.equal((await f.call(path, 'POST', {}, {})).status, 403, 'bootstrap must match only the exact pairing endpoint');
  }
});

test('real HTTP: possession never bypasses original Host/Origin fence', async t => {
  const f = await fixture(t);
  for (const headers of [
    { host: 'evil.invalid', 'x-alkaid-token': fixtureToken },
    { origin: 'https://evil.invalid', 'x-alkaid-token': fixtureToken },
    { origin: 'http://127.0.0.1:1', cookie: `alkaid_local=${fixtureToken}` },
  ]) {
    const response = await f.call('/api/conversations/no-such-id', 'DELETE', headers);
    assert.equal(response.status, 403);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.body.includes(fixtureToken), false);
  }
});

test('real HTTP secure default: manual code pairs once, failed attempts do not consume, GET never bootstraps', async t => {
  const f = await secureFixture(t);
  const auth = getLocalAuth(f.app);
  assert.ok(auth !== null && auth.pairingPath.length > 0, 'undefined must create the private local auth service');
  const code = readFileSync(auth.pairingPath, 'utf8').trim();
  const status = await f.call('/api/auth/status');
  const statusBody = JSON.parse(status.body) as Record<string, unknown>;
  assert.equal(statusBody.enabled, true);
  assert.equal(statusBody.authenticated, false);
  assert.equal(statusBody.pairingPath, auth.pairingPath);
  assert.equal(statusBody.pairingExpiresAt, auth.pairingExpiresAt);
  assert.ok(auth.pairingExpiresAt > Date.now() && auth.pairingExpiresAt <= Date.now() + 600_000);
  assert.equal(status.body.includes(code), false);
  assert.equal(status.body.includes(auth.token), false);
  assert.equal(status.headers['set-cookie'], undefined);
  for (const path of ['/api/healthz', '/api/auth/status', '/api/conversations']) {
    const response = await f.call(path);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.body.includes(code), false);
    assert.equal(response.body.includes(auth.token), false);
  }
  for (const headers of [{}, { 'x-alkaid-token': auth.token }, { cookie: `alkaid_local=${auth.token}` }]) {
    const failed = await f.call('/api/auth/pair', 'POST', headers, { code: 'wrong-code-do-not-reflect' });
    assert.equal(failed.status, 403, 'even an existing bearer cannot pair without the code');
    assert.equal(failed.headers['cache-control'], 'no-store');
    assert.equal(failed.headers['set-cookie'], undefined);
    assert.equal(failed.body.includes('wrong-code-do-not-reflect'), false);
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const publicPair = await f.call(`/api/auth/pair?code=${encodeURIComponent(code)}`, method);
    assert.equal(publicPair.headers['set-cookie'], undefined);
    assert.equal(publicPair.body.includes(code), false);
    assert.equal(publicPair.headers['cache-control'], 'no-store');
  }
  const badOrigin = await f.call('/api/auth/pair', 'POST', { origin: 'https://evil.invalid' }, { code });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.headers['set-cookie'], undefined);
  const badHost = await f.call('/api/auth/pair', 'POST', { host: 'evil.invalid' }, { code });
  assert.equal(badHost.status, 403);
  const malformed = await wire(`${f.origin}/api/auth/pair`, 'POST', { 'content-type': 'application/json' }, `{"code":"${code}`);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.includes(code), false);
  assert.equal(malformed.headers['set-cookie'], undefined);
  assert.equal(malformed.headers['cache-control'], 'no-store');
  const extra = await f.call('/api/auth/pair', 'POST', {}, { code, extra: true });
  assert.equal(extra.status, 400);
  const paired = await f.call('/api/auth/pair?browser=1', 'POST', {}, { code });
  assert.equal(paired.status, 200);
  assert.equal(paired.headers['cache-control'], 'no-store');
  const cookie = paired.headers['set-cookie']?.[0];
  assert.ok(cookie);
  assert.ok(cookie.startsWith(`alkaid_local=${auth.token};`));
  assert.match(cookie, /; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.doesNotMatch(cookie, /Domain|Expires|Max-Age/i);
  assert.equal(paired.body.includes(code), false);
  assert.equal(paired.body.includes(auth.token), false);
  const confirmed = await f.call('/api/auth/status', 'GET', { cookie: cookie.split(';')[0]! });
  assert.equal(JSON.parse(confirmed.body).authenticated, true);
  assert.equal(confirmed.headers['set-cookie'], undefined);
  const replay = await f.call('/api/auth/pair', 'POST', {}, { code });
  assert.equal(replay.status, 403);
  assert.equal(replay.headers['set-cookie'], undefined);
});

test('real HTTP: 10-minute expiry rejects a correct unused pairing code without issuing a cookie', async t => {
  const f = await secureFixture(t);
  const auth = getLocalAuth(f.app)!;
  const code = readFileSync(auth.pairingPath, 'utf8').trim();
  const now = t.mock.method(Date, 'now', () => auth.pairingExpiresAt + 1);
  try {
    const expired = await f.call('/api/auth/pair', 'POST', {}, { code });
    assert.equal(expired.status, 403);
    assert.equal(expired.headers['set-cookie'], undefined);
    assert.equal(expired.body.includes(code), false);
  } finally { now.mock.restore(); }
});

test('real HTTP: explicit test opt-out and production environment escape warn in health', async t => {
  const disabled = await fixture(t, null); // Only this test intentionally verifies the opt-out contract.
  assert.equal(getLocalAuth(disabled.app), null);
  const status = await disabled.call('/api/auth/status');
  assert.deepEqual(JSON.parse(status.body), { enabled: false, authenticated: true, pairingPath: null, pairingExpiresAt: null });
  const health = JSON.parse((await disabled.call('/api/healthz')).body);
  assert.equal(health.trust.localToken, 'disabled');
  assert.match(health.trust.warning, /WARNING/);
  assert.equal(health.trust.tokenPath, null);
  assert.equal(health.trust.pairingPath, null);
  assert.equal((await disabled.call('/api/auth/pair', 'POST', {}, { code: 'no-code-in-disabled-mode' })).status, 403);
  const write = await disabled.call('/api/providers', 'POST', {}, {});
  assert.notEqual(write.status, 403);

  const prior = process.env['ALKAID_DISABLE_LOCAL_TOKEN'];
  process.env['ALKAID_DISABLE_LOCAL_TOKEN'] = '1';
  let escaped: Awaited<ReturnType<typeof fixture>>;
  try { escaped = await fixture(t, 'secure-default'); }
  finally { if (prior === undefined) delete process.env['ALKAID_DISABLE_LOCAL_TOKEN']; else process.env['ALKAID_DISABLE_LOCAL_TOKEN'] = prior; }
  assert.equal(getLocalAuth(escaped.app), null);
  assert.equal(JSON.parse((await escaped.call('/api/healthz')).body).trust.localToken, 'disabled');
});

test('real HTTP: unauthorized permission PATCH and MCP registration leave the database unchanged', async t => {
  const f = await fixture(t);
  const provider = insertProvider(f.db, { name: 'offline-only', baseUrl: 'http://127.0.0.1:1/v1' });
  const conversation = insertConversation(f.db, { providerId: provider.id, model: 'offline', permissionMode: 'readonly' });
  const snapshot = JSON.stringify(f.db.prepare('SELECT * FROM conversations').all());
  const beforeMcp = JSON.stringify(f.db.prepare('SELECT * FROM mcp_servers').all());
  for (const headers of [{}, { 'x-alkaid-token': '' }, { 'x-alkaid-token': 'wrong' }]) {
    const forged = { origin: f.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', ...headers };
    assert.equal((await f.call(`/api/conversations/${conversation.id}`, 'PATCH', forged, { permissionMode: 'full' })).status, 403);
    assert.equal((await f.call('/api/mcp/servers', 'POST', forged, { name: 'must-not-spawn', transport: 'stdio', command: 'do-not-run' })).status, 403);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM conversations').all()), snapshot);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM mcp_servers').all()), beforeMcp);
  }
  assert.equal(getConversation(f.db, conversation.id)?.permissionMode, 'readonly');
  const authorized = await f.call(`/api/conversations/${conversation.id}`, 'PATCH', { 'x-alkaid-token': fixtureToken }, { permissionMode: 'full' });
  assert.equal(authorized.status, 200);
  assert.equal(getConversation(f.db, conversation.id)?.permissionMode, 'full');
});

test('real HTTP: empty ticket denies forged human approval-intent and does not consume an issued grant', async t => {
  const f = await fixture(t);
  const project = insertProject(f.db, { id: randomUUID(), name: 'auth-approval', sharedDir: join(f.home, 'project-never-write') });
  const prefix = `/api/projects/${project.id}/memory/principles`;
  const proposed = await f.call(`${prefix}/proposals`, 'POST', { 'x-alkaid-token': fixtureToken }, {
    recordId: 'P-auth', title: 'Require approval', content: 'Only user approved rule', operation: 'upsert', baseRevision: 0,
  });
  assert.equal(proposed.status, 201);
  const base = `${prefix}/proposals/${(JSON.parse(proposed.body) as { id: string }).id}`;
  const spoofed = { origin: f.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-alkaid-human-intent': 'principle-approval' };
  const deniedIntent = await f.call(`${base}/approval-intent`, 'POST', { ...spoofed, 'x-alkaid-token': '' }, { operation: 'approve' });
  assert.equal(deniedIntent.status, 403);
  assert.equal(deniedIntent.body.includes('capability'), false);
  const allowedHeaders = { ...spoofed, 'x-alkaid-token': fixtureToken };
  const intent = await f.call(`${base}/approval-intent`, 'POST', allowedHeaders, { operation: 'approve' });
  assert.equal(intent.status, 200);
  const capability = (JSON.parse(intent.body) as { capability: string }).capability;
  assert.equal(typeof capability, 'string');
  const before = JSON.stringify(f.db.prepare('SELECT * FROM memory_principle_proposals').all());
  const deniedResolve = await f.call(`${base}/approve`, 'POST', { ...spoofed, 'x-alkaid-token': '' }, { capability });
  assert.equal(deniedResolve.status, 403);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM memory_principle_proposals').all()), before);
  assert.equal((await f.call(`${base}/approve`, 'POST', allowedHeaders, { capability })).status, 200, 'an unauthorized request must not consume the grant');
  assert.equal((await f.call(`${base}/approve`, 'POST', allowedHeaders, { capability })).status, 403);
});
