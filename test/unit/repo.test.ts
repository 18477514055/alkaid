import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import {
  appendMessage,
  deleteConversation,
  getConversation,
  insertConversation,
  insertProvider,
  listConversations,
  listMessages,
  listProviders,
  updateConversation,
} from '../../src/core/store/repo.ts';

function withDb(run: (db: DatabaseSync) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-repo-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('provider 可写入并读回，JSON 列往返不丢类型', () => {
  withDb((db) => {
    const created = insertProvider(db, {
      name: '假厂商',
      baseUrl: 'http://127.0.0.1:9999/v1',
      defaultModel: 'test-model',
      extraHeaders: { 'x-title': 'alkaid' },
    });
    assert.equal(created.name, '假厂商');
    assert.deepEqual(created.extraHeaders, { 'x-title': 'alkaid' });
    assert.equal(created.supportsStreamUsage, true);
    assert.equal(listProviders(db).length, 1);
  });
});

test('消息 seq 从 1 单调递增，且 after 增量读得对', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    const first = appendMessage(db, { conversationId: conversation.id, role: 'user', content: '一' });
    const second = appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '二',
      usage: { input: 3, output: 1 },
    });

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.deepEqual(second.usage, { input: 3, output: 1 });

    assert.equal(getConversation(db, conversation.id)?.lastSeq, 2);
    assert.deepEqual(
      listMessages(db, conversation.id).map((message) => message.seq),
      [1, 2],
    );
    assert.deepEqual(
      listMessages(db, conversation.id, 1).map((message) => message.seq),
      [2],
    );
  });
});

test('tool_calls 以 JSON 列往返（数组不变成字符串）', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' }],
    });

    const [message] = listMessages(db, conversation.id);
    assert.deepEqual(message?.toolCalls, [{ id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' }]);
  });
});

test('会话可按项目过滤，删对话不影响 provider', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    // project_id 有外键 ⇒ 必须先有项目行（这也是"外键真开着"的副作用）
    db.prepare(
      'INSERT INTO projects (id, name, shared_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('proj-1', '项目一', 'C:/tmp/proj-1/shared', new Date().toISOString(), new Date().toISOString());

    const a = insertConversation(db, { providerId: provider.id, model: 'm', projectId: 'proj-1' });
    insertConversation(db, { providerId: provider.id, model: 'm' });

    assert.equal(listConversations(db, { projectId: 'proj-1' }).length, 1);
    assert.equal(listConversations(db).length, 2);

    assert.equal(deleteConversation(db, a.id), true);
    assert.equal(listConversations(db).length, 1);
    assert.equal(listProviders(db).length, 1);
  });
});

test('PATCH 只改传入的字段（没传的保持原值）', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, {
      providerId: provider.id,
      model: 'model-a',
      title: '原标题',
      permissionMode: 'readonly',
    });

    const updated = updateConversation(db, conversation.id, { title: '新标题' });
    assert.equal(updated?.title, '新标题');
    assert.equal(updated?.model, 'model-a');
    assert.equal(updated?.permissionMode, 'readonly');
  });
});
