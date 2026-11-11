/**
 * Browser Host/Origin fence plus local bearer authorization.
 * Host allowlisting prevents DNS rebinding; the original Origin checks stay in force.
 * Every non-GET/HEAD/OPTIONS request additionally needs the local header/cookie,
 * except the exact POST pairing endpoint, whose one-time code proves possession.
 * Public reads never mint cookies. Fetch Metadata/Origin alone are not authentication.
 * Scope: restricted Low processes, NOT isolation from a same-user full shell/admin.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const LOCAL_AUTH_COOKIE = 'alkaid_local';

export type LocalAuthHeaders = {
  readonly 'x-alkaid-token'?: string | undefined;
  readonly cookie?: string | undefined;
};

/** Hash both inputs to fixed-size buffers before the constant-time comparison. */
function tokenEquals(candidate: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(candidate).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

/** Header or HttpOnly cookie proves possession; Fetch Metadata is never authentication.
 * This boundary protects restricted Low tools, not a same-user full shell/administrator.
 */
export function requestAuthenticated(headers: LocalAuthHeaders, localToken: string | null): boolean {
  if (localToken === null) return true;
  const cookies = (headers.cookie ?? '').split(';').map(part => part.trim());
  const values = cookies.filter(part => part.slice(0, part.indexOf('=')) === LOCAL_AUTH_COOKIE)
    .map(part => part.slice(part.indexOf('=') + 1));
  // Ambiguous duplicate cookies fail closed rather than relying on first/last parser order.
  const headerMatches = tokenEquals(headers['x-alkaid-token'] ?? '', localToken);
  const cookieMatches = tokenEquals(values.length === 1 ? values[0]! : '', localToken);
  return headerMatches || cookieMatches;
}

export type RequestLocalAuth = {
  readonly localToken: string | null;
  /** Only POST /api/auth/pair may bootstrap, after the original Host/Origin checks. */
  readonly pairingBootstrap?: boolean;
};

/** 永远算作"本机"的主机名 */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** `255.255.255.255` 之类没有意义；这里只做形状判定 */
function stripPort(hostHeader: string): string {
  const raw = hostHeader.trim().toLowerCase();
  if (raw.length === 0) return '';
  // IPv6 字面量：[::1]:8787
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    return close === -1 ? raw : raw.slice(0, close + 1);
  }
  const colon = raw.lastIndexOf(':');
  // 只有一个冒号才是 host:port；`::1` 这种纯 IPv6 不剥
  if (colon > 0 && raw.indexOf(':') === colon) return raw.slice(0, colon);
  return raw;
}

function isLoopbackBind(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  return isIP(value) === 4 && value.startsWith('127.');
}

export type TrustPolicy = {
  /** 只接受这些 `Host`（已含绑定的地址本身） */
  readonly allowedHosts: ReadonlySet<string>;
  /** 绑的是本机 ⇒ 只校验 `Host`；绑的是对外地址 ⇒ 还要求 `Origin` 同源 */
  readonly requireOrigin: boolean;
  /**
   * ★ 对外监听时，**写操作（非 GET/HEAD/OPTIONS）必须带 Origin**（2026-11-11 审计 `ALK-CRIT-01`）。
   *
   * 原判据是"没有 Origin 就放行"，理由是 CLI/curl/桌面壳/同源导航都不带它。
   * 但绑 `0.0.0.0` 时这条等于把 `requireOrigin` 作废：局域网里任何人都能不带 Origin
   * 直接 `curl -X POST` 打 API（改设置、发消息、删会话）。
   *
   * 现在的判据分两半：
   * - **读请求**（GET/HEAD/OPTIONS）没有副作用 ⇒ 仍然放行（curl 看健康、桌面壳轮询都不受影响）；
   * - **写请求**在对外监听时必须带 Origin 且同源；回环仅不要求 Origin，仍必须通过独立令牌层。
   */
  readonly requireOriginForWrites: boolean;
  /** 给出人类可读的策略描述（写进 `/api/healthz`，别让接手的人靠猜） */
  readonly description: string;
};

/**
 * 由绑定地址 + 白名单推导策略。
 *
 * @param bindHost `config.host`（`127.0.0.1` / `0.0.0.0` / `192.168.1.5` …）
 * @param extraHosts 用户显式加的白名单（`ALKAID_TRUSTED_HOSTS`，逗号分隔）
 */
export function trustPolicyFor(bindHost: string, extraHosts: readonly string[] = []): TrustPolicy {
  const bind = bindHost.trim().toLowerCase() || '127.0.0.1';
  const extra = extraHosts.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);

  /**
   * ★ 绑 `0.0.0.0` / `::` 时**不**把通配地址本身放进允许集合：
   *   通配不是别人会写进 `Host` 的值（`Host` 里出现的是具体地址），
   *   允许它只会让策略看起来宽松、实际没用。
   */
  const wildcard = bind === '0.0.0.0' || bind === '::' || bind === '[::]';
  const loopback = isLoopbackBind(bind);

  const allowed = new Set<string>(LOOPBACK_NAMES);
  if (!wildcard) allowed.add(bind);
  for (const host of extra) allowed.add(host);

  /**
   * ★ 判据：只有**明确绑在回环**时才放松 `Origin` 校验。
   *   绑通配（0.0.0.0）、绑具体网卡 IP、以及"用户写了个域名"的情况，一律要求 Origin 同源 ——
   *   宁可多要一个头，也不要在"能被人碰到"的时候少一道检查。
   */
  const requireOrigin = !loopback;

  const description = loopback
    ? `仅本机（Host 校验：${[...allowed].join(', ')}）`
    : `对外监听 ${bind}（Host 与 Origin 双重校验；白名单：${
        allowed.size > 0 ? [...allowed].join(', ') : '（无）'
      }）`;

  return { allowedHosts: allowed, requireOrigin, requireOriginForWrites: requireOrigin, description };
}

export type TrustVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * 判一条请求是否可信。
 *
 * @param headers Host/Origin plus bearer header/cookie（头名归一化由调用方保证）
 */
export function checkRequestTrust(
  policy: TrustPolicy,
  headers: { readonly host?: string | undefined; readonly origin?: string | undefined } & LocalAuthHeaders,
  /** 实际监听的端口，用来把 `Origin` 归一成"同源"（`null` = 不校验端口） */
  listenPort: number | null = null,
  /** HTTP 方法。只有它才能区分"读"与"写"——见 `requireOriginForWrites` */
  method: string = 'GET',
  auth: RequestLocalAuth = { localToken: null },
): TrustVerdict {
  const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  const checkLocalAuth = (): TrustVerdict => {
    if (!safeMethod && !auth.pairingBootstrap && !requestAuthenticated(headers, auth.localToken)) {
      return { ok: false, reason: '本机授权凭据缺失或无效；请先完成一次性配对。' };
    }
    return { ok: true };
  };
  // ① Host 必须命中允许集合 —— 这一条防 DNS rebinding，**任何绑定模式下都要查**
  const rawHost = headers.host?.trim() ?? '';
  if (rawHost.length === 0) {
    return { ok: false, reason: '缺少 Host 头' };
  }
  const host = stripPort(rawHost);
  if (!policy.allowedHosts.has(host)) {
    return {
      ok: false,
      reason: `Host "${host}" 不在允许列表内（当前策略：${policy.description}）。如果这是你自己的域名/网段，把它加进 ALKAID_TRUSTED_HOSTS。`,
    };
  }

  // ② 对外监听时，Origin 也必须同源
  const rawOrigin = headers.origin?.trim();
  if (rawOrigin === undefined || rawOrigin.length === 0) {
    /**
     * ★ 没有 Origin 时**不再一律放行**（2026-11-11 审计 `ALK-CRIT-01`）：
     *   读请求放行（CLI/curl/桌面壳/同源导航本来就不带它，且没有副作用）；
     *   写请求在**对外监听**时一律拒绝 —— 否则绑 0.0.0.0 就等于把整个 API 交给局域网。
     *   回环仅跳过这一层 Origin 要求（`requireOriginForWrites` 为 false）；随后仍检查本机令牌。
     */
    const methodVerb = method.toUpperCase();
    if (!safeMethod && policy.requireOriginForWrites) {
      return {
        ok: false,
        reason:
          `对外监听时，写操作（${methodVerb}）必须带 Origin 请求头并同源。` +
          '浏览器会自动带上；命令行请改用本机回环地址（127.0.0.1），或把来源主机加进 ALKAID_TRUSTED_HOSTS。',
      };
    }
    return checkLocalAuth();
  }

  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    return { ok: false, reason: `Origin "${rawOrigin}" 不是合法 URL` };
  }

  const originHost = parsed.hostname.toLowerCase();
  if (!policy.allowedHosts.has(originHost) && !policy.allowedHosts.has(stripPort(parsed.host))) {
    return { ok: false, reason: `Origin 的主机 "${originHost}" 不受信任` };
  }

  /**
   * ★ 端口判据：只有在**明确知道我们监听哪个端口**时才比。
   *   测试用 `app.inject()` 不监听端口，夹具用随机端口 —— 强行要比会把两者全打挂，
   *   而"端口不同"本身并不构成跨站（跨站攻击靠的是域名，不是端口）。
   */
  if (listenPort !== null && listenPort > 0) {
    const originPort = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
    if (originPort !== listenPort) {
      return { ok: false, reason: `Origin 的端口 ${String(originPort)} 与监听端口 ${String(listenPort)} 不一致` };
    }
  }

  if (!policy.requireOrigin) {
    // 回环来源也必须使用 HTTP(S)；端口已在上面按实际监听端口校验。
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: `Origin 的协议 "${parsed.protocol}" 不受支持` };
    }
  }

  return checkLocalAuth();
}
