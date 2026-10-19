/**
 * 裁剪舞台（shadcn nova 版，v1.26）。
 *
 * 与上游 `dialogs/canvasImageCrop.tsx` 的关系：
 *   - **几何与像素全部复用**上游纯函数（`centeredCrop` / `createCrop` / `resizeCrop` /
 *     `moveCrop` / `hitCrop` / `cropHandles` / `cropOutputRects`），所以选区语义、
 *     把手命中半径（20px）、出口尺寸与上游逐像素一致；
 *   - 外观换成 nova 的工具条 + 状态行，去掉上游那圈「胶囊套胶囊」与手写 SVG；
 *   - 上游裁剪器的宫格（行列切线）与全景球预览仍留在上游实现里 ——
 *     「宫格裁剪 / 全景图」入口（mode = grid / panorama）走 vendor 原组件
 *     （见 CanvasImageStudio 的分流），这里只负责图片编辑里的单帧裁剪。
 *
 * 交互契约（回归 / 真机检查依赖）：
 *   - 选区画布 `data-fisherai-crop-canvas` + `aria-label="裁剪选择区域"`；
 *   - 比例按钮 `data-fisherai-crop-ratio="Original|Free|1:1|…"` + `aria-pressed`；
 *   - 应用按钮 `data-fisherai-image-save="crop"`，文案取 `saveLabel`；
 *   - 尺寸读数 `data-fisherai-image-dimensions`。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import {
  ArrowLeft as ArrowLeftIcon,
  Check as CheckIcon,
  LoaderCircle as LoaderCircleIcon,
  X as XIcon,
} from 'lucide-react';

import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { activateModal } from '../../../vendor/aifisher/src/stable/design/modalFocus';
import {
  cropGeometry,
  exportCrop,
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
  type CropOutput,
  type WorkbenchHandle,
  type WorkbenchRect,
  type WorkbenchSize,
} from './imageWorkbench';
import { useCanvasOverlayBox } from './imageWorkbenchOverlay';

type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'useState' | 'useRef' | 'useEffect' | 'useLayoutEffect' | 'useCallback'
>;

export interface CropStageProps {
  node?: { id: string; resultUrl?: string; title?: string };
  saveLabel: string;
  onApply(output: CropOutput): void;
  /** 返回图片编辑首页（也用 Esc / ✕）。 */
  onClose(): void;
}

const RATIOS: Array<{ value: string; label: string }> = [
  { value: 'Original', label: '原图' },
  { value: 'Free', label: '自由' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
];

interface Gesture {
  id: number;
  start: { x: number; y: number };
  rect: WorkbenchRect;
  kind: WorkbenchHandle | 'move' | 'create';
}

export function ImageCropStage(react: Runtime, props: CropStageProps) {
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
  const [hover, setHover] = react.useState<WorkbenchHandle | 'move' | null>(null);
  const [ratioLabel, setRatioLabel] = react.useState('Original');
  const [loaded, setLoaded] = react.useState(false);
  const [saving, setSaving] = react.useState(false);
  const [error, setError] = react.useState('');

  const updateCrop = (next: WorkbenchRect | null) => {
    cropRef.current = next;
    setCrop(next);
  };
  const source = imageRef.current
    ? { width: imageRef.current.naturalWidth, height: imageRef.current.naturalHeight }
    : display;
  const ratio = source.width ? cropGeometry.cropRatio(ratioLabel, source) : 1;

  react.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return activateModal(root, () => closeRef.current());
  }, []);

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
    // 缩放窗口时选区按比例跟随（与上游一致），没有选区就重新居中
    const nextCrop =
      current && previous.width > 0
        ? {
            x: (current.x * next.width) / previous.width,
            y: (current.y * next.height) / previous.height,
            width: (current.width * next.width) / previous.width,
            height: (current.height * next.height) / previous.height,
          }
        : cropGeometry.centeredCrop(next, image.naturalWidth / image.naturalHeight);
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
    setDisplay({ width: 0, height: 0 });
    setCrop(null);
    setRatioLabel('Original');
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
    // 选区外压暗（整块先铺半透明黑，再把选区抠亮）
    context.fillStyle = 'rgba(0,0,0,.62)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.clearRect(rect.x, rect.y, rect.width, rect.height);
    // 选区边框（canvas 里不能用 CSS 变量，取画布 focus 蓝 #60a5fa）
    context.strokeStyle = '#60a5fa';
    context.lineWidth = 1.5;
    context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
    // 三分参考线
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
    // 8 个把手（hover 放大，与上游同款手感）
    for (const handle of cropGeometry.cropHandles(rect)) {
      context.beginPath();
      context.arc(handle.x, handle.y, hover === handle.id ? 7 : 5, 0, Math.PI * 2);
      context.fillStyle = '#f2f2f2';
      context.fill();
      context.strokeStyle = '#0b0b0b';
      context.lineWidth = 1.5;
      context.stroke();
    }
    context.restore();
  }, [crop, display, hover]);

  const location = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(display.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(display.height, event.clientY - bounds.top)),
    };
  };
  const hit = (point: { x: number; y: number }): WorkbenchHandle | 'move' | 'create' => {
    const current = cropRef.current;
    if (!current) return 'create';
    return (cropGeometry.hitCrop(current, point) as WorkbenchHandle | 'move' | null) ?? 'create';
  };
  const pointerDown = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    if (!loaded || savingRef.current || event.button !== 0 || gestureRef.current) return;
    const start = location(event);
    const action = hit(start);
    gestureRef.current = {
      id: event.pointerId,
      start,
      rect: cropRef.current ?? { ...start, width: 0, height: 0 },
      kind: action,
    };
    if (action === 'create') updateCrop({ ...start, width: 0, height: 0 });
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
      const kind = hit(point);
      setHover(kind === 'create' ? null : kind);
      return;
    }
    if (gesture.id !== event.pointerId) return;
    if (gesture.kind === 'move')
      updateCrop(
        cropGeometry.moveCrop(
          gesture.rect,
          { x: point.x - gesture.start.x, y: point.y - gesture.start.y },
          display,
        ),
      );
    else if (gesture.kind === 'create')
      updateCrop(cropGeometry.createCrop(gesture.start, point, display, ratio));
    else
      updateCrop(cropGeometry.resizeCrop(gesture.rect, gesture.kind, point, display, ratio));
  };
  const pointerUp = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    if (gestureRef.current?.id !== event.pointerId) return;
    if (event.type === 'pointerup') pointerMove(event);
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const applyCrop = async () => {
    const image = imageRef.current;
    const rect = cropRef.current;
    if (!image || !rect || savingRef.current || gestureRef.current) return;
    if (rect.width < 2 || rect.height < 2) {
      setError('裁切范围太小，请重新框选。');
      return;
    }
    const session = sessionRef.current;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const output = exportCrop(image, rect, display, {
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      if (sessionRef.current !== session) return;
      props.onApply(output);
    } catch (cause) {
      if (sessionRef.current === session)
        setError(cause instanceof Error ? cause.message : '裁切失败，请重试。');
    } finally {
      if (sessionRef.current === session) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  const selectRatio = (label: string) => {
    if (savingRef.current) return;
    setRatioLabel(label);
    if (label !== 'Free')
      updateCrop(cropGeometry.centeredCrop(display, cropGeometry.cropRatio(label, source)));
  };

  // ⚠️ hook 全部写在这行之前（见 docs/canvas-ui-shadcn.md 第 0 条）
  if (!props.node) return null;

  /** 选区对应的源图像素尺寸（底栏读数，按源图换算而不是显示尺寸）。 */
  const selectionPixels =
    crop && display.width
      ? {
          width: Math.round((crop.width * source.width) / display.width),
          height: Math.round((crop.height * source.height) / display.height),
        }
      : null;

  const header = h(
    'header',
    { className: WORKBENCH_HEADER_CLASS },
    h(
      Button,
      {
        key: 'back',
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '返回图片编辑',
        title: '返回图片编辑',
        onClick: () => props.onClose(),
      },
      h(ArrowLeftIcon, { className: 'size-4' }),
    ),
    h('span', { className: 'text-[13px] font-medium' }, '图片编辑 · 裁剪'),
    h('span', { className: WORKBENCH_HINT_CLASS }, '拖动空白处新建选区 · 拖把手改大小 · 拖选区内部移动'),
    h('div', { className: 'min-w-0 flex-1' }),
    h(
      Button,
      {
        type: 'button',
        size: 'sm',
        'aria-label': props.saveLabel,
        'data-fisherai-image-save': 'crop',
        disabled: saving || !loaded || !crop,
        onClick: () => void applyCrop(),
        className: 'h-8 gap-1.5 text-xs',
      },
      saving
        ? h(LoaderCircleIcon, { className: 'size-3.5 animate-spin' })
        : h(CheckIcon, { className: 'size-3.5' }),
      saving ? '裁切中…' : props.saveLabel,
    ),
    h(
      Button,
      {
        key: 'close',
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '关闭裁剪',
        title: '返回（Esc）',
        onClick: () => props.onClose(),
      },
      h(XIcon, { className: 'size-4' }),
    ),
  );

  const toolbar = h(
    'div',
    { className: WORKBENCH_TOOLBAR_CLASS },
    h(
      'div',
      { role: 'group', 'aria-label': '裁剪比例', className: 'flex items-center gap-0.5' },
      ...RATIOS.map((option) =>
        h(
          'button',
          {
            key: option.value,
            type: 'button',
            'data-fisherai-crop-ratio': option.value,
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
    h('div', { className: WORKBENCH_DIVIDER_CLASS }),
    h(
      'span',
      { className: WORKBENCH_HINT_CLASS },
      ratioLabel === 'Original'
        ? '按原图比例'
        : ratioLabel === 'Free'
          ? '自由比例'
          : `锁定 ${ratioLabel}`,
    ),
  );

  const stage = h(
    'div',
    { ref: stageRef, className: WORKBENCH_STAGE_CLASS, 'data-fisherai-crop-stage': 'true' },
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
        alt: '待裁剪图片',
        draggable: false,
        className: 'pointer-events-none block h-full w-full object-contain',
      }),
      h('canvas', {
        ref: canvasRef,
        'data-fisherai-crop-canvas': 'true',
        'aria-label': '裁剪选择区域',
        className: cn(
          'absolute inset-0 touch-none',
          hover === 'move' ? 'cursor-move' : 'cursor-crosshair',
        ),
        style: { width: display.width, height: display.height },
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
    h('span', { className: WORKBENCH_HINT_CLASS }, '选区'),
    h(
      'span',
      {
        className: 'font-mono text-[11px] tabular-nums text-muted-foreground',
        'data-fisherai-image-dimensions': 'selection',
      },
      sizeLabel(selectionPixels),
    ),
    h('div', { className: 'min-w-0 flex-1' }),
    error
      ? h(
          'span',
          {
            role: 'alert',
            'data-fisherai-image-status': 'error',
            className: 'max-w-[46ch] truncate text-[11px] text-[var(--af-danger)]',
          },
          error,
        )
      : h(
          'span',
          { role: 'status', 'data-fisherai-image-status': 'idle', className: WORKBENCH_HINT_CLASS },
          '裁切后会作为一次编辑应用，保存时生成新图片',
        ),
  );

  return h(
    'div',
    {
      ref: rootRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '图片裁剪',
      'data-fisherai-image-workbench': 'crop',
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

ImageCropStage.displayName = 'ImageCropStageShadcn';

/**
 * 给 studio 直接当 React 组件用（`(react, props)` 形状的实现不能直接 createElement：
 * React 会把 props 当第一个参数传进去 → hooks 拿到的是 props，整块舞台炸掉）。
 */
const cropRuntime = ReactTypes as unknown as Runtime;
export const ImageCropStageView: ReactTypes.ComponentType<CropStageProps> = (props) =>
  ImageCropStage(cropRuntime, props);
ImageCropStageView.displayName = 'ImageCropStageView';
