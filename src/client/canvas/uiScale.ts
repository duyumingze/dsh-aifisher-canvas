/**
 * 界面缩放（UI Scale，2026-10-30 设计稿第四节）。
 *
 * 用户要的是「界面本身」的字号/控件整体放大，**画布内容（节点/图片/连线）不动**：
 * 看字累调到 125%，要一屏塞更多就调到 90%。和画布自己的 zoom 完全分离。
 *
 * 落地走设计稿推荐的方案 A：只给 6 类 chrome 节点加 `zoom: var(--af-ui-scale)`
 * （顶栏 / 工具条 / 缩放条 / 帮助钮 / 小地图 / 任务队列 + 缩放胶囊本身，见 skin.ts 第 8 段）。
 * 这里只负责状态、档位、快捷键、持久化与 CSS 变量写入。
 *
 * 为什么不用包一层 transform：实测（Chrome 1440×900）`zoom` 下
 *   · 百分比定位 `top:50%` 仍然居中（工具条不会偏移）；
 *   · `width:100%` 的顶栏仍然正好铺满（不需要补偿）；
 *   · 贴边元素 `right:12 / bottom:24` 的边距同比放大（贴边仍在贴边）。
 * 而整层 transform 会让所有绝对定位的子元素错位（设计稿 mock 也踩过）。
 *
 * 档位：80 / 90 / 100 / 110 / 125 / 150（按档跳，不做无级拖）。
 * 快捷键：Ctrl + = / Ctrl + − / Ctrl + 0（只在画布内拦截，不改浏览器缩放）。
 * 持久化：localStorage['af.uiScale']。
 */

/** 档位（设计稿取值）。 */
export const UI_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

const STORAGE_KEY = 'af.uiScale';
const MIN = UI_SCALE_STEPS[0];
const MAX = UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1];

type Listener = () => void;
const listeners = new Set<Listener>();

/** 最近一次变更的时刻（胶囊用它显示 1.6s 提示）。 */
let changedAt = 0;

function clamp(value: number): number {
  return Math.min(MAX, Math.max(MIN, value));
}

function read(): number {
  // 调试/截图用：`?uiScale=1.25` 直接定档（不落盘）。browser-check 的场景靠它出 125% 的图。
  try {
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get('uiScale');
    const urlValue = fromUrl ? Number(fromUrl) : NaN;
    if (Number.isFinite(urlValue)) return clamp(Math.round(urlValue * 100) / 100);
  } catch {
    /* file: / about:blank 等场景没有 location，忽略 */
  }
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const value = raw ? Number(raw) : NaN;
    if (Number.isFinite(value)) return clamp(Math.round(value * 100) / 100);
  } catch {
    /* 隐私模式 / 存储被禁：用缺省值 */
  }
  return 1;
}

let current = read();

function write(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(current));
  } catch {
    /* 存储不可用只影响下次打开，不影响本次 */
  }
}

/**
 * 把缩放写进 CSS 变量。
 *
 * 写在 `documentElement` 上而不是画布容器：变量只需要在 chrome 节点的祖先上存在，
 * 而 DOM 根永远不会被画布重挂载换掉；画布卸载时变回 1（见 dispose）。
 */
function apply(): void {
  const root = document.documentElement;
  root.style.setProperty('--af-ui-scale', String(current));
  // 注意：不要用 dataset.afUiScale —— 那会生成 data-af-ui-scale 属性，和右下角胶囊的
  // data-af-ui-scale 撞名（querySelector 会先命中 <html>，量出来的胶囊是整个视口）。
  root.dataset.afUiPercent = String(Math.round(current * 100));
}

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 单个订阅者出错不影响其它 */
    }
  }
}

/** 当前缩放（1 = 100%）。 */
export function currentUiScale(): number {
  return current;
}

/** 最近一次变更的时间戳（毫秒）；提示条据此判断是否还该显示。 */
export function uiScaleChangedAt(): number {
  return changedAt;
}

/** 订阅变更；返回退订函数。 */
export function subscribeUiScale(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 设为指定值（自动夹到 0.8–1.5 并落盘）。 */
export function setUiScale(value: number): number {
  const next = clamp(Math.round(value * 100) / 100);
  if (next === current) return current;
  current = next;
  changedAt = Date.now();
  apply();
  write();
  emit();
  return current;
}

/** 按档位走一步（dir=1 放大 / -1 缩小）。 */
export function stepUiScale(dir: 1 | -1): number {
  const index = UI_SCALE_STEPS.indexOf(current as (typeof UI_SCALE_STEPS)[number]);
  // 当前值不在档位上（比如旧存档 1.15）时，向上取最近一档再走。
  const nearest = index >= 0 ? index : dir > 0
    ? UI_SCALE_STEPS.findIndex((step) => step > current)
    : [...UI_SCALE_STEPS].reverse().findIndex((step) => step < current);
  const base = index >= 0 ? index : nearest >= 0 ? nearest : dir > 0 ? 0 : UI_SCALE_STEPS.length - 1;
  const nextIndex = Math.min(UI_SCALE_STEPS.length - 1, Math.max(0, base + dir));
  return setUiScale(UI_SCALE_STEPS[nextIndex]);
}

/** 恢复 100%。 */
export function resetUiScale(): number {
  return setUiScale(1);
}

/** 诊断读数（mount 的 buildInfo 与回归脚本读它）。 */
export function canvasUiScaleReport(): Record<string, unknown> {
  return {
    scale: current,
    percent: Math.round(current * 100),
    steps: [...UI_SCALE_STEPS],
    storageKey: STORAGE_KEY,
    root: document.documentElement.style.getPropertyValue('--af-ui-scale') || null,
  };
}

/**
 * 快捷键：Ctrl + = / Ctrl + − / Ctrl + 0。
 *
 * 只在「事件目标在画布容器内」或「焦点在 body」时拦截 —— 输入框/文本编辑器里的 Ctrl+±
 * 留给它们自己；DSH 其它面板里的浏览器缩放也不抢。
 */
function onKeyDown(event: KeyboardEvent): void {
  if (!event.ctrlKey || event.altKey || event.metaKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
    return;
  const mount = document.querySelector('.af-canvas-mount');
  if (!mount) return;
  // 事件目标是元素（真实键盘事件）或 window（合成事件）；都不是时按「在画布里」处理，
  // 免得 `mount.contains(window)` 抛 TypeError 把快捷键整条打断。
  const inCanvas =
    !target ||
    target === document.body ||
    target === (window as unknown as HTMLElement) ||
    (typeof Node !== 'undefined' && target instanceof Node && mount.contains(target));
  if (!inCanvas) return;
  const key = event.key;
  if (key === '=' || key === '+') {
    event.preventDefault();
    event.stopPropagation();
    stepUiScale(1);
  } else if (key === '-' || key === '_') {
    event.preventDefault();
    event.stopPropagation();
    stepUiScale(-1);
  } else if (key === '0') {
    event.preventDefault();
    event.stopPropagation();
    resetUiScale();
  }
}

/**
 * 装快捷键与初始值；返回撤销函数（画布卸载时把变量恢复成 1，
 * 否则画布关掉后 DSH 其它界面若继承了该变量会莫名其妙变大）。
 */
export function installCanvasUiScale(): () => void {
  apply();
  window.addEventListener('keydown', onKeyDown, true);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.style.removeProperty('--af-ui-scale');
    delete document.documentElement.dataset.afUiPercent;
  };
}
