import type { ReactElement } from 'react';

/**
 * 内联图标集 —— 一律 16×16、stroke=currentColor、线宽 1.4。
 *
 * ★ 为什么手写而不引库：整个前端只有十来个图标，引一个图标库会多带几十 KB
 *   并且把「颜色跟随文字」的规则交给第三方。这里每个都是纯路径，主题一改就跟着变。
 * ★ 一律 `fill=none`、`stroke=currentColor`：图标**永远不自己决定颜色**。
 */

export type IconProps = {
  readonly size?: number;
};

function svg(path: ReactElement, size: number): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}

export function IconPlus({ size = 16 }: IconProps): ReactElement {  return svg(
    <>
      <path d="M8 3.5v9M3.5 8h9" />
    </>,
    size,
  );
}

export function IconChevron({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </>,
    size,
  );
}

export function IconArrowUp({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2" />
    </>,
    size,
  );
}

export function IconPanel({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <rect x="2.2" y="3" width="11.6" height="10" rx="2" />
      <path d="M10.2 3v10" />
    </>,
    size,
  );
}

export function IconX({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M4 4l8 8M12 4l-8 8" />
    </>,
    size,
  );
}

/**
 * 停止生成用的方块。
 * ★ 为什么不用 ✕：✕ 在这套界面里已经表示"关闭/删除"，而"停止这一轮"是**中断**不是关闭，
 *   用实心方块才不会让人以为要点掉对话。
 */
export function IconStop({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.4" />
    </>,
    size,
  );
}


/** 瑶光的标记：一颗带十字光芒的星（与图标同源，但只用单色线稿） */
export function IconStar({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M8 1.6c.35 3.05 1.75 4.45 4.8 4.8-3.05.35-4.45 1.75-4.8 4.8-.35-3.05-1.75-4.45-4.8-4.8 3.05-.35 4.45-1.75 4.8-4.8Z" />
      <path d="M12.6 11.1c.15 1.3.75 1.9 2.05 2.05-1.3.15-1.9.75-2.05 2.05" />
    </>,
    size,
  );
}

export function IconPlugins({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M2.5 4.5h5v5h-5z" />
      <path d="M9.5 7.5h4v5h-4z" />
      <path d="M4 9.5v2h2" />
    </>,
    size,
  );
}

export function IconLink({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M6.4 9.6 9.6 6.4" />
      <path d="M7.6 4.4l1-1a2.5 2.5 0 0 1 3.6 3.6l-1 1" />
      <path d="M8.4 11.6l-1 1a2.5 2.5 0 0 1-3.6-3.6l1-1" />
    </>,
    size,
  );
}

export function IconArchive({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <rect x="2.2" y="3" width="11.6" height="3.2" rx="1" />
      <path d="M3.4 6.2v6.3h9.2V6.2" />
      <path d="M6.4 9h3.2" />
    </>,
    size,
  );
}

export function IconFolder({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M2.2 4.6c0-.7.5-1.2 1.2-1.2h2.4l1.2 1.4h5.6c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2Z" />
    </>,
    size,
  );
}

export function IconTerminal({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.8" />
      <path d="M5 6.6 6.8 8.4 5 10.2M8.6 10.4h2.6" />
    </>,
    size,
  );
}

export function IconAlert({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M8 2.6 14 13H2Z" />
      <path d="M8 6.6v3M8 11.2v.01" />
    </>,
    size,
  );
}

export function IconLayers({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M8 2.4 14 5.6 8 8.8 2 5.6Z" />
      <path d="M2.6 8.4 8 11.3l5.4-2.9" />
      <path d="M2.6 11 8 13.9 13.4 11" />
    </>,
    size,
  );
}

export function IconGauge({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M2.4 11.2a5.6 5.6 0 1 1 11.2 0" />
      <path d="M8 11.2 10.8 7" />
    </>,
    size,
  );
}

export function IconUser({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <circle cx="8" cy="6" r="2.4" />
      <path d="M3.4 13c.5-2.2 2.3-3.4 4.6-3.4S12.1 10.8 12.6 13" />
    </>,
    size,
  );
}

export function IconCheck({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M3.2 8.4 6.4 11.6 12.8 4.8" />
    </>,
    size,
  );
}

/** 轮次 / 步数（DSH 底部那行第一个图标） */
export function IconSteps({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M2.6 11.6h2.6v1.8H2.6zM6.7 8.6h2.6v4.8H6.7zM10.8 4.2h2.6v9.2h-2.6z" />
    </>,
    size,
  );
}

/** 累计用量（DSH 底部那个「文档 + 数字」） */
export function IconUsage({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <path d="M4 2.6h5.2L12.4 5.8v7.6H4z" />
      <path d="M9 2.8v3.2h3.2" />
      <path d="M6.2 9.2h4.4M6.2 11.2h3" />
    </>,
    size,
  );
}

/**
 * 设置齿轮（2026-11-09 取代左下角头像）。
 * 画法：外圈八齿 + 中心圆孔，用两条 path 描边 —— 不填色，跟其它图标一致走 stroke。
 */
export function IconSettings({ size = 16 }: IconProps): ReactElement {
  return svg(
    <>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </>,
    size,
  );
}
