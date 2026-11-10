import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type AppSettingsDto, type GeneralSettings, type PanelSettings } from './api.ts';
import { DEFAULT_GENERAL, DEFAULT_PANEL } from '../../src/shared/settings.ts';
/**
 * 应用设置的读取与写入（**服务端为唯一真源**）。
 *
 * ★ 为什么不再用 `localStorage`（2026-11-09 用户报「每次更新设置就没了」）：
 *   桌面壳每次启动都挑一个随机空闲端口 ⇒ 前端 origin 每次都变
 *   （`http://127.0.0.1:61715` → `http://127.0.0.1:52344`…），
 *   而 `localStorage` 是**按 origin 隔离**的 ⇒ 设置每次重启就归零。
 *   跟"更新"其实无关：**是每次启动都丢**。放服务端后跟着数据家走，更新与重启都不再丢。
 *
 * ★ 写入策略：**乐观更新 + 失败回滚**。
 *   改一个开关要立刻在界面上生效（否则像没点到），但服务端才是真源；
 *   请求失败就把状态退回上一次服务端确认的值，并把错误交给调用方显示。
 */
export type SettingsState = {
  readonly ready: boolean;
  readonly general: GeneralSettings;
  /** 无项目对话用的右栏设置（也是新项目的初始值） */
  readonly panelWithoutProject: PanelSettings;
  /** 项目覆盖（按项目 id）；没取到的项目用 panelWithoutProject */
  readonly projectPanels: Readonly<Record<string, PanelSettings>>;
  /** 当前作用域的右栏设置：有项目用项目的，没有就用全局那份 */
  panelFor: (projectId: string | null) => PanelSettings;
  /** 按需拉取某个项目的右栏设置（App 在切会话时调；没拉到之前用默认值） */
  ensureProjectPanel: (projectId: string | null) => void;
  updateGeneral: (patch: Partial<GeneralSettings>) => Promise<void>;
  updatePanel: (projectId: string | null, patch: Partial<PanelSettings>) => Promise<void>;
  reload: () => Promise<void>;
};

export function useAppSettings(): SettingsState {
  const [ready, setReady] = useState(false);
  const [general, setGeneral] = useState<GeneralSettings>(DEFAULT_GENERAL);
  const [panelWithoutProject, setPanelWithoutProject] = useState<PanelSettings>(DEFAULT_PANEL);
  const [projectPanels, setProjectPanels] = useState<Record<string, PanelSettings>>({});
  /** 服务端确认过的最后一份（失败回滚用） */
  const confirmed = useRef<{ general: GeneralSettings; panel: PanelSettings }>({
    general: DEFAULT_GENERAL,
    panel: DEFAULT_PANEL,
  });

  const apply = useCallback((next: AppSettingsDto) => {
    setGeneral(next.general);
    setPanelWithoutProject(next.panel);
    confirmed.current = { general: next.general, panel: next.panel };
  }, []);

  const reload = useCallback(async () => {
    try {
      apply(await api.getSettings());
    } finally {
      setReady(true);
    }
  }, [apply]);

  useEffect(() => {
    void reload().catch(() => setReady(true));
  }, [reload]);

  const updateGeneral = useCallback(async (patch: Partial<GeneralSettings>) => {
    const previous = confirmed.current.general;
    setGeneral((current) => ({ ...current, ...patch }));
    try {
      apply(await api.patchSettings({ general: patch }));
    } catch (cause) {
      setGeneral(previous);
      throw cause;
    }
  }, [apply]);

  const updatePanel = useCallback(
    async (projectId: string | null, patch: Partial<PanelSettings>) => {
      if (projectId === null) {
        const previous = confirmed.current.panel;
        setPanelWithoutProject((current) => ({ ...current, ...patch }));
        try {
          const next = await api.patchSettings({ panel: patch });
          apply(next);
        } catch (cause) {
          setPanelWithoutProject(previous);
          throw cause;
        }
        return;
      }

      const previous = projectPanels[projectId] ?? panelWithoutProject;
      setProjectPanels((current) => ({ ...current, [projectId]: { ...previous, ...patch } }));
      try {
        const next = await api.patchProjectSettings(projectId, patch);
        setProjectPanels((current) => ({ ...current, [projectId]: next.panel }));
      } catch (cause) {
        setProjectPanels((current) => ({ ...current, [projectId]: previous }));
        throw cause;
      }
    },
    [panelWithoutProject, projectPanels],
  );

  const panelFor = useCallback(
    /**
     * ★ 项目没拉到时用 **DEFAULT_PANEL**，不要回落到"无项目"那份。
     *   实测踩到的坑：全局那份读出来只剩工作/日志，回落过去会让**每个项目都少两个页签**。
     */
    (projectId: string | null): PanelSettings =>
      projectId === null ? panelWithoutProject : (projectPanels[projectId] ?? DEFAULT_PANEL),
    [panelWithoutProject, projectPanels],
  );

  /** 正在拉的项目，避免每次渲染都发请求 */
  const fetching = useRef<Set<string>>(new Set());
  const ensureProjectPanel = useCallback((projectId: string | null) => {
    if (projectId === null || fetching.current.has(projectId)) return;
    fetching.current.add(projectId);
    void api
      .getProjectSettings(projectId)
      .then((result) => setProjectPanels((current) => ({ ...current, [projectId]: result.panel })))
      .catch(() => {
        // 拉不到就用默认值，下次进这个项目再试
        fetching.current.delete(projectId);
      });
  }, []);

  return {
    ready,
    general,
    panelWithoutProject,
    projectPanels,
    panelFor,
    ensureProjectPanel,
    updateGeneral,
    updatePanel,
    reload,
  };
}
