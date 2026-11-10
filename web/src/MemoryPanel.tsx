import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  api, ApiError,
  type ConversationDto, type MaintainerConfig, type MemoryKind,
  type MemoryProposal, type MemoryRecord, type MemoryView, type ProviderDto,
} from './api.ts';
import { Markdown } from './markdown.tsx';
import { MemoryWorkbench, MemoryRecordBody, MemoryRecordEditor } from './MemoryWorkbench.tsx';
import { ExecutionBoard } from './ExecutionBoard.tsx';
import { DelegationBoardPanel } from './DelegationBoard.tsx';
import type { PanelTab } from '../../src/shared/settings.ts';
import { memoryDiagnosticLabel, isMemoryDiagnosticCode } from '../../src/shared/memory-diagnostics.ts';

type Props = {
  projectId: string | null;
  conversationId?: string | null;
  projectName?: string;
  providers: ProviderDto[];
  conversations?: ConversationDto[];
  refreshKey?: number;
  /** 右栏设置：显示哪些页签、默认停在哪个（来自 `app_settings`） */
  visibleTabs?: readonly PanelTab[];
  defaultTab?: PanelTab;
  /** ★ 从委派看板点进子代理对话 / 切回主对话（2026-11-10）。不传 = 不可点。 */
  onOpenConversation?: (conversationId: string) => void;
  onBackToParent?: () => void;
};
type Draft = {
  enabled: boolean; providerId: string; model: string;
  quietSeconds: string; maxInputChars: string; maxOutputTokens: string;
  /** 维护模型自己的思考强度；空串 = 交给模型默认 */
  thinkingEffort: string;
  /** 对话结束后自动批准**非冲突**的台账提案（原则永不自动批准） */
  autoApproveOnTurnEnd: boolean;
};
const KIND: Record<MemoryKind, string> = {
  active: '当前状态', decision: '决策', goal: '目标', lesson: '经验教训', principle: '原则', note: '笔记',
};
const STATUS: Record<string, string> = {
  pending: '待审', applied: '已应用', rejected: '已拒绝', conflict: '冲突',
  running: '维护中', failed: '失败', deferred: '暂缓',
};
function configDraft(config: MaintainerConfig): Draft {
  return {
    enabled: config.enabled, providerId: config.providerId ?? '', model: config.model ?? '',
    quietSeconds: String(config.quietMs / 1000),
    maxInputChars: String(config.maxInputChars), maxOutputTokens: String(config.maxOutputTokens),
    thinkingEffort: config.thinkingEffort ?? '',
    /** ★ 缺字段按 false 处理：老库没有这一列时不能默认打开"自动批准" */
    autoApproveOnTurnEnd: config.autoApproveOnTurnEnd === true,
  };
}
function errorText(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 409) return `冲突（409）：${cause.message}。请刷新并重新核对正式版本。`;
  return cause instanceof Error ? cause.message : String(cause);
}
function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function sourceName(id: string, conversations: ConversationDto[]): string {
  const title = conversations.find((item) => item.id === id)?.title;
  return title ? `${title} · ${id}` : id;
}

/** 基线合同不含历史快照，before 明确使用当前正式版本，不伪造 baseRev 的内容。 */
function ProposalDiff({ before, after, deleting }: { before: string; after: string; deleting: boolean }): React.ReactElement {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  return (
    <div className="memory-diff" aria-label="提案 before after 差异">
      <div><div className="memory-meta">before · 当前正式内容（不是基线快照）</div>
        <pre>{before.length === 0 ? '（无正式内容）' : oldLines.map((line, index) => (
          <span key={index} className={index >= prefix && index < oldLines.length - suffix ? 'memory-diff-remove' : ''}>{index >= prefix && index < oldLines.length - suffix ? '− ' : '  '}{line || ' '}</span>
        ))}</pre>
      </div>
      <div><div className="memory-meta">after · 提案内容</div>
        <pre>{after.length === 0 ? (deleting ? '（删除记录）' : '（空内容）') : newLines.map((line, index) => (
          <span key={index} className={index >= prefix && index < newLines.length - suffix ? 'memory-diff-add' : ''}>{index >= prefix && index < newLines.length - suffix ? '+ ' : '  '}{line || ' '}</span>
        ))}</pre>
      </div>
    </div>
  );
}

function ProposalCard(props: {
  proposal: MemoryProposal; record: MemoryRecord | undefined; conversations: ConversationDto[];
  busy: boolean; onResolve: (id: string, accept: boolean) => void;
  /**
   * ② 改**自己**的暂存文本（不传 = 不可编辑）。
   * ★ 判据在服务端：只允许改本人 pending 提案的 title/content，baseRevision 不动。
   */
  onEditText?: (proposal: MemoryProposal, patch: { title?: string; content?: string }) => Promise<void>;
}): React.ReactElement {
  const { proposal, record } = props;
  const actionable = proposal.status === 'pending' || proposal.status === 'conflict';
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(proposal.title);
  const [content, setContent] = useState(proposal.content);
  const canEdit = props.onEditText !== undefined && proposal.status === 'pending';
  return (
    <details className="memory-card" open={proposal.status === 'conflict'}>
      <summary aria-label={`提案 ${proposal.title}`}>
        <span className={`memory-badge ${proposal.status}`}>{STATUS[proposal.status]}</span>{' '}
        {proposal.title} <span className="memory-meta">{KIND[proposal.kind]} · {proposal.operation === 'delete' ? '删除' : '写入'}</span>
      </summary>
      <div className="memory-card-body">
        <div className="memory-meta">记录 {proposal.recordId} · baseRev {proposal.baseRevision} / current {record?.revision ?? 0}</div>
        <div className="memory-meta">来源：{sourceName(proposal.conversationId, props.conversations)}</div>
        <div className="memory-meta">提交：{timestamp(proposal.createdAt)}</div>
        <div className="memory-reason"><strong>理由</strong><Markdown text={proposal.reason || '（未提供）'} /></div>
        {/*
          ② 编辑本人暂存文本：**不经过审批**，改完仍是 pending。
          ★ 编辑态里不显示 diff（diff 是"当前正式版 → 提案"的对比，边改边看会误导），
            只在下面给原文供参照。
        */}
        {editing ? (
          <div className="memory-edit">
            <label>
              标题
              <input aria-label="提案标题" value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              正文
              <textarea aria-label="提案正文" rows={8} value={content} onChange={(event) => setContent(event.target.value)} />
            </label>
            <p className="hint">只能改文本。提交时不会改动 baseRev，也不会改变提案的性质与目标记录。</p>
            <div className="memory-actions">
              <button
                type="button"
                className="small"
                disabled={props.busy}
                onClick={() => {
                  void props.onEditText?.(proposal, { title, content }).then(() => setEditing(false));
                }}
              >
                保存文本
              </button>
              <button
                type="button"
                className="small"
                disabled={props.busy}
                onClick={() => {
                  setTitle(proposal.title);
                  setContent(proposal.content);
                  setEditing(false);
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <ProposalDiff before={record?.deleted ? '' : (record?.content ?? '')} after={proposal.operation === 'delete' ? '' : proposal.content} deleting={proposal.operation === 'delete'} />
        )}
        {proposal.status === 'conflict' && <p className="memory-warning">冲突提案不能直接覆盖正式版。请重新读取当前版本、核对后提交新提案，或在此拒绝旧提案。</p>}
        {actionable && <div className="memory-actions">
          <button type="button" className="small" aria-label={`接受提案 ${proposal.id}`} disabled={props.busy || proposal.status === 'conflict'}
            onClick={() => props.onResolve(proposal.id, true)}>{proposal.status === 'conflict' ? '需重新提案' : '接受'}</button>
          <button type="button" className="small" aria-label={`拒绝提案 ${proposal.id}`} disabled={props.busy}
            onClick={() => props.onResolve(proposal.id, false)}>拒绝</button>
          {canEdit && !editing && <button type="button" className="small" aria-label={`编辑提案文本 ${proposal.id}`}
            disabled={props.busy} onClick={() => setEditing(true)}>编辑文本</button>}
        </div>}
        {proposal.resolvedAt && <div className="memory-meta">处理：{timestamp(proposal.resolvedAt)}</div>}
      </div>
    </details>
  );
}

/** key 使切项目的首帧就卸掉旧数据；所有读写结果另有 cleanup 防止异步回写。 */
export function MemoryPanel(props: Props): React.ReactElement {
  /**
   * ★ 没有绑定项目的对话（2026-11-09 用户要求）：
   *   右侧只显示**不需要项目**也能用的东西，而不是一句"绑定项目后使用记忆"。
   *   执行看板本来就属于「某个主对话的当前工作状态」，与项目无关 ⇒ 用会话级入口照常可用。
   *   台账 / 原则是项目域的数据，没有项目就没有它们 —— 不假装存在。
   */
  if (props.projectId === null) {
    const canShowWork = (props.visibleTabs ?? ['work']).includes('work');
    return (
      <section className="panel memory-panel" aria-label="会话工作">
        <div className="panel-title">当前工作</div>
        {canShowWork ? (
          <>
            <ExecutionBoard
              projectId={null}
              conversationId={props.conversationId ?? null}
              refreshKey={props.refreshKey ?? 0}
            />
            {/*
              ★ 委派看板在**没有项目的对话**里同样要有（用户 2026-11-10：一张看板看到子代理）。
              子代理与项目无关 —— 它属于"这个主对话派出去的活"。
              没有它的话，用户在独立对话里派了子代理却看不到它干到哪了。
            */}
            <DelegationBoardPanel
              conversationId={props.conversationId ?? null}
              refreshKey={props.refreshKey ?? 0}
              {...(props.onOpenConversation === undefined ? {} : { onOpenConversation: props.onOpenConversation })}
              {...(props.onBackToParent === undefined ? {} : { onBackToParent: props.onBackToParent })}
            />
          </>
        ) : (
          <p className="hint">你在这里关闭了「工作」页；可在「设置 → 项目/右栏」重新打开。</p>
        )}
        <p className="hint">台账与原则是项目域的数据：给对话绑定项目后才会出现。</p>
      </section>
    );
  }
  return (
    <ProjectMemory
      key={`${props.projectId}/${props.conversationId ?? ''}`}
      {...props}
      projectId={props.projectId}
    />
  );
}

function ProjectMemory({ projectId, conversationId = null, projectName, providers, conversations = [], refreshKey = 0, visibleTabs, defaultTab, onOpenConversation, onBackToParent }: Props & { projectId: string }): React.ReactElement {
  const [view, setView] = useState<MemoryView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<'records' | 'proposals' | 'jobs'>('records');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const alive = useRef(false);
  const actionBusy = useRef(false);
  const readEpoch = useRef(0);
  const modelRequest = useRef(0);
  const modelListId = useId();

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; modelRequest.current++; };
  }, []);

  useEffect(() => {
    let stopped = false;
    let fetching = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(): Promise<void> {
      if (stopped || fetching) return;
      if (actionBusy.current) { timer = setTimeout(() => void poll(), 3000); return; }
      fetching = true;
      const epoch = readEpoch.current;
      try {
        const result = await api.getMemory(projectId, controller.signal);
        if (!stopped && !actionBusy.current && epoch === readEpoch.current) {
          if (result.projectId !== projectId) throw new Error('记忆响应的项目不匹配，已忽略');
          setView(result);
          setDraft((current) => current ?? configDraft(result.config));
          setLoadError(null);
        }
      } catch (cause) {
        if (!stopped) setLoadError(errorText(cause));
      } finally {
        fetching = false;
        if (!stopped) timer = setTimeout(() => void poll(), 3000);
      }
    }
    void poll();
    return () => { stopped = true; controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [projectId, refreshKey, reload]);

  const pending = view?.proposals.filter((item) => item.status === 'pending' || item.status === 'conflict') ?? [];
  const records = view?.records.filter((item) => !item.deleted && !item.id.startsWith('artifact:')) ?? [];
  const pendingSources = new Set(view?.proposals.filter((item) => item.status === 'pending').map((item) => item.conversationId));
  const projectConversations = conversations.filter((item) => item.projectId === projectId);
  const projectIdle = projectConversations.length >= 2 && projectConversations.every((item) => item.state === 'idle');
  const configDirty = draft !== null && view !== null && JSON.stringify(draft) !== JSON.stringify(configDraft(view.config));
  const running = view?.jobs.some((job) => job.state === 'running') ?? false;
  const canRetry = view !== null && view.config.enabled && view.config.providerId !== null &&
    !!view.config.model && pendingSources.size >= 2 && projectIdle && !running && loadError === null;
  const modelOptions = useMemo(() => [...new Set([
    providers.find((item) => item.id === draft?.providerId)?.defaultModel,
    ...conversations.filter((item) => item.providerId === draft?.providerId).map((item) => item.model),
    ...models,
  ].filter((model): model is string => typeof model === 'string' && model.length > 0))], [providers, draft?.providerId, conversations, models]);

  async function action(work: () => Promise<unknown>, success: string): Promise<void> {
    if (actionBusy.current) return;
    actionBusy.current = true; readEpoch.current++; setBusy(true); setActionError(null); setNotice(null);
    try {
      await work();
      if (alive.current) setNotice(success);
    } catch (cause) {
      if (alive.current) setActionError(errorText(cause));
    } finally {
      if (alive.current) { actionBusy.current = false; setBusy(false); setReload((value) => value + 1); }
    }
  }

  async function saveConfig(): Promise<void> {
    if (draft === null || view === null) return;
    const quietMs = Math.round(Number(draft.quietSeconds) * 1000);
    const maxInputChars = Number(draft.maxInputChars);
    const maxOutputTokens = Number(draft.maxOutputTokens);
    if (!draft.quietSeconds.trim() || !Number.isFinite(quietMs) || quietMs < 1000 || quietMs > 300000 ||
      !Number.isSafeInteger(maxInputChars) || maxInputChars < 1000 || maxInputChars > 64000 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 4096) {
      setActionError('静默延迟应为 1–300 秒；输入预算为 1000–64000 字符，输出预算为 256–4096 tokens（整数）。'); return;
    }
    if (draft.enabled && (!providers.some((item) => item.id === draft.providerId) || !draft.model.trim())) {
      setActionError('启用前请明确选择已接入的连接并填写模型 ID。'); return;
    }
    const config: MaintainerConfig = {
      enabled: draft.enabled, providerId: draft.providerId || null, model: draft.model.trim() || null,
      quietMs, maxInputChars, maxOutputTokens,
      thinkingEffort: draft.thinkingEffort === '' ? null : draft.thinkingEffort,
      autoApproveOnTurnEnd: draft.autoApproveOnTurnEnd,
    };
    await action(async () => {
      const saved = await api.patchMemoryConfig(projectId, config);
      if (alive.current) {
        setDraft(configDraft(saved));
        setView((current) => current === null ? current : { ...current, config: saved });
      }
    }, config.enabled ? '配置已保存；只有满足多来源、全项目 idle 与静默门槛后才可能维护。' : '配置已保存，自动维护已停用。');
  }

  async function pullModels(): Promise<void> {
    if (!draft?.providerId || modelsBusy) return;
    const request = ++modelRequest.current;
    const providerId = draft.providerId;
    setModelsBusy(true); setActionError(null); setNotice(null);
    try {
      const result = await api.listModels(providerId);
      if (!alive.current || request !== modelRequest.current) return;
      if (!result.ok) throw new Error(result.error ?? result.hint ?? '拉取模型失败');
      setModels(result.models.map((item) => item.id));
      setNotice(`已拉取 ${result.models.length} 个模型；也可手填任意模型 ID。`);
    } catch (cause) {
      if (alive.current && request === modelRequest.current) setActionError(errorText(cause));
    } finally {
      if (alive.current && request === modelRequest.current) setModelsBusy(false);
    }
  }

  return (
    <section className="panel memory-panel" aria-label="项目记忆" aria-busy={busy}>
      <div className="memory-heading"><div className="panel-title">项目工作台</div>
        <span className="memory-meta">{view === null ? '加载中' : `${records.length} 条共享记忆`}</span>
        <button type="button" className="small" aria-label="刷新项目记忆" disabled={busy} onClick={() => setReload((value) => value + 1)}>刷新</button>
      </div>
      {loadError && <p className="memory-error" role="alert">记忆读取失败：{loadError}</p>}
      {actionError && <p className="memory-error" role="alert">{actionError}</p>}
      {notice && <p className="hint" role="status">{notice}</p>}
      {view === null && <p className="hint">只读取本项目本地记录，不请求模型。</p>}
      {view !== null && <MemoryWorkbench key={`${projectId}/${conversationId ?? ''}`} view={view} conversationId={conversationId} projectName={projectName}
        conversations={conversations} refreshKey={refreshKey} onChanged={() => setReload((value) => value + 1)}
        visibleTabs={visibleTabs} defaultTab={defaultTab}
        {...(onOpenConversation === undefined ? {} : { onOpenConversation })}
        {...(onBackToParent === undefined ? {} : { onBackToParent })}
        onShowPending={() => setTab('proposals')}>
        <div className="seg memory-tabs" role="tablist" aria-label="记忆内容">
          <button type="button" role="tab" aria-selected={tab === 'records'} className={tab === 'records' ? 'on' : ''} onClick={() => setTab('records')}>正式版 {records.length}</button>
          <button type="button" role="tab" aria-selected={tab === 'proposals'} className={tab === 'proposals' ? 'on' : ''} onClick={() => setTab('proposals')}>暂存 {pending.length}</button>
          <button type="button" role="tab" aria-selected={tab === 'jobs'} className={tab === 'jobs' ? 'on' : ''} onClick={() => setTab('jobs')}>维护记录</button>
        </div>
        <div className="memory-content" role="tabpanel" aria-label={tab === 'records' ? '正式记忆记录' : tab === 'proposals' ? '暂存提案' : '维护任务记录'}>
          {tab === 'records' && (records.length === 0 ? <p className="hint">还没有正式记忆。暂存提案不会冒充已生效内容。</p> : records.map((record) => {
            const sources = [...new Set(view.proposals.filter((item) => item.recordId === record.id && item.status === 'applied').map((item) => item.conversationId))];
            return <details className="memory-card" key={record.id}>
              <summary aria-label={`正式记录 ${record.title}`}><span className="memory-meta">{KIND[record.kind]} · r{record.revision}</span> {record.title}</summary>
              <div className="memory-card-body"><div className="memory-meta">{record.id} · {timestamp(record.updatedAt)}</div>
                <MemoryRecordBody record={record} />
                <MemoryRecordEditor projectId={projectId} conversationId={conversationId} record={record} disabled={busy}
                  onProposed={() => { setNotice('修改已暂存，尚未生效；请在“暂存”中独立接受。'); setTab('proposals'); setReload((value) => value + 1); }} />
                <div className="memory-meta">来源：{sources.length ? sources.map((id) => sourceName(id, conversations)).join('；') : '当前投影未提供来源'}</div>
              </div>
            </details>;
          }))}
          {tab === 'proposals' && <>
            {pending.length === 0 && <p className="hint">没有待审或冲突提案。</p>}
            {pending.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} record={view.records.find((item) => item.id === proposal.recordId)} conversations={conversations} busy={busy}
              /**
               * ② 只有**来源于本对话**的提案能就地改文本（服务端还会再判一次，这里是省一次往返/给用户明白的反馈）。
               */
              onEditText={
                conversationId !== null && proposal.conversationId === conversationId
                  ? async (target, patch) => {
                      await action(
                        () => api.patchMemoryProposalText(projectId, target.id, conversationId, patch),
                        '暂存文本已更新；仍是待审状态，未生效。',
                      );
                    }
                  : undefined
              }
              onResolve={(id, accept) => void action(() => accept ? api.acceptMemoryProposal(projectId, id) : api.rejectMemoryProposal(projectId, id), accept ? '提案已接受。' : '提案已拒绝。')} />)}
            {view.proposals.some((item) => item.status === 'applied' || item.status === 'rejected') && <details className="memory-resolved"><summary>已处理提案</summary>
              {view.proposals.filter((item) => item.status === 'applied' || item.status === 'rejected').map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} record={view.records.find((item) => item.id === proposal.recordId)} conversations={conversations} busy={busy} onResolve={() => {}} />)}
            </details>}
          </>}
          {tab === 'jobs' && <>
            <p className="hint">维护任务的错误和用量只在此显示；工具底层历史仍保留。</p>
            {view.jobs.length === 0 && <p className="hint">还没有维护任务。</p>}
            {view.jobs.map((job) => <details key={job.id} className="memory-card" open={job.state === 'failed'}>
              <summary><span className={`memory-badge ${job.state}`}>{STATUS[job.state]}</span> {timestamp(job.createdAt)}</summary>
              <div className="memory-card-body">
                <div className="memory-meta">{providers.find((item) => item.id === job.providerId)?.name ?? job.providerId} / {job.model}</div>
                <div className="memory-meta">任务 {job.id}</div>
                <div className="memory-meta">输入 {job.inputTokens ?? '未回报'} / 输出 {job.outputTokens ?? '未回报'} tokens</div>
                {job.finishedAt && <div className="memory-meta">结束：{timestamp(job.finishedAt)}</div>}
                {job.error && <p className={job.state === 'failed' ? 'memory-error' : 'memory-warning'}>{memoryDiagnosticLabel(job.error)}{isMemoryDiagnosticCode(job.error) ? ` · ${job.error}` : ''}</p>}
              </div>
            </details>)}
          </>}
        </div>
        <MemoryPolicySettings key={projectId} projectId={projectId} />
        <details className="memory-config">
          <summary aria-label="记忆维护配置">维护配置 · {view.config.enabled ? '已启用' : '已停用'}{configDirty ? ' · 有未保存更改' : ''}</summary>
          {draft !== null && <form onSubmit={(event) => { event.preventDefault(); void saveConfig(); }}>
            <fieldset disabled={busy}>
              <label className="memory-check"><input type="checkbox" aria-label="启用自动记忆维护" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用自动维护（保存后生效）</label>
              <label>连接<select aria-label="记忆维护连接" value={draft.providerId} onChange={(event) => {
                const id = event.target.value;
                modelRequest.current++; setModelsBusy(false); setModels([]);
                setDraft({ ...draft, providerId: id, model: providers.find((item) => item.id === id)?.defaultModel ?? '' });
                setNotice(null); setActionError(null);
              }}>
                <option value="">未选择连接</option>
                {draft.providerId && !providers.some((item) => item.id === draft.providerId) && <option value={draft.providerId}>连接已不可用：{draft.providerId}</option>}
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              </select></label>
              <label>模型 ID<input aria-label="记忆维护模型 ID" list={modelListId} value={draft.model} placeholder="选择建议或手填任意模型 ID" onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
              <label>
                思考强度
                <select
                  aria-label="记忆维护思考强度"
                  value={draft.thinkingEffort}
                  onChange={(event) => setDraft({ ...draft, thinkingEffort: event.target.value })}
                >
                  <option value="">默认（交给模型）</option>
                  <option value="off">off（关掉思考）</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
              <datalist id={modelListId}>{modelOptions.map((model) => <option key={model} value={model} />)}</datalist>
              <button type="button" className="small" aria-label="拉取记忆维护模型" disabled={modelsBusy || !providers.some((item) => item.id === draft.providerId)} onClick={() => void pullModels()}>{modelsBusy ? '拉取中…' : '拉取模型'}</button>
              <p className="hint">默认模型与已有对话模型仅作为建议；只有点击“拉取模型”才请求连接，不自动探测。</p>
              <label>静默延迟（秒）<input aria-label="记忆维护静默秒数" type="number" min="1" max="300" step="0.001" value={draft.quietSeconds} onChange={(event) => setDraft({ ...draft, quietSeconds: event.target.value })} /></label>
              <label>输入成本上限（字符）<input aria-label="记忆维护输入预算" type="number" min="1000" max="64000" step="1" value={draft.maxInputChars} onChange={(event) => setDraft({ ...draft, maxInputChars: event.target.value })} /></label>
              <label>输出成本上限（tokens）<input aria-label="记忆维护输出预算" type="number" min="256" max="4096" step="1" value={draft.maxOutputTokens} onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.value })} /></label>
              <label className="memory-check">
                <input
                  type="checkbox"
                  aria-label="对话结束后自动批准非冲突台账"
                  checked={draft.autoApproveOnTurnEnd}
                  onChange={(event) => setDraft({ ...draft, autoApproveOnTurnEnd: event.target.checked })}
                />
                对话结束后自动批准<strong>不冲突</strong>的台账提案
              </label>
              <p className="hint">
                只自动批准不冲突的那部分：目标记录版本已变、或同一记录上有多条提案互相打架的，一律留在暂存区等人工；
                <strong>原则永远不会被自动批准</strong>。自动批准的记录会标明"自动"，不会冒充你本人点过。
              </p>
              <p className="hint">默认静默 15 秒（可设 1–300 秒 / 1000–300000 ms）；默认输入上限 64000 字符，输出上限 4096 tokens。启用维护会消耗所选模型额度。</p>
              <button type="submit" className="small primary" aria-label="保存记忆维护配置">{busy ? '处理中…' : '保存配置'}</button>
            </fieldset>
          </form>}
        <p className="hint">仅至少两个不同对话提交且全部对话结束本轮后触发；失败不自动重试。还需满足保存的静默延迟与成本限额；单来源不调用维护模型。</p>
        <div className="memory-actions">
          <button type="button" className="small" aria-label="显式重试记忆维护" disabled={busy || !canRetry} onClick={() => {
            if (canRetry) void action(() => api.retryMemory(projectId), '已请求显式重试；服务端仍检查多来源、idle、静默与成本门槛。');
          }}>显式重试</button>
          <span className="memory-meta">{pendingSources.size} 个待审来源 · {running ? '维护中' : projectIdle ? '项目 idle' : '等待全项目 idle'}</span>
        </div>
        </details>
      </MemoryWorkbench>}
    </section>
  );
}

function MemoryPolicySettings({ projectId }: { projectId: string }): React.ReactElement {
  const [value, setValue] = useState(''); const [saved, setSaved] = useState<number | null>(null);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0); const alive = useRef(false); const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let stopped = false; const controller = new AbortController(); setLoading(true);
    void api.getMemoryPolicy(projectId, controller.signal).then((result) => {
      if (!stopped) { setSaved(result.thresholdPercent); setValue(String(result.thresholdPercent)); setError(null); }
    }).catch((cause: unknown) => { if (!stopped) setError(errorText(cause)); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; controller.abort(); };
  }, [projectId, reload]);
  return <details className="memory-config"><summary>台账整理间隔（上下文%）{saved === null ? '' : ` · ${saved}%`}</summary>
    <p className="hint">只作用于强制收尾检查；范围 0–50，可填小数。0 表示每轮都检查。保存此设置不会请求模型，不改变手工台账编辑或正式记忆审批。</p>
    {error && <p role="alert" className="memory-error">{error}</p>}{notice && <p role="status" className="hint">{notice}</p>}
    {loading ? <p className="hint">读取本项目设置…</p> : <form onSubmit={(event) => {
      event.preventDefault(); if (pending.current || saved === null) return;
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number) || number < 0 || number > 50) { setError('台账整理间隔须为 0–50 的数值，允许小数。'); return; }
      pending.current = true; setSaving(true); setError(null); setNotice(null);
      void api.patchMemoryPolicy(projectId, number).then((result) => {
        if (alive.current) { setSaved(result.thresholdPercent); setValue(String(result.thresholdPercent)); setNotice('本项目台账整理间隔已保存。'); }
      }).catch((cause: unknown) => { if (alive.current) setError(errorText(cause)); }).finally(() => { if (alive.current) { pending.current = false; setSaving(false); } });
    }}><label>台账整理间隔（上下文%）<input aria-label="台账整理间隔（上下文%）" type="number" min="0" max="50" step="any" value={value} disabled={saving || saved === null} onChange={(event) => setValue(event.target.value)} /></label>
      <button type="submit" className="small" disabled={saving || saved === null}>保存整理间隔</button>
      <button type="button" className="small" disabled={saving} onClick={() => setReload((current) => current + 1)}>重新读取间隔</button>
    </form>}
  </details>;
}
