import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/**
 * 把当前构建产物同步进打包版（`release/YaoGuang-win32-x64/resources/app/`）。
 *
 * ★ 为什么需要它：`build-dist.mjs` 要重装依赖、跑几分钟；而**只改了前端与内核源码**时，
 *   直接覆盖文件即可（node_modules 与原生二进制不受影响）。
 * ★ 必须删掉旧的 `index-<hash>.css/js` —— 打包版的 index.html 是按文件名引用的，
 *   留着旧的两份会越堆越多，将来排查"改了没生效"会疯。
 * ★★ **整个 `src/` 一起覆盖**：早先只列了几个文件，结果新增的模块（如 `core/model/presets.ts`、
 *    `presets.json`）没被同步 ⇒ 打包版内核一启动就 import 失败、端口都起不来。
 *   内核源码总量很小，整目录覆盖既简单又不会再漏。
 */
/**
 * ★ 用 `import.meta.dirname` 推导仓库根，不写死绝对路径 ——
 *   写死之后任何人的机器上都跑不了（本机是 `D:/…`，别人可能是别处）。
 */
const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'release/YaoGuang-win32-x64/resources/app');

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) {
      copyDir(src, dst);
    } else {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
}

/**
 * ★★ 2026-11-11 审计 `ALK-P3-④`：**桌面端在跑的时候不许同步**。
 *
 * 这个脚本会覆盖 `resources/app/` 下的源码与产物。而 `YaoGuang.exe` 正在运行时，
 * Node 已经把内核源码读进内存 —— 覆盖不会立刻炸，但**下一次重启**会加载"一半新一半旧"的树，
 * 症状是 import 失败或行为诡异。更直接的是 Windows 会锁住正在执行的文件（EBUSY），
 * 脚本会停在一半、留下**半同步**的打包版。
 *
 * 判据：发现有 `YaoGuang.exe` 就跑都不跑。确实要强制（离线修构建）用 `--force`。
 */
function runningInstances() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq YaoGuang.exe', '/NH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (out.match(/YaoGuang\.exe/gi) ?? []).length;
  } catch {
    return 0; // tasklist 不可用（非 Windows）就当没有
  }
}

const forced = process.argv.includes('--force');
const running = runningInstances();
if (running > 0 && !forced) {
  console.error(
    `桌面端正开着（${String(running)} 个 YaoGuang.exe）。请先退出桌面端再同步 ——\n` +
      '  正在运行时覆盖 resources/app 会留下"一半新一半旧"的打包版，下次启动才会出问题。\n' +
      '  确实要强制：加 --force（不推荐）。',
  );
  process.exit(1);
}

copyDir(join(ROOT, 'dist/web'), join(APP, 'dist/web'));
copyDir(join(ROOT, 'src'), join(APP, 'src'));
// ★ 桌面壳也整目录覆盖：`desktop/preload.cjs` 和 `main.cjs` 必须一起进打包版，
//   少了 preload（或版本对不上）症状是"窗口能开、但添加工作区按钮没反应"，很难想得到。
copyDir(join(ROOT, 'desktop'), join(APP, 'desktop'));
console.log('内核：整个 src/ 已覆盖；桌面壳：整个 desktop/ 已覆盖');

// 清掉 index.html 没引用的旧资源
const indexHtml = readFileSync(join(APP, 'dist/web/index.html'), 'utf8');
const keep = new Set([...indexHtml.matchAll(/assets\/(index-[^"']+\.(?:css|js))/g)].map((m) => m[1]));
const assetsDir = join(APP, 'dist/web/assets');
let removed = 0;
for (const file of readdirSync(assetsDir)) {
  if (keep.has(file)) continue;
  rmSync(join(assetsDir, file));
  removed += 1;
  console.log(`删除旧资源：${file}`);
}

console.log(`\n保留：${[...keep].join(', ')}`);
console.log(`删除 ${removed} 个旧文件；打包版已同步。`);
