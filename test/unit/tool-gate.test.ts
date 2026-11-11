import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDatabase } from '../../src/core/store/db.ts';
import { migrate, SCHEMA_VERSION } from '../../src/core/store/schema.ts';
import { insertConversation, insertProvider } from '../../src/core/store/repo.ts';
import { setToolMode } from '../../src/core/tools/settings.ts';
import {
  applyToolTemplateToConversation, applyToolTemplateToGlobal, clearAllConversationToolModes,
  clearConversationToolMode, createToolTemplate, deleteToolTemplate, effectiveToolModes,
  listConversationToolModes, listToolTemplates, setConversationToolMode, setDefaultToolTemplate,
  snapshotModes,
} from '../../src/core/tools/gate.ts';

/**
 * 工具门控（v18）的两层合并与模板。
 *
 * ★ 这些断言针对的是**行为**，不是"表存在"：
 *   - 会话覆盖必须**压过**全局；
 *   - 删掉覆盖必须**回到**全局（这条最容易写错成"回到代码默认"）；
 *   - 模板套用必须是**整份覆盖**（包括把改过的工具搬回去）。
 */

function fresh() {
  const db = openDatabase(':memory:');
  migrate(db);
  const provider = insertProvider(db, {
    name: 'p', baseUrl: 'http://127.0.0.1:9/v1', kind: 'openai_compatible', defaultModel: 'm',
  });
  const conversation = insertConversation(db, { providerId: provider.id, model: 'm', title: 't' });
  return { db, conversationId: conversation.id };
}

test('v18 迁移把库升到最新，并建出两张新表', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  assert.equal(SCHEMA_VERSION, 19);
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((row) => row.name);
  assert.ok(names.includes('conversation_tool_settings'));
  assert.ok(names.includes('tool_templates'));
});

test('会话覆盖压过全局；删掉覆盖回到全局而不是回到代码默认', () => {
  const { db, conversationId } = fresh();
  setToolMode(db, 'read', 'lazy');
  setConversationToolMode(db, conversationId, 'read', 'disabled');

  assert.equal(effectiveToolModes(db).get('read'), 'lazy', '只有全局时就是全局值');
  assert.equal(effectiveToolModes(db, conversationId).get('read'), 'disabled', '会话覆盖必须赢');

  clearConversationToolMode(db, conversationId, 'read');
  assert.equal(
    effectiveToolModes(db, conversationId).get('read'),
    'lazy',
    '删掉覆盖应回落到全局（lazy），而不是代码默认',
  );
});

test('不同会话的覆盖互不影响；清空只清自己那个', () => {
  const { db, conversationId } = fresh();
  const provider = insertProvider(db, {
    name: 'p2', baseUrl: 'http://127.0.0.1:9/v1', kind: 'openai_compatible', defaultModel: 'm',
  });
  const other = insertConversation(db, { providerId: provider.id, model: 'm', title: 'o' });

  setConversationToolMode(db, conversationId, 'read', 'disabled');
  setConversationToolMode(db, other.id, 'read', 'resident');

  assert.equal(effectiveToolModes(db, conversationId).get('read'), 'disabled');
  assert.equal(effectiveToolModes(db, other.id).get('read'), 'resident');

  const cleared = clearAllConversationToolModes(db, conversationId);
  assert.equal(cleared, 1);
  assert.equal(listConversationToolModes(db, conversationId).size, 0);
  assert.equal(effectiveToolModes(db, other.id).get('read'), 'resident', '另一个会话不受影响');
});

test('非法 mode 被拒，不会写库', () => {
  const { db, conversationId } = fresh();
  assert.throws(() => setConversationToolMode(db, conversationId, 'read', 'nope' as never), /非法工具模式/);
  assert.equal(listConversationToolModes(db, conversationId).size, 0);
});

test('模板：存快照 → 整份套到会话（含把改过的搬回去）', () => {
  const { db, conversationId } = fresh();
  setToolMode(db, 'read', 'lazy');
  setToolMode(db, 'write', 'disabled');
  const template = createToolTemplate(db, '基础套', snapshotModes(db));
  assert.equal(template.modes['read'], 'lazy');
  assert.equal(template.modes['write'], 'disabled');

  // 之后用户把 read 改成 resident
  setToolMode(db, 'read', 'resident');
  assert.equal(effectiveToolModes(db).get('read'), 'resident');

  const changed = applyToolTemplateToConversation(db, conversationId, template.id);
  assert.equal(changed, 2);
  assert.equal(effectiveToolModes(db, conversationId).get('read'), 'lazy', '模板套用要覆盖会话层的现值');
  assert.equal(effectiveToolModes(db).get('read'), 'resident', '套到会话不该改全局');
});

test('模板：套到全局会改全局；重名报错；删掉后取不到', () => {
  const { db } = fresh();
  setToolMode(db, 'read', 'lazy');
  const template = createToolTemplate(db, '全局套', { read: 'disabled', write: 'resident' });

  assert.throws(() => createToolTemplate(db, '全局套', { read: 'lazy' }), /UNIQUE|unique/i);

  applyToolTemplateToGlobal(db, template.id);
  assert.equal(effectiveToolModes(db).get('read'), 'disabled');
  assert.equal(effectiveToolModes(db).get('write'), 'resident');

  assert.equal(deleteToolTemplate(db, template.id), true);
  assert.equal(listToolTemplates(db).length, 0);
});

test('默认模板只有一个（部分唯一索引兜底）', () => {
  const { db } = fresh();
  const first = createToolTemplate(db, 'A', { read: 'lazy' });
  const second = createToolTemplate(db, 'B', { read: 'resident' });

  setDefaultToolTemplate(db, first.id);
  assert.equal(listToolTemplates(db).find((item) => item.isDefault)?.id, first.id);

  setDefaultToolTemplate(db, second.id);
  const defaults = listToolTemplates(db).filter((item) => item.isDefault);
  assert.equal(defaults.length, 1, '任意时刻只能有一个默认模板');
  assert.equal(defaults[0]?.id, second.id);
});

test('模板名去空白后为空要报错；过长也报错', () => {
  const { db } = fresh();
  assert.throws(() => createToolTemplate(db, '   ', { read: 'lazy' }), /不能为空/);
  assert.throws(() => createToolTemplate(db, 'x'.repeat(41), { read: 'lazy' }), /过长/);
});
