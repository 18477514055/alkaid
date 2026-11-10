import type { DatabaseSync } from 'node:sqlite';
import { NO_PROJECT_SCOPE, readExecutionBoard, updateExecutionBoard } from '../memory/execution.ts';
import type { ExecutionBoard, UpdateExecutionBoard } from '../../shared/execution.ts';
import type { ToolDefinition } from './types.ts';

/** Project execution permission is independent of FILE permission. Subagents are excluded. */
export function createExecutionBoardTool(db: DatabaseSync): ToolDefinition {
  const reads = new Map<string, number>();
  function delivered(board: ExecutionBoard) {
    // Goal/tasks are complete. Tool delivery carries latest 10 events; HTTP carries latest 30.
    const content = JSON.stringify({ ...board, events: board.events.slice(0, 10) });
    if (content.length > 64000) throw Object.assign(new Error('Execution board delivery limit exceeded'), { statusCode: 400 });
    return { ok: true as const, content };
  }
  return {
    name: 'execution_board', displayName: '当前执行目标与任务', source: 'builtin', group: 'context',
    kind: 'write_local', preferredMode: 'resident', displayChannel: 'maintenance',
    modes: ['readonly','workspace','project','workspace_project','full'],
    oneLiner: '读取或更新当前主对话的执行目标、任务和动态；不写正式项目记忆',
    description: '当前执行目标不是长期目标树。仅操作当前主对话绑定项目的执行板，不写正式台账、不代替进展或triage履责、不影响文件权限。主对话在readonly文件档也可操作，子智能体不能操作。模型每次更新前必须先action=read拿当前revision，再action=update带baseRevision；用户或另一请求改过时409后必须重读。仅在用户目标或真实执行进展明确时更新，不要自行臆造目标。goal为完整{title,status:active|paused|completed,summary}或null；tasks为完整列表，每条{id,content,status:pending|in_progress|completed}。activity追加动态；历史不可改。工具只返回最近10条动态，完整历史保留在本地数据库。不在聊天正文播报本调用。',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['read','update'] }, baseRevision: { type: 'integer', minimum: 0 },
      goal: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['title','status','summary'], properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 }, status: { type: 'string', enum: ['active','paused','completed'] }, summary: { type: 'string', maxLength: 2000 },
      } }] },
      tasks: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['id','content','status'], properties: {
        id: { type: 'string', minLength: 1, maxLength: 100 }, content: { type: 'string', minLength: 1, maxLength: 500 }, status: { type: 'string', enum: ['pending','in_progress','completed'] },
      } } }, activity: { type: 'string', minLength: 1, maxLength: 500 },
    } },
    async execute(raw, ctx) {
      try {
        /**
         * ★★ 权限判据（用户 2026-11-10 明确定下）：
         *   「子代理可以只读所有东西 —— 不能改除了自己的看板之外的任何东西」
         *
         * 所以这道门是**按所有权**判，不是按角色判：
         * - 看板永远只能写**自己那一行**（`conversation_id = ctx.conversationId`，见下面 select 的条件）；
         * - 子代理因此天然只能写自己的板 —— 它没有别的会话 id；
         * - `read` 对任何会话都放行（子代理要能读主对话的板，否则它不知道自己在整盘里算什么）。
         *
         * ★ 这条替换掉了原来那句"子代理一律 403"。原来那条是早期"执行看板 = 主对话身份"
         *   的产物；一旦允许子代理有自己的一行，一刀切禁用反而会挡住"它自己登记进度"，
         *   而那正是用户要看板里显示的东西。
         */
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['action','baseRevision','goal','tasks','activity'].includes(k))) throw Object.assign(new Error('Invalid execution arguments'), { statusCode: 400 });
        const args = raw as Record<string, unknown>;
        const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(ctx.conversationId);
        if (!conv) throw Object.assign(new Error('Current conversation not found'), { statusCode: 404 });
        /**
         * ★ 归属判据：**任何**会话（主对话或子代理）都只能操作**自己那一行**。
         *   有项目走项目作用域，没项目走空串哨兵 —— 与 `core/memory/execution.ts` 的
         *   `binding()` 完全同一套规则，不在这里另发明一份。
         */
        const rawProject = conv['project_id'];
        const projectId = typeof rawProject === 'string' && rawProject.length > 0 ? rawProject : NO_PROJECT_SCOPE;
        const userSeq = ctx.turnUserSeq ?? Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE conversation_id=? AND role='user'").get(ctx.conversationId)?.['seq']);
        const key = JSON.stringify([projectId, ctx.conversationId, userSeq]);
        if (args['action'] === 'read') {
          if (Object.keys(args).some(k => k !== 'action')) throw Object.assign(new Error('Read does not accept update fields'), { statusCode: 400 });
          const board = readExecutionBoard(db, projectId, ctx.conversationId), result = delivered(board);
          reads.delete(key); reads.set(key, board.revision);
          if (reads.size > 500) reads.delete(reads.keys().next().value!);
          return result;
        }
        if (args['action'] !== 'update') throw Object.assign(new Error('Invalid execution action'), { statusCode: 400 });
        if (reads.get(key) !== args['baseRevision'] || !reads.has(key)) throw Object.assign(new Error('Read the current execution board before each model update'), { statusCode: 409 });
        reads.delete(key);
        const { action: _action, ...input } = args;
        return delivered(updateExecutionBoard(db, projectId, ctx.conversationId, input as UpdateExecutionBoard, 'model'));
      } catch (error) {
        const controlled = error instanceof Error && typeof (error as Error & { statusCode?: unknown }).statusCode === 'number';
        return { ok: false, code: 'execution_board_rejected', message: controlled ? (error as Error).message : 'Execution board operation failed; read current state and check project/main-conversation scope.' };
      }
    },
  };
}
