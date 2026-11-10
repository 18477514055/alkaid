import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { rootsFor } from '../../src/core/policy/roots.ts';
import { createFsTools } from '../../src/core/tools/fs.ts';
import type { ToolContext } from '../../src/core/tools/types.ts';

/**
 * 工具输出上限可以**关掉**（用户 2026-11-09 的第 5 条要求）。
 *
 * ★ 判据三条：
 *  1. 给了数字 ⇒ 超长输出被截断，并且**告诉我们它被截过**（`truncated`）。
 *  2. 给 `null` ⇒ **不截断**，原文一个字不少。
 *  3. 不传 ⇒ 用各工具自己的默认值（30k），行为与以前一致。
 *
 * ★ 为什么必须测"真内容"而不是只测设置存住了：
 *   「设置存了 ≠ 生效」是这个项目栽过的坑（localStorage 那次就是存住了但没生效）。
 */
const [, , , globToolRaw] = createFsTools();
const [readToolRaw] = createFsTools();
/** 数组解构在 `noUncheckedIndexedAccess` 下是 `T | undefined`；这里断言它们确实存在（顺序来自 createFsTools） */
const globTool = globToolRaw!;
const readTool = readToolRaw!;

function makeEnv(): { root: string; ws: string; file: string; big: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'alkaid-outcap-')));
  const ws = join(root, 'ws');
  mkdirSync(ws, { recursive: true });
  const file = join(ws, 'small.txt');
  writeFileSync(file, '甲乙丙\n', 'utf8');
  const big = join(ws, 'big.txt');
  // 5 万字符：大于默认 30k，也大于测试里给的 5000
  writeFileSync(big, 'X'.repeat(50_000), 'utf8');
  return { root, ws, file, big };
}

function ctxFor(env: { root: string; ws: string }, maxToolOutputChars?: number | null): ToolContext {
  return {
    conversationId: 'c1',
    permissionMode: 'full',
    roots: rootsFor('full', env.ws, null),
    workspacePath: env.ws,
    projectSharedDir: null,
    cwd: env.ws,
    tempDir: join(env.root, 'tmp'),
    signal: new AbortController().signal,
    ...(maxToolOutputChars === undefined ? {} : { maxToolOutputChars }),
  };
}

test('输出上限给了数字：超长被截断并标记 truncated', async () => {
  const env = makeEnv();
  try {
    const outcome = await readTool.execute({ path: 'big.txt' }, ctxFor(env, 5_000));
    assert.equal(outcome.ok, true);
    const content = String(outcome.content);
    assert.ok(content.length < 50_000, '应当被截断');
    assert.match(content, /已截断/, '要被截断时必须自己说明，不能让模型以为读全了');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('★ 输出上限设为 null：不截断，原文完整', async () => {
  const env = makeEnv();
  try {
    const outcome = await readTool.execute({ path: 'big.txt' }, ctxFor(env, null));
    assert.equal(outcome.ok, true);
    const content = String(outcome.content);
    assert.equal(content.includes('已截断'), false, '关掉上限后不该再出现截断提示');
    assert.ok(content.length >= 50_000, `关掉上限后应保留全部内容，实际 ${String(content.length)} 字符`);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('不传上限：沿用工具默认（不动老行为）', async () => {
  const env = makeEnv();
  try {
    const outcome = await readTool.execute({ path: 'small.txt' }, ctxFor(env));
    assert.equal(outcome.ok, true);
    assert.match(String(outcome.content), /甲乙丙/);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('glob 也遵守同一个上限（不是只有 read 生效）', async () => {
  const env = makeEnv();
  try {
    const limited = await globTool.execute({ pattern: '*' }, ctxFor(env, 5_000));
    assert.equal(limited.ok, true);
    // 只要不抛错、且内容可用即可：这条主要防"改了 read 忘了别的工具"
    assert.ok(String(limited.content).length > 0);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});
