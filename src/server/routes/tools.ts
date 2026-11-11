import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../app.ts';
import { buildCatalog } from '../../core/tools/catalog.ts';
import { clearToolSetting, listToolViews, setToolMode, toolModeMap } from '../../core/tools/settings.ts';
import { isToolMode, type ToolMode, type ToolSource } from '../../core/tools/types.ts';
import { resolvePermissionMode } from '../../core/policy/mode.ts';

/**
 * 工具管理面（`/api/tools`）。
 *
 * ## ★★★ 三条设计判据
 *
 * 1. **`GET` 只读，不改任何东西**；改动一律 `PATCH`。
 *    设置页打开时会先 GET 一次，若 GET 顺带"补齐默认值写库"，
 *    那就会把"没配置过"变成"用户选择过"，将来改默认值对老库无效（见 settings.ts 判据 1）。
 *
 * 2. **`PATCH` 只接受 `mode` 一个字段**（+ 可选 `reset`）。
 *    ★ 不接受"一次提交整张表"：工具是**独立**的开关，整表提交会让两个编辑器互相覆盖
 *      （用户在两个窗口各改一个工具，后保存的把前一个回退了）。
 *
 * 3. **非法工具名要 404 而不是静默成功**。
 *    静默成功会让界面显示"已保存"，而实际什么都没发生 —— 那是最难查的一类 bug。
 */
export function registerToolRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /**
   * 列出全部工具及其三态。
   *
   * 查询参数 `mode` 用来算 `visibleInMode`（哪一档看得见）——
   * 这让我们能在同一张表里解释"为什么它没出现"：是权限挡的，还是被用户关的。
   */
  app.get('/api/tools', async (request) => {
    const query = request.query as { mode?: string };
    const mode = resolvePermissionMode(query.mode);
    const views = listToolViews(deps.db, deps.tools, mode);

    // 顺带把"这一轮真正会发什么"算出来 —— 界面用它显示"常驻 N / 按需 M / 关闭 K"
    const catalog = buildCatalog(deps.tools, mode, toolModeMap(deps.db));

    return {
      permissionMode: mode,
      tools: views,
      summary: {
        resident: catalog.resident.length,
        lazy: catalog.lazy.length,
        disabled: catalog.disabled.length,
        // 这一轮实际发给模型的工具表大小（字符）—— 用户能直观看到懒加载省了多少
        toolTableChars: JSON.stringify(catalog.tools).length,
      },
    };
  });

  /**
   * 改一个工具的三态。
   *
   * body：`{ mode: 'resident' | 'lazy' | 'disabled' }` 或 `{ reset: true }`（回到代码默认）。
   */
  app.patch('/api/tools/:name', async (request, reply) => {    const { name } = request.params as { name: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    // 名字必须存在于注册表，或者是"配置还留着但工具不在了"的那一类
    const known = deps.tools.get(name) !== undefined;
    if (!known && !listToolViews(deps.db, deps.tools, 'workspace').some((view) => view.name === name)) {
      return reply.code(404).send({ error: `没有名为 "${name}" 的工具` });
    }

    if (body['reset'] === true) {
      clearToolSetting(deps.db, name);
      return { ok: true, name, mode: deps.tools.get(name)?.preferredMode ?? 'resident', reset: true };
    }

    if (!isToolMode(body['mode'])) {
      return reply.code(400).send({ error: "mode 必须是 'resident' / 'lazy' / 'disabled' 之一（或传 reset: true）" });
    }

    const mode: ToolMode = body['mode'];
    const tool = deps.tools.get(name);
    const source: ToolSource = tool?.source ?? 'builtin';
    setToolMode(deps.db, name, mode, source);

    // ★ 落库后**立刻回读**，不以内存/入参为准 —— 这是"设置存了 ≠ 生效"那类事故的唯一防线
    const verified = toolModeMap(deps.db).get(name) ?? (tool?.preferredMode ?? 'resident');
    if (verified !== mode) {
      return reply.code(500).send({ error: `设置没有真正落库（期望 ${mode}，实际 ${verified}）` });
    }
    return { ok: true, name, mode: verified };
  });

  /**
   * 批量重置 —— 把全部配置清空，回到代码默认。
   *
   * ★ 单独一个端点而不是 `PATCH {}`：清空是破坏性的，
   *   必须是一个用户看得懂的动作（界面上是"全部恢复默认"按钮 + 二次确认）。
   */
  app.post('/api/tools/reset', async () => {
    const cleared = [...toolModeMap(deps.db).keys()];
    for (const name of cleared) clearToolSetting(deps.db, name);
    return { ok: true, cleared: cleared.length };
  });
}
