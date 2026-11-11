import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createLocalAuth } from '../../src/server/token.ts';
import { createPrivateCredentialDirectory } from '../../src/core/security/private-credentials.ts';
import { verifyWindowsPrivatePath } from '../../src/core/security/windows-private.ts';
import { checkAccess } from '../../src/core/policy/guard.ts';
import { rootsFor } from '../../src/core/policy/roots.ts';
import { PERMISSION_MODES } from '../../src/core/policy/mode.ts';
import { createFsTools } from '../../src/core/tools/fs.ts';
import type { ToolContext } from '../../src/core/tools/types.ts';

function fixture() { return mkdtempSync(join(tmpdir(), 'alkaid-private-unit-')); }
function cleanup(root: string) { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }

// Never use value-dumping equality assertions on random secrets, even on a failing test.
test('local credentials: independent 256-bit secrets, plain pairing file, one successful consume only', () => {
  const home = fixture();
  const auth = createLocalAuth(home);
  try {
    const code = readFileSync(auth.pairingPath, 'utf8');
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(auth.token));
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(code));
    assert.equal(Buffer.from(auth.token, 'base64url').length, 32);
    assert.equal(Buffer.from(code, 'base64url').length, 32);
    assert.ok(code !== auth.token);
    assert.ok(readFileSync(auth.tokenPath, 'utf8') === auth.token);
    assert.ok(auth.pairingExpiresAt > Date.now());
    assert.ok(auth.pairingExpiresAt <= Date.now() + 10 * 60_000);
    assert.equal(auth.consumePairing('wrong'), false);
    assert.equal(auth.consumePairing('A'.repeat(43)), false);
    assert.equal(auth.consumePairing(auth.token), false);
    assert.equal(auth.consumePairing(code), true);
    assert.equal(auth.consumePairing(code), false);
  } finally { auth.close(); cleanup(home); }
});

test('local credentials: expiry is final, closed instances cannot pair', (t) => {
  const home = fixture();
  const auth = createLocalAuth(home);
  try {
    const code = readFileSync(auth.pairingPath, 'utf8');
    t.mock.method(Date, 'now', () => auth.pairingExpiresAt);
    assert.equal(auth.consumePairing(code), false);
    t.mock.restoreAll();
    assert.equal(auth.consumePairing(code), false, 'an observed expiry must not revive after wall-clock rollback');
    auth.close();
    assert.equal(auth.consumePairing(code), false);
    assert.equal(existsSync(dirname(auth.tokenPath)), false);
    auth.close();
  } finally { t.mock.restoreAll(); auth.close(); cleanup(home); }
});

test('local credentials: each server owns a unique directory; closing one never overwrites/removes another', () => {
  const home = fixture();
  const a = createLocalAuth(home);
  const b = createLocalAuth(home);
  try {
    assert.notEqual(dirname(a.tokenPath), dirname(b.tokenPath));
    assert.ok(a.token !== b.token);
    a.close();
    assert.ok(readFileSync(b.tokenPath, 'utf8') === b.token);
    assert.ok(readFileSync(b.pairingPath, 'utf8').length === 43);
    assert.equal(existsSync(dirname(a.tokenPath)), false);
    assert.equal(checkAccess(rootsFor('full', home, null), 'read', b.tokenPath).ok, false);
  } finally { a.close(); b.close(); cleanup(home); }
});

test('local credentials: no secret is exported to environment; registry is mode-independent', () => {
  const home = fixture();
  const before = JSON.stringify(process.env);
  const auth = createLocalAuth(home);
  try {
    assert.ok(JSON.stringify(process.env) === before);
    for (const mode of PERMISSION_MODES) {
      const roots = rootsFor(mode, home, home);
      for (const target of [auth.tokenPath, auth.pairingPath, dirname(auth.tokenPath), join(dirname(auth.tokenPath), 'not-yet-created')]) {
        assert.equal(checkAccess(roots, 'read', target).ok, false, mode);
        assert.equal(checkAccess(roots, 'write', target).ok, false, mode);
      }
      assert.equal(checkAccess(roots, 'read', join(home, 'ordinary')).ok, true, mode);
    }
  } finally { auth.close(); cleanup(home); }
});

test('local credentials: linked or non-directory homes fail closed without creating any credential files', () => {
  const root = fixture();
  const actual = join(root, 'actual');
  const alias = join(root, 'alias');
  mkdirSync(actual);
  symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => createLocalAuth(alias));
    assert.throws(() => createLocalAuth(join(alias, 'nested')));
    assert.deepEqual(readdirSync(actual), []);
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'control');
    assert.throws(() => createLocalAuth(file));
  } finally { cleanup(root); }
});

test('credential OS descriptor is checked, and a weakened directory rejects writes before any secret file', () => {
  const home = fixture();
  const directory = createPrivateCredentialDirectory(home);
  try {
    if (process.platform === 'win32') {
      verifyWindowsPrivatePath(directory.path, true);
      assert.throws(() => verifyWindowsPrivatePath(home, true));
      // This exact historical recommendation supplies NW only, NOT the required NR bit.
      execFileSync('icacls', [directory.path, '/setintegritylevel', '(OI)(CI)Medium'], { stdio: 'ignore' });
      assert.throws(() => directory.write('must-not-exist', 'nonsecret-test-control'));
      assert.equal(existsSync(join(directory.path, 'must-not-exist')), false);
    } else {
      assert.equal(lstatSync(directory.path).mode & 0o777, 0o700);
      const file = directory.write('control', 'nonsecret-test-control');
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
    }
  } finally { directory.close(); cleanup(home); }
});

test('host file tools: all modes deny direct reads/writes, ancestor glob/grep, directory links and hard-link aliases', async () => {
  const home = fixture();
  const auth = createLocalAuth(home);
  const ordinary = join(home, 'ordinary.txt');
  const hardlink = join(home, 'hardlink.txt');
  const dirlink = join(home, 'dirlink');
  writeFileSync(ordinary, 'control-visible');
  linkSync(auth.tokenPath, hardlink);
  symlinkSync(dirname(auth.tokenPath), dirlink, process.platform === 'win32' ? 'junction' : 'dir');
  const tools = new Map(createFsTools().map((tool) => [tool.name, tool]));
  const code = readFileSync(auth.pairingPath, 'utf8');
  try {
    for (const mode of PERMISSION_MODES) {
      const ctx: ToolContext = {
        conversationId: 'credential-test', agentRole: 'subagent', permissionMode: mode,
        roots: rootsFor(mode, home, home), workspacePath: home, projectSharedDir: home,
        cwd: home, tempDir: home, signal: new AbortController().signal,
      };
      const run = (name: string, args: unknown) => tools.get(name)!.execute(args, ctx);
      for (const target of [auth.tokenPath, auth.pairingPath, hardlink, join(dirlink, 'token')]) {
        for (const [name, args] of [
          ['read', { path: target }], ['write', { path: target, content: 'nonsecret-test-control' }],
          ['edit', { path: target, old_string: 'x', new_string: 'y' }],
        ] as const) {
          const result = await run(name, args);
          assert.equal(result.ok, false, `${mode}:${name}`);
          if (!result.ok) assert.equal(result.code, 'denied_by_policy');
        }
      }
      for (const name of ['glob', 'grep']) {
        for (const base of [dirname(auth.tokenPath), dirlink, auth.tokenPath, auth.pairingPath, hardlink]) {
          const denied = await run(name, { path: base, pattern: name === 'glob' ? '**/*' : '.' });
          assert.equal(denied.ok, false, `${mode}:${name}`);
        }
        const result = await run(name, { path: home, pattern: name === 'glob' ? '**/*' : '.' });
        assert.equal(result.ok, true, `${mode}:${name}`);
        if (result.ok) {
          assert.ok(!result.content.includes(auth.token));
          assert.ok(!result.content.includes(code));
          assert.ok(!result.content.includes('pairing-code'));
          assert.ok(!result.content.includes('hardlink.txt'));
          assert.ok(result.content.includes('ordinary.txt'));
        }
      }
      const ordinaryResult = await run('read', { path: ordinary });
      assert.equal(ordinaryResult.ok, true);
      const fullCtx = { ...ctx, permissionMode: 'full' as const, roots: rootsFor('full', null, null) };
      assert.equal((await tools.get('read')!.execute({ path: ordinary }, fullCtx)).ok, true);
    }
    assert.ok(readFileSync(auth.tokenPath, 'utf8') === auth.token);
  } finally { auth.close(); cleanup(home); }
});

test('host file tools: file symlink targets are denied; ordinary file symlinks remain readable in full', async (t) => {
  const home = fixture();
  const auth = createLocalAuth(home);
  try {
    const alias = join(home, 'file-alias.txt');
    const ordinary = join(home, 'ordinary.txt');
    const ordinaryAlias = join(home, 'ordinary-alias.txt');
    writeFileSync(ordinary, 'control-visible');
    try {
      symlinkSync(auth.pairingPath, alias, 'file');
      symlinkSync(ordinary, ordinaryAlias, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows file symlinks require Developer Mode or SeCreateSymbolicLinkPrivilege; junction+hardlink cases run separately');
        return;
      }
      throw error;
    }
    const ctx: ToolContext = {
      conversationId: 'credential-test', permissionMode: 'full', roots: rootsFor('full', null, null),
      workspacePath: home, projectSharedDir: null, cwd: home, tempDir: home, signal: new AbortController().signal,
    };
    const read = createFsTools().find((tool) => tool.name === 'read')!;
    assert.equal((await read.execute({ path: alias }, ctx)).ok, false);
    assert.equal((await read.execute({ path: ordinaryAlias }, ctx)).ok, true);
  } finally { auth.close(); cleanup(home); }
});
