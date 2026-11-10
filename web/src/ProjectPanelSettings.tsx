import { useEffect, useId, useState, type ReactElement } from 'react';

import './new-parts.css';
import {
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_TABS,
  PANEL_TAB_LABEL,
  type PanelSettings,
  type PanelTab,
} from '../../src/shared/settings.ts';

/**
 * 「某个项目（或没有项目的对话）」的右栏设置表单。
 *
 * ★ 这个组件只改**显示**，不改权限、不改记忆：
 *   页签 / 默认页 / 宽度 / 高级是否展开，全都只影响右栏怎么画。
 *   界面上必须把这句话写清楚 —— 否则「台账」「原则」这些名字很容易被当成"开了才有数据"。
 *
 * ★ 为什么所有改动都自己先把组合算好再 `onChange(patch)`：
 *   父级只负责发请求 + 存盘，不该再重复一遍「取消默认页签要落到第一个」这种规则。
 *   组件在同一帧里把 `visibleTabs` 与 `defaultTab` 一起交出去，就不会出现
 *   「默认页签指向一个已取消的页签」这种中间态。
 *
 * ★ 宽度为什么用本地文本态：
 *   数字输入框里必然出现「3」「45」这种暂时不合法但正在输入的中间值。
 *   若每个按键都夹一次，用户永远打不出 456（打到 4 就被弹成 304）。
 *   所以：输入过程中只接受**合法区间内**的值，失焦 / 回车时才夹。
 */

export type ProjectPanelSettingsProps = {
  /** 例如「项目：测验001」或「默认（没有项目的对话）」 */
  scopeLabel: string;
  panel: PanelSettings;
  onChange: (patch: Partial<PanelSettings>) => void;
  /** 该项目允许哪些页签；没有项目时只允许 work / logs */
  allowedTabs: readonly PanelTab[];
  /** 保存中 */
  busy?: boolean;
};

/** 常用宽度档位（都是 8 的倍数，和 --inspector-width 的节奏一致） */
const WIDTH_PRESETS: readonly number[] = [304, 456, 608, 760];

/** 提示语：空面板兜底 / 默认页签被挤走 */
type Notice = 'none' | 'kept-last' | 'auto-adjusted';

function clampWidth(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, rounded));
}

export function ProjectPanelSettings(props: ProjectPanelSettingsProps): ReactElement {
  const { scopeLabel, panel, onChange, allowedTabs, busy = false } = props;
  const baseId = useId();

  /** 输入框里的原始文本（可能暂时越界 / 为空） */
  const [widthText, setWidthText] = useState<string>(String(panel.width));
  const [notice, setNotice] = useState<Notice>('none');

  // 外部把宽度改了（比如父级恢复默认、或预设按钮之外的地方改了），输入框跟着走
  useEffect(() => {
    setWidthText(String(panel.width));
  }, [panel.width]);

  // 已勾选且**被允许**的页签，顺序永远按 PANEL_TABS（不跟点击顺序走）
  const checked: PanelTab[] = PANEL_TABS.filter(
    (tab) => allowedTabs.includes(tab) && panel.visibleTabs.includes(tab),
  );
  // 兜底：一个都没有时，用允许集里的第一个，绝不渲染空面板
  const visible: readonly PanelTab[] = checked.length > 0 ? checked : [allowedTabs[0] ?? 'work'];

  const defaultTab: PanelTab = visible.includes(panel.defaultTab) ? panel.defaultTab : (visible[0] ?? 'work');

  const presets = WIDTH_PRESETS.filter((value) => value >= MIN_PANEL_WIDTH && value <= MAX_PANEL_WIDTH);
  const widthInRange = panel.width >= MIN_PANEL_WIDTH && panel.width <= MAX_PANEL_WIDTH;

  /** 一次性把 visibleTabs + defaultTab 算好交出去 */
  const applyVisible = (nextVisible: readonly PanelTab[]): void => {
    const ordered = PANEL_TABS.filter((tab) => nextVisible.includes(tab));
    if (ordered.length === 0) return;
    const keepDefault = ordered.includes(panel.defaultTab);
    const nextDefault = keepDefault ? panel.defaultTab : (ordered[0] ?? 'work');
    setNotice(keepDefault ? 'none' : 'auto-adjusted');
    onChange({ visibleTabs: ordered, defaultTab: nextDefault });
  };

  const toggleTab = (tab: PanelTab, next: boolean): void => {
    if (busy) return;
    if (!allowedTabs.includes(tab)) return;

    if (next) {
      applyVisible(PANEL_TABS.filter((candidate) => candidate === tab || checked.includes(candidate)));
      return;
    }

    const remaining = checked.filter((candidate) => candidate !== tab);
    if (remaining.length === 0) {
      // 全取消 = 空面板。不做，并说清楚为什么。
      setNotice('kept-last');
      return;
    }
    applyVisible(remaining);
  };

  const onWidthInput = (raw: string): void => {
    setWidthText(raw);
    if (raw.trim().length === 0) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    // 只有落在合法区间里才即时提交；越界 / 中间值等到失焦再夹
    if (parsed < MIN_PANEL_WIDTH || parsed > MAX_PANEL_WIDTH) return;
    const next = Math.trunc(parsed);
    if (next !== panel.width) onChange({ width: next });
  };

  const commitWidth = (): void => {
    const parsed = widthText.trim().length === 0 ? Number.NaN : Number(widthText);
    const next = clampWidth(parsed, panel.width);
    setWidthText(String(next));
    if (next !== panel.width) onChange({ width: next });
  };

  const pickPreset = (value: number): void => {
    if (busy) return;
    setWidthText(String(value));
    if (value !== panel.width) onChange({ width: value });
  };

  // 为什么某项点不了：按**缺什么**判断，而不是按允许集长度
  // （没有项目的对话允许 work / logs 两个，长度是 2，缺的其实是"项目绑定"）
  const projectScope = allowedTabs.includes('memory') || allowedTabs.includes('principles');
  const disabledReason = projectScope ? '当前作用域不开放这个页签' : '需要先给对话绑定项目';

  return (
    <div className="panel-settings" aria-busy={busy}>
      <div className="panel-settings-head">
        <div className="panel-settings-scope">{scopeLabel}</div>
        {busy ? (
          <span className="panel-settings-saving" role="status">
            保存中…
          </span>
        ) : null}
      </div>

      {/* ── 页签多选 ─────────────────────────────────────── */}
      <section className="panel-settings-row">
        <div className="panel-settings-text">
          <div className="panel-settings-title" id={`${baseId}-tabs-title`}>
            显示哪些页签
          </div>
          <div className="panel-settings-desc">
            至少要留一个。「台账 / 原则」是项目域的，没有绑定项目就没有内容可看。
          </div>
          {projectScope ? null : <div className="panel-settings-desc warn">{disabledReason}。</div>}
        </div>
        <div className="panel-settings-control">
          <div className="panel-settings-tabs" role="group" aria-labelledby={`${baseId}-tabs-title`}>
            {PANEL_TABS.map((tab) => {
              const allowed = allowedTabs.includes(tab);
              const on = allowed && visible.includes(tab);
              return (
                <label key={tab} className={`panel-settings-check${allowed ? '' : ' off'}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!allowed || busy}
                    aria-label={`显示页签 ${PANEL_TAB_LABEL[tab]}`}
                    onChange={(event) => {
                      toggleTab(tab, event.target.checked);
                    }}
                  />
                  <span className="panel-settings-check-text">
                    {PANEL_TAB_LABEL[tab]}
                    {allowed ? null : <span className="panel-settings-reason">（{disabledReason}）</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── 默认页签 ─────────────────────────────────────── */}
      <section className="panel-settings-row">
        <div className="panel-settings-text">
          <label className="panel-settings-title" htmlFor={`${baseId}-default`}>
            默认停留在
          </label>
          <div className="panel-settings-desc">只能从上面勾选过的页签里选；打开右栏时先停在这一页。</div>
        </div>
        <div className="panel-settings-control">
          <select
            id={`${baseId}-default`}
            className="panel-settings-select"
            value={defaultTab}
            disabled={busy}
            aria-label="默认页签"
            onChange={(event) => {
              const picked = visible.find((tab) => tab === event.target.value);
              if (picked === undefined) return;
              setNotice('none');
              onChange({ defaultTab: picked });
            }}
          >
            {visible.map((tab) => (
              <option key={tab} value={tab}>
                {PANEL_TAB_LABEL[tab]}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* ── 宽度 ─────────────────────────────────────────── */}
      <section className="panel-settings-row">
        <div className="panel-settings-text">
          <label className="panel-settings-title" htmlFor={`${baseId}-width`}>
            右栏宽度
          </label>
          <div className="panel-settings-desc">
            范围 {MIN_PANEL_WIDTH}–{MAX_PANEL_WIDTH} px；超出会被夹到边界，不会报错。
          </div>
        </div>
        <div className="panel-settings-control">
          <div className="panel-settings-width">
            <input
              id={`${baseId}-width`}
              className="panel-settings-number"
              type="number"
              inputMode="numeric"
              step={1}
              min={MIN_PANEL_WIDTH}
              max={MAX_PANEL_WIDTH}
              value={widthText}
              disabled={busy}
              aria-label={`右栏宽度（${MIN_PANEL_WIDTH}–${MAX_PANEL_WIDTH} px）`}
              onChange={(event) => {
                onWidthInput(event.target.value);
              }}
              onBlur={commitWidth}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                commitWidth();
              }}
            />
            <span className="panel-settings-unit">px</span>
          </div>
          <div className="panel-settings-presets" role="group" aria-label="常用宽度档位">
            {presets.map((value) => (
              <button
                key={value}
                type="button"
                className={`panel-settings-preset${panel.width === value ? ' on' : ''}`}
                disabled={busy}
                aria-pressed={panel.width === value}
                aria-label={`右栏宽度 ${value} px`}
                onClick={() => {
                  pickPreset(value);
                }}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── 高级区块 ─────────────────────────────────────── */}
      <section className="panel-settings-row">
        <div className="panel-settings-text">
          <label className="panel-settings-title" htmlFor={`${baseId}-advanced`}>
            高级区块默认展开
          </label>
          <div className="panel-settings-desc">只是打开右栏时的初始状态，随时可以手动折叠。</div>
        </div>
        <div className="panel-settings-control">
          <input
            id={`${baseId}-advanced`}
            className="panel-settings-switch"
            type="checkbox"
            checked={panel.advancedOpen}
            disabled={busy}
            aria-label="高级区块默认展开"
            onChange={(event) => {
              onChange({ advancedOpen: event.target.checked });
            }}
          />
        </div>
      </section>

      {/* ── 提示 ─────────────────────────────────────────── */}
      {notice === 'kept-last' ? (
        <p className="panel-settings-flag warn" role="status">
          至少要保留一个页签，已为你保留当前勾选。
        </p>
      ) : null}
      {notice === 'auto-adjusted' ? (
        <p className="panel-settings-flag" role="status">
          已自动调整：默认页签被取消勾选，改为停留在「{PANEL_TAB_LABEL[defaultTab]}」。
        </p>
      ) : null}
      {widthInRange ? null : (
        <p className="panel-settings-flag warn" role="status">
          当前宽度 {panel.width} px 超出 {MIN_PANEL_WIDTH}–{MAX_PANEL_WIDTH} px，显示时会被夹到边界。
        </p>
      )}

      <p className="panel-settings-note">
        这一份设置<strong>只影响右栏显示什么</strong>（显示哪些页签、先停在哪页、栏有多宽、高级区块是否展开），
        它不是权限、也不改变记忆内容。权限在「通用」里按权限档设置；台账与原则的内容由项目本身决定。
      </p>
    </div>
  );
}
