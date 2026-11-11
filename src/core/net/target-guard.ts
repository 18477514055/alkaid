/**
 * **出站目标守卫**（2026-11-11 审计 `ALK-HIGH-07`：SSRF）。
 *
 * ## 两处会被"决定请求打到哪"的入口
 * 1. `POST /api/providers/probe` —— 服务端去请求调用方填的 `baseUrl`；
 * 2. MCP `http` 传输 —— 服务端长期往那个 URL 发 JSON-RPC。
 *
 * ## 判据（刻意收窄，只挡真正危险的那三类）
 * - 只允许 **http/https**；
 * - **拒绝云元数据地址**（`169.254.169.254` / `metadata.google.internal`）——
 *   它没有任何正当用途，却是最经典的 SSRF 目标；
 * - **拒绝指向我们自己的管理面**（本机回环 + 我们的端口）—— 否则模型可以
 *   「注册一个 MCP 服务器指向 /api/...」，让宿主在沙箱外替它调管理接口；
 * - 其它情况**放行**，包括本机回环与内网地址。
 *
 * ★ 为什么不像"一刀切禁内网"那样做（这是我与审计建议不同的地方，理由写在这里）：
 *   本地模型网关（Ollama / LM Studio / vLLM / 自建代理）默认就在 `127.0.0.1` 或 `192.168.x.x`，
 *   MCP server 也绝大多数在本机。一刀切会把这些**主要用法**全部打掉，
 *   而用户只会得出一个结论："这个功能坏了"。挡元数据 + 挡自指，是收益/代价最合理的那一格。
 *   真要更严：设 `ALKAID_STRICT_EGRESS=1`，那时除公网地址外一律拒绝。
 */

export type TargetVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', '169.254.169.254', 'fd00:ec2::254']);

function strictEgress(): boolean {
  return process.env['ALKAID_STRICT_EGRESS'] === '1';
}

/**
 * 判一个出站 URL 是否允许请求。
 * @param ownPort 我们自己的 HTTP 端口；命中它（且是本机回环）视为"指向自己"
 */
export function checkOutboundTarget(raw: string, ownPort?: number): TargetVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `不是合法的 URL：${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `只允许 http/https：${url.protocol}` };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_HOSTS.has(host)) {
    return { ok: false, reason: '不允许请求云元数据地址' };
  }

  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  if (loopback && ownPort !== undefined && ownPort > 0) {
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    if (port === ownPort) {
      return { ok: false, reason: `不允许请求瑶光自己的接口（端口 ${String(ownPort)}）` };
    }
  }

  if (strictEgress()) {
    const privateV4 = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/.test(host);
    const privateV6 = host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd');
    if (loopback || privateV4 || privateV6 || host.endsWith('.internal') || host.endsWith('.local')) {
      return { ok: false, reason: 'ALKAID_STRICT_EGRESS=1：不允许请求本机/内网地址' };
    }
  }
  return { ok: true };
}
