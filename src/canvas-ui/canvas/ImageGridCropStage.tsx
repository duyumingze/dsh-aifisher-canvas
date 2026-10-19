/**
 * 宫格裁剪舞台（shadcn nova 版，v1.46）。
 *
 * 与上游 `dialogs/canvasImageCrop.tsx`（variant='grid'）的关系：
 *   - **几何、切线与像素全部复用**上游纯函数：`centeredCrop` / `createCrop` /
 *     `resizeCrop` / `moveCrop` / `hitCrop` / `cropHandles` / `cropOutputRects` /
 *     `equalCuts` / `moveCropCut`（切线拖动的最小间距也在上游函数里），出口逐像素一致
 *     （宫格每块先铺白底再画图，与上游同一条分支）；
 *   - 输出顺序 / 导出序号仍走 `dialogs/gridExport.ts` 的 `gridExportIndices`
 *     （逐行 / 逐列 / 蛇形 / 倒序、`1,3,5-8` 语法与错误文案都没变）；
 *   - 外观换成与裁剪舞台（ImageCropStage）同一套 nova 工作台：header / toolbar / stage /
 *     footer 四段，工具条里换掉上游那圈「胶囊里塞 fieldset + 原生 select」。
 *
 * 为什么它现在是独立舞台：v1.26 换图片编辑族时，宫格裁剪（连同全景 / 角度）整棵交回
 * vendor 的 `Components.ImageCrop`。到 v1.46 用户指出「画布宫格裁剪 ui 还没有更新」——
 * 宫格是唯一还在用旧外观、且日常真的会点的模式（全景球与角度草稿依赖 three.js，继续留给上游）。
 *
 * 交互契约（回归 / 真机检查依赖）：
 *   - 根 `role="dialog"` + `aria-label="宫格裁剪"` + `data-fisherai-image-workbench="grid"`；
 *   - 选区画布 `data-fisherai-crop-canvas`（aria-label「宫格裁剪选择区域」）；
 *   - 预设 `data-fisherai-grid-crop-preset="2x2|3x3|3x4|4x3|1x4|4x1"` + `aria-pressed`；
 *   - 行列读数 `data-fisherai-grid-crop-columns` / `-rows`（带 data-fisherai-grid-crop-value）；
 *   - 间隙滑杆 `data-fisherai-grid-crop-row-gap` / `-column-gap`（shadcn Slider）；
 *   - 比例 `data-fisherai-grid-crop-ratio="Original|Free|1:1|…"` + `aria-pressed`；
 *   - 导出顺序 `data-fisherai-grid-crop-order="row|column|snake|reverse"` + `aria-pressed`；
 *   - 导出序号输入 `data-fisherai-grid-crop-selection`（aria-label「导出格子序号」）；
 *   - 张数读数 `data-fisherai-grid-crop-count`；保存 `data-fisherai-image-save="grid"`；
 *   - 状态行 `data-fisherai-image-status`。
 *
 * ⚠️ hooks 一律用 `ReactTypes`（与 ImageCropStage 同一份），别用 props 里的 react；
 *    hook 也不能放到「!node return null」之后（见 docs/canvas-ui-shadcn.md 第 0/1 条）。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import {
  Check as CheckIcon,
  Columns3 as ColumnsIcon,
  Grid2X2 as GridIcon,
  LoaderCircle as LoaderCircleIcon,
  Minus as MinusIcon,
  Plus as PlusIcon,
  RotateCcw as RotateCcwIcon,
  Rows3 as RowsIcon,
  X as XIcon,
} from 'lucide-react';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Slider } from '@/ui/slider';
import { cn } from '@/lib/utils';
import { activateModal } from '../../../vendor/aifisher/src/stable/design/modalFocus';
import {
  cropOutputRects,
  equalCuts,
  moveCropCut,
} from '../../../vendor/aifisher/src/stable/dialogs/imageCropGeometry';
import {
  gridExportIndices,
  type GridOrder,
} from '../../../vendor/aifisher/src/stable/dialogs/gridExport';
import {
  cropGeometry,
  exportGridPieces,
  fitInside,
  loadWorkbenchImage,
  sizeLabel,
  WORKBENCH_DIVIDER_CLASS,
  WORKBENCH_FOOTER_CLASS,
  WORKBENCH_HEADER_CLASS,
  WORKBENCH_HINT_CLASS,
  WORKBENCH_ROOT_CLASS,
  WORKBENCH_STAGE_CLASS,
  WORKBENCH_TOOLBAR_CLASS,
  type WorkbenchHandle,
  type WorkbenchOutput,
  type WorkbenchRect,
  type WorkbenchSize,
} from './imageWorkbench';
import { useCanvasOverlayBox } from './imageWorkbenchOverlay';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'useState'
  | 'useRef'
  | 'useEffect'
  | 'useLayoutEffect'
  | 'useCallback'
  | 'useMemo'
>;

export interface GridCropStageProps {
  node?: { id: string; resultUrl?: string; title?: string };
  onSave(
    id: string,
    outputs: WorkbenchOutput[],
    progress: (completed: number) => void,
  ): unknown | Promise<unknown>;
  onClose(): void;
}

/** 上游那 6 个预设（注意 value 是「列 × 行」，与上游 `setRows(lines) / setColumns(cols)` 一致）。 */
const PRESETS: Array<{ id: string; columns: number; rows: number }> = [
  { id: '2x2', columns: 2, rows: 2 },
  { id: '3x3', columns: 3, rows: 3 },
  { id: '3x4', columns: 3, rows: 4 },
  { id: '4x3', columns: 4, rows: 3 },
  { id: '1x4', columns: 1, rows: 4 },
  { id: '4x1', columns: 4, rows: 1 },
];

const ORDERS: Array<{ value: GridOrder; label: string }> = [
  { value: 'row', label: '逐行' },
  { value: 'column', label: '逐列' },
  { value: 'snake', label: '蛇形' },
  { value: 'reverse', label: '倒序' },
];

const RATIOS: Array<{ value: string; label: string }> = [
  { value: 'Original', label: '原图' },
  { value: 'Free', label: '自由' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
];

/** 把手 / 移动 / 新建选区，外加宫格特有的两种切线拖动。 */
type GridGestureKind = WorkbenchHandle | 'move' | 'create' | 'row' | 'column';

/** 出口矩形（源图像素；与 `cropOutputRects` 的返回同形）。 */
type GridPieces = ReturnType<typeof cropOutputRects>;

interface Gesture {
  id: number;
  start: { x: number; y: number };
  rect: WorkbenchRect;
  kind: GridGestureKind;
  index?: number;
}

const MIN_ROWS = 1;
const MAX_ROWS = 5;

function clampCount(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.round(value) : min));
}

export function ImageGridCropStage(react: Runtime, props: GridCropStageProps) {
  const h = createElement(react);
  const overlay = useCanvasOverlayBox(react);
  const rootRef = react.useRef<HTMLDivElement>(null);
  const stageRef = react.useRef<HTMLDivElement>(null);
  const canvasRef = react.useRef<HTMLCanvasElement>(null);
  const imageRef = react.useRef<HTMLImageElement | null>(null);
  const displayRef = react.useRef<WorkbenchSize>({ width: 0, height: 0 });
  const cropRef = react.useRef<WorkbenchRect | null>(null);
  const gestureRef = react.useRef<Gesture | null>(null);
  const sessionRef = react.useRef(0);
  const savingRef = react.useRef(false);
  const closeRef = react.useRef(props.onClose);
  react.useLayoutEffect(() => {
    closeRef.current = props.onClose;
  }, [props.onClose]);

  const [display, setDisplay] = react.useState<WorkbenchSize>({ width: 0, height: 0 });
  const [crop, setCrop] = react.useState<WorkbenchRect | null>(null);
  const [hover, setHover] = react.useState<{ kind: GridGestureKind; index?: number } | null>(null);
  const [ratioLabel, setRatioLabel] = react.useState('Original');
  const [loaded, setLoaded] = react.useState(false);
  const [saving, setSaving] = react.useState(false);
  const [error, setError] = react.useState('');
  const [progress, setProgress] = react.useState(0);
  const [rows, setRows] = react.useState(2);
  const [columns, setColumns] = react.useState(2);
  const [rowCuts, setRowCuts] = react.useState<number[]>(() => equalCuts(2));
  const [columnCuts, setColumnCuts] = react.useState<number[]>(() => equalCuts(2));
  const [rowGap, setRowGap] = react.useState(0);
  const [columnGap, setColumnGap] = react.useState(0);
  const [order, setOrder] = react.useState<GridOrder>('row');
  const [exportSelection, setExportSelection] = react.useState('');

  const updateCrop = (next: WorkbenchRect | null) => {
    cropRef.current = next;
    setCrop(next);
  };
  const source = imageRef.current
    ? { width: imageRef.current.naturalWidth, height: imageRef.current.naturalHeight }
    : display;
  const ratio = source.width ? cropGeometry.cropRatio(ratioLabel, source) : 1;
  const grid = rows > 1 || columns > 1;

  react.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return activateModal(root, () => closeRef.current());
  }, []);

  /**
   * 图片在舞台里等比显示。
   *
   * 差异点（与 ImageCropStage 比）：宫格裁剪一打开就**铺满整张原图**
   * （上游默认 1×1 + 居中 80% 选区，用户还得先挑预设才看得到格子）。
   * 窗口缩放时仍按比例跟随已有的选区。
   */
  const fit = react.useCallback(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image) return;
    const width = stage.clientWidth || window.innerWidth;
    const height = stage.clientHeight || window.innerHeight;
    const next = fitInside(
      { width: image.naturalWidth, height: image.naturalHeight },
      { width, height },
    );
    const previous = displayRef.current;
    const current = cropRef.current;
    const nextCrop =
      current && previous.width > 0
        ? {
            x: (current.x * next.width) / previous.width,
            y: (current.y * next.height) / previous.height,
            width: (current.width * next.width) / previous.width,
            height: (current.height * next.height) / previous.height,
          }
        : { x: 0, y: 0, width: next.width, height: next.height };
    displayRef.current = next;
    cropRef.current = nextCrop;
    setDisplay(next);
    setCrop(nextCrop);
  }, []);

  const id = props.node?.id ?? '';
  const url = props.node?.resultUrl ?? '';
  react.useEffect(() => {
    const session = ++sessionRef.current;
    savingRef.current = false;
    imageRef.current = null;
    gestureRef.current = null;
    cropRef.current = null;
    displayRef.current = { width: 0, height: 0 };
    setLoaded(false);
    setSaving(false);
    setError('');
    setProgress(0);
    setDisplay({ width: 0, height: 0 });
    setCrop(null);
    setHover(null);
    setRatioLabel('Original');
    setRows(2);
    setColumns(2);
    setRowCuts(equalCuts(2));
    setColumnCuts(equalCuts(2));
    setRowGap(0);
    setColumnGap(0);
    setOrder('row');
    setExportSelection('');
    if (!id || !url) {
      setError('这张图片没有可编辑的地址，请重新生成或上传后再试。');
      return;
    }
    loadWorkbenchImage(url)
      .then((image) => {
        if (sessionRef.current !== session) return;
        imageRef.current = image;
        setLoaded(true);
        setError('');
        fit();
      })
      .catch((cause: unknown) => {
        if (sessionRef.current !== session) return;
        setError(cause instanceof Error ? cause.message : '图片加载失败。');
      });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    if (stageRef.current) observer?.observe(stageRef.current);
    window.addEventListener('resize', fit);
    return () => {
      sessionRef.current = session + 1;
      window.removeEventListener('resize', fit);
      observer?.disconnect();
    };
  }, [id, url, fit]);

  /** 每个格子的出口矩形（源图像素），用于校验、编号、底栏读数与画布叠加层。 */
  const selection = react.useMemo(() => {
    if (!crop || !display.width)
      return { pieces: null as GridPieces | null, error: '' };
    try {
      return {
        pieces: cropOutputRects(crop, display, source, rowCuts, columnCuts, rowGap, columnGap),
        error: '',
      };
    } catch {
      return { pieces: null, error: '裁切范围太小，无法为每个分块保留至少一个像素。' };
    }
  }, [crop, display, source.width, source.height, rowCuts, columnCuts, rowGap, columnGap]);

  /** 导出序号解析（非法就禁用保存，并把原因写在状态行）。 */
  const exportPlan = react.useMemo(() => {
    try {
      return { indices: gridExportIndices(rows, columns, order, exportSelection), error: '' };
    } catch (cause) {
      return {
        indices: [] as number[],
        error: cause instanceof Error ? cause.message : '导出序号无效',
      };
    }
  }, [rows, columns, order, exportSelection]);

  const invalidSelection = selection.error || exportPlan.error;
  const total = rows * columns;
  const selectedCount = exportPlan.indices.length;

  react.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const rect = crop;
    if (!canvas || !rect || !display.width) return;
    canvas.width = Math.max(1, Math.round(display.width));
    canvas.height = Math.max(1, Math.round(display.height));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    // 选区外压暗（与裁剪舞台同一套：整块半透明黑，再把选区抠亮）
    context.fillStyle = 'rgba(0,0,0,.62)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.clearRect(rect.x, rect.y, rect.width, rect.height);

    const scaleX = display.width / (source.width || display.width || 1);
    const scaleY = display.height / (source.height || display.height || 1);
    const pieces = selection.pieces;

    // 间隙（被切掉的那一条）用淡红铺出来 —— 与上游同一套语义，只是透明度更低
    if (pieces && grid) {
      context.fillStyle = 'rgba(239,68,68,.16)';
      for (let index = 1; index < pieces.columns.length; index += 1) {
        const previous = pieces.columns[index - 1];
        const start = (previous.start + previous.size) * scaleX;
        const end = pieces.columns[index].start * scaleX;
        if (end > start)
          context.fillRect(
            start,
            rect.y,
            Math.max(1, end - start),
            rect.height,
          );
      }
      for (let index = 1; index < pieces.rows.length; index += 1) {
        const previous = pieces.rows[index - 1];
        const start = (previous.start + previous.size) * scaleY;
        const end = pieces.rows[index].start * scaleY;
        if (end > start)
          context.fillRect(
            rect.x,
            start,
            rect.width,
            Math.max(1, end - start),
          );
      }
    }

    // 选区边框
    context.strokeStyle = '#60a5fa';
    context.lineWidth = 1.5;
    context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);

    if (pieces && grid) {
      // 每格边框（细白线）+ 序号（左下角，避开把手与切线）
      context.strokeStyle = 'rgba(255,255,255,.4)';
      context.lineWidth = 1;
      for (const row of pieces.rows)
        for (const column of pieces.columns) {
          const x = Math.round(column.start * scaleX) + 0.5;
          const y = Math.round(row.start * scaleY) + 0.5;
          context.strokeRect(x, y, Math.round(column.size * scaleX), Math.round(row.size * scaleY));
        }
      context.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.textBaseline = 'top';
      for (let rowIndex = 0; rowIndex < pieces.rows.length; rowIndex += 1)
        for (let columnIndex = 0; columnIndex < pieces.columns.length; columnIndex += 1) {
          const cell = pieces.rows[rowIndex];
          const horizontal = pieces.columns[columnIndex];
          const label = String(rowIndex * columns + columnIndex + 1);
          const x = horizontal.start * scaleX + 7;
          const y = cell.start * scaleY + 7;
          context.fillStyle = 'rgba(0,0,0,.55)';
          const width = context.measureText(label).width;
          context.fillRect(x - 3, y - 1, width + 6, 15);
          context.fillStyle = '#f8fafc';
          context.fillText(label, x, y);
        }
      // 当前拖动的切线高亮（其余切线用亮白细线，与格子边框区分开）
      for (const [index, cut] of columnCuts.entries()) {
        const active = hover?.kind === 'column' && hover.index === index;
        context.strokeStyle = active ? '#60a5fa' : 'rgba(255,255,255,.78)';
        context.lineWidth = active ? 2.5 : 1.5;
        const x = rect.x + rect.width * cut;
        context.beginPath();
        context.moveTo(x, rect.y);
        context.lineTo(x, rect.y + rect.height);
        context.stroke();
      }
      for (const [index, cut] of rowCuts.entries()) {
        const active = hover?.kind === 'row' && hover.index === index;
        context.strokeStyle = active ? '#60a5fa' : 'rgba(255,255,255,.78)';
        context.lineWidth = active ? 2.5 : 1.5;
        const y = rect.y + rect.height * cut;
        context.beginPath();
        context.moveTo(rect.x, y);
        context.lineTo(rect.x + rect.width, y);
        context.stroke();
      }
    } else {
      // 没有行列切线时给三分参考线（与裁剪舞台一致，方便单格取景）
      context.strokeStyle = 'rgba(255,255,255,.32)';
      context.lineWidth = 1;
      for (const part of [1 / 3, 2 / 3]) {
        context.beginPath();
        context.moveTo(rect.x + rect.width * part, rect.y);
        context.lineTo(rect.x + rect.width * part, rect.y + rect.height);
        context.moveTo(rect.x, rect.y + rect.height * part);
        context.lineTo(rect.x + rect.width, rect.y + rect.height * part);
        context.stroke();
      }
    }

    // 8 个把手（hover 放大，与裁剪舞台同款手感）
    for (const handle of cropGeometry.cropHandles(rect)) {
      context.beginPath();
      context.arc(handle.x, handle.y, hover?.kind === handle.id ? 7 : 5, 0, Math.PI * 2);
      context.fillStyle = '#f2f2f2';
      context.fill();
      context.strokeStyle = '#0b0b0b';
      context.lineWidth = 1.5;
      context.stroke();
    }
    context.restore();
  }, [
    crop,
    display,
    hover,
    rows,
    columns,
    rowCuts,
    columnCuts,
    rowGap,
    columnGap,
    grid,
    source.width,
    source.height,
    selection,
  ]);

  const location = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(display.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(display.height, event.clientY - bounds.top)),
    };
  };

  /** 先判切线（10px 命中带，与上游一致），再判把手 / 内部移动 / 新建。 */
  const hit = (point: { x: number; y: number }): { kind: GridGestureKind; index?: number } => {
    const current = cropRef.current;
    if (!current) return { kind: 'create' };
    if (grid) {
      const column = columnCuts.findIndex(
        (cut) =>
          Math.abs(point.x - (current.x + current.width * cut)) <= 10 &&
          point.y >= current.y &&
          point.y <= current.y + current.height,
      );
      if (column >= 0) return { kind: 'column', index: column };
      const row = rowCuts.findIndex(
        (cut) =>
          Math.abs(point.y - (current.y + current.height * cut)) <= 10 &&
          point.x >= current.x &&
          point.x <= current.x + current.width,
      );
      if (row >= 0) return { kind: 'row', index: row };
    }
    return { kind: (cropGeometry.hitCrop(current, point) as GridGestureKind | null) ?? 'create' };
  };

  const pointerDown = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    if (!loaded || savingRef.current || event.button !== 0 || gestureRef.current) return;
    const start = location(event);
    const action = hit(start);
    gestureRef.current = {
      id: event.pointerId,
      start,
      rect: cropRef.current ?? { ...start, width: 0, height: 0 },
      kind: action.kind,
      index: action.index,
    };
    if (action.kind === 'create') updateCrop({ ...start, width: 0, height: 0 });
    try {
      // 合成事件（真机脚本派发的 PointerEvent）没有真实指针，捕获会抛 NotFoundError
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointer: ignore */
    }
  };

  const pointerMove = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    const point = location(event);
    const gesture = gestureRef.current;
    if (!gesture) {
      const action = hit(point);
      setHover(action.kind === 'create' ? null : action);
      return;
    }
    if (gesture.id !== event.pointerId) return;
    if (gesture.kind === 'column')
      setColumnCuts((old) =>
        moveCropCut(
          old,
          gesture.index ?? 0,
          (point.x - gesture.rect.x) / (gesture.rect.width || 1),
          gesture.rect.width,
        ),
      );
    else if (gesture.kind === 'row')
      setRowCuts((old) =>
        moveCropCut(
          old,
          gesture.index ?? 0,
          (point.y - gesture.rect.y) / (gesture.rect.height || 1),
          gesture.rect.height,
        ),
      );
    else if (gesture.kind === 'move')
      updateCrop(
        cropGeometry.moveCrop(
          gesture.rect,
          { x: point.x - gesture.start.x, y: point.y - gesture.start.y },
          display,
        ),
      );
    else if (gesture.kind === 'create')
      updateCrop(cropGeometry.createCrop(gesture.start, point, display, ratio));
    else updateCrop(cropGeometry.resizeCrop(gesture.rect, gesture.kind, point, display, ratio));
  };

  const pointerUp = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    if (gestureRef.current?.id !== event.pointerId) return;
    if (event.type === 'pointerup') pointerMove(event);
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /** 改行列数 = 重新等分 + 选区铺满原图（与上游 `restoreGrid` 一致）。 */
  const restoreEqual = (nextRows = rows, nextColumns = columns) => {
    if (savingRef.current) return;
    const safeRows = clampCount(nextRows, MIN_ROWS, MAX_ROWS);
    const safeColumns = clampCount(nextColumns, MIN_ROWS, MAX_ROWS);
    setRows(safeRows);
    setColumns(safeColumns);
    setRowCuts(equalCuts(safeRows));
    setColumnCuts(equalCuts(safeColumns));
    setRowGap(0);
    setColumnGap(0);
    setRatioLabel('Original');
    const size = displayRef.current;
    updateCrop({ x: 0, y: 0, width: size.width, height: size.height });
  };

  const choosePreset = (preset: { columns: number; rows: number }) => {
    if (savingRef.current) return;
    setExportSelection('');
    restoreEqual(preset.rows, preset.columns);
  };

  const selectRatio = (label: string) => {
    if (savingRef.current) return;
    setRatioLabel(label);
    if (label !== 'Free')
      updateCrop(cropGeometry.centeredCrop(display, cropGeometry.cropRatio(label, source)));
  };

  const saveGrid = async () => {
    const image = imageRef.current;
    const rect = cropRef.current;
    if (!image || !rect || savingRef.current || gestureRef.current) return;
    if (rect.width <= 0 || rect.height <= 0) {
      setError('裁切范围太小，请重新框选。');
      return;
    }
    if (invalidSelection) {
      setError(invalidSelection);
      return;
    }
    const session = sessionRef.current;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setProgress(0);
    try {
      const pieces = exportGridPieces(
        image,
        rect,
        displayRef.current,
        { width: image.naturalWidth, height: image.naturalHeight },
        { rowCuts, columnCuts, rowGap, columnGap },
        grid,
      );
      if (sessionRef.current !== session) return;
      const ordered = exportPlan.indices.map((index) => pieces[index]).filter(Boolean);
      if (!ordered.length) throw new Error('没有要导出的格子，请检查导出序号。');
      await props.onSave(id, ordered, (completed) => {
        if (sessionRef.current === session) setProgress(completed);
      });
      if (sessionRef.current === session) props.onClose();
    } catch (cause) {
      if (sessionRef.current === session)
        setError(cause instanceof Error ? cause.message : '宫格裁剪保存失败，请重试。');
    } finally {
      if (sessionRef.current === session) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  // ⚠️ hook 全部写在这行之前（见 docs/canvas-ui-shadcn.md 第 0 条）
  if (!props.node) return null;

  const single = selection.pieces
    ? {
        width: selection.pieces.columns[0]?.size ?? 0,
        height: selection.pieces.rows[0]?.size ?? 0,
      }
    : null;
  const cursor =
    hover?.kind === 'column'
      ? 'col-resize'
      : hover?.kind === 'row'
        ? 'row-resize'
        : hover?.kind === 'move'
          ? 'move'
          : hover?.kind
            ? 'pointer'
            : 'crosshair';
  const savingLabel = saving ? `导出 ${progress}/${selectedCount || total}` : `保存 ${selectedCount} 张`;

  const header = h(
    'header',
    { className: WORKBENCH_HEADER_CLASS },
    h('span', { className: 'flex items-center gap-1.5 text-[13px] font-medium' },
      h(GridIcon, { className: 'size-3.5 text-muted-foreground' }),
      '宫格裁剪',
    ),
    h(
      'span',
      { className: WORKBENCH_HINT_CLASS },
      `${columns} 列 × ${rows} 行 · 共 ${total} 格`,
    ),
    h('div', { className: 'min-w-0 flex-1' }),
    h(
      Button,
      {
        type: 'button',
        size: 'sm',
        'aria-label': '保存宫格裁剪',
        'data-fisherai-image-save': 'grid',
        disabled:
          saving ||
          !loaded ||
          !crop ||
          !!invalidSelection ||
          selectedCount === 0 ||
          crop.width <= 0 ||
          crop.height <= 0,
        onClick: () => void saveGrid(),
        className: 'h-8 gap-1.5 text-xs',
      },
      saving
        ? h(LoaderCircleIcon, { className: 'size-3.5 animate-spin' })
        : h(CheckIcon, { className: 'size-3.5' }),
      savingLabel,
    ),
    h(
      Button,
      {
        key: 'close',
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '关闭宫格裁剪',
        title: '返回（Esc）',
        onClick: () => props.onClose(),
      },
      h(XIcon, { className: 'size-4' }),
    ),
  );

  const presetActive = (preset: { columns: number; rows: number }) =>
    preset.columns === columns && preset.rows === rows;

  const toolbar = h(
    'div',
    { className: cn(WORKBENCH_TOOLBAR_CLASS, 'flex-col items-stretch gap-1.5') },
    h(
      'div',
      { className: 'flex flex-wrap items-center gap-2' },
      h(
        'div',
        {
          role: 'group',
          'aria-label': '宫格预设',
          className: 'flex items-center gap-0.5',
        },
        ...PRESETS.map((preset) =>
          h(
            'button',
            {
              key: preset.id,
              type: 'button',
              'data-fisherai-grid-crop-preset': preset.id,
              'aria-label': `宫格 ${preset.columns} 列 × ${preset.rows} 行`,
              'aria-pressed': presetActive(preset),
              disabled: saving || !loaded,
              onClick: () => choosePreset(preset),
              className: cn(
                'h-7 rounded-md border px-2 font-mono text-[11px] tabular-nums transition-colors',
                presetActive(preset)
                  ? 'border-border bg-[var(--af-hover)] text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-[var(--af-hover)] hover:text-foreground',
              ),
            },
            `${preset.columns}×${preset.rows}`,
          ),
        ),
      ),
      h('div', { className: WORKBENCH_DIVIDER_CLASS }),
      h(Stepper, {
        label: '横向分割',
        icon: ColumnsIcon,
        value: columns,
        min: MIN_ROWS,
        max: MAX_ROWS,
        disabled: saving || !loaded,
        dataAttribute: 'data-fisherai-grid-crop-columns',
        onChange: (value: number) => restoreEqual(rows, value),
        h,
      }),
      h(Stepper, {
        label: '竖向分割',
        icon: RowsIcon,
        value: rows,
        min: MIN_ROWS,
        max: MAX_ROWS,
        disabled: saving || !loaded,
        dataAttribute: 'data-fisherai-grid-crop-rows',
        onChange: (value: number) => restoreEqual(value, columns),
        h,
      }),
      h('div', { className: WORKBENCH_DIVIDER_CLASS }),
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          'data-fisherai-grid-crop-restore': 'true',
          'aria-label': '恢复等分',
          title: '按当前行列重新等分，并让选区铺满原图',
          disabled: saving || !loaded,
          onClick: () => restoreEqual(),
          className: 'h-7 gap-1 px-2 text-[11px] text-muted-foreground',
        },
        h(RotateCcwIcon, { className: 'size-3.5' }),
        '恢复等分',
      ),
      h('div', { className: WORKBENCH_DIVIDER_CLASS }),
      h(
        'div',
        { role: 'group', 'aria-label': '裁切比例', className: 'flex items-center gap-0.5' },
        ...RATIOS.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              'data-fisherai-grid-crop-ratio': option.value,
              'aria-pressed': ratioLabel === option.value,
              disabled: saving || !loaded,
              onClick: () => selectRatio(option.value),
              className: cn(
                'h-7 rounded-md border px-2 text-[11px] transition-colors',
                ratioLabel === option.value
                  ? 'border-border bg-[var(--af-hover)] text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-[var(--af-hover)] hover:text-foreground',
              ),
            },
            option.label,
          ),
        ),
      ),
    ),
    h(
      'div',
      { className: 'flex flex-wrap items-center gap-2' },
      h(GapSlider, {
        label: '上下间隙',
        value: rowGap,
        disabled: saving || !loaded,
        dataAttribute: 'data-fisherai-grid-crop-row-gap',
        onChange: (value: number) => setRowGap(value),
        h,
      }),
      h(GapSlider, {
        label: '左右间隙',
        value: columnGap,
        disabled: saving || !loaded,
        dataAttribute: 'data-fisherai-grid-crop-column-gap',
        onChange: (value: number) => setColumnGap(value),
        h,
      }),
      h('div', { className: WORKBENCH_DIVIDER_CLASS }),
      h(
        'div',
        { role: 'group', 'aria-label': '导出顺序', className: 'flex items-center gap-0.5' },
        ...ORDERS.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              'data-fisherai-grid-crop-order': option.value,
              'aria-pressed': order === option.value,
              disabled: saving || !loaded,
              onClick: () => setOrder(option.value),
              className: cn(
                'h-7 rounded-md border px-2 text-[11px] transition-colors',
                order === option.value
                  ? 'border-border bg-[var(--af-hover)] text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-[var(--af-hover)] hover:text-foreground',
              ),
            },
            option.label,
          ),
        ),
      ),
      h('div', { className: WORKBENCH_DIVIDER_CLASS }),
      h(
        'div',
        { className: 'flex items-center gap-1.5' },
        h('span', { className: WORKBENCH_HINT_CLASS }, '序号'),
        h(Input, {
          type: 'text',
          inputMode: 'numeric',
          value: exportSelection,
          placeholder: '全部 / 1,3,5-8',
          'aria-label': '导出格子序号',
          'data-fisherai-grid-crop-selection': 'true',
          disabled: saving || !loaded,
          onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
            setExportSelection(event.target.value),
          className: 'h-7 w-36 text-[11px]',
        }),
      ),
    ),
  );

  const stage = h(
    'div',
    { ref: stageRef, className: WORKBENCH_STAGE_CLASS, 'data-fisherai-grid-crop-stage': 'true' },
    h(
      'div',
      {
        className: 'af-wb-image relative overflow-hidden rounded-[3px]',
        style: {
          width: display.width || 1,
          height: display.height || 1,
          visibility: loaded ? 'visible' : 'hidden',
        },
      },
      h('img', {
        src: url,
        alt: '待宫格裁剪图片',
        draggable: false,
        className: 'pointer-events-none block h-full w-full object-contain',
      }),
      h('canvas', {
        ref: canvasRef,
        'data-fisherai-crop-canvas': 'true',
        'aria-label': '宫格裁剪选择区域',
        className: 'absolute inset-0 touch-none',
        style: { width: display.width, height: display.height, cursor },
        onPointerDown: pointerDown,
        onPointerMove: pointerMove,
        onPointerUp: pointerUp,
        onPointerCancel: pointerUp,
        onLostPointerCapture: pointerUp,
        onPointerLeave: () => setHover(null),
      }),
    ),
    !loaded && !error
      ? h(
          'div',
          {
            className:
              'absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground',
          },
          h(LoaderCircleIcon, { className: 'size-4 animate-spin' }),
          '正在载入图片…',
        )
      : null,
  );

  const footer = h(
    'footer',
    { className: WORKBENCH_FOOTER_CLASS },
    h('span', { className: WORKBENCH_HINT_CLASS }, '原图'),
    h(
      'span',
      {
        className: 'font-mono text-[11px] tabular-nums text-muted-foreground',
        'data-fisherai-image-dimensions': 'source',
      },
      sizeLabel(source),
    ),
    h('div', { className: WORKBENCH_DIVIDER_CLASS }),
    h('span', { className: WORKBENCH_HINT_CLASS }, '宫格'),
    h(
      'span',
      {
        className: 'font-mono text-[11px] tabular-nums text-muted-foreground',
        'data-fisherai-grid-crop-count': 'true',
      },
      `${total} 格${exportSelection.trim() ? ` · 导出 ${selectedCount}` : ''}`,
    ),
    h('div', { className: WORKBENCH_DIVIDER_CLASS }),
    h('span', { className: WORKBENCH_HINT_CLASS }, '单格'),
    h(
      'span',
      {
        className: 'font-mono text-[11px] tabular-nums text-muted-foreground',
        'data-fisherai-grid-crop-cell': 'true',
      },
      sizeLabel(single),
    ),
    h('div', { className: 'min-w-0 flex-1' }),
    error || invalidSelection
      ? h(
          'span',
          {
            role: 'alert',
            'data-fisherai-image-status': 'error',
            className: 'max-w-[46ch] truncate text-[11px] text-[var(--af-danger)]',
          },
          error || invalidSelection,
        )
      : h(
          'span',
          { role: 'status', 'data-fisherai-image-status': 'idle', className: WORKBENCH_HINT_CLASS },
          grid
            ? '拖动白色切线可单独微调某一行/列 · 「恢复等分」回到默认宫格 · 保存后每一格成为画布上的一张图'
            : '挑一个宫格预设，或拖边缘调整裁切范围',
        ),
  );

  return h(
    'div',
    {
      ref: rootRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '宫格裁剪',
      'data-fisherai-image-workbench': 'grid',
      tabIndex: -1,
      style: {
        left: overlay.left,
        top: overlay.top,
        width: overlay.width,
        height: overlay.height,
      },
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      onContextMenu: (event: ReactTypes.MouseEvent) => event.preventDefault(),
      className: WORKBENCH_ROOT_CLASS,
    },
    header,
    toolbar,
    stage,
    footer,
  );
}

/** 行列数步进器：nova 工具条里比原生 range 好点，也不占横向空间。 */
function Stepper(props: {
  label: string;
  icon: unknown;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  dataAttribute: string;
  onChange(value: number): void;
  h: typeof ReactTypes.createElement;
}) {
  const h = props.h;
  const Icon = props.icon as ReactTypes.ComponentType<{ className?: string }>;
  const change = (delta: number) => {
    const next = clampCount(props.value + delta, props.min, props.max);
    if (next !== props.value) props.onChange(next);
  };
  const attribute = props.dataAttribute;
  const value = String(props.value);
  return h(
    'div',
    { className: 'flex items-center gap-1' },
    h(
      'span',
      { className: cn(WORKBENCH_HINT_CLASS, 'flex items-center gap-1') },
      h(Icon, { className: 'size-3.5' }),
      props.label,
    ),
    h(
      'div',
      { className: 'flex items-center rounded-md border border-border' },
      h(
        'button',
        {
          type: 'button',
          'aria-label': `减少${props.label}`,
          disabled: props.disabled || props.value <= props.min,
          onClick: () => change(-1),
          className:
            'flex size-6 items-center justify-center text-muted-foreground transition-colors hover:bg-[var(--af-hover)] hover:text-foreground disabled:opacity-40',
        },
        h(MinusIcon, { className: 'size-3' }),
      ),
      h(
        'span',
        {
          ...{ [attribute]: value },
          'data-fisherai-grid-crop-value': 'true',
          className: 'w-6 text-center font-mono text-[11px] tabular-nums text-foreground',
        },
        value,
      ),
      h(
        'button',
        {
          type: 'button',
          'aria-label': `增加${props.label}`,
          disabled: props.disabled || props.value >= props.max,
          onClick: () => change(1),
          className:
            'flex size-6 items-center justify-center text-muted-foreground transition-colors hover:bg-[var(--af-hover)] hover:text-foreground disabled:opacity-40',
        },
        h(PlusIcon, { className: 'size-3' }),
      ),
    ),
  );
}

/** 间隙滑杆（源图像素，0–100；与上游同一个量纲，只是换成 shadcn Slider）。 */
function GapSlider(props: {
  label: string;
  value: number;
  disabled: boolean;
  dataAttribute: string;
  onChange(value: number): void;
  h: typeof ReactTypes.createElement;
}) {
  const h = props.h;
  const attribute = props.dataAttribute;
  const value = String(props.value);
  return h(
    'div',
    { className: 'flex items-center gap-2' },
    h('span', { className: cn(WORKBENCH_HINT_CLASS, 'w-14 shrink-0') }, props.label),
    h(Slider, {
      'aria-label': props.label,
      ...{ [attribute]: value },
      min: 0,
      max: 100,
      step: 1,
      value: [props.value],
      disabled: props.disabled,
      onValueChange: (values: number[]) => props.onChange(values[0] ?? props.value),
      className: 'h-4 w-24',
    }),
    h(
      'span',
      { className: 'w-6 text-center font-mono text-[11px] tabular-nums text-muted-foreground' },
      `${props.value}`,
    ),
  );
}

ImageGridCropStage.displayName = 'ImageGridCropStageShadcn';

/**
 * 给 studio 直接当 React 组件用（`(react, props)` 形状的实现不能直接 createElement：
 * React 会把 props 当第一个参数传进去 → hooks 拿到的是 props，整块舞台炸掉）。
 */
const gridRuntime = ReactTypes as unknown as Runtime;
export const ImageGridCropStageView: ReactTypes.ComponentType<GridCropStageProps> = (props) =>
  ImageGridCropStage(gridRuntime, props);
ImageGridCropStageView.displayName = 'ImageGridCropStageView';
