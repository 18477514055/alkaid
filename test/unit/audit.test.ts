import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { runTurn } from '../../src/core/agent/loop.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { rootsFor } from '../../src/core/policy/roots.ts';
import { listStepEvents, recordStepEvent } from '../../src/core/store/audit.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createFsTools } from '../../src/core/tools/fs.ts';
import { ToolRegistry } from '../../src/core/tools/types.ts';
import type { ChatEvent } from '../../src/shared/types.ts';

function withDb(run: (db: DatabaseSync) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-audit-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return (async () => {
    try {
      await run(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

test('审计可以写入并按顺序读出，payload 往返成对象', () => {
  withDb((db) => {
    recordStepEvent(db, { conversationId: 'c1', stepNo: 1, kind: 'tool_call', payload: { tool: 'read' } });
    recordStepEvent(db, { conversationId: 'c1', stepNo: 1, kind: 'step_end', payload: { finishReason: 'stop' } });

    const events = listStepEvents(db, 'c1');
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, 'tool_call');
    assert.deepEqual(events[0]?.payload, { tool: 'read' });
    assert.equal(events[1]?.kind, 'step_end');
  });
});

test('主循环会把工具调用、权限拒绝、步骤结束都记进审计', async () => {
  await withDb(async (db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm', permissionMode: 'readonly' });

    const registry = new ToolRegistry();
    for (const tool of createFsTools()) registry.register(tool);

    const calls: ChatEvent[][] = [
      [
        { type: 'tool_call', index: 0, id: 'call_1', name: 'write', argsDelta: '{"path":"a.txt","content":"x"}' },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [{ type: 'text', delta: '写不了。' }, { type: 'finish', reason: 'stop' }],
    ];
    const fake: Provider = {
      id: 'fake',
      async *stream(): AsyncGenerator<ChatEvent> {
        for (const event of calls.shift() ?? [{ type: 'finish', reason: 'stop' } as ChatEvent]) yield event;
      },
    };

    const dir = mkdtempSync(join(tmpdir(), 'alkaid-audit-fs-'));
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of runTurn({
        db,
        conversationId: conversation.id,
        userText: '写文件',
        provider: fake,
        signal: new AbortController().signal,
        tools: registry,
        tempDir: dir,
        workspacePath: null,
        projectSharedDir: null,
      })) {
        void _event;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const events = listStepEvents(db, conversation.id);
    const kinds = events.map((event) => event.kind);

    assert.ok(kinds.includes('policy_denied'), `没有记录权限拒绝：${kinds.join(',')}`);
    assert.ok(kinds.includes('step_end'), '没有记录步骤结束');

    const denial = events.find((event) => event.kind === 'policy_denied');
    assert.equal(denial?.payload?.['tool'], 'write');
    // ★ 审计里不能出现参数原文（可能含密钥/源码）
    assert.equal(JSON.stringify(denial?.payload ?? {}).includes('a.txt'), false);
  });
});
