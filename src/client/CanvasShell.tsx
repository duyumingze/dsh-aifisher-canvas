/**
 * CanvasShell —— 无限画布面板的外壳（画布 + 右侧 DSH 原生会话栏）。
 *
 * 用户拍板（2026-10-16）：「画布里的对话面板换成 DSH 原生会话区」。
 *
 * ## 布局
 *
 *   main 槽位 key=aifisher-canvas
 *     └─ CanvasShell（本文件）
 *          ├─ 左：CanvasPanel（vendor 画布，React 19 独立 root）
 *          └─ 右：会话栏（可拖宽 / 可收起）
 *               └─ renderSlot('aifisher-canvas.chat')  ← 宿主按 session-maybe 绑定「当前会话」
 *                    └─ CanvasChatDock：renderFactorySlot('conversation.content', {variant:'embedded'})
 *
 * 为什么会话栏要做成**子槽位**而不是直接在本文件里渲染会话：`main` 槽位的 scope 是 `root`，
 * 条目只拿到全局标准 props（没有 sessionId / useSession）——DSH 的槽位文档原话是
 * 「reserved `conversation` key hosts the Conversation; other keys receive no Session binding」。
 * 而子槽位可以声明成 `scope: 'session-maybe'`，条目就会拿到内核的会话标准 props
 * （这正是 ui-conversation 用 `main.conversation` 做的同一件事）。
 *
 * ## 拖宽 / 收起的存储
 *
 * localStorage（`dsh-aifisher-canvas.chatDock.*`）：宽度与开合都是「这台机器上的偏好」，
 * 不进画布数据目录（那是项目数据，换项目不该带走侧栏宽度）。读取一律 try/catch + 夹取，
 * 坏数据不该让面板渲染不出来。
 *
 * 只用 React.createElement、不写 JSX（产物只从模块表要 `react`）。
 */
import * as React from 'react';

import { CanvasPanel } from './CanvasPanel';
import { CANVAS_CHAT_SLOT } from './CanvasChatDock';

/** 右侧会话栏的宽度偏好键。 */
const WIDTH_KEY = 'dsh-aifisher-canvas.chatDock.width';
/** 右侧会话栏开合偏好键。 */
const OPEN_KEY = 'dsh-aifisher-canvas.chatDock.open';

/** 宽度兜底与上下限：太窄会话没法用，太宽画布没法用。 */
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 300;
const MAX_WIDTH = 860;
/** 收起状态留下的竖条宽度（点它可以再展开）。 */
const RAIL_WIDTH = 34;

/**
 * 压掉 vendor 自带的对话面板与启动球（上游 `canvasAgentPanel` / `CanvasAgentLauncher`）。
 *
 * 为什么用 CSS 而不是改 vendor：这两个元素是上游 `CanvasSidePanels` 按 `isChatOpen` 渲的，
 * 而「画布内对话」整块的后端（/chat/stream 等）我们保留着、以后可能还想开；在这里只做
 * 「默认看不见」，vendor 树一个字不用动（vendor 是每次构建重新生成的，少一处覆盖少一处漂移）。
 * 元素都挂在本面板容器内（vendor 补丁 3.7 已把它们的 fixed 改成 absolute），所以作用域选择器能兜住。
 */
const SUPPRESS_VENDOR_AGENT_CSS = [
  '[data-dsh-aifisher-canvas="shell"] [data-fisherai-agent-launcher],',
  '[data-dsh-aifisher-canvas="shell"] [data-fisherai-agent-panel] {',
  '  display: none !important;',
  '}',
].join('\n');

function clampWidth(value: unknown): number {
  // 先挡住「没存过」这几种：`Number(null) === 0`、`Number('') === 0` 都是有限数，
  // 直接往下走会被当成「用户把宽度拖到了 0」→ 夹成 MIN_WIDTH（真机踩过：默认宽度变成 300 而不是 420）。
  if (value === null || value === undefined || value === '') return DEFAULT_WIDTH;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(numeric)));
}

function readStoredWidth(): number {
  try {
    return clampWidth(window.localStorage.getItem(WIDTH_KEY));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function readStoredOpen(): boolean {
  try {
    // 缺省 = 展开：用户要的就是「画布右边有会话」。
    return window.localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式/配额满：偏好存不下不该影响使用 */
  }
}

export interface CanvasShellProps {
  /** 退出面板（回 DSH 对话）；由 apply.ts 接 ctx.layout.selectPanel(null)。 */
  onExit?: () => void;
  /**
   * 子槽位渲染器：apply.ts 在注册 `main` 条目时声明了 children，
   * 宿主于是会把 `renderSlot` 放进标准 props（宿主没给时右栏退化成提示）。
   */
  renderSlot?: (key: string, ownerProps?: Record<string, unknown>) => React.ReactNode;
}

const SHELL_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  background: '#0e0f13',
};

const CANVAS_AREA_STYLE: React.CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minWidth: 0,
  height: '100%',
  overflow: 'hidden',
};

const DOCK_COLUMN_STYLE: React.CSSProperties = {
  position: 'relative',
  flex: '0 0 auto',
  height: '100%',
  minWidth: 0,
  overflow: 'hidden',
  borderLeft: '1px solid rgba(255,255,255,0.08)',
};

const RAIL_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  width: RAIL_WIDTH,
  height: '100%',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: 10,
  borderLeft: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(23,24,28,0.6)',
};

const RAIL_BUTTON_STYLE: React.CSSProperties = {
  width: 22,
  height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'transparent',
  color: '#a8adb8',
  cursor: 'pointer',
};

const HANDLE_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  width: 5,
  height: '100%',
  cursor: 'col-resize',
  background: 'transparent',
};

/** 收起态：一条窄竖条，点箭头展开。 */
function CollapsedRail({ onOpen }: { onOpen: () => void }) {
  return React.createElement(
    'div',
    { 'data-dsh-aifisher-canvas': 'chat-rail', style: RAIL_STYLE },
    React.createElement(
      'button',
      {
        type: 'button',
        'data-dsh-aifisher-chat': 'expand',
        'aria-label': '展开会话栏',
        title: '展开 DSH 会话栏',
        onClick: onOpen,
        style: RAIL_BUTTON_STYLE,
      },
      React.createElement(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        React.createElement('path', { d: 'M10 3.5 5.5 8l4.5 4.5' }),
      ),
    ),
  );
}

export function CanvasShell({ onExit, renderSlot }: CanvasShellProps = {}) {
  const [open, setOpen] = React.useState<boolean>(() => readStoredOpen());
  const [width, setWidth] = React.useState<number>(() => readStoredWidth());
  // 拖拽起点（指针捕获期间的基准）：用 ref 存，避免 pointermove 里读到旧 state。
  const drag = React.useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const setOpenPersisted = React.useCallback((next: boolean) => {
    setOpen(next);
    writeStorage(OPEN_KEY, next ? '1' : '0');
  }, []);

  const onHandlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
      // jsdom 没有指针捕获；真浏览器里捕获住，拖到 canvas 上也不丢事件。
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        /* 捕获不可用（jsdom / 老浏览器）：靠 pointermove 继续，最多丢到元素外的那一段 */
      }
      event.preventDefault();
    },
    [width],
  );

  const onHandlePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    // 手柄在右栏左缘：指针往左 = 右栏变宽。
    setWidth(clampWidth(current.startWidth + (current.startX - event.clientX)));
  }, []);

  const onHandlePointerUp = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* 同上 */
    }
    writeStorage(WIDTH_KEY, String(width));
  }, [width]);

  const chatColumn =
    open && typeof renderSlot === 'function'
      ? React.createElement(
          React.Fragment,
          null,
          React.createElement('div', {
            'data-dsh-aifisher-canvas': 'chat-handle',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': '拖动调整会话栏宽度',
            style: HANDLE_STYLE,
            onPointerDown: onHandlePointerDown,
            onPointerMove: onHandlePointerMove,
            onPointerUp: onHandlePointerUp,
            onPointerCancel: onHandlePointerUp,
          }),
          React.createElement(
            'div',
            {
              'data-dsh-aifisher-canvas': 'chat-column',
              style: { ...DOCK_COLUMN_STYLE, width },
            },
            renderSlot(CANVAS_CHAT_SLOT, { onClose: () => setOpenPersisted(false) }),
          ),
        )
      : null;

  return React.createElement(
    'div',
    { 'data-dsh-aifisher-canvas': 'shell', style: SHELL_STYLE },
    React.createElement('style', { 'data-dsh-aifisher-canvas': 'agent-suppress' }, SUPPRESS_VENDOR_AGENT_CSS),
    React.createElement(
      'div',
      { 'data-dsh-aifisher-canvas': 'canvas-area', style: CANVAS_AREA_STYLE },
      // CanvasPanel 的 props 参数带默认值，createElement 推不出 P（详见
      // src/canvas-ui/lib/react.ts 的 createElement 注释）；这里显式给 P。
      React.createElement<{ onExit?: () => void }>(CanvasPanel, { onExit }),
    ),
    chatColumn,
    open ? null : React.createElement(CollapsedRail, { onOpen: () => setOpenPersisted(true) }),
  );
}
