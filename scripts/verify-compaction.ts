/** Offline production HTTP/SSE acceptance. Only a new temporary home and a loopback fake model are used. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ensureHome, loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/core/store/db.ts';
import { migrate, SCHEMA_VERSION } from '../src/core/store/schema.ts';
import { appendMessage, insertConversation, insertProvider, listMessages, type MessageRow } from '../src/core/store/repo.ts';
import { createProject } from '../src/core/project/service.ts';
import { setSecret } from '../src/core/secrets.ts';
import { getCompactionDuties } from '../src/core/memory/duties.ts';
import { buildServer } from '../src/server/app.ts';
import type { CompactionPlan, CompactionState, CompactionEventPage } from '../src/shared/compaction.ts';
import type { DutyState } from '../src/shared/compaction-duties.ts';
import type { RecallIndex, RecallMessagePage } from '../src/shared/recall.ts';
import type { MemoryCheckpoint } from '../src/shared/memory-context.ts';
import type { MemoryProposal, MemoryView } from '../src/shared/memory.ts';
import type { GeneralSettings } from '../src/shared/settings.ts';

const serve = process.argv.includes('--serve');
assert.ok(!(serve && process.argv.includes('--once')), 'Use --once OR --serve');
assert.ok(process.argv.slice(2).every(arg => ['--once', '--serve'].includes(arg)), 'Unknown fixture argument');
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const webRoot = resolve(appRoot, 'dist/web');
const home = mkdtempSync(join(tmpdir(), 'alkaid-compaction-http-'));
const config = loadConfig({ ALKAID_HOME: home, ALKAID_HOST: '127.0.0.1' });
const reportPath = process.env['ALKAID_VERIFY_REPORT_DIR']
  ? resolve(process.env['ALKAID_VERIFY_REPORT_DIR'], '验收-统一压缩-HTTP.json')
  : resolve(appRoot, '../docs/验收-统一压缩-HTTP.json');
const checks: Record<string, boolean> = {};
const counters = { allCalls: 0, primaryCalls: 0, compactionCalls: 0, closureCalls: 0, maintenanceCalls: 0, modelCatalogReads: 0, paidModelCalls: 0 };
let db: DatabaseSync | undefined; let app: FastifyInstance | undefined; let url = '';
let autoConversationId = ''; let autoTurnUserSeq = 0; let closePromise: Promise<void> | undefined;
let fakeFailure: string | null = null;
const primaryRequests: WireRequest[] = [];
const compactRequests: { conversationId: string; originalCount: number; fromSeq: number; toSeq: number; allThreeReceiptsPersisted: boolean }[] = [];
type WireCall = { id?: string; function?: { name?: string; arguments?: string } };
type WireMessage = { role: string; content?: string | null; tool_calls?: WireCall[]; tool_call_id?: string };
type WireRequest = { messages: WireMessage[]; tools?: unknown[]; model?: string; stream?: boolean };
type TurnEvent = { type: string; delta?: string; message?: MessageRow; reason?: string };
type Status = { settings: { enabled: boolean; thresholdPercent: number }; contextTokens: number; contextWindow: number; ratio: number; duties: DutyState; plan: CompactionPlan } & CompactionState;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
function parse(text: string | null | undefined): Record<string, unknown> { return object(JSON.parse(text ?? '{}')); }
function pairs(messages: readonly WireMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    assert.notEqual(message.role, 'tool', `orphan tool reply at wire index ${i}`);
    if (!message.tool_calls?.length) continue;
    const expected = new Set(message.tool_calls.map(call => call.id)); const seen = new Set<string>();
    assert.ok(!expected.has(undefined)); assert.equal(expected.size, message.tool_calls.length);
    while (messages[i + 1]?.role === 'tool') {
      const reply = messages[++i]!; assert.ok(reply.tool_call_id && expected.has(reply.tool_call_id));
      assert.ok(!seen.has(reply.tool_call_id)); seen.add(reply.tool_call_id);
    }
    assert.equal(seen.size, expected.size, 'Every actual assistant tool batch must have all matching replies');
  }
}
const fake = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      counters.modelCatalogReads++; res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'offline-compaction-fixture' }] })); return;
    }
    assert.equal(req.method, 'POST'); assert.match(req.url ?? '', /chat\/completions/);
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as WireRequest; assert.ok(Array.isArray(body.messages)); assert.equal(body.stream, true);
    counters.allCalls++; const system = body.messages[0]?.content ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const call = (index: number, name: string, args: unknown) => frame({ tool_calls: [{ index, id: `compaction-http-${counters.allCalls}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    let finish = 'stop';
    if (system.startsWith('你是上下文压缩器')) {
      counters.compactionCalls++;
      const material = parse(body.messages[1]?.content); const id = String(material.conversationId);
      const originals = material.originalMessages as { seq: number; role: string; toolCalls?: { id: string }[] | null; toolCallId?: string | null }[];
      assert.ok(Array.isArray(originals) && originals.length > 0);
      assert.equal(getCompactionDuties(db!, id).complete, true, 'No fake compression inference before three real saved receipts');
      pairs(originals.map(row => ({ role: row.role, tool_calls: row.toolCalls?.map(call => ({ id: call.id })), tool_call_id: row.toolCallId ?? undefined })));
      if (id === autoConversationId) {
        const receipts = listMessages(db!, id, autoTurnUserSeq).filter(row => row.role === 'tool');
        assert.equal(receipts.length, 3, 'All three tool replies must exist BEFORE automatic compression inference');
        assert.ok(receipts.every(row => parse(row.content).ok === true));
      }
      compactRequests.push({ conversationId: id, originalCount: originals.length, fromSeq: originals[0]!.seq, toSeq: originals.at(-1)!.seq, allThreeReceiptsPersisted: true });
      const summary = ['目标', '决定', '当前', '文件', '错误教训', '待办', '下一步', '关键约束'].map(title => `## ${title}\n本地 HTTP/SSE 验收：三项独立收条已保存，原文按 seq 可逐字回读；不把暂存当正式合并。`).join('\n\n');
      frame({ content: summary });
    } else if (system.startsWith('You maintain project memory')) {
      counters.maintenanceCalls++; throw new Error('Unexpected maintenance generation');
    } else if (body.messages.some(message => message.content?.includes('MEMORY_TURN_CLOSURE'))) {
      counters.closureCalls++; throw new Error('Proactive three-receipt turn must not need an extra closure request');
    } else {
      pairs(body.messages); counters.primaryCalls++; primaryRequests.push(body);
      const user = [...body.messages].reverse().find(message => message.role === 'user')?.content ?? '';
      if (user.includes('[AUTO_TRIPLE_HTTP]') && body.messages.at(-1)?.role === 'user') {
        call(0, 'memory_propose', { recordId: 'http-ledger-proof', kind: 'active', title: '统一压缩的真实三项收尾', operation: 'upsert', content: '本轮已核验生产 HTTP 与流式工具回执；内容仅暂存，正式记忆仍独立审核。', baseRevision: 0, reason: '真实消息 SSE 内的独立台账回执', idempotencyKey: 'http-ledger-proof' });
        call(1, 'memory_stage', { action: 'intent', payload: { goal: '核验统一压缩', did: '核对三项分别成功与原文保留', issues: '', next: '逐页回读并检查固定日志' }, reason: '真实进展日志收条，与台账不同提案', idempotencyKey: 'http-log-proof' });
        call(2, 'memory_stage', { action: 'triage', payload: { keep: [{ what: '自动、手动与检查点都需要独立台账、进展日志和最后的triage收条。' }], stash: [{ what: '压缩前长原文和完整工具批可通过分页recall逐字回读。' }], drop: [] }, reason: '三项最后一项，完整取舍收条', idempotencyKey: 'http-triage-proof' });
        finish = 'tool_calls';
      } else {
        frame({ content: '离线核验' }); await delay(60); frame({ content: '已完成，可以继续工作。' });
      }
    }
    frame({}, finish); res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 240, completion_tokens: 32, prompt_tokens_details: { cached_tokens: 40 } } })}\n\n`); res.end('data: [DONE]\n\n');
  } catch (error) {
    fakeFailure = error instanceof Error ? error.message : 'fake request failed';
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'offline_compaction_fixture_request_failed' }));
  }
});
async function close(): Promise<void> {
  return closePromise ??= (async () => {
    await app?.close();
    if (fake.listening) await new Promise<void>((done, reject) => fake.close(error => error ? reject(error) : done()));
    db?.close();
    const absolute = resolve(home), prefix = resolve(tmpdir(), 'alkaid-compaction-http-');
    assert.ok(absolute.startsWith(prefix) && absolute.length > prefix.length && !lstatSync(absolute).isSymbolicLink(), 'Only the exact newly-created non-symlink fixture home may be deleted');
    rmSync(absolute, { recursive: true, force: true });
  })();
}
async function request<T>(path: string, method = 'GET', payload?: unknown, expected = 200): Promise<T> {
  const response = await fetch(url + path, { method, signal: AbortSignal.timeout(30000), headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const text = await response.text(); assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 300)}`);
  return (response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text) as T;
}
async function send(conversationId: string, content: string): Promise<{ events: TurnEvent[]; text: string }> {
  const response = await fetch(`${url}/api/conversations/${conversationId}/messages`, { method: 'POST', signal: AbortSignal.timeout(45000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/); assert.ok(response.body);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = ''; const events: TurnEvent[] = [];
  let firstTextAt: number | null = null, finishAt: number | null = null;
  for (;;) {
    const part = await reader.read(); if (part.done) break; pending += decoder.decode(part.value, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).trimEnd(); pending = pending.slice(newline + 1);
      if (!line.startsWith('data: ')) continue; const event = JSON.parse(line.slice(6)) as TurnEvent; events.push(event);
      if (event.type === 'text' && firstTextAt === null) firstTextAt = Date.now(); if (event.type === 'finish') finishAt = Date.now();
    }
  }
  assert.equal(fakeFailure, null, fakeFailure ?? 'Fake must remain valid');
  assert.ok(events.some(event => event.type === 'finish' && event.reason === 'stop'), 'Production SSE must finish normally');
  assert.ok(!events.some(event => event.type === 'error'), 'Production SSE may not hide a failed turn');
  assert.ok(firstTextAt !== null && finishAt !== null && firstTextAt < finishAt, 'Business text must stream before the final finish event');
  return { events, text: events.filter(event => event.type === 'text').map(event => event.delta ?? '').join('') };
}
function count(table: string, conversationId?: string): number {
  assert.ok(['memory_capsules', 'compactions', 'compaction_events', 'memory_proposals'].includes(table));
  return Number(db!.prepare(`SELECT COUNT(*) AS n FROM ${table}${conversationId ? ' WHERE conversation_id=?' : ''}`).get(...(conversationId ? [conversationId] : []))?.['n'] ?? 0);
}
function seed(conversationId: string, long = false): MessageRow | null {
  appendMessage(db!, { conversationId, role: 'user', content: 'SEED_EARLIEST_MARKER: preserved historical user wording.' });
  let original: MessageRow | null = null;
  if (long) {
    original = appendMessage(db!, { conversationId, role: 'assistant', content: `LONG_CONTENT_HEAD\n${'C'.repeat(26000)}\nLONG_CONTENT_TAIL_😀`, reasoning: `LONG_REASON_HEAD\n${'R'.repeat(25000)}\nLONG_REASON_TAIL_😀`, toolCalls: [{ id: 'seed-long-tool', name: 'read', arguments: JSON.stringify({ path: 'fixture-only-old-file.txt', note: 'A'.repeat(24000), tail: 'LONG_TOOL_ARGUMENT_TAIL_😀' }) }], usage: { input: 41, output: 17, cached: 5, cachedWrite: 3, inputExcludesCached: true }, finishReason: 'tool_calls' });
    appendMessage(db!, { conversationId, role: 'tool', toolCallId: 'seed-long-tool', content: JSON.stringify({ ok: true, content: 'Historical fixture-only read receipt; original batch is complete.' }) });
  }
  for (let i = 0; i < 40; i++) appendMessage(db!, { conversationId, role: i % 2 ? 'assistant' : 'user', content: `SEEDED_HISTORY_${i}\n${'x'.repeat(long ? 4500 : 100)}` });
  return original;
}

try {
  assert.ok(existsSync(join(webRoot, 'index.html')), 'Build the current production Web bundle first');
  ensureHome(config); await new Promise<void>(done => fake.listen(0, '127.0.0.1', done));
  const address = fake.address(); assert.ok(address && typeof address !== 'string');
  db = openDatabase(config.dbPath); migrate(db);
  const provider = insertProvider(db, { name: '统一压缩 · 离线免费验收模型', baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: 'offline-compaction-fixture', contextWindow: 100000 });
  assert.equal(new URL(provider.baseUrl).hostname, '127.0.0.1'); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM providers').get()?.['n'], 1);
  setSecret(config.secretsPath, provider.id, 'fixture-only-local-placeholder');
  const project = createProject(db, config, { name: '统一上下文压缩 · 离线验收' });
  const automatic = insertConversation(db, { providerId: provider.id, model: 'offline-compaction-fixture', projectId: project.id, permissionMode: 'readonly', title: '自动80%压缩与完整原文回读' });
  const manual = insertConversation(db, { providerId: provider.id, model: 'offline-compaction-fixture', projectId: project.id, permissionMode: 'readonly', title: '手动缺三项 · 不请求模型' });
  const checkpoint = insertConversation(db, { providerId: provider.id, model: 'offline-compaction-fixture', projectId: project.id, permissionMode: 'readonly', title: '检查点缺项 · 不自动接受' });
  autoConversationId = automatic.id; const longOriginal = seed(automatic.id, true)!; seed(manual.id); seed(checkpoint.id);
  app = buildServer({ db, config }); await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
  app.get('/__verify/status', async () => ({ fixtureOnly: true, ...counters, projectId: project.id, conversationId: automatic.id, conversations: { automatic: automatic.id, manual: manual.id, checkpoint: checkpoint.id }, longOriginalSeq: longOriginal.seq, fakeFailure }));
  app.post('/__verify/stop', async () => { setTimeout(() => { void close().catch(() => { process.exitCode = 1; console.error('compaction_fixture_shutdown_failed'); }); }, 50); return { stopping: true }; });
  url = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.match(await request<string>('/'), /<html|<!doctype/i); checks.productionRoutesAndCurrentStaticWeb = true;
  const initialSettings = await request<{ general: GeneralSettings }>('/api/settings');
  assert.equal(initialSettings.general.autoCompactEnabled, true); assert.equal(initialSettings.general.compactThresholdPercent, 80); checks.defaultAutomaticTrueAnd80Percent = true;
  const beforeManualCalls = counters.allCalls, beforeManualCapsules = count('memory_capsules'), beforeManualCompactions = count('compactions');
  const blocked = await request<{ compacted: boolean; blocked: boolean; code: string; missing: string[] }>(`/api/conversations/${manual.id}/compact`, 'POST', {}, 409);
  assert.equal(blocked.compacted, false); assert.equal(blocked.blocked, true); assert.equal(blocked.code, 'duties_incomplete'); assert.deepEqual([...blocked.missing].sort(), ['ledger', 'log', 'triage']);
  assert.equal(counters.allCalls, beforeManualCalls); assert.equal(count('memory_capsules'), beforeManualCapsules); assert.equal(count('compactions'), beforeManualCompactions); checks.manualAllThreeMissing409ZeroModelAndCapsules = true;
  const opened = await request<{ checkpoint: MemoryCheckpoint }>(`/api/conversations/${checkpoint.id}/checkpoint`, 'POST', {});
  const staged = await request<{ checkpoint: MemoryCheckpoint; proposal: MemoryProposal }>(`/api/conversations/${checkpoint.id}/checkpoint/resolve`, 'POST', { checkpointId: opened.checkpoint.id, choice: 'record_compact', intent: { goal: '验证检查点同门', did: '准备单份用户摘要，不伪造三项工具收条', issues: '', next: '分别补齐三项后再检查' } });
  assert.equal(staged.proposal.status, 'pending'); const memoryPath = `/api/projects/${project.id}/memory`;
  const beforeStageTwo = await request<MemoryView>(memoryPath); const beforeCheckpointCalls = counters.allCalls; const beforeCheckpointCapsules = count('memory_capsules');
  const stageTwo = await request<{ blocked: boolean; code: string; missing: string[] }>(`/api/conversations/${checkpoint.id}/checkpoint/resolve`, 'POST', { checkpointId: opened.checkpoint.id, choice: 'record_compact', accept: true }, 409);
  assert.equal(stageTwo.blocked, true); assert.equal(stageTwo.code, 'duties_incomplete'); assert.ok(stageTwo.missing.length > 0);
  const afterStageTwo = await request<MemoryView>(memoryPath); assert.deepEqual(afterStageTwo.records, beforeStageTwo.records); assert.equal(afterStageTwo.proposals.find(proposal => proposal.id === staged.proposal.id)?.status, 'pending');
  assert.equal(counters.allCalls, beforeCheckpointCalls); assert.equal(count('memory_capsules'), beforeCheckpointCapsules); checks.checkpointStageTwoMissing409NeverAcceptsOrRequestsModel = true;
  let beforeAuto = await request<Status>(`/api/conversations/${automatic.id}/compaction-status`);
  for (let extra = 0; beforeAuto.ratio <= 0.82 && extra < 30; extra++) {
    appendMessage(db, { conversationId: automatic.id, role: extra % 2 ? 'assistant' : 'user', content: `WATERLINE_FILL_${extra}\n${'y'.repeat(6000)}` });
    beforeAuto = await request<Status>(`/api/conversations/${automatic.id}/compaction-status`);
  }
  assert.ok(beforeAuto.ratio > .8, `The actual assembled context must cross DEFAULT 80%, got ${beforeAuto.ratio}`);
  assert.equal(beforeAuto.settings.thresholdPercent, 80); assert.equal(beforeAuto.duties.complete, false);
  const authoritativeBefore = listMessages(db, automatic.id); autoTurnUserSeq = authoritativeBefore.at(-1)!.seq + 1;
  const streamed = await send(automatic.id, '[AUTO_TRIPLE_HTTP] 核验本轮实际结果：分别暂存台账更新、进展日志，然后提交triage；最后正常回答，不播报维护过程。');
  assert.equal(streamed.text, '离线核验已完成，可以继续工作。'); assert.equal(counters.primaryCalls, 2); assert.equal(counters.compactionCalls, 1); assert.equal(counters.closureCalls, 0); assert.equal(counters.maintenanceCalls, 0);
  const streamedCalls = streamed.events.flatMap(event => event.type === 'assistant' ? event.message?.toolCalls ?? [] : []);
  assert.deepEqual(streamedCalls.map(call => call.name), ['memory_propose', 'memory_stage', 'memory_stage']);
  assert.deepEqual(streamedCalls.filter(call => call.name === 'memory_stage').map(call => parse(call.arguments).action), ['intent', 'triage']);
  assert.ok(streamed.events.filter(event => event.type === 'tool').every(event => event.message?.displayChannel === 'maintenance'));
  const actual = listMessages(db, automatic.id); assert.deepEqual(actual.slice(0, authoritativeBefore.length), authoritativeBefore, 'Authoritative history bytes/fields may not be edited by compaction');
  const receipts = actual.filter(row => row.seq > autoTurnUserSeq && row.role === 'tool'); assert.equal(receipts.length, 3); assert.ok(receipts.every(row => parse(row.content).ok === true && row.displayChannel === 'maintenance'));
  pairs(actual.map(row => ({ role: row.role, tool_calls: row.toolCalls?.map(call => ({ id: call.id })), tool_call_id: row.toolCallId ?? undefined })));
  assert.equal(primaryRequests.length, 2); const beforeRequest = primaryRequests[0]!, afterRequest = primaryRequests[1]!;
  assert.equal(beforeRequest.messages[0]?.role, 'system'); assert.equal(beforeRequest.messages[0]?.content, afterRequest.messages[0]?.content); assert.equal(JSON.stringify(beforeRequest.tools), JSON.stringify(afterRequest.tools));
  assert.ok(JSON.stringify(beforeRequest.messages).includes('SEED_EARLIEST_MARKER')); assert.ok(!JSON.stringify(afterRequest.messages).includes('SEED_EARLIEST_MARKER')); assert.ok(JSON.stringify(afterRequest.messages).includes('runtime_compaction'));
  checks.realHttpSseThreeDistinctSuccessfulToolReceipts = true; checks.automatic80PercentCompactsBetweenCompleteBatches = true; checks.systemAndToolDefinitionsByteIdenticalBeforeAfter = true; checks.derivedRecapReplacesOnlyRequestHistory = true; checks.businessTextStreamsWithoutMaintenanceOrRecapLeak = true; checks.authoritativeMessagesAndToolBatchesRemainComplete = true;
  const autoStatus = await request<Status>(`/api/conversations/${automatic.id}/compaction-status`); assert.equal(autoStatus.duties.complete, true); assert.ok(autoStatus.duties.checkpoint);
  const anchor = autoStatus.duties.checkpoint;
  assert.equal(new Set([anchor.ledger.proposalId, anchor.log.proposalId, anchor.triage.proposalId]).size, 3);
  assert.ok(anchor.triage.messageSeq > Math.max(anchor.ledger.messageSeq, anchor.log.messageSeq));
  assert.equal(autoStatus.lastAttempt?.state, 'succeeded'); assert.ok(autoStatus.ratio < beforeAuto.ratio);
  const eventPage = await request<CompactionEventPage>(`/api/conversations/${automatic.id}/compaction-events?limit=50&offset=0`);
  assert.ok(eventPage.entries.some(event => event.phase === 'blocked')); assert.ok(eventPage.entries.some(event => event.phase === 'start' && event.source === 'auto')); const success = eventPage.entries.find(event => event.phase === 'success' && event.source === 'auto'); assert.ok(success); assert.ok(success.fromSeq !== null && success.toSeq !== null && success.fromSeq <= longOriginal.seq && success.toSeq >= longOriginal.seq);
  checks.blockedStartAndSuccessLogsQueryableByHttp = true;
  const writeBaseline = Number(db.prepare('SELECT total_changes() AS n').get()?.['n']); const callsBeforeGets = counters.allCalls;
  const index = await request<RecallIndex>(`/api/conversations/${automatic.id}/recall?mode=index&fromSeq=${success.fromSeq}&toSeq=${success.toSeq}&limit=2&offset=0`);
  assert.ok(index.total > index.entries.length); assert.ok(index.entries.every(entry => Object.keys(entry).sort().join(',') === 'createdAt,id,role,seq,totalChars'));
  const secondIndex = await request<RecallIndex>(`/api/conversations/${automatic.id}/recall?mode=index&fromSeq=${success.fromSeq}&toSeq=${success.toSeq}&limit=2&offset=2`); assert.ok(secondIndex.entries.every(entry => !index.entries.some(previous => previous.seq === entry.seq)));
  let serialized = '', cursor = 0, pageCount = 0;
  for (;;) {
    const page = await request<RecallMessagePage>(`/api/conversations/${automatic.id}/recall?mode=message&seq=${longOriginal.seq}&charOffset=${cursor}&maxChars=12000`);
    assert.equal(page.serialization, 'JSON(MessageRow)'); assert.equal(page.seq, longOriginal.seq); assert.equal(page.charOffset, cursor); assert.ok(page.text.length <= 12000); serialized += page.text; pageCount++;
    if (page.done) { assert.equal(page.nextOffset, null); assert.equal(serialized.length, page.totalChars); break; }
    assert.ok(page.nextOffset !== null && page.nextOffset > cursor); cursor = page.nextOffset;
  }
  assert.ok(pageCount > 2 && serialized.length > 20000); assert.equal(serialized, JSON.stringify(longOriginal)); assert.deepEqual(JSON.parse(serialized), longOriginal);
  assert.ok(longOriginal.reasoning!.length > 20000); assert.ok(longOriginal.toolCalls![0]!.arguments.length > 20000); assert.ok(serialized.includes('LONG_CONTENT_TAIL_')); assert.ok(serialized.includes('LONG_REASON_TAIL_')); assert.ok(serialized.includes('LONG_TOOL_ARGUMENT_TAIL_')); assert.deepEqual(JSON.parse(serialized).usage, longOriginal.usage);
  for (const path of [`/api/conversations/${automatic.id}/compaction-status`, `/api/conversations/${automatic.id}/compaction-events?limit=1&offset=1`, `/api/conversations/${automatic.id}/prompt`, `/api/projects/${project.id}/memory/capsules?conversationId=${automatic.id}&fromSeq=${success.fromSeq}&toSeq=${success.toSeq}`]) await request(path);
  assert.equal(Number(db.prepare('SELECT total_changes() AS n').get()?.['n']), writeBaseline); assert.equal(counters.allCalls, callsBeforeGets); checks.recallIndexHasMetadataOnlyAndRealPagination = true; checks.originalAbove20kReasoningToolCallsUsageExactRoundTrip = true; checks.allStatusLogRecallAndPromptGetsZeroWritesAndZeroModels = true;
  const beforeFinalManual = counters.compactionCalls; const finalManual = await request<{ compacted: boolean; compaction?: { fromSeq: number; toSeq: number }; reason?: string }>(`/api/conversations/${automatic.id}/compact`, 'POST', {});
  if (finalManual.compacted) { assert.ok(finalManual.compaction); assert.equal(counters.compactionCalls, beforeFinalManual + 1); }
  else { assert.equal(counters.compactionCalls, beforeFinalManual); assert.ok(finalManual.reason); }
  checks.manualAfterSuccessfulThreeLayersEitherCompactsOrHonestlyNoCandidate = true;
  assert.equal(fakeFailure, null); assert.equal(counters.paidModelCalls, 0); assert.equal(counters.maintenanceCalls, 0); checks.offlineLoopbackOnlyNoPaidOrMaintenanceGeneration = true;
  const allModelBeforeSettings = counters.allCalls; const patched = await request<{ general: GeneralSettings }>('/api/settings', 'PATCH', { general: { autoCompactEnabled: false, compactThresholdPercent: 82.25 } });
  assert.equal(patched.general.autoCompactEnabled, false); assert.equal(patched.general.compactThresholdPercent, 82.25); assert.equal(counters.allCalls, allModelBeforeSettings);
  const restored = await request<{ general: GeneralSettings }>('/api/settings', 'PATCH', { general: { autoCompactEnabled: true, compactThresholdPercent: 80 } }); assert.equal(restored.general.compactThresholdPercent, 80); checks.settingsPersistDecimalAndToggleWithoutModelAndRestoreBrowser80 = true;
  const report = { verifiedAt: new Date().toISOString(), fixtureOnly: true, baseURL: url, running: serve, schemaVersion: SCHEMA_VERSION, homeKind: 'New temporary ALKAID_HOME, deleted on stop', modelKind: 'Exactly one loopback SSE fake provider; no paid provider configured', projectId: project.id, conversationId: automatic.id, conversations: { automatic: automatic.id, manual: manual.id, checkpoint: checkpoint.id }, checks, checkCount: Object.keys(checks).length, ...counters,
    waterline: { thresholdPercent: 80, contextWindow: beforeAuto.contextWindow, ratioBefore: beforeAuto.ratio, ratioAfter: autoStatus.ratio },
    stablePrefix: { systemBytes: Buffer.byteLength(beforeRequest.messages[0]!.content!), systemSha256Before: hash(beforeRequest.messages[0]!.content!), systemSha256After: hash(afterRequest.messages[0]!.content!), toolsBytes: Buffer.byteLength(JSON.stringify(beforeRequest.tools)), toolsSha256Before: hash(JSON.stringify(beforeRequest.tools)), toolsSha256After: hash(JSON.stringify(afterRequest.tools)) },
    originalRoundTrip: { seq: longOriginal.seq, jsonChars: serialized.length, pages: pageCount, reasoningChars: longOriginal.reasoning!.length, toolArgumentChars: longOriginal.toolCalls![0]!.arguments.length, sha256: hash(serialized), complete: true }, compactRequests, finalManualOutcome: finalManual.compacted ? 'compacted' : 'no_candidate', browserFixture: { stopPath: '/__verify/stop', statusPath: '/__verify/status', initialTab: '日志 -> 上下文压缩 / 原文回读', longOriginalSeq: longOriginal.seq, originalRange: { fromSeq: success.fromSeq, toSeq: success.toSeq }, settings: { enabled: true, thresholdPercent: 80 } } };
  mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ready: true, URL: url, conversationId: automatic.id, projectId: project.id, reportPath, checkCount: report.checkCount, counters, serve }));
  if (!serve) await close();
} catch (error) {
  try { await close(); } catch (cleanupError) { console.error('compaction_fixture_cleanup_failed', cleanupError instanceof Error ? cleanupError.message : 'unknown'); }
  throw error;
}
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
