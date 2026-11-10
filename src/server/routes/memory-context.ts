import type { FastifyInstance } from 'fastify';
import { projectMaterialMap } from '../../core/agent/prompt/memory.ts';
import { buildConversationPrompt } from '../../core/agent/prompt/session.ts';
import { CompactionError, compactRange,planCompaction,recordCompactionBlocked } from '../../core/context/compact.ts';
import { appendCheckpointEvent, getCheckpoint, openCheckpoint, queryCapsules, recordTurnProgress } from '../../core/memory/context.ts';
import { applyProposalManually, getMemoryView, submitProposal } from '../../core/memory/store.ts';
import { getHandoff, makeArtifactInput } from '../../core/memory/workbench.ts';
import { createProviderFromRow } from '../../core/model/factory.ts';
import type { Provider } from '../../core/model/provider.ts';
import { getSecret } from '../../core/secrets.ts';
import { getConversation, getProvider } from '../../core/store/repo.ts';
import type { CheckpointChoice } from '../../shared/memory-context.ts';
import type { ServerDeps } from '../app.ts';

type Row = Record<string, unknown>;
function bad(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
function object(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fields(body: unknown, allowed: string[]): asserts body is Row {
 if (!object(body) || Object.keys(body).some(k => !allowed.includes(k))) bad('Invalid checkpoint fields');
}
function range(value: unknown): number | undefined {
 if (value === undefined) return undefined;
 const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) bad('Invalid seq range'); return n;
}
export function registerMemoryContextRoutes(app: FastifyInstance, deps: ServerDeps, hooks: { createProvider?: (conversationId: string) => Provider } = {}): void {
 const resolving = new Set<string>();
 app.get('/api/conversations/:id/memory-state', async (request, reply) => {
  const { id } = request.params as { id: string }; const conv = getConversation(deps.db, id);
  if (!conv) return reply.code(404).send({ error: 'Conversation not found' });
  return buildConversationPrompt(deps.db, id, deps.tools).state;
 });
 app.get('/api/projects/:projectId/memory/capsules', async (request, reply) => {
  const { projectId } = request.params as { projectId: string }; const query = request.query as Row;
  const id = typeof query['conversationId'] === 'string' ? query['conversationId'] : '';
  if (!id) return reply.code(400).send({ error: 'conversationId required' });
  if (getConversation(deps.db, id)?.projectId !== projectId) return reply.code(404).send({ error: 'Conversation not found in project' });
  const fromSeq = range(query['fromSeq']); const toSeq = range(query['toSeq']);
  if (fromSeq && toSeq && fromSeq > toSeq) bad('Invalid seq range');
  return { capsules: queryCapsules(deps.db, id, { ...(fromSeq === undefined ? {} : { fromSeq }), ...(toSeq === undefined ? {} : { toSeq }), ...(typeof query['capsuleId'] === 'string' ? { capsuleId: query['capsuleId'] } : {}) }) };
 });
 app.get('/api/projects/:projectId/memory/material-map', async (request, reply) => {
  const { projectId } = request.params as { projectId: string }; const { conversationId } = request.query as { conversationId?: string };
  if (!conversationId) return reply.code(400).send({ error: 'conversationId required' });
  if (getConversation(deps.db, conversationId)?.projectId !== projectId) return reply.code(404).send({ error: 'Conversation not found in project' });
  return { materials: projectMaterialMap(deps.db, conversationId), coverage: '当前正式记录；实际memory_read完整交付当前revision才记已读。UI查阅不记模型已读。' };
 });
 app.post('/api/conversations/:id/checkpoint', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!getConversation(deps.db, id)) return reply.code(404).send({ error: 'Conversation not found' });
  fields(request.body ?? {}, []);
  return { checkpoint: openCheckpoint(deps.db, id) };
 });
 app.post('/api/conversations/:id/checkpoint/resolve', async (request, reply) => {
  const { id } = request.params as { id: string }; const body = request.body;
  fields(body, ['checkpointId','choice','intent','handoff','accept','keepRecent']);
  const conv = getConversation(deps.db, id); if (!conv) return reply.code(404).send({ error: 'Conversation not found' });
  if (typeof body['checkpointId'] !== 'string') bad('checkpointId required');
  const checkpoint = getCheckpoint(deps.db, id, body['checkpointId']); if (!checkpoint) bad('Checkpoint not found', 404);
  if (!['skip','record','record_compact','record_handoff'].includes(String(body['choice']))) bad('Invalid checkpoint choice');
  const choice = body['choice'] as CheckpointChoice;
  if (checkpoint.status === 'resolved') {
   if (checkpoint.choice !== choice) bad('Checkpoint already resolved with a different choice', 409);
   return { checkpoint };
  }
  if (checkpoint.choice !== null && checkpoint.choice !== choice) bad('Checkpoint choice already staged', 409);
  if (resolving.has(checkpoint.id)) bad('Checkpoint request in progress', 409);
  resolving.add(checkpoint.id);
  try {
   if (choice === 'skip') {
    if (body['accept'] !== undefined || body['intent'] !== undefined || body['handoff'] !== undefined) bad('Skip does not record or approve memory');
    recordTurnProgress(deps.db, id, checkpoint.userSeq, 'checkpoint_skip');
    return { checkpoint: appendCheckpointEvent(deps.db, checkpoint, 'resolved', choice, 'checkpoint_skipped') };
   }
   if (!conv.projectId) bad('Checkpoint recording requires a project');
   if (conv.state === 'running') bad('Wait until the current turn finishes', 409);
   if (body['accept'] !== undefined && body['accept'] !== true) bad('accept must be explicit true');
   if (body['accept'] !== true) {
    if (checkpoint.proposalId) return { checkpoint, requiresAcceptance: true };
    let artifact;
    if (choice === 'record_handoff') {
     fields(body['handoff'], ['title','did','state','next','files','blocked']);
     artifact = makeArtifactInput('handoff', body['handoff']);
    } else {
     fields(body['intent'], ['goal','did','issues','next']);
     artifact = makeArtifactInput('intent', { ...body['intent'], conversationId: id });
    }
    const proposal = submitProposal(deps.db, { conversationId: id, recordId: artifact.recordId, kind: 'note', title: artifact.title,
     content: artifact.content, operation: 'upsert', baseRevision: 0, reason: 'User checkpoint request; independent acceptance required', idempotencyKey: `checkpoint-${checkpoint.id}` });
    recordTurnProgress(deps.db, id, checkpoint.userSeq, 'progress_recorded');
    return { checkpoint: appendCheckpointEvent(deps.db, checkpoint, 'recorded', choice, 'checkpoint_proposal_pending', proposal.id), proposal, requiresAcceptance: true };
   }
   // Stage two MUST identify a proposal created by stage one. No arbitrary kind/recordId/principle channel.
   if (!checkpoint.proposalId) bad('Submit a checkpoint proposal before independent acceptance', 409);
   if (body['intent'] !== undefined || body['handoff'] !== undefined) bad('Acceptance uses the already-reviewed proposal, not replacement content');
   const proposal = getMemoryView(deps.db, conv.projectId).proposals.find(p => p.id === checkpoint.proposalId);
   if (!proposal || proposal.conversationId !== id || !proposal.recordId.startsWith(`artifact:${choice === 'record_handoff' ? 'handoff' : 'intent'}:`)) bad('Checkpoint proposal not available', 409);
   let compactProvider: (()=>Provider) | null = null;
   if (choice === 'record_compact') {
    if (body['keepRecent'] !== undefined && (!Number.isSafeInteger(body['keepRecent']) || Number(body['keepRecent']) < 1)) bad('Invalid keepRecent');
    const plan=planCompaction(deps.db,id,{source:'checkpoint',...(typeof body['keepRecent']==='number'?{keepRecent:body['keepRecent']}:{})});
    if(plan.status==='blocked') { recordCompactionBlocked(deps.db,plan); throw new CompactionError('blocked',plan); }
    compactProvider=()=>{
     if(hooks.createProvider)return hooks.createProvider(id);
     const row = getProvider(deps.db, conv.providerId); if (!row) bad('Existing conversation provider unavailable', 412);
     const key = getSecret(deps.config.secretsPath, row.id); if (!key) bad('Existing conversation provider credentials unavailable', 412);
     return createProviderFromRow(row, key, id);
    };
   }
   if (proposal.status === 'pending') applyProposalManually(deps.db, conv.projectId, proposal.id);
   else if (proposal.status !== 'applied') bad('Checkpoint proposal is not acceptable', 409);
   recordTurnProgress(deps.db, id, checkpoint.userSeq, 'progress_recorded');
   if (choice === 'record_compact' && compactProvider) {
    const compaction = await compactRange({ db: deps.db, conversationId: id, source:'checkpoint',createProvider: compactProvider,
     ...(typeof body['keepRecent'] === 'number' ? { keepRecent: body['keepRecent'] } : {}), signal: AbortSignal.timeout(120000) });
    return { checkpoint: appendCheckpointEvent(deps.db, checkpoint, 'resolved', choice, 'checkpoint_recorded_compacted', proposal.id), compacted: compaction !== null, compaction };
   }
   if (choice === 'record_handoff') {
    const row = deps.db.prepare('SELECT id FROM memory_handoffs WHERE project_id=? AND record_id=?').get(conv.projectId, proposal.recordId);
     if (!row) bad('Checkpoint handoff not available', 409);
     const handoff = getHandoff(deps.db, conv.projectId, String(row['id']));
    return { checkpoint: appendCheckpointEvent(deps.db, checkpoint, 'resolved', choice, 'checkpoint_recorded_handoff', proposal.id, handoff.id), handoff };
   }
   return { checkpoint: appendCheckpointEvent(deps.db, checkpoint, 'resolved', choice, 'checkpoint_recorded', proposal.id) };
  } catch (error) {
   // ★ 压缩失败是六类封闭枚举（`CompactionError`）：给人话 + 能否重试，**不带**上游正文。
   //   这必须走在 `checkpoint_operation_failed` 之前：压缩失败要回答的是"能不能再来一次"，
   //   被吞成一句无法行动的检查点失败，用户就不知道该干什么了。
   if (error instanceof CompactionError) {
    return reply.code(error.code==='blocked'||error.code==='busy'?409:502).send({ compacted:false,blocked:error.code==='blocked',code:error.reason==='duties'||error.reason==='no_checkpoint'?'duties_incomplete':error.reason??error.code,missing:error.missing,error: { code: error.code, message: error.message, retryable: error.retryable } });
   }
   const statusCode = object(error) && typeof error['statusCode'] === 'number' ? error['statusCode'] : 502;
   // No upstream error body, prompt, credential, or exception text in persistent diagnostics or HTTP errors.
   return reply.code(statusCode).send({ error: statusCode === 502 ? 'checkpoint_operation_failed' : error instanceof Error ? error.message : 'checkpoint_invalid_request', code: 'checkpoint_operation_failed' });
  } finally { resolving.delete(checkpoint.id); }
 });
}
