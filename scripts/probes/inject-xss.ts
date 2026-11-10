import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * 往演示库的某个会话里插一条 assistant 消息，正文是**恶意 HTML** ——
 * 用来验证前端的 Markdown 渲染器真的把脚本洗掉了（不是"看起来没事"）。
 */
const db = new DatabaseSync(join(process.cwd(), '.alkaid-demo', 'alkaid.db'));

const target = process.argv[2];
const conversationId =
  target ??
  (db.prepare("SELECT id FROM conversations WHERE title = '对话 8'").get() as { id: string } | undefined)?.id;
if (conversationId === undefined) throw new Error('找不到会话');

const seq = (
  db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?').get(conversationId) as {
    n: number;
  }
).n;

const evil = [
  '## XSS 探针\n\n',
  '下面几段是**恶意 HTML**，渲染后应当只剩文字，脚本与事件不该生效：\n\n',
  '<script>window.__XSS__ = "script 执行了"</script>\n\n',
  '<img src=x onerror="window.__XSS__ = \'img onerror 执行了\'">\n\n',
  '<a href="javascript:window.__XSS__=\'a href 执行了\'">点我</a>\n\n',
  '<iframe src="https://example.com"></iframe>\n\n',
  '正文结束。\n',
].join('');

db.prepare(
  `INSERT INTO messages (id, conversation_id, seq, role, content, reasoning, tool_calls, tool_call_id,
     usage, finish_reason, created_at)
   VALUES (?, ?, ?, 'assistant', ?, NULL, NULL, NULL, ?, 'stop', ?)`,
).run(
  randomUUID(),
  conversationId,
  seq,
  evil,
  JSON.stringify({ input: 100, output: 60, cached: 0 }),
  new Date().toISOString(),
);

console.log(`已插入 seq=${seq} 到会话 ${conversationId}`);
