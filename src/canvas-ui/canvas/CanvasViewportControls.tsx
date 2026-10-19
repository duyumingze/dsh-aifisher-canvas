/**
 * 画布缩放控件 / 快捷键说明 / 宫格排列（shadcn/ui 重设计版）。
 *
 * 替换 vendor 的 `dialogs/canvasViewportControls.tsx`。它同时接管小地图
 * （vendor 的 `canvasComponents.ts` 里 Controls 的依赖就是 { Tooltip, Minimap }）。
 *
 * 结构契约（真机检查依赖，改前看 docs/canvas-ui-shadcn.md）：
 *   - 缩放条根元素保留 `absolute bottom-6 left-6 h-[42px]`（test-panel-exit 断言）；
 *   - 小地图按钮 aria-label = 关闭小地图 / 打开小地图；重置按钮 = 显示所有节点；
 *     缩放滑杆 aria-label = 画布缩放；快捷键按钮 aria-label = 快捷键说明；
 *   - `zoomControlsRef` 要挂到缩放条根元素上（vendor 用它做滚轮/定位计算）；
 *   - 宫格面板 `role=dialog` + aria-label=排列选中节点，紧凑模式 `role=switch`。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数），不要用本文件 import 的那份 ——
 *    产物里 React 有两份副本，用错那分量 React 19 不报错也不渲染（整条控制条会消失）。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import { CircleHelpIcon, KeyboardIcon, MaximizeIcon, MapIcon, ZoomInIcon } from 'lucide-react';

import { Button } from '@/ui/button';
import { Kbd } from '@/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Separator } from '@/ui/separator';
import { Slider } from '@/ui/slider';
import { Switch } from '@/ui/switch';
import { cn } from '@/lib/utils';
import { CanvasNodeSearch } from './CanvasNodeSearch';
import { CanvasProjectArchive } from './CanvasProjectArchivePanel';
import { CanvasTaskQueue } from './CanvasTaskQueue';
import { CanvasWorkflowLibrary } from './CanvasWorkflowLibrary';
import { ComfyWorkflowConfig } from './ComfyWorkflowConfig';
import type { CanvasViewport } from '../../../vendor/aifisher/src/stable/canvas/canvasNavigation';
import type { MinimapNode } from '../../../vendor/aifisher/src/stable/dialogs/minimapGeometry';

type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'Fragment' | 'useState' | 'useEffect'
>;

interface MinimapComponentProps {
  nodes: MinimapNode[];
  viewport: CanvasViewport;
  onViewportChange(viewport: CanvasViewport): void;
  width: number;
  height: number;
  canvasRef?: ReactTypes.RefObject<HTMLElement | null>;
  documentEpoch?: number;
}

interface Props {
  view: string;
  nodes: MinimapNode[];
  viewport: CanvasViewport;
  onViewportChange(viewport: CanvasViewport): void;
  isMinimapOpen: boolean;
  setIsMinimapOpen: ReactTypes.Dispatch<ReactTypes.SetStateAction<boolean>>;
  minimapWidth: number;
  zoomControlsRef: ReactTypes.RefObject<HTMLDivElement | null>;
  canvasRef?: ReactTypes.RefObject<HTMLElement | null>;
  documentEpoch?: number;
  onResetCanvas(nodes: MinimapNode[]): void;
  onSliderZoom(event: ReactTypes.ChangeEvent<HTMLInputElement>): void;
  showGridSlider: boolean;
  setShowGridSlider(value: boolean): void;
  gridColumns: number;
  setGridColumns(value: number): void;
  isCompact: boolean;
  setIsCompact(value: boolean): void;
  onGridLayout(columns: number, compact: boolean): void;
  selectedNodeIds: string[];
  /** 当前项目 id（v1.42：vendor 补丁 3.8r 给 Controls 补的一个 prop；空 = 还没保存过） */
  projectId?: string;
}

const SHORTCUTS: Array<[string, string]> = [
  ['搜索节点（仿 Blender）', 'Shift + A'],
  ['平移画布', '中键拖拽 / Alt+滚轮'],
  ['缩放画布', '滚轮 / Ctrl+滚轮'],
  ['聚焦选中/全部', 'F'],
  ['自动排列', 'L'],
  ['保存工作流', 'Ctrl + S'],
  ['复制 / 粘贴', 'Ctrl + C / V'],
  ['节点打组', 'Ctrl + G'],
  ['撤销 / 重做', 'Ctrl + Z / Y'],
  ['删除节点', 'Del / Backspace'],
  ['断开连线', '双击连线'],
];

/**
 * 节点搜索面板的槽位绑定：把它从「(react, props) 两参函数」变成真正的 React 组件。
 *
 * ⚠️ 不能直接 `createElement(CanvasNodeSearch, props)`：React 调函数组件时只传一个 props
 *    参数，于是 `react` 参数会收到 props、`props` 参数是 undefined（画布会直接抛
 *    「Cannot read properties of undefined (reading 'zoom')」并整块白屏）。这里显式补上
 *    注入的那一份 React —— 与 vendor `bind()` 的形状一致。
 */
function CanvasNodeSearchBound(props: NodeSearchBoundProps) {
  return CanvasNodeSearch(reactRuntime, props);
}
CanvasNodeSearchBound.displayName = 'CanvasNodeSearchBound';

/**
 * 组件签名是 `(react, props)` 两参形式，`ComponentProps<>` 只认单参数组件，
 * 会推成 `{}`（于是 props.view 变成多余属性）；这里直接取第二个参数的类型。
 */
type NodeSearchBoundProps = Parameters<typeof CanvasNodeSearch>[1];
const reactRuntime = ReactTypes as unknown as Parameters<typeof CanvasNodeSearch>[0];

/**
 * 「ComfyUI 工作流配置」面板的槽位绑定（v1.16）。
 *
 * 和节点搜索同一个理由：它也是「(react, props) 两参函数」，必须显式把 React 补进去；
 * 也挂在 Controls 槽位 —— 这里同时有 view / viewport，而 viewport 决定「添加到画布」
 * 的落点（画布正中）。
 */
const ComfyWorkflowConfigBound: ReactTypes.ComponentType<{
  view: string;
  viewport?: { x: number; y: number; zoom: number };
  canvasRef?: ReactTypes.RefObject<HTMLElement | null>;
}> = (props) => ComfyWorkflowConfig(reactRuntime, props);
ComfyWorkflowConfigBound.displayName = 'ComfyWorkflowConfigBound';

/**
 * 「任务队列」面板的槽位绑定（v1.24，画布右侧那块）。
 *
 * 同样挂在 Controls 槽位：它只认 view（画布视图才渲染），而这个槽位是唯一拿得到
 * view 的地方；面板自己 portal 到画布容器、绝对定位贴右缘，不依赖 viewport。
 * 与上面两份一样必须是稳定的组件类型（模块级常量），否则每次渲染重挂载会把面板的
 * 轮询与列表状态清零。
 */
const TaskQueueBound: ReactTypes.ComponentType<{ view: string }> = (props) =>
  CanvasTaskQueue(reactRuntime, props);
TaskQueueBound.displayName = 'CanvasTaskQueueBound';

/**
 * 「工作流节点」面板的槽位绑定（v1.28）。
 *
 * 用户报障：「左侧工作流节点做错了，点击后是在画布右键的样子」—— 那个按钮原来是
 * `onAddClick`（画布右键菜单）；现在换成这个面板，把配置好的 ComfyUI 工作流按图卡片陈列。
 * 同样必须有**稳定的组件类型**（模块级常量），否则每次 Controls 重渲染都会重挂载，
 * 面板的清单/搜索/上传中状态全被清掉。
 */
const WorkflowLibraryBound: ReactTypes.ComponentType<{
  view: string;
  viewport?: { x: number; y: number; zoom: number };
  canvasRef?: ReactTypes.RefObject<HTMLElement | null>;
}> = (props) => CanvasWorkflowLibrary(reactRuntime, props);
WorkflowLibraryBound.displayName = 'CanvasWorkflowLibraryBound';

/**
 * 「项目归档」面板的槽位绑定（v1.42）。
 *
 * 同样挂在 Controls 槽位：它需要的是**当前项目 id**，而这个 prop 是 vendor 补丁 3.8r
 * 给 Controls 多喂的一个（`projectId: workflowId || void 0`）—— 上游本来只把 workflowId
 * 喂给 SidePanels。组件类型必须模块级稳定，否则每次 Controls 重渲染都会重挂载，
 * 面板里刚读到的规模读数与提示条会被清掉。
 */
const ProjectArchiveBound: ReactTypes.ComponentType<{ view: string; projectId?: string }> = (
  props,
) => CanvasProjectArchive(reactRuntime, props);
ProjectArchiveBound.displayName = 'CanvasProjectArchiveBound';

export function CanvasViewportControls(
  react: Runtime,
  props: Props,
  components: {
    Minimap: ReactTypes.ComponentType<MinimapComponentProps>;
  },
) {
  const h = createElement(react);
  const { Minimap } = components;
  const {
    view,
    nodes,
    viewport,
    onViewportChange,
    isMinimapOpen,
    setIsMinimapOpen,
    minimapWidth,
    zoomControlsRef,
    canvasRef,
    documentEpoch,
    onResetCanvas,
    onSliderZoom,
    showGridSlider,
    setShowGridSlider,
    gridColumns,
    setGridColumns,
    isCompact,
    setIsCompact,
    onGridLayout,
    selectedNodeIds,
    projectId,
  } = props;

  const [helpOpen, setHelpOpen] = react.useState(false);

  react.useEffect(() => {
    setHelpOpen(false);
  }, [documentEpoch, view]);

  /**
   * vendor 的 onSliderZoom 读的是原生 range 事件，**单位是缩放倍率 0.05..5**
   * （`sliderViewport` 里 `Math.min(5, Math.max(0.05, value))`，上游 range 的 min=0.05/max=5）。
   *
   * ⚠️ 2026-10-17 修「滑轮用不了」：这里以前把滑杆的**百分比**（5..500）直接当成倍率传进去，
   *    于是任何一次拖动都被 clamp 成 100 倍 → 落在 5 → 500%，滑杆永远钉在最右端、拖不动
   *    （真机复现：拖到轨道 25% 处 → 500%，thumb 钉在 x=492；方向键也是 100%→500%）。
   *    所以必须除以 100 还原成倍率。真机验收见 scripts/verify-live-zoom.mjs。
   */
  const zoomFromSlider = (values: number[]) => {
    const next = values[0];
    if (typeof next !== 'number' || !Number.isFinite(next)) return;
    onSliderZoom({
      target: { value: String(next / 100) },
    } as unknown as ReactTypes.ChangeEvent<HTMLInputElement>);
  };

  const zoomBar = h(
    'div',
    {
      ref: zoomControlsRef,
      // 保留 vendor 的定位串（真机断言按它判断「控件没跑出画布」）
      className:
        'absolute bottom-6 left-6 h-[42px] z-50 flex items-center gap-1.5 rounded-lg border ' +
        'border-border bg-popover px-2 shadow-md transition-colors duration-300',
    },
    h(
      Button,
      {
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': isMinimapOpen ? '关闭小地图' : '打开小地图',
        onClick: () => setIsMinimapOpen((value: boolean) => !value),
        className: cn(isMinimapOpen && 'bg-accent text-foreground'),
      },
      h(MapIcon, null),
    ),
    h(
      Button,
      {
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '显示所有节点',
        title: '显示所有节点',
        onClick: () => onResetCanvas(nodes),
      },
      h(MaximizeIcon, null),
    ),
    h(Separator, { orientation: 'vertical', className: 'mx-0.5 h-5' }),
    h(ZoomInIcon, { className: 'size-3.5 text-muted-foreground' }),
    h(Slider, {
      'aria-label': '画布缩放',
      min: 5,
      max: 500,
      step: 5,
      value: [Math.max(5, Math.min(500, Math.round(viewport.zoom * 100)))],
      onValueChange: zoomFromSlider,
      className: 'w-20',
    }),
    h(
      'button',
      {
        type: 'button',
        title: '点击恢复 100%',
        // 真机验收（scripts/verify-live-zoom.mjs）与 jsdom 回归都读这个属性，
        // 不必去猜缩放条里那串文本的格式。
        'data-fisherai-zoom-value': String(Math.round(viewport.zoom * 100)),
        onClick: () =>
          onSliderZoom({
            target: { value: '1' },
          } as unknown as ReactTypes.ChangeEvent<HTMLInputElement>),
        className:
          'min-w-9 rounded-sm px-1 text-right text-[11px] font-semibold tabular-nums ' +
          'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
      },
      `${Math.round(viewport.zoom * 100)}%`,
    ),
  );

  const helper =
    view === 'canvas'
      ? h(
          Popover,
          { open: helpOpen, onOpenChange: setHelpOpen, modal: false },
          h(
            PopoverTrigger,
            {
              'aria-label': '快捷键说明',
              title: '快捷键说明',
              className: cn(
                'absolute bottom-6 left-[260px] z-50 flex h-[42px] w-[42px] items-center justify-center',
                'text-muted-foreground transition-colors hover:text-foreground',
              ),
            },
            h(CircleHelpIcon, { className: 'size-5' }),
          ),
          h(
            PopoverContent,
            { side: 'top', align: 'start', className: 'w-72 p-3' },
            h(
              'div',
              { className: 'mb-2 flex items-center gap-2' },
              h(KeyboardIcon, { className: 'size-3.5 text-muted-foreground' }),
              h('span', { className: 'text-xs font-semibold' }, '快捷键说明'),
            ),
            h(
              'div',
              { className: 'flex flex-col gap-1.5' },
              SHORTCUTS.map(([label, keys]) =>
                h(
                  'div',
                  { key: label, className: 'flex items-center justify-between gap-3 text-xs' },
                  h('span', { className: 'text-muted-foreground' }, label),
                  h(Kbd, null, keys),
                ),
              ),
            ),
          ),
        )
      : null;

  const gridPanel =
    showGridSlider && selectedNodeIds.length > 1 && view === 'canvas'
      ? h(
          'div',
          {
            role: 'dialog',
            'aria-label': '排列选中节点',
            className:
              'absolute left-1/2 top-6 z-[10000] flex w-64 -translate-x-1/2 flex-col gap-3 ' +
              'rounded-lg border border-border bg-popover p-3 shadow-lg',
            onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
            onKeyDown: (event: ReactTypes.KeyboardEvent) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setShowGridSlider(false);
              }
            },
          },
          h(
            'div',
            { className: 'flex flex-col gap-2' },
            h(
              'div',
              { className: 'flex items-center justify-between' },
              h('span', { className: 'text-xs font-medium text-muted-foreground' }, '宫格列数'),
              h(
                'span',
                {
                  className:
                    'min-w-6 rounded-full bg-secondary px-1.5 text-center text-xs font-semibold tabular-nums',
                },
                String(gridColumns),
              ),
            ),
            h(Slider, {
              'aria-label': '宫格列数',
              min: 1,
              max: 10,
              step: 1,
              value: [gridColumns],
              onValueChange: (values: number[]) => {
                const columns = Math.round(values[0] ?? gridColumns);
                setGridColumns(columns);
                onGridLayout(columns, isCompact);
              },
            }),
          ),
          h(Separator, null),
          h(
            'div',
            { className: 'flex items-center justify-between' },
            h('span', { className: 'text-xs text-muted-foreground' }, '紧凑模式'),
            h(Switch, {
              'aria-label': '紧凑模式',
              checked: isCompact,
              onCheckedChange: (compact: boolean) => {
                setIsCompact(compact);
                onGridLayout(gridColumns, compact);
              },
            }),
          ),
          h(
            Button,
            {
              type: 'button',
              variant: 'secondary',
              size: 'sm',
              onClick: () => setShowGridSlider(false),
            },
            '完成',
          ),
        )
      : null;

  /**
   * 节点搜索面板（Shift+A，仿 Blender 的搜索节点）。
   *
   * 它自己装 keydown 监听、自己派发 `fisherai:add-canvas-node`，所以这里只是把它挂进
   * 画布容器（`useCanvasReact` 会把「渲染器那一份 React」注册好，组件内部直接用它建元素）。
   * 为什么挂在 Controls 里：vendor 只给这一个槽位同时喂了 view / viewport / canvasRef /
   * documentEpoch，而这几样正是「把面板放在鼠标旁边」需要的，不必为此新增依赖契约。
   */
  const nodeSearch =
    view === 'canvas'
      ? react.createElement(CanvasNodeSearchBound, {
          key: 'node-search',
          view,
          viewport,
          canvasRef,
          containerRef: canvasRef,
        })
      : null;

  /**
   * 「ComfyUI 工作流配置」面板（左栏那个入口按钮触发）。
   *
   * 挂这里而不是挂侧边栏：侧边栏槽位拿不到 viewport，而「直接添加到画布」要把节点落在
   * 画布正中 —— 换算世界坐标必须用这份 viewport。
   */
  const workflowConfig =
    view === 'canvas'
      ? react.createElement(ComfyWorkflowConfigBound, {
          key: 'workflow-config',
          view,
          viewport,
        })
      : null;

  /**
   * 「任务队列」面板（v1.24）：常驻画布右侧，可收起成右缘窄轨道。
   *
   * 用户要求原话：「在画布右侧添加一个任务队列面板，显示简易参数，如时间等，
   * 正在运行的任务要有边框循环发光特效」。轮询与数据都在组件里（host `/tasks`）。
   */
  const taskQueue =
    view === 'canvas' ? react.createElement(TaskQueueBound, { key: 'task-queue', view }) : null;

  /**
   * 「工作流节点」面板（v1.28，左栏那个「工作流节点」按钮打开）：
   * 配置好的 ComfyUI 工作流按图卡片陈列，点卡片直接放到画布正中，配图可自定义。
   */
  const workflowLibrary =
    view === 'canvas'
      ? react.createElement(WorkflowLibraryBound, {
          key: 'workflow-library',
          view,
          viewport,
          canvasRef,
        })
      : null;

  /**
   * 「项目归档」面板（v1.42，头部那个归档按钮打开）：导出当前项目 / 导入一份备份。
   * 只认 view 与 projectId —— 面板本身不依赖画布落点。
   */
  const projectArchive =
    view === 'canvas'
      ? react.createElement(ProjectArchiveBound, {
          key: 'project-archive',
          view,
          projectId,
        })
      : null;

  return h(
    react.Fragment,
    null,
    view === 'canvas' && isMinimapOpen
      ? h(Minimap, {
          nodes,
          canvasRef,
          documentEpoch,
          viewport,
          onViewportChange,
          width: minimapWidth,
          height: minimapWidth * 0.6,
        })
      : null,
    zoomBar,
    helper,
    gridPanel,
    nodeSearch,
    workflowConfig,
    taskQueue,
    workflowLibrary,
    projectArchive,
  );
}

CanvasViewportControls.displayName = 'CanvasViewportControlsShadcn';
