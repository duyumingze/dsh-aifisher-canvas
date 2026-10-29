/**
 * 合成器节点图（Color Grade）—— 纯数据 + 纯函数，不碰 DOM / WebGL。
 *
 * 为什么单独一层：求值顺序、端口规则、默认图、剪枝这些都能在 jsdom 里直接测，
 * 不必先摆一屏节点。真渲染由 engine.ts 负责，交互由 editor.ts 负责。
 *
 * 形态（用户 2026-10-28 拍板）：
 *   - 主编上一个「调色」节点，多图输入，点按钮进入全屏合成器；
 *   - 合成器里预置三个节点：输入（上游几张图就几个输出口）、输出、预览；
 *   - 一个效果一个节点；
 *   - Shift+T 点节点 → 自动接到预览节点（Blender 的 viewer 手势）。
 */

/** 节点种类。'input' 的输出口数量跟着上游图片数走，是唯一动态端口。 */
export type CompositorKind =
  | 'input'
  | 'output'
  | 'viewer'
  | 'reroute'
  | 'colorBalance'
  | 'whiteBalance'
  | 'curves'
  | 'hueSaturation'
  | 'brightnessContrast'
  | 'exposure'
  | 'gamma'
  | 'mix'
  | 'alphaOver'
  | 'blur'
  | 'sharpen'
  | 'vignette'
  | 'grain'
  | 'transform'
  | 'ellipseMask'
  | 'boxMask'
  | 'gradientMask';

/** 参数值：标量、颜色（rgba 0..1）、曲线控制点（[x,y,…]）。 */
export type CompositorParamValue = number | number[] | string | boolean;

export interface CompositorNode {
  id: string;
  kind: CompositorKind;
  x: number;
  y: number;
  /** kind 决定默认参数；存下来的只有用户改过的值，缺的按默认补。 */
  params: Record<string, CompositorParamValue>;
  title?: string;
}

export interface CompositorEdge {
  id: string;
  fromNode: string;
  /** 输出口序号（input 节点第 N 张图 = N）。 */
  fromPort: number;
  toNode: string;
  /** 输入口序号（mix 的 A=0 / B=1）。 */
  toPort: number;
}

export interface CompositorGraph {
  version: 1;
  nodes: CompositorNode[];
  edges: CompositorEdge[];
  /** 编辑器自己的视图状态（平移/缩放），与图像无关，但一起存省一次写。 */
  view?: { x: number; y: number; scale: number };
  /** 示波器面板状态：看哪张图、开没开、面板多大（用户 2026-10-29 要求面板能调大小）。 */
  scope?: { kind: string; visible: boolean; width: number; height: number };
}

/** 主画布传进来的上游图片，顺序即输入节点的端口顺序。 */
export interface CompositorInputImage {
  nodeId: string;
  url: string;
  title?: string;
}

export interface CompositorNodeSpec {
  label: string;
  category: '基础' | '颜色' | '混合' | '滤镜' | '蒙版';
  inputs: number;
  outputs: number;
  /** input 节点专用：输出口数量等于上游图片数。 */
  dynamicOutputs?: boolean;
  /** 编辑器里的默认标题；缺省用 label。 */
  defaults?: Record<string, CompositorParamValue>;
}

/**
 * 节点规格表。
 *
 * 端口数量是硬契约：edge 的 fromPort/toPort 直接索引它，改这里等于改已存图的语义，
 * 所以新增效果时只追加、不改已有条目的 inputs/outputs。
 */
export const NODE_SPECS: Record<CompositorKind, CompositorNodeSpec> = {
  input: { label: '输入图像', category: '基础', inputs: 0, outputs: 1, dynamicOutputs: true },
  output: { label: '输出', category: '基础', inputs: 1, outputs: 0 },
  viewer: { label: '预览', category: '基础', inputs: 1, outputs: 0 },
  // 转接点（Blender 的 Reroute）：一路进、一路出，纯整理走向；求值就是原样拷贝上游。
  // 不放进「可删除的固定节点」名单 —— 用户可以像普通节点一样 Delete 它。
  reroute: { label: '转接点', category: '基础', inputs: 1, outputs: 1 },

  // 色彩平衡 = Blender Color Balance 那套四轮调色（用户 2026-10-29 给的参照图）：
  // 暗部 / 中灰 / 亮部 / 偏移 各一个色轮，值就是界面上的数字（0.00 / 1.00 / 25.00 为中性）。
  // 参数从 9 个扩到 12 个：老项目里没有 offsetR/G/B 的按 25 补（见 paramsOf）。
  colorBalance: {
    label: '色彩平衡',
    category: '颜色',
    inputs: 1,
    outputs: 1,
    defaults: {
      liftR: 0,
      liftG: 0,
      liftB: 0,
      gammaR: 0,
      gammaG: 0,
      gammaB: 0,
      gainR: 1,
      gainG: 1,
      gainB: 1,
      offsetR: 25,
      offsetG: 25,
      offsetB: 25,
    },
  },
  whiteBalance: {
    label: '白平衡',
    category: '颜色',
    inputs: 1,
    outputs: 1,
    defaults: { temperature: 5600, tint: 0 },
  },
  curves: {
    label: '曲线',
    category: '颜色',
    inputs: 1,
    outputs: 1,
    // 分通道曲线：主曲线 points，单通道 pointsR / pointsG / pointsB（缺省 = 恒等）。
    // 老图里只有 points 的照样能开：单通道按直线补。
    defaults: { channel: 'rgb', points: [0, 0, 1, 1] },
  },
  hueSaturation: {
    label: '色相/饱和度',
    category: '颜色',
    inputs: 1,
    outputs: 1,
    defaults: { hue: 0, saturation: 0, lightness: 0 },
  },
  brightnessContrast: {
    label: '亮度/对比度',
    category: '颜色',
    inputs: 1,
    outputs: 1,
    defaults: { brightness: 0, contrast: 0 },
  },
  exposure: { label: '曝光', category: '颜色', inputs: 1, outputs: 1, defaults: { exposure: 0 } },
  gamma: { label: 'Gamma', category: '颜色', inputs: 1, outputs: 1, defaults: { gamma: 1 } },

  // 混合 = Blender 的 Mix 节点：A / B 两路图像 + 一个**系数**输入口。
  // 系数口（toPort=2）接灰度图或蒙版时按像素驱动 factor（引擎里乘在滑块上），
  // 不接就是纯滑块的 0..1 —— 所以老图（只有 A/B 两条线）语义不变。
  mix: {
    label: '混合',
    category: '混合',
    inputs: 3,
    outputs: 1,
    defaults: { mode: 'normal', factor: 1 },
  },
  alphaOver: { label: 'Alpha 上叠', category: '混合', inputs: 2, outputs: 1, defaults: { factor: 1 } },

  blur: { label: '模糊', category: '滤镜', inputs: 1, outputs: 1, defaults: { radius: 8 } },
  sharpen: { label: '锐化', category: '滤镜', inputs: 1, outputs: 1, defaults: { amount: 0.5 } },
  vignette: {
    label: '暗角',
    category: '滤镜',
    inputs: 1,
    outputs: 1,
    defaults: { amount: 0.5, softness: 0.5, roundness: 0.5 },
  },
  grain: { label: '颗粒', category: '滤镜', inputs: 1, outputs: 1, defaults: { amount: 0.15 } },
  transform: {
    label: '变换',
    category: '滤镜',
    inputs: 1,
    outputs: 1,
    defaults: { translateX: 0, translateY: 0, scale: 1, rotation: 0 },
  },

  ellipseMask: {
    label: '椭圆蒙版',
    category: '蒙版',
    inputs: 0,
    outputs: 1,
    defaults: { width: 0.8, height: 0.8, softness: 0.1, invert: false },
  },
  boxMask: {
    label: '矩形蒙版',
    category: '蒙版',
    inputs: 0,
    outputs: 1,
    defaults: { width: 0.8, height: 0.8, softness: 0.1, invert: false },
  },
  gradientMask: {
    label: '渐变蒙版',
    category: '蒙版',
    inputs: 0,
    outputs: 1,
    defaults: { angle: 90, offset: 0, softness: 0.8, invert: false },
  },
};

/** 能当「图像输出」被主画布下游消费的，只有 output 节点的结果。 */
export const OUTPUT_KIND: CompositorKind = 'output';

/**
 * 多输入节点的端口名（鼠标悬停提示 + 无障碍）。
 *
 * 用户 2026-10-29：「混合节点应该有三个输入通道，a b 和系数」—— Blender 的 Mix
 * 就是 A / B / Factor 三个口，第三个口接灰度就能按像素控混合量。
 */
export const INPUT_PORT_LABELS: Partial<Record<CompositorKind, readonly string[]>> = {
  mix: ['A 上层', 'B 底层', '系数（灰度 / 蒙版）'],
  alphaOver: ['A 上层', 'B 底层'],
};

/** 第 index 个输入口的显示名；没登记的走「输入 N」。 */
export function inputPortLabel(kind: CompositorKind, index: number): string {
  const labels = INPUT_PORT_LABELS[kind];
  return labels?.[index] ?? `输入 ${index + 1}`;
}

export function specOf(kind: CompositorKind): CompositorNodeSpec {
  return NODE_SPECS[kind];
}

/** 某个节点实际有几个输出口：输入节点跟着上游图片数走。 */
export function outputPortCount(kind: CompositorKind, inputCount: number): number {
  return NODE_SPECS[kind].dynamicOutputs ? Math.max(1, inputCount) : NODE_SPECS[kind].outputs;
}

/** 缺省参数补齐：老图里没有的新字段不该让求值崩。 */
export function paramsOf(node: CompositorNode): Record<string, CompositorParamValue> {
  return { ...(NODE_SPECS[node.kind].defaults || {}), ...(node.params || {}) };
}

/** 输入节点端口顺序 = 上游 parentIds 顺序（主画布那边是同一个数组）。 */
export function inputPortsFor(edges: readonly CompositorEdge[], inputId: string): number[] {
  return edges
    .filter((edge) => edge.fromNode === inputId)
    .map((edge) => edge.fromPort)
    .sort((a, b) => a - b);
}

/**
 * 从目标节点反向收集依赖，返回「上游先、目标最后」的求值顺序。
 * 环直接判错：合成图不该有环，有环时宁可报错也不要无限递归。
 */
export function evaluationOrder(
  graph: CompositorGraph,
  targetId: string,
): { order: string[]; error?: string } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!byId.has(targetId)) return { order: [], error: `目标节点不存在：${targetId}` };
  const incoming = new Map<string, CompositorEdge[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.fromNode) || !byId.has(edge.toNode)) continue;
    const list = incoming.get(edge.toNode) ?? [];
    list.push(edge);
    incoming.set(edge.toNode, list);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const order: string[] = [];
  const visit = (id: string): string | null => {
    const mark = state.get(id);
    if (mark === 'done') return null;
    if (mark === 'visiting') return `节点图出现环：${byId.get(id)?.title || id}`;
    state.set(id, 'visiting');
    for (const edge of incoming.get(id) ?? []) {
      const error = visit(edge.fromNode);
      if (error) return error;
    }
    state.set(id, 'done');
    order.push(id);
    return null;
  };
  const error = visit(targetId);
  return error ? { order: [], error } : { order, error: undefined };
}

/** 目标节点的某个输入口接的是谁；没接返回 null。 */
export function upstreamOf(
  graph: CompositorGraph,
  nodeId: string,
  port: number,
): string | null {
  const edge = graph.edges.find((item) => item.toNode === nodeId && item.toPort === port);
  return edge ? edge.fromNode : null;
}

/** 新建一条边前先做替换：一个输入口只能有一条线（Blender 同款语义）。 */
export function connect(
  graph: CompositorGraph,
  fromNode: string,
  fromPort: number,
  toNode: string,
  toPort: number,
): CompositorGraph {
  if (fromNode === toNode) return graph;
  const nodes = new Set(graph.nodes.map((node) => node.id));
  if (!nodes.has(fromNode) || !nodes.has(toNode)) return graph;
  const edges = graph.edges.filter((edge) => !(edge.toNode === toNode && edge.toPort === toPort));
  edges.push({ id: edgeId(fromNode, fromPort, toNode, toPort), fromNode, fromPort, toNode, toPort });
  return { ...graph, edges };
}

export function disconnectEdge(graph: CompositorGraph, edgeId: string): CompositorGraph {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
}

/**
 * 把节点插进一条已有的连线（Blender 的「拖到线上松手就串进去」）。
 *
 * 语义：拆除 `fromPort → edge.toNode:edge.toPort`，换成
 * `fromPort → 新节点输入 0` 与 `新节点输出 0 → 原来的输入口`。
 * 只有「一进一出」的节点能这么串；输入 / 输出 / 预览 / 蒙版（0 进）一律返回原图，
 * 已经在链上的节点也不重复插（否则会自己接自己）。
 */
export function insertNodeIntoEdge(
  graph: CompositorGraph,
  nodeId: string,
  edgeId: string,
): CompositorGraph {
  const node = graph.nodes.find((item) => item.id === nodeId);
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!node || !edge) return graph;
  if (edge.fromNode === nodeId || edge.toNode === nodeId) return graph;
  const spec = specOf(node.kind);
  if (spec.inputs < 1 || spec.outputs < 1) return graph;
  const remaining = graph.edges.filter((item) => item.id !== edgeId);
  let next: CompositorGraph = { ...graph, edges: remaining };
  next = connect(next, edge.fromNode, edge.fromPort, nodeId, 0);
  next = connect(next, nodeId, 0, edge.toNode, edge.toPort);
  return next;
}

/** 节点能不能被串进连线（一进一出）。编辑器用它挡掉输入/输出/预览/蒙版。 */
export function canInsertIntoEdge(kind: CompositorKind): boolean {
  const spec = specOf(kind);
  return spec.inputs >= 1 && spec.outputs >= 1;
}

/** 自动避让时两个节点之间至少留多少像素（世界坐标）。 */
export const NODE_LAYOUT_GAP = 40;

export interface NodeLayoutSize {
  width: number;
  height: number;
}

/** 一个节点要挪到哪儿（只回有变化的那些）。 */
export interface NodePlacement {
  id: string;
  x: number;
  y: number;
}

/**
 * 落地避让：让刚放下（或刚串进连线）的节点不再压住别人。
 *
 * 用户 2026-10-30：「做一个当节点拖入线段接入后会自动调整节点位置，现在我加入一个
 * 较长的节点时节点会被遮住」—— 色彩平衡卡片宽 792px（四个色轮横排），串进
 * 输入→预览那条线时会把左右两边的卡片都盖住。
 *
 * 规则（确定性、可回归，不碰 vendor）：
 *   ① 锚点（刚放下的节点）**位置不动**：用户放哪儿就是哪儿，纵向更是他自己选的；
 *   ② 从锚点向右 BFS：压到谁就把谁推到锚点右边 40px（其他节点同理，向两侧推）；
 *   ③ 被推开的节点继续向外推，一条链整体平移，不会挤成一团；
 *   ④ 最后补一遍残余重叠（推过去以后又压到更远的节点）。
 *
 * 只回「挪动清单」而不是新图：节点卡片里的控件闭包握着节点对象，
 * 换掉对象身份会让色轮/曲线改到一份已经没人看的副本上（v1.79 踩过）。
 */
export function resolveNodeOverlaps(
  graph: CompositorGraph,
  anchorId: string,
  sizeOf: (node: CompositorNode) => NodeLayoutSize,
  gap = NODE_LAYOUT_GAP,
): NodePlacement[] {
  const anchor = graph.nodes.find((node) => node.id === anchorId);
  if (!anchor) return [];
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sizes = new Map<string, NodeLayoutSize>();
  const sizeFor = (node: CompositorNode): NodeLayoutSize => {
    let size = sizes.get(node.id);
    if (!size) {
      size = sizeOf(node);
      sizes.set(node.id, size);
    }
    return size;
  };
  const rectOf = (node: CompositorNode) => {
    const size = sizeFor(node);
    return { left: node.x, top: node.y, right: node.x + size.width, bottom: node.y + size.height };
  };
  const overlaps = (a: CompositorNode, b: CompositorNode): boolean => {
    const ra = rectOf(a);
    const rb = rectOf(b);
    return ra.left < rb.right + gap && rb.left < ra.right + gap && ra.top < rb.bottom + gap && rb.top < ra.bottom + gap;
  };

  // ① 从锚点向右 BFS 推开（锚点不动）
  const visited = new Set<string>([anchorId]);
  let frontier: string[] = [anchorId];
  for (let pass = 0; pass < 96 && frontier.length; pass += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const current = byId.get(id);
      if (!current) continue;
      for (const other of nodes) {
        if (visited.has(other.id)) continue;
        if (!overlaps(current, other)) continue;
        const currentCenter = current.x + sizeFor(current).width / 2;
        const otherCenter = other.x + sizeFor(other).width / 2;
        if (otherCenter >= currentCenter) other.x = current.x + sizeFor(current).width + gap;
        else other.x = current.x - gap - sizeFor(other).width;
        visited.add(other.id);
        next.push(other.id);
      }
    }
    frontier = next;
  }

  // ② 残余重叠：右侧那个再往右挪（最多几轮，避免把整张图推到很远）
  for (let pass = 0; pass < 6; pass += 1) {
    let moved = false;
    for (const a of nodes) {
      if (a.id === anchorId) continue;
      for (const b of nodes) {
        if (a.id === b.id || b.id === anchorId) continue;
        if (!overlaps(a, b)) continue;
        const left = a.x + sizeFor(a).width / 2 <= b.x + sizeFor(b).width / 2 ? a : b;
        const right = left === a ? b : a;
        right.x = Math.max(right.x, left.x + sizeFor(left).width + gap);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const placements: NodePlacement[] = [];
  for (const node of nodes) {
    const original = graph.nodes.find((item) => item.id === node.id);
    if (!original) continue;
    if (original.x !== node.x || original.y !== node.y) {
      placements.push({ id: node.id, x: node.x, y: node.y });
    }
  }
  return placements;
}

/** 删节点时连带删掉它两侧的边。 */
export function removeNode(graph: CompositorGraph, nodeId: string): CompositorGraph {
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter((edge) => edge.fromNode !== nodeId && edge.toNode !== nodeId),
  };
}

/** 稳定边 id：同一对端口重复连接时不会长出新 id。 */
export function edgeId(fromNode: string, fromPort: number, toNode: string, toPort: number): string {
  return `${fromNode}:${fromPort}->${toNode}:${toPort}`;
}

let sequence = 0;
/** 编辑器内新节点 id；只要求当前图里唯一，不进主画布命名空间。 */
export function newCompositorId(kind: CompositorKind): string {
  sequence += 1;
  return `${kind}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

/**
 * 默认图：输入 → 输出，输入 → 预览。
 * 输入节点的输出口数量由 upstream 图片数决定，节点本身只有一张卡片。
 */
export function createDefaultGraph(inputCount: number): CompositorGraph {
  const inputNode: CompositorNode = {
    id: 'input',
    kind: 'input',
    x: 80,
    y: 220,
    params: {},
    title: '输入图像',
  };
  const outputNode: CompositorNode = { id: 'output', kind: 'output', x: 720, y: 120, params: {} };
  const viewerNode: CompositorNode = { id: 'viewer', kind: 'viewer', x: 720, y: 360, params: {} };
  const ports = outputPortCount('input', inputCount);
  const edges: CompositorEdge[] = [];
  for (let port = 0; port < ports; port += 1) {
    edges.push({
      id: edgeId('input', port, 'output', 0),
      fromNode: 'input',
      fromPort: port,
      toNode: 'output',
      toPort: 0,
    });
    edges.push({
      id: edgeId('input', port, 'viewer', 0),
      fromNode: 'input',
      fromPort: port,
      toNode: 'viewer',
      toPort: 0,
    });
  }
  return { version: 1, nodes: [inputNode, outputNode, viewerNode], edges };
}

/** 兼容性修补：老图 / 外部写入的图进编辑器前先过一遍。 */export function normalizeGraph(value: unknown, inputCount: number): CompositorGraph {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const source = record(value);
  const nodesIn = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes: CompositorNode[] = [];
  for (const raw of nodesIn) {
    const item = record(raw);
    const kind = String(item.kind || '') as CompositorKind;
    if (!(kind in NODE_SPECS)) continue;
    const id = String(item.id || '');
    if (!id) continue;
    nodes.push({
      id,
      kind,
      x: Number.isFinite(Number(item.x)) ? Number(item.x) : 0,
      y: Number.isFinite(Number(item.y)) ? Number(item.y) : 0,
      params: { ...record(item.params) } as Record<string, CompositorParamValue>,
      title: typeof item.title === 'string' ? item.title : undefined,
    });
  }
  if (!nodes.length) return createDefaultGraph(inputCount);
  const ids = new Set(nodes.map((node) => node.id));
  const edges: CompositorEdge[] = [];
  for (const raw of Array.isArray(source.edges) ? source.edges : []) {
    const item = record(raw);
    const fromNode = String(item.fromNode || '');
    const toNode = String(item.toNode || '');
    if (!ids.has(fromNode) || !ids.has(toNode)) continue;
    const fromPort = Math.max(0, Math.trunc(Number(item.fromPort) || 0));
    const toPort = Math.max(0, Math.trunc(Number(item.toPort) || 0));
    edges.push({ id: edgeId(fromNode, fromPort, toNode, toPort), fromNode, fromPort, toNode, toPort });
  }
  const view = record(source.view);
  const scope = record(source.scope);
  return {
    version: 1,
    nodes,
    edges,
    view:
      Number.isFinite(Number(view.x)) && Number.isFinite(Number(view.scale))
        ? { x: Number(view.x), y: Number(view.y), scale: Number(view.scale) }
        : undefined,
    // 示波器状态：老图没有这一段就留 undefined（编辑器回默认值），有就只挑认得的字段
    scope:
      typeof scope.kind === 'string' || Number.isFinite(Number(scope.width))
        ? {
            kind: typeof scope.kind === 'string' ? scope.kind : 'waveform',
            visible: scope.visible !== false,
            width: Number.isFinite(Number(scope.width)) ? Number(scope.width) : 0,
            height: Number.isFinite(Number(scope.height)) ? Number(scope.height) : 0,
          }
        : undefined,
  };
}

/** 目标节点的 0 号输入口是不是直接接着「输入图像」（没经过任何效果）。 */
export function targetIsRawInput(graph: CompositorGraph, targetId: string): boolean {
  const inputId = graph.nodes.find((node) => node.kind === 'input')?.id;
  if (!inputId) return false;
  return graph.edges.some(
    (edge) => edge.toNode === targetId && edge.toPort === 0 && edge.fromNode === inputId,
  );
}

/**
 * 「保存并退出」导哪个口，按顺序尝试。
 *
 * 用户的实际操作是先看预览：新节点拖到「输入 → 预览」那条线上、调完色，
 * 而输出节点还接着原图（默认图 input→output 本来就在）。这时若按输出导出，
 * 会得到**没调过色的图**，用户看到的就是「调完色没有图像输出」。
 * 所以：预览链真的接了效果、而输出还接着原图（或没接线）时，先导预览。
 * 两边接的是同一条链时两者等价，仍按输出优先（Blender 语义）。
 */
export function chooseApplyTargets(graph: CompositorGraph): Array<'output' | 'viewer'> {
  const hasOutput = graph.edges.some((edge) => edge.toNode === 'output');
  const hasViewer = graph.edges.some((edge) => edge.toNode === 'viewer');
  if (!hasOutput && !hasViewer) return [];
  const viewerGrades = hasViewer && !targetIsRawInput(graph, 'viewer');
  if (viewerGrades && (!hasOutput || targetIsRawInput(graph, 'output'))) {
    return ['viewer', 'output'];
  }
  return ['output', 'viewer'];
}
