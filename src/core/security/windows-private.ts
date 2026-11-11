import koffi from 'koffi';

const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
// LABEL is intentionally NOT SACL_SECURITY_INFORMATION (which requires SeSecurityPrivilege).
const LABEL_SECURITY_INFORMATION = 0x10;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
const QUERY = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;

function windowsApi() {
  const kernel = koffi.load('kernel32.dll');
  const advapi = koffi.load('advapi32.dll');
  return {
    currentProcess: kernel.func('void* __stdcall GetCurrentProcess()'),
    lastError: kernel.func('uint32 __stdcall GetLastError()'),
    close: kernel.func('bool __stdcall CloseHandle(void* handle)'),
    free: kernel.func('void* __stdcall LocalFree(void* memory)'),
    openToken: advapi.func('bool __stdcall OpenProcessToken(void* process, uint32 access, _Out_ void** token)'),
    tokenInfo: advapi.func('bool __stdcall GetTokenInformation(void* token, uint32 infoClass, void* buffer, uint32 size, _Out_ uint32* needed)'),
    sidString: advapi.func('bool __stdcall ConvertSidToStringSidW(void* sid, _Out_ void** text)'),
    parse: advapi.func('bool __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(char16_t* text, uint32 revision, _Out_ void** descriptor, void* size)'),
    stringify: advapi.func('bool __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void* descriptor, uint32 revision, uint32 info, _Out_ void** text, void* size)'),
    set: advapi.func('bool __stdcall SetFileSecurityW(char16_t* path, uint32 info, void* descriptor)'),
    get: advapi.func('bool __stdcall GetFileSecurityW(char16_t* path, uint32 info, void* buffer, uint32 size, _Out_ uint32* needed)'),
  };
}
let api: ReturnType<typeof windowsApi> | undefined;
function win() { return api ??= windowsApi(); }
function failure(operation: string): Error { return new Error(`Private credential protection failed: ${operation} (Win32 ${win().lastError()})`); }
function decodeText(pointer: unknown): string { return koffi.decode(pointer as never, 'char16_t', -1) as string; }

function currentUserSid(): string {
  const w = win();
  const token = [null];
  if (!w.openToken(w.currentProcess(), 0x8, token)) throw failure('OpenProcessToken');
  try {
    const size = [0];
    w.tokenInfo(token[0], 1, null, 0, size); // TokenUser
    if (!size[0] || size[0] > 1024 * 1024) throw failure('GetTokenInformation size');
    const buffer = Buffer.alloc(size[0]);
    if (!w.tokenInfo(token[0], 1, buffer, buffer.length, size)) throw failure('GetTokenInformation');
    const sid = koffi.decode(buffer, 'void*');
    const text = [null];
    if (!w.sidString(sid, text)) throw failure('ConvertSidToStringSidW');
    try { return decodeText(text[0]); } finally { w.free(text[0]); }
  } finally { w.close(token[0]); }
}
let userSid: string | undefined;
function sid(): string { return userSid ??= currentUserSid(); }

function readDescriptor(path: string): string {
  const w = win();
  const size = [0];
  w.get(path, QUERY, null, 0, size);
  if (!size[0] || size[0] > 1024 * 1024) throw failure('GetFileSecurityW size');
  const buffer = Buffer.alloc(size[0]);
  if (!w.get(path, QUERY, buffer, buffer.length, size)) throw failure('GetFileSecurityW');
  const text = [null];
  if (!w.stringify(buffer, 1, QUERY, text, null)) throw failure('ConvertSecurityDescriptorToStringSecurityDescriptorW');
  try { return decodeText(text[0]); } finally { w.free(text[0]); }
}

/** Validate the ACTUAL descriptor, not command exit status or requested SDDL. No secret is in these errors. */
export function verifyWindowsPrivatePath(path: string, directory: boolean): void {
  const sddl = readDescriptor(path);
  const owner = /O:([^:]+?)(?=[GDS]:|$)/.exec(sddl)?.[1];
  const dacl = /D:([^:]*)(?=[OGS]:|$)/.exec(sddl)?.[1];
  const sacl = /S:([^:]*)(?=[OGD]:|$)/.exec(sddl)?.[1];
  const entries = (acl: string | undefined) => [...(acl ?? '').matchAll(/\(([^()]*)\)/g)].map((m) => m[1]!.split(';'));
  const access = entries(dacl);
  const label = entries(sacl);
  const fullAccess = access[0]?.[2];
  const policy = label[0]?.[2];
  const rightsOK = fullAccess === 'FA' || fullAccess?.toLowerCase() === '0x1f01ff';
  const policyOK = policy === 'NWNR' || policy === 'NRNW' || policy?.toLowerCase() === '0x3';
  const inheritanceOK = (flags: string | undefined) => flags !== undefined && !flags.includes('IO') && (!directory || (flags.includes('OI') && flags.includes('CI')));
  if (owner !== sid() || !dacl || (directory && !dacl.split('(')[0]?.includes('P')) ||
      access.length !== 1 || access[0]?.[0] !== 'A' || !rightsOK || access[0]?.[5] !== sid() ||
      !inheritanceOK(access[0]?.[1]) || label.length !== 1 || label[0]?.[0] !== 'ML' || !policyOK ||
      !['ME', 'S-1-16-8192'].includes(label[0]?.[5] ?? '') || !inheritanceOK(label[0]?.[1])) {
    throw new Error('Private credential security descriptor readback rejected (requires current-user-only DACL and Medium NO_READ_UP|NO_WRITE_UP)');
  }
}

/** Apply before writing ANY secret. Medium NW alone is not sufficient: Low shares the same user SID. */
export function protectWindowsPrivateDirectory(path: string): void {
  const w = win();
  const descriptor = [null];
  const sddl = `O:${sid()}D:P(A;OICI;FA;;;${sid()})S:(ML;OICI;NWNR;;;ME)`;
  if (!w.parse(sddl, 1, descriptor, null)) throw failure('ConvertStringSecurityDescriptorToSecurityDescriptorW');
  try {
    if (!w.set(path, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor[0])) throw failure('SetFileSecurityW DACL');
    if (!w.set(path, LABEL_SECURITY_INFORMATION, descriptor[0])) throw failure('SetFileSecurityW LABEL');
  } finally { w.free(descriptor[0]); }
  verifyWindowsPrivatePath(path, true);
}

/**
 * 给**单个文件**施加「仅当前用户 + Medium NRNW」（审计 `ALK-CRIT-02` 的读全盘一半）。
 *
 * ★ 为什么需要它在目录版本之外：`secrets.json` 与 `alkaid.db` 落在数据目录根上，
 *   而那里不能整目录降 NRNW（用户自己的备份/导出还要用，且不属于凭证域）。
 *   **只有文件级标签**才能让"Low 读不到它"，同时不影响目录的其它用途。
 * ★ 为什么 DACL 也要设：只加完整性标签时，同机的**其他用户**仍可能凭继承的 DACL 读；
 *   这里把 DACL 一起收紧成"仅属主"，两道一起才等于"别人读不到、Low 读不到"。
 * ★ 读回校验（`verifyWindowsPrivatePath(path, false)`）不能省 —— 设失败却以为设上了，
 *   正是这类安全改动最容易自欺的地方。
 */
export function protectWindowsPrivateFile(path: string): void {
  const w = win();
  const descriptor = [null];
  // 文件没有 (OI)(CI) —— 它们是给目录/容器用的；文件自己只认不带继承标志的 ACE。
  const sddl = `O:${sid()}D:P(A;;FA;;;${sid()})S:(ML;;NWNR;;;ME)`;
  if (!w.parse(sddl, 1, descriptor, null)) throw failure('ConvertStringSecurityDescriptorToSecurityDescriptorW');
  try {
    if (!w.set(path, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor[0])) throw failure('SetFileSecurityW DACL (file)');
    if (!w.set(path, LABEL_SECURITY_INFORMATION, descriptor[0])) throw failure('SetFileSecurityW LABEL (file)');
  } finally { w.free(descriptor[0]); }
  verifyWindowsPrivatePath(path, false);
}
