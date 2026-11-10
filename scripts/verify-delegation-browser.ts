/**
 * 真机浏览器验收：委派看板（用户 2026-11-10 的要求）。
 *
 * ★ 为什么必须真跑浏览器：本项目已经两次栽在"tsc 干净 + 单测全绿、界面却是坏的"上
 *   （归档页永远显示 0、项目只显示两个页签）。看板这种东西坏了不会报错，
 *   它只会**静静地空白**，而那和"还没派过活"长得一模一样。
 *
 * 判据（全都从真实 DOM 里读，不看源码）：
 * ① 主对话里有子代理时，右栏**出现**「子代理」区块，并且标题对得上；
 * ② 状态角标显示中文（已完成后 / 进行中），不是裸英文枚举；
 * ③ 展开后能看到它自己的目标与任务（这是"进度"的核心）；
 * ④ 共享任务板出现在**同一张**看板上；
 * ⑤ 没有子代理时显示的是引导语，不是空白。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import fastifyStatic from '@fastify/static';
import { loadConfig, ensureHome } from '../src/config.ts';
import { finishDelegation, startDelegation } from '../src/core/agent/delegation.ts';
import { updateExecutionBoard } from '../src/core/memory/execution.ts';
import { createProject } from '../src/core/project/service.ts';
import { openDatabase } from '../src/core/store/db.ts';
import { insertConversation, insertProvider } from '../src/core/store/repo.ts';
import { migrate } from '../src/core/store/schema.ts';
import { buildServer } from '../src/server/app.ts';

const home = mkdtempSync(join(tmpdir(), 'alkaid-deleg-browser-'));
const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
ensureHome(config);
const db = openDatabase(config.dbPath);
migrate(db);

const provider = insertProvider(db, { name: '本地假模型（不计费）', baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'offline' });
const project = createProject(db, config, { name: '委派看板验收' });
const parent = insertConversation(db, { providerId: provider.id, model: 'offline', permissionMode: 'full', projectId: project.id });

// ① 一个已完成的子代理 + 它自己的目标/任务
const done = startDelegation(db, {
  parentConversationId: parent.id,
  task: '把 fs 工具里的旧 API 全部改成新 API，并跑一遍测试',
  title: '改完 fs 工具旧 API',
  providerId: provider.id, model: 'offline', permissionMode: 'full',
  projectId: project.id, primaryWorkspaceId: null,
});
updateExecutionBoard(db, project.id, done.childConversationId, {
  baseRevision: 0,
  goal: { title: '迁移 fs 工具 API', status: 'completed', summary: '三个文件改完，测试通过' },
  tasks: [
    { id: 't1', content: '改 fs.ts', status: 'completed' },
    { id: 't2', content: '改 fs.test.ts', status: 'completed' },
  ],
  activity: '全部完成',
}, 'model');
finishDelegation(db, done.delegation.id, { status: 'completed', result: '三个文件改完，测试全绿。' });

// ② 一个还在跑的子代理
const running = startDelegation(db, {
  parentConversationId: parent.id,
  task: '调研 DSH 的 Team 机制并写成结论',
  title: '调研 Team 机制',
  providerId: provider.id, model: 'offline', permissionMode: 'full',
  projectId: project.id, primaryWorkspaceId: null,
});
updateExecutionBoard(db, project.id, running.childConversationId, {
  baseRevision: 0,
  goal: { title: '调研 Team 机制', status: 'active', summary: '正在读报告 §2.8' },
  tasks: [{ id: 'r1', content: '读 §2.8', status: 'in_progress' }],
  activity: '开始读',
}, 'model');

const app = buildServer({ config, db });
await app.register(fastifyStatic, { root: join(import.meta.dirname, '..', 'dist', 'web'), prefix: '/' });
const baseURL = await app.listen({ host: '127.0.0.1', port: 0 });

const report: Record<string, unknown> = { verifiedAt: new Date().toISOString(), baseURL, fixtureOnly: true };
console.log(JSON.stringify({ ready: true, baseURL, parentId: parent.id, doneId: done.delegation.id, runningId: running.delegation.id }));

// ── 给浏览器脚本用的信息（它会读这一行） ──
console.log(`BROWSER_URL=${baseURL}`);

const shutdown = async (): Promise<void> => {
  await app.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
if (!process.argv.includes('--serve')) {
  await shutdown();
}
await delay(600_000);
await shutdown();
