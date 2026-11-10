/**
 * 上下文窗口档位 —— **唯一真源**。
 *
 * ★ 2026-11-10 之前这里有**三份副本**（`ModelPicker.tsx:42`、`SettingsDialog.tsx:87`、
 *   `SetupDialog.tsx:24`），三处各自演化。用户要加 500k 档位时，三份都得改 ——
 *   这就是"同一个数字写三遍"的账单。现在只有这一份。
 *
 * ★ 500k 这一档是按用户要求加的：1M 太大（一次首包就把账单顶上去），
 *   128k/200k 对长上下文模型又偏小，中间需要一个务实档位。
 */
export const WINDOW_PRESETS: readonly number[] = [32_000, 64_000, 128_000, 200_000, 500_000, 1_000_000];

/** 档位按钮上的字：整 M 显示 M，其余按 k */
export function windowPresetLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${String(tokens / 1_000_000)}M`;
  return `${String(Math.round(tokens / 1000))}k`;
}
