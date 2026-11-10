/**
 * 一键打出可双击运行的 Windows 桌面端：`release/YaoGuang-win32-x64/YaoGuang.exe`
 *
 * 为什么这么绕（staging + npm 安装）：
 * 1. 本项目的依赖是 **pnpm** 装的（符号链接 + .pnpm 虚拟store），electron-packager 的
 *    prune 逻辑会解析失败（实测报 `Failed to locate module "@fastify/accept-negotiator"`）；
 * 2. 所以先把「只该出厂的东西」复制到 `release/stage`，在那里用 **npm** 做一次
 *    `--omit=dev` 的扁平安装（真目录、无符号链接），再对 stage 打包；
 * 3. npm 默认不跑安装脚本 ⇒ koffi 的原生二进制要单独 build（`node ./cnoke.cjs ... --prebuild`）。
 *
 * 跑法：`node scripts/build-dist.mjs`（需要本机有 node + npm；Electron 已在 devDependencies）
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(ROOT, 'release');
const STAGE = join(RELEASE, 'stage');
const APP_NAME = 'YaoGuang';
const ELECTRON_VERSION = '45.2.3';
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd) {
  console.log(`\n$ ${command} ${args.join(' ')}  (${cwd})`);
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
}

// ① 前端产物
run(PNPM, ['web:build'], ROOT);

// ② 干净 stage
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const entry of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  cpSync(join(ROOT, entry), join(STAGE, entry));
}
for (const entry of ['src', 'dist', 'plugins', 'assets', 'desktop']) {
  cpSync(join(ROOT, entry), join(STAGE, entry), { recursive: true });
}

// ③ 扁平的生产依赖（npm 才有真目录；pnpm 的符号链接会让 packager 解析失败）
run(NPM, ['install', '--omit=dev', '--no-audit', '--no-fund'], STAGE);

// ④ koffi 的原生二进制（npm 不跑安装脚本）
const koffiDir = join(STAGE, 'node_modules', 'koffi');
const koffiBinary = ['build', 'koffi.node'].join('/');
if (existsSync(koffiDir)) {
  const probe = execFileSync(process.execPath, ['-e', "require('koffi'); console.log('ok')"], {
    cwd: STAGE,
    encoding: 'utf8',
  }).trim();
  console.log(`koffi 自检: ${probe}`);
} else {
  throw new Error('stage 里没有 koffi');
}
void koffiBinary;

// ⑤ 打包
const packager = join(ROOT, 'node_modules', '@electron', 'packager', 'bin', 'electron-packager.js');
run(
  process.execPath,
  [
    packager,
    STAGE,
    APP_NAME,
    '--platform=win32',
    '--arch=x64',
    `--electron-version=${ELECTRON_VERSION}`,
    `--out=${RELEASE}`,
    `--icon=${join(ROOT, 'assets', 'icon.ico')}`,
    '--asar=false',
    '--overwrite',
    '--prune=false',
  ],
  ROOT,
);

console.log(`
完成：${join(RELEASE, `${APP_NAME}-win32-x64`, `${APP_NAME}.exe`)}
提示：桌面快捷方式用 scripts/make-shortcut.mjs 生成。
`);
