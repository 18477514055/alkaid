import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

/**
 * 每条消息下面的操作条（复制 / 分支到新对话）。
 *
 * ★ 为什么默认透明、靠父级 hover 才显形：
 *   这两颗按钮**不是主操作**，一条对话里每行都挂着一排常亮小按钮，
 *   视觉上会和正文抢注意力（尤其 assistant 消息本来就长）。
 *   这里只压 `opacity`、**不用 `display:none` 或 `visibility:hidden`** ——
 *   那些做法会让键盘用户 Tab 到按钮时**看不到焦点落在哪**。
 *   所以 CSS 里同时给了 `.msg-actions:focus-within`，聚焦即显形。
 *
 * ★ 为什么复制反馈要自己管一个定时器：
 *   「已复制」必须自己收回去，否则下一条消息看上去也像刚被复制过。
 *   定时器一定要在卸载时清掉 —— 消息列表会随会话切换整批重建，
 *   不清就会在已卸载的组件上 setState（React 19 不再报警，但状态是白算的）。
 */

export type MessageActionsProps = {
  /** 要复制 / 分支的正文 */
  content: string;
  /** 消息序号（分支接口要的就是它） */
  seq: number;
  role: 'user' | 'assistant';
  onBranch: (seq: number) => void;
  disabled?: boolean;
};

/** 反馈停留时长：1.4s 足够看清「已复制」，又不至于挡住下一次点 */
const FEEDBACK_MS = 1400;

type Feedback = 'idle' | 'ok' | 'fail';

export function MessageActions({
  content,
  seq,
  role,
  onBranch,
  disabled = false,
}: MessageActionsProps): ReactElement {
  const [feedback, setFeedback] = useState<Feedback>('idle');
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback((): void => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // 卸载时收尾：把 return 的清理函数直接交给 effect
  useEffect(() => clearTimer, [clearTimer]);

  const flash = useCallback(
    (next: Feedback): void => {
      clearTimer();
      setFeedback(next);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setFeedback('idle');
      }, FEEDBACK_MS);
    },
    [clearTimer],
  );

  const handleCopy = useCallback((): void => {
    /**
     * ★ 先把它提成 `Clipboard | undefined` 再判空：
     *   lib.dom 把 `navigator.clipboard` 声明成一定存在，但**非 https / 非 localhost**
     *   的页面上它其实是 undefined。直接写 `navigator.clipboard === undefined`
     *   会被 TS 判成「两个类型没有交集」而报错，用中间变量才是诚实的写法。
     *
     * ★ 这里不走 `document.execCommand('copy')` 兜底：那个接口已废弃，
     *   而且要先把选中区抢过来（会打断用户自己的选择）。失败就照实说「复制失败」。
     */
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) {
      flash('fail');
      return;
    }
    void clipboard.writeText(content).then(
      () => {
        flash('ok');
      },
      () => {
        flash('fail');
      },
    );
  }, [content, flash]);

  const copyLabel = feedback === 'ok' ? '已复制' : feedback === 'fail' ? '复制失败' : '复制';

  return (
    <div className={`msg-actions ${role}`}>
      <button
        type="button"
        className={`msg-action ${feedback === 'ok' ? 'ok' : feedback === 'fail' ? 'fail' : ''}`}
        title="复制这条消息的正文"
        onClick={handleCopy}
        disabled={disabled || content.length === 0}
      >
        {copyLabel}
      </button>
      <button
        type="button"
        className="msg-action"
        title={`从 seq ${seq} 分出一个新对话（保留到这条为止的上下文）`}
        onClick={() => {
          onBranch(seq);
        }}
        disabled={disabled}
      >
        分支到新对话
      </button>
    </div>
  );
}
