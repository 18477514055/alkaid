import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryKind, MemoryProposal, MemoryRecord } from '../../shared/memory.ts';
import { EXPERIENCE_CATEGORIES, LESSON_CATEGORIES } from '../../shared/memory-records.ts';
import type {
  ArchiveEntry, ArchivePage, ArchiveQuery, ArchiveSnapshot, GoalContent, GoalNode, GoalTree,
  LessonContent, LessonEntry, LessonSearch, MemoryIndex, MergePreservedInput, NoteContent,
  PreservedEntry, PreservedView, RecordIssue,
} from '../../shared/memory-records.ts';

type Row = Record<string, unknown>;
function fail(statusCode: 400 | 404 | 409, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function string(value: unknown, field: string, max = 2000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(400, `缺少或无效的${field}`);
}
function strings(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 50) fail(400, `${field}必须是最多50条的列表`);
  value.forEach(v => string(v, field));
}
function object(content: string): Row | null {
  try { const v: unknown = JSON.parse(content); return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : null; }
  catch { return null; }
}
export function parseGoalContent(content: string): GoalContent {
  const v = object(content);
  if (!v) fail(400, '目标必须包含parentId、state、keyResults、lessons结构');
  if (v['parentId'] !== null) string(v['parentId'], '父目标parentId', 200);
  if (!['root', 'active', 'paused', 'done', 'dropped'].includes(v['state'] as string)) fail(400, '目标状态state无效');
  strings(v['keyResults'], '关键结果keyResults');
  strings(v['lessons'], '目标教训lessons');
  if (v['body'] !== undefined) string(v['body'], '目标正文', 18_000);
  return v as GoalContent;
}
export function parseLessonContent(content: string): LessonContent {
  const v = object(content);
  if (!v || !['lesson', 'experience'].includes(v['type'] as string)) fail(400, '教训/经验必须声明type为lesson或experience');
  if (v['type'] === 'lesson') {
    string(v['rootCause'], '根因rootCause');
    if (!(LESSON_CATEGORIES as readonly unknown[]).includes(v['category'])) fail(400, '教训分类category无效');
  } else {
    string(v['source'], '出处source');
    if (!(EXPERIENCE_CATEGORIES as readonly unknown[]).includes(v['category'])) fail(400, '经验分类category无效');
  }
  string(v['body'], '正文body', 18_000);
  string(v['fix'], '正确做法fix', 4000);
  for (const field of ['rootCause', 'source', 'symptom', 'scope']) if (v[field] !== undefined) string(v[field], field);
  return v as LessonContent;
}
export function parseNoteContent(content: string): NoteContent | null {
  const v = object(content);
  if (!v || !Object.hasOwn(v, 'type') || Object.hasOwn(v, '$memory')) return null;
  if (!['problem', 'research', 'other'].includes(v['type'] as string)) fail(400, '笔记type必须为problem/research/other');
  if (v['type'] === 'problem') string(v['rootCause'], '问题笔记根因rootCause');
  if (v['type'] === 'research') string(v['conclusion'], '调研笔记结论conclusion');
  string(v['body'], '笔记正文body', 18_000);
  for (const field of ['rootCause', 'conclusion']) if (v[field] !== undefined) string(v[field], field, 4000);
  if (v['documentName'] !== undefined) {
    string(v['documentName'], 'documentName', 240);
    if (!/^\d{4}-\d{2}-\d{2}-[^/\\\x00-\x1f]+\.md$/.test(v['documentName'] as string)) fail(400, '笔记名称必须是日期标题，不是外部文件路径');
  }
  return v as NoteContent;
}
/** Pure validation shared by submission AND both official application paths. Legacy reads remain available. */
export function validateStructuredRecordContent(kind: MemoryKind, operation: 'upsert' | 'delete', content: string): void {
  if (operation === 'delete') return;
  if (kind === 'goal') parseGoalContent(content);
  if (kind === 'lesson') parseLessonContent(content);
  if (kind === 'note') parseNoteContent(content);
}
export function renderGoalContent(data: GoalContent): string {
  return [`状态：${data.state}`, `父目标：${data.parentId ?? '根目标'}`, data.body ?? '',
    '关键结果：', ...data.keyResults.map(s => `- ${s}`), '教训：', ...data.lessons.map(s => `- ${s}`)].join('\n');
}
export function renderLessonContent(data: LessonContent): string {
  return [`${data.type === 'lesson' ? '教训' : '经验'} · ${data.category}`, `正文：${data.body}`,
    data.rootCause ? `根因：${data.rootCause}` : '', data.source ? `出处：${data.source}` : '',
    data.symptom ? `症状：${data.symptom}` : '', `正确做法：${data.fix}`, data.scope ? `适用范围：${data.scope}` : ''].filter(Boolean).join('\n');
}
export function renderNoteContent(data: NoteContent): string {
  return [data.documentName ?? '', data.body, data.rootCause ? `根因：${data.rootCause}` : '', data.conclusion ? `结论：${data.conclusion}` : ''].filter(Boolean).join('\n');
}
function exists(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function requireProject(db: DatabaseSync, projectId: string, writable = false): void {
  string(projectId, '项目ID', 200);
  const row = db.prepare('SELECT archived_at FROM projects WHERE id=?').get(projectId);
  if (!row) fail(404, '项目不存在');
  if (writable && row['archived_at'] !== null) fail(409, '项目已归档，不能写入');
}
function fromRecord(row: Row): MemoryRecord {
  return { id: row['record_id'] as string, kind: row['kind'] as MemoryKind, title: row['title'] as string,
    content: row['content'] as string, revision: Number(row['revision']), deleted: !!row['deleted'], updatedAt: row['updated_at'] as string };
}
function records(db: DatabaseSync, projectId: string): MemoryRecord[] {
  requireProject(db, projectId);
  return db.prepare('SELECT * FROM memory_records WHERE project_id=? AND deleted=0 ORDER BY record_id').all(projectId).map(fromRecord);
}
/** Reserve a logical DB document name; never writes or resolves a filesystem path. Called within submit transaction. */
export function prepareStructuredProposalContent(db: DatabaseSync, projectId: string, recordId: string, title: string, kind: MemoryKind, operation: 'upsert' | 'delete', content: string): string {
  validateStructuredRecordContent(kind, operation, content);
  if (kind !== 'note' || operation !== 'upsert') return content;
  const data = parseNoteContent(content);
  if (!data) return content;
  const saved = db.prepare('SELECT document_name FROM memory_note_documents WHERE project_id=? AND record_id=?').get(projectId, recordId);
  const stem = title.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-').slice(0, 80) || '笔记';
  const name = saved?.['document_name'] as string | undefined ?? `${new Date().toISOString().slice(0, 10)}-${stem}-${createHash('sha256').update(recordId).digest('hex').slice(0, 16)}.md`;
  if (data.documentName !== undefined && data.documentName !== name) fail(400, '笔记文档名称由系统生成，不能覆盖其他文档');
  if (!saved) db.prepare('INSERT INTO memory_note_documents(project_id,record_id,document_name) VALUES(?,?,?)').run(projectId, recordId, name);
  const normalized = JSON.stringify({ ...data, documentName: name });
  if (normalized.length > 20_000) fail(400, '规范化笔记内容超过20000字符');
  return normalized;
}
export function validateStructuredApplication(db: DatabaseSync, projectId: string, recordId: string, kind: MemoryKind, operation: 'upsert' | 'delete', content: string): void {
  validateStructuredRecordContent(kind, operation, content);
  if (kind !== 'note' || operation !== 'upsert') return;
  const data = parseNoteContent(content);
  if (!data) return;
  const row = db.prepare('SELECT document_name FROM memory_note_documents WHERE project_id=? AND record_id=?').get(projectId, recordId);
  if (!row || data.documentName !== row['document_name']) fail(400, '结构笔记缺少已登记的documentName，需重新提交有效提案');
}
function archiveEntry(row: Row): ArchiveEntry {
  return { id: row['id'] as string, projectId: row['project_id'] as string, recordId: row['record_id'] as string,
    projectRevision: Number(row['project_revision']), before: row['before_json'] ? JSON.parse(row['before_json'] as string) as MemoryRecord : null,
    after: JSON.parse(row['after_json'] as string) as MemoryRecord, sourceId: row['source_id'] as string, createdAt: row['created_at'] as string };
}
function dateBound(value: string | undefined, end: boolean): string | undefined {
  if (value === undefined) return undefined;
  string(value, '时间', 40);
  const input = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : value;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(input) || !Number.isFinite(Date.parse(input))) fail(400, '时间必须是ISO时间或YYYY-MM-DD');
  return new Date(input).toISOString();
}
export function listMemoryArchive(db: DatabaseSync, projectId: string, query: ArchiveQuery = {}): ArchivePage {
  requireProject(db, projectId);
  const limit = query.limit ?? 50, offset = query.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 50_000) fail(400, '归档分页limit/offset无效');
  const clauses = ['project_id=?']; const params: (string | number)[] = [projectId];
  if (query.recordId !== undefined) { string(query.recordId, '记录ID', 200); clauses.push('record_id=?'); params.push(query.recordId); }
  const from = dateBound(query.from, false), to = dateBound(query.to, true);
  if (from && to && from > to) fail(400, '归档起始时间晚于结束时间');
  if (from) { clauses.push('created_at>=?'); params.push(from); }
  if (to) { clauses.push('created_at<=?'); params.push(to); }
  if (query.revision !== undefined) {
    if (!Number.isSafeInteger(query.revision) || query.revision < 1) fail(400, '记录版本revision无效');
    clauses.push("CAST(json_extract(after_json,'$.revision') AS INTEGER)=?"); params.push(query.revision);
  }
  const where = clauses.join(' AND ');
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM memory_history WHERE ${where}`).get(...params)?.['n']);
  const rows = db.prepare(`SELECT * FROM memory_history WHERE ${where} ORDER BY created_at DESC,project_revision DESC,id LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { entries: rows.map(archiveEntry), total, limit, offset };
}
export function getMemoryArchiveSnapshot(db: DatabaseSync, projectId: string, historyId: string, side: 'before' | 'after' = 'after'): ArchiveSnapshot {
  requireProject(db, projectId); string(historyId, '归档ID', 200);
  if (side !== 'before' && side !== 'after') fail(400, '归档side必须为before或after');
  const row = db.prepare('SELECT * FROM memory_history WHERE project_id=? AND id=?').get(projectId, historyId);
  if (!row) fail(404, '归档不存在');
  const entry = archiveEntry(row);
  return { entry, side, snapshot: entry[side] };
}
export function refuseArchiveMutation(db: DatabaseSync, projectId: string, historyId: string): never {
  getMemoryArchiveSnapshot(db, projectId, historyId);
  fail(409, '历史归档只允许追加，不能删除或修改');
}
/** Root > active > paused. Completed goals decay with age; lessons retain a premium. */
export function goalWeight(data: GoalContent, updatedAt: string, now = Date.now()): number {
  const days = Math.max(0, (now - Date.parse(updatedAt)) / 86_400_000) || 0;
  const age = 100 / (1 + days / 30);
  const base = data.parentId === null || data.state === 'root' ? 1_000_000 : data.state === 'active' ? 10_000 : data.state === 'paused' ? 5000 : data.state === 'done' ? 1000 : 100;
  return Number((base + age + (data.lessons.length ? 2000 : 0)).toFixed(6));
}
export function getGoalTree(db: DatabaseSync, projectId: string, now = Date.now()): GoalTree {
  const issues: RecordIssue[] = [];
  const nodes: GoalNode[] = records(db, projectId).filter(r => r.kind === 'goal').map(record => {
    try { const data = parseGoalContent(record.content); return { record, data, childrenIds: [], depth: null, weight: goalWeight(data, record.updatedAt, now) }; }
    catch { issues.push({ recordId: record.id, code: 'legacy-format', message: '旧目标缺少有效结构；原文保留，需提交结构化更新' }); return { record, data: null, childrenIds: [], depth: null, weight: 0 }; }
  });
  const byId = new Map(nodes.map(n => [n.record.id, n]));
  const roots: string[] = [];
  for (const node of nodes) {
    if (!node.data) continue;
    if (node.data.parentId === null) { roots.push(node.record.id); node.depth = 0; }
    else {
      const parent = byId.get(node.data.parentId);
      if (!parent) issues.push({ recordId: node.record.id, code: 'missing-parent', message: `父目标不存在：${node.data.parentId}` });
      else parent.childrenIds.push(node.record.id);
      if (node.data.state === 'root') issues.push({ recordId: node.record.id, code: 'root-has-parent', message: '根目标状态不能带父目标' });
    }
    const visited = new Set<string>([node.record.id]); let parentId = node.data.parentId; let depth = 0;
    while (parentId !== null) {
      if (visited.has(parentId)) { issues.push({ recordId: node.record.id, code: 'cycle', message: '目标父子关系存在环' }); depth = -1; break; }
      visited.add(parentId); const p = byId.get(parentId);
      if (!p?.data) { depth = -1; break; }
      depth++; parentId = p.data.parentId;
    }
    if (depth >= 0) node.depth = depth;
  }
  const compare = (a: GoalNode, b: GoalNode) => b.weight - a.weight || a.record.id.localeCompare(b.record.id, 'en');
  nodes.sort(compare);
  for (const n of nodes) n.childrenIds.sort((a, b) => compare(byId.get(a)!, byId.get(b)!));
  roots.sort((a, b) => compare(byId.get(a)!, byId.get(b)!));
  return { projectId, nodes, roots, issues };
}
export function searchMemoryLessons(db: DatabaseSync, projectId: string, query: { type?: string; category?: string; q?: string } = {}): LessonSearch {
  if (query.type !== undefined && !['lesson', 'experience'].includes(query.type)) fail(400, '教训检索type无效');
  if (query.category !== undefined) string(query.category, '分类', 100);
  if (query.q !== undefined) string(query.q, '关键词', 200);
  const issues: RecordIssue[] = [];
  const entries: LessonEntry[] = [];
  for (const record of records(db, projectId).filter(r => r.kind === 'lesson')) {
    let data: LessonContent | null = null; const own: RecordIssue[] = [];
    try { data = parseLessonContent(record.content); }
    catch { own.push({ recordId: record.id, code: 'legacy-format', message: '旧教训/经验缺少根因或出处等结构；原文保留' }); issues.push(...own); }
    if (query.type && data?.type !== query.type || query.category && data?.category !== query.category) continue;
    const rendered = data ? renderLessonContent(data) : record.content;
    if (query.q && !`${record.title}\n${rendered}`.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) continue;
    entries.push({ record, data, rendered, issues: own });
  }
  return { projectId, entries, issues };
}
export function getMemoryIndex(db: DatabaseSync, projectId: string): MemoryIndex {
  const rows = records(db, projectId);
  const counts = new Map(db.prepare('SELECT record_id,COUNT(*) AS n FROM memory_proposals WHERE project_id=? GROUP BY record_id').all(projectId).map(r => [r['record_id'] as string, Number(r['n'])]));
  const importance: Record<MemoryKind, number> = { principle: 100, active: 90, decision: 80, goal: 70, lesson: 60, note: 30 };
  const values = rows.map(r => ({ record: r, importance: importance[r.kind], recency: Date.parse(r.updatedAt) || 0, stability: -r.revision, references: counts.get(r.id) ?? 0, volume: r.content.length }));
  const dimensions = ['importance', 'recency', 'stability', 'references', 'volume'] as const;
  const ranks = new Map(rows.map(r => [r.id, { importance: 0, recency: 0, stability: 0, references: 0, volume: 0 }]));
  for (const dim of dimensions) {
    const ordered = [...values].sort((a, b) => b[dim] - a[dim] || a.record.id.localeCompare(b.record.id, 'en'));
    let rank = 1;
    ordered.forEach((v, i) => { if (i > 0 && v[dim] !== ordered[i - 1]![dim]) rank = i + 1; ranks.get(v.record.id)![dim] = rank; });
  }
  const weights = { importance: 3, recency: 1.5, stability: 0.8, references: 1, volume: 0.3 };
  return { projectId, diagnosticOnly: true, rows: rows.map(r => {
    const rank = ranks.get(r.id)!;
    const score = dimensions.reduce((sum, d) => sum + weights[d] * (1 - (rank[d] - 1) / Math.max(1, rows.length - 1)), 0);
    return { recordId: r.id, kind: r.kind, title: r.title, score: Number(score.toFixed(6)), ranks: rank };
  }).sort((a, b) => b.score - a.score || a.recordId.localeCompare(b.recordId, 'en')) };
}
function proposalFromRow(row: Row): MemoryProposal {
  return { id: row['id'] as string, projectId: row['project_id'] as string, conversationId: row['conversation_id'] as string,
    resourceType: 'ledger', recordId: row['record_id'] as string, kind: row['kind'] as MemoryKind, title: row['title'] as string,
    operation: row['operation'] as 'upsert' | 'delete', content: row['content'] as string, baseRevision: Number(row['base_revision']),
    reason: row['reason'] as string, status: row['status'] as MemoryProposal['status'], createdAt: row['created_at'] as string, resolvedAt: row['resolved_at'] as string | null };
}
/** Submission retains current A separately from B's pending proposal; neither becomes prompt material. */
export function preserveConcurrentRecord(db: DatabaseSync, projectId: string, p: MemoryProposal, current: MemoryRecord | undefined): void {
  if (!current || current.revision === p.baseRevision) return;
  if (!exists(db, 'memory_preserved')) fail(409, '并发保留区迁移尚未完成');
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_preserved WHERE project_id=?').get(projectId)?.['n']);
  if (n >= 2000) fail(409, '并发保留区已达2000条上限，请先导出审阅');
  const history = db.prepare('SELECT source_id FROM memory_history WHERE project_id=? AND record_id=? ORDER BY project_revision DESC LIMIT 1').get(projectId, current.id);
  const sourceId = history?.['source_id'] as string | undefined;
  const sources = new Set<string>();
  if (sourceId) {
    const direct = db.prepare('SELECT conversation_id FROM memory_proposals WHERE project_id=? AND id=?').get(projectId, sourceId);
    if (direct) sources.add(direct['conversation_id'] as string);
    const job = db.prepare('SELECT proposal_ids FROM memory_jobs WHERE project_id=? AND id=?').get(projectId, sourceId);
    if (job) for (const id of JSON.parse(job['proposal_ids'] as string) as string[]) {
      const source = db.prepare('SELECT conversation_id FROM memory_proposals WHERE project_id=? AND id=?').get(projectId, id);
      if (source) sources.add(source['conversation_id'] as string);
    }
  }
  db.prepare('INSERT INTO memory_preserved VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), projectId, current.id, p.id, JSON.stringify(current), sourceId ?? null, JSON.stringify([...sources].sort()), new Date().toISOString());
}
export function getPreservedMemory(db: DatabaseSync, projectId: string, includeResolved = false): PreservedView {
  requireProject(db, projectId);
  const rows = db.prepare(`SELECT p.*,r.merge_proposal_id,r.created_at AS resolution_at FROM memory_preserved p
    LEFT JOIN memory_preserved_resolutions r ON r.project_id=p.project_id AND r.preserved_id=p.id
    WHERE p.project_id=? ${includeResolved ? '' : 'AND r.id IS NULL'} ORDER BY p.created_at,p.id LIMIT 2000`).all(projectId);
  const entries: PreservedEntry[] = rows.map(row => {
    const p = db.prepare('SELECT * FROM memory_proposals WHERE project_id=? AND id=?').get(projectId, row['proposal_id'] as string);
    if (!p) fail(409, '保留区来源提案缺失');
    return { id: row['id'] as string, projectId, recordId: row['record_id'] as string, proposalId: row['proposal_id'] as string,
      current: JSON.parse(row['current_json'] as string) as MemoryRecord, sourceId: row['source_id'] as string | null,
      sourceConversationIds: JSON.parse(row['source_conversations_json'] as string) as string[], proposal: proposalFromRow(p), createdAt: row['created_at'] as string,
      resolution: row['merge_proposal_id'] ? { mergeProposalId: row['merge_proposal_id'] as string, createdAt: row['resolution_at'] as string } : null };
  });
  return { projectId, entries };
}
export function validatePreservedMerge(db: DatabaseSync, projectId: string, input: MergePreservedInput): { kind: MemoryKind; baseRevision: number; entries: PreservedEntry[] } {
  requireProject(db, projectId, true);
  if (!input || typeof input !== 'object') fail(400, '合并请求无效');
  if (!Array.isArray(input.preservedIds) || input.preservedIds.length < 1 || input.preservedIds.length > 50 || new Set(input.preservedIds).size !== input.preservedIds.length) fail(400, 'preservedIds必须为1至50个不同保留条目');
  input.preservedIds.forEach(id => string(id, '保留条目ID', 200));
  string(input.recordId, '记录ID', 200);
  const all = getPreservedMemory(db, projectId).entries;
  const entries = input.preservedIds.map(id => { const e = all.find(e => e.id === id); if (!e) fail(404, '未合并的保留条目不存在'); return e; });
  if (entries.some(e => e.recordId !== input.recordId)) fail(400, '一次合并只能涉及同一条记录');
  const current = db.prepare('SELECT * FROM memory_records WHERE project_id=? AND record_id=?').get(projectId, input.recordId);
  if (!current || current['kind'] === 'principle') fail(400, '不能合并原则或缺失记录');
  const k = current['kind'] as MemoryKind;
  if (entries.some(e => e.proposal.kind !== k)) fail(400, '保留区记录类型不一致');
  return { kind: k, baseRevision: Number(current['revision']), entries };
}
export function linkPreservedMerge(db: DatabaseSync, projectId: string, proposalId: string, preservedIds: string[]): void {
  for (const id of preservedIds) db.prepare('INSERT INTO memory_preserved_merges VALUES(?,?,?)').run(projectId, proposalId, id);
}
/** Called only after formal record commit, in the SAME transaction. Append resolution; never delete A/B. */
export function resolvePreservedMerge(db: DatabaseSync, projectId: string, appliedProposalIds: string[]): void {
  if (!exists(db, 'memory_preserved_merges')) return;
  for (const id of appliedProposalIds) {
    const links = db.prepare('SELECT preserved_id FROM memory_preserved_merges WHERE project_id=? AND proposal_id=?').all(projectId, id);
    for (const link of links) {
      const resolved = db.prepare('SELECT id FROM memory_preserved_resolutions WHERE project_id=? AND preserved_id=?').get(projectId, link['preserved_id'] as string);
      if (resolved) fail(409, '保留条目已经由另一提案合并，不能再次覆盖');
      const resolvedAt = new Date().toISOString();
      db.prepare('INSERT INTO memory_preserved_resolutions VALUES(?,?,?,?,?)').run(randomUUID(), projectId, link['preserved_id'] as string, id, resolvedAt);
      // The independently approved merge incorporates this old source proposal.
      // Retire it from the pending queue too, or it can spuriously trigger another
      // paid maintenance batch after its preservation region has already resolved.
      db.prepare(`UPDATE memory_proposals SET status='applied', resolved_at=?
        WHERE project_id=? AND id=(SELECT proposal_id FROM memory_preserved WHERE project_id=? AND id=?)
          AND status IN ('pending','conflict')`).run(resolvedAt, projectId, projectId, link['preserved_id'] as string);
    }
  }
}
