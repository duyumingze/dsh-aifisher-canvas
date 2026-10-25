/**
 * Client 半（浏览器端）
 *
 * 按 DSH 的 slot 契约挂两个面板（每个都要「侧边栏图标 + main 面板」两处）：
 *   sidebar.panellist       ── 全局面板图标：无限画布 / 素材库
 *   main                    ── keyed slot，key 与上面的 id 一一对应
 *
 * 画布面板自 v1.14 起是「画布 + 右侧 DSH 原生会话栏」（CanvasShell）：
 * 右侧栏不是我们自己画的聊天框，而是把内核的会话界面嵌进来 —— 做法是在 `main` 条目的
 * children 里声明一个 `session-maybe` 子槽位（`aifisher-canvas.chat`），再把 CanvasChatDock
 * 注册进去；宿主于是把「当前会话」的标准 props（sessionId / useSession / useConversation /
 * renderFactorySlot）按作用域发给它，dock 再用 renderFactorySlot 渲染 `conversation.content`
 * 工厂的 embedded occurrence。这与 ui-conversation 自己用 `main.conversation` 的做法同构，
 * 细节与硬约束见 src/client/CanvasChatDock.tsx 的文件头。
 *
 * （2026-10-16 移除了第三处 sidebar.footer.action 的「AIFISHER 账号」按钮：
 *  它连的是 identity.work-fisher.com，与用户实际持有的 FisherAI 接口站账号是两套体系。）
 *
 * 三条契约细节（照 DSH 内置的 slot 文档）：
 *   1. sidebar.panellist 的 id 必须与 main 的 key 相同：侧边栏靠这个 id
 *      去 main 里找面板，"选一个不存在的 main 条目会抛错且不切换"；
 *   2. 注册要包在 ctx.slots.inject(slot, cb) 里 —— 宿主没声明这个 slot 时
 *      只是不出现，而不是把插件启动搞崩；
 *   3. `main` 条目的 scope 是 root（拿不到会话绑定），会话必须走自己声明的子槽位，
 *      且子槽位的 scope 要写 `session-maybe`（没有选中会话时也要能渲染）。
 */
import type { Context } from '@deepseek-ai/cordis';
import * as React from 'react';

import { CanvasChatDock, CANVAS_CHAT_SLOT } from './CanvasChatDock';
import type { CanvasSessionActions } from './CanvasChatDock';
import { CanvasShell } from './CanvasShell';
import { CreativeLibraryPanel } from './library/CreativeLibraryPanel';
import {
  CANVAS_NODE_SOURCE,
  CanvasNodeReferenceChip,
  installCanvasNodeReferences,
} from './canvasReferences';

export const name = 'dsh-aifisher-canvas-client';
export const inject = ['slots'];

/** sidebar.panellist 的 id，同时也是 main 的 key。 */
const CANVAS_PANEL_ID = 'aifisher-canvas';
const LIBRARY_PANEL_ID = 'aifisher-library';

/** 只用到 slot 服务的两个方法，写成结构化类型就不必再依赖 ui-slots 的类型包。 */
interface SlotsLike {
  inject(owner: string, callback: () => unknown): unknown;
  register(options: Record<string, unknown>, component: unknown): unknown;
}

/**
 * DSH ui-layout 暴露的跨插件面板动作面（`ctx.layout`）：
 * `selectPanel(null)` = 主区域切回 Conversation（面板的**唯一**显式出口）。
 * 声明成结构化类型，避免对 ui-layout 的类型包产生构建期依赖。
 */
interface LayoutLike {
  selectPanel(panelId: string | null): unknown;
}

/**
 * DSH 会话 / 工作区服务里本插件用到的成员（结构化类型，不对内核包产生构建期依赖）。
 *
 * 为什么是结构化类型而不是 `import type { ISessions } from '@deepseek-ai/...'`：
 * 本插件要兼容 rc 期多个 DSH 版本，而 `sessions.create` / `uiWorkspace.openSession`
 * 这些成员有的在类型面上、有的只在实现类上（ui-workspace 内部就是这么调的）。
 * 这里只声明「调用时会先检查存在性」的那几个方法，缺了就走降级分支。
 */
interface SessionsLike {
  /** 会话列表快照：拿 `current` 与 `byId[id].blank`。 */
  list?: { getSnapshot(): { current?: string; byId?: Record<string, { blank?: boolean }> } };
  /** 把某个会话设为当前（不动主面板）。 */
  open?(id: string): void;
  /** 老版本 DSH 的 `ctx.workspaces` 没有 connectWorkspace 时，最后的兜底是直接建会话。 */
  create?(opts: { workspaceId?: string; cwd?: string }): Promise<string>;
}

interface WorkspacesLike {
  /** 工作区列表快照：拿 items[].sessionIds / recentWorkspaceId。 */
  list?: {
    getSnapshot(): {
      items?: ReadonlyArray<{ workspaceId?: string; sessionIds?: string[] }>;
      recentWorkspaceId?: string;
    };
  };
  /** 连到工作区可复用的空白会话，没有就新建 —— **不导航**（返回 id 由调用方决定怎么开）。 */
  connectWorkspace?(workspaceId: string): Promise<string>;
}

/** `ctx.uiWorkspace`（dsh-client-ui-workspace 的 UiWorkspaceService）里本插件用到的成员。 */
interface UiWorkspaceLike {
  /**
   * DSH 侧边栏点会话走的同一个动作：`replaceMain(…, 'reveal')` —— 保留 mainView、
   * 写选中状态、**并把主面板切回 Conversation**（context 注释见 CanvasChatDock 文件头）。
   */
  openSession?(sessionId: string): void;
  /**
   * 「连到工作区可复用或新建的空白会话」——**不导航**，返回 id 由调用方决定怎么开。
   *
   * 真机（DSH 0.2.1）实测：这个方法在 `ctx.uiWorkspace` 上，**不在 `ctx.workspaces` 上**
   * （0.1.x 的 `IWorkspaces.connectWorkspace` 在 0.2.x 已经没了，只剩运行时内部的
   * `connectBlank`）。所以这里是首选来源，`ctx.workspaces.connectWorkspace` 只作旧版兜底。
   */
  connectWorkspace?(workspaceId: string): Promise<string>;
}

/**
 * 可选服务的解析器（sessions / workspaces / uiWorkspace / layout）。
 *
 * **为什么不能只用 `ctx.get(name)`**（2026-10-21 在 DSH 0.2.1 上真机踩到）：本插件只声明了
 * `inject: ['slots']`，`ctx.get` 在「服务由别的 fiber 提供、且名字没进本插件的依赖声明」时
 * 解析不到 —— 真机探针 `{"sessions":false,"workspaces":false,"uiWorkspace":false}`，
 * 连 `ctx.get('layout')` 都是 undefined（这也是「画布右上角没有退出按钮」的隐藏原因：
 * 老版 DSH 上能拿到，升级后静默失效）。表现就是「＋ 新建会话」只报「没有暴露会话 / 工作区服务」。
 *
 * 正确姿势与本插件 `canvasReferences.ts` 的 @ 节点一致：`ctx.inject([name], cb)` ——
 * 服务就绪时回调把实现记下来，晚于 apply 就绪也没关系（动作/渲染时才解析）。
 * `readService` 仍作兜底：老宿主没有 `ctx.inject` 时退回 `ctx.get` / 属性读取。
 */
function createServiceResolver(ctx: unknown): (name: string) => unknown {
  const resolved = new Map<string, unknown>();
  const context = ctx as {
    inject?: (deps: string[], callback: (sub: unknown) => unknown) => unknown;
  } | null;
  const watch = (name: string) => {
    if (typeof context?.inject !== 'function') return;
    try {
      context.inject([name], (sub) => {
        const value = readService(sub, name);
        if (value === undefined) {
          console.warn(`[aifisher-canvas] 服务 "${name}" 已就绪但读不到实现（inject 回调拿到的不是可用于读服务的 ctx）`);
        }
        if (value !== undefined) resolved.set(name, value);
        // 服务被卸载时把缓存清掉：之后再点按钮会走「不可用」提示，而不是拿一个死对象。
        return () => {
          if (resolved.get(name) === value) resolved.delete(name);
        };
      });
    } catch (error) {
      console.warn(`[aifisher-canvas] 订阅服务 "${name}" 失败：`, error);
    }
  };
  for (const name of ['sessions', 'workspaces', 'uiWorkspace', 'layout']) watch(name);
  return (name: string) => resolved.get(name) ?? readService(ctx, name);
}

/** 动作失败时给用户看的一句话（异常对象只取 message，别把栈糊到界面上）。 */
function reasonText(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return '未知错误';
}

/**
 * 读一个服务：优先走 `ctx.get(name)`，读不到再退回属性读取（只作 `ctx.inject` 的兜底）。
 *
 * **绝不能直接写 `ctx.layout`**：cordis 的 ctx 是服务代理，读一个没有写进本插件
 * `inject` 的服务属性会当场抛 `cannot get property "layout" without inject`
 * （cordis 4 实测，跟服务有没有提供无关）。这个异常发生在 apply() 里，会把整个
 * client 半打成 failed，DSH 的 web boot 就报：
 *
 *   web boot: 1 entry did not activate
 *   dsh-aifisher-canvas: failed
 *
 * 所以属性读取必须包在 try 里；`ctx.get(name)` 只是「老宿主 / 已经 inject 过」时的快路。
 */
function readService(holder: unknown, name: string): unknown {
  const target = holder as { get?: (service: string) => unknown } | undefined;
  if (typeof target?.get === 'function') {
    try {
      const viaGet = target.get(name);
      if (viaGet !== undefined) return viaGet;
    } catch {
      /* 服务解析失败：按「没有这个服务」处理 */
    }
  }
  try {
    return (target as Record<string, unknown> | undefined)?.[name];
  } catch {
    /* cordis 服务代理：未 inject 的服务属性不可读，按没有处理 */
    return undefined;
  }
}

/**
 * 画布内「换会话 / 新建会话但留在画布」的动作（v1.62）。
 *
 * 为什么不能直接调 `ctx.workspaces.startSession()`（侧边栏那个「新会话」按钮走的就是它）：
 * 它最终走 `replaceMain(…, 'reveal')` → **`layout.selectPanel(null)`**，主区域被切回
 * Conversation，画布面板整个卸载 —— 用户看到的就是「一开新对话就退出画布」。
 * 点侧边栏任意会话也是同一条路（`uiWorkspace.openSession`）。这条路对 DSH 是对的：
 * 从侧边栏点会话，主区当然该显示会话。所以本插件不劫持它，而是在画布侧栏里给出
 * 等价的切换动作，并且**只在这条线里**把主面板留在画布：
 *
 *   - 有 `uiWorkspace.openSession`（DSH 侧边栏点会话的同一个方法）→ 调它（mainView 保留、
 *     左栏高亮、持久化全部与原生一致），**紧接着同一个 tick 内** `selectPanel('aifisher-canvas')`
 *     把画布拉回来。两次 store 写入在同一 tick 内完成，React 只提交最终状态：
 *     既不闪烁，画布（含视口）也不重挂。这是**唯一**能让 DSH 侧边栏状态与画布侧栏
 *     保持一致的做法 —— 只调 `sessions.open()` 的话，DSH 自己的 mainView 会滞后一个会话，
 *     之后从画布退到 Conversation 时左栏高亮会指错行。
 *   - 没有 `uiWorkspace`（老版本 DSH）→ 退 `ctx.sessions.open(id)`：只换当前会话，
 *     连主面板都不碰，画布自然留在原地（代价是上面说的 mainView 滞后，可接受）。
 *
 * 新建会话则先 `uiWorkspace.connectWorkspace(workspaceId)`（**明确不导航**，它会复用同工作区
 * 已有的空白会话；DSH 0.2.x 上这个入口在 uiWorkspace 上，不在 ctx.workspaces 上），拿到 id
 * 再走上面那条导航 —— 这样既不会出现「先切走再切回来的空档」，也不会像 `startSession()`
 * 那样把 `selectPanel(null)` 放在 await 之后。
 *
 * 所有失败都回 `{ ok:false, message }` 而不是抛：槽位条目里的异常会被内核错误边界吃掉，
 * 用户只看到死格子，既没有原因也没法重试。
 */
function createSessionActions(resolveService: (name: string) => unknown, keepCanvasPanel: () => void): CanvasSessionActions {
  const sessions = () => resolveService('sessions') as SessionsLike | undefined;
  const workspaces = () => resolveService('workspaces') as WorkspacesLike | undefined;
  const uiWorkspace = () => resolveService('uiWorkspace') as UiWorkspaceLike | undefined;

  /**
   * 切到某个会话，并保证动作结束时画布还是激活面板。
   *
   * 顺序不能反：`openSession` 内部自己会 `selectPanel(null)`，所以「拉回画布」必须跟在它
   * **后面**、且仍在同一个 tick 里（不要 await / setTimeout，否则用户会看到画布闪一下）。
   */
  const navigate = (sessionId: string): void => {
    const ui = uiWorkspace();
    if (ui && typeof ui.openSession === 'function') {
      ui.openSession(sessionId);
      keepCanvasPanel();
      return;
    }
    const service = sessions();
    if (!service || typeof service.open !== 'function') {
      throw new Error('当前 DSH 没有暴露会话导航（sessions.open / uiWorkspace.openSession）');
    }
    // 只换当前会话：主面板不动，画布本来就还在。
    service.open(sessionId);
  };

  return {
    open(sessionId: string) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, message: '会话 id 为空，无法切换' };
      }
      try {
        navigate(sessionId);
        return { ok: true, sessionId };
      } catch (reason) {
        return { ok: false, message: `切换会话失败：${reasonText(reason)}` };
      }
    },

    async create() {
      const service = sessions();
      const workspaceService = workspaces();
      const ui = uiWorkspace();
      /**
       * 拿「未命名空白会话」的入口，按宿主版本择优（真机 0.2.1：只有 uiWorkspace 上那个）：
       *   ① `uiWorkspace.connectWorkspace` —— 0.2.x，复用/新建工作区空白会话，不导航；
       *   ② `workspaces.connectWorkspace`   —— 0.1.x 的公开契约，同样不导航；
       *   ③ `sessions.create({ workspaceId })` —— 两个都没有时的最后兜底（一定新建，不复用）。
       */
      const connectWorkspace =
        typeof ui?.connectWorkspace === 'function'
          ? (workspaceId: string) => ui.connectWorkspace!(workspaceId)
          : typeof workspaceService?.connectWorkspace === 'function'
            ? (workspaceId: string) => workspaceService.connectWorkspace!(workspaceId)
            : typeof service?.create === 'function'
              ? (workspaceId: string) => service.create!({ workspaceId })
              : undefined;
      if (!service?.list || !workspaceService?.list || connectWorkspace === undefined) {
        // 真机排查入口：服务拿不到时把「到底缺哪一段」打出来（用户看到的仍是人话一句）。
        const probe = {
          sessions: Boolean(service),
          sessionsList: Boolean(service?.list),
          workspaces: Boolean(workspaceService),
          workspacesList: Boolean(workspaceService?.list),
          workspacesConnect: typeof workspaceService?.connectWorkspace,
          uiWorkspace: Boolean(ui),
          uiWorkspaceConnect: typeof ui?.connectWorkspace,
          sessionsCreate: typeof service?.create,
        };
        console.warn(`[aifisher-canvas] 画布内新建会话不可用，服务探测：${JSON.stringify(probe)}`);
        return { ok: false, message: '当前 DSH 没有暴露会话 / 工作区服务，无法在画布内新建会话；请在左侧栏新建。' };
      }

      const list = service.list.getSnapshot();
      const current = typeof list?.current === 'string' ? list.current : undefined;
      const currentRow = current === undefined ? undefined : list?.byId?.[current];
      // 当前已经是空白会话：它本身就是「新会话」，再建一个只会让左栏多一条重复的空行。
      if (current !== undefined && currentRow?.blank === true) {
        try {
          navigate(current);
          return { ok: true, sessionId: current };
        } catch (reason) {
          return { ok: false, message: `打开当前会话失败：${reasonText(reason)}` };
        }
      }

      // 目标工作区按 DSH 自己的口径找：当前会话所属工作区 → 最近活跃工作区 → 第一个。
      const workspace = workspaceService.list.getSnapshot();
      const items = Array.isArray(workspace?.items) ? workspace.items : [];
      const workspaceId =
        (current === undefined
          ? undefined
          : items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(current))?.workspaceId) ??
        workspace?.recentWorkspaceId ??
        items[0]?.workspaceId;
      if (workspaceId === undefined) {
        return { ok: false, message: '还没有工作区：先在左侧栏新建一个工作区，再回来开新会话。' };
      }

      let sessionId: string;
      try {
        sessionId = await connectWorkspace(workspaceId);
      } catch (reason) {
        return { ok: false, message: `新建会话失败：${reasonText(reason)}` };
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, message: '新建会话失败：宿主没有返回会话 id。' };
      }
      try {
        navigate(sessionId);
      } catch (reason) {
        return { ok: false, message: `会话已建好，但切换失败：${reasonText(reason)}` };
      }
      return { ok: true, sessionId };
    },
  };
}

/** sidebar.panellist 吃的是纯图标组件，宿主会传 { size, active }。 */
function makePanelIcon(id: string, path: string) {
  return function PanelIcon({ size = 16 }: { size?: number; active?: boolean }) {
    return React.createElement(
      'svg',
      {
        'data-dsh-panel-entry': id,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      React.createElement('path', { d: path }),
    );
  };
}

/** 画布：一块画板加一条中线。 */
const CanvasPanelIcon = makePanelIcon(CANVAS_PANEL_ID, 'M2.5 3h11v10h-11zM2.5 6h11M6 6v7');
/** 素材库：三个堆叠的格子。 */
const LibraryPanelIcon = makePanelIcon(LIBRARY_PANEL_ID, 'M2.5 3h4.2v4.2H2.5zM9.3 3h4.2v4.2H9.3zM2.5 8.8h4.2V13H2.5zM9.3 8.8h4.2V13H9.3z');

export function apply(ctx: Context & { slots: SlotsLike }) {
  const slots = ctx.slots;
  const disposers: Array<() => void> = [];
  const track = (handle: unknown) => {
    if (typeof handle === 'function') disposers.push(handle as () => void);
  };

  /**
   * 注册一个 slot：失败只报错，不让插件启动失败。
   *
   * slot 契约是宿主的（slot 没声明、id 撞车、优先级打架都会抛错）。这里任何一次注册
   * 失败都降级成「这个位置不出现」+ console.error —— 理由和 readService 那条一样：
   * 一次 slot 注册失败不该把整个 client 半打成 failed 让应用起不来；而 console.error
   * 会被 DSH 的崩溃报告收进去（它只抓 error 级别的 renderer 日志），下次启动能看到原因。
   */
  const registerSlot = (slot: string, options: Record<string, unknown>, component: unknown) => {
    const register = () => {
      try {
        track(slots.register(options, component));
      } catch (error) {
        console.error(`[aifisher-canvas] 注册 slot "${slot}" 失败，这个位置不会出现：`, error);
      }
    };
    try {
      track(slots.inject(slot, register));
    } catch (error) {
      console.error(`[aifisher-canvas] 订阅 slot "${slot}" 失败，这个位置不会出现：`, error);
    }
  };

  /**
   * 服务解析一律走 `ctx.inject` 订阅（见 createServiceResolver 的注释），**不用 `ctx.get`**：
   * 真机（DSH 0.2.1）实测 `ctx.get('sessions' / 'workspaces' / 'uiWorkspace' / 'layout')`
   * 全都解析不到，只有 inject 拿得到。所以 layout 也必须是**懒解析**——
   * apply 阶段服务可能还没就绪，点击/渲染时再取。
   */
  const resolveService = createServiceResolver(ctx);
  const layoutOf = (): LayoutLike | null => {
    const candidate = resolveService('layout');
    return candidate && typeof (candidate as LayoutLike).selectPanel === 'function' ? (candidate as LayoutLike) : null;
  };

  // ---- 退出面板：把主区域切回 Conversation（DSH 面板没有内置的返回控件）----
  const exitToConversation = () => {
    const layout = layoutOf();
    if (!layout) {
      console.warn('[aifisher-canvas] 找不到 DSH layout 服务，无法退出面板；可在侧边栏点其它面板。');
      return;
    }
    try {
      layout.selectPanel(null);
    } catch (error) {
      console.error('[aifisher-canvas] 退出面板失败', error);
    }
  };

  /**
   * 把 onExit 作为 prop 传给面板组件（slot 注册本身不接受自定义 props）。
   *
   * 注意**必须把宿主发来的标准 props 原样转发**：`renderSlot` / `renderFactorySlot` 这些
   * 是宿主按条目发的（画布面板要用 renderSlot 渲染会话子槽位），吞掉它们会让会话栏永远空着。
   */
  const withExit = (Panel: (props: { onExit?: () => void }) => React.ReactNode) =>
    function PanelWithExit(props: { onExit?: () => void } & Record<string, unknown>) {
      // 宿主真的没有 layout 服务时干脆不给 onExit：按钮自己就不渲染，
      // 免得点一个只会打日志的死按钮。（渲染时再解析：面板挂载远晚于服务就绪。）
      return React.createElement(Panel, { ...props, onExit: layoutOf() ? exitToConversation : undefined });
    };

  /**
   * 画布面板比其它面板多注入一件事：**会话切换动作**（v1.62，见 createSessionActions）。
   *
   * 动作经 CanvasShell → renderSlot 的 ownerProps 传给会话栏，所以「＋ 新会话 / 点标题换会话」
   * 都在画布里完成，不会像侧边栏那条路一样把主区域切回 Conversation。
   */
  const keepCanvasPanel = () => {
    const layout = layoutOf();
    if (!layout) return;
    try {
      layout.selectPanel(CANVAS_PANEL_ID);
    } catch (error) {
      console.error('[aifisher-canvas] 切回画布面板失败（会话已切换，画布可能需要手动点一下侧边栏）', error);
    }
  };
  const sessionActions = createSessionActions(resolveService, keepCanvasPanel);

  const withSessionActions = (
    Panel: (props: { onExit?: () => void; sessionActions?: CanvasSessionActions }) => React.ReactNode,
  ) =>
    function PanelWithSessionActions(props: { onExit?: () => void } & Record<string, unknown>) {
      return React.createElement(Panel, {
        ...props,
        onExit: layoutOf() ? exitToConversation : undefined,
        sessionActions,
      });
    };

  // ---- 无限画布：侧边栏图标 + main 面板（画布 + 右侧 DSH 原生会话栏） ----
  registerSlot(
    'sidebar.panellist',
    { name: 'sidebar.panellist', id: CANVAS_PANEL_ID, order: 10, label: '无限画布' },
    CanvasPanelIcon,
  );
  registerSlot(
    'main',
    {
      name: 'main',
      key: CANVAS_PANEL_ID,
      /**
       * 会话子槽位：**scope 必须是 session-maybe**。
       * `main` 自己是 root 作用域（宿主文档：非 conversation 的 key 不绑定会话），
       * 只有把自己声明的子槽位写成 session-maybe，宿主才会把「当前会话（可能没有）」
       * 的标准 props 发给该槽位的条目 —— 这是内嵌原生会话的前提。
       */
      children: { [CANVAS_CHAT_SLOT]: { kind: 'single', scope: 'session-maybe' } },
    },
    withSessionActions(CanvasShell),
  );
  // 会话栏本体：注册进上面声明的子槽位（宿主按 session-maybe 绑定当前会话）。
  registerSlot(CANVAS_CHAT_SLOT, { name: CANVAS_CHAT_SLOT }, CanvasChatDock);

  // ---- 画布节点 @ 引用（v1.51）：候选来源 + 已发送消息里的 chip ----
  // 两个都 fail-open：没有 inputTriggers / uiConversation 时只是少一组 @ 候选，
  // 画布面板与对话照常工作（installCanvasNodeReferences 内部自己吞异常）。
  installCanvasNodeReferences(ctx);
  registerSlot(
    'conversation.user.text.node',
    { name: 'conversation.user.text.node', key: CANVAS_NODE_SOURCE, priority: 100 },
    CanvasNodeReferenceChip,
  );

  // ---- 素材库：侧边栏图标 + main 面板 ----
  registerSlot(
    'sidebar.panellist',
    { name: 'sidebar.panellist', id: LIBRARY_PANEL_ID, order: 11, label: '素材库' },
    LibraryPanelIcon,
  );
  registerSlot('main', { name: 'main', key: LIBRARY_PANEL_ID }, withExit(CreativeLibraryPanel));

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 卸载阶段忽略单个注册的释放失败 */
      }
    }
  };
}
