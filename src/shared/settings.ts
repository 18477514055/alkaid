/**
 * 应用设置的**唯一契约**（服务端与前端共用）。
 *
 * ★ 为什么不再放 `localStorage`（2026-11-09 用户报「每次更新设置就没了」）：
 *   桌面壳每次启动都会挑一个**随机空闲端口**，于是前端 origin 从
 *   `http://127.0.0.1:61715` 变成 `http://127.0.0.1:52344`……
 *   而 `localStorage` 是**按 origin 隔离**的 ⇒ 设置每次重启（更别说更新）就归零。
 *   现在设置存到服务端（家目录稳定），与更新/重启完全无关。
 *
 * ★ 三条判据：
 *  1. **默认值尽量对齐 DSH 官方端**（用户早习惯了那套）。
 *  2. **非法值一律回落默认，不报错、不写坏**：设置是"随时可能被旧版本/手改"的数据，
 *     读的时候必须能容错，否则一个坏字段能让整个设置面板打不开。
 *  3. **`null` 与 `0` 语义不同**：`null` = 不限制（关掉上限），`0` 不是合法上限值。
 */

/** 思考强度：`default` 表示跟随模型。 */
export type ThinkingEffortSetting = 'default' | 'off' | 'low' | 'medium' | 'high';

/** 忙碌时按 Enter 的行为 */
export type BusySendBehavior = 'queue' | 'interrupt';

/**
 * 通用设置（全局）。
 * 这些是**新会话的默认值 + 内核行为开关**，不是某个会话的即时状态。
 */
export type GeneralSettings = {
  /** 新会话默认权限档 */
  readonly defaultPermissionMode: string;
  /** 新会话默认思考强度 */
  readonly defaultThinkingEffort: ThinkingEffortSetting;
  /** 新会话默认上下文窗口（tokens），底部水位分母 */
  readonly defaultContextWindow: number;
  /** 会话正在生成时，Enter 的行为 */
  readonly busySendBehavior: BusySendBehavior;
  /** 自动压缩开关；仍须台账更新、进展日志、triage 三项分别成功，不旁路收尾门。 */
  readonly autoCompactEnabled: boolean;
  /** 自动压缩水位线（百分比），1–99，允许小数；与项目 5% 台账整理间隔不同。 */
  readonly compactThresholdPercent: number;
  /**
   * 单轮步数上限。
   * - 数字：夹到 [MIN_STEPS, MAX_STEPS]
   * - `null`：**不限制**（用户显式关闭上限）
   */
  readonly maxStepsPerTurn: number | null;
  /**
   * 单个工具输出上限（字符）。
   * - 数字：夹到 [MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS]
   * - `null`：**不限制**（不再截断工具输出）
   * ★ 关掉它意味着长输出会整段进上下文 —— 可能一口气吃掉大量窗口与费用，
   *   所以界面上要明说这个代价，而不是悄悄放开。
   */
  readonly maxToolOutputChars: number | null;
  /**
   * **子代理可以用的模型白名单**（2026-11-10 用户要求）。
   *
   * 语义（三条，判据都写在这里，免得以后各自解释）：
   * - `null` ⇒ **不限制**：主对话可以给子代理选任意已注册模型（默认）。
   * - 空数组 `[]` ⇒ **一个都不许**：子代理只能跟主对话用同一个模型。
   *   ★ 它和 `null` 必须分得开 —— 这正是"关掉白名单"与"白名单全禁"的区别。
   * - 非空数组 ⇒ 只允许这些模型 id。数组里存的是**模型 id 字符串**
   *   （`providerId::model` 形式见下），因为不同连接下可能有同名模型。
   *
   * ★ 为什么键是 `providerId::model` 而不是裸 model：
   *   两个连接（比如官方与自建网关）都可以有 `deepseek-chat`，
   *   只写模型名会让"白名单里的 deepseek-chat"把两家的都放进来 —— 那不是限制。
   */
  readonly delegateAllowedModels: readonly string[] | null;
  /**
   * **是否允许把"主对话自己在用的那个模型"指派给子代理**（独立开关，2026-11-10 用户要求）。
   *
   * ★ 为什么它要单独一个开关，而不是直接塞进白名单：
   *   "沿用主对话的模型"是最省事、也最常被用的路径（主对话往往就用最合适的那个）。
   *   但它同时是**最容易被滥用**的一条：一路默认下去，所有子代理都在同一个模型上跑，
   *   白名单等于没设。所以用户要能单独关掉它，而不必去白名单里手工排除自己那个。
   *
   * 判据（与白名单的组合，三种情况）：
   * - `true`（默认）⇒ 主对话那一对**永远视作在白名单内**（不论是沿用还是不传）。
   * - `false` ⇒ 主对话那一对**不特殊对待**，必须像别的模型一样过白名单：
   *   白名单 `null`（不限制）时仍可用；白名单非空时必须在列表里；空数组时不可用。
   * - 白名单为 `null`（不限制）时，这个开关对"别的模型"没有影响，只影响自己那一对。
   */
  readonly delegateAllowParentModel: boolean;
}

/** 右栏面板（看板）可见的页签 */
export type PanelTab = 'work' | 'memory' | 'logs' | 'principles';

export const PANEL_TABS: readonly PanelTab[] = ['work', 'memory', 'logs', 'principles'];

export const PANEL_TAB_LABEL: Readonly<Record<PanelTab, string>> = {
  work: '工作',
  memory: '台账',
  logs: '日志',
  principles: '原则',
};

/**
 * 右栏（看板）设置。
 * - `global` 作用域 = **没有项目的对话**用这一份，同时也是新项目的初始值；
 * - `project` 作用域 = 某个项目自己的覆盖。
 */
export type PanelSettings = {
  /** 显示哪些页签（顺序即 PANEL_TABS 顺序，这里只控制是否显示） */
  readonly visibleTabs: readonly PanelTab[];
  /** 打开时默认停在哪个页签；不在 visibleTabs 里就用第一个可见的 */
  readonly defaultTab: PanelTab;
  /** 右栏宽度（CSS px） */
  readonly width: number;
  /** 「高级」区块是否默认展开 */
  readonly advancedOpen: boolean;
};

export const PERMISSION_MODES_SETTING: readonly string[] = [
  'readonly',
  'workspace',
  'project',
  'workspace_project',
  'full',
];

export const THINKING_EFFORTS_SETTING: readonly ThinkingEffortSetting[] = [
  'default',
  'off',
  'low',
  'medium',
  'high',
];

export const MIN_STEPS = 1;
export const MAX_STEPS = 1000;
export const MIN_OUTPUT_CHARS = 1_000;
export const MAX_OUTPUT_CHARS = 5_000_000;

export const MIN_PANEL_WIDTH = 304;
export const MAX_PANEL_WIDTH = 1200;

/**
 * 默认值 —— 依据是 DSH 官方端真配置
 * （`~/.dsh/profiles/desktop/cordis.patch.yml`）：
 * `permission.defaultPreset` 是 danger-full-access，但本平台的权限**同时决定工具可见性**，
 * 所以这里仍取 `workspace`；`contextBudgets` 主流模型给 1M；思考强度不指定。
 */
export const DEFAULT_GENERAL: GeneralSettings = {
  defaultPermissionMode: 'workspace',
  defaultThinkingEffort: 'default',
  defaultContextWindow: 1_000_000,
  busySendBehavior: 'queue',
  autoCompactEnabled: true,
  compactThresholdPercent: 80,
  maxStepsPerTurn: 40,
  maxToolOutputChars: 80_000,
  // 默认不限制：不给用户一个"默认就选不了模型"的惊讶
  delegateAllowedModels: null,
  /**
   * ★ 默认 `true`：不给用户一个"默认连自己的模型都派不出去"的惊讶。
   *   想收紧的人会主动去关它（那是明确的意图），而不是反过来。
   */
  delegateAllowParentModel: true,
};

/**
 * 把 `providerId::model` 拼成白名单键 / 拆开。
 *
 * ★ 分隔符用 `::` 而不是 `:`：模型 id 里常带 `:`（如 `vendor:model-v2`），
 *   用单冒号拆会把 id 切坏。
 */
export function delegateModelKey(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

export function parseDelegateModelKey(key: string): { providerId: string; model: string } | null {
  const index = key.indexOf('::');
  if (index <= 0) return null;
  const providerId = key.slice(0, index);
  const model = key.slice(index + 2);
  if (providerId.length === 0 || model.length === 0) return null;
  return { providerId, model };
}

export const DEFAULT_PANEL: PanelSettings = {
  visibleTabs: ['work', 'memory', 'logs', 'principles'],
  defaultTab: 'work',
  width: 608,
  advancedOpen: false,
};

/** 没有项目的对话能用的页签：台账/原则是项目域的，没有项目就没有它们。 */
export const PANEL_TABS_WITHOUT_PROJECT: readonly PanelTab[] = ['work', 'logs'];

function int(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/** 数字型上限：`null` 表示不限制，其余按范围夹，非法回落默认 */
function limit(value: unknown, fallback: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min) return fallback;
  return Math.min(rounded, max);
}

export function normalizeGeneral(input: unknown): GeneralSettings {
  const raw = (input ?? {}) as Partial<Record<keyof GeneralSettings, unknown>>;

  const permission =
    typeof raw.defaultPermissionMode === 'string' && PERMISSION_MODES_SETTING.includes(raw.defaultPermissionMode)
      ? raw.defaultPermissionMode
      : DEFAULT_GENERAL.defaultPermissionMode;

  const effort =
    typeof raw.defaultThinkingEffort === 'string' &&
    (THINKING_EFFORTS_SETTING as readonly string[]).includes(raw.defaultThinkingEffort)
      ? (raw.defaultThinkingEffort as ThinkingEffortSetting)
      : DEFAULT_GENERAL.defaultThinkingEffort;

  const window = int(raw.defaultContextWindow, DEFAULT_GENERAL.defaultContextWindow, 1_000, 20_000_000);
  const busy: BusySendBehavior = raw.busySendBehavior === 'interrupt' ? 'interrupt' : 'queue';

  return {
    defaultPermissionMode: permission,
    defaultThinkingEffort: effort,
    defaultContextWindow: window,
    busySendBehavior: busy,
    autoCompactEnabled: raw.autoCompactEnabled === false ? false : true,
    compactThresholdPercent: typeof raw.compactThresholdPercent === 'number' && Number.isFinite(raw.compactThresholdPercent) && raw.compactThresholdPercent >= 1 && raw.compactThresholdPercent <= 99
      ? raw.compactThresholdPercent : DEFAULT_GENERAL.compactThresholdPercent,
    maxStepsPerTurn: limit(raw.maxStepsPerTurn, DEFAULT_GENERAL.maxStepsPerTurn, MIN_STEPS, MAX_STEPS),
    maxToolOutputChars: limit(
      raw.maxToolOutputChars,
      DEFAULT_GENERAL.maxToolOutputChars,
      MIN_OUTPUT_CHARS,
      MAX_OUTPUT_CHARS,
    ),
    /**
     * ★ 白名单三态归一化（`null` / `[]` / 非空数组 各是各的意思，见类型注释）。
     * - 不是数组 ⇒ 回落默认（`null` = 不限制），**不**把它当空数组 ——
     *   那会把所有子代理模型突然禁掉，是很危险的"手滑后果"。
     * - 数组里只留非空字符串，去重，最多 200 条（防止被塞爆）。
     */
    delegateAllowedModels: (() => {
      const value = raw.delegateAllowedModels;
      if (value === null) return null;
      if (!Array.isArray(value)) return DEFAULT_GENERAL.delegateAllowedModels;
      const seen = new Set<string>();
      for (const item of value) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed.length > 0 && trimmed.length <= 300) seen.add(trimmed);
        if (seen.size >= 200) break;
      }
      return [...seen];
    })(),
    /**
     * ★ 布尔开关只认 `=== false`：取不到 / 是垃圾 / 是字符串 "false" 时一律按**允许**。
     *   判据与白名单类字段相反：这里"允许"是更保守的选择（它不放开任何**别的**模型，
     *   只是允许用自己那个），而误判成 `false` 会让用户突然派不出活却不知道为什么。
     */
    delegateAllowParentModel: raw.delegateAllowParentModel === false ? false : true,
  };
}

/**
 * 右栏设置归一化。
 * `allowedTabs` 由调用方给：有项目时是四个，没项目时只有 `work` / `logs`。
 * ★ 必须过滤掉不允许的页签 —— 否则"无项目对话"会被存进 `memory`，
 *   然后每次打开都落在一个根本没有内容的页签上。
 */
export function normalizePanel(input: unknown, allowedTabs: readonly PanelTab[] = PANEL_TABS): PanelSettings {
  const raw = (input ?? {}) as Partial<Record<keyof PanelSettings, unknown>>;

  const requested = Array.isArray(raw.visibleTabs) ? raw.visibleTabs : DEFAULT_PANEL.visibleTabs;
  const visible: PanelTab[] = [];
  for (const tab of PANEL_TABS) {
    if (!allowedTabs.includes(tab)) continue;
    if (requested.includes(tab) || (requested as readonly unknown[]).length === 0) visible.push(tab);
  }
  // 允许集非空却一个都没勾 ⇒ 回落到允许集的第一个，不能给出"空面板"
  const finalVisible = visible.length > 0 ? visible : [allowedTabs[0] ?? 'work'];

  const fallbackTab = finalVisible[0] ?? 'work';
  const tab =
    typeof raw.defaultTab === 'string' && (finalVisible as readonly string[]).includes(raw.defaultTab)
      ? (raw.defaultTab as PanelTab)
      : fallbackTab;

  return {
    visibleTabs: finalVisible,
    defaultTab: tab,
    width: int(raw.width, DEFAULT_PANEL.width, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH),
    advancedOpen: raw.advancedOpen === true,
  };
}

/**
 * 磨合上下限给内核用：把 `null`（不限制）与数字区分开交代出去。
 * ★ 内核要的是**明确的"不限制"**，不能拿 0 或 Infinity 混过去：
 *   0 会被当成"输出上限 0"把所有工具输出清空。
 */
export type EffectiveLimit = { readonly unlimited: false; readonly value: number } | { readonly unlimited: true };

export function effectiveLimit(value: number | null): EffectiveLimit {
  return value === null ? { unlimited: true } : { unlimited: false, value };
}
