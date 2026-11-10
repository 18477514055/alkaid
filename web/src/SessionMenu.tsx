import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * 侧边栏会话的右键菜单。
 *
 * ★ 为什么用 portal 挂到 `document.body`：
 *   左栏是 `overflow-y: auto` 的滚动容器（`.conv-scroll`）。菜单若留在树里，
 *   超出左栏矩形的那一截会被**裁掉**，而且会被左栏的层叠上下文压住。
 *   portal 出去以后只需要管自己的 `position: fixed`，与祖先的 overflow / z-index 全部无关。
 *
 * ★ 为什么要「先量再定位」：
 *   菜单宽高由条目文字的像素宽度决定，事前算不出来。
 *   所以首帧按 `visibility: hidden` 放出去、`useLayoutEffect` 里量真实矩形，
 *   **量完再决定往哪边翻**——这样不会出现「先闪一下错位的菜单再跳回来」。
 */

export type SessionMenuItem = {
  key: string;
  label: string;
  /** 危险操作（删除等）—— 只染字色，不做红底：右键菜单里红块太吵 */
  danger?: boolean;
  /** 分隔线：占一个位置便于排版，但**不可点、不参与键盘循环** */
  divider?: boolean;
};

export type SessionMenuProps = {
  /** 鼠标位置（clientX / clientY） */
  x: number;
  y: number;
  items: SessionMenuItem[];
  onPick: (key: string) => void;
  onClose: () => void;
};

/** 菜单与视口边缘至少留这么多，否则阴影会贴到屏幕上沿 */
const EDGE = 8;

type Position = { left: number; top: number };

/** 把矩形塞回视口内；优先「整体翻到光标另一侧」，翻不下才硬夹 */
function placeAt(x: number, y: number, width: number, height: number): Position {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 先试光标右下（原生右键菜单的习惯位置）
  let left = x;
  let top = y;

  // 右边放不下 → 翻到光标左侧；左侧也放不下就贴右边缘
  if (left + width + EDGE > vw) left = x - width;
  if (left < EDGE) left = Math.max(EDGE, vw - width - EDGE);

  if (top + height + EDGE > vh) top = y - height;
  if (top < EDGE) top = Math.max(EDGE, vh - height - EDGE);

  return { left, top };
}

export function SessionMenu({ x, y, items, onPick, onClose }: SessionMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  /** 键盘高亮项：存的是 items 里的**下标**，不是条目 key（key 可能重复） */
  const [active, setActive] = useState<number>(-1);

  /**
   * ★ 用 ref 转发 onClose，而不是把它塞进 effect 的依赖：
   *   onClose 通常是父级内联箭头函数，每次父级渲染都是新引用。
   *   放进依赖会让**监听起来回重挂**（流式输出时父级每秒重渲染好几次），
   *   而在「重新挂载监听」的那一瞬发生的点击就会漏掉。
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  /** 可选中项（跳过分隔线），给键盘循环用 */
  const selectable = items.map((item, index) => ({ item, index })).filter(({ item }) => item.divider !== true);

  // 量一次真实尺寸再定位。依赖 items 长度：条目变了（菜单被复用）要重新量高度。
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const next = placeAt(x, y, rect.width, rect.height);
    setPosition((current) =>
      current !== null && current.left === next.left && current.top === next.top ? current : next,
    );
  }, [x, y, items.length]);

  /**
   * 自动聚焦菜单本体，键盘才有落点。
   * ★ 必须等 `position` 落地之后再聚焦 —— 首帧为了量尺寸是 `visibility: hidden`，
   *   而**隐藏元素在 Chrome 里不可聚焦**，那时调 `focus()` 是静默失败的。
   *   实测过：不挂这个依赖的话 `document.activeElement` 会停在上一个按钮上。
   */
  useEffect(() => {
    if (position === null) return;
    menuRef.current?.focus({ preventScroll: true });
  }, [position]);

  // 关闭条件全在这里：点外面 / Esc / 滚动。卸载时统一摘监听。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const element = menuRef.current;
      if (element !== null && event.target instanceof Node && element.contains(event.target)) return;
      closeRef.current();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
    };
    // 滚动就关：菜单是 fixed 的，不跟着内容滚，留着一定是"飘在原地"的错觉。
    // capture: true 才收得到内部滚动容器（.conv-scroll）的 scroll —— 它不冒泡。
    const onScroll = (): void => {
      closeRef.current();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  const pick = useCallback(
    (key: string): void => {
      onPick(key);
      onClose();
    },
    [onPick, onClose],
  );

  const move = useCallback(
    (delta: number): void => {
      if (selectable.length === 0) return;
      setActive((current) => {
        const at = selectable.findIndex((entry) => entry.index === current);
        const from = at === -1 ? (delta > 0 ? -1 : 0) : at;
        // 首尾环绕：菜单条目很少，绕回去比"顶住不动"好用
        const next = (from + delta + selectable.length) % selectable.length;
        return selectable[next]?.index ?? -1;
      });
    },
    [selectable],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        const item = items[active];
        if (item === undefined || item.divider === true) return;
        event.preventDefault();
        pick(item.key);
      }
    },
    [active, items, move, pick],
  );

  const menu = (
    <div
      ref={menuRef}
      className="session-menu"
      role="menu"
      tabIndex={-1}
      aria-label="会话操作"
      // 定位还没量出来时只隐藏不隐藏排版（仍在文档里可量尺寸），避免闪一下错位
      style={{
        left: position?.left ?? x,
        top: position?.top ?? y,
        visibility: position === null ? 'hidden' : 'visible',
      }}
      onKeyDown={onKeyDown}
      // 右键菜单里再右键：不该冒出浏览器原生菜单
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      {items.map((item, index) =>
        item.divider === true ? (
          <div key={`divider-${String(index)}`} className="session-menu-sep" role="separator" />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`session-menu-item ${item.danger === true ? 'danger' : ''} ${
              index === active ? 'active' : ''
            }`}
            // 鼠标移进去就同步高亮，否则键盘高亮会停在别处，看着有两个焦点
            onPointerEnter={() => {
              setActive(index);
            }}
            onClick={() => {
              pick(item.key);
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );

  return createPortal(menu, document.body);
}
