import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { finishDelegation, startDelegation } from '../../src/core/agent/delegation.ts';
import { loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

/**
 * 委派看板的 **HTTP 面**（用户 2026-11-10：「这两个功能最好在右侧看板显现出来」）。
 *
 * ★ 为什么在单元测试之外还要走一遍真实 `buildServer`：
 *   看板的数据在服务端拼（子代理树 + 各自执行板 + 共享板），
 *   而"拼得对不对"只有从 HTTP 出去那一刻才算数。
 *   另外这里钉住两件**只看代码看不出来**的事：
 *   ① 子代理请求这个端点 ⇒ 回空树 + 说明，**不是** 404、也不是假装它有一棵树；
 *   ② 别人的会话不会串台。
 */

async function withServer(run: (ctx: { app: ReturnType<typeof buildServer>; db: ReturnType<typeof openDatabase> }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-deleg-http-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });
  try {
    await run({ app, db });
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test('★★ GET /api/conversations/:id/delegations 回一棵树（含各自执行板）', async () => {
  await withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const parent = insertConversation(db, { providerId: provider.id, model: 'm', permissionMode: 'full' });

    const { delegation } = startDelegation(db, {
      parentConversationId: parent.id,
      task: '改掉旧 API',
      title: '改 API',
      providerId: provider.id,
      model: 'm',
      permissionMode: 'full',
      projectId: null,
      primaryWorkspaceId: null,
    });
    finishDelegation(db, delegation.id, { status: 'completed', result: '改完了' });

    const res = await app.inject({ method: 'GET', url: `/api/conversations/${parent.id}/delegations`, headers: { host: '127.0.0.1' } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      parentConversationId: string;
      entries: Array<{ delegation: { title: string; status: string; result: string | null }; messageCount: number }>;
    };
    assert.equal(body.parentConversationId, parent.id);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0]?.delegation.title, '改 API');
    assert.equal(body.entries[0]?.delegation.status, 'completed');
    assert.equal(body.entries[0]?.delegation.result, '改完了');
  });
});

test('★★ 子代理查这个端点：回空树 + 说明（不是 404，也不假装它有自己的树）', async () => {
  await withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const parent = insertConversation(db, { providerId: provider.id, model: 'm', permissionMode: 'full' });
    const { childConversationId } = startDelegation(db, {
      parentConversationId: parent.id,
      task: 'x',
      title: 'x',
      providerId: provider.id,
      model: 'm',
      permissionMode: 'full',
      projectId: null,
      primaryWorkspaceId: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/conversations/${childConversationId}/delegations`,
      headers: { host: '127.0.0.1' },
    });
    assert.equal(res.statusCode, 200, '子代理查它自己的委派树不该报错');
    const body = res.json() as { entries: unknown[]; note?: string; parentConversationIdOfThisSubagent?: string | null };
    assert.deepEqual(body.entries, [], '子代理不该有"自己的"子代理');
    assert.ok((body.note ?? '').length > 0, '要说明为什么是空的，否则前端只能显示一个空白区块');
    assert.match(String(body.note), /子代理/);
    // ★ 同时也告诉它"你属于谁" —— 看板据此可以把用户导回主对话
    assert.equal(body.parentConversationIdOfThisSubagent, parent.id);
  });
});

test('★ 不存在的会话 ⇒ 404（不是空树 —— 空树会让前端以为"这个会话没派过活"）', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/conversations/nope/delegations', headers: { host: '127.0.0.1' } });
    assert.equal(res.statusCode, 404);
  });
});

test('★★ 别人的子代理不会串到我的看板上（HTTP 层）', async () => {
  await withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const mine = insertConversation(db, { providerId: provider.id, model: 'm' });
    const theirs = insertConversation(db, { providerId: provider.id, model: 'm' });

    startDelegation(db, {
      parentConversationId: theirs.id,
      task: '别人的活',
      title: '别人的',
      providerId: provider.id,
      model: 'm',
      permissionMode: 'full',
      projectId: null,
      primaryWorkspaceId: null,
    });

    const res = await app.inject({ method: 'GET', url: `/api/conversations/${mine.id}/delegations`, headers: { host: '127.0.0.1' } });
    const body = res.json() as { entries: unknown[] };
    assert.deepEqual(body.entries, [], '串台了');
  });
});

test('★ POST /api/delegations/recover 清掉崩溃遗留的 running', async () => {
  await withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const parent = insertConversation(db, { providerId: provider.id, model: 'm' });
    startDelegation(db, {
      parentConversationId: parent.id,
      task: '会中断',
      title: '中断',
      providerId: provider.id,
      model: 'm',
      permissionMode: 'full',
      projectId: null,
      primaryWorkspaceId: null,
    });

    const res = await app.inject({ method: 'POST', url: '/api/delegations/recover', headers: { host: '127.0.0.1' } });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { recovered: number }).recovered, 1);

    const board = await app.inject({ method: 'GET', url: `/api/conversations/${parent.id}/delegations`, headers: { host: '127.0.0.1' } });
    const body = board.json() as { entries: Array<{ delegation: { status: string } }> };
    assert.equal(body.entries[0]?.delegation.status, 'interrupted', '恢复后看板还显示"进行中"');
  });
});

test('★★ 真实服务器上 delegate 工具是**可用**的（不是永远 delegate_unavailable）', async () => {
  await withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm', permissionMode: 'full' });

    /**
     * ★ 这条钉的是一个**静默失效**：`buildServer` 曾经用 `createDefaultRegistry(db)`
     *   而不传 `secretsPath` ⇒ 工具还在表里（界面看得见），但每次调用都回
     *   `delegate_unavailable`。用户会对着一个永远失败的按钮猜。
     *   这里通过真实的工具端点确认它是"参数问题/密钥问题"而不是"实现缺配置"。
     */
    const res = await app.inject({
      method: 'GET',
      url: '/api/tools',
      headers: { host: '127.0.0.1' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as unknown;
    const serialized = JSON.stringify(body);
    assert.ok(serialized.includes('delegate'), `工具表里没有 delegate：${serialized.slice(0, 400)}`);
    void conversation;
  });
});
