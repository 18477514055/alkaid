import { useEffect, useMemo, useState } from 'react';

import './setup-dialog.css';
import {
  api,
  type ModelProbeDto,
  type ProviderDto,
  type ProviderPresetDto,
} from './api.ts';
import { IconCheck, IconPlus } from './icons.tsx';
import { WINDOW_PRESETS } from './windowPresets.ts';

/**
 * 模型接入。目标是**能点的都不让人打字**：
 *
 * 1. 先选服务商（46 家内置目录，含"同一厂商多接入点"：通义 5 个、小米 4 个）；
 * 2. baseUrl 自动填好，只有 key 需要粘贴；
 * 3. 点「拉取模型」→ 直接列出这家账号下真实可用的模型，点一下选中；
 * 4. 上下文窗口给常用档位，默认 128k；
 * 5. 保存前先探针（GET /models）—— 401 和 404 的提示是分开写的，不是一句"连接失败"。
 *
 * ★ 自定义（OpenAI 兼容）永远是第一项：目录没收录的网关照样能接。
 */

/** 档位唯一真源在 windowPresets.ts（含 500k 档位） */

type Props = {
  readonly providers: readonly ProviderDto[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
};

type Step = 'pick' | 'config' | 'manage';

export function SetupDialog({ providers, onClose, onChanged }: Props): React.ReactElement {
  const [step, setStep] = useState<Step>(providers.length > 0 ? 'manage' : 'pick');
  const [presets, setPresets] = useState<ProviderPresetDto[]>([]);
  const [search, setSearch] = useState('');
  const [presetId, setPresetId] = useState<string>('__custom__');
  const [endpointIndex, setEndpointIndex] = useState(0);
  const [apiKey, setApiKey] = useState('');
  const [modelsPath, setModelsPath] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [contextWindow, setContextWindow] = useState(128_000);
  /** 编辑中的连接 id；null = 正在新增 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 对话中可选的模型白名单（编辑时能勾） */
  const [enabledModels, setEnabledModels] = useState<string[]>([]);
  const [probe, setProbe] = useState<ModelProbeDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listPresets()
      .then(setPresets)
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  const preset = useMemo(
    () => (presetId === '__custom__' ? null : (presets.find((item) => item.id === presetId) ?? null)),
    [presetId, presets],
  );

  const baseUrl = preset === null ? '' : (preset.endpoints[endpointIndex]?.baseUrl ?? preset.endpoints[0]?.baseUrl ?? '');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customName, setCustomName] = useState('');
  const effectiveBaseUrl = preset === null ? customBaseUrl : baseUrl;

  const filtered = useMemo(() => {
    // 只显示真的有 baseUrl 的（目录里还有一条 "custom"，那是给手填用的，由下面的「自定义」承担）
    const usable = presets.filter((item) => item.endpoints.some((endpoint) => endpoint.baseUrl.trim().length > 0));
    const keyword = search.trim().toLowerCase();
    if (keyword.length === 0) return usable;
    return usable.filter(
      (item) =>
        item.id.toLowerCase().includes(keyword) ||
        item.displayName.toLowerCase().includes(keyword) ||
        item.endpoints.some((endpoint) => endpoint.baseUrl.toLowerCase().includes(keyword)),
    );
  }, [presets, search]);

  const choosePreset = (id: string): void => {
    setPresetId(id);
    setEndpointIndex(0);
    setModels([]);
    setModel('');
    setProbe(null);
    setError(null);
    const found = presets.find((item) => item.id === id);
    setModelsPath(found?.modelsPathOverride ?? '');
    setContextWindow(128_000);
    setStep('config');
  };

  const runProbe = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.probeProvider({
        baseUrl: effectiveBaseUrl,
        apiKey: apiKey.trim(),
        ...(modelsPath.trim().length > 0 ? { modelsPath: modelsPath.trim() } : {}),
      });
      setProbe(result);
      if (result.ok) {
        setModels(result.models.map((item) => item.id));
        if (model.length === 0 && result.models[0] !== undefined) setModel(result.models[0].id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProvider({
        name: (preset?.displayName ?? customName.trim()) || '自定义连接',
        baseUrl: effectiveBaseUrl,
        apiKey: apiKey.trim(),
        ...(model.length > 0 ? { defaultModel: model } : {}),
        ...(modelsPath.trim().length > 0 ? { modelsPath: modelsPath.trim() } : {}),
        // ★ 这两项决定"能不能连上"：有的网关不带会话头直接 400 MissingSessionID
        ...(preset !== null && preset.sessionHeaderName.length > 0 ? { sessionHeader: preset.sessionHeaderName } : {}),
        ...(preset !== null && Object.keys(preset.defaultHeaders).length > 0
          ? { extraHeaders: preset.defaultHeaders }
          : {}),
      });
      if (contextWindow !== 128_000) {
        await api.patchProvider(created.id, { contextWindow });
      }
      /**
       * ★ 新建时把「对话中可选模型」设成**只有刚选的那一个**。
       *   不设的话会回退到 defaultModel，看起来一样；但显式写下来，
       *   用户在编辑页才能看到"哦，原来被限定成一个了"。
       */
      if (model.length > 0) {
        await api.patchProvider(created.id, { enabledModels: [model] });
      }
      onChanged();
      setStep('manage');
      setApiKey('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 进入编辑：把这条连接现有配置填回表单。
   *
   * ★ 三个刻意的选择：
   *   1. **不预填 apiKey**（后端从来不下发密钥，界面也不该假装知道）；
   *      留空 = 不改密钥；填了才改。
   *   2. **不重跑探针**就已经把"目录"按现有配置填好 —— 编辑时用户多半只是想改名字或窗口，
   *      不该为了看一个列表就强制先探一次网。
   *   3. `baseUrl` 走自定义分支（preset 置空）：编辑的是一条已存在的连接，
   *      它可能来自任何预设，硬套某个 preset 的端点会把它改坏。
   */
  const startEdit = async (item: ProviderDto): Promise<void> => {
    setError(null);
    setEditingId(item.id);
    setStep('config');
    setPresetId('__custom__');
    setCustomName(item.name);
    setCustomBaseUrl(item.baseUrl);
    setModelsPath(item.modelsPath ?? '');
    setModel(item.defaultModel ?? '');
    setContextWindow(item.contextWindow);
    setApiKey('');
    setProbe(null);
    setEnabledModels(item.enabledModels ?? (item.defaultModel === null ? [] : [item.defaultModel]));

    // 顺手拉一次目录，让「可选模型」有多选项可挑；拉不到也不阻塞（可以手填）
    try {
      const catalog = await api.listModels(item.id);
      setModels(catalog.ok ? (catalog.catalog ?? catalog.models.map((m) => m.id)) : []);
    } catch {
      setModels([]);
    }
  };

  /** 保存编辑（只 PATCH 这条连接，不新建） */
  const saveEdit = async (): Promise<void> => {
    if (editingId === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.patchProvider(editingId, {
        name: customName.trim().length > 0 ? customName.trim() : '自定义连接',
        baseUrl: customBaseUrl.trim(),
        modelsPath: modelsPath.trim(),
        defaultModel: model.length > 0 ? model : null,
        contextWindow,
        enabledModels,
        // ★ 只有用户真填了新密钥才改；留空表示"保持原样"
        ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      });
      onChanged();
      setEditingId(null);
      setStep('manage');
      setApiKey('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await api.deleteProvider(id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <div className="modal-head">
          <h2>模型接入</h2>
          <div className="tabs">
            <button type="button" className={step === 'manage' ? 'tab active' : 'tab'} onClick={() => setStep('manage')}>
              已接入 {providers.length}
            </button>
            <button type="button" className={step === 'pick' ? 'tab active' : 'tab'} onClick={() => setStep('pick')}>
              <IconPlus size={12} /> 新增
            </button>
          </div>
        </div>

        {error !== null && <div className="banner danger">{error}</div>}

        {step === 'manage' && (
          <>
            {providers.length === 0 ? (
              <div className="side-empty">还没有接入任何模型。点右上「新增」开始。</div>
            ) : (
              <ul className="conn-list">
                {providers.map((item) => (
                  <li key={item.id}>
                    <div className="conn-main">
                      <span className="conn-name">{item.name}</span>
                      <span className="conn-meta">{item.baseUrl}</span>
                      <span className="conn-meta">
                        模型 {item.defaultModel ?? '未指定'} · 窗口 {(item.contextWindow / 1000).toFixed(0)}k ·{' '}
                        {item.hasKey ? '已保存密钥' : '缺密钥'}
                      </span>
                      {/*
                        ★ 白名单摘要要露出来：用户最困惑的就是「我只配了一个，为什么能选到一堆」。
                          这里直接告诉他"对话里只给这几个"。
                      */}
                      <span className="conn-meta">
                        对话中可选：
                        {item.enabledModels === null
                          ? item.defaultModel === null
                            ? '（未限定，将回退到默认模型）'
                            : `${item.defaultModel}（默认模型）`
                          : item.enabledModels.length === 0
                            ? '（已清空，没有任何可选模型）'
                            : item.enabledModels.join('、')}
                      </span>
                    </div>
                    <div className="conn-actions">
                      <button
                        type="button"
                        className="ghost small"
                        disabled={busy}
                        onClick={() => void startEdit(item)}
                      >
                        编辑
                      </button>
                      <button type="button" className="ghost small" disabled={busy} onClick={() => void remove(item.id)}>
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">
              密钥只保存在本机 <code>~/.alkaid/secrets.json</code>，不进日志、不回显。
            </p>
          </>
        )}

        {step === 'pick' && (
          <>
            <input
              className="search"
              placeholder="搜索服务商（如 deepseek / 通义 / kimi / openrouter）"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <ul className="preset-list">
              {filtered.map((item) => (
                <li key={item.id}>
                  <button type="button" className="preset-item" onClick={() => choosePreset(item.id)}>
                    <span className="preset-name">{item.displayName}</span>
                    <span className="preset-meta">
                      {item.endpoints[0]?.baseUrl ?? ''}
                      {item.endpoints.length > 1 ? ` · ${item.endpoints.length} 个接入点` : ''}
                    </span>
                  </button>
                </li>
              ))}
              {/* ★ 自定义放**最后**：它是兜底，不该插在一堆厂商中间 */}
              <li className="preset-custom">
                <button type="button" className="preset-item" onClick={() => choosePreset('__custom__')}>
                  <span className="preset-name">自定义接入（OpenAI 兼容）</span>
                  <span className="preset-meta">上面没有你的服务商？自己填 baseUrl</span>
                </button>
              </li>
            </ul>
          </>
        )}

        {step === 'config' && (
          <>
            <div className="field">
              <span className="field-label">服务商</span>
              <div className="field-value">{preset?.displayName ?? '自定义（OpenAI 兼容）'}</div>
            </div>

            {preset === null ? (
              <>
                <label>
                  名称
                  <input value={customName} placeholder="例如 公司网关" onChange={(event) => setCustomName(event.target.value)} />
                </label>
                <label>
                  Base URL
                  <input
                    value={customBaseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => setCustomBaseUrl(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                {preset.endpoints.length > 1 && (
                  <div className="field">
                    <span className="field-label">接入点</span>
                    <div className="chip-row">
                      {preset.endpoints.map((endpoint, index) => (
                        <button
                          key={`${endpoint.baseUrl}-${index}`}
                          type="button"
                          className={index === endpointIndex ? 'chip active' : 'chip'}
                          title={endpoint.note || endpoint.baseUrl}
                          onClick={() => setEndpointIndex(index)}
                        >
                          {endpoint.label}
                          {endpoint.recommended ? ' ★' : ''}
                        </button>
                      ))}
                    </div>
                    <div className="field-value mono">{baseUrl}</div>
                  </div>
                )}
                {preset.note.length > 0 && <p className="hint">{preset.note}</p>}
              </>
            )}

            <label>
              API Key
              <input type="password" value={apiKey} placeholder="粘贴密钥" onChange={(event) => setApiKey(event.target.value)} />
            </label>

            <div className="field">
              <span className="field-label">模型</span>
              <div className="row-inline">
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy || effectiveBaseUrl.length === 0 || apiKey.trim().length === 0}
                  onClick={() => void runProbe()}
                >
                  {busy ? '正在拉取…' : '拉取模型列表'}
                </button>
                {probe !== null && (
                  <span className={probe.ok ? 'ok-text' : 'warn-text'}>
                    {probe.ok ? `拉到 ${probe.models.length} 个 · ${probe.latencyMs}ms` : (probe.error ?? '失败')}
                  </span>
                )}
              </div>
              {probe !== null && !probe.ok && probe.hint !== null && <p className="hint danger">{probe.hint}</p>}
              {models.length > 0 ? (
                <div className="chip-row scroll">
                  {models.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={item === model ? 'chip active' : 'chip'}
                      onClick={() => setModel(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  placeholder="拉不到列表时手填模型名（如 deepseek-chat）"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              )}
            </div>

            <div className="field">
              <span className="field-label">上下文窗口</span>
              <div className="chip-row">
                {WINDOW_PRESETS.map((tokens) => (
                  <button
                    key={tokens}
                    type="button"
                    className={tokens === contextWindow ? 'chip active' : 'chip'}
                    onClick={() => setContextWindow(tokens)}
                  >
                    {tokens >= 1000 ? `${tokens / 1000}k` : String(tokens)}
                  </button>
                ))}
              </div>
              <p className="hint">底部状态栏的「水位」用它当分母。填小了只会更早提醒压缩，不会溢出。</p>
            </div>

            {/*
              ★ 这一节回答用户最困惑的那个问题：「我只配了一个，为什么对话里能选到一堆」。
                对话里的模型选择器读的是这个白名单，不读网关完整目录。
            */}
            <div className="field">
              <span className="field-label">对话中可选的模型</span>
              {models.length === 0 ? (
                <p className="hint">
                  还没有拉到模型目录（可能是没探针，或网关不支持 GET /models）。
                  不设白名单时会回退到上面选的默认模型，对话里就只剩那一个。
                </p>
              ) : (
                <>
                  <div className="model-checks">
                    {models.map((item) => (
                      <label key={item} className="model-check">
                        <input
                          type="checkbox"
                          checked={enabledModels.includes(item)}
                          onChange={(event) => {
                            setEnabledModels((current) =>
                              event.target.checked
                                ? [...new Set([...current, item])]
                                : current.filter((name) => name !== item),
                            );
                          }}
                        />
                        <span>{item}</span>
                      </label>
                    ))}
                  </div>
                  <div className="chip-row" style={{ marginTop: 6 }}>
                    <button type="button" className="chip" onClick={() => setEnabledModels([...models])}>
                      全选
                    </button>
                    <button type="button" className="chip" onClick={() => setEnabledModels([])}>
                      全不选
                    </button>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => setEnabledModels(model.length > 0 ? [model] : [])}
                    >
                      只要默认这一个
                    </button>
                  </div>
                  <p className="hint">
                    只勾选你真正要用的。勾太多会让对话里的模型菜单变成一长串，选错了还会直接请求失败。
                  </p>
                </>
              )}
            </div>

            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setStep(preset === null && editingId !== null ? 'manage' : 'pick')}>
                上一步
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  effectiveBaseUrl.length === 0 ||
                  // 新增必须填密钥；编辑时留空表示"不改密钥"
                  (editingId === null && apiKey.trim().length === 0)
                }
                onClick={() => void (editingId === null ? save() : saveEdit())}
              >
                <IconCheck size={13} /> {editingId === null ? '保存' : '保存修改'}
              </button>
            </div>
          </>
        )}

        <div className="modal-actions close-only">
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
