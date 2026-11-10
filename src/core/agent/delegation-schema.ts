/**
 * v16：**委派（子代理）** —— 记录"谁派了谁、干到哪了、结论是什么"。
 *
 * ## ★ 为什么需要一张表，而不是"看 conversation 的 agent_role 就够了"
 *
 * 只有 `agent_role='subagent'` 时，你只知道"这是一个子会话"，但不知道：
 * - **是谁派的**（`parent_conversation_id` 那一列能答一半，但父会话可能派很多个）；
 * - **派它干什么**（任务说明只存在于父会话的 tool_call 参数里，那东西不该被反复解析）；
 * - **现在什么状态**（进程崩了之后子会话停在 `running`，从消息表看不出来）；
 * - **结论是什么**（结论是写回父会话的**一条 tool 消息**，而那只是"交付物"，
 *   不是委派这个动作本身的状态）。
 *
 * ⇒ 委派是一个**独立的事实**，有自己的生命周期。消息表记"说了什么"，这张表记"派了什么"。
 *   这也是 DSH 的做法（`D6@L472`：`tool-subagent` 只返回 child id，**runtime owns result delivery**）。
 *
 * ## ★ 三条判据
 *
 * 1. **一行对应一次委派**，不与子会话一一绑定到"只能有一个"（父会话可以多次派同一个任务）。
 * 2. **状态只能单向推进**：`running → completed|failed|cancelled|interrupted`。
 *    不允许 completed 再变回 running —— 那会让看板显示"已经完成的还在跑"。
 *    （用触发器保证，而不是靠代码自觉。）
 * 3. **结论与错误互斥**：成功有 `result` 没 `error`，失败反之。两个都空 = 还没结束。
 */

export const DELEGATION_SCHEMA_SQL = `
-- ★ 谁派的：让子会话能反查父会话（看板、孤儿清理、审计都要它）。
--   ON DELETE SET NULL 是刻意的：父会话被删掉时子会话**不该跟着消失** ——
--   它还是一条真实的历史，"失去归属"比"被连坐删除"诚实得多。
ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS delegations (
  id                        TEXT PRIMARY KEY,
  parent_conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  child_conversation_id     TEXT NOT NULL,
  task                      TEXT NOT NULL CHECK(length(task) BETWEEN 1 AND 4000),
  title                     TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  status                    TEXT NOT NULL
                              CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
  result                    TEXT,
  error                     TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  finished_at               TEXT,
  CHECK(
    (status = 'running'     AND finished_at IS NULL AND result IS NULL AND error IS NULL) OR
    (status = 'completed'   AND finished_at IS NOT NULL AND result IS NOT NULL AND error IS NULL) OR
    (status IN ('failed','cancelled','interrupted') AND finished_at IS NOT NULL AND error IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_delegations_parent ON delegations(parent_conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_child ON delegations(child_conversation_id);
CREATE INDEX IF NOT EXISTS idx_delegations_running ON delegations(status) WHERE status = 'running';

-- ★ 状态只能单向：终态不许再变。
--   没有这条，一次误写就能让看板永远显示"进行中"，而子代理其实早就完成了。
CREATE TRIGGER IF NOT EXISTS delegations_no_reopen
BEFORE UPDATE OF status ON delegations
WHEN OLD.status <> 'running' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'Delegation status is terminal; cannot change after it finished'); END;

-- ★ 委派记录是不可变的审计事实：不许删。
--   删掉它等于把"谁派过活"这段历史抹了，而父子会话还在库里 —— 那会留下无法解释的孤儿。
CREATE TRIGGER IF NOT EXISTS delegations_no_delete
BEFORE DELETE ON delegations
BEGIN SELECT RAISE(ABORT, 'Delegation records are append-only audit facts; deletion forbidden'); END;
`;
