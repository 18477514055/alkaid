import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { PluginManifest } from './protocol.ts';

/**
 * 插件清单的**读写**（清单只有一个文件：`plugins/<目录>/plugin.json`）。
 *
 * ## ★★ 为什么要有这个文件（阶段一第 5 条的真问题）
 *
 * 报告的建议是"补原子写 + 文件锁"（`D6@L805`）。但真看代码会发现一个更基本的事实：
 * **Alkaid 之前根本没有写清单的路径** —— `host.ts` 里只有 `readManifests()`（只读）。
 * 后果不是"改一半断电会损坏"，而是更日常的那个：
 * **在界面上点「停用插件」，重启后它又活了** —— `setEnabled()` 只改了内存里的
 * `runtime.status`，而 `loadAll()` 读的是 `plugin.json` 里的 `enabled`。
 * 一次网络中断、一次关窗口，用户的决定就没了。
 *
 * ⇒ 要"原子写"，先得有"写"。这个文件补上写，并按两条判据做：
 *
 * 1. **永远不留半截文件**：先写同目录的 `.tmp`，再 `rename` 覆盖。
 *    同盘 `rename` 是原子的：读者要么看到旧的完整版，要么看到新的完整版。
 *    （直接 `writeFileSync` 到目标路径会在中途被读到半截 JSON；
 *    而**断电**时更糟 —— 文件长度已更新但内容还没落盘，读出来是 NUL 填充。）
 * 2. **写之前先拿锁**：两个进程同时给同一个插件改 `enabled` 时，
 *    没有锁就会出现"后写的人把前一个人的修改整个覆盖掉"（清单只有 4 个字段，
 *    覆盖 = 丢改动）。锁用 `wx` 打开独占文件，拿不到就退避重试，超时就放弃并报错。
 *
 * ## ★ 为什么锁文件要带"过期"判定
 *
 * 上次进程被强杀时锁文件会留在那里（Windows 上 `mkdir`/`open` 式的锁不会自动释放）。
 * 没有过期判定的话，那个插件从此**再也改不了 enabled** —— 而且要人手工去删一个
 * 藏在用户数据目录里的隐藏文件，这属于"修一个 bug 引入两个"。
 * ⇒ 锁超过 {@link LOCK_STALE_MS} 且持有者已不可能还在写（这里用文件的 mtime），就当作残留清掉。
 *    代价是"极慢的写者可能被误抢"—— 但一次写只有几十字节，正常远低于 5 秒。
 */

/** 锁超过这么久就当作上次崩溃留下的残留 */
const LOCK_STALE_MS = 5_000;

/** 拿锁的重试间隔 */
const LOCK_RETRY_MS = 25;

/** 拿锁的总超时 */
const LOCK_TIMEOUT_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 半截 JSON 的错误用这个类型，好让调用方能"跳过并继续"而不是整个崩掉 */
export class ManifestParseError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`插件清单不是合法 JSON：${path}（${cause instanceof Error ? cause.message : String(cause)}）`);
    this.name = 'ManifestParseError';
    this.path = path;
  }
}

/**
 * 原子写一个 JSON 文件（同目录 `.tmp` + `rename`）。
 *
 * ★ 为什么 tmp 必须与目标**同目录**：跨盘/跨卷的 `rename` 在 Windows 上直接失败
 *   （`EXDEV`），而落到 `os.tmpdir()` 就正好是跨盘。
 * ★ `.tmp` 名字带上 pid：两个进程同时写时不会互相踩到对方的临时文件
 *   （锁已经挡住了大部分，但锁过期被误抢时不至于把半截内容拼起来）。
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, { encoding: 'utf8' });
    renameSync(tmp, path);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清不掉也不该把原始错误盖掉 */
    }
    throw error;
  }
}

/**
 * 拿一个**跨进程**的独占锁，跑完 `fn` 再释放。
 *
 * 判据：拿不到就等，等不到就抛（**不静默跳过**）—— 静默跳过等于"用户的修改悄悄丢了"，
 * 那正是这次要修的毛病。
 */
export async function withFileLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: number | null = null;

  for (;;) {
    try {
      handle = openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // 残留锁：上次进程被强杀时留下的。清掉再试一次。
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* 锁在这一瞬间被别人释放了 —— 直接重试即可 */
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`插件清单被占用（${lockPath}），请稍后重试`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      closeSync(handle);
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* 残留锁有过期判定兜底 */
    }
  }
}

/**
 * 读一份**原始**清单对象（不做字段裁剪）。
 *
 * ★ 为什么写侧要用"原始"而不是 {@link readManifestFile} 的结果：
 *   后者只挑 4 个已知字段重建对象，**未知字段会被丢掉**（有测试钉住）。
 *   用户手写的注记字段、以后版本新增的字段都属于"我没读懂但不是我的"，
 *   不该因为一次 `enabled` 开关就消失。写 = 读原样 → 只改一个键 → 写回。
 *
 * @returns 文件缺失 / 不是合法 JSON / 不是对象 / 缺 `id` 或 `entry` ⇒ `null`
 */
function readRawManifest(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || typeof raw['entry'] !== 'string') return null;
  return raw;
}

/**
 * 读一份清单。
 * @returns 读不到 / 不是合法 JSON / 缺必有字段 时返回 `null`（**不抛**）——
 *   一个插件清单坏了不该让整个宿主起不来，那是"崩溃隔离"的同一笔账。
 */
export function readManifestFile(path: string): PluginManifest | null {
  const raw = readRawManifest(path);
  if (raw === null) return null;
  const id = raw['id'] as string;
  const entry = raw['entry'] as string;
  return {
    id,
    name: typeof raw['name'] === 'string' ? raw['name'] : id,
    entry,
    ...(typeof raw['enabled'] === 'boolean' ? { enabled: raw['enabled'] } : {}),
  };
}

/**
 * 改一份清单的 `enabled` 并**原子落盘**（持锁）。
 *
 * 只改 `enabled` 一个键，**其余键原样写回**（含本版本不认识的字段）——
 * 读不到合法 JSON 就拒绝写，免得用"我理解的结构"覆盖掉"我读不懂的结构"。
 */
export async function setManifestEnabled(path: string, enabled: boolean): Promise<void> {
  const lockPath = `${path}.lock`;
  await withFileLock(lockPath, () => {
    const raw = readRawManifest(path);
    if (raw === null) throw new ManifestParseError(path, new Error('文件缺失、不是对象或缺少 id/entry'));
    writeJsonAtomic(path, { ...raw, enabled });
  });
}
