/**
 * 桌面壳「添加工作区 ⇒ 唤起系统目录选择器」的接线测试。
 *
 * 为什么用假 electron 模块：`desktop/main.cjs` 顶部就 `require('electron')`，拿真实 Electron
 * 跑要开窗口（本机不允许打扰用户）。这里用 `Module._load` 拦截，把 `electron` /
 * `node:child_process` 换成桩，让 **真实的 main.cjs** 跑完它自己的启动流程：
 * 注册 IPC → 起"内核"（假 spawn）→ 私有 ready（EventEmitter）→ 内存 session cookie → createWindow。
 * 这样断言到的是**它实际注册的 handler 和实际传给 BrowserWindow 的 webPreferences**，
 * 不是读源码猜出来的。
 *
 * 覆盖：
 * 1. 主进程：ipcMain 注册了 `alkaid:pick-directory`；BrowserWindow 带 preload 且安全开关全对。
 * 2. 主进程：handler 的四种返回（选中 / 取消 / 抛异常 / 空列表）都落到约定值，且**永不 reject**。
 * 3. preload：通过 contextBridge 只暴露 `alkaidDesktop`，`pickDirectory` 永不 reject。
 * 4. preload 降级：纯 Node（`require('electron')` 只返回路径字符串）、空对象、exposeInMainWorld
 *    抛错三种情况都不许把 preload 抛崩 —— 其中"纯 Node"那条用**真子进程**跑，不是桩。
 * 5. 打包链路：build-dist / 两个同步脚本的文件清单里含 `desktop`，且整目录复制确实会带上
 *    `preload.cjs`（用真 cpSync 复现一次）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { createRequire, default as Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN_CJS = join(APP_ROOT, 'desktop', 'main.cjs');
const PRELOAD_CJS = join(APP_ROOT, 'desktop', 'preload.cjs');
const requireCjs = createRequire(import.meta.url);

/** `Module._load` 不在 @types/node 里，但 require() 内部就是走它（对核心模块同样生效）。 */
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

async function withPatchedLoads<T>(loads: Record<string, unknown>, body: () => Promise<T> | T): Promise<T> {
  const original = ModuleInternals._load;
  ModuleInternals._load = function patchedLoad(this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (Object.prototype.hasOwnProperty.call(loads, request)) return loads[request];
    return original.call(this, request, parent, isMain);
  } as typeof ModuleInternals._load;
  try {
    return await body();
  } finally {
    ModuleInternals._load = original;
  }
}

function freshRequire(path: string): unknown {
  delete requireCjs.cache[path];
  return requireCjs(path);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待条件超时（main.cjs 启动流程没有走到预期步骤）');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

interface FakeMainState {
  exposed: Array<{ key: string; api: Record<string, any> }>;
  handlers: Map<string, (event: any) => any>;
  windows: Array<{ options: any; webContents: any; loadURL: (url: string) => void; on: (name: string, fn: any) => void }>;
  loadedUrls: string[];
  openDialogCalls: Array<{ parent: any; options: any }>;
  errorBoxes: string[];
  quitCount: number;
  quitSignalled: () => boolean;
  events: string[];
  partitions: Array<{ name: string; options: any }>;
  cookies: any[];
  appEvents: EventEmitter;
  beforeHeaders: ((details: any, callback: (result: any) => void) => void) | null;
  clearCount: number;
}

function makeFakeMainElectron(home: string) {
  const state: FakeMainState = {
    exposed: [],
    handlers: new Map(),
    windows: [],
    loadedUrls: [],
    openDialogCalls: [],
    errorBoxes: [],
    quitCount: 0,
    quitSignalled: () => state.quitCount > 0,
    events: [],
    partitions: [],
    cookies: [],
    appEvents: new EventEmitter(),
    beforeHeaders: null,
    clearCount: 0,
  };
  let cookieGate: Promise<void> = Promise.resolve();
  const trustedSession = {
    cookies: { set: async (cookie: any) => {
      state.cookies.push(cookie);
      state.events.push('cookie:start');
      await cookieGate;
      state.events.push('cookie:done');
    } },
    webRequest: { onBeforeSendHeaders: (handler: any) => { state.beforeHeaders = handler; } },
    clearStorageData: async () => { state.clearCount += 1; },
  };
  /** 每条用例自己换；默认当作用户取消。 */
  let respond: (parent: any, options: any) => any = () => ({ canceled: true, filePaths: [] });

  class FakeBrowserWindow {
    options: any;
    webContents: any;
    constructor(options: any) {
      this.options = options;
      this.webContents = {
        setWindowOpenHandler: (fn: any) => {
          this.windowOpenHandler = fn;
        },
        /**
         * ★ 真实的 `webContents` 一定有 `.on`（`will-navigate` / `did-create-window` 都靠它）。
         * 这个假体原来没实现它，于是主进程一调 `will-navigate` 就抛错、启动流程走不到 loadURL ——
         * 测试报的是"等待条件超时"，看着像"窗口没建出来"，实际是**假体缺能力**。
         */
        on: (name: string, fn: any) => {
          this.handlers.set(name, fn);
        },
      };
      state.windows.push(this);
    }
    windowOpenHandler: any = null;
    handlers: Map<string, any> = new Map();
    loadURL(url: string) {
      state.events.push('loadURL');
      state.loadedUrls.push(url);
    }
    on(name: string, fn: any) { this.handlers.set(`window:${name}`, fn); }
    isMinimized() {
      return false;
    }
    restore() {}
    focus() {}
    static fromWebContents(_sender: any) {
      return state.windows[0] ?? null;
    }
    static getAllWindows() {
      return state.windows;
    }
  }

  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      on: (name: string, fn: any) => state.appEvents.on(name, fn),
      whenReady: () => Promise.resolve(),
      quit: () => {
        state.quitCount += 1;
      },
      getPath: () => home,
    },
    BrowserWindow: FakeBrowserWindow,
    session: { fromPartition: (name: string, options: any) => {
      state.partitions.push({ name, options });
      return trustedSession;
    } },
    Menu: { buildFromTemplate: (template: any) => template, setApplicationMenu: () => {} },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    ipcMain: {
      handle: (channel: string, handler: (event: any) => any) => void state.handlers.set(channel, handler),
    },
    dialog: {
      showOpenDialog: async (...args: any[]) => {
        const parent = args.length > 1 ? args[0] : null;
        const options = args[args.length - 1];
        state.openDialogCalls.push({ parent, options });
        return respond(parent, options);
      },
      showErrorBox: (title: string, content: string) => void state.errorBoxes.push(`${title}|${content}`),
    },
  };

  return {
    electron,
    state,
    trustedSession,
    setCookieGate(gate: Promise<void>) { cookieGate = gate; },
    setDialogResponse(next: (parent: any, options: any) => any) {
      respond = next;
    },
  };
}

/** 真实 main.cjs + EventEmitter child IPC/session；绝不把公开 health 误当认证。 */
const TEST_LOCAL_TOKEN = 'synthetic_desktop_test_token_not_a_secret_123456';
async function bootRealMain(options: {
  ready?: false | { url?: string; localToken?: string | null };
  cookieGate?: Promise<void>;
  inspectPending?: (context: { state: FakeMainState; child: EventEmitter; fake: ReturnType<typeof makeFakeMainElectron> }) => Promise<void>;
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'alkaid-desktop-home-'));
  const fake = makeFakeMainElectron(home);
  if (options.cookieGate) fake.setCookieGate(options.cookieGate);
  const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: () => { child.emit('exit', 0); },
  });
  const fakeChildProcess = {
    spawn: (command: string, args: string[], spawnOptions: any) => {
      spawnCalls.push({ command, args, options: spawnOptions });
      return child;
    },
  };
  const previousHome = process.env.ALKAID_HOME;
  const previousPort = process.env.ALKAID_PORT;
  process.env.ALKAID_HOME = home;
  process.env.ALKAID_PORT = '43123';
  const realFetch = globalThis.fetch;
  let publicHealthCalls = 0;
  globalThis.fetch = (async () => {
    publicHealthCalls += 1;
    return { ok: true, status: 200 };
  }) as unknown as typeof globalThis.fetch;
  const restore = () => {
    fake.state.appEvents.emit('before-quit');
    globalThis.fetch = realFetch;
    if (previousHome === undefined) delete process.env.ALKAID_HOME;
    else process.env.ALKAID_HOME = previousHome;
    if (previousPort === undefined) delete process.env.ALKAID_PORT;
    else process.env.ALKAID_PORT = previousPort;
    delete requireCjs.cache[MAIN_CJS];
    delete requireCjs.cache[PRELOAD_CJS];
    rmSync(home, { recursive: true, force: true });
  };
  try {
    await withPatchedLoads({ electron: fake.electron, 'node:child_process': fakeChildProcess, child_process: fakeChildProcess }, async () => {
      freshRequire(MAIN_CJS);
      await waitFor(() => child.listenerCount('message') > 0);
      assert.equal(fake.state.windows.length, 0, '未收到可信 IPC 时不能开窗（即使 health 200）');
      if (options.ready !== false) {
        child.emit('message', { type: 'alkaid:ready', url: options.ready?.url ?? 'http://127.0.0.1:43123',
          localToken: options.ready?.localToken === undefined ? TEST_LOCAL_TOKEN : options.ready.localToken });
      }
      if (options.inspectPending) await options.inspectPending({ state: fake.state, child, fake });
      if (options.ready === false) {
        assert.equal(fake.state.windows.length, 0);
        child.emit('disconnect');
      }
      await waitFor(() => fake.state.loadedUrls.length > 0 || fake.state.quitCount > 0);
    });
  } catch (error) {
    restore();
    throw error;
  }
  return { state: fake.state, fake, restore, spawnCalls, publicHealthCalls };
}

test('desktop auth: 私有 IPC → 内存 session → HttpOnly cookie 完成 → loadURL；token 不进 env/argv/preload', async () => {
  let releaseCookie!: () => void;
  const cookieGate = new Promise<void>((resolveGate) => { releaseCookie = resolveGate; });
  const { state, fake, restore, spawnCalls, publicHealthCalls } = await bootRealMain({ cookieGate,
    inspectPending: async ({ state }) => {
      await waitFor(() => state.cookies.length === 1);
      assert.equal(state.windows.length, 0, 'cookies.set 尚未完成时不能建窗');
      assert.equal(state.loadedUrls.length, 0);
      releaseCookie();
    },
  });
  try {
    assert.deepEqual(state.events, ['cookie:start', 'cookie:done', 'loadURL']);
    assert.equal(state.partitions.length, 1);
    assert.match(state.partitions[0]!.name, /^alkaid-[0-9a-f-]{36}$/);
    assert.ok(!state.partitions[0]!.name.startsWith('persist:'));
    assert.deepEqual(state.partitions[0]!.options, { cache: false });
    assert.deepEqual(state.cookies[0], { url: 'http://127.0.0.1:43123', name: 'alkaid_local',
      value: TEST_LOCAL_TOKEN, httpOnly: true, sameSite: 'strict', path: '/' });
    assert.equal(state.windows[0]!.options.webPreferences.session, fake.trustedSession);
    assert.deepEqual(spawnCalls[0]!.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
    assert.ok(!JSON.stringify(spawnCalls).includes(TEST_LOCAL_TOKEN), 'token 不得进入 argv 或 env');
    assert.ok(!JSON.stringify(state.windows[0]!.options).includes(TEST_LOCAL_TOKEN), 'token 不得进入 renderer 参数');
    assert.ok(!readFileSync(PRELOAD_CJS, 'utf8').includes(TEST_LOCAL_TOKEN));
    assert.deepEqual([...state.handlers.keys()], ['alkaid:pick-directory'], '没有获取 token 的 renderer IPC');
    assert.equal(publicHealthCalls, 0, '启动认证完全不依赖公开 health');
    state.windows.splice(0);
    state.appEvents.emit('activate');
    assert.equal(state.windows[0]!.options.webPreferences.session, fake.trustedSession, '恢复窗口沿用已授权 session');
    assert.equal(state.partitions.length, 1);
    state.appEvents.emit('before-quit');
    assert.equal(state.clearCount, 1);
  } finally { restore(); }
});

test('desktop auth: cookie 注入失败不开窗，错误框不泄露凭证', async () => {
  let failCookie!: (error: Error) => void;
  const cookieGate = new Promise<void>((_resolveGate, rejectGate) => { failCookie = rejectGate; });
  const { state, restore } = await bootRealMain({ cookieGate, inspectPending: async ({ state }) => {
    await waitFor(() => state.cookies.length === 1);
    failCookie(new Error(TEST_LOCAL_TOKEN));
  } });
  try {
    assert.equal(state.windows.length, 0);
    assert.equal(state.loadedUrls.length, 0);
    assert.match(state.errorBoxes[0]!, /安全会话/);
    assert.ok(!state.errorBoxes.join('').includes(TEST_LOCAL_TOKEN));
  } finally { restore(); }
});

test('desktop auth: 无可信 IPC 不开窗；错误 origin/port/protocol 和非法 token 全部 fail closed', async () => {
  const noReady = await bootRealMain({ ready: false });
  try {
    assert.equal(noReady.state.windows.length, 0);
    assert.equal(noReady.state.cookies.length, 0);
    assert.match(noReady.state.errorBoxes[0]!, /IPC/);
  } finally { noReady.restore(); }
  for (const ready of [
    { url: 'http://127.0.0.1:43124' }, { url: 'https://127.0.0.1:43123' },
    { url: 'http://localhost:43123' }, { url: 'http://evil.example:43123' },
    { url: 'http://127.0.0.1:43123@evil.example/' }, { url: 'http://127.0.0.1:43123/extra' },
    { localToken: 'bad\r\nvalue' },
  ]) {
    const result = await bootRealMain({ ready });
    try {
      assert.equal(result.state.windows.length, 0);
      assert.equal(result.state.cookies.length, 0);
      assert.equal(result.state.partitions.length, 0);
      assert.match(result.state.errorBoxes[0]!, /IPC/);
      assert.ok(!result.state.errorBoxes.join('').includes(TEST_LOCAL_TOKEN));
    } finally { result.restore(); }
  }
});

test('desktop auth: 仅相同 origin 保留 Cookie，跨端口/主机/协议和前缀欺骗导航被拦截', async () => {
  const { state, restore } = await bootRealMain();
  try {
    for (const target of ['http://127.0.0.1:43123/api/x', 'http://127.0.0.1:43124/api/x',
      'https://127.0.0.1:43123/', 'http://localhost:43123/', 'http://127.0.0.1:43123@evil.example/',
      'http://127.0.0.1:431230/', 'not-a-url']) {
      const trusted = target === 'http://127.0.0.1:43123/api/x';
      let result: any;
      state.beforeHeaders!({ url: target, requestHeaders: { Cookie: `alkaid_local=${TEST_LOCAL_TOKEN}`, cookie: 'other=1', Accept: '*/*' } }, (next) => { result = next; });
      assert.equal(Object.hasOwn(result.requestHeaders, 'Cookie'), trusted, target);
      assert.equal(Object.hasOwn(result.requestHeaders, 'cookie'), trusted, target);
      assert.equal(result.requestHeaders.Accept, '*/*');
      for (const eventName of ['will-navigate', 'will-redirect']) {
        let prevented = false;
        (state.windows[0] as any).handlers.get(eventName)({ preventDefault: () => { prevented = true; } }, target);
        assert.equal(prevented, !trusted, `${eventName}: ${target}`);
      }
    }
  } finally { restore(); }
});

test('desktop auth: 显式禁用本机鉴权时仍需可信 ready，但不设置 cookie', async () => {
  const { state, restore } = await bootRealMain({ ready: { localToken: null } });
  try {
    assert.equal(state.windows.length, 1);
    assert.deepEqual(state.cookies, []);
  } finally { restore(); }
});

test('desktop main: BrowserWindow 挂上 preload，且 contextIsolation/nodeIntegration/sandbox 三项显式正确', async () => {
  const { state, restore } = await bootRealMain();
  try {
    assert.equal(state.windows.length, 1, '应该只造一个窗口');
    const prefs = state.windows[0]!.options.webPreferences;
    // ★ 用真实磁盘路径比对，防止写错文件名/相对路径。
    assert.equal(prefs.preload, PRELOAD_CJS, 'preload 必须指向 desktop/preload.cjs 的真实绝对路径');
    assert.ok(existsSync(prefs.preload), 'preload 文件必须真的存在');
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.sandbox, true);
    assert.match(state.loadedUrls[0]!, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(state.errorBoxes, [], '启动流程不该弹错误框');
    assert.equal(state.quitSignalled(), false, '启动成功不该退出');
  } finally {
    restore();
  }
});

test('desktop main: 注册了 alkaid:pick-directory，且只弹 openDirectory 对话框', async () => {
  const { state, fake, restore } = await bootRealMain();
  try {
    assert.ok(state.handlers.has('alkaid:pick-directory'), 'ipcMain 必须注册 alkaid:pick-directory');
    fake.setDialogResponse(() => ({ canceled: false, filePaths: ['C:\\work\\demo'] }));
    const picked = await state.handlers.get('alkaid:pick-directory')!({ sender: {} });
    assert.equal(picked, 'C:\\work\\demo');
    assert.equal(state.openDialogCalls.length, 1);
    assert.deepEqual(state.openDialogCalls[0]!.options, { properties: ['openDirectory'] });
    // 有窗口时应该挂在窗口上（模态对话框），不是无父窗口的散装对话框
    assert.equal(state.openDialogCalls[0]!.parent, state.windows[0]);
  } finally {
    restore();
  }
});

test('desktop main: 取消 / 异常 / 空结果一律返回 null，绝不 reject 到渲染进程', async () => {
  const { state, fake, restore } = await bootRealMain();
  try {
    const handle = state.handlers.get('alkaid:pick-directory')!;
    const cases: Array<[string, () => any, string | null]> = [
      ['用户取消', () => ({ canceled: true, filePaths: [] }), null],
      ['取消了但带了路径', () => ({ canceled: true, filePaths: ['C:\\still\\canceled'] }), null],
      ['对话框抛异常', () => { throw new Error('boom'); }, null],
      ['返回 undefined', () => undefined, null],
      ['filePaths 为空', () => ({ canceled: false, filePaths: [] }), null],
      ['filePaths 缺失', () => ({ canceled: false }), null],
      ['空字符串路径', () => ({ canceled: false, filePaths: [''] }), null],
      ['正常选中', () => ({ canceled: false, filePaths: ['D:\\ws\\a'] }), 'D:\\ws\\a'],
    ];
    for (const [name, responder, expected] of cases) {
      fake.setDialogResponse(responder);
      let value: unknown;
      await assert.doesNotReject(async () => {
        value = await handle({ sender: {} });
      }, `${name}：handler 不该抛错`);
      assert.equal(value, expected, `${name}：返回值应为 ${String(expected)}`);
    }
  } finally {
    restore();
  }
});

test('desktop main: 拿不到窗口时退化成无父窗口对话框，仍然工作', async () => {
  const { state, fake, restore } = await bootRealMain();
  try {
    const window = state.windows[0]!;
    const originalFrom = (fake.electron.BrowserWindow as any).fromWebContents;
    (fake.electron.BrowserWindow as any).fromWebContents = () => null;
    try {
      fake.setDialogResponse(() => ({ canceled: false, filePaths: ['E:\\no-parent'] }));
      const picked = await state.handlers.get('alkaid:pick-directory')!({ sender: {} });
      assert.equal(picked, 'E:\\no-parent');
      assert.equal(state.openDialogCalls.at(-1)!.parent, null);
      assert.deepEqual(state.openDialogCalls.at(-1)!.options, { properties: ['openDirectory'] });
    } finally {
      (fake.electron.BrowserWindow as any).fromWebContents = originalFrom;
      void window;
    }
  } finally {
    restore();
  }
});

test('desktop preload: contextBridge 只暴露 alkaidDesktop，pickDirectory 永不 reject', async () => {
  const exposed: Array<{ key: string; api: any }> = [];
  let invokeCalls: string[] = [];
  let invokeBehavior: () => Promise<any> = async () => 'D:\\chosen\\dir';
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, api: any) => void exposed.push({ key, api }),
    },
    ipcRenderer: {
      invoke: (channel: string) => {
        invokeCalls.push(channel);
        return invokeBehavior();
      },
    },
  };

  await withPatchedLoads({ electron }, async () => {
    freshRequire(PRELOAD_CJS);

    assert.equal(exposed.length, 1, '只该暴露一个对象');
    assert.equal(exposed[0]!.key, 'alkaidDesktop');
    const api = exposed[0]!.api;
    assert.equal(api.available, true, 'available 必须为 true');
    assert.equal(typeof api.pickDirectory, 'function');

    const picked = await api.pickDirectory();
    assert.equal(picked, 'D:\\chosen\\dir');
    assert.deepEqual(invokeCalls, ['alkaid:pick-directory'], '必须走约定的 IPC 通道');

    // 主进程返回 null（取消）⇒ null
    invokeBehavior = async () => null;
    assert.equal(await api.pickDirectory(), null);

    // 主进程返回非字符串（防御）⇒ null
    invokeBehavior = async () => 42;
    assert.equal(await api.pickDirectory(), null);

    // 空字符串 ⇒ null
    invokeBehavior = async () => '';
    assert.equal(await api.pickDirectory(), null);

    // IPC 通道本身异常 ⇒ null，不许 reject
    invokeBehavior = async () => {
      throw new Error('channel broken');
    };
    let rejected: unknown = 'unset';
    await assert.doesNotReject(async () => {
      rejected = await api.pickDirectory();
    });
    assert.equal(rejected, null);
  });
});

test('desktop preload: 非 Electron 环境下安静降级，不抛错也不暴露任何东西', async () => {
  // ① 纯 Node 里 `require('electron')` 的真实返回值就是一个路径字符串（不是对象）
  await withPatchedLoads({ electron: 'C:\\fake\\electron.exe' }, async () => {
    const exposed: unknown[] = [];
    void exposed;
    assert.doesNotThrow(() => freshRequire(PRELOAD_CJS));
  });

  // ② 空对象（既没有 contextBridge 也没有 ipcRenderer）
  await withPatchedLoads({ electron: {} }, async () => {
    assert.doesNotThrow(() => freshRequire(PRELOAD_CJS));
  });

  // ③ 有 contextBridge 但暴露动作本身抛错 ⇒ 也必须被吞掉
  const exposedKeys: string[] = [];
  await withPatchedLoads(
    {
      electron: {
        contextBridge: {
          exposeInMainWorld: (key: string) => {
            exposedKeys.push(key);
            throw new Error('namespace collision');
          },
        },
        ipcRenderer: { invoke: async () => null },
      },
    },
    async () => {
      assert.doesNotThrow(() => freshRequire(PRELOAD_CJS));
    },
  );
  assert.deepEqual(exposedKeys, ['alkaidDesktop'], '确实尝试过暴露（说明走了正常分支），只是异常被吞掉');
});

test('desktop preload: 真子进程（纯 Node，无任何桩）里 require 不报错', () => {
  // ★ 不是桩：真起一个 node，真的让 require('electron') 落到 npm 包（返回路径字符串）。
  const stdout = execFileSync(
    process.execPath,
    ['-e', `require(${JSON.stringify(PRELOAD_CJS)}); process.stdout.write('preload-ok');`],
    { cwd: APP_ROOT, encoding: 'utf8' },
  );
  assert.equal(stdout, 'preload-ok');
});

test('packaging: build-dist 与两个同步脚本的清单都含 desktop，整目录复制确实带上 preload.cjs', () => {
  const buildDist = readFileSync(join(APP_ROOT, 'scripts', 'build-dist.mjs'), 'utf8');
  // build-dist 里有多个 `for (const entry of [...])`：挑"整目录复制源码/资源"那一条（含 'src'）。
  const entryLists = [...buildDist.matchAll(/for \(const entry of \[([^\]]*)\]\)/g)].map((match) => match[1]!);
  const treeList = entryLists.find((list) => list.includes("'src'"));
  assert.ok(treeList, 'build-dist.mjs 里应能找到整目录复制的清单（含 src 的那条）');
  assert.match(treeList!, /'desktop'/, 'build-dist 的整目录复制清单必须含 desktop（否则 preload 进不了安装包）');

  const syncRelease = readFileSync(join(APP_ROOT, 'scripts', 'sync-release.mjs'), 'utf8');
  assert.match(syncRelease, /copyDir\(join\(ROOT, 'desktop'\)/, 'sync-release.mjs 必须整目录同步 desktop/');

  const syncSafe = readFileSync(join(APP_ROOT, 'scripts', 'sync-release-safe.mjs'), 'utf8');
  const treesLine = syncSafe.split('\n').find((line) => line.includes('const trees ='));
  assert.ok(treesLine, 'sync-release-safe.mjs 里应能找到 trees 清单');
  assert.match(treesLine!, /'desktop'/, 'sync-release-safe.mjs 的同步树必须含 desktop');

  // 真复现一次「整目录复制」，证明 cpSync 会把 preload.cjs 带过去。
  const stage = mkdtempSync(join(tmpdir(), 'alkaid-stage-'));
  try {
    cpSync(join(APP_ROOT, 'desktop'), join(stage, 'desktop'), { recursive: true });
    assert.ok(existsSync(join(stage, 'desktop', 'preload.cjs')), '整目录复制后必须存在 desktop/preload.cjs');
    assert.ok(existsSync(join(stage, 'desktop', 'main.cjs')), '整目录复制后必须存在 desktop/main.cjs');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
