import { type ReactElement } from 'react';

import type { DashboardDto, UsageDetailDto } from './api.ts';
import { IconX } from './icons.tsx';

/**
 * 底部「用量 / 上下文」内嵌抽屉。
 *
 * ★ 与旧版 `UsagePanel` 的本质差别：**它是文档流里的一块，不是 modal**。
 *   旧版是 `.modal-backdrop` + 居中弹窗，一打开就把整屏压暗、遮住对话 ——
 *   而这两个页签回答的是「这条对话现在什么状况」，**看数字的时候必须能同时看到对话**，
 *   否则每次都要先关掉再回头看，来回切。所以这里：
 *   - 没有 backdrop、没有 `position: fixed`；
 *   - 高度固定（260–320px）、内部各自滚动，撑开时对话区（flex:1）自动让位；
 *   - 内容与 `App.tsx` 里的 `UsagePanel` 逐字段一致，**不重新发明字段**。
 *
 * ★ 为什么表格要自己再包一层滚动容器：抽屉整体不高，逐步表格可能有 200 行；
 *   让 `thead` 停在表格容器顶部（sticky）比让表头跟着抽屉滚走可用得多。
 *
 * ★ `clockTime` 在这里重写而不是从 App.tsx 引：
 *   那个函数是 App.tsx 私有的（未导出），而 Lead 正在改 App.tsx ——
 *   从那里引一个"还没导出"的符号必然撞车。这 5 行重复是刻意的。
 */

export type UsageDockProps = {
  tab: 'usage' | 'context';
  onTab: (tab: 'usage' | 'context') => void;
  detail: UsageDetailDto | null;
  dashboard: DashboardDto | null;
  loading: boolean;
  onClose: () => void;
  onSetWindow: (tokens: number) => void;
};

/** 常用窗口档位（与 ModelPicker 的档位一致，两处别各写一套不同的数字） */
const WINDOW_PRESETS: readonly number[] = [32_000, 64_000, 128_000, 200_000, 1_000_000];

function clockTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function windowLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${String(tokens / 1_000_000)}M` : `${String(Math.round(tokens / 1000))}k`;
}

export function UsageDock({
  tab,
  onTab,
  detail,
  dashboard,
  loading,
  onClose,
  onSetWindow,
}: UsageDockProps): ReactElement {
  return (
    <section className="usage-dock" aria-label="用量与上下文">
      <div className="usage-dock-head">
        <div className="seg">
          <button
            type="button"
            className={tab === 'usage' ? 'on' : ''}
            aria-pressed={tab === 'usage'}
            onClick={() => {
              onTab('usage');
            }}
          >
            用量
          </button>
          <button
            type="button"
            className={tab === 'context' ? 'on' : ''}
            aria-pressed={tab === 'context'}
            onClick={() => {
              onTab('context');
            }}
          >
            上下文
          </button>
        </div>
        {loading && <span className="usage-dock-loading">加载中…</span>}
        <span className="grow" />
        {/* ★ 这里不自己挂 Esc：抽屉在文档流里、和对话区共处一个焦点范围，
            再挂一个 document 级 Esc 会和 App.tsx 的同名处理互相打架。
            键盘关闭由接入方统一负责，按钮只做"点一下关掉"这一件事。 */}
        <button type="button" className="icon" title="关闭" aria-label="关闭" onClick={onClose}>
          <IconX size={14} />
        </button>
      </div>

      <div className="usage-dock-body">
        {tab === 'usage' && (
          <>
            {detail === null ? (
              <p className="hint">{loading ? '正在读取用量…' : '还没有用量数据。'}</p>
            ) : (
              <>
                <dl className="facts wide">
                  <dt>轮 / 步</dt>
                  <dd>
                    {detail.stats.turns} / {detail.stats.steps}
                  </dd>
                  <dt>输入 tokens</dt>
                  <dd>
                    {detail.stats.totalInput}
                    {/* ★ 三桶口径：总量下面摊开「未缓存 / 缓存读 / 缓存写」，三个数加起来正好是上面那个总量。
                        未缓存那桶直接用后端给的数（不在这里做减法反推），旧后端没给时才回退到差值。 */}
                    <span className="hint">
                      （未缓存{' '}
                      {detail.stats.totalUncachedInput ??
                        detail.stats.totalInput - detail.stats.totalCached - (detail.stats.totalCachedWrite ?? 0)}
                      ，缓存读 {detail.stats.totalCached}
                      {detail.stats.totalCachedWrite === null || detail.stats.totalCachedWrite === undefined
                        ? '，缓存写未回报'
                        : `，缓存写 ${detail.stats.totalCachedWrite}`}
                      ）
                    </span>
                  </dd>
                  <dt>输出 tokens</dt>
                  <dd>{detail.stats.totalOutput}</dd>
                  <dt>命中缓存</dt>
                  <dd>
                    {detail.stats.totalCached}
                    {detail.stats.cacheHitRate === null
                      ? ''
                      : `（${String(Math.round(detail.stats.cacheHitRate * 100))}%）`}
                  </dd>
                  <dt>生成总耗时</dt>
                  <dd>{(detail.elapsedMs / 1000).toFixed(1)} s</dd>
                  <dt>平均输出速度</dt>
                  <dd>
                    {detail.stats.tokensPerSecond === null ? '—' : `${String(detail.stats.tokensPerSecond)} tok/s`}
                  </dd>
                </dl>

                {detail.steps.length === 0 ? (
                  <p className="hint">还没有带 usage 的步骤。模型没回用量时这里会是空的 —— 那不是 bug。</p>
                ) : (
                  <div className="usage-table-wrap">
                    <table className="usage-table">
                      <thead>
                        <tr>
                          <th>seq</th>
                          <th>时间</th>
                          <th>输入</th>
                          <th>输出</th>
                          <th>缓存读</th>
                          <th>缓存写</th>
                          <th>耗时</th>
                          <th>速度</th>
                          <th>结束</th>
                        </tr>
                      </thead>
                      <tbody>
                        {/* ★ 倒序（最近的在上）：这一步刚花掉多少，是最常看的那一行 */}
                        {detail.steps
                          .slice()
                          .reverse()
                          .map((step) => (
                            <tr key={step.seq}>
                              <td className="mono">{step.seq}</td>
                              <td className="mono dim">{clockTime(step.at)}</td>
                              <td>{step.input}</td>
                              <td>{step.output}</td>
                              <td className="dim">{step.cached}</td>
                              {/* ★ 没报过就显示「—」，不要显示 0 —— 「0 次写入」和「没回报」不是一回事 */}
                              <td className="dim">{step.cachedWrite ?? '—'}</td>
                              <td className="dim">
                                {step.durationMs === null ? '—' : `${(step.durationMs / 1000).toFixed(1)}s`}
                              </td>
                              <td className="dim">
                                {step.tokensPerSecond === null ? '—' : String(step.tokensPerSecond)}
                              </td>
                              <td className="mono dim">{step.finishReason ?? '—'}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="hint">
                  只列最近 {detail.steps.length} 步（共 {detail.stepCount} 步）。速度 = 该步输出 ÷ 该步实际耗时；
                  耗时取「本条消息时间 − 上一条消息时间」，是能从库里还原的近似值。
                </p>
              </>
            )}
          </>
        )}

        {tab === 'context' && (
          <>
            {dashboard === null ? (
              <p className="hint">先选一个会话。</p>
            ) : (
              <>
                <dl className="facts wide">
                  <dt>已用（未压缩）</dt>
                  <dd>{dashboard.contextTokens} tokens</dd>
                  <dt>模型窗口</dt>
                  <dd>{dashboard.contextWindow} tokens</dd>
                  <dt>水位</dt>
                  <dd>
                    {dashboard.contextRatio === null
                      ? '—'
                      : `${(dashboard.contextRatio * 100).toFixed(1)}%`}
                  </dd>
                  <dt>剩余可用</dt>
                  <dd>{Math.max(dashboard.contextWindow - dashboard.contextTokens, 0)} tokens</dd>
                  <dt>消息条数</dt>
                  <dd>{dashboard.messageCount}</dd>
                  <dt>压缩段</dt>
                  <dd>{dashboard.compactions.length}</dd>
                </dl>

                {dashboard.compactions.length > 0 && (
                  <>
                    <div className="panel-title">已压缩的区间（原文仍可取回）</div>
                    {dashboard.compactions.map((row) => (
                      <div key={row.id} className="compaction-item">
                        <span className="mono">
                          seq {row.fromSeq}–{row.toSeq}
                        </span>
                        <span className="hint">（{row.summary.length} 字摘要）</span>
                      </div>
                    ))}
                  </>
                )}

                <div className="panel-title">窗口配置</div>
                <p className="hint">
                  水位 = 未压缩上下文 ÷ 模型窗口。窗口填小了只会更早提示你压缩，不会溢出；填大了水位会偏低。
                  <strong>改了要重新进会话才生效</strong>（数据来自 /dashboard）。
                </p>
                <div className="usage-adjust">
                  {WINDOW_PRESETS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`small ${value === dashboard.contextWindow ? 'on' : ''}`}
                      disabled={loading}
                      onClick={() => {
                        onSetWindow(value);
                      }}
                    >
                      {windowLabel(value)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
