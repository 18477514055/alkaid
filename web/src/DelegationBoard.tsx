import { useEffect, useState } from 'react';

import { api, ApiError, type DelegationBoard } from './api.ts';
import { DELEGATION_STATUS_LABEL, type DelegationStatus } from '../../src/shared/delegation.ts';
import { Markdown } from './markdown.tsx';
import './delegation-board.css';

/**
 * **委派看板**（用户 2026-11-10 的要求）。
 *
 * > 「这两个功能最好在右侧看板显现出来，我可以用一张看板就同时看到各个子代理当前的
 * >   工作进度，目标和任务。同时还有他们之间的共享任务看板。子代理也是同理的。
 * >   不过子代理似乎就没有共享任务看板这个东西。」
 *
 * ## ★ 这一版只做三件事，刻意不做第四件
 *
 * 1. **一个列表**：每个子代理一行，带状态、任务标题、它自己的目标与任务、消息数。
 * 2. **它自己的执行看板**：折叠展开。子代理在跑的时候会写 `execution_board`，
 *    所以这里显示的不是"猜它大概在干嘛"，而是**它自己登记的目标与任务**。
 * 3. **共享任务板**：只属于这棵树的根（也就是当前主对话）。子代理那一侧不显示 ——
 *    用户说的"子代理似乎没有共享任务看板"是对的，而且**这就是设计**
 *    （见 `shared/delegation.ts` 的 `SUBAGENTS_HAVE_NO_OWN_BOARD`）。
 *
 * 4. **不做**：写操作。看板是投影，写入只走工具（模型）或既有路由（用户）。
 *    让看板可写会造出"两套写入路径"，校验规则迟早分叉。
 *
 * ## ★ 轮询而不是推送
 *
 * 子代理在跑的时候状态会变，但没有事件通道推给它。5 秒轮询是这个规模下最省的：
 * 一次请求拿全（服务端已经拼好），不产生"三个请求各自失败"的组合态。
 * 用户切走会话时立刻停（`AbortController` + cleanup），不会在后台空转。
 */

type Props = {
  conversationId: string | null;
  /** 主对话刷新时带一下，让委派状态尽快跟上 */
  refreshKey?: number;
  /**
   * ★ 点进某个子代理/队友的对话（2026-11-10 用户要求）。
   * 不传就只显示、不可点 —— 这样组件在没有导航能力的地方也能用。
   */
  onOpenConversation?: (conversationId: string) => void;
  /** 切回主对话。看板本身属于主对话，所以这个按钮在展开面板里出现一次就够 */
  onBackToParent?: () => void;
};

const POLL_MS = 5_000;

function statusClass(status: DelegationStatus): string {
  return `delegation-status ${status}`;
}

export function DelegationBoardPanel({ conversationId, refreshKey = 0, onOpenConversation, onBackToParent }: Props): React.ReactElement {
  const [board, setBoard] = useState<DelegationBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (conversationId === null) {
      setBoard(null);
      setError(null);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function poll(): Promise<void> {
      if (stopped) return;
      try {
        const result = await api.getDelegations(conversationId as string, controller.signal);
        if (!stopped) {
          setBoard(result);
          setError(null);
        }
      } catch (cause) {
        if (!stopped) {
          // ★ 读失败不清空已有数据：一次网络抖动不该让看板闪成空白
          setError(cause instanceof ApiError ? cause.message : '委派看板暂时读不到');
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
      }
    }
    void poll();

    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [conversationId, refreshKey]);

  if (conversationId === null) {
    return (
      <section className="panel delegation-panel" aria-label="子代理">
        <div className="panel-title">子代理</div>
        <p className="hint">选择主对话后查看它派出去的子代理。</p>
      </section>
    );
  }

  const entries = board?.entries ?? [];
  const team = board?.team ?? null;

  return (
    <section className="panel delegation-panel" aria-label="子代理">
      <div className="panel-title">
        子代理
        {entries.length > 0 ? <span className="delegation-count">{entries.length}</span> : null}
        <span className="grow" />
        {/*
          ★ 切回主对话（用户 2026-11-10 的第二半要求）。
          为什么放在标题栏而不是每个子代理里：看板**本身就是**主对话的，
          所以"回到主对话"是一个全局动作，不是某一条的属性。

          ★★ 判据修正（真机验出来的）：原来这里还要求 `entries.length > 0`，
          结果是**站在子代理会话里看不到「回主对话」** —— 因为子代理自己没有子代理，
          entries 恒为空。而那正是最需要这个按钮的时刻。现在只看有没有父会话可回。
        */}
        {onBackToParent !== undefined ? (
          <button type="button" className="small" onClick={onBackToParent}>
            ← 回主对话
          </button>
        ) : null}
      </div>

      {error !== null ? <p className="hint delegation-error">{error}</p> : null}

      {entries.length === 0 ? (
        <p className="hint">
          还没有子代理。模型可以用 `delegate` 工具把一件独立、自足的任务整块交出去；
          它会开一个**看不到本对话**的新会话去干，干完把结论交回来。
        </p>
      ) : (
        <ul className="delegation-list">
          {entries.map((entry) => {
            const item = entry.delegation;
            const open = expanded[item.id] === true;
            const goal = entry.execution?.goal ?? null;
            const tasks = entry.execution?.tasks ?? [];
            const done = tasks.filter((task) => task.status === 'completed').length;
            return (
              <li key={item.id} className="delegation-item">
                <button
                  type="button"
                  className="delegation-head"
                  aria-expanded={open}
                  onClick={() => setExpanded((current) => ({ ...current, [item.id]: !open }))}
                >
                  <span className={statusClass(item.status)}>{DELEGATION_STATUS_LABEL[item.status]}</span>
                  <span className="delegation-title">{item.title}</span>
                  {tasks.length > 0 ? (
                    <span className="delegation-progress">
                      {done}/{tasks.length}
                    </span>
                  ) : null}
                </button>

                {open ? (
                  <div className="delegation-body">
                    {/* ★ ⑨ 看板要按 Markdown 渲染：任务描述里经常带 `代码`、列表、路径，纯文本会原样露出星号和反引号 */}
                    <div className="delegation-task"><Markdown text={item.task} /></div>

                    {goal !== null ? (
                      <div className="delegation-goal">
                        <span className="k">目标</span>
                        <span className={`delegation-goal-status ${goal.status}`}>{goal.status}</span>
                        <span className="v">{goal.title}</span>
                        {goal.summary.length > 0 ? <div className="delegation-goal-summary"><Markdown text={goal.summary} /></div> : null}
                      </div>
                    ) : (
                      <p className="hint">它没有登记目标（短任务不必有目标）。</p>
                    )}

                    {tasks.length > 0 ? (
                      <ul className="delegation-tasks">
                        {tasks.map((task) => (
                          <li key={task.id} className={`delegation-task-row ${task.status}`}>
                            <span className="delegation-task-status">
                              {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○'}
                            </span>
                            <span className="delegation-task-text"><Markdown text={task.content} /></span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {item.result !== null ? (
                      <details className="delegation-result">
                        <summary>结论</summary>
                        {/* ★ 子代理的最终答复就是一段 Markdown；用 <pre> 会把它原样摊开 */}
                        <div className="delegation-result-body"><Markdown text={item.result} /></div>
                      </details>
                    ) : null}
                    {item.error !== null ? <p className="hint delegation-error">{item.error}</p> : null}

                    {/*
                      ★ 点开它的完整对话（用户 2026-11-10：「让我在看板点击来查看智能体队友和
                      子代理的对话」）。子代理是一个**真实会话**，所以这里不是"看日志"，
                      是切到那个会话去 —— 消息、工具调用、它自己的看板全都在。
                    */}
                    {onOpenConversation !== undefined ? (
                      <button
                        type="button"
                        className="small delegation-open"
                        onClick={(event) => {
                          // ★ 阻止冒泡：这个按钮在 details 的展开区里，别让外层再切一次
                          event.stopPropagation();
                          onOpenConversation(item.childConversationId);
                        }}
                      >
                        查看它的对话 →
                      </button>
                    ) : null}

                    <p className="hint delegation-meta">
                      {entry.messageCount} 条消息
                      {entry.lastMessageAt !== null ? ` · 最近 ${entry.lastMessageAt.slice(11, 19)}` : ''}
                      {' · '}子会话 <code>{item.childConversationId.slice(0, 8)}</code>
                      {entry.execution !== null && entry.execution.tasks.length > 0
                        ? ` · 任务 ${String(entry.execution.tasks.filter((task) => task.status === 'completed').length)}/${String(entry.execution.tasks.length)}`
                        : ''}
                    </p>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* ★ 共享任务板：只属于这棵树的根。子代理自己没有 —— 那是对的，不是漏做。 */}
      {team !== null && team.tasks.length > 0 ? (
        <div className="delegation-team">
          <div className="panel-title">
            共享任务板
            <span className="delegation-revision">r{team.revision}</span>
          </div>
          <ul className="delegation-team-list">
            {team.tasks.map((task) => (
              <li key={task.id} className={`delegation-team-row ${task.status}`}>
                <span className="delegation-task-status">
                  {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○'}
                </span>
                <span className="delegation-team-subject"><Markdown text={task.subject} /></span>
                <span className="delegation-team-owner">
                  {task.owner === null ? '未认领' : task.ownerKind === 'subagent' ? '子代理' : '主对话'}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">
            {/* ★ 这里原来写成 `**建议**`，在 JSX 里会原样露出星号 —— 正是"没渲染 Markdown"的同类问题 */}
            写作用域重叠只是<strong>建议</strong>，不是锁 —— 该板靠约定协调，不阻止并行写同一处。
          </p>
        </div>
      ) : null}
    </section>
  );
}
