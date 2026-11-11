import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { rootsFor } from '../../src/core/policy/roots.ts';
import { createDefaultRegistry } from '../../src/core/tools/index.ts';
import type { ToolContext } from '../../src/core/tools/types.ts';

/**
 * shell 在**工作区档**下的行为（V0.2 新增能力）。
 *
 * 这是"把 shell 从完全权限档放开"的验收：
 * ① 工作区档能看到 pwsh（可见性即权限）；
 * ② 能写工作区；
 * ③ **写工作区外被拒绝，且文件确实不存在**（只信磁盘）；
 * ④ 完全权限档不变（不需要沙箱，走原生 spawn）。
 */

function makeWorkspace(): { root: string; workspace: string; outside: string; tempDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'alkaid-shell-sbx-'));
  const workspace = join(root, 'ws');
  const outside = join(root, 'outside');
  const tempDir = join(root, 'tmp');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  return { root, workspace, outside, tempDir };
}

function context(workspace: string, tempDir: string): ToolContext {
  return {
    conversationId: 'c1',
    permissionMode: 'workspace',
    roots: rootsFor('workspace', workspace, null),
    workspacePath: workspace,
    projectSharedDir: null,
    cwd: workspace,
    tempDir,
    signal: new AbortController().signal,
  };
}

test('工作区档：pwsh 可见，工作目录就是工作区，绝对路径写沙箱目录能成功', async () => {
  const { root, workspace, tempDir } = makeWorkspace();
  const registry = createDefaultRegistry();

  try {
    const visible = registry.toProviderTools('workspace').map((tool) => tool.name);
    assert.ok(visible.includes('pwsh'), `工作区档看不到 pwsh：${visible.join(',')}`);

    /**
     * ★ 2026-11-11 审计 `ALK-HIGH-02` 之后的新契约：**工作目录是真实工作区**，
     *   不再是那个空的 `tempDir/shell-sandbox`（旧行为让所有相对路径都落到空目录里）。
     *   写仍然只在沙箱目录里能成功（Low 完整性写不动 Medium 的工作区）。
     */
    const sandboxFile = join(tempDir, 'shell-sandbox', 'probe.txt');
    const result = await registry.execute(
      'pwsh',
      { command: `(Get-Location).Path; Set-Content -LiteralPath '${sandboxFile.replaceAll("'", "''")}' -Value 'hello' -Encoding UTF8; Get-Content -LiteralPath '${sandboxFile.replaceAll("'", "''")}'` },
      context(workspace, tempDir),
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) {
      assert.match(result.content, /hello/, `沙箱内写入应成功：${result.content.slice(0, 300)}`);
      assert.match(result.content, /\[沙箱\]/, '结果里必须告诉模型沙箱目录在哪');
      // ★ 新契约：第一条输出就是真实工作区路径（证明 Set-Location 生效）
      assert.ok(
        result.content.toLowerCase().includes(workspace.toLowerCase()),
        `工作目录应当是工作区：${result.content.slice(0, 300)}`,
      );
    }
    assert.equal(existsSync(sandboxFile), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('工作区档：写工作区被系统拒绝，且文件确实不存在（★ 用户目录绝不打标签）', async () => {
  const { root, workspace, outside, tempDir } = makeWorkspace();
  const registry = createDefaultRegistry();

  try {
    const target = join(workspace, 'inside.txt');
    const result = await registry.execute(
      'pwsh',
      { command: `Set-Content -LiteralPath '${target}' -Value 'x' -Encoding UTF8` },
      context(workspace, tempDir),
    );

    // 受限档下 shell 只能写沙箱目录 ⇒ 工作区写入必须被系统拒绝
    assert.equal(existsSync(target), false, '受限档不该能从 shell 写工作区');
    if (result.ok) assert.match(result.content, /访问被拒绝|Access is denied/i);

    const outTarget = join(outside, 'escape.txt');
    await registry.execute('pwsh', { command: `Set-Content -LiteralPath '${outTarget}' -Value 'x' -Encoding UTF8` }, context(workspace, tempDir));
    assert.equal(existsSync(outTarget), false, '工作区外更不能写');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('完全权限档：不经过沙箱，行为与 V0.1 一致', async () => {
  const { root, workspace, outside, tempDir } = makeWorkspace();
  const registry = createDefaultRegistry();

  try {
    const target = join(outside, 'allowed-in-full.txt');
    const result = await registry.execute(
      'pwsh',
      { command: `Set-Content -LiteralPath '${target}' -Value 'x' -Encoding UTF8; Write-Output 'ok'` },
      {
        conversationId: 'c1',
        permissionMode: 'full',
        roots: rootsFor('full', workspace, null),
        workspacePath: workspace,
        projectSharedDir: null,
        cwd: workspace,
        tempDir,
        signal: new AbortController().signal,
      },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(existsSync(target), true, '完全权限档应当能写任意位置');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
