import type { ThinkingShape } from '../model/provider.ts';
import type { ChatRequest } from '../../shared/types.ts';

/**
 * 思考强度 → 请求体字段。
 *
 * ★ 为什么要单独一个模块：同一件事（"让模型多想/少想"）在不同厂商是**不同字段名**，
 *   而我们的 provider 表里已经有 `thinking_shape` 这一列在描述"这个网关认哪种形状"。
 *   把映射集中在纯函数里，既好测，也不会把 if-else 撒进主循环。
 *
 * ★ 形状（来自 `provider.ts`）：
 * - `effort_only`              → 只发 `reasoning_effort`
 * - `effort_plus_thinking_switch` → `reasoning_effort` + `thinking.type`
 * - `enable_thinking`          → `enable_thinking: boolean`
 * - `reasoning_object`         → `reasoning: { effort }`
 * - `none`                     → 什么都不发
 *
 * ★ `off` 的语义：**关思考**，不是"低强度"。能关的都尽量关；关不掉时（`effort_only` 没有开关字段）
 *   就发最低档，并**明确不假装已关闭** —— 上层不需要知道细节，但注释要留清楚。
 */

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high';

export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['off', 'low', 'medium', 'high'];

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && (THINKING_EFFORTS as readonly string[]).includes(value);
}

/** `off` 时退而求其次用的最低档（`effort_only` 形状没有"关"的字段） */
const LOWEST_EFFORT = 'low';

/**
 * 生成要并进请求体的字段。
 *
 * @returns 空对象表示"这个 provider 形状不吃思考参数"或 `effort` 为 undefined
 */
export function thinkingBody(
  shape: ThinkingShape | string | null | undefined,
  effort: ThinkingEffort | null | undefined,
): Record<string, unknown> {
  if (effort === null || effort === undefined) return {};
  if (shape === null || shape === undefined || shape === 'none') return {};

  const off = effort === 'off';
  const level = off ? LOWEST_EFFORT : effort;

  switch (shape) {
    case 'effort_only':
      // 没有开关字段 ⇒ 只能压低强度；不要谎称已关
      return { reasoning_effort: level };

    case 'effort_plus_thinking_switch':
      return {
        reasoning_effort: level,
        thinking: { type: off ? 'disabled' : 'enabled' },
      };

    case 'enable_thinking':
      // 这种网关只有开关、没有档位 ⇒ 关了就是关，开了就只能给默认强度
      return { enable_thinking: !off };

    case 'reasoning_object':
      return { reasoning: { effort: level } };

    default:
      return {};
  }
}

/** 把思考参数并进一个 ChatRequest（不改原对象） */
export function withThinking(
  request: ChatRequest,
  shape: ThinkingShape | string | null | undefined,
  effort: ThinkingEffort | null | undefined,
): ChatRequest {
  const extra = thinkingBody(shape, effort);
  if (Object.keys(extra).length === 0) return request;
  return { ...request, extraBody: { ...(request.extraBody ?? {}), ...extra } };
}
