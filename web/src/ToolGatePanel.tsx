import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import {
  api,
  type ToolGateDto,
  type ToolGateToolDto,
  type ToolModeDto,
  type ToolTemplateDto,
} from './api.ts';
import { IconCheck, IconChevron, IconTerminal } from './icons.tsx';
import './tool-gate.css';

/**
 * 工具可见性门控（仿用户给 DSH 写的那个插件，2026-11-10）。
 *
 * ## 为什么重做（用户的评价与要求）
 * 旧的工具面板是一长串平铺的三态按钮：看不出**每一组有多大**、**占多少上下文**、**多久没用**，
 * 也不知道"关掉这一组能省多少"。用户要的是：
 * 一行一组（勾选 + 个数 + 体积 + 约多少 token + 最近使用），可展开到单个工具，可批量、可存模板。
 *
 * ## 两层语义（v18）
 * - `conversationId === null` ⇒ 改的是**全局默认**
 * - 有 `conversationId` ⇒ 改的是**这个对话**，只存差异；「跟随全局」= 删掉这条覆盖
 *
 * ## 保存模型
 * 面板里改的都是**草稿**（`draft`），点保存才逐条发 `PATCH`。
 * ★ 不整表提交：两个窗口各改一个工具，后保存的不会把前一个回退。
 */
type Draft = Map<string, ToolModeDto | 'inherit'>;

const MODE_LABEL: Record<ToolModeDto, string> = { resident: '常驻', lazy: '按需', disabled: '关闭' };
const MODES: readonly ToolModeDto[] = ['resident', 'lazy', 'disabled'];

function kb(chars: number): string {
  const kbValue = chars / 1024;
  return kbValue >= 1024 ? `${(kbValue / 1024).toFixed(1)} MB` : `${kbValue.toFixed(1)} KB`;
}

function tok(chars: number): string {
  return `~${String(Math.round(chars / 3.5 / 100) / 10)}k tok`;
}

/** 相对时间：从未 / N 分钟前 / N 小时前 / N 天前 */
function ago(iso: string | null): string {
  if (iso === null) return '从未';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '未知';
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  return `${String(Math.round(hours / 24))} 天前`;
}

/** 一组工具（内置分类 / 一个 MCP 服务器 / 一个插件） */
type Group = {
  key: string;
  label: string;
  hint: string;
  tools: ToolGateToolDto[];
};

export function ToolGatePanel(props: {
  /** `null` = 全局默认（设置页）；否则是这个对话的工具集 */
  conversationId: string | null;
  /** 对话框里显示的标题后缀，例如对话标题 */
  scopeLabel?: string;
  onClose: () => void;
  /** 保存后通知外层刷新（对话页可能要重算"这一轮发什么"） */
  onSaved?: () => void;
}): ReactElement {
  const { conversationId } = props;
  const [data, setData] = useState<ToolGateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.getToolGate({
        ...(conversationId === null ? {} : { conversationId }),
      });
      if (!alive.current) return;
      setData(next);
      setDraft(new Map());
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load]);

  /** 读"当前应显示的值"：草稿优先，其次是库里的值 */
  const modeOf = useCallback((tool: ToolGateToolDto): ToolModeDto => {
    const staged = draft.get(tool.name);
    if (staged === undefined) return tool.mode;
    return staged === 'inherit' ? tool.globalMode : staged;
  }, [draft]);

  const dirtyNames = useMemo(() => [...draft.keys()], [draft]);

  /** 分组：内置按 `group`，MCP / 插件按来源归拢（名字前缀由内核保证唯一，这里只做归类展示） */
  const groups = useMemo<Group[]>(() => {
    if (data === null) return [];
    const buckets = new Map<string, Group>();
    const push = (key: string, label: string, hint: string, tool: ToolGateToolDto): void => {
      const existing = buckets.get(key) ?? { key, label, hint, tools: [] };
      existing.tools.push(tool);
      buckets.set(key, existing);
    };
    for (const tool of data.tools) {
      if (!tool.visibleInMode) continue; // 这一档权限根本看不见的，不该出现在门控里
      /**
       * ★★ 归属**只认服务端给的** `ownerKey/ownerLabel`（2026-11-11 审计 `ALK-HIGH-09`）。
       *
       * 上一版这里按 `__` 切工具名 —— 而真实形状是 `mcp_<服务器>_<工具>` / `p_<插件>_<工具>`，
       * 单下划线，且服务器名自己就可能带下划线、超长还会被截断加哈希。
       * 于是 `includes('__')` 恒为 false：所有 MCP 坍进一个 "mcp" 组、所有插件坍进 "plugin"，
       * 按服务器看体积、按组开关全都做不到。
       */
      if (tool.ownerKey !== null && tool.ownerLabel !== null) {
        push(tool.ownerKey, tool.ownerLabel, tool.ownerHint ?? '', tool);
        continue;
      }
      push(`builtin:${tool.group}`, tool.group, '内置分类', tool);
    }
    return [...buckets.values()].sort((left, right) => right.tools.length - left.tools.length);
  }, [data]);

  const visibleGroups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return groups;
    return groups
      .map((group) => ({
        ...group,
        tools: group.tools.filter((tool) => tool.name.toLowerCase().includes(needle) || tool.oneLiner.toLowerCase().includes(needle)),
      }))
      .filter((group) => group.tools.length > 0);
  }, [groups, filter]);

  const groupStats = (group: Group): { chars: number; used: string; enabled: number } => {
    let chars = 0;
    let enabled = 0;
    let latest: string | null = null;
    for (const tool of group.tools) {
      chars += tool.sizeChars;
      if (modeOf(tool) !== 'disabled') enabled += 1;
      if (tool.lastUsedAt !== null && (latest === null || Date.parse(tool.lastUsedAt) > Date.parse(latest))) {
        latest = tool.lastUsedAt;
      }
    }
    return { chars, used: ago(latest), enabled };
  };

  const stage = (name: string, mode: ToolModeDto | 'inherit'): void => {
    setNotice(null);
    setDraft((current) => {
      const next = new Map(current);
      next.set(name, mode);
      return next;
    });
  };

  const stageGroup = (group: Group, mode: ToolModeDto | 'inherit'): void => {
    setNotice(null);
    setDraft((current) => {
      const next = new Map(current);
      for (const tool of group.tools) next.set(tool.name, mode);
      return next;
    });
  };

  const save = async (): Promise<void> => {
    if (dirtyNames.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const name of dirtyNames) {
        const staged = draft.get(name);
        if (staged === undefined) continue;
        if (staged === 'inherit') {
          // 「跟随全局」= 删掉会话覆盖；全局层没有"跟随"的概念，退回代码默认
          await api.patchToolGate({ name, reset: true, ...(conversationId === null ? {} : { conversationId }) });
        } else {
          await api.patchToolGate({ name, mode: staged, ...(conversationId === null ? {} : { conversationId }) });
        }
      }
      setNotice(`已保存 ${String(dirtyNames.length)} 项${conversationId === null ? '' : '到本对话'}`);
      await load();
      props.onSaved?.();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const applyTemplate = async (template: ToolTemplateDto): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.applyToolTemplate(template.id, conversationId);
      setNotice(`已套用「${template.name}」：${String(result.changed)} 项`);
      await load();
      props.onSaved?.();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const saveTemplate = async (): Promise<void> => {
    const name = templateName.trim();
    if (name.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.createToolTemplate({ name, ...(conversationId === null ? {} : { conversationId }) });
      setTemplateName('');
      setNotice(`模板「${name}」已保存`);
      await load();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const totalChars = (data?.summary.residentChars ?? 0) + (data?.summary.lazyChars ?? 0);
  const offGroups = groups.filter((group) => groupStats(group).enabled === 0).length;

  return (
    <div className="tool-gate">
      <header className="tg-head">
        <div>
          <h3>工具可见性门控</h3>
          <p className="tg-sub">
            {conversationId === null ? '全局默认' : `本对话 · ${props.scopeLabel ?? conversationId.slice(0, 8)}`}
            {' · '}
            {String(data?.tools.filter((tool) => tool.visibleInMode).length ?? 0)} 个工具 · {String(offGroups)} 组关闭
            {conversationId === null ? '' : ` · ${String(data?.summary.overridden ?? 0)} 项本对话覆盖`}
          </p>
        </div>
        <div className="tg-head-actions">
          <button type="button" className="small" onClick={() => void load()} disabled={busy}>刷新</button>
          <button type="button" className="small" onClick={props.onClose}>关闭</button>
        </div>
      </header>

      {error !== null && <p className="tg-error" role="alert">{error}</p>}
      {notice !== null && <p className="tg-notice" role="status">{notice}</p>}

      <div className="tg-filter">
        <input
          value={filter}
          placeholder="搜索工具名或说明…"
          aria-label="搜索工具"
          onChange={(event) => { setFilter(event.target.value); }}
        />
        <span className="tg-total">
          常驻表 ≈ {kb(totalChars)}（{tok(totalChars)}）
        </span>
      </div>

      <div className="tg-groups">
        {visibleGroups.map((group) => {
          const stats = groupStats(group);
          const isOpen = expanded.has(group.key);
          const isCollapsed = collapsed.has(group.key);
          const allOn = group.tools.every((tool) => modeOf(tool) !== 'disabled');
          return (
            <section className={`tg-group ${isCollapsed ? 'collapsed' : ''}`} key={group.key}>
              <div className="tg-row">
                <button
                  type="button"
                  className="tg-tri"
                  aria-expanded={isCollapsed ? false : true}
                  title={isCollapsed ? '展开' : '收起'}
                  onClick={() => {
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      setExpanded((currentExpanded) => {
                        const nextExpanded = new Set(currentExpanded);
                        if (next.has(group.key)) nextExpanded.delete(group.key);
                        return nextExpanded;
                      });
                      return next;
                    });
                  }}
                >
                  <IconChevron size={10} />
                </button>
                <input
                  type="checkbox"
                  className="tg-check"
                  aria-label={`整组启用 ${group.label}`}
                  checked={allOn}
                  disabled={busy}
                  onChange={(event) => { stageGroup(group, event.target.checked ? 'inherit' : 'disabled'); }}
                />
                <span className="tg-name">{group.label}</span>
                <span className="tg-hint">{group.hint}</span>
                <span className="tg-stats">
                  {String(group.tools.length)} 个 · {kb(stats.chars)} · {tok(stats.chars)} · {stats.used}
                </span>
                <button
                  type="button"
                  className="tg-expand"
                  title="展开到这个组的每个工具"
                  onClick={() => {
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    });
                    setCollapsed((current) => {
                      const next = new Set(current);
                      next.delete(group.key);
                      return next;
                    });
                  }}
                >
                  {isOpen ? '收起明细' : '明细'}
                </button>
              </div>

              {!isCollapsed && isOpen && (
                <div className="tg-tools">
                  {group.tools.map((tool) => {
                    const staged = draft.get(tool.name);
                    const current = modeOf(tool);
                    return (
                      <div className={`tg-tool ${staged === undefined ? '' : 'staged'}`} key={tool.name}>
                        <span className="tg-tool-name" title={tool.name}>{tool.displayName || tool.name}</span>
                        <span className="tg-tool-oneliner" title={tool.oneLiner}>{tool.oneLiner}</span>
                        <span className="tg-tool-stats">
                          {kb(tool.sizeChars)} · {tok(tool.sizeChars)}
                          {tool.useCount > 0 ? ` · 用过 ${String(tool.useCount)} 次` : ''} · {ago(tool.lastUsedAt)}
                        </span>
                        <span className="tg-seg" role="group" aria-label={`${tool.name} 三态`}>
                          {MODES.map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              className={current === mode ? 'on' : ''}
                              disabled={busy}
                              onClick={() => { stage(tool.name, mode); }}
                            >
                              {MODE_LABEL[mode]}
                            </button>
                          ))}
                          {conversationId !== null && (
                            <button
                              type="button"
                              className={staged === 'inherit' || (staged === undefined && !tool.overridden) ? 'on inherit' : 'inherit'}
                              disabled={busy}
                              title="不覆盖：跟随全局默认"
                              onClick={() => { stage(tool.name, 'inherit'); }}
                            >
                              跟随全局
                            </button>
                          )}
                        </span>
                        {tool.overridden && staged === undefined && <span className="tg-badge">本对话已覆盖</span>}
                        {staged !== undefined && <span className="tg-badge staged">未保存</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
        {visibleGroups.length === 0 && <p className="tg-empty">没有匹配的工具。</p>}
      </div>

      <div className="tg-savebar">
        <span className="tg-dirty">
          {dirtyNames.length === 0 ? '没有未保存的改动' : `未保存 ${String(dirtyNames.length)} 项`}
        </span>
        <div className="tg-savebar-actions">
          <button type="button" className="small" disabled={busy || dirtyNames.length === 0} onClick={() => { setDraft(new Map()); setNotice(null); }}>
            放弃
          </button>
          <button type="button" className="small primary" disabled={busy || dirtyNames.length === 0} onClick={() => void save()}>
            保存
          </button>
          {conversationId !== null && (
            <button
              type="button"
              className="small"
              disabled={busy}
              title="清空本对话的全部覆盖，整体回到跟随全局"
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    const result = await api.resetConversationTools(conversationId);
                    setNotice(`已清空 ${String(result.cleared)} 项覆盖，本对话回到跟随全局`);
                    await load();
                    props.onSaved?.();
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  } finally {
                    if (alive.current) setBusy(false);
                  }
                })();
              }}
            >
              全部跟随全局
            </button>
          )}
        </div>
      </div>

      <details className="tg-templates" open>
        <summary>模板（{String(data?.templates.length ?? 0)}）</summary>
        <ul className="tg-template-list">
          {(data?.templates ?? []).map((template) => (
            <li key={template.id}>
              <span className="tg-template-name">
                {template.name}
                {template.isDefault && <span className="tg-badge default"><IconCheck size={10} /> 默认</span>}
              </span>
              <span className="tg-template-actions">
                <button type="button" className="small" disabled={busy} onClick={() => void applyTemplate(template)}>套用</button>
                {!template.isDefault && (
                  <button
                    type="button"
                    className="small"
                    disabled={busy}
                    onClick={() => {
                      void api.setDefaultToolTemplate(template.id).then(() => load(), (cause: unknown) => {
                        setError(cause instanceof Error ? cause.message : String(cause));
                      });
                    }}
                  >
                    设为默认
                  </button>
                )}
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    void api.deleteToolTemplate(template.id).then(() => load(), (cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    });
                  }}
                >
                  删除
                </button>
              </span>
            </li>
          ))}
          {(data?.templates.length ?? 0) === 0 && <li className="tg-empty-line">还没有模板。</li>}
        </ul>
        <form
          className="tg-template-new"
          onSubmit={(event) => { event.preventDefault(); void saveTemplate(); }}
        >
          <input
            value={templateName}
            placeholder="给当前这套起个名字…"
            aria-label="新模板名"
            maxLength={40}
            onChange={(event) => { setTemplateName(event.target.value); }}
          />
          <button type="submit" className="small" disabled={busy || templateName.trim().length === 0}>存为模板</button>
        </form>
        <p className="tg-foot">
          <span>提示：隐藏后模型看不到，但工具仍在注册表里（执行层另判权限）。</span>
          <span>每次保存会让缓存前缀失效一次。</span>
        </p>
      </details>
    </div>
  );
}

/** 输入框下面那个按钮用的：本对话工具集的小结（"常驻 N / 按需 M / 关闭 K"） */
export function ToolGateSummaryButton(props: {
  conversationId: string | null;
  disabled?: boolean;
  onClick: () => void;
  summary: string;
}): ReactElement {
  return (
    <button
      type="button"
      className="tool-gate-trigger"
      title="调整这个对话的工具集"
      aria-label="工具集"
      disabled={props.disabled === true}
      onClick={props.onClick}
    >
      <IconTerminal size={12} />
      {props.summary}
    </button>
  );
}
