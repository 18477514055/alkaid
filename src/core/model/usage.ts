import type { Usage } from '../../shared/types.ts';

/**
 * 用量的**输入总量**（= 三桶之和）。
 *
 * ## ★ 为什么需要这个小函数，而不是各处自己写 `input + cached`
 *
 * 2026-11-09 改成三桶口径时（`openai-parse.ts`：`input = prompt_tokens − cached − cachedWrite`），
 * 有两处消费方原本写着 `event.usage.input`，它们要的是**这次请求的输入总量**
 * （上游 `prompt_tokens` 口径），不是为了看"未命中多少"。语义一改，这两处的数字就会
 * **静默变小**：
 *
 * - `core/context/compact.ts` → `compactions.input_tokens`（压缩审计：这一次压缩花了多少输入）
 * - `core/agent/loop.ts` → `step_end` 审计事件的 `payload.input`
 *
 * 两处都是**落库的数字**，静默变小等于把审计账做错，而且不会报错。所以统一收在这里，
 * 让"总量"只有一个算法。
 *
 * ★ `reasoning` 不参与：它是 `output` 的子集，加进来就是重复计费。
 * ★ `cachedWrite` 可能没有（厂商不报），`?? 0` 只在求和时兜底，不改变"没报"这个事实。
 */
export function usageInputTotal(usage: Usage): number {
  return usage.input + (usage.cached ?? 0) + (usage.cachedWrite ?? 0);
}
