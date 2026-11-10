/** Pure sizing policy: intentionally no React/DOM imports, so Node can test it. */
export const ORIGINAL_INSPECTOR_WIDTH = 304;
export const DEFAULT_INSPECTOR_WIDTH = ORIGINAL_INSPECTOR_WIDTH * 2;
export const MIN_INSPECTOR_WIDTH = 280;
export const MAX_INSPECTOR_WIDTH = 1400;
export const INSPECTOR_WIDTH_STORAGE_KEY = 'alkaid.inspector-width.v1';
export const INSPECTOR_DRAWER_BREAKPOINT = 1000;
export const INSPECTOR_SEPARATOR_WIDTH = 8;
export const MIN_CHAT_WIDTH = 480;

export function normalizeInspectorPreference(width: number): number {
  return Number.isFinite(width)
    ? Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, Math.round(width)))
    : DEFAULT_INSPECTOR_WIDTH;
}

/** Only the versioned format is accepted; old bare numbers and malformed values reset. */
export function restoreInspectorWidth(raw: string | null): number {
  if (raw === null) return DEFAULT_INSPECTOR_WIDTH;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_INSPECTOR_WIDTH;
    const record = value as Record<string, unknown>;
    const width = record['width'];
    if (record['version'] !== 1 || typeof width !== 'number' || !Number.isFinite(width) ||
        width < MIN_INSPECTOR_WIDTH || width > MAX_INSPECTOR_WIDTH) return DEFAULT_INSPECTOR_WIDTH;
    return Math.round(width);
  } catch {
    return DEFAULT_INSPECTOR_WIDTH;
  }
}

export function serializeInspectorWidth(width: number): string {
  return JSON.stringify({ version: 1, width: normalizeInspectorPreference(width) });
}

/** Must match the sidebar media queries in styles.css. */
export function inspectorWidthBounds(viewportWidth: number): { min: number; max: number; drawer: boolean } {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, Math.floor(viewportWidth)) : 0;
  const drawer = viewport <= INSPECTOR_DRAWER_BREAKPOINT;
  const sidebar = viewport > 1240 ? 264 : 248;
  // A drawer leaves a 24px outside strip (including its handle), never a horizontal overflow.
  const available = drawer ? viewport - 24 : viewport - sidebar - MIN_CHAT_WIDTH - INSPECTOR_SEPARATOR_WIDTH;
  const max = Math.max(0, Math.min(MAX_INSPECTOR_WIDTH, available));
  return { min: Math.min(MIN_INSPECTOR_WIDTH, max), max, drawer };
}

/** Projection only: resize/open/close never mutate the separately stored preference. */
export function clampInspectorWidth(preference: number, viewportWidth: number, open = true): number {
  if (!open) return 0;
  const { min, max } = inspectorWidthBounds(viewportWidth);
  return Math.min(max, Math.max(min, normalizeInspectorPreference(preference)));
}
