/**
 * 画布保存链路的取证器（client 半，跑在画布应用里）。
 *
 * 为什么需要它（2026-10-20）：
 *   用户报障「画布助手操作了之后很容易保存不上」。画布跑在浏览器里，保存失败只往
 *   控制台写一行 `[Auto-Save] Failed on edit: …`，而 agent（我）看不到用户的控制台，
 *   只能靠猜。上一次排查就是靠临时探针复现才定位到「一次字段级冲突之后永久不保存」。
 *
 *   这里在**不碰 vendor 代码**的前提下，给保存链路装两盏灯：
 *     1. 包一层 fetch：`POST /api/aifisher/canvas/workflows` 非 2xx / 抛错
 *        （含超时、断网、跨站拒绝）都上报到 host 的 /diagnostics；
 *     2. 包一层 console.error：把 `[Auto-Save] Failed …` 那一行的原文（带错误码，
 *        例如 409 冲突的 `D9:` 前缀）一并上报。
 *   于是「保存不上」不再是黑盒：`GET /api/aifisher/canvas/diagnostics` 直接能读到。
 *
 * 纪律：
 *   - 上报本身绝不能变成新的错误源：所有异常吞掉，fetch 的包装必须原样返回结果；
 *   - 409 只是乐观并发的正常撞车（画布会自己重读+合并+重发），报 warn；
 *     其它状态码才是 error，别让 /diagnostics 全是假故障；
 *   - 限流：同一句话 30s 内只报一次，全局每 60s 最多 20 条，避免把环形缓冲刷满；
 *   - 成功不发（否则每次自动保存都是一条噪音）。
 */
import { reportCanvasError, reportCanvasWarning } from './diagnostics';

/** 保存端点（restRouter 的 POST /workflows）。 */
const SAVE_PATH = '/api/aifisher/canvas/workflows';
/** 与 canvasAutoSave 的失败日志同一前缀（vendor 用 console.error 报的）。 */
const AUTOSAVE_FAILURE = /\[Auto-Save\]\s*Failed/i;

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const DEDUPE_MS = 30_000;

interface Budget {
  windowStart: number;
  count: number;
  lastByMessage: Map<string, number>;
}

/** 把一段可能很长的响应体压成一行摘要（排查够用，又不刷屏）。 */
function snippet(value: unknown, limit = 240): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

type Mutable = Record<string, unknown>;

function installSaveTelemetryOnce(): () => void {
  const budget: Budget = { windowStart: 0, count: 0, lastByMessage: new Map() };

  const allowed = (message: string): boolean => {
    const now = Date.now();
    if (now - budget.windowStart > WINDOW_MS) {
      budget.windowStart = now;
      budget.count = 0;
      budget.lastByMessage.clear();
    }
    if (budget.count >= MAX_PER_WINDOW) return false;
    const last = budget.lastByMessage.get(message) ?? 0;
    if (now - last < DEDUPE_MS) return false;
    budget.lastByMessage.set(message, now);
    budget.count += 1;
    return true;
  };

  const report = (
    message: string,
    detail: Record<string, unknown>,
    level: 'error' | 'warn' = 'error',
  ): void => {
    try {
      if (!allowed(message)) return;
      if (level === 'warn') reportCanvasWarning(message, detail);
      else reportCanvasError(message, detail);
    } catch {
      /* 上报失败就算了 */
    }
  };

  /** 灯 1：把某个 realm 的 fetch 包起来（原始实现由调用方给，避免 bind 串味）。 */
  const wrapFetch =
    (original: typeof fetch): typeof fetch =>
    async (input, init) => {
      const url =
        typeof input === 'string' ? input : ((input as { url?: string })?.url ?? String(input));
      const method = String(init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();
      const isSave = method === 'POST' && url.includes(SAVE_PATH);
      let response: Response;
      try {
        response = await original(input, init);
      } catch (error) {
        if (isSave) {
          report('画布保存请求没发出去（网络/中断/超时）', {
            url,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
        }
        throw error;
      }
      if (isSave && !response.ok) {
        let body = '';
        try {
          // clone 一份去读，原响应必须原样交给调用方（画布要自己解析它）。
          body = snippet(await response.clone().text());
        } catch {
          body = '(响应体读不出来)';
        }
        report(
          `画布保存被后端拒绝（HTTP ${response.status}）`,
          { url, status: response.status, body },
          response.status === 409 ? 'warn' : 'error',
        );
      }
      return response;
    };

  /** 灯 2：vendor 自动保存的失败日志。 */
  const wrapConsoleError =
    (original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      try {
        const text = args
          .map((arg) =>
            typeof arg === 'string'
              ? arg
              : arg instanceof Error
                ? `${arg.name}: ${arg.message}`
                : '',
          )
          .filter(Boolean)
          .join(' ');
        if (text && AUTOSAVE_FAILURE.test(text)) {
          report('画布自动保存失败', { line: snippet(text, 400) });
        }
      } catch {
        /* 取证失败不能影响原日志 */
      }
      original(...args);
    };

  /**
   * 要包的对象：`window` 与 `globalThis`。
   *
   * 真浏览器里两者是同一个对象，Set 自动去重；但在 jsdom 宿主（回归测试）里它们是
   * **两个**：画布产物里的裸 `fetch` / `console` 走的是 globalThis 那一份，只包 window
   * 的话测试里一条都收不到、真机又能收到 —— 那种「测试与真机不一致」的坑不值得留。
   */
  const realms = [
    ...new Set<Mutable>([window as unknown as Mutable, globalThis as unknown as Mutable]),
  ];
  const restores: Array<() => void> = [];

  for (const realm of realms) {
    const originalFetch = realm.fetch;
    if (typeof originalFetch === 'function') {
      const patched = wrapFetch((originalFetch as typeof fetch).bind(realm) as typeof fetch);
      realm.fetch = patched;
      restores.push(() => {
        if (realm.fetch === patched) realm.fetch = originalFetch;
      });
    }
    const originalConsole = realm.console as Console | undefined;
    if (originalConsole && typeof originalConsole.error === 'function') {
      const original = originalConsole.error.bind(originalConsole);
      const patched = wrapConsoleError(original);
      originalConsole.error = patched as unknown as typeof originalConsole.error;
      restores.push(() => {
        if (originalConsole.error === (patched as unknown as typeof originalConsole.error)) {
          originalConsole.error = original as unknown as typeof originalConsole.error;
        }
      });
    }
  }

  return () => {
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch {
        /* 卸载时恢复不了也不致命 */
      }
    }
  };
}

let installed: (() => void) | null = null;

/** 装上保存链路取证（幂等；返回的函数用于卸载）。 */
export function installSaveTelemetry(): () => void {
  if (installed) return installed;
  let release: () => void;
  try {
    release = installSaveTelemetryOnce();
  } catch {
    return () => {};
  }
  const once = () => {
    try {
      release();
    } finally {
      installed = null;
    }
  };
  installed = once;
  return once;
}
