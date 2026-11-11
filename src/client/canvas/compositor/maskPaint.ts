/**
 * 手绘蒙版的绘制数学（纯函数，不碰 DOM）—— 编辑器只负责把结果画上去。
 *
 * 为什么单独一层：笔刷插值、笔刷半径、硬度渐变、反相这些都能在 jsdom 里直接测，
 * 不必先有一块真 canvas（jsdom 没有 2D 上下文）。
 *
 * 用户 2026-11-11 定的形态：遮罩要在调色面板里**画**出来，输出一张黑白图，
 * 再接到「混合」节点的系数口 —— 参照 Blender 的遮罩操作（左键画、笔刷大小/硬度可调、
 * 可以反相、可以清空）。
 */

/** 蒙版工作画布的固定宽度；高度按合成画布比例算（引擎按 UV 采样，比例对了才不变形）。 */
export const MASK_CANVAS_WIDTH = 1024;

export interface MaskCanvasSize {
  width: number;
  height: number;
}

/**
 * 蒙版画布尺寸：宽度固定 1024，高度跟帧比例走。
 * 帧尺寸不可用时按 16:9；结果夹在 64..1024（极端超宽/超高的图也不至于把内存拉爆）。
 */
export function maskCanvasSize(frameWidth: number, frameHeight: number): MaskCanvasSize {
  const width = MASK_CANVAS_WIDTH;
  const w = Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth : 16;
  const h = Number.isFinite(frameHeight) && frameHeight > 0 ? frameHeight : 9;
  const height = Math.max(64, Math.min(width, Math.round((width * h) / w)));
  return { width, height };
}

/** 笔刷直径（蒙版像素）：brushSize 存的是「占画面宽度的比例」（0.01..0.4）。 */
export function brushDiameter(brushSize: number, canvasWidth: number): number {
  const size = Number.isFinite(brushSize) ? brushSize : 0.06;
  return Math.max(1, Math.abs(size) * Math.max(1, canvasWidth));
}

/**
 * 一段笔画的落笔点：从上一点到当前点按 `spacing`（蒙版像素）插值。
 *
 * 原因：pointermove 在快速划动时几十像素才来一个点，只按事件画会变成一串圆点。
 * 返回含起点、不含终点的中间点（终点由下一次调用补上，最后再补一次终点）。
 */
export function strokePoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  spacing: number,
): Array<{ x: number; y: number }> {
  const step = Math.max(0.5, Number.isFinite(spacing) ? spacing : 2);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const points: Array<{ x: number; y: number }> = [];
  if (!Number.isFinite(distance) || distance <= 0.0001) return points;
  const count = Math.floor(distance / step);
  for (let index = 1; index <= count; index += 1) {
    const t = (index * step) / distance;
    points.push({ x: from.x + dx * t, y: from.y + dy * t });
  }
  return points;
}

/**
 * 笔刷的径向渐变停点：`hardness` 0..1 决定「实心到什么半径才开始化开」。
 * 返回 [offset, alpha] 对，编辑器按它建 createRadialGradient。
 */
export function brushGradientStops(hardness: number): Array<[number, number]> {
  const h = Math.max(0, Math.min(1, Number.isFinite(hardness) ? hardness : 0.7));
  if (h >= 0.995) return [[0, 1], [1, 1]];
  // 实心区到 h 结束，剩下 1-h 用来渐隐；太软时留一点中心强度，不然轻轻一笔看不见
  return [
    [0, 1],
    [h, 1],
    [1, 0],
  ];
}

/**
 * 反相一张黑白蒙版（就地改 RGBA）。
 *
 * 只翻 RGB、遍历步长 4；alpha 保持不变（蒙版是不透明的黑白图，alpha 本来全是 255）。
 */
export function invertMaskPixels(data: Uint8ClampedArray): void {
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 255 - data[index];
    data[index + 1] = 255 - data[index + 1];
    data[index + 2] = 255 - data[index + 2];
  }
}

/** 蒙版预览用：dataURL 是不是一张能显示的图（空串 = 还没画过）。 */
export function hasMaskImage(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image/');
}

/* ------------------------------------------------------------------ */
/* 样条遮罩（参照 Blender 的 Mask：一圈控制点 + 羽化，见 browser-check    */
/* 的 compositor-mask 场景与用户 2026-11-11 给的 Blender 截图）          */
/* ------------------------------------------------------------------ */

export interface MaskPoint {
  x: number;
  y: number;
}

/** 「两套坐标」的约定：控制点存归一化 0..1（换分辨率不变形），绘制时乘画布宽高。 */
export function splineFromParam(value: unknown): MaskPoint[] {
  if (!Array.isArray(value)) return [];
  const points: MaskPoint[] = [];
  for (let index = 0; index + 1 < value.length; index += 2) {
    const x = Number(value[index]);
    const y = Number(value[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y });
  }
  return points;
}

export function splineToParam(points: readonly MaskPoint[]): number[] {
  const out: number[] = [];
  for (const point of points) {
    out.push(Math.round(point.x * 10000) / 10000, Math.round(point.y * 10000) / 10000);
  }
  return out;
}

/** 点是否落在某个控制点的命中半径里（返回下标，没有就 -1）。 */
export function hitSplinePoint(
  points: readonly MaskPoint[],
  point: MaskPoint,
  radius: number,
): number {
  const limit = Math.max(0, radius);
  let best = -1;
  let bestDistance = Infinity;
  points.forEach((candidate, index) => {
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (distance <= limit && distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * 在最近的一条边上插入控制点（Blender 里 Ctrl+点击边 = 加点）。
 * 少于两个点时直接追加；返回新数组与插入位置，边上的点按投影位置放。
 */
export function insertSplinePoint(
  points: readonly MaskPoint[],
  point: MaskPoint,
): { points: MaskPoint[]; index: number } {
  if (points.length < 2) {
    return { points: [...points, point], index: points.length };
  }
  let bestIndex = 0;
  let bestDistance = Infinity;
  let bestPoint = point;
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)) : 0;
    const projected = { x: from.x + dx * t, y: from.y + dy * t };
    const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
      bestPoint = projected;
    }
  }
  const next = [...points];
  next.splice(bestIndex + 1, 0, bestPoint);
  return { points: next, index: bestIndex + 1 };
}

/**
 * 闭合样条 → 一串三次贝塞尔段（Catmull-Rom 转 Bezier）。
 *
 * 每个元素是 [cp1, cp2, end]（起点由上一段的终点给），可以直接喂给 ctx.bezierCurveTo
 * 或拼成 SVG 的 d。少于 3 个点时返回空数组（形不成闭合区域）。
 * 为什么是 Catmull-Rom：控制点少也能出圆滑边缘，和 Blender 里拖动控制点的观感最接近，
 * 又不用实现一整套 bezier 手柄交互。
 */
export function splineBezierSegments(
  points: readonly MaskPoint[],
): Array<[MaskPoint, MaskPoint, MaskPoint]> {
  if (points.length < 3) return [];
  const count = points.length;
  const segments: Array<[MaskPoint, MaskPoint, MaskPoint]> = [];
  for (let index = 0; index < count; index += 1) {
    const p0 = points[(index - 1 + count) % count];
    const p1 = points[index];
    const p2 = points[(index + 1) % count];
    const p3 = points[(index + 2) % count];
    const cp1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const cp2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    segments.push([cp1, cp2, p2]);
  }
  return segments;
}

/** 归一化的羽化距离 → 画面像素（0 就是硬边）。 */
export function featherPixels(feather: number, width: number): number {
  const value = Number.isFinite(feather) ? Math.abs(feather) : 0;
  return Math.max(0, value * Math.max(1, width));
}
