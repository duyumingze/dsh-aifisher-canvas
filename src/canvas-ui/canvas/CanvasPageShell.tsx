/**
 * 页面层外壳（v1.84）：项目库 / 设置共用的一块玻璃。
 *
 * 设计稿 pages/shell.css 的「顶栏 54 + 页面底 + 统一圆角/强调色」那一套，落成一个组件：
 * 两屏只写自己的主体（左栏 + 主区 / 左导航 + 分组表单），顶栏、返回、关闭、Esc、铺满
 * 画布容器这几件事都在这。
 *
 * 为什么 portal 到 `.af-canvas-mount` 而不是塞进 vendor 的 React 树：
 *   与 v1.82 图片编辑台、v1.83 整页扩图同一条结论（见 CanvasOutpaintStudio 文件头）——
 *   画布 viewport 带 transform，`fixed inset-0` 会被困住、量出来不是窗口尺寸。
 *   这里按 `useCanvasOverlayBox()` 量出来的画布矩形铺满，于是页面严丝合缝盖住画布，
 *   不越到 DSH 的侧边栏上。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）——产物里 React 有两份副本。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import { createPortal } from 'react-dom';
import { ArrowLeft as ArrowLeftIcon, ChevronRight as ChevronRightIcon, X as XIcon } from 'lucide-react';

import { canvasPortalTarget } from '@/lib/portal';
import { WORKBENCH_ROOT_CLASS } from './imageWorkbench';
import { useCanvasOverlayBox } from './imageWorkbenchOverlay';
import { closeCanvasPage } from './CanvasPagesStore';

type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'useRef' | 'useEffect' | 'useState' | 'useCallback'
>;

export interface CanvasPageShellProps {
  /** 页面身份（也是 `data-fisherai-page` 的取值）。 */
  id: 'projects' | 'settings';
  /** 顶栏标题（项目库 / 设置）。 */
  title: string;
  /** 标题右边那个计数徽标（项目个数 / 分组数）。 */
  count?: string;
  /** 顶栏中间（项目库：搜索框；设置：无）。 */
  center?: unknown;
  /** 顶栏右侧（按钮组）；关闭按钮由外壳统一追加。 */
  right?: unknown;
  /**
   * 这一屏关掉之后能不能露出画布（v1.85）。
   *
   * 项目库在「还没打开任何项目」时就是画布的首屏 —— 底下是 vendor 那张旧看板
   * （用户 2026-10-31：「移除旧版设置与画布项目管理」），关掉它等于把旧界面翻出来。
   * 所以这种时候外壳不给返回/关闭，也不吃 Esc：只能点项目进去，或者用 DSH 右下角
   * 那个「退出画布」退出整个画布。
   */
  dismissible?: boolean;
  /** 根节点附加类名（`afp-root` / `afs-root`）。 */
  rootClass: string;
  children?: unknown;
}

export function CanvasPageShell(react: Runtime, props: CanvasPageShellProps) {
  const h = createElement(react);
  const overlay = useCanvasOverlayBox(react);
  const rootRef = react.useRef<HTMLDivElement | null>(null);
  const close = react.useCallback(() => closeCanvasPage(), []);
  const dismissible = props.dismissible !== false;

  // Esc 关闭 + 打开即聚焦：页面是整块接管型浮层，键盘用户不能只靠鼠标关。
  react.useEffect(() => {
    /**
     * 页面开着时把画布那几块「画在容器外面的固定 chrome」藏掉（v1.84）。
     *
     * 为什么非藏不可：缩放条 / 快捷键钮 / 界面缩放胶囊 / 小地图 / 任务队列 / 副驾与分镜胶囊
     * 都按**视口**贴边定位（bottom-6 / bottom-24），而页面只盖住画布容器的矩形
     * （实测 1182×804，比视口矮一截）—— 不藏的话它们会从页面下缘戳出来，看着像页面没盖全
     * （v1.83 整页扩图也有同样的尾巴，当时没管；两屏页面面积更大，必须处理）。
     */
    document.documentElement.classList.add('afg-page-open');
    const onKeyDown = (event: KeyboardEvent) => {
      if (!dismissible) return;
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    const timer = window.setTimeout(() => {
      try {
        rootRef.current?.focus({ preventScroll: true });
      } catch {
        /* jsdom / 老浏览器：focus 带参数不支持，忽略 */
      }
    }, 0);
    return () => {
      document.documentElement.classList.remove('afg-page-open');
      window.removeEventListener('keydown', onKeyDown, true);
      window.clearTimeout(timer);
    };
  }, [close, dismissible]);

  const topbar = h(
    'header',
    { className: 'afg-top', 'data-fisherai-page-top': 'true' },
    h(
      'div',
      { className: 'afg-crumbs' },
      dismissible
        ? h(
            'button',
            {
              type: 'button',
              'aria-label': '返回画布',
              title: '返回画布（Esc）',
              'data-fisherai-page-back': 'true',
              className: 'afg-back',
              onClick: close,
            },
            h(ArrowLeftIcon, {}),
          )
        : null,
      h('span', { className: 'afg-crumb-sep' }),
      h('span', { className: 'afg-crumb-root' }, '画布'),
      h(ChevronRightIcon, { style: { width: 12, height: 12 }, className: 'afg-dim' }),
      h('span', { className: 'afg-crumb-title' }, props.title),
      props.count ? h('span', { className: 'afg-crumb-count' }, props.count) : null,
    ),
    props.center ? h('div', { className: 'afg-top-center' }, props.center) : null,
    h(
      'div',
      { className: 'afg-top-right' },
      props.right ?? null,
      dismissible
        ? h(
            'button',
            {
              type: 'button',
              'aria-label': `关闭${props.title}`,
              title: '关闭（Esc）',
              'data-fisherai-page-close': 'true',
              className: 'afg-iconbtn',
              onClick: close,
            },
            h(XIcon, {}),
          )
        : null,
    ),
  );

  const root = h(
    'div',
    {
      ref: rootRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': props.title,
      'data-fisherai-page': props.id,
      tabIndex: -1,
      style: {
        left: overlay.left,
        top: overlay.top,
        width: overlay.width,
        height: overlay.height,
        outline: 'none',
      },
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      onContextMenu: (event: ReactTypes.MouseEvent) => event.preventDefault(),
      className: `${WORKBENCH_ROOT_CLASS} afg-root ${props.rootClass}`,
    },
    h('div', { className: 'afg-bg' }),
    topbar,
    props.children,
  );

  const target = canvasPortalTarget();
  return target ? (createPortal(root, target) as ReactTypes.ReactNode) : root;
}

/**
 * 外壳的**组件形式**（页面用它，不要直接调 `CanvasPageShell`）。
 *
 * 为什么必须有这一层：`CanvasPageShell` 内部要用 hooks（量画布矩形、Esc 监听）。
 * 页面组件在「没打开」时会 `return null`，如果打开时直接调它，同一个组件的 hooks
 * 数量就会从 N 变成 N+k —— React 19 直接报 #310（Rendered more hooks than during
 * the previous render），整块画布被 error boundary 接住。包成一个稳定的组件后，
 * 它的 hooks 属于它自己，页面开没开都不影响上面的计数。
 */
export interface CanvasPageShellViewProps extends CanvasPageShellProps {
  runtime: Runtime;
}

export function CanvasPageShellView(props: CanvasPageShellViewProps) {
  const { runtime, ...rest } = props;
  return CanvasPageShell(runtime, rest) as ReactTypes.ReactElement;
}
