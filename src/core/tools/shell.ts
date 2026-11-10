import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { PermissionMode } from '../policy/mode.ts';
import { ensureLowLabel, spawnConfined } from '../sandbox/win32-confine.ts';
import type { ToolDefinition, ToolOutcome } from './types.ts';

/**
 * PowerShell 工具。
 *
 * ## 为什么是 PowerShell 而不是 bash
 *
 * 本机实测（2026-11-06）：
 * - `bash` 在 PATH 上是 **WSL 的 bash**（`...\WindowsApps\bash.exe`，Debian 发行版）。
 *   它跑在 Linux 侧，**Windows 的 ACL / 受限令牌管不到它** ⇒ 沙箱边界会当场漏掉一半。
 * - 真正的 Windows 原生 bash 只有 Git Bash（`C:\Program Files\Git\bin\bash.exe`），
 *   可作为第二选择，但它自带 POSIX 路径翻译层，语义与 Windows 路径不一致。
 * - `pwsh`（PowerShell 7）**未安装**；`powershell.exe` = **Windows PowerShell 5.1**（必有）。
 *
 * 所以：**PowerShell 打头，Windows 原生进程，没有 WSL 那一层语义漂移**。
 * 与 DSH 的做法一致 —— 它把 bash / pwsh 做成"逐调用镜像"的两个执行器，
 * 我们先把 pwsh 这一条做实，`ToolDefinition` 的接口足以让 bash 作为第二个工具加进来。
 *
 * ## 为什么现在能在「工作区」档看到它（V0.2 起）
 *
 * V0.1 时 shell 只在完全权限档可见，因为没有 OS 级 confinement，放开就是"假装有边界"。
 * V0.2 做出了 **Low 完整性沙箱**（`core/sandbox/win32-confine.ts`，三条真跑验收在
 * `test/e2e/sandbox.test.ts`）：子进程用受限令牌启动、工作区/共享目录/临时目录被标成 Low，
 * 于是它**只能写这三个地方**，写别处会被 Windows 直接拒绝。
 *
 * ★ 已知限制（必须对用户说清楚，不能装看不见）：
 * - **读不受限**：低完整性只挡写，进程仍能读到工作区外的文件；
 * - 打 Low 标签是对目录的**持久副作用**（可逆，退出时不清除）；
 * - 超时只结束直接子进程，不保证杀干净它拉起的进程树；
 * - `full` 档**不走沙箱**（那是"我信任这一步"的档位，行为与 V0.1 一致）。
 */

/** ★ 可见档位：完全权限档走原生 spawn，其余三档走 Low 完整性沙箱 */
const SHELL_VISIBLE_MODES: readonly PermissionMode[] = ['full', 'workspace', 'project', 'workspace_project'];

/**
 * ★ 默认值对齐 **DSH 官方端**（`cordis.patch.yml` 里 pwsh-sandbox 的 timeoutMs=200000 / maxOutputBytes=80000）。
 *   用户早就习惯那套手感：60s 对 `npm install` / `dotnet build` 这类命令明显偏短，
 *   而 30k 字符输出很容易在 `Get-ChildItem -Recurse` 上被截断。
 */
const DEFAULT_TIMEOUT_MS = 200_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_CHARS = 80_000;

/**
 * ★ 默认用**绝对路径**。
 * `CreateProcessAsUser` 不像 `spawn` 那样替你搜 PATH —— 传 `powershell.exe` 这种裸名字，
 * 受限沙箱那条路会直接 `ERROR_FILE_NOT_FOUND(2)`（实测踩过）。原生 spawn 两种都能用。
 */
const DEFAULT_EXECUTABLE =
  process.env['SystemRoot'] === undefined
    ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    : `${process.env['SystemRoot']}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

export type ShellToolOptions = {
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
  /** 便于测试替换（默认 powershell.exe） */
  readonly executable?: string;
};

type RunResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly ms: number;
};

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  // 截尾而不是截头：命令的结论通常在最后
  return {
    text: `${text.slice(0, limit)}\n…[输出过长，已截断；原始长度 ${text.length} 字符]`,
    truncated: true,
  };
}

/**
 * 跑一次 PowerShell。
 *
 * ★ 三个硬性细节，缺一个就出事故：
 * 1. **强制 UTF-8**：PowerShell 5.1 往管道里写的是 GBK(CP936)，当成 UTF-8 解就是满屏乱码
 *    （本机实测过：不设 `[Console]::OutputEncoding` 时 `中文输出测试` 变成 `�����������`）。
 * 2. **`-NoProfile -NonInteractive`**：不让用户的 profile 干扰，也不让命令卡在交互提示上。
 * 3. **超时杀进程树**：PowerShell 拉起的子进程不会随父进程退出，必须 `taskkill /T /F`。
 */
function runPowerShell(command: string, options: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly executable: string;
  readonly signal: AbortSignal;
}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const started = Date.now();
    const script = [
      '$ErrorActionPreference = "Continue"',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      command,
      'if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    ].join('\n');

    const child = spawn(
      options.executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const killTree = (): void => {
      if (child.pid === undefined) return;
      // Windows：/T 连子进程一起杀，/F 强制
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);

    const onAbort = (): void => {
      killTree();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length >= options.maxOutputChars) {
        truncated = true;
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length >= options.maxOutputChars) {
        truncated = true;
        return;
      }
      stderr += chunk;
    });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({
        code,
        // 即便如此仍再截一次：data 事件里可能一次给超大批量
        stdout: truncate(stdout, options.maxOutputChars).text,
        stderr: truncate(stderr, options.maxOutputChars).text,
        timedOut,
        truncated,
        ms: Date.now() - started,
      });
    };

    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

function formatOutcome(result: RunResult, timeoutMs: number, executable: string): ToolOutcome {
  if (result.timedOut) {
    return {
      ok: false,
      code: 'timeout',
      message: `命令超时（${timeoutMs}ms），已连同子进程一起终止`,
      hint: '换一个更快的做法，或显式传 timeout_ms（上限 600000）；不要用同样的命令重试。',
    };
  }

  if (result.code === null) {
    return {
      ok: false,
      code: 'spawn_failed',
      message: `无法启动 ${executable}`,
      hint: '这是环境问题，不是命令本身的问题；直接告诉用户。',
    };
  }

  const parts: string[] = [];
  if (result.code !== 0) parts.push(`[exit code: ${result.code}]`);
  if (result.stdout.length > 0) parts.push(result.stdout.trimEnd());
  if (result.stderr.length > 0) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (result.truncated) parts.push('[提示] 输出超过上限，已截断；必要时用 `| Select-Object -First N` 缩小范围');

  const content = parts.length > 0 ? parts.join('\n') : '(命令执行成功，没有输出)';
  return { ok: true, content };
}

/**
 * 受限执行：先把可写目录打上 Low 标签，再用受限令牌起进程。
 *
 * ★ 打标签是**幂等**的（对同一目录重复打不会变坏），但它是持久副作用：
 *   这些目录之后对"低完整性进程"可写，对普通进程没有任何影响。
 * ★ 目录集合必须与 `policy/roots.ts` 的 writable 集合一致 —— 这是本工具唯一的权限真源。
 */
async function runInSandbox(command: string, options: {
  readonly cwd: string;
  readonly workspacePath: string | null;
  readonly projectSharedDir: string | null;
  readonly tempDir: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly executable: string;
  readonly signal: AbortSignal;
}): Promise<RunResult & { readonly truncated: boolean; readonly sandboxDir: string }> {
  // ★★ 只给**我们自己拥有的沙箱目录**打 Low 标签，**绝不给用户的工作区/项目目录打**。
  //
  //   教训（2026-11-06 真机）：早期版本给整个工作区盘符根打 Low 标签，造成两件坏事：
  //   ① `CreateProcessAsUser` 以该目录为 cwd 时直接 `err=267 ERROR_DIRECTORY` —— 命令一条都跑不了；
  //   ② 之后 `icacls /setintegritylevel` 对它的子目录一律 `Access is denied`，
  //      等于**永久削弱了用户对该目录的 SACL 控制权**（文件读写仍正常，但标签改不回去了）。
  //   ⇒ 用户目录一律不碰。沙箱的代价是：受限档下 shell 只能写这个沙箱目录。
  const sandboxDir = join(options.tempDir, 'shell-sandbox');
  mkdirSync(sandboxDir, { recursive: true });
  ensureLowLabel(options.tempDir);
  ensureLowLabel(sandboxDir);

  const script = [
    '$ErrorActionPreference = "Continue"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    command,
    'if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\n');

  const result = await spawnConfined({
    file: options.executable,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    cwd: sandboxDir,
    outputDir: options.tempDir,
    timeoutMs: options.timeoutMs,
    maxOutputChars: options.maxOutputChars,
    signal: options.signal,
  });

  const truncated = result.stdout.includes('[截断：输出过长]') || result.stderr.includes('[截断：输出过长]');
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    truncated,
    ms: result.ms,
    sandboxDir,
  };
}

export function createPwshTool(options: ShellToolOptions = {}): ToolDefinition {
  const executable = options.executable ?? DEFAULT_EXECUTABLE;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  return {
    name: 'pwsh',
    description:
      '在本机执行一段 Windows PowerShell（5.1）命令/脚本，返回 stdout 与 stderr。' +
      '\n- 工作目录默认是当前工作区（没有工作区时是数据目录）。' +
      '\n- 输出已强制 UTF-8；单条输出超长会被截断。' +
      '\n- 注意：本机是 **Windows PowerShell 5.1**，不支持 `??`、`?:`、`-Parallel` 等 PS7 语法。' +
      '\n- 注意：`Get-Content` 默认按 GBK 解码 UTF-8 文件（会显示成乱码）；读文本文件优先用 `read` 工具，' +
      '或在命令里写明 `-Encoding UTF8`。' +
      '\n- 超时会连子进程一起杀掉；非 0 退出码会以 `[exit code: N]` 出现在结果里。' +
      '\n- ★ 在工作区/项目/受限档位下，命令跑在**低完整性沙箱**里：**只能写**返回结果里给出的沙箱目录；' +
      '改工作区或项目里的文件请改用 `write` / `edit` 工具。**读不受限制**。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令或脚本（可多行）' },
        timeout_ms: {
          type: 'number',
          description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    modes: SHELL_VISIBLE_MODES,

    // ── 元信息 ──
    source: 'builtin',
    kind: 'external',
    group: 'shell',
    displayName: '执行命令',
    summary: '在本机执行 PowerShell 命令（非完全权限档跑在低完整性沙箱里）',
    oneLiner: 'Run a PowerShell command on this machine and return stdout/stderr.',
    preferredMode: 'resident',
    examples: [
      {
        whenTo: 'a command may be slow and you want a shorter timeout',
        args: { command: 'Get-ChildItem -Recurse | Measure-Object', timeout_ms: 30000 },
      },
    ],

    async execute(rawArgs: unknown, ctx): Promise<ToolOutcome> {
      const args = (rawArgs ?? {}) as { command?: unknown; timeout_ms?: unknown };
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (command.length === 0) {
        return { ok: false, code: 'invalid_args', message: 'command 不能为空', hint: '传一个非空的 PowerShell 命令。' };
      }

      const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(1_000, Math.trunc(requested)), MAX_TIMEOUT_MS);

      /**
       * 本次生效的输出上限。
       * ★ `ctx.maxToolOutputChars === null` ⇒ 用户在设置里**关掉了上限**。
       *   这里不把 `null` 往下传：沙箱层与执行层的签名都是 `number`，改签名会牵动三个模块；
       *   也不传 `Infinity`（`length >= max` 与 `truncate` 的行为容易读错）。
       *   用 `Number.MAX_SAFE_INTEGER` 最直观：真实输出到不了，等价于不限制。
       */
      const effectiveMaxOutputChars =
        ctx.maxToolOutputChars === null
          ? Number.MAX_SAFE_INTEGER
          : (ctx.maxToolOutputChars ?? maxOutputChars);

      // ★ 目录不在了就明说 —— 否则 spawn 只会回一个 ENOENT，模型猜不出是工作区被删了
      if (!existsSync(ctx.cwd)) {
        return {
          ok: false,
          code: 'cwd_missing',
          message: `工作目录不存在：${ctx.cwd}`,
          hint: '工作区可能被移动或删除。请让用户重新登记工作区，或先解除工作区绑定。',
        };
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // ★ 临时目录指到会话私有目录：命令产生的临时文件不散落在系统 temp 里
        TMP: ctx.tempDir,
        TEMP: ctx.tempDir,
      };

      // ★ 非完全权限档：走 Low 完整性沙箱（能写工作区/共享/临时，写别处被系统拒绝）
      if (ctx.permissionMode !== 'full') {
        try {
          const confined = await runInSandbox(command, {
            cwd: ctx.cwd,
            workspacePath: ctx.workspacePath,
            projectSharedDir: ctx.projectSharedDir,
            tempDir: ctx.tempDir,
            timeoutMs,
            maxOutputChars: effectiveMaxOutputChars,
            executable,
            signal: ctx.signal,
          });
          // ★ 结果里带上沙箱目录：模型否则只能靠猜"我能写到哪"
          const outcome = formatOutcome(confined, timeoutMs, executable);
          const note = `[沙箱] 本命令以低完整性运行，**只能写** ${confined.sandboxDir}；改工作区/项目文件请用 write / edit 工具。`;
          return outcome.ok ? { ok: true, content: `${outcome.content}\n\n${note}` } : outcome;
        } catch (error) {
          return {
            ok: false,
            code: 'sandbox_unavailable',
            message: `无法建立受限执行环境：${error instanceof Error ? error.message : String(error)}`,
            hint: '这是环境问题（可能是 Low 完整性标签打不上），不是命令本身的问题；直接告诉用户，不要重试。',
          };
        }
      }

      const result = await runPowerShell(command, {
        cwd: ctx.cwd,
        env,
        timeoutMs,
        maxOutputChars: effectiveMaxOutputChars,
        executable,
        signal: ctx.signal,
      });

      return formatOutcome(result, timeoutMs, executable);
    },
  };
}
