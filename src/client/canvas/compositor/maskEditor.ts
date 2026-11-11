/**
 * 预览里的遮罩编辑器（用户 2026-11-11 改版）。
 *
 * 用户原话：「这里要点击然后跳转另外一个页面来画遮罩，我觉得直接在左上角的预览切换成遮罩
 * 来上添加绘制就好了。添加圆形和方型的遮罩工具，可以直接在画布预览区域 shift+a 搜索添加形状。
 * 添加画笔工具和颜色工具。」
 *
 * 所以 v1.94 的「点编辑 → 弹一整个全屏浮层」被撤掉，改成：
 *   - 上方预览（VIEWER 那块）在左上角切「预览 / 遮罩」，切到遮罩就在原地画；
 *   - 工具栏长在预览底部：选择 / 画笔 / 圆形 / 方形 + 前景/背景色 + 笔刷/羽化；
 *   - Shift+A（或点「＋ 形状」）弹和节点搜索同一套模糊搜索菜单，能加圆、方、自由样条；
 *   - 形状控制点仍按 Blender 的手感：G/R/S 变换（X/Y 锁轴）、X 删点、E 挤出、M 合并、F 闭合。
 *
 * 这一层只管「画」：DOM 交互 + 画布预览。真值仍然写回项目级遮罩数据块
 * （graph.masks，见 graph.ts 的 CompositorMask），栅格化由 editor.ts 统一做。
 */

import type { CompositorMask, CompositorMaskShape } from './graph';
import {
  boxShapePoints,
  brushDiameter,
  brushGradientStops,
  circleShapePoints,
  featherPixels,
  hitSplinePoint,
  shapeIsSmooth,
  splineFromParam,
  splineToParam,
  strokePoints,
  traceMaskOutline,
  type MaskPoint,
  type MaskShapeKind,
} from './maskPaint';
import { fuzzyScore } from './nodeSearch';

export type MaskTool = 'select' | 'brush' | 'circle' | 'box';

export interface MaskEditorOptions {
  /** 预览面板（工具栏与提示的父节点）。 */
  host: HTMLElement;
  /** 叠在预览画布上的遮罩画布（已插进 host）。 */
  canvas: HTMLCanvasElement;
  /** 帧尺寸（= 遮罩画布像素尺寸）。 */
  size: () => { width: number; height: number };
  /** 当前要编辑的遮罩（每次写回后对象会换新的，所以每次现取）。 */
  mask: () => CompositorMask | undefined;
  /** 写回遮罩数据块（外层负责重栅格化 + 重绘节点）。 */
  update: (mask: CompositorMask) => void;
  /** 遮罩节点参考口的底图（没有就 null，编辑时垫着对位）。 */
  baseImageUrl: () => string | null;
  /** 只改了编辑器的显示（不写回时）；外层重绘节点卡片 + 调度求值。 */
  changed: () => void;
  toast: (message: string, error?: boolean) => void;
  /** 点「返回预览」：切回 VIEWER。 */
  exit: () => void;
}

export interface MaskEditor {
  /** 底部工具栏 + 快捷键提示（外层 append 进预览面板）。 */
  element: HTMLElement;
  activate: () => void;
  deactivate: () => void;
  /** 换了一份遮罩（下拉切遮罩 / 换节点）时把编辑器状态重新读一遍。 */
  reload: () => void;
  /** 帧尺寸 / 视图变了要重画一次。 */
  render: () => void;
  /** 键盘优先处理；true = 已消费。 */
  handleKey: (event: KeyboardEvent) => boolean;
  /** 回归用读数。 */
  state: () => Record<string, unknown>;
  destroy: () => void;
}

/** 编辑中的一条形状：控制点换成遮罩画布像素（存储仍是归一化）。 */
interface WorkingShape {
  kind: MaskShapeKind;
  points: MaskPoint[];
  closed: boolean;
}

interface ToolSnapshot {
  shapes: WorkingShape[];
  active: number;
  paint: string | null;
}

/** 画笔默认：占画面宽度 6%，硬度 0.7（和 Blender 的默认笔刷手感接近）。 */
const DEFAULT_BRUSH = 0.06;
const DEFAULT_HARDNESS = 0.7;
/** 从菜单直接加形状时的默认半径 / 边长（占画面宽度的比例）。 */
const DEFAULT_SHAPE_DIAMETER = 0.36;
/** 前景/背景默认：白（加入）/ 黑（擦除）—— 遮罩是黑白图。 */
const DEFAULT_FG = '#ffffff';
const DEFAULT_BG = '#000000';

/* ------------------------------------------------------------------ */
/* 画笔层的解码缓存：栅格化（editor.ts）与编辑器共用                       */
/* ------------------------------------------------------------------ */

interface PaintCacheEntry {
  data: string;
  canvas: HTMLCanvasElement;
}

const paintCache = new Map<string, PaintCacheEntry>();
const paintDecoding = new Map<string, Promise<HTMLCanvasElement | null>>();

/** 已经解码好的画笔层（dataURL 对得上才给，栅格化就是同步的）。 */
export function cachedMaskPaint(mask: CompositorMask): HTMLCanvasElement | null {
  if (!mask.paint) return null;
  const entry = paintCache.get(mask.id);
  return entry && entry.data === mask.paint ? entry.canvas : null;
}

/** 记下刚画完的画笔层：下次栅格化直接用它，不必再解一次 dataURL。 */
export function rememberMaskPaint(
  maskId: string,
  data: string,
  canvas: HTMLCanvasElement,
): void {
  paintCache.set(maskId, { data, canvas });
}

/** 解码画笔层（同一份 dataURL 只解一次）。没有画笔层就 resolve(null)。 */
export function decodeMaskPaint(mask: CompositorMask): Promise<HTMLCanvasElement | null> {
  const data = mask.paint;
  if (!data) return Promise.resolve(null);
  const entry = paintCache.get(mask.id);
  if (entry && entry.data === data) return Promise.resolve(entry.canvas);
  const pending = paintDecoding.get(mask.id);
  if (pending) return pending;
  const task = new Promise<HTMLCanvasElement | null>((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    const image = new Image();
    image.onload = () => {
      paintDecoding.delete(mask.id);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, image.naturalWidth || 1);
      canvas.height = Math.max(1, image.naturalHeight || 1);
      const context = canvas.getContext('2d');
      if (!context) {
        resolve(null);
        return;
      }
      context.drawImage(image, 0, 0);
      paintCache.set(mask.id, { data, canvas });
      resolve(canvas);
    };
    image.onerror = () => {
      paintDecoding.delete(mask.id);
      resolve(null);
    };
    image.src = data;
  });
  paintDecoding.set(mask.id, task);
  return task;
}

/** 0..255 的灰度（画笔落笔值）：颜色按亮度换算 —— 遮罩是黑白图，颜色只是取它的明暗。 */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cloneShapes(shapes: readonly WorkingShape[]): WorkingShape[] {
  return shapes.map((shape) => ({
    kind: shape.kind,
    closed: shape.closed,
    points: shape.points.map((point) => ({ x: point.x, y: point.y })),
  }));
}

export function createMaskEditor(options: MaskEditorOptions): MaskEditor {
  const canvas = options.canvas;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext('2d');
  } catch {
    context = null;
  }

  let active = false;
  let tool: MaskTool = 'select';
  let shapes: WorkingShape[] = [];
  let activeShape = 0;
  let selected: number[] = [];
  let feather = 0.015;
  let brushSize = DEFAULT_BRUSH;
  let hardness = DEFAULT_HARDNESS;
  let foreground = DEFAULT_FG;
  let background = DEFAULT_BG;
  let paint: HTMLCanvasElement | null = null;
  let paintReady = true;
  /** 画笔层动过没有：没动过就别把一张空图写进数据块（免得 JSON 里全是空 PNG）。 */
  let paintTouched = false;
  let strokes = 0;
  let currentMask: CompositorMask | undefined;
  let baseImage: HTMLImageElement | null = null;

  /** 指针拖动状态。 */
  let dragPoint = -1;
  let stroke: { last: MaskPoint; value: number } | null = null;
  let shapeDrag: { from: MaskPoint; to: MaskPoint; kind: 'circle' | 'box' } | null = null;
  let transform: {
    mode: 'move' | 'rotate' | 'scale';
    origin: MaskPoint;
    startPoints: MaskPoint[];
    startPointer: MaskPoint;
    axis: 'x' | 'y' | null;
  } | null = null;
  let lastPointer: MaskPoint | null = null;
  let lastClient: { x: number; y: number } | null = null;
  let menu: HTMLElement | null = null;
  let menuCleanup: (() => void) | null = null;

  /** 编辑器自己的撤销栈（Ctrl+Z 在遮罩模式里先退这一层）。 */
  const snapshots: ToolSnapshot[] = [];
  let restoredPaintToken = 0;

  const size = (): { width: number; height: number } => {
    const frame = options.size();
    return {
      width: Math.max(2, Math.round(frame.width)),
      height: Math.max(2, Math.round(frame.height)),
    };
  };

  /* ---------------- 工具栏 ---------------- */

  const element = document.createElement('div');
  element.className = 'cg-mask-hud';
  element.setAttribute('data-fisherai-mask-editor', 'true');

  const bar = document.createElement('div');
  bar.className = 'cg-maskbar';

  const tools = document.createElement('div');
  tools.className = 'cg-maskbar-tools';
  const toolDefs: Array<{ id: MaskTool; label: string; title: string }> = [
    { id: 'select', label: '选择', title: '选择控制点（V）：左键加点 / 拖点，G 移动 R 旋转 S 缩放' },
    { id: 'brush', label: '画笔', title: '画笔（B）：左键画前景色、右键擦；[ ] 改笔刷大小' },
    { id: 'circle', label: '圆形', title: '圆形遮罩：在预览上拖出来（点一下 = 默认大小）' },
    { id: 'box', label: '方形', title: '方形遮罩：在预览上拖出来（点一下 = 默认大小）' },
  ];
  const toolButtons = new Map<MaskTool, HTMLButtonElement>();
  for (const def of toolDefs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cg-maskbar-tool';
    button.dataset.maskTool = def.id;
    button.textContent = def.label;
    button.title = def.title;
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      setTool(def.id);
    });
    toolButtons.set(def.id, button);
    tools.append(button);
  }

  const colors = document.createElement('div');
  colors.className = 'cg-maskbar-colors';
  const makeSwatch = (slot: 'fg' | 'bg', initial: string, title: string): HTMLInputElement => {
    const label = document.createElement('label');
    label.className = 'cg-maskbar-swatch';
    label.title = title;
    label.dataset.maskSwatch = slot;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = initial;
    input.dataset.maskColor = slot;
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('input', () => {
      if (slot === 'fg') foreground = input.value;
      else background = input.value;
      label.style.setProperty('--swatch', input.value);
    });
    label.style.setProperty('--swatch', initial);
    label.append(input);
    colors.append(label);
    return input;
  };
  const fgInput = makeSwatch('fg', DEFAULT_FG, '前景色：画笔落笔的颜色（按亮度写进黑白遮罩）');
  const bgInput = makeSwatch('bg', DEFAULT_BG, '背景色：右键擦除用的颜色（默认黑 = 擦掉）');
  const swapButton = document.createElement('button');
  swapButton.type = 'button';
  swapButton.className = 'cg-maskbar-swap';
  swapButton.textContent = '⇄';
  swapButton.title = '交换前景 / 背景';
  swapButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  swapButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const fg = foreground;
    foreground = background;
    background = fg;
    fgInput.value = foreground;
    bgInput.value = background;
    fgInput.parentElement?.style.setProperty('--swatch', foreground);
    bgInput.parentElement?.style.setProperty('--swatch', background);
  });
  colors.append(swapButton);

  const brushField = document.createElement('label');
  brushField.className = 'cg-maskbar-field';
  const brushLabel = document.createElement('span');
  const brushInput = document.createElement('input');
  brushInput.type = 'range';
  brushInput.min = '1';
  brushInput.max = '40';
  brushInput.step = '1';
  brushInput.dataset.maskBrush = 'true';
  brushInput.value = String(Math.round(brushSize * 100));
  brushInput.addEventListener('pointerdown', (event) => event.stopPropagation());
  brushInput.addEventListener('input', () => {
    brushSize = clamp(Number(brushInput.value) / 100 || DEFAULT_BRUSH, 0.01, 0.4);
    syncLabels();
  });
  brushField.append(brushLabel, brushInput);

  const featherField = document.createElement('label');
  featherField.className = 'cg-maskbar-field';
  const featherLabel = document.createElement('span');
  const featherInput = document.createElement('input');
  featherInput.type = 'range';
  featherInput.min = '0';
  featherInput.max = '10';
  featherInput.step = '0.5';
  featherInput.dataset.maskFeather = 'true';
  featherInput.addEventListener('pointerdown', (event) => event.stopPropagation());
  featherInput.addEventListener('input', () => {
    feather = clamp(Number(featherInput.value) / 100 || 0, 0, 0.1);
    syncLabels();
    render();
  });
  // 拖动过程只改本地预览，松手才写回（每次写回都要重栅格化 + 重绘节点）
  featherInput.addEventListener('change', () => commitMask(false));
  featherField.append(featherLabel, featherInput);

  const actions = document.createElement('div');
  actions.className = 'cg-maskbar-actions';
  const makeAction = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  };
  actions.append(
    makeAction('＋ 形状', 'Shift+A：搜索添加圆形 / 方形 / 自由样条', () => openShapeMenu()),
    makeAction('清空', '清空这份遮罩的所有形状和画笔笔画', () => clearMask()),
    makeAction('返回预览', '回到 VIEWER 预览（遮罩已经保存）', () => options.exit()),
  );

  bar.append(tools, colors, brushField, featherField, actions);
  element.append(bar);

  const hint = document.createElement('div');
  hint.className = 'cg-maskbar-hint';
  hint.dataset.maskHint = 'true';
  element.append(hint);

  /* ---------------- 状态同步 ---------------- */

  const syncLabels = (): void => {
    for (const [id, button] of toolButtons) {
      button.classList.toggle('cg-active', id === tool);
    }
    brushLabel.textContent = `笔刷 ${Math.round(brushSize * 100)}%`;
    featherLabel.textContent = `羽化 ${(feather * 100).toFixed(1)}%`;
    featherInput.value = String(clamp(feather * 100, 0, 10));
    brushField.classList.toggle('cg-dim', tool !== 'brush');
    hint.textContent =
      tool === 'brush'
        ? '左键画前景色（白=加入）· 右键擦（黑）· [ ] 改笔刷大小 · Shift+A 加形状 · Esc 返回预览'
        : tool === 'circle' || tool === 'box'
          ? `拖出${tool === 'circle' ? '圆形' : '方形'}区域 · 点一下 = 默认大小 · Shift+A 搜索加形状`
          : '左键加点 / 拖控制点 · Shift+点加选 · A 全选 G 移动 R 旋转 S 缩放（X/Y 锁轴）· X 删点 E 挤出 M 合并 F 闭合 · Shift+A 加形状';
  };

  const setTool = (next: MaskTool): void => {
    if (tool === next) return;
    tool = next;
    cancelTransient();
    syncLabels();
    render();
  };

  const cancelTransient = (): void => {
    transform = null;
    dragPoint = -1;
    stroke = null;
    shapeDrag = null;
  };

  /* ---------------- 坐标换算 ---------------- */

  /**
   * 遮罩画布在屏幕上的**内容**矩形。
   *
   * 画布是 `width:100%;height:100%` + `object-fit: contain`，外加上方预览的
   * transform（缩放/平移）。所以：元素盒（getBoundingClientRect 已含 transform）
   * 里再按 contain 的留白把内容框算出来。
   */
  const surfaceRect = (): { left: number; top: number; width: number; height: number } => {
    const frame = size();
    const rect = canvas.getBoundingClientRect();
    const cssWidth = canvas.clientWidth || rect.width || frame.width;
    const cssHeight = canvas.clientHeight || rect.height || frame.height;
    // jsdom / 未布局：按 1:1（clientX 直接当画布像素）——回归里靠这条
    if (rect.width <= 1 || rect.height <= 1 || cssWidth <= 1 || cssHeight <= 1) {
      return { left: rect.left || 0, top: rect.top || 0, width: frame.width, height: frame.height };
    }
    const scaleX = rect.width / cssWidth;
    const scaleY = rect.height / cssHeight;
    const fit = Math.min(cssWidth / frame.width, cssHeight / frame.height);
    const contentWidth = frame.width * fit;
    const contentHeight = frame.height * fit;
    return {
      left: rect.left + ((cssWidth - contentWidth) / 2) * scaleX,
      top: rect.top + ((cssHeight - contentHeight) / 2) * scaleY,
      width: contentWidth * scaleX,
      height: contentHeight * scaleY,
    };
  };

  const toFrame = (event: { clientX: number; clientY: number }): MaskPoint => {
    const frame = size();
    const surface = surfaceRect();
    return {
      x: ((event.clientX - surface.left) / Math.max(1, surface.width)) * frame.width,
      y: ((event.clientY - surface.top) / Math.max(1, surface.height)) * frame.height,
    };
  };

  /** 命中半径按屏幕像素算（12px），换成画布像素后再比距离。 */
  const screenRadius = (): number => {
    const frame = size();
    const surface = surfaceRect();
    const scale = surface.width / frame.width;
    return scale > 0 ? Math.max(4, 12 / scale) : 12;
  };

  /* ---------------- 形状 / 画笔写回 ---------------- */

  const activePoints = (): MaskPoint[] => {
    const shape = shapes[activeShape];
    return shape ? shape.points : [];
  };

  const ensureShape = (kind: MaskShapeKind = 'spline'): WorkingShape => {
    if (!shapes.length) {
      shapes = [{ kind, points: [], closed: false }];
      activeShape = 0;
      selected = [];
    } else if (activeShape < 0 || activeShape >= shapes.length) {
      activeShape = 0;
    }
    return shapes[activeShape];
  };

  /** 把当前形状/画笔层写回遮罩数据块（`snapshot`=改之前先记一步撤销）。 */
  const commitMask = (takeSnapshot = true): void => {
    // 以节点当前引用的那份为准（下拉切过遮罩后，currentMask 可能是旧的）
    const mask = options.mask() ?? currentMask;
    if (!mask) return;
    if (takeSnapshot) pushSnapshot();
    const { width: W, height: H } = size();
    const encoded: CompositorMaskShape[] = shapes
      .filter((shape) => shape.points.length >= 2)
      .map((shape) => ({
        kind: shape.kind,
        closed: shape.closed,
        points: splineToParam(shape.points.map((point) => ({ x: point.x / W, y: point.y / H }))),
      }));
    let data = mask.paint;
    if (paint && paintTouched) {
      data = paint.toDataURL('image/png');
      rememberMaskPaint(mask.id, data, paint);
    }
    const next: CompositorMask = {
      ...mask,
      shapes: encoded,
      feather,
      ...(data ? { paint: data, paintWidth: W, paintHeight: H } : {}),
    };
    options.update(next);
    currentMask = options.mask() ?? next;
    options.changed();
  };

  const pushSnapshot = (): void => {
    let data: string | null = null;
    if (paint) {
      try {
        data = paint.toDataURL('image/png');
      } catch {
        data = null;
      }
    }
    snapshots.push({ shapes: cloneShapes(shapes), active: activeShape, paint: data });
    if (snapshots.length > 12) snapshots.shift();
  };

  const undo = (): boolean => {
    const snapshot = snapshots.pop();
    if (!snapshot) return false;
    shapes = cloneShapes(snapshot.shapes);
    activeShape = clamp(snapshot.active, 0, Math.max(0, shapes.length - 1));
    selected = [];
    if (snapshot.paint) {
      void restorePaint(snapshot.paint);
    } else if (paint) {
      const frame = size();
      const context2d = paint.getContext('2d');
      context2d?.clearRect(0, 0, frame.width, frame.height);
    }
    commitMask(false);
    render();
    return true;
  };

  const restorePaint = async (data: string): Promise<void> => {
    const token = ++restoredPaintToken;
    const mask = currentMask;
    if (!mask) return;
    const decoded = await decodeMaskPaint({ ...mask, paint: data });
    if (token !== restoredPaintToken || !decoded) return;
    const frame = size();
    if (!paint) paint = createPaintCanvas();
    const context2d = paint.getContext('2d');
    if (!context2d) return;
    context2d.clearRect(0, 0, frame.width, frame.height);
    context2d.drawImage(decoded, 0, 0, frame.width, frame.height);
    paintTouched = true;
    render();
  };

  const createPaintCanvas = (): HTMLCanvasElement => {
    const frame = size();
    const layer = document.createElement('canvas');
    layer.width = frame.width;
    layer.height = frame.height;
    return layer;
  };

  const clearMask = (): void => {
    if (!currentMask) return;
    pushSnapshot();
    shapes = [];
    activeShape = 0;
    selected = [];
    const frame = size();
    if (paint) paint.getContext('2d')?.clearRect(0, 0, frame.width, frame.height);
    // 清空要把「空画笔层」也写回去，否则上一次的笔画会从旧数据块里复活
    paintTouched = true;
    commitMask(false);
    render();
    options.toast('遮罩已清空');
  };

  /* ---------------- 画笔 ---------------- */

  const paintDab = (point: MaskPoint, value: number): void => {
    if (!paint) return;
    const frame = size();
    const context2d = paint.getContext('2d');
    if (!context2d) return;
    const radius = Math.max(0.5, brushDiameter(brushSize, frame.width) / 2);
    if (typeof context2d.createRadialGradient === 'function') {
      const gradient = context2d.createRadialGradient(
        point.x,
        point.y,
        0,
        point.x,
        point.y,
        radius,
      );
      for (const [offset, alpha] of brushGradientStops(hardness)) {
        gradient.addColorStop(offset, `rgba(${value},${value},${value},${alpha})`);
      }
      context2d.fillStyle = gradient;
    } else {
      context2d.fillStyle = `rgba(${value},${value},${value},1)`;
    }
    context2d.beginPath();
    context2d.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context2d.fill();
  };

  const beginStroke = (point: MaskPoint, value: number): void => {
    if (!paintReady) {
      options.toast('正在读回画笔层，稍等一下再画', true);
      return;
    }
    if (!paint) paint = createPaintCanvas();
    paintTouched = true;
    stroke = { last: point, value };
    paintDab(point, value);
    render();
  };

  const moveStroke = (point: MaskPoint): void => {
    if (!stroke) return;
    const frame = size();
    const spacing = Math.max(1, brushDiameter(brushSize, frame.width) * 0.16);
    for (const step of strokePoints(stroke.last, point, spacing)) {
      paintDab(step, stroke.value);
    }
    paintDab(point, stroke.value);
    stroke.last = point;
    render();
  };

  const endStroke = (): void => {
    if (!stroke) return;
    stroke = null;
    strokes += 1;
    commitMask(true);
  };

  /* ---------------- 画布绘制 ---------------- */

  const render = (): void => {
    if (!context) return;
    const frame = size();
    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, frame.width, frame.height);
    // 底图垫在下面（对位用）；没接参考口就让下面的合成预览透出来
    if (baseImage && baseImage.complete && baseImage.naturalWidth) {
      context.globalAlpha = 0.5;
      context.drawImage(baseImage, 0, 0, frame.width, frame.height);
      context.globalAlpha = 1;
    }
    // 形状区域：半透明白（黑底白遮罩的预览）
    shapes.forEach((shape, index) => {
      if (!shape.closed || shape.points.length < 3) return;
      traceMaskOutline(context!, shape.points, {
        closed: true,
        smooth: shapeIsSmooth(shape.kind),
      });
      context!.fillStyle = index === activeShape ? 'rgba(255,255,255,.45)' : 'rgba(255,255,255,.3)';
      context!.fill();
    });
    // 画笔层
    if (paint) {
      context.globalAlpha = 0.45;
      context.drawImage(paint, 0, 0, frame.width, frame.height);
      context.globalAlpha = 1;
    }
    // 圆 / 方拖拽中的预览框
    if (shapeDrag) {
      const preview = shapeDragPreview();
      if (preview) {
        traceMaskOutline(context, preview, { closed: true, smooth: shapeDrag?.kind === 'circle' });
        context.strokeStyle = 'rgba(94, 240, 110, .95)';
        context.lineWidth = Math.max(1.5, frame.width / 700);
        context.stroke();
      }
    }
    // 轮廓 + 控制点
    const lineWidth = Math.max(1.5, frame.width / 700);
    shapes.forEach((shape, index) => {
      if (shape.points.length < 2) return;
      const isActive = index === activeShape;
      traceMaskOutline(context!, shape.points, {
        closed: shape.closed,
        smooth: shapeIsSmooth(shape.kind),
      });
      context!.strokeStyle = isActive ? 'rgba(94, 240, 110, .95)' : 'rgba(94, 240, 110, .45)';
      context!.lineWidth = lineWidth;
      context!.stroke();
    });
    const size2d = Math.max(6, frame.width / 110);
    shapes.forEach((shape, index) => {
      const isActive = index === activeShape;
      shape.points.forEach((point, pointIndex) => {
        const isSelected = isActive && selected.includes(pointIndex);
        context!.beginPath();
        context!.rect(point.x - size2d / 2, point.y - size2d / 2, size2d, size2d);
        context!.fillStyle = isSelected ? '#ffffff' : isActive ? '#f5d642' : 'rgba(245,214,66,.55)';
        context!.fill();
        context!.strokeStyle = isSelected ? '#5ef06e' : 'rgba(12, 16, 20, .85)';
        context!.lineWidth = Math.max(1, size2d / 6);
        context!.stroke();
      });
    });
    // 羽化范围提示：只画一圈虚的外沿，不真的重算模糊（节点卡片预览里看得见真结果）
    if (feather > 0 && shapes[activeShape]?.points.length) {
      const blur = featherPixels(feather, frame.width);
      traceMaskOutline(context, shapes[activeShape].points, {
        closed: true,
        smooth: shapeIsSmooth(shapes[activeShape].kind),
      });
      context.setLineDash?.([6, 6]);
      context.strokeStyle = 'rgba(94, 234, 212, .5)';
      context.lineWidth = Math.max(1, blur);
      context.stroke();
      context.setLineDash?.([]);
    }
  };

  const shapeDragPreview = (): MaskPoint[] | null => {
    if (!shapeDrag) return null;
    const { from, to, kind } = shapeDrag;
    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2;
    if (kind === 'circle') {
      const radius = Math.max(2, Math.hypot(to.x - from.x, to.y - from.y) / 2);
      return circleShapePoints({ x: cx, y: cy }, radius, 16);
    }
    return boxShapePoints({ x: cx, y: cy }, Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  };

  /* ---------------- 加形状（Shift+A /「＋ 形状」） ---------------- */

  const addShape = (kind: MaskShapeKind, at?: MaskPoint): void => {
    const frame = size();
    const center = at ?? { x: frame.width / 2, y: frame.height / 2 };
    const radius = Math.min(frame.width, frame.height) * DEFAULT_SHAPE_DIAMETER * 0.5;
    // 形状函数只认「和半径同一单位」的坐标：这里编辑态统一用遮罩画布像素
    const points =
      kind === 'circle'
        ? circleShapePoints(center, radius, 8)
        : kind === 'box'
          ? boxShapePoints(center, radius * 2, radius * 2)
          : [];
    pushSnapshot();
    shapes = [...shapes, { kind, points, closed: kind !== 'spline' }];
    activeShape = shapes.length - 1;
    selected = [];
    if (kind === 'spline') {
      tool = 'select';
      options.toast('新样条：在预览上点几个点，按 F 连首尾闭合');
    } else {
      commitMask(false);
      tool = 'select';
      options.toast(
        `${kind === 'circle' ? '圆形' : '方形'}遮罩已加在${at ? '指针处' : '画面中心'} · G 移动 R 旋转 S 缩放`,
      );
    }
    syncLabels();
    render();
  };

  const shapeMenuItems = [
    { kind: 'circle' as const, label: '圆形遮罩', hint: '光滑的椭圆区域' },
    { kind: 'box' as const, label: '方形遮罩', hint: '四角硬边的矩形区域' },
    { kind: 'spline' as const, label: '自由样条', hint: '逐点画，F 闭合' },
  ];

  /**
   * Shift+A 的形状搜索菜单：和节点搜索用同一套 `.cg-menu` 外观与模糊匹配
   * （用户 2026-11-11：「可以直接在画布预览区域 shift+a 搜索添加形状」）。
   */
  const openShapeMenu = (): void => {
    closeShapeMenu();
    const frame = size();
    const surface = surfaceRect();
    const anchorClient = lastClient ?? {
      x: surface.left + surface.width / 2,
      y: surface.top + surface.height / 2,
    };
    const popup = document.createElement('div');
    popup.className = 'cg-menu cg-mask-menu';
    popup.style.left = `${clamp(anchorClient.x + 12, 8, Math.max(8, window.innerWidth - 232))}px`;
    popup.style.top = `${clamp(anchorClient.y + 12, 8, Math.max(8, window.innerHeight - 40))}px`;
    popup.style.width = '214px';
    const searchWrap = document.createElement('div');
    searchWrap.className = 'cg-menu-search';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = '搜索形状 · 圆 / 方 / 样条';
    input.setAttribute('aria-label', '搜索遮罩形状');
    searchWrap.append(input);
    const list = document.createElement('div');
    list.className = 'cg-menu-body';
    popup.append(searchWrap, list);
    document.body.append(popup);
    menu = popup;

    const pickPoint = (): MaskPoint => {
      if (!lastClient) return { x: frame.width / 2, y: frame.height / 2 };
      const rect = surfaceRect();
      const inside =
        lastClient.x >= rect.left - 1 &&
        lastClient.x <= rect.left + rect.width + 1 &&
        lastClient.y >= rect.top - 1 &&
        lastClient.y <= rect.top + rect.height + 1;
      return inside
        ? toFrame({ clientX: lastClient.x, clientY: lastClient.y })
        : { x: frame.width / 2, y: frame.height / 2 };
    };

    let hits = shapeMenuItems;
    let activeIndex = 0;
    const paintActive = (): void => {
      const items = list.querySelectorAll<HTMLElement>('.cg-menu-item');
      items.forEach((item) => item.classList.remove('cg-active'));
      items[Math.min(activeIndex, items.length - 1)]?.classList.add('cg-active');
    };
    const pick = (kind: MaskShapeKind): void => {
      closeShapeMenu();
      addShape(kind, pickPoint());
    };
    const renderMenu = (): void => {
      list.textContent = '';
      const query = input.value.trim();
      hits = query
        ? shapeMenuItems
            .map((item) => ({
              item,
              score: Math.max(
                fuzzyScore(query, item.label),
                fuzzyScore(query, item.hint),
                fuzzyScore(query, item.kind),
              ),
            }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((entry) => entry.item)
        : shapeMenuItems;
      activeIndex = Math.min(activeIndex, Math.max(0, hits.length - 1));
      if (!hits.length) {
        const empty = document.createElement('div');
        empty.className = 'cg-menu-empty';
        empty.textContent = '没有匹配的形状';
        list.append(empty);
        return;
      }
      hits.forEach((hit, index) => {
        const item = document.createElement('div');
        item.className = 'cg-menu-item';
        item.dataset.shape = hit.kind;
        const label = document.createElement('span');
        label.textContent = hit.label;
        item.append(label);
        if (query) {
          const hintEl = document.createElement('span');
          hintEl.className = 'cg-menu-hint';
          hintEl.textContent = hit.hint;
          item.append(hintEl);
        }
        item.addEventListener('pointerenter', () => {
          activeIndex = index;
          paintActive();
        });
        item.addEventListener('click', () => pick(hit.kind));
        list.append(item);
      });
      paintActive();
    };
    input.addEventListener('input', () => {
      activeIndex = 0;
      renderMenu();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        if (!hits.length) return;
        activeIndex =
          (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
        paintActive();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const hit = hits[activeIndex];
        if (hit) pick(hit.kind);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeShapeMenu();
      }
    });
    const onOutside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && popup.contains(target)) return;
      closeShapeMenu();
    };
    document.addEventListener('pointerdown', onOutside, true);
    const onWindowMove = (event: PointerEvent): void => {
      lastClient = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', onWindowMove, { passive: true });
    menuCleanup = () => {
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('pointermove', onWindowMove);
    };
    renderMenu();
    input.focus({ preventScroll: true });
    input.select?.();
  };

  const closeShapeMenu = (): void => {
    menuCleanup?.();
    menuCleanup = null;
    menu?.remove();
    menu = null;
  };

  /* ---------------- 控制点编辑（选择工具） ---------------- */

  const hitPoint = (point: MaskPoint): number => {
    const radius = screenRadius();
    let best = -1;
    let bestDistance = radius;
    shapes.forEach((shape, shapeIndex) => {
      shape.points.forEach((candidate, pointIndex) => {
        const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
        if (distance <= bestDistance) {
          best = shapeIndex * 10000 + pointIndex;
          bestDistance = distance;
        }
      });
    });
    return best;
  };

  const splitHit = (hit: number): { shape: number; point: number } => ({
    shape: Math.floor(hit / 10000),
    point: hit % 10000,
  });

  const activeIndices = (): number[] => {
    const points = activePoints();
    if (selected.length) return selected.filter((index) => index < points.length);
    return points.map((_point, index) => index);
  };

  const selectedCenter = (): MaskPoint => {
    const frame = size();
    const indices = activeIndices();
    const points = activePoints();
    if (!indices.length) return { x: frame.width / 2, y: frame.height / 2 };
    let sumX = 0;
    let sumY = 0;
    for (const index of indices) {
      sumX += points[index].x;
      sumY += points[index].y;
    }
    return { x: sumX / indices.length, y: sumY / indices.length };
  };

  const applyTransform = (pointer: MaskPoint): void => {
    if (!transform) return;
    const frame = size();
    const { mode, origin, startPoints, startPointer } = transform;
    const axis = transform.axis;
    let dx = pointer.x - startPointer.x;
    let dy = pointer.y - startPointer.y;
    if (axis === 'x') dy = 0;
    if (axis === 'y') dx = 0;
    const shape = shapes[activeShape];
    if (!shape) return;
    if (mode === 'move') {
      shape.points = startPoints.map((point) => ({
        x: clamp(point.x + dx, 0, frame.width),
        y: clamp(point.y + dy, 0, frame.height),
      }));
    } else if (mode === 'rotate') {
      const startAngle = Math.atan2(startPointer.y - origin.y, startPointer.x - origin.x);
      const nowAngle = Math.atan2(pointer.y - origin.y, pointer.x - origin.x);
      const delta = nowAngle - startAngle;
      const cos = Math.cos(delta);
      const sin = Math.sin(delta);
      shape.points = startPoints.map((point) => {
        const x = point.x - origin.x;
        const y = point.y - origin.y;
        return {
          x: clamp(origin.x + x * cos - y * sin, 0, frame.width),
          y: clamp(origin.y + x * sin + y * cos, 0, frame.height),
        };
      });
    } else {
      const startDistance = Math.hypot(startPointer.x - origin.x, startPointer.y - origin.y);
      const nowDistance = Math.hypot(pointer.x - origin.x, pointer.y - origin.y);
      let factor = startDistance > 0.5 ? nowDistance / startDistance : 1;
      factor = clamp(factor, 0.02, 40);
      const scaleX = axis === 'y' ? 1 : factor;
      const scaleY = axis === 'x' ? 1 : factor;
      shape.points = startPoints.map((point) => ({
        x: clamp(origin.x + (point.x - origin.x) * scaleX, 0, frame.width),
        y: clamp(origin.y + (point.y - origin.y) * scaleY, 0, frame.height),
      }));
    }
  };

  const startTransform = (mode: 'move' | 'rotate' | 'scale'): void => {
    const frame = size();
    const points = activePoints();
    if (!points.length) {
      options.toast('没有控制点：先用左键点几下，或 Shift+A 加个圆/方', true);
      return;
    }
    transform = {
      mode,
      origin: selectedCenter(),
      startPoints: points.map((point) => ({ ...point })),
      startPointer: lastPointer ?? { x: frame.width / 2, y: frame.height / 2 },
      axis: null,
    };
    render();
    options.toast(
      mode === 'move'
        ? '移动：拖动鼠标 · X/Y 锁轴 · 左键/回车确认'
        : mode === 'rotate'
          ? '旋转：拖动鼠标 · 左键/回车确认'
          : '缩放：拖动鼠标 · X/Y 只缩一个方向 · 左键/回车确认',
    );
  };

  const removeSelected = (): void => {
    const shape = shapes[activeShape];
    if (!shape) return;
    const indices = selected.filter((index) => index < shape.points.length);
    if (!indices.length) return;
    pushSnapshot();
    shape.points = shape.points.filter((_point, index) => !indices.includes(index));
    selected = [];
    if (shape.points.length < 3) shape.closed = false;
    commitMask(false);
    render();
  };

  const extrudePoint = (): void => {
    const shape = shapes[activeShape];
    if (!shape || !shape.points.length) return;
    const indices = activeIndices();
    const from = indices.length ? indices[indices.length - 1] : shape.points.length - 1;
    const previous = shape.points[(from - 1 + shape.points.length) % shape.points.length];
    const base = shape.points[from];
    const frame = size();
    const dx = base.x - previous.x;
    const dy = base.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    const step = Math.max(24, Math.min(frame.width, frame.height) * 0.04);
    pushSnapshot();
    shape.points = [
      ...shape.points.slice(0, from + 1),
      {
        x: clamp(base.x + (dx / length) * step, 0, frame.width),
        y: clamp(base.y + (dy / length) * step, 0, frame.height),
      },
      ...shape.points.slice(from + 1),
    ];
    selected = [from + 1];
    commitMask(false);
    render();
  };

  const mergeSelected = (): void => {
    const shape = shapes[activeShape];
    if (!shape) return;
    const indices = activeIndices();
    if (indices.length < 2) {
      options.toast('合并需要至少选中两个控制点', true);
      return;
    }
    pushSnapshot();
    const center = selectedCenter();
    const first = indices[0];
    const kept = shape.points.filter((_point, index) => !indices.includes(index));
    kept.splice(Math.min(first, kept.length), 0, center);
    shape.points = kept;
    selected = [Math.min(first, kept.length - 1)];
    if (kept.length < 3) shape.closed = false;
    commitMask(false);
    render();
  };

  const closeSpline = (): void => {
    const shape = shapes[activeShape];
    if (!shape || shape.closed || shape.points.length < 3) return;
    pushSnapshot();
    shape.closed = true;
    commitMask(false);
    render();
  };

  /* ---------------- 指针 ---------------- */

  const onPointerDown = (event: PointerEvent): void => {
    if (!active) return;
    if (event.button === 1) return; // 中键交给上面的预览平移
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    lastClient = { x: event.clientX, y: event.clientY };
    lastPointer = toFrame(event);
    const point = lastPointer;

    if (transform) {
      // 变换中左键 = 确认（这一下不再加点）
      if (event.button === 0) {
        transform = null;
        commitMask(false);
        render();
      } else {
        transform = null;
        render();
      }
      return;
    }

    if (tool === 'brush') {
      const value = event.button === 2 ? luminance(background) : luminance(foreground);
      beginStroke(point, value);
      try {
        canvas.setPointerCapture?.(event.pointerId);
      } catch {
        /* 合成事件里 pointerId 往往不活跃 */
      }
      return;
    }

    if (tool === 'circle' || tool === 'box') {
      shapeDrag = { from: point, to: point, kind: tool };
      try {
        canvas.setPointerCapture?.(event.pointerId);
      } catch {
        /* 同上 */
      }
      render();
      return;
    }

    // 选择工具
    if (event.button === 2) {
      if (selected.length) {
        selected = [];
        render();
      }
      return;
    }
    const hit = hitPoint(point);
    if (hit >= 0) {
      const target = splitHit(hit);
      activeShape = target.shape;
      if (event.shiftKey) {
        selected = selected.includes(target.point)
          ? selected.filter((index) => index !== target.point)
          : [...selected, target.point];
      } else if (!selected.includes(target.point)) {
        selected = [target.point];
      }
      dragPoint = target.point;
      render();
      try {
        canvas.setPointerCapture?.(event.pointerId);
      } catch {
        /* 同上 */
      }
      return;
    }
    if (event.shiftKey) {
      selected = [];
      render();
      return;
    }
    // 空白处左键 = 在当前形状上加一个点
    const shape = ensureShape('spline');
    pushSnapshot();
    shape.points = [...shape.points, point];
    selected = [shape.points.length - 1];
    dragPoint = shape.points.length - 1;
    commitMask(false);
    render();
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      /* 同上 */
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!active) return;
    lastClient = { x: event.clientX, y: event.clientY };
    lastPointer = toFrame(event);
    if (stroke) {
      event.stopPropagation();
      moveStroke(lastPointer);
      return;
    }
    if (shapeDrag) {
      shapeDrag.to = lastPointer;
      render();
      return;
    }
    if (transform) {
      applyTransform(lastPointer);
      render();
      return;
    }
    if (dragPoint < 0) return;
    const shape = shapes[activeShape];
    if (!shape || dragPoint >= shape.points.length) return;
    const frame = size();
    shape.points[dragPoint] = {
      x: clamp(lastPointer.x, 0, frame.width),
      y: clamp(lastPointer.y, 0, frame.height),
    };
    render();
  };

  const onPointerUp = (): void => {
    if (!active) return;
    if (stroke) {
      endStroke();
      return;
    }
    if (shapeDrag) {
      const preview = shapeDragPreview();
      const frame = size();
      const { from, to, kind } = shapeDrag;
      const dragged = Math.hypot(to.x - from.x, to.y - from.y) > 6;
      shapeDrag = null;
      if (preview && preview.length >= 3) {
        pushSnapshot();
        shapes = [...shapes, { kind, points: preview, closed: true }];
        activeShape = shapes.length - 1;
        selected = [];
        // 拖出来的形状：落笔即写回；点一下（没拖动）走默认大小
        if (dragged) {
          commitMask(false);
        } else {
          shapes = shapes.slice(0, -1);
          addShape(kind, { x: from.x, y: from.y });
        }
        tool = 'select';
        syncLabels();
      }
      render();
      return;
    }
    if (dragPoint >= 0) {
      dragPoint = -1;
      commitMask(false);
    }
  };

  /* ---------------- 键盘 ---------------- */

  const handleKey = (event: KeyboardEvent): boolean => {
    if (!active) return false;
    const key = event.key.toLowerCase();
    if (menu) {
      // 菜单自己处理键（输入框里上下键/回车/Esc），这里不再抢
      return false;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      event.stopPropagation();
      if (!undo()) options.toast('没有可撤销的遮罩操作', true);
      return true;
    }
    if (transform) {
      if (key === 'x' || key === 'y') {
        event.preventDefault();
        event.stopPropagation();
        transform.axis = transform.axis === key ? null : key;
        applyTransform(transform.startPointer);
        render();
        return true;
      }
      if (event.key === 'Enter' || key === 's') {
        event.preventDefault();
        event.stopPropagation();
        transform = null;
        commitMask(false);
        render();
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        const shape = shapes[activeShape];
        if (shape) shape.points = transform.startPoints.map((point) => ({ ...point }));
        transform = null;
        render();
        return true;
      }
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (tool !== 'select') {
        setTool('select');
        return true;
      }
      options.exit();
      return true;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      if (key === 'a' && event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        selected = [];
        render();
        return true;
      }
      return false;
    }
    if (key === 'a' && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      openShapeMenu();
      return true;
    }
    if (key === 'b') {
      event.preventDefault();
      event.stopPropagation();
      setTool('brush');
      return true;
    }
    if (key === 'v') {
      event.preventDefault();
      event.stopPropagation();
      setTool('select');
      return true;
    }
    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      event.stopPropagation();
      brushSize = clamp(brushSize + (event.key === ']' ? 0.01 : -0.01), 0.01, 0.4);
      brushInput.value = String(Math.round(brushSize * 100));
      syncLabels();
      return true;
    }
    if (key === 'a') {
      event.preventDefault();
      event.stopPropagation();
      selected = activePoints().map((_point, index) => index);
      render();
      return true;
    }
    if (key === 'g' || key === 'r' || key === 's') {
      event.preventDefault();
      event.stopPropagation();
      startTransform(key === 'g' ? 'move' : key === 'r' ? 'rotate' : 'scale');
      return true;
    }
    if (key === 'x' || event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      if (selected.length) removeSelected();
      else options.toast('先点选控制点，再按 X 删除', true);
      return true;
    }
    if (key === 'e') {
      event.preventDefault();
      event.stopPropagation();
      extrudePoint();
      return true;
    }
    if (key === 'm') {
      event.preventDefault();
      event.stopPropagation();
      mergeSelected();
      return true;
    }
    if (key === 'f') {
      event.preventDefault();
      event.stopPropagation();
      closeSpline();
      return true;
    }
    return false;
  };

  /* ---------------- 生命周期 ---------------- */

  const loadMask = (): void => {
    const mask = options.mask();
    if (!mask) return;
    currentMask = mask;
    const frame = size();
    shapes = mask.shapes.map((shape) => ({
      kind: shape.kind,
      closed: shape.closed,
      points: splineFromParam(shape.points).map((point) => ({
        x: point.x * frame.width,
        y: point.y * frame.height,
      })),
    }));
    activeShape = 0;
    selected = [];
    feather = mask.feather;
    paint = null;
    paintReady = !mask.paint;
    syncLabels();
    if (mask.paint) {
      void decodeMaskPaint(mask).then((decoded) => {
        if (!active) return;
        if (decoded) {
          // 历史画笔层尺寸可能和当前帧不同：按当前帧重采样一次
          const layer = createPaintCanvas();
          layer.getContext('2d')?.drawImage(decoded, 0, 0, frame.width, frame.height);
          paint = layer;
        } else {
          paint = createPaintCanvas();
        }
        paintReady = true;
        render();
      });
    }
    render();
  };

  const activate = (): void => {
    if (active) return;
    active = true;
    canvas.style.display = 'block';
    canvas.classList.add('cg-mask-canvas-active');
    loadBaseImage();
    loadMask();
  };

  const loadBaseImage = (): void => {
    const url = options.baseImageUrl();
    baseImage = null;
    if (!url) return;
    const image = new Image();
    image.onload = () => render();
    image.src = url;
    baseImage = image;
  };

  /** 换了一份遮罩（下拉切遮罩 / 换节点）：重新读形状、画笔层与底图。 */
  const reload = (): void => {
    if (!active) return;
    cancelTransient();
    selected = [];
    snapshots.length = 0;
    loadBaseImage();
    loadMask();
  };

  const deactivate = (): void => {
    if (!active) return;
    // 还没松手的动作先收尾（不然切回预览后形状/笔画会丢一半）
    if (dragPoint >= 0) {
      dragPoint = -1;
      commitMask(false);
    }
    if (stroke) endStroke();
    if (shapeDrag) {
      shapeDrag = null;
      render();
    }
    active = false;
    transform = null;
    cancelTransient();
    closeShapeMenu();
    canvas.classList.remove('cg-mask-canvas-active');
    canvas.style.display = 'none';
  };

  const destroy = (): void => {
    deactivate();
    element.remove();
    closeShapeMenu();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('contextmenu', (event) => {
    if (active) event.preventDefault();
  });

  syncLabels();
  canvas.style.display = 'none';

  return {
    element,
    activate,
    deactivate,
    reload,
    render,
    handleKey,
    state: () => ({
      tool,
      shapes: shapes.length,
      activeShape,
      points: activePoints().length,
      closed: shapes[activeShape]?.closed === true,
      selected: selected.length,
      strokes,
      paintReady,
      feather,
      brushSize,
      foreground,
      background,
    }),
    destroy,
  };
}
