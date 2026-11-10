import { useEffect, useRef, useState } from 'react';
import {
  api, ApiError, type ConversationDto, type MemoryProposal, type MemoryObligation,
  type ObligationCode, type ObligationPage, type ObligationSummary, type ObligationQuery,
  type ResolveObligationInput,
} from './api.ts';
import './memory-obligations.css';

type Props = {
  projectId: string; conversations: ConversationDto[]; proposals: MemoryProposal[];
  refreshKey?: string; busy?: boolean; onChanged: () => void;
};
const STATUS = {
  required: '待收尾', repairing: '定向补收尾中', staged: '采集齐备（审核另计）', exempt: '已免除', incomplete: '未完成',
} as const;
/** 闭词表：不把模型自述、上游错误或任意旧 code 当作可靠错误原因。 */
const CODE: Record<ObligationCode, string> = {
  OBLIGATION_INTERVAL_NOT_DUE: '尚未达到台账整理间隔，本轮不强制收尾；新增进展仍会累计',
  OBLIGATION_REQUIRED: '本轮收尾义务已建立，尚待证据',
  OBLIGATION_BUSINESS: '出现了业务动作，需要重新核对收尾证据',
  OBLIGATION_PROPOSAL: '已收到提案指针，仍需核对两类证据',
  OBLIGATION_REPAIRING: '正在进行本轮唯一一次定向补收尾',
  OBLIGATION_STAGED: '进展与分流已成功采集；正式合并状态以各提案为准',
  OBLIGATION_INCOMPLETE: '收尾证据不完整，历史义务保留',
  OBLIGATION_REPAIR_EXHAUSTED: '本轮一次补收尾机会已使用，未完成项保留',
  OBLIGATION_REPAIR_FAILED: '定向补收尾请求失败；未完成项保留，不自动重试',
  OBLIGATION_REPAIR_TIMEOUT: '定向补收尾超时；未完成项保留，不自动重试',
  OBLIGATION_REPAIR_INPUT_LIMIT: '定向补收尾输入超过预算；未发送模型请求，未完成项保留',
  OBLIGATION_NO_PROGRESS: '模型明确声明本轮无新增；这是可追溯声明，不是语义事实证明',
  OBLIGATION_ERROR: '本轮发生错误；需复核，不能宣称成果漏记',
  OBLIGATION_ABORT: '本轮已中断；需复核实际进展',
  OBLIGATION_READONLY: '受只读权限限制，不自动补收尾；免除不是已记录',
  OBLIGATION_REGISTRY_MISSING: '所需记忆工具未接入，不额外请求模型；已有变更仍需核对',
  OBLIGATION_TOOLS_DISABLED: '所需记忆工具被关闭，不绕过用户配置；已有变更仍需核对',
  OBLIGATION_USER_SKIP: '用户明确跳过；属于免除，不是已记录',
  OBLIGATION_RECONCILED: '已核对既有双类提案；没有生成或自动应用新内容',
  OBLIGATION_LEGACY_REVIEW: '旧欠账记录缺少新证据链，需人工复核',
  OBLIGATION_EVIDENCE_INVALID: '引用证据不满足本轮收尾要求',
  OBLIGATION_EVIDENCE_STALE: '证据早于后续业务动作，需要重新核对',
};
function diagnostic(code: string): string {
  return Object.hasOwn(CODE, code) ? CODE[code as ObligationCode] : '未知义务诊断；原始错误不在界面显示';
}
function safeRequestError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 409) return '409 · 当前对话仍在运行，或义务/提案状态已变化；请结束本轮并刷新核对。';
    if (cause.status === 400 || cause.status === 422) return `${cause.status} · 理由或双类证据不满足校验；请核对同源、进展与分流提案。`;
    if (cause.status === 404) return '404 · 当前项目、来源或证据不可用；请刷新项目后重试。';
    return `${cause.status} · 本地义务操作未完成；原始响应不在界面显示。`;
  }
  return '本地义务服务暂不可用；请检查连接并刷新。';
}
const timestamp = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间不可用' : date.toLocaleString();
};
function conversationName(id: string, conversations: ConversationDto[]): string {
  return conversations.find((conversation) => conversation.id === id)?.title ?? id;
}
function evidenceType(proposal: MemoryProposal): 'progress' | 'triage' | null {
  if (proposal.kind === 'principle') return null;
  if (!proposal.recordId.startsWith('artifact:')) return 'progress';
  if (proposal.kind !== 'note') return null;
  let marker: unknown;
  try { const value: unknown = JSON.parse(proposal.content); marker = value && typeof value === 'object' && '$memory' in value ? value.$memory : null; } catch { return null; }
  if (proposal.recordId.startsWith('artifact:triage:') && marker === 'triage') return 'triage';
  return (proposal.recordId.startsWith('artifact:intent:') && marker === 'intent') ||
    (proposal.recordId.startsWith('artifact:handoff:') && marker === 'handoff') ? 'progress' : null;
}

/** 重新绑定项目会卸载旧状态；请求与操作各有过期守卫。 */
export function MemoryObligations(props: Props): React.ReactElement {
  return <ProjectObligations key={props.projectId} {...props} />;
}
function ProjectObligations({ projectId, conversations, proposals, refreshKey = '', busy = false, onChanged }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState('');
  const [status, setStatus] = useState<NonNullable<ObligationQuery['status']> | ''>('');
  const [includeResolved, setIncludeResolved] = useState(false);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [summary, setSummary] = useState<ObligationSummary | null>(null);
  const [result, setResult] = useState<{ key: string; page: ObligationPage | null; error: string | null } | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<{ entry: MemoryObligation; type: 'skip' | 'reconcile' } | null>(null);
  const [writing, setWriting] = useState(false);
  const mounted = useRef(false); const operationBusy = useRef(false); const epoch = useRef(0);
  const changed = useRef(onChanged); changed.current = onChanged;
  const key = `${projectId}/${open}/${conversationId}/${status}/${includeResolved}/${offset}/${reload}/${refreshKey}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useEffect(() => {
    let stopped = false; let fetching = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function poll(): Promise<void> {
      if (stopped || fetching) return;
      if (operationBusy.current) { timer = setTimeout(() => void poll(), 5000); return; }
      fetching = true; const version = epoch.current;
      try {
        const query: ObligationQuery = open ? { conversationId: conversationId || undefined, status: status || undefined, includeResolved, limit: 20, offset } : { includeResolved: true, limit: 1, offset: 0 };
        const page = await api.getMemoryObligations(projectId, query, controller.signal);
        if (!stopped && !operationBusy.current && version === epoch.current) {
          if (page.projectId !== projectId) throw new Error('Wrong project response');
          setSummary(page.summary); setResult({ key, page, error: null });
        }
      } catch (cause) {
        if (!stopped && version === epoch.current) setResult({ key, page: null, error: safeRequestError(cause) });
      } finally { fetching = false; if (!stopped) timer = setTimeout(() => void poll(), 5000); }
    }
    void poll();
    return () => { stopped = true; controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [projectId, key, open, conversationId, status, includeResolved, offset]);
  const page = result?.key === key ? result.page : null;
  const readError = result?.key === key ? result.error : null;
  const currentSelection = action ? page?.entries.find((entry) => entry.id === action.entry.id) : undefined;
  // 轮询或外部刷新不抹掉用户正在填写的理由；操作前必须再次取得当前页证据。
  const selected = currentSelection ?? action?.entry;
  async function resolve(input: ResolveObligationInput): Promise<void> {
    if (operationBusy.current || busy) return;
    if (!currentSelection || !selected || selected.running || selected.status === 'staged' || selected.status === 'exempt' || selected.conversationId !== input.conversationId || selected.userSeq !== input.userSeq) {
      setOperationError('来源或义务已变化，请重新选择；运行中的对话不能处理。'); return;
    }
    operationBusy.current = true; epoch.current++; setWriting(true); setOperationError(null); setNotice(null);
    try {
      const response = await api.resolveMemoryObligation(projectId, input);
      if (!mounted.current) return;
      setSummary(response.summary); setAction(null);
      setNotice(input.action === 'skip'
        ? '此项已按用户理由免除。跳过不等于已记录，没有批量消除其他义务。'
        : '已核对既有进展与分流提案。已暂存不等于正式合并；本操作没有生成或应用内容。');
      changed.current();
    } catch (cause) { if (mounted.current) setOperationError(safeRequestError(cause)); }
    finally { if (mounted.current) { operationBusy.current = false; setWriting(false); setReload((value) => value + 1); } }
  }
  function resetFilters(): void { setOffset(0); setAction(null); setOperationError(null); }
  return <section className="memory-obligations" aria-label="项目收尾义务" aria-busy={writing}>
    <div className="mo-heading"><strong>项目收尾义务 · 全历史</strong><button type="button" className="small" aria-label="刷新项目收尾义务" disabled={writing} onClick={() => setReload((value) => value + 1)}>刷新</button></div>
    <div className="mo-counts" aria-label="全项目义务统计">
      <span>历史未完成 <b>{summary?.incomplete ?? '待读'}</b></span><span>补收尾中 <b>{summary?.repairing ?? '待读'}</b></span>
      <span>采集齐备 <b>{summary?.staged ?? '待读'}</b></span><span>已免除 <b>{summary?.exempt ?? '待读'}</b></span>
      <span>旧记录 / 需复核 <b>{summary?.needsReview ?? '待读'}</b></span><span>全项目累计 <b>{summary?.total ?? '待读'}</b></span>
    </div>
    <p className="hint"><strong>已暂存不等于正式合并。</strong>采集齐备包括待审和已应用，审核状态以各条证据为准。统计覆盖本项目所有对话与历史轮次，不只最后一条欠账；免除也不是已记录。</p>
    {readError && <p className="mo-error" role="alert">{readError}{summary ? ' 上方统计为上次成功读取，非最新结果。' : ''}</p>}
    {operationError && <p className="mo-error" role="alert">{operationError}</p>}{notice && <p className="mo-notice" role="status">{notice}</p>}
    <details className="mo-details" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label="展开项目历史义务">查看 / 逐项处理历史义务</summary>
      <div className="mo-body">
        <div className="mo-filters"><label>来源对话<select aria-label="义务来源对话筛选" value={conversationId} disabled={writing} onChange={(event) => { setConversationId(event.target.value); resetFilters(); }}><option value="">本项目全部对话</option>{conversations.filter((conversation) => conversation.projectId === projectId).map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title ?? conversation.id}</option>)}</select></label>
          <label>义务状态<select aria-label="义务状态筛选" value={status} disabled={writing} onChange={(event) => { const next = event.target.value as typeof status; setStatus(next); if (next === 'staged' || next === 'exempt') setIncludeResolved(true); resetFilters(); }}><option value="">全部可见状态</option>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="needs_review">旧记录 / 需复核</option></select></label></div>
        <label className="mo-check"><input type="checkbox" aria-label="显示已暂存与免除义务" checked={includeResolved} disabled={writing} onChange={(event) => { setIncludeResolved(event.target.checked); if (!event.target.checked && (status === 'staged' || status === 'exempt')) setStatus(''); resetFilters(); }} />包含采集齐备与已免除历史</label>
        {!page && !readError && <p className="hint" role="status">读取本地义务指针…</p>}
        {page && <><p className="mo-meta">筛选后 {page.total} 条 · 当前 {page.entries.length ? page.offset + 1 : 0}–{page.offset + page.entries.length} · 统计卡仍为全项目累计</p>
          {page.entries.length === 0 && <p className="hint">当前筛选下没有义务记录；这不表示其他筛选或项目历史为空。</p>}
          {page.entries.map((entry) => <ObligationRow key={entry.id} entry={entry} conversations={conversations} disabled={writing || busy || !!readError} onAction={(type) => { setAction({ entry, type }); setOperationError(null); setNotice(null); }} />)}
          <div className="mo-actions"><button type="button" className="small" aria-label="上一页义务" disabled={writing || page.offset === 0} onClick={() => { setOffset(Math.max(0, page.offset - page.limit)); setAction(null); }}>上一页</button><button type="button" className="small" aria-label="下一页义务" disabled={writing || page.offset + page.entries.length >= page.total} onClick={() => { setOffset(page.offset + page.limit); setAction(null); }}>下一页</button></div>
        </>}
        {selected && action && <ObligationResolution key={`${selected.id}/${action.type}`} entry={selected} type={action.type} proposals={proposals} disabled={writing || busy || selected.running || !!readError || !currentSelection || selected.status === 'staged' || selected.status === 'exempt'} onCancel={() => setAction(null)} onResolve={resolve} />}
      </div>
    </details>
    <p className="hint">正常每轮最多一次定向补收尾；未完成项保留在这里，正文不再反复播报。此面板只核对本地证据，不自动调用真实模型。</p>
  </section>;
}

function ObligationRow({ entry, conversations, disabled, onAction }: { entry: MemoryObligation; conversations: ConversationDto[]; disabled: boolean; onAction: (type: 'skip' | 'reconcile') => void }): React.ReactElement {
  const actionable = entry.status !== 'exempt' && entry.status !== 'staged';
  const published = entry.status === 'staged' && entry.progress?.proposalStatus === 'applied' && entry.triage?.proposalStatus === 'applied';
  const label = entry.status === 'staged' ? (published ? '两类提案已应用' : '已暂存待审') : STATUS[entry.status];
  return <details className={`mo-row ${entry.legacy ? 'mo-legacy' : ''}`}>
    <summary aria-label={`义务 ${entry.conversationId} userSeq ${entry.userSeq}`}><span className="mo-status">{entry.legacy ? (entry.needsReview ? '旧记录 · 需复核' : `旧记录 · ${label}`) : label}</span>{' '}{conversationName(entry.conversationId, conversations)} · userSeq {entry.userSeq}<br /><span className="mo-meta">{timestamp(entry.createdAt)} · 修复尝试 {entry.repairAttempt}/1 · {entry.missing.length ? `缺${entry.missing.map((type) => type === 'progress' ? '进展' : '分流').join('、')}` : entry.status === 'exempt' ? '已免除（不是已记录）' : entry.needsReview ? '旧证据链待核对' : '两类证据指针齐备'}{entry.running ? ' · 对话运行中' : ''}</span><br /><span className="mo-meta">{diagnostic(entry.code)}</span></summary>
    <div className="mo-row-body"><p className="mo-meta">来源 {entry.conversationId} · 最后业务 seq {entry.lastBusinessSeq} · 更新 {timestamp(entry.updatedAt)}</p>
      {entry.legacy && entry.needsReview && <p className="mo-notice">legacy：只有旧欠账记录，没有本轮新式证据链；包含错误轮，不能把它解释为已证实的成果漏记。只能逐项核对或明确免除。</p>}
      {entry.legacy && entry.status === 'exempt' && <p className="mo-notice">legacy：保留旧检查点明确跳过的历史状态，已免除，不计作待复核义务。跳过不是已记录，也不代表正式记忆已合并。</p>}
      {entry.stale && <p className="mo-notice">存在过期证据：提案之后还有业务动作，不能将旧提案当成本轮已收尾。</p>}
      {entry.reasonSource === 'model' && <p className="mo-meta">本项按模型的无新增声明免除（semanticProof=false），不是程序已证明没有成果；成功业务写入或已有进展提案不能走此免除。</p>}
      {entry.reasonSource === 'user' && entry.reason && <p className="mo-meta">用户处理理由：{entry.reason}</p>}
      <details><summary>证据指针 · {entry.evidence.length} 条</summary>{entry.evidence.length === 0 && <p className="hint">没有可核对的证据指针。</p>}{entry.evidence.map((evidence, index) => <p key={`${evidence.proposalId}/${index}`} className="mo-meta">{evidence.type === 'progress' ? '进展' : '分流'} · {evidence.proposalId} · message seq {evidence.messageSeq} · {evidence.proposalStatus ?? '状态不可用'} · {evidence.valid ? '指针有效' : '证据无效'}{evidence.stale ? ' · 过期' : ''}</p>)}</details>
      <details><summary>义务留痕 · {entry.events.length} 条</summary>{entry.events.map((event) => <p key={event.id} className="mo-meta">{timestamp(event.createdAt)} · {diagnostic(event.code)}{event.messageSeq !== null ? ` · seq ${event.messageSeq}` : ''}{event.proposalId ? ` · ${event.proposalId}` : ''}</p>)}</details>
      {actionable && <div className="mo-actions"><button type="button" className="small" aria-label={`免除此项义务 ${entry.id}`} disabled={disabled || entry.running} onClick={() => onAction('skip')}>逐项免除（需理由）</button><button type="button" className="small" aria-label={`核对既有证据 ${entry.id}`} disabled={disabled || entry.running} onClick={() => onAction('reconcile')}>引用既有双类提案核对</button></div>}
      {entry.status === 'staged' && <p className="hint">{published ? '两类提案均已应用；正式版本可在记忆工作台查看。' : '证据采集齐备；尚未应用的提案仍须独立审阅 / 合并。'}</p>}
    </div>
  </details>;
}

function ObligationResolution({ entry, type, proposals, disabled, onCancel, onResolve }: { entry: MemoryObligation; type: 'skip' | 'reconcile'; proposals: MemoryProposal[]; disabled: boolean; onCancel: () => void; onResolve: (input: ResolveObligationInput) => Promise<void> }): React.ReactElement {
  const [reason, setReason] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const eligible = proposals.filter((proposal) => proposal.conversationId === entry.conversationId && (proposal.status === 'pending' || proposal.status === 'applied') && evidenceType(proposal) !== null);
  const hasBothTypes = (['progress', 'triage'] as const).every((type) => eligible.some((proposal) => ids.includes(proposal.id) && evidenceType(proposal) === type));
  return <section className="mo-resolution" aria-label="逐项处理义务确认"><strong>{type === 'skip' ? '确认免除此一项（不是已记录）' : '核对已存在提案（不生成 / 不自动应用）'}</strong><p className="mo-meta">仅处理 {entry.conversationId} / userSeq {entry.userSeq}；不处理其他轮次。</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!confirmed || disabled || (type === 'skip' ? !reason.trim() : !hasBothTypes)) return; void onResolve({ conversationId: entry.conversationId, userSeq: entry.userSeq, action: type, ...(type === 'skip' ? { reason: reason.trim() } : { proposalIds: ids }) }); }}><fieldset disabled={disabled}>
      {type === 'skip' ? <label>本项跳过理由（必填）<textarea aria-label="义务跳过理由" required maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} /></label> : <>
        <p className="hint">请选择同来源对话的进展与分流两类既有提案。服务端继续验证真实关联、顺序及有效性，不能用其他轮次或任意 ID 伪造收尾。</p>
        <div className="mo-evidence">{eligible.length === 0 && <p className="hint">暂无可核对的同源提案。这里只能引用历史上实际成功提交的同轮证据；没有证据可明确免除，或在新一轮真实补记，不可用新草稿伪造旧回执。</p>}{eligible.map((proposal) => <div key={proposal.id}><label className="mo-check"><input type="checkbox" aria-label={`义务证据提案 ${proposal.id}`} checked={ids.includes(proposal.id)} onChange={(event) => setIds(event.target.checked ? [...ids, proposal.id] : ids.filter((id) => id !== proposal.id))} />{evidenceType(proposal) === 'triage' ? '分流证据' : '进展证据'} · {proposal.title} · {proposal.status}<span className="mo-meta">{proposal.id}</span></label><details><summary>查看此提案原文</summary><pre>{proposal.content}</pre></details></div>)}</div>
      </>}
      <label className="mo-check"><input type="checkbox" aria-label="确认仅处理所选义务" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{type === 'skip' ? '我确认凭以上理由仅免除此项，跳过不等于已记录' : '我确认仅核对所选既有双类提案，不生成、不自动合并正式内容'}</label>
      <div className="mo-actions"><button type="submit" className="small" aria-label={type === 'skip' ? '确认免除此项义务' : '确认核对双类提案'} disabled={disabled || !confirmed || (type === 'skip' ? !reason.trim() : !hasBothTypes)}>{type === 'skip' ? '确认免除此项' : '确认核对双类提案'}</button><button type="button" className="small" onClick={onCancel} disabled={disabled}>取消</button></div>
    </fieldset></form>
  </section>;
}
