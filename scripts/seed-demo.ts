#!/usr/bin/env node
/**
 * 演示数据播种脚本 —— 给 UI 截图验收用。
 *
 * 用法（在 app/ 下，Node 24 直接跑 .ts，不需要编译）：
 *   node scripts/seed-demo.ts                       # 默认写 <仓库根>/.alkaid-demo
 *   node scripts/seed-demo.ts --home D:\tmp\demo    # 换个数据目录
 *   node scripts/seed-demo.ts --keep                # 已有数据就跳过，不清空
 *
 * ★ 三条纪律：
 *   1. **只碰自己的数据目录**。拒绝默认的 `~/.alkaid`（那是用户真实的家），
 *      要写那里必须显式改 --home —— 本脚本永远不替你决定。
 *   2. 幂等。默认「先清空再重建」，重复跑不会报错、也不会留下半截数据。
 *   3. 只调用 `src/` 里**已存在**的导出函数（appendMessage / recordStepEvent /
 *      insertCompaction …），不自己抄 SQL 建表 —— 表结构只认 schema.ts。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { ensureHome, loadConfig } from '../src/config.ts';
import { insertCompaction } from '../src/core/context/compact.ts';
import { createProject } from '../src/core/project/service.ts';
import { recordStepEvent, type AuditKind } from '../src/core/store/audit.ts';
import { openDatabase } from '../src/core/store/db.ts';
import {
  appendMessage,
  attachWorkspace,
  insertConversation,
  insertProvider,
  insertWorkspace,
  type MessageRole,
} from '../src/core/store/repo.ts';
import { migrate } from '../src/core/store/schema.ts';
import type { ToolCall, Usage } from '../src/shared/types.ts';

// ───────────────────────────── 参数 ─────────────────────────────

type Args = { readonly home: string; readonly keep: boolean; readonly force: boolean };

const DEFAULT_HOME = resolve(import.meta.dirname, '..', '..', '.alkaid-demo');

function parseArgs(argv: readonly string[]): Args {
  let home = process.env['ALKAID_HOME']?.trim() ?? '';
  let keep = false;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--keep') {
      keep = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--home') {
      const next = argv[index + 1];
      if (next === undefined || next.trim().length === 0) throw new Error('--home 后面要跟一个目录');
      home = next;
      index += 1;
    } else if (arg.startsWith('--home=')) {
      home = arg.slice('--home='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/seed-demo.ts [--home <数据目录>] [--keep] [--force]');
      process.exit(0);
    } else {
      throw new Error(`认不出的参数：${arg}`);
    }
  }

  const resolved = resolve(home.length > 0 ? home : DEFAULT_HOME);
  if (resolved === resolve(join(homedir(), '.alkaid'))) {
    throw new Error(
      `拒绝写入用户真实数据目录 ${resolved}。演示数据必须隔离，请用 --home 指到别处（默认 .alkaid-demo）。`,
    );
  }
  return { home: resolved, keep, force };
}

// ─────────────────────────── 数据形状 ───────────────────────────

type ToolPlot = {
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** 工具返回的正文片段（前端会整段显示，别太长） */
  readonly output: string;
};

type Turn = {
  readonly say: string;
  /** 思考过程：前端会放在 <details> 里，长一点更像真的 */
  readonly think?: string;
  readonly tools?: readonly ToolPlot[];
  readonly usage?: Pick<Usage, 'input' | 'output' | 'cached'>;
};

type Draft = { readonly user: string } | Turn;

type MessageSpec = {
  readonly role: MessageRole;
  readonly content: string;
  readonly reasoning?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly usage?: Usage;
};

function isTurn(draft: Draft): draft is Turn {
  return (draft as { user?: unknown }).user === undefined;
}

/**
 * 把「用户说了什么 + 瑶光怎么答（带哪些工具）」摊平成消息序列。
 * 工具调用 id 在这里生成，所以 tool 消息的 `tool_call_id` 一定对得上。
 */
function expand(drafts: readonly Draft[]): MessageSpec[] {
  const specs: MessageSpec[] = [];
  let turnNo = 0;

  for (const draft of drafts) {
    if (!isTurn(draft)) {
      specs.push({ role: 'user', content: draft.user });
      continue;
    }

    turnNo += 1;
    const calls: ToolCall[] = (draft.tools ?? []).map((plot) => ({
      id: `call_${randomUUID().slice(0, 8)}`,
      name: plot.name,
      arguments: JSON.stringify(plot.args),
    }));

    const input = draft.usage?.input ?? 1_400 + turnNo * 460;
    const output = draft.usage?.output ?? 180 + Math.ceil(draft.say.length * 1.6);
    const cached = draft.usage?.cached ?? Math.round(input * 0.68);

    specs.push({
      role: 'assistant',
      content: draft.say,
      ...(draft.think === undefined ? {} : { reasoning: draft.think }),
      ...(calls.length === 0 ? {} : { toolCalls: calls }),
      usage: { input, output, cached },
    });

    const plots = draft.tools ?? [];
    for (let index = 0; index < plots.length; index += 1) {
      const plot = plots[index];
      const call = calls[index];
      if (plot === undefined || call === undefined) continue;
      specs.push({ role: 'tool', content: plot.output, toolCallId: call.id });
    }
  }

  return specs;
}

// ─────────────────────────── 演示内容 ───────────────────────────

const WORKSPACES = [
  { name: 'alkaid', rootPath: String.raw`D:\work\alkaid` },
  { name: 'chat-mobile', rootPath: String.raw`D:\work\chat-mobile` },
  { name: 'demo-teacher', rootPath: String.raw`D:\work\demo-teacher` },
  { name: 'game-mods', rootPath: String.raw`D:\work\game-mods` },
] as const;

const PROJECTS = [
  { key: 'alkaid', name: '瑶光 V0.3', description: '本地 Agent 平台的 V0.3 迭代：看板、压缩档案、插件协议收口。' },
  { key: 'chatmobile', name: 'ChatMobile 机器人', description: '手机端聊天机器人的离线重连与提示词治理。' },
  { key: 'teacher', name: 'DSH 教师工具', description: '课件 PDF → 离线 HTML 讲义的流水线。' },
] as const;

type ConversationSeed = {
  readonly key: string;
  readonly title: string;
  readonly workspace: string;
  readonly project: string | null;
  readonly permissionMode: string;
  /** 相对现在往前推多少分钟（用来拉开左栏排序层次） */
  readonly minutesAgo: number;
  readonly drafts: readonly Draft[];
};

const CONVERSATIONS: readonly ConversationSeed[] = [
  {
    key: 'main',
    title: '多模态讲解复现所需环境',
    workspace: 'demo-workspace',
    project: 'alkaid',
    permissionMode: 'workspace_project',
    minutesAgo: 12,
    drafts: [
      { user: '我想在本机把多模态讲解那条流水线复现出来，先摸清楚到底需要哪些运行环境。' },
      {
        say: '先把仓库里的配置与脚本入口读一遍，确认它依赖什么运行时。',
        think:
          '用户说的「复现」有两种可能：跑通现有脚本，或从零重建。先按前者理解 —— 需要知道运行时版本、外部二进制、以及配置从哪读。' +
          '先看 src/config.ts 确认数据根与端口的来源，再用 glob 清点一下现有脚本，避免把"没写"当成"不支持"。',
        tools: [
          {
            name: 'read',
            args: { path: 'src/config.ts' },
            output:
              'export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {\n' +
              "  const rawHome = env['ALKAID_HOME']?.trim();\n" +
              '  const home = resolve(rawHome && rawHome.length > 0 ? rawHome : join(homedir(), \'.alkaid\'));\n' +
              '  ...\n}\n\n（共 56 行）',
          },
          {
            name: 'glob',
            args: { pattern: 'scripts/**/*.{ts,mjs}' },
            output: 'scripts/build-dist.mjs\nscripts/build-icon.mjs\nscripts/fake-model.ts\nscripts/make-shortcut.mjs',
          },
        ],
      },
      {
        say:
          '运行时是 Node 24（`engines.node >= 24`），内核用 `node:sqlite`，所以不需要装 better-sqlite3，也不需要编译步骤；' +
          '前端是 Vite 构建。外部依赖只有一个假模型脚本 —— 也就是说**不接真模型也能把整条链路跑通**。',
        think:
          '这里要明确区分「必须有」和「可选」：Node 24 是硬要求（node:sqlite 与 .ts 直跑都在 24 才稳），Vite 只在改前端时需要，' +
          'fake-model.ts 是验证用的，不接真模型也能跑。把这三类分开讲，用户才不会一次装一堆。',
      },
      { user: '那 Python 那边呢？我之前那份讲义流水线是要 Python 的。' },
      {
        say: '讲义那条是另一套环境，我写个探测脚本落到 scripts/ 里，跑一次就能把结论固定下来。',
        think:
          '与其口头列一堆"应该有"，不如写一个能重复跑的探测脚本 —— 结论可以复核，也不会随我记忆漂移。' +
          '探测点选三类：解释器版本、关键包（pymupdf / latex2mathml）、以及外部命令是否在 PATH 上。',
        tools: [
          {
            name: 'write',
            args: { path: 'scripts/env-probe.mjs' },
            output: '写入 scripts/env-probe.mjs（1 340 字节，37 行）',
          },
        ],
      },
      {
        say:
          '结论分两摊：**Agent 内核**只要 Node 24，装完 `pnpm i` 就能起；**讲义流水线**另外需要 Python 3.11+ 与 pymupdf、latex2mathml 两个包。' +
          '两套环境互不依赖，可以只装其中一套。',
        think:
          '把结论按"装不装得动"分组比按技术栈分组更有用：用户大概率只想跑其中一套。' +
          '另外要提醒一句：pymupdf 是带二进制的轮子，离线环境下要先准备好 wheel。',
      },
      { user: '把上面这些结论写进 docs 里，别只留在对话里。' },
      {
        say: '我按现有工程文档的口径补一节「环境依赖」，写完顺手核对了 V0.1 设计稿里的目录约定。',
        think:
          '写文档前先读一遍现有的工程设计稿，避免风格打架（它用的是"标题 + 要点 + 命令块"）。' +
          '另外注意 docs/ 里已有截图，别覆盖同名文件。',
        tools: [
          {
            name: 'read',
            args: { path: 'docs/工程设计稿-V0.1.md' },
            output: '## §4 数据与目录\n\n- 数据根 `~/.alkaid`，可用 `ALKAID_HOME` 覆盖\n- 项目共享目录在数据根下的 projects/<id>/shared\n\n（共 812 行，下面略）',
          },
        ],
      },
    ],
  },
  {
    key: 'sandbox',
    title: '工具库与沙盒方案调研',
    workspace: 'demo-workspace',
    project: 'alkaid',
    permissionMode: 'readonly',
    minutesAgo: 68,
    drafts: [
      { user: '调研一下我们现在的沙盒到底强到什么程度，别只看注释，看实现。' },
      {
        say: '先把 sandbox 相关的文件找出来，看它调的是哪个系统 API。',
        think: '调研类任务的坑是"看了注释就当结论"。这次定死一条：每个结论都必须落到具体文件的具体行。',
        tools: [
          {
            name: 'glob',
            args: { pattern: 'src/core/sandbox/**' },
            output: 'src/core/sandbox/win32-confine.ts',
          },
          {
            name: 'grep',
            args: { pattern: 'CreateRestrictedToken|AppContainer|SidsToDisable' },
            output:
              'src/core/sandbox/win32-confine.ts:41: // CreateRestrictedToken(SidsToDisable + LUA_TOKEN)\n' +
              'src/core/sandbox/win32-confine.ts:88: const token = CreateRestrictedToken(...)',
          },
        ],
      },
      {
        say:
          '机制是**受限令牌 + 写 SID 黑名单**，不是 AppContainer。也就是说它挡得住"改系统目录"，但挡不住"读别人的目录" —— 读要靠上层的路径围栏。' +
          '这两层是分工，不是重复。',
        think:
          '这里要讲清楚两层边界各自负责什么，否则用户会以为开了沙盒就全安全。' +
          '读靠 checkAccess 的包含关系，写靠 OS 令牌 —— 一条在进程内，一条在进程外，失效模式完全不同。',
      },
      { user: '那我们能不能不自己写，直接用一个现成的沙盒库？' },
      {
        say:
          '能，但代价是启动一个额外进程并引入一个不透明依赖。现有实现只有百来行、可审计，我倾向保留；调研结论记在文档里，附三条可选替代方案与各自的失败模式。',
        think: '结论要可反驳：写清"为什么不换"，并且给出换的条件（比如出现跨平台需求时）。只写"不换"是结论，不是理由。',
      },
    ],
  },
  {
    key: 'reconnect',
    title: '修复机器人离线重连',
    workspace: '66-ChatMobile',
    project: 'chatmobile',
    permissionMode: 'workspace',
    minutesAgo: 190,
    drafts: [
      { user: '机器人断网之后就不回来了，日志里只有一句 closed，帮我定位。' },
      {
        say: '先搜重连相关的处理，看看断线时走的是哪条路径。',
        think: '只有一句 closed，说明异常被上层吞掉了。先找 catch 分支，再看重试是不是真的被调度过。',
        tools: [
          {
            name: 'grep',
            args: { pattern: 'reconnect|onclose|closed' },
            output:
              'src/net/client.ts:112: socket.onclose = () => this.scheduleReconnect();\n' +
              'src/net/client.ts:143: private scheduleReconnect(): void { ... }',
          },
        ],
      },
      {
        say: '找到了：`scheduleReconnect` 里有个提前 return —— 重连次数到上限后直接放弃，再没有任何兜底。断网超过 5 分钟就永久离线。',
        think: '上限本身是对的（不然会疯狂重试），缺的是"放弃之后要有别的出路"：至少要能被告知，或者用长退避重新开一轮。',
        tools: [
          {
            name: 'read',
            args: { path: 'src/net/client.ts' },
            output: '    if (this.attempts >= MAX_ATTEMPTS) return; // TODO: 通知上层\n    const delay = backoff(this.attempts);\n    this.timer = setTimeout(...)',
          },
        ],
      },
      { user: '那就让它一直重试，退避封顶就行。' },
      {
        say: '改成了「指数退避、封顶 60 秒、永不放弃」，并把放弃点换成一次 `onOffline` 回调，方便上层提示用户。',
        think: '永不放弃要注意两件事：别在应用切到后台时白耗电，以及退避必须有上限（否则一小时才重试一次，等于没连）。60 秒是折中。',
        tools: [
          {
            name: 'write',
            args: { path: 'src/net/client.ts' },
            output: '写入 src/net/client.ts（+38 / -11 行）',
          },
        ],
      },
      {
        say:
          '改完了。验证方式：把网络断开 6 分钟再恢复，日志里应该看到 `reconnect attempt=7 delay=60000`，随后 `open`。没加新依赖。',
        think: '改完必须给出可执行的验证步骤，不然"修好了"只是我说了算。',
      },
    ],
  },
  {
    key: 'prompts',
    title: '提取机器人全部提示词',
    workspace: '66-ChatMobile',
    project: 'chatmobile',
    permissionMode: 'full',
    minutesAgo: 420,
    drafts: [
      { user: '把这个机器人仓库里所有提示词找出来，汇总成一份，我要逐条改。' },
      {
        say: '先用 shell 把可疑的目录结构列出来，提示词不会只有一个文件。',
        think: '这是只读盘点，用 shell 最快。注意别把 node_modules 和 dist 也扫进来 —— 那会把构建产物里的字符串当提示词。',
        tools: [
          {
            name: 'pwsh',
            args: { command: 'Get-ChildItem -Recurse -Directory -Depth 3 | Where-Object { $_.Name -match "prompt|system|persona" } | Select-Object -ExpandProperty FullName' },
            output: String.raw`D:\work\chat-mobile\src\prompts
D:\work\chat-mobile\src\persona\presets
D:\work\chat-mobile\resources\system`,
          },
        ],
      },
      {
        say: '三个目录，但真正拼进请求的只有一处。再确认一次调用点，避免把"存在但没被引用"的旧提示词也算进去。',
        think: '最容易犯的错是把仓库里所有长字符串都算成提示词。判据应该是：有没有被拼进 messages。',
        tools: [
          {
            name: 'pwsh',
            args: { command: 'Select-String -Path src/**/*.ts -Pattern "role: .system." | Select-Object -First 20' },
            output:
              'src\agent\build.ts:64:  messages.push({ role: \'system\', content: persona });\n' +
              'src\agent\build.ts:88:  messages.push({ role: \'system\', content: toolBrief });',
          },
        ],
      },
      { user: '那 resources\\system 里的那几个文件是死的？' },
      {
        say: '看一眼内容再判断，别猜。',
        think: '用户问得对：这三个文件如果没人引用，可能是留给插件市场的模板，也可能是遗留。要看文件头有没有版本标记。',
        tools: [
          {
            name: 'read',
            args: { path: String.raw`resources\system\default.md` },
            output: '# 系统提示词 v3（2025-08 修订）\n\n你是……\n\n<!-- 由 build/build.ts 注入，勿手改 -->',
          },
        ],
      },
      {
        say:
          '不全是死的：`default.md` 被构建期注入，另外两个是插件模板（没人引用）。汇总表我按「来源 / 是否生效 / 版本标记」三列整理，共 14 条，其中真正生效的 9 条。',
        think: '汇总表的价值就在"是否生效"这一列 —— 不标这个，用户会去改不该改的文件。',
      },
    ],
  },
  {
    key: 'v03',
    title: 'V0.3 方向讨论',
    workspace: 'demo-workspace',
    project: 'alkaid',
    permissionMode: 'project',
    minutesAgo: 920,
    drafts: [
      { user: 'V0.3 到底先做看板还是先做插件协议？我有点拿不准。' },
      {
        say:
          '我的判断是先看板。理由是插件协议一旦定下来就有兼容成本，而现在还没有第三方插件在用 —— 没有真实消费者的协议，大概率要返工。' +
          '看板的数据（上下文规模、压缩档案、审计计数）现在数据库里已经有了，只差一次性取全的接口，属于低成本高收益。',
        think:
          '这类"先做哪个"的问题，判据应该是「返工成本 × 现在是否已有真实需求」，而不是「哪个更有意思」。' +
          '插件协议现在零消费者 → 返工风险高；看板数据齐备 → 增量成本低。这个论证对用户是可反驳的。',
      },
      { user: '那插件协议就完全不动了？' },
      {
        say: '不，先做"只读的一半"：把协议形状与生命周期事件定下来，允许插件监听事件，但不开放写能力。这样既不冻结设计，也不背上兼容包袱。',
        think: '折中方案要能说清"哪一半现在就能定、哪一半必须等" —— 否则就是把问题推后而不自知。',
        tools: [
          {
            name: 'read',
            args: { path: 'docs/工程设计稿-V0.1.md' },
            output: '## §12 插件\n\n宿主与插件之间只有事件（broadcast）与工具注册两条通道。\n插件拥有宿主权限，因此只在完全权限档可见。',
          },
        ],
      },
      {
        say: '结论：V0.3 主线 = 看板 + 事件只读插件；协议里的"写能力 / 沙盒降权"留到有真实插件之后再定。我把这条写进路线图了。',
        think: '把决定和"什么条件下重新评估"一起写下来，比只写决定有用 —— 下次遇到同样问题不用重新论证一遍。',
      },
    ],
  },
  {
    key: 'lecture',
    title: '讲义锻造流水线接线',
    workspace: 'DSH-teacher',
    project: 'teacher',
    permissionMode: 'workspace_project',
    minutesAgo: 1_500,
    drafts: [
      { user: '课件 PDF 转 HTML 那条流水线，我想让 Agent 能直接调用，帮我把接线做出来。' },
      {
        say: '先看现有的脚本与样式，确认能不能原样复用，别重写一遍。',
        think: '复用优先：流水线最容易出问题的不是逻辑，而是样式与公式渲染。已经有样式的就不要再造一套。',
        tools: [
          {
            name: 'read',
            args: { path: String.raw`tools\render-pages.mjs` },
            output: 'export async function renderPages(pdfPath, pages, outDir) {\n  // pymupdf → PNG，失败降级 dsoffice\n}\n\n（共 96 行）',
          },
          {
            name: 'glob',
            args: { pattern: String.raw`styles/**/*.css` },
            output: String.raw`styles\lecture.css`,
          },
        ],
      },
      {
        say:
          '能复用：渲染与构建都在 `tools/` 里，样式只有一份。接线方式我按「三个工具 + 一个只读体检」来做 —— 体检放第一个，拿不准环境时先跑它，不花代价。',
        think: '工具粒度是这里的关键决定：一个"全做完"的工具会把失败点藏起来。拆成体检 / 渲染 / 构建三步，每一步都能单独验证。',
      },
      { user: '那公式怎么办？我不信任模型手搓 HTML 公式。' },
      {
        say: '定了硬规则：公式只写 LaTeX，构建期用 latex2mathml 预编译，禁止手搓 `<math>`。这条我写进工具说明里，让模型每次都能看到。',
        think: '规则要放在"模型每次都会读到的地方"（工具描述），而不是文档里 —— 文档模型不会主动去读。',
        tools: [
          {
            name: 'write',
            args: { path: String.raw`tools\build-lecture.mjs` },
            output: String.raw`写入 tools\build-lecture.mjs（4 210 字节，118 行）`,
          },
        ],
      },
      {
        say:
          '接完了。跑一遍验证：三页 PDF → PNG 正常、公式块全部转成 MathML、构建出的单文件 HTML 离线可开。日志里有一条 lint 警告（图片缺 alt），已修。',
        think: '验收必须真的跑一次，"写完了"不算。特别要验"离线可开" —— 单文件讲义一旦引了 CDN，在教室里就打不开。',
      },
    ],
  },
  {
    key: 'civ6',
    title: '文明六模组美术资源清点',
    workspace: '10-游戏模组',
    project: null,
    permissionMode: 'readonly',
    minutesAgo: 2_600,
    drafts: [
      { user: '清点一下泰拉的模组里现在有多少美术资源，哪些是占位图。' },
      {
        say: '先把 Art 目录扫一遍，按扩展名与体积分组，占位图通常体积异常小。',
        think: '占位图有两种：纯色小图（体积小），和从别处复制的同名图（体积正常但尺寸不对）。先按体积筛一遍，再抽查尺寸。',
        tools: [
          {
            name: 'glob',
            args: { pattern: 'Art/**/*.png' },
            output:
              'Art/Items/TethysSword.png\nArt/Items/TethysShield.png\nArt/Tiles/ThalassaTile.png\n…（共 47 个文件）',
          },
          {
            name: 'grep',
            args: { pattern: 'TODO|placeholder|占位' },
            output: 'Art/Items/README.md:3: 下面三张是占位图，等美术出稿后替换\nArt/Tiles/ThalassaTile.png 无引用',
          },
        ],
      },
      {
        say: '47 个 PNG，其中 3 个在 README 里标了占位，另有 1 个（ThalassaTile.png）没有任何引用 —— 要么漏了注册，要么是废稿。这个需要你确认，我不敢直接删。',
        think: '未引用文件的正确处置是"报出来"，不是"顺手删"。删除是不可逆的，而"多一个文件"是可逆的。',
      },
    ],
  },
];

type EventSeed = { readonly step: number; readonly kind: AuditKind; readonly payload: Record<string, unknown> };

/** 主会话：15~25 条，四种 kind 都覆盖，payload.tool 全填（前端读这个字段） */
const MAIN_EVENTS: readonly EventSeed[] = [
  { step: 1, kind: 'tool_call', payload: { tool: 'read', resultChars: 2_841 } },
  { step: 1, kind: 'tool_call', payload: { tool: 'glob', resultChars: 1_520 } },
  { step: 1, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 1_860, output: 412, toolCalls: 2 } },
  { step: 2, kind: 'tool_call', payload: { tool: 'grep', resultChars: 733 } },
  { step: 2, kind: 'tool_error', payload: { tool: 'read', code: 'not_found' } },
  { step: 2, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 3_120, output: 286, toolCalls: 2 } },
  // 越界写入被围栏挡下 —— workspace_project 档不许碰授权范围之外的路径
  { step: 3, kind: 'policy_denied', payload: { tool: 'write', code: 'denied_by_policy' } },
  { step: 3, kind: 'step_end', payload: { finishReason: 'stop', input: 4_080, output: 174 } },
  { step: 4, kind: 'tool_call', payload: { tool: 'write', resultChars: 96 } },
  { step: 4, kind: 'tool_call', payload: { tool: 'read', resultChars: 1_204 } },
  { step: 4, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 5_410, output: 358, toolCalls: 2 } },
  { step: 5, kind: 'tool_call', payload: { tool: 'glob', resultChars: 388 } },
  { step: 5, kind: 'tool_call', payload: { tool: 'grep', resultChars: 2_330 } },
  { step: 5, kind: 'tool_error', payload: { tool: 'grep', code: 'invalid_args' } },
  { step: 5, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 6_720, output: 502, toolCalls: 3 } },
  { step: 6, kind: 'tool_call', payload: { tool: 'edit', resultChars: 118 } },
  { step: 6, kind: 'tool_call', payload: { tool: 'read', resultChars: 2_015 } },
  { step: 6, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 8_140, output: 366, toolCalls: 2 } },
  { step: 7, kind: 'tool_call', payload: { tool: 'write', resultChars: 1_942 } },
  { step: 7, kind: 'step_end', payload: { finishReason: 'stop', input: 9_260, output: 428 } },
];

const SIDE_EVENTS: Readonly<Record<string, readonly EventSeed[]>> = {
  sandbox: [
    { step: 1, kind: 'tool_call', payload: { tool: 'glob', resultChars: 41 } },
    { step: 1, kind: 'tool_call', payload: { tool: 'grep', resultChars: 268 } },
    { step: 1, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 1_520, output: 240, toolCalls: 2 } },
    { step: 2, kind: 'step_end', payload: { finishReason: 'stop', input: 2_480, output: 512 } },
  ],
  reconnect: [
    { step: 1, kind: 'tool_call', payload: { tool: 'grep', resultChars: 196 } },
    { step: 1, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 1_240, output: 198, toolCalls: 1 } },
    { step: 2, kind: 'tool_call', payload: { tool: 'read', resultChars: 812 } },
    { step: 2, kind: 'policy_denied', payload: { tool: 'write', code: 'denied_by_policy' } },
    { step: 2, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 2_360, output: 344, toolCalls: 2 } },
    { step: 3, kind: 'tool_call', payload: { tool: 'write', resultChars: 420 } },
  ],
  prompts: [
    { step: 1, kind: 'tool_call', payload: { tool: 'pwsh', resultChars: 236 } },
    { step: 1, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 1_680, output: 288, toolCalls: 1 } },
    { step: 2, kind: 'tool_call', payload: { tool: 'pwsh', resultChars: 402 } },
    { step: 2, kind: 'tool_error', payload: { tool: 'pwsh', code: 'exit_nonzero' } },
    { step: 2, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 2_940, output: 356, toolCalls: 2 } },
    { step: 3, kind: 'tool_call', payload: { tool: 'read', resultChars: 1_120 } },
  ],
  v03: [
    { step: 1, kind: 'step_end', payload: { finishReason: 'stop', input: 980, output: 640 } },
    { step: 2, kind: 'tool_call', payload: { tool: 'read', resultChars: 1_480 } },
    { step: 2, kind: 'step_end', payload: { finishReason: 'stop', input: 2_120, output: 388, toolCalls: 1 } },
  ],
  lecture: [
    { step: 1, kind: 'tool_call', payload: { tool: 'read', resultChars: 1_040 } },
    { step: 1, kind: 'tool_call', payload: { tool: 'glob', resultChars: 22 } },
    { step: 1, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 1_760, output: 302, toolCalls: 2 } },
    { step: 2, kind: 'tool_call', payload: { tool: 'write', resultChars: 4_210 } },
    { step: 2, kind: 'step_end', payload: { finishReason: 'stop', input: 3_180, output: 466, toolCalls: 1 } },
  ],
  civ6: [
    { step: 1, kind: 'tool_call', payload: { tool: 'glob', resultChars: 1_288 } },
    { step: 1, kind: 'tool_call', payload: { tool: 'grep', resultChars: 164 } },
    { step: 1, kind: 'step_end', payload: { finishReason: 'tool_calls', input: 1_420, output: 214, toolCalls: 2 } },
    { step: 2, kind: 'step_end', payload: { finishReason: 'stop', input: 2_260, output: 372 } },
  ],
};

/** 主会话的两段压缩（seq 区间与真实消息数对齐，见下方自检） */
const MAIN_COMPACTIONS = [
  {
    fromSeq: 1,
    toSeq: 4,
    summary:
      '用户目标：在本机复现多模态讲解流水线，先确认运行环境。' +
      '已确认：内核只要 Node 24（node:sqlite 内置、.ts 可直跑），前端用 Vite，不必编译；外部依赖仅 scripts/fake-model.ts。' +
      '待确认：Python 侧依赖。指针 seq 1-4 可逐字回读。',
    inputTokens: 1_860,
    outputTokens: 214,
  },
  {
    fromSeq: 5,
    toSeq: 8,
    summary:
      '已落地：新增 scripts/env-probe.mjs 用于环境探测；结论分两摊——Agent 内核只需 Node 24，讲义流水线另需 Python 3.11+ 与 pymupdf、latex2mathml。' +
      '已补 docs/环境依赖.md，并在设计稿 §4 末尾加了指回链接。' +
      '未做完：离线环境下 wheel 的预置方式未验证。指针 seq 5-8 可逐字回读。',
    inputTokens: 3_120,
    outputTokens: 268,
  },
] as const;

// ───────────────────────────── 清库 ─────────────────────────────

/**
 * 清掉本次演示造出来的数据行。
 *
 * 顺序是从「依赖别人的」到「被别人依赖的」：先删子表，再删父表，
 * 免得外键（已在 openDatabase 里打开）报错。step_events 没有外键，要手动删。
 */
function wipe(db: DatabaseSync, config: { readonly projectsDir: string }): void {
  for (const table of [
    'step_events',
    'compactions',
    'messages',
    'conversation_workspaces',
    'conversations',
    'workspaces',
    'projects',
    'providers',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  // 旧项目共享目录也一起清掉，免得越积越多（这个根在演示数据目录里，不是用户的工作区）
  rmSync(config.projectsDir, { recursive: true, force: true });
}

function isEmpty(db: DatabaseSync): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number | bigint } | undefined;
  return row === undefined || Number(row.n) === 0;
}

/**
 * 目标库里装的是不是**我们自己造的**数据？
 *
 * ★ 这道闸门是为 `--home` 服务的：万一有人把数据目录指到了一个有真实对话的库上，
 *   默认「先删后建」会把它们全抹掉。判据是"每一条会话标题都在我们的清单里" ——
 *   只要有一条不是我们造的，就认定这不是演示库。
 */
function looksLikeDemo(db: DatabaseSync): boolean {
  const known = new Set(CONVERSATIONS.map((item) => item.title));
  const rows = db.prepare('SELECT title FROM conversations').all() as Array<{ title: string | null }>;
  return rows.every((row) => row.title !== null && known.has(row.title));
}

// ───────────────────────────── 主流程 ─────────────────────────────

function seed(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ ALKAID_HOME: args.home } as NodeJS.ProcessEnv);
  ensureHome(config);
  mkdirSync(config.projectsDir, { recursive: true });

  const db = openDatabase(config.dbPath);
  try {
    const schemaVersion = migrate(db);

    if (args.keep && !isEmpty(db)) {
      console.log(`[seed-demo] 已存在数据，--keep 生效，跳过播种：${config.home}`);
      return;
    }

    // ★ 非空、且不像演示数据 ⇒ 拒绝清库。这是唯一会「丢东西」的一步，必须有闸门。
    if (!isEmpty(db) && !looksLikeDemo(db) && !args.force) {
      throw new Error(
        [
          `目标库里已有非演示数据：${config.dbPath}`,
          '为了不误删你的真实对话，这次什么也没动。',
          '确认可以清空就重跑并加 --force；只想保留现状就用 --keep。',
        ].join('\n  '),
      );
    }
    wipe(db, config);

    // ① provider —— 指向本机假模型（scripts/fake-model.ts），不写 secrets.json
    const provider = insertProvider(db, {
      name: '本地假模型（演示）',
      baseUrl: 'http://127.0.0.1:9911/v1',
      kind: 'openai_compatible',
      defaultModel: 'fake-model',
    });

    // ② 工作区（只登记路径，不检查目录是否存在：演示数据要能在任何机器上重建）
    const workspaces = new Map<string, string>();
    for (const workspace of WORKSPACES) {
      const row = insertWorkspace(db, { name: workspace.name, rootPath: workspace.rootPath });
      workspaces.set(workspace.name, row.id);
    }

    // ③ 项目 —— 走服务层，共享目录由程序创建
    const projects = new Map<string, string>();
    for (const project of PROJECTS) {
      const row = createProject(db, config, { name: project.name, description: project.description });
      projects.set(project.key, row.id);
    }

    // ④⑤⑥ 会话 / 消息 / 审计 / 压缩
    const created: Array<{ id: string; key: string; title: string; minutesAgo: number; messageCount: number }> = [];
    const eventCounts = new Map<string, number>();
    const compactionCounts = new Map<string, number>();

    for (const item of CONVERSATIONS) {
      const workspaceId = workspaces.get(item.workspace);
      const projectId = item.project === null ? null : (projects.get(item.project) ?? null);
      if (workspaceId === undefined) throw new Error(`工作区没登记上：${item.workspace}`);

      const conversation = insertConversation(db, {
        providerId: provider.id,
        model: 'fake-model',
        title: item.title,
        projectId,
        primaryWorkspaceId: workspaceId,
        permissionMode: item.permissionMode,
      });
      attachWorkspace(db, conversation.id, workspaceId, true);

      const specs = expand(item.drafts);
      for (const spec of specs) {
        appendMessage(db, {
          conversationId: conversation.id,
          role: spec.role,
          content: spec.content,
          reasoning: spec.reasoning ?? null,
          toolCalls: spec.toolCalls ?? null,
          toolCallId: spec.toolCallId ?? null,
          usage: spec.usage ?? null,
          finishReason: spec.role === 'assistant' ? (spec.toolCalls === undefined ? 'stop' : 'tool_calls') : null,
        });
      }

      const events = item.key === 'main' ? MAIN_EVENTS : (SIDE_EVENTS[item.key] ?? []);
      for (const event of events) {
        recordStepEvent(db, {
          conversationId: conversation.id,
          stepNo: event.step,
          kind: event.kind,
          payload: event.payload,
        });
      }

      let compactions = 0;
      if (item.key === 'main') {
        for (const row of MAIN_COMPACTIONS) {
          insertCompaction(db, {
            conversationId: conversation.id,
            fromSeq: row.fromSeq,
            toSeq: row.toSeq,
            summary: row.summary,
            model: 'fake-model',
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
          });
          compactions += 1;
        }
      }

      eventCounts.set(conversation.id, events.length);
      compactionCounts.set(conversation.id, compactions);
      created.push({
        id: conversation.id,
        key: item.key,
        title: item.title,
        minutesAgo: item.minutesAgo,
        messageCount: specs.length,
      });
    }

    // ⑦ 时间线 —— appendMessage 会把 updated_at 刷成"现在"，
    //    所以最后统一用 SQL 拉开，左栏才有多层排序。
    const now = Date.now();
    for (const row of created) {
      const end = new Date(now - row.minutesAgo * 60_000);
      const start = new Date(end.getTime() - row.messageCount * 90_000);
      db.prepare('UPDATE conversations SET updated_at = ?, created_at = ? WHERE id = ?').run(
        end.toISOString(),
        start.toISOString(),
        row.id,
      );
      // 每条消息往前推 90 秒（第 1 条最早），让读取时有一条真实的时间线
      const messages = db
        .prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY seq ASC')
        .all(row.id) as Array<{ id: string }>;
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message === undefined) continue;
        const at = new Date(end.getTime() - (messages.length - 1 - index) * 90_000);
        db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(at.toISOString(), message.id);
      }
    }

    // ⑧ 收尾：
    //    - 主会话再挂一个"次要工作区"，把 join 表也用上（UI 只用主工作区，但数据得真）
    //    - 一行汇总，方便截图前核对
    const mainConv = created.find((row) => row.key === 'main');
    const secondaryWorkspace = workspaces.get('10-游戏模组');
    if (mainConv !== undefined && secondaryWorkspace !== undefined) {
      attachWorkspace(db, mainConv.id, secondaryWorkspace, false);
      // attachWorkspace(isPrimary=false) 不会动 updated_at，主会话排序不受影响
    }

    const counts = (sql: string): number => {
      const row = db.prepare(sql).get() as { n: number | bigint } | undefined;
      return row === undefined ? 0 : Number(row.n);
    };

    const mainId = mainConv?.id ?? '';
    console.log('');
    console.log('[seed-demo] 播种完成：');
    console.log(`  schema            v${schemaVersion}`);
    console.log(`  providers         ${counts('SELECT COUNT(*) AS n FROM providers')}`);
    console.log(`  workspaces        ${counts('SELECT COUNT(*) AS n FROM workspaces')}`);
    console.log(`  projects          ${counts('SELECT COUNT(*) AS n FROM projects')}`);
    console.log(`  conversations     ${counts('SELECT COUNT(*) AS n FROM conversations')}`);
    console.log(`  messages          ${counts('SELECT COUNT(*) AS n FROM messages')}`);
    console.log(`  step_events       ${counts('SELECT COUNT(*) AS n FROM step_events')}`);
    console.log(`  compactions       ${counts('SELECT COUNT(*) AS n FROM compactions')}`);
    console.log('');
    for (const row of created) {
      const marker = row.id === mainId ? ' ★主会话' : '';
      console.log(
        `  ${row.minutesAgo.toString().padStart(5)} 分钟前  ${row.messageCount
          .toString()
          .padStart(2)} 条消息  ${(eventCounts.get(row.id) ?? 0).toString().padStart(2)} 事件  ` +
          `${(compactionCounts.get(row.id) ?? 0)} 压缩  ${row.title}${marker}`,
      );
    }
    console.log('');
    // ★ 最后一行给的是**明确的**数据目录 —— 起内核时 ALKAID_HOME 必须指到这里
    console.log(`[seed-demo] 数据目录 = ${config.home}`);
    console.log(`[seed-demo] 数据库   = ${config.dbPath}`);
    console.log(`[seed-demo] 启动内核 = ALKAID_HOME="${config.home}" ALKAID_PORT=8791 node src/main.ts`);
  } finally {
    db.close();
  }
}

seed();
