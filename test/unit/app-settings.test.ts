import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { deleteProjectSettings, getGeneralSettings, getPanelSettings, setGeneralSettings, setPanelSettings } from '../../src/core/settings/service.ts';
import { openDatabase } from '../../src/core/store/db.ts';
import { insertProject } from '../../src/core/store/repo.ts';
import { migrate } from '../../src/core/store/schema.ts';
import { DEFAULT_GENERAL, normalizeGeneral, normalizePanel } from '../../src/shared/settings.ts';

/**
 * 应用设置（`app_settings`）。
 *
 * ★ 这一批测试直接对应 2026-11-09 用户报的 bug：
 *   「每次更新我自己做好的设置就没了」—— 真因不是更新，而是**桌面壳每次启动换随机端口**
 *   ⇒ 前端 origin 每次都变 ⇒ `localStorage` 每次重启归零。
 *   设置搬到服务端后，判据变成：「**关掉进程重新打开同一份库，设置还在**」。
 *   下面第三条就是这条判据的可执行版本。
 */

function withDb(run: (db: ReturnType<typeof openDatabase>, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-settings-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  try {
    run(db, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('★ 设置写进库后，重开数据库仍然在（这是"重启就丢"的直接反证）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alkaid-settings-persist-'));
  const path = join(dir, 'test.db');
  try {
    const first = openDatabase(path);
    migrate(first);
    setGeneralSettings(first, { maxStepsPerTurn: null, maxToolOutputChars: null, defaultContextWindow: 500_000 });
    setPanelSettings(first, null, { visibleTabs: ['work'], width: 456 });
    first.close();

    // 模拟"关掉应用再打开"：全新连接、同一个库文件
    const second = openDatabase(path);
    migrate(second);
    const general = getGeneralSettings(second);
    const panel = getPanelSettings(second, null);
    second.close();

    assert.equal(general.maxStepsPerTurn, null, '关闭的步数上限必须能留存（null 是合法值，不是"没设"）');
    assert.equal(general.maxToolOutputChars, null, '关闭的输出上限必须能留存');
    assert.equal(general.defaultContextWindow, 500_000);
    assert.deepEqual(panel.visibleTabs, ['work']);
    assert.equal(panel.width, 456);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('通用设置：合并式写入、非法值回落、`null` 与数字语义分开', () => {
  withDb((db) => {
    // 只改一个字段，其余保持
    const patched = setGeneralSettings(db, { defaultContextWindow: 250_000 });
    assert.equal(patched.defaultContextWindow, 250_000);
    assert.equal(patched.maxStepsPerTurn, DEFAULT_GENERAL.maxStepsPerTurn, '没传的字段不该被重置');

    // 非法值一律回落默认，不写坏
    const restored = setGeneralSettings(db, { maxStepsPerTurn: '不是数字', defaultPermissionMode: 'nope' });
    assert.equal(restored.maxStepsPerTurn, DEFAULT_GENERAL.maxStepsPerTurn);
    assert.equal(restored.defaultPermissionMode, DEFAULT_GENERAL.defaultPermissionMode);

    // null = 不限制（与"数字上限"是两件事）
    assert.equal(setGeneralSettings(db, { maxStepsPerTurn: null }).maxStepsPerTurn, null);
    assert.equal(setGeneralSettings(db, { maxStepsPerTurn: 120 }).maxStepsPerTurn, 120);
    // 超过硬上限被夹住
    assert.equal(setGeneralSettings(db, { maxStepsPerTurn: 999_999 }).maxStepsPerTurn, 1000);
  });
});

test('右栏设置：项目与"无项目"互不影响，删除项目要清掉它的设置行', () => {
  withDb((db) => {
    const project = insertProject(db, { id: 'p1', name: 'P1', description: null, sharedDir: '/tmp/p1' });

    // 全局：只留工作
    setPanelSettings(db, null, { visibleTabs: ['work'], width: 456 });
    assert.deepEqual(getPanelSettings(db, null).visibleTabs, ['work']);

    /**
     * ★ 没设过的项目**不继承全局**，用 DEFAULT_PANEL 四个页签全开。
     *   实测踩到的坑：全局那份读出来已经按"无项目"过滤成只剩工作/日志，
     *   一旦让项目继承它，**每个项目都只显示两个页签**。
     */
    assert.deepEqual(
      getPanelSettings(db, project.id).visibleTabs,
      ['work', 'memory', 'logs', 'principles'],
      '项目默认应为四项全开，而不是继承无项目那份',
    );
    assert.notEqual(getPanelSettings(db, project.id).width, 456, '宽度也不该被全局那份带偏');

    // 项目自己设过 ⇒ 用项目自己的
    setPanelSettings(db, project.id, { visibleTabs: ['work', 'memory'], defaultTab: 'memory' });
    assert.deepEqual(getPanelSettings(db, project.id).visibleTabs, ['work', 'memory']);
    assert.equal(getPanelSettings(db, project.id).defaultTab, 'memory');
    // 全局不受影响
    assert.deepEqual(getPanelSettings(db, null).visibleTabs, ['work']);

    deleteProjectSettings(db, project.id);
    assert.deepEqual(
      getPanelSettings(db, project.id).visibleTabs,
      ['work', 'memory', 'logs', 'principles'],
      '删项目设置后回到默认四项',
    );
  });
});

test('无项目对话不允许出现项目域页签（台账/原则）', () => {
  withDb((db) => {
    // 强行把台账与原则存进"无项目"作用域 ⇒ 读的时候必须被过滤掉
    setPanelSettings(db, null, { visibleTabs: ['work', 'memory', 'logs', 'principles'], defaultTab: 'memory' });
    const panel = getPanelSettings(db, null);
    assert.deepEqual(panel.visibleTabs, ['work', 'logs'], '无项目只允许 工作/日志');
    assert.equal(panel.defaultTab, 'work', '默认页签落到仍在可见集合里的那个');
  });
});

test('normalizePanel：一个都不勾时不留空面板', () => {
  assert.deepEqual(normalizePanel({ visibleTabs: [] }).visibleTabs, ['work', 'memory', 'logs', 'principles']);
  assert.deepEqual(normalizePanel({ visibleTabs: [] }, ['work', 'logs']).visibleTabs, ['work', 'logs']);
  // 越界宽度被夹住
  assert.equal(normalizePanel({ width: 10 }).width >= 304, true);
  assert.equal(normalizePanel({ width: 99_999 }).width <= 1200, true);
  // 默认页签不在可见集合 ⇒ 退到第一个可见
  assert.equal(normalizePanel({ visibleTabs: ['logs'], defaultTab: 'work' }).defaultTab, 'logs');
});

test('normalizeGeneral：权限与思考强度只接受白名单值', () => {
  assert.equal(normalizeGeneral({ defaultPermissionMode: 'full' }).defaultPermissionMode, 'full');
  assert.equal(normalizeGeneral({ defaultPermissionMode: 'admin' }).defaultPermissionMode, 'workspace');
  assert.equal(normalizeGeneral({ defaultThinkingEffort: 'high' }).defaultThinkingEffort, 'high');
  assert.equal(normalizeGeneral({ defaultThinkingEffort: 'max' }).defaultThinkingEffort, 'default');
});
