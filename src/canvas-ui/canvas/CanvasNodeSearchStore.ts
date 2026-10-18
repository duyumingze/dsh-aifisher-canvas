/**
 * 「搜索节点」的打开请求（画布内共用的一个极小 store）。
 *
 * 为什么单独一个模块：请求由**侧边栏**的按钮发出，而面板挂在**缩放控件**那个槽位里
 * （vendor 只给 Controls 喂了 view / viewport / canvasRef，面板靠它们把面板放到鼠标旁边）。
 * 两个槽位之间原本想走「装配层注入 prop」，结果 vendor 的注入对象是**渲染期**构造的 --
 * 值传下去了、更新却传不到实现里（踩过：按钮点了计数确实变了、面板就是不开）。
 * 一个小 store 让两边直接对话，不再经过 vendor 的注入契约。
 *
 * 不 import 任何东西（含 React）：面板用 `useSyncExternalStore` 订阅，
 * 侧边栏只调 `requestCanvasNodeSearch()`。模块级状态与组件生命周期无关，正好是我们要的语义。
 */
let requestCount = 0;
const listeners = new Set<() => void>();

/** 面板要用的快照（自增计数：每次请求都变，effect 才能看见「又请求了一次」）。 */
export function nodeSearchRequestSnapshot(): number {
  return requestCount;
}

/** 订阅请求变化；返回取消订阅函数。 */
export function subscribeCanvasNodeSearchRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 请求打开节点搜索面板（侧边栏的「搜索节点」按钮）。 */
export function requestCanvasNodeSearch(): void {
  requestCount += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[aifisher-canvas] 节点搜索请求订阅者出错', error);
    }
  }
}

/** 排查用：请求计数与订阅者数量（画布诊断接口会带上它）。 */
export function canvasNodeSearchReport(): { requestCount: number; listeners: number } {
  return { requestCount, listeners: listeners.size };
}
