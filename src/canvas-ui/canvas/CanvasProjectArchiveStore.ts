/**
 * 「项目归档」面板的开关状态（v1.42，画布内的模块级 store）。
 *
 * 与 CanvasWorkflowLibraryStore / ComfyWorkflowConfigStore 同一套理由：
 * ① 入口在**头部栏**（CanvasHeader 是 vendor 槽位的实现，只读 props），面板挂在
 *    **缩放控件槽位**（Controls 只喂 view / viewport / canvasRef / nodes），两个槽位之间
 *    无法靠注入 prop 传话，只能走模块级 store；
 * ② 面板重挂载时（Controls 绑定层重渲染会重造组件类型，见 stage.tsx 的注释）组件本地
 *    useState 会归零、旧闭包 setState 打空 —— 开关状态必须是模块级的。
 *
 * 不 import 任何东西（含 React）：面板用 `useSyncExternalStore` 订阅，头部只调
 * `requestCanvasProjectArchive()`。
 */
export interface ProjectArchiveState {
  open: boolean;
  /** 每次「请求打开」自增：面板据此判断要不要重拉项目规模 */
  version: number;
}

let state: ProjectArchiveState = { open: false, version: 0 };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[aifisher-canvas] 项目归档面板订阅者出错', error);
    }
  }
}

/** 面板订阅的快照（对象身份只在状态变化时更换，符合 useSyncExternalStore 的要求）。 */
export function projectArchiveSnapshot(): ProjectArchiveState {
  return state;
}

/** 订阅状态变化；返回取消订阅函数。 */
export function subscribeProjectArchive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 请求打开「项目归档」面板（头部按钮 / 项目菜单）。 */
export function requestCanvasProjectArchive(): void {
  state = { open: true, version: state.version + 1 };
  notify();
}

/** 关闭面板（关闭按钮 / Esc / 点遮罩）。 */
export function closeCanvasProjectArchive(): void {
  if (!state.open) return;
  state = { open: false, version: state.version + 1 };
  notify();
}

/** 排查用：当前开关、请求版本、订阅者数量。 */
export function projectArchiveStoreReport(): ProjectArchiveState & { listeners: number } {
  return { ...state, listeners: listeners.size };
}
