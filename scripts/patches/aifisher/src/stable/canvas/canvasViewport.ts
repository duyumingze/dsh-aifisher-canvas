import type * as React from 'react';
import {
  getWheelMode,
  panViewport,
  shouldKeepWheelInsideControl,
  STABLE_MAX_ZOOM,
  STABLE_MIN_ZOOM,
  zoomViewportAtPoint,
  type CanvasViewport,
  type StableWheelSample,
} from './canvasNavigation';

/**
 * 视口（平移/缩放）—— dsh-aifisher-canvas 覆盖版（v1.108「手势期不 setState」P0）。
 *
 * 上游写法：每个 wheel / 每次拖拽平移都 `setState` → 整棵树（场景、连线、可见集）
 * 每 tick 重建一次。轻薄本上这就是纯浪费：画面靠 CSS transform 走合成器，
 * React 那边并没有必须在同一帧完成的事。
 *
 * 这里的改法（契约不变，仍是 `{ viewport, setViewport, canvasRef, handleWheel, handleSliderZoom, focusOnNodes }`）：
 *   1. 每个事件**立刻**写 `#canvas-viewport-content` 的 transform（手指跟手，不等 React）；
 *   2. 交给 React 的状态按 `VIEWPORT_SYNC_MS` 合并通知（首发立即、期间合并、停手补齐）；
 *   3. 状态换成「活快照」（getter 读最新值）——于是任何**因别的原因**发生的渲染
 *      （悬停、节点状态更新）都不会把 transform 写回旧位置；事件处理里读到的
 *      也永远是最新视口，不会出现「拖完立刻框选，选框偏一截」。
 *
 * `readCanvasViewport()` 是给「事件处理 / 场景渲染」用的；`viewport` 仍是 React 状态
 * （身份每轮同步变一次），只该喂 memo 依赖与展示。改这里之前先读项目 rules：
 * 平移是每帧写 DOM 的，别再加回「每 tick setState」。
 */
export { STABLE_MIN_ZOOM, STABLE_MAX_ZOOM };

/** 手势期间最多这么久把视口提交给 React 一次。 */
export const VIEWPORT_SYNC_MS = 90;

export const CANVAS_VIEWPORT_STATS_KEY = '__FISHERAI_CANVAS_VIEWPORT_STATS__';

let latestViewport: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/** 永远最新的视口（DOM transform 已经写成的那个值）。 */
export function readCanvasViewport(): CanvasViewport {
  return latestViewport;
}

/** 诊断计数：真机探针与回归共用（打了多少次 wheel vs 真正提交给 React 多少次）。 */
const viewportStats = { wheelTicks: 0, stateSyncs: 0 };

export function readCanvasViewportStats(): { wheelTicks: number; stateSyncs: number } {
  return { ...viewportStats };
}

export function resetCanvasViewportStats(): void {
  viewportStats.wheelTicks = 0;
  viewportStats.stateSyncs = 0;
}

/**
 * 交给 React 的活快照：身份每轮同步变一次（依赖数组照常失效），属性读的是最新值。
 * 用普通对象字面量 + getter，`{...viewport}` / `JSON.stringify(viewport)` 都照常工作。
 */
function liveSnapshot(): CanvasViewport {
  return {
    get x(): number {
      return latestViewport.x;
    },
    get y(): number {
      return latestViewport.y;
    },
    get zoom(): number {
      return latestViewport.zoom;
    },
  };
}

interface ViewportNode {
  id: string;
  x: number;
  y: number;
  height?: number;
}
interface CanvasBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
type ReactHooks = Pick<typeof React, 'useState' | 'useRef' | 'useCallback' | 'useEffect'>;

function boundsOf(canvas: HTMLElement | null): CanvasBounds {
  const bounds = canvas?.getBoundingClientRect();
  return bounds && bounds.width > 0 && bounds.height > 0
    ? bounds
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

export function sliderViewport(
  viewport: CanvasViewport,
  value: number,
  bounds: CanvasBounds,
): CanvasViewport {
  if (!Number.isFinite(value) || !(viewport.zoom > 0)) return viewport;
  const zoom = Math.min(STABLE_MAX_ZOOM, Math.max(STABLE_MIN_ZOOM, value));
  const x = bounds.width / 2;
  const y = bounds.height / 2;
  return {
    x: x - ((x - viewport.x) * zoom) / viewport.zoom,
    y: y - ((y - viewport.y) * zoom) / viewport.zoom,
    zoom,
  };
}

export function focusedViewport(
  nodes: readonly ViewportNode[],
  selectedIds: readonly string[] | undefined,
  bounds: CanvasBounds,
  getWidth: (node: ViewportNode) => number,
  getHeight: (node: ViewportNode) => number,
): CanvasViewport | null {
  const selected = selectedIds?.length
    ? nodes.filter((node) => selectedIds.includes(node.id))
    : nodes;
  if (!selected.length) return selectedIds?.length ? null : { x: 0, y: 0, zoom: 1 };
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const node of selected) {
    const width = getWidth(node);
    const height = node.height || getHeight(node);
    if (![node.x, node.y, width, height].every(Number.isFinite) || width < 0 || height < 0)
      return null;
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + width);
    bottom = Math.max(bottom, node.y + height);
  }
  const zoom = Math.max(
    STABLE_MIN_ZOOM,
    Math.min(
      STABLE_MAX_ZOOM,
      bounds.width / (right - left + 200),
      bounds.height / (bottom - top + 200),
      1.2,
    ),
  );
  return {
    x: bounds.width / 2 - ((left + right) / 2) * zoom,
    y: bounds.height / 2 - ((top + bottom) / 2) * zoom,
    zoom,
  };
}

/** Use the canvas's React instance; this module never bundles a second React runtime. */
export function useCanvasViewport(
  hooks: ReactHooks,
  getWidth: (node: ViewportNode) => number,
  getHeight: (node: ViewportNode) => number,
) {
  const [viewport, updateViewport] = hooks.useState<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  const canvasRef = hooks.useRef<HTMLElement | null>(null);
  const rendered = hooks.useRef<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  /** 上一次真正提交给 React 的那个对象（没变就不必再渲染一次）。 */
  const committed = hooks.useRef<CanvasViewport | null>(null);
  const syncTimer = hooks.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncAt = hooks.useRef(0);
  const releaseTimer = hooks.useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelBounds = hooks.useRef<CanvasBounds | null>(null);
  const acceleratedCanvas = hooks.useRef<HTMLElement | null>(null);
  /** `#canvas-viewport-content` 缓存（每 tick 查一次 DOM 是没必要的）。 */
  const layerCache = hooks.useRef<HTMLElement | null>(null);
  // 第一次渲染就把模块级读数对齐本实例的初始视口（重新挂载/换项目时别沿用上一份）。
  const bootstrapped = hooks.useRef(false);
  if (!bootstrapped.current) {
    bootstrapped.current = true;
    latestViewport = rendered.current;
  }

  const layerOf = hooks.useCallback(() => {
    const cached = layerCache.current;
    if (cached && cached.isConnected) return cached;
    const element =
      canvasRef.current?.querySelector<HTMLElement>('#canvas-viewport-content') ?? null;
    layerCache.current = element;
    return element;
  }, []);

  const writeTransform = hooks.useCallback(
    (next: CanvasViewport) => {
      const layer = layerOf();
      if (layer)
        layer.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.zoom})`;
    },
    [layerOf],
  );

  /** 立刻把当前视口提交给 React（停手、按下指针、卸载前用）。 */
  const flush = hooks.useCallback(() => {
    if (syncTimer.current !== null) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }
    const next = rendered.current;
    if (committed.current === next) return;
    committed.current = next;
    lastSyncAt.current = Date.now();
    viewportStats.stateSyncs += 1;
    updateViewport(liveSnapshot());
  }, [updateViewport]);
  /** setTimeout 回调里要拿最新的 flush（依赖 updateViewport，不能落后一格）。 */
  const flushRef = hooks.useRef(flush);
  flushRef.current = flush;

  const scheduleSync = hooks.useCallback((delay: number) => {
    if (syncTimer.current !== null) return;
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null;
      flushRef.current();
    }, delay);
  }, []);

  const commit = hooks.useCallback(
    (next: CanvasViewport) => {
      rendered.current = next;
      latestViewport = next;
      writeTransform(next);
      if (next === committed.current) return;
      const elapsed = Date.now() - lastSyncAt.current;
      if (elapsed >= VIEWPORT_SYNC_MS) {
        flush();
        return;
      }
      scheduleSync(VIEWPORT_SYNC_MS - elapsed);
    },
    [flush, scheduleSync, writeTransform],
  );

  const cancelPending = hooks.useCallback(() => {
    if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
    releaseTimer.current = null;
    acceleratedCanvas.current?.removeAttribute('data-canvas-wheel-active');
    acceleratedCanvas.current = null;
    wheelBounds.current = null;
  }, []);

  const setViewport = hooks.useCallback(
    (value: React.SetStateAction<CanvasViewport>) => {
      cancelPending();
      const next =
        typeof value === 'function'
          ? (value as (previous: CanvasViewport) => CanvasViewport)(rendered.current)
          : value;
      commit(next);
    },
    [cancelPending, commit],
  );

  const handleWheel = hooks.useCallback(
    (event: StableWheelSample & { target: EventTarget | null }) => {
      if (shouldKeepWheelInsideControl(event.target)) return;
      viewportStats.wheelTicks += 1;
      if (acceleratedCanvas.current !== canvasRef.current || !wheelBounds.current) {
        cancelPending();
        wheelBounds.current = boundsOf(canvasRef.current);
        acceleratedCanvas.current = canvasRef.current;
        acceleratedCanvas.current?.setAttribute('data-canvas-wheel-active', 'true');
      }
      const adapter = window.__FISHERAI_CANVAS_NAVIGATION__;
      const bounds = wheelBounds.current!;
      const next = getWheelMode(event) === 'pan'
        ? (adapter ? adapter.pan(rendered.current, event) : panViewport(rendered.current, event))
        : (adapter ? adapter.zoomAt(rendered.current, event, bounds) : zoomViewportAtPoint(rendered.current, event, {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        }));
      // 跟手：transform 本帧就落，React 那边按 VIEWPORT_SYNC_MS 合并。
      commit(next);
      if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
      releaseTimer.current = setTimeout(cancelPending, 150);
    },
    [cancelPending, commit],
  );

  const handleSliderZoom = hooks.useCallback(
    (event: { target: { value: string } }) => {
      const value = Number.parseFloat(event.target.value);
      const bounds = boundsOf(canvasRef.current);
      setViewport((current) => sliderViewport(current, value, bounds));
    },
    [setViewport],
  );

  const focusOnNodes = hooks.useCallback(
    (nodes: readonly ViewportNode[], selectedIds?: readonly string[]) => {
      const next = focusedViewport(
        nodes,
        selectedIds,
        boundsOf(canvasRef.current),
        getWidth,
        getHeight,
      );
      if (next) setViewport(next);
    },
    [getWidth, getHeight, setViewport],
  );

  hooks.useEffect(() => {
    const host = (typeof window === 'undefined' ? null : window) as unknown as
      | Record<string, unknown>
      | null;
    if (host) host[CANVAS_VIEWPORT_STATS_KEY] = () => readCanvasViewportStats();
    const doc = typeof document === 'undefined' ? null : document;
    // 指针一按下就把视口补齐：框选/建节点/连线都按 state 里的视口算起点，
    // 不能让「刚平移完」的那 90ms 变成一次偏移。
    const flushNow = () => flushRef.current();
    doc?.addEventListener('pointerdown', flushNow, true);
    doc?.addEventListener('keydown', flushNow, true);
    return () => {
      doc?.removeEventListener('pointerdown', flushNow, true);
      doc?.removeEventListener('keydown', flushNow, true);
      if (syncTimer.current !== null) {
        clearTimeout(syncTimer.current);
        syncTimer.current = null;
      }
      if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
      releaseTimer.current = null;
      if (host && host[CANVAS_VIEWPORT_STATS_KEY]) delete host[CANVAS_VIEWPORT_STATS_KEY];
    };
  }, []);

  return { viewport, setViewport, canvasRef, handleWheel, handleSliderZoom, focusOnNodes };
}
