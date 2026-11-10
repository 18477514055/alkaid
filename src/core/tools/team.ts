import type { DatabaseSync } from 'node:sqlite';

import {
  assertEventBudget,
  claimTask,
  completeTask,
  createTasks,
  readBoard,
  resolveRootConversation,
  updateTask,
} from '../team/board.ts';
import {
  TEAM_DELIVERED_EVENTS,
  TEAM_MAX_ACTIVITY,
  TEAM_MAX_CREATE_BATCH,
  TEAM_MAX_TASK_ID,
  TEAM_TASK_STATUSES,
  type NewTeamTask,
  type TeamBoard,
  type TeamTaskPatch,
} from '../../shared/team.ts';
import type { ToolContext, ToolDefinition, ToolOutcome } from './types.ts';

/**
 * `team_tasks` —— **模型侧进入 Agent Team 共享任务板的唯一入口**。
 *
 * ## ★ 为什么只有一个工具，不拆成六个
 *
 * 工具表里的**每个条目都占缓存前缀**（每一轮都要重发整段 schema）。
 * 拆成 list/create/claim/complete/update 五个 = 同一段说明发五遍，
 * 而它们共享同一套字段和同一套语义。⇒ 用 `action` 分派，
 * 与 `execution_board` 完全一致的做法（那个文件是范本）。
 *
 * ## ★★★ 子代理**能用**这个工具（这正是 Team 的意义）
 *
 * 和 `execution_board` 相反：那块板是主对话的私有执行状态，子代理碰它就是污染；
 * 这块板存在的理由就是**多个人在同一块板上认领互不重叠的活**。
 * 所以它**不包 `registerMemory`**（那个包装会把子代理一律挡掉）。
 *
 * ## ★★ 但子代理**不能动别人的卡**
 *
 * 判据（与 DSH `tool-agent-team` 的模型侧规则一致）：
 * - `claim`：只能认领**没人认领的**或**自己已认领的**；root 可以分派任何卡。
 * - `complete` / `update`：只能动**自己的**卡；root 可以动任何卡。
 *   DSH 原话："The root can reassign tasks to itself or any continuable descendant;
 *   other agents claim ready tasks themselves."
 *
 * 这一条不是礼节，是**记账可信度**的来源：如果谁都能把别人的卡标完成，
 * 那么"做完了"这句话就不再是干活那个人说的。
 *
 * ## ★ return 必须**小**
 *
 * `list` 最多回 50 张卡 + 最近 10 条事件。完整历史留在库里
 * （板可能被反复读，每次塞几百条事件进去等于每一轮都白付一次钱）。
 */
export function createTeamTasksTool(db: DatabaseSync): ToolDefinition {
  /**
   * ★ 板级回执同样要**瘦身**：`readBoard` 内部读 30 条事件（给界面/调试用），
   *   但工具交付只带 10 条。分成两档而不是把核心层限死 ——
   *   核心层不该知道"模型这一次能看多少"。
   */
  function delivered(board: TeamBoard, extra: Record<string, unknown> = {}): ToolOutcome {
    const content = JSON.stringify({
      rootConversationId: board.rootConversationId,
      revision: board.revision,
      totalTasks: board.totalTasks,
      truncated: board.truncated,
      tasks: board.tasks,
      events: board.events.slice(0, TEAM_DELIVERED_EVENTS),
      updatedAt: board.updatedAt,
      ...extra,
    });
    if (content.length > 64_000) {
      // ★ 兜底：不是"不可能"，256 张卡 × 长描述真的能超过。
      //   直接抛会让模型拿到一个不可读的失败；所以按"只回卡、不回事件"降级。
      return {
        ok: true,
        content: JSON.stringify({
          rootConversationId: board.rootConversationId,
          revision: board.revision,
          totalTasks: board.totalTasks,
          truncated: true,
          tasks: board.tasks,
          events: [],
          notice: '看板内容过大，本次只交付任务卡、省略事件；需要细节时按 taskId 用 update/complete 前先 list。',
          ...extra,
        }),
      };
    }
    return { ok: true, content };
  }

  return {
    name: 'team_tasks',
    displayName: '团队共享任务板',
    source: 'builtin',
    group: 'context',
    kind: 'write_local',
    // ★ lazy：这不是每轮都用的工具。常驻会为"偶尔编排队列"付掉每一轮的前缀成本。
    preferredMode: 'lazy',
    displayChannel: 'maintenance',
    modes: ['readonly', 'workspace', 'project', 'workspace_project', 'full'],
    oneLiner: '在多代理共享的任务板上建卡、认领、完成互不重叠的活；write_scopes 只是建议不是锁。',
    description:
      '主对话与它派出的子智能体共用一块任务板：主对话(root)拥有这块板，子智能体加入同一块板并认领各自的卡。'
      + '用途是把一摊能并行的活拆成互不重叠的卡，让"谁认领了什么、谁做完了"有据可查。'
      + 'action=list 读板；create 建卡（tasks数组，可带writeScopes/blockedBy）；claim 认领一张；complete 标完成；update 改卡。'
      + 'claim/complete/update 必须带 baseRevision（就是卡的 revision，从 list 里读），不符即冲突、必须重读后重试。'
      + 'blocked_by 是**真依赖**：依赖没完成就认领不了，工具会告诉你还差哪几张。'
      + '**write_scopes 只是建议，不是锁**：与别人的卡作用域重叠只回一条 warning，仍然允许认领；'
      + '写作用域重叠是提示你去协调查分，不是阻止你干活。'
      + '权限：子智能体只能认领没人认领的卡，只能 complete/update 自己的卡；root(主对话)可以改任何卡。'
      + '工具只返回最多50张卡与最近10条事件，完整历史留在本地数据库。不在聊天正文播报本调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'claim', 'complete', 'update'] },
        baseRevision: { type: 'integer', minimum: 1 },
        taskId: { type: 'string', minLength: 1, maxLength: TEAM_MAX_TASK_ID },
        status: { type: 'string', enum: [...TEAM_TASK_STATUSES] },
        activity: { type: 'string', minLength: 1, maxLength: TEAM_MAX_ACTIVITY },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: TEAM_MAX_CREATE_BATCH,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['subject'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: TEAM_MAX_TASK_ID },
              subject: { type: 'string', minLength: 1, maxLength: 200 },
              description: { type: 'string', maxLength: 2000 },
              blockedBy: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: TEAM_MAX_TASK_ID } },
              writeScopes: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 } },
            },
          },
        },
      },
    },
    async execute(raw, ctx: ToolContext): Promise<ToolOutcome> {
      const allowed = ['action', 'baseRevision', 'taskId', 'status', 'activity', 'tasks'];
      try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !allowed.includes(key))) {
          throw Object.assign(new Error('Invalid team_tasks arguments'), { statusCode: 400 });
        }
        const args = raw as Record<string, unknown>;
        const action = args['action'];
        if (typeof action !== 'string' || !['list', 'create', 'claim', 'complete', 'update'].includes(action)) {
          throw Object.assign(new Error('Invalid team_tasks action'), { statusCode: 400 });
        }

        /**
         * ★ 板主 = 沿 `parent_conversation_id` 往上找到的根。
         *   **绝不让模型自己传 rootId** —— 那等于让它挑一块任意别人的板。
         */
        const root = resolveRootConversation(db, ctx.conversationId);
        /**
         * ★ `actor` 只有 `model` / `user` 两种（DB 里有 CHECK）。工具是模型在调，
         *   所以恒为 `model` —— 包括子代理。真人通过界面改的时候由别的入口写 `user`。
         */
        const actor = 'model' as const;
        const note = typeof args['activity'] === 'string' ? args['activity'] : undefined;

        if (action === 'list') {
          if (Object.keys(args).some((key) => key !== 'action')) {
            throw Object.assign(new Error('list accepts no extra fields'), { statusCode: 400 });
          }
          return delivered(readBoard(db, root));
        }

        // 三个写入动作都要求 baseRevision 与 taskId —— 在这里一次性挡住，别让它们各写一遍。
        const writeActions = ['claim', 'complete', 'update'];
        if (writeActions.includes(action)) {
          if (!Number.isSafeInteger(args['baseRevision']) || Number(args['baseRevision']) < 1) {
            throw Object.assign(new Error('baseRevision is required: read the board with action=list and use the task revision'), { statusCode: 400 });
          }
          if (typeof args['taskId'] !== 'string' || args['taskId'].length === 0) {
            throw Object.assign(new Error('taskId is required'), { statusCode: 400 });
          }
        }

        assertEventBudget(db, root);
        const baseRevision = Number(args['baseRevision']);

        if (action === 'create') {
          if (args['tasks'] === undefined) throw Object.assign(new Error('create requires tasks'), { statusCode: 400 });
          if (args['taskId'] !== undefined || args['status'] !== undefined || args['baseRevision'] !== undefined) {
            throw Object.assign(new Error('create does not accept taskId/status/baseRevision'), { statusCode: 400 });
          }
          const result = createTasks(db, root, args['tasks'] as NewTeamTask[], actor, note);
          return delivered(result.board, { created: result.created.map((task) => ({ id: task.id, subject: task.subject, revision: task.revision })) });
        }

        if (action === 'claim') {
          if (args['status'] !== undefined || args['tasks'] !== undefined) {
            throw Object.assign(new Error('claim does not accept status/tasks'), { statusCode: 400 });
          }
          const result = claimTask(db, root, ctx.conversationId, args['taskId'] as string, baseRevision, actor, note);
          return delivered(result.board, {
            claimed: { id: result.task.id, subject: result.task.subject, owner: result.task.owner, revision: result.task.revision },
            ...(result.warning === null ? {} : { warning: result.warning }),
          });
        }

        if (action === 'complete') {
          if (args['status'] !== undefined || args['tasks'] !== undefined) {
            throw Object.assign(new Error('complete does not accept status/tasks'), { statusCode: 400 });
          }
          const result = completeTask(db, root, ctx.conversationId, args['taskId'] as string, baseRevision, actor, note);
          return delivered(result.board, { completed: { id: result.task.id, subject: result.task.subject, revision: result.task.revision } });
        }

        // update：只开放 status（+ 可选 activity 作为事件备注）。其余字段
        // （subject/description/blockedBy/writeScopes）留给核心层与将来的界面 ——
        // 模型改卡标题/依赖的失败率远高于收益，而 `status` 才是它真需要动的那个。
        const status = args['status'];
        if (status === undefined) throw Object.assign(new Error('update requires status'), { statusCode: 400 });
        const patch: TeamTaskPatch = { status: status as TeamTaskPatch['status'] };
        const result = updateTask(db, root, ctx.conversationId, args['taskId'] as string, baseRevision, patch, actor, note);
        return delivered(result.board, {
          updated: { id: result.task.id, subject: result.task.subject, status: result.task.status, revision: result.task.revision },
          ...(result.warning === null ? {} : { warning: result.warning }),
        });
      } catch (error) {
        const controlled = error instanceof Error && typeof (error as Error & { statusCode?: unknown }).statusCode === 'number';
        return {
          ok: false,
          code: 'team_tasks_rejected',
          message: controlled
            ? (error as Error).message
            : 'Team board operation failed; read the board with action=list and check the task revision.',
        };
      }
    },
  };
}
