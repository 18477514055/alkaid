/** Local-only context evidence. Capsules and diagnostic transitions are append-only, not audit bodies. */
export const MEMORY_CONTEXT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_read_receipts (
 conversation_id TEXT NOT NULL, project_id TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(conversation_id,project_id,record_id,revision)
);
CREATE TABLE IF NOT EXISTS memory_file_touches (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, tool TEXT NOT NULL CHECK(tool IN ('write','edit')),
 path TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_capsules (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,
 content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(conversation_id,from_seq,to_seq)
);
CREATE TABLE IF NOT EXISTS memory_waterlines (
 conversation_id TEXT PRIMARY KEY, context_tokens INTEGER NOT NULL, context_window INTEGER NOT NULL,
 level TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_turn_debts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, user_seq INTEGER NOT NULL,
 code TEXT NOT NULL CHECK(code IN ('progress_not_recorded','progress_recorded','checkpoint_skip')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_checkpoints (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_seq INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_checkpoint_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, checkpoint_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','recorded','resolved','failed')),
 choice TEXT CHECK(choice IN ('skip','record','record_compact','record_handoff')),
 proposal_id TEXT, handoff_id TEXT, code TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS memory_capsules_no_replace BEFORE INSERT ON memory_capsules
WHEN EXISTS(SELECT 1 FROM memory_capsules WHERE id=NEW.id OR (conversation_id=NEW.conversation_id AND from_seq=NEW.from_seq AND to_seq=NEW.to_seq))
BEGIN SELECT RAISE(ABORT, 'Memory capsule is append-only; replacement is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS memory_receipts_no_replace BEFORE INSERT ON memory_read_receipts
WHEN EXISTS(SELECT 1 FROM memory_read_receipts WHERE conversation_id=NEW.conversation_id AND project_id=NEW.project_id AND record_id=NEW.record_id AND revision=NEW.revision)
BEGIN SELECT RAISE(ABORT, 'Memory receipt is append-only; replacement is forbidden'); END;
${['memory_file_touches','memory_turn_debts','memory_checkpoints','memory_checkpoint_events'].map(table => `
CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'Memory context evidence is append-only; replacement is forbidden'); END;`).join('\n')}
CREATE INDEX IF NOT EXISTS memory_capsule_range ON memory_capsules(conversation_id,from_seq,to_seq);
CREATE INDEX IF NOT EXISTS memory_debt_conversation ON memory_turn_debts(conversation_id,user_seq,id);
CREATE INDEX IF NOT EXISTS memory_checkpoint_conversation ON memory_checkpoints(conversation_id,created_at);
${['memory_read_receipts','memory_file_touches','memory_capsules','memory_turn_debts','memory_checkpoints','memory_checkpoint_events'].map(table => `
CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'Memory context evidence is append-only; updates are forbidden'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'Memory context evidence is append-only; deletion is forbidden'); END;`).join('\n')}
`;
