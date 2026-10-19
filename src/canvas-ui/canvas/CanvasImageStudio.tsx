/**
 * 「图片编辑」工作台（shadcn nova 版，v1.26）。
 *
 * 替换 vendor 的 `dialogs/canvasImageStudio.tsx`（上游外观：一条 nav 按钮带 + 一张大图 +
 * 底栏三个裸按钮）。**分工和边界**：
 *
 *   mode === 'editor'（节点工具条的「图片编辑」）→ 本文件：
 *     · 首页：工具（裁剪 / 蒙版 / 笔刷 / 组合）+ 预览 + 版本撤销重做 + 保存为新图片；
 *     · 裁剪：`ImageCropStage`（几何复用 vendor 纯函数）；
 *     · 蒙版 / 笔刷：`ImageAnnotationStage`（initialMask 区分，保存后回到首页成为一版）；
 *     · 组合：仍走 vendor 的 `CompositePreview`（多图层拖放/缩放/层级是另一套编辑器，
 *       不在这轮范围内 —— 见 docs/canvas-ui-shadcn.md 第五节）。
 *   mode !== 'editor'：
 *     · `grid`（v1.46）→ `ImageGridCropStage`（同样是 nova 工作台，几何/切线/导出全复用
 *       vendor 纯函数，见 docs/canvas-ui-shadcn.md 第三节）；
 *     · 其余（全景 / 角度 / 生成全景）→ **原样交给 vendor** 的 `Components.ImageCrop`：
 *       全景球采景依赖 three.js 场景、角度草稿走另一套编辑器，本轮不动，保证既有能力一个不丢
 *       （vendor 内部会再分发给自己的 CropEditor / Angle / Panorama）。
 *
 * 保存链路（也是 v1.26 修的 bug 的下游）：`onSave(node.id, [current])` →
 * `useCanvasCropSave` → `POST /api/aifisher/canvas/assets/images`（data URL 落盘）→
 * 在画布上新建一个 `Upload Image` 节点。host 侧那条路由以前对 POST 回 405
 * （列表分支把非 GET 全吞了），于是「保存为新图片」点了没反应、状态行显示
 * `method not allowed`；修好后图片会落进素材库并出现在源图右侧。
 *
 * 结构契约（回归 / 真机检查依赖）：
 *   - 根 `role="dialog"` + `aria-label="图片编辑"` + `data-fisherai-image-studio="editor"`；
 *   - 工具按钮 `data-fisherai-image-tool="crop|mask|brush|compose"` + `aria-pressed`；
 *   - 保存按钮 `data-fisherai-image-save="studio"` + `aria-label="保存为新图片"`；
 *   - 撤销 / 重做 aria-label「撤销编辑」「重做编辑」；素材项 `data-fisherai-image-source="<节点id>"`；
 *   - 尺寸/版本读数 `data-fisherai-image-dimensions`，状态行 `data-fisherai-image-status`。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）—— 产物里 React 有两份。见
 *    docs/canvas-ui-shadcn.md 第 1 条；hook 也不能放到「!node return null」之后。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import { createPortal } from 'react-dom';
import {
  Check as CheckIcon,
  Crop as CropIcon,
  Image as ImageIcon,
  Layers as LayersIcon,
  LoaderCircle as LoaderCircleIcon,
  Paintbrush as PaintbrushIcon,
  Redo2 as Redo2Icon,
  Scan as ScanIcon,
  Undo2 as Undo2Icon,
  X as XIcon,
} from 'lucide-react';

import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { canvasPortalTarget } from '@/lib/portal';
import { activateModal } from '../../../vendor/aifisher/src/stable/design/modalFocus';
import {
  CompositePreview,
  ImageCrop as VendorImageCrop,
} from '../../../vendor/aifisher/src/stable/app/canvasComponents';
import { ImageAnnotationStageView } from './ImageAnnotationStage';
import { ImageCropStageView } from './ImageCropStage';
import { ImageGridCropStageView } from './ImageGridCropStage';
import {
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
  type WorkbenchOutput,
  type WorkbenchSize,
} from './imageWorkbench';
import { useCanvasOverlayBox } from './imageWorkbenchOverlay';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'useState'
  | 'useRef'
  | 'useEffect'
  | 'useMemo'
  | 'useLayoutEffect'
  | 'useCallback'
>;

interface StudioSource {
  id: string;
  resultUrl?: string;
  title?: string;
  imageAngle?: unknown;
}

export interface StudioProps {
  node?: StudioSource;
  sources?: StudioSource[];
  projectId?: string;
  mode?: 'editor' | 'grid' | 'panorama' | 'angle' | 'panorama-generate';
  onPanorama?(id: string): void;
  onAngle?(id: string, angle: unknown): void;
  onClose(): void;
  onSave(
    id: string,
    outputs: WorkbenchOutput[],
    progress: (completed: number) => void,
  ): unknown | Promise<unknown>;
}

type Stage = 'crop' | 'mask' | 'brush' | 'compose';

const TOOLS: Array<{ value: Stage; label: string; hint: string; icon: unknown }> = [
  { value: 'crop', label: '裁剪', hint: '框选一块区域，应用后可继续编辑', icon: CropIcon },
  { value: 'mask', label: '蒙版', hint: '把画出来的地方从图片里抠掉（透明）', icon: ScanIcon },
  { value: 'brush', label: '笔刷', hint: '画笔 / 橡皮 / 箭头 / 形状标注', icon: PaintbrushIcon },
  { value: 'compose', label: '组合', hint: '叠加画布上的其它图片（多图层）', icon: LayersIcon },
];

export function CanvasImageStudio(react: Runtime, props: StudioProps) {
  const h = createElement(react);
  const mode = props.mode ?? 'editor';
  const overlay = useCanvasOverlayBox(react);
  const rootRef = react.useRef<HTMLDivElement>(null);
  const activeRef = react.useRef(true);
  const lockRef = react.useRef(false);
  const closeRef = react.useRef(props.onClose);
  react.useLayoutEffect(() => {
    closeRef.current = props.onClose;
  }, [props.onClose]);

  const [stage, setStage] = react.useState<Stage | null>(null);
  const [versions, setVersions] = react.useState<WorkbenchOutput[]>([]);
  const [position, setPosition] = react.useState(-1);
  const [selected, setSelected] = react.useState<string[]>([]);
  const [saving, setSaving] = react.useState(false);
  const [error, setError] = react.useState('');
  const [sourcesOpen, setSourcesOpen] = react.useState(false);
  const [sourceSize, setSourceSize] = react.useState<WorkbenchSize | null>(null);
  const [previewBox, setPreviewBox] = react.useState<WorkbenchSize>({ width: 0, height: 0 });
  const stageRef = react.useRef<HTMLDivElement>(null);

  react.useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  /** 首页才有 modal 契约；进入子舞台时由子舞台自己 activateModal（同一套 stack）。 */
  react.useEffect(() => {
    if (mode !== 'editor' || stage || !rootRef.current) return;
    return activateModal(rootRef.current, () => closeRef.current());
  }, [mode, stage]);

  const current = versions[position];
  const node = props.node;
  const sources = props.sources ?? [];
  const workingUrl = current?.data || node?.resultUrl || '';

  /** 取图拿尺寸 + 校验（版本切换时重新量；失败在状态行显示原因）。 */
  react.useEffect(() => {
    if (mode !== 'editor' || !workingUrl) {
      setSourceSize(null);
      return;
    }
    let cancelled = false;
    loadWorkbenchImage(workingUrl)
      .then((image) => {
        if (cancelled) return;
        setSourceSize({ width: image.naturalWidth, height: image.naturalHeight });
      })
      .catch(() => {
        if (!cancelled) setSourceSize(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, workingUrl]);

  /** 预览按容器等比缩放（首页那张大图）。 */
  const fitPreview = react.useCallback(() => {
    if (!sourceSize || !stageRef.current) return;
    const box = {
      width: stageRef.current.clientWidth || window.innerWidth,
      height: stageRef.current.clientHeight || window.innerHeight,
    };
    setPreviewBox(fitInside(sourceSize, box));
  }, [sourceSize]);
  react.useEffect(() => {
    fitPreview();
    const observer =
      typeof ResizeObserver !== 'undefined' && stageRef.current
        ? new ResizeObserver(fitPreview)
        : null;
    if (stageRef.current) observer?.observe(stageRef.current);
    window.addEventListener('resize', fitPreview);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fitPreview);
    };
  }, [fitPreview]);

  const apply = (output: WorkbenchOutput) => {
    const next = [...versions.slice(0, position + 1), output].slice(-50);
    setVersions(next);
    setPosition(next.length - 1);
    setStage(null);
    setError('');
  };

  // ---- 宫格裁剪（v1.46）：nova 版独立舞台，保存后每格变成画布上的一张图 ----
  if (mode === 'grid')
    return h(ImageGridCropStageView, {
      node: node ? { id: node.id, resultUrl: node.resultUrl, title: node.title } : undefined,
      onSave: props.onSave,
      onClose: props.onClose,
    });
  // ---- 其余非 editor 模式：原样交回 vendor（全景 / 角度 / 生成全景）----
  if (mode !== 'editor') return h(VendorImageCrop, props as unknown as Record<string, unknown>);
  if (!node?.resultUrl) return null;

  // ---- 子舞台（整块对话框由子组件渲染）----
  if (stage === 'crop')
    return h(ImageCropStageView, {
      node: { id: node.id, resultUrl: workingUrl, title: node.title },
      saveLabel: '应用裁剪',
      onApply: apply,
      onClose: () => setStage(null),
    });
  if (stage === 'mask' || stage === 'brush')
    return h(ImageAnnotationStageView, {
      node: { id: node.id, resultUrl: workingUrl, title: node.title },
      initialMask: stage === 'mask',
      saveLabel: '应用编辑',
      title: stage === 'mask' ? '图片编辑 · 蒙版' : '图片编辑 · 笔刷',
      onSave: (_id: string, data: string, dimensions: WorkbenchSize) => {
        apply({ data, width: dimensions.width, height: dimensions.height, row: 0, column: 0 });
      },
      // ✕ / Esc / 保存之后都回到图片编辑首页（与上游一致；关掉整个工作台用首页那个 ✕）
      onClose: () => setStage(null),
    });
  if (stage === 'compose')
    return h(CompositePreview, {
      saveLabel: '应用组合',
      onClose: () => setStage(null),
      payload: {
        nodeId: node.id,
        // 第一层用**当前版本**（应用过裁剪/标注之后合成要基于它，而不是原图）
        layers: [
          { nodeId: node.id, url: workingUrl, title: node.title },
          ...sources
            .filter((item) => item.id !== node.id && selected.includes(item.id))
            .map((item) => ({ nodeId: item.id, url: item.resultUrl ?? '', title: item.title })),
        ],
        onSave: async (_id: string, data: string) => {
          const image = await loadWorkbenchImage(data);
          if (!activeRef.current) return;
          apply({
            data,
            width: image.naturalWidth,
            height: image.naturalHeight,
            row: 0,
            column: 0,
          });
        },
      },
    });

  const others = sources.filter((item) => item.id !== node.id && item.resultUrl);
  const percentBase = sourceSize;

  const header = h(
    'header',
    { className: WORKBENCH_HEADER_CLASS },
    h(ImageIcon, { className: 'size-4 text-muted-foreground' }),
    h('span', { className: 'text-sm font-medium' }, '图片编辑'),
    h('span', { className: WORKBENCH_HINT_CLASS }, '应用工具后可继续编辑，保存时生成新图片'),
    h('div', { className: 'min-w-0 flex-1' }),
    h(
      Button,
      {
        key: 'close',
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '关闭图片编辑',
        title: '关闭（Esc）',
        onClick: () => props.onClose(),
      },
      h(XIcon, { className: 'size-4' }),
    ),
  );

  const toolbar = h(
    'div',
    { className: WORKBENCH_TOOLBAR_CLASS },
    ...TOOLS.map((tool) => {
      const Icon = tool.icon as ReactTypes.ComponentType<{ className?: string }>;
      // 「组合」没有素材可选时不可点（vendor 同款语义：只有一张图时没什么可组合的）
      const disabled = saving || (tool.value === 'compose' && others.length === 0);
      return h(
        Button,
        {
          key: tool.value,
          type: 'button',
          variant: 'outline',
          size: 'sm',
          title: tool.hint,
          'aria-label': tool.label,
          'aria-pressed': false,
          'data-fisherai-image-tool': tool.value,
          disabled,
          onClick: () => setStage(tool.value),
          className: 'h-8 gap-1.5 border-border/70 text-xs text-muted-foreground hover:text-foreground',
        },
        h(Icon, { className: 'size-3.5' }),
        tool.label,
      );
    }),
    h('div', { className: WORKBENCH_DIVIDER_CLASS }),
    h(
      'span',
      { className: WORKBENCH_HINT_CLASS },
      current ? `已应用 ${position + 1} 次编辑` : '还没有应用编辑',
    ),
  );

  const stageView = h(
    'div',
    { ref: stageRef, className: WORKBENCH_STAGE_CLASS, 'data-fisherai-image-preview': 'true' },
    h(
      'div',
      {
        className:
          'af-wb-image relative overflow-hidden rounded-[3px] bg-[var(--af-media-bg)]',
        style: {
          width: previewBox.width || '40%',
          height: previewBox.height || '60%',
          minWidth: 80,
          minHeight: 80,
        },
      },
      h('img', {
        src: workingUrl,
        alt: '当前编辑图片',
        draggable: false,
        className: 'block h-full w-full object-contain',
      }),
      current
        ? h(
            'span',
            {
              className:
                'absolute right-1.5 top-1.5 rounded border border-border bg-[var(--af-input)]/90 ' +
                'px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground',
            },
            `第 ${position + 1} 版`,
          )
        : null,
    ),
    !sourceSize
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

  const sourcesStrip =
    others.length > 0 && sourcesOpen
      ? h(
          'div',
          {
            'data-fisherai-image-sources': 'true',
            className:
              'flex shrink-0 items-center gap-2 overflow-x-auto border-t border-border ' +
              'bg-[var(--af-surface)] px-3 py-2',
          },
          h('span', { className: cn(WORKBENCH_HINT_CLASS, 'shrink-0') }, '组合素材'),
          ...others.map((item) => {
            const pressed = selected.includes(item.id);
            return h(
              'button',
              {
                key: item.id,
                type: 'button',
                title: item.title ?? '未命名图片',
                'data-fisherai-image-source': item.id,
                'aria-pressed': pressed,
                'aria-label': `组合素材 ${item.title ?? item.id}`,
                disabled: saving,
                onClick: () =>
                  setSelected((old) =>
                    old.includes(item.id)
                      ? old.filter((id) => id !== item.id)
                      : [...old, item.id],
                  ),
                className: cn(
                  'flex shrink-0 flex-col items-center gap-1 rounded border p-1 transition-colors',
                  pressed
                    ? 'border-[var(--af-text-secondary)] bg-[var(--af-hover)]'
                    : 'border-border/70 hover:bg-[var(--af-hover)]',
                ),
              },
              h('img', {
                src: item.resultUrl,
                alt: item.title ?? '素材',
                className: 'h-12 w-16 object-contain',
              }),
              h(
                'span',
                { className: 'max-w-16 truncate text-[10px] text-muted-foreground' },
                item.title ?? '未命名',
              ),
            );
          }),
        )
      : null;

  const footer = h(
    'footer',
    { className: WORKBENCH_FOOTER_CLASS },
    h(
      Button,
      {
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '撤销编辑',
        title: '撤销上一版',
        disabled: saving || position < 0,
        onClick: () => setPosition(position - 1),
      },
      h(Undo2Icon, { className: 'size-4' }),
    ),
    h(
      Button,
      {
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '重做编辑',
        title: '重做下一版',
        disabled: saving || position >= versions.length - 1,
        onClick: () => setPosition(position + 1),
      },
      h(Redo2Icon, { className: 'size-4' }),
    ),
    h('div', { className: WORKBENCH_DIVIDER_CLASS }),
    h(
      'span',
      {
        'data-fisherai-image-version': current ? String(position + 1) : 'original',
        className:
          'rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground',
      },
      current ? `第 ${position + 1} 版` : '原图',
    ),
    h(
      'span',
      {
        className: 'font-mono text-[11px] tabular-nums text-muted-foreground',
        'data-fisherai-image-dimensions': current ? 'edited' : 'original',
      },
      percentBase ? sizeLabel(percentBase) : '—',
    ),
    h('span', { className: WORKBENCH_HINT_CLASS }, '像素'),
    h('div', { className: 'min-w-0 flex-1' }),
    others.length > 0
      ? h(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'xs',
            'aria-label': sourcesOpen ? '收起组合素材' : '展开组合素材',
            'aria-pressed': sourcesOpen,
            disabled: saving,
            onClick: () => setSourcesOpen(!sourcesOpen),
            className: 'gap-1 px-1.5 text-[11px] text-muted-foreground',
          },
          h(LayersIcon, { className: 'size-3' }),
          `素材 ${selected.length}/${others.length}`,
        )
      : null,
    error
      ? h(
          'span',
          {
            role: 'alert',
            'data-fisherai-image-status': 'error',
            className: 'max-w-[42ch] truncate text-[11px] text-[var(--af-danger)]',
          },
          error,
        )
      : h(
          'span',
          {
            role: 'status',
            'data-fisherai-image-status': 'idle',
            className: WORKBENCH_HINT_CLASS,
          },
          current ? '本次编辑已应用，可继续编辑或保存' : '应用一个工具后就能保存为新图片',
        ),
    h(
      Button,
      {
        type: 'button',
        size: 'sm',
        'aria-label': '保存为新图片',
        'data-fisherai-image-save': 'studio',
        disabled: saving || !current,
        onClick: async () => {
          if (lockRef.current || !current) return;
          lockRef.current = true;
          setSaving(true);
          setError('');
          try {
            await props.onSave(node.id, [current], () => {});
            if (activeRef.current) props.onClose();
          } catch (cause) {
            if (activeRef.current)
              setError(
                cause instanceof Error ? cause.message : '保存失败，请重试',
              );
          } finally {
            lockRef.current = false;
            if (activeRef.current) setSaving(false);
          }
        },
        className: 'h-8 gap-1.5 text-xs',
      },
      saving
        ? h(LoaderCircleIcon, { className: 'size-3.5 animate-spin' })
        : h(CheckIcon, { className: 'size-3.5' }),
      saving ? '正在保存…' : '保存为新图片',
    ),
  );

  const root = h(
    'div',
    {
      ref: rootRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '图片编辑',
      'data-fisherai-image-studio': 'editor',
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
    stageView,
    sourcesStrip,
    footer,
  );
  const target = canvasPortalTarget();
  return target ? (createPortal(root, target) as ReactTypes.ReactNode) : root;
}

CanvasImageStudio.displayName = 'CanvasImageStudioShadcn';
