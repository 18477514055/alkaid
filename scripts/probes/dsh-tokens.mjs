/**
 * 把 DSH 主题里 `--dsw-static-*` 与 `--dsw-alias-*` 的定义抽成一张对照表（只读）。
 *
 * 为什么单独写：这两个命名空间在 136 KB 的 client.js 里是两条超长 CSS 文本，
 * 直接眼看会漏。这里按 `--name: value` 逐条切，再按前缀分组打印。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = process.argv[2];
const OUT = process.argv[3];

const text = readFileSync(SRC, 'utf8');

function collect(prefix) {
  const out = new Map();
  const re = new RegExp(`(${prefix}[a-z0-9-]+)\\s*:\\s*([^;}]{1,160})`, 'g');
  for (const match of text.matchAll(re)) {
    const name = match[1];
    const value = match[2].trim();
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

const statics = collect('--dsw-static-');
const aliases = collect('--dsw-alias-');
const fonts = collect('--dsw-font-');
const radius = collect('--dsw-radius-');

const sections = [
  ['static（原始色板）', statics],
  ['alias（语义别名）', aliases],
  ['font（字体与字号）', fonts],
  ['radius（圆角）', radius],
];

let out = '';
for (const [title, map] of sections) {
  out += `\n## ${title} —— ${map.size} 条\n`;
  for (const [name, value] of [...map.entries()].sort()) out += `${name}: ${value}\n`;
}
console.log(out);
if (OUT !== undefined) writeFileSync(OUT, out, 'utf8');
