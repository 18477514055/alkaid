import type { DatabaseSync } from 'node:sqlite';
import { exemptObligation, readObligation } from '../memory/obligations.ts';
import type { ToolDefinition } from './types.ts';

/** A model assertion, not a fabricated progress record or a human skip. */
export function createMemoryDispositionTool(db: DatabaseSync): ToolDefinition {
  return {
    name: 'memory_disposition', displayName: '声明本轮无新增', source: 'builtin', group: 'context',
    kind: 'write_local', preferredMode: 'resident', displayChannel: 'maintenance',
    modes: ['readonly', 'workspace', 'project', 'workspace_project', 'full'],
    oneLiner: '仅无新增成果时明确说明原因，不能掩盖已发生的修改或已有进展提案',
    description: '当台账整理间隔已到、但本轮确实无新增需要保存（如问候、重复确认）时，可调用本工具给出简短原因，记录明确的无新增声明，不制造垃圾记忆。未到整理间隔的短交流不要求调用。它是模型声明，不是程序对事实的语义证明；已成功执行业务写入或已提交进展时不能用它绕过分流。不得替用户跳过旧义务，不批准记忆，不在聊天正文播报。',
    parameters: { type: 'object', properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } }, required: ['reason'], additionalProperties: false },
    async execute(raw, ctx) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'reason')) return { ok: false, code: 'invalid_arguments', message: '仅接受无新增原因reason。' };
      const reason = (raw as Record<string, unknown>).reason;
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 300) return { ok: false, code: 'invalid_arguments', message: '请给出1–300字符的真实无新增原因。' };
      if (!ctx.turnUserSeq || !readObligation(db, ctx.conversationId, ctx.turnUserSeq)) return { ok: false, code: 'no_active_obligation', message: '没有属于当前执行轮的项目义务，不能修改其他轮次。' };
      try {
        const obligation = exemptObligation(db, ctx.conversationId, ctx.turnUserSeq, reason);
        return { ok: true, content: JSON.stringify({ obligation, notice: '仅记录模型的无新增声明，未写正式记忆、未请求维护模型。' }) };
      } catch {
        return { ok: false, code: 'memory_disposition_rejected', message: '本轮已有业务修改/进展、义务状态已变化，或原因未通过安全校验；请提交真实进展与分流，不要用无新增掩盖。' };
      }
    },
  };
}
