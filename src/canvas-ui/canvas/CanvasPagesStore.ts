/**
 * 页面层路由（v1.84）：项目库 / 设置。
 *
 * 为什么要一个 store 而不是 React Router：画布本身是**一个 React 树**（vendor 的
 * `canvasApplication`），而这两屏按 v1.83 的做法挂在**画布容器的兄弟图层**上
 * （portal 到 `.af-canvas-mount`）。它们与画布的关系不是「另一个 App」，而是
 * 「同一套外壳的另一种内容」——所以入口在画布内（顶栏 / 侧栏按钮），内容在兄弟图层，
 * 中间只靠这个 store 传「现在该显示哪一屏」。
 *
 * 同一时刻只开一屏：项目库 → 设置 是可点的（项目库右上角那个齿轮），
 * 但两屏不会叠着（叠着会浪费一整层玻璃，视觉上也说不出谁在上）。
 *
 * 为什么带 `key`：项目库每次打开都要重新拉一遍 `/projects`（用户可能刚在画布里
 * 编辑过），key 变了组件就知道「这是新的一次打开」，把搜索 / 视图 / 选中项归位。
 */

export type CanvasPageId = 'projects' | 'settings';

export interface CanvasPageRequest {
  id: CanvasPageId;
  /** 每次打开 +1：页面据此重置搜索/视图/选中项。 */
  key: number;
  /**
   * 打开时想落在哪一块（v1.85：vendor 的 `fisherai:open-settings` 事件带不了分区，
   * 由装配层拦下来后告诉设置页「这次是奔着服务与通道来的」）。
   * 只对 settings 有意义；项目库不看它。
   */
  section?: string;
}

type Listener = () => void;

let current: CanvasPageRequest | null = null;
let sequence = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 单个订阅者出错不能挡住另一个（页面 + 诊断各订一份） */
    }
  }
}

/** 打开某一屏（已开着同一屏时只换 key，等于「重新来一遍」）。 */
export function openCanvasPage(id: CanvasPageId, section?: string): boolean {
  if (id !== 'projects' && id !== 'settings') return false;
  current = { id, key: (sequence += 1), section: section || undefined };
  emit();
  return true;
}

/** 关闭当前页（✕ / Esc / 打开某个项目之后）。 */
export function closeCanvasPage(): void {
  if (!current) return;
  current = null;
  emit();
}

/** `useSyncExternalStore` 的 subscribe（返回值必须稳定）。 */
export function subscribeCanvasPage(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `useSyncExternalStore` 的 getSnapshot（未打开时是 null，引用稳定）。 */
export function currentCanvasPage(): CanvasPageRequest | null {
  return current;
}

/**
 * 诊断读数：`canvasAppBuildInfo().pages` 与回归脚本都读它。
 *
 * v1.85：`vendorSettings` 不再有（旧版设置对话框已从界面移除，vendor 的
 * `fisherai:open-settings` 事件由 canvasHome 拦下改开这一页），字段留着只是让
 * 旧脚本读到 `false` 而不是 `undefined`。
 */
export function canvasPagesReport(): Record<string, unknown> {
  return {
    open: current?.id ?? null,
    key: current?.key ?? 0,
    section: current?.section ?? null,
    projects: Boolean(document.querySelector('[data-fisherai-page="projects"]')),
    settings: Boolean(document.querySelector('[data-fisherai-page="settings"]')),
    bridge: Boolean((window as unknown as { __FISHERAI_CANVAS_PAGES__?: unknown }).__FISHERAI_CANVAS_PAGES__),
    vendorSettings: false,
  };
}

interface PagesBridge {
  open(id: CanvasPageId): boolean;
  close(): void;
  current(): CanvasPageId | null;
}

/**
 * 把「打开哪一屏」挂到 window 上（装配层与 canvas-ui 是两个模块实例，只能走全局桥）。
 *
 * 注意只写 window：jsdom 里 window 与 globalThis 不是同一个对象（v1.39 踩过），
 * 照 globalThis 写的桥，页面上真点按钮时永远拿不到。
 */
export function installCanvasPagesBridge(): () => void {
  const holder = window as unknown as { __FISHERAI_CANVAS_PAGES__?: PagesBridge };
  const bridge: PagesBridge = {
    open: (id) => openCanvasPage(id),
    close: () => closeCanvasPage(),
    current: () => current?.id ?? null,
  };
  holder.__FISHERAI_CANVAS_PAGES__ = bridge;
  return () => {
    if (holder.__FISHERAI_CANVAS_PAGES__ === bridge) delete holder.__FISHERAI_CANVAS_PAGES__;
  };
}
