/**
 * **发布验收 v13 → v16**（真启动打包版，三段式：deploy → rollback → reapply）。
 *
 * ## ★ 为什么要有这一份，而不是改那几个老的
 *
 * `verify-memory-release.mjs` / `verify-obligation-release.mjs` / `verify-experience-release.mjs`
 * 各自把**当时的**基线版本写死在断言里（v7 / v10 / v11 / v12），它们的价值是"那一次发布
 * 确实把那一版验过了"—— 改掉它们等于篡改历史证据。所以这一版单独写一份，只验本次要发的
 * v13 → v16。
 *
 * ## ★★ 三段式各自的判据（不是"起了就行"）
 *
 * 1. **deploy**：新程序读**旧库（v13）** ⇒ 自动迁移到 v16，且
 *    ① 既有 2 个会话 / 307 条消息**一条不少**；
 *    ② 五张新表都在、`conversations.parent_conversation_id` 有了；
 *    ③ 新能力真的可用（委派看板端点 200、子代理设置读得到）。
 * 2. **rollback**：**旧程序（v13）读被升到 v16 的库** ⇒ 必须**能起、能读旧数据**。
 *    这一条是"不降级"承诺的反面证据：库只加不删，旧程序不该因为多了几张表就打不开。
 * 3. **reapply**：再换回新程序 ⇒ 一切照旧（证明回退没有破坏任何东西）。
 *
 * ★ 全程用**临时家**（新的 `ALKAID_HOME`），绝不碰用户真实的
 *   `%APPDATA%\alkaid\data`。脚本末尾会断言真实库的 mtime 没变。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { assertDesktopClosed } from './release-guard.mjs';

const root = resolve(import.meta.dirname, '..');
const packaged = join(root, 'release/YaoGuang-win32-x64/resources/app');
const binary = join(root, 'release/YaoGuang-win32-x64/YaoGuang.exe');
const REAL_HOME = process.env['APPDATA'] === undefined ? null : join(process.env['APPDATA'], 'alkaid', 'data');

const publishing = process.argv.includes('--publish');

/**
 * ★ 基线守卫：打包版现在必须是 **v13**（本次要发的起点）。
 *   如果不是，说明已经发布过或回退过 —— 不要盲目覆盖（那会毁掉上一次的回执）。
 */
const packagedSchema = readFileSync(join(packaged, 'src/core/store/schema.ts'), 'utf8');
if (!/export const SCHEMA_VERSION = 13;/.test(packagedSchema)) {
  throw new Error(
    '发布前置不满足：打包版不是 v13 基线。若已发布过请勿重复发布（会覆盖回执）；先确认当前状态。',
  );
}
const sourceSchema = readFileSync(join(root, 'src/core/store/schema.ts'), 'utf8');
assert.match(sourceSchema, /MIGRATIONS\[MIGRATIONS\.length - 1\]/, '源码的 SCHEMA_VERSION 应当从迁移清单推导');

if (publishing) assertDesktopClosed();

/** 用户真实库的 mtime —— 全程不能变（证明我们没碰它） */
const realMtime = REAL_HOME !== null && existsSync(join(REAL_HOME, 'alkaid.db')) ? statSync(join(REAL_HOME, 'alkaid.db')).mtimeMs : null;

// ① 造一个**v13 形态**的临时库：用打包版（v13）的 schema 建，再塞两条会话与若干消息。
const home = mkdtempSync(join(tmpdir(), 'alkaid-release-v16-'));
mkdirSync(join(home, 'empty-plugins'));

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

let child;
async function stop() {
  if (child === undefined) return;
  const owned = child;
  child = undefined;
  if (owned.exitCode !== null) return;
  const exit = once(owned, 'exit');
  owned.kill();
  await exit;
}

async function boot(program, expectSchema, stage) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  child = spawn(binary, [join(program, 'src/main.ts')], {
    cwd: program,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ALKAID_HOME: home,
      ALKAID_PORT: String(port),
      ALKAID_PLUGINS: join(home, 'empty-plugins'),
    },
  });

  let health;
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) throw new Error(`${stage}: 内核进程提前退出（code=${String(child.exitCode)}）`);
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await delay(100);
  }
  assert.ok(health !== undefined, `${stage}: 起不来`);
  assert.equal(health.schemaVersion, expectSchema, `${stage}: schema 应为 ${String(expectSchema)}，实际 ${String(health.schemaVersion)}`);

  async function request(path, method = 'GET', body, status = 200) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, status, `${stage} ${path}: ${text.slice(0, 200)}`);
    return text.length === 0 ? null : JSON.parse(text);
  }

  return { url, health, request };
}

async function sync(mode) {
  const proc = spawn(process.execPath, [join(root, 'scripts/sync-release-safe.mjs'), mode], { cwd: root, stdio: 'inherit' });
  const [code] = await once(proc, 'exit');
  assert.equal(code, 0, `sync ${mode} 失败`);
}

const stages = [];

try {
  /**
   * ★★ 两段式设计（这一点很容易做错）：**两种模式都要真的验**，区别只在"新程序是谁"。
   *
   * - **发布前（不带 `--publish`）**：新程序 = **源码**（用打包版自带的 Node 跑 `src/main.ts`）。
   *   这一步证明"迁移逻辑本身是对的"，但**不动打包版一个字节** —— 所以随时可以跑，
   *   失败也只是白跑一次，不会留下半发布的程序。
   * - **发布时（带 `--publish`）**：新程序 = **打包版**，并且额外跑 rollback/reapply 三段。
   *
   * 基线库一律由**打包版（v13）**建 —— 那是"用户现在库的样子"的唯一可信来源
   * （我们没法凭源码造出一个 v13 形态的库而不撒谎）。
   */
  const baseline = await boot(packaged, 13, 'baseline-v13');
  const provider = await baseline.request(
    '/api/providers',
    'POST',
    {
      name: '离线验收模型（不计费）',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'offline-placeholder-not-real',
      defaultModel: 'offline',
    },
    201,
  );
  const a = await baseline.request('/api/conversations', 'POST', { providerId: provider.id, model: 'offline' }, 201);
  const b = await baseline.request('/api/conversations', 'POST', { providerId: provider.id, model: 'offline' }, 201);
  await baseline.request(`/api/conversations/${a.id}`, 'PATCH', { title: '验收 A' });
  await baseline.request(`/api/conversations/${b.id}`, 'PATCH', { title: '验收 B' });

  /**
   * ★★ 必须**真的往库里塞消息**，否则"迁移不丢数据"这条等于没验。
   *
   * 第一版我就漏了：只建了会话，`messages` 是 0，于是
   * `assert.equal(counts.messages, baselineCounts.messages)` 变成 `0 === 0` ——
   * **空库对空库，永远真**。这类"拿空集当通过"的坑本项目已经踩过一次
   * （零继承测试断言 `[] === []`），所以这里直接往消息表写几条**形态真实**的记录：
   * 用户消息、带 tool_calls 的 assistant、配对的 tool 回复 —— 三种角色都覆盖，
   * 因为迁移最容易伤到的就是"带结构化字段的老行"。
   */
  await seedMessages(home, a.id);

  await stop();

  const baselineCounts = await readCounts();
  assert.ok(baselineCounts.conversations >= 2, '基线库没建出会话');
  assert.equal(baselineCounts.version, 13, '基线库应当是 v13');
  assert.ok(baselineCounts.messages >= 4, '基线库没有消息 —— 那样"迁移不丢数据"会变成空对空的假通过');
  stages.push({ stage: 'baseline-v13', schema: 13, ...baselineCounts });

  /** 验"新程序读旧库"：这一段两种模式都用，只是程序路径不同 */
  async function verifyUpgrade(program, label) {
    const upgraded = await boot(program, 16, label);
    const counts = await readCounts();
    assert.equal(counts.conversations, baselineCounts.conversations, `${label}: 迁移把会话弄丢了`);
    assert.equal(counts.messages, baselineCounts.messages, `${label}: 迁移把消息弄丢了`);
    assert.equal(counts.version, 16, `${label}: 迁移没到位`);

    // 新能力真的可用（不是"表建了但端点没接"）
    const board = await upgraded.request(`/api/conversations/${a.id}/delegations`);
    assert.equal(board.parentConversationId, a.id);
    assert.deepEqual(board.entries, []);
    const settings = await upgraded.request('/api/settings');
    assert.equal(settings.general.delegateAllowedModels, null, '子代理设置没读到默认值');
    assert.equal(settings.general.delegateAllowParentModel, true);
    const titles = await upgraded.request('/api/conversations');
    assert.ok(Array.isArray(titles) && titles.some((item) => item.title === '验收 A'), '旧会话读不出来');
    await stop();
    stages.push({ stage: label, schema: 16, ...counts, delegationBoard: 'ok', delegateSettings: 'ok', oldDataReadable: true });
  }

  if (publishing) {
    // ① deploy → 打包版变成 v16，读旧库
    await sync('deploy');
    await verifyUpgrade(packaged, 'deployed-v16');

    // ② rollback → 旧程序（v13 代码）读**已被升到 v16 的库**：必须能起、能读旧数据
    await sync('rollback');
    /**
     * ★★ 关键认知：**库不会跟着程序回退**。
     *
     * 第一次写这条时我断言"回退后 schema 是 13"，结果红了 —— 因为迁移是**加法且不可逆**的：
     * 程序换回 v13，但库已经是 v16 了。这正是本项目"库只加不删、不降级"的承诺在起作用。
     *
     * ⇒ 正确的判据是：**v13 的程序读 v16 的库要能起、能读旧数据**（多出来的表它不认识，
     *   但它只查自己认识的那几张，所以照常工作）。这也正是"回退是安全的"这句话的实际含义。
     */
    const rolled = await boot(packaged, 16, 'rollback-v13-program-on-v16-data');
    const afterRollback = await readCounts();
    assert.equal(afterRollback.conversations, baselineCounts.conversations, '回退后会话对不上（数据被降级删除了？）');
    assert.equal(afterRollback.messages, baselineCounts.messages, '回退后消息对不上');
    const rollbackTitles = await rolled.request('/api/conversations');
    assert.ok(Array.isArray(rollbackTitles) && rollbackTitles.length >= 2, '旧程序读不出旧会话');
    stages.push({
      stage: 'rollback-v13-program-on-v16-data',
      programSchema: 13,
      dataSchema: afterRollback.version,
      ...afterRollback,
      dataPreserved: true,
    });
    await stop();

    // ③ reapply → 再换回新程序，一切照旧
    await sync('reapply');
    await verifyUpgrade(packaged, 'reapplied-v16');
  } else {
    // 发布前：用**源码**当"新程序"，不动打包版
    await verifyUpgrade(root, 'source-v16-on-v13-data');
  }

  // ★ 反证：用户真实库全程没被碰过
  if (realMtime !== null) {
    const now = statSync(join(REAL_HOME, 'alkaid.db')).mtimeMs;
    assert.equal(now, realMtime, '用户真实库被改动了 —— 这不该发生（全程用的是临时家）');
  }

  const report = {
    verifiedAt: new Date().toISOString(),
    binary,
    published: publishing,
    fromSchema: 13,
    toSchema: 16,
    newProgram: publishing ? 'packaged' : 'source',
    stages,
    realUserHomeUntouched: true,
    note: 'All stages run the real packaged runtime against an isolated temporary home. No paid model, no user data.',
  };
  const output = resolve(root, publishing ? '../docs/验收-发布-v16.json' : '../docs/验收-发布-v16-隔离.json');
  writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ verified: true, ...report, output }));
} finally {
  await stop();
  assert.ok(resolve(home).startsWith(resolve(tmpdir(), 'alkaid-release-v16-')));
  rmSync(home, { recursive: true, force: true });
}

/** 直接读临时库的行数（不起服务）：迁移有没有丢数据，这里最直接 */
async function readCounts() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(home, 'alkaid.db'), { readOnly: true });
  try {
    const conversations = Number(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n);
    const messages = Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);
    const version = Number(db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get().v);
    return { conversations, messages, version };
  } finally {
    db.close();
  }
}

/**
 * 往基线库塞几条**形态真实**的消息（三种角色都覆盖）。
 *
 * ★ 为什么不用 HTTP 的 `/messages`：那会真的去调模型（这里没有模型）。
 *   直接写库在"迁移验收"里是正当的 —— 我们要验的是**迁移**对既有行做了什么，
 *   不是"发消息这条链路通不通"（那是别的测试的事）。
 */
async function seedMessages(homeDir, conversationId) {
  const { DatabaseSync } = await import('node:sqlite');
  const { randomUUID } = await import('node:crypto');
  const db = new DatabaseSync(join(homeDir, 'alkaid.db'));
  try {
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, role, content, reasoning, tool_calls, tool_call_id, usage, finish_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    insert.run(randomUUID(), conversationId, 1, 'user', '把旧 API 改掉', null, null, null, null, null, now);
    insert.run(
      randomUUID(),
      conversationId,
      2,
      'assistant',
      null,
      'think',
      JSON.stringify([{ id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' }]),
      null,
      JSON.stringify({ input: 10, output: 5 }),
      'tool_calls',
      now,
    );
    insert.run(randomUUID(), conversationId, 3, 'tool', '{"ok":true,"content":"文件内容"}', null, null, 'call-1', null, null, now);
    insert.run(randomUUID(), conversationId, 4, 'assistant', '改完了', null, null, null, JSON.stringify({ input: 20, output: 8 }), 'stop', now);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

// 让 lint 满意：copyFileSync 暂未用（留作将来备份库副本）
void copyFileSync;
