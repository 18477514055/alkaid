import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';

import { IconCheck } from './icons.tsx';
import { WINDOW_PRESETS as WINDOW_PRESETS_SRC, windowPresetLabel } from './windowPresets.ts';

/**
 * 输入框右下角的「模型名」触发器 + 向上展开的浮层。
 *
 * ★ 为什么浮层往上开：它挂在 composer 底栏上，**离视口底只有几十像素**，
 *   往下开会立刻被裁掉。所以 CSS 里是 `bottom: 100%` 而不是 `top: 100%`。
 * ★ 为什么不用 `<select>`：这个浮层里塞了三段不同控件（列表 / 分段按钮 / 数字输入），
 *   原生 select 只能表达单选。
 * ★ 为什么接受「模型列表可能为空」：
 *   很多自建网关根本不实现 `GET /models`。这时**不能把选择器做成死的**，
 *   得留一个受控输入框让人手填，否则这类连接就没法用。
 */

export type ModelPickerProps = {
  model: string;
  providerName: string;
  /** 当前会话绑定的连接（跨连接选模型时用来判断"换没换"） */
  providerId?: string;
  /** 可选模型（可能为空：连接没返回列表） */
  models: string[];
  /**
   * 跨连接的可选模型：按提供商分组（提供商作为标签）。
   * ★ 不传时退化成"只有当前连接的一列"，旧调用方零影响。
   */
  providerGroups?: readonly ProviderModelGroup[];
  /** 当前思考强度 */
  effort: string;
  /** 可选强度（如 off/low/medium/high/max） */
  efforts: string[];
  contextWindow: number;
  /** 选中模型；跨连接选中时第二个参数是该模型所属连接 */
  onPickModel: (model: string, providerId?: string) => void;
  onPickEffort: (effort: string) => void;
  onSetContextWindow: (tokens: number) => void;
  disabled?: boolean;
};

/** 一个提供商 + 它允许在该会话里使用的模型 */
export type ProviderModelGroup = {
  providerId: string;
  providerName: string;
  models: readonly string[];
};

/** 常用窗口档位：唯一真源在 windowPresets.ts（曾经三份副本各改各的） */
const WINDOW_PRESETS = WINDOW_PRESETS_SRC;

function windowLabel(tokens: number): string {
  return windowPresetLabel(tokens);
}

/** 把用户输入解析成 tokens；非法（NaN / ≤0）给 null，由调用方决定不要提交 */
function parseWindow(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // 允许「128k」「1m」这种写法：浮层里档位按钮是 k/M，手输时人也会照着敲
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(trimmed);
  if (match === null) return null;
  const digits = match[1];
  if (digits === undefined) return null;
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2] ?? '';
  const scale = unit === '' ? 1 : unit.toLowerCase() === 'k' ? 1_000 : 1_000_000;
  const tokens = Math.round(value * scale);
  // 上下界是防手滑：太小没意义，太大是打错了单位
  if (tokens < 1_000 || tokens > 10_000_000) return null;
  return tokens;
}

export function ModelPicker({
  model,
  providerName,
  providerId = '',
  models,
  providerGroups,
  effort,
  efforts,
  contextWindow,
  onPickModel,
  onPickEffort,
  onSetContextWindow,
  disabled = false,
}: ModelPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  /** 搜索词：模型多的时候（一个网关能列 30 个）靠滚动翻是不行的 */
  const [query, setQuery] = useState('');
  /** 上下文输入框的草稿。★ 必须是本地草稿：输入过程中 `128` 这种中间值不能立刻提交 */
  const [windowDraft, setWindowDraft] = useState<string>(() => String(contextWindow));
  /** 模型为空时手填用的草稿 */
  const [manualDraft, setManualDraft] = useState<string>(model);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  // 外部值变了（换了连接 / 别人改了窗口）就同步草稿，但**只在不编辑时**同步 ——
  // 这里没有"编辑中"标志，直接跟着 contextWindow 走即可：草稿只在本浮层活着。
  useEffect(() => {
    setWindowDraft(String(contextWindow));
  }, [contextWindow]);

  useEffect(() => {
    setManualDraft(model);
  }, [model]);

  /**
   * ★ 监听只在 `open` 为真时挂：关着的时候完全没有 document 监听，
   *   不会在页面其它地方滚一下、点一下都被这里拦一道。
   * ★ 监听里只操作 setOpen（稳定），不读任何会变的 props ——
   *   所以依赖里只需要 `open`，闭包不存在过期值问题。
   */
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      const element = rootRef.current;
      if (element !== null && event.target instanceof Node && element.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const commitWindow = useCallback((): void => {
    const parsed = parseWindow(windowDraft);
    if (parsed === null) {
      // 解析不了就退回当前值，别把脏草稿留在框里让人以为改成了
      setWindowDraft(String(contextWindow));
      return;
    }
    if (parsed === contextWindow) return;
    onSetContextWindow(parsed);
  }, [contextWindow, onSetContextWindow, windowDraft]);

  const submitManual = useCallback((): void => {
    const trimmed = manualDraft.trim();
    if (trimmed.length === 0) return;
    onPickModel(trimmed);
  }, [manualDraft, onPickModel]);

  const triggerLabel = `${model.length > 0 ? model : '未选择模型'} · ${effort.length > 0 ? effort : '默认'}`;

  /**
   * 可见的「提供商 → 模型」分组。
   * ★ 传了 `providerGroups` 就用它（跨连接）；没传就退化成当前连接一组 —— 旧调用方零影响。
   * ★ 分组里的模型可能**同名**（不同连接都叫 deepseek-v4.1-flash），所以选中判定必须连 providerId 一起比，
   *   只比模型名会让两个连接勾上同一个。
   */
  const groups: ProviderModelGroup[] =
    providerGroups !== undefined && providerGroups.length > 0
      ? [...providerGroups]
      : [{ providerId, providerName, models }];

  const needle = query.trim().toLowerCase();
  const matches = (candidate: string): boolean => needle === '' || candidate.toLowerCase().includes(needle);
  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0);
  /** 命中的分组；空分组不显示（搜索时尤其明显） */
  const visibleGroups = groups
    .map((group) => ({ ...group, models: group.models.filter(matches) }))
    .filter((group) => group.models.length > 0);
  /** 多连接时才在每一项后面挂提供商标签，单连接挂着是噪音 */
  const showProviderTag = visibleGroups.length > 1;

  const isSelected = (candidate: string, ownerId: string): boolean =>
    candidate === model && (ownerId === '' ? true : ownerId === providerId);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className={`model-picker-trigger ${open ? 'open' : ''}`}
        title={`${providerName} 的模型与思考强度（点开切换）`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {triggerLabel}
      </button>

      {open && (
        <div className="model-picker-panel" id={panelId} role="dialog" aria-label="模型设置">
          {/* ── ① 模型 ── */}
          <div className="mp-section">
            <div className="mp-label">模型</div>
            {totalModels === 0 ? (
              <>
                <p className="mp-hint">这个连接没有返回模型列表，只能手填。</p>
                <form
                  className="mp-manual"
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    submitManual();
                  }}
                >
                  <input
                    value={manualDraft}
                    placeholder="模型 id，例如 gpt-4o-mini"
                    onChange={(event) => {
                      setManualDraft(event.target.value);
                    }}
                  />
                  <button type="submit" className="small" disabled={manualDraft.trim().length === 0}>
                    使用
                  </button>
                </form>
              </>
            ) : (
              <>
                <input
                  className="mp-search"
                  value={query}
                  placeholder={`搜索模型（共 ${String(totalModels)} 个 · ${String(groups.length)} 个连接）`}
                  aria-label="搜索模型"
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                />
                {visibleGroups.length === 0 ? (
                  <p className="mp-hint">没有匹配「{query.trim()}」的模型。</p>
                ) : (
                  <div className="mp-list" role="listbox" aria-label="模型列表">
                    {visibleGroups.map((group) => (
                      <div className="mp-group" key={`${group.providerId}\u0000${group.providerName}`}>
                        <div className="mp-group-head">
                          <span className="mp-provider-tag" title={group.providerName}>
                            {group.providerName}
                          </span>
                          <span className="mp-group-count">{group.models.length}</span>
                        </div>
                        {group.models.map((candidate) => {
                          const selected = isSelected(candidate, group.providerId);
                          return (
                            <button
                              key={`${group.providerId}\u0000${candidate}`}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              className={`mp-item ${selected ? 'on' : ''}`}
                              title={
                                group.providerId !== '' && group.providerId !== providerId
                                  ? `选用后会把这个会话切到「${group.providerName}」`
                                  : candidate
                              }
                              onClick={() => {
                                onPickModel(candidate, group.providerId === '' ? undefined : group.providerId);
                              }}
                            >
                              <span className="mp-item-name">{candidate}</span>
                              {showProviderTag && (
                                <span className="mp-item-provider">{group.providerName}</span>
                              )}
                              {selected && (
                                <span className="mp-check">
                                  <IconCheck size={12} />
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── ② 思考强度 ── */}
          <div className="mp-section">
            <div className="mp-label">思考强度</div>
            {efforts.length === 0 ? (
              <p className="mp-hint">这个模型没有声明可选强度。</p>
            ) : (
              <div className="mp-seg" role="group" aria-label="思考强度">
                {efforts.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    className={candidate === effort ? 'on' : ''}
                    aria-pressed={candidate === effort}
                    onClick={() => {
                      onPickEffort(candidate);
                    }}
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── ③ 上下文上限 ── */}
          <div className="mp-section">
            <div className="mp-label">上下文上限</div>
            <div className="mp-window">
              <input
                value={windowDraft}
                inputMode="numeric"
                aria-label="上下文窗口 tokens"
                onChange={(event) => {
                  setWindowDraft(event.target.value);
                }}
                onBlur={commitWindow}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitWindow();
                  }
                }}
              />
              <span className="mp-unit">tokens</span>
            </div>
            <div className="mp-presets">
              {WINDOW_PRESETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`small ${value === contextWindow ? 'on' : ''}`}
                  onClick={() => {
                    onSetContextWindow(value);
                  }}
                >
                  {windowLabel(value)}
                </button>
              ))}
            </div>
            <p className="mp-hint">填小了只会更早提示压缩，不会溢出；改了要重新进会话才生效。</p>
          </div>
        </div>
      )}
    </div>
  );
}
