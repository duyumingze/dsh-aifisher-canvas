/**
 * 画布应用装配层（对应上游 app/canvasRuntime.tsx 的 dependencies 对象）。
 *
 * 上游那份把 Dependencies 的每一项接到真实实现上；我们这份基本沿用，全部接到上游实现。
 * 两条生成链路都在：云端模型（useGeneration → POST /generate-<kind>，host 侧方舟直连
 * 与通用 OpenAI 兼容端点）与本地 ComfyUI 工作流（useLocalWorkflows → POST /comfy/<工作流>）。
 *
 * 其余 hook（viewport / nodes / connections / drag / resize / marquee / groups /
 * history / workflow / commands / contextMenu / assets / presets / textActions /
 * 抽帧 / 音频裁剪 / 结果回收 …）全部直接用上游实现：它们是纯画布逻辑，后端交互只发生在
 * 具体动作里，而画布的一切 HTTP 已经被 vendor 阶段改写到 /api/aifisher/canvas/*（我们自己的本地后端）。
 */
import * as React from 'react';
import { toPng } from 'html-to-image';
import { FolderOpenIcon, LogOutIcon, SaveIcon } from 'lucide-react';

import { CanvasApplication } from '../../../vendor/aifisher/src/stable/canvas/canvasApplication';
import type { Dependencies } from '../../../vendor/aifisher/src/stable/canvas/canvasApplicationDependencies';
import * as Components from '../../../vendor/aifisher/src/stable/app/canvasComponents';
import { CanvasHeader } from '../../canvas-ui/canvas/CanvasHeader';
import { CanvasSidebar } from '../../canvas-ui/canvas/CanvasSidebar';
import { CanvasMinimap } from '../../canvas-ui/canvas/CanvasMinimap';
import { CanvasViewportControls } from '../../canvas-ui/canvas/CanvasViewportControls';
import { CanvasImageAnnotation } from '../../canvas-ui/canvas/CanvasImageAnnotation';
import { CanvasImageStudio } from '../../canvas-ui/canvas/CanvasImageStudio';
import { CanvasImageResize } from '../../canvas-ui/canvas/CanvasImageResize';
import { requestCanvasNodeSearch } from '../../canvas-ui/canvas/CanvasNodeSearchStore';
import { requestComfyWorkflowConfig } from '../../canvas-ui/canvas/ComfyWorkflowConfigStore';
import { requestCanvasWorkflowLibrary } from '../../canvas-ui/canvas/CanvasWorkflowLibraryStore';
import { avatarClass, avatarColor, avatarText } from '../../../vendor/aifisher/src/stable/profile/canvasAvatar';
import { useLocalUser } from '../../../vendor/aifisher/src/stable/profile/localUser';
import {
  IMAGE_MODELS,
  VIDEO_MODELS,
  TEXT_MODELS,
  AUDIO_MODELS,
} from '../../../vendor/aifisher/src/config/modelConfig';
import * as Rules from '../../../vendor/aifisher/src/stable/nodes/canvasNodeRules';
import * as Editor from '../../../vendor/aifisher/src/stable/canvas/canvasEditorHooks';
import * as Nodes from '../../../vendor/aifisher/src/stable/nodes/canvasNodeState';
import type {
  CanvasNode,
  NodeRuntime,
} from '../../../vendor/aifisher/src/stable/nodes/canvasNodeOperations';
import * as Media from '../../../vendor/aifisher/src/stable/media/canvasMediaOperations';
import * as Generation from '../../../vendor/aifisher/src/stable/generation/canvasGeneration';
import { useCanvasViewport } from '../../../vendor/aifisher/src/stable/canvas/canvasViewport';
import { useCanvasPanels } from '../../../vendor/aifisher/src/stable/dialogs/canvasPanels';
import { useCanvasWorkflow } from '../../../vendor/aifisher/src/stable/persistence/canvasWorkflow';
import { useCanvasAutoSave } from '../../../vendor/aifisher/src/stable/persistence/canvasAutoSaveLifecycle';
import { useCanvasCommands } from '../../../vendor/aifisher/src/stable/canvas/canvasCommands';
import { useCanvasWorkflowPresets } from '../../../vendor/aifisher/src/stable/canvas/canvasWorkflowPresets';
import { useRecovery, type RecoveryOptions } from '../../../vendor/aifisher/src/stable/app/useRecovery';

const catalog = {
  image: IMAGE_MODELS,
  video: VIDEO_MODELS,
  text: TEXT_MODELS,
  audio: AUDIO_MODELS,
};
const models = {
  imageModels: IMAGE_MODELS,
  videoModels: VIDEO_MODELS,
  textModels: TEXT_MODELS,
  audioModels: AUDIO_MODELS,
};
const createId = () => crypto.randomUUID();
const nodeRuntime: NodeRuntime = {
  ...models,
  createId,
  templates: Rules.workflowTemplates,
  mediaType: Rules.nodeMediaKind,
  canConnect: (source, target, nodes, port) =>
    Rules.chooseConnectionMode(source, target, nodes, port, catalog),
  validateConnection: (source, target, nodes, model, mode, port) =>
    Rules.validateConnection(source, target, nodes, model, mode, port, catalog),
};

type Options = Record<string, unknown>;
/** 上游把文档扩展字段透传给 hook，这里保持同样的宽松签名。 */
function optionsHook<O, Result>(hook: (options: O) => Result) {
  return (options: Options) => hook(options as O);
}
function view(component: unknown): Dependencies['Projects'] {
  return component as Dependencies['Projects'];
}
/**
 * 视图槽位替换：把「(React, props, ...injected)」形状的实现包成 React 组件。
 *
 * 三条必须遵守的约定（都是踩过坑才定下来的，改动前先看 docs/canvas-ui-shadcn.md）：
 *   1. 注入的 React 必须是**画布渲染器那一份**。产物里 React 有两份副本
 *      （vendor 画面包一份、shadcn 组件自己的 import 一份），hooks 分发器各管各的；
 *      用错那分量 React 19 既不报错也不渲染 —— 表现成「头部/工具条整块消失」。
 *      所以实现签名固定为 `(react, props, ...injected)`，这里把本文件的 React 传进去。
 *   2. 依赖注入形状与 vendor 的 `bind()` 一致：`render(React, props, ...deps())`，
 *      工厂返回对象 → 实现拿到一个对象参数（返回数组则数组本身成为一个参数）。
 *   3. 不要再套 vendor 的 `bind()` 来二次包装：它自己会注入一份 React，
 *      两层包装会让注入参数错位。
 */
function bindView(implementation: unknown, injected: () => unknown | unknown[]) {
  const render = implementation as (
    react: typeof React,
    props: unknown,
    ...injected: unknown[]
  ) => React.ReactNode;
  const Bound = (props: Record<string, unknown>) => {
    const deps = injected();
    return render(React, props, ...(Array.isArray(deps) ? deps : [deps]));
  };
  const name = (implementation as { displayName?: string })?.displayName ?? 'CanvasView';
  Bound.displayName = `${name}Bound`;
  return Bound as unknown as Dependencies['Header'];
}

/**
 * 与 bindView 同形，但允许在**注入对象**上再补几个字段（对应实现的第三个参数）。
 *
 * ⚠️ 只对「从注入对象里读」的槽位有效。如果实现是从 `props` 里读那个字段（例如侧边栏的
 *    `props.onSearchClick`），补在注入对象上它永远拿不到 —— 表现成「按钮点了没反应」。
 *    所以侧边栏那份绑定直接把 onClick 写进 props（见 CanvasSidebarBound）。
 */
function bindViewWithExtras(
  implementation: unknown,
  extras: () => Record<string, unknown>,
  injected: () => unknown,
) {
  const render = implementation as (
    react: typeof React,
    props: unknown,
    ...injected: unknown[]
  ) => React.ReactNode;
  const Bound = (props: Record<string, unknown>) =>
    render(React, props, { ...(injected() as object), ...extras() });
  const name = (implementation as { displayName?: string })?.displayName ?? 'CanvasView';
  Bound.displayName = `${name}Bound`;
  return Bound;
}

/**
 * 各槽位的「注入依赖工厂」。单独抽出来是为了：
 *   ① 形状一目了然（对象 vs 数组，见 bindView 的约定）；
 *   ② 诊断接口能把它们回报出来 —— 注入形状写错是「组件不渲染」的头号原因。
 */
const viewInjections = {
  header: () => ({
    SaveIcon: SaveIcon,
    ImportIcon: FolderOpenIcon,
    BackIcon: LogOutIcon,
  }),
  sidebar: () => ({
    Tooltip: Components.Tooltip,
    avatarClass: avatarClass,
    avatarText: avatarText,
  }),
  minimap: () => ({
    width: Rules.nodeWidth,
    height: Rules.nodeHeight,
  }),
  /**
   * 小地图的槽位绑定**在模块级建一次**（不是每次渲染都 bindView 一遍）。
   *
   * 踩过：写成 `controls: () => ({ Minimap: bindView(CanvasMinimap, …) })` 时，
   * 每次 Controls 渲染都会造出一个新的组件类型，React 认为「类型变了」就**卸载重挂**
   * 整棵子树 —— 小地图的拖拽状态会丢，而挂在同一个槽位里的面板（节点搜索 / ComfyUI 工作流配置）
   * 更惨：重挂载会把本地 useState 归零（表现成「点保存/添加后面板关不掉、提示也不见」）。
   * 组件类型必须稳定，见 CanvasViewportControlsBound / CanvasSidebarBound 的注释。
   */
  /**
   * ⚠️ 小地图的绑定**必须用模块级那个常量**（`MinimapBound`，见下面）。
   * 写成 `Minimap: bindView(CanvasMinimap, …)` 会在每次 Controls 渲染时造出一个新组件类型，
   * React 认为「类型变了」就卸载重挂整棵子树 —— 小地图拖拽状态丢失，而挂在同一个槽位里的
   * 面板（节点搜索 / ComfyUI 工作流配置）更惨：重挂载会把本地 useState 归零，
   * 表现成「点了保存/添加之后面板关不掉、提示也不见」。
   */
  controls: () => ({
    Minimap: MinimapBound,
  }),
  /**
   * 图片标注 / 图片编辑（v1.26）。
   *
   * 这两块原来是 vendor 原样外观（docs/canvas-ui-shadcn.md 第五节的遗留项）。
   * 新实现不再从 vendor 取 `CropEditor/Annotation/Composite` 三个依赖 —— 裁剪与标注
   * 的舞台都在 `src/canvas-ui/canvas/` 里，几何仍复用 vendor 的纯函数；
   * 只有「组合」（多图层）和「宫格/全景/角度」这几种模式回落到 vendor 的同一组组件。
   * 所以注入对象是空的，形状仍然保持「一个对象」（见 bindView 的三条约定）。
   */
  annotation: () => ({}),
  crop: () => ({}),
  /**
   * 「尺寸」对话框（v1.38）。
   *
   * 注入对象是空的：新实现自己用 shadcn Button + lucide 图标，Size 换算仍 import vendor
   * 的 `imageResizeGeometry`（等比规则与上限一字不动）。这里只保留「一个对象」的形状，
   * 因为 bindView 会把它整体作为第三个参数传进去。
   */
  resize: () => ({}),
};

/** 小地图槽位绑定（模块级建一次，类型稳定）。 */
const MinimapBound = bindView(CanvasMinimap, viewInjections.minimap);

/**
 * 图片标注 / 图片编辑槽位（v1.26）。
 *
 * ⚠️ 同样必须**模块级建一次**：这两个槽位在 `canvasApplication` 里是
 * `React.createElement(Annotation/Crop, { key, node, … })`，组件类型一变就会卸载重挂
 * （标注到一半的笔迹、裁剪选区会凭空消失）。见上面小地图那段踩坑记录。
 */
const AnnotationBound = bindView(CanvasImageAnnotation, viewInjections.annotation);
const CropBound = bindView(CanvasImageStudio, viewInjections.crop);
/** 尺寸对话框（v1.38）：同样是模块级建一次，避免每次渲染造出新组件类型把输入框状态清掉。 */
const ResizeBound = bindView(CanvasImageResize, viewInjections.resize);

/** 排查用：把每个槽位真正收到的「注入依赖」形状回报出来（不渲染，避免踩 hooks 规则）。 */
export function canvasViewInjectionReport(): Record<string, string> {
  const report: Record<string, string> = {};
  for (const [name, factory] of Object.entries(viewInjections)) {
    try {
      const value = factory();
      report[name] = Array.isArray(value)
        ? `array(${value.length})`
        : `keys=${Object.keys((value ?? {}) as object).join('|')}`;
    } catch (error) {
      report[name] = `throw: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return report;
}

/** 节点搜索面板需要的、由我们额外注入给 Controls 的值。 */
interface NodeSearchInjections {
  nodeSearchRequest: number;
}

/**
 * Controls / Sidebar 的槽位绑定：视图组件**在模块级建一次**，wrapper 只负责补 props。
 *
 * 为什么不能每次渲染都 `bindView(...)`（踩过，v1.16）：那样会造出一个新的组件类型，
 * React 按「类型变了」卸载重挂整棵子树 —— 槽位里那些带本地状态的东西（小地图拖拽、
 * 节点搜索面板、ComfyUI 工作流配置面板）会被重置。表现：「点保存/添加到画布之后面板关不掉」
 * （旧闭包里的 setOpen 打空）、「保存成功提示一闪就没」。
 */
const ControlsViewBound = bindView(CanvasViewportControls, viewInjections.controls) as unknown as
  React.ComponentType<Record<string, unknown>>;

function CanvasViewportControlsBound(props: Record<string, unknown>) {
  return React.createElement(ControlsViewBound, props);
}

/**
 * 侧边栏槽位绑定：把「搜索节点」「ComfyUI 工作流配置」两个按钮接到请求通路上。
 *
 * ⚠️ `onSearchClick` / `onWorkflowConfigClick` 必须写进 **props**（侧边栏的实现是从 props
 *    里读它们，不是从注入对象里读）。注入对象只给 Tooltip / avatar*（vendor 的
 *    `viewInjections.sidebar`）。
 */
const SidebarViewBound = bindView(CanvasSidebar, viewInjections.sidebar) as unknown as
  React.ComponentType<Record<string, unknown>>;

function CanvasSidebarBound(props: Record<string, unknown>) {
  return React.createElement(SidebarViewBound, {
    ...props,
    onSearchClick: () => requestCanvasNodeSearch(),
    onWorkflowConfigClick: () => requestComfyWorkflowConfig(),
    // v1.28：左栏「工作流节点」不再接 onAddClick（那是画布右键菜单），改开工作流节点面板
    onWorkflowNodesClick: () => requestCanvasWorkflowLibrary(),
  });
}

const dependencies: Dependencies = {
  usePanels: () => useCanvasPanels(React),
  useTitle: () => Editor.useCanvasTitle(React),
  useViewport: () =>
    useCanvasViewport(
      React,
      (node) => Rules.nodeWidth(node as CanvasNode),
      (node) => Rules.nodeHeight(node as CanvasNode),
    ),
  useNodes: () =>
    Nodes.useCanvasNodes(React, {
      ...nodeRuntime,
      getWidth: Rules.nodeWidth,
      layout: function useLayout(options) {
        return Editor.useCanvasLayout(options, {
          getWidth: Rules.nodeWidth,
          getHeight: Rules.nodeHeight,
          horizontalGap: 40,
          verticalGap: 40,
        });
      },
    }),
  useConnections: () =>
    Editor.useCanvasConnections(React, {
      getWidth: Rules.nodeWidth,
      getHeight: Rules.nodeHeight,
      templates: Rules.workflowTemplates,
      canConnect: nodeRuntime.canConnect,
      getPortTop: Rules.legacyWorkflowPortTop,
      portHeight: Rules.portHeight,
      portGap: Rules.portGap,
      workflow: () => window.__FISHERAI_WORKFLOW_NODES__,
      minimax: () => window.__FISHERAI_MINIMAX_H3__,
    }),
  useDrag: () => Editor.useCanvasDrag(React),
  useResize: () => Editor.useCanvasResize(React),
  useMarquee: () =>
    Editor.useCanvasMarquee(
      React,
      (node) => Rules.nodeWidth(node as CanvasNode),
      (node, parent) => Rules.nodeHeight(node as CanvasNode, parent as CanvasNode | undefined),
    ),
  useGroups: () => Editor.useCanvasGroups(React, createId),
  useEdgePan: optionsHook((options: Parameters<typeof Editor.useCanvasEdgePan>[1]) =>
    Editor.useCanvasEdgePan(React, options),
  ),
  useHistory: (initial, limit) => Editor.useCanvasHistory(React, initial, limit),
  useWorkflow: optionsHook((options: Parameters<typeof useCanvasWorkflow>[1]) =>
    useCanvasWorkflow(React, options),
  ) as Dependencies['useWorkflow'],
  useLocalUser: () => useLocalUser(React),
  userColorForId: avatarColor,
  NodeStatus: Rules.nodeStatuses,
  NodeType: Rules.nodeTypes,

  // ---- 生成：云端模型（/generate-image|video|audio|text）用上游实现 ----
  // 这里曾经是空实现（早期 host 半没有云端 provider，调了只会 console.warn，表现是
  // 「点生图没反应」）。v1.4 起 host 侧两条路都有了：方舟直连（arkImageProvider）与
  // 通用 OpenAI 兼容端点（cloudGenerationRouter），所以直接用上游的 useCanvasGeneration ——
  // 它自己负责 buildXxxRequest → POST /generate-<kind> → 把 resultUrl 写回节点。
  // 本地 ComfyUI 工作流不走这里：它们由 useLocalWorkflows 直接调 /comfy/<工作流>（见下）。
  useGeneration: optionsHook((options: Parameters<typeof Generation.useCanvasGeneration>[1]) =>
    Generation.useCanvasGeneration(React, { ...options, ...models }),
  ) as unknown as Dependencies['useGeneration'],
  // ---- 抽帧 / 音频裁剪：走 host 的媒体加工端点（mediaEditingRouter，ffmpeg）----
  useSnapshots: optionsHook((options: Parameters<typeof Media.useCanvasSnapshots>[1]) =>
    Media.useCanvasSnapshots(React, options),
  ),
  useAudioTrim: optionsHook((options: Parameters<typeof Media.useCanvasAudioTrim>[1]) =>
    Media.useCanvasAudioTrim(React, options),
  ),

  useTextActions: optionsHook((options: Parameters<typeof Nodes.createCanvasTextActions>[0]) =>
    Nodes.createCanvasTextActions(options, nodeRuntime),
  ),
  useLocalWorkflows: optionsHook(
    (options: Parameters<typeof Generation.useCanvasLocalWorkflows>[1]) =>
      Generation.useCanvasLocalWorkflows(React, options, createId),
  ),
  useAssets: optionsHook((options: Parameters<typeof Media.useCanvasAssets>[1]) =>
    Media.useCanvasAssets(React, options),
  ),
  usePresets: optionsHook((options: Parameters<typeof useCanvasWorkflowPresets>[1]) =>
    useCanvasWorkflowPresets(React, options, {
      width: Rules.nodeWidth,
      height: Rules.nodeHeight,
      capture: toPng,
    }),
  ),
  useCommands: optionsHook((options: Parameters<typeof useCanvasCommands>[2]) =>
    useCanvasCommands(React, createId, options),
  ),
  useAutoSave: optionsHook((options: Parameters<typeof useCanvasAutoSave>[1]) =>
    useCanvasAutoSave(React, options),
  ),
  // 结果回收：轮询 /generation-status/:nodeId 把断线/刷新期间跑完的结果补回节点；
  // 图片侧（framesOnly）还负责给成功产出的视频补最后一帧预览。host 两条路都实现了
  // （任务日记 + 素材库侧车反查），所以这里用回上游实现。
  useVideoResults: optionsHook((options: RecoveryOptions) => useRecovery(options, false)),
  useImageResults: optionsHook((options: RecoveryOptions) => useRecovery(options, true)),
  useContextMenu: optionsHook((options: Parameters<typeof Nodes.useCanvasContextMenu>[1]) =>
    Nodes.useCanvasContextMenu(React, options),
  ),
  media: Media,
  getNodeWidth: Rules.nodeWidth,
  getNodeHeight: Rules.nodeHeight,
  createId,
  textForNode: (node) =>
    node.type === Rules.nodeTypes.TEXT && typeof node.textContent === 'string'
      ? node.textContent
      : '',

  // ---- 视图组件 ----
  // shadcn/ui 重设计的第一波只换「核心操控面」这四个视图组件（头部栏 / 左侧工具条 /
  // 缩放控件与小地图），其余仍走 vendor 实现。vendor 树一个字没改：这里换的是
  // dependencies 槽位，而 vendor 的 canvasComponents.ts 已经给了我们注入点。
  //
  // ⚠️ 注入形状必须与 vendor 一致：`bind()` 是 `render(React, props, ...deps())`，
  //    所以这里返回的每一项会**各自成为一个参数** —— 返回对象就一次传一个对象，
  //    返回数组会把数组本身当成一个参数（`() => [{...}]` 会让实现拿到数组、
  //    于是 `components.Tooltip` 是 undefined，React 抛 #130）。vendor 上游用的是对象，
  //    我们保持一致：`Header` 的实现签名是「一个 icons 对象」，`Sidebar/Controls` 是
  //    「一个 components 对象」，`Minimap` 是「一个 measure 对象」。
  Projects: view(Components.ProjectDashboard),
  Settings: view(Components.Settings),
  Header: bindView(CanvasHeader, viewInjections.header),
  Sidebar: CanvasSidebarBound as unknown as Dependencies['Sidebar'],
  Scene: view(Components.Scene),
  Controls: CanvasViewportControlsBound as unknown as Dependencies['Controls'],
  SidePanels: view(Components.SidePanels),
  Overlays: view(Components.Overlays),
  Annotation: AnnotationBound as unknown as Dependencies['Annotation'],
  Crop: CropBound as unknown as Dependencies['Crop'],
  Resize: ResizeBound as unknown as Dependencies['Resize'],
};

/** 画布的根组件：上游 canvasRuntime.tsx 的 CanvasRoot 等价物。 */
export function CanvasStage() {
  return CanvasApplication(React, dependencies);
}

/** 排查用：视图槽位到底是函数、对象还是没接上。 */
export function canvasBindingReport(): Record<string, string> {
  // 注意：这里**不能**脱开 React 直接调用组件函数（那会踩 Invalid hook call），
  // 只报告槽位的类型即可；组件是否真的渲染出来由回归脚本查 DOM。
  const report: Record<string, string> = {};
  for (const [key, value] of Object.entries(dependencies)) report[key] = typeof value;
  return report;
}
