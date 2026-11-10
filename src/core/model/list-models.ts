/**
 * 模型目录探针：`GET {baseUrl}/{modelsPath}`。
 *
 * 这是"模型接入"能不能好用的关键一步 —— 用户填完 key 就该**看到模型列表**，
 * 而不是自己背模型名。参照项目里也是这么做的（`ModelsApi.kt`）。
 *
 * ★ 错误必须**可行动**：401 和 404 是完全不同的问题，混成一句"连接失败"等于没说。
 */

export type ModelInfo = {
  readonly id: string;
  readonly ownedBy: string | null;
};

export type ModelProbe = {
  readonly ok: boolean;
  readonly models: ModelInfo[];
  readonly latencyMs: number;
  readonly status: number | null;
  readonly error: string | null;
  readonly hint: string | null;
  /** 实际请求的 URL —— 排查时比任何描述都有用 */
  readonly url: string;
};

const DEFAULT_TIMEOUT_MS = 12_000;

export function resolveModelsUrl(baseUrl: string, modelsPath?: string | null): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
  const raw = (modelsPath ?? '').trim();

  // 绝对 URL = 直接覆盖（有些网关 chat 与 models 前缀不同）
  if (/^https?:\/\//i.test(raw)) return raw;

  const path = raw.length > 0 ? raw.replace(/^\/+/, '') : 'models';
  return `${trimmedBase}/${path}`;
}

function parseModels(payload: unknown): ModelInfo[] {
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null
      ? ((payload as { data?: unknown }).data as unknown[] | undefined) ??
        ((payload as { models?: unknown }).models as unknown[] | undefined) ??
        []
      : [];

  const out: ModelInfo[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      out.push({ id: item, ownedBy: null });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = record['id'] ?? record['name'] ?? record['model'];
    if (typeof id !== 'string' || id.length === 0) continue;
    const owner = record['owned_by'] ?? record['owner'] ?? record['organization'];
    out.push({ id, ownedBy: typeof owner === 'string' ? owner : null });
  }

  // 去重（有些网关会重复返回），保持上游顺序
  const seen = new Set<string>();
  return out.filter((model) => (seen.has(model.id) ? false : (seen.add(model.id), true)));
}

export type ProbeInput = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelsPath?: string | null;
  readonly timeoutMs?: number;
};

export async function probeModels(input: ProbeInput): Promise<ModelProbe> {
  const url = resolveModelsUrl(input.baseUrl, input.modelsPath);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    const latencyMs = Date.now() - started;
    const text = await response.text();

    if (!response.ok) {
      const detail = text.slice(0, 300).replace(/\s+/g, ' ').trim();
      const hint =
        response.status === 401 || response.status === 403
          ? '密钥被拒绝。检查 Key 是否填错、是否已过期、是否与这个接入点匹配（套餐 Key 常只能用于专用域名）。'
          : response.status === 404
            ? '这个地址下没有模型列表。多半是 Base URL 少了/多了路径段，或该服务商不支持 GET /models —— 填「模型列表路径」或直接手填模型名。'
            : response.status === 429
              ? '被限流了。稍等再试，或换一个接入点。'
              : `服务端返回 ${response.status}。${detail.length > 0 ? `原文：${detail}` : ''}`;
      return { ok: false, models: [], latencyMs, status: response.status, error: `HTTP ${response.status}`, hint, url };
    }

    const models = parseModels(JSON.parse(text) as unknown);
    if (models.length === 0) {
      return {
        ok: false,
        models: [],
        latencyMs,
        status: response.status,
        error: '返回里没有可识别的模型列表',
        hint: '地址可能指向了网页而不是 API。确认 Base URL 形如 https://api.xxx.com/v1（不带 /chat/completions）。',
        url,
      };
    }

    return { ok: true, models, latencyMs, status: response.status, error: null, hint: null, url };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /abort|timeout/i.test(message);
    return {
      ok: false,
      models: [],
      latencyMs,
      status: null,
      error: timedOut ? '请求超时' : message,
      hint: timedOut
        ? '12 秒没有响应。检查网络/代理，或确认这个域名在国内能否直连。'
        : '请求发不出去。检查 Base URL 是否写对（必须 http/https 开头、域名可达）。',
      url,
    };
  }
}
