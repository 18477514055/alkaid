import { COMPACTION_EVENT_CODES } from '../../shared/compaction.ts';

/** v17 additive engine tables; no model, prompt or compaction implementation imports here. */
export const COMPACTION_SCHEMA_SQL = `
CREATE TABLE compaction_attempts (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, project_id TEXT NOT NULL, anchor_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('manual','auto','checkpoint')),
 state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')),
 from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, plan_hash TEXT NOT NULL,
 lease_until INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
 code TEXT CHECK(code IN (${COMPACTION_EVENT_CODES.map(code => `'${code}'`).join(',')}))
);
CREATE TRIGGER compaction_attempts_no_delete BEFORE DELETE ON compaction_attempts
BEGIN SELECT RAISE(ABORT,'Compaction attempts and auto dedup history cannot be deleted'); END;
CREATE TRIGGER compaction_attempts_no_replace BEFORE INSERT ON compaction_attempts
WHEN EXISTS(SELECT 1 FROM compaction_attempts WHERE id=NEW.id OR (NEW.source='auto' AND source='auto' AND conversation_id=NEW.conversation_id AND anchor_id=NEW.anchor_id))
BEGIN SELECT RAISE(ABORT,'Compaction attempts cannot be replaced'); END;
CREATE TRIGGER compaction_attempts_identity BEFORE UPDATE ON compaction_attempts
WHEN OLD.state<>'running' OR OLD.id<>NEW.id OR OLD.conversation_id<>NEW.conversation_id OR OLD.project_id<>NEW.project_id OR OLD.anchor_id<>NEW.anchor_id OR OLD.source<>NEW.source OR OLD.from_seq<>NEW.from_seq OR OLD.to_seq<>NEW.to_seq OR OLD.plan_hash<>NEW.plan_hash OR OLD.started_at<>NEW.started_at
BEGIN SELECT RAISE(ABORT,'Compaction attempt identity and completed state are immutable'); END;
CREATE UNIQUE INDEX compaction_running_conversation ON compaction_attempts(conversation_id) WHERE state='running';
CREATE UNIQUE INDEX compaction_auto_once_per_anchor ON compaction_attempts(conversation_id,anchor_id) WHERE source='auto';
CREATE TABLE compaction_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT, conversation_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('manual','auto','checkpoint')),
 phase TEXT NOT NULL CHECK(phase IN ('blocked','start','success','failure')),
 code TEXT NOT NULL CHECK(code IN (${COMPACTION_EVENT_CODES.map(code => `'${code}'`).join(',')})),
 from_seq INTEGER, to_seq INTEGER, anchor_id TEXT,
 input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, missing_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX compaction_events_source ON compaction_events(conversation_id,id);
CREATE TABLE compaction_metadata (
 compaction_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
 anchor_id TEXT NOT NULL, capsule_id TEXT NOT NULL, covers_from_seq INTEGER NOT NULL,
 covers_to_seq INTEGER NOT NULL, previous_ids TEXT NOT NULL, source_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX compaction_metadata_conversation ON compaction_metadata(conversation_id,covers_to_seq);
${['compaction_events','compaction_metadata'].map(table=>`
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Compaction evidence is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Compaction evidence is append-only'); END;
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${table==='compaction_events'?'id=NEW.id':'compaction_id=NEW.compaction_id OR attempt_id=NEW.attempt_id'})
BEGIN SELECT RAISE(ABORT,'Compaction evidence cannot be replaced'); END;
`).join('\n')}
`;
