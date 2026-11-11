import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalAuth } from '../../src/server/token.ts';

test('Windows REAL Low process: ordinary read works but token/pair reads and writes are AccessDenied; Medium reads work',
  { skip: process.platform !== 'win32' }, async () => {
    // Import lazily: the confinement runner loads Win32 DLLs at module initialization.
    const { spawnConfined, clearLowLabel } = await import('../../src/core/sandbox/win32-confine.ts');
    const root = mkdtempSync(join(tmpdir(), 'alkaid-private-low-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const output = join(root, 'output');
    mkdirSync(workspace);
    const control = join(root, 'ordinary-control.txt');
    writeFileSync(control, 'ordinary-control');
    const auth = createLocalAuth(home);
    try {
      // Medium reads happen in this actual host process. Never print the values (including on failure).
      assert.ok(readFileSync(auth.tokenPath, 'utf8') === auth.token);
      assert.ok(readFileSync(auth.pairingPath, 'utf8').length === 43);
      const source = `
        const fs = require('node:fs');
        const [control, token, pairing] = process.argv.slice(1);
        function denied(path, write) {
          try { if (write) fs.appendFileSync(path, ''); else fs.readFileSync(path); return false; }
          catch (e) { return e.code === 'EACCES' || e.code === 'EPERM'; }
        }
        const result = {
          controlReadable: fs.readFileSync(control, 'utf8') === 'ordinary-control',
          tokenReadDenied: denied(token, false), pairingReadDenied: denied(pairing, false),
          tokenWriteDenied: denied(token, true), pairingWriteDenied: denied(pairing, true),
        };
        console.log(JSON.stringify(result));
        if (!Object.values(result).every(Boolean)) process.exitCode = 7;
      `;
      const result = await spawnConfined({
        file: process.execPath, args: ['-e', source, control, auth.tokenPath, auth.pairingPath],
        cwd: workspace, outputDir: output, timeoutMs: 30_000,
      });
      assert.equal(result.code, 0);
      assert.equal(result.timedOut, false);
      assert.equal(result.aborted, false);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        controlReadable: true, tokenReadDenied: true, pairingReadDenied: true,
        tokenWriteDenied: true, pairingWriteDenied: true,
      });
      // The runner returns ONLY boolean evidence, never file contents or secret-bearing exceptions.
      assert.ok(!result.stdout.includes(auth.token));
      assert.ok(!result.stdout.includes(readFileSync(auth.pairingPath, 'utf8')));
      assert.ok(readFileSync(auth.tokenPath, 'utf8') === auth.token);
    } finally {
      auth.close();
      clearLowLabel(output);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
