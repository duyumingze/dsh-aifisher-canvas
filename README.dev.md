# dsh-aifisher-canvas

> ⚠️ **许可证（发版前必读）**：本仓库基于 AIFISHER 2.0.7，沿用 **AIFISHER Noncommercial Source License 1.0** —— 这是**非商业源码可见许可**，不是 OSI 认证的开源协议，**禁止商用**（含接私单、付费项目出图、卖插件、商业 SaaS、付费托管）。再分发须免费并保留 LICENSE / NOTICE / 修改说明。完整条款见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。商用请联系版权方 Work-Fisher 获取书面授权。

把 [AIFISHER 无限画布](../AIFISHER-main) 移植成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）的 UI 插件：
画布本体、本地 ComfyUI 生成、云端生图/生视频、右侧 DSH 原生对话栏、任务队列都在同一个面板里。

> 本文档 2026-10-17 按 v1.27 重写过一遍、v1.30 补了 FisherAI 通道、v1.31 补了「默认模型 + 错误文案」、
> v1.32 补了「参考素材读不出来（结果 URL 带缓存戳）」、v1.33 补了「网格比节点快（几何里混进了 dpr）」、
> v1.34 补了「提示词沿上游谱系串味」、v1.35 补了「参考素材上传被瞬时掐断（ECONNRESET）」、
> v1.36 重排了画布顶部（返回项目库 / ComfyUI 胶囊左移 / 任务队列上移，并修好头部被画布底盘盖住）、
> v1.37 给「多选折叠成一叠」加了**叠内切换**（不展开也能翻看这一叠里的每一张）、
> v1.38 把「AI 高清放大」换成**扩图**（只落一个空图片节点、提示词填好，生成由你自己点）+ 尺寸对话框 nova 版、
> v1.39 把扩图改成**两步两节点**（先出一张真图片「扩图画面」，再接一个空的图像生成节点；
> 面板补上目标比例 / 原图位置九宫格 / 延展内容 / 预览）、
> v1.40 让**新建节点默认用上一次生成任务的那个模型**（在节点上换过模型、或真发过一次生成，
> 下一个新节点就不必再调一次下拉；按图片/视频/音频/文本分桶记，模型若已不在目录里就回落目录第一个）。
> **v1.64 给视频补上生成历史**：视频节点以前每生成一次就覆盖上一条，现在与图片同一套 ——
> 每次结果并进 `resultUrls`、节点头部一枚「历史 N」、摊开可预览/下载/设为主视频。
> （原来那份是逐版本累加的长文）。要更细的过程与踩坑记录，
> 看 `docs/` 与本仓库的会话记录；要改代码，先读下面「关键约束」和对应文件顶部的注释。

## 它是什么

上游 AIFISHER 是 Vite + Electron 的独立应用，本插件是 DSH Web 插件。做法是 **整树 vendor + 薄适配**：

```
vendor/aifisher/            上游源码（构建时由 scripts/vendor-aifisher.mjs 从 ../AIFISHER-main 复制）
  ├─ ① 正则/锚点补丁        scripts/vendor-aifisher.mjs（每条断言「恰好命中 N 次」，改不到就构建失败）
  ├─ ② 整文件覆盖            scripts/patches/aifisher/**（7 个文件：本地工作流清单/节点/运行、接入口判定、
  │                          图片工具条与角度草稿、图像工具主按钮）
  └─ ③ 装配层                src/client/canvas/bootstrap.ts（38 个 installer）+ stage.tsx（视图槽位）

三产物（tsdown）：
  lib/index.js                 host 半（ESM）：路由、ComfyUI、生成、媒体库、诊断
  lib/client/apply.js          浏览器半（CJS 工厂）：panel/slot 注册
  lib/canvas/canvas-app.js     画布应用（浏览器 ESM，~2.7MB，host 挂 /api/aifisher/canvas-app/*）
```

`vendor/` 里的东西**一个字不改、也不加文件**：所有改动只走上面三层。原因是上游还在继续改，
正则补丁 + 锚点断言能在上游变写法时立刻报错，而不是悄悄失效。

## 装上 / 更新到本机

插件本体装在 `D:\AllAssets\DSH插件\dsh-aifisher-canvas`，desktop profile 用 junction 挂进
`$DSH_HOME/profiles/desktop/node_modules/dsh-aifisher-canvas`。**DSH 加载的是那个目录里构建好的 `lib/`**，
本工作区（`E:\开源项目\dsh-aifisher-canvas`）的源码不会自动同步过去 —— 改了源码不等于更新了插件。

更新一台已装好的机器 = 同步源码 → 在插件目录里构建 → 跑回归 → 重启 DSH：

1. **同步**（不要把 `node_modules` 与 `.dsh-*` 数据目录带过去）：
   `robocopy E:\开源项目\dsh-aifisher-canvas D:\AllAssets\DSH插件\dsh-aifisher-canvas /E /XO /XD node_modules .dsh-tmp .dsh-meow .dsh-build lib`
   （`/XO` 会按时间戳跳过没变的文件；同步完用 `Get-FileHash` 抽查 `src`、`scripts` 两边一致。）
2. **构建**（在插件目录里跑，构建链顺序不能变）：
   `set AIFISHER_SRC=E:\开源项目\AIFISHER-main` —— vendor 那步默认找 `../AIFISHER-main`，D: 上并没有上游源码树，
   必须用这个环境变量指过去；否则 vendor 直接报「找不到 AIFISHER 源码」。
   `node scripts/clean.mjs && node scripts/vendor-aifisher.mjs && node scripts/build-canvas-css.mjs && node node_modules/tsdown/dist/run.js`
3. **类型门禁**：`node scripts/typecheck.mjs`（只对 `src/` 报错；`vendor/` 是上游源码，不进门禁）。
4. **回归**：`node scripts/run-all-regressions.mjs`（37 套，逐套跑、判绿只看 SUMMARY 行；2026-10-20 v1.57 实测 2210 项）。
5. **重启 DSH**（host 半是进程内加载的，光刷新页面只更新画布产物），重启后刷新画布页即可。

> 盘符换过（`G:` → `E:`）的机器上会有一个坑：`node_modules` 里上千个 junction 存的是绝对路径，
> 盘符一变全部悬空，`node` 解析不到 `tsdown`/`jsdom`，构建与回归一起报「找不到模块」。
> 批量重指用 `node scripts/fix-node-modules-junctions.mjs --dry` 先看计数，去掉 `--dry` 真改（目标必须真实存在才改）。

## 能力清单

| 能力 | 状态 | 主要落点 |
|---|---|---|
| 无限画布核心（视口/节点/连线/编组/历史/框选/复制） | ✅ 搬（vendor + 装配） | `vendor/.../stable/canvas`, `stable/nodes` |
| 本地 ComfyUI 工作流（目录式自定义工作流 + 可视化配置面板） | ➕ 新增 + 4 处覆盖补丁（v1.16→v1.21） | `src/host/comfyui/**`, `src/canvas-ui/canvas/ComfyWorkflow*` |
| 「工作流节点」面板（配置好的工作流按图卡片陈列，点卡片放上画布） | ➕ 新增（v1.28） | `CanvasWorkflowLibrary.tsx` + `CanvasWorkflowLibraryStore.ts` |
| 工作流自定义配图（每份工作流一张封面图，卡片与节点共用） | ➕ 新增（v1.28） | `src/host/comfyui/workflowCovers.ts` + `src/host/canvas/workflowCoversRouter.ts` |
| 云端生图/生视频（方舟直连 + OpenAI 兼容通道，多通道多模型） | ➕ 新增（v1.4 / v1.11） | `src/host/generation/**`, `CloudChannelPanel.ts` |
| **视频生成历史**（每次生成并进 `resultUrls`，节点头部「历史 N」，摊开可悬停预览 / 下载 / 设为主视频） | ➕ 新增（v1.64） | `src/canvas-ui/canvas/CanvasVideoHistory.ts`, `scripts/patches/aifisher/.../canvasVideoPlayer.tsx`, `scripts/vendor-aifisher.mjs`（3.8w） |
| **视频参考图数量**（自配通道的视频条目：总输入上限按各模式 `allowedInputs` 之和算，多图参考 = MiniMax H3 的 9 个图片槽；修「只能拖入三张」） | ➕ 修复（v1.65） | `src/canvas-ui/canvas/CloudChannelModels.ts` |
| **视频截帧**（底部工具条三项菜单：截取首帧 / 截取尾帧 / 首尾帧各一张；单截不造多余节点、尾帧空白自动后退、输出 ≤2048、贴右避让落位、截完聚焦） | ➕ 新增（v1.66） | `src/canvas-ui/canvas/CanvasVideoFrames.ts`, `src/canvas-ui/canvas/CanvasFrameLayout.ts`, `scripts/patches/aifisher/.../canvasVideoPlayer.tsx`, `scripts/vendor-aifisher.mjs`（3.8x） |
| 魔搭（ModelScope）API-Inference 图像接口（image_url 方言 + 一键预设） | ➕ 新增（v1.29） | `src/host/generation/cloudChannels.ts`（方言）, `CloudChannelPanel.ts` |
| FisherAI（api.work-fisher.com）图像接口（`workfisher` 方言 + 异步任务 + 参考图直链上传） | ➕ 新增（v1.30；**v1.35 上传被掐断会自动重试 + 直链缓存**） | `src/host/generation/cloudChannels.ts`（方言/上传/轮询）, `cloudGenerationRouter.ts`, `CloudChannelPanel.ts` |
| 画布右侧 DSH 原生会话栏（聊天框控制画布） | ➕ 新增（v1.9 / v1.14） | `src/host/canvas/{agentChatRouter,canvasChatHub,agentChatStore}.ts`, `src/client/CanvasChatDock.tsx` |
| 任务队列面板（运行中循环发光 / 取消 / 清空） | ➕ 新增（v1.24） | `CanvasTaskQueue.tsx` + `taskQueueRouter.ts` + `generationJournal.ts` |
| 图片编辑族（工作台 / 裁剪 / 宫格裁剪 / 标注·蒙版） | ➕ nova 版重做（v1.26；宫格裁剪 v1.46） | `CanvasImageStudio.tsx`, `ImageCropStage.tsx`, `ImageGridCropStage.tsx`, `ImageAnnotationStage.tsx` |
| **扩图**（工具条点一下 → **先出一张「扩图画面」真图片，再接一个空的图像生成节点**：提示词已填、参考图已连、模型跟你自己的通道；生成由你点） | ➕ 新增（v1.38 起；**v1.39 改成两步两节点**；**替换掉「AI 高清放大 · SeedVR2」**） | `src/canvas-ui/canvas/CanvasOutpaint.ts`, `src/client/canvas/bootstrap.ts`（画像素）, `scripts/patches/aifisher/.../canvasMediaToolbar.tsx`, `scripts/vendor-aifisher.mjs`（3.8p） |
| 尺寸对话框 nova 版（等比倍数 / 指定宽高 / 快捷倍率，保存仍走同一套落盘） | ➕ 新增（v1.38） | `src/canvas-ui/canvas/CanvasImageResize.tsx` + `stage.tsx` 的 `Resize` 槽位 |
| **新建节点默认用上一次的模型**（在节点上换过模型、或真发过一次生成，下一个新节点就不必再调下拉；按 图片/视频/音频/文本 分桶，模型已不在目录里就回落目录第一个） | ➕ 新增（v1.40） | `src/canvas-ui/canvas/CanvasLastModel.ts`, `src/client/canvas/bootstrap.ts`（桥）, `scripts/vendor-aifisher.mjs`（3.8q） |
| 点阵底纹 + 鼠标互动（可在设置里关掉） | ➕ 新增（v1.8；**v1.27 修互动、加开关**；**v1.33 修「网格比节点快」**；**v1.48 Blender 式三层嵌套**） | `src/client/canvas/canvasGrid.ts`, `CanvasEffectsStore/Panel.ts` |
| 画布 UI shadcn 化（头部/工具条/缩放控件/小地图/搜索/对话框） | ➕ 新增（v1.6 起；**v1.36 修好头部被画布盖住 + 重排顶部**） | `src/canvas-ui/**` |
| 多选折叠成一叠（叠图） | ➕ 新增（v1.21） | `scripts/vendor-aifisher.mjs`（3.8j） |
| **叠图「切换」**（不展开也能翻看这一叠里的每一张，`切换 2/3`） | ➕ 新增（v1.37） | `src/canvas-ui/canvas/CanvasStack.ts`, `scripts/vendor-aifisher.mjs`（3.8o） |
| **项目归档**（导出/导入 `.fisherai`：面板里看规模、导出到本机目录并回执绝对路径、导入即新建项目并自动切过去；项目库头部另有「导入项目」） | ➕ 新增（v1.42） | `src/canvas-ui/canvas/CanvasProjectArchive*.ts(x)`, `src/host/canvas/projectArchiveRouter.ts`, `scripts/vendor-aifisher.mjs`（3.8r） |
| **项目数据目录**（设置 → 存储 → 项目数据目录：把插件的整个数据目录换到别的盘；写指针 + **重启 DSH 生效**，可选把现有数据复制过去，纯复制不删旧目录） | ➕ 新增（v1.43） | `src/host/canvas/dataDir.ts` + `dataDirRouter.ts`, `src/canvas-ui/canvas/CanvasDataDir*.ts`, `scripts/vendor-aifisher.mjs`（3.8s） |
| **切刀**（Ctrl + 右键拖拽：划过的连线当场变红，松手断开；Esc 取消；只断被划过的那条） | ➕ 新增（v1.49） | `src/client/canvas/knife.ts`, `scripts/vendor-aifisher.mjs`（3.8t） |
| 画布顶部三维：左上返回项目库 / ComfyUI 胶囊在左 / 任务队列贴右上角 | ➕ 新增（v1.36） | `CanvasHeader.tsx`, `CanvasTaskQueue.tsx`, `scripts/vendor-aifisher.mjs`（3.8n） |
| agent 操控画布（`canvas_control`） | ✅ 用 DSH 替代 Codex | `src/host/index.ts`, `src/host/canvas/agentBridge.ts` |
| **文本节点正文**（`create`/`update` 给 `prompt` 时按正文写进 `textContent`；`text` = 正文、`prompt` = 转换模板，agent 写的字不再落进提示词框） | ➕ 修复（v1.50） | `scripts/vendor-aifisher.mjs`（3.8u）, `src/host/index.ts`, `docs/canvas-agent-contract.md` |
| **@ 画布节点**（输入框敲 `@` 多一组「画布节点」候选：当前项目的文本/图像/视频/音频节点；发送时自动带只读快照，点 chip 聚焦回节点） | ➕ 新增（v1.51） | `src/client/canvasReferences.ts`, `src/host/canvas/nodeReferences.ts`, `src/client/apply.ts`, `src/host/index.ts` |
| **画布侧技能目录**（`canvas_control` 的 `skills`/`skillLoad` + `GET /api/aifisher/skills[/:name]`：能看到并读到**用户/项目自己的技能**，不再只剩 4 条 bundled） | ➕ 修复（v1.44） | `src/host/skills/skillsRouter.ts` |
| 账号登录 / 导演台 / 分镜 / 技能社区 / 反馈中心 / 内置浏览器 | ❌ 不搬 | — |

## 关键约束（改代码前必读）

- **vendor 树不动**：改行为只能改 `scripts/vendor-aifisher.mjs` 的锚点补丁、`scripts/patches/aifisher/**`
  的整文件覆盖，或装配层。补丁锚点必须断言命中次数。
- **画布组件签名固定** `(react, props, ...injected)`：注入值在**第三个参数**；hooks 必须用注入进来的那份 React。
  产物里有**两份 React 19**（vendor 一份 / `src/canvas-ui` 一份），用错那份既不报错也不渲染。
- **浮层状态放模块级 store**（`useSyncExternalStore`），不要只放组件 `useState`；视图槽位 `bindView`
  必须在模块级建一次，否则整棵子树重挂、本地 state 归零。
- **HTTP 命名空间铁律 `/api/aifisher/*`**：撞上内核的 `/api/account` 会让桌面版起不来。
- **画布里的 DOM 事实先过 `rect > 1px` 这道闸**：jsdom 量出来全是 0×0，不过闸会把 23 套回归的判定改掉；
  量不到就退回上游那套纯数据公式。
- **jsdom 验不了的（布局/命中/rAF 视觉）分两层守**：jsdom 守 DOM 属性契约，真机在 `browser-check` 里量
  （真派发 pointer 事件 + 读 computedStyle + 读截图像素）。
- **画布几何只用 CSS px，`devicePixelRatio` 不进几何**：画布 `translate3d(x px, y px) scale(z)` 里的
  平移/缩放本来就是 CSS px，节点按它画；任何「自己也跟画布动」的装饰层必须**原样**用这两个数
  （v1.33 的 bug：底纹把平移乘了 dpr，125% 缩放的屏幕上网格比节点快 1.25 倍；dpr 只能当读数）。
  同类检查要**在 dpr≠1 下跑一遍** —— jsdom 恒为 1、`browser-check` 默认也带着
  `--force-device-scale-factor=1`，两套都会把「乘了 dpr」看成绿。现在真机有两场守这个比值
  （`grid-pan` / `grid-pan-hidpi`）。
- **视觉反馈不写 React state**：pointermove 每帧重渲染会掉帧；rAF 节流后直接改 `transform`/`boxShadow`，
  只碰 React 不写的那几条属性，并留一个 `window.__FISHERAI_*__()` 读数给排障用。
- **跨 bundle 的桥走全局**（`__FISHERAI_CANVAS_STACK__`、`__FISHERAI_MOUNT_CLOUD_CHANNELS__`、
  `__FISHERAI_CANVAS_EFFECTS__`、`__FISHERAI_LAST_MODEL__` / `__FISHERAI_REMEMBER_MODEL__` …），
  原因是两份 React + 两个模块实例。写桥时**同时写 `window` 与 `globalThis`**：浏览器里两者是同一个对象，
  jsdom 里不是（vendor 读 globalThis、回归脚本读 window）。
- **「只在某一层可见」靠图层契约，不靠 z-index**（v1.41）：接管全屏的浮层要走 vendor 的
  `activateModal()`（它给浮层路径上的兄弟节点加 `inert`）；画布层的小部件（任务队列…）挂在画布容器里
  就等于「浮层一开就带 `inert`」，用一条 `[inert] { display:none }` 表达「只在画布这一层」。
  别写「按浮层选择器逐个登记」的清单，也别指望把 z-index 调低 —— 半透明浮层会把它透出来。
- **内核会话的布局补丁写在 `CanvasChatDock` 的样式表里、选择器要精确到 `>`**（v1.41）：空白会话不渲 Views、
  `composerSeat` 是唯一子元素，补 `margin-top:auto` 让它贴底；有正文时 `.viewArea` 吃掉剩余空间，`auto`=0，
  所以这条对已有会话零影响。不要用 `justify-content:flex-end`（可滚动 flex 容器里顶部内容会滚不到）。
- **查技能不要只问 `ctx.skills`**（v1.44）：文件系统技能 provider 挂在 **agent 作用域**，
  插件 host 上下文里的 `ctx.skills.list()` 只看得见 global（bundled）那几条 —— 用户自己的技能
  一条都列不出来、`skillLoad` 404（真机取证：只回 4 条 bundled，`$DSH_HOME/skills` 下 10 条全丢）。
  画布侧一律走 `createSkillsCatalog()`：按官方那四个根自己扫盘
  （项目 `.dsh/skills` > 项目 `.agents/skills` > 用户 `$DSH_HOME/skills` > `$DSH_AGENTS_HOME/skills`），
  再与 `ctx.skills` 合并（同名以扫到的为准）。项目层要扫哪个目录由**发起调用的会话 cwd** 决定
  （`?cwd=` / `exec.agent.session.cwd`），不传就只扫用户层。
- **改 host 半要重启 DSH；改 client/画布产物刷新页面即可**（产物 no-store）。

## 数据目录与本地后端

数据默认都在 `$DSH_HOME/storages/dsh-aifisher-canvas/`；**v1.43 起可以在「设置 → 存储 → 项目数据目录」
把整个数据根换到别的盘**（写指针 + 重启 DSH 生效，见下）：

| 文件/目录 | 内容 |
|---|---|
| `canvas.json` | 项目、节点、分组、视口（画布存档；自动保存写这里） |
| `media/<项目>/<images\|videos\|audios>/` | 生成与上传的素材（同目录 `<file>.json` 侧车存元数据） |
| `library.json` | 资产库索引（显式收藏） |
| `workflows/` + `workflow-dir.json` | 目录式自定义工作流；目录可自定义（只读、只允许建一层） |
| `workflow-covers.json` + `workflow-covers/` | 工作流自定义配图（v1.28：索引 + 图片本体；**不写**用户的工作流目录） |
| `comfy-widget-options.json` | ComfyUI `/object_info` 枚举快照（5 分钟 TTL，失败退回旧快照） |
| `appearance/` | 画布背景图（`background.<ext>` + `background.json`） |
| `downloads/` + `downloads.json` | 媒体下载目录与设置（项目归档导出也落这里） |
| `data-dir.json` | 数据目录指针（v1.43：`{directory, savedAt}`；有它时所有数据都在 `directory` 指的目录） |
| `prompts.json` | 提示词预设 + 创意库收藏 |
| `cloud-keys.json` | 界面上填的密钥（现在只剩方舟 `ARK_*`；密钥值永不回前端） |
| `cloud-channels.json` | 自配通道表（通道 = 名称 + Base URL + Key + 请求方言 + 勾选的模型） |
| `agent-chat.json` | 画布对话存档（一条画布对话 = 一个 DSH 会话） |

接口分组（画布那套全在 `/api/aifisher/canvas/*`；ComfyUI 能力清单另在 `/api/comfy/*`）：

| 分组 | 代表端点 |
|---|---|
| 项目/工作流 | `GET/POST /workflows`, `POST /workflows/:id`, `GET /status` |
| 生成 | `POST /generate-<image\|video\|audio\|text>`, `POST /comfy/<工作流>`, `GET /generation-status/:nodeId`, `POST /generation-cancel/:nodeId` |
| 素材 | `POST /assets/upload\|import`, `POST /assets/<kind>s`（data URL）, `GET /assets/…`, `DELETE`（回收站）, `GET /proxy?url=` |
| 媒体加工 | `/media-crop`, `/media-grid`, `/video-frames`, `/audio-trim`（ffmpeg） |
| 外观/下载/本机 | `/appearance/background`, `/media-download/settings`, `/local-runtime/*` |
| 通道/模型 | `/cloud-channels`, `/chat/models`, `/model-availability` |
| 对话 | `POST /chat/stream`（SSE）, `GET/PUT /agent/workspace`, `GET/DELETE /chat/sessions` |
| 任务 | `GET /tasks?limit=`, `POST /tasks/cancel`, `DELETE /tasks` |
| 工作流配图 | `GET /workflow-covers`, `POST/DELETE /workflow-covers/:id`（body `{dataUrl}`）, `GET /workflow-covers/file/:name` |
| 项目归档 | `GET /workflows/:id/backup`（下载）, `GET /workflows/:id/backup/info`（规模预览）, `POST /workflows/:id/backup/save`（写入本机目录）, `POST /workflows/restore`（导入） |
| 其它 | `/diagnostics`, `/prompts/*`, `/library/*`, `/skills`（列表）, `/skills/:name?cwd=`（正文；v1.44 起扫用户+项目技能） |

### 换电脑怎么迁移（速查）

一句话：**整份 `$DSH_HOME/storages/dsh-aifisher-canvas/` 就是全部数据**，拷过去就行。

1. 新机器装好 DSH + **同一版本（或更新）**的本插件，先启动一次让目录出现，然后两边都**关掉 DSH**；
2. 旧机器：`robocopy "$env:DSH_HOME\storages\dsh-aifisher-canvas" D:\backup\canvas-data /E`
   （`$DSH_HOME` 没设就是 `$env:USERPROFILE\.dsh`）；新机器再
   `robocopy D:\backup\canvas-data "$env:DSH_HOME\storages\dsh-aifisher-canvas" /E`；
3. 启动 DSH → 进无限画布 → 核对：项目数、图都能打开、设置里的通道在、工作流卡片有配图、画布背景在；
4. 只有两类东西需要手动补：**机器相关的绝对路径**（工作流目录 / 下载目录，设置里重选一次）与
   **浏览器 localStorage 里的 5 个偏好**（会话栏宽/开合、任务队列开合、画布互动、上次用的模型；
   不在数据目录里，缺了回落默认值）。

细节（每个文件是什么、**只迁单个项目的 `.fisherai` 归档**、常见坑）见
[`docs/storage-and-migration.md`](docs/storage-and-migration.md)。
只迁一个项目不必整目录搬：画布头部「项目归档」→ 导出（写到下载目录，回执给绝对路径）；
到新机器在项目库头部点「导入项目」选那份 `.fisherai` 就行（v1.42）。
不在这个目录里的四样：插件本体、DSH 自己的会话记录（右侧会话栏的历史）、浏览器 localStorage 偏好、DSH 配置。

## 版本线（v0.6 → v1.51）

| 版本 | 要点 |
|---|---|
| v0.6～v0.9 | 画布 vendor 化 + 本地后端替代 AIFISHER server + 面板出口（退出画布/返回对话）；删掉账号系统 |
| v1.0 | 画布上跑本地工作流（自定义工作流可选可跑） |
| v1.1 / v1.2 | 设置页与画布 UI 补全（installer 14→35）、ComfyUI 状态胶囊、最后三块漏装 |
| v1.4 | 方舟（豆包）图片直连；生成失败 hint 进节点错误文案 |
| v1.6 | 画布 UI 换 shadcn/ui（nova 风）：只换槽位，vendor 不动 |
| v1.7 / v1.8 | 点阵底纹：24px 小十字星 + 鼠标周围圆形变亮（像素级断言兜底） |
| v1.9 / v1.14 | 右侧对话面板 → 改成 DSH 原生会话栏（大脑 = DSH 会话） |
| v1.10 | 节点搜索面板（Shift+A，模糊搜节点与工作流） |
| v1.11～v1.13 | 自配 OpenAI 通道（多通道 × 多模型、模型别名）；旧单端点下架 |
| v1.15 | 移除看板头部两个站外入口（AIFISHER API / B 站教学主页） |
| v1.16～v1.21 | 「ComfyUI 工作流配置」族：左栏入口、目录可自定义、节点图可视化配置、ComfyUI 枚举变下拉、节点 720 宽两列布局、负向提示词变输入槽、结果图自动排开、多选折叠 |
| v1.22 / v1.24 | 任务队列面板：右缘浮层、运行中循环发光边框、取消/清空、云端任务进日记 |
| v1.25 | 接入口按「端口圆」命中（elementFromPoint + 圆心吸附）；拖动时端口跟着指针放大发光 |
| v1.26 | 图片编辑族重做成 nova 版（工作台/裁剪/标注·蒙版）并修好「保存为新图片」（以前 405） |
| v1.27 | **画布与鼠标互动修好** + 设置里的开关（见下） |
| v1.28 | 左栏「工作流节点」不再误弹画布右键菜单 → 改成工作流节点面板；工作流可自定义配图（见下） |
| v1.29 | **接通魔搭（ModelScope）图像接口**：请求方言（参考图 `image_url`）+ 生成数量按次提交 + 一键预设（见下） |
| v1.30 | **接通 FisherAI（api.work-fisher.com）图像接口**：`workfisher` 方言（单数路径 / `size` 宽高比 + `resolution` 档位 / `nsfw_check`）+ 异步任务轮询 + 参考图先传公网直链 + 一键预设（见下） |
| v1.31 | **「生图失败」的真原因看得见了**（403 不再被改写成「请检查 API Key」）+ **新建节点默认模型跟着通道走**（不再落回上游内置的 `GPT Image 2 · API`）（见下） |
| v1.32 | **「参考素材读不出来」修好**（结果 URL 上的 `?t=` 缓存戳以前被当成文件名的一部分）+ 素材已被删时文案不再说反（见下） |
| v1.33 | **「画布平移时网格比节点快」修好**：底纹几何里混进了 `devicePixelRatio`（125% 缩放的屏幕上正好快 1.25 倍），真机补了两场 dpr 1.0 / 1.25 的回归（见下） |
| v1.34 | **提示词不再沿上游谱系串味**：输入框里写了什么就只发什么，不再把「前面那个节点（或它更上游文本节点）的提示词」并进这一条请求（见下） |
| v1.35 | **参考素材上传被瞬时掐断不再变成「生成不了」**：`ECONNRESET`/`socket hang up` 这类可免费重放的失败自动重试 3 次（每次新超时），同一张参考图的直链缓存 12 小时；一直断时回执写清「试了几次 / 多大 / 什么原因」并给代理方向（见下） |
| v1.36 | **画布顶部重排**：左上角返回项目库按钮、ComfyUI 胶囊从右上角移到左边、任务队列上移到右上角；顺带修好「整条头部被画布底盘盖住」（z-index 与底色类名丢失，真机上 logo/项目名/保存状态看不见也点不到，见下） |
| v1.37 | **叠图「切换」按钮**：多选折叠成一叠之后，宿主卡左下角多了 `切换 2/3` —— 不展开也能翻看这一叠里的每一张（Shift+点击往回翻），换的是**内容**（图/标题/提示词一起走，壳字段与节点 id 不动）（见下） |
| v1.38 | **「AI 高清放大」换成「扩图」**：工具条那个 HD 按钮拿掉（它直接生图、走写死的 RunningHub 通道），原位置换成扩图 —— 点一下只**落一个空图片节点**（提示词已填、原图已连、模型跟你自己的通道），生成由你点；「角度 / 全景图」也不再自动生图、不再写死旧通道模型；**尺寸对话框换成 nova 版**（见下） |
| v1.39 | **扩图改成「先出一张图，再接生成节点」**：点一下先在浏览器里把原图按目标比例 / 原图位置九宫格画成一张**真的「扩图画面」**（扩出去的区域留透明）落进素材库、成为画布上的图片节点；再建一个空的 `扩图 · 比例` 节点、参考图连那张扩图画面、提示词填好——生成仍由你点。面板补上目标比例 / 原图位置 / 延展内容 / 预览（见下） |
| v1.40 | **新建节点默认用上一次生成任务的那个模型**：在节点上换过模型、或真发过一次生成，下一个新节点就直接是那一款（不必每次都再调一次下拉）。按 图片/视频/音频/文本 分桶记、落本机 localStorage；模型已不在目录里（通道被删/取消勾选/改名）就回落目录第一个（见下） |
| v1.41 | **任务队列只在画布这一层**：打开设置/图片编辑/媒体预览这类接管全屏的浮层时，面板整块不出现（以前它 `z-[11000]` 浮在设置上面）；**右侧会话栏「新对话」的输入区贴到底部**（以前空白会话里输入框顶在栏头下面）；补一份**数据存放与换机迁移**说明（见下） |
| v1.42 | **项目归档（导出 / 导入）**：画布头部多了「项目归档」入口 —— 面板里看得到「N 个节点 · 素材 M 个 · 归档约 X MB」，一键**导出到本机目录**（host 落盘、回执给绝对路径、可打开目录）或下载；导入支持 `.fisherai`（带素材）与旧版 `.json` 文档，**导入即新建项目并自动切过去**；项目库头部另有「导入项目」按钮（见下） |
| v1.43 | **项目数据目录可自定义**：设置 → 存储 → 「项目数据目录（缓存）」，填一个绝对路径 + 可选「把现有数据复制过去」，**重启一次 DSH** 之后项目/素材/通道/密钥/工作流/下载全落到新目录；「恢复默认」回 DSH 数据目录下（旧目录不删）（见下） |
| v1.44 | **画布侧技能目录修好**：`canvas_control` 的 `skills`/`skillLoad` 与 `GET /api/aifisher/skills[/:name]` 以前只能看到 4 条 bundled 技能、用户自己的技能（`$DSH_HOME/skills` 下那 10 条）一条都列不出来、`skillLoad` 直接 404 —— 现在按官方四个根自己扫盘并与 `ctx.skills` 合并（见下） |
| v1.45 | **节点搜索一次回车只建一个节点**（输入框与面板根各处理了一次同一个 Enter），并按用户要求做成 Blender 式「新建并移动」：确认后节点跟着鼠标走，下一次左键才放下（见下） |
| v1.46 | **宫格裁剪换成 nova 版工作台**（用户「画布宫格裁剪ui还没有更新」）：宫格预设 / 行列分割 / 间隙 / 比例 / 导出顺序 / 导出序号收进同一套四段式舞台；切图仍走上游纯函数（切线间距、间隙、宫格白底、`1,3,5-8` 语法一字没动），默认 2×2 且选区铺满原图；全景 / 角度继续交给 vendor（见下） |
| v1.47 | **拖出来的连线不再偏出去**（用户「从图像拉出的线与鼠标指针有很大偏差」）：上游把 `clientX/clientY` 直接当画布内坐标用，本插件的画布底盘左边是 DSH 侧边栏、上边是顶栏，于是虚线整体偏 (底盘左, 底盘上)/zoom（真机侧边栏 240px，就是偏 240px）。修法：手势开始时量一次 `#canvas-background` 的 rect，进画布坐标系前减掉它；真机回归钉住「自由端与指针偏差 ≤ 2px」（改前实测偏 240px）（见下） |
| v1.48 | **缩小时点阵不再密密麻麻（Blender 式三层嵌套矩阵）**（用户「画布背景的星型矩阵，缩小画布就密密麻麻的，能不能参考 blender 的，大的矩阵包裹小的矩阵，缩放到一点程度后小的矩阵就消失」）：24 / 120 / 600px 三层共用同一平移相位（大星压在小星上），每层按**屏幕间距**淡入淡出 —— 小矩阵缩到 12px 以下先消失，大矩阵接棒，继续缩由更大一层接棒；24px 那层的规格与 zoom 1 的观感不变（见下） |
| v1.51 | **对话里 @ 画布节点**（用户「能不能加一个我能在对话去@画布内的素材，文本、图像等」）：输入框敲 `@` 就多一组「画布节点」候选（当前项目里的文本 / 图像 / 视频 / 音频节点，按标题与正文模糊过滤）；选中插入原子引用，发送时序列化为 `@[标题](aifisher-node:节点id)`，宿主在 `agent/pre-step` 里把它展开成紧随其后的**只读节点快照**（标题 / 类型 / 正文 / 结果地址，最多 8 个、单节截断）；已发送消息里渲染成 chip，点一下把节点聚焦回画布（见下） |
| v1.50 | **agent 写的字不再落进「提示词」框**（用户「它生成的内容不在文本里，反而在提示词里」）：Text 节点的正文是 `textContent`、`prompt` 是转换模板，而 agent 的 `create/update` 无条件写 `prompt`；现在只给 `prompt` 时按正文写入，显式 `text` 才写正文、`prompt` 留给模板（见下） |
| v1.49 | **切刀：按住 Ctrl + 右键拖拽，划过的连线断开**（用户「像blender一样按住ctrl加鼠标右键切换到切刀工具，划过的线会断开连接」）：拖拽时画出刀口线、被划过的连线**当场变红**（预览），松手只断开这些线（与双击断线同一条写路径，可撤销、会被自动保存）；Esc 取消；只按身份 `(parentId, childId, portIndex)` 断开，同一子节点上没被划到的连线原样保留（见下） |

### v1.27：鼠标互动修好 + 设置里的开关

用户原话：「现在画布与鼠标没有互动效果，在设置里做一个开关」。

- **根因**：网格层必须 `pointer-events: none`（铺满画布，不能抢画布指针事件），而这种元素**永远不是命中目标**
  —— v1.8 把 `pointermove` 监听挂在网格层自己身上，真实鼠标的事件落在 `#canvas-background`（或节点）上，
  一格都到不了它。两套回归都是 `layer.dispatchEvent(...)`（合成事件绕过命中测试），所以一直「全绿但真机不动」。
- **修法**（`src/client/canvas/canvasGrid.ts`）：改成 **window 捕获阶段**监听；圆心用 `clientX/Y − 网格层 rect`
  （rect 量不到才退回 `offsetX/offsetY`）；指针出画布 / `pointerout`（relatedTarget 为空）/ 窗口 `blur` 三路复位；
  回归改成**派发在 `#canvas-background` 上且不冒泡**（谁把监听挂回网格层，那几条立刻红）。
- **开关**：设置 → 画布外观 → 画布互动。状态在 `src/canvas-ui/canvas/CanvasEffectsStore.ts`
  （模块级 store，落本机 `localStorage: dsh-aifisher-canvas.canvas-effects`），面板是纯 DOM
  （`CanvasEffectsPanel.ts`，由 vendor 补丁 3.8k 挂进那一页）。关掉时**摘监听 + 清遮罩**，不是把透明度调成 0。
- **排查读数**：`canvasGridReport()` 的 `interactive` / `effects` / `pointer`（enabled/listening/last/paints），
  或页面里 `__FISHERAI_CANVAS_EFFECTS__.get() / .set('pointerGlow', false) / .report()`。

### v1.28：「工作流节点」面板 + 工作流自定义配图

用户原话：「左侧工作流节点做错了，点击后是在画布右键的样子。工作流节点里放置配置好的 comfui，可以自定义配图」。

- **根因**：左栏那个按钮被接到了 `onAddClick`（「添加节点」的处理器），而它做的是
  `adapter.openCanvasMenu('global', …)` —— 就是画布右键菜单那一份，所以点出来「是在画布右键的样子」。
  修法：接到自己的面板（`CanvasWorkflowLibraryStore.ts` 的 `requestCanvasWorkflowLibrary()`）；
  缺省时点了**不动**，不回落到 `onAddClick`（那正是 bug 本体）。
- **面板**（`src/canvas-ui/canvas/CanvasWorkflowLibrary.tsx`）：把「配置好的 ComfyUI 工作流」按
  **图卡片**陈列（封面 / 标题 / 分类 / 输入与参数数量），可搜索；点卡片 = 把绑好该工作流的
  ComfyUI 节点放到画布正中（走 `fisherai:add-canvas-node` + `comfyMode`）；目录空了有明确空态并给
  「ComfyUI 工作流配置」的去处。
- **配图**：host 新增 `src/host/comfyui/workflowCovers.ts` + `canvas/workflowCoversRouter.ts`。
  索引 `workflow-covers.json` + 图片 `workflow-covers/<sha1(id)>.<ext>` 都落在**画布数据目录**
  （用户的工作流目录保持只读/干净）；URL 带 `?v=<updatedAt>` 破缓存；上限 8 MB，只收 png/jpg/webp/gif。
  同一张图既做面板卡片封面，也做**节点头部那枚 22px 小图**
  （`data-fisherai-local-workflow-cover="custom|brand"`）。
- **接口**：`GET /api/aifisher/canvas/workflow-covers`、`POST/DELETE /workflow-covers/:id`、
  `GET /workflow-covers/file/:name`；能力清单与「ComfyUI 工作流配置」清单都多带一个 `coverUrl`
  （面板与节点共用一份数据）。
- ⚠️ 这轮改了 host 半：**要重启一次 DSH**（配图接口与 `coverUrl` 才生效），然后刷新画布页。

### v1.29：接通魔搭（ModelScope）图像接口

用户要求：给无限画布接一下魔搭的图像大模型接口（给了 `Qwen/Qwen-Image-2.1-Turbo` 的异步调用样例，
样例里参考图走的是 `image_url` 数组）。魔搭的异步任务链路（`X-ModelScope-Async-Mode` + `/tasks/{id}` 轮询）
v1.11 就已经在了，这轮补的是**请求形状**这一层。

- **根因（静默出错）**：魔搭的 `/v1/images/generations` **不认 OpenAI 形状的 `image` 字段**，
  而且**不报错、不回 400** —— 它把参考图整张丢掉，按纯文生图跑完回一张图。于是画布上的
  「图生图 / 图片编辑」看起来像「重新画了一张」，日志里一个字都看不出来。
  取证判据（参考图 = 纯红 512×512，prompt 一个字都没提颜色「保持原样输出」，量输出里的近红像素）：

  | 参考图字段 | 近红像素 | 结论 |
  |---|---|---|
  | `image_url: [...]`（魔搭形状） | **100%** | 参考图用上了 |
  | `image: '...'`（OpenAI 形状） | 9% | 参考图被丢掉（无参考图的对照是 0%） |

  （单次取证的绝对值会抖：「保持原样」这类 prompt 偶尔会被模型重画一遍，所以可复跑的脚本
  `verify-live-modelscope.mjs` 用的是**配对判据** —— 见下文「真机取证」。）

- **修法**：通道表新增 **请求方言** `dialect`（`openai` / `modelscope`；**缺省 = 按 Base URL 域名自动判定**，
  `*.modelscope.cn` → `modelscope`）。魔搭方言下参考图进 `image_url`（**数组**；画布送的是本站素材内联的
  data URL，实测魔搭接受），并**不再带无效的 `n`**。OpenAI 方言那条路一个字节没动。
- **生成数量**：魔搭不认 `n`（实测 `n=2` 仍只回 1 张图），所以方言是魔搭且数量 > 1 时，
  host **真的提交几次**再把结果合并（`resultUrls`）—— 叫 3 张就给 3 张；
  部分失败仍返回成功的那些，全失败才报错。否则那个「生成数量」控件在魔搭上就是空转。
- **界面**（设置 → 闭源服务 → OpenAI 通道）：每张通道卡片多一个「请求方言」下拉
  （自动 / OpenAI 兼容 / 魔搭 ModelScope），下面一行小字**实时写出「自动」判成了哪套**；
  头部多一个「+ 魔搭 API-Inference」一键预设（地址 + `Qwen/Qwen-Image-2.1-Turbo`、
  `Qwen/Qwen-Image-Edit` 两个图像模型一次填好 —— 魔搭的 `GET /models` 只回报 36 个模型，
  **不含** 用户在用的那个 Turbo，光靠「读取模型列表」勾不出来）。
- **排查读数**：生成回执里多一个 `channelDialect`；`channelDiagnostics()` 里每条通道都有
  `dialect`（`自动` = 没显式配）与 `dialectDetected`（实际生效的那套）。
- **真机取证**：`node scripts/verify-live-modelscope.mjs`（`pnpm verify:modelscope`）走 **host 链路**
  真出图，判定「参考图有没有被用上」用的是**配对判据**：同一个「一个字不提颜色」的 prompt，
  分别配**纯红**与**纯绿**两张参考图（画布那种 data URL），要求红那张的输出以 R 通道为主、
  绿那张以 G 通道为主（各领先 ≥ 20）—— 参考图被丢掉时两张只会是同一个纯文生图分布，不可能各自跟着走；
  另外跑一次 `openai` 方言作**对照**，把上面那条静默失败原样复现出来（实测：红 `[231,17,17]` R 领先 214 /
  绿 `[37,187,53]` G 领先 134 / 对照 `[238,226,217]` R 只领先 12）。
- ⚠️ 这轮改了 host 半：**要重启一次 DSH**，然后刷新画布页。

### v1.30：接通 FisherAI（api.work-fisher.com）图像接口

用户给的是「一句需求 + 一段 curl 样例」：

```bash
curl https://api.work-fisher.com/v1/image/generations \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"workfisher-image-g-v2.5-lowprice","prompt":"A red ceramic teapot on a white table",
       "n":1,"size":"16:9","resolution":"1k","nsfw_check":false}'
```

这套端点**不是** OpenAI 兼容形状 —— 路径、尺寸写法、同步性、参考图、结果位置五处都不一样，而且配错都**不报错**：

| 维度 | OpenAI 兼容 | FisherAI（work-fisher） |
|---|---|---|
| 路径 | `/v1/images/generations`（复数） | `/v1/image/generations`（**单数** image） |
| 尺寸 | `size:"1024x576"` 像素串 | `size:"16:9"`（宽高比）+ `resolution:"1k"`（只认 1k/2k/4k，小写） |
| 同步性 | 同步回 `data[].url` | **异步任务**：提交回 `task_id` → 轮询 `/image/generations/{id}` |
| 结果位置 | `data[].url` | `data.data.content.image_urls[]`（`result_url` 兜底），签名直链约 24h 过期 |
| 参考图 | `image`（可 data URL / base64） | `images`（**只收公网直链**；data URL 会被当没传） |
| 其它 | — | 必带 `nsfw_check:false`；状态机是大写 `NOT_START/SUBMITTED/IN_PROGRESS/SUCCESS/FAILURE` |

协议细节以**上游 `AIFISHER-main/server/providers/relayProvider.js`** 为准（那边早就接了同一套网关），
不是照 curl 猜的 —— 里面的 `buildImageRequestBody` 就是这个形状。

- **方言**：`ChannelDialect` 新增 `workfisher`；`*.work-fisher.com` 域名**自动判定**（用户已有的通道不用改配置就生效）。
  图像请求体（`src/host/generation/cloudChannels.ts`）：
  `{model, prompt, n:1, resolution, nsfw_check:false, size?:'16:9', images?:[...]}`；
  非 `2.5` 家族的 workfisher 图像模型走 `metadata:{resolution, ratio, output_format:'png'}` 那套（与上游一致）。
  路径由 `channelPath()` 按方言给默认值（`DIALECT_PATHS`），用户显式填的「高级 → 路径」仍然压过它。
- **异步任务**：`channelTaskPoll()` 按方言分流（FisherAI = 提交地址 + `/{task_id}`，魔搭仍是 `base + /tasks/{id}`）；
  `channelTaskState()` / `channelTaskError()` 都先剥掉 `{code, data}` 那层再读状态与 `fail_reason`。
- **参考图**：新增 `uploadChannelReferences()` —— data URL / 本站素材先 `POST {base}/files/upload`（multipart `file`）
  换成公网直链再塞进 `images`，已是直链的原样用。真机取证见下。
- **生成数量**：低价扩展版一个任务只回 1 张 → 与魔搭同一条「叫几张就真提交几次」的路（`n` 恒为 1）。
- **网络抖动**（2026-10-17 实测，这台机器）：到 `api.work-fisher.com`（Cloudflare）**约 1/6 次连接在 10.5s 超时**
  （`UND_ERR_CONNECT_TIMEOUT`）。处理原则是「重试可以，重复计费不行」：
  - 提交只在**连接阶段**失败时重试（请求一个字节都没发出去 ⇒ 不会重复扣费），发出去后断掉的一律不重放；
  - 轮询把「这次没回来」与 `5xx/429` 都当可重试（连续 8 次才认输），单次查询 20s 超时；
  - 错误文案带上 `error.cause.code`，不再只给一句 `fetch failed`（那两句根本分不清是「地址不通」还是「这次没连上」）。
- **界面**（设置 → 闭源服务 → OpenAI 通道）：「请求方言」下拉多一项「FisherAI（work-fisher）」，
  头部多一个「+ FisherAI（work-fisher）」一键预设（地址 + `workfisher-image-g-v2.5-lowprice` 一次填好）。
  这个网关的 `GET /models` 实测回报 **290 个模型**、`workfisher-image-*` 全套都在，所以想要别的模型
  直接点面板上的「读取模型列表」勾选即可（模型名就是请求里要发的那个 ID）。
- **额度不足要说人话**：端点会回 `403 {"code":"insufficient_user_quota","message":"用户额度不足，无法预扣 ¥0.048752"}`
  （2026-10-17 真机复跑时余额扣光就撞上了）。上游原话照传，另外补一句 hint「是账户余额的事，去充值页；
  与画布、与密钥格式无关」，否则这种 403 最容易被当成「画布又坏了」。
- **真机取证**：`node scripts/verify-live-workfisher.mjs`（走 host 链路，真花额度 2 次）：

  | 用例 | 结果 |
  |---|---|
  | 文生图 1K · 16:9 | HTTP 200，40s，落盘 1.5MB PNG |
  | 纯红参考图编辑（prompt 一个字没提颜色） | HTTP 200，40s，输出 `平均 RGB=[238,8,12]`、近红 1.00 → 参考图确实到了上游 |

  另外 `browser-check` 新增 `channels` 场景量真浏览器里的通道面板（截图 = `docs/shots/canvas-cloud-channels.png`）。
- ⚠️ 这轮改了 host 半：**要重启一次 DSH**，然后刷新画布页。

### v1.31：生图失败的真原因 + 新建节点的默认模型

用户原话：「生图失败，帮我看看。还有新建节点的时候默认模型不是我配置好的」。两句各自一个真 bug，
且都不是「画布坏了」：

- **生图失败**（实测 `POST /api/aifisher/canvas/generate-image` 带 `imageModel: "Fisher · workfisher-image-g-v2.5-lowprice"`）：
  host 回 `502 CLOUD_UPSTREAM_ERROR`，上游原话是
  `HTTP 403 {"code":"insufficient_user_quota","message":"用户额度不足，无法预扣 ¥0.048752"}` ——
  **端点侧余额不足，与画布、与密钥格式都无关**（要充值；或换一条有额度的通道）。
  但画布节点上显示的是「权限被拒绝。请检查 API Key 配置。」—— 根因在上游
  `generation/canvasGeneration.ts`：它只要看到错误消息里出现 `403` 就把整句替换掉，
  于是 host 已经拼好的「状态 + 上游原话 + hint」被扔了。修法（vendor 补丁 3.8j）：host 给的详细消息
  （以「云端通道 / 云端模型」开头）**原样显示**，只对没有上下文的干巴错误保留兜底那句。
- **新建节点默认模型不对**：两截，缺一都不行。
  1. `createCanvasNode` 本来按 `runtime.imageModels[0]` 填好了 `model/imageModel`，但
     `createFresh` 里的 `applyFreshCanvasNodeDefaults` 又**无条件覆盖**成上游内置的
     `GPT Image 2 · API` / `Seedance 2.5 Standard · API`。本插件没有这两条后端，所以新节点一建出来
     点生成就是 `501 CLOUD_NOT_CONFIGURED`（实测）。修法（vendor 补丁 3.8i）：给了就尊重，
     只有上游原生名 `GPT Image 2` 仍换成 `· API` 那条，没给才兜底。
  2. 通道模型原来是**追加在目录末尾**（当时为了「不影响默认值」），所以 `imageModels[0]` 仍是内置模型。
     现在改成**装在最前面**（`src/canvas-ui/canvas/CloudChannelModels.ts`）→ 第一个已配置通道的
     第一个模型就是新节点的默认模型。
- **回归**：`test:cloud-channels` 111 → **119**（+8：403 时节点上显示「额度不足」原话 / 带得出 HTTP 403 /
  诊断码不变 / 新节点 `imageModel` 与 `model` 都等于通道模型 / 两条 vendor 补丁在源码里）。
  真机：`BROWSER_ONLY=workflow-node` 新增一条 —— 现场预置通道别名「魔搭出图」，新建的图片节点上就是它，
  且不含 `GPT Image 2`。
- ⚠️ 这轮**只改浏览器半边**（vendor 补丁 + 画布注册表）：**不用重启 DSH，刷新画布页即可**。

### v1.32：参考素材读不出来（结果 URL 自带缓存戳）

用户报障是「节点上写着参考素材读不出来，可那张图明明在画布里」，原文：

```
参考素材读不出来：/api/aifisher/canvas/media/<项目>/images/media-f3e89ede.png?t=1792243183952。
（画布素材库里的图片才能内联给云端端点；外链图片请先下载到素材库。）
```

- **根因**（一条链，缺一环都不成立）：
  1. 画布上的结果 URL 由上游 `canvasGeneration.ts` 的 `withTimestamp()` 挂了**显示用缓存戳**
     （`?t=<毫秒>`，纯粹给 `<img>` 破缓存）；
  2. 这个 URL 又正好是**下一张图的参考素材**（`inputMedia()` → `imageReferences()` → 请求体的
     `imageBase64`），原样带了过去；
  3. host 半 `mediaStore.localPathForUrl()` 只对 `http(s):` 走 `new URL().pathname`（顺带吃掉查询串），
     **相对形状直接当路径用** → `?t=…` 被算进文件名 → `existsSync` 落空 → 报「读不出来」。
     同一份解析在 `mediaEditingRouter` 里还抄了一份，所以「编辑/裁剪一张刚生成的图」也是同一个坑。
- **改法（两半都改，生效方式不同）**：
  1. host：新增 `mediaStore.parseMediaUrlRef()`（相对/绝对/带查询串/带锚点一律先归一到 pathname，
     再切三段），`localPathForUrl()` 与 `mediaEditingRouter` 的副本都改成走它；
  2. 画布：vendor 补丁 **3.8l** —— `withoutCacheStamp()` 在**出请求体前**摘掉本插件素材 URL 上的
     缓存戳（`inputMedia()` / 「AI 高清放大」两处）。公网签名直链（方舟 24h 链接、FisherAI 回传直链）
     的查询串是签名的一部分，**不碰**。
- **顺带修的文案**：素材是「本插件素材 URL 但文件已不在库中」时，以前会落进「外链图片请先下载到素材库」
  那条（方向说反了，用户会去重复上传一张画布上看得见的图）。现在回 `404 CHANNEL_REFERENCE_MISSING`
  /`ARK_REFERENCE_MISSING`，文案是「参考素材已不在素材库里：<文件名>。请重新选一张」。
- **顺手治了构建不确定性**：Tailwind v4 默认会**扫整个仓库**（只认 `.gitignore`），于是 `.dsh-tmp`
  里随手留的备份/测试日志也会被当成 class 来源 —— 同一份源码在「工作区」与「已装插件」两处编出
  不一样的 CSS（实测多出 `.\!start` / `.bottom-1` 这类没用的工具类，差 1～2 KB）。
  `tailwind-entry.css` 改成 `@import 'tailwindcss/utilities.css' layer(utilities) source(none);`
  关掉自动探测（只认那三条 `@source`），并把 `.dsh-tmp/`、`.dsh-build/` 写进 `.gitignore`。
- **回归**：`test:ark` 80 → **84**、`test:cloud-channels` 119 → **124**、`test:media` 87 → **88**、
  `test:cloud-canvas` 19 → **26**（新增「拿刚生成的图当参考图再生成一次」端到端：画布里点第二个节点
  → 假方舟收到的 `image` 是 data URL、且字节等于上一张结果图）。全量 **24 套 1558 项**。
- ⚠️ 两半的生效方式不同：**画布半边刷新页面即生效**（已装插件的 `canvas-app.js` 是 no-store 每次读盘），
  所以「修那张三条腿的图」现在刷新页面就能重试；host 半边（`mediaStore`/`cloudChannels`/`arkImageProvider`，
  保障本地 ComfyUI 参考图、图片编辑、资产库复制这些走同一套解析的路径）**要重启一次 DSH**。

### v1.33：画布平移时网格比节点快（几何里混进了 dpr）

用户原话：「移动画布的时候背后的网格和节点移动的速度不一致，网格的速度快，节点慢。」

- **根因**（`src/client/canvas/canvasGrid.ts`）：底纹是「世界坐标里的一层贴纸」，做法是把画布的
  `transform` 读出来喂给 `background-position` / `background-size`。但读出来之后**乘了
  `devicePixelRatio`**：`--canvas-grid-pan-x = translate × dpr`、`background-size = 24px × zoom × dpr`。
  CSS 背景的几何单位**永远是 CSS px**，于是网格位移 = 节点位移 × dpr ——
  **本机缩放 125%（dpr=1.25），网格正好比节点快 1.25 倍**，格子也跟着大了 1.25 倍。
- **为什么一直没被发现**：两套回归都跑在 dpr=1（jsdom 恒为 1；`browser-check` 带着
  `--force-device-scale-factor=1`），乘子等于没写；jsdom 里那条断言甚至写的就是 `panX === -120 * dpr`。
- **修法**：
  1. 平移/缩放变量**原样写**（`panX` / `zoom` 都是 CSS px，一个 dpr 都不掺），`background-size` 只乘 zoom；
  2. 去掉 `background-attachment: fixed` —— 它的定位面积是**视口**，格子相位会随「画布原点 / zoom」
     漂移、与节点脱节；改成相对画布原点定位，「世界坐标贴纸」的语义才精确；
  3. `--canvas-grid-dpr` 保留但**只作读数**（排障时要能看出这台机器是 100% 还是 125%）。
- **排查读数**：`canvasGridReport()` 多了 `geometry: 'css-px'` 与 `panMatchesTransform`
  （网格层写的平移是否等于画布 translate —— 真机再报「网格比节点快」时先看这两个数）+ `devicePixelRatio`。
- **回归**：`test:grid` 61 → **67**（新增：样式表里不许出现 `var(--canvas-grid-dpr)` / 边长只有一个乘子 /
  不用 fixed 定位 / 把 jsdom 的 `devicePixelRatio` 改成 1.25 与 2 再平移一遍，变量必须一动不动）。
  真机新增 **`grid-pan` + `grid-pan-hidpi`** 两场（同一块空画布，分别用
  `--force-device-scale-factor=1` 与 `1.25` 启动）：画布平移 160px → 网格背景也必须移 160px。
  修复前 1.25 那场量到 **-200px（= 1.25 倍）**、格子 30px；修复后 -160px（ratio 1.0000）、格子 24px。
- ⚠️ 这轮**只改浏览器半边**：同步到已装插件并重建后，**刷新画布页即可，不用重启 DSH**
  （按 `verify-live-canvas-bundle` 的口径核过：活服务 `/api/aifisher/canvas-app/canvas-app.js`
  与磁盘构建同 sha256）。

### v1.34：提示词不再沿上游谱系串味

用户原话：「提示词输入出现污染问题，前面的提示词会输入到后边的提示词」。

- **根因**：上游 `generationScheduler.buildPrompt()` 收集「正文」时是**沿 `parentIds` 一路往上爬**的 ——
  把整条上游谱系里所有非空正文的 Text 节点都捞出来，按 `y` / `x` 排个序拼成一段，再接上本节点自己的
  `prompt`。于是一条再普通不过的改图链就串味了：

  ```
  Text（整段场景描述） → 图片 A → 图片 B（输入框里只有「修复一下，人物出现了三条腿」）
  ```

  B 的输入框里只有那句话，真正发出去的却是「整段场景描述 + 那句话」。**证据在素材库侧车**：
  `media/<项目>/images/<文件>.json` 里 B 那条结果的 `prompt` 就是拼接后的全文
  （本机实测 = 整段草原场景描述 + `\n` + `修复一下，人物出现了三条腿`）。模型拿着完整场景描述整张重画，
  改图越改越坏。
- **口径**：输入框里显示什么，就只发什么 —— 同步链路 `resolveConnectedText()` 的注释写的也是
  「只把**第一个直接连入**的 Text 节点作为实时文本源」，两处语义本来就该一致。
- **修法**：vendor 补丁 **3.8m**（`scripts/vendor-aifisher.mjs`，锚点断言「恰好命中 1 次」）——
  `buildPrompt` 的上行遍历只走**直接父节点**，不再递归祖辈；节点自己的 `prompt`、`textContent`
  （Text 节点正文）、创意预设、图片角度都不动。**直连文本节点照旧生效**（把文本节点接在提示词槽上
  仍是标准用法），只是不再「隔空继承」。
- **回归**：`test:render` 24 → **31**（新增 7 项，全部跑在**构建产物** `lib/canvas/canvas-app.js` 里真正
  在用的调度器上）：直连正文仍进请求 / 隔一层不再继承 / 第三跳也不继承 / 直连两个文本节点按 y-x 序
  拼接 / 文本节点「自己正文 + 直连文本父节点」照旧 / 「接进来的正文 + 自己的提示词」拼接顺序不变。
- **真机**：新增 `scripts/verify-live-canvas-bundle.mjs` —— 用本机授权 cookie 直接问**正在跑的 DSH** 要
  `/api/aifisher/canvas-app/canvas-app.js`，跟磁盘构建产物比 sha256（证明「刷新页面拿到的就是这份」）。
- ⚠️ 这轮**只改浏览器半边**（vendor 补丁 + 画布产物）：把源码同步到已装插件并重建后，**刷新画布页即可，
  不用重启 DSH**。

### v1.35：参考素材上传被瞬时掐断（`ECONNRESET`）不再变成「生成不了」

用户报障（2026-10-17，一张节点截图 + 三个字「报错了」）：节点上红字写着

```
上传参考素材到通道「Fisher」失败：fetch failed（ECONNRESET）
（确认这台机器能访问该地址；FisherAI 的参考图必须先传成公网直链（不是 base64）。）
```

- **先取证，别急着改**。三步都指向「同一条链路、不同时刻」：
  1. 独立进程直连真实端点：`POST https://api.work-fisher.com/v1/files/upload` 连传 3 次（760B / 2.15MB / 2.15MB）
     **全 200**（0.8s / 8.4s / 4.1s），回来的都是腾讯云 COS 签名直链；
  2. 在**正在跑的 DSH 进程里**把通道换成本机回环假端点：收到的 multipart 字节数 = 2,252,178B（与素材文件一致）、
     `content-type: multipart/form-data`、UA 是 `node` —— 说明「在 app 里发多部分表单」这件事本身没问题；
  3. 在 DSH 里用**真实端点 + 一个不存在的模型 ID**（对端必回「No available channel for model」，零计费）连跑 3 轮，
     `files/upload` 都通，只有提交那步被拒。
  结论：地址、路径、字段、密钥都对；是这条 Cloudflare 链路偶发中断（本机对它也早有「约 1/6 次连接 10.5s 超时」的记录）。
- **真正的 bug 在重试口径**：`uploadChannelAsset` 以前只重试「连接阶段失败」那几个码
  （`UND_ERR_CONNECT_TIMEOUT` 等，见 `isConnectLevelFetchFailure`），`ECONNRESET`（已经发出去又被重置）
  一出现就直接抛给用户 —— 一次瞬时中断 = 这张图永远生成不了。可上传这条路**免费、无副作用**（最坏是对象存储里
  多一个同样的文件），完全可以重放。
- **修法**（`src/host/generation/cloudChannels.ts`）：
  1. 新增 `isRetryableUploadFailure()`：`ECONNRESET` / `EPIPE` / `ETIMEDOUT` / `ECONNABORTED` /
     `UND_ERR_SOCKET` / `UND_ERR_CLOSED` / 连接类码，以及 undici 折成一句 `socket hang up` 的那些，都重试；
     **只给上传用** —— 提交生成请求重放会重复计费，那边仍然只认「一个字节都没发出去」。
  2. 最多 3 次、总预算 180s；**每次尝试都换一条新的 `AbortSignal.timeout`**
     （原来是一条信号复用三次，第一次超时会把后面几次一起毙掉）。
  3. 换回来的直链按「通道 baseUrl + 字节 sha1」缓存 **12 小时**（签名直链本身约 24h 过期，缓存上限 64 条）：
     同一张参考图再生成时不必重传 2MB 上行 —— 这同时把「偶发中断」的暴露面从「每次生成」降到「第一次」。
     读数：`GET /api/aifisher/canvas/status` 的 `cloudChannels.uploads`（entries / maxEntries / ttlMs），
     或 `channelUploadCacheReport()`；回归里用 `resetChannelUploadCache()` 清。
  4. 一直断时的回执能自解释：`上传参考素材到通道「Fisher」失败（2.2MB，试了 3 次 / 12.4s）：fetch failed（ECONNRESET）`
     + hint「这一步免费、可安全重试；每次都断查代理/VPN」。
- **回归**：`test:cloud-channels` 124 → **130**（新增 6 项，假端点用 `socket.resetAndDestroy()` 造**真的 RST**）：
  同一份字节第二次生成只有 1 次 `/files/upload`（缓存命中）/ 掐断一次 → 自动重试后生成 200（attempts=2）/
  一直断 → 502 `CHANNEL_UPLOAD_UNREACHABLE` / 回执含「试了 3 次」「MB」「ECONNRESET」/ 一直断时**没有**发出
  `/image/generations`（不生成、不计费）/ hint 含免费可重试 + 代理方向。
- **真机（免费）**：新增 `scripts/verify-live-channel-upload.mjs`（`pnpm verify:upload`）——
  取真实的 work-fisher 通道 + 素材库里最新那张图的真字节，走 `files/upload`，再用**不存在的模型 ID** 提交拿零成本回执。
  本机实测两次：
  - 工作区构建：2.15MB / **7.2s** 上传成功；
  - **已装插件**构建：第 1 次尝试 10.6s 撞上 `UND_ERR_CONNECT_TIMEOUT` → **自动重试后成功**（总计 25.6s）——
    这一条正是旧代码会直接甩给用户的场景，现在它自己过去了。
  （随后那句 `No available channel for model aifisher-canvas-upload-probe` 是探针故意用的假模型，零成本、预期之内。）
- ⚠️ 这轮改的是 **host 半**：同步到已装插件并重建后，**要重启一次 DSH** 才会生效。

### v1.36：画布顶部重排（返回项目库 / ComfyUI 胶囊左移 / 任务队列上移）+ 头部被画布盖住

用户原话：「在画布左上角添加返回项目库按钮；把右上角的 comfui 待启动移动到左边。任务队列往上移；」

- **顺手挖出来的真 bug：整条头部其实一直被画布盖住。** shadcn 重写 `CanvasHeader` 时把 vendor 那行的
  `z-50` 与 `bg-[var(--af-surface)]` 丢了（`bg-surface` 在主题里根本不存在），而 vendor 的
  `#canvas-background` 是不透明底、DOM 顺序又排在 Header 之后 —— 于是真机上**项目名 / 品牌下拉 /
  保存状态全部看不见也点不到**，只剩自带 `z-index:70` 的 ComfyUI 胶囊浮在画布上。
  老回归量的是「盒子在不在」（盒子一直在、尺寸也正常），所以天天绿。现在头部补回
  `z-50` + `bg-[var(--af-surface)]`，并在 `browser-check` 加了一条**命中测试**（`header.onTop`：
  在头部左端 `elementFromPoint`，命中元素必须属于头部）+「z-index 不是 auto」「底色不透明」两条。
- **返回项目库**：头部左侧第一个可交互件（左箭头 +「项目库」，`aria-label="返回项目库"`、
  `data-fisherai-back-to-library`），点击走 vendor 的 `onBack`（回项目看板）。以前回看板只有品牌图
  下拉里的「退出项目」，而那个下拉正在被盖住的那一块里 —— 等于没有出口。
- **ComfyUI 胶囊左移**：头部左侧工具条新增槽位 `[data-fisherai-comfyui-slot="true"]`；
  `scripts/vendor-aifisher.mjs` 新增 **3.8n 补丁**（两条锚点，各断言命中 1 次）：`dockComfyPanel`
  优先 `slot.append(host)`、`host.dataset.dock='topbar-left'`、下拉面板贴着胶囊左缘向下展开；
  找不到左侧槽位（项目看板视图没有这个头部）才回落到原来的账号插槽 / body 左下角。
- **任务队列上移**：面板 `top:60 → 8`、窄轨同步 `top:8`（`CanvasTaskQueue.tsx`）；两者还会往画布
  容器写 `--fisherai-task-queue-inset`（展开 306px / 窄轨 44px），头部用它做 `padding-right`，
  把「已保存 HH:MM」徽标让到面板左侧，而不是被压在下面。
- **回归**：`test:canvas-ui` 102 → 112（返回项目库按钮可访问 + 真点一次回看板、左侧胶囊槽位、
  头部 z-index/底色/padding 契约）；`test:task-queue` 97 → 100（`top:8`、`gapTop=8`、inset 变量
  展开 306 / 收起 44）。`browser-check` canvas 场景新增 4 条（返回项目库真可见 + 命中测试落在头部、
  胶囊停在头部左半边、`dock=topbar-left`、头部真的压在画布之上），task-queue 场景新增 1 条（`gapTop`）。

### v1.37：叠图「切换」（折叠起来的那一叠，不展开也能翻看）

用户原话（2026-10-17，附一张「3 张叠图 · 展开」的画布截图）：
「给这种折叠起来的图添加一个切换按钮」。

- **原来的问题**：v1.21 的折叠把选中的图**从文档里摘出来**塞进宿主节点的 `stackItems`，
  宿主卡后面垫两层纸、左下角一个「N 张叠图 · 展开」。但卡上**永远只看得见宿主那一张** ——
  想看叠在下面的另外两张，只能点「展开」（节点摊回画布）→ 看完再重新多选 + 折叠，来回好几趟。
- **做法**：宿主卡左下角那条徽章扩成控制条 —— `N 张叠图 | 切换 2/3 | 展开`。
  点「切换」= 把叠在下面的下一张**提成宿主卡**（环形，点到底自动绕回第一张；`Shift+点击` 往回翻）；
  计数实时写「现在第几张 / 共几张」。
- **换的是内容，不是渲染**（关键取舍）：内容字段（标题 / 提示词 / 结果图 / 模型 / 参数 / 状态…）
  与被提上来的那张**整组交换**，壳字段（`id` / 位置 / 类型 / 尺寸 / `parentIds`）一律不动：
  - `id` 不动 ⇒ 连线、生成结果、任务队列、素材引用都还指着同一个节点，不会「一切换就断线」；
  - 位置不动 ⇒ 切换时卡不跳；
  - 真换内容 ⇒ v1.34 那条「看到什么就发什么」不用破：切到第 2 张之后点生成，发出去的就是
    第 2 张的提示词，不会拿第 1 张的提示词去重画。
- **落点**：
  - 算法是纯函数 `src/canvas-ui/canvas/CanvasStack.ts`（`rotateStackHost` / `stackPositionOf` /
    `stackCounterOf`，天然可回归；`mount.tsx` 转出给回归直接调）；
  - 装配层 `bootstrap.ts` 注册成 `window.__FISHERAI_STACK_ROTATE__`（两份 React + 两个模块实例，
    只能靠全局桥）；
  - vendor 补丁 **3.8o**（`scripts/vendor-aifisher.mjs`，4 条锚点各断言命中 1 次）：
    `__FISHERAI_CANVAS_STACK__` 加 `rotate(hostId, step)`（只有 `canvasApplication` 的 effect
    够得着 `setNodes`）+ 宿主卡那条控制条的 JSX + 窗口桥的类型声明。
  - 结构契约：`[data-fisherai-stack-controls]`（带 `data-fisherai-stack-total/-position`）、
    `[data-fisherai-stack-switch]`（aria-label「切换叠图（当前第 N/M 张，点击看下一张）」）、
    `[data-fisherai-stack-badge]`（旧的「展开」，位置与语义都没变）。
- **回归**：新增 **`test:stack` 43 项**（一半是纯函数：环形顺序、`Shift` 往回拨之后再往前拨方向不反、
  壳字段不动、三张一张不丢、不改入参；另一半是真 jsdom 点击：控制条/计数/小标题跟着换、卡不跳、
  不凭空多节点、存盘后 `stackPosition` 与内容都在文档里、点「展开」仍是 1 → 3 个节点且三张图都在）。
  全量 **25 套 1637 项**。
- **真机**：`browser-check` 新增 **`stack` 场景**（一叠 3 张红/绿/蓝 PNG）：量控制条在卡里且可见、
  `elementFromPoint` 命中「切换」按钮自己（守住「布局对但被盖住点不动」）、真点一下图换成第 2 张
  且计数 2/3、连点三下绕回第 1 张、画布节点数始终 1。交付图 `docs/shots/canvas-stack-switch.png`
  （停在「第二张 / 切换 2/3」）。
- ⚠️ 这轮**只改浏览器半边**（vendor 补丁 + 画布产物）：同步到已装插件并重建后，**刷新画布页即可，
  不用重启 DSH**。

### v1.38：「AI 高清放大」换成「扩图」+ 生成不再自己偷偷跑 + 尺寸对话框 nova 版

用户原话（2026-10-17，附一张图片节点工具条的截图，指着上面那个 HD 按钮）：
「把这个功能移除，替换成扩图功能；还有一点，这里的功能点击生成后模型走的是之前的通道。
做一个调整，点击生成后不直接生图，先输出一个空的图像生成节点，填好提示词，由我来点击最后的生成；
尺寸节点的ui还没有更新；检查其他类似的功能是否正常」。

- **拿掉的是什么**：那个 HD 按钮是上游的「AI 高清放大 · SeedVR2」——点了**直接生图**，
  请求写死在 `SeedVr2ImageProvider`（RunningHub 国内站，要另外绑那份 Key，本插件也没有这条后端）。
  这一轮把按钮、状态查询、弹窗、`useCanvasImageUpscale` 的 hook 调用、模型目录里那条
  `SeedVR2 高清放大 · RH` 条目一起删了（vendor 补丁 **3.8p**）。
- **换成「扩图」**（`src/canvas-ui/canvas/CanvasOutpaint.ts` 纯逻辑 + 工具条覆盖文件里的面板）：
  选「方向（四周 / 左右 / 上下 / 左 / 右 / 上 / 下）+ 目标比例」，点「创建扩图节点」——
  它**不生图**，只往画布上落一个**空图片节点**：提示词已经写好（“基于参考图向外扩图……目标画幅比例 16:9”）、
  原图已经连成参考图、模型 = 你当前通道里的图像模型；生成按钮就在新节点上，由你自己点。
- **「模型走的是之前的通道」怎么修的**：上游「角度 / 全景图」那两个草稿原来写死
  `IMAGE_MODELS.find(endpoint === 'workfisher-image-g-v2.5-lowprice')` —— 永远挑那条 Relay 旧通道
  （本插件没有后端，点了只回 501）。现在统一走「用户通道里的图像模型优先」（`cloudChannelId` 标记），
  解析不到才退回目录里第一个能图生图的；面板上会写明「你的通道」。顺带：全景图原来写死 `2:1`，
  而通道模型的比例表里没有 2:1 —— 现在按「2:1 → 最接近 2.0 的 16:9 → …」降级，不塞模型不认的比例。
- **不再自动生成**：`onPanorama` / `onAngle` 建完草稿原本紧跟一句 `void handleGenerate(result.id)`，
  于是用户还没看见节点、没挑模型，图就已经发出去了。这一句删掉（补丁 3.8p 里断言命中 2 次），
  面板里的按钮语义也跟着改成「创建全景图节点 / 创建角度节点」、文案不再宣称走「GPT2.5 低价版」。
- **尺寸对话框 nova 版**（`src/canvas-ui/canvas/CanvasImageResize.tsx`，换的是 `Resize` 槽位）：
  原来是一整块铺满窗口的浮层（原生 range + 手写样式），现在是画布里的紧凑卡片 ——
  倍数滑杆 + 数字、快捷倍率 0.5x/1x/2x/4x、宽 / 高输入、预览与「原图 → 目标」读数、保存关闭。
  **像素语义一字没动**：换算仍走 vendor 的 `resizeDimensions` / `resizeLimit`，保存仍走
  `saveResize`（上传素材库 → 画布上新建一张图）。
- **结构契约**（回归与真机都靠它）：
  工具条 `[data-fisherai-outpaint-trigger]`；面板 `role="dialog"` + `aria-label="扩图"` +
  `[data-fisherai-outpaint-panel]`（带 `data-fisherai-outpaint-model`）、方向
  `[data-fisherai-outpaint-direction="all|horizontal|vertical|left|right|up|down"]`、
  比例 `[data-fisherai-outpaint-ratio="16:9"]`、创建 `[data-fisherai-outpaint-create]`；
  尺寸对话框 `[data-fisherai-image-resize]` + `[data-fisherai-resize-dimensions]`
  （`data-original` / `data-target`）+ 快捷倍率 `[data-fisherai-resize-preset]` +
  保存 `[data-fisherai-image-save="resize"]`。
- **回归**：新增 **`test:outpaint` 65 项**（纯函数：提示词/标题/落点/比例、模型必须来自通道、
  脏输入给中文错误；真 DOM：工具条 HD 没了、面板开合、真点「创建」→ 画布多一个**空**节点、
  一条 `/generate-image` 都没发、存盘后提示词/模型/连线都在；顺带守「全景图 / 角度」两种草稿都不再自动生图、
  模型都是通道模型、比例落在该模型支持的表里）。
  扩展 **`test:canvas-ui` 112 → 137 项**（尺寸对话框结构契约 + 扩图面板结构契约）。
  全量 **26 套 1727 项**。
- **真机**：`browser-check` 新增 **`outpaint` / `outpaint-panel` / `resize` 三场**：
  - `outpaint`：工具条 HD 没了 → 开面板 → 选四周+16:9 → 创建 → 画布上多一个**空**节点、
    标题「扩图 · 四周 · 16:9」、composer 里能看到填好的提示词；并且 **host 一整场没收到任何
    `/generate-*` 请求**（这才是「不直接生图」的硬证据）；
  - `outpaint-panel`：只停在面板上（交付图：方向 / 比例 / 模型 / 「你的通道」）；
  - `resize`：真开 nova 对话框 → 320×240 原图 → 点 2x → 640×480 → 保存 → 画布上那张新图的
    **自然尺寸真的就是 640×480**（像素语义没被换壳改坏）。
  交付图 `docs/shots/canvas-outpaint.png`、`canvas-outpaint-panel.png`、`canvas-resize.png`。
- ⚠️ 这轮**只改浏览器半边**（vendor 补丁/覆盖 + 画布产物）：同步到已装插件并重建后，
  **刷新画布页即可，不用重启 DSH**。

### v1.39：扩图改成「先出一张图，再接图像生成节点」

用户原话（2026-10-17，附两张参考图：一张是带「目标比例 / 原图位置 / 延展内容」的扩图面板，
一张是画布上「原图 → 扩图画面 → 扩图 · 21:9」的节点链）：
「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」。

- **以前只落一个空节点，现在先落一张真图片**：点「生成扩图画面」→
  ① 浏览器里把原图画进一张更大的画布（目标比例 + 原图位置九宫格；扩出去的区域是**透明**），
  PNG 交给 host 现成的 `POST /media/images/annotation` 落进素材库 → 画布上多一张图片节点
  **「扩图画面」**（标题带真实像素，如 427x240）；
  ② 再建一个空的 `扩图 · 16:9` 节点：`imageMode=image-to-image`、提示词已填（含你写的延展内容）、
  **参考图连的是那张扩图画面**、`status:'idle'` —— 生成仍由你点（v1.38 那条口径没变）。
- **几何**（`CanvasOutpaint.ts` 的 `outpaintGeometry`）：只朝一个方向长（目标更宽 → 高度不变补宽，
  更高 → 宽度不变补高），原图一个像素都不重采样；九宫格决定原图贴哪一侧、哪几边是新画面
  （贴右 → 左边 107px 留白）；超过 4096 才整体等比缩。提示词由留白反推措辞
  （向四周 / 向左右两侧 / 只向画面右侧…）。
- **面板**（工具条覆盖文件）：目标比例（两行、顺序照参考图）+ 原图位置九宫格（aria-label「原图位置 左上…」
  + `aria-pressed`）+ 延展内容（可空）+ 左侧预览（原图按目标比例/位置摆进去，虚线框 = 原图边界，
  棋盘格 = 待补区域）+ 底部「先出扩图画面，再接一个图像生成节点；生成由你点」。
- **顺手修的**：工具条容器 `zIndex:110` —— 节点 composer 是 `z-[100]`，不提的话扩图面板下半截
  （延展内容 / 按钮）会被它盖住（真机截图取证发现）。
- **回归**：`test:outpaint` 65 → **97 项**（几何/预览/两张节点/扩图画面真落盘 427×240/一条生成请求都不发）；
  `test:canvas-ui` 137 → 140（面板结构契约改成九宫格 + 预览）；
  真机 `outpaint` / `outpaint-panel` 两场重做（真机解码出 427×240、留白那条 RGB 全 0、
  按钮中心 `elementFromPoint` 命中面板自己）。全量 **26 套 1762 项全绿**。
- ⚠️ 仍然**只改浏览器半边**：**刷新画布页即可，不用重启 DSH**。

### v1.40：新建节点默认用上一次的模型

用户原话（2026-10-18）：
「我刚建完一个节点后需要我再次调整模型，可不可以改成新的节点会默认使用上一次生成任务所使用的模型」。

- **现状**：新节点的默认模型 = **模型目录里的第一个**（本插件里就是你在设置里勾的第一条通道模型，
  见 `CloudChannelModels` 的 `splice(0,0,…)` + v1.31 的补丁 3.8i）。只要你在第一款/第二款模型之间来回用，
  每建一个节点就得再挑一次下拉 —— 这条特性就是把这个动作省掉。
- **记的时机**（两处，vendor 补丁 **3.8q**）：
  1. 在节点上换模型（画布下拉 / composer 的 `changeComposerModel` → `updateCanvasNode`，patch 里带
     `imageModel` / `videoModel` / `audioModel` / `textModel`）—— 换完就记，不必等点生成；
  2. 真发起一次生成任务（`canvasGeneration.handleGenerate` 拿到 `modelName` 的那一刻）——
     这是你嘴里的口径「上一次**生成任务**所使用的模型」，也覆盖「模型是程序设的、没经过下拉」的路径。
  两处都 `try/catch` 包住：记忆层坏掉最多是「默认模型又回到目录第一个」，绝不拦住建节点/改模型/生成。
- **用的时机**（一处）：`createCanvasNode` 建新节点前按 kind 问一次
  `__FISHERAI_LAST_MODEL__(kind, names)`。它**只返回还留在目录里的名字** —— 通道被删、模型被取消勾选、
  别名被改了，就返回空串，`createCanvasNode` 照旧回落目录第一个。这条是硬要求：
  v1.31 用户报的「新建节点默认模型不是我配置好的」正是「节点写成一条本插件没有后端的模型，点生成只回 501」，
  这条特性绝不能把它带回来。
- **落点**：本机 `localStorage` 的 `dsh-aifisher-canvas.last-model`（形如
  `{"image":"Fisher · workfisher-image-g-v2.5-sunburst",…}`，按 图片/视频/音频/文本 分桶）。
  这是「这台机器上我上次用了什么」，与项目数据无关，所以**不进** `canvas.json`（也不跨机器同步）；
  隐私模式下 localStorage 不可用时退化成「本次会话内内存生效」，功能照常。
- **桥**：算法与存储在 `src/canvas-ui/canvas/CanvasLastModel.ts`（纯函数，回归直接验这一份）；
  装配层 `bootstrap.ts` 的 `installCanvasLastModelSupport` 把它注册成
  `__FISHERAI_LAST_MODEL__` / `__FISHERAI_REMEMBER_MODEL__`（vendor 三处都读它），
  另外挂 `__FISHERAI_CANVAS_LAST_MODEL__`（`report()` / `pick()` / `remember()` / `reset()`）给回归与排障用。
  ⚠️ 桥**同时写 `window` 与 `globalThis`**：浏览器里同一个对象，jsdom 里不是（vendor 读 globalThis、
  回归读 window；与 v1.37 的 `__FISHERAI_STACK_ROTATE__` 同一个坑）。
- **排查读数**：`canvasAppBuildInfo().lastModel` 或页面里 `__FISHERAI_CANVAS_LAST_MODEL__.report()`
  → `models`（四个桶各记的是谁）/ `storage`（ok / unavailable）/ `writes`（写盘次数）/ `hits` / `misses`
  （`misses` 就是「记着的模型已经不在目录里」的次数 —— 新节点又用回第一个模型时先看这个数）。
- **回归**：新增 `test:last-model`（**39 项**）—— 纯逻辑（分桶/削空白/坏存档/脏值/非法 kind/写盘次数/
  pick 命中与未命中）、画布内真行为（**真点模型下拉**换到第二款 → 节点存盘换掉、记忆跟着换 → 再新建节点
  默认就是它；记忆的模型不在目录里 → 回落第一个；图片记忆不串到视频节点；**真点一次生成**也会记）、
  产物与补丁存在性（三个桥名 / 存档键 / 3.8q 三处锚点）。
  真机新增 `last-model` 场景（9 项）：真建三个图片节点 —— 没记过 = 通道别名「魔搭出图」/ 记一次 =
  那一款 / 已建好的旧节点不动 / localStorage 留证 / reset 后回到第一个。
- ⚠️ 仍然**只改浏览器半边**：**刷新画布页即可，不用重启 DSH**。

### v1.41：任务队列只在画布层 / 新对话输入区贴底 / 数据存放与换机迁移

用户原话（2026-10-18，一句话里三件事）：
「这个插件的缓存数据是怎么保存的？如果换电脑怎么把项目迁移过去；任务队列希望只出现在画布这一层，
现在点击设置啥的都看的见任务队列；右侧聊天面板新对话默认会顶头不好看，希望移动到最地下。」

**① 任务队列只在画布这一层**

- **根因**不是层级写太高，而是面板**不属于画布图层**：它被 portal 到画布容器里、`right:12/top:8` 绝对定位，
  看起来像画布的一部分；而 vendor 的设置是 `fixed inset-0 z-[100]`（媒体预览 z-100、资源库 z-50…），
  面板为了压住节点上的浮层（工具条 / composer）一路写到了 `z-[11000]` —— 于是**任何 z<11000 的接管型浮层**
  打开时，任务队列都浮在它上面。只有工作流配置（11900）/ 工作流节点（11950）/ 节点搜索（12000）
  碰巧比它高，所以只有「设置 / 媒体预览 / 图片编辑」这几处露馅。
- **修法（一条 CSS，不登记浮层）**：vendor 的接管型浮层全部经
  `design/modalFocus.ts` 的 `activateModal()` 打开，它在打开期间沿浮层路径给**所有兄弟节点**加 `inert`、
  关闭时还原。本面板是画布容器的直接子节点、与画布应用根节点并列 → 浮层一开它就带 `inert`。
  所以 `CanvasTaskQueue` 的样式表里加一条 `[data-fisherai-task-queue][inert] { display: none !important }`
  （`inert` 只禁交互不隐藏，必须显式 `display:none`；关闭浮层后属性被摘掉，纯 CSS 立刻回来，不用重渲染）。
  好处：**以后新加的浮层自动对齐**，不用维护选择器清单。
- **真机怎么验**：`browser-check` 新增 `queue-layers` 场景 —— 基线（画布层上 286px 宽、无 inert）→
  开设置（`display:none` + `inert=true` + 原位置 `elementFromPoint` 不再命中队列）→ 切「画布外观」仍然看不到 →
  关掉设置面板回来。jsdom 侧 `test:task-queue` 真开一次设置，守「面板真的拿到 inert、关掉真的被摘掉」。

**② 右侧会话栏「新对话」输入区贴底**

- **根因**（读 DSH 客户端 `dsh-client-ui-conversation` 骨架确认）：空白会话的 `DefaultConversationViews`
  直接 `return null`，于是 `[data-conversation-scroll]` 里只剩一个 `flex:none` 的 `[data-composer-seat]`；
  内核只在 hero phase 写 `justify-content:center`，而本栏刻意固定 `phase:'active'`（不渲那一大坨 hero 标题），
  active phase 只让 `.viewArea{flex:1 0 auto}` 撑高 —— 空白会话连 viewArea 都没有，输入框就顶到了栏头下面。
- **修法**：`CanvasChatDock` 的样式表加
  `[data-dsh-aifisher-chat="body"] [data-conversation-content] > [data-conversation-scroll] > [data-composer-seat] { margin-top: auto }`。
  空白会话 → 自动外边距把输入区推到最底；有正文的会话 → `.viewArea` 已经吃掉剩余空间，`auto` 解析成 0，
  滚轮/粘底行为一个字不变。不用 `justify-content:flex-end`（可滚动 flex 容器里会让溢出到顶部的正文滚不到）。
- **真机怎么验**：`scripts/verify-live-dock.mjs` 里用**真会话的真实 class** 起一个空白会话骨架做 A/B ——
  带着本栏样式时输入区贴底（seat 底边 = 滚动区底边），临时摘掉本栏样式就复现「顶头」；证明是这条规则在起作用。

**③ 数据存放与换机迁移**：新增 `docs/storage-and-migration.md`（README 的「数据目录与本地后端」
补了同一份的速查版）。结论一句话：画布数据只有 `$DSH_HOME/storages/dsh-aifisher-canvas/` 一处，
换机器 = 装好同版本插件 + 整目录搬过去 + 重启 DSH；插件本体、DSH 会话记录、浏览器 localStorage 里的
5 个偏好都不在这个目录里（文档里逐项列清）。

- **回归**：`test:task-queue` 100→107（样式守卫 + 真开设置的 inert 行为）、`test:chat-dock` 39→40
  （输入区贴底规则的**精确选择器**）、`browser-check` 21→22 场景（新增 `queue-layers`）；
- ⚠️ 只改浏览器半边（画布产物 + client 产物）：**刷新画布页即生效，不用重启 DSH**。

### v1.42：项目归档（导出 / 导入）

用户原话（2026-10-18，整轮需求只有这一句）：「在无限画布面板做一个项目导出导入的功能」。

**之前缺的不是接口，是出口。** host 侧 v1.1 就有 `GET /workflows/<id>/backup`（下载）与
`POST /workflows/restore`（导入），但画布上：导出只有 agent 桥那一条（界面上点不到），导入埋在品牌
下拉的「导入项目 JSON」里、点了直接弹 file input —— 导完有没有成功、素材带没带过来、文件存到哪，
用户一概看不见。

**现在的样子**（画布头部左侧「项目归档」，紧挨「返回项目库」）：

| 区块 | 你能看到 / 做什么 |
|---|---|
| 导出 | `2 个节点 · 素材 2 个（3.4 MB）· 归档约 4.6 MB`；导出目录（= 素材下载目录，可改/可恢复默认）；**「导出到目录」**（host 落盘，回执直接给绝对路径）+「下载到浏览器」（备用）+「打开目录」 |
| 导入 | 「选择文件导入」（`.fisherai` 带素材 / 旧版 `.json` 文档）或直接填**绝对路径**点「从路径导入」（不经过浏览器上传）；导完自动切到新项目，并弹一句 `已导入「X」（12 个节点；素材 8 个已恢复）` |
| 项目库 | 项目列表页头部也有「导入项目」按钮 —— 不必先打开某个项目才能导 |

**为什么导出优先落盘而不是浏览器下载**：`.fisherai` 里素材是 base64，512 MiB 上限的归档过一次浏览器
内存不合适，而且 `a[download]` 在 Electron/无头环境下行为不一致。所以主路径是 host 直接写盘
（`POST /workflows/<id>/backup/save`，回执 `{path, fileName, bytes, mediaFiles, mediaOmitted}`）；
浏览器下载保留为备用按钮，且**不支持时明确指路**「用导出到本机目录」，不静默失败。

**几个刻意的口径**（改之前先对一遍）：

- **导入 = 新建项目**，永不覆盖现有项目（避免误伤）；代价是同一份备份导两次会有两个副本。
- **导出目录只收绝对路径**，且拒绝指向 `<画布数据目录>/media/**`；同名不覆盖（`名字 (2).fisherai`）。
- **导入会重写素材地址**：所有 `/api/aifisher/canvas/media/<旧项目id>/…`（含带 `?t=` 缓存戳的、
  以及旧的 `/library/media/…`）都改成新项目 id —— 素材文件按 base64 写进新项目目录。
- **旧版 `.json` 也认**：`{nodes: [...]}` 形态的画布文档（没有 `format` 外壳）当「无素材归档」导入，
  回执带 `legacy: true`，提示里说清「这种文档不带素材」。
- **看板那个按钮只能走 window 桥**：看板视图里 Controls 槽位（面板挂的地方）根本没渲染，
  所以 vendor 侧（`projectDashboardChrome` 的 DOM 注入）只调装配层注册的
  `__FISHERAI_PROJECT_ARCHIVE__.importFromPicker()`；而「导入后切到新项目」靠 vendor 补丁 3.8r 新增的
  `fisherai:open-project` 监听（`openProject` 只活在 `canvasApplication` 里）。

**排查读数**：`window.__FISHERAI_PROJECT_ARCHIVE__.report()` →
`{ infoReads, saves, downloads, imports, lastError, lastStatus, lastToast, routes }`
（`lastError` 是最近一次的 host 错误码，比如 `ARCHIVE_DIRECTORY_INVALID` / `ARCHIVE_FORMAT_UNKNOWN`）。

- **回归**：新增 `test:project-archive`（**100 项**：host 段 60 项 —— 规模预览 / 落盘导出 / 同名不覆盖 /
  导出目录边界 / 下载形态 / 三种导入形态与五种错误码 / 素材改写；jsdom 段 40 项 —— 头部入口、面板契约、
  真点导出落盘、真上传导入、从路径导入、看板导入、产物与文档守卫）；
- ⚠️ 这一版**改了 host 半**（`projectArchiveRouter.ts` + `mediaDownloadRouter.ts` 多导出一个读数函数）：
  **要重启一次 DSH**；画布半边照旧刷新页面即生效。

### v1.43：项目数据目录（缓存）可自定义

用户原话（2026-10-18，整轮需求只有这一句）：「设置里添加项目自定义缓存目录」。

在此之前插件把所有数据固定写在 `$DSH_HOME/storages/dsh-aifisher-canvas/`（项目 = `canvas.json`、
素材、资产库索引、通道表/密钥、工作流目录与配图、下载、画布背景、提示词、画布对话映射），
界面上没有任何入口 —— 想换盘只能整目录搬 + 动环境变量。

**现在**：**设置 → 存储 → 项目数据目录（缓存）**

| 你能做什么 | 会发生什么 |
|---|---|
| 看当前目录 / 默认目录 | 上面一行就是**这个进程正在用的**那个路径 |
| 填绝对路径（如 `D:\DSH数据\canvas`）→ 点「应用」 | host 先把现有数据**复制**过去（勾选框，默认勾上；只复制、不覆盖同名文件），再写指针；面板回「复制了 N 个文件（X MB）」+ **重启一次 DSH 才生效** |
| 重启后回来 | 那一行变成新目录，项目/素材/通道/密钥/工作流/下载全在新位置；`/status` 的 `dataDir` 也是它 |
| 点「恢复默认」 | 删指针，重启后回默认目录（**不删**你那份自定义数据，随时能切回来） |

**为什么是「重启生效」而不是热切换**：所有 store 都在 `apply()` 时按目录构造好了（canvas.json 已读进
内存、素材库定了 rootDir、工作流目录缓存、通道表…），运行时换目录要么到处漏、要么逐个重建；
换目录是低频操作，重启一次代价可接受，而且语义清楚。所以接口一律回 `restartRequired`，
面板文案**只说「重启之后生效」，不说「已切换」**（不重复 v1.31 那种「假成功」）。

**指针文件**：`<默认数据目录>/data-dir.json` = `{directory, savedAt}`。放在默认目录里的原因是
「数据搬走之后它还得找得到」（默认目录永远由 `$DSH_HOME` 算得出来）；放进目标目录就自指了。

**边界**：绝对路径；不能是文件；不能就是当前/默认目录；不能和它们互为父子；同目录再应用一次是幂等的。

- **回归**：新增 `test:data-dir`（**65 项**：host 段 —— 现状读数 / 五条边界 / 复制 / 指针 / **再起一个
  host 实例验「重启后真的用新目录」** / 恢复默认；jsdom 段 —— 真开设置 → 存储 → 面板读数 → 相对路径报错
  → 合法路径应用 → 状态变「还没生效」→ 恢复默认；外加产物与文档守卫）；
- ⚠️ 这一版同样**改了 host 半**：**要重启一次 DSH**（和 v1.42 那次可以并成一次重启）。

### v1.44：画布侧技能目录（在画布用技能 + 跟画布协作）

用户原话（2026-10-18）：「检查一下我是否能在画布正常使用skill技能，与画布进行协作」。

**查下来的结论分两半**：能用的那一半本来就通，不能用的那一半是 host 侧一个静默缺口。

| 这一环 | 结论 | 取证 |
|---|---|---|
| 画布右侧会话栏里能用技能 | ✅ 通 | 真机：技能按钮（`conversation.input.right` 槽位）就在画布会话栏的 composer 工具行里，点开列出**你的 10 条技能**，点一条把 `/技能名` 插进输入框；不用按钮、**直接在画布输入框里手打一个 `/`** 也会弹出同一批技能候选（内核 `inputTriggers` 在这个 embedded composer 里照样生效，`verify-live-skills.mjs`） |
| 技能/助手能操作画布 | ✅ 通 | `canvas_control` 是**全局注册**的 DSH 工具（host `ctx.tools.register`，不分会话），右侧会话栏渲染的就是同一个会话 —— 「选技能 → 发出去 → 它用 `canvas_control` 改画布」这条链不缺工具 |
| 画布侧「技能目录」（`canvas_control` 的 `skills`/`skillLoad`、`GET /api/aifisher/skills`） | ❌ 以前只能看到 4 条 bundled | 真机端点回 `count=4`（`diagnose-windows-sandbox-acl`/`office-docx`/`office-pptx`/`office-xlsx`），`/skills/image-prompt-generator` → **404** |

**根因**：文件系统技能 provider 挂在 **agent 作用域**（标准预设的常驻挂载），插件 host 上下文里的
`ctx.skills.list()` 只看得见 global（bundled）层 —— 用户层 `$DSH_HOME/skills` 与项目层 `<cwd>/.dsh/skills`
都在 agent 作用域里，host 侧问不到（`dsh-skill-picker` 的 host 半注释里记着同一个判断）。

**修法**（`src/host/skills/skillsRouter.ts` 重写，路由与 `canvas_control` 两个动作共用一份实现）：
按官方 provider 的**同一套根自己扫盘**，再与 `ctx.skills` 合并（同名以扫到的为准）：

| 优先级 | 根 | source |
|---|---|---|
| 最高 | `<会话 cwd>/.dsh/skills` | `project` |
| | `<会话 cwd>/.agents/skills` | `project` |
| | `$DSH_HOME/skills`（默认 `~/.dsh/skills`） | `user` |
| 最低 | `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`） | `user` |

- **项目层扫哪儿由发起调用的会话决定**：`canvas_control` 传 `exec.agent.session.cwd`，HTTP 端点收 `?cwd=<绝对路径>`
  （不传/相对路径就只扫用户层 —— 不拿进程 cwd 去猜，这正是 picker 0.5.x 踩过的「项目级技能静默消失」坑）；
- **枚举与加载同口径**：`user-invocable:false`、旧式 invocation 键（`userInvocable`/`modelInvocable`/`disableModelInvocation`）、
  只剩 `SKILL.disabled.md` 的技能一律**不列也读不到**（避免「列不出来但能加载」和「列出来但 `/名字` 是静默空操作」）；
- 扫盘跟随软链/junction、只认合法技能名（不会拿用户输入去拼路径）。

- **回归**：`test:backend` 66 → **81 项**（新增 15 项：用户层扫到 / bundled 层保留 / 同名以用户为准 /
  三种过滤 / 正文 UTF-8 原样 / bundled 取正文 / 404 边界 / `?cwd=` 项目层与同名覆盖 / 相对路径忽略）；
- **真机**：新增 `scripts/verify-live-skills.mjs`（画布会话栏技能按钮 → 面板列 10 条 → 点选插入 `/技能名`；
  手打 `/` 也弹同一批候选；技能目录两路取证：运行中的 host 端点 + **磁盘构建产物 + 真技能目录**，
  后者不用等重启就能下结论；收尾断言输入框已清空，不在你的会话里留草稿），
  交付图 `docs/shots/canvas-skills.png` / `canvas-skills-inserted.png`；
- ⚠️ 这一版**改了 host 半**：**要重启一次 DSH**（和 v1.42/v1.43 那次并成同一次重启即可），
  重启前画布侧技能目录仍是旧的 4 条。

### v1.45：节点搜索——一次回车只建一个节点 + Blender 式「新建并移动」

用户原话（2026-10-19）：「发现一个bug，是搜索工具的，点击回车后会出现两个节点。我希望点击确定
之后出现在画布里，但会继续跟着鼠标，再次点击左键才能算完成。对应blender新建并移动」。

**两个节点是同一个 Enter 被处理了两次**：`onPanelKeyDown` 同时挂在输入框和面板根上（面板根还要
接住从候选按钮冒上来的键），同一个 keydown 先被输入框处理一次、再冒泡到面板根处理一次 ——
两次 `commit()`、两次 `fisherai:add-canvas-node`，两个节点叠在同一点。处理过的键现在
`stopPropagation()`（顺手修掉 ↑/↓ 一次跳两格），commit 另有一道「一次打开只提交一次」的闸门。

**「新建并移动」落在 vendor 建节点桥里**（`scripts/vendor-aifisher.mjs` 3.8f 段，面板侧只传
`detail.place: true`）：节点按原落点建出来后，`pointermove` 按「屏幕位移 ÷ 画布当前缩放」更新节点
坐标（与 vendor 拖节点同一套算法，中途滚轮缩放不跳），并节流到 rAF；**下一次左键 `pointerdown`
= 放下**，这一次事件被 `preventDefault + stopPropagation` 吞掉（不吞会立刻开始拖这个节点，
点在空白处还会清掉刚建好的选中态）；Esc 或画布卸载也会结束跟随。不传 `place` 的调用方
（工作流库、browser-check 的合成事件）行为完全不变。

- 回归：`test:node-search` 新增 6 项（一次 Enter 只派发一次 / 只建一个节点 / 跟随位移 +40/+24 /
  放下时左键被拦下 / 放下后不再跟手且移动后的位置真的存盘 / 工具栏入口也能建节点），并把
  「按一次 ↓ 只走一格」钉住；`browser-check` node-search 场景真机量了「+60/+40 跟手、放下后 0 位移」
  （量之前临时关掉网格探针的合成 pointermove，否则会被它冲成 0）；
- 顺带修好工具栏入口的静默失败：没有鼠标位置时落点回落到画布正中（以前事件里没有合法 `point`，
  vendor 桥直接 return，「选了候选画布上什么都没发生」）；
- 排障读数：`window.__DSH_NODE_PLACEMENT__` → `{moves, flushes, stops, zoom, last, log}`；
- 面板底栏提示改成「Enter 添加 · 移动鼠标 · 左键放下」。

### v1.46：宫格裁剪——只换壳，切图语义一字没动

用户原话（2026-10-19）：「画布宫格裁剪ui还没有更新」。v1.26 换图片编辑族时，`mode !== 'editor'`
整棵树交回 vendor，所以宫格裁剪（工具条里最常点的那个）一直是上游那圈「胶囊里塞 fieldset +
原生 select + 手写 range」的外观。

- **新舞台** `src/canvas-ui/canvas/ImageGridCropStage.tsx`：与 `ImageCropStage` 同一套
  header / toolbar / stage / footer 与变量；工具条两行 —— 宫格预设（2×2…4×1）+ 横向/竖向分割
  步进器 + 恢复等分 + 7 个比例；上下/左右间隙滑杆 + 导出顺序（逐行/逐列/蛇形/倒序）+ 导出序号。
  顺序与比例都是**按钮组**，不用 Radix Select/Popover（它的 content portal 到画布容器 z-50，
  会成为工作台 z-12000 的兄弟节点，永远被盖住 —— 与 v1.26 同一个坑）。
- **像素仍走上游**：切线/间隙 → 源图像素用 `cropOutputRects`；拖切线的最小间距用 `moveCropCut`；
  行列等分用 `equalCuts`；顺序与 `1,3,5-8` 语法用 `gridExportIndices`。真正落像素的是
  `imageWorkbench.ts` 新增的 `exportGridPieces`（**行优先 + 宫格时每块先铺白底**，与上游
  grid 分支逐条对齐；`row`/`column` 保留原位，画布按它排节点）。
- **默认态**：上游打开是 1×1 + 居中 80% 选区（要先挑预设才看得到格子），nova 版默认 **2×2 +
  选区铺满整张图**；改行列数仍「重新等分 + 铺满原图」（与上游 `restoreGrid` 同一语义）。
- **能力一个不丢**：拖切线微调单行/单列、间隙、顺序、导出序号、恢复等分、比例锁定、
  保存后每格变成画布上的一张图（`useCanvasCropSave` 原样，host 半没动 —— 只要刷新页面）。
- **回归**：`test:canvas-ui` 里原来「宫格裁剪必须原样交回 vendor」那两条改成 nova 契约
  （22 条结构断言）；`browser-check` 新增 `image-grid` 场景 18 项 —— 舞台铺满画布（1176×808）、
  图片真的解码（775×581）、真拖第一条竖向切线后单格从 160×120 变 171×120、3×3 → 9 格、
  导出序号 `1,3` → 只导 2 张、保存后画布上多出 2 个 `/api/aifisher/canvas/media/` 节点；
  交付图 `.dsh-tmp/shots/canvas-image-grid.png`。

### v1.47：拖出来的连线不跟手——画布坐标系少了一个原点

用户原话（2026-10-19，附截图）：「从图像拉出的线与鼠标指针有很大偏差」。

- **根因**：上游连线手势把**视口坐标**（`clientX/clientY`）直接当**画布内坐标**塞进
  `tempConnectionEnd`，`canvasEdges` 再按 `(end - viewport) / zoom` 换成世界坐标 ——
  这只有在画布底盘贴着窗口左上角 (0,0) 时才对（AIFISHER 是独占窗口的应用）。
  嵌进 DSH 面板后底盘左边是侧边栏、上边是顶栏，虚线整体偏 `(rect.left, rect.top) / zoom`；
  真机侧边栏 240px、缩放 100% 时就是**偏 240px**。缩放越小偏得越多。
  同一个根因也是 v1.25「按节点矩形判落点也会偏」的来源 —— 那次只是把落点改成 DOM 命中绕开了它，
  画线这一路没绕开，所以线一直偏。
- **修法**（`scripts/patches/aifisher/src/stable/canvas/canvasConnectionHooks.ts`，整文件覆盖补丁）：
  - 手势开始时量一次 `#canvas-background` 的 rect，记进 `originRef`；
  - `hover()` 统一收**视口坐标**，只在最外层减一次原点得到画布内坐标：`tempConnectionEnd`
    存画布内坐标（`canvasEdges` 的约定），节点矩形判定用世界坐标，`elementFromPoint` /
    `rect` 命中仍用视口坐标（DOM 本来就是这个坐标系）；
  - 菜单是 `position: fixed` + `left/top` 吃 `clientX/clientY`，所以 `openMenu` 那条路继续用视口坐标；
  - jsdom 里 rect 全 0 → 原点 (0,0)，老行为与老回归**逐字不变**。
- **回归**：`browser-check` 的 `workflow-node` 场景加一条「拖出来的虚线跟着指针（自由端与指针偏差 ≤ 2px）」——
  指针停在空白处时把虚线端点按 `rect + viewport + zoom` 换算回屏幕坐标，和指针比。
  该宿主页复刻了 DSH 的 240px 侧边栏，所以改前实测 `delta=[240,0]`（这条断言真的会红），改后 `[0,0]`。

### v1.48：缩小时点阵密密麻麻 —— 换成 Blender 式三层嵌套矩阵

用户原话（2026-10-19，附截图）：「画布背景的星型矩阵，缩小画布就密密麻麻的，能不能参考 blender 的，
大的矩阵包裹小的矩阵，缩放到一点程度后小的矩阵就消失」。

- **根因**：底纹只有一层 24px 星号，`background-size = 24 × zoom`。缩小画布时整层贴纸跟着按比例缩，
  屏幕间距一路掉到几像素，星号就挤成一片噪点（用户截图就是这种状态）。
- **修法**（`src/client/canvas/canvasGrid.ts`，vendor 树仍然一个字不改）：一层 → **三层嵌套矩阵**
  `24 / 120 / 600px`（每层是上一层的 5 倍），三层共用同一个平移相位（`background-position` 都是画布
  translate），所以 120px 的大星圆心永远压在 24px 的某颗小星上，600px 再压在大星上 —— 是「大矩阵包小矩阵」
  而不是三套错位的网格。
- **显隐**：每层 wrapper 的整体透明度由**屏幕上的格子间距**（`spacing × zoom`）算：
  `<12px` 隐藏、`12→18px` 淡入、`18→200px` 全显、`200→240px` 淡出（放大到很大时不再出现巨大的稀疏星号）。
  于是放大时只剩小矩阵；缩小时小矩阵先消失、大矩阵接棒；继续缩由更大一层接棒 ——
  任何档位都只有 1~2 层可见，屏幕星号密度被夹在 12~200px 之间。
- **观感**：大矩阵的星号同时更大更亮（7 / 11 / 15px，alpha 0.19 / 0.26 / 0.32），否则同尺寸同墨色叠在
  一起根本分不出层次。24px 那一层的规格（间距 / 星号 / 墨色）一字没动：zoom 1 时仍按 v1.8 的参考图
  规格画，只是每 5 格多一颗大星。
- **回归**：jsdom `test-canvas-grid` 加了 22 项（三层结构 / 三套 SVG 平铺块各自 = 自己的间距 /
  zoom 1·0.2·0.05 三档的层 opacity 与屏幕间距）；`browser-check` 的 `grid-pan` / `grid-pan-hidpi`
  两场加了 4 条真机断言（真浏览器里量每层 inline opacity：zoom 1 小+大、0.2 大+更大、0.05 只剩最大）。
- **排查读数**：`canvasGridReport()` 多了 `tierCount` / `tiers`（id / spacing / screenSpacing / opacity /
  visible）/ `tierFade`；真机再报「缩小时密密麻麻」时先看 `tiers`。

### v1.49：切刀 —— 按住 Ctrl + 右键，划过的连线断开

用户原话（2026-10-19）：「现在做一个新功能，像blender一样按住ctrl加鼠标右键切换到切刀工具，
划过的线会断开连接」。

- **手势**：在画布上按住 Ctrl（mac 上 Meta 也行）+ 鼠标右键按下 → 进入切刀；拖拽画一条自由曲线，
  被这条曲线**划过**的连线当场变红（预览），松手就断开；拖到一半按 **Esc** 取消（一刀不落）。
  只点一下右键（没有位移，<10px）不算一刀 —— 避免和「右键菜单」的肌肉记忆打架。
  按住 Ctrl 时画布空白区的光标变成十字（`body.fisherai-knife-ready`），一眼看得出工具切过去了。
- **为什么能切准**（这是这一版最花心思的地方）：连线几何归 vendor 那套 `edgePath` / 端口函数管
  （端口行高、节点测高、ComfyUI 模板槽位、折叠、缩放都会让端点动）。自己按节点重算迟早和画面不一致，
  所以切刀**读渲染出来的 `<path d>`**：解析 `M … C …` 并把三次贝塞尔采样成折线 → 按
  `#canvas-viewport-content` 的 translate+scale 和 `#canvas-background` 的 rect 换算到屏幕坐标
  （Chrome 有 `getScreenCTM()` 时直接用，jsdom 里退回 inline transform）→ 与刀口折线做线段相交
  （容差 6px，包围盒先排除远处的线）。**用户看到的那条线就是判定用的那条线。**
- **断开只能落在 vendor 那半**：只有 `canvasApplication` 握着 `setNodes` 与连接适配器。
  所以 vendor 补丁 3.8t 做两件小事：① 给连线 `<g>` 补上
  `data-fisherai-edge-parent-id / -child-id / -port-index`（断线要的是**真身份**，
  而不是拆 `data-edge-key` 那个用 `-` 拼起来的字符串 —— 节点 id 里也可能有 `-`，拆错就断错线）；
  ② 挂 `window.__FISHERAI_CANVAS_KNIFE__.cut(edges)`，内部就是双击断线用的同一个
  `adapter.disconnect`。撤销 / 脏标记 / 自动保存都走既有的 nodes 变更 effect，没有第二条写路径。
- **只断被划到的**：C 同时接 A、B 时划掉 A→C，B→C 必须还在（jsdom 与真机都钉了这条）。
- **右键菜单**：起刀、拖拽、收刀后 600ms 内主动压住 `contextmenu`（Windows 上它可能排在
  pointerup 之后）；平时在画布上右键的菜单与双击断线**一字没改**。
- **回归**：jsdom 新增 `test-canvas-knife` 40 项（`d` 解析 / 贝塞尔中点 / 屏幕换算 / 点到线段距离 /
  线段相交与容差 / 去重 / 真挂画布后真派发 Ctrl+右键拖拽：浮层与红线预览、只切 A→C、B→C 保留、
  Esc 不落刀、不按 Ctrl 不触发、右键菜单不被吞、存盘后 `parentIds` 只剩 B）；
  `browser-check` 新增 `knife` 场景 7 条（真 Chrome 里用 `getTotalLength / getPointAtLength /
  getScreenCTM` 取点，验预览、只断一条、读数与「交付图停在切到一半」）。
- **排查读数**：`canvasApp.knifeReport()` —— `installed / canvas / edges / bridge / sessions / cuts /
  targets / lastError / lastGesture`。真机「Ctrl+右键没反应」时先看 `bridge`（vendor 补丁生效没）
  与 `edges`（认得出几条线），再看 `lastError`。

### v1.50：文本节点的正文不再落进「提示词」框

用户原话（2026-10-19）：「发现一个问题，它生成的内容不在文本里，反而在提示词里」。

- **现象**：让 agent 在画布上写一段剧本，节点上出现的是「提示词」框里一大段字，正文区空白；
  把节点接给图像节点当提示词时，下游也读不到这段字。
- **根因**：Text 节点有两个文本字段 —— `textContent`（正文，节点大画布区）与 `prompt`
  （转换模板，生成面板里的提示词框）；发起请求时按「上游文本 + 正文 + 模板」拼接
  （`generationScheduler.buildPrompt`），下游取上游正文时只认 `textContent`。
  agent 通道的 `create` 只认一个 `prompt` 字段，executor 又无条件写 `node.prompt`，
  于是所有 agent 建的文本节点都把正文写进了模板位，正文一片空白。
- **修法**（vendor 补丁 3.8u，`canvasControlExecutor.ts`）：
  ① `create`：只给 `prompt` → 当正文写 `textContent`（`prompt` 留空）；显式给 `text` +
  `prompt` → 正文与模板各归各位；② `update`：只给 `prompt` → 改正文，显式 `text` → 改正文、
  模板不动。`validCanvasControl` 的 create / update `patch` 白名单放行 `text`
  （`.js` 校验与 `.d.ts` 类型同步），否则指令会被判 `INVALID`；工具描述与
  `docs/canvas-agent-contract.md` 同步写清两个字段的分工。
- **旧数据**：本次受影响的那个测试节点已把 `prompt` 里的 516 字挪回 `textContent`
  （画布关闭时直接改落盘的 `canvas.json`，DSH 重启后从盘上读）。**没有做全局自动迁移**：
  「模板」是合法用法，自动搬会破坏「模板持久、正文被生成结果覆盖」的语义。
- **回归**：`test-canvas-agent` 新增 7 项（只给 prompt 建文本 → 正文落 `textContent`、
  提示词为空 / `update` 只给 prompt 也改正文 / `text` + `prompt` 分别落正文与模板）。

### v1.51：对话里 @ 画布节点

用户原话（2026-10-19）：「能不能加一个我能在对话去@画布内的素材，文本、图像等」。

- **为什么是「注册一个 @ source」而不是自己画菜单**：DSH 的 composer 本身就有触发流水线
  （`@deepseek-ai/dsh-client-ui-input-trigger`）：键入 @ 打开分组候选、pick 后插入原子行内
  引用、发送时调 `inputTriggers.serializeReference(source, ref)` 换成模型可见文本。文件 /
  会话引用就是这么接的；我们按同一份契约注册第三个 source（trigger `@`、name `aifisher-node`），
  不碰内核组件。
- **候选从哪来**：画布当前项目 id 从画布自己的 resume 状态读
  （`window.__FISHERAI_CANVAS_SESSION__.load().workflowId`），再用 `#canvas-background`
  确认「画布视图真开着」（项目库视图里 resume 状态还是上一个项目，照它列会列错）；
  节点列表走本地后端 `GET /api/aifisher/canvas/workflows/:id`。文本节点排前面，其余按 y/x；
  按标题 / 类型 / 正文模糊过滤，最多 50 行。
- **插进去的是什么**：原子引用 `@[标题](aifisher-node:<节点 id>)`。`appearance` 刻意不给 ——
  DSH 只认 session / file / folder 三种图标，画布节点不属于任何一种，硬塞会给错图标；
  不给就是中性的「@ 标题」chip。已发送消息里由注册到 `conversation.user.text.node`
  （key `aifisher-node`）的组件渲染成同款 chip，点一下调 `__FISHERAI_FOCUS_NODES__`
  把节点聚焦回画布。
- **模型看到什么**：宿主半在 `agent/pre-step` 里扫描本次提交的用户消息，解析 mention →
  用 `store.findNode(id)` 反查节点（节点 id 是全库唯一 UUID，不需要带项目 id）→ 在
  **用户消息后面**插一条只读快照（`## Referenced canvas nodes` + `<canvas-nodes>` JSON）。
  文本节点带 `text`（≤4000 字）与 `template`，媒体节点带 `resultUrl`；最多 8 个；
  正文里的 `<` 转义成 `\u003c`，拼不出定界标签。
- **两级 fail-open**：client 拿不到 `inputTriggers` / `uiConversation`、画布没开、接口失败
  → 只少一组候选；host 解析失败 / 节点被删 → 原样放行，绝不改坏用户消息。
- **两个坑（记下来）**：① `@[标题](aifisher-node:…)` 里也含 `@…`，file 规则（order 30）
  会把它当 `@path` 抢先匹配，所以 userText 规则的 order 必须更小（这里 5）；② jsdom harness
  原来把 pre-step 的多个监听器**并行**调用、取第一个结果，不是瀑布 —— v1.51 起改成真正的
  `next()` 串联（第二个入参是函数才走瀑布；`session/event` 那种「第二入参是数据」的事件保持原样）。
- **回归**：新增 `test-canvas-references` 15 项（mention → 快照、紧随用户消息、正文 / 结果地址、
  去重、四种不触发、`</canvas-nodes>` 转义）。

### v1.60：火山方舟视频（Seedance 2.0）接通

（v1.52–v1.59 的条目没在这里补齐，以代码注释与 `docs/` 为准；本节从 v1.60 续写。）

用户给的是一条方舟 curl（`doubao-seedance-2-0-260128` + 两张参考图 + 参考视频 + 参考音频，
`generate_audio:true` / `ratio` / `duration:11`），要求「接一下这个模型」。

- **它原来在哪**：画布目录里本来就有 `豆包视频2.0` / `豆包视频2.0 fast`（provider
  `DoubaoVideoProvider`，端点就是 `…/contents/generations/tasks`），但本插件只移植了方舟的**图片**
  那条 —— 视频请求会掉到「没有通道」的 501。所以这次不是新增模型表，是补**第二条方言**。
- **协议**（2026-11 核对，与官方文档、`seedance2` 的实践一致）：异步任务两跳。
  ① `POST {base}/contents/generations/tasks`，`content` 是数组：
  `{type:'text',text}` / `{type:'image_url',image_url:{url},role:'first_frame'|'last_frame'|'reference_image'}`
  / `{type:'video_url',…,role:'reference_video'}` / `{type:'audio_url',…,role:'reference_audio'}`，
  加 `model` / `resolution` / `ratio` / `duration` / `generate_audio` / `watermark`；回 `{id}`。
  ② `GET …/tasks/{id}`，`status` 走 queued→running→succeeded|failed，成功时结果在
  `content.video_url`，失败原因在 `error.{code,message}`。
- **沙箱现实决定了素材形态**：画布素材是本站相对 URL，方舟访问不到。图片按官方支持的
  `data:image/<格式>;base64,…` **内联**（单张 ≤10MB、总量 ≤40MB）；**参考视频 / 参考音频官方只收公网
  https 直链、不吃 data URL**，所以本站素材在这里**明确拒绝**并说清「把素材放到公网直链再连」——
  让它发出去换一个看不懂的 400 是最差的体验。
- **模式映射**：`text-to-video` 无 role；`first-frame` / `i2v-first-last-frame` 把前两张图当
  first_frame / last_frame 且 `ratio` 强制 `adaptive`（比例由画面决定，节点上的比例设置会在 `notes` 里说明
  不参与提交）；其余（`multimodal` / `reference-video` / `reference_image`）按连的素材分别成
  reference_image / reference_video / reference_audio。契约里的硬约束都当场拦：
  尾帧不能与任何参考素材混用、参考音频必须配视觉参考、张数上限（图 ≤9 / 视频 ≤3 / 音频 ≤3）。
- **轮询**：2s 起、×1.4、封顶 8s；`queued/running/未知状态`都不当收尾；`5xx/429` 与「这次没回来」
  按可重试，连续 8 次才认输；总预算 `ARK_VIDEO_TIMEOUT_MS`（默认 15 分钟，只压 30 分钟上限）。
  超时回 `504 ARK_VIDEO_TIMEOUT` **带任务号**并提示别重发（重发＝重复计费）。出片后走
  `localizeCloudResult('video')` 下载进素材库（临时链接几小时就失效）。
- **可发现性（不改 vendor）**：`/generation/sources` 的方舟卡片多了 `media:[{kind:'video'}]`
  （agent 的 `prepareGeneration` 靠它判断 configured）；`/generation/model-availability` 多了一组
  `canonicalModel='Seedance 2.0' › sourceLabel='火山方舟'` 的变体，价格是**元/秒**（画布 composer 自己乘时长），
  所以二级下拉显示 `≈¥1.35/秒`。模型名逐字取目录，`MODEL_ID_CUSTOM_<码点>` 仍可换成 `ep-…`。
- **回归**：新增 `scripts/test-ark-video.mjs` 47 项（真 HTTP 假方舟：提交/轮询/落盘、四种 role 映射、
  内联与拒绝、五类输入拦截、queued 不算收尾、失败/超时/401/404/400/无任务号、分发边界、自定义模型 ID）。
  `test-ark-generation` 85 项、`ui` 75 项随之更新（方舟卡片现在两种媒体）。
- **实测状态**：用用户给的 Key 探过方舟 —— 鉴权通过，但 `doubao-seedance-2-0-260128` 在该账号下
  是 `404 ModelNotOpen`（**账号未开通该模型**，不是代码问题）。到方舟控制台「开通管理」开通，
  或在设置页填账号下的 `ep-…` 即可。
- ⚠️ 这轮改了 host 半：**要重启 DSH**；画布侧无需刷新（没动 vendor）。

### v1.61：画布助手 P1（记忆 / 长任务 / 一致性 / 副驾 / 分镜板）

本轮把路线图 P1 五项一次落地。原则没变：**确定性工作放 host、创意判断给模型、花钱的决定归用户**。

- **项目记忆**（`src/host/canvas/projectMemory.ts`）：`<数据目录>/canvas-memory.json`，条目带
  `kind`/`key`/`importance`，同 `kind+key` **原地更新**（否则模型每轮都会追加一条重复的「画风」）；
  每项目 40 条、每条 400 字。注入走 `agent/pre-step`，只对画布对话会话、每份内容只注入一次
  （按文本比对）——「新会话不用重新交代画风」就是这一条。
- **视觉一致性**（`consistency.ts`）：不发明协议。画布准备生成时本来就把**上游节点结果**当参考图，
  所以「锁脸/锁服装/锁画风」= 把锚点节点 `connect` 成镜头节点的上游。host 只算「该连哪几条」
  （已连的跳过、锚点自己不算镜头、幽灵锚点如实回报），覆盖率口径是「每个镜头都接上**全部**锚点」。
- **主动副驾**（`copilot.ts` + `CanvasCopilot.tsx`）：建议在 host 算（失败 > 缺提示词 > 一致性缺口 >
  记忆空白 > 孤立节点 > 长任务），界面默认**连胶囊都不出现**（没有建议就什么都不渲染 = 低打扰），
  有建议才冒小胶囊，点开是面板；「不再提示」写 localStorage，彻底关掉（不新增设置项）。
- **长任务编排**（`canvasJob.ts`）：固定流水线 `read → shots(recipe) → lock → prepare → await → retry → report`，
  `action:"job"` **立即返回**快照。关键取舍：**重试 = 自动再准备一批（仍 awaiting-approval）**，
  绝不自动提交 —— 审批红线不动，用户只是多点一次确认。状态区分 `awaiting-approval`（等人点）
  与 `waiting`（真在生成），排查时一眼能看出卡在哪一步。
- **轻量分镜板**（`CanvasStoryboard.tsx`）：画布底部缩略图带，镜头号（镜头 3/分镜03/shot 3）优先、
  坐标兜底；点一张用 vendor 的 `__FISHERAI_FOCUS_NODES__` 聚焦，播放每 1.5s 翻一张、到结尾自动停。
  只做「看顺序」，不做时间轴/轨道/转场。
- **接线**：`canvas_control` 新增 `memory` / `consistency` / `copilot` / `job` 四个动作；
  HTTP 面 `/memory`（GET/POST/DELETE）、`/memory/anchors`（PUT）、`/copilot`、`/jobs`（只读 + cancel）；
  `read view:"digest"` 的 `digest` 里多了 `memory` / `consistency` / `copilot` 三段（形状不变）；
  `canvasAppBuildInfo()` 多了 `storyboard` / `copilot` 两段诊断。
- **踩坑记录**：
  1. digest 的补充段必须放进 `digest` **里面**，放到顶层会破坏所有读 `result.digest.*` 的调用方
     （本轮真踩到：test-canvas-digest 一次红 10 条）；
  2. 画布对话的 DSH 会话 id 是 `hub.ensureSession` 生成的 `session-…`，**不是面板的 chatId** ——
     记忆注入按 DSH 会话 id 命中，拿 chatId 去找永远找不到（回归里专门验了这条）；
  3. `/memory/anchors` 传了锚点却一个都没留下（全是幽灵 id）必须 422，而不是 200 + 空列表
     （否则界面显示「设置成功」但锚点没了）；
  4. 本机从 E: 同步时发现 E: 仓库缺 v1.58「生成批次确认卡」全套（`CanvasGenerationBatches.tsx`、
     vendor 3.8v、mount 挂载、test 断言），同步会把它覆盖掉 —— 已按原设计重建，发布前必须双向核对；
  5. **`GET /copilot` 不许走 bridge**（2026-10-20 真机检查一口气红到 fail=68 的真凶）：副驾面板每 30s
     轮询一次，第一版让它 `bridge.request({action:'read'})` 去问「活画布」。画布一关/一重载，
     上一个页面的 client 还留在桥里，指令被投给一个已经消失的长轮询，于是这一问要等满 5s；
     headless 的虚拟时间在等这个 fetch → 页面探针一条都发不出去（现象看起来像「画布没挂起来」，
     截图里却一切正常）。现在的口径：**后台轮询只读磁盘文档**，`live=1`（用户真打开面板）才问活画布，
     且 host 侧只问「最近 5s 内还在轮询」的页面、超时 1.5s 兜底。
     `test-canvas-copilot` 加了两条断言（不带 live 必须 <500ms 回、带 live 不能挂死）。
- ⚠️ 改了 host 半：**要重启 DSH**；画布侧刷新页面即生效。

### v1.63.1：「退出画布」压住「副驾」胶囊

用户 2026-10-23 截图报障（只写「这两个重叠了」）：画布右下角黄色星星的「副驾 N」胶囊
被 DSH 层的「← 退出画布」按钮压掉右半截。

- **根因是两个浮层抢同一个右下角**，而它们分属两层：
  - 退出按钮在 DSH 层（`PanelExitButton`，画布面板内的 absolute）：`right: 20`，宽 98 → 占距右缘 20..118；
  - 副驾胶囊在画布层（`CanvasCopilot.PILL_STYLE`）：`right: 56`，宽 ~81 → 占距右缘 56..137。
  两者都贴底（bottom 20 / 24），水平交叠 62px，**宽窗口下也必然重叠**（不是窄屏问题）。
  之前 v1.60 只抬高了助手启动球（`bottom-20`），没管这个更晚加的胶囊。
- **修法：右下角整块留给退出按钮**（它属于 DSH 层，必须始终可点），画布自己的浮层往中间让：
  胶囊改成 `right: calc(50% + 54px)`，右缘贴在画布中线外 54px —— 分镜板居中、半宽约 46.5，
  两者间距 8px，底部连成一条工具带。副驾面板也从「贴右缘」改成从胶囊正上方居中展开
  （`left:50% / translateX(-50%)`），顺手避开窄窗口下压住按钮的风险。
- **回归**：`test:copilot` 20→21（新增「胶囊靠中线定位、不贴右缘」断言，防它被改回固定 right 数字）；
  真机实测 1662×954 下 胶囊 623..704 / 分镜板 712..805 / 退出按钮 1118..1216，三者两两不相交。
- ⚠️ 只改画布产物 + client 半：**刷新页面即生效**，不用重启 DSH。

### v1.64：视频生成历史（仿照图片那套）

用户原话（2026-10-23）：「仿照图像生成历史记录，做视频生成历史记录功能」。

- **参照物**：图片节点本来就有 —— 每次生成把新结果**并进** `resultUrls`（`resultUrl` 永远是最新那张），
  节点头部一枚 `历史 N` 药丸，点开在节点周围扇形摊出前面那些（每张可下载 / 设为主图），
  文案按 `currentResultCount` 在「本次 2 / 本次 2 · 历史 5 / 历史 5」之间切换。
- **视频侧缺的三处**：
  1. `generation/canvasGeneration.ts` 的 Video 分支直接 `resultUrls: urls` —— **覆盖**，上一条当场没了；
  2. `generation/generationRecovery.ts` 只在 `result.type === 'image'` 时合并历史 ——
     断线/刷新期间跑完的视频同样只剩最新一条；
  3. `media/canvasVideoPlayer.tsx` 根本没有历史叠：`resultUrls` 就算有多条也看不见、点不到。
- **改法（算法在插件，vendor 只留薄壳）**：
  - **数据**：`src/canvas-ui/canvas/CanvasVideoHistory.ts` 提供纯函数
    `mergeVideoResultHistory` / `promoteVideoResult` / `videoHistoryLabel` / `videoResultUrls`
    （去重、上限 **12** 条 —— 比图片的 20 低，展开时每一格都是真的 `<video>`，摊 20 个会压出卡顿），
    由装配层 `installVideoResultHistory()` 挂成 `__FISHERAI_VIDEO_RESULT_HISTORY__` 桥；
  - **接线**：vendor 补丁 **3.8w**（9 处）让上面三处都走桥（桥不在时退回「只记这一批」，不阻断生成）；
  - **界面**：`scripts/patches/aifisher/.../canvasVideoPlayer.tsx` 整文件覆盖 —— 头部药丸与图片同款，
    摊开是带悬停预览的真视频格，角上「下载历史视频 N」/「设为主视频」；
    外框的 `overflow-hidden` 挪进视频层（否则扇形会被节点边界剪掉）。
- **「设为主视频」清三样跟着上一条片子走的字段**：`lastFrame`（首/尾帧预览、用最后一帧接着生成都读它）、
  `resultAspectRatio / naturalWidth / naturalHeight`（新片 `loadedmetadata` 会重新量并写回）。
- **不变的红线**：`canvas_control` 不新增任何动作；审批仍只有页面 UI 能按。历史是节点数据，
  存在 `canvas.json` 的文档里，导出 `.fisherai` 一起带走。
- **回归**：新增 `test:video-history` **41 项**（纯逻辑：合并去重 / 上限 12 / 换位 / 文案 / 老数据只有
  `resultUrl`；真 DOM：药丸 → 摊开 2 条真 `<video>` → 点「设为主视频」→ 卡上换片、存盘后 `resultUrl`
  与 `resultUrls` 顺序都在、`lastFrame` 已清；外加「图片那枚 `历史 N` 还在」）；全量 **47 套 2550 项**。
  真浏览器新增 `video-history` 场景 **11 项**（节拍与证据见上面「真浏览器检查」）。
- **素材**：`scripts/fixtures/video-history-{red,green,blue}.mp4` 三份 1.8KB 的 320×180 / 1 秒纯色片，
  只给真浏览器检查用（Chrome 真解码，`videoWidth` 能读到 320）——不是运行时依赖。
- ⚠️ 只改画布产物 + client 半：**刷新画布页即生效**，不用重启 DSH。

### v1.65：视频节点的参考图能拖到 9 张（MiniMax H3 口径）

用户原话（2026-10-23）：「视频生成图像参考只能拖入三张，修复一下，按 minimaxh3 的标准来」。

- **现象**：自配通道里的视频模型（线上那条就是 FisherAI 的 `minimax-h3-ow-r2v`，画布上的名字
  `通道名 · minimax-h3-ow-r2v`）在「多图参考」模式下，往节点上拖第 4 张图连不上 —— 没有报错，
  线就是接不上。
- **根因**：条目上的 `maxInputs: 3`（**总输入上限**）与模式声明打架。vendor 的
  `canvasNodeRules.validateConnection` 有两道闸：
  1. `parents.length >= model.maxInputs` —— 总闸，先拦；
  2. 再按素材种类查该模式的 `allowedInputs`（多图参考一直写的是 `image: 9`）。
  闸 1 写死 3，闸 2 声明的 9 张就永远用不到 —— 用户看到的就是「只能拖入三张」。
- **改法**：`videoEntry` 的 `maxInputs` 不再手写，改为 `videoInputCap(videoModes)` ——
  **取各模式 `allowedInputs` 之和的最大值**（文生视频 10 / 首帧 11 / 首尾帧 12 / 多图参考 19 /
  视频参考 11 → 19）。参考图上限抽成常量 `VIDEO_REFERENCE_IMAGE_LIMIT = 9`，与
  `vendor/.../media/minimaxH3.ts` 的 `SLOT_RANGES.referenceImage = [3, 11]`（9 个图片槽）同口径。
  这样以后改模式上限不必再回来同步一个魔数，两条闸也不会再自相矛盾。
- **不变的红线**：`maxInputs` 仍是「总闸」，`首帧 1 张 / 首尾帧 2 张 / 文生视频不接图」这些
  单图模式的限制原样由 `allowedInputs` 把关；host 侧提交形状（`images[]` / `videos[]` /
  `audios[]`）一个字没动，也不新增审批动作。
- **回归**：新增 `test:video-references` **24 项**（纯逻辑：上限推导 / 9 张常量 / 至少为 1；
  注册表：通道表 → 条目的 `maxInputs` 与 `allowedInputs` 自洽；**真 DOM 拖线**：10 张图依次拖到视频节点上
  → 前 9 张连上、第 10 张被拒、节点的 `videoMode` 没被改掉 → 再接文本节点仍能进（总上限是 19 不是 9）；
  外加源码级「别把 `maxInputs: 3` 写回去」与文档口径）。
- ⚠️ 只改画布产物（`src/canvas-ui` + 装配层导出）：**刷新画布页即生效**，不用重启 DSH。

### v1.66：视频截帧（首帧 / 尾帧 / 两张）

用户原话（2026-10-23）：「完善视频截取首尾帧功能」。

- **现状**（上游 `videoSnapshots.ts` + `canvasMediaOperations.snapshot()`）：一枚「截取首尾帧」
  只能**两帧一起截**、原尺寸 PNG、节点固定落在 `source.x + 400`、截完只选中不聚焦。
  真机实测（967×544 / 362s 的片子）：首尾帧都能取到、耗时 ~200–300ms，**取帧本身没坏**，
  坏的是「只截一帧」「落在视口外像没反应」「4K 原图搬得很慢」这几件事。
- **取帧算法**（`src/canvas-ui/canvas/CanvasVideoFrames.ts`，桥 `__FISHERAI_VIDEO_FRAMES__`）：
  - `role` 驱动：`first` / `last` / 两个都要，**单帧不再配一个多余节点**；
  - 尾帧从 `duration - 0.05` 起（与 `inspectVideo` 的 lastFrame 同口径），
    用 4×4 像素**探空白帧**（alpha 全 0 = 没画上），空白就按 `TAIL_SEEK_OFFSETS`
    （0.05 → 0.2 → 0.5 → 1.2s）往前退；
  - 输出最长边压到 `FRAME_MAX_EDGE = 2048`（PNG 无损），4K 帧不再原尺寸搬；
  - 每步错误文案分开（等首帧 / 读时长 / seek 超时 / 空白画面），不再只有一句「等待超时」。
- **落位**（`src/canvas-ui/canvas/CanvasFrameLayout.ts`，桥 `__FISHERAI_FRAME_LAYOUT__`）：
  贴视频右侧 60px，首帧在上、尾帧在下（以视频中线为基准，纵向间距 40），整列与画布上已有节点
  相交就**整列右移**（最多 8 列，再不行贴画布最右）；节点宽高拿不到时按类型兜底（Video 385）。
- **播放器**（整文件覆盖 `canvasVideoPlayer.tsx`）：原来那枚「截取首尾帧」按钮变成**三项菜单**
  （截取首帧 / 截取尾帧 / 首尾帧各一张），另留「截图（当前画面）」；成功给一条 2.6s 的
  「已截取尾帧」回执（以前只有失败提示），执行中按钮禁用。
- **vendor 接线**（补丁 3.8x，4 处）：空帧跳过、坐标问落位桥、带 `focus` 的截帧把
  「视频 + 新帧」交给 `__FISHERAI_FOCUS_NODES__` 收进视口、截帧节点 `prompt` 留空
  （「视频首帧」这类标题不再被当成生成提示词）。
- **回归**：新增 `test:video-frames`（纯逻辑：尺寸上限 / 尾帧候选序列 / 空白判定 / 贴右避让 /
  兜底尺寸；真 DOM：菜单三项 → 首尾帧 2 个节点 → 单截尾帧只 1 个 → 列避让与存盘字段 →
  回执 / 聚焦 / 桥）；全量套数与项数见下面 TOTAL。
- ⚠️ 只改画布产物（`src/canvas-ui` + vendor 补丁 + 装配层导出）：**刷新画布页即生效**，不用重启 DSH。

### v1.67：截帧加固（「截取视频首尾帧失败了」）

用户报障原话（2026-10-23）：「截取视频首尾帧失败了」—— 截图里是视频节点上的一条
「视频定位超时（拖到该时间点没等到画面），请稍后重试」。

- **取证**（真 Chromium + 构建产物 + 那段片子本体：`967×544 / 362.04s / 56.7MB / 23fps /
  28 个关键帧`）：`captureVideoFrames` 在干净页面里 220ms 出两帧、`seekable` 到 362.043；
  接**活着的 DSH 媒体地址**（`/api/aifisher/canvas/media/...`，curl 确认 `206` + `Content-Range`
  正常）同样 186–228ms。**算法和文件都没坏，坏的是"等它落位"的判定**。
- **根因**：旧 `waitForVideo` 把判定挂在单个事件上 —— `seeked` 来的那一刻只要
  `readyState` 还没到 2、或 `|currentTime - target|` 差几毫秒，条件**从此不再评估**，
  于是白等满 15s 报超时；片尾 seek 还要现拉一个关键帧（本例关键帧间隔 ~13s），
  在真页面里比空载慢一拍是常态。
- **改法**（`src/canvas-ui/canvas/CanvasVideoFrames.ts`）：
  - `waitUntil()`：**事件唤醒 + 40ms 轮询**（`seeked` / `timeupdate` / `canplay` / `progress`
    都只当唤醒用），条件每 40ms 重算，事件丢了也能自己捡回来；`failed()` 一返回错误立刻失败；
    `abort` 立刻退出；结束摘干净监听。
  - `seekLanded()` + `SEEK_TOLERANCE_SEC = 0.5`：Chromium 会把手感位置吸到最近可解码帧，
    原来 `< 0.02` 对 23fps 的片子过紧。
  - `clampSeekTime()`：按 `seekable` 钳目标。远端素材走 `/proxy` 时只缓冲了一截，
    硬拖到片尾**永远**等不到 `seeked`；现在退到能到的最后一刻。
  - `waitForPaintedFrame()`：空白（alpha 全 0）先等最多 `PAINT_WAIT_MS = 800` 再判，
    不再"一探空白就换下一档"。
  - 尾帧单档预算 `TAIL_SEEK_TIMEOUT_MS = 8000`；整轮超时**换一个新 `<video>` 重试一次**
    （`retryOnTimeout`，回归里可关）。
  - 错误文案带现场：`视频定位超时（拖到 361.94s 没等到画面；readyState=2，仍在寻址，
    落点 361.99s，时长 362.04s），请稍后重试`。
- **host 配套**（`src/host/canvas/mediaRouter.ts`）：`/proxy` 透传 `Range`，206 与
  `Content-Range` / `Accept-Ranges` 一并回给浏览器。以前固定 200 + 整段，浏览器据此把远端视频
  当"不可寻址"（`seekable` 只有已缓冲那截）→ 拖进度条、截尾帧全卡死。
- **回归**：`test-canvas-video-frames` 54 → **73 项**（新增：落点判定四态 / 钳制三态 / 现场描述 /
  事件来早了仍通过 / 一个事件都不来也能通过 / `failed()` 立刻失败 / 超时文案带现场 /
  超时摘监听 / abort 立刻退出 / host 代理透传 Range 源码级）；`verify-video-frames.mjs`
  11 → **18 项**（新增：报障那段真片子必须 8s 内截出 967×544 首尾帧、尾帧落在 361.99s、
  探针不透明、以及 `seekLanded` / `clampSeekTime` 在真浏览器里的口径）。
- ⚠️ 画布侧改动**刷新页面即生效**；host 的 `/proxy` 改动要**重启 DSH**（只影响云端/跨域视频）。

### v1.68：进度条整条轨道都能拖（「视频下方进度条拖到不了」）

用户报障原话（2026-10-23）：「视频下方进度条拖到不了」。

- **先取证，不照着字面猜**：把用户**本人那份 canvas.json**（只读拷贝）挂进真画布产物，
  再用 CDP 真鼠标在他那个 `Upload Video` 节点（967×544 / 362.04s / 56.7MB，画布 zoom 1.3195）上拖：
  - 暂停态 10% → 99% 落到 **362.04s**（片尾）、再拖回 20% 落到 66.85s；clicks 在轨道最右端也到片尾；
  - 播放中拖 20% → 90% 每一跳的 `input.value` 都跟指针（333.13 = 92%），松手后继续播；
  - dpr 1.25 再跑一遍同样过。
  → **seek 链路没坏**（单次 seek 89–258ms、60Hz 连打也能落位）。坏的是那根细滑杆的交互本身。
- **根因（交互层，三条叠在一起）**：
  1. 原生 range 只有 16px 高、拇指 12px；画布缩到 70% 就只剩半个手指高，**没戳中拇指 = 什么都不发生**
     （底栏那片 56px 渐变还会把这次按压吞掉，看着就是"拖不动"）；
  2. 原生拖动的值映射带半个拇指的内缩（点 85% 只到 86.8%），想拖到片尾得把手移出轨道 ——
     正好是「拖到不了（片尾）」的手感；
  3. 拖动途中底栏的受控回写跟着播放时钟走，长片里拇指会被新的 `time` 拽回去一下。
- **改法**（整文件覆盖 `canvasVideoPlayer.tsx`，vendor 侧不再依赖原生拖动）：
  - 轨道自己吃指针：`data-fisherai-video-seek-track` 包一层 20px 高（+上下 2px 余量）、`touch-none`
    的容器，**按下即按比例跳到落点**（`timeAtPointer`，点最右 = 片尾），`setPointerCapture` 后
    指针移出轨道也继续跟；
  - 拖动期间用本地 `scrubTime` 驱动拇指/读数（与播放时钟无关），松手才切回真实 `time`；
  - seek 按 `SCRUB_SEEK_INTERVAL_MS = 120` 节流 + **始终留一发尾发**（松手时按松手位置再提交一次）；
  - 松手后若真在寻址 → 时间旁显示「定位中…」（`data-fisherai-video-seek-pending`），落到位自己收掉；
  - 底栏收起时 `pointer-events-none`（以前那片隐形渐变一直在吞视频底部的点击）；
  - 原生 `<input type=range>` 保留（键盘/无障碍），但 `pointer-events-none`，拖完自动 focus 回去。
- **回归**：新增 `test:video-seek`（**19 项**）：轨道契约 / range 仍可键盘 / 按下即跳 50%（100s）/
  连续 5 次 pointermove 只打 ≤2 次 seek / 拖动中 `timeupdate` 回写不拽拇指 / 松手补最后一发到 199s /
  「定位中」出现与自动收掉 / 底栏收起带 `pointer-events-none`、悬停后摘掉 / 补丁源与 vendor 一致。
  全套 **50 套 2666 项**。
- ⚠️ 只改画布产物（vendor 覆盖 + 装配层）：**刷新画布页即生效**，不用重启 DSH。

## 验证

三套：类型门禁（`pnpm typecheck`，`src/` 零错误）+ jsdom 回归（50 套，`pnpm test`）+ 真浏览器检查（28 场景，`scripts/browser-check.mjs`，不在 `pnpm test` 里）。

**0）类型门禁：`pnpm typecheck` 的 `src` 零错误**（2026-10-20 v1.61；`scripts/typecheck.mjs` 用 TS 编译器 API 只统计 `src/`，`vendor/` 上游自带的类型错误不进门禁）

**1）jsdom 回归：50 套 2666 项全绿（2026-10-23 v1.68；下面分项是 v1.44–v1.57 的累加记录，最新总数以 `run-all-regressions` 的 TOTAL 行为准）**

> v1.66 新增 `test-canvas-video-frames`（**54 项**）：纯逻辑（输出最长边 2048 / 尾帧候选
> 9.95→8.8 / 空白帧判定 / 贴右避让学生成 / 兜底尺寸 385×216）+ 真 DOM（菜单三项 →
> 首尾帧 2 个节点 → 单截尾帧只 1 个（空帧被跳过）→ 第一列被挡就整列右移 → 存盘字段
> title/x/y/prompt/parentIds → 回执 2.6s 自消失 / 聚焦带视频 / 两个桥都挂上）+ 源码级接线。
>
> **v1.67 加到 73 项**：抓的是「截取视频首尾帧失败了」的真身 —— 等待判定不能挂在单次事件上。
> 新增 19 项：`seekLanded` 四态（readyState/寻址中/0.3s 容差/0.9s 跑偏）、
> `clampSeekTime` 三态（seekable 20s → 19.95 / 到片尾不动 / 读不到原样返回）、
> 现场描述、**事件来得太早仍能通过（旧写法在这里卡满 15s）**、**一个事件都不来也能靠轮询通过**、
> `failed()` 立刻失败、超时文案带现场、超时摘监听、`abort` 立刻退出、
> host `/proxy` 透传 Range（源码级）。

smoke 59 / **backend 81**（v1.44 加 15 项：画布侧技能目录 —— 用户层扫到 / bundled 层保留 / 同名以用户为准 /
`user-invocable:false`·旧式 invocation 键·`SKILL.disabled.md` 三种过滤 / 正文 UTF-8 原样 / bundled 仍能取正文 /
非法名与不列的都 404 / `?cwd=` 项目层与同名覆盖 / 相对路径忽略） / **render 31**（v1.34 加 7 项：直连正文仍进请求/隔一层不再继承/第三跳也不继承/
直连两个文本节点按 y-x 序拼接/文本节点「自己正文 + 直连文本父节点」/「接进来的正文 + 自己的提示词」拼接顺序） /
panel-exit 26 / **chat-dock 40**（v1.41 加 1 项：新对话输入区贴底那条规则的**精确选择器**
`[data-conversation-scroll] > [data-composer-seat]` + `margin-top:auto`） / agent 27 / agent-chat 66 / references 16 / generation 65 /
media 88 / library 85 / custom-workflows 121 / workflow-config 100 / local-workflows 64 / cloud 38 / ark 85 /
**ark-video 49**（v1.60 新增：方舟视频异步任务的提交/轮询/落盘、四种 role 映射、参考图内联与
参考视频/音频只收公网直链、五类输入拦截（无首帧/无提示词/音频无视觉/尾帧混参考/本站素材）、
queued 不算收尾、任务失败带原因、超时带任务号、401/404/400/无任务号、分发边界不串线、
自定义模型 ID 覆盖、构建期 `selectable` 补丁与常用清单断言） /
**cloud-channels 130**（v1.29 加 10 项：方言判定/`image_url`/按次提交；v1.30 再加 21 项：`workfisher` 方言判
定/单数路径/`size`+`resolution`+`nsfw_check`/任务轮询/`FAILURE`→`fail_reason`/参考图先上传换直链/按次提交/
额度不足 403 的人话提示；v1.31 再加 8 项：403 时节点上显示「额度不足」原话/带 HTTP 403/诊断码不变/
新节点默认模型=通道模型/两条 vendor 补丁在源码里；v1.32 再加 5 项：带 `?t=` 缓存戳的素材照样内联/
素材已删除时回 `CHANNEL_REFERENCE_MISSING` 而不是「外链图片请先下载」/补丁 3.8l 在源码里；
v1.35 再加 6 项：真 RST 造 `ECONNRESET` → 自动重试后生成 200 / 一直断 → 502 `CHANNEL_UPLOAD_UNREACHABLE`
且回执含次数与大小 / 一直断时不发 `/image/generations` / hint 含免费可重试 / 直链缓存命中只有 1 次上传） /
**cloud-canvas 26**（v1.32 加 7 项端到端：真画布里点「拿刚生成的图当参考图」的第二个节点 → 假方舟收到的
`image` 是 data URL、字节等于上一张结果图、那次也跑成功） / ui 75 /
**grid 87**（v1.48 加 22 项：三层嵌套结构（24/120/600）、12 张 SVG 平铺块各自 = 自己的间距、
zoom 1 / 0.2 / 0.05 三档的层 opacity 与屏幕间距） / node-search 52 /
**task-queue 107**（v1.36 加 3 项：面板 `top:8` / 窄轨也 `top:8` / 头部让位变量 306→44；
v1.41 再加 7 项：`[inert] → display:none` 守卫规则 / 平时不带 inert / 真开一次设置后面板**真的**拿到 inert、
关掉**真的**被摘掉、位置与内容没被卸载） /
workflow-library 61 / **outpaint 97**（v1.38 新增、v1.39 扩到 97：九宫格几何（427×240 / 贴左贴右 / 竖幅 /
4096 上限）/ 预览百分比 / 两张节点的字段与落点 / 真点「生成扩图画面」→ 画布多**两张**节点、
扩图画面真的落成 427×240 的文件、一条生成请求都不发；全景图 / 角度两种草稿同样不自动生图且模型跟通道、
比例落在模型支持的表里） /
**canvas-ui 140**（v1.36 加 10 项：返回项目库按钮可访问、真点一次回看板、
ComfyUI 左侧槽位契约（含「在头部左半边」）、头部 z-index + 真实底色 + padding 读 inset 变量；
v1.38 再加 25 项：工具条 HD 已移除 / 扩图入口与面板契约 / 尺寸对话框 nova 契约 + vendor 整屏浮层不再出现；
v1.39 把扩图面板契约改成九宫格位置 + 延展内容 + 预览 + 新文案） /
**verify-ui 19**（v1.36 加 4 项：产物里返回项目库按钮 / 左侧胶囊槽位 / `topbar-left` / `fisherai-task-queue-inset） /
**last-model 39**（v1.40 新增：按 kind 分桶记、只认还留在目录里的名字、坏存档/脏值/非法 kind、写盘次数只在真变化时 +1、
**真点模型下拉**换到第二款后新节点默认就是它、记忆的模型不在目录里就回落第一个、图片记忆不串视频桶、
真点一次生成也记账、三个桥名与补丁 3.8q 在产物/源码里） /
**project-archive 100**（v1.42 新增：host 段 —— 规模预览 / `backup/save` 落盘与回执 / 同名不覆盖 /
导出目录三条边界（相对路径 / 指进素材目录 / 一次性自定义目录不落成默认）/ 下载形态的 `Content-Disposition` /
原始字节·本机路径·旧版 `.json` 三种导入 / 五种错误码 / 素材 URL 与文件都换到新项目；
jsdom 段 —— 头部入口与命中、面板契约、真点导出落盘、真上传导入（file input）、从路径导入、
项目看板头部「导入项目」走 window 桥、产物与文档守卫） /
**knife 40**（v1.49 新增：`d` 解析（三次贝塞尔采样，中点 (50, 37.5)）/ 世界→屏幕换算 / 点到线段距离 /
线段相交与 6px 容差 / 按 key 去重 / 真挂画布后真派发 Ctrl+右键拖拽：刀口浮层、红色预览、
松手只断开 A→C（B→C 保留）、Esc 取消不落刀、不按 Ctrl 不触发、右键菜单事件不被吞、
存盘后 `parentIds` 只剩 B）。

```powershell
# node 用 DSH 自带的运行时（PATH 里通常没有 node）
$node = "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts/clean.mjs; & $node scripts/vendor-aifisher.mjs; & $node scripts/build-canvas-css.mjs
& $node node_modules/tsdown/dist/run.js          # 构建顺序固定：clean → vendor → build:css → tsdown

& $node scripts/typecheck.mjs                    # 类型门禁（只对 src/ 报错，vendor 不进门禁）
& $node scripts/test-canvas-grid.mjs             # 单套；**判绿只认 SUMMARY 行**（pwsh 退出码不可信）
& $node scripts/verify-live-canvas-bundle.mjs    # 真机：服务端下发的 canvas-app.js == 刚构建的那份？（需 DSH 在跑）
& $node scripts/verify-live-channel-upload.mjs   # 真机且不花额度：参考素材 → /files/upload 换公网直链（假模型 ID 提交）
```

**2）真浏览器检查：28 场景 357 条断言 fail=0**（2026-10-23 v1.67 全量复跑；
其中 `grid-pan-hidpi` 用 `--force-device-scale-factor=1.25` 启动，守「网格不比节点快」；
v1.64 新增 `video-history` 场景（药丸真的点得到 / 扇形历史格摊在节点外且 `elementFromPoint` 打得到 / 三条 1.8KB mp4 在 Chrome 里真解码 320×180 / 设为主视频后主片换成蓝的那条），
v1.66 在同一场加 2 条「截帧入口在真布局里点得开、菜单三项、再点收起」；
v1.67 没动真布局里的入口，但把 `verify-video-frames.mjs` 扩到 18 项（含报障那段 56MB 真片子的首尾帧 + 等待判定），并全量复跑本套 357 条；
v1.65 新增 `video-references` 场景（真布局里从 10 张图的「连接输出」圆依次拖到视频节点上：9 张全接上、第 10 张被拒，注册表的 `maxInputs` 与模式声明的 9 自洽）；
v1.49 新增 `knife` 场景（Ctrl+右键真拖一刀：预览、只断被划过的那条、第二刀停在拖拽中当交付图）；
v1.48 给 `grid-pan` / `grid-pan-hidpi` 两场加了**三层显隐**真机断言（真浏览器里量每层 wrapper 的 inline opacity：zoom 1 = 小+大、0.2 = 大+更大、0.05 = 只剩最大一层），
并把 `canvas` 场景的截图像素上限按「大星交点叠墨」重新校准（p99 仍 ≤90，最亮交点 ≤170）；
v1.39 把 `outpaint` / `outpaint-panel` 两场按新流程重做：真画一次 427×240 的扩图画面、量落盘 PNG 的透明留白、量按钮中心没被 composer 盖住；
v1.40 新增 `last-model` 场景：真建三个图片节点验「没记过 → 通道别名 / 记一次 → 那一款 / reset 后回到第一个」；
v1.41 新增 `queue-layers` 场景：开设置时任务队列必须 `display:none` + 带 `inert` + 原位置 `elementFromPoint` 不再命中它；
v1.42 新增 `archive` 场景：真点头部「项目归档」→ 面板读数 → 真导出落盘，node 侧再解开归档核对素材随行；
v1.43 新增 `data-dir` 场景：设置 → 存储 → 「项目数据目录」面板真的挂上、读数就是这台机器的真路径、默认状态下「恢复默认」不可点）

| 场景 | 验什么 |
|---|---|
| `dashboard` | 看板首页；头部没有站外入口、设置按钮仍在；**v1.42 头部有「导入项目」按钮** |
| `canvas` | 头几何 + 点阵底纹（SVG/规格/1:1 铺/缩放平移跟随）+ **v1.27 真实命中路径与开关** + 截图像素（画出来了/间距 24px/墨色够淡）；**v1.36 返回项目库按钮真可见（elementFromPoint 命中头部，守住「头部不能被画布底盘盖住」）+ ComfyUI 胶囊停在左半边（dock=topbar-left）** |
| `workflow-node` | 真建本地工作流节点：尺寸、槽间距 34px、端口圆心压在节点左缘、v1.25 外半边命中/放大发光/不兼容不接；**v1.31 新建图片节点的默认模型 = 通道里勾的模型（不是 `GPT Image 2 · API`）** |
| `glow` | 提亮圆心像素：最亮 ≥150 且比空白区高 ≥60 |
| `settings` | 四个分区都能打开不报错；通道面板行内布局；**v1.27 画布互动开关点一下关掉 → 网格层同步 off**；**v1.29 请求方言下拉 + 「自动」按地址判成魔搭**；**v1.30 方言四项 + 两个一键预设** |
| `effects` | 只开设置→画布外观，停在「画布互动」面板截图（交付图） |
| `channels` | 只开设置→闭源服务，停在「OpenAI 通道」面板截图（交付图；量四项方言、两个预设、说明里的 `/image/generations`） |
| `node-search` | Shift+A 面板贴光标、过滤、建节点（含工作流候选）；**v1.45 真建出节点后左键放下，并量到节点不再跟手** |
| `workflow-config` | 面板尺寸、目录输入框、扫描、保存、添加到画布、节点图缩放/检查器 |
| `chat` | 启动球 → 面板 → 发消息 → DSH 会话 → SSE 回填 |
| `task-queue` | 面板贴右缘、运行中行的发光动画（computedStyle）、用时在跳；**v1.36 面板顶边距画布顶 = 8px** |
| `image-editor` | 真拖裁剪框 → 应用 → 保存为新图片 → 画布多一个落盘节点 |
| `image-annotate` | 蒙版舞台真画一笔 → 应用编辑 → 保存 |
| `image-saved` | 回看：源图 + 保存出来的新图都在，src 都是媒体地址 |
| `image-grid` | **v1.46 宫格裁剪 nova 版**：舞台铺满画布（1176×808）、图片真解码（775×581）、默认 2×2 = 4 格；真拖第一条竖向切线单格 160×120 → 171×120；3×3 → 9 格；导出序号 `1,3` → 保存 2 张；保存后画布多 2 个媒体节点；再打开舞台截图（交付图） |
| `grid-pan` | **v1.33 网格跟随速度**：dpr=1 下画布平移 160px → 网格背景也移 160px（ratio 1.0000）、格子 24×zoom；**v1.48 三层嵌套显隐**：zoom 1 = minor+major、0.2 = major+super、0.05 = 只剩 super（真机量 inline opacity） |
| `grid-pan-hidpi` | 同上，但用 `--force-device-scale-factor=1.25` 启动（本机 125% 缩放）：修复前量到 200px / 30px（= 1.25 倍），现在必须仍是 160px / 24px |
| `stack` | **v1.37 叠图切换**：一叠 3 张（红/绿/蓝 PNG）。控制条在卡里且可见、`elementFromPoint` 命中「切换」按钮自己、真点一下换成第 2 张且计数 2/3、连点三下绕回第 1 张、画布节点数始终 1（截图停在「第二张 / 切换 2/3」） |
| `video-history` | **v1.64 视频生成历史**：节点带 3 条历史（红/绿/蓝 1.8KB mp4，Chrome 真解码 320×180）。头部「历史 3」药丸在节点上方且 `elementFromPoint` 命中它自己；点开摊出 2 格，**rect 在节点框外 + 中心点打得到它自己**（守「外框 overflow-hidden 把扇形剪掉」）；点第 2 格的「设为主视频」→ 主片换成蓝的那条、历史仍是 3 条、画布节点数不变（截图停在「蓝主片 + 摊开的两条历史」）。**v1.66 加截帧入口断言**：底栏「截取视频帧」在真布局里点得开、菜单三项（first/last/both）、再点一下收起 |
| `video-references` | **v1.65 视频参考图数量**：1 个视频节点（多图参考）+ 10 张图，真拖 10 次线 → **9 张接上、第 10 张被拒**（修复前第 4 张就断）；截图停在「9 条参考线入视频节点、第 10 张空着」 |
| `outpaint` | **v1.38 扩图**：工具条 HD 没了 → 开面板 → 选四周 + 16:9 → 创建 → 画布多一个**空**节点（无结果图）、标题「扩图 · 四周 · 16:9」、composer 里提示词已填；**host 一整场收到 0 条 `/generate-*`** |
| `outpaint-panel` | **v1.38 扩图面板**：只开面板不创建（交付图：方向 / 目标比例 / 模型 + 「你的通道」） |
| `resize` | **v1.38 尺寸对话框**：真开 nova 卡片 → 320×240 → 点 2x → 640×480 → 保存 → 画布上那张新图的自然尺寸真是 640×480；同一时刻只有一个对话框（vendor 整屏浮层没一起渲染） |
| `last-model` | **v1.40 新节点默认用上一次的模型**：真建三个图片节点 —— 没记过时 = 目录第一个（通道别名「魔搭出图」）/ 记一次「上一次用的模型」→ 下一个新节点就是它 / 已建好的旧节点不动 / localStorage 留证 / reset 之后回到第一个（截图停在「第二款模型」那颗节点的 composer 上） |
| `queue-layers` | **v1.41 任务队列只在画布这一层**：基线面板在场（286px、无 inert）→ 开设置 → 面板 `display:none` + `inert=true` + 原位置 `elementFromPoint` 不再命中队列 → 切「画布外观」仍不可见（截图 = 设置页打开、右上角没有任务队列） |
| `archive` | **v1.42 项目归档**：头部「项目归档」按钮可访问且 `elementFromPoint` 命中它自己 → 面板 620×380 在视口内 → 读数「2 个节点 · 素材 2 个」→ 真点「导出到目录」→ 提示带落盘路径；node 侧再核对 `downloads/` 里真有 `.fisherai`、归档格式/项目 id 对、2 张素材都在（截图 = 面板 + 导出成功） |
| `data-dir` | **v1.43 项目数据目录**：设置 → 存储 里的「项目数据目录（缓存）」面板 830×460 挂上了 → 当前/默认目录读数就是这台机器的真路径 → 状态写「正在使用默认目录」→ `overridden=false` / `restart=false` / 「恢复默认」不可点 → 输入框预填当前目录（截图 = 设置页停在这一栏） |
| `knife` | **v1.49 切刀**：Ctrl+右键真拖一刀划过 A→C —— 起刀浮层 + 被划过的连线变红（只有 1 条）→ 松手后 DOM 里只剩 B→C（A→C 真的断开）→ `knifeReport()` 记 1 次切中/1 次断开；第二刀停在拖拽中当交付图（截图 = 刀口白虚线 + 红色高亮） |

```powershell
$env:BROWSER_ONLY = "canvas,settings,effects"    # 只跑指定场景
$env:BROWSER_CHECK_PORT = "4311"                 # 连跑要换端口（TIME_WAIT → EADDRINUSE）
& $node scripts/browser-check.mjs                # 截图在 .dsh-tmp/shots/，交付图另存 docs/shots/
& $node scripts/verify-live-workflow-library.mjs # 真机验收「工作流节点」面板 + 配图（需 DSH 在跑）
& $node scripts/verify-video-frames.mjs          # **v1.66 真机取帧**：真 Chromium + 构建产物里的 captureVideoFrames
```

**2.5）真机取帧取证：`scripts/verify-video-frames.mjs`（v1.66 起，v1.67 加真片子）**

截帧要**真解码视频**（几百毫秒）再**真上传**，而 `browser-check` 是 `--virtual-time-budget`
驱动退出的：解码期间虚拟时钟会被一路快进，`captureVideoFrames` 内部的等待窗口直接假超时
（实测：点完 1.2s 后节点还没出现，`until(...)` 的 20s/15s 窗口在几毫秒虚拟时间里全被烧完，
探针只回了一半，截图时还在「正在截取视频画面…」）。所以真取帧单独用一个**真时间**的
headless Chrome 验：

- 页面 `import('/canvas/canvas-app.js')`（就是画布加载的那份产物）→ 直接调
  `captureVideoFrames(fixture, ['first','last'])` → 把返回的 data URL 画回 canvas 读像素；
- 断言（**18 项**，全绿）：两帧都是 320×180、首帧像素 = 红色 fixture 的 `225,40,41`、
  尾帧时间 = `duration - 0.05 = 0.95`、尾帧不透明、只要求 `last` 时只回一条、
  蓝色 fixture 的尾帧是蓝的（不是旧帧）、`frameTargetSize(3840,2160) = 2048×1152`、
  `tailTimes(10) = [9.95, 9.8, 9.5, 8.8]`、整轮 < 8s（实测 13ms）；
- **v1.67 加报障真片子**：本机存在那段 `967×544 / 362.04s / 56.7MB` 的 mp4 时（路径可用
  `FRAME_REAL_VIDEO` 覆盖，别的机器自动 SKIP），必须 **8s 内**截出首尾帧 —— 实测两帧都是
  967×544、尾帧落在 `361.993s`、探针像素不透明、整轮 **569ms**；另外把
  `seekLanded`（`readyState=1` 不算到位 / 差 0.25s 算到位）与 `clampSeekTime`（seekable 只到
  20s 时把 361.99s 钳到 19.95s）在真浏览器里再过一遍。
- 这条教训通用的：**任何「真媒体解码 / 真上传」的等待都不该放进 virtual-time 场景**，
  jsdom 里只能测数据链路（本套件用桩替换 `__FISHERAI_VIDEO_FRAMES__`），真算法用这个脚本。

## 截图

| 图 | 说明 |
|---|---|
| ![画布](docs/shots/canvas-canvas.png) | 画布视图（头部/左栏/缩放控件 + 点阵底纹；v1.36 起左上「返回项目库」、ComfyUI 胶囊在左、任务队列贴右上角） |
| ![顶部（真机）](docs/shots/canvas-topbar-live.png) | 真机 DSH 窗口里的顶部（v1.36）：`← 项目库 / 品牌 / 项目名 / ComfyUI 待启动` 在左，保存状态让到任务队列左侧 |
| ![点阵提亮](docs/shots/canvas-cross-grid-glow.png) | 鼠标周围圆形提亮（`glow` 场景像素取证） |
| ![网格跟随](docs/shots/canvas-grid-pan-hidpi.png) | 125% 缩放下（dpr=1.25）的点阵：格子边长仍是 24 CSS px、与节点同速（`grid-pan-hidpi` 场景） |
| ![设置](docs/shots/canvas-effects.png) | 设置 → 画布外观 → 画布互动（v1.27） |
| ![通道](docs/shots/canvas-cloud-channels.png) | 设置 → 闭源服务 → OpenAI 通道（v1.30：方言四项 + 魔搭 / FisherAI 两个一键预设） |
| ![任务队列](docs/shots/canvas-task-queue.png) | 右上角任务队列（运行中循环发光；v1.36 上移到画布顶部） |
| ![叠图切换](docs/shots/canvas-stack-switch.png) | **v1.37**：折叠成一叠的图，宿主卡左下角 `3 张叠图 · 切换 2/3 · 展开` —— 不展开也能翻看这一叠（图里已经按一下换成了「第二张」） |
| ![扩图](docs/shots/canvas-outpaint.png) | **v1.38**：点「扩图 → 创建扩图节点」之后画布上的样子 —— **空**节点、标题「扩图 · 四周 · 16:9」、下面那条 composer 里提示词已经填好（尚未生成，等你自己点） |
| ![扩图面板](docs/shots/canvas-outpaint-panel.png) | **v1.38**：图片工具条上的「扩图」面板（方向 / 目标比例 / 模型 = 你通道里的模型 / 创建按钮） |
| ![尺寸](docs/shots/canvas-resize.png) | **v1.38**：nova 版「尺寸」对话框（倍增 2x → 640×480，预览 + 原图→目标读数） |
| ![上次模型](docs/shots/canvas-last-model.png) | **v1.40**：三张刚建的图片节点 —— 中间那颗的 composer 上写着「上一次用的模型」（`任务队列检查通道 · TQ/Fast-Image`），它正是**新建时自己带上的**；左边那颗是没记过时建的（通道别名「魔搭出图」） |
| ![任务队列只在画布层](docs/shots/canvas-task-queue-layer.png) | **v1.41**：设置打开时的画面 —— 右上角本来浮着的任务队列**整块不出现**（同一位置对比 `canvas-task-queue.png`） |
| ![项目归档](docs/shots/canvas-project-archive.png) | **v1.42**：画布头部「项目归档」面板 —— 上面是导出（`2 个节点 · 素材 2 个 · 归档约 3.1 KB`、导出目录、导出到目录/下载/打开目录），下面是导入（选文件 / 填绝对路径），底部那条就是「已导出 … .fisherai 到 …\downloads」的回执 |
| ![项目数据目录](docs/shots/canvas-data-dir.png) | **v1.43**：设置 → 存储 里的「项目数据目录（缓存）」—— 当前目录 / 默认目录读数、绝对路径输入框、「应用 / 恢复默认 / 刷新」、以及「把现有数据复制到新目录（只复制，不删旧目录）」 |
| ![切刀](docs/shots/canvas-knife.png) | **v1.49**：按住 Ctrl + 右键拖拽的切刀 —— 白色虚线是刀口、红色高亮是**会被切开**的那条连线（B→C）；松手就断开、Esc 取消（图里 A→C 已经切掉，只剩 B→C） |
| ![视频生成历史](docs/shots/canvas-video-history.png) | **v1.64**：视频节点的「历史 N」摊开 —— 主片已经「设为主视频」成蓝的那条（头部 `320x180 历史 3`），上/右两格是同一节点以前生成的绿/红两条（悬停即循环播放，角上是下载 / 设为主视频） |
| ![视频参考图数量](docs/shots/canvas-video-references.png) | **v1.65**：把那 10 张图依次拖到右边的视频节点上（多图参考）—— **9 条参考线接上了**，左下的第 10 张还空着（修复前第 4 张就拖不进去） |
| ![视频截帧菜单](docs/shots/canvas-video-frames.png) | **v1.66**：视频底栏「截取视频帧」弹开的三项菜单 —— 截取首帧 / 截取尾帧 / 首尾帧各一张（悬停底栏才出现；截完的图落在节点右侧并自动避开已有节点） |
| ![工作流配置](docs/shots/canvas-comfy-workflow-config.png) | ComfyUI 工作流配置（节点图 + 检查器） |
| ![工作流节点](docs/shots/workflow-nodes.png) | 工作流节点面板：配置好的工作流按图卡片陈列（v1.28，可自定义配图） |
| ![图片编辑](docs/shots/canvas-image-editor.png) | nova 版图片编辑工作台 |
| ![标注](docs/shots/canvas-image-annotate.png) | 标注 / 蒙版舞台 |
| ![对话](docs/shots/canvas-native-chat-dock.png) | 右侧 DSH 原生对话栏 |

## 目录

```
scripts/
  vendor-aifisher.mjs     上游源码 vendor + 所有正则补丁（每条断言命中次数）
  build-canvas-css.mjs    Tailwind（theme+utilities，不含 preflight）→ vendor/aifisher/tailwind.generated.ts
  patches/aifisher/**     7 个整文件覆盖补丁（清单 / 节点 UI / 运行路径 / 接入口判定 / 图片工具条 / 角度草稿 / 图像工具主按钮）
  browser-check.mjs       真 Chrome 28 场景（含 PNG 解码器做像素断言；`grid-pan-hidpi` 跑在 dpr=1.25）
  verify-live-modelscope.mjs 真机：走魔搭真出图，配对（红/绿参考图）证明参考图被用上（含 openai 方言对照）
  verify-live-workfisher.mjs 真机：走 FisherAI 真出图（异步任务 + 参考图先上传换直链），纯红参考图验颜色
  verify-live-canvas-bundle.mjs 真机：问正在跑的 DSH 要 canvas-app.js，跟磁盘构建产物比 sha256（证明「刷新即生效」）
  verify-live-dock.mjs    真机：右侧会话栏（内核原生会话正文/滚轮）+ v1.41 新对话输入区贴底的 A/B 测量
  verify-live-skills.mjs  真机：在画布会话栏里用技能（conversation.input.right 技能按钮 → 技能面板列 10 条 →
                          点选把 `/技能名` 插进输入框；手打 `/` 也弹同一批候选）+ 技能目录两路取证
                          （运行中的 host / 磁盘构建 + 真技能目录）
  lib/                    canvas-harness（jsdom 真挂载）、png.mjs（灰度测点阵 + RGB 测颜色）
  test-*.mjs              30 套回归 + smoke-contract + verify-canvas-ui（v1.37 加 test-canvas-stack，v1.38 加 test-canvas-outpaint，
                          v1.40 加 test-canvas-last-model，v1.49 加 test-canvas-knife）
  src/
  host/                   index.ts（装配）、comfyui/**、generation/**、canvas/**、media/**、http/**
  client/                 apply / CanvasPanel / CanvasShell / CanvasChatDock / PanelExitButton
  client/canvas/          mount / stage / bootstrap / styles / canvasGrid / knife / diagnostics
  canvas-ui/              shadcn 化层：ui 组件 + canvas 里的各个面板与 store
vendor/aifisher/          上游树（构建时生成，不要手改）
docs/                     详细文档 + 交付截图
```

## 已知限制 / 下一步

- ComfyUI 本地进程**不自启**：设置页只读显示状态；启动请用绘世启动器。
- `/workflow-library`（上游 workflowManager 那套执行工作流）仍 501；导演台/分镜/技能社区/反馈中心/内置浏览器未移植。
- 方舟账号 2133080946 **尚未在控制台开通任何图片模型**（404 时先去
  `console.volcengine.com/ark/region:ark+cn-beijing/openManagement` 开通，与 API Key 无关）。
- 组合（多图层）、全景 / 角度的外观仍是 vendor 原样（尺寸对话框已在 v1.38、宫格裁剪已在 v1.46 换成 nova 版）。
- 魔搭（ModelScope）这条通道只接了**同步语义**的那部分：`loras` 没接（画布上没有对应控件）；
  `size` 由画布的档位/宽高比换算（1K+16:9 → `1024x576`，实测接受）；不认 OpenAI 的 `n`，
  所以「生成数量 > 1」由 host 按次数提交（会真的消耗多次额度）。
  `Qwen/Qwen-Image-2.1-Turbo` 不在魔搭 `GET /models` 的回报清单里，只能用面板上的「手填模型 ID」
  或「+ 魔搭 API-Inference」预设加进来。
- FisherAI 这条通道只接了**图像**：视频（`/v1/videos` + 小写状态机 + `metadata.url`）、音频/音乐
  （`/v1/audio/generations`、`/v1/music/*`）没接 —— 配了那类模型仍会按 OpenAI 兼容路径打过去并失败。
  图像里 `workfisher-image-g-v2.5-flare/sunburst` 的「画质 / 输出格式 / 背景 / 审核」四个高级参数也没接到
  画布控件（用服务端默认），画布上只发模型/尺寸/数量/参考图。
  参考图上限 15 张（低价扩展版）、单任务只回 1 张，画布侧不拦张数，超了由上游拒（`fail_reason` 会带回来）。
- 各子系统细节见 `docs/dsh-host-client-bridge.md`、`docs/canvas-ui-shadcn.md`、
  `docs/comfyui-local-setup.md`、`docs/aifisher-bootstrap-analysis.md`、
  `docs/storage-and-migration.md`（数据存放与换机迁移）。
