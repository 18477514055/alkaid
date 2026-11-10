import type { DatabaseSync } from 'node:sqlite';

import { createFsTools } from './fs.ts';
import { createRecallTool } from './recall.ts';
import { createMemoryTools } from './memory.ts';
import { createMemoryWorkbenchTools } from './memory-workbench.ts';
import { createMemoryDispositionTool } from './memory-disposition.ts';
import { createExecutionBoardTool } from './execution.ts';
import { createTeamTasksTool } from './team.ts';
import { createPwshTool } from './shell.ts';
import { createDelegateTool } from '../agent/delegate-tool.ts';
import { ToolRegistry, type ToolDefinition } from './types.ts';
import { getConversation } from '../store/repo.ts';

/**
 * 默认工具集。
 *
 * 可见性分三类，都是刻意的：
 * - **文件工具 + recall**：五档全可见 —— 它们的执行在我们自己的进程里，`policy/guard.ts` 是真边界。
 * - **shell**：`readonly` 档**不给**；其余四档可见。
 *   ★ V0.2 起非 full 档走 **Low 完整性沙箱**（能写工作区/共享/临时，写别处被系统拒），
 *     `full` 档走原生 spawn（"我信任这一步"的档位）。
 * - **插件工具**：同样只在完全权限档（插件拥有宿主权限，围栏管不到它）。
 *
 * ★ `describe_tool` **不在这里注册** —— 它是懒加载的运行时元工具，
 *   由 `ToolSurface` 按需注入。注册进来会让它在"没有按需工具"时也常驻，白占缓存前缀。
 */
export function createDefaultRegistry(
  db?: DatabaseSync,
  options?: {
    readonly secretsPath?: string;
    /**
     * 子代理模型白名单（三态，见 `shared/settings.ts`）。
     * ★ 不传 = `undefined` ⇒ 按"不限制"处理（`delegate-tool.ts` 里 `?? null`），
     *   这样老调用方（大量测试）行为完全不变。
     */
    readonly delegateAllowedModels?: readonly string[] | null;
    /** 是否允许把主对话自己的模型派给子代理（默认 true）。不传 = 允许。 */
    readonly delegateAllowParentModel?: boolean;
  },
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createFsTools()) registry.register(tool);
  if (db !== undefined) {
    registry.register(createRecallTool(db));
    /**
     * ★ 委派工具（子代理 spawn）**不包**记忆守卫：子代理虽然不能用它
     *   （`delegate-tool.ts` 自己按 `agent_role` 拒绝），但主对话需要它，
     *   而 `registerMemory` 会把工具整个对子代理禁掉 —— 那不是我们想要的语义。
     *   这里只解决"没有密钥路径就不能用"的问题：没传 path 时工具会如实回
     *   `delegate_unavailable`（而不是静默消失），这样看板上能看出"功能在但没配好"。
     */
    registry.register(
      createDelegateTool(db, {
        ...(options?.secretsPath === undefined ? {} : { secretsPath: options.secretsPath }),
        ...(options?.delegateAllowedModels === undefined ? {} : { allowedModels: options.delegateAllowedModels }),
        ...(options?.delegateAllowParentModel === undefined ? {} : { allowParentModel: options.delegateAllowParentModel }),
      }),
    );
    const registerMemory = (tool:ToolDefinition) => registry.register({ ...tool,
      async execute(args,ctx) {
        if (ctx.agentRole === 'subagent' || getConversation(db,ctx.conversationId)?.agentRole === 'subagent') return { ok:false, code:'tool_not_found', message:'子智能体只返回委派结果，项目记忆由主对话维护。' };
        return tool.execute(args,ctx);
      },
    });
    for (const tool of createMemoryTools(db)) registerMemory(tool);
    for (const tool of createMemoryWorkbenchTools(db)) registerMemory(tool);
    registerMemory(createMemoryDispositionTool(db));
    registerMemory(createExecutionBoardTool(db));
    /**
     * ★ `team_tasks` **不走 `registerMemory`** —— 这是刻意的。
     *
     * `registerMemory` 的语义是"子智能体一律挡掉"（项目台账由主对话维护）。
     * 而 Team 板存在的全部意义就是**子代理也在这块板上认领活**
     * （DSH：「other agents claim ready tasks themselves」）。
     * 包进 `registerMemory` = 把这个功能直接废掉，而且症状很隐蔽：
     * 工具在清单里看得到，子代理一调就"没有这个工具"。
     *
     * ★ 越权判据不在这里，在 `core/team/board.ts` 里 ——
     *   它按"调用者是不是板主 / 是不是卡的 owner"逐条判定，
     *   而不是按"你是不是子代理"一刀切。
     */
    registry.register(createTeamTasksTool(db));
  }
  registry.register(createPwshTool());
  return registry;
}
