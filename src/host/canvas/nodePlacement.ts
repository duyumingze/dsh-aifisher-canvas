/**
 * 对话建节点的落位约束（v1.53）。
 *
 * 起因（用户 2026-10-20）：「对话生成的节点会遮罩其他的节点」。
 * canvas_control 的 create 只把 x/y 原样交给画布（vendor 的 runtime.create 是「给什么放什么」，
 * 未给坐标时落 0,0），于是 agent 连续建节点、或沿用旧坐标时，新节点直接压在地图上已有节点上面。
 *
 * 这里在 host 下发 edit 之前做一层**纯函数**的落位规划：
 *   - 显式坐标只要不和已有节点相交 → 原样保留（尊重 agent 的摆放意图）；
 *   - 没给坐标、或坐标与已有节点相交 → 放到已有内容右侧的空位（逐列向下扫描，留 40px 间隙）；
 *   - 同一批内的 create 依次排队，彼此也不重叠。
 *
 * 为什么用「类型默认尺寸」而不是画布实测尺寸：host 拿不到 DOM，read 返回的节点也不带
 * width/height；vendor 的 nodeFramework DEFAULT_NODE_SIZES 就是节点首次落位时的尺寸，
 * 与实测观感足够接近（text 360×300 / image 360×420 / video 420×360 / audio 360×220）。
 * 节点后来被手动缩放不影响「是否遮罩」的判断精度要求 —— 只要不落在一起即可。
 */

/** read 返回里落位规划真正用到的字段（其余字段原样忽略）。 */
export interface CanvasPlacementNode {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 与 vendor nodeFramework.ts 的 DEFAULT_NODE_SIZES 保持一致。 */
const NODE_DEFAULT_SIZE: Readonly<Record<string, readonly [number, number]>> = {
  text: [360, 300],
  image: [360, 420],
  video: [420, 360],
  audio: [360, 220],
};

const FALLBACK_SIZE: readonly [number, number] = [360, 320];

/** 新节点与已有节点之间至少留出的空隙（画布单位）。 */
export const PLACEMENT_GAP = 40;

function sizeOf(node: { type?: unknown; width?: unknown; height?: unknown }): readonly [number, number] {
  const preset = NODE_DEFAULT_SIZE[String(node.type ?? '').toLowerCase()] ?? FALLBACK_SIZE;
  const width =
    typeof node.width === 'number' && Number.isFinite(node.width) && node.width > 0
      ? node.width
      : preset[0];
  const height =
    typeof node.height === 'number' && Number.isFinite(node.height) && node.height > 0
      ? node.height
      : preset[1];
  return [width, height];
}

/** 节点落位尺寸（供 recipe 等复用；有实测 width/height 用实测，否则按类型默认值）。 */
export function nodeSizeOf(node: {
  type?: unknown;
  width?: unknown;
  height?: unknown;
}): readonly [number, number] {
  return sizeOf(node);
}

function overlaps(a: CanvasRect, b: CanvasRect, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

/**
 * 在已有内容右侧找最近的一块空地。
 *
 * 从「所有节点包围盒的右边」开始，一列一列向右、一列内从上往下扫描；
 * 找不到（极端情况：整个搜索窗口都被占满）就退到内容右下方。
 */
function findFreeSpot(
  occupied: readonly CanvasRect[],
  width: number,
  height: number,
): { x: number; y: number } {
  if (occupied.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...occupied.map((rect) => rect.x + rect.width));
  const top = Math.min(...occupied.map((rect) => rect.y));
  const bottom = Math.max(...occupied.map((rect) => rect.y + rect.height));
  const margin = PLACEMENT_GAP * 2;
  const stepX = width + PLACEMENT_GAP * 2;
  const stepY = height + PLACEMENT_GAP * 2;
  for (let column = 0; column < 8; column += 1) {
    const x = right + margin + column * stepX;
    for (let row = 0; row < 40; row += 1) {
      const candidate = { x, y: top + row * stepY, width, height };
      // 只要求「不遮住」，不强制 40px 全间隙（否则斜向相邻也会被误判）。
      if (!occupied.some((rect) => overlaps(candidate, rect, PLACEMENT_GAP / 2))) {
        return { x: candidate.x, y: candidate.y };
      }
    }
  }
  return { x: right + margin, y: bottom + margin };
}

/**
 * 给一批 operations 里的 create 补/改坐标，返回**新的** operations 数组（不改入参）。
 *
 * 只处理 `kind === 'create'`；update/connect/configure 等原样透传。
 */
export function placeCreateOperations(
  operations: readonly unknown[],
  nodes: readonly CanvasPlacementNode[],
): unknown[] {
  const occupied: CanvasRect[] = [];
  for (const node of nodes) {
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    const [width, height] = sizeOf(node);
    occupied.push({ x: node.x as number, y: node.y as number, width, height });
  }

  const placed: unknown[] = [];
  for (const operation of operations) {
    if (
      !operation ||
      typeof operation !== 'object' ||
      (operation as { kind?: unknown }).kind !== 'create'
    ) {
      placed.push(operation);
      continue;
    }
    const create = operation as {
      kind: string;
      type?: unknown;
      x?: unknown;
      y?: unknown;
    };
    const [width, height] = sizeOf(create);
    const hasPoint =
      typeof create.x === 'number' &&
      Number.isFinite(create.x) &&
      typeof create.y === 'number' &&
      Number.isFinite(create.y);

    if (hasPoint) {
      const candidate = {
        x: create.x as number,
        y: create.y as number,
        width,
        height,
      };
      if (!occupied.some((rect) => overlaps(candidate, rect, PLACEMENT_GAP / 2))) {
        occupied.push(candidate);
        placed.push(operation);
        continue;
      }
    }

    const spot = findFreeSpot(occupied, width, height);
    occupied.push({ x: spot.x, y: spot.y, width, height });
    placed.push({ ...(operation as Record<string, unknown>), x: spot.x, y: spot.y });
  }
  return placed;
}
