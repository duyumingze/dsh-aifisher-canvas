/**
 * 图片标注 / 蒙版舞台（shadcn nova 版，v1.26）。
 *
 * 替换 vendor 的 `dialogs/canvasImageAnnotation.tsx`（908 行，手写 SVG 图标 +
 * 原生 range + 三颗玻璃胶囊）。**行为契约与上游逐条对齐**，只换外观：
 *
 *   1. 画布坐标语义：标注点存在**源图像素**里（`image.naturalWidth` 坐标系），
 *      与显示缩放/平移无关 —— 保存时按原图像素重绘，所以放大画的小图保存后不变形；
 *   2. 工具：笔刷 / 橡皮 / 矩形 / 圆形 / 箭头 / 直线；橡皮用 destination-out；
 *   3. 标准 vs 遮罩：遮罩模式保存时整体 destination-out（把标注区域抠成透明）；
 *   4. 撤销 / 重做 / 清除（时间线结构同上游：past/present/future，上限 50）；
 *   5. 滚轮以指针为中心缩放（0.05x..20x）、中键拖拽平移、`适应窗口`复位；
 *   6. Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y 撤销重做，Ctrl/Cmd+S 保存（上游同款）；
 *   7. Esc 关闭、Tab 陷阱、背景 inert —— 走 vendor 的 `activateModal`（与画布其它弹窗同一套
 *      focus 契约，不另外实现一套）。
 *
 * 结构契约（回归 / 真机检查依赖）：
 *   - 根 `role="dialog"` + `data-fisherai-image-workbench="annotation"`；
 *   - 工具按钮 `data-fisherai-annotation-tool="brush|eraser|rectangle|circle|arrow|line"` + `aria-pressed`；
 *   - 绘制区 canvas `data-fisherai-annotation-canvas` + `aria-label="标注绘制区域"`；
 *   - 保存按钮 `data-fisherai-image-save="annotation"`，文案取 `saveLabel`；
 *   - 尺寸读数 `data-fisherai-image-dimensions`、状态行 `data-fisherai-image-status`。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）—— 产物里 React 有两份，
 *    用错那份 React 19 不报错也不渲染（整个舞台会消失）。见 docs/canvas-ui-shadcn.md。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft as ArrowLeftIcon,
  Check as CheckIcon,
  Circle as CircleIcon,
  Eraser as EraserIcon,
  LoaderCircle as LoaderCircleIcon,
  Maximize as MaximizeIcon,
  Minus as MinusIcon,
  MoveUpRight as MoveUpRightIcon,
  Paintbrush as PaintbrushIcon,
  Plus as PlusIcon,
  Redo2 as Redo2Icon,
  Square as SquareIcon,
  Trash2 as Trash2Icon,
  Undo2 as Undo2Icon,
  X as XIcon,
} from 'lucide-react';

import { Button } from '@/ui/button';
import { Slider } from '@/ui/slider';
import { cn } from '@/lib/utils';
import { canvasPortalTarget } from '@/lib/portal';
import { activateModal } from '../../../vendor/aifisher/src/stable/design/modalFocus';
import {
  renderAnnotations,
  type AnnotationStroke,
  type AnnotationTool,
} from '../../../vendor/aifisher/src/stable/dialogs/imageAnnotationDrawing';
import {
  flattenAnnotations,
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
>;

export interface AnnotationStageProps {
  node?: { id: string; resultUrl?: string; title?: string };
  /** 蒙版模式（保存时 destination-out）。studio 的「蒙版」工具就是它。 */
  initialMask?: boolean;
  saveLabel: string;
  /** 标题（默认「标注图片」）；studio 里传「图片编辑 · 蒙版 / 笔刷」。 */
  title?: string;
  /** 是否显示「标准 / 遮罩」切换（独立标注入口显示；studio 内由工具决定，不再切换）。 */
  maskToggle?: boolean;
  /** studio 内使用时提供：点「返回」回到图片编辑首页（而不是直接关掉整个工作台）。 */
  onBack?(): void;
  onSave(
    id: string,
    data: string,
    dimensions: { width: number; height: number },
  ): Promise<unknown> | unknown;
  onClose(): void;
}

interface Timeline {
  past: AnnotationStroke[][];
  present: AnnotationStroke[];
  future: AnnotationStroke[][];
}

const EMPTY_TIMELINE: Timeline = { past: [], present: [], future: [] };

/** 常用标注色（nova 风：低饱和 + 一个纯白/纯黑用于遮罩边缘）。 */
const SWATCHES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#000000'];

const TOOLS: Array<{ value: AnnotationTool; label: string; icon: unknown }> = [
  { value: 'brush', label: '笔刷', icon: PaintbrushIcon },
  { value: 'eraser', label: '橡皮', icon: EraserIcon },
  { value: 'rectangle', label: '矩形', icon: SquareIcon },
  { value: 'circle', label: '圆形', icon: CircleIcon },
  { value: 'arrow', label: '箭头', icon: MoveUpRightIcon },
  { value: 'line', label: '直线', icon: MinusIcon },
];

export function ImageAnnotationStage(react: Runtime, props: AnnotationStageProps) {
  const h = createElement(react);
  const overlay = useCanvasOverlayBox(react);
  const rootRef = react.useRef<HTMLDivElement>(null);
  const stageRef = react.useRef<HTMLDivElement>(null);
  const canvasRef = react.useRef<HTMLCanvasElement>(null);
  const imageRef = react.useRef<HTMLImageElement | null>(null);
  const sessionRef = react.useRef(0);
  const savingRef = react.useRef(false);
  const activeRef = react.useRef<AnnotationStroke | null>(null);
  const pointerRef = react.useRef<{ id: number; x: number; y: number; pan: boolean } | null>(null);
  const historyRef = react.useRef<Timeline>(EMPTY_TIMELINE);
  const closeRef = react.useRef(props.onClose);
  react.useLayoutEffect(() => {
    closeRef.current = props.onClose;
  }, [props.onClose]);

  const [tool, setTool] = react.useState<AnnotationTool>('brush');
  const [color, setColor] = react.useState('#ef4444');
  const [brushSize, setBrushSize] = react.useState(12);
  const [opacity, setOpacity] = react.useState(0.6);
  const [mask, setMask] = react.useState(Boolean(props.initialMask));
  const [saving, setSaving] = react.useState(false);
  const [loaded, setLoaded] = react.useState(false);
  const [error, setError] = react.useState('');
  const [history, setHistory] = react.useState<Timeline>(historyRef.current);
  const [display, setDisplay] = react.useState<WorkbenchSize>({ width: 0, height: 0 });
  const [viewport, setViewport] = react.useState({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = react.useState(false);
  const [drawing, setDrawing] = react.useState(false);
  const [cursor, setCursor] = react.useState({ x: 0, y: 0 });
  const [cursorVisible, setCursorVisible] = react.useState(false);

  const strokes = history.present;
  const id = props.node?.id ?? '';
  const url = props.node?.resultUrl ?? '';

  /** focus 契约（Esc / Tab / 背景 inert）与画布其它弹窗保持一致。 */
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
    setDisplay(next);
    setViewport({ x: (width - next.width) / 2, y: (height - next.height) / 2, scale: 1 });
  }, []);

  /** 取图：会话号防止「切了图之后旧图的加载回调又把状态写回来」。 */
  react.useEffect(() => {
    const session = ++sessionRef.current;
    savingRef.current = false;
    imageRef.current = null;
    activeRef.current = null;
    pointerRef.current = null;
    historyRef.current = { past: [], present: [], future: [] };
    setHistory(historyRef.current);
    setSaving(false);
    setLoaded(false);
    setError('');
    setDrawing(false);
    setPanning(false);
    setCursorVisible(false);
    setDisplay({ width: 0, height: 0 });
    setMask(Boolean(props.initialMask));
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
  }, [id, url, props.initialMask, fit]);

  const redraw = react.useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !canvas.width || !canvas.height) return;
    const current = historyRef.current.present;
    const strokesToDraw = activeRef.current ? [...current, activeRef.current] : current;
    try {
      // renderAnnotations 会 throw（jsdom 里 getContext 返回 null）；编辑期不该因为
      // 「预览画不出来」把整块舞台打挂 —— 上游也是靠 canvas 存在性提前 return 的。
      renderAnnotations(canvas, strokesToDraw, {
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    } catch {
      /* 预览失败不影响保存链路 */
    }
  }, []);

  react.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !display.width || !display.height) return;
    canvas.width = Math.max(1, Math.round(display.width));
    canvas.height = Math.max(1, Math.round(display.height));
    redraw();
  }, [display, history, redraw]);

  const commit = (next: AnnotationStroke[]) => {
    const old = historyRef.current;
    historyRef.current = {
      past: [...old.past, old.present].slice(-50),
      present: next,
      future: [],
    };
    setHistory(historyRef.current);
  };
  const undo = () => {
    if (savingRef.current || pointerRef.current) return;
    const old = historyRef.current;
    const previous = old.past.at(-1);
    if (!previous) return;
    historyRef.current = {
      past: old.past.slice(0, -1),
      present: previous,
      future: [old.present, ...old.future],
    };
    setHistory(historyRef.current);
  };
  const redo = () => {
    if (savingRef.current || pointerRef.current) return;
    const old = historyRef.current;
    const next = old.future[0];
    if (!next) return;
    historyRef.current = {
      past: [...old.past, old.present],
      present: next,
      future: old.future.slice(1),
    };
    setHistory(historyRef.current);
  };
  const clear = () => {
    if (!savingRef.current && !pointerRef.current && historyRef.current.present.length) commit([]);
  };
  const zoomAt = (factor: number, x: number, y: number) =>
    setViewport((old) => {
      const scale = Math.max(0.05, Math.min(20, old.scale * factor));
      return {
        scale,
        x: x - ((x - old.x) * scale) / old.scale,
        y: y - ((y - old.y) * scale) / old.scale,
      };
    });
  const zoomCenter = (factor: number) => {
    const stage = stageRef.current;
    if (stage && !pointerRef.current)
      zoomAt(
        factor,
        (stage.clientWidth || window.innerWidth) / 2,
        (stage.clientHeight || window.innerHeight) / 2,
      );
  };
  const point = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const image = imageRef.current!;
    return {
      x:
        ((event.clientX - bounds.left) / (bounds.width || display.width * viewport.scale)) *
        image.naturalWidth,
      y:
        ((event.clientY - bounds.top) / (bounds.height || display.height * viewport.scale)) *
        image.naturalHeight,
    };
  };
  const pointerDown = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    if (!loaded || savingRef.current || pointerRef.current || ![0, 1].includes(event.button))
      return;
    event.preventDefault();
    // 合成事件（回归/真机脚本里派发的 PointerEvent）拿不到真实指针，setPointerCapture 会抛
    // NotFoundError；真实鼠标不会。这里吞掉即可 —— 不给捕获也不影响绘制与提交。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointer: ignore */
    }
    pointerRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      pan: event.button === 1,
    };
    if (event.button === 1) {
      setPanning(true);
      return;
    }
    const start = point(event);
    const image = imageRef.current!;
    activeRef.current = {
      tool,
      color,
      size: (brushSize * image.naturalWidth) / (display.width || 1),
      arrowHead: (20 * image.naturalWidth) / (display.width || 1),
      opacity,
      points: [start, start],
    };
    setDrawing(true);
    redraw();
  };
  const pointerMove = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    setCursorVisible(true);
    const bounds = stageRef.current?.getBoundingClientRect();
    setCursor({ x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) });
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (pointer.pan) {
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      setViewport((old) => ({ ...old, x: old.x + dx, y: old.y + dy }));
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      return;
    }
    const stroke = activeRef.current;
    if (!stroke) return;
    if (['rectangle', 'circle', 'arrow', 'line'].includes(stroke.tool))
      stroke.points[1] = point(event);
    else stroke.points.push(point(event));
    redraw();
  };
  const pointerUp = (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (event.type === 'pointerup') pointerMove(event);
    const stroke = activeRef.current;
    activeRef.current = null;
    pointerRef.current = null;
    setDrawing(false);
    setPanning(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (stroke) commit([...historyRef.current.present, stroke]);
    else redraw();
  };

  const save = async () => {
    const image = imageRef.current;
    if (!image || !id || savingRef.current || pointerRef.current) return;
    const session = sessionRef.current;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const output = flattenAnnotations(image, historyRef.current.present, mask);
      await props.onSave(id, output.data, { width: output.width, height: output.height });
      // 保存成功后回到「来的地方」：studio 里是图片编辑首页（onBack），独立入口是关掉自己。
      if (sessionRef.current === session) (props.onBack ?? closeRef.current)();
    } catch (cause) {
      if (sessionRef.current === session)
        setError(cause instanceof Error ? cause.message : '标注保存失败，请重试。');
    } finally {
      if (sessionRef.current === session) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  /** 滚轮：原生非 passive 监听（React 的 onWheel 在根上是被动监听，preventDefault 无效）。 */
  react.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!loaded || pointerRef.current || savingRef.current) return;
      const bounds = stage.getBoundingClientRect();
      zoomAt(
        event.deltaY < 0 ? 1.15 : 1 / 1.15,
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      );
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  });

  /** 键盘：Ctrl/Cmd+S 保存、Ctrl/Cmd+Z/Y 撤销重做（上游同款），其余按键不外泄给画布快捷键。 */
  react.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (!(event.ctrlKey || event.metaKey) || event.isComposing) return;
      const key = event.key.toLowerCase();
      const editing =
        event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]');
      if (key === 's') {
        event.preventDefault();
        void save();
      } else if (!editing && (key === 'z' || key === 'y')) {
        event.preventDefault();
        if (key === 'y' || event.shiftKey) redo();
        else undo();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  });

  // ⚠️ 所有 hook 必须在下面这个提前返回**之前**（否则「有图 / 无图」两次渲染的 hook
  // 数量不同 → React #310，整棵画布树会卸载）。见 docs/canvas-ui-shadcn.md 第 0 条。
  if (!props.node) return null;

  const toolButton = (entry: (typeof TOOLS)[number]) => {
    const Icon = entry.icon as ReactTypes.ComponentType<{ className?: string }>;
    const active = tool === entry.value;
    return h(
      Button,
      {
        key: entry.value,
        type: 'button',
        variant: active ? 'secondary' : 'ghost',
        size: 'icon-sm',
        title: entry.label,
        'aria-label': entry.label,
        'aria-pressed': active,
        'data-fisherai-annotation-tool': entry.value,
        disabled: saving,
        onClick: () => setTool(entry.value),
        className: cn('rounded-md', active ? 'text-foreground' : 'text-muted-foreground'),
      },
      h(Icon, { className: 'size-4' }),
    );
  };

  const percent = Math.round(viewport.scale * 100);

  const header = h(
    'header',
    { className: WORKBENCH_HEADER_CLASS },
    props.onBack
      ? h(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'icon-sm',
            'aria-label': '返回图片编辑',
            title: '返回图片编辑',
            onClick: () => props.onBack?.(),
          },
          h(ArrowLeftIcon, { className: 'size-4' }),
        )
      : null,
    h('span', { className: 'text-[13px] font-medium' }, props.title ?? '标注图片'),
    h('span', { className: WORKBENCH_HINT_CLASS }, '滚轮缩放 · 中键平移 · Ctrl+S 保存'),
    h('div', { className: 'min-w-0 flex-1' }),
    props.maskToggle
      ? h(
          'div',
          { className: 'flex items-center rounded-md border border-border p-0.5' },
          ...[
            ['标准', false],
            ['遮罩', true],
          ].map(([label, value]) =>
            h(
              'button',
              {
                key: String(label),
                type: 'button',
                'aria-pressed': mask === value,
                'data-fisherai-annotation-mask': value ? 'true' : 'false',
                disabled: saving,
                onClick: () => setMask(Boolean(value)),
                className: cn(
                  'rounded px-2 py-1 text-[11px] transition-colors',
                  mask === value
                    ? 'bg-[var(--af-hover)] text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                ),
              },
              String(label),
            ),
          ),
        )
      : null,
    h(
      Button,
      {
        type: 'button',
        size: 'sm',
        'aria-label': props.saveLabel,
        'data-fisherai-image-save': 'annotation',
        disabled: saving || !loaded || drawing,
        onClick: () => void save(),
        className: 'h-8 gap-1.5 text-xs',
      },
      saving
        ? h(LoaderCircleIcon, { className: 'size-3.5 animate-spin' })
        : h(CheckIcon, { className: 'size-3.5' }),
      saving ? '保存中…' : props.saveLabel,
    ),
    h(
      Button,
      {
        key: 'close',
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '关闭标注',
        title: '关闭（Esc）',
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
      {
        role: 'group',
        'aria-label': '标注工具',
        className: 'flex items-center gap-0.5 rounded-md border border-border/70 p-0.5',
      },
      ...TOOLS.map(toolButton),
    ),
    h('div', { className: WORKBENCH_DIVIDER_CLASS }),
    h(
      'div',
      { role: 'group', 'aria-label': '颜色', className: 'flex items-center gap-1' },
      ...SWATCHES.map((value) =>
        h(
          'button',
          {
            key: value,
            type: 'button',
            title: value,
            'aria-label': `颜色 ${value}`,
            'aria-pressed': color === value,
            'data-fisherai-annotation-color': value,
            disabled: saving,
            onClick: () => setColor(value),
            className: cn(
              'size-5 rounded-full border transition-transform',
              color === value
                ? 'scale-110 border-[var(--af-text)]'
                : 'border-[var(--af-border-control)] hover:scale-105',
            ),
            style: { backgroundColor: value },
          },
          '',
        ),
      ),
      h(
        'label',
        {
          className:
            'ml-1 inline-flex h-5 cursor-pointer items-center rounded border border-border px-1.5 ' +
            'text-[10px] text-muted-foreground hover:text-foreground',
          title: '自定义颜色',
        },
        '自定义',
        h('input', {
          type: 'color',
          value: color,
          'aria-label': '自定义颜色',
          disabled: saving,
          onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
            setColor(event.target.value),
          className: 'absolute size-0 opacity-0',
        }),
      ),
      h(
        'span',
        {
          className: 'ml-1 inline-flex size-6 items-center justify-center rounded border border-border',
          title: '当前笔触',
        },
        h('span', {
          className: 'rounded-full',
          style: {
            width: `${Math.min(20, Math.max(2, brushSize / 2))}px`,
            height: `${Math.min(20, Math.max(2, brushSize / 2))}px`,
            backgroundColor: color,
            opacity,
          },
        }),
      ),
    ),
    h('div', { className: WORKBENCH_DIVIDER_CLASS }),
    h(
      'div',
      { className: 'flex items-center gap-2' },
      h('span', { className: cn(WORKBENCH_HINT_CLASS, 'w-6 shrink-0') }, '粗细'),
      h(Slider, {
        'aria-label': '笔触粗细',
        'data-fisherai-annotation-size': String(brushSize),
        min: 5,
        max: 60,
        step: 1,
        value: [brushSize],
        disabled: saving,
        onValueChange: (value: number[]) => setBrushSize(value[0] ?? brushSize),
        className: 'h-4 w-28',
      }),
      h(
        'span',
        {
          className: 'w-6 text-center font-mono text-[11px] tabular-nums text-muted-foreground',
        },
        String(brushSize),
      ),
    ),
    h(
      'div',
      { className: 'flex items-center gap-2' },
      h('span', { className: cn(WORKBENCH_HINT_CLASS, 'w-6 shrink-0') }, '透明'),
      h(Slider, {
        'aria-label': '不透明度',
        'data-fisherai-annotation-opacity': String(Math.round(opacity * 100)),
        min: 10,
        max: 100,
        step: 10,
        value: [Math.round(opacity * 100)],
        disabled: saving,
        onValueChange: (value: number[]) =>
          setOpacity(Math.max(0.1, Math.min(1, (value[0] ?? 60) / 100))),
        className: 'h-4 w-24',
      }),
      h(
        'span',
        {
          className: 'w-8 text-center font-mono text-[11px] tabular-nums text-muted-foreground',
        },
        `${Math.round(opacity * 100)}%`,
      ),
    ),
    h('div', { className: WORKBENCH_DIVIDER_CLASS }),
    h(
      'div',
      { className: 'flex items-center gap-0.5' },
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'icon-sm',
          'aria-label': '撤销标注',
          title: '撤销（Ctrl+Z）',
          disabled: saving || history.past.length === 0,
          onClick: undo,
        },
        h(Undo2Icon, { className: 'size-4' }),
      ),
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'icon-sm',
          'aria-label': '重做标注',
          title: '重做（Ctrl+Shift+Z）',
          disabled: saving || history.future.length === 0,
          onClick: redo,
        },
        h(Redo2Icon, { className: 'size-4' }),
      ),
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'icon-sm',
          'aria-label': '清除标注',
          title: '清除全部标注',
          disabled: saving || strokes.length === 0,
          onClick: clear,
          className: 'text-muted-foreground hover:text-[var(--af-danger)]',
        },
        h(Trash2Icon, { className: 'size-4' }),
      ),
    ),
  );

  const stage = h(
    'div',
    {
      ref: stageRef,
      className: WORKBENCH_STAGE_CLASS,
      'data-fisherai-annotation-stage': 'true',
    },
    h(
      'div',
      {
        className: 'af-wb-image absolute overflow-hidden rounded-[3px]',
        style: {
          visibility: loaded ? 'visible' : 'hidden',
          left: 0,
          top: 0,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: '0 0',
        },
      },
      h('img', {
        src: url,
        alt: '标注图片',
        draggable: false,
        className: 'pointer-events-none block',
        style: {
          width: display.width,
          height: display.height,
          visibility: loaded && display.width > 0 ? 'visible' : 'hidden',
        },
      }),
      h('canvas', {
        ref: canvasRef,
        'data-fisherai-annotation-canvas': 'true',
        'aria-label': '标注绘制区域',
        className: cn(
          'absolute inset-0 touch-none',
          panning ? 'cursor-grabbing' : 'cursor-crosshair',
        ),
        style: { width: display.width, height: display.height },
        onPointerDown: pointerDown,
        onPointerMove: pointerMove,
        onPointerUp: pointerUp,
        onPointerCancel: pointerUp,
        onLostPointerCapture: pointerUp,
        onPointerEnter: () => setCursorVisible(true),
        onPointerLeave: (event: ReactTypes.PointerEvent<HTMLCanvasElement>) => {
          setCursorVisible(false);
          if ((drawing || panning) && !event.currentTarget.hasPointerCapture?.(event.pointerId))
            pointerUp(event);
        },
      }),
    ),
    !loaded && !error
      ? h(
          'div',
          {
            key: 'loading',
            className: 'absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground',
          },
          h(LoaderCircleIcon, { className: 'size-4 animate-spin' }),
          '正在载入图片…',
        )
      : null,
    loaded && cursorVisible && !panning
      ? h('div', {
          className: 'pointer-events-none absolute z-[2000] -translate-x-1/2 -translate-y-1/2 rounded-full border shadow-sm',
          style: {
            left: cursor.x,
            top: cursor.y,
            width: `${brushSize * viewport.scale}px`,
            height: `${brushSize * viewport.scale}px`,
            borderColor: tool === 'eraser' ? 'var(--af-text-secondary)' : color,
            borderStyle: tool === 'eraser' ? 'dashed' : 'solid',
            backgroundColor: tool === 'eraser' ? 'transparent' : color,
            opacity: tool === 'eraser' ? 0.4 : opacity * 0.35,
          },
        })
      : null,
  );

  const footer = h(
    'footer',
    { className: WORKBENCH_FOOTER_CLASS },
    h(
      'div',
      {
        className: 'flex items-center gap-0.5 rounded-md border border-border px-0.5',
      },
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'icon-xs',
          'aria-label': '缩小',
          title: '缩小',
          onClick: () => zoomCenter(1 / 1.15),
        },
        h(MinusIcon, { className: 'size-3.5' }),
      ),
      h(
        'span',
        { className: 'w-11 text-center font-mono text-[11px] tabular-nums text-muted-foreground' },
        `${percent}%`,
      ),
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'icon-xs',
          'aria-label': '放大',
          title: '放大',
          onClick: () => zoomCenter(1.15),
        },
        h(PlusIcon, { className: 'size-3.5' }),
      ),
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'xs',
          'aria-label': '适应窗口',
          title: '适应窗口',
          onClick: () => fit(),
          className: 'gap-1 px-1.5 text-[11px]',
        },
        h(MaximizeIcon, { className: 'size-3' }),
        '适应',
      ),
    ),
    h('div', { className: WORKBENCH_DIVIDER_CLASS }),
    h(
      'span',
      {
        className: 'font-mono text-[11px] tabular-nums text-muted-foreground',
        'data-fisherai-image-dimensions': 'true',
      },
      sizeLabel(imageRef.current ?? null),
    ),
    h(
      'span',
      { className: WORKBENCH_HINT_CLASS },
      mask ? '遮罩模式：标注区域会从图片里抠掉' : '标准模式：标注直接画在图片上',
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
          strokes.length ? `${strokes.length} 笔标注` : '还没有标注',
        ),
  );

  const root = h(
    'div',
    {
      ref: rootRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '标注图片',
      'data-fisherai-image-workbench': 'annotation',
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
  const target = canvasPortalTarget();
  return target ? (createPortal(root, target) as ReactTypes.ReactNode) : root;
}

ImageAnnotationStage.displayName = 'ImageAnnotationStageShadcn';

/**
 * 给 studio / 标注槽位当 React 组件用（`(react, props)` 形状的实现不能直接
 * createElement：React 会把 props 当第一个参数传进去 → hooks 拿不到 React）。
 */
const annotationRuntime = ReactTypes as unknown as Runtime;
export const ImageAnnotationStageView: ReactTypes.ComponentType<AnnotationStageProps> = (props) =>
  ImageAnnotationStage(annotationRuntime, props);
ImageAnnotationStageView.displayName = 'ImageAnnotationStageView';
