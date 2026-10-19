# 画布 UI 重设计：shadcn/ui（nova 风）

> 2026-10-16 起。第一波覆盖**核心操控面**：头部栏、左侧节点工具条、左下缩放控件、
> 小地图。第二波（v1.10~v1.25）陆续补了节点搜索、ComfyUI 工作流配置、任务队列；
> **v1.26 补完图片编辑族**（图片编辑工作台 / 裁剪舞台 / 标注·蒙版舞台 / 独立标注器）；
> **v1.36 重排顶部**（返回项目库按钮 / ComfyUI 胶囊移到左边 / 任务队列上移到右上角，
> 并修好头部被画布底盘整块盖住的老问题）；**v1.38 换成扩图 + 尺寸对话框 nova 版**
> （工具条那个 HD「AI 高清放大」拿掉，原位置是「扩图」面板；`Resize` 槽位换实现）；
> **v1.39 扩图改成两步两节点**（先出一张真图片「扩图画面」，再接一个空的图像生成节点，
> 面板补上目标比例 / 原图位置九宫格 / 延展内容 / 预览）；
> **v1.41 任务队列只在画布这一层**（浮层打开时面板整块不出现）+ 右侧会话栏「新对话」输入区贴底；
> **v1.42 项目归档**（头部「项目归档」入口 → 面板里导出 `.fisherai` / 导入备份，
> 项目看板头部另有「导入项目」按钮；导出会直接写到本机下载目录并回绝对路径）；
> **v1.43 项目数据目录**（设置 → 存储 → 项目数据目录：把插件的整个数据目录换到别的盘，
> 写指针 + 重启 DSH 生效，可选「把现有数据复制过去」）；
> **v1.46 补完宫格裁剪**（宫格裁剪舞台换成同一套 nova 工作台，几何/切线/导出仍复用 vendor 纯函数；
> 全景 / 角度 / 生成全景继续交给 vendor）。
> 其余画面（节点框内部、其它十几个对话框）仍沿用 AIFISHER 原样，后续可分批迁。

## 一、整体做法（为什么这么接）

画布 UI 来自 vendor 的 AIFISHER（300 个源文件，`scripts/vendor-aifisher.mjs`
**每次构建都整树重建**）。所以重设计不能直接改 vendor —— 那样下次构建就没了。

AIFISHER 恰好留了一个干净的注入点：`app/canvasComponents.ts` 把每个视图组件都写成
`bind(实现)(依赖工厂)`，而 `canvas/` 的 `dependencies`（我们的 `stage.tsx`）才是真正的装配处。

于是路线是：

```
src/canvas-ui/            ← 新增：shadcn/ui 组件（vendor 进来的源码，可自由改）
  ui/                     ← 29 个 registry 组件（scripts/sync-shadcn-ui.mjs 拉取）
  lib/utils.ts            ← cn()（clsx + tailwind-merge）
  lib/portal.ts           ← 浮层容器（见下）
  lib/react.ts            ← 画布内共用的 React 元素工厂（见下）
  lib/icon.tsx            ← 图标工厂（shadcn 的 data-icon 约定）
  canvas/                 ← 四个重绘的视图组件
    CanvasHeader.tsx  CanvasSidebar.tsx  CanvasViewportControls.tsx  CanvasMinimap.tsx

src/client/canvas/stage.tsx   ← 装配层：把 dependencies 的四个槽位换成上面的实现
src/client/canvas/shadcn-theme.css  ← 主题桥接 + 作用域 base 复位
```

**vendor 树一个字都没改**（`scripts/test-panel-exit.mjs` 里有几条断言就在查 vendor
源文件字符串，这个事实同时也是回归保护）。

## 二、四个必须知道的硬约束（都踩过坑；v1.19 又补了第 0 条）

### 0. 面板里加 hook，别放到「提前返回」之后

视图组件常在中间写 `if (!open) return null`（面板关着就什么都不渲染）。在那之后新加
`useState`/`useMemo`/`useRef`，会让「关着的那次渲染少跑两个 hook、打开的那次多跑两个」——
React 直接抛 **error #310（Rendered more hooks than during the previous render）**，
整棵画布树一起卸载（表现成「点入口没反应，工具条也没了」）。v1.19 加节点图检查器时就踩了这一次。
规矩：面板/组件的 hook 一律写在第一个提前返回之前，纯计算（`filter`/`find`/字符串拼装）才放到后面。

### 1. hooks 必须用「画布渲染器那一份 React」

产物里 React 有**两份副本**：vendor 画面包一份、`src/canvas-ui` 里 shadcn 组件
import 的那份。两份的 hooks 分发器互不相通。用错那份，React 19 **既不报错也不渲染** ——
表现成「头部/工具条整块消失，页面上什么都没说」。

- 四个视图组件的签名固定为 `(react, props, ...injected)`，hooks 一律从第一个参数取
  （`react.useState`），`import * as ReactTypes from 'react'` 只用来取类型。
- shadcn 的 `ui/**` 组件用 JSX，靠 `tsdown.config.ts` 的
  `inputOptions.jsx = { mode: 'automatic', jsxImportSource: '@/lib/react' }`
  把它们的 JSX 收拢到 `src/canvas-ui/lib/react.ts` 的 `h()` 工厂上；
  装配层在挂载前调用 `useCanvasReact(React)` 登记当前那份 React。
- `react` / `react-dom` **不能设成 external**：产物是浏览器 ESM，external 会退化成
  CommonJS 互操作里的 `require('react')`，浏览器里直接抛
  「Calling `require` for "react" ...」。

### 2. 依赖注入形状：对象，不是数组

vendor 的 `bind()` 是 `render(React, props, ...dependencies())` —— 工厂返回什么，
就**原样展开成参数**。上游 `canvasComponents.ts` 里写的是对象：

```ts
export const Header = bind(Dialogs.CanvasHeader)(() => [
  { Tooltip, SaveIcon, … },     // ← 数组里放一个对象，被展开成一个参数
]);
```

所以我们的实现拿到的是**一个对象**（`components.Tooltip`）。若自己写成
`() => [{...}]` 再手工展开一层，`components` 就成了数组、`components.Tooltip` 是
undefined，React 抛 #130。

### 3. shadcn 浮层要 portal 回画布容器

Radix 默认 portal 到 `document.body`。画布的 shadcn 变量只落在 `.af-canvas-mount`
作用域里，挂到 body 会读到 DSH 那份主题；而且画布卸载后浮层会留在 DSH 页面上。

- `src/canvas-ui/lib/portal.ts` 提供 `canvasPortalTarget()`；
- `scripts/sync-shadcn-ui.mjs` 在**重新拉组件时自动注入** `container={canvasPortalTarget()}`
  到每个 `XxxPortal`（改组件清单后重跑脚本即可，不用手工补）。

### 4. 主题与 base 复位都必须限定在画布作用域
样式会被注入到 DSH 自己的页面里，全局 preflight 会把 DSH 整个界面改样。做法：

- 只取 Tailwind 的 `theme` + `utilities` 两层（`build-canvas-css.mjs` 里刻意不要 preflight）；
- `shadcn-theme.css` 里用 `@layer base` 把 shadcn 组件**依赖的那部分**复位
  （box-sizing / border-color / 控件字体继承 / img-video 块级…）限定在 `.af-canvas-mount` 内；
- shadcn 的语义变量（`--background` / `--primary` / `--border` / `--ring` …）在
  `@theme inline` 里**别名到 `--af-*`**，所以 shadcn 组件自动跟随画布的深/浅色主题；
- 暗色不是 `.dark` 类而是 `[data-af-theme="dark"]` 属性，用 `@custom-variant dark`
  改写；装配层把主题镜像到画布容器上（`mount.tsx` 的 `mirrorCanvasTheme`）。

## 三、结构契约（改这四块之前先看）
回归与真机检查依赖下面这些**不会变的东西**：

| 位置 | 契约 | 谁在查 |
|---|---|---|
| 头部 | 根元素 class 含 `af-canvas-header absolute top-0 left-0` | `browser-check`（越界）、`test-panel-exit` |
| 头部 | **必须带 `z-50` + 不透明底 `bg-[var(--af-surface)]`**（v1.36）：vendor 的 `#canvas-background` 是不透明底且 DOM 顺序在头部之后，头部没有叠层就会被整块盖住 —— 真机表现「logo/项目名/保存状态都看不见、也点不到」 | `test:canvas-ui`（类名契约）、`browser-check`（`elementFromPoint` 命中测试 `onTop`） |
| 头部 | `[data-fisherai-back-to-library]` + `aria-label="返回项目库"`（v1.36，左起第一个可交互件），点击 → vendor 的 `onBack`（view→dashboard） | `test:canvas-ui`（真点一次回看板）、`browser-check` canvas 场景 |
| 头部 | `[data-fisherai-account-center-slot="true"]` 是头部右侧工具条的**直接子元素** | `comfyLogPanel` 用它兜底停靠胶囊 |
| 头部 | `[data-fisherai-comfyui-slot="true"]` 是头部**左侧**工具条的直接子元素（v1.36）：vendor 的 `dockComfyPanel`（3.8n 补丁）优先停到这里，`host.dataset.dock = 'topbar-left'` | `test:canvas-ui`、`browser-check`（胶囊中心落在头部左半边） |
| 头部 | `padding-right` 读 `--fisherai-task-queue-inset`（v1.36）：任务队列展开 306px / 收起成窄轨 44px，由 `CanvasTaskQueue` 写在画布容器上，避免面板盖住保存状态 | `test:task-queue`、`test:canvas-ui` |
| 头部 | 保存状态文案含「尚未保存 / 未保存 / 保存中 / 已保存」 | `browser-check` canvas 场景 |
| 左侧工具条 | 根元素 `absolute left-4 top-1/2`；「添加节点」aria-label | `test-panel-exit`、`browser-check` 建节点场景 |
| 左侧工具条 | 资产 / 工作流节点 / **ComfyUI 工作流配置** / 历史 / 设置 五个 aria-label（v1.16 起第三个不再是「SKILL 社区」） | `browser-check` 设置场景、`test:canvas-ui` |
| ComfyUI 工作流配置 | 入口按钮要带 `data-fisherai-workflow-config-trigger`；面板根 `role="dialog"` + `aria-label="ComfyUI 工作流配置"` + `data-fisherai-workflow-config-dialog`；候选字段行 `data-fisherai-workflow-config-candidate` + `aria-checked`；底栏目录输入框 `input[aria-label="工作流目录"]`（v1.18 可编辑）+ 按钮 aria-label「应用目录」「恢复默认目录」「重新扫描目录」 | `test:canvas-ui`、`test:workflow-config`、`browser-check` |
| ComfyUI 工作流配置（节点图，v1.19） | 图根 `data-fisherai-workflow-config-graph`（带 `data-nodes`/`data-edges`/`data-zoom`）；节点卡 `data-fisherai-workflow-config-graph-node="<节点id>"`（带 `data-selected`/`data-candidates`/`data-picked`）；连线 `data-fisherai-workflow-config-graph-edge="from->to"`；检查器 `data-fisherai-workflow-config-inspector="all\|<节点id>"`，✕ 的 aria-label「返回全部字段」；「适应窗口」`data-fisherai-workflow-config-fit` | `test:workflow-config`、`browser-check` |
| 缩放控件 | 根元素 `absolute bottom-6 left-6 h-[42px]`；滑杆 aria-label=画布缩放 | `test-panel-exit`、`browser-check` |
| 缩放控件 | 按钮 aria-label = 关闭/打开小地图、显示所有节点、快捷键说明 | jsdom 回归 |
| 小地图 | `data-fisherai-minimap` / `data-fisherai-minimap-viewport` | jsdom 回归 |
| 画布菜单 | 项仍是 `role="menuitem"`（画布菜单本身仍在 vendor，只换外观） | `browser-check` 建节点场景 |
| 任务队列（v1.24） | 根 `data-fisherai-task-queue="panel" \| "rail"`（带 `data-fisherai-task-queue-running`）；行 `data-fisherai-task-queue-item="<任务id>"` + `data-fisherai-task-status="running\|success\|failed\|cancelled"` + `data-fisherai-task-kind`；用时 `data-fisherai-task-elapsed-ms`；空态 `data-fisherai-task-queue-empty`；读取失败 `data-fisherai-task-queue-error`；失败原因 `data-fisherai-task-error` | `test:task-queue`、`browser-check` task-queue 场景 |
| 任务队列（位置，v1.36） | 面板与窄轨都贴画布**右上角**：`position:absolute; right:12px; top:8px`（窄轨 `right:0`）；同时往画布容器写 `--fisherai-task-queue-inset`（306/44px）给头部让位 | `test:task-queue`（style 串 + 变量）、`browser-check`（`gapTop=8`） |
| 任务队列（按钮 aria） | 取消任务 / 收起任务队列 / 展开任务队列 / 清空已完成任务 | `test:task-queue` |
| 任务队列（视觉） | 运行中的行：`af-task-queue-glow`（box-shadow 呼吸）+ `::before` 的 `af-task-queue-sweep`（mask 抠 1px 环 + background-position 流动）；样式由组件自注入的 `style[data-fisherai-task-queue-style]` 提供，`prefers-reduced-motion` 下停 | `browser-check`（读 computedStyle 的 animationName） |
| 任务队列（层级，v1.41） | **只在画布这一层**：任何接管全屏的浮层（设置 / 图片编辑 / 媒体预览 / 资源库…）打开时，面板必须 `display:none`。机制 = vendor `activateModal()` 给浮层路径上的兄弟节点加 `inert`，面板（portal 到画布容器的直接子节点）也在其中，样式表里 `[data-fisherai-task-queue][inert] { display:none !important }`；**不要**用选择器清单逐个登记浮层，也不要用「把 z-index 调到比浮层低」的办法（`--af-overlay` 是半透明 + blur，会透出来） | `test:task-queue`（规则串 + 真开设置的 inert 行为）、`browser-check` `queue-layers`（display + inert + `elementFromPoint`） |
| 右侧会话栏（布局，v1.41） | **新对话（空白会话）输入区贴底**：`[data-dsh-aifisher-chat="body"] [data-conversation-content] > [data-conversation-scroll] > [data-composer-seat] { margin-top: auto }`。原因：空白会话内核不渲 Views，滚动区里只剩一个 `flex:none` 的 composerSeat；本栏又固定 `phase:'active'`（不渲 hero 标题），拿不到内核 hero phase 的居中规则 | `test:chat-dock`（精确选择器 + `margin-top:auto`）、`verify-live-dock`（真机 A/B：带规则贴底 / 摘掉规则复现顶头） |
| 接入口 / 端口（v1.25） | 每个端口按钮必须带 `data-fisherai-connector-node-id` / `-side="left\|right"` / `-port-index="<槽位下标>"`；本地工作流节点的端口另带 `data-fisherai-port="true"`（拖动时按距离放大/发光的锚点）；槽位行 `data-fisherai-local-workflow-slot="<槽位 id>"` | `canvasConnectionHooks` 的命中判定**全靠这三个属性**找端口（按节点矩形判定会漏掉露在框外的那半圈圆）；`test:local-workflows` 守属性契约、`browser-check` workflow-node 场景真拖线量落点与发光 |
| 端口发光的诊断读数（v1.25） | `window.__FISHERAI_PORT_GLOW__()` → `{ bound, active, targets, buttons, paints, pointer }` | `browser-check`（BROWSER_DEBUG=1 时打印，用来分清「没绑定 / 没触发 / 画了但没量到」） |
| 图片编辑工作台（v1.26） | 根 `role="dialog"` + `aria-label="图片编辑"` + `data-fisherai-image-studio="editor"`；工具 `data-fisherai-image-tool="crop\|mask\|brush\|compose"`；保存 `data-fisherai-image-save="studio"`（aria-label「保存为新图片」）；撤销/重做 aria-label「撤销编辑」「重做编辑」；版本 `data-fisherai-image-version`；尺寸 `data-fisherai-image-dimensions`；状态 `data-fisherai-image-status`；素材项 `data-fisherai-image-source="<节点id>"` | `test:canvas-ui`、`browser-check` image-editor / image-saved 场景 |
| 裁剪舞台（v1.26） | 根 `data-fisherai-image-workbench="crop"`；选区画布 `data-fisherai-crop-canvas`（aria-label「裁剪选择区域」）；比例 `data-fisherai-crop-ratio="Original\|Free\|1:1\|…"` + `aria-pressed`；保存 `data-fisherai-image-save="crop"`（「应用裁剪」） | `browser-check` image-editor 场景（真拖框 → 量 256×192） |
| 宫格裁剪舞台（v1.46） | 根 `role="dialog"` + `aria-label="宫格裁剪"` + `data-fisherai-image-workbench="grid"`；选区画布 `data-fisherai-crop-canvas`（aria-label「宫格裁剪选择区域」）；预设 `data-fisherai-grid-crop-preset="2x2\|3x3\|3x4\|4x3\|1x4\|4x1"` + `aria-pressed`；行列读数 `data-fisherai-grid-crop-columns` / `-rows`（+「减少/增加横向/竖向分割」）；间隙滑杆 `data-fisherai-grid-crop-row-gap` / `-column-gap`；比例 `data-fisherai-grid-crop-ratio` + `aria-pressed`；导出顺序 `data-fisherai-grid-crop-order="row\|column\|snake\|reverse"` + `aria-pressed`；导出序号 `data-fisherai-grid-crop-selection`（aria-label「导出格子序号」）；张数 `data-fisherai-grid-crop-count`；单格 `data-fisherai-grid-crop-cell`；保存 `data-fisherai-image-save="grid"`（aria-label=保存宫格裁剪，文案「保存 N 张」） | `test:canvas-ui`（结构契约）、`browser-check` image-grid 场景（真拖切线改单格尺寸 → 3×3 → 序号 1,3 → 保存出 2 个媒体节点） |
| 标注 / 蒙版舞台（v1.26） | 根 `data-fisherai-image-workbench="annotation"`；工具 `data-fisherai-annotation-tool="brush\|eraser\|rectangle\|circle\|arrow\|line"`；绘制区 `data-fisherai-annotation-canvas`（aria-label「标注绘制区域」）；颜色 `data-fisherai-annotation-color`；标准/遮罩 `data-fisherai-annotation-mask`；保存 `data-fisherai-image-save="annotation"`（aria-label 取 `saveLabel`：独立入口「保存」/ studio 内「应用编辑」） | `test:canvas-ui`、`browser-check` image-annotate 场景（真画一笔 → 「1 笔标注」） |
| 工作流节点面板（v1.28） | 左栏按钮 `aria-label="工作流节点"` + `data-fisherai-workflow-node-trigger`（**不再**接 `onAddClick` —— 那正是「点了像画布右键菜单」的根因）；面板根 `role="dialog"` + `aria-label="工作流节点"` + `data-fisherai-workflow-node-panel`（带 `data-fisherai-workflow-node-count`）；卡片 `data-fisherai-workflow-node-item="<工作流id>"` + `data-fisherai-workflow-node-cover-state="custom\|placeholder"`；封面 `data-fisherai-workflow-node-cover`（有图是 `<img>`，没图是 `="placeholder"` 的占位 div）；搜索框 `data-fisherai-workflow-node-search`（aria-label「搜索工作流」）；空态 `data-fisherai-workflow-node-empty`；提示条 `data-fisherai-workflow-node-notice="ok\|error"`；隐藏 file input `data-fisherai-workflow-node-cover-input` | `test:workflow-library`（jsdom 真点真传）、`verify:workflow-library`（真机：点开的是面板而不是 role=menu 的右键菜单、卡片封面有真高度、配图 POST/GET/DELETE 往返） |
| 工作流节点（卡片按钮 aria） | 「配图」「清除配图」；头部「刷新工作流清单」「关闭工作流节点」；底部与空态里的「打开工作流配置」 | `test:workflow-library` |
| 工作流配图接口（v1.28） | `GET /api/aifisher/canvas/workflow-covers`、`POST/DELETE /workflow-covers/<工作流id>`（body `{dataUrl}`）、`GET /workflow-covers/file/<文件名>`；索引落 `workflow-covers.json` + 图片落 `workflow-covers/`（都在画布数据目录，**不写**用户的工作流目录） | `test:workflow-library` 的 host 段（422/415/413/404 + 换图破缓存 + 孤儿文件） |
| 叠图控制条（v1.37） | 折叠宿主卡左下角：`[data-fisherai-stack-controls]`（带 `data-fisherai-stack-total` / `-position`，都是 1 基）、`[data-fisherai-stack-switch]`（aria-label「切换叠图（当前第 N/M 张，点击看下一张）」，Shift+点击 = 上一张）、`[data-fisherai-stack-badge]`（「展开」，语义与位置没变）；叠图数据仍是宿主节点上的 `stackItems` + 新增的 `stackPosition` | `test:stack`（纯函数 + 真点）、`browser-check` stack 场景（`elementFromPoint` 命中按钮 + 三下切换 + 节点数不变） |
| 扩图面板（v1.38 起，v1.39 改两步） | 节点工具条 `[data-fisherai-outpaint-trigger]`（aria-label=扩图、aria-expanded）—— 工具条容器 `zIndex:110`（节点 composer 是 `z-[100]`，不提就会被它盖住）；面板 `role="dialog"` + `aria-label="扩图"` + `[data-fisherai-outpaint-panel]`（带 `data-fisherai-outpaint-model`）；比例 `[data-fisherai-outpaint-ratio="16:9"]` + `aria-pressed`；原图位置九宫格 `[data-fisherai-outpaint-anchor="top-left\|…\|bottom-right"]` + `aria-pressed` + `aria-label=原图位置 <左上…>`；延展内容 `[data-fisherai-outpaint-content]`（aria-label=延展内容）；预览 `[data-fisherai-outpaint-preview]`（带 `data-fisherai-outpaint-preview-size="427x240"`）+ 里面的 `[data-fisherai-outpaint-preview-image]`（`style.left/width` 是百分比）+ 读数 `[data-fisherai-outpaint-preview-caption]`；模型读数 `[data-fisherai-outpaint-model-name]`；主按钮 `[data-fisherai-outpaint-create]`（aria-label=生成扩图画面）；状态 `[data-fisherai-outpaint-status="error\|empty"]`。**工具条里不再有 `button[aria-label="AI 高清放大"]`** | `test:outpaint`（纯函数 + 真点：两张节点 + 扩图画面真落盘 + 一条生成请求都不发）、`test:canvas-ui`、`browser-check` outpaint / outpaint-panel 场景（真机解码出 427×240、留白透明、按钮 center 命中面板） |
| 尺寸对话框（v1.38） | 根 `role="dialog"` + `aria-label="调整图片尺寸"` + `[data-fisherai-image-resize]`（portal 进画布容器、`fixed z-[12000]` 按画布 rect 定位）；输入 `aria-label` = 图片缩放滑块 / 图片缩放倍数 / 图片宽度 / 图片高度；快捷倍率 `[data-fisherai-resize-preset="0.5\|1\|2\|4"]` + `aria-pressed`；读数 `[data-fisherai-resize-dimensions]`（`data-original` / `data-target`，形状 `320x240`）；保存 `[data-fisherai-image-save="resize"]`（aria-label=保存尺寸图片）；关闭 aria-label=关闭尺寸。同一时刻页面上只能有一个「调整图片尺寸」 | `test:canvas-ui`（结构契约）、`browser-check` resize 场景（真 2x → 保存后的图自然尺寸 640×480） |
| 项目归档面板（v1.42） | 头部入口 `[data-fisherai-project-archive-trigger]`（aria-label=项目归档，紧挨「返回项目库」）；面板根 `role="dialog"` + `aria-label="项目归档"` + `[data-fisherai-project-archive="panel"]`（带 `data-fisherai-project-archive-project="<项目id>"`）；规模读数 `[data-fisherai-project-archive-info]`（文本含「N 个节点」与「素材 M 个」）；导出目录输入 `aria-label="导出目录"` + `[data-fisherai-project-archive-dir]`；按钮 aria-label = 导出到目录 / 下载备份 / 打开导出目录 / 保存导出目录 / 恢复默认导出目录；导入按钮 `aria-label="导入项目文件"` + `[data-fisherai-project-archive-import]`，路径输入 `aria-label="本机备份路径"` + `[data-fisherai-project-archive-path-input]`，`aria-label="从路径导入"`；提示条 `[data-fisherai-project-archive-notice="ok\|error"]`；隐藏 file input `[data-fisherai-project-archive-input]`；页面级提示 `[data-fisherai-project-archive-toast="ok\|error"]`（看板视图用，面板不在那儿）；项目看板头部 `[data-fisherai-project-import="true"]`（aria-label=导入项目） | `test:project-archive`（jsdom：真点导出落盘 / 真上传导入 / 从路径导入 / 看板导入）、`browser-check` archive 场景 |
| 项目归档接口（v1.42） | `GET /workflows/<id>/backup`（下载形态，`Content-Disposition` + RFC 5987 文件名）、`GET /workflows/<id>/backup/info`（规模预览，只 stat 不读内容）、`POST /workflows/<id>/backup/save`（body `{directory?}`，写本机目录，回执给绝对路径）、`POST /workflows/restore`（`application/json` body `{path}` = 本机路径；其它 Content-Type = 原始归档字节；旧版 `.json` 画布文档也认，回执带 `legacy:true`）。导出目录 = **素材下载目录**（`downloads.json`），且拒绝相对路径 / 指进素材目录 | `test:project-archive` 的 host 段（四种错误码 + 同名不覆盖 + 素材改写） |
| 项目数据目录面板（v1.43） | 挂在 **设置 → 存储** 分区（宿主 = vendor 那页的 `[data-fisherai-settings-page="storage"]`，与「下载目录」那张卡同一个 div）：根 `[data-fisherai-data-dir="panel"]`（带 `data-fisherai-data-dir-overridden="true\|false"` / `-restart`）；当前目录读数 `[data-fisherai-data-dir-current]`、默认目录 `[data-fisherai-data-dir-default]`、状态 `[data-fisherai-data-dir-status]`；输入框 `aria-label="项目数据目录"` + `[data-fisherai-data-dir-input]`；按钮 aria-label = 应用数据目录 / 恢复默认数据目录 / 刷新数据目录；勾选 `aria-label="复制现有数据"` + `[data-fisherai-data-dir-migrate]`；提示 `[data-fisherai-data-dir-notice="ok\|error"]`。**文案不许说「已切换」**：host 写指针、重启 DSH 才生效 | `test:data-dir`（jsdom：真开设置 → 存储 → 面板读数 → 相对路径报错 → 合法路径应用 → 恢复默认）、`test:data-dir` 的 host 段（五条边界 + 复制 + 重启语义） |
| 项目数据目录接口（v1.43） | `GET/POST/DELETE /api/aifisher/canvas/data-dir`；指针固定是 `<默认数据目录>/data-dir.json`；校验绝对路径 / 不是文件 / 不是当前或默认目录 / 不互为父子；复制只复制不覆盖；回执一律 `restartRequired` | `test:data-dir` |
| 节点搜索（v1.10，v1.44 修交互） | 面板根 `role="dialog"` + `data-fisherai-node-search-panel`（带 `-state` / `-active` / `-count` / `-query`）；输入框 `data-fisherai-node-search-input`；候选 `data-fisherai-node-search-item` + `data-command-id`；工具栏入口 `data-fisherai-node-search-trigger`；空态 `data-fisherai-node-search-empty`。**建节点是 Blender 式「新建并移动」**：确认（Enter / 点选）→ 节点落在光标处 → 跟随鼠标 → 下一次左键放下（这一次 pointerdown 由 vendor 桥吞掉）。派发的事件是 `fisherai:add-canvas-node`，`detail.place === true` 才跟随（工作流库等其它调用方不传，行为不变） | `test:node-search`（一次 Enter 只建一个节点、跟随位移、左键放下后不再跟手、↑↓ 一次一格）、`browser-check` node-search 场景 |

### 顶部重排（v1.36）：头部被画布盖住的老 bug、返回项目库、ComfyUI 胶囊左移、任务队列上移

用户 2026-10-17 原话：「在画布左上角添加返回项目库按钮；把右上角的 comfui 待启动移动到左边。
任务队列往上移；」

**看不见的根因**：改 shadcn 头部时把 vendor 那行 `z-50` 和 `bg-[var(--af-surface)]` 丢了，
只剩一个主题里根本不存在的 `bg-surface`。vendor 的 `#canvas-background`（不透明底、DOM 顺序
在 Header 之后）于是把整条头部盖住 —— 真机上 logo / 项目名 / 保存状态 / 品牌下拉**全都看不见也
点不到**，只剩自带 `z-index:70` 的 ComfyUI 胶囊浮在画布上。老回归量的是「盒子在不在」，
所以一直是绿的；browser-check 现在补了一条**命中测试**（`header.onTop`：在头部左端
`elementFromPoint`，命中的元素必须属于头部），再叠上「z-index 不是 auto」「底色不透明」两条。

落点：

| 要求 | 实现 |
|---|---|
| 左上角返回项目库 | 头部左侧第一个可交互件：`Button variant=ghost size=xs` + 左箭头 +「项目库」，`aria-label="返回项目库"`、`data-fisherai-back-to-library`，点击走 vendor 的 `onBack`（回项目看板）。不走品牌图下拉 —— 那个下拉以前正是被盖住的那块。 |
| ComfyUI 胶囊移到左边 | 头部左侧工具条加 `[data-fisherai-comfyui-slot="true"]`；`scripts/vendor-aifisher.mjs` 新增 3.8n 补丁（两条锚点）：`dockComfyPanel` 优先 `slot.append(host)` 并设 `dock='topbar-left'`、下拉面板改成贴着胶囊左缘向下展开；找不到左侧槽位才回落到账号插槽 / body。 |
| 任务队列往上移 | 面板 `top:60 → 8`、窄轨同步 `top:8`；两者都往画布容器写 `--fisherai-task-queue-inset`（展开 306px / 窄轨 44px），头部用它做 `padding-right`，把保存状态徽标让到面板左侧而不是被压在下面。 |

### 扩图（v1.38 起，v1.39 改成「先出一张图，再接生成节点」）

用户原话（2026-10-17 v1.38，附一张图片节点工具条的截图，指着 HD 按钮）：「把这个功能移除，替换成扩图功能；
还有一点，这里的功能点击生成后模型走的是之前的通道。做一个调整，点击生成后不直接生图，
先输出一个空的图像生成节点，填好提示词，由我来点击最后的生成；尺寸节点的ui还没有更新」。

用户原话（2026-10-17 v1.39，附两张参考图：一张是带「目标比例 / 原图位置 / 延展内容」的扩图面板，
一张是画布上「原图 → 扩图画面 → 扩图 · 21:9」的节点链）：
「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」。

- **被替换的东西**：`AI 高清放大 · SeedVR2`（上游把图传 RunningHub、写死 `SeedVr2ImageProvider`、
  点了**直接出图**）。本插件没有这条后端，也不该替用户走一条他不认识的通道 —— 整条拆掉，
  连模型目录里那条 `SeedVR2 高清放大 · RH` 一起删（vendor 补丁 **3.8p**）。
- **两步两节点**（与参考图一致）：
  1. **先出图**：`window.__FISHERAI_OUTPAINT__.prepare()` 在浏览器里把原图画进一张更大的画布
     （目标比例 + 九宫格位置，延展区是**透明**），PNG dataURL 交给 host 现成的
     `POST /media/images/annotation` 落进素材库，画布上多一张真实图片节点，标题 **「扩图画面」**；
  2. **再接生成节点**：新建一个**空的** Image 节点，标题 `扩图 · <比例>`，`imageMode=image-to-image`、
     提示词已填（含用户写的延展内容）、参考图连的是那张扩图画面、`status:'idle'` ——
     真正的生成仍由用户在节点上点（v1.38 那条口径不变）。
- **几何/算法**（`src/canvas-ui/canvas/CanvasOutpaint.ts`，纯函数）：
  `outpaintGeometry({width,height,ratio,anchor})` 只朝一个方向长（目标更宽就补宽、更高就补高），
  原图一个像素都不重采样；九宫格决定原图贴在画布哪一侧、哪几边是新画面；超过 4096 才整体等比缩。
  提示词由 `pad` 反推措辞（向四周 / 向左右两侧 / 只向画面右侧…）。
- **分工**：面板在工具条覆盖文件里；装配层 `bootstrap.ts` 注册 `__FISHERAI_OUTPAINT__`
  （`model()` / `preview()` / `prepare()` / `report()`，负责画像素）；vendor 补丁 3.8p 只留
  「存素材 + 建两张节点 + 连线 + `setNodes`」那层壳（只有 canvasApplication 够得着 setNodes）。
  **host 半没动**，所以改这一块只刷新画布页即可。
- **三条口径**（改它之前先读 CanvasOutpaint.ts 的头注释）：
  1. **不直接生图** —— 生成节点 `status: 'idle'`，不写 `loading`、不发 `/generate-*`；生成只能由用户点；
  2. **模型跟着通道走** —— 优先 `cloudChannelId` 标记的通道模型，不再写死 Relay 旧通道
     （「角度 / 全景图」的草稿也改成同一个选择口径，见覆盖文件 `imageAngleDraft.ts`）；
  3. **提示词真的写进节点** —— 一句可读中文（只延展、不重绘、无缝衔接、目标比例），
     遵守 v1.34「看到什么就发什么」。
- **面板**：目标比例（模型支持的比例表，顺序照参考图两行）、原图位置九宫格、延展内容（可空）、
  左侧预览（原图按目标比例/位置摆在棋盘格上，虚线框 = 原图边界），底部一条「先出扩图画面，
  再接一个图像生成节点；生成由你点」。工具条容器 `zIndex:110` —— 节点 composer 是 `z-[100]`，
  不提就会被它盖住（v1.39 真机截图取证：面板只露出上半截）。
- **顺带修的两处**：`onPanorama` / `onAngle` 原来建完草稿紧跟 `void handleGenerate(...)`（自动生图），
  已删；面板按钮语义改成「创建全景图节点 / 创建角度节点」，`ImageToolGenerateButton` 也不再显示
  一个基于旧通道的假报价。

### 尺寸对话框（v1.38）：换壳不换像素

用户原话：「尺寸节点的ui还没有更新」。上游 `canvasImageResize` 是**整屏浮层**（`fixed inset-0` +
原生 range + 手写样式），与 v1.26 之后的图片编辑族不是一套视觉语言。

- 换成 `src/canvas-ui/canvas/CanvasImageResize.tsx`（`Resize` 槽位，模块级 `bindView` 一次），
  nova 紧凑卡片：倍数滑杆 + 数字、快捷倍率 0.5x/1x/2x/4x、宽/高输入、预览 + 「原图 → 目标」读数。
- **像素语义一字没动**：换算仍 import vendor 的 `resizeDimensions` / `resizeLimit`
  （改一边按比例推另一边、16384px 与 6400 万像素上限），保存仍走 `saveResize`
  （`POST /assets/images` → 画布上新建一张图）。
- 定位用 `useCanvasOverlayBox`（量画布容器 rect），**不要用 `fixed inset-0`** —— 与 v1.26 的坑同源。

### 叠图「切换」（v1.37）：不展开也能翻看折叠起来的每一张

用户 2026-10-17 原话（附一张「3 张叠图 · 展开」的画布截图）：「给这种折叠起来的图添加一个切换按钮」。

v1.21 的折叠把选中的图从文档里摘进宿主节点的 `stackItems`，但卡上永远只看得见宿主那一张，
想看下面几张只能「展开」→ 看完再重新多选折叠。现在左下角那条徽章扩成控制条：

```
[3 张叠图] [切换 2/3] [展开]
```

点「切换」= 把叠里的下一张**提成宿主卡**（环形；Shift+点击往回翻），计数跟着走。

两个实现取舍（改它之前先读）：

1. **换内容，不换渲染**。内容字段（标题 / 提示词 / 结果图 / 模型 / 参数 / 状态…）与被提上来的那张
   整组交换，壳字段（`id` / 位置 / 类型 / 尺寸 / `parentIds`）不动。理由：
   - id 不动 ⇒ 连线、生成结果、任务队列、素材引用还指着同一个节点；
   - 位置不动 ⇒ 卡不跳；
   - 真换内容 ⇒ 「看到什么就发什么」（v1.34）不用破 —— 切到第 2 张后点生成发的是第 2 张的提示词。
2. **算法不在 vendor 里**。`rotateStackHost` 是纯函数（`src/canvas-ui/canvas/CanvasStack.ts`），
   由装配层注册成 `window.__FISHERAI_STACK_ROTATE__`；vendor 补丁 3.8o 只留
   `__FISHERAI_CANVAS_STACK__.rotate(hostId, step)` 三行壳（只有 `canvasApplication` 够得着
   `setNodes`）。这样回归可以直接在产物上单调算法，真点击那条只验接线。

`stackItems` 的顺序语义是「**下一个**在前」（`[下一张, 再下一张, …, 上一张]`）：往回拨之后
仍然要成立，否则「往回拨一次、再往前点」方向就反了（看着像按钮时灵时不灵，`test:stack` 钉了这条）。

### 任务队列只在画布这一层 + 新对话输入区贴底（v1.41）

用户 2026-10-18 原话：「任务队列希望只出现在画布这一层，现在点击设置啥的都看的见任务队列；
右侧聊天面板新对话默认会顶头不好看，希望移动到最地下。」

**① 任务队列浮在设置上面**

- 面板是 `position:absolute; right:12; top:8` + `z-[11000]`，portal 进画布容器 —— 看着像画布的一部分，
  但它**不在画布应用的 DOM 里**，所以画布层的浮层不会自动盖住它。
- vendor 的接管型浮层（设置 `z-[100]` / 媒体预览 `z-[100]` / 资源库 `z-50` / 裁剪·标注·尺寸·比较·
  组合·角度 `z-[1000]`…）里只有工作流配置（11900）/ 工作流节点（11950）/ 节点搜索（12000）碰巧更高，
  于是只有前者那几处露馅。
- 修法是**顺着 vendor 已有的 modal 契约**：这些浮层全部经 `design/modalFocus.ts` 的
  `activateModal()` 打开，它沿浮层路径给所有兄弟节点加 `inert`（关闭时按基线还原）。面板是画布容器的
  直接子节点 → 浮层一开它就被 `inert` 命中，于是一条 CSS 就能表达「画布层被压下去时，面板跟着下去」：

  ```css
  [data-fisherai-task-queue][inert] { display: none !important; }
  ```

  为什么不是别的做法：
  - 不用「按浮层选择器逐个登记」：vendor 有十几个浮层、以后还会加，清单一定会漏；
  - 不用「把 z-index 降到浮层下面」：`--af-overlay` 是半透明 + `backdrop-blur`，降下去会**透出来**；
  - `inert` 本身只禁交互**不隐藏**，所以必须显式 `display:none`。

**② 新对话输入区顶在栏头下面**

- 会话正文结构：`[data-conversation-content] > [data-conversation-scroll] > (Views, [data-composer-seat])`，
  scrollBody 是 flex column。**空白会话的 Views 直接 `return null`**（内核 `DefaultConversationViews`），
  而本栏刻意固定 `phase:'active'`（不渲 hero 那一大坨标题），拿不到内核 hero phase 的 `justify-content:center`。
  active phase 只让 `.viewArea{flex:1 0 auto}` 撑高 —— 空白会话连 viewArea 都没有，于是滚动区里只剩
  一个 `flex:none` 的 composerSeat，它自然贴在顶部（`sticky bottom:0` 在没有溢出时不会把元素往下推）。
- 修法：给 composerSeat 一条 `margin-top:auto`。空白会话 → 推到最底；有正文的会话 → `.viewArea`
  已经吃掉剩余空间，`auto` 解析成 0，滚轮与粘底一个字不变。
- 为什么不用 `justify-content:flex-end`：可滚动 flex 容器里它会让溢出到顶部的内容滚不到（Chrome 老问题）；
  auto 外边距在没有剩余空间时恒为 0，天然安全。

**真机验法**（这两条 jsdom 都量不了）：`browser-check` 的 `queue-layers` 场景量 `display` / `inert` /
`elementFromPoint`；`scripts/verify-live-dock.mjs` 用真会话的**真实 class** 起一个空白会话骨架做 A/B
（带本栏样式 → 贴底；临时摘掉 `style[data-dsh-aifisher-canvas="dock-layout"]` → 复现顶头）。

### 项目归档（v1.42）：导出 / 导入为什么做成一个面板

用户 2026-10-18 原话：「在无限画布面板做一个项目导出导入的功能」。

**之前有什么、缺什么**：host 侧早就有 `GET /workflows/<id>/backup`（下载）与
`POST /workflows/restore`（导入）—— v1.1 就补了；但画布上**没有出口**：导出只有 agent 桥那一条
（`projectRuntime.download`，界面上点不到），导入埋在品牌下拉的「导入项目 JSON」里、点了直接弹一个
file input —— 导完有没有成功、素材带没带过来、文件存到哪了，用户一概看不见。

**做成面板的三个理由**（也是这一版的设计口径）：

1. **导出/导入是一对「有状态」的动作**，不是一次点击：导出要告诉你「多大 / 存到哪 / 存好了没」，
   导入要告诉你「导进来几个节点、几张素材、缺了什么」。直接触发浏览器下载/上传会把这些全吞掉。
2. **大文件不该过浏览器内存**：`.fisherai` 里素材是 base64，512 MiB 上限的归档过一次浏览器
   下载（`a[download]`）在 Electron/无头环境下行为还不一致。所以主路径是 host 直接落盘
   （`POST /workflows/<id>/backup/save`），回执给**绝对路径**，面板上一键「打开目录」；
   浏览器下载作为备用按钮保留，并在不支持时明确指路（不静默失败）。
3. **导入必须能「当场看到结果」**：host 回执带 `title/nodeCount/mediaRestored/mediaMissing`，
   面板/看板都把它变成一句话（`已导入「X」（12 个节点；素材 8 个已恢复）`），并立刻切到新项目。

**两个入口**（面板都挂在 Controls 槽位，看板视图里它根本没挂载）：

| 入口 | 位置 | 实现 |
|---|---|---|
| 画布头部「项目归档」 | 头部左侧、紧挨「返回项目库」 | `requestCanvasProjectArchive()`（模块级 store）→ 面板 |
| 项目看板头部「导入项目」 | 看板头部工具栏，设置按钮与「新建项目」之间 | vendor 补丁 3.8r 用 DOM 注入按钮，点击调装配层注册的 `window.__FISHERAI_PROJECT_ARCHIVE__.importFromPicker()`（看板里没有面板，只能走这条桥） |

**导入完成后怎么切项目**：`openProject`（`loadProject` + `setView`）只活在 vendor 的
`canvasApplication` 里，所以 3.8r 只加了一个 `fisherai:open-project` 监听，面板派发事件即可
（也顺带让 jsdom 回归能真跑一遍「导入 → 画布切过去」）。

**导出目录** = 素材「下载」用的那个目录（`downloads.json`，默认 `<画布数据目录>/downloads`）。
不为项目导出另开一份设置：用户只需要理解「下载/导出的东西都落到这一个目录」。
边界：只收绝对路径；不许指进 `<画布数据目录>/media/**`（会和素材混在一起）；同名不覆盖（`名字 (2).fisherai`）。

**已知取舍**：导入 = **新建一个项目**（永不覆盖现有项目），所以不会误伤；代价是同一个备份导两次会有
两个副本。切到新项目前不强制保存当前项目（vendor 自己的「退出项目」也不保存，只有 5s 自动保存兜底）——
想稳妥就先 Ctrl+S。

### 项目数据目录（v1.43）：一个「写指针 + 重启生效」的设置项

用户 2026-10-18 原话：「设置里添加项目自定义缓存目录」。

插件的数据（项目、素材、资产库、通道表/密钥、工作流目录、下载、画布背景）原先**固定**在
`$DSH_HOME/storages/dsh-aifisher-canvas/`，界面上没有入口 —— 想换盘只能整目录搬 + 动环境变量。

**为什么不热切换**（这是这个功能唯一值得解释的决定）：所有 store 都在 `apply()` 里按目录构造好了
（canvas.json 已读进内存、mediaStore 定了 `rootDir`、工作流目录缓存、通道表、下载设置…），
运行时换目录要么到处漏、要么逐个重建。换目录本身是低频操作，所以选**写指针 + 重启**：
接口一律回 `restartRequired`，面板文案只写「重启一次 DSH 之后生效」，**不说「已切换」**。

**指针文件为什么在默认目录里**：它必须「数据搬走之后还找得到」。默认目录永远由 `$DSH_HOME` 算得出来，
而把指针放进目标目录就自指了（换个目标就读不到自己）。所以 `<默认数据目录>/data-dir.json` =
`{directory, savedAt}`，`resolveDataDir()` 读它、校验目录存在才认。

**「项目数据目录」这一栏与「下载目录」共用同一个宿主 div**：vendor 的存储页只有一个
`[data-fisherai-settings-page="storage"]`，`mountMediaDownloadSettings(host, …)` 往它里面 append 一张卡。
我们的面板在它后面再 append 一张（纯 DOM，见 `CanvasDataDirPanel.ts`），并且**把两个 disposer 串起来**
交给 `pageDisposeRef` —— 只赋一个会漏掉另一个（切分区后留下孤儿面板）。

**校验**（都在 host，前端只转话）：绝对路径 / 不是文件 / 不是当前或默认目录 / 不与它们互为父子；
复制只复制不覆盖（同目录再应用一次是幂等的）。复制**不删旧目录**：随时能切回来。

### 工作流节点面板（v1.28）：根因、配图落点、点卡片怎么落节点

**根因**（用户原话「左侧工作流节点做错了，点击后是在画布右键的样子」）：左栏那个按钮被接到了
`onAddClick` —— 也就是「添加节点」的处理器：

```ts
// vendor canvas/canvasContextHooks.ts
handleToolbarAdd = (event) => setContextMenu(adapter.openCanvasMenu('global', rect.right + 10, rect.top));
```

`openCanvasMenu('global', …)` 就是画布右键菜单的那一份，所以点「工作流节点」看到的是右键菜单。
修法是把它接到自己的面板（`requestCanvasWorkflowLibrary()`）；**不要**回落到 `onAddClick`
（那正是 bug 本体），`CanvasSidebar` 里 `onWorkflowNodesClick` 缺省时点了就不动。

**配图为什么不写进工作流的 meta 侧车**（`<名字>.meta.json`）：

1. meta 是用户手写、可能放在自己的 ComfyUI 导出目录里的可读配置，塞 base64 会把文件撑爆；
2. 工作流目录 v1.18 起可自定义，且约定「用户自己指的目录只读不写」；配图是**外观**，
   不该往那里扔文件；
3. 配图按工作流 id（`custom-<文件名 slug>`）索引在画布数据目录里 → 换目录、改 meta 都不丢图。

落点：`workflow-covers.json`（id → 文件名/字节/时间）+ `workflow-covers/<sha1(id)>.<ext>`。
索引条目带 `updatedAt`，对外 URL 是 `…/file/<文件名>?v=<updatedAt>` —— 换图靠这个 `?v=` 破缓存
（文件名是 sha1(id)，换图不换名）。写索引失败时会把刚落盘的图删掉，不留孤儿。

**点卡片怎么落节点**：面板在 `src/canvas-ui` 里，拿不到画布的 node store，所以沿用节点搜索那条路
（`fisherai:add-canvas-node`，vendor 的 `canvasNodeState` 监听）：

```js
new CustomEvent('fisherai:add-canvas-node', { detail: { type: 'ComfyUI', comfyMode: <工作流id>, point } })
```

前提是这份工作流已经进了 `canvasNodeRules.workflowTemplates`（`ensureLocalWorkflows()` 推的），
否则 `updateCanvasNode` 找不到模板、`comfyMode` 会被丢掉 —— 所以面板打开时会顺手 `ensureLocalWorkflows()`。

**节点头部的小图**：`canvasLegacyWorkflowNode` 头部那枚 22px 的图改用 `definition.coverUrl`
（没配图仍是品牌标，`data-fisherai-local-workflow-cover="custom|brand"`）。只换 `src`/圆角，
**不动**任何槽位几何（`SLOT_TOP=142` 那套和连线端点对齐，动一个像素线就歪了）。

### 任务队列面板为什么自己能滚

画布的 vendor 在 `document` 上装了「画布永不滚动」的监听，所以面板里的滚动容器必须用
**原生 `overflow-y-auto` div** 并在 `onWheel` 里对非 ctrl/meta 的滚轮 `stopPropagation()`
（和 `ComfyWorkflowConfig` 同一个护栏）。不要换 Radix `ScrollArea`：它 viewport 里的
`display:table` 包裹层会把行顶出面板。

### 图片编辑族（v1.26）：为什么只换壳、几何仍用上游

`Annotation` / `Crop` 两个槽位换成了 `src/canvas-ui/canvas/` 里的实现，但**几何与像素一律
import vendor 的纯函数**：

```
dialogs/imageCropGeometry       centeredCrop / createCrop / resizeCrop / moveCrop
                                hitCrop / cropHandles / cropOutputRects / cropRatio
dialogs/imageAnnotationDrawing  renderAnnotations（含遮罩的 destination-out）/ AnnotationStroke
```

理由：这两块是「像素语义」——选区边界、20px 把手命中、出口尺寸、标注点存源图像素
（`image.naturalWidth` 坐标系）、遮罩出口，上游已经在真机上跑了很久；重写一份只会引入偏差，
而用户要的是**外观与手感**。所以分工是：

| 部件 | 谁实现 | 说明 |
|---|---|---|
| 图片编辑首页（工具 / 版本 / 素材 / 保存） | canvas-ui `CanvasImageStudio.tsx` | mode==='editor'；versions 时间线（上与上游同款：past/present/future + 50 上限） |
| 裁剪舞台 | canvas-ui `ImageCropStage.tsx` | 单帧裁剪 + 7 个比例；宫格切线在宫格舞台 |
| 宫格裁剪舞台（v1.46） | canvas-ui `ImageGridCropStage.tsx` | 宫格预设 / 切线拖动 / 间隙 / 导出顺序 / 导出序号；`exportGridPieces`（`imageWorkbench.ts`）负责切图与白底 |
| 标注 / 蒙版舞台 | canvas-ui `ImageAnnotationStage.tsx` | 6 个工具、8 个常用色、粗细/不透明度、缩放平移、Ctrl+S/Z |
| 独立标注器（节点工具条「标注」） | canvas-ui `CanvasImageAnnotation.tsx` | 复用同一个舞台，多一个「标准 / 遮罩」切换 |
| 全景 / 角度 / 生成全景 | **vendor** | 依赖 three.js 全景球采景与角度草稿，`mode !== 'editor' && mode !== 'grid'` 时整棵树交回 `Components.ImageCrop` |
| 组合（多图层） | **vendor** `CompositePreview` | 工作台只负责以选中的素材唤起它 |

两个坑（都在 `imageWorkbenchOverlay.ts` 的注释里）：

1. **不要用 `fixed inset-0` 做整块浮层**：浮层 portal 到 `.af-canvas-mount`，而 DSH 那条容器链路上
   可能有 transform/filter（会变成 fixed 的包含块）。实测 `inset-0` 量出来 1416×808（窗口是 1440×900）
   —— 左边压住 DSH 侧边栏、右边留缝。改成「量画布容器的 rect + ResizeObserver」后是 1176×808 严丝合缝。
2. **工作台里不要用 Radix 的 Select / Popover**：它们的 content 也 portal 到画布容器（z-50），
   会成为工作台（z-12000）的兄弟节点 → 下拉永远被盖住。比例改用普通按钮组，取色用原生 `input[type=color]`。

标注的指针处理有一个必须保留的细节：`setPointerCapture` 用 try/catch 包着 —— 合成事件
（回归/真机脚本派发的 PointerEvent）没有真实指针，捕获会抛 `NotFoundError`，真实鼠标不会。

#### 宫格裁剪（v1.46）：只换壳，切图语义一字没动

用户 2026-10-19 原话：「画布宫格裁剪ui还没有更新」。v1.26 换图片编辑族时，`mode !== 'editor'`
整棵交回 vendor，于是宫格裁剪（工具条里每天都点得到的那个）还是上游那圈「胶囊里塞 fieldset +
原生 select + 手写 range」的外观。

- **新舞台** `ImageGridCropStage.tsx`：header / toolbar / stage / footer 四段，与 `ImageCropStage`
  同一套变量与间距；工具条两行 —— 第一行宫格预设（2×2…4×1）+ 横向/竖向分割步进器 + 恢复等分 + 比例，
  第二行上下/左右间隙滑杆 + 导出顺序 + 导出序号。**顺序改用按钮组，不用 Radix Select**
  （见上面第 2 条坑）。
- **切图语义复用上游**：`cropOutputRects`（切线/间隙 → 源图像素）、`moveCropCut`（切线拖动的
  24px 最小间距）、`equalCuts`、`gridExportIndices`（顺序 + `1,3,5-8` 语法 + 错误文案）。
  真正落像素的是 `imageWorkbench.ts` 的 `exportGridPieces`：**行优先出一遍，宫格时每块先铺白底**
  ——与上游 grid 分支逐条对齐，导出顺序由调用方再重排（`row`/`column` 保留原位，画布按它排节点）。
- **默认态改了**：上游打开是 1×1 + 居中 80% 选区（要先挑预设才看得到格子），nova 版默认
  **2×2 + 选区铺满整张图**；改行列数仍走「重新等分 + 铺满原图」（与上游 `restoreGrid` 一致）。
- **能力一个不丢**：拖切线微调单行/单列、间隙（源图像素 0–100）、逐行/逐列/蛇形/倒序、
  导出序号、恢复等分、比例锁定、保存后每格成为画布上的一张图（`useCanvasCropSave` 原样）。
- 全景 / 角度 / 生成全景仍交给 vendor：它们要 three.js 的全景球与角度草稿，不是同一类画面。

## 四、怎么改 / 怎么验

```bash
pnpm sync:shadcn          # 重新拉 shadcn registry 组件（幂等）
pnpm build                # clean → vendor → build:css → tsdown
pnpm test                 # 29 套（含 test:canvas-ui、test:workflow-library 与 verify:ui）
node scripts/browser-check.mjs   # 真机几何/视觉（需本机 Chrome；25 场景）
node scripts/verify-live-dock.mjs   # 真机验收右侧会话栏（滚动契约 + v1.41 输入区贴底 A/B）
node scripts/verify-live-workflow-library.mjs   # 真机验收「工作流节点」面板 + 配图（需 DSH 在跑）
```

- 改 shadcn 组件源码前先跑 `pnpm sync:shadcn` 看有没有上游更新；
  `scripts/sync-shadcn-ui.mjs` 的两处自动改写（`cn` 路径、Portal 容器）**不要手工回退**。
- 组件清单在 `scripts/sync-shadcn-ui.mjs` 的 `COMPONENTS` 里，加减后重跑即可。
- 新增/替换视图槽位时，照 `stage.tsx` 的 `viewInjections` 写：对象形状、
  `(react, props, ...injected)` 签名、在装配层 `bindView` 包一层。

## 五、这一波没做的（后续可分批）

- 节点框与节点工具条（`nodes/canvasNodeFrame.tsx`、`canvasMediaToolbar.tsx`）仍是上游外观
  —— 工具条本轮只做了功能（拿掉 HD、加扩图面板），视觉还是上游那一套；
- 其它对话框（设置 / 素材库 / 历史 / 保存…）仍是上游外观；
  —— 图片编辑 / 裁剪 / 标注 / 独立标注器已在 v1.26 补完（见上）；
  —— 「尺寸」对话框已在 **v1.38** 换成 nova 版（见上）；
  —— **宫格裁剪**已在 **v1.46** 换成 nova 版（见上）；全景 / 角度仍走上游；
  —— 「组合」仍是上游实现
     （多图层编辑器：拖放/缩放/层级/布局序列化，值得单独一轮）；
- 画布右键菜单的 DOM 仍在 vendor（只换了观感，未换 shadcn 组件）；
- DSH 侧的画布面板外壳（`src/client/CanvasPanel.tsx`、`PanelExitButton`）仍用内联样式；
- 项目工作台（`Projects`）与设置对话框属"外壳/大屏"页面，未纳入本波。
