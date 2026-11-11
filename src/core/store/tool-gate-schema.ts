/**
 * V18：**会话级工具集** + **工具模板**。
 *
 * ## 为什么需要（用户 2026-11-10）
 * 之前只有**全局**一份 `tool_settings`：改一次，所有对话都跟着变。
 * 用户要的是「设置里管全局默认」+「每个对话的输入框下面有个按钮，调这个对话的工具集」。
 * 参考对象是他给 DSH 写的工具门控插件（分组勾选 + 个数/体积/tokens/最近使用 + 模板套用）。
 *
 * ## 两层模型（和 DSH 一致）
 * - **全局默认**：仍是 `tool_settings`（不动它的语义，老库行为完全不变）
 * - **会话覆盖**：`conversation_tool_settings` —— 只存"这个对话和全局不一样"的那些工具
 *
 * 生效规则：`会话值 ?? 全局值 ?? 定义里的 preferredMode`。
 * ★ 只存差异行，不复制整张表：否则全局一改，所有会话都停在旧副本上（那种"改了没反应"最难查）。
 *
 * ## 模板
 * 一张 `tool_templates` 存**一份 mode 映射快照**，可以「套用」到全局或某个会话。
 * `is_default` 只有一行（用部分唯一索引钉住）：默认模板在新建会话时套用。
 */
export const TOOL_GATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_tool_settings (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('resident', 'lazy', 'disabled')),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, name)
);

CREATE INDEX IF NOT EXISTS idx_conversation_tool_settings_conv
  ON conversation_tool_settings (conversation_id);

CREATE TABLE IF NOT EXISTS tool_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  -- 一份 {"工具名":"resident|lazy|disabled"} 的 JSON 快照
  modes      TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 默认模板最多一个：部分唯一索引比"应用层先查再写"可靠（后者在并发下会出两个默认）
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_templates_single_default
  ON tool_templates (is_default) WHERE is_default = 1;
`;
