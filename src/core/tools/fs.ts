import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';

import { PERMISSION_MODES } from '../policy/mode.ts';
import { checkAccess, resolveToolPath, type AccessOp } from '../policy/guard.ts';
import type { ToolContext, ToolDefinition, ToolOutcome } from './types.ts';

/**
 * 文件工具族（read / write / edit / glob / grep）。
 *
 * ★ 它们与 shell 的区别在于**边界是真的**：这些操作全部由我们自己的进程执行，
 *   所以"规范化后判包含关系"就是完整答案（DSH fs-sandbox 的原话）。
 *   shell 那边进程不受我们控制，只能靠 OS confinement —— 这就是为什么 shell
 *   目前只在完全权限档可见，而文件工具五档都可见。
 *
 * ★ 五个工具都**不做全盘扫描**：glob/grep 有数量上限、跳过 node_modules/.git、
 *   不跟随目录符号链接。一个能爬满硬盘的工具不是能力，是事故。
 */

const MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 2_000;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 5_000;
const MAX_GREP_FILES = 800;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 30_000;

const SKIP_DIRS = new Set(['node_modules', '.git', '.alkaid', 'dist', '.vite', '.turbo', 'coverage']);

function fail(code: string, message: string, hint?: string): ToolOutcome {
  return { ok: false, code, message, ...(hint === undefined ? {} : { hint }) };
}

/**
 * 生效的输出上限。
 * - `ctx.maxToolOutputChars === null` ⇒ **不限制**，返回 `null` 让调用方跳过截断
 * - 数字 ⇒ 用它
 * - 未设 ⇒ 用模块默认 30k
 * ★ 必须返回 `null` 而不是 `Infinity`：`text.slice(0, Infinity)` 虽然等价于不截，
 *   但会把"截断提示"的逻辑绕进去，读起来像 bug。
 */
function outputLimit(ctx: ToolContext): number | null {
  const configured = ctx.maxToolOutputChars;
  if (configured === null) return null;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  return MAX_OUTPUT_CHARS;
}

function clip(text: string, limit: number | null = MAX_OUTPUT_CHARS): string {
  if (limit === null || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[输出过长，已截断；原始长度 ${text.length} 字符]`;
}

/** 同 {@link clip}，但**额外告诉调用方它被截过** —— 供 `ToolOutcome.truncated` 用 */
function clipped(text: string, limit: number | null = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  return limit === null || text.length <= limit
    ? { text, truncated: false }
    : { text: clip(text, limit), truncated: true };
}

/** 解析 + 围栏。所有文件工具的第一步都是它 —— 没有例外。 */
function prepare(
  ctx: ToolContext,
  op: AccessOp,
  input: unknown,
): { ok: true; path: string } | { ok: false; outcome: ToolOutcome } {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, outcome: fail('invalid_args', 'path 不能为空', '传一个相对当前工作目录的路径。') };
  }

  const absolute = resolveToolPath(input, ctx.cwd);
  const verdict = checkAccess(ctx.roots, op, absolute);
  if (!verdict.ok) {
    return {
      ok: false,
      outcome: fail('denied_by_policy', verdict.message, verdict.hint),
    };
  }
  return { ok: true, path: verdict.path };
}

function readTextFile(path: string): { ok: true; text: string } | { ok: false; outcome: ToolOutcome } {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { ok: false, outcome: fail('not_found', `文件不存在：${path}`, '先确认路径；可以用 glob 找一下。') };
  }
  if (!stats.isFile()) return { ok: false, outcome: fail('not_a_file', `不是一个文件：${path}`) };
  if (stats.size > MAX_READ_BYTES) {
    return {
      ok: false,
      outcome: fail('file_too_large', `文件过大（${stats.size} 字节，上限 ${MAX_READ_BYTES}）`, '用 grep 找关键行，或写在脚本里处理。'),
    };
  }
  try {
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (error) {
    return { ok: false, outcome: fail('read_failed', error instanceof Error ? error.message : String(error)) };
  }
}

// ─────────────────────────────── read ───────────────────────────────

const readTool: ToolDefinition = {
  name: 'read',
  description:
    '读取一个文本文件，返回带行号的内容。可用 offset/limit 分段读大文件。' +
    '路径相对当前工作目录，且必须落在授权范围内（五档权限由程序强制，不靠自觉）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
      offset: { type: 'number', description: '从第几行开始（1 起），默认 1' },
      limit: { type: 'number', description: `最多读几行，默认 ${DEFAULT_READ_LINES}` },
    },
    required: ['path'],
    additionalProperties: false,
  },
  modes: PERMISSION_MODES,

  // ── 元信息 ──
  source: 'builtin',
  kind: 'read_only',
  group: 'files',
  displayName: '读文件',
  summary: '按行读取文本文件，可分段读大文件',
  oneLiner: 'Read a text file with line numbers; supports offset/limit.',
  preferredMode: 'resident',

  async execute(rawArgs, ctx) {
    const args = (rawArgs ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown };
    const prepared = prepare(ctx, 'read', args.path);
    if (!prepared.ok) return prepared.outcome;

    const loaded = readTextFile(prepared.path);
    if (!loaded.ok) return loaded.outcome;

    const lines = loaded.text.split(/\r?\n/);
    const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.trunc(args.offset) : 1;
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.trunc(args.limit) : DEFAULT_READ_LINES;

    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length - 1).length + 1;
    const body = slice.map((line, index) => `${String(offset + index).padStart(width)}  ${line}`).join('\n');

    const tail =
      offset - 1 + slice.length < lines.length
        ? `\n…[还有 ${lines.length - (offset - 1 + slice.length)} 行；用 offset=${offset + slice.length} 继续读]`
        : '';

    return { ok: true, content: clip(`${body}${tail}`, outputLimit(ctx)) };
  },
};

// ────────────────────────────── write ──────────────────────────────

const writeTool: ToolDefinition = {
  name: 'write',
  description:
    '整体写入一个文本文件（覆盖原内容）。父目录不存在时会创建。' +
    '★ 只想改几行时用 edit，不要用 write 覆盖整个文件 —— 覆盖会丢掉没读到的内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整的新内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  modes: PERMISSION_MODES,

  // ── 元信息 ──
  source: 'builtin',
  kind: 'write_local',
  group: 'files',
  displayName: '写文件',
  summary: '整体覆盖写入文本文件（会丢掉没读到的内容）',
  oneLiner: 'Create or overwrite a whole file. Prefer edit for small changes.',
  preferredMode: 'resident',
  examples: [
    {
      // ★ write 与 edit 的分界是模型最常搞错的一点：它常拿 write 去改几行，
      //   于是把没读到的内容一起覆盖掉。示例比长描述有效。
      whenTo: 'creating a brand-new file (nothing to preserve)',
      args: { path: 'src/new.ts', content: 'export const x = 1;\n' },
    },
  ],

  async execute(rawArgs, ctx) {
    const args = (rawArgs ?? {}) as { path?: unknown; content?: unknown };
    if (typeof args.content !== 'string') return fail('invalid_args', 'content 必须是字符串', '传完整的新内容。');

    const prepared = prepare(ctx, 'write', args.path);
    if (!prepared.ok) return prepared.outcome;

    if (Buffer.byteLength(args.content, 'utf8') > MAX_WRITE_BYTES) {
      return fail('content_too_large', `内容过大（上限 ${MAX_WRITE_BYTES} 字节）`, '拆成多个文件，或改用 edit。');
    }

    try {
      mkdirSync(dirname(prepared.path), { recursive: true });
      writeFileSync(prepared.path, args.content, 'utf8');
      return { ok: true, content: `已写入 ${prepared.path}（${Buffer.byteLength(args.content, 'utf8')} 字节）` };
    } catch (error) {
      return fail('write_failed', error instanceof Error ? error.message : String(error));
    }
  },
};

// ────────────────────────────── edit ──────────────────────────────

const editTool: ToolDefinition = {
  name: 'edit',
  description:
    '在文件里做**精确字符串替换**：old_string 必须在文件中出现，且（默认）必须唯一。' +
    '找不到或有歧义都会明确报错，不会改错地方。不做正则、不做模糊匹配。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原文（必须与文件中逐字一致）' },
      new_string: { type: 'string', description: '替换成什么' },
      replace_all: { type: 'boolean', description: '为 true 时替换所有出现位置（默认 false，要求唯一）' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  modes: PERMISSION_MODES,

  // ── 元信息 ──
  source: 'builtin',
  kind: 'write_local',
  group: 'files',
  displayName: '改文件',
  summary: '精确字符串替换，要求唯一命中，不做正则与模糊匹配',
  oneLiner: 'Replace an exact unique string in a file (no regex, no fuzzy match).',
  preferredMode: 'resident',
  examples: [
    {
      whenTo: 'changing a few lines that you just read',
      args: { path: 'src/main.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    },
    {
      whenTo: 'the same text appears several times and all must change',
      args: { path: 'a.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
    },
  ],

  async execute(rawArgs, ctx) {
    const args = (rawArgs ?? {}) as {
      path?: unknown;
      old_string?: unknown;
      new_string?: unknown;
      replace_all?: unknown;
    };
    if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
      return fail('invalid_args', 'old_string 不能为空', '给出要被替换的原文。');
    }
    if (typeof args.new_string !== 'string') return fail('invalid_args', 'new_string 必须是字符串');

    const prepared = prepare(ctx, 'write', args.path);
    if (!prepared.ok) return prepared.outcome;

    const loaded = readTextFile(prepared.path);
    if (!loaded.ok) return loaded.outcome;

    const occurrences = loaded.text.split(args.old_string).length - 1;
    if (occurrences === 0) {
      return fail(
        'old_string_not_found',
        'old_string 在文件中不存在（逐字未匹配）',
        '先用 read 看一下目标区域，把 old_string 复制得更精确些（注意缩进与空行）。',
      );
    }

    const replaceAll = args.replace_all === true;
    if (occurrences > 1 && !replaceAll) {
      return fail(
        'old_string_not_unique',
        `old_string 在文件中出现了 ${occurrences} 次，无法确定改哪一处`,
        '在 old_string 里多带几行上下文让它唯一；若确实要全改，传 replace_all=true。',
      );
    }

    const next = replaceAll
      ? loaded.text.split(args.old_string).join(args.new_string)
      : loaded.text.replace(args.old_string, args.new_string);

    try {
      writeFileSync(prepared.path, next, 'utf8');
      return { ok: true, content: `已替换 ${replaceAll ? occurrences : 1} 处（${prepared.path}）` };
    } catch (error) {
      return fail('write_failed', error instanceof Error ? error.message : String(error));
    }
  },
};

// ────────────────────────────── 遍历 ──────────────────────────────

/** 遍历文件；**不跟随目录符号链接**（防环、防跑出授权范围） */
function walkFiles(base: string, limit: number, ctx: ToolContext): string[] {
  const out: string[] = [];
  const stack: string[] = [base];

  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop();
    if (dir === undefined) break;
    // Recheck EACH directory, not just the traversal root (which may be home or a drive root).
    if (!checkAccess(ctx.roots, 'read', dir).ok) continue;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (out.length >= limit) break;
      const full = resolve(dir, entry.name);
      if (!checkAccess(ctx.roots, 'read', full).ok) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/** 极简 glob → 正则：支持 `**`、`*`、`?`（够用了，不引依赖） */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/');
  let source = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        source += '.*';
        index += 1;
        if (normalized[index + 1] === '/') index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char ?? '')) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`, 'i');
}

// ────────────────────────────── glob ──────────────────────────────

const globTool: ToolDefinition = {
  name: 'glob',
  description:
    '按文件名模式列出文件（支持 ** / * / ?）。跳过 node_modules、.git 等目录，不跟随目录链接。' +
    '找"内容"请用 grep，找"文件"用这个。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '形如 "**/*.ts" 或 "src/*.md"' },
      path: { type: 'string', description: '从哪个目录开始找，默认当前工作目录' },
      limit: { type: 'number', description: '最多返回多少条，默认 200' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  modes: PERMISSION_MODES,

  // ── 元信息 ──
  source: 'builtin',
  kind: 'read_only',
  group: 'files',
  displayName: '找文件',
  summary: '按文件名模式列文件（** 与 * 都支持）',
  oneLiner: 'List files by name pattern ("**/*.ts"). Use grep to search contents.',
  preferredMode: 'lazy',

  async execute(rawArgs, ctx) {
    const args = (rawArgs ?? {}) as { pattern?: unknown; path?: unknown; limit?: unknown };
    if (typeof args.pattern !== 'string' || args.pattern.trim().length === 0) {
      return fail('invalid_args', 'pattern 不能为空', '例如 "**/*.ts"。');
    }

    const baseInput = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.';
    const prepared = prepare(ctx, 'read', baseInput);
    if (!prepared.ok) return prepared.outcome;

    let isDirectory = false;
    try {
      isDirectory = statSync(prepared.path).isDirectory();
    } catch {
      return fail('not_found', `目录不存在：${prepared.path}`);
    }
    if (!isDirectory) return fail('not_a_directory', `不是一个目录：${prepared.path}`);

    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.trunc(args.limit), 2_000) : 200;
    const matcher = globToRegExp(args.pattern.trim());
    const files = walkFiles(prepared.path, MAX_WALK_ENTRIES, ctx);

    const hits: string[] = [];
    for (const file of files) {
      if (!checkAccess(ctx.roots, 'read', file).ok) continue;
      const rel = relative(ctx.cwd, file).replaceAll('\\', '/');
      if (matcher.test(rel) || matcher.test(basename(file))) hits.push(rel);
      if (hits.length >= limit) break;
    }

    if (hits.length === 0) {
      return { ok: true, content: `没有匹配 ${args.pattern} 的文件（扫描了 ${files.length} 个文件）` };
    }
    return { ok: true, content: clip(hits.sort().join('\n'), outputLimit(ctx)) };
  },
};

// ────────────────────────────── grep ──────────────────────────────

const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    '在文件内容里按正则搜索，返回 文件:行号: 内容。可再用 glob 过滤文件范围。' +
    '默认区分大小写；找不到就如实说找不到，不要假设文件里没有。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      glob: { type: 'string', description: '只搜匹配这个模式的文件，如 "**/*.ts"' },
      path: { type: 'string', description: '在哪个目录下搜，默认当前工作目录' },
      case_insensitive: { type: 'boolean', description: '为 true 时忽略大小写' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  modes: PERMISSION_MODES,

  // ── 元信息 ──
  source: 'builtin',
  kind: 'read_only',
  group: 'files',
  displayName: '搜内容',
  summary: '按正则在文件内容里搜索，返回 文件:行号: 内容',
  oneLiner: 'Search file contents by regex; returns file:line: text.',
  preferredMode: 'lazy',
  examples: [
    {
      // ★ 模型最常犯的错：忘了 grep 默认区分大小写，搜不到就断言"代码里没有"。
      whenTo: 'you are not sure about capitalization',
      args: { pattern: 'toolmode', glob: '**/*.ts', case_insensitive: true },
    },
  ],

  async execute(rawArgs, ctx) {
    const args = (rawArgs ?? {}) as {
      pattern?: unknown;
      glob?: unknown;
      path?: unknown;
      case_insensitive?: unknown;
    };
    if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
      return fail('invalid_args', 'pattern 不能为空', '传一个正则表达式。');
    }

    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.case_insensitive === true ? 'i' : '');
    } catch (error) {
      return fail('invalid_regex', `正则不合法：${error instanceof Error ? error.message : String(error)}`);
    }

    const baseInput = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.';
    const prepared = prepare(ctx, 'read', baseInput);
    if (!prepared.ok) return prepared.outcome;

    const fileFilter = typeof args.glob === 'string' && args.glob.length > 0 ? globToRegExp(args.glob) : null;
    const files = walkFiles(prepared.path, MAX_WALK_ENTRIES, ctx);
    const matches: string[] = [];
    let scanned = 0;

    for (const file of files) {
      if (scanned >= MAX_GREP_FILES || matches.length >= MAX_GREP_MATCHES) break;
      if (!checkAccess(ctx.roots, 'read', file).ok) continue;
      const rel = relative(ctx.cwd, file).replaceAll('\\', '/');
      if (fileFilter !== null && !fileFilter.test(rel) && !fileFilter.test(basename(file))) continue;

      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size > MAX_GREP_FILE_BYTES) continue;

      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue; // 二进制
      scanned += 1;

      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!regex.test(line)) continue;
        matches.push(`${rel}:${index + 1}: ${line.trim().slice(0, 300)}`);
        if (matches.length >= MAX_GREP_MATCHES) break;
      }
    }

    if (matches.length === 0) {
      return { ok: true, content: `没有匹配（扫描了 ${scanned} 个文件）` };
    }
    return { ok: true, content: clip(matches.join('\n'), outputLimit(ctx)) };
  },
};

export function createFsTools(): ToolDefinition[] {
  return [readTool, writeTool, editTool, globTool, grepTool];
}
