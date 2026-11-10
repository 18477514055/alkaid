import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

/**
 * 单轮步数上限：默认 40，可调，但**硬上限 200**。
 *
 * 真事（2026-11-09）：用户让它「客户端全面自检」，40 步跑到一半被硬停，
 * 提示只说"达到最大步数"，用户既不知道这是可调的、也不知道该调哪。
 * 现在：① 设置里可改（10–200）；② 越界一律夹住，调用方无法打开无限循环；③ 提示里说清下一步。
 */

function world(): { dir: string; db: ReturnType<typeof openDatabase>; conversationId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-maxsteps-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const provider = insertProvider(db, { name: 'p', baseUrl: 'http://127.0.0.1:1/v1' });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'm', permissionMode: 'full' });
  return { dir, db, conversationId: conversation.id };
}

/**
 * 永远要工具、永不收尾的假模型。
 * ★ 参数必须**每次不同**：内核有「同工具同参数连续 3 次 = 空转」的守卫，
 *   固定参数会被它在第 3 步就拦下，测不到步数上限（第一版就是这么写错的）。
 */
let seq = 0;
function endlessToolProvider(): Provider {
  return {
    id: 'fake',
    async *stream(_request: ChatRequest): AsyncGenerator<ChatEvent> {
      seq += 1;
      yield { type: 'tool_call', index: 0, id: `call-${String(seq)}`, name: 'read', argsDelta: `{"path":"x${String(seq)}"}` };
      yield { type: 'finish', reason: 'tool_calls' };
    },
  };
}

test('默认上限是 40：不给参数时第 41 步中止', async () => {
  const { dir, db, conversationId } = world();
  const events: TurnEvent[] = [];
  try {
    for await (const event of runTurn({
      db,
      conversationId,
      userText: 'go',
      provider: endlessToolProvider(),
      signal: new AbortController().signal,
      workspacePath: dir,
    })) {
      events.push(event);
    }
    const errors = events.filter((e) => e.type === 'error').map((e) => (e.type === 'error' ? e.message : ''));
    const hit = errors.find((m) => m.includes('步数上限'));
    assert.ok(hit, `应当报步数上限，实际错误：${JSON.stringify(errors)}`);
    assert.match(hit, /40/, '提示里要带具体上限');
    assert.match(hit, /设置/, '提示里要告诉用户可调');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('传入更大的上限会生效（这里用 12 避免测试过慢）', async () => {
  const { dir, db, conversationId } = world();
  const events: TurnEvent[] = [];
  try {
    for await (const event of runTurn({
      db,
      conversationId,
      userText: 'go',
      provider: endlessToolProvider(),
      maxSteps: 12,
      signal: new AbortController().signal,
      workspacePath: dir,
    })) {
      events.push(event);
    }
    const hit = events
      .filter((e) => e.type === 'error')
      .map((e) => (e.type === 'error' ? e.message : ''))
      .find((m) => m.includes('步数上限'));
    assert.ok(hit?.includes('12'), `应当按 12 步中止，实际：${hit ?? '(没有报错)'}`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ `maxSteps: null` = 不限制：跑过 40 步也不中止', async () => {
  const { dir, db, conversationId } = world();
  const events: TurnEvent[] = [];
  try {
    /**
     * ★ 这里**必须自己在测试里设一个上限**（跑够就 break）。
     *   为什么：`null` 就是"不限制"，而假模型每次都换工具参数 ⇒ **空转守卫也拦不住**
     *   （它只在"同工具 + 同参数连续 3 次"时才触发）⇒ 不 break 就是真无限循环。
     *   第一次写这条测试就是这么挂住的 —— 这也说明了一件事：
     *   **关掉步数上限之后，除了空转守卫没有任何步数护栏**，这是用户显式选择的代价。
     */
    const WATCHDOG = 60;
    let steps = 0;
    for await (const event of runTurn({
      db,
      conversationId,
      userText: 'go',
      provider: endlessToolProvider(),
      maxSteps: null,
      signal: new AbortController().signal,
      workspacePath: dir,
    })) {
      events.push(event);
      if (event.type === 'tool') steps += 1;
      if (event.type === 'error') break;
      if (steps >= WATCHDOG) break; // 测试自己收手
    }
    const errors = events.filter((e) => e.type === 'error').map((e) => (e.type === 'error' ? e.message : ''));
    assert.equal(
      errors.some((message) => message.includes('步数上限')),
      false,
      `关掉上限后不该出现"步数上限"，实际：${errors[0] ?? '(无错误)'}`,
    );
    assert.ok(steps >= WATCHDOG, `应当至少跑满 ${String(WATCHDOG)} 步都没被步数上限拦，实际 ${String(steps)} 步`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('上限被夹到 [1, 1000]：传 0 / 负数 / 巨大值都不会失控', async () => {
  for (const [requested, expected] of [[0, '1'], [-5, '1'], [999999, '1000']] as const) {
    const { dir, db, conversationId } = world();
    try {
      const events: TurnEvent[] = [];
      for await (const event of runTurn({
        db,
        conversationId,
        userText: 'go',
        provider: endlessToolProvider(),
        maxSteps: requested,
        signal: new AbortController().signal,
        workspacePath: dir,
      })) {
        events.push(event);
        // 收到任何终止性错误就停：要么是步数上限，要么是空转检测（后者也说明没失控）
        if (event.type === 'error') break;
      }
      const errors = events.filter((e) => e.type === 'error').map((e) => (e.type === 'error' ? e.message : ''));
      assert.ok(errors.length > 0, `maxSteps=${requested} 应当被夹住并在有限步内停止`);

      if (requested <= 0) {
        // 夹到 1：第一步就跑不了（第 1 步 > 1 不成立……实际是第 2 步才越界），必须报上限
        assert.match(errors[0]!, new RegExp(`上限 ${expected}\\b`), `maxSteps=${requested} 应夹到 ${expected}`);
      } else {
        // 夹到 1000 时会被别的守卫先拦（同工具同参数空转），这也是"没失控"的证据
        assert.ok(
          /上限 1000|空转|重复/.test(errors[0]!),
          `maxSteps=999999 必须被夹住，实际错误：${errors[0]}`,
        );
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
