/**
 * 合成器编辑器（全屏 DOM 节点图）—— 纯 DOM + SVG，不碰 vendor 的 React 树。
 *
 * 为什么不用 React：画布产物里有两份 React 19，编辑器再引一份必然踩 hooks 分发器；
 * 而且节点图交互（pointer capture、命中、拖线）本来就是 DOM 事件的主场。
 * 与 knife.ts 同一套分工：手势与渲染在这里，vendor 只负责把「打开」和「写回」接上。
 *
 * 形态（用户 2026-10-28 定稿，2026-10-29 晚按 Blender 手感二次收紧）：
 *   - 上方只留一块预览：优先显示「预览」节点（Blender 的 Viewer），
 *     预览没接线时退回显示「输出」（并标出来），不再左右分屏；
 *     预览支持滚轮缩放（以光标为中心）/ 拖动平移 / 双击复位 —— 用户 2026-10-29
 *     「预览图像没有放大移动功能」；
 *   - 连线画在 **stage 屏幕坐标**上：默认就画好输入→输出 / 输入→预览两条，
 *     平移缩放时线宽恒定、跟着节点走；拖端口时线跟着鼠标走；
 *   - 背景点阵跟随平移/缩放（和主画布一致），不是固定贴纸；
 *   - 左键在空白处拖 = 框选多个节点（主画布同款），中键 / 空格+左键 = 平移，滚轮 = 缩放；
 *   - **参数控件直接长在节点身上**（Blender 的做法），不再有右侧属性面板 ——
 *     用户 2026-10-29「节点属性希望和 blender 一样显示在节点里，而不是在右侧」；
 *   - 新加的节点跟着鼠标走、左键放下（和主画布「新建并移动」一致）—— 用户 2026-10-29
 *     「shift新建节点后节点不会跟随鼠标指针，操作和主画布不一致」；
 *   - Shift+点击节点 = 接到预览，Ctrl+Shift+点击 = 接到输出，Shift+A 添加效果；
 *   - Shift+右键划过连线 = 同源合并 + 插转接点（和主画布同一套手势，且**任何起手位置
 *     都认**，包括正好压在连线上 —— 以前只认 stage/world 时压线就起不来）。
 *
 * 2026-10-29 晚再按用户报障收紧（原话见 CHANGELOG）：
 *   - **拖节点压住连线松手 = 插入连线**（Blender 的 insert-on-link），压住的线变蓝；
 *   - **端口命中区 10px → 26px**，松手按「线上的口 → 节点身上取空口 → 34px 内最近口」
 *     三级吸附，拖线时悬停节点的输入口整体点亮；
 *   - **数字参数换全宽自绘滑轨 + 专业单位**（色相 ±180°、饱和度/明度 %、色温 K、曝光 EV），
 *     Shift/Alt 微调、滚轮一格、方向键一步、双击复位（见 params.ts）；
 *   - **曲线节点有真编辑器**（主曲线 + R/G/B 分通道、点击加点/拖动/双击删点）；
 *   - 预览右侧 **示波器**：波形图 / 分量图 / 矢量图（数据来自 engine.readScope）；
 *   - 点「应用」后在主画布调色节点右侧落一张「调色结果」（vendor 桥，见 bridge 注释）。
 *
 * 2026-10-29 晚再按用户「要达芬奇同款示波器」收紧：
 *   - 直方图 tab 撤掉，换成达芬奇的三张图（波形图 / 分量图 / 矢量图），纵轴统一 10-bit
 *     0–1023、每 128 一格（画法全在 scopes.ts，这里只负责喂像素与切 tab）；
 *   - 示波器面板可调大小：拖左边缘改宽度、拖下边缘改高度、双击复位，尺寸存在
 *     `compositorGraph.scope` 里，下次打开还是这个大小；
 *   - 面板变宽后画布按 CSS 尺寸 × dpr 重设属性尺寸（不再写死 264×150，否则被拉伸糊掉）。
 *
 * 2026-10-30 按用户六条报障再收紧（原话见 CHANGELOG）：
 *   - **顶栏整体下移**让出 DSH 桌面窗口顶上 40px 的系统 caption 带（「上方的按钮点不动」），
 *     见 compositorTitlebarInset；
 *   - **圆形控件补 corner-shape: round**（DSH nova 主题把 border-radius:50% 变成超椭圆，
 *     「我的色轮怎么变方了」），规则在 styles.ts 顶部；
 *   - **Shift+A 菜单带模糊搜索**（中文子序列 / 拼音首字母 / 英文，上下键 + Enter，
 *     见 nodeSearch.ts）——「shift+a可以模糊输入查找节点」；
 *   - **下拉改自绘**（原生 select 弹层是系统白板）——「下拉选项的ui还没有做好」；
 *   - **落地/串线后自动避让**（graph.ts 的 resolveNodeOverlaps）——「加入一个较长的节点时节点会被遮住」；
 *   - 混合节点 A / B / **系数** 三输入。
 *
 * 历史坑：连线最初画在 `.cg-world` 里，端口坐标用 `.cg-port.out` 找 —— 真实 class 是
 * `cg-out` / `cg-in`，选择器永远命中不到，于是「默认图有边、屏幕上一条线都没有」。
 */

import {
  MIX_MODE_LABELS,
  MIX_MODES,
  CompositorEngine,
  CompositorEngineError,
} from './engine';
import {
  NODE_SPECS,
  canInsertIntoEdge,
  chooseApplyTargets,
  connect,
  createDefaultGraph,
  edgeId,
  evaluationOrder,
  inputPortLabel,
  inputPortsFor,
  insertNodeIntoEdge,
  newCompositorId,
  normalizeGraph,
  outputPortCount,
  paramsOf,
  removeNode,
  resolveNodeOverlaps,
  specOf,
  targetIsRawInput,
  type CompositorEdge,
  type CompositorGraph,
  type CompositorInputImage,
  type CompositorKind,
  type CompositorNode,
  type CompositorParamValue,
} from './graph';
import { creatableNodeCount, searchNodeKinds, type NodeSearchHit } from './nodeSearch';
import {
  MAX_CURVE_POINTS,
  addCurvePoint,
  curveAt,
  flattenCurve,
  normalizeCurvePoints,
  removeCurvePoint,
  type CurvePoint,
} from './curves';
import {
  clampRaw,
  displayBounds,
  formatParam,
  isBipolar,
  paramMeta,
  parseDisplay,
  toDisplay,
  toRaw,
} from './params';
import { drawScope, type ScopeImage, type ScopeKind } from './scopes';
import { COMPOSITOR_STYLE } from './styles';
import { WHEEL_NODE_WIDTH, renderColorWheels } from './wheels-ui';

export interface CompositorApplyPayload {
  graph: CompositorGraph;
  dataUrl: string;
}

export interface OpenCompositorOptions {
  nodeId: string;
  title?: string;
  images: CompositorInputImage[];
  graph?: unknown;
  onApply: (payload: CompositorApplyPayload) => void | Promise<void>;
  onClose?: () => void;
}

const STYLE_ATTR = 'data-fisherai-compositor-style';
const MIN_SCALE = 0.12;
const MAX_SCALE = 3;
/** 节点宽度与其他几何常量必须和 styles.ts 对齐（连线按它们算，不再读 DOM 布局）。 */
const NODE_WIDTH = 224;
/** 转接点是个小圆点（Blender Reroute），不是卡片。 */
const REROUTE_WIDTH = 34;
const REROUTE_HEIGHT = 34;
/** 标题栏高度：端口默认落在标题栏竖直正中（和 styles.ts 的 .cg-node-head 对齐）。 */
const HEADER_HEIGHT = 34;
const PORT_SIZE = 12;
const PORT_HALF = PORT_SIZE / 2;
const GRID_STEP = 26;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** 划选合并的手势允许的「擦到」半径（屏幕像素）。 */
const MERGE_HIT_TOLERANCE = 7;
/** 采一条连线用多少段（命中精度与开销的折中）。 */
const MERGE_SAMPLE_STEPS = 24;
/** 松手时离输入口多近算接上（屏幕像素）；端口本身只有 12px，靠这个把「手感」放大。 */
const LINK_SNAP_RADIUS = 34;
/** 缩放/拖动结束后多久撤掉 will-change（让 Chrome 按新 DPI 重新栅格化文字）。 */
const SCALING_IDLE_MS = 140;
/** 示波器刷新间隔：readPixels 同步，拖滑块时别每帧都读。 */
const SCOPE_INTERVAL_MS = 80;
/** 曲线编辑器在节点里的绘制区域（viewBox 单位，CSS 会拉伸到卡片宽度）。 */
const CURVE_W = 200;
const CURVE_H = 104;
const CURVE_PAD = 6;

const FIXED_NODES = new Set(['input', 'output', 'viewer']);

/** Electron 桌面端右上角的窗口按钮（titleBarOverlay 画的 − ▢ ✕）盖在网页上，点不到也看不见。 */
export interface WindowControlsOverlayLike {
  visible?: boolean;
  getTitlebarAreaRect?: () => { x: number; width: number } | null | undefined;
  addEventListener?: (type: string, listener: () => void) => void;
}

/**
 * 顶栏右侧要让给系统窗口按钮的宽度（CSS px）。
 *
 * 背景（用户 2026-10-29 报「没有应用按钮啊？」）：DSH 桌面窗口用
 * `titleBarStyle:'hidden' + titleBarOverlay`，Windows 的原生 − ▢ ✕ 是**画在网页上方**的，
 * 任何 z-index 都压不住；调色面板的「保存并退出」正好在右上角，被整个盖住。
 * 所以顶栏右侧要按窗口按钮的宽度留白。
 *
 * 优先问 Window Controls Overlay 的几何量（换 DPI / 换系统按钮宽度都跟得上），
 * 拿不到就退：Electron 里留 152px（46px × 3 个按钮），浏览器里留 0。
 */
export function compositorTopbarInset(
  userAgent: string,
  overlay?: WindowControlsOverlayLike | null,
  viewportWidth = 0,
): number {
  try {
    const rect = overlay?.getTitlebarAreaRect?.();
    if (overlay?.visible && rect && rect.width > 0 && viewportWidth > 0) {
      const inset = viewportWidth - (rect.x + rect.width);
      if (inset > 1) return Math.min(240, Math.round(inset));
    }
  } catch {
    /* 老版本没有这个 API：走下面的兜底 */
  }
  return /\bElectron\//.test(userAgent) ? 152 : 0;
}

/**
 * 顶栏要往下让出多少像素（系统标题栏高度）。
 *
 * 背景（用户 2026-10-30 报「上方的按钮点不动」）：上一版只做了**水平**让位，
 * 但 DSH 桌面窗口（`titleBarStyle:'hidden'` + `titleBarOverlay.height: 40`）顶上
 * 那 40px 是 Windows 的原生 caption 带 —— 鼠标事件根本不进网页。调色面板的顶栏
 * 正好从 y=0 开始，「+ 添加节点 / 示波器 / 适应视图 / 放弃修改 / 保存并退出」全在
 * 这条带子里，点了没反应。DSH 自己的全屏面板同样是 `padding-top:
 * var(--dsh-windows-titlebar-height)`，这里按同一套路给自己加一条。
 *
 * 优先用 Window Controls Overlay 的高度（40 / 42 会随系统设置变），拿不到就退：
 * Electron 里按 40px，浏览器里 0。
 */
export function compositorTitlebarInset(
  userAgent: string,
  overlay?: WindowControlsOverlayLike | null,
): number {
  try {
    const rect = overlay?.getTitlebarAreaRect?.() as { height?: number } | null | undefined;
    if (overlay?.visible && rect && typeof rect.height === 'number' && rect.height > 0) {
      return Math.min(96, Math.round(rect.height));
    }
  } catch {
    /* 老版本没有这个 API：走下面的兜底 */
  }
  return /\bElectron\//.test(userAgent) ? 40 : 0;
}

/** 节点宽度：转接点是 Blender 那种小圆点，比普通卡片窄；四轮调色要横排四个色轮。 */
function nodeWidthOf(kind: CompositorKind): number {
  if (kind === 'reroute') return REROUTE_WIDTH;
  if (kind === 'colorBalance') return WHEEL_NODE_WIDTH;
  return NODE_WIDTH;
}

/** 节点分类色：方案 C 只拿它当标题栏那颗小圆点（不再整条铺满），所以用亮一档的色。 */
const HEAD_COLORS: Record<string, string> = {
  input: '#8fa8bd',
  output: '#c98f8f',
  viewer: '#8fb6c9',
  reroute: '#b09cd8',
  基础: '#8b98ab',
  颜色: '#d8a45e',
  混合: '#5ec2a0',
  滤镜: '#9c8be0',
  蒙版: '#d87a9a',
};

/** 蒙版节点的输出是灰度遮罩，连线用灰白，和图像线（黄绿）区分开。 */
const MASK_KINDS = new Set<CompositorKind>(['ellipseMask', 'boxMask', 'gradientMask']);

function headColor(node: CompositorNode): string {
  return HEAD_COLORS[node.kind] ?? HEAD_COLORS[specOf(node.kind).category] ?? '#3f4650';
}

/** 图像插槽黄绿、遮罩插槽灰白 —— 和 Blender 的 socket 颜色语义一致。 */
function socketColor(fromKind: CompositorKind): 'image' | 'mask' {
  return MASK_KINDS.has(fromKind) ? 'mask' : 'image';
}

/** 撤销快照：整张图的节点与连线（视图平移/缩放、示波器设置不进历史）。 */
interface GraphSnapshot {
  nodes: CompositorNode[];
  edges: CompositorEdge[];
}

/** 撤销历史：past/future 两条栈 + 一次连续手势的起点快照 + 打开时的基线。 */
interface HistoryState {
  past: GraphSnapshot[];
  future: GraphSnapshot[];
  /** 连续手势（滑块 / 色轮 / 曲线）里第一次改动前的快照；停手 420ms 合成一步。 */
  pending: GraphSnapshot | null;
  pendingTimer: number;
  baseline: GraphSnapshot;
}

interface NodeDrag {
  id: string;
  clientX: number;
  clientY: number;
  /** 拖动开始时所有选中节点的位置：多选时整体移动。 */
  positions: Map<string, { x: number; y: number }>;
  /** 按下那一刻的图：松手时和「压线插入」一起合成一步撤销。 */
  before: GraphSnapshot;
}

interface PanDrag {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

interface MarqueeDrag {
  startX: number;
  startY: number;
  additive: boolean;
  base: string[];
  element: HTMLElement;
  moved: boolean;
  hits: string[];
}

interface LinkDrag {
  fromNode: string;
  fromPort: number;
  path: SVGPathElement;
}

interface MergeHit {
  edge: CompositorEdge;
  /** 划选线上第一次擦到这条连线的位置（stage 屏幕坐标）。 */
  point: { x: number; y: number };
}

/**
 * 划选手势（右键）：
 *   - merge = Shift+右键：同源连线收进一个转接点（Blender 的 reroute）；
 *   - cut   = Ctrl/Meta+右键：划过的连线直接断开（和主画布 knife.ts 同一个手势）。
 * 两者共用采样 / 命中 / 浮层，只是松手时做的事不同。
 */
interface StrokeDrag {
  mode: 'merge' | 'cut';
  stroke: Array<{ x: number; y: number }>;
  path: SVGPathElement;
  hint: SVGPathElement;
  hits: Map<string, MergeHit>;
}

/** 「新建并移动」：节点跟着鼠标走，下一次左键按下 = 放下（与主画布 canvasNodeState 同手感）。 */
interface PlacementDrag {
  id: string;
  /** 第一次 pointermove 只定基线，不搬节点（否则会在起手点跳一下）。 */
  lastX: number | null;
  lastY: number | null;
}

/** 拖节点经过一条连线时的候选：松手就把节点串进去（Blender 的 insert-on-link）。 */
interface InsertTarget {
  nodeId: string;
  edgeId: string;
}

/** 示波器面板的当前状态。 */
interface ScopeState {
  kind: ScopeKind;
  visible: boolean;
  image: ScopeImage | null;
  clipShadow: number;
  clipHighlight: number;
  /** 面板宽度（CSS px）；用户可拖左边缘改，存在 compositorGraph.scope 里。 */
  width: number;
  /** 面板高度（CSS px）；0 = 跟着预览那行拉满。 */
  height: number;
}

/** 示波器面板的可调范围：太窄刻度会糊，太宽把预览挤没了。 */
const SCOPE_MIN_WIDTH = 168;
const SCOPE_MIN_HEIGHT = 132;
const SCOPE_MAX_HEIGHT = 620;
/** 预览至少留这么宽（拖示波器宽度时封顶用）。 */
const PREVIEW_MIN_WIDTH = 240;

function isScopeKind(value: unknown): value is ScopeKind {
  return value === 'waveform' || value === 'parade' || value === 'vectorscope';
}

/** 上方预览的视图：zoom=1 即「整幅适应窗口」（canvas 用的是 object-fit: contain）。 */
interface PreviewView {
  zoom: number;
  x: number;
  y: number;
}

interface Session {
  options: OpenCompositorOptions;
  graph: CompositorGraph;
  view: { x: number; y: number; scale: number };
  selection: string[];
  root: HTMLElement;
  stage: HTMLElement;
  world: HTMLElement;
  edgeLayer: SVGSVGElement;
  meta: HTMLElement;
  previewTag: HTMLElement;
  previewEmpty: HTMLElement;
  engine: CompositorEngine | null;
  canvas: HTMLCanvasElement | null;
  size: { width: number; height: number };
  dirty: boolean;
  /** 用户是否真的动过图（改参数 / 接线 / 增删节点）；Esc 与「保存并退出」靠它决定要不要落图。 */
  edited: boolean;
  destroyed: boolean;
  linkDrag: LinkDrag | null;
  strokeDrag: StrokeDrag | null;
  nodeDrag: NodeDrag | null;
  panDrag: PanDrag | null;
  marquee: MarqueeDrag | null;
  placement: PlacementDrag | null;
  placementController: AbortController | null;
  /** 拖节点时压住的那条线（松手串进去）。 */
  insertTarget: InsertTarget | null;
  /** 拖线时悬停的目标节点（只用于高亮输入口）。 */
  linkHoverNode: string | null;
  scope: ScopeState;
  preview: PreviewView;
  previewPan: PanDrag | null;
  tHeld: boolean;
  spaceHeld: boolean;
  frame: number | null;
  onKey: (event: KeyboardEvent) => void;
  toast: (message: string, error?: boolean) => void;
  previousOverflow: string;
  controller: AbortController;
  /** Ctrl+Z / Ctrl+Shift+Z 的整图撤销栈（见 GraphSnapshot）。 */
  history: HistoryState;
}

let session: Session | null = null;

/** 当前打开的自绘下拉的关闭函数（同一时刻只允许一个；重绘 / 关面板时收起）。 */
let openSelectPopup: (() => void) | null = null;
const closePopup = (): void => {
  const close = openSelectPopup;
  if (!close) return;
  openSelectPopup = null;
  close();
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function ensureStyle(): void {
  if (document.querySelector(`style[${STYLE_ATTR}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, 'true');
  style.textContent = COMPOSITOR_STYLE;
  document.head.appendChild(style);
}

/** 同屏只允许一个合成器；重复打开视为「切到那个节点」。 */
export function openCompositorEditor(options: OpenCompositorOptions): void {
  if (session) closeCompositorEditor();
  ensureStyle();
  const graph = normalizeGraph(options.graph, options.images.length);
  const root = document.createElement('div');
  root.className = 'cg-root';
  root.setAttribute('data-fisherai-compositor', 'true');

  const top = document.createElement('header');
  top.className = 'cg-top';
  // 右上角让出 Electron 原生窗口按钮（见 compositorTopbarInset 的注释）
  const topbarOverlay = (navigator as unknown as { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay;
  const applyTopbarInset = (): void => {
    const inset = compositorTopbarInset(navigator.userAgent, topbarOverlay, window.innerWidth);
    root.style.setProperty('--cg-topbar-right', `${inset}px`);
    root.style.setProperty(
      '--cg-titlebar-top',
      `${compositorTitlebarInset(navigator.userAgent, topbarOverlay)}px`,
    );
  };
  applyTopbarInset();
  try {
    topbarOverlay?.addEventListener?.('geometrychange', applyTopbarInset);
  } catch {
    /* 没有 WCO 事件的环境（浏览器 / 老 Electron）不用管 */
  }
  const title = document.createElement('div');
  title.className = 'cg-title';
  title.textContent = options.title ? `调色 · ${options.title}` : '调色 · 合成器';
  const meta = document.createElement('div');
  meta.className = 'cg-meta';
  meta.textContent = '';
  const spacer = document.createElement('div');
  spacer.className = 'cg-spacer';
  const button = (label: string, act: string, primary = false): HTMLButtonElement => {
    const element = document.createElement('button');
    element.className = primary ? 'cg-btn cg-primary' : 'cg-btn';
    element.textContent = label;
    element.dataset.act = act;
    return element;
  };
  const addButton = button('+ 添加节点', 'add');
  const scopeButton = button('示波器', 'scopes');
  const fitButton = button('适应视图', 'fit');
  // v1.78：撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z）。原本只有主画布有历史，调色面板里拖错一下只能手调回去。
  const undoButton = button('↶', 'undo');
  undoButton.title = '撤销（Ctrl+Z）';
  undoButton.disabled = true;
  const redoButton = button('↷', 'redo');
  redoButton.title = '重做（Ctrl+Shift+Z / Ctrl+Y）';
  redoButton.disabled = true;
  // 「保存并退出」是主动作（用户 2026-10-29：「希望按退出也会输出保存图像」）。
  // 「放弃修改」要二次确认才真丢，避免把刚调好的色一键清了。
  const cancelButton = button('放弃修改', 'cancel');
  cancelButton.title = '不保存本次调整，直接关闭（需再点一次确认）';
  const applyButton = button('保存并退出', 'apply', true);
  applyButton.title = '保存这张调色结果，并在调色节点后面落一张成品图（Esc 同效）';
  // 主动作单独成组：窗口窄到要换行时，「放弃修改 / 保存并退出」整组仍靠右，不会散到左边。
  const actions = document.createElement('div');
  actions.className = 'cg-actions';
  actions.append(cancelButton, applyButton);
  top.append(title, meta, spacer, undoButton, redoButton, addButton, scopeButton, fitButton, actions);

  // ---- 上方预览：只有一块，以「预览」节点为主 --------------------------
  const previews = document.createElement('section');
  previews.className = 'cg-previews';
  const previewBox = document.createElement('div');
  previewBox.className = 'cg-preview';
  const previewCanvas = document.createElement('canvas');
  previewCanvas.className = 'cg-preview-canvas';
  previewCanvas.width = 1;
  previewCanvas.height = 1;
  const previewTag = document.createElement('span');
  previewTag.className = 'cg-preview-label';
  previewTag.textContent = '预览 VIEWER';
  const previewEmpty = document.createElement('div');
  previewEmpty.className = 'cg-preview-empty';
  previewEmpty.textContent = '';
  // 缩放读数 + 手势提示：Blender Image Editor 也是左下角写「100%」那一套。
  const previewZoom = document.createElement('span');
  previewZoom.className = 'cg-preview-zoom';
  previewZoom.textContent = '100%';
  previewZoom.title = '双击复位到 100%';
  const previewHint = document.createElement('span');
  previewHint.className = 'cg-preview-hint';
  previewHint.textContent = '滚轮缩放 · 拖动平移 · 双击复位';
  previewBox.append(previewCanvas, previewTag, previewEmpty, previewZoom, previewHint);

  // ---- 右侧示波器：分量图 / 波形图 / 矢量图（达芬奇同款）-------------------
  // 数据从引擎的降采样缓冲来（engine.readScope），这里只负责画、切 tab、调面板大小。
  const scopePanel = document.createElement('aside');
  scopePanel.className = 'cg-scopes';
  const scopeTabs = document.createElement('div');
  scopeTabs.className = 'cg-scope-tabs';
  const scopeButtons: HTMLButtonElement[] = [];
  const scopeKinds: Array<{ kind: ScopeKind; label: string }> = [
    { kind: 'waveform', label: '波形图' },
    { kind: 'parade', label: '分量图' },
    { kind: 'vectorscope', label: '矢量图' },
  ];
  for (const entry of scopeKinds) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'cg-scope-tab';
    tab.dataset.scope = entry.kind;
    tab.textContent = entry.label;
    scopeTabs.append(tab);
    scopeButtons.push(tab);
  }
  const scopeCanvas = document.createElement('canvas');
  scopeCanvas.className = 'cg-scope-canvas';
  // 属性尺寸随后由 syncScopeCanvas 按 CSS 尺寸 × dpr 重设（面板可调大小）
  scopeCanvas.width = 264;
  scopeCanvas.height = 150;
  // canvas 必须绝对定位进这个壳里：它的属性尺寸会改变自身固有宽高比，
  // 直接当 flex 项会把父面板撑高，进而把预览那行越拖越高（实测 378 → 560，连带视图被缩没）。
  const scopeBody = document.createElement('div');
  scopeBody.className = 'cg-scope-body';
  scopeBody.append(scopeCanvas);
  const scopeClip = document.createElement('div');
  scopeClip.className = 'cg-scope-clip';
  scopeClip.textContent = '示波器待命';
  // 两条拉动条：左边缘改宽度、下边缘改高度（双击任一复位）。达芬奇也是拖面板边缘改大小。
  const scopeGripX = document.createElement('div');
  scopeGripX.className = 'cg-scope-grip-x';
  scopeGripX.title = '拖动调整示波器宽度 · 双击复位';
  const scopeGripY = document.createElement('div');
  scopeGripY.className = 'cg-scope-grip-y';
  scopeGripY.title = '拖动调整示波器高度 · 双击复位';
  scopePanel.append(scopeTabs, scopeBody, scopeClip, scopeGripX, scopeGripY);

  const previewRow = document.createElement('div');
  previewRow.className = 'cg-preview-row';
  previewRow.append(previewBox, scopePanel);
  previews.append(previewRow);

  // ---- 节点画布：连线层在 stage 坐标，节点层在 world 坐标 ----------------
  const stage = document.createElement('section');
  stage.className = 'cg-stage';
  const edgeLayer = document.createElementNS(SVG_NS, 'svg');
  edgeLayer.setAttribute('class', 'cg-edges');
  edgeLayer.setAttribute('width', '100%');
  edgeLayer.setAttribute('height', '100%');
  const world = document.createElement('div');
  world.className = 'cg-world';
  // 快捷键提示挪到画布左下角（右侧属性面板已拆掉，参数直接长在节点上）
  const hintbar = document.createElement('div');
  hintbar.className = 'cg-hintbar';
  hintbar.textContent =
    '空白拖=框选 · 中键/空格=平移 · 滚轮=缩放 · Shift+A=添加节点 · 拖节点压线=插入连线 · 双击连线=断开 · Ctrl+右键划过=断开 · Shift+右键划过=合线 · Delete=删除 · Ctrl+Z=撤销';
  stage.append(edgeLayer, world, hintbar);

  // 右下角缩放读数：和顶栏「适应视图」同一个动作，顺手可点。
  // 它也是「放大不糊」这件事的可见落点 —— 用户放大节点时最先看的就是这个数。
  const zoomHud = document.createElement('div');
  zoomHud.className = 'cg-zoom';
  const zoomOutButton = document.createElement('button');
  zoomOutButton.type = 'button';
  zoomOutButton.textContent = '−';
  zoomOutButton.title = '缩小';
  const zoomValueButton = document.createElement('button');
  zoomValueButton.type = 'button';
  zoomValueButton.className = 'cg-zoom-value';
  zoomValueButton.textContent = '100%';
  zoomValueButton.title = '点一下回到 100%';
  const zoomInButton = document.createElement('button');
  zoomInButton.type = 'button';
  zoomInButton.textContent = '+';
  zoomInButton.title = '放大';
  const zoomFitButton = document.createElement('button');
  zoomFitButton.type = 'button';
  zoomFitButton.textContent = '⤢';
  zoomFitButton.title = '适应视图';
  zoomHud.append(zoomOutButton, zoomValueButton, zoomInButton, zoomFitButton);
  zoomHud.addEventListener('pointerdown', (event) => event.stopPropagation());
  stage.append(zoomHud);

  root.append(top, previews, stage);

  const toastElement = document.createElement('div');
  toastElement.className = 'cg-toast';
  root.append(toastElement);

  // 示波器状态随图存（graph.scope）。老图没有这段 → 波形图 + 打开 + 268px 宽 + 跟着预览行拉满。
  const restoredScope = graph.scope;
  const scopeState: ScopeState = {
    kind: isScopeKind(restoredScope?.kind) ? restoredScope.kind : 'waveform',
    visible: restoredScope ? restoredScope.visible !== false : true,
    image: null,
    clipShadow: 0,
    clipHighlight: 0,
    width: clamp(Number(restoredScope?.width) || 268, SCOPE_MIN_WIDTH, 900),
    // 0 = 高度交给 flex 拉满（和预览那块对齐）
    height: clamp(Number(restoredScope?.height) || 0, 0, SCOPE_MAX_HEIGHT),
  };

  const session_: Session = {
    options,
    graph,
    view: graph.view
      ? {
          x: Number(graph.view.x) || 0,
          y: Number(graph.view.y) || 0,
          scale: clamp(Number(graph.view.scale) || 1, MIN_SCALE, MAX_SCALE),
        }
      : { x: 60, y: 40, scale: 1 },
    selection: [],
    root,
    stage,
    world,
    edgeLayer,
    meta,
    previewTag,
    previewEmpty,
    engine: null,
    canvas: previewCanvas,
    size: { width: 1024, height: 1024 },
    dirty: true,
    edited: false,
    destroyed: false,
    linkDrag: null,
    strokeDrag: null,
    nodeDrag: null,
    panDrag: null,
    marquee: null,
    placement: null,
    placementController: null,
    insertTarget: null,
    linkHoverNode: null,
    scope: scopeState,
    preview: { zoom: 1, x: 0, y: 0 },
    previewPan: null,
    tHeld: false,
    spaceHeld: false,
    frame: null,
    onKey: () => undefined,
    toast: () => undefined,
    previousOverflow: document.body.style.overflow,
    // 必须用 window 上那份 AbortController：jsdom 的 EventTarget 只认自己的 AbortSignal，
    // 用 Node 全局那份会在 addEventListener({signal}) 处直接抛错（整块事件注册静默失败）。
    controller: new (window.AbortController ?? AbortController)(),
    history: {
      past: [],
      future: [],
      pending: null,
      pendingTimer: 0,
      baseline: JSON.parse(JSON.stringify({ nodes: graph.nodes, edges: graph.edges })) as GraphSnapshot,
    },
  };
  session = session_;
  window.addEventListener('resize', applyTopbarInset, { signal: session_.controller.signal });

  // 示波器的节流状态（每开一次合成器一份）
  let pendingScope: { target: string; presented: boolean } | null = null;
  let scopeTimer = 0;
  let scopePaintedAt = 0;

  let toastTimer = 0;
  session_.toast = (message: string, error = false) => {
    toastElement.textContent = message;
    toastElement.classList.toggle('cg-error', error);
    toastElement.classList.add('cg-show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastElement.classList.remove('cg-show'), 2200);
  };

  document.body.append(root);
  document.body.style.overflow = 'hidden';

  // ---- 引擎与预览 ------------------------------------------------------
  const initEngines = (): void => {
    try {
      session_.engine = new CompositorEngine(previewCanvas, session_.graph);
      session_.engine.setImages(options.images);
      session_.engine.onInvalidate = () => schedule();
    } catch (error) {
      session_.toast(error instanceof CompositorEngineError ? error.message : String(error), true);
    }
  };

  // 尺寸取第一张输入图；加载失败就退回 1024。
  const resolveSize = (): void => {
    const first = options.images[0];
    if (!first) return;
    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      if (session_ !== session || !probe.naturalWidth || !probe.naturalHeight) return;
      session_.size = { width: probe.naturalWidth, height: probe.naturalHeight };
      meta.textContent = `${session_.size.width} × ${session_.size.height} · ${options.images.length} 张输入`;
      schedule();
    };
    probe.onerror = () => undefined;
    probe.src = first.url;
  };

  // ---- 求值调度 --------------------------------------------------------
  const schedule = (): void => {
    if (session_ !== session || session_.destroyed) return;
    if (session_.frame !== null) return;
    const run = () => {
      session_.frame = null;
      evaluateAll();
    };
    session_.frame =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(run)
        : (window.setTimeout(run, 16) as unknown as number);
  };

  /** 预览节点接了就显示预览，没接就退回输出 —— Blender 的 Image Editor 也是这个优先级。 */
  const previewTarget = (): 'viewer' | 'output' =>
    session_.graph.edges.some((edge) => edge.toNode === 'viewer') ? 'viewer' : 'output';

  const evaluateAll = (): void => {
    const engine = session_.engine;
    if (!engine) return;
    try {
      engine.setGraph(session_.graph);
      engine.setSize(session_.size.width, session_.size.height);
      previewCanvas.width = session_.size.width;
      previewCanvas.height = session_.size.height;
      const target = previewTarget();
      const connected = session_.graph.edges.some((edge) => edge.toNode === target);
      engine.evaluate(target);
      const presented = connected && engine.present(target);
      session_.previewTag.textContent = target === 'viewer' ? '预览 VIEWER' : '输出 OUTPUT';
      session_.previewTag.classList.toggle('cg-live', presented);
      session_.previewEmpty.textContent = presented
        ? ''
        : '预览与输出都还没接线 — 从「输入图像」右侧的端口拖一条线过来';
      session_.previewEmpty.classList.toggle('cg-show', !presented);
      if (engine.lastError) session_.toast(engine.lastError, true);
      refreshScopes(target, presented);
      session_.dirty = false;
    } catch (error) {
      session_.toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  // ---- 示波器 ----------------------------------------------------------
  /**
   * 画布的属性尺寸 = CSS 尺寸 × 设备像素比。
   * 面板能拉大之后尺寸不再是常量，写死 264×150 会被拉伸糊掉；绘制仍按 CSS px 记账，
   * 靠 setTransform 把 dpr 吃掉，所以 drawScope 里量到的字号/线宽都是「看得见的像素」。
   */
  let scopeCss = { width: 264, height: 150 };
  const syncScopeCanvas = (): number => {
    const rect = scopeCanvas.getBoundingClientRect();
    const width = Math.max(96, Math.round(rect.width || scopeCss.width));
    const height = Math.max(72, Math.round(rect.height || scopeCss.height));
    scopeCss = { width, height };
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (scopeCanvas.width !== pixelWidth) scopeCanvas.width = pixelWidth;
    if (scopeCanvas.height !== pixelHeight) scopeCanvas.height = pixelHeight;
    return dpr;
  };

  /** 把当前 target 的降采样结果交给 scopes.ts 统计并画出来；切 tab 时复用缓存。 */
  const paintScope = (): void => {
    const state = session_.scope;
    for (const tab of scopeButtons) {
      tab.classList.toggle('cg-scope-active', tab.dataset.scope === state.kind);
    }
    const context = scopeCanvas.getContext('2d');
    if (!context) return;
    if (!state.visible) return;
    if (!state.image) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, scopeCanvas.width, scopeCanvas.height);
      scopeClip.textContent = '还没接到图像';
      return;
    }
    const dpr = syncScopeCanvas();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const readout = drawScope(context, state.kind, state.image, scopeCss.width, scopeCss.height);
    state.clipShadow = readout.clipShadow;
    state.clipHighlight = readout.clipHighlight;
    const format = (value: number): string => `${(value * 100).toFixed(value > 0.1 ? 0 : 1)}%`;
    scopeClip.textContent = `暗部裁切 ${format(readout.clipShadow)} · 高光裁切 ${format(readout.clipHighlight)}`;
  };

  /**
   * 面板尺寸：宽走 style.flex/width（面板是 flex 项），高为 0 时交给 align-items: stretch
   * 跟预览那一行等高 —— 用户拖了下边缘才有自己的高度。
   */
  const applyScopeSize = (): void => {
    const state = session_.scope;
    scopePanel.style.flex = `0 0 ${Math.round(state.width)}px`;
    scopePanel.style.width = `${Math.round(state.width)}px`;
    if (state.height > 0) {
      scopePanel.style.height = `${Math.round(state.height)}px`;
      scopePanel.style.alignSelf = 'flex-start';
    } else {
      scopePanel.style.height = '';
      scopePanel.style.alignSelf = '';
    }
    if (state.visible && state.image) paintScope();
  };

  const refreshScopes = (target: string, presented: boolean): void => {
    if (!session_.scope.visible) return;
    pendingScope = { target, presented };
    // readPixels 是同步的：4K 拖滑块时每帧都读会拖慢预览，这里压到约 12fps，
    // 末帧用定时器补一次（否则松手后波形停在中途那一帧）。
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const wait = SCOPE_INTERVAL_MS - (now - scopePaintedAt);
    if (wait > 0) {
      if (!scopeTimer) {
        scopeTimer = window.setTimeout(() => {
          scopeTimer = 0;
          runScope();
        }, wait);
      }
      return;
    }
    runScope();
  };

  const runScope = (): void => {
    if (session_ !== session || session_.destroyed) return;
    const pending = pendingScope;
    if (!pending) return;
    const engine = session_.engine;
    scopePaintedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    session_.scope.image = engine && pending.presented ? engine.readScope(pending.target, 256, 160) : null;
    paintScope();
  };

  const applyScopeVisibility = (): void => {
    scopePanel.classList.toggle('cg-scopes-hidden', !session_.scope.visible);
    scopeButton.classList.toggle('cg-active', session_.scope.visible);
    previewRow.classList.toggle('cg-preview-row-wide', !session_.scope.visible);
    // 宽度/高度是行内样式，隐藏时留着不影响布局；重新展开要重新量一次画布
    if (session_.scope.visible) applyScopeSize();
  };

  // ---- 示波器面板改大小（用户 2026-10-29：「并且可以调整页面大小」）--------
  // 左边缘拖动 = 宽度，下边缘拖动 = 高度，双击任一 = 复位成默认（268px、跟预览等高）。
  // 与画布手势一样按「位移 ÷ 缩放」不适用（面板不在 stage 坐标系里，是纯 CSS 像素）。
  let scopeResize: {
    axis: 'x' | 'y';
    startX: number;
    startY: number;
    width: number;
    height: number;
  } | null = null;

  const beginScopeResize = (axis: 'x' | 'y', event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = scopePanel.getBoundingClientRect();
    scopeResize = {
      axis,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width || session_.scope.width,
      height: rect.height || session_.scope.height || 320,
    };
    scopePanel.classList.add('cg-scopes-resizing');
  };

  const updateScopeResize = (event: PointerEvent): void => {
    const drag = scopeResize;
    if (!drag) return;
    const state = session_.scope;
    if (drag.axis === 'x') {
      // 往左拖 = 更宽；上限留给预览一块够看的宽度
      const row = previewRow.getBoundingClientRect().width || 1200;
      const maxWidth = Math.max(SCOPE_MIN_WIDTH + 60, row - PREVIEW_MIN_WIDTH);
      state.width = clamp(drag.width - (event.clientX - drag.startX), SCOPE_MIN_WIDTH, maxWidth);
    } else {
      state.height = clamp(drag.height + (event.clientY - drag.startY), SCOPE_MIN_HEIGHT, SCOPE_MAX_HEIGHT);
    }
    applyScopeSize();
  };

  const endScopeResize = (): void => {
    if (!scopeResize) return;
    scopeResize = null;
    scopePanel.classList.remove('cg-scopes-resizing');
  };

  const resetScopeSize = (): void => {
    session_.scope.width = 268;
    session_.scope.height = 0;
    applyScopeSize();
    session_.toast('示波器面板已复位');
  };

  scopeGripX.addEventListener('pointerdown', (event) => beginScopeResize('x', event));
  scopeGripY.addEventListener('pointerdown', (event) => beginScopeResize('y', event));
  scopeGripX.addEventListener('dblclick', resetScopeSize);
  scopeGripY.addEventListener('dblclick', resetScopeSize);

  // ---- 预览的缩放 / 平移 ------------------------------------------------
  /**
   * canvas 是 `width:100%; height:100%` + `object-fit: contain`，所以 zoom=1 就是
   * 「整幅图适应窗口」。放大缩小与平移都只改 transform，不动绘制缓冲（求值结果不重算）。
   */
  const applyPreviewView = (): void => {
    const { zoom, x, y } = session_.preview;
    previewCanvas.style.transformOrigin = '0 0';
    previewCanvas.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    previewZoom.textContent = `${Math.round(zoom * 100)}%`;
  };

  const resetPreviewView = (): void => {
    session_.preview = { zoom: 1, x: 0, y: 0 };
    applyPreviewView();
  };

  const onPreviewWheel = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const previous = session_.preview.zoom;
    const next = clamp(previous * Math.exp(-event.deltaY * 0.0015), 0.2, 8);
    if (next === previous) return;
    const rect = previewBox.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const worldX = (cursorX - session_.preview.x) / previous;
    const worldY = (cursorY - session_.preview.y) / previous;
    session_.preview = {
      zoom: next,
      x: cursorX - worldX * next,
      y: cursorY - worldY * next,
    };
    applyPreviewView();
  };

  const onPreviewPointerDown = (event: PointerEvent): void => {
    // 左键/中键都能拖：预览里没有别的左键语义，不需要像主画布那样区分框选
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    session_.previewPan = {
      x: session_.preview.x,
      y: session_.preview.y,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    previewBox.classList.add('cg-preview-panning');
    previewBox.setPointerCapture?.(event.pointerId);
  };

  // ---- 节点渲染 --------------------------------------------------------
  const portTopFallback = (kind: CompositorKind, side: 'in' | 'out', index: number): number => {
    // 转接点只有一个小圆点，端口摆在竖直正中
    if (kind === 'reroute') return REROUTE_HEIGHT / 2 - PORT_HALF;
    // 输入节点：每张缩略图一个输出口（真位置由 layoutPorts 实测覆盖，这里只兜底）
    if (kind === 'input') return HEADER_HEIGHT + 9 + 48 - PORT_HALF + index * 102;
    const spec = specOf(kind);
    const count = side === 'in' ? spec.inputs : spec.outputs;
    // 单口：落在标题栏竖直正中（方案 C 的端口就长在标题栏上）
    if (count <= 1) return HEADER_HEIGHT / 2 - PORT_HALF;
    // 多口（mix / alphaOver）：从身体第一行往下排
    return HEADER_HEIGHT + 12 + index * 22;
  };

  const portKey = (nodeId: string, side: 'in' | 'out', index: number): string =>
    `${nodeId}:${side}:${index}`;
  /** 端口在节点内的 top。输入节点的输出口按缩略图实测位置对齐。 */
  const portTops = new Map<string, number>();

  const createNodeElement = (node: CompositorNode): HTMLElement => {
    const spec = specOf(node.kind);
    const element = document.createElement('div');
    element.className = 'cg-node';
    element.dataset.nodeId = node.id;
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    if (node.kind === 'output') element.classList.add('cg-node-output');
    if (node.kind === 'viewer') element.classList.add('cg-node-viewer');
    if (node.kind === 'colorBalance') element.classList.add('cg-node-wheels');
    if (node.kind === 'reroute') {
      element.classList.add('cg-node-compact');
      element.title = '转接点：一路进、多路出，只整理走向';
    }

    const head = document.createElement('div');
    head.className = 'cg-node-head';
    // 分类色只喂给标题栏那颗小圆点（styles.ts 里的 --cg-cat），不再铺满整条标题栏
    head.style.setProperty('--cg-cat', headColor(node));
    const dot = document.createElement('span');
    dot.className = 'cg-dot';
    const headTitle = document.createElement('span');
    headTitle.className = 'cg-node-title';
    headTitle.textContent = node.title || spec.label;
    const kindLabel = document.createElement('span');
    kindLabel.className = 'cg-node-kind';
    kindLabel.textContent =
      node.kind === 'input'
        ? `${options.images.length}`
        : node.kind === 'output' || node.kind === 'viewer' || node.kind === 'reroute'
          ? ''
          : spec.category;
    head.append(dot, headTitle, kindLabel);

    element.append(head);

    // 转接点只有标题栏（Blender 的 Reroute 就是个小圆点），不占卡片高度
    if (node.kind === 'reroute') {
      // ports 在下面统一补
    } else {
      const body = document.createElement('div');
      body.className = 'cg-node-body';
      if (node.kind === 'input') {
        if (!options.images.length) {
          const empty = document.createElement('div');
          empty.className = 'cg-empty';
          empty.textContent = '主画布上没有接图像';
          body.append(empty);
        } else {
          for (const image of options.images) {
            const thumb = document.createElement('img');
            thumb.className = 'cg-thumb';
            thumb.src = image.url;
            thumb.alt = image.title || '输入图像';
            thumb.draggable = false;
            body.append(thumb);
          }
        }
      } else if (node.kind === 'output') {
        body.textContent = '合成结果写回调色节点';
      } else if (node.kind === 'viewer') {
        body.textContent = 'Shift+点击节点可接到这里';
      } else if (!renderNodeParams(node, body)) {
        body.textContent = '暂无参数';
      }
      element.append(body);
    }

    for (let index = 0; index < spec.inputs; index += 1) {
      const port = document.createElement('div');
      port.className = 'cg-port cg-in';
      port.dataset.port = String(index);
      port.dataset.side = 'in';
      port.style.top = `${portTopFallback(node.kind, 'in', index)}px`;
      port.title = inputPortLabel(node.kind, index);
      element.append(port);
    }
    const outputs = outputPortCount(node.kind, options.images.length);
    for (let index = 0; index < outputs; index += 1) {
      const port = document.createElement('div');
      port.className = 'cg-port cg-out';
      port.dataset.port = String(index);
      port.dataset.side = 'out';
      port.style.top = `${portTopFallback(node.kind, 'out', index)}px`;
      port.title = node.kind === 'input' ? `图像 ${index + 1}` : '输出';
      element.append(port);
    }
    return element;
  };

  /**
   * 自绘下拉（用户 2026-10-30：「下拉选项的ui还没有做好，现在是纯白的，比如混合节点」）。
   *
   * 原生 `<select>` 的**弹层**是系统画的，CSS 完全够不着 —— Windows 上就是一块白板。
   * 所以改成「按钮 + 挂在 body 上的深色列表」：
   *   · 按钮沿用节点内控件的小尺寸，列表 fixed 定位在按钮下方（放不下就翻到上方）；
   *   · 点选项即生效，Esc / 点外面收起，上下键 + Enter 也能选；
   *   · 同一时刻只允许开一个（模块级 openSelectPopup）。
   */
  interface DropdownOption {
    value: string;
    label: string;
  }
  const createDropdown = (
    options: readonly DropdownOption[],
    current: string,
    onChange: (value: string) => void,
  ): HTMLElement => {
    const wrapper = document.createElement('div');
    wrapper.className = 'cg-select';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cg-select-button';
    const label = document.createElement('span');
    label.className = 'cg-select-label';
    const caret = document.createElement('span');
    caret.className = 'cg-select-caret';
    button.append(label, caret);
    wrapper.append(button);

    let value = current;
    const paint = (): void => {
      const option = options.find((entry) => entry.value === value);
      label.textContent = option?.label ?? value;
      button.title = option?.label ?? value;
    };
    paint();

    let close: (() => void) | null = null;
    const openList = (): void => {
      closePopup();
      const list = document.createElement('div');
      list.className = 'cg-select-list';
      const rows: HTMLElement[] = [];
      let active = Math.max(0, options.findIndex((entry) => entry.value === value));
      const paintActive = (): void => {
        rows.forEach((row, index) => row.classList.toggle('cg-active', index === active));
      };
      options.forEach((option, index) => {
        const row = document.createElement('div');
        row.className = 'cg-select-option';
        if (option.value === value) row.classList.add('cg-selected');
        const check = document.createElement('span');
        check.className = 'cg-select-check';
        check.textContent = option.value === value ? '✓' : '';
        const text = document.createElement('span');
        text.textContent = option.label;
        row.append(check, text);
        row.addEventListener('pointerdown', (event) => event.stopPropagation());
        row.addEventListener('click', (event) => {
          event.stopPropagation();
          choose(option.value);
        });
        row.addEventListener('pointerenter', () => {
          active = index;
          paintActive();
        });
        rows.push(row);
        list.append(row);
      });
      const rect = button.getBoundingClientRect();
      const width = Math.max(132, Math.round(rect.width));
      list.style.width = `${width}px`;
      document.body.append(list);
      // 位置：优先挂在按钮下方；放不下就翻到上方；上下都放不下就贴着视口底边（节点可能
      // 已经被拖到画布下沿，列表不该跟着跑出屏幕）。左右同理，永远留 8px 边距。
      const margin = 8;
      const listHeight = Math.max(
        list.getBoundingClientRect().height,
        list.scrollHeight,
        120,
      );
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
      let top = rect.bottom + 4;
      if (top + listHeight > window.innerHeight - margin) {
        const above = rect.top - listHeight - 4;
        top =
          above >= margin
            ? above
            : Math.max(margin, window.innerHeight - listHeight - margin);
      }
      list.style.left = `${Math.round(left)}px`;
      list.style.top = `${Math.round(top)}px`;
      paintActive();

      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          active = (active + step + options.length) % options.length;
          paintActive();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          const option = options[active];
          if (option) choose(option.value);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closePopup();
        }
      };
      const onOutside = (event: PointerEvent): void => {
        const target = event.target as Node | null;
        if (!target) return;
        if (list.contains(target) || wrapper.contains(target)) return;
        closePopup();
      };
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('pointerdown', onOutside, true);

      close = () => {
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('pointerdown', onOutside, true);
        list.remove();
        wrapper.classList.remove('cg-open');
        openSelectPopup = null;
        close = null;
      };
      openSelectPopup = close;
      wrapper.classList.add('cg-open');
    };
    const choose = (next: string): void => {
      const changed = next !== value;
      value = next;
      paint();
      closePopup();
      if (changed) onChange(next);
    };
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (close) {
        closePopup();
        return;
      }
      openList();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        if (!close) openList();
      }
    });
    return wrapper;
  };

  /**
   * 参数控件直接长在节点身体里（Blender 的节点内控件），不再有右侧属性面板。
   *
   * 用户 2026-10-29：「色相饱节点稍微移动一点点就超过预期了，0 到 1 这个取值不是很合理」。
   * 所以数字参数不再用原生 range（它只能把整条范围铺满一段很窄的轨道），改成自己画的
   * 全宽滑块：标签与数值直接印在轨道上（专业调色软件的做法），左键拖动改值、
   * Shift/Alt 拖动是 0.12× 微调、滚轮一格、方向键一步、双击恢复默认；
   * 右边数字框按专业单位显示（° / % / K / EV），输入的是同一个单位。
   */
  const renderNodeParams = (node: CompositorNode, body: HTMLElement): boolean => {
    if (node.kind === 'curves') return renderCurvesEditor(node, body);
    // 四轮调色：色轮 / 数字 / 细滑轨 / 亮度长条（参照图那套），不用通用滑块行
    if (node.kind === 'colorBalance') {
      body.append(renderColorWheels(node, (key, value) => setParam(node.id, key, value)));
      return true;
    }
    const params = paramsOf(node);
    const spec = specOf(node.kind);
    let count = 0;
    for (const [key, defaultValue] of Object.entries(spec.defaults || {})) {
      if (key === 'mode') {
        const row = paramRow('模式');
        // 自绘下拉：原生 select 的弹层是系统白板（用户 2026-10-30 报「下拉选项是纯白的」）
        row.control.append(
          createDropdown(
            MIX_MODES.map((mode) => ({ value: mode, label: MIX_MODE_LABELS[mode] })),
            String(params.mode || MIX_MODES[0]),
            (next) => setParam(node.id, key, next),
          ),
        );
        body.append(row.element);
        count += 1;
        continue;
      }
      if (typeof defaultValue === 'boolean') {
        const row = paramRow(paramMeta(key).label || key);
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = params[key] === true;
        input.addEventListener('change', () => setParam(node.id, key, input.checked));
        row.control.append(input);
        body.append(row.element);
        count += 1;
        continue;
      }
      if (typeof defaultValue !== 'number') continue;
      body.append(renderNumericParam(node, key, Number(defaultValue) || 0));
      count += 1;
    }
    return count > 0;
  };

  /** 数字参数：全宽滑块（标签/数值内嵌）+ 数字框。 */
  const renderNumericParam = (
    node: CompositorNode,
    key: string,
    defaultValue: number,
  ): HTMLElement => {
    const params = paramsOf(node);
    const rawStart = typeof params[key] === 'number' ? (params[key] as number) : defaultValue;
    const meta = paramMeta(key);
    const bounds = displayBounds(key);
    const digits = typeof meta.digits === 'number' ? meta.digits : bounds.step >= 1 ? 0 : 2;
    const span = bounds.max - bounds.min || 1;
    let current = clampRaw(key, rawStart);

    const row = document.createElement('div');
    row.className = 'cg-param cg-param-slider';
    const slider = document.createElement('div');
    slider.className = 'cg-slider';
    slider.tabIndex = 0;
    slider.setAttribute('role', 'slider');
    slider.setAttribute('aria-label', meta.label);
    slider.dataset.param = key;
    const fill = document.createElement('span');
    fill.className = 'cg-slider-fill';
    const label = document.createElement('span');
    label.className = 'cg-slider-label';
    label.textContent = meta.label;
    const valueText = document.createElement('span');
    valueText.className = 'cg-slider-value';
    slider.append(fill, label, valueText);

    const number = document.createElement('input');
    number.type = 'number';
    number.className = 'cg-param-number';
    number.min = String(bounds.min);
    number.max = String(bounds.max);
    number.step = String(bounds.step);
    number.title = '可直接输入（单位：' + (meta.unit || '数值') + '）';

    const paint = (): void => {
      const display = toDisplay(key, current);
      const percent = ((display - bounds.min) / span) * 100;
      if (isBipolar(key)) {
        const center = ((0 - bounds.min) / span) * 100;
        fill.style.left = `${Math.min(percent, center)}%`;
        fill.style.width = `${Math.abs(percent - center)}%`;
      } else {
        fill.style.left = '0%';
        fill.style.width = `${Math.max(0, percent)}%`;
      }
      valueText.textContent = formatParam(key, current);
      number.value = display.toFixed(digits);
      slider.setAttribute('aria-valuemin', String(bounds.min));
      slider.setAttribute('aria-valuemax', String(bounds.max));
      slider.setAttribute('aria-valuenow', display.toFixed(digits));
    };

    const commitDisplay = (displayValue: number): void => {
      current = clampRaw(key, toRaw(key, displayValue));
      setParam(node.id, key, current);
      paint();
    };
    const commitRaw = (raw: number): void => {
      current = clampRaw(key, raw);
      setParam(node.id, key, current);
      paint();
    };

    let drag: { startX: number; startDisplay: number; fine: boolean; rect: DOMRect } | null = null;
    slider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = slider.getBoundingClientRect();
      const fine = event.shiftKey || event.altKey;
      drag = { startX: event.clientX, startDisplay: toDisplay(key, current), fine, rect };
      slider.classList.add('cg-slider-active');
      // 微调模式下不跳值：从当前值开始按位移走
      if (!fine) commitDisplay(bounds.min + ((event.clientX - rect.left) / Math.max(1, rect.width)) * span);
      slider.setPointerCapture?.(event.pointerId);
    });
    slider.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const rect = drag.rect;
      if (drag.fine) {
        // 0.12× 灵敏度：整条轨道走完仍是全量程，但同样的手抖只动 12%
        const delta = ((event.clientX - drag.startX) / Math.max(1, rect.width)) * span * 0.12;
        commitDisplay(drag.startDisplay + delta);
      } else {
        commitDisplay(bounds.min + ((event.clientX - rect.left) / Math.max(1, rect.width)) * span);
      }
    });
    const endDrag = (): void => {
      drag = null;
      slider.classList.remove('cg-slider-active');
    };
    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);
    slider.addEventListener('lostpointercapture', endDrag);
    slider.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      commitRaw(defaultValue);
    });
    slider.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        const step = bounds.step * (event.shiftKey ? 0.2 : 1);
        commitDisplay(toDisplay(key, current) + (event.deltaY < 0 ? step : -step));
      },
      { passive: false },
    );
    slider.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Home') return commitDisplay(bounds.min);
      if (event.key === 'End') return commitDisplay(bounds.max);
      const step = bounds.step * (event.shiftKey ? 10 : 1);
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1;
      commitDisplay(toDisplay(key, current) + direction * step);
    });
    number.addEventListener('pointerdown', (event) => event.stopPropagation());
    number.addEventListener('change', () => {
      const parsed = parseDisplay(key, number.value);
      if (parsed === null) paint();
      else {
        current = parsed;
        setParam(node.id, key, current);
        paint();
      }
    });

    paint();
    row.append(slider, number);
    return row;
  };

  /**
   * 曲线节点：通道下拉 + 可拖点曲线（点击加点、拖动、双击删点、重置）。
   * 主曲线（RGB）与 R/G/B 单通道各存一组控制点（points / pointsR / pointsG / pointsB）；
   * 单通道没动过就是恒等直线，引擎那边按「主曲线 → 通道曲线」合成 LUT。
   */
  const renderCurvesEditor = (node: CompositorNode, body: HTMLElement): boolean => {
    const channelKeys: Record<string, { key: string; label: string }> = {
      rgb: { key: 'points', label: 'RGB 主曲线' },
      r: { key: 'pointsR', label: 'R 红通道' },
      g: { key: 'pointsG', label: 'G 绿通道' },
      b: { key: 'pointsB', label: 'B 蓝通道' },
    };
    let channelKey = 'points';
    const row = paramRow('通道');
    const stored = paramsOf(node).channel;
    let initialChannel = 'rgb';
    if (typeof stored === 'string' && stored in channelKeys) initialChannel = stored;
    channelKey = channelKeys[initialChannel].key;
    row.control.append(
      createDropdown(
        Object.entries(channelKeys).map(([value, entry]) => ({ value, label: entry.label })),
        initialChannel,
        (next) => {
          channelKey = channelKeys[next].key;
          setParam(node.id, 'channel', next);
          paint();
        },
      ),
    );
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'cg-mini-btn';
    reset.textContent = '重置';
    reset.title = '把当前通道的曲线恢复成对角直线';
    row.control.append(reset);
    body.append(row.element);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'cg-curve');
    svg.setAttribute('viewBox', `0 0 ${CURVE_W} ${CURVE_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const grid = document.createElementNS(SVG_NS, 'path');
    grid.setAttribute('class', 'cg-curve-grid');
    const diagonal = document.createElementNS(SVG_NS, 'path');
    diagonal.setAttribute('class', 'cg-curve-diagonal');
    diagonal.setAttribute('d', `M ${CURVE_PAD} ${CURVE_H - CURVE_PAD} L ${CURVE_W - CURVE_PAD} ${CURVE_PAD}`);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'cg-curve-line');
    const pointsGroup = document.createElementNS(SVG_NS, 'g');
    pointsGroup.setAttribute('class', 'cg-curve-points');
    const gridLines: string[] = [];
    for (let step = 1; step < 4; step += 1) {
      const gy = CURVE_PAD + ((CURVE_H - CURVE_PAD * 2) * step) / 4;
      const gx = CURVE_PAD + ((CURVE_W - CURVE_PAD * 2) * step) / 4;
      gridLines.push(`M ${CURVE_PAD} ${gy} L ${CURVE_W - CURVE_PAD} ${gy}`);
      gridLines.push(`M ${gx} ${CURVE_PAD} L ${gx} ${CURVE_H - CURVE_PAD}`);
    }
    grid.setAttribute('d', gridLines.join(' '));
    svg.append(grid, diagonal, path, pointsGroup);
    body.append(svg);

    const toView = (point: CurvePoint): { x: number; y: number } => ({
      x: CURVE_PAD + point.x * (CURVE_W - CURVE_PAD * 2),
      y: CURVE_H - CURVE_PAD - point.y * (CURVE_H - CURVE_PAD * 2),
    });
    const pointsOfChannel = (): CurvePoint[] => {
      const value = paramsOf(node)[channelKey];
      return normalizeCurvePoints(Array.isArray(value) ? (value as number[]) : undefined);
    };
    const writePoints = (points: CurvePoint[]): void => setParam(node.id, channelKey, flattenCurve(points));

    const paint = (): void => {
      const points = pointsOfChannel();
      const samples: string[] = [];
      for (let index = 0; index <= 48; index += 1) {
        const t = index / 48;
        const view = toView({ x: t, y: curveAt(points, t) });
        samples.push(`${index ? 'L' : 'M'} ${view.x.toFixed(2)} ${view.y.toFixed(2)}`);
      }
      path.setAttribute('d', samples.join(' '));
      pointsGroup.textContent = '';
      points.forEach((point, index) => {
        const view = toView(point);
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('class', 'cg-curve-point');
        circle.setAttribute('cx', String(view.x));
        circle.setAttribute('cy', String(view.y));
        circle.setAttribute('r', index === 0 || index === points.length - 1 ? '3.6' : '3');
        circle.dataset.index = String(index);
        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent = `${Math.round(point.x * 255)} → ${Math.round(point.y * 255)}（双击删点）`;
        circle.append(title);
        pointsGroup.append(circle);
      });
    };

    let dragIndex = -1;
    const pointerPoint = (event: PointerEvent): CurvePoint | null => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const x = (event.clientX - rect.left) / rect.width;
      const y = 1 - (event.clientY - rect.top) / rect.height;
      return {
        x: Math.max(0, Math.min(1, (x * CURVE_W - CURVE_PAD) / (CURVE_W - CURVE_PAD * 2))),
        y: Math.max(0, Math.min(1, (y * CURVE_H - CURVE_PAD) / (CURVE_H - CURVE_PAD * 2))),
      };
    };
    svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.target as SVGElement;
      const circle = target.closest?.('.cg-curve-point') as SVGCircleElement | null;
      const points = pointsOfChannel();
      if (circle) {
        dragIndex = Number(circle.dataset.index ?? -1);
      } else {
        // 双击的第二下不再加点（第一下已经加过了，否则双击空白会一次冒出两个点）
        if (event.detail > 1) return;
        const point = pointerPoint(event);
        if (!point || points.length >= MAX_CURVE_POINTS) return;
        const next = addCurvePoint(flattenCurve(points), point.x, point.y);
        writePoints(normalizeCurvePoints(next));
        const merged = normalizeCurvePoints(next);
        dragIndex = merged.findIndex((item) => Math.abs(item.x - point.x) < 0.02);
        paint();
      }
      svg.setPointerCapture?.(event.pointerId);
    });
    svg.addEventListener('pointermove', (event) => {
      if (dragIndex < 0) return;
      const point = pointerPoint(event);
      if (!point) return;
      const points = pointsOfChannel();
      if (!points[dragIndex]) return;
      const previous = points[dragIndex - 1];
      const next = points[dragIndex + 1];
      const minX = dragIndex === 0 ? 0 : previous ? previous.x + 0.004 : 0;
      const maxX = dragIndex === points.length - 1 ? 1 : next ? next.x - 0.004 : 1;
      points[dragIndex] = {
        x: dragIndex === 0 ? 0 : dragIndex === points.length - 1 ? 1 : clamp(point.x, minX, maxX),
        y: point.y,
      };
      writePoints(points);
      paint();
    });
    const endDrag = (): void => {
      dragIndex = -1;
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('lostpointercapture', endDrag);
    svg.addEventListener('dblclick', (event) => {
      const target = event.target as SVGElement;
      const circle = target.closest?.('.cg-curve-point') as SVGCircleElement | null;
      if (!circle) return;
      event.preventDefault();
      event.stopPropagation();
      const points = pointsOfChannel();
      const index = Number(circle.dataset.index ?? -1);
      if (index <= 0 || index >= points.length - 1) return;
      writePoints(normalizeCurvePoints(removeCurvePoint(flattenCurve(points), index)));
      paint();
    });
    reset.addEventListener('click', (event) => {
      event.stopPropagation();
      const value = JSON.parse(JSON.stringify([0, 0, 1, 1]));
      setParam(node.id, channelKey, value);
      paint();
    });
    paint();
    return true;
  };

  const paramRow = (labelText: string): { element: HTMLElement; control: HTMLElement } => {
    const element = document.createElement('div');
    element.className = 'cg-param cg-param-plain';
    const label = document.createElement('label');
    label.textContent = labelText;
    const control = document.createElement('div');
    control.className = 'cg-param-control';
    element.append(label, control);
    return { element, control };
  };

  const nodeElement = (nodeId: string): HTMLElement | null =>
    world.querySelector<HTMLElement>(`.cg-node[data-node-id="${cssEscape(nodeId)}"]`);

  /** 把端口摆到缩略图中心（输入节点多图时每张图一个口）。 */
  const layoutPorts = (): void => {
    portTops.clear();
    for (const node of session_.graph.nodes) {
      const element = nodeElement(node.id);
      if (!element) continue;
      const thumbs = Array.from(element.querySelectorAll<HTMLElement>('.cg-thumb'));
      const ports = Array.from(element.querySelectorAll<HTMLElement>('.cg-port'));
      for (const port of ports) {
        const side = port.dataset.side === 'in' ? 'in' : 'out';
        const index = Number(port.dataset.port || 0);
        const thumb = node.kind === 'input' && side === 'out' ? thumbs[index] : null;
        const top =
          thumb && thumb.offsetHeight > 0
            ? thumb.offsetTop + thumb.offsetHeight / 2 - PORT_HALF
            : portTopFallback(node.kind, side, index);
        port.style.top = `${top}px`;
        portTops.set(portKey(node.id, side, index), top);
      }
    }
  };

  const renderNodes = (): void => {
    // 卡片重建后，原先挂在这些控件上的下拉列表就悬空了
    closePopup();
    world.querySelectorAll('.cg-node').forEach((element) => element.remove());
    for (const node of session_.graph.nodes) world.append(createNodeElement(node));
    layoutPorts();
    paintSelection(session_.selection);
  };

  const renderEdges = (): void => {
    layoutPorts();
    edgeLayer.innerHTML = '';
    const selected = new Set(session_.selection);
    for (const edge of session_.graph.edges) {
      const fromNode = session_.graph.nodes.find((node) => node.id === edge.fromNode);
      const toNode = session_.graph.nodes.find((node) => node.id === edge.toNode);
      if (!fromNode || !toNode) continue;
      const start = portWorld(edge.fromNode, 'out', edge.fromPort);
      const end = portWorld(edge.toNode, 'in', edge.toPort);
      if (!start || !end) continue;
      const d = curve(toScreen(start), toScreen(end));
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'cg-edge');
      if (selected.has(edge.fromNode) || selected.has(edge.toNode)) path.classList.add('cg-edge-sel');
      path.setAttribute('d', d);
      path.dataset.edgeId = edge.id;
      edgeLayer.append(path);
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('class', 'cg-edge-hit');
      hit.setAttribute('d', d);
      hit.dataset.edgeId = edge.id;
      edgeLayer.append(hit);
    }
    syncPorts();
  };

  const syncPorts = (): void => {
    world.querySelectorAll<HTMLElement>('.cg-port').forEach((port) => port.classList.remove('cg-linked'));
    const mark = (nodeId: string, side: 'in' | 'out', index: number): void => {
      const element = nodeElement(nodeId);
      const port = element?.querySelector<HTMLElement>(
        `.cg-port[data-side="${side}"][data-port="${index}"]`,
      );
      port?.classList.add('cg-linked');
    };
    for (const edge of session_.graph.edges) {
      mark(edge.fromNode, 'out', edge.fromPort);
      mark(edge.toNode, 'in', edge.toPort);
    }
  };

  /** 和 Blender 的 noodle 一样的枢轴曲线：两端各留一段水平切线再弯。 */
  const curve = (start: { x: number; y: number }, end: { x: number; y: number }): string => {
    const distance = Math.abs(end.x - start.x);
    const dx = Math.max(42, distance * 0.5);
    return `M ${start.x} ${start.y} C ${start.x + dx} ${start.y}, ${end.x - dx} ${end.y}, ${end.x} ${end.y}`;
  };

  const toScreen = (point: { x: number; y: number }): { x: number; y: number } => ({
    x: session_.view.x + point.x * session_.view.scale,
    y: session_.view.y + point.y * session_.view.scale,
  });

  const portWorld = (
    nodeId: string,
    side: 'in' | 'out',
    index: number,
  ): { x: number; y: number } | null => {
    const node = session_.graph.nodes.find((item) => item.id === nodeId);
    if (!node) return null;
    const top = portTops.get(portKey(nodeId, side, index)) ?? portTopFallback(node.kind, side, index);
    return {
      x: side === 'out' ? node.x + nodeWidthOf(node.kind) : node.x,
      y: node.y + top + PORT_HALF,
    };
  };

  // ---- 视图与背景 ------------------------------------------------------
  /**
   * 点阵跟随视图：size 按 scale 缩放，position 跟着平移。
   * 缩太小时按 2 的幂合并网格，避免出现摩尔纹（和主画布一样是「无限网格」的观感）。
   */
  const updateGrid = (): void => {
    const { x, y, scale } = session_.view;
    let spacing = GRID_STEP * scale;
    while (spacing < 9) spacing *= 2;
    while (spacing > 72) spacing /= 2;
    const ox = ((x % spacing) + spacing) % spacing;
    const oy = ((y % spacing) + spacing) % spacing;
    stage.style.backgroundSize = `${spacing * 5}px ${spacing * 5}px, ${spacing}px ${spacing}px`;
    stage.style.backgroundPosition = `${ox}px ${oy}px, ${ox}px ${oy}px`;
  };

  /**
   * 视图变了才刷新缩放读数与合成层提示。
   *
   * 「放大就糊」的根因是这一层被当成位图：`.cg-world` 常驻 will-change 时，
   * Chrome 会按旧分辨率把整棵节点树栅格化成一张图，再用 transform 拉伸。
   * 所以 will-change 只在手势进行期间加（.cg-scaling），抬手 140ms 撤掉 ——
   * 撤掉那一下浏览器会按新的缩放重新栅格化，文字就是矢量重排而不是放大位图。
   */
  let scalingIdleTimer: ReturnType<typeof setTimeout> | undefined;
  const applyView = (): void => {
    world.style.transform = `translate(${session_.view.x}px, ${session_.view.y}px) scale(${session_.view.scale})`;
    updateGrid();
    renderEdges();
    zoomValueButton.textContent = `${Math.round(session_.view.scale * 100)}%`;
    world.classList.add('cg-scaling');
    if (scalingIdleTimer) clearTimeout(scalingIdleTimer);
    scalingIdleTimer = setTimeout(() => {
      scalingIdleTimer = undefined;
      world.classList.remove('cg-scaling');
    }, SCALING_IDLE_MS);
  };

  /** 以画布中心为锚点缩放（HUD 的 +/− 与读数点击都走这里）。 */
  const zoomBy = (factor: number): void => {
    const rect = stage.getBoundingClientRect();
    const previous = session_.view.scale;
    const next = clamp(previous * factor, MIN_SCALE, MAX_SCALE);
    if (next === previous) return;
    const anchorX = rect.width / 2;
    const anchorY = rect.height / 2;
    const worldX = (anchorX - session_.view.x) / previous;
    const worldY = (anchorY - session_.view.y) / previous;
    session_.view = {
      scale: next,
      x: anchorX - worldX * next,
      y: anchorY - worldY * next,
    };
    applyView();
  };

  zoomOutButton.addEventListener('click', (event) => {
    event.stopPropagation();
    zoomBy(1 / 1.25);
  });
  zoomInButton.addEventListener('click', (event) => {
    event.stopPropagation();
    zoomBy(1.25);
  });
  zoomValueButton.addEventListener('click', (event) => {
    event.stopPropagation();
    zoomBy(1 / session_.view.scale);
  });
  zoomFitButton.addEventListener('click', (event) => {
    event.stopPropagation();
    fitView();
  });

  const fitView = (): void => {
    const nodes = session_.graph.nodes;
    if (!nodes.length) return;
    // 高度按实测卡片量（参数进了节点体内之后，色轮那类节点会明显变高），量不到再用旧的兜底值
    const heightOf = (node: CompositorNode): number => {
      const element = nodeElement(node.id);
      const measured = element?.offsetHeight || 0;
      return measured > 0 ? measured : node.kind === 'reroute' ? REROUTE_HEIGHT : 220;
    };
    const minX = Math.min(...nodes.map((node) => node.x)) - 60;
    const minY = Math.min(...nodes.map((node) => node.y)) - 60;
    const maxX = Math.max(...nodes.map((node) => node.x + nodeWidthOf(node.kind))) + 60;
    const maxY = Math.max(...nodes.map((node) => node.y + heightOf(node))) + 60;
    const rect = stage.getBoundingClientRect();
    // 还没量到尺寸（jsdom / 刚 append）时不硬算，否则 scale 会被钳到 MIN 把整张图缩成一个点
    if (!rect.width || !rect.height) return;
    const scale = clamp(
      Math.min(rect.width / (maxX - minX), (rect.height - 30) / (maxY - minY), 1.2),
      MIN_SCALE,
      1.2,
    );
    session_.view = {
      scale,
      x: rect.width / 2 - ((minX + maxX) / 2) * scale,
      y: (rect.height - 30) / 2 - ((minY + maxY) / 2) * scale,
    };
    applyView();
  };

  // ---- 选择 ------------------------------------------------------------
  /** 只刷 class，不动 session.selection —— 框选拖动中要能实时预览命中。 */
  const paintSelection = (ids: readonly string[]): void => {
    const set = new Set(ids);
    world.querySelectorAll<HTMLElement>('.cg-node').forEach((element) => {
      element.classList.toggle('cg-selected', set.has(element.dataset.nodeId || ''));
    });
  };

  const setSelection = (ids: readonly string[]): void => {
    const known = new Set(session_.graph.nodes.map((node) => node.id));
    session_.selection = unique(ids).filter((id) => known.has(id));
    paintSelection(session_.selection);
    renderEdges();
  };

  const selectNode = (id: string | null): void => {
    setSelection(id ? [id] : []);
  };

  // ---- 撤销 / 重做 ------------------------------------------------------
  /**
   * 用户 2026-10-29：「添加 ctrl+z 撤销功能」。
   *
   * 按**整张图**快照回退（节点位置 + 连线 + 节点参数），不做命令拆分：调色面板里的改动
   * 大多是连续拖动，命令式的粒度反而难对上用户的手感。连续手势在第一次改动时抓一份
   * 「改动前」快照，停手 420ms 才落成一步；否则拖一次色相会吃掉几十步撤销。
   * 视图平移/缩放与示波器开关不进历史（那是看的方式，不是调色结果）。
   */
  const HISTORY_LIMIT = 80;
  const PARAM_HISTORY_IDLE_MS = 420;
  const cloneHistorySnapshot = (): GraphSnapshot =>
    JSON.parse(JSON.stringify({ nodes: session_.graph.nodes, edges: session_.graph.edges })) as GraphSnapshot;
  const historySignature = (value: { nodes: readonly CompositorNode[]; edges: readonly CompositorEdge[] }): string =>
    JSON.stringify([value.nodes, value.edges]);
  const sameHistory = (a: GraphSnapshot, b: GraphSnapshot): boolean => historySignature(a) === historySignature(b);
  const refreshHistoryButtons = (): void => {
    const history = session_.history;
    undoButton.disabled = !history.past.length && !history.pending;
    redoButton.disabled = !history.future.length;
  };
  const pushHistory = (before: GraphSnapshot): void => {
    const history = session_.history;
    history.past.push(before);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future = [];
    refreshHistoryButtons();
  };
  /** 把「停手够久」的连续手势落成一步；任何离散操作前也要先冲掉它，保证顺序。 */
  const flushPendingHistory = (): void => {
    const history = session_.history;
    if (history.pendingTimer) {
      window.clearTimeout(history.pendingTimer);
      history.pendingTimer = 0;
    }
    const before = history.pending;
    history.pending = null;
    if (!before) return;
    if (sameHistory(before, cloneHistorySnapshot())) {
      refreshHistoryButtons();
      return;
    }
    pushHistory(before);
  };
  /** 参数控件每次改值前调：第一次抓快照，之后只续定时器（一次拖动 = 一步撤销）。 */
  const rememberParamEdit = (): void => {
    const history = session_.history;
    if (!history.pending) history.pending = cloneHistorySnapshot();
    if (history.pendingTimer) window.clearTimeout(history.pendingTimer);
    history.pendingTimer = window.setTimeout(() => {
      history.pendingTimer = 0;
      flushPendingHistory();
    }, PARAM_HISTORY_IDLE_MS);
    refreshHistoryButtons();
  };
  /** 离散操作（接线 / 增删节点 / 合线）改完图后调：和之前的参数手势一起排进历史。 */
  const commitHistory = (before: GraphSnapshot): void => {
    flushPendingHistory();
    if (sameHistory(before, cloneHistorySnapshot())) {
      refreshHistoryButtons();
      return;
    }
    pushHistory(before);
  };
  const restoreHistorySnapshot = (snapshot: GraphSnapshot): void => {
    const copy = JSON.parse(JSON.stringify(snapshot)) as GraphSnapshot;
    session_.graph = { ...session_.graph, nodes: copy.nodes, edges: copy.edges };
    const known = new Set(copy.nodes.map((node) => node.id));
    session_.selection = session_.selection.filter((id) => known.has(id));
    session_.dirty = true;
    // 撤销回到打开时的样子 = 没有改动，Esc 就不该再落一张图
    session_.edited = !sameHistory(session_.history.baseline, cloneHistorySnapshot());
    renderNodes();
    renderEdges();
    schedule();
    refreshHistoryButtons();
  };
  /** 拖框/拖线/框选途中不响应撤销（中途换图会把进行中的手势指向已不存在的节点）。 */
  const historyGestureBusy = (): boolean =>
    !!session_.linkDrag || !!session_.nodeDrag || !!session_.marquee || !!session_.panDrag;
  const undoGraph = (): void => {
    if (historyGestureBusy()) return;
    flushPendingHistory();
    const entry = session_.history.past.pop();
    if (!entry) {
      session_.toast('没有可以撤销的改动了');
      return;
    }
    // 跟随放下的节点也要停：撤销后那个节点已经不存在
    if (session_.placement) {
      session_.placementController?.abort();
      session_.placementController = null;
      session_.placement = null;
    }
    session_.history.future.push(cloneHistorySnapshot());
    restoreHistorySnapshot(entry);
    session_.toast(`已撤销 · 还能撤销 ${session_.history.past.length} 步`);
  };
  const redoGraph = (): void => {
    if (historyGestureBusy()) return;
    flushPendingHistory();
    const entry = session_.history.future.pop();
    if (!entry) {
      session_.toast('没有可以重做的改动了');
      return;
    }
    session_.history.past.push(cloneHistorySnapshot());
    if (session_.history.past.length > HISTORY_LIMIT) session_.history.past.shift();
    restoreHistorySnapshot(entry);
    session_.toast(`已重做 · 还能重做 ${session_.history.future.length} 步`);
  };

  const setParam = (nodeId: string, key: string, value: CompositorParamValue): void => {
    const node = session_.graph.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    rememberParamEdit();
    node.params = { ...node.params, [key]: value };
    session_.dirty = true;
    session_.edited = true;
    // 不重建节点 DOM：滑块的 input 事件在拖动中连续触发，重建会丢焦点/断拖拽
    schedule();
  };

  // ---- 连接 ------------------------------------------------------------
  const connectTo = (fromNodeId: string, toNodeId: string, toPort: number): void => {
    const fromNode = session_.graph.nodes.find((node) => node.id === fromNodeId);
    const toNode = session_.graph.nodes.find((node) => node.id === toNodeId);
    if (!fromNode || !toNode) return;
    // 接第一个输出口（输入节点第 1 张图）；同一输入口后连的会覆盖先连的，语义同 Blender
    const before = cloneHistorySnapshot();
    session_.graph = connect(session_.graph, fromNodeId, 0, toNodeId, toPort);
    session_.edited = true;
    commitHistory(before);
    schedule();
    renderEdges();
    session_.toast(`已接到${toNode.title || specOf(toNode.kind).label}`);
  };

  // ---- 添加节点 --------------------------------------------------------
  type MenuAnchor = { x: number; y: number };
  let menu: HTMLElement | null = null;
  let menuCleanup: (() => void) | null = null;
  const closeMenu = (): void => {
    menuCleanup?.();
    menuCleanup = null;
    menu?.remove();
    menu = null;
  };

  /**
   * Shift+A /「+ 添加节点」菜单：顶部搜索框 + 分组列表。
   *
   * 用户 2026-10-30：「shift+a可以模糊输入查找节点」—— 节点已经三十来个，
   * 只按分类翻列表太慢。搜索支持中文子序列（"平" → 色彩平衡）、拼音首字母
   * （"scph"）、英文 / kind 名（"blur"）；上下键 + Enter 不用鼠标也能建节点。
   */
  const openAddMenu = (anchor: MenuAnchor, worldPoint?: { x: number; y: number }): void => {
    closeMenu();
    const popup = document.createElement('div');
    popup.className = 'cg-menu';
    popup.style.left = `${clamp(anchor.x, 8, window.innerWidth - 220)}px`;
    popup.style.top = `${clamp(anchor.y, 8, window.innerHeight - 40)}px`;
    popup.style.width = '214px';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'cg-menu-search';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = `搜索节点 · ${creatableNodeCount()} 个`;
    input.setAttribute('aria-label', '搜索节点');
    searchWrap.append(input);
    const list = document.createElement('div');
    list.className = 'cg-menu-body';
    popup.append(searchWrap, list);

    let hits: NodeSearchHit[] = [];
    let active = 0;
    const pick = (kind: CompositorKind): void => {
      addNode(kind, worldPoint);
      closeMenu();
    };
    const paintActive = (): void => {
      const items = list.querySelectorAll<HTMLElement>('.cg-menu-item');
      items.forEach((item) => item.classList.remove('cg-active'));
      const current = items[active];
      if (!current) return;
      current.classList.add('cg-active');
      current.scrollIntoView?.({ block: 'nearest' });
    };
    const render = (): void => {
      list.textContent = '';
      hits = searchNodeKinds(input.value);
      if (!hits.length) {
        const empty = document.createElement('div');
        empty.className = 'cg-menu-empty';
        empty.textContent = '没有匹配的节点';
        list.append(empty);
        return;
      }
      active = Math.min(active, hits.length - 1);
      const query = input.value.trim();
      let lastCategory = '';
      hits.forEach((hit, index) => {
        // 没输入时按分类分组；搜索时按分数平铺（最像的排最前）
        if (!query && hit.category !== lastCategory) {
          lastCategory = hit.category;
          const section = document.createElement('div');
          section.className = 'cg-menu-section';
          section.textContent = hit.category;
          list.append(section);
        }
        const item = document.createElement('div');
        item.className = 'cg-menu-item';
        item.dataset.kind = hit.kind;
        const label = document.createElement('span');
        label.textContent = hit.label;
        item.append(label);
        if (query && hit.category) {
          const hint = document.createElement('span');
          hint.className = 'cg-menu-hint';
          hint.textContent = hit.category;
          item.append(hint);
        }
        item.addEventListener('pointerenter', () => {
          active = index;
          paintActive();
        });
        item.addEventListener('click', () => pick(hit.kind));
        list.append(item);
      });
      paintActive();
    };

    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        if (!hits.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + hits.length) % hits.length;
        paintActive();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const hit = hits[active];
        if (hit) pick(hit.kind);
      }
    });
    // 点菜单外面收起（以前只有点画布空白处才收，点顶栏/预览会留着）
    const onOutside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && popup.contains(target)) return;
      closeMenu();
    };
    document.addEventListener('pointerdown', onOutside, true);
    menuCleanup = () => document.removeEventListener('pointerdown', onOutside, true);

    render();
    document.body.append(popup);
    menu = popup;
    input.focus({ preventScroll: true });
    input.select?.();
  };

  /**
   * 菜单与落点跟着指针：Shift+A 和顶栏「+ 添加节点」都走这里。
   *
   * 用户 2026-10-30：「添加节点的时候节点位置不会以鼠标为中心点」。以前这两个入口都把
   * 新节点丢在 stage 正中，跟鼠标在哪无关；现在先取指针在 stage 里的最后位置，
   * 指针不在 stage 上（例如刚点顶栏按钮）才回落到正中。
   */
  const openAddMenuAtPointer = (): void => {
    const rect = stage.getBoundingClientRect();
    // jsdom 里没有布局（rect 全 0），有指针记录就认为它落在 stage 上
    const hasBox = rect.width > 1 && rect.height > 1;
    const pointerInside =
      !!stagePointer &&
      (!hasBox ||
        (stagePointer.x >= rect.left - 1 &&
          stagePointer.x <= rect.right + 1 &&
          stagePointer.y >= rect.top - 1 &&
          stagePointer.y <= rect.bottom + 1));
    if (stagePointer && pointerInside) {
      openAddMenu(
        { x: stagePointer.x + 14, y: stagePointer.y + 14 },
        toWorld(stagePointer.x, stagePointer.y),
      );
      return;
    }
    openAddMenu(
      { x: rect.left + rect.width / 2 - 90, y: rect.top + 80 },
      toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2),
    );
  };

  /**
   * 新建节点的落点：**以指针为中心**（用户 2026-10-30：「添加节点的时候节点位置不会以
   * 鼠标为中心点」）。
   *
   * 宽度有常量表（nodeWidthOf），高度只能等节点渲染出来量 —— 所以先按一个估高落位，
   * renderNodes() 之后再用真实 offsetHeight 对齐一次。jsdom 里量不到高度，就用估算值
   * （回归只断言横向中心；纵向由 browser-check 在真浏览器里验）。
   */
  const DEFAULT_NODE_HEIGHT_GUESS = 180;
  const centerNodeOn = (id: string, center: { x: number; y: number }): void => {
    const node = session_.graph.nodes.find((item) => item.id === id);
    if (!node) return;
    const element = nodeElement(id);
    const height = element?.offsetHeight || DEFAULT_NODE_HEIGHT_GUESS;
    node.x = center.x - nodeWidthOf(node.kind) / 2;
    node.y = center.y - height / 2;
    if (element) {
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
    }
  };

  const addNode = (kind: CompositorKind, point?: { x: number; y: number }): void => {
    const rect = stage.getBoundingClientRect();
    const center =
      point ??
      (stagePointer
        ? toWorld(stagePointer.x, stagePointer.y)
        : toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2));
    const node: CompositorNode = {
      id: newCompositorId(kind),
      kind,
      x: center.x - nodeWidthOf(kind) / 2,
      y: center.y - DEFAULT_NODE_HEIGHT_GUESS / 2,
      // 深拷贝数组参数（曲线控制点），别把 NODE_SPECS 里的默认表改掉
      params: Object.fromEntries(
        Object.entries(NODE_SPECS[kind].defaults || {}).map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value] : value,
        ]),
      ),
    };
    const before = cloneHistorySnapshot();
    session_.graph = { ...session_.graph, nodes: [...session_.graph.nodes, node] };
    session_.edited = true;
    commitHistory(before);
    renderNodes();
    // 量到真实高度后把卡片摆正到指针中心
    centerNodeOn(node.id, center);
    renderEdges();
    selectNode(node.id);
    schedule();
    // 加完就跟在鼠标上，左键放下（用户 2026-10-29：要和主画布「新建并移动」一致）
    beginPlacement(node.id);
  };

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = stage.getBoundingClientRect();
    return {
      x: (clientX - rect.left - session_.view.x) / session_.view.scale,
      y: (clientY - rect.top - session_.view.y) / session_.view.scale,
    };
  };

  /** 指针在 stage 里的最后位置（新节点落点：用户刚看的地方，不是死板的窗口中心）。 */
  let stagePointer: { x: number; y: number } | null = null;

  const stopPlacement = (): void => {
    session_.placement = null;
    session_.placementController?.abort();
    session_.placementController = null;
  };

  /**
   * 「新建并移动」：把刚建出来的节点挂在鼠标上，下一次左键按下＝放下。
   *
   * 和主画布 canvasNodeState.attachPointerPlacement 同一套手感（位移 ÷ 画布缩放，
   * 中途滚轮缩放也不会跳），差别只是这里的坐标空间是合成器自己的 view。
   * 放下那一下要**吞掉** pointerdown：否则同一次按下会立刻开始拖节点或框选。
   */
  const beginPlacement = (id: string): void => {
    stopPlacement();
    const state: PlacementDrag = { id, lastX: null, lastY: null };
    session_.placement = state;
    const controller = new (window.AbortController ?? AbortController)();
    session_.placementController = controller;
    const signal = controller.signal;
    const move = (event: PointerEvent): void => {
      if (session_ !== session || session_.placement !== state) return;
      // 第一次移动只定基线：节点本来就在落点上，不必再挪一下
      if (state.lastX === null || state.lastY === null) {
        state.lastX = event.clientX;
        state.lastY = event.clientY;
        return;
      }
      const node = session_.graph.nodes.find((item) => item.id === id);
      if (!node) return;
      node.x += (event.clientX - state.lastX) / session_.view.scale;
      node.y += (event.clientY - state.lastY) / session_.view.scale;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      const element = nodeElement(id);
      if (element) {
        element.style.left = `${node.x}px`;
        element.style.top = `${node.y}px`;
      }
      renderEdges();
      updateInsertTarget(id);
    };
    const release = (event: PointerEvent): void => {
      if (event.button !== 0) {
        // 右键/中键：结束跟随但不吞事件（右键菜单、中键平移照常）
        stopPlacement();
        clearInsertTarget();
        return;
      }
      const target = event.target as HTMLElement | null;
      const insideStage = !!(target && stage.contains(target));
      stopPlacement();
      if (insideStage) {
        // 落点压住连线就串进去（和「拖动已有节点压线」同一套判定）
        if (!commitInsert(id)) {
          clearInsertTarget();
          // 没串线也要避让：宽节点直接落在别人身上同样会遮住
          if (avoidOverlaps(id)) {
            renderEdges();
            schedule();
          }
        }
        event.preventDefault();
        event.stopPropagation();
      } else {
        clearInsertTarget();
      }
    };
    const abort = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 菜单开着时 Esc 先关菜单（onKeyDown 那条路径），不要顺手把跟随也取消
      if (menu) return;
      // 只取消「放下」这一步，别把整个合成器关掉（主画布同样只是结束跟随）
      event.stopPropagation();
      stopPlacement();
      clearInsertTarget();
    };
    window.addEventListener('pointermove', move, { signal, passive: true });
    window.addEventListener('pointerdown', release, { signal, capture: true });
    window.addEventListener('keydown', abort, { signal, capture: true });
    session_.toast('移动鼠标定位，左键放下');
  };

  // ---- 事件 ------------------------------------------------------------
  const onNodePointerDown = (event: PointerEvent): void => {
    const target = event.target as HTMLElement;
    const element = target.closest<HTMLElement>('.cg-node');
    if (!element) return;
    const nodeId = element.dataset.nodeId || '';
    const node = session_.graph.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    // 右键留给 stage 的划选合并（Shift+右键）与平移，不在节点上起手拖拽
    if (event.button !== 0) return;
    const port = target.closest<HTMLElement>('.cg-port');
    if (port) {
      event.stopPropagation();
      event.preventDefault();
      selectNode(nodeId);
      if (port.dataset.side === 'out') startLink(nodeId, Number(port.dataset.port ?? 0), event);
      return;
    }
    // 参数控件（滑块/数字框/下拉/勾选/色轮）长在节点里：让它自己处理，不要被当成拖动节点
    const control = target.closest('.cg-param, .cg-wheel-control, .cg-select');
    if (control) {
      event.stopPropagation();
      if (!session_.selection.includes(nodeId)) setSelection([nodeId]);
      return;
    }
    event.stopPropagation();
    // Ctrl+Shift 先判：Blender 里 Ctrl+Shift+点击 = 接到 Viewer，我们反过来用
    // （Shift 接预览、Ctrl+Shift 接输出），两者不能互相吞掉。
    if (event.ctrlKey && event.shiftKey && node.kind !== 'output') {
      selectNode(nodeId);
      connectTo(nodeId, 'output', 0);
      return;
    }
    if ((event.shiftKey || session_.tHeld) && node.kind !== 'output' && node.kind !== 'viewer') {
      selectNode(nodeId);
      connectTo(nodeId, 'viewer', 0);
      return;
    }
    if (!session_.selection.includes(nodeId)) setSelection([nodeId]);
    const positions = new Map<string, { x: number; y: number }>();
    for (const id of session_.selection) {
      const item = session_.graph.nodes.find((entry) => entry.id === id);
      if (item) positions.set(id, { x: item.x, y: item.y });
    }
    session_.nodeDrag = {
      id: nodeId,
      clientX: event.clientX,
      clientY: event.clientY,
      positions,
      before: cloneHistorySnapshot(),
    };
    element.setPointerCapture?.(event.pointerId);
  };

  /**
   * 从输出口拖线。松手判定按「从明确到模糊」三级兜底：
   *   ① 线上的输入口（端口本身 10px，但 CSS 给了 26px 的透明命中区）；
   *   ② 松手落在某个节点身上 → 接它的第一个空输入口；
   *   ③ 离最近输入口 34px 以内 → 吸过去。
   * 用户 2026-10-29：「节点与节点之间的连线判定太小了，经常接不上」。
   */
  const startLink = (nodeId: string, port: number, event: PointerEvent): void => {
    const start = portWorld(nodeId, 'out', port);
    if (!start) return;
    const origin = toScreen(start);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'cg-edge cg-edge-active');
    path.setAttribute('d', curve(origin, origin));
    edgeLayer.append(path);
    session_.linkDrag = { fromNode: nodeId, fromPort: port, path };
    stage.classList.add('cg-linking');
    const rect = stage.getBoundingClientRect();

    const elementAt = (x: number, y: number): Element | null =>
      typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    const portScreen = (id: string, inputPort: number): { x: number; y: number } | null => {
      const worldPoint = portWorld(id, 'in', inputPort);
      return worldPoint ? toScreen(worldPoint) : null;
    };
    const firstFreeInputPort = (target: CompositorNode): number => {
      const spec = specOf(target.kind);
      for (let index = 0; index < spec.inputs; index += 1) {
        const occupied = session_.graph.edges.some(
          (edge) => edge.toNode === target.id && edge.toPort === index,
        );
        if (!occupied) return index;
      }
      return 0;
    };
    const nearestInputPort = (
      x: number,
      y: number,
    ): { nodeId: string; port: number } | null => {
      let best: { nodeId: string; port: number; distance: number } | null = null;
      for (const node of session_.graph.nodes) {
        if (node.id === nodeId) continue;
        const spec = specOf(node.kind);
        for (let index = 0; index < spec.inputs; index += 1) {
          const screen = portScreen(node.id, index);
          if (!screen) continue;
          const distance = Math.hypot(screen.x - x, screen.y - y);
          if (distance <= LINK_SNAP_RADIUS && (!best || distance < best.distance)) {
            best = { nodeId: node.id, port: index, distance };
          }
        }
      }
      return best ? { nodeId: best.nodeId, port: best.port } : null;
    };
    const clearHover = (): void => {
      if (!session_.linkHoverNode) return;
      nodeElement(session_.linkHoverNode)?.classList.remove('cg-snap-target');
      session_.linkHoverNode = null;
    };

    const move = (moveEvent: PointerEvent) => {
      const point = { x: moveEvent.clientX - rect.left, y: moveEvent.clientY - rect.top };
      path.setAttribute('d', curve(origin, point));
      // 指针在一个有输入口的节点上时，把它的输入口整体点亮（松手就会接上）
      const hovered =
        elementAt(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>('.cg-node')?.dataset
          .nodeId || null;
      if (hovered !== session_.linkHoverNode) {
        clearHover();
        if (hovered) {
          session_.linkHoverNode = hovered;
          nodeElement(hovered)?.classList.add('cg-snap-target');
        }
      }
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up, true);
      path.remove();
      stage.classList.remove('cg-linking');
      clearHover();
      const link = session_.linkDrag;
      session_.linkDrag = null;
      if (!link) return;
      const element = elementAt(upEvent.clientX, upEvent.clientY);
      let targetId = '';
      let targetPort = 0;
      const portElement = element?.closest<HTMLElement>('.cg-port.cg-in');
      if (portElement) {
        const targetNode = portElement.closest<HTMLElement>('.cg-node');
        if (targetNode) {
          targetId = targetNode.dataset.nodeId || '';
          targetPort = Number(portElement.dataset.port || 0);
        }
      }
      if (!targetId) {
        // 落在节点身上（不一定是端口）也算接上：取第一个空输入口
        const nodeElementTarget = element?.closest<HTMLElement>('.cg-node');
        const id = nodeElementTarget?.dataset.nodeId || '';
        const target = session_.graph.nodes.find((item) => item.id === id);
        if (target && target.id !== link.fromNode && specOf(target.kind).inputs > 0) {
          targetId = target.id;
          targetPort = firstFreeInputPort(target);
        }
      }
      if (!targetId) {
        const near = nearestInputPort(upEvent.clientX, upEvent.clientY);
        if (near) {
          targetId = near.nodeId;
          targetPort = near.port;
        }
      }
      if (!targetId || targetId === link.fromNode) return;
      const before = cloneHistorySnapshot();
      session_.graph = connect(session_.graph, link.fromNode, link.fromPort, targetId, targetPort);
      session_.edited = true;
      commitHistory(before);
      schedule();
      renderEdges();
      const target = session_.graph.nodes.find((item) => item.id === targetId);
      if (target) session_.toast(`已接到${target.title || specOf(target.kind).label}`);
    };
    move(event);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, true);
  };

  const onStagePointerDown = (event: PointerEvent): void => {
    const target = event.target as HTMLElement;
    // 右键划选：Shift = 合并加转接点，Ctrl/Meta = 断开（和主画布 knife.ts 同一套手势）。
    // 必须在「只认 stage/world」之前判：指针压在一条连线上时命中的是 `.cg-edge-hit`，
    // 以前那个判断直接把起手吞掉，用户看到的就是「划过线段不建转接点」。
    if (event.button === 2 && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      closeMenu();
      stopPlacement();
      beginStroke(event, event.shiftKey ? 'merge' : 'cut');
      return;
    }
    // 连线层 pointer-events: none（只有线上的 hit path 可点），所以空白处只会命中 stage / world
    if (!(target === stage || target === world)) return;
    closeMenu();
    stopPlacement();
    // 中键 / 空格+左键 / Alt+左键 = 平移（Blender 的手感）
    if (event.button === 1 || (event.button === 0 && (session_.spaceHeld || event.altKey))) {
      event.preventDefault();
      // 平移不清选中：Blender 里中键拖动只是换个视角，选区要留着
      session_.panDrag = {
        x: session_.view.x,
        y: session_.view.y,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      stage.classList.add('cg-panning');
      return;
    }
    if (event.button !== 0) return;
    // 左键在空白处拖 = 框选，和主画布一致（不再用左键平移）
    const rect = stage.getBoundingClientRect();
    const element = document.createElement('div');
    element.className = 'cg-marquee';
    stage.append(element);
    session_.marquee = {
      startX: event.clientX - rect.left,
      startY: event.clientY - rect.top,
      additive: event.shiftKey,
      base: session_.selection.slice(),
      element,
      moved: false,
      hits: [],
    };
    if (!event.shiftKey) paintSelection([]);
  };

  const hitsInBox = (left: number, top: number, width: number, height: number): string[] => {
    const box = {
      x: (left - session_.view.x) / session_.view.scale,
      y: (top - session_.view.y) / session_.view.scale,
      width: width / session_.view.scale,
      height: height / session_.view.scale,
    };
    return session_.graph.nodes
      .filter((node) => {
        const element = nodeElement(node.id);
        const nodeHeight = element?.offsetHeight || 120;
        return (
          node.x < box.x + box.width &&
          node.x + nodeWidthOf(node.kind) > box.x &&
          node.y < box.y + box.height &&
          node.y + nodeHeight > box.y
        );
      })
      .map((node) => node.id);
  };

  const updateMarquee = (event: PointerEvent): void => {
    const drag = session_.marquee;
    if (!drag) return;
    const rect = stage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (Math.abs(x - drag.startX) + Math.abs(y - drag.startY) > 3) drag.moved = true;
    const left = Math.min(drag.startX, x);
    const top = Math.min(drag.startY, y);
    const width = Math.abs(x - drag.startX);
    const height = Math.abs(y - drag.startY);
    drag.element.style.left = `${left}px`;
    drag.element.style.top = `${top}px`;
    drag.element.style.width = `${width}px`;
    drag.element.style.height = `${height}px`;
    drag.hits = hitsInBox(left, top, width, height);
    paintSelection(drag.additive ? unique([...drag.base, ...drag.hits]) : drag.hits);
  };

  const finishMarquee = (): void => {
    const drag = session_.marquee;
    if (!drag) return;
    session_.marquee = null;
    drag.element.remove();
    if (drag.moved) {
      setSelection(drag.additive ? [...drag.base, ...drag.hits] : drag.hits);
    } else {
      setSelection(drag.additive ? drag.base : []);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (scopeResize) {
      updateScopeResize(event);
      return;
    }
    if (session_.previewPan) {
      const drag = session_.previewPan;
      session_.preview.x = drag.x + (event.clientX - drag.clientX);
      session_.preview.y = drag.y + (event.clientY - drag.clientY);
      applyPreviewView();
      return;
    }
    if (session_.strokeDrag) {
      updateStroke(event);
      return;
    }
    if (session_.nodeDrag) {
      const drag = session_.nodeDrag;
      const dx = (event.clientX - drag.clientX) / session_.view.scale;
      const dy = (event.clientY - drag.clientY) / session_.view.scale;
      for (const [id, start] of drag.positions) {
        const node = session_.graph.nodes.find((item) => item.id === id);
        if (!node) continue;
        node.x = start.x + dx;
        node.y = start.y + dy;
        const element = nodeElement(id);
        if (element) {
          element.style.left = `${node.x}px`;
          element.style.top = `${node.y}px`;
        }
      }
      renderEdges();
      updateInsertTarget(drag.id);
      return;
    }
    if (session_.panDrag) {
      const drag = session_.panDrag;
      session_.view.x = drag.x + (event.clientX - drag.clientX);
      session_.view.y = drag.y + (event.clientY - drag.clientY);
      applyView();
      return;
    }
    if (session_.marquee) updateMarquee(event);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (scopeResize) {
      endScopeResize();
      return;
    }
    if (session_.previewPan) {
      session_.previewPan = null;
      previewBox.classList.remove('cg-preview-panning');
      return;
    }
    if (session_.strokeDrag) {
      finishStroke();
      return;
    }
    if (session_.nodeDrag) {
      const drag = session_.nodeDrag;
      const dragged = drag.id;
      session_.nodeDrag = null;
      // 松手时压着连线就串进去（Blender 的 insert-on-link）；位置与插入合成一步撤销
      if (!commitInsert(dragged)) clearInsertTarget();
      commitHistory(drag.before);
    }
    if (session_.panDrag) {
      session_.panDrag = null;
      stage.classList.remove('cg-panning');
    }
    if (session_.marquee) finishMarquee();
    if (event.button === 0) stage.classList.remove('cg-panning');
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const rect = stage.getBoundingClientRect();
    const previous = session_.view.scale;
    const next = clamp(previous * Math.exp(-event.deltaY * 0.0012), MIN_SCALE, MAX_SCALE);
    if (next === previous) return;
    const worldX = (event.clientX - rect.left - session_.view.x) / previous;
    const worldY = (event.clientY - rect.top - session_.view.y) / previous;
    session_.view.scale = next;
    session_.view.x = event.clientX - rect.left - worldX * next;
    session_.view.y = event.clientY - rect.top - worldY * next;
    applyView();
  };

  /**
   * 断开一条连线（双击 / Ctrl+右键划线共用）。
   *
   * 用户 2026-10-30：「画布里的调色面板左键单点就断开连线了，修改一下，可以双击断开
   * 或者 ctrl+鼠标右键划线断开」。以前单击就断 —— 想点空白处或拖框选时手一抖压到线
   * 就把线弄没了。现在单击什么都不做，只有**双击**和 **Ctrl+右键划过**才断开。
   */
  const removeEdgeById = (edgeId: string): boolean => {
    if (!session_.graph.edges.some((item) => item.id === edgeId)) return false;
    const before = cloneHistorySnapshot();
    session_.graph = {
      ...session_.graph,
      edges: session_.graph.edges.filter((item) => item.id !== edgeId),
    };
    session_.edited = true;
    commitHistory(before);
    renderEdges();
    schedule();
    return true;
  };

  const onEdgeDoubleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const hit = target?.closest?.<SVGPathElement>('.cg-edge-hit');
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    if (removeEdgeById(hit.dataset.edgeId || '')) session_.toast('已断开连线（双击）');
  };

  // ---- 串线（把节点拖到一条连线上松手就插进去）---------------------------
  const nodeScreenRect = (
    node: CompositorNode,
  ): { left: number; top: number; right: number; bottom: number } => {
    const element = nodeElement(node.id);
    const width = nodeWidthOf(node.kind);
    const height =
      element?.offsetHeight || (node.kind === 'reroute' ? REROUTE_HEIGHT : 180);
    const origin = toScreen({ x: node.x, y: node.y });
    return {
      left: origin.x,
      top: origin.y,
      right: origin.x + width * session_.view.scale,
      bottom: origin.y + height * session_.view.scale,
    };
  };

  const pointInRect = (
    point: { x: number; y: number },
    rect: { left: number; top: number; right: number; bottom: number },
  ): boolean =>
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;

  /** 折线（连线采样点）是否压到节点矩形：端点落入 + 任意一段穿过四条边。 */
  const polylineHitsRect = (
    points: ReadonlyArray<{ x: number; y: number }>,
    rect: { left: number; top: number; right: number; bottom: number },
  ): boolean => {
    for (const point of points) if (pointInRect(point, rect)) return true;
    const corners = [
      { x: rect.left, y: rect.top },
      { x: rect.right, y: rect.top },
      { x: rect.right, y: rect.bottom },
      { x: rect.left, y: rect.bottom },
    ];
    const sides: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
      [corners[0], corners[1]],
      [corners[1], corners[2]],
      [corners[2], corners[3]],
      [corners[3], corners[0]],
    ];
    for (let index = 1; index < points.length; index += 1) {
      for (const [start, end] of sides) {
        if (segmentsCross(points[index - 1], points[index], start, end)) return true;
      }
    }
    return false;
  };

  /** 节点压住的连线里挑「离节点中心最近」的一条；一进一出的节点才有资格串线。 */
  const insertCandidateFor = (nodeId: string): string | null => {
    const node = session_.graph.nodes.find((item) => item.id === nodeId);
    if (!node || !canInsertIntoEdge(node.kind)) return null;
    const rect = nodeScreenRect(node);
    const center = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    let best: { edgeId: string; distance: number } | null = null;
    for (const edge of session_.graph.edges) {
      if (edge.fromNode === nodeId || edge.toNode === nodeId) continue;
      const points = edgeScreenPoints(edge);
      if (points.length < 2 || !polylineHitsRect(points, rect)) continue;
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 1; index < points.length; index += 1) {
        distance = Math.min(distance, distanceToSegment(center, points[index - 1], points[index]));
      }
      if (!best || distance < best.distance) best = { edgeId: edge.id, distance };
    }
    return best?.edgeId ?? null;
  };

  const paintInsertTarget = (): void => {
    edgeLayer
      .querySelectorAll<SVGPathElement>('.cg-edge.cg-edge-splice')
      .forEach((element) => element.classList.remove('cg-edge-splice'));
    const target = session_.insertTarget;
    if (!target) return;
    const path = edgeLayer.querySelector<SVGPathElement>(
      `.cg-edge[data-edge-id="${cssEscape(target.edgeId)}"]`,
    );
    path?.classList.add('cg-edge-splice');
  };

  /**
   * 拖动中实时算「会插进哪条线」。每帧重画连线后 class 会丢，所以这里总是重新标一遍，
   * 不做「同一个目标就跳过」的优化（连线数量是个位数，代价可以忽略）。
   */
  const updateInsertTarget = (nodeId: string | null): void => {
    const edgeId = nodeId ? insertCandidateFor(nodeId) : null;
    session_.insertTarget = nodeId && edgeId ? { nodeId, edgeId } : null;
    paintInsertTarget();
  };

  const clearInsertTarget = (): void => {
    session_.insertTarget = null;
    paintInsertTarget();
  };

  /**
   * 落地避让：刚放下/刚串进连线的节点不许压住别人（用户 2026-10-30 的原话见
   * resolveNodeOverlaps 的注释）。规则全在 graph.ts 里的纯函数里，这里只提供实时尺寸，
   * 并且**就地改坐标**（不换节点对象：色轮/曲线的闭包握着它们）。
   */
  const avoidOverlaps = (anchorId: string): boolean => {
    const sizeOf = (node: CompositorNode): { width: number; height: number } => {
      const element = nodeElement(node.id);
      return {
        width: nodeWidthOf(node.kind),
        height: element?.offsetHeight || (node.kind === 'reroute' ? REROUTE_HEIGHT : 180),
      };
    };
    const placements = resolveNodeOverlaps(session_.graph, anchorId, sizeOf);
    if (!placements.length) return false;
    for (const placement of placements) {
      const node = session_.graph.nodes.find((item) => item.id === placement.id);
      if (!node) continue;
      node.x = placement.x;
      node.y = placement.y;
      const element = nodeElement(node.id);
      if (!element) continue;
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
    }
    session_.edited = true;
    return true;
  };

  /** 串进连线后先让新节点站到上游右边（不遮住自己的源头），再推开挡路的。 */
  const layoutAfterInsert = (nodeId: string, upstreamId: string): void => {
    const anchor = session_.graph.nodes.find((node) => node.id === nodeId);
    const upstream = session_.graph.nodes.find((node) => node.id === upstreamId);
    if (anchor && upstream) {
      const clearX = upstream.x + nodeWidthOf(upstream.kind) + 40;
      if (anchor.x < clearX) {
        anchor.x = clearX;
        const element = nodeElement(anchor.id);
        if (element) element.style.left = `${anchor.x}px`;
      }
    }
    avoidOverlaps(nodeId);
  };

  /** 松手落地：把节点串进刚才高亮的那条线。返回是否真的插入了。
   *  历史由调用方合成一步（新节点在 addNode 已记，拖动在 pointerup 记），这里只改图。 */
  const commitInsert = (nodeId: string): boolean => {
    const target = session_.insertTarget;
    clearInsertTarget();
    if (!target || target.nodeId !== nodeId) return false;
    // 先记下原来这条线的上游：插完边就没了（自动挪位要「站在上游右边」）
    const source = session_.graph.edges.find((edge) => edge.id === target.edgeId)?.fromNode ?? '';
    const before = session_.graph.edges.length;
    const next = insertNodeIntoEdge(session_.graph, nodeId, target.edgeId);
    if (next === session_.graph || next.edges.length === before) return false;
    session_.graph = next;
    session_.edited = true;
    // 串进链里之后自动挪位：宽节点（色彩平衡 792px）会盖住上下游
    layoutAfterInsert(nodeId, source);
    renderEdges();
    schedule();
    session_.toast('已插入连线');
    return true;
  };

  // ---- 划选合并（Shift + 右键）：同源的几条线收进一个转接点 ----------------
  const edgeScreenPoints = (edge: CompositorEdge): Array<{ x: number; y: number }> => {
    const start = portWorld(edge.fromNode, 'out', edge.fromPort);
    const end = portWorld(edge.toNode, 'in', edge.toPort);
    if (!start || !end) return [];
    const from = toScreen(start);
    const to = toScreen(end);
    const dx = Math.max(42, Math.abs(to.x - from.x) * 0.5);
    const first = { x: from.x + dx, y: from.y };
    const second = { x: to.x - dx, y: to.y };
    const points: Array<{ x: number; y: number }> = [];
    for (let index = 0; index <= MERGE_SAMPLE_STEPS; index += 1) {
      const t = index / MERGE_SAMPLE_STEPS;
      const rest = 1 - t;
      points.push({
        x:
          rest ** 3 * from.x +
          3 * rest ** 2 * t * first.x +
          3 * rest * t ** 2 * second.x +
          t ** 3 * to.x,
        y:
          rest ** 3 * from.y +
          3 * rest ** 2 * t * first.y +
          3 * rest * t ** 2 * second.y +
          t ** 3 * to.y,
      });
    }
    return points;
  };

  const distanceToSegment = (
    point: { x: number; y: number },
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): number => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = dx * dx + dy * dy;
    if (length <= 0) return Math.hypot(point.x - start.x, point.y - start.y);
    const progress = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0, 1);
    return Math.hypot(point.x - (start.x + progress * dx), point.y - (start.y + progress * dy));
  };

  const segmentsCross = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    c: { x: number; y: number },
    d: { x: number; y: number },
  ): boolean => {
    const orientation = (
      p: { x: number; y: number },
      q: { x: number; y: number },
      r: { x: number; y: number },
    ): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const first = orientation(a, b, c);
    const second = orientation(a, b, d);
    const third = orientation(c, d, a);
    const fourth = orientation(c, d, b);
    if (first * second <= 0 && third * fourth <= 0) return true;
    return (
      Math.min(
        distanceToSegment(a, c, d),
        distanceToSegment(b, c, d),
        distanceToSegment(c, a, b),
        distanceToSegment(d, a, b),
      ) <= MERGE_HIT_TOLERANCE
    );
  };

  /** 划选线第一次碰到这条连线的位置（取那一小段的中点，转接点就摆在那儿）。 */
  const firstCrossing = (
    stroke: ReadonlyArray<{ x: number; y: number }>,
    points: ReadonlyArray<{ x: number; y: number }>,
  ): { x: number; y: number } | null => {
    for (let index = 1; index < stroke.length; index += 1) {
      const start = stroke[index - 1];
      const end = stroke[index];
      for (let step = 1; step < points.length; step += 1) {
        if (segmentsCross(start, end, points[step - 1], points[step])) {
          return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
        }
      }
    }
    return null;
  };

  const updateStrokeHits = (drag: StrokeDrag): void => {
    drag.hits.clear();
    const hints: string[] = [];
    for (const edge of session_.graph.edges) {
      const points = edgeScreenPoints(edge);
      if (points.length < 2) continue;
      const point = firstCrossing(drag.stroke, points);
      if (!point) continue;
      drag.hits.set(edge.id, { edge, point });
      hints.push(points.map((item, index) => `${index ? 'L' : 'M'} ${item.x} ${item.y}`).join(' '));
    }
    drag.hint.setAttribute('d', hints.join(' '));
    drag.hint.setAttribute('opacity', hints.length ? '1' : '0');
  };

  const strokeClass = (mode: StrokeDrag['mode']): string =>
    mode === 'cut' ? 'cg-cutting' : 'cg-merging';

  const beginStroke = (event: PointerEvent, mode: StrokeDrag['mode']): void => {
    const rect = stage.getBoundingClientRect();
    const hint = document.createElementNS(SVG_NS, 'path');
    // 与主画布切刀同一套配色：合并=绿（收束），断开=红（切断）
    hint.setAttribute('class', mode === 'cut' ? 'cg-cut-hint' : 'cg-merge-hint');
    hint.setAttribute('opacity', '0');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'cg-merge-stroke');
    edgeLayer.append(hint, path);
    session_.strokeDrag = {
      mode,
      stroke: [{ x: event.clientX - rect.left, y: event.clientY - rect.top }],
      path,
      hint,
      hits: new Map(),
    };
    stage.classList.add(strokeClass(mode));
  };

  const updateStroke = (event: PointerEvent): void => {
    const drag = session_.strokeDrag;
    if (!drag) return;
    const rect = stage.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const last = drag.stroke[drag.stroke.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
    drag.stroke.push(point);
    drag.path.setAttribute(
      'd',
      drag.stroke.map((item, index) => `${index ? 'L' : 'M'} ${item.x} ${item.y}`).join(' '),
    );
    updateStrokeHits(drag);
  };

  const finishStroke = (): void => {
    const drag = session_.strokeDrag;
    if (!drag) return;
    session_.strokeDrag = null;
    stage.classList.remove(strokeClass(drag.mode));
    drag.path.remove();
    drag.hint.remove();
    const hits = [...drag.hits.values()];
    if (!hits.length) return;
    const before = cloneHistorySnapshot();
    // Ctrl/Meta+右键划过：只断线，不建节点（用户 2026-10-30 要的「划线断开」）
    if (drag.mode === 'cut') {
      const removed = new Set(hits.map((hit) => hit.edge.id));
      session_.graph = {
        ...session_.graph,
        edges: session_.graph.edges.filter((edge) => !removed.has(edge.id)),
      };
      session_.edited = true;
      commitHistory(before);
      renderEdges();
      setSelection([]);
      schedule();
      session_.toast(`已断开 ${removed.size} 条连线`);
      return;
    }
    interface Group {
      fromNode: string;
      fromPort: number;
      point: { x: number; y: number };
      edges: CompositorEdge[];
    }
    const groups = new Map<string, Group>();
    for (const hit of hits) {
      const key = `${hit.edge.fromNode}|${hit.edge.fromPort}`;
      const existing = groups.get(key);
      if (existing) existing.edges.push(hit.edge);
      else {
        groups.set(key, {
          fromNode: hit.edge.fromNode,
          fromPort: hit.edge.fromPort,
          point: hit.point,
          edges: [hit.edge],
        });
      }
    }
    let graph = session_.graph;
    const created: string[] = [];
    for (const group of groups.values()) {
      const id = newCompositorId('reroute');
      const world = {
        x: (group.point.x - session_.view.x) / session_.view.scale,
        y: (group.point.y - session_.view.y) / session_.view.scale,
      };
      const node: CompositorNode = {
        id,
        kind: 'reroute',
        x: world.x - REROUTE_WIDTH / 2,
        y: world.y - REROUTE_HEIGHT / 2,
        params: {},
        title: '转接点',
      };
      const removed = new Set(group.edges.map((edge) => edge.id));
      graph = {
        ...graph,
        nodes: [...graph.nodes, node],
        edges: graph.edges.filter((edge) => !removed.has(edge.id)),
      };
      // 同源的几条线先并成「上游 → 转接点」这一条主干，再从转接点分出去
      graph = connect(graph, group.fromNode, group.fromPort, id, 0);
      for (const edge of group.edges) {
        graph = connect(graph, id, 0, edge.toNode, edge.toPort);
      }
      created.push(id);
    }
    session_.graph = graph;
    session_.edited = true;
    commitHistory(before);
    renderNodes();
    renderEdges();
    setSelection(created);
    schedule();
    session_.toast(`已合并 ${hits.length} 条线 · 新增 ${created.length} 个转接点`);
  };

  const cancelStroke = (): void => {
    const drag = session_.strokeDrag;
    if (!drag) return;
    session_.strokeDrag = null;
    stage.classList.remove(strokeClass(drag.mode));
    drag.path.remove();
    drag.hint.remove();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // 参数面板里的输入框优先：否则 Shift+A / T / 空格会把正在输入的字符吞成快捷键
    const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (event.key === 'Escape') {
      event.preventDefault();
      if (menu) {
        closeMenu();
        return;
      }
      if (session_.strokeDrag) {
        cancelStroke();
        return;
      }
      // 在数字框里按 Esc 只是退出输入，别顺手把整个调色面板关掉/保存
      if (typing) {
        (event.target as HTMLElement | null)?.blur?.();
        return;
      }
      // 「退出即保存」：有改动时 Esc 等于「保存并退出」，不再悄悄丢弃（用户 2026-10-29 的要求）。
      void exitWithSave();
      return;
    }
    if (typing) return;
    // 撤销 / 重做：Ctrl+Z、Ctrl+Shift+Z、Ctrl+Y（输入框里走浏览器原生撤销，不拦）
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoGraph();
        else undoGraph();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        redoGraph();
        return;
      }
    }
    if (event.key === ' ') {
      event.preventDefault();
      session_.spaceHeld = true;
      stage.classList.add('cg-space');
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const ids = session_.selection.filter((id) => {
        const node = session_.graph.nodes.find((item) => item.id === id);
        return node ? !FIXED_NODES.has(node.kind) : false;
      });
      if (!ids.length) return;
      event.preventDefault();
      const before = cloneHistorySnapshot();
      for (const id of ids) session_.graph = removeNode(session_.graph, id);
      session_.edited = true;
      commitHistory(before);
      renderNodes();
      renderEdges();
      setSelection([]);
      schedule();
      return;
    }
    if (event.key.toLowerCase() === 'a' && event.shiftKey) {
      event.preventDefault();
      openAddMenuAtPointer();
      return;
    }
    if (event.key.toLowerCase() === 't') {
      session_.tHeld = true;
      stage.style.cursor = 'crosshair';
    }
    if (event.key === 'f' || event.key === 'F') fitView();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() === 't') {
      session_.tHeld = false;
      stage.style.cursor = '';
    }
    if (event.key === ' ') {
      session_.spaceHeld = false;
      stage.classList.remove('cg-space');
    }
  };

  const onTopClick = (event: MouseEvent): void => {
    const act = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'add') {
      openAddMenuAtPointer();
      return;
    }
    if (act === 'scopes') {
      session_.scope.visible = !session_.scope.visible;
      applyScopeVisibility();
      return;
    }
    if (act === 'undo') return undoGraph();
    if (act === 'redo') return redoGraph();
    if (act === 'fit') return fitView();
    if (act === 'cancel') {
      requestCancel();
      return;
    }
    if (act === 'apply') void apply();
  };

  /**
   * 「放弃修改」要再点一次才真丢：调色是一次次拖出来的，误吞等于白做。
   * 真要保存的用户会被提示去点「保存并退出」或按 Esc。
   */
  let discardArmed = false;
  let discardTimer = 0;
  const requestCancel = (): void => {
    if (!session_.edited) {
      closeCompositorEditor();
      return;
    }
    if (discardArmed) {
      window.clearTimeout(discardTimer);
      closeCompositorEditor();
      return;
    }
    discardArmed = true;
    session_.toast('再点一次「放弃修改」才丢弃这次调整；要保存请点「保存并退出」或按 Esc');
    discardTimer = window.setTimeout(() => {
      discardArmed = false;
    }, 5000);
  };

  /** 输出节点的上游是不是「输入图像」原样直连（= 用户只把效果接进了预览链）。 */
  const upstreamIsRawInput = (targetId: string): boolean =>
    targetIsRawInput(session_.graph, targetId);

  const apply = async (): Promise<boolean> => {
    const engine = session_.engine;
    if (!engine) {
      session_.toast('合成器引擎还没准备好', true);
      return false;
    }
    // 导哪个口是纯图逻辑，见 graph.ts 的 chooseApplyTargets（回归直接验）
    const targets = chooseApplyTargets(session_.graph);
    if (!targets.length) {
      session_.toast('输出和预览都没接线：从「输入图像」右边拖一条线接到效果节点，再接到「输出」。', true);
      return false;
    }
    applyButton.disabled = true;
    try {
      engine.setGraph(session_.graph);
      engine.setSize(session_.size.width, session_.size.height);
      if (session_.canvas) {
        session_.canvas.width = session_.size.width;
        session_.canvas.height = session_.size.height;
      }
      let used: 'output' | 'viewer' | null = null;
      let dataUrl: string | null = null;
      for (const candidate of targets) {
        if (!session_.graph.edges.some((edge) => edge.toNode === candidate)) continue;
        const order = evaluationOrder(session_.graph, candidate);
        if (order.error) continue;
        const texture = engine.evaluate(candidate);
        const exported = texture ? engine.exportDataUrl(candidate) : null;
        if (exported) {
          used = candidate;
          dataUrl = exported;
          break;
        }
      }
      if (!dataUrl || !used) {
        session_.toast('没导出来图像：确认「输出」或「预览」节点接在效果链的最后一环上。', true);
        return false;
      }
      if (used === 'viewer' && targets[0] === 'viewer') {
        console.info(
          '[dsh-aifisher-canvas] 输出节点' +
            (upstreamIsRawInput('output') ? '还接着原始图像' : '没有接线') +
            '，这次按预览（VIEWER）的结果保存。',
        );
      }
      await options.onApply({
        graph: {
          ...session_.graph,
          view: { ...session_.view },
          // 示波器看哪张图、开没开、面板多大也一起存（下次打开还是这个大小）
          scope: {
            kind: session_.scope.kind,
            visible: session_.scope.visible,
            width: Math.round(session_.scope.width),
            height: Math.round(session_.scope.height),
          },
        },
        dataUrl,
      });
      session_.toast('已保存，正在写回画布');
      closeCompositorEditor();
      return true;
    } catch (error) {
      // 以前这里只包住 onApply：导出阶段抛错会变成「点保存没反应」，一律报出来
      session_.toast(error instanceof Error ? error.message : String(error), true);
      return false;
    } finally {
      if (session_ === session) {
        applyButton.disabled = false;
        schedule();
      }
    }
  };

  /** Esc / 退出：有改动就保存并落图（用户 2026-10-29：「希望按退出也会输出保存图像」）。 */
  const exitWithSave = async (): Promise<void> => {
    if (!session_.edited) {
      closeCompositorEditor();
      return;
    }
    await apply();
  };

  session_.onKey = onKeyDown;
  const signal = session_.controller.signal;
  world.addEventListener('pointerdown', onNodePointerDown, { signal });
  stage.addEventListener('pointerdown', onStagePointerDown, { signal });
  stage.addEventListener('wheel', onWheel, { passive: false, signal });
  // 新节点的落点跟着指针走：菜单在窗口中心弹，但用户的眼睛（和鼠标）可能在别处
  stage.addEventListener(
    'pointermove',
    (event: PointerEvent) => {
      stagePointer = { x: event.clientX, y: event.clientY };
    },
    { signal, passive: true },
  );
  // 连线只认「双击断开」与「Ctrl+右键划过断开」：单击什么都不做（避免误触把线弄丢）
  stage.addEventListener('dblclick', onEdgeDoubleClick, { signal });
  // 上方预览：滚轮缩放 / 拖动平移 / 双击复位
  previewBox.addEventListener('wheel', onPreviewWheel, { passive: false, signal });
  previewBox.addEventListener('pointerdown', onPreviewPointerDown, { signal });
  previewBox.addEventListener('dblclick', () => resetPreviewView(), { signal });
  // 示波器 tab：波形图 / 分量图 / 矢量图（切 tab 复用最近一次读回的像素）
  scopeTabs.addEventListener('click', (event: MouseEvent) => {
    const kind = (event.target as HTMLElement).closest<HTMLElement>('[data-scope]')?.dataset
      .scope as ScopeKind | undefined;
    if (!kind) return;
    session_.scope.kind = kind;
    paintScope();
  });
  // 窗口尺寸变了，面板的 CSS 尺寸跟着变：重新量画布再画一遍（不做的话会糊成拉伸图）
  window.addEventListener(
    'resize',
    () => {
      if (session_.scope.visible) paintScope();
    },
    { signal, passive: true },
  );
  top.addEventListener('click', onTopClick, { signal });
  document.addEventListener('keydown', onKeyDown, { signal });
  document.addEventListener('keyup', onKeyUp, { signal });
  window.addEventListener('pointermove', onPointerMove, { signal });
  window.addEventListener('pointerup', onPointerUp, { signal });
  // 右键菜单在合成器里一律压掉（画布的上下文菜单不该穿透进来）
  const suppressContextMenu = (event: Event) => event.preventDefault();
  root.addEventListener('contextmenu', suppressContextMenu, { signal });

  renderNodes();
  applyView();
  applyPreviewView();
  applyScopeVisibility();
  refreshHistoryButtons();
  // 第一次打开（没有存过视图）时先适应视图：默认位置下预览节点会被 stage 下沿切掉半截。
  if (!graph.view) fitView();
  initEngines();
  resolveSize();
  meta.textContent = options.images.length
    ? `加载中 · ${options.images.length} 张输入`
    : '没有输入图像';
  schedule();
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

export function closeCompositorEditor(): void {
  if (!session) return;
  const current = session;
  session = null;
  current.destroyed = true;
  closePopup();
  // 菜单与下拉列表挂在 body 上（不随 root 一起消失），关面板时一并清掉
  document.querySelectorAll('.cg-menu, .cg-select-list').forEach((element) => element.remove());
  current.placementController?.abort();
  current.placementController = null;
  current.placement = null;
  if (current.history.pendingTimer) window.clearTimeout(current.history.pendingTimer);
  current.history.pendingTimer = 0;
  current.history.pending = null;
  if (current.frame !== null) {
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(current.frame);
    else window.clearTimeout(current.frame);
  }
  current.controller.abort();
  current.root.remove();
  document.body.style.overflow = current.previousOverflow;
  current.engine?.destroy();
  current.options.onClose?.();
}

export function isCompositorOpen(): boolean {
  return !!session;
}

export function compositorReport(): Record<string, unknown> {
  if (!session) return { open: false };
  return {
    open: true,
    nodeCount: session.graph.nodes.length,
    edgeCount: session.graph.edges.length,
    selection: session.selection,
    edited: session.edited,
    topbarInset: session.root.style.getPropertyValue('--cg-topbar-right') || '0px',
    insertTarget: session.insertTarget ? session.insertTarget.edgeId : null,
    view: {
      x: Math.round(session.view.x),
      y: Math.round(session.view.y),
      scale: Number(session.view.scale.toFixed(2)),
    },
    preview: {
      zoom: Number(session.preview.zoom.toFixed(2)),
      x: Math.round(session.preview.x),
      y: Math.round(session.preview.y),
    },
    scope: {
      visible: session.scope.visible,
      kind: session.scope.kind,
      hasImage: !!session.scope.image,
      width: Math.round(session.scope.width),
      height: Math.round(session.scope.height),
      clipShadow: Number(session.scope.clipShadow.toFixed(4)),
      clipHighlight: Number(session.scope.clipHighlight.toFixed(4)),
    },
    placing: session.placement ? session.placement.id : null,
    /** 进行中的右键划选：merge / cut / null（回归用）。 */
    stroke: session.strokeDrag ? session.strokeDrag.mode : null,
    history: {
      canUndo: !!session.history.past.length || !!session.history.pending,
      canRedo: !!session.history.future.length,
      undo: session.history.past.length,
      redo: session.history.future.length,
    },
    nodes: session.graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      x: Math.round(node.x),
      y: Math.round(node.y),
    })),
    edges: session.graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.fromNode,
      fromPort: edge.fromPort,
      to: edge.toNode,
      toPort: edge.toPort,
    })),
    images: session.options.images.length,
  };
}

/** 回归用：编辑器里「Shift+点击接到预览」的端口规则，不依赖 DOM。 */
export function viewerTargetPort(): { node: 'viewer'; port: number } {
  return { node: 'viewer', port: 0 };
}

/** 回归用：默认图必须把输入同时接到输出与预览（Blender 里 viewer 是独立一份）。 */
export function defaultGraphIsWired(inputCount: number): boolean {
  const graph = createDefaultGraph(inputCount);
  const ports = inputPortsFor(graph.edges, 'input');
  return (
    ports.length === Math.max(1, inputCount) &&
    graph.edges.some((edge) => edge.toNode === 'output') &&
    graph.edges.some((edge) => edge.toNode === 'viewer')
  );
}

/** 回归用：连接后同一输入口只有一条边（后连的覆盖先连的）。 */
export function edgeReplacementWorks(): boolean {
  let graph = createDefaultGraph(1);
  graph = connect(graph, 'input', 0, 'output', 0);
  const incoming = graph.edges.filter((edge) => edge.toNode === 'output');
  return incoming.length === 1 && incoming[0].id === edgeId('input', 0, 'output', 0);
}
