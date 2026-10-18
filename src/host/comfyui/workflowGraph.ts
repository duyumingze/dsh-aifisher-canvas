/**
 * 「ComfyUI 工作流配置」面板的**可视化**半边（v1.19）：把 ComfyUI API JSON 排成一张可画的图。
 *
 * 为什么要有它：v1.16 的面板只能看一长串「候选字段」，用户 2026-10-17 又丢来一张参考图
 * （ComfyUI 那种节点图 + 右侧「某节点 · #id」的勾选浮层），说「希望 comfui api 配置可以
 * 像参考图一样可视化配置」。参考图里那套东西（工作流节点库 / definitions / deployments /
 * binding-sets）本插件没有后端，不搬；搬的是它真正有用的那几步：
 *   **画节点图 → 点节点 → 右侧勾这个节点的字段**。
 *
 * 这里只做「排版」这一件事（纯函数、可单测）：
 *   - 节点：id / 类名 / 标题 / 每个 input 的显示文本（被连线喂的标成 link）；
 *   - 边：ComfyUI API 格式里 `[来源节点id, 输出序号]` 就是一条连线；
 *   - 坐标：按**最长路径**分层（左→右），同层内按父节点顺序 + id 数值序排列，层内竖直居中。
 *
 * 画面上要用的常量（行高 / 行内 y）与前端严格同一套，改这里就必须同步
 * src/canvas-ui/canvas/ComfyWorkflowGraph.tsx 的 `edgePath`（有回归守着）。
 */
import type { PromptGraph, PromptNode } from './workflows/minimaxH3T2VA';
import { sortedGraphNodeIds } from './customWorkflows';

/** 排版的量纲：前端画节点框、算连线端点都用这一份（别在那儿另写一套数字）。 */
export const WORKFLOW_GRAPH_METRICS = {
  /** 所有节点等宽（参考图也是等宽的，扫一眼就能看出层级） */
  nodeWidth: 170,
  headerHeight: 26,
  rowHeight: 15,
  padTop: 5,
  padBottom: 5,
  /**
   * 一个节点最多画几行字段（再多就在图上折起来，检查器里照样能勾）。
   * 取 16 是为了**跟 ComfyUI 里看到的一致**：真工作流的「条件 / 采样」节点常有 14 个 input，
   * 早先取 9 会把它们折掉，用户在图上就找不到那些候选字段了。宽度才是「适应窗口」的瓶颈，
   * 行数基本不额外花版面。
   */
  maxRows: 16,
  columnGap: 38,
  rowGap: 18,
  /** 画布左上角留白（节点不从 (0,0) 贴边开始，连线才有地方画） */
  margin: 24,
} as const;

export interface WorkflowGraphRow {
  field: string;
  /** 字段值的种类；link = 被上游连线喂的（面板里不能当参数勾） */
  valueType: 'number' | 'string' | 'boolean' | 'link' | 'other';
  /** 图上给用户看的一小段值（已截断，别在前端再切一次） */
  display: string;
  linked: boolean;
  fromNodeId?: string;
  fromSlot?: number;
  /** 这个字段是候选字段时，等于绑定地址 `${nodeId}.inputs.${field}` */
  candidateId?: string;
}

export interface WorkflowGraphNodeView {
  id: string;
  classType: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rows: WorkflowGraphRow[];
  /** 因 maxRows 折起来没画的字段数（>0 时节点底部显示「+n 字段」） */
  hiddenRows: number;
  /** 这个节点是工作流的输出节点（面板会把它标出来） */
  isOutput: boolean;
}

export interface WorkflowGraphEdgeView {
  from: string;
  to: string;
  /** 目标节点上被喂的字段名 */
  field: string;
  /** ComfyUI 的输入序号（来源那侧写的那个数字） */
  slot: number;
  /** 目标节点里这一行的索引（前端按它算连线落点；已 clamp 到画出来的行内） */
  toRow: number;
  /** 同一个来源节点的第几条出边（前端按它做竖直扇出，避免几条线叠在一起） */
  fromIndex: number;
}

export interface WorkflowGraphView {
  nodes: WorkflowGraphNodeView[];
  edges: WorkflowGraphEdgeView[];
  bounds: { x: number; y: number; width: number; height: number };
  metrics: {
    nodeWidth: number;
    headerHeight: number;
    rowHeight: number;
    padTop: number;
    maxRows: number;
  };
}

const METRICS = WORKFLOW_GRAPH_METRICS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

/** 按**字符**（不是 UTF-16 码元）截断，免得把 emoji / 中文截成半个。 */
function truncate(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text;
}

/** 一个 input 值 → 图上那一行右边显示什么。 */
function displayOf(value: unknown): Pick<WorkflowGraphRow, 'valueType' | 'display' | 'linked' | 'fromNodeId' | 'fromSlot'> {
  if (isLink(value)) {
    return { valueType: 'link', display: `← #${value[0]}`, linked: true, fromNodeId: value[0], fromSlot: value[1] };
  }
  if (typeof value === 'number') {
    return { valueType: 'number', display: Number.isFinite(value) ? String(value) : String(value), linked: false };
  }
  if (typeof value === 'boolean') {
    return { valueType: 'boolean', display: value ? 'true' : 'false', linked: false };
  }
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    return { valueType: 'string', display: text ? truncate(text, 20) : '(空)', linked: false };
  }
  if (value === null || value === undefined) {
    return { valueType: 'other', display: '(空)', linked: false };
  }
  try {
    return { valueType: 'other', display: truncate(JSON.stringify(value) ?? '', 20), linked: false };
  } catch {
    return { valueType: 'other', display: '?', linked: false };
  }
}

function inputsOf(node: PromptNode): Record<string, unknown> {
  return isRecord(node.inputs) ? node.inputs : {};
}

function titleOf(node: PromptNode): string {
  const title = String(node._meta?.title ?? '').trim();
  return title || String(node.class_type ?? '');
}

function idOrder(id: string): number {
  const value = Number(id);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * 把 ComfyUI API JSON 排成一张图。
 *
 * 分层用最长路径（不是 BFS 最短路径）：这样「被两个上游喂」的节点会排到最右边那个上游的右边，
 * 连线就全部朝右、不会出现回头线。图上若真有环（ComfyUI 理论上不该有），循环次数被
 * 节点数 + 1 卡住，排出来的位置最多是不好看，不会死循环。
 */
export function buildWorkflowGraph(
  graph: PromptGraph,
  options: { outputNodeId?: string | null; candidateIds?: ReadonlySet<string> } = {},
): WorkflowGraphView {
  const nodeIds = sortedGraphNodeIds(graph);
  const known = new Set(nodeIds);
  const candidateIds = options.candidateIds ?? new Set<string>();
  const outputNodeId = options.outputNodeId ?? null;

  // ---- 1. 边（ComfyUI API 格式：[来源节点, 输出序号] 就是一条连线）
  const rawEdges: Array<{ from: string; to: string; field: string; slot: number; toRow: number }> = [];
  for (const to of nodeIds) {
    const inputs = inputsOf(graph[to]);
    let row = 0;
    for (const [field, value] of Object.entries(inputs)) {
      if (isLink(value)) {
        if (known.has(value[0])) {
          rawEdges.push({ from: value[0], to, field, slot: value[1], toRow: row });
        }
      }
      row += 1;
    }
  }

  // ---- 2. 分层：最长路径
  const depth = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (let round = 0; round <= nodeIds.length; round += 1) {
    let changed = false;
    for (const edge of rawEdges) {
      const next = (depth.get(edge.from) ?? 0) + 1;
      if (next > (depth.get(edge.to) ?? 0)) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // ---- 3. 同层排序：先按「父节点在上一层的顺序」，再按 id 数值
  const columns = new Map<number, string[]>();
  for (const id of nodeIds) {
    const level = depth.get(id) ?? 0;
    const column = columns.get(level) ?? [];
    column.push(id);
    columns.set(level, column);
  }
  const order = new Map<string, number>();
  let orderCursor = 0;
  for (const level of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(level)!;
    const parentOrder = new Map<string, number>();
    for (const id of column) {
      let best = Number.MAX_SAFE_INTEGER;
      for (const edge of rawEdges) {
        if (edge.to !== id) continue;
        const value = order.get(edge.from);
        if (value !== undefined && value < best) best = value;
      }
      parentOrder.set(id, best);
    }
    column.sort((a, b) => {
      const pa = parentOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
      const pb = parentOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return idOrder(a) - idOrder(b);
    });
    for (const id of column) order.set(id, orderCursor++);
  }

  // ---- 4. 摆位置：列 x 固定，列内竖直堆叠后再整体居中
  const rowsOf = (id: string) => {
    const inputs = Object.entries(inputsOf(graph[id]));
    return {
      total: inputs.length,
      rows: inputs.slice(0, METRICS.maxRows),
      hidden: Math.max(0, inputs.length - METRICS.maxRows),
    };
  };
  const heightOf = (visibleRows: number) =>
    METRICS.headerHeight + METRICS.padTop + visibleRows * METRICS.rowHeight + METRICS.padBottom;

  const levels = [...columns.keys()].sort((a, b) => a - b);
  const rowsById = new Map<string, ReturnType<typeof rowsOf>>();
  const heightById = new Map<string, number>();
  for (const id of nodeIds) {
    const rows = rowsOf(id);
    rowsById.set(id, rows);
    heightById.set(id, heightOf(rows.rows.length));
  }
  const stackHeightOf = (column: readonly string[]) =>
    column.reduce((sum, id) => sum + (heightById.get(id) ?? 0), 0) +
    METRICS.rowGap * Math.max(0, column.length - 1);
  // 每列按「最高的那一列」竖直居中：不然小列全贴在顶部，图看着像阶梯
  const tallest = Math.max(0, ...levels.map((level) => stackHeightOf(columns.get(level)!)));

  const placed = new Map<string, { x: number; y: number; width: number; height: number; visible: ReturnType<typeof rowsOf> }>();
  levels.forEach((level, levelIndex) => {
    const column = columns.get(level)!;
    const x = METRICS.margin + levelIndex * (METRICS.nodeWidth + METRICS.columnGap);
    let cursorY = METRICS.margin + Math.max(0, (tallest - stackHeightOf(column)) / 2);
    for (const id of column) {
      const height = heightById.get(id) ?? 0;
      placed.set(id, { x, y: cursorY, width: METRICS.nodeWidth, height, visible: rowsById.get(id)! });
      cursorY += height + METRICS.rowGap;
    }
  });

  // ---- 5. 节点视图
  const nodes: WorkflowGraphNodeView[] = nodeIds.map((id) => {
    const node = graph[id];
    const spot = placed.get(id)!;
    const rows: WorkflowGraphRow[] = spot.visible.rows.map(([field, value]) => {
      const shown = displayOf(value);
      return {
        field,
        ...shown,
        ...(candidateIds.has(`${id}.inputs.${field}`) ? { candidateId: `${id}.inputs.${field}` } : {}),
      };
    });
    return {
      id,
      classType: String(node.class_type ?? ''),
      title: titleOf(node),
      x: spot.x,
      y: spot.y,
      width: spot.width,
      height: spot.height,
      rows,
      hiddenRows: spot.visible.hidden,
      isOutput: outputNodeId !== null && outputNodeId === id,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // ---- 6. 边：目标端按行校准，来源端按出边序号做扇出
  const edges: WorkflowGraphEdgeView[] = [];
  const fanOut = new Map<string, number>();
  const sortedRaw = [...rawEdges].sort((a, b) => {
    if (a.from !== b.from) return idOrder(a.from) - idOrder(b.from);
    const ax = byId.get(a.to)?.x ?? 0;
    const bx = byId.get(b.to)?.x ?? 0;
    if (ax !== bx) return ax - bx;
    return a.toRow - b.toRow;
  });
  for (const edge of sortedRaw) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const index = fanOut.get(edge.from) ?? 0;
    fanOut.set(edge.from, index + 1);
    edges.push({
      from: edge.from,
      to: edge.to,
      field: edge.field,
      slot: edge.slot,
      toRow: Math.min(edge.toRow, Math.max(0, to.rows.length - 1)),
      fromIndex: index,
    });
  }

  const maxX = nodes.reduce((value: number, node) => Math.max(value, node.x + node.width), METRICS.margin);
  const maxY = nodes.reduce((value: number, node) => Math.max(value, node.y + node.height), METRICS.margin);
  return {
    nodes,
    edges,
    bounds: { x: 0, y: 0, width: maxX + METRICS.margin, height: maxY + METRICS.margin },
    metrics: {
      nodeWidth: METRICS.nodeWidth,
      headerHeight: METRICS.headerHeight,
      rowHeight: METRICS.rowHeight,
      padTop: METRICS.padTop,
      maxRows: METRICS.maxRows,
    },
  };
}
