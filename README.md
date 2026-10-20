# 🎨 dsh-aifisher-canvas

> 把专业级 AI 创作无限画布带进 DeepSeek Harness：**不是插件内置一个聊天框，而是让 DSH 原生 AI Agent 直接接管整个画布**——本地 ComfyUI、多云端生成、节点编排、素材整理，全靠你在右侧说一句话完成。

**Version**: v1.61 | **Node**: ≥22.19 | **React**: 19 | **TypeScript**: 5.8 | **License**: AIFISHER Noncommercial

---

## 📸 界面

![无限画布总览](docs/shots/readme-node.png)

<sub>左边是 DSH，中间是无限画布（节点 + 生成结果 + 任务队列），右边就是那个能动手改画布的 DSH 原生 Agent。</sub>

![Agent 正在操作画布](docs/shots/readme-agent.png)

<sub>右侧对话区随手问一句「画布上现在有什么」，Agent 自己读回节点、连线、类型、坐标和生成参数——它看得到你画布上的一切。</sub>

| 项目库 | 选中节点 · 参数面板 |
|---|---|
| ![项目库](docs/shots/readme-projects.png) | ![节点参数面板](docs/shots/readme-node-panel.png) |

<sub>大图见 [`docs/shots/`](docs/shots/)。</sub>

---

## ✨ 核心亮点：DSH Agent 原生接管画布

这不是在插件里套了一个写死提示词的"生图对话框"——你右侧的聊天栏就是完整的 DSH 原生 Agent（模型走 DSH 配置，可接入任意兼容的大模型 API：Base URL + Key）：

- 🎯 **直接操作画布对象**：Agent 能看到画布上所有节点、连线、素材，通过 `canvas_control` 工具直接放节点、连参数、调位置、批量整理素材，不需要你手动拖拽
- 🗣️ **自然语言搭工作流**：你只需要说"帮我在画布中间放一个文生图节点，接上我常用的 SDXL 大模型，提示词写一只在雨夜路灯下的三花猫，生成4张"，Agent 会自动完成节点创建、参数填充、连线，并把生成确认卡片递到你面前——最后那一键（费用授权）始终由你自己按
- 🧩 **完整技能生态打通**：Agent 不只能调用画布内置能力——它能读取你项目级、用户级安装的所有 DSH 技能，查文档、写脚本、处理素材后直接把结果放回画布
- 🛠️ **对话式功能开发**：不只是操作已有节点——你可以直接让它写自定义 ComfyUI 工作流、写素材处理脚本、配置并暴露新的画布节点、调整通道参数，写完即挂到画布上跑，不需要你手写 JSON 或改代码
- 🖼️ **素材自动回流**：Agent 跑脚本处理完图片、下载完素材、生成完结果，会自动放到画布你指定的位置，连参数引用、连线都帮你接好
- 🔍 **上下文全感知**：Agent 知道你当前画布上有什么项目、你上次用的是哪个模型、你之前生成过什么图，不需要反复跟它交代背景
- 📎 **@ 画布节点当上下文**：在输入框敲 `@` 直接选画布上的文本 / 图像 / 视频 / 音频节点，发送时自动把该节点的只读快照（标题、正文、结果地址）带在消息后面——指着某个节点说「把这张图改成…」就行，不用先让 Agent 自己 read 一轮
- 🔔 **生成事件推回面板**：Agent 准备的批次跑完后，宿主会把结果（成功/失败、错误码、节点 id）**推回这条对话**——Agent 接着就能看图自评、修失败、重新准备，你不用再问一句「生成完了吗」；费用确认仍然只在画布上按
- 🧠 **项目记忆**：画风、角色设定、常用模型/参数记进项目记忆后，新开一个对话会自动带上（同一份内容只注入一次），不用每次重新交代
- 🎭 **视觉一致性**：把角色定妆 / 画风参考节点设为「锚点」，一次 `lock` 就接到所有镜头上（锚点即上游参考图），跨镜头锁脸锁服装；副驾会提示还剩几个镜头没锁
- 🎬 **长任务编排**：一句话提交「做完这组镜头」——host 端按既定流水线建节点、锁参考、准备批次，然后等你在确认卡上按一次；某个镜头失败会**自动再准备一批重试**（仍然要你确认，不自动花钱）
- 🗂️ **分镜板**：画布底部一条缩略图带，按镜头号排好、点一张聚焦过去、按播放自动翻页——只看顺序，不塞完整导演台
- 🧭 **主动副驾**：发现失败节点、空提示词、没锁的镜头时，在左下角安静冒一个小胶囊，点开才看建议；没有建议时不出现，点「不再提示」彻底关掉

> 传统 AI 画布是"你手动摆节点 + 点按钮生成单张图"，这个插件是"你跟 AI 说你要做什么，AI 自己在无限画布上帮你搭整个创作流水线"。

---

## 🗺️ 其他核心能力

### 本地 ComfyUI 深度集成
- 自动扫描本机 ComfyUI 节点、模型、LoRA 列表，下拉选模型不用手动敲文件名
- 支持导入你自己在 ComfyUI 里 `Export(API)` 的自定义工作流，勾选要暴露的参数后一键变成画布节点
- 导入后在「ComfyUI 工作流配置」里看**可视化节点图**：逐节点挑模型 / LoRA / 参数，改完写回工作流
- 提交前自动校验节点和模型是否存在，缺哪个节点/模型直接告诉你本机相近候选是什么
- 节点上模型名和你本机文件名差量化后缀时自动对账，不用手动改

### 多云端生成通道
| 通道 | 支持能力 |
|---|---|
| 火山方舟直连 | 生图/生视频，模型自动同步 |
| OpenAI 兼容接口 | 任意符合 OpenAI schema 的生图端点都能接 |
| 魔搭 ModelScope | 一键预设，支持参考图数组传入 |
| FisherAI | 异步任务轮询，自动上传参考图公网直链 |

- 新建节点自动沿用上一次你选过的模型，不用每次重新下拉
- 多通道多模型并行管理，任务队列里统一看进度、取消、清空

### 无限画布原生体验
- 节点连线、编组、框选复制粘贴、历史回退全套基础能力完整保留
- **Blender 式切刀**：按住 `Ctrl` + 鼠标右键拖拽，划过的连线当场变红、松手即断开（`Esc` 取消，只断划过的那条）
- 多选图片自动折叠成叠图，不展开也能在卡片上翻页查看
- 两步式智能扩图：先自动生成外延参考画面，再生成你自己的扩图节点，提示词参考图自动填好，生成由你自己触发
- 内置图片裁剪、宫格切分、标注蒙版、尺寸调整工具，不用跳出去用其他软件

### 项目迁移与数据自主
- 一键导出 `.fisherai` 项目归档包，换机导入直接恢复整个画布
- **项目数据目录**可以自定义到任意磁盘，C 盘不够用直接搬走，不污染系统盘
- 所有素材、工作流、配置本地存储，不上传到第三方服务器

---

## 🚀 安装

### 0. 环境要求
- **Node.js** ≥ 22.19 + **pnpm**
- **DeepSeek Harness** ≥ 0.1.0-rc.7（桌面版 / Web 版都行）
- 要跑**本地生成**才需要 [ComfyUI](https://github.com/comfyanonymous/ComfyUI)（默认地址 `http://127.0.0.1:8188`）；只用云端通道不需要

### 1. 准备上游 AIFISHER 源码
构建链的第一步 `pnpm vendor` 每次都会从一份**完整的上游 AIFISHER 源码树**重新复制到 `vendor/aifisher/`，再逐条打补丁（每条补丁都带「命中 N 次」断言）——仓库里 `vendor/aifisher/` 现存的内容是上一次构建的产物，**不是这一步的输入**。上游源码按其原版权方的许可证分发，请自行获取（版权方 Work-Fisher）。

默认按候选顺序自动探测，最省事是把它放在与本仓库同级的 `AIFISHER-main/`；也可以显式指定：

```powershell
# PowerShell
$env:AIFISHER_SRC = 'D:\path\to\AIFISHER-main'
```

```bash
# bash
export AIFISHER_SRC=/path/to/AIFISHER-main
```

> 报 `[vendor] 找不到 AIFISHER 源码` 就是这一步目录没找对。

### 2. 构建
```bash
git clone <本仓库> dsh-aifisher-canvas
cd dsh-aifisher-canvas
pnpm install
pnpm build
```

`pnpm build` = `clean → vendor-aifisher → build-canvas-css → tsdown`，**顺序不可变**。产物三件，DSH 加载的就是它们：

- `lib/index.js` — host 半（路由、ComfyUI、生成、媒体库、诊断）
- `lib/client/apply.js` — 浏览器半（panel / slot 注册）
- `lib/canvas/canvas-app.js` — 画布应用本体

### 3. 装进 DSH
1. 打开 DSH → **设置 → 插件 →「添加插件」**。
2. 填**插件目录的绝对路径**（就是第 2 步构建出 `lib/` 的那个目录），点安装。
   DSH 会把这个目录 link 进当前 profile，并把 `dsh-aifisher-canvas` 追加进 profile 的 `dsh.profile.bundles`，默认启用。
3. **重启 DSH**。host 半是进程内加载的，只刷新页面不会更新它。

不想用界面时，手工等价做法是改 `$DSH_HOME/profiles/<profile>/package.json`，然后在 profile 目录跑 `pnpm install`、重启 DSH：

```jsonc
{
  "dependencies": { "dsh-aifisher-canvas": "link:D:/path/to/dsh-aifisher-canvas" },
  "dsh": { "profile": { "bundles": [ /* …原有组合包… */, "dsh-aifisher-canvas" ] } }
}
```

### 4. 验证
侧边栏出现 **「无限画布」** → 打开 → 新建项目。要用本地生成的话，画布左上角 ComfyUI 胶囊应变绿；云端通道在 **设置 → 闭源服务** 里配。具体上手见 [`使用说明.md`](使用说明.md)。

### 5. 更新与卸载
- **更新**：改完源码重新 `pnpm build` → 重启 DSH。DSH 不自动更新插件，换版本要在插件页重装。
- **卸载**：设置 → 插件里移除（DSH 会先把组合包摘出 `dsh.profile.bundles`，再执行 `pnpm remove`）。画布数据留在 `$DSH_HOME/storages/dsh-aifisher-canvas/`，不会被删。

### 安装常见报错
| 现象 | 原因 / 处理 |
|---|---|
| `[vendor] 找不到 AIFISHER 源码` | 上游源码没准备或路径不对 → 见第 1 步 |
| 构建报「找不到模块 tsdown / jsdom」 | 盘符变过，`node_modules` 里 junction 存的是绝对路径已悬空 → `node scripts/fix-node-modules-junctions.mjs --dry` 先看计数，去掉 `--dry` 真改 |
| 装完侧边栏没有「无限画布」 | 组合包没启用，或没重启 DSH → 设置 → 插件 里确认 `dsh-aifisher-canvas` 已开启，再重启 |
| 画布能打开但接口 404 | host 半没重新加载（只刷新页面不够）→ 重启 DSH |

### 基础操作速查
| 操作 | 方式 |
|---|---|
| 唤起节点搜索 | `Shift + A` / 双击空白处 |
| 自定义工作流 | 左侧栏导入 ComfyUI 导出的 API JSON |
| 配置云端通道 | 设置 → 闭源服务，填 Base URL + API Key |
| 让 AI 帮你操作画布 | 直接在右侧聊天栏说你的需求即可 |

---

## 🧱 技术实现

```
vendor/aifisher/        # 上游 AIFISHER 源码树，零修改
  ├─ 锚点补丁脚本        # 每条补丁带命中次数断言，上游改写法立刻构建报错
  ├─ 整文件覆盖          # 仅修改需要适配的核心文件
  └─ 装配层              # 多安装器注入画布槽位
```

- 前端：React 19、Tailwind CSS 4、shadcn/ui、TipTap、Wavesurfer
- 后端：Node.js 原生 HTTP 服务，所有接口统一 `/api/aifisher/*` 命名空间
- 双 bundle 架构：host 半进程内加载，client 半浏览器独立运行，跨 bundle 通过全局桥通信
- 与 DSH 宿主的边界：画布会把「从系统拖进来的文件」事件止步在自己的容器上（`src/client/canvas/mount.tsx` 的 `containFileDrags`）。原因是宿主把「拖入即可添加附件」的全屏提示层挂在 `document` 的 dragenter/dragleave 计数上，而画布的 `onDrop` 会 `stopPropagation` —— 放进去的话宿主永远收不到那次 drop，计数停在 1，整屏遮罩再也退不掉（真机踩过）。同理，任何一次鼠标点击都会补一次 dragleave，把已经卡住的遮罩解开。
- 测试覆盖：类型门禁（`pnpm typecheck`，`src/` 零错误）+ jsdom 契约测试 + 真机浏览器视觉校验，累计 2200+ 回归用例守住画布几何、交互、响应逻辑
- 保存链路（v1.58，见 `scripts/patches/aifisher/src/stable/persistence/canvasWorkflow.ts`）：上游的乐观并发是「撞 409 → 重读服务端 → 三向合并 → 重发」，但三向合并遇到**同一字段两边都改**会抛冲突，并把这份文档的保存**永久封锁**（只有重新打开项目才解），画布照常能编辑、实际一个字都存不进去。本插件改成「救援合并」：节点/分组按 id 取并集、同 id 以当前窗口为准、**一定落盘**，并提示用户核对；保存/读取请求另加 20s 超时，避免一次挂住的请求把保存队列永久占死。agent 的每次改动还会由 host 立刻追加一次保存，回执里用 `saved` 说明有没有真的写进 `canvas.json`。
- 云端结果落盘（2026-10-20）：云端通道回的是**服务商临时链接**（如 `https://file*.aitohumanize.com/file/<hash>.png`），host 侧会先把字节下载进素材库，节点的 `resultUrl` 才是同源 `/api/aifisher/canvas/media/...`。图床在任务刚回报 SUCCESS 的头几秒常常还是 404（文件没落地），所以下载带 4 次退避重试；真要失败，节点会显示「图片链接已失效」并留痕到 `/api/aifisher/canvas/diagnostics`（`installImageLoadTelemetry` 收 img 的 error 事件），而不是静默留一块黑。
- 火山方舟直连（v1.60）：一张卡片管两种媒体，只认 `ARK_API_KEY`。**图片**走 `POST /api/v3/images/generations`（`arkImageProvider.ts`：档位+比例 → `size`、参考图内联成 data URL、组图/图层拆分按模型能力分流）；**视频**（Seedance 2.0，`arkVideoProvider.ts`）走异步任务 —— `POST /api/v3/contents/generations/tasks` 提交 `content` 数组（`text` / `first_frame` / `last_frame` / `reference_image` / `reference_video` / `reference_audio`）再轮询 `GET …/tasks/{id}`，出片后立刻把 mp4 下载进素材库。参考图的字节内联（方舟访问不到 `127.0.0.1`），参考视频/音频只收公网直链；模型名逐字取自画布目录（`豆包视频2.0`），界面的「自定义模型 ID」可换成账号下的推理接入点（`ep-…`）。
- Agent 契约：[docs/canvas-agent-contract.md](docs/canvas-agent-contract.md) —— `canvas_control` 每类 operation 的字段、`configure` 的四条硬约束（模型名逐字匹配 / 换模型会重置高级参数）、生成授权边界与错误码速查。**要让 AI 正确操作画布，先喂它这份文档。**

---

## 📂 数据存储

所有数据默认存放在 `$DSH_HOME/storages/dsh-aifisher-canvas/`，支持在设置中一键迁移到其他磁盘：
- `canvas.json`：画布项目、节点、视口自动存档
- `media/`：生成与上传的图片/视频/音频素材
- `workflows/`：自定义 ComfyUI 工作流配置
- `cloud-channels.json`：云端通道与密钥配置（密钥值不回传前端）

---

## 📄 许可证

⚠️ 本项目基于 AIFISHER 源码构建，采用 **AIFISHER Noncommercial Source License 1.0**：
- ✅ 个人学习、非商业创作、技术研究可自由使用与修改
- ❌ **禁止任何商业用途**：包括接私单、付费出图、售卖插件、商业 SaaS、付费托管
- 再分发必须保持免费，并保留 LICENSE / NOTICE 文件与修改说明
- 商用授权请联系原版权方 Work-Fisher 获取书面许可

---

## 🤝 贡献

欢迎提交 Issue 和 PR。修改代码前请阅读 `README.dev.md` 中的开发约束章节，了解 vendor 补丁机制、双 React bundle 隔离规则和画布几何的 dpr 约束，避免踩历史踩过的坑。
