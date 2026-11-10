import { useCallback, useEffect, useState, type ReactElement } from 'react';

import {
  KEEP_EXISTING,
  MCP_GROUP_MODE_LABEL,
  MCP_GROUP_MODES,
  MCP_TRANSPORTS,
  type McpGroupMode,
  type McpServerDto,
  type McpTransport,
} from '../../src/shared/mcp.ts';
import { api } from './api.ts';
import { IconAlert, IconCheck, IconLink, IconPlus, IconX } from './icons.tsx';
import './mcp-panel.css';

/**
 * 工具设置里的 **MCP 面板**（只读参考了 ToolsPanel 的视觉与交互，代码各自独立）。
 *
 * ## ★★★ 四条界面判据
 *
 * 1. **凭据只写不读**。`env` / `headers` 的输入框在编辑时**永不预填值**，只预填键名
 *    （`KEY=`）。写清了"留空 = 不修改"，所以用户不需要"先看一眼再改"—— 那一看就是把 token
 *    送到屏幕上。提交时留空自动换成 `KEEP_EXISTING` 占位符。
 * 2. **组模式是批量动作，必须一眼看出它对"这一台的全部工具"生效**。
 *    单个工具的精细调整不在这个面板（在工具列表里），这里只有三态分段控件。
 * 3. **失败要说清是哪一步**。连接失败时同时显示状态、原因、以及"重连"按钮；
 *    不显示"未知错误"这种没法行动的话。
 * 4. **改完立刻回读**。全部写操作完成后重新 `listMcpServers()`，不信本地 state
 *    ——「设置存了 ≠ 生效」是这个项目栽过的坑。
 *
 * ★ 视觉：中性墨黑（`--ink` = #0f1115）为主色，**不用蓝色**；状态靠深浅与勾表达，不靠色相。
 */

const STATUS_LABEL: Record<string, string> = {
  ready: '已连接',
  error: '连接失败',
  disabled: '已停用',
  idle: '未连接',
};

const MODE_HINT: Record<McpGroupMode, string> = {
  resident: '这一台的全部工具都常驻：完整参数每轮都发给模型（最占上下文）',
  lazy: '这一台的全部工具都按需：目录里只留一句话，模型用时自己展开',
  disabled: '这一台的全部工具都关闭：模型完全看不到它们',
};

type Draft = {
  readonly id: string | null;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string;
  readonly args: string;
  readonly cwd: string;
  readonly env: string;
  readonly url: string;
  readonly headers: string;
  readonly enabled: boolean;
  readonly groupMode: McpGroupMode;
};

const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  cwd: '',
  env: '',
  url: '',
  headers: '',
  enabled: true,
  groupMode: 'lazy',
};

/** `KEY=VALUE` 一行一个。编辑模式下空值 = 保留原值（→ `KEEP_EXISTING`）。 */
function parsePairs(text: string, keepBlank: boolean): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    const key = (eq === -1 ? line : line.slice(0, eq)).trim();
    if (key.length === 0) continue;
    const value = eq === -1 ? '' : line.slice(eq + 1).trim();
    pairs[key] = keepBlank && value.length === 0 ? KEEP_EXISTING : value;
  }
  return pairs;
}

/** 键名回显成 `KEY=`（**不回显值**）。 */
function pairsToText(keys: readonly string[]): string {
  return keys.map((key) => `${key}=`).join('\n');
}

/** args：一行一个；也接受直接贴一个 JSON 数组。 */
function parseArgs(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
      }
    } catch {
      /* 不是合法 JSON 就按一行一个处理 */
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export type McpPanelProps = {
  /**
   * 当前权限档。只用于在面板上说明「MCP 工具只在完全权限档可见」这件事与本档是否匹配；
   * 不传就不渲染这一行（面板本身不依赖权限档工作）。
   */
  readonly permissionMode?: string;
};

export function McpPanel(props: McpPanelProps): ReactElement {
  const [servers, setServers] = useState<readonly McpServerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setServers(await api.listMcpServers());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = (): void => {
    setDraft({ ...EMPTY_DRAFT });
    setConfirming(null);
  };

  const openEdit = (server: McpServerDto): void => {
    setDraft({
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command ?? '',
      args: [...server.args].join('\n'),
      cwd: server.cwd ?? '',
      // ★ 只填键名，绝不填值（值不在前端，也从不下发）
      env: pairsToText(server.envKeys),
      url: server.url ?? '',
      headers: pairsToText(server.headerKeys),
      enabled: server.enabled,
      groupMode: server.groupMode,
    });
    setConfirming(null);
  };

  const patchDraft = (patch: Partial<Draft>): void => {
    setDraft((current) => (current === null ? current : { ...current, ...patch }));
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    const name = draft.name.trim();
    if (name.length === 0) {
      setError('名字不能为空');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const editing = draft.id !== null;
      const common = {
        name,
        transport: draft.transport,
        enabled: draft.enabled,
        groupMode: draft.groupMode,
      };
      if (draft.transport === 'stdio') {
        await (draft.id === null
          ? api.createMcpServer({
              ...common,
              command: draft.command.trim(),
              args: parseArgs(draft.args),
              cwd: draft.cwd.trim().length === 0 ? null : draft.cwd.trim(),
              env: parsePairs(draft.env, editing),
            })
          : api.patchMcpServer(draft.id, {
              ...common,
              command: draft.command.trim(),
              args: parseArgs(draft.args),
              cwd: draft.cwd.trim().length === 0 ? null : draft.cwd.trim(),
              env: parsePairs(draft.env, editing),
            }));
      } else {
        await (draft.id === null
          ? api.createMcpServer({
              ...common,
              url: draft.url.trim(),
              headers: parsePairs(draft.headers, editing),
            })
          : api.patchMcpServer(draft.id, {
              ...common,
              url: draft.url.trim(),
              headers: parsePairs(draft.headers, editing),
            }));
      }
      setDraft(null);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await action();
      // ★ 回读：以服务端为准
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mcp-panel">
      <div className="mcp-head">
        <h3>
          <IconLink size={13} /> MCP 服务器
        </h3>
        <span className="mcp-grow" />
        <button type="button" className="mcp-btn primary" onClick={openCreate} disabled={saving}>
          <IconPlus size={12} /> 添加服务器
        </button>
      </div>

      <p className="mcp-hint">
        MCP 服务器把外部能力（文件系统、数据库、SaaS 接口……）接成工具。
        <br />
        <b>★ MCP 工具只在「完全权限」档可见</b>（与插件一致）：它能让本机起任意进程、连任意外网，
        所以不在低权限档暴露。{' '}
        {props.permissionMode !== undefined && props.permissionMode !== 'full' && (
          <span className="mcp-warn-inline">当前档位是「{props.permissionMode}」，这些工具现在对模型不可见。</span>
        )}
        <br />
        凭据（env / headers 的<b>值</b>）只存在本机数据库里，<b>任何时候都不会回显</b>；
        编辑时留空即表示不修改。
      </p>

      {error !== null && (
        <p className="mcp-error">
          <IconAlert size={13} /> {error}
        </p>
      )}

      {loading ? (
        <div className="mcp-empty">读取中…</div>
      ) : servers.length === 0 ? (
        <div className="mcp-empty">
          还没有配置 MCP 服务器。点「添加服务器」填一条，或用内置工具 <code>mcp_configure</code> 让模型来配。
        </div>
      ) : (
        <div className="mcp-list">
          {servers.map((server) => {
            const working = busy === server.id;
            const opened = expanded === server.id;
            return (
              <div className="mcp-row" key={server.id}>
                <div className="mcp-main">
                  <div className="mcp-title">
                    <span className={`mcp-dot st-${server.status}`} title={STATUS_LABEL[server.status] ?? server.status} />
                    <code className="mcp-name">{server.name}</code>
                    <span className="mcp-badge">{server.transport}</span>
                    <span className={`mcp-badge status-${server.status}`}>
                      {STATUS_LABEL[server.status] ?? server.status}
                    </span>
                    <span className="mcp-badge">{server.toolNames.length} 个工具</span>
                    {server.toolNames.length > 0 && (
                      <button
                        type="button"
                        className="mcp-link"
                        onClick={() => setExpanded(opened ? null : server.id)}
                      >
                        {opened ? '收起' : '看工具名'}
                      </button>
                    )}
                  </div>

                  {opened && (
                    <div className="mcp-tools">
                      {server.toolNames.map((toolName) => (
                        <code key={toolName}>{toolName}</code>
                      ))}
                    </div>
                  )}

                  {server.error !== null && (
                    <p className="mcp-row-error">
                      <IconAlert size={12} /> {server.error}
                    </p>
                  )}
                </div>

                {confirming === server.id ? (
                  <div className="mcp-confirm">
                    <span>删除「{server.name}」？它的工具会立刻从工具表摘掉。</span>
                    <button
                      type="button"
                      className="mcp-btn danger"
                      disabled={working}
                      onClick={() => {
                        setConfirming(null);
                        void run(server.id, () => api.deleteMcpServer(server.id));
                      }}
                    >
                      确认删除
                    </button>
                    <button type="button" className="mcp-btn" onClick={() => setConfirming(null)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <div className="mcp-actions">
                    <div className="mcp-modes" role="group" aria-label={`${server.name} 的整组模式`}>
                      {MCP_GROUP_MODES.map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={server.groupMode === mode ? `seg-btn on mode-${mode}` : `seg-btn mode-${mode}`}
                          title={MODE_HINT[mode]}
                          disabled={working}
                          onClick={() => void run(server.id, () => api.setMcpGroupMode(server.id, mode))}
                        >
                          {server.groupMode === mode && <IconCheck size={11} />}
                          {MCP_GROUP_MODE_LABEL[mode]}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="mcp-btn"
                      disabled={working}
                      title="重新拉起进程并重新拉取工具列表"
                      onClick={() => void run(server.id, () => api.reconnectMcpServer(server.id))}
                    >
                      {working ? '处理中…' : '重新连接'}
                    </button>
                    <button type="button" className="mcp-btn" onClick={() => openEdit(server)}>
                      编辑
                    </button>
                    <button type="button" className="mcp-btn danger" onClick={() => setConfirming(server.id)}>
                      删除
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {draft !== null && (
        <div className="mcp-form">
          <div className="mcp-form-title">
            {draft.id === null ? '新增 MCP 服务器' : `编辑「${draft.name}」`}
            <span className="mcp-grow" />
            <button type="button" className="mcp-link" onClick={() => setDraft(null)}>
              <IconX size={11} /> 关闭表单
            </button>
          </div>

          <label className="mcp-field">
            <span className="mcp-label">
              名字 <b>（必填，必须唯一）</b>
            </span>
            <input
              className="mcp-input"
              value={draft.name}
              placeholder="filesystem"
              onChange={(event) => patchDraft({ name: event.target.value })}
            />
          </label>

          <div className="mcp-field">
            <span className="mcp-label">传输方式</span>
            <div className="mcp-radios">
              {MCP_TRANSPORTS.map((transport) => (
                <label key={transport} className="mcp-radio">
                  <input
                    type="radio"
                    name="mcp-transport"
                    checked={draft.transport === transport}
                    onChange={() => patchDraft({ transport })}
                  />
                  {transport === 'stdio' ? 'stdio（本机子进程）' : 'http（streamable-http）'}
                </label>
              ))}
            </div>
          </div>

          {draft.transport === 'stdio' ? (
            <>
              <label className="mcp-field">
                <span className="mcp-label">
                  command <b>（必填）</b>
                </span>
                <input
                  className="mcp-input"
                  value={draft.command}
                  placeholder="node（或 npx / C:\…\server.exe）"
                  onChange={(event) => patchDraft({ command: event.target.value })}
                />
              </label>
              <label className="mcp-field">
                <span className="mcp-label">args（一行一个，也可以直接贴 JSON 数组）</span>
                <textarea
                  className="mcp-textarea"
                  rows={3}
                  value={draft.args}
                  placeholder={'server.js\n--stdio'}
                  onChange={(event) => patchDraft({ args: event.target.value })}
                />
              </label>
              <label className="mcp-field">
                <span className="mcp-label">cwd（可选）</span>
                <input
                  className="mcp-input"
                  value={draft.cwd}
                  placeholder="留空 = 用应用的当前目录"
                  onChange={(event) => patchDraft({ cwd: event.target.value })}
                />
              </label>
              <label className="mcp-field">
                <span className="mcp-label">env（一行一个 KEY=VALUE）</span>
                <textarea
                  className="mcp-textarea"
                  rows={3}
                  value={draft.env}
                  placeholder={'GITHUB_TOKEN=\nLOG_LEVEL=info'}
                  onChange={(event) => patchDraft({ env: event.target.value })}
                />
                <span className="mcp-note">
                  ★ 值不会回显：<b>留空 = 不修改</b>（沿用已保存的值）；填了就覆盖；整块清空 = 清空全部；
                  删掉某一行 = 删除该键。新增时留空就是空字符串。
                </span>
              </label>
            </>
          ) : (
            <>
              <label className="mcp-field">
                <span className="mcp-label">
                  url <b>（必填，http:// 或 https://）</b>
                </span>
                <input
                  className="mcp-input"
                  value={draft.url}
                  placeholder="http://127.0.0.1:3000/mcp"
                  onChange={(event) => patchDraft({ url: event.target.value })}
                />
              </label>
              <label className="mcp-field">
                <span className="mcp-label">headers（一行一个 KEY=VALUE）</span>
                <textarea
                  className="mcp-textarea"
                  rows={3}
                  value={draft.headers}
                  placeholder={'Authorization=\nX-Api-Key='}
                  onChange={(event) => patchDraft({ headers: event.target.value })}
                />
                <span className="mcp-note">
                  ★ 值不会回显：<b>留空 = 不修改</b>；填了就覆盖；整块清空 = 清空全部；删掉某一行 = 删除该键。
                </span>
              </label>
            </>
          )}

          <div className="mcp-field">
            <span className="mcp-label">整组模式（这一台的全部工具，写库后立即生效）</span>
            <select
              className="mcp-select"
              value={draft.groupMode}
              onChange={(event) => patchDraft({ groupMode: event.target.value as McpGroupMode })}
            >
              {MCP_GROUP_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {MCP_GROUP_MODE_LABEL[mode]}
                </option>
              ))}
            </select>
          </div>

          <label className="mcp-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => patchDraft({ enabled: event.target.checked })}
            />
            启用（停用后不连接，工具也不会注册）
          </label>

          <div className="mcp-form-actions">
            <button type="button" className="mcp-btn" onClick={() => setDraft(null)} disabled={saving}>
              取消
            </button>
            <button type="button" className="mcp-btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : draft.id === null ? '添加并连接' : '保存并重连'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
