import type { DatabaseSync } from 'node:sqlite';

import { getRecallIndex, getRecallMessage, RECALL_MESSAGE_DEFAULT_CHARS } from '../context/recall.ts';
import { PERMISSION_MODES } from '../policy/mode.ts';
import { getConversation, listMessages } from '../store/repo.ts';
import type { ToolContext, ToolDefinition, ToolOutcome } from './types.ts';

const MAX_RANGE_CHARS = 20_000;
const isInteger = (value: unknown, minimum: number): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
function invalid(message = 'recall 参数不合法'): ToolOutcome {
  return { ok: false, code: 'invalid_args', message, hint: 'range需要正整数from_seq/to_seq；index支持区间与offset/limit；message需要seq。不得传conversationId/projectId，来源只由当前工具上下文决定。' };
}
function runtimeChildFloor(db: DatabaseSync, ctx: ToolContext): number | null {
  const conversation = getConversation(db, ctx.conversationId);
  if (ctx.agentRole !== 'subagent' || conversation?.agentRole === 'subagent') return 1;
  // Runtime children may execute on a main ID. They own only the current delegated
  // turn, never the main conversation's earlier maintenance replies or summaries.
  return isInteger(ctx.turnUserSeq, 1) ? ctx.turnUserSeq : null;
}

/** Backward-compatible text range plus lossless original-MessageRow pagination. */
export function createRecallTool(db: DatabaseSync): ToolDefinition {
  return {
    name: 'recall',
    description: '只读回查当前会话压缩前的原始消息，不修改原文。默认mode=range兼容from_seq/to_seq文本范围；范围只显示正文且超20k明确截断，不代表完整字段。' +
      '完整回读先mode=index列seq/id/role/createdAt/totalChars元数据（无正文gist，默认50条最多100），再mode=message按seq取JSON(MessageRow)分片（默认12000、最多20000字符）。' +
      '分片包含原始content/reasoning/toolCalls/toolCallId/usage/displayChannel/id等全部MessageRow字段，不修补工具协议。charOffset/maxChars/nextOffset按UTF-16 code unit计数，不是字节；按nextOffset拼接text直到done=true后再JSON.parse，单片不是完整JSON，emoji边界也不得自行丢字符。' +
      '不接受conversationId/projectId等来源参数。子智能体只能读自己的会话原文；复用主会话ID的runtime子任务只可读本轮委派输入及结果。',
    parameters: {
      type: 'object', properties: {
        mode: { type: 'string', enum: ['range', 'index', 'message'], default: 'range', description: '兼容文本范围、元数据索引、完整消息JSON分片' },
        from_seq: { type: 'integer', minimum: 1, description: 'range必填，index可选；起始seq含' },
        to_seq: { type: 'integer', minimum: 1, description: 'range必填，index可选；结束seq含' },
        seq: { type: 'integer', minimum: 1, description: 'message模式必填，目标seq' },
        charOffset: { type: 'integer', minimum: 0, description: 'message模式UTF-16 code-unit起点，默认0；下一片使用返回nextOffset' },
        maxChars: { type: 'integer', minimum: 1, maximum: 20_000, description: 'message模式每片最大UTF-16 code units，默认12000' },
        offset: { type: 'integer', minimum: 0, description: 'index模式元数据行偏移，默认0' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'index模式页大小，默认50' },
      }, additionalProperties: false,
    },
    modes: PERMISSION_MODES,
    source: 'builtin', kind: 'read_only', group: 'history', displayName: '回读原文',
    summary: '压缩原文索引、兼容范围与完整消息JSON分页回读',
    oneLiner: 'Index original messages or page their complete JSON without losing long tails.',
    preferredMode: 'lazy',
    async execute(rawArgs, ctx) {
      if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return invalid();
      const args = rawArgs as Record<string, unknown>;
      const mode = args.mode === undefined ? 'range' : args.mode;
      if (mode !== 'range' && mode !== 'index' && mode !== 'message') return invalid('未知recall mode');
      const keys = mode === 'range' ? ['mode', 'from_seq', 'to_seq'] : mode === 'index'
        ? ['mode', 'from_seq', 'to_seq', 'offset', 'limit'] : ['mode', 'seq', 'charOffset', 'maxChars'];
      if (Object.keys(args).some(key => !keys.includes(key))) return invalid('recall不接受其他会话/项目标识或当前模式之外的字段');
      if (!getConversation(db, ctx.conversationId)) return { ok: false, code: 'nothing_found', message: '当前会话不存在' };
      const floor = runtimeChildFloor(db, ctx);
      if (floor === null) return { ok: false, code: 'denied_by_policy', message: '子任务没有有效的本轮原文边界，不能读取主会话历史。' };
      try {
        if (mode === 'message') {
          if (!isInteger(args.seq, 1)) return invalid('message需要正整数seq');
          if (args.seq < floor) return { ok: false, code: 'denied_by_policy', message: '子任务只能读取本轮委派原文，不能读取主会话旧消息。' };
          const page = getRecallMessage(db, ctx.conversationId, { seq: args.seq,
            ...(args.charOffset === undefined ? {} : { charOffset: args.charOffset as number }),
            ...(args.maxChars === undefined ? {} : { maxChars: args.maxChars as number }) });
          return { ok: true, content: JSON.stringify(page) };
        }
        if (mode === 'index') {
          if (args.from_seq !== undefined && !isInteger(args.from_seq, 1)) return invalid();
          if (args.to_seq !== undefined && !isInteger(args.to_seq, 1)) return invalid();
          const from = Math.max((args.from_seq as number | undefined) ?? 1, floor);
          if (args.to_seq !== undefined && args.to_seq < from) return invalid('索引区间位于当前允许的会话原文范围之外');
          return { ok: true, content: JSON.stringify(getRecallIndex(db, ctx.conversationId, {
            fromSeq: from,
            ...(args.to_seq === undefined ? {} : { toSeq: args.to_seq as number }),
            ...(args.offset === undefined ? {} : { offset: args.offset as number }),
            ...(args.limit === undefined ? {} : { limit: args.limit as number }),
          })) };
        }
        if (!isInteger(args.from_seq, 1) || !isInteger(args.to_seq, args.from_seq)) return invalid();
        const from = Math.max(args.from_seq, floor), to = args.to_seq;
        if (to < from) return { ok: false, code: 'denied_by_policy', message: '子任务不能读取主会话旧原文区间。' };
        const rows = listMessages(db, ctx.conversationId, from - 1).filter(message => message.seq <= to);
        if (!rows.length) return { ok: false, code: 'nothing_found', message: `seq ${from}-${to} 之间没有消息`, hint: '确认压缩摘要的区间，或先用mode=index查询本会话原文索引。' };
        const body = rows.map(message => {
          const role = message.role === 'tool' ? `工具结果（call ${message.toolCallId ?? '?'}）`
            : message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '系统';
          return `[seq ${message.seq}] ${role}：\n${message.content ?? '（无正文）'}`;
        }).join('\n\n');
        const truncated = body.length > MAX_RANGE_CHARS;
        const guidance = `完整字段和超长尾部请先recall(mode="index",from_seq=${from},to_seq=${to})，再recall(mode="message",seq=目标序号,charOffset=0,maxChars=${RECALL_MESSAGE_DEFAULT_CHARS})，按nextOffset逐片取至done=true；拼接text后JSON.parse。`;
        return { ok: true, content: truncated ? `${body.slice(0, MAX_RANGE_CHARS)}\n…[截断：范围正文更长，并非完整原文。${guidance}]`
          : `${body}\n\n[兼容范围模式仅显示正文，不含完整reasoning/toolCalls/usage等字段。${guidance}]`,
          ...(truncated ? { truncated: true } : {}) };
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 400) return invalid(error instanceof Error ? error.message : 'recall分页参数不合法');
        if (status === 404) return { ok: false, code: 'nothing_found', message: '当前会话内未找到目标原文' };
        throw error;
      }
    },
  };
}
