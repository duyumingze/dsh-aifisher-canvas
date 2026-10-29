/**
 * 示波器（Scopes）—— **达芬奇同款**的分量图 / 波形图 / 矢量图。
 *
 * 数据来自引擎把「预览/输出」降采样到一块 256×160 的 RGBA8 缓冲后 readPixels
 * （见 engine.ts 的 readScope）。这里只做纯 JS 聚合与画布绘制：
 *   · 聚合（histogramOf / waveformOf / paradeOf / vectorscopeOf）不碰 DOM，回归可直接喂像素验；
 *   · 绘制（drawScope）才需要 2D context，浏览器里用。
 *
 * 为什么在 JS 里算而不是 shader：示波器只在求值后跑一次、分辨率很低（几万像素），
 * 用 JS 省一套 GPU 读回/统计管线；而调色本身仍在 GPU 上逐帧算。
 *
 * 2026-10-29 用户拿达芬奇截图要求「替换成达芬奇同款的分量图、波形图、矢量图」，
 * 于是三种图都按达芬奇的颜色与刻度重画，并**弃用直方图 tab**（直方图只留作裁切读数）：
 *   · 纵轴是 **10-bit 量程 0–1023**，每 128 一格、顶格写 1023（达芬奇的标尺就是这样，
 *     用户截图里能读到 0/128/…/896/1023），刻度线是暗橄榄色细线、标签是暗黄小字；
 *   · **分量图（parade）**：横向三等分，红/绿/蓝三路各画自己的分布带，三路共用一条
 *     标尺与网格，颜色就是通道色 —— 对应达芬奇的 RGB Parade；
 *   · **波形图（waveform）**：一张图里把亮度分布画成一条彩色带，颜色取自该格像素的
 *     平均色（RGB 三色叠加）。这正是用户截图里那条紫/绿/橙叠在一起的波形，
 *     纯灰画面就会显示成灰白；
 *   · **矢量图（vectorscope）**：圆环 + 一圈刻度 + 六个 75% 彩条靶位（R/Mg/B/Cy/G/Yl）
 *     + 肤色线（I 轴，约 128°）。靶位坐标不是写死的角度，而是用 BT.601 反算出来的
 *     （见 vectorscopeTargets），所以和真实彩条对得上。
 *
 * 为什么靶位/肤色线用 BT.601：多数示波器（含达芬奇的 Rec.709 模式）都用同一套近似，
 * 我们的 eye 也只是读「往哪偏」，不必为 BT.709 系数差异再开一套。
 */

export interface ScopeImage {
  width: number;
  height: number;
  /** RGBA，逐行自上而下（引擎读回后已把 GL 的下翻转过）。 */
  pixels: Uint8Array;
}

/** 三种图。'histogram' 已从 UI 撤掉（见文件头），但统计函数留着给裁切读数用。 */
export type ScopeKind = 'parade' | 'waveform' | 'vectorscope';

/** 示波器纵轴量程：达芬奇用的是 10-bit。 */
export const SCOPE_MAX = 1023;
/** 标尺刻度（0..1023 每 128 一格，顶格单列 1023）。 */
const SCALE_STEPS: readonly number[] = [0, 128, 256, 384, 512, 640, 768, 896, 1023];

function clampInt(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.trunc(Number(value) || 0)));
}

/* ------------------------------------------------------------------ 聚合 */

export interface HistogramData {
  bins: number;
  pixels: number;
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  peak: number;
  /** 各通道贴 0 / 贴 255 的像素占比（取三通道平均）。 */
  clipShadow: number;
  clipHighlight: number;
}

export function histogramOf(image: ScopeImage, bins = 128): HistogramData {
  const count = Math.max(1, Math.min(512, Math.trunc(bins)));
  const r = new Uint32Array(count);
  const g = new Uint32Array(count);
  const b = new Uint32Array(count);
  const luma = new Uint32Array(count);
  const pixels = image.pixels;
  const total = Math.max(1, Math.floor(pixels.length / 4));
  let shadow = 0;
  let highlight = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const pr = pixels[index];
    const pg = pixels[index + 1];
    const pb = pixels[index + 2];
    const ri = Math.min(count - 1, Math.floor((pr / 256) * count));
    const gi = Math.min(count - 1, Math.floor((pg / 256) * count));
    const bi = Math.min(count - 1, Math.floor((pb / 256) * count));
    r[ri] += 1;
    g[gi] += 1;
    b[bi] += 1;
    const lumaValue = (0.2126 * pr + 0.7152 * pg + 0.0722 * pb) / 255;
    luma[Math.min(count - 1, Math.floor(lumaValue * count))] += 1;
    if (pr === 0) shadow += 1;
    if (pg === 0) shadow += 1;
    if (pb === 0) shadow += 1;
    if (pr === 255) highlight += 1;
    if (pg === 255) highlight += 1;
    if (pb === 255) highlight += 1;
  }
  let peak = 1;
  for (let index = 0; index < count; index += 1) {
    peak = Math.max(peak, r[index], g[index], b[index], luma[index]);
  }
  return {
    bins: count,
    pixels: total,
    r,
    g,
    b,
    luma,
    peak,
    clipShadow: shadow / (total * 3),
    clipHighlight: highlight / (total * 3),
  };
}

/**
 * 亮度波形：横轴 = 画面 x，纵轴 = 亮度（上亮下暗）。
 * 除了亮度计数，还累计每格的 RGB 之和 —— 画的时候用平均色给波形上色，
 * 这就是达芬奇那条「彩色波形」的来源（灰阶画面自然是灰白，偏暖的画面偏橙）。
 */
export interface WaveformData {
  columns: number;
  rows: number;
  counts: Uint32Array;
  red: Uint32Array;
  green: Uint32Array;
  blue: Uint32Array;
  peak: number;
}

export function waveformOf(image: ScopeImage, columns = 192, rows = 96): WaveformData {
  const cols = clampInt(columns, 8, 512);
  const lines = clampInt(rows, 8, 256);
  const cells = cols * lines;
  const counts = new Uint32Array(cells);
  const red = new Uint32Array(cells);
  const green = new Uint32Array(cells);
  const blue = new Uint32Array(cells);
  const pixels = image.pixels;
  const width = Math.max(1, image.width);
  const height = Math.max(1, image.height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (offset + 2 >= pixels.length) continue;
      const pr = pixels[offset];
      const pg = pixels[offset + 1];
      const pb = pixels[offset + 2];
      const luma = (0.2126 * pr + 0.7152 * pg + 0.0722 * pb) / 255;
      const col = Math.min(cols - 1, Math.floor((x / width) * cols));
      const row = Math.min(lines - 1, Math.max(0, Math.floor((1 - luma) * (lines - 1))));
      const cell = row * cols + col;
      counts[cell] += 1;
      red[cell] += pr;
      green[cell] += pg;
      blue[cell] += pb;
    }
  }
  let peak = 1;
  for (let index = 0; index < cells; index += 1) peak = Math.max(peak, counts[index]);
  return { columns: cols, rows: lines, counts, red, green, blue, peak };
}

/**
 * 分量图（RGB Parade）：三路各自的「每列纵向分布」。
 * 三路共用同一个峰值归一化（哪个通道像素少就是暗一截），和达芬奇一样能一眼看出
 * 红/绿/蓝谁抬起来了；如果各自归一化，三路永远一样亮，反而是误导。
 */
export interface ParadeData {
  columns: number;
  rows: number;
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  peak: number;
}

export function paradeOf(image: ScopeImage, columns = 96, rows = 96): ParadeData {
  const cols = clampInt(columns, 8, 512);
  const lines = clampInt(rows, 8, 256);
  const cells = cols * lines;
  const r = new Uint32Array(cells);
  const g = new Uint32Array(cells);
  const b = new Uint32Array(cells);
  const pixels = image.pixels;
  const width = Math.max(1, image.width);
  const height = Math.max(1, image.height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (offset + 2 >= pixels.length) continue;
      const col = Math.min(cols - 1, Math.floor((x / width) * cols));
      const rowR = Math.min(lines - 1, Math.max(0, Math.floor((1 - pixels[offset] / 255) * (lines - 1))));
      const rowG = Math.min(
        lines - 1,
        Math.max(0, Math.floor((1 - pixels[offset + 1] / 255) * (lines - 1))),
      );
      const rowB = Math.min(
        lines - 1,
        Math.max(0, Math.floor((1 - pixels[offset + 2] / 255) * (lines - 1))),
      );
      r[rowR * cols + col] += 1;
      g[rowG * cols + col] += 1;
      b[rowB * cols + col] += 1;
    }
  }
  let peak = 1;
  for (let index = 0; index < cells; index += 1) peak = Math.max(peak, r[index], g[index], b[index]);
  return { columns: cols, rows: lines, r, g, b, peak };
}

export interface VectorscopeData {
  size: number;
  counts: Uint32Array;
  peak: number;
}

/** BT.601 的色差（Cb/Cr），返回值以 0 为中心、±0.5 为满饱和。 */
function chromaOf(r: number, g: number, b: number): { cb: number; cr: number } {
  return {
    cb: -0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 0.5 * r - 0.418688 * g - 0.081312 * b,
  };
}

/**
 * 矢量图：色度平面（Cb/Cr），灰/白落在正中心，越靠外越饱和。
 * 用 BT.601 的近似转换，和大多数示波器一致（肤色线在 33° 附近）。
 */
export function vectorscopeOf(image: ScopeImage, size = 128): VectorscopeData {
  const side = Math.max(32, Math.min(256, Math.trunc(size)));
  const counts = new Uint32Array(side * side);
  const pixels = image.pixels;
  for (let index = 0; index + 2 < pixels.length; index += 4) {
    const r = pixels[index] / 255;
    const g = pixels[index + 1] / 255;
    const b = pixels[index + 2] / 255;
    const chroma = chromaOf(r, g, b);
    const cb = chroma.cb + 0.5;
    const cr = chroma.cr + 0.5;
    const cx = Math.min(side - 1, Math.max(0, Math.floor(cb * side)));
    const cy = Math.min(side - 1, Math.max(0, Math.floor((1 - cr) * side)));
    // 中心附近是灰：点太多会把图糊成一片，压低它的权重
    const saturation = Math.hypot(chroma.cb, chroma.cr);
    if (saturation < 0.02) continue;
    counts[cy * side + cx] += 1;
  }
  let peak = 1;
  for (let index = 0; index < counts.length; index += 1) peak = Math.max(peak, counts[index]);
  return { size: side, counts, peak };
}

/** 矢量图上的一个靶位（75% 彩条）。 */
export interface VectorscopeTarget {
  label: string;
  /** 从 +Cb 轴（3 点钟方向）起、逆时针的色相角（弧度）。 */
  angle: number;
  /** 相对「100% 饱和圆半径」的倍数（75% 彩条约 0.79）。 */
  radius: number;
  /** 靶位/标签的提示色。 */
  color: string;
}

/**
 * 六个靶位：不用写死角度，直接用 75% 彩条反算 BT.601 的 (Cb,Cr) →
 * 角度与半径都从公式来，所以换成别的彩条也不会有「框和波形对不上」的偏差。
 * 75% 彩条算出来六个半径都约等于 0.79，和真实矢量图的靶位圈一致。
 */
export function vectorscopeTargets(): VectorscopeTarget[] {
  const bars: Array<[string, number, number, number, string]> = [
    ['R', 1, 0, 0, '#ff5a5a'],
    ['Mg', 1, 0, 1, '#ff6ecb'],
    ['B', 0, 0, 1, '#7590ff'],
    ['Cy', 0, 1, 1, '#6fdce8'],
    ['G', 0, 1, 0, '#63e072'],
    ['Yl', 1, 1, 0, '#e6db63'],
  ];
  return bars.map(([label, r, g, b, color]) => {
    const chroma = chromaOf(r * 0.75, g * 0.75, b * 0.75);
    return {
      label,
      color,
      angle: Math.atan2(chroma.cr, chroma.cb),
      radius: Math.hypot(chroma.cb, chroma.cr) / 0.5,
    };
  });
}

/** 肤色线角度（弧度，从 +Cb 轴起逆时针）：取中肤色 (0.80,0.62,0.52) 反算 ≈128°。 */
export const SKIN_TONE_ANGLE = (() => {
  const chroma = chromaOf(0.8, 0.62, 0.52);
  return Math.atan2(chroma.cr, chroma.cb);
})();

/**
 * 色度平面上的角度 → 提示色。
 *
 * 注意这里**不能**用「r=cos(θ)、g=cos(θ-120°)、b=cos(θ+120°)」那套：那个公式的 θ 是从
 * 红轴起算的，而我们的 θ 是从 +Cb（蓝轴）起算 —— 直接用会把红蓝对调（第一版就是这样，
 * 红色靶位上亮起一颗绿点）。所以三条通道各自减去自己的靶位角（R 108.6° / G 231.7° /
 * B 350.8°，都是从同一个 chromaOf 反算出来的），色相就与靶位严格对齐了。
 */
const HUE_PHASES = (() => {
  const byLabel = new Map(vectorscopeTargets().map((target) => [target.label, target.angle]));
  return { r: byLabel.get('R') ?? 0, g: byLabel.get('G') ?? 0, b: byLabel.get('B') ?? 0 };
})();

function hueColor(angle: number): [number, number, number] {
  const channel = (phase: number): number => Math.round(128 + 127 * Math.cos(angle - phase));
  return [channel(HUE_PHASES.r), channel(HUE_PHASES.g), channel(HUE_PHASES.b)];
}

/* ------------------------------------------------------------------ 绘制 */

type Context2D = CanvasRenderingContext2D;

interface Plot {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 左侧留给 10-bit 刻度标签的宽度（达芬奇的标尺就在图里左侧）。 */
const GUTTER = 31;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;
const PAD_RIGHT = 9;

const CHANNELS: ReadonlyArray<{ key: 'r' | 'g' | 'b'; label: string; tint: [number, number, number] }> = [
  { key: 'r', label: 'R', tint: [255, 64, 64] },
  { key: 'g', label: 'G', tint: [56, 226, 84] },
  { key: 'b', label: 'B', tint: [76, 112, 255] },
];

function plotOf(width: number, height: number): Plot {
  return {
    x: GUTTER,
    y: PAD_TOP,
    width: Math.max(24, width - GUTTER - PAD_RIGHT),
    height: Math.max(20, height - PAD_TOP - PAD_BOTTOM),
  };
}

function createOffscreen(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** 把 0..1 的密度压成看得见的亮度：线性会把大多数格子压成看不见。 */
function density(value: number): number {
  return Math.min(1, Math.pow(Math.max(0, value), 0.45));
}

/** 10-bit 标尺 + 横向网格（分量图/波形图共用，达芬奇的两张图也是同一套刻度）。 */
function drawScale(context: Context2D, plot: Plot): void {
  context.save();
  context.lineWidth = 1;
  context.font = '9px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (const value of SCALE_STEPS) {
    const y = Math.round(plot.y + plot.height * (1 - value / SCOPE_MAX)) + 0.5;
    context.strokeStyle = 'rgba(150, 144, 66, .26)';
    context.beginPath();
    context.moveTo(plot.x, y);
    context.lineTo(plot.x + plot.width, y);
    context.stroke();
    // 顶格写 1023 会贴到边缘，夹一下别被裁掉半行字
    const textY = Math.max(plot.y + 5, Math.min(plot.y + plot.height - 5, y));
    context.fillStyle = value === SCOPE_MAX ? 'rgba(238, 228, 132, .95)' : 'rgba(202, 192, 108, .72)';
    context.fillText(String(value), plot.x - 5, textY);
  }
  // 左边框
  context.strokeStyle = 'rgba(150, 144, 66, .35)';
  context.beginPath();
  context.moveTo(Math.round(plot.x) + 0.5, plot.y);
  context.lineTo(Math.round(plot.x) + 0.5, plot.y + plot.height);
  context.stroke();
  context.restore();
}

/**
 * 清底 + 铺底色。
 *
 * 调用方（editor.ts 的 paintScope）已经把 transform 设成 dpr 缩放，
 * 所以这里的 width/height 是 CSS 尺寸、正好盖满整块位图。
 * 千万不要在这里 setTransform 回单位矩阵：那会让 dpr=2 时只清/只铺左上 1/4，
 * 右边和下边留一块旧画面（曾经就是这样，示波器内容缩在角落里）。
 */
function clearScope(context: Context2D, width: number, height: number): void {
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#08080a';
  context.fillRect(0, 0, width, height);
}

/**
 * 把一张低分辨率的「密度图」放大画进 plot。
 * 用 'lighter'（加色）而不是覆盖：波形/矢量图里重叠的通道要相加，这才是示波器的观感。
 */
function blitTrace(
  context: Context2D,
  offscreen: HTMLCanvasElement,
  plot: Plot,
  smoothing = true,
  alpha = 1,
): void {
  context.save();
  context.imageSmoothingEnabled = smoothing;
  context.globalCompositeOperation = 'lighter';
  context.globalAlpha = alpha;
  context.drawImage(offscreen, plot.x, plot.y, plot.width, plot.height);
  context.restore();
}

function drawWaveform(context: Context2D, data: WaveformData, width: number, height: number): void {
  clearScope(context, width, height);
  const plot = plotOf(width, height);
  drawScale(context, plot);

  const offscreen = createOffscreen(data.columns, data.rows);
  const target = offscreen?.getContext('2d');
  if (!offscreen || !target) return;
  const painted = target.createImageData(data.columns, data.rows);
  for (let index = 0; index < data.counts.length; index += 1) {
    const count = data.counts[index];
    if (!count) continue;
    const alpha = density(count / data.peak);
    if (alpha <= 0.004) continue;
    // 用这一格像素的平均色给波形上色：灰阶→灰白、偏暖→橙、偏青→绿蓝
    const red = data.red[index] / count;
    const green = data.green[index] / count;
    const blue = data.blue[index] / count;
    const max = Math.max(red, green, blue, 1);
    const offset = index * 4;
    painted.data[offset] = Math.round((255 * red) / max);
    painted.data[offset + 1] = Math.round((255 * green) / max);
    painted.data[offset + 2] = Math.round((255 * blue) / max);
    painted.data[offset + 3] = Math.round(255 * alpha);
  }
  target.putImageData(painted, 0, 0);
  blitTrace(context, offscreen, plot);
}

function drawParade(context: Context2D, data: ParadeData, width: number, height: number): void {
  clearScope(context, width, height);
  const plot = plotOf(width, height);
  drawScale(context, plot);

  const gap = 4;
  const each = Math.max(8, (plot.width - gap * 2) / 3);
  for (let channel = 0; channel < CHANNELS.length; channel += 1) {
    const entry = CHANNELS[channel];
    const values = data[entry.key];
    const area: Plot = {
      x: plot.x + channel * (each + gap),
      y: plot.y,
      width: each,
      height: plot.height,
    };
    const offscreen = createOffscreen(data.columns, data.rows);
    const target = offscreen?.getContext('2d');
    if (!offscreen || !target) continue;
    const painted = target.createImageData(data.columns, data.rows);
    for (let index = 0; index < values.length; index += 1) {
      const count = values[index];
      if (!count) continue;
      const alpha = density(count / data.peak);
      if (alpha <= 0.004) continue;
      const offset = index * 4;
      painted.data[offset] = entry.tint[0];
      painted.data[offset + 1] = entry.tint[1];
      painted.data[offset + 2] = entry.tint[2];
      painted.data[offset + 3] = Math.round(255 * alpha);
    }
    target.putImageData(painted, 0, 0);
    blitTrace(context, offscreen, area);

    // 通道标签（右上角，暗一档，别抢波形）
    context.save();
    context.font = '9px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
    context.textAlign = 'right';
    context.textBaseline = 'top';
    context.fillStyle = `rgba(${entry.tint[0]}, ${entry.tint[1]}, ${entry.tint[2]}, .8)`;
    context.fillText(entry.label, area.x + area.width - 3, plot.y + 2);
    context.restore();

    // 三路之间的分隔线
    if (channel < CHANNELS.length - 1) {
      const x = Math.round(area.x + area.width + gap / 2) + 0.5;
      context.save();
      context.strokeStyle = 'rgba(255, 255, 255, .07)';
      context.beginPath();
      context.moveTo(x, plot.y);
      context.lineTo(x, plot.y + plot.height);
      context.stroke();
      context.restore();
    }
  }
}

function drawVectorscope(context: Context2D, data: VectorscopeData, width: number, height: number): void {
  clearScope(context, width, height);
  const side = Math.min(width, height) - 12;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(18, side / 2);

  // 底盘
  context.save();
  context.fillStyle = '#07070a';
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fill();
  context.restore();

  // 刻度环：每 5° 一短划，每 30° 一长划（达芬奇的圆盘也是这样密一圈）
  context.save();
  context.strokeStyle = 'rgba(150, 144, 66, .45)';
  context.lineWidth = 1;
  for (let degree = 0; degree < 360; degree += 5) {
    const angle = (degree * Math.PI) / 180;
    const inner = degree % 30 === 0 ? 0.9 : 0.95;
    context.beginPath();
    context.moveTo(centerX + Math.cos(angle) * radius * inner, centerY - Math.sin(angle) * radius * inner);
    context.lineTo(centerX + Math.cos(angle) * radius, centerY - Math.sin(angle) * radius);
    context.stroke();
  }
  context.strokeStyle = 'rgba(196, 186, 100, .62)';
  context.beginPath();
  context.arc(centerX, centerY, radius - 0.5, 0, Math.PI * 2);
  context.stroke();
  context.restore();

  // 靶位 + 标签（75% 彩条）
  context.save();
  for (const target of vectorscopeTargets()) {
    const distance = radius * target.radius;
    const x = centerX + Math.cos(target.angle) * distance;
    const y = centerY - Math.sin(target.angle) * distance;
    context.strokeStyle = target.color;
    context.globalAlpha = 0.5;
    context.lineWidth = 1;
    context.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7);
    context.globalAlpha = 0.85;
    context.fillStyle = target.color;
    context.font = '9px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
    context.textBaseline = 'middle';
    const outward = 8;
    const labelX = x + Math.cos(target.angle) * outward;
    const labelY = y - Math.sin(target.angle) * outward;
    context.textAlign = Math.cos(target.angle) >= 0 ? 'left' : 'right';
    context.fillText(target.label, labelX, labelY);
  }
  context.restore();

  // 肤色线（I 轴）：穿过圆心的整条虚线，皮肤落在线上就说明色相没跑偏
  const skin = { x: Math.cos(SKIN_TONE_ANGLE), y: -Math.sin(SKIN_TONE_ANGLE) };
  context.save();
  context.strokeStyle = 'rgba(232, 226, 206, .34)';
  context.lineWidth = 1;
  context.setLineDash([5, 4]);
  context.beginPath();
  context.moveTo(centerX - skin.x * radius, centerY - skin.y * radius);
  context.lineTo(centerX + skin.x * radius, centerY + skin.y * radius);
  context.stroke();
  context.restore();

  // 色度波形（裁进圆里，画在刻度之上但比圆环淡）
  const offscreen = createOffscreen(data.size, data.size);
  const target = offscreen?.getContext('2d');
  if (offscreen && target) {
    const painted = target.createImageData(data.size, data.size);
    const half = data.size / 2;
    for (let index = 0; index < data.counts.length; index += 1) {
      const count = data.counts[index];
      if (!count) continue;
      // 矢量图的点天生比波形稀：用更平的幂次，单格色度点（纯色块）才不会淡到看不见
      const alpha = Math.min(1, Math.pow(count / data.peak, 0.35));
      if (alpha <= 0.004) continue;
      const x = index % data.size;
      const y = Math.floor(index / data.size);
      const hue = Math.atan2(-(y - half), x - half);
      const offset = index * 4;
      const [red, green, blue] = hueColor(hue);
      painted.data[offset] = red;
      painted.data[offset + 1] = green;
      painted.data[offset + 2] = blue;
      painted.data[offset + 3] = Math.round(255 * alpha);
    }
    target.putImageData(painted, 0, 0);
    const area = { x: centerX - radius, y: centerY - radius, width: radius * 2, height: radius * 2 };
    context.save();
    context.beginPath();
    context.arc(centerX, centerY, radius - 1, 0, Math.PI * 2);
    context.clip();
    // 平滑一次当柔光、不插值再刷一次当实体：否则纯色块（一拍就是一个格子）几乎看不见
    blitTrace(context, offscreen, area, true, 0.8);
    blitTrace(context, offscreen, area, false, 0.85);
    context.restore();

    /**
     * 高密度格子再点一颗柔光：纯色块在 160×160 的色度网格里只占一个格子，
     * 放大之后就是 2–3px 的小点，远看几乎读不出「色块落在靶位上没有」。
     * 达芬奇的矢量图对单点色度也是画成一颗亮斑，这里用径向渐变补上。
     * 只点最热的那些格子并封顶 240 颗 —— 照片的云状分布本来就靠上面的图层，
     * 给每一个格子都加发光只会糊成一团，还慢。
     */
    const hot: Array<{ x: number; y: number; r: number; g: number; b: number; weight: number }> = [];
    for (let index = 0; index < data.counts.length; index += 1) {
      const count = data.counts[index];
      if (!count) continue;
      const weight = count / data.peak;
      if (weight < 0.45) continue;
      const x = index % data.size;
      const y = Math.floor(index / data.size);
      const hue = Math.atan2(-(y - half), x - half);
      const [red, green, blue] = hueColor(hue);
      hot.push({
        x: x / data.size,
        y: y / data.size,
        r: red,
        g: green,
        b: blue,
        weight: Math.min(1, Math.pow(weight, 0.35)),
      });
      if (hot.length >= 240) break;
    }
    context.save();
    context.beginPath();
    context.arc(centerX, centerY, radius - 1, 0, Math.PI * 2);
    context.clip();
    context.globalCompositeOperation = 'lighter';
    const glow = Math.max(4, Math.min(9, Math.round(radius * 0.035)));
    for (const dot of hot) {
      const x = area.x + dot.x * area.width;
      const y = area.y + dot.y * area.height;
      const gradient = context.createRadialGradient(x, y, 0, x, y, glow);
      gradient.addColorStop(0, `rgba(${dot.r}, ${dot.g}, ${dot.b}, ${0.85 * dot.weight})`);
      gradient.addColorStop(0.55, `rgba(${dot.r}, ${dot.g}, ${dot.b}, ${0.3 * dot.weight})`);
      gradient.addColorStop(1, `rgba(${dot.r}, ${dot.g}, ${dot.b}, 0)`);
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(x, y, glow, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  // 圆心十字 + 圆环重描（波形不许压掉准星）
  context.save();
  context.strokeStyle = 'rgba(210, 204, 150, .5)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(centerX - 7, centerY);
  context.lineTo(centerX + 7, centerY);
  context.moveTo(centerX, centerY - 7);
  context.lineTo(centerX, centerY + 7);
  context.stroke();
  context.strokeStyle = 'rgba(196, 186, 100, .55)';
  context.beginPath();
  context.arc(centerX, centerY, radius - 0.5, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

/** 示波器读数：只留「坏了要修」的两个数（暗部/高光裁切）。 */
export interface ScopeReadout {
  clipShadow: number;
  clipHighlight: number;
}

/** 把某一种示波器画进 2D canvas（尺寸以 CSS 像素给，transform 由调用方按 dpr 设好）。 */
export function drawScope(
  context: Context2D,
  kind: ScopeKind,
  image: ScopeImage,
  width: number,
  height: number,
): ScopeReadout {
  const w = Math.max(48, Math.round(width));
  const h = Math.max(40, Math.round(height));
  // 列数不能超过采样图的宽度：一列比一个采样点还窄就会出现「空列」，
  // 放大后波形变成一串虚线（第一版就踩了：450px 的图向 256px 的采样要 410 列）。
  const sourceColumns = Math.max(32, image.width);
  if (kind === 'parade') {
    // 三路平分宽度：每路的列数跟着像素走，太密反而成一片糊
    const columns = clampInt(Math.min(Math.round(w / 3), sourceColumns), 24, 240);
    drawParade(context, paradeOf(image, columns, 128), w, h);
  } else if (kind === 'waveform') {
    const columns = clampInt(Math.min(w - GUTTER - PAD_RIGHT, sourceColumns), 48, 480);
    drawWaveform(context, waveformOf(image, columns, 128), w, h);
  } else {
    drawVectorscope(context, vectorscopeOf(image, 160), w, h);
  }
  const histogram = histogramOf(image, 64);
  return { clipShadow: histogram.clipShadow, clipHighlight: histogram.clipHighlight };
}

/** 最近一次聚合读数（回归 / 排查用）。 */
export function scopeSampleReport(image: ScopeImage): Record<string, unknown> {
  const histogram = histogramOf(image, 32);
  const parade = paradeOf(image, 32, 32);
  const waveform = waveformOf(image, 32, 32);
  return {
    pixels: histogram.pixels,
    clipShadow: Number(histogram.clipShadow.toFixed(4)),
    clipHighlight: Number(histogram.clipHighlight.toFixed(4)),
    peak: histogram.peak,
    paradePeak: parade.peak,
    waveformPeak: waveform.peak,
  };
}
