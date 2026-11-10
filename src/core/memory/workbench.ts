import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../../config.ts';
import type { MemoryKind, MemoryRecord } from '../../shared/memory.ts';
import type {
  ArtifactType, ExtensionDefinition, ExtensionEntry, Handoff, IntentEntry, PrincipleAudit,
  PrincipleCurrent, PrincipleProposal, PrincipleReviewCheck, TriageEntry, TriageView, UserQuote, UserQuoteGroup,
  WorkbenchArtifact, WorkbenchView,
} from '../../shared/memory-workbench.ts';

type Row = Record<string, unknown>;
export type WorkbenchQuery = { q?: string; from?: string; to?: string; conversationId?: string; limit?: number };
const TYPES = ['triage', 'handoff', 'intent', 'extension-entry'] as const;
const DEFAULT_MEMORY_CONFIG = { enabled: false, providerId: null, model: null, quietMs: 15_000, maxInputChars: 64_000, maxOutputTokens: 4096 };
const CREDENTIAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"']{8,}/i;
function fail(statusCode: 400 | 403 | 404 | 409, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function object(value: unknown): value is Row { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Row {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail(400, 'Invalid workbench fields');
}
function text(value: unknown, name: string, max = 4000, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) fail(400, `Invalid ${name}`);
  if (CREDENTIAL.test(value)) fail(400, 'Memory must not contain credentials');
}
function id(value: unknown, name = 'id'): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail(400, `Invalid ${name}`);
}
function project(db: DatabaseSync, projectId: string, write = false): void {
  id(projectId, 'projectId');
  const row = db.prepare('SELECT archived_at FROM projects WHERE id=?').get(projectId);
  if (!row) fail(404, 'Project not found');
  if (write && row.archived_at !== null) fail(409, 'Project is archived');
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function count(db: DatabaseSync, table: string, projectId: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).get(projectId)?.n ?? 0);
}
function bounded(db: DatabaseSync, table: string, projectId: string, max: number, additional = 1): void {
  if (count(db, table, projectId) + additional > max) fail(409, 'Workbench storage limit reached');
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function limit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) fail(400, 'Invalid query limit');
  return value;
}
function filters(query: WorkbenchQuery): { sql: string; args: string[] } {
  const clauses: string[] = [];
  const args: string[] = [];
  for (const [key, operator] of [['from', '>='], ['to', '<=']] as const) {
    const value = query[key];
    if (value !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, 'Invalid timestamp');
      clauses.push(`created_at ${operator} ?`); args.push(new Date(value).toISOString());
    }
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) fail(400, 'Invalid time range');
  if (query.conversationId !== undefined) { id(query.conversationId, 'conversationId'); clauses.push('conversation_id=?'); args.push(query.conversationId); }
  if (query.q !== undefined) text(query.q, 'query', 500, true);
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', args };
}
function matches(q: string | undefined, ...parts: string[]): boolean { return !q || parts.join('\n').toLocaleLowerCase().includes(q.toLocaleLowerCase()); }
function definition(db: DatabaseSync, projectId: string, extensionId: string): Row {
  id(extensionId, 'extensionId');
  const row = db.prepare('SELECT * FROM memory_extension_definitions WHERE project_id=? AND id=?').get(projectId, extensionId);
  if (!row) fail(404, 'Extension not found');
  return row;
}
function parseArtifact(db: DatabaseSync, projectId: string, recordId: string, kind: MemoryKind, operation: string, content: string): { artifact: WorkbenchArtifact; artifactId: string } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { if (recordId.startsWith('artifact:')) fail(400, 'Artifact requires valid JSON'); return null; }
  const tagged = object(parsed) && Object.hasOwn(parsed, '$memory');
  if (!recordId.startsWith('artifact:') && !tagged) return null;
  const match = /^artifact:(triage|handoff|intent|extension-entry):([A-Za-z0-9_-]{1,100})$/.exec(recordId);
  if (!match || kind !== 'note' || operation !== 'upsert' || !object(parsed) || !Object.hasOwn(parsed, '$memory') || parsed.$memory !== match[1]) fail(400, 'Invalid or forged workbench artifact');
  project(db, projectId, true);
  if (content.length > 20_000) fail(400, 'Artifact content limit exceeded');
  if (CREDENTIAL.test(content)) fail(400, 'Memory must not contain credentials');
  if (parsed.$memory === 'triage') {
    shape(parsed, ['$memory', 'keep', 'stash', 'drop'], ['releaseKeepIds']);
    let total = 0;
    for (const bucket of ['keep', 'stash', 'drop'] as const) {
      const items = parsed[bucket];
      if (!Array.isArray(items)) fail(400, 'Invalid triage bucket');
      total += items.length;
      for (const item of items) {
        shape(item, ['what'], ['why', 'where']); text(item.what, 'triage what');
        if (item.why !== undefined) text(item.why, 'triage why', 2000, true);
        if (item.where !== undefined) text(item.where, 'triage where', 2000, true);
      }
    }
    const releases = parsed.releaseKeepIds ?? [];
    if (!Array.isArray(releases) || releases.length > 12 || new Set(releases).size !== releases.length) fail(400, 'Invalid keep releases');
    for (const keepId of releases) {
      text(keepId, 'keep id', 200);
      const row = db.prepare("SELECT id FROM memory_triage_entries WHERE project_id=? AND id=? AND bucket='keep'").get(projectId, keepId);
      if (!row || db.prepare('SELECT id FROM memory_triage_releases WHERE project_id=? AND keep_id=?').get(projectId, keepId)) fail(409, 'Keep entry is unavailable or already released');
    }
    if (total + releases.length > 12 || (!total && !releases.length)) fail(400, 'Triage batch must contain 1 to 12 entries');
    const active = Number(db.prepare("SELECT COUNT(*) AS n FROM memory_triage_entries e WHERE e.project_id=? AND e.bucket='keep' AND NOT EXISTS(SELECT 1 FROM memory_triage_releases r WHERE r.project_id=e.project_id AND r.keep_id=e.id)").get(projectId)?.n ?? 0);
    if (active - releases.length + (parsed.keep as unknown[]).length > 40) fail(409, 'Active keep limit is 40; release old keep entries first');
    const existingKeep = db.prepare("SELECT e.id,e.what FROM memory_triage_entries e WHERE e.project_id=? AND e.bucket='keep' AND NOT EXISTS(SELECT 1 FROM memory_triage_releases r WHERE r.project_id=e.project_id AND r.keep_id=e.id)").all(projectId);
    const keepChars = existingKeep.filter(row => !releases.includes(row.id)).reduce((sum, row) => sum + String(row.what).length, 0)
      + (parsed.keep as { what: string }[]).reduce((sum, item) => sum + item.what.length, 0);
    if (keepChars > 6000) fail(409, 'Active keep character limit is 6000; release old keep entries first');
    const stash = Number(db.prepare("SELECT COUNT(*) AS n FROM memory_triage_entries WHERE project_id=? AND bucket='stash'").get(projectId)?.n ?? 0);
    if (stash + (parsed.stash as unknown[]).length > 2000) fail(409, 'Stash storage limit reached');
    bounded(db, 'memory_triage_entries', projectId, 20_000, total);
  } else if (parsed.$memory === 'handoff') {
    shape(parsed, ['$memory', 'title', 'did', 'state', 'next', 'files', 'blocked']);
    text(parsed.title, 'handoff title', 200);
    for (const field of ['did', 'state', 'next', 'blocked']) text(parsed[field], `handoff ${field}`, 4000, field === 'blocked');
    if (!Array.isArray(parsed.files) || parsed.files.length > 40) fail(400, 'Invalid handoff files');
    for (const path of parsed.files) { text(path, 'handoff file', 1000); if (!isAbsolute(path) && !win32.isAbsolute(path)) fail(400, 'Handoff files must be absolute paths'); }
    bounded(db, 'memory_handoffs', projectId, 2000);
  } else if (parsed.$memory === 'intent') {
    shape(parsed, ['$memory', 'conversationId', 'goal', 'did', 'issues', 'next']);
    id(parsed.conversationId, 'conversationId');
    if (!db.prepare('SELECT id FROM conversations WHERE project_id=? AND id=?').get(projectId, parsed.conversationId)) fail(404, 'Source conversation not found in project');
    for (const field of ['goal', 'did', 'issues', 'next']) text(parsed[field], `intent ${field}`, 4000, field === 'issues');
    bounded(db, 'memory_intents', projectId, 10_000);
  } else if (parsed.$memory === 'extension-entry') {
    shape(parsed, ['$memory', 'extensionId', 'key', 'action', 'content']);
    id(parsed.extensionId, 'extensionId'); id(parsed.key, 'extension key');
    text(parsed.content, 'extension content', 16_000, parsed.action === 'delete');
    if (typeof parsed.action !== 'string' || !['append', 'replace', 'delete'].includes(parsed.action)) fail(400, 'Invalid extension action');
    const ext = definition(db, projectId, parsed.extensionId);
    if (ext.mode === 'single' && parsed.key !== 'main') fail(400, 'Single extension key must be main');
    if (ext.append_only === 1 && parsed.action !== 'append') fail(400, 'Append-only extension forbids replace and delete');
    bounded(db, 'memory_extension_entries', projectId, 10_000);
  } else fail(400, 'Unknown workbench artifact type');
  return { artifact: parsed as WorkbenchArtifact, artifactId: match[2]! };
}

/** Called by store inside its submit/apply transaction; plain records are untouched. */
export function validateWorkbenchArtifact(db: DatabaseSync, projectId: string, recordId: string, kind: MemoryKind, operation: string, content: string): void {
  const parsed = parseArtifact(db, projectId, recordId, kind, operation, content);
  if (parsed && db.prepare('SELECT record_id FROM memory_workbench_artifacts WHERE project_id=? AND record_id=?').get(projectId, recordId)) fail(409, 'Applied artifacts are append-only; create a new artifact');
}

/** No transaction nesting: the store owns the atomic official-record + domain commit. */
export function applyWorkbenchArtifact(db: DatabaseSync, projectId: string, sourceId: string, recordId: string, kind: MemoryKind, operation: string, content: string): void {
  validateWorkbenchArtifact(db, projectId, recordId, kind, operation, content);
  const parsed = parseArtifact(db, projectId, recordId, kind, operation, content);
  if (!parsed) return;
  const { artifact: value, artifactId } = parsed;
  const now = new Date().toISOString();
  bounded(db, 'memory_workbench_artifacts', projectId, 20_000);
  db.prepare('INSERT INTO memory_workbench_artifacts VALUES(?,?,?,?,?)').run(projectId, recordId, value.$memory, sourceId, now);
  if (value.$memory === 'triage') {
    for (const bucket of ['keep', 'stash', 'drop'] as const) value[bucket].forEach((item, index) => {
      db.prepare('INSERT INTO memory_triage_entries VALUES(?,?,?,?,?,?,?,?)').run(`${artifactId}:${bucket}:${index}`, projectId, bucket, item.what, item.why ?? '', item.where ?? '', sourceId, now);
    });
    for (const keepId of value.releaseKeepIds ?? []) db.prepare('INSERT INTO memory_triage_releases VALUES(?,?,?,?,?)').run(randomUUID(), projectId, keepId, sourceId, now);
  } else if (value.$memory === 'handoff') {
    db.prepare('INSERT INTO memory_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(artifactId, projectId, recordId, value.title, value.did, value.state, value.next, JSON.stringify(value.files), value.blocked, sourceId, now);
  } else if (value.$memory === 'intent') {
    db.prepare('INSERT INTO memory_intents VALUES(?,?,?,?,?,?,?,?,?)').run(artifactId, projectId, value.conversationId, value.goal, value.did, value.issues, value.next, sourceId, now);
  } else {
    db.prepare('INSERT INTO memory_extension_entries(id,project_id,extension_id,entry_key,action,content,source_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(artifactId, projectId, value.extensionId, value.key, value.action, value.content, sourceId, now);
  }
}

export function listActiveKeep(db: DatabaseSync, projectId: string): TriageEntry[] {
  project(db, projectId);
  return db.prepare("SELECT e.* FROM memory_triage_entries e WHERE e.project_id=? AND e.bucket='keep' AND NOT EXISTS(SELECT 1 FROM memory_triage_releases r WHERE r.project_id=e.project_id AND r.keep_id=e.id) ORDER BY e.created_at,e.id LIMIT 40").all(projectId).map(triageEntry);
}
function triageEntry(row: Row): TriageEntry {
  return { id: String(row.id), bucket: row.bucket as TriageEntry['bucket'], what: String(row.what), why: String(row.why), where: String(row.location), sourceId: String(row.source_id), createdAt: String(row.created_at) };
}
export function getTriage(db: DatabaseSync, projectId: string, query: WorkbenchQuery = {}): TriageView {
  project(db, projectId); const n = limit(query.limit); if (query.q !== undefined) text(query.q, 'query', 500, true);
  const rows = db.prepare('SELECT * FROM memory_triage_entries WHERE project_id=? ORDER BY created_at DESC,id').all(projectId).map(triageEntry);
  const releasedKeepIds = db.prepare('SELECT keep_id FROM memory_triage_releases WHERE project_id=? ORDER BY created_at,id').all(projectId).map(row => String(row.keep_id));
  const active = rows.filter(row => row.bucket !== 'keep' || !releasedKeepIds.includes(row.id));
  const bucket = (name: TriageEntry['bucket']) => active.filter(row => row.bucket === name && matches(query.q, row.what, row.why ?? '', row.where ?? '')).slice(0, name === 'keep' ? 40 : n);
  return { keep: bucket('keep'), stash: bucket('stash'), drop: bucket('drop'), releasedKeepIds,
    counts: { keep: active.filter(row => row.bucket === 'keep').length, stash: active.filter(row => row.bucket === 'stash').length, drop: active.filter(row => row.bucket === 'drop').length } };
}
function handoff(row: Row): Handoff {
  return { $memory: 'handoff', id: String(row.id), recordId: String(row.record_id), title: String(row.title), did: String(row.did), state: String(row.state), next: String(row.next), files: JSON.parse(String(row.files)) as string[], blocked: String(row.blocked), sourceId: String(row.source_id), createdAt: String(row.created_at) };
}
export function listHandoffs(db: DatabaseSync, projectId: string, max = 100): Handoff[] {
  project(db, projectId); return db.prepare('SELECT * FROM memory_handoffs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(projectId, limit(max)).map(handoff);
}
export function getLatestHandoff(db: DatabaseSync, projectId: string): Handoff | null { return listHandoffs(db, projectId, 1)[0] ?? null; }
export function getHandoff(db: DatabaseSync, projectId: string, handoffId: string): Handoff {
  project(db, projectId); id(handoffId, 'handoffId'); const row = db.prepare('SELECT * FROM memory_handoffs WHERE project_id=? AND id=?').get(projectId, handoffId);
  if (!row) fail(404, 'Handoff not found'); return handoff(row);
}
export function renderHandoff(value: Handoff): string {
  return `# ${value.title}\n\n## 做了什么\n${value.did}\n\n## 当前状态\n${value.state}\n\n## 下一步\n${value.next}\n\n## 关键文件路径\n${value.files.map(path => `- ${path}`).join('\n')}\n\n## 阻塞与待决策\n${value.blocked || '无'}\n\n---\nHandoff: ${value.id}\nCreated: ${value.createdAt}\n`;
}
export function materializeHandoff(db: DatabaseSync, config: Config, projectId: string, handoffId: string): { path: string; created: boolean } {
  const value = getHandoff(db, projectId, handoffId);
  const home = resolve(config.home); const dir = join(home, 'projects', projectId, 'handoffs');
  // Refuse reparse points anywhere below the chosen application home. Never
  // materialize through a workspace link or accept a caller-provided directory.
  let current = home;
  mkdirSync(home, { recursive: true });
  if (lstatSync(home).isSymbolicLink()) fail(409, 'Application home must not be a symlink');
  for (const part of ['projects', projectId, 'handoffs']) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(409, 'Handoff directory must not contain links');
    mkdirSync(current, { recursive: true });
  }
  if (relative(realpathSync(home), realpathSync(dir)).startsWith('..')) fail(409, 'Unsafe handoff directory');
  const slug = value.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/g, '').slice(0, 60) || 'handoff';
  const path = join(dir, `${value.createdAt.slice(0, 10)}-${slug}-${value.id}.md`);
  const content = renderHandoff(value);
  try { writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); return { path, created: true }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (lstatSync(path).isSymbolicLink() || readFileSync(path, 'utf8') !== content) fail(409, 'Handoff filename exists; never overwrite');
    return { path, created: false };
  }
}

function intent(row: Row): IntentEntry {
  return { $memory: 'intent', id: String(row.id), conversationId: String(row.conversation_id), goal: String(row.goal), did: String(row.did), issues: String(row.issues), next: String(row.next), sourceId: String(row.source_id), createdAt: String(row.created_at) };
}
export function queryIntents(db: DatabaseSync, projectId: string, query: WorkbenchQuery = {}): IntentEntry[] {
  project(db, projectId); const filter = filters(query);
  return db.prepare(`SELECT * FROM memory_intents WHERE project_id=?${filter.sql} ORDER BY created_at,id`).all(projectId, ...filter.args).map(intent)
    .filter(row => matches(query.q, row.goal, row.did, row.issues, row.next)).slice(0, limit(query.limit));
}
export function queryUserQuotes(db: DatabaseSync, projectId: string, query: WorkbenchQuery = {}): UserQuoteGroup[] {
  project(db, projectId); const filter = filters(query);
  const rows = db.prepare(`SELECT * FROM (SELECT m.id,m.conversation_id,m.seq,m.content,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.project_id=? AND m.role='user') WHERE 1=1${filter.sql} ORDER BY created_at,conversation_id,seq,id`).all(projectId, ...filter.args);
  const groups = new Map<string, UserQuote[]>();
  for (const row of rows.filter(row => matches(query.q, String(row.content ?? ''))).slice(0, limit(query.limit))) {
    const conversationId = String(row.conversation_id); const messages = groups.get(conversationId) ?? [];
    messages.push({ conversationId, messageId: String(row.id), seq: Number(row.seq), content: String(row.content ?? ''), createdAt: String(row.created_at) }); groups.set(conversationId, messages);
  }
  return [...groups.entries()].map(([conversationId, messages]) => ({ conversationId, messages }));
}

function extension(row: Row, db: DatabaseSync, projectId: string): ExtensionDefinition {
  return { id: String(row.id), name: String(row.name), description: String(row.description), mode: row.mode as 'cards' | 'single', appendOnly: row.append_only === 1, createdAt: String(row.created_at),
    entryCount: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_extension_entries WHERE project_id=? AND extension_id=?').get(projectId, String(row.id))?.n ?? 0),
    location: `sqlite:memory_extension_entries?projectId=${encodeURIComponent(projectId)}&extensionId=${encodeURIComponent(String(row.id))}` };
}
export function createExtension(db: DatabaseSync, projectId: string, input: unknown): ExtensionDefinition {
  shape(input, ['name', 'description', 'mode', 'appendOnly']); text(input.name, 'extension name', 200); text(input.description, 'extension description', 2000);
  if (typeof input.mode !== 'string' || !['cards', 'single'].includes(input.mode) || typeof input.appendOnly !== 'boolean') fail(400, 'Invalid extension configuration');
  return transaction(db, () => {
    project(db, projectId, true); bounded(db, 'memory_extension_definitions', projectId, 50);
    if (db.prepare('SELECT id FROM memory_extension_definitions WHERE project_id=? AND name=?').get(projectId, input.name as string)) fail(409, 'Extension name already exists');
    const extensionId = randomUUID();
    db.prepare('INSERT INTO memory_extension_definitions VALUES(?,?,?,?,?,?,?)').run(extensionId, projectId, input.name as string, input.description as string, input.mode as string, input.appendOnly ? 1 : 0, new Date().toISOString());
    return extension(definition(db, projectId, extensionId), db, projectId);
  });
}
export function listExtensions(db: DatabaseSync, projectId: string): ExtensionDefinition[] {
  project(db, projectId); return db.prepare('SELECT * FROM memory_extension_definitions WHERE project_id=? ORDER BY created_at,id').all(projectId).map(row => extension(row, db, projectId));
}
export function getExtension(db: DatabaseSync, projectId: string, extensionId: string): ExtensionDefinition {
  project(db, projectId); return extension(definition(db, projectId, extensionId), db, projectId);
}
export function queryExtensionEntries(db: DatabaseSync, projectId: string, extensionId: string, query: WorkbenchQuery = {}): ExtensionEntry[] {
  project(db, projectId); definition(db, projectId, extensionId); if (query.q !== undefined) text(query.q, 'query', 500, true);
  const rows = db.prepare('SELECT * FROM memory_extension_entries WHERE project_id=? AND extension_id=? ORDER BY ordinal').all(projectId, extensionId);
  const current = new Map<string, ExtensionEntry>();
  for (const row of rows) {
    const key = String(row.entry_key);
    if (row.action === 'delete') { current.delete(key); continue; }
    const previous = current.get(key);
    current.set(key, { id: String(row.id), extensionId, key, action: row.action as ExtensionEntry['action'],
      content: row.action === 'append' && previous ? `${previous.content}\n${String(row.content)}` : String(row.content), sourceId: String(row.source_id), createdAt: String(row.created_at) });
  }
  return [...current.values()].filter(row => matches(query.q, row.key, row.content)).slice(0, limit(query.limit));
}

function principleProposal(row: Row): PrincipleProposal {
  return { id: String(row.id), recordId: String(row.record_id), title: String(row.title), content: String(row.content), operation: row.operation as 'upsert' | 'delete', baseRevision: Number(row.base_revision), status: row.status as PrincipleProposal['status'], createdAt: String(row.created_at), resolvedAt: row.resolved_at === null ? null : String(row.resolved_at) };
}
/** Deterministic queue preparation only. No generation, semantic approval or background wait. */
function reviewPrinciple(db: DatabaseSync, projectId: string, proposal: PrincipleProposal): PrincipleProposal {
  const current = db.prepare('SELECT kind,title,content,revision,deleted FROM memory_records WHERE project_id=? AND record_id=?').get(projectId, proposal.recordId);
  const currentRevision = Number(current?.revision ?? 0);
  const competing = db.prepare(`SELECT id FROM memory_principle_proposals WHERE project_id=? AND record_id=? AND status='pending' AND id<>?
    AND (title<>? OR content<>? OR operation<>? OR base_revision<>?) LIMIT 1`)
    .get(projectId, proposal.recordId, proposal.id, proposal.title, proposal.content, proposal.operation, proposal.baseRevision);
  const validShape = !!proposal.recordId.trim() && !!proposal.title.trim() && (proposal.operation === 'delete' || !!proposal.content.trim());
  const credentials = CREDENTIAL.test(`${proposal.recordId}\n${proposal.title}\n${proposal.content}`);
  const baseline = currentRevision === proposal.baseRevision && (current === undefined || current.kind === 'principle');
  const noChange = proposal.operation === 'delete'
    ? current === undefined || current.deleted === 1
    : current?.deleted === 0 && current.title === proposal.title && current.content === proposal.content;
  const checks: PrincipleReviewCheck[] = [
    { code: 'shape', status: validShape ? 'pass' : 'warning', message: validShape ? '必填字段检查通过。' : '必填字段不完整，请修正请求。' },
    { code: 'credentials', status: credentials ? 'warning' : 'pass', message: credentials ? '发现疑似凭据，禁止直接批准。' : '未匹配到已知凭据格式；程序检查不保证识别所有敏感信息。' },
    { code: 'baseline', status: baseline ? 'pass' : 'warning', message: baseline ? '基线版本与当前正式原则一致；批准时仍会再次检查。' : '基线版本或目标类型已变化，请人工核对后重新提议。' },
    { code: 'pending_conflict', status: competing ? 'warning' : 'pass', message: competing ? '同一目标另有不同待批请求，请人工核对，程序未替你选择。' : '未发现同目标的不同待批请求；相同请求复用已有排队项。' },
    { code: 'change', status: noChange ? 'warning' : 'pass', message: noChange ? '请求未产生可见变更，或删除目标已不存在，请人工确认。' : '请求包含待人工确认的变更。' },
    { code: 'semantic', status: 'unknown', message: '程序未判断语义正确性或原则冲突；只有用户最终批准才会生效，暂不审批不影响当前任务。' },
  ];
  const attention = checks.some(check => check.status === 'warning');
  return { ...proposal, review: { processor: 'program', status: attention ? 'needs_attention' : 'ready', currentRevision, checks,
    summary: attention ? '已排入人工队列，存在需核对项；尚未批准，不阻塞当前任务。' : '程序确定性检查通过，等待用户最终审批；不是语义批准，不阻塞当前任务。' } };
}

export function proposePrinciple(db: DatabaseSync, projectId: string, input: unknown): PrincipleProposal {
  shape(input, ['recordId', 'title', 'content', 'operation', 'baseRevision']);
  text(input.recordId, 'principle recordId', 200); if ((input.recordId as string).startsWith('artifact:')) fail(400, 'Principle cannot target artifact');
  text(input.title, 'principle title', 200); text(input.content, 'principle content', 20_000, input.operation === 'delete');
  if (typeof input.operation !== 'string' || !['upsert', 'delete'].includes(input.operation) || !Number.isSafeInteger(input.baseRevision) || Number(input.baseRevision) < 0) fail(400, 'Invalid principle proposal');
  return transaction(db, () => {
    project(db, projectId, true);
    // Keep retries idempotent without a new schema or client key. Identity includes
    // every requested field and the project; do not trim or rewrite the user's rule.
    const existing = db.prepare(`SELECT * FROM memory_principle_proposals WHERE project_id=? AND record_id=? AND title=? AND content=? AND operation=? AND base_revision=? AND status='pending' ORDER BY created_at,id LIMIT 1`)
      .get(projectId, input.recordId as string, input.title as string, input.content as string, input.operation as string, input.baseRevision as number);
    if (existing) return reviewPrinciple(db, projectId, principleProposal(existing));
    const current = db.prepare('SELECT kind FROM memory_records WHERE project_id=? AND record_id=?').get(projectId, input.recordId as string);
    if (current && current.kind !== 'principle') fail(400, 'Principle cannot replace another memory kind');
    bounded(db, 'memory_principle_proposals', projectId, 5000);
    const proposalId = randomUUID();
    db.prepare('INSERT INTO memory_principle_proposals(id,project_id,record_id,title,content,operation,base_revision,created_at) VALUES(?,?,?,?,?,?,?,?)').run(proposalId, projectId, input.recordId as string, input.title as string, input.content as string, input.operation as string, input.baseRevision as number, new Date().toISOString());
    return reviewPrinciple(db, projectId, principleProposal(db.prepare('SELECT * FROM memory_principle_proposals WHERE id=?').get(proposalId)!));
  });
}
export function listPrincipleProposals(db: DatabaseSync, projectId: string, max = 100): PrincipleProposal[] {
  project(db, projectId); return db.prepare("SELECT * FROM memory_principle_proposals WHERE project_id=? AND status='pending' ORDER BY created_at,id LIMIT ?").all(projectId, limit(max)).map(row => reviewPrinciple(db, projectId, principleProposal(row)));
}
export function getCurrentPrinciples(db: DatabaseSync, projectId: string): PrincipleCurrent {
  project(db, projectId);
  const records: MemoryRecord[] = db.prepare("SELECT * FROM memory_records WHERE project_id=? AND kind='principle' AND deleted=0 ORDER BY record_id").all(projectId).map(row => ({ id: String(row.record_id), kind: 'principle', title: String(row.title), content: String(row.content), revision: Number(row.revision), deleted: false, updatedAt: String(row.updated_at) }));
  const approvals: PrincipleAudit[] = db.prepare('SELECT * FROM memory_principle_audit WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(projectId).map(row => ({ id: String(row.id), proposalId: String(row.proposal_id), recordId: String(row.record_id), operation: row.operation as 'approve' | 'reject', actor: 'human', summary: String(row.summary), createdAt: String(row.created_at) }));
  return { records, text: records.map(row => `# ${row.title}\n${row.content}`).join('\n\n'), approvals };
}

/** Kept only in the HTTP route closure. No tool registry returns this broker or a token. */
export class HumanApprovalBroker {
  private readonly pending = new Map<string, { projectId: string; proposalId: string; operation: 'approve' | 'reject'; expires: number }>();
  issueIntent(db: DatabaseSync, projectId: string, proposalId: string, operation: 'approve' | 'reject'): { capability: string; expiresAt: string } {
    project(db, projectId, true); id(proposalId, 'proposalId');
    if (!['approve', 'reject'].includes(operation)) fail(400, 'Invalid approval operation');
    if (!db.prepare("SELECT id FROM memory_principle_proposals WHERE project_id=? AND id=? AND status='pending'").get(projectId, proposalId)) fail(404, 'Pending principle proposal not found');
    for (const [key, entry] of this.pending) if (entry.expires <= Date.now()) this.pending.delete(key);
    if (this.pending.size >= 200) fail(409, 'Too many outstanding human approval intents');
    const capability = randomBytes(32).toString('base64url'); const expires = Date.now() + 120_000;
    this.pending.set(digest(capability), { projectId, proposalId, operation, expires });
    return { capability, expiresAt: new Date(expires).toISOString() };
  }
  resolve(db: DatabaseSync, projectId: string, proposalId: string, operation: 'approve' | 'reject', capability: unknown): { ok: true } {
    if (typeof capability !== 'string' || capability.length > 200) fail(403, 'Human approval capability required');
    const key = digest(capability); const intent = this.pending.get(key);
    if (!intent || intent.expires <= Date.now() || intent.projectId !== projectId || intent.proposalId !== proposalId || intent.operation !== operation) fail(403, 'Invalid or expired human approval capability');
    this.pending.delete(key); // Single use even if CAS fails: a new deliberate intent is required.
    return transaction(db, () => {
      project(db, projectId, true);
      const raw = db.prepare("SELECT * FROM memory_principle_proposals WHERE project_id=? AND id=? AND status='pending'").get(projectId, proposalId);
      if (!raw) fail(409, 'Principle proposal already resolved');
      const proposal = principleProposal(raw); const now = new Date().toISOString();
      if (operation === 'approve') {
        const beforeRow = db.prepare('SELECT * FROM memory_records WHERE project_id=? AND record_id=?').get(projectId, proposal.recordId);
        if (beforeRow && beforeRow.kind !== 'principle') fail(409, 'Principle target kind changed');
        if (Number(beforeRow?.revision ?? 0) !== proposal.baseRevision) fail(409, 'Principle revision changed');
        const before = beforeRow ? { id: String(beforeRow.record_id), kind: 'principle', title: String(beforeRow.title), content: String(beforeRow.content), revision: Number(beforeRow.revision), deleted: beforeRow.deleted === 1, updatedAt: String(beforeRow.updated_at) } : null;
        const after = { id: proposal.recordId, kind: 'principle', title: proposal.title, content: proposal.operation === 'delete' ? before?.content ?? '' : proposal.content, revision: proposal.baseRevision + 1, deleted: proposal.operation === 'delete', updatedAt: now };
        if (!beforeRow) bounded(db, 'memory_records', projectId, 2000);
        bounded(db, 'memory_history', projectId, 50_000); bounded(db, 'memory_events', projectId, 100_000);
        db.prepare('INSERT OR IGNORE INTO memory_projects(project_id,revision,config) VALUES(?,0,?)').run(projectId, JSON.stringify(DEFAULT_MEMORY_CONFIG));
        db.prepare('UPDATE memory_projects SET revision=revision+1 WHERE project_id=?').run(projectId);
        const revision = Number(db.prepare('SELECT revision FROM memory_projects WHERE project_id=?').get(projectId)?.revision);
        db.prepare(`INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,record_id) DO UPDATE SET title=excluded.title,content=excluded.content,revision=excluded.revision,deleted=excluded.deleted,updated_at=excluded.updated_at`).run(projectId, after.id, 'principle', after.title, after.content, after.revision, after.deleted ? 1 : 0, now);
        db.prepare('INSERT INTO memory_history VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), projectId, after.id, revision, before ? JSON.stringify(before) : null, JSON.stringify(after), proposalId, now);
        db.prepare('INSERT INTO memory_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(), projectId, revision, proposalId, 'principle.approve', JSON.stringify({ actor: 'human', recordId: after.id, operation: proposal.operation, digest: digest(after.content), chars: after.content.length }), now);
      }
      db.prepare('UPDATE memory_principle_proposals SET status=?,resolved_at=? WHERE id=?').run(operation === 'approve' ? 'approved' : 'rejected', now, proposalId);
      bounded(db, 'memory_principle_audit', projectId, 10_000);
      db.prepare('INSERT INTO memory_principle_audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), projectId, proposalId, proposal.recordId, operation, 'human', `principle.${proposal.operation} sha256:${digest(proposal.content)} chars:${proposal.content.length}`, now);
      return { ok: true };
    });
  }
}

export function getWorkbenchCounts(db: DatabaseSync, projectId: string): WorkbenchView['counts'] {
  project(db, projectId);
  const rows = db.prepare("SELECT e.bucket,COUNT(*) AS n FROM memory_triage_entries e WHERE e.project_id=? AND (e.bucket<>'keep' OR NOT EXISTS(SELECT 1 FROM memory_triage_releases r WHERE r.project_id=e.project_id AND r.keep_id=e.id)) GROUP BY e.bucket").all(projectId);
  const buckets = new Map(rows.map(row => [String(row.bucket), Number(row.n)]));
  return { keep: buckets.get('keep') ?? 0, stash: buckets.get('stash') ?? 0, drop: buckets.get('drop') ?? 0,
    handoffs: count(db, 'memory_handoffs', projectId), pendingPrinciples: Number(db.prepare("SELECT COUNT(*) AS n FROM memory_principle_proposals WHERE project_id=? AND status='pending'").get(projectId)?.n ?? 0),
    intents: count(db, 'memory_intents', projectId), extensions: count(db, 'memory_extension_definitions', projectId) };
}

export function getWorkbenchView(db: DatabaseSync, projectId: string, max = 30): WorkbenchView {
  project(db, projectId); const n = limit(max); const triage = getTriage(db, projectId, { limit: n });
  return { counts: { ...triage.counts, handoffs: count(db, 'memory_handoffs', projectId), pendingPrinciples: Number(db.prepare("SELECT COUNT(*) AS n FROM memory_principle_proposals WHERE project_id=? AND status='pending'").get(projectId)?.n ?? 0), intents: count(db, 'memory_intents', projectId), extensions: count(db, 'memory_extension_definitions', projectId) },
    triage, handoffs: listHandoffs(db, projectId, n), principles: getCurrentPrinciples(db, projectId), pending: listPrincipleProposals(db, projectId, n), intents: queryIntents(db, projectId, { limit: n }), extensions: listExtensions(db, projectId) };
}

/** Only constructs data; submitting and approving remains the store's responsibility. */
export function makeArtifactInput(type: unknown, payload: unknown): { type: ArtifactType; recordId: string; title: string; content: string } {
  if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type) || !object(payload) || Object.hasOwn(payload, '$memory')) fail(400, 'Invalid artifact type or payload');
  return { type: type as ArtifactType, recordId: `artifact:${type}:${randomUUID()}`, title: `Memory ${type}`, content: JSON.stringify({ $memory: type, ...payload }) };
}
