import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { queryObligations, resolveObligation } from '../../core/memory/obligations.ts';
import type { ObligationQuery, ResolveObligationInput } from '../../shared/memory-obligations.ts';

function fail(message: string): never { throw Object.assign(new Error(message), { statusCode: 400 }); }
function number(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail(`Invalid ${name}`);
  return Number(value);
}
/** Local read/explicit human resolution only. Never generates, retries, approves or applies memory. */
export function registerMemoryObligationRoutes(app: FastifyInstance, deps: { db: DatabaseSync }): void {
  const base = '/api/projects/:id/memory/obligations';
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(base, async request => {
    const q = request.query;
    if (Object.keys(q).some(k => !['conversationId','status','limit','offset','includeResolved'].includes(k))) fail('Unknown obligation query field');
    if (q['conversationId'] !== undefined && typeof q['conversationId'] !== 'string') fail('Invalid conversationId');
    if (q['status'] !== undefined && typeof q['status'] !== 'string') fail('Invalid status');
    if (q['includeResolved'] !== undefined && q['includeResolved'] !== 'true' && q['includeResolved'] !== 'false') fail('Invalid includeResolved');
    return queryObligations(deps.db, request.params.id, {
      conversationId: q['conversationId'] as string | undefined,
      status: q['status'] as ObligationQuery['status'],
      limit: number(q['limit'], 'limit'), offset: number(q['offset'], 'offset'),
      includeResolved: q['includeResolved'] === 'true',
    });
  });
  app.post<{ Params: { id: string }; Body: unknown }>(`${base}/resolve`, async request => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['conversationId','userSeq','action','reason','proposalIds'].includes(k))) fail('Invalid obligation resolution fields');
    return resolveObligation(deps.db, request.params.id, body as ResolveObligationInput);
  });
}
