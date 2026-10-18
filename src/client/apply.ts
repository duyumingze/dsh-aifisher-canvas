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
import { CanvasShell } from './CanvasShell';
import { CreativeLibraryPanel } from './library/CreativeLibraryPanel';

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
 * 读一个服务：优先走 `ctx.get(name)`，读不到再退回属性读取。
 *
 * **绝不能直接写 `ctx.layout`**：cordis 的 ctx 是服务代理，读一个没有写进本插件
 * `inject` 的服务属性会当场抛 `cannot get property "layout" without inject`
 * （cordis 4 实测，跟服务有没有提供无关）。这个异常发生在 apply() 里，会把整个
 * client 半打成 failed，DSH 的 web boot 就报：
 *
 *   web boot: 1 entry did not activate
 *   dsh-aifisher-canvas: failed
 *
 * `ctx.get(name)` 按契约返回服务或 undefined，不需要 inject，才是安全的那条路。
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
 * 取 layout 服务。
 *
 * 不把 layout 写进 inject：它是 DSH 内核服务，正常情况下一定在；
 * 但万一宿主没有（老版本/裁剪版），我们宁可「面板照常出现、只是退出按钮不渲染」，
 * 也不要整个插件因为缺服务而不加载。所以走 ctx.get('layout')，拿不到就当没有。
 */
function resolveLayout(ctx: unknown): LayoutLike | null {
  const candidate = readService(ctx, 'layout');
  if (candidate && typeof (candidate as LayoutLike).selectPanel === 'function') {
    return candidate as LayoutLike;
  }
  return null;
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

  // ---- 退出面板：把主区域切回 Conversation（DSH 面板没有内置的返回控件）----
  const layout = resolveLayout(ctx);
  const exitToConversation = () => {
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
      // 免得点一个只会打日志的死按钮。
      return React.createElement(Panel, { ...props, onExit: layout ? exitToConversation : undefined });
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
    withExit(CanvasShell),
  );
  // 会话栏本体：注册进上面声明的子槽位（宿主按 session-maybe 绑定当前会话）。
  registerSlot(CANVAS_CHAT_SLOT, { name: CANVAS_CHAT_SLOT }, CanvasChatDock);

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
