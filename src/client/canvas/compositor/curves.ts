/**
 * 曲线节点的纯逻辑 —— 控制点规范化、单调三次插值、LUT 生成。
 *
 * 为什么不用线性折线：分段直线在控制点处会折出硬边，照片曲线一拉就是「台阶」；
 * 用 Fritsch–Carlson 单调三次 Hermite（保证不越过局部极值）既顺滑又不会把黑位翻上去。
 *
 * 为什么在 sRGB 域做：曲线是「所见即所得」的调色工具（Photoshop / DaVinci 的曲线也长这样），
 * 8bit LUT 在 sRGB 域的暗部精度远好于 scene-linear；引擎侧在 shader 里直接映射编码后的值。
 *
 * 分通道：主曲线 + R/G/B 三条，最终合成进一张 256×1 的 RGBA LUT
 * （R 通道存 R 曲线、G 存 G 曲线、B 存 B 曲线），shader 三次采样就能同时应用。
 */

export interface CurvePoint {
  x: number;
  y: number;
}

/** 一个通道最多允许的控制点（再多滑块也摆不下，纯属防呆）。 */
export const MAX_CURVE_POINTS = 16;

/** 默认曲线：对角直线，等价于「不处理」。 */
export const IDENTITY_CURVE: readonly number[] = [0, 0, 1, 1];

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/**
 * 把 [x0,y0,x1,y1,…] 摊成排好序的点。
 *
 * 规则：丢掉非有限值、夹到 0..1、按 x 排序、同 x 只留最后一个（拖动时两点短暂重合会出现）；
 * 首尾强制落在 x=0 / x=1（曲线允许不覆盖全区间，区间外用端点值延伸）。
 */
export function normalizeCurvePoints(raw: readonly number[] | undefined): CurvePoint[] {
  const points: CurvePoint[] = [];
  const source = Array.isArray(raw) ? raw : [];
  for (let index = 0; index + 1 < source.length; index += 2) {
    const x = Number(source[index]);
    const y = Number(source[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x: clamp01(x), y: clamp01(y) });
  }
  points.sort((a, b) => a.x - b.x);
  const unique: CurvePoint[] = [];
  for (const point of points) {
    const last = unique[unique.length - 1];
    if (last && Math.abs(point.x - last.x) < 1e-4) unique[unique.length - 1] = { x: last.x, y: point.y };
    else unique.push({ ...point });
  }
  if (!unique.length) return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  unique[0].x = 0;
  unique[unique.length - 1].x = 1;
  if (unique.length === 1) unique.push({ x: 1, y: unique[0].y });
  return unique;
}

/** 单调三次 Hermite 的切线（Fritsch–Carlson，保证插值不超调）。 */
function tangents(points: readonly CurvePoint[]): number[] {
  const count = points.length;
  const slope: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = points[index + 1].x - points[index].x;
    slope.push(dx > 1e-6 ? (points[index + 1].y - points[index].y) / dx : 0);
  }
  const tangent = new Array<number>(count).fill(0);
  tangent[0] = slope[0] ?? 0;
  tangent[count - 1] = slope[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const before = slope[index - 1];
    const after = slope[index];
    tangent[index] = before * after <= 0 ? 0 : (before + after) / 2;
  }
  for (let index = 0; index < count - 1; index += 1) {
    const delta = slope[index];
    if (Math.abs(delta) < 1e-9) {
      tangent[index] = 0;
      tangent[index + 1] = 0;
      continue;
    }
    const a = tangent[index] / delta;
    const b = tangent[index + 1] / delta;
    const squared = a * a + b * b;
    if (squared > 9) {
      const scale = 3 / Math.sqrt(squared);
      tangent[index] = scale * a * delta;
      tangent[index + 1] = scale * b * delta;
    }
  }
  return tangent;
}

/** 在已规范化的点上求值（给 LUT 批量用，避免每次重新排序）。 */
export function curveAt(points: readonly CurvePoint[], x: number): number {
  if (!points.length) return clamp01(x);
  if (points.length === 1) return points[0].y;
  const t = clamp01(x);
  if (t <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (t >= last.x) return last.y;
  let index = 0;
  while (index < points.length - 2 && t > points[index + 1].x) index += 1;
  const current = points[index];
  const next = points[index + 1];
  const width = next.x - current.x;
  if (width <= 1e-6) return next.y;
  const tangentsCache = tangents(points);
  const m0 = tangentsCache[index];
  const m1 = tangentsCache[index + 1];
  const s = (t - current.x) / width;
  const s2 = s * s;
  const s3 = s2 * s;
  return clamp01(
    (2 * s3 - 3 * s2 + 1) * current.y +
      (s3 - 2 * s2 + s) * width * m0 +
      (-2 * s3 + 3 * s2) * next.y +
      (s3 - s2) * width * m1,
  );
}

/** 便捷入口：直接对扁平数组求值（编辑器画路径 / 回归用）。 */
export function curveValue(raw: readonly number[] | undefined, x: number): number {
  return curveAt(normalizeCurvePoints(raw), x);
}

export interface CurveParams {
  /** 主曲线（等价于同时作用于三个通道）。 */
  points?: unknown;
  pointsR?: unknown;
  pointsG?: unknown;
  pointsB?: unknown;
}

function pointsOf(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.map((item) => Number(item));
  if (numbers.length < 4 || numbers.some((item) => !Number.isFinite(item))) return null;
  return numbers;
}

/** 曲线参数是不是「全默认」：是的话引擎可以跳过 LUT。 */
export function curvesAreIdentity(params: CurveParams): boolean {
  const master = pointsOf(params.points);
  if (master && !isIdentity(master)) return false;
  for (const key of ['pointsR', 'pointsG', 'pointsB'] as const) {
    const channel = pointsOf(params[key]);
    if (channel && !isIdentity(channel)) return false;
  }
  return true;
}

function isIdentity(raw: readonly number[]): boolean {
  return (
    raw.length === 4 &&
    Math.abs(raw[0] - 0) < 1e-6 &&
    Math.abs(raw[1] - 0) < 1e-6 &&
    Math.abs(raw[2] - 1) < 1e-6 &&
    Math.abs(raw[3] - 1) < 1e-6
  );
}

/**
 * 生成 256×1 RGBA LUT：先过主曲线，再过对应通道曲线（与 Blender 的顺序一致）。
 * 返回的字节按 sRGB 0..255 存，texture 用 LINEAR 采样。
 */
export function buildCurveLut(params: CurveParams): Uint8Array {
  const master = normalizeCurvePoints(pointsOf(params.points) ?? IDENTITY_CURVE.slice());
  const channels: Array<CurvePoint[] | null> = [
    pointsOf(params.pointsR),
    pointsOf(params.pointsG),
    pointsOf(params.pointsB),
  ].map((raw) => (raw ? normalizeCurvePoints(raw) : null));
  const lut = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    const encoded = index / 255;
    const base = curveAt(master, encoded);
    for (let channel = 0; channel < 3; channel += 1) {
      const curve = channels[channel];
      const value = curve ? curveAt(curve, base) : base;
      lut[index * 4 + channel] = Math.round(clamp01(value) * 255);
    }
    lut[index * 4 + 3] = 255;
  }
  return lut;
}

/** 曲线控制点的增删（editor 的点击加点到 / 双击删点用）。 */
export function addCurvePoint(raw: readonly number[] | undefined, x: number, y: number): number[] {
  const points = normalizeCurvePoints(raw);
  if (points.length >= MAX_CURVE_POINTS) return flattenCurve(points);
  points.push({ x: clamp01(x), y: clamp01(y) });
  points.sort((a, b) => a.x - b.x);
  return flattenCurve(points);
}

export function removeCurvePoint(raw: readonly number[] | undefined, index: number): number[] {
  const points = normalizeCurvePoints(raw);
  if (points.length <= 2) return flattenCurve(points);
  // 首尾是端点，删了就缺半条曲线
  if (index <= 0 || index >= points.length - 1) return flattenCurve(points);
  points.splice(index, 1);
  return flattenCurve(points);
}

export function flattenCurve(points: readonly CurvePoint[]): number[] {
  const flat: number[] = [];
  for (const point of points) flat.push(Number(point.x.toFixed(4)), Number(point.y.toFixed(4)));
  return flat;
}
