const INSERT_GUARDS: Record<string, string> = {
  memory_workbench_artifacts: 'project_id=NEW.project_id AND record_id=NEW.record_id',
  memory_triage_entries: 'project_id=NEW.project_id AND id=NEW.id',
  memory_triage_releases: 'id=NEW.id OR (project_id=NEW.project_id AND keep_id=NEW.keep_id)',
  memory_handoffs: 'project_id=NEW.project_id AND id=NEW.id',
  memory_intents: 'project_id=NEW.project_id AND id=NEW.id',
  memory_extension_definitions: 'project_id=NEW.project_id AND (id=NEW.id OR name=NEW.name)',
  memory_extension_entries: 'ordinal=NEW.ordinal OR (project_id=NEW.project_id AND id=NEW.id)',
  memory_principle_audit: 'id=NEW.id',
  memory_principle_proposals: 'id=NEW.id',
};
const IMMUTABLE = [
  'memory_workbench_artifacts', 'memory_triage_entries', 'memory_triage_releases',
  'memory_handoffs', 'memory_intents', 'memory_extension_definitions', 'memory_extension_entries',
  'memory_principle_audit',
];

/** V8 additive fragment. History is immutable even through accidental direct SQL. */
export const MEMORY_WORKBENCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_workbench_artifacts (
  project_id TEXT NOT NULL, record_id TEXT NOT NULL, type TEXT NOT NULL,
  source_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,record_id)
);
CREATE TABLE IF NOT EXISTS memory_triage_entries (
  id TEXT NOT NULL, project_id TEXT NOT NULL, bucket TEXT NOT NULL CHECK(bucket IN ('keep','stash','drop')),
  what TEXT NOT NULL, why TEXT NOT NULL, location TEXT NOT NULL, source_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,id)
);
CREATE INDEX IF NOT EXISTS idx_memory_triage_project ON memory_triage_entries(project_id,bucket,created_at);
CREATE TABLE IF NOT EXISTS memory_triage_releases (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, keep_id TEXT NOT NULL, source_id TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(project_id,keep_id)
);
CREATE TABLE IF NOT EXISTS memory_handoffs (
  id TEXT NOT NULL, project_id TEXT NOT NULL, record_id TEXT NOT NULL, title TEXT NOT NULL,
  did TEXT NOT NULL, state TEXT NOT NULL, next TEXT NOT NULL, files TEXT NOT NULL, blocked TEXT NOT NULL,
  source_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,id)
);
CREATE TABLE IF NOT EXISTS memory_intents (
  id TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  goal TEXT NOT NULL, did TEXT NOT NULL, issues TEXT NOT NULL, next TEXT NOT NULL,
  source_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,id)
);
CREATE INDEX IF NOT EXISTS idx_memory_intents_project ON memory_intents(project_id,created_at,conversation_id);
CREATE TABLE IF NOT EXISTS memory_extension_definitions (
  id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('cards','single')), append_only INTEGER NOT NULL CHECK(append_only IN (0,1)),
  created_at TEXT NOT NULL, PRIMARY KEY(project_id,id), UNIQUE(project_id,name)
);
CREATE TABLE IF NOT EXISTS memory_extension_entries (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, project_id TEXT NOT NULL, extension_id TEXT NOT NULL,
  entry_key TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('append','replace','delete')), content TEXT NOT NULL,
  source_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,id)
);
CREATE INDEX IF NOT EXISTS idx_memory_extensions_project ON memory_extension_entries(project_id,extension_id,ordinal);
CREATE TABLE IF NOT EXISTS memory_principle_proposals (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')), base_revision INTEGER NOT NULL CHECK(base_revision>=0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_principle_pending ON memory_principle_proposals(project_id,status,created_at);
CREATE TABLE IF NOT EXISTS memory_principle_audit (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, proposal_id TEXT NOT NULL, record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('approve','reject')), actor TEXT NOT NULL CHECK(actor='human'),
  summary TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS memory_principle_proposals_no_delete BEFORE DELETE ON memory_principle_proposals
BEGIN SELECT RAISE(ABORT,'Principle proposal history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS memory_principle_proposals_payload_immutable BEFORE UPDATE ON memory_principle_proposals
WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.record_id<>OLD.record_id OR NEW.title<>OLD.title
 OR NEW.content<>OLD.content OR NEW.operation<>OLD.operation OR NEW.base_revision<>OLD.base_revision OR NEW.created_at<>OLD.created_at
 OR OLD.status<>'pending' OR NEW.status='pending' OR NEW.resolved_at IS NULL
BEGIN SELECT RAISE(ABORT,'Principle proposal payload is immutable'); END;
${Object.entries(INSERT_GUARDS).map(([table, predicate]) => `
CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${predicate})
BEGIN SELECT RAISE(ABORT,'Memory workbench history is append-only; replacement forbidden'); END;`).join('\n')}
${IMMUTABLE.map((table) => `
CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT,'Memory workbench history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT,'Memory workbench history is append-only'); END;`).join('\n')}
`;
