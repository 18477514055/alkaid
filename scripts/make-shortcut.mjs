/**
 * 在桌面放一个「瑶光」快捷方式，指向打包好的 exe，并用我们自己的图标。
 *
 * 跑法：`node scripts/make-shortcut.mjs`
 * 说明：图标用 exe 同级 resources/app/assets/icon.ico —— 换图标后重跑本脚本即可。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(ROOT, 'release', 'YaoGuang-win32-x64', 'YaoGuang.exe');
const ICON = join(ROOT, 'release', 'YaoGuang-win32-x64', 'resources', 'app', 'assets', 'icon.ico');

if (!existsSync(EXE)) {
  console.error(`找不到 exe：${EXE}\n先跑 node scripts/build-dist.mjs`);
  process.exit(1);
}

const desktop = join(homedir(), 'Desktop');
const shortcutPath = join(desktop, '瑶光.lnk');

/**
 * ★ 2026-11-11 审计 `ALK-P3-④`：路径是**拼进 PowerShell 脚本**的，必须转义单引号。
 *   PowerShell 单引号字符串里 `'` 的转义是 `''`。不转义时，一个带单引号的用户名/路径
 *   就能让整段脚本语法错乱（坏的话是报错，坏得刚刚好就是**注入**）。
 */
function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const script = `
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut(${psQuote(shortcutPath)})
$sc.TargetPath = ${psQuote(EXE)}
$sc.WorkingDirectory = ${psQuote(dirname(EXE))}
${existsSync(ICON) ? `$sc.IconLocation = ${psQuote(`${ICON},0`)}` : ''}
$sc.Description = '瑶光 —— 本地个人 Agent'
$sc.Save()
Write-Output $sc.FullName
`;

execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' });
console.log(`快捷方式已创建：${shortcutPath}`);
