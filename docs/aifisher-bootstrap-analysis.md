# AIFISHER 无限画布 → DSH 插件：启动层施工考古报告

分析对象：`E:\开源项目\AIFISHER-main`（**只读，未改动任何文件**）
目标：给 `E:\开源项目\dsh-aifisher-canvas` 一个「能渲染 + 能编辑（拖拽/连线/编组/undo）+ 刷新不丢」的最小启动集。后端能力（生成/账号/agent/本地 ComfyUI/storyboard/drama）第一阶段全部不要。

**一句话结论**：
`src/stable/main.ts` 里 **47 个** `installXxx / createXxx / startXxx` 调用中，**只有 15 个是第一阶段必须的**，其余 32 个要么连 AIFISHER 后端，要么只服务被砍掉的功能。
画布核心（`canvas/nodes/dialogs/persistence/media/text`）**没有任何模块在 import 阶段读 `window.__FISHERAI_*`**（184 个核心文件全树扫描，顶层命中 = 0）。
且**没有任何全局是「不装就抛错」的硬依赖**——所有 `window.__FISHERAI_*` 读取都在函数体内，且几乎全部走可选链或 `if` 兜底。
唯一真正的硬依赖是 `useCanvasContextMenu` 里 **直接调用函数**（不是读全局）的 `installStableCanvasContextActions()`（`canvas/canvasContextHooks.ts:34`），但它自身有幂等 guard，任何路径第一次调用即可满足。

---

## 0. 启动时序事实（后续所有判断的基础）

```
index.html:14   <script type="module" src="/src/stable/app/main.tsx">
main.tsx:1      import { preventFileDropNavigation } from '../../shared/fileDrop'
main.tsx:2      import '../main'      ← 先执行 main.ts 全部 47 个 installer（含 :69 顶层 await）
main.tsx:9      const element = document.getElementById('root')
main.tsx:11     preventFileDropNavigation()
main.tsx:13-17  createRoot(element).render(<StrictMode><CanvasRoot/></StrictMode>)
canvasRuntime.tsx:56-166  const dependencies: Dependencies = {...}
canvasRuntime.tsx:168-170 CanvasRoot() { return CanvasApplication(React, dependencies) }
```

关键点：
- `main.ts:69` 是 **顶层 `await installPreferenceStore(window.fetch.bind(window))`**，会阻塞 `createRoot` 直到 hydrate 完成（`preferenceStore.ts:116` 有 `AbortSignal.timeout(3000)`，最坏阻塞 3s）。第一阶段必须换成**同步**的本地 store（见 §4.2）。
- `vite.stable.config.ts` 的 `define.__FISHERAI_BUILD__` 被 `main.ts:60` 使用（声明在 `vite-env.d.ts:4`）→ **我们的构建必须 define 这个常量**，否则 vendored `main.ts` 编译不过。
- `canvasRuntime.tsx:8` 从 `../../config/modelConfig` 引入 `IMAGE_MODELS/VIDEO_MODELS/TEXT_MODELS/AUDIO_MODELS` → 必须一起 vendor（`app/canvasComponents.ts:24` 也用它；`canvasComponents.ts:25` 用 `../../../package.json` 的 `version`，`vendor-aifisher.mjs:65-79` 已生成兜底 package.json）。
- `app/canvasComponents.ts:2` import `@tiptap/react`；`:5-7` import `@react-three/fiber`、`@react-three/drei`、`three` → 见 §6 红线 7。

---

## 1. installer 清单分级（47 项，逐条；编号 = `main.ts` 行号）

分级含义：**保** = 第一阶段必须装；**丢** = 不装；**待定** = 不装也能跑，看需求。

### 1.1 后端 / 账号 / agent / drama / 本地 runtime 组（29 项，全丢）

| main.ts 行 | 名称 | 源文件 | 干什么（一句话） | 依赖后端? | 证据行号 | 分级 |
|---|---|---|---|---|---|---|
| 60 | `installWorkflowRecoveryFetch()` | `generation/workflowRecoveryBoundary.ts` | 包裹 `window.fetch`，把工作流节点的 `/api/generation-status/*` 挡成 404 | 是（改写 `window.fetch`） | `:23` `:56-70` `:81 windowObject.fetch = recoveryFetch` | 丢 |
| 62 | `installDramaCanvasBridge()` | `agent/dramaCanvasBridge.ts` | 建「文戏/短剧 → 画布」桥，写 `__FISHERAI_DRAMA_BRIDGE__` | 是（drama） | `:89`；消费方 `canvasApplication.tsx:296-317` | 丢 |
| 63 | `installBackendReconnectNotice()` | `desktop/backendReconnectNotice.ts` | 桌面壳后端重连提示条 | 是（依赖 `desktopBridge().onBackendState`） | `:34` `:40 if (!bridge) return` `:54` | 丢（`bridge` 为 null 时自己 no-op） |
| 64 | `installDesktopUpdateSurface({...})` | `update/desktopUpdate.ts` | 桌面版自动更新界面 | 是（`desktopBridge().update`） | `main.ts:67` 读 `__FISHERAI_BEFORE_DESKTOP_UPDATE__` | 丢 |
| 69 | `await installPreferenceStore(window.fetch)` | `persistence/preferenceStore.ts` | 账号级界面偏好存储，`GET/PATCH /api/preferences` | 是 | `:9 ENDPOINT='/api/preferences'`、`:67`、`:113` | **保（改成同步本地实现）** |
| 71 | `createSourceSettingsClient()` | `generation/sourceSettingsClient.ts` | 生成来源/模型目录客户端 | 是 | `:195 /api/generation/sources`、`:208/:249 /api/config/keys`、`:262/:267/:274/:282/:294/:311 /api/local-runtime/*` | 丢 |
| 72 | `installAgentModelAvailability(client)` | `generation/agentModelAvailability.ts` | agent 可用文本模型过滤；**安装时立即发请求** | 是 | `:49 client.getBlocks()` → `sourceSettingsClient.ts:195`；`:81 void bridge.refresh()` | 丢 |
| 73 | `installRelayAccountCenter()` | `account/relayAccountCenter.ts` | 中转账号中心 | 是（账号） | `:664 window.__FISHERAI_RELAY_ACCOUNT__` | 丢 |
| 74 | `installFeedbackCenter()` | `feedback/feedbackCenter.ts` | 意见反馈中心 | 是 | 894 行，反馈接口 | 丢 |
| 75 | `installAgentClient()` | `agent/agentClient.ts` | agent HTTP 客户端 | 是 | `:301 /api/chat/sessions`、`:304`、`:311`、`:324 /api/chat/tools/search-nodes`、`:342 __FISHERAI_AGENT__` | 丢 |
| 76 | `installAgentSkillClient()` | `skills/skillClient.ts` | 技能客户端 | 是 | `:68 window.__FISHERAI_SKILLS__` | 丢 |
| 77 | `installSkillCommunity(client)` | `skills/skillCommunity.ts` | SKILL 社区面板 | 是 | 497 行 | 丢 |
| 94 | `installImageModeAdapter()` | `generation/imageMode.ts` | image mode 纯函数适配器 → `__FISHERAI_IMAGE_MODE__` | 否 | `:39-48`（无 fetch） | 丢（纯写全局、**无读者**） |
| 95 | `installMidjourneyReferenceAdapter()` | `generation/midjourneyReferences.ts` | MJ 参考图分配纯函数 → `__FISHERAI_MIDJOURNEY_REFERENCES__` | 否 | `:125-154` | 丢 |
| 96 | `installVideoModeAdapter()` | `generation/videoMode.ts` | video mode 纯函数适配器 | 否 | 170 行纯函数 | 丢 |
| 97 | `installImageResultHistory()` | `generation/imageResultHistory.ts` | 图片结果历史合并纯函数 → `__FISHERAI_IMAGE_RESULT_HISTORY__` | 否 | `:58-67` | 丢 |
| 98 | `installGenerationScheduler()` | `generation/generationScheduler.ts` | 生成调度器（并发/attempt 记账） | 否（自身不发请求） | `:263-267`；**被核心读**：`text/CanvasTextNodeContent.tsx:45,79`、`nodes/mediaComposer.ts:107`、`nodes/canvasTextComposer.tsx:93`、`generation/generationClient.ts:14` | 丢（读点全部 `?.`，降级 = 不显示「生成中」） |
| 99 | `installGenerationRecovery()` | `generation/generationRecovery.ts` | 生成结果恢复轮询 → `__FISHERAI_GENERATION_RECOVERY__` | 是 | `:161 fetchImpl=window.fetch`、`:180-181 fetchImpl('/api/generation-status/<id>')`、`:241 setInterval(scan, 10s)` | 丢（配合 `useVideoResults/useImageResults` 一起不接） |
| 100 | `installModelPricing(client)` | `generation/modelPicker.ts` | 价格展示（DOM 观察器 + `__FISHERAI_MODEL_PRICING__`） | 是 | `:104`、`:206`、`:1134-1137 client.getModelGroups()` | 丢 |
| 102 | `installLocalRuntimeClient()` | `local/localRuntimeClient.ts` | 本机 ComfyUI 运行时客户端 → `__FISHERAI_LOCAL_RUNTIME__` | 是 | `:152-197 /api/local-runtime/*`、`:192 /api/config/keys`、`:211` | 丢 |
| 103 | `createWorkflowManagerClient()` | `local/workflowManagerClient.ts` | 工作流库客户端（804 行） | 是 | 工作流库/ComfyUI 接口 | 丢 |
| 104 | `installWorkflowCanvasNodes(client)` | `local/workflowCanvasNodes.ts` | ComfyUI 工作流节点（2082 行）→ `__FISHERAI_WORKFLOW_NODES__` | 是 | `:1392 fetch`、`:2080 window.__FISHERAI_WORKFLOW_NODES__ = adapter` | 丢（但见 §2 警告，建议补 stub） |
| 105 | `createAgentConversation(...)` | `agent/agentConversation.ts` | agent 会话状态机（260 行） | 是 | — | 丢 |
| 106 | `installDramaConversationShortcut(...)` | `agent/dramaConversationShortcut.ts` | 短剧会话快捷键 → `__FISHERAI_AGENT_CONVERSATION__` | 是 | `:25-27`、`:522-523` | 丢 |
| 107 | `installDramaConversationTools(...)` | `agent/dramaConversationTools.ts` | 短剧会话工具 | 是 | `:585-598` 读 `__FISHERAI_WORKFLOW_NODES__` | 丢 |
| 108 | `installWorkflowManager(client)` | `local/workflowManager.ts` | 工作流管理器 UI（3610 行） | 是 | `:49`、`:1296` | 丢 |
| 109 | `installComfyLogPanel(client)` | `local/comfyLogPanel.ts` | ComfyUI 日志面板（403 行） | 是 | — | 丢 |
| 110 | `installMiniMaxH3CanvasAdapter()` | `media/minimaxH3.ts` | MiniMax-H3 节点适配 → `__FISHERAI_MINIMAX_H3__` | 是（远端生成） | `:543`；读者 `canvasNodeRules.ts:215` 带 `?.` | 丢 |
| 111 | `installMiniMaxPromptScroll()` | `media/minimaxPromptScroll.ts` | MiniMax 提示词滚动增强（86 行 DOM 增强） | 否 | — | 丢 |
| 112 | `installVideoWorkflows()` | `media/videoWorkflows.ts` | 视频工作流客户端 → `__FISHERAI_VIDEO_WORKFLOWS__` | 是 | `:47 /api/comfy/capabilities`、`:76` | 丢 |
| 113 | `installPromptAssistant()` | `prompt/promptAssistant.ts` | 提示词助手 → `__FISHERAI_PROMPT_ASSISTANT__` | 是 | `:76` | 丢 |
| 114 | `installPromptExpand()` | `prompt/promptExpand.ts` | 提示词扩写（848 行） | 是 | — | 丢 |
| 115 | `installPromptPresets()` | `prompt/promptPresets.ts` | 提示词预设 → `__FISHERAI_PROMPT_PRESETS__` | 是 | `:171` | 丢 |
| 117 | `installStoryboardClient()` | `storyboard/storyboardClient.ts` | 分镜客户端 → `__FISHERAI_STORYBOARD__` | 是 | `:144` | 丢 |
| 118 | `installMediaEditing()` | `media/mediaEditing.ts` | 服务端图片/音频编辑客户端 → `__FISHERAI_MEDIA_EDITING__` | 是 | `:86-97 /api/media/images/{crop,grid,annotation}`、`/api/trim-video`、`/api/trim-audio`、`:121` | 丢 |

### 1.2 画布行为组（9 项，全保）

| main.ts 行 | 名称 | 源文件 | 干什么 | 依赖后端? | 写入全局 | 分级 |
|---|---|---|---|---|---|---|
| 78 | `installStableCanvasClipboard()` | `canvas/canvasClipboard.ts` | 克隆/插入/删除节点纯函数 | 否 | `__FISHERAI_CANVAS_CLIPBOARD__`（`:195`） | 保 |
| 79 | `installStableCanvasConnections()` | `canvas/canvasConnections.ts` | 连线/断线纯函数 | 否 | `__FISHERAI_CANVAS_CONNECTIONS__`（`:271`） | 保 |
| 80 | `installStableCanvasContextActions()` | `canvas/canvasContextActions.ts` | 右键菜单状态构造 + 资格判断 | 否 | `__FISHERAI_CANVAS_CONTEXT_ACTIONS__`（`:116`） | **保（唯一硬依赖）** |
| 81 | `installStableCanvasEditing()` | `canvas/canvasEditing.ts` | 移动/缩放/undo/redo 历史纯函数 | 否 | `__FISHERAI_CANVAS_EDITING__`（`:360`） | **保** |
| 82 | `installStableCanvasGroups()` | `canvas/canvasGroups.ts` | 编组/解组/清理 | 否 | `__FISHERAI_CANVAS_GROUPS__`（`:252`） | 保 |
| 83 | `installStableCanvasLayout()` | `canvas/canvasLayout.ts` | 对齐/网格排列 | 否 | `__FISHERAI_CANVAS_LAYOUT__`（`:154`） | 保 |
| 84 | `installStableCanvasNavigation()` | `canvas/canvasNavigation.ts` | 滚轮平移/缩放 + 合成策略 `<style>` + 浏览器缩放守卫 | 否 | `__FISHERAI_CANVAS_NAVIGATION__`（`:193`） | **保** |
| 85 | `installStableCanvasSelection()` | `canvas/canvasSelection.ts` | 点选/框选/组选 | 否 | `__FISHERAI_CANVAS_SELECTION__`（`:150`） | **保** |
| 86 | `installWorkflowPresetComposition()` | `canvas/workflowPresetComposition.ts` | 预设依赖收集纯函数 | 否 | `__FISHERAI_WORKFLOW_PRESET_COMPOSITION__`（`:89`） | 保 |

#### 「是否必须在 React 渲染前执行」——重要澄清（与任务假设不同）

这 9 个 installer **不全是**渲染前必须的，必须区分三种情况：

| 情况 | installer | 依据 |
|---|---|---|
| **A. install 行为本身就是渲染/交互路径的一部分** | `installStableCanvasNavigation` | `canvasNavigation.ts:167-168` 在 install 时调 `installStableCanvasCompositingPolicy()`（向 `document.head` 注入 `#canvas-viewport-content { will-change: auto !important }` 策略样式，`:144-164`）和 `installCanvasLocalBrowserZoomGuard()`（`window` 级 wheel capture 监听，`:71-79`）。不执行 → 视口 transform 动画会抖 + Ctrl+滚轮被浏览器缩放吃掉。 |
| **A′. 同一类，但会自我兜底** | `installStableCanvasContextActions` | `canvas/canvasContextHooks.ts:34` 在 hook 顶层**直接调用**该函数（`const adapter = installStableCanvasContextActions();`）；`useCanvasContextMenu` 由 `canvasApplication.tsx:703` 无条件调用 → 即使 main.ts 不调，第一次渲染也会调。显式预调只是提前 + 去重。 |
| **B. 纯「提前注册 + 去重」** | clipboard / connections / editing / groups / layout / selection / workflowPresetComposition | 全是纯函数 + 写一个**几乎无人读**的全局（见 §2）。canvas 内部走 import 直调，不经过全局。仅 `clipboard`（`canvasCommands.ts:89-99`）与 `editing`（`canvasApplication.tsx:902,958` 的拖拽/缩放/undo 路径）**读**全局，但都 `?.` + `?? 本地实现` 降级。 |

**结论**：第一阶段建议把这 9 个都在 render 前按原顺序调用一遍（成本为零，与上游语义一致），但要知道**只有 `navigation` 与 `contextActions` 有实质性的「必须先执行」理由**。

### 1.3 其余组（chrome / 媒体 / 存储 / 设计系统）

| main.ts 行 | 名称 | 源文件 | 干什么 | 依赖后端? | 证据行号 | 分级 |
|---|---|---|---|---|---|---|
| 68 | `installCanvasAppearance()` | `appearance/canvasAppearance.ts` | 注入 `#aifisher-appearance-tokens` 主题 CSS 变量 + 本地主题存储；`:227 loadImage()` 拉背景图 | 主题=否；背景图=是 | `:217-222` 注入 style；`:223-226`；`:150 fetchImpl(BACKGROUND_ENDPOINT)` + `:156-158 catch` 静默 | **保**（不装则 `var(--af-*)` 全部缺失，整页样式崩） |
| 87 | `installMediaDownloadFileName()` | `media/mediaDownloadFileName.ts` | 下载回写文件名 → `__FISHERAI_MEDIA_DOWNLOAD__` | 是 | `:233`、`:278`、`:310-322 /api/media-download/*` | 丢（读点 `canvasApplication.tsx:823` 有 `if (... && !window.__FISHERAI_MEDIA_DOWNLOAD__) throw Error('素材不可用')`） |
| 88 | `installMediaNodeSizing()` | `media/mediaNodeSizing.ts` | 媒体节点自适应尺寸 → `__FISHERAI_MEDIA_NODE_SIZING__` | 否 | `:84-90` | 待定（**无读者**；`canvasNodeRules.ts:164` 用的是本地 `adaptiveMediaNodeSize`，不走全局） |
| 89 | `installStableVideoPlayback()` | `media/videoPlayback.ts` | 视频音量记忆 → `__FISHERAI_VIDEO_PLAYBACK__` | 否 | 读者 `media/useCanvasVideoPlayback.ts:30,33,104` 全 `?.` | 丢（降级 = 音量不记忆） |
| 90 | `installStableDesignSystem().observe()` | `design/designSystem.ts` | createToast/createButton/createDialog 等命令式 UI + MutationObserver 入场动画 | 否 | `:989-1056`；`preferenceStore` 用在 `:112-120` | 待定（`createToast` 被 `canvasWorkflow.ts:5,190` 直接 import 用，**不依赖全局**，能省；但建议保，成本低） |
| 91 | `installProjectDashboardChrome()` | `navigation/projectDashboardChrome.ts` | dashboard 的 CSS/DOM chrome 增强 | 否（有站外链接常量，**v1.15 已把两个外链入口移除**） | `:1-5`、`:7-24` 外链 | 待定（只影响 dashboard 观感；实际已装 —— 看板根 `100dvh`→`100%` 与「设置」按钮都靠它，见 `scripts/vendor-aifisher.mjs` 3.8b / 3.8i） |
| 92 | `installCanvasSession()` | `persistence/canvasSession.ts` | 会话续接（`sessionStorage: fisherai.canvas.resume.v1`，纯本地） | **否** | `:3`、`:57-93`（仅 `getItem/setItem`）；读者 `canvasApplication.tsx:81` | **保（「刷新不丢」的关键）** |
| 93 | `installCanvasAutoSave()` | `persistence/canvasAutoSave.ts` | 自动保存控制器（自身无 HTTP） | 否 | `:151-164` | **保**（`canvasAutoSaveLifecycle.ts:67,113` 的依赖） |
| 101 | `installNodeFramework()` | `nodes/nodeFramework.ts` | 节点工厂 → `__FISHERAI_NODE_FRAMEWORK__` | 否 | `:635-639`；消费方仅 `nodes/canvasNodeState.ts:150`（低频事件回调） | 丢（纯写全局 + 一处直接 import 调用，无预装必要） |
| 116 | `installLocalProfile()` | `profile/localProfile.ts` | 本地头像（`preferenceStorage` + MutationObserver） | 否 | `:99-165`；`__FISHERAI_LOCAL_PROFILE__` **无外部读者** | 丢 |
| 119 | `startStableMediaEnhancement({ renderer: new NativeStableMediaRenderer() })` | `media/stableMediaEnhancement.ts` + `media/nativeStableMediaRenderer.ts` | 媒体 DOM 增强轮询（201 + 20 行） | 否 | — | 丢 |

**分级汇总（47 项）**

| 分级 | 数量 | 明细 |
|---|---|---|
| **保** | 15 | §1.2 的 9 项（78-86）+ `installCanvasAppearance`(68) + `installPreferenceStore`(69，改本地) + `installCanvasSession`(92) + `installCanvasAutoSave`(93) + `installStableDesignSystem`(90) |
| **待定** | 3 | `installMediaNodeSizing`(88) + `installProjectDashboardChrome`(91) + `installStableVideoPlayback`(89) |
| **丢** | 29 | §1.1 全部 + `installMediaDownloadFileName`(87) + `installNodeFramework`(101) + `installLocalProfile`(116) + `startStableMediaEnhancement`(119) |

> 实操建议：**保**集里真正不可省的只有
> `installPreferenceStore`(本地化)、`installCanvasAppearance`、`installCanvasSession`、`installCanvasAutoSave`、
> `installStableCanvasNavigation`、`installStableCanvasContextActions`，
> 以及 §1.2 的其余 7 个纯函数 adapter（成本为零，建议一并装上）。
> `installMediaNodeSizing` / `installStableDesignSystem` / `installProjectDashboardChrome` / `installStableVideoPlayback` 属「顺手」，可有可无。

---

## 2. `window.__FISHERAI_*` 全局（画布核心读取的全部）

> 扫描范围：全仓 `*.ts,*.tsx,*.js,*.mjs,*.html`（排除 node_modules）。
> **关键事实：没有任何模块在 import 阶段（模块顶层）读这些全局。** 184 个核心文件按缩进 = 0 判定顶层，命中数 = 0。
> 因此「不装就崩」不来自 import，只来自函数体内的**非可选**访问。

| 全局名 | 谁写入（文件:行号） | 画布核心在哪读（文件:行号） | 读不到时的行为 | 第一阶段能否不装 |
|---|---|---|---|---|
| `__FISHERAI_CANVAS_SESSION__` | `persistence/canvasSession.ts:115`（`installCanvasSession`） | `canvas/canvasApplication.tsx:81`（裸读属性）；`:1079`、`:1084`、`:1169`、`:1180`、`:1184`、`:1193`（全部 `session?.`） | `:81` 得 `undefined` **不抛**（`window.x` 属性访问）；其余走 `session?.` → 会话续接禁用（刷新回 dashboard） | **必须装**（「刷新不丢」） |
| `__FISHERAI_CANVAS_SELECTION__` | `canvas/canvasSelection.ts:150` | `canvas/canvasApplication.tsx:878`（`?.clearSelection() ?? []`）、`:1457-1466`（`if (Ge) … else 本地实现`）、`:1478-1489`（同上） | 降级为内联实现（手算 additive/locked） | 可不装（只少 locked 语义） |
| `__FISHERAI_CANVAS_EDITING__` | `canvas/canvasEditing.ts:360` | `canvas/canvasApplication.tsx:902`（`?.getMovableNodeIds(...) ?? selectedNodeIds`）、`:958`（`?.hasPendingMove()` → `undefined` falsy） | 降级为「不过滤锁定节点」「pendingMove 视为 false」→ history commit 时机略变 | 可不装 |
| `__FISHERAI_CANVAS_NAVIGATION__` | `canvas/canvasNavigation.ts:193` | `canvas/canvasViewport.ts:131` → `:133-137` **三元兜底**到 `panViewport/zoomViewportAtPoint` | 降级为本地纯函数（**行为等价**，adapter 内部就是同一函数） | 可不装（但见 §1.2 A：install 时的 2 个副作用必须补） |
| `__FISHERAI_CANVAS_CLIPBOARD__` | `canvas/canvasClipboard.ts:195` | `canvas/canvasCommands.ts:89` → `:90 (adapter?.clone ?? cloneCanvasNodes)`、`:97 (adapter?.insert ?? insertClonedCanvasNodes)` | 降级为 import 的同一函数（**行为等价**） | 可不装 |
| `__FISHERAI_CANVAS_GROUPS__` | `canvas/canvasGroups.ts:252` | **无读者**（全仓扫描仅写入点） | n/a | 可不装 |
| `__FISHERAI_CANVAS_CONNECTIONS__` | `canvas/canvasConnections.ts:271` | **无读者** | n/a | 可不装 |
| `__FISHERAI_CANVAS_LAYOUT__` | `canvas/canvasLayout.ts:154` | **无读者** | n/a | 可不装 |
| `__FISHERAI_CANVAS_CONTEXT_ACTIONS__` | `canvas/canvasContextActions.ts:116` | **无读者**（`canvasContextHooks.ts:34` 直接调 install 函数本身，不经全局） | `:34` 会自己调用 | 可不预装 |
| `__FISHERAI_CANVAS_AUTO_SAVE__` | `persistence/canvasAutoSave.ts:163` | **无直接读者**；`canvasAutoSaveLifecycle.ts:67,113` 直接 import 调 `installCanvasAutoSave()` | 自己兜底 | 可不预装 |
| `__FISHERAI_WORKFLOW_PRESET_COMPOSITION__` | `canvas/workflowPresetComposition.ts:89` | **无读者** | n/a | 可不装 |
| `__FISHERAI_NODE_FRAMEWORK__` | `nodes/nodeFramework.ts:638` | **无读者**（`canvasNodeState.ts:150` 走直接 import） | n/a | 可不装 |
| `__FISHERAI_DESIGN_SYSTEM__` | `design/designSystem.ts:1056` | **无读者**（`createToast` 等为直接 import） | n/a | 可不装 |
| `__FISHERAI_LOCAL_PROFILE__` | `profile/localProfile.ts:163` | **无读者** | n/a | 可不装 |
| `__FISHERAI_WORKFLOW_NODES__` | `local/workflowCanvasNodes.ts:2080` | `nodes/canvasNodeRules.ts:172,182,209,210,224,310`；`nodes/canvasNodeOperations.ts:240`；`nodes/canvasNodeState.ts:60,69,118,130`；`app/canvasRuntime.tsx:87`；`local/canvasWorkflowGenerator.tsx:68` | 全部 `?.`，**唯一例外见下方警告** | 条件性（见下） |
| `__FISHERAI_MINIMAX_H3__` | `media/minimaxH3.ts:543` | `nodes/canvasNodeRules.ts:215`；`app/canvasRuntime.tsx:88` | `?.getPortY(...) ?? 500` 有兜底 | 可不装 |
| `__FISHERAI_GENERATION_SCHEDULER__` | `generation/generationScheduler.ts:266` | `text/CanvasTextNodeContent.tsx:45,79`；`nodes/mediaComposer.ts:107`；`nodes/canvasTextComposer.tsx:93` | `?.` → 生成中状态恒 false，文本节点仍可编辑 | 可不装 |
| `__FISHERAI_MODEL_PRICING__` | `generation/modelPicker.ts:206` | `nodes/mediaComposer.ts:116`（`useComposerPricing`） | `?.` → pricing 为 undefined，价格条不渲染 | 可不装 |
| `__FISHERAI_MEDIA_DOWNLOAD__` | `media/mediaDownloadFileName.ts:89` | `canvas/canvasApplication.tsx:823`（**显式 `if (!window.__FISHERAI_MEDIA_DOWNLOAD__) throw Error('素材不可用')`**）、`:830` | 该命令抛错（被 agent 通道捕获）——只在用户触发「下载」时 | 可不装（纯功能缺失） |
| `__FISHERAI_GENERATION_RECOVERY__` | `generation/generationRecovery.ts:322` | **无核心读者** | n/a | 可不装 |
| `__FISHERAI_DRAMA_BRIDGE__` | `agent/dramaCanvasBridge.ts:89` | `canvas/canvasApplication.tsx:296` | `dramaBridge` = undefined → `:299-317` 的 `?.setProject/?.bind` 全跳过 | 可不装 |
| `__FISHERAI_FOCUS_NODES__` | `canvas/canvasApplication.tsx:1152`（**画布自己写**） | 外部：`local/workflowManager.ts:49`、`local/runningHubWebAppManager.ts:291` | 外部 `?.()` | 无需处理（画布自给自足） |
| `__FISHERAI_BEFORE_DESKTOP_UPDATE__` | `persistence/canvasAutoSaveLifecycle.ts:83`（画布自己写） | `main.ts:67`（已丢弃的桌面更新） | 无人读 | 无需处理 |
| `__FISHERAI_MEDIA_EDITING__` | `media/mediaEditing.ts:121` | **核心无读者** | n/a | 可不装 |

### 警告：唯一一处「非可选」全局访问（潜在崩点）

```ts
// nodes/canvasNodeRules.ts:170-175
if (node.type === 'ComfyUI')
  return node.kind === 'workflow'
    ? (positive(window.__FISHERAI_WORKFLOW_NODES__?.getNodeSize(node).width) ?? 520)
    //                                                    ^^^^^^^^^^^^^^^^^^^^^ 没有 ?.
    : node.comfyMode === 'minimax-h3-t2va' ? 900 : legacyWorkflowWidth;
```

- `?.` 只保护到方法本身；若 `__FISHERAI_WORKFLOW_NODES__ === undefined`，`undefined?.getNodeSize(node)` 求值为 `undefined`，紧接着 `.width` → **`TypeError: Cannot read properties of undefined`**。
- 同类写法还有 `canvasNodeRules.ts:181-182`（`nodeHeight`，`?.getNodeSize(node).height`）。
- `nodeWidth` / `nodeHeight` 被 `canvasRuntime.tsx:62-63,148-149` 传进 `useViewport`/`useNodes`/`useMarquee`/`useEdgePan`/`useResize`，**每次渲染都会调用**。
- **规避办法（二选一）**：
  1. 第一阶段不给画布塞 `type === 'ComfyUI' && kind === 'workflow'` 的节点（保存/导入的项目里也过滤掉）；或
  2. 提前塞一个最小 stub（见 §4.2 的 `installWorkflowNodesStub`）。

### 「必须装否则直接崩」清单 = 实际为 0 项

- `installStableCanvasContextActions` 由 `canvasContextHooks.ts:34` 自我兜底，不预装也不会崩。
- `__FISHERAI_WORKFLOW_NODES__` 是**代码缺陷导致的条件性崩点**（仅当画布存在 ComfyUI workflow 节点、且其宽高被测量时触发），不是设计上的强依赖。
- 所以：**所有 window 全局不装都不会让首屏渲染崩**；不装只是逐个少功能。

---

## 3. 后端耦合点（画布渲染 / 编辑路径上的 HTTP）

> 全仓无 `EventSource` / `WebSocket`（扫描 0 命中）；无 `src` 文件 import 服务端代码（扫 `from '.../server/'` 0 命中）。

| # | 调用点（文件:行号） | 请求路径 | 触发时机 | 第一阶段不接后端会怎样 |
|---|---|---|---|---|
| 1 | `persistence/canvasWorkflow.ts:78`（`request()` 内 `fetch`） | `POST /api/workflows`（`:254`） | **保存**：Ctrl+S（`canvasCommands.ts:138-141`）、Header 保存按钮（`canvasApplication.tsx:1339`）、自动保存（`:679 onSave`）、切项目（`:1262`） | **静默失败 + 无限重试**：`canvasSaveFeedback.ts:85-88` 在 `reportFailure` 未设时 `return null` 吞掉异常 → `setDirty(false)` 永不执行 → `dirty` 恒 true → `canvasAutoSaveLifecycle.ts:141-144`（每次渲染 schedule）+ `:121`（5s interval，`canvasApplication.tsx:681`）反复再发。**不弹窗、不阻塞 UI，但持续刷失败请求**。 |
| 2 | `persistence/canvasWorkflow.ts:339-342`（`request()`） | `GET /api/workflows/{id}` 或 `GET /api/public-workflows/{id}` | **打开项目 / 刷新续接**：`sessionStorage` 有 resume 状态时 `canvasApplication.tsx:1172 loadProject(ke.workflowId)` | `:370-372 catch` → `console.error('Failed to load workflow:')` + `return null`；`canvasApplication.tsx:1179-1181` 走 `session?.clear()` → **停留在 dashboard**。不崩、不阻塞。 |
| 3 | `persistence/canvasWorkflow.ts:266`（`request()`） | `GET /api/workflows/{id}`（409 冲突后拉远端） | 保存遇到 409 | 仅在已接后端时可达，第一阶段不触发 |
| 4 | `persistence/canvasAutoSaveLifecycle.ts:121 attempt('interval')` → `onSave` | （间接）同 #1 | 每 5s（`canvasApplication.tsx:681 interval: 5e3`）+ blur/beforeunload/pagehide（`:116-119`） | 同 #1 |
| 5 | `canvas/canvasApplication.tsx:1362` | `POST /api/workflows/restore` | 用户选 `.fisherai` 备份文件（`:1355-1357`） | `:1370-1372 window.alert(error.message)` → **弹窗**「备份导入未确认…」（仅用户操作时） |
| 6 | `canvas/canvasApplication.tsx:777` `link.href = /api/workflows/{id}/backup` | `GET /api/workflows/{id}/backup` | agent 通道 `download`（`productRuntime.invoke`，`:775-780`） | 404，无 UI 反馈 |
| 7 | `canvas/canvasApplication.tsx:863` → `local/workflowNodeSession.ts requestWorkflowNodeRun` | 工作流运行接口 | agent 通道 `runWorkflow`（`:838-865`） | `throw Error('请在节点核对原任务')`，被 agent 通道捕获 |
| 8 | `nodes/canvasNodeState.ts:286` | `POST /api/verify-tos-url` | 选中带 `networkUrl` 的节点（`:283-291`） | `:303-305 catch` 静默；节点保留 `networkUrl` |
| 9 | `persistence/canvasProjectFiles.ts:68` → `persistence/projectMediaImport.ts:10` | `POST /api/assets/copy` | 导入/合并项目 JSON（本地文件） | `prepareProjectMedia` 抛错 → `canvasProjectFiles.ts:92-96` → `window.alert('打开项目 JSON 失败：…')` **弹窗** |
| 10 | `canvas/canvasWorkflowPresets.ts:237,258,270` | `GET/POST /api/library/workflows`、`/api/library/workflows/import` | 打开工作流预设面板 / 保存预设 | 面板空列表 + 保存失败（功能缺失） |
| 11 | `media/canvasMediaOperations.ts:729` | `GET /api/library` | **打开「保存到素材库」对话框**（`handleOpenCreateAsset`，非首屏） | `:739-741 catch` 静默；保留内置默认分类 |
| 12 | `media/canvasMediaOperations.ts:764` | `POST /api/library` | 点「保存素材」 | 抛出，UI 显示失败 |
| 13 | `media/canvasMediaOperations.ts:71` | `POST /api/trim-audio` | 音频裁剪（`useCanvasAudioTrim`） | 操作失败提示 |
| 14 | `media/canvasMediaTransport.ts:44,60,83` | `POST /api/assets/import/{kind}s`、`/api/assets/upload/{kind}s`、`/api/assets/{kind}s` | 粘贴 / 拖入 / 上传媒体文件 | 上传失败（`readMediaResponse` 抛错）→ 节点创建失败 |
| 15 | `canvas/canvasAssetInsertion.ts:28` | `POST /api/library/import` | 从素材库插入资产 | `report` 默认 `window.alert`（`:46`）**弹窗** |
| 16 | `appearance/canvasAppearance.ts:150` | `GET`（`BACKGROUND_ENDPOINT`，背景图） | `installCanvasAppearance()` 时 `:227 void installed.loadImage()` | `:156-158 catch` **静默**，用默认主题 |
| 17 | `profile/localUser.ts:38` | `GET /api/auth/profile` | `useLocalUser` 的 `useEffect`（`:70 adoptAccountDisplayName`） | `.catch(() => '')` → 静默，用户名回落 `'local'` / 空 |
| 18 | `persistence/preferenceStore.ts:113`（hydrate）、`:67`（PATCH） | `GET` / `PATCH /api/preferences` | **启动时（`main.ts:69` 顶层 await，阻塞渲染最多 3s）** + 每次 `preferenceStorage().setItem` | hydrate `:119-122 catch` 静默；PATCH `:92-102` 失败后 `schedule(retryDelayMs=5s)` **无限重试** |
| 19 | `generation/generationRecovery.ts:180-181` | `GET /api/generation-status/{id}?…` | `useVideoResults/useImageResults` mount 后（`:242 scan()`）+ 每 10s（`:241`） | `catch` 静默（`canvasApplication.tsx:683,685`）；**只是空转轮询**，可安全删 |
| 20 | `generation/generationClient.ts:10,68` | `POST /api/generate-{kind}`、`GET /api/generation-concurrency` | 点「生成」按钮（`handleGenerate`） | 错误进 agent 通道 / 控制台 |
| 21 | `generation/canvasLocalWorkflows.ts:230` | `__FISHERAI_VIDEO_WORKFLOWS__` → `/api/comfy/*` | MiniMax H3 T2VA 生成 | 功能不可用 |
| 22 | `settings/canvasSettings.tsx:99` | （间接）`/api/generation/sources` 等 | 打开设置面板 | 设置面板部分区块失败 |

### 结论（照抄）

- **首屏渲染路径上真正会发请求的只有 1 个**：`preferenceStore.hydrate()`（`GET /api/preferences`，会阻塞最多 3s）。
- **编辑路径上会持续发请求的是保存**（#1 / #2 / #4）：不接后端不会崩、不会弹窗，但会**每 5s 无限重试一次失败的 POST**。第一阶段**必须**把保存做成「本地成功」。
- 其余全部是**用户显式操作触发**，失败表现为静默或弹窗，不影响拖拽 / 连线 / 编组 / undo。
- 无 EventSource / WebSocket；无服务端 import。

---

## 4. 最小可渲染启动集建议

### 4.1 installer 调用顺序清单（照抄函数名）

新建 `src/client/canvas/bootstrap.ts`，**在 `createRoot(...).render()` 之前同步执行**：

```ts
// 0) 构建期常量（tsdown define）
//    __FISHERAI_BUILD__  —— main.ts:60 使用（声明见 vite-env.d.ts:4）

// 1) 主题 CSS 变量：canvas 全部样式依赖 var(--af-*)
//    ⚠️ 必须先装 preferenceStore，否则 canvasAppearance.ts:224 的 preferenceStorage()
//       会 fallback 到 detachedStorage（preferenceStore.ts:159-163）→ 主题写不进 localStorage
installPreferenceStoreLocal();       // ← 同步本地实现，替换上游 fetch 版（签名见 4.2）

// 2) 视口合成策略 + 浏览器缩放守卫 + adapter（canvasNavigation.ts:167-168 的副作用）
installStableCanvasNavigation();

// 3) 「刷新不丢」的两件套
installCanvasSession();              // persistence/canvasSession.ts
installCanvasAutoSave();             // persistence/canvasAutoSave.ts

// 4) 纯画布行为 adapter（成本为零）
installStableCanvasContextActions(); // canvas/canvasContextActions.ts
installStableCanvasClipboard();      // canvas/canvasClipboard.ts
installStableCanvasConnections();    // canvas/canvasConnections.ts
installStableCanvasEditing();        // canvas/canvasEditing.ts
installStableCanvasGroups();         // canvas/canvasGroups.ts
installStableCanvasLayout();         // canvas/canvasLayout.ts
installStableCanvasSelection();      // canvas/canvasSelection.ts
installWorkflowPresetComposition();  // canvas/workflowPresetComposition.ts

// 5) 主题（依赖第 1 步；背景图 404 会静默降级）
installCanvasAppearance();

// 6) 顺手（可省）
installMediaNodeSizing();            // media/mediaNodeSizing.ts
installStableDesignSystem().observe(); // design/designSystem.ts

// 7) 画布核心 global 兜底（防 canvasNodeRules.ts:172 / :182 的 `.width` 崩）
installWorkflowNodesStub();          // 见 4.2

// 8) 渲染（不要用 #root；自己建一个 class="af-canvas-mount" 的容器）
createRoot(canvasRootEl).render(
  <StrictMode><CanvasRoot /></StrictMode>,
);
```

**不要调用**（第一阶段）：
`installWorkflowRecoveryFetch`、`installDramaCanvasBridge`、`installBackendReconnectNotice`、`installDesktopUpdateSurface`、
`createSourceSettingsClient`、`installAgentModelAvailability`、`installRelayAccountCenter`、`installFeedbackCenter`、
`installAgentClient`、`installAgentSkillClient`、`installSkillCommunity`、`installImageModeAdapter`、
`installMidjourneyReferenceAdapter`、`installVideoModeAdapter`、`installImageResultHistory`、`installGenerationScheduler`、
`installGenerationRecovery`、`installModelPricing`、`installLocalRuntimeClient`、`createWorkflowManagerClient`、
`installWorkflowCanvasNodes`、`createAgentConversation`、`installDramaConversationShortcut`、`installDramaConversationTools`、
`installWorkflowManager`、`installComfyLogPanel`、`installMiniMaxH3CanvasAdapter`、`installMiniMaxPromptScroll`、
`installVideoWorkflows`、`installPromptAssistant`、`installPromptExpand`、`installPromptPresets`、
`installStoryboardClient`、`installMediaEditing`、`installMediaDownloadFileName`、`installStableVideoPlayback`、
`installNodeFramework`、`installLocalProfile`、`startStableMediaEnhancement`、`installProjectDashboardChrome`。

### 4.2 需要额外写的 stub

| stub | 对应上游 | 签名 | 返回什么 / 关键实现 |
|---|---|---|---|
| `installPreferenceStoreLocal()` | `installPreferenceStore(fetchImpl)`，`persistence/preferenceStore.ts:166` | `(): PreferenceStorage`（**同步**，不是 Promise） | `PreferenceStorage = Pick<Storage,'getItem'\|'setItem'\|'removeItem'>`（`preferenceStore.ts:6`）。直接包一层 `localStorage` + 内存 Map，**不发请求、不 await**。注意 `preferenceStorage()`（`:185`）在未安装时回落到 `localStorage`（`:188`）或 `detachedStorage`（`:159-163`）。最省事的做法是**直接改 vendored `preferenceStore.ts`**：把 `hydrate()` 与 `patch()`（`:65-134`）改成 no-op / 本地写。 |
| `installWorkflowNodesStub()` | `installWorkflowCanvasNodes`，`local/workflowCanvasNodes.ts:2080` | `(): void` | 设 `window.__FISHERAI_WORKFLOW_NODES__`；最少只需 `getNodeSize: () => ({ width: 520, height: 520 })` 即可消除 `canvasNodeRules.ts:172/182` 崩点。完整最小面：`getNodeSize`、`getInputPortY`、`getOutputPortY`、`getOutputMediaKind`、`canConnect`、`resolveAvailableInputSlot`、`getInputCapacity`、`getInputSlots`、`captureExample`、`instantiateExample`、`instantiateVerifiedRun`、`updateNode`。 |
| `useWorkflow` 实现（由 deps 提供，非 installer） | `useCanvasWorkflow`，`persistence/canvasWorkflow.ts:91` | 返回 `{ workflowId, workflowRevision, isWorkflowPanelOpen, workflowPanelY, handleWorkflowsClick, handleSaveWorkflow, handleLoadWorkflow, closeWorkflowPanel, resetWorkflowId, getWorkflowEpoch, useSaveFeedback, importDocument, useProjectFiles }`（对照 `canvasWorkflow.ts:420-434` 与 `canvasApplication.tsx:262-274` 的解构） | **必须真实现**。最省事：保留 vendored `useCanvasWorkflow`，只把 `request()`（`canvasWorkflow.ts:77-88`）换成写 localStorage / 插件存储并返回 `{ id, revision: n+1, success: true }`。这样 `canvasApplication.tsx` 一行都不用改，`getWorkflowEpoch` / `handleLoadWorkflow` / `importDocument` 等语义全部保留。 |
| `__FISHERAI_BUILD__` | `main.ts:60` | 构建常量（string） | 在 tsdown/esbuild `define` 里给固定串（如 `'v0.0.0-canvas'`）。`vite-env.d.ts:4` 的 `declare const` 可一并 vendor。 |
| `verify-tos-url`（可选） | `nodes/canvasNodeState.ts:286` | n/a | 无需 stub。若要彻底干净，把 `:283-307` 那段 effect 删掉（它只负责清 `networkUrl`）。 |
| CSS 外壳中立化（已就绪） | `vendor-aifisher.mjs:146-155` | n/a | 脚本已把 `html,body,#root{...}` 换成 `.af-canvas-mount{...}`。**挂载容器必须有 `class="af-canvas-mount"` 和确定尺寸**，否则 `canvasApplication.tsx:1328` 的 `w-screen h-screen` 会溢出 DSH 面板。 |
| 挂载点 | `app/main.tsx:9` `getElementById('root')` | n/a | **不要照抄 `main.tsx`**；自己在 DSH panel 里建容器并调 `CanvasRoot`。 |

### 4.3 画布首屏渲染路径调用链（标出后端请求 / window 全局节点）

```
index.html / DSH slot: main[key=aifisher-canvas]
└─ src/client/CanvasPanel.tsx
   └─ [我们自己的 bootstrap]            ← §4.1 的 installer 在此完成
      └─ createRoot(canvasRootEl).render(<StrictMode><CanvasRoot/></StrictMode>)
         └─ app/canvasRuntime.tsx:168 CanvasRoot()
            └─ app/canvasRuntime.tsx:169 CanvasApplication(React, dependencies)
               │  ★ dependencies（:56-166）在模块加载时构造，会 import：
               │     · ../../config/modelConfig（:8）                ← 需 vendor
               │     · ../profile/localUser（:7）
               │     · ../profile/canvasAvatar（:6）
               │     · ../persistence/canvasWorkflow（:17）
               │     · ../persistence/canvasAutoSaveLifecycle（:18）
               │     · ../agent/*（:13-27 的 canvasControl 系列）    ← 需裁剪 / stub
               └─ canvas/canvasApplication.tsx:34 CanvasApplication
                  ├─ :81   读 window.__FISHERAI_CANVAS_SESSION__          [全局]
                  ├─ :149  usePanels()                                    纯状态
                  ├─ :161  useTitle()                                     纯状态
                  ├─ :163  useViewport() → canvasViewport.ts:131          [全局]（可选链+兜底）
                  ├─ :182  useNodes()   → canvasNodeState.ts              ← mount 时 :273-280 装 3 个 window 事件监听（无网络）
                  ├─ :206  useConnections()                               纯状态
                  ├─ :217  useDrag()  :224 useResize()  :232 useMarquee() 纯状态
                  ├─ :243  useCanvasEdgePan（经 deps.useEdgePan，见 §5 备注）
                  ├─ :260  useHistory()                                   纯状态
                  ├─ :274  useWorkflow() → canvasWorkflow.ts              [HTTP] 若 session 有 resume → :339 GET /api/workflows/{id}
                  ├─ :296  读 window.__FISHERAI_DRAMA_BRIDGE__             [全局]（可选链）
                  ├─ :319  useCanvasDeferredFrame   :320 useCanvasSurfaceSize（app/canvasApplicationEvents.ts）
                  ├─ :327  useLocalUser() → profile/localUser.ts:70        [HTTP] GET /api/auth/profile（catch 静默）
                  ├─ :515  useGeneration()   → generation/canvasGeneration.ts:347   mount 建 controller（无请求）
                  ├─ :522  useSnapshots()    → media/canvasMediaOperations.ts:662   mount 建 controller（无请求）
                  ├─ :530  useAudioTrim()    同上
                  ├─ :539  useCanvasImageUpscale（media/canvasImageUpscale.ts）
                  ├─ :591  useTextActions()  → canvas/canvasTextActions.ts
                  ├─ :600  useLocalWorkflows() → generation/canvasLocalWorkflows.ts
                  ├─ :618  useAssets()       → canvasMediaOperations.ts:700
                  │        mount 时 :706 的 useEffect 只重置 UI 状态，**不发请求**（请求在 :729 打开对话框时）
                  ├─ :638  usePresets()      → canvas/canvasWorkflowPresets.ts（请求在打开面板时 :237/:258）
                  ├─ :649  useCommands()     → canvas/canvasCommands.ts（键盘 + 剪贴板）
                  ├─ :672  useAutoSave()     → canvasAutoSaveLifecycle.ts:67 installCanvasAutoSave().createController()
                  │                            :116-121 window blur/beforeunload/pagehide/pageshow + :121 5s interval
                  │                            [HTTP] 一旦 dirty → :679 onSave → canvasSaveFeedback → POST /api/workflows
                  ├─ :683  useVideoResults()  :685 useImageResults() → app/useRecovery.ts → generation/generationRecovery.ts
                  │                            [HTTP] mount 即 :242 scan() + :241 setInterval(10s) → GET /api/generation-status/*
                  ├─ :703  useContextMenu()  → canvasContextHooks.ts:34 直接调用 installStableCanvasContextActions()
                  ├─ :742  useCanvasAssetInsertion（canvas/canvasAssetInsertion.ts）
                  ├─ :731  media.useCanvasCollage  :989/:999/:1009/:1019 media.useCanvas*Save
                  ├─ :1105-1114 createCanvasSceneProjector + canvasVisibleScene（canvas/canvasSceneData.ts）纯计算
                  ├─ :1152 写 window.__FISHERAI_FOCUS_NODES__
                  ├─ :1167-1190 session.load() → 有 resume 时 :1172 loadProject()   [HTTP] GET /api/workflows/{id}
                  ├─ :1191-1199 session.save()  ← 纯本地，无网络
                  ├─ :1301-1320 view==='dashboard' → <Projects> + <Settings>
                  └─ :1325 主渲染 createElement('div', { className: 'w-screen h-screen …' })
                     ├─ :1330 <Header>    dialogs/canvasHeader.tsx             纯展示
                     ├─ :1384 <Sidebar>   dialogs/canvasSidebar.tsx            纯展示
                     ├─ :1405 <Scene>     canvas/canvasScene.tsx
                     │     └─ components.Scene = Dialogs.CanvasScene（dialogs/canvasDialogs.ts:127）
                     │        └─ app/canvasComponents.ts:75-77 bind，依赖 { Edges, Selection, Node }
                     │           · Edges     → canvas/canvasEdges.tsx
                     │           · Selection → dialogs/canvasSelectionBounds.tsx
                     │           · Node      → nodes/canvasNodeFrame.tsx → CanvasNode
                     │               └─ 按 type 分派 Text/Image/Video/Audio/…（canvasComponents.ts:159-174）
                     │                  ★ canvasNodeRules.ts:163/178 nodeWidth/nodeHeight 被反复调用
                     │                    [崩点] ComfyUI workflow 节点会触发 §2 的 `.width` 崩点
                     ├─ :1539 <Controls>  dialogs/canvasViewportControls.tsx（Minimap）
                     ├─ :1562 <SidePanels> dialogs/canvasSidePanels.tsx
                     │     └─ History/Assets/Presets/AgentLauncher/Agent（canvasComponents.ts:81-89）
                     │        [HTTP] Assets 打开时 GET /api/library；Agent 面板依赖 agent 通道（第一阶段可空）
                     ├─ :1623 <Overlays>  dialogs/canvasDialogs.ts:32 CanvasOverlays
                     │     [HTTP] AssetDialog 保存时 POST /api/library（canvasMediaOperations.ts:764）
                     ├─ :1661 <Settings>  settings/canvasSettings.tsx
                     │     它 import 了 generation/sourceSettings、local/localRuntimeSettings、
                     │     media/mediaDownloadSettings、update/localUpdateSettings（:6-14）→ 第一阶段建议传 () => null
                     └─ :1670+ 条件渲染 Annotation（:1671）/ Crop（:1679）/ Resize（:1719）
```

**路径上的关键节点小结**

- **会发 HTTP 的节点**：`:274`（条件性 GET 项目）、`:327`（GET 账号名，静默）、`:672+`（保存 POST，反复）、`:683/:685`（生成恢复轮询，10s）、`:1167`（条件性 GET 项目），以及用户操作触发的资产/素材/编辑请求。
- **会读 `window.__FISHERAI_*` 的节点**：`canvasApplication.tsx:81 / :296 / :878 / :902 / :958 / :1152(写) / :1457 / :1478`，加上 `canvasViewport.ts:131`、`canvasCommands.ts:89`、`canvasContextHooks.ts:34`、`canvasNodeRules.ts:172/182/209/210/215/224/310`、`canvasNodeOperations.ts:240`、`canvasNodeState.ts:60/69/118/130`、`media/canvasImagePreview.tsx:124`、`media/useCanvasVideoPlayback.ts:30/33/104`、`text/CanvasTextNodeContent.tsx:45/79`、`nodes/mediaComposer.ts:107/116`、`nodes/canvasTextComposer.tsx:93`。
  **除 §2 警告那一处外，全部可选链兜底。**

---

## 5. `CanvasApplication(React, deps)` 的 deps 逐项分类

行号均指 `canvas/canvasApplication.tsx`（除特别标注）。

### 5.1 可以直接传空实现 / 桩

| dep | 使用位置 | 空实现返回 | 后果 |
|---|---|---|---|
| `useGeneration` | `:515` 解构 `{ handleGenerate }`；`:394`、`:1529` | `() => ({ handleGenerate: () => undefined })` | 点「生成」无反应（**不能返回 `undefined`，否则 `:515` 解构报错**） |
| `useSnapshots` | `:522` 解构 `{ handleVideoSnapshot, handleVideoFirstLastSnapshot }` → `:1520-1521` | `() => ({ handleVideoSnapshot: () => {}, handleVideoFirstLastSnapshot: () => {} })` | 视频截图按钮无效 |
| `useAudioTrim` | `:530` 解构 `{ handleAudioTrim }` → `:1522` | `() => ({ handleAudioTrim: () => {} })` | 音频裁剪无效 |
| `useTextActions` | `:591` 解构 `{ handleWriteContent, handleTextToVideo, handleTextToImage }` → `:1516-1518` | `() => ({ handleWriteContent: () => {}, handleTextToVideo: () => {}, handleTextToImage: () => {} })` | 文本→图/视频无效 |
| `useLocalWorkflows` | `:600` 解构 `{ handleMiniMaxH3T2VAGenerate }` → `:1519` | `() => ({ handleMiniMaxH3T2VAGenerate: () => {} })` | MiniMax 生成无效 |
| `usePresets` | `:638` 解构 8 个字段；`:634` → `:1639`；`:636` → `:1659`；`:637` → `:1582` | `() => ({ isCreateWorkflowPresetModalOpen: false, setIsCreateWorkflowPresetModalOpen: () => {}, workflowPresetCoverUrl: undefined, workflowPresetCategories: [], workflowPresetDefaultName: '', canCreateWorkflowPreset: () => false, handleOpenCreateWorkflowPreset: () => {}, handleSaveWorkflowPreset: async () => {}, handleImportWorkflowPreset: () => {} })` | 预设面板空、保存无效 |
| `useVideoResults` | `:683` | `() => {}` | 视频首尾帧恢复不做（**同时消掉 10s 轮询**） |
| `useImageResults` | `:685` | `() => {}` | 图片结果恢复不做 |
| `useAutoSave` | `:672` | `() => {}` | 自动保存停用（需另外接保存） |
| `useLocalUser` | `:327` 解构 `{ id, no, name, setName }`；`:328-331` 算 `userColor` | `() => ({ id: 'local', no: '1', name: '本地用户', setName: () => {} })` | 侧栏头像显示兜底 |
| `userColorForId` | `:329`（`React.useMemo` 内） | `() => '#60a5fa'` | 头像色固定 |
| `NodeStatus` | `:503`、`:505`、`:513`、`:680`、`:1205`、`:1207`、`:1221`、`:1226` | **不能给空对象**，给 `{ LOADING: 'loading', SUCCESS: 'success' }` | 给空对象 → 判断恒 false，dirty/生成计数逻辑失效（不崩） |
| `NodeType` | `:1252`、`:1258` | `{ VIDEO: 'Video', UPLOAD_VIDEO: 'Upload Video' }`（给空也不崩） | 封面选择逻辑变化 |
| `media` | `:731 useCanvasCollage`、`:989 useCanvasImageEditSave`、`:999 useCanvasCropSave`、`:1009 useCanvasImageEditSave`、`:1019 useCanvasCompositeSave` | 这 5 个**必须存在**：`{ useCanvasCollage: () => ({}), useCanvasImageEditSave: () => (async () => {}), useCanvasCropSave: () => (async () => {}), useCanvasCompositeSave: () => (async () => {}) }` | 拼图 / 标注保存 / 裁剪保存 / 尺寸保存 / 合成保存无效 |
| `useEdgePan` | `:45` 解构；**函数体内从未被调用**（`:243` 用的是 import 的 `useCanvasEdgePan`，由 `canvasRuntime.tsx:99-101` 绑到该字段） | `() => ({})` | 零副作用 |
| `Projects` | `:1304`（仅 `view==='dashboard'`） | `() => null` | dashboard 空白（见 §6 红线 10） |
| `Settings` | `:1310`（dashboard）+ `:1661`（canvas） | `() => null` | 设置面板空（同时避免连带 localRuntime/mediaDownload 等裁剪依赖） |
| `Annotation` | `:1671`（条件：`annotatingNodeId`） | `() => null` | 点「标注」无反应 |
| `Crop` | `:1679`（条件：`cropNodeId`） | `() => null` | 点「裁剪」无反应（**同时免掉 three/@react-three 依赖**） |
| `Resize` | `:1719`（条件：`resizeNodeId`） | `() => null` | 点「尺寸」无反应 |

### 5.2 必须真实现才能渲染出画面

| dep | 使用位置 | 为什么必须 |
|---|---|---|
| `usePanels` | `:149` | 解构 30+ 字段；`isChatOpen`(`:1344`)、`annotatingNodeId`(`:1670`)、`cropNodeId`(`:1678`)、`resizeNodeId`(`:1718`) 直接决定渲染分支。用 `dialogs/canvasPanels.ts:34 useCanvasPanels` |
| `useTitle` | `:161` | `canvasTitle`/`editingTitleValue`；`setCanvasTitle` 被 workflow 依赖 |
| `useViewport` | `:163` | 返回 `viewport` + `canvasRef`；`:1329` 起所有 pointer 事件都靠它。必须用 `canvas/canvasViewport.ts` 的 `useCanvasViewport`，并把 `canvasRef` 绑到 `Scene` |
| `useNodes` | `:182` | **节点 store 本身**。必须 `nodes/canvasNodeState.ts useCanvasNodes` + `canvasNodeOperations` + `canvasNodeRules`（`canvasRuntime.tsx:65-77`） |
| `useConnections` | `:206` | 连线拖拽状态机。必须 `canvas/canvasConnectionHooks.ts useCanvasConnections` |
| `useDrag` | `:217` | `handleNodePointerDown/updateNodeDrag/endNodeDrag` → `:1456-1471`、`:887-911`。拖拽必需 |
| `useResize` | `:224` | 节点缩放 + 选区缩放（`:1506-1510`） |
| `useMarquee` | `:232` | 框选：`selectionBox`(`:1726`)、`endSelection`(`:944`) |
| `useGroups` | `:242` | 编组：`groupNodes`(`:1445`)、`ungroupNodes`(`:1446`)、`cleanupInvalidGroups`(`:1265`)、`renameGroup`(`:1447`) |
| `useHistory` | `:260` | undo/redo：`:341-349 restoreHistory`、`:1632-1633` 传进 Overlays |
| `useWorkflow` | `:274` | 解构 11 个字段；`getWorkflowEpoch`（`:297,:320,:353,:427,:434,:441,:452,:744,:796,:840,:1050,:1340,:1407,:1543,:1564,:1597`）遍布全文件；`handleSaveWorkflow` 是自动保存的落点；`handleLoadWorkflow`(`:498`)。**必须真实现（改造版，见 §4.2）** |
| `useCommands` | `:649` | 键盘（Ctrl+Z/Y/S/C/G、Delete、Esc）+ 剪贴板 `handleCopy/handlePaste/hasCopiedNodes`(`:690`)。**编辑体验必需** |
| `useContextMenu` | `:703` | 双击/右键菜单；`handleAddNext`(`:950`) 是连线完成后的入口 |
| `useAssets` | `:618` | `handleContextUpload`(`:805,:1631`)、`handleClipboardImagePaste`(`:692,:1100`)、`handleReplaceMedia`(`:730,:804`)、`handleOpenCreateAsset`(`:711,:815,:1532`)、`nodeToSnapshot`/`assetCategories`(`:1650-1651`)。**拖入/粘贴媒体与「保存资产」必需** |
| `getNodeWidth` | `:65`，用于 `:368,:739,:904,:920,:997,:1006,:1017,:1026,:1106-1107,:1417,:1688,:1702` | 视口聚焦、对齐辅助线、拖拽网格、场景投影都靠它。用 `nodes/canvasNodeRules.ts:163 nodeWidth` |
| `getNodeHeight` | `:66`，用于 `:368,:740,:904,:921,:1007,:1106-1107,:1417` | 用 `canvasNodeRules.ts:178 nodeHeight` |
| `createId` | `:67`，用于 `:1074` | `() => crypto.randomUUID()` |
| `textForNode` | `:68`，用于 `:1106-1107`（`createCanvasSceneProjector`） | `(node) => node.type === 'Text' && typeof node.textContent === 'string' ? node.textContent : ''`（`canvasRuntime.tsx:151-154`） |
| `Header` | `:1330` | 顶部标题栏 + 保存按钮（`:1339 onSave`）。空实现 → 无保存入口 |
| `Sidebar` | `:1384` | 左侧工具条（加节点/工作流/资产/历史/设置） |
| `Scene` | `:1405` | **画布本体** |
| `Controls` | `:1539` | 缩放控件 + 小地图；`zoomControlsRef`(`:1134`) 被 ResizeObserver 依赖 |
| `SidePanels` | `:1562` | 历史/资产/预设/agent 面板 |
| `Overlays` | `:1623` | 右键菜单 + 预览 + 保存对话框；`:1626 onCloseContextMenu`、`:1632-1633 onUndo/onRedo` |

### 5.3 最小 deps 清单（照抄）

```ts
const deps: Dependencies = {
  // —— 真实现（18 个）——
  usePanels, useTitle, useViewport, useNodes, useConnections,
  useDrag, useResize, useMarquee, useGroups, useHistory,
  useWorkflow, useCommands, useContextMenu, useAssets,
  getNodeWidth, getNodeHeight, createId, textForNode,

  // —— 真组件（6 个必需 + 5 个按需）——
  Header, Sidebar, Scene, Controls, SidePanels, Overlays,
  Annotation: () => null, Crop: () => null, Resize: () => null,   // 按需
  Projects: () => null, Settings: () => null,                      // 按需

  // —— 空实现（桩）——
  useGeneration: () => ({ handleGenerate: () => undefined }),
  useSnapshots: () => ({ handleVideoSnapshot: () => {}, handleVideoFirstLastSnapshot: () => {} }),
  useAudioTrim: () => ({ handleAudioTrim: () => {} }),
  useTextActions: () => ({ handleWriteContent: () => {}, handleTextToVideo: () => {}, handleTextToImage: () => {} }),
  useLocalWorkflows: () => ({ handleMiniMaxH3T2VAGenerate: () => {} }),
  usePresets: () => ({
    isCreateWorkflowPresetModalOpen: false, setIsCreateWorkflowPresetModalOpen: () => {},
    workflowPresetCoverUrl: undefined, workflowPresetCategories: [],
    workflowPresetDefaultName: '', canCreateWorkflowPreset: () => false,
    handleOpenCreateWorkflowPreset: () => {}, handleSaveWorkflowPreset: async () => {},
    handleImportWorkflowPreset: () => {},
  }),
  useVideoResults: () => {}, useImageResults: () => {}, useAutoSave: () => {},
  useLocalUser: () => ({ id: 'local', no: '1', name: '本地用户', setName: () => {} }),
  userColorForId: () => '#60a5fa',
  NodeStatus: { LOADING: 'loading', SUCCESS: 'success' },
  NodeType: { IMAGE: 'Image', VIDEO: 'Video', AUDIO: 'Audio', TEXT: 'Text',
              UPLOAD_IMAGE: 'Upload Image', UPLOAD_VIDEO: 'Upload Video', UPLOAD_AUDIO: 'Upload Audio' },
  media: {
    useCanvasCollage: () => ({}),
    useCanvasImageEditSave: () => (async () => {}),
    useCanvasCropSave: () => (async () => {}),
    useCanvasCompositeSave: () => (async () => {}),
  },
  useEdgePan: () => ({}),
};
```

---

## 6. 施工红线 / 易踩坑

1. **不要 vendor `src/stable/main.ts` 并直接 import** —— 它含顶层 `await` + 40+ 个后端 installer。我们自己的 bootstrap 才是入口；`main.ts` 只当「哪些该保留」的参考。
2. **必须 `define __FISHERAI_BUILD__`**（`main.ts:60`，声明 `vite-env.d.ts:4`）。
3. **preferenceStore 必须同步 + 本地**，否则 (a) 阻塞首屏最多 3s（`preferenceStore.ts:116`），(b) `canvasAppearance.ts:224` 拿到 `detachedStorage`，主题偏好写不进磁盘（`preferenceStore.ts:159-163`）。
4. **保存必须本地化**：改 `canvasWorkflow.ts:77-88` 的 `request()`，或整体替换 `useWorkflow`；否则每 5s 一次失败 POST（`canvasApplication.tsx:681` + `canvasAutoSaveLifecycle.ts:121`）。
5. **一定要 stub `useVideoResults` / `useImageResults`**，否则 `generationRecovery.ts:241` 每 10s 空轮询 `/api/generation-status/*`。
6. **ComfyUI workflow 节点宽高崩点**（`canvasNodeRules.ts:172` / `:182`）—— 要么过滤掉这类节点，要么装 §4.2 的 stub。
7. **依赖补齐**：`app/canvasComponents.ts:2` 用 `@tiptap/react`（当前 `package.json` 已有 tiptap 全套）；`:5-7` 用 `@react-three/fiber`、`@react-three/drei`、`three`（**当前 devDependencies 里没有**）；`:25` 用 `../../../package.json`。要么补依赖，要么把 `Crop` 传 `() => null` 并去掉 `canvasComponents.ts` 里的 3D import。
8. **挂载容器必须 `class="af-canvas-mount"` 且有确定尺寸**（`vendor-aifisher.mjs:147-155` + `canvasApplication.tsx:1328` 的 `w-screen h-screen`）。
9. `settings/canvasSettings.tsx` 是 `canvasComponents.ts:47` 的 `Settings` 绑定目标，它 import 了 `generation/sourceSettings`、`local/localRuntimeSettings`、`media/mediaDownloadSettings`、`update/localUpdateSettings`（`:6-14`）→ 第一阶段传 `Settings: () => null` 最省事。
10. **画布初始视图硬编码为 `dashboard`**（`canvasApplication.tsx:84` `React.useState('dashboard')`）→ 若 `Projects: () => null`，用户会看到空白。**建议**：在 bootstrap 里预先向 `sessionStorage` 写入一条 `fisherai.canvas.resume.v1`（`canvasSession.ts:3`），或干脆把 `view` 初始值改成 `'canvas'`。
11. `useEdgePan` 这个 deps 字段在 `CanvasApplication` 内**从未被调用** —— 不必为它写实现（`() => ({})` 即可）。
12. `canvasNodeState.ts:283-307` 的 `/api/verify-tos-url` effect 是唯一「选中节点即发请求」的编辑路径请求，可整段删除。
