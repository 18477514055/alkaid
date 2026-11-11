/**
 * 在**只读副本**上验证 v13 → v16 迁移（绝不碰用户的真实库）。
 *
 * 判据（都从副本读出来，不是"跑完没报错"）：
 * ① 迁移跑完后 schema = 16，五张新表都在、`conversations.parent_conversation_id` 有了；
 * ② **既有数据一条没少**：会话数与消息数与迁移前逐条相同；
 * ③ 迁移**幂等**：再跑一次还是 16，不重复写迁移记录。
 */
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { currentVersion, migrate, SCHEMA_VERSION } from '../src/core/store/schema.ts';

/** ★ 本机真实库路径从环境推导，不写死用户名（发布版不能带个人路径） */
const REAL = process.argv[2] ?? join(process.env['APPDATA'] ?? homedir(), 'alkaid', 'data', 'alkaid.db');
const before = statSync(REAL).mtimeMs;

const dir = mkdtempSync(join(tmpdir(), 'alkaid-migrate-copy-'));
const copy = join(dir, 'alkaid.db');
copyFileSync(REAL, copy);
// WAL 里可能还有未落盘的内容；把旁边两个文件也带上，副本才等于"用户看到的库"
for (const suffix of ['-wal', '-shm']) {
  try {
    copyFileSync(`${REAL}${suffix}`, `${copy}${suffix}`);
  } catch {
    /* 没有就算了 */
  }
}

const db = new DatabaseSync(copy);
const checks = {};
try {
  const v0 = currentVersion(db);
  const conv0 = Number(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n);
  const msg0 = Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);
  console.log(JSON.stringify({ step: 'before', schema: v0, conversations: conv0, messages: msg0 }));

  const v1 = migrate(db);
  const v2 = migrate(db); // 幂等
  const migrations = Number(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n);

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const cols = new Set(db.prepare('PRAGMA table_info(conversations)').all().map((r) => r.name));

  const conv1 = Number(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n);
  const msg1 = Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);

  checks.schemaReached16 = v1 === 16 && v2 === 16 && SCHEMA_VERSION === 16;
  checks.newTablesPresent =
    ['pending_inputs', 'delegations', 'team_boards', 'team_tasks', 'team_task_events'].every((t) => tables.has(t));
  checks.parentColumnAdded = cols.has('parent_conversation_id');
  checks.dataPreserved = conv0 === conv1 && msg0 === msg1;
  checks.idempotent = migrations === 16;
  checks.nothingLost = msg1 === 307;

  console.log(
    JSON.stringify({
      step: 'after',
      schema: v1,
      conversations: conv1,
      messages: msg1,
      migrationRows: migrations,
      checks,
      allPass: Object.values(checks).every(Boolean),
    }),
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// 反证：用户的真实库**没有被碰过**（mtime 未变）
const after = statSync(REAL).mtimeMs;
console.log(JSON.stringify({ realDatabaseUntouched: before === after }));
