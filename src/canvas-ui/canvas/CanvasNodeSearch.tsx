/**
 * 画布「节点搜索」面板（仿 Blender 的 Shift+A 搜索）。
 *
 * 交互：画布视图里按 **Shift+A** → 面板出现在鼠标旁边（贴着鼠标、自动避开画布边缘），
 * 输入即模糊过滤，↑/↓ 选，Enter 建节点，Esc 关闭；点选也行。
 * 候选 = **画布节点类型**（文本/图像/视频/音频/ComfyUI 工作流/图片对比/图片拼合）
 *      + **ComfyUI 工作流**（本地 workflows 目录里每一个都能直接搜到）。
 *
 * 为什么是「派发事件」而不是直接 setNodes：
 *   本组件在 src/canvas-ui 里，拿不到画布的 node store（它在 vendor 的 useCanvasNodes 里）。
 *   画布侧已有同一个形状的先例（`fisherai:add-workflow-node` 由 vendor 的
 *   canvasNodeState.attachWorkflowNodeEvents 直接写 store），所以这里沿用「window 事件」，
 *   vendor 侧只需在同一个监听器集合里多一条 `fisherai:add-canvas-node`（见
 *   scripts/vendor-aifisher.mjs 的 3.8f 段）。好处：不动 vendor 的依赖契约（Dependencies），
 *   上游升级不会因为多了一个必填依赖而整体崩。
 *
 * 结构契约（回归依赖，改前先看 docs/canvas-ui-shadcn.md）：
 *   - 面板根 `role="dialog"` + `aria-label="搜索节点"` + `data-fisherai-node-search-panel`；
 *   - 输入框 `aria-label="搜索节点"` + `data-fisherai-node-search-input`（真机检查靠它找输入框）；
 *   - 候选行 `role="option"` + `data-fisherai-node-search-item` + `data-command-id`；
 *   - 工具栏里的入口按钮 `aria-label="搜索节点"` + `data-fisherai-node-search-trigger`。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数），不要用本文件 import 的那份 ——
 *    产物里 React 有两份副本，用错那分量 React 19 不报错也不渲染（整条控制条会消失）。
 */
import * as ReactTypes from 'react';
import { createPortal } from 'react-dom';
import {
  ImagePlusIcon,
  LayersIcon,
  MusicIcon,
  SearchIcon,
  SquareDashedIcon,
  SquareStackIcon,
  TypeIcon,
  VideoIcon,
  WorkflowIcon,
} from 'lucide-react';

import { Input } from '@/ui/input';
import { Kbd } from '@/ui/kbd';
import { ScrollArea } from '@/ui/scroll-area';
import { cn } from '@/lib/utils';
import { canvasPortalTarget } from '@/lib/portal';
import {
  localWorkflowDefinitions,
  localWorkflowOptions,
  subscribeLocalWorkflows,
} from '../../../vendor/aifisher/src/stable/media/videoWorkflows';
import {
  buildNodeSearchCatalog,
  rankNodeSearch,
  type CanvasNodeSearchEntry,
} from './CanvasNodeSearchRank';
import {
  nodeSearchRequestSnapshot,
  subscribeCanvasNodeSearchRequest,
} from './CanvasNodeSearchStore';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'Fragment'
  | 'useState'
  | 'useRef'
  | 'useEffect'
  | 'useSyncExternalStore'
  | 'useMemo'
  | 'useCallback'
  | 'useLayoutEffect'
>;

interface Props {
  view: string;
  viewport: { x: number; y: number; zoom: number };
  canvasRef?: ReactTypes.RefObject<HTMLElement | null>;
  /** 面板根绝对定位的包含块（画布容器）。缺省时回落到 document.body。 */
  containerRef?: ReactTypes.RefObject<HTMLElement | null>;
}

const PANEL_WIDTH = 380;
const PANEL_MARGIN = 12;
/** 估算高度用于「鼠标靠近底部时往上翻」；真实高度由 CSS 上限兜住。 */
const PANEL_ESTIMATED_HEIGHT = 360;

const ENTRY_ICONS: Record<string, unknown> = {
  Text: TypeIcon,
  Image: ImagePlusIcon,
  Video: VideoIcon,
  Audio: MusicIcon,
  'Image Compare': SquareStackIcon,
  'Image Composite': LayersIcon,
  ComfyUI: WorkflowIcon,
};

interface PanelPlacement {
  left: number;
  top: number;
  width: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 视口坐标 → 画布世界坐标。
 *
 * 「屏幕 → 世界」的映射就是 `#canvas-viewport-content` 上的 transform：
 * `translate3d(viewport.x, viewport.y, 0) scale(viewport.zoom)`，它的原点是**画布面板左上角**；
 * 而视口坐标的原点是窗口左上角，两者差一个 `canvasOrigin`（画布面板的视口位置）。
 */
function toWorldPoint(
  viewportX: number,
  viewportY: number,
  viewport: Props['viewport'],
  canvasOrigin: { left: number; top: number },
) {
  const zoom = Number.isFinite(viewport?.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const x = (viewportX - canvasOrigin.left - (viewport?.x ?? 0)) / zoom;
  const y = (viewportY - canvasOrigin.top - (viewport?.y ?? 0)) / zoom;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/** 画布面板左上角在视口里的位置（`#canvas-background` 就是那个盒子）。 */
function canvasOrigin(): { left: number; top: number } {
  const rect = document.getElementById('canvas-background')?.getBoundingClientRect();
  return rect ? { left: rect.left, top: rect.top } : { left: 0, top: 0 };
}

/**
 * 算出面板该放在哪儿（left/top 是**视口坐标**，因为面板根用 `position: fixed`）。
 *
 * 两种输入：
 *   ① `point = {x,y}`：鼠标的视口坐标 → 面板贴在光标右下，超出画布时夹进画布范围；
 *   ② `point = undefined`：没有鼠标位置（工具栏按钮点的），落在画布正中。
 * 画布量到 0×0（jsdom / 极窄容器）时退回窗口尺寸，仍能给出一个合法位置。
 * 夹取范围用的是**画布面板**的 rect（不是窗口）：面板始终待在画布那一块里，
 * 不会飘到 DSH 侧边栏上面去。
 */
function panelPlacement(
  point: { x: number; y: number } | undefined,
  container: HTMLElement | null,
): PanelPlacement {
  const origin = canvasOrigin();
  const canvasRect = container?.getBoundingClientRect();
  const width = canvasRect && canvasRect.width > 0 ? canvasRect.width : window.innerWidth;
  const height = canvasRect && canvasRect.height > 0 ? canvasRect.height : window.innerHeight;
  const left0 = point ? point.x : origin.left + width / 2;
  const top0 = point ? point.y : origin.top + height / 2;
  const minLeft = origin.left + PANEL_MARGIN;
  const maxLeft = Math.max(minLeft, origin.left + width - PANEL_WIDTH - PANEL_MARGIN);
  const minTop = origin.top + PANEL_MARGIN;
  const maxTop = Math.max(minTop, origin.top + height - PANEL_ESTIMATED_HEIGHT - PANEL_MARGIN);
  return {
    left: clamp(left0, minLeft, maxLeft),
    top: clamp(top0, minTop, maxTop),
    width: Math.min(PANEL_WIDTH, Math.max(240, width - PANEL_MARGIN * 2)),
  };
}

function isTextEditor(element: unknown): boolean {
  // 必须挡住非 Element（document.activeElement 在极端情况下不是 Element，
  // 而 `closest` 只在 Element 上存在 —— 直接调会抛「e?.closest is not a function」）
  if (!element || typeof (element as Element).closest !== 'function') return false;
  return Boolean((element as Element).closest('input,textarea,select,[contenteditable]'));
}

/**
 * 画布上最后一次鼠标位置（模块级，**故意不用 useRef**），坐标系是**视口坐标**
 * （`clientX + window.scrollX`）—— 面板根用 `position: fixed` 也是视口坐标，
 * 两者同一个原点，不需要去猜「最近的定位祖先是谁」。
 *
 * 为什么这么在意这个原点（踩了一整轮）：面板根早先是 `absolute`，坐标是「包含块局部坐标」。
 * 那个包含块在不同页面里可能是画布容器、也可能是底盘，量错了面板就贴在画布左缘不动
 * （现象：Shift+A 面板出来了，但不跟着鼠标，节点却落在光标处 —— 因为节点走的是另一条换算）。
 * 改成 fixed + 视口坐标之后，引用系唯一，量与算都不依赖 DOM 层级。
 *
 * 为什么不能放组件里：`props.canvasRef` 每次渲染都是新对象字面量，把它写进 effect 依赖会让
 * effect 反复「清理→重装」，而清理里顺手把指针清空 —— 于是「先 Shift+A 建一个节点、再按
 * Shift+A 建第二个」时，第二次按键读到的指针是空的，节点没有落点、画布静默不建节点。
 * 模块级的指针与组件生命周期无关，正好符合「鼠标还在画布上」这个事实。
 */
let lastCanvasPointer: { x: number; y: number } | undefined;

export function CanvasNodeSearch(react: Runtime, props: Props) {
  const h = react.createElement;
  // 每次点「搜索节点」按钮都换一个 key，强制重建（状态归零、输入框自动聚焦）。
  const [session, setSession] = react.useState(0);
  const [open, setOpen] = react.useState(false);
  const [query, setQuery] = react.useState('');
  const [activeIndex, setActiveIndex] = react.useState(0);
  const [placement, setPlacement] = react.useState<PanelPlacement>(() =>
    panelPlacement(undefined, null),
  );
  /** 开面板那一刻鼠标位置换算出来的世界坐标（节点落点）。 */
  const pointRef = react.useRef<{ x: number; y: number } | undefined>(undefined);

  const [definitionsEpoch, setDefinitionsEpoch] = react.useState(0);
  // 工作流清单是异步拉回来的（装配层 ensureLocalWorkflows）；到位后重排候选列表。
  react.useEffect(() => subscribeLocalWorkflows(() => setDefinitionsEpoch((value) => value + 1)), []);

  const catalog = react.useMemo(
    () => buildNodeSearchCatalog(localWorkflowOptions(), localWorkflowDefinitions()),
    [definitionsEpoch, open],
  );
  const results = react.useMemo(() => rankNodeSearch(query, catalog, 60), [query, catalog]);
  // 注意：results 的每一项是 `{ entry, score, hits }`，不是 entry 本身（踩过：写成 results[i] 之后
  // Enter 建节点会派发一个没有 type 的事件，表现成「面板能开、点了不建节点」，还不报错）。
  const activeResult = results[Math.min(activeIndex, Math.max(0, results.length - 1))];
  const active = activeResult?.entry;

  const close = react.useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }, []);

  /**
   * 记录鼠标位置（视口坐标；Shift+A 时用它决定面板位置与节点落点）。
   *
   * 监听器装在 document 上并只认画布范围内的事件（`#canvas-background`）：
   * 画布的 ref 在挂载那一帧还是 null（React 先渲染再赋 ref，RefObject 变化又不触发重渲染），
   * 在 ref 上装监听器会永远装不上。
   */
  react.useEffect(() => {
    const track = (event: PointerEvent) => {
      /**
       * 「鼠标在不在画布里」的判定：优先用**画布挂载容器**的 rect（`#canvas-background` 是底盘，
       * 在某些页面里量到 0×0 —— headless Chromium 实测，用它判定会把所有事件都滤掉）。
       * 量不到尺寸时（jsdom 没有布局引擎）不筛：那时 rect 全是 0，按 rect 做的换算仍然是自洽的，
       * 滤掉反而会让指针永远为空、面板只能回落到居中。
       */
      const containerRect = document.querySelector('.af-canvas-mount')?.getBoundingClientRect();
      const bounds =
        containerRect && containerRect.width > 0 && containerRect.height > 0
          ? containerRect
          : props.canvasRef?.current?.getBoundingClientRect();
      const measurable = !!bounds && bounds.width > 0 && bounds.height > 0;
      const x = event.clientX;
      const y = event.clientY;
      if (measurable && bounds) {
        if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
      }
      lastCanvasPointer = { x: x + window.scrollX, y: y + window.scrollY };
    };
    document.addEventListener('pointermove', track, { passive: true });
    return () => document.removeEventListener('pointermove', track);
  }, [props.canvasRef]);

  const inputRef = react.useRef<HTMLInputElement | null>(null);
  const panelRef = react.useRef<HTMLDivElement | null>(null);
  // 面板刚打开时聚焦输入框（用 ref 回填，避免额外一次渲染）。
  react.useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, session]);

  /** 点面板外面就关闭（与画布右键菜单同一个交互习惯）。 */
  react.useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      // 工具条上的「搜索节点」按钮自己有 onClick，让它走自己的路（不然会关掉又立刻打开）
      if (target instanceof Element && target.closest('[data-fisherai-node-search-trigger]')) return;
      close();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, close]);

  /**
   * 打开面板。
   * - 不带参数（Shift+A）：用画布上最后一次鼠标位置 —— 面板贴着光标、节点也落在那儿；
   * - `center = true`（工具栏按钮）：忽略鼠标位置，面板落在画布正中（按钮离鼠标很远，
   *   贴光标反而会出现在没预期的角落）。
   */
  const openAt = react.useCallback(
    (center = false) => {
      const target = center ? undefined : lastCanvasPointer;
      pointRef.current = target
        ? toWorldPoint(target.x, target.y, props.viewport, canvasOrigin())
        : undefined;
      setPlacement(panelPlacement(target, props.containerRef?.current ?? null));
      setQuery('');
      setActiveIndex(0);
      setSession((value) => value + 1);
      setOpen(true);
      // 画布的右键菜单若正开着，先关掉（否则两层浮层叠在一起）
      window.dispatchEvent(new CustomEvent('fisherai:close-canvas-menu'));
    },
    [props.containerRef, props.viewport],
  );

  /** Shift+A：打开搜索面板（Blender 的「添加 → 搜索」）。 */
  react.useEffect(() => {
    if (props.view !== 'canvas') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key !== 'a' && event.key !== 'A') return;
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTextEditor(document.activeElement) || isTextEditor(event.target)) return;
      event.preventDefault();
      openAt();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.view, openAt]);

  /**
   * 工具栏「搜索节点」按钮：面板落在画布正中。
   * 请求走 src/canvas-ui/canvas/CanvasNodeSearchStore.ts 那个小 store（按钮在侧边栏槽位、
   * 面板在缩放控件槽位，靠 vendor 的注入契约传运行时值传不过来）。
   */
  const openRequestValue = react.useSyncExternalStore(
    subscribeCanvasNodeSearchRequest,
    nodeSearchRequestSnapshot,
  );
  react.useEffect(() => {
    if (!openRequestValue) return;
    openAt(true);
  }, [openRequestValue, openAt]);

  const commit = react.useCallback(
    (entry: CanvasNodeSearchEntry) => {
      const point = pointRef.current;
      const detail = { type: entry.type, ...(entry.mode ? { comfyMode: entry.mode } : {}), point };
      close();
      window.dispatchEvent(new CustomEvent('fisherai:add-canvas-node', { detail }));
    },
    [close],
  );

  const onPanelKeyDown = (event: ReactTypes.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + step + results.length) % results.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) commit(active);
    }
  };

  const entryIcon = (entry: CanvasNodeSearchEntry) => {
    const Icon = (ENTRY_ICONS[entry.type] ?? WorkflowIcon) as ReactTypes.ComponentType<{
      className?: string;
    }>;
    return h(Icon, { className: 'size-4 shrink-0 text-muted-foreground' });
  };

  const list = results.length
    ? results.map((result, index) => {
        const entry = result.entry;
        const selected = index === Math.min(activeIndex, results.length - 1);
        return h(
          'button',
          {
            key: entry.id,
            type: 'button',
            role: 'option',
            'aria-selected': selected,
            'data-fisherai-node-search-item': 'true',
            'data-command-id': entry.id,
            'data-command-group': entry.group,
            onMouseEnter: () => setActiveIndex(index),
            // mousedown 而不是 click：输入框失焦前就把动作做完
            onMouseDown: (event: ReactTypes.MouseEvent) => {
              event.preventDefault();
              commit(entry);
            },
            className: cn(
              'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
              selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60',
            ),
          },
          entryIcon(entry),
          h(
            'span',
            { className: 'min-w-0 flex-1' },
            h('span', { className: 'block truncate text-sm' }, entry.label),
            entry.description
              ? h(
                  'span',
                  { className: 'mt-0.5 block truncate text-[11px] text-muted-foreground' },
                  entry.description,
                )
              : null,
          ),
          h(
            'span',
            {
              className:
                'shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground',
            },
            entry.group,
          ),
        );
      })
    : h(
        'div',
        {
          'data-fisherai-node-search-empty': 'true',
          className: 'px-3 py-6 text-center text-xs text-muted-foreground',
        },
        `没有匹配「${query}」的节点或工作流`,
      );

  const input = h(Input, {
    key: 'input',
    ref: inputRef,
    value: query,
    'aria-label': '搜索节点',
    'data-fisherai-node-search-input': 'true',
    placeholder: '搜索节点 / ComfyUI 工作流…',
    autoComplete: 'off',
    spellCheck: false,
    onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => {
      setQuery(event.target.value);
      setActiveIndex(0);
    },
    onKeyDown: onPanelKeyDown,
    className: 'h-9 border-0 bg-transparent pl-0 text-sm shadow-none focus-visible:ring-0',
  });

  const panel = h(
    'div',
    {
      key: 'panel',
      ref: panelRef,
      role: 'dialog',
      'aria-label': '搜索节点',
      'data-fisherai-node-search-panel': 'true',
      'data-fisherai-node-search-state': 'open',
      // 排查/回归用：当前高亮的候选与候选总数（真机检查与 jsdom 回归都读它）
      'data-fisherai-node-search-active': active?.id ?? '',
      'data-fisherai-node-search-count': String(results.length),
      'data-fisherai-node-search-query': query,
      style: {
        left: `${Math.round(placement.left)}px`,
        top: `${Math.round(placement.top)}px`,
        width: `${Math.round(placement.width)}px`,
      },
      onKeyDown: onPanelKeyDown,
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      onContextMenu: (event: ReactTypes.MouseEvent) => event.preventDefault(),
      className:
        'fixed z-[12000] flex max-h-[60%] flex-col overflow-hidden rounded-xl border ' +
        'border-border bg-popover text-popover-foreground shadow-2xl',
    },
    h(
      'div',
      { className: 'flex items-center gap-2 border-b border-border px-3 py-1.5' },
      h(SearchIcon, { className: 'size-4 shrink-0 text-muted-foreground' }),
      input,
      h(Kbd, null, 'Esc'),
    ),
    h(
      ScrollArea,
      { className: 'min-h-0 flex-1' },
      h('div', { role: 'listbox', 'aria-label': '节点候选', className: 'flex flex-col gap-0.5 p-1.5' }, list),
    ),
    h(
      'div',
      {
        className:
          'flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground',
      },
      h('span', null, '↑↓ 选择'),
      h('span', null, 'Enter 添加'),
      h('span', null, 'Shift + A 再次打开'),
    ),
  );

  const watcher = h('div', {
    key: 'watcher',
    'data-fisherai-node-search': open ? 'open' : 'closed',
    hidden: true,
  });

  const root = h(react.Fragment, null, watcher, open ? panel : null);

  // 面板要挂在画布容器里（absolute 定位 + 继承画布主题变量），而不是 document.body。
  const target = canvasPortalTarget();
  if (target && open) return createPortal(root, target) as ReactTypes.ReactNode;
  return root;
}

CanvasNodeSearch.displayName = 'CanvasNodeSearchShadcn';
