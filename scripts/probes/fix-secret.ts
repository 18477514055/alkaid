import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 给演示库写一条演示用 API Key（假模型不看值，只要存在即可）。★ 写到本地 .alkaid-demo，不进版本库。 */
const path = join(process.cwd(), '.alkaid-demo', 'secrets.json');
const providerId = '0a2883d6-15a8-40c6-b364-0b448cd40acd';
const raw = readFileSync(path, 'utf8');
const current = raw.charCodeAt(0) === 0xfeff ? JSON.parse(raw.slice(1)) : JSON.parse(raw);
current[providerId] = 'fake-key-123456';
writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
console.log('ok', Object.keys(current));
