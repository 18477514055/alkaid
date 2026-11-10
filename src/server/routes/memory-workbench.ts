import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  HumanApprovalBroker, createExtension, getCurrentPrinciples, getExtension, getHandoff,
  getTriage, getWorkbenchCounts, getWorkbenchView, listPrincipleProposals,
  makeArtifactInput, materializeHandoff, proposePrinciple, queryExtensionEntries,
  queryIntents, queryUserQuotes, renderHandoff, type WorkbenchQuery,
} from '../../core/memory/workbench.ts';
import { submitProposal } from '../../core/memory/store.ts';
import { getConversation } from '../../core/store/repo.ts';
import type { ServerDeps } from '../app.ts';

type Params = { id: string; handoffId: string; proposalId: string; extensionId: string };
function bad(statusCode: 400 | 403 | 404, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function body(request: FastifyRequest, keys: string[]): Record<string, unknown> {
  if (!object(request.body) || keys.some(key => !Object.hasOwn(request.body as object, key)) || Object.keys(request.body).some(key => !keys.includes(key))) bad(400, 'Invalid request fields');
  return request.body;
}
function query(request: FastifyRequest): WorkbenchQuery {
  const input = request.query as Record<string, unknown>;
  const out: WorkbenchQuery = {};
  for (const key of ['q', 'from', 'to', 'conversationId'] as const) {
    if (input[key] !== undefined) { if (typeof input[key] !== 'string') bad(400, 'Invalid query'); out[key] = input[key]; }
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'string' || !/^\d+$/.test(input.limit)) bad(400, 'Invalid query limit');
    out.limit = Number(input.limit);
    if (!Number.isSafeInteger(out.limit) || out.limit < 1 || out.limit > 500) bad(400, 'Invalid query limit');
  }
  return out;
}

/** Browser-only approval intent: never trust actor fields or return capabilities to tools.
 * Fetch Metadata headers cannot be set by ordinary browser JS on another origin.
 * A local administrator/full shell can forge HTTP; that is outside this boundary.
 */
function humanUiIntent(request: FastifyRequest): void {
  const headers = request.headers;
  if (headers['origin'] !== `${request.protocol}://${request.host}`
    || headers['sec-fetch-site'] !== 'same-origin'
    || !['cors', 'same-origin'].includes(String(headers['sec-fetch-mode']))
    || headers['x-alkaid-human-intent'] !== 'principle-approval') bad(403, 'Same-origin human UI approval intent required');
}

export function registerMemoryWorkbenchRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const broker = new HumanApprovalBroker();
  const prefix = '/api/projects/:id/memory';
  app.get<{ Params: Params }>(`${prefix}/workbench`, async request => {
    const input = request.query as { view?: string };
    if (input.view === 'counts') return { counts: getWorkbenchCounts(deps.db, request.params.id) };
    return getWorkbenchView(deps.db, request.params.id, query(request).limit ?? 30);
  });
  app.get<{ Params: Params }>(`${prefix}/triage`, async request => getTriage(deps.db, request.params.id, query(request)));
  app.get<{ Params: Params }>(`${prefix}/handoffs/:handoffId`, async request => getHandoff(deps.db, request.params.id, request.params.handoffId));
  app.get<{ Params: Params }>(`${prefix}/handoffs/:handoffId/download`, async (request, reply) => {
    const handoff = getHandoff(deps.db, request.params.id, request.params.handoffId);
    return reply.type('text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="handoff-${handoff.id}.md"`).header('x-content-type-options', 'nosniff').send(renderHandoff(handoff));
  });
  app.post<{ Params: Params }>(`${prefix}/handoffs/:handoffId/materialize`, async request => materializeHandoff(deps.db, deps.config, request.params.id, request.params.handoffId));
  app.get<{ Params: Params }>(`${prefix}/principles/current`, async request => getCurrentPrinciples(deps.db, request.params.id));
  app.get<{ Params: Params }>(`${prefix}/principles/proposals`, async request => listPrincipleProposals(deps.db, request.params.id, query(request).limit));
  app.post<{ Params: Params }>(`${prefix}/principles/proposals`, async (request, reply) => {
    const proposed = proposePrinciple(deps.db, request.params.id, request.body);
    return reply.code(201).send(proposed);
  });
  app.post<{ Params: Params }>(`${prefix}/principles/proposals/:proposalId/approval-intent`, async (request, reply) => {
    humanUiIntent(request);
    const input = body(request, ['operation']);
    if (input.operation !== 'approve' && input.operation !== 'reject') bad(400, 'Invalid approval operation');
    return reply.header('cache-control', 'no-store').send(broker.issueIntent(deps.db, request.params.id, request.params.proposalId, input.operation));
  });
  for (const operation of ['approve', 'reject'] as const) app.post<{ Params: Params }>(`${prefix}/principles/proposals/:proposalId/${operation}`, async request => {
    humanUiIntent(request);
    const input = body(request, ['capability']);
    const result = broker.resolve(deps.db, request.params.id, request.params.proposalId, operation, input.capability);
    deps.memory.projectBusy(request.params.id);
    return result;
  });
  app.get<{ Params: Params }>(`${prefix}/logs`, async request => {
    const view = (request.query as { view?: string }).view ?? 'intents';
    if (view !== 'intents' && view !== 'users') bad(400, 'Invalid log view');
    return view === 'users' ? queryUserQuotes(deps.db, request.params.id, query(request)) : queryIntents(deps.db, request.params.id, query(request));
  });
  app.post<{ Params: Params }>(`${prefix}/extensions`, async (request, reply) => reply.code(201).send(createExtension(deps.db, request.params.id, request.body)));
  app.get<{ Params: Params }>(`${prefix}/extensions/:extensionId`, async request => getExtension(deps.db, request.params.id, request.params.extensionId));
  app.get<{ Params: Params }>(`${prefix}/extensions/:extensionId/entries`, async request => queryExtensionEntries(deps.db, request.params.id, request.params.extensionId, query(request)));
  app.post<{ Params: Params }>(`${prefix}/artifacts`, async (request, reply) => {
    const input = body(request, ['conversationId', 'idempotencyKey', 'type', 'payload']);
    if (typeof input.conversationId !== 'string' || typeof input.idempotencyKey !== 'string') bad(400, 'Conversation and idempotency key required');
    const conversation = getConversation(deps.db, input.conversationId);
    if (!conversation || conversation.projectId !== request.params.id) bad(404, 'Source conversation not found in project');
    if (input.type === 'intent' && object(input.payload) && input.payload.conversationId !== input.conversationId) bad(400, 'Intent must belong to source conversation');
    const artifact = makeArtifactInput(input.type, input.payload);
    // Same HTTP idempotency key must reconstruct the same recordId on retries.
    const artifactId = createHash('sha256').update(JSON.stringify([input.conversationId, input.idempotencyKey, artifact.type])).digest('hex');
    const proposal = submitProposal(deps.db, { conversationId: input.conversationId, idempotencyKey: input.idempotencyKey,
      recordId: `artifact:${artifact.type}:${artifactId}`, kind: 'note', title: artifact.title,
      content: artifact.content, operation: 'upsert', baseRevision: 0, reason: 'Workbench artifact awaiting independent review' });
    deps.memory.notifyProject(request.params.id);
    return reply.code(201).send(proposal);
  });
}
