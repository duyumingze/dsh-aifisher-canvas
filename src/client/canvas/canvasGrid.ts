/**
 * 画布点阵底纹：小十字星 + 鼠标周围圆形变亮（交互式网格背景）。
 *
 * 用户原话（v1.7）：「画布希望有个小十字型字间隔一个方块背景，与鼠标有交互效果鼠标周围圆形区域变亮」；
 * 用户原话（v1.8，附官方画布截图当参考）：「我要的是这种样式的，把点替换成小型十字星，鼠标靠近会变亮」。
 * → 参考图量出来的规格：间距 24px、标记墨色 alpha≈0.19、底色 #050505（= vendor 的 --af-canvas）。
 *   v1.8 就照这个规格走：间距 24px，把 v1.7 那个偏大的十字（22px 间距 + 视觉约 9px 长、2px 粗）
 *   收成 7px 长、1px 粗的小十字星 —— 「小」是用户明确要求的。
 *
 * 做法（**vendor 树一个字不改**）：
 *   往 `#canvas-background`（vendor 的 canvasScene 里那个 `absolute inset-0` 的画布底盘）
 *   里插一层纯 DOM 的网格层，作为它的**第一个孩子** —— 它在 DOM 顺序上排在
 *   `#canvas-viewport-content`（节点/连线层，被 transform 平移缩放）之前，所以天然
 *   画在所有节点下方，不需要动 vendor 的任何栈序。
 *
 * 三个技术点，都是想清楚「为什么不能更省事」之后才这么写的：
 *
 *   1. **网格跟着画布平移缩放**（无限画布的标准行为：放大时格子间距跟着变宽，星号与间距
 *      比例恒定 —— 底纹是「一层贴纸」，不模拟「星号固定大小、只变间距」那种需要
 *      per-mark DOM 的做法）。所以网格不能放进被 transform 的
 *      `#canvas-viewport-content` 里，而是留在底盘上，只把 transform 里的位移/缩放
 *      **读出来喂给 background-position / background-size**：
 *        background-position = translate（CSS px，原样）
 *        background-size     = 间距 × zoom（CSS px，原样）
 *      数据源是 `#canvas-viewport-content` 的 style（React 每次平移/缩放都重写它），
 *      用 MutationObserver 监听属性变化 —— 不用接画布的 React 状态，也就绕开了
 *      产物里两份 React（vendor 一份 / shadcn 一份）的坑。
 *
 *      ⚠️ **CSS 背景的几何单位永远是 CSS px，绝不能乘 devicePixelRatio。**
 *      v1.33 之前的实现乘了（`translate × dpr`、`间距 × zoom × dpr`），于是网格的位移
 *      = 节点位移 × dpr：本机 125% 缩放下网格正好比节点快 1.25 倍。用户原话
 *      「移动画布的时候背后的网格和节点移动的速度不一致，网格的速度快，节点慢」。
 *      这个 bug 藏了很久，因为两套回归都跑在 dpr=1：jsdom 恒为 1，browser-check 也带着
 *      `--force-device-scale-factor=1`（乘子等于没写）。现在真机检查多了一场 dpr=1.25
 *      （browser-check 的 grid-pan-hidpi 场景）专门守这个比值。
 *
 *   2. **星号要清晰**：平铺块 = 间距、viewBox 同尺寸（1:1 绘制，星号就是它真实的
 *      7px 大小）。定位相对**画布自己的原点**（不用 `background-attachment: fixed` ——
 *      它的定位面积是视口，会让星号相对节点在缩放时漂移：格子相位 = canvas 原点/zoom）。
 *      这样「世界坐标里的贴纸」语义是精确的：节点 world (0,0) 落在 (panX, panY)，
 *      星号也按 (panX, panY) 起排，任何 dpr / zoom 下都不会错位。
 *
 *   3. **鼠标周围的圆形变亮**用 `mask-image: radial-gradient(circle Rpx at Xpx Ypx, …)`
 *      做在**第二层**（提亮版星号）上：遮罩圆心取事件的 offsetX/offsetY
 *      （相对底盘自身的坐标），所以不管画布怎么平移缩放，圆心永远在指针正下方。
 *      半径用 min(R, w/2, h/2) 夹住 —— 遮罩区域超出元素边界时部分浏览器会整层消失。
 *
 * 主题：按 `html[data-af-theme]` 分浅/深两套星号颜色（暗底用亮灰、亮底用深灰）。
 * 观感常量都在 STYLE_CONSTANTS 里，改那里就行。
 *
 * v1.27（用户原话「现在画布与鼠标没有互动效果，在设置里做一个开关」）修了两件事：
 *   ① **互动真的不见了**：v1.8～v1.26 把指针监听挂在网格层自己身上，而网格层必须
 *      `pointer-events: none` —— 这种元素**永远不是命中目标**，真实鼠标的 pointermove
 *      落在 `#canvas-background` / 节点上，一格都不会到网格层。两套回归都没发现，因为
 *      它们都是 `layer.dispatchEvent(...)`（合成事件绕过命中测试）。现在改成
 *      **window 捕获阶段**监听 + 用网格层自己的 rect 判「在不在画布里」
 *      （量不到 rect 时退回事件 offset，见 locate()）。
 *   ② **加了一个开关**（设置 → 画布外观 → 画布互动）：状态在 ./CanvasEffectsStore.ts，
 *      网格层订阅它 —— 关掉时**摘掉监听并清遮罩**（底纹退回纯静态），不是把透明度调成 0。
 *
 * v1.33（用户原话「移动画布的时候背后的网格和节点移动的速度不一致，网格的速度快，节点慢」）：
 *   真机量出来的根因是**网格把 CSS px 当设备 px 用**（详见上面第 1 条）。修法只有一句：
 *   `--canvas-grid-pan-x/y` 写 `translate` 的原值，`background-size` 只乘 zoom，dpr 一个都
 *   不掺。同时去掉 `background-attachment: fixed`（它让定位面积变成视口，缩小/放大时格子
 *   相位会随 `画布原点/zoom` 漂移，与节点脱节）。
 *   `--canvas-grid-dpr` 保留下来**只作读数**（排障时要能看出这台机器是 100% 还是 125%）。
 *
 * 这一层全程 `pointer-events: none`：它铺满整个画布，绝不能抢走画布自己的指针事件。
 */
import { reportCanvasError, reportCanvasInfo } from './diagnostics';
import {
  canvasEffects,
  canvasEffectsReport,
  subscribeCanvasEffects,
} from '../../canvas-ui/canvas/CanvasEffectsStore';

/** 底纹观感常量（要调十字疏密/浓淡/提亮范围改这里）。 */
const STYLE_CONSTANTS = {
  /** 暗色主题：近黑画布上的浅灰十字（颜色写进 SVG，见 crossDataUrl 的注释）。 */
  darkInk: '#ffffff',
  darkInkOpacity: 0.19,
  /** 浅色主题：白画布上的深灰十字。 */
  lightInk: '#111827',
  lightInkOpacity: 0.2,
  /** 提亮层（鼠标周围）用的颜色：暗色主题纯白、浅色主题近黑。 */
  darkHighlight: '#ffffff',
  lightHighlight: '#0b1220',
  /** 两枚十字之间的间距（逻辑 px）。1:1 画进平铺块里，所以这里也是平铺块的边长。 */
  spacing: 24,
  /** 小十字星的臂长（从中心往外，逻辑 px）—— 星号总宽 = arm × 2 + stroke。 */
  arm: 3,
  stroke: 1,
  /** 鼠标周围变亮圆的半径（逻辑 px），以及其中「全亮核心」的占比。 */
  radius: 190,
  coreRatio: 0.28,
};

/**
 * 小十字星（+）的 data URL。
 *
 * 平铺块边长 = spacing，viewBox 与原图**同尺寸**（1 SVG 单位 = 1 逻辑 px），
 * 于是星号画出来就是它真实的像素大小（7px），不会被 background-size 拉伸放大成糊块。
 * 圆心取半像素（12.5）：1px 线正好压在整数像素行/列上，缩放 100% 时最锐。
 *
 * ⚠️ **颜色必须写死在 SVG 里（stroke + stroke-opacity），绝不能用 `currentColor`。**
 * 背景图里的 SVG 是一份**独立的图片文档**，宿主元素的 CSS `color` 不会继承进去 ——
 * `currentColor` 到了那边只会解析成图片文档自己的默认色（黑）。v1.7 就是这么写的：
 * 深色画布（#050505）上画的是**黑十字**，肉眼几乎看不见（只有极小的色差），
 * 这属于「代码看着对、画面上没有」的典型坑，回归里专门钉了一条断言。
 */
function crossDataUrl(color: string, opacity: number): string {
  const { arm, stroke, spacing } = STYLE_CONSTANTS;
  const center = spacing / 2 + 0.5;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spacing}" height="${spacing}" ` +
    `viewBox="0 0 ${spacing} ${spacing}"><path d="M${center - arm} ${center}` +
    `H${center + arm}M${center} ${center - arm}V${center + arm}" ` +
    `stroke="${color}" stroke-opacity="${opacity}" stroke-width="${stroke}" ` +
    `stroke-linecap="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function maskGradient(): string {
  const core = Math.round(STYLE_CONSTANTS.coreRatio * 100);
  return (
    `radial-gradient(circle var(--canvas-grid-mr) at var(--canvas-grid-mx) var(--canvas-grid-my), ` +
    `#000 0%, rgba(0,0,0,0.92) ${core}%, rgba(0,0,0,0.5) 62%, transparent 100%)`
  );
}

/**
 * 网格层样式。跟着画布样式一起注入（见 styles.ts）—— 全局但只命中 `[data-canvas-grid]`，
 * 不会误伤 DSH 界面。
 */
export function canvasGridStyleText(): string {
  const C = STYLE_CONSTANTS;
  const darkCross = crossDataUrl(C.darkInk, C.darkInkOpacity);
  const lightCross = crossDataUrl(C.lightInk, C.lightInkOpacity);
  const darkHighlight = crossDataUrl(C.darkHighlight, 1);
  const lightHighlight = crossDataUrl(C.lightHighlight, 1);
  return `
/* ---- 画布点阵底纹（小十字星 + 鼠标圆形提亮） ---- */
.af-canvas-mount [data-canvas-grid='true'] {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  /* 遮罩初值：圆心在元素外 → 提亮层不可见（语法在任何时刻都合法）。 */
  --canvas-grid-mx: -9999px;
  --canvas-grid-my: -9999px;
  --canvas-grid-mr: 0px;
  --canvas-grid-zoom: 1;
  /* 只作读数（排障时能看出这台机器是 100% / 125%）：**不参与任何几何计算**，见上面 v1.33。 */
  --canvas-grid-dpr: 1;
  --canvas-grid-pan-x: 0;
  --canvas-grid-pan-y: 0;
}
.af-canvas-mount [data-canvas-grid='true'] .canvas-grid-cross {
  position: absolute;
  inset: 0;
  background-repeat: repeat;
  /* ⚠️ 这两个值必须是**纯 CSS px**，一个 dpr 都不能掺进来（v1.33 的 bug 就死在这儿）：
     平移量 = 画布 transform 里的 translate 原值；边长 = 间距 × zoom。
     乘了 dpr 的后果：网格位移 = 节点位移 × dpr（125% 缩放 → 网格快 1.25 倍）。 */
  background-size: calc(${C.spacing}px * var(--canvas-grid-zoom));
  background-position: calc(var(--canvas-grid-pan-x) * 1px) calc(var(--canvas-grid-pan-y) * 1px);
}
/* 颜色写死在各自的 SVG 里（图片文档不继承宿主 color），所以分主题给四张图。 */
.af-canvas-mount [data-canvas-grid='true'] .canvas-grid-cross.is-base {
  background-image: ${darkCross};
}
.af-canvas-mount [data-canvas-grid='true'] .canvas-grid-cross.is-highlight {
  background-image: ${darkHighlight};
  opacity: 0;
  -webkit-mask-image: ${maskGradient()};
  mask-image: ${maskGradient()};
  transition: opacity 180ms ease;
}
html[data-af-theme='light'] .af-canvas-mount [data-canvas-grid='true'] .canvas-grid-cross.is-base {
  background-image: ${lightCross};
}
html[data-af-theme='light'] .af-canvas-mount [data-canvas-grid='true'] .canvas-grid-cross.is-highlight {
  background-image: ${lightHighlight};
}
/* 壁纸开着的时候不出网格：用户挑了背景图，底纹只会打架（vendor 自己有壁纸开关）。 */
.af-canvas-mount:has(.af-wallpaper) [data-canvas-grid='true'] {
  display: none;
}
`;
}

/** 读 transform: `translate3d(x, y, 0) scale(z)`（兼容 matrix 写法）里的平移与缩放。 */
function readTransform(value: string): { panX: number; panY: number; zoom: number } {
  const scale = /scale\(\s*([-0-9.eE+]+)\s*\)/.exec(value);
  const zoom = scale ? Number.parseFloat(scale[1]) : 1;
  const translate = /translate3d\(\s*([-0-9.eE+]+)px\s*,\s*([-0-9.eE+]+)px/.exec(value);
  if (translate) {
    return {
      panX: Number.parseFloat(translate[1]),
      panY: Number.parseFloat(translate[2]),
      zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
    };
  }
  const matrix = /matrix\(([^)]*)\)/.exec(value);
  if (matrix) {
    const parts = matrix[1].split(',').map((part) => Number.parseFloat(part));
    if (parts.length >= 6 && parts.every((part) => Number.isFinite(part))) {
      return { panX: parts[4], panY: parts[5], zoom: parts[0] > 0 ? parts[0] : 1 };
    }
  }
  return { panX: 0, panY: 0, zoom: 1 };
}

function resolveTheme(root: HTMLElement, element: Element | null): string {
  const attribute =
    root.dataset.afTheme ?? element?.closest('[data-af-theme]')?.getAttribute('data-af-theme');
  return attribute === 'light' ? 'light' : 'dark';
}

interface GridRuntime {
  canvas: HTMLElement;
  layer: HTMLElement;
  dispose(): void;
}

/**
 * 指针跟随的排查读数（挂在哪一层上就记哪一层）。
 * 真机「看着没反应」时这样才能分清是「没绑定 / 没触发 / 画了但量不到」：
 *   enabled=false → 设置里关掉了；listening=false → 监听没挂上；
 *   paints=0 → 指针事件没进来（历史 bug 就是这个：事件目标不是网格层）；last=null → 从没画过。
 */
interface PointerInteractivityState {
  enabled: boolean;
  listening: boolean;
  last: { x: number; y: number } | null;
  paints: number;
}

const interactivity = new WeakMap<HTMLElement, PointerInteractivityState>();

/**
 * 让网格层接管一个画布底盘。装饰层出任何问题都不该影响画布本体，
 * 所以这里只做最小的事，异常由调用方兜住并上报。
 */
function attachGridLayer(canvas: HTMLElement, root: HTMLElement): GridRuntime {
  const layer = document.createElement('div');
  layer.setAttribute('data-canvas-grid', 'true');
  layer.setAttribute('data-canvas-grid-spacing', String(STYLE_CONSTANTS.spacing));
  layer.setAttribute(
    'data-canvas-grid-star',
    `${STYLE_CONSTANTS.arm * 2 + STYLE_CONSTANTS.stroke}x${STYLE_CONSTANTS.stroke}`,
  );
  // 墨色也自报一份：回归靠它断言「画在深色画布上的是亮色」（v1.7 的黑十字事故）。
  layer.setAttribute(
    'data-canvas-grid-ink',
    `${STYLE_CONSTANTS.darkInk}@${STYLE_CONSTANTS.darkInkOpacity}`,
  );
  layer.setAttribute('aria-hidden', 'true');

  const base = document.createElement('div');
  base.className = 'canvas-grid-cross is-base';
  base.setAttribute('aria-hidden', 'true');
  const highlight = document.createElement('div');
  highlight.className = 'canvas-grid-cross is-highlight';
  highlight.setAttribute('aria-hidden', 'true');
  layer.append(base, highlight);
  canvas.prepend(layer);

  const rAF = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : null;
  const cAF = typeof window.cancelAnimationFrame === 'function'
    ? window.cancelAnimationFrame.bind(window)
    : null;
  /** 指针在画布里时补一个循环盯 transform（底纹不跟画布脱节）。 */
  let running = false;
  let tickFrame = 0;
  /** 鼠标互动效果是否开启（设置页开关，见 CanvasEffectsStore）。 */
  let enabled = canvasEffects().pointerGlow;
  /** 现在有没有挂 window 监听（关掉效果时摘掉，别在后台空转）。 */
  let listening = false;
  /** 排查读数（诊断接口读它）。 */
  const pointerState: PointerInteractivityState = {
    enabled,
    listening: false,
    last: null,
    paints: 0,
  };
  interactivity.set(layer, pointerState);

  const highlightPoint = (localX: number, localY: number) => {
    const rect = layer.getBoundingClientRect();
    const radius = Math.max(
      40,
      Math.min(STYLE_CONSTANTS.radius, (rect.width || STYLE_CONSTANTS.radius * 2) / 2, (rect.height || STYLE_CONSTANTS.radius * 2) / 2),
    );
    layer.style.setProperty('--canvas-grid-mx', `${Math.round(localX)}px`);
    layer.style.setProperty('--canvas-grid-my', `${Math.round(localY)}px`);
    layer.style.setProperty('--canvas-grid-mr', `${Math.round(radius)}px`);
    highlight.style.opacity = '1';
    pointerState.last = { x: Math.round(localX), y: Math.round(localY) };
    pointerState.paints += 1;
  };
  const clearPoint = () => {
    layer.style.setProperty('--canvas-grid-mx', '-9999px');
    layer.style.setProperty('--canvas-grid-my', '-9999px');
    highlight.style.opacity = '0';
  };

  /**
   * 把画布的 transform 落到网格层的 CSS 变量上。
   *
   * ⚠️ **平移量原样写，不乘 devicePixelRatio**（v1.33 的老 bug：乘了之后网格位移 =
   * 节点位移 × dpr，125% 缩放的屏幕上网格比节点快 1.25 倍）。`#canvas-viewport-content`
   * 的 `translate3d(x px, y px, 0)` 本来就是 CSS px，节点就是按它画的，底纹按同一个数
   * 平移才可能同速。dpr 只写进 `--canvas-grid-dpr` 供排障读，不参与几何。
   */
  const syncTransform = (): HTMLElement | null => {
    const viewport = document.getElementById('canvas-viewport-content');
    const transform = readTransform(viewport?.style.transform ?? '');
    const dpr = window.devicePixelRatio || 1;
    layer.style.setProperty('--canvas-grid-zoom', String(transform.zoom));
    layer.style.setProperty('--canvas-grid-dpr', String(dpr));
    layer.style.setProperty('--canvas-grid-pan-x', transform.panX.toFixed(3));
    layer.style.setProperty('--canvas-grid-pan-y', transform.panY.toFixed(3));
    return viewport;
  };

  // 平移/缩放：React 每次都重写 #canvas-viewport-content 的 style，监听属性即可；
  // 指针悬停期间再加一个 rAF 兜底，万一有哪次改动没触发观察器，底纹也不会和画布脱节。
  let viewport = syncTransform();
  const transformObserver =
    typeof MutationObserver === 'function' ? new MutationObserver(() => void syncTransform()) : null;
  if (viewport) {
    transformObserver?.observe(viewport, { attributes: true, attributeFilter: ['style'] });
  }

  const tick = () => {
    tickFrame = 0;
    if (!running) return;
    viewport = syncTransform();
    if (!viewport) {
      transformObserver?.disconnect();
      const next = document.getElementById('canvas-viewport-content');
      if (next && transformObserver) {
        viewport = next;
        transformObserver.observe(next, { attributes: true, attributeFilter: ['style'] });
      }
    }
    tickFrame = rAF ? rAF(tick) : 0;
  };
  const startTick = () => {
    if (running) return;
    running = true;
    if (rAF && !tickFrame) tickFrame = rAF(tick);
  };
  const stopTick = () => {
    running = false;
    if (cAF && tickFrame) cAF(tickFrame);
    tickFrame = 0;
  };

  /**
   * 指针跟随（v1.27 修的那个 bug）。
   *
   * ⚠️ **绝对不要把监听挂回网格层自己**：网格层必须 `pointer-events: none`（铺满画布，不能
   * 抢画布的指针事件），而 pointer-events:none 的元素**永远不是命中目标** —— 真实鼠标的
   * pointermove 落在 `#canvas-background` 或节点上，一帧都不会到网格层。
   * v1.8～v1.26 就是这么写的：jsdom 与 browser-check 都用 `dispatchEvent` 直接派给网格层，
   * 合成事件绕过命中测试 → 两套回归全绿，真机上却一点反应都没有
   * （用户 v1.27 原话：「现在画布与鼠标没有互动效果」）。
   *
   * 所以改成 **window 捕获阶段**监听：
   *   - 捕获阶段不受任何节点/面板 `stopPropagation` 的影响（节点拖动、右键菜单都拦不住它）；
   *   - 是不是在画布里用网格层自己的 rect 判（规则：DOM 事实先过 `rect > 1px` 这道闸；
   *     量不出来 —— jsdom / 隐藏 —— 就退回事件自带 offsetX/offsetY，别做范围过滤）。
   */
  const locate = (event: PointerEvent): { x: number; y: number } | null => {
    const rect = layer.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) {
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      // 指针在画布外（窗口级监听会收到整个文档的移动）→ 当作「离开画布」。
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
      return { x, y };
    }
    // 量不出布局：用事件自带的 offset（jsdom 里由脚本显式定义）。
    const { offsetX, offsetY } = event;
    if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) return { x: offsetX, y: offsetY };
    return null;
  };

  /**
   * ⚠️ 这里**同步**画（不再用 rAF 节流），两个原因：
   *   ① 浏览器本来就把 pointermove 合并到帧率（Chrome：一帧最多派发一次，其余进
   *      getCoalescedEvents），所以同步画不会变成「每帧写好几次」；
   *   ② browser-check 的探针**必须全程同步**（headless 的 --virtual-time-budget 一到
   *      浏览器就退出，await setTimeout/rAF 都会让探针发不出去），rAF 节流会让探针
   *      永远读到上一帧的值 —— 那就等于没验。这里只写 3 个 CSS 变量 + 一次 opacity，
   *      比同帧的画布绘制便宜得多。
   */
  const hideGlow = () => {
    stopTick();
    clearPoint();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!enabled) return;
    const point = locate(event);
    if (!point) {
      hideGlow();
      return;
    }
    startTick();
    highlightPoint(point.x, point.y);
  };
  /** 指针从窗口/画布出去时不会再有 pointermove，兜底清一次（blur 与 relatedTarget=null 的 out）。 */
  const onPointerLost = () => {
    hideGlow();
  };
  const onPointerOut = (event: PointerEvent) => {
    if (!event.relatedTarget) hideGlow();
  };

  const attachPointer = () => {
    if (listening) return;
    listening = true;
    pointerState.listening = true;
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerdown', onPointerMove, true);
    window.addEventListener('pointerout', onPointerOut, true);
    window.addEventListener('blur', onPointerLost);
  };
  const detachPointer = () => {
    if (!listening) return;
    listening = false;
    pointerState.listening = false;
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', onPointerMove, true);
    window.removeEventListener('pointerout', onPointerOut, true);
    window.removeEventListener('blur', onPointerLost);
  };

  /**
   * 把设置（./CanvasEffectsStore）落到这一层上。
   * 关掉时**摘监听 + 清遮罩**：底纹退回纯静态，不占一帧预算，也不会在后台空跑 rAF。
   * `data-canvas-grid-interactive` 是回归与排查的读数（真机上「看起来没反应」时先看它）。
   */
  const applyEffectState = () => {
    enabled = canvasEffects().pointerGlow;
    pointerState.enabled = enabled;
    layer.setAttribute('data-canvas-grid-interactive', enabled ? 'on' : 'off');
    if (enabled) {
      attachPointer();
      return;
    }
    detachPointer();
    hideGlow();
  };

  // 主题：容器上打一份（方便排查与测试），样式规则本身按 html[data-af-theme] 走。
  const rootElement = document.documentElement;
  const applyTheme = () => {
    layer.setAttribute('data-canvas-grid-theme', resolveTheme(rootElement, layer));
  };
  applyTheme();
  const themeObserver =
    typeof MutationObserver === 'function' ? new MutationObserver(applyTheme) : null;
  themeObserver?.observe(rootElement, { attributes: true, attributeFilter: ['data-af-theme'] });

  // 互动效果开关（设置 → 画布外观 → 画布互动）：先按当前设置落一次，再订阅后续变化。
  applyEffectState();
  const unsubscribeEffects = subscribeCanvasEffects(applyEffectState);

  return {
    canvas,
    layer,
    dispose() {
      stopTick();
      detachPointer();
      unsubscribeEffects();
      transformObserver?.disconnect();
      themeObserver?.disconnect();
      layer.remove();
    },
  };
}

/** 供排查用：画布网格层当前的真实状态（诊断接口回报这个）。 */
export function canvasGridReport(): Record<string, unknown> | null {
  const layer = document.querySelector<HTMLElement>('[data-canvas-grid="true"]');
  if (!layer) return { mounted: false, effects: canvasEffectsReport() };
  const viewport = document.getElementById('canvas-viewport-content');
  const transform = readTransform(viewport?.style.transform ?? '');
  const pointer = interactivity.get(layer) ?? null;
  /**
   * 「网格比节点快」的首查读数（v1.33）：网格层里写的平移必须**等于**画布 transform 的平移。
   * 一旦有人在几何里又乘了 dpr / 缩放，这两个数就会分叉。
   */
  const gridPanX = Number.parseFloat(layer.style.getPropertyValue('--canvas-grid-pan-x'));
  const gridPanY = Number.parseFloat(layer.style.getPropertyValue('--canvas-grid-pan-y'));
  const panMatchesTransform =
    Number.isFinite(gridPanX) &&
    Number.isFinite(gridPanY) &&
    Math.abs(gridPanX - transform.panX) < 0.01 &&
    Math.abs(gridPanY - transform.panY) < 0.01;
  return {
    mounted: true,
    inCanvasBackground: layer.parentElement?.id === 'canvas-background',
    isFirstChild: layer.parentElement?.firstElementChild === layer,
    pointerEvents: getComputedStyle(layer).pointerEvents,
    theme: layer.getAttribute('data-canvas-grid-theme'),
    spacing: STYLE_CONSTANTS.spacing,
    radius: STYLE_CONSTANTS.radius,
    /** 设置 →「画布互动」的开关状态 + 落点（v1.27）。 */
    interactive: layer.getAttribute('data-canvas-grid-interactive'),
    effects: canvasEffectsReport(),
    /** 指针跟随的读数：enabled/listening/last/paints（见 PointerInteractivityState 的注释）。 */
    pointer: pointer
      ? {
          enabled: pointer.enabled,
          listening: pointer.listening,
          last: pointer.last,
          paints: pointer.paints,
        }
      : null,
    /** 小十字星的几何（测试/排查按这个断言，别在测试里抄数字）。 */
    star: {
      spacing: STYLE_CONSTANTS.spacing,
      arm: STYLE_CONSTANTS.arm,
      stroke: STYLE_CONSTANTS.stroke,
      size: STYLE_CONSTANTS.arm * 2 + STYLE_CONSTANTS.stroke,
      ink: `${STYLE_CONSTANTS.darkInk}@${STYLE_CONSTANTS.darkInkOpacity}`,
    },
    viewportTransform: viewport?.style.transform ?? null,
    canvasTransform: transform,
    /** 网格几何口径：CSS px（= 节点同一个坐标系；掺 dpr 就会让网格比节点跑得快）。 */
    geometry: 'css-px',
    /** 网格层写的平移 == 画布 translate？（报「网格比节点快」时先看这两个读数） */
    panMatchesTransform,
    devicePixelRatio: window.devicePixelRatio || 1,
    variables: {
      zoom: layer.style.getPropertyValue('--canvas-grid-zoom'),
      dpr: layer.style.getPropertyValue('--canvas-grid-dpr'),
      panX: layer.style.getPropertyValue('--canvas-grid-pan-x'),
      panY: layer.style.getPropertyValue('--canvas-grid-pan-y'),
      maskX: layer.style.getPropertyValue('--canvas-grid-mx'),
      maskY: layer.style.getPropertyValue('--canvas-grid-my'),
      maskRadius: layer.style.getPropertyValue('--canvas-grid-mr'),
    },
    highlightOpacity: layer.querySelector<HTMLElement>('.is-highlight')?.style.opacity ?? null,
  };
}

/**
 * 在画布挂载时装上点阵底纹。
 *
 * 底盘 `#canvas-background` 在 React 切 documentEpoch 时会被整体重建，
 * 所以这里用 MutationObserver 盯住容器：底盘一换，网格层跟着重挂。
 * 返回的 disposer 必须由 mountCanvas 在卸载时调用。
 */
export function mountCanvasGrid(options: { container: HTMLElement; observe?: boolean }): () => void {
  const ownerDocument = options.container.ownerDocument;
  const root = ownerDocument.documentElement;
  let runtime: GridRuntime | null = null;
  let disposed = false;

  const attach = (): boolean => {
    const canvas = options.container.querySelector<HTMLElement>('#canvas-background');
    if (!canvas) return false;
    if (runtime && runtime.canvas === canvas && canvas.contains(runtime.layer)) return true;
    runtime?.dispose();
    try {
      runtime = attachGridLayer(canvas, root);
    } catch (error) {
      runtime = null;
      reportCanvasError(
        `画布网格底纹安装失败：${error instanceof Error ? error.message : String(error)}`,
        { stack: error instanceof Error ? error.stack : undefined },
      );
      return false;
    }
    reportCanvasInfo('画布网格底纹已挂载', {
      spacing: STYLE_CONSTANTS.spacing,
      star: `${STYLE_CONSTANTS.arm * 2 + STYLE_CONSTANTS.stroke}x${STYLE_CONSTANTS.stroke}`,
      ink: `${STYLE_CONSTANTS.darkInk}@${STYLE_CONSTANTS.darkInkOpacity}`,
      radius: STYLE_CONSTANTS.radius,
      theme: resolveTheme(root, canvas),
      // v1.27：互动效果开关的初值 + 落点（关掉时这里是 off，且没有挂任何指针监听）
      interactive: canvasEffects().pointerGlow ? 'on' : 'off',
      effectsStorage: canvasEffectsReport().storage,
    });
    return true;
  };

  if (!attach()) {
    reportCanvasInfo('画布网格底纹等待底盘就绪（未找到 #canvas-background）', {});
  }

  let observer: MutationObserver | null = null;
  if (options.observe !== false && typeof MutationObserver === 'function') {
    // 合成一次挂载：这个观察器盯的是整个画布子树（底盘可能出现在任意深度），
    // 而画布每加一个节点都会产生一次 childList 变动 —— 逐条回调会在节点多的项目里
    // 白跑一堆 querySelector。用一个微任务把同一轮变动合并成一次 attach。
    let scheduled = false;
    const scheduleAttach = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      const run = () => {
        scheduled = false;
        if (!disposed) attach();
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(run);
      else void Promise.resolve().then(run);
    };
    observer = new MutationObserver(scheduleAttach);
    observer.observe(options.container, { childList: true, subtree: true });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    runtime?.dispose();
    runtime = null;
  };
}
