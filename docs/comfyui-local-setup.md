# 真机跑通本地生成的前置条件（本机实测记录）

> 记录时间：2026-10-16 凌晨。本文只讲「要在你机器上真的生成出一段视频，需要什么」，
> 以及**离线能核实到哪一步、哪些必须真机验**。

## 一、链路（已经接好并离线验证）

```
画布 ComfyUI 节点(MiniMax H3) → handleMiniMaxH3T2VAGenerate
  → POST /api/aifisher/canvas/comfy/minimax-h3-t2va
  → 组装 prompt 图 → 对账(/object_info) → ComfyUI /prompt → 轮询 /history → /view
  → 落 $DSH_HOME/storages/dsh-aifisher-canvas/media/<项目>/videos/<文件>
  → { success, url, asset } → 画布 <video src>
```

`node scripts/test-canvas-generation.mjs` 用**假 ComfyUI**（真 HTTP 服务，含 `/object_info`、`/prompt`、
`/history`、`/view`、`/upload/image`）把这条链路端到端跑了一遍：52 项断言全绿，
覆盖文生视频、参考素材上传、取消、结果回收、素材上传/列表/删除、提交前对账的两条失败路径。

**假 ComfyUI 验不到的**：真模型能不能加载、显存够不够、真实推理时长、真实输出格式。

## 二、本机 ComfyUI 现状（已核实）

| 项 | 现状 |
|---|---|
| 安装位置 | `G:\ComfyUI-aki-v3.2-duyumingze`（秋叶整合包，启动器：`绘世启动器.exe`；2026-10-17 复核，旧记录里的 `E:\…` 已作废） |
| 服务地址 | 默认 `http://127.0.0.1:8188`（插件读 `COMFYUI_URL`）；**当前没在运行** |
| ffmpeg | PATH 里没有；可用的是整合包内 `python\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe` |
| MiniMax H3 模型 | 齐全（19.5GB unet + 25.3GB 文本编码器 + 两个 VAE + 一个 4step LoRA） |
| 自定义节点 | 装了 `nkxx188/ComfyUI-MiniMaxH3-Easy`（1.3.0）等 30 多个包，**但没有模板需要的 T8 系列节点** |

### 两个必须处理的差异

**1）节点包不对口（阻塞）**

内置模板 `src/host/comfyui/workflows/MiniMax-H3-T2VA-api.json` 来自上游 AIFISHER，用的是低阶 T8 节点：

- `MiniMaxH3AudioConditioningT8`
- `MiniMaxH3MultiRateSamplerEXPT8`
- `MiniMaxH3AVDecodeT8`

本机装的是 `ComfyUI-MiniMaxH3-Easy`，节点名全是 `MiniMaxH3Easy*`（`EasyLoader` / `EasySampler` /
`EasyOutput`…），**两者不是同一套**。离线扫描过本机 1946 个节点源码文件，上面三个 T8 类名一个都不存在。

- 上游那两个「fisherai」小包（`fisherai_node_ids` / `fisherai_canvas_inputs`）只是画布辅助，不提供 T8 节点。
- 出处在 [`T8mars/comfyui-minimax-h3-audio-T8`](https://github.com/T8mars/comfyui-minimax-h3-audio-T8)，
  ComfyUI 节点索引里这些类的归属就是它（[Multi-Rate Sampler](https://comfy.icu/node/MiniMaxH3MultiRateSamplerEXPT8)、[AV Decode](https://comfy.icu/node/MiniMaxH3AVDecodeT8)）。

**两种出路，二选一：**

- A. 装 T8 包（最省事，与上游模板严格对齐）：
  `git clone https://github.com/T8mars/comfyui-minimax-h3-audio-T8` 到 `ComfyUI\custom_nodes\`，重启 ComfyUI。
- B. 用你自己的工作流：在 ComfyUI 里搭好（用 Easy 包也行），**导出 API 格式 JSON**，把它当模板。
  目前模板是注册表里写死的，B 需要我再加一个「自定义模板」入口（见下节）。

**2）模型文件名不一致（已自动处理）**

| 模板里写的 | 本机实际装的 |
|---|---|
| `minimax_h3_fl2va_int8_convrot.safetensors` | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` |
| `minimax_h3_video_vae_fp16.safetensors` | 一致 |
| `minimax_h3_audio_vae_fp32.safetensors` | 一致 |

插件在提交前会拿 ComfyUI 的 `/object_info` 对账（`src/host/comfyui/modelResolver.ts`）：
去掉量化/打包后缀（`int8`/`nvfp4`/`awq`/`pruned`/`convrot`/`fp8`…）后核心名相同且候选唯一 → **自动替换**并在响应里回 `resolvedModels`；
否则回 409 + `COMFY_NODE_MISSING` / `COMFY_MODEL_MISSING`，并把本机相近的候选名列出来 —— 不会让 ComfyUI 抛一句看不懂的英文。

## 三、需要你做的三件事（真机验证清单）

1. **启动 ComfyUI**（绘世启动器），确认 `http://127.0.0.1:8188/system_stats` 能打开；
2. **重启 DeepSeek Harness**（host 半改了，要重新组装 profile；只改 client 半才不用重启）；
3. 页面里点开侧边栏「无限画布」→ 新建/打开项目 → 放一个 **ComfyUI(MiniMax H3)** 节点 + 一个文本节点并连线 → 点生成。

**自己带工作流（v1.16 起可以不用手写 meta.json）**：

```
左栏第三个按钮「ComfyUI 工作流配置」
  → 左下角「工作流目录」填自己的目录（v1.18，绝对路径；不存在会自动新建，点「默认」回默认目录），
     然后把 Export (API) 的 JSON 丢进去，点「重新扫描」
  → 左边选一个工作流
  → 右边在「全部候选字段」里勾要长到画布节点上的参数（勾中的写进 <名字>.meta.json 的 bindings，
     取消勾选的写 null；可以顺手起中文标签）
  → 改「画布节点名称」（= 这个工作流在画布上的标题）
  → 「保存配置」只写配置；「直接添加到画布」= 先保存再往画布正中落一个节点
```

接口：`GET /api/comfy/workflow-config`（清单）、`GET /api/comfy/workflow-config/<id>`（候选字段）、
`POST /api/comfy/workflow-config/<id>`（保存）、`GET/POST /api/comfy/workflow-config-dir`（当前目录 / 改目录，
v1.18；落盘在 `$DSH_HOME/storages/dsh-aifisher-canvas/workflow-dir.json`，不写进被选目录）。
参考图里「试运行 / 输出结果」两步没有移植 —— 试运行就是画布节点上点「生成」。

**v1.20 起补的两件事**（同一天用户报障「字符串节点当提示词被当成不需要提示词」「切 lora 要手打文字」）：

- **提示词写在字符串节点上也能认出来**：`PrimitiveStringMultiline(value="正面提示词") → CLIPTextEncode.text`
  这种接法，推断会沿 `text` 输入往上游找字符串生产者（`PrimitiveString*` / `String` / `Textbox` / 拼接），
  把提示词写进它的 `value`。画布节点上于是有提示词框 + 可接文本节点的 `text` 槽；
  负向提示词看整条链上的标题/类名（「负面提示词」那个节点会被认成负向）。
  老 meta 里绑在同一字段上的别名键（`"value": "70.inputs.value"`）会自动并进 `text` / `negativeText`。
- **参数下拉（自动扫 ComfyUI）**：面板底栏「扫描 ComfyUI」读 `/object_info`，把 `lora_name` / `ckpt_name` /
  `model_name` / `sampler_name` 这些枚举字段在画布节点上变成 `<select>`（候选就是本机装的那些）。
  快照落在 `$DSH_HOME/storages/dsh-aifisher-canvas/comfy-widget-options.json`（5 分钟 TTL），
  ComfyUI 没开时用上次扫到的那份；装了新 lora 之后点一次「扫描 ComfyUI」即可，不用刷新页面。
  接口：`GET /api/comfy/widget-options[?refresh=1]`。
- **画布节点布局**：720 宽、参数改成横跨整宽的两列网格（行高 34 + 12 间距、标签列 108），
  提示词框加高到 132 —— 以前 9 个参数挤在右边一列、节点很高而左半边空着。

**v1.21 起补的三件事**（用户报障「comfui 节点还不能把文本输入接入负面提示词」「生成之后它的图会互相遮盖」）：

- **负向提示词也是文本输入槽**：能力清单里 `template.inputs[1] = { id: 'negativeText', type: 'text' }`
  （紧跟正向槽），所以画布节点左边第二个 `+` 就是负向槽，可以接文本节点；它**不再是参数控件**
  （以前只有一个单行参数框，接不了文本节点）。请求体里仍然是 `negativeText` 这个键。
- **接上文本节点后不显示输入框**：正向/负向各自判断槽上有没有接节点 —— 接了就把输入框换成一行只读的
  「提示词 ← 文本节点：<内容>」，节点高度跟着收；没接就还是输入框（负向值存 `node.negativePrompt`，
  老节点 `comfyParams.negativeText` 里的值会被读回来）。请求体里 `negativeText` 优先取接线的文本。
- **结果图自动整理**：同一个节点连生几张时，结果图按「源节点右侧的网格」找第一个不重叠的格子落位
  （以前每张都落在同一个点，于是四张叠成一张）；多选图片后工具条上还有「折叠」，把这一叠收进最上面那张
  （卡上有「N 张叠图 · 展开」徽章，点一下就摊开）。
- **槽位签名迁移**：节点上记着 `comfySlotIds`，槽位布局一变就按槽位 id 重排 `parentIds` ——
  所以这轮插入负向槽不会把老项目的连线串位。

跑的时候我可以用 `node scripts/verify-live.mjs` 从命令行看：路由是否 200、ComfyUI 是否在线、
诊断通道里画布报了什么错、以及 `/api/aifisher/canvas/status` 的桥接状态。

## 四、还没做（下一批候选）

- 画布云端模型生成的历史遗留：上游走 relay/runninghub/即梦等 provider，需要 API Key，未移植。
- `/library`（资产库）、`/library/workflows`（SKILL 社区/本地预设）、`/workflow-library`（上游那套
  definitions/deployments/binding-sets/attestation 的完整工作流库）—— 本插件用「目录式自定义工作流 +
  左栏的 ComfyUI 工作流配置面板」覆盖了「用我自己的 ComfyUI 工作流」这个诉求，**试运行/输出结果**
  这两步仍然回到画布节点上做。
- agent 的 `workflow-runs` 观测与 `agent/budgets`、`agent/plans`。
