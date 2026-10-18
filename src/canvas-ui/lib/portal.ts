/**
 * 画布内 shadcn 浮层的 portal 容器。
 *
 * 为什么需要它：shadcn/Radix 的浮层（Tooltip / DropdownMenu / Popover / Dialog /
 * Select…）默认 portal 到 `document.body`。但画布的 shadcn 变量是在
 * `.af-canvas-mount`（画布容器）里落地的，而 DSH 页面自己的主题与画布主题**未必一致**
 * （画布可以独立切深/浅色）。浮层挂到 body 就会读到 DSH 那份 token，
 * 表现为「菜单/提示框配色跟画布不一致」。
 *
 * 解法：装配时由 mount 层把画布容器登记进来，所有浮层 portal 到该容器内部 ——
 * 于是浮层的变量继承链完整（容器 → --af-* → shadcn token），
 * 同时也避开了「浮层留在 DSH 页面上」的清理问题（容器一卸载，浮层跟着没）。
 */
let portalTarget: HTMLElement | null = null;

/** 登记/清除浮层容器（画布挂载时调用，卸载时传 null）。 */
export function setCanvasPortalTarget(element: HTMLElement | null): void {
  portalTarget = element;
}

/** 供 shadcn 组件的 Portal 使用；未登记时返回 undefined（回落到 document.body）。 */
export function canvasPortalTarget(): HTMLElement | undefined {
  return portalTarget ?? undefined;
}
