import type { DatabaseSync } from 'node:sqlite';
import type { Provider } from '../model/provider.ts';
import type { ToolRegistry } from '../tools/types.ts';
import { getGeneralSettings } from '../settings/service.ts';
import { buildConversationPrompt } from './prompt/session.ts';
import { compactRange,CompactionError,getCompactionState,planCompaction } from '../context/compact.ts';
import { getCompactionDuties } from '../memory/duties.ts';

/** Shared read-only projection for UI/auto scheduling. The 80% line is NOT the 5% ledger interval. */
export function readCompactionStatus(db:DatabaseSync,conversationId:string,tools:ToolRegistry) {
 const settings=getGeneralSettings(db),prompt=buildConversationPrompt(db,conversationId,tools);
 return {
  settings:{enabled:settings.autoCompactEnabled,thresholdPercent:settings.compactThresholdPercent},
  contextTokens:prompt.state.contextTokens,contextWindow:prompt.state.contextWindow,
  ratio:prompt.state.contextTokens/Math.max(1,prompt.state.contextWindow),
  duties:getCompactionDuties(db,conversationId),plan:planCompaction(db,conversationId,{source:'manual'}),
  ...getCompactionState(db,conversationId),
 };
}
export function autoCompactionDue(db:DatabaseSync,conversationId:string,tools:ToolRegistry):boolean {
 const settings=getGeneralSettings(db);if(!settings.autoCompactEnabled)return false;
 const state=buildConversationPrompt(db,conversationId,tools).state;
 return state.contextTokens/Math.max(1,state.contextWindow)>settings.compactThresholdPercent/100;
}
/** Caller awaits this between complete steps. No fire-and-forget mutation of the request surface. */
export async function maybeAutoCompact(options:{db:DatabaseSync;conversationId:string;tools:ToolRegistry;provider:Provider;signal:AbortSignal}):Promise<'none'|'compacted'|'blocked'|'failed'> {
 if(options.signal.aborted||!autoCompactionDue(options.db,options.conversationId,options.tools))return 'none';
 try {
  const row=await compactRange({db:options.db,conversationId:options.conversationId,source:'auto',createProvider:()=>options.provider,signal:options.signal});
  return row?'compacted':'blocked';
 }catch(error){
  // The engine logs fixed diagnostic codes. Never leak upstream response text into business chat.
  if(error instanceof CompactionError&&['blocked','busy','auto_duplicate'].includes(error.code))return 'blocked';
  return 'failed';
 }
}
