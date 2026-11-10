// 从 DSH 真配置里抽出与"默认值"相关的段（只读）
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const lines = readFileSync(file, 'utf8').split(/\r?\n/);

const keys = /contextBudgets|defaultThinkingEfforts|offModelIds|imageToolEnabled|videoToolEnabled|permissionMode|approval|sandbox|defaultModel|compaction|autoCompact|maxSteps|maxTurns/;

for (let i = 0; i < lines.length; i += 1) {
  if (!keys.test(lines[i])) continue;
  const indent = (lines[i].match(/^\s*/) ?? [''])[0].length;
  console.log(`${String(i + 1).padStart(5)} ${lines[i]}`);
  // 打印紧随的更深缩进块（最多 8 行）
  for (let j = i + 1; j < Math.min(i + 9, lines.length); j += 1) {
    const m = (lines[j].match(/^\s*/) ?? [''])[0].length;
    if (m <= indent && lines[j].trim() !== '') break;
    console.log(`      ${lines[j]}`);
  }
}
