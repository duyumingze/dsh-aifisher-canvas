# DSH 浏览器插件 ↔ Node 插件通信 API 调研报告

对象：`E:\开源项目\dsh-aifisher-canvas`。证据源：`D:\Program Files\DSH\resources\app.asar`（内部前缀 `/dsh/`）。asar 内**无 `.d.ts`**；`lib/types/*.js` 是 tsc 产物（保留 JSDoc），本文当类型声明原文引用。提取物见 `.dsh-tmp/x/`。

## 1. 浏览器模块表（`window.__ModuleLoader__`）

### 结论

外壳注入一张**冻结的 9 项种子表**，只有这些名字能直接 `require()`：

```js
function platformModules() {
  return {
    "react": React,                        // 18.3.1
    "react/jsx-runtime": JsxRuntime,       // 18.3.1
    "react-dom": ReactDOM,                 // 18.3.1
    "react-dom/client": ReactDOMClient,    // createRoot
    "@deepseek-ai/cordis": Cordis,
    "@deepseek-ai/dsh-client-store": ClientStore,
    "@deepseek-ai/dsh-client-ui-slots": UiSlots,
    "@deepseek-ai/dsh-client-ui-primitives": UiPrimitives,
    "@deepseek-ai/dsh-client-ui-dockkit": UiDockkit,
  };
}
```

- **React = 18.3.1**（不是 19）；`react-dom`、`react/jsx-runtime`、`react-dom/client` **都提供**。
- `@deepseek-ai/dsh-client-runtime`（本仓库 package.json 的 optional peerDep）**在 DSH 里根本不存在**（`asar-list` 匹配 0 条），不要依赖。
- 跨插件 require 走启动图 row；解析顺序 = 种子表 → 已物化记录 → 已注册 factory（其他插件 bundle）→ 启动图 row，全落空即抛 `client-modules: require("x") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`。

```ts
// 可照抄
import * as React from 'react';                // → 18.3.1
import { createRoot } from 'react-dom/client'; // 可用
```

`react` / `react/jsx-runtime` 构建保持 external（`tsdown.config.ts` 已正确）；**不要**写进 `dsh.client.external`——external 只列「基座之外、由其他 row 提供」的请求。

### 证据

| 内容 | 路径:行 |
|---|---|
| 种子表 `function rM(){return{react:Ef,"react/jsx-runtime":If,"react-dom":Rf,"react-dom/client":Df,"@deepseek-ai/cordis":sf,"@deepseek-ai/dsh-client-store":lh,"@deepseek-ai/dsh-client-ui-slots":hh,"@deepseek-ai/dsh-client-ui-primitives":sE,"@deepseek-ai/dsh-client-ui-dockkit":XS}}` | `/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js:126` |
| 外壳注入 `o.create({boot:n.__DSH_BOOT__,staticModules:rM(),...})`；版本串 `version="18.3.1"`（react / react-dom 段） | 同上（偏移 ≈630925） |
| 种子表落地 `this.seed=new Map(Object.entries(options.staticModules))`；解析顺序与失败文案 | `.../dsh-client-modules/lib/client.js:548`、`:697-706` |
| `__ModuleLoader__` 队列 facade（`load` 入队 / `create()` 物化 modules bundle）；`dsh.client` 声明校验（`platform`/`inject`/`external`/`immediately`） | `.../dsh-client-modules/lib/index.js:453-498`、`:61-75` |

## 2. client 调 host：`ctx.remote` 与 `ctx.connection.rpc`

### 2.1 `ctx.remote.<namespace>.<method>(...)` —— 官方 Typert 远程调用

`ctx.remote` 由 API Gateway client 半提供（`new ClientRemoteService(ctx)` → `super(ctx,'remote')`）；client 面（`lib/types/client/index.js` 原文）：

```ts
class ClientRemoteService extends Service {
  get $host(): { home?: string; isLoopback: boolean }
  $on(event, listener): () => void            // 见 §3(a)
  $stream(options): RemoteStream
  $mount(contribution: RemoteContribution): Promise<() => void>   // 装配生成的 /remote 产物
}
// 返回信封，不抛异常：type RemoteResult<T> = { ok:true; value:T } | { ok:false; error: RemoteError }
```

真实第一方调用（照抄形状）：

```ts
// /dsh/node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js:1069
const result = await ctx.remote.commands.execute(session.sessionId, line, attachments);
if (!result.ok) throw result.error;
return result.value;
```

- 依赖声明 `export const inject = ['remote']`（可细化：`inject: ["remote", "remote.session"]`，见 `dsh-client-ui-open-in-app/lib/client.js`）。
- 底层 wire：`.../dsh-api-gateway/lib/types/client/index.js:269-298` → `await connection.rpc.call('/api', endpoint, { args: prepared.args }, signal)`。
- **新增自定义远程方法必须走 Typert 生成（`$mount` 装 contribution）**，构建链重；轻量替代见 2.2。

### 2.2 `ctx.connection.rpc.handle()` / `.call()` —— 无生成步骤的通用通道（推荐）

```ts
// host 半：/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:572-584
get rpc() {
  const owner = this.ctx;
  return {
    handle: (channel, handler) => this.register(owner, channel, handler),
    intercept: (channel, matches, handler) => this.registerInterceptor(owner, channel, matches, handler),
  };
}
get fetch() { return { register: (route) => this.registerFetchRoute(owner, route) }; }
```

- `channel` 匹配 `/^\/[A-Za-z0-9._~-]+$/` 且不能是 `/api`；`endpoint` 段匹配 `/^[A-Za-z0-9_$.-]+$/`。
- 注册后挂一条 webserver **prefix route**，**每个请求先过 `this.admit(req)`**（Host/Origin fence + 浏览器 cookie，失败 401/403）。
- handler 签名 `handler(endpoint, payload, signal, peer)`，返回 `{ok:true,value}` 或 `{ok:false,error:{code,message,details}}`（`.../lib/index.js:640-701`）。

```ts
// host —— 照抄
ctx.inject(['connection'], (c) => {
  c.connection.rpc.handle('/aifisher-canvas', async (endpoint, payload, signal, peer) => {
    if (endpoint === 'ping') return { ok: true, value: { pong: true, at: Date.now() } };
    if (endpoint === 'result') return { ok: true, value: { accepted: settle(payload.requestId, payload.value) } };
    return { ok: false, error: { code: 'aifisher/unknown-endpoint', message: endpoint, details: {} } };
  });
});

// client —— 等价于 POST /aifisher-canvas/ping
const result = await ctx.connection.rpc.call('/aifisher-canvas', 'ping', { sessionId });
if (!result.ok) throw new Error(result.error.message);
```

实际 wire（`.../dsh-client-connection/lib/client.js:1212-1232`）：`send(`${channel}/${endpoint}`.slice(1), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({type:'client-request', rpcId, method: endpoint, payload}), signal })` —— 相对 URL、同源 cookie、无自定义 header，返回前校验 `rpcId`。client 侧 `ctx.connection` 面（`.../dsh-cordis-client-runner/lib/client.js:1782` 声明原文）：

```ts
export interface ConnectionHandle {
    readonly isLoopback: boolean;
    readonly generation: ConnectionGenerationState;
    readonly state: ConnectionStateSource;
    readonly rpc: ClientConnectionRpc;
    reconnect(): void;
    registerGenerationSource(source: ConnectionGenerationSource): () => void;
    start(sinks: ConnectionSinks, config?: ConnectionRecoveryConfig): ConnectionLoop;
}
```

## 3. 反向通道：host 推给 client

### (a) `ctx.remote.$on(event, listener)` —— 只对编译期白名单有效（**插件加不进去**）

27 条固定名单（`API_REMOTE_FORWARDED_EVENTS`）：`agent-preset/selected`、`approval/request`(waterfall)、`api-session/added|removed|status|activity|error`、`commands/change`、`credentials/record-updated|reference-updated`、`goal/activation-changed`、`cordis/request-run|request-run-resolved|dynamic-package|dynamic-retract|inspect-query|inspect-query-resolved`、`llm/adapters-updated`、`permission-presets/catalog-changed`、`plugin-manager/changed|install-log|install-state`、`settings/document-updated`、`schedule/changed`、`user-questions/request`(waterfall)。证据：`.../dsh-api-remotes/lib/types/remote-events.js` 全文；消费示例 `.../dsh-api-session-controller/lib/client.js:3612-3627`。

### (b) session projection —— 官方「host 状态 → client 订阅」机制（带 schema 校验）

```ts
// host；方法签名取自 /dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:2087-2120
ctx.sessionProjections.register<K, S>(definition: {
  key: K;
  stateSchema; stateVersion: number;
  init(header, inheritedEventCount): S;
  apply(state: S, event): S;                 // 必须同步；无关事件返回同一引用（Object.is 闸门）
  wire: { viewSchema; view(state: S): V };   // wire 块 = 暴露给 client 的视图
}): () => void
// 另有 snapshot(session, keys?) -> { asOfSeq, values } / onChanged(listener) / stateOf(session, key)
```

client 三条读取路径：① session 作用域 slot 的 selector 钩子 **`useProjection(key, selector?)`**（`const plan = useProjection("plan", (p) => p?.active)`，`.../dsh-client-ui-conversation/lib/client.js:17240`）；② 服务层 `ctx.sessions.get(sessionId).projections`（`ProjectionValueStore`：`values()` / `faceOf(key)`（useSyncExternalStore 面）/ `seqOf(key)` / `subscribeAny(fn)`，`.../dsh-api-session-controller/lib/client.js:929-1050`）；③ 帧落地 `handleControlFrame` → `projectionStore(frame.sessionId).apply(frame.key, frame.value, seq)`，整块基线 `replaceControlBaseline(baseline.projections)`（同文件 `:2805-2823`），一次性拉取 `await this.remote.session.projections({ sessionId }, signal)`（`:2557`）。
证据与语义：`dsh-session-projection/README.zh.md:36-64`。**限制**：projection 逐会话，只能在 session-scope slot 读；`main`（root scope）没有 `useProjection`（见 §5）。

### (c) 自定义推送：第一方 SSE 实例（唯一能承载任意数据的官方机制）

```js
// host: /dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js（EVENTS_ENDPOINT = "/plugins/events"）
const connect = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
  res.write(": connected\n\n");
  connections.add(res);
  res.write(sseData({ type: "graph", graph: ctx.clientModules.graph() }));
  res.on("close", () => { connections.delete(res); });
};
ctx.effect(() => {
  const disposeRoute = ctx.webServer.register({ kind: "exact", path: "/plugins/events", handler: (req, res) => connect(res) });
  return () => { disposeRoute(); for (const res of connections) res.destroy(); connections.clear(); };
}, "client-hmr: /plugins/events channel");
// client 消费：new EventSource("/plugins/events")  → .../dsh-client-hmr/lib/client.js:64
```

### (d) client 侧现成可订阅 store（无需新增推送）

`ctx.sessions.list`（`getSnapshot()`/`subscribe()`）、`ctx.sessions.retainInfo(id)`、`ctx.layout.panelInfo`、`ctx.uiSession`（`ctx.uiSession.current` 是当前会话 binding 的 bare snapshot source，`.../dsh-client-ui-session/lib/client.js:279-298`）。

## 4. `webServer.registerUpgrade`

```ts
// 类型与签名：api-catalog.js:7887 / :3434
export interface WebUpgradeRoute {
    path: string;   // 精确 pathname；重复注册抛错
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
// ctx.webServer.registerUpgrade(route: WebUpgradeRoute): () => void
```

实现 `/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:191-197`（`if (this.upgrades.has(route.path)) throw new Error('webserver: duplicate upgrade route ...')`）；升级表**只做精确匹配**，未命中直接关连接（`README.zh.md:45`）；`WebRoute` 对照声明 `api-catalog.js:7847`。**webserver 自身不做任何鉴权**（README：「不提供服务器级 TLS、认证或来源策略」）。

```ts
// 第一方真实用例（含鉴权）：/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/index.js:86-103
ctx.inject(['connection', 'webServer'], (webCtx) => {
  const mux = new RemoteStreamMuxServer(...);
  webCtx.effect(function* () {
    yield () => mux.close();
    yield webCtx.webServer.registerUpgrade({
      path: '/api/remote.mux',
      handler: (req, socket, head) => {
        const admission = webCtx.connection.admit(req);            // ← cookie + Host/Origin 鉴权
        if ('rejection' in admission) { rejectRemoteStreamUpgrade(socket, admission.rejection); return; }
        mux.handleUpgrade(req, socket, head, admission.peer);
      },
    });
  }, 'api-gateway: /api/remote.mux WebSocket');
});
```

**client 端可以直接 `new WebSocket('ws://127.0.0.1:19387/<自定义路径>')`** —— DSH 自己就这么连（`.../dsh-api-gateway/lib/types/client/stream-client.js:441-449` 的 `remoteStreamUrl()` + `:200` 的 `new WebSocket(remoteStreamUrl())`）：

```ts
const base = (globalThis as any).__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
const url = new URL('aifisher-canvas/bridge', base);
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(url.href);   // 同源握手浏览器自动带 HttpOnly cookie
```

注意：DSH 自带 `ws@8.22.0`（`/dsh/node_modules/ws/package.json`），但它在 app.asar 里，**不在你插件的解析路径上**——host 半要用 `WebSocketServer` 得自己 `pnpm add ws@^8`（本仓库 `node_modules/ws` 不存在）。

## 5. 当前会话 id / agent 上下文 / host↔页面配对

### 5.1 取决于 slot 作用域

- **session 作用域** slot（`scope:"session" | "session-maybe"`）的 framework props **直接带** `sessionId: SessionId`、`useSession: SessionSnapshotSelector`、`useConversation`、`useProjection: UseProjection`、`useInput`、`inputActions`、`useChat`（`.../dsh-cordis-client-runner/lib/client.js:2373-2389`）。
- **`main` 是 `scope:"root"`**（本插件画布面板就挂这里），props 只有 `useResource / useWorkspaces / usePanelInfo / useSessions / useSessionStatus / useSessionRetainInfo` —— **没有 `sessionId`，也没有 `useProjection`**（同文件 `:3883-3918`，含官方 example 与 `source: packages/client/ui-layout/src/client/index.ts:73`）。

```ts
// root 作用域取当前会话的官方惯用法
// /dsh/node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js:769-771
const session = Object.values(ctx.sessions.list.getSnapshot().byId)
  .find((row) => (row.retainedBy.mainView ?? 0) > 0);
// 组件内响应式写法：/dsh-client-ui-layout/lib/client.js:60
const currentId = useSessions((state) => Object.values(state.byId)
  .find((s) => (s.retainedBy.mainView ?? 0) > 0)?.id);

// 画布面板是否在前台 / 切换（.../dsh-client-ui-layout/lib/client.js:388-410, :463）
const active = ctx.layout.panelInfo.getSnapshot().activePanelId;  // 'aifisher-canvas' | null(=会话视图) | 其它
ctx.layout.selectPanel('aifisher-canvas');
ctx.layout.selectPanel(null);
```

同语义服务实现：`.../dsh-client-ui-session/lib/client.js:279-298`（`publishMain()`）、`:340`（`isMain`）；root 作用域真实调用 `.../dsh-client-ui-open-in-app/lib/client.js:770`、`.../dsh-client-ui-sidebar/lib/client.js:480`。

### 5.2 host 工具侧知道调用它的会话

```ts
// api-catalog.js:7531 / 7619 / 7543 / 7551 / 4395
export interface ToolDefinition { execute(args: unknown, exec: ToolRunContext): Promise<unknown>; /* … */ }
export interface ToolRunContext extends ToolExecution { deferContext(c): void; concludeTurn(): void }
export interface ToolExecutionInput {
  readonly callId: ToolCallId; readonly name: string; readonly arguments: unknown;
  readonly agent?: Agent; readonly signal: AbortSignal;
}
export interface Agent { readonly id: SessionId }   // 实际写法：agent.session.id（.../dsh-agent/lib/index.js:512）
```

### 5.3 官方推荐的配对方式 = sessionId 对齐

DSH **没有**「当前打开的页面」全局注册表：`retainedBy.mainView` 是**纯客户端**概念（计数在 client 的 sessions 服务内维护，`.../dsh-api-session-controller/lib/types/client/sessions/service.js:419-449`），host 看不到。所以配对只能是：client 上报 `sessionId`（slot props 或 `retainedBy.mainView`）→ host 维护 `Map<sessionId, connection>` → 工具里用 `exec.agent?.session.id` 命中同 id 连接，否则回退「最近活跃连接」，都没有就返回 `{ ok:false, code:'NO_OPEN_PAGE' }`。

## 6. client 直接 `fetch('/api/...')` 与鉴权

### 结论

1. **可以同源 fetch**，但 `/api` 不是随便挂的：`/api` 前缀 route 由 `dsh-client-connection` 独占，只应答两类路径——(i) `ctx.connection.fetch.register({path:'/api/...'})` 注册的 exact Fetch route，(ii) Typert Gateway interceptor 端点；其余 **404**（`.../dsh-client-connection/lib/index.js:608-624`）。
2. **走 `/api` 就有鉴权**：`/api` route 先 `connection.admit(req)`（Host/Origin fence + 浏览器 cookie），失败 401/403（`.../lib/index.js:830-843`）。
3. **没有 token header**。凭据是 `GET /?token=...` 换来的签名 **HttpOnly cookie**（`SameSite=Strict`、host-only）。README 原文：「HTTP 载体不在根路径交换之外接受 query token，也不接受 Authorization header token」。client fetch 不需要也不应加凭证 header：`createWebConnectionRpc` 只设 `content-type`，同源默认 `credentials:'same-origin'` 自动带 cookie。
4. ⚠️ **本仓库现状风险**：`src/host/index.ts` 用 `ctx.webServer.register({kind:'prefix', path:'/api/aifisher/canvas'…})`（以及 `/api/comfy`、`/api/aifisher/skills`、`/api/aifisher/canvas-app`）自挂 `/api/*`（前缀更长所以命中），但 **webserver 不做鉴权**，这些端点实为**无鉴权**（插件自己在路由里加了同源围栏 `rejectCrossOrigin` 挡跨站写操作）；`dsh web --host 0.0.0.0` 时按 README「仍会向该网络公开未受保护的 route」。

```ts
// 带鉴权的写法（照抄）
ctx.inject(['connection'], (c) => {
  c.connection.fetch.register({
    path: '/api/aifisher-canvas/state',        // 必须形如 /api/<segments>
    methods: ['GET', 'POST'],                  // 非空、不重复
    requestBody: () => 'buffered',             // 'buffered' | 'streamed'
    fetch: async (request) => Response.json({ ok: true, at: Date.now() }),
  });
});
// 校验：.../dsh-client-connection/lib/index.js:758-762 assertFetchRoute
// client：const res = await fetch('api/aifisher-canvas/state', { method: 'GET' });  // 相对路径，自动带 cookie
```

## 7. 对 dsh-aifisher-canvas 的建议方案

### 7.1 选型

| 需求 | 方案 | 理由 |
|---|---|---|
| client → host（上报 / 回包 / 查询） | `ctx.connection.rpc.handle('/aifisher-canvas', handler)` + client `ctx.connection.rpc.call(...)` | 零新依赖、复用 `admit` 鉴权、endpoint 自由扩展 |
| host → client（`canvas_control` 推指令） | `ctx.webServer.register({kind:'exact', path:'/aifisher-canvas/events'})` 的 **SSE** | 第一方 `dsh-client-hmr` 同款；零依赖；EventSource 自动重连 |
| 备选：双向低延迟 | `registerUpgrade` + `ws@^8` | 需新增依赖；鉴权同样用 `ctx.connection.admit(req)` |

不要用 Typert `$mount`（需 DSH 构建链生成 contribution），也不要用 `ctx.remote.$on`（事件白名单是本体的编译期常量）。

### 7.2 host 半（新增 `src/host/bridge/canvasBridge.ts`）

```ts
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function createCanvasBridge() {
  const clients = new Map<string, ServerResponse>();   // sessionId → SSE 连接
  const pending = new Map<string, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();
  let lastSessionId: string | undefined;

  /** agent 工具调用：推一条指令给「当前页面」并等回包 */
  const request = (sessionId: string | undefined, payload: any, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const target = sessionId !== undefined && clients.has(sessionId) ? sessionId
        : clients.size === 1 ? [...clients.keys()][0]
        : lastSessionId !== undefined && clients.has(lastSessionId) ? lastSessionId : undefined;
      if (target === undefined) { reject(Object.assign(new Error('NO_OPEN_PAGE'), { code: 'NO_OPEN_PAGE' })); return; }
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Object.assign(new Error('BRIDGE_TIMEOUT'), { code: 'BRIDGE_TIMEOUT' }));
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      clients.get(target)!.write(`data: ${JSON.stringify({ type: 'command', requestId, ...payload })}\n\n`);
    });

  const attach = (ctx: Context) => {
    // 1) SSE：host → client 推送（带 cookie 鉴权，同 /api）
    ctx.webServer.register({
      kind: 'exact',
      path: '/aifisher-canvas/events',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        const admission = (ctx as any).connection?.admit(req);
        if (admission !== undefined && 'rejection' in admission) { res.writeHead(admission.rejection); res.end(); return; }
        const sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId') ?? 'unknown';
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.set(sessionId, res);
        lastSessionId = sessionId;
        req.on('close', () => { if (clients.get(sessionId) === res) clients.delete(sessionId); });
      },
    });
    // 2) 通用 RPC：client → host（回包）
    ctx.inject(['connection'], (c: any) => {
      c.connection.rpc.handle('/aifisher-canvas', async (endpoint: string, payload: any) => {
        if (endpoint !== 'result') return { ok: false, error: { code: 'aifisher/unknown-endpoint', message: endpoint, details: {} } };
        const waiter = pending.get(payload.requestId);
        if (waiter === undefined) return { ok: true, value: { accepted: false } };
        pending.delete(payload.requestId);
        clearTimeout(waiter.timer);
        waiter.resolve(payload.value);
        return { ok: true, value: { accepted: true } };
      });
    });
  };

  return { attach, request, clients };
}
```

```ts
// src/host/index.ts 的工具 execute(args, exec)
async execute(args, exec) {
  const sessionId = (exec as any)?.agent?.session?.id as string | undefined;
  try {
    return { ok: true, result: await bridge.request(sessionId, { action: args.action, args }) };
  } catch (e: any) {
    if (e?.code === 'NO_OPEN_PAGE') return { ok: false, code: 'NO_OPEN_PAGE', message: '画布未打开：请先在侧边栏点开「无限画布」面板。' };
    return { ok: false, code: e?.code ?? 'BRIDGE_FAILED', error: String(e?.message ?? e) };
  }
}
```

### 7.3 client 半（新增 `src/client/bridge/bridge.ts`）

```ts
interface BridgeOptions {
  getSessionId: () => string | undefined;
  onCommand: (msg: any) => Promise<unknown> | unknown;
}

export function installBridge(ctx: any, opts: BridgeOptions) {
  let source: EventSource | undefined;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const base = (globalThis as any).__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
    const url = new URL('aifisher-canvas/events', base);
    url.searchParams.set('sessionId', opts.getSessionId() ?? 'unknown');
    source = new EventSource(url.href);                 // 同源，自动带 HttpOnly cookie
    source.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== 'command') return;
      let value: unknown; let error: string | undefined;
      try { value = await opts.onCommand(msg); } catch (e) { error = String(e); }
      await ctx.connection.rpc.call('/aifisher-canvas', 'result', { requestId: msg.requestId, value, error });
    };
    source.onerror = () => { source?.close(); source = undefined; setTimeout(connect, 1500); };
  };

  connect();
  return () => { closed = true; source?.close(); };
}
```

```tsx
// CanvasPanel.tsx：main 是 root scope，用它拿会话
const sessionId = useSessions((state: any) =>
  Object.values(state.byId).find((s: any) => (s.retainedBy.mainView ?? 0) > 0)?.id);
const panelActive = usePanelInfo((info: any) => info.activePanelId === 'aifisher-canvas');
```

### 7.4 必须同步修的既有问题

1. `src/host/*` 的 `/api/aifisher/*`、`/api/comfy/*` 目前**无鉴权**（`ctx.webServer.register` 裸挂）→ 迁到 `ctx.connection.fetch.register`，或至少 handler 开头 `ctx.connection.admit(req)`。
2. `@deepseek-ai/dsh-client-runtime` 在 DSH 安装包里不存在，别依赖；类型自声明结构化接口（现有 `SlotsLike` 思路正确）。
3. `dsh.client` **不要**把 `react` / `react/jsx-runtime` 写进 `external`（它们在基座种子表里）。
4. React 双版本隔离必须保持：平台 18.3.1 给 `lib/client/apply.js`，画布 app 自带 19 走静态资源动态 import（`tsdown.config.ts` 注释与配置正确，勿合流）。
5. 自定义路径统一走唯一前缀 `/aifisher-canvas/*`，避开 `/plugins/*` 与 `/api`；webserver 同表重复路径会直接抛错。
