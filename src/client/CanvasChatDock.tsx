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
 * ## 依赖降级
 *
 * 宿主没给 `renderFactorySlot` / 没有会话绑定时，本组件只渲染一句提示，绝不抛错
 * （同 apply.ts 的「一次注册失败不该把应用搞崩」原则）。
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
  /** 全局会话列表（拿标题 / blank 标记用）。 */
  useSessions?: (selector: (snapshot: any) => any) => any;
  /** renderer 给的 Factory occurrence 渲染器（见文件头第 1 条）。 */
  renderFactorySlot?: (
    name: string,
    props?: Record<string, unknown>,
    options?: { slots?: Record<string, unknown>; fallback?: unknown },
  ) => React.ReactNode;
  /** 由画布外壳通过 renderSlot 的 ownerProps 传进来：收起右侧栏。 */
  onClose?: () => void;
}

const DOCK_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-base, #17181c)',
  color: 'var(--dsw-alias-label-primary, #e7e9ee)',
  font: '13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei UI", sans-serif',
};

const HEAD_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
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
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 24,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
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

/**
 * 真正调用内核选择器钩子的那一层。
 *
 * 拆成两层是有意的：React 不允许同一实例上条件性调用 hooks，而「宿主给没给这些标准 props」
 * 是外层才知道的事 —— 外层零 hook 只做分派，内层无条件调用。
 */
function ChatDockBody(props: CanvasChatDockProps) {
  const { sessionId, useSession, useConversation, useSessions, renderFactorySlot, onClose } = props;

  /**
   * 三个标准钩子**必须无条件、按固定顺序**调用。
   *
   * 真机踩过（2026-10-16，React #310「Rendered more hooks than during the previous render」）：
   * 一开始写成「没有选中会话就不调 useSessions」——应用启动时 sessionId 先是 undefined（少调一个钩子），
   * 随后会话解析出来（多调一个钩子），Hook 数量在一棵已挂载的子树里变了，
   * React 当场抛错，整个条目被内核的槽位错误边界换成死格子（`<div data-slot-error>`）。
   * 所以：**分支写在 selector 里，绝不写在钩子调用外面**。
   */
  const absentSessions = (selector: (snapshot: unknown) => unknown) => selector(undefined);
  const useSessionsSafe = typeof useSessions === 'function' ? useSessions : absentSessions;

  // 外层已保证前两个是函数，这里直接调（不用 `?.`：那会让「有没有钩子」再次变成运行时分支）。
  const session = useSession!((value) => value);
  const conversation = useConversation!((value) => value);
  const summary = useSessionsSafe((state: any) =>
    sessionId === undefined ? undefined : state?.byId?.[sessionId] ?? undefined,
  );

  const hasSession = sessionId !== undefined && session !== undefined && conversation !== undefined;
  const title = typeof summary?.displayTitle === 'string' && summary.displayTitle ? summary.displayTitle : '当前会话';

  const header = React.createElement(
    'div',
    { 'data-dsh-aifisher-chat': 'head', style: HEAD_STYLE },
    React.createElement(
      'span',
      {
        style: {
          maxWidth: '70%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
        title,
      },
      hasSession ? title : 'DSH 会话',
    ),
    React.createElement(CloseButton, { onClose }),
  );

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
    { 'data-dsh-aifisher-chat': 'dock', style: DOCK_STYLE, onWheel: onDockWheel },
    React.createElement(DockStyle, null),
    header,
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
