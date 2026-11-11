/**
 * Alkaid 桌面壳（Electron 主进程）。
 *
 * ★ 用 CommonJS（`.cjs`）：Electron 主进程里 `require('electron')` 会命中 Electron 内置模块，
 *   拿到的是 API 对象；而 ESM 命名导入会绕过那层拦截、落到 npm 包本身（导出的只是一个路径字符串），
 *   实测会报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
 *
 * ## 为什么是"套壳"而不是重写 UI
 * V0.1 的形态**本来就是**本地内核 + 浏览器界面（决策 D4）。桌面化只是把
 * "你自己去开浏览器"换成"应用自己开一个窗口"，界面一行不改。以后出 Web 版、手机版，
 * 还是同一套内核与同一套页面。
 *
 * ## 分工
 * - 主进程：拉起内核子进程、等它就绪、开窗口、退出时收尾。
 * - 内核：`node src/main.ts`，监听 127.0.0.1，数据放在 Electron 的 userData 下。
 * - 窗口：只加载内核提供的 HTTP 页面（contextIsolation 开、nodeIntegration 关、sandbox 开）。
 *   `desktop/preload.cjs` 只往外递一个能力：`window.alkaidDesktop.pickDirectory()`（选工作区目录）。
 *
 * ## 已知边界（V0.2，不粉饰）
 * - 需要本机有 `node`（或用 `ALKAID_NODE` 指定）。**打包分发还没做**。
 * - 默认随机端口，避免和开发实例撞车（`ALKAID_PORT` 可固定，验证时就是这么干的）。
 */
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync, mkdirSync } = require('node:fs');
const { createServer } = require('node:net');
const { join } = require('node:path');

const { BrowserWindow, Menu, app, dialog, ipcMain, session, shell } = require('electron');

// ★ 真实踩过：如果父进程（例如另一个 Electron 应用、或从它派生的终端）带着
//   `ELECTRON_RUN_AS_NODE=1`，Electron 二进制会**退化成普通 node**，
//   `require('electron')` 只会拿到一个路径字符串 ⇒ app 为 undefined。
//   这里给一句能看懂的提示，而不是抛 TypeError。
if (!app) {
  console.error(
    '[alkaid-desktop] 检测到 Electron 以纯 Node 模式运行（多半是继承了 ELECTRON_RUN_AS_NODE=1）。\n' +
      '请在启动前清掉这个环境变量：PowerShell 里执行  Remove-Item Env:ELECTRON_RUN_AS_NODE',
  );
  process.exit(1);
}

const appRoot = join(__dirname, '..');

/**
 * 「添加工作区」用：让页面能唤起系统目录选择器（见 desktop/preload.cjs）。
 *
 * ★ 契约：**永远不向渲染进程抛错**。用户取消 ⇒ null；任何异常（窗口已销毁、对话框失败、
 *   平台不支持）⇒ null。前端只需要判断 `null`，不用 try/catch。
 * ★ 在模块加载时就注册，早于任何窗口创建/页面加载，避免页面先调了却没人接。
 */
ipcMain.handle('alkaid:pick-directory', async (event) => {
  try {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory'] };
    // 挂在父窗口上 ⇒ 模态、居中、跟随应用图标；万一拿不到窗口就退化成无父窗口的对话框。
    const result = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
    if (!result || result.canceled) return null;
    const picked = Array.isArray(result.filePaths) ? result.filePaths[0] : undefined;
    return typeof picked === 'string' && picked.length > 0 ? picked : null;
  } catch {
    return null;
  }
});

let kernel = null;
let win = null;
let shuttingDown = false;
let desktopSession = null;

function pickPort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

// 公开 health 只能说明有 HTTP 服务，不能证明是我们启动的内核。只信任这个 child 的私有 IPC。
function waitForKernel(child, expectedOrigin, timeoutMs = 30_000) {
  return new Promise((resolveReady, rejectReady) => {
    const finish = (error, ready) => {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('disconnect', onDisconnect);
      if (error) rejectReady(error);
      else resolveReady(ready);
    };
    const onError = () => finish(new Error('内核 IPC 启动失败'));
    const onExit = () => finish(new Error('内核在可信就绪前已退出'));
    const onDisconnect = () => finish(new Error('内核在可信就绪前断开 IPC'));
    const onMessage = (message) => {
      if (!message || message.type !== 'alkaid:ready') return;
      try {
        const parsed = new URL(message.url);
        if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
            parsed.origin !== expectedOrigin || parsed.username || parsed.password ||
            parsed.pathname !== '/' || parsed.search || parsed.hash ||
            (message.localToken !== null &&
              (typeof message.localToken !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(message.localToken)))) {
          throw new Error('invalid ready');
        }
        finish(null, { url: parsed.origin, localToken: message.localToken });
      } catch {
        // 不 stringify message/error：它可能含凭证，绝不能进入日志或错误框。
        finish(new Error('内核 IPC 就绪消息不合法或来源不匹配'));
      }
    };
    const timer = setTimeout(() => finish(new Error('内核在超时前没有发送可信 IPC 就绪消息')), timeoutMs);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('disconnect', onDisconnect);
  });
}

function startKernel(port, home) {
  const entry = join(appRoot, 'src', 'main.ts');
  if (!existsSync(entry)) throw new Error(`找不到内核入口：${entry}`);

  // ★ 用 Electron 自带的 Node 跑内核（ELECTRON_RUN_AS_NODE=1），这样**打包后不需要用户装 node**。
  //   Electron 45 内置 Node 24，支持直接跑 .ts（type stripping 不需要额外 flag）。
  //   想用系统 node 时给 ALKAID_NODE 指定路径即可。
  const explicitNode = process.env.ALKAID_NODE;
  const nodeBin = explicitNode || process.execPath;
  const env = {
    ...process.env,
    ALKAID_HOME: home,
    ALKAID_PORT: String(port),
  };
  if (!explicitNode) env.ELECTRON_RUN_AS_NODE = '1';
  if (env.ALKAID_PLUGINS === undefined) env.ALKAID_PLUGINS = join(appRoot, 'plugins');

  const child = spawn(nodeBin, [entry], {
    cwd: appRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout.on('data', (chunk) => process.stdout.write(`[kernel] ${String(chunk)}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[kernel] ${String(chunk)}`));

  child.on('exit', (code) => {
    kernel = null;
    if (shuttingDown) return;
    dialog.showErrorBox('Alkaid 内核已退出', `内核进程退出（code=${String(code)}）。\n应用将关闭。`);
    app.quit();
  });

  return child;
}

/**
 * 把外部链接交给系统默认浏览器。
 * ★ 只放行 http/https：`file:` / `javascript:` / 自定义协议交给 `shell.openExternal`
 *   等于把一个"打开任意本机程序/文件"的开关交到页面手里（审计 `ALK-CRIT-05`）。
 */
function openExternally(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  void shell.openExternal(target);
}

function createWindow(url, trustedSession) {
  const expectedOrigin = new URL(url).origin;
  const iconPath = join(appRoot, 'assets', 'icon.png');
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#f6f6f7',
    title: '瑶光',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      // ★ 显式写全（都是安全默认值，写出来是为了不让后人"顺手"打开其中任何一个）：
      //   页面只通过 preload 里的 contextBridge 拿到白名单 API。
      preload: join(__dirname, 'preload.cjs'),
      session: trustedSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 外链交给系统浏览器，**不在应用内打开**（应用内没有地址栏，用户看不出来源）
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternally(target);
    return { action: 'deny' };
  });

  /**
   * ★★ 2026-11-11 审计 `ALK-CRIT-05`：拦住**主窗口自己**被导航走。
   *
   * `setWindowOpenHandler` 只管 `target="_blank"` / `window.open`。如果页面里有
   * `location.href = 'https://evil.example'`（Markdown 里的链接被点、或渲染层出洞），
   * 主窗口会直接变成那个外部站点 —— 而它挂着 `preload.cjs`（有 `pickDirectory` 能力），
   * 用户也看不出地址变了（应用内没有地址栏）。
   * 判据：只允许留在**我们自己的内核 origin** 里，其余一律拦下并交给系统浏览器。
   */
  const guardNavigation = (event, target) => {
    try {
      if (new URL(target).origin === expectedOrigin) return;
    } catch {
      // 无法解析的地址也不得进入带 preload 的窗口。
    }
    event.preventDefault();
    openExternally(target);
  };
  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
  // 新窗口（含 target=_blank 的 webview）一律不给开
  window.webContents.on('did-create-window', (child) => {
    child.close();
  });

  window.on('closed', () => {
    win = null;
  });

  void window.loadURL(url);
  return window;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录',
          click: () => {
            const home = process.env.ALKAID_HOME || join(app.getPath('userData'), 'data');
            void shell.openPath(home);
          },
        },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win !== null) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const home = process.env.ALKAID_HOME || join(app.getPath('userData'), 'data');
      mkdirSync(home, { recursive: true });

      const pinned = Number(process.env.ALKAID_PORT || '0');
      const port = Number.isInteger(pinned) && pinned > 0 && pinned <= 65535 ? pinned : await pickPort();

      kernel = startKernel(port, home);
      const ready = await waitForKernel(kernel, `http://127.0.0.1:${port}`);
      const url = ready.url;
      try {
        if (shuttingDown) return;
        // 非 persist 分区：每次启动随机、禁缓存，cookie 不进入默认/磁盘持久化 session。
        desktopSession = session.fromPartition(`alkaid-${randomUUID()}`, { cache: false });
        // Cookie 标准不隔离端口；子资源/fetch/重定向也必须做 exact-origin 出站过滤。
        desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
          const requestHeaders = { ...details.requestHeaders };
          let trusted = false;
          try { trusted = new URL(details.url).origin === url; } catch { /* fail closed */ }
          if (!trusted) {
            for (const name of Object.keys(requestHeaders)) {
              if (name.toLowerCase() === 'cookie') delete requestHeaders[name];
            }
          }
          callback({ requestHeaders });
        });
        if (ready.localToken !== null) {
          await desktopSession.cookies.set({
            url,
            name: 'alkaid_local',
            value: ready.localToken,
            httpOnly: true,
            sameSite: 'strict',
            path: '/',
          });
        }
      } catch {
        throw new Error('无法建立桌面专用安全会话');
      } finally {
        ready.localToken = null;
      }
      if (shuttingDown) return;

      buildMenu();
      win = createWindow(url, desktopSession);

      app.on('activate', () => {
        if (!shuttingDown && BrowserWindow.getAllWindows().length === 0) win = createWindow(url, desktopSession);
      });

      console.log(`[alkaid-desktop] 已就绪 ${url}（数据目录 ${home}）`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox('Alkaid 启动失败', `${message}\n\n请确认本机有 node（或用 ALKAID_NODE 指定）。`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    shuttingDown = true;
    if (desktopSession !== null) {
      void desktopSession.clearStorageData().catch(() => { /* 内存分区退出时也会销毁；尽力清理 */ });
    }
    if (kernel !== null) {
      try {
        kernel.kill();
      } catch {
        /* ignore */
      }
      kernel = null;
    }
  });
}
