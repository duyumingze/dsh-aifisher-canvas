/**
 * 「ComfyUI 工作流配置」面板的打开/关闭状态（画布内共用的一个极小 store）。
 *
 * 与 CanvasNodeSearchStore 同一套理由：请求由**左侧工具条**的按钮发出，面板挂在**缩放控件**
 * 那个槽位里（vendor 只给 Controls 喂了 view / viewport / canvasRef）。两个槽位之间走
 * 「装配层注入 prop」传不进去（注入对象是渲染期构造的），所以用模块级 store 直接对话。
 *
 * 与节点搜索那份的**关键区别：开关状态也放在 store 里**（不只是「请求计数」）。
 * 原因是实测到的事件顺序：面板里点「添加到画布」会先派发建节点事件、再调
 * `resetLocalWorkflows()` 重拉能力清单 —— 后者会 notify 出一整轮画布重渲染，
 * Controls 槽位的绑定层（stage.tsx 的 `bindView`）**每次渲染都会造一个新的组件类型**，
 * 于是面板子树被重挂载：本地 `useState` 里的 open 归零、旧闭包里的 `setOpen(false)`
 * 成了对已卸载 fiber 的空操作 → 面板「关不掉」，而 effect 又在挂载时把它重新打开。
 * 开关放进 store 之后，关与开都走同一份模块级状态，重挂载只会读到正确的值。
 *
 * 不 import 任何东西（含 React）：面板用 `useSyncExternalStore` 订阅，工具条只调
 * `requestComfyWorkflowConfig()`。
 */
export interface WorkflowConfigState {
  open: boolean;
  /** 每次「请求打开」自增：面板据此判断要不要重拉清单（重挂载时不重拉也行，但重开一次会刷新） */
  version: number;
}

let state: WorkflowConfigState = { open: false, version: 0 };
/** 上次选中的工作流 id：面板重挂载后还停在同一个工作流上（不然会被重置回第一条） */
let selectedId: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[aifisher-canvas] ComfyUI 工作流配置订阅者出错', error);
    }
  }
}

/** 面板订阅的快照（对象身份只在状态变化时更换，符合 useSyncExternalStore 的要求）。 */
export function workflowConfigSnapshot(): WorkflowConfigState {
  return state;
}

/** 订阅状态变化；返回取消订阅函数。 */
export function subscribeWorkflowConfigRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 请求打开「ComfyUI 工作流配置」面板（左侧工具条的入口按钮）。 */
export function requestComfyWorkflowConfig(): void {
  state = { open: true, version: state.version + 1 };
  notify();
}

/** 关闭面板（面板里的关闭按钮 / Esc / 点遮罩 / 「添加到画布」之后）。 */
export function closeComfyWorkflowConfig(): void {
  if (!state.open) return;
  state = { open: false, version: state.version + 1 };
  notify();
}

/** 记住/读取当前选中的工作流（跨重挂载）。 */
export function rememberWorkflowConfigSelection(id: string | null): void {
  selectedId = id;
}

export function workflowConfigSelectedId(): string | null {
  return selectedId;
}

/** 排查用：当前开关、请求版本、订阅者数量。 */
export function workflowConfigReport(): WorkflowConfigState & { listeners: number } {
  return { ...state, listeners: listeners.size };
}
