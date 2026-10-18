/**
 * 画布应用入口（浏览器 ESM，由 CanvasPanel 动态 import）。
 *
 * 这一层只干三件事：
 *   1. 注入画布样式；
 *   2. 跑 AIFISHER 的「应用装配」（那些 installXxx：剪贴板/连线/编组/快捷键/window 全局…）；
 *   3. 在给定容器里用**自带的 React 19** 起一个独立 root 渲染 CanvasApplication。
 *
 * 为什么要独立 root + 自带 React：
 *   AIFISHER 上游是 React 19，DSH 模块表给插件的是 React 18。hooks 分发器只能有一个，
 *   把 React 19 的 hook 调用挂到 React 18 的渲染器上会直接崩。两者彻底隔开最稳：
 *   DSH 那边只是渲染一个空容器 <div>，画布在自己的 root 里跑。
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { setCanvasPortalTarget } from '../../canvas-ui/lib/portal';
import { useCanvasReact } from '../../canvas-ui/lib/react';
import { canvasNodeSearchReport } from '../../canvas-ui/canvas/CanvasNodeSearchStore';
import { canvasLastModelReport } from '../../canvas-ui/canvas/CanvasLastModel';
import { buildNodeSearchCatalog } from '../../canvas-ui/canvas/CanvasNodeSearchRank';
import { installCanvasStyles } from './styles';
import { installCanvasBootstrap, bootstrapInstallerNames } from './bootstrap';
import { CanvasStage, canvasBindingReport, canvasViewInjectionReport } from './stage';
import { installCanvasDiagnostics, reportCanvasError, reportCanvasInfo } from './diagnostics';
import { canvasGridReport, mountCanvasGrid } from './canvasGrid';

export interface CanvasHandle {
  /** 卸载画布：root.unmount + 撤销装配 + 移除样式。 */
  dispose(): void;
}

/**
 * 错误边界：画布任何组件抛错都不能白屏到无从排查 —— 就地渲染可读信息，
 * 并把异常 POST 回 host（/api/aifisher/canvas/diagnostics），agent 能直接读到。
 */
class CanvasErrorBoundary extends React.Component<
  { children?: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children?: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // 排查用：把首个画布异常留在全局，脚本可以直接读（不必翻控制台）。
    const globals = globalThis as unknown as {
      __DSH_CANVAS_LAST_ERROR__?: { message: string; stack?: string; componentStack?: string };
    };
    globals.__DSH_CANVAS_LAST_ERROR__ ??= {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    };
    reportCanvasError(`画布组件异常：${error.message}`, {
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  render() {
    if (!this.state.error) return this.props.children ?? null;
    return React.createElement(
      'div',
      {
        style: {
          padding: 24,
          color: '#f2b8b5',
          font: '13px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
      },
      React.createElement('strong', null, '画布渲染出错'),
      React.createElement('pre', { style: { whiteSpace: 'pre-wrap', color: '#cfd3dc' } },
        this.state.error.message,
        '\n',
        this.state.error.stack ?? '',
      ),
    );
  }
}

/** 画布构建信息：排查「页面拿的是不是新代码」用。 */
export function canvasAppBuildInfo(): Record<string, unknown> {
  return {
    entry: 'lib/canvas/canvas-app.js',
    installers: bootstrapInstallerNames(),
    react: (React as unknown as { version?: string }).version ?? 'unknown',
    bindings: canvasBindingReport(),
    injections: canvasViewInjectionReport(),
    grid: canvasGridReport(),
    // 节点搜索：请求计数 / 订阅者数 / 候选目录规模（「Shift+A 没反应」时先看这几个数）
    nodeSearch: {
      ...canvasNodeSearchReport(),
      candidates: buildNodeSearchCatalog().length,
      panel: document.querySelector('[data-fisherai-node-search-panel]') ? 'open' : 'closed',
    },
    // 新节点默认模型（v1.40）：按 kind 记着的模型 + 存档状态 + 命中/未命中次数
    // （「新建节点还是旧模型」时先看这里：是没记上，还是记着的模型已经不在目录里）
    lastModel: canvasLastModelReport(),
  };
}

/** 排查用：画布点阵底纹的实时状态（原样转出 canvasGrid 的探针）。 */
export { canvasGridReport } from './canvasGrid';

/**
 * 排查用 / 回归用：叠图切换的纯逻辑（v1.37）。
 * 转出来是为了让 jsdom 回归能在**构建产物**上直接验算法（环形、壳字段不动、不丢图），
 * 不必先摆一屏幕节点再点 —— 真点击那条路由 test-canvas-stack 的另一半守着。
 */
export { rotateStackHost, stackCounterOf, stackPositionOf, stackReport, stackTotalOf } from '../../canvas-ui/canvas/CanvasStack';
export type { StackNode } from '../../canvas-ui/canvas/CanvasStack';

/**
 * 排查用 / 回归用：「扩图」的纯逻辑（v1.38 引入，v1.39 扩成「几何 + 两张节点」）。
 * 与叠图切换同一条理由 —— 回归在**构建产物**上直接验「九宫格/比例 → 画布几何 / 提示词 /
 * 两张节点的字段」，不必先摆一屏节点点按钮；真点击那条路由 `test-canvas-outpaint` 的另一半守着
 * （真实绘制像素在 browser-check 的 outpaint 场景里量）。
 */
export {
  anchorSpec,
  assertOutpaintSource,
  buildOutpaintPlan,
  defaultOutpaintRatio,
  OUTPAINT_ANCHORS,
  OUTPAINT_COMPOSITE_TITLE,
  OUTPAINT_MAX_SIDE,
  outpaintGeometry,
  outpaintModelName,
  outpaintPrompt,
  outpaintRatioValue,
  outpaintRatios,
  outpaintReport,
  outpaintSourceSize,
  outpaintTitle,
  resolveOutpaintModel,
  supportsImageToImage,
} from '../../canvas-ui/canvas/CanvasOutpaint';
export type {
  OutpaintAnchor,
  OutpaintAnchorSpec,
  OutpaintGeometry,
  OutpaintOptions,
  OutpaintPlan,
  OutpaintSource,
} from '../../canvas-ui/canvas/CanvasOutpaint';

/**
 * 排查用 / 回归用：「新节点默认用上一次的模型」的纯逻辑（v1.40）。
 *
 * 与叠图切换、扩图同一条理由 —— 回归在**构建产物**上直接验「按 kind 分桶 / 只认还留在目录里的名字 /
 * 存档读写」，不必先摆一屏节点点下拉；真点下拉那半条路由 `test-canvas-last-model` 的另一半
 * 与 browser-check 的场景守着。
 */
export {
  asCanvasModelKind,
  CANVAS_LAST_MODEL_STORAGE_KEY,
  CANVAS_MODEL_KINDS,
  canvasLastModelReport,
  lastModelFor,
  pickCanvasModel,
  rememberLastModel,
  resetCanvasLastModel,
} from '../../canvas-ui/canvas/CanvasLastModel';
export type {
  CanvasLastModelSnapshot,
  CanvasModelKind,
} from '../../canvas-ui/canvas/CanvasLastModel';

/** 主题镜像：画布容器跟着 `html[data-af-theme]` 走，浮层才拿得到同一套 shadcn token。 */
function mirrorCanvasTheme(container: HTMLElement): () => void {
  const root = document.documentElement;
  const apply = () => {
    const theme = root.dataset.afTheme;
    if (theme === 'light' || theme === 'dark') {
      container.dataset.afTheme = theme;
      container.classList.toggle('dark', theme === 'dark');
    }
  };
  apply();
  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(apply)
      : null;
  observer?.observe(root, { attributes: true, attributeFilter: ['data-af-theme'] });
  return () => observer?.disconnect();
}

/**
 * 在 container 里挂载 AIFISHER 画布。
 * 返回的 handle 必须在组件卸载时 dispose，否则会留下全局定时器/监听器。
 */
export function mountCanvas(container: HTMLElement): CanvasHandle {
  const releaseDiagnostics = installCanvasDiagnostics();
  const releaseStyles = installCanvasStyles();
  const releaseBootstrap = installCanvasBootstrap();
  // shadcn/Radix 的浮层要 portal 进画布容器内部（否则读到 DSH 那份主题变量，
  // 而且卸载时会把浮层留在 DSH 页面上）。见 src/canvas-ui/lib/portal.ts。
  setCanvasPortalTarget(container);
  // 画布内 shadcn 组件必须用「渲染器认的那份 React」造元素（产物里 React 有两份）。
  useCanvasReact(React);
  const releaseThemeMirror = mirrorCanvasTheme(container);

  const root: Root = createRoot(container);
  root.render(
    React.createElement(CanvasErrorBoundary, null, React.createElement(CanvasStage)),
  );

  // 画布点阵底纹（小十字 + 鼠标周围圆形变亮）。它是纯 DOM 层，插在 vendor 的
  // `#canvas-background` 底盘里当第一个孩子（=画在所有节点下方），所以不碰 vendor 树。
  // 挂载时机在 root.render 之后：底盘要等这一帧渲染完才存在，mountCanvasGrid 自己会用
  // MutationObserver 等它出现（dashboard 视图下没有底盘，切进画布时才挂上）。
  const releaseGrid = mountCanvasGrid({ container });

  // 构建信息上报放在这里（而不是 root.render 之前）：grid 段要等这一帧渲染完才拿得到
  // 真实状态（底盘出现 → 网格挂上），否则回报的永远是「未挂载」。
  reportCanvasInfo('画布应用已加载', canvasAppBuildInfo());

  // 布局自检：画布是绝对定位撑满容器的，容器量到 0×0 就说明 DSH 的 main 区没有给出
  // 有尺寸的盒子（那会是「一片空白」而不是报错）。把实测尺寸回报给 host，
  // agent 读 /api/aifisher/canvas/diagnostics 就能判断，不用让用户开控制台。
  const measure = () => {
    try {
      const rect = container.getBoundingClientRect();
      reportCanvasInfo('画布容器已测量', {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        clientWidth: container.clientWidth,
        clientHeight: container.clientHeight,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
    } catch {
      /* 量不到就算了，不能因为自检把画布搞崩 */
    }
  };
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.setTimeout(measure, 0));
  } else {
    setTimeout(measure, 0);
  }

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        root.unmount();
      } finally {
        releaseGrid();
        setCanvasPortalTarget(null);
        releaseThemeMirror();
        releaseBootstrap();
        releaseStyles();
        releaseDiagnostics();
      }
    },
  };
}

