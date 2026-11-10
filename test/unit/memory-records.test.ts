import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { MEMORY_RECORDS_SCHEMA_SQL } from '../../src/core/memory/records-schema.ts';
import { MEMORY_WORKBENCH_SCHEMA_SQL } from '../../src/core/memory/workbench-schema.ts';
import {
  getGoalTree, getMemoryArchiveSnapshot, getMemoryIndex, getPreservedMemory, goalWeight,
  listMemoryArchive, parseGoalContent, parseLessonContent, parseNoteContent,
  refuseArchiveMutation, renderGoalContent, renderLessonContent, renderNoteContent, searchMemoryLessons,
} from '../../src/core/memory/records.ts';
import {
  applyMergePlan, applyProposalManually, claimMergeJob, finishMergeJob, getMemoryView,
  submitPreservedMerge, submitProposal,
} from '../../src/core/memory/store.ts';
import { projectMemoryBlock } from '../../src/core/agent/prompt/memory.ts';
import type { MemoryProposal, SubmitMemoryProposal } from '../../src/shared/memory.ts';
import type { GoalContent, LessonContent } from '../../src/shared/memory-records.ts';

function fixture(run: (f: { db: DatabaseSync; a: string; b: string; foreign: string; provider: string }) => void): void {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db);
  db.exec(MEMORY_RECORDS_SCHEMA_SQL); db.exec(MEMORY_WORKBENCH_SCHEMA_SQL);
  insertProject(db, { id: 'p', name: 'P', sharedDir: 'unused' });
  insertProject(db, { id: 'other', name: 'Other', sharedDir: 'unused' });
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' }).id;
  const a = insertConversation(db, { providerId: provider, model: 'offline', projectId: 'p' }).id;
  const b = insertConversation(db, { providerId: provider, model: 'offline', projectId: 'p' }).id;
  const foreign = insertConversation(db, { providerId: provider, model: 'offline', projectId: 'other' }).id;
  try { run({ db, a, b, foreign, provider }); } finally { db.close(); }
}
function input(a: string, patch: Partial<SubmitMemoryProposal> = {}): SubmitMemoryProposal {
  return { conversationId: a, recordId: 'r', kind: 'note', title: 'Record', operation: 'upsert', content: 'Original', baseRevision: 0,
    reason: 'Evidence reason that belongs only to proposal/history, not diagnostic events', idempotencyKey: randomUUID(), ...patch };
}
function accept(db: DatabaseSync, a: string, patch: Partial<SubmitMemoryProposal> = {}): MemoryProposal {
  const p = submitProposal(db, input(a, patch)); applyProposalManually(db, 'p', p.id); return p;
}
function code(n: number): (e: unknown) => boolean { return e => e instanceof Error && (e as Error & { statusCode?: number }).statusCode === n; }
function goal(parentId: string | null, state: GoalContent['state'] = 'active', lessons: string[] = []): string {
  return JSON.stringify({ parentId, state, keyResults: ['可复核关键结果'], lessons, body: '目标完整正文' });
}
function lesson(type: LessonContent['type'], patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, category: type === 'lesson' ? '假设错' : '机制', body: 'SQLite完整正文可按特殊关键词密钥隔离策略检索', fix: '先核实再执行',
    ...(type === 'lesson' ? { rootCause: '未验证的假设' } : { source: 'app/src/core/memory/records.ts:1' }), ...patch });
}

test('archive: five full versions and exact before-third snapshot are retrievable', () => fixture(({ db, a }) => {
  const contents = Array.from({ length: 5 }, (_, i) => `完整第${i + 1}版\n${'长文，不能变成摘要。'.repeat(20)}\n尾部原样🙂${i}`);
  for (let i = 0; i < 5; i++) accept(db, a, { baseRevision: i, content: contents[i]! });
  const archive = listMemoryArchive(db, 'p', { recordId: 'r', limit: 100 });
  assert.equal(archive.total, 5);
  for (let i = 1; i <= 5; i++) assert.equal(archive.entries.find(e => e.after.revision === i)?.after.content, contents[i - 1]);
  const third = listMemoryArchive(db, 'p', { recordId: 'r', revision: 3 }).entries[0]!;
  assert.equal(getMemoryArchiveSnapshot(db, 'p', third.id, 'before').snapshot?.content, contents[1]);
  assert.equal(getMemoryArchiveSnapshot(db, 'p', third.id, 'after').snapshot?.content, contents[2]);
  assert.throws(() => getMemoryArchiveSnapshot(db, 'other', third.id), code(404));
}));

test('archive: SQL UPDATE/DELETE and normal archive mutation refuse readable append-only reasons', () => fixture(({ db, a }) => {
  accept(db, a);
  const h = listMemoryArchive(db, 'p').entries[0]!;
  assert.throws(() => db.prepare('DELETE FROM memory_history WHERE id=?').run(h.id), /只允许追加.*不能删除/);
  assert.throws(() => db.prepare("UPDATE memory_history SET after_json='{}' WHERE id=?").run(h.id), /只允许追加.*不能修改/);
  assert.throws(() => refuseArchiveMutation(db, 'p', h.id), /只允许追加/);
  assert.equal(listMemoryArchive(db, 'p').entries[0]?.after.content, 'Original');
}));

test('append-only: INSERT OR REPLACE cannot bypass immutable snapshots with recursive_triggers OFF', () => fixture(({ db, a, b }) => {
  db.exec('PRAGMA recursive_triggers=OFF');
  accept(db, a, { content: 'A original immutable' });
  const archived = db.prepare('SELECT * FROM memory_history LIMIT 1').get()!;
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO memory_history VALUES(?,?,?,?,?,?,?,?)').run(
    archived['id'] as string, 'p', 'r', 1, null, '{}', 'fake', archived['created_at'] as string,
  ), /不能替换/);
  assert.equal(listMemoryArchive(db, 'p').entries[0]?.after.content, 'A original immutable');
  submitProposal(db, input(b, { content: 'B preserved original' }));
  const e = getPreservedMemory(db, 'p').entries[0]!;
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO memory_preserved VALUES(?,?,?,?,?,?,?,?)').run(e.id, 'p', 'r', e.proposalId, '{}', null, '[]', e.createdAt), /不能替换/);
  assert.equal(getPreservedMemory(db, 'p').entries[0]?.current.content, 'A original immutable');
  const merged = submitPreservedMerge(db, 'p', { preservedIds: [e.id], conversationId: b, recordId: 'r', title: 'Merged', content: 'A original immutable+B preserved original', reason: 'explicit merge', idempotencyKey: 'merged' });
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO memory_preserved_merges VALUES(?,?,?)').run('p', merged.id, e.id), /不能替换/);
  applyProposalManually(db, 'p', merged.id);
  const resolution = db.prepare('SELECT * FROM memory_preserved_resolutions').get()!;
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO memory_preserved_resolutions VALUES(?,?,?,?,?)').run(resolution['id'] as string, 'p', e.id, 'fake', e.createdAt), /不能替换/);
  const note = submitProposal(db, input(a, { recordId: 'structured-note', content: JSON.stringify({ type: 'problem', body: 'Problem', rootCause: 'Cause' }) }));
  const name = JSON.parse(note.content).documentName as string;
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO memory_note_documents VALUES(?,?,?)').run('p', 'structured-note', '2000-01-01-forged.md'), /不能覆盖/);
  assert.equal(db.prepare('SELECT document_name FROM memory_note_documents WHERE record_id=?').get('structured-note')?.['document_name'], name);
}));

test('archive: time range, pagination, record and version filters list only scoped changes', () => fixture(({ db, a }) => {
  // Freeze Date independently of Node test timers; snapshots receive distinct exact ISO times.
  const RealDate = Date;
  try {
    for (let i = 0; i < 3; i++) {
      const now = Date.parse(`2026-11-0${i + 1}T12:00:00.000Z`);
      globalThis.Date = class extends RealDate { constructor(...args: [] | [string | number]) { super(args.length ? args[0]! : now); } static now() { return now; } } as DateConstructor;
      accept(db, a, { recordId: `r${i}`, content: `day${i}` });
    }
  } finally { globalThis.Date = RealDate; }
  const result = listMemoryArchive(db, 'p', { from: '2026-11-02', to: '2026-11-03' });
  assert.deepEqual(result.entries.map(e => e.recordId), ['r2', 'r1']);
  assert.equal(listMemoryArchive(db, 'p', { limit: 1, offset: 1 }).entries[0]?.recordId, 'r1');
  assert.equal(listMemoryArchive(db, 'other').total, 0);
  assert.throws(() => listMemoryArchive(db, 'p', { from: '2026-11-04', to: '2026-11-01' }), code(400));
  assert.throws(() => listMemoryArchive(db, 'p', { limit: 201 }), code(400));
}));

test('archive: full-history presence/absence and archive queries cannot change prompt bytes', () => fixture(({ db, a }) => {
  for (let i = 0; i < 5; i++) accept(db, a, { kind: 'active', baseRevision: i, content: `Current formal content ${i}` });
  const withArchive = projectMemoryBlock(db, a);
  listMemoryArchive(db, 'p'); getMemoryArchiveSnapshot(db, 'p', listMemoryArchive(db, 'p').entries[0]!.id, 'before');
  assert.equal(projectMemoryBlock(db, a), withArchive);
  fixture(({ db: empty, a: otherA }) => {
    const current = db.prepare("SELECT * FROM memory_records WHERE project_id='p'").get()!;
    const state = db.prepare("SELECT * FROM memory_projects WHERE project_id='p'").get()!;
    empty.prepare('INSERT INTO memory_projects VALUES(?,?,?)').run('p', state['revision'] as number, state['config'] as string);
    empty.prepare('INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?)').run('p', current['record_id'] as string, current['kind'] as string,
      current['title'] as string, current['content'] as string, current['revision'] as number, 0, current['updated_at'] as string);
    assert.equal(listMemoryArchive(empty, 'p').total, 0);
    assert.equal(projectMemoryBlock(empty, otherA), withArchive);
  });
}));

test('goals: three-level tree includes all states/results/lessons, and pure parsing/rendering', () => fixture(({ db, a }) => {
  accept(db, a, { kind: 'goal', recordId: 'root', content: goal(null, 'root') });
  accept(db, a, { kind: 'goal', recordId: 'child', content: goal('root', 'paused') });
  accept(db, a, { kind: 'goal', recordId: 'grand', content: goal('child', 'done', ['走通的路径']) });
  const tree = getGoalTree(db, 'p');
  assert.deepEqual(tree.roots, ['root']);
  assert.deepEqual(tree.issues, []);
  assert.equal(tree.nodes.find(n => n.record.id === 'grand')?.depth, 2);
  assert.equal(tree.nodes.find(n => n.record.id === 'child')?.data?.state, 'paused');
  assert.deepEqual(tree.nodes.find(n => n.record.id === 'root')?.childrenIds, ['child']);
  assert.match(renderGoalContent(parseGoalContent(goal('child', 'done', ['走通的路径']))), /走通的路径/);
  assert.throws(() => submitProposal(db, input(a, { kind: 'goal', recordId: 'bad', content: '{}' })), /parentId|父目标/);
}));

test('goals: missing parent, cycles, invalid states and legacy data are reported without deletion', () => fixture(({ db, a }) => {
  accept(db, a, { kind: 'goal', recordId: 'missing', content: goal('not-found') });
  accept(db, a, { kind: 'goal', recordId: 'cycle-a', content: goal('cycle-b') });
  accept(db, a, { kind: 'goal', recordId: 'cycle-b', content: goal('cycle-a') });
  db.prepare('INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?)').run('p', 'legacy', 'goal', 'Legacy', '旧自由文本目标', 1, 0, new Date().toISOString());
  assert.throws(() => submitProposal(db, input(a, { kind: 'goal', recordId: 'state', content: JSON.stringify({ parentId: null, state: 'bogus', keyResults: [], lessons: [] }) })), /状态/);
  const tree = getGoalTree(db, 'p');
  assert.ok(tree.issues.some(i => i.code === 'missing-parent' && i.recordId === 'missing'));
  assert.ok(tree.issues.some(i => i.code === 'cycle'));
  assert.ok(tree.issues.some(i => i.code === 'legacy-format' && i.recordId === 'legacy'));
  assert.ok(!tree.roots.includes('missing'));
  assert.equal(tree.nodes.find(n => n.record.id === 'legacy')?.record.content, '旧自由文本目标');
}));

test('goals: root always highest, active raised, completed age decays and lessons retain higher weight', () => fixture(({ db, a }) => {
  for (const [id, state, lessons] of [['root', 'root', []], ['active', 'active', []], ['done', 'done', []], ['done-lesson', 'done', ['重要教训']]] as const) {
    accept(db, a, { kind: 'goal', recordId: id, content: goal(state === 'root' ? null : 'root', state, [...lessons]) });
  }
  const same = '2026-11-07T00:00:00.000Z';
  db.prepare("UPDATE memory_records SET updated_at=? WHERE project_id='p'").run(same);
  const now = Date.parse(same);
  const tree = getGoalTree(db, 'p', now);
  assert.deepEqual(tree.nodes.map(n => n.record.id), ['root', 'active', 'done-lesson', 'done']);
  const previous = tree.nodes.find(n => n.record.id === 'done')!.weight;
  db.prepare("UPDATE memory_records SET updated_at='2025-01-01T00:00:00.000Z' WHERE record_id='done'").run();
  assert.ok(getGoalTree(db, 'p', now).nodes.find(n => n.record.id === 'done')!.weight < previous);
  assert.ok(goalWeight(parseGoalContent(goal('root', 'done', ['教训'])), same, now) > goalWeight(parseGoalContent(goal('root', 'done')), same, now));
}));

test('lessons: missing root cause and experience source are explicitly rejected in Chinese', () => fixture(({ db, a }) => {
  assert.throws(() => submitProposal(db, input(a, { kind: 'lesson', content: lesson('lesson', { rootCause: undefined }) })), /根因/);
  assert.throws(() => submitProposal(db, input(a, { kind: 'lesson', content: lesson('experience', { source: undefined }) })), /出处/);
  assert.throws(() => submitProposal(db, input(a, { kind: 'lesson', content: lesson('lesson', { category: '未知分类' }) })), /分类/);
  assert.throws(() => submitProposal(db, input(a, { kind: 'lesson', content: lesson('experience', { fix: '' }) })), /fix/);
}));

test('lessons: full category+body keyword search and independent experience/lesson types', () => fixture(({ db, a }) => {
  accept(db, a, { kind: 'lesson', recordId: 'l', content: lesson('lesson') });
  accept(db, a, { kind: 'lesson', recordId: 'e', content: lesson('experience') });
  const lessons = searchMemoryLessons(db, 'p', { type: 'lesson', category: '假设错', q: '特殊关键词' });
  assert.equal(lessons.entries.length, 1);
  assert.match(lessons.entries[0]!.rendered, /未验证的假设/);
  assert.match(lessons.entries[0]!.rendered, /SQLite完整正文/);
  assert.equal(searchMemoryLessons(db, 'p', { category: '机制', q: 'sqlite' }).entries[0]?.data?.type, 'experience');
  assert.equal(searchMemoryLessons(db, 'other').entries.length, 0);
  assert.match(renderLessonContent(parseLessonContent(lesson('experience'))), /出处/);
}));

test('structures: manual application and maintainer cannot bypass validation or partially change formal state', () => fixture(({ db, a, provider }) => {
  const p = submitProposal(db, input(a, { kind: 'lesson', content: lesson('lesson') }));
  const invalid = lesson('lesson', { rootCause: '' });
  db.prepare('UPDATE memory_proposals SET content=? WHERE id=?').run(invalid, p.id);
  assert.throws(() => applyProposalManually(db, 'p', p.id), /根因/);
  const job = claimMergeJob(db, 'p', 'invalid-structure', provider, 'offline')!;
  assert.throws(() => applyMergePlan(db, 'p', job.id, 0, [p.id], { decisions: [{ recordId: p.recordId, kind: 'lesson', title: 'Lesson', action: 'upsert', content: invalid, proposalIds: [p.id], reason: 'evidence' }] }), /根因/);
  assert.equal(getMemoryView(db, 'p').revision, 0);
  assert.equal(getMemoryView(db, 'p').records.length, 0);
  assert.equal(listMemoryArchive(db, 'p').total, 0);
}));

test('artifacts: valid-but-tampered maintainer payload and multi-source upsert are rejected atomically', () => fixture(({ db, a, b, provider }) => {
  const original = JSON.stringify({ $memory: 'triage', keep: [{ what: '必须逐字保留的原话🙂' }], stash: [], drop: [] });
  const recordId = 'artifact:triage:exact';
  const p = submitProposal(db, input(a, { recordId, content: original }));
  const job = claimMergeJob(db, 'p', 'tampered', provider, 'offline')!;
  const d = { recordId, kind: 'note' as const, title: 'Triage', action: 'upsert' as const, content: JSON.stringify({ $memory: 'triage', keep: [{ what: '另一个完全合法但已篡改的正文' }], stash: [], drop: [] }), proposalIds: [p.id], reason: 'merge' };
  assert.throws(() => applyMergePlan(db, 'p', job.id, 0, [p.id], { decisions: [d] }), /逐字应用单个来源/);
  assert.equal(getMemoryView(db, 'p').revision, 0);
  assert.equal(getMemoryView(db, 'p').records.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_triage_entries').get()?.['n'], 0);
  assert.equal(listMemoryArchive(db, 'p').total, 0);
  assert.equal(getMemoryView(db, 'p').proposals[0]?.status, 'pending');
  applyMergePlan(db, 'p', job.id, 0, [p.id], { decisions: [{ ...d, content: original }] });
  assert.equal(getMemoryView(db, 'p').records[0]?.content, original);
  const nextId = 'artifact:triage:multiple';
  const q = submitProposal(db, input(a, { recordId: nextId, content: original }));
  const r = submitProposal(db, input(b, { recordId: nextId, content: original }));
  const multi = claimMergeJob(db, 'p', 'multi', provider, 'offline')!;
  const both = { ...d, recordId: nextId, content: original, proposalIds: [q.id, r.id] };
  assert.throws(() => applyMergePlan(db, 'p', multi.id, 1, both.proposalIds, { decisions: [both] }), /逐字应用单个来源/);
  applyMergePlan(db, 'p', multi.id, 1, both.proposalIds, { decisions: [{ ...both, action: 'conflict' }] });
  assert.equal(getMemoryView(db, 'p').proposals.filter(x => [q.id, r.id].includes(x.id)).every(x => x.status === 'conflict'), true);
}));

test('notes: problem root cause / research conclusion, dated unique immutable logical document names', () => fixture(({ db, a }) => {
  const problem = JSON.stringify({ type: 'problem', body: 'Failure', rootCause: 'Root cause' });
  const research = JSON.stringify({ type: 'research', body: 'Research', conclusion: 'Verified conclusion' });
  assert.throws(() => submitProposal(db, input(a, { content: JSON.stringify({ type: 'problem', body: 'No cause' }) })), /根因/);
  assert.throws(() => submitProposal(db, input(a, { content: JSON.stringify({ type: 'research', body: 'No conclusion' }) })), /结论/);
  const p = submitProposal(db, input(a, { recordId: 'n1', title: '同名笔记', content: problem }));
  const q = submitProposal(db, input(a, { recordId: 'n2', title: '同名笔记', content: problem }));
  const first = parseNoteContent(p.content)!; const second = parseNoteContent(q.content)!;
  assert.match(first.documentName!, /^\d{4}-\d{2}-\d{2}-同名笔记-.+\.md$/);
  assert.notEqual(first.documentName, second.documentName);
  applyProposalManually(db, 'p', p.id); applyProposalManually(db, 'p', q.id);
  assert.equal(getMemoryView(db, 'p').records.find(r => r.id === 'n1')?.content, p.content);
  const update = submitProposal(db, input(a, { recordId: 'n1', baseRevision: 1, content: research }));
  assert.equal(parseNoteContent(update.content)?.documentName, first.documentName);
  assert.match(renderNoteContent(parseNoteContent(research)!), /Verified conclusion/);
  const idem = input(a, { recordId: 'n3', content: problem });
  assert.equal(submitProposal(db, idem).id, submitProposal(db, idem).id);
  assert.throws(() => submitProposal(db, input(a, { recordId: 'n4', content: JSON.stringify({ ...first, documentName: '2026-11-07-C:/outside.md' }) })), /名称|路径/);
}));

test('index: final score and all relative dimension ranks are pure and deterministic, including ties', () => fixture(({ db, a }) => {
  accept(db, a, { recordId: 'z', kind: 'decision' });
  accept(db, a, { recordId: 'a', content: 'Very detailed '.repeat(20) });
  const before = getMemoryView(db, 'p').revision;
  const first = getMemoryIndex(db, 'p');
  assert.deepEqual(getMemoryIndex(db, 'p'), first);
  assert.equal(first.diagnosticOnly, true);
  assert.deepEqual(Object.keys(first.rows[0]!.ranks).sort(), ['importance', 'recency', 'references', 'stability', 'volume']);
  assert.ok(first.rows.every(r => Number.isFinite(r.score) && Object.values(r.ranks).every(v => v >= 1)));
  assert.equal(getMemoryView(db, 'p').revision, before);
  assert.deepEqual(getMemoryIndex(db, 'other').rows, []);
}));

test('preserved: full A/B plus provenance, stale submission succeeds, fresh merge remains independent proposal', () => fixture(({ db, a, b }) => {
  const A = 'A完整正文\n包含最后一字🙂与不可丢失进展';
  const B = 'B自己的完整正文\n基于旧版本写入的内容';
  accept(db, a, { content: A });
  const pending = submitProposal(db, input(b, { content: B, baseRevision: 0 }));
  assert.equal(pending.status, 'pending');
  assert.throws(() => applyProposalManually(db, 'p', pending.id), code(409));
  const kept = getPreservedMemory(db, 'p').entries[0]!;
  assert.equal(kept.current.content, A); assert.equal(kept.proposal.content, B);
  assert.deepEqual(kept.sourceConversationIds, [a]); assert.equal(kept.proposal.conversationId, b);
  const mergeInput = { preservedIds: [kept.id], conversationId: b, recordId: 'r', title: 'Merged', content: `${A}\n\n${B}`, reason: 'Explicit merge of A+B', idempotencyKey: randomUUID() };
  const merged = submitPreservedMerge(db, 'p', mergeInput);
  assert.equal(merged.baseRevision, 1); assert.equal(merged.status, 'pending');
  assert.equal(getMemoryView(db, 'p').records[0]?.content, A);
  assert.equal(getPreservedMemory(db, 'p').entries.length, 1);
  applyProposalManually(db, 'p', merged.id);
  assert.equal(getMemoryView(db, 'p').records[0]?.content, `${A}\n\n${B}`);
  assert.equal(getMemoryView(db, 'p').proposals.find(p => p.id === pending.id)?.status, 'applied', 'incorporated stale source must not trigger another maintenance batch');
  assert.equal(getPreservedMemory(db, 'p').entries.length, 0);
  const resolved = getPreservedMemory(db, 'p', true).entries[0]!;
  assert.equal(resolved.current.content, A); assert.equal(resolved.proposal.content, B);
  assert.equal(resolved.resolution?.mergeProposalId, merged.id);
  assert.equal(submitPreservedMerge(db, 'p', mergeInput).id, merged.id);
  assert.throws(() => db.prepare('DELETE FROM memory_preserved WHERE id=?').run(kept.id), /不能删除/);
  assert.throws(() => db.prepare("UPDATE memory_preserved_resolutions SET merge_proposal_id='x'").run(), /只允许追加/);
}));

test('preserved: project scope, duplicated IDs, idempotent source binding and later record race are guarded', () => fixture(({ db, a, b, foreign }) => {
  accept(db, a, { content: 'A' });
  submitProposal(db, input(b, { content: 'B' }));
  const kept = getPreservedMemory(db, 'p').entries[0]!;
  const request = { preservedIds: [kept.id], conversationId: b, recordId: 'r', title: 'Merge', content: 'A+B', reason: 'merge', idempotencyKey: 'merge' };
  assert.throws(() => submitPreservedMerge(db, 'other', request), code(400));
  assert.throws(() => submitPreservedMerge(db, 'p', { ...request, conversationId: foreign }), code(400));
  assert.throws(() => submitPreservedMerge(db, 'p', { ...request, preservedIds: [kept.id, kept.id] }), code(400));
  const merged = submitPreservedMerge(db, 'p', request);
  assert.throws(() => submitPreservedMerge(db, 'p', { ...request, preservedIds: [] }), code(409));
  accept(db, a, { baseRevision: 1, content: 'A even newer revision' });
  assert.throws(() => applyProposalManually(db, 'p', merged.id), code(409));
  assert.equal(getPreservedMemory(db, 'p').entries.length, 1);
  assert.equal(getMemoryView(db, 'p').records[0]?.content, 'A even newer revision');
}));

test('diagnostics: events/job errors never retain content/reason/upstream response bodies', () => fixture(({ db, a, provider }) => {
  const body = 'FULL_BODY_SENTINEL_very_private'; const reason = 'FULL_REASON_SENTINEL_private_evidence';
  accept(db, a, { content: body, reason });
  submitProposal(db, input(a, { recordId: 'another', content: body, reason }));
  const job = claimMergeJob(db, 'p', 'failure', provider, 'offline')!;
  finishMergeJob(db, job.id, 'failed', `Upstream response: ${body} ${reason}`);
  const diagnostics = JSON.stringify(db.prepare('SELECT detail FROM memory_events').all()) + JSON.stringify(getMemoryView(db, 'p').jobs);
  assert.doesNotMatch(diagnostics, /FULL_BODY_SENTINEL|FULL_REASON_SENTINEL|Upstream response/);
  assert.match(diagnostics, /MEMORY_JOB_FAILED/);
  assert.equal(listMemoryArchive(db, 'p').entries[0]?.after.content, body);
}));

test('preserved: real write failure rolls back new proposal, preservation and diagnostic event atomically', () => fixture(({ db, a, b }) => {
  accept(db, a, { content: 'A' });
  const before = getMemoryView(db, 'p').proposals.length;
  db.exec("CREATE TRIGGER test_preserve_failure BEFORE INSERT ON memory_preserved BEGIN SELECT RAISE(ABORT,'injected preserve failure'); END;");
  assert.throws(() => submitProposal(db, input(b, { content: 'B' })), /injected preserve failure/);
  assert.equal(getMemoryView(db, 'p').proposals.length, before);
  assert.equal(getPreservedMemory(db, 'p').entries.length, 0);
  assert.equal(getMemoryView(db, 'p').records[0]?.content, 'A');
}));
