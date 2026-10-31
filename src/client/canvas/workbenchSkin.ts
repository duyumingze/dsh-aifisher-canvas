/**
 * 工作台皮肤（图像编辑 / 裁剪 / 扩图共用，方案 C 玻璃面板）。
 *
 * 与画布皮肤（skin.ts）同一套令牌，只补「工作台」这一层：
 *   顶栏 54 / 左工具条 56 / 画布台 / 右侧检查器 320。
 *
 * 为什么单独一个文件：`skin.ts` 已经 28KB，且只该管画布 Chrome 与节点；
 * 工作台是对话框语义（fixed 覆盖画布区域），样式边界清楚，放一起会互相打架。
 *
 * 所有类名 afw- 前缀，只作用于工作台根节点之下，不会误伤画布与 DSH。
 */
export const WORKBENCH_SKIN_CSS = `
/* ============================ 工作台骨架 ============================ */

.afw-root {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #07090c;
  color: var(--af-text, #e9eef6);
  font-size: 12.5px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

.afw-top {
  flex: 0 0 auto;
  height: 54px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px 0 12px;
  background: linear-gradient(180deg, rgba(14, 17, 23, .96), rgba(12, 15, 20, .8));
  border-bottom: 1px solid var(--af-border, rgba(255, 255, 255, .075));
  position: relative;
  z-index: 4;
}
.afw-top::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(94, 234, 212, .3) 32%, rgba(139, 124, 246, .26) 68%, transparent);
  opacity: .7;
  pointer-events: none;
}

.afw-title { font-size: 13.5px; font-weight: 600; letter-spacing: .2px; }
.afw-sub { font-size: 11px; color: var(--af-text-muted, #6c7688); }
.afw-sep { width: 1px; height: 16px; background: var(--af-border-control, rgba(255, 255, 255, .13)); }

.afw-body { flex: 1 1 auto; min-height: 0; display: flex; }

/* 左工具条 */
.afw-rail {
  flex: 0 0 auto;
  width: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 12px 0;
  border-right: 1px solid var(--af-border, rgba(255, 255, 255, .075));
  background: linear-gradient(180deg, rgba(13, 16, 22, .6), rgba(11, 13, 17, .35));
}

.afw-tool {
  position: relative;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--af-text-secondary, #a7b2c3);
  cursor: pointer;
  transition: background .15s, color .15s;
}
.afw-tool:hover { background: rgba(255, 255, 255, .055); color: var(--af-text, #e9eef6); }
.afw-tool:disabled { opacity: .38; cursor: not-allowed; }
.afw-tool[aria-pressed="true"] {
  background: rgba(94, 234, 212, .12);
  border-color: rgba(94, 234, 212, .38);
  color: #5eead4;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 16px rgba(94, 234, 212, .12);
}
.afw-tool[aria-pressed="true"]::before {
  content: "";
  position: absolute;
  left: -9px;
  top: 12px;
  bottom: 12px;
  width: 2px;
  border-radius: 2px;
  background: #5eead4;
  box-shadow: 0 0 10px rgba(94, 234, 212, .6);
}
.afw-tool svg { width: 18px; height: 18px; }
.afw-tool-on { color: #5eead4; }
.afw-tool-on::after {
  content: "";
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #5eead4;
  box-shadow: 0 0 6px rgba(94, 234, 212, .7);
}
.afw-rail-div { width: 22px; height: 1px; background: var(--af-border-control, rgba(255, 255, 255, .13)); margin: 7px 0; }

/* 中间：画布台 */
.afw-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }

.afw-stage {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background:
    radial-gradient(760px 520px at 48% 34%, rgba(255, 255, 255, .028), transparent 68%),
    #07090c;
}

.afw-foot {
  flex: 0 0 auto;
  height: 46px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-top: 1px solid var(--af-border, rgba(255, 255, 255, .075));
  background: rgba(10, 13, 18, .72);
}

/* 旧版横向工具条（标注 / 宫格裁剪还在用这个结构，先统一皮肤） */
.afw-toolbar {
  flex: 0 0 auto;
  min-height: 44px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--af-border, rgba(255, 255, 255, .075));
  background: rgba(13, 16, 22, .6);
}

/* 右侧检查器 */
.afw-insp {
  flex: 0 0 auto;
  width: 320px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--af-border, rgba(255, 255, 255, .075));
  background: linear-gradient(180deg, rgba(19, 23, 30, .92), rgba(14, 17, 23, .9));
}
.afw-insp-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px 11px;
  border-bottom: 1px solid var(--af-border, rgba(255, 255, 255, .075));
}
.afw-insp-head h2 { margin: 0; font-size: 12.5px; font-weight: 650; }
.afw-insp-head .afw-sub { margin-top: 1px; }
.afw-insp-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
.afw-sect {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, .055);
}
.afw-sect:last-child { border-bottom: 0; }
.afw-sect-t {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .8px;
  text-transform: uppercase;
  color: var(--af-text-muted, #6c7688);
}
.afw-sect-t .r { font-size: 10.5px; font-weight: 500; letter-spacing: 0; text-transform: none; }

.afw-kv { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11.5px; color: var(--af-text-secondary, #a7b2c3); }
.afw-kv b { font-weight: 600; color: var(--af-text, #e9eef6); font-variant-numeric: tabular-nums; }
.afw-note { font-size: 10.5px; line-height: 1.6; color: var(--af-text-muted, #6c7688); }

.afw-insp-foot {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--af-border, rgba(255, 255, 255, .075));
  background: rgba(10, 13, 18, .5);
}

/* ============================ 控件 ============================ */

.afw-root button[data-fisherai-image-save] {
  height: 34px;
  padding: 0 14px;
  border-radius: 9px;
  border: 1px solid rgba(122, 242, 223, .55);
  background: linear-gradient(180deg, #7af2df, #3fd5bd);
  color: #062b26;
  font: 600 12px/1 inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-shadow: 0 6px 18px rgba(63, 213, 189, .28), inset 0 1px 0 rgba(255, 255, 255, .45);
  cursor: pointer;
}
/* 只有检查器底部那个主按钮占满剩余宽度；旧版横向工作台（标注/宫格）里保持胶囊宽度 */
.afw-insp-foot button[data-fisherai-image-save] { flex: 1 1 auto; }
.afw-root button[data-fisherai-image-save]:hover { filter: brightness(1.05); }
.afw-root button[data-fisherai-image-save]:disabled { opacity: .45; cursor: not-allowed; filter: none; }

.afw-ghost {
  height: 34px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px solid var(--af-border-control, rgba(255, 255, 255, .13));
  background: rgba(255, 255, 255, .04);
  color: var(--af-text, #e9eef6);
  font: 600 12px/1 inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.afw-ghost:hover { background: rgba(255, 255, 255, .075); }

.afw-iconbtn {
  width: 30px;
  height: 30px;
  display: inline-grid;
  place-items: center;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--af-text-secondary, #a7b2c3);
  cursor: pointer;
}
.afw-iconbtn:hover { background: rgba(255, 255, 255, .055); color: var(--af-text, #e9eef6); }
.afw-iconbtn:disabled { opacity: .38; cursor: not-allowed; }
.afw-iconbtn svg { width: 16px; height: 16px; }

/* 比例 / 选项 chip（沿用 attr 语义，不改数据契约） */
.afw-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.afw-root [data-fisherai-crop-ratio] {
  height: 28px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--af-border-control, rgba(255, 255, 255, .13));
  background: rgba(255, 255, 255, .025);
  color: var(--af-text-secondary, #a7b2c3);
  font: 500 11px/1 inherit;
  cursor: pointer;
}
.afw-root [data-fisherai-crop-ratio]:hover { background: rgba(255, 255, 255, .06); color: var(--af-text, #e9eef6); }
.afw-root [data-fisherai-crop-ratio][aria-pressed="true"] {
  background: rgba(94, 234, 212, .12);
  border-color: rgba(94, 234, 212, .38);
  color: #5eead4;
}

.afw-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 21px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--af-border, rgba(255, 255, 255, .075));
  background: rgba(255, 255, 255, .04);
  color: var(--af-text-secondary, #a7b2c3);
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.afw-badge.mint { background: rgba(94, 234, 212, .12); border-color: rgba(94, 234, 212, .3); color: #5eead4; }

.afw-size-chip {
  position: absolute;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 9px;
  border-radius: 7px;
  background: rgba(9, 12, 16, .82);
  border: 1px solid var(--af-border-control, rgba(255, 255, 255, .13));
  color: var(--af-text, #e9eef6);
  font: 600 10.5px/1 inherit;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  backdrop-filter: blur(8px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, .45);
}

.afw-thumbs { display: flex; gap: 6px; flex-wrap: wrap; }
.afw-root [data-fisherai-image-source] {
  width: 62px;
  height: 62px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid var(--af-border-control, rgba(255, 255, 255, .13));
  background: #12161d;
  overflow: hidden;
  cursor: pointer;
}
.afw-root [data-fisherai-image-source] img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: .9; }
.afw-root [data-fisherai-image-source][aria-pressed="true"] {
  border-color: #5eead4;
  box-shadow: 0 0 0 1px rgba(94, 234, 212, .3), 0 0 14px rgba(94, 234, 212, .25);
}

.afw-stage-img {
  border: 1px solid rgba(255, 255, 255, .1);
  box-shadow: 0 26px 60px rgba(0, 0, 0, .6);
}

.afw-alert { font-size: 11px; color: #f87171; }
.afw-status { font-size: 10.5px; color: var(--af-text-muted, #6c7688); line-height: 1.5; }

/* ============================ 扩图面板（vendor 浮层，只换视觉） ============================
   扩图面板本体在 vendor 的 canvasMediaToolbar 里（不改 vendor 渲染），
   这里按 data 属性把「玻璃卡 + 青色选中 + 虚线圈出扩展区」的观感补上。
   v1.83 起它只是**兜底**：正常路径是整页工作台（见本文件末尾的 .afo-*），
   只有「整页桥没挂上」的宿主才会用到这一段。 */

.af-canvas-mount [data-fisherai-outpaint-panel] {
  border-radius: 14px !important;
  border: 1px solid rgba(255, 255, 255, .13) !important;
  background: linear-gradient(180deg, rgba(21, 25, 32, .97), rgba(14, 17, 23, .97)) !important;
  box-shadow: 0 24px 60px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .05) !important;
}

.af-canvas-mount [data-fisherai-outpaint-preview] {
  border-color: rgba(94, 234, 212, .28) !important;
  box-shadow: inset 0 0 24px rgba(0, 0, 0, .45);
}

.af-canvas-mount [data-fisherai-outpaint-preview-image] {
  border: 1px dashed rgba(94, 234, 212, .65) !important;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .35), 0 8px 20px rgba(0, 0, 0, .4);
}

.af-canvas-mount [data-fisherai-outpaint-ratio][aria-pressed="true"],
.af-canvas-mount [data-fisherai-outpaint-anchor][aria-pressed="true"] {
  border-color: rgba(94, 234, 212, .45) !important;
  background: rgba(94, 234, 212, .12) !important;
  color: #5eead4 !important;
}

.af-canvas-mount [data-fisherai-outpaint-anchor][aria-pressed="true"] span {
  background: #5eead4 !important;
  box-shadow: 0 0 8px rgba(94, 234, 212, .7);
}

.af-canvas-mount [data-fisherai-outpaint-panel] textarea {
  border-radius: 9px !important;
  border-color: rgba(255, 255, 255, .13) !important;
  background: rgba(0, 0, 0, .28) !important;
  color: var(--af-text, #e9eef6) !important;
}
.af-canvas-mount [data-fisherai-outpaint-panel] textarea:focus {
  border-color: rgba(94, 234, 212, .45) !important;
  outline: none;
}

/* 扩图工作台（vendor 面板放大后）：舞台 + 参数两栏 */
.af-canvas-mount .af-outpaint-page {
  max-height: min(76vh, 760px);
  overflow: auto;
  background: linear-gradient(180deg, rgba(21, 25, 32, .98), rgba(14, 17, 23, .98)) !important;
}
.af-canvas-mount .af-outpaint-body { align-items: flex-start; }
.af-canvas-mount .af-outpaint-stage {
  padding: 4px;
  border-radius: 12px;
  background: #07090c;
  border: 1px solid rgba(255, 255, 255, .08);
}
.af-canvas-mount .af-outpaint-stage [data-fisherai-outpaint-preview] {
  border-radius: 8px !important;
  border-color: rgba(94, 234, 212, .22) !important;
}
.af-canvas-mount .af-outpaint-stage [data-fisherai-outpaint-preview-caption] {
  padding: 4px 2px 0;
  font-variant-numeric: tabular-nums;
}

/* ============================ 整页扩图工作台（v1.83） ============================
   页面本体在 src/canvas-ui/canvas/CanvasOutpaintStudio.tsx：portal 到 .af-canvas-mount，
   铺满画布容器（顶栏 54 / 大舞台 / 右参数栏 362）。上面那一段是 vendor 520 气泡的兜底皮肤，
   桥没挂上（非画布宿主）时仍会用到，所以两段都留着。 */

.afo-root {
  font-size: 12.5px;
  border: 1px solid rgba(255, 255, 255, .06);
  animation: afo-page-in .16s ease-out;
}
@keyframes afo-page-in {
  from { opacity: 0; transform: scale(1.012); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .afo-root { animation: none; }
}

.afo-head-ico { width: 16px; height: 16px; flex: 0 0 auto; color: #5eead4; }
.afo-dim { font-variant-numeric: tabular-nums; }

.afo-body { min-height: 0; }
.afo-main { position: relative; min-width: 0; }

/* ---- 舞台：整张目标画幅 ---- */
.afo-stage { padding: 0; }
.afo-stage-hint {
  position: absolute;
  left: 14px;
  top: 12px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 8px;
  background: rgba(9, 12, 16, .72);
  border: 1px solid rgba(255, 255, 255, .08);
  color: var(--af-text-secondary, #a7b2c3);
  font: 500 11px/1 inherit;
  white-space: nowrap;
  backdrop-filter: blur(8px);
  max-width: calc(100% - 28px);
  overflow: hidden;
  text-overflow: ellipsis;
}
.afo-frame-wrap { display: flex; align-items: center; justify-content: center; }
.afo-frame {
  position: relative;
  flex: 0 0 auto;
  background: #06080b;
  border: 1px solid rgba(94, 234, 212, .34);
  box-shadow: 0 26px 64px rgba(0, 0, 0, .62), 0 0 0 1px rgba(0, 0, 0, .5);
}
.afo-frame > img {
  display: block;
  object-fit: cover;
  object-position: center;
  border: 1px dashed rgba(94, 234, 212, .55);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .35);
}
/* 待补区域：斜纹 + 冷色描边（不是「已经填好的画面」，别让预览骗人） */
.afo-zone {
  position: absolute;
  pointer-events: none;
  background:
    repeating-linear-gradient(135deg, rgba(94, 234, 212, .055) 0 10px, rgba(0, 0, 0, 0) 10px 20px),
    rgba(8, 11, 15, .58);
}
.afo-zone-l { border-right: 1px dashed rgba(94, 234, 212, .45); }
.afo-zone-r { border-left: 1px dashed rgba(94, 234, 212, .45); }
.afo-zone-t { border-bottom: 1px dashed rgba(94, 234, 212, .45); }
.afo-zone-b { border-top: 1px dashed rgba(94, 234, 212, .45); }

.afo-ext-chip {
  position: absolute;
  z-index: 2;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  background: rgba(6, 12, 12, .72);
  border: 1px solid rgba(94, 234, 212, .4);
  color: #5eead4;
  font: 600 10.5px/20px inherit;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.afo-chip-left { left: 10px; top: 10px; }
.afo-chip-right { right: 10px; top: 10px; }
.afo-chip-top { left: 50%; top: 8px; transform: translateX(-50%); }
.afo-chip-bottom { left: 50%; bottom: 8px; transform: translateX(-50%); }

.afo-corner {
  position: absolute;
  width: 13px;
  height: 13px;
  z-index: 3;
  border: 0 solid #5eead4;
  opacity: .85;
  pointer-events: none;
}
.afo-corner-tl { left: -1px; top: -1px; border-left-width: 2px; border-top-width: 2px; }
.afo-corner-tr { right: -1px; top: -1px; border-right-width: 2px; border-top-width: 2px; }
.afo-corner-bl { left: -1px; bottom: -1px; border-left-width: 2px; border-bottom-width: 2px; }
.afo-corner-br { right: -1px; bottom: -1px; border-right-width: 2px; border-bottom-width: 2px; }

.afo-src-chip {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  height: 22px;
  padding: 0 9px;
  border-radius: 6px;
  background: rgba(6, 12, 12, .72);
  border: 1px solid rgba(255, 255, 255, .16);
  color: var(--af-text-secondary, #a7b2c3);
  font: 500 10.5px/20px inherit;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}

.afo-stage-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--af-text-muted, #6c7688);
  font-size: 12px;
}

.afo-footline {
  flex: 0 0 auto;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
  border-top: 1px solid rgba(255, 255, 255, .055);
  color: var(--af-text-muted, #6c7688);
  font-size: 11px;
}
.afo-footline b { color: var(--af-text-secondary, #a7b2c3); font-weight: 600; font-variant-numeric: tabular-nums; }
.afo-keys { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.afo-kbd {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, .12);
  background: rgba(255, 255, 255, .045);
  color: var(--af-text-secondary, #a7b2c3);
  font: 500 10px/1 inherit;
}

/* ---- 右参数栏 362 ---- */
.afo-insp { width: 362px; }
.afo-ico {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  border: 1px solid rgba(94, 234, 212, .28);
  background: rgba(94, 234, 212, .1);
  color: #5eead4;
}
.afo-ico svg { width: 16px; height: 16px; }

.afo-anchor-row { display: flex; align-items: flex-start; gap: 12px; }
.afo-anchors {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(3, 54px);
  grid-auto-rows: 40px;
  gap: 4px;
}
.afo-anchor {
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, .1);
  background: rgba(255, 255, 255, .025);
  overflow: hidden;
  cursor: pointer;
  transition: background .15s, border-color .15s;
}
.afo-anchor:hover { background: rgba(255, 255, 255, .06); }
.afo-anchor-dot { width: 7px; height: 7px; border-radius: 2px; background: var(--af-text-secondary, #a7b2c3); }
.afo-anchor img { display: block; width: 100%; height: 100%; object-fit: cover; opacity: .95; }
.afo-anchor-on {
  border-color: rgba(94, 234, 212, .55);
  background: rgba(94, 234, 212, .12);
  box-shadow: 0 0 0 1px rgba(94, 234, 212, .22), 0 0 16px rgba(94, 234, 212, .14);
}
.afo-anchor-on .afo-anchor-dot { background: #5eead4; box-shadow: 0 0 8px rgba(94, 234, 212, .7); }
.afo-anchor-desc { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.afo-anchor-t { font-size: 11px; font-weight: 600; line-height: 1.5; color: var(--af-text, #e9eef6); }

.afo-ratios { display: flex; flex-wrap: wrap; gap: 5px; }
.afo-ratio {
  height: 28px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, .13);
  background: rgba(255, 255, 255, .025);
  color: var(--af-text-secondary, #a7b2c3);
  font: 500 11px/1 inherit;
  cursor: pointer;
}
.afo-ratio:hover { background: rgba(255, 255, 255, .06); color: var(--af-text, #e9eef6); }
.afo-ratio-on { background: rgba(94, 234, 212, .12); border-color: rgba(94, 234, 212, .42); color: #5eead4; }

.afo-size { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.afo-size-n {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: .4px;
  line-height: 1.15;
  color: var(--af-text, #e9eef6);
  font-variant-numeric: tabular-nums;
}
.afo-size-x { font-size: 12px; color: var(--af-text-muted, #6c7688); }
.afo-size-from { font-size: 10.5px; color: var(--af-text-muted, #6c7688); }

.afo-textarea {
  width: 100%;
  min-height: 64px;
  max-height: 150px;
  resize: vertical;
  padding: 8px 9px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, .13);
  background: rgba(0, 0, 0, .28);
  color: var(--af-text, #e9eef6);
  font: 11.5px/1.6 inherit;
  outline: none;
}
.afo-textarea::placeholder { color: rgba(167, 178, 195, .5); }
.afo-textarea:focus { border-color: rgba(94, 234, 212, .45); box-shadow: 0 0 0 3px rgba(94, 234, 212, .08); }

.afo-hints { display: flex; flex-wrap: wrap; gap: 5px; }
.afo-hint {
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, .1);
  background: transparent;
  color: var(--af-text-secondary, #a7b2c3);
  font: 500 10.5px/1 inherit;
  cursor: pointer;
}
.afo-hint:hover { border-color: rgba(94, 234, 212, .35); color: #5eead4; }

.afo-model {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, .1);
  background: rgba(255, 255, 255, .03);
  font-size: 11.5px;
  color: var(--af-text, #e9eef6);
}
.afo-model-ico { flex: 0 0 auto; width: 14px; height: 14px; color: #8b7cf6; }
.afo-model span[data-fisherai-outpaint-model-name] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.afo-tag {
  flex: 0 0 auto;
  margin-left: auto;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid rgba(94, 234, 212, .35);
  background: rgba(94, 234, 212, .1);
  color: #5eead4;
  font-size: 9.5px;
  line-height: 18px;
}

.afo-status-row { border-bottom: 0; }
.afo-empty { font-size: 11px; line-height: 1.6; color: #f87171; }

.afo-actions { flex-direction: column; align-items: stretch; gap: 8px; }
.afo-foot-status { font-size: 10.5px; line-height: 1.5; color: var(--af-text-muted, #6c7688); }

/* 键盘焦点用青描边，别让系统那份亮蓝焦点环糊在 ✕ / 生成按钮上 */
.afw-root button:focus-visible { outline: 2px solid rgba(94, 234, 212, .5); outline-offset: 1px; }
/*
 * 整页本身是 dialog 表面：焦点落在它身上时不要画焦点环。
 * ⚠️ 选择器要写两遍 .afo-root：vendor 的通用焦点环选择器是
 * :where(button, a, input, select, textarea, [tabindex]):not([contenteditable="true"]):focus-visible
 * （特异性 0,2,0 + !important），且它的样式表在运行时**后注入** —— 同特异性会按文档顺序压掉我们，
 * 所以这里抬到 0,3,0。
 */
.afo-root.afo-root:focus,
.afo-root.afo-root:focus-visible { outline: none !important; }
.afo-create {
  width: 100%;
  height: 38px;
  border-radius: 9px;
  border: 1px solid rgba(122, 242, 223, .55);
  background: linear-gradient(180deg, #7af2df, #3fd5bd);
  color: #062b26;
  font: 600 12.5px/1 inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(63, 213, 189, .26), inset 0 1px 0 rgba(255, 255, 255, .45);
}
.afo-create:hover { filter: brightness(1.05); }
.afo-create:disabled { opacity: .45; filter: none; cursor: not-allowed; }
.afo-create svg { width: 15px; height: 15px; }
.afo-spin { animation: afo-spin 1s linear infinite; }
@keyframes afo-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .afo-spin { animation: none; }
}
`;
