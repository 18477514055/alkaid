import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * 默认值应当**尽量对齐 DSH 官方端**，而不是我们另立一套。
 *
 * 依据（用户原话）：「那里很多设置默认的都可以直接复用 dsh 现在的设置，早就适应了的。」
 * DSH 真值来自 `~/.dsh/profiles/desktop/cordis.patch.yml`（本机实测，2026-11-09）：
 * - `contextBudgets.<model>: 1000000`        → 上下文窗口默认 1M
 * - `pwsh-sandbox: timeoutMs 200000`         → shell 默认超时 200s
 * - `pwsh-sandbox: maxOutputBytes 80000`     → shell 输出上限 80000
 * - `permission.defaultPreset: danger-full-access` → **这一条刻意不跟**（见下）
 *
 * ★ 这个测试用**读源码断言字面量**的方式，而不是运行时 import：
 *   前端模块是 .tsx / 依赖 React，直接 import 进 node --test 会很别扭；
 *   这里要钉的是"这几个数字是多少"，读源码最直接、失败信息也最清楚。
 */

const APP = join(import.meta.dirname, '..', '..');

/**
 * ★ 2026-11-09：默认值从 `SettingsDialog.tsx` 搬到了 `src/shared/settings.ts`
 *   （服务端要用同一套规则校验与归一化，不能前后端各写一份）。
 *   所以这两个断言改成读**新的唯一真源**；读错文件会得到"永远是 0 命中"的假绿。
 */
const SETTINGS_SRC = join(APP, 'src/shared/settings.ts');

test('前端默认上下文窗口对齐 DSH 的 1M', () => {
  const source = readFileSync(SETTINGS_SRC, 'utf8');
  assert.match(
    source,
    /defaultContextWindow:\s*1_000_000/,
    'DSH 的 contextBudgets 是 1_000_000，我们的默认值应当一致（用户早就习惯这个数）',
  );
});

test('shell 默认超时与输出上限对齐 DSH 的 200s / 80000', () => {
  const source = readFileSync(join(APP, 'src/core/tools/shell.ts'), 'utf8');
  assert.match(source, /DEFAULT_TIMEOUT_MS\s*=\s*200_000/, 'DSH pwsh-sandbox timeoutMs = 200000');
  assert.match(source, /DEFAULT_MAX_OUTPUT_CHARS\s*=\s*80_000/, 'DSH pwsh-sandbox maxOutputBytes = 80000');
});

test('权限默认值**刻意不跟 DSH**：必须是 workspace 而不是 full', () => {
  const source = readFileSync(SETTINGS_SRC, 'utf8');
  assert.match(
    source,
    /defaultPermissionMode:\s*'workspace'/,
    '本平台的权限同时决定"模型能看到哪些工具"，默认 full 等于默认放行插件工具 —— 这不是习惯问题而是安全语义差别',
  );
  assert.doesNotMatch(
    source,
    /defaultPermissionMode:\s*'(full|danger-full-access)'/,
    '不得把完全权限设成默认',
  );
});
