/**
 * 「画布互动」设置面板（设置 → 画布外观）。
 *
 * 用户原话（v1.27，2026-10-17）：「现在画布与鼠标没有互动效果，在设置里做一个开关」。
 * 这一页给那条互动（鼠标周围的十字星提亮）一个开关：开 = 指针跟着亮一圈，关 = 底纹纯静态。
 *
 * 三个实现约束（都是这条链上踩过的坑）：
 *   ① **不写 React**：设置页是 vendor 的 React 树，而插件里有**两份 React 19**
 *      （vendor 画布那份 + src/canvas-ui 那份），往 vendor 的 DOM 里塞另一棵 React 树会踩 #130。
 *      所以这里全部原生 DOM + Tailwind 类（Tailwind 会扫 src/canvas-ui，见 tailwind-entry.css），
 *      样式值一律用 vendor 的 `--af-*` 变量（深浅两套主题自动跟手）。
 *   ② **挂到 vendor 的「画布外观」页里**：vendor 补丁（scripts/vendor-aifisher.mjs 的
 *      CANVAS_EFFECTS_PANEL_PATCHES）在这一页多渲染一个 `[data-fisherai-settings-page="appearance"]`
 *      宿主 div，并在挂页之后调 `__FISHERAI_MOUNT_CANVAS_EFFECTS__(host)`；这里挂在宿主里并返回
 *      disposer（切分区/关对话框都会调用它，监听器不会泄漏）。
 *   ③ **状态只有一份**：开关读写 ./CanvasEffectsStore，网格层订阅同一个 store。
 *      面板自己也订阅 —— 这样从别处改（回归脚本 / 将来的快捷键）面板上的开关会跟着动。
 */
import {
  CANVAS_EFFECTS_STORAGE_KEY,
  canvasEffects,
  setCanvasEffect,
  subscribeCanvasEffects,
} from './CanvasEffectsStore';

/** 面板根节点（回归与真机脚本按它找）。 */
const PANEL_ATTRIBUTE = 'data-fisherai-canvas-effects';
/** 开关按钮（回归点它、真机点它）。 */
const SWITCH_ATTRIBUTE = 'data-fisherai-canvas-effect';
/** 开关右侧那行状态文案。 */
const STATUS_ATTRIBUTE = 'data-fisherai-canvas-effect-status';

const PANEL_CLASS = 'space-y-4';
const CARD_CLASS =
  'flex items-start justify-between gap-6 rounded-lg border border-[var(--af-border)] ' +
  'bg-[var(--af-surface-raised)] p-6';
const TITLE_CLASS = 'text-base font-medium text-[var(--af-text)]';
const NOTE_CLASS = 'text-xs leading-relaxed text-[var(--af-text-muted)]';
const DESCRIPTION_CLASS = 'text-sm leading-relaxed text-[var(--af-text-secondary)]';

const SWITCH_BASE =
  'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ' +
  'duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-[var(--af-focus)]';
const SWITCH_ON = 'border-[var(--af-info)] bg-[var(--af-info)]';
const SWITCH_OFF = 'border-[var(--af-border-control)] bg-[var(--af-hover)]';
const KNOB_BASE = 'block h-5 w-5 rounded-full transition-transform duration-150';
/** 轨道 44px、滑块 20px、两侧各 2px：开 = 20px、关 = 2px。 */
const KNOB_ON_X = 20;
const KNOB_OFF_X = 2;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * 把「画布互动」面板挂到宿主元素里（宿主 = vendor 设置页给的那个空 div）。
 * 返回 disposer：摘掉面板 + 退订 store。
 */
export function mountCanvasEffectsPanel(host: HTMLElement): () => void {
  const root = el('section', PANEL_CLASS);
  root.setAttribute(PANEL_ATTRIBUTE, 'true');
  root.setAttribute('aria-labelledby', 'fisherai-canvas-effects-title');

  const header = el('div', 'space-y-1');
  const title = el('h3', TITLE_CLASS, '画布互动');
  title.id = 'fisherai-canvas-effects-title';
  const description = el(
    'p',
    DESCRIPTION_CLASS,
    '鼠标在画布上移动时，指针周围的小十字星会亮起一圈；关掉之后底纹保持静态，' +
      '平移、缩放、连线与生成都不受影响。',
  );
  header.append(title, description);

  const card = el('div', CARD_CLASS);
  const text = el('div', 'min-w-0 space-y-1');
  const label = el('p', TITLE_CLASS, '鼠标互动效果');
  const status = el('p', NOTE_CLASS);
  status.setAttribute(STATUS_ATTRIBUTE, 'true');
  status.setAttribute('role', 'status');
  text.append(label, status);

  const toggle = el('button', SWITCH_BASE);
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', '鼠标互动效果');
  toggle.setAttribute(SWITCH_ATTRIBUTE, 'pointer-glow');
  const knob = el('span', KNOB_BASE);
  knob.style.background = 'var(--af-canvas)';
  knob.setAttribute('aria-hidden', 'true');
  toggle.append(knob);

  const apply = () => {
    const on = canvasEffects().pointerGlow;
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    // classList.toggle 只收**单个** token（传带空格的类串会抛 InvalidCharacterError，
    // 面板会整块挂不上）—— 所以整串 className 直接重写。
    toggle.className = `${SWITCH_BASE} ${on ? SWITCH_ON : SWITCH_OFF}`;
    knob.style.transform = `translateX(${on ? KNOB_ON_X : KNOB_OFF_X}px)`;
    root.setAttribute('data-fisherai-canvas-effect-state', on ? 'on' : 'off');
    status.textContent = on
      ? '已开启：指针在画布上移动时，周围会亮起一圈光。'
      : '已关闭：底纹保持静态，不再跟随指针。';
  };
  apply();

  toggle.addEventListener('click', () => {
    // 只改 store，显示交给订阅回调 —— 保证「面板上的开关」与「网格层」永远同一个真相。
    setCanvasEffect('pointerGlow', !canvasEffects().pointerGlow);
  });

  const footer = el(
    'p',
    NOTE_CLASS,
    `这项设置只保存在本机浏览器（localStorage：${CANVAS_EFFECTS_STORAGE_KEY}），` +
      '不影响项目内容与生成结果。',
  );

  card.append(text, toggle);
  root.append(header, card, footer);
  host.append(root);

  const unsubscribe = subscribeCanvasEffects(apply);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    root.remove();
  };
}

interface PanelHolder {
  __FISHERAI_MOUNT_CANVAS_EFFECTS__?: (host: HTMLElement) => (() => void) | null;
}

/**
 * 注册设置页挂载点（vendor 补丁在「画布外观」页挂好后调它）。
 * 返回撤销函数（画布卸载时摘掉全局）。
 */
export function registerCanvasEffectsPanel(): () => void {
  const holder = globalThis as unknown as PanelHolder;
  holder.__FISHERAI_MOUNT_CANVAS_EFFECTS__ = (host: HTMLElement) => {
    try {
      return mountCanvasEffectsPanel(host);
    } catch (error) {
      // 面板挂不上不该拦住设置页（vendor 那一行调用点没有 try）
      console.error('[aifisher-canvas] 挂载「画布互动」设置面板失败', error);
      return null;
    }
  };
  return () => {
    if (holder.__FISHERAI_MOUNT_CANVAS_EFFECTS__) delete holder.__FISHERAI_MOUNT_CANVAS_EFFECTS__;
  };
}
