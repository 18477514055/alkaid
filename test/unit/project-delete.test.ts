import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { deleteProject } from '../../src/core/project/lifecycle.ts';

/**
 * ★ 审计 `CRITICAL-03`：删项目**绝不能**连对话与消息一起删。
 *
 * `purgeProjectRows` 原来按"表里有 project_id 就整片删"扫库，而 `conversations` 恰好有这一列
 * 且没有删除触发器 ⇒ 删项目 = 该项目下所有对话历史永久消失（还可能撞上委派触发器直接 500）。
 *
 * 用户当时的裁定是**对话与项目解耦**：删项目只让对话降级成「无项目会话」。
 * 这条测试就是为了钉住它 —— 之前全仓**没有任何一条测试**调用过 deleteProject。
 */
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  const project = insertProject(db, { id: 'p1', name: 'P1', description: null, sharedDir: 'C:/alkaid-test/p1' });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'offline', projectId: project.id });
  db.prepare(
    `INSERT INTO messages (id, conversation_id, seq, role, content, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run('m1', conversation.id, 1, 'user', '这段历史不能被删', new Date().toISOString());
  return { db, project, conversation };
}

test('删项目：对话降级为无项目会话，消息一条不少', () => {
  const { db, project, conversation } = fixture();
  try {
    const result = deleteProject(db, { home: '.', projectsDir: 'C:/alkaid-test' } as never, project.id, { deleteFiles: false });
    assert.ok(result !== undefined, '项目应存在并可删');

    const row = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(conversation.id);
    assert.ok(row !== undefined, '对话被删掉了（CRITICAL-03 回归）');
    assert.equal(row.project_id, null, '对话应降级为无项目，而不是消失');

    const messages = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversation.id) as { n?: number } | undefined;
    assert.equal(messages?.n, 1, '消息历史被删掉了');

    const projectRow = db.prepare('SELECT id FROM projects WHERE id = ?').get(project.id);
    assert.equal(projectRow, undefined, '项目本身应当被删掉');
  } finally {
    db.close();
  }
});

test('删项目：派过子代理的对话也不会因只追加触发器而 500', () => {
  const { db, project, conversation } = fixture();
  try {
    // 造一条委派记录（它挂在会话上，且有 BEFORE DELETE 触发器）
    db.prepare(
      `INSERT INTO delegations (id, parent_conversation_id, child_conversation_id, task, title, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('d1', conversation.id, 'child-x', '活儿', '标题', 'running', new Date().toISOString(), new Date().toISOString());

    assert.doesNotThrow(() =>
      deleteProject(db, { home: '.', projectsDir: 'C:/alkaid-test' } as never, project.id, { deleteFiles: false }),
    );
    assert.ok(db.prepare('SELECT 1 FROM delegations WHERE id = ?').get('d1') !== undefined, '委派记录不该被删');
  } finally {
    db.close();
  }
});
