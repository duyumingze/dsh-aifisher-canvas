/**
 * 「整页扩图」的打开请求（v1.83）。
 *
 * 为什么要有这一层：整页工作台不能长在节点里（节点卡只有 360 宽、画布 viewport 还带
 * transform，`fixed` 会被困住 —— v1.82 把节点气泡放大到 880/560 都试过，两次都越界）。
 * 所以工作台挂成**画布容器的兄弟图层**（与生成批次卡同一套做法），由这里传递
 * 「要扩哪张图」这一件事。
 *
 * 分工：
 *   - vendor 工具条的「扩图」按钮调 `window.__FISHERAI_CANVAS_OUTPAINT_PAGE__.open(node)`
 *     （`scripts/patches/aifisher/src/stable/nodes/canvasMediaToolbar.tsx`）；
 *   - 本模块把 node 快照存下来并叫醒订阅者（`mount.tsx` 里的兄弟图层订阅它）；
 *   - 真正的像素合成 / 建节点仍走原来的 `__FISHERAI_CANVAS_OUTPAINT__.create()` 桥，
 *     这一层只负责「开哪张图、什么参数」。
 *
 * 为什么快照而不是 nodeId：工具条手里本来就有整份节点（resultUrl / 标题 / 比例都是现成的），
 * 传快照省一次「去画布里再找一遍」；真正落盘时 create() 仍按 id 从画布状态里取**最新**节点，
 * 所以扩图期间节点被改不会读到过期数据。
 */

/** 工作台只需要节点里这几项；其余字段原样带着（`preview()` 还要读比例字段）。 */
export interface OutpaintStudioNode {
  id: string;
  type?: string;
  title?: string;
  resultUrl?: string;
  aspectRatio?: string;
  resultAspectRatio?: string;
  width?: number;
  [key: string]: unknown;
}

export interface OutpaintStudioRequest {
  /** 每次打开都换一个 key：工作台据此把比例 / 位置 / 提示词重置成默认值。 */
  key: number;
  node: OutpaintStudioNode;
}

type Listener = () => void;

let current: OutpaintStudioRequest | null = null;
let sequence = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 订阅者自己的异常不能挡住别的订阅者（工作台 / 诊断各占一份） */
    }
  }
}

/** 打开整页扩图（vendor 工具条只认这一个入口）。 */
export function requestOutpaintStudio(node: OutpaintStudioNode | null | undefined): boolean {
  if (!node || typeof node.id !== 'string' || !node.id) return false;
  current = { key: (sequence += 1), node };
  emit();
  return true;
}

/** 关闭整页扩图（✕ / Esc / 生成成功之后）。 */
export function closeOutpaintStudio(): void {
  if (!current) return;
  current = null;
  emit();
}

/** `useSyncExternalStore` 的 subscribe（返回值必须稳定，否则 React 会无限重订阅）。 */
export function subscribeOutpaintStudio(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `useSyncExternalStore` 的 getSnapshot（未打开时是 null，引用稳定）。 */
export function currentOutpaintStudio(): OutpaintStudioRequest | null {
  return current;
}

/** 诊断读数：`canvasAppBuildInfo().outpaintStudio` 与回归脚本都读它。 */
export function outpaintStudioReport(): Record<string, unknown> {
  const page = Boolean(document.querySelector('[data-fisherai-outpaint-panel="true"]'));
  return {
    open: Boolean(current),
    nodeId: current?.node.id ?? null,
    page,
    // 整页工作台只有挂上桥之后工具条才会走它；没有桥就回落到 vendor 的 520 浮层。
    bridge: Boolean(
      (window as unknown as { __FISHERAI_CANVAS_OUTPAINT_PAGE__?: unknown })
        .__FISHERAI_CANVAS_OUTPAINT_PAGE__,
    ),
  };
}

interface OutpaintPageBridge {
  open(node: OutpaintStudioNode): boolean;
  close(): void;
}

/**
 * 把「打开整页扩图」挂到 window 上（vendor 半与本层是两个模块实例，只能走全局桥）。
 *
 * ⚠️ 只写 window：vendor 工具条读的就是 window；jsdom 里 window 与 globalThis 不是同一个
 *    对象，照 globalThis 写的桥工具条永远拿不到（v1.39 踩过一次，见 canvasMediaToolbar 注释）。
 */
export function installOutpaintStudioBridge(): () => void {
  const holder = window as unknown as { __FISHERAI_CANVAS_OUTPAINT_PAGE__?: OutpaintPageBridge };
  const bridge: OutpaintPageBridge = {
    open: (node) => requestOutpaintStudio(node),
    close: () => closeOutpaintStudio(),
  };
  holder.__FISHERAI_CANVAS_OUTPAINT_PAGE__ = bridge;
  return () => {
    if (holder.__FISHERAI_CANVAS_OUTPAINT_PAGE__ === bridge) delete holder.__FISHERAI_CANVAS_OUTPAINT_PAGE__;
  };
}
