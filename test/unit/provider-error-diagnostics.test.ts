import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import { classifyError } from '../../src/core/model/retry.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { listStepEvents } from '../../src/core/store/audit.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

/**
 * 上游失败必须**可诊断**，但**不许把上游正文落库/上屏**。
 *
 * 事故背景（2026-11-08）：为了不泄漏上游响应体，主循环把错误统一成一句
 * `provider_request_failed`，结果用户只看到"模型请求失败"，审计里也只剩一个码 ——
 * 无法判断是 401、429 还是断网。这些测试钉住新的折中：**状态码与类别进库，正文不进**。
 */

function world(): { dir: string; db: ReturnType<typeof openDatabase>; conversationId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-provider-err-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const provider = insertProvider(db, { name: 'p', baseUrl: 'http://127.0.0.1:1/v1' });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'm', permissionMode: 'full' });
  return { dir, db, conversationId: conversation.id };
}

function failingProvider(event: ChatEvent): Provider {
  return {
    id: 'fake',
    async *stream(_request: ChatRequest): AsyncGenerator<ChatEvent> {
      yield event;
    },
  };
}

test('HTTP 状态进审计、进提示；上游正文一个字都不落', async () => {
  const { dir, db, conversationId } = world();
  const secretBody = 'UPSTREAM_BODY_SHOULD_NEVER_APPEAR';

  const events: TurnEvent[] = [];
  for await (const event of runTurn({
    db,
    conversationId,
    userText: 'hi',
    // ★ 这里故意把"正文"塞进 message：它绝不能被持久化或显示
    provider: failingProvider({ type: 'error', message: secretBody, retryable: false, status: 429, kind: 'http' }),
    signal: new AbortController().signal,
    workspacePath: dir,
  })) {
    events.push(event);
  }

  const shown = events.filter((e) => e.type === 'error').map((e) => (e.type === 'error' ? e.message : '')).join('\n');
  assert.match(shown, /429/, `界面提示必须带上状态码，实际：${shown}`);
  assert.doesNotMatch(shown, new RegExp(secretBody), '上游正文不许上屏');

  const audit = JSON.stringify(listStepEvents(db, conversationId, 50));
  assert.match(audit, /provider_request_failed/);
  assert.match(audit, /429/, '审计里必须有状态码，否则查不出原因');
  assert.doesNotMatch(audit, new RegExp(secretBody), '上游正文不许落库');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('非 HTTP 失败落到可读类别（网络/超时/断流）', async () => {
  for (const [kind, pattern] of [
    ['network', /网络错误/],
    ['timeout', /超时/],
    ['stream', /流在结束前断了/],
  ] as const) {
    const { dir, db, conversationId } = world();
    const shown: string[] = [];
    for await (const event of runTurn({
      db,
      conversationId,
      userText: 'hi',
      provider: failingProvider({ type: 'error', message: 'x', retryable: false, kind }),
      signal: new AbortController().signal,
      workspacePath: dir,
    })) {
      if (event.type === 'error') shown.push(event.message);
    }
    assert.match(shown.join(''), pattern, `kind=${kind} 必须翻译成可读原因，实际：${shown.join('')}`);
    const audit = JSON.stringify(listStepEvents(db, conversationId, 50));
    assert.match(audit, new RegExp(`"failureKind":"${kind}"`), `审计里要带 failureKind=${kind}`);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyError 对 HTTP 状态给出 kind/status（正文仍在 message 里，供内部重试判断）', async () => {
  const { HttpError } = await import('../../src/core/model/retry.ts');
  const classified = classifyError(new HttpError(400, 'bad request body'));
  assert.equal(classified.kind, 'http');
  assert.equal(classified.status, 400);
  assert.equal(classified.retryable, false);

  const limited = classifyError(new HttpError(429, 'slow down'));
  assert.equal(limited.retryable, true, '429 必须可重试');

  const other = classifyError(new Error('boom'));
  assert.equal(other.kind, 'other');
  assert.equal(other.status, undefined);
});
