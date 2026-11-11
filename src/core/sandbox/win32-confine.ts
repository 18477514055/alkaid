import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { isPrivatePathOrAncestor } from '../security/private-paths.ts';
import koffi from 'koffi';

/**
 * Windows 受限执行（Low 完整性级别）。
 *
 * 设计来源：`docs/ACL受限令牌runner-可行性验证.md`。
 *
 * 机制：低完整性进程**只能写 Low 标签的对象**，读不受限。
 *      把工作区/临时目录标成 Low，子进程能写它们、写别处被系统拒绝（ACCESS_DENIED）。
 *
 * ## 为什么输出走**临时文件**而不是管道
 * 走 `CreatePipe` + `_open_osfhandle` + `fs.createReadStream` 这条路实测读不出内容
 * （`EBADF: bad file descriptor, close`）—— CRT fd 与 Win32 HANDLE 的桥接在 Node 里不可靠。
 * 改成把子进程的 stdout/stderr 重定向到**已打 Low 标签目录下的临时文件**，退出后读文件：
 * 少一层脆弱的桥接，代价是拿不到流式输出 —— 而本工具的产出本来就是一次性结果，不需要流。
 * ★ 因此**不要**再改回管道，除非你能证明那条路真的能读出数据。
 *
 * ## 已知边界（必须写进文档）
 * - **读不受限**（Low 只挡写）—— 路线本身的性质；
 * - 打标签会修改目录的完整性标签（可逆，但确实是持久副作用）；
 * - 超时只 `TerminateProcess` 直接子进程，**不保证杀干净进程树**；
 * - TOCTOU 仍在。
 */

const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');

const SECURITY_ATTRIBUTES = koffi.struct('SECURITY_ATTRIBUTES', {
  nLength: 'uint32',
  lpSecurityDescriptor: 'void*',
  bInheritHandle: 'int',
});

const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'char16_t*',
  lpDesktop: 'char16_t*',
  lpTitle: 'char16_t*',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'void*',
  hStdInput: 'void*',
  hStdOutput: 'void*',
  hStdError: 'void*',
});

const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void*',
  hThread: 'void*',
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
});

const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', { Sid: 'void*', Attributes: 'uint32' });
const TOKEN_MANDATORY_LABEL = koffi.struct('TOKEN_MANDATORY_LABEL', { Label: SID_AND_ATTRIBUTES });
const FILETIME = koffi.struct('FILETIME', { dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' });

const GetCurrentProcess = kernel32.func('void* GetCurrentProcess()');
const GetLastError = kernel32.func('uint32 GetLastError()');
const CloseHandle = kernel32.func('bool CloseHandle(void* handle)');
const TerminateProcess = kernel32.func('bool TerminateProcess(void* process, uint32 exitCode)');
const WaitForSingleObject = kernel32.func('uint32 WaitForSingleObject(void* handle, uint32 ms)');
const GetExitCodeProcess = kernel32.func('bool GetExitCodeProcess(void* process, _Out_ uint32* exitCode)');
const CreateFileW = kernel32.func(
  'void* CreateFileW(char16_t* name, uint32 access, uint32 share, SECURITY_ATTRIBUTES* attrs, uint32 disposition, uint32 flags, void* template)',
);

const OpenProcessToken = advapi32.func('bool OpenProcessToken(void* process, uint32 access, _Out_ void** token)');
const CreateRestrictedToken = advapi32.func(
  'bool CreateRestrictedToken(void* existing, uint32 flags, uint32 disableCount, void* disableSids, uint32 deleteCount, void* deleteSids, uint32 restrictCount, void* restrictSids, _Out_ void** newToken)',
);
const SetTokenInformation = advapi32.func(
  'bool SetTokenInformation(void* token, int infoClass, TOKEN_MANDATORY_LABEL* info, uint32 length)',
);
const AllocateAndInitializeSid = advapi32.func(
  'bool AllocateAndInitializeSid(uint8* authority, uint8 subCount, uint32 sub0, uint32 sub1, uint32 sub2, uint32 sub3, uint32 sub4, uint32 sub5, uint32 sub6, uint32 sub7, _Out_ void** sid)',
);
const FreeSid = advapi32.func('void* FreeSid(void* sid)');
const CreateProcessAsUserW = advapi32.func(
  'bool CreateProcessAsUserW(void* token, char16_t* appName, char16_t* cmdLine, void* procAttrs, void* threadAttrs, bool inherit, uint32 flags, char16_t* env, char16_t* cwd, STARTUPINFOW* si, _Out_ PROCESS_INFORMATION* pi)',
);

const TOKEN_QUERY = 0x0008;
const TOKEN_DUPLICATE = 0x0002;
const TOKEN_ADJUST_DEFAULT = 0x0080;
// ★ 少了它 CreateProcessAsUser 一律 ERROR_ACCESS_DENIED(5) —— 二分定位出来的
const TOKEN_ASSIGN_PRIMARY = 0x0001;
const DISABLE_MAX_PRIVILEGE = 0x1;
const TOKEN_INTEGRITY_LEVEL = 25;
const SE_GROUP_INTEGRITY = 0x00000020;
const WINDOWS_LOW_INTEGRITY_RID = 0x1000;
const STARTF_USESTDHANDLES = 0x00000100;
const CREATE_NO_WINDOW = 0x08000000;
/** 环境块是 UTF-16（配合 CreateProcessAsUserW） */
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 0x00000001;
const CREATE_ALWAYS = 2;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = -1;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

function lowIntegritySid(): unknown {
  const authority = Buffer.from([0, 0, 0, 0, 0, 16]);
  const out = [null];
  const ok = AllocateAndInitializeSid(authority, 1, WINDOWS_LOW_INTEGRITY_RID, 0, 0, 0, 0, 0, 0, 0, out);
  if (!ok) throw new Error(`AllocateAndInitializeSid 失败 err=${GetLastError()}`);
  return out[0];
}

/** 造一个 Low 完整性级别的受限令牌（**不改动当前进程的令牌**） */
export function createLowIntegrityToken(): unknown {
  const tokenPtr = [null];
  if (
    !OpenProcessToken(
      GetCurrentProcess(),
      TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
      tokenPtr,
    )
  ) {
    throw new Error(`OpenProcessToken 失败 err=${GetLastError()}`);
  }

  const restricted = [null];
  const made = CreateRestrictedToken(tokenPtr[0], DISABLE_MAX_PRIVILEGE, 0, null, 0, null, 0, null, restricted);
  CloseHandle(tokenPtr[0]);
  if (!made) throw new Error(`CreateRestrictedToken 失败 err=${GetLastError()}`);

  const sid = lowIntegritySid();
  const set = SetTokenInformation(
    restricted[0],
    TOKEN_INTEGRITY_LEVEL,
    { Label: { Sid: sid, Attributes: SE_GROUP_INTEGRITY } },
    koffi.sizeof(TOKEN_MANDATORY_LABEL),
  );
  FreeSid(sid);

  if (!set) {
    CloseHandle(restricted[0]);
    throw new Error(`SetTokenInformation(TokenIntegrityLevel) 失败 err=${GetLastError()}`);
  }
  return restricted[0];
}

/**
 * 确保目录带 Low 完整性标签。幂等；失败**显式抛**，绝不静默继续。
 *
 * ★ 2026-11-11 审计 `ALK-CRIT-04`（第二半）：这里每次调用都同步派生两次 `icacls.exe`，
 *   而 `execFileSync` 是阻塞的 —— 每个 `pwsh` 调用都要先卡住主线程一两百毫秒。
 *   现在按「路径 + 目录 mtime」缓存：同一目录在本次进程生命周期内只打一次标签。
 *   ★ 为什么要带 mtime：目录被打过标签后 mtime 一般不变，但用户删了重建就该重打。
 */
const lowLabelCache = new Map<string, number>();

/**
 * ★ 2026-11-11 审计 `ALK-CRIT-02`（本机令牌任务内）：打 Low 标签前必须堵住
 *   「Low 进程经 junction 别名诱导宿主降私密目录标签」这条路。
 *
 *   旧实现只用 `statSync`（**跟随** junction）+ `icacls`。攻击形状（已隔离实测）：
 *   前一次 shell 结束后，Low 进程把 `tempDir`（Low 可写）里的某个中间段换成指向
 *   `local-auth-*` 的 junction；下一次 `ensureLowLabel` 拿到的词法路径看似仍是
 *   自己的沙箱目录，实际 `statSync`/`icacls` 跟随 junction 落到私密目录，
 *   把 `NO_READ_UP|NO_WRITE_UP` 破坏成 Low 可读，进而读票 → 环回 API 提权。
 *
 *   这里的两道判据：
 *   ① **逐段 lstatSync**：目标路径的**每一段**（含目标自身）都不许是 reparse point
 *      （junction / symlink）。`lstatSync` 不跟随，能看出 junction 本身。
 *   ② **私密域双向拒绝**：目标不得落在私密目录内，也不得是私密目录的**祖先**——
 *      因为 `icacls (OI)(CI)` 是继承标签，给祖先打标签会波及下面的私密目录。
 *
 *   ★ 诚实边界：这两道是「词法 + lstat」判据，**不能消除 TOCTOU**（判完到 icacls 之间
 *   仍可能被并发替换）。要根除需持目录句柄 + `SetSecurityInfo` on handle（见 task-6 备注）。
 *   本档位堵住的是已证实的「中间段 junction 别名」路径；文件系统并发竞态属残余风险。
 */
function rejectReparsePointOnAnySegment(dir: string): void {
  let current = resolve(dir);
  for (;;) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; // 更上层一定存在（目标已 existsSync 校验）
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`打 Low 标签被拒绝：路径含 junction/符号链接段（${current}），不允许跟随`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function ensureLowLabel(dir: string): void {
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  if (isPrivatePathOrAncestor(dir)) {
    // 绝不通过继承标签或跟随链接把私密目录的 NRNW 破坏成 Low 可读。
    throw new Error(`打 Low 标签被拒绝：目标或其祖先涉及本机令牌私密域（${dir}）`);
  }
  rejectReparsePointOnAnySegment(dir);
  const stat = statSync(dir);
  if (!stat.isDirectory()) throw new Error(`不是目录：${dir}`);
  const stamp = stat.mtimeMs;
  if (lowLabelCache.get(dir) === stamp) return; // 已经打过了，跳过同步派生
  try {
    execFileSync('icacls', [dir, '/setintegritylevel', '(OI)(CI)Low'], { stdio: 'pipe' });
    lowLabelCache.set(dir, stamp);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`给目录打 Low 标签失败：${dir}（${detail}）`);
  }
}

/** 把目录的完整性标签恢复成 Medium（清理/测试收尾用；失败不抛） */
export function clearLowLabel(dir: string): void {
  // ★ 与 ensureLowLabel 同一判据：恢复成 Medium 也会经 icacls 跟随 junction，
  //   把私密目录的 NRNW 破坏成 Medium NW-only（Low 又可读）。拒绝进入私密域及其祖先，
  //   且任何路径段是 reparse point 都不跟随。
  if (isPrivatePathOrAncestor(dir)) return;
  try {
    rejectReparsePointOnAnySegment(dir);
  } catch {
    return; // 拒绝跟随，不误动别的目录
  }
  try {
    execFileSync('icacls', [dir, '/setintegritylevel', '(OI)(CI)Medium'], { stdio: 'pipe' });
  } catch {
    /* 尽力而为 */
  } finally {
    lowLabelCache.delete(dir); // 标签已撤，下次必须重打
  }
}

export type ConfinedResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly ms: number;
};

export type ConfinedOptions = {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** 放 stdout/stderr 临时文件的目录（会被打 Low 标签） */
  readonly outputDir: string;
  readonly timeoutMs: number;
  readonly maxOutputChars?: number;
  readonly signal?: AbortSignal;
};

/**
 * MSVC 风格的命令行引号（**不是** shell 引号）。
 *
 * ★ 2026-11-11 审计 `ALK-HIGH-01`：原来写的是 `value.replaceAll('"', '\\"')` ——
 *   而 Windows 的命令行解析规则是"反斜杠只在引号前才转义"，`\"` 会被解释成**字面引号并继续引号状态**，
 *   于是带引号或反斜杠结尾的参数会把后面的参数一起吃掉（中文路径本身没问题，坏的是引号处理）。
 *   照 MSVC 的规则重写：遇到 `"` 前面补 `\`，且连续反斜杠在引号前要成对加倍。
 */
function quoteArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  let out = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

/**
 * 给沙箱子进程的**最小环境块**（审计 `ALK-CRIT-02`）。
 *
 * ★ 原来传 `null` ⇒ 子进程**完整继承**内核的环境变量，其中包含 `ALKAID_PORT` / `ALKAID_HOME`。
 *   低完整性进程虽然写不了 Medium 目录，但**读是全盘的**（Windows MIC 默认是 No-Write-Up，
 *   不是 No-Read-Up）。拿着这两个变量，它就可以 `Invoke-RestMethod http://127.0.0.1:$env:ALKAID_PORT/api/...`
 *   绕回我们自己的管理接口（改权限档、注册一个 stdio MCP 服务器让宿主替它执行命令）。
 *   ⇒ 这里只放"跑得起 powershell"必需的那几项，绝不透传任何 `ALKAID_*` 与用户目录变量。
 *
 * 返回 Windows 要求的环境块：`K=V\0K=V\0\0`（配合 `CREATE_UNICODE_ENVIRONMENT`）。
 */
function buildSandboxEnvironment(): string {
  const passthrough = [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'TEMP',
    'TMP',
    'ComSpec',
    'PATHEXT',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
  ];
  const entries: string[] = [];
  for (const key of passthrough) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) entries.push(`${key}=${value}`);
  }
  /**
   * PATH 只给系统目录 —— 用户 `PATH` 里可能有自定义工具目录、甚至指向某个 bat 的路径。
   * powershell 自身与常用 cmdlet 只需要 System32 那两个。
   */
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  entries.push(
    `PATH=${root}\\System32\\WindowsPowerShell\\v1.0;${root}\\System32;${root}`,
    `PSModulePath=${root}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
  );
  return `${entries.join('\0')}\0\0`;
}

function openInheritableFile(path: string): unknown {
  const handle = CreateFileW(
    path,
    GENERIC_WRITE,
    FILE_SHARE_READ,
    { nLength: koffi.sizeof(SECURITY_ATTRIBUTES), lpSecurityDescriptor: null, bInheritHandle: 1 },
    CREATE_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    null,
  );
  // ★ koffi 把 HANDLE 当外部指针对象返回，不能 `typeof === 'number'` 判断有效性；
  //   一律用 koffi.address 取数值，再和 INVALID_HANDLE_VALUE(0xFFFFFFFF) 比。
  const numeric = Number(koffi.address(handle));
  if (!Number.isFinite(numeric) || numeric === 0 || numeric === 0xffffffff || numeric === -1) {
    throw new Error(`CreateFileW 失败：${path} err=${GetLastError()}`);
  }
  void realpathSync;
  void FILETIME;
  void closeSync;
  return handle;
}

/**
 * 用 Low 完整性令牌启动进程；stdout/stderr 重定向到临时文件，退出后读回。
 * ★ 令牌、标签、输出目录任一环节失败都**抛**，不降级 —— 降级就等于没有边界。
 */
export async function spawnConfined(options: ConfinedOptions): Promise<ConfinedResult> {
  const started = Date.now();
  const maxChars = options.maxOutputChars ?? 30_000;
  const runIdSeq = (globalThis as { __alkaidRunSeq?: number }).__alkaidRunSeq ?? 0;
  (globalThis as { __alkaidRunSeq?: number }).__alkaidRunSeq = runIdSeq + 1;
  // ★ 加序号（审计 `ALK-MED-11`）：只靠 `pid-时间戳` 时，同毫秒并发会撞同一个文件名
  const runId = `${process.pid}-${Date.now().toString(36)}-${runIdSeq}`;

  mkdirSync(options.outputDir, { recursive: true });
  ensureLowLabel(options.outputDir);
  const stdoutPath = join(options.outputDir, `${runId}.out`);
  const stderrPath = join(options.outputDir, `${runId}.err`);

  const token = createLowIntegrityToken();
  const outHandle = openInheritableFile(stdoutPath);
  const errHandle = openInheritableFile(stderrPath);

  const startup = {
    cb: koffi.sizeof(STARTUPINFOW),
    dwFlags: STARTF_USESTDHANDLES,
    hStdInput: null,
    hStdOutput: outHandle,
    hStdError: errHandle,
  };

  const info = {};
  const commandLine = [options.file, ...options.args].map(quoteArg).join(' ');
  const ok = CreateProcessAsUserW(
    token,
    options.file,
    commandLine,
    null,
    null,
    true,
    // ★ CREATE_UNICODE_ENVIRONMENT：环境块是 UTF-16（见 buildSandboxEnvironment）
    CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
    buildSandboxEnvironment(),
    options.cwd,
    startup,
    info,
  );
  const spawnError = GetLastError();

  CloseHandle(outHandle);
  CloseHandle(errHandle);
  CloseHandle(token);

  if (!ok) {
    rmSync(stdoutPath, { force: true });
    rmSync(stderrPath, { force: true });
    throw new Error(`CreateProcessAsUser 失败 err=${spawnError}`);
  }

  const handle = (info as { hProcess?: unknown }).hProcess;

  // ★ 分片等待：既要能超时，也要能被 abort 打断（否则用户点停止后进程还在跑）
  const deadline = Date.now() + options.timeoutMs;
  let timedOut = false;
  let aborted = false;
  let waitStatus = 2;

  if (handle !== undefined) {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      /**
       * ★★★ 2026-11-11 审计 `ALK-CRIT-04`：这里原来是 `WaitForSingleObject(handle, 200)`
       * 在一个**没有任何 await** 的 `for (;;)` 里轮询 —— Koffi 是同步 FFI，
       * 于是子进程跑的这 200 秒里 Node.js 主线程被 100% 占死：
       * - Fastify 收不到任何请求（连 `/api/healthz` 都不回）；
       * - 用户点的 `POST /stop` 根本进不了事件循环 ⇒ 上面那句 `signal.aborted` **永远不可能变真**，
       *   "能中止"这个承诺是假的；
       * - 看板轮询、其它会话，全部饿死。
       *
       * 现在：`WaitForSingleObject(handle, 0)` 只做**非阻塞探测**，然后 `await` 一个 25ms 的定时器
       * 把事件循环让出去 —— 这样 abort 信号才真的能传进来，`/stop` 才会生效。
       */
      waitStatus = WaitForSingleObject(handle, 0);
      if (waitStatus === WAIT_OBJECT_0) break;
      if (options.signal?.aborted === true) {
        aborted = true;
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(25, remaining));
      });
    }
  }

  let code: number | null = null;
  if (!timedOut && !aborted && handle !== undefined && waitStatus === WAIT_OBJECT_0) {
    const codeOut = [0];
    if (GetExitCodeProcess(handle, codeOut)) code = Number(codeOut[0]);
  } else if (handle !== undefined) {
    TerminateProcess(handle, 1);
  }
  if (handle !== undefined) CloseHandle(handle);
  const thread = (info as { hThread?: unknown }).hThread;
  if (thread !== undefined) CloseHandle(thread);

  const readBack = (path: string): string => {
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return '';
    } finally {
      // ★ 清理是**尽力而为**：Low 标签目录下偶发 EPERM（杀软/句柄释放延迟），
      //   不能因为删不掉就把一次成功的执行判成失败。
      try {
        rmSync(path, { force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* 留给会话退出时统一清理 */
      }
    }
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[截断：输出过长]` : text;
  };

  return {
    code,
    stdout: readBack(stdoutPath),
    stderr: readBack(stderrPath),
    timedOut,
    aborted,
    ms: Date.now() - started,
  };
}
