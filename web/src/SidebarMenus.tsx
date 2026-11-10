import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';

import './new-parts.css';

/**
 * 左栏「工作区 / 项目」的右键菜单（置顶 / 重命名 / 归档 / 删除）。
 *
 * ★ 为什么用 portal 挂到 `document.body`：
 *   左栏是 `overflow-y: auto` 的滚动容器。菜单若留在树里，超出左栏矩形的那一截会被
 *   **裁掉**，还会被左栏的层叠上下文压住。portal 出去以后只要管自己的 `position: fixed`，
 *   与祖先的 overflow / z-index 全部无关（和 SessionMenu.tsx 同一套理由）。
 *
 * ★ 为什么要「先量再定位」：
 *   菜单宽高由文字与当前形态决定（菜单 / 重命名 / 删除确认三种形态高度不同），
 *   事前算不出来。所以首帧 `visibility: hidden` 放出去，`useLayoutEffect` 里量真实矩形，
 *   量完再决定往哪边翻 —— 不会先闪一下错位的菜单再跳回来。`mode` 变化时必须重量一再定位。
 *
 * ★ 为什么要「夹住视口」而不是只用 CSS max-height：
 *   `getBoundingClientRect()` 拿到的是**已经应用 max-height 之后**的高度，
 *   如果只写 CSS，测出来的永远是「没溢出」的假象，`top` 就不会往回收。
 *   这里用视口尺寸显式算出 `maxHeight` 再写进 style，量测与夹取用同一把尺子。
 *
 * ★ 删除为什么必须在菜单里二次确认：
 *   项目删除带「连共享目录文件一起删」的选项，这是**不可恢复**的。
 *   把它放在菜单里一屏说清后果，比先关菜单再弹一个没上下文的确认框可靠。
 */

export type SidebarMenuTarget =
  | { kind: 'workspace'; id: string; name: string; pinned: boolean }
  | { kind: 'project'; id: string; name: string; pinned: boolean; archived: boolean };

export type SidebarMenuProps = {
  target: SidebarMenuTarget;
  /** 视口坐标（clientX/clientY） */
  x: number;
  y: number;
  onClose: () => void;
  onPin: (nextPinned: boolean) => void;
  onRename: (nextName: string) => void;
  /** 只有 project 有；workspace 传了也不该显示这一项 */
  onArchive?: (nextArchived: boolean) => void;
  /** workspace：只删登记（不删磁盘）；project：deleteFiles 决定是否连共享目录一起删 */
  onDelete: (deleteFiles: boolean) => void;
  /** 删除/归档请求进行中，按钮要禁用并显示"处理中…" */
  busy?: boolean;
};

/** 菜单与视口边缘至少留这么多，否则阴影会贴到屏幕边上 */
const EDGE = 8;

/** 三种形态：普通菜单 / 就地重命名 / 删除二次确认 */
type MenuMode = 'menu' | 'rename' | 'delete';

type Position = { readonly left: number; readonly top: number; readonly maxHeight: number };

/** 把矩形塞回视口内；优先「整体翻到光标另一侧」，翻不下才硬夹 */
function placeAt(x: number, y: number, width: number, height: number): Position {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 宽高先夹到视口内 —— 否则「翻到光标左侧」也算不准
  const w = Math.min(width, Math.max(160, vw - EDGE * 2));
  const h = Math.min(height, Math.max(120, vh - EDGE * 2));

  let left = x;
  let top = y;

  // 先试光标右下（原生右键菜单的习惯位置）
  if (left + w + EDGE > vw) left = x - w;
  if (left < EDGE) left = Math.max(EDGE, vw - w - EDGE);

  if (top + h + EDGE > vh) top = y - h;
  if (top < EDGE) top = Math.max(EDGE, vh - h - EDGE);

  return { left, top, maxHeight: h };
}

export function SidebarMenu(props: SidebarMenuProps): ReactElement {
  const { target, x, y, onClose, onPin, onRename, onArchive, onDelete, busy = false } = props;

  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();

  const [mode, setMode] = useState<MenuMode>('menu');
  const [draftName, setDraftName] = useState(target.name);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  const project = target.kind === 'project' ? target : null;
  const noun = project === null ? '工作区' : '项目';
  const trimmedName = draftName.trim();

  /**
   * ★ onClose 走 ref 转发，不塞进 effect 依赖：
   *   父级的 onClose 通常是内联箭头函数，每次渲染都是新引用。放进依赖会让
   *   「点外面 / Esc / 滚动」三个监听来回重挂，而重挂那一瞬的点击就漏掉了。
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  /** Esc 要区分「还在菜单里」与「在子表单里」；用 ref 读最新形态，避免重挂监听 */
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // 换了一个目标（菜单被复用），一切回到初始形态
  useEffect(() => {
    setMode('menu');
    setDraftName(target.name);
    setDeleteFiles(false);
  }, [target.id, target.name]);

  // 量一次真实尺寸再定位。形态 / busy 变化都会改宽高，必须重量。
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const next = placeAt(x, y, rect.width, rect.height);
    setPosition((current) =>
      current !== null &&
      current.left === next.left &&
      current.top === next.top &&
      current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, [x, y, mode, busy]);

  // 关闭条件全在这里：点外面 / Esc / 滚动。卸载时统一摘监听。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const element = menuRef.current;
      if (element !== null && event.target instanceof Node && element.contains(event.target)) return;
      closeRef.current();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // 子表单里先退回菜单（重命名的「Esc 取消」就是这个），菜单里才真正关闭
      if (modeRef.current !== 'menu') {
        setMode('menu');
        return;
      }
      closeRef.current();
    };
    // 滚动就关：菜单是 fixed 的，不跟着内容滚，留着一定是「飘在原地」的错觉。
    // capture: true 才收得到内部滚动容器的 scroll —— 它不冒泡。
    const onScroll = (): void => {
      closeRef.current();
    };
    const onResize = (): void => {
      // 窗口尺寸变了，右/下边缘可能已经放不下：重新量一次（放在下一帧，等布局落定）
      const element = menuRef.current;
      if (element === null) return;
      const rect = element.getBoundingClientRect();
      setPosition(placeAt(x, y, rect.width, rect.height));
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [x, y]);

  // 焦点落点：菜单本体（普通形态）—— 键盘才有起点
  useEffect(() => {
    if (position === null || mode !== 'menu') return;
    menuRef.current?.focus({ preventScroll: true });
  }, [position, mode]);

  // 进入重命名：聚焦并全选，直接打字就能替换掉旧名字
  useEffect(() => {
    if (mode !== 'rename') return;
    const input = renameRef.current;
    if (input === null) return;
    input.focus({ preventScroll: true });
    input.select();
  }, [mode]);

  // 进入删除确认：焦点默认落在「取消」上，避免一个回车就把东西删了
  useEffect(() => {
    if (mode !== 'delete') return;
    cancelRef.current?.focus({ preventScroll: true });
  }, [mode]);

  const submitRename = useCallback((): void => {
    if (trimmedName.length === 0) return;
    // 名字没变就当作取消，不要白发一次请求
    if (trimmedName !== target.name) onRename(trimmedName);
    onClose();
  }, [onClose, onRename, target.name, trimmedName]);

  const submitDelete = useCallback((): void => {
    // 工作区永远不带 deleteFiles（只删登记，磁盘不动）
    onDelete(project === null ? false : deleteFiles);
  }, [deleteFiles, onDelete, project]);

  /** 上下键在**可点的按钮**之间移动焦点（子表单里也适用） */
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const active = document.activeElement;
    // 文本框里的上下键是光标 / 选值，不能抢
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    const element = menuRef.current;
    if (element === null) return;
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (buttons.length === 0) return;
    event.preventDefault();
    const at = buttons.findIndex((button) => button === active);
    const next =
      event.key === 'ArrowDown'
        ? buttons[(at + 1 + buttons.length) % buttons.length]
        : buttons[(at - 1 + buttons.length) % buttons.length];
    next?.focus({ preventScroll: true });
  }, []);

  const deleteLabel = busy ? '处理中…' : project === null ? '删除登记' : deleteFiles ? '永久删除' : '删除项目';

  const menu = (
    <div
      ref={menuRef}
      className="menu"
      role="menu"
      tabIndex={-1}
      aria-label={`${noun}操作：${target.name}`}
      aria-busy={busy}
      style={{
        left: position?.left ?? x,
        top: position?.top ?? y,
        maxHeight: position?.maxHeight,
        // 定位还没量出来时只隐藏、不隐藏排版（仍在文档里可量尺寸），避免闪一下错位
        visibility: position === null ? 'hidden' : 'visible',
      }}
      onKeyDown={onKeyDown}
      // 右键菜单里再右键：不该冒出浏览器原生菜单
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      <div className="menu-target" role="presentation" title={target.name}>
        {noun}·{target.name}
      </div>

      {mode === 'menu' ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={busy}
            aria-label={`${target.pinned ? '取消置顶' : '置顶'} ${target.name}`}
            onClick={() => {
              onPin(!target.pinned);
              onClose();
            }}
          >
            {target.pinned ? '取消置顶' : '置顶'}
          </button>

          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={busy}
            aria-label={`重命名 ${target.name}`}
            onClick={() => {
              setDraftName(target.name);
              setMode('rename');
            }}
          >
            重命名
          </button>

          {/* 只有项目才有归档；workspace 即使传了 onArchive 也不显示 */}
          {project !== null && onArchive !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={busy}
              aria-label={`${project.archived ? '取消归档' : '归档'} ${project.name}`}
              onClick={() => {
                // 归档要等服务端回执：菜单保持开着，busy 时这一项显示「处理中…」，
                // 成功与否由父级决定是否卸载菜单
                onArchive(!project.archived);
              }}
            >
              {busy ? '处理中…' : project.archived ? '取消归档' : '归档'}
            </button>
          ) : null}

          <div className="menu-sep" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="menu-item danger"
            disabled={busy}
            aria-label={`删除 ${noun} ${target.name}`}
            onClick={() => {
              setDeleteFiles(false);
              setMode('delete');
            }}
          >
            删除
          </button>
        </>
      ) : null}

      {mode === 'rename' ? (
        <form
          className="menu-form"
          aria-label={`重命名${noun}`}
          onSubmit={(event) => {
            event.preventDefault();
            submitRename();
          }}
        >
          <label className="menu-form-title" htmlFor={`${baseId}-rename`}>
            重命名{noun}
          </label>
          <input
            id={`${baseId}-rename`}
            ref={renameRef}
            className="menu-input"
            type="text"
            value={draftName}
            disabled={busy}
            aria-label={`新的${noun}名称`}
            onChange={(event) => {
              setDraftName(event.target.value);
            }}
            onKeyDown={(event) => {
              // Esc 由 document 上的监听统一处理成「退回菜单」，这里只需要挡掉冒泡带来的副作用
              if (event.key === 'Escape') {
                event.stopPropagation();
              }
            }}
          />
          <p className="menu-hint">留空不能提交。</p>
          <div className="menu-row">
            <button
              type="button"
              className="menu-btn"
              disabled={busy}
              onClick={() => {
                setMode('menu');
              }}
            >
              取消
            </button>
            <button type="submit" className="menu-btn primary" disabled={busy || trimmedName.length === 0}>
              确定
            </button>
          </div>
        </form>
      ) : null}

      {mode === 'delete' ? (
        <div className="menu-form" role="group" aria-label={`确认删除${noun}`}>
          <div className="menu-form-title">删除{noun}「{target.name}」？</div>

          {project === null ? (
            <>
              <p className="menu-warn">只删除登记，磁盘上的文件夹不会被删除。</p>
              <p className="menu-hint">之后可以重新登记这个目录。</p>
            </>
          ) : (
            <>
              <p className={`menu-warn${deleteFiles ? ' strong' : ''}`}>
                {deleteFiles
                  ? '项目登记和共享目录里的文件都会被删除。'
                  : '只删除项目登记；共享目录里的文件默认保留。'}
              </p>
              <label className="menu-check">
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
                <p className="menu-warn strong">共享目录里的文件将被永久删除，不可恢复。</p>
              ) : null}
            </>
          )}

          <div className="menu-row">
            <button
              ref={cancelRef}
              type="button"
              className="menu-btn"
              disabled={busy}
              onClick={() => {
                setMode('menu');
              }}
            >
              取消
            </button>
            <button type="button" className="menu-btn danger" disabled={busy} onClick={submitDelete}>
              {deleteLabel}
            </button>
          </div>
          {busy ? (
            <p className="menu-hint" role="status">
              正在处理请求，请稍候…
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return createPortal(menu, document.body);
}
