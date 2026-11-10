import type { FastifyInstance } from 'fastify';
import {
  getGoalTree, getMemoryArchiveSnapshot, getMemoryIndex, getPreservedMemory,
  listMemoryArchive, parseNoteContent, refuseArchiveMutation, renderNoteContent, searchMemoryLessons,
} from '../../core/memory/records.ts';
import { getMemoryView, getProjectRevision, submitPreservedMerge, submitProposal } from '../../core/memory/store.ts';
import type { SubmitMemoryProposal } from '../../shared/memory.ts';
import type { MergePreservedInput } from '../../shared/memory-records.ts';
import type { ServerDeps } from '../app.ts';

type Params = { id: string };
type ArchiveParams = Params & { historyId: string };
type Query = { recordId?: string; from?: string; to?: string; revision?: string; limit?: string; offset?: string };
function fail(statusCode: 400 | 404 | 409, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function payload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '请求必须是对象');
  return value as Record<string, unknown>;
}
function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) fail(400, '分页或版本参数必须为非负整数');
  return Number(value);
}
function bindConversation(deps: Pick<ServerDeps, 'db'>, projectId: string, conversationId: unknown): void {
  getProjectRevision(deps.db, projectId);
  if (typeof conversationId !== 'string' || !conversationId.trim()) fail(400, '缺少来源会话conversationId');
  const row = deps.db.prepare('SELECT project_id FROM conversations WHERE id=?').get(conversationId);
  if (!row) fail(404, '来源会话不存在');
  if (row['project_id'] !== projectId) fail(400, '来源会话与项目不匹配');
}
/** All reads are local and pure; writes create proposals, never accept them. */
export function registerMemoryRecordRoutes(app: FastifyInstance, deps: Pick<ServerDeps, 'db' | 'memory'>): void {
  const base = '/api/projects/:id/memory';
  app.get<{ Params: Params; Querystring: Query }>(`${base}/archive`, async request => {
    const q = request.query;
    return listMemoryArchive(deps.db, request.params.id, {
      recordId: q.recordId, from: q.from, to: q.to,
      revision: number(q.revision), limit: number(q.limit), offset: number(q.offset),
    });
  });
  app.get<{ Params: ArchiveParams; Querystring: { side?: string } }>(`${base}/archive/:historyId`, async request => {
    const side = request.query.side ?? 'after';
    if (side !== 'before' && side !== 'after') fail(400, '归档side必须为before或after');
    return getMemoryArchiveSnapshot(deps.db, request.params.id, request.params.historyId, side);
  });
  for (const method of ['DELETE', 'PATCH', 'PUT'] as const) app.route<{ Params: ArchiveParams }>({
    method, url: `${base}/archive/:historyId`, handler: async request => refuseArchiveMutation(deps.db, request.params.id, request.params.historyId),
  });
  app.get<{ Params: Params & { recordId: string } }>(`${base}/notes/:recordId/download`, async (request, reply) => {
    const { id, recordId } = request.params;
    const record = getMemoryView(deps.db, id).records.find(r => r.id === recordId && !r.deleted);
    if (!record) fail(404, '正式笔记不存在；暂存提案不能导出为正式文档');
    if (record.kind !== 'note') fail(400, '只有正式结构笔记可以下载');
    const data = parseNoteContent(record.content);
    const registered = deps.db.prepare('SELECT document_name FROM memory_note_documents WHERE project_id=? AND record_id=?').get(id, recordId);
    if (!data?.documentName || data.documentName !== registered?.['document_name']) fail(400, '笔记缺少已登记的系统文档名称');
    const filename = encodeURIComponent(data.documentName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply.type('text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="memory-note.md"; filename*=UTF-8''${filename}`)
      .send(`# ${record.title}\n\n${renderNoteContent(data)}\n`);
  });
  app.get<{ Params: Params }>(`${base}/goals`, async request => getGoalTree(deps.db, request.params.id));
  app.get<{ Params: Params; Querystring: { type?: string; category?: string; q?: string } }>(`${base}/lessons`, async request => searchMemoryLessons(deps.db, request.params.id, request.query));
  app.get<{ Params: Params }>(`${base}/index`, async request => getMemoryIndex(deps.db, request.params.id));
  app.get<{ Params: Params; Querystring: { includeResolved?: string } }>(`${base}/preserved`, async request => {
    if (request.query.includeResolved !== undefined && !['true', 'false'].includes(request.query.includeResolved)) fail(400, 'includeResolved必须为true或false');
    return getPreservedMemory(deps.db, request.params.id, request.query.includeResolved === 'true');
  });
  app.post<{ Params: Params; Body: unknown }>(`${base}/proposals`, async (request, reply) => {
    const body = payload(request.body);
    bindConversation(deps, request.params.id, body['conversationId']);
    const p = submitProposal(deps.db, body as SubmitMemoryProposal);
    deps.memory.notifyProject(request.params.id);
    return reply.code(201).send(p);
  });
  app.post<{ Params: Params; Body: unknown }>(`${base}/preserved/merge`, async (request, reply) => {
    const body = payload(request.body);
    bindConversation(deps, request.params.id, body['conversationId']);
    const p = submitPreservedMerge(deps.db, request.params.id, body as MergePreservedInput);
    deps.memory.notifyProject(request.params.id);
    return reply.code(201).send(p);
  });
}
