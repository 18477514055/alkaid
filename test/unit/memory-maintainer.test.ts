import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { MemoryMaintainer } from '../../src/core/memory/maintainer.ts';
import { applyProposalManually, claimMergeJob, getMemoryView, setMaintainerConfig, submitProposal } from '../../src/core/memory/store.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { setSecret } from '../../src/core/secrets.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProject, insertProvider, updateConversation } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { MemoryProposal } from '../../src/shared/memory.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const home = mkdtempSync(join(tmpdir(), 'alkaid-memory-ai-'));
  const config = loadConfig({ ALKAID_HOME: home });
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const provider = insertProvider(db, { name: 'offline fake', baseUrl: 'https://never-contact.invalid/v1' });
  const project = insertProject(db, { id: randomUUID(), name: 'p', sharedDir: join(home, 'unused') });
  const conversations = [0, 1].map(() => insertConversation(db, { providerId: provider.id, model: 'fake', projectId: project.id }));
  setSecret(config.secretsPath, provider.id, 'test-local-credential');
  setMaintainerConfig(db, project.id, { enabled: true, providerId: provider.id, model: 'fake', quietMs: 1000 });
  const requests: ChatRequest[] = [];
  let script: (req: ChatRequest, signal: AbortSignal) => AsyncGenerator<ChatEvent> = async function* (req) {
    const input = JSON.parse(req.messages[1]!.content!) as { proposals: MemoryProposal[] };
    const groups = new Map<string, MemoryProposal[]>();
    for (const proposal of input.proposals) {
      const group = groups.get(proposal.recordId) ?? [];
      group.push(proposal);
      groups.set(proposal.recordId, group);
    }
    yield { type: 'text', delta: JSON.stringify({ decisions: [...groups.entries()].map(([recordId, proposals]) => ({
      recordId, proposalIds: proposals.map((proposal) => proposal.id), action: 'upsert', kind: proposals[0]!.kind,
      title: proposals[0]!.title, content: 'merged safely', reason: 'Combined evidence',
    })) }) };
    yield { type: 'usage', usage: { input: 101, output: 40 } };
    yield { type: 'finish', reason: 'stop' };
  };
  const createProvider = (): Provider => ({
    id: provider.id,
    async *stream(req, signal) { requests.push(req); yield* script(req, signal); },
  });
  const instances: MemoryMaintainer[] = [];
  const maintainer = (useDefaultProvider = false) => {
    const instance = new MemoryMaintainer({ db, config, ...(useDefaultProvider ? {} : { createProvider }) });
    instances.push(instance);
    return instance;
  };
  const propose = (author: number, recordId = 'target', content = `evidence ${author}`, baseRevision = 0) => submitProposal(db, {
    conversationId: conversations[author]!.id, recordId, kind: 'note', title: recordId,
    operation: 'upsert', content, reason: 'From this conversation', baseRevision, idempotencyKey: randomUUID(),
  });
  const due = async (instance: MemoryMaintainer, ms = 1001) => {
    t.mock.timers.tick(ms);
    await instance.runEligible(project.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  t.after(async () => {
    for (const instance of instances) await instance.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { db, config, project, provider, conversations, requests, maintainer, propose, due,
    setScript: (next: typeof script) => { script = next; } };
}

test('zero generation calls for empty, single author, busy, disabled, and missing credential gates', async (t) => {
  const f = fixture(t);
  const ai = f.maintainer();
  await f.due(ai);
  f.propose(0);
  f.propose(0, 'another');
  ai.notifyProject(f.project.id);
  await f.due(ai);
  assert.equal(f.requests.length, 0);
  f.propose(1);
  updateConversation(f.db, f.conversations[0]!.id, { state: 'running' });
  ai.notifyProject(f.project.id);
  await f.due(ai);
  updateConversation(f.db, f.conversations[0]!.id, { state: 'idle' });
  setMaintainerConfig(f.db, f.project.id, { enabled: false });
  ai.notifyProject(f.project.id);
  await f.due(ai);
  setMaintainerConfig(f.db, f.project.id, { enabled: true });
  setSecret(f.config.secretsPath, f.provider.id, '');
  ai.notifyProject(f.project.id);
  await f.due(ai);
  assert.equal(f.requests.length, 0);
  assert.equal(getMemoryView(f.db, f.project.id).jobs.length, 0);
});

test('two idle authors debounce to exactly one call; only affected records are sent and changed', async (t) => {
  const f = fixture(t);
  const unrelated = f.propose(0, 'unrelated', 'DO NOT SEND THIS RECORD');
  applyProposalManually(f.db, f.project.id, unrelated.id);
  f.propose(0);
  f.propose(1);
  const other = insertProject(f.db, { id: randomUUID(), name: 'other', sharedDir: join(f.config.home, 'other') });
  const otherConversation = insertConversation(f.db, { providerId: f.provider.id, model: 'fake', projectId: other.id });
  updateConversation(f.db, otherConversation.id, { state: 'running' });
  submitProposal(f.db, { conversationId: otherConversation.id, recordId: 'foreign', kind: 'note', title: 'foreign',
    operation: 'upsert', content: 'FOREIGN PROJECT MUST NOT LEAK', reason: 'isolated', baseRevision: 0, idempotencyKey: randomUUID() });
  const ai = f.maintainer();
  ai.notifyProject(f.project.id);
  t.mock.timers.tick(800);
  ai.notifyProject(f.project.id);
  await f.due(ai, 800);
  assert.equal(f.requests.length, 0, 'last notification resets the entire quiet interval');
  await f.due(ai, 201);
  assert.equal(f.requests.length, 1);
  for (let i = 0; i < 5; i++) ai.notifyProject(f.project.id);
  await f.due(ai, 100_000);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.equal(request.maxTokens, 4096);
  assert.equal(request.tools, undefined);
  assert.doesNotMatch(request.messages[1]!.content!, /DO NOT SEND THIS RECORD|FOREIGN PROJECT MUST NOT LEAK/);
  assert.equal(getMemoryView(f.db, other.id).proposals[0]?.status, 'pending');
  assert.equal(getMemoryView(f.db, other.id).jobs.length, 0);
  assert.match(request.messages[0]!.content!, /untrusted JSON/);
  const view = getMemoryView(f.db, f.project.id);
  assert.equal(view.records.find((record) => record.id === 'target')?.content, 'merged safely');
  assert.equal(view.records.find((record) => record.id === 'unrelated')?.content, 'DO NOT SEND THIS RECORD');
  assert.equal(view.jobs[0]?.state, 'applied');
  assert.equal(view.jobs[0]?.inputTokens, 101);
  assert.equal(view.jobs[0]?.outputTokens, 40);
});

test('projectBusy cancels waiting without any request', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  const ai = f.maintainer();
  ai.notifyProject(f.project.id);
  ai.projectBusy(f.project.id);
  t.mock.timers.tick(10_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
});

test('running job invalidated by projectBusy never applies even when provider ignores abort', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  f.setScript(async function* () {
    await waiting;
    yield { type: 'text', delta: '{}' };
    yield { type: 'finish', reason: 'stop' };
  });
  const ai = f.maintainer();
  t.mock.timers.tick(1001);
  assert.equal(f.requests.length, 1);
  ai.projectBusy(f.project.id);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getMemoryView(f.db, f.project.id).jobs[0]?.state, 'deferred');
  assert.equal(getMemoryView(f.db, f.project.id).records.length, 0);
  assert.equal(getMemoryView(f.db, f.project.id).proposals.filter((p) => p.status === 'pending').length, 2);
});

test('restart restores remaining quiet interval and failed identical queue is never auto-retried', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  f.setScript(async function* () { yield { type: 'error', message: 'echo test-local-credential and prompt', retryable: true }; });
  const first = f.maintainer();
  t.mock.timers.tick(700);
  await first.close();
  const second = f.maintainer();
  await f.due(second, 200);
  assert.equal(f.requests.length, 0);
  await f.due(second, 101);
  assert.equal(f.requests.length, 1);
  const failure = getMemoryView(f.db, f.project.id).jobs[0]!;
  assert.equal(failure.state, 'failed');
  assert.equal(failure.error, 'MEMORY_JOB_PROVIDER_FAILED');
  assert.doesNotMatch(JSON.stringify(failure), /test-local-credential|echo/);
  second.notifyProject(f.project.id);
  await f.due(second, 20_000);
  await second.close();
  const third = f.maintainer();
  await f.due(third, 20_000);
  assert.equal(f.requests.length, 1, 'no retries across notifications or restart');
});

for (const invalid of ['malformed', 'foreign target', 'missing coverage', 'principle', 'truncated', 'output limit']) {
  test(`${invalid} model output preserves all original proposals`, async (t) => {
    const f = fixture(t);
    const first = f.propose(0, 'target', 'original A');
    const second = f.propose(1, 'target', 'original B');
    f.setScript(async function* () {
      const decision = { recordId: invalid === 'foreign target' ? 'other-project-record' : 'target',
        proposalIds: invalid === 'missing coverage' ? [first.id] : [first.id, second.id],
        action: 'upsert', kind: invalid === 'principle' ? 'principle' : 'note',
        title: 'target', content: 'bad rewrite', reason: 'reason' };
      yield { type: 'text', delta: invalid === 'malformed' ? 'not json' : JSON.stringify({ decisions: [decision] }) };
      if (invalid === 'output limit') yield { type: 'usage', usage: { input: 10, output: 9000 } };
      yield { type: 'finish', reason: invalid === 'truncated' ? 'length' : 'stop' };
    });
    const ai = f.maintainer();
    await f.due(ai);
    const view = getMemoryView(f.db, f.project.id);
    assert.equal(f.requests.length, 1);
    assert.equal(view.jobs[0]?.state, 'failed');
    assert.equal(view.records.length, 0);
    assert.deepEqual(view.proposals.map((p) => p.content).sort(), ['original A', 'original B']);
    assert.ok(view.proposals.every((p) => p.status === 'pending'));
    ai.notifyProject(f.project.id);
    await f.due(ai);
    assert.equal(f.requests.length, 1);
  });
}

for (const mutation of ['revision', 'new proposal', 'new conversation']) {
  test(`${mutation} change during stream defers a valid answer`, async (t) => {
    const f = fixture(t);
    const a = f.propose(0); const b = f.propose(1);
    f.setScript(async function* () {
      if (mutation === 'revision') setMaintainerConfig(f.db, f.project.id, { maxOutputTokens: 2048 });
      if (mutation === 'new proposal') f.propose(0, 'new-target');
      if (mutation === 'new conversation') insertConversation(f.db, { providerId: f.provider.id, model: 'fake', projectId: f.project.id });
      yield { type: 'text', delta: JSON.stringify({ decisions: [{ recordId: 'target', proposalIds: [a.id, b.id],
        action: 'upsert', kind: 'note', title: 'target', content: 'obsolete answer', reason: 'reason' }] }) };
      yield { type: 'finish', reason: 'stop' };
    });
    const ai = f.maintainer();
    await f.due(ai);
    const view = getMemoryView(f.db, f.project.id);
    assert.equal(f.requests.length, 1);
    assert.equal(view.jobs[0]?.state, 'deferred');
    assert.equal(view.records.length, 0);
    assert.ok(view.proposals.every((p) => p.status === 'pending'));
  });
}

test('input budget exceeded creates a visible error without sending or truncating proposals', async (t) => {
  const f = fixture(t);
  f.propose(0, 'target', 'A'.repeat(2000)); f.propose(1, 'target', 'B'.repeat(2000));
  setMaintainerConfig(f.db, f.project.id, { maxInputChars: 1000 });
  const ai = f.maintainer();
  await f.due(ai);
  assert.equal(f.requests.length, 0);
  const view = getMemoryView(f.db, f.project.id);
  assert.equal(view.jobs[0]?.state, 'failed');
  assert.equal(view.jobs[0]?.error, 'MEMORY_JOB_INPUT_LIMIT');
  assert.ok(view.proposals.every((p) => p.content.length === 2000 && p.status === 'pending'));
});

test('explicit retry retains history and still waits an entire quiet interval', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  f.setScript(async function* () { yield { type: 'error', message: 'offline', retryable: true }; });
  const ai = f.maintainer();
  await f.due(ai);
  assert.equal(f.requests.length, 1);
  ai.retryProject(f.project.id);
  await f.due(ai, 999);
  assert.equal(f.requests.length, 1);
  await f.due(ai, 2);
  assert.equal(f.requests.length, 2);
  assert.equal(getMemoryView(f.db, f.project.id).jobs.length, 2);
  await f.due(ai, 50_000);
  assert.equal(f.requests.length, 2);
});

test('production OpenAI transport performs exactly one attempt on a retryable failure', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  const ai = f.maintainer(true);
  await f.due(ai);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(getMemoryView(f.db, f.project.id).jobs[0]?.state, 'failed');
  ai.notifyProject(f.project.id);
  await f.due(ai, 20_000);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('restart quiet interval also follows the most recent conversation update', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  const first = f.maintainer();
  t.mock.timers.tick(600);
  updateConversation(f.db, f.conversations[1]!.id, { title: 'recent activity' });
  await first.close();
  const second = f.maintainer();
  await f.due(second, 999);
  assert.equal(f.requests.length, 0);
  await f.due(second, 2);
  assert.equal(f.requests.length, 1);
});

test('close settles and preserves proposals even when stream ignores cancellation forever', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  f.setScript(async function* () {
    await new Promise<void>(() => {});
    yield { type: 'finish', reason: 'stop' };
  });
  const ai = f.maintainer();
  await f.due(ai);
  assert.equal(f.requests.length, 1);
  await ai.close();
  assert.equal(getMemoryView(f.db, f.project.id).jobs[0]?.state, 'deferred');
  assert.equal(getMemoryView(f.db, f.project.id).records.length, 0);
});

test('hanging generation times out once without any automatic retry', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  f.setScript(async function* () {
    await new Promise<void>(() => {});
    yield { type: 'finish', reason: 'stop' };
  });
  const ai = f.maintainer();
  await f.due(ai);
  assert.equal(f.requests.length, 1);
  await f.due(ai, 120_001);
  const view = getMemoryView(f.db, f.project.id);
  assert.equal(view.jobs[0]?.state, 'failed');
  assert.equal(view.jobs[0]?.error, 'MEMORY_JOB_TIMEOUT');
  ai.notifyProject(f.project.id);
  await f.due(ai, 500_000);
  assert.equal(f.requests.length, 1);
});

test('two maintainer instances sharing SQLite still claim only one generation', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  const first = f.maintainer();
  const second = f.maintainer();
  await f.due(first);
  await second.runEligible(f.project.id);
  assert.equal(f.requests.length, 1);
  assert.equal(getMemoryView(f.db, f.project.id).jobs.length, 1);
});

test('restart recovers expired running jobs locally and does not regenerate their fingerprint', async (t) => {
  const f = fixture(t);
  f.propose(0); f.propose(1);
  const pending = getMemoryView(f.db, f.project.id).proposals.sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = createHash('sha256').update(JSON.stringify([f.project.id, pending])).digest('hex');
  const claimed = claimMergeJob(f.db, f.project.id, fingerprint, f.provider.id, 'fake');
  assert.ok(claimed !== null);
  const first = f.maintainer();
  await f.due(first);
  assert.equal(f.requests.length, 0, 'fresh lease must not be stolen');
  await first.close();
  t.mock.timers.tick(180_001);
  const second = f.maintainer();
  await f.due(second, 100_000);
  assert.equal(f.requests.length, 0);
  const job = getMemoryView(f.db, f.project.id).jobs[0]!;
  assert.equal(job.state, 'failed');
  assert.equal(job.error, 'MEMORY_JOB_LEASE_EXPIRED');
  assert.equal(job.fingerprint, fingerprint, 'recovery never releases deduplication');
  assert.equal(getMemoryView(f.db, f.project.id).proposals.filter((p) => p.status === 'pending').length, 2);
});
