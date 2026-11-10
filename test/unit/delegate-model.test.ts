import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { createDelegateTool } from '../../src/core/agent/delegate-tool.ts';
import { listDelegations } from '../../src/core/agent/delegation.ts';
import type { TurnEvent } from '../../src/core/agent/loop.ts';
import { setSecret } from '../../src/core/secrets.ts';
import { loadConfig } from '../../src/config.ts';
import { rootsFor } from '../../src/core/policy/roots.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { getConversation, insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { DEFAULT_GENERAL, delegateModelKey, normalizeGeneral } from '../../src/shared/settings.ts';
import type { ToolContext } from '../../src/core/tools/types.ts';

/**
 * **主对话给子代理选模型**（2026-11-10 用户要求）。
 *
 * 两个独立旋钮，回答两个不同的问题：
 * ① 白名单：**别的**模型里允许哪些（三态：`null` 不限制 / `[]` 一个都不许 / 非空列出）；
 * ② 「允许主对话用它自己的模型」：**我自己正在用的那个**要不要也放行（默认放行）。
 *
 * 这组测试钉的是**判据的行为**，不是"字段存在"：
 * 同样的参数在白名单三态下必须给出**不同的**结果，且错误码要能让模型知道该做什么。
 */

function withDb(run: (db: DatabaseSync, home: string) => Promise<void>) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'alkaid-delegate-model-'));
    const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
    const db = openDatabase(config.dbPath);
    migrate(db);
    try {
      await run(db, home);
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function ctxOf(conversationId: string): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-dm-ctx-'));
  return {
    conversationId,
    permissionMode: 'full',
    roots: rootsFor('full', null, null),
    workspacePath: null,
    projectSharedDir: null,
    cwd: dir,
    tempDir: dir,
    signal: new AbortController().signal,
  };
}

/** 造主对话（用 provider A / model-a）+ 另一个已注册连接（provider B / model-b） */
function seed(db: DatabaseSync) {
  const a = insertProvider(db, { name: '连接A', baseUrl: 'http://x/v1', defaultModel: 'model-a' });
  const b = insertProvider(db, { name: '连接B', baseUrl: 'http://y/v1', defaultModel: 'model-b' });
  const conversation = insertConversation(db, {
    providerId: a.id,
    model: 'model-a',
    permissionMode: 'full',
  });
  return { a, b, conversation };
}

/** 假 runner：立刻成功，返回一个结论 */
const okRunner = () =>
  (async function* (): AsyncGenerator<TurnEvent> {
    yield { type: 'text', delta: '做完了' };
    yield { type: 'finish', reason: 'stop' };
  })();

function toolFor(
  db: DatabaseSync,
  home: string,
  options: { allowedModels?: readonly string[] | null; allowParentModel?: boolean },
) {
  /**
   * ★ 每个 provider 都要有 Key：工具在**选定模型之后**才去取那个连接自己的 Key，
   *   所以只给主对话那个连接配 Key 的话，"用别的连接"这条测试会假失败在取 Key 上，
   *   而不是死在我们要验的白名单判据上。
   */
  const secretsPath = join(home, 'secrets.json');
  const rows = db.prepare('SELECT id FROM providers').all() as Array<{ id: string }>;
  for (const row of rows) setSecret(secretsPath, row.id, 'test-key-not-real');

  return createDelegateTool(db, {
    secretsPath,
    runner: () => okRunner(),
    ...(options.allowedModels === undefined ? {} : { allowedModels: options.allowedModels }),
    ...(options.allowParentModel === undefined ? {} : { allowParentModel: options.allowParentModel }),
  });
}

// ───────────────────────── 归一化（纯函数） ─────────────────────────

test('★★ 白名单三态归一化：null / [] / 非空 各是各的意思，不许互相混', () => {
  assert.equal(normalizeGeneral({}).delegateAllowedModels, null, '默认必须是不限制');
  assert.deepEqual(normalizeGeneral({ delegateAllowedModels: [] }).delegateAllowedModels, [], '空数组必须留住 —— 它不是"没设"');
  assert.deepEqual(normalizeGeneral({ delegateAllowedModels: ['p::m'] }).delegateAllowedModels, ['p::m']);

  // ★ 非数组（垃圾值）⇒ 回落"不限制"，**不能**当成空数组：那会把所有子代理模型突然禁掉
  assert.equal(normalizeGeneral({ delegateAllowedModels: 'oops' }).delegateAllowedModels, null);
  assert.equal(normalizeGeneral({ delegateAllowedModels: 42 }).delegateAllowedModels, null);

  // 去重 + 丢空串
  assert.deepEqual(
    normalizeGeneral({ delegateAllowedModels: ['p::m', 'p::m', '  ', 'q::n'] }).delegateAllowedModels,
    ['p::m', 'q::n'],
  );
});

test('★ 键的拼/拆：模型 id 里带冒号也不能被切坏', () => {
  const key = delegateModelKey('prov-1', 'vendor:model-v2');
  assert.equal(key, 'prov-1::vendor:model-v2');
  const parsed = normalizeGeneral({ delegateAllowedModels: [key] }).delegateAllowedModels;
  assert.deepEqual(parsed, [key]);
});

test('★ 「允许用自己模型」默认 true；只有明确 false 才关', () => {
  assert.equal(DEFAULT_GENERAL.delegateAllowParentModel, true);
  assert.equal(normalizeGeneral({}).delegateAllowParentModel, true);
  assert.equal(normalizeGeneral({ delegateAllowParentModel: false }).delegateAllowParentModel, false);
  // 垃圾值按"允许"（保守：它不放开别的模型，只是允许用自己那个）
  assert.equal(normalizeGeneral({ delegateAllowParentModel: 'false' }).delegateAllowParentModel, true);
});

// ───────────────────────── 行为：白名单三态 ─────────────────────────

test('★★ 白名单 = null（不限制）⇒ 主对话可以把它选成别的已注册模型', withDb(async (db, home) => {
  const { a, b, conversation } = seed(db);
  const tool = toolFor(db, home, { allowedModels: null });

  const result = await tool.execute(
    { task: '用 B 干点活', title: 'B', providerId: b.id, model: 'model-b' },
    ctxOf(conversation.id),
  );
  assert.equal(result.ok, true, `不限制时应该能用别的模型：${JSON.stringify(result)}`);

  // ★ 子会话真的落在这个模型上（不是只在返回值里说了一声）
  const delegations = listDelegations(db, conversation.id);
  assert.equal(delegations.length, 1);
  const child = getConversation(db, delegations[0]!.childConversationId);
  assert.equal(child?.providerId, b.id, '子会话没有用选定的连接');
  assert.equal(child?.model, 'model-b', '子会话没有用选定的模型');
  void a;
}));

test('★★ 白名单非空 ⇒ 不在列表里的模型被拒，且错误码可行动', withDb(async (db, home) => {
  const { a, b, conversation } = seed(db);
  // 白名单只有 A（主对话自己的那家）
  const tool = toolFor(db, home, { allowedModels: [delegateModelKey(a.id, 'model-a')] });

  const denied = await tool.execute(
    { task: '用 B', providerId: b.id, model: 'model-b' },
    ctxOf(conversation.id),
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, 'delegate_model_not_allowed');
    assert.ok((denied.hint ?? '').length > 0, '拒绝必须告诉模型接下来怎么走');
  }

  // 白名单里的照常可用
  const allowed = await tool.execute(
    { task: '用 A', providerId: a.id, model: 'model-a' },
    ctxOf(conversation.id),
  );
  assert.equal(allowed.ok, true, `白名单内的模型不该被拦：${JSON.stringify(allowed)}`);
}));

test('★★ 白名单 = []（一个都不许）⇒ 不能用别的模型，但仍能用主对话自己的', withDb(async (db, home) => {
  const { a, b, conversation } = seed(db);
  const tool = toolFor(db, home, { allowedModels: [], allowParentModel: true });

  const denied = await tool.execute({ task: '用 B', providerId: b.id, model: 'model-b' }, ctxOf(conversation.id));
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, 'delegate_model_not_allowed');
    assert.match(denied.message, /空|只能用当前对话/);
  }

  // ★ 「允许用自己模型」= true ⇒ 显式选自己那一对仍然放行
  const own = await tool.execute(
    { task: '用自己', providerId: a.id, model: 'model-a' },
    ctxOf(conversation.id),
  );
  assert.equal(own.ok, true, `空数组 + 允许自己 ⇒ 自己那个必须放行：${JSON.stringify(own)}`);
}));

test('★★ 白名单 = [] 且「允许用自己模型」= false ⇒ 连自己那个也不给', withDb(async (db, home) => {
  const { a, conversation } = seed(db);
  const tool = toolFor(db, home, { allowedModels: [], allowParentModel: false });

  const denied = await tool.execute(
    { task: '用自己', providerId: a.id, model: 'model-a' },
    ctxOf(conversation.id),
  );
  assert.equal(denied.ok, false, '关掉那个开关后，连主对话自己的模型也要过白名单');
  if (!denied.ok) assert.equal(denied.code, 'delegate_model_not_allowed');

  // 但不传 providerId/model（沿用主对话）是**另一条路**：它不是"选定模型"，不受白名单约束
  const inherit = await tool.execute({ task: '不指定模型' }, ctxOf(conversation.id));
  assert.equal(inherit.ok, true, `不指定模型应该仍然可用（那是原行为）：${JSON.stringify(inherit)}`);
}));

// ───────────────────────── 行为：参数与连接的既有约束 ─────────────────────────

test('★ 只给 providerId 或只给 model ⇒ 拒绝（无法定位具体模型）', withDb(async (db, home) => {
  const { b, conversation } = seed(db);
  const tool = toolFor(db, home, { allowedModels: null });

  const onlyProvider = await tool.execute({ task: 'x', providerId: b.id }, ctxOf(conversation.id));
  assert.equal(onlyProvider.ok, false);
  if (!onlyProvider.ok) {
    assert.equal(onlyProvider.code, 'invalid_arguments');
    assert.match(onlyProvider.message, /一起给/);
  }

  const onlyModel = await tool.execute({ task: 'x', model: 'model-b' }, ctxOf(conversation.id));
  assert.equal(onlyModel.ok, false);
}));

test('★ 指向不存在的连接 ⇒ provider_missing（不是"模型不在白名单"）', withDb(async (db, home) => {
  const { conversation } = seed(db);
  const tool = toolFor(db, home, { allowedModels: null });

  const result = await tool.execute(
    { task: 'x', providerId: 'no-such-provider', model: 'whatever' },
    ctxOf(conversation.id),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'provider_missing');
}));

test('★★ 连接自己的 enabledModels 白名单也要守（否则一条委派就能绕过它）', withDb(async (db, home) => {
  const { b, conversation } = seed(db);
  // 把 B 限定为只允许 model-b；请求 model-c 应被拒
  db.prepare('UPDATE providers SET enabled_models = ? WHERE id = ?').run(JSON.stringify(['model-b']), b.id);

  const tool = toolFor(db, home, { allowedModels: null });
  const denied = await tool.execute(
    { task: 'x', providerId: b.id, model: 'model-c' },
    ctxOf(conversation.id),
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, 'delegate_model_not_allowed');
    assert.match(denied.message, /只允许/);
  }
}));
