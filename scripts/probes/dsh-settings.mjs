// 从 DSH 的 asar 里抽出「设置项 → 默认值」，供对照
import { readFileSync } from 'node:fs';

const ASAR = 'C:/Users/24239/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
const buf = readFileSync(ASAR);
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
const dataStart = 16 + headerSize;

const files = [];
function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (child.files !== undefined) { walk(child, path); continue; }
    if (child.offset === undefined || child.size === undefined) continue;
    if (child.size > 400_000) continue;
    files.push({ path, offset: Number(child.offset), size: Number(child.size) });
  }
}
walk(header, '');

// 只关心 settings 相关包的 client.js / lib
const targets = files.filter((f) => /dsh-client-ui-settings[^/]*\/(lib|dist)\/.*\.js$/.test(f.path));
console.log('候选文件:', targets.length);

const read = (f) => buf.subarray(dataStart + f.offset, dataStart + f.offset + f.size).toString('utf8');

// 找"默认值"定义：defaultValue / DEFAULT_ / 枚举选项
const wanted = /(defaultValue|DEFAULT_[A-Z_]+|default:\s*(?:'|")|options:\s*\[)/;
for (const f of targets) {
  const text = read(f);
  if (!wanted.test(text)) continue;
  const lines = text.split(/\r?\n/);
  const hits = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /defaultValue|DEFAULT_[A-Z_]+|default:\s*['"]|options:\s*\[\s*\{/.test(l));
  if (hits.length === 0) continue;
  console.log(`\n=== ${f.path} ===`);
  for (const h of hits.slice(0, 18)) {
    console.log('  ' + h.l.trim().slice(0, 200));
  }
}
