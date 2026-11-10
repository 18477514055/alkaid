import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PromptDialog } from './PromptDialog.tsx';
import { MemoryPanel } from './MemoryPanel.tsx';
import { ConversationCompactionLog } from './MemoryWorkbench.tsx';
import { SettingsDialog, type SettingsTab } from './SettingsDialog.tsx';
import { useAppSettings } from './useAppSettings.ts';
import { SidebarMenu, type SidebarMenuTarget } from './SidebarMenus.tsx';
import { ArchivePage } from './ArchivePage.tsx';
import { ProjectPanelSettings } from './ProjectPanelSettings.tsx';
import { McpPanel } from './McpPanel.tsx';
import { PANEL_TABS, PANEL_TABS_WITHOUT_PROJECT } from '../../src/shared/settings.ts';
import { MessageActions } from './MessageActions.tsx';
import { SessionMenu } from './SessionMenu.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { UsageDock } from './UsageDock.tsx';
import './ui-parts.css';
import {
  api,
  ApiError,
  COMPACTION_DUTY_LABEL,
  sendMessage,
  type ConversationDto,
  type DashboardDto,
  type MessageDto,
  type PluginDto,
  type ProjectDto,
  type ProviderDto,
  type StepEventDto,
  type UsageDetailDto,
  type WorkspaceDto,
} from './api.ts';
import {
  IconAlert,
  IconArrowUp,
  IconStop,
  IconChevron,
  IconFolder,
  IconGauge,
  IconLayers,
  IconPanel,
  IconPlus,
  IconStar,
  IconSteps,
  IconTerminal,
  IconUsage,
  IconSettings,
  IconX,
} from './icons.tsx';
import { Markdown } from './markdown.tsx';
import {
  DEFAULT_INSPECTOR_WIDTH,
  clampInspectorWidth,
  inspectorWidthBounds,
  normalizeInspectorPreference,
} from './useInspectorWidth.ts';

/**
 * 瑶光界面（V0.3 重制）。
 *
 * ★ 布局与 DSH 同一套骨架：左栏「工作区 → 会话」树 / 中栏对话 / 右栏检查器。
 *   右栏可收起，收起后正文居中，不会有一大片空白挂着。
 * ★ 颜色全部走 `styles.css` 的令牌，主色是墨黑，**不用蓝色**；
 *   彩色只留给「被拒绝 / 出错 / 警告」这三种状态，且面积很小。
 * ★ 这里**不做任何业务判断**：权限、压缩、归档都在内核，前端只调接口与显示。
 */

/**
 * ★ 这里原来有一个 `alkaid.general-settings.v1` 的 localStorage 键。
 *   已删除：桌面壳每次启动都换随机端口 ⇒ origin 变 ⇒ 那份设置每次重启就归零。
 *   现在设置在服务端 `app_settings` 表，见 `useAppSettings.ts`。
 */

const PERMISSION_LABEL: Record<string, string> = {
  readonly: '只读',
  workspace: '工作区',
  project: '项目',
  workspace_project: '工作区 + 项目',
  full: '完全权限',
};

/** 没有会话时的空统计 —— 底部栏永远有东西可显示，不用到处判空 */
const EMPTY_STATS = {
  turns: 0,
  steps: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCached: 0,
  tokensPerSecond: null as number | null,
  totalTokens: 0,
  cacheHitRate: null as number | null,
};

/** 审计事件的短标签（右栏与轨迹共用，别在两处各写一遍） */
const KIND_LABEL: Record<string, string> = {
  tool_call: '工具',
  policy_denied: '被拒绝',
  tool_error: '工具错误',
  provider_error: '模型错误',
  step_end: '收尾',
};

const KIND_COLOR: Record<string, string> = {
  tool_call: 'var(--line-3)',
  policy_denied: 'var(--danger)',
  tool_error: 'var(--warn)',
  provider_error: 'var(--danger)',
  step_end: 'var(--line-2)',
};

function relTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  if (days < 8) return `${days} 天`;
  const date = new Date(at);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`;
}

function clockTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/**
 * 折叠块。
 * ★ 用自己的按钮而不是 `<details>`：`<details>` 的三角在 Chrome 里不可样式化，
 *   而这套界面里三角要对齐到 11px 的字号上。
 */
function Fold(props: {
  label: React.ReactNode;
  children: React.ReactNode;
  mono?: boolean;
  defaultOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(props.defaultOpen === true);
  return (
    <div>
      <button type="button" className="fold" onClick={() => setOpen((current) => !current)}>
        <span className={`tri ${open ? 'open' : ''}`}>
          <IconChevron size={11} />
        </span>
        {props.label}
      </button>
      {open && <div className={`fold-body ${props.mono === true ? 'mono' : ''}`}>{props.children}</div>}
    </div>
  );
}

/**
 * 工具调用 = **一行**（DSH 的形式）：`工具调用 · read · {"path":"…"}`。
 * 展开后是**输入 / 输出两段** —— 因为调用与它的结果本来是同一件事，
 * 拆成两条消息就是用户说的「一条工具输出也算一条消息」。
 */
function ToolCallRow(props: { name: string; args: string; output?: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const oneLine = useMemo(() => {
    const flat = props.args.replace(/\s+/g, ' ').trim();
    return flat.length > 110 ? `${flat.slice(0, 110)}…` : flat;
  }, [props.args]);

  /** JSON 参数尽量展开成缩进形式；不是 JSON 就原样给（工具参数不一定都是 JSON） */
  const pretty = (raw: string): string => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  };

  return (
    <div className="tool-call">
      <button
        type="button"
        className="tool-row"
        style={{ width: '100%', textAlign: 'left' }}
        onClick={() => setOpen((current) => !current)}
        title={open ? '收起' : '展开输入与输出'}
        aria-expanded={open}
      >
        <span className="tri">
          <IconChevron size={10} />
        </span>
        <span className="lbl">工具调用</span>
        <span className="ico">
          <IconTerminal size={12} />
        </span>
        <span className="name">{props.name}</span>
        <span className="args">{oneLine}</span>
        {props.output !== undefined && <span className="len">{props.output.length} 字</span>}
      </button>
      {open && (
        <div className="tool-io">
          <div className="tool-io-label">输入</div>
          <pre className="tool-io-body">{pretty(props.args)}</pre>
          {props.output !== undefined && (
            <>
              <div className="tool-io-label">输出</div>
              <pre className="tool-io-body">{props.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 只按显式分流元数据决定展示；不按工具名字或正文关键字猜测。 */
function isChatMessage(message: MessageDto): boolean {
  if (message.displayChannel === 'maintenance') return false;
  if (message.role !== 'assistant') return true;
  const calls = message.toolCalls ?? [];
  return !(calls.length > 0 && calls.every((call) => call.displayChannel === 'maintenance') &&
    (message.content ?? '').trim().length === 0);
}

/**
 * ⑦ 一轮对话 = 一个「正文块」。
 *
 * ★ 用户的原话（2026-11-10）：「为什么你这个一条工具输出或者一次请求就算一条消息，
 *   你不觉得很诡异吗？你就不能按照 dsh 的这个正文形式来去排版吗？」
 * ★ 旧结构：**每条消息一个 `<article class="msg …">`** —— 于是「思考」「工具调用」
 *   「工具输出」「续写」各自是一块，各自带一份间距与（assistant 的）角色行。
 *   一轮里工具调用十几次，屏幕上就是十几块等高方块，**正文被切成碎片**，翻起来像日志。
 * ★ DSH 的形式：**一轮只出一个正文块**，正文连续阅读；思考 / 调用 / 工具输出退化成
 *   这块**内部**可折叠的小行，各自只占一行。
 * ★ 所以这里按「user 之后、下一个 user 之前」分组，**组内不再有块级间距**。
 */
type Turn = {
  readonly key: string;
  readonly user: MessageDto | null;
  readonly parts: readonly MessageDto[];
};

function groupTurns(messages: readonly MessageDto[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ key: message.id, user: message, parts: [] });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last === undefined) {
      // 文件开头不是 user（例如只有系统消息）：也要有自己的块，不能丢
      turns.push({ key: `head-${message.id}`, user: null, parts: [message] });
      continue;
    }
    (last.parts as MessageDto[]).push(message);
  }
  return turns;
}

/** 工具输出：**一行**可折叠（点开才是正文）—— 与「思考」同款，不再占两行 */
function ToolOutputRow(props: { body: string }): React.ReactElement {
  return (
    <Fold
      label={
        <>
          <IconTerminal size={12} />
          工具输出 · {props.body.length} 字
        </>
      }
      mono
    >
      <div className="tool-out">{props.body}</div>
    </Fold>
  );
}

function TurnView(props: {
  turn: Turn;
  onBranch: (seq: number) => void;
  busy: boolean;
}): React.ReactElement {
  const { turn } = props;
  /** 一轮的用量挂在**最后一条有 usage 的 assistant** 上，显示在块末，不当独立消息 */
  const usageSource = [...turn.parts].reverse().find((part) => part.usage !== null) ?? null;

  /**
   * ★ 把工具消息按 `toolCallId` 收回它那次调用里 —— 同一件事只出一行。
   * 收不回去的（找不到对应调用）留作孤儿行，**不丢**：宁可多一行，也不能让输出凭空消失。
   */
  const outputs = new Map<string, string>();
  for (const part of turn.parts) {
    if (part.role === 'tool' && typeof part.toolCallId === 'string' && part.toolCallId.length > 0) {
      outputs.set(part.toolCallId, part.content ?? '');
    }
  }
  const claimed = new Set<string>();
  for (const part of turn.parts) {
    for (const call of part.toolCalls ?? []) {
      if (outputs.has(call.id)) claimed.add(call.id);
    }
  }

  return (
    <section className="turn">
      {turn.user !== null && (
        <div className="turn-user">
          <div className="bubble">{turn.user.content ?? '（空消息）'}</div>
          <div className="stamp">
            {clockTime(turn.user.createdAt)}
            <MessageActions
              content={turn.user.content ?? ''}
              seq={turn.user.seq}
              role="user"
              onBranch={props.onBranch}
              disabled={props.busy}
            />
          </div>
        </div>
      )}

      <div className="turn-body">
        {turn.parts.map((part) => {
          if (part.role === 'tool') {
            // 已被某次调用认领的输出由那一行显示输入+输出；这里只渲染孤儿
            if (typeof part.toolCallId === 'string' && claimed.has(part.toolCallId)) return null;
            return <ToolOutputRow key={part.id} body={part.content ?? '（空输出）'} />;
          }
          if (part.role === 'system') {
            return (
              <p className="turn-system" key={part.id}>
                {part.content ?? ''}
              </p>
            );
          }
          const calls = part.toolCalls?.filter((call) => call.displayChannel !== 'maintenance') ?? [];
          return (
            <div className="turn-part" key={part.id}>
              {part.reasoning !== null && part.reasoning.length > 0 && (
                <Fold label={`思考 · ${part.reasoning.length} 字`} mono>
                  {part.reasoning}
                </Fold>
              )}
              {part.content !== null && part.content.length > 0 && <Markdown text={part.content} />}
              {calls.map((call) => (
                <ToolCallRow
                  key={call.id}
                  name={call.name}
                  args={call.arguments}
                  {...(outputs.has(call.id) ? { output: outputs.get(call.id) as string } : {})}
                />
              ))}
            </div>
          );
        })}
      </div>

      {usageSource !== null && usageSource.usage !== null && (
        <div className="usage turn-usage">
          tokens {compactNumber(usageSource.usage.input)} → {compactNumber(usageSource.usage.output)}
          {usageSource.usage.cached !== undefined ? ` · 缓存 ${compactNumber(usageSource.usage.cached)}` : ''}
          {usageSource.finishReason !== null ? ` · ${usageSource.finishReason}` : ''}
        </div>
      )}
    </section>
  );
}

/**
/** 轨迹视图：先把「这一步发生了什么事」铺成一条泳道，再列明细 */function TraceView(props: { events: StepEventDto[] }): React.ReactElement {
  const ordered = props.events;
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const event of ordered) map.set(event.kind, (map.get(event.kind) ?? 0) + 1);
    return map;
  }, [ordered]);

  if (ordered.length === 0) {
    return (
      <div className="traj">
        <div className="traj-inner">
          <div className="empty-hint">
            <p>发一条消息之后，每个步骤都会在这里留一条记录：调了哪个工具、结果如何、有没有被权限挡下。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="traj">
      <div className="traj-inner">
        <section className="lane">
          <div className="lane-head">
            <span>步骤泳道</span>
            <span className="grow" />
            <span>{ordered.length} 步</span>
          </div>
          <div className="lane-track">
            {ordered.map((event) => (
              <span
                key={event.id}
                className={`tick k-${event.kind}`}
                title={`#${event.stepNo} ${KIND_LABEL[event.kind] ?? event.kind}`}
              />
            ))}
          </div>
          <div className="lane-legend">
            {[...counts.entries()].map(([kind, count]) => (
              <span key={kind}>
                <i style={{ background: KIND_COLOR[kind] ?? 'var(--line-3)' }} />
                {KIND_LABEL[kind] ?? kind} {count}
              </span>
            ))}
          </div>
        </section>

        <section className="steps">
          {ordered.map((event) => {
            // 审计纪律：payload 只有工具名/结果状态/用量，**没有 prompt 与参数原文**。
            // 所以这一列只能拼「工具 + 结果规模/结束原因/码」，拼不出命令内容 —— 这是刻意的。
            const tool = typeof event.payload?.['tool'] === 'string' ? String(event.payload['tool']) : null;
            const code = typeof event.payload?.['code'] === 'string' ? String(event.payload['code']) : null;
            const finish =
              typeof event.payload?.['finishReason'] === 'string' ? String(event.payload['finishReason']) : null;
            const chars =
              typeof event.payload?.['resultChars'] === 'number' ? Number(event.payload['resultChars']) : null;
            const detail =
              tool !== null
                ? `${tool}${chars !== null ? ` · ${compactNumber(chars)} 字符` : ''}${code !== null ? ` · ${code}` : ''}`
                : finish !== null
                  ? `finish=${finish}`
                  : '—';

            return (
              <div className="step-row" key={event.id}>
                <span className="no">#{event.stepNo}</span>
                <span className={`kind ${event.kind}`}>{KIND_LABEL[event.kind] ?? event.kind}</span>
                <span className="what">{detail}</span>
                <span className="at">{clockTime(event.createdAt)}</span>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}

/**
 * 右栏宽度：**设置是唯一真源**（`app_settings` 的 `panel.width`）。
 * ★ 以前存在 localStorage，而桌面壳每次启动换随机端口 ⇒ origin 变 ⇒ 宽度每次重启归零。
 * ★ 拖动过程中只改本地态（否则每个 pointermove 都发一次请求），
 *   **拖动结束 / 键盘调整 / 双击复位**时才提交给服务端。
 */
function useInspectorSizing(
  open: boolean,
  options: { serverWidth: number; onCommit: (width: number) => void },
) {
  const [preference, setPreference] = useState(() => normalizeInspectorPreference(options.serverWidth));
  /** 服务端值变了（例如在设置面板里改了宽度）就跟随；拖动中不打断用户 */
  const lastServer = useRef(options.serverWidth);
  const draggingRef = useRef(false);
  const commitRef = useRef(options.onCommit);
  commitRef.current = options.onCommit;
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number; element: HTMLDivElement; startX: number; startWidth: number; restoreStyle: () => void;
  } | null>(null);
  const bounds = inspectorWidthBounds(viewport);
  const width = clampInspectorWidth(preference, viewport, open);

  const finishDrag = useCallback(() => {
    const current = drag.current;
    if (current === null) return;
    drag.current = null;
    current.restoreStyle();
    setDragging(false);
    draggingRef.current = false;
    // Clear the ref before release: release itself may dispatch lostpointercapture.
    if (current.element.hasPointerCapture(current.pointerId)) {
      current.element.releasePointerCapture(current.pointerId);
    }
    // ★ 拖动结束才提交给服务端（每次 pointermove 都发请求会把接口打爆）
    setPreference((value) => { commitRef.current(value); return value; });
  }, []);

  useEffect(() => {
    const resize = () => { finishDrag(); setViewport(window.innerWidth); };
    window.addEventListener('resize', resize);
    window.addEventListener('blur', finishDrag);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', finishDrag);
      finishDrag();
    };
  }, [finishDrag]);

  useEffect(() => { if (!open) finishDrag(); }, [open, finishDrag]);
  /** 服务端值变化时跟随（拖动中不打断）；同值不重复设，避免死循环 */
  useEffect(() => {
    if (lastServer.current === options.serverWidth) return;
    lastServer.current = options.serverWidth;
    if (draggingRef.current) return;
    setPreference(normalizeInspectorPreference(options.serverWidth));
  }, [options.serverWidth]);

  const resizeTo = (value: number) => {
    setPreference(normalizeInspectorPreference(clampInspectorWidth(value, viewport)));
  };
  const reset = (): void => {
    finishDrag();
    setPreference(DEFAULT_INSPECTOR_WIDTH);
    // 双击复位也要落盘，否则刷新一次又弹回旧宽度
    commitRef.current(normalizeInspectorPreference(DEFAULT_INSPECTOR_WIDTH));
  };

  return {
    width, bounds, dragging, reset,
    separatorProps: {
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !event.isPrimary || drag.current !== null) return;
        const element = event.currentTarget;
        // No document listeners or selection changes survive failed capture.
        try { element.setPointerCapture(event.pointerId); } catch { return; }
        event.preventDefault();
        element.focus();
        const style = document.body.style;
        const select = style.getPropertyValue('user-select');
        const selectPriority = style.getPropertyPriority('user-select');
        const cursor = style.getPropertyValue('cursor');
        const cursorPriority = style.getPropertyPriority('cursor');
        drag.current = {
          pointerId: event.pointerId, element, startX: event.clientX, startWidth: width,
          restoreStyle: () => {
            if (select) style.setProperty('user-select', select, selectPriority);
            else style.removeProperty('user-select');
            if (cursor) style.setProperty('cursor', cursor, cursorPriority);
            else style.removeProperty('cursor');
          },
        };
        style.setProperty('user-select', 'none');
        style.setProperty('cursor', 'col-resize');
        setDragging(true);
        draggingRef.current = true;
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        resizeTo(current.startWidth + current.startX - event.clientX);
      },
      onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId === event.pointerId) finishDrag();
      },
      onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId === event.pointerId) finishDrag();
      },
      onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId === event.pointerId) finishDrag();
      },
      onDoubleClick: reset,
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 40 : 10;
        const next = event.key === 'ArrowLeft' ? width + step
          : event.key === 'ArrowRight' ? width - step
            : event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : null;
        if (next !== null) {
          event.preventDefault();
          finishDrag();
          resizeTo(next);
          // 键盘调整也要落盘（同一套"结束才提交"的规矩）
          commitRef.current(normalizeInspectorPreference(clampInspectorWidth(next, viewport)));
        }
      },
    },
  };
}

/**
 * 归档面板的挂载包装：**一挂载就拉一次**。
 * ★ 单独一个组件是为了让"挂载"这件事可靠：设置对话框切页签是它自己的内部状态，
 *   外层拿不到"当前在归档页"这个信息，靠外层 effect 会永远不触发（第一版就是这么错的）。
 */
function ArchivePane(
  props: { load: () => Promise<void> } & React.ComponentProps<typeof ArchivePage>,
): React.ReactElement {
  const { load, ...rest } = props;
  useEffect(() => {
    void load();
  }, [load]);
  return <ArchivePage {...rest} />;
}

/**
 * 桌面壳注入的原生能力（只有 Electron 的 preload 会挂它）。
 * ★ 显式写成最小形状并**逐个校验**，而不是 `(window as any).alkaidDesktop`：
 *   浏览器里它是 undefined，Electron 里也可能是旧版 preload（没有这个方法）。
 * ★ `pickDirectory` 契约：永不 reject，`null` = 用户取消或失败。
 */
type DesktopBridge = { pickDirectory: () => Promise<string | null> };

function readDesktopBridge(): DesktopBridge | null {
  const candidate = (window as unknown as { alkaidDesktop?: unknown }).alkaidDesktop;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const bridge = candidate as { available?: unknown; pickDirectory?: unknown };
  if (bridge.available !== true || typeof bridge.pickDirectory !== 'function') return null;
  return { pickDirectory: bridge.pickDirectory.bind(candidate) as () => Promise<string | null> };
}

export function App(): React.ReactElement {  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [draft, setDraft] = useState('');
  const [streamText, setStreamText] = useState('');
  const [streamReasoning, setStreamReasoning] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 桌面端原生能力桥；浏览器里恒为 null（用一次 useMemo 避免每帧重读 window） */
  const desktopBridge = useMemo(() => readDesktopBridge(), []);
  const [compactionNotice, setCompactionNotice] = useState<{ conversationId: string; text: string } | null>(null);
  const [compactionRunning, setCompactionRunning] = useState(false);
  const [compactionLogsFor, setCompactionLogsFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [plugins, setPlugins] = useState<PluginDto[]>([]);
  const [dialog, setDialog] = useState<'project' | 'workspace' | null>(null);
  const [dialogName, setDialogName] = useState('');
  const [dialogPath, setDialogPath] = useState('');
  const [dashboard, setDashboard] = useState<DashboardDto | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [promptChars, setPromptChars] = useState<number | null>(null);
  const [view, setView] = useState<'chat' | 'trace'>('chat');
  const [inspectorOpen, setInspectorOpen] = useState(true);
  /** 统一设置面板：null = 关着；记录打开时落在哪个页签 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  /**
   * 通用设置 + 右栏设置（**服务端为唯一真源**）。
   * ★ 以前这些存在 localStorage，而桌面壳每次启动都换随机端口 ⇒ origin 变 ⇒ 每次重启就归零。
   *   现在走 `app_settings` 表，跟着数据家走，更新与重启都不丢。
   */
  const settings = useAppSettings();
  const general = settings.general;
  /** 归档管理（设置 → 归档）：只在打开那一页时拉 */
  const [archivedConversations, setArchivedConversations] = useState<ConversationDto[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<ProjectDto[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveBusy, setArchiveBusy] = useState<string | null>(null);
  /** 底部三样的详情抽屉：null = 关着 */
  const [usageTab, setUsageTab] = useState<'usage' | 'context' | null>(null);
  const [usageDetail, setUsageDetail] = useState<UsageDetailDto | null>(null);
  /** 侧栏会话右键菜单：记录鼠标位置与被点的会话 */
  const [menu, setMenu] = useState<{ x: number; y: number; conversationId: string } | null>(null);
  /** 侧栏**工作区 / 项目**右键菜单（与会话菜单分开：目标类型不同、动作也不同） */
  const [sidebarMenu, setSidebarMenu] = useState<{ x: number; y: number; target: SidebarMenuTarget } | null>(null);
  const [sidebarBusy, setSidebarBusy] = useState(false);
  /** 当前 provider 能报出的模型列表（为空说明网关没实现 /models） */
  const [models, setModels] = useState<string[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [conversations, activeId],
  );

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeConversation?.projectId) ?? null,
    [projects, activeConversation],
  );

  /**
   * 当前作用域的右栏设置：
   * - 会话绑了项目 ⇒ 用**该项目自己的**那份
   * - 没绑项目 ⇒ 用全局那份（`app_settings` 里 `scope='global'`），
   *   这时右栏只显示不需要项目的页签（工作 / 日志）
   */
  const activeProjectId = activeConversation?.projectId ?? null;
  const panelSettings = settings.panelFor(activeProjectId);

  /** 切到有项目的会话时按需拉该项目的右栏设置（拉不到就用默认值） */
  useEffect(() => {
    settings.ensureProjectPanel(activeProjectId);
  }, [activeProjectId, settings]);

  /**
   * 右栏宽度：服务端 `panel.width` 是真源；拖动结束/键盘/双击复位时提交。
   * ★ 必须放在 `panelSettings` 之后 —— 它要用当前作用域的宽度做初始值。
   */
  const inspectorSizing = useInspectorSizing(inspectorOpen, {
    serverWidth: panelSettings.width,
    onCommit: (nextWidth) => {
      void settings
        .updatePanel(activeProjectId, { width: nextWidth })
        .catch((cause: unknown) => setError(String(cause)));
    },
  });

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeConversation?.primaryWorkspaceId) ?? null,
    [workspaces, activeConversation],
  );

  /** 左栏树：工作区 → 会话；没绑工作区的会话归到「独立会话」 */
  const groups = useMemo(() => {
    const byWorkspace = new Map<string, ConversationDto[]>();
    for (const conversation of conversations) {
      const key = conversation.primaryWorkspaceId ?? 'none';
      const list = byWorkspace.get(key) ?? [];
      list.push(conversation);
      byWorkspace.set(key, list);
    }
    const result = workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      rootPath: workspace.rootPath,
      /** 真实工作区 id；「独立会话」是虚拟分组，没有登记可改，右键菜单要据此跳过 */
      workspaceId: workspace.id as string | null,
      conversations: byWorkspace.get(workspace.id) ?? [],
    }));
    const orphans = byWorkspace.get('none') ?? [];
    if (orphans.length > 0) {
      result.push({ id: 'none', name: '独立会话', rootPath: '', workspaceId: null, conversations: orphans });
    }
    return result;
  }, [conversations, workspaces]);

  /**
   * 底部三样东西的数据源都是 `/dashboard` 的 `stats`。
   * ★ 没有会话时给一份全 0 的空统计，**不要**在 JSX 里到处写 `dashboard?.stats?.x ?? 0`
   *   —— 那样一旦漏一处就是 `undefined` 显示成空白。
   */
  const stats = dashboard?.stats ?? EMPTY_STATS;

  /** 上下文水位 0–100（超 100 也照实显示，不要悄悄夹到 100） */
  const waterPct = dashboard?.contextRatio === null || dashboard?.contextRatio === undefined
    ? 0
    : dashboard.contextRatio * 100;

  /**
   * ★ 已用但不足 1% 时显示 `<1%`，不要显示 `0%` ——
   *   0% 会让人以为「一点都没用」，而实际上上下文里已经有内容了（312 字也是内容）。
   */
  const waterText =
    dashboard === null
      ? '—'
      : waterPct === 0
        ? '0%'
        : waterPct < 1
          ? '<1%'
          : `${Math.round(waterPct)}%`;

  const waterLevel = waterPct >= 80 ? 'high' : waterPct >= 60 ? 'mid' : 'low';

  /** 当前会话绑定的 provider（模型选择器要显示连接名） */
  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id === activeConversation?.providerId) ?? null,
    [providers, activeConversation],
  );

  /**
   * 拉当前 provider 能报出的模型列表。
   * ★ 失败**不算错误**：很多自建网关根本没实现 `GET /models`，
   *   这时列表为空、选择器退化成手填 —— 那是正常状态，不该弹红条吓用户。
   */
  useEffect(() => {
    if (activeProvider === null) {
      setModels([]);
      return;
    }
    void api
      .listModels(activeProvider.id)
      .then((probe) => {
        /**
         * ★ 只显示**白名单里的**模型（后端已经过滤）。
         *   之前这里读的是网关完整目录，于是"我只配了一个 deepseek"却能看到 OpenCode 的几十个模型 ——
         *   选一个没配过的会在下一次请求里直接失败。
         *
         * ★ 再兜一层：把**当前会话正在用的模型**塞进去。
         *   万一白名单是空的（老库没设过 defaultModel），至少让用户看得见自己正在用哪个，
         *   而不是看到一个空选择器。
         */
        const list = probe.ok ? probe.models.map((model) => model.id) : [];
        const inUse = activeConversation?.model;
        const withCurrent = inUse !== undefined && inUse.length > 0 && !list.includes(inUse) ? [inUse, ...list] : list;
        setModels(withCurrent);
      })
      .catch(() => setModels([]));
  }, [activeProvider, activeConversation?.model]);

  /** 通用设置一变就落服务端（`useAppSettings` 内部乐观更新 + 失败回滚） */

  const refreshProviders = useCallback(async () => {
    const list = await api.listProviders();
    setProviders(list);
    // ★ 没有连接时**不要再自动弹 SetupDialog 了** —— 现在配置在「设置 → 模型」里，
    //   自动弹窗会在打开设置面板时叠一层，看着像卡住了。改成在设置里提示。
  }, []);

  const refreshConversations = useCallback(async () => {
    const list = await api.listConversations();
    setConversations(list);
    setActiveId((current) => {
      if (current !== null && list.some((item) => item.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }, []);

  const refreshProjects = useCallback(async () => {
    setProjects(await api.listProjects());
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    setWorkspaces(await api.listWorkspaces());
  }, []);

  useEffect(() => {
    void refreshProviders().catch((cause: unknown) => setError(String(cause)));
    void refreshConversations().catch((cause: unknown) => setError(String(cause)));
    void refreshProjects().catch((cause: unknown) => setError(String(cause)));
    void refreshWorkspaces().catch((cause: unknown) => setError(String(cause)));
    void api.listPlugins().then(setPlugins).catch(() => setPlugins([]));
  }, [refreshProviders, refreshConversations, refreshProjects, refreshWorkspaces]);

  useEffect(() => {
    if (activeId === null) {
      setMessages([]);
      setDashboard(null);
      return;
    }
    void api
      .listMessages(activeId)
      .then(setMessages)
      .catch((cause: unknown) => setError(String(cause)));
    void api
      .getDashboard(activeId)
      .then(setDashboard)
      .catch((cause: unknown) => setError(String(cause)));
    void api
      .getPrompt(activeId)
      .then((info) => setPromptChars(info.text.length))
      .catch(() => setPromptChars(null));
  }, [activeId]);

  const refreshDashboard = useCallback(async () => {
    if (activeId === null) return;
    try {
      setDashboard(await api.getDashboard(activeId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [activeId]);

  /** 打开底部三样的详情面板。★ 每次打开都重新拉一次，不缓存旧数据（用量一直在变）。 */
  const openUsage = useCallback(
    (tab: 'usage' | 'context') => {
      setUsageTab(tab);
      if (activeId === null) return;
      setUsageLoading(true);
      setUsageDetail(null);
      void api
        .getUsage(activeId)
        .then(setUsageDetail)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setUsageLoading(false));
    },
    [activeId],
  );

  /** 面板里改窗口大小：改完立刻重拉 dashboard，水位马上跟着变 */
  const handleSetWindow = useCallback(
    async (tokens: number) => {
      if (activeConversation === null) return;
      setUsageLoading(true);
      try {
        await api.patchProviderContextWindow(activeConversation.providerId, tokens);
        await refreshProviders();
        await refreshDashboard();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setUsageLoading(false);
      }
    },
    [activeConversation, refreshProviders, refreshDashboard],
  );

  const handleCompact = async (): Promise<void> => {
    if (activeId === null || busy || compactionRunning) return;
    const conversationId = activeId;
    setCompactionRunning(true); setCompactionNotice(null);
    const report = (text: string): void => setCompactionNotice({ conversationId, text });
    const blocked = (missing: readonly (keyof typeof COMPACTION_DUTY_LABEL)[]): void => report(`本次未压缩、未发送压缩模型请求。尚缺：${missing.map((kind) => COMPACTION_DUTY_LABEL[kind]).join('、') || '有效三层收尾证据'}。请分别补齐后再检查；现在可以继续工作。`);
    try {
      const result = await api.compact(conversationId);
      if (result.blocked || result.code === 'duties_incomplete') blocked(result.missing ?? []);
      else if (result.compacted) report(`压缩已完成${result.compaction ? `：seq ${result.compaction.fromSeq}–${result.compaction.toSeq}` : ''}。原文仍保留，可在“日志 → 上下文压缩”按需回读。`);
      else report('本次没有完成压缩。请在“日志 → 上下文压缩”查看当前状态与区间；不自动重试，可以继续工作。');
      await refreshDashboard();
    } catch (cause) {
      if (cause instanceof ApiError && cause.compactionBlocked) blocked(cause.compactionBlocked.missing);
      else if (cause instanceof ApiError && cause.compactionFailure !== null) report(`${cause.compactionFailure.message}。没有自动重试；请先查看“日志 → 上下文压缩”的记录与原因。`);
      else report('压缩未完成。原始错误不在正文显示，请在“日志 → 上下文压缩”核对状态；不自动重试。');
    } finally { setCompactionRunning(false); }
  };

  /**
   * 自动跟随滚动：**只有彻底贴到底部时**才跟着走。
   * ★ 阈值取 2px 而不是 48px：48px 意味着"差一点没到底"也算贴底，
   *   用户明明停在倒数两行、却被继续往下推 —— 那正是"抢滚动"的手感来源。
   *   2px 只用来吸收浏览器亚像素取整（scrollTop 可能是小数）。
   */
  const AT_BOTTOM_PX = 2;
  const threadRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const lastView = useRef<string | null>(null);

  const handleThreadScroll = (): void => {
    const element = threadRef.current;
    if (element === null) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX;
  };

  useEffect(() => {
    const changedConversation = lastView.current !== view;
    lastView.current = view;
    // 切会话/切视图时总是跳到底 —— 那是"打开新内容"，不是"追着输出跑"
    if (changedConversation) stickToBottom.current = true;
    if (!stickToBottom.current) return;
    // ★ 直接设 scrollTop 到 scrollHeight（真正到底，gap=0）。
    //   用 scrollIntoView 的话，底部留白会让 gap 停在 7px 左右，
    //   而 2px 的贴底判据随即失效 ⇒ 自动跟随只生效一次。
    const element = threadRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [messages, streamText, view]);

  // 输入框随内容长高（上限由 CSS 的 max-height 兜住）
  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${String(Math.min(element.scrollHeight, 200))}px`;
  }, [draft]);

  const handleCreateProviderDone = (): void => {
    void refreshProviders();
  };

  /* ─────────────────── 归档管理（设置 → 归档）─────────────────── */
  /**
   * 归档列表**只在打开归档页时拉**：日常不需要它，每次启动都拉是白花请求。
   * ★ 项目用 `?includeArchived=1` 再过滤出 `archivedAt !== null`；
   *   会话用 `listConversations(true)` 同样过滤 —— 两个列表都只显示真正归档的。
   */
  const refreshArchive = useCallback(async () => {
    setArchiveLoading(true);
    setArchiveError(null);
    try {
      const [allConversations, allProjects] = await Promise.all([
        api.listConversations(true),
        api.listArchivedProjects(),
      ]);
      setArchivedConversations(allConversations.filter((item) => item.archivedAt !== null));
      setArchivedProjects(allProjects.filter((item) => item.archivedAt !== null));
    } catch (cause) {
      setArchiveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setArchiveLoading(false);
    }
  }, []);

  /** 统一的"做一件事 + 刷新两侧列表"包装：失败时把错误显出来而不是静默 */
  const runArchiveAction = useCallback(
    async (id: string, action: () => Promise<unknown>): Promise<void> => {
      setArchiveBusy(id);
      setArchiveError(null);
      try {
        await action();
        await Promise.all([refreshArchive(), refreshConversations(), refreshProjects()]);
      } catch (cause) {
        setArchiveError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setArchiveBusy(null);
      }
    },
    [refreshArchive, refreshConversations, refreshProjects],
  );

  const restoreConversation = useCallback(
    (id: string) => runArchiveAction(id, () => api.patchConversation(id, { archivedAt: null })),
    [runArchiveAction],
  );
  const purgeConversation = useCallback(
    (id: string) => runArchiveAction(id, () => api.deleteConversation(id)),
    [runArchiveAction],
  );
  const restoreProject = useCallback(
    (id: string) => runArchiveAction(id, () => api.updateProject(id, { archived: false })),
    [runArchiveAction],
  );
  const purgeProject = useCallback(
    (id: string, deleteFiles: boolean) => runArchiveAction(id, () => api.deleteProject(id, deleteFiles)),
    [runArchiveAction],
  );

  /**
   * ★ 归档数据在**归档面板挂载时**拉取。
   *   曾经写成「App 的 settingsTab === 'archive' 时拉」—— 错的：设置对话框的页签是
   *   **它自己的内部状态**，App 的 `settingsTab` 只会停在打开时那个值，所以那个 effect 从不触发。
   *   现在由面板挂载来触发，页面真正显示时才请求。
   */
  const archivePane = (
    <ArchivePane
      load={refreshArchive}
      archivedConversations={archivedConversations}
      archivedProjects={archivedProjects}
      busyId={archiveBusy}
      loading={archiveLoading}
      error={archiveError}
      onRestoreConversation={(id) => void restoreConversation(id)}
      onDeleteConversation={(id) => void purgeConversation(id)}
      onRestoreProject={(id) => void restoreProject(id)}
      onDeleteProject={(id, deleteFiles) => void purgeProject(id, deleteFiles)}
    />
  );

  /* ───────────── 侧栏工作区 / 项目右键菜单的动作 ───────────── */
  /**
   * 所有动作都走同一个包装：置 busy → 调接口 → 刷新列表 → 清 busy。
   * ★ 项目被改名/归档/删除后，`projects` 与 `conversations` 都可能变，
   *   所以两个都刷；工作区变化也影响左栏分组，同样刷。
   */
  const runSidebarAction = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      setSidebarBusy(true);
      setError(null);
      try {
        await action();
        await Promise.all([refreshWorkspaces(), refreshProjects(), refreshConversations()]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSidebarBusy(false);
      }
    },
    [refreshWorkspaces, refreshProjects, refreshConversations],
  );

  const handleNewConversation = async (): Promise<void> => {
    const provider = providers[0];
    if (provider === undefined) {
      // 没有连接时把用户直接带到「设置 → 模型」，而不是弹一个孤立的对话框
      setSettingsTab('models');
      return;
    }
    setError(null);
    try {
      const conversation = await api.createConversation({
        providerId: provider.id,
        // 模型跟着连接走：连接里存了默认模型就用它，否则退到 'default'
        model: provider.defaultModel ?? 'default',
        // ★ 新建时**不给标题**：让首轮结束后由模型起名（占位名会被 generateTitle 识别并替换）
        title: undefined,
        // ★ 权限档用设置里的默认值（这才是"设置"真的生效的地方）
        permissionMode: general.defaultPermissionMode,
        // ★ 新建对话继承当前选中的工作区/项目，省得每次两遍手点
        ...(activeConversation?.primaryWorkspaceId != null
          ? { workspaceId: activeConversation.primaryWorkspaceId }
          : {}),
        ...(activeConversation?.projectId != null ? { projectId: activeConversation.projectId } : {}),
      });
      await refreshConversations();
      setActiveId(conversation.id);
      setView('chat');

      // ★ 建完再把「默认思考强度 / 默认上下文窗口」落到这个新会话上 ——
      //   这两个字段 createConversation 不接，只能建完再 PATCH。
      //   失败不报错：会话已经建好了，偏好没写上不该让它看起来像失败。
      if (general.defaultThinkingEffort !== 'default') {
        void api
          .patchConversation(conversation.id, { thinkingEffort: general.defaultThinkingEffort })
          .catch(() => undefined);
      }
      void api
        .patchProviderContextWindow(provider.id, general.defaultContextWindow)
        .then(() => refreshProviders())
        .catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const applyPatch = async (patch: {
    projectId?: string | null;
    workspaceId?: string | null;
    permissionMode?: string;
    title?: string;
    model?: string;
    /** 跨连接选模型时一起切连接（服务端会校验连接存在与该连接的模型白名单） */
    providerId?: string;
  }): Promise<void> => {
    if (activeId === null) return;
    setError(null);
    try {
      const updated = await api.patchConversation(activeId, patch);
      setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      void refreshDashboard();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /**
   * 首轮结束后让模型起标题。
   * ★ 非阻塞：不 await，失败也不影响任何东西（后端在已有标题/没素材/上游失败时都静默返回）。
   * ★ 判定在后端（"标题还是占位才起"），前端不重复这份逻辑。
   */
  const maybeNameConversation = useCallback((conversationId: string): void => {
    void api
      .generateTitle(conversationId)
      .then((result) => {
        if (!result.titled) return;
        setConversations((current) =>
          current.map((item) => (item.id === conversationId ? { ...item, title: result.title } : item)),
        );
      })
      .catch(() => {
        /* 起标题失败什么都不做：不是用户的错，也不该弹红条 */
      });
  }, []);

  /** 从某条消息分支出新会话 */
  const handleBranch = async (seq: number): Promise<void> => {
    if (activeId === null) return;
    setError(null);
    try {
      const created = await api.branchConversation(activeId, seq);
      await refreshConversations();
      setActiveId(created.id);
      setView('chat');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 侧栏会话右键动作 */
  const handleSessionAction = async (conversationId: string, key: string): Promise<void> => {
    setMenu(null);
    setError(null);
    try {
      if (key === 'delete') {
        await api.deleteConversation(conversationId);
        await refreshConversations();
        return;
      }
      if (key === 'rename') {
        const target = conversations.find((item) => item.id === conversationId);
        const next = window.prompt('新的会话名称', target?.title ?? '');
        if (next === null) return;
        const name = next.trim();
        if (name.length === 0) return;
        const updated = await api.patchConversation(conversationId, { title: name });
        setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        return;
      }

      const now = new Date().toISOString();
      const patch =
        key === 'pin'
          ? { pinnedAt: now }
          : key === 'unpin'
            ? { pinnedAt: null }
            : key === 'archive'
              ? { archivedAt: now }
              : { archivedAt: null };
      const updated = await api.patchConversation(conversationId, patch);
      // 归档后该会话会从主列表消失 —— 直接整表重拉比手工删更稳
      if (key === 'archive') await refreshConversations();
      else setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 输入框右下角：换模型 */
  /**
   * 「提供商 → 模型」分组，供模型选择器按标签分类 + 搜索。
   * ★ 每个连接允许的模型 = 白名单 `enabledModels`；没设过白名单就回退 `defaultModel`（最保守）。
   * ★ 当前连接的列表用**探测结果**（可能比白名单多，因为网关报了什么就有什么）覆盖，
   *   其余连接不主动探测 —— 那会给每个连接都发一次网络请求，用户没要求。
   */
  const providerModelGroups = useMemo(() => {
    const groups = providers
      .map((provider) => {
        const declared =
          provider.enabledModels ?? (provider.defaultModel !== null ? [provider.defaultModel] : []);
        const list =
          provider.id === activeProvider?.id && models.length > 0 ? models : declared;
        return { providerId: provider.id, providerName: provider.name, models: list };
      })
      .filter((group) => group.models.length > 0);
    groups.sort((left, right) => {
      const leftCurrent = left.providerId === activeProvider?.id ? 0 : 1;
      const rightCurrent = right.providerId === activeProvider?.id ? 0 : 1;
      if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
      return left.providerName.localeCompare(right.providerName, 'zh');
    });
    return groups;
  }, [providers, models, activeProvider]);

  const handlePickModel = (model: string, providerId?: string): void => {
    /**
     * 只有**真的换了连接**才带 providerId：同连接内换模型时多传一个字段，
     * 万一服务端那侧校验更严（比如白名单），就会把一次无辜的换模型变成 400。
     */
    const patch: { model: string; providerId?: string } = { model };
    if (providerId !== undefined && providerId !== activeConversation?.providerId) {
      patch.providerId = providerId;
    }
    void applyPatch(patch);
  };

  /** 输入框右下角：换思考强度（`default` = 交给模型默认） */
  const handlePickEffort = (effort: string): void => {
    if (activeId === null) return;
    void api
      .patchConversation(activeId, { thinkingEffort: effort === 'default' ? null : effort })
      .then((updated) =>
        setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item))),
      )
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const handleCreateProject = async (): Promise<void> => {
    const name = dialogName.trim();
    if (name.length === 0) return;
    setError(null);
    try {
      const project = await api.createProject({ name });
      await refreshProjects();
      await applyPatch({ projectId: project.id });
      setDialog(null);
      setDialogName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleCreateWorkspace = async (): Promise<void> => {
    const path = dialogPath.trim();
    if (path.length === 0) return;
    setError(null);
    try {
      const workspace = await api.createWorkspace({
        name: dialogName.trim().length > 0 ? dialogName.trim() : path,
        path,
      });
      await refreshWorkspaces();
      await applyPatch({ workspaceId: workspace.id });
      setDialog(null);
      setDialogName('');
      setDialogPath('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleSend = async (): Promise<void> => {
    const content = draft.trim();
    if (content.length === 0 || activeId === null || busy) return;

    setDraft('');
    setBusy(true);
    setError(null);
    setStreamText('');
    setStreamReasoning('');

    try {
      await sendMessage(activeId, content, (event) => {
        if (event.type === 'user') {
          setMessages((current) => [...current, event.message]);
        } else if (event.type === 'reasoning') {
          setStreamReasoning((current) => current + event.delta);
        } else if (event.type === 'text') {
          setStreamText((current) => current + event.delta);
        } else if (event.type === 'assistant') {
          setMessages((current) => [...current, event.message]);
          setStreamText('');
          setStreamReasoning('');
        } else if (event.type === 'tool') {
          setMessages((current) => [...current, event.message]);
          setStreamText('');
          setStreamReasoning('');
        } else if (event.type === 'error') {
          setError(event.message);
        }
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setStreamReasoning('');
      void refreshConversations();
      void refreshDashboard();
      // ★ 这一轮结束后顺手让模型起个名（只在标题还是占位时才真的调，判定在后端）
      maybeNameConversation(activeId);
    }
  };

  /**
   * 停止正在生成的那一轮（发送键在输出中、输入框为空时会变成这个键）。
   * ★ 不自己把 busy 置 false：真正的收尾在 handleSend 的 finally 里（它会等到流真的结束）。
   *   这里只负责"把中止信号递过去"，否则界面会假装已经停了、其实后台还在写。
   */
  const handleStop = async (): Promise<void> => {
    if (activeId === null || !busy) return;
    try {
      const result = await api.stopTurn(activeId);
      // 已经结束了就不用弹东西 —— 停止键会被连点，报"已经结束"只会制造噪音
      if (!result.stopped) setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /**
   * 插话：模型输出中、输入框里有内容时，发送键照旧是"发送"，但语义是**排进当前这一轮**。
   * ★ 与"排队发送"的区别：插话不新开一轮，它会在下一个 step 之前被注入；
   *   所以它不会打断当前这一轮，也不会另起一条 user 消息进历史。
   */
  const handleInterject = async (): Promise<void> => {
    if (activeId === null) return;
    const content = draft.trim();
    if (content.length === 0) return;
    try {
      const result = await api.queueSteering(activeId, content);
      setDraft('');
      // 界面只有一个横幅位（error-bar）；插话成功用它报一句，比什么都不说强
      setError(`已插话：下一个步骤前会交给模型（当前排队 ${String(result.queued)} 条）`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const toggleGroup = (id: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hasConversation = activeConversation !== null;
  // 历史加载与 SSE 都保留原始消息，只在同一个展示投影里分流，避免空壳占位。
  const chatMessages = useMemo(() => messages.filter(isChatMessage), [messages]);

  return (
    <div
      className={`app ${inspectorOpen ? '' : 'inspector-closed'} ${inspectorSizing.dragging ? 'inspector-resizing' : ''}`}
      style={{ '--inspector-width': `${inspectorSizing.width}px` } as React.CSSProperties}
    >
      {/* ───────── 左栏 ───────── */}
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">
            <span className="mark">
              <IconStar size={17} />
            </span>
            瑶光
            <span className="tag">V0.3</span>
          </div>
        </div>

        <button type="button" className="new-chat" onClick={() => void handleNewConversation()}>
          <IconPlus size={14} />
          新对话
        </button>

        <div className="conv-scroll">
          <div className="side-section">
            <div className="side-label">
              工作区
              <button
                type="button"
                className="icon"
                title="登记工作区"
                onClick={() => {
                  setDialogName('');
                  setDialogPath('');
                  setDialog('workspace');
                }}
              >
                <IconPlus size={13} />
              </button>
            </div>

            {groups.length === 0 && <div className="side-empty">还没有工作区。先登记一个授权目录。</div>}

            {groups.map((group) => {
              const open = !collapsed.has(group.id);
              return (
                <div key={group.id} className="conv-group">
                  <button
                    type="button"
                    className="nav-item"
                    onClick={() => toggleGroup(group.id)}
                    onContextMenu={(event) => {
                      // ★ 只对真实登记的工作区开菜单；「独立会话」是虚拟分组（id='none'），没有可改的登记
                      if (group.workspaceId === null) return;
                      const workspace = workspaces.find((item) => item.id === group.workspaceId);
                      if (workspace === undefined) return;
                      event.preventDefault();
                      setSidebarMenu({
                        x: event.clientX,
                        y: event.clientY,
                        target: {
                          kind: 'workspace',
                          id: workspace.id,
                          name: workspace.name,
                          pinned: workspace.pinnedAt != null,
                        },
                      });
                    }}
                  >
                    <IconFolder size={13} />
                    <span className="title" title={group.rootPath}>
                      {group.name}
                    </span>
                    <span className="count">{group.conversations.length}</span>
                    {/* ★ 折叠箭头放行尾、默认透明：左侧不必为它留槽，图标天然对齐 */}
                    <span className={`chev ${open ? 'open' : 'closed'}`}>
                      <IconChevron size={11} />
                    </span>
                  </button>

                  {open &&
                    group.conversations.map((conversation) => (
                      <button
                        key={conversation.id}
                        type="button"
                        className={conversation.id === activeId ? 'conv-item active' : 'conv-item'}
                        onClick={() => {
                          setActiveId(conversation.id);
                          setView('chat');
                        }}
                        onContextMenu={(event) => {
                          // ★ 右键菜单要的是「这个会话」，不是「当前会话」——
                          //   所以位置与会话 id 一起存，不能靠 activeId。
                          event.preventDefault();
                          setMenu({ x: event.clientX, y: event.clientY, conversationId: conversation.id });
                        }}
                      >
                        {conversation.pinnedAt !== null && (
                          <span className="pin" title="已置顶">
                            ★
                          </span>
                        )}
                        <span className="title">{conversation.title ?? '新的对话'}</span>
                        {conversation.state === 'running' && <span className="dot" />}
                        <span className="time">{relTime(conversation.updatedAt)}</span>
                      </button>
                    ))}
                </div>
              );
            })}
          </div>

          <div className="side-section">
            <div className="side-label">更多</div>
            {/*
              ★ 原来这里还有「模型连接 / 插件 / 工具」—— 全是**配置**，不是日常操作。
                现在搬进「设置」（点头像 → 设置），侧栏只留真正天天用的「新建项目」。
            */}
            <button
              type="button"
              className="nav-item"
              onClick={() => {
                setDialogName('');
                setDialog('project');
              }}
            >
              <IconLayers size={13} />
              新建项目
              <span className="count">{projects.length}</span>
            </button>

            {/*
              ★ 已登记的项目列表（2026-11-09 用户要求「已注册的项目展示出来」）。
              右键可置顶 / 重命名 / 归档 / 删除 —— 归档保留共享目录里的文件，
              删除才可能连文件一起删（删除对话框里默认不删文件）。
            */}
            {projects.map((project) => {
              const isActive = project.id === activeConversation?.projectId;
              return (
                <button
                  key={project.id}
                  type="button"
                  className={isActive ? 'nav-item project-item active' : 'nav-item project-item'}
                  title={project.sharedDir}
                  onClick={() => void applyPatch({ projectId: project.id })}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSidebarMenu({
                      x: event.clientX,
                      y: event.clientY,
                      target: {
                        kind: 'project',
                        id: project.id,
                        name: project.name,
                        pinned: project.pinnedAt != null,
                        archived: project.archivedAt !== null,
                      },
                    });
                  }}
                >
                  {project.pinnedAt !== null && (
                    <span className="pin" title="已置顶">
                      ★
                    </span>
                  )}
                  <IconLayers size={13} />
                  <span className="title">{project.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="side-foot">
          {/*
            ★ 用户要求（2026-11-09）：把头像去掉，这里只留一个设置齿轮。
            原来是一个圆形头像按钮 + 弹出菜单（菜单里也只有「设置」一项）——
            一层菜单只为了一个入口，不如直接就是齿轮本身。
            连接状态仍以左侧小灯表示，鼠标悬停齿轮能看到文字状态。
          */}
          <button
            type="button"
            className="gear-button"
            title={`设置（${error === null ? '内核已连接' : '有错误'}）`}
            aria-label="设置"
            onClick={() => setSettingsTab('general')}
          >
            <IconSettings size={16} />
          </button>
          <span className="status">
            <span className={`led ${error === null ? 'on' : ''}`} />
            {error === null ? '内核已连接' : '有错误'}
          </span>
        </div>
      </aside>

      {/* ───────── 中栏 ───────── */}
      <main className="stage">
        <header className="chat-header">
          <div className="chat-title">
            <h1>{activeConversation?.title ?? '新对话'}</h1>
            <div className="chat-sub">
              {hasConversation ? (
                <>
                  <span>{activeConversation.model}</span>
                  <span className="sep">·</span>
                  <span>{PERMISSION_LABEL[activeConversation.permissionMode] ?? activeConversation.permissionMode}</span>
                  <span className="sep">·</span>
                  <span>{activeWorkspace?.name ?? '未绑定工作区'}</span>
                </>
              ) : (
                <span>选一个会话，或者直接开始新的</span>
              )}
            </div>
          </div>

          <div className="header-right">
            <div className="seg">
              <button type="button" className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')}>
                对话
              </button>
              <button type="button" className={view === 'trace' ? 'on' : ''} onClick={() => setView('trace')}>
                轨迹
              </button>
            </div>
            <button
              type="button"
              className="icon"
              title={inspectorOpen ? '收起右栏' : '展开右栏'}
              aria-label={inspectorOpen ? '收起右栏' : '展开右栏'}
              aria-expanded={inspectorOpen}
              aria-controls="session-inspector"
              onClick={() => setInspectorOpen((current) => !current)}
            >
              <IconPanel size={15} />
            </button>
          </div>
        </header>

        <div className="session-bar">
          <span className="chip">
            <span className="k">项目</span>
            <select
              value={activeConversation?.projectId ?? ''}
              disabled={!hasConversation}
              onChange={(event) => void applyPatch({ projectId: event.target.value === '' ? null : event.target.value })}
            >
              <option value="">独立对话</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </span>
          <button
            type="button"
            className="icon"
            title="新建项目"
            onClick={() => {
              setDialogName('');
              setDialog('project');
            }}
          >
            <IconPlus size={12} />
          </button>

          <span className="chip">
            <span className="k">工作区</span>
            <select
              value={activeConversation?.primaryWorkspaceId ?? ''}
              disabled={!hasConversation}
              onChange={(event) =>
                void applyPatch({ workspaceId: event.target.value === '' ? null : event.target.value })
              }
            >
              <option value="">未绑定</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </span>
          <button
            type="button"
            className="icon"
            title="登记工作区"
            onClick={() => {
              setDialogName('');
              setDialogPath('');
              setDialog('workspace');
            }}
          >
            <IconPlus size={12} />
          </button>

          <span className="chip">
            <span className="k">权限</span>
            <select
              value={activeConversation?.permissionMode ?? 'workspace'}
              disabled={!hasConversation}
              onChange={(event) => void applyPatch({ permissionMode: event.target.value })}
            >
              <option value="readonly">只读</option>
              <option value="workspace">工作区</option>
              <option value="project">项目</option>
              <option value="workspace_project">工作区 + 项目</option>
              <option value="full">完全权限（可用 shell）</option>
            </select>
          </span>

          <span className="grow" />
          {activeProject !== null && (
            <span className="path" title={activeProject.sharedDir}>
              共享目录 {activeProject.sharedDir}
            </span>
          )}
        </div>

        {error !== null && (
          <div className="error-bar" role="alert">
            <span style={{ marginTop: 1 }}>
              <IconAlert size={14} />
            </span>
            <span className="grow">{error}</span>
            <button type="button" className="icon" title="关闭" onClick={() => setError(null)}>
              <IconX size={13} />
            </button>
          </div>
        )}

        <div className="stage-body">
          {view === 'trace' ? (
            <TraceView events={dashboard?.events ?? []} />
          ) : (
            <div className="thread" ref={threadRef} onScroll={handleThreadScroll}>
              {chatMessages.length === 0 && !busy ? (
                <div className="thread-inner empty">
                  <div className="empty-hint">
                    <p>
                      {hasConversation
                        ? '这是一个新的会话。说点什么，或者让它去读写你授权的那几个目录。'
                        : '先登记一个工作区，再开一个对话。所有工具调用都在权限围栏内发生。'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="thread-inner">
                  {groupTurns(chatMessages).map((turn) => (
                    <TurnView
                      key={turn.key}
                      turn={turn}
                      onBranch={(seq) => void handleBranch(seq)}
                      busy={busy}
                    />
                  ))}

                  {streamReasoning.length > 0 && (
                    <section className="turn streaming-turn">
                      <div className="turn-body">
                        <Fold label="正在思考…" mono defaultOpen>
                          {streamReasoning}
                        </Fold>
                      </div>
                    </section>
                  )}

                  {(streamText.length > 0 || busy) && (
                    <section className="turn streaming-turn">
                      <div className="turn-body">
                        {streamText.length > 0 ? (
                          <Markdown text={streamText} />
                        ) : (
                          <div className="streaming">
                            <span className="dots">
                              <i />
                              <i />
                              <i />
                            </span>
                            正在处理
                          </div>
                        )}
                      </div>
                    </section>
                  )}
                  <div ref={bottomRef} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              ref={textareaRef}
              value={draft}
              rows={1}
              placeholder={hasConversation ? '输入消息，Enter 换行，Ctrl+Enter 发送' : '先选一个会话'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              disabled={busy || !hasConversation}
            />
            <div className="composer-bar">
              <button
                type="button"
                className="plus"
                title="新建对话"
                onClick={() => void handleNewConversation()}
              >
                <IconPlus size={15} />
              </button>
              <span className="grow" />
              <ModelPicker
                model={activeConversation?.model ?? ''}
                providerName={activeProvider?.name ?? '未连接'}
                models={models}
                providerId={activeConversation?.providerId ?? undefined}
                providerGroups={providerModelGroups}
                effort={activeConversation?.thinkingEffort ?? 'default'}
                efforts={['default', 'off', 'low', 'medium', 'high']}
                contextWindow={dashboard?.contextWindow ?? activeProvider?.contextWindow ?? 128_000}
                onPickModel={handlePickModel}
                onPickEffort={handlePickEffort}
                onSetContextWindow={(tokens) => void handleSetWindow(tokens)}
                disabled={!hasConversation}
              />
              {/*
                ★ 输出中（busy）+ 输入框为空 ⇒ 发送键变**停止键**（用户要求 ⑧）。
                ★ 输出中但输入框有内容 ⇒ **保留发送键**：这一下是"插话"，插进当前这一轮的下一个 step，
                  不新开一轮、也不打断正在跑的（比"先停再发"少一次往返，也少一次上下文重建）。
              */}
              {busy && draft.trim().length === 0 ? (
                <button
                  type="button"
                  className="send stop"
                  title="停止生成（已落库的内容不会丢）"
                  aria-label="停止生成"
                  onClick={() => void handleStop()}
                  disabled={!hasConversation}
                >
                  <IconStop size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="send"
                  title={busy ? '插话：排进当前这一轮的下一个步骤' : '发送（Ctrl+Enter）'}
                  onClick={() => void (busy ? handleInterject() : handleSend())}
                  disabled={!hasConversation || draft.trim().length === 0}
                >
                  <IconArrowUp size={15} />
                </button>
              )}
            </div>
          </div>

          <div className="status-line">
            {/* ① 轮 / 步 + 输出速度 —— 点开看使用统计 */}
            <button
              type="button"
              className="stat link"
              title="点开看使用统计"
              onClick={() => openUsage('usage')}
              disabled={!hasConversation}
            >
              <IconSteps size={12} />
              <b>{stats.turns}</b> 轮
              <span className="muted">{stats.steps}</span> 步
            </button>
            {stats.tokensPerSecond !== null && (
              <>
                <span className="sep">·</span>
                <button
                  type="button"
                  className="stat link"
                  title="点开看逐步用量"
                  onClick={() => openUsage('usage')}
                  disabled={!hasConversation}
                >
                  {stats.tokensPerSecond} tok/s
                </button>
              </>
            )}

            {/* ② 累计用量 + 缓存命中率 */}
            <span className="sep">·</span>
            <button
              type="button"
              className="stat link"
              title="点开看逐步用量"
              onClick={() => openUsage('usage')}
              disabled={!hasConversation}
            >
              <IconUsage size={12} />
              <b>{compactNumber(stats.totalTokens)}</b> tok
            </button>
            <span className="sep">·</span>
            <button
              type="button"
              className="stat link"
              title="点开看逐步用量"
              onClick={() => openUsage('usage')}
              disabled={!hasConversation}
            >
              缓存命中 {stats.cacheHitRate === null ? '—' : `${Math.round(stats.cacheHitRate * 100)}%`}
            </button>

            <span className="grow" />

            {/* ③ 上下文水位 —— 点开看「什么在占地方」 */}
            <button
              type="button"
              className={`stat water link ${waterLevel === 'high' ? 'high' : waterLevel === 'mid' ? 'mid' : ''}`}
              title="点开看上下文构成"
              onClick={() => openUsage('context')}
              disabled={!hasConversation}
            >
              <span
                className="ring"
                style={{ background: `conic-gradient(currentColor ${Math.max(waterPct, 2)}%, var(--line-2) 0)` }}
              />
              {waterText}
            </button>
          </div>
        </div>

        {/*
          ★ 用量 / 上下文改成**贴着底部的抽屉**，不再是遮罩弹窗 ——
            原来的 modal 会把整个对话糊上一层黑，想一边看数字一边看对话是做不到的。
            抽屉在文档流里占位（不遮内容），关掉就还给对话。
        */}
        {usageTab !== null && (
          <UsageDock
            tab={usageTab}
            onTab={(tab) => openUsage(tab)}
            detail={usageDetail}
            dashboard={dashboard}
            loading={usageLoading}
            onClose={() => setUsageTab(null)}
            onSetWindow={(tokens) => void handleSetWindow(tokens)}
          />
        )}
      </main>

      {/* ───────── 右栏 ───────── */}
      {inspectorOpen && (
        <>
          {inspectorSizing.bounds.drawer && (
            <button type="button" className="inspector-backdrop" aria-label="关闭右栏抽屉" onClick={() => setInspectorOpen(false)} />
          )}
          <div
            className="inspector-resizer"
            role="separator"
            tabIndex={0}
            aria-label="调整右栏宽度"
            aria-orientation="vertical"
            aria-controls="session-inspector"
            aria-valuemin={inspectorSizing.bounds.min}
            aria-valuemax={inspectorSizing.bounds.max}
            aria-valuenow={inspectorSizing.width}
            aria-valuetext={`${inspectorSizing.width} 像素`}
            title="拖拽调宽；←/→ 调整，Shift 加速，Home/End 最小/最大；双击恢复默认"
            {...inspectorSizing.separatorProps}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); setInspectorOpen(false); }
              else inspectorSizing.separatorProps.onKeyDown(event);
            }}
          />
        <aside id="session-inspector" className="inspector" aria-label="会话详情" onKeyDown={(event) => {
          if (event.key === 'Escape') setInspectorOpen(false);
        }}>
          <div className="inspector-head">
            <IconGauge size={14} />
            会话详情
            <span className="grow" />
            <button type="button" className="icon" title="收起" onClick={() => setInspectorOpen(false)}>
              <IconX size={13} />
            </button>
          </div>

          <div className="inspector-body">
            <MemoryPanel
              conversationId={activeConversation?.id ?? null}
              projectName={activeProject?.name}
              projectId={activeConversation?.projectId ?? null}
              providers={providers}
              conversations={conversations}
              refreshKey={dashboard?.messageCount ?? 0}
              visibleTabs={panelSettings.visibleTabs}
              defaultTab={panelSettings.defaultTab}
              /**
               * ★ 看板点进子代理对话 / 切回主对话（用户 2026-11-10）。
               *
               * 为什么"回主对话"的判据是 `agentRole`：主对话没有父会话，所以那个按钮
               * 只在**当前看的这条是子代理**时才该出现。子代理的 `parentConversationId`
               * 由服务端从会话行读（`/api/conversations/:id/delegations` 会告诉我们它属于谁），
               * 这里直接用 `activeConversation.parentConversationId`。
               */
              onOpenConversation={(conversationId) => {
                // 切走前先记住"从哪来的"，否则子代理里点"回主对话"会不知道回哪
                setActiveId(conversationId);
              }}
              {...(activeConversation?.parentConversationId === null || activeConversation?.parentConversationId === undefined
                ? {}
                : { onBackToParent: () => setActiveId(activeConversation.parentConversationId as string) })}
            />
            {dashboard === null ? (
              <p className="hint">选择主对话后查看当前工作；运行细节按需展开。</p>
            ) : (
              <details className="panel inspector-runtime" key={activeConversation?.id}>
                <summary>运行详情：提示词、上下文与审计</summary>
                <section className="panel">
                  <div className="panel-title">系统提示</div>
                  <p className="hint">
                    {promptChars === null ? '—' : `${promptChars} 字`} · 首条稳定 system；动态附加与派生回顾分区查看
                  </p>
                  <button type="button" className="small" onClick={() => setShowPrompt(true)}>
                    查看 / 编辑指令
                  </button>
                </section>

                <section className="panel">
                  <div className="panel-title">上下文</div>
                  <dl className="facts">
                    <dt>约 tokens</dt>
                    <dd>{compactNumber(dashboard.contextTokens)}</dd>
                    <dt>消息</dt>
                    <dd>{dashboard.messageCount}</dd>
                    <dt>压缩段</dt>
                    <dd>{dashboard.compactions.length}</dd>
                    <dt>工作区</dt>
                    <dd>{dashboard.workspace?.name ?? '未绑定'}</dd>
                    <dt>项目</dt>
                    <dd>{dashboard.project?.name ?? '独立对话'}</dd>
                  </dl>
                  <button
                    type="button"
                    className="small"
                    disabled={busy || compactionRunning || dashboard.messageCount < 8}
                    onClick={() => void handleCompact()}
                  >
                    {compactionRunning ? '正在检查并压缩…' : '压缩较早历史'}
                  </button>
                  <p className="hint">手动与自动都须台账更新、进展日志、triage 三项分别成功；缺项不发压缩请求、不旁路，可以继续工作。原文在“日志 → 上下文压缩”按需回读。</p>
                  {compactionNotice?.conversationId === activeId && <p className="hint" role="status">{compactionNotice.text}</p>}
                </section>

                <section className="panel">
                  <div className="panel-title">压缩档案</div>
                  <details open={compactionLogsFor === activeId} onToggle={(event) => setCompactionLogsFor(event.currentTarget.open ? activeId : null)}>
                    <summary>上下文压缩日志与原文回读</summary>
                    {activeId !== null && compactionLogsFor === activeId && <ConversationCompactionLog conversationId={activeId} refreshKey={dashboard.messageCount} />}
                  </details>
                  {dashboard.compactions.length === 0 ? (
                    <p className="hint">还没有压缩过。</p>
                  ) : (
                    dashboard.compactions.map((row) => (
                      <details key={row.id} className="compaction-item">
                        <summary>
                          seq {row.fromSeq}–{row.toSeq}
                        </summary>
                        <p>{row.summary}</p>
                        <p className="hint">
                          可取回：recall(from_seq={row.fromSeq}, to_seq={row.toSeq})
                        </p>
                      </details>
                    ))
                  )}
                </section>

                <section className="panel">
                  <div className="panel-title">审计</div>
                  <div className="counts">
                    <span className="count-pill">
                      工具 <b>{dashboard.counts['tool_call'] ?? 0}</b>
                    </span>
                    <span
                      className={`count-pill ${(dashboard.counts['policy_denied'] ?? 0) > 0 ? 'bad' : ''}`}
                    >
                      被拒绝 <b>{dashboard.counts['policy_denied'] ?? 0}</b>
                    </span>
                    <span className={`count-pill ${(dashboard.counts['tool_error'] ?? 0) > 0 ? 'warn' : ''}`}>
                      工具错误 <b>{dashboard.counts['tool_error'] ?? 0}</b>
                    </span>
                  </div>
                  <ul className="events">
                    {dashboard.events
                      .slice(-8)
                      .reverse()
                      .map((event) => (
                        <li key={event.id}>
                          <span className={`kind ${event.kind}`}>{KIND_LABEL[event.kind] ?? event.kind}</span>
                          <span className="what">
                            {typeof event.payload?.['tool'] === 'string' ? String(event.payload['tool']) : '—'}
                          </span>
                          <span>#{event.stepNo}</span>
                        </li>
                      ))}
                    {dashboard.events.length === 0 && <li className="hint">还没有步骤记录。</li>}
                  </ul>
                  <p className="hint">只记工具名与结果状态，不记 prompt 正文与参数原文。</p>
                </section>
              </details>
            )}
          </div>
        </aside>
        </>
      )}

      {/* 侧栏工作区 / 项目右键菜单（置顶 / 重命名 / 归档 / 删除） */}
      {sidebarMenu !== null && (
        <SidebarMenu
          target={sidebarMenu.target}
          x={sidebarMenu.x}
          y={sidebarMenu.y}
          busy={sidebarBusy}
          onClose={() => setSidebarMenu(null)}
          onPin={(nextPinned) => {
            const { target } = sidebarMenu;
            setSidebarMenu(null);
            void runSidebarAction(() =>
              target.kind === 'workspace'
                ? api.updateWorkspace(target.id, { pinned: nextPinned })
                : api.updateProject(target.id, { pinned: nextPinned }),
            );
          }}
          onRename={(nextName) => {
            const { target } = sidebarMenu;
            setSidebarMenu(null);
            void runSidebarAction(() =>
              target.kind === 'workspace'
                ? api.updateWorkspace(target.id, { name: nextName })
                : api.updateProject(target.id, { name: nextName }),
            );
          }}
          onArchive={(nextArchived) => {
            const { target } = sidebarMenu;
            setSidebarMenu(null);
            if (target.kind !== 'project') return;
            void runSidebarAction(() => api.updateProject(target.id, { archived: nextArchived }));
          }}
          onDelete={(deleteFiles) => {
            const { target } = sidebarMenu;
            setSidebarMenu(null);
            void runSidebarAction(() =>
              target.kind === 'workspace'
                ? api.deleteWorkspace(target.id)
                : api.deleteProject(target.id, deleteFiles),
            );
          }}
        />
      )}

      {/* ───────── 弹窗 ───────── */}
      {menu !== null && (
        <SessionMenu
          x={menu.x}
          y={menu.y}
          items={[
            ...(conversations.find((item) => item.id === menu.conversationId)?.pinnedAt != null
              ? [{ key: 'unpin', label: '取消置顶' }]
              : [{ key: 'pin', label: '置顶' }]),
            { key: 'rename', label: '重命名' },
            { key: 'divider-1', label: '', divider: true },
            { key: 'archive', label: '归档' },
            { key: 'divider-2', label: '', divider: true },
            { key: 'delete', label: '删除', danger: true },
          ]}
          onPick={(key) => void handleSessionAction(menu.conversationId, key)}
          onClose={() => setMenu(null)}
        />
      )}

      {/* ───────── 设置（点头像 → 设置） ───────── */}
      {settingsTab !== null && (
        <SettingsDialog
          initialTab={settingsTab}
          providers={providers}
          plugins={plugins}
          permissionMode={activeConversation?.permissionMode ?? 'workspace'}
          general={general}
          onGeneral={(patch) => {
            // ★ 服务端是唯一真源：失败时 hook 会回滚，这里只把错误显出来
            void settings.updateGeneral(patch).catch((cause: unknown) => setError(String(cause)));
          }}
          panes={{
            project: (
              <ProjectPanelSettings
                scopeLabel={
                  activeProject === null
                    ? '默认（没有绑定项目的对话）'
                    : `项目：${activeProject.name}`
                }
                panel={panelSettings}
                allowedTabs={activeProjectId === null ? PANEL_TABS_WITHOUT_PROJECT : PANEL_TABS}
                onChange={(patch) => {
                  void settings.updatePanel(activeProjectId, patch).catch((cause: unknown) => setError(String(cause)));
                }}
              />
            ),
            archive: archivePane,
            mcp: <McpPanel permissionMode={activeConversation?.permissionMode ?? 'workspace'} />,
          }}
          onClose={() => setSettingsTab(null)}
          onChanged={handleCreateProviderDone}
        />
      )}

      {showPrompt && activeId !== null && (
        <PromptDialog
          conversationId={activeId}
          onClose={() => setShowPrompt(false)}
          onSaved={() => {
            void api
              .getPrompt(activeId)
              .then((info) => setPromptChars(info.text.length))
              .catch(() => setPromptChars(null));
          }}
        />
      )}

      {dialog !== null && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{dialog === 'project' ? '新建项目' : '登记工作区'}</h2>
            {dialog === 'project' ? (
              <>
                <p className="hint">
                  项目共享目录由程序创建在数据根下（<code>~/.alkaid/projects/&lt;id&gt;/shared</code>），它不在任何工作区
                  里，因此删对话碰不到它。
                </p>
                <label>
                  项目名称
                  <input value={dialogName} onChange={(event) => setDialogName(event.target.value)} />
                </label>
              </>
            ) : (
              <>
                <p className="hint">
                  工作区是<strong>授权目录</strong>：填一个真实存在的文件夹路径。登记只记路径，不复制文件。
                </p>
                <label>
                  名称（可留空）
                  <input value={dialogName} onChange={(event) => setDialogName(event.target.value)} />
                </label>
                <label>
                  目录路径
                  <input
                    value={dialogPath}
                    placeholder="D:\\work\\my-project"
                    onChange={(event) => setDialogPath(event.target.value)}
                  />
                </label>
                {/*
                  ★ ⑥ 桌面端才有的「选择文件夹…」：走 preload 暴露的 window.alkaidDesktop。
                  ★ 浏览器里没有这个对象 ⇒ 按钮不显示，手输路径照旧可用（不是降级体验，是两种形态）。
                  ★ pickDirectory 永不 reject，null = 用户取消或对话框失败 —— 两者都不当错误处理。
                */}
                {desktopBridge !== null && (
                  <button
                    type="button"
                    className="small"
                    onClick={() => {
                      void desktopBridge.pickDirectory().then((picked) => {
                        if (picked === null) return;
                        setDialogPath(picked);
                        if (dialogName.trim().length === 0) setDialogName(picked);
                      });
                    }}
                  >
                    <IconFolder size={12} /> 选择文件夹…
                  </button>
                )}
              </>
            )}
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void (dialog === 'project' ? handleCreateProject() : handleCreateWorkspace())}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
