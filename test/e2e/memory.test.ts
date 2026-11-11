import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { MemoryMaintainer } from '../../src/core/memory/maintainer.ts';
import { getMemoryView, setMaintainerConfig, submitProposal } from '../../src/core/memory/store.ts';
import { setSecret } from '../../src/core/secrets.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProject, insertProvider, updateConversation } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';
import type { MaintainerConfig, MemoryView } from '../../src/shared/memory.ts';
import type { ChatRequest } from '../../src/shared/types.ts';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const home = mkdtempSync(join(tmpdir(), 'alkaid-memory-http-'));
  const config = loadConfig({ ALKAID_HOME: home });
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const provider = insertProvider(db, { name: 'fake', baseUrl: 'https://never-contact.invalid/v1' });
  setSecret(config.secretsPath, provider.id, 'http-test-local-credential');
  const project = insertProject(db, { id: randomUUID(), name: 'memory project', sharedDir: join(home, 'unused') });
  const conversations = [0, 1].map(() => insertConversation(db, { providerId: provider.id, model: 'fake', projectId: project.id }));
  const requests: ChatRequest[] = [];
  const memory = new MemoryMaintainer({ db, config, createProvider: () => ({ id: provider.id,
    async *stream(req) {
      requests.push(req);
      yield { type: 'error', message: 'offline failure', retryable: true };
    },
  }) });
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ db, config, memory });
  t.after(async () => {
    await app.close();
    await memory.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const url = `/api/projects/${project.id}/memory`;
  const propose = (author: number, recordId = 'target', content = `source ${author}`) => submitProposal(db, {
    conversationId: conversations[author]!.id, recordId, kind: 'note', title: recordId, operation: 'upsert',
    content, reason: 'user proposal', baseRevision: 0, idempotencyKey: randomUUID(),
  });
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { db, app, memory, config, project, provider, conversations, requests, url, propose, tick };
}

test('memory GET/dashboard/provider reads are pure and never schedule a generation', async (t) => {
  const f = fixture(t);
  setMaintainerConfig(f.db, f.project.id, { enabled: true, providerId: f.provider.id, model: 'fake', quietMs: 1000 });
  f.propose(0); f.propose(1);
  for (let i = 0; i < 5; i++) {
    const response = await f.app.inject({ method: 'GET', url: f.url });
    assert.equal(response.statusCode, 200);
    const view = response.json() as MemoryView;
    assert.equal(view.projectId, f.project.id);
    assert.equal(view.proposals.length, 2);
    assert.equal(view.jobs.length, 0);
    assert.doesNotMatch(response.body, /http-test-local-credential|secretsPath|sharedDir|home/);
    const providers = await f.app.inject({ method: 'GET', url: '/api/providers' });
    assert.equal(providers.statusCode, 200);
  }
  await f.tick(60_000);
  assert.equal(f.requests.length, 0, 'only a relevant event, not GET, can schedule this newly submitted queue');
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/projects/not-found/memory' })).statusCode, 404);
});

test('configuration PATCH validates boundaries and does not expose credentials or accept path import', async (t) => {
  const f = fixture(t);
  const response = await f.app.inject({ method: 'PATCH', url: `${f.url}/config`, payload: {
    enabled: true, providerId: f.provider.id, model: 'fake', quietMs: 1000,
  } });
  assert.equal(response.statusCode, 200, response.body);
  const saved = response.json() as MaintainerConfig;
  assert.equal(saved.enabled, true);
  assert.equal(saved.providerId, f.provider.id);
  assert.equal(saved.quietMs, 1000);
  for (const payload of [null, [], { quietMs: 0 }, { maxOutputTokens: 99999 }, { maxInputChars: 999999 },
    { providerId: 'nonexistent' }, { importPath: 'C:/private' }, { apiKey: 'not-a-supported-field' }]) {
    const bad = await f.app.inject({ method: 'PATCH', url: `${f.url}/config`,
      payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
    assert.equal(bad.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal((await f.app.inject({ method: 'PATCH', url: '/api/projects/unknown/memory/config', payload: { enabled: false } })).statusCode, 404);
  await f.tick(20_000);
  assert.equal(f.requests.length, 0);
});

test('manual accept/reject are project-scoped, transactional, and never invoke AI', async (t) => {
  const f = fixture(t);
  setMaintainerConfig(f.db, f.project.id, { enabled: true, providerId: f.provider.id, model: 'fake', quietMs: 1000 });
  const accepted = f.propose(0, 'accepted-record', 'explicitly accepted text');
  const rejected = f.propose(1, 'rejected-record', 'keep as rejected evidence');
  const other = insertProject(f.db, { id: randomUUID(), name: 'other project', sharedDir: join(f.config.home, 'other') });
  const foreign = await f.app.inject({ method: 'POST', url: `/api/projects/${other.id}/memory/proposals/${accepted.id}/accept` });
  assert.equal(foreign.statusCode, 404);
  const accept = await f.app.inject({ method: 'POST', url: `${f.url}/proposals/${accepted.id}/accept` });
  assert.equal(accept.statusCode, 200, accept.body);
  const reject = await f.app.inject({ method: 'POST', url: `${f.url}/proposals/${rejected.id}/reject` });
  assert.equal(reject.statusCode, 200, reject.body);
  const duplicateAccept = await f.app.inject({ method: 'POST', url: `${f.url}/proposals/${accepted.id}/accept` });
  assert.equal(duplicateAccept.statusCode, 409);
  await f.tick(30_000);
  assert.equal(f.requests.length, 0);
  const view = getMemoryView(f.db, f.project.id);
  assert.deepEqual(view.records.map((record) => [record.id, record.content]), [['accepted-record', 'explicitly accepted text']]);
  assert.equal(view.proposals.find((proposal) => proposal.id === accepted.id)?.status, 'applied');
  assert.equal(view.proposals.find((proposal) => proposal.id === rejected.id)?.status, 'rejected');
  assert.equal(view.jobs.length, 0);
});

test('explicit retry remains behind two-author, idle and quiet gates; failure has no implicit retry', async (t) => {
  const f = fixture(t);
  setMaintainerConfig(f.db, f.project.id, { enabled: true, providerId: f.provider.id, model: 'fake', quietMs: 1000 });
  f.propose(0);
  assert.equal((await f.app.inject({ method: 'POST', url: `${f.url}/retry` })).statusCode, 202);
  await f.tick(20_000);
  assert.equal(f.requests.length, 0);
  f.propose(1);
  updateConversation(f.db, f.conversations[1]!.id, { state: 'running' });
  assert.equal((await f.app.inject({ method: 'POST', url: `${f.url}/retry` })).statusCode, 202);
  await f.tick(20_000);
  assert.equal(f.requests.length, 0);
  updateConversation(f.db, f.conversations[1]!.id, { state: 'idle' });
  const retry = await f.app.inject({ method: 'POST', url: `${f.url}/retry` });
  assert.equal(retry.statusCode, 202);
  await f.tick(999);
  assert.equal(f.requests.length, 0);
  await f.tick(2);
  assert.equal(f.requests.length, 1);
  assert.equal(getMemoryView(f.db, f.project.id).jobs[0]?.state, 'failed');
  await f.app.inject({ method: 'GET', url: f.url });
  f.memory.notifyProject(f.project.id);
  await f.tick(100_000);
  assert.equal(f.requests.length, 1);
  assert.equal(getMemoryView(f.db, f.project.id).proposals.filter((proposal) => proposal.status === 'pending').length, 2);
  await f.app.inject({ method: 'POST', url: `${f.url}/retry` });
  await f.tick(1001);
  assert.equal(f.requests.length, 2);
  assert.equal(getMemoryView(f.db, f.project.id).jobs.length, 2);
});
