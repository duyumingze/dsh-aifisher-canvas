/**
 * 画布运行时诊断上报（client 半，跑在画布应用里）。
 *
 * 画布是独立 ESM 应用、在浏览器里跑；出问题时 agent 看不到控制台。
 * 这里把全局错误 / 未处理 Promise / React 错误边界捕获到的异常
 * POST 回 host 的 /api/aifisher/canvas/diagnostics，之后用
 * GET /api/aifisher/canvas/diagnostics 就能读到我需要的信息。
 *
 * 上报本身出任何问题都必须静默：诊断通道不能变成新的错误源。
 */
const ENDPOINT = '/api/aifisher/canvas/diagnostics';

interface ReportDetail {
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
  [key: string]: unknown;
}

let installed = false;

function post(level: 'error' | 'warn' | 'info', message: string, detail?: ReportDetail): void {
  const body = JSON.stringify({
    level,
    message: String(message ?? '').slice(0, 4000),
    detail,
    url: location.pathname,
  });
  try {
    // keepalive 保证页面正在卸载时也能发出去
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 诊断上报失败就放弃 */
  }
}

/** 手动上报（React 错误边界、关键分支用）。 */
export function reportCanvasError(message: string, detail?: ReportDetail): void {
  console.error('[aifisher-canvas]', message, detail);
  post('error', message, detail);
}

/**
 * 警告级上报（v1.58）：用于「不一定是故障、但值得留痕」的情况。
 *
 * 第一个用它是保存链路的 409：乐观并发撞车是**正常**流程（画布会自己重读服务端
 * 合并再重发），报成 error 会让 /diagnostics 里全是红色的假故障。
 */
export function reportCanvasWarning(message: string, detail?: ReportDetail): void {
  console.warn('[aifisher-canvas]', message, detail);
  post('warn', message, detail);
}

export function reportCanvasInfo(message: string, detail?: ReportDetail): void {
  post('info', message, detail);
}

/**
 * 图片加载失败留痕（2026-10-20）。
 *
 * 云端生成的回执里可能是服务商的**临时链接**（host 侧落盘失败时的回落，见
 * `src/host/generation/cloudResult.ts`）。那种链接过一阵就 404，画布节点变成一块黑：
 * JS 不报错、控制台干干净净，只有一条资源加载失败事件 —— 用户只能说「图没了」。
 * 这里在捕获阶段收下它（img 的 error 不冒泡），报进 /diagnostics，
 * 「节点状态成功但没图」才能和「临时链接过期」对上号。
 */
export function installImageLoadTelemetry(): () => void {
  const reported = new Set<string>();
  const onError = (event: Event) => {
    const target = event.target as HTMLImageElement | null;
    if (!target || target.tagName !== 'IMG') return;
    const src = target.currentSrc || target.src || '';
    if (!src || reported.has(src)) return;
    reported.add(src);
    reportCanvasWarning('画布图片加载失败（链接可能已失效）', {
      url: src.slice(0, 500),
      alt: target.alt,
      remote: /^https?:/i.test(src),
    });
  };
  window.addEventListener('error', onError, true);
  return () => window.removeEventListener('error', onError, true);
}

/** 安装全局错误钩子（幂等）。 */
export function installCanvasDiagnostics(): () => void {
  if (installed) return () => {};
  installed = true;

  const onError = (event: ErrorEvent) => {
    post('error', event.message || 'window.onerror', {
      stack: event.error instanceof Error ? event.error.stack : undefined,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    post('error', reason instanceof Error ? reason.message : String(reason), {
      stack: reason instanceof Error ? reason.stack : undefined,
      kind: 'unhandledrejection',
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    installed = false;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
