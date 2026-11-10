import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { sanitizeToolName } from '../../src/core/plugin/host.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import { createSurface } from '../../src/core/tools/runtime.ts';

/**
 * 工具名必须满足 OpenAI 兼容网关的字符集 `^[a-zA-Z0-9_-]+$`。
 *
 * 真事故（2026-11-08）：插件工具名曾是 `p.<插件id>.<工具名>`（点号）。装了插件之后，
 * 每一轮请求都被上游判 400：
 *   Invalid 'tools[5].***.name': string does not match pattern.
 * 而且网关经常把这条错误翻译成毫不相干的 `missing role field at line 1 column 58`，
 * 排查方向被带偏很久。⇒ 用测试把字符集钉死，任何人都不能再引入非法字符。
 */

const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

test('sanitizeToolName 只留字母数字下划线连字符', () => {
  assert.equal(sanitizeToolName('p.demo-echo.whoami'), 'p_demo-echo_whoami');
  assert.equal(sanitizeToolName('a b/c:d'), 'a_b_c_d');
  assert.equal(sanitizeToolName('中文名'), '___');
  assert.match(sanitizeToolName('p.demo-echo.whoami'), WIRE_NAME);
});

test('注册表里所有工具名（含插件前缀规则）都合法', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-toolname-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  try {
    const registry = createDefaultRegistry(db);
    // 模拟一个带点号 id 的插件工具（按新规则命名）
    registry.register({
      name: sanitizeToolName('p_demo.v2_echo'),
      description: 'x',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      modes: ['full'],
      async execute() { return { ok: true, content: '{}' }; },
    });

    const surface = createSurface(registry, 'full', new Map());
    const names = surface.tools.map((t) => t.name);
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.match(name, WIRE_NAME, `工具名 "${name}" 不符合上游字符集，会让整轮请求 400`);
    }
    // 点号已经不该出现
    assert.equal(names.some((n) => n.includes('.')), false, `工具名里不该有点号：${names.join(',')}`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
