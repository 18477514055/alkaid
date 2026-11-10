/** V8 fragment: existing memory_history already contains FULL snapshots.
 * Add append-only guards, not a second archive or workspace-file copies.
 */
export const MEMORY_RECORDS_SCHEMA_SQL = `
CREATE TRIGGER IF NOT EXISTS memory_history_no_replace BEFORE INSERT ON memory_history
WHEN EXISTS(SELECT 1 FROM memory_history WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, '归档只允许追加，不能替换历史'); END;
CREATE TRIGGER IF NOT EXISTS memory_history_no_update BEFORE UPDATE ON memory_history
BEGIN SELECT RAISE(ABORT, '归档只允许追加，不能修改历史'); END;
CREATE TRIGGER IF NOT EXISTS memory_history_no_delete BEFORE DELETE ON memory_history
BEGIN SELECT RAISE(ABORT, '归档只允许追加，不能删除历史'); END;
CREATE INDEX IF NOT EXISTS idx_memory_history_time ON memory_history(project_id, created_at, id);
CREATE TABLE IF NOT EXISTS memory_preserved (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE,
  current_json TEXT NOT NULL,
  source_id TEXT,
  source_conversations_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_preserved_project ON memory_preserved(project_id, record_id);
CREATE TABLE IF NOT EXISTS memory_preserved_merges (
  project_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  preserved_id TEXT NOT NULL,
  PRIMARY KEY (project_id, proposal_id, preserved_id)
);
CREATE TABLE IF NOT EXISTS memory_preserved_resolutions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  preserved_id TEXT NOT NULL UNIQUE,
  merge_proposal_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_note_documents (
  project_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  document_name TEXT NOT NULL,
  PRIMARY KEY (project_id, record_id),
  UNIQUE (project_id, document_name)
);
CREATE TRIGGER IF NOT EXISTS memory_preserved_no_replace BEFORE INSERT ON memory_preserved
WHEN EXISTS(SELECT 1 FROM memory_preserved WHERE id=NEW.id OR proposal_id=NEW.proposal_id)
BEGIN SELECT RAISE(ABORT, '保留区历史只允许追加，不能替换'); END;
CREATE TRIGGER IF NOT EXISTS memory_preserved_merges_no_replace BEFORE INSERT ON memory_preserved_merges
WHEN EXISTS(SELECT 1 FROM memory_preserved_merges WHERE project_id=NEW.project_id AND proposal_id=NEW.proposal_id AND preserved_id=NEW.preserved_id)
BEGIN SELECT RAISE(ABORT, '保留区合并来源只允许追加，不能替换'); END;
CREATE TRIGGER IF NOT EXISTS memory_preserved_merges_no_update BEFORE UPDATE ON memory_preserved_merges
BEGIN SELECT RAISE(ABORT, '保留区合并来源只允许追加'); END;
CREATE TRIGGER IF NOT EXISTS memory_preserved_merges_no_delete BEFORE DELETE ON memory_preserved_merges
BEGIN SELECT RAISE(ABORT, '保留区合并来源不能删除'); END;
CREATE TRIGGER IF NOT EXISTS memory_preserved_resolution_no_replace BEFORE INSERT ON memory_preserved_resolutions
WHEN EXISTS(SELECT 1 FROM memory_preserved_resolutions WHERE id=NEW.id OR preserved_id=NEW.preserved_id)
BEGIN SELECT RAISE(ABORT, '保留区合并结果只允许追加，不能替换'); END;
CREATE TRIGGER IF NOT EXISTS memory_note_documents_no_replace BEFORE INSERT ON memory_note_documents
WHEN EXISTS(SELECT 1 FROM memory_note_documents WHERE project_id=NEW.project_id AND (record_id=NEW.record_id OR document_name=NEW.document_name))
BEGIN SELECT RAISE(ABORT, '笔记文档名称不能覆盖复用'); END;
CREATE TRIGGER IF NOT EXISTS memory_preserved_no_update BEFORE UPDATE ON memory_preserved
BEGIN SELECT RAISE(ABORT, '保留区历史只允许追加'); END;
CREATE TRIGGER IF NOT EXISTS memory_preserved_no_delete BEFORE DELETE ON memory_preserved
BEGIN SELECT RAISE(ABORT, '保留区历史不能删除，只能追加合并结果'); END;
CREATE TRIGGER IF NOT EXISTS memory_preserved_resolution_no_update BEFORE UPDATE ON memory_preserved_resolutions
BEGIN SELECT RAISE(ABORT, '保留区合并结果只允许追加'); END;
CREATE TRIGGER IF NOT EXISTS memory_preserved_resolution_no_delete BEFORE DELETE ON memory_preserved_resolutions
BEGIN SELECT RAISE(ABORT, '保留区合并结果不能删除'); END;
CREATE TRIGGER IF NOT EXISTS memory_note_documents_no_update BEFORE UPDATE ON memory_note_documents
BEGIN SELECT RAISE(ABORT, '笔记文档名称不能覆盖'); END;
CREATE TRIGGER IF NOT EXISTS memory_note_documents_no_delete BEFORE DELETE ON memory_note_documents
BEGIN SELECT RAISE(ABORT, '笔记文档名称不能删除复用'); END;
`;
