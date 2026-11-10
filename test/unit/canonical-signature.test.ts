import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalArguments, canonicalCallSignature } from '../../src/core/agent/canonical.ts';

/**
 * 空转守卫的**签名规范化**（A2 / `D1@L639`）。
 *
 * ★ 这条测试的价值不在"排序函数对不对"，而在钉住一个**真事故的同族**：
 *   原来的签名是 `JSON.stringify(calls.map(c => [c.name, c.arguments]))`，
 *   而 `call.arguments` 是模型生成的 JSON **字符串** —— 字段顺序一变，
 *   签名就变，守卫永远数不到 3 ⇒ 空转永不触发。
 *
 *   我写 `maxSteps: null` 的行为测试时就是这么踩到的：假模型每次吐参数时换个顺序，
 *   进程真的无限循环，只能 kill。`D1@L617`（G4）记的正是这条。
 */

test('★★ 同一份参数、换个字段顺序 ⇒ 必须得到同一个签名（否则守卫形同虚设）', () => {
  const a = canonicalCallSignature([{ name: 'write', arguments: '{"path":"a.txt","content":"x"}' }]);
  const b = canonicalCallSignature([{ name: 'write', arguments: '{"content":"x","path":"a.txt"}' }]);
  assert.equal(a, b, `换序就不认得了 —— 空转守卫会被绕过：\n  ${a}\n  ${b}`);

  // 反证：旧做法确实会得到两个不同的串（说明这条测试真的在防那件事）
  const oldA = JSON.stringify([['write', '{"path":"a.txt","content":"x"}']]);
  const oldB = JSON.stringify([['write', '{"content":"x","path":"a.txt"}']]);
  assert.notEqual(oldA, oldB, '旧写法的反例不再成立，测试需要重写');
});

test('★ 嵌套对象的键也要排序（只排第一层等于没排）', () => {
  const a = canonicalArguments('{"outer":{"b":2,"a":1}}');
  const b = canonicalArguments('{"outer":{"a":1,"b":2}}');
  assert.equal(a, b);
});

test('★ 数组顺序必须保留（[1,2] 与 [2,1] 是不同的参数）', () => {
  assert.notEqual(canonicalArguments('{"xs":[1,2]}'), canonicalArguments('{"xs":[2,1]}'));
  // 数组里的对象：元素顺序不动，但元素内部的键要排序
  assert.equal(canonicalArguments('{"xs":[{"b":1,"a":2}]}'), canonicalArguments('{"xs":[{"a":2,"b":1}]}'));
});

test('★ 参数真的是不同 ⇒ 签名必须不同（不能为了"认重复"把什么都判成重复）', () => {
  assert.notEqual(
    canonicalCallSignature([{ name: 'write', arguments: '{"path":"a.txt"}' }]),
    canonicalCallSignature([{ name: 'write', arguments: '{"path":"b.txt"}' }]),
  );
  assert.notEqual(
    canonicalCallSignature([{ name: 'read', arguments: '{}' }]),
    canonicalCallSignature([{ name: 'write', arguments: '{}' }]),
  );
  // 调用次序本身有意义：[read, write] 与 [write, read] 不是同一批
  assert.notEqual(
    canonicalCallSignature([
      { name: 'read', arguments: '{}' },
      { name: 'write', arguments: '{}' },
    ]),
    canonicalCallSignature([
      { name: 'write', arguments: '{}' },
      { name: 'read', arguments: '{}' },
    ]),
  );
});

test('★ 坏 JSON 不抛：退回原文参与比较（签名函数不能在模型吐坏 JSON 时炸掉整轮）', () => {
  assert.doesNotThrow(() => canonicalArguments('{not json'));
  const broken = canonicalArguments('{not json');
  assert.equal(broken, canonicalArguments('{not json'), '同一段坏 JSON 应该稳定认出重复');
  assert.notEqual(broken, canonicalArguments('{other broken'));
  // 坏 JSON 不能被当成合法空对象（否则 "{}" 会被误判成重复调用）
  assert.notEqual(broken, canonicalArguments('{}'));
});

test('★ 空参数与 {} 等价（模型两种写法都有，不该算两次不同调用）', () => {
  assert.equal(canonicalArguments(''), canonicalArguments('{}'));
  assert.equal(canonicalArguments('   '), canonicalArguments('{}'));
});

test('★ 键排序与 locale 无关（同一份参数在不同机器上必须得到同一签名）', () => {
  // 大小写混排时 localeCompare 与 code-unit 排序可能不一致
  const mixed = canonicalArguments('{"Zeta":1,"alpha":2,"Beta":3,"ALPHA":4}');
  // 期望：按 code unit（大写字母在前）
  assert.equal(mixed, '{"ALPHA":4,"Beta":3,"Zeta":1,"alpha":2}');
});
