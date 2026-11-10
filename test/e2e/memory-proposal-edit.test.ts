import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { MemoryMaintainer } from '../../src/core/memory/maintainer.ts';
import { applyProposalManually, getMemoryView, submitProposal } from '../../src/core/memory/store.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProject, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';
import type { MemoryProposal } from '../../src/shared/memory.ts';

/**
 * ② 的 HTTP 面：`PATCH /api/projects/:projectId/memory/proposals/:proposalId`
 *
 * 只有这一条路由的状态码契约是前端依赖的，所以单独在 e2e 里钉住：
 * - 本人 pending ⇒ 200 + 最新 DTO（仍是 pending）
 * - 别人 ⇒ 403，非 pending ⇒ 409，不存在 ⇒ 404，改文本以外的字段 ⇒ 400
 */

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-proposal-edit-'));
  const config = loadConfig({ ALKAID_HOME: home });
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const provider = insertProvider(db, { name: 'fake', baseUrl: 'https://never-contact.invalid/v1' });
  const project = insertProject(db, { id: randomUUID(), name: 'edit project', sharedDir: join(home, 'unused') });
  const other = insertProject(db, { id: randomUUID(), name: 'other project', sharedDir: join(home, 'other') });
  const conv = insertConversation(db, { providerId: provider.id, model: 'fake', projectId: project.id });
  const sibling = insertConversation(db, { providerId: provider.id, model: 'fake', projectId: project.id });
  const foreign = insertConversation(db, { providerId: provider.id, model: 'fake', projectId: other.id });
  const memory = new MemoryMaintainer({ db, config });
  const app = buildServer({ db, config, memory });
  t.after(async () => {
    await app.close();
    await memory.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const url = (proposalId: string, projectId = project.id) =>
    `/api/projects/${projectId}/memory/proposals/${proposalId}`;
  const propose = (conversationId = conv.id, patch: Partial<Parameters<typeof submitProposal>[0]> = {}) => submitProposal(db, {
    conversationId, recordId: 'r', kind: 'note', title: 'Note', operation: 'upsert',
    content: 'Supported fact', baseRevision: 0, reason: 'user proposal', idempotencyKey: randomUUID(), ...patch,
  });
  return { db, app, project, other, conv, sibling, foreign, url, propose };
}

test('① HTTP：PATCH config 能开关 autoApproveOnTurnEnd（默认 false），非布尔 400', async (t) => {
  const f = fixture(t);
  const url = `/api/projects/${f.project.id}/memory/config`;
  // 读：新建项目默认关闭（DTO 里字段存在，不是靠"缺字段"猜）。
  const before = await f.app.inject({ method: 'GET', url: `/api/projects/${f.project.id}/memory` });
  assert.equal(before.statusCode, 200);
  assert.equal((before.json() as { config: { autoApproveOnTurnEnd: boolean } }).config.autoApproveOnTurnEnd, false);
  const enabled = await f.app.inject({ method: 'PATCH', url, payload: { autoApproveOnTurnEnd: true } });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal((enabled.json() as { autoApproveOnTurnEnd: boolean }).autoApproveOnTurnEnd, true);
  for (const payload of [{ autoApproveOnTurnEnd: 'yes' }, { autoApproveOnTurnEnd: 1 }, { autoApproveOnTurnEnd: null }]) {
    const bad = await f.app.inject({ method: 'PATCH', url, payload });
    assert.equal(bad.statusCode, 400, JSON.stringify(payload));
  }
});

test('② HTTP：来源对话可改自己的 pending 文本，返回最新 DTO 且仍是 pending', async (t) => {
  const f = fixture(t);
  const proposal = f.propose();
  const response = await f.app.inject({
    method: 'PATCH', url: f.url(proposal.id),
    payload: { conversationId: f.conv.id, title: 'Edited title', content: 'Edited content' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const updated = response.json() as MemoryProposal;
  assert.equal(updated.id, proposal.id);
  assert.equal(updated.title, 'Edited title');
  assert.equal(updated.content, 'Edited content');
  assert.equal(updated.status, 'pending');
  assert.equal(updated.baseRevision, proposal.baseRevision);
  // 这条路径不应用任何东西。
  assert.equal(getMemoryView(f.db, f.project.id).records.length, 0);
  // 只改 title（不带 content）也允许，且不会把正文清空。
  const onlyTitle = await f.app.inject({
    method: 'PATCH', url: f.url(proposal.id), payload: { conversationId: f.conv.id, title: 'Title only' },
  });
  assert.equal(onlyTitle.statusCode, 200, onlyTitle.body);
  assert.equal((onlyTitle.json() as MemoryProposal).content, 'Edited content');
});

test('② HTTP：别人的提案 403，非 pending 409，不存在 404，改非文本字段 400', async (t) => {
  const f = fixture(t);
  const proposal = f.propose();
  const hijack = await f.app.inject({
    method: 'PATCH', url: f.url(proposal.id), payload: { conversationId: f.sibling.id, content: 'hijack' },
  });
  assert.equal(hijack.statusCode, 403, hijack.body);
  const foreignConv = await f.app.inject({
    method: 'PATCH', url: f.url(proposal.id), payload: { conversationId: f.foreign.id, content: 'hijack' },
  });
  assert.equal(foreignConv.statusCode, 403, foreignConv.body);
  // 身份字段不许被改。
  for (const payload of [
    { conversationId: f.conv.id, kind: 'decision' },
    { conversationId: f.conv.id, recordId: 'other' },
    { conversationId: f.conv.id, baseRevision: 9 },
    { conversationId: f.conv.id, status: 'applied' },
  ]) {
    const response = await f.app.inject({ method: 'PATCH', url: f.url(proposal.id), payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal((await f.app.inject({
    method: 'PATCH', url: f.url('missing-proposal'), payload: { conversationId: f.conv.id, content: 'x' },
  })).statusCode, 404);
  assert.equal((await f.app.inject({
    method: 'PATCH', url: f.url(proposal.id, 'missing-project'), payload: { conversationId: f.conv.id, content: 'x' },
  })).statusCode, 404);
  // 别的项目里的提案：本项目查不到 ⇒ 404。
  const elsewhere = f.propose(f.foreign.id);
  assert.equal((await f.app.inject({
    method: 'PATCH', url: f.url(elsewhere.id), payload: { conversationId: f.foreign.id, content: 'x' },
  })).statusCode, 404);
  // 非 pending ⇒ 409（并确认文本没被改）。
  applyProposalManually(f.db, f.project.id, proposal.id);
  const late = await f.app.inject({
    method: 'PATCH', url: f.url(proposal.id), payload: { conversationId: f.conv.id, content: 'too late' },
  });
  assert.equal(late.statusCode, 409, late.body);
  assert.equal(getMemoryView(f.db, f.project.id).proposals.find(p => p.id === proposal.id)?.content, proposal.content);
  // 非对象体 ⇒ 400（不是 500）。
  const scalar = await f.app.inject({
    method: 'PATCH', url: f.url(proposal.id), payload: JSON.stringify('nope'),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(scalar.statusCode, 400, scalar.body);
});
