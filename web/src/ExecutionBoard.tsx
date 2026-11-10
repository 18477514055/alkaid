import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type ExecutionBoard as Board, type ExecutionGoal, type ExecutionTask, type UpdateExecutionBoard } from './api.ts';
import { Markdown } from './markdown.tsx';
import './execution-board.css';

/**
 * ★ `projectId` 允许为 `null`：执行看板是**某个主对话的当前工作状态**，
 *   没有绑定项目的对话也该有目标与任务（用户 2026-11-09 的要求）。
 *   那时走会话级入口 `/api/conversations/:id/execution`，服务端用空串哨兵存。
 */
type Props = { projectId: string | null; conversationId: string | null; conversationTitle?: string | null; refreshKey?: number };
type Section = 'goal' | 'tasks' | 'activity';
type GoalDraft = { baseRevision: number; goal: ExecutionGoal; clear: boolean };
type TaskDraft = { baseRevision: number; tasks: ExecutionTask[] };
const GOAL_STATUS: Record<ExecutionGoal['status'], string> = { active: '进行中', paused: '已暂停', completed: '已完成' };
const TASK_STATUS: Record<ExecutionTask['status'], string> = { pending: '待开始', in_progress: '进行中', completed: '已完成' };
const EVENT_KIND: Record<string, string> = { goal: '目标', tasks: '任务', activity: '动态', update: '更新' };
function requestError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 409) return '看板已被其他操作更新（409）。你的输入已保留；请读取最新版本，核对后再决定是否继续保存。';
  if (cause instanceof ApiError && cause.status === 403) return '当前会话不能编辑执行看板；请使用绑定此项目的主对话。';
  if (cause instanceof ApiError && cause.status === 404) return '当前项目或主对话不可用，请重新选择。';
  if (cause instanceof ApiError && cause.status === 400) return '内容未通过校验：目标标题最多 200 字、说明 2000 字，任务最多 50 条且每条 500 字，动态最多 500 字。';
  return '本地执行看板暂时无法读写，请刷新重试；你的编辑输入不会被自动覆盖。';
}

/** 对话 key 是展示边界：同项目切主对话也立即清空旧看板与旧编辑状态。 */
export function ExecutionBoard(props: Props): React.ReactElement {
  if (!props.conversationId) return <section className="execution-board"><p className="hint">选择主对话后查看当前执行目标与任务。</p></section>;
  return <ConversationExecution key={`${props.projectId ?? 'none'}/${props.conversationId}`} {...props} conversationId={props.conversationId} />;
}
function ConversationExecution({ projectId, conversationId, conversationTitle, refreshKey = 0 }: Props & { conversationId: string }): React.ReactElement {
  /**
   * 两个入口、同一份数据：
   * - 有项目 → `/api/projects/:pid/execution/:cid`
   * - 无项目 → `/api/conversations/:cid/execution`（服务端从会话行反查，用空串哨兵存）
   */
  const loadBoard = (signal?: AbortSignal): Promise<Board> =>
    projectId === null
      ? api.getConversationExecution(conversationId, signal)
      : api.getExecutionBoard(projectId, conversationId, signal);
  const saveBoard = (input: UpdateExecutionBoard): Promise<Board> =>
    projectId === null
      ? api.patchConversationExecution(conversationId, input)
      : api.patchExecutionBoard(projectId, conversationId, input);
  /** 归属校验：会话必须对上；有项目时项目也要对上（无项目时服务端回的是空串哨兵，不比） */
  const inScope = (result: Board): boolean =>
    result.conversationId === conversationId && (projectId === null || result.projectId === projectId);
  const [board, setBoard] = useState<Board | null>(null);
  const [goalDraft, setGoalDraft] = useState<GoalDraft | null>(null);
  const [taskDraft, setTaskDraft] = useState<TaskDraft | null>(null);
  const [activity, setActivity] = useState(''); const [activityBase, setActivityBase] = useState<number | null>(null);
  const [busy, setBusy] = useState(false); const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Section | null>(null); const [reviewRevision, setReviewRevision] = useState<number | null>(null);
  const [reload, setReload] = useState(0); const mounted = useRef(false); const writing = useRef(false); const epoch = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); let stopped = false; let fetching = false; let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(): Promise<void> {
      if (stopped || fetching) return;
      if (writing.current) { timer = setTimeout(() => void poll(), 5000); return; }
      fetching = true; const version = epoch.current;
      try {
        const result = await loadBoard(controller.signal);
        if (!stopped && version === epoch.current && !writing.current) {
          if (!inScope(result)) throw new Error('scope mismatch');
          setBoard(result); setLoadError(null);
        }
      } catch (cause) { if (!stopped && version === epoch.current) setLoadError(requestError(cause)); }
      finally { fetching = false; if (!stopped) timer = setTimeout(() => void poll(), 5000); }
    }
    void poll(); return () => { stopped = true; controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [projectId, conversationId, refreshKey, reload]);

  async function save(section: Section, input: UpdateExecutionBoard): Promise<void> {
    if (writing.current || conflict !== null) return;
    writing.current = true; epoch.current++; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await saveBoard(input);
      if (!mounted.current) return;
      setBoard(result); setLoadError(null);
      if (section === 'goal') setGoalDraft(null);
      if (section === 'tasks') setTaskDraft(null);
      if (section === 'activity') { setActivity(''); setActivityBase(null); }
      setNotice(section === 'activity' ? '动态已追加；历史没有被覆写。' : '当前执行看板已保存。');
    } catch (cause) {
      if (mounted.current) {
        setError(requestError(cause));
        if (cause instanceof ApiError && cause.status === 409) { setConflict(section); setReviewRevision(null); }
      }
    } finally { if (mounted.current) { writing.current = false; setBusy(false); setReload((value) => value + 1); } }
  }
  async function readLatest(): Promise<void> {
    if (writing.current) return;
    writing.current = true; epoch.current++; setBusy(true);
    try {
      const result = await loadBoard();
      if (!mounted.current) return;
      if (!inScope(result)) throw new Error('scope mismatch');
      setBoard(result); setLoadError(null); setReviewRevision(result.revision);
      setNotice('最新正式看板已读入；你的输入仍保留在编辑区。请核对后决定继续保存或取消编辑。');
    } catch (cause) { if (mounted.current) setError(requestError(cause)); }
    finally { if (mounted.current) { writing.current = false; setBusy(false); } }
  }
  function rebase(): void {
    if (!board || reviewRevision === null || reviewRevision !== board.revision || !conflict) return;
    if (conflict === 'goal') setGoalDraft((current) => current ? { ...current, baseRevision: board.revision } : null);
    if (conflict === 'tasks') setTaskDraft((current) => current ? { ...current, baseRevision: board.revision } : null);
    if (conflict === 'activity') setActivityBase(board.revision);
    setConflict(null); setReviewRevision(null); setError(null); setNotice('已按你确认的最新版本继续编辑；尚未保存，仍需点击对应保存按钮。');
  }
  function moveTask(index: number, direction: -1 | 1): void {
    setTaskDraft((current) => {
      if (!current || index + direction < 0 || index + direction >= current.tasks.length) return current;
      const tasks = [...current.tasks]; const task = tasks[index]!; tasks[index] = tasks[index + direction]!; tasks[index + direction] = task;
      return { ...current, tasks };
    });
  }
  return <section className="execution-board" aria-label="当前对话执行看板" aria-busy={busy}>
    <header className="execution-head"><div><strong>当前工作</strong><p>{conversationTitle ?? '本项目主对话'}</p></div><button type="button" className="small" disabled={busy} aria-label="刷新执行看板" onClick={() => setReload((value) => value + 1)}>刷新</button></header>
    {loadError && <p className="execution-error" role="alert">{loadError}</p>}{error && <p className="execution-error" role="alert">{error}</p>}{notice && <p className="execution-notice" role="status">{notice}</p>}
    {!board && !loadError && <p className="hint" role="status">读取本对话目标与任务…</p>}
    {conflict && <section className="execution-conflict" aria-label="看板版本冲突处理"><strong>先核对，不自动覆盖</strong><p>输入仍在下方编辑区；当前读到 r{board?.revision ?? '—'}。</p><div className="execution-actions"><button type="button" className="small" disabled={busy} onClick={() => void readLatest()}>读取最新版本（保留输入）</button><button type="button" className="small" disabled={busy || reviewRevision === null || reviewRevision !== board?.revision} onClick={rebase}>已核对，基于最新版本继续编辑</button></div></section>}
    {board && <>
      <section className="execution-section" aria-label="当前执行目标"><div className="execution-section-head"><h3>执行目标</h3><span className="execution-badge">{board.goal ? GOAL_STATUS[board.goal.status] : '尚未设置'}</span><button type="button" className="small" disabled={busy || goalDraft !== null} aria-label="编辑当前执行目标" onClick={() => setGoalDraft({ baseRevision: board.revision, goal: board.goal ? { ...board.goal } : { title: '', status: 'active', summary: '' }, clear: false })}>编辑目标</button></div>
        {board.goal ? <><h4>{board.goal.title}</h4>{board.goal.summary && <Markdown text={board.goal.summary} />}</> : <p className="execution-empty">还没有当前执行目标。可直接编辑，不需要建立长期目标树。</p>}
        {goalDraft && <form className="execution-editor" onSubmit={(event) => { event.preventDefault(); if (!goalDraft.clear && !goalDraft.goal.title.trim()) return; void save('goal', { baseRevision: goalDraft.baseRevision, goal: goalDraft.clear ? null : { ...goalDraft.goal, title: goalDraft.goal.title.trim() } }); }}><fieldset disabled={busy}>
          <label>执行目标标题<input aria-label="执行目标标题" maxLength={200} required={!goalDraft.clear} value={goalDraft.goal.title} disabled={goalDraft.clear} onChange={(event) => setGoalDraft({ ...goalDraft, goal: { ...goalDraft.goal, title: event.target.value } })} /></label>
          <label>目标状态<select aria-label="当前目标状态" value={goalDraft.goal.status} disabled={goalDraft.clear} onChange={(event) => setGoalDraft({ ...goalDraft, goal: { ...goalDraft.goal, status: event.target.value as ExecutionGoal['status'] } })}>{Object.entries(GOAL_STATUS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
          <label>目标说明<textarea aria-label="执行目标说明" rows={3} maxLength={2000} value={goalDraft.goal.summary} disabled={goalDraft.clear} onChange={(event) => setGoalDraft({ ...goalDraft, goal: { ...goalDraft.goal, summary: event.target.value } })} /></label>
          {board.goal && <label className="execution-check"><input type="checkbox" checked={goalDraft.clear} onChange={(event) => setGoalDraft({ ...goalDraft, clear: event.target.checked })} />清除本对话当前执行目标（不影响长期目标树）</label>}
          <div className="execution-actions"><button type="submit" className="small primary" disabled={conflict !== null}>保存执行目标</button><button type="button" className="small" onClick={() => { setGoalDraft(null); if (conflict === 'goal') setConflict(null); }}>取消目标编辑</button></div>
        </fieldset></form>}
      </section>
      <section className="execution-section" aria-label="有序执行任务"><div className="execution-section-head"><h3>任务</h3><span className="execution-meta">{board.tasks.filter((task) => task.status === 'completed').length}/{board.tasks.length} 完成</span><button type="button" className="small" disabled={busy || taskDraft !== null} aria-label="编辑执行任务" onClick={() => setTaskDraft({ baseRevision: board.revision, tasks: board.tasks.map((task) => ({ ...task })) })}>编辑任务</button></div>
        {board.tasks.length === 0 ? <p className="execution-empty">暂无任务。添加有序步骤并手工更新状态。</p> : <ol className="execution-task-list">{board.tasks.map((task) => <li key={task.id} className={`execution-task ${task.status}`}><span className="execution-task-text"><Markdown text={task.content} /></span><b>{TASK_STATUS[task.status]}</b></li>)}</ol>}
        {taskDraft && <form className="execution-editor" onSubmit={(event) => { event.preventDefault(); if (taskDraft.tasks.some((task) => !task.content.trim())) return; void save('tasks', { baseRevision: taskDraft.baseRevision, tasks: taskDraft.tasks.map((task) => ({ ...task, content: task.content.trim() })) }); }}><fieldset disabled={busy}>
          {taskDraft.tasks.map((task, index) => <div className="execution-task-editor" key={task.id}><label>第 {index + 1} 项任务<input aria-label={`任务内容 ${index + 1}`} maxLength={500} required value={task.content} onChange={(event) => setTaskDraft({ ...taskDraft, tasks: taskDraft.tasks.map((item) => item.id === task.id ? { ...item, content: event.target.value } : item) })} /></label>
            <label>状态<select aria-label={`任务状态 ${index + 1}`} value={task.status} onChange={(event) => setTaskDraft({ ...taskDraft, tasks: taskDraft.tasks.map((item) => item.id === task.id ? { ...item, status: event.target.value as ExecutionTask['status'] } : item) })}>{Object.entries(TASK_STATUS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
            <div className="execution-actions"><button type="button" className="small" aria-label={`上移任务 ${index + 1}`} disabled={index === 0} onClick={() => moveTask(index, -1)}>上移</button><button type="button" className="small" aria-label={`下移任务 ${index + 1}`} disabled={index === taskDraft.tasks.length - 1} onClick={() => moveTask(index, 1)}>下移</button><button type="button" className="small" aria-label={`删除任务 ${index + 1}`} onClick={() => setTaskDraft({ ...taskDraft, tasks: taskDraft.tasks.filter((item) => item.id !== task.id) })}>移除</button></div>
          </div>)}
          <button type="button" className="small" disabled={taskDraft.tasks.length >= 50} onClick={() => setTaskDraft({ ...taskDraft, tasks: [...taskDraft.tasks, { id: crypto.randomUUID(), content: '', status: 'pending' }] })}>添加一步任务</button>
          <div className="execution-actions"><button type="submit" className="small primary" disabled={conflict !== null}>保存有序任务</button><button type="button" className="small" onClick={() => { setTaskDraft(null); if (conflict === 'tasks') setConflict(null); }}>取消任务编辑</button></div>
        </fieldset></form>}
      </section>
      <section className="execution-section" aria-label="执行动态"><div className="execution-section-head"><h3>动态</h3><span className="execution-meta">最近 {board.events.length} 条</span></div>
        <form className="execution-activity" onSubmit={(event) => { event.preventDefault(); if (activity.trim()) void save('activity', { baseRevision: activityBase ?? board.revision, activity: activity.trim() }); }}><label>追加动态 / 更正说明<textarea aria-label="追加执行动态" maxLength={500} rows={2} value={activity} disabled={busy} placeholder="追加进展、说明或更正；不会改写已有动态" onChange={(event) => { if (activityBase === null) setActivityBase(board.revision); setActivity(event.target.value); }} /></label><button type="submit" className="small" disabled={busy || !activity.trim() || conflict !== null}>追加动态</button></form>
        {board.events.length === 0 ? <p className="execution-empty">还没有动态。保存目标、任务或追加说明后，会在这里留痕。</p> : <ul className="execution-events">{[...board.events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((event) => <li key={event.id}><div><span>{EVENT_KIND[event.kind] ?? '动态'}</span><time>{new Date(event.createdAt).toLocaleString()}</time></div><div className="execution-event-text"><Markdown text={event.text} /></div></li>)}</ul>}
      </section>
      <p className="execution-meta">本对话工作看板 r{board.revision}{board.updatedAt ? ` · ${new Date(board.updatedAt).toLocaleString()}` : ' · 尚无保存记录'}。与长期目标树、正式记忆审批及后台整理分开。</p>
    </>}
  </section>;
}
