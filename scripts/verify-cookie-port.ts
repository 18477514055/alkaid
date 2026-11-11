/** Low-IL cross-port cookie receiver. Prints only counts/booleans, never headers or cookie values. */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearLowLabel, ensureLowLabel, spawnConfined } from '../src/core/sandbox/win32-confine.ts';

assert.equal(process.platform, 'win32', 'This verifier requires real Windows Low-IL');
const root = mkdtempSync(join(tmpdir(), 'alkaid-cookie-port-'));
const out = join(root, 'out');
mkdirSync(out);
ensureLowLabel(out);
const ready = join(out, 'ready');
const probe = createServer();
await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
const address = probe.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
await new Promise<void>(done => probe.close(() => done()));
const code = `
const http=require('node:http'),fs=require('node:fs');
let probeCount=0,controlCount=0,authCookieObserved=false;
const s=http.createServer((q,r)=>{
  if(q.url==='/probe'){probeCount++;authCookieObserved ||= /(?:^|;\\s*)alkaid_local=/.test(q.headers.cookie||'');}
  if(q.url==='/control')controlCount++;
  r.setHeader('Access-Control-Allow-Origin','*');r.end('ok');
  if(q.url==='/finish')s.close();
});
const timer=setTimeout(()=>s.close(),90000);
s.on('close',()=>{clearTimeout(timer);console.log(JSON.stringify({probeCount,controlCount,authCookieObserved}));});
s.listen(${port},'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)},'ready'));
`;
let readyTimer: NodeJS.Timeout;
const readyWait = new Promise<void>((done, reject) => {
  const watcher = watch(out, () => { if (existsSync(ready)) { clearTimeout(readyTimer); watcher.close(); done(); } });
  readyTimer = setTimeout(() => { watcher.close(); reject(new Error('Low cookie receiver failed to listen')); }, 15000);
});
const running = spawnConfined({ file: process.execPath, args: ['-e', code], cwd: root, outputDir: out, timeoutMs: 100_000, maxOutputChars: 8_000 });
try {
  await readyWait;
  const control = await fetch(`http://127.0.0.1:${port}/control`);
  assert.equal(control.status, 200);
  console.log(JSON.stringify({ lowReceiverUrl: `http://127.0.0.1:${port}/probe`, finishUrl: `http://127.0.0.1:${port}/finish`, home: root, controlStatus: control.status }));
  const result = await running;
  assert.equal(result.code, 0, `Low cookie receiver failed: ${result.stderr}`);
  const receipt = { mode: 'real-Windows-Low-cookie-receiver', ...JSON.parse(result.stdout.trim()), stderr: result.stderr, tokenPrinted: false };
  assert.equal(receipt.controlCount, 1);
  console.log(JSON.stringify(receipt));
  const reportDir = process.env['ALKAID_VERIFY_REPORT_DIR'];
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    const label = process.argv.find(v => v.startsWith('--label='))?.slice(8) ?? 'cookie-port';
    assert.match(label, /^[a-z0-9-]+$/);
    writeFileSync(join(reportDir, `${label}.json`), JSON.stringify(receipt, null, 2), 'utf8');
  }
} finally {
  clearLowLabel(out);
  assert.ok(resolve(root).startsWith(resolve(tmpdir())) && root.includes('alkaid-cookie-port-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
