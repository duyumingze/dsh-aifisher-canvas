/**
 * 生成中节点的「噪波放大的圆点阵」（2026-10-30 定稿）。
 *
 * 用户原话（四轮迭代后的最终描述）：「圆型点阵，默认状态下不明显，随机选取部分圆进行放大发光。
 * 这个范围就是 Blender 里噪波纹理提高对比度放大尺寸的形状，大小和发光的质取决于噪波的值，
 * 0 到 1，会随机移动。」前面还明确否掉了：整层呼吸、扫描带、满屏噪波雾。
 *
 * 为什么不用纯 CSS：每个圆的半径/亮度都要跟着噪波值走，CSS 只能整层叠滤镜，
 * 做不出「一部分圆大、一部分圆暗」的分布。所以这里跟设计稿的 orbit.html 一样，
 * 往生成中遮罩里插一层 SVG（约 400 个 <circle>），每帧只改 r / fill-opacity。
 *
 * 为什么不改 vendor 的 GenerationWaiting.tsx：vendor 树一个字不动是项目的硬约束；
 * 这一层挂在 `[data-fisherai-regeneration-overlay="true"]` 里当**兄弟节点**，
 * React 重渲染把我们的层冲掉时 MutationObserver 会补回来。
 *
 * 2026-11-01 第二轮（用户原话）：「噪波点阵的动态效果，现在它是一张静帧，但是噪波的大小要发大一倍，
 * 也就是让让发光放大的点阵与默认状态下的过度更平滑」。两件事：
 *   ①「静帧」是真 bug：循环重启时没清 lastPaint，`time - lastPaint` 一直是负的，
 *      点阵要冻住上一轮动画那么久（一次生成 30–60s）才恢复。ensureLoop 里重置 lastPaint。
 *   ②噪波尺寸放大一倍 = NOISE_SCALE 减半（0.012→0.006，团块从约 83px 变约 166px），
 *      同时把对比区间从 0.32 宽拉到 0.50 宽，亮团到暗点的过渡才不硬边。
 *
 * 观感参数（2026-11-01 现用）：
 *   - 点距 20px，缺省 r=0.9 / alpha .03（几乎不可见）；
 *   - 噪波 = 2 octave value noise，坐标 x*0.006 + t*0.12（整片场随时间平移，约 20px/s，肉眼能看出在飘）；
 *   - smoothstep(0.40, 0.90) 拉对比 → 团块边界像 Blender 噪波纹理，但留软过渡；
 *   - r = 0.9 + n*3.2，alpha = 0.03 + n*0.85；
 *   - 发光靠 SVG 根的 drop-shadow（见 skin.ts），不做整层呼吸。
 *
 * 性能：391 点 × 若干节点，约 30fps；文档隐藏时停 rAF，prefers-reduced-motion 只画一帧。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const GAP = 20;
const BASE_R = 0.9;
const GROW_R = 3.2;
const BASE_ALPHA = 0.03;
const ALPHA_RANGE = 0.85;
/** 噪声尺寸：0.006 = 团块直径约 166px（2026-11-01 用户要求「放大一倍」，原 0.012）。 */
const NOISE_SCALE = 0.006;
const X_SPEED = 0.12;
const Y_SPEED = 0.045;
/** 对比区间：0.40–0.90（宽 0.50）。区间越窄团块边界越硬；放大噪声后配合放宽，亮团→暗点是连续过渡。 */
const NOISE_LOW = 0.4;
const NOISE_HIGH = 0.9;
const LAYER_CLASS = 'af-gen-dots';
const BAR_CLASS = 'af-gen-bar';
const OVERLAY_SELECTOR = '[data-fisherai-regeneration-overlay="true"]';

interface Dot {
  circle: SVGCircleElement;
  x: number;
  y: number;
}

interface Instance {
  overlay: HTMLElement;
  svg: SVGSVGElement;
  dots: Dot[];
  width: number;
  height: number;
  resize: ResizeObserver | null;
}

const instances = new Map<HTMLElement, Instance>();
let frame = 0;
let startedAt = 0;
let lastPaint = -1;
let observer: MutationObserver | null = null;
let syncQueued = false;
let disposed = false;

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- 噪波（与设计稿 orbit.html 同一套） ---------------- */

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x: number, y: number): number {
  return vnoise(x, y) * 0.65 + vnoise(x * 2.1 + 13.7, y * 2.1 + 7.3) * 0.35;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* ---------------- 挂载 / 绘制 ---------------- */

function paint(instance: Instance, time: number): void {
  const ox = time * X_SPEED;
  const oy = time * Y_SPEED;
  for (const dot of instance.dots) {
    const n = smoothstep(NOISE_LOW, NOISE_HIGH, fbm(dot.x * NOISE_SCALE + ox, dot.y * NOISE_SCALE + oy));
    dot.circle.setAttribute('r', (BASE_R + n * GROW_R).toFixed(2));
    dot.circle.setAttribute('fill-opacity', (BASE_ALPHA + n * ALPHA_RANGE).toFixed(3));
  }
}

function ensureLayer(overlay: HTMLElement): HTMLDivElement | null {
  let layer = overlay.querySelector<HTMLDivElement>(`:scope > .${LAYER_CLASS}`);
  if (layer) return layer;
  layer = document.createElement('div');
  layer.className = LAYER_CLASS;
  layer.setAttribute('aria-hidden', 'true');
  overlay.insertBefore(layer, overlay.firstChild);
  return layer;
}

function ensureBar(overlay: HTMLElement): void {
  if (overlay.querySelector(`:scope > .${BAR_CLASS}`)) return;
  const bar = document.createElement('div');
  bar.className = BAR_CLASS;
  bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('i');
  bar.append(fill);
  overlay.append(bar);
}

function attach(overlay: HTMLElement): void {
  if (instances.has(overlay)) {
    const existing = instances.get(overlay);
    // 层被 React 冲掉时补回来（只补层，不重建点集，等 resize 或下次挂载）
    if (existing && !overlay.querySelector(`:scope > .${LAYER_CLASS}`)) {
      const layer = ensureLayer(overlay);
      layer?.append(existing.svg);
    }
    ensureBar(overlay);
    return;
  }
  const layer = ensureLayer(overlay);
  if (!layer) return;
  const width = Math.max(0, Math.round(overlay.clientWidth));
  const height = Math.max(0, Math.round(overlay.clientHeight));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('preserveAspectRatio', 'none');
  const dots: Dot[] = [];
  if (width > 0 && height > 0) {
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    for (let y = GAP * 0.6; y < height; y += GAP) {
      for (let x = GAP * 0.6; x < width; x += GAP) {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', x.toFixed(1));
        circle.setAttribute('cy', y.toFixed(1));
        circle.setAttribute('r', String(BASE_R));
        circle.setAttribute('fill', '#5eead4');
        circle.setAttribute('fill-opacity', String(BASE_ALPHA));
        svg.append(circle);
        dots.push({ circle, x, y });
      }
    }
  }
  layer.append(svg);
  ensureBar(overlay);

  const resize = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        const nextWidth = Math.round(overlay.clientWidth);
        const nextHeight = Math.round(overlay.clientHeight);
        if (Math.abs(nextWidth - instance.width) > 8 || Math.abs(nextHeight - instance.height) > 8) {
          rebuild(overlay);
        }
      })
    : null;
  const instance: Instance = { overlay, svg, dots, width, height, resize };
  instances.set(overlay, instance);
  resize?.observe(overlay);
  paint(instance, 0.8);
}

function rebuild(overlay: HTMLElement): void {
  const previous = instances.get(overlay);
  previous?.resize?.disconnect();
  instances.delete(overlay);
  overlay.querySelector(`:scope > .${LAYER_CLASS}`)?.remove();
  attach(overlay);
}

function detach(overlay: HTMLElement): void {
  const instance = instances.get(overlay);
  if (!instance) return;
  instance.resize?.disconnect();
  instances.delete(overlay);
}

function sync(): void {
  if (disposed) return;
  // 已摘掉的遮罩
  for (const overlay of [...instances.keys()]) {
    if (!overlay.isConnected) detach(overlay);
  }
  // 新出现的遮罩 / 被冲掉的层
  for (const overlay of document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    attach(overlay);
  }
}

function scheduleSync(): void {
  if (syncQueued || disposed) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    sync();
    ensureLoop();
  });
}

function ensureLoop(): void {
  if (disposed || frame || instances.size === 0) return;
  if (reducedMotion()) {
    for (const instance of instances.values()) paint(instance, 0.8);
    return;
  }
  startedAt = performance.now();
  // 上一轮循环停下时 lastPaint 停在上一轮的时间（可能 30–60s），不清掉的话
  // `time - lastPaint` 会一直是负数，新一轮点阵要冻住同样长的时间才动 —— 用户看到的就是「一张静帧」。
  lastPaint = -1;
  for (const instance of instances.values()) paint(instance, 0.8);
  const tick = (now: number) => {
    frame = 0;
    if (disposed || instances.size === 0) return;
    if (!document.hidden) {
      const time = (now - startedAt) / 1000;
      // 30fps 足够；噪波场移动很慢，高了只是白烧 CPU
      if (time - lastPaint >= 1 / 30) {
        lastPaint = time;
        for (const instance of instances.values()) paint(instance, time);
      }
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

/**
 * 装生成中点阵。返回撤销函数（画布卸载时停 rAF / 断开观察者 / 摘掉自己插的层）。
 */
export function installCanvasGenerationDots(): () => void {
  if (typeof document === 'undefined') return () => {};
  disposed = false;
  observer = new MutationObserver(() => scheduleSync());
  observer.observe(document.body, { childList: true, subtree: true });
  const onVisibility = () => {
    if (!document.hidden) ensureLoop();
  };
  document.addEventListener('visibilitychange', onVisibility);
  sync();
  ensureLoop();
  return () => {
    disposed = true;
    observer?.disconnect();
    observer = null;
    document.removeEventListener('visibilitychange', onVisibility);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const overlay of [...instances.keys()]) {
      detach(overlay);
      overlay.querySelector(`:scope > .${LAYER_CLASS}`)?.remove();
      overlay.querySelector(`:scope > .${BAR_CLASS}`)?.remove();
    }
  };
}

/** 诊断读数：挂了几个 / 共几个点 / 首帧有没有画出来。 */
export function generationDotsReport(): Record<string, unknown> {
  let dots = 0;
  for (const instance of instances.values()) dots += instance.dots.length;
  return { overlays: instances.size, dots, running: Boolean(frame) };
}
