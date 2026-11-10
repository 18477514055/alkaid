// 二分定位：到底是"低完整性令牌"还是"管道继承"导致 CreateProcessAsUser 返回 5
import koffi from 'koffi';

const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');

const SA = koffi.struct('SA', { nLength: 'uint32', lpSecurityDescriptor: 'void*', bInheritHandle: 'int' });
const SI = koffi.struct('SI', {
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
const PI = koffi.struct('PI', { hProcess: 'void*', hThread: 'void*', dwProcessId: 'uint32', dwThreadId: 'uint32' });
const TML = koffi.struct('TML', { Sid: 'void*', Attributes: 'uint32' });

const GetCurrentProcess = kernel32.func('void* GetCurrentProcess()');
const GetLastError = kernel32.func('uint32 GetLastError()');
const CloseHandle = kernel32.func('bool CloseHandle(void* h)');
const CreatePipe = kernel32.func('bool CreatePipe(_Out_ void** r, _Out_ void** w, SA* a, uint32 s)');
const OpenProcessToken = advapi32.func('bool OpenProcessToken(void* p, uint32 a, _Out_ void** t)');
const CreateRestrictedToken = advapi32.func(
  'bool CreateRestrictedToken(void* e, uint32 f, uint32 dc, void* ds, uint32 xc, void* xs, uint32 rc, void* rs, _Out_ void** nt)',
);
const SetTokenInformation = advapi32.func('bool SetTokenInformation(void* t, int c, TML* i, uint32 l)');
const AllocateAndInitializeSid = advapi32.func(
  'bool AllocateAndInitializeSid(uint8* a, uint8 n, uint32 s0, uint32 s1, uint32 s2, uint32 s3, uint32 s4, uint32 s5, uint32 s6, uint32 s7, _Out_ void** sid)',
);
const CreateProcessAsUserA = advapi32.func(
  'bool CreateProcessAsUserA(void* t, char* app, char* cmd, void* pa, void* ta, bool inherit, uint32 flags, void* env, char* cwd, SI* si, _Out_ PI* pi)',
);

const TOKEN_QUERY = 0x0008;
const TOKEN_DUPLICATE = 0x0002;
const TOKEN_ADJUST_DEFAULT = 0x0080;
const DISABLE_MAX_PRIVILEGE = 0x1;
const STARTF_USESTDHANDLES = 0x00000100;

function makeToken(low) {
  const t = [null];
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | 0x0001, t)) {
    throw new Error('OpenProcessToken ' + GetLastError());
  }
  const r = [null];
  if (!CreateRestrictedToken(t[0], DISABLE_MAX_PRIVILEGE, 0, null, 0, null, 0, null, r)) {
    throw new Error('CreateRestrictedToken ' + GetLastError());
  }
  CloseHandle(t[0]);
  if (!low) return r[0];
  const authority = Buffer.from([0, 0, 0, 0, 0, 16]);
  const sid = [null];
  if (!AllocateAndInitializeSid(authority, 1, 0x1000, 0, 0, 0, 0, 0, 0, 0, sid)) {
    throw new Error('AllocateAndInitializeSid ' + GetLastError());
  }
  const ok = SetTokenInformation(r[0], 25, { Sid: sid[0], Attributes: 0x20 }, koffi.sizeof(TML));
  const err = GetLastError();
  if (!ok) throw new Error('SetTokenInformation ' + err);
  return r[0];
}

function attempt(label, low, pipes) {
  const token = makeToken(low);
  let outW = null;
  let outR = null;
  const siBase = { cb: koffi.sizeof(SI) };
  if (pipes) {
    outR = [null];
    outW = [null];
    const okPipe = CreatePipe(outR, outW, { nLength: koffi.sizeof(SA), lpSecurityDescriptor: null, bInheritHandle: 1 }, 0);
    if (!okPipe) {
      console.log(`${label}: CreatePipe 失败 ${GetLastError()}`);
      return;
    }
  }
  const si = pipes
    ? { ...siBase, dwFlags: STARTF_USESTDHANDLES, hStdOutput: outW[0], hStdError: outW[0] }
    : siBase;
  const pi = {};
  const ok = CreateProcessAsUserA(
    token,
    'C:\\Windows\\System32\\cmd.exe',
    'cmd.exe /c exit 0',
    null,
    null,
    pipes === true,
    0,
    null,
    'C:\\Windows\\System32',
    si,
    pi,
  );
  const err = GetLastError();
  console.log(`${label}: ok=${ok} err=${err} pid=${pi.dwProcessId ?? '?'}`);
  CloseHandle(token);
  if (outW) CloseHandle(outW[0]);
  if (outR) CloseHandle(outR[0]);
}

attempt('A 普通受限令牌 / 无管道', false, false);
attempt('B 低完整性令牌 / 无管道', true, false);
attempt('C 普通受限令牌 / 有管道', false, true);
attempt('D 低完整性令牌 / 有管道', true, true);

