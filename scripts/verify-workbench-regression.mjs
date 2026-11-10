import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, process.argv[2] ?? '../docs/验收-记忆工作台-回归.txt');
const steps = [
  ['backend typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']],
  ['web typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.web.json']],
  ['all tests', ['--test', 'test/**/*.test.ts']],
  ['production build', ['node_modules/vite/bin/vite.js', 'build']],
];
writeFileSync(output, `Memory workbench regression — ${new Date().toISOString()}\nNode ${process.version}\n`, 'utf8');
for (const [name, args] of steps) {
  const fd = openSync(output, 'a');
  writeFileSync(fd, `\n=== ${name}: node ${args.join(' ')} ===\n`);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', fd, fd], env: { ...process.env, NO_COLOR: '1' } });
  const [code] = await once(child, 'exit');
  writeFileSync(fd, `exit=${code}\n`); closeSync(fd);
  console.log(`${name}: exit ${code}`); assert.equal(code, 0, name);
}
const raw = readFileSync(output, 'utf8');
console.log(raw.split('\n').filter(line => /tests \d|pass \d|fail \d|built in|exit=/.test(line)).join('\n'));
console.log(`Evidence: ${output}`);
