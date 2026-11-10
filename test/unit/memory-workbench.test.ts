import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ensureHome, loadConfig } from '../../src/config.ts';
import {
  HumanApprovalBroker, createExtension, getCurrentPrinciples, getHandoff, getLatestHandoff, getTriage,
  getWorkbenchCounts, listActiveKeep, listExtensions, listPrincipleProposals, makeArtifactInput,
  materializeHandoff, proposePrinciple, queryExtensionEntries, queryIntents, queryUserQuotes,
  validateWorkbenchArtifact,
} from '../../src/core/memory/workbench.ts';
import { MEMORY_WORKBENCH_SCHEMA_SQL } from '../../src/core/memory/workbench-schema.ts';
import { applyProposalManually, getMemoryView, submitProposal } from '../../src/core/memory/store.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { ArtifactType } from '../../src/shared/memory-workbench.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-workbench-'));
  const config = loadConfig({ ALKAID_HOME: home }); ensureHome(config);
  const db = openDatabase(config.dbPath); migrate(db); db.exec(MEMORY_WORKBENCH_SCHEMA_SQL);
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  const project = insertProject(db, { id: randomUUID(), name: 'A', sharedDir: join(home, 'workspace-never-write') });
  const other = insertProject(db, { id: randomUUID(), name: 'B', sharedDir: join(home, 'other-never-write') });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'offline', projectId: project.id });
  const second = insertConversation(db, { providerId: provider.id, model: 'offline', projectId: project.id });
  const stage = (type: ArtifactType, payload: unknown) => {
    const artifact = makeArtifactInput(type, payload);
    return submitProposal(db, { conversationId: conversation.id, recordId: artifact.recordId, kind: 'note', title: artifact.title,
      operation: 'upsert', content: artifact.content, baseRevision: 0, reason: 'independent review needed', idempotencyKey: randomUUID() });
  };
  const apply = (type: ArtifactType, payload: unknown) => { const proposal = stage(type, payload); applyProposalManually(db, project.id, proposal.id); return proposal; };
  t.after(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  return { db, config, project, other, conversation, second, stage, apply };
}
const triage = (what: string) => ({ keep: [{ what }], stash: [{ what: 'archived searchword in full body' }], drop: [{ what: 'superseded item' }] });
const handoff = { title: 'same title', did: 'Implemented server', state: 'Tests pass; UI pending', next: 'Connect UI and run acceptance', files: ['D:\\project\\src\\file.ts', '/tmp/project/file.ts'], blocked: 'Needs review' };

test('triage is staged, preserves exact keep bytes, searches stash, and retains immutable drop audit', t => {
  const f = fixture(t); const exact = '  USER ORIGINAL\n逐字\tkeep  ';
  const staged = f.stage('triage', triage(exact));
  assert.deepEqual(getWorkbenchCounts(f.db, f.project.id), { keep: 0, stash: 0, drop: 0, handoffs: 0, pendingPrinciples: 0, intents: 0, extensions: 0 });
  applyProposalManually(f.db, f.project.id, staged.id);
  assert.equal(listActiveKeep(f.db, f.project.id)[0]?.what, exact);
  const view = getTriage(f.db, f.project.id);
  assert.equal(view.keep.length, 1); assert.equal(view.stash.length, 1); assert.equal(view.drop.length, 1);
  assert.equal(getTriage(f.db, f.project.id, { q: 'SEARCHWORD' }).stash[0]?.what, 'archived searchword in full body');
  assert.throws(() => f.db.prepare("DELETE FROM memory_triage_entries WHERE bucket='drop'").run(), /append-only/);
  assert.throws(() => f.db.prepare("UPDATE memory_triage_entries SET what='tamper'").run(), /append-only/);
  assert.equal(getTriage(f.db, f.other.id).counts.keep, 0);
});

test('triage accumulates across batches but keep limits require append-only release rather than truncation', t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) f.apply('triage', { keep: Array.from({ length: 10 }, (_v, n) => ({ what: `batch ${i} entry ${n}` })), stash: [], drop: [] });
  assert.equal(listActiveKeep(f.db, f.project.id).length, 40);
  assert.throws(() => f.stage('triage', { keep: [{ what: 'overflow' }], stash: [], drop: [] }), /limit is 40/);
  const old = listActiveKeep(f.db, f.project.id)[0]!;
  f.apply('triage', { keep: [{ what: 'replacement' }], stash: [], drop: [], releaseKeepIds: [old.id] });
  assert.equal(listActiveKeep(f.db, f.project.id).length, 40);
  assert.ok(!listActiveKeep(f.db, f.project.id).some(row => row.id === old.id));
  assert.equal(f.db.prepare('SELECT what FROM memory_triage_entries WHERE project_id=? AND id=?').get(f.project.id, old.id)?.what, old.what);
  assert.throws(() => f.db.exec('DELETE FROM memory_triage_releases'), /append-only/);
  assert.throws(() => f.stage('triage', { keep: [], stash: Array.from({ length: 13 }, () => ({ what: 'too many' })), drop: [] }), /1 to 12/);
});

test('keep character cap rejects oversized application without truncation or losing pending proposal', t => {
  const f = fixture(t);
  const one = f.stage('triage', { keep: [{ what: 'A'.repeat(4000) }], stash: [], drop: [] });
  const two = f.stage('triage', { keep: [{ what: 'B'.repeat(3000) }], stash: [], drop: [] });
  applyProposalManually(f.db, f.project.id, one.id);
  assert.throws(() => applyProposalManually(f.db, f.project.id, two.id), /character limit/);
  assert.equal(listActiveKeep(f.db, f.project.id)[0]?.what, 'A'.repeat(4000));
  assert.equal(getMemoryView(f.db, f.project.id).proposals.find(row => row.id === two.id)?.status, 'pending');
});

test('artifact marker, naming, domain type and principle spoofing are rejected', t => {
  const f = fixture(t);
  for (const [recordId, kind, operation, content] of [
    ['plain', 'note', 'upsert', '{"$memory":"triage","keep":[],"stash":[],"drop":[]}'],
    ['artifact:principle:fake', 'note', 'upsert', '{"$memory":"principle"}'],
    ['artifact:triage:fake', 'principle', 'upsert', '{"$memory":"triage"}'],
    ['artifact:triage:fake', 'note', 'delete', ''],
    ['artifact:triage:fake', 'note', 'upsert', '{"$memory":"intent"}'],
    ['artifact:triage:fake', 'note', 'upsert', 'not json'],
  ]) assert.throws(() => validateWorkbenchArtifact(f.db, f.project.id, recordId!, kind as 'note', operation!, content!));
  assert.doesNotThrow(() => validateWorkbenchArtifact(f.db, f.project.id, 'plain', 'note', 'upsert', 'legacy ordinary note'));
  const proposal = f.apply('triage', triage('one'));
  assert.throws(() => validateWorkbenchArtifact(f.db, f.project.id, proposal.recordId, 'note', 'upsert', proposal.content), /append-only/);
});

test('handoffs are authoritative SQL, absolute-path validated, immutable and materialized without overwrite', t => {
  const f = fixture(t);
  assert.throws(() => f.stage('handoff', { ...handoff, files: ['relative/file.ts'] }), /absolute/);
  f.apply('handoff', handoff);
  const first = getLatestHandoff(f.db, f.project.id)!;
  const firstFile = materializeHandoff(f.db, f.config, f.project.id, first.id);
  const bytes = readFileSync(firstFile.path);
  for (const section of ['做了什么', '当前状态', '下一步', '关键文件路径', '阻塞与待决策']) assert.match(bytes.toString('utf8'), new RegExp(section));
  assert.ok(firstFile.path.startsWith(join(f.config.home, 'projects', f.project.id, 'handoffs')));
  assert.equal(materializeHandoff(f.db, f.config, f.project.id, first.id).created, false);
  f.apply('handoff', { ...handoff, did: 'New session progress' });
  const second = getLatestHandoff(f.db, f.project.id)!;
  const secondFile = materializeHandoff(f.db, f.config, f.project.id, second.id);
  assert.notEqual(firstFile.path, secondFile.path);
  assert.deepEqual(readFileSync(firstFile.path), bytes);
  assert.equal(getHandoff(f.db, f.project.id, first.id).did, handoff.did);
  assert.throws(() => getHandoff(f.db, f.other.id, first.id), /not found/);
  assert.throws(() => f.db.exec('DELETE FROM memory_handoffs'), /append-only/);
});

test('intent summaries are staged/searchable while user quotes remain original read-only ordered messages', t => {
  const f = fixture(t);
  f.apply('intent', { conversationId: f.conversation.id, goal: 'debug searchword', did: 'reproduced', issues: 'race', next: 'fix' });
  const logs = queryIntents(f.db, f.project.id, { q: 'SEARCHWORD', conversationId: f.conversation.id, from: '2000-01-01T00:00:00Z', to: '2099-01-01T00:00:00Z' });
  assert.equal(logs.length, 1); assert.equal(logs[0]?.issues, 'race');
  const beforeEvents = Number(f.db.prepare('SELECT COUNT(*) AS n FROM memory_events').get()?.n);
  for (const [seq, text] of [[2, ' second user exact  '], [1, 'first user exact']] as const) f.db.prepare('INSERT INTO messages(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), f.conversation.id, seq, 'user', text, `2026-11-07T00:00:0${seq}Z`);
  const groups = queryUserQuotes(f.db, f.project.id, { conversationId: f.conversation.id });
  assert.deepEqual(groups[0]?.messages.map(row => row.content), ['first user exact', ' second user exact  ']);
  assert.equal(queryUserQuotes(f.db, f.project.id, { from: '2026-11-07T00:00:02Z' })[0]?.messages.length, 1);
  assert.equal(queryUserQuotes(f.db, f.other.id).length, 0);
  assert.equal(Number(f.db.prepare('SELECT COUNT(*) AS n FROM memory_events').get()?.n), beforeEvents);
  assert.throws(() => f.db.exec('DELETE FROM memory_intents'), /append-only/);
});

test('cards and append-only single extensions are independent, staged, isolated and immutable in history', t => {
  const f = fixture(t);
  const cards = createExtension(f.db, f.project.id, { name: 'Mechanics', description: 'Test mechanics', mode: 'cards', appendOnly: false });
  const stream = createExtension(f.db, f.project.id, { name: 'Journal', description: 'Append-only observations', mode: 'single', appendOnly: true });
  const staged = f.stage('extension-entry', { extensionId: cards.id, key: 'boss1', action: 'replace', content: 'initial full entry' });
  assert.equal(queryExtensionEntries(f.db, f.project.id, cards.id).length, 0);
  applyProposalManually(f.db, f.project.id, staged.id);
  f.apply('extension-entry', { extensionId: cards.id, key: 'boss1', action: 'replace', content: 'updated full entry' });
  assert.equal(queryExtensionEntries(f.db, f.project.id, cards.id)[0]?.content, 'updated full entry');
  f.apply('extension-entry', { extensionId: stream.id, key: 'main', action: 'append', content: 'line A' });
  f.apply('extension-entry', { extensionId: stream.id, key: 'main', action: 'append', content: 'line B searchword' });
  assert.equal(queryExtensionEntries(f.db, f.project.id, stream.id, { q: 'searchword' })[0]?.content, 'line A\nline B searchword');
  for (const action of ['replace', 'delete']) assert.throws(() => f.stage('extension-entry', { extensionId: stream.id, key: 'main', action, content: 'no' }), /Append-only/);
  assert.throws(() => queryExtensionEntries(f.db, f.other.id, stream.id), /not found/);
  assert.equal(listExtensions(f.db, f.other.id).length, 0);
  assert.equal(listExtensions(f.db, f.project.id)[0]?.location.startsWith('sqlite:'), true);
  assert.throws(() => f.db.exec('DELETE FROM memory_extension_entries'), /append-only/);
  assert.equal(f.db.prepare('SELECT content FROM memory_extension_entries WHERE id=?').get(staged.recordId.split(':')[2]!)?.content, 'initial full entry');
});

test('principles require scoped single-use expiring human capability and audit excludes full body', t => {
  const f = fixture(t); const broker = new HumanApprovalBroker();
  const first = proposePrinciple(f.db, f.project.id, { recordId: 'P1', title: 'Human rule', content: 'FULL PRINCIPLE ORIGINAL TEXT', operation: 'upsert', baseRevision: 0 });
  assert.equal(getCurrentPrinciples(f.db, f.project.id).text, '');
  assert.equal(listPrincipleProposals(f.db, f.project.id).length, 1);
  assert.throws(() => broker.resolve(f.db, f.project.id, first.id, 'approve', undefined), /capability required/);
  const cap = broker.issueIntent(f.db, f.project.id, first.id, 'approve');
  assert.throws(() => broker.resolve(f.db, f.other.id, first.id, 'approve', cap.capability), /Invalid/);
  assert.throws(() => broker.resolve(f.db, f.project.id, first.id, 'reject', cap.capability), /Invalid/);
  broker.resolve(f.db, f.project.id, first.id, 'approve', cap.capability);
  assert.throws(() => broker.resolve(f.db, f.project.id, first.id, 'approve', cap.capability), /Invalid/);
  assert.match(getCurrentPrinciples(f.db, f.project.id).text, /FULL PRINCIPLE ORIGINAL TEXT/);
  const second = proposePrinciple(f.db, f.project.id, { recordId: 'P2', title: 'Second rule', content: 'SECOND RULE', operation: 'upsert', baseRevision: 0 });
  broker.resolve(f.db, f.project.id, second.id, 'approve', broker.issueIntent(f.db, f.project.id, second.id, 'approve').capability);
  const current = getCurrentPrinciples(f.db, f.project.id);
  assert.equal(current.approvals.length, 2);
  assert.ok(current.approvals.every(row => row.actor === 'human' && row.createdAt && row.summary.includes('sha256:')));
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM memory_events').all()), /FULL PRINCIPLE ORIGINAL TEXT|SECOND RULE/);
  assert.throws(() => f.db.exec('DELETE FROM memory_principle_audit'), /append-only/);
  assert.throws(() => submitProposal(f.db, { conversationId: f.conversation.id, recordId: 'P1', kind: 'principle', title: 'AI bypass', content: 'bad', operation: 'upsert', baseRevision: 1, reason: 'bad', idempotencyKey: 'cannot' }), /human-maintained/);
});

test('expired capability and principle CAS failures never approve or release immutable history', t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); const broker = new HumanApprovalBroker();
  const p = proposePrinciple(f.db, f.project.id, { recordId: 'P1', title: 'rule', content: 'rule body', operation: 'upsert', baseRevision: 0 });
  const expired = broker.issueIntent(f.db, f.project.id, p.id, 'approve');
  t.mock.timers.tick(120_001);
  assert.throws(() => broker.resolve(f.db, f.project.id, p.id, 'approve', expired.capability), /expired/);
  broker.resolve(f.db, f.project.id, p.id, 'approve', broker.issueIntent(f.db, f.project.id, p.id, 'approve').capability);
  const stale = proposePrinciple(f.db, f.project.id, { recordId: 'P1', title: 'stale', content: 'must not overwrite', operation: 'upsert', baseRevision: 0 });
  assert.throws(() => broker.resolve(f.db, f.project.id, stale.id, 'approve', broker.issueIntent(f.db, f.project.id, stale.id, 'approve').capability), /revision changed/);
  assert.equal(getCurrentPrinciples(f.db, f.project.id).records[0]?.content, 'rule body');
  assert.equal(listPrincipleProposals(f.db, f.project.id).length, 1);
});

test('INSERT OR REPLACE cannot bypass any workbench append-only history with recursive triggers off', t => {
  const f = fixture(t); f.db.exec('PRAGMA recursive_triggers=OFF');
  f.apply('triage', triage('immutable keep'));
  f.apply('triage', { keep: [], stash: [], drop: [], releaseKeepIds: [listActiveKeep(f.db, f.project.id)[0]!.id] });
  f.apply('handoff', handoff);
  f.apply('intent', { conversationId: f.conversation.id, goal: 'goal', did: 'did', issues: '', next: 'next' });
  const ext = createExtension(f.db, f.project.id, { name: 'immutable extension', description: 'desc', mode: 'single', appendOnly: true });
  f.apply('extension-entry', { extensionId: ext.id, key: 'main', action: 'append', content: 'body' });
  const p = proposePrinciple(f.db, f.project.id, { recordId: 'P1', title: 'P1', content: 'body', operation: 'upsert', baseRevision: 0 });
  const broker = new HumanApprovalBroker(); broker.resolve(f.db, f.project.id, p.id, 'approve', broker.issueIntent(f.db, f.project.id, p.id, 'approve').capability);
  for (const table of ['memory_workbench_artifacts', 'memory_triage_entries', 'memory_triage_releases', 'memory_handoffs', 'memory_intents', 'memory_extension_definitions', 'memory_extension_entries', 'memory_principle_audit', 'memory_principle_proposals']) {
    const before = f.db.prepare(`SELECT * FROM ${table}`).all(); assert.ok(before.length > 0, table);
    assert.throws(() => f.db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`), /replacement forbidden/, table);
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), before);
  }
});
