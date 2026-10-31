/**
 * 画布小地图（shadcn/ui 重设计版）。
 *
 * 替换 vendor 的 `dialogs/canvasMinimap.tsx`。几何逻辑与 vendor 完全一致
 * （minimapScene / minimapViewport / 指针拖拽平移），只换外观：
 *   - 容器改为 shadcn 的 popover 面板外观（圆角、边框、阴影），不再是一块裸黑底；
 *   - 节点方块颜色取自画布语义 token（普通/视频），不再硬编码蓝紫；
 *   - 视口框用 focus 色 + 半透明填充。
 *
 * 结构契约：保留 `data-fisherai-minimap` / `data-fisherai-minimap-viewport`
 * 两个属性（回归脚本用它确认小地图真的渲染出来了）。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数），不要用本文件 import 的那份 ——
 *    产物里 React 有两份副本，用错那分量 React 19 不报错也不渲染（小地图会消失）。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';

import type { CanvasViewport } from '../../../vendor/aifisher/src/stable/canvas/canvasNavigation';
import {
  minimapScene,
  minimapViewport,
  type MinimapNode,
  type NodeMeasurement,
} from '../../../vendor/aifisher/src/stable/dialogs/minimapGeometry';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'useState'
  | 'useRef'
  | 'useEffect'
  | 'useLayoutEffect'
  | 'useMemo'
  | 'useCallback'
>;

interface Props {
  nodes: MinimapNode[];
  viewport: CanvasViewport;
  onViewportChange(viewport: CanvasViewport): void;
  width?: number;
  height?: number;
  canvasRef?: ReactTypes.RefObject<HTMLElement | null>;
  documentEpoch?: number;
}

export function CanvasMinimap(react: Runtime, props: Props, measure: NodeMeasurement) {
  const h = createElement(react);
  const { nodes, viewport, width = 250, height = 150, canvasRef, documentEpoch } = props;
  const rootRef = react.useRef<HTMLDivElement>(null);
  const dragRef = react.useRef<number | null>(null);
  const currentRef = react.useRef(props);
  const [dragging, setDragging] = react.useState(false);
  const [canvasSize, setCanvasSize] = react.useState({ width: 0, height: 0 });

  react.useLayoutEffect(() => {
    currentRef.current = props;
  });

  react.useLayoutEffect(() => {
    const canvas = canvasRef?.current ?? document.getElementById('canvas-background');
    const update = () => {
      const rect = canvas?.getBoundingClientRect();
      const next = {
        width: rect?.width || window.innerWidth,
        height: rect?.height || window.innerHeight,
      };
      setCanvasSize((old: { width: number; height: number }) =>
        old.width === next.width && old.height === next.height ? old : next,
      );
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (canvas) observer?.observe(canvas);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [canvasRef, documentEpoch]);

  const { width: measureWidth, height: measureHeight } = measure;
  const scene = react.useMemo(
    () => minimapScene(nodes, { width, height }, { width: measureWidth, height: measureHeight }),
    [nodes, width, height, measureWidth, measureHeight],
  );
  const frame = minimapViewport(scene, viewport, canvasSize);

  const release = react.useCallback(() => {
    const id = dragRef.current;
    dragRef.current = null;
    if (id !== null && rootRef.current?.hasPointerCapture?.(id))
      rootRef.current.releasePointerCapture(id);
    setDragging(false);
  }, []);

  react.useEffect(() => {
    const root = rootRef.current;
    dragRef.current = null;
    setDragging(false);
    const stop = () => release();
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('blur', stop);
      const id = dragRef.current;
      dragRef.current = null;
      if (id !== null && root?.hasPointerCapture?.(id)) root.releasePointerCapture(id);
    };
  }, [documentEpoch, release]);

  const pan = (event: ReactTypes.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height || !scene.scale) return;
    const localX = ((event.clientX - rect.left) * width) / rect.width;
    const localY = ((event.clientY - rect.top) * height) / rect.height;
    const worldX = (localX - scene.offsetX) / scene.scale + scene.minX;
    const worldY = (localY - scene.offsetY) / scene.scale + scene.minY;
    const current = currentRef.current;
    if (current.documentEpoch !== documentEpoch) return;
    current.onViewportChange({
      ...current.viewport,
      x: canvasSize.width / 2 - worldX * current.viewport.zoom,
      y: canvasSize.height / 2 - worldY * current.viewport.zoom,
    });
  };

  if (!scene.frames.length) return null;

  return h(
    'div',
    {
      ref: rootRef,
      'data-fisherai-minimap': 'true',
      'aria-label': '画布小地图',
      className:
        'absolute bottom-[80px] left-6 z-50 overflow-hidden rounded-lg border border-border ' +
        'bg-popover shadow-md transition-colors ' +
        (dragging ? 'cursor-grabbing' : 'cursor-grab'),
      style: { width, height, touchAction: 'none' },
      onPointerDown: (event: ReactTypes.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
        pan(event);
      },
      onPointerMove: (event: ReactTypes.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current === event.pointerId) pan(event);
      },
      onPointerUp: (event: ReactTypes.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current === event.pointerId) {
          pan(event);
          release();
        }
      },
      onPointerCancel: release,
      onLostPointerCapture: () => {
        dragRef.current = null;
        setDragging(false);
      },
    },
    h(
      'svg',
      { width: '100%', height: '100%', className: 'opacity-80' },
      scene.frames.map(
        (node: { id: string; type?: string; x: number; y: number; width: number; height: number }) =>
          h('rect', {
            key: node.id,
            x: (node.x - scene.minX) * scene.scale + scene.offsetX,
            y: (node.y - scene.minY) * scene.scale + scene.offsetY,
            width: Math.max(1, node.width * scene.scale),
            height: Math.max(1, node.height * scene.scale),
            rx: 2,
            // 语义色（设计稿第 6 节）：文本=白 17% / 图片=紫 50% / 视频=琥珀 46%。
            fill:
              node.type === 'Video'
                ? 'rgba(245, 194, 107, .46)'
                : node.type === 'Image'
                  ? 'rgba(139, 124, 246, .5)'
                  : 'rgba(255, 255, 255, .17)',
          }),
      ),
    ),
    h('div', {
      'data-fisherai-minimap-viewport': 'true',
      className: 'pointer-events-none absolute rounded-[3px] border border-[var(--af-focus)]',
      style: {
        ...frame,
        background: 'color-mix(in srgb, var(--af-focus) 8%, transparent)',
      },
    }),
  );
}

CanvasMinimap.displayName = 'CanvasMinimapShadcn';
