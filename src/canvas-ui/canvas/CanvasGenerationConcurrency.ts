/**
 * 「并发生成数」设置（模块级 store，v1.90）。
 *
 * 用户 2026-11-05：「生成并发 2–3 路」。
 *
 * 为什么是 localStorage 里的**一个纯数字**，而不是 host 配置：
 *   - 实际排队发生在**画布应用**（vendor 的 batch approve 循环，整文件覆盖版）里，
 *     它和设置页分属两个 bundle（canvas-app.js / apply.js），字符串键是唯一稳的共享点；
 *   - 这条设置只影响「这台机器一次同时跑几个节点」，跟项目数据、生成结果无关，
 *     没必要写进 canvas.json（那会让一条排队偏好转成项目数据）。
 * 键名与 vendor 覆盖文件里的 `BATCH_CONCURRENCY_STORAGE_KEY` 必须逐字一致；
 * 取值 1–3，默认 2（ComfyUI 单卡也能吃下两路，云端通道更宽松）。
 */

export const GENERATION_CONCURRENCY_KEY = 'dsh-aifisher-canvas.generation-concurrency';
export const GENERATION_CONCURRENCY_DEFAULT = 2;
export const GENERATION_CONCURRENCY_MIN = 1;
export const GENERATION_CONCURRENCY_MAX = 3;

type Listener = () => void;

const listeners = new Set<Listener>();
let current: number | null = null;

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function clampGenerationConcurrency(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric)) return GENERATION_CONCURRENCY_DEFAULT;
  return Math.min(GENERATION_CONCURRENCY_MAX, Math.max(GENERATION_CONCURRENCY_MIN, Math.trunc(numeric)));
}

export function readGenerationConcurrency(): number {
  if (current !== null) return current;
  const store = storage();
  current = store ? clampGenerationConcurrency(store.getItem(GENERATION_CONCURRENCY_KEY)) : GENERATION_CONCURRENCY_DEFAULT;
  return current;
}

export function writeGenerationConcurrency(next: number): number {
  const value = clampGenerationConcurrency(next);
  current = value;
  const store = storage();
  try {
    store?.setItem(GENERATION_CONCURRENCY_KEY, String(value));
  } catch {
    /* 隐私模式 / 存储满：只在本次会话内生效，功能照常 */
  }
  for (const listener of listeners) listener();
  return value;
}

/** 步进（-1/+1），夹在 1–3；返回新值，方便调用方直接回显/提示。 */
export function stepGenerationConcurrency(delta: number): number {
  return writeGenerationConcurrency(readGenerationConcurrency() + delta);
}

export function subscribeGenerationConcurrency(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 回归用：把模块内存值丢掉，下次读真的从 storage 读（模拟重开页面）。 */
export function resetGenerationConcurrencyCache(): void {
  current = null;
}
