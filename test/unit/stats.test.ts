import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { appendMessage, insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { conversationStats, conversationUsageDetail } from '../../src/core/store/stats.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

/**
 * 底部状态栏的三样数据：轮/步 + 速度、累计 tok + 缓存命中、上下文水位。
 * ★ 这里只断言**口径**（谁算一轮、谁算一步、命中率怎么除），不断言具体数字来源 ——
 *   数字来自假模型，换个假模型就变，断言死数字等于把测试绑到夹具上。
 */
function withDb<T>(fn: (db: ReturnType<typeof openDatabase>) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-stats-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test('轮 = 用户消息数，步 = 助手消息数（与工具消息无关）', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '一' });
    appendMessage(db, { conversationId: conversation.id, role: 'assistant', content: '甲' });
    appendMessage(db, { conversationId: conversation.id, role: 'tool', content: '输出' });
    appendMessage(db, { conversationId: conversation.id, role: 'assistant', content: '乙' });
    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '二' });

    const stats = conversationStats(db, conversation.id);
    assert.equal(stats.turns, 2, '两条 user 消息 = 两轮');
    assert.equal(stats.steps, 2, '两条 assistant 消息 = 两步；tool 消息不计');
  });
});

test('累计 tokens 与缓存命中率按「输入总量」求和/相除（历史数据 = 旧口径）', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '问' });
    // ★ 这两个 usage 是**历史形状**（没有 inputExcludesCached 标记）：
    //   旧口径下 `input` 已含缓存，读取侧不能再把 cached 加上去
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '答一',
      usage: { input: 1000, output: 200, cached: 800 },
    });
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '答二',
      usage: { input: 1000, output: 300, cached: 200 },
    });

    const stats = conversationStats(db, conversation.id);
    assert.equal(stats.totalInput, 2000, '旧口径 input 本身就是输入总量');
    assert.equal(stats.totalOutput, 500);
    assert.equal(stats.totalCached, 1000);
    assert.equal(stats.totalTokens, 2500);
    assert.equal(stats.cacheHitRate, 0.5, '1000 / 2000');
    assert.equal(stats.totalCachedWrite, null, '历史数据没报缓存写入 ⇒ null，不是 0');
  });
});

test('新口径（input 已扣缓存）：三桶之和 = 输入总量，totalTokens 不变大也不变小', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    // ★ 这正是 openai-parse.ts 现在写出来的形状：input 只有未缓存那部分
    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '问' });
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '答',
      usage: { input: 100, output: 50, cached: 900, inputExcludesCached: true },
    });

    const stats = conversationStats(db, conversation.id);
    assert.equal(stats.totalInput, 1000, '输入总量 = 100 未缓存 + 900 缓存读');
    assert.equal(stats.totalCached, 900);
    assert.equal(stats.totalTokens, 1050, '1000 + 50');
    assert.equal(stats.cacheHitRate, 0.9, '900 / 1000');

    const detail = conversationUsageDetail(db, conversation.id);
    assert.equal(detail.steps[0]?.input, 1000, '明细 input 也是输入总量');
    assert.equal(detail.steps[0]?.uncachedInput, 100, '未缓存那部分单列');
    assert.equal(detail.steps[0]?.cached, 900);
  });
});

test('★ 新旧两种库数据混排：totalTokens 与命中率都正确（缓存只能算一次）', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '问' });
    // ① 历史行（旧口径，没有标记）：input=1000 已含 800 缓存 ⇒ 输入总量 1000
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '旧',
      usage: { input: 1000, output: 200, cached: 800 },
    });
    // ② 新行（带标记）：input=300 未缓存 + cached=900 ⇒ 输入总量 1200
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '新',
      usage: { input: 300, output: 100, cached: 900, inputExcludesCached: true },
    });

    const stats = conversationStats(db, conversation.id);
    // 旧：1000（含缓存，未缓存 200）  新：300 + 900（未缓存 300）   合计 2200
    assert.equal(stats.totalInput, 2200);
    assert.equal(stats.totalUncachedInput, 500, '200（旧行反推）+ 300（新行原值）');
    assert.equal(stats.totalCached, 1700, '800 + 900');
    assert.equal(stats.totalTokens, 2500, '2200 输入 + 300 输出');

    // ★ 三桶必须自己就能对上总量（不靠减法补差）
    assert.equal(
      stats.totalUncachedInput + stats.totalCached + (stats.totalCachedWrite ?? 0),
      stats.totalInput,
      '三桶之和必须等于输入总量',
    );

    // ★ 反证：如果两条都按「input + cached」算，会得到 1000+800 + 300+900 = 3000，多算了一整桶
    assert.notEqual(stats.totalTokens, 3000, '旧行绝不能再加一次 cached');

    // ★ 反证：如果两条都按旧口径（只加 input），会得到 1000 + 300 = 1300，少算一整桶
    assert.notEqual(stats.totalInput, 1300, '新行必须把 cached 加回来');

    assert.equal(stats.cacheHitRate, 1700 / 2200);
  });
});

test('reasoning 是 output 的子集：库里存了它也**不**进 totalTokens', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '问' });
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '答',
      usage: { input: 100, output: 500, cached: 40, reasoning: 400, inputExcludesCached: true },
    });

    const stats = conversationStats(db, conversation.id);
    // 输入总量 = 100 + 40 = 140；输出 500（reasoning 400 已含在里面）
    assert.equal(stats.totalInput, 140);
    assert.equal(stats.totalOutput, 500);
    assert.equal(stats.totalTokens, 640, '140 + 500；若把 reasoning 也加就是 1040，那是重复计费');
  });
});

test('缓存写入：报过就累加，一步都没报就是 null（0 与「没报」分开）', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '问' });
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '写缓存',
      usage: { input: 200, output: 10, cached: 300, cachedWrite: 500, inputExcludesCached: true },
    });
    // 第二步没报缓存写入 —— 不能把它的 0 混成「报过 0」
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '无写入',
      usage: { input: 100, output: 10, cached: 0, inputExcludesCached: true },
    });

    const stats = conversationStats(db, conversation.id);
    assert.equal(stats.totalCachedWrite, 500, '只有第一步报过');
    // 第一步输入总量 = 200 未缓存 + 300 缓存读 + 500 缓存写 = 1000；第二步 = 100 + 0 = 100
    assert.equal(stats.totalInput, 1100, '1000 + 100');
    assert.equal(stats.totalUncachedInput, 300, '200 + 100');
    assert.equal(stats.totalTokens, 1120, '1100 输入 + 20 输出');

    const detail = conversationUsageDetail(db, conversation.id);
    assert.equal(detail.steps[0]?.cachedWrite, 500);
    assert.equal(detail.steps[1]?.cachedWrite, undefined, '没报过就没有这个字段');
    assert.equal(detail.steps[0]?.input, 1000, '该步输入总量 = 200+300+500');
  });
});

test('没有任何 usage 时，速度与命中率是 null（不编数字）', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });
    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '问' });
    appendMessage(db, { conversationId: conversation.id, role: 'assistant', content: '答' });

    const stats = conversationStats(db, conversation.id);
    assert.equal(stats.tokensPerSecond, null);
    assert.equal(stats.cacheHitRate, null);
    assert.equal(stats.totalTokens, 0);
  });
});

test('PATCH /api/providers/:id 改上下文窗口，非法值被拒', async () => {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-pw-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });

  try {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/providers/${provider.id}`,
      payload: { contextWindow: 64_000 },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.json() as { contextWindow: number }).contextWindow, 64_000);

    for (const bad of [0, 999, 10_000_001, 64_000.5, '64000', null]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/providers/${provider.id}`,
        payload: { contextWindow: bad },
      });
      assert.equal(res.statusCode, 400, `应拒绝：${String(bad)}`);
    }

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/providers/不存在',
      payload: { contextWindow: 64_000 },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('usage 明细：逐步列出，且耗时/速度与聚合口径一致', async () => {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-usage-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });

  try {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });
    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '问' });
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '答',
      usage: { input: 100, output: 40, cached: 20 },
      finishReason: 'stop',
    });

    const res = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}/usage` });
    assert.equal(res.statusCode, 200);

    const body = res.json() as {
      stats: { turns: number; steps: number; totalTokens: number };
      steps: Array<{ seq: number; input: number; output: number; cached: number; finishReason: string | null }>;
      stepCount: number;
    };
    assert.equal(body.stepCount, 1);
    assert.equal(body.steps.length, 1);
    assert.equal(body.steps[0]?.input, 100);
    assert.equal(body.steps[0]?.cached, 20);
    assert.equal(body.steps[0]?.finishReason, 'stop');
    // ★ 明细里的聚合必须与 /dashboard 的 stats 同源同值
    assert.equal(body.stats.totalTokens, 140);
    assert.equal(body.stats.steps, 1);

    // limit 越界要回落到默认值，不能把整个会话抛出去
    const clamped = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}/usage?limit=99999`,
    });
    assert.equal(clamped.statusCode, 200);

    const missing = await app.inject({ method: 'GET', url: '/api/conversations/不存在/usage' });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('间隔太短（同一批写入）时速度是 null，不是天文数字', () => {
  withDb((db) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });

    // 三条消息几乎同时写入（间隔 0–几毫秒），正是"批量插入/假模型一次吐完"的形状
    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '问' });
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '答',
      usage: { input: 100, output: 320, cached: 0 },
    });

    const detail = conversationUsageDetail(db, conversation.id);
    assert.equal(detail.steps.length, 1);
    // ★ 这条是为了钉住"32000 tok/s"那个假数不再出现
    assert.equal(detail.steps[0]?.tokensPerSecond, null, '毫秒级间隔不该算出速度');
    assert.equal(detail.stats.tokensPerSecond, null, '聚合速度同理');
  });
});

test('dashboard 带出 stats / contextWindow / contextRatio，且 provider 默认窗口 128000', async () => {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-dash2-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });

  try {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    assert.equal(provider.contextWindow, 128_000, 'V3 默认窗口');

    const conversation = insertConversation(db, { providerId: provider.id, model: 'm' });
    appendMessage(db, { conversationId: conversation.id, role: 'user', content: '一' });
    appendMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '二',
      usage: { input: 50, output: 10, cached: 25 },
    });

    const res = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}/dashboard` });
    assert.equal(res.statusCode, 200);

    const body = res.json() as {
      contextWindow: number;
      contextRatio: number | null;
      stats: { turns: number; steps: number; totalTokens: number; cacheHitRate: number | null };
    };
    assert.equal(body.contextWindow, 128_000);
    assert.equal(body.stats.turns, 1);
    assert.equal(body.stats.steps, 1);
    assert.equal(body.stats.totalTokens, 60);
    assert.equal(body.stats.cacheHitRate, 0.5);
    assert.ok(body.contextRatio !== null && body.contextRatio > 0 && body.contextRatio < 1);
  } finally {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
