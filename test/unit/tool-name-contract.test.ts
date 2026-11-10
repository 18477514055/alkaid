import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WIRE_TOOL_NAME_MAX,
  WIRE_TOOL_NAME_RE,
  assertWireToolName,
  fitToolName,
  isWireToolName,
} from '../../src/shared/tool-name.ts';
import { sanitizeToolName } from '../../src/core/plugin/host.ts';
import { mcpToolName, sanitizeWireToolName } from '../../src/shared/mcp.ts';
import { ToolRegistry } from '../../src/core/tools/types.ts';
import type { ToolDefinition } from '../../src/core/tools/types.ts';

/**
 * 工具名的**线上契约**（阶段一第 1、4 条）。
 *
 * 2026-11-08 真事故：插件工具名带点号 ⇒ 上游 `^[a-zA-Z0-9_-]+$` 不匹配 ⇒
 * **每一轮请求都 400，整个应用不能用**，而网关把错误改写成 `missing role field`。
 * 那次修的是**字符集**，**长度**这个口子还开着（`p_<id>_<tool>` 能到 83 字符）。
 *
 * 这组测试钉三件事：
 * ① 长度一定截到 64；
 * ② 截断**不能造成撞名**（单纯 slice 会让工具表静默少一个）；
 * ③ 守卫在**注册点**，任何新名字来源都绕不过去。
 */

function tool(name: string): ToolDefinition {
  return {
    name,
    description: 'x',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    modes: ['full'],
    async execute() {
      return { ok: true as const, content: '{}' };
    },
  };
}

// ───────────────────────── ① 长度 ─────────────────────────

test('★ fitToolName：40 字符 id + 40 字符工具名 ⇒ 一定 ≤ 64 且合法', () => {
  const id = 'a'.repeat(40);
  const name = 'b'.repeat(40);
  const wire = fitToolName(`p_${id}_${name}`, `${id}\0${name}`);

  assert.ok(wire.length <= WIRE_TOOL_NAME_MAX, `长度必须 ≤ 64，实际 ${String(wire.length)}`);
  assert.match(wire, WIRE_TOOL_NAME_RE);
  // 前缀要保留，否则设置页与日志里认不出是哪个插件
  assert.ok(wire.startsWith('p_aaaa'), `前缀丢了：${wire}`);
});

test('★ fitToolName：不超长时**逐字不改**（名字一变 prompt cache 整段失效）', () => {
  assert.equal(fitToolName('p_demo-echo_echo'), 'p_demo-echo_echo');
  assert.equal(fitToolName('mcp_filesystem_read_file'), 'mcp_filesystem_read_file');
  // 恰好 64 也原样保留
  const exactly = 'x'.repeat(WIRE_TOOL_NAME_MAX);
  assert.equal(fitToolName(exactly), exactly);
  // 65 才截
  assert.notEqual(fitToolName('x'.repeat(WIRE_TOOL_NAME_MAX + 1)), 'x'.repeat(WIRE_TOOL_NAME_MAX + 1));
});

test('★ fitToolName：非法字符换成下划线，清洗后为空则给 unnamed', () => {
  assert.equal(fitToolName('p.demo-echo.whoami'), 'p_demo-echo_whoami');
  assert.equal(fitToolName(''), 'unnamed');
  assert.equal(fitToolName('...'), '___');
});

test('★ fitToolName 是幂等式稳定的：同输入必然同输出（否则缓存白丢）', () => {
  const id = 'i'.repeat(50);
  assert.equal(fitToolName(`p_${id}_t`, `${id}\0t`), fitToolName(`p_${id}_t`, `${id}\0t`));
});

// ───────────────────────── ② 截断不撞名 ─────────────────────────

test('★★ 两个只差末尾的工具名**截断后不许撞**（反模式：只 slice 不加哈希）', () => {
  // 前 72 字符完全相同，只差在最后 —— 保证差异落在第 64 字符**之后**
  const head = 'p_' + 'x'.repeat(70);
  const a = fitToolName(`${head}_alpha`, `${head}_alpha`);
  const b = fitToolName(`${head}_bravo`, `${head}_bravo`);

  assert.ok(a.length <= WIRE_TOOL_NAME_MAX, `长度必须 ≤ 64，实际 ${String(a.length)}`);
  assert.ok(b.length <= WIRE_TOOL_NAME_MAX);
  assert.notEqual(a, b, `截断把两个工具撞成了一个名字：${a}`);

  // 反证：单纯 slice(0,64) 确实会撞 —— 说明这条测试真的在防那件事
  assert.equal(`${head}_alpha`.slice(0, 64), `${head}_bravo`.slice(0, 64));
});

test('★★ 两个插件的 id 前 51 字符相同时，工具名也不许撞（哈希的输入是原始标识）', () => {
  const idA = `${'same-prefix-'.repeat(5)}A`;
  const idB = `${'same-prefix-'.repeat(5)}B`;
  const toolName = 'do_something_really_long_named';
  const a = fitToolName(`p_${idA}_${toolName}`, `${idA}\0${toolName}`);
  const b = fitToolName(`p_${idB}_${toolName}`, `${idB}\0${toolName}`);
  assert.notEqual(a, b);
});

test('★ 清洗后同形、原始不同（a.b vs a/b）也必须分得开', () => {
  // 如果哈希的输入是**清洗后**的串，这两个会撞
  const a = fitToolName(`p_${'z'.repeat(60)}_a.b`, 'p_zzz_a.b');
  const b = fitToolName(`p_${'z'.repeat(60)}_a/b`, 'p_zzz_a/b');
  assert.equal(a.replace(/_[0-9a-f]{12}$/, ''), b.replace(/_[0-9a-f]{12}$/, ''));
  assert.notEqual(a, b, '原始标识不同却拿到同一个后缀');
});

// ───────────────────────── ③ 注册点守卫 ─────────────────────────

test('★★ 注册一个非法名 ⇒ 抛错且**不进入**工具表', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register(tool('p.demo.echo')), /工具名不合法/);
  assert.equal(registry.has('p.demo.echo'), false, '非法工具名居然进了工具表');

  assert.throws(() => registry.register(tool('x'.repeat(65))), /超长/);
  assert.equal(registry.has('x'.repeat(65)), false);

  assert.throws(() => registry.register(tool('')), /名字为空/);

  // 合法的照常进
  registry.register(tool('p_ok_echo'));
  assert.equal(registry.has('p_ok_echo'), true);
});

test('★ 重名依然是重名（不是被长度守卫掩盖掉）', () => {
  const registry = new ToolRegistry().register(tool('dup'));
  assert.throws(() => registry.register(tool('dup')), /工具重名/);
});

test('assertWireToolName 对合法名不抛、对非法名给人话', () => {
  assert.doesNotThrow(() => assertWireToolName('read_file'));
  assert.doesNotThrow(() => assertWireToolName('a'.repeat(64)));
  assert.equal(isWireToolName('a'.repeat(64)), true);
  assert.equal(isWireToolName('a'.repeat(65)), false);
  assert.throws(() => assertWireToolName('a'.repeat(65)), /超长（65 > 64）/);
});

// ───────────────────────── ④ 两条生产者侧都接上了 ─────────────────────────

test('★ 插件侧：sanitizeToolName 保留旧语义（只做字符集）', () => {
  assert.equal(sanitizeToolName('p.demo-echo.whoami'), 'p_demo-echo_whoami');
  assert.equal(sanitizeToolName('中文名'), '___');
});

test('★ MCP 侧：短名逐字不变（历史名字不能变），长名截断且不撞', () => {
  // 短名：与改造前完全一致
  assert.equal(mcpToolName('filesystem', 'read_file'), 'mcp_filesystem_read_file');
  assert.equal(sanitizeWireToolName('mcp_x_y'), 'mcp_x_y');

  // 长名：合法 + 长度受限
  const long = mcpToolName('server'.repeat(20), 'tool'.repeat(20));
  assert.ok(long.length <= WIRE_TOOL_NAME_MAX);
  assert.match(long, WIRE_TOOL_NAME_RE);

  // 同一服务器上两个长名工具不许撞
  const head = 'mcp_' + 's'.repeat(70);
  const a = sanitizeWireToolName(`${head}_alpha`);
  const b = sanitizeWireToolName(`${head}_bravo`);
  assert.notEqual(a, b);
});
