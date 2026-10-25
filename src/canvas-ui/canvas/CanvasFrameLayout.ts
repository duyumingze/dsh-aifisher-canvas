/**
 * 「截帧结果落位」（v1.66）。
 *
 * 用户原话（2026-10-23）：「完善视频截取首尾帧功能」。
 *
 * 上游把截出来的图固定放在 `source.x + 400` / `source.y ± 150`：
 *   · 400 是拍的数，视频卡实际宽度会随比例/自适应尺寸变化，宽片子会被压住；
 *   · 右侧已经有节点时直接叠上去，叠完还看不见（截完像"什么都没发生"）；
 *   · 一张和两张用同一套偏移，两张之间也不是按节点高度算的。
 *
 * 这里只算**位置**（不碰节点、不碰 vendor 的字段）：贴着视频右侧留 60px，垂直方向以视频
 * 中线为准上下居中排开（首帧在上、尾帧在下），整组矩形与画布上已有节点相交就整列右移。
 * 纯函数，回归在构建产物上直接验（`canvasApp.placeFrameNodes`）。
 */

export interface FrameLayoutNode {
  id?: string;
  type?: string;
  x: number;
  y: number;
  width?: unknown;
  height?: unknown;
  resultAspectRatio?: unknown;
  aspectRatio?: unknown;
}

/** vendor 传进来的帧描述（只用得上条数与顺序；title 留给诊断）。 */
export interface FrameLayoutItem {
  title?: string;
  offset?: number;
}

export interface FrameLayoutOptions {
  /** 帧节点（图片卡）的宽。默认 365，与图片节点默认宽一致。 */
  frameWidth?: number;
  /** 列间距（视频右缘 → 第一张图，以及列与列之间）。 */
  gap?: number;
  /** 同一列里两张帧之间的间距。 */
  verticalGap?: number;
  /** 最多试几列，超过就用「画布最右 + gap」。 */
  maxColumns?: number;
}

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FRAME_LAYOUT_GAP = 60;
export const FRAME_LAYOUT_VERTICAL_GAP = 40;
export const FRAME_LAYOUT_WIDTH = 365;
export const FRAME_LAYOUT_MAX_COLUMNS = 8;

/** 常见节点类型的兜底宽高（拿不到 width/height 时用，只服务于"别叠上去"）。 */
const FALLBACK_WIDTH: Record<string, number> = {
  Video: 385,
  'Upload Video': 385,
  Audio: 365,
  'Upload Audio': 365,
  Text: 252,
  ComfyUI: 520,
};
const DEFAULT_FALLBACK_WIDTH = 365;

function positive(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function ratioOf(value: unknown, separator: '/' | ':'): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split(separator);
  if (parts.length !== 2) return undefined;
  const width = positive(parts[0]);
  const height = positive(parts[1]);
  return width && height ? width / height : undefined;
}

/** 节点的宽高比：`resultAspectRatio`（"1920/1080"）优先，其次 `aspectRatio`（"16:9"）。 */
export function frameAspectRatio(node: FrameLayoutNode | null | undefined): number {
  if (!node) return 16 / 9;
  return (
    ratioOf(node.resultAspectRatio, '/') ??
    ratioOf(node.aspectRatio, ':') ??
    (node.type === 'Text' ? 1 : node.type === 'Audio' || node.type === 'Upload Audio' ? 4 : 16 / 9)
  );
}

/** 估一个节点的占位矩形（画布节点是宽松对象，宽高点不到就按类型兜底）。 */
export function estimateNodeSize(node: FrameLayoutNode): { width: number; height: number } {
  const width =
    positive(node.width) ?? FALLBACK_WIDTH[node.type ?? ''] ?? DEFAULT_FALLBACK_WIDTH;
  const height = positive(node.height) ?? Math.max(80, width / frameAspectRatio(node));
  return { width, height };
}

/** 两个矩形是否相交（边贴边不算）。 */
export function frameRectsOverlap(a: FrameRect, b: FrameRect): boolean {
  if (!a || !b) return false;
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

function overlapsAny(rect: FrameRect, others: FrameRect[]): boolean {
  return others.some((other) => frameRectsOverlap(rect, other));
}

/**
 * 算出这一批帧节点该放哪儿（按 items 顺序返回同长度的位置）。
 *
 * · `source` 是视频节点（它的 x/y 与宽高决定整组落点）；
 * · `nodes` 是当前画布上的节点（来源自己不算，它在左侧）；
 * · 同一列里上下居中排开：两张时首帧中心在视频中线之上、尾帧在之下。
 */
export function placeFrameNodes(
  source: FrameLayoutNode | null | undefined,
  items: readonly FrameLayoutItem[],
  nodes: readonly FrameLayoutNode[] = [],
  options: FrameLayoutOptions = {},
): FrameRect[] {
  const count = items.length;
  if (!source || count === 0) return [];
  const gap = positive(options.gap) ?? FRAME_LAYOUT_GAP;
  const verticalGap = positive(options.verticalGap) ?? FRAME_LAYOUT_VERTICAL_GAP;
  const frameWidth = positive(options.frameWidth) ?? FRAME_LAYOUT_WIDTH;
  const maxColumns = Math.max(1, Math.trunc(positive(options.maxColumns) ?? FRAME_LAYOUT_MAX_COLUMNS));
  const frameHeight = Math.max(80, frameWidth / frameAspectRatio(source));
  const sourceSize = estimateNodeSize(source);
  const height = count * frameHeight + Math.max(0, count - 1) * verticalGap;
  const startY = source.y + (sourceSize.height - height) / 2;

  const occupied: FrameRect[] = nodes
    .filter((node) => node && node !== source && node.id !== source.id)
    .map((node) => {
      const size = estimateNodeSize(node);
      return { x: node.x, y: node.y, width: size.width, height: size.height };
    });

  const column = (index: number): FrameRect[] => {
    const x = source.x + sourceSize.width + gap + index * (frameWidth + gap);
    return Array.from({ length: count }, (_, slot) => ({
      x,
      y: startY + slot * (frameHeight + verticalGap),
      width: frameWidth,
      height: frameHeight,
    }));
  };

  for (let step = 0; step < maxColumns; step += 1) {
    const rects = column(step);
    if (!rects.some((rect) => overlapsAny(rect, occupied))) return rects;
  }
  // 所有列都被占了：贴着整张画布最右再往右排（宁可远，也不要叠）
  const rightEdge = Math.max(
    source.x + sourceSize.width,
    ...occupied.map((rect) => rect.x + rect.width),
  );
  return Array.from({ length: count }, (_, slot) => ({
    x: rightEdge + gap,
    y: startY + slot * (frameHeight + verticalGap),
    width: frameWidth,
    height: frameHeight,
  }));
}

export interface FrameLayoutAdapter {
  place(
    source: FrameLayoutNode,
    items: readonly FrameLayoutItem[],
    nodes?: readonly FrameLayoutNode[],
    options?: FrameLayoutOptions,
  ): FrameRect[];
}

interface FrameLayoutHolder {
  __FISHERAI_FRAME_LAYOUT__?: FrameLayoutAdapter;
}

/**
 * 装配层调用：把落位算法挂成 `window.__FISHERAI_FRAME_LAYOUT__`。
 *
 * vendor 的 `canvasMediaOperations.snapshot()` 只做一件事：拿这个桥算出的 x/y 贴到新节点上；
 * 桥不在（单测直接挂组件、或 vendor 版本对不上）就退回上游的 `source.x + 400`。
 */
export function installFrameLayout(): { dispose: () => void } {
  const adapter: FrameLayoutAdapter = { place: placeFrameNodes };
  const holders = [
    window as unknown as FrameLayoutHolder,
    globalThis as unknown as FrameLayoutHolder,
  ].filter((holder, index, all) => all.indexOf(holder) === index);
  for (const holder of holders) holder.__FISHERAI_FRAME_LAYOUT__ = adapter;
  return {
    dispose() {
      for (const holder of holders) {
        if (holder.__FISHERAI_FRAME_LAYOUT__ === adapter) delete holder.__FISHERAI_FRAME_LAYOUT__;
      }
    },
  };
}

declare global {
  interface Window {
    /** dsh-aifisher-canvas v1.66：截帧结果的落位（贴视频右侧 / 避让已有节点）。 */
    __FISHERAI_FRAME_LAYOUT__?: FrameLayoutAdapter;
  }
}
