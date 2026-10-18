/**
 * 画布互动效果设置（模块级 store）。
 *
 * 用户原话（v1.27，2026-10-17）：「现在画布与鼠标没有互动效果，在设置里做一个开关」。
 * 两件事：① 把「鼠标周围圆形变亮」这条互动修回真的跟着指针走（根因见 canvasGrid.ts 的
 * attachGridLayer：网格层 pointer-events:none，真实鼠标事件永远不会落到它身上）；
 * ② 给这条互动一个**设置页里的开关**，关掉时底纹保持静态、不装任何指针监听。
 *
 * 为什么是模块级 store 而不是 React state：
 *   - 网格层是纯 DOM（src/client/canvas/canvasGrid.ts），设置页面板也是纯 DOM
 *     （./CanvasEffectsPanel.ts，vendor 设置页里不能塞第二棵 React 树）；
 *   - 两个入口一个在 client 半、一个在 canvas-ui 半，靠 store 的订阅通路同步，
 *     谁先挂都不影响（画布先挂 → 设置页打开时读到的就是当前值）。
 *   - 与 ComfyWorkflowConfigStore / CanvasNodeSearchStore / TaskQueueStore 同一套路。
 *
 * 落点：**本机 localStorage**（`dsh-aifisher-canvas.canvas-effects`）。
 *   这条设置只影响这台机器的观感，跟项目、生成结果、其它画布实例无关，
 *   所以没必要进 host 的 canvas.json（那会让一份外观偏好变成项目数据）。
 *   localStorage 不可用（隐私模式 / 被禁）时退化成「本次会话内存生效」，功能照常。
 */

/** 可以开关的互动效果。目前只有一条：指针周围的十字星提亮。 */
export type CanvasEffectKey = 'pointerGlow';

export interface CanvasEffectsSettings {
  /** 鼠标在画布上移动时，指针周围的小十字星是否亮起一圈。默认开。 */
  pointerGlow: boolean;
}

/** localStorage 键名（回归与文档都引用它，别改字符串本身就改这里）。 */
export const CANVAS_EFFECTS_STORAGE_KEY = 'dsh-aifisher-canvas.canvas-effects';

/** 默认值（用户没动过设置、或存档损坏时用这套）。 */
const DEFAULTS: CanvasEffectsSettings = Object.freeze({ pointerGlow: true });

type Listener = () => void;

const listeners = new Set<Listener>();

/** 当前设置。引用稳定：没改动时 `canvasEffects()` 返回同一个对象（useSyncExternalStore 需要）。 */
let current: CanvasEffectsSettings = { ...DEFAULTS };
/** 是否已经从 localStorage 读过（懒读：模块 import 时 localStorage 可能还不存在）。 */
let loaded = false;
/** 存档是否可用（不可用只在报告里留痕，不影响功能）。 */
let storageState: 'unused' | 'ok' | 'unavailable' = 'unused';

function storage(): Storage | null {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

function normalize(value: unknown): CanvasEffectsSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULTS };
  const record = value as Partial<CanvasEffectsSettings>;
  return {
    // 只认真正的 boolean：存档里出现 'false'/0 这种脏值就退回默认，别把用户锁在关不掉的状态里。
    pointerGlow: typeof record.pointerGlow === 'boolean' ? record.pointerGlow : DEFAULTS.pointerGlow,
  };
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (!store) {
    storageState = 'unavailable';
    return;
  }
  try {
    const raw = store.getItem(CANVAS_EFFECTS_STORAGE_KEY);
    storageState = 'ok';
    if (!raw) return;
    current = normalize(JSON.parse(raw));
  } catch {
    // 存档坏掉/被手改坏：保持默认值，下一次写入会覆盖掉它。
    storageState = 'ok';
    current = { ...DEFAULTS };
  }
}

function persist(): void {
  const store = storage();
  if (!store) {
    storageState = 'unavailable';
    return;
  }
  try {
    store.setItem(CANVAS_EFFECTS_STORAGE_KEY, JSON.stringify(current));
    storageState = 'ok';
  } catch {
    storageState = 'unavailable';
  }
}

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      // 单个订阅者出错不能拦住其它入口（设置页面板 + 网格层各自订阅）
      console.error('[aifisher-canvas] 画布互动效果订阅者出错', error);
    }
  }
}

/** 读当前设置（首次调用时从 localStorage 读一次）。 */
export function canvasEffects(): CanvasEffectsSettings {
  load();
  return current;
}

/** 读某一条效果是否开启。 */
export function isCanvasEffectEnabled(key: CanvasEffectKey): boolean {
  return canvasEffects()[key];
}

/**
 * 改一条效果。值没变就什么都不做（不写盘、不通知）——
 * 设置页的开关在 pointerenter/点击里可能被重复调用。
 */
export function setCanvasEffect<K extends CanvasEffectKey>(
  key: K,
  value: CanvasEffectsSettings[K],
): void {
  load();
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  persist();
  emit();
}

/** 翻转一条效果，返回改完之后的值（面板/快捷键共用）。 */
export function toggleCanvasEffect(key: CanvasEffectKey): boolean {
  const next = !canvasEffects()[key];
  setCanvasEffect(key, next);
  return next;
}

/** 全部恢复默认（设置页的「恢复默认」用）。 */
export function resetCanvasEffects(): void {
  load();
  current = { ...DEFAULTS };
  persist();
  emit();
}

/** 订阅设置变化；返回退订函数。 */
export function subscribeCanvasEffects(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 排查用读数（canvasGridReport / 画布构建信息都会带上这一段）。
 * `storage` 说清这份设置到底写没写进本机：「unavailable」= 只在本会话内存里生效。
 */
export function canvasEffectsReport(): {
  settings: CanvasEffectsSettings;
  storageKey: string;
  storage: 'unused' | 'ok' | 'unavailable';
  storageSupported: boolean;
  subscribers: number;
} {
  load();
  return {
    settings: { ...current },
    storageKey: CANVAS_EFFECTS_STORAGE_KEY,
    storage: storageState,
    storageSupported: !!storage(),
    subscribers: listeners.size,
  };
}

/**
 * 只给回归脚本用：把「已读过存档」的标记清掉，并重新按 localStorage 现状装载。
 * 生产代码别调（会把当前会话里的开关状态覆盖成盘上的值）。
 */
export function reloadCanvasEffectsForTests(): void {
  loaded = false;
  current = { ...DEFAULTS };
  load();
  emit();
}
