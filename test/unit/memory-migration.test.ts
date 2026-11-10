import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate, SCHEMA_VERSION, BUSINESS_TABLES } from '../../src/core/store/schema.ts';
import { rejectProposal, submitProposal, getMemoryView } from '../../src/core/memory/store.ts';
import { insertProject, insertProvider, insertConversation } from '../../src/core/store/repo.ts';

test('V6-shaped existing messages survive V7 and subsequent additive migrations and default to chat', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(6,'2026-11-06T00:00:00Z');
      CREATE TABLE conversations(id TEXT PRIMARY KEY, project_id TEXT, title TEXT, primary_workspace_id TEXT,
      provider_id TEXT NOT NULL, model TEXT NOT NULL, permission_mode TEXT NOT NULL DEFAULT 'workspace',
      state TEXT NOT NULL DEFAULT 'idle', last_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, instructions TEXT);
      -- ★ 老库必须带上 providers：V3/V9/V10 都会 ALTER providers，
      --   这里少建一张表，后续任何"给 providers 加列"的迁移都会整步失败。
      CREATE TABLE providers(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      base_url TEXT NOT NULL, chat_path TEXT NOT NULL DEFAULT 'chat/completions',
      models_path TEXT NOT NULL DEFAULT 'models', default_model TEXT, extra_headers TEXT,
      thinking_shape TEXT NOT NULL DEFAULT 'effort_only',
      supports_stream_usage INTEGER NOT NULL DEFAULT 1,
      uses_max_completion_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      -- ★ 同理：V13 会给 projects / workspaces 加 pinned_at。真实 V1 库这两张表都在，
      --   夹具也要照实建出来，否则测的是"一个现实中不存在的库"。
      CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      shared_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
      content TEXT, reasoning TEXT, tool_calls TEXT, tool_call_id TEXT, usage TEXT, finish_reason TEXT, created_at TEXT NOT NULL);
      INSERT INTO messages VALUES('existing','c1',1,'assistant','既有业务原文',NULL,NULL,NULL,NULL,'stop','2026-11-06T00:00:00Z');`);
    assert.equal(migrate(db), SCHEMA_VERSION);
    assert.equal(migrate(db), SCHEMA_VERSION);
    const row = db.prepare('SELECT content,display_channel FROM messages WHERE id=?').get('existing')!;
    assert.equal(row['content'], '既有业务原文'); assert.equal(row['display_channel'], 'chat');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%'").all().map(row => String(row.name));
    for (const original of ['memory_projects', 'memory_records', 'memory_proposals', 'memory_jobs', 'memory_history', 'memory_events']) assert.ok(names.includes(original));
    assert.equal(names.length, BUSINESS_TABLES.filter(name => name.startsWith('memory_')).length);
  } finally { db.close(); }
});

test('a conflict may be explicitly rejected, but cannot be silently applied', () => {
  const db = new DatabaseSync(':memory:'); migrate(db);
  try {
    insertProject(db, { id: 'p', name: 'p', sharedDir: 'C:/unused' });
    const provider = insertProvider(db, { name: 'offline', baseUrl: 'http://127.0.0.1:1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'offline', projectId: 'p' });
    const proposal = submitProposal(db, { conversationId: conversation.id, recordId: 'note', kind: 'note', title: 'note', operation: 'upsert', content: 'content', baseRevision: 0, reason: 'test', idempotencyKey: 'one' });
    db.prepare("UPDATE memory_proposals SET status='conflict' WHERE id=?").run(proposal.id);
    rejectProposal(db, 'p', proposal.id);
    assert.equal(getMemoryView(db, 'p').proposals[0]?.status, 'rejected');
    assert.equal(getMemoryView(db, 'p').records.length, 0);
  } finally { db.close(); }
});
