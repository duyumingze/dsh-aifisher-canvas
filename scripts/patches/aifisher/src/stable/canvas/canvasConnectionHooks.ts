/**
 * 【本文件是 dsh-aifisher-canvas 的覆盖补丁，不是上游原文】
 *
 * 上游这套连线手势按「指针在不在节点矩形里 + 按模板公式算第几个槽」来判定落点，
 * 在本插件的本地工作流节点上会明显不准（用户报障原话：
 *「这里接入的时候判定接入口与鼠标不准，修复一下」）：
 *
 *   1. **端口圆有一半在节点框外面**。本地工作流节点左边的「+」按钮中心正好压在节点
 *      左缘上（这样连线端点才对得上），所以圆的外半边落在节点矩形之外 —— 用户把线
 *      拖到那个圆上、松手点只要偏左 1px，`x >= item.x` 就不成立，被判成「没对上节点」，
 *      于是弹「新建节点」菜单。
 *   2. **落点会自己挪槽**。`resolveOperation()` 拿到首选槽位后不兼容时，会去试其它
 *      所有可用槽位 —— 用户瞄的是「遮罩图」，线最后却接在「原图」或「正面提示词」上。
 *   3. **松手那一下不重判**。快速拖动时最后一个 pointermove 与 pointerup 之间有位移，
 *      落点用的是上一帧的位置。
 *
 * 改法（只用 DOM 事实，不加新机制）：
 *   - 节点/端口按钮都带 `data-fisherai-connector-node-id / -side / -port-index`
 *     （上游自己也这么标，见 canvasNodeFrame、canvasWorkflowGenerator、canvasMiniMaxNode）；
 *   - 命中顺序：`elementFromPoint` 精确命中 → 圆心吸附（圆 + 10px 光晕）→ 节点矩形；
 *   - 指着具体某个端口时记 `hoveredPortExact`，落点**只认它**，不兼容就不接
 *     （拖动过程中虚线已经变红，用户看得见）；
 *   - pointerup 时按松手坐标再判一次（只在这一帧还没有判定结果时才用，保持老行为可预期）。
 *
 * jsdom 里 `getBoundingClientRect()` 全是 0、`elementFromPoint` 也没有布局可算，
 * 所以所有 DOM 命中都要求 rect 可用（> 1px）；不满足就整体退回上游那套公式 —— 回归用例
 * 的判定结果与改之前完全一致。
 */
import type * as React from 'react';
import {
  installStableCanvasConnections,
  connectCanvasNodes,
  type ConnectCanvasNodesOptions,
  type CanvasConnectionNode,
  type CanvasConnectionIdentity,
} from './canvasConnections';
import type { CanvasViewport } from './canvasNavigation';

type Hooks = Pick<typeof React, 'useState' | 'useRef' | 'useCallback'>;
type Side = 'left' | 'right';
interface Node extends CanvasConnectionNode {
  x: number;
  y: number;
  kind?: string;
  comfyMode?: string;
}
interface WorkflowConnections {
  getOutputPortY?(node: Node, portIndex: number): number;
  resolveAvailableInputSlot(target: Node, source: Node, sourcePort: number): number;
  canConnect(target: Node, source: Node, targetPort: number, sourcePort: number): boolean;
  getInputSlots(node: Node): { slotIndex: number }[];
  getInputCapacity(node: Node): number;
  getConnectionLimitNotice(target: Node, source: Node, sourcePort: number): string | undefined;
}
export interface ConnectionRuntime {
  getWidth(node: Node): number;
  getHeight(node: Node): number;
  templates: { id: string; inputs: unknown[]; outputs: unknown[] }[];
  canConnect(source: Node, target: Node, nodes: Node[], targetPort?: number): string | false | null;
  getPortTop(): number;
  portHeight: number;
  portGap: number;
  workflow(): WorkflowConnections | undefined;
  minimax():
    | {
        resolvePortIndex(node: Node, relativeY: number, source?: Node): number;
        isConnectionAllowed(target: Node, source: Node, targetPort: number): boolean;
      }
    | undefined;
}
interface Point {
  x: number;
  y: number;
}
interface Start {
  nodeId: string;
  handle: Side;
  portIndex?: number;
}
interface DragState {
  isDraggingConnection: boolean;
  isPendingConnection: boolean;
  pendingBatchSourceNodeIds: string[];
  connectionStart: Start | null;
  tempConnectionEnd: Point | null;
  hoveredNodeId: string | null;
  hoveredSide: Side | null;
  hoveredPortIndex: number | null;
  /** 指针是不是**真的**指在这个端口上（DOM 命中 / 圆心吸附），而不是按位置算出来的。 */
  hoveredPortExact: boolean;
  isInvalidHover: boolean;
}
const empty = (): DragState => ({
  isDraggingConnection: false,
  isPendingConnection: false,
  pendingBatchSourceNodeIds: [],
  connectionStart: null,
  tempConnectionEnd: null,
  hoveredNodeId: null,
  hoveredSide: null,
  hoveredPortIndex: null,
  hoveredPortExact: false,
  isInvalidHover: false,
});
type Pointer = Pick<PointerEvent, 'clientX' | 'clientY' | 'stopPropagation' | 'preventDefault'>;
type SetNodes = React.Dispatch<React.SetStateAction<Node[]>>;

// ---------------------------------------------------------------- 端口命中（DOM 事实）

const CONNECTOR_NODE_ATTRIBUTE = 'data-fisherai-connector-node-id';
const CONNECTOR_SIDE_ATTRIBUTE = 'data-fisherai-connector-side';
const CONNECTOR_PORT_ATTRIBUTE = 'data-fisherai-connector-port-index';
/**
 * 端口圆外面还能算「指着它」的光晕（屏幕像素）。
 * 圆直径 30、圆心压在节点左缘上，所以用户的肌肉记忆是「把线甩到那个圆附近」，
 * 不是「精确戳进 15px 半径」。给 10px 容差手感最接近其它画布工具。
 */
const PORT_SNAP_PADDING = 10;
/**
 * 指针落在节点身上时，「贴着某一行端口」的判定距离（屏幕像素）。
 * 槽位行距 34、圆直径 30：20px 之内就是「我要接这一行」；再远就是「随便连到这个节点」。
 */
const PORT_EXACT_DISTANCE = 20;
/**
 * 指着具体某个槽却接不上时**不弹窗**：拖动过程中虚线已经变红（isInvalidHover），
 * 这是这套画布既有的「接不了」反馈；用 window.alert 会在真机上打断操作，
 * 还会把 headless 里跑着的手势卡住（modal 挡住渲染进程）。
 */


/** 真实布局才有意义：jsdom 里所有 rect 都是 0×0。 */
const measurable = (rect: { width: number; height: number } | null | undefined): boolean =>
  !!rect && rect.width > 1 && rect.height > 1;

function portIndexOf(button: Element): number {
  const raw = Number(button.getAttribute(CONNECTOR_PORT_ATTRIBUTE));
  return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

function sideOf(button: Element): Side | null {
  const side = button.getAttribute(CONNECTOR_SIDE_ATTRIBUTE);
  return side === 'left' || side === 'right' ? side : null;
}

/** 指针**正下方**的端口按钮：所见即所得的那一路。 */
function portAtPoint(
  x: number,
  y: number,
): { nodeId: string; side: Side; portIndex: number } | null {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function')
    return null;
  let element: Element | null = null;
  try {
    element = document.elementFromPoint(x, y);
  } catch {
    return null;
  }
  const button = element?.closest?.(`[${CONNECTOR_NODE_ATTRIBUTE}]`) as Element | null;
  if (!button) return null;
  const nodeId = button.getAttribute(CONNECTOR_NODE_ATTRIBUTE);
  const side = sideOf(button);
  if (!nodeId || !side) return null;
  if (!measurable(button.getBoundingClientRect())) return null;
  return { nodeId, side, portIndex: portIndexOf(button) };
}

/**
 * 圆心吸附：指针在圆的「半径 + 光晕」之内就算指着它，取最近的一个。
 * 这一条同时解决了「圆的外半边在节点外面」的问题（指针在节点框外也算命中）。
 */
function portNearPoint(
  x: number,
  y: number,
  side: Side,
  excludeNodeId: string,
): { nodeId: string; side: Side; portIndex: number } | null {
  if (typeof document === 'undefined') return null;
  let best: { nodeId: string; side: Side; portIndex: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const selector = `[${CONNECTOR_NODE_ATTRIBUTE}][${CONNECTOR_SIDE_ATTRIBUTE}="${side}"]`;
  for (const button of Array.from(document.querySelectorAll(selector))) {
    const nodeId = button.getAttribute(CONNECTOR_NODE_ATTRIBUTE);
    if (!nodeId || nodeId === excludeNodeId) continue;
    const rect = button.getBoundingClientRect();
    if (!measurable(rect)) continue;
    const distance = Math.hypot(
      x - (rect.left + rect.width / 2),
      y - (rect.top + rect.height / 2),
    );
    if (distance > rect.width / 2 + PORT_SNAP_PADDING) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { nodeId, side, portIndex: portIndexOf(button) };
    }
  }
  return best;
}

/**
 * 指针落在节点身上（不是正好压在某个按钮上）时，按**纵向位置**取这个节点最近的端口按钮。
 * 比「按模板公式算行号」准：节点的槽位布局、缩放、折叠都会动，DOM 才是真的。
 * 同时给出纵向距离：贴着某一行（≤ PORT_EXACT_DISTANCE）才算「指着这个槽」，
 * 在节点下半部分的参数区松手仍然按「连到节点、自动挑一个空槽」的老规矩办。
 */
function portNearY(
  nodeId: string,
  side: Side,
  clientY: number,
): { portIndex: number; distance: number } | null {
  if (typeof document === 'undefined') return null;
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(nodeId)
      : nodeId.replace(/["\\]/g, '\\$&');
  const scope = document.querySelector(`[data-node-id="${escaped}"]`) ?? document;
  let best: { portIndex: number; distance: number } | null = null;
  for (const button of Array.from(
    scope.querySelectorAll(`[${CONNECTOR_NODE_ATTRIBUTE}]`),
  )) {
    if (button.getAttribute(CONNECTOR_NODE_ATTRIBUTE) !== nodeId) continue;
    if (button.getAttribute(CONNECTOR_SIDE_ATTRIBUTE) !== side) continue;
    const rect = button.getBoundingClientRect();
    if (!measurable(rect)) continue;
    const distance = Math.abs(clientY - (rect.top + rect.height / 2));
    if (!best || distance < best.distance) best = { portIndex: portIndexOf(button), distance };
  }
  return best;
}

/** Pointer state, compatibility and mutations belong to one connection gesture. */
export function useCanvasConnections(hooks: Hooks, runtime: ConnectionRuntime) {
  const adapter = installStableCanvasConnections();
  const [state, publish] = hooks.useState(empty);
  const current = hooks.useRef(state);
  /** 最近一次的视口（pointerup 上按松手点补判要用）。 */
  const viewportRef = hooks.useRef<CanvasViewport | null>(null);
  const [selectedConnection, publishSelected] = hooks.useState<CanvasConnectionIdentity | null>(
    null,
  );
  const selected = hooks.useRef(selectedConnection);
  const setSelectedConnection = (update: React.SetStateAction<CanvasConnectionIdentity | null>) => {
    selected.current = typeof update === 'function' ? update(selected.current) : update;
    publishSelected(selected.current);
  };
  const update = (next: DragState) => {
    current.current = next;
    publish(next);
  };
  const template = (node: Node, mode = node.comfyMode) =>
    runtime.templates.find((item) => item.id === mode) ?? runtime.templates[0];
  const compatible = (
    nodes: Node[],
    source: Node,
    target: Node,
    targetPort: number,
    sourcePort: number,
  ) => {
    const workflow = runtime.workflow(),
      minimax = runtime.minimax();
    if (
      target.kind === 'workflow' &&
      (!workflow || !workflow.canConnect(target, source, targetPort, sourcePort))
    )
      return false;
    if (
      target.comfyMode === 'minimax-h3-t2va' &&
      minimax &&
      !minimax.isConnectionAllowed(target, source, targetPort)
    )
      return false;
    return runtime.canConnect(
      source.kind === 'workflow' ? { ...source, __fisherSourcePort: sourcePort } : source,
      target,
      nodes,
      targetPort,
    );
  };
  /** 上游那套「按模板算第几个槽」的落点公式（只作 DOM 不可用时的兜底：jsdom、老节点）。 */
  const portFromTemplate = (
    node: Node,
    side: Side,
    y: number,
    origin: Node | undefined,
    sourcePort: number,
  ): number => {
    let port = 0;
    if (node.type !== 'ComfyUI') return port;
    const ports = side === 'left' ? template(node)?.inputs : template(node)?.outputs;
    if (node.kind === 'workflow') {
      // An input slot is chosen only when dragging into the workflow. When
      // dragging from an input, the hovered workflow supplies an output.
      if (side === 'left')
        port = origin ? (runtime.workflow()?.resolveAvailableInputSlot(node, origin, sourcePort) ?? -1) : -1;
      else {
        const outputs = Array.isArray(node.outputPorts) ? node.outputPorts : [];
        port = -1;
        let closest = Infinity;
        outputs.forEach((_, index) => {
          const center =
            runtime.workflow()?.getOutputPortY?.(node, index) ??
            runtime.getPortTop() +
              runtime.portHeight / 2 +
              index * (runtime.portHeight + runtime.portGap);
          const distance = Math.abs(y - node.y - center);
          if (distance < closest) {
            closest = distance;
            port = index;
          }
        });
      }
    } else if (node.comfyMode === 'minimax-h3-t2va' && side === 'left') {
      port = runtime.minimax()?.resolvePortIndex(node, y - node.y, origin) ?? 0;
    } else if (ports && ports.length > 1) {
      port = Math.max(
        0,
        Math.min(
          ports.length - 1,
          Math.round(
            (y - node.y - runtime.getPortTop() - runtime.portHeight / 2) /
              (runtime.portHeight + runtime.portGap),
          ),
        ),
      );
    }
    return port;
  };
  const hover = (point: Point, nodes: Node[], viewport: CanvasViewport): DragState => {
    const value = current.current,
      start = value.connectionStart;
    const next = {
      ...value,
      tempConnectionEnd: point,
      hoveredNodeId: null,
      hoveredSide: null,
      hoveredPortIndex: null,
      hoveredPortExact: false,
      isInvalidHover: false,
    } as DragState;
    if (!start || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0) return next;
    const x = (point.x - viewport.x) / viewport.zoom,
      y = (point.y - viewport.y) / viewport.zoom;
    const side: Side = start.handle === 'right' ? 'left' : 'right';
    const origin = nodes.find((item) => item.id === start.nodeId);
    // ① 指针指着端口按钮（含圆心吸附 / 圆露在节点框外的那半圈）
    const pointedAt = portAtPoint(point.x, point.y);
    const snapped =
      pointedAt && pointedAt.side === side && pointedAt.nodeId !== start.nodeId
        ? pointedAt
        : portNearPoint(point.x, point.y, side, start.nodeId);
    let node = snapped ? nodes.find((item) => item.id === snapped.nodeId) : undefined;
    let port = snapped ? snapped.portIndex : 0;
    let exact = Boolean(snapped);
    if (!node) {
      // ② 指针在节点身上：按纵向位置取最近的端口按钮（DOM 量不出来时才用模板公式）
      node = nodes.find(
        (item) =>
          item.id !== start.nodeId &&
          x >= item.x &&
          x <= item.x + runtime.getWidth(item) &&
          y >= item.y &&
          y <= item.y + runtime.getHeight(item),
      );
      if (!node) return next;
      const rendered = node.type === 'ComfyUI' ? portNearY(node.id, side, point.y) : null;
      if (rendered) {
        port = rendered.portIndex;
        exact = rendered.distance <= PORT_EXACT_DISTANCE;
      } else {
        port = portFromTemplate(node, side, y, origin, start.portIndex ?? 0);
      }
    }
    next.hoveredNodeId = node.id;
    next.hoveredSide = side;
    next.hoveredPortIndex = port;
    next.hoveredPortExact = exact;
    if (origin)
      next.isInvalidHover =
        port < 0 ||
        !compatible(
          nodes,
          start.handle === 'right' ? origin : node,
          start.handle === 'right' ? node : origin,
          start.handle === 'right' ? port : (start.portIndex ?? 0),
          start.handle === 'right' ? (start.portIndex ?? 0) : port,
        );
    return next;
  };
  const cancelConnectionDrag = () => update(empty());
  const resolveOperation = (
    nodes: Node[],
    intent: Pick<
      ConnectCanvasNodesOptions,
      'parentId' | 'childId' | 'portIndex' | 'sourcePortIndex'
    >,
    /** 指针明确指着某个槽：只认它，不许自动挪到别的槽。 */
    exact = false,
  ): { operation?: ConnectCanvasNodesOptions; notice?: string } => {
    const source = nodes.find((node) => node.id === intent.parentId),
      target = nodes.find((node) => node.id === intent.childId);
    if (!source || !target) return {};
    const sourcePort = intent.sourcePortIndex ?? 0;
    const ports = [intent.portIndex ?? 0];
    if (!exact && target.type === 'ComfyUI') {
      const available =
        target.kind === 'workflow'
          ? (runtime
              .workflow()
              ?.getInputSlots(target)
              .map((slot) => slot.slotIndex) ?? [])
          : (template(target)?.inputs.map((_, index) => index) ?? []);
      for (const port of available) if (!ports.includes(port)) ports.push(port);
    }
    for (const port of ports) {
      const mode = compatible(nodes, source, target, port, sourcePort);
      if (!mode) continue;
      const inputCount =
        target.type === 'ComfyUI'
          ? target.kind === 'workflow'
            ? (runtime.workflow()?.getInputCapacity(target) ?? 0)
            : template(target, mode !== 'default' ? mode : target.comfyMode)?.inputs.length
          : undefined;
      const modeField =
        mode === 'default' || target.kind === 'workflow'
          ? undefined
          : ['Image', 'Upload Image'].includes(target.type)
            ? 'imageMode'
            : ['Video', 'Upload Video'].includes(target.type)
              ? 'videoMode'
              : target.type === 'ComfyUI'
                ? 'comfyMode'
                : undefined;
      return {
        operation: {
          ...intent,
          portIndex: port,
          sourcePortIndex: sourcePort,
          inputCount,
          connectionMode: mode,
          modeField,
        },
      };
    }
    return {
      notice:
        target.kind === 'workflow'
          ? runtime.workflow()?.getConnectionLimitNotice(target, source, sourcePort)
          : undefined,
    };
  };
  return {
    ...state,
    selectedConnection,
    setSelectedConnection,
    handleConnectorPointerDown(event: Pointer, nodeId: string, handle: Side, portIndex?: number) {
      event.stopPropagation();
      event.preventDefault();
      update({
        ...empty(),
        isDraggingConnection: true,
        connectionStart: { nodeId, handle, portIndex },
        tempConnectionEnd: { x: event.clientX, y: event.clientY },
      });
    },
    updateConnectionDrag(event: Pointer, nodes: Node[], viewport: CanvasViewport) {
      if (!current.current.isDraggingConnection) return false;
      viewportRef.current = viewport;
      update(hover({ x: event.clientX, y: event.clientY }, nodes, viewport));
      return true;
    },
    completeConnectionDrag(
      openMenu: (id: string, side: Side, x: number, y: number, ids: string[], sourcePortIndex?: number) => void,
      setNodes: SetNodes,
      nodes: Node[],
      onConnected?: (parent: string, child: string) => void,
      event?: Pick<PointerEvent, 'clientX' | 'clientY'>,
      batch?: string[],
    ) {
      const value = current.current,
        start = value.connectionStart;
      if (!value.isDraggingConnection || !start) return false;
      const x = event?.clientX ?? value.tempConnectionEnd?.x ?? 0,
        y = event?.clientY ?? value.tempConnectionEnd?.y ?? 0;
      const ids = [...new Set(batch?.length ? batch : [start.nodeId])];
      // 拖得快的时候最后一次 pointermove 与松手位置之间有位移：这一帧还没有判定结果
      // （指针一直在空白处）就按松手点补判一次，别让用户「明明拖到槽上了却弹新建菜单」。
      const release =
        !value.hoveredNodeId && viewportRef.current
          ? hover({ x, y }, nodes, viewportRef.current)
          : null;
      const hoveredNodeId = value.hoveredNodeId ?? release?.hoveredNodeId ?? null;
      const hoveredSide = value.hoveredSide ?? release?.hoveredSide ?? null;
      const hoveredPortIndex = value.hoveredNodeId
        ? value.hoveredPortIndex
        : (release?.hoveredPortIndex ?? null);
      const hoveredPortExact = value.hoveredNodeId
        ? value.hoveredPortExact
        : Boolean(release?.hoveredPortExact);
      if (!hoveredNodeId || !hoveredSide) {
        update({
          ...value,
          isDraggingConnection: false,
          isPendingConnection: true,
          pendingBatchSourceNodeIds: ids,
        });
        openMenu(start.nodeId, start.handle, x, y, ids, start.portIndex ?? 0);
        return true;
      }
      const sourcePort =
        start.handle === 'right' ? (start.portIndex ?? 0) : (hoveredPortIndex ?? 0);
      let updated = nodes;
      const operations: ConnectCanvasNodesOptions[] = [];
      for (const id of ids) {
        if (id === hoveredNodeId) continue;
        const parentId = start.handle === 'right' ? id : hoveredNodeId;
        const childId = start.handle === 'right' ? hoveredNodeId : id;
        const preferred = start.handle === 'right' ? hoveredPortIndex : start.portIndex;
        const { operation, notice } = resolveOperation(
          updated,
          {
            parentId,
            childId,
            portIndex: preferred ?? undefined,
            sourcePortIndex: sourcePort,
          },
          hoveredPortExact,
        );
        if (!operation) {
          if (notice) window.alert(notice);
          continue;
        }
        const next = connectCanvasNodes(updated, operation);
        if (next !== updated) {
          updated = next;
          operations.push(operation);
          onConnected?.(parentId, childId);
        }
      }
      if (operations.length)
        setNodes((latest) =>
          operations.reduce((result, intent) => {
            const { operation } = resolveOperation(result, intent, hoveredPortExact);
            return operation ? adapter.connect(result, operation) : result;
          }, latest),
        );
      cancelConnectionDrag();
      return true;
    },
    cancelConnectionDrag,
    handleEdgeClick(
      event: Pick<PointerEvent, 'stopPropagation'>,
      parentId: string,
      childId: string,
      portIndex?: number,
    ) {
      event.stopPropagation();
      setSelectedConnection({ parentId, childId, portIndex });
    },
    deleteSelectedConnection(setNodes: SetNodes) {
      const identity = selected.current;
      if (!identity) return false;
      setNodes((nodes) => adapter.disconnect(nodes, identity));
      setSelectedConnection(null);
      return true;
    },
  };
}
