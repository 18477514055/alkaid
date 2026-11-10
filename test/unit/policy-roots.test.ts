import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rootsFor } from '../../src/core/policy/roots.ts';

const WS = 'C:/work/demo';
const SHARED = 'C:/data/projects/p1/shared';

test('五档权限的授权根矩阵（工作区 / 项目共享 / 任意路径）', () => {
  const table = {
    readonly: { readable: [WS, SHARED], writable: [], anywhere: false },
    workspace: { readable: [WS, SHARED], writable: [WS], anywhere: false },
    project: { readable: [WS, SHARED], writable: [SHARED], anywhere: false },
    workspace_project: { readable: [WS, SHARED], writable: [WS, SHARED], anywhere: false },
    full: { readable: [WS, SHARED], writable: [WS, SHARED], anywhere: true },
  } as const;

  for (const [mode, expected] of Object.entries(table)) {
    assert.deepEqual(rootsFor(mode as keyof typeof table, WS, SHARED), expected, `模式 ${mode} 的根不对`);
  }
});

test('没有工作区 / 没有项目时，根集合跟着缩（不是给个空串当根）', () => {
  assert.deepEqual(rootsFor('workspace', null, SHARED), {
    readable: [SHARED],
    writable: [],
    anywhere: false,
  });
  assert.deepEqual(rootsFor('workspace', WS, null), {
    readable: [WS],
    writable: [WS],
    anywhere: false,
  });
  assert.deepEqual(rootsFor('readonly', null, null), { readable: [], writable: [], anywhere: false });
});
