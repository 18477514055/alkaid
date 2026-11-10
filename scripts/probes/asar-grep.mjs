/**
 * 在 app.asar 里全文搜索一个字符串（只读）—— 用来找出 `--dsw-alias-*` 这类令牌到底定义在哪。
 *
 * 用法：node scripts/probes/asar-grep.mjs <asar> <正则> [最多显示几个]
 */
import { readFileSync } from 'node:fs';

const ASAR = process.argv[2];
const PATTERN = new RegExp(process.argv[3], 'i');
const LIMIT = Number.parseInt(process.argv[4] ?? '10', 10);

const buf = readFileSync(ASAR);
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
const dataStart = 16 + headerSize;

const files = [];
function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (child.files !== undefined) {
      walk(child, path);
      continue;
    }
    if (child.offset === undefined || child.size === undefined) continue;
    if (child.size > 8_000_000) continue;
    files.push({ path, offset: Number(child.offset), size: Number(child.size), unpacked: child.unpacked === true });
  }
}
walk(header, '');

let shown = 0;
let scanned = 0;
for (const file of files) {
  if (file.unpacked) continue;
  if (!/\.(css|js|mjs|cjs|json|html|md)$/i.test(file.path)) continue;
  scanned += 1;
  const slice = buf.subarray(dataStart + file.offset, dataStart + file.offset + file.size);
  const text = slice.toString('utf8');
  const hit = PATTERN.exec(text);
  if (hit === null) continue;
  console.log(`\n=== ${file.path} (${(file.size / 1024).toFixed(1)} KB) @${hit.index} ===`);
  const from = Math.max(0, hit.index - 160);
  console.log(text.slice(from, hit.index + 400).replace(/\n/g, '\\n'));
  shown += 1;
  if (shown >= LIMIT) break;
}
console.log(`\n扫描 ${scanned} 个文本文件，命中 ${shown} 个（上限 ${LIMIT}）`);
