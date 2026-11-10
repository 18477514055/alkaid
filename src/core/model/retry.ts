import { SseParseError } from './openai-parse.ts';
import { redact } from './provider.ts';

/**
 * 错误分类。设计稿 §6.2 的结论：**重试与否由错误种类决定，不由"失败了"决定**。
 *
 * 判据（照 ChatMobile 的实测表）：
 * - 网络/超时、HTTP 408/409/425/429/5xx → 可重试
 * - HTTP 400/401/403/404/422 → **不可**重试（密钥或参数错了，重试一万次也一样）
 * - 帧本身坏了 → 不可重试（重试还会坏）
 * - 用户主动中止 → 不可重试
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`HTTP ${status}${detail.length > 0 ? `: ${detail}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * 上游失败的**可诊断分类**。
 *
 * ★ 为什么要多这两个字段（2026-11-08 真事）：为了不把上游响应体写进库与界面，
 *   主循环把错误统一改成了 `provider_request_failed` 一句固定文案 ——
 *   安全是对的，但**可诊断性归零**：用户看到"模型请求失败"，谁也不知道是 401、429 还是断网。
 *   ⇒ 保留**结构化最小信息**（HTTP 状态 + 错误类别），正文永远不落。
 */
export type ErrorClass = {
  readonly message: string;
  readonly retryable: boolean;
  /** HTTP 状态码；非 HTTP 错误时没有 */
  readonly status?: number;
  /** 粗分类：http / timeout / network / stream / abort / parse / other */
  readonly kind: 'http' | 'timeout' | 'network' | 'stream' | 'abort' | 'parse' | 'other';
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429]);

export function classifyError(error: unknown, secret = ''): ErrorClass {
  const clean = (text: string): string => redact(text, secret);

  if (error instanceof HttpError) {
    const retryable = RETRYABLE_STATUS.has(error.status) || error.status >= 500;
    return { message: clean(error.message), retryable, status: error.status, kind: 'http' };
  }
  if (error instanceof TimeoutError) {
    return { message: clean(error.message), retryable: true, kind: 'timeout' };
  }
  if (error instanceof SseParseError) {
    return { message: clean(error.message), retryable: false, kind: 'parse' };
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { message: clean(`请求被中止: ${error.message}`), retryable: false, kind: 'abort' };
    }
    // undici 的网络错误多为 TypeError（fetch failed / ECONNREFUSED / socket hang up）
    const retryable = error.name === 'TypeError' || /fetch failed|ECONN|ETIMEDOUT|socket/i.test(error.message);
    return { message: clean(error.message), retryable, kind: retryable ? 'network' : 'other' };
  }
  return { message: clean(String(error)), retryable: false, kind: 'other' };
}

/**
 * 指数退避 + 抖动。抖动是必要的：多个重试同时回来会一起再撞一次。
 * 返回毫秒；`attempt` 从 1 开始。
 */
export function backoffDelay(attempt: number, baseMs: number, random: () => number = Math.random): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  const jittered = exponential * (0.5 + random() * 0.5);
  return Math.round(jittered);
}
