import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { applyProposalManually, getMemoryView } from '../../src/core/memory/store.ts';
import { createExtension, getCurrentPrinciples, getTriage } from '../../src/core/memory/workbench.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import { createSurface } from '../../src/core/tools/runtime.ts';
import type { ToolContext, ToolOutcome } from '../../src/core/tools/types.ts';

function fixture() {
  const db = new DatabaseSync(':memory:'); migrate(db);
  const p = insertProvider(db, { name: 'offline', baseUrl: 'http://127.0.0.1:1' });
  insertProject(db, { id: 'project-a', name: 'A', sharedDir: 'C:/owned/a' });
  insertProject(db, { id: 'project-b', name: 'B', sharedDir: 'C:/owned/b' });
  const a = insertConversation(db, { providerId: p.id, model: 'offline', projectId: 'project-a' });
  const b = insertConversation(db, { providerId: p.id, model: 'offline', projectId: 'project-b' });
  const ctx: ToolContext = { conversationId: a.id, permissionMode: 'project', workspacePath: null, projectSharedDir: null, roots: { readable: [], writable: [], anywhere: false }, cwd: '.', tempDir: '.', signal: new AbortController().signal };
  const registry = createDefaultRegistry(db);
  return { db, a, b, ctx, registry };
}
function value(outcome: ToolOutcome): any { assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message); return JSON.parse(outcome.ok ? outcome.content : '{}'); }

test('workbench model surface: readonly can stage project memory independently, but no approval operation is exposed', async () => {
  const { db, ctx, registry } = fixture();
  try {
    const read = createSurface(registry, 'readonly');
    for (const name of ['memory_records', 'memory_workbench', 'memory_material_map', 'memory_checkpoint']) assert.equal(read.canCall(name), true);
    assert.equal(read.canCall('memory_stage'), true);
    assert.equal(read.canCall('memory_propose'), true);
    const readonlyContext: ToolContext = { ...ctx, permissionMode: 'readonly' };
    const triage = value(await registry.execute('memory_stage', { action: 'triage', payload: { keep: [{ what: 'VERIFIED_READONLY_KEEP' }], stash: [], drop: [] }, idempotencyKey: 'readonly-tool-triage', reason: 'verified read-only work' }, readonlyContext));
    const progress = value(await registry.execute('memory_propose', { projectId: 'project-b', recordId: 'readonly-progress', kind: 'active', title: 'Verified readonly finding', operation: 'upsert', content: 'VERIFIED_READONLY_PROGRESS', baseRevision: 0, reason: 'verified read-only work', idempotencyKey: 'readonly-tool-progress' }, readonlyContext));
    assert.equal(triage.staged, true); assert.equal(triage.applied, false);
    assert.equal(progress.staged, true); assert.equal(progress.applied, false);
    const view = getMemoryView(db, 'project-a');
    assert.equal(view.proposals.length, 2); assert.ok(view.proposals.every(row => row.status === 'pending'));
    assert.equal(getTriage(db, 'project-a').keep.length, 0, 'readonly capture cannot bypass independent review');
    assert.equal(getMemoryView(db, 'project-b').proposals.length, 0, 'model projectId cannot redirect readonly writes');
    const forged = await registry.execute('memory_stage', { action: 'principle_approve', payload: { actor: 'human', capability: 'forged' } }, ctx);
    assert.equal(forged.ok, false);
    assert.equal(getCurrentPrinciples(db, 'project-a').records.length, 0);
    assert.equal(getMemoryView(db, 'project-a').records.length, 0);
  } finally { db.close(); }
});

test('triage through model tools is pending first, idempotent, independently reviewed, and readable without model requests', async () => {
  const { db, ctx, registry } = fixture();
  try {
    const input = { action: 'triage', payload: { keep: [{ what: 'KEEP_VERBATIM_NEXT_TURN' }], stash: [{ what: 'SEARCHABLE_LATER_DETAIL' }], drop: [{ what: 'superseded fixture' }] }, idempotencyKey: 'triage-tools-1', reason: 'fixture verified' };
    const first = value(await registry.execute('memory_stage', input, ctx));
    const second = value(await registry.execute('memory_stage', input, ctx));
    assert.equal(first.staged, true); assert.equal(first.applied, false);
    assert.equal(first.proposal.id, second.proposal.id);
    assert.equal(getTriage(db, 'project-a').keep.length, 0);
    applyProposalManually(db, 'project-a', first.proposal.id);
    const view = value(await registry.execute('memory_workbench', { action: 'triage', q: 'SEARCHABLE' }, ctx));
    assert.equal(view.stash[0]?.what, 'SEARCHABLE_LATER_DETAIL');
    assert.equal(getTriage(db, 'project-a').keep[0]?.what, 'KEEP_VERBATIM_NEXT_TURN');
    assert.equal(getTriage(db, 'project-b').keep.length, 0);
    const changed = await registry.execute('memory_stage', { ...input, payload: { ...input.payload, keep: [{ what: 'different' }] } }, ctx);
    assert.equal(changed.ok, false);
  } finally { db.close(); }
});

test('structured lesson/goal validation applies to model submission, and complete reads update the material map receipt', async () => {
  const { db, ctx, registry } = fixture();
  try {
    const base = { recordId: 'lesson-1', kind: 'lesson', title: 'lesson', operation: 'upsert', baseRevision: 0, reason: 'fixture', idempotencyKey: 'lesson-tools' };
    const rejected = await registry.execute('memory_propose', { ...base, content: JSON.stringify({ type: 'lesson', category: '假设错', body: 'body', fix: 'fix' }) }, ctx);
    assert.equal(rejected.ok, false); if (!rejected.ok) assert.match(rejected.message, /根因/);
    const proposed = value(await registry.execute('memory_propose', { ...base, content: JSON.stringify({ type: 'lesson', category: '假设错', body: 'FULL_BODY_KEYWORD', fix: 'fixture correction', rootCause: 'unchecked premise' }) }, ctx));
    applyProposalManually(db, 'project-a', proposed.proposal.id);
    const before = value(await registry.execute('memory_material_map', {}, ctx));
    assert.equal(before.rows.find((r: any) => r.recordId === 'lesson-1')?.read, false);
    const read = value(await registry.execute('memory_read', { recordId: 'lesson-1' }, ctx));
    assert.match(read.records[0]?.content, /FULL_BODY_KEYWORD/);
    const after = value(await registry.execute('memory_material_map', {}, ctx));
    assert.equal(after.rows.find((r: any) => r.recordId === 'lesson-1')?.read, true);
    const search = value(await registry.execute('memory_records', { action: 'lessons', category: '假设错', q: 'full_body' }, ctx));
    assert.equal(search.entries.length, 1); assert.match(search.entries[0]?.rendered, /unchecked premise/);
  } finally { db.close(); }
});

test('principle model proposal is human-pending only; unknown cross-project log/capsule sources are rejected', async () => {
  const { db, b, ctx, registry } = fixture();
  try {
    const proposed = value(await registry.execute('memory_stage', { action: 'principle_propose', payload: { recordId: 'principle-1', title: 'human review', content: 'Only human approval changes principles', operation: 'upsert', baseRevision: 0 } }, ctx));
    assert.equal(proposed.pendingHumanApproval, true); assert.equal(proposed.applied, false);
    assert.equal(getCurrentPrinciples(db, 'project-a').records.length, 0);
    assert.equal(JSON.stringify(proposed).includes('capability'), false);
    for (const action of ['user_quotes', 'capsules', 'intent_logs']) {
      const response = await registry.execute('memory_workbench', { action, conversationId: b.id }, ctx);
      assert.equal(response.ok, false);
    }
    const checkpoint = value(await registry.execute('memory_checkpoint', {}, ctx));
    assert.equal(checkpoint.requiresHumanChoice, true);
    assert.equal(getMemoryView(db, 'project-a').records.length, 0);
  } finally { db.close(); }
});

test('append-only extension writes through model tools reject replace and do not mutate formal content', async () => {
  const { db, ctx, registry } = fixture();
  try {
    const ext = createExtension(db, 'project-a', { name: 'append log', description: 'fixture', mode: 'single', appendOnly: true });
    const bad = await registry.execute('memory_stage', { action: 'extension-entry', payload: { extensionId: ext.id, key: 'main', action: 'replace', content: 'cannot overwrite' }, idempotencyKey: 'extension-replace', reason: 'fixture' }, ctx);
    assert.equal(bad.ok, false);
    const staged = value(await registry.execute('memory_stage', { action: 'extension-entry', payload: { extensionId: ext.id, key: 'main', action: 'append', content: 'safe appended body' }, idempotencyKey: 'extension-append', reason: 'fixture' }, ctx));
    const empty = value(await registry.execute('memory_workbench', { action: 'extension_entries', extensionId: ext.id }, ctx));
    assert.deepEqual(empty, []);
    applyProposalManually(db, 'project-a', staged.proposal.id);
    const entries = value(await registry.execute('memory_workbench', { action: 'extension_entries', extensionId: ext.id }, ctx));
    assert.equal(entries[0]?.content, 'safe appended body');
  } finally { db.close(); }
});
