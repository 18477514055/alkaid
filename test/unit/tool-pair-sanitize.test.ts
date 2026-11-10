import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assembleContext, sanitizeToolPairs } from '../../src/core/context/compact.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { appendMessage, insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { MessageRow } from '../../src/core/store/repo.ts';

/**
 * 半截工具调用必须被补齐或摘掉。
 *
 * 真事故（2026-11-08）：一轮在工具执行中途失败后，库里留下
 * 「assistant 带 tool_calls，但没有对应 tool 回复」。此后**每一次**请求都被上游拒收：
 * `missing role field at line 1 column 58`（文案极具误导性）。
 * 实测：该形态必然 400；补一条 tool 回复即 200。会话除非修库否则永久损坏。
 */

function mk(over: Partial<MessageRow> & { seq: number; role: MessageRow['role'] }): MessageRow {
  return {
    id: `m${over.seq}`,
    conversationId: 'c1',
    seq: over.seq,
    role: over.role,
    content: over.content ?? null,
    reasoning: null,
    toolCalls: over.toolCalls ?? null,
    toolCallId: over.toolCallId ?? null,
    usage: null,
    finishReason: over.finishReason ?? null,
    createdAt: '2026-11-08T00:00:00.000Z',
  };
}

test('最后一条 assistant 带 tool_calls 却没有 tool 回复 → 补占位（否则上游必 400）', () => {
  const messages = [
    mk({ seq: 1, role: 'user', content: 'hi' }),
    mk({ seq: 2, role: 'assistant', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] }),
  ];

  const out = sanitizeToolPairs(messages);
  assert.equal(out.length, 3, '必须补出一条 tool 消息');
  const filler = out[2]!;
  assert.equal(filler.role, 'tool');
  assert.equal(filler.toolCallId, 'c1');
  const body = JSON.parse(filler.content!);
  assert.equal(body.ok, false, '占位必须说明"没结果"，不能伪装成功');
  assert.equal(body.code, 'tool_result_missing');
});

test('多个 call 只回了一个 → 缺的补占位，已有的原样保留', () => {
  const messages = [
    mk({ seq: 1, role: 'user', content: 'hi' }),
    mk({ seq: 2, role: 'assistant', toolCalls: [
      { id: 'c1', name: 'read', arguments: '{}' },
      { id: 'c2', name: 'grep', arguments: '{}' },
    ] }),
    mk({ seq: 3, role: 'tool', content: '{"ok":true}', toolCallId: 'c1' }),
  ];

  const out = sanitizeToolPairs(messages);
  const tools = out.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 2, '两个 call 都要有回复');
  assert.equal(tools.find((m) => m.toolCallId === 'c1')?.content, '{"ok":true}', '真实结果不能被覆盖');
  assert.equal(JSON.parse(tools.find((m) => m.toolCallId === 'c2')!.content!).code, 'tool_result_missing');
});

test('孤立的 tool 消息被摘掉（它配不上任何 call，上游同样会拒）', () => {
  const messages = [
    mk({ seq: 1, role: 'user', content: 'hi' }),
    mk({ seq: 2, role: 'tool', content: '{"ok":true}', toolCallId: 'ghost' }),
    mk({ seq: 3, role: 'assistant', content: 'ok' }),
  ];

  const out = sanitizeToolPairs(messages);
  assert.equal(out.filter((m) => m.role === 'tool').length, 0, '孤立 tool 必须被摘掉');
  assert.equal(out.length, 2);
});

test('配对完整的历史原样通过（不许改动正常数据）', () => {
  const messages = [
    mk({ seq: 1, role: 'user', content: 'hi' }),
    mk({ seq: 2, role: 'assistant', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] }),
    mk({ seq: 3, role: 'tool', content: '{"ok":true}', toolCallId: 'c1' }),
    mk({ seq: 4, role: 'assistant', content: 'done' }),
  ];

  const out = sanitizeToolPairs(messages);
  assert.deepEqual(out.map((m) => m.seq), [1, 2, 3, 4]);
  assert.equal(out[2]!.content, '{"ok":true}');
});

test('真实库路径：assembleContext 保留原文，但发出去的历史一定可发送（每个 call 都有回复）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-toolpair-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);

  try {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    appendMessage(db, { conversationId: conversation.id, role: 'user', content: 'go' });
    // ★ 复刻事故现场：assistant 带 call，但工具中途失败、tool 回复从未写入
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      toolCalls: [{ id: 'dangling', name: 'pwsh', arguments: '{}' }],
      finishReason: 'error',
    });

    // ① assembleContext 只负责"取原文"：证据胶囊/recall/审计依赖它保持逐字
    const raw = assembleContext(db, conversation.id).messages;
    assert.equal(raw.filter((m) => m.role === 'tool').length, 0, 'assembled 不该凭空造消息');

    // ② 发送前必须修补成合法形状
    const outgoing = sanitizeToolPairs(raw);
    const calls = outgoing.flatMap((m) => (m.role === 'assistant' ? m.toolCalls ?? [] : []));
    const replies = new Set(outgoing.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
    for (const call of calls) {
      assert.ok(replies.has(call.id), `call ${call.id} 没有对应 tool 回复 —— 这样的历史发出去必然 400`);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
