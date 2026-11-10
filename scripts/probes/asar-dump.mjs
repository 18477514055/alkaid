/**
 * 只读地从 app.asar 里挑文件 —— 用来把 DSH 自己的主题色号/字体抄下来。
 *
 * asar 格式：8 字节前缀（4 字节 uint32 = 头部长度相关的两个字段）+ JSON 头 + 数据区。
 * 这里不实现完整 asar 语义（link/unpacked 都跳过），只要能列出并导出普通文件。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ASAR = process.argv[2];
const OUT = process.argv[3];
const PATTERN = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;

const buf = readFileSync(ASAR);
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
const dataStart = 16 + headerSize;

const hits = [];

function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (child.files !== undefined) {
      walk(child, path);
      continue;
    }
    if (child.offset === undefined || child.size === undefined) continue;
    if (PATTERN !== null && !PATTERN.test(path)) continue;
    hits.push({ path, offset: Number(child.offset), size: Number(child.size), unpacked: child.unpacked === true });
  }
}

walk(header, '');

hits.sort((a, b) => b.size - a.size);
console.log(`匹配 ${hits.length} 个文件（按体积降序，前 30）：`);
for (const hit of hits.slice(0, 30)) {
  console.log(`  ${(hit.size / 1024).toFixed(1).padStart(9)} KB  ${hit.unpacked ? '[unpacked] ' : ''}${hit.path}`);
}

if (OUT !== undefined && OUT !== '(none)') {
  for (const hit of hits) {
    if (hit.unpacked) continue;
    const target = `${OUT}/${hit.path}`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf.subarray(dataStart + hit.offset, dataStart + hit.offset + hit.size));
  }
  console.log(`\n已导出到 ${OUT}`);
}
