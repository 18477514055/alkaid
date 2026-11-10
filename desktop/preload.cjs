/**
 * Alkaid 桌面壳的预加载脚本（preload）。
 *
 * 职责只有一个：把「唤起系统目录选择器」这条能力递给页面，别的一概不递。
 * 页面拿不到 Node、拿不到原始 `ipcRenderer`，只能看到下面这一个小对象。
 *
 * ## 运行环境（与 main.cjs 的 webPreferences 一一对应）
 * - `contextIsolation: true`：preload 与页面在两个隔离的 JS 世界里，唯一通道是 `contextBridge`。
 * - `sandbox: true`：沙箱里的 preload 只能 `require('electron')`（拿到 contextBridge / ipcRenderer
 *   等极少几个），拿不到 `node:fs` 之类。本文件正好只用到 electron，没有多余依赖。
 * - `nodeIntegration: false`：页面自己 require 不到任何东西。
 *
 * ## 降级（★ 必须优雅，不许把 preload 挂掉）
 * 网页也可能在**普通浏览器**里打开（同一套 UI 走 `http://127.0.0.1:<port>`）：
 * 那种情况下 preload 根本不会执行，`window.alkaidDesktop` 自然不存在，前端据此判断即可。
 * 但如果这个文件被纯 Node require 到（本机实测：纯 Node 里 `require('electron')` 只返回
 * 一个指向 electron 可执行文件**路径字符串**），下面也必须**安静地什么都不做**，绝不抛错。
 *
 * ## 对外 API 形状（前端用它）
 * ```js
 * if (window.alkaidDesktop?.available) {
 *   const dir = await window.alkaidDesktop.pickDirectory(); // string（绝对路径）| null
 *   if (dir !== null) { ...用户选了目录... } else { ...用户取消或调用失败... }
 * }
 * ```
 * - `available`：恒为 `true`（对象存在即代表这套桥可用）。
 * - `pickDirectory()`：**永不 reject**。用户取消、对话框出错、IPC 断开，一律 resolve 成 `null`。
 */
(function exposeAlkaidDesktopBridge() {
  /** 纯浏览器/纯 Node 下会是字符串、null 或干脆抛错 —— 都按「没有宿主」处理。 */
  let host = null;
  try {
    host = require('electron');
  } catch {
    return;
  }
  if (host === null || typeof host !== 'object') return;

  const { contextBridge, ipcRenderer } = host;
  if (contextBridge === undefined || typeof contextBridge.exposeInMainWorld !== 'function') return;
  if (ipcRenderer === undefined || typeof ipcRenderer.invoke !== 'function') return;

  const api = Object.freeze({
    available: true,
    /**
     * 让主进程弹系统目录选择器。
     * @returns {Promise<string|null>} 选中目录的绝对路径；取消/失败为 null。
     */
    async pickDirectory() {
      try {
        const picked = await ipcRenderer.invoke('alkaid:pick-directory');
        return typeof picked === 'string' && picked.length > 0 ? picked : null;
      } catch {
        /* 主进程那边已经保证不抛；这里再兜一层，防止通道异常把 Promise 变成 reject */
        return null;
      }
    },
  });

  try {
    contextBridge.exposeInMainWorld('alkaidDesktop', api);
  } catch {
    /* 例如同一上下文里被注入两次：宁可不暴露，也不要让异常冒出来影响页面 */
  }
})();
