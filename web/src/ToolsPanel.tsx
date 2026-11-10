import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { api, type McpServerDto, type PluginDto, type ToolListDto, type ToolModeDto, type ToolSettingDto } from './api.ts';
import { IconAlert, IconCheck, IconChevron, IconSteps, IconX } from './icons.tsx';

/**
 * 工具管理面板。
 *
 * ## ★★★ 三条界面判据（都是踩过坑之后的结论）
 *
 * 1. **三态必须是三态，不能是开关**。
 *    开关只能表达「开 / 关」，而「按需加载」是第三种状态 —— 用开关做就会逼用户在
 *    「全塞进上下文」和「用不了」之间二选一。参照项目也是分段控件，不是开关。
 *
 * 2. **「看不见」与「被关闭」必须在界面上分得开**。
 *    权限档挡住时 `visibleInMode: false` —— 这不是用户的选择，不能说成"你关掉了它"。
 *    两者混在一起，用户会去改一个根本改不动的开关。
 *
 * 3. **改完立刻回读**，不以本地 state 为准。
 *    「设置存了 ≠ 生效」是这个项目栽过的坑；回读一次的成本远低于信任一次。
 *
 * ## ★ 分组（2026-11-09 用户要求）
 * 顶层按**来源**分三类：**内置工具 / MCP 工具 / 插件工具**。
 * - 内置：再按功能组（文件 / 命令 / 上下文 / 历史 / 配置）。
 * - MCP：按**服务器**分组，每组有整组批量（常驻 / 按需 / 关闭）——
 *   一个 MCP 动辄几十个工具，逐个点谁都受不了。
 * - 插件：按**插件**分组，同样有整组批量。
 * 归属靠 `mcpServers[].toolNames` / `plugins[].toolNames` 反查（不靠名字前缀猜：
 * 服务器名里本来就可能带下划线，切不出来）。
 */

const MODE_LABEL: Record<ToolModeDto, string> = {
  resident: '常驻',
  lazy: '按需',
  disabled: '关闭',
};

const MODE_HINT: Record<ToolModeDto, string> = {
  resident: '完整参数每轮都发给模型（最快，也最占上下文）',
  lazy: '只在目录里留一句话，用时由模型自己展开（省上下文，多一次往返）',
  disabled: '完全不出现，模型看不到也不会尝试调用',
};

const GROUP_LABEL: Record<string, string> = {
  files: '文件',
  shell: '命令',
  context: '上下文',
  history: '历史',
  plugin: '插件',
  mcp: 'MCP',
  setup: '配置',
};

const KIND_LABEL: Record<string, string> = {
  read_only: '只读',
  write_local: '写本机',
  external: '外网',
};

const SOURCE_LABEL: Record<string, string> = {
  builtin: '内置',
  plugin: '插件',
  mcp: 'MCP',
};

export function ToolsPanel({
  permissionMode,
  onClose,
}: {
  permissionMode: string;
  onClose: () => void;
}): ReactElement {
  const [data, setData] = useState<ToolListDto | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerDto[]>([]);
  const [plugins, setPlugins] = useState<PluginDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 展开完整说明的（默认折叠 —— 一屏放得下二十个工具才可用） */
  const [expanded, setExpanded] = useState<string | null>(null);
  /**
   * 折叠起来的分类（group key 集合）。
   * ★ 临时视图状态，**不落盘**：用户这次想收起哪个分类，下次打开未必还想收着。
   */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  const load = useCallback(async (): Promise<void> => {
    try {
      /**
       * 三份都要：工具列表 + MCP 服务器 + 插件。
       * 后两份提供 `toolNames`，用来把工具**归到哪个服务器 / 哪个插件**名下 ——
       * 不靠工具名前缀去切（服务器名本身可能带下划线，切出来会错）。
       */
      const [tools, servers, pluginList] = await Promise.all([
        api.listTools(permissionMode),
        api.listMcpServers().catch(() => [] as McpServerDto[]),
        api.listPlugins().catch(() => [] as PluginDto[]),
      ]);
      setData(tools);
      setMcpServers(servers);
      setPlugins(pluginList);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [permissionMode]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 改一个工具的三态：发请求 → **重新拉一遍**（不信本地 state） */
  const change = async (name: string, mode: ToolModeDto): Promise<void> => {
    setBusy(name);
    try {
      await api.setToolMode(name, mode);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const reset = async (name: string): Promise<void> => {
    setBusy(name);
    try {
      await api.resetToolMode(name);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const resetAll = async (): Promise<void> => {
    setBusy('__all__');
    try {
      await api.resetAllTools();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  /**
   * 整组批量。
   * - MCP：走 `setMcpGroupMode` —— 服务端一次把该服务器的**全部工具**写进 `tool_settings`，
   *   并且**不会覆盖用户单独改过的那些**（判定：该行是否还等于上一轮的组默认）。
   * - 内置分类 / 插件：没有专用端点，逐个 `setToolMode` 即可。
   * 两条路都**改完回读**，不信本地 state。
   */
  const batch = async (kind: 'mcp' | 'names', id: string, names: readonly string[], mode: ToolModeDto): Promise<void> => {
    setBusy(`group:${id}`);
    try {
      if (kind === 'mcp') {
        await api.setMcpGroupMode(id, mode);
      } else {
        for (const name of names) await api.setToolMode(name, mode);
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  // 顶层按来源分三类；再按归属（服务器 / 插件）或功能组细分
  const all = data?.tools ?? [];
  const builtin = all.filter((tool) => tool.source === 'builtin');
  const mcpTools = all.filter((tool) => tool.source === 'mcp');
  const pluginTools = all.filter((tool) => tool.source === 'plugin');

  /** 功能组（内置工具用） */
  const builtinGroups = new Map<string, ToolSettingDto[]>();
  for (const tool of builtin) {
    const bucket = builtinGroups.get(tool.group) ?? [];
    bucket.push(tool);
    builtinGroups.set(tool.group, bucket);
  }

  /** 归属映射：工具名 → 所属服务器 / 插件（靠 toolNames 反查，不猜前缀） */
  const ownerOf = new Map<string, { kind: 'mcp' | 'plugin'; id: string; label: string; groupMode?: ToolModeDto }>();
  for (const server of mcpServers) {
    for (const name of server.toolNames) {
      ownerOf.set(name, { kind: 'mcp', id: server.id, label: server.name, groupMode: server.groupMode });
    }
  }
  for (const plugin of plugins) {
    for (const name of plugin.toolNames) {
      ownerOf.set(name, { kind: 'plugin', id: plugin.id, label: plugin.name });
    }
  }

  /** 把某一来源的工具按归属分桶；找不到归属的进「未归属」 */
  const bucketByOwner = (tools: ToolSettingDto[]): Array<{ key: string; label: string; owner: { kind: 'mcp' | 'plugin'; id: string } | null; tools: ToolSettingDto[] }> => {
    const buckets = new Map<string, { key: string; label: string; owner: { kind: 'mcp' | 'plugin'; id: string } | null; tools: ToolSettingDto[] }>();
    for (const tool of tools) {
      const owner = ownerOf.get(tool.name) ?? null;
      const key = owner === null ? `orphan:${tool.source}` : `${owner.kind}:${owner.id}`;
      const existing = buckets.get(key) ?? {
        key,
        label: owner === null ? '未归属（配置还在，来源已不在）' : owner.label,
        owner: owner === null ? null : { kind: owner.kind, id: owner.id },
        tools: [],
      };
      existing.tools.push(tool);
      buckets.set(key, existing);
    }
    return [...buckets.values()];
  };

  const renderRows = (tools: ToolSettingDto[]): ReactElement => (
    <>
      {tools.map((tool) => (
        <ToolRow
          key={tool.name}
          tool={tool}
          busy={busy === tool.name}
          expanded={expanded === tool.name}
          onToggleExpand={() => setExpanded(expanded === tool.name ? null : tool.name)}
          onChange={(mode) => void change(tool.name, mode)}
          onReset={() => void reset(tool.name)}
        />
      ))}
    </>
  );

  /**
   * 一个分类（内置的功能组 / 一个 MCP 服务器 / 一个插件）。
   *
   * ★ 用户要的两件事都在这里：
   *   ① **按分类批量**改常驻/按需/关闭（内置分类也给，因为"文件/上下文"这些组名才是他看到的分类）；
   *   ② **折叠收起**某个分类 —— 内置工具有 17 个、MCP 一个服务器可能有几十个，不折叠根本翻不动。
   * ★ 折叠状态用 group key 存在 Set 里，**不落盘**：这是"这一次查看时"的临时视图状态。
   */
  const renderGroup = (
    groupKey: string,
    label: string,
    tools: ToolSettingDto[],
    batchHandler?: (mode: ToolModeDto) => void,
    batchCurrent?: ToolModeDto | undefined,
  ): ReactElement => {
    const collapsed = collapsedGroups.has(groupKey);
    return (
      <div className="tool-group" key={groupKey}>
        <div className="tool-group-head">
          <button
            type="button"
            className="tool-group-toggle"
            aria-expanded={!collapsed}
            title={collapsed ? '展开这个分类' : '收起这个分类'}
            onClick={() => {
              setCollapsedGroups((current) => {
                const next = new Set(current);
                if (next.has(groupKey)) next.delete(groupKey);
                else next.add(groupKey);
                return next;
              });
            }}
          >
            <span className={collapsed ? 'caret collapsed' : 'caret'}>
              <IconChevron size={11} />
            </span>
            <span className="tool-group-name">{label}</span>
          </button>
          <span className="count">{tools.length}</span>
          {batchHandler !== undefined && (
            <BatchButtons
              busy={busy === `group:${groupKey}`}
              current={batchCurrent}
              onPick={batchHandler}
            />
          )}
        </div>
        {!collapsed && renderRows(tools)}
      </div>
    );
  };

  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <div className="modal-head">
          <h2>
            <IconSteps size={14} /> 工具
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <IconX size={14} />
          </button>
        </div>

        <p className="hint">
          把不常用的工具设为<strong>按需</strong> —— 它只留一句话在目录里，模型要用时自己展开，
          省下的都是每一轮都要付的输入 token。设为<strong>关闭</strong>则模型完全看不到它。
          <br />
          {data !== null && (
            <>
              当前档位 <code>{data.permissionMode}</code>：常驻 <b>{data.summary.resident}</b> · 按需{' '}
              <b>{data.summary.lazy}</b> · 关闭 <b>{data.summary.disabled}</b> · 这一轮工具表约{' '}
              <b>{data.summary.toolTableChars}</b> 字符
            </>
          )}
        </p>

        {error !== null && (
          <p className="tool-error">
            <IconAlert size={13} /> {error}
          </p>
        )}

        {data === null ? (
          <div className="side-empty">读取中…</div>
        ) : (
          <div className="tool-list">
            {/* ───────── ① 内置工具 ───────── */}
            <div className="tool-section">
              <div className="tool-section-head">
                内置工具<span className="count">{builtin.length}</span>
                <span className="hint-inline">平台自带，按功能分组</span>
              </div>
              {[...builtinGroups.entries()].map(([group, tools]) =>
                renderGroup(
                  `builtin:${group}`,
                  GROUP_LABEL[group] ?? group,
                  tools,
                  (mode) => void batch('names', `builtin:${group}`, tools.map((tool) => tool.name), mode),
                ),
              )}
              {builtin.length === 0 && <div className="side-empty">当前权限档看不到内置工具。</div>}
            </div>

            {/* ───────── ② MCP 工具 ───────── */}
            <div className="tool-section">
              <div className="tool-section-head">
                MCP 工具<span className="count">{mcpTools.length}</span>
                <span className="hint-inline">按服务器分组；只有「完全权限」档可见</span>
              </div>
              {mcpServers.length === 0 && mcpTools.length === 0 && (
                <div className="side-empty">
                  还没有 MCP 服务器。在下面的「MCP」区添加一个，或者让模型用 <code>mcp_configure</code> 配。
                </div>
              )}
              {bucketByOwner(mcpTools).map((bucket) =>
                renderGroup(
                  bucket.key,
                  bucket.label,
                  bucket.tools,
                  bucket.owner === null
                    ? undefined
                    : (mode) =>
                        void batch('mcp', (bucket.owner as { id: string }).id, bucket.tools.map((tool) => tool.name), mode),
                  mcpServers.find((server) => server.id === (bucket.owner as { id: string } | null)?.id)?.groupMode,
                ),
              )}
            </div>

            {/* ───────── ③ 插件工具 ───────── */}
            <div className="tool-section">
              <div className="tool-section-head">
                插件工具<span className="count">{pluginTools.length}</span>
                <span className="hint-inline">按插件分组；只有「完全权限」档可见</span>
              </div>
              {pluginTools.length === 0 && <div className="side-empty">没有插件工具。</div>}
              {bucketByOwner(pluginTools).map((bucket) =>
                renderGroup(
                  bucket.key,
                  bucket.label,
                  bucket.tools,
                  bucket.owner === null
                    ? undefined
                    : (mode) =>
                        void batch('names', (bucket.owner as { id: string }).id, bucket.tools.map((tool) => tool.name), mode),
                  undefined,
                ),
              )}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => void resetAll()} disabled={busy === '__all__'}>
            全部恢复默认
          </button>
          <button type="button" className="primary close-only" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 整组批量按钮：把该服务器的所有工具一次设成同一模式 */
function BatchButtons({
  busy,
  current,
  onPick,
}: {
  busy: boolean;
  /** MCP 服务器当前的组模式（插件没有这个概念，传 undefined） */
  current: ToolModeDto | undefined;
  onPick: (mode: ToolModeDto) => void;
}): ReactElement {
  return (
    <span className="tool-batch" role="group" aria-label="整组批量设置">
      <span className="tool-batch-label">整组</span>
      {(['resident', 'lazy', 'disabled'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={current === mode ? `seg-btn on mode-${mode}` : `seg-btn mode-${mode}`}
          disabled={busy}
          title={`把整组设为「${MODE_LABEL[mode]}」${mode === 'lazy' ? '（推荐：省上下文）' : ''}`}
          onClick={() => onPick(mode)}
        >
          {MODE_LABEL[mode]}
        </button>
      ))}
    </span>
  );
}

function ToolRow({
  tool,
  busy,
  expanded,
  onToggleExpand,
  onChange,
  onReset,
}: {
  tool: ToolSettingDto;
  busy: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onChange: (mode: ToolModeDto) => void;
  onReset: () => void;
}): ReactElement {
  const changed = tool.mode !== tool.defaultMode;

  return (
    <div className={tool.available ? 'tool-row' : 'tool-row absent'}>
      <div className="tool-main">
        <button type="button" className="tool-name" onClick={onToggleExpand} title="点开看完整说明">
          <code>{tool.name}</code>
          <span className="tool-display">{tool.displayName}</span>
          <span className={`tool-kind kind-${tool.kind}`}>{KIND_LABEL[tool.kind] ?? tool.kind}</span>
          {/* ★ 「看不见」必须单独标出来 —— 它不是用户的选择，是权限档挡的 */}
          {!tool.visibleInMode && tool.available && <span className="tool-blocked">本档不可见</span>}
          {!tool.available && <span className="tool-blocked">工具已不在</span>}
        </button>

        {expanded && (
          <div className="tool-detail">
            <p>{tool.summary}</p>
            <p className="tool-oneliner">
              目录里的一句话：<code>{tool.oneLiner}</code>
            </p>
            <p className="tool-meta">
              来源 {SOURCE_LABEL[tool.source] ?? tool.source} · 默认 {MODE_LABEL[tool.defaultMode]} · 已调用{' '}
              {tool.useCount} 次
              {tool.lastUsedAt === null ? '（从没调用过）' : ` · 最后 ${tool.lastUsedAt.slice(0, 16).replace('T', ' ')}`}
            </p>
            {changed && (
              <button type="button" className="link-btn" onClick={onReset}>
                恢复默认（{MODE_LABEL[tool.defaultMode]}）
              </button>
            )}
          </div>
        )}
      </div>

      <div className="tool-modes" role="group" aria-label={`${tool.name} 的加载方式`}>
        {(['resident', 'lazy', 'disabled'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={tool.mode === mode ? `seg-btn on mode-${mode}` : `seg-btn mode-${mode}`}
            disabled={busy}
            title={MODE_HINT[mode]}
            onClick={() => onChange(mode)}
          >
            {tool.mode === mode && <IconCheck size={11} />}
            {MODE_LABEL[mode]}
          </button>
        ))}
      </div>
    </div>
  );
}
