/** Closed diagnostic vocabulary. Never use a regex-shaped arbitrary string as a log code. */
export const MEMORY_DIAGNOSTIC_LABELS = {
  MEMORY_JOB_FAILED: '维护失败；提案已保留，未自动重试',
  MEMORY_JOB_DEFERRED: '维护暂缓；项目重新活动或快照已变化',
  MEMORY_JOB_CONFLICT: '发现冲突；需要核对后重新提案',
  MEMORY_JOB_PROVIDER_FAILED: '模型请求失败；未自动重试',
  MEMORY_JOB_INPUT_LIMIT: '输入材料超过预算；未向模型发送请求',
  MEMORY_JOB_OUTPUT_LIMIT: '模型输出超过预算；未应用结果',
  MEMORY_JOB_TIMEOUT: '模型请求超时；未自动重试',
  MEMORY_JOB_LEASE_EXPIRED: '上次维护中断或租约已过期；提案已保留',
  MEMORY_JOB_INVALID_RESULT: '模型结果格式、目标或提案覆盖校验失败',
  MEMORY_JOB_PRINCIPLE_FORBIDDEN: '拒绝维护模型修改原则',
  MEMORY_JOB_SNAPSHOT_CHANGED: '项目版本或待审队列变化；旧结果未应用',
  MEMORY_JOB_CANCELLED: '项目开始新工作；旧维护任务已取消',
  MEMORY_JOB_UNEXPECTED_TOOL: '模型返回了不允许的工具调用',
  MEMORY_JOB_VALIDATION_FAILED: '合并结果未通过正式应用检查',
} as const;
export type MemoryDiagnosticCode = keyof typeof MEMORY_DIAGNOSTIC_LABELS;
const LEGACY_CATEGORIES: Readonly<Record<string, MemoryDiagnosticCode>> = {
  'Provider generation failed': 'MEMORY_JOB_PROVIDER_FAILED',
  'Input character limit exceeded': 'MEMORY_JOB_INPUT_LIMIT',
  'Output character safety limit exceeded': 'MEMORY_JOB_OUTPUT_LIMIT',
  'Incomplete or over-limit generation': 'MEMORY_JOB_INVALID_RESULT',
  'Generation timed out': 'MEMORY_JOB_TIMEOUT',
  'Merge lease expired': 'MEMORY_JOB_LEASE_EXPIRED',
  'Principles are never AI-editable': 'MEMORY_JOB_PRINCIPLE_FORBIDDEN',
  'Cannot change memory kind or principle': 'MEMORY_JOB_PRINCIPLE_FORBIDDEN',
  'Unexpected tool call': 'MEMORY_JOB_UNEXPECTED_TOOL',
  'Duplicate finish': 'MEMORY_JOB_INVALID_RESULT',
  'Content after finish': 'MEMORY_JOB_INVALID_RESULT',
  'Invalid merge JSON': 'MEMORY_JOB_INVALID_RESULT',
  'Invalid decision shape': 'MEMORY_JOB_INVALID_RESULT',
  'Invalid merge target or fields': 'MEMORY_JOB_INVALID_RESULT',
  'Invalid proposal coverage': 'MEMORY_JOB_INVALID_RESULT',
  'Incomplete proposal coverage': 'MEMORY_JOB_INVALID_RESULT',
  'Memory merge validation or application failed': 'MEMORY_JOB_VALIDATION_FAILED',
  'Project became active or job was cancelled': 'MEMORY_JOB_CANCELLED',
  'Snapshot changed; proposals preserved': 'MEMORY_JOB_SNAPSHOT_CHANGED',
};
export function isMemoryDiagnosticCode(value: string): value is MemoryDiagnosticCode {
  return Object.hasOwn(MEMORY_DIAGNOSTIC_LABELS, value);
}
export function normalizeMemoryDiagnostic(value: string | undefined, state: string): MemoryDiagnosticCode | undefined {
  if (value === undefined) return undefined;
  if (isMemoryDiagnosticCode(value)) return value;
  if (Object.hasOwn(LEGACY_CATEGORIES, value)) return LEGACY_CATEGORIES[value];
  return state === 'deferred' ? 'MEMORY_JOB_DEFERRED' : state === 'conflict' ? 'MEMORY_JOB_CONFLICT' : 'MEMORY_JOB_FAILED';
}
export function memoryDiagnosticLabel(value: string | null): string {
  if (!value) return '—';
  if (isMemoryDiagnosticCode(value)) return MEMORY_DIAGNOSTIC_LABELS[value];
  if (Object.hasOwn(LEGACY_CATEGORIES, value)) return MEMORY_DIAGNOSTIC_LABELS[LEGACY_CATEGORIES[value]!];
  return '未知维护诊断；原始错误内容不在界面显示';
}
