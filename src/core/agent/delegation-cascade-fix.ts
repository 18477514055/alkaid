/**
 * v19：修 `delegations_no_delete` 与 `ON DELETE CASCADE` 的死锁（2026-11-11 审计 `CRITICAL-02`）。
 *
 * ## 症状（已复现）
 * `delegations.parent_conversation_id` 是 `ON DELETE CASCADE`，而 v16 又加了一条
 * `BEFORE DELETE ON delegations → RAISE(ABORT)`。于是**删父会话**时：
 * 父行删除 → 级联删委派行 → 触发器 ABORT → 整条 DELETE 失败。
 * ⇒ **任何派过子代理的对话都删不掉**（HTTP 面表现为 500）。
 *
 * ## 修法：让触发器区分「有人点名删这一行」和「跟着父会话级联删」
 *
 * SQLite 在级联删除时**父行已经不在表里**了（实测：见 `_probe-cascade.mjs` 的探针结论）。
 * 所以判据写成：**父会话还在 ⇒ 拒删**（保住"委派是不可变审计事实"这条原意）；
 * `父会话已不在 ⇒ 放行`（那是级联，不是有人在抹历史）。
 *
 * ## 为什么不是直接去掉 CASCADE
 * 去掉 CASCADE 只会把错误从"触发器拒绝"变成"外键约束失败"，症状一样、语义更模糊。
 * 用 `ON DELETE SET NULL` 又会让委派行永久悬空、看板查不到父子关系。
 * 真正的意图是"不许**手动**抹历史"，不是"父会话永远不能删"。
 */
export const V19_TOOL_DELEGATION_CASCADE_FIX = `
DROP TRIGGER IF EXISTS delegations_no_delete;

CREATE TRIGGER IF NOT EXISTS delegations_no_delete
BEFORE DELETE ON delegations
WHEN EXISTS (SELECT 1 FROM conversations WHERE id = OLD.parent_conversation_id)
BEGIN SELECT RAISE(ABORT, 'Delegation records are append-only audit facts; deletion forbidden'); END;
`;
