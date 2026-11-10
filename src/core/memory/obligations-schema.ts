import { OBLIGATION_CODES } from '../../shared/memory-obligations.ts';

/** V11: durable, per-turn evidence. No cascade FK, body copies, or GET-time migrations. */
export const MEMORY_OBLIGATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_obligations (
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_seq INTEGER NOT NULL CHECK(user_seq>0),
  user_message_id TEXT NOT NULL,
  base_proposal_rowid INTEGER NOT NULL CHECK(base_proposal_rowid>=0),
  legacy_origin INTEGER NOT NULL DEFAULT 0 CHECK(legacy_origin IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,user_seq)
);
CREATE INDEX IF NOT EXISTS memory_obligation_project ON memory_obligations(project_id,conversation_id,user_seq);
CREATE TABLE IF NOT EXISTS memory_obligation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  user_seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('begin','business','proposal','repair','finish','exempt','user_skip','user_reconcile')),
  status TEXT NOT NULL CHECK(status IN ('required','repairing','staged','exempt','incomplete')),
  code TEXT NOT NULL CHECK(code IN (${OBLIGATION_CODES.filter(c => c !== 'OBLIGATION_INTERVAL_NOT_DUE').map(c => `'${c}'`).join(',')})),
  message_seq INTEGER,
  proposal_id TEXT,
  mutating INTEGER NOT NULL DEFAULT 0 CHECK(mutating IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_obligation_event_turn ON memory_obligation_events(conversation_id,user_seq,id);
CREATE TABLE IF NOT EXISTS memory_obligation_evidence (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_seq INTEGER NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('progress','triage')),
  message_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_obligation_evidence_turn ON memory_obligation_evidence(conversation_id,user_seq,message_seq);
CREATE TABLE IF NOT EXISTS memory_obligation_repairs (
  conversation_id TEXT NOT NULL,
  user_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,user_seq)
);
CREATE TABLE IF NOT EXISTS memory_obligation_explanations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_seq INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('model','user')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
  reason_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_obligation_legacy_resolutions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_seq INTEGER NOT NULL CHECK(user_seq>=0),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
  reason_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(conversation_id,user_seq)
);
${['memory_obligations','memory_obligation_events','memory_obligation_evidence','memory_obligation_repairs','memory_obligation_explanations','memory_obligation_legacy_resolutions'].map(table => `
CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'Project obligation evidence is append-only; updates forbidden'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'Project obligation evidence is append-only; deletion forbidden'); END;
`).join('')}
CREATE TRIGGER IF NOT EXISTS memory_obligations_no_replace BEFORE INSERT ON memory_obligations
WHEN EXISTS(SELECT 1 FROM memory_obligations WHERE id=NEW.id OR (conversation_id=NEW.conversation_id AND user_seq=NEW.user_seq))
BEGIN SELECT RAISE(ABORT, 'Project obligation is append-only; replacement forbidden'); END;
CREATE TRIGGER IF NOT EXISTS memory_obligation_events_no_replace BEFORE INSERT ON memory_obligation_events
WHEN EXISTS(SELECT 1 FROM memory_obligation_events WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'Project obligation event is append-only; replacement forbidden'); END;
CREATE TRIGGER IF NOT EXISTS memory_obligation_evidence_no_replace BEFORE INSERT ON memory_obligation_evidence
WHEN EXISTS(SELECT 1 FROM memory_obligation_evidence WHERE id=NEW.id OR proposal_id=NEW.proposal_id)
BEGIN SELECT RAISE(ABORT, 'Proposal evidence cannot be replaced or reused by another turn'); END;
CREATE TRIGGER IF NOT EXISTS memory_obligation_repairs_no_replace BEFORE INSERT ON memory_obligation_repairs
WHEN EXISTS(SELECT 1 FROM memory_obligation_repairs WHERE conversation_id=NEW.conversation_id AND user_seq=NEW.user_seq)
BEGIN SELECT RAISE(ABORT, 'Obligation repair may be claimed only once'); END;
CREATE TRIGGER IF NOT EXISTS memory_obligation_legacy_resolutions_no_replace BEFORE INSERT ON memory_obligation_legacy_resolutions
WHEN EXISTS(SELECT 1 FROM memory_obligation_legacy_resolutions WHERE id=NEW.id OR (conversation_id=NEW.conversation_id AND user_seq=NEW.user_seq))
BEGIN SELECT RAISE(ABORT, 'Legacy obligation resolution is append-only; replacement forbidden'); END;
CREATE TRIGGER IF NOT EXISTS memory_obligation_explanations_no_replace BEFORE INSERT ON memory_obligation_explanations
WHEN EXISTS(SELECT 1 FROM memory_obligation_explanations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'Obligation explanation is append-only; replacement forbidden'); END;
`;
