import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openDatabase } from '../../src/core/store/db.ts';
import { BUSINESS_TABLES, SCHEMA_VERSION, currentVersion, migrate } from '../../src/core/store/schema.ts';

function withTempDb(run: (db: ReturnType<typeof openDatabase>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-schema-'));
  const db = openDatabase(join(dir, 'test.db'));
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('空库 currentVersion 为 0，迁移后为最新版本', () => {
  withTempDb((db) => {
    assert.equal(currentVersion(db), 0);
    assert.equal(migrate(db), SCHEMA_VERSION);
    assert.equal(currentVersion(db), SCHEMA_VERSION);
  });
});

test('迁移把全部业务表都建出来（一张都不少）', () => {
  withTempDb((db) => {
    migrate(db);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const table of BUSINESS_TABLES) {
      assert.ok(names.includes(table), `缺表：${table}`);
    }
  });
});

test('迁移可重复执行（幂等），不重复写迁移记录', () => {
  withTempDb((db) => {
    migrate(db);
    migrate(db);
    migrate(db);
    const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number | bigint };
    assert.equal(Number(row.n), SCHEMA_VERSION);
  });
});

test('外键约束真的生效：删项目把对话的 project_id 置空', () => {
  withTempDb((db) => {
    migrate(db);
    const now = new Date().toISOString();

    // ★ 先证明 pragma 确实开了 —— 否则下面的断言会因为"约束根本没跑"而误绿
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number | bigint };
    assert.equal(Number(fk.foreign_keys), 1, 'foreign_keys 未开启');

    db.prepare(
      'INSERT INTO projects (id, name, shared_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('p1', '项目一', 'C:/tmp/p1/shared', now, now);

    db.prepare(
      `INSERT INTO conversations (id, project_id, provider_id, model, permission_mode, state, last_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c1', 'p1', 'prov-1', 'deepseek-chat', 'workspace', 'idle', 0, now, now);

    db.prepare('DELETE FROM projects WHERE id = ?').run('p1');

    const conv = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get('c1') as {
      project_id: string | null;
    };
    assert.equal(conv.project_id, null, 'ON DELETE SET NULL 没有生效 —— 外键没起作用');
  });
});

test('messages 的 (conversation_id, seq) 唯一约束真的挡住重复写', () => {
  withTempDb((db) => {
    migrate(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO conversations (id, provider_id, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('c1', 'prov-1', 'm', now, now);

    const insert = db.prepare(
      'INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('m1', 'c1', 1, 'user', '你好', now);

    assert.throws(() => insert.run('m2', 'c1', 1, 'assistant', '重复 seq', now), /UNIQUE|constraint/i);
  });
});
