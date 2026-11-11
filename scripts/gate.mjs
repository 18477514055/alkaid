/**
 * 门禁（阶段一第 2 条）：**一条命令，按顺序跑，坏了就停**。
 *
 * ## ★ 为什么要有它
 *
 * `app/scripts/` 下早就有一批 `verify-*` / `audit-*`，但 **`package.json` 的 scripts 里
 * 一个都没有**（报告 D8 §2.6/§4.4 实测：8 个脚本、0 个进 scripts）。
 * 写了不挂进 scripts ≈ 不存在 —— 没人会记得手敲 `node scripts/verify-memory-workbench.ts`。
 *
 * ## ★★ 三条判据（这是它与"一串 &&"的区别）
 *
 * 1. **默认只跑"干净可重复"的那些**。
 *    有些脚本是**真启动打包版**或**要 a) 用户数据目录 b) 桌面端没在跑** 的（发布类），
 *    门禁天天跑它们会：① 撞上用户正在用的桌面端；② 把 `docs/验收-*-发布.json` 这类
 *    "某一次真实发布"的证据文件覆盖掉 —— 那是证据链，不是测试输出。
 *    ⇒ 这类只在 `--release` 时跑，且必须显式给出。
 * 2. **每个步骤有超时**。门禁卡死比不跑更糟：你会以为在跑，实际在等。
 * 3. **输出要能定位**。坏在哪一步、退出码多少、最后 N 行是什么 —— 直接打出来，
 *    不用回头翻日志。
 *
 * ## ★ 为什么是 `.mjs` 而不是 `&&` 串联
 *
 * - `&&` 没有超时、不会把子进程组杀掉（Windows 上留下孤儿进程很常见）；
 * - 失败时只回一个退出码，看不到"哪一步的哪几行"；
 * - 想加"跳过 + 说明理由"就没地方放。
 *
 * 跑法：
 * ```bash
 * node scripts/gate.mjs            # 默认：typecheck → 全量测试 → 三个隔离夹具
 * node scripts/gate.mjs --release  # 追加打包版发布验收（要桌面端已关闭）
 * node scripts/gate.mjs --list     # 只列步骤，不执行
 * ```
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const argv = new Set(process.argv.slice(2));

/**
 * 一步 = 一条命令。
 *
 * `timeoutMs` 是**硬上限**：到点杀子进程并判红。
 * ★ 取值依据：全量测试本机约 20 秒、构建约 10 秒；给 5–10 倍余量，
 *   为的是"真卡住"时能报出来，而不是把慢机器误判成失败。
 */
const STEPS = [
  {
    name: '类型检查（后端）',
    args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    timeoutMs: 180_000,
  },
  {
    name: '类型检查（前端）',
    args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.web.json'],
    timeoutMs: 180_000,
  },
  {
    name: '全量测试',
    args: ['--test', 'test/**/*.test.ts'],
    timeoutMs: 600_000,
  },
  {
    name: '生产构建（前端产物能编出来）',
    args: ['node_modules/vite/bin/vite.js', 'build'],
    timeoutMs: 300_000,
  },
  {
    // ★ 这三个是**隔离夹具**：自己建临时 ALKAID_HOME、自己起 loopback 假模型、
    //   跑完自己删。不碰用户数据目录、不碰真实厂商、不花钱。
    //   `writesReport: true` ⇒ 回执写进临时目录，不弄脏 docs/（见 runStep 的注释）。
    name: '隔离夹具：记忆工作台（HTTP）',
    args: ['scripts/verify-memory-workbench.ts'],
    timeoutMs: 300_000,
    writesReport: true,
  },
  {
    name: '隔离夹具：项目义务闭环（HTTP）',
    args: ['scripts/verify-memory-obligations.ts'],
    timeoutMs: 300_000,
    writesReport: true,
  },
  {
    name: '隔离夹具：简明工作看板（HTTP）',
    args: ['scripts/verify-execution-experience.ts'],
    timeoutMs: 300_000,
    writesReport: true,
  },
  {
    name: '隔离夹具：统一压缩与原文回读（HTTP/SSE）',
    args: ['scripts/verify-compaction.ts', '--once'],
    timeoutMs: 300_000,
    writesReport: true,
  },
];

/**
 * 发布类：**默认不跑**。
 *
 * 判据：它们要么起打包版 exe、要么要求"桌面端没在运行"（`release-guard.mjs` 会主动
 * 拒绝并退出），而且会把 `docs/验收-*-发布.json` 这种"某一次真实发布"的回执覆盖成
 * "刚刚" —— 那是证据，不该被日常门禁改写。
 */
const RELEASE_STEPS = [
  {
    /**
     * ★ 2026-11-11（审计 `LOW-02`）改成**版本无关**的冒烟。
     *
     * 原来这里挂的是 `verify-release-v17.mjs`，它把 `schema = 16/17` 写死在断言里：
     * 项目升到 v18/v19 之后，`--release` 必然红，而红的原因与"打包版坏了"**毫无关系** ——
     * 只是那条发布路径是历史快照。
     *
     * 现在挂 `verify-packaged-smoke.ts`：它从源码 `SCHEMA_VERSION` 推导期望值，
     * 只断言"打包版与源码同一版本 + 新端点可用"，任何版本都能跑。
     * 历史 v16→v17 的四段式发布脚本**保留但不再自动执行**（那是某一次发布的历史证据）。
     */
    name: '发布冒烟：真二进制 + 隔离家（schema 与源码一致）',
    args: ['scripts/verify-packaged-smoke.ts'],
    timeoutMs: 900_000,
  },
];

/**
 * 不在门禁里，但要在 `--list` 里说清"为什么不在"—— 免得下一个人以为是漏了。
 */
const NOT_IN_GATE = [
  ['scripts/verify-memory.ts', '★ 当前在本机失败（见下方 KNOWN_RED），不进门禁以免掩盖真问题'],
  ['scripts/audit-memory-obligations.mjs', '要传一个**真实库路径**才跑（只读审计），属于人工动作'],
  ['scripts/sync-release-safe.mjs', '写打包版文件；必须人工确认桌面端已关闭，不能自动跑'],
  ['scripts/build-dist.mjs', '重装依赖 + 打包，几分钟；属于发布流程，不是门禁'],
  ['scripts/build-icon.mjs', '生成图标资源，一次性'],
  ['scripts/make-shortcut.mjs', '写桌面快捷方式，一次性'],
  ['scripts/seed-demo.ts', '往库里塞演示数据，会改数据'],
  ['scripts/probes/*', '一次性探针'],
  ['scripts/verify-memory-release.mjs', '历史v7/v8基线发布证据，不得对当前打包版重放'],
  ['scripts/verify-obligation-release.mjs', '历史v10/v11基线发布证据，不得对当前打包版重放'],
  ['scripts/verify-experience-release.mjs', '历史v11/v12基线发布证据，不得对当前打包版重放'],
  [
    'scripts/verify-release-v16.mjs',
    '历史v13→v16发布证据，当前基线已v16，不得重放；v17用verify-release-v17.mjs',
  ],
  ['scripts/verify-release-v17.mjs --publish', '显式发布会写打包版文件；必须桌面端关闭并验证deploy→rollback→reapply，默认gate不发布'],
  [
    'scripts/verify-packaged-smoke.ts',
    '真启动打包版 exe；门禁跑它会把"能不能跑"绑到"打包版在不在"，而源码开发时打包版可能是旧的',
  ],
  [
    'scripts/verify-real-db-copy.ts',
    '读**用户真实库的副本**；只读但它依赖本机真实数据，不该成为通用门禁的一步（CI 上没有那个库）',
  ],
];

/**
 * ★★ 已知红（**记录事实，不掩盖**）
 *
 * `scripts/verify-memory.ts --once` 在 **HEAD `a73c3ca` 的干净工作树里也失败**
 * （我在 `git worktree` 里复现过，与本次改动无关）。原因是一处**断言与实现对不上**：
 * 夹具 `scripts/verify-memory.ts:47` 让假模型先吐一句 `MAINTENANCE_ONLY_DO_NOT_SHOW`
 * 再发 `memory_propose` 工具调用；但 `loop.ts` 的 `suppressStream` 只在**看到维护类
 * 工具调用之后**才停止转发，于是那第一段正文已经作为 `text` 事件发出去了。
 * 夹具在 `:81` 断言"整轮 text 拼起来只有业务结果"，`:82` 又断言"不含 MAINTENANCE_ONLY"
 * —— 这两条与 `suppressStream` 的"看到调用才抑制"设计**不可能同时成立**。
 *
 * 处理方式：**不改**（改哪一边都等于替别人做产品决定）；在这里写明，让门禁报它时不至于
 * 被当成"这次改动弄坏的"。要修是单独一件事，见 `docs/阶段一清单` 的后续项。
 */
const KNOWN_RED = {
  'scripts/verify-memory.ts': 'HEAD a73c3ca 干净工作树亦失败：夹具 :81/:82 断言与 loop.ts 的 suppressStream「看到维护调用才抑制」不可能同时成立',
};

const tail = (text, lines = 25) => text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');

/**
 * 跑一步：**不经过 shell**（数组传参），超时杀**整棵进程树**。
 *
 * ★ 为什么要杀树：`node --test` 与夹具都会再起子进程；只 kill 直接子进程的话，
 *   那些孙进程会占着端口（夹具起的是真 HTTP server），下一次运行就 EADDRINUSE。
 *
 * ★ 为什么把 `ALKAID_VERIFY_REPORT_DIR` 指到临时目录：三个隔离夹具默认把回执写到
 *   `docs/验收-*.json`。门禁天天跑的话，那三个文件每次都被刷新（时间戳、随机 UUID 全变）
 *   ⇒ **工作树永远是脏的**，而那些文件是**证据**不是测试输出。脏工作树会让人分不清
 *   "这次改了什么"和"门禁刚跑过"，`git diff` 也就失去意义。
 *   门禁里指到临时目录，人工跑（不带这个变量）仍照旧写 docs/ 留档。
 */
let reportDir = null;

function ensureReportDir() {
  if (reportDir !== null) return reportDir;
  reportDir = mkdtempSync(join(tmpdir(), 'alkaid-gate-reports-'));
  return reportDir;
}

function runStep(step) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, step.args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...(step.writesReport === true ? { ALKAID_VERIFY_REPORT_DIR: ensureReportDir() } : {}),
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      // 门禁要能"边跑边看"：只回显摘要行，避免几万行刷屏
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (/^(ℹ (tests|pass|fail)|✖|vite v|built in|.*\.mjs\b.*exit=|AssertionError)/.test(line.trim())) {
          process.stdout.write(`  ${line.trim()}\n`);
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // ★ 先整树杀（Windows 上 taskkill /T 才管用），失败再退回 kill
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, step.timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveRun({
        ok: !timedOut && code === 0,
        code,
        timedOut,
        ms: Date.now() - started,
        stdout,
        stderr,
      });
    });
    // 启动失败（找不到 tsc 之类）也要有结果，不能永远挂着
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ ok: false, code: null, timedOut: false, ms: Date.now() - started, stdout, stderr: `${stderr}${error.message}` });
    });
  });
}

async function main() {
  const release = argv.has('--release');
  const steps = release ? [...STEPS, ...RELEASE_STEPS] : STEPS;

  if (argv.has('--list')) {
    console.log('门禁步骤：');
    for (const [index, step] of steps.entries()) {
      console.log(`  ${index + 1}. ${step.name}  →  node ${step.args.join(' ')}`);
    }
    console.log('\n不在门禁里（附理由）：');
    for (const [script, why] of NOT_IN_GATE) console.log(`  - ${script}：${why}`);
    if (!release) console.log('\n发布类步骤用 `node scripts/gate.mjs --release` 追加。');
    return 0;
  }

  const failed = [];
  console.log(`门禁开始（${steps.length} 步）${release ? ' —— 含发布验收' : ''}\n`);

  for (const [index, step] of steps.entries()) {
    console.log(`[${index + 1}/${steps.length}] ${step.name}`);
    const result = await runStep(step);
    const seconds = (result.ms / 1000).toFixed(1);

    if (result.ok) {
      console.log(`  ✓ ${seconds}s\n`);
      continue;
    }

    console.log(`  ✗ ${seconds}s${result.timedOut ? `（超时 ${step.timeoutMs}ms，已杀进程树）` : `（exit=${String(result.code)}）`}`);
    const text = `${result.stdout}\n${result.stderr}`.trim();
    if (text.length > 0) console.log(`  ── 末尾 ${Math.min(25, text.split(/\r?\n/).length)} 行 ──\n${tail(text)}\n`);
    failed.push({ step, result });
    // ★ 遇错即停：后面的步骤在"地基已经坏了"的前提下跑出来的结论没有意义，
    //   而且会把真正的失败埋在噪音里。修好再重跑整个门禁。
    break;
  }

  if (failed.length > 0) {
    console.log(`✗ 门禁失败于：${failed.map((item) => item.step.name).join('、')}`);
    return 1;
  }

  console.log(`✓ 门禁全绿（${steps.length} 步）`);
  if (!release) {
    console.log('提示：发布类验收不在默认门禁里（会覆盖 docs/验收-*-发布.json 且要求桌面端已关闭）。');
    console.log('     需要时跑 `node scripts/gate.mjs --release`。');
  }
  console.log('\n已知红（不进门禁，避免掩盖真问题）：');
  for (const [script, why] of Object.entries(KNOWN_RED)) console.log(`  - ${script}：${why}`);
  return 0;
}

/** 清掉门禁自己建的临时报告目录（成功失败都要清，否则临时目录越堆越多） */
function cleanup() {
  if (reportDir === null) return;
  try {
    rmSync(reportDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
}

// ★ 顶层 await 里 return 的退出码必须显式赋给 exitCode，否则永远 0
try {
  process.exitCode = await main();
} finally {
  cleanup();
}
