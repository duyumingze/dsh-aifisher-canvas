/**
 * 画布样式注入。
 *
 * 上游 AIFISHER 的 CSS 是 Vite 编译进独立页面的；这里把 vendor 阶段收集好的
 * CSS 字符串 + Tailwind CLI 产物一起塞进一个 <style> 标签（引用计数，
 * 多个画布实例/多次挂载只注入一份，卸载到零时移除）。
 *
 * 注入顺序：Tailwind utilities 在前，AIFISHER 自己的 CSS 在后
 * （上游 canvas.css 里也是先 `@import 'tailwindcss'` 再写自己的规则，保持同样的层叠关系）。
 *
 * 注意：这些样式是**全局**注入到 DSH 页面里的。所以：
 *   - Tailwind 编译时排除了 preflight（否则 * 的重置会改掉 DSH 整个界面）；
 *   - canvas.css 里的 `html, body, #root` 全局规则在 vendor 阶段已被换成 `.af-canvas-mount`；
 *   - AIFISHER 其余 CSS 全部是 .af- / 组件前缀类选择器，不会误伤 DSH。
 */
import { AIFISHER_CSS } from '../../../vendor/aifisher/styles.generated';
import { TAILWIND_CSS } from '../../../vendor/aifisher/tailwind.generated';
import { canvasGridStyleText } from './canvasGrid';
import { CANVAS_SKIN_CSS } from './skin';
import { WORKBENCH_SKIN_CSS } from './workbenchSkin';
import { PAGE_SKIN_CSS } from './pageSkin';

const STYLE_ID = 'dsh-aifisher-canvas-styles';

/**
 * 面板内适配（追加在 AIFISHER 自己的 CSS 之后）。
 *
 * 上游画布是**独占整个窗口**的独立应用：根视图用 Tailwind 的 `w-screen` / `h-screen` /
 * `min-h-screen`（= 100vw / 100vh）排版。嵌进 DSH 主区域后这些页面级尺寸必须退回
 * 「撑满画布容器」，否则画布会按视口宽度铺开：右边被侧边栏宽度裁掉、下面的控件跑到窗口外。
 *
 * 为什么只改这三个类、不动 `position:fixed`：
 *   那些 fixed 浮层（右键菜单、面板、预览、裁剪框）的坐标来自鼠标事件与
 *   getBoundingClientRect，本来就是**视口坐标系**；改成 absolute 反而会整体错位。
 *   它们盖到窗口上属于可接受的降级（本来就是浮层语义）。
 */
const PANEL_ADAPTATION_CSS = `
/* ---- DSH 面板内适配 ---- */
.af-canvas-mount .w-screen { width: 100% !important; }
.af-canvas-mount .h-screen { height: 100% !important; }
.af-canvas-mount .min-h-screen { min-height: 100% !important; }

/* ---- 图片工作台（v1.26，src/canvas-ui/canvas/ 下的 nova 版图片编辑/裁剪/标注）----
   舞台是一块「退后」的暗底：轻微的径向提亮 + 点阵，让居中的图片有落点，
   而不是一大片纯黑（用户截图里那块空黑就是没铺底纹的观感）。
   图片框加 1px 边框 + 投影，跟节点卡片是同一套语言。 */
.af-wb-stage {
  background-color: var(--af-canvas);
  background-image: radial-gradient(
      circle at 50% 34%,
      color-mix(in srgb, var(--af-surface-raised) 88%, transparent) 0,
      transparent 64%
    ),
    radial-gradient(circle, color-mix(in srgb, var(--af-border) 60%, transparent) 1px, transparent 1px);
  background-size: 100% 100%, 18px 18px;
  background-position: center, 0 0;
}
.af-wb-image {
  border: 1px solid color-mix(in srgb, var(--af-border) 80%, transparent);
  box-shadow: 0 18px 44px #00000066;
}
`;

let refCount = 0;

export function installCanvasStyles(): () => void {
  refCount += 1;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-dsh-aifisher-canvas', 'styles');
    // 网格底纹的样式来自 canvasGrid.ts（与它自己的实现放一起，改观感只需动那一处）。
    // 皮肤（方案 C 玻璃面板）放在最后：它覆盖 --af-* 令牌与 chrome/节点样式，必须在最上层。
    style.textContent = `${TAILWIND_CSS}\n${AIFISHER_CSS}\n${PANEL_ADAPTATION_CSS}\n${canvasGridStyleText()}\n${CANVAS_SKIN_CSS}\n${WORKBENCH_SKIN_CSS}\n${PAGE_SKIN_CSS}`;
    document.head.appendChild(style);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount -= 1;
    if (refCount <= 0) {
      refCount = 0;
      style?.remove();
    }
  };
}

/** 供排查用：当前注入的样式字节数。 */
export function canvasStyleBytes(): number {
  return (
    (TAILWIND_CSS?.length ?? 0) +
    (AIFISHER_CSS?.length ?? 0) +
    PANEL_ADAPTATION_CSS.length +
    canvasGridStyleText().length +
    CANVAS_SKIN_CSS.length +
    WORKBENCH_SKIN_CSS.length +
    PAGE_SKIN_CSS.length
  );
}
