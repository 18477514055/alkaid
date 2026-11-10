/**
 * Win32 沙箱机制探针（一次性验证脚本，保留作证据）。
 *
 * 跑法：`node scripts/probes/win32-token-probe.mjs`（需要 koffi，devDependency）
 *
 * 决定性问题：**非管理员**能不能用受限令牌起一个子进程？
 * 这决定 ACL runner 是否需要"提权安装"这一步。
 *
 * ★ 这不是产品代码，不参与构建；它存在的意义是"结论可复现"。
 * ★ 第一版探针里读 SID 的那段（koffi.decode TOKEN_USER）会让进程静默崩溃（0xC0000005），
 *   已删掉 —— 与结论无关的代码不该留在证据里制造噪声。
 */
import koffi from 'koffi';

const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');

const GetCurrentProcess = kernel32.func('void* GetCurrentProcess()');
const GetLastError = kernel32.func('uint32 GetLastError()');
const CloseHandle = kernel32.func('bool CloseHandle(void* handle)');

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

const TOKEN_QUERY = 0x0008;
const TOKEN_DUPLICATE = 0x0002;
const TOKEN_ASSIGN_PRIMARY = 0x0001;
const DISABLE_MAX_PRIVILEGE = 0x1;

const OpenProcessToken = advapi32.func('bool OpenProcessToken(void* process, uint32 access, _Out_ void** token)');
const CreateRestrictedToken = advapi32.func(
  'bool CreateRestrictedToken(void* existing, uint32 flags, uint32 disableCount, void* disableSids, uint32 deleteCount, void* deleteSids, uint32 restrictCount, void* restrictSids, _Out_ void** newToken)',
);
const CreateProcessAsUserA = advapi32.func(
  'bool CreateProcessAsUserA(void* token, char* appName, char* cmdLine, void* procAttrs, void* threadAttrs, bool inherit, uint32 flags, void* env, char* cwd, STARTUPINFOA* si, PROCESS_INFORMATION* pi)',
);

const tokenPtr = [null];
if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY, tokenPtr)) {
  console.log(`[1] OpenProcessToken 失败 err=${GetLastError()}`);
  process.exit(1);
}
console.log('[1] OpenProcessToken OK');

const restricted = [null];
const made = CreateRestrictedToken(tokenPtr[0], DISABLE_MAX_PRIVILEGE, 0, null, 0, null, 0, null, restricted);
console.log(`[2] CreateRestrictedToken = ${made} err=${made ? 0 : GetLastError()}`);
if (!made) process.exit(1);

const si = { cb: koffi.sizeof(STARTUPINFOA) };
const pi = {};
const started = CreateProcessAsUserA(
  restricted[0],
  'C:\\Windows\\System32\\cmd.exe',
  'cmd.exe /c exit 0',
  null,
  null,
  false,
  0,
  null,
  'C:\\Windows\\System32',
  si,
  pi,
);

const code = GetLastError();
const meaning = {
  0: 'ERROR_SUCCESS',
  5: 'ERROR_ACCESS_DENIED',
  87: 'ERROR_INVALID_PARAMETER',
  1314: 'ERROR_PRIVILEGE_NOT_HELD',
};
console.log(`[3] CreateProcessAsUser = ${started} err=${code}（${meaning[code] ?? '未收录'}）`);

CloseHandle(restricted[0]);
CloseHandle(tokenPtr[0]);
