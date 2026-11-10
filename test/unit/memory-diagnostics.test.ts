import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { claimMergeJob, finishMergeJob, getMemoryView, submitProposal } from '../../src/core/memory/store.ts';
import { isMemoryDiagnosticCode, memoryDiagnosticLabel, normalizeMemoryDiagnostic } from '../../src/shared/memory-diagnostics.ts';

test('diagnostic vocabulary is CLOSED: uppercase data, fake codes, keys and response bodies cannot become log codes', () => {
  for (const raw of ['FULL_USER_PROMPT_BODY', 'SYNTHETIC_UPPERCASE_CREDENTIAL_ABC123', 'MEMORY_JOB_FAKE_SECRET', 'provider says api_key=synthetic-only-fixture', '{"raw_response":"full private body"}']) {
    assert.equal(normalizeMemoryDiagnostic(raw, 'failed'), 'MEMORY_JOB_FAILED');
    assert.equal(normalizeMemoryDiagnostic(raw, 'deferred'), 'MEMORY_JOB_DEFERRED');
    assert.equal(isMemoryDiagnosticCode(raw), false);
    assert.equal(memoryDiagnosticLabel(raw).includes(raw), false);
  }
  assert.equal(normalizeMemoryDiagnostic('Input character limit exceeded', 'failed'), 'MEMORY_JOB_INPUT_LIMIT');
  assert.equal(normalizeMemoryDiagnostic('Provider generation failed', 'failed'), 'MEMORY_JOB_PROVIDER_FAILED');
  assert.equal(normalizeMemoryDiagnostic('Generation timed out', 'failed'), 'MEMORY_JOB_TIMEOUT');
  assert.match(memoryDiagnosticLabel('MEMORY_JOB_INPUT_LIMIT'), /未向模型发送/);
  assert.match(memoryDiagnosticLabel('MEMORY_JOB_TIMEOUT'), /超时/);
});

test('job storage preserves useful fixed categories but never stores arbitrary uppercase or response text', () => {
  const db = new DatabaseSync(':memory:'); migrate(db);
  try {
    insertProject(db, { id: 'diagnostic-project', name: 'fixture', sharedDir: 'C:/owned' });
    const provider = insertProvider(db, { name: 'offline', baseUrl: 'http://127.0.0.1:1' });
    const conversation = insertConversation(db, { projectId: 'diagnostic-project', providerId: provider.id, model: 'offline' });
    submitProposal(db, { conversationId: conversation.id, recordId: 'active', kind: 'active', title: 'fixture', content: 'public fixture', operation: 'upsert', baseRevision: 0, reason: 'fixture', idempotencyKey: 'initial' });
    const raw = 'MEMORY_JOB_SUPER_SECRET_UPPERCASE_BODY';
    const job = claimMergeJob(db, 'diagnostic-project', 'diag-1', provider.id, 'offline')!;
    finishMergeJob(db, job.id, 'failed', raw);
    assert.equal(getMemoryView(db, 'diagnostic-project').jobs.find(j => j.id === job.id)?.error, 'MEMORY_JOB_FAILED');
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM memory_jobs').all()), /SUPER_SECRET/);
    const next = claimMergeJob(db, 'diagnostic-project', 'diag-2', provider.id, 'offline')!;
    finishMergeJob(db, next.id, 'failed', 'Input character limit exceeded');
    assert.equal(getMemoryView(db, 'diagnostic-project').jobs.find(j => j.id === next.id)?.error, 'MEMORY_JOB_INPUT_LIMIT');
  } finally { db.close(); }
});
