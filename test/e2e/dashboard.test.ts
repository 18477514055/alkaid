import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { insertCompaction } from '../../src/core/context/compact.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { appendMessage, insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { recordStepEvent } from '../../src/core/store/audit.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

/** 看板数据一次拿全：上下文规模、压缩档案、审计计数、所属项目/工作区 */
test('看板接口把上下文、压缩档案、审计、项目/工作区一次给全', async () => {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-dash-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });

  try {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '一' });
    appendMessage(db, { conversationId: conversation.id, role: 'assistant', content: '二' });
    insertCompaction(db, { conversationId: conversation.id, fromSeq: 1, toSeq: 2, summary: '前两条的摘要' });
    recordStepEvent(db, { conversationId: conversation.id, stepNo: 1, kind: 'tool_call', payload: { tool: 'read' } });
    recordStepEvent(db, { conversationId: conversation.id, stepNo: 2, kind: 'policy_denied', payload: { tool: 'write' } });

    const res = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}/dashboard` });
    assert.equal(res.statusCode, 200);

    const body = res.json() as {
      messageCount: number;
      contextTokens: number;
      compactions: Array<{ fromSeq: number; toSeq: number; summary: string }>;
      counts: Record<string, number>;
      events: Array<{ kind: string }>;
      workspace: unknown;
      project: unknown;
    };

    assert.equal(body.messageCount, 2);
    assert.ok(body.contextTokens > 0);
    assert.equal(body.compactions.length, 1);
    assert.equal(body.compactions[0]?.summary, '前两条的摘要');
    assert.equal(body.counts['tool_call'], 1);
    assert.equal(body.counts['policy_denied'], 1);
    assert.ok(body.events.some((event) => event.kind === 'policy_denied'));
    assert.equal(body.workspace, null);
    assert.equal(body.project, null);
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('不存在的会话看板返回 404', async () => {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-dash-404-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/conversations/nope/dashboard' });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
