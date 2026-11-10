import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
