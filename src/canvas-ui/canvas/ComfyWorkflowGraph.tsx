/**
 * 「ComfyUI 工作流配置」面板里的**节点图**（v1.19）。
 *
 * 用户 2026-10-17 丢来一张参考图（ComfyUI 那种节点图 + 右侧「某节点 · #id」的勾选浮层），
 * 一句「希望 comfui api 配置可以像参考图一样可视化配置」。参考图那套东西属于上游
 * 「工作流节点库」（definitions / deployments / binding-sets / attestation 一整套后端），
 * 本插件没有、也不搬；这里落它真正有用的核心交互：
 *
 *   画 ComfyUI 的节点图（节点 + 贝塞尔连线）→ 点某个节点 → 面板右侧只列**这个节点**的字段
 *   → 勾选要暴露到画布节点上的参数（勾选状态仍由面板写回 `<名字>.meta.json`）。
 *
 * 分工：
 *   - 排版（坐标 / 行内容 / 连线两端）全在 host 的 src/host/comfyui/workflowGraph.ts 算好，
 *     前端**不重新布局**，只按坐标画 —— 这样回归里能拿 host 的数直接断言，两边不会漂。
 *   - 本文件的 `fitTransform` / `edgePath` 是纯函数，也被回归直接调用（不用 jsdom 量布局）。
 *
 * ⚠️ 与面板同一个坑：hooks 用注入进来的那份 React（第一个参数）；这份组件由面板用
 *    `ComfyWorkflowGraphBound`（见 ComfyWorkflowConfig.tsx）绑定，不要直接 createElement。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'useState' | 'useRef' | 'useEffect' | 'useCallback' | 'useSyncExternalStore'
>;

export interface GraphRow {
  field: string;
  valueType: 'number' | 'string' | 'boolean' | 'link' | 'other';
  display: string;
  linked: boolean;
  fromNodeId?: string;
  fromSlot?: number;
  candidateId?: string;
}

export interface GraphNode {
  id: string;
  classType: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rows: GraphRow[];
  hiddenRows: number;
  isOutput: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  field: string;
  slot: number;
  toRow: number;
  fromIndex: number;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bounds: { x: number; y: number; width: number; height: number };
  metrics: {
    nodeWidth: number;
    headerHeight: number;
    rowHeight: number;
    padTop: number;
    maxRows: number;
  };
}

export interface GraphTransform {
  /** 缩放倍率 */
  scale: number;
  /** 世界坐标 → 视口坐标的平移（像素） */
  x: number;
  y: number;
}

export interface ComfyWorkflowGraphProps {
  graph: GraphView;
  /** 节点 id → 这个节点上有几个候选字段 / 勾了几个（画在节点头部） */
  counts: Record<string, { total: number; selected: number }>;
  /** 当前已勾的候选 id（`节点id.inputs.字段`）—— 图上给这些行点亮小圆点 */
  pickedIds: Record<string, true>;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}

/** jsdom 里所有 rect 都是 0×0 —— 拿不到真实尺寸时用这个兜底（只是视图，不影响断言）。 */
const FALLBACK_SIZE = { width: 880, height: 470 };
/**
 * 右侧检查器浮层遮住的宽度（px）。
 * 「适应窗口」与「点节点居中」都要给它留出这块：不然图会排在浮层底下，看起来像被裁掉了。
 */
export const INSPECTOR_RESERVE = 276;
const MIN_SCALE = 0.18;
const MAX_SCALE = 2.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 「适应窗口」：把整张图缩放到视口里并居中。
 * 导出给回归用 —— 真浏览器里量到的视口尺寸与 host 的 bounds 一比，就能验证图没画出界。
 */
export function fitTransform(
  graph: GraphView,
  size: { width: number; height: number },
  padding = 26,
): GraphTransform {
  const width = size.width > 0 ? size.width : FALLBACK_SIZE.width;
  const height = size.height > 0 ? size.height : FALLBACK_SIZE.height;
  const boundsWidth = Math.max(1, graph.bounds.width);
  const boundsHeight = Math.max(1, graph.bounds.height);
  const scale = clamp(
    Math.min((width - padding * 2) / boundsWidth, (height - padding * 2) / boundsHeight),
    MIN_SCALE,
    1.1,
  );
  return {
    scale,
    x: (width - boundsWidth * scale) / 2 - graph.bounds.x * scale,
    y: (height - boundsHeight * scale) / 2 - graph.bounds.y * scale,
  };
}

/**
 * 一条连线的路径：右侧源节点 → 左边目标节点，落点是目标节点**那一行**的中心。
 * 行内 y 的量纲必须与 host 的 metrics 完全一致（headerHeight + padTop + row*rowHeight + rowHeight/2）。
 */
export function edgePath(
  from: GraphNode,
  to: GraphNode,
  edge: GraphEdge,
  metrics: GraphView['metrics'],
): string {
  const x1 = from.x + from.width;
  const y1 = round(
    Math.min(
      from.y + from.height - 4,
      from.y + metrics.headerHeight + metrics.padTop + metrics.rowHeight / 2 + edge.fromIndex * metrics.rowHeight,
    ),
  );
  const x2 = to.x;
  const y2 = round(
    to.y + metrics.headerHeight + metrics.padTop + edge.toRow * metrics.rowHeight + metrics.rowHeight / 2,
  );
  const dx = Math.max(24, (x2 - x1) * 0.45);
  return `M ${round(x1)} ${y1} C ${round(x1 + dx)} ${y1}, ${round(x2 - dx)} ${y2}, ${round(x2)} ${y2}`;
}

export function ComfyWorkflowGraph(react: Runtime, props: ComfyWorkflowGraphProps) {
  const h = createElement(react);
  const { graph, counts, pickedIds, selectedNodeId, onSelectNode } = props;
  const metrics = graph.metrics;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  const viewportRef = react.useRef<HTMLDivElement | null>(null);
  const [view, setView] = react.useState<GraphTransform>(() =>
    fitTransform(graph, {
      width: FALLBACK_SIZE.width - INSPECTOR_RESERVE,
      height: FALLBACK_SIZE.height,
    }),
  );
  /** 用户手动平移/缩放过之后，容器尺寸变化就不再自动「适应窗口」抢他的视角 */
  const touchedRef = react.useRef(false);

  const measure = react.useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }, []);

  /** 真正给图用的那块：「整块 - 右侧检查器浮层」；容器还没量到时用兜底尺寸。 */
  const fitSize = react.useCallback(() => {
    const size = measure();
    const width = size.width > 0 ? size.width : FALLBACK_SIZE.width;
    const height = size.height > 0 ? size.height : FALLBACK_SIZE.height;
    return { width: Math.max(160, width - INSPECTOR_RESERVE), height };
  }, [measure]);

  const fit = react.useCallback(() => {
    touchedRef.current = false;
    setView(fitTransform(graph, fitSize()));
  }, [graph, fitSize]);

  // 换工作流 / 换图 → 重新适应窗口
  react.useEffect(() => {
    touchedRef.current = false;
    setView(fitTransform(graph, fitSize()));
  }, [graph, fitSize]);

  // 面板刚打开时容器还是 0 宽（portal 里首次布局），尺寸到位后没被用户动过就再适应一次
  react.useEffect(() => {
    const element = viewportRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (touchedRef.current) return;
      setView(fitTransform(graph, fitSize()));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph, fitSize]);

  /**
   * 滚轮缩放：必须用**原生非 passive** 监听。
   * React 的 onWheel 在根上是 passive 的，preventDefault 会失效；而且画布 vendor 在 document
   * 上装了「画布永不滚动」的 wheel 监听，这里不 stopPropagation 就会连画布一起动。
   */
  react.useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      touchedRef.current = true;
      const rect = element.getBoundingClientRect();
      const px = event.clientX - (rect.left || 0);
      const py = event.clientY - (rect.top || 0);
      setView((current) => {
        const scale = clamp(current.scale * Math.exp(-event.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
        const ratio = scale / current.scale;
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    touchedRef.current = true;
    const size = fitSize();
    setView((current) => {
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      const ratio = scale / current.scale;
      const px = size.width / 2;
      const py = size.height / 2;
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  };

  /**
   * 选中节点：从概览里点一个小节点时，不把它挪过来/放大就等于没点。
   * 规则：节点已经完整可见就不动视角；否则居中到「图那块」（避开右侧检查器），
   * 并在缩放太小时抬到 0.7 —— 让点中的节点立刻看得清。
   */
  const revealSelected = (id: string | null) => {
    if (!id) {
      onSelectNode(null);
      return;
    }
    const node = nodeById.get(id);
    if (node) {
      const size = fitSize();
      const margin = 10;
      const left = view.x + node.x * view.scale;
      const top = view.y + node.y * view.scale;
      const right = left + node.width * view.scale;
      const bottom = top + node.height * view.scale;
      const fullyVisible =
        left >= margin && top >= margin && right <= size.width - margin && bottom <= size.height - margin;
      const scale = fullyVisible ? view.scale : Math.max(view.scale, 0.7);
      if (!fullyVisible || scale !== view.scale) {
        touchedRef.current = true;
        setView({
          scale,
          x: size.width / 2 - (node.x + node.width / 2) * scale,
          y: size.height / 2 - (node.y + node.height / 2) * scale,
        });
      }
    }
    onSelectNode(id);
  };

  // 拖拽平移（从空白处/节点外拖；点节点是选中，不拦它的 click）
  const dragRef = react.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [dragging, setDragging] = react.useState(false);

  const onPointerDown = (event: ReactTypes.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target && typeof target.closest === 'function' && target.closest('button,[data-fisherai-workflow-config-graph-node]')) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
    const element = event.currentTarget;
    if (element && typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // 老浏览器不支持捕获也没事：下面按坐标算平移，不依赖 capture
      }
    }
    setDragging(true);
  };

  const onPointerMove = (event: ReactTypes.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    touchedRef.current = true;
    setView((current) => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }));
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const nodeCard = (node: GraphNode) => {
    const selected = node.id === selectedNodeId;
    const count = counts[node.id] ?? { total: 0, selected: 0 };
    return h(
      'div',
      {
        key: node.id,
        role: 'button',
        tabIndex: 0,
        title: `${node.title} · #${node.id}（${node.classType}）`,
        'aria-label': `${node.title} · #${node.id}`,
        'aria-current': selected ? 'true' : undefined,
        'data-fisherai-workflow-config-graph-node': node.id,
        'data-selected': selected ? 'true' : 'false',
        'data-candidates': String(count.total),
        'data-picked': String(count.selected),
        style: { left: node.x, top: node.y, width: node.width, height: node.height },
        onClick: () => revealSelected(selected ? null : node.id),
        onKeyDown: (event: ReactTypes.KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          revealSelected(selected ? null : node.id);
        },
        className: cn(
          'pointer-events-auto absolute overflow-hidden rounded-[3px] border text-[var(--af-text)] shadow-sm transition-shadow',
          selected
            ? 'border-[var(--af-text-secondary)] bg-[var(--af-surface)] shadow-md ring-1 ring-[var(--af-text-secondary)]'
            : 'border-[var(--af-border)] bg-[var(--af-surface)] hover:border-[var(--af-border-control)]',
        ),
      },
      h(
        'div',
        {
          style: { height: metrics.headerHeight },
          className:
            'flex items-center gap-1 rounded-t-[3px] border-b border-[var(--af-border)] bg-[var(--af-surface-raised)] px-2',
        },
        h('span', { className: 'min-w-0 flex-1 truncate text-[10px] font-medium leading-none' }, node.title),
        count.selected > 0
          ? h(
              'span',
              {
                title: `这个节点上已经勾了 ${count.selected} / ${count.total} 个字段`,
                className:
                  'shrink-0 rounded-[2px] border border-[var(--af-border)] px-0.5 text-[8px] font-medium leading-[10px] text-[var(--af-text-secondary)]',
              },
              String(count.selected),
            )
          : null,
        h('span', { className: 'shrink-0 text-[9px] leading-none text-[var(--af-text-muted)]' }, `#${node.id}`),
      ),
      node.rows.map((row) => {
        const picked = row.candidateId !== undefined && pickedIds[row.candidateId] === true;
        return h(
          'div',
          {
            key: row.field,
            'data-fisherai-workflow-config-graph-row': `${node.id}.inputs.${row.field}`,
            'data-candidate': row.candidateId === undefined ? 'false' : 'true',
            'data-picked': picked ? 'true' : 'false',
            style: { height: metrics.rowHeight },
            className: 'flex items-center gap-1 px-2',
          },
          // 能被勾的字段前面点一个小圆点：实心 = 已经暴露到画布节点上（与 ComfyUI 的 widget 点同义）
          row.candidateId === undefined
            ? null
            : h('span', {
                className: cn(
                  'size-[3px] shrink-0 rounded-full',
                  picked ? 'bg-[var(--af-primary)]' : 'bg-[var(--af-border-control)]',
                ),
              }),
          h(
            'span',
            { className: 'min-w-0 flex-1 truncate text-[8.5px] leading-none text-[var(--af-text-muted)]' },
            row.field,
          ),
          h(
            'span',
            {
              className: cn(
                'max-w-[86px] shrink-0 truncate text-[8.5px] leading-none',
                row.linked ? 'text-[var(--af-text-muted)] opacity-60' : 'text-[var(--af-text-secondary)]',
              ),
            },
            row.display,
          ),
        );
      }),
      node.hiddenRows > 0
        ? h(
            'div',
            {
              style: { height: metrics.rowHeight },
              className: 'px-2 text-[8.5px] leading-[15px] text-[var(--af-text-muted)]',
            },
            `+${node.hiddenRows} 字段`,
          )
        : null,
      node.isOutput
        ? h(
            'span',
            {
              className:
                'absolute right-1 bottom-0.5 rounded-[2px] bg-[var(--af-surface-raised)] px-1 text-[7.5px] leading-[11px] text-[var(--af-text-muted)]',
            },
            '输出',
          )
        : null,
    );
  };

  const edgeElements = graph.edges.map((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) return null;
    const active = selectedNodeId !== null && (edge.from === selectedNodeId || edge.to === selectedNodeId);
    return h('path', {
      key: `${edge.from}->${edge.to}:${edge.field}`,
      d: edgePath(from, to, edge, metrics),
      fill: 'none',
      stroke: active ? 'var(--af-text-secondary)' : 'var(--af-edge)',
      strokeWidth: active ? 1.4 : 1.1,
      strokeOpacity: active ? 0.95 : 0.45,
      'data-fisherai-workflow-config-graph-edge': `${edge.from}->${edge.to}`,
    });
  });

  const empty = graph.nodes.length === 0;

  return h(
    'div',
    {
      ref: viewportRef,
      'data-fisherai-workflow-config-graph': 'true',
      'data-nodes': String(graph.nodes.length),
      'data-edges': String(graph.edges.length),
      'data-zoom': view.scale.toFixed(3),
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onWheel: (event: ReactTypes.WheelEvent) => event.stopPropagation(),
      className: cn(
        'relative min-h-0 flex-1 overflow-hidden bg-[var(--af-canvas)] select-none',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
      ),
      style: empty
        ? undefined
        : {
            backgroundImage: 'radial-gradient(circle, var(--af-border) 0.7px, transparent 0.8px)',
            backgroundSize: '18px 18px',
          },
    },
    empty
      ? h(
          'div',
          { className: 'flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground' },
          '这份工作流里没有节点（JSON 可能不是 ComfyUI 的 API 导出格式）。',
        )
      : h(
          'div',
          {
            className: 'pointer-events-none absolute top-0 left-0 origin-top-left',
            style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` },
          },
          h(
            'svg',
            {
              width: Math.max(1, graph.bounds.width),
              height: Math.max(1, graph.bounds.height),
              className: 'absolute top-0 left-0 overflow-visible',
              'aria-hidden': 'true',
            },
            edgeElements,
          ),
          graph.nodes.map(nodeCard),
        ),
    // 工具栏（参考图右上角那个「适应窗口」）
    h(
      'div',
      {
        className:
          'absolute top-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-popover/90 p-0.5 shadow-sm backdrop-blur-sm',
      },
      h(
        'button',
        {
          type: 'button',
          'aria-label': '缩小',
          'data-fisherai-workflow-config-graph-zoom-out': 'true',
          onClick: () => zoomBy(1 / 1.25),
          className: 'rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground',
        },
        h(ZoomOutIcon, { className: 'size-3.5' }),
      ),
      h(
        'button',
        {
          type: 'button',
          'aria-label': '放大',
          'data-fisherai-workflow-config-graph-zoom-in': 'true',
          onClick: () => zoomBy(1.25),
          className: 'rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground',
        },
        h(ZoomInIcon, { className: 'size-3.5' }),
      ),
      h(
        'button',
        {
          type: 'button',
          'aria-label': '适应窗口',
          'data-fisherai-workflow-config-fit': 'true',
          onClick: () => fit(),
          className:
            'ml-0.5 flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground',
        },
        h(MaximizeIcon, { className: 'size-3' }),
        '适应窗口',
      ),
    ),
    // 缩放读数（左下角，跟画布左下那个 100% 一个语义）
    h(
      'div',
      {
        'data-fisherai-workflow-config-graph-zoom': String(Math.round(view.scale * 100)),
        className:
          'pointer-events-none absolute bottom-2 left-2 rounded bg-popover/80 px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm',
      },
      `${Math.round(view.scale * 100)}%`,
    ),
  );
}

ComfyWorkflowGraph.displayName = 'ComfyWorkflowGraph';
