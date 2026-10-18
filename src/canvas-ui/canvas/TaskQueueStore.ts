/**
 * 「任务队列」面板的展开/收起状态（画布内共用的一个极小 store）。
 *
 * 与 ComfyWorkflowConfigStore / CanvasNodeSearchStore 同一套理由：面板挂在 Controls 槽位
 * （stage.tsx 的 bindView 每次渲染都可能造出新的组件类型），子树会被重挂载，本地 useState
 * 里的「展开/收起」会归零 —— 用户刚收起、重渲染后自己又展开，看着像按钮失灵。
 * 状态放模块级 store，重挂载读到的就是真值。
 *
 * 另外这份状态落 localStorage：它是「这台机器上的偏好」（用户想不想在画布右侧一直看见任务队列），
 * 不属于项目数据，不进 $DSH_HOME/storages 那份画布数据目录。
 *
 * 不 import 任何东西（含 React）：面板用 `useSyncExternalStore` 订阅。
 */
export interface TaskQueueState {
  /** true = 展开成右侧面板；false = 收成右缘一条窄轨道（上面带运行中角标）。 */
  open: boolean;
}

/** localStorage 键（与 CanvasShell 的 chatDock.* 同一套命名习惯）。 */
const OPEN_KEY = 'dsh-aifisher-canvas.taskQueue.open';

function readStoredOpen(): boolean {
  try {
    // 缺省 = 展开：用户要的就是「画布右边有任务队列」。
    return window.localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeStoredOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* 隐私模式/配额满：偏好存不下不该影响使用 */
  }
}

let state: TaskQueueState = { open: readStoredOpen() };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[aifisher-canvas] 任务队列订阅者出错', error);
    }
  }
}

/** 面板订阅的快照（对象身份只在状态变化时更换，符合 useSyncExternalStore 的要求）。 */
export function taskQueueSnapshot(): TaskQueueState {
  return state;
}

/** 订阅状态变化；返回取消订阅函数。 */
export function subscribeTaskQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 展开/收起（同时落盘）。 */
export function setTaskQueueOpen(open: boolean): void {
  if (state.open === open) return;
  state = { open };
  writeStoredOpen(open);
  notify();
}

/** 切换（面板头部那个箭头按钮）。 */
export function toggleTaskQueue(): void {
  setTaskQueueOpen(!state.open);
}

/** 排查用：当前开关 + 订阅者数量。 */
export function taskQueueReport(): TaskQueueState & { listeners: number } {
  return { ...state, listeners: listeners.size };
}
