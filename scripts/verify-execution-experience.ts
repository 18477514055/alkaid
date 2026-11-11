/** Real HTTP/SSE acceptance fixture. Isolated new home + loopback fake only; never production data or paid models. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ensureHome, loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/core/store/db.ts';
import { migrate, SCHEMA_VERSION } from '../src/core/store/schema.ts';
import { insertConversation, insertProvider, listMessages } from '../src/core/store/repo.ts';
import { createProject } from '../src/core/project/service.ts';
import { setSecret } from '../src/core/secrets.ts';
import { buildServer } from '../src/server/app.ts';
import type { ExecutionBoard } from '../src/shared/execution.ts';
import type { MemoryView } from '../src/shared/memory.ts';
import type { ObligationPage } from '../src/shared/memory-obligations.ts';
import type { PrincipleCurrent, PrincipleProposal } from '../src/shared/memory-workbench.ts';

const home = mkdtempSync(join(tmpdir(), 'alkaid-execution-review-'));
const config = loadConfig({ ALKAID_HOME: home });
/**
 * 报告写到哪。
 *
 * ★ 为什么要支持环境变量覆盖：这个夹具现在挂在 `npm run gate` 里，每跑一次门禁就会
 *   把 `docs/` 下的验收回执刷新一遍（时间戳、随机 UUID 全变）⇒ 工作树**永远是脏的**，
 *   而 `docs/验收-*.json` 是**证据**，不是测试输出。脏工作树会让人分不清
 *   "这次改了什么"和"门禁刚跑过"。
 *   ⇒ 门禁把 `ALKAID_VERIFY_REPORT_DIR` 指到临时目录；人工跑（不带该变量）仍写 docs/，
 *     要留档时照旧直接 `node scripts/verify-execution-experience.ts`。
 */
const reportPath = process.env['ALKAID_VERIFY_REPORT_DIR']
  ? resolve(process.env['ALKAID_VERIFY_REPORT_DIR'], '验收-简明工作看板-HTTP.json')
  : resolve('../docs/验收-简明工作看板-HTTP.json');
const counters = { allCalls: 0, primaryCalls: 0, closureCalls: 0, maintenanceCalls: 0, paidModelCalls: 0 };
const checks: Record<string, boolean> = {};
let closureSawEarlierShortMarker = false;
let firstBusinessSystem: string | undefined;
let db: DatabaseSync | undefined;
let app: FastifyInstance | undefined;
let url = '';
let closePromise: Promise<void> | undefined;
type WireCall = { id?: string; function?: { name?: string; arguments?: string } };
type WireMessage = { role: string; content?: string | null; tool_calls?: WireCall[]; tool_call_id?: string };
type WireRequest = { messages: WireMessage[]; tools?: { function?: { name?: string }; name?: string }[] };
type StreamEvent = { type: string; delta?: string; message?: ReturnType<typeof listMessages>[number]; reason?: string };
function parse(value: string | null | undefined): Record<string, unknown> {
  const out: unknown = JSON.parse(value ?? '{}');
  assert.ok(out && typeof out === 'object' && !Array.isArray(out));
  return out as Record<string, unknown>;
}
const fake = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'local-execution-experience' }] })); return; }
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as WireRequest;
    assert.ok(Array.isArray(body.messages)); counters.allCalls++;
    const system = String(body.messages[0]?.content ?? '');
    const isClosure = body.messages.some(message => String(message.content ?? '').includes('MEMORY_TURN_CLOSURE'));
    if (!system.startsWith('You maintain project memory')) {
      assert.doesNotMatch(system, /MEMORY_TURN_CLOSURE/);
      if (firstBusinessSystem === undefined) firstBusinessSystem = system;
      else assert.equal(system, firstBusinessSystem, 'derived runtime context must not rewrite the first system prefix');
    }
    const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
    const userText = String(lastUser?.content ?? '');
    const last = body.messages.at(-1);
    const lastCall = [...body.messages].reverse().find(m => m.role === 'assistant' && m.tool_calls?.length)?.tool_calls?.at(-1);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const call = (index: number, name: string, args: object) => frame({ tool_calls: [{ index, id: `execution-fixture-${counters.allCalls}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const prose = async (text: string) => { frame({ content: text.slice(0, 4) }); await delay(70); frame({ content: text.slice(4) }); };
    let finish = 'stop';
    if (system.startsWith('You maintain project memory')) {
      counters.maintenanceCalls++;
      // Any maintenance generation would fail the zero-maintenance assertions below.
      frame({ content: JSON.stringify({ decisions: [] }) });
    } else if (isClosure) {
      counters.closureCalls++;
      closureSawEarlierShortMarker = body.messages.some(m => m.content?.includes('EARLY_CONTEXT_SSE'));
      const key = `experience-closure-${counters.closureCalls}`;
      call(0, 'memory_propose', { recordId: key, kind: 'active', title: '真实执行看板与整理边界的已核验进展', operation: 'upsert',
        content: '本主对话已通过真实execution_board工具建立并完成两项任务；readonly文件档下原则整理提议进入人工待批，未改变正式原则。整理覆盖此前短轮的工具回执，不是只记最后一句。',
        baseRevision: 0, reason: '本会话execution_board与memory_stage成功回执；含EARLY_CONTEXT_SSE之前材料', idempotencyKey: key });
      call(1, 'memory_stage', { action: 'triage', payload: {
        keep: [{ what: '当前执行目标按主对话隔离；项目记忆整理不等于文件写权限，原则仍待人工审核。' }],
        stash: [{ what: 'EARLY_CONTEXT_SSE短交流标记和两轮execution_board成功回执在本会话可逐字回读。' }], drop: [],
      }, idempotencyKey: `triage-${key}`, reason: '真实业务与工具回执后的明确取舍' });
      finish = 'tool_calls';
    } else {
      counters.primaryCalls++;
      if (userText.includes('[EXEC_START]') || userText.includes('[EXEC_COMPLETE]')) {
        if (last?.role === 'user') { call(0, 'execution_board', { action: 'read' }); finish = 'tool_calls'; }
        else if (last?.role === 'tool' && lastCall?.function?.name === 'execution_board' && parse(lastCall.function.arguments)['action'] === 'read') {
          const receipt = parse(last.content); assert.equal(receipt['ok'], true);
          const board = parse(String(receipt['content'])) as unknown as ExecutionBoard;
          assert.ok(Number.isSafeInteger(board.revision));
          const complete = userText.includes('[EXEC_COMPLETE]');
          call(0, 'execution_board', { action: 'update', baseRevision: board.revision,
            goal: { title: '核验简明工作看板的真实执行', status: complete ? 'completed' : 'active', summary: '由本轮用户明确指定，不是项目长期目标树。' },
            tasks: [
              { id: 'observe', content: '核验目标、任务和动态能够实时读回', status: complete ? 'completed' : 'in_progress' },
              { id: 'verify', content: '核验只读文件权限与项目记忆整理相互独立', status: complete ? 'completed' : 'pending' },
            ], activity: complete ? '两项任务已根据真实执行回执完成' : '已建立当前目标与有序任务，开始核验',
          }); finish = 'tool_calls';
        } else {
          assert.equal(parse(last?.content)['ok'], true);
          await prose(userText.includes('[EXEC_COMPLETE]') ? '两项核验任务已完成，可以继续下一步。' : '目标与两项任务已建立，正在按顺序核验。');
        }
      } else if (userText.includes('[PRINCIPLE_READONLY]')) {
        if (last?.role === 'user') {
          call(0, 'memory_stage', { action: 'principle_propose', payload: { recordId: 'fixture-local-review', title: '本地与人工复核边界',
            content: '这是隔离验收中的待批原则：项目记忆仅本地存储；正式原则变更必须独立人工批准。', operation: 'upsert', baseRevision: 0 },
            idempotencyKey: 'readonly-principle-review', reason: '当前用户要求整理后排队人工审核' }); finish = 'tool_calls';
        } else { const result = parse(last?.content); assert.equal(result['ok'], true); assert.equal(parse(String(result['content']))['pendingHumanApproval'], true); await prose('已核对整理要求，可以继续下一项工作。'); }
      } else if (userText.includes('[CROSS_INTERVAL]')) await prose('业务调查已完成，事实与边界已经核实。');
      else await prose('已收到，继续正常工作。');
    }
    frame({}, finish);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'local_execution_fixture_invalid_request' }));
  }
});
function close(): Promise<void> {
  return closePromise ??= (async () => {
    await app?.close();
    if (fake.listening) await new Promise<void>((done, reject) => fake.close(error => error ? reject(error) : done()));
    db?.close();
    const absolute = resolve(home), allowedPrefix = resolve(tmpdir(), 'alkaid-execution-review-');
    assert.ok(absolute.startsWith(allowedPrefix) && absolute.length > allowedPrefix.length, 'Only this newly created temporary fixture home may be removed');
    rmSync(absolute, { recursive: true, force: true });
  })();
}
async function request<T>(path: string, method = 'GET', payload?: unknown, expected = 200): Promise<T> {
  const response = await fetch(url + path, { method, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 250)}`);
  return (response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text) as T;
}
async function send(conversationId: string, content: string) {
  const response = await fetch(`${url}/api/conversations/${conversationId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/); assert.ok(response.body);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = ''; const events: StreamEvent[] = [];
  let firstTextAt: number | null = null, finishAt: number | null = null;
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    pending += decoder.decode(part.value, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).trimEnd(); pending = pending.slice(newline + 1);
      if (!line.startsWith('data: ')) continue;
      const e = JSON.parse(line.slice(6)) as StreamEvent; events.push(e);
      if (e.type === 'text' && firstTextAt === null) firstTextAt = Date.now();
      if (e.type === 'finish') finishAt = Date.now();
    }
  }
  assert.ok(events.some(e => e.type === 'finish' && e.reason === 'stop'), 'Real SSE must complete successfully');
  assert.ok(firstTextAt !== null && finishAt !== null && firstTextAt < finishAt, 'Business text must arrive before finish, not only after buffering');
  return { events, text: events.filter(e => e.type === 'text').map(e => e.delta ?? '').join('') };
}
function assertMaintenanceTools(events: StreamEvent[], names: string[]) {
  const tools = events.filter(e => e.type === 'tool'); assert.ok(tools.length >= names.length);
  assert.ok(tools.every(e => e.message?.displayChannel === 'maintenance'));
  const actualNames = events.flatMap(e => e.type === 'assistant' ? e.message?.toolCalls?.map(c => c.name) ?? [] : []);
  for (const name of names) assert.ok(actualNames.includes(name));
}

try {
  assert.ok(existsSync(resolve('dist/web/index.html')), 'Build the production Web bundle before this acceptance fixture');
  ensureHome(config); mkdirSync(join(home, 'empty-plugins'));
  await new Promise<void>(done => fake.listen(0, '127.0.0.1', done));
  const address = fake.address(); assert.ok(address && typeof address !== 'string');
  db = openDatabase(config.dbPath); migrate(db);
  const provider = insertProvider(db, { name: '简明工作看板 · 本地免费验收模型', baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: 'local-execution-experience', contextWindow: 1_000_000 });
  assert.equal(new URL(provider.baseUrl).hostname, '127.0.0.1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM providers').get()?.['n'], 1, 'The isolated database must contain only this loopback fake provider');
  setSecret(config.secretsPath, provider.id, 'fixture-only-local-placeholder');
  const project = createProject(db, config, { name: '简明工作看板 · 执行与整理体验验收' });
  const foreign = createProject(db, config, { name: '隔离项目 B · 不得串读' });
  const a = insertConversation(db, { projectId: project.id, providerId: provider.id, model: 'local-execution-experience', permissionMode: 'readonly', title: '主对话 A · 当前目标与整理节奏' });
  const b = insertConversation(db, { projectId: project.id, providerId: provider.id, model: 'local-execution-experience', permissionMode: 'readonly', title: '主对话 B · 独立空执行板' });
  const child = insertConversation(db, { projectId: project.id, providerId: provider.id, model: 'local-execution-experience', agentRole: 'subagent', permissionMode: 'readonly', title: '子智能体 · 无项目执行板权限' });
  const foreignConv = insertConversation(db, { projectId: foreign.id, providerId: provider.id, model: 'local-execution-experience', title: '隔离项目对话' });
  app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ db, config }); await app.register(fastifyStatic, { root: resolve('dist/web'), prefix: '/' });
  app.get('/__verify/status', async () => ({ ...counters, projectId: project.id, foreignProjectId: foreign.id, conversations: { a: a.id, b: b.id, child: child.id, foreign: foreignConv.id }, fixtureOnly: true }));
  app.post('/__verify/stop', async () => { setTimeout(() => { void close().catch(() => { process.exitCode = 1; console.error('execution_fixture_shutdown_failed'); }); }, 50); return { stopping: true }; });
  url = await app.listen({ host: '127.0.0.1', port: 0 });
  const memory = `/api/projects/${project.id}/memory`, execution = `/api/projects/${project.id}/execution`;
  const root = await request<string>('/'); assert.match(root, /<html|<!doctype/i); checks.productionDistServed = true;
  const policy = await request<{ thresholdPercent: number }>(`${memory}/policy`); assert.equal(policy.thresholdPercent, 5); assert.equal(provider.contextWindow, 1_000_000); checks.defaultFivePercentAndMillionWindow = true;
  for (const id of [a.id,b.id]) { const board = await request<ExecutionBoard>(`${execution}/${id}`); assert.equal(board.revision, 0); assert.equal(board.goal, null); assert.deepEqual(board.tasks, []); }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_boards').get()?.['n'], 0); checks.emptyReadsNeverInventExecutionGoal = true;
  for (const text of ['[EARLY_CONTEXT_SSE] 先确认本轮目标，不立即整理。','[SHORT_2] 好的，继续。','[SHORT_3] 收到。']) { const reply = await send(a.id, text); assert.equal(reply.text, '已收到，继续正常工作。'); }
  assert.equal(counters.primaryCalls, 3); assert.equal(counters.closureCalls, 0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_obligations').get()?.['n'], 0); checks.defaultShortExchangesZeroClosureAndObligations = true;
  const start = await send(a.id, '[EXEC_START] 用户明确目标为核验简明工作看板，请建立两项有序任务并开始核验。');
  assertMaintenanceTools(start.events, ['execution_board']); assert.equal(start.text, '目标与两项任务已建立，正在按顺序核验。');
  const started = await request<ExecutionBoard>(`${execution}/${a.id}`); assert.equal(started.revision, 1); assert.equal(started.goal?.status, 'active');
  assert.deepEqual(started.tasks.map(t => [t.id,t.status]), [['observe','in_progress'],['verify','pending']]); assert.ok(started.events[0]?.text.includes('已建立'));
  checks.realModelReadThenUpdateCreatesExecutionBoard = true;
  const complete = await send(a.id, '[EXEC_COMPLETE] 用户确认两项核验均已完成，请先读取当前执行板，再更新任务完成状态并追加动态。');
  assertMaintenanceTools(complete.events, ['execution_board']); assert.equal(complete.text, '两项核验任务已完成，可以继续下一步。');
  const completed = await request<ExecutionBoard>(`${execution}/${a.id}`); assert.equal(completed.revision, 2); assert.equal(completed.goal?.status, 'completed'); assert.ok(completed.tasks.every(t => t.status === 'completed')); assert.equal(completed.events.length, 2);
  const calls = listMessages(db,a.id).flatMap(m => m.toolCalls ?? []).filter(c => c.name === 'execution_board').map(c => parse(c.arguments)['action']);
  assert.deepEqual(calls, ['read','update','read','update']); checks.secondRealModelTurnCompletesTasksAndAppendsActivity = true; checks.maintenanceChannelWithVisibleStreamingBusinessReply = true;
  const peer = await request<ExecutionBoard>(`${execution}/${b.id}`); assert.equal(peer.revision, 0); assert.equal(peer.goal, null); checks.sameProjectMainConversationsHaveIndependentBoards = true;
  // ★ 判据变更（用户 2026-11-10）：「子代理可以只读所有东西，不能改除了自己的看板之外的任何东西」。
  //   所以这里不再断言 403，而是断言**它能读写自己那一行、但碰不到别人的**。
  const childOwn = await request<ExecutionBoard>(`${execution}/${child.id}`); assert.equal(childOwn.revision, 0); assert.equal(childOwn.conversationId, child.id);
  const childWrite = await request<ExecutionBoard>(`${execution}/${child.id}`, 'PATCH', { baseRevision: 0, activity: 'subagent own progress' }); assert.equal(childWrite.revision, 1); assert.equal(childWrite.conversationId, child.id);
  const mainUntouched = await request<ExecutionBoard>(`${execution}/${a.id}`); assert.equal(mainUntouched.revision, 2); assert.equal(mainUntouched.conversationId, a.id);
  assert.equal(mainUntouched.events.length, 2, '子代理写自己的板时碰到了主对话的板');
  checks.subagentOwnsOnlyItsOwnExecutionBoard = true;
  checks.persistedSubagentCannotReadOrWriteExecution = false;
  const principle = await send(a.id, '[PRINCIPLE_READONLY] 本对话文件权限保持只读。请整理本地与人工复核边界为原则变更建议，仅排队review，不批准。');
  assertMaintenanceTools(principle.events, ['memory_stage']); assert.equal(principle.text, '已核对整理要求，可以继续下一项工作。');
  const principles = await request<PrincipleCurrent>(`${memory}/principles/current`); const pending = await request<PrincipleProposal[]>(`${memory}/principles/proposals`);
  assert.equal(principles.records.length, 0); assert.equal(pending.length, 1); assert.equal(pending[0]?.status, 'pending'); assert.equal(counters.maintenanceCalls, 0);
  assert.equal(db.prepare('SELECT permission_mode FROM conversations WHERE id=?').get(a.id)?.['permission_mode'], 'readonly'); checks.readonlyFileMainCanQueuePrincipleButNeverApprove = true;
  const beforeContinue = counters.allCalls; const next = await send(a.id, '[SHORT_CONTINUE] 继续核对下一步工作。'); assert.equal(next.text, '已收到，继续正常工作。'); assert.equal(counters.allCalls, beforeContinue + 1); assert.equal(counters.closureCalls, 0); checks.nextShortTurnContinuesWithoutForcedClosure = true;
  for (const invalid of [{ thresholdPercent: -1 }, { thresholdPercent: 51 }, { thresholdPercent: '5' }, { thresholdPercent: 5, extra: true }]) await request(`${memory}/policy`, 'PATCH', invalid, 400);
  assert.equal((await request<{ thresholdPercent: number }>(`${memory}/policy`, 'PATCH', { thresholdPercent: 0.01 })).thresholdPercent, 0.01); checks.policyApiValidatesAndAcceptsDecimalThreshold = true;
  const closureBefore = counters.closureCalls;
  const crossed = await send(a.id, '[CROSS_INTERVAL] ' + '中'.repeat(200)); assert.equal(crossed.text, '业务调查已完成，事实与边界已经核实。');
  assert.equal(counters.closureCalls, closureBefore + 1); assert.ok(closureSawEarlierShortMarker); assertMaintenanceTools(crossed.events, ['memory_propose','memory_stage']);
  const obligations = await request<ObligationPage>(`${memory}/obligations?conversationId=${a.id}&includeResolved=true`);
  const fulfilled = obligations.entries.find(o => o.status === 'staged'); assert.ok(fulfilled); assert.equal(fulfilled.repairAttempt, 1); assert.equal(fulfilled.evidence.length, 2); assert.ok(fulfilled.evidence.every(e => e.valid && !e.stale));
  const beforeAccept = await request<MemoryView>(memory); assert.equal(beforeAccept.records.length, 0); assert.equal(beforeAccept.proposals.length, 2); assert.ok(beforeAccept.proposals.every(p => p.status === 'pending'));
  checks.thresholdCrossingMakesOneRealDualProposalClosure = true; checks.closureReceivesEarlierShortTurnMarker = true; checks.dualProposalsRemainPendingIndependentReview = true;
  const beforeResetShort = counters.allCalls; await send(a.id, '[SHORT_AFTER_RESET] 收到。'); assert.equal(counters.allCalls, beforeResetShort + 1); assert.equal(counters.closureCalls, closureBefore + 1); checks.successfulCaptureResetsIntervalForNextShortTurn = true;
  // Explicit fixture-only HUMAN acceptance for a useful browser demo. Neither execution updates nor model closure applies formal memory.
  const active = beforeAccept.proposals.find(p => p.kind === 'active'); assert.ok(active);
  await request(`${memory}/proposals/${active.id}/accept`, 'POST', {});
  const accepted = await request<MemoryView>(memory); assert.equal(accepted.records.length, 1); assert.equal(accepted.records[0]?.kind, 'active');
  assert.equal((await request<PrincipleCurrent>(`${memory}/principles/current`)).records.length, 0); checks.fixtureIndependentHumanAcceptsOneActiveRecordOnly = true;
  assert.equal((await request<{ thresholdPercent: number }>(`${memory}/policy`, 'PATCH', { thresholdPercent: 5 })).thresholdPercent, 5); checks.browserFixtureRestoresDefaultFivePercent = true;
  const changes = Number(db.prepare('SELECT total_changes() AS n').get()?.['n']), beforeGets = counters.allCalls;
  for (const path of [memory, `${memory}/policy`, `${memory}/obligations?includeResolved=true`, `${memory}/principles/current`, `${memory}/principles/proposals`, `${execution}/${a.id}`, `${execution}/${b.id}`, `/api/conversations/${a.id}/prompt`, `/api/conversations/${a.id}/dashboard`]) await request(path);
  assert.equal(Number(db.prepare('SELECT total_changes() AS n').get()?.['n']), changes); assert.equal(counters.allCalls, beforeGets); checks.allOrdinaryGetsAreLocalAndZeroGeneration = true;
  await request(`/api/projects/${foreign.id}/execution/${a.id}`, 'GET', undefined, 404); await request(`/api/projects/${foreign.id}/memory/obligations?conversationId=${a.id}`, 'GET', undefined, 404);
  assert.equal((await request<MemoryView>(`/api/projects/${foreign.id}/memory`)).records.length, 0); assert.equal((await request<ExecutionBoard>(`/api/projects/${foreign.id}/execution/${foreignConv.id}`)).revision, 0); checks.projectIsolation = true;
  assert.equal(counters.maintenanceCalls, 0); assert.equal(counters.paidModelCalls, 0); checks.zeroAutomaticMaintenanceAndPaidCalls = true;
  const report = { verifiedAt: new Date().toISOString(), baseURL: url, schema: SCHEMA_VERSION, fixtureOnly: true, homeKind: 'new temporary ALKAID_HOME; removed on stop', modelKind: 'loopback fake only', projectId: project.id, foreignProjectId: foreign.id,
    conversations: { a: a.id, b: b.id, child: child.id, foreign: foreignConv.id }, contextWindow: provider.contextWindow, initialThresholdPercent: policy.thresholdPercent, crossingThresholdPercent: 0.01, restoredThresholdPercent: 5,
    checks, checkCount: Object.keys(checks).length, ...counters,
    paidModelCallBasis: 'The new isolated database has exactly one provider, verified 127.0.0.1 loopback; all inference requests are counted by this fake server. No paid provider is configured.',
    closureSawEarlierShortMarker, executionRevision: completed.revision, obligationSummary: obligations.summary,
    browserFixture: { activeRecordAcceptedBy: 'explicit fixture human POST accept, not model or auto-maintainer', pendingPrincipleCount: pending.length, completedTaskIds: completed.tasks.map(t => t.id), stopPath: '/__verify/stop' } };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify({ ready: true, ...report, reportPath }));
  if (!process.argv.includes('--serve')) await close();
} catch (error) { await close(); throw error; }
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
