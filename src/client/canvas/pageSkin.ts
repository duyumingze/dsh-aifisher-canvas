/**
 * 页面层皮肤（v1.84）：项目库 / 设置两屏的**全部**样式。
 *
 * 来源是设计稿 `E:\AllAssets\项目\画布UI改版\pages\{shell,projects,settings}.css`
 * （用户 2026-10-30 定稿的四屏之一、之二）。落地时做了三件事：
 *   1. 令牌从 `:root` 收进 `.afg-root`（画布页面上全局 :root 已经被 vendor 与 skin.ts
 *      占着，再往 :root 塞一套 `--bg/--text` 会撞 DSH 自己的变量）；
 *   2. 所有类名加前缀（`afg-` 外壳 / `afp-` 项目库 / `afs-` 设置），避免与 vendor 的
 *      `.btn/.card/.panel/.row/.tr/.tag` 那些通用名撞车；
 *   3. 设计稿里的 `assets/*.webp` 示意图片全部换成真实数据（项目封面 / 最近生成），
 *      没有图片的项目用渐变占位，不再有假图。
 *
 * 为什么独立成一个文件而不塞进 workbenchSkin.ts：那张表已经是 750 行的图片编辑工作台
 * 皮肤，两屏页面（约 1500 行）混进去以后，改一处「项目库卡片」要在图片编辑的规则里翻半天。
 *
 * ⚠️ 结构契约（回归 / 真机检查依赖）：页面根 `data-fisherai-page="projects|settings"`、
 * 关闭按钮 `data-fisherai-page-close`、项目卡 `data-fisherai-project-card` +
 * `data-project-id`、视图切换 `data-fisherai-projects-view`、设置分组
 * `data-fisherai-settings-section`、缩放 `data-fisherai-settings-scale`。类名可以改，
 * 这些属性不能少（见 scripts/test-canvas-pages.mjs）。
 */
export const PAGE_SKIN_CSS = `
/* ============================ 页面层令牌 ============================ */
/* 收在 .afg-root 里：不污染 DSH 与 vendor 的全局变量。数值与设计稿 pages/shell.css 一致。 */
.afg-root {
  --afg-bg: #0b0d11;
  --afg-bg-2: #0d1016;
  --afg-glass: rgba(21, 25, 32, .78);
  --afg-glass-2: rgba(18, 22, 29, .72);
  --afg-line: rgba(255, 255, 255, .075);
  --afg-line-2: rgba(255, 255, 255, .13);
  --afg-line-3: rgba(255, 255, 255, .055);
  --afg-text: #e9eef6;
  --afg-text-2: #a7b2c3;
  --afg-text-3: #6c7688;
  --afg-text-4: #4c5566;
  --afg-mint: #5eead4;
  --afg-mint-2: #2dd4bf;
  --afg-mint-3: #7af2df;
  --afg-mint-soft: rgba(94, 234, 212, .12);
  --afg-mint-line: rgba(94, 234, 212, .38);
  --afg-violet: #8b7cf6;
  --afg-violet-soft: rgba(139, 124, 246, .14);
  --afg-amber: #f5c26b;
  --afg-amber-soft: rgba(245, 194, 107, .13);
  --afg-danger: #f87171;
  --afg-r-panel: 16px;
  --afg-r-card: 14px;
  --afg-r-ctl: 9px;
  --afg-shadow: 0 18px 44px rgba(0, 0, 0, .46), 0 2px 6px rgba(0, 0, 0, .32);
  --afg-shadow-s: 0 8px 22px rgba(0, 0, 0, .34), 0 1px 3px rgba(0, 0, 0, .3);
  --afg-inset: inset 0 1px 0 rgba(255, 255, 255, .055);

  position: fixed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--afg-bg);
  color: var(--afg-text);
  font-family: "Segoe UI", "Microsoft YaHei UI", "PingFang SC", -apple-system, sans-serif;
  font-size: 12.5px;
  line-height: 1.45;
  letter-spacing: 0;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  user-select: none;
  z-index: 12000;
  animation: afg-fade .12s ease-out;
}
@keyframes afg-fade { from { opacity: 0; } to { opacity: 1; } }
.afg-root.afg-root:focus, .afg-root.afg-root:focus-visible { outline: none !important; }
.afg-root *, .afg-root *::before, .afg-root *::after { box-sizing: border-box; }
.afg-root button { font: inherit; color: inherit; }
.afg-root button:focus-visible { outline: 2px solid rgba(94, 234, 212, .5); outline-offset: 1px; }
.afg-root input, .afg-root textarea { font: inherit; }

/* 页面底：两团极淡的青/紫径向光 + 120px 网格（遮罩渐隐） */
.afg-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(760px 520px at 8% -10%, rgba(94, 234, 212, .075), transparent 60%),
    radial-gradient(820px 560px at 96% 4%, rgba(139, 124, 246, .08), transparent 62%),
    radial-gradient(1100px 700px at 50% 122%, rgba(255, 255, 255, .02), transparent 70%);
}
.afg-bg::after {
  content: "";
  position: absolute;
  inset: 0;
  opacity: .5;
  background-image:
    linear-gradient(to right, rgba(255, 255, 255, .018) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, .018) 1px, transparent 1px);
  background-size: 120px 120px;
  -webkit-mask-image: radial-gradient(120% 90% at 50% 0%, #000 20%, transparent 78%);
  mask-image: radial-gradient(120% 90% at 50% 0%, #000 20%, transparent 78%);
}

/* 页面开着时：藏掉按视口贴边的画布 chrome（否则从页面下缘戳出来，见 CanvasPageShell 注释） */
html.afg-page-open [data-af-zoom-bar],
html.afg-page-open [data-af-help-btn],
html.afg-page-open .af-uity,
html.afg-page-open [data-fisherai-minimap],
html.afg-page-open [data-fisherai-task-queue],
html.afg-page-open [data-fisherai-copilot-pill],
html.afg-page-open [data-fisherai-storyboard-toggle] {
  display: none !important;
}

/**
 * 页面开着时把 vendor 的旧项目看板藏起来（v1.85）。
 *
 * 用户 2026-10-31：「移除旧版设置与画布项目管理」。看板是 vendor 在「没有打开项目」时
 * 渲染的那一整屏（v1.80、显示全部 / 设置 / 导入项目 / 新建项目），我们的项目库页面严丝合缝
 * 盖在它上面。藏掉不是为了好看 —— 是防止页面量出 0×0 的那一帧（挂载第一帧）把旧界面
 * 露出来闪一下。看板本身仍留在底下当「没有项目」的占位，不受影响。
 */
html.afg-page-open [data-fisherai-project-dashboard="true"] {
  visibility: hidden;
}

/* ============================ 顶栏 54 ============================ */
.afg-top {
  position: relative;
  z-index: 6;
  flex: 0 0 auto;
  height: 54px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px 0 12px;
  background: linear-gradient(180deg, rgba(14, 17, 23, .96), rgba(12, 15, 20, .8));
  border-bottom: 1px solid var(--afg-line);
  backdrop-filter: blur(20px) saturate(1.1);
}
.afg-top::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(94, 234, 212, .3) 32%, rgba(139, 124, 246, .26) 68%, transparent);
  opacity: .75;
}
.afg-crumbs { display: flex; align-items: center; gap: 9px; min-width: 0; }
.afg-back {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--afg-text-2);
  display: grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
}
.afg-back:hover { background: rgba(255, 255, 255, .05); color: var(--afg-text); }
.afg-back svg { width: 16px; height: 16px; }
.afg-crumb-sep { width: 1px; height: 16px; background: var(--afg-line-2); }
.afg-crumb-root { color: var(--afg-text-3); font-size: 12px; }
.afg-crumb-title { font-size: 13.5px; font-weight: 600; letter-spacing: .2px; white-space: nowrap; }
.afg-crumb-count {
  font-size: 10.5px;
  color: var(--afg-text-3);
  border: 1px solid var(--afg-line-2);
  border-radius: 999px;
  padding: 1px 7px;
  font-variant-numeric: tabular-nums;
}
.afg-top-center { position: absolute; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; }
.afg-top-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }

/* ============================ 控件 ============================ */
.afg-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: var(--afg-r-ctl);
  border: 1px solid var(--afg-line-2);
  background: rgba(255, 255, 255, .04);
  color: var(--afg-text);
  font: 600 12px/1 inherit;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  white-space: nowrap;
  padding-top: 0;
  padding-bottom: 0;
}
.afg-btn:hover { background: rgba(255, 255, 255, .075); }
.afg-btn svg { width: 14px; height: 14px; flex: 0 0 auto; }
.afg-btn.afg-sm { height: 26px; padding: 0 9px; font-size: 11.5px; border-radius: 8px; }
.afg-btn.afg-ghost { background: transparent; border-color: transparent; color: var(--afg-text-2); }
.afg-btn.afg-ghost:hover { background: rgba(255, 255, 255, .05); color: var(--afg-text); }
.afg-btn.afg-primary {
  background: linear-gradient(180deg, #7af2df, #3fd5bd);
  color: #062b26;
  border-color: rgba(122, 242, 223, .55);
  box-shadow: 0 6px 18px rgba(63, 213, 189, .28), inset 0 1px 0 rgba(255, 255, 255, .45);
}
.afg-btn.afg-primary:hover { filter: brightness(1.05); }
.afg-btn.afg-primary svg { color: #062b26; }
.afg-btn:disabled { opacity: .42; cursor: not-allowed; filter: none; }

.afg-iconbtn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--afg-text-2);
  display: grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
}
.afg-iconbtn:hover { background: rgba(255, 255, 255, .055); color: var(--afg-text); }
.afg-iconbtn svg { width: 16px; height: 16px; }
.afg-iconbtn.afg-on { background: var(--afg-mint-soft); color: var(--afg-mint); border-color: var(--afg-mint-line); }

.afg-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 10px;
  background: rgba(0, 0, 0, .28);
  border: 1px solid var(--afg-line-2);
  gap: 2px;
}
.afg-seg > button {
  height: 26px;
  min-width: 30px;
  padding: 0 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--afg-text-3);
  font: 600 11.5px/1 inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
}
.afg-seg > button:hover { color: var(--afg-text-2); }
.afg-seg > button.afg-on {
  background: rgba(255, 255, 255, .075);
  color: var(--afg-text);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .08), 0 1px 3px rgba(0, 0, 0, .3);
}
.afg-seg > button svg { width: 14px; height: 14px; }

.afg-search {
  display: flex;
  align-items: center;
  height: 32px;
  width: 292px;
  border-radius: 9px;
  border: 1px solid var(--afg-line-2);
  background: rgba(0, 0, 0, .25);
  padding: 0 10px;
  gap: 8px;
  color: var(--afg-text-3);
}
.afg-search svg { width: 14px; height: 14px; flex: 0 0 auto; }
.afg-search input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: 0;
  color: var(--afg-text);
  font: 500 12px/1 inherit;
}
.afg-search input::placeholder { color: var(--afg-text-4); }

.afg-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 5px;
  border: 1px solid var(--afg-line-2);
  border-bottom-color: rgba(255, 255, 255, .18);
  background: rgba(255, 255, 255, .04);
  color: var(--afg-text-3);
  font: 600 10px/1 inherit;
  font-variant-numeric: tabular-nums;
}

.afg-chip {
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--afg-line-2);
  background: rgba(255, 255, 255, .03);
  color: var(--afg-text-2);
  font: 500 11.5px/1 inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.afg-chip:hover { background: rgba(255, 255, 255, .06); color: var(--afg-text); }
.afg-chip.afg-on { background: var(--afg-mint-soft); border-color: var(--afg-mint-line); color: var(--afg-mint); }
.afg-chip .afg-num { color: var(--afg-text-3); font-variant-numeric: tabular-nums; }
.afg-chip.afg-on .afg-num { color: rgba(94, 234, 212, .62); }

.afg-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 21px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 10.5px;
  font-weight: 600;
  background: rgba(255, 255, 255, .05);
  border: 1px solid var(--afg-line);
  color: var(--afg-text-2);
  white-space: nowrap;
}
.afg-tag.afg-mint { background: var(--afg-mint-soft); border-color: rgba(94, 234, 212, .3); color: var(--afg-mint); }
.afg-tag.afg-violet { background: var(--afg-violet-soft); border-color: rgba(139, 124, 246, .3); color: #c3b9ff; }
.afg-tag.afg-amber { background: var(--afg-amber-soft); border-color: rgba(245, 194, 107, .28); color: var(--afg-amber); }

.afg-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--afg-mint);
  box-shadow: 0 0 0 3px rgba(94, 234, 212, .12);
  flex: 0 0 auto;
}
.afg-dot.afg-g { background: #4ade80; box-shadow: 0 0 0 3px rgba(74, 222, 128, .12); }
.afg-dot.afg-a { background: var(--afg-amber); box-shadow: 0 0 0 3px rgba(245, 194, 107, .12); }
.afg-dot.afg-v { background: var(--afg-violet); box-shadow: 0 0 0 3px rgba(139, 124, 246, .12); }

.afg-switch {
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .1);
  border: 1px solid var(--afg-line-2);
  position: relative;
  flex: 0 0 auto;
  cursor: pointer;
  padding: 0;
}
.afg-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #9aa6b6;
  transition: .18s;
}
.afg-switch.afg-on { background: rgba(94, 234, 212, .22); border-color: var(--afg-mint-line); }
.afg-switch.afg-on::after { left: 18px; background: var(--afg-mint-3); box-shadow: 0 0 8px rgba(94, 234, 212, .6); }

.afg-slider { position: relative; height: 20px; display: flex; align-items: center; width: 100%; }
.afg-slider .afg-track { position: relative; height: 3px; width: 100%; border-radius: 999px; background: rgba(255, 255, 255, .1); }
.afg-slider .afg-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(94, 234, 212, .55), var(--afg-mint));
}
.afg-slider .afg-knob {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  margin-left: -6.5px;
  border-radius: 50%;
  transform: translateY(-50%);
  background: #eafffb;
  border: 2px solid var(--afg-mint);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .5), 0 0 12px rgba(94, 234, 212, .45);
}

.afg-input {
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--afg-line-2);
  background: rgba(0, 0, 0, .28);
  color: var(--afg-text);
  font: 500 11.5px/1 inherit;
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.afg-input:focus { outline: none; border-color: var(--afg-mint-line); }
.afg-input.afg-mono { font-variant-numeric: tabular-nums; }

.afg-sect-head { display: flex; align-items: baseline; gap: 9px; }
.afg-sect-head h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .4px;
  color: var(--afg-text);
  text-transform: uppercase;
}
.afg-sect-head .afg-hint { font-size: 11px; color: var(--afg-text-3); }

.afg-scroll { overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .14) transparent; }
.afg-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.afg-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, .12);
  border-radius: 99px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

.afg-mono { font-variant-numeric: tabular-nums; }
.afg-dim { color: var(--afg-text-3); }
.afg-dim2 { color: var(--afg-text-2); }
.afg-mint { color: var(--afg-mint); }
.afg-violet { color: var(--afg-violet); }
.afg-amber { color: var(--afg-amber); }
.afg-w600 { font-weight: 600; }
.afg-f11 { font-size: 11px; }
.afg-f12 { font-size: 12px; }
.afg-center { display: flex; align-items: center; }
.afg-gap4 { gap: 4px; }
.afg-gap6 { gap: 6px; }
.afg-gap8 { gap: 8px; }
.afg-grow { flex: 1 1 auto; min-width: 0; }
.afg-ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afg-vdiv { width: 1px; background: var(--afg-line-2); align-self: stretch; }
.afg-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  color: var(--afg-text-3);
  font-size: 12px;
  text-align: center;
}
.afg-alert { font-size: 11px; color: var(--afg-danger); }

/* ============================ 项目库 ============================ */
.afp-body { position: relative; z-index: 1; flex: 1 1 auto; min-height: 0; display: flex; }

.afp-side {
  width: 210px;
  flex: 0 0 auto;
  padding: 14px 10px 12px;
  border-right: 1px solid var(--afg-line);
  background: linear-gradient(180deg, rgba(13, 16, 22, .52), rgba(11, 13, 17, .3));
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.afp-side-group { display: flex; flex-direction: column; gap: 2px; }
.afp-side-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .9px;
  color: var(--afg-text-4);
  text-transform: uppercase;
  padding: 0 10px 7px;
}
.afp-side-item {
  height: 32px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--afg-text-2);
  font: 500 12px/1 inherit;
  cursor: pointer;
  position: relative;
  text-align: left;
}
.afp-side-item svg { width: 14px; height: 14px; flex: 0 0 auto; }
.afp-side-item .afp-n { margin-left: auto; font-size: 10.5px; color: var(--afg-text-4); font-variant-numeric: tabular-nums; }
.afp-side-item:hover { background: rgba(255, 255, 255, .045); color: var(--afg-text); }
.afp-side-item.afg-on { background: rgba(255, 255, 255, .065); color: var(--afg-text); }
.afp-side-item.afg-on::before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--afg-mint);
  box-shadow: 0 0 10px rgba(94, 234, 212, .6);
}
.afp-side-item.afg-on svg { color: var(--afg-mint); }
.afp-side-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 6px; }
.afp-side-chips .afg-chip { height: 23px; padding: 0 8px; font-size: 11px; }
.afp-side-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 13px 6px 0;
  border-top: 1px solid var(--afg-line);
}
.afp-storage-top { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; }
.afp-storage-bar { height: 5px; border-radius: 99px; background: rgba(255, 255, 255, .07); margin: 7px 0 6px; overflow: hidden; }
.afp-storage-bar i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, #3fd5bd, #7af2df);
  box-shadow: 0 0 10px rgba(94, 234, 212, .45);
}
.afp-storage-sub { line-height: 1.5; }
.afp-side-foot .afg-btn { width: 100%; justify-content: flex-start; }

.afp-main { flex: 1 1 auto; min-width: 0; padding: 20px 24px 26px; container-type: inline-size; }

/* 继续编辑 hero */
.afp-hero {
  position: relative;
  display: grid;
  grid-template-columns: 344px minmax(0, 1fr) 300px;
  height: 244px;
  border-radius: 18px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .1);
  background: linear-gradient(120deg, rgba(38, 44, 56, .78), rgba(17, 21, 27, .94) 58%);
  box-shadow: var(--afg-shadow), var(--afg-inset);
}

/**
 * 窄画布下的 hero（v1.85）。
 *
 * 真机踩到的：DSH 右侧会话栏展开时画布只剩 ~950px，主区 ~720px —— 344 + 300 的左右两块
 * 先占掉 644，中间只剩几十像素，标题和「运行中 / 1 小时前」叠成一团（截图见
 * .dsh-tmp/shots/v185-01-open-canvas.png 的旧版）。画布宽度跟着会话栏/窗口变，媒体查询
 * 量的是窗口而不是画布，所以用容器查询（.afp-main = 容器）。
 */
@container (max-width: 1040px) {
  .afp-hero { grid-template-columns: 300px minmax(0, 1fr); height: auto; }
  .afp-hero-cover { min-height: 236px; }
  .afp-hero-info { min-height: 236px; padding: 18px 20px 16px; }
  /* 带 .afp-hero 前缀：基础规则写在下面（文件后半段），同权重会被它压掉 */
  .afp-hero .afp-hero-recent {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: 1px solid var(--afg-line);
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px 16px;
    padding: 12px 18px;
  }
  .afp-hero .afp-hero-recent .afp-thumbs { grid-template-columns: repeat(4, 52px); }
  .afp-hero .afp-hero-recent .afp-hr-sep { display: none; }
  .afp-hero .afp-hero-recent .afp-tasks { flex: 1 1 200px; min-width: 0; }
}
@container (max-width: 620px) {
  .afp-main { padding: 14px 14px 20px; }
  .afp-hero { grid-template-columns: minmax(0, 1fr); }
  .afp-hero-cover { min-height: 176px; }
  .afp-hero-recent { display: none; }
  .afp-hero-info h1 { font-size: 19px; }
}
.afp-hero::before {
  content: "";
  position: absolute;
  width: 560px;
  height: 340px;
  left: -140px;
  top: -170px;
  background: radial-gradient(closest-side, rgba(94, 234, 212, .16), transparent 70%);
  pointer-events: none;
}
.afp-hero-cover { position: relative; overflow: hidden; background: #14181f; }
.afp-hero-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.afp-hero-cover::after {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, rgba(17, 21, 27, 0) 52%, rgba(23, 27, 34, .98) 100%),
    linear-gradient(180deg, rgba(11, 13, 17, .22), transparent 40%);
}
.afp-hero-badge {
  position: absolute;
  left: 12px;
  top: 12px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: rgba(9, 12, 16, .62);
  border: 1px solid rgba(255, 255, 255, .14);
  backdrop-filter: blur(10px);
  font: 600 11px/1 inherit;
  color: var(--afg-text);
}
.afp-hero-info { min-width: 0; padding: 20px 24px 18px; display: flex; flex-direction: column; gap: 7px; }
.afp-hero-eyebrow { display: flex; align-items: center; gap: 8px; }
.afp-hero-info h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: .3px; line-height: 1.25; }
.afp-hero-sub { margin: 0; font-size: 12px; color: var(--afg-text-2); }
.afp-hero-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.afp-hero-meta { margin-top: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.afp-hero-recent {
  border-left: 1px solid var(--afg-line);
  background: rgba(0, 0, 0, .16);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
}
.afp-thumbs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.afp-thumb {
  position: relative;
  aspect-ratio: 1 / 1;
  border-radius: 7px;
  overflow: hidden;
  border: 1px solid var(--afg-line);
  background: #12161d;
}
.afp-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.afp-thumb.afp-more {
  display: grid;
  place-items: center;
  color: var(--afg-text-3);
  font-size: 11px;
  background: rgba(255, 255, 255, .035);
}
.afp-hr-sep { height: 1px; background: var(--afg-line); margin: 4px 0 2px; }
.afp-tasks { display: flex; flex-direction: column; gap: 8px; }
.afp-trow { display: flex; align-items: center; gap: 8px; height: 20px; }
.afp-bar { flex: 1; height: 3px; border-radius: 99px; background: rgba(255, 255, 255, .08); overflow: hidden; }
.afp-bar i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--afg-violet), #b6a9ff); }

.afp-list-head { display: flex; align-items: center; justify-content: space-between; margin: 24px 2px 14px; }

/* 卡片墙 */
.afp-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
.afp-card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--afg-line);
  background: linear-gradient(180deg, rgba(30, 35, 45, .86), rgba(21, 25, 32, .94));
  box-shadow: var(--afg-inset), 0 10px 26px rgba(0, 0, 0, .22);
  text-align: left;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: transform .18s, border-color .18s, box-shadow .18s;
}
.afp-card-cover { position: relative; overflow: hidden; background: #14181f; height: 186px; flex: 0 0 auto; }
.afp-card-cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .4s ease; }
.afp-card-cover::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(7, 9, 12, 0) 35%, rgba(7, 9, 12, .72) 100%);
  pointer-events: none;
}
.afp-cover-fallback {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 100% at 20% 0%, rgba(94, 234, 212, .16), transparent 60%),
    radial-gradient(120% 100% at 100% 100%, rgba(139, 124, 246, .18), transparent 62%),
    linear-gradient(140deg, #171c24, #10141a);
}
.afp-card:hover { transform: translateY(-2px); border-color: rgba(255, 255, 255, .18); box-shadow: var(--afg-inset), 0 20px 36px rgba(0, 0, 0, .42); }
.afp-card:hover .afp-card-cover img { transform: scale(1.035); }
.afp-card.afp-archived { opacity: .6; }
.afp-card.afp-archived:hover { opacity: .85; }
.afp-card.afp-selected { border-color: var(--afg-mint-line); box-shadow: var(--afg-inset), 0 0 0 1px rgba(94, 234, 212, .22), 0 16px 32px rgba(0, 0, 0, .4); }
.afp-badges { position: absolute; top: 9px; left: 9px; z-index: 2; display: flex; gap: 6px; }
.afp-badges .afg-tag { background: rgba(9, 12, 16, .6); backdrop-filter: blur(8px); }
.afp-card-meta {
  padding: 10px 13px 12px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  row-gap: 3px;
  flex: 1;
  align-content: start;
}
.afp-card-name {
  grid-column: 1 / 3;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 1px;
}
.afp-card-sub { font-size: 11px; color: var(--afg-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.afp-card-time { font-size: 10.5px; color: var(--afg-text-4); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.afp-hover-actions {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  gap: 6px;
  padding: 8px;
  background: linear-gradient(180deg, transparent, rgba(7, 9, 12, .88));
  opacity: 0;
  transform: translateY(6px);
  transition: opacity .18s, transform .18s;
}
.afp-card:hover .afp-hover-actions, .afp-card.afp-selected .afp-hover-actions { opacity: 1; transform: none; }
.afp-ha {
  height: 26px;
  min-width: 26px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid var(--afg-line-2);
  background: rgba(20, 24, 31, .88);
  color: var(--afg-text-2);
  font: 600 11px/1 inherit;
  display: grid;
  place-items: center;
  backdrop-filter: blur(10px);
  cursor: pointer;
}
.afp-ha svg { width: 13px; height: 13px; }
.afp-ha.afp-primary {
  flex: 1;
  background: linear-gradient(180deg, #7af2df, #3fd5bd);
  border-color: transparent;
  color: #062b26;
}
.afp-card.afp-new {
  border-style: dashed;
  border-color: rgba(255, 255, 255, .14);
  background: rgba(255, 255, 255, .016);
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 254px;
  box-shadow: none;
}
.afp-card.afp-new:hover { border-color: var(--afg-mint-line); background: rgba(94, 234, 212, .035); }
.afp-new-plus {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--afg-line-2);
  display: grid;
  place-items: center;
  color: var(--afg-text-2);
  margin-bottom: 6px;
}
.afp-new-plus svg { width: 16px; height: 16px; }
.afp-new-t { font-size: 12.5px; font-weight: 600; }
.afp-new-s { font-size: 10.5px; }
.afp-foot { text-align: center; padding: 18px 0 6px; font-size: 11px; color: var(--afg-text-3); }

/* 列表视图 */
.afp-list-main { flex: 1 1 auto; min-width: 0; padding: 18px 18px 0 24px; display: flex; flex-direction: column; }
.afp-list-head2 { display: flex; align-items: center; justify-content: space-between; margin: 0 4px 12px; height: 30px; }
.afp-table { border-top: 1px solid var(--afg-line); }
.afp-tr {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px 116px 96px 74px 30px;
  align-items: center;
  gap: 12px;
  height: 63px;
  padding: 0 10px;
  border-bottom: 1px solid var(--afg-line-3);
  cursor: pointer;
  position: relative;
  border-radius: 8px;
}
.afp-tr:hover { background: rgba(255, 255, 255, .035); }
.afp-tr.afg-on { background: rgba(94, 234, 212, .055); }
.afp-tr.afg-on::before {
  content: "";
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 2px;
  border-radius: 2px;
  background: var(--afg-mint);
  box-shadow: 0 0 10px rgba(94, 234, 212, .55);
}
.afp-tr.afp-th {
  height: 34px;
  border-bottom: 1px solid var(--afg-line);
  cursor: default;
  color: var(--afg-text-4);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .5px;
  text-transform: uppercase;
  background: transparent;
}
.afp-tr.afp-th:hover { background: transparent; }
.afp-tgroup {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  color: var(--afg-text-3);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .6px;
  text-transform: uppercase;
}
.afp-tgroup::after { content: ""; flex: 1; height: 1px; background: var(--afg-line-3); }
.afp-pcell { display: flex; align-items: center; gap: 11px; min-width: 0; }
.afp-pthumb {
  position: relative;
  width: 42px;
  height: 42px;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--afg-line);
  flex: 0 0 auto;
  background: #12161d;
}
.afp-pthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.afp-pcell .afp-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.afp-pcell .afp-t { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.afp-pcell .afp-s { font-size: 10.5px; color: var(--afg-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.afp-cell-num { font-size: 11.5px; color: var(--afg-text-2); font-variant-numeric: tabular-nums; }
.afp-cell-dim { font-size: 11px; color: var(--afg-text-3); font-variant-numeric: tabular-nums; }
.afp-row-actions { display: flex; justify-content: flex-end; gap: 2px; opacity: 0; transition: opacity .15s; }
.afp-tr:hover .afp-row-actions, .afp-tr.afg-on .afp-row-actions { opacity: 1; }
.afp-row-actions .afg-iconbtn { width: 26px; height: 26px; }

/* 右侧详情 */
.afp-drawer {
  width: 352px;
  flex: 0 0 auto;
  border-left: 1px solid var(--afg-line);
  background: linear-gradient(180deg, rgba(17, 21, 27, .86), rgba(13, 16, 22, .78));
  display: flex;
  flex-direction: column;
  padding: 14px 16px 16px;
  gap: 14px;
  overflow: auto;
}
.afp-drawer > * { flex: 0 0 auto; }
.afp-drawer-head { display: flex; align-items: center; justify-content: space-between; }
.afp-drawer-cover {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--afg-line-2);
  aspect-ratio: 16 / 10;
  position: relative;
  box-shadow: var(--afg-shadow-s);
  background: #12161d;
}
.afp-drawer-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.afp-drawer-cover .afg-tag { position: absolute; left: 9px; top: 9px; background: rgba(9, 12, 16, .62); backdrop-filter: blur(8px); }
.afp-drawer-title { display: flex; flex-direction: column; gap: 4px; }
.afp-drawer-title h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: .2px; }
.afp-drawer-title .afp-sub { font-size: 11px; color: var(--afg-text-3); }
.afp-metagrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--afg-line);
  border: 1px solid var(--afg-line);
}
.afp-metacell { background: rgba(15, 18, 24, .86); padding: 9px 11px; display: flex; flex-direction: column; gap: 2px; }
.afp-metacell .afp-k { font-size: 10px; color: var(--afg-text-4); letter-spacing: .3px; }
.afp-metacell .afp-v { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.afp-drawer-sect { display: flex; flex-direction: column; gap: 8px; }
.afp-drawer-thumbs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.afp-note {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--afg-text-2);
  background: rgba(0, 0, 0, .22);
  border: 1px solid var(--afg-line);
  border-left: 2px solid rgba(94, 234, 212, .45);
  border-radius: 4px 9px 9px 4px;
  padding: 8px 11px;
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 44px;
}
.afp-note-edit {
  width: 100%;
  min-height: 76px;
  resize: vertical;
  border-radius: 9px;
  border: 1px solid var(--afg-line-2);
  background: rgba(0, 0, 0, .3);
  color: var(--afg-text);
  font: 400 11.5px/1.7 inherit;
  padding: 8px 10px;
}
.afp-note-edit:focus { outline: none; border-color: var(--afg-mint-line); }
.afp-drawer-actions { margin-top: auto; display: flex; flex-direction: column; gap: 7px; }
.afp-drawer-actions .afg-btn { width: 100%; justify-content: center; }
.afp-drawer-actions .afp-row { display: flex; gap: 7px; }
.afp-drawer-actions .afp-row .afg-btn { flex: 1; }
.afp-drawer-hint { font-size: 10.5px; color: var(--afg-text-4); text-align: center; padding-top: 2px; }
.afp-rename {
  height: 30px;
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--afg-mint-line);
  background: rgba(0, 0, 0, .35);
  color: var(--afg-text);
  font: 600 12.5px/1 inherit;
  padding: 0 9px;
}

/* ============================ 设置 ============================ */
.afs-body { position: relative; z-index: 1; flex: 1 1 auto; min-height: 0; display: flex; }

.afs-nav {
  width: 214px;
  flex: 0 0 auto;
  border-right: 1px solid var(--afg-line);
  background: linear-gradient(180deg, rgba(13, 16, 22, .55), rgba(11, 13, 17, .3));
  padding: 15px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.afs-nav .afg-search { width: 100%; height: 30px; margin-bottom: 10px; }
.afs-nav .afg-search input { font-size: 11.5px; }
.afs-nav-group { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
.afs-nav-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .9px;
  color: var(--afg-text-4);
  text-transform: uppercase;
  padding: 0 10px 6px;
}
.afs-nav-item {
  height: 33px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--afg-text-2);
  font: 500 12px/1 inherit;
  cursor: pointer;
  position: relative;
  text-align: left;
}
.afs-nav-item svg { width: 14px; height: 14px; flex: 0 0 auto; }
.afs-nav-item:hover { background: rgba(255, 255, 255, .045); color: var(--afg-text); }
.afs-nav-item.afg-on { background: rgba(255, 255, 255, .065); color: var(--afg-text); }
.afs-nav-item.afg-on::before {
  content: "";
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 2px;
  border-radius: 2px;
  background: var(--afg-mint);
  box-shadow: 0 0 10px rgba(94, 234, 212, .6);
}
.afs-nav-item.afg-on svg { color: var(--afg-mint); }
.afs-nav-foot {
  margin-top: auto;
  border-top: 1px solid var(--afg-line);
  padding: 10px 6px 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.afs-nav-foot .afs-ver { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--afg-text-3); }

.afs-main { flex: 1 1 auto; min-width: 0; padding: 14px 40px 18px; display: flex; flex-direction: column; }
.afs-main > * { width: 100%; max-width: 1180px; align-self: flex-start; }
.afs-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.afs-head h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: .3px; }
.afs-head p { margin: 5px 0 0; font-size: 11.5px; color: var(--afg-text-3); max-width: 520px; line-height: 1.6; }
.afs-head-actions { display: flex; align-items: center; gap: 8px; padding-top: 2px; }
.afs-saved { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--afg-text-3); }
.afs-saved .afg-dot { width: 5px; height: 5px; box-shadow: 0 0 0 2px rgba(94, 234, 212, .1); }
.afs-saved.afs-dirty { color: var(--afg-amber); }

.afs-sect { margin-top: 12px; }
.afs-sect .afg-sect-head { margin-bottom: 6px; padding-left: 2px; display: flex; align-items: baseline; gap: 10px; }
.afs-sect .afg-sect-head .afs-idx { font-size: 10px; color: var(--afg-text-4); letter-spacing: 1px; }
.afs-sect .afg-sect-head h2 { font-size: 11px; letter-spacing: 1.2px; color: var(--afg-text-2); }
.afs-sect .afg-sect-head .afg-hint { font-size: 10.5px; color: var(--afg-text-4); margin-left: auto; }
.afs-rows {
  border: 1px solid var(--afg-line);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(255, 255, 255, .022), rgba(255, 255, 255, .008));
  overflow: hidden;
}
.afs-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 9px 16px;
  min-height: 52px;
  border-bottom: 1px solid var(--afg-line-3);
  position: relative;
}
.afs-row:last-child { border-bottom: 0; }
.afs-row:hover { background: rgba(255, 255, 255, .018); }
.afs-row-main { min-width: 0; }
.afs-row-t { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.afs-row-h { font-size: 11px; color: var(--afg-text-3); margin-top: 3px; line-height: 1.5; }
.afs-row-ctl { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; }

/* ---- 旧版设置对话框搬进来的面板（v1.85）：分组壳 + 宿主 + 个人资料 ---- */
.afs-host-block { border-top: 1px solid var(--afg-line-3); padding: 12px 16px 6px; }
.afs-host-block:first-child { border-top: 0; }
.afs-host-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 10px; }
.afs-host { min-width: 0; }
.afs-host:empty { display: none; }
.afs-host > section { padding: 2px 0 12px; }
.afs-host h3 { margin: 0; line-height: 1.35; }
.afs-profile { display: flex; gap: 14px; align-items: center; padding: 2px 0 10px; }
.afs-profile-avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid var(--afg-line-2);
  background: rgba(94, 234, 212, .14);
  color: var(--afg-mint);
  font: 700 17px/1 inherit;
}
.afs-profile-avatar img { width: 100%; height: 100%; object-fit: cover; }
.afs-profile-fields { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 8px; }
.afs-profile-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.afs-input {
  height: 32px;
  max-width: 320px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--afg-line-2);
  background: rgba(255, 255, 255, .02);
  color: var(--afg-text);
  font: 500 12.5px/1 inherit;
  outline: none;
}
.afs-input:focus { border-color: var(--afg-mint-line); box-shadow: 0 0 0 2px rgba(94, 234, 212, .12); }

.afs-theme-opt {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 11px 0 9px;
  border-radius: 9px;
  border: 1px solid var(--afg-line-2);
  background: rgba(255, 255, 255, .025);
  color: var(--afg-text-2);
  font: 600 11.5px/1 inherit;
  cursor: pointer;
}
.afs-theme-opt:hover { background: rgba(255, 255, 255, .055); color: var(--afg-text); }
.afs-theme-opt.afg-on { border-color: var(--afg-mint-line); background: var(--afg-mint-soft); color: var(--afg-mint); }
.afs-theme-opt:disabled { opacity: .45; cursor: not-allowed; }
.afs-sw { display: inline-flex; gap: 2px; }
.afs-sw i { width: 5px; height: 13px; border-radius: 1.5px; display: block; }
.afs-draft { font-size: 9px; font-weight: 600; color: var(--afg-text-3); border: 1px solid var(--afg-line-2); border-radius: 3px; padding: 1px 4px; }

.afs-scale { display: flex; align-items: center; gap: 10px; width: 356px; }
.afs-scale .afg-slider { flex: 1; }
.afs-scale-val { width: 46px; text-align: right; font-size: 12.5px; font-weight: 600; color: var(--afg-mint); font-variant-numeric: tabular-nums; }
.afs-scale-wrap { flex: 1; display: flex; flex-direction: column; gap: 7px; }
.afs-scale-wrap .afs-ticks { position: relative; height: 12px; }
.afs-scale-wrap .afs-ticks span {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  font-size: 9.5px;
  color: var(--afg-text-4);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.afs-scale-wrap .afs-ticks span:first-child { transform: none; }
.afs-scale-wrap .afs-ticks span:last-child { transform: translateX(-100%); }
.afs-scale-wrap .afs-ticks span.afg-on { color: var(--afg-mint); }

.afs-opts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; max-width: 430px; }
.afs-opt {
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--afg-line-2);
  background: rgba(255, 255, 255, .025);
  color: var(--afg-text-2);
  font: 500 11.5px/1 inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.afs-opt:hover { background: rgba(255, 255, 255, .055); color: var(--afg-text); }
.afs-opt.afg-on { background: var(--afg-mint-soft); border-color: var(--afg-mint-line); color: var(--afg-mint); }
.afs-opt:disabled { opacity: .45; cursor: not-allowed; }
.afs-opt.afg-off.afg-on { background: rgba(255, 255, 255, .06); border-color: var(--afg-line-2); color: var(--afg-text); }
.afs-rec { font-size: 9px; padding: 1px 4px; border-radius: 3px; background: rgba(94, 234, 212, .16); color: var(--afg-mint); }

.afs-bgthumb {
  width: 74px;
  height: 42px;
  border-radius: 7px;
  overflow: hidden;
  border: 1px solid var(--afg-line-2);
  background: #12161d;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
.afs-bgthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.afs-bgthumb svg { width: 16px; height: 16px; color: var(--afg-text-4); }
.afs-path {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  max-width: 320px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px dashed var(--afg-line-2);
  background: rgba(0, 0, 0, .2);
  color: var(--afg-text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.afs-path svg { color: var(--afg-text-4); flex: 0 0 auto; width: 13px; height: 13px; }

.afs-stepper {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--afg-line-2);
  border-radius: 9px;
  overflow: hidden;
  height: 30px;
  background: rgba(0, 0, 0, .22);
}
.afs-stepper button {
  width: 28px;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--afg-text-2);
  display: grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
}
.afs-stepper button:hover { background: rgba(255, 255, 255, .06); color: var(--afg-text); }
.afs-stepper svg { width: 13px; height: 13px; }
.afs-stepper .afs-v { width: 34px; text-align: center; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* 外观分组：左选项 + 右实时预览（设计稿 B 的挑皮肤视图） */
.afs-theme-body { display: grid; grid-template-columns: 252px minmax(0, 1fr); gap: 16px; padding: 12px 16px 14px; }
.afs-theme-list { display: flex; flex-direction: column; gap: 6px; }
.afs-topt {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 40px;
  padding: 0 11px;
  border-radius: 9px;
  border: 1px solid var(--afg-line-2);
  background: rgba(255, 255, 255, .022);
  color: var(--afg-text-2);
  font: 600 11.5px/1 inherit;
  cursor: pointer;
  text-align: left;
}
.afs-topt:hover { background: rgba(255, 255, 255, .05); color: var(--afg-text); }
.afs-topt .afs-tt { flex: 1; display: flex; align-items: center; gap: 6px; }
.afs-topt .afs-tt i {
  font-style: normal;
  font-size: 9px;
  font-weight: 600;
  color: var(--afg-mint);
  background: rgba(94, 234, 212, .14);
  border-radius: 3px;
  padding: 2px 4px;
}
.afs-topt .afs-radio { width: 13px; height: 13px; border-radius: 50%; border: 1px solid var(--afg-line-2); flex: 0 0 auto; }
.afs-topt.afg-on { border-color: var(--afg-mint-line); background: var(--afg-mint-soft); color: var(--afg-text); }
.afs-topt.afg-on .afs-radio { border-color: var(--afg-mint); background: var(--afg-mint); box-shadow: inset 0 0 0 2.5px #0b0d11; }
.afs-topt:disabled { opacity: .5; cursor: not-allowed; }

.afs-tcanvas {
  position: relative;
  border-radius: 10px;
  border: 1px solid var(--afg-line-2);
  background: #0b0d11;
  overflow: hidden;
  min-height: 186px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .04);
}
.afs-gridlayer {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(rgba(255, 255, 255, .1) 1px, transparent 1.2px);
  background-size: 18px 18px;
}
.afs-tn {
  position: absolute;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, .1);
  background: linear-gradient(180deg, rgba(34, 39, 49, .96), rgba(24, 28, 35, .98));
  box-shadow: 0 10px 24px rgba(0, 0, 0, .45), inset 0 1px 0 rgba(255, 255, 255, .05);
  overflow: hidden;
}
.afs-tn-head { height: 19px; display: flex; align-items: center; gap: 5px; padding: 0 7px; border-bottom: 1px solid rgba(255, 255, 255, .07); }
.afs-tn-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--afg-mint); flex: 0 0 auto; }
.afs-tn-t { font-size: 8px; color: var(--afg-text-2); letter-spacing: .2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.afs-tn-body { background: linear-gradient(120deg, #17302d, #251c34); }
.afs-tn-port {
  position: absolute;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--afg-mint);
  box-shadow: 0 0 0 2px #0b0d11, 0 0 8px rgba(94, 234, 212, .6);
}
.afs-link {
  position: absolute;
  height: 1.5px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--afg-mint), var(--afg-violet));
  box-shadow: 0 0 8px rgba(94, 234, 212, .35);
}
.afs-tagline { position: absolute; left: 11px; bottom: 8px; font-size: 9.5px; color: var(--afg-text-3); }
.afs-zp {
  position: absolute;
  right: 10px;
  bottom: 8px;
  height: 18px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--afg-line-2);
  background: rgba(13, 16, 22, .78);
  display: flex;
  align-items: center;
  font-size: 9px;
  color: var(--afg-text-3);
}
.afs-foot { padding: 14px 2px 0; color: var(--afg-text-4); font-size: 11px; }
.afs-foot .afg-mint { color: rgba(94, 234, 212, .75); }
`;
