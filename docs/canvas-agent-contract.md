# canvas_control · Agent 契约与边界

> 这份文档写给**要操作这块画布的 AI Agent**，以及**要改这个插件的贡献者**。
>
> 起因是实测：一个 Agent 第一次用 `canvas_control`，为了搞清楚 `operations` 怎么写，读了 6 个源文件、串了 20+ 次工具往返，**耗时 1 分钟**；而同样的操作在知道契约之后只要 **3 次调用**。差距不在模型，在可发现性。所以把契约从 `.d.ts` 里搬到画面上。

---

## 1. 最短路径

```
edit  →  （看返回里的 snapshot）
```

1. `edit` 直接带 `operations:[]`；`revision` **可以省略** —— host 会自己先读一次补上（v1.52）。
2. 成功时返回 `{ok, revision, operationId, created, snapshot}`：`snapshot` 是精简后的节点列表，**不需要再 read 验证**。
3. 需要读全文时才 `read detail:"full"`；默认 `read` 会把节点正文截断到约 240 字（带 `textTruncated` 与 `readSummary.hint`）。
4. **先看全貌再动手**：`read view:"digest"` 返回项目摘要 —— 节点/分组/连线统计、按状态计数、`hints`（如「2 个生成节点还没有提示词」「有 1 个节点是孤立节点」），**不含正文**；规划多步任务时先来这一下，再按需 `read view:"nodes" detail:"full"` 取细节。

以前是 `read → edit → read` 三次；v1.52 把「读+改」合并成一次调用，并省掉了验证用的那次 read。
如果发现自己正在 grep 源码找字段名，说明契约没覆盖到你的场景 —— 请给 `src/host/index.ts` 的工具描述提 PR。

---

## 2. edit 的 operation 契约

每条 operation 是一个判别联合，`kind` 决定字段。

| kind | 字段 | 说明 |
|---|---|---|
| `create` | `ref` `type` `x` `y` `title?` `prompt?` `text?` | `type` ∈ `Image` / `Video` / `Audio` / `Text`；`ref` 是本次 edit 内的临时名，用于 `created[]` 回传。**Text 节点**：`text` 是正文（节点上显示的那段字），`prompt` 是转换模板；只给 `prompt` 时会被当成正文写入（不会落进提示词框） |
| `update` | `nodeId` `patch{title?,prompt?,x?,y?,text?}` | 只改这几项；改模型/参数用 `configure`。Text 节点只给 `prompt` 同样按正文处理 |
| `configure` | `nodeId` `model` `parameters{}` | 见第 3 节，**最容易踩坑** |
| `delete` | `nodeId` | |
| `connect` | `sourceId` `targetId` `sourcePort?` | |
| `disconnect` | `sourceId` `targetId` `targetPort?` | |
| `group` | `ref` `nodeIds` `label` | |
| `ungroup` | `groupId` | |
| `renameGroup` | `groupId` `label` | |
| `arrange` | `nodeIds` `columns` | 网格排列 |
| `duplicate` | `nodes[{nodeId,ref}]` `x` `y` | |

**节点落位（v1.53）**：`create` 的坐标会被 host 兜底 —— 没给 `x/y`、或给的坐标会与已有节点重叠时，host 会把节点放到已有内容右侧的空位（约 40px 间隙）；显式坐标落在空地则原样保留。所以 agent 不用为了「别盖住别的节点」自己算坐标，直接把 `x/y` 交给 host 判断即可。

`edit` 返回 `{ok, revision, operationId, created:[{ref,id}]}`。`operationId` 可以喂给 `action:"undo"`（同样要带 `revision`），但画布有后续修改后会失效（`CONFLICT`）。

### recipe：一次展开分镜（v1.55）

```jsonc
{ "action": "recipe",
  "recipe": { "name": "shot-list",
              "anchorId": "剧本节点id",
              "columns": 3,
              "shots": [
                { "title": "镜头1 · 大全景", "prompt": "…" },
                { "title": "镜头2 · 中景", "prompt": "…", "type": "Video" }
              ] } }
```

- host 一次展开成节点 + 可选 configure（`shots[].model` 与 `parameters` 同时给才 configure），画布侧只收到一条普通 edit；
- 排布优先放在 anchor 正下方，放不下自动让到已有内容右侧/下方，不与已有节点重叠；
- **不自动连线**：画布的 Text→Image 连线会把整段剧本拼进每条提示词，需要连线时再显式 `connect`；
- 返回 `created`、`recipe.placed`（每个镜头的坐标）、`snapshot`；`shots` 上限 24。

### preview：看生成结果（v1.56）

```jsonc
{ "action": "preview", "nodeIds": ["节点id"] }   // nodeIds 可省略 = 全部节点
```

返回每个有结果的节点：`media[{ url, kind:"file"|"remote"|"data"|"missing", path?, type? }]`。`kind:"file"` 的 `path` 是本机绝对路径，图片直接 `read_image` 打开自评；视频/音频需要画面时用 `media` 动作截帧。**preview 不改画布**。画布把项目加载进内存时会规范化节点（`resultUrl` 可能被剥离），host 已回退到项目持久化文档补齐，所以刚生成完和重开项目后都能拿到结果。

### 生成事件推送：批次跑完会主动找你（v1.57）

你 `prepareGeneration` 之后，用户点确认、画布开始跑；**这批全部到终点时，host 会往这个会话推一条消息**：

```
【画布生成事件｜宿主自动推送，不是用户发言，也不是一条新任务】
你之前准备的那批生成已结束（共 3 个节点）：
- 节点 n1「镜头1」：图片 · 成功，2 个结果 · 12.4s
- 节点 n2「镜头2」：视频 · 失败 · COMFY_NODE_MISSING · …
- 节点 n3「镜头3」：图片 · 已取消 · GENERATION_CANCELLED
下一步（按需，不用复述…）：成功的 preview 自评；失败的修原因后重新 prepareGeneration，仍要用户确认。
```

几条口径：

1. **成组**：一批里全部节点到终点才推一次；某个节点卡住时，第一条终点事件后最多等 90s 就带着「还有 N 个没结束」推出来。别指望一节点一条。
2. **只推 Agent 准备的批次**：`prepareGeneration` 会把批次落进 `/agent/plans`，host 从中拿到 `sessionId` + `nodeIds`。用户在画布上自己点生成的那些**不会**推（任务队列面板是它们的实时视图）。
3. **收到后怎么做**：成功的 `preview` → `read_image` 看图自评；失败的按错误码修（缺节点/模型未开通/提示词与参数），再 `prepareGeneration`。**仍然不许提交或绕过确认**——「确认本批生成与费用」永远归用户。
4. **别复述**那条事件，也别把它当成用户的新指令；没有后续动作就简短说一句现状。
5. 排查：`GET /api/aifisher/canvas/events?recent=20` 是只读回看；`/api/aifisher/canvas/status` 里的 `events`（`openBatches`/`bindings`）与 `plans` 是计数。
6. `/agent/plans` 是内存实现（v1.57）：DSH 重启后旧的 pending 批次会消失，画布上那张确认卡片也随之不再出现——节点状态以画布为准，重新准备即可。

### 项目记忆：跨会话记住风格/角色/参数（v1.59）

```jsonc
{ "action": "memory", "memory": { "op": "list" } }
{ "action": "memory", "memory": { "op": "set", "kind": "style", "text": "黄昏海边，冷色调，低饱和", "key": "look", "importance": 3 } }
{ "action": "memory", "memory": { "op": "remove", "id": "记忆id" } }
{ "action": "memory", "memory": { "op": "anchor-add", "role": "character" }, "nodeIds": ["定妆节点id"] }
{ "action": "memory", "memory": { "op": "anchor-set", "anchors": [{ "nodeId": "…", "title": "角色A", "role": "character" }] } }
{ "action": "memory", "memory": { "op": "anchor-remove" }, "nodeIds": ["定妆节点id"] }
```

- 存储：`<数据目录>/canvas-memory.json`（文本条目 + 参考锚点，最多 40 条/项目）；
- `kind`：`style` / `character` / `model` / `param` / `rule` / `note`；同 `kind`+`key` 是**原地更新**（不会越记越多）；
- 注入：画布对话的**每个回合**会带一段【画布项目记忆】（内容没变就不重复注入），所以新会话不必重新交代画风；
- 主区域会话不硬塞，靠 `read view:"digest"` 里的 `digest.memory` 看到条数。

### 视觉一致性：把参考锚点接到镜头上（v1.59）

```jsonc
{ "action": "consistency", "consistency": { "op": "status" } }
{ "action": "consistency", "consistency": { "op": "lock", "nodeIds": ["镜头1", "镜头2"] } }  // nodeIds 可省略 = 全部镜头
{ "action": "consistency", "consistency": { "op": "unlock" } }
```

- 画布不发明新协议：**上游节点结果就是参考图**，所以「锁脸/锁服装/锁画风」= 把定妆节点 `connect` 成镜头节点的上游；
- `lock` 只连缺失的（已连的跳过），锚点自己不算镜头，幽灵锚点会如实回报；
- 覆盖率口径：**每个镜头都引用全部锚点**才算 covered（两个锚点时只接一个不算）；
- `status` 返回 `coverage{shots,covered,uncovered[],summary}`，适合判断「还剩几个镜头没锁」。

### 主动副驾：现在最该做什么（v1.59）

```jsonc
{ "action": "copilot" }
→ { "summary": "2 条建议，其中 1 条要马上处理。",
    "suggestions": [{ "id": "failed-nodes", "level": "high", "title": "2 个节点生成失败", "detail": "…", "ask": "…" }],
    "consistency": { … }, "memory": { "entries": 3, "anchors": ["角色A"] } }
```

建议来源与优先级：失败节点 > 缺提示词 > 一致性缺口 > 记忆空白 > 孤立节点 > 进行中的长任务，最多 5 条。画布左下角有胶囊，点开可看；用户可以在面板里「不再提示」关掉。

HTTP 面（界面同源调用）：`GET /api/aifisher/canvas/copilot?projectId=` 默认读**磁盘文档**；
加 `&live=1` 才去问活画布（刚建、还没保存的节点也在）。后台 30s 轮询必须用默认，
否则画布关掉/正在重载时那一问会等满超时，把页面卡住。

### 长任务：一次提交「做完整短片」（v1.59）

```jsonc
{ "action": "job", "job": {
    "op": "create",
    "name": "雨夜短片",
    "shots": [{ "title": "镜头 1", "prompt": "…", "model": "画布里的显示名", "parameters": { … } }],
    "columns": 3,
    "lockAnchors": true,
    "prepare": true,
    "retry": { "enabled": true, "maxAttempts": 2 }
} }
{ "action": "job", "job": { "op": "status", "id": "任务id" } }
{ "action": "job", "job": { "op": "list" } }
{ "action": "job", "job": { "op": "cancel", "id": "任务id" } }
```

固定流水线：`read → shots（复用 recipe）→ lock（接锚点）→ prepare（准备批次）→ await（等确认 + 等结果）→ retry（失败自动再准备）→ report`。

- **立即返回**任务快照，不等生成；用 `op:"status"` 看每一步的 state/detail；
- v1.63 起 `op:"create"` 也可以只给 `brief`（可带 `shotsCount`/`type`/`aspectRatio`/`duration`/`model`/`style`）：host 先用意图编译器编出 shots 再进流水线，显式 `shots` 仍然优先 —— 「一句话做完整短片」于是变成一次调用；
- 审批红线不变：只调用 `prepareGeneration`（`awaiting-approval`），重试也只是**再准备一批**，仍要用户点确认；
- `state` 语义：`running`（在建节点/准备）→ `awaiting-approval`（等用户点确认）→ `waiting`（批次 running）→ `completed` / `failed` / `cancelled`；
- 收口/自动重试会给会话推一条【画布长任务】通知（推不出去就在下一回合补）；
- `GET /api/aifisher/canvas/jobs?projectId=` 与 `POST /jobs/:id/cancel` 是给界面/排查用的同源 HTTP 面。

### 意图编译器：一句话 → 一排镜头（v1.63）

```jsonc
{ "action": "intent", "intent": { "op": "compile", "brief": "雨夜追车。挡风玻璃上水痕。远处警灯逼近。", "shots": 3 } }
{ "action": "intent", "intent": { "op": "apply",   "brief": "雨夜追车，6 个镜头，16:9，视频 5 秒", "columns": 3 } }
```

`compile` 只返回计划（不改画布），`apply` 一次展开成节点（内部走 recipe，审批仍在画布 UI）。编译规则：

- **镜头数**：显式 `shots` > brief 里的「6 个镜头 / 六镜」 > 句子数；句子不够时先把长句按逗号细分（不复制文本），仍不够就**少出镜头**并写进 `notes`/`missing`——不会编造画面内容。
- **类型/画幅/时长**：`type` 显式 > brief 关键词（视频/短片/seedance → Video）；`aspectRatio` 认 `16:9` 这种写法；`duration` 认 `5s/5 秒`。
- **风格与锁定串**：`style` 显式 > 项目记忆里 `kind:"style"` 的条目；资产库与记忆里的角色（`kind:"character"`）逐字织进**每一镜**。`includeLocks:false` 可关。
- **固定串**：每镜末尾必带质感锚点与画面内限制（`qualityAnchor`/`limitClause` 可覆盖），项目记忆里的 `rule` 条目作为约束追加。
- **参数**：只有给了 `model` 才挂 `parameters`（画布要求 `model+parameters` 同时给，见第 3 节）；没给 model 时画幅/时长只写进 `notes`。

### 质量评估：只判能判的（v1.63）

```jsonc
{ "action": "review", "review": { "op": "scan" } }
{ "action": "review", "review": { "op": "fix", "apply": true } }
```

- **scan**：提示词（缺失/过短/过长/缺光源/缺质感锚点/缺限制）、锚点覆盖（直接复用 `coverageReport().uncovered`）、结果文件（存在/0 字节/过小/格式/像素尺寸，只读文件头）、失败归因；输出 `summary.retry[]` = 该重新准备的节点。
- **不评价构图好坏**：报告带一段固定 rubric，视觉判断仍由 agent `preview` → `read_image` 完成；报告本身不改画布。
- **fix**：把缺失的固定串**追加**到提示词末尾（原文保留），`apply:true` 才写回画布（update 只接受 title/prompt/text/x/y）。

### 资产库：一次定版、多镜引用（v1.63）

```jsonc
{ "action": "assetlibrary", "assetlibrary": { "op": "add", "kind": "character", "name": "林溯", "prompt": "林溯：35 岁男性，短寸头，左眉有一道疤…" } }
{ "action": "assetlibrary", "assetlibrary": { "op": "link", "id": "资产id", "nodeId": "定妆节点id" } }
{ "action": "assetlibrary", "assetlibrary": { "op": "use", "id": "资产id" } }        // 登记为锚点 + 锁到镜头
{ "action": "assetlibrary", "assetlibrary": { "op": "import", "locks": [ … ] } }
```

- 存储：`<数据目录>/canvas-assets.json`（每项目最多 60 条）；`kind` 取 `character`/`scene`/`prop`/`style`，同名同类型**原地更新**；
- 分工：项目记忆是「一两句偏好」，资产库是「可复用资产卡片 + 锁定串 + 定妆节点」；
- `use` 只对**挂了节点**的资产有效（`NEED_NODE` 会提示先 `link`）；它复用一致性机制：定妆节点 → 上游连线，覆盖率按「每个镜头引用全部锚点」算；
- HTTP 面：`GET/POST /api/aifisher/canvas/asset-library`、`POST /asset-library/link|import`、`DELETE /asset-library/:id`。

### 多 agent：任务是协议，不是口头约定（v1.63）

```jsonc
{ "action": "crew", "crew": { "op": "plan", "brief": "雨夜追车短片，6 个镜头", "shots": 6 } }
{ "action": "crew", "crew": { "op": "receive", "role": "storyboard", "deliverable": { "shots": [ … ] }, "apply": true } }
```

- **plan**：按任务复杂度派角色（导演/分镜/设定/审片），每个 `assignment` 带 `task`、`deliverable`（JSON 契约）、`boundary`（不许调用 canvas_control/prepareGeneration、不许改画布）和**压过的上下文**（brief 摘要 + 风格 + 资产名 + 摘要统计，≤1600 字符，不含节点正文）；
- **receive**：逐条校验交付（空 prompt 等逐条 `rejected` 并给原因），合格 `shots` 归一后 `apply:true` 走 recipe 展开；`locks` 默认批量登记进资产库（`importLocks:false` 可关）；
- host **不替你起子代理**：把 assignments 交给 DSH 的 subagent 机制即可，审批权永远不随任务包下发。

---

## 3. configure 的四条硬约束

```jsonc
{ "kind": "configure",
  "nodeId": "…",
  "model": "GPT-Image-2.5-lowprice 高速标准版",
  "parameters": { "mode": "text-to-image", "resolution": "1K",
                  "aspectRatio": "3:4", "generateCount": 4 } }
```

1. **`model` 必须与画布目录里的显示名逐字一致。** 自配通道模型的显示名是拼出来的（形如 `通道标签 · 模型标签` 去掉多余空格），**别自己猜**——先 `create` 一个节点再 `read`，新节点会自动继承目录里的默认模型，那个 `model` 字段就是准确写法。
2. **`parameters` 的每个 key 必须是该模型声明过的描述符**（`mode` / `resolution` / `aspectRatio` / `generateCount` / `duration` …）。传未声明的 key 会让整次 edit 失败并返回 `INVALID`，不是忽略。
3. **换模型会重置未显式传入的高级参数。** 这是 `canvasModelControl.ts` 里刻意的行为（换模型不继承不兼容的旧值），后果是：UI 上先设了 `generateCount:4`、再换模型，数量会**悄悄打回 1**。所以「换模型 + 设数量」必须写进**同一次** `configure`。
4. **目标节点不能处于 `loading` 或带有 `generationAttemptId`**，否则 `configure` 返回 `INVALID`。

---

## 4. 生成：Agent 只能准备，不能提交

这是**设计如此**，不是 bug。

```
prepareGeneration(revision, nodeIds)
  → { generationState: "awaiting-approval", generationPlanId }
  → 【用户在画布右下角点「确认本批生成与费用」】
  → 真正提交
```

- `approve()` 只挂在 UI 上，**故意没有暴露给 `canvas_control`**（`canvasCreationControl.ts` 里那句 `This method is held by the UI only`）。
- 理由：生成是要花钱的动作，费用授权必须由人按下。
- 因此 Agent 的职责边界是：**把节点、模型、参数、提示词准备到位，把确认卡片递到用户面前**。不要试图绕过，也不要把「跑不通生成」当成待修的缺陷。
- **确认卡在哪（v1.58）**：上游那张卡在画布内 Agent 面板里，而 DSH 版把那个面板换成了右侧原生会话，所以卡片改由
  `src/canvas-ui/canvas/CanvasGenerationBatches.tsx` 画在**画布右下角**（只列当前项目的 pending/running 批次）。
  控制器由 vendor 补丁 3.8v 挂到 `window.__FISHERAI_CANVAS_GENERATION_BATCHES__`；不新增协议动作，
  `canvas_control` 依旧拿不到 `approve`。排查「看不到确认按钮」：读
  `/api/aifisher/canvas/diagnostics` 里 `canvasAppBuildInfo().generationBatches`（`bridged` / `visible` / `card`）。
- 一批次 10 分钟内有效；同一会话同时只允许一个 pending 批次（第二个返回 `CONFLICT`）；一批所有节点合计不得超过 100 张。
- 准备动作最后要 `POST /api/aifisher/canvas/agent/plans` 落一条批次记录（v1.57 起 host 自己实现，内存态）——
  缺了它整条准备链会 `UNAVAILABLE`（v1.57 之前就是这个状态）。记录里的 `sessionId` + `items[].nodeId`
  同时就是「这批跑完推给谁」的绑定信息。

### 自配云端通道（v1.52 已补）

`GET /api/aifisher/canvas/generation/sources` 现在返回：

- 方舟直连一张卡（`source:"ark"`）；
- **每条自配 OpenAI 通道**一张只读卡（`source:"channel:<id>"`，`accountManaged:true`、`secrets:[]`、模型名 = 画布显示名、`configured:true`）。

于是 `canvasCreationControl` 能认出通道模型，`action:"models"` 与 `action:"prepareGeneration"` 对自配通道也能走通。
**但这只是「能准备」**：批次仍停在 `awaiting-approval`，最后一击（确认费用）永远归用户在画布面板按下 —— 这是设计如此，不是缺陷。

---

## 5. 错误码速查

| code | 含义 | 怎么办 |
|---|---|---|
| `CONFLICT` | 你手上的 `revision` 过期了（编辑期间画布被改过） | 重新 `read` 再来 |
| `INVALID` | 参数不合法（未声明的 key、模型名不对、节点在生成中） | 核对第 3 节 |
| `UNAVAILABLE` | 画布运行时不可用（画布页未打开）或生成来源未配置 | 确认画布页在活动，或见上面的已知缺口 |
| `NOT_FOUND` | `nodeId` 不存在 | 重新 `read` 拿 id |
| `UNCONFIRMED` | 指令过期 / 结果未确认 | 核对画布实际状态，别盲目重试 |

---

## 6. 排查清单

- 参数没生效？→ 先确认 `edit` 返回的 `ok:true`，再 `read` 复核；`configure` 的失败是**整次 edit 失败**，不会部分写入。
- 数量/比例莫名变了？→ 回想有没有换过模型（第 3 节第 3 条）。
- 生成点不动？→ 先看是不是落在第 4 节的缺口里，而不是自己的参数写错了。
- 每次操作都慢？→ 数一下工具调用次数。正确姿势是 1~2 次（`edit` 一次完成，`snapshot` 已回带）；每次工具调用都是一次完整模型推理，多出来的轮次都会直接变成等待时间。
