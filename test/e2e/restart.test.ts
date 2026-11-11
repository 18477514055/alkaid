import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { listStepEvents } from '../../src/core/store/audit.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

/**
 * §11 测试七：关掉再打开，项目 / 对话 / 消息 / 工作区关联都要能恢复。
 *
 * ★ 这里刻意**真的 close 掉进程内的 db 与 app，再用同一个数据目录重新打开**，
 *   而不是"同一个连接里再查一遍" —— 后者证明不了落盘。
 */

type Running = { app: ReturnType<typeof buildServer>; db: DatabaseSync };

async function startFakeModel(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((_req, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"记得我"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('§11 测试七：重启后项目/对话/消息/工作区关联全部恢复', async () => {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-restart-'));
  const workspaceDir = mkdtempSync(join(tmpdir(), 'alkaid-restart-ws-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);

  const model = await startFakeModel();

  const open = (): Running => {
    const db = openDatabase(config.dbPath);
    migrate(db);
    return { app: buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db }), db };
  };

  let running = open();

  try {
    // ── 第一次运行：把数据造出来 ──
    const providerRes = await running.app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { name: '假模型', baseUrl: model.baseUrl, apiKey: 'sk-restart-123456' },
    });
    assert.equal(providerRes.statusCode, 201);
    const provider = providerRes.json() as { id: string };

    const projectRes = await running.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '重启前的项目' },
    });
    const project = projectRes.json() as { id: string; sharedDir: string };

    const workspaceRes = await running.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '重启前的工作区', path: workspaceDir },
    });
    assert.equal(workspaceRes.statusCode, 201);
    const workspace = workspaceRes.json() as { id: string; rootPath: string };

    const conversationRes = await running.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {
        providerId: provider.id,
        model: 'test-model',
        title: '重启前的对话',
        projectId: project.id,
        workspaceId: workspace.id,
      },
    });
    assert.equal(conversationRes.statusCode, 201);
    const conversation = conversationRes.json() as { id: string };

    const sent = await running.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { content: '记住这条消息' },
    });
    assert.equal(sent.statusCode, 200);
    assert.match(sent.body, /记得我/);

    // v11 may persist a maintenance-only closure receipt/usage after the business reply.
    // Restart must preserve ALL protocol rows, not discard these to retain an old row count.
    const messagesBefore = (await running.app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}/messages` })).json();
    const auditsBefore = listStepEvents(running.db, conversation.id).length;
    assert.ok(auditsBefore > 0, '审计一条都没写');

    // ── 关掉：模拟进程退出 ──
    await running.app.close();
    running.db.close();

    // ── 第二次运行：同一个数据目录重新打开 ──
    running = open();

    const projects = (await running.app.inject({ method: 'GET', url: '/api/projects' })).json() as Array<{
      id: string;
      name: string;
      sharedDir: string;
    }>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.id, project.id);
    assert.equal(projects[0]?.name, '重启前的项目');
    assert.equal(projects[0]?.sharedDir, project.sharedDir);

    const workspaces = (await running.app.inject({ method: 'GET', url: '/api/workspaces' })).json() as Array<{
      id: string;
      rootPath: string;
    }>;
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.id, workspace.id);

    const conversations = (await running.app.inject({ method: 'GET', url: '/api/conversations' })).json() as Array<{
      id: string;
      title: string;
      projectId: string | null;
      primaryWorkspaceId: string | null;
    }>;
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.id, conversation.id);
    assert.equal(conversations[0]?.title, '重启前的对话');
    assert.equal(conversations[0]?.projectId, project.id, '项目关联丢了');
    assert.equal(conversations[0]?.primaryWorkspaceId, workspace.id, '工作区关联丢了');

    const messages = (await running.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}/messages`,
    })).json() as Array<{ role: string; content: string | null; seq: number; displayChannel: string }>;
    assert.deepEqual(messages, messagesBefore, '全部原文、通道和维护协议行必须逐字恢复');
    assert.deepEqual(
      messages.filter(message => message.displayChannel !== 'maintenance').map((message) => [message.seq, message.role, message.content]),
      [
        [1, 'user', '记住这条消息'],
        [2, 'assistant', '记得我'],
      ],
    );

    // 密钥也要还在（否则重启后模型就用不了了）
    const providers = (await running.app.inject({ method: 'GET', url: '/api/providers' })).json() as Array<{
      hasKey: boolean;
    }>;
    assert.equal(providers[0]?.hasKey, true, '重启后密钥丢了');

    // 审计也在
    assert.ok(listStepEvents(running.db, conversation.id).length >= auditsBefore, '审计没落盘');
  } finally {
    try {
      await running.app.close();
    } catch {
      /* 已关闭 */
    }
    try {
      running.db.close();
    } catch {
      /* 已关闭 */
    }
    await model.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
