import type { DatabaseSync } from 'node:sqlite';
import { assembleContext, renderSummaries } from '../../context/compact.ts';
import { resolvePermissionMode } from '../../policy/mode.ts';
import { getConversation, getProject, getWorkspace } from '../../store/repo.ts';
import { createSurface } from '../../tools/runtime.ts';
import { effectiveToolModes } from '../../tools/gate.ts';
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
  /**
   * ★ 用**会话生效值**，不是全局值（2026-11-11 审计 `HIGH-02`）。
   *
   * v18 之后工具门控有两层：全局默认 + 会话覆盖。这里原来读的是 `toolModeMap(db)`（只看全局），
   * 于是提示词查看器 / 水位估算 / 右栏看板看到的工具表，与 `runTurn` 真正发出去的**不是同一份** ——
   * 用户在对话里关掉一组工具，查看器照样显示它们在常驻，估出来的 token 也是错的。
   */
  const surface = createSurface(tools, mode, effectiveToolModes(db, conversationId), conversation.agentRole);
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
