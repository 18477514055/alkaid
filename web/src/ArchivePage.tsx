import { Fragment, useState, type ReactElement } from 'react';

import './new-parts.css';
import type { ConversationDto, ProjectDto } from './api.ts';

/**
 * 设置 → 归档页：管理**已归档的对话**与**已归档的项目**。
 *
 * ★ 为什么二次确认做成「行内展开的一行」而不是再弹一个模态：
 *   归档页本身就住在设置弹窗里（`.settings-dialog` 带 `overflow: hidden`，
 *   外面还有 `.modal-backdrop` 的层叠上下文）。再叠一层 fixed 遮罩要么被裁、
 *   要么 z-index 打架。行内展开既不会跑出边界，也把「你正在删的到底是哪一行」
 *   摆在眼前 —— 对不可恢复的操作来说，这比居中弹窗更不容易点错。
 *
 * ★ 时间为什么自己拼而不用 toLocaleString：
 *   各浏览器 / 各语言的输出差别太大（有的给 2026/11/9 下午 7:19，有的给 Nov 9）。
 *   这里统一成 `YYYY-MM-DD HH:mm`（本地时区），表格才对得齐。
 */

export type ArchivePageProps = {
  archivedConversations: readonly ConversationDto[];
  archivedProjects: readonly ProjectDto[];
  /** 正在处理的对象 id（用于禁用按钮与显示"处理中…"） */
  busyId: string | null;
  onRestoreConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onRestoreProject: (id: string) => void;
  onDeleteProject: (id: string, deleteFiles: boolean) => void;
  /** 数据加载中 */
  loading?: boolean;
  error?: string | null;
};

type Pending =
  | { readonly kind: 'conversation'; readonly id: string; readonly label: string }
  | { readonly kind: 'project'; readonly id: string; readonly label: string };

/** ISO → `YYYY-MM-DD HH:mm`（本地时区）；解析不出来就给个占位，不抛错 */
function formatWhen(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function conversationLabel(item: ConversationDto): string {
  const title = item.title?.trim() ?? '';
  return title.length > 0 ? title : '（无标题对话）';
}

export function ArchivePage(props: ArchivePageProps): ReactElement {
  const {
    archivedConversations,
    archivedProjects,
    busyId,
    onRestoreConversation,
    onDeleteConversation,
    onRestoreProject,
    onDeleteProject,
  } = props;

  const loading = props.loading === true;
  const error = props.error ?? null;

  const [pending, setPending] = useState<Pending | null>(null);
  /** 项目删除时「同时删共享目录文件」，默认**不勾** */
  const [deleteFiles, setDeleteFiles] = useState(false);

  const isBusy = (id: string): boolean => busyId !== null && busyId === id;

  const askDelete = (next: Pending): void => {
    setDeleteFiles(false);
    setPending(next);
  };

  const cancel = (): void => {
    setDeleteFiles(false);
    setPending(null);
  };

  const confirmConversationDelete = (id: string): void => {
    onDeleteConversation(id);
    setPending(null);
  };

  const confirmProjectDelete = (id: string): void => {
    onDeleteProject(id, deleteFiles);
    setPending(null);
    setDeleteFiles(false);
  };

  const emptyConversations = archivedConversations.length === 0;
  const emptyProjects = archivedProjects.length === 0;

  return (
    <div className="archive-page">
      {error !== null ? (
        <p className="archive-error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="archive-loading" role="status">
          正在加载归档…
        </p>
      ) : null}

      {/* ── 已归档的对话 ───────────────────────────────────── */}
      <section className="archive-section" aria-labelledby="archive-conv-heading" aria-busy={loading}>
        <h3 className="archive-heading" id="archive-conv-heading">
          已归档的对话
          <span className="archive-count">{archivedConversations.length}</span>
        </h3>
        <p className="archive-desc">归档的对话不会再出现在左栏列表里；还原后回到原位置。</p>

        {emptyConversations ? (
          <p className="archive-empty">没有已归档的对话</p>
        ) : (
          <table className="archive-table" aria-label="已归档的对话">
            <thead>
              <tr>
                <th scope="col">标题</th>
                <th scope="col">所属项目</th>
                <th scope="col">归档时间</th>
                <th scope="col" className="archive-col-actions">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {archivedConversations.map((item) => {
                const label = conversationLabel(item);
                const busy = isBusy(item.id);
                const confirming = pending !== null && pending.kind === 'conversation' && pending.id === item.id;
                return (
                  <Fragment key={item.id}>
                    <tr className="archive-row">
                      <td>
                        <div className="archive-name" title={label}>
                          {label}
                        </div>
                      </td>
                      <td>
                        <div className="archive-sub">{item.projectId ?? '—'}</div>
                      </td>
                      <td className="archive-when">{formatWhen(item.archivedAt)}</td>
                      <td className="archive-col-actions">
                        <div className="archive-actions">
                          <button
                            type="button"
                            className="archive-btn"
                            disabled={busy}
                            aria-label={`还原对话 ${label}`}
                            onClick={() => {
                              onRestoreConversation(item.id);
                            }}
                          >
                            {busy ? '处理中…' : '还原'}
                          </button>
                          <button
                            type="button"
                            className="archive-btn danger"
                            disabled={busy}
                            aria-label={`永久删除对话 ${label}`}
                            aria-expanded={confirming}
                            onClick={() => {
                              askDelete({ kind: 'conversation', id: item.id, label });
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>

                    {confirming ? (
                      <tr key={`${item.id}-confirm`} className="archive-confirm-row">
                        <td colSpan={4}>
                          <div className="archive-confirm">
                            <p className="archive-confirm-text strong">
                              永久删除对话「{label}」？这个消息记录会从服务端删除，不可恢复。
                            </p>
                            <div className="archive-confirm-actions">
                              <button type="button" className="archive-btn" disabled={busy} onClick={cancel}>
                                取消
                              </button>
                              <button
                                type="button"
                                className="archive-btn danger solid"
                                disabled={busy}
                                onClick={() => {
                                  confirmConversationDelete(item.id);
                                }}
                              >
                                {busy ? '处理中…' : '永久删除'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── 已归档的项目 ───────────────────────────────────── */}
      <section className="archive-section" aria-labelledby="archive-proj-heading" aria-busy={loading}>
        <h3 className="archive-heading" id="archive-proj-heading">
          已归档的项目
          <span className="archive-count">{archivedProjects.length}</span>
        </h3>
        <p className="archive-desc">归档的项目不再出现在左栏；共享目录里的文件默认不动。</p>

        {emptyProjects ? (
          <p className="archive-empty">没有已归档的项目</p>
        ) : (
          <table className="archive-table" aria-label="已归档的项目">
            <thead>
              <tr>
                <th scope="col">项目</th>
                <th scope="col">共享目录</th>
                <th scope="col">归档时间</th>
                <th scope="col" className="archive-col-actions">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {archivedProjects.map((item) => {
                const busy = isBusy(item.id);
                const confirming = pending !== null && pending.kind === 'project' && pending.id === item.id;
                return (
                  <Fragment key={item.id}>
                    <tr className="archive-row">
                      <td>
                        <div className="archive-name" title={item.name}>
                          {item.name}
                        </div>
                      </td>
                      <td>
                        <div className="archive-sub" title={item.sharedDir}>
                          {item.sharedDir}
                        </div>
                      </td>
                      <td className="archive-when">{formatWhen(item.archivedAt)}</td>
                      <td className="archive-col-actions">
                        <div className="archive-actions">
                          <button
                            type="button"
                            className="archive-btn"
                            disabled={busy}
                            aria-label={`还原项目 ${item.name}`}
                            onClick={() => {
                              onRestoreProject(item.id);
                            }}
                          >
                            {busy ? '处理中…' : '还原'}
                          </button>
                          <button
                            type="button"
                            className="archive-btn danger"
                            disabled={busy}
                            aria-label={`删除项目 ${item.name}`}
                            aria-expanded={confirming}
                            onClick={() => {
                              askDelete({ kind: 'project', id: item.id, label: item.name });
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>

                    {confirming ? (
                      <tr key={`${item.id}-confirm`} className="archive-confirm-row">
                        <td colSpan={4}>
                          <div className="archive-confirm">
                            <p className={`archive-confirm-text${deleteFiles ? ' strong' : ''}`}>
                              {deleteFiles
                                ? `删除项目「${item.name}」并永久删除共享目录里的文件。`
                                : `删除项目「${item.name}」的登记？共享目录里的文件会保留。`}
                            </p>
                            <label className="archive-check">
                              <input
                                type="checkbox"
                                checked={deleteFiles}
                                disabled={busy}
                                aria-label="同时删除项目共享目录里的文件"
                                onChange={(event) => {
                                  setDeleteFiles(event.target.checked);
                                }}
                              />
                              同时删除项目共享目录里的文件
                            </label>
                            {deleteFiles ? (
                              <p className="archive-confirm-text strong">
                                共享目录「{item.sharedDir}」里的文件将被永久删除，不可恢复。
                              </p>
                            ) : null}
                            <div className="archive-confirm-actions">
                              <button type="button" className="archive-btn" disabled={busy} onClick={cancel}>
                                取消
                              </button>
                              <button
                                type="button"
                                className="archive-btn danger solid"
                                disabled={busy}
                                onClick={() => {
                                  confirmProjectDelete(item.id);
                                }}
                              >
                                {busy ? '处理中…' : deleteFiles ? '永久删除' : '删除项目'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
