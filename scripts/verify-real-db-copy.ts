/**
 * 用**用户真实库的副本**验一遍 v13 → v16（副本，绝不碰原库）。
 *
 * ★ 为什么这一步必须做，而且要在发布**之后**做：
 *   前面那些阶段用的是自己造的临时库。而用户真实库里有 2 个会话 / 307 条消息 /
 *   50 张表的一堆历史形态（老行、老的 usage JSON、老的 display_channel 等）。
 *   "在我造的干净库上能迁移"跟"在真实库上能迁移"是两件事 —— 本项目栽过太多次
 *   "夹具太干净，真实数据一跑就露"。
 */
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { currentVersion, migrate } from '../src/core/store/schema.ts';

/** ★ 本机真实库路径从环境推导，不写死用户名（发布版不能带个人路径） */
const REAL = process.argv[2] ?? join(process.env['APPDATA'] ?? homedir(), 'alkaid', 'data', 'alkaid.db');
const beforeMtime = statSync(REAL).mtimeMs;

const dir = mkdtempSync(join(tmpdir(), 'alkaid-real-copy-'));
const copy = join(dir, 'alkaid.db');
copyFileSync(REAL, copy);
for (const suffix of ['-wal', '-shm']) {
  try {
    copyFileSync(`${REAL}${suffix}`, `${copy}${suffix}`);
  } catch {
    /* 没有就算了 */
  }
}

const checks = {};
const db = new DatabaseSync(copy);
try {
  const v0 = currentVersion(db);
  const conv0 = Number(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n);
  const msg0 = Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);
  const tables0 = Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n);

  const v1 = migrate(db);
  const v2 = migrate(db);

  const conv1 = Number(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n);
  const msg1 = Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);
  const tables1 = Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n);
  const migrations = Number(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n);

  const cols = new Set(db.prepare('PRAGMA table_info(conversations)').all().map((r) => r.name));
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));

  // ★ 真实历史行是否仍然读得出来（不是只数行数）
  const sample = db
    .prepare('SELECT id, role, content, usage, finish_reason FROM messages ORDER BY seq ASC LIMIT 5')
    .all();

  checks.reachedV16 = v0 === 13 && v1 === 16 && v2 === 16;
  checks.migrationRows = migrations === 16;
  checks.conversationsPreserved = conv0 === conv1 && conv1 === 2;
  checks.messagesPreserved = msg0 === msg1 && msg1 === 307;
  checks.noTableLost = tables1 >= tables0;
  checks.newTables = ['pending_inputs', 'delegations', 'team_boards', 'team_tasks', 'team_task_events'].every((t) =>
    tables.has(t),
  );
  checks.parentColumn = cols.has('parent_conversation_id');
  checks.realRowsReadable = sample.length === 5 && sample.every((row) => typeof row.role === 'string');

  console.log(
    JSON.stringify(
      {
        before: { schema: v0, conversations: conv0, messages: msg0, tables: tables0 },
        after: { schema: v1, conversations: conv1, messages: msg1, tables: tables1, migrationRows: migrations },
        sampleRoles: sample.map((row) => row.role),
        checks,
        allPass: Object.values(checks).every(Boolean),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const afterMtime = statSync(REAL).mtimeMs;
console.log(JSON.stringify({ realDatabaseUntouched: beforeMtime === afterMtime }));
