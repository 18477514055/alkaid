/**
 * MCP 服务器配置的共享契约（服务端 / 前端 / 工具共用）。
 *
 * ★ 为什么单独一个文件：`ToolSource` 里早有 `'mcp'`，但那只是类型占位与界面分组名，
 *   从来没有任何真正的连接能力。用户这轮明确要求"给模型一个配置 MCP 的通道，
 *   或在工具设置里手动输入"，所以这里把"一个 MCP 服务器长什么样"钉死。
 *
 * ★ 三条判据：
 *  1. **凭据不下发**。`env` / `headers` 里通常就是 token。`listMcpServers` 只回
 *     `envKeys` / `headerKeys`（键名）+ `hasEnv` / `hasHeaders`；要改就整份重填，
 *     或传 `KEEP_EXISTING` 占位表示"这一项保持原样"。**任何地方都不回显值。**
 *  2. **两种传输**：`stdio`（起子进程）与 `http`（streamable-http）。
 *     `stdio` 只接受 `command` + `args` + 可选 `cwd`；`http` 只接受 `url` + 可选 `headers`。
 *  3. **组模式三态**：`resident` / `lazy` / `disabled`，作用于该服务器的**全部工具**；
 *     单个工具仍可用既有的 `tool_settings` 覆盖。批量设置是这条需求的要点 ——
 *     一个 MCP 动辄几十个工具，逐个点谁都受不了。
 */

import { fitToolName } from './tool-name.ts';

/** 凭据占位符：PATCH 时原样回传表示"保持现有值不变" */
export const KEEP_EXISTING = '<KEEP_EXISTING>' as const;

export type McpTransport = 'stdio' | 'http';

/** 与工具三态同名同义，避免再发明一套词 */
export type McpGroupMode = 'resident' | 'lazy' | 'disabled';

export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http'];
export const MCP_GROUP_MODES: readonly McpGroupMode[] = ['resident', 'lazy', 'disabled'];

export const MCP_GROUP_MODE_LABEL: Readonly<Record<McpGroupMode, string>> = {
  resident: '常驻',
  lazy: '按需',
  disabled: '关闭',
};

/** 连接状态：只有真正连上并成功 listTools 才算 `ready` */
export type McpStatus = 'ready' | 'error' | 'disabled' | 'idle';

/**
 * 前端看到的服务器。
 * ★ 不含 `env` / `headers` 的**值**，只含键名 —— 见文件头判据 1。
 */
export type McpServerDto = {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  /** stdio 才有 */
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  /** http 才有 */
  readonly url: string | null;
  /** env 的键名（值不下发） */
  readonly envKeys: readonly string[];
  readonly headerKeys: readonly string[];
  readonly enabled: boolean;
  readonly groupMode: McpGroupMode;
  readonly status: McpStatus;
  /** 最近一次错误（连接失败 / listTools 失败），成功则为 null */
  readonly error: string | null;
  /** 该服务器当前注册进注册表的工具名（已清洗、已加前缀） */
  readonly toolNames: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type UpsertMcpServerInput = {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string | null;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string | null;
  readonly url?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
  readonly groupMode?: McpGroupMode;
};

/** PATCH：字段都可选；`env` / `headers` 里可以用 `KEEP_EXISTING` 表示保留原值 */
export type PatchMcpServerInput = Partial<UpsertMcpServerInput>;

/**
 * 工具名规则（会写进测试）：`mcp_<服务器名>_<工具名>`，全部清洗到 `[A-Za-z0-9_-]`。
 * ★ 这条不是审美：上游 OpenAI 兼容网关要求工具名匹配 `^[a-zA-Z0-9_-]+$`，
 *   带点号会被整轮拒绝（2026-11-08 真踩过，插件工具名 `p.demo-echo.whoami` 导致每轮 400）。
 */
export const MCP_TOOL_PREFIX = 'mcp_';

/**
 * ★ 字符集 + 长度 + **碰撞哈希** 三条判据的真源搬到了 `shared/tool-name.ts`，
 *   这里只保留转出（历史调用点与测试都从 `shared/mcp.ts` 拿，不要在这里复制一份逻辑）。
 *
 * 为什么必须带哈希：MCP 服务器名与工具名都由用户填，`server+tool` 拼起来超过 64 字符很常见
 * （服务器名 40 + 工具名 40 = 83）。单纯 `slice(0, 64)` 会让**同一服务器上两个长名工具撞名**，
 * 工具表静默少一个 —— 而且不报错，只有模型"怎么调都调不到"时才看得出来。
 */
export function sanitizeWireToolName(raw: string): string {
  return fitToolName(raw);
}

export function mcpToolName(serverName: string, toolName: string): string {
  // 哈希的输入用**原始**服务器名 + 工具名（不是拼好再清洗的串）：
  // `weird.name` 与 `weird/name` 清洗后同形，拿清洗后的串去算哈希仍会撞。
  return fitToolName(`${MCP_TOOL_PREFIX}${serverName}_${toolName}`, `${serverName}\0${toolName}`);
}
