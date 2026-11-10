/** V7 fragment. Memory is database-local, project-scoped, never workspace files.
 * Source IDs intentionally have no cascading foreign keys: deleting a conversation
 * or project must not destroy already submitted evidence or official memory.
 */
export const MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_projects (
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_records (
  project_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('active','decision','goal','lesson','principle','note')),
  title TEXT NOT NULL CHECK (length(title) <= 200),
  content TEXT NOT NULL CHECK (length(content) <= 20000),
  revision INTEGER NOT NULL CHECK (revision > 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, record_id)
);
CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('active','decision','goal','lesson','principle','note')),
  title TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  content TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','conflict')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (conversation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_project ON memory_proposals(project_id, status, created_at);
CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','applied','failed','deferred','conflict')),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  proposal_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  UNIQUE (project_id, fingerprint)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_one_running ON memory_jobs(project_id) WHERE state = 'running';
CREATE TABLE IF NOT EXISTS memory_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  project_revision INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_history_record ON memory_history(project_id, record_id, project_revision);
CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_revision INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
