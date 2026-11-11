import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createPrivateCredentialDirectory } from '../core/security/private-credentials.ts';

export interface LocalAuth {
  readonly token: string;
  readonly tokenPath: string;
  readonly pairingPath: string;
  /** Epoch milliseconds. Pairing expires after ten minutes; expiration or consumption requires a restart. */
  readonly pairingExpiresAt: number;
  consumePairing(code: string): boolean;
  close(): void;
}

/**
 * Startup-scoped bearer and independent one-use pairing code. Neither is put in env/argv/logs.
 * Only the local pairing file is the user bootstrap channel; public GET MUST NOT issue an auth cookie.
 * Windows: current-user DACL + inheritable Medium NO_READ_UP|NO_WRITE_UP protects against Low processes.
 * This is not isolation from other Medium processes of the same user (nor root/admin).
 * POSIX: 0700/0600 is user separation only; it does not isolate same-user processes.
 */
export function createLocalAuth(home: string): LocalAuth {
  const directory = createPrivateCredentialDirectory(home);
  try {
    const token = randomBytes(32).toString('base64url');
    let pairingCode: string;
    do { pairingCode = randomBytes(32).toString('base64url'); } while (pairingCode === token);
    const tokenPath = directory.write('token', token);
    const pairingPath = directory.write('pairing-code', pairingCode);
    const pairingExpiresAt = Date.now() + 10 * 60_000;
    const pairingDeadline = performance.now() + 10 * 60_000;
    let used = false;
    let closed = false;
    return {
      token, tokenPath, pairingPath, pairingExpiresAt,
      consumePairing(code) {
        if (closed || used) return false;
        if (Date.now() >= pairingExpiresAt || performance.now() >= pairingDeadline) { used = true; return false; }
        if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
        if (!timingSafeEqual(Buffer.from(code, 'ascii'), Buffer.from(pairingCode, 'ascii'))) return false;
        used = true;
        return true;
      },
      close() {
        if (closed) return;
        closed = true;
        used = true;
        directory.close();
      },
    };
  } catch (error) {
    try { directory.close(); } catch { /* preserve the original protection error, never expose a secret */ }
    throw error;
  }
}
