import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { migrate } from '../../src/core/store/schema.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { createTasks, updateTask } from '../../src/core/team/board.ts';

/**
 * ★ 审计 `MEDIUM-01`：**改依赖**也必须查环。
 *
 * 原来只有建卡时查环、而且只走批内的边 ⇒「把 A 改成依赖 B，而 B 早就在依赖 A」
 * 可以顺利写进去。后果不是报错，而是**两张卡永远互相等待、谁也无法认领**，
 * 界面上看起来只是"还没开始做"。
 */
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'https://never-contact.invalid' });
  const root = insertConversation(db, { providerId: provider.id, model: 'offline' }).id;
  return { db, root };
}

test('team: 改 blockedBy 造出环必须 400，且不会写进库里', () => {
  const { db, root } = fixture();
  try {
    const created = createTasks(db, root, [
      { subject: 'A', blockedBy: [] },
      { subject: 'B', blockedBy: [] },
    ]);
    const a = created.created[0]!;
    const b = created.created[1]!;

    // B 依赖 A —— 单向，合法
    updateTask(db, root, root, b.id, b.revision, { blockedBy: [a.id] });

    // 现在让 A 依赖 B ⇒ 成环，必须拒
    assert.throws(
      () => updateTask(db, root, root, a.id, a.revision, { blockedBy: [b.id] }),
      /cycle/i,
    );

    // 库里不能留下环（A 的依赖仍是空）
    const row = db.prepare('SELECT blocked_by FROM team_tasks WHERE id = ?').get(a.id) as { blocked_by?: string } | undefined;
    assert.equal(row?.blocked_by, '[]');
  } finally {
    db.close();
  }
});

test('team: 合法的长链依赖（A←B←C）仍然允许', () => {
  const { db, root } = fixture();
  try {
    const created = createTasks(db, root, [
      { subject: 'A', blockedBy: [] }, { subject: 'B', blockedBy: [] }, { subject: 'C', blockedBy: [] },
    ]);
    const [a, b, c] = created.created;
    assert.ok(a && b && c);
    updateTask(db, root, root, b.id, b.revision, { blockedBy: [a.id] });
    updateTask(db, root, root, c.id, c.revision, { blockedBy: [b.id] });
    // A 依赖 C 会成环（A←B←C←A）⇒ 拒
    assert.throws(() => updateTask(db, root, root, a.id, a.revision, { blockedBy: [c.id] }), /cycle/i);
  } finally {
    db.close();
  }
});
