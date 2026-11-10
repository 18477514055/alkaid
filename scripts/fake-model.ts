/**
 * 假模型服务器 —— 让 UI 与主循环能在**不花一分钱、不碰真密钥**的前提下跑通。
 *
 * 用法：
 *   node scripts/fake-model.ts            # 默认 9911 端口
 *   node scripts/fake-model.ts 9922
 *
 * 然后在界面的「模型连接」里填：
 *   Base URL = http://127.0.0.1:9911/v1
 *   模型名   = fake-model
 *   API Key  = 随便填（≥6 位）
 *
 * 它发出去的字节形状与 OpenAI 流式接口一致（含 `[DONE]` 与 usage），
 * 所以它验的是**我们的解析与循环**，不是它的实现。
 *
 * 额外约定（用来在 UI 里手工验工具链）：
 * - 用户消息里带 `shell` ⇒ 本回合发一个 `pwsh` 工具调用；
 * - 对话里已经出现工具结果 ⇒ 把结果原文回显出来（证明工具结果真的进了上下文）。
 */
import { createServer } from 'node:http';

const port = Number.parseInt(process.argv[2] ?? '9911', 10);

const PLAIN_REPLY = ['你好，', '我是假模型。', '这条回复由本地脚本生成，不消耗任何额度。'];

/**
 * 手测界面用：用户消息里带 `markdown` ⇒ 回一段覆盖各种 Markdown 语法的正文。
 * 用来验证渲染器（标题 / 列表 / 行内代码 / 代码块 / 表格 / 引用 / 链接）以及 XSS 清洗。
 */
const MARKDOWN_REPLY = [
  '## 环境依赖结论\n\n',
  '先说结论：**内核只要 Node 24**，流水线那套额外要 Python。\n\n',
  '### 需要装什么\n\n',
  '1. `pnpm i` —— 内核依赖\n',
  '2. `pip install pymupdf latex2mathml` —— 讲义流水线\n',
  '3. 可选：`rdkit`（化学式校验）\n\n',
  '### 一个代码块\n\n',
  '```ts\n',
  'export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {\n',
  "  const rawHome = env['ALKAID_HOME']?.trim();\n",
  '  return { home: resolve(rawHome ?? join(homedir(), \'.alkaid\')) };\n',
  '}\n',
  '```\n\n',
  '### 对照表\n\n',
  '| 组件 | 版本 | 必需 |\n|---|---|---|\n| Node | 24+ | 是 |\n| Python | 3.11+ | 否 |\n| pymupdf | 最新 | 否 |\n\n',
  '> 提示：两套环境互不依赖，可以只装其中一套。\n\n',
  '参考 [Node 官网](https://nodejs.org) 与 `docs/工程设计稿-V0.1.md`。\n',
];


type WireMessage = { role: string; content: string | null; tool_call_id?: string };

function writeSse(res: import('node:http').ServerResponse, payload: unknown): void {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
}

function startStream(res: import('node:http').ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function finish(res: import('node:http').ServerResponse, outputTokens = 18): void {
  writeSse(res, {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 42, completion_tokens: outputTokens, prompt_cache_hit_tokens: 32 },
  });
  writeSse(res, '[DONE]');
  res.end();
}

const server = createServer((req, res) => {
  /**
   * `GET /v1/models` —— 目录端点。
   * ★ 必须真的实现：设置页的「对话中可选的模型」靠它拿目录，
   *   以前这里所有路径都当聊天流处理，问一次目录就返回一段 SSE 正文，
   *   前端解析失败 ⇒ 白名单勾选区永远是空的，那条路径根本测不到。
   * ★ 故意返回比实际配置多的模型（3 个），这样才验得出"白名单过滤"是否真在生效。
   */
  if (req.method === 'GET' && req.url !== null && /\/models(\?.*)?$/.test(req.url)) {
    const ids = ['fake-model', 'fake-model-large', 'fake-model-reasoning'];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', owned_by: 'fake' })),
      }),
    );
    console.log(`[fake-model] GET ${req.url} -> ${ids.length} models`);
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let model = 'fake-model';
    let messages: WireMessage[] = [];
    try {
      const parsed = JSON.parse(raw) as { model?: string; messages?: WireMessage[] };
      model = parsed.model ?? model;
      messages = parsed.messages ?? [];
    } catch {
      /* 不关心 */
    }
    console.log(`[fake-model] ${req.method} ${req.url} model=${model} messages=${messages.length}`);

    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const systemText = messages.find((message) => message.role === 'system')?.content ?? '';
    const tail = messages[messages.length - 1];
    const lastTool = tail?.role === 'tool' ? tail : undefined;
    const wantsShell = (lastUser?.content ?? '').toLowerCase().includes('shell');
    const isCompaction = systemText.includes('上下文压缩器');
    // 手测通道：`tool:<工具名>:<JSON 参数>` ⇒ 原样发起一次工具调用（验权限围栏/插件用）
    // 工具名可能带点号与连字符（如 p.demo-echo.echo），所以名字部分不能只认 \w
    const handcrafted = /^tool:([^:\s]+):([\s\S]+)$/.exec((lastUser?.content ?? '').trim());

    startStream(res);

    // 压缩请求：回一份像样的摘要（让看板有真实内容可看）
    if (isCompaction) {
      for (const piece of [
        '【摘要】用户目标是测试 Alkaid 的完整链路。',
        '已确认的约束：权限由程序强制、密钥不进日志、压缩必须带指针。',
        '已完成：配置模型、创建对话、多轮问答。',
        '未完成：真实厂商 endpoint 验证。',
      ]) {
        writeSse(res, { choices: [{ delta: { content: piece } }] });
      }
      finish(res, 60);
      return;
    }

    // 已经拿到工具结果 ⇒ 把结果回显（证明工具结果进了上下文）。★ 必须先判这条，
    // 否则手测通道会一直重复发起同一次调用，被主循环的 doom_loop 熔断掉。
    if (lastTool !== undefined && lastTool.content !== null) {
      for (const piece of ['工具返回了：\n', lastTool.content.slice(0, 800)]) {
        writeSse(res, { choices: [{ delta: { content: piece } }] });
      }
      finish(res);
      return;
    }

    if (handcrafted !== null) {
      const [, toolName, rawArgs] = handcrafted;
      writeSse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_fake_${toolName}`,
                  type: 'function',
                  function: { name: toolName, arguments: rawArgs },
                },
              ],
            },
          },
        ],
      });
      writeSse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      writeSse(res, '[DONE]');
      res.end();
      return;
    }

    // 用户要 shell ⇒ 发一个工具调用
    if (wantsShell) {
      writeSse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_fake_1',
                  type: 'function',
                  function: { name: 'pwsh', arguments: '{"command":"Write-Output \'来自 pwsh 工具的问候\'"}' },
                },
              ],
            },
          },
        ],
      });
      writeSse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      writeSse(res, '[DONE]');
      res.end();
      return;
    }

    // 用户要 Markdown 样例 ⇒ 回一段覆盖各种语法的正文（验渲染器与 XSS 清洗）
    if ((lastUser?.content ?? '').toLowerCase().includes('markdown')) {
      for (const piece of MARKDOWN_REPLY) {
        writeSse(res, { choices: [{ delta: { content: piece } }] });
      }
      finish(res, 320);
      return;
    }

    for (const piece of PLAIN_REPLY) {
      writeSse(res, { choices: [{ delta: { content: piece } }] });
    }
    finish(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-model] 监听 http://127.0.0.1:${port}/v1`);
});
