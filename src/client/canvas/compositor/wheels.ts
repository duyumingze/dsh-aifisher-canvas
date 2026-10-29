/**
 * 四轮调色（Lift / Gamma / Gain / Offset）的纯数学与显示口径。
 *
 * 形态照 Blender 4 的 Color Balance 节点（用户 2026-10-29 给的参照图）：
 * 四个色轮 —— 暗部（lift）/ 中灰（gamma）/ 亮部（gain）/ 偏移（offset），
 * 每个色轮下面 4 个数字（亮度 + R/G/B；偏移只有 R/G/B）、4 条彩色细滑轨、一条亮度长条。
 *
 * 存储就是界面上的数字本身（暗部/中灰默认 0.00、亮部 1.00、偏移 25.00），
 * 色轮圆点的位置由三通道的「色度分量」反算，拖圆点则按同样的映射写回三通道：
 *   · 圆点只改色度，不改平均亮度（拖动时圆点周围的三条数字此消彼长，亮度数字不动）；
 *   · 外圈 / 亮度数字 / 长条改的是平均亮度（三通道同时加减，色偏保留）。
 * 这样界面上的数字和引擎用的参数是同一个东西，老项目里存的 liftR 之类不用迁移。
 *
 * 为什么单独一层：色轮坐标换算是最容易算错、又最值得在 jsdom 里直接验的部分
 * （旋转方向、纯红落在左上 120°、顺时针拖回原值），不必先摆一屏节点。
 */

export type WheelRangeKey = 'lift' | 'gamma' | 'gain' | 'offset';

export interface WheelRangeSpec {
  key: WheelRangeKey;
  /** 节点里的中文标题（和参照图一致）。 */
  label: string;
  /** 中性值：暗部/中灰 0、亮部 1、偏移 25。 */
  neutral: number;
  min: number;
  max: number;
}

/** 四个轮的顺序就是横向排布的顺序（和参照图一致）。 */
export const WHEEL_RANGES: readonly WheelRangeSpec[] = [
  { key: 'lift', label: '暗部', neutral: 0, min: -1, max: 1 },
  { key: 'gamma', label: '中灰', neutral: 0, min: -1, max: 1 },
  { key: 'gain', label: '亮部', neutral: 1, min: 0, max: 4 },
  { key: 'offset', label: '偏移', neutral: 25, min: 0, max: 50 },
];

/** 圆点推到盘边时，单通道最大偏移（数字上大约 ±0.6）。 */
export const WHEEL_CHROMA = 0.9;

/** 三通道键名：liftR / liftG / liftB …… 偏移也是 offsetR/G/B。 */
export function wheelChannelKeys(spec: WheelRangeSpec): [string, string, string] {
  return [`${spec.key}R`, `${spec.key}G`, `${spec.key}B`];
}

const SQRT3_2 = Math.sqrt(3) / 2;
/** 色轮上「红」所在的方向：屏幕 120°（左上），与绘制用的色相环对齐。 */
const ROT_COS = Math.cos((120 * Math.PI) / 180);
const ROT_SIN = Math.sin((120 * Math.PI) / 180);

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 从节点参数里取某个轮的三通道值（缺的按中性补齐）。 */
export function wheelChannels(
  spec: WheelRangeSpec,
  params: Record<string, unknown>,
): [number, number, number] {
  const [rk, gk, bk] = wheelChannelKeys(spec);
  return [
    numberOr(params[rk], spec.neutral),
    numberOr(params[gk], spec.neutral),
    numberOr(params[bk], spec.neutral),
  ];
}

/** 亮度（界面上的白字数字）= 三通道平均。 */
export function wheelLevel(channels: readonly [number, number, number]): number {
  return (channels[0] + channels[1] + channels[2]) / 3;
}

export function clampWheelValue(spec: WheelRangeSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.neutral;
  return Math.max(spec.min, Math.min(spec.max, value));
}

/** 界面统一两位小数（参照图就是 0.00 / 1.00 / 25.00）。 */
export function formatWheelValue(value: number): string {
  const rounded = Math.abs(value) < 0.005 ? 0 : value;
  return rounded.toFixed(2);
}

/** 外圈刻度 / 长条的占比（0..1）。 */
export function wheelLevelFraction(spec: WheelRangeSpec, level: number): number {
  const span = spec.max - spec.min || 1;
  return Math.max(0, Math.min(1, (level - spec.min) / span));
}

/**
 * 三通道 → 色轮圆点位置（-1..1，屏幕上 y 向上为正）。
 *
 * 取色度坐标 x0 = r − (g+b)/2、y0 = (√3/2)(g−b)，再旋转 +120°：
 * 纯红 → (-0.5, 0.866)（左上，正是色轮上红的位置）、纯绿 → 左下、纯蓝 → 右。
 * 半径按 WHEEL_CHROMA 归一：推到盘边是 1。
 */
export function wheelDotFromRgb(
  channels: readonly [number, number, number],
  chroma = WHEEL_CHROMA,
): { x: number; y: number } {
  const [r, g, b] = channels;
  const mean = (r + g + b) / 3;
  const x0 = 1.5 * (r - mean);
  const y0 = SQRT3_2 * (g - b);
  const x = x0 * ROT_COS - y0 * ROT_SIN;
  const y = x0 * ROT_SIN + y0 * ROT_COS;
  const magnitude = Math.hypot(x, y);
  if (magnitude < 1e-6) return { x: 0, y: 0 };
  const scale = Math.min(1, magnitude / Math.max(1e-6, chroma)) / magnitude;
  return { x: x * scale, y: y * scale };
}

/**
 * 色轮圆点 → 三通道（平均亮度用 level，色度按圆点方向的色相给）。
 * 与 wheelDotFromRgb 互逆（忽略盘边钳制与两位小数取整）。
 */
export function wheelRgbFromDot(
  x: number,
  y: number,
  level: number,
  chroma = WHEEL_CHROMA,
): [number, number, number] {
  let nx = Number.isFinite(x) ? x : 0;
  let ny = Number.isFinite(y) ? y : 0;
  const magnitude = Math.hypot(nx, ny);
  if (magnitude > 1) {
    nx /= magnitude;
    ny /= magnitude;
  }
  // 旋转 -120° 回到色度坐标
  const x0 = nx * ROT_COS + ny * ROT_SIN;
  const y0 = -nx * ROT_SIN + ny * ROT_COS;
  const dr = (2 / 3) * x0;
  const dg = -x0 / 3 + y0 / Math.sqrt(3);
  const db = -x0 / 3 - y0 / Math.sqrt(3);
  return [level + dr * chroma, level + dg * chroma, level + db * chroma];
}

/** 色轮色相环上某个屏幕角度对应的色相（编辑器画盘用；红在左上 120°）。 */
export function wheelHueAt(screenAngleDeg: number): number {
  return ((screenAngleDeg - 120) % 360 + 360) % 360;
}
