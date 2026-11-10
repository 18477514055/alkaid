/**
 * **浏览器信任围栏**（B1 / `D7@L358`）。
 *
 * ## ★ 为什么这是硬前提，不是"以后上云再说"
 *
 * Alkaid 有一个**代理能力**：它替你带着真实 API Key 去调上游模型（`core/model/openai.ts`
 * 出站 `Authorization: Bearer <provider key>`）。而这个 HTTP 面的监听地址来自
 * `config.host`（`ALKAID_HOST` 一行环境变量），`app/src/main.ts` 直接拿它去 `listen`。
 *
 * 报告 `D7@L341` 的判语是「**无入站鉴权**：全仓无 `requireAuth`/`preHandler`」——
 * 也就是说：**只要有人把 `ALKAID_HOST` 写成 `0.0.0.0`，整个局域网就能用你的 Key
 * 免费调模型、读你的全部会话与记忆，还能改你的文件**（shell/fs 工具在 full 档下是真实权限）。
 *
 * 这不是理论风险：`0.0.0.0` 是很多人"想用手机访问一下"时的第一反应。
 *
 * ## ★★ 两道判据（缺一条都能被绕过）
 *
 * 1. **`Host` 头必须落在允许集合里** —— 防 **DNS rebinding**：
 *    攻击者把自己的域名解析到 `127.0.0.1`，再从浏览器里访问 `http://evil.example:8787`，
 *    此时 `Origin` 是同源（`evil.example`），浏览器会照发请求。只有校验 `Host`
 *    才能识破（`Host` 会是 `evil.example:8787`，而不是我们绑定的地址）。
 * 2. **`Origin` 必须同源** —— 防**跨站请求伪造**：别的网站用 `fetch` 打我们的 API 时，
 *    浏览器会带上 `Origin: https://evil.example`。
 *    ★ 没有 `Origin` 的要**放行**：CLI / curl / 桌面端壳 / 同源导航都可能不带它，
 *    一刀切拒绝会让 `npm run gate` 的夹具、`app.inject()` 测试和 Electron 全挂。
 *    （判断依据：带 Origin 的只有**浏览器发起的跨源请求**与部分表单提交；
 *      不带 Origin 的请求没法被"任意网站"利用 —— 那正是 CSRF 的必要条件。）
 *
 * ## ★ 为什么默认全放行、只在非 loopback 绑定时才硬起来
 *
 * 判据是**"是不是被别人碰得到"**：
 * - 绑 `127.0.0.1` / `::1` ⇒ 只有本机能连，浏览器跨源请求的危害面限于"本机上别的网页"
 *   —— 但那时 `Host` 判据仍然有意义（DNS rebinding 就是在 loopback 上做文章）。
 * - 绑 `0.0.0.0` / 具体网卡 IP ⇒ **整个网段都能连** ⇒ 必须同时校验 `Host` 与 `Origin`，
 *   且 `Host` 只认"绑定的地址 + 显式白名单"。
 *
 * ⇒ 校验强度由 `config.host` 推导，不需要用户再学一个开关。**默认（loopback）不误伤，
 *   一旦放开监听就自动收紧** —— 这是"安全的默认值应该跟着危险程度走"。
 */

import { isIP } from 'node:net';

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

  return { allowedHosts: allowed, requireOrigin, description };
}

export type TrustVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * 判一条请求是否可信。
 *
 * @param headers 只取用得到的两个头（大小写不敏感由调用方保证）
 */
export function checkRequestTrust(
  policy: TrustPolicy,
  headers: { readonly host?: string | undefined; readonly origin?: string | undefined },
  /** 实际监听的端口，用来把 `Origin` 归一成"同源"（`null` = 不校验端口） */
  listenPort: number | null = null,
): TrustVerdict {
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
    // ★ 无 Origin 放行：CLI/curl/桌面壳/同源导航都不带它（见文件头判据 2）
    return { ok: true };
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
    // 本机绑定时只额外核对协议，不强制端口（开发时 vite 反代会换端口）
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: `Origin 的协议 "${parsed.protocol}" 不受支持` };
    }
  }

  return { ok: true };
}
