import type { DatabaseSync } from 'node:sqlite';
import { assembleContext, renderSummaries } from '../../context/compact.ts';
import { resolvePermissionMode } from '../../policy/mode.ts';
import { getConversation, getProject, getWorkspace } from '../../store/repo.ts';
import { createSurface } from '../../tools/runtime.ts';
import { toolModeMap } from '../../tools/settings.ts';
import type { ToolRegistry } from '../../tools/types.ts';
import { PromptBuilder } from './builder.ts';
import { builtinSources } from './builtin.ts';
import { memoryAwarePrompt, projectMemoryBlock } from './memory.ts';
import { projectRequestMessages } from './projection.ts';

/** One read-only projection for prompt viewer, bottom waterline, and right-board status. */
export function buildConversationPrompt(db: DatabaseSync, conversationId: string, tools: ToolRegistry) {
  const conversation = getConversation(db, conversationId);
  if (!conversation) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
  const mode = resolvePermissionMode(conversation.permissionMode);
  const workspace = conversation.primaryWorkspaceId ? getWorkspace(db, conversation.primaryWorkspaceId) : undefined;
  const project = conversation.projectId ? getProject(db, conversation.projectId) : undefined;
  const surface = createSurface(tools, mode, toolModeMap(db), conversation.agentRole);
  const assembled = assembleContext(db, conversationId);
  const builder = new PromptBuilder(builtinSources());
  const result = memoryAwarePrompt(db, conversationId, builder, {
    conversationId, agentRole: conversation.agentRole, permissionMode: mode, workspacePath: workspace?.rootPath ?? null,
    projectSharedDir: project?.sharedDir ?? null, toolNames: surface.visibleNames,
    userInstructions: conversation.instructions, projectMemory: projectMemoryBlock(db, conversationId),
    summaryBlock: null,
  }, surface.tools);
  return { ...result, messages:projectRequestMessages(result,assembled), sources: builder.listSources(), instructions: conversation.instructions };
}
