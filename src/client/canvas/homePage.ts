/**
 * 画布首屏（v1.85）：打开画布 = 项目库，旧看板不再露出。
 *
 * 用户原话（2026-10-31）：「现在打开画布它的项目管理是旧的；移除设置里的旧版设置」。
 *
 * v1.84 把项目库做成了页面层的一屏，但**入口还是旧的**：DSH 打开画布时 vendor 应用
 * 先渲染它自己的「项目看板」（`data-fisherai-project-dashboard`，头部写着 v1.80、
 * 显示全部 / 设置 / 导入项目 / 新建项目），页面层要等用户点顶栏「← 项目库」才出现。
 * 所以这里做三件事：
 *
 *   1. **首屏**：一旦 vendor 回到看板（打开画布、点「退出项目」），而页面层没开任何一屏
 *      → 立刻开「项目库」。项目库自己带新建 / 导入 / 打开 / 归档 / 复制 / 删除 / 备注，
 *      看板能做到的事它都有（看板本身从此只在底下当「当前没有项目」的占位）。
 *   2. **兜底**：页面被关掉（设置页的 ✕、Esc、脚本调 close）而底下还是看板 → 再把项目库
 *      打开。项目库在自己是首屏时不给关（见 CanvasProjectsPage 的 canDismiss），
 *      这条兜底防的是「从设置页关回来正好落在看板上」。
 *   3. **旧版设置的路由**：vendor 只有一条开设置的路（`fisherai:open-settings` 事件，
 *      由看板头部的「设置」和 `openSettings()` 派发）。旧对话框已移除，所以在这里把它
 *      拦下来（stopImmediatePropagation，vendor 那个监听器收不到），改开页面层设置页，
 *      并告诉它落在「服务与通道」（闭源服务 / 开源服务都搬过去了）。
 *
 * 不做的事：不改 vendor 的渲染树、不删 vendor 的看板组件 —— 看板留在底下当
 * 「没有项目」的占位，我们的页面严丝合缝盖住它；万一哪天页面层挂不上，画布仍然是可用的。
 */
import {
  currentCanvasPage,
  openCanvasPage,
  subscribeCanvasPage,
} from '../../canvas-ui/canvas/CanvasPagesStore';

/** vendor 看板根节点的选择器（vendor 源码里的 `DASHBOARD_SELECTOR`）。 */
const DASHBOARD_SELECTOR = '[data-fisherai-project-dashboard="true"]';
/** vendor 唯一那条「打开设置」事件（看板头部按钮 / navigation/openSettings.ts）。 */
const OPEN_SETTINGS_EVENT = 'fisherai:open-settings';
/**
 * 「用户刚点了某个项目、画布还没起来」的那条事件（v1.42 的 openProjectById 派发的）。
 *
 * v1.86：这是「点一次进不了画布」的兜底 —— 打开项目是异步的（vendor 要先 loadProject
 * 才 setView('canvas')），这中间如果项目库先被关掉，`ensureHome` 会看到「旧看板 +
 * 页面层没开」并立刻把项目库弹回来。现在项目库自己会等画布底盘出现再关
 * （CanvasProjectsPage 的 enterCanvasWhenReady），这里再按事件加一道时间窗：
 * 窗口内绝不自动开项目库，画布底盘一出现（ensureHome 顶部）就把窗口清掉。
 * 窗口过期仍自动恢复（例如导入/打开失败后还得能回到项目库）。
 */
const OPEN_PROJECT_EVENT = 'fisherai:open-project';
const OPENING_GRACE_MS = 5000;
/** 旧对话框里的分区搬到了设置页的哪一块（见 CanvasSettingsPage 的 services 分区）。 */
const SETTINGS_SECTION = 'services';

export interface CanvasHomeReport {
  /** 底下是不是 vendor 的旧看板（开始画布 / 退出项目时）。 */
  dashboard: boolean;
  /** 有没有因为「这里是首屏」自动开过项目库。 */
  autoOpened: boolean;
  /** 拦下过几次 vendor 的开设置请求（应该是每次都改开新设置页）。 */
  settingsRouted: number;
}

let autoOpened = false;
let settingsRouted = 0;
/** 打开项目的时间窗（见 OPEN_PROJECT_EVENT）：在此之前不自动开项目库。 */
let openingUntil = 0;

export function canvasHomeReport(): CanvasHomeReport {
  return {
    dashboard: (() => {
      try {
        return Boolean(document.querySelector(DASHBOARD_SELECTOR));
      } catch {
        return false;
      }
    })(),
    autoOpened,
    settingsRouted,
  };
}

/**
 * 装上首屏看门（在 mountCanvas 里、root.render 之前调用）。
 *
 * 为什么必须在 render 之前：`fisherai:open-settings` 的拦截要求我们的监听器先于 vendor
 * 的 React effect 注册（事件派发在 window 上，同一目标按注册顺序调用，后注册的那个
 * 只要前一个不 stopImmediatePropagation 就会执行）。
 */
export function installCanvasHomePage(container: HTMLElement): () => void {
  let disposed = false;
  autoOpened = false;
  settingsRouted = 0;
  openingUntil = 0;

  const dashboardPresent = () => {
    try {
      return Boolean(container.querySelector(DASHBOARD_SELECTOR));
    } catch {
      return false;
    }
  };

  /** 画布视图真的开着（vendor 的底盘）：有它说明底下是一个项目，不是看板。 */
  const canvasViewOpen = () => {
    try {
      return Boolean(document.getElementById('canvas-background'));
    } catch {
      return false;
    }
  };

  /**
   * 有没有「上次打开的项目」等着恢复。
   *
   * vendor 的初始 view 永远是 dashboard，带 resume 时它先渲染一帧看板、再去 loadProject
   * 并 setView('canvas')（见 canvasApplication 的 session?.load()）。如果这一帧看到看板就
   * 把项目库打开，刷新页面会变成「永远停在项目库」，再也不会回到上次的画布 ——
   * browser-check 的 canvas 场景就是这么红的。所以带 resume 时先等：要么底盘出现（恢复成功），
   * 要么 session 被清掉（loadProject 失败，见 vendor 的 catch 分支）。
   */
  const resumeWorkflowId = () => {
    try {
      const holder = window as unknown as {
        __FISHERAI_CANVAS_SESSION__?: { load?: () => { workflowId?: unknown } | null };
      };
      const state = holder.__FISHERAI_CANVAS_SESSION__?.load?.();
      return typeof state?.workflowId === 'string' && state.workflowId ? state.workflowId : '';
    } catch {
      return '';
    }
  };
  let bootPending = Boolean(resumeWorkflowId());

  /** 底上是看板、页面层却一屏都没开 → 开项目库。 */
  const ensureHome = () => {
    if (disposed) return;
    if (canvasViewOpen()) {
      bootPending = false;
      openingUntil = 0;
      return;
    }
    // 看板还没渲染出来（首帧）或正在切进画布：都别动。只看「有画布底盘」来判断
    // 「恢复成功」，不能因为看板暂时不在就把 bootPending 提前清掉 —— 那正是首帧
    // 会踩到的顺序：installCanvasHomePage 在 root.render 之前，DOM 里还什么都没有。
    if (!dashboardPresent()) return;
    // 用户刚点了项目、vendor 还在 loadProject（v1.86）：这段时间里**绝不**把项目库
    // 弹回来，否则就是「点一次只是重新激活了项目管理器，还得再点一次」。
    // 窗口过期仍会恢复下面那条兜底（加载失败时用户要能回到项目库）。
    if (openingUntil) {
      if (Date.now() < openingUntil) return;
      openingUntil = 0;
    }
    if (bootPending) {
      // 还在等 vendor 恢复上次的项目：session 还在就再等等（下面有轮询兜底）
      if (resumeWorkflowId()) return;
      bootPending = false;
    }
    if (currentCanvasPage()) return;
    autoOpened = openCanvasPage('projects') || autoOpened;
  };

  // 0) 「正在打开项目」的时间窗（v1.86）：见 ensureHome 里的说明。
  const onOpenProject = () => {
    if (disposed) return;
    openingUntil = Date.now() + OPENING_GRACE_MS;
  };
  window.addEventListener(OPEN_PROJECT_EVENT, onOpenProject, true);

  // 1) vendor 那条开设置的路拦下来，改开页面层设置页。
  const onOpenSettings = (event: Event) => {
    if (disposed) return;
    event.stopImmediatePropagation();
    settingsRouted += 1;
    openCanvasPage('settings', SETTINGS_SECTION);
  };
  window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings, true);

  // 2) 首屏与兜底：vendor 的看板/画布切换、页面开关都走这一条。
  let frame = 0;
  const schedule = () => {
    if (disposed || frame) return;
    const run = () => {
      frame = 0;
      ensureHome();
    };
    frame =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(run)
        : window.setTimeout(run, 0);
  };

  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(schedule)
      : null;
  observer?.observe(container, { childList: true, subtree: true });
  const unsubscribe = subscribeCanvasPage(schedule);

  /**
   * 恢复等待期间的轮询（v1.85）：vendor 清 session 时不一定有 DOM 变化
   * （失败分支可能只是 session.clear() + 保持 dashboard），只靠 MutationObserver 会一直等。
   */
  const bootPoll = window.setInterval(() => {
    if (disposed || !bootPending) return;
    ensureHome();
  }, 300);

  // 首帧就跑一次：看板可能已经在容器里了（二次打开画布），也可能稍后才渲染（首次）。
  ensureHome();
  schedule();

  return () => {
    disposed = true;
    window.removeEventListener(OPEN_PROJECT_EVENT, onOpenProject, true);
    window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings, true);
    observer?.disconnect();
    unsubscribe();
    window.clearInterval(bootPoll);
    if (frame) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
      frame = 0;
    }
  };
}
