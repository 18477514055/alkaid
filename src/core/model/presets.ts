import { readFileSync } from 'node:fs';

/**
 * 内置的模型服务商目录（46 家）。
 *
 * 数据来源：参照项目 `66-ChatMobile` 的 `net/Providers.kt`（它本身溯源到 DSH 内置的
 * provider 目录 `@deepseek-ai/dsh-llm-pi-ai` 的 PROVIDER_DATA）。**只收 OpenAI 兼容端点。**
 *
 * ★ 这份目录的价值不在"有个下拉框"，而在**把不该让人手填的东西填好**：
 *   - baseUrl（含"同一厂商多接入点"这种真实差异：通义 5 个、小米 4 个、智谱 3 个）；
 *   - 模型列表路径（有些网关 chat 与 models 前缀不同）；
 *   - 常见模型名（拉不到 /models 时的兜底）；
 *   - 该家是否支持 GET /models（不支持的就不给"拉取"按钮，不给假按钮）。
 *
 * ★ 目录里**没有密钥**，可以随包分发。
 */

export type PresetEndpoint = {
  readonly label: string;
  readonly baseUrl: string;
  readonly note: string;
  readonly recommended: boolean;
};

export type ProviderPreset = {
  readonly id: string;
  readonly displayName: string;
  readonly endpoints: readonly PresetEndpoint[];
  readonly commonModels: readonly string[];
  readonly supportsModelList: boolean;
  readonly modelsPathOverride: string;
  /** 静态默认请求头（不含密钥） */
  readonly defaultHeaders: Record<string, string>;
  /**
   * 必须带**按对话固定**值的头名（空 = 这家不需要）。
   * ★ 真机撞出来的：OpenCode / OpenCode Go 不带 `x-opencode-session` 直接
   *   400 `{"type":"MissingSessionID"}`。值必须稳定（用 conversationId），不能随机。
   */
  readonly sessionHeaderName: string;
  readonly docUrl: string;
  readonly note: string;
};

let cached: readonly ProviderPreset[] | null = null;

export function listPresets(): readonly ProviderPreset[] {
  if (cached !== null) return cached;
  const raw = readFileSync(new URL('./presets.json', import.meta.url), 'utf8');
  cached = JSON.parse(raw) as ProviderPreset[];
  return cached;
}

export function findPreset(id: string): ProviderPreset | undefined {
  return listPresets().find((preset) => preset.id === id);
}
