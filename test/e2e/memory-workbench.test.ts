import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ensureHome, loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';
import type { ExtensionDefinition, Handoff, PrincipleCurrent, PrincipleProposal, TriageView } from '../../src/shared/memory-workbench.ts';
import type { MemoryProposal } from '../../src/shared/memory.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-workbench-http-'));
  const config = loadConfig({ ALKAID_HOME: home }); ensureHome(config);
  const db = openDatabase(config.dbPath); migrate(db);
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  const project = insertProject(db, { id: randomUUID(), name: 'A', sharedDir: join(home, 'workspace-never-write') });
  const other = insertProject(db, { id: randomUUID(), name: 'B', sharedDir: join(home, 'other-never-write') });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'offline', projectId: project.id });
  const app = buildServer({ db, config });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden in workbench tests'); });
  t.after(async () => { await app.close(); db.close(); rmSync(home, { recursive: true, force: true }); assert.equal(fetchMock.mock.callCount(), 0); });
  const prefix = `/api/projects/${project.id}/memory`;
  const artifact = async (type: string, payload: unknown, idempotencyKey: string = randomUUID()) => app.inject({ method: 'POST', url: `${prefix}/artifacts`, payload: { conversationId: conversation.id, idempotencyKey, type, payload } });
  const accept = (proposal: MemoryProposal) => app.inject({ method: 'POST', url: `${prefix}/proposals/${proposal.id}/accept` });
  return { app, db, home, config, project, other, conversation, prefix, artifact, accept };
}
const uiHeaders = { host: 'localhost:8787', origin: 'http://localhost:8787', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-alkaid-human-intent': 'principle-approval' };

test('HTTP triage is staged, idempotent, independently accepted and queryable without generation', async t => {
  const f = fixture(t);
  const payload = { keep: [{ what: '  exact keep\n原话  ' }], stash: [{ what: 'stash fulltext searchword' }], drop: [{ what: 'outdated' }] };
  const first = await f.artifact('triage', payload, 'replay-safe'); assert.equal(first.statusCode, 201, first.body);
  const replay = await f.artifact('triage', payload, 'replay-safe'); assert.equal(replay.statusCode, 201, replay.body);
  assert.equal((replay.json() as MemoryProposal).id, (first.json() as MemoryProposal).id);
  const before = await f.app.inject({ url: `${f.prefix}/triage` }); assert.equal((before.json() as TriageView).keep.length, 0);
  assert.equal((await f.accept(first.json() as MemoryProposal)).statusCode, 200);
  const after = await f.app.inject({ url: `${f.prefix}/triage` }); const triage = after.json() as TriageView;
  assert.equal(triage.keep[0]?.what, payload.keep[0]?.what); assert.equal(triage.drop.length, 1);
  const search = await f.app.inject({ url: `${f.prefix}/triage?q=SEARCHWORD` }); assert.equal((search.json() as TriageView).stash.length, 1);
  const counts = await f.app.inject({ url: `${f.prefix}/workbench?view=counts` }); assert.deepEqual(Object.keys(counts.json()), ['counts']); assert.doesNotMatch(counts.body, /exact keep|fulltext/);
  const release = await f.artifact('triage', { keep: [], stash: [], drop: [], releaseKeepIds: [triage.keep[0]!.id] });
  assert.equal((await f.accept(release.json() as MemoryProposal)).statusCode, 200);
  assert.equal(((await f.app.inject({ url: `${f.prefix}/triage` })).json() as TriageView).keep.length, 0);
  const forged = await f.artifact('principle', { content: 'bypass' }); assert.equal(forged.statusCode, 400);
  const misplaced = await f.app.inject({ method: 'POST', url: `/api/projects/${f.other.id}/memory/artifacts`, payload: { conversationId: f.conversation.id, idempotencyKey: 'foreign', type: 'triage', payload } }); assert.equal(misplaced.statusCode, 404);
});

test('HTTP handoff renders five sections for direct download and materializes only under application home', async t => {
  const f = fixture(t);
  const staged = await f.artifact('handoff', { title: 'Next session', did: 'Implemented backend', state: 'Tests pass', next: 'Wire UI', files: ['D:\\repo\\app\\src\\a.ts'], blocked: '' });
  assert.equal(staged.statusCode, 201, staged.body); const proposal = staged.json() as MemoryProposal;
  assert.equal((await f.accept(proposal)).statusCode, 200);
  const handoffId = proposal.recordId.split(':')[2]!;
  const read = await f.app.inject({ url: `${f.prefix}/handoffs/${handoffId}` }); assert.equal(read.statusCode, 200); assert.equal((read.json() as Handoff).next, 'Wire UI');
  const download = await f.app.inject({ url: `${f.prefix}/handoffs/${handoffId}/download` }); assert.equal(download.statusCode, 200); assert.match(download.headers['content-type'] as string, /text\/markdown/); assert.match(download.headers['content-disposition'] as string, /attachment/);
  for (const heading of ['做了什么', '当前状态', '下一步', '关键文件路径', '阻塞与待决策']) assert.ok(download.body.includes(heading));
  const materialized = await f.app.inject({ method: 'POST', url: `${f.prefix}/handoffs/${handoffId}/materialize` }); assert.equal(materialized.statusCode, 200, materialized.body);
  assert.ok((materialized.json() as { path: string }).path.startsWith(join(f.home, 'projects', f.project.id, 'handoffs')));
  assert.equal((await f.app.inject({ url: `/api/projects/${f.other.id}/memory/handoffs/${handoffId}/download` })).statusCode, 404);
});

test('HTTP principles require real same-origin intent flow plus scoped single-use capability, never actor claims', async t => {
  const f = fixture(t);
  const create = await f.app.inject({ method: 'POST', url: `${f.prefix}/principles/proposals`, payload: { recordId: 'P1', title: 'Human principle', content: 'Only approved rule', operation: 'upsert', baseRevision: 0 } });
  assert.equal(create.statusCode, 201, create.body); const proposal = create.json() as PrincipleProposal;
  const base = `${f.prefix}/principles/proposals/${proposal.id}`;
  assert.equal(((await f.app.inject({ url: `${f.prefix}/principles/current` })).json() as PrincipleCurrent).text, '');
  assert.equal((await f.app.inject({ method: 'POST', url: `${base}/approve`, payload: { actor: 'human' } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: `${base}/approval-intent`, payload: { operation: 'approve' } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: `${base}/approval-intent`, headers: { ...uiHeaders, origin: 'https://evil.invalid', 'sec-fetch-site': 'cross-site' }, payload: { operation: 'approve' } })).statusCode, 403);
  const issued = await f.app.inject({ method: 'POST', url: `${base}/approval-intent`, headers: uiHeaders, payload: { operation: 'approve' } });
  assert.equal(issued.statusCode, 200, issued.body); assert.equal(issued.headers['cache-control'], 'no-store');
  const { capability } = issued.json() as { capability: string };
  const wrong = await f.app.inject({ method: 'POST', url: `${base}/reject`, headers: uiHeaders, payload: { capability } }); assert.equal(wrong.statusCode, 403);
  const approved = await f.app.inject({ method: 'POST', url: `${base}/approve`, headers: uiHeaders, payload: { capability } }); assert.equal(approved.statusCode, 200, approved.body);
  assert.equal((await f.app.inject({ method: 'POST', url: `${base}/approve`, headers: uiHeaders, payload: { capability } })).statusCode, 403);
  const current = (await f.app.inject({ url: `${f.prefix}/principles/current` })).json() as PrincipleCurrent;
  assert.match(current.text, /Only approved rule/); assert.equal(current.approvals[0]?.actor, 'human'); assert.doesNotMatch(JSON.stringify(current.approvals), /Only approved rule|capability/);
  const rejected = await f.app.inject({ method: 'POST', url: `${f.prefix}/principles/proposals`, payload: { recordId: 'P2', title: 'Unapproved', content: 'Never current', operation: 'upsert', baseRevision: 0 } });
  const rejectBase = `${f.prefix}/principles/proposals/${(rejected.json() as PrincipleProposal).id}`;
  const rejectIntent = await f.app.inject({ method: 'POST', url: `${rejectBase}/approval-intent`, headers: uiHeaders, payload: { operation: 'reject' } });
  assert.equal((await f.app.inject({ method: 'POST', url: `${rejectBase}/reject`, headers: uiHeaders, payload: rejectIntent.json() ? { capability: (rejectIntent.json() as { capability: string }).capability } : {} })).statusCode, 200);
  assert.doesNotMatch(((await f.app.inject({ url: `${f.prefix}/principles/current` })).json() as PrincipleCurrent).text, /Never current/);
});

test('HTTP extensions and intent/user queries operate within their own project without leaking into audit', async t => {
  const f = fixture(t);
  const defined = await f.app.inject({ method: 'POST', url: `${f.prefix}/extensions`, payload: { name: 'Journal', description: 'User defined log', mode: 'single', appendOnly: true } });
  assert.equal(defined.statusCode, 201, defined.body); const ext = defined.json() as ExtensionDefinition;
  const entry = await f.artifact('extension-entry', { extensionId: ext.id, key: 'main', action: 'append', content: 'full entry searchword' });
  assert.equal(entry.statusCode, 201, entry.body); assert.equal((await f.accept(entry.json() as MemoryProposal)).statusCode, 200);
  const entries = await f.app.inject({ url: `${f.prefix}/extensions/${ext.id}/entries?q=searchword` }); assert.equal(entries.statusCode, 200); assert.match(entries.body, /full entry searchword/);
  const overwrite = await f.artifact('extension-entry', { extensionId: ext.id, key: 'main', action: 'replace', content: 'not allowed' }); assert.equal(overwrite.statusCode, 400);
  assert.equal((await f.app.inject({ url: `/api/projects/${f.other.id}/memory/extensions/${ext.id}` })).statusCode, 404);
  const intent = await f.artifact('intent', { conversationId: f.conversation.id, goal: 'why searchword', did: 'tested', issues: '', next: 'ship' });
  assert.equal(intent.statusCode, 201, intent.body); assert.equal((await f.accept(intent.json() as MemoryProposal)).statusCode, 200);
  assert.match((await f.app.inject({ url: `${f.prefix}/logs?view=intents&q=searchword&conversationId=${f.conversation.id}` })).body, /why searchword/);
  f.db.prepare('INSERT INTO messages(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), f.conversation.id, 1, 'user', '  USER ORIGINAL EXACT  ', new Date().toISOString());
  const quotes = await f.app.inject({ url: `${f.prefix}/logs?view=users&conversationId=${f.conversation.id}` }); assert.equal(quotes.statusCode, 200); assert.match(quotes.body, /  USER ORIGINAL EXACT  /);
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM memory_events').all()), /USER ORIGINAL EXACT|why searchword|full entry searchword/);
});
