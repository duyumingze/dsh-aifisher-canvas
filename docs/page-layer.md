# 页面层（项目库 / 设置）— v1.85（v1.86 修「点两次才进画布」）

> 对象：`dsh-aifisher-canvas` v1.86.0
> 设计稿：`E:\AllAssets\项目\画布UI改版\pages\`（`projects-1/2.html`、`settings-1/2.html` + 各自的 CSS）
> 用户拍板：2026-10-30「无限画布ui设计要包含设置页、图像编辑页、扩图页的等。还有项目管理页」；
> 2026-10-31「置灰 + 「设计稿」小标签，只有真实现的能点」「侧栏设置直接开新设置页」；
> 2026-10-31「现在打开画布它的项目管理是旧的；移除设置里的旧版设置」——
> 于是 v1.85 把**打开画布的首屏换成项目库**、把**旧版设置对话框整块移除**（面板搬进设置页）。

---

## 一、这两屏是什么

| 屏 | 入口 | 主体 |
|---|---|---|
| 项目库 | **打开画布即首屏**（vendor 看板不再露出）；项目内点顶栏「← 项目库」 | 左栏（视图 / 筛选 / 存储）+ hero「继续编辑」+ 卡片墙（默认）或 列表 + 右侧详情 |
| 设置 | 项目库右上角齿轮 / 画布左侧工具条「设置」 | 左导航（搜索 + 三组）+ 五段分组表单（外观 / 生成 / **服务与通道** / 项目与数据 / 高级与关于） |

两屏都是**画布容器的兄弟图层**：`mount.tsx` 里与生成批次卡、整页扩图并排渲染，
内容 portal 到 `.af-canvas-mount`，按 `useCanvasOverlayBox()` 量出的画布矩形铺满
（实测 1182×804，与容器 100% 对齐）。所以画布还在下面活着 —— 打开项目只是
`openProjectById()`（派发 `fisherai:open-project`），不刷新 DSH 页面。

同一时刻只开一屏，由 `src/canvas-ui/canvas/CanvasPagesStore.ts` 管：

```ts
openCanvasPage('projects' | 'settings', section?)   // 每次打开 key+1（页面据此重置搜索/视图）
closeCanvasPage()
installCanvasPagesBridge()                          // window.__FISHERAI_CANVAS_PAGES__
```

**首屏看门**在 `src/client/canvas/homePage.ts`（`mountCanvas` 里、`root.render` 之前装）：

1. vendor 一回到看板（打开画布、点「退出项目」）而页面层没开任何一屏 → 立刻开项目库；
2. 带 resume（`fisherai.canvas.resume.v1`）时**先等**：vendor 启动瞬间也是 dashboard，
   等 `#canvas-background` 出现（恢复成功）或 session 被清掉（恢复失败）才判断，
   否则刷新页面会永远停在项目库、回不到上次的画布；
3. vendor 唯一开设置的路 `fisherai:open-settings`（看板「设置」按钮 / `openSettings()`）
   被拦下来（`stopImmediatePropagation`），改开页面层设置页并落在「服务与通道」；
4. **打开项目时不早关**（v1.86）：点「打开画布」只是派发 `fisherai:open-project`，
   vendor 还要走一次 `loadProject` 才 `setView('canvas')`。这中间要是先把项目库关掉，
   上面第 1 条会立刻把项目库重开一遍（看起来像「第一下只是重新激活了项目管理器」）。
   所以项目库等到 `#canvas-background` 真的出现再关（`enterCanvasWhenReady`），
   `homePage` 再按 `fisherai:open-project` 加一道 5s 时间窗兜底。

旧版设置对话框里的面板一个没丢，全部改成**页内宿主**（`data-fisherai-settings-host=<id>`）：
开源服务、闭源服务、自定义通道在「服务与通道」；下载目录与项目数据目录在「项目与数据」；
检查更新（桌面版才有）在「高级与关于」。个人资料（昵称 / 头像）也搬进「高级与关于」。

---

## 二、数据面：`/api/aifisher/canvas/projects*`

`src/host/canvas/projectsRouter.ts`。为什么不直接扩 `/workflows`：那是 vendor dashboard 的契约，
而且这份列表每项都要 stat 素材目录、扫节点包围盒、读 sidecar 模型名，比 `/workflows` 贵一个量级。

| 接口 | 说明 |
|---|---|
| `GET /projects` | 全部项目 + 存储读数（`projects[] / folders[] / storage / generatedAt`） |
| `GET /projects/<id>` | 单项详情 + `recentImages[12]` + `recentVideos[4]` |
| `POST /projects` | 新建空项目 `{title}` → `{id,title}` |
| `POST /projects/<id>/status` | `{status:'active'\|'archived'}`（归档） |
| `POST /projects/<id>/favorite` | `{favorite:boolean}` |
| `POST /projects/<id>/note` | `{note}`（项目备注） |
| `POST /projects/<id>/duplicate` | 文档 + 素材一起复制（素材走 `mediaStore.copyFrom`） |
| `DELETE /projects/<id>` | 文档删除 + 素材进 `media/trash/<id>` |

每个项目卡的字段（全部来自真实文件）：

- `nodeCount / groupCount / nodeTypes{image,video,audio,text,other}`
- `imageCount / videoCount / audioCount / mediaFiles / mediaBytes / documentBytes`
- `thumbUrl`（最新一张图；没有就退回文档 `coverUrl`）、`recent[]`（最近 4 张）
- `models[]`（素材 sidecar 里记过的模型名，去重）、`running`（生成日记里该项目 running 的任务数）
- `width / height`（节点包围盒；单节点按 340×500 估）
- `status / favorite / note / createdAt / updatedAt`

存储读数：`mediaBytes`（素材根下真实文件）+ `documentBytes`（`canvas.json`）+ `appearanceBytes`。

**归档不删任何东西**：只给文档写 `status:'archived'`（`store.patchDocument`，不动 revision ——
否则正在打开的画布下一次 saved 会撞 409）。

---

## 三、设置页的「真实 / 设计稿」分界

| 行 | 状态 | 落点 |
|---|---|---|
| 主题皮肤 | **玻璃面板可用**；精密仪器 / 暗房置灰 + 「设计稿」 | `src/client/canvas/skin.ts` |
| 界面缩放 | 可用（80/90/100/110/125/150，Ctrl+ = − 0） | `src/client/canvas/uiScale.ts` |
| 画布网格 | 「静态点阵」常驻 +「光标辉光」开关；A/B/C 置灰 | `CanvasEffectsStore`（localStorage） |
| 画布背景图 | 可用（选图 / 清除，≤20MB、≤4096²） | host `/appearance/background` |
| 本地 ComfyUI | 只读状态 + 地址 + 刷新 | host `/local-runtime/status` |
| 新建节点默认模型 | 读「上次用的模型」+ 忘记 | `CanvasLastModel`（v1.40 机制） |
| 并发生成数 | 置灰（现在是逐节点排队） | — |
| 生成中显示 V1/V2/V3 | 只有 V2 仪表（当前实现）；V1/V3 置灰 | `src/client/canvas/genDots.ts` |
| 生成中动效 G1/G2/G3/N1/关 | 只有 N1 噪波（当前实现）；其余置灰 | 同上 |
| 项目数据目录 | 显示真实路径 + 复制 + 「更换」滚到下方目录管理面板（可改，重启生效） | host `/data-dir` + 页内宿主 `data-dir` |
| 导出目录 | 显示真实路径 + 打开 + 「更换」滚到下载设置面板 | host `/media-download/settings` + 页内宿主 `downloads` |
| 自动保存 | 只读展示（vendor 自动保存常开） | `canvasAutoSave` |
| 开源服务 | **整页搬进「服务与通道」**（ComfyUI 目录 / 启动 / 扩展 / 日志） | vendor `mountLocalRuntimeSettings` + 宿主 `local-service` |
| 闭源服务 | **搬进「服务与通道」**（来源卡片 + 自定义通道） | vendor `mountSourceSettings` + 宿主 `source` / `channels` |
| 个人资料 | 昵称 + 头像（「高级与关于」） | `__FISHERAI_LOCAL_USER__` / `__FISHERAI_LOCAL_PROFILE__` |
| 检查更新 | 仅桌面版有（「高级与关于」），DSH 里宿主为空、自动隐藏 | vendor `mountLocalUpdateSettings` + 宿主 `update` |
| 高级 / 关于 | ~~打开旧版设置对话框~~（v1.85 移除）/ 跳到项目库 / 版本 | — |

页面上每个未接入的按钮都带一个 `<span class="afs-draft">设计稿</span>`，点不动；
这不是「还没写完」，是**故意不撒谎**（用户 2026-10-31 定的口径）。

---

## 四、结构契约（回归 / 真机检查依赖）

| 属性 | 位置 |
|---|---|
| `data-fisherai-page="projects" \| "settings"` | 页面根 |
| `data-fisherai-page-back` / `data-fisherai-page-close` | 顶栏返回 / 关闭 |
| `data-fisherai-back-to-library` | 画布顶栏「项目库」按钮（改为开页面） |
| `data-fisherai-open-settings-page` | 侧栏「设置」按钮（改为开页面） |
| `data-fisherai-project-card` + `data-project-id` | 卡片墙每张卡 |
| `data-fisherai-project-row` | 列表视图每行 |
| `data-fisherai-project-drawer` | 右侧详情栏 |
| `data-fisherai-project-open` | 「打开画布」按钮 |
| `data-fisherai-projects-view="cards\|list"` | 视图切换 |
| `data-fisherai-projects-search` / `-facet` / `-kind` | 搜索 / 视图分组 / 筛选 |
| `data-fisherai-settings-section="appearance\|generation\|services\|data\|other"` | 五个分组 |
| `data-fisherai-settings-scale` | 当前缩放读数（`data-fisherai-settings-scale="100"`） |
| `data-fisherai-settings-theme` | 主题三选（只有 glass 可点） |
| `data-fisherai-settings-grid-glow` | 光标辉光开关（`on` / `off`） |
| `data-fisherai-settings-background` | 背景图行（`set` / `empty`） |
| `data-fisherai-settings-host="<id>"` | 旧对话框面板的页内宿主（`local-service / source / channels / data-dir / downloads / update`） |
| `data-fisherai-settings-profile` | 个人资料块（`-profile-name` / `-profile-avatar`） |
| `data-fisherai-settings-goto-host` | 目录两行的「更换」（滚到宿主） |
| `data-fisherai-settings-reset` | 恢复默认 |
| `data-fisherai-settings-advanced` | **已移除**（回归断言它不存在） |

诊断：`canvasAppBuildInfo().pages`（开了哪一屏、分区 key、桥在不在）、`.home`（底下是不是
vendor 看板、自动开过项目库没有、拦下过几次开设置请求）与 `.page`；host `/status` 里多一段
`projects.endpoints`。

---

## 五、落地时踩的坑

1. **React #310（Rendered more hooks than during the previous render）**
   页面「没打开时 `return null`」，如果直接调用带 hooks 的外壳函数，打开时同一个组件的
   hooks 数量会从 N 变成 N+k，React 19 直接抛 #310，整块画布被 error boundary 接住
   （现象是「点项目库 → 画布白了」）。修法：外壳包成稳定组件 `CanvasPageShellView`，
   hooks 属于它自己，页面开没开都不影响上面的计数。

2. **容器外的固定 chrome 从页面下缘戳出来**
   缩放条 / 快捷键钮 / 界面缩放胶囊 / 小地图 / 任务队列 / 副驾与分镜胶囊都按**视口**贴边
   （`bottom-6` / `bottom-24`），而页面只盖住画布容器矩形 —— 打开页面后它们会从下缘露出来。
   修法：页面挂载时给 `<html>` 加 `afg-page-open`，`pageSkin.ts` 里把这几类元素
   `display:none !important`；关闭即撤。

3. **首屏看门把「dashboard 还没渲染」当成「没有 resume」**（v1.85）
   `installCanvasHomePage` 在 `root.render` 之前跑，第一帧 DOM 里还没有看板；如果
   「看不到看板」就把 `bootPending` 清掉，带 resume 的刷新会立刻弹出项目库，之后
   vendor 恢复完画布也被页面盖着 —— 表现就是「刷新后永远停在项目库」。
   修法：只有 `#canvas-background`（画布底盘）出现才算恢复成功，看板缺席时什么都不做。

4. **用 ref 回调挂 vendor 面板会反复重挂**（v1.85）
   设置页每次 toast / 搜索都重渲；ref 回调每次都是新函数，React 会先 `ref(null)` 再
   `ref(el)`，vendor 面板被反复 destroy/mount，输入框丢焦点、通道列表滚动位置归零。
   修法：`mountSettingsHosts()` 在「打开 / 重开」的 effect 里 querySelector 一次，
   同一份 DOM 上只挂一次，关闭时按 disposer 卸载。

5. **jsdom 里 `window !== globalThis`，挂载点必须从 `globalThis` 读**（v1.85）
   `bootstrap` / `CanvasDataDirPanel` / `CloudChannelPanel` 都把 `__FISHERAI_MOUNT_*__`
   写在 `globalThis` 上；页面照 `window` 读在真机没事、在回归里全是 undefined（面板不出现）。
   修法：`mountSettingsHosts()` 统一读 `globalThis`。

6. **容器查询写在基础规则前面会被同权重覆盖**（v1.85）
   窄画布的 hero 用 `@container (max-width: 1040px)` 改成「封面 + 信息两列、最近生成排下面」，
   但基础 `.afp-hero-recent` 写在文件后面、同权重会赢 —— 结果两列生效、最近生成仍是竖排。
   修法：容器查询里的选择器带 `.afp-hero` 前缀提权重。

7. **点一次「打开画布」进不去，项目库自己弹回来**（v1.86，用户原话「打开无限画布后
   要点击两次才能进入画布，第一次点击好像才正式激活项目管理器」）
   `openProjectById()` 之后立刻 `closeCanvasPage()`，而 vendor 的 `view` 还是 dashboard
   （`loadProject` 有一次 HTTP），首屏看门看到「旧看板 + 页面层没开」→ 又
   `openCanvasPage('projects')`：列表重拉、视图归位、卡片墙闪一下，画布在底下悄悄起来。
   第二次点的时候 `#canvas-background` 已经在，关掉就不会再弹回来 —— 所以正好两次。
   修法：①关页面必须晚于 `#canvas-background` 出现（`enterCanvasWhenReady`，等不到就
   留着页面并提示）；②`homePage` 监听 `fisherai:open-project` 开 5s 时间窗，窗口内
   绝不自动开项目库（拉不到项目时窗口过期仍会恢复兜底）。
   回归 `scripts/test-canvas-home.mjs` 12 项：用一个进程只挂一次画布（页面层有模块级
   store，第二个 jsdom 环境里 vendor 树不会重挂），并给 `/workflows/<id>` 加 200ms
   延迟 —— 不给延迟就永远复现不出这条竞态。

---

## 六、验证

```powershell
# jsdom 契约（76 项：host 数据面 26 + DOM 与交互 50）
node scripts/test-canvas-pages.mjs

# 首屏「点一次就进画布」（12 项；v1.86）
node scripts/test-canvas-home.mjs

# 真机（打正在跑的 DSH：真鼠标点「无限画布」→ 一次「打开画布」；v1.86）
$env:DSH_WEB_URL='http://127.0.0.1:61220'; node scripts/verify-live-home-click.mjs

# 真机（打开画布的首屏 + 三张页面交付图 + 迁进来面板的取证）
$env:BROWSER_ONLY='dashboard,projects-page,projects-list,settings-page,settings,effects,channels,data-dir'; node scripts/browser-check.mjs
```

交付图（1440×900、dpr=1；页面 1182×804 = 画布容器 100%）：
`docs/shots/canvas-dashboard.png`（**打开画布 = 项目库首屏**）、`canvas-projects-page.png`（卡片墙）、
`canvas-projects-list.png`（列表 + 详情）、`canvas-settings-page.png`（设置）、
`canvas-settings.png`（服务与通道：开源服务）、`canvas-channels.png`（闭源服务 / 自定义通道）、
`canvas-effects.png`（光标辉光开关）、`canvas-data-dir.png`（项目数据目录）。
