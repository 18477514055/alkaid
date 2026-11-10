import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api, ApiError, COMPACTION_DUTY_LABEL, type ConversationDto, type MemoryView, type MemoryProposal, type MemoryRecord,
  type GoalTree, type LessonSearch, type NoteContent, type MemoryKind, type ArchivePage,
  type MemoryIndex, type PreservedView, type TriageView, type Handoff, type PrincipleCurrent,
  type PrincipleProposal, type ExtensionDefinition, type ExtensionEntry, type IntentEntry,
  type UserQuoteGroup, type MemoryCapsule, type MaterialMapDto, type MemoryContextState,
  type CheckpointChoice, type CheckpointInput, type ArtifactInput, type MemoryCounts,
  type CompactionStatusDto, type CompactionEventPage, type CompactionEventCode, type CompactionEvent,
  type RecallIndex, type RecallMessagePage,
} from './api.ts';
import { Markdown } from './markdown.tsx';
import type { PanelTab } from '../../src/shared/settings.ts';
import './memory-workbench.css';
import { serializeMemoryForm } from './memoryForm.ts';
import { MemoryObligations } from './MemoryObligations.tsx';
import { ExecutionBoard } from './ExecutionBoard.tsx';
import { DelegationBoardPanel } from './DelegationBoard.tsx';

type Props = {
  view: MemoryView; conversationId: string | null; projectName?: string;
  conversations: ConversationDto[]; refreshKey: number; children: ReactNode;
  onChanged: () => void; onShowPending: () => void;
  /**
   * 右栏设置里"显示哪些页签 / 默认停在哪个"（来自 `app_settings`）。
   * ★ 不传 = 四个页签全显示、默认「工作」—— 保持既有行为，避免影响旧调用方与测试。
   */
  visibleTabs?: readonly PanelTab[];
  defaultTab?: PanelTab;
  /**
   * ★ 从委派看板点进某个子代理/队友的对话（2026-11-10 用户要求）。
   * 不传 = 看板只显示不可点（保持旧调用方行为）。
   */
  onOpenConversation?: (conversationId: string) => void;
  /** 从子代理对话切回主对话 */
  onBackToParent?: () => void;
};
type Page = 'work' | 'overview' | 'current' | 'archive' | 'goals' | 'lessons' | 'notes' | 'preserved' | 'index' | 'map' | 'triage' | 'handoffs' | 'capsules' | 'checkpoint' | 'principles' | 'logs' | 'extensions' | 'compaction';
type Group = 'work' | 'memory' | 'logs' | 'advanced';
const GROUPS: Record<Group, { label: string; pages: [Page, string][] }> = {
  work: { label: '工作', pages: [['work', '当前执行目标 / 任务 / 动态']] },
  memory: { label: '台账', pages: [['current', '正式记录 / 待审修改 / 整理设置'], ['goals', '长期目标树（不是当前执行目标）'], ['lessons', '教训与经验'], ['notes', '问题 / 调研笔记'], ['triage', '保留 / 暂存 / 丢弃分流'], ['extensions', '自定义扩展'], ['preserved', '其他对话保留的进展']] },
  logs: { label: '日志', pages: [['logs', '意图摘要 / 用户原话 / 追加更正'], ['compaction', '上下文压缩 / 原文回读'], ['handoffs', '交接单'], ['archive', '记录修订历史'], ['capsules', '压缩前逐字原文']] },
  advanced: { label: '高级', pages: [['overview', '台账状态概览'], ['checkpoint', '收尾检查点（四选一）'], ['index', '诊断排序（只读）'], ['map', '材料地图 / 模型未读']] },
};
const GOAL_STATE: Record<string, string> = { root: '根目标', active: '进行中', paused: '暂停', done: '完成', dropped: '放弃' };
const time = (value: string): string => new Date(value).toLocaleString();
const lines = (value = ''): string[] => value.split('\n').map((line) => line.trim()).filter(Boolean);
const message = (cause: unknown): string => cause instanceof ApiError && cause.compactionBlocked
  ? `本次未压缩、未发压缩模型请求。尚缺：${cause.compactionBlocked.missing.map((kind) => COMPACTION_DUTY_LABEL[kind]).join('、') || '有效三层证据'}。请分别补齐台账更新、进展日志与 triage；可以继续工作。`
  : cause instanceof ApiError ? `${cause.status} · ${cause.message}` : cause instanceof Error ? cause.message : String(cause);
const objectContent = (content: string): Record<string, unknown> | null => {
  try { const value: unknown = JSON.parse(content); return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
};
const scalar = (value: unknown): string => Array.isArray(value) ? value.map((entry: unknown) => {
  if (entry && typeof entry === 'object' && 'what' in entry) {
    const item = entry as Record<string, unknown>;
    return [String(item.what), item.why ? `原因：${String(item.why)}` : '', item.where ? `位置：${String(item.where)}` : ''].filter(Boolean).join('\n');
  }
  return typeof entry === 'string' ? entry : JSON.stringify(entry);
}).join('\n\n') : typeof value === 'string' ? value : '';

/** 结构化记录在正式版里也是可读正文，不要求用户理解 JSON。 */
export function MemoryRecordBody({ record }: { record: MemoryRecord }): React.ReactElement {
  const data = objectContent(record.content);
  const knownStructure = data && (
    (record.kind === 'goal' && typeof data.state === 'string' && Array.isArray(data.keyResults)) ||
    (record.kind === 'lesson' && (data.type === 'lesson' || data.type === 'experience') && typeof data.body === 'string') ||
    (record.kind === 'note' && ['problem', 'research', 'other'].includes(String(data.type)) && typeof data.body === 'string') ||
    (record.id.startsWith('artifact:') && ['triage', 'handoff', 'intent', 'extension-entry'].includes(String(data.$memory)))
  );
  if (!data || !knownStructure) return <Markdown text={record.content} />;
  const labels: Record<string, string> = { body: '正文', state: '状态', parentId: '父目标', keyResults: '关键结果', lessons: '教训', type: '类型', category: '分类', symptom: '现象', rootCause: '根因', source: '出处', fix: '正确做法', scope: '适用范围', conclusion: '结论', documentName: '文档名', did: '做了什么', next: '下一步', files: '关键文件', blocked: '阻塞与待决策', goal: '目标', issues: '问题', content: '内容' };
  return <div className="wb-record-fields">{Object.entries(data).filter(([key]) => key !== '$memory').map(([key, value]) => {
    const text = scalar(value);
    return text ? <section key={key}><strong>{labels[key] ?? key}</strong><Markdown text={key === 'state' ? (GOAL_STATE[text] ?? text) : text} /></section> : null;
  })}</div>;
}

/** 每个 key 的结果独立；切页、查询、项目时 abort 并拒绝旧结果。无模型与定时详情请求。 */
function useLocal<T>(key: string, load: (signal: AbortSignal) => Promise<T>, enabled = true, retainKey = key): { data: T | null; error: string | null; loading: boolean } {
  const loader = useRef(load); loader.current = load;
  const [result, setResult] = useState<{ key: string; retainKey: string; data: T | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let stopped = false;
    void loader.current(controller.signal).then((data) => { if (!stopped) setResult({ key, retainKey, data, error: null }); })
      .catch((cause: unknown) => { if (!stopped) setResult(previous => ({ key, retainKey, data: previous?.retainKey === retainKey ? previous.data : null, error: message(cause) })); });
    return () => { stopped = true; controller.abort(); };
  }, [key, enabled, retainKey]);
  // Polling may keep the SAME resource visible so native details/readback state
  // does not collapse every ten seconds. Conversation/page changes never reuse it.
  return { data: enabled && result?.retainKey === retainKey ? result.data : null, error: result?.key === key ? result.error : null, loading: enabled && result?.key !== key };
}
function ReadState({ query }: { query: { error: string | null; loading: boolean } }): React.ReactElement | null {
  return query.error ? <p role="alert" className="wb-error">读取失败：{query.error}</p> : query.loading ? <p className="hint" role="status">读取本地记录…</p> : null;
}
function Empty({ children = '暂无记录。' }: { children?: ReactNode }): React.ReactElement { return <p className="wb-empty">{children}</p>; }
function Issues({ issues }: { issues: { recordId: string; code: string; message: string }[] }): React.ReactElement | null {
  return issues.length ? <details className="wb-warning" open><summary>发现 {issues.length} 个结构问题</summary>{issues.map((issue, index) => <p key={index}>{issue.recordId} · {issue.code} · {issue.message}</p>)}</details> : null;
}
function FullRecord({ record }: { record: MemoryRecord | null }): React.ReactElement {
  return record ? <><p className="memory-meta">{record.title} · r{record.revision} · {record.deleted ? '已软删' : '有效'}</p><MemoryRecordBody record={record} /><details><summary>逐字原文</summary><pre className="wb-verbatim">{record.content}</pre></details></> : <Empty>此侧不存在记录。</Empty>;
}

type Field = { name: string; label: string; kind?: 'textarea' | 'select' | 'date' | 'number' | 'checkbox'; required?: boolean; value?: string; options?: [string, string][]; hint?: string };
function Editor(props: { title: string; fields: Field[]; busy: boolean; submit: (values: Record<string, string>, idempotencyKey: string) => Promise<void>; button?: string; defaultOpen?: boolean }): React.ReactElement {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const submitting = useRef(false);
  const identity = useRef({ signature: '', key: '' });
  return <details className="wb-editor" open={props.defaultOpen}><summary>{props.title}</summary><form onSubmit={(event) => {
    event.preventDefault();
    if (submitting.current || props.busy) return;
    setError(null); setSubmitted(false);
    const input = Object.fromEntries(props.fields.map((field) => [field.name, values[field.name] ?? field.value ?? '']));
    const signature = JSON.stringify(input);
    if (identity.current.signature !== signature) identity.current = { signature, key: crypto.randomUUID() };
    submitting.current = true;
    void props.submit(input, identity.current.key).then(() => {
      identity.current = { signature: '', key: '' }; setValues({}); setSubmitted(true);
    }).catch((cause: unknown) => setError(message(cause))).finally(() => { submitting.current = false; });
  }}><fieldset disabled={props.busy}>{props.fields.map((field) => <label key={field.name}>
    {field.label}{field.required ? ' *' : ''}
    {field.kind === 'textarea' ? <textarea aria-label={field.label} rows={3} required={field.required} value={values[field.name] ?? field.value ?? ''} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />
      : field.kind === 'select' ? <select aria-label={field.label} required={field.required} value={values[field.name] ?? field.value ?? ''} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}>{field.options?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      : field.kind === 'checkbox' ? <input aria-label={field.label} type="checkbox" checked={(values[field.name] ?? field.value) === 'true'} onChange={(event) => setValues({ ...values, [field.name]: String(event.target.checked) })} />
      : <input aria-label={field.label} type={field.kind ?? 'text'} required={field.required} value={values[field.name] ?? field.value ?? ''} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />}
    {field.hint && <span className="hint">{field.hint}</span>}
  </label>)}{error && <p className="wb-error" role="alert">{error}</p>}{submitted && <p className="hint" role="status">{props.button === '查询本地记录' ? '本地查询已更新。' : props.button === '确认新建扩展定义' ? '用户扩展定义已创建；条目内容仍须另行提交提案并接受。' : '提交成功；表单已重置，可再新建同名独立条目。提案尚未生效，仍需独立接受。'}</p>}<button type="submit" className="small" aria-label={props.button ?? props.title}>{props.busy ? '处理中…' : (props.button ?? '提交为暂存提案')}</button></fieldset></form></details>;
}
export function MemoryRecordEditor(props: { projectId: string; conversationId: string | null; record: MemoryRecord; disabled: boolean; onProposed: (proposal: MemoryProposal) => void }): React.ReactElement {
  const [snapshot, setSnapshot] = useState<MemoryRecord | null>(null);
  const [prefillKey, setPrefillKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (props.record.kind === 'principle') return <p className="hint">原则请使用顶部独立“原则”入口提议并人工批准。</p>;
  const data = snapshot ? objectContent(snapshot.content) : null;
  const typedGoal = snapshot?.kind === 'goal' && typeof data?.state === 'string' && Array.isArray(data.keyResults);
  const typedLesson = snapshot?.kind === 'lesson' && (data?.type === 'lesson' || data?.type === 'experience');
  const typedNote = snapshot?.kind === 'note' && ['problem', 'research', 'other'].includes(String(data?.type)) && typeof data?.body === 'string';
  const fields: Field[] = [{ name: 'title', label: '修改记录标题', required: true, value: snapshot?.title ?? '' }];
  if (typedGoal) fields.push({ name: 'parentId', label: '修改父目标 ID', value: scalar(data?.parentId) }, { name: 'state', label: '修改目标状态', kind: 'select', value: scalar(data?.state), options: Object.entries(GOAL_STATE) }, { name: 'body', label: '修改目标说明', kind: 'textarea', value: scalar(data?.body) }, { name: 'keyResults', label: '修改关键结果（每行一条）', kind: 'textarea', value: Array.isArray(data?.keyResults) ? data.keyResults.join('\n') : '' }, { name: 'lessons', label: '修改路径教训（每行一条）', kind: 'textarea', value: Array.isArray(data?.lessons) ? data.lessons.join('\n') : '' });
  else if (typedLesson) fields.push({ name: 'type', label: '修改条目类型', kind: 'select', value: scalar(data?.type), options: [['lesson', '教训'], ['experience', '经验']] }, { name: 'category', label: '修改分类', required: true, value: scalar(data?.category) }, { name: 'body', label: '修改条目正文', kind: 'textarea', required: true, value: scalar(data?.body) }, { name: 'symptom', label: '修改现象', kind: 'textarea', value: scalar(data?.symptom) }, { name: 'rootCause', label: '修改根因（教训必填）', kind: 'textarea', value: scalar(data?.rootCause) }, { name: 'source', label: '修改出处（经验必填）', value: scalar(data?.source) }, { name: 'fix', label: '修改正确做法', kind: 'textarea', required: true, value: scalar(data?.fix) }, { name: 'scope', label: '修改适用范围', value: scalar(data?.scope) });
  else if (typedNote) fields.push({ name: 'type', label: '修改笔记类型', kind: 'select', value: scalar(data?.type), options: [['problem', '问题'], ['research', '调研'], ['other', '其他']] }, { name: 'body', label: '修改笔记正文', kind: 'textarea', required: true, value: scalar(data?.body) }, { name: 'rootCause', label: '修改问题根因', kind: 'textarea', value: scalar(data?.rootCause) }, { name: 'conclusion', label: '修改调研结论', kind: 'textarea', value: scalar(data?.conclusion) });
  else fields.push({ name: 'content', label: '修改记录正文', kind: 'textarea', required: true, value: snapshot?.content ?? '' });
  fields.push({ name: 'reason', label: '此次修改理由', required: true });
  return <div className="wb-record-edit"><button type="button" className="small" aria-label={`编辑正式记录 ${props.record.title}`} disabled={props.disabled || saving} onClick={() => { setSnapshot(props.record); setPrefillKey((value) => value + 1); }}>{snapshot ? '重新从正式版预填' : '编辑此记录'}</button>
    {snapshot && <><p className="hint">已预填记录，无需手输 ID。编辑基于 r{snapshot.revision}；只会提交暂存提案，不直接改正式内容。</p>{props.record.revision !== snapshot.revision && <p className="wb-warning">正式记录已更新至 r{props.record.revision}，你的输入保留；请核对后重新预填或提交为待审冲突提案。</p>}
      <Editor key={`${snapshot.id}/${snapshot.revision}/${prefillKey}`} defaultOpen title="编辑预填内容并提交提案" fields={fields} busy={props.disabled || saving} submit={async (values, idempotencyKey) => {
        if (!props.conversationId) throw new Error('请选择本项目主对话后再编辑。');
        let content = values.content ?? snapshot.content;
        if (typedGoal) content = serializeMemoryForm({ parentId: values.parentId || null, state: values.state, body: values.body, keyResults: lines(values.keyResults), lessons: lines(values.lessons) });
        if (typedLesson) {
          if (values.type === 'lesson' && !values.rootCause?.trim()) throw new Error('教训必须填写根因。');
          if (values.type === 'experience' && !values.source?.trim()) throw new Error('经验必须填写出处。');
          content = serializeMemoryForm({ type: values.type, category: values.category, body: values.body, symptom: values.symptom, rootCause: values.rootCause, source: values.source, fix: values.fix, scope: values.scope });
        }
        if (typedNote) {
          if (values.type === 'problem' && !values.rootCause?.trim()) throw new Error('问题笔记必须填写根因。');
          if (values.type === 'research' && !values.conclusion?.trim()) throw new Error('调研笔记必须填写结论。');
          content = serializeMemoryForm({ type: values.type, body: values.body, rootCause: values.rootCause, conclusion: values.conclusion });
        }
        setSaving(true);
        try {
          const proposal = await api.submitMemoryProposal(props.projectId, { conversationId: props.conversationId, recordId: snapshot.id, kind: snapshot.kind, title: values.title!, operation: 'upsert', content, baseRevision: snapshot.revision, reason: values.reason!, idempotencyKey });
          if (alive.current) { setSnapshot(null); props.onProposed(proposal); }
        } finally { if (alive.current) setSaving(false); }
      }} />
      <button type="button" className="small" disabled={saving} onClick={() => setSnapshot(null)}>取消编辑，不写入</button>
    </>}
  </div>;
}

function SearchForm({ fields, onSearch }: { fields: Field[]; onSearch: (values: Record<string, string>) => void }): React.ReactElement {
  return <div className="wb-search"><Editor title="筛选 / 查询" fields={fields} busy={false} submit={async (values) => onSearch(values)} button="查询本地记录" /></div>;
}

type Shared = { projectId: string; view: MemoryView; conversationId: string; revision: string; busy: boolean; stage: (work: () => Promise<MemoryProposal>) => Promise<void>; run: (work: () => Promise<unknown>, success: string) => Promise<void> };
const baseFields = (prefix: string): Field[] => [
  { name: 'recordId', label: '记录 ID（新建可留空）', hint: `留空创建独立${prefix}；填写已有 ID 则基于当前正式 revision 提案。` },
  { name: 'title', label: `${prefix}标题`, required: true }, { name: 'reason', label: '变更理由', required: true },
];
async function propose(shared: Shared, values: Record<string, string>, key: string, kind: MemoryKind, content: object): Promise<void> {
  if (!shared.conversationId) throw new Error('先选择本项目来源对话。');
  const recordId = values.recordId?.trim() || `${kind}-${key}`;
  const current = shared.view.records.find((record) => record.id === recordId);
  await shared.stage(() => api.submitMemoryProposal(shared.projectId, {
    conversationId: shared.conversationId, recordId, kind, title: values.title!, operation: 'upsert',
    content: serializeMemoryForm(content), baseRevision: current?.revision ?? 0, reason: values.reason!, idempotencyKey: key,
  }));
}

function ArchivePane(shared: Shared): React.ReactElement {
  const [filters, setFilters] = useState<Record<string, string>>({}); const [offset, setOffset] = useState(0);
  const query = useLocal<ArchivePage>(`${shared.projectId}/archive/${shared.revision}/${JSON.stringify(filters)}/${offset}`, (signal) => api.getMemoryArchive(shared.projectId, { recordId: filters.recordId, from: filters.from, to: filters.to, revision: filters.revision ? Number(filters.revision) : undefined, limit: 20, offset }, signal));
  return <><p className="hint">只追加归档；这里没有编辑或删除入口。日期按 UTC 日界限查询，ISO 时间可明确指定时区。</p>
    <SearchForm fields={[{ name: 'recordId', label: '归档记录 ID' }, { name: 'from', label: '归档起始日期', kind: 'date' }, { name: 'to', label: '归档结束日期', kind: 'date' }, { name: 'revision', label: '归档记录版本（record revision）', kind: 'number' }]} onSearch={(values) => { setFilters(values); setOffset(0); }} />
    <ReadState query={query} />{query.data && <><p className="memory-meta">共 {query.data.total} 次变更 · 当前 {query.data.offset + 1}–{query.data.offset + query.data.entries.length}</p>
      {query.data.entries.length === 0 && <Empty />}{query.data.entries.map((entry) => <details className="wb-card" key={entry.id}><summary>{entry.after.title} · {time(entry.createdAt)} · r{entry.after.revision}</summary><p className="memory-meta">{entry.recordId} · 项目 r{entry.projectRevision} · 来源 {entry.sourceId}</p>
        <Snapshot projectId={shared.projectId} id={entry.id} side="before" /><Snapshot projectId={shared.projectId} id={entry.id} side="after" />
      </details>)}<div className="wb-actions"><button type="button" className="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><button type="button" className="small" disabled={offset + query.data.entries.length >= query.data.total} onClick={() => setOffset(offset + 20)}>下一页</button></div></>}
  </>;
}
function Snapshot({ projectId, id, side }: { projectId: string; id: string; side: 'before' | 'after' }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const query = useLocal(`${projectId}/snapshot/${id}/${side}`, (signal) => api.getMemoryArchiveSnapshot(projectId, id, side, signal), open);
  return <details className="wb-card" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{side === 'before' ? '变更前完整版本' : '变更后完整版本'}</summary><ReadState query={query} />{query.data && <><FullRecord record={query.data.snapshot} /><pre className="wb-verbatim" aria-label={`${side} 完整原文`}>{query.data.snapshot?.content ?? '（不存在）'}</pre></>}</details>;
}
function GoalsPane(shared: Shared): React.ReactElement {
  const query = useLocal<GoalTree>(`${shared.projectId}/goals/${shared.revision}`, (signal) => api.getMemoryGoals(shared.projectId, signal));
  return <><ReadState query={query} />{query.data && <><Issues issues={query.data.issues} />{query.data.nodes.length === 0 && <Empty>没有目标卡，先提交根目标提案。</Empty>}
    {query.data.nodes.map((node) => <details className="wb-card wb-goal" key={node.record.id} style={{ marginInlineStart: Math.min(node.depth ?? 0, 6) * 10 }}><summary>{node.depth === null ? '⚠ 未定层级' : `层 ${node.depth}`} · {node.record.title} · {GOAL_STATE[node.data?.state ?? ''] ?? '非结构化'}</summary>
      <p className="memory-meta">{node.record.id} · 父 {node.data?.parentId ?? '无'} · 权重 {node.weight.toFixed(2)}</p><MemoryRecordBody record={node.record} />
    </details>)}</>}
    <Editor title="新建 / 更新目标提案" busy={shared.busy} fields={[...baseFields('目标'), { name: 'parentId', label: '父目标 ID（根目标留空）' }, { name: 'state', label: '目标状态', kind: 'select', value: 'active', options: Object.entries(GOAL_STATE) }, { name: 'body', label: '目标说明', kind: 'textarea' }, { name: 'keyResults', label: '关键结果（每行一条）', kind: 'textarea' }, { name: 'lessons', label: '路径教训（每行一条）', kind: 'textarea' }]} submit={(values, key) => propose(shared, values, key, 'goal', { parentId: values.parentId || null, state: values.state, body: values.body, keyResults: lines(values.keyResults), lessons: lines(values.lessons) })} />
  </>;
}
function LessonsPane(shared: Shared): React.ReactElement {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const query = useLocal<LessonSearch>(`${shared.projectId}/lessons/${shared.revision}/${JSON.stringify(filters)}`, (signal) => api.getMemoryLessons(shared.projectId, { type: filters.type === 'lesson' || filters.type === 'experience' ? filters.type : undefined, category: filters.category, q: filters.q }, signal));
  return <><SearchForm fields={[{ name: 'type', label: '教训或经验', kind: 'select', options: [['', '全部'], ['lesson', '教训'], ['experience', '经验']] }, { name: 'category', label: '分类（尺子错 / 机制等）' }, { name: 'q', label: '正文关键词' }]} onSearch={setFilters} /><ReadState query={query} />
    {query.data && <><Issues issues={query.data.issues} />{query.data.entries.length === 0 && <Empty />}{query.data.entries.map((entry) => <details className="wb-card" key={entry.record.id}><summary>{entry.record.title} · {entry.data?.type === 'experience' ? '经验' : '教训'} · {entry.data?.category ?? '待结构化'}</summary><Markdown text={entry.rendered} /><Issues issues={entry.issues} /></details>)}</>}
    <Editor title="新建 / 更新教训经验提案" busy={shared.busy} fields={[...baseFields('条目'), { name: 'type', label: '条目类型', kind: 'select', value: 'lesson', options: [['lesson', '教训：别再这样'], ['experience', '经验：机制知识']] }, { name: 'category', label: '条目分类', required: true, hint: '教训：尺子错/夹具错/守卫错/假设错/记录错/其他；经验：机制/入口/约定/速查/其他' }, { name: 'body', label: '完整条目正文', kind: 'textarea', required: true }, { name: 'symptom', label: '现象', kind: 'textarea' }, { name: 'rootCause', label: '根因（教训必填）', kind: 'textarea' }, { name: 'source', label: '出处（经验必填）', hint: '文件:行号、探针路径或可复核的实测命令。' }, { name: 'fix', label: '正确做法 / 修改入口', kind: 'textarea', required: true }, { name: 'scope', label: '适用范围' }]} submit={async (values, key) => {
      if (values.type === 'lesson' && !values.rootCause?.trim()) throw new Error('教训缺根因；请补填后再提交。');
      if (values.type === 'experience' && !values.source?.trim()) throw new Error('经验缺出处；请补填可复核的证据。');
      await propose(shared, values, key, 'lesson', { type: values.type, category: values.category, body: values.body, symptom: values.symptom, rootCause: values.rootCause, source: values.source, fix: values.fix, scope: values.scope });
    }} />
  </>;
}
function NotesPane(shared: Shared): React.ReactElement {
  const [q, setQ] = useState('');
  const records = shared.view.records.filter((record) => !record.deleted && record.kind === 'note' && !record.id.startsWith('artifact:') && !objectContent(record.content)?.$memory && `${record.title}\n${record.content}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
  return <><label className="wb-field">笔记全文搜索<input aria-label="笔记全文搜索" value={q} onChange={(event) => setQ(event.target.value)} /></label>{records.length === 0 && <Empty />}{records.map((record) => <details key={record.id} className="wb-card"><summary>{record.title} · r{record.revision}</summary><MemoryRecordBody record={record} />{typeof objectContent(record.content)?.documentName === 'string' && <a href={api.memoryNoteDownloadUrl(shared.projectId, record.id)} download>下载笔记：{String(objectContent(record.content)?.documentName)}（独立副本）</a>}</details>)}
    <Editor title="新建 / 更新结构化笔记提案" busy={shared.busy} fields={[...baseFields('笔记'), { name: 'type', label: '笔记类型', kind: 'select', value: 'problem', options: [['problem', '问题'], ['research', '调研'], ['other', '其他']] }, { name: 'body', label: '笔记正文', kind: 'textarea', required: true }, { name: 'rootCause', label: '问题根因（问题类必填）', kind: 'textarea' }, { name: 'conclusion', label: '调研结论（调研类必填）', kind: 'textarea' }]} submit={async (values, key) => {
      if (values.type === 'problem' && !values.rootCause?.trim()) throw new Error('问题笔记缺根因。');
      if (values.type === 'research' && !values.conclusion?.trim()) throw new Error('调研笔记缺结论。');
      const content: NoteContent = { type: values.type as NoteContent['type'], body: values.body!, rootCause: values.rootCause, conclusion: values.conclusion };
      await propose(shared, values, key, 'note', content);
    }} /><p className="hint">日期标题文档名由服务端生成且不覆盖已有记录；此处提交后仍须独立接受。</p>
  </>;
}
function PreservedPane(shared: Shared & { onCount: (count: number) => void }): React.ReactElement {
  const [includeResolved, setIncludeResolved] = useState(false); const [selected, setSelected] = useState<string[]>([]);
  const query = useLocal<PreservedView>(`${shared.projectId}/preserved/${shared.revision}/${includeResolved}`, (signal) => api.getMemoryPreserved(shared.projectId, includeResolved, signal));
  useEffect(() => { if (query.data && !includeResolved) shared.onCount(query.data.entries.length); }, [query.data, includeResolved]);
  return <><p className="hint">A 是其他会话已写入的正式内容，B 是旧基线提案；重新合并只产生待审提案，不直接覆盖任何一方。</p><label className="wb-check"><input type="checkbox" checked={includeResolved} onChange={(event) => { setIncludeResolved(event.target.checked); setSelected([]); }} />包含已合并历史</label><ReadState query={query} />
    {query.data && <>{query.data.entries.length === 0 && <Empty />}{query.data.entries.map((entry) => <details key={entry.id} className="wb-card"><summary>{entry.current.title} · {time(entry.createdAt)} · {entry.resolution ? '已合并' : '待合并'}</summary>
      {!entry.resolution && <label className="wb-check"><input type="checkbox" aria-label={`选择保留条目 ${entry.id}`} checked={selected.includes(entry.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id))} />纳入重合并</label>}
      <p className="memory-meta">{entry.recordId} · 来源 {entry.sourceConversationIds.join('、')} · {entry.sourceId ?? entry.proposal.conversationId}</p><h4>A · 当前正式完整版本</h4><FullRecord record={entry.current} /><h4>B · 后到提案完整版本</h4><pre className="wb-verbatim">{entry.proposal.content}</pre><p>理由：{entry.proposal.reason}</p>
    </details>)}</>}
    <Editor title="重新合并为新提案" busy={shared.busy} fields={[{ name: 'recordId', label: '合并记录 ID', required: true }, { name: 'title', label: '合并标题', required: true }, { name: 'content', label: '合并后的完整正文', kind: 'textarea', required: true }, { name: 'reason', label: '如何保留双方进展', kind: 'textarea', required: true }]} submit={async (values, key) => {
      if (!selected.length) throw new Error('先选择至少一条未合并保留记录。');
      if (!shared.conversationId) throw new Error('请先选择来源对话。');
      await shared.stage(() => api.mergeMemoryPreserved(shared.projectId, { preservedIds: selected, conversationId: shared.conversationId, recordId: values.recordId!, title: values.title!, content: values.content!, reason: values.reason!, idempotencyKey: key }));
    }} />
  </>;
}
function IndexPane(shared: Shared): React.ReactElement {
  const query = useLocal<MemoryIndex>(`${shared.projectId}/index/${shared.revision}`, (signal) => api.getMemoryIndex(shared.projectId, signal));
  return <><p className="wb-warning">诊断排序只供阅读参考，不决定注入或是否阅读；表格只读，不是决策依据。</p><ReadState query={query} />{query.data && <div className="wb-table"><table><thead><tr><th>记录</th><th>分数</th><th>重要</th><th>时效</th><th>稳定</th><th>引用</th><th>体量</th></tr></thead><tbody>{query.data.rows.map((row) => <tr key={row.recordId}><td>{row.title}<small>{row.kind} · {row.recordId}</small></td><td>{row.score.toFixed(3)}</td>{Object.values(row.ranks).map((rank, index) => <td key={index}>{rank}</td>)}</tr>)}</tbody></table>{query.data.rows.length === 0 && <Empty />}</div>}</>;
}

const HANDOFF_FIELDS: Field[] = [
  { name: 'title', label: '交接标题', required: true }, { name: 'did', label: '做了什么', kind: 'textarea', required: true },
  { name: 'state', label: '当前状态（可用 / 不可用 / 半完成）', kind: 'textarea', required: true }, { name: 'next', label: '下一步', kind: 'textarea', required: true },
  { name: 'files', label: '关键文件绝对路径（每行一个）', kind: 'textarea', required: true }, { name: 'blocked', label: '阻塞与待决策', kind: 'textarea', required: true },
];
function handoffPayload(values: Record<string, string>): Omit<Handoff, '$memory' | 'id' | 'recordId' | 'sourceId' | 'createdAt'> {
  const files = lines(values.files);
  if (files.some((path) => !/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path))) throw new Error('交接文件必须是绝对路径。');
  return { title: values.title!, did: values.did!, state: values.state!, next: values.next!, files, blocked: values.blocked! };
}
async function artifact(shared: Shared, type: ArtifactInput['type'], payload: ArtifactInput['payload'], key: string): Promise<void> {
  if (!shared.conversationId) throw new Error('先选择来源对话。');
  await shared.stage(() => api.submitMemoryArtifact(shared.projectId, { conversationId: shared.conversationId, idempotencyKey: key, type, payload } as ArtifactInput));
}
function TriagePane(shared: Shared): React.ReactElement {
  const [q, setQ] = useState(''); const [search, setSearch] = useState('');
  const query = useLocal<TriageView>(`${shared.projectId}/triage/${shared.revision}/${search}`, (signal) => api.getMemoryTriage(shared.projectId, search, signal));
  return <><form className="wb-inline" onSubmit={(event) => { event.preventDefault(); setSearch(q); }}><input aria-label="检索 stash 全文" placeholder="检索 stash 全文" value={q} onChange={(event) => setQ(event.target.value)} /><button type="submit" className="small">检索</button></form><ReadState query={query} />
    {query.data && (['keep', 'stash', 'drop'] as const).map((bucket) => <details className="wb-card" key={bucket} open={bucket === 'keep'}><summary>{bucket} · {query.data![bucket].length} 条</summary><p className="hint">{bucket === 'keep' ? '下一轮必须原样可用；压缩后仍可取回。' : bucket === 'stash' ? '全文可查，不进注入。' : '被替代事项的审计记录，不静默删除。'}</p>{query.data![bucket].length === 0 && <Empty />}{query.data![bucket].map((entry) => <article key={entry.id} className="wb-entry"><pre className="wb-verbatim">{entry.what}</pre>{entry.why && <p>原因：{entry.why}</p>}{entry.where && <p>位置：{entry.where}</p>}<small>{entry.id} · 来源 {entry.sourceId} · {time(entry.createdAt)}</small></article>)}</details>)}
    <Editor title="提交三桶分流提案" busy={shared.busy} fields={[{ name: 'keep', label: 'keep（每行一条）', kind: 'textarea' }, { name: 'stash', label: 'stash（每行一条）', kind: 'textarea' }, { name: 'drop', label: 'drop（每行一条）', kind: 'textarea' }, { name: 'releaseKeepIds', label: '解除 keep 的条目 ID（每行一个）', kind: 'textarea' }]} submit={(values, key) => artifact(shared, 'triage', { keep: lines(values.keep).map((what) => ({ what })), stash: lines(values.stash).map((what) => ({ what })), drop: lines(values.drop).map((what) => ({ what })), releaseKeepIds: lines(values.releaseKeepIds) }, key)} />
  </>;
}
function HandoffsPane(shared: Shared): React.ReactElement {
  const query = useLocal(`${shared.projectId}/handoffs/${shared.revision}`, (signal) => api.getMemoryWorkbench(shared.projectId, signal));
  return <><p className="hint">交接内容直接在看板阅读。每份独立保留；下载同名由浏览器另存，不覆盖数据库历史。</p><ReadState query={query} />{query.data && <>{query.data.handoffs.length === 0 && <Empty />}{query.data.handoffs.map((handoff) => <details className="wb-card" key={handoff.id}><summary>{handoff.title} · {time(handoff.createdAt)}</summary><HandoffBody handoff={handoff} /><a href={api.memoryHandoffDownloadUrl(shared.projectId, handoff.id)} download>下载此份交接 Markdown（不覆盖旧份）</a></details>)}</>}
    <Editor title="新建交接提案" fields={HANDOFF_FIELDS} busy={shared.busy} submit={(values, key) => artifact(shared, 'handoff', handoffPayload(values), key)} />
  </>;
}
function HandoffBody({ handoff }: { handoff: Pick<Handoff, 'did' | 'state' | 'next' | 'files' | 'blocked'> }): React.ReactElement {
  return <div className="wb-record-fields">{[['做了什么', handoff.did], ['当前状态', handoff.state], ['下一步', handoff.next], ['关键文件路径', handoff.files.join('\n')], ['阻塞与待决策', handoff.blocked]].map(([label, text]) => <section key={label}><strong>{label}</strong><Markdown text={text!} /></section>)}</div>;
}

function PrinciplesPane(shared: Shared): React.ReactElement {
  const current = useLocal<PrincipleCurrent>(`${shared.projectId}/principles/current/${shared.revision}`, (signal) => api.getMemoryPrinciples(shared.projectId, signal));
  const pending = useLocal<PrincipleProposal[]>(`${shared.projectId}/principles/pending/${shared.revision}`, (signal) => api.getMemoryPrincipleProposals(shared.projectId, signal));
  const [decision, setDecision] = useState<{ proposal: PrincipleProposal; operation: 'approve' | 'reject' } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  return <><p className="wb-warning">原则仅能由人明确批准。AI 只能提议；这里不会预取审批授权，也不会把授权交给模型。</p>
    <ReadState query={current} />{current.data && <><details className="wb-card" open><summary>当前原则全文（已批准）</summary>{current.data.text ? <Markdown text={current.data.text} /> : <Empty>尚无已批准原则。</Empty>}</details>
      <details className="wb-card"><summary>人工审批留痕 · {current.data.approvals.length}</summary>{current.data.approvals.map((audit) => <p key={audit.id}>{audit.operation === 'approve' ? '批准' : '驳回'} · {audit.actor} · {time(audit.createdAt)}<br />{audit.summary}</p>)}</details></>}
    <ReadState query={pending} />{pending.data && <><h4>待批准提议 · {pending.data.length}</h4>{pending.data.length === 0 && <Empty />}{pending.data.map((proposal) => <details key={proposal.id} className="wb-card"><summary>{proposal.title} · {proposal.operation === 'delete' ? '删除提议' : '写入提议'} · base r{proposal.baseRevision}</summary><Markdown text={proposal.content} />{proposal.review && <details className="wb-principle-review"><summary>程序预检 · {proposal.review.status === 'ready' ? '可交人审（未批准）' : '有事项待核对'}</summary><p>{proposal.review.summary}</p><p className="hint">基于当前 r{proposal.review.currentRevision}。预检不是语义批准；暂不批准不影响当前任务。</p>{proposal.review.checks.map((check) => <p key={check.code}><strong>{check.status === 'pass' ? '通过' : check.status === 'warning' ? '需注意' : '由人判断'}</strong> · {check.message}</p>)}</details>}<p className="memory-meta">{proposal.id} · {time(proposal.createdAt)}</p><div className="wb-actions">
      <button type="button" className="small" disabled={shared.busy} onClick={() => { setDecision({ proposal, operation: 'approve' }); setConfirmed(false); }}>审阅并批准</button>
      <button type="button" className="small" disabled={shared.busy} onClick={() => { setDecision({ proposal, operation: 'reject' }); setConfirmed(false); }}>审阅并驳回</button>
    </div></details>)}</>}
    {decision && <section className="wb-confirm" aria-label="人工原则审批确认"><strong>确认{decision.operation === 'approve' ? '批准' : '驳回'}：{decision.proposal.title}</strong><p>记录 {decision.proposal.recordId} · 基线 r{decision.proposal.baseRevision}</p><pre className="wb-verbatim">{decision.proposal.content}</pre>
      <label className="wb-check"><input aria-label="我确认以用户身份审批原则" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已阅读，确认以用户身份执行本次审批</label>
      <div className="wb-actions"><button type="button" className="small" disabled={shared.busy || !confirmed} onClick={() => {
        const selected = decision;
        void shared.run(() => api.decideMemoryPrinciple(shared.projectId, selected.proposal.id, selected.operation), '人工审批已完成并留痕。').then(() => setDecision(null)).catch(() => {});
      }}>确认{decision.operation === 'approve' ? '批准' : '驳回'}原则</button><button type="button" className="small" onClick={() => setDecision(null)}>取消</button></div></section>}
    <Editor title="提出原则变更（尚未批准）" busy={shared.busy} fields={[...baseFields('原则'), { name: 'operation', label: '原则操作', kind: 'select', value: 'upsert', options: [['upsert', '新增 / 修改'], ['delete', '删除（仍需人工批准）']] }, { name: 'content', label: '原则全文或删除说明', kind: 'textarea', required: true }]} submit={async (values, key) => {
      const recordId = values.recordId || `principle-${key}`;
      await shared.run(() => api.proposeMemoryPrinciple(shared.projectId, { recordId, title: values.title!, content: values.content!, operation: values.operation === 'delete' ? 'delete' : 'upsert', baseRevision: shared.view.records.find((record) => record.id === recordId)?.revision ?? 0 }), '原则提议已暂存，尚未批准、未生效；请在上方独立审批。');
    }} />
  </>;
}
function LogsPane(shared: Shared & { conversations: ConversationDto[] }): React.ReactElement {
  const [filters, setFilters] = useState<Record<string, string>>({}); const [mode, setMode] = useState<'intents' | 'users'>('intents');
  const params = { conversationId: filters.conversationId, q: filters.q, from: filters.from ? `${filters.from}T00:00:00.000Z` : undefined, to: filters.to ? `${filters.to}T23:59:59.999Z` : undefined, limit: 200 };
  const intents = useLocal<IntentEntry[]>(`${shared.projectId}/intents/${shared.revision}/${JSON.stringify(params)}`, (signal) => api.getMemoryIntentLogs(shared.projectId, params, signal), mode === 'intents');
  const quotes = useLocal<UserQuoteGroup[]>(`${shared.projectId}/users/${shared.revision}/${JSON.stringify(params)}`, (signal) => api.getMemoryUserQuotes(shared.projectId, params, signal), mode === 'users');
  return <><div className="wb-actions"><button type="button" className={`small ${mode === 'intents' ? 'primary' : ''}`} onClick={() => setMode('intents')}>意图摘要</button><button type="button" className={`small ${mode === 'users' ? 'primary' : ''}`} onClick={() => setMode('users')}>用户原话（按会话）</button></div>
    <SearchForm fields={[{ name: 'conversationId', label: '日志来源会话', kind: 'select', options: [['', '本项目全部会话'], ...shared.conversations.filter((item) => item.projectId === shared.projectId).map((item): [string, string] => [item.id, item.title ?? item.id])] }, { name: 'from', label: '日志起始日期（UTC）', kind: 'date' }, { name: 'to', label: '日志结束日期（UTC）', kind: 'date' }, { name: 'q', label: '日志全文关键词' }]} onSearch={setFilters} />
    <p className="hint">按需查询，不进注入。已有意图与用户原话属于追加历史，不提供覆写；更正请追加说明。最多显示 200 条，更多请缩小日期/会话范围。</p><ReadState query={mode === 'intents' ? intents : quotes} />
    {mode === 'intents' && intents.data && <>{intents.data.length === 0 && <Empty />}{intents.data.map((entry) => <details className="wb-card" key={entry.id}><summary>{time(entry.createdAt)} · {entry.goal}</summary><p className="memory-meta">会话 {entry.conversationId} · 来源 {entry.sourceId}</p><HandoffBody handoff={{ did: entry.did, state: entry.issues || '无记录问题', next: entry.next, files: [], blocked: entry.issues }} /></details>)}</>}
    {mode === 'users' && quotes.data && <>{quotes.data.length === 0 && <Empty />}{quotes.data.map((group) => <details className="wb-card" key={group.conversationId} open><summary>{shared.conversations.find((item) => item.id === group.conversationId)?.title ?? group.conversationId} · {group.messages.length} 条</summary>{group.messages.map((quote) => <article className="wb-entry" key={quote.messageId}><small>seq {quote.seq} · {time(quote.createdAt)}</small><pre className="wb-verbatim">{quote.content}</pre></article>)}</details>)}</>}
    <Editor title="追加日志 / 更正说明（新提案）" busy={shared.busy} fields={[{ name: 'goal', label: '本轮目标', required: true }, { name: 'did', label: '实际做了什么', kind: 'textarea', required: true }, { name: 'issues', label: '卡点 / 不确定', kind: 'textarea' }, { name: 'next', label: '下一步行动', kind: 'textarea', required: true }]} submit={(values, key) => artifact(shared, 'intent', { conversationId: shared.conversationId, goal: values.goal!, did: values.did!, issues: values.issues!, next: values.next! }, key)} />
  </>;
}
function ExtensionsPane(shared: Shared): React.ReactElement {
  const query = useLocal(`${shared.projectId}/extensions/${shared.revision}`, (signal) => api.getMemoryWorkbench(shared.projectId, signal));
  const [id, setId] = useState('');
  const definition = query.data?.extensions.find((item) => item.id === id);
  return <><p className="hint">扩展只属于当前项目，不替代内置记忆。定义由用户新建；条目写入仍先暂存再接受。</p><ReadState query={query} />{query.data && <><label className="wb-field">选择项目扩展<select aria-label="选择项目扩展" value={id} onChange={(event) => setId(event.target.value)}><option value="">选择扩展以读取条目</option>{query.data.extensions.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.entryCount} 条{item.appendOnly ? ' · 只追加' : ''}</option>)}</select></label>{query.data.extensions.length === 0 && <Empty>项目尚未定义扩展。</Empty>}</>}
    {definition && <ExtensionEntries key={definition.id} {...shared} definition={definition} />}
    <Editor title="用户新建扩展定义" busy={shared.busy} fields={[{ name: 'name', label: '扩展名称', required: true }, { name: 'description', label: '扩展用途说明', kind: 'textarea', required: true }, { name: 'mode', label: '存储形态', kind: 'select', value: 'cards', options: [['cards', '一卡一条（卡片型）'], ['single', '单份内容']] }, { name: 'appendOnly', label: '只追加，不允许覆盖或删除', kind: 'checkbox', value: 'true' }]} submit={(values) => shared.run(() => api.createMemoryExtension(shared.projectId, { name: values.name!, description: values.description!, mode: values.mode === 'single' ? 'single' : 'cards', appendOnly: values.appendOnly === 'true' }), '用户扩展定义已创建；尚无内容，请选中后提交条目提案。')} button="确认新建扩展定义" />
  </>;
}
function ExtensionEntries(shared: Shared & { definition: ExtensionDefinition }): React.ReactElement {
  const [q, setQ] = useState(''); const [search, setSearch] = useState(''); const { definition } = shared;
  const query = useLocal<ExtensionEntry[]>(`${shared.projectId}/extension/${definition.id}/${shared.revision}/${search}`, (signal) => api.getMemoryExtensionEntries(shared.projectId, definition.id, search, signal));
  return <><div className="wb-card"><strong>{definition.name}</strong><p>{definition.description}</p><p className="memory-meta">{definition.mode === 'single' ? '单份内容' : '卡片型'} · {definition.appendOnly ? '只追加' : '可提案覆盖'} · 数据库位置 {definition.location}</p></div>
    <form className="wb-inline" onSubmit={(event) => { event.preventDefault(); setSearch(q); }}><input aria-label="扩展条目全文搜索" value={q} onChange={(event) => setQ(event.target.value)} /><button className="small" type="submit">搜索条目</button></form><ReadState query={query} />
    {query.data && <>{query.data.length === 0 && <Empty />}{query.data.map((entry) => <details key={entry.id} className="wb-card"><summary>{entry.key} · {entry.action} · {time(entry.createdAt)}</summary><Markdown text={entry.content} /><p className="memory-meta">来源 {entry.sourceId}</p></details>)}</>}
    <Editor title="提交扩展条目提案" busy={shared.busy} fields={[...(definition.mode === 'cards' ? [{ name: 'key', label: '条目键', required: true } satisfies Field] : []), { name: 'action', label: '条目操作', kind: 'select', value: 'append', options: definition.appendOnly ? [['append', '追加']] : [['append', '追加'], ['replace', '覆盖'], ['delete', '删除']] }, { name: 'content', label: '条目正文', kind: 'textarea', required: true }]} submit={(values, key) => artifact(shared, 'extension-entry', { extensionId: definition.id, key: definition.mode === 'single' ? 'main' : values.key!, action: definition.appendOnly ? 'append' : values.action as ExtensionEntry['action'], content: values.content! }, key)} />
  </>;
}
function CapsulesPane(shared: Shared): React.ReactElement {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const query = useLocal<{ capsules: MemoryCapsule[] }>(`${shared.projectId}/capsules/${shared.revision}/${shared.conversationId}/${JSON.stringify(filters)}`, (signal) => api.getMemoryCapsules(shared.projectId, { conversationId: shared.conversationId || undefined, capsuleId: filters.capsuleId, fromSeq: filters.fromSeq ? Number(filters.fromSeq) : undefined, toSeq: filters.toSeq ? Number(filters.toSeq) : undefined }, signal), !!shared.conversationId);
  return <>{!shared.conversationId && <Empty>请先选择一个本项目来源对话以查询胶囊。</Empty>}<p className="hint">压缩前逐字胶囊：用户原话、报错原文及改动文件。保护字段以服务端标记为准，不编造缺失原文。</p><SearchForm fields={[{ name: 'capsuleId', label: '胶囊 ID' }, { name: 'fromSeq', label: '起始 seq', kind: 'number' }, { name: 'toSeq', label: '结束 seq', kind: 'number' }]} onSearch={setFilters} /><ReadState query={query} />
    {query.data && <>{query.data.capsules.length === 0 && <Empty>尚无压缩胶囊。</Empty>}{query.data.capsules.map((capsule) => <details className="wb-card" key={capsule.id}><summary>seq {capsule.fromSeq}–{capsule.toSeq} · {time(capsule.createdAt)}</summary><p className="memory-meta">会话 {capsule.conversationId} · 胶囊 {capsule.capsuleId}</p><p>{capsule.coverage}</p>{([['用户原话', capsule.users], ['报错原文', capsule.errors]] as const).map(([label, entries]) => <section key={label}><h4>{label}</h4>{entries.map((entry) => <article key={`${entry.messageId}-${entry.seq}`} className="wb-entry"><small>seq {entry.seq}{entry.protected ? ' · 受保护' : ''}</small><pre className="wb-verbatim">{entry.text ?? entry.notice ?? '此原文不可用'}</pre></article>)}</section>)}<h4>改动文件清单</h4>{capsule.files.map((file, index) => <p className="memory-meta" key={index}>seq {file.seq} · {file.tool} · {file.path}</p>)}</details>)}</>}
  </>;
}
function MaterialPane(shared: Shared): React.ReactElement {
  const query = useLocal<MaterialMapDto>(`${shared.projectId}/map/${shared.revision}/${shared.conversationId}`, (signal) => api.getMemoryMaterialMap(shared.projectId, shared.conversationId, signal), !!shared.conversationId);
  return <><p className="hint">阅读状态属于所选来源对话；排序仅建议，未读材料不会因为排名较低而消失。</p>{!shared.conversationId && <Empty>先选择一个来源对话。</Empty>}<ReadState query={query} />{query.data && <><p>{query.data.coverage}</p>{query.data.materials.length === 0 && <Empty />}{query.data.materials.map((material) => <details className="wb-card" key={material.recordId}><summary>{material.read ? '已读' : '● 未读'} · {material.suggestedOrder} · {material.title}</summary><p className="memory-meta">{material.kind} · r{material.revision} · {material.chars} 字符</p><p className="memory-meta">{material.location}</p><FullRecord record={shared.view.records.find((record) => record.id === material.recordId) ?? null} /></details>)}</>}</>;
}

const COMPACTION_LOG_LABEL: Record<CompactionEventCode, string> = {
  COMPACTION_BLOCKED_DUTIES: '三项收尾未齐，未发送压缩请求', COMPACTION_BLOCKED_NO_PROJECT: '未绑定项目，未压缩',
  COMPACTION_BLOCKED_SUBAGENT: '子代理不执行主对话压缩', COMPACTION_BLOCKED_NO_CHECKPOINT: '尚无安全收尾边界，未压缩',
  COMPACTION_BLOCKED_NO_CANDIDATE: '没有满足条件的较早区间', COMPACTION_BLOCKED_INPUT_LIMIT: '输入区间超出预算，未请求模型',
  COMPACTION_BLOCKED_BUSY: '已有压缩进行中，未重复发起', COMPACTION_BLOCKED_AUTO_DUPLICATE: '本轮已检查，不重复自动发起',
  COMPACTION_BLOCKED_UNAVAILABLE: '压缩条件暂不可用', COMPACTION_STARTED: '开始压缩', COMPACTION_SUCCEEDED: '压缩已成功提交',
  COMPACTION_CANCELLED: '压缩已取消，未提交旧结果', COMPACTION_TIMEOUT: '压缩超时，未自动重试',
  COMPACTION_CHANGED: '区间或会话已变化，未应用旧结果', COMPACTION_SUMMARY_FAILED: '摘要校验失败，未压缩',
  COMPACTION_OUTPUT_LIMIT: '摘要超过输出上限，未应用', COMPACTION_CAPSULE_FAILED: '原文胶囊未保存，未提交压缩',
  COMPACTION_PROVIDER_FAILED: '模型请求失败，未自动重试', COMPACTION_COMMIT_FAILED: '压缩提交失败',
  COMPACTION_PERSISTENCE_FAILED: '压缩持久化未完成', COMPACTION_LEASE_EXPIRED: '上次压缩租约已过期',
};
const COMPACTION_SOURCE_LABEL = { auto: '自动', manual: '手动', checkpoint: '检查点' } as const;
function compactionLogLabel(code: string): string {
  return Object.hasOwn(COMPACTION_LOG_LABEL, code) ? COMPACTION_LOG_LABEL[code as CompactionEventCode] : '未知压缩诊断，原始错误不在界面显示';
}
export function ConversationCompactionLog({ conversationId, refreshKey = 0 }: { conversationId: string; refreshKey?: number }): React.ReactElement {
  return <CompactionPane key={conversationId} conversationId={conversationId} revision={String(refreshKey)} />;
}
function CompactionPane(shared: Pick<Shared, 'conversationId' | 'revision'>): React.ReactElement {
  const [clock, setClock] = useState(0); const [offset, setOffset] = useState(0);
  const [recallRange, setRecallRange] = useState<{ fromSeq?: number; toSeq?: number } | null>(null);
  useEffect(() => { const timer = setInterval(() => setClock((value) => value + 1), 10000); return () => clearInterval(timer); }, []);
  const current = useLocal<CompactionStatusDto>(`${shared.conversationId}/compaction-status/${shared.revision}/${clock}`, (signal) => api.getCompactionStatus(shared.conversationId, signal), !!shared.conversationId, `${shared.conversationId}/compaction-status`);
  const events = useLocal<CompactionEventPage>(`${shared.conversationId}/compaction-events/${shared.revision}/${clock}/${offset}`, (signal) => api.getCompactionEvents(shared.conversationId, { limit: 20, offset }, signal), !!shared.conversationId, `${shared.conversationId}/compaction-events/${offset}`);
  if (!shared.conversationId) return <Empty>先选择来源主对话，查看其上下文压缩与原文。</Empty>;
  function showOriginal(event: CompactionEvent): void {
    setRecallRange(event.fromSeq !== null && event.toSeq !== null ? { fromSeq: event.fromSeq, toSeq: event.toSeq } : {});
  }
  return <><p className="hint">自动与手动使用同一道门：台账更新、进展日志、triage 三项分别成功后才可能压缩。缺项不发压缩模型请求，也不阻止继续工作。</p>
    <ReadState query={current} />{current.data && <section className="wb-compaction-state" aria-label="上下文压缩当前状态">
      <strong>自动压缩{current.data.settings.enabled ? '已开启' : '已关闭'} · 水位线 {current.data.settings.thresholdPercent}%{current.data.running ? ' · 正在压缩' : ''}</strong>
      <p>当前上下文 {(current.data.ratio * 100).toFixed(1)}%。默认 80% 水位线不是项目的 5% 台账整理间隔；在“设置 → 通用”调整。</p>
      <div className="wb-compaction-duties">{(['ledger', 'log', 'triage'] as const).map((kind) => <span key={kind}>{COMPACTION_DUTY_LABEL[kind]} · {current.data!.duties.missing.includes(kind) ? '待补齐' : current.data!.duties.complete ? '已取得收条' : '待核对 / 更新'}</span>)}</div>
      {!current.data.duties.complete && <p className="wb-warning">{current.data.duties.reason === 'stale' ? '收尾后出现了新业务，三项证据需要更新。' : `尚缺：${current.data.duties.missing.map((kind) => COMPACTION_DUTY_LABEL[kind]).join('、') || '本主对话有效的三项独立收条'}。`}本次不旁路，可以继续当前工作。</p>}
      {current.data.duties.complete && <p className="hint">三项收条齐备，不代表已经压缩。{current.data.plan.status === 'ready' ? '已具备候选区间，是否成功以日志记录为准。' : '当前没有可提交的压缩计划。'}</p>}
      {current.data.plan.fromSeq !== null && current.data.plan.toSeq !== null && <p className="memory-meta">待检查候选区间 seq {current.data.plan.fromSeq}–{current.data.plan.toSeq}（不是已提交压缩记录）</p>}
    </section>}
    <div className="wb-actions"><button type="button" className="small" onClick={() => setClock((value) => value + 1)}>刷新压缩记录</button><button type="button" className="small" onClick={() => setRecallRange({})}>按需查本对话原文</button></div>
    <ReadState query={events} />{events.data && <><p className="memory-meta">共 {events.data.total} 条压缩记录 · {events.data.entries.length ? events.data.offset + 1 : 0}–{events.data.offset + events.data.entries.length}</p>
      {events.data.entries.length === 0 && <Empty>尚无压缩记录；这里不会为展示而发起压缩。</Empty>}
      {events.data.entries.map((event) => <details className="wb-card" key={event.id}><summary>{COMPACTION_SOURCE_LABEL[event.source]} · {event.phase === 'success' ? '成功' : event.phase === 'start' ? '开始' : event.phase === 'blocked' ? '待条件齐备' : '未完成'} · {time(event.timestamp)}</summary>
        <p>{compactionLogLabel(event.code)}</p><p className="memory-meta">{event.fromSeq === null || event.toSeq === null ? '未产生可定位区间' : `seq ${event.fromSeq}–${event.toSeq}`} · 来源 {COMPACTION_SOURCE_LABEL[event.source]}</p>
        {event.missing.length > 0 && <p>缺项：{event.missing.map((kind) => COMPACTION_DUTY_LABEL[kind]).join('、')}</p>}
        {event.anchorId && <p className="memory-meta">安全边界指针 {event.anchorId}</p>}
        <button type="button" className="small" aria-label={`回读压缩记录 ${event.id} 原文`} onClick={() => showOriginal(event)}>{event.phase === 'success' ? '定位并回读原文' : '查看此次候选原文索引'}</button>
      </details>)}
      <div className="wb-actions"><button type="button" className="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页压缩记录</button><button type="button" className="small" disabled={offset + events.data.entries.length >= events.data.total} onClick={() => setOffset(offset + 20)}>下一页压缩记录</button></div>
    </>}
    {recallRange && <section className="wb-original-browser" aria-label="原文按需回读"><div className="wb-actions"><strong>原文回读</strong><button type="button" className="small" onClick={() => setRecallRange(null)}>关闭原文</button></div><RecallBrowser key={`${shared.conversationId}/${recallRange.fromSeq ?? ''}/${recallRange.toSeq ?? ''}`} conversationId={shared.conversationId} range={recallRange} /></section>}
  </>;
}
function RecallBrowser({ conversationId, range }: { conversationId: string; range: { fromSeq?: number; toSeq?: number } }): React.ReactElement {
  const [offset, setOffset] = useState(0); const [seq, setSeq] = useState<number | null>(null);
  const query = useLocal<RecallIndex>(`${conversationId}/recall-index/${range.fromSeq ?? ''}/${range.toSeq ?? ''}/${offset}`, async (signal) => {
    const result = await api.recallIndex(conversationId, { ...range, offset, limit: 20 }, signal);
    if (result.conversationId !== conversationId) throw new Error('原文响应来源不匹配，已忽略。');
    return result;
  });
  return <><p className="hint">{range.fromSeq !== undefined ? `seq ${range.fromSeq}–${range.toSeq}：` : ''}先取索引，不加载正文；选择一条后才读取 JSON 原文分片。原文包含 reasoning、toolCalls 等完整 MessageRow 字段，不会用摘要冒充。</p><ReadState query={query} />
    {query.data && <>{query.data.entries.length === 0 && <Empty>此区间没有可回读消息。</Empty>}{query.data.entries.map((entry) => <button key={entry.id} type="button" className={`wb-original-entry ${seq === entry.seq ? 'on' : ''}`} aria-label={`选择原文 seq ${entry.seq}`} onClick={() => setSeq(entry.seq)}><span>seq {entry.seq} · {entry.role} · {time(entry.createdAt)}</span><small>{entry.totalChars.toLocaleString()} UTF-16 字符单元</small></button>)}
      <div className="wb-actions"><button type="button" className="small" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 20)); setSeq(null); }}>上一页索引</button><button type="button" className="small" disabled={query.data.offset + query.data.entries.length >= query.data.total} onClick={() => { setOffset(offset + 20); setSeq(null); }}>下一页索引</button></div>
    </>}
    {seq !== null && <RawMessagePages key={`${conversationId}/${seq}`} conversationId={conversationId} seq={seq} />}
  </>;
}
function downloadOriginal(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function RawMessagePages({ conversationId, seq }: { conversationId: string; seq: number }): React.ReactElement {
  const [offsets, setOffsets] = useState([0]); const [position, setPosition] = useState(0);
  const [pages, setPages] = useState<Record<number, RecallMessagePage>>({});
  const charOffset = offsets[position] ?? 0;
  const query = useLocal<RecallMessagePage>(`${conversationId}/recall-message/${seq}/${charOffset}`, async (signal) => {
    const result = await api.recallMessage(conversationId, { seq, charOffset, maxChars: 12000 }, signal);
    if (result.conversationId !== conversationId || result.seq !== seq || result.charOffset !== charOffset) throw new Error('原文分片定位不匹配，已忽略。');
    return result;
  });
  useEffect(() => { if (query.data) setPages((current) => ({ ...current, [query.data!.charOffset]: query.data! })); }, [query.data]);
  let completeText: string | null = null; let cursor = 0; let collected = ''; const visited = new Set<number>();
  const first = pages[0];
  while (first && pages[cursor] && !visited.has(cursor)) {
    visited.add(cursor); const page = pages[cursor]!;
    if (page.totalChars !== first.totalChars || page.charOffset !== cursor) break;
    collected += page.text;
    if (page.done && page.nextOffset === null && collected.length === page.totalChars) { completeText = collected; break; }
    if (page.nextOffset === null || page.nextOffset <= cursor) break;
    cursor = page.nextOffset;
  }
  return <div className="wb-original-pages"><ReadState query={query} />{query.data && <>
    <p className="memory-meta">{query.data.serialization} · seq {seq} · UTF-16 偏移 {query.data.charOffset}–{query.data.charOffset + query.data.text.length} / {query.data.totalChars}{query.data.done ? ' · 已到尾部' : ''}</p>
    <p className="hint">下方是当前分片，不一定是完整 JSON；不要把单页当作全文解析。上一片 / 下一片按需读取，不自动全量拉取。</p>
    <pre className="wb-verbatim wb-original-text" aria-label={`原文 seq ${seq} 当前分片`}>{query.data.text}</pre>
    <div className="wb-actions"><button type="button" className="small" disabled={position === 0} onClick={() => setPosition(position - 1)}>上一片原文</button><button type="button" className="small" disabled={query.data.done || query.data.nextOffset === null || query.data.nextOffset <= charOffset} onClick={() => {
      const next = query.data!.nextOffset; if (next === null || next <= charOffset) return;
      setOffsets([...offsets.slice(0, position + 1), next]); setPosition(position + 1);
    }}>下一片原文</button><button type="button" className="small" disabled={completeText === null} onClick={() => { if (completeText !== null) downloadOriginal(completeText, `original-${seq}.json`); }}>下载完整原文 JSON</button></div>
    {completeText === null && <p className="hint">完整下载需先按需读齐所有分片；未读齐时不提供可能缺尾的“全文”。拼接完成后可 JSON.parse 恢复原 MessageRow，reasoning/toolCalls 不会被格式化丢弃。</p>}
  </>}</div>;
}

const CHECKPOINT_LABEL: Record<CheckpointChoice, string> = { skip: '跳过，不记录', record: '只记台账', record_compact: '记录并压缩', record_handoff: '记录并写交接单' };
function CheckpointPane(shared: Shared): React.ReactElement {
  const query = useLocal<MemoryContextState>(`${shared.conversationId}/checkpoint/${shared.revision}`, (signal) => api.getMemoryContextState(shared.conversationId, signal), !!shared.conversationId);
  const [choice, setChoice] = useState<CheckpointChoice>('record');
  const [preview, setPreview] = useState<MemoryProposal | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const checkpoint = query.data?.checkpoint;
  const effectiveChoice = checkpoint?.choice ?? choice;
  const staged = checkpoint?.proposalId ? shared.view.proposals.find((proposal) => proposal.id === checkpoint.proposalId) ?? preview : null;
  const currentConversation = shared.conversationId;
  async function firstStage(values?: Record<string, string>): Promise<void> {
    if (!currentConversation || !checkpoint || checkpoint.status === 'resolved') throw new Error('请先打开本轮检查点。');
    const input: CheckpointInput = { checkpointId: checkpoint.id, choice: effectiveChoice };
    if (effectiveChoice === 'record_handoff') input.handoff = handoffPayload(values ?? {});
    else if (effectiveChoice !== 'skip') input.intent = { goal: values?.goal ?? '', did: values?.did ?? '', issues: values?.issues ?? '', next: values?.next ?? '' };
    await shared.run(async () => {
      const result = await api.resolveMemoryCheckpoint(currentConversation, input);
      setPreview(result.proposal ?? null); setConfirmed(false);
    }, effectiveChoice === 'skip' ? '已明确跳过本轮记录；没有写入或调用模型。' : '检查点内容已暂存、尚未生效。请审阅后独立确认接受。');
  }
  if (!currentConversation) return <Empty>选择本项目的来源对话后才能打开收尾检查点。</Empty>;
  return <><ReadState query={query} />{query.data && <Waterline state={query.data} />}
    <p className="hint">第一步只暂存用户输入；第二步明确接受后才发布。原则不能经此通道修改。</p>
    <button type="button" className="small" aria-label="打开本轮记忆检查点" disabled={shared.busy || !!checkpoint && checkpoint.status !== 'resolved'} onClick={() => void shared.run(() => api.openMemoryCheckpoint(currentConversation), '检查点已打开，请选择收尾方式。').then(() => { setPreview(null); setConfirmed(false); }).catch(() => {})}>打开本轮检查点</button>
    {checkpoint && <p className="memory-meta">检查点 {checkpoint.id} · user seq {checkpoint.userSeq} · 状态 {checkpoint.status} · {checkpoint.code}</p>}
    {checkpoint && checkpoint.status !== 'resolved' && <>
      <label className="wb-field">检查点四选一<select aria-label="检查点四选一" value={effectiveChoice} disabled={shared.busy || checkpoint.status === 'recorded' || !!checkpoint.proposalId} onChange={(event) => { setChoice(event.target.value as CheckpointChoice); setPreview(null); setConfirmed(false); }}>{Object.entries(CHECKPOINT_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {effectiveChoice === 'record_compact' && <p className="wb-warning">第二阶段接受这份摘要，不等于压缩成功。手动、自动和检查点都须台账更新、进展日志、triage 三项分别成功；缺项不发压缩请求。满足同门条件后才可能调用当前模型并消耗额度；未完成可以继续工作。</p>}
      {!checkpoint.proposalId && (effectiveChoice === 'skip' ? <button type="button" className="small" disabled={shared.busy} onClick={() => void firstStage().catch(() => {})}>确认跳过本轮记录</button> : <Editor key={effectiveChoice} title={effectiveChoice === 'record_handoff' ? '填写检查点交接内容' : '填写本轮进展摘要'} busy={shared.busy} fields={effectiveChoice === 'record_handoff' ? HANDOFF_FIELDS : [{ name: 'goal', label: '本轮目标', required: true }, { name: 'did', label: '实际完成内容', kind: 'textarea', required: true }, { name: 'issues', label: '问题与不确定', kind: 'textarea' }, { name: 'next', label: '明确下一步', kind: 'textarea', required: true }]} submit={(values) => firstStage(values)} />)}
      {checkpoint.proposalId && <section className="wb-confirm" aria-label="检查点独立接受"><strong>已暂存，未生效</strong><p className="memory-meta">提案 {checkpoint.proposalId}</p>
        {staged ? <FullRecord record={{ id: staged.recordId, kind: staged.kind, title: staged.title, content: staged.content, revision: staged.baseRevision, deleted: false, updatedAt: staged.createdAt }} /> : <p className="wb-warning">提案正文暂未取得，请刷新正式/暂存后再确认；不要盲目批准。</p>}
        <label className="wb-check"><input type="checkbox" aria-label="确认接受检查点暂存内容" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{effectiveChoice === 'record_compact' ? '我已审阅并同意接受内容，同时调用当前模型压缩并消耗额度' : '我已审阅，明确接受这份暂存内容'}</label>
        <button type="button" className="small" disabled={shared.busy || !confirmed || !staged} onClick={() => {
          const input: CheckpointInput = { checkpointId: checkpoint.id, choice: effectiveChoice, accept: true };
          void shared.run(async () => {
            const result = await api.resolveMemoryCheckpoint(currentConversation, input);
            if (effectiveChoice === 'record_compact' && result.compacted !== true) throw new Error(result.blocked || result.code === 'duties_incomplete' ? `尚缺：${(result.missing ?? []).map((kind) => COMPACTION_DUTY_LABEL[kind]).join('、') || '完整三层收尾证据'}；本次未压缩，不自动重试，可以继续工作。` : '本次没有确认压缩成功；单份摘要接受不等于三层齐备，请到“日志 → 上下文压缩”核对。');
          }, `${CHECKPOINT_LABEL[effectiveChoice]}已完成。`).then(() => { setPreview(null); setConfirmed(false); }).catch(() => {});
        }}>{effectiveChoice === 'record_compact' ? '确认接受并压缩（消耗模型额度）' : effectiveChoice === 'record_handoff' ? '确认接受并生成交接单' : '确认接受本轮记录'}</button>
      </section>}
    </>}
    {checkpoint?.status === 'resolved' && <p role="status" className="hint">{checkpoint.choice === 'record_compact' ? '检查点已处理；压缩是否成功以“日志 → 上下文压缩”的成功记录为准，不凭一份摘要推断。' : `本轮检查点已处理：${checkpoint.choice ? CHECKPOINT_LABEL[checkpoint.choice] : checkpoint.code}。`}交接单与逐字原文可在“日志”对应内容中查阅。</p>}
  </>;
}
function Waterline({ state }: { state: MemoryContextState }): React.ReactElement {
  const warning = state.warning.level !== 'safe';
  return <section className={warning || state.debt?.outstanding ? 'wb-warning' : 'wb-waterline'} aria-label="记忆上下文水线">
    <strong>上下文 {(state.contextRatio * 100).toFixed(1)}%</strong><span> · {state.contextTokens.toLocaleString()} / {state.contextWindow.toLocaleString()} tokens</span>
    {warning && <p role="status">{state.warning.message}</p>}
    {state.debt?.outstanding && <p role="alert"><strong>本对话最近一轮有历史欠账提示</strong> · user seq {state.debt.userSeq}。这不是项目总数；请在上方“项目收尾义务”逐项核对历史及旧记录，勿把提示当作已证实的成果漏记。</p>}
  </section>;
}

/** 一个项目一份工作台；轻量 counts/context 定时读，所有正文页按用户导航加载。 */
export function MemoryWorkbench(props: Props): React.ReactElement {
  const { view } = props;
  /**
   * 可见页签：默认四个全开（不传就保持旧行为）。
   * ★ 至少要有一个 —— 空面板比"少显示一个页签"更糟，所以这里兜底成「工作」。
   */
  const visible = props.visibleTabs ?? (['work', 'memory', 'logs', 'principles'] as const);
  const visibleGroups = (['work', 'memory', 'logs'] as const).filter((key) => visible.includes(key));
  const showPrinciples = visible.includes('principles');
  /** 默认落点：把 PanelTab 映射成 (group, page)；不在可见集合里就退到第一个可见分组 */
  const initial = ((): { group: Group; page: Page } => {
    const wanted = props.defaultTab ?? 'work';
    if (wanted === 'principles' && showPrinciples) return { group: 'memory', page: 'principles' };
    if ((visibleGroups as readonly string[]).includes(wanted)) {
      const key = wanted as 'work' | 'memory' | 'logs';
      return { group: key, page: GROUPS[key].pages[0]![0] };
    }
    const fallback = visibleGroups[0] ?? 'work';
    return { group: fallback, page: GROUPS[fallback].pages[0]![0] };
  })();
  const [group, setGroup] = useState<Group>(initial.group); const [page, setPage] = useState<Page>(initial.page);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [source, setSource] = useState(props.conversationId ?? ''); const [revision, setRevision] = useState(0);
  const [clock, setClock] = useState(0); const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [staged, setStaged] = useState<MemoryProposal | null>(null); const [preservedCount, setPreservedCount] = useState<number | null>(null);
  const mounted = useRef(false); const writing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setSource(props.conversationId ?? ''); }, [props.conversationId]);
  useEffect(() => { const timer = setInterval(() => setClock((value) => value + 1), 10000); return () => clearInterval(timer); }, []);
  const counts = useLocal<MemoryCounts>(`${view.projectId}/counts/${clock}/${revision}/${props.refreshKey}`, (signal) => api.getMemoryCounts(view.projectId, signal));
  const context = useLocal<MemoryContextState>(`${view.projectId}/${source}/state/${clock}/${revision}/${props.refreshKey}`, (signal) => api.getMemoryContextState(source, signal), !!source);
  const detailRevision = `${view.revision}/${revision}`;
  async function run(work: () => Promise<unknown>, success: string): Promise<void> {
    if (writing.current) throw new Error('已有操作正在进行，请等待完成。');
    writing.current = true; setBusy(true); setError(null); setNotice(null);
    try { await work(); if (mounted.current) setNotice(success); }
    catch (cause) { if (mounted.current) setError(message(cause)); throw cause; }
    finally { if (mounted.current) { writing.current = false; setBusy(false); setRevision((value) => value + 1); props.onChanged(); } }
  }
  async function stage(work: () => Promise<MemoryProposal>): Promise<void> {
    await run(async () => { const proposal = await work(); if (mounted.current) setStaged(proposal); }, '已暂存，未生效。请在下方审阅并独立接受，或前往“暂存”处理。');
  }
  function navigate(next: Page): void {
    const target = (Object.keys(GROUPS) as Group[]).find((key) => GROUPS[key].pages.some(([candidate]) => candidate === next)) ?? 'memory';
    setGroup(target); setPage(next);
    if (target === 'advanced') setAdvancedOpen(true);
  }
  const shared: Shared = { projectId: view.projectId, view, conversationId: source, revision: detailRevision, busy, stage, run };
  const formal = view.records.filter((record) => !record.deleted && !record.id.startsWith('artifact:'));
  const artifacts = view.records.filter((record) => !record.deleted && record.id.startsWith('artifact:'));
  const pending = view.proposals.filter((proposal) => proposal.status === 'pending');
  const conflicts = view.proposals.filter((proposal) => proposal.status === 'conflict');
  const activeGoals = formal.filter((record) => record.kind === 'goal' && ['root', 'active'].includes(String(objectContent(record.content)?.state))).length;
  const unresolvedStage = staged && (view.proposals.find((proposal) => proposal.id === staged.id)?.status ?? staged.status) === 'pending' ? staged : null;
  return <div className="memory-workbench" aria-label="记忆工作台" aria-busy={busy}>
    <div className="wb-project"><strong>{props.projectName ?? '当前绑定项目'}</strong><span className="memory-meta">{page === 'work' ? '本主对话的目标、任务与动态' : `正式台账 r${view.revision} · ${formal.length} 条记录`}</span></div>
    <nav className="wb-nav wb-main-nav" role="tablist" aria-label="工作台导航">{visibleGroups.map((key) => <button key={key} type="button" role="tab" aria-selected={group === key && page !== 'principles'} className={group === key && page !== 'principles' ? 'on' : ''} onClick={() => { setGroup(key); setPage(GROUPS[key].pages[0]![0]); }}>{GROUPS[key].label}{key === 'memory' && pending.length > 0 && <span className="wb-nav-count">{pending.length} 待审</span>}</button>)}{showPrinciples && <button type="button" role="tab" aria-selected={page === 'principles'} aria-label="原则与人工审批" className={page === 'principles' ? 'on' : ''} onClick={() => { setGroup('memory'); setPage('principles'); }}>原则<span className="wb-nav-count">{counts.data?.counts.pendingPrinciples ?? '—'} 待批</span></button>}</nav>
    {group !== 'work' && group !== 'advanced' && page !== 'principles' && <label className="wb-field">{group === 'memory' ? '台账内容' : '日志内容'}<select aria-label="记忆工作台内容" value={page} onChange={(event) => setPage(event.target.value as Page)}>{GROUPS[group].pages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    {page !== 'work' && <details className="wb-source"><summary>来源对话 · {props.conversations.find((conversation) => conversation.id === source)?.title ?? (source ? source : '未选择')}</summary><label className="wb-field">用于提案 / 日志 / 原文查询的来源<select aria-label="记忆工作台来源对话" value={source} disabled={busy} onChange={(event) => setSource(event.target.value)}><option value="">请选择本项目来源对话</option>{props.conversations.filter((conversation) => conversation.projectId === view.projectId).map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title ?? conversation.id}</option>)}</select></label></details>}
    {page !== 'work' && <div className="wb-actions"><button type="button" className="small" disabled={busy} aria-label="刷新当前工作台内容" onClick={() => { setRevision((value) => value + 1); props.onChanged(); }}>刷新当前内容</button>{group === 'memory' && <button type="button" className="small" onClick={() => { props.onShowPending(); navigate('current'); }}>查看待审修改 {pending.length}</button>}<span className="hint">详细内容按需读取</span></div>}
    {error && <p className="wb-error" role="alert">{error}</p>}{notice && <p className="wb-notice" role="status">{notice}</p>}
    {unresolvedStage && <details className="wb-staged" open><summary>刚提交：{unresolvedStage.title} · 已暂存，未生效</summary><pre className="wb-verbatim">{unresolvedStage.content}</pre><p className="memory-meta">{unresolvedStage.id} · 来源 {unresolvedStage.conversationId}</p><div className="wb-actions"><button type="button" className="small" disabled={busy} aria-label="独立接受刚提交的记忆提案" onClick={() => void run(() => api.acceptMemoryProposal(view.projectId, unresolvedStage.id), '提案已独立接受。').then(() => setStaged(null)).catch(() => {})}>审阅后独立接受</button><button type="button" className="small" disabled={busy} onClick={() => void run(() => api.rejectMemoryProposal(view.projectId, unresolvedStage.id), '提案已拒绝。').then(() => setStaged(null)).catch(() => {})}>拒绝此提案</button></div></details>}
    <div className="wb-page" role="tabpanel" aria-label={GROUPS[group].pages.find(([candidate]) => candidate === page)?.[1] ?? '工作台内容'}>
      {page === 'work' && <>
          <ExecutionBoard projectId={view.projectId} conversationId={props.conversationId} conversationTitle={props.conversations.find((conversation) => conversation.id === props.conversationId)?.title} refreshKey={props.refreshKey} />
          {/* 委派看板紧跟执行看板：子代理进度属于"当前工作"，分开放会让人以为它们是两件事 */}
          <DelegationBoardPanel
            conversationId={props.conversationId}
            refreshKey={props.refreshKey}
            {...(props.onOpenConversation === undefined ? {} : { onOpenConversation: props.onOpenConversation })}
            {...(props.onBackToParent === undefined ? {} : { onBackToParent: props.onBackToParent })}
          />
        </>}
      {page === 'overview' && <><ReadState query={counts} /><p className="memory-meta">{formal.length} 正式记录 · {artifacts.length} 已发布制品 · {activeGoals} 个进行中长期目标 · 冲突 {conflicts.length} / 保留区 {preservedCount ?? '按需读取'}</p><p className="hint">暂存不是正式记忆。先处理待审与收尾欠账，再按需要查完整内容；所有表单在对应页面渐进展开。</p>
        <div className="wb-overview-grid">
          <button type="button" onClick={() => { props.onShowPending(); navigate('current'); }}><strong>审阅进展</strong><span>{pending.length} 待审 · {conflicts.length} 冲突</span></button>
          <button type="button" onClick={() => navigate('checkpoint')}><strong>收尾检查点</strong><span>{context.data?.debt?.outstanding ? '有未固化欠账' : context.data?.checkpoint ? `状态 ${context.data.checkpoint.status}` : '四选一明确收尾'}</span></button>
          <button type="button" onClick={() => navigate('handoffs')}><strong>下一位先看什么</strong><span>{counts.data ? `${counts.data.counts.handoffs} 份交接单` : '按需读取交接单'}</span></button>
          <button type="button" onClick={() => navigate('triage')}><strong>保留与分流</strong><span>{counts.data ? `keep ${counts.data.counts.keep} / stash ${counts.data.counts.stash} / drop ${counts.data.counts.drop}` : '读取三桶清单'}</span></button>
        </div><p className="hint">目标进行中仅统计已发布且有结构状态的 root/active 卡片；旧标签记录不会被当作机制已完成。保留区计数读取前标为“按需查”，不虚报零。</p>
        {view.jobs.find((job) => job.state === 'failed') && <p className="wb-warning">有维护失败记录；请到“台账 → 正式记录 / 待审修改 / 整理设置 → 维护记录”检查诊断与用量。失败不会自动重试。</p>}
      </>}
      {page === 'current' && props.children}
      {page === 'archive' && <ArchivePane {...shared} />}{page === 'goals' && <GoalsPane {...shared} />}{page === 'lessons' && <LessonsPane {...shared} />}{page === 'notes' && <NotesPane {...shared} />}
      {page === 'preserved' && <PreservedPane {...shared} onCount={setPreservedCount} />}{page === 'index' && <IndexPane {...shared} />}{page === 'map' && <MaterialPane {...shared} />}
      {page === 'triage' && <TriagePane {...shared} />}{page === 'handoffs' && <HandoffsPane {...shared} />}{page === 'compaction' && <CompactionPane key={source} {...shared} />}{page === 'capsules' && <CapsulesPane {...shared} />}{page === 'checkpoint' && <CheckpointPane key={source} {...shared} />}
      {page === 'principles' && <PrinciplesPane {...shared} />}{page === 'logs' && <LogsPane {...shared} conversations={props.conversations} />}{page === 'extensions' && <ExtensionsPane {...shared} />}
    </div>
    <details className="wb-advanced" open={advancedOpen} onToggle={(event) => {
      const open = event.currentTarget.open; setAdvancedOpen(open);
      if (!open && group === 'advanced') { setGroup('work'); setPage('work'); }
    }}><summary aria-label="高级台账整理与诊断">高级：后台整理检查 / 上下文 / 诊断</summary>
      {advancedOpen && <div className="wb-advanced-body"><p className="hint">后台整理状态不代表当前工作失败，也不阻塞正常任务。日常目标与任务请在“工作”查看。</p>
        <label className="wb-field">高级工具<select aria-label="高级台账工具" value={group === 'advanced' ? page : ''} onChange={(event) => { if (event.target.value) navigate(event.target.value as Page); }}><option value="">选择需要查看的高级工具…</option>{GROUPS.advanced.pages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <MemoryObligations key={view.projectId} projectId={view.projectId} conversations={props.conversations} proposals={view.proposals} refreshKey={`${view.revision}/${revision}/${props.refreshKey}`} busy={busy} onChanged={props.onChanged} />
        {context.data && <Waterline state={context.data} />}{context.error && <p className="wb-error" role="alert">上下文状态读取失败：{context.error}</p>}
      </div>}
    </details>
  </div>;
}
