# canvas_control · Agent 契约与边界

> 这份文档写给**要操作这块画布的 AI Agent**，以及**要改这个插件的贡献者**。
>
> 起因是实测：一个 Agent 第一次用 `canvas_control`，为了搞清楚 `operations` 怎么写，读了 6 个源文件、串了 20+ 次工具往返，**耗时 1 分钟**；而同样的操作在知道契约之后只要 **3 次调用**。差距不在模型，在可发现性。所以把契约从 `.d.ts` 里搬到画面上。

---

## 1. 最短路径

```
read  →  edit  →  read
```

1. `read` 拿 `revision`（乐观并发令牌）和节点清单；
2. `edit` 带上**同一个** `revision` 和 `operations:[]`；
3. 再 `read` 一次复核结果（参数是否真的写进去了）。

只要三次。如果发现自己正在 grep 源码找字段名，说明契约没覆盖到你的场景 —— 请给 `src/host/index.ts` 的工具描述提 PR。

---

## 2. edit 的 operation 契约

每条 operation 是一个判别联合，`kind` 决定字段。

| kind | 字段 | 说明 |
|---|---|---|
| `create` | `ref` `type` `x` `y` `title?` `prompt?` | `type` ∈ `Image` / `Video` / `Audio` / `Text`；`ref` 是本次 edit 内的临时名，用于 `created[]` 回传 |
| `update` | `nodeId` `patch{title?,prompt?,x?,y?}` | 只改这四项；改模型/参数用 `configure` |
| `configure` | `nodeId` `model` `parameters{}` | 见第 3 节，**最容易踩坑** |
| `delete` | `nodeId` | |
| `connect` | `sourceId` `targetId` `sourcePort?` | |
| `disconnect` | `sourceId` `targetId` `targetPort?` | |
| `group` | `ref` `nodeIds` `label` | |
| `ungroup` | `groupId` | |
| `renameGroup` | `groupId` `label` | |
| `arrange` | `nodeIds` `columns` | 网格排列 |
| `duplicate` | `nodes[{nodeId,ref}]` `x` `y` | |

`edit` 返回 `{ok, revision, operationId, created:[{ref,id}]}`。`operationId` 可以喂给 `action:"undo"`（同样要带 `revision`），但画布有后续修改后会失效（`CONFLICT`）。

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
  → 【用户在画布面板点「确认本批生成与费用」】
  → 真正提交
```

- `approve()` 只挂在 UI 上，**故意没有暴露给 `canvas_control`**（`canvasCreationControl.ts` 里那句 `This method is held by the UI only`）。
- 理由：生成是要花钱的动作，费用授权必须由人按下。
- 因此 Agent 的职责边界是：**把节点、模型、参数、提示词准备到位，把确认卡片递到用户面前**。不要试图绕过，也不要把「跑不通生成」当成待修的缺陷。
- 一批次 10 分钟内有效；同一会话同时只允许一个 pending 批次（第二个返回 `CONFLICT`）；一批所有节点合计不得超过 100 张。

### 已知缺口：自配云端通道走不通 Agent 生成

`GET /api/aifisher/canvas/generation/sources` 目前只返回**火山方舟**一张卡片（`sourceSettingsRouter.ts` 里的 `sendJson(res, 200, { blocks: [arkBlock(process.env)] })`），而 `canvasCreationControl` 是靠这份 blocks 判断模型是否 `configured`。

后果：

| 接口 | 现象 |
|---|---|
| `action:"models"` | 恒返回 `models: []` |
| `action:"prepareGeneration"` | 恒返回 `UNAVAILABLE` |

而自配通道（设置 → 闭源服务里那几条）的模型**在节点下拉里能选、在节点上手动点「生成」能正常出图**——断的只是 Agent 这条链路。补法：把 `cloudChannels` 的通道也拼成 block 塞进 `/generation/sources`。注意补完也**只是能弹出确认卡片**，最后一击仍然归用户。

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
- 每次操作都慢？→ 数一下工具调用次数。正确姿势是 3 次；超了就是契约没覆盖，欢迎提 PR。
