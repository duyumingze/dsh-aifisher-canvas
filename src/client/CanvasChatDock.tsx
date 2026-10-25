/**
 * CanvasChatDock —— 画布右侧栏里的**DSH 原生会话**（替代上游那个 canvasAgentPanel）。
 *
 * 用户拍板（2026-10-16）：「画布里的对话面板换成 DSH 原生会话区」。
 *
 * ## 它是怎么嵌进来的（这是本文件存在的全部理由）
 *
 * DSH 的 UI 是一套 slot/Factory 装配面，会话界面本身也是：
 *
 *   main（keyed, root）
 *     └─ key=conversation → ConversationPanel → renderSlot('main.conversation')
 *          └─ ConversationRoot → renderSlot('conversation.header') + renderFactorySlot('conversation.content')
 *               └─ 工厂 conversation.content（scope: session-maybe）
 *                    ├─ 局部槽 views（默认 ConversationSessionView → renderSlot('conversation.session')）
 *                    ├─ 子槽 conversation.composer（链式；InputBar 在这条链上）
 *                    └─ 子槽 conversation.view（list, session；ui-chat 的 ChatView 在这里）
 *
 * 三个契约细节决定了「照抄右侧栏那个 subagent 会话窗」是可行且被支持的：
 *
 *   1. **每个 renderer 创建的组件都能渲染任何 Factory occurrence**
 *      （`standardKit()` 无条件给每个槽位条目发一个 `renderFactorySlot` 绑定，
 *        `boundRenderFactorySlot(caller)` → `FactoryOutlet`，不校验归属）。
 *      所以本组件（注册在画布面板声明的子槽位里）可以直接把整棵会话界面渲染出来。
 *   2. **`conversation.content` 的 scope 是 `session-maybe`，绑定来自继承**：
 *      `createSlotRenderer().renderRoot()` 把整个应用包在 `<ScopeProvider scope="session-maybe">` 里，
 *      这个「当前会话（可能没有）」就是全应用继承的绑定 —— 所以嵌出来的会话＝当前选中的那个会话。
 *      与主区域的对话是**同一个会话、同一份 transcript**，不是另一套聊天记录。
 *   3. `variant: 'embedded'` 是给这种嵌入式 occurrence 用的（上游右侧栏的 subagent 会话窗
 *      与 `ConversationSlotPanel` 就是 `variant:'embedded'` + 把局部 views 固定成 Chat）。
 *      它不渲染主 Header、不带正文宽度拖拽条 —— 正是我们想要的「塞进一栏」的形态。
 *
 * ## 刻意与上游 main occurrence 不同的两处（都写在这里，别再顺手改回去）
 *
 *   - **phase 固定 'active'、hero 固定 false**：hero 那一大坨「探索未至之境 + 工作区选择器」
 *     是给整屏首启用的，塞进 400px 的侧栏只会挤爆；而没有选中会话时我们给的是自己的
 *     一句人话提示（见下），不需要 hero 里的工作区选择器。
 *   - **不传 `slots.views`**：让工厂用自己的默认 adapter（渲染 `conversation.session`），
 *     于是会话里如果注册了别的 View（例如 Trajectory）也能照常切。
 *
 * ## 本栏的会话切换（v1.62，用户 2026-10-21 原话：「我在画布想要新开一个对话的时候它会退出画布，
 * 能不能想个方法能快速切换」）
 *
 * 根因不在画布这边，在 DSH 的**导航语义**里（读 `dsh-client-ui-workspace` 的源码确认）：
 *
 *   - 侧边栏「新会话」→ `uiWorkspace.startSession()` → `openWorkspaceSession()` →
 *     `replaceMain(…, 'reveal')` → **`ctx.layout.selectPanel(null)`**；
 *   - 侧边栏点任意会话 → `uiWorkspace.openSession()` → 同一个 `replaceMain(…, 'reveal')`。
 *
 * `selectPanel(null)` 的语义就是「主区域切回 Conversation」，于是画布面板被卸载 —— 用户看到的就是
 * 「一开新对话就退出画布」。这条语义对 DSH 是对的（从侧边栏点会话，主区当然该显示会话），
 * 所以本插件不改它、也不去劫持全局面板状态；而是在**本栏自己**给出同等的切换能力：
 *
 *   - 标题变成下拉触发器 → 列最近会话（可搜），点一条就切过去；
 *   - 头部的「＋」→ 在当前会话所属工作区里新建/复用空白会话并切过去。
 *
 * 两个动作都不走侧边栏那条「先 selectPanel(null)」的路：`apply.ts` 里注入的 `sessionActions`
 * 用 `uiWorkspace.openSession()`（保持 DSH 自己的 mainView 保留计数、左栏高亮、持久化一致）
 * 之后**同一次点击里立刻把主面板切回画布**（`layout.selectPanel('aifisher-canvas')`）。
 * 两次 store 写入在同一 tick 内完成，React 只提交最终状态 —— 没有「退出又回来」的闪烁，
 * 画布（含视口）也不会重挂。拿不到 `uiWorkspace` 时退回 `ctx.sessions.open()`：只换当前会话，
 * 连面板都不碰，画布照样留在原地（代价是 DSH 的 mainView 会滞后一个会话，见 apply.ts 注释）。
 *
 * ## 依赖降级
 *
 * 宿主没给 `renderFactorySlot` / 没有会话绑定时，本组件只渲染一句提示，绝不抛错
 * （同 apply.ts 的「一次注册失败不该把应用搞崩」原则）。拿不到 `sessionActions` 时
 * 不渲染「＋」、标题也不可点 —— 老版本宿主上就是个纯标题栏。
 *
 * ## 三条布局约定（动这个文件前先看）
 *
 *   1. **正文容器必须是 flex column**：内核会话的 `.body`/`.scrollBody` 靠 `flex:1 1 0%` +
 *      `min-height:0` 建立「有界高度 → 内层溢出 → 内层滚动」，父级不是 flex 容器就整栏滚不动
 *      （详见 `DOCK_LAYOUT_CSS` 的注释与其中的真机测量数据）。
 *   2. **本栏的滚轮不冒泡到 document**：画布那半在 document 上装了 wheel 监听（画布永不滚动），
 *      见 `onDockWheel`。这两条都是「画布右侧会话栏滚轮滚不动」那一轮修出来的。
 *   3. **新对话（空白会话）的输入区贴底**：内核在空白会话里不渲 Views，只剩一个
 *      `flex:none` 的 composerSeat，不补一条 `margin-top:auto` 它会顶在栏头下方
 *      （详见 `COMPOSER_BOTTOM_CSS`；真机 A/B 由 scripts/verify-live-dock.mjs 量）。
 *
 * 只用 React.createElement、不写 JSX：client 半的产物只从 DSH 模块表要 `react` 一个说明符
 * （见 README「产物格式」与 scripts/test-panel-exit.mjs 的断言）。
 */
import * as React from 'react';

/** 本文件的会话槽位名，必须与 apply.ts 里 `main` 面板声明的 children 键一致。 */
export const CANVAS_CHAT_SLOT = 'aifisher-canvas.chat';

/**
 * 会话切换动作的结果。
 *
 * 失败**不抛异常**：槽位条目里的异常会被内核的错误边界吃掉，用户只看到一块死格子
 * （`<div data-slot-error>`），既没有原因也没法重试。所以动作一律回结果，界面就地显示原因。
 */
export type CanvasSessionResult = { ok: true; sessionId?: string } | { ok: false; message: string };

/**
 * 由 apply.ts 注入的会话导航动作（见文件头「本栏的会话切换」）。
 *
 * 两个都保证**不把主区域切走**：画布面板在动作结束后仍是激活面板。
 */
export interface CanvasSessionActions {
  /** 新建（或复用同工作区的空白）会话并切到它，留在画布。 */
  create(): Promise<CanvasSessionResult>;
  /** 切到另一个已有会话，留在画布。 */
  open(sessionId: string): CanvasSessionResult;
}

/** 宿主（renderer）按 session-maybe 作用域注入的标准 props，取我们用到的那几个。 */
export interface CanvasChatDockProps {
  /**
   * 当前会话 id；`undefined` = 应用当前没有选中会话（`session-maybe` 的「maybe」那一支）。
   * blank session 也会有 id。
   */
  sessionId?: string;
  /** 内核的会话快照选择器（`hooks` 里的 `session`）。 */
  useSession?: (selector: (snapshot: any) => any) => any;
  /** 内核的会话外壳状态（`activeTargets` / `inputActions` 那一份）。 */
  useConversation?: (selector: (snapshot: any) => any) => any;
  /** 全局会话列表（拿标题 / blank / 最近时间用）。 */
  useSessions?: (selector: (snapshot: any) => any) => any;
  /** 全局工作区列表（只用来读 `archivedSessionIds`：已归档的不进切换列表）。 */
  useWorkspaces?: (selector: (snapshot: any) => any) => any;
  /** renderer 给的 Factory occurrence 渲染器（见文件头第 1 条）。 */
  renderFactorySlot?: (
    name: string,
    props?: Record<string, unknown>,
    options?: { slots?: Record<string, unknown>; fallback?: unknown },
  ) => React.ReactNode;
  /** 由画布外壳通过 renderSlot 的 ownerProps 传进来：收起右侧栏。 */
  onClose?: () => void;
  /** 由 apply.ts 经画布外壳注入：在画布内换会话 / 新建会话。 */
  sessionActions?: CanvasSessionActions;
}

const DOCK_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  // 会话下拉菜单是绝对定位的（top = 头高），锚点就是本栏根节点。
  position: 'relative',
  background: 'var(--dsw-alias-bg-base, #17181c)',
  color: 'var(--dsw-alias-label-primary, #e7e9ee)',
  font: '13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei UI", sans-serif',
};

const HEAD_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: '0 0 auto',
  height: 36,
  padding: '0 8px 0 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
  color: 'var(--dsw-alias-label-secondary, #a8adb8)',
  fontSize: 12,
};

const BODY_STYLE: React.CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden',
  // `display` 交给 DOCK_LAYOUT_CSS：本栏的正文容器**必须是 flex column**，
  // 否则内核会话的 `.body{flex:1 1 0%}` 失效、整栏滚不动（见那段长注释）。
};

/** 标题即下拉触发器：占满头部剩余宽度，长标题省略。 */
const TRIGGER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flex: '1 1 auto',
  minWidth: 0,
  height: 24,
  padding: '0 4px',
  border: '1px solid transparent',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
  overflow: 'hidden',
};

const TRIGGER_LABEL_STYLE: React.CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** 头部的小方块按钮（＋ / 收起共用一套尺寸语言）。 */
const HEAD_ICON_BUTTON_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  padding: 0,
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
};

const HEAD_ICON_BUTTON_BUSY_STYLE: React.CSSProperties = {
  ...HEAD_ICON_BUTTON_STYLE,
  opacity: 0.5,
  cursor: 'default',
};

const MENU_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 37,
  left: 8,
  right: 8,
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 6,
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
  background: 'var(--dsw-alias-bg-elevated, #1e2026)',
  boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
  maxHeight: 380,
  overflow: 'hidden',
};

const SEARCH_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  height: 26,
  padding: '0 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
  background: 'var(--dsw-alias-bg-base, #17181c)',
  color: 'inherit',
  font: 'inherit',
  outline: 'none',
};

const MENU_LIST_STYLE: React.CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 8px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

const ROW_ACTIVE_STYLE: React.CSSProperties = {
  background: 'rgba(120,170,255,0.16)',
};

const ROW_TITLE_STYLE: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const ROW_TIME_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary, #a8adb8)',
};

const RUNNING_DOT_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  width: 6,
  height: 6,
  borderRadius: 3,
  background: '#4da3ff',
};

const EMPTY_STYLE: React.CSSProperties = {
  padding: '10px 8px',
  color: 'var(--dsw-alias-label-secondary, #a8adb8)',
  fontSize: 12,
};

const ERROR_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  padding: '6px 8px',
  borderRadius: 6,
  background: 'rgba(255,96,96,0.12)',
  color: '#ff9a9a',
  fontSize: 12,
  lineHeight: 1.6,
};

/**
 * 让内核的会话正文**滚在一个有界高度里** —— 这是「画布右侧会话栏滚轮滚不动」的根因补丁
 * （2026-10-16 真机取证）。
 *
 * 内核 `conversation.content` 的 embedded occurrence 自己就是一列 flex：
 *
 *   .body[data-conversation-content]{display:flex;flex-direction:column;flex:1 1 0%;min-height:0}
 *     └─ .scrollBody[data-conversation-scroll]{flex:1 1 0%;min-height:0;overflow-y:auto}
 *
 * 「父级有界高度 → 内层溢出 → 内层滚动」这套链条**要求父级是 flex 容器**：`flex:1 1 0%`
 * 只在 flex 父级里生效。而本文件原来给正文容器写的是默认 `display:block`，于是 `.body`
 * 退化成「高度 = 内容高度」。真机量到的证据（会话栏 420px 宽、正文区 917px 高）：
 *
 *   [data-dsh-aifisher-chat="body"]      display=block  clientHeight=917  scrollHeight=981
 *     └─ .body[data-conversation-content] clientHeight=981  scrollHeight=981   ← 没有溢出
 *          └─ [data-conversation-scroll]   clientHeight=981  scrollHeight=981   ← 滚不动（sh==ch）
 *   往里塞一根 3000px 撑杆再量：scrollBody clientHeight=3768 scrollHeight=3768  ← 它是**长高**，不是溢出
 *
 * 结果就是滚轮无事可做，而且正文底部（连 composer 输入区一起）被 `overflow:hidden` 裁掉 ——
 * 真机量到 composer seat 落在 890~1018，而本栏只到 954。
 *
 * 修法只补这一层 flex 链，内核 CSS 一个字不碰：
 *   ① 正文容器（`data-dsh-aifisher-chat="body"`）成为 flex column；
 *   ② 它下面那层「装着会话的包裹」串上 `flex:1 1 auto; min-height:0`。
 *      本机 DSH 里 `.body` 就是它的直接子元素；`> *:has(...)` 的写法让将来宿主多包一层
 *      槽位锚点时依然成立（`display:contents` 的锚点被这条规则接住也只是变成一个普通盒子）。
 *   ③ **新对话的输入区要贴底**（v1.41，见下面 COMPOSER_BOTTOM_CSS）。
 */
const DOCK_LAYOUT_CSS = [
  '[data-dsh-aifisher-chat="dock"] [data-dsh-aifisher-chat="body"] {',
  '  display: flex;',
  '  flex-direction: column;',
  '}',
  '[data-dsh-aifisher-chat="body"] > *:has([data-conversation-content]) {',
  '  display: flex;',
  '  flex-direction: column;',
  '  flex: 1 1 auto;',
  '  min-height: 0;',
  '}',
].join('\n');

/**
 * ③「新对话输入区贴底」（v1.41，用户 2026-10-18 原话：「右侧聊天面板新对话默认会顶头不好看，
 * 希望移动到最地下」）。
 *
 * 根因（读 DSH 客户端 `dsh-client-ui-conversation` 的骨架确认，不是猜）：
 *   - 会话正文结构是 `[data-conversation-content] > [data-conversation-scroll] >
 *     ( Views, [data-composer-seat] )`，scrollBody 是 flex column；
 *   - **空白会话的 Views 直接 `return null`**（`DefaultConversationViews`：
 *     `if (session.blank && conversationPhase(...) === "blank") return null;`）；
 *   - 内核只给 hero phase 写 `justify-content:center`
 *     （`.Dc7zOa_embeddedBody[data-content-phase=hero] .Dc7zOa_scrollBody`）；
 *     而本栏刻意固定 `phase:'active'`（不渲那一大坨 hero 标题），active phase 只让
 *     `.viewArea{flex:1 0 auto}` 去撑高度 —— 空白会话连 viewArea 都没有，
 *     于是 scrollBody 里只剩一个 `flex:none` 的 composerSeat，它自然粘在**顶部**
 *     （`position:sticky; bottom:0` 在没有溢出时不会把元素往下推）。用户看到的就是
 *     「新对话一打开，输入框顶着头」。
 *
 * 修法：给 composerSeat 一个 `margin-top:auto` ——
 *   - 空白会话（scrollBody 里没有其它可撑高的兄弟）：自动外边距把输入区推到最底下；
 *   - 有正文的会话：viewArea 是 `flex:1 0 auto` 已经吃掉全部剩余空间，auto 外边距解析成 0，
 *     行为一个字不变（滚轮与粘底逻辑都不受影响）。
 * 不用 `justify-content:flex-end`：它在**可滚动**的 flex 容器里会让溢出到顶部的内容
 * 滚不到（Chrome 的老问题），而 auto 外边距在没有剩余空间时恒为 0，天然安全。
 */
const COMPOSER_BOTTOM_CSS = [
  '[data-dsh-aifisher-chat="body"] [data-conversation-content] > [data-conversation-scroll] > [data-composer-seat] {',
  '  margin-top: auto;',
  '}',
].join('\n');

/**
 * 会话下拉里的行 hover（内联样式表达不了伪类）。
 *
 * 只给**非当前**行上底色：当前行用内联 `background` 标出来（内联优先级高于这条规则），
 * 所以 hover 不会把「当前会话」的高亮洗掉。
 */
const SESSION_ROW_CSS = [
  '[data-dsh-aifisher-chat="session-row"]:hover {',
  '  background: rgba(255,255,255,0.06);',
  '}',
].join('\n');

/**
 * 滚轮护栏：本栏的滚动不该由画布那半的策略决定。
 *
 * 画布（vendor `canvasApplicationEvents.ts`）在 **document** 上挂了 wheel 监听，逻辑是
 * 「画布永不滚动：自下而上找 overflow-y:auto 且当下真能滚的祖先，找到一个就放行，否则 preventDefault」。
 * 本栏与画布在同一个 document 里，于是本栏滚轮能不能用取决于它那套祖先扫描当次的判断。
 * 所以：**非 ctrl/meta 的滚轮在本栏内停止冒泡**（正文/下拉/读写面板照旧原生滚动），
 * ctrl/meta 放行，保留画布那半「ctrl+滚轮 = 缩放」的行为。
 */
const onDockWheel = (event: React.WheelEvent<HTMLDivElement>) => {
  if (event.ctrlKey || event.metaKey) return;
  event.stopPropagation();
};

/** 本栏的样式块（与 CanvasShell 压 vendor 面板同一套写法：作用域选择器 + style 元素）。 */
function DockStyle() {
  return React.createElement(
    'style',
    { 'data-dsh-aifisher-canvas': 'dock-layout' },
    `${DOCK_LAYOUT_CSS}\n${COMPOSER_BOTTOM_CSS}`,
  );
}

/** 会话行的 hover 规则（与 DockStyle 分开，便于回归脚本单独断言）。 */
function SessionRowStyle() {
  return React.createElement('style', { 'data-dsh-aifisher-canvas': 'dock-session-row' }, SESSION_ROW_CSS);
}

/** 无会话 / 没有 renderFactorySlot 时的提示（不发请求、不抛错）。 */
function DockNotice({ title, detail }: { title: string; detail: string }) {
  return React.createElement(
    'div',
    {
      'data-dsh-aifisher-chat': 'notice',
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '18px 16px',
        color: 'var(--dsw-alias-label-secondary, #a8adb8)',
      },
    },
    React.createElement('strong', { style: { color: 'inherit', fontSize: 13 } }, title),
    React.createElement('span', { style: { fontSize: 12, lineHeight: 1.7 } }, detail),
  );
}

function CloseButton({ onClose }: { onClose?: () => void }) {
  if (typeof onClose !== 'function') return null;
  return React.createElement(
    'button',
    {
      type: 'button',
      'data-dsh-aifisher-chat': 'collapse',
      'aria-label': '收起会话栏',
      title: '收起会话栏（画布铺满）',
      onClick: onClose,
      style: {
        ...HEAD_ICON_BUTTON_STYLE,
        width: 'auto',
        padding: '0 8px',
        gap: 4,
      },
    },
    React.createElement('span', null, '收起'),
    React.createElement(
      'svg',
      { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: 'M6 3.5 10.5 8 6 12.5' }),
    ),
  );
}

function ChevronDown() {
  return React.createElement(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: 10,
      height: 10,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { flex: '0 0 auto' },
    },
    React.createElement('path', { d: 'M3.5 6 8 10.5 12.5 6' }),
  );
}

function PlusIcon() {
  return React.createElement(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: 13,
      height: 13,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      'aria-hidden': true,
    },
    React.createElement('path', { d: 'M8 3.5v9M3.5 8h9' }),
  );
}

/** 会话列表的一行（标题 / 运行中圆点 / 时间），时间只用于排序时的视觉锚点。 */
interface SessionRow {
  id: string;
  title: string;
  blank: boolean;
  running: boolean;
  updatedAt: number;
}

/** 空的归档集合（稳定引用：避免每次渲染都造一个新数组把 useMemo 打穿）。 */
const EMPTY_IDS: readonly string[] = [];

/** `updatedAt` 若是秒级（老数据）先归一成毫秒，再按「今天只看时分、更早只看月日」显示。 */
function formatWhen(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 从会话列表快照里挑出「适合放进切换菜单」的行。
 *
 * 过滤三类：已归档（工作区快照的 `archivedSessionIds`）、子代理会话（`parentId` 有值，
 * 它们属于某个父会话，不该平铺在主列表）、以及**不是当前会话的空白会话**（空白行是
 * 「新会话」占位，点它不会打开任何东西）。排序按最近更新时间倒序。
 */
function collectSessionRows(list: any, currentId: string | undefined, archivedIds: readonly string[]): SessionRow[] {
  const ids: string[] = Array.isArray(list?.ids) ? list.ids : [];
  const byId: Record<string, any> = list?.byId ?? {};
  const archived = new Set(archivedIds);
  const rows: SessionRow[] = [];
  for (const id of ids) {
    const row = byId[id];
    if (!row) continue;
    if (row.parentId !== undefined) continue;
    if (archived.has(id)) continue;
    const blank = row.blank === true;
    if (blank && id !== currentId) continue;
    const rawTitle = typeof row.displayTitle === 'string' && row.displayTitle ? row.displayTitle : typeof row.title === 'string' ? row.title : '';
    rows.push({
      id,
      // 空白会话的 displayTitle 是 cwd 兜底值（见 ChatDockBody 里 title 的注释），行里也显示「新会话」。
      title: blank ? (typeof row.title === 'string' && row.title ? row.title : '新会话') : rawTitle || id,
      blank,
      running: row.running === true,
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    });
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

/**
 * 真正调用内核选择器钩子的那一层。
 *
 * 拆成两层是有意的：React 不允许同一实例上条件性调用 hooks，而「宿主给没给这些标准 props」
 * 是外层才知道的事 —— 外层零 hook 只做分派，内层无条件调用。
 */
function ChatDockBody(props: CanvasChatDockProps) {
  const { sessionId, useSession, useConversation, useSessions, useWorkspaces, renderFactorySlot, onClose, sessionActions } = props;

  /**
   * 三个标准钩子**必须无条件、按固定顺序**调用。
   *
   * 真机踩过（2026-10-16，React #310「Rendered more hooks than during the previous render」）：
   * 一开始写成「没有选中会话就不调 useSessions」——应用启动时 sessionId 先是 undefined（少调一个钩子），
   * 随后会话解析出来（多调一个钩子），Hook 数量在一棵已挂载的子树里变了，
   * React 当场抛错，整个条目被内核的槽位错误边界换成死格子（`<div data-slot-error>`）。
   * 所以：**分支写在 selector 里，绝不写在钩子调用外面**。
   */
  const absentSelector = (selector: (snapshot: unknown) => unknown) => selector(undefined);
  const useSessionsSafe = typeof useSessions === 'function' ? useSessions : absentSelector;
  // useWorkspaces 是 v1.62 才用到的（只为过滤已归档会话）：老宿主没有它时按「没有归档」处理。
  const useWorkspacesSafe = typeof useWorkspaces === 'function' ? useWorkspaces : absentSelector;

  // 外层已保证前两个是函数，这里直接调（不用 `?.`：那会让「有没有钩子」再次变成运行时分支）。
  const session = useSession!((value) => value);
  const conversation = useConversation!((value) => value);
  const list = useSessionsSafe((state: any) => state);
  const workspaceState = useWorkspacesSafe((state: any) => state);

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  const summary = sessionId === undefined ? undefined : list?.byId?.[sessionId];
  const hasSession = sessionId !== undefined && session !== undefined && conversation !== undefined;
  /**
   * 标题：空白会话必须显示「新会话」。
   *
   * 为什么不能直接用 `displayTitle`：内核给空白会话的 displayTitle 是**用 cwd 兜底出来的**
   * （没有标题 → 退回工作区目录名），于是侧栏顶部看着像「一个新会话」，本栏标题却写着
   * `dsh-aifisher-canvas`（工作区目录名）—— 用户会以为切错了会话。侧边栏自己也是
   * `node.blank ? t('session.new') : title`，这里对齐同一个口径。
   */
  const title = summary?.blank === true
    ? (typeof summary?.title === 'string' && summary.title ? summary.title : '新会话')
    : typeof summary?.displayTitle === 'string' && summary.displayTitle
      ? summary.displayTitle
      : '当前会话';

  const archivedIds = React.useMemo<readonly string[]>(
    () => (Array.isArray(workspaceState?.archivedSessionIds) ? workspaceState.archivedSessionIds : EMPTY_IDS),
    [workspaceState],
  );
  const rows = React.useMemo(() => collectSessionRows(list, sessionId, archivedIds), [list, sessionId, archivedIds]);
  const needle = query.trim().toLowerCase();
  const visibleRows = needle ? rows.filter((row) => row.title.toLowerCase().includes(needle)) : rows;

  /**
   * 点空白处关菜单。
   *
   * 监听器挂在捕获阶段：菜单里的输入框/行点击都是先经过 document 再到目标，
   * 所以必须在 document 上判断「这次按下是不是在菜单或触发器里面」，是就放行。
   * 只靠 trigger 的 onClick 切换是不够的 —— 先关后开会在同一次点击里互相抵消。
   */
  React.useEffect(() => {
    if (!menuOpen) return undefined;
    if (typeof document === 'undefined') return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [menuOpen]);

  const onToggleMenu = () => {
    setError(undefined);
    setQuery('');
    setMenuOpen((open) => !open);
  };

  /**
   * 新建会话。
   *
   * 成功后本组件会被内核重挂（session-maybe 换会话必重挂，见 renderer 的 `useMaybeIncarnation`），
   * 这里的 state 跟着卸载丢掉，所以不需要收尾；失败时把菜单打开，让原因当场可见。
   */
  const onNewSession = () => {
    if (!sessionActions || busy) return;
    setBusy(true);
    setError(undefined);
    sessionActions.create().then(
      (result) => {
        setBusy(false);
        if (!result.ok) {
          setError(result.message);
          setMenuOpen(true);
        }
      },
      (reason: unknown) => {
        setBusy(false);
        setError(reason instanceof Error ? reason.message : String(reason));
        setMenuOpen(true);
      },
    );
  };

  const onPickSession = (id: string) => {
    if (!sessionActions) return;
    if (id === sessionId) {
      setMenuOpen(false);
      return;
    }
    const result = sessionActions.open(id);
    if (result.ok) setMenuOpen(false);
    else setError(result.message);
  };

  const header = React.createElement(
    'div',
    { 'data-dsh-aifisher-chat': 'head', style: HEAD_STYLE },
    React.createElement(
      'button',
      {
        ref: triggerRef,
        type: 'button',
        'data-dsh-aifisher-chat': 'session-menu-trigger',
        'aria-haspopup': sessionActions ? 'listbox' : undefined,
        'aria-expanded': sessionActions ? menuOpen : undefined,
        'aria-label': sessionActions ? '切换会话' : undefined,
        title: sessionActions ? `${hasSession ? title : '当前会话'}（点击切换会话）` : title,
        disabled: !sessionActions,
        onClick: sessionActions ? onToggleMenu : undefined,
        style: sessionActions ? TRIGGER_STYLE : { ...TRIGGER_STYLE, cursor: 'default' },
      },
      React.createElement('span', { style: TRIGGER_LABEL_STYLE }, hasSession ? title : sessionActions ? '选择会话' : 'DSH 会话'),
      sessionActions ? ChevronDown() : null,
    ),
    sessionActions
      ? React.createElement(
          'button',
          {
            type: 'button',
            'data-dsh-aifisher-chat': 'session-new',
            'aria-label': '新建会话（留在画布）',
            title: busy ? '正在新建会话…' : '新建会话（留在画布，不切走）',
            disabled: busy,
            onClick: onNewSession,
            style: busy ? HEAD_ICON_BUTTON_BUSY_STYLE : HEAD_ICON_BUTTON_STYLE,
          },
          PlusIcon(),
        )
      : null,
    React.createElement(CloseButton, { onClose }),
  );

  const menu = menuOpen
    ? React.createElement(
        'div',
        { 'data-dsh-aifisher-chat': 'session-menu', ref: menuRef, style: MENU_STYLE },
        React.createElement('input', {
          'data-dsh-aifisher-chat': 'session-search',
          type: 'search',
          value: query,
          placeholder: '搜索会话…',
          'aria-label': '搜索会话',
          autoFocus: true,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
          style: SEARCH_STYLE,
        }),
        error ? React.createElement('div', { 'data-dsh-aifisher-chat': 'session-error', role: 'alert', style: ERROR_STYLE }, error) : null,
        React.createElement(
          'div',
          { role: 'listbox', 'aria-label': '会话列表', style: MENU_LIST_STYLE, 'data-dsh-aifisher-chat': 'session-list' },
          visibleRows.length === 0
            ? React.createElement('div', { style: EMPTY_STYLE }, query.trim() ? '没有匹配的会话' : '还没有其它会话')
            : visibleRows.map((row) =>
                React.createElement(
                  'button',
                  {
                    key: row.id,
                    type: 'button',
                    role: 'option',
                    'aria-selected': row.id === sessionId,
                    'data-dsh-aifisher-chat': 'session-row',
                    'data-session-id': row.id,
                    'data-current': row.id === sessionId ? 'true' : undefined,
                    title: row.title,
                    onClick: () => onPickSession(row.id),
                    style: row.id === sessionId ? { ...ROW_STYLE, ...ROW_ACTIVE_STYLE } : ROW_STYLE,
                  },
                  React.createElement('span', { style: ROW_TITLE_STYLE }, row.title),
                  row.running ? React.createElement('span', { 'data-dsh-aifisher-chat': 'session-running', 'aria-label': '运行中', style: RUNNING_DOT_STYLE }) : null,
                  React.createElement('span', { style: ROW_TIME_STYLE }, formatWhen(row.updatedAt)),
                ),
              ),
        ),
      )
    : null;

  /**
   * 会话本体。
   *
   * - `variant: 'embedded'`：不渲染主 Header / 不带正文宽度拖拽条（嵌入式 occurrence 的既有形态）；
   * - `phase: 'active'` + `hero: false`：见文件头「刻意不同的两处」；
   * - 不传 `slots`：交给工厂的默认 views adapter。
   */
  const body = !hasSession
    ? React.createElement(DockNotice, {
        title: '未选择会话',
        detail:
          '在左侧点一个会话（或新建一个）即可在这里继续对话 —— 与 DSH 主区域的聊天是同一个会话、同一份记录，画布工具（canvas_control）也照常可用。',
      })
    : typeof renderFactorySlot === 'function'
      ? renderFactorySlot(
          'conversation.content',
          { variant: 'embedded', phase: 'active', hero: false },
          undefined,
        )
      : React.createElement(DockNotice, {
          title: '宿主没有提供会话渲染面',
          detail: '当前 DSH 版本的 slots 渲染器没有给本面板 renderFactorySlot，会话无法嵌入；画布本身不受影响。',
        });

  return React.createElement(
    'div',
    {
      'data-dsh-aifisher-chat': 'dock',
      // 当前会话 id（排障/真机回归用：换会话后它必须变；jsdom 里由标准 props 注入）。
      'data-dsh-aifisher-session': sessionId,
      style: DOCK_STYLE,
      onWheel: onDockWheel,
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || !menuOpen) return;
        event.stopPropagation();
        setMenuOpen(false);
      },
    },
    React.createElement(DockStyle, null),
    React.createElement(SessionRowStyle, null),
    header,
    menu,
    React.createElement('div', { 'data-dsh-aifisher-chat': 'body', style: BODY_STYLE }, body),
  );
}

/**
 * 槽位入口。宿主按 `aifisher-canvas.chat`（single, session-maybe）注册的就是它。
 *
 * 宿主没给 `useSession` / `useConversation`（老版本 DSH、或测试桩没铺这些 props）时，
 * 直接给出提示而不是把异常抛进 React 渲染期 —— 画布面板必须照常可用。
 */
export function CanvasChatDock(props: CanvasChatDockProps) {
  if (typeof props.useSession !== 'function' || typeof props.useConversation !== 'function') {
    return React.createElement(
      'div',
      { 'data-dsh-aifisher-chat': 'dock', style: DOCK_STYLE, onWheel: onDockWheel },
      React.createElement(DockStyle, null),
      React.createElement(DockNotice, {
        title: '会话面未就绪',
        detail: '宿主没有给这个槽位会话作用域的标准 props（useSession / useConversation），暂时无法嵌入 DSH 会话。',
      }),
    );
  }
  // 钩子只能在稳定的调用顺序里跑：上面的分支在同一个实例上不会来回切换，
  // 因为「宿主给没给标准 props」在一次装机里是常量。
  return React.createElement(ChatDockBody, props);
}
