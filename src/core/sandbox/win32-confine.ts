import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

const STARTUPINFOA = koffi.struct('STARTUPINFOA', {
  cb: 'uint32',
  lpReserved: 'char*',
  lpDesktop: 'char*',
  lpTitle: 'char*',
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
const CreateProcessAsUserA = advapi32.func(
  'bool CreateProcessAsUserA(void* token, char* appName, char* cmdLine, void* procAttrs, void* threadAttrs, bool inherit, uint32 flags, void* env, char* cwd, STARTUPINFOA* si, _Out_ PROCESS_INFORMATION* pi)',
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

/** 确保目录带 Low 完整性标签。幂等；失败**显式抛**，绝不静默继续。 */
export function ensureLowLabel(dir: string): void {
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  if (!statSync(dir).isDirectory()) throw new Error(`不是目录：${dir}`);
  try {
    execFileSync('icacls', [dir, '/setintegritylevel', '(OI)(CI)Low'], { stdio: 'pipe' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`给目录打 Low 标签失败：${dir}（${detail}）`);
  }
}

/** 把目录的完整性标签恢复成 Medium（清理/测试收尾用；失败不抛） */
export function clearLowLabel(dir: string): void {
  try {
    execFileSync('icacls', [dir, '/setintegritylevel', '(OI)(CI)Medium'], { stdio: 'pipe' });
  } catch {
    /* 尽力而为 */
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

function quoteArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
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
  const runId = `${process.pid}-${Date.now().toString(36)}`;

  mkdirSync(options.outputDir, { recursive: true });
  ensureLowLabel(options.outputDir);
  const stdoutPath = join(options.outputDir, `${runId}.out`);
  const stderrPath = join(options.outputDir, `${runId}.err`);

  const token = createLowIntegrityToken();
  const outHandle = openInheritableFile(stdoutPath);
  const errHandle = openInheritableFile(stderrPath);

  const startup = {
    cb: koffi.sizeof(STARTUPINFOA),
    dwFlags: STARTF_USESTDHANDLES,
    hStdInput: null,
    hStdOutput: outHandle,
    hStdError: errHandle,
  };

  const info = {};
  const commandLine = [options.file, ...options.args].map(quoteArg).join(' ');
  const ok = CreateProcessAsUserA(
    token,
    options.file,
    commandLine,
    null,
    null,
    true,
    CREATE_NO_WINDOW,
    null,
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
      waitStatus = WaitForSingleObject(handle, Math.min(200, remaining));
      if (waitStatus === WAIT_OBJECT_0) break;
      if (options.signal?.aborted === true) {
        aborted = true;
        break;
      }
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
