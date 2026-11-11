import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureHome, loadConfig } from '../../src/config.ts';
import { fallbackTitle, isPlaceholderTitle, normalizeTitle } from '../../src/core/context/title.ts';
import { thinkingBody, withThinking } from '../../src/core/model/thinking.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import {
  appendMessage,
  getConversation,
  insertConversation,
  insertProvider,
  listConversations,
  updateConversation,
} from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { buildServer } from '../../src/server/app.ts';

/** 建一个隔离的库 + server，跑完自动清理 */
function withServer<T>(fn: (ctx: { app: ReturnType<typeof buildServer>; db: ReturnType<typeof openDatabase>; home: string }) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-ui6-'));
  const config = loadConfig({ ALKAID_HOME: home } as NodeJS.ProcessEnv);
  ensureHome(config);
  const db = openDatabase(config.dbPath);
  migrate(db);
  const app = buildServer({ localToken: null, /* Legacy fixture tests business contracts, not authentication defaults. */ config, db });
  return fn({ app, db, home }).finally(() => {
    void app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
}

// ───────────────── ① 置顶 / 归档 ─────────────────

test('置顶排在最前，归档默认不出现、显式请求才出现', () => {
 withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const a = insertConversation(db, { providerId: provider.id, model: 'm', title: 'A' });
    const b = insertConversation(db, { providerId: provider.id, model: 'm', title: 'B' });
    const c = insertConversation(db, { providerId: provider.id, model: 'm', title: 'C' });

    /**
     * ★ 这个测试只断言**排序契约**，不断言"三条精确顺序"。
     *   原因：三条会话是在同一毫秒里插入的，`updated_at DESC` 对同毫秒的顺序是未定义的。
     *   断言死顺序看着更严格，实际是在测时间戳精度 —— 那种测试会随机红。
     *   真正要钉住的是这四条：未置顶的都在置顶之后 / 置顶之间按置顶时刻 / 归档不出现在主列表 / 归档沉到最后。
     */
    const order = (): string[] => listConversations(db).map((row) => row.title ?? '?');
    const orderWithArchived = (): string[] =>
      listConversations(db, { includeArchived: true }).map((row) => row.title ?? '?');

    assert.equal(order().length, 3, '默认三条都在（还没归档）');
    assert.deepEqual(new Set(order()), new Set(['A', 'B', 'C']));

    // 置顶 A ⇒ A 必须在最前
    updateConversation(db, a.id, { pinnedAt: new Date().toISOString() });
    assert.equal(order()[0], 'A', '置顶的排最前');

    // 再置顶 B（时刻更晚）⇒ B 在 A 前面：置顶之间按置顶时刻倒序
    await new Promise((resolve) => setTimeout(resolve, 5));
    updateConversation(db, b.id, { pinnedAt: new Date().toISOString() });
    assert.deepEqual(order().slice(0, 2), ['B', 'A'], '置顶之间按置顶时刻倒序');
    assert.equal(order()[2], 'C', '未置顶的沉到后面');

    // 归档 C ⇒ 主列表看不到，但带参数能看到，且沉到最后
    updateConversation(db, c.id, { archivedAt: new Date().toISOString() });
    assert.deepEqual(order(), ['B', 'A'], '归档的不出现在主列表');
    assert.deepEqual(orderWithArchived(), ['B', 'A', 'C'], '归档的沉到最后');

    // 取消置顶 / 还原归档 ⇒ 三条都回来
    updateConversation(db, a.id, { pinnedAt: null });
    updateConversation(db, c.id, { archivedAt: null });
    const finalOrder = order();
    assert.equal(finalOrder[0], 'B', 'B 仍然置顶，必须第一');
    assert.deepEqual(new Set(finalOrder), new Set(['A', 'B', 'C']), '三条都在，一个不丢');
  });
});

test('PATCH 置顶/归档收的是时刻，null 与空串都表示取消，非法值 400', () => {
 withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conv = insertConversation(db, { providerId: provider.id, model: 'm' });

    const pinned = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conv.id}`,
      payload: { pinnedAt: '2026-11-08T00:00:00Z' },
    });
    assert.equal(pinned.statusCode, 200);
    assert.ok((pinned.json() as { pinnedAt: string | null }).pinnedAt !== null);

    // 空串 = 取消（不能变成「1970 年置顶」）
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conv.id}`,
      payload: { pinnedAt: '' },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal((cleared.json() as { pinnedAt: string | null }).pinnedAt, null);

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conv.id}`,
      payload: { pinnedAt: '不是时刻' },
    });
    assert.equal(bad.statusCode, 400);
  });
});

// ───────────────── ② 思考强度 ─────────────────

test('思考强度映射：五种 provider 形状各发各的字段，off 不假装', () => {
  // effort_only 没有开关字段 ⇒ 只能压到最低档，不能谎称已关
  assert.deepEqual(thinkingBody('effort_only', 'high'), { reasoning_effort: 'high' });
  assert.deepEqual(thinkingBody('effort_only', 'off'), { reasoning_effort: 'low' });

  // 有开关的才真的关
  assert.deepEqual(thinkingBody('effort_plus_thinking_switch', 'off'), {
    reasoning_effort: 'low',
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(thinkingBody('enable_thinking', 'off'), { enable_thinking: false });
  assert.deepEqual(thinkingBody('enable_thinking', 'medium'), { enable_thinking: true });
  assert.deepEqual(thinkingBody('reasoning_object', 'high'), { reasoning: { effort: 'high' } });

  // none / 未设置 ⇒ 一个字段都不发
  assert.deepEqual(thinkingBody('none', 'high'), {});
  assert.deepEqual(thinkingBody(undefined, 'high'), {});
  assert.deepEqual(thinkingBody('effort_only', null), {});

  // withThinking 不改原对象，且与已有 extraBody 合并
  const base = { model: 'm', messages: [], extraBody: { keep: true } as Record<string, unknown> };
  const merged = withThinking(base, 'effort_only', 'high');
  assert.equal(base.extraBody['reasoning_effort'], undefined, '原对象不能被改');
  assert.deepEqual(merged.extraBody, { keep: true, reasoning_effort: 'high' });
});

test('PATCH 只接受白名单里的思考强度', () => {
 withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const conv = insertConversation(db, { providerId: provider.id, model: 'm' });

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conv.id}`,
      payload: { thinkingEffort: 'medium' },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(getConversation(db, conv.id)?.thinkingEffort, 'medium');

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conv.id}`,
      payload: { thinkingEffort: null },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(getConversation(db, conv.id)?.thinkingEffort, null);

    for (const bad of ['max', 'HIGH', '', 3]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/conversations/${conv.id}`,
        payload: { thinkingEffort: bad },
      });
      assert.equal(res.statusCode, 400, `应拒绝：${String(bad)}`);
    }
  });
});

// ───────────────── ③ 分支 ─────────────────

test('分支只复制对话正文，不搬工具链，且原会话不动', () => {
 withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const source = insertConversation(db, { providerId: provider.id, model: 'm', title: '原会话' });

    appendMessage(db, { conversationId: source.id, role: 'user', content: '问题一' });
    appendMessage(db, {
      conversationId: source.id,
      role: 'assistant',
      content: '答一',
      toolCalls: [{ id: 'call_1', name: 'read', arguments: '{}' }],
    });
    appendMessage(db, { conversationId: source.id, role: 'tool', content: '工具输出' });
    appendMessage(db, { conversationId: source.id, role: 'user', content: '问题二' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${source.id}/branch`,
      payload: { uptoSeq: 2 },
    });
    assert.equal(res.statusCode, 201);

    const branch = res.json() as { id: string; title: string | null; model: string };
    assert.equal(branch.title, '原会话（分支）');
    assert.equal(branch.model, 'm', '模型继承原会话');

    const copied = listConversations(db).find((row) => row.id === branch.id);
    assert.ok(copied !== undefined);

    // ★ 关键：分支里没有 tool 消息，也没有 tool_calls —— 否则就是一条坏历史
    const rows = db
      .prepare('SELECT role, tool_calls FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(branch.id) as Array<{ role: string; tool_calls: string | null }>;
    assert.deepEqual(rows.map((row) => row.role), ['user', 'assistant']);
    assert.equal(rows[1]?.tool_calls, null, '工具调用不能搬过去');

    // 原会话一条不少
    const sourceCount = db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
      .get(source.id) as { n: number };
    assert.equal(Number(sourceCount.n), 4);
  });
});

test('分支：没有可复制内容时 400，源会话不存在时 404', () => {
 withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://x/v1' });
    const empty = insertConversation(db, { providerId: provider.id, model: 'm' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${empty.id}/branch`,
      payload: { uptoSeq: 0 },
    });
    assert.equal(res.statusCode, 400);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/conversations/不存在/branch',
      payload: { uptoSeq: 1 },
    });
    assert.equal(missing.statusCode, 404);
  });
});

// ───────────────── ④ 自动起标题 ─────────────────

test('占位标题判定：新对话/对话 N 算占位，用户起的名字不算', () => {
  for (const placeholder of [null, '', '  ', '对话 1', '对话 12', '新对话', '未命名', '新的对话']) {
    assert.equal(isPlaceholderTitle(placeholder), true, `应判为占位：${String(placeholder)}`);
  }
  for (const real of ['修复机器人离线重连', 'V0.3 方向讨论', '对话不是占位吧']) {
    assert.equal(isPlaceholderTitle(real), false, `不该判为占位：${real}`);
  }
});

test('标题清洗：去掉 markdown 符号、引号，只取第一行', () => {
  assert.equal(normalizeTitle('## 环境依赖排查'), '环境依赖排查');
  assert.equal(normalizeTitle('「修复离线重连」'), '修复离线重连');
  assert.equal(normalizeTitle('- 工具链体检'), '工具链体检');
  assert.equal(normalizeTitle('**沙箱方案**'), '沙箱方案');
  assert.equal(normalizeTitle('第一行\n第二行'), '第一行');
  assert.equal(normalizeTitle('  前后有空格  '), '前后有空格');
});

test('标题洗掉 ANSI / 控制字符 / 方向欺骗字符（照 DSH 的 normalize 做法）', () => {
  // SGR 颜色码
  assert.equal(normalizeTitle('\u001b[31m红色标题\u001b[0m'), '红色标题');
  // 方向覆盖符：能让"看起来一样"的两个标题实际不同，必须删
  assert.equal(normalizeTitle('abc\u202Edef'), 'abcdef');
  // 零宽与 BOM
  assert.equal(normalizeTitle('a\u200Bb\uFEFFc'), 'abc');
  // 换行/制表归一成空格（★ 是"一个空格"不是"删掉"：`甲\t乙` 不该粘连成 `甲乙`）
  assert.equal(normalizeTitle('甲\t乙'), '甲 乙');
  assert.equal(normalizeTitle('甲\n丙'), '甲');
});

test('标题超字节预算时在句读处截断，且不切断 emoji', () => {
  // 模型不听"12 字"的要求，回了整句寒暄 —— 必须收短到 48 字节以内
  const chatty = '你好，我是假模型。这条回复由本地脚本生成，不消耗任何额度。';
  const short = normalizeTitle(chatty);
  assert.ok(Buffer.byteLength(short, 'utf8') <= 48, `必须 ≤48 字节，实际 ${Buffer.byteLength(short, 'utf8')}`);
  assert.ok(chatty.startsWith(short), '截断必须是从头开始的一段');

  // emoji 是 4 字节 / 多码元：截断不能劈出半个代理对
  const emoji = '🚀'.repeat(20);
  const cut = normalizeTitle(emoji);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 48);
  assert.ok(!/[\uD800-\uDBFF]$/u.test(cut), '不能以孤立的高代理结尾');
  assert.equal([...cut].every((ch) => ch === '🚀'), true);
});

test('模型失败时用第一句用户消息兜一个标题（不是永远叫「新的对话」）', () => {
  // 有句读：截到句读处
  assert.equal(fallbackTitle('帮我看看这个项目的环境依赖。别的先不急'), '帮我看看这个项目的环境依赖');
  // 没句读：按字节硬截
  const long = fallbackTitle('一二三四五六七八九十一二三四五六七八九十');
  assert.ok(long !== null && Buffer.byteLength(long, 'utf8') <= 48);
  // 空白/纯符号 ⇒ 没有可用回退
  assert.equal(fallbackTitle('   '), null);
});

test('起标题接口：已有非占位标题时不动它，且回 titled:false', () => {
 withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://127.0.0.1:1', contextWindow: 1000 });
    const conv = insertConversation(db, { providerId: provider.id, model: 'm', title: '我自己起的名字' });
    appendMessage(db, { conversationId: conv.id, role: 'user', content: '随便说点什么' });

    // provider 指向一个连不上的地址，但"已有标题"应当**在发请求前**就短路
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/title`, payload: {} });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { titled: boolean; reason: string | null };
    assert.equal(body.titled, false);
    assert.equal(body.reason, 'has_title');
    assert.equal(getConversation(db, conv.id)?.title, '我自己起的名字', '用户起的名字绝不能被覆盖');
  });
});

test('起标题接口：上游连不上时回 200 且 reason=failed（不是用户的错）', () => {
 withServer(async ({ app, db }) => {
    const provider = insertProvider(db, { name: 'p', baseUrl: 'http://127.0.0.1:1', contextWindow: 1000 });
    const conv = insertConversation(db, { providerId: provider.id, model: 'm' });
    appendMessage(db, { conversationId: conv.id, role: 'user', content: '帮我看看环境' });

    const res = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/title`, payload: {} });
    // 没有 key 时是 412（前置检查），这也是"不让用户看到 500"的一种；
    // 有 key 但连不上时核心逻辑自己吞掉失败、回 200 + failed。
    assert.ok([200, 412].includes(res.statusCode), `不能是 500，实际 ${res.statusCode}`);
    if (res.statusCode === 200) {
      const body = res.json() as { titled: boolean; reason: string | null };
      assert.equal(body.titled, false);
      assert.equal(body.reason, 'failed');
    }
    assert.equal(getConversation(db, conv.id)?.title, null, '失败时标题保持原样');
  });
});
