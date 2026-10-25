# 更新日志

> 只记**对外可见的行为变化**与踩过的坑，实现细节看 `git log`。
> 版本从 v1.45 起才有完整记录；更早的按主题合并。

## v1.70.0 — 2026-10-26

**`canvas_control` 表面收敛**

- 枚举 29 → 26：撤掉 `runGeneration` / `media` / `workflow` / `product` 四个「实现只回一句
  『请改用 command』」的动作，新增显式 `action:"command"`（逃生舱）。
- 逃生舱白名单在 `src/host/canvas/commandMapping.ts`：放行 `media` / `workflow` / `product` 等
  不会让 Agent 自己花钱的动作；`runGeneration`、`prepareBudget`、`revokeBudget` 永久拒绝，
  并给出可读理由（审批只在画布 UI）。
- 工具描述 7,657 → 2,710 字符：每个 DSH 会话少付约 1.6k tokens；细节留在契约文档 §2.5 / §2.6。
- 逃生舱下发的动作按 `command.action` 记名，`saved` 三态与 edit 快照同样生效。

**构建与分发**

- host / client 产物开启压缩：`lib/index.js` 1.23MB → 643KB，`lib/client/apply.js` 777KB → 686KB。
- 画布应用缓存策略：带哈希的 chunk 走 `immutable` 长缓存，入口 `canvas-app.js` 改
  `no-cache` + ETag（每次打开只做一次 304，不再重下 2.8MB）。
- 新增 `pnpm build:offline`：不重新 vendor，直接用仓库里已提交的 `vendor/` 构建
  （贡献者与 CI 没有上游源码时用）。
- 新增 CI（类型门禁 + 契约对账 + 离线构建 + 产物契约 + 4 套核心回归）。
- 新增 `pnpm check:contract`：enum / 契约文档 / 逃生舱白名单 / 描述预算 / 版本号，五处机器对账。
- 发布治理补齐：本文件、`CONTRIBUTING.md`、`package.json` 的 description / keywords /
  repository / homepage / license 字段。

## v1.69.0 — 2026-10-25

- `camera`：机身 / 镜头 / 焦段 / 光圈按项目存一套，一次 `apply` 把英文光学描述写进镜头提示词；
  重复 apply 整段替换（幂等），只动 `prompt`。
- `query`：按节点上游/下游/双向邻域（深度 1–3）、关键词、类型、分页取一块，不再整张 `read`。
- `progress`：十阶段创作进度 + 已确认方案，跨会话注入；阶段变了才记 history。
- 品牌换成「渡雨鸣泽」；服务端拼版工具 `tools/contact-sheet`（独立 CLI，不进构建）。

## v1.64–v1.68 — 2026-10-23 ~ 10-25

- 视频节点「历史 N」、截取首/尾帧（事件唤醒 + 轮询、容差 0.5s、空白帧重试）、
  进度条自绘轨道（120ms 节流、松手补发）、远端视频代理透传 `Range`。
- 拖拽素材、@ 节点引用、生成事件推回面板的体验修补。

## v1.63 — 2026-10-23

- 画布助手 P2：`intent` 意图编译器、`review` 质量评估、`crew` 多 agent 任务包、`assetlibrary` 资产库。

## v1.59–v1.61 — 2026-10-21 ~ 10-23

- 画布助手 P1：项目记忆、视觉一致性锚点、主动副驾、长任务编排、分镜板；
  火山方舟（Seedream 图片 + Seedance 2.0 视频）直连。
- v1.58 修「画布助手改完但没落盘」：每次改动后强制保存，回执带 `saved` 三态。

## v1.45–v1.57 — 2026-10-18 ~ 10-20

- 切刀断线、@ 节点、对话提速（一次 edit 完成读+改）、落位避让、`digest` 摘要、
  `recipe` 分镜展开、`preview` 取生成结果、生成事件推送。

## v1.0.0 — 2026-10-18

- 首个可用版本：把 AIFISHER 无限画布装配进 DSH，`canvas_control` 接管画布，
  本地 ComfyUI 与云端通道打通。
