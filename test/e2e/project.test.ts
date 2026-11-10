import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

/**
 * §11 测试二 / 三 / 四 —— **项目与对话解耦、跨工作区、项目共享文件**。
 *
 * 注意测试四的**能力边界**：这一轮还没有文件工具（M4 才有），
 * 所以这里验的是"两个对话解析到**同一个共享目录**"这条数据链路；
 * 真正由 agent 通过工具写、另一个读，在 M4 的用例里补。
 * 我不想把"目录一致"说成"工具能用" —— 那是两件事。
 */

type Harness = {
  app: ReturnType<typeof buildServer>;
  home: string;
  close: () => Promise<void>;
};

async function withHarness(run: (ctx: Harness) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-proj-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);

  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ config, db });

  try {
    await run({
      app,
      home,
      close: async () => {
        await app.close();
        db.close();
        rmSync(home, { recursive: true, force: true });
      },
    });
  } finally {
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    rmSync(home, { recursive: true, force: true });
  }
}

async function makeProvider(app: Harness['app']): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/providers',
    payload: { name: 'p', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-project-test-123' },
  });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function makeWorkspace(app: Harness['app'], name: string): Promise<{ id: string; rootPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), `alkaid-ws-${name}-`));
  const res = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name, path: dir } });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { id: string; rootPath: string };
  return { id: body.id, rootPath: body.rootPath };
}

test('§11 测试二：一个项目两个对话，各自历史独立且可分别恢复', async () => {
  await withHarness(async ({ app, close }) => {
    try {
      const providerId = await makeProvider(app);

      const projectRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: '项目 A' },
      });
      assert.equal(projectRes.statusCode, 201);
      const project = projectRes.json() as { id: string; sharedDir: string };
      assert.ok(existsSync(project.sharedDir), '项目共享目录应由程序创建');

      const first = await app
        .inject({
          method: 'POST',
          url: '/api/conversations',
          payload: { providerId, model: 'm', projectId: project.id, title: '对话一' },
        })
        .then((res) => res.json() as { id: string; projectId: string });
      const second = await app
        .inject({
          method: 'POST',
          url: '/api/conversations',
          payload: { providerId, model: 'm', projectId: project.id, title: '对话二' },
        })
        .then((res) => res.json() as { id: string; projectId: string });

      assert.equal(first.projectId, project.id);
      assert.equal(second.projectId, project.id);

      // 项目下确实有两个对话
      const listed = await app
        .inject({ method: 'GET', url: `/api/projects/${project.id}/conversations` })
        .then((res) => res.json() as Array<{ id: string }>);
      assert.equal(listed.length, 2);

      // 删掉一个对话：项目还在、另一个对话还在
      const deleted = await app.inject({ method: 'DELETE', url: `/api/conversations/${first.id}` });
      assert.equal(deleted.statusCode, 200);

      const remaining = await app
        .inject({ method: 'GET', url: `/api/projects/${project.id}/conversations` })
        .then((res) => res.json() as Array<{ id: string }>);
      assert.deepEqual(
        remaining.map((item) => item.id),
        [second.id],
      );

      const projectStillThere = await app.inject({ method: 'GET', url: `/api/projects/${project.id}` });
      assert.equal(projectStillThere.statusCode, 200);
      assert.ok(existsSync(project.sharedDir), '删对话不该删掉项目共享目录');
    } finally {
      await close();
    }
  });
});

test('§11 测试三：两个对话各自关联不同工作区，但同属一个项目', async () => {
  await withHarness(async ({ app, close }) => {
    try {
      const providerId = await makeProvider(app);
      const project = await app
        .inject({ method: 'POST', url: '/api/projects', payload: { name: '项目 B' } })
        .then((res) => res.json() as { id: string });

      const workspaceA = await makeWorkspace(app, 'ws-a');
      const workspaceB = await makeWorkspace(app, 'ws-b');
      assert.notEqual(workspaceA.rootPath, workspaceB.rootPath);

      const conversationA = await app
        .inject({
          method: 'POST',
          url: '/api/conversations',
          payload: { providerId, model: 'm', projectId: project.id, workspaceId: workspaceA.id },
        })
        .then((res) => res.json() as { id: string; projectId: string; primaryWorkspaceId: string });

      const conversationB = await app
        .inject({
          method: 'POST',
          url: '/api/conversations',
          payload: { providerId, model: 'm', projectId: project.id, workspaceId: workspaceB.id },
        })
        .then((res) => res.json() as { id: string; projectId: string; primaryWorkspaceId: string });

      assert.equal(conversationA.projectId, project.id);
      assert.equal(conversationB.projectId, project.id);
      assert.notEqual(conversationA.primaryWorkspaceId, conversationB.primaryWorkspaceId);

      // ★ 任务书 §3.4 第 4 条：改工作区**不改变**项目身份
      await app.inject({
        method: 'PATCH',
        url: `/api/conversations/${conversationA.id}`,
        payload: { workspaceId: workspaceB.id },
      });
      const afterSwitch = await app
        .inject({ method: 'GET', url: `/api/conversations/${conversationA.id}` })
        .then((res) => res.json() as { projectId: string; primaryWorkspaceId: string });
      assert.equal(afterSwitch.projectId, project.id, '换工作区后项目身份变了');
      assert.equal(afterSwitch.primaryWorkspaceId, workspaceB.id);
    } finally {
      await close();
    }
  });
});

test('§11 测试四（数据链路）：同项目两对话解析到同一个共享目录', async () => {
  await withHarness(async ({ app, close }) => {
    try {
      const providerId = await makeProvider(app);
      const project = await app
        .inject({ method: 'POST', url: '/api/projects', payload: { name: '项目 C' } })
        .then((res) => res.json() as { id: string; sharedDir: string });

      const workspaceA = await makeWorkspace(app, 'ws-c1');
      const workspaceB = await makeWorkspace(app, 'ws-c2');

      const a = await app
        .inject({
          method: 'POST',
          url: '/api/conversations',
          payload: { providerId, model: 'm', projectId: project.id, workspaceId: workspaceA.id },
        })
        .then((res) => res.json() as { id: string });
      const b = await app
        .inject({
          method: 'POST',
          url: '/api/conversations',
          payload: { providerId, model: 'm', projectId: project.id, workspaceId: workspaceB.id },
        })
        .then((res) => res.json() as { id: string });

      const projectOfA = await app
        .inject({ method: 'GET', url: `/api/conversations/${a.id}/project` })
        .then((res) => res.json() as { project: { sharedDir: string } | null });
      const projectOfB = await app
        .inject({ method: 'GET', url: `/api/conversations/${b.id}/project` })
        .then((res) => res.json() as { project: { sharedDir: string } | null });

      assert.equal(projectOfA.project?.sharedDir, project.sharedDir);
      assert.equal(projectOfB.project?.sharedDir, project.sharedDir);

      // 模拟"一个对话写、另一个读"的落盘效果（工具级实现在 M4）
      const sharedDir = project.sharedDir;
      writeFileSync(join(sharedDir, 'shared-note.txt'), '来自对话一的共享内容', 'utf8');
      const readBack = readFileSync(join(projectOfB.project?.sharedDir ?? '', 'shared-note.txt'), 'utf8');
      assert.equal(readBack, '来自对话一的共享内容');
    } finally {
      await close();
    }
  });
});

test('对话可以完全独立存在（既无项目也无工作区）', async () => {
  await withHarness(async ({ app, close }) => {
    try {
      const providerId = await makeProvider(app);
      const res = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { providerId, model: 'm' },
      });
      assert.equal(res.statusCode, 201);
      const conversation = res.json() as { projectId: string | null; primaryWorkspaceId: string | null };
      assert.equal(conversation.projectId, null);
      assert.equal(conversation.primaryWorkspaceId, null);
    } finally {
      await close();
    }
  });
});
