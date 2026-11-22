/**
 * 手势降载（v1.107，性能 P0-1）。
 *
 * 背景：用户 2026-11-22 报「画布浏览起来还是有点卡」。取证（见 CHANGELOG / 记忆 decisions）
 * 指向三类**每帧都在重算**的开销：
 *   ① 顶栏 / 工具条 / 浮动面板上一大片 `backdrop-filter: blur(18–20px)`：它们压在会动的
 *      画布上，平移缩放时 Chromium 必须每帧重新模糊那一整块；
 *   ② 节点卡 `shadow-2xl` 这类大阴影（54 张卡同时在缩放中重新栅格化）；
 *   ③ 连线上的 SVG `feGaussianBlur` filter；
 *   ④ 点阵底纹的提亮层：一层带 radial-gradient 遮罩的全屏平铺图，指针/平移每帧都要重画。
 *
 * 这四样都是「静止时好看、动起来纯亏」的效果。所以在**手势期间**把它们整体关掉
 * （平移 / 缩放 / 拖节点 / 拉线这一小段时间里，画面本来就在动，没人看得清模糊），
 * 停手 180ms 后原样恢复 —— 观感不变，手势帧预算立刻降下来。
 *
 * 实现要点：
 *   - 只在容器 `.af-canvas-mount` 上打 `data-canvas-gesture="pan|zoom|drag"`，样式沿用项目
 *     既有做法（skin.ts 里也是 `.af-canvas-mount [class*='rounded-full']` 这种前缀限定），
 *     不往 DSH 页面别处渗透；
 *   - 判定用**窗口捕获阶段**的监听（与 canvasGrid 的指针跟随同一条教训：画布内部大量
 *     stopPropagation，冒泡阶段收不全），且只认落在画布底盘 / 缩放条上的事件 —— 右栏对话、
 *     项目库、设置页里的滚轮不该触发降载；
 *   - 属性只在**状态真的变了**时写一次，定时器复用，不在每帧写 DOM（否则等于又添一处抖动）。
 *
 * 排查口径：`canvasGestureReport()` 给出手势状态、最近种类、切换次数（真机「看着没降载」
 * 时先看这里，再看样式是否被覆盖）。
 */

/** 停手后多久恢复效果（太短会在两帧之间闪烁，太长会拖住恢复）。 */
export const GESTURE_IDLE_MS = 180;
/** 指针按下后移动多少像素才算「拖拽」（避免一次点击就关掉全屏模糊）。 */
export const GESTURE_DRAG_THRESHOLD_PX = 3;

export type CanvasGestureKind = 'pan' | 'zoom' | 'drag';

interface GestureRuntime {
  marks: number;
  lastKind: CanvasGestureKind | null;
  lastAt: number;
}

const runtimes = new WeakMap<HTMLElement, GestureRuntime>();

/** 读容器当前的手势状态（排查用；null = 没挂载）。 */
export function canvasGestureReport(): Record<string, unknown> | null {
  const container = document.querySelector<HTMLElement>('.af-canvas-mount');
  if (!container) return null;
  const runtime = runtimes.get(container);
  return {
    mounted: true,
    active: container.getAttribute('data-canvas-gesture'),
    marks: runtime?.marks ?? 0,
    lastKind: runtime?.lastKind ?? null,
    lastAt: runtime?.lastAt ?? 0,
    idleMs: GESTURE_IDLE_MS,
  };
}

/**
 * 手势降载的样式。与实现放在一起（点阵底纹 canvasGrid.ts 同一条约定）：
 * 改观感只动这一处，样式注入在 styles.ts 里按顺序追加。
 *
 * ⚠️ 规则右侧的选择器都要写成**具体类/属性**（`[class*='backdrop-blur']`、
 * `.af-canvas-header` 这种）。写 `*` 会让「属性一翻转」触发整页元素重匹配，
 * 每次手势开始/结束都卡一下 —— 那就和优化目标相反了。
 */
export function canvasGestureStyleText(): string {
  return `
/* ---- 手势降载（v1.107）：平移/缩放/拖拽期间关掉最贵的静态效果 ---- */
.af-canvas-mount[data-canvas-gesture] [class*='backdrop-blur'],
.af-canvas-mount[data-canvas-gesture] [class*='backdrop-filter'],
.af-canvas-mount[data-canvas-gesture] .af-canvas-header,
.af-canvas-mount[data-canvas-gesture] .af-canvas-header::after,
.af-canvas-mount[data-canvas-gesture] [role='toolbar'][aria-label='画布工具'],
.af-canvas-mount[data-canvas-gesture] [data-af-zoom-bar],
.af-canvas-mount[data-canvas-gesture] [data-af-help-btn],
.af-canvas-mount[data-canvas-gesture] [data-fisherai-minimap],
.af-canvas-mount[data-canvas-gesture] [data-fisherai-task-queue],
.af-canvas-mount[data-canvas-gesture] [data-slot='dropdown-menu-content'],
.af-canvas-mount[data-canvas-gesture] [data-slot='popover-content'],
.af-canvas-mount[data-canvas-gesture] [data-slot='tooltip-content'] {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
/* 卡片的大阴影：缩放/平移时每张卡都要重新栅格化阴影，手势期间不值当 */
.af-canvas-mount[data-canvas-gesture] [class*='shadow-'] {
  box-shadow: none !important;
}
/* 皮肤自己给 chrome 写的是「普通 CSS 的 box-shadow」（不是 tailwind 的 shadow-* 类），
   所以要单独列一遍；否则「手势期间没有大阴影」这条在真机上不成立。 */
.af-canvas-mount[data-canvas-gesture] .af-canvas-header,
.af-canvas-mount[data-canvas-gesture] [role='toolbar'][aria-label='画布工具'],
.af-canvas-mount[data-canvas-gesture] [data-af-zoom-bar],
.af-canvas-mount[data-canvas-gesture] [data-af-help-btn],
.af-canvas-mount[data-canvas-gesture] [data-fisherai-minimap],
.af-canvas-mount[data-canvas-gesture] [data-fisherai-task-queue] {
  box-shadow: none !important;
}
/* 连线的 SVG 高斯模糊（feGaussianBlur）—— 手势期间退成纯描边 */
.af-canvas-mount[data-canvas-gesture] .fisherai-canvas-edge path {
  filter: none !important;
}
/* 点阵提亮层：带 radial-gradient 遮罩的全屏平铺图，手势期间不画（visibility 才真的跳过绘制） */
.af-canvas-mount[data-canvas-gesture] [data-canvas-grid='true'] .canvas-grid-cross.is-highlight {
  visibility: hidden !important;
}
/* 生成中节点的噪波点阵同理 */
.af-canvas-mount[data-canvas-gesture] .af-gen-dots {
  visibility: hidden !important;
}
`;
}

function insideSurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('#canvas-background') ||
      target.closest('#canvas-viewport-content') ||
      target.closest('[data-af-zoom-bar]'),
  );
}

/**
 * 在画布容器上装手势降载。返回卸载函数（必须在组件卸载时调用，否则全局监听会留）。
 */
export function installCanvasGesture(container: HTMLElement): () => void {
  const runtime: GestureRuntime = { marks: 0, lastKind: null, lastAt: 0 };
  runtimes.set(container, runtime);

  let active: CanvasGestureKind | null = null;
  let timer: number | null = null;
  let pressing = false;
  let pressX = 0;
  let pressY = 0;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const commit = (kind: CanvasGestureKind | null) => {
    if (kind === active) return;
    active = kind;
    runtime.lastKind = kind;
    runtime.marks += 1;
    runtime.lastAt = Date.now();
    if (kind) container.setAttribute('data-canvas-gesture', kind);
    else container.removeAttribute('data-canvas-gesture');
  };

  const mark = (kind: CanvasGestureKind, keepUntilRelease = false) => {
    if (disposed) return;
    clearTimer();
    commit(kind);
    // 拖拽由 pointerup 收尾（指针按着的时候手势本来就还在进行）；
    // 滚轮/缩放没有「松开」事件，靠静默 180ms 判停。
    if (!keepUntilRelease) timer = window.setTimeout(() => commit(null), GESTURE_IDLE_MS);
  };

  const onWheel = (event: WheelEvent) => {
    if (!container.isConnected || !insideSurface(event.target)) return;
    mark('zoom');
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!container.isConnected) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (!insideSurface(event.target)) return;
    pressing = true;
    pressX = event.clientX;
    pressY = event.clientY;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pressing || disposed) return;
    if (Math.abs(event.clientX - pressX) < GESTURE_DRAG_THRESHOLD_PX &&
      Math.abs(event.clientY - pressY) < GESTURE_DRAG_THRESHOLD_PX) {
      return;
    }
    // 一旦越过阈值就持续降载（不再重复判阈值）：拖节点、拉线、平移都算。
    mark('drag', true);
  };

  const endPress = () => {
    if (!pressing) return;
    pressing = false;
    if (active === 'drag') {
      clearTimer();
      timer = window.setTimeout(() => commit(null), GESTURE_IDLE_MS);
    }
  };

  // 捕获阶段：画布内部大量 stopPropagation，冒泡阶段收不全（canvasGrid 同一条教训）。
  // 全部 passive —— 这里只读坐标，绝不 preventDefault，不能影响 vendor 的平移/缩放。
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  window.addEventListener('pointerup', endPress, { capture: true, passive: true });
  window.addEventListener('pointercancel', endPress, { capture: true, passive: true });
  window.addEventListener('blur', endPress);

  return () => {
    if (disposed) return;
    disposed = true;
    clearTimer();
    pressing = false;
    commit(null);
    container.removeAttribute('data-canvas-gesture');
    window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
    window.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
    window.removeEventListener('pointermove', onPointerMove, { capture: true } as EventListenerOptions);
    window.removeEventListener('pointerup', endPress, { capture: true } as EventListenerOptions);
    window.removeEventListener('pointercancel', endPress, { capture: true } as EventListenerOptions);
    window.removeEventListener('blur', endPress);
    runtimes.delete(container);
  };
}
