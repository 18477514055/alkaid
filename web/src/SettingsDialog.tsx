import { useState, type ReactElement, type ReactNode } from 'react';

import './settings-dialog.css';
import { SetupDialog } from './SetupDialog.tsx';
import { ToolGatePanel } from './ToolGatePanel.tsx';
import type { PluginDto, ProviderDto } from './api.ts';
import type { GeneralSettings, ThinkingEffortSetting } from '../../src/shared/settings.ts';
import { DEFAULT_GENERAL, MAX_OUTPUT_CHARS, MAX_STEPS, MIN_OUTPUT_CHARS, MIN_STEPS, delegateModelKey } from '../../src/shared/settings.ts';
import { IconCheck, IconChevron, IconPlugins, IconSteps, IconX } from './icons.tsx';
import { WINDOW_PRESETS } from './windowPresets.ts';

/**
 * 统一设置面板（左下角**齿轮**打开；2026-11-09 起不再有头像）。
 *
 * ★ 页签按「改什么」分，不按「它是什么组件」：
 *   - 通用：新会话的默认行为 + **内核行为上限**（步数 / 工具输出）
 *   - 项目（右栏）：当前项目（或"没有项目的对话"）的右栏显示设置
 *   - 模型：连接与模型（复用 SetupDialog）
 *   - 工具：内置 / MCP / 插件 分组的三态开关（复用 ToolsPanel + McpPanel）
 *   - 插件：插件列表与状态
 *   - 归档：已归档的对话与项目
 *
 * ★ 设置全部存在服务端 `app_settings`（不再是 localStorage）：
 *   桌面壳每次启动换随机端口 ⇒ origin 变 ⇒ localStorage 每次重启归零。
 *
 * ★ 后三个页签用**插槽**注入（`panes`），因为它们的组件在别处：
 *   这样设置面板不用 import 一堆互相依赖的面板，也方便单独测。
 */

export type SettingsTab = 'general' | 'project' | 'delegate' | 'models' | 'tools' | 'plugins' | 'archive';

export type SettingsPanes = {
  readonly project?: ReactNode;
  readonly mcp?: ReactNode;
  readonly archive?: ReactNode;
};

type Props = {
  readonly initialTab?: SettingsTab;
  readonly providers: readonly ProviderDto[];
  readonly plugins: readonly PluginDto[];
  /** 工具面板需要知道当前权限档（哪一档看不看得见工具） */
  readonly permissionMode: string;
  /** 通用设置（受控：由 App 的服务端设置驱动） */
  readonly general: GeneralSettings;
  /** 只传改动的字段；服务端做合并与校验 */
  readonly onGeneral: (patch: Partial<GeneralSettings>) => void;
  /** 外部注入的面板（没有对应组件时不显示该页签） */
  readonly panes?: SettingsPanes;
  readonly onClose: () => void;
  readonly onChanged: () => void;
};

/**
 * ★ `GeneralSettings` / `DEFAULT_GENERAL` 已经搬到 `src/shared/settings.ts`
 *   （服务端要按同一套规则校验与归一化，不能两边各写一份）。
 *   这里**导入并再导出**，让既有 import 不用改。
 */
export type { GeneralSettings };
export { DEFAULT_GENERAL, MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS, MAX_STEPS, MIN_STEPS };

const ALL_TABS: ReadonlyArray<{ key: SettingsTab; label: string; needs?: keyof SettingsPanes }> = [
  { key: 'general', label: '通用' },
  { key: 'project', label: '项目/右栏', needs: 'project' },
  { key: 'delegate', label: '子代理' },
  { key: 'models', label: '模型' },
  { key: 'tools', label: '工具' },
  { key: 'plugins', label: '插件' },
  { key: 'archive', label: '归档', needs: 'archive' },
];

const PERMISSION_LABEL: Record<string, string> = {
  readonly: '只读',
  workspace: '工作区',
  project: '项目',
  workspace_project: '工作区 + 项目',
  full: '完全权限',
};

const EFFORT_LABEL: Record<ThinkingEffortSetting, string> = {
  default: '跟随模型',
  off: '关闭思考',
  low: '低',
  medium: '中',
  high: '高',
};

/** 档位唯一真源在 windowPresets.ts（三处副本各改各的吃过亏；500k 档位也由那里统一提供） */

/** 一行设置：左边标题 + 说明，右边控件 —— 与截图里的版式一致 */
function Row(props: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{props.title}</div>
        {props.desc !== undefined && <div className="set-row-desc">{props.desc}</div>}
      </div>
      <div className="set-row-control">{props.children}</div>
    </div>
  );
}

/** 下拉：用一个原生 select（够用、可靠、键盘可达），只套一层壳让它不那么丑 */
function Select(props: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <select className="set-select" value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function SettingsDialog(props: Props): ReactElement {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? 'general');
  const [windowDraft, setWindowDraft] = useState(String(props.general.defaultContextWindow));
  const [stepsDraft, setStepsDraft] = useState(
    props.general.maxStepsPerTurn === null ? '' : String(props.general.maxStepsPerTurn),
  );
  const [outputDraft, setOutputDraft] = useState(
    props.general.maxToolOutputChars === null ? '' : String(props.general.maxToolOutputChars),
  );
  const [compactDraft, setCompactDraft] = useState(String(props.general.compactThresholdPercent));
  const [compactError, setCompactError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /** 只传改动的字段：服务端负责合并与校验，前端不再维护整份副本 */
  const patchGeneral = (patch: Partial<GeneralSettings>): void => {
    props.onGeneral(patch);
    // 通用项是即时生效的，给一个 1.2s 的"已保存"提示，不用点保存按钮
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  };

  // ★ 没有注入对应面板就不显示那个页签 —— 不要给用户一个点开是空白的入口
  const tabs = ALL_TABS.filter((item) => item.needs === undefined || props.panes?.[item.needs] !== undefined);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="settings-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="settings-head">
          <h2>设置</h2>
          {saved && (
            <span className="settings-saved">
              <IconCheck size={12} />
              已保存
            </span>
          )}
          <span className="grow" />
          <button type="button" className="icon" title="关闭" onClick={props.onClose}>
            <IconX size={14} />
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-tabs">
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                className={item.key === tab ? 'settings-tab on' : 'settings-tab'}
                onClick={() => setTab(item.key)}
              >
                {item.label}
                <span className="chev">
                  <IconChevron size={11} />
                </span>
              </button>
            ))}
          </nav>

          <section className="settings-pane">
            {tab === 'general' && (
              <>
                <Row
                  title="权限"
                  desc="新会话的默认权限模式。★ 刻意与 DSH 不同：DSH 默认「完全权限」，这里默认「工作区」—— 本平台的权限同时决定模型能看到哪些工具，全开等于默认放行插件工具。"
                >
                  <Select
                    value={props.general.defaultPermissionMode}
                    onChange={(value) => patchGeneral({ defaultPermissionMode: value })}
                    options={Object.entries(PERMISSION_LABEL).map(([value, label]) => ({ value, label }))}
                  />
                </Row>

                <Row title="思考强度" desc="新会话默认的思考强度；会话里还能单独改">
                  <Select
                    value={props.general.defaultThinkingEffort}
                    onChange={(value) => patchGeneral({ defaultThinkingEffort: value as ThinkingEffortSetting })}
                    options={(Object.keys(EFFORT_LABEL) as ThinkingEffortSetting[]).map((value) => ({
                      value,
                      label: EFFORT_LABEL[value],
                    }))}
                  />
                </Row>

                <Row title="上下文窗口" desc="新会话默认的模型窗口（tokens），底部水位的分母">
                  <div className="set-inline">
                    <input
                      className="set-number"
                      inputMode="numeric"
                      value={windowDraft}
                      onChange={(event) => setWindowDraft(event.target.value)}
                      onBlur={() => {
                        const parsed = Number.parseInt(windowDraft, 10);
                        if (!Number.isInteger(parsed) || parsed < 1000) {
                          setWindowDraft(String(props.general.defaultContextWindow));
                          return;
                        }
                        patchGeneral({ defaultContextWindow: parsed });
                      }}
                    />
                    <span className="set-unit">tokens</span>
                  </div>
                </Row>

                <Row title="预设窗口" desc="点一下就填进上面的输入框（DSH 官方端对主流模型也是给 1M）">
                  <div className="set-chips">
                    {WINDOW_PRESETS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={props.general.defaultContextWindow === value ? 'set-chip on' : 'set-chip'}
                        onClick={() => {
                          setWindowDraft(String(value));
                          patchGeneral({ defaultContextWindow: value });
                        }}
                      >
                        {value >= 1_000_000 ? '1M' : `${value / 1000}k`}
                      </button>
                    ))}
                  </div>
                </Row>

                <Row title="自动压缩上下文" desc="默认开启。达到水位线后，仍须台账更新、进展日志、triage 三项分别成功才会压缩；缺项时不发压缩请求，也不影响继续工作。手动压缩使用同一道门，不会旁路。">
                  <label className="set-inline"><input type="checkbox" aria-label="自动压缩上下文" checked={props.general.autoCompactEnabled} onChange={(event) => patchGeneral({ autoCompactEnabled: event.target.checked })} /><span>{props.general.autoCompactEnabled ? '已开启' : '已关闭'}</span></label>
                </Row>
                <Row title="压缩水位线" desc="默认 80%，可设 1–99%，支持小数。这是上下文压缩水位，不是项目的 5% 台账整理间隔；启用或修改设置不会立即发送模型请求。">
                  <div className="set-compaction-controls"><div className="set-inline"><input className="set-number" aria-label="上下文压缩水位线" type="number" min="1" max="99" step="any" inputMode="decimal" value={compactDraft} onChange={(event) => { setCompactDraft(event.target.value); setCompactError(null); }} onBlur={() => {
                    const value = Number(compactDraft);
                    if (!compactDraft.trim() || !Number.isFinite(value) || value < 1 || value > 99) { setCompactError('压缩水位线须为 1–99%，允许小数；未保存此次输入。'); return; }
                    setCompactError(null); patchGeneral({ compactThresholdPercent: value });
                  }} /><span className="set-unit">%</span></div>
                  {compactError && <p className="set-compaction-error" role="alert">{compactError}</p>}</div>
                </Row>

                <Row
                  title="单轮步数上限"
                  desc="一步 = 一次模型调用（可能带一批工具）。关掉后**没有上限**：理论上可以一直调下去，也就等于让账单不设上限（空转检测仍然有效）。"
                >
                  <div className="set-inline">
                    <input
                      className="set-number"
                      inputMode="numeric"
                      placeholder="不限"
                      value={stepsDraft}
                      disabled={props.general.maxStepsPerTurn === null}
                      onChange={(event) => setStepsDraft(event.target.value)}
                      onBlur={() => {
                        const parsed = Number.parseInt(stepsDraft, 10);
                        if (!Number.isInteger(parsed) || parsed < MIN_STEPS || parsed > MAX_STEPS) {
                          setStepsDraft(
                            props.general.maxStepsPerTurn === null ? '' : String(props.general.maxStepsPerTurn),
                          );
                          return;
                        }
                        patchGeneral({ maxStepsPerTurn: parsed });
                      }}
                    />
                    <span className="set-unit">步</span>
                  </div>
                  <div className="set-chips">
                    {[40, 120, 300, MAX_STEPS].map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={props.general.maxStepsPerTurn === value ? 'set-chip on' : 'set-chip'}
                        onClick={() => {
                          setStepsDraft(String(value));
                          patchGeneral({ maxStepsPerTurn: value });
                        }}
                      >
                        {value}
                      </button>
                    ))}
                    {/* ★ 用户要求：允许**关闭**上限，而不是只能调大 */}
                    <button
                      type="button"
                      className={props.general.maxStepsPerTurn === null ? 'set-chip on' : 'set-chip'}
                      title="不限制步数；空转检测仍然生效"
                      onClick={() => {
                        setStepsDraft('');
                        patchGeneral({ maxStepsPerTurn: null });
                      }}
                    >
                      不限制
                    </button>
                  </div>
                </Row>

                <Row
                  title="工具输出上限"
                  desc="单个工具返回的内容超过这个长度会被截断并标注。关掉后**不截断**：一段很长的输出会整段进上下文，可能一口气吃掉大量窗口与费用。"
                >
                  <div className="set-inline">
                    <input
                      className="set-number"
                      inputMode="numeric"
                      placeholder="不限"
                      value={outputDraft}
                      disabled={props.general.maxToolOutputChars === null}
                      onChange={(event) => setOutputDraft(event.target.value)}
                      onBlur={() => {
                        const parsed = Number.parseInt(outputDraft, 10);
                        if (!Number.isInteger(parsed) || parsed < MIN_OUTPUT_CHARS || parsed > MAX_OUTPUT_CHARS) {
                          setOutputDraft(
                            props.general.maxToolOutputChars === null
                              ? ''
                              : String(props.general.maxToolOutputChars),
                          );
                          return;
                        }
                        patchGeneral({ maxToolOutputChars: parsed });
                      }}
                    />
                    <span className="set-unit">字符</span>
                  </div>
                  <div className="set-chips">
                    {[30_000, 80_000, 200_000, MAX_OUTPUT_CHARS].map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={props.general.maxToolOutputChars === value ? 'set-chip on' : 'set-chip'}
                        onClick={() => {
                          setOutputDraft(String(value));
                          patchGeneral({ maxToolOutputChars: value });
                        }}
                      >
                        {value >= 1_000_000 ? `${String(value / 1_000_000)}M` : `${String(value / 1000)}k`}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={props.general.maxToolOutputChars === null ? 'set-chip on' : 'set-chip'}
                      title="不截断工具输出（会明显增加上下文占用与费用）"
                      onClick={() => {
                        setOutputDraft('');
                        patchGeneral({ maxToolOutputChars: null });
                      }}
                    >
                      不限制
                    </button>
                  </div>
                </Row>

                <Row
                  title="忙碌时的发送行为"
                  desc="会话正在生成时，Enter 与发送按钮的行为；Ctrl+Enter 使用另一种"
                >
                  <Select
                    value={props.general.busySendBehavior}
                    onChange={(value) => patchGeneral({ busySendBehavior: value === 'interrupt' ? 'interrupt' : 'queue' })}
                    options={[
                      { value: 'queue', label: '排队发送' },
                      { value: 'interrupt', label: '插话发送' },
                    ]}
                  />
                </Row>

                <p className="settings-note">
                  权限、思考强度与窗口默认值作用于新建会话；自动压缩开关与水位线属于全局内核行为设置，现有会话也使用它们。
                  项目与工作区的登记仍在侧栏「工作区」分组里 —— 那是日常操作，不是配置。
                </p>
              </>
            )}

            {tab === 'project' && props.panes?.project !== undefined && <>{props.panes.project}</>}

            {tab === 'delegate' && (
              <>
                {/*
                  ★ 子代理设置（2026-11-10 用户要求）：主对话可以为子代理选哪些模型。
                  两个旋钮，故意分开 —— 它们回答的是两个不同的问题：
                  ① 白名单：**别的**模型里允许哪些；
                  ② 「允许用它自己的模型」：**主对话正在用的那个**要不要也放行。
                */}
                <Row
                  title="允许主对话把它自己的模型派给子代理"
                  desc="关掉后，主对话当前在用的那个模型也要像别的模型一样过白名单。默认开着 —— 否则最常见的一条路（沿用主对话模型）会被白名单意外挡住。"
                >
                  <label className="set-inline">
                    <input
                      type="checkbox"
                      checked={props.general.delegateAllowParentModel}
                      onChange={(event) => patchGeneral({ delegateAllowParentModel: event.target.checked })}
                    />
                    <span>{props.general.delegateAllowParentModel ? '允许' : '不允许（也过白名单）'}</span>
                  </label>
                </Row>

                <Row
                  title="子代理模型白名单"
                  desc="子代理只能用这里列出的模型。不限制 = 任意已注册模型都能派；一个都不选（空列表）= 只能用主对话自己的模型（受上面那个开关约束）。"
                >
                  <div className="set-chips">
                    <button
                      type="button"
                      className={props.general.delegateAllowedModels === null ? 'set-chip on' : 'set-chip'}
                      onClick={() => patchGeneral({ delegateAllowedModels: null })}
                    >
                      不限制
                    </button>
                    <button
                      type="button"
                      className={
                        props.general.delegateAllowedModels !== null &&
                        props.general.delegateAllowedModels.length === 0
                          ? 'set-chip on'
                          : 'set-chip'
                      }
                      title="一个都不许：子代理只能用主对话自己的模型"
                      onClick={() => patchGeneral({ delegateAllowedModels: [] })}
                    >
                      一个都不许
                    </button>
                  </div>

                  {/*
                    ★★ 2026-11-11 审计 `ALK-HIGH-08`：这张清单**必须一直显示**。
                    原来只在"已经选了至少一个模型"时才渲染 —— 于是从「不限制」或「一个都不许」
                    出发**永远没有第一个可勾的复选框**，用户被锁死在两种整体状态里，
                    白名单功能在 UI 上等于不存在。现在：勾一个就从空列表变成那一个。
                  */}
                  <div className="set-model-list">
                      {props.providers.map((provider) => (
                        <div key={provider.id} className="set-model-group">
                          <div className="set-model-provider">{provider.name}</div>
                          {(provider.enabledModels ?? []).length === 0 ? (
                            <p className="hint">
                              这个连接没有勾选任何模型 —— 先去「模型」页给它加上，这里才会出现可选项。
                            </p>
                          ) : (
                            (provider.enabledModels ?? []).map((model) => {
                              const key = delegateModelKey(provider.id, model);
                              const checked = (props.general.delegateAllowedModels ?? []).includes(key);
                              return (
                                <label key={key} className="set-model-row">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {
                                      const current = props.general.delegateAllowedModels ?? [];
                                      patchGeneral({
                                        delegateAllowedModels: checked
                                          ? current.filter((item) => item !== key)
                                          : [...current, key],
                                      });
                                    }}
                                  />
                                  <span>{model}</span>
                                </label>
                              );
                            })
                          )}
                        </div>
                      ))}
                    </div>

                  <p className="settings-note">
                    {props.general.delegateAllowedModels === null
                      ? '现在不限制：主对话可以把任意已注册模型派给子代理。'
                      : props.general.delegateAllowedModels.length === 0
                        ? '现在一个都不许：子代理只能用主对话自己的模型（若上面那个开关也关了，就连自己也不能用）。'
                        : `已选 ${String(props.general.delegateAllowedModels.length)} 个模型。想改这组选项，先在上面的「模型」页把模型加进对应连接。`}
                  </p>
                </Row>
              </>
            )}

            {tab === 'models' && (
              <div className="settings-embed">
                <SetupDialog
                  providers={[...props.providers]}
                  onClose={() => setTab('general')}
                  onChanged={props.onChanged}
                />
              </div>
            )}

            {tab === 'tools' && (
              <>
                {/*
                  工具门控（v18）：**全局默认**那一层 —— 与"某个对话的工具集"是同一个面板，
                  区别只在有没有 conversationId。旧的平铺式 ToolsPanel 已退役。
                */}
                <div className="settings-embed">
                  <ToolGatePanel conversationId={null} onClose={() => setTab('general')} />
                </div>
                {/* MCP 是"工具"的子分区：它们最终都是工具，只是来源不同 */}
                {props.panes?.mcp !== undefined && (
                  <div className="settings-embed settings-embed-mcp">{props.panes.mcp}</div>
                )}
              </>
            )}

            {tab === 'archive' && props.panes?.archive !== undefined && <>{props.panes.archive}</>}

            {tab === 'plugins' && (
              <>
                <p className="settings-note">
                  插件是放在插件目录里的本地代码，<strong>装插件就等于信任作者</strong>。
                  插件工具只在「完全权限」档可见；插件进程崩了只摘掉它的工具，聊天继续。
                </p>
                {props.plugins.length === 0 ? (
                  <div className="settings-empty">
                    <IconPlugins size={16} />
                    还没有插件。把代码放进 &lt;数据根&gt;/plugins/&lt;name&gt;/ 即可。
                  </div>
                ) : (
                  <div className="settings-list">
                    {props.plugins.map((plugin) => (
                      <div key={plugin.id} className="settings-item">
                        <span className={`led ${plugin.status === 'ready' ? 'on' : ''}`} />
                        <span className="name">{plugin.name}</span>
                        <span className="meta">
                          {plugin.status === 'ready'
                            ? `${plugin.toolNames.length} 个工具`
                            : plugin.status === 'failed'
                              ? (plugin.error ?? '启动失败')
                              : '已停用'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** 头像菜单：目前只有「设置」一项（照用户要求） */
export function AvatarMenu(props: {
  x: number;
  y: number;
  onSettings: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="avatar-menu-backdrop" onClick={props.onClose}>
      <div
        className="avatar-menu"
        style={{ left: props.x, bottom: props.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="avatar-menu-item" onClick={props.onSettings}>
          <IconSteps size={13} />
          设置
        </button>
      </div>
    </div>
  );
}
