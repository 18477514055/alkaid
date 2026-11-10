import { execFileSync } from 'node:child_process';

/** Fail closed before ANY release copy/rollback. Never stops the user's processes. */
export function assertDesktopClosed({ platform = process.platform, probe } = {}) {
  if (platform !== 'win32') return;
  let state;
  try {
    state = (probe ?? (() => execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
      "$p = @(Get-Process -Name YaoGuang -ErrorAction SilentlyContinue); if ($p.Count -eq 0) { 'CLEAR' } else { 'RUNNING' }",
    ], { encoding:'utf8',windowsHide:true,timeout:10_000 })))().trim();
  } catch { throw new Error('Cannot verify YaoGuang is closed; release files were not changed.'); }
  if (state !== 'CLEAR') throw new Error('YaoGuang desktop/kernel is running or ownership is unknown; close it before deploy/rollback/reapply. No release files were changed.');
}
