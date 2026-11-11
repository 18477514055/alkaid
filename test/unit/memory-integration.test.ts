import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import { projectMemoryBlock } from '../../src/core/agent/prompt/memory.ts';
import { applyProposalManually, getMemoryView, submitProposal } from '../../src/core/memory/store.ts';
import { setMemoryPolicy } from '../../src/core/memory/rhythm.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { insertConversation, insertProject, insertProvider, listMessages } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import { createSurface } from '../../src/core/tools/runtime.ts';
import { createMemoryTools } from '../../src/core/tools/memory.ts';
import { ToolRegistry, type ToolContext } from '../../src/core/tools/types.ts';
import { buildServer } from '../../src/server/app.ts';
import { loadConfig } from '../../src/config.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db);
  const provider = insertProvider(db, { name: 'offline', baseUrl: 'http://127.0.0.1:1/v1' });
  const a = insertProject(db, { id: 'project-a', name: 'A', sharedDir: 'C:/owned/a' });
  const b = insertProject(db, { id: 'project-b', name: 'B', sharedDir: 'C:/owned/b' });
  // These integration cases intentionally exercise the per-turn closure contract,
  // not the production default threshold's accumulation behavior.
  setMemoryPolicy(db, a.id, { thresholdPercent: 0 });
  setMemoryPolicy(db, b.id, { thresholdPercent: 0 });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'offline', projectId: a.id, permissionMode: 'project' });
  return { db, provider, a, b, conversation };
}

test('a persisted running marker from a stopped process does not lock conversation resume or settings forever', async () => {
  const { db, conversation } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-memory-resume-'));
  db.prepare("UPDATE conversations SET state='running' WHERE id=?").run(conversation.id);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ db, config: { ...loadConfig(), home: dir, secretsPath: join(dir, 'missing-secrets.json') } });
  try {
    const patch = await app.inject({ method: 'PATCH', url: `/api/conversations/${conversation.id}`, payload: { title: 'resumable' } });
    assert.equal(patch.statusCode, 200);
    const send = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/messages`, payload: { content: 'resume' } });
    assert.equal(send.statusCode, 412, 'normal missing-key check, not a permanent false running 409');
  } finally { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
function input(conversationId: string, recordId = 'active-current') {
  return { conversationId, recordId, kind: 'active' as const, title: 'Current work', operation: 'upsert' as const, content: 'VERIFIED_OFFICIAL', baseRevision: 0, reason: 'test fixture evidence', idempotencyKey: `fixture-${recordId}` };
}
function context(conversationId: string, permissionMode: ToolContext['permissionMode'] = 'project'): ToolContext {
  return { conversationId, permissionMode, roots: { readable: [], writable: [], anywhere: false }, workspacePath: null, projectSharedDir: null, cwd: '.', tempDir: '.', signal: new AbortController().signal };
}

test('memory tools: execution project comes from conversation, readonly can stage memory independently, disabled tool cannot run', async () => {
  const { db, conversation } = fixture();
  try {
    const registry = createDefaultRegistry(db);
    assert.equal(createSurface(registry, 'readonly').canCall('memory_propose'), true);
    assert.equal(createSurface(registry, 'readonly').canCall('memory_stage'), true);
    assert.equal(createSurface(registry, 'project', new Map([['memory_propose', 'disabled']])).canCall('memory_propose'), false);
    assert.equal(createSurface(registry, 'readonly', new Map([['memory_propose', 'disabled']])).canCall('memory_propose'), false);
    const write = createMemoryTools(db).find(t => t.name === 'memory_propose')!;
    const { conversationId: _ignored, ...args } = input(conversation.id);
    const readonlyProgress = await write.execute(args, context(conversation.id, 'readonly'));
    assert.equal(readonlyProgress.ok, true);
    const readonlyTriage = await registry.execute('memory_stage', { action: 'triage', payload: { keep: [{ what: 'verified readonly finding' }], stash: [], drop: [] }, idempotencyKey: 'readonly-triage', reason: 'verified read evidence' }, context(conversation.id, 'readonly'));
    assert.equal(readonlyTriage.ok, true);
    const accepted = await registry.execute('memory_propose', { ...args, projectId: 'project-b' }, context(conversation.id));
    assert.equal(accepted.ok, true);
    assert.equal(getMemoryView(db, 'project-a').proposals.length, 2, 'readonly progress and triage are real staged proposals; repeated progress remains idempotent');
    assert.equal(getMemoryView(db, 'project-a').records.length, 0);
    assert.equal(getMemoryView(db, 'project-b').proposals.length, 0);
    const missing = insertConversation(db, { providerId: conversation.providerId, model: 'offline' });
    const read = await registry.execute('memory_read', {}, context(missing.id));
    assert.equal(read.ok, false);
  } finally { db.close(); }
});

test('memory snapshot: only formal current-project records; main loop and prompt viewer use identical source', async () => {
  const { db, conversation } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-memory-inject-'));
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ db, config: { ...loadConfig(), home: dir, secretsPath: join(dir, 'secrets.json') } });
  try {
    const p = submitProposal(db, input(conversation.id)); applyProposalManually(db, 'project-a', p.id);
    submitProposal(db, { ...input(conversation.id, 'pending-only'), content: 'UNMERGED_PRIVATE_FACT' });
    const block = projectMemoryBlock(db, conversation.id)!;
    assert.match(block, /VERIFIED_OFFICIAL/); assert.doesNotMatch(block, /UNMERGED_PRIVATE_FACT/);
    const foreign = insertConversation(db, { providerId: conversation.providerId, model: 'offline', projectId: 'project-b' });
    const q = submitProposal(db, { ...input(foreign.id), content: 'FOREIGN_PROJECT_FACT' }); applyProposalManually(db, 'project-b', q.id);
    assert.doesNotMatch(block, /FOREIGN_PROJECT_FACT/);
    const requests: ChatRequest[] = [];
    const provider: Provider = { id: 'offline', async *stream(req) { requests.push(req); yield { type: 'text', delta: 'business result' }; yield { type: 'finish', reason: 'stop' }; } };
    for await (const _ of runTurn({ db, conversationId: conversation.id, userText: 'work', provider, tools: createDefaultRegistry(db), signal: new AbortController().signal })) { /* collect through completion */ }
    const response = await app.inject(`/api/conversations/${conversation.id}/prompt`);
    assert.equal(response.statusCode, 200);
    const section = response.json().sections.find((s: { id: string }) => s.id === 'project-memory');
    assert.equal(section.text, block);
    assert.ok(requests[0]?.messages.some(message => message.role === 'user' && message.content?.includes(section.text)), 'formal project memory belongs in runtime-derived context');
    assert.ok(!requests[0]?.messages[0]?.content?.includes(section.text), 'turn memory must not rewrite the first system prefix');
    assert.doesNotMatch(String(requests[0]?.messages[0]?.content), /VERIFIED_OFFICIAL|UNMERGED_PRIVATE_FACT|FOREIGN_PROJECT_FACT/);
    const registry = createDefaultRegistry(db);
    const read = await registry.execute('memory_read', { includeOwnPending: true }, context(conversation.id));
    assert.equal(read.ok, true); if (read.ok) assert.equal(JSON.parse(read.content).pendingIsNotOfficial, true);
  } finally { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('maintenance-only prose is never emitted as chat deltas; full protocol history and presentation flags survive reload', async () => {
  const { db, conversation } = fixture();
  try {
    const { conversationId: _ignored, ...args } = input(conversation.id);
    const scripts: ChatEvent[][] = [
      [{ type: 'text', delta: 'MAINTENANCE_PREFACE' }, { type: 'reasoning', delta: 'PRIVATE_MAINTENANCE_REASONING' }, { type: 'tool_call', index: 0, id: 'stage-1', name: 'memory_propose', argsDelta: JSON.stringify(args) }, { type: 'finish', reason: 'tool_calls' }],
      [{ type: 'text', delta: 'BUSINESS_RESULT' }, { type: 'finish', reason: 'stop' }],
    ];
    const requests: ChatRequest[] = [];
    const provider: Provider = { id: 'offline', async *stream(req) { requests.push(req); for (const event of scripts.shift() ?? []) yield event; } };
    const events: TurnEvent[] = [];
    for await (const event of runTurn({ db, conversationId: conversation.id, userText: 'work', provider, tools: createDefaultRegistry(db), signal: new AbortController().signal })) events.push(event);
    /**
     * ★ 契约在 2026-11-07 变了：**正文优先流式**。
     *   旧契约要求"维护步的正文一个字都不许流出去"，实现方式却是"只要注册表里有维护工具就全量缓冲正文"，
     *   而生产注册表一定有 memory 工具 ⇒ **所有档位、所有步骤**都不再流式（实测首字 11ms → 618ms）。
     *   新契约：
     *   ① 维护调用**之前**已吐出的正文/推理，会实时流出去（提示词已要求模型不要预告记账动作）；
     *   ② 维护调用**之后**的正文一律不再实时转发；
     *   ③ 落库时这一步整体标 maintenance，界面按通道分流 ⇒ 刚才闪过的部分随消息重分类消失。
     *   所以这里只钉"持久化与分流"，不钉"一个字都没流过"。
     */
    const streamed = events.filter(e => e.type === 'text').map(e => (e.type === 'text' ? e.delta : '')).join('');
    assert.equal(streamed.includes('BUSINESS_RESULT'), true, '第二步是普通业务回复，必须流式到达');
    const saved = listMessages(db, conversation.id);
    const first = saved.find(m => m.toolCalls?.length)!;
    assert.equal(first.displayChannel, 'maintenance'); assert.equal(first.content, 'MAINTENANCE_PREFACE');
    assert.equal(first.toolCalls?.[0]?.displayChannel, 'maintenance');
    const result = saved.find(m => m.role === 'tool')!;
    assert.equal(result.displayChannel, 'maintenance'); assert.equal(result.toolCallId, 'stage-1');
    assert.equal(JSON.parse(result.content!).applied, undefined); // envelope retains structured tool result
    assert.equal(JSON.parse(JSON.parse(result.content!).content).applied, false);
    assert.equal(requests.length, 3, '显式0%每轮强制模式下，仅提交进展但缺分流必须补收尾一次，不能冒充全部履责');
    assert.ok(requests[2]?.messages.some(message => message.role === 'user' && String(message.content).includes('MEMORY_TURN_CLOSURE')));
    assert.doesNotMatch(String(requests[2]?.messages[0]?.content), /MEMORY_TURN_CLOSURE/);
    assert.equal(requests[2]?.messages[0]?.content, requests[0]?.messages[0]?.content, 'maintenance continuation preserves the first system prefix');
    assert.ok(requests[1]?.messages.some(m => m.role === 'tool' && m.toolCallId === 'stage-1'));
    assert.equal(getMemoryView(db, 'project-a').records.length, 0);
  } finally { db.close(); }
});

test('mixed maintenance and ordinary calls preserve ordinary chat and classify each result independently', async () => {
  const { db, conversation } = fixture();
  try {
    const registry = new ToolRegistry(); for (const t of createMemoryTools(db)) registry.register(t);
    registry.register({ name: 'echo', modes: ['project'], description: 'ordinary', parameters: {}, async execute() { return { ok: true, content: 'ordinary output' }; } });
    let step = 0;
    const provider: Provider = { id: 'offline', async *stream() {
      if (step++ === 0) {
        yield { type: 'text', delta: 'MIXED_BUSINESS' };
        yield { type: 'tool_call', index: 0, id: 'read-memory', name: 'memory_read', argsDelta: '{}' };
        yield { type: 'tool_call', index: 1, id: 'read-ordinary', name: 'echo', argsDelta: '{}' };
        yield { type: 'finish', reason: 'tool_calls' };
      } else { yield { type: 'finish', reason: 'stop' }; }
    } };
    const out: TurnEvent[] = [];
    for await (const e of runTurn({ db, conversationId: conversation.id, userText: 'work', provider, tools: registry, signal: new AbortController().signal })) out.push(e);
    assert.ok(out.some(e => e.type === 'text' && e.delta === 'MIXED_BUSINESS'));
    const history = listMessages(db, conversation.id);
    assert.equal(history.find(m => m.toolCalls)?.displayChannel, 'chat');
    assert.equal(history.find(m => m.toolCallId === 'read-memory')?.displayChannel, 'maintenance');
    assert.equal(history.find(m => m.toolCallId === 'read-ordinary')?.displayChannel, 'chat');
  } finally { db.close(); }
});
