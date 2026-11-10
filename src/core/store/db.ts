import { DatabaseSync } from 'node:sqlite';

/**
 * 打开数据库并设好三个必需 pragma。
 *
 * - `journal_mode = WAL`：读写不互相阻塞（对话流式写入 + UI 读历史）
 * - `foreign_keys = ON`：★ SQLite **默认是关的**，不开的话 `ON DELETE SET NULL`
 *   全部静默失效 —— 那是"看着有约束、其实没有"的典型
 * - `busy_timeout`：并发写时等一下而不是立刻 SQLITE_BUSY
 */
export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
