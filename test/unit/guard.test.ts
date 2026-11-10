import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalize, checkAccess, resolveToolPath } from '../../src/core/policy/guard.ts';
import { rootsFor } from '../../src/core/policy/roots.ts';
import { normalizePath } from '../../src/core/paths.ts';

function makeDirs(): { root: string; ws: string; shared: string; outside: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'alkaid-guard-')));
  const ws = join(root, 'ws');
  const shared = join(root, 'shared');
  const outside = join(root, 'outside');
  for (const dir of [ws, shared, outside]) mkdirSync(dir, { recursive: true });
  return { root, ws, shared, outside };
}

const MODES = ['readonly', 'workspace', 'project', 'workspace_project', 'full'] as const;

test('五档 × 三个位置 × 读写的完整矩阵（这就是权限表本身）', () => {
  const { ws, shared, outside } = makeDirs();
  const expectations: Record<string, { wsR: boolean; wsW: boolean; shR: boolean; shW: boolean; outR: boolean; outW: boolean }> = {
    readonly: { wsR: true, wsW: false, shR: true, shW: false, outR: false, outW: false },
    workspace: { wsR: true, wsW: true, shR: true, shW: false, outR: false, outW: false },
    project: { wsR: true, wsW: false, shR: true, shW: true, outR: false, outW: false },
    workspace_project: { wsR: true, wsW: true, shR: true, shW: true, outR: false, outW: false },
    full: { wsR: true, wsW: true, shR: true, shW: true, outR: true, outW: true },
  };

  for (const mode of MODES) {
    const roots = rootsFor(mode, ws, shared);
    const expected = expectations[mode];
    assert.ok(expected !== undefined);

    const cases: Array<[string, string, boolean]> = [
      ['读工作区', join(ws, 'a.txt'), expected.wsR],
      ['写工作区', join(ws, 'a.txt'), expected.wsW],
      ['读项目共享', join(shared, 'b.txt'), expected.shR],
      ['写项目共享', join(shared, 'b.txt'), expected.shW],
      ['读外部', join(outside, 'c.txt'), expected.outR],
      ['写外部', join(outside, 'c.txt'), expected.outW],
    ];

    for (const [label, target, allowed] of cases) {
      const op = label.startsWith('读') ? 'read' : 'write';
      const result = checkAccess(roots, op, normalizePath(target));
      assert.equal(result.ok, allowed, `${mode} / ${label} 判定错了`);
    }
  }
});

test('.. 穿越被挡住（词法就要先拒）', () => {
  const { root, ws } = makeDirs();
  const roots = rootsFor('workspace', ws, null);
  const escaped = resolveToolPath('../outside/c.txt', ws);
  assert.ok(escaped.startsWith(normalizePath(root)));
  assert.equal(checkAccess(roots, 'write', escaped).ok, false);
});

test('★ junction 逃逸被真实路径复核挡住（CVE-2026-39861 的形状）', () => {
  const { ws, outside } = makeDirs();

  let created = false;
  try {
    symlinkSync(outside, join(ws, 'escape'), 'junction');
    created = true;
  } catch {
    // 某些环境下建不了链接（权限策略），那就跳过这条，不假装通过
    return;
  }

  if (created) {
    const roots = rootsFor('workspace', ws, null);
    const targetInside = join(ws, 'escape', 'pwn.txt');

    // 词法上它在工作区里 —— 只有真实路径复核能发现它其实指向外面
    assert.equal(checkAccess(roots, 'write', normalizePath(targetInside)).ok, false);

    const canonical = canonicalize(normalizePath(targetInside));
    assert.ok(!canonical.toLowerCase().startsWith(normalizePath(ws).toLowerCase()), 'canonicalize 没解析出真实位置');
  }
});

test('完全权限不做根限制，但仍返回规范化路径', () => {
  const { ws, outside } = makeDirs();
  const roots = rootsFor('full', ws, null);
  const result = checkAccess(roots, 'write', normalizePath(join(outside, 'x.txt')));
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.path.includes('x.txt'));
});

test('没有授权根时，读写都拒且给出可行动理由', () => {
  const roots = rootsFor('readonly', null, null);
  const result = checkAccess(roots, 'read', 'C:/whatever/a.txt');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'denied_by_policy');
    assert.match(result.message, /被拒绝/);
    assert.ok(result.hint.length > 0);
  }
});
