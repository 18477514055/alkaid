import type { DatabaseSync } from 'node:sqlite';
import { MEMORY_KINDS, type MemoryKind, type SubmitMemoryProposal } from '../../shared/memory.ts';
import { getMemoryView, submitProposal } from '../memory/store.ts';
import { getConversation } from '../store/repo.ts';
import { recordReadReceipt } from '../memory/context.ts';
import type { ToolDefinition } from './types.ts';

function argsObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数必须是对象');
  return raw as Record<string, unknown>;
}

/** Project identity comes exclusively from the executing conversation, never from model arguments. */
export function createMemoryTools(db: DatabaseSync): ToolDefinition[] {
  return [{
    name: 'memory_read', displayName: '读取项目记忆', source: 'builtin', group: 'context',
    kind: 'read_only', preferredMode: 'lazy', displayChannel: 'maintenance',
    oneLiner: '读取本项目已生效的台账、决策、目标和经验；不把暂存当正式结论',
    description: '读取当前对话所属项目的正式记忆。可按recordId精确读或query检索标题和正文。返回记录revision，修改提案须带此基准。includeOwnPending仅额外返回本会话待处理提案，未生效。所有日常记忆往来在右侧看板展示，不在聊天正文叙述。未绑定项目时不可用。',
    parameters: { type: 'object', properties: { recordId: { type: 'string' }, query: { type: 'string' }, includeOwnPending: { type: 'boolean' } }, additionalProperties: false },
    modes: ['readonly', 'workspace', 'project', 'workspace_project', 'full'],
    async execute(raw, ctx) {
      const args = argsObject(raw);
      const conversation = getConversation(db, ctx.conversationId);
      if (!conversation?.projectId) return { ok: false, code: 'no_project', message: '当前对话未绑定项目', hint: '不要猜测其他项目；在看板绑定项目后才可读取项目记忆。' };
      if ((args['recordId'] !== undefined && typeof args['recordId'] !== 'string') || (args['query'] !== undefined && typeof args['query'] !== 'string') || (args['includeOwnPending'] !== undefined && typeof args['includeOwnPending'] !== 'boolean')) return { ok: false, code: 'invalid_arguments', message: 'recordId/query必须是字符串，includeOwnPending必须是布尔值' };
      const view = getMemoryView(db, conversation.projectId);
      const query = String(args['query'] ?? '').toLocaleLowerCase();
      const matches = view.records.filter(r => !r.deleted && (args['recordId'] === undefined || r.id === args['recordId']) && `${r.title}\n${r.content}`.toLocaleLowerCase().includes(query));
      const records = [];
      let chars = 0;
      for (const record of matches) { if (chars + record.content.length > 60000) break; records.push(record); chars += record.content.length; }
      // A receipt records actual complete tool delivery, not UI viewing or a title hit.
      for (const record of records) recordReadReceipt(db, ctx.conversationId, record.id, record.revision);
      return { ok: true, content: JSON.stringify({ projectId: conversation.projectId, revision: view.revision, records, totalMatches: matches.length, truncated: records.length !== matches.length, ...(args['includeOwnPending'] === true ? { ownPending: view.proposals.filter(p => p.conversationId === ctx.conversationId && (p.status === 'pending' || p.status === 'conflict')).slice(0, 30), pendingIsNotOfficial: true } : {}) }) };
    },
  }, {
    name: 'memory_propose', displayName: '暂存项目记忆提案', source: 'builtin', group: 'context',
    kind: 'write_local', preferredMode: 'resident', displayChannel: 'maintenance',
    oneLiner: '把有依据的项目进展暂存给维护员，不直接改正式台账',
    description: '在完成实质工作后主动提交值得保存的进展、决定、目标或经验。只写当前项目暂存区，绝不直接改正式记忆。先memory_read拿recordId与revision；新记录baseRevision=0。相同请求重试必须复用idempotencyKey；更新既有记录须沿用其recordId。reason写证据指针或原因，不复制密钥。principle禁止模型提交或修改。只在确有新进展时调用，不为每个普通动作制造提案。不要在正文播报本调用或“已更新台账”：回执由右侧看板承载，pending不代表已合并。',
    parameters: { type: 'object', properties: {
      recordId: { type: 'string', description: '稳定条目ID，如active-current、decision-api；沿用既有ID' },
      kind: { type: 'string', enum: MEMORY_KINDS.filter(k => k !== 'principle') }, title: { type: 'string' },
      operation: { type: 'string', enum: ['upsert', 'delete'] }, content: { type: 'string', description: 'active/decision可用正文；goal须JSON {parentId,state,keyResults,lessons,body?}；lesson须JSON {type:lesson|experience,category,body,fix,rootCause?或source?}；问题/调研note须JSON {type:problem|research,body,rootCause?或conclusion?}。分流/交接/扩展请用memory_stage。' },
      baseRevision: { type: 'integer', minimum: 0 }, reason: { type: 'string' }, idempotencyKey: { type: 'string' },
    }, required: ['recordId', 'kind', 'title', 'operation', 'content', 'baseRevision', 'reason', 'idempotencyKey'], additionalProperties: false },
    modes: ['readonly', 'workspace', 'project', 'workspace_project', 'full'],
    examples: [{ whenTo: '保存新查证的机制，未有同ID正式记录', args: { recordId: 'lesson-sse-close', kind: 'lesson', title: 'SSE断开处理', operation: 'upsert', content: JSON.stringify({ type: 'experience', category: '机制', body: '监听响应close而非请求close。', fix: '在响应close且!writableEnded时abort', source: 'src/server.ts:40，已跑断连测试' }), baseRevision: 0, reason: 'src/server.ts:40，已跑断连测试', idempotencyKey: 'sse-close-check-1' } }],
    async execute(raw, ctx) {
      const args = argsObject(raw);
      const input: SubmitMemoryProposal = { conversationId: ctx.conversationId,
        recordId: args['recordId'] as string, kind: args['kind'] as MemoryKind, title: args['title'] as string,
        operation: args['operation'] as 'upsert' | 'delete', content: args['content'] as string,
        baseRevision: args['baseRevision'] as number, reason: args['reason'] as string, idempotencyKey: args['idempotencyKey'] as string };
      try {
        const proposal = submitProposal(db, input);
        return { ok: true, content: JSON.stringify({ proposal, staged: true, applied: false, notice: '仅已暂存；正式版本尚未改变。维护状态见右侧看板，无需在正文播报。' }) };
      } catch (error) {
        return { ok: false, code: 'memory_proposal_rejected', message: error instanceof Error ? error.message : String(error), hint: '在右侧看板查看问题；不要把待处理说成已生效，版本冲突请先memory_read再提交新提案。' };
      }
    },
  }];
}
