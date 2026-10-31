/**
 * 无限画布皮肤（方案 C「玻璃面板 Fluent」，2026-10-30 定稿）。
 *
 * 来由：用户原话「帮我重新设计无限画布的 ui，按照之前的调色面板的 ui 风格来。位置尽量不要变。
 * 先设计出来，我再决定替不替换」→ 设计稿（E:\AllAssets\项目\画布UI改版）定稿后说
 * 「按设计好的无限画布 ui 替换」。
 *
 * 做法：**只换皮肤，不动结构**。
 *   - 令牌直接覆盖 vendor 的 `--af-*`（深色一套）：画布/合成器/设置面板从此同一套冷灰蓝 + 青色强调；
 *   - 头部 / 工具条 / 缩放条 / 任务队列 / 小地图按设计稿的玻璃层重绘；位置与结构契约一律不改
 *     （`af-canvas-header`、`bottom-6 left-6 h-[42px]`、`data-fisherai-*` 槽位全部保留）；
 *   - 节点卡片/端口/连线用结构选择器改 vendor 的 Tailwind 产物，vendor 源码一个字不动；
 *   - 生成中节点的「噪波放大圆点阵」由 genDots.ts 往 `[data-fisherai-regeneration-overlay]`
 *     里插一层 SVG，这里只负责底板、圆点发光与中央信息的样式。
 *
 * 为什么覆盖令牌而不是改 themeTokens.ts：那是 vendor 文件；覆盖 CSS 变量在注入顺序上更靠后，
 * 深浅两套主题也还能各自保留（这里只动 dark，light 主题维持原样，用户没要求改浅色）。
 *
 * 圆形控件必须显式 `corner-shape: round`：DSH 的 nova 主题有一段
 * `@supports (corner-shape: superellipse(1.5)) { *, ::before, ::after { corner-shape: ... } }`，
 * 于是 border-radius: 50% 会变成超椭圆（圆角方块）。合成器里已经踩过一次。
 */

export const CANVAS_SKIN_CSS = `
/* ============================================================================
   1. 令牌：暗色画布 → 方案 C（冷灰蓝底 / 半透明层 / 青色强调 + 紫色辅助）
   ========================================================================== */
html[data-af-theme='dark'],
.af-canvas-mount[data-af-theme='dark'] {
  --af-canvas: #0b0d11;
  --af-surface: #15181f;
  --af-surface-raised: #1b2029;
  --af-input: #0f1218;
  --af-text: #e9eef6;
  --af-text-secondary: #a7b2c3;
  --af-text-muted: #6c7688;
  --af-border: rgba(255, 255, 255, .075);
  --af-border-control: rgba(255, 255, 255, .13);
  --af-hover: rgba(255, 255, 255, .06);
  --af-selected: rgba(94, 234, 212, .14);
  --af-on-selected: #eafffb;
  --af-primary: #5eead4;
  --af-on-primary: #052621;
  --af-focus: #5eead4;
  --af-info: #8b7cf6;
  --af-info-bg: #1d1a33;
  --af-edge: #4fd8c4;
  --af-edge-halo: rgba(94, 234, 212, .12);
  --af-scrollbar: #3d4655;
  --af-overlay: rgba(4, 6, 10, .72);
  --af-shadow: 0 18px 44px rgba(0, 0, 0, .46), 0 2px 6px rgba(0, 0, 0, .32);
}

/* 画布底盘：冷灰蓝 + 两团极淡的青/紫光（设计稿的 bg-glow）。grid 层自己会铺点阵。 */
.af-canvas-mount #canvas-background {
  background-color: #0b0d11 !important;
  background-image:
    radial-gradient(920px 580px at 14% -8%, rgba(94, 234, 212, .075), transparent 62%),
    radial-gradient(820px 540px at 98% 6%, rgba(139, 124, 246, .075), transparent 62%) !important;
}

/* 圆形控件：抵消 DSH nova 主题的 superellipse 圆角 */
.af-canvas-mount [class*='rounded-full'],
.af-canvas-mount [data-fisherai-profile-avatar],
.af-canvas-mount [data-fisherai-connector-side],
.af-canvas-mount .af-generation-waiting-ring,
.af-canvas-mount .af-uity-btn,
.af-canvas-mount .af-uity-value {
  corner-shape: round;
}

/* ============================================================================
   2. 顶栏：玻璃条 + 青→紫渐变细线
   ========================================================================== */
.af-canvas-mount .af-canvas-header {
  height: 48px !important;
  /* 顶栏是容器：窄画布（或界面放大后）ComfyUI 胶囊会和中央同步 chip 撞上，
     下面的 @container 只留状态点、把文字收起来。 */
  container-type: inline-size;
  /* background-color 是给「头部是否压住画布」的断言看的（它读 computed backgroundColor）；
     可见的玻璃渐变走 background-image。 */
  background-color: #0d1016 !important;
  background-image: linear-gradient(180deg, rgba(14, 17, 23, .96), rgba(12, 15, 20, .74)) !important;
  -webkit-backdrop-filter: blur(18px) saturate(1.1);
  backdrop-filter: blur(18px) saturate(1.1);
  border-bottom: 1px solid rgba(255, 255, 255, .055) !important;
  box-shadow: 0 1px 0 rgba(255, 255, 255, .02);
}
.af-canvas-mount .af-canvas-header::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(90deg,
    transparent,
    rgba(94, 234, 212, .24) 32%,
    rgba(139, 124, 246, .22) 70%,
    transparent);
  opacity: .62;
}
/* 项目名（未编辑时是 button[title=点击重命名]） */
.af-canvas-mount .af-canvas-header [title='点击重命名'] {
  font-size: 14.5px !important;
  font-weight: 600 !important;
  color: #f1f5fb !important;
  letter-spacing: .01em;
}
.af-canvas-mount .af-canvas-header [title='点击重命名']:hover {
  background: rgba(255, 255, 255, .045) !important;
}
/* 「← 项目库」ghost 胶囊（30 高） */
.af-canvas-mount .af-canvas-header [data-fisherai-back-to-library] {
  height: 30px !important;
  border-radius: 9px !important;
  color: var(--af-text-secondary) !important;
  font-size: 12.5px !important;
}
.af-canvas-mount .af-canvas-header [data-fisherai-back-to-library]:hover {
  background: rgba(255, 255, 255, .06) !important;
  border-color: rgba(255, 255, 255, .075) !important;
  color: var(--af-text) !important;
}
/* ComfyUI 状态胶囊：玻璃小丸（细节见 vendor 的 comfyLogPanel，这里只改皮） */
.af-canvas-mount [data-fisherai-comfyui-log-toggle] {
  height: 28px !important;
  padding: 0 9px !important;
  gap: 7px !important;
  border-radius: 999px !important;
  border-color: rgba(255, 255, 255, .075) !important;
  background: rgba(255, 255, 255, .035) !important;
  color: var(--af-text-secondary) !important;
  font-size: 11.5px !important;
}
.af-canvas-mount [data-fisherai-comfyui-log-toggle]:hover {
  background: rgba(255, 255, 255, .06) !important;
  color: var(--af-text) !important;
}
/* 头部变窄（界面放大 / 侧栏窄）时：只留状态点 + 箭头，别和中央的同步 chip 叠字 */
@container (max-width: 860px) {
  .af-canvas-mount [data-fisherai-comfyui-log-toggle] > span:nth-of-type(2) {
    display: none;
  }
  .af-canvas-mount [data-fisherai-comfyui-log-toggle] {
    padding: 0 7px !important;
  }
}
/* 保存状态徽标：无边框、11px、右侧贴边（设计稿只留文字 + 琥珀点） */
.af-canvas-mount .af-canvas-header [data-slot='badge'] {
  border-color: transparent !important;
  background: transparent !important;
  padding: 0 2px !important;
  font-size: 11px !important;
  color: var(--af-text-muted) !important;
}

/* ============================================================================
   3. 左侧工具条：48 宽玻璃胶囊 / 34 圆 ghost / 38 青色主按钮
   ========================================================================== */
.af-canvas-mount [role='toolbar'][aria-label='画布工具'] {
  width: 48px !important;
  padding: 5px !important;
  border-radius: 24px !important;
  gap: 2px !important;
  /* 工具条是「垂直居中」的；界面放大后整条变高，底部会撞到左下小地图。
     每放大一档往上让一点（100% 时不影响），保证 125% 下头像仍然完整露在小地图上方。 */
  top: calc(50% - (var(--af-ui-scale, 1) - 1) * 108px) !important;
  background: rgba(20, 24, 31, .74) !important;
  border-color: rgba(255, 255, 255, .075) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.1);
  backdrop-filter: blur(20px) saturate(1.1);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .46), 0 2px 6px rgba(0, 0, 0, .32),
    inset 0 1px 0 rgba(255, 255, 255, .055) !important;
}
.af-canvas-mount [role='toolbar'][aria-label='画布工具'] button {
  width: 34px !important;
  height: 34px !important;
  border-radius: 50% !important;
  color: #93a0b4 !important;
  background: transparent !important;
  transition: background .12s ease, color .12s ease;
}
.af-canvas-mount [role='toolbar'][aria-label='画布工具'] button:hover {
  background: rgba(255, 255, 255, .07) !important;
  color: var(--af-text) !important;
}
.af-canvas-mount [role='toolbar'][aria-label='画布工具'] button:active {
  transform: scale(.94);
}
/* 「添加节点」是整条工具条唯一的主按钮 */
.af-canvas-mount [role='toolbar'][aria-label='画布工具'] button[aria-label='添加节点'] {
  width: 38px !important;
  height: 38px !important;
  border: 1px solid rgba(180, 255, 244, .5) !important;
  background: linear-gradient(180deg, #7af2df, #3fd5bd) !important;
  color: #052621 !important;
  box-shadow: 0 6px 18px rgba(63, 213, 189, .32), inset 0 1px 0 rgba(255, 255, 255, .5) !important;
}
.af-canvas-mount [role='toolbar'][aria-label='画布工具'] button[aria-label='添加节点'] svg {
  width: 18px;
  height: 18px;
  stroke-width: 2.2;
}
.af-canvas-mount [role='toolbar'][aria-label='画布工具'] button[aria-label='添加节点']:hover {
  filter: brightness(1.07);
}
/* 工具条里的分隔线：24px 宽、更淡 */
.af-canvas-mount [role='toolbar'][aria-label='画布工具'] [data-slot='separator'] {
  width: 24px !important;
  margin: 5px 0 !important;
  background: rgba(255, 255, 255, .09) !important;
}
/* 底部用户头像：紫→青渐变 */
.af-canvas-mount [data-fisherai-profile-avatar] {
  width: 30px !important;
  height: 30px !important;
  border: 0 !important;
  background: linear-gradient(135deg, #8b7cf6, #5eead4) !important;
  color: #0b0d11 !important;
  font-size: 11px !important;
  font-weight: 800 !important;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .12), 0 4px 12px rgba(0, 0, 0, .4);
}

/* ============================================================================
   4. 左下缩放条 + 帮助按钮 + 小地图
   ========================================================================== */
.af-canvas-mount [data-af-zoom-bar] {
  height: 44px !important;
  padding: 0 7px !important;
  gap: 4px !important;
  border-radius: 12px !important;
  background: rgba(21, 25, 32, .8) !important;
  border-color: rgba(255, 255, 255, .075) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.1);
  backdrop-filter: blur(20px) saturate(1.1);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .46), 0 2px 6px rgba(0, 0, 0, .32),
    inset 0 1px 0 rgba(255, 255, 255, .055) !important;
}
.af-canvas-mount [data-af-zoom-bar] button {
  width: 30px !important;
  height: 30px !important;
  border-radius: 9px !important;
  color: #93a0b4 !important;
}
.af-canvas-mount [data-af-zoom-bar] button:hover {
  background: rgba(255, 255, 255, .07) !important;
  color: var(--af-text) !important;
}
.af-canvas-mount [data-af-zoom-bar] [data-fisherai-zoom-value] {
  min-width: 40px !important;
  height: 26px !important;
  padding: 0 4px !important;
  border-radius: 7px !important;
  color: var(--af-text-secondary) !important;
  font-size: 11.5px !important;
  font-weight: 600 !important;
  font-variant-numeric: tabular-nums;
}
.af-canvas-mount [data-af-zoom-bar] [data-fisherai-zoom-value]:hover {
  background: rgba(255, 255, 255, .06) !important;
  color: var(--af-text) !important;
}
/* 缩放滑杆：3px 轨道 + 青色渐变填充 */
.af-canvas-mount [data-af-zoom-bar] [data-slot='slider'] {
  width: 84px !important;
}
.af-canvas-mount [data-af-zoom-bar] [data-slot='slider-track'] {
  height: 3px !important;
  background: rgba(255, 255, 255, .12) !important;
}
.af-canvas-mount [data-af-zoom-bar] [data-slot='slider-range'] {
  background: linear-gradient(90deg, #2dd4bf, #5eead4) !important;
  box-shadow: 0 0 10px rgba(94, 234, 212, .35);
}
.af-canvas-mount [data-af-zoom-bar] [data-slot='slider-thumb'] {
  width: 12px !important;
  height: 12px !important;
  border: 2px solid #2dd4bf !important;
  background: #eafffb !important;
  box-shadow: 0 0 0 3px rgba(94, 234, 212, .12), 0 1px 4px rgba(0, 0, 0, .5) !important;
}

.af-canvas-mount [data-af-help-btn] {
  left: 288px !important;
  width: 42px !important;
  height: 42px !important;
  border-radius: 50% !important;
  border: 1px solid rgba(255, 255, 255, .075) !important;
  background: rgba(21, 25, 32, .8) !important;
  color: var(--af-text-muted) !important;
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .46), inset 0 1px 0 rgba(255, 255, 255, .055);
}
.af-canvas-mount [data-af-help-btn]:hover {
  color: var(--af-text) !important;
  background: rgba(30, 35, 44, .86) !important;
}

.af-canvas-mount [data-fisherai-minimap] {
  border-radius: 14px !important;
  border-color: rgba(255, 255, 255, .075) !important;
  background: rgba(18, 22, 28, .78) !important;
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .46), inset 0 1px 0 rgba(255, 255, 255, .055) !important;
}
.af-canvas-mount [data-fisherai-minimap-viewport] {
  border-color: rgba(94, 234, 212, .34) !important;
  background: rgba(94, 234, 212, .03) !important;
}

/* ============================================================================
   5. 任务队列：玻璃面板 + 运行中的行保留循环光（GLOW_CSS 不动）
   ========================================================================== */
.af-canvas-mount [data-fisherai-task-queue='panel'] {
  /* 宽度保持 306：任务队列自己按 306 往画布写 --fisherai-task-queue-inset 给头部让位，
     改成 320 会让保存状态被面板压住（设计稿注：落地按回归里的 306 也行）。 */
  width: 306px !important;
  border-radius: 16px !important;
  border-color: rgba(255, 255, 255, .075) !important;
  background: rgba(20, 24, 31, .82) !important;
  -webkit-backdrop-filter: blur(22px) saturate(1.15);
  backdrop-filter: blur(22px) saturate(1.15);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .46), 0 2px 6px rgba(0, 0, 0, .32),
    inset 0 1px 0 rgba(255, 255, 255, .055) !important;
}
.af-canvas-mount [data-fisherai-task-queue='panel'] > div:first-child {
  height: 42px !important;
  padding: 0 10px 0 12px !important;
  border-bottom-color: rgba(255, 255, 255, .055) !important;
}
.af-canvas-mount [data-fisherai-task-queue='panel'] > div:first-child > svg {
  width: 15px;
  height: 15px;
  color: #5eead4;
}
.af-canvas-mount [data-fisherai-task-queue='panel'] > div:first-child > span:first-of-type {
  font-size: 13px !important;
  font-weight: 600 !important;
  color: #e4ebf5 !important;
}
.af-canvas-mount [data-fisherai-task-queue-badge='running'] {
  height: 20px !important;
  padding: 0 7px !important;
  border-radius: 999px !important;
  background: rgba(94, 234, 212, .1) !important;
  border: 1px solid rgba(94, 234, 212, .18);
  color: #8ff5e4 !important;
  font-size: 10px !important;
  font-weight: 600 !important;
}
.af-canvas-mount [data-fisherai-task-queue-badge='idle'] {
  color: var(--af-text-muted) !important;
  font-size: 10px !important;
}
.af-canvas-mount [data-fisherai-task-queue-item] {
  border-radius: 11px !important;
  border-color: rgba(255, 255, 255, .05) !important;
  background: rgba(255, 255, 255, .026) !important;
  padding: 7px 9px !important;
}
.af-canvas-mount [data-fisherai-task-queue-item][data-fisherai-task-status='running'] {
  background: rgba(94, 234, 212, .045) !important;
  border-color: rgba(94, 234, 212, .24) !important;
}
.af-canvas-mount [data-fisherai-task-queue-item][data-fisherai-task-status='success'] {
  opacity: .82;
}
.af-canvas-mount [data-fisherai-task-queue='rail'] {
  border-radius: 12px 0 0 12px !important;
  border-color: rgba(255, 255, 255, .075) !important;
  background: rgba(20, 24, 31, .82) !important;
  -webkit-backdrop-filter: blur(22px);
  backdrop-filter: blur(22px);
}

/* ============================================================================
   6. 节点卡片：14 圆角 / 玻璃渐变 / 描边 + 内高光；标题行改成「分类色小圆点 + 名称」
   ========================================================================== */
.af-canvas-mount #canvas-viewport-content [data-node-id] > div[class~='group/nodecard'] > div[class*='bg-[var(--af-surface)]'] {
  border-radius: 14px !important;
  border-color: rgba(255, 255, 255, .075) !important;
  background: linear-gradient(180deg, rgba(32, 37, 47, .95), rgba(24, 28, 35, .97)) !important;
  box-shadow: 0 18px 44px rgba(0, 0, 0, .46), 0 2px 6px rgba(0, 0, 0, .32),
    inset 0 1px 0 rgba(255, 255, 255, .055) !important;
}
.af-canvas-mount #canvas-viewport-content [data-node-id] > div[class~='group/nodecard'] > div[class*='bg-[var(--af-surface)]']:hover {
  border-color: rgba(255, 255, 255, .13) !important;
}
/* 选中：青色描边 + 内环 + 柔光 */
.af-canvas-mount #canvas-viewport-content [data-node-id][data-node-selected='true'] > div[class~='group/nodecard'] > div[class*='bg-[var(--af-surface)]'] {
  border-color: rgba(94, 234, 212, .55) !important;
  box-shadow: 0 0 0 1px rgba(94, 234, 212, .22), 0 0 26px rgba(94, 234, 212, .14),
    0 18px 44px rgba(0, 0, 0, .46) !important;
}
/* 叠图那两张垫纸也跟卡片同一套圆角/描边 */
.af-canvas-mount #canvas-viewport-content [data-node-id] [data-fisherai-stack-layer] {
  border-radius: 14px !important;
  border-color: rgba(255, 255, 255, .075) !important;
  background: #1b2029 !important;
}

/* 标题行（在卡片上方，位置/行为不动） */
.af-canvas-mount [data-af-node-title] {
  align-items: center;
  gap: 2px;
  padding: 0 2px;
}
.af-canvas-mount [data-af-node-title] svg {
  display: none;
}
.af-canvas-mount [data-af-node-title] [role='button'] {
  font-size: 12.5px !important;
  font-weight: 600 !important;
  letter-spacing: .005em;
  color: #c3ccda !important;
  padding: 2px 4px !important;
}
.af-canvas-mount [data-node-id][data-node-selected='true'] [data-af-node-title] [role='button'] {
  color: #eaf6ff !important;
}
/* 分类色小圆点：靠内容反推类型（文本 / 图片 / 视频），比读图标 path 稳 */
.af-canvas-mount [data-af-node-title] [role='button']::before {
  content: '';
  display: inline-block;
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--af-text-muted);
  box-shadow: 0 0 9px color-mix(in srgb, var(--af-text-muted) 70%, transparent);
  vertical-align: middle;
}
.af-canvas-mount [data-node-id]:has([contenteditable='true']) [data-af-node-title] [role='button']::before,
.af-canvas-mount [data-node-id]:has(.ProseMirror) [data-af-node-title] [role='button']::before {
  background: #5eead4;
  box-shadow: 0 0 9px rgba(94, 234, 212, .7);
}
.af-canvas-mount [data-node-id]:has(video) [data-af-node-title] [role='button']::before {
  background: #f5c26b;
  box-shadow: 0 0 9px rgba(245, 194, 107, .66);
}
.af-canvas-mount [data-node-id]:has(img) [data-af-node-title] [role='button']::before {
  background: #8b7cf6;
  box-shadow: 0 0 9px rgba(139, 124, 246, .7);
}
.af-canvas-mount [data-af-node-title] > div:last-child {
  font-size: 10px !important;
  color: var(--af-text-muted) !important;
  letter-spacing: .02em;
  font-variant-numeric: tabular-nums;
}

/* 图片/视频本体：圆角跟着卡片，外圈不再有第二道硬边 */
.af-canvas-mount #canvas-viewport-content [data-fisherai-image-preview] [data-af-media-chrome],
.af-canvas-mount #canvas-viewport-content [data-fisherai-image-preview] > div:last-child > div,
.af-canvas-mount #canvas-viewport-content video {
  border-radius: 9px !important;
}
.af-canvas-mount #canvas-viewport-content [data-fisherai-image-preview] img {
  border-radius: 9px !important;
}

/* 端口：12px 青色圆点（20px 命中区不变，用 content-box 收视觉尺寸） */
.af-canvas-mount [data-fisherai-connector-side] {
  border: 0 !important;
  padding: 4px !important;
  background: #5eead4 !important;
  background-clip: content-box !important;
  color: transparent !important;
  box-shadow: 0 0 0 2px #0b0d11, 0 0 12px rgba(94, 234, 212, .55) !important;
}
.af-canvas-mount [data-fisherai-connector-side] svg {
  display: none;
}
.af-canvas-mount [data-fisherai-connector-side]:hover {
  background: #a7fff1 !important;
  box-shadow: 0 0 0 2px #0b0d11, 0 0 16px rgba(94, 234, 212, .8) !important;
}

/* 连线：青→紫，halo 同色低透明度（base 路径走 --af-edge / --af-edge-halo 令牌） */
.af-canvas-mount .fisherai-canvas-edge [data-af-edge-halo] {
  stroke: rgba(94, 234, 212, .13) !important;
}
.af-canvas-mount .fisherai-canvas-edge [data-fisherai-edge-visible] {
  stroke: #4fd8c4 !important;
}

/* 选中节点的框选/媒体缩放把手也换成青色 */
.af-canvas-mount [data-fisherai-media-resize-handle] {
  color: rgba(94, 234, 212, .8) !important;
}

/* ============================================================================
   7. 生成中节点：黑底 + 噪波放大的圆点阵（圆点由 genDots.ts 插入）
   ========================================================================== */
.af-canvas-mount .af-generation-waiting {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  overflow: hidden;
  border-radius: inherit;
  color: #e9eef6;
  background: #04060a !important;
  pointer-events: none;
  text-align: center;
  padding: 16px;
  contain: paint;
}
/* 圆点阵层：由 genDots.ts 插入为第一个孩子；发光靠 SVG 的 drop-shadow */
.af-canvas-mount .af-generation-waiting .af-gen-dots {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: inherit;
  overflow: hidden;
}
.af-canvas-mount .af-generation-waiting .af-gen-dots svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  filter: drop-shadow(0 0 4px rgba(94, 234, 212, .45));
}
/* 中央可读性：小范围暗底 + 文字/进度提到噪波之上（暗底太大整块点阵会被吃掉） */
.af-canvas-mount .af-generation-waiting::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: radial-gradient(circle 150px at 50% 47%, rgba(4, 6, 10, .82) 0 16%, rgba(4, 6, 10, .34) 55%, transparent 88%);
}
.af-canvas-mount .af-generation-waiting > * {
  position: relative;
  z-index: 2;
}
/* 文字在噪波上也清楚（不靠大块暗底） */
.af-canvas-mount .af-generation-waiting strong,
.af-canvas-mount .af-generation-waiting-operation,
.af-canvas-mount .af-generation-waiting small {
  text-shadow: 0 1px 10px rgba(4, 6, 10, .92), 0 0 2px rgba(4, 6, 10, .9);
}
/* 原来的转圈 spinner → 细环 + 3/4 青色弧（不定进度，不假装 62%） */
.af-canvas-mount .af-generation-waiting-ring {
  width: 56px;
  height: 56px;
  margin-bottom: 6px;
  border: 0;
  border-radius: 50%;
  background: conic-gradient(from 0deg,
    rgba(94, 234, 212, .95) 0 52%,
    rgba(94, 234, 212, .55) 68%,
    rgba(94, 234, 212, .12) 84%,
    rgba(94, 234, 212, 0) 92%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
  box-shadow: 0 0 24px rgba(94, 234, 212, .18);
  animation: af-gen-orbit-spin 1.6s linear infinite;
}
@keyframes af-gen-orbit-spin {
  to { transform: rotate(360deg); }
}
.af-canvas-mount .af-generation-waiting strong {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .01em;
  color: #eaf6ff;
  line-height: 1.4;
}
.af-canvas-mount .af-generation-waiting-operation {
  font-size: 10.5px;
  color: #8b95a5;
}
.af-canvas-mount .af-generation-waiting small {
  font-size: 10px;
  color: #6c7688;
}
/* 底部不定进度线（细、常驻、只在生成中） */
.af-canvas-mount .af-generation-waiting::before {
  content: '';
  position: absolute;
  left: 22px;
  right: 22px;
  bottom: 18px;
  z-index: 2;
  height: 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, .07);
  pointer-events: none;
}
.af-canvas-mount .af-generation-waiting .af-gen-bar {
  position: absolute;
  left: 22px;
  right: 22px;
  bottom: 18px;
  z-index: 3;
  height: 3px;
  border-radius: 3px;
  overflow: hidden;
  pointer-events: none;
}
.af-canvas-mount .af-generation-waiting .af-gen-bar i {
  display: block;
  width: 34%;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #2dd4bf, #5eead4);
  box-shadow: 0 0 10px rgba(94, 234, 212, .55);
  animation: af-gen-bar-slide 1.8s cubic-bezier(.65, 0, .35, 1) infinite;
}
@keyframes af-gen-bar-slide {
  0% { transform: translateX(-105%); }
  100% { transform: translateX(320%); }
}

/* ============================================================================
   8. 界面缩放（UI Scale）：只作用于 chrome，画布内容不动
   ========================================================================== */
.af-canvas-mount .af-canvas-header,
.af-canvas-mount [role='toolbar'][aria-label='画布工具'],
.af-canvas-mount [data-af-zoom-bar],
.af-canvas-mount [data-af-help-btn],
.af-canvas-mount [data-fisherai-minimap],
.af-canvas-mount [data-fisherai-task-queue],
.af-canvas-mount [data-af-ui-scale] {
  zoom: var(--af-ui-scale, 1);
}

/* 右下角「界面 − 100% +」胶囊（设计稿唯一新增的控件）。
   设计稿把它放在 right:24 / bottom:24，但 DSH 桌面面板的「退出画布」按钮就占着那个角
   （PanelExitButton：right 20 / bottom 20 / z 60，会把它整块盖住）。这里往上让 48px，
   仍然贴右下、仍然不与任何现有控件重叠。 */
.af-canvas-mount .af-uity {
  position: absolute;
  right: 24px;
  bottom: 72px;
  z-index: 50;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 0 5px 0 11px;
  border-radius: 999px;
  background: rgba(21, 25, 32, .8);
  border: 1px solid rgba(255, 255, 255, .075);
  -webkit-backdrop-filter: blur(20px) saturate(1.1);
  backdrop-filter: blur(20px) saturate(1.1);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .46), 0 2px 6px rgba(0, 0, 0, .32),
    inset 0 1px 0 rgba(255, 255, 255, .055);
  color: var(--af-text-secondary);
  user-select: none;
}
.af-canvas-mount .af-uity-label {
  margin-right: 3px;
  font-size: 10.5px;
  letter-spacing: .06em;
  color: var(--af-text-muted);
}
.af-canvas-mount .af-uity-btn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--af-text-secondary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.af-canvas-mount .af-uity-btn:hover {
  background: rgba(255, 255, 255, .07);
  color: var(--af-text);
}
.af-canvas-mount .af-uity-btn:active {
  transform: scale(.92);
}
.af-canvas-mount .af-uity-value {
  min-width: 42px;
  height: 26px;
  padding: 0 4px;
  border: 0;
  border-radius: 8px;
  background: rgba(94, 234, 212, .08);
  color: #9cf5e6;
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.af-canvas-mount .af-uity-value:hover {
  background: rgba(94, 234, 212, .14);
}
.af-canvas-mount .af-uity-tip {
  position: absolute;
  right: 2px;
  bottom: 44px;
  padding: 7px 10px;
  border-radius: 9px;
  background: rgba(18, 22, 28, .94);
  border: 1px solid rgba(255, 255, 255, .075);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .46);
  font-size: 10.5px;
  color: var(--af-text-secondary);
  white-space: nowrap;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity .18s ease, transform .18s ease;
  pointer-events: none;
}
.af-canvas-mount .af-uity-tip.is-show {
  opacity: 1;
  transform: translateY(0);
}

/* 弹层（下拉/弹窗/popover）也换成同一套玻璃：它们 portal 到画布容器里 */
.af-canvas-mount [data-slot='dropdown-menu-content'],
.af-canvas-mount [data-slot='popover-content'],
.af-canvas-mount [data-slot='tooltip-content'] {
  border-radius: 12px !important;
  border-color: rgba(255, 255, 255, .1) !important;
  background: rgba(20, 25, 32, .96) !important;
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
  box-shadow: 0 20px 48px rgba(0, 0, 0, .62) !important;
}

@media (prefers-reduced-motion: reduce) {
  .af-canvas-mount .af-generation-waiting-ring,
  .af-canvas-mount .af-generation-waiting .af-gen-bar i {
    animation: none;
  }
}
`;
