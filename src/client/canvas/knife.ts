/**
 * 切刀（Ctrl + 右键拖拽）—— dsh-aifisher-canvas v1.49
 *
 * 用户原话（2026-10-19）：
 *   「现在做一个新功能，像blender一样按住ctrl加鼠标右键切换到切刀工具，划过的线会断开连接」。
 *
 * ## 行为
 *
 *   按住 Ctrl（mac 上 Meta 等价）+ 鼠标右键按下，画布上就进入切刀：
 *   - 拖拽画一条自由曲线（像 Blender 的切刀那样），划过的连线**当场变红**（= 会被切开）；
 *   - 松手 → 被划到的连线全部断开（`parentIds` 里对应那一项被摘掉，与双击断开同一条路径）；
 *   - 拖拽中按 Esc 取消，一刀不落；
 *   - 拖拽中右键弹菜单被压住（否则 Windows 上按下去先弹菜单、手势直接断掉）。
 *
 * ## 分工（改它之前先读这段）
 *
 *   - **手势 / 预览 / 命中** 全在这里：纯 DOM，不碰 vendor 的 React 状态；
 *   - **真正断开**只有 vendor 的 `canvasApplication` 做得到（它握着 `setNodes` 与连接适配器），
 *     所以落刀是调 `window.__FISHERAI_CANVAS_KNIFE__.cut(edges)`（vendor 补丁 3.8t，
 *     见 scripts/vendor-aifisher.mjs）。这与叠图切换（v1.37）、扩图（v1.38）是同一套分工。
 *
 * ## 为什么用「渲染出来的 <path>」取样，而不是自己按节点算曲线
 *
 *   连线的几何归 vendor 那套 `edgePath` / 端口函数管：端口行高、节点测高、ComfyUI 模板槽位、
 *   折叠与缩放都会让端点位置变。自己重算迟早和画面不一致（这也是 v1.47「拉线跟手」那一轮
 *   学到的：DOM 事实 > 公式）。DOM 里的 `d` 就是**画出来的那条线**，取样得到的是用户
 *   真正看到的东西；而且在 jsdom 里也能解析，回归不必真开浏览器。
 *
 * ## 坐标系
 *
 *   path 的 `d` 是画布世界坐标。要对齐指针，先乘 `#canvas-viewport-content` 的
 *   translate+scale（vendor 写在 inline style 上），再加 `#canvas-background` 的 rect
 *   左上角。Chrome 的 `getScreenCTM()` 更稳（含任意 CSS 变换），作为兜底；jsdom 里
 *   没有它就走 inline transform + rect（rect 为 0×0 时偏移为 0，正好等于回归环境）。
 */

export interface KnifePoint {
  x: number;
  y: number;
}

export interface KnifeEdgeIdentity {
  parentId: string;
  childId: string;
  portIndex: number;
}

export interface KnifeEdgePath extends KnifeEdgeIdentity {
  /** 去重用的稳定键（同一条连线在屏幕上只有一份）。 */
  key: string;
  /** 屏幕坐标下的折线采样（含两端点）。 */
  points: KnifePoint[];
}

/** 划过的线「擦到」多近算切到（屏幕像素）。 */
export const KNIFE_HIT_TOLERANCE = 6;
/** 拖动距离小于这个值视为误触（右键点一下不算切）。 */
export const KNIFE_MIN_STROKE = 10;
/** 每条贝塞尔采样多少段（只影响命中精度与开销，不影响画出来的形状）。 */
export const KNIFE_CURVE_STEPS = 24;
/** 相邻两次采样点至少差这么多像素才记一笔（去抖）。 */
const KNIFE_POINT_STEP = 2;

const OVERLAY_ATTRIBUTE = 'data-fisherai-knife-overlay';
const HIT_TARGET_SELECTOR = 'path[data-fisherai-edge-hit-target]';
const PARENT_ATTRIBUTE = 'data-fisherai-edge-parent-id';
const CHILD_ATTRIBUTE = 'data-fisherai-edge-child-id';
const PORT_ATTRIBUTE = 'data-fisherai-edge-port-index';
const STYLE_ATTRIBUTE = 'data-fisherai-knife-style';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 排查 / 回归用的读数（`canvasApp.knifeReport()`）。 */
export interface KnifeReport {
  installed: boolean;
  canvas: boolean;
  edges: number;
  bridge: boolean;
  sessions: number;
  cuts: number;
  targets: number;
  lastError: string;
  lastGesture: {
    strokeLength: number;
    targets: number;
    cut: number;
  } | null;
}

const stats: Omit<KnifeReport, 'installed' | 'canvas' | 'edges' | 'bridge'> = {
  sessions: 0,
  cuts: 0,
  targets: 0,
  lastError: '',
  lastGesture: null,
};

let installed = false;

// ---------------------------------------------------------------- 坐标与路径解析

function toNumber(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const value = Number.parseFloat(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * 从 vendor 写在 `#canvas-viewport-content` 上的 inline transform 里读出平移与缩放。
 * 认 `translate3d(...) scale(...)`（vendor 现在的写法）、`translate(...) scale(...)`、
 * 以及 `matrix(...)`（万一以后改成 matrix）。读不出来返回 null —— 调用方据此放弃这一刀，
 * 而不是把线画到错的位置上。
 */
export function knifeViewportTransform(
  value: string | null | undefined,
): { x: number; y: number; zoom: number } | null {
  if (!value) return null;
  const matrix = /matrix\(([^)]*)\)/i.exec(value);
  if (matrix) {
    const parts = matrix[1].split(',').map((part) => toNumber(part));
    if (parts.length >= 6 && parts.every((part) => part !== null)) {
      const [a, , , , e, f] = parts as number[];
      if (a > 0 && Number.isFinite(e) && Number.isFinite(f)) {
        return { x: e, y: f, zoom: a };
      }
    }
  }
  const translate = /translate(?:3d)?\(\s*([^,)]+)(?:px)?\s*,\s*([^,)]+)(?:px)?/i.exec(value);
  const scale = /scale\(\s*([^,)]+)/i.exec(value);
  if (!translate && !scale) return null;
  const x = translate ? toNumber(translate[1]) : 0;
  const y = translate ? toNumber(translate[2]) : 0;
  const zoom = scale ? toNumber(scale[1]) : 1;
  if (x === null || y === null || zoom === null || !(zoom > 0)) return null;
  return { x, y, zoom };
}

function cubicPoint(
  from: KnifePoint,
  first: KnifePoint,
  second: KnifePoint,
  end: KnifePoint,
  progress: number,
): KnifePoint {
  const remaining = 1 - progress;
  const axis = (name: 'x' | 'y') =>
    remaining ** 3 * from[name] +
    3 * remaining ** 2 * progress * first[name] +
    3 * remaining * progress ** 2 * second[name] +
    progress ** 3 * end[name];
  return { x: axis('x'), y: axis('y') };
}

function quadraticPoint(
  from: KnifePoint,
  control: KnifePoint,
  end: KnifePoint,
  progress: number,
): KnifePoint {
  const remaining = 1 - progress;
  const axis = (name: 'x' | 'y') =>
    remaining ** 2 * from[name] + 2 * remaining * progress * control[name] + progress ** 2 * end[name];
  return { x: axis('x'), y: axis('y') };
}

/**
 * 解析 SVG path 的 `d`（画布连线只会是 `M x y C …`，另外顺手认 L/Q/Z）。
 *
 * 不用 `SVGPathElement.getPointAtLength()`：jsdom 没实现（回归会直接炸），而且它需要
 * 一个**已经排版**的元素。自己采样三次贝塞尔既确定，又能在没有布局的环境里跑。
 * 解析不了（空串 / 怪写法）返回空数组 —— 这条连线就不参与切，不会误伤别的线。
 */
export function parseKnifePath(d: string, steps = KNIFE_CURVE_STEPS): KnifePoint[] {
  const tokens = String(d ?? '').match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  const points: KnifePoint[] = [];
  let index = 0;
  let cursor: KnifePoint | null = null;
  let command = '';

  const read = (): number | null => {
    const raw = tokens[index];
    if (raw === undefined || /^[a-zA-Z]$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    index += 1;
    return value;
  };
  const readPoint = (): KnifePoint | null => {
    const x = read();
    if (x === null) return null;
    const y = read();
    return y === null ? null : { x, y };
  };
  const stepCount = Math.max(2, Math.min(64, Math.round(steps)));

  while (index < tokens.length) {
    const raw = tokens[index];
    if (/^[a-zA-Z]$/.test(raw)) {
      command = raw.toUpperCase();
      index += 1;
      if (command === 'Z') {
        command = '';
        continue;
      }
    } else if (!command) {
      // 没有命令却先来了数字：这份 d 不是我们能认的形状，直接放弃。
      break;
    }

    if (command === 'M' || command === 'L') {
      const point = readPoint();
      if (!point) break;
      points.push(point);
      cursor = point;
      // `M` 后面跟多组坐标（隐式 L）在画布连线里不会出现，但认下来不亏。
      if (command === 'M') command = 'L';
    } else if (command === 'C') {
      const first = readPoint();
      const second = readPoint();
      const end = readPoint();
      if (!first || !second || !end) break;
      const from = cursor ?? first;
      for (let step = 1; step <= stepCount; step += 1) {
        points.push(cubicPoint(from, first, second, end, step / stepCount));
      }
      cursor = end;
    } else if (command === 'Q') {
      const control = readPoint();
      const end = readPoint();
      if (!control || !end) break;
      const from = cursor ?? control;
      for (let step = 1; step <= stepCount; step += 1) {
        points.push(quadraticPoint(from, control, end, step / stepCount));
      }
      cursor = end;
    } else {
      // 其它命令（A/H/V/S/T）画布连线不用；遇到就停，避免把半截路径当成真几何。
      break;
    }
  }
  return points;
}

/** 世界坐标 → 屏幕坐标（与指针同一个坐标系）。 */
export function knifePointsToScreen(
  points: readonly KnifePoint[],
  transform: { x: number; y: number; zoom: number },
  origin: KnifePoint,
): KnifePoint[] {
  return points.map((point) => ({
    x: origin.x + transform.x + point.x * transform.zoom,
    y: origin.y + transform.y + point.y * transform.zoom,
  }));
}

// ---------------------------------------------------------------- 命中判定

/** 点到线段的最短距离。 */
export function knifeDistancePointSegment(
  point: KnifePoint,
  start: KnifePoint,
  end: KnifePoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = dx * dx + dy * dy;
  if (length <= 0) return Math.hypot(point.x - start.x, point.y - start.y);
  let progress = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length;
  progress = Math.max(0, Math.min(1, progress));
  return Math.hypot(point.x - (start.x + progress * dx), point.y - (start.y + progress * dy));
}

function orientation(a: KnifePoint, b: KnifePoint, c: KnifePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** 两条线段是否真的交叉（端点接触也算，便于「只擦到一点」也能切）。 */
export function knifeSegmentsIntersect(
  a: KnifePoint,
  b: KnifePoint,
  c: KnifePoint,
  d: KnifePoint,
): boolean {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return first * second <= 0 && third * fourth <= 0 && (
    // 共线的情况要再确认包围盒有重叠，否则「延长线挨着」会被误判成交叉。
    (first !== 0 || second !== 0 || third !== 0 || fourth !== 0) ||
    (Math.min(a.x, b.x) <= Math.max(c.x, d.x) &&
      Math.min(c.x, d.x) <= Math.max(a.x, b.x) &&
      Math.min(a.y, b.y) <= Math.max(c.y, d.y) &&
      Math.min(c.y, d.y) <= Math.max(a.y, b.y))
  );
}

/** 两条线段是否「相交或距离 ≤ tolerance」。 */
export function knifeSegmentsCross(
  a: KnifePoint,
  b: KnifePoint,
  c: KnifePoint,
  d: KnifePoint,
  tolerance = KNIFE_HIT_TOLERANCE,
): boolean {
  if (knifeSegmentsIntersect(a, b, c, d)) return true;
  return (
    Math.min(
      knifeDistancePointSegment(a, c, d),
      knifeDistancePointSegment(b, c, d),
      knifeDistancePointSegment(c, a, b),
      knifeDistancePointSegment(d, a, b),
    ) <= tolerance
  );
}

/** 这一刀有没有划到这条连线。 */
export function knifeStrokeHitsEdge(
  stroke: readonly KnifePoint[],
  edge: readonly KnifePoint[],
  tolerance = KNIFE_HIT_TOLERANCE,
): boolean {
  if (stroke.length < 2 || edge.length < 2) return false;
  for (let index = 1; index < stroke.length; index += 1) {
    const start = stroke[index - 1];
    const end = stroke[index];
    // 先按包围盒排掉远处连线：一屏几十条线时这一步省掉的采样比想象中多。
    let minX = Math.min(start.x, end.x) - tolerance;
    let maxX = Math.max(start.x, end.x) + tolerance;
    let minY = Math.min(start.y, end.y) - tolerance;
    let maxY = Math.max(start.y, end.y) + tolerance;
    if (minX > maxX) [minX, maxX] = [maxX, minX];
    if (minY > maxY) [minY, maxY] = [maxY, minY];
    for (let point = 1; point < edge.length; point += 1) {
      const from = edge[point - 1];
      const to = edge[point];
      if (Math.max(from.x, to.x) < minX || Math.min(from.x, to.x) > maxX) continue;
      if (Math.max(from.y, to.y) < minY || Math.min(from.y, to.y) > maxY) continue;
      if (knifeSegmentsCross(start, end, from, to, tolerance)) return true;
    }
  }
  return false;
}

/** 这一刀会切断哪些连线（按 key 去重，顺序按渲染顺序）。 */
export function knifeCutTargets(
  stroke: readonly KnifePoint[],
  edges: readonly KnifeEdgePath[],
  tolerance = KNIFE_HIT_TOLERANCE,
): KnifeEdgePath[] {
  const hits: KnifeEdgePath[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (seen.has(edge.key)) continue;
    if (!knifeStrokeHitsEdge(stroke, edge.points, tolerance)) continue;
    seen.add(edge.key);
    hits.push(edge);
  }
  return hits;
}

// ---------------------------------------------------------------- 从画面读连线

function safeScreenMatrix(element: Element): { a: number; b: number; c: number; d: number; e: number; f: number } | null {
  const getter = (element as unknown as { getScreenCTM?: () => unknown }).getScreenCTM;
  if (typeof getter !== 'function') return null;
  try {
    const matrix = getter.call(element) as
      | { a: number; b: number; c: number; d: number; e: number; f: number }
      | null
      | undefined;
    if (!matrix) return null;
    const values = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
    return values.every((value) => Number.isFinite(value))
      ? (matrix as { a: number; b: number; c: number; d: number; e: number; f: number })
      : null;
  } catch {
    return null;
  }
}

/**
 * 读出当前画面上**所有可见连线**在屏幕坐标下的折线。
 *
 * 只认 vendor 补丁 3.8t 加在连线 `<g>` 上的身份属性；没有这些属性（补丁没生效）就
 * 返回空数组 —— 宁可切不动，也不要按 `data-edge-key` 里用 `-` 拼起来的字符串去猜
 * 哪个是 nodeId（节点 id 里也可能有 `-`，拆错就会断开错误的线）。
 */
export function collectKnifeEdges(doc: Document): KnifeEdgePath[] {
  const content = doc.getElementById('canvas-viewport-content');
  if (!content) return [];
  const surface = doc.getElementById('canvas-background');
  const rect = surface && typeof surface.getBoundingClientRect === 'function'
    ? surface.getBoundingClientRect()
    : null;
  const origin: KnifePoint =
    rect && rect.width > 1 && rect.height > 1 ? { x: rect.left, y: rect.top } : { x: 0, y: 0 };
  // 优先用 vendor 写在 inline style 上的 transform：与它画的节点/连线是同一个数，
  // 而且 jsdom 里也读得到。读不出来再退回 getScreenCTM（Chrome 有，jsdom 没有）。
  const inline = knifeViewportTransform(
    (content as HTMLElement).style ? (content as HTMLElement).style.transform : '',
  );
  const edges: KnifeEdgePath[] = [];
  for (const path of Array.from(content.querySelectorAll(HIT_TARGET_SELECTOR))) {
    const group = path.closest(`[${PARENT_ATTRIBUTE}]`);
    if (!group) continue;
    const parentId = group.getAttribute(PARENT_ATTRIBUTE) ?? '';
    const childId = group.getAttribute(CHILD_ATTRIBUTE) ?? '';
    if (!parentId || !childId) continue;
    const rawPort = group.getAttribute(PORT_ATTRIBUTE);
    const portIndex = rawPort === null ? 0 : Math.max(0, Math.trunc(Number(rawPort) || 0));
    const world = parseKnifePath(path.getAttribute('d') ?? '');
    if (world.length < 2) continue;
    let points: KnifePoint[];
    if (inline) {
      points = knifePointsToScreen(world, inline, origin);
    } else {
      const matrix = safeScreenMatrix(path);
      if (!matrix) continue;
      points = world.map((point) => ({
        x: matrix.a * point.x + matrix.c * point.y + matrix.e,
        y: matrix.b * point.x + matrix.d * point.y + matrix.f,
      }));
    }
    edges.push({
      key: `${parentId}|${childId}|${portIndex}`,
      parentId,
      childId,
      portIndex,
      points,
    });
  }
  return edges;
}

// ---------------------------------------------------------------- 手势 / 预览

interface KnifeSession {
  pointerId: number;
  stroke: KnifePoint[];
  edges: KnifeEdgePath[];
  hits: KnifeEdgePath[];
  overlay: HTMLDivElement | null;
  strokePath: SVGPathElement | null;
  strokeHalo: SVGPathElement | null;
  hintPath: SVGPathElement | null;
  hintHalo: SVGPathElement | null;
  cursor: SVGCircleElement | null;
  frame: number | null;
}

let session: KnifeSession | null = null;
let suppressContextUntil = 0;
let styleElement: HTMLStyleElement | null = null;
let readyClass = false;

const KNIFE_STYLE = `
body.fisherai-knife-ready #canvas-background { cursor: crosshair !important; }
body.fisherai-knife-cutting,
body.fisherai-knife-cutting * { cursor: crosshair !important; }
body.fisherai-knife-cutting { user-select: none !important; -webkit-user-select: none !important; }
[${OVERLAY_ATTRIBUTE}] { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
`;

function polyline(points: readonly KnifePoint[]): string {
  return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function canvasSurface(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('canvas-background');
}

/** 指针是不是在画布底盘上（jsdom 里 rect 全 0，只能用 DOM 包含关系判断）。 */
function insideCanvas(event: Event, x: number, y: number): boolean {
  const surface = canvasSurface();
  if (!surface) return false;
  const target = event.target;
  if (target instanceof Element && surface.contains(target)) return true;
  const rect = surface.getBoundingClientRect();
  return (
    rect.width > 1 &&
    rect.height > 1 &&
    x >= rect.left &&
    x <= rect.right &&
    y >= rect.top &&
    y <= rect.bottom
  );
}

function makeSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function mountOverlay(current: KnifeSession): void {
  if (typeof document === 'undefined' || !document.body) return;
  const overlay = document.createElement('div');
  overlay.setAttribute(OVERLAY_ATTRIBUTE, 'true');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '2147483000';

  const svg = makeSvgElement('svg', {
    width: '100%',
    height: '100%',
    viewBox: `0 0 ${Math.max(1, window.innerWidth || 1)} ${Math.max(1, window.innerHeight || 1)}`,
    fill: 'none',
  });
  // viewBox 用当前视口尺寸、并且 `preserveAspectRatio` 固定成 none 之外的默认：
  // 指针坐标是 client 坐标，屏幕缩放（125% 之类）下也保持一致。
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.overflow = 'visible';

  // 会被切断的连线：先在底下铺一层红光，再压一条实线（像 Blender 的切刀高亮）。
  const hintHalo = makeSvgElement('path', {
    'data-fisherai-knife-hint-halo': 'true',
    stroke: 'rgba(255, 77, 90, 0.28)',
    'stroke-width': '9',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  const hintPath = makeSvgElement('path', {
    'data-fisherai-knife-hint': 'true',
    stroke: 'rgba(255, 77, 90, 0.95)',
    'stroke-width': '2.4',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  // 刀口本身：深色描边 + 白色细线，避免在浅色画布上看不见。
  const strokeHalo = makeSvgElement('path', {
    'data-fisherai-knife-stroke-halo': 'true',
    stroke: 'rgba(9, 14, 24, 0.55)',
    'stroke-width': '5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  const strokePath = makeSvgElement('path', {
    'data-fisherai-knife-stroke': 'true',
    stroke: 'rgba(255, 255, 255, 0.96)',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'stroke-dasharray': '7 5',
  });
  const cursor = makeSvgElement('circle', {
    'data-fisherai-knife-cursor': 'true',
    r: '3.2',
    fill: 'rgba(255, 255, 255, 0.98)',
    stroke: 'rgba(9, 14, 24, 0.65)',
    'stroke-width': '1',
  });

  svg.append(hintHalo, hintPath, strokeHalo, strokePath, cursor);
  overlay.append(svg);
  document.body.appendChild(overlay);
  current.overlay = overlay;
  current.hintHalo = hintHalo;
  current.hintPath = hintPath;
  current.strokeHalo = strokeHalo;
  current.strokePath = strokePath;
  current.cursor = cursor;
}

function renderSession(current: KnifeSession): void {
  const path = polyline(current.stroke);
  if (current.strokeHalo) current.strokeHalo.setAttribute('d', path);
  if (current.strokePath) current.strokePath.setAttribute('d', path);
  current.hits = knifeCutTargets(current.stroke, current.edges);
  const hints = current.hits.map((edge) => polyline(edge.points)).join(' ');
  if (current.hintHalo) current.hintHalo.setAttribute('d', hints);
  if (current.hintPath) {
    current.hintPath.setAttribute('d', hints);
    current.hintPath.setAttribute('opacity', hints ? '1' : '0');
  }
  if (current.hintHalo) current.hintHalo.setAttribute('opacity', hints ? '1' : '0');
  const last = current.stroke[current.stroke.length - 1];
  if (current.cursor && last) {
    current.cursor.setAttribute('cx', String(last.x));
    current.cursor.setAttribute('cy', String(last.y));
  }
}

function scheduleRender(current: KnifeSession): void {
  if (typeof requestAnimationFrame !== 'function') {
    renderSession(current);
    return;
  }
  if (current.frame !== null) return;
  current.frame = requestAnimationFrame(() => {
    current.frame = null;
    if (session === current) renderSession(current);
  });
}

function strokeLength(stroke: readonly KnifePoint[]): number {
  let total = 0;
  for (let index = 1; index < stroke.length; index += 1) {
    total += Math.hypot(stroke[index].x - stroke[index - 1].x, stroke[index].y - stroke[index - 1].y);
  }
  return total;
}

function removeOverlay(current: KnifeSession, fade: boolean): void {
  if (!current.overlay) return;
  const overlay = current.overlay;
  current.overlay = null;
  if (!fade) {
    overlay.remove();
    return;
  }
  overlay.style.transition = 'opacity 180ms ease-out';
  overlay.style.opacity = '0';
  const remove = () => overlay.remove();
  if (typeof setTimeout === 'function') setTimeout(remove, 200);
  else remove();
}

function setCuttingClass(value: boolean): void {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.classList.toggle('fisherai-knife-cutting', value);
}

function setReadyClass(value: boolean): void {
  if (readyClass === value) return;
  readyClass = value;
  if (typeof document === 'undefined' || !document.body) return;
  document.body.classList.toggle('fisherai-knife-ready', value);
}

function startSession(event: PointerEvent): void {
  const current: KnifeSession = {
    pointerId: Number.isFinite(event.pointerId) ? event.pointerId : 1,
    stroke: [{ x: event.clientX, y: event.clientY }],
    edges: collectKnifeEdges(document),
    hits: [],
    overlay: null,
    strokePath: null,
    strokeHalo: null,
    hintPath: null,
    hintHalo: null,
    cursor: null,
    frame: null,
  };
  session = current;
  stats.sessions += 1;
  stats.lastError = '';
  // 拖拽期间与收刀之后的短时间内压住右键菜单（Windows 上 contextmenu 可能排在
  // pointerup 之后，用户已经松了 Ctrl 也会弹出来）。窗口只留 600ms：再长就会误伤
  // 用户「切完一刀立刻右键」的正常右键菜单。
  suppressContextUntil = now() + 600;
  setCuttingClass(true);
  mountOverlay(current);
  renderSession(current);
}

function finishSession(fadeOut = true): void {
  const current = session;
  if (!current) return;
  session = null;
  suppressContextUntil = now() + 600;
  setCuttingClass(false);
  if (current.frame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(current.frame);
    current.frame = null;
  }
  const length = strokeLength(current.stroke);
  if (length >= KNIFE_MIN_STROKE) renderSession(current);
  else current.hits = [];
  const hits = current.hits;
  let cut = 0;
  if (hits.length) {
    const bridge = (window as unknown as {
      __FISHERAI_CANVAS_KNIFE__?: {
        cut(edges: readonly KnifeEdgeIdentity[]): number;
      };
    }).__FISHERAI_CANVAS_KNIFE__;
    if (bridge && typeof bridge.cut === 'function') {
      try {
        cut = Number(bridge.cut(hits.map(({ parentId, childId, portIndex }) => ({ parentId, childId, portIndex })))) || 0;
      } catch (error) {
        stats.lastError = error instanceof Error ? error.message : String(error);
      }
    } else {
      stats.lastError = '切刀桥未装配（window.__FISHERAI_CANVAS_KNIFE__.cut 不存在）';
    }
  }
  stats.targets = hits.length;
  stats.cuts += cut;
  stats.lastGesture = { strokeLength: Math.round(length), targets: hits.length, cut };
  // 落刀后留一道淡出的红线（视觉反馈：确实切开了这几条）。
  removeOverlay(current, fadeOut);
}

function cancelSession(): void {
  const current = session;
  if (!current) return;
  session = null;
  setCuttingClass(false);
  if (current.frame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(current.frame);
    current.frame = null;
  }
  removeOverlay(current, false);
}

/** 拆掉所有监听与残留（画布卸载时调用）。 */
export function installCanvasKnife(): { dispose(): void } {
  if (installed) return { dispose: () => undefined };
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { dispose: () => undefined };
  }
  installed = true;

  if (!document.querySelector(`style[${STYLE_ATTRIBUTE}]`)) {
    const style = document.createElement('style');
    style.setAttribute(STYLE_ATTRIBUTE, 'true');
    style.textContent = KNIFE_STYLE;
    (document.head ?? document.body)?.appendChild(style);
    styleElement = style;
  }

  const onPointerDown = (event: PointerEvent) => {
    if (session) return;
    if (event.button !== 2) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    if (!insideCanvas(event, event.clientX, event.clientY)) return;
    // 这一刀必须由我们独占：vendor 的右键手势（contextmenu）不能同时开菜单。
    event.preventDefault();
    event.stopPropagation();
    startSession(event);
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = session;
    if (!current) return;
    if (Number.isFinite(event.pointerId) && event.pointerId !== current.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    // 右键已经在画布外松开（浏览器没把 pointerup 送回来）时收尾，避免手势卡死。
    if (typeof event.buttons === 'number' && (event.buttons & 2) === 0) {
      finishSession();
      return;
    }
    const last = current.stroke[current.stroke.length - 1];
    if (Math.hypot(event.clientX - last.x, event.clientY - last.y) < KNIFE_POINT_STEP) return;
    current.stroke.push({ x: event.clientX, y: event.clientY });
    scheduleRender(current);
  };

  const onPointerUp = (event: PointerEvent) => {
    const current = session;
    if (!current) return;
    if (Number.isFinite(event.pointerId) && event.pointerId !== current.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishSession();
  };

  const onPointerCancel = () => {
    if (session) cancelSession();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Control' || event.key === 'Meta') setReadyClass(true);
    if (!session) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelSession();
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Control' || event.key === 'Meta') setReadyClass(false);
  };

  const onContextMenu = (event: MouseEvent) => {
    const inside = insideCanvas(event, event.clientX, event.clientY);
    // ① 正在切；② 按住 Ctrl 在画布上（这一下就是切刀的起手，不能弹菜单）；
    // ③ 刚收刀的一小段时间里（浏览器可能把 contextmenu 排在 pointerup 之后）。
    if (session || (inside && (event.ctrlKey || event.metaKey)) || (inside && now() < suppressContextUntil)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onBlur = () => {
    setReadyClass(false);
    if (session) cancelSession();
  };

  // 用捕获阶段：必须早于 vendor 挂在画布上的 React 处理（右键菜单就挂在那儿）。
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  return {
    dispose() {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerCancel, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      cancelSession();
      setReadyClass(false);
      styleElement?.remove();
      styleElement = null;
      installed = false;
      suppressContextUntil = 0;
    },
  };
}

/** 排查 / 回归读数：装没装、认得出几条线、切过几刀。 */
export function knifeReport(): KnifeReport {
  const bridge = (window as unknown as {
    __FISHERAI_CANVAS_KNIFE__?: { cut?: unknown };
  }).__FISHERAI_CANVAS_KNIFE__;
  return {
    installed,
    canvas: Boolean(canvasSurface()),
    edges: installed ? collectKnifeEdges(document).length : 0,
    bridge: Boolean(bridge && typeof bridge.cut === 'function'),
    sessions: stats.sessions,
    cuts: stats.cuts,
    targets: stats.targets,
    lastError: stats.lastError,
    lastGesture: stats.lastGesture,
  };
}
