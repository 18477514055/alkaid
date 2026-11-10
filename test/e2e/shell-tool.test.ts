import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { runTurn, type TurnEvent } from '../../src/core/agent/loop.ts';
import type { Provider } from '../../src/core/model/provider.ts';
import { rootsFor } from '../../src/core/policy/roots.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertConversation, insertProvider, listMessages } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createPwshTool } from '../../src/core/tools/shell.ts';
import { ToolRegistry, type ToolContext } from '../../src/core/tools/types.ts';
import type { ChatEvent, ChatRequest } from '../../src/shared/types.ts';

/**
 * shell 工具的真机测试：**真的 spawn powershell.exe**，不 mock。
 * 这里钉的是三个已经踩过或极易踩的点：编码、退出码、超时杀进程树。
 */

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const tempDir = mkdtempSync(join(tmpdir(), 'alkaid-sh-'));
  return {
    conversationId: 'c1',
    permissionMode: 'full',
    roots: rootsFor('full', null, null),
    workspacePath: null,
    projectSharedDir: null,
    cwd: tempDir,
    tempDir,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('中文输出不再乱码（PowerShell 5.1 默认写 GBK，必须强制 UTF-8）', async () => {
  const tool = createPwshTool();
  const ctx = makeContext();
  try {
    const result = await tool.execute({ command: "Write-Output '中文输出测试'" }, ctx);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.content, '中文输出测试');
      // ★ 这一条就是防回归：不设 OutputEncoding 时会变成一串 `�`
      assert.ok(!result.content.includes('\uFFFD'), '出现了替换字符，说明编码又坏了');
    }
  } finally {
    rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

test('非 0 退出码会出现在结果里（命令跑了，但失败了）', async () => {
  const tool = createPwshTool();
  const ctx = makeContext();
  try {
    const result = await tool.execute({ command: 'cmd /c exit 3' }, ctx);
    assert.equal(result.ok, true, '非 0 退出码不是工具故障');
    if (result.ok) assert.match(result.content, /\[exit code: 3\]/);
  } finally {
    rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

test('超时会把进程杀掉并回结构化失败（不是一直挂着）', async () => {
  const tool = createPwshTool();
  const ctx = makeContext();
  const started = Date.now();
  try {
    const result = await tool.execute({ command: 'Start-Sleep -Seconds 20', timeout_ms: 1000 }, ctx);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'timeout');
      assert.ok(typeof result.hint === 'string' && result.hint.length > 0);
    }
    assert.ok(Date.now() - started < 15_000, '超时没有生效，命令还在跑');
  } finally {
    rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

test('输出超长会被截断并明说（不是悄悄吞掉）', async () => {
  const tool = createPwshTool({ maxOutputChars: 200 });
  const ctx = makeContext();
  try {
    const result = await tool.execute({ command: "1..500 | ForEach-Object { 'x' }" }, ctx);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.content, /已截断/);
      assert.ok(result.content.length < 1_000, '截断没生效');
    }
  } finally {
    rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

test('空命令被拒（invalid_args），不会真去 spawn', async () => {
  const tool = createPwshTool();
  const ctx = makeContext();
  try {
    const result = await tool.execute({ command: '   ' }, ctx);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid_args');
  } finally {
    rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

test('★ 可见性即权限：readonly 档看不到 pwsh，其余档可见（V0.2 起工作区档走沙箱）', async () => {
  const registry = new ToolRegistry().register(createPwshTool());

  // V0.2：沙箱落地后，三档都放开；只读档仍然不给（它连写都不该发生）
  for (const mode of ['full', 'workspace', 'project', 'workspace_project'] as const) {
    assert.deepEqual(registry.toProviderTools(mode).map((tool) => tool.name), ['pwsh'], `模式 ${mode} 应当看到 pwsh`);
  }
  assert.deepEqual(registry.toProviderTools('readonly'), [], 'readonly 档不该看到 pwsh');

  const ctx = makeContext({ permissionMode: 'readonly', roots: rootsFor('readonly', 'C:/work', null) });
  try {
    const outcome = await registry.execute('pwsh', { command: 'echo hi' }, ctx);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.code, 'tool_not_found');
      assert.match(outcome.message, /readonly/);
    }
  } finally {
    rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

test('主循环端到端：full 档下模型调用 pwsh，结果真的回到对话里', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-sh-loop-'));
  const db: DatabaseSync = openDatabase(join(dir, 'test.db'));
  migrate(db);

  try {
    const providerRow = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, {
      providerId: providerRow.id,
      model: 'm',
      permissionMode: 'full',
    });

    const captured: ChatRequest[] = [];
    const script: ChatEvent[][] = [
      [
        { type: 'tool_call', index: 0, id: 'call_1', name: 'pwsh', argsDelta: '{"command":' },
        { type: 'tool_call', index: 0, argsDelta: '"Write-Output \'来自工具的问候\'"}' },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [{ type: 'text', delta: '命令跑完了。' }, { type: 'finish', reason: 'stop' }],
    ];
    const provider: Provider = {
      id: 'fake',
      async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
        captured.push(req);
        for (const event of script.shift() ?? [{ type: 'finish', reason: 'stop' } as ChatEvent]) yield event;
      },
    };

    const registry = new ToolRegistry().register(createPwshTool());
    const tempDir = join(dir, 'tmp');
    mkdirSync(tempDir, { recursive: true });
    const events: TurnEvent[] = [];
    for await (const event of runTurn({
      db,
      conversationId: conversation.id,
      userText: '跑个命令',
      provider,
      signal: new AbortController().signal,
      tools: registry,
      tempDir,
    })) {
      events.push(event);
    }

    // 第一次请求必须把 pwsh 的定义发给模型（否则模型根本不知道有这个工具）
    assert.deepEqual(
      captured[0]?.tools?.map((tool) => tool.name),
      ['pwsh'],
    );

    const toolMessage = listMessages(db, conversation.id).find((message) => message.role === 'tool');
    assert.ok(toolMessage !== undefined, '缺 tool 消息');
    const payload = JSON.parse(String(toolMessage.content)) as { ok: boolean; content?: string };
    assert.equal(payload.ok, true);
    assert.match(String(payload.content), /来自工具的问候/);

    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
