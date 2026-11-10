import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { getConversation } from '../store/repo.ts';
import { submitProposal } from '../memory/store.ts';
import {
  getGoalTree, getMemoryArchiveSnapshot, getMemoryIndex, getPreservedMemory,
  listMemoryArchive, searchMemoryLessons,
} from '../memory/records.ts';
import {
  getCurrentPrinciples, getExtension, getHandoff, getTriage, getWorkbenchCounts,
  listExtensions, listHandoffs, listPrincipleProposals, makeArtifactInput,
  proposePrinciple, queryExtensionEntries, queryIntents, queryUserQuotes,
} from '../memory/workbench.ts';
import { getMemoryState, openCheckpoint, queryCapsules } from '../memory/context.ts';
import { projectMaterialMap } from '../agent/prompt/memory.ts';
import type { ToolContext, ToolDefinition, ToolOutcome } from './types.ts';

const READ_MODES = ['readonly', 'workspace', 'project', 'workspace_project', 'full'] as const;
const WRITE_MODES = READ_MODES;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('参数必须是对象'), { statusCode: 400 });
  return value as Record<string, unknown>;
}
function str(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > 500 || (required && !value.trim())) throw Object.assign(new Error(`Invalid ${name}`), { statusCode: 400 });
  return value as string;
}
function integer(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error(`Invalid ${name}`), { statusCode: 400 });
  return value;
}
function project(db: DatabaseSync, ctx: ToolContext): string {
  const projectId = getConversation(db, ctx.conversationId)?.projectId;
  if (!projectId) throw Object.assign(new Error('当前对话未绑定项目'), { statusCode: 400 });
  return projectId;
}
function result(value: unknown): ToolOutcome {
  const content = JSON.stringify(value);
  if (content.length > 64000) return { ok: false, code: 'memory_query_too_large', message: '查询结果超过64000字符，请缩小关键词/时间范围或分页读取；未截断正文冒充完整结果。' };
  return { ok: true, content };
}
function rejected(error: unknown): ToolOutcome {
  const controlled = error instanceof Error && typeof (error as Error & { statusCode?: unknown }).statusCode === 'number';
  return { ok: false, code: 'memory_workbench_rejected', message: controlled ? (error as Error).message : '记忆操作未通过校验，请核对参数、项目与正式版本。', hint: '右侧看板可查看状态；不要绕过审核、重复收费重试或声称未批准内容已经生效。' };
}
function tool(name: string, description: string, properties: Record<string, unknown>, run: (args: Record<string, unknown>, ctx: ToolContext) => ToolOutcome, write = false): ToolDefinition {
  return { name, description, displayName: name === 'memory_stage' ? '暂存结构化记忆制品' : name === 'memory_checkpoint' ? '请求记忆检查点' : '查询项目记忆工作台',
    source: 'builtin', kind: write ? 'write_local' : 'read_only', preferredMode: name === 'memory_stage' ? 'resident' : 'lazy', group: 'context', displayChannel: 'maintenance',
    oneLiner: description.split('。')[0]!, modes: write ? WRITE_MODES : READ_MODES,
    parameters: { type: 'object', properties, additionalProperties: false },
    async execute(raw, ctx) { try { return run(object(raw), ctx); } catch (error) { return rejected(error); } },
  };
}

/** Query tools never expose the human approval broker or approval capabilities. */
export function createMemoryWorkbenchTools(db: DatabaseSync): ToolDefinition[] {
  return [
    tool('memory_records', '查询正式记忆的完整归档版本、目标树、经验分类全文、只读排序或并发保留区。历史不会自动注入；所有记忆往来仅右栏显示，不在正文播报。', {
      action: { type: 'string', enum: ['archive', 'archive_snapshot', 'goals', 'lessons', 'index', 'preserved'] },
      recordId: { type: 'string' }, historyId: { type: 'string' }, side: { type: 'string', enum: ['before', 'after'] },
      from: { type: 'string', description: '带时区ISO时间' }, to: { type: 'string', description: '带时区ISO时间' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 },
      category: { type: 'string' }, type: { type: 'string', enum: ['lesson', 'experience'] }, q: { type: 'string' },
    }, (args, ctx) => {
      const p = project(db, ctx); const action = str(args.action, 'action', true);
      if (action === 'archive') return result(listMemoryArchive(db, p, { recordId: str(args.recordId, 'recordId'), from: str(args.from, 'from'), to: str(args.to, 'to'), limit: integer(args.limit, 'limit') ?? 20, offset: integer(args.offset, 'offset') ?? 0 }));
      if (action === 'archive_snapshot') {
        if (args.side !== undefined && args.side !== 'before' && args.side !== 'after') throw Object.assign(new Error('Invalid side'), { statusCode: 400 });
        return result(getMemoryArchiveSnapshot(db, p, str(args.historyId, 'historyId', true)!, args.side === 'before' ? 'before' : 'after'));
      }
      if (action === 'goals') return result(getGoalTree(db, p));
      if (action === 'lessons') return result(searchMemoryLessons(db, p, { type: str(args.type, 'type'), category: str(args.category, 'category'), q: str(args.q, 'q') }));
      if (action === 'index') return result(getMemoryIndex(db, p));
      if (action === 'preserved') return result(getPreservedMemory(db, p));
      throw Object.assign(new Error('Invalid memory_records action'), { statusCode: 400 });
    }),
    tool('memory_workbench', '读取已审核分流三桶、交接单、意图日志、用户原话、扩展内容和原则待批。原则只能读取或另行提议，不能由模型批准；这些查询均不会请求维护模型。', {
      action: { type: 'string', enum: ['overview', 'triage', 'handoff_read', 'handoffs', 'intent_logs', 'user_quotes', 'extensions', 'extension_read', 'extension_entries', 'principles', 'principle_pending', 'context_state', 'capsules'] },
      id: { type: 'string' }, extensionId: { type: 'string' }, conversationId: { type: 'string' }, q: { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      capsuleId: { type: 'string' }, fromSeq: { type: 'integer', minimum: 1 }, toSeq: { type: 'integer', minimum: 1 },
    }, (args, ctx) => {
      const p = project(db, ctx); const action = str(args.action, 'action', true);
      const query = { q: str(args.q, 'q'), from: str(args.from, 'from'), to: str(args.to, 'to'), conversationId: str(args.conversationId, 'conversationId'), limit: integer(args.limit, 'limit') ?? 30 };
      if (query.conversationId && getConversation(db, query.conversationId)?.projectId !== p) throw Object.assign(new Error('Conversation is not in current project'), { statusCode: 404 });
      if (action === 'overview') return result(getWorkbenchCounts(db, p));
      if (action === 'triage') return result(getTriage(db, p, query));
      if (action === 'handoff_read') return result(getHandoff(db, p, str(args.id, 'id', true)!));
      if (action === 'handoffs') return result(listHandoffs(db, p, query.limit));
      if (action === 'intent_logs') return result(queryIntents(db, p, query));
      if (action === 'user_quotes') return result(queryUserQuotes(db, p, query));
      if (action === 'extensions') return result(listExtensions(db, p));
      if (action === 'extension_read') return result(getExtension(db, p, str(args.extensionId, 'extensionId', true)!));
      if (action === 'extension_entries') return result(queryExtensionEntries(db, p, str(args.extensionId, 'extensionId', true)!, query));
      if (action === 'principles') return result(getCurrentPrinciples(db, p));
      if (action === 'principle_pending') return result(listPrincipleProposals(db, p));
      if (action === 'context_state') return result(getMemoryState(db, ctx.conversationId));
      if (action === 'capsules') return result(queryCapsules(db, query.conversationId ?? ctx.conversationId, { capsuleId: str(args.capsuleId, 'capsuleId'), fromSeq: integer(args.fromSeq, 'fromSeq'), toSeq: integer(args.toSeq, 'toSeq') }));
      throw Object.assign(new Error('Invalid memory_workbench action'), { statusCode: 400 });
    }),
    tool('memory_material_map', '读取当前项目完整材料地图和哪些当前版本尚未读过。地图分数只是建议顺序；正文必须用memory_read按ID读取，UI打开不算模型已读。', {
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    }, (args, ctx) => {
      project(db, ctx); const rows = projectMaterialMap(db, ctx.conversationId);
      const offset = integer(args.offset, 'offset') ?? 0; const limit = integer(args.limit, 'limit') ?? 100;
      if (limit < 1 || limit > 200) throw Object.assign(new Error('Invalid map limit'), { statusCode: 400 });
      return result({ total: rows.length, offset, rows: rows.slice(offset, offset + limit) });
    }),
    tool('memory_stage', '提交分流、交接单、意图摘要、扩展写入的结构化提案，或提出待用户批准的原则变更。前四类仍须独立人工/维护AI审核；原则只进入人工待批区，模型绝无批准能力。不要在正文播报。', {
      action: { type: 'string', enum: ['triage', 'handoff', 'intent', 'extension-entry', 'principle_propose'] },
      payload: { type: 'object', description: 'triage:{keep,stash,drop}各项{what,why?,where?}; handoff:{title,did,state,next,files绝对路径[],blocked}; intent:{goal,did,issues,next}; extension-entry:{extensionId,key,action:append|replace|delete,content}; principle_propose:{recordId,title,content,operation,baseRevision}。' },
      idempotencyKey: { type: 'string', description: '制品提案重试复用同一键，内容变化用新键' }, reason: { type: 'string' },
    }, (args, ctx) => {
      const p = project(db, ctx); const action = str(args.action, 'action', true)!;
      const payload = object(args.payload);
      if (action === 'principle_propose') return result({ pendingHumanApproval: true, applied: false, proposal: proposePrinciple(db, p, payload) });
      if (!['triage', 'handoff', 'intent', 'extension-entry'].includes(action)) throw Object.assign(new Error('Invalid stage action'), { statusCode: 400 });
      const key = str(args.idempotencyKey, 'idempotencyKey', true)!;
      const reason = str(args.reason, 'reason', true)!;
      const artifact = makeArtifactInput(action, action === 'intent' ? { ...payload, conversationId: ctx.conversationId } : payload);
      const artifactId = createHash('sha256').update(JSON.stringify([ctx.conversationId, key, artifact.type])).digest('hex');
      const proposal = submitProposal(db, { conversationId: ctx.conversationId, recordId: `artifact:${artifact.type}:${artifactId}`, kind: 'note', title: artifact.title, operation: 'upsert', content: artifact.content, baseRevision: 0, reason, idempotencyKey: key });
      return result({ staged: true, applied: false, proposal });
    }, true),
    tool('memory_checkpoint', '请求右侧四选一检查点（不记录/只记/记并压缩/记并交接）。本工具只打开用户交互，不替用户选择、不批准提案、不发压缩请求。', {}, (_args, ctx) => {
      project(db, ctx); return result({ checkpoint: openCheckpoint(db, ctx.conversationId), requiresHumanChoice: true });
    }),
  ];
}
