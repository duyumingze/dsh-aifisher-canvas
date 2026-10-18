/**
 * 画布右侧「DSH 原生会话栏」回归测试（jsdom + 真 client 产物）。
 *
 * 背景：用户拍板「画布里的对话面板换成 DSH 原生会话区」（2026-10-16）。做法不是自己重画一个
 * 聊天框，而是把内核的会话界面按槽位契约嵌进来：
 *
 *   main key=aifisher-canvas 的条目声明子槽位 aifisher-canvas.chat（session-maybe）
 *     → CanvasShell 用 renderSlot 渲染它
 *       → CanvasChatDock 收到内核的会话标准 props，用 renderFactorySlot 渲染
 *          `conversation.content` 工厂的 embedded occurrence（= 真·原生会话界面）
 *
 * 本套把这些契约钉死（jsdom 验不了真会话渲染，但契约与降级都能验）：
 *   1. `main` 条目的 children 里确实声明了会话子槽位，且 scope 必须是 session-maybe
 *      （写成 session 会在「没选中会话」时直接抛 SlotAssemblyError，写成 root 则拿不到会话）；
 *   2. 会话栏条目真的注册进了那个子槽位；
 *   3. 外壳：画布区 + 会话栏同屏、宽度取自 localStorage（越界夹取、坏数据回退默认）；
 *   4. dock：拿到的会话标准 props 会转成一次 renderFactorySlot('conversation.content',
 *      { variant:'embedded', phase:'active', hero:false }) 调用；
 *   5. 降级：宿主没给标准 props / 没给 renderFactorySlot / 没给 renderSlot 时只给提示，
 *      不抛错、不把画布面板拖崩；
 *   6. vendor 自带的对话面板与启动球被作用域 CSS 压掉（且 vendor 树没被改）。
 *
 * 用法：node scripts/test-canvas-chat-dock.mjs   （需要先 build）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import React from 'react';
import { createRoot } from 'react-dom/client';

import { ROOT, createCanvasDom, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

// ---------------------------------------------------------------- 1) jsdom + client 产物

const host = await startHost();
const { window } = await createCanvasDom({ dispatch: host.dispatch });

const clientSrc = readFileSync(join(ROOT, 'lib/client/apply.js'), 'utf8');
let registration;
const sandbox = {
  console,
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  fetch: window.fetch,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  performance,
  MutationObserver: window.MutationObserver,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  Blob: window.Blob,
  File: window.File,
  FormData: window.FormData,
};
sandbox.window.__ModuleLoader__ = {
  load: (reg) => {
    registration = reg;
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(clientSrc, sandbox, { filename: 'lib/client/apply.js' });
  check('client 产物执行并注册模块', registration?.id === 'dsh-aifisher-canvas', String(registration?.id));
} catch (error) {
  check('client 产物执行并注册模块', false, error.message);
}

let mod = null;
try {
  mod = registration.factory((spec) => {
    if (spec === 'react') return React;
    throw new Error(`unexpected require("${spec}")`);
  });
} catch (error) {
  check('client factory 可执行', false, error.message);
}

// ---------------------------------------------------------------- 2) 假宿主：记录槽位注册

/** key → { component, options }；子槽位另存。 */
const mainEntries = new Map();
const childSlotEntries = new Map();
const ctxStub = {
  slots: {
    inject: (_owner, callback) => {
      callback();
      return () => {};
    },
    register: (options, component) => {
      if (options?.name === 'main' && typeof options.key === 'string') {
        mainEntries.set(options.key, { component, options });
      } else if (typeof options?.name === 'string') {
        if (!childSlotEntries.has(options.name)) childSlotEntries.set(options.name, []);
        childSlotEntries.get(options.name).push({ component, options });
      }
      return () => {};
    },
  },
  get: () => undefined,
};

let dispose = null;
try {
  dispose = mod.apply(ctxStub);
  check('client apply() 在只有 slots 的宿主上跑通', true);
} catch (error) {
  check('client apply() 在只有 slots 的宿主上跑通', false, error.message);
}

const CHAT_SLOT = 'aifisher-canvas.chat';
const canvasEntry = mainEntries.get('aifisher-canvas');

check(
  'main 条目 children 声明了会话子槽位',
  canvasEntry?.options?.children?.[CHAT_SLOT]?.kind === 'single',
  JSON.stringify(canvasEntry?.options?.children ?? null),
);
check(
  '会话子槽位 scope = session-maybe（写成 session 会在无会话时抛错、写成 root 拿不到会话）',
  canvasEntry?.options?.children?.[CHAT_SLOT]?.scope === 'session-maybe',
  String(canvasEntry?.options?.children?.[CHAT_SLOT]?.scope),
);
check(
  '会话栏本体注册进了那个子槽位',
  (childSlotEntries.get(CHAT_SLOT) ?? []).length === 1,
  String((childSlotEntries.get(CHAT_SLOT) ?? []).length),
);
check(
  'main 里没有去抢内核保留的 conversation key（只动自己的 key）',
  !mainEntries.has('conversation'),
  Array.from(mainEntries.keys()).join(', '),
);

const CanvasShell = canvasEntry?.component;
const CanvasChatDock = childSlotEntries.get(CHAT_SLOT)?.[0]?.component;
const DockRegistered = CanvasChatDock;

// ---------------------------------------------------------------- 3) 外壳 + dock 的联排渲染

/** 假内核的「会话作用域标准 props」：选择器钩子是纯函数，直接给快照。 */
function standardSessionProps(options = {}) {
  // 注意不能用默认参数表达「没有会话」：`{ sessionId: undefined }` 会触发默认值。
  const sessionId = Object.hasOwn(options, 'sessionId') ? options.sessionId : 'session-dock-test';
  const withFactory = options.withFactory ?? true;
  const sessionsSnapshot = {
    byId: { [sessionId]: { displayTitle: '测试会话', blank: false } },
  };
  return {
    sessionId,
    useSession: (selector) => selector({ blank: false, running: false, promptAttempted: true, openState: 'open' }),
    useConversation: (selector) => selector({ activeTargets: new Set() }),
    useSessions: (selector) => selector(sessionsSnapshot),
    renderFactorySlot: withFactory
      ? (name, props) => {
          factoryCalls.push({ name, props });
          return React.createElement('div', { 'data-fake-conversation': 'content' }, '原生会话');
        }
      : undefined,
  };
}
let factoryCalls = [];

/** 假宿主：renderSlot(key, owner) = 把注册在 key 上的组件按「标准 props + ownerProps」渲出来。 */
function makeRenderSlot(options = {}) {
  return (key, owner) => {
    if (key !== CHAT_SLOT) throw new Error(`unexpected renderSlot("${key}")`);
    if (typeof DockRegistered !== 'function') return null;
    return React.createElement(DockRegistered, { ...standardSessionProps(options), ...(owner ?? {}) });
  };
}

async function renderShell({ props = {}, storage = {} } = {}) {
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  const container = window.document.createElement('div');
  container.style.width = '1200px';
  container.style.height = '800px';
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CanvasShell, props));
  await settle(300);
  return { container, root };
}

{
  factoryCalls = [];
  const { container, root } = await renderShell({
    props: { renderSlot: makeRenderSlot({}) },
    storage: { 'dsh-aifisher-canvas.chatDock.open': '1', 'dsh-aifisher-canvas.chatDock.width': '420' },
  });

  const shell = container.querySelector('[data-dsh-aifisher-canvas="shell"]');
  check('外壳渲染出根容器', shell !== null);
  check('外壳是 flex 排布（画布 + 会话栏同屏）', (shell?.style.display ?? '') === 'flex', shell?.style.display ?? '(none)');
  check('左侧画布区在', container.querySelector('[data-dsh-aifisher-canvas="canvas-area"]') !== null);
  check('画布面板根容器还在（退出按钮等契约不变）', container.querySelector('[data-dsh-aifisher-canvas="panel"]') !== null);

  const column = container.querySelector('[data-dsh-aifisher-canvas="chat-column"]');
  check('右侧会话栏在', column !== null);
  check('会话栏宽度取自偏好（420）', (column?.style.width ?? '') === '420px', column?.style.width ?? '(none)');
  check('会话栏左侧有拖宽手柄', container.querySelector('[data-dsh-aifisher-canvas="chat-handle"]') !== null);
  check('dock 渲染出来了', container.querySelector('[data-dsh-aifisher-chat="dock"]') !== null);
  check(
    'dock 用 renderFactorySlot 渲染了 conversation.content 的 embedded occurrence',
    factoryCalls.length === 1 &&
      factoryCalls[0].name === 'conversation.content' &&
      factoryCalls[0].props?.variant === 'embedded' &&
      factoryCalls[0].props?.phase === 'active' &&
      factoryCalls[0].props?.hero === false,
    JSON.stringify(factoryCalls[0] ?? null),
  );
  check('dock 头部显示的是当前会话标题', (container.textContent ?? '').includes('测试会话'), (container.textContent ?? '').slice(0, 40));

  const suppress = container.querySelector('style[data-dsh-aifisher-canvas="agent-suppress"]');
  check(
    'vendor 自带对话面板/启动球被作用域 CSS 压掉（不改 vendor 树）',
    suppress !== null &&
      suppress.textContent.includes('[data-fisherai-agent-launcher]') &&
      suppress.textContent.includes('[data-fisherai-agent-panel]') &&
      suppress.textContent.includes('display: none !important'),
    suppress ? suppress.textContent.replace(/\s+/g, ' ').slice(0, 80) : '(none)',
  );

  // ---------------------------------------------------------------- 滚动契约（真机「滚轮滚不动」那一轮）
  //
  // jsdom 没有排版引擎，量不出 clientHeight/scrollHeight，所以这里只钉**两条约定的存在性**：
  //   ① 本栏必须把内核会话需要的 flex 链补齐（正文容器 flex column + 装会话的那层 flex:1 1 auto）；
  //   ② 非 ctrl/meta 的滚轮不许冒泡到 document（画布那半在 document 上装了「画布永不滚动」的监听）。
  // 真正的「滚得动」由 scripts/verify-live-dock.mjs 用真浏览器 + 真滚轮事件验（那边有 CDP）。
  const dockLayout = container.querySelector('style[data-dsh-aifisher-canvas="dock-layout"]');
  const layoutCss = (dockLayout?.textContent ?? '').replace(/\s+/g, ' ');
  check(
    '本栏带上了会话正文的 flex 链（正文容器 flex column）',
    dockLayout !== null &&
      layoutCss.includes('[data-dsh-aifisher-chat="dock"] [data-dsh-aifisher-chat="body"]') &&
      layoutCss.includes('display: flex') &&
      layoutCss.includes('flex-direction: column'),
    layoutCss.slice(0, 120),
  );
  check(
    '本栏带上了装会话的那层包裹（flex:1 1 auto + min-height:0）',
    layoutCss.includes(':has([data-conversation-content])') &&
      layoutCss.includes('flex: 1 1 auto') &&
      layoutCss.includes('min-height: 0'),
    layoutCss.slice(0, 160),
  );
  /**
   * v1.41：新对话的输入区贴底（用户 2026-10-18：「右侧聊天面板新对话默认会顶头不好看，
   * 希望移动到最地下」）。根因是空白会话里内核不渲 Views，scrollBody 里只剩一个 flex:none 的
   * composerSeat；这里钉住修法（给 composerSeat 一条 margin-top:auto）。
   *
   * jsdom 没有排版引擎，量不出「贴没贴底」，所以对象必须精确到
   * `[data-conversation-scroll] > [data-composer-seat]`（少一层 `>` 就会连别的座位一起改，
   * 那是有正文时会出问题的写法）；真机上的「贴底 / 有正文时不受影响」由
   * scripts/verify-live-dock.mjs 的 A/B 测量验。
   */
  check(
    '新对话（空白会话）的输入区贴底：给 composerSeat 补了 margin-top:auto',
    /\[data-dsh-aifisher-chat="body"\] \[data-conversation-content\] > \[data-conversation-scroll\] > \[data-composer-seat\][^{]*\{[^}]*margin-top:\s*auto/.test(
      layoutCss,
    ),
    layoutCss.slice(layoutCss.indexOf('[data-composer-seat]')).slice(0, 200) || '(missing)',
  );

  {
    // 滚轮护栏：dispatch 到 dock 正文里，看事件能不能冒到 document。
    const body = container.querySelector('[data-dsh-aifisher-chat="body"]');
    const seen = [];
    const spy = (event) => seen.push({ ctrl: event.ctrlKey });
    window.document.addEventListener('wheel', spy);
    try {
      const plain = new window.WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true });
      body.dispatchEvent(plain);
      check(
        '非 ctrl/meta 的滚轮在本栏内停止冒泡（画布的 document 级 wheel 监听收不到）',
        seen.length === 0,
        `document 收到 ${seen.length} 次`,
      );

      const withCtrl = new window.WheelEvent('wheel', { deltaY: 300, ctrlKey: true, bubbles: true, cancelable: true });
      body.dispatchEvent(withCtrl);
      check(
        'ctrl+滚轮照旧冒泡（画布那半的「ctrl+滚轮=缩放」行为不被本栏吃掉）',
        seen.length === 1 && seen[0].ctrl === true,
        JSON.stringify(seen),
      );
    } finally {
      window.document.removeEventListener('wheel', spy);
    }
  }

  // 收起 → 窄竖条；展开 → 回会话栏；开合偏好落 localStorage
  const collapse = container.querySelector('[data-dsh-aifisher-chat="collapse"]');
  check('会话栏有收起按钮', collapse !== null);
  collapse?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(60);
  check('点收起后会话栏消失、出现窄竖条', container.querySelector('[data-dsh-aifisher-canvas="chat-column"]') === null && container.querySelector('[data-dsh-aifisher-canvas="chat-rail"]') !== null);
  check('收起状态落进 localStorage', window.localStorage.getItem('dsh-aifisher-canvas.chatDock.open') === '0', String(window.localStorage.getItem('dsh-aifisher-canvas.chatDock.open')));

  const expand = container.querySelector('[data-dsh-aifisher-chat="expand"]');
  expand?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(60);
  check('点展开后会话栏回来', container.querySelector('[data-dsh-aifisher-canvas="chat-column"]') !== null && container.querySelector('[data-dsh-aifisher-canvas="chat-rail"]') === null);

  root.unmount();
}

// ---------------------------------------------------------------- 4) 宽度偏好的夹取与坏数据

{
  // 没存过宽度（localStorage 里没有这个键 → getItem 返回 null）时必须回退默认 420，
  // 而不是被 Number(null)===0 夹成下限 300（真机踩过）。
  window.localStorage.removeItem('dsh-aifisher-canvas.chatDock.width');
  factoryCalls = [];
  const { container, root } = await renderShell({
    props: { renderSlot: makeRenderSlot({}) },
    storage: { 'dsh-aifisher-canvas.chatDock.open': '1' },
  });
  const column = container.querySelector('[data-dsh-aifisher-canvas="chat-column"]');
  check('没存过宽度时用默认 420（不是被夹成下限）', (column?.style.width ?? '') === '420px', column?.style.width ?? '(none)');
  root.unmount();
}

{
  factoryCalls = [];
  const { container, root } = await renderShell({
    props: { renderSlot: makeRenderSlot({}) },
    storage: { 'dsh-aifisher-canvas.chatDock.open': '1', 'dsh-aifisher-canvas.chatDock.width': '4000' },
  });
  const column = container.querySelector('[data-dsh-aifisher-canvas="chat-column"]');
  check('超上限的宽度被夹到 860', (column?.style.width ?? '') === '860px', column?.style.width ?? '(none)');
  root.unmount();
}

{
  factoryCalls = [];
  const { container, root } = await renderShell({
    props: { renderSlot: makeRenderSlot({}) },
    storage: { 'dsh-aifisher-canvas.chatDock.open': '1', 'dsh-aifisher-canvas.chatDock.width': 'abc' },
  });
  const column = container.querySelector('[data-dsh-aifisher-canvas="chat-column"]');
  check('坏宽度回退默认 420', (column?.style.width ?? '') === '420px', column?.style.width ?? '(none)');
  root.unmount();
}

{
  factoryCalls = [];
  const { container, root } = await renderShell({
    props: { renderSlot: makeRenderSlot({}) },
    storage: { 'dsh-aifisher-canvas.chatDock.open': '1', 'dsh-aifisher-canvas.chatDock.width': '100' },
  });
  const column = container.querySelector('[data-dsh-aifisher-canvas="chat-column"]');
  check('低于下限的宽度被抬到 300', (column?.style.width ?? '') === '300px', column?.style.width ?? '(none)');
  root.unmount();
}

// ---------------------------------------------------------------- 5) 降级路径

{
  // 宿主没给 renderSlot（老版本宿主 / 测试桩）：外壳只渲染画布，不抛错
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  let error = null;
  try {
    root.render(React.createElement(CanvasShell, { renderSlot: undefined }));
    await settle(200);
  } catch (caught) {
    error = caught;
  }
  check('宿主没给 renderSlot 时外壳照常渲染（只有画布）', error === null && container.querySelector('[data-dsh-aifisher-canvas="shell"]') !== null, error ? String(error) : '');
  check('此时不渲染会话栏也不炸', container.querySelector('[data-dsh-aifisher-canvas="chat-column"]') === null);
  root.unmount();
}

{
  // dock：没有选中会话 → 人话提示，不调用 renderFactorySlot
  factoryCalls = [];
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(DockRegistered, { ...standardSessionProps({ sessionId: undefined }) }));
  await settle(120);
  check(
    '没选中会话时给提示且不渲染会话工厂',
    container.querySelector('[data-dsh-aifisher-chat="notice"]') !== null && factoryCalls.length === 0,
    JSON.stringify(factoryCalls),
  );
  root.unmount();
}

{
  // dock：宿主没给 renderFactorySlot → 提示，不崩
  factoryCalls = [];
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  let error = null;
  try {
    root.render(React.createElement(DockRegistered, { ...standardSessionProps({ withFactory: false }) }));
    await settle(120);
  } catch (caught) {
    error = caught;
  }
  check('宿主没给 renderFactorySlot 时只给提示', error === null && container.querySelector('[data-dsh-aifisher-chat="notice"]') !== null, error ? String(error) : '');
  root.unmount();
}

{
  // dock：连会话标准 props 都没有（没有会话作用域的宿主）
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  let error = null;
  try {
    root.render(React.createElement(DockRegistered, {}));
    await settle(120);
  } catch (caught) {
    error = caught;
  }
  check(
    '没有会话标准 props 时 dock 给「会话面未就绪」而不抛错',
    error === null && (container.textContent ?? '').includes('会话面未就绪'),
    error ? String(error) : (container.textContent ?? '').slice(0, 40),
  );
  root.unmount();
}

{
  // 回归：会话从「无」变「有」时**不许**变 hooks 数量。
  //
  // 真机踩过（2026-10-16，React #310「Rendered more hooks than during the previous render」）：
  // 最初写成「sessionId === undefined 就不调 useSessions」，应用启动时会话先无后有 →
  // 已挂载的子树里 Hook 数量变了 → React 抛错 → 内核的槽位错误边界把条目换成死格子
  // （`<div data-slot-error="aifisher-canvas.chat">`），右栏空着。jsdom 这一场就是钉住它。
  factoryCalls = [];
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  try {
    root.render(React.createElement(DockRegistered, { ...standardSessionProps({ sessionId: undefined }) }));
    await settle(80);
    check(
      '无会话时先渲染成提示',
      container.querySelector('[data-dsh-aifisher-chat="notice"]') !== null && factoryCalls.length === 0,
      JSON.stringify(factoryCalls),
    );
    // 同一个实例再渲染一次，这次带上会话（Hook 数量必须不变）
    root.render(React.createElement(DockRegistered, { ...standardSessionProps({}) }));
    await settle(120);
    check(
      '会话从「无」到「有」时同一实例不崩、dock 正常渲染会话',
      container.querySelector('[data-dsh-aifisher-chat="notice"]') === null && factoryCalls.length === 1,
      `factoryCalls=${factoryCalls.length} errors=${errors.length}`,
    );
    check(
      '这次切换没有 React hooks 顺序报错（#310）',
      !errors.some((line) => line.includes('310') || line.includes('more hooks')),
      errors.slice(-1).join(' ').slice(0, 160),
    );
  } finally {
    console.error = originalError;
    root.unmount();
  }
}

// ---------------------------------------------------------------- 6) vendor 树没有被这次改动碰过

{
  const sidePanels = readFileSync(join(ROOT, 'vendor/aifisher/src/stable/dialogs/canvasSidePanels.ts'), 'utf8');
  check(
    'vendor 的 CanvasSidePanels 保持原样（agent 面板仍由上游渲染，只是被 CSS 压掉）',
    sidePanels.includes('components.AgentLauncher') && sidePanels.includes('components.Agent'),
  );
}

if (typeof dispose === 'function') {
  dispose();
  check('apply 返回的清理函数可调用', true);
}

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
