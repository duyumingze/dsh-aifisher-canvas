# 画布移植施工图（已实施）

> 这份文件原来是「按 Dependencies 接口逐项分类（REUSE / ADAPT / STUB）」的施工清单。
> 方案在实施中改了：不再逐项手写适配，而是 **整棵 AIFISHER 源码树 vendor 进来**，
> 只写两层薄适配（装配 + Dependencies），详见 README 的「画布移植（v0.6）」一节。
> 结论保留在这里，避免以后重新踩一遍。

## 最终做法（与原始计划的差异）

| 原计划 | 实际做法 | 原因 |
|---|---|---|
| 按 `REUSE_LIST` 挑文件复制 | 复制整棵 `src/`（323 个文件） | 上游 import 图比清单大得多；整树复制最省事，打包器只会打进去真正被引用的部分 |
| 手写 `canvasComponents.ts` 等价物 | **直接用上游那份**，构建期把 three/@react-three/* alias 到 `src/client/canvas/stubs/` | 上游那份 500 行的 `bind()` 依赖注入表是设计好的移植点，改它没有收益 |
| ADAPT_HOOKS 全部先返回空 | 直接用上游 hook，只把生成/结果回收换成空实现 | 上游 HTTP 全部被改写到 `/api/aifisher/canvas/*`，host 侧实现了同契约的本地后端，hook 不需要改 |
| 迭代1「先渲染，后端全 STUB」 | 一次做到「能渲染 + 能保存（本地）」 | 上游保存失败会 5s 无限重试刷请求；不做本地后端反而更乱 |
| 自己实现 host→client 推送 | 复用上游「外部连接」长轮询协议 | 画布侧 `canvasExternalClient` 已实现完整握手与执行链，host 侧照抄端点即可 |

## 两份移植依据（保留了完整证据）

- [`aifisher-bootstrap-analysis.md`](./aifisher-bootstrap-analysis.md)
  —— 上游 `main.ts` 47 个 installer 逐个分级（保 15 / 丢 29）、`window.__FISHERAI_*` 全局读点、
  后端耦合点、deps 哪些能空实现哪些必须真实现。**含一个真崩点的定位**：
  `canvasNodeRules.ts` 的 `?.getNodeSize(node).width` 缺第二个 `?.`（vendor 阶段已修）。
- [`dsh-host-client-bridge.md`](./dsh-host-client-bridge.md)
  —— DSH 浏览器模块表（React 18.3.1）、`ctx.connection.rpc`、SSE、`registerUpgrade`、
  root/session slot 作用域、`/api` 鉴权边界。**结论：模块表只给 9 个种子模块，
  `@deepseek-ai/dsh-client-runtime` 在安装包里并不存在。**

## 仍然成立的注意事项

- client 半的 `main` slot 是 **root 作用域**：拿不到 `sessionId`，也没有 `useProjection`。
- 画布应用必须自带 React（平台是 18，上游要 19），两份 hooks 分发器不能混。
- 上游 CSS 是全局注入的，所以 Tailwind 编译排除 preflight，且 `html,body,#root` 规则被改成 `.af-canvas-mount`。
- 插件裸挂的 `/api/*` 路由没有 DSH 的 cookie/Host 鉴权（webserver 本身不做鉴权），需要自己加围栏。
