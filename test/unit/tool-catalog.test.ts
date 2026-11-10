import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCatalog, DESCRIBE_TOOL_NAME, renderToolDefinition } from '../../src/core/tools/catalog.ts';
import { searchTools, tokenize } from '../../src/core/tools/search.ts';
import { resolveTool, ToolRegistry, type ToolDefinition, type ToolMode } from '../../src/core/tools/types.ts';

/**
 * 工具管理层的专项测试。
 *
 * ★★★ 这些测试存在的理由：过去 116 条绿只证明"工具能被正确调用且不越权"，
 *   **不证明"工具被管理"**。工具管理层没有测试 = 懒加载、三态、检索全部靠人肉保证。
 */

// ───────────────────────── 测试夹具 ─────────────────────────

/** 造一个最小可用的工具。参数故意简单 —— 被测的是管理层，不是参数校验。 */
function makeTool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `${name} 做什么。第二句不该进目录。`,
    parameters: { type: 'object', properties: { a: { type: 'string', description: 'A' } }, additionalProperties: false },
    modes: ['readonly', 'workspace', 'project', 'workspace_project', 'full'],
    async execute() {
      return { ok: true as const, content: `${name} ok` };
    },
    ...overrides,
  };
}

function registryOf(...tools: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

// ───────────────────────── 元信息默认值 ─────────────────────────

test('resolveTool：没给元信息时补出可用的默认值，而不是留 undefined', () => {
  const resolved = resolveTool(makeTool('foo'));
  assert.equal(resolved.source, 'builtin');
  assert.equal(resolved.displayName, 'foo');
  assert.equal(resolved.kind, 'read_only');
  assert.equal(resolved.preferredMode, 'resident');
  assert.equal(resolved.group, 'context');
  // ★ oneLiner 必须是**第一句**，不是整段 —— 否则目录会变回长文
  assert.equal(resolved.oneLiner, 'foo 做什么');
});

test('resolveTool：给了元信息就一律用给的，不被默认值覆盖', () => {
  const resolved = resolveTool(
    makeTool('bar', {
      source: 'plugin',
      displayName: '插件工具',
      oneLiner: 'does bar',
      preferredMode: 'lazy',
      group: 'plugin',
      kind: 'external',
    }),
  );
  assert.equal(resolved.source, 'plugin');
  assert.equal(resolved.displayName, '插件工具');
  assert.equal(resolved.oneLiner, 'does bar');
  assert.equal(resolved.preferredMode, 'lazy');
  assert.equal(resolved.group, 'plugin');
});

test('★ 使用示例拼进 fullDescription，而不是塞进 tools JSON 的新字段', () => {
  const tool = makeTool('withExample', {
    examples: [{ whenTo: 'when you need the append mode', args: { a: 'x' } }],
  });
  const resolved = resolveTool(tool);

  assert.ok(resolved.fullDescription.includes('Examples'), 'fullDescription 里应有示例段');
  assert.ok(resolved.fullDescription.includes('{"a":"x"}'), '示例必须是可直接复制的 JSON');

  // ★★★ 关键：示例**不能**变成 parameters 里的字段 —— 严格网关会 400
  assert.deepEqual(Object.keys(tool.parameters), ['type', 'properties', 'additionalProperties']);
});

test('没有示例时 fullDescription 就是原 description（不多出空段落）', () => {
  const resolved = resolveTool(makeTool('plain'));
  assert.equal(resolved.fullDescription, 'plain 做什么。第二句不该进目录。');
});

// ───────────────────────── 目录构建 ─────────────────────────

test('全员常驻时：不发 describe_tool（它描述的是空表，纯浪费）', () => {
  const registry = registryOf(makeTool('a'), makeTool('b'));
  const built = buildCatalog(registry, 'workspace', new Map());

  assert.equal(built.lazy.length, 0);
  assert.equal(built.tools.some((tool) => tool.name === DESCRIBE_TOOL_NAME), false);
  assert.deepEqual(built.resident, ['a', 'b']);
});

test('★ 有按需工具时：describe_tool 排第一，且目录里列出全部按需工具名', () => {
  const registry = registryOf(
    makeTool('resident_one'),
    makeTool('lazy_one', { preferredMode: 'lazy', oneLiner: 'first lazy' }),
    makeTool('lazy_two', { preferredMode: 'lazy', oneLiner: 'second lazy' }),
  );
  const built = buildCatalog(registry, 'workspace', new Map());

  assert.equal(built.tools[0]?.name, DESCRIBE_TOOL_NAME, 'describe_tool 必须排第一');
  const describe = built.tools[0];
  assert.ok(describe !== undefined);

  // ★★★ 目录必须在 description 里 —— 否则模型只能盲猜名字
  assert.ok(describe.description.includes('lazy_one'), '目录里必须有 lazy_one');
  assert.ok(describe.description.includes('lazy_two'), '目录里必须有 lazy_two');
  assert.ok(describe.description.includes('first lazy'), '目录里必须有它的一句话');

  // 按需工具**不能**有完整 schema
  assert.equal(built.tools.some((tool) => tool.name === 'lazy_one'), false);
});

test('★★ disabled 与 lazy 绝不混淆：关掉的工具不进目录，也不进常驻', () => {
  const registry = registryOf(
    makeTool('kept', { preferredMode: 'resident' }),
    makeTool('lazy_kept', { preferredMode: 'lazy' }),
    makeTool('turned_off', { preferredMode: 'resident' }),
  );
  const modes = new Map<string, ToolMode>([['turned_off', 'disabled']]);
  const built = buildCatalog(registry, 'workspace', modes);

  assert.deepEqual(built.disabled, ['turned_off']);
  assert.equal(built.resident.includes('turned_off'), false);
  assert.equal(built.lazy.includes('turned_off'), false);

  const describe = built.tools.find((tool) => tool.name === DESCRIBE_TOOL_NAME);
  assert.ok(describe !== undefined);
  // ★ 关掉的工具**不能**出现在目录里 —— 否则模型会"发现"它，然后反复尝试调用
  assert.equal(describe.description.includes('turned_off'), false);
});

test('用户配置能覆盖代码默认（常驻改按需、按需改常驻）', () => {
  const registry = registryOf(makeTool('a'), makeTool('b', { preferredMode: 'lazy' }));
  const built = buildCatalog(
    registry,
    'workspace',
    new Map<string, ToolMode>([
      ['a', 'lazy'],
      ['b', 'resident'],
    ]),
  );

  assert.deepEqual(built.lazy, ['a']);
  assert.deepEqual(built.resident, ['b']);
});

test('★ 权限先于配置：配置说常驻，但这一档看不见 ⇒ 一律不出现', () => {
  const registry = registryOf(makeTool('full_only', { modes: ['full'] }));
  const built = buildCatalog(registry, 'readonly', new Map([['full_only', 'resident']]));

  assert.deepEqual(built.resident, []);
  assert.deepEqual(built.lazy, []);
  assert.deepEqual(built.disabled, [], '看不见 ≠ 被关闭，两者不能混');
});

test('★★ 同样的配置必须产出同样的字节前缀（缓存纪律）', () => {
  const make = (): string =>
    JSON.stringify(
      buildCatalog(
        registryOf(
          makeTool('zeta', { preferredMode: 'lazy' }),
          makeTool('alpha'),
          makeTool('mid', { preferredMode: 'lazy' }),
        ),
        'workspace',
        new Map(),
      ).tools,
    );

  assert.equal(make(), make(), '两次构建必须逐字节相同');
});

test('没有任何可见工具时：不发 tools 字段（空数组 = 空），hasAny 为 false', () => {
  const registry = registryOf(makeTool('full_only', { modes: ['full'] }));
  const built = buildCatalog(registry, 'readonly', new Map());

  assert.equal(built.hasAny, false);
  assert.equal(built.tools.length, 0);
});

test('目录按分组聚拢，且组顺序固定（不随注册顺序变化）', () => {
  const registry = registryOf(
    makeTool('file_tool', { preferredMode: 'lazy', group: 'files' }),
    makeTool('shell_tool', { preferredMode: 'lazy', group: 'shell' }),
    makeTool('history_tool', { preferredMode: 'lazy', group: 'history' }),
  );
  const built = buildCatalog(registry, 'workspace', new Map());
  const describe = built.tools[0];
  assert.ok(describe !== undefined);

  const filesAt = describe.description.indexOf('[文件]');
  const shellAt = describe.description.indexOf('[命令]');
  const historyAt = describe.description.indexOf('[历史]');
  assert.ok(filesAt > 0 && shellAt > 0 && historyAt > 0, '三个组标题都该出现');
  assert.ok(filesAt < shellAt && shellAt < historyAt, '组顺序必须固定');
});

// ───────────────────────── 定义渲染 ─────────────────────────

test('renderToolDefinition：返回完整参数表，而不是"你可以调了"', () => {
  const resolved = resolveTool(
    makeTool('rich', {
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          mode: { type: 'string', description: '模式', enum: ['a', 'b'] },
        },
        required: ['path'],
        additionalProperties: false,
      },
    }),
  );
  const text = renderToolDefinition(resolved);

  assert.ok(text.includes('Tool: rich'));
  assert.ok(text.includes('path (string, required)'));
  assert.ok(text.includes('mode (string, optional)'));
  assert.ok(text.includes('Allowed values: a | b'));
  // ★ 懒加载工具也必须拿到示例（走同一个 fullDescription 入口）
  assert.ok(text.includes('Full description:'));
});

// ───────────────────────── 检索 ─────────────────────────

test('tokenize：下划线当分隔符（read_file 能命中 "read a file"）', () => {
  assert.deepEqual(tokenize('read_file'), ['read', 'file']);
  assert.ok(tokenize('read a file').includes('read'));
  assert.ok(tokenize('read a file').includes('file'));
});

test('★★ 停用词必须真的起作用：查询里的 a/the 不能把不相干的工具捞回来', () => {
  // 这是实测出来的坑：没有停用词表时 "download a web page" 会命中带 "for a durable fact" 的描述
  assert.equal(tokenize('a').length, 0);
  assert.equal(tokenize('the').length, 0);
  assert.equal(tokenize('please').length, 0);
  // 中文单字有实义，必须保留
  assert.deepEqual(tokenize('搜'), ['搜']);
});

test('tokenize：中文按单字切（否则一整句中文是一个巨大 token）', () => {
  assert.deepEqual(tokenize('搜索网页'), ['搜', '索', '网', '页']);
});

test('searchTools：按相关度返回，且结果确定（同分按名字）', () => {
  const docs = [
    { name: 'read_file', oneLiner: 'Read a text file from disk.' },
    { name: 'web_search', oneLiner: 'Search the web and return URLs.' },
    { name: 'save_memory', oneLiner: 'Store a durable fact about the user.' },
  ];

  const hits = searchTools(docs, 'read a file');
  assert.equal(hits[0]?.name, 'read_file', '最相关的一定排第一');

  // ★ 确定性：同样输入两次，顺序必须一样
  assert.deepEqual(
    searchTools(docs, 'search').map((hit) => hit.name),
    searchTools(docs, 'search').map((hit) => hit.name),
  );
});

test('★ searchTools：查不到就返回空，不要返回一堆不相干的', () => {
  const docs = [{ name: 'read_file', oneLiner: 'Read a text file.' }];
  assert.deepEqual(searchTools(docs, 'zzzzz'), []);
  assert.deepEqual(searchTools(docs, ''), []);
  assert.deepEqual(searchTools([], 'read'), []);
});

test('searchTools：limit 生效', () => {
  const docs = Array.from({ length: 20 }, (_, index) => ({
    name: `tool_${index}`,
    oneLiner: 'read file content',
  }));
  assert.equal(searchTools(docs, 'read file', 3).length, 3);
});

// ───────────────────────── 注册表 ─────────────────────────

test('注册表：重名直接抛错（不允许静默覆盖）', () => {
  const registry = registryOf(makeTool('dup'));
  assert.throws(() => registry.register(makeTool('dup')), /工具重名/);
});

test('★ 注册表：不可见 = 不存在，硬调回可读回执而不是抛异常', async () => {
  const registry = registryOf(makeTool('full_only', { modes: ['full'] }));
  const outcome = await registry.execute('full_only', {}, makeContext('readonly'));

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, 'tool_not_found');
    // ★ hint 里必须带可用清单，否则模型不知道怎么自纠
    assert.ok(outcome.hint !== undefined);
  }
});

test('★★ 被关闭的工具：拒绝，且理由是"关闭"不是"不存在"', async () => {
  const registry = registryOf(makeTool('off'));
  const outcome = await registry.execute('off', {}, {
    ...makeContext('workspace'),
    toolModes: new Map<string, ToolMode>([['off', 'disabled']]),
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'tool_disabled');
});

test('★★★ 按需（lazy）的工具必须能真的执行 —— 否则整个机制是死的', async () => {
  const registry = registryOf(makeTool('lazy_one', { preferredMode: 'lazy' }));
  const outcome = await registry.execute('lazy_one', {}, {
    ...makeContext('workspace'),
    toolModes: new Map<string, ToolMode>([['lazy_one', 'lazy']]),
  });

  assert.equal(outcome.ok, true, '召回成功却调不动 = 坏死的循环');
  if (outcome.ok) assert.equal(outcome.content, 'lazy_one ok');
});

test('工具抛异常时不炸主循环，变成可读失败结果', async () => {
  const registry = registryOf(
    makeTool('boom', {
      async execute() {
        throw new Error('内部炸了');
      },
    }),
  );
  const outcome = await registry.execute('boom', {}, makeContext('workspace'));

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, 'tool_crashed');
    assert.ok(outcome.message.includes('内部炸了'));
  }
});

test('★ 执行结果带 durationMs（由注册表统一测量，不由工具各自算）', async () => {
  const registry = registryOf(
    makeTool('slow', {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true as const, content: 'done' };
      },
    }),
  );
  const outcome = await registry.execute('slow', {}, makeContext('workspace'));

  assert.equal(outcome.ok, true);
  assert.ok(typeof outcome.durationMs === 'number' && outcome.durationMs >= 20, '耗时应当被测量');
});

// ───────────────────────── 夹具 ─────────────────────────

function makeContext(mode: 'readonly' | 'workspace' | 'project' | 'workspace_project' | 'full') {
  return {
    conversationId: 'c1',
    permissionMode: mode,
    // ★ Roots 的真实形状是 { readable, writable, anywhere } ——
    //   之前写成 { workspace, projectShared, temp } 会让 walkFiles 读到 undefined 而崩。
    roots: { readable: [], writable: [], anywhere: mode === 'full' },
    workspacePath: null,
    projectSharedDir: null,
    cwd: '.',
    tempDir: 'C:\\tmp',
    signal: new AbortController().signal,
  };
}
