# 数据存在哪、换电脑怎么迁移

> 一句话：**这个插件的数据只有一处 —— 默认是 `$DSH_HOME/storages/dsh-aifisher-canvas/`。**
> v1.43 起，这个目录可以在 **设置 → 存储 → 项目数据目录（缓存）** 里改到别的盘（重启 DSH 生效）。
> 迁移 = 新机器装好同版本插件 + 把这一个目录整个搬过去 + 重启 DSH。
> 不需要导出数据库、不依赖插件安装目录、也不会因为换项目而丢。

本机（2026-10-18 实测）：`$DSH_HOME = C:\Users\duyumingze\.dsh`，
数据目录 = `C:\Users\duyumingze\.dsh\storages\dsh-aifisher-canvas\`（当时 22.3 MB / 2 个项目 / 38 个素材文件）。

## 一、把数据目录换到别的盘（v1.43）

**设置 → 存储 → 项目数据目录（缓存）**：

- 上面一行显示**这个进程正在用的目录**（以及默认目录是什么）；
- 下面填一个**绝对路径**（例如 `D:\DSH数据\canvas`）→ 勾着「把现有数据复制到新目录」→ 点「应用」；
- 面板会告诉你复制了几个文件，以及 **要重启一次 DSH 才生效**（host 的存档/素材库/通道表都是启动时按目录
  加载的，运行中只写指针做不了热切换 —— 界面不会假装已经切了）；
- 重启后回来，那一行就变成新目录；「恢复默认」把指针删掉、下次重启回默认目录（**不会删**你那份数据）。

它改的是「整个插件的数据根」，所以**下面第二节列的所有文件都会跟着搬**（包括密钥表、通道表）。

底层（排查用）：指针文件固定是 `<默认数据目录>/data-dir.json`（`{directory, savedAt}`）——
放在默认目录里的原因是「数据搬走之后它还得找得到」。接口：

```
GET    /api/aifisher/canvas/data-dir                     现状（active / pending / restartRequired）
POST   /api/aifisher/canvas/data-dir  {directory, migrate}
DELETE /api/aifisher/canvas/data-dir                     回默认目录
```

校验：绝对路径；不能是文件；不能就是当前/默认目录；不能和它们互为父子；复制是「只复制、不覆盖同名文件」。

---

## 二、目录里都有什么

`canvas.json` 的结构（一眼能对上）：

```json
{
  "version": 1,
  "documents": { "<项目id>": { "id": "…", "revision": 139, "title": "…", "nodes": [], "groups": [], "viewport": {}, "coverUrl": "…", "createdAt": "…", "updatedAt": "…" } },
  "folders": { "<文件夹id>": { "id": "…", "name": "…", "parentId": null } },
  "preferences": { "values": { "<上游界面偏好>": "…" }, "browserImported": false }
}
```

节点上的 `stackItems`（叠图那一叠的内容）、`resultUrls`、`parentIds` 全在 `documents` 里，
所以「把项目搬过去」= 把这份 JSON 和它引用的素材一起搬。

| 文件 / 目录 | 内容 | 换电脑要不要带 |
|---|---|---|
| `canvas.json` | **所有项目**（节点/连线/分组/视口/叠图内容）+ 文件夹 + 上游界面偏好（`preferences.values`，主题/模型下拉偏好等都在这里） | ✅ 必须 |
| `media/<项目id>/<images\|videos\|audios>/` | 生成与上传的素材本体 + 同目录 `<文件名>.json` 侧车（提示词、尺寸、生成参数） | ✅ 必须（不带就是「项目在、图全裂」） |
| `media/.tmp/` | 上传/加工的临时文件 + `thumbnails/` 缩略图缓存 | ❌ 可不带（缩略图会按需重建） |
| `library.json` | 资产库索引（显式收藏的那些图） | ✅ 建议 |
| `workflows/` | 目录式自定义 ComfyUI 工作流（Export (API) JSON + `<名字>.meta.json` 配置） | ✅ 建议 |
| `workflow-dir.json` | 自定义工作流**目录设置**（`dir`，`null` = 默认 `workflows/`） | ⚠️ 看情况：指向本机绝对路径的话换机后要重选（不存在就回落默认目录） |
| `workflow-covers.json` + `workflow-covers/` | 工作流节点面板的卡片配图（索引 + 图片本体） | ✅ 建议 |
| `comfy-widget-options.json` | ComfyUI `/object_info` 枚举快照（5 分钟 TTL 的缓存） | ❌ 可不带（会重扫） |
| `appearance/` | 画布背景图（`background.<ext>` + `background.json`） | ✅ 想要背景就带 |
| `downloads.json` + `downloads/` | 媒体下载目录设置与下载产物（目录可自定义成别的绝对路径） | ⚠️ 自定义过目录的话换机后要重选 |
| `prompts.json` | 提示词预设 + 创意库收藏 | ✅ 建议 |
| `cloud-keys.json` | 界面上填过的密钥（现在只剩方舟 `ARK_*`） | 🔒 **敏感**：带，但别进公开仓库 |
| `cloud-channels.json` | 自配 OpenAI 兼容通道（名称 / Base URL / Key / 请求方言 / 勾选的模型） | 🔒 **敏感**；不带就得在新机器重配通道 |
| `agent-chat.json` | 画布右侧对话的「节点 ↔ DSH 会话」映射 | ✅ 建议 |
| `data-dir.json` | **数据目录指针**（v1.43）：`{directory, savedAt}`，由「设置 → 存储 → 项目数据目录」写入；有它时**所有数据**都落在 `directory` 指的那个目录 | ⚠️ 换机后想继续用自定义目录：那份数据一起带过去，再在新机器设一次（或把这个指针文件放进默认目录；`defaultDataDir()` 永远由 `$DSH_HOME` 算得出来，所以数据搬走了指针也还在默认目录里） |
| `.dsh-meow/` | **meow-memory 记忆插件**的数据（不是画布插件写的）；想带走记忆就一起带 | ⚠️ 独立插件，按需 |

### 不在这个目录里的四样东西

1. **插件本体**：已装目录（本机 `D:\AllAssets\DSH插件\dsh-aifisher-canvas`）与开发工作区是代码，不是数据。
2. **DSH 的会话记录**：右侧会话栏显示的是 DSH 原生会话，聊天记录在 `$DSH_HOME/sessions/…`
   与 DSH 自己的存储里；画布这边只存 `agent-chat.json` 那点映射。**只搬画布数据 = 画布里的图都在、
   右侧的聊天历史不会跟着过来。**
3. **浏览器 localStorage 里的 5 个偏好**（都是「这台机器上的习惯」，缺了会回落默认值）：

   | 键 | 作用 | 缺省 |
   |---|---|---|
   | `dsh-aifisher-canvas.chatDock.width` | 右侧会话栏宽度 | 420（夹在 300–860） |
   | `dsh-aifisher-canvas.chatDock.open` | 右侧会话栏开合 | 开 |
   | `dsh-aifisher-canvas.taskQueue.open` | 任务队列展开/收起 | 展开 |
   | `dsh-aifisher-canvas.canvas-effects` | 画布与鼠标的互动效果 | 开 |
   | `dsh-aifisher-canvas.last-model` | 新建节点默认用的上一款模型（按 image/video/audio/text 分桶） | 空（回落模型目录第一个） |

4. **DSH 本体**：profiles / 配置 / 凭据 / 插件安装记录都在 `$DSH_HOME` 的别的子目录里，属于 DSH 的迁移话题。

---

## 三、换电脑迁移（Windows，逐步可执行）

### 0. 先决条件

- 新机器装好 DSH，再装**同一版本（或更新）**的 `dsh-aifisher-canvas`；
- 先启动一次 DSH，让它把 `storages/dsh-aifisher-canvas/` 目录建出来；
- 然后**两边都关掉 DSH 主程序**再拷数据（见下面「常见坑」）。

### 1. 旧机器：把数据目录整份复制出来

```powershell
# $DSH_HOME 没设的话就是 $env:USERPROFILE\.dsh（下面两行统一取一次，免得抄错）
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
robocopy (Join-Path $home 'storages\dsh-aifisher-canvas') 'D:\backup\canvas-data' /E /R:2 /W:2
```

要一个压缩包也行（解压后**目录要平铺**，别再套一层 `dsh-aifisher-canvas`）：

```powershell
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Compress-Archive -Path (Join-Path $home 'storages\dsh-aifisher-canvas\*') `
                 -DestinationPath 'D:\backup\canvas-data.zip' -Force
```

### 2. 新机器：覆盖回同一个相对位置

```powershell
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$dst = Join-Path $home 'storages\dsh-aifisher-canvas'
# 压缩包形态：
Expand-Archive 'D:\backup\canvas-data.zip' -DestinationPath $dst -Force
# 目录形态：
robocopy 'D:\backup\canvas-data' $dst /E /R:2 /W:2
```

`$DSH_HOME` 两台机器不一定一样（本机是环境变量指到 `C:\Users\duyumingze\.dsh`），
**以新机器为准**：把数据放进「新机器的 `$DSH_HOME/storages/dsh-aifisher-canvas`」。

### 3. 启动并核对

启动 DSH → 进「无限画布」→ 项目库应能看到原来的项目。逐项核对：

| 核对项 | 期望 | 不对时先看 |
|---|---|---|
| 项目列表 / 项目数 | 与旧机器一致 | `canvas.json` 的 `documents` 条数；`GET /api/aifisher/canvas/status` 的 `store.documents` |
| 打开项目能看到图 | 节点上的图都在（素材 URL 形如 `/api/aifisher/canvas/media/<项目id>/images/…`） | `media/<项目id>/` 是否一起拷了 |
| 设置 → 闭源服务 | 自配通道还在（名称/模型勾选都在） | `cloud-channels.json` |
| 左侧「工作流节点」 | 工作流卡片在、配图在 | `workflows/` + `workflow-covers*` |
| 画布背景 | 还是那张图 | `appearance/` |
| 右侧会话栏 | 能开、能用（历史记录是 DSH 会话那边的） | 与画布数据无关 |

### 4. 处理「机器相关」的两处设置

- **工作流目录**：设置 → 开源服务 → ComfyUI 工作流配置里重新选一次目录
  （旧路径在新机器不存在时会回落默认 `storages/dsh-aifisher-canvas/workflows/`）；
- **下载目录**：设置 → 存储，若以前改过绝对路径，重选一次；
- 浏览器里那 5 个 localStorage 偏好（上一节表格）按需重设，不影响项目数据。

---

## 四、只迁一个项目：`.fisherai` 归档（v1.42 起有面板了）
不想整目录搬，只要某个项目时用**项目归档**（格式自描述，内置素材）。
界面入口：**画布头部左侧的「项目归档」按钮**（`[data-fisherai-project-archive-trigger]`，紧挨「返回项目库」）。

**导出**（在要导出的项目里点「项目归档」）：

- 面板先显示规模：`N 个节点 · 素材 M 个（X MB）· 归档约 Y MB`；
- 「导出到目录」→ 写到**下载目录**（设置里的「下载目录」，默认 `<画布数据目录>/downloads`），
  回执给出**绝对路径**，旁边就是「打开目录」；
- 「下载到浏览器」是备用路径（浏览器不支持时它会明确让你改用「导出到目录」，不会静默失败）；
- 底层：`POST /api/aifisher/canvas/workflows/<项目id>/backup/save`（body 可带一次性 `{directory}`），
  下载形态仍是 `GET /api/aifisher/canvas/workflows/<项目id>/backup`，文件名 `<标题>.fisherai`。

**导入**（两个入口，效果一样）：

- 画布头部「项目归档」→「选择文件导入」，或直接填备份文件的**绝对路径**点「从路径导入」
  （这条不经过浏览器上传，几百 MB 也快）；
- **项目看板头部**的「导入项目」按钮（`[data-fisherai-project-import]`）—— 在项目列表页就能导，
  导完自动进那个项目；
- 底层：`POST /api/aifisher/canvas/workflows/restore`（`Content-Type: application/json` + `{path}`
  = 本机路径；其它 Content-Type = 原始归档字节），回执
  `{ id, title, nodeCount, mediaRestored, mediaMissing }`，前端拿 `id` 打开新项目。
- 也认**旧版 `.json` 画布文档**（就是 `canvas.json` 里那份文档，没有 `format` 外壳、不带素材）：
  回执带 `legacy: true`，提示里会说明「这种文档不带素材」。

它的边界（都写在 `src/host/canvas/projectArchiveRouter.ts` 文件头）：
**只带这一个项目 + 它自己的素材**；素材总量上限 512 MiB（超了只带文档并在归档里标记）；
导入会**分配新的项目 id**并把素材 URL 重写过去（不覆盖任何现有项目；同一份备份导两次 = 两个副本）；
导出目录只收绝对路径，且**拒绝**指向 `<画布数据目录>/media/**`（免得和素材混在一起）；
**不带**通道/密钥、工作流目录、资产库索引、画布背景、界面偏好。

---

## 五、常见坑

- **整目录复制前关掉 DSH**。`canvas.json` 是「写 `.tmp` → rename」的原子写，单文件不会写坏；
  但正在上传/生成的 `media/…` 半截文件会被拷成坏图。
- **别把插件目录当数据目录**：装插件只会写 `lib/`；数据只在 `storages/dsh-aifisher-canvas/`。
- **两份敏感文件**：`cloud-channels.json` / `cloud-keys.json` 里有明文密钥。备份包当敏感文件处理，
  不要提交进公开仓库（`.gitignore` 也不该让它们进仓库）。
- **别只拷 `canvas.json`**：没有 `media/` 就是「项目在、图全裂」；没有 `cloud-channels.json`
  就是「节点上的模型全都点不通」。
- **素材 URL 带着项目 id**：手工改项目文件夹名会让图裂开；要改名请走项目归档导入（它会重写 URL）。
- **版本方向**：备份格式 `version=1`，老插件读不了更新的备份（会提示先升级）；
  数据目录本身是普通 JSON，新插件读旧数据是兼容的。
- **`.dsh-meow/` 是记忆插件的**：不想要记忆就别带，带了也不影响画布。

---

## 六、排查用读数

```powershell
# 数据目录 + 项目/文件夹计数 + 素材统计（不回显任何密钥）
Invoke-RestMethod http://127.0.0.1:19387/api/aifisher/canvas/status | ConvertTo-Json -Depth 4
```

`status.store.path` 就是这台机器上真正在用的 `canvas.json` 路径 —— 换机后对不上，
说明新机器的 `$DSH_HOME` 与你以为的不一样（比如 DSH 用了 `--home` 或另一份 profile）。
