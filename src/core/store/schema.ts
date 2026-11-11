import type { DatabaseSync } from 'node:sqlite';
import { MEMORY_SCHEMA_SQL } from '../memory/schema.ts';
import { MEMORY_RECORDS_SCHEMA_SQL } from '../memory/records-schema.ts';
import { MEMORY_WORKBENCH_SCHEMA_SQL } from '../memory/workbench-schema.ts';
import { MEMORY_CONTEXT_SCHEMA_SQL } from '../memory/context-schema.ts';
import { MEMORY_OBLIGATIONS_SCHEMA_SQL } from '../memory/obligations-schema.ts';
import { COMPACTION_SCHEMA_SQL } from '../context/compaction-schema.ts';
import { TOOL_GATE_SCHEMA_SQL } from './tool-gate-schema.ts';
import { V19_TOOL_DELEGATION_CASCADE_FIX } from '../agent/delegation-cascade-fix.ts';
import { EXECUTION_SCHEMA_SQL } from '../memory/execution-schema.ts';
import { DELEGATION_SCHEMA_SQL } from '../agent/delegation-schema.ts';
import { MEMORY_RHYTHM_SCHEMA_SQL } from '../memory/rhythm.ts';

/**
 * 数据库结构（设计稿 §4）。
 *
 * 设计原则：
 * - **稳定 ID**：主键一律 TEXT（randomUUID），不拿文件名当身份（任务书 §十二.8）。
 * - **seq 单调递增**：`messages.seq` 是会话内永不重排的序号 —— V0.5 的压缩指针
 *   要指向"第几段原文"，现在就把它留对，比以后迁移便宜。
 * - **可空的项目/工作区**：对话必须能独立存在（任务书 §3.2、§3.4）。
 */

/** 迁移顺序即数组顺序；**只追加、不改已发布的 SQL**。 */
type Migration = { readonly version: number; readonly sql: string };

const V1 = `
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  shared_dir   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  root_path    TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ★ 故意不含密钥：密钥只在 ~/.alkaid/secrets.json
CREATE TABLE IF NOT EXISTS providers (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  kind                        TEXT NOT NULL,
  base_url                    TEXT NOT NULL,
  chat_path                   TEXT NOT NULL DEFAULT 'chat/completions',
  models_path                 TEXT NOT NULL DEFAULT 'models',
  default_model               TEXT,
  extra_headers               TEXT,
  thinking_shape              TEXT NOT NULL DEFAULT 'effort_only',
  supports_stream_usage       INTEGER NOT NULL DEFAULT 1,
  uses_max_completion_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT REFERENCES projects(id)   ON DELETE SET NULL,
  title                 TEXT,
  primary_workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  provider_id           TEXT NOT NULL,
  model                 TEXT NOT NULL,
  permission_mode       TEXT NOT NULL DEFAULT 'workspace',
  state                 TEXT NOT NULL DEFAULT 'idle',
  last_seq              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- 任务书 §3.2「应预留对话关联多个工作区」：join 表就够，UI 只用主工作区
CREATE TABLE IF NOT EXISTS conversation_workspaces (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id)    ON DELETE CASCADE,
  is_primary       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT,
  reasoning       TEXT,
  tool_calls      TEXT,
  tool_call_id    TEXT,
  usage           TEXT,
  finish_reason   TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS plugins (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  entry_path   TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_status  TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 审计：每一步一行。★ 默认不记 prompt 正文（设计稿 §14 / D8 §2.5）
CREATE TABLE IF NOT EXISTS step_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  TEXT NOT NULL,
  step_no          INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  payload          TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_project   ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv_seq       ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_step_events_conv        ON step_events(conversation_id, step_no);
`;

/**
 * v2：压缩记录。
 *
 * ★ 三件事必须一起记：**摘要 + seq 区间 + 模型**。
 *   只记摘要不记区间，就没法回读原文（等于不可逆丢弃，D3 反复强调的那条）。
 * ★ 原文**永远不删** —— 这张表只记录"哪一段被摘要替代了"，消息表一个字都不动。
 */
const V2 = `
CREATE TABLE IF NOT EXISTS compactions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_seq        INTEGER NOT NULL,
  to_seq          INTEGER NOT NULL,
  summary         TEXT NOT NULL,
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compactions_conv ON compactions(conversation_id, from_seq, to_seq);
`;

/**
 * V3：给模型连接加「上下文窗口」。
 *
 * ★ 为什么要加：底部状态栏要显示「上下文水位」（已用 / 窗口），
 *   而窗口大小是**厂商模型的属性**，不是会话的 —— 它挂在 provider 上最合理。
 * ★ 默认 128000 是"不知道时的保守值"：小于真实窗口只会更早提醒压缩，不会溢出。
 *   用户可在 `PATCH /api/providers/:id` 改。
 */
const V3 = `
ALTER TABLE providers ADD COLUMN context_window INTEGER NOT NULL DEFAULT 128000;
`;

/**
 * v4：按对话固定的会话头（头名存这里，值在请求时用 conversationId 填）。
 * 有的网关不带它就 400：OpenCode / OpenCode Go 要 `x-opencode-session`。
 */
const V4 = `
ALTER TABLE providers ADD COLUMN session_header TEXT;
`;

/**
 * v5：会话级用户自定义指令。
 * ★ 存"用户自己写的要求"，注入 system 提示的独立段；不改任何内置规则。
 */
const V5 = `
ALTER TABLE conversations ADD COLUMN instructions TEXT;
`;

/**
 * v6：工具三态配置（用户可以把任意工具设为 常驻 / 按需 / 关闭）。
 *
 * ## ★★★ 为什么必须是**表**，不是 settings 里的一个 JSON 串
 *
 * 参照项目的做法是 DataStore 里存 `name:1/2/0` 的串。我们这个项目已经有 SQL 库，
 * 存表有三个直接好处：
 * 1. **改一个工具只写一行**，不会因为整串重写而把并发写的另一个工具覆盖掉；
 * 2. 可以查"哪些工具 30 天没被用过"（将来做降级建议要用 `last_used_at`）；
 * 3. 迁移/诊断直接 `SELECT`，不用写解析器。
 *
 * ## ★★ `mode` 存**字符串**而不是数字
 * 数字（1/2/0）省几个字节，但"2 是什么"这件事只能靠注释传下去 ——
 * 而注释会在下一次重构时丢掉。字符串自解释，且 CHECK 约束能挡住非法值。
 *
 * ## ★ `source` 冗余存一份
 * 工具从注册表**消失**之后（插件被卸载），这一行仍要保留 ——
 * 否则用户"关掉过某个插件工具"这件事会被静默遗忘，插件重新装回来时行为莫名改变。
 * 冗余的 source 让设置页在工具不在时仍能显示"它原本属于哪个插件"。
 */
const V6 = `
CREATE TABLE IF NOT EXISTS tool_settings (
  name         TEXT PRIMARY KEY,
  mode         TEXT NOT NULL CHECK (mode IN ('resident', 'lazy', 'disabled')),
  source       TEXT NOT NULL DEFAULT 'builtin',
  -- 用户最后一次改它的时刻（审计用；不是工具的调用时间）
  updated_at   TEXT NOT NULL,
  -- 工具最后一次被真正执行的时刻与次数（做"建议改为按需"要用）
  last_used_at TEXT,
  use_count    INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * V9：会话的「置顶 / 归档 / 思考强度」三件事，一次加完。
 *
 * ★ 为什么这三个一起加：都是**会话级偏好**，都是「用户体验上缺了别扭」的东西，
 *   而且都不影响任何既有语义（默认值让老库行为完全不变）。
 * - `pinned_at`：非空 = 置顶。用**时刻**而不是布尔 —— 多个置顶之间按什么排序就自然有了，
 *   取消置顶只需置 NULL，删除别人置顶顺序不受影响。
 * - `archived_at`：非空 = 已归档。同样用时刻，`NULL` = 未归档。
 *   ★ 归档是**软删**：消息、审计、压缩档案全留着，只是默认不出现在侧栏主列表。
 * - `thinking_effort`：思考强度。`NULL` = 用 provider/模型默认（不猜测、不硬塞）。
 */
const V9 = `
ALTER TABLE conversations ADD COLUMN pinned_at TEXT;
ALTER TABLE conversations ADD COLUMN archived_at TEXT;
ALTER TABLE conversations ADD COLUMN thinking_effort TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_pinned ON conversations(pinned_at);
`;

/**
 * V10：连接的「对话里可选的模型」白名单。
 *
 * ★ 为什么需要它：`GET /models` 返回的是**网关那边的全部模型目录**
 *   （OpenCode 一个订阅能列出几十个），但用户在设置里明明只挑了 deepseek 一个。
 *   模型选择器直接读目录 ⇒ 界面上冒出一堆"我根本没配过的模型"。
 *
 * ★ 语义（NULL 与空数组要区分开）：
 *   - `NULL`     = 还没设过 ⇒ **回退到 `default_model` 那一个**（最保守、最符合"我只配了一个"）
 *   - `[]`（空）= 用户显式清空 ⇒ 也是一个都不给，让他去设置里挑
 *   - 有值      = 只允许这几个
 */
const V10 = `
ALTER TABLE providers ADD COLUMN enabled_models TEXT;
`;

/**
 * V13 —— 三件东西，都是这一轮用户明确要求的：
 *
 * 1. **`app_settings`**：把界面设置从 `localStorage` 搬到服务端。
 *    ★ 真因（2026-11-09 用户报「每次更新设置就没了」）：桌面壳**每次启动挑随机端口**，
 *      于是前端 origin 每次都变，而 `localStorage` 是按 origin 隔离的 ⇒ 设置每次重启就归零。
 *      跟"更新"无关，是**每次启动都丢**。放服务端后，家目录稳定 ⇒ 设置跟着家走。
 *    - `scope`：`global`（通用 / 无项目对话的右栏默认）或 `project`（某项目的右栏设置）。
 *    - `scope_id`：全局用空串，项目用项目 id。**不用 NULL**：SQLite 的 `NULL` 在唯一约束里
 *      彼此不算相等，会让同一把键能插无数行。
 *    - `value` 存 JSON 文本，键与形状由 `shared/settings.ts` 统一定义与校验。
 *
 * 2. **`pinned_at`**：工作区与项目的置顶。与会话一致，**存时刻不存布尔** ——
 *    取消就是 NULL，多个置顶之间天然能按时间排序。
 *
 * 3. **`mcp_servers`**：MCP 服务器配置。之前 `ToolSource` 里早有 `'mcp'`，
 *    但只是类型占位与 UI 分组名，**没有任何真正的连接能力**；这张表让它落地。
 *    - `transport`：`stdio`（子进程）或 `http`（streamable-http）。
 *    - `group_mode`：**按整组**设默认模式，避免几十个工具逐个点。
 *      单个工具仍可用既有的 `tool_settings` 覆盖。
 *    - `args` / `env` / `headers` 存 JSON 文本。
 */
const V13 = `
CREATE TABLE IF NOT EXISTS app_settings (
  scope      TEXT NOT NULL CHECK(scope IN ('global','project')),
  scope_id   TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL CHECK(json_valid(value)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, scope_id, key)
);

ALTER TABLE workspaces ADD COLUMN pinned_at TEXT;
ALTER TABLE projects ADD COLUMN pinned_at TEXT;

CREATE TABLE IF NOT EXISTS mcp_servers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  transport   TEXT NOT NULL CHECK(transport IN ('stdio','http')),
  command     TEXT,
  args        TEXT,
  env         TEXT,
  cwd         TEXT,
  url         TEXT,
  headers     TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  group_mode  TEXT NOT NULL DEFAULT 'lazy' CHECK(group_mode IN ('resident','lazy','disabled')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK(
    (transport='stdio' AND command IS NOT NULL AND length(trim(command))>0) OR
    (transport='http'  AND url IS NOT NULL AND length(trim(url))>0)
  )
);
`;

/**
 * v14：**steering 通道**（A3 / `D1@L638`）。
 *
 * ★ 为什么需要一张表，而不是直接 `appendMessage(role='user')`：
 *   那样会**往库里塞一条假用户消息**。而本项目的核心承诺之一是"库里的原文逐字不变"
 *   （证据胶囊 / `recall` / 审计三处都依赖它）。一条 AI 自己写的"用户消息"进库之后，
 *   recall 会把它当成用户真的说过的话，导出的 transcript 也会带上它 ——
 *   `D1@L637`（A2）把这条明确列为**反模式**。
 *
 * ★ 所以：待注入内容单独一张表，**注入是"临时拼进请求"，不是"写进历史"**。
 *   请求里它带 `source` 标记，模型能看出这是系统提醒而不是用户发言。
 *
 * 列语义：
 * - `source`      —— 谁产生的。`user` = 真人；`repeat-tool-reminder` / `time-context` 等 = 系统。
 *                  **判据：只有 source='user' 的内容才允许被当成用户发言呈现。**
 * - `consumed_at` —— 被哪一步领取过。NULL = 还没用过。
 *                  ★ **一条只能领一次**：否则每步重复注入同一句提醒，比不提醒更糟
 *                    （模型会把重复当强调，然后做出过激举动）。
 */
const STEERING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pending_inputs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  source          TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_step   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_inputs_conv
  ON pending_inputs(conversation_id, created_at);
`;

/**
 * v16：**Agent Team 共享任务板**。
 *
 * ★ 版本号是 16 不是 15：v15 已被委派（子代理）的 `delegations` 占用，
 *   而 `test/unit/schema.test.ts` 断言 `COUNT(*) FROM schema_migrations === SCHEMA_VERSION`
 *   ⇒ **跳号会让那条测试变红**（报 `actual: 15, expected: 16`，看着完全不像版本号问题）。
 *   迁移版本必须**连续**。
 *
 * ★ `conversations.parent_conversation_id` 在 v15 里已经加过了（委派功能要用），
 *   **这里不能再 ALTER 一次** —— 重复加列会直接报错，整个迁移步骤回滚。
 *
 * ## ★ 为什么板的主键是 `root_conversation_id`，而不是 `project_id`
 *
 * 执行看板（v12）挂在项目上，因为它回答的是"这个项目的当前目标"。
 * Team 板回答的是另一件事：**主对话派出去的一摊活，谁认领了哪一张**。
 * 这个"谁"是主对话本身 —— 一个项目里可以同时有十块互不相干的板，
 * 一个没有项目的对话同样可以有一块（所以这里**不用**外键、不做项目校验）。
 *
 * ## ★★ 为什么 `owner` 存**会话 id**
 *
 * 认领必须可判定："这张卡现在是不是我的"。判据只有会话身份靠得住 ——
 * 模型名、代理名都能被人为改动，会话 id 是运行时分派的、不可自选。
 * 于是 `claim` 的原子性有了唯一正确的实现：`UPDATE ... WHERE owner IS NULL`。
 *
 * ## ★★★ 为什么 `write_scopes` 与 `blocked_by` 的语义**完全不同**
 *
 * - `blocked_by` 是**真依赖**：不满足就**认领不了**（有测试钉住）。
 * - `write_scopes` 是**建议**：重叠**只警告不拒绝**（DSH 原话
 *   "Write-scope overlap is advisory, not a lock"）。
 *   两者都存 JSON 数组，但一个是闸门一个是备注 —— 别因为长得像就当成同一种东西。
 *   真锁会让两个代理在共享文件上互相等待、活直接卡死；而记账价值并不依赖锁。
 *
 * ## ★ 为什么要 `BEFORE UPDATE/DELETE` 触发器（照 `execution_events` 一模一样的意图）
 *
 * "谁做了什么有据可查"这句话的全部价值在于**过去不可篡改**。
 * 触发器挡的是"事后悄悄抹掉一条认领记录"这件事 —— 那不是备份问题，
 * 而是把证据链变成故事。`no_replace` 那条额外挡 `INSERT OR REPLACE`：
 * SQLite 的 REPLACE 是先 DELETE 再 INSERT，`recursive_triggers=OFF` 时
 * 只靠 UPDATE/DELETE 触发器**挡不住**（本项目在 execution_events 上实测过）。
 *
 * ## ★ 板为什么不用外键指向 `conversations`
 *
 * 卡是有价值的记账，不该因为某个会话被删就跟着消失。`root_conversation_id` /
 * `owner` 都是**逻辑引用**：会话没了那张卡还在，只是再也认领不到（没人能扮演那个 id）。
 * 这和 `execution_boards` 的做法一致（它也不加外键）。
 */
const TEAM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS team_boards (
  root_conversation_id TEXT PRIMARY KEY,
  revision             INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_tasks (
  id                    TEXT PRIMARY KEY,
  root_conversation_id  TEXT NOT NULL,
  subject               TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
  description           TEXT NOT NULL DEFAULT '' CHECK(length(description)<=2000),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
  owner                 TEXT,
  revision              INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  blocked_by            TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(blocked_by)),
  write_scopes          TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(write_scopes)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- owner 要么没有，要么是一个真实存在的会话 id（不设外键：板不该因为会话被删而丢卡）
  CHECK(owner IS NULL OR length(owner) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS team_task_board_created ON team_tasks(root_conversation_id, created_at);
CREATE INDEX IF NOT EXISTS team_task_board_status  ON team_tasks(root_conversation_id, status, created_at);
CREATE INDEX IF NOT EXISTS team_task_board_owner   ON team_tasks(root_conversation_id, owner);

CREATE TABLE IF NOT EXISTS team_task_events (
  id                   TEXT PRIMARY KEY,
  root_conversation_id TEXT NOT NULL,
  task_id              TEXT NOT NULL,
  revision             INTEGER NOT NULL CHECK(revision>=0),
  actor                TEXT NOT NULL CHECK(actor IN ('model','user')),
  kind                 TEXT NOT NULL CHECK(kind IN ('created','claimed','updated','completed')),
  text                 TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 500),
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_task_event_board ON team_task_events(root_conversation_id, created_at);
CREATE INDEX IF NOT EXISTS team_task_event_task  ON team_task_events(root_conversation_id, task_id, revision);
CREATE TRIGGER IF NOT EXISTS team_task_events_no_update BEFORE UPDATE ON team_task_events
BEGIN SELECT RAISE(ABORT, 'Team task history is append-only; updates forbidden'); END;
CREATE TRIGGER IF NOT EXISTS team_task_events_no_delete BEFORE DELETE ON team_task_events
BEGIN SELECT RAISE(ABORT, 'Team task history is append-only; deletion forbidden'); END;
CREATE TRIGGER IF NOT EXISTS team_task_events_no_replace BEFORE INSERT ON team_task_events
WHEN EXISTS(SELECT 1 FROM team_task_events WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'Team task history is append-only; replacement forbidden'); END;
`;

/** Business tables (tests assert none of them is missing) */
const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 },
  { version: 5, sql: V5 },
  { version: 6, sql: V6 },
  { version: 7, sql: `ALTER TABLE messages ADD COLUMN display_channel TEXT NOT NULL DEFAULT 'chat' CHECK (display_channel IN ('chat','maintenance'));\n${MEMORY_SCHEMA_SQL}` },
  { version: 8, sql: `${MEMORY_RECORDS_SCHEMA_SQL}\n${MEMORY_WORKBENCH_SCHEMA_SQL}\n${MEMORY_CONTEXT_SCHEMA_SQL}` },
  { version: 9, sql: V9 },
  { version: 10, sql: V10 },
  { version: 11, sql: MEMORY_OBLIGATIONS_SCHEMA_SQL },
  { version: 12, sql: `ALTER TABLE conversations ADD COLUMN agent_role TEXT NOT NULL DEFAULT 'main' CHECK(agent_role IN ('main','subagent'));\n${EXECUTION_SCHEMA_SQL}\n${MEMORY_RHYTHM_SCHEMA_SQL}` },
  { version: 13, sql: V13 },
  { version: 14, sql: STEERING_SCHEMA_SQL },
  { version: 15, sql: DELEGATION_SCHEMA_SQL },
  { version: 16, sql: TEAM_SCHEMA_SQL },
  { version: 17, sql: COMPACTION_SCHEMA_SQL },
  { version: 18, sql: TOOL_GATE_SCHEMA_SQL },
  { version: 19, sql: V19_TOOL_DELEGATION_CASCADE_FIX },
];

/**
 * ★★ 当前库结构版本 —— **从迁移清单推导，不再手写**。
 *
 * 为什么改：这个常量原本是手写的（`= 13` / `= 14`），而每次加迁移都要记得同步改它。
 * 漏改的后果是**静默的**：`migrate()` 照样升到最新、`currentVersion()` 也对，
 * 但 `SCHEMA_VERSION` 会给出一个**和真实库不一样的数**（2026-11-10 真发生：
 * 库里已经是 16，常量还写 14，三条 schema 测试一起红）。
 * ⇒ 只留**一个真源**：迁移清单的最后一项。加迁移时不可能忘记同步。
 *
 * ★ 必须声明在 `MIGRATIONS` **之后**（`const` 有暂时性死区，提前读会直接抛）。
 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** 业务表清单（测试用它断言"一张都没少"） */
export const BUSINESS_TABLES: readonly string[] = [
  'projects',
  'workspaces',
  'providers',
  'conversations',
  'conversation_workspaces',
  'messages',
  'plugins',
  'step_events',
  'tool_settings',
  'memory_projects',
  'memory_records',
  'memory_proposals',
  'memory_jobs',
  'memory_history',
  'memory_events',
  'memory_preserved', 'memory_preserved_merges', 'memory_preserved_resolutions', 'memory_note_documents',
  'memory_workbench_artifacts', 'memory_triage_entries', 'memory_triage_releases', 'memory_handoffs', 'memory_intents',
  'memory_extension_definitions', 'memory_extension_entries', 'memory_principle_proposals', 'memory_principle_audit',
  'memory_read_receipts', 'memory_file_touches', 'memory_capsules', 'memory_waterlines', 'memory_turn_debts',
  'memory_checkpoints', 'memory_checkpoint_events',
  'memory_obligations', 'memory_obligation_events', 'memory_obligation_evidence',
  'memory_obligation_repairs', 'memory_obligation_explanations', 'memory_obligation_legacy_resolutions',
  'execution_boards', 'execution_events', 'memory_policies', 'memory_rhythm_checkpoints',
  'app_settings', 'mcp_servers', 'pending_inputs', 'delegations',
  // ★ Agent Team 板（v16）。放进这个数组是为了让"一张都没少"那条测试真的覆盖到它们 ——
  //   不进来的表，建漏了也没人知道。
  'team_boards', 'team_tasks', 'team_task_events',
  'compaction_attempts', 'compaction_events', 'compaction_metadata',
  // ★ 工具门控（v18）：会话级工具集 + 工具模板
  'conversation_tool_settings', 'tool_templates',
];

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

/** 当前库结构版本；库还没建时返回 0。 */
export function currentVersion(db: DatabaseSync): number {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (exists === undefined) return 0;

  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as
    | { v: number | bigint }
    | undefined;
  return row === undefined ? 0 : Number(row.v);
}

/**
 * 把库升到最新版本。幂等 —— 再跑一次不会重复建表。
 * 每一步单独一个事务：中途失败就整步回滚，不会留下半张表。
 */
export function migrate(db: DatabaseSync): number {
  db.exec(MIGRATIONS_TABLE);

  let version = currentVersion(db);
  for (const step of MIGRATIONS) {
    if (step.version <= version) continue;

    db.exec('BEGIN');
    try {
      db.exec(step.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        step.version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    version = step.version;
  }
  return version;
}
