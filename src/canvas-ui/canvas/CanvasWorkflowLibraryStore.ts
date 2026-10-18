/**
 * 「工作流节点」面板的打开/关闭状态（v1.28，画布内共用的一个极小 store）。
 *
 * 与 ComfyWorkflowConfigStore / CanvasNodeSearchStore 同一套理由：请求由**左侧工具条**的
 * 「工作流节点」按钮发出（那是个 vendor 槽位的实现，只能读 props），而面板挂在**缩放控件**
 * 槽位里（vendor 只给 Controls 喂了 view / viewport / canvasRef）。两个槽位之间靠「装配层
 * 注入 prop」传不过去，所以用模块级 store 直接对话。
 *
 * 之所以连**开关状态**也放 store（不只是请求计数）：面板重挂载时（Controls 槽位绑定层每次
 * 渲染都会重造组件类型，见 stage.tsx 的注释）本地 useState 会归零、旧闭包里的 setOpen 打空，
 * 表现成「面板关不掉」。store 是模块级的，重挂载读到的就是真值。
 *
 * 不 import 任何东西（含 React）：面板用 `useSyncExternalStore` 订阅，工具条只调
 * `requestCanvasWorkflowLibrary()`。
 */
export interface WorkflowLibraryState {
  open: boolean;
  /** 每次「请求打开」自增：面板据此判断要不要重拉清单 */
  version: number;
}

let state: WorkflowLibraryState = { open: false, version: 0 };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[aifisher-canvas] 工作流节点面板订阅者出错', error);
    }
  }
}

/** 面板订阅的快照（对象身份只在状态变化时更换，符合 useSyncExternalStore 的要求）。 */
export function workflowLibrarySnapshot(): WorkflowLibraryState {
  return state;
}

/** 订阅状态变化；返回取消订阅函数。 */
export function subscribeWorkflowLibraryRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 请求打开「工作流节点」面板（左侧工具条的入口按钮）。 */
export function requestCanvasWorkflowLibrary(): void {
  state = { open: true, version: state.version + 1 };
  notify();
}

/** 关闭面板（关闭按钮 / Esc / 点遮罩）。 */
export function closeCanvasWorkflowLibrary(): void {
  if (!state.open) return;
  state = { open: false, version: state.version + 1 };
  notify();
}

/** 排查用：当前开关、请求版本、订阅者数量。 */
export function workflowLibraryReport(): WorkflowLibraryState & { listeners: number } {
  return { ...state, listeners: listeners.size };
}
