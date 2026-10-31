/**
 * 合成器编辑器样式（方案 C「玻璃面板 Fluent」：冷灰蓝底 + 半透明层 + 青色强调）。
 *
 * 为什么不再复用画布的 `--af-*` 变量：合成器是盖在画布上面的独立图层，
 * 画布换主题/换肤时它不该跟着抖；这里自带一套中性色，只借用同一套字号与圆角尺度。
 *
 * 几何常量（NODE_WIDTH / PORT_SIZE / 标题栏高度 / 网格步长）必须和 editor.ts 里的常量对齐 ——
 * 连线按这些常量算坐标，不读 DOM 布局。
 *
 * 关于「放大就糊」：节点里不放任何位图。色轮是 conic + radial 梯度、曲线是 SVG、
 * 文字是 DOM 文本，所以 `transform: scale()` 只是重新栅格化，不是拉伸一张旧图。
 * `.cg-world` 的 will-change 只在缩放/拖动期间由 editor.ts 临时加上（.cg-scaling），
 * 抬手即撤 —— 常驻会把整层固化成位图，那才是之前发虚的真凶。
 */

export const COMPOSITOR_STYLE = `
.cg-root {
  position: fixed;
  inset: 0;
  z-index: 2147482000;
  display: flex;
  flex-direction: column;
  /* 顶部让位给 DSH 桌面窗口的系统标题栏（titleBarOverlay 高 40px）：那一整条是
     Windows 的原生 caption 区，网页在上面收不到点击。用户 2026-10-30 报「上方的
     按钮点不动」——顶栏正好压在这条带子里。--cg-titlebar-top 由 editor.ts 按
     navigator.windowControlsOverlay 的几何写入（浏览器里 0）；DSH 自己的全屏
     面板也是 padding-top: var(--dsh-windows-titlebar-height) 的同一套做法。 */
  padding-top: var(--cg-titlebar-top, 0px);
  /* DSH 的窗口拖动带靠 -webkit-app-region: drag；这里显式退出，免得整层被当成拖拽区 */
  -webkit-app-region: no-drag;
  /* 原生控件（数字框的步进、滚动条、下拉弹层）跟着应用暗色走，别闪一片白 */
  color-scheme: dark;
  color: #eef1f6;
  font: 12px/1.45 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-variant-numeric: tabular-nums;
  user-select: none;
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(900px 420px at 12% -6%, rgba(94, 234, 212, .09), transparent 65%),
    radial-gradient(760px 420px at 92% 6%, rgba(139, 124, 246, .10), transparent 62%),
    #0b0d11;
}
.cg-root * { box-sizing: border-box; }
/* 圆形控件必须显式 corner-shape: round。
   DSH 的 nova 主题有一段
   '@supports (corner-shape: superellipse(1.5)) { *, ::before, ::after { corner-shape: superellipse(1.5) } }'，
   于是 border-radius: 50% 不再是正圆，而是**超椭圆**（看着就是个圆角方块）。
   用户 2026-10-30 报「我的色轮怎么变方了」就是这个：盘面 148px 一大块，超椭圆非常明显。
   规则：只要 reshape 依赖 50% / 999px，就在同一条规则里配 corner-shape: round。 */
.cg-root .cg-wheel,
.cg-root .cg-wheel::before,
.cg-root .cg-wheel::after,
.cg-root .cg-port,
.cg-root .cg-port::after,
.cg-root .cg-node-head .cg-dot,
.cg-root .cg-preview-label::before {
  corner-shape: round;
}

/* ---------------- 顶栏 ---------------- */
.cg-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-height: 50px;
  /* 右上角要给 Electron 原生窗口按钮（titleBarOverlay 的 − ▢ ✕）让位：
     它们是画在网页上方的，任何 z-index 都盖不住，之前「保存并退出」正好被压在按钮底下
     （用户 2026-10-29 报「没有应用按钮」）。--cg-topbar-right 由 editor.ts 按窗口几何写入，
     浏览器里是 0、桌面端是系统按钮宽度。 */
  padding: 8px 14px;
  padding-right: calc(14px + var(--cg-topbar-right, 0px));
  flex: 0 0 auto;
  background: rgba(12, 15, 20, .72);
  border-bottom: 1px solid rgba(255, 255, 255, .06);
  backdrop-filter: blur(18px);
}
/* 标题/尺寸先让位：按钮（尤其「保存并退出」）不许被挤出可视区 */
.cg-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: .2px;
  color: #f3f6fa;
}
.cg-meta {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #6b7383;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.cg-spacer { flex: 1 1 24px; min-width: 0; }
/* 主动作组：总在右上（窗口按钮左边），换行时整组靠右落一行 */
.cg-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  margin-left: auto;
}
.cg-btn {
  flex: 0 0 auto;
  white-space: nowrap;
  height: 29px;
  padding: 0 11px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, .09);
  background: rgba(255, 255, 255, .055);
  color: #d6dce6;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cg-btn:hover { background: rgba(255, 255, 255, .09); border-color: rgba(255, 255, 255, .16); color: #fff; }
.cg-btn:active { transform: translateY(1px); }
.cg-btn[disabled] { opacity: .38; cursor: default; }
.cg-btn.cg-active {
  background: rgba(94, 234, 212, .14);
  border-color: rgba(94, 234, 212, .3);
  color: #9cf5e6;
}
.cg-btn.cg-primary {
  background: linear-gradient(180deg, #6ff0da, #35cdb4);
  border-color: rgba(180, 255, 244, .55);
  color: #052621;
  font-weight: 700;
  box-shadow: 0 4px 16px rgba(53, 205, 180, .26);
}
.cg-btn.cg-primary:hover { filter: brightness(1.06); color: #03201c; }

/* ---------------- 上方预览：一块，以预览节点为主 ---------------- */
.cg-previews {
  flex: 0 0 auto;
  padding: 0 14px 12px;
  background: transparent;
}
.cg-preview-row { display: flex; align-items: stretch; gap: 12px; }
.cg-preview-row-wide .cg-scopes { display: none; }
.cg-preview {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  height: min(42vh, 540px);
  min-height: 180px;
  border-radius: 14px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 透明区用棋盘格垫底（浅一档的玻璃感，不要死黑） */
  background-color: #0a0c11;
  background-image: conic-gradient(from 45deg,
    rgba(255, 255, 255, .026) 25%, transparent 0 50%,
    rgba(255, 255, 255, .026) 0 75%, transparent 0);
  background-size: 18px 18px;
  border: 1px solid rgba(255, 255, 255, .08);
  box-shadow: 0 24px 60px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .06);
}
.cg-preview-canvas {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  border-radius: 7px;
  /* 缩放/平移只改这个 transform（见 editor.ts 的 applyPreviewView） */
  transform-origin: 0 0;
  will-change: transform;
  cursor: grab;
}
.cg-preview.cg-preview-panning .cg-preview-canvas { cursor: grabbing; }
.cg-preview-label {
  position: absolute;
  left: 12px;
  top: 11px;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 21px;
  padding: 0 9px;
  font-size: 10px;
  letter-spacing: .8px;
  text-transform: uppercase;
  font-weight: 600;
  color: #9ff0e2;
  background: rgba(10, 14, 19, .72);
  border: 1px solid rgba(94, 234, 212, .22);
  border-radius: 7px;
  pointer-events: none;
  backdrop-filter: blur(10px);
}
.cg-preview-label::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #5eead4;
  box-shadow: 0 0 8px #5eead4;
}
.cg-preview-label.cg-live { color: #8bf5e3; border-color: rgba(94, 234, 212, .45); }
.cg-preview-zoom {
  position: absolute;
  right: 12px;
  top: 11px;
  height: 21px;
  padding: 0 9px;
  display: flex;
  align-items: center;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: #c5cddb;
  background: rgba(10, 14, 19, .72);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: 7px;
  pointer-events: none;
  backdrop-filter: blur(10px);
}
.cg-preview-hint {
  position: absolute;
  right: 12px;
  bottom: 10px;
  font-size: 10px;
  color: #77808f;
  pointer-events: none;
}
.cg-preview-empty {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 0 24px;
  text-align: center;
  color: #7b8492;
  font-size: 11.5px;
  pointer-events: none;
}
.cg-preview-empty.cg-show { display: flex; }

/* ---------------- 示波器（波形图 / 分量图 / 矢量图，达芬奇同款） ---------------- */
.cg-scopes {
  position: relative;
  flex: 0 0 296px;
  width: 296px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px 10px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, .08);
  background: rgba(255, 255, 255, .045);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 18px 44px rgba(0, 0, 0, .35);
  backdrop-filter: blur(16px);
}
.cg-scopes.cg-scopes-hidden { display: none; }
.cg-scopes.cg-scopes-resizing { border-color: rgba(94, 234, 212, .4); }
.cg-scope-tabs { display: flex; gap: 4px; flex: 0 0 auto; }
.cg-scope-tab {
  flex: 1 1 0;
  height: 23px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, .045);
  color: #8c95a5;
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
  white-space: nowrap;
  padding: 0 2px;
}
.cg-scope-tab:hover { color: #dfe7f1; background: rgba(255, 255, 255, .08); }
.cg-scope-tab.cg-scope-active {
  color: #9cf5e6;
  border-color: rgba(94, 234, 212, .28);
  background: rgba(94, 234, 212, .13);
  font-weight: 600;
}
/* 示波器画布的定位壳：flex-grow 吃满剩余高度，canvas 绝对定位在其中。
   canvas 的固有宽高比会随属性尺寸变化，若让它参与 flex 布局会把父面板越撑越高。 */
.cg-scope-body {
  position: relative;
  flex: 1 1 0;
  min-height: 84px;
}
.cg-scope-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  border-radius: 6px;
  background: radial-gradient(130% 100% at 50% 0%, #0f1420, #070a10 75%);
  border: 1px solid rgba(255, 255, 255, .06);
}
.cg-scope-clip {
  flex: 0 0 auto;
  color: #7c8697;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 面板拉动条：左边缘改宽度、下边缘改高度（双击复位）。
   命中区比视觉宽一档，和端口的做法一样——细线不好抓。 */
.cg-scope-grip-x {
  position: absolute;
  left: -5px;
  top: 8px;
  bottom: 8px;
  width: 10px;
  cursor: ew-resize;
  z-index: 3;
  touch-action: none;
}
.cg-scope-grip-x::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 30px;
  border-radius: 1px;
  background: rgba(255, 255, 255, .16);
}
.cg-scope-grip-x:hover::after,
.cg-scopes-resizing .cg-scope-grip-x::after { background: rgba(94, 234, 212, .75); }
.cg-scope-grip-y {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -5px;
  height: 10px;
  cursor: ns-resize;
  z-index: 3;
  touch-action: none;
}
.cg-scope-grip-y::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 4px;
  transform: translateX(-50%);
  width: 30px;
  height: 2px;
  border-radius: 1px;
  background: rgba(255, 255, 255, .16);
}
.cg-scope-grip-y:hover::after,
.cg-scopes-resizing .cg-scope-grip-y::after { background: rgba(94, 234, 212, .75); }

/* ---------------- 节点画布 ---------------- */
.cg-stage {
  position: relative;
  flex: 1 1 auto;
  overflow: hidden;
  cursor: default;
  background-color: transparent;
  /* 两层点阵：updateGrid() 会按缩放喂两组 size/position —— 只留一层的话第二组会被忽略 */
  background-image:
    radial-gradient(circle at 1px 1px, rgba(255, 255, 255, .075) 1px, transparent 0),
    radial-gradient(circle at 1px 1px, rgba(255, 255, 255, .045) 1px, transparent 0);
  background-repeat: repeat;
  border-top: 1px solid rgba(255, 255, 255, .06);
}
.cg-stage.cg-space { cursor: grab; }
.cg-stage.cg-panning { cursor: grabbing; }
.cg-stage.cg-merging { cursor: crosshair; }
/* Ctrl+右键划过 = 断开：和主画布切刀同一套红色，一眼区分「这是切、不是合」 */
.cg-stage.cg-cutting { cursor: crosshair; }
.cg-merge-stroke {
  fill: none;
  stroke: rgba(255, 255, 255, .95);
  stroke-width: 1.6;
  stroke-dasharray: 7 5;
  stroke-linecap: round;
  pointer-events: none;
}
.cg-merge-hint {
  fill: none;
  stroke: #5eead4;
  stroke-width: 2.4;
  stroke-linecap: round;
  filter: drop-shadow(0 0 5px rgba(94, 234, 212, .55));
  pointer-events: none;
}
.cg-cut-hint {
  fill: none;
  stroke: #ff4d5a;
  stroke-width: 2.4;
  stroke-linecap: round;
  filter: drop-shadow(0 0 5px rgba(255, 77, 90, .55));
  pointer-events: none;
}
/* 节点层：默认不留 will-change（常驻会把整层固化成位图，缩放就发虚）。
   缩放/拖动期间 editor.ts 临时加 .cg-scaling，抬手即撤，让 Chrome 按新 DPI 重栅格化。 */
.cg-world {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
}
.cg-world.cg-scaling { will-change: transform; }
.cg-edges {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.cg-edge {
  fill: none;
  stroke: #4fd8c4;
  stroke-width: 1.8;
  stroke-linecap: round;
  filter: drop-shadow(0 0 6px rgba(94, 234, 212, .18));
}
.cg-edge.cg-edge-sel {
  stroke: #eaf6ff;
  stroke-width: 2.1;
  filter: drop-shadow(0 0 8px rgba(160, 240, 255, .5));
}
.cg-edge.cg-edge-active { stroke: #a7fff1; stroke-width: 2; }
.cg-edge-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 16;
  pointer-events: stroke;
  cursor: pointer;
}
.cg-edge-hit:hover { stroke: rgba(94, 234, 212, .14); }

.cg-node {
  position: absolute;
  width: 224px;
  border-radius: 13px;
  background: linear-gradient(180deg, #1a1f27, #151a21);
  border: 1px solid rgba(255, 255, 255, .09);
  box-shadow: 0 18px 40px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .07);
}
.cg-node.cg-selected {
  box-shadow:
    0 0 0 1.5px rgba(94, 234, 212, .8),
    0 0 30px rgba(94, 234, 212, .18),
    0 18px 40px rgba(0, 0, 0, .55);
}
/* 转接点：Blender Reroute 那种小圆点（34×34），不是卡片 */
.cg-node.cg-node-compact { width: 34px; height: 34px; border-radius: 50%; }
.cg-node.cg-node-compact .cg-node-head {
  height: 34px;
  padding: 0;
  justify-content: center;
  border-bottom: none;
  border-radius: 50%;
  background: linear-gradient(180deg, #232a34, #171c24);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .09);
}
.cg-node.cg-node-compact .cg-node-title,
.cg-node.cg-node-compact .cg-node-kind { display: none; }
.cg-node.cg-node-compact .cg-dot {
  width: 7px;
  height: 7px;
  background: #eaf6ff;
  box-shadow: 0 0 12px rgba(180, 240, 255, .75);
}
.cg-node-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 11px;
  border-radius: 12px 12px 0 0;
  color: #f2f5fa;
  font-size: 12px;
  font-weight: 600;
  cursor: move;
  background: linear-gradient(180deg, rgba(255, 255, 255, .055), rgba(255, 255, 255, .01));
}
.cg-node-head::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: rgba(255, 255, 255, .07);
}
/* 分类色：不再铺满标题栏，收成一颗小圆点（--cg-cat 由 editor.ts 按节点种类写进内联样式） */
.cg-node-head .cg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cg-cat, #6b7686);
  box-shadow: 0 0 9px 0 var(--cg-cat, #6b7686);
  flex: 0 0 auto;
}
.cg-node-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cg-node-kind {
  margin-left: auto;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: .4px;
  color: #79828f;
}
.cg-node-body {
  padding: 9px 10px 10px;
  min-height: 28px;
  color: #98a1b0;
  font-size: 11px;
  background: transparent;
  border-radius: 0 0 12px 12px;
}
.cg-node-body .cg-thumb {
  width: 100%;
  height: 96px;
  object-fit: cover;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, .09);
  display: block;
  background: #0a0c11;
}
.cg-node-body .cg-thumb + .cg-thumb { margin-top: 6px; }
.cg-node-body .cg-empty { color: #7c8592; font-size: 10.5px; }

/* ---------------- 节点体内的参数控件（参数直接长在节点上，没有右侧面板） ---------------- */
.cg-param {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.cg-param:last-child { margin-bottom: 0; }
.cg-param > label {
  color: #8f98a8;
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cg-param-control { display: flex; align-items: center; gap: 4px; min-width: 0; }
.cg-param-control input[type="checkbox"] { accent-color: #35cdb4; margin: 0; }

/* ---------------- 自绘下拉 ----------------
   原生 <select> 的弹层由系统画（Windows 上一片纯白、只能点完才知道选了啥），
   节点里这种小控件改用按钮 + 挂在 body 上的深色列表：样式可控、和示波器 tab 同一套观感。 */
.cg-select { position: relative; flex: 1 1 auto; min-width: 0; }
.cg-select-button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 20px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, .08);
  background: rgba(255, 255, 255, .05);
  color: #eaf0f8;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
  text-align: left;
}
.cg-select-button:hover { background: rgba(255, 255, 255, .09); border-color: rgba(255, 255, 255, .16); }
.cg-select-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cg-select-caret {
  flex: 0 0 auto;
  width: 0;
  height: 0;
  border-left: 3.5px solid transparent;
  border-right: 3.5px solid transparent;
  border-top: 4.5px solid #8b95a5;
}
.cg-select.cg-open .cg-select-button { border-color: rgba(94, 234, 212, .55); color: #fff; }
.cg-select-list {
  position: fixed;
  z-index: 2147482100;
  min-width: 132px;
  max-height: 44vh;
  overflow: auto;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, .12);
  background: rgba(18, 23, 30, .98);
  box-shadow: 0 18px 42px rgba(0, 0, 0, .6);
  backdrop-filter: blur(16px);
}
.cg-select-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  color: #cfd7e2;
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  white-space: nowrap;
}
.cg-select-option:hover,
.cg-select-option.cg-active { background: rgba(94, 234, 212, .14); color: #fff; }
.cg-select-option.cg-selected { color: #9cf5e6; font-weight: 600; }
.cg-select-check { flex: 0 0 auto; width: 9px; color: #5eead4; }
.cg-param-control select {
  flex: 1 1 auto;
  min-width: 0;
  height: 20px;
  background: rgba(255, 255, 255, .05);
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 6px;
  color: #eaf0f8;
  font: inherit;
  font-size: 10px;
  padding: 0 4px;
}
/* 数字参数：全宽滑块（标签/数值印在轨道上）+ 数字框。 */
.cg-param-slider { grid-template-columns: minmax(0, 1fr) 44px; gap: 4px; margin-bottom: 5px; }
.cg-slider {
  position: relative;
  height: 19px;
  border-radius: 6px;
  background: rgba(0, 0, 0, .34);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .07);
  cursor: ew-resize;
  overflow: hidden;
  touch-action: none;
}
.cg-slider:focus { outline: none; box-shadow: inset 0 0 0 1px rgba(94, 234, 212, .5); }
.cg-slider-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 0;
  background: linear-gradient(90deg, rgba(94, 234, 212, .14), rgba(94, 234, 212, .42));
  border-right: 1px solid rgba(148, 255, 238, .55);
  pointer-events: none;
}
.cg-slider-active .cg-slider-fill {
  background: linear-gradient(90deg, rgba(94, 234, 212, .28), rgba(94, 234, 212, .62));
  border-right-color: rgba(190, 255, 245, .85);
}
.cg-slider-label {
  position: absolute;
  left: 7px;
  top: 0;
  height: 100%;
  display: flex;
  align-items: center;
  font-size: 10px;
  color: #a6b0be;
  pointer-events: none;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cg-slider-value {
  position: absolute;
  right: 7px;
  top: 0;
  height: 100%;
  display: flex;
  align-items: center;
  font-size: 10px;
  color: #eef4fa;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.cg-param-number {
  width: 44px;
  height: 19px;
  background: rgba(255, 255, 255, .05);
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 6px;
  color: #eaf0f8;
  font: inherit;
  font-size: 10px;
  padding: 0 4px;
  text-align: right;
}
.cg-mini-btn {
  flex: 0 0 auto;
  height: 19px;
  padding: 0 7px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, .09);
  background: rgba(255, 255, 255, .05);
  color: #9aa4b2;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.cg-mini-btn:hover { color: #9cf5e6; border-color: rgba(94, 234, 212, .35); }

/* ---------------- 四轮调色：色轮是矢量梯度，不是位图 ---------------- */
.cg-node.cg-node-wheels { width: 792px; }
.cg-node-wheels .cg-node-body { padding: 9px 10px 10px; }
.cg-wheels {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.cg-wheel-block { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cg-wheel-head { position: relative; display: flex; align-items: center; gap: 4px; height: 16px; padding: 0 2px; }
/* 参照图那个准星图标在这里退成一颗暗点：标题栏越干净，名字和复位越清楚 */
.cg-wheel-mark { display: none; }
.cg-wheel-mark::before,
.cg-wheel-mark::after { content: ''; position: absolute; background: rgba(226, 226, 232, .45); }
.cg-wheel-mark::before { left: 50%; top: -2px; bottom: -2px; width: 1px; transform: translateX(-50%); }
.cg-wheel-mark::after { top: 50%; left: -2px; right: -2px; height: 1px; transform: translateY(-50%); }
.cg-wheel-name {
  flex: 1 1 auto;
  text-align: center;
  color: #dfe6f0;
  font-size: 11px;
  letter-spacing: .6px;
  white-space: nowrap;
}
.cg-wheel-reset {
  position: absolute;
  right: 0;
  top: 0;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #7d8794;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.cg-wheel-reset:hover { color: #9cf5e6; background: rgba(94, 234, 212, .12); }
.cg-wheel-disc { position: relative; width: 148px; height: 148px; margin: 0 auto; }
/* 盘面用 conic + radial 梯度合成：
   ::before = 色相盘（中心中性白 → 外圈全饱和，边缘再压暗一档做球面感）
   ::after  = 外圈亮度轨道（和 overlay 里 47/112 的弧半径对齐） */
.cg-wheel {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  cursor: crosshair;
  touch-action: none;
}
.cg-wheel::before {
  content: '';
  position: absolute;
  inset: 16.07%;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%,
      rgba(236, 240, 246, .98) 0 3%,
      rgba(226, 231, 240, .86) 8%,
      rgba(206, 213, 226, .4) 20%,
      rgba(196, 204, 218, .08) 36%,
      rgba(196, 204, 218, 0) 52%),
    radial-gradient(circle at 50% 50%,
      rgba(0, 0, 0, 0) 62%,
      rgba(0, 0, 0, .14) 84%,
      rgba(0, 0, 0, .28) 100%),
    conic-gradient(from 90deg,
      hsl(0 92% 54%), hsl(20 92% 54%), hsl(40 92% 54%), hsl(60 92% 52%),
      hsl(80 92% 50%), hsl(120 92% 50%), hsl(160 92% 50%), hsl(190 92% 52%),
      hsl(215 92% 54%), hsl(245 92% 56%), hsl(275 92% 56%), hsl(305 92% 55%),
      hsl(335 92% 54%), hsl(360 92% 54%));
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, .12),
    0 2px 10px rgba(0, 0, 0, .4);
}
.cg-wheel::after {
  content: '';
  position: absolute;
  inset: 8.04%;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, .055);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .38);
  pointer-events: none;
}
.cg-wheel-overlay { position: absolute; inset: 0; width: 148px; height: 148px; pointer-events: none; }
.cg-wheel-arc {
  stroke: #9ff0e2;
  stroke-width: 4.6;
  opacity: .82;
  filter: drop-shadow(0 0 3px rgba(120, 240, 225, .3));
}
.cg-wheel-dot { fill: #ffffff; stroke: #0b0d11; stroke-width: 1.4; }
.cg-wheel-values { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; }
.cg-wheel-values-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.cg-wheel-value {
  width: 100%;
  height: 19px;
  padding: 0 2px;
  background: rgba(255, 255, 255, .05);
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 6px;
  color: #eef4fa;
  font: inherit;
  font-size: 9.5px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
  appearance: textfield;
}
.cg-wheel-value::-webkit-outer-spin-button,
.cg-wheel-value::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.cg-wheel-value[data-channel="master"] { box-shadow: inset 0 -2px 0 rgba(255, 255, 255, .32); }
.cg-wheel-value[data-channel="R"] { box-shadow: inset 0 -2px 0 rgba(226, 94, 94, .55); }
.cg-wheel-value[data-channel="G"] { box-shadow: inset 0 -2px 0 rgba(94, 200, 120, .5); }
.cg-wheel-value[data-channel="B"] { box-shadow: inset 0 -2px 0 rgba(94, 140, 226, .6); }
.cg-wheel-value:focus { outline: none; border-color: rgba(167, 255, 241, .7); color: #fff; }
.cg-wheel-minis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.cg-wheel-minis-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.cg-wheel-mini {
  position: relative;
  height: 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, .4);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05);
  cursor: ew-resize;
  touch-action: none;
  overflow: hidden;
}
.cg-wheel-mini-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 50%; opacity: .9; }
.cg-wheel-mini-master .cg-wheel-mini-fill { background: linear-gradient(180deg, #f2f7ff, #b9c4d4); }
.cg-wheel-mini-R .cg-wheel-mini-fill { background: linear-gradient(180deg, #e2605e, #a82c2c); }
.cg-wheel-mini-G .cg-wheel-mini-fill { background: linear-gradient(180deg, #59c674, #2f8438); }
.cg-wheel-mini-B .cg-wheel-mini-fill { background: linear-gradient(180deg, #5c93e6, #2d55a6); }
.cg-wheel-bar {
  position: relative;
  height: 11px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, .07);
  background-color: rgba(0, 0, 0, .35);
  background-image: repeating-linear-gradient(
    90deg,
    rgba(255, 255, 255, .08) 0 1px,
    transparent 1px 7px
  );
  cursor: ew-resize;
  touch-action: none;
  overflow: hidden;
}
.cg-wheel-bar-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 4px;
  background: rgba(94, 234, 212, .3);
}
.cg-wheel-bar-knob {
  position: absolute;
  top: 1px;
  bottom: 1px;
  width: 3px;
  margin-left: -1.5px;
  border-radius: 1px;
  background: #eaf6ff;
  box-shadow: 0 0 8px rgba(160, 240, 255, .7);
}

/* 曲线编辑器（节点体内，viewBox 200×104 拉伸到卡片宽度） */
.cg-curve {
  display: block;
  width: 100%;
  height: 104px;
  margin-top: 2px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, .08);
  background: rgba(0, 0, 0, .32);
  touch-action: none;
  cursor: crosshair;
}
.cg-curve-grid { fill: none; stroke: rgba(255, 255, 255, .06); stroke-width: 1; }
.cg-curve-diagonal { fill: none; stroke: rgba(255, 255, 255, .12); stroke-width: 1; stroke-dasharray: 3 3; }
.cg-curve-line {
  fill: none;
  stroke: #5eead4;
  stroke-width: 1.6;
  stroke-linecap: round;
  filter: drop-shadow(0 0 4px rgba(94, 234, 212, .35));
}
.cg-curve-point {
  fill: #0b0d11;
  stroke: #8ff3e2;
  stroke-width: 1.4;
  cursor: grab;
  vector-effect: non-scaling-stroke;
}
.cg-curve-point:hover { fill: #5eead4; }

.cg-port {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid #6b7686;
  background: #0d1118;
  cursor: crosshair;
  z-index: 2;
  box-shadow: 0 0 0 3px rgba(0, 0, 0, .28);
  transition: border-color .08s ease, background .08s ease, box-shadow .08s ease;
}
/* 端口看着只有 12px，命中区给到 28px：用户报「连线判定太小、经常接不上」。 */
.cg-port::after {
  content: '';
  position: absolute;
  inset: -8px;
  border-radius: 50%;
}
.cg-port.cg-in { left: -6px; }
.cg-port.cg-out { right: -6px; }
.cg-port:hover { border-color: #a7fff1; background: #123a36; }
.cg-port.cg-linked { border-color: #a7fff1; background: #5eead4; box-shadow: 0 0 10px rgba(94, 234, 212, .5); }
.cg-port.cg-linked:hover { background: #b9fff5; border-color: #ddfffa; }
.cg-stage.cg-linking .cg-port.cg-in { border-color: #8fd0ff; box-shadow: 0 0 0 2px rgba(143, 208, 255, .15); }
/* 拖线时指针悬在节点上：把整张卡片的输入口点亮，松手就接第一个空口 */
.cg-node.cg-snap-target .cg-port.cg-in {
  border-color: #a7fff1;
  background: #123a36;
  box-shadow: 0 0 0 4px rgba(94, 234, 212, .22);
}
/* 拖节点压住的连线：变蓝加粗，松手就串进去 */
.cg-edge.cg-edge-splice {
  stroke: #8fd0ff;
  stroke-width: 2.8;
  filter: drop-shadow(0 0 5px rgba(143, 208, 255, .55));
}

.cg-marquee {
  position: absolute;
  border: 1px solid rgba(94, 234, 212, .8);
  background: rgba(94, 234, 212, .1);
  border-radius: 4px;
  pointer-events: none;
}

/* 快捷键提示条（右侧属性面板拆掉后，这条接替它承担「怎么操作」） */
.cg-hintbar {
  position: absolute;
  left: 14px;
  right: 150px;
  bottom: 11px;
  color: #69727f;
  font-size: 10px;
  line-height: 1.5;
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 画布右下角缩放读数：− 100% + ⤢（和顶栏的「适应视图」同一个动作，顺手可点） */
.cg-zoom {
  position: absolute;
  right: 14px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 1px;
  height: 26px;
  padding: 0 4px;
  border-radius: 9px;
  background: rgba(14, 18, 24, .82);
  border: 1px solid rgba(255, 255, 255, .1);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .4);
  backdrop-filter: blur(14px);
  color: #b9c3d1;
  font-size: 10.5px;
}
.cg-zoom button {
  width: 19px;
  height: 19px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.cg-zoom button:hover { background: rgba(94, 234, 212, .14); color: #9cf5e6; }
.cg-zoom-value {
  min-width: 40px;
  text-align: center;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: .2px;
  color: #eef3f9;
}

.cg-menu {
  position: fixed;
  z-index: 2147482100;
  min-width: 186px;
  max-height: 60vh;
  overflow: auto;
  background: rgba(20, 25, 32, .96);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: 12px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, .62);
  padding: 5px;
  backdrop-filter: blur(18px);
}
.cg-menu-section {
  padding: 6px 8px 3px;
  font-size: 9.5px;
  letter-spacing: .6px;
  text-transform: uppercase;
  color: #6f7887;
}
.cg-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 7px;
  color: #d3dae4;
  font-size: 11.5px;
  cursor: pointer;
}
.cg-menu-item:hover { background: rgba(94, 234, 212, .12); color: #fff; }
.cg-menu-item.cg-active { background: rgba(94, 234, 212, .18); color: #fff; }
/* 搜索时右侧那行分类小字（"颜色" / "滤镜"），帮人一眼看出结果属于哪一类 */
.cg-menu-hint {
  margin-left: auto;
  padding-left: 8px;
  color: #6f7887;
  font-size: 9.5px;
  letter-spacing: .3px;
}
/* 搜索框钉在菜单顶部：滚动列表时它不会跟着消失 */
.cg-menu-search {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 3px 3px 6px;
  background: linear-gradient(180deg, rgba(20, 25, 32, .99), rgba(20, 25, 32, .9));
}
.cg-menu-search input {
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, .12);
  background: rgba(255, 255, 255, .05);
  color: #eef4fa;
  font: inherit;
  font-size: 11px;
  outline: none;
}
.cg-menu-search input::placeholder { color: #6b7484; }
.cg-menu-search input:focus { border-color: rgba(94, 234, 212, .55); }
.cg-menu-empty { padding: 10px 8px; color: #6f7887; font-size: 11px; }
.cg-toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  background: rgba(20, 25, 32, .96);
  border: 1px solid rgba(255, 255, 255, .1);
  color: #e6edf6;
  font-size: 11.5px;
  padding: 8px 14px;
  border-radius: 10px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, .5);
  z-index: 2147482200;
  opacity: 0;
  transition: opacity .16s ease;
  pointer-events: none;
  backdrop-filter: blur(14px);
}
.cg-toast.cg-show { opacity: 1; }
.cg-toast.cg-error { border-color: rgba(255, 120, 120, .45); color: #ffd0d0; }
`;

