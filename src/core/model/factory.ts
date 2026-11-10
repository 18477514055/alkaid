import type { ProviderRow } from '../store/repo.ts';
import { createOpenAiProvider } from './openai.ts';
import type { Provider, ProviderConfig, ThinkingShape } from './provider.ts';

/**
 * 唯一厂商分发点。新增一家 **OpenAI 兼容**厂商只要加一条 provider 记录，
 * 不改代码；非 OpenAI 协议要在这里加分支（V0.1 明确不支持，**报错而不是静默降级**）。
 */

const SUPPORTED_KINDS = new Set(['openai_compatible']);

export function toProviderConfig(row: ProviderRow, apiKey: string, sessionId?: string): ProviderConfig {
  // ★ 有的网关（OpenCode / OpenCode Go）要求一个**按对话固定**的会话头，
  //   不带直接 400 MissingSessionID（真实报错，用户踩过）。
  //   值是 conversationId —— 必须稳定：随机值等于每轮都是新会话，路由与缓存全失效。
  const sessionHeaders =
    row.sessionHeader !== null && row.sessionHeader.length > 0 && sessionId !== undefined && sessionId.length > 0
      ? { [row.sessionHeader]: sessionId }
      : {};

  const config: ProviderConfig = {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey,
    chatPath: row.chatPath,
    modelsPath: row.modelsPath,
    defaultModel: row.defaultModel,
    thinkingShape: row.thinkingShape as ThinkingShape,
    supportsStreamUsage: row.supportsStreamUsage,
    usesMaxCompletionTokens: row.usesMaxCompletionTokens,
    ...(row.extraHeaders === null && Object.keys(sessionHeaders).length === 0
      ? {}
      : { extraHeaders: { ...row.extraHeaders, ...sessionHeaders } }),
  };
  return config;
}

export function createProviderFromRow(row: ProviderRow, apiKey: string, sessionId?: string): Provider {
  if (!SUPPORTED_KINDS.has(row.kind)) {
    throw new Error(
      `暂不支持 provider kind = "${row.kind}"（V0.1 只实现 OpenAI 兼容协议，不会静默降级）`,
    );
  }
  return createOpenAiProvider({ config: toProviderConfig(row, apiKey, sessionId) });
}
