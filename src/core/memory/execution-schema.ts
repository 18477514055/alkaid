/** V12 fragment. Execution state is per MAIN conversation, not project memory or filesystem state. */
export const EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_boards (
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  state_json TEXT NOT NULL CHECK(length(state_json)<=40000 AND json_valid(state_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,conversation_id)
);
CREATE TABLE IF NOT EXISTS execution_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  actor TEXT NOT NULL CHECK(actor IN ('model','user')),
  kind TEXT NOT NULL CHECK(kind IN ('goal','tasks','activity','update')),
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 500),
  before_json TEXT NOT NULL CHECK(length(before_json)<=40000 AND json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(length(after_json)<=40000 AND json_valid(after_json)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,conversation_id,revision)
);
CREATE INDEX IF NOT EXISTS execution_event_board ON execution_events(project_id,conversation_id,revision DESC);
CREATE TRIGGER IF NOT EXISTS execution_events_no_update BEFORE UPDATE ON execution_events
BEGIN SELECT RAISE(ABORT, 'Execution history is append-only; updates forbidden'); END;
CREATE TRIGGER IF NOT EXISTS execution_events_no_delete BEFORE DELETE ON execution_events
BEGIN SELECT RAISE(ABORT, 'Execution history is append-only; deletion forbidden'); END;
CREATE TRIGGER IF NOT EXISTS execution_events_no_replace BEFORE INSERT ON execution_events
WHEN EXISTS(SELECT 1 FROM execution_events WHERE id=NEW.id OR (project_id=NEW.project_id AND conversation_id=NEW.conversation_id AND revision=NEW.revision))
BEGIN SELECT RAISE(ABORT, 'Execution history is append-only; replacement forbidden'); END;
`;
