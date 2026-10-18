/**
 * 「尺寸」对话框（`dependencies.Resize` 槽位，shadcn nova 版，v1.38）。
 *
 * 用户原话（2026-10-17）：「尺寸节点的ui还没有更新」。
 *
 * 上游 `dialogs/canvasImageResize.tsx` 的功能只有三件事：等比倍数、指定宽、指定高 ——
 * 但它是一整块**铺满窗口**的浮层（`fixed inset-0` + 原生 range + 手写样式），
 * 与 v1.26 之后的图片编辑族（工作台 / 裁剪舞台 / 标注舞台）完全是两套视觉语言。
 *
 * 这一版只换**壳**，像素语义与上游逐字一致：
 *   - 尺寸换算仍走 vendor 纯函数 `resizeDimensions` / `resizeLimit`
 *     （同一个「改一边按比例推另一边」的规则，同样的 16384px / 6400 万像素上限）；
 *   - 保存仍走 vendor 的 `saveResize`（`useCanvasImageEditSave` → 上传素材库 → 画布上新建
 *     「尺寸」图片节点），所以这里只负责把 dataURL 与目标尺寸交回去。
 *
 * 结构契约（回归 / 真机检查依赖）：
 *   - 根 `role="dialog"` + `aria-label="调整图片尺寸"` + `data-fisherai-image-resize="true"`；
 *     portal 进画布容器（不是 document.body）；
 *   - 倍数滑杆 `aria-label="图片缩放滑块"`、倍数输入 `aria-label="图片缩放倍数"`；
 *   - 宽 / 高输入 `aria-label="图片宽度"` / `aria-label="图片高度"`；
 *   - 快捷倍率 `data-fisherai-resize-preset="0.5|1|2|4"` + `aria-pressed`；
 *   - 尺寸读数 `data-fisherai-resize-dimensions`（`data-original` / `data-target`）；
 *   - 保存 `data-fisherai-image-save="resize"` + `aria-label="保存尺寸图片"`，关闭 `aria-label="关闭尺寸"`。
 *
 * ⚠️ 与 v1.26 那几个浮层同一个坑：**不要用 `fixed inset-0`** —— 画布浮层 portal 到
 *    `.af-canvas-mount`，DSH 容器链路上可能有 transform，`inset-0` 会量成窗口尺寸而不是画布尺寸。
 *    这里用 `useCanvasOverlayBox`（量画布容器 rect + ResizeObserver）。
 */
import * as ReactTypes from 'react';
import { createPortal } from 'react-dom';
import {
  Check as CheckIcon,
  Image as ImageIcon,
  LoaderCircle as LoaderCircleIcon,
  Maximize2 as Maximize2Icon,
  X as XIcon,
} from 'lucide-react';

import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { canvasPortalTarget } from '@/lib/portal';
import { activateModal } from '../../../vendor/aifisher/src/stable/design/modalFocus';
import {
  resizeDimensions,
  resizeLimit,
  type Mode,
  type Size,
} from '../../../vendor/aifisher/src/stable/dialogs/imageResizeGeometry';
import { useCanvasOverlayBox } from './imageWorkbenchOverlay';

type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'useState' | 'useRef' | 'useEffect' | 'useLayoutEffect' | 'useCallback'
>;

export interface ResizeSlotProps {
  node?: { id: string; resultUrl?: string; title?: string };
  projectId?: string;
  onSave(id: string, data: string, dimensions: Size): Promise<unknown> | unknown;
  onClose(): void;
}

/** 快捷倍率：最常用的四档（等比，不改变构图）。 */
const SCALE_PRESETS = ['0.5', '1', '2', '4'];

const INPUT_CLASS =
  'h-7 w-20 rounded-[3px] border border-border/70 bg-[var(--af-input)] px-1.5 text-center ' +
  'font-mono text-[11px] tabular-nums text-foreground outline-none ' +
  'focus-visible:border-[var(--af-info)] [appearance:textfield] ' +
  '[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';

export function CanvasImageResize(react: Runtime, props: ResizeSlotProps) {
  const h = react.createElement;
  const overlay = useCanvasOverlayBox(react);
  const rootRef = react.useRef<HTMLDivElement>(null);
  const stageRef = react.useRef<HTMLDivElement>(null);
  const imageRef = react.useRef<HTMLImageElement | null>(null);
  const sessionRef = react.useRef(0);
  const savingRef = react.useRef(false);
  const closeRef = react.useRef(props.onClose);

  react.useLayoutEffect(() => {
    closeRef.current = props.onClose;
  }, [props.onClose]);

  const [original, setOriginal] = react.useState<Size | null>(null);
  const [mode, setMode] = react.useState<Mode>('scale');
  const [scale, setScale] = react.useState('1');
  const [width, setWidth] = react.useState('');
  const [height, setHeight] = react.useState('');
  const [saving, setSaving] = react.useState(false);
  const [error, setError] = react.useState('');
  const [preview, setPreview] = react.useState<Size>({ width: 0, height: 0 });

  const id = props.node?.id;
  const url = props.node?.resultUrl;

  react.useEffect(() => {
    const session = ++sessionRef.current;
    savingRef.current = false;
    imageRef.current = null;
    setSaving(false);
    setOriginal(null);
    setMode('scale');
    setScale('1');
    setWidth('');
    setHeight('');
    setError('');
    if (!id || !rootRef.current) return;
    const release = activateModal(rootRef.current, () => closeRef.current());
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const fail = () => {
      if (sessionRef.current === session) setError('图片加载失败，请关闭后重新打开。');
    };
    const timeout = window.setTimeout(fail, 15000);
    image.onload = () => {
      clearTimeout(timeout);
      if (sessionRef.current !== session) return;
      if (!image.naturalWidth || !image.naturalHeight) {
        fail();
        return;
      }
      imageRef.current = image;
      setOriginal({ width: image.naturalWidth, height: image.naturalHeight });
      setWidth(String(image.naturalWidth));
      setHeight(String(image.naturalHeight));
      setError('');
    };
    image.onerror = () => {
      clearTimeout(timeout);
      fail();
    };
    if (url) image.src = url;
    else {
      clearTimeout(timeout);
      fail();
    }
    return () => {
      sessionRef.current = session + 1;
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      imageRef.current = null;
      release();
    };
  }, [id, url, props.projectId]);

  const dimensions = original
    ? resizeDimensions(original, mode, mode === 'scale' ? scale : mode === 'width' ? width : height)
    : { width: 0, height: 0 };
  const invalid = original ? resizeLimit(dimensions) : '';
  const ratio = dimensions.width && original ? (dimensions.width / original.width).toFixed(3) : '1';

  /** 预览按舞台等比缩放（与 vendor 一样的「不放大到超过容器」）。 */
  const fitPreview = react.useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !dimensions.width || !dimensions.height) return;
    const box = {
      width: stage.clientWidth || window.innerWidth - 80,
      height: stage.clientHeight || window.innerHeight - 200,
    };
    const factor = Math.max(
      0.02,
      Math.min(box.width / dimensions.width, box.height / dimensions.height, 1),
    );
    setPreview({
      width: Math.max(1, Math.round(dimensions.width * factor)),
      height: Math.max(1, Math.round(dimensions.height * factor)),
    });
  }, [dimensions.width, dimensions.height]);

  react.useEffect(() => {
    fitPreview();
    const stage = stageRef.current;
    const observer =
      typeof ResizeObserver !== 'undefined' && stage ? new ResizeObserver(fitPreview) : null;
    if (stage) observer?.observe(stage);
    window.addEventListener('resize', fitPreview);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fitPreview);
    };
  }, [fitPreview]);

  /** 改一个字段 → 其余两个按同一比例跟着走（与 vendor 的 change() 语义一致）。 */
  const change = (nextMode: Mode, raw: string) => {
    setMode(nextMode);
    setError('');
    if (nextMode === 'scale') setScale(raw);
    else if (nextMode === 'width') setWidth(raw);
    else setHeight(raw);
    if (!original) return;
    const next = resizeDimensions(original, nextMode, raw);
    if (!next.width || !next.height) return;
    if (nextMode !== 'width') setWidth(String(next.width));
    if (nextMode !== 'height') setHeight(String(next.height));
    if (nextMode !== 'scale') setScale((next.width / original.width).toFixed(3));
  };

  const save = async () => {
    const image = imageRef.current;
    if (!image || !id || savingRef.current || invalid) return;
    const session = sessionRef.current;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建尺寸处理画布');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
      const data = canvas.toDataURL('image/png');
      if (!data.startsWith('data:image/png')) throw new Error('图片尺寸超出当前设备的处理范围。');
      await props.onSave(id, data, dimensions);
      if (sessionRef.current === session) closeRef.current();
    } catch (cause) {
      if (sessionRef.current === session)
        setError(cause instanceof Error ? cause.message : '尺寸图片保存失败，请重试。');
    } finally {
      if (sessionRef.current === session) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  if (!props.node) return null;
  const canSave = Boolean(original) && !invalid && !saving;
  const loading = !original && !error;

  const header = h(
    'header',
    {
      className:
        'flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3',
    },
    h(ImageIcon, { className: 'size-4 text-muted-foreground' }),
    h('span', { className: 'text-sm font-medium' }, '调整尺寸'),
    h(
      'span',
      { className: 'truncate text-[11px] text-muted-foreground' },
      props.node.title ? props.node.title : '等比缩放或指定宽高',
    ),
    h('div', { className: 'min-w-0 flex-1' }),
    h(
      Button,
      {
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '关闭尺寸',
        title: '关闭（Esc）',
        onClick: () => props.onClose(),
      },
      h(XIcon, { className: 'size-4' }),
    ),
  );

  const fieldLabel = (text: string, active: boolean) =>
    h(
      'span',
      {
        className: cn(
          'shrink-0 text-[10px] font-semibold',
          active ? 'text-[var(--af-info)]' : 'text-muted-foreground',
        ),
      },
      text,
    );

  const toolbar = h(
    'div',
    {
      className:
        'flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 ' +
        'bg-[var(--af-surface)] px-3 py-2',
    },
    h(
      'div',
      { className: 'flex items-center gap-1.5' },
      fieldLabel('倍数', mode === 'scale'),
      h('input', {
        'aria-label': '图片缩放滑块',
        type: 'range',
        min: '0.1',
        max: '5',
        step: '0.01',
        value: mode === 'scale' ? scale : ratio,
        disabled: saving || loading,
        onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
          change('scale', event.target.value),
        className: 'h-1 w-28 cursor-pointer appearance-none rounded-full bg-[var(--af-hover)]',
      }),
      h('input', {
        'aria-label': '图片缩放倍数',
        type: 'number',
        min: '0.01',
        step: '0.01',
        value: mode === 'scale' ? scale : ratio,
        disabled: saving || loading,
        onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
          change('scale', event.target.value),
        className: INPUT_CLASS,
      }),
      h('span', { className: 'text-[10px] text-muted-foreground' }, 'x'),
    ),
    ...SCALE_PRESETS.map((value) =>
      h(
        Button,
        {
          key: `preset:${value}`,
          type: 'button',
          variant: 'outline',
          size: 'xs',
          'data-fisherai-resize-preset': value,
          'aria-pressed': mode === 'scale' && scale === value,
          'aria-label': `缩放到 ${value} 倍`,
          disabled: saving || loading,
          onClick: () => change('scale', value),
          className: cn(
            'h-6 px-1.5 font-mono text-[11px]',
            mode === 'scale' && scale === value
              ? 'border-[var(--af-info)] bg-[var(--af-info-bg)] text-foreground'
              : 'text-muted-foreground',
          ),
        },
        `${value}x`,
      ),
    ),
    h('div', { className: 'h-5 w-px bg-border/70' }),
    fieldLabel('宽', mode === 'width'),
    h('input', {
      'aria-label': '图片宽度',
      type: 'number',
      min: '1',
      value: width,
      disabled: saving || loading,
      onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
        change('width', event.target.value),
      className: INPUT_CLASS,
    }),
    fieldLabel('高', mode === 'height'),
    h('input', {
      'aria-label': '图片高度',
      type: 'number',
      min: '1',
      value: height,
      disabled: saving || loading,
      onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
        change('height', event.target.value),
      className: INPUT_CLASS,
    }),
  );

  const stage = h(
    'div',
    {
      ref: stageRef,
      className: 'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6',
    },
    original && !invalid && dimensions.width > 0
      ? h(
          'div',
          {
            'data-fisherai-resize-preview': 'true',
            className:
              'relative overflow-hidden rounded-[3px] border border-border/70 ' +
              'bg-[var(--af-media-bg)] shadow-2xl',
            style: {
              width: Math.max(1, preview.width),
              height: Math.max(1, preview.height),
            },
          },
          h('img', {
            src: url,
            alt: props.node.title || '尺寸预览',
            draggable: false,
            className: 'block h-full w-full object-contain',
          }),
          h(
            'span',
            {
              className:
                'absolute right-1.5 top-1.5 rounded border border-border bg-[var(--af-input)]/90 ' +
                'px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground',
            },
            `${dimensions.width} × ${dimensions.height}`,
          ),
        )
      : null,
    loading
      ? h(
          'div',
          {
            role: 'status',
            'data-fisherai-resize-status': 'loading',
            className: 'flex items-center gap-2 text-xs text-muted-foreground',
          },
          h(LoaderCircleIcon, { className: 'size-4 animate-spin' }),
          '正在载入图片…',
        )
      : null,
  );

  const footer = h(
    'footer',
    {
      className:
        'flex h-14 shrink-0 items-center gap-3 border-t border-border/70 ' +
        'bg-[var(--af-surface)] px-3',
    },
    h(
      'span',
      {
        'data-fisherai-resize-dimensions': 'true',
        'data-original': original ? `${original.width}x${original.height}` : '',
        'data-target': dimensions.width ? `${dimensions.width}x${dimensions.height}` : '',
        className: 'flex items-center gap-2 font-mono text-[11px] tabular-nums',
      },
      h(
        'span',
        { className: 'text-muted-foreground' },
        original ? `${original.width} × ${original.height}` : '--',
      ),
      h(Maximize2Icon, { className: 'size-3 text-muted-foreground' }),
      h(
        'span',
        { className: 'text-[var(--af-info)]' },
        dimensions.width ? `${dimensions.width} × ${dimensions.height}` : '--',
      ),
      h('span', { className: 'text-muted-foreground' }, '像素'),
    ),
    invalid || error
      ? h(
          'span',
          {
            role: 'alert',
            'data-fisherai-resize-status': 'error',
            className: 'min-w-0 truncate text-[11px] text-[var(--af-danger)]',
          },
          error || invalid,
        )
      : h(
          'span',
          {
            role: 'status',
            'data-fisherai-resize-status': 'idle',
            className: 'min-w-0 truncate text-[11px] text-muted-foreground',
          },
          '保存后会生成一张新图片，原图保留',
        ),
    h('div', { className: 'min-w-0 flex-1' }),
    h(
      Button,
      {
        type: 'button',
        variant: 'ghost',
        size: 'sm',
        'aria-label': '取消',
        disabled: saving,
        onClick: () => props.onClose(),
        className: 'h-8 text-xs text-muted-foreground',
      },
      '取消',
    ),
    h(
      Button,
      {
        type: 'button',
        size: 'sm',
        'data-fisherai-image-save': 'resize',
        'aria-label': '保存尺寸图片',
        disabled: !canSave,
        onClick: () => void save(),
        className: 'h-8 gap-1.5 text-xs',
      },
      saving
        ? h(LoaderCircleIcon, { className: 'size-3.5 animate-spin' })
        : h(CheckIcon, { className: 'size-3.5' }),
      saving ? '正在保存…' : '保存尺寸图片',
    ),
  );

  const root = h(
    'div',
    {
      ref: rootRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '调整图片尺寸',
      'data-fisherai-image-resize': 'true',
      tabIndex: -1,
      style: {
        left: overlay.left,
        top: overlay.top,
        width: overlay.width,
        height: overlay.height,
      },
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      onWheel: (event: ReactTypes.WheelEvent) => event.stopPropagation(),
      onKeyDown: (event: ReactTypes.KeyboardEvent) => event.stopPropagation(),
      className:
        'fixed z-[12000] flex select-none flex-col overflow-hidden bg-black/45 text-[var(--af-text)] backdrop-blur-sm',
    },
    h(
      'div',
      {
        className:
          'm-auto flex h-full max-h-[min(720px,100%)] w-full max-w-[min(880px,100%)] ' +
          'flex-col overflow-hidden rounded-[4px] border border-border/70 ' +
          'bg-[var(--af-surface)] shadow-2xl',
      },
      header,
      toolbar,
      stage,
      footer,
    ),
  );
  const target = canvasPortalTarget();
  return target ? (createPortal(root, target) as ReactTypes.ReactNode) : root;
}

CanvasImageResize.displayName = 'CanvasImageResizeShadcn';
