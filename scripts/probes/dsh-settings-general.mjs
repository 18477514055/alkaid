// 直接抽出 DSH settings-general 的 client.js，找它到底有哪些设置行与默认值
import { readFileSync, writeFileSync } from 'node:fs';

const ASAR = 'C:/Users/24239/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
const buf = readFileSync(ASAR);
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
const dataStart = 16 + headerSize;

function find(pathWanted) {
  let found = null;
  function walk(node, prefix) {
    if (found !== null) return;
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (child.files !== undefined) { walk(child, path); continue; }
      if (path === pathWanted) { found = child; return; }
    }
  }
  walk(header, '');
  return found;
}

const target = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js';
const node = find(target);
if (node === null) { console.log('没找到', target); process.exit(1); }
const text = buf.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + Number(node.size)).toString('utf8');
writeFileSync('C:/Users/24239/AppData/Local/Temp/dsh-settings-general.js', text, 'utf8');
console.log('已导出', text.length, '字节 → Temp/dsh-settings-general.js');

// 找关键 UI 文案与默认值
const patterns = [
  [/parallelism|parallel/gi, '并发'],
  [/theme|appearance|dark|light/gi, '主题'],
  [/language|locale/gi, '语言'],
  [/compaction|compress/gi, '压缩'],
  [/permission/gi, '权限'],
];
for (const [re, label] of patterns) {
  const hits = [...text.matchAll(re)].length;
  console.log(`${label}: ${hits} 次`);
}
