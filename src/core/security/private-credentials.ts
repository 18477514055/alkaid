import {
  closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { registerPrivateDirectory, registerPrivateFile } from './private-paths.ts';
import { protectWindowsPrivateDirectory, verifyWindowsPrivatePath } from './windows-private.ts';

/** POSIX 0700/0600 separates users, NOT processes running as the same user. Windows MIC adds the Low read boundary. */
function rejectLinks(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Private credential directory must not contain links or non-directories');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export interface PrivateCredentialDirectory {
  readonly path: string;
  write(name: string, secret: string): string;
  close(): void;
}

/** Each instance owns a fresh directory. Never opens/overwrites another server's credentials. Fail closed. */
export function createPrivateCredentialDirectory(home: string): PrivateCredentialDirectory {
  const parent = resolve(home);
  rejectLinks(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  rejectLinks(parent);
  const path = mkdtempSync(join(parent, 'local-auth-'));
  const identity = lstatSync(path);
  const unregister = registerPrivateDirectory(path);
  const unregisterFiles: Array<() => void> = [];
  const sameDirectory = () => {
    rejectLinks(path);
    const actual = lstatSync(path);
    if (actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error('Private credential directory changed during initialization');
  };
  const verify = () => {
    sameDirectory();
    if (process.platform === 'win32') verifyWindowsPrivatePath(path, true);
    else if ((lstatSync(path).mode & 0o777) !== 0o700) throw new Error('Private credential directory requires mode 0700');
  };
  const remove = () => {
    sameDirectory();
    rmSync(path, { recursive: true, force: true });
    unregister(); // Keep registered if removal fails: old files must remain inaccessible to host tools.
    for (const release of unregisterFiles) release();
  };
  try {
    sameDirectory();
    if (process.platform === 'win32') protectWindowsPrivateDirectory(path);
    // mkdtemp uses 0700 on POSIX, independently of the parent's permissions.
    verify();
  } catch (error) {
    try { remove(); } catch { /* no secrets were written; preserve fail-closed registry */ }
    throw error;
  }
  let closed = false;
  return {
    path,
    write(name, secret) {
      if (closed) throw new Error('Private credential directory is closed');
      if (basename(name) !== name || !/^[a-z][a-z0-9.-]*$/i.test(name)) throw new Error('Invalid private credential filename');
      verify();
      const file = join(path, name);
      const fd = openSync(file, 'wx', 0o600);
      try {
        if (process.platform !== 'win32') fchmodSync(fd, 0o600);
        const before = fstatSync(fd);
        const linked = lstatSync(file);
        if (!before.isFile() || linked.isSymbolicLink() || before.nlink !== 1 || before.ino !== linked.ino || before.dev !== linked.dev) {
          throw new Error('Private credential file identity rejected');
        }
        // Empty child MUST inherit the label/DACL and pass readback before its first secret byte.
        if (process.platform === 'win32') verifyWindowsPrivatePath(file, false);
        else if ((before.mode & 0o777) !== 0o600) throw new Error('Private credential file requires mode 0600');
        verify();
        unregisterFiles.push(registerPrivateFile(file));
        writeFileSync(fd, secret, 'utf8');
        if (process.platform === 'win32') verifyWindowsPrivatePath(file, false);
      } finally { closeSync(fd); }
      return file;
    },
    close() {
      if (closed) return;
      closed = true;
      remove();
    },
  };
}
