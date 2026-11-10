import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertDesktopClosed } from './release-guard.mjs';

// This script only copies app-owned source/build artifacts. No runtime data, keys,
// plugins, node_modules or user workspaces are opened, migrated or deleted.
const root = resolve(import.meta.dirname, '..');
const target = join(root, 'release', 'YaoGuang-win32-x64', 'resources', 'app');
const receiptFile = join(root, 'release', 'memory-release-receipt.json');
function inside(base, path) {
  const rel = relative(base, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Unexpected artifact path: ${path}`);
}
function noLinks(path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error(`Refusing linked path: ${p}`);
    if (p === dirname(p)) break;
  }
}
function files(path, prefix = '') {
  noLinks(path);
  if (!existsSync(path)) return [];
  const out = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name); const name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing linked entry: ${full}`);
    if (entry.isDirectory()) out.push(...files(full, name));
    else if (entry.isFile()) out.push(name);
    else throw new Error(`Not a regular artifact: ${full}`);
  }
  return out;
}
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function copy(from, to) { noLinks(from); noLinks(to); mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
noLinks(target);
if (!existsSync(join(target, 'package.json'))) throw new Error('Packaged app is missing');
const mode = process.argv[2] ?? 'deploy';
assertDesktopClosed();
if (mode === 'deploy') {
  const backup = join(target, `.rollback-memory-${randomUUID()}`);
  const entries = [];
  // Check every tree BEFORE the first copy, so a later discovered junction cannot
  // leave a partially traversed deployment or copy somebody else's data.
  const trees = ['src', join('dist', 'web'), 'desktop'].map(tree => ({ tree, source: files(join(root, tree)), previous: files(join(target, tree)) }));
  for (const { tree, source, previous } of trees) {
    for (const name of previous) copy(join(target, tree, name), join(backup, tree, name));
    for (const name of source) {
      const destination = join(target, tree, name); inside(target, destination);
      entries.push({ relative: join(tree, name), before: existsSync(destination) ? digest(destination) : null, after: digest(join(root, tree, name)) });
    }
  }
  // Record before writing. A deployment can be rolled back after an interrupted copy.
  const receipt = { target, backup, createdAt: new Date().toISOString(), state: 'prepared', entries };
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  for (const { tree, source } of trees) for (const name of source) copy(join(root, tree, name), join(target, tree, name));
  for (const entry of entries) if (digest(join(target, entry.relative)) !== entry.after) throw new Error('Artifact readback mismatch');
  receipt.state = 'deployed'; writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ mode, target, backup, files: entries.length, verified: true, receipt: receiptFile }));
} else if (mode === 'rollback' || mode === 'reapply') {
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  if (receipt.target !== target || !receipt.backup.startsWith(join(target, '.rollback-memory-'))) throw new Error('Unexpected receipt root');
  inside(target, receipt.backup); noLinks(receipt.backup);
  // Guard all live files before changing any; user edits after deployment abort it.
  for (const entry of receipt.entries) {
    const path = resolve(target, entry.relative); inside(target, path); noLinks(path);
    const expected = mode === 'rollback' ? entry.after : entry.before;
    const actual = existsSync(path) ? digest(path) : null;
    if (actual !== expected) throw new Error(`Artifact changed since previous step: ${entry.relative}`);
    if (entry.before !== null && digest(join(receipt.backup, entry.relative)) !== entry.before) throw new Error('Backup mismatch');
    if (mode === 'reapply' && digest(join(root, entry.relative)) !== entry.after) throw new Error('Source changed; deploy again instead');
  }
  for (const entry of receipt.entries) {
    const path = resolve(target, entry.relative); inside(target, path); noLinks(path);
    if (mode === 'rollback') {
      if (entry.before === null) { console.log(`Removing deployment-created artifact: ${path}`); unlinkSync(path); }
      else copy(join(receipt.backup, entry.relative), path);
    } else copy(join(root, entry.relative), path);
  }
  for (const entry of receipt.entries) {
    const expected = mode === 'rollback' ? entry.before : entry.after;
    const path = join(target, entry.relative);
    if ((existsSync(path) ? digest(path) : null) !== expected) throw new Error('Readback mismatch');
  }
  receipt.state = mode === 'rollback' ? 'rolled-back' : 'deployed'; writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ mode, target, verified: true, files: receipt.entries.length, receipt: receiptFile }));
} else throw new Error('Usage: node scripts/sync-release-safe.mjs [deploy|rollback|reapply]');
