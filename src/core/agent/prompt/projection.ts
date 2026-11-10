import type { ChatMessage } from '../../../shared/types.ts';
import { renderSummaries,sanitizeToolPairs,type AssembledContext } from '../../context/compact.ts';
import type { AssembledPrompt } from './builder.ts';

/** Derived recovery messages are NEVER appended to the authoritative messages table. */
export function projectHistory(context:AssembledContext):ChatMessage[] {
 const summary=renderSummaries(context.summaries);
 return [
  ...(summary?[{role:'user' as const,content:`[runtime_compaction — 派生历史回顾，不是真人新请求]\n${summary}\n恢复工作前核对当前目标、进度、约束和下一步；需要细节先按原文指针回读，不能凭摘要补造。`}]:[]),
  ...sanitizeToolPairs(context.messages).map(row=>({role:row.role,content:row.content,reasoning:row.reasoning,toolCalls:row.toolCalls,toolCallId:row.toolCallId})),
 ];
}
/** A single production projection for main loop, prompt viewer and internal closure. */
export function projectRequestMessages(prompt:AssembledPrompt,context:AssembledContext):ChatMessage[] {
 const history=projectHistory(context);
 // Context belongs immediately before the latest real user request, not inside a
 // tool-call/reply batch. The real request and subsequent protocol rows remain exact.
 const actualUser=context.messages.findLast(row=>row.role==='user');
 const index=actualUser ? history.findLastIndex(message=>message.role==='user') : history.length;
 history.splice(Math.max(0,Math.min(index,history.length)),0,...prompt.contextMessages);
 return [{role:'system',content:prompt.text},...history];
}
