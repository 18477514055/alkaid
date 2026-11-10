import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { rootsFor } from '../../src/core/policy/roots.ts';
import type { PermissionMode } from '../../src/core/policy/mode.ts';
import { createFsTools } from '../../src/core/tools/fs.ts';
import { ToolRegistry, type ToolContext } from '../../src/core/tools/types.ts';

/**
 * 文件工具的真机测试：真目录、真文件、真读写。
 * 重点不是"能读能写"，而是**越权时必须真的被拒、且文件确实没被创建**。
 */

const registry = new ToolRegistry();
for (const tool of createFsTools()) registry.register(tool);

const [readTool, writeTool, editTool, globTool, grepTool] = createFsTools();

type Env = { root: string; ws: string; shared: string; outside: string };

function makeEnv(): Env {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'alkaid-fs-')));
  const ws = join(root, 'ws');
  const shared = join(root, 'shared');
  const outside = join(root, 'outside');
  for (const dir of [ws, shared, outside]) mkdirSync(dir, { recursive: true });
  return { root, ws, shared, outside };
}

function ctxFor(env: Env, mode: PermissionMode): ToolContext {
  return {
    conversationId: 'c1',
    permissionMode: mode,
    roots: rootsFor(mode, env.ws, env.shared),
    workspacePath: env.ws,
    projectSharedDir: env.shared,
    cwd: env.ws,
    tempDir: join(env.root, 'tmp'),
    signal: new AbortController().signal,
  };
}

async function run(tool: { execute: (args: unknown, ctx: ToolContext) => Promise<unknown> }, args: unknown, ctx: ToolContext) {
  return (await tool.execute(args, ctx)) as
    | { ok: true; content: string }
    | { ok: false; code: string; message: string; hint?: string };
}

test('read：带行号、支持 offset/limit', async () => {
  const env = makeEnv();
  const ctx = ctxFor(env, 'workspace');
  writeFileSync(join(env.ws, 'a.txt'), '第一行\n第二行\n第三行\n', 'utf8');

  try {
    const all = await run(readTool!, { path: 'a.txt' }, ctx);
    assert.equal(all.ok, true);
    if (all.ok) {
      assert.match(all.content, /1\s+第一行/);
      assert.match(all.content, /3\s+第三行/);
    }

    const part = await run(readTool!, { path: 'a.txt', offset: 2, limit: 1 }, ctx);
    assert.equal(part.ok, true);
    if (part.ok) {
      assert.match(part.content, /第二行/);
      assert.doesNotMatch(part.content, /第一行/);
    }
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('write：建文件、建父目录', async () => {
  const env = makeEnv();
  const ctx = ctxFor(env, 'workspace');
  try {
    const result = await run(writeTool!, { path: 'sub/dir/note.txt', content: '内容' }, ctx);
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(env.ws, 'sub/dir/note.txt'), 'utf8'), '内容');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('★ 越权写入必须真被拒，且文件确实不存在（不能只信返回值）', async () => {
  const env = makeEnv();
  const ctx = ctxFor(env, 'workspace');
  const target = join(env.outside, 'pwn.txt');
  try {
    const denied = await run(writeTool!, { path: target, content: '不该写进去' }, ctx);
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.code, 'denied_by_policy');
      assert.ok(typeof denied.hint === 'string' && denied.hint.length > 0);
    }
    assert.equal(existsSync(target), false, '被拒的写入居然真的落盘了');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('edit：唯一命中才改；找不到/有歧义都明确报错', async () => {
  const env = makeEnv();
  const ctx = ctxFor(env, 'workspace');
  const file = join(env.ws, 'e.txt');
  writeFileSync(file, 'alpha\nbeta\nalpha\n', 'utf8');
  try {
    const ambiguous = await run(editTool!, { path: 'e.txt', old_string: 'alpha', new_string: 'A' }, ctx);
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) assert.equal(ambiguous.code, 'old_string_not_unique');

    const missing = await run(editTool!, { path: 'e.txt', old_string: 'gamma', new_string: 'G' }, ctx);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'old_string_not_found');

    const ok = await run(editTool!, { path: 'e.txt', old_string: 'beta', new_string: 'BETA' }, ctx);
    assert.equal(ok.ok, true);
    assert.equal(readFileSync(file, 'utf8'), 'alpha\nBETA\nalpha\n');

    const all = await run(editTool!, { path: 'e.txt', old_string: 'alpha', new_string: 'A', replace_all: true }, ctx);
    assert.equal(all.ok, true);
    assert.equal(readFileSync(file, 'utf8'), 'A\nBETA\nA\n');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('glob：能找到文件、跳过 node_modules；grep：找内容、可被 glob 过滤', async () => {
  const env = makeEnv();
  const ctx = ctxFor(env, 'workspace');
  mkdirSync(join(env.ws, 'src'), { recursive: true });
  mkdirSync(join(env.ws, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(env.ws, 'src', 'a.ts'), 'export const needle = 1;\n', 'utf8');
  writeFileSync(join(env.ws, 'src', 'b.md'), 'nothing here\n', 'utf8');
  writeFileSync(join(env.ws, 'node_modules', 'pkg', 'c.ts'), 'export const needle = 2;\n', 'utf8');

  try {
    const globbed = await run(globTool!, { pattern: '**/*.ts' }, ctx);
    assert.equal(globbed.ok, true);
    if (globbed.ok) {
      assert.match(globbed.content, /src\/a\.ts/);
      assert.doesNotMatch(globbed.content, /node_modules/, '不该扫进 node_modules');
    }

    const found = await run(grepTool!, { pattern: 'needle', glob: '**/*.ts' }, ctx);
    assert.equal(found.ok, true);
    if (found.ok) {
      assert.match(found.content, /src\/a\.ts:1:/);
      assert.doesNotMatch(found.content, /node_modules/);
    }

    const none = await run(grepTool!, { pattern: '绝对不存在的串xyz' }, ctx);
    assert.equal(none.ok, true);
    if (none.ok) assert.match(none.content, /没有匹配/);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('只读档：能读、不能写（写被拒且文件不存在）', async () => {
  const env = makeEnv();
  const ctx = ctxFor(env, 'readonly');
  writeFileSync(join(env.ws, 'r.txt'), '只读内容', 'utf8');
  try {
    const read = await run(readTool!, { path: 'r.txt' }, ctx);
    assert.equal(read.ok, true);

    const write = await run(writeTool!, { path: 'r.txt', content: '改掉' }, ctx);
    assert.equal(write.ok, false);
    assert.equal(readFileSync(join(env.ws, 'r.txt'), 'utf8'), '只读内容', '只读档的文件被改了');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('§11 测试四（工具级）：同一项目的两个对话，A 写共享目录、B 读到', async () => {
  const env = makeEnv();
  // A、B 用不同工作区，但共享同一个项目共享目录
  const wsB = join(env.root, 'ws-b');
  mkdirSync(wsB, { recursive: true });

  const ctxA = ctxFor(env, 'workspace_project');
  const ctxB: ToolContext = { ...ctxFor(env, 'workspace_project'), conversationId: 'c2', workspacePath: wsB, cwd: wsB, roots: rootsFor('workspace_project', wsB, env.shared) };

  try {
    const written = await run(writeTool!, { path: join(env.shared, 'shared-note.txt'), content: '对话 A 写的' }, ctxA);
    assert.equal(written.ok, true);

    const readByB = await run(readTool!, { path: join(env.shared, 'shared-note.txt') }, ctxB);
    assert.equal(readByB.ok, true);
    if (readByB.ok) assert.match(readByB.content, /对话 A 写的/);

    // B 的工作区只有自己那份：A 工作区里的文件 B 读不到（项目共享 ≠ 共享彼此工作区）
    writeFileSync(join(env.ws, 'a-only.txt'), 'A 私有', 'utf8');
    const leak = await run(readTool!, { path: join(env.ws, 'a-only.txt') }, ctxB);
    assert.equal(leak.ok, false, 'B 竟然读到了 A 工作区里的文件');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('§11 测试五：五档全枚举，越权写入一律被拒且不落盘', async () => {
  const env = makeEnv();
  const matrix: Array<{ mode: PermissionMode; ws: boolean; shared: boolean; outside: boolean }> = [
    { mode: 'readonly', ws: false, shared: false, outside: false },
    { mode: 'workspace', ws: true, shared: false, outside: false },
    { mode: 'project', ws: false, shared: true, outside: false },
    { mode: 'workspace_project', ws: true, shared: true, outside: false },
    { mode: 'full', ws: true, shared: true, outside: true },
  ];

  try {
    for (const row of matrix) {
      const ctx = ctxFor(env, row.mode);
      const targets: Array<[string, string, boolean]> = [
        ['ws', join(env.ws, `w-${row.mode}.txt`), row.ws],
        ['shared', join(env.shared, `s-${row.mode}.txt`), row.shared],
        ['outside', join(env.outside, `o-${row.mode}.txt`), row.outside],
      ];

      for (const [label, target, shouldAllow] of targets) {
        const result = await run(writeTool!, { path: target, content: 'x' }, ctx);
        assert.equal(result.ok, shouldAllow, `${row.mode} 写 ${label} 的判定与权限表不一致`);
        assert.equal(existsSync(target), shouldAllow, `${row.mode} 写 ${label}：落盘状态与判定不一致`);
        if (existsSync(target)) rmSync(target, { force: true });
      }
    }
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});
