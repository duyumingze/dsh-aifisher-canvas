/**
 * 画布应用加载器（DSH client 半，跑在 DSH 的 React 18 里）。
 *
 * 画布本体是另一份产物 `lib/canvas/canvas-app.js`（浏览器 ESM，自带 React 19），
 * 由 host 半挂在 /api/aifisher/canvas-app 下。这里用动态 import 按需拉取：
 *   - 只有用户真的打开「无限画布」面板才下载这 2MB；
 *   - DSH 的模块表没有它，也不需要 —— 它就是一段普通 ESM。
 *
 * 用 `new Function('u','return import(u)')` 而不是直接写 `import(url)`：
 * 后者会被打包器静态分析，试图把目标打进产物。走 Function 构造器可以绕开。
 */
export interface CanvasAppHandle {
  dispose(): void;
}

export interface CanvasAppModule {
  mountCanvas(container: HTMLElement): CanvasAppHandle;
  /** 画布应用自报的构建信息，用于排查「页面拿的是不是新代码」。 */
  canvasAppBuildInfo?(): Record<string, unknown>;
}

/** 与 host 半 staticAssets.ts 里的 CANVAS_APP_PREFIX 保持一致。 */
const CANVAS_APP_URL = '/api/aifisher/canvas-app/canvas-app.js';

const importByUrl = new Function('u', 'return import(u)') as (
  url: string,
) => Promise<CanvasAppModule>;

let pending: Promise<CanvasAppModule> | null = null;

/** 加载画布应用模块（同一次页面会话里只加载一次；失败后可重试）。 */
export function loadCanvasAppModule(): Promise<CanvasAppModule> {
  if (!pending) {
    pending = importByUrl(CANVAS_APP_URL).catch((error: unknown) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}
