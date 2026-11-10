/** Current execution state of ONE main conversation; unrelated to long-lived memory goal cards. */
export const EXECUTION_GOAL_STATUSES = ['active', 'paused', 'completed'] as const;
export const EXECUTION_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export const EXECUTION_EVENT_KINDS = ['goal', 'tasks', 'activity', 'update'] as const;
export type ExecutionGoal = { title: string; status: typeof EXECUTION_GOAL_STATUSES[number]; summary: string };
export type ExecutionTask = { id: string; content: string; status: typeof EXECUTION_TASK_STATUSES[number] };
export type ExecutionEvent = { id: string; kind: typeof EXECUTION_EVENT_KINDS[number]; text: string; createdAt: string };
export type ExecutionBoard = {
  projectId: string; conversationId: string; revision: number; goal: ExecutionGoal | null;
  tasks: ExecutionTask[]; events: ExecutionEvent[]; updatedAt: string | null;
};
export type UpdateExecutionBoard = {
  baseRevision: number; goal?: ExecutionGoal | null; tasks?: ExecutionTask[]; activity?: string;
};
