import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Run only while the user's desktop is closed. Uses the packaged Electron's real
// Node runtime, real production dependencies and one NEW isolated application home.
const root = resolve(import.meta.dirname, '..');
// Do not replace the only v7 rollback receipt by blindly re-running after v8 was deployed.
const baselineSchema = readFileSync(join(root, 'release/YaoGuang-win32-x64/resources/app/src/core/store/schema.ts'), 'utf8');
if (!/export const SCHEMA_VERSION = 7;/.test(baselineSchema)) throw new Error('Release acceptance requires the original v7 program baseline. Existing release and rollback receipt were NOT changed; use the saved receipt for explicit rollback/reapply.');
const home = mkdtempSync(join(tmpdir(), 'alkaid-release-review-'));
mkdirSync(join(home, 'empty-plugins'));
const binary = join(root, 'release/YaoGuang-win32-x64/YaoGuang.exe');
const entry = join(root, 'release/YaoGuang-win32-x64/resources/app/src/main.ts');
const stages = [];
let child;
async function sync(mode) {
  const p = spawn(process.execPath, [join(root, 'scripts/sync-release-safe.mjs'), mode], { cwd: root, stdio: 'inherit' });
  const [code] = await once(p, 'exit'); assert.equal(code, 0, `sync ${mode}`);
}
async function port() {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); const value = address.port; await new Promise(r => server.close(r)); return value;
}
async function stop() {
  if (!child) return;
  const p = child; child = undefined;
  if (p.exitCode !== null) return;
  const exited = once(p, 'exit'); p.kill(); await exited;
}
let expectedRecord;
async function check(stage, hasWorkbench) {
  const listenPort = await port(); const url = `http://127.0.0.1:${listenPort}`;
  child = spawn(binary, [entry], { cwd: join(root, 'release/YaoGuang-win32-x64/resources/app'), stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ALKAID_HOME: home, ALKAID_PORT: String(listenPort), ALKAID_PLUGINS: join(home, 'empty-plugins') } });
  const exited = once(child, 'exit'); // retain early-exit observation
  let health;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Kernel exited during ${stage}`);
    try { const r = await fetch(`${url}/api/healthz`); if (r.ok) { health = await r.json(); break; } } catch { /* startup */ }
    await delay(100);
  }
  assert.equal(health?.ok, true, `health ${stage}`);
  const projects = await fetch(`${url}/api/projects`).then(r => r.json());
  let project = projects[0];
  if (!project) {
    const response = await fetch(`${url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'release review only' }) });
    assert.equal(response.status, 201); project = await response.json();
  }
  const memory = await fetch(`${url}/api/projects/${project.id}/memory`);
  assert.equal(memory.status, 200, `v7 memory route must survive ${stage}`);
  let body = await memory.json(); assert.equal(body.config.enabled, false);
  const request = async (path, payload) => {
    const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.ok(r.ok, `${stage} ${path}: ${r.status}`); return r.json();
  };
  const prefix = `/api/projects/${project.id}/memory`;
  if (!expectedRecord) {
    const provider = await request('/api/providers', { name: 'offline release fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'release-offline-placeholder-not-a-real-key' });
    const conversation = await request('/api/conversations', { providerId: provider.id, model: 'never-invoked', projectId: project.id });
    const proposal = await request(`${prefix}/proposals`, { conversationId: conversation.id, recordId: 'release-preserved', kind: 'active', title: 'Release preservation evidence', operation: 'upsert', content: 'Preserved across v8 -> v7 -> v8, byte-identical.\n原文不能丢🙂', baseRevision: 0, reason: 'isolated release acceptance', idempotencyKey: 'release-proof' });
    await request(`${prefix}/proposals/${proposal.id}/accept`, {});
    body = await fetch(`${url}${prefix}`).then(r => r.json());
    expectedRecord = body.records.find(row => row.id === 'release-preserved'); assert.ok(expectedRecord);
  }
  assert.deepEqual(body.records.find(row => row.id === 'release-preserved'), expectedRecord, `full formal record survived ${stage}`);
  const goals = await fetch(`${url}${prefix}/goals`);
  assert.equal(goals.status, hasWorkbench ? 200 : 404, `workbench code ${stage}`);
  if (hasWorkbench) {
    const archive = await fetch(`${url}${prefix}/archive`).then(r => r.json());
    assert.equal(archive.entries[0].after.content, expectedRecord.content);
    const counts = await fetch(`${url}${prefix}/workbench?view=counts`); assert.equal(counts.status, 200);
  }
  assert.equal(health.schemaVersion, 8, 'rollback preserves database schema without downgrade');
  stages.push({ stage, schemaVersion: health.schemaVersion, memoryStatus: memory.status, workbenchStatus: goals.status, fullRecordPreserved: true, projectSurvived: project.id, productionNode: true });
  await stop(); await exited;
}
try {
  await sync('deploy'); await check('forward-v8', true);
  await sync('rollback'); await check('rollback-v7-code-on-preserved-v8-data', false);
  await sync('reapply'); await check('reapplied-v8', true);
  const output = resolve(root, '../docs/验收-记忆工作台-发布.json');
  writeFileSync(output, JSON.stringify({ verifiedAt: new Date().toISOString(), binary, stages, realUserHomeUntouched: true, note: 'Program rollback only. Database was NEVER downgraded or deleted; official memory remains preserved.' }, null, 2));
  console.log(JSON.stringify({ verified: true, stages, evidence: output }));
} finally {
  await stop();
  if (!resolve(home).startsWith(resolve(tmpdir(), 'alkaid-release-review-'))) throw new Error('Unexpected fixture cleanup target');
  rmSync(home, { recursive: true, force: true });
}
