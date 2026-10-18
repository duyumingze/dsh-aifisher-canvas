/**
 * 面板出口回归测试（jsdom + 真 client 产物）。
 *
 * 背景：DSH 的 `main` 是 keyed slot，面板一被选中就整块占住主区域，DSH 自己只提供
 * 「在侧边栏点别的面板」这条隐式退路。用户实测反馈「画布没有退出画布功能」——所以
 * 本插件给两个面板各挂了一个显式退出按钮（ctx.layout.selectPanel(null) → 回对话）。
 *
 * 本套验证四件事：
 *   1. client 产物只依赖模块表的 react（不 require react/jsx-runtime），并且
 *      真的把布局服务接进了两个 main 面板；
 *   2. 面板渲染出来以后，按钮存在、点下去确实调用 layout.selectPanel(null)；
 *   3. 面板根容器自带 position:relative（否则面板的 absolute 会以整个 AppFrame 为
 *      基准，盖住 DSH 侧边栏 —— 那正是「没有退路」的另一种成因）；
 *   4. 画布左上角项目菜单的裂图修好了（/aifisher-mark-white.svg 由 host 半托管），
 *      以及画布外壳贴边元素已从 fixed 改成 absolute（不再压住 DSH 侧边栏）。
 *
 * 用法：node scripts/test-panel-exit.mjs   （需要先 build）
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

// ---------------------------------------------------------------- 1) jsdom 环境（client 产物要在这里跑）

const host = await startHost();
const { window } = await createCanvasDom({ dispatch: host.dispatch });

// ---------------------------------------------------------------- 2) client 产物 + 假 ModuleLoader

const clientSrc = readFileSync(join(ROOT, 'lib/client/apply.js'), 'utf8');
let registration;
/**
 * 产物的全局来自 vm 沙箱，不是 Node 的 globalThis —— 浏览器里本来就有的
 * setTimeout / document 这些必须显式灌进去（素材库面板的防抖就用了 setTimeout）。
 */
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

const required = [];
const requireShim = (spec) => {
  required.push(spec);
  if (spec === 'react') return React;
  throw new Error(`unexpected require("${spec}")`);
};
let mod = null;
try {
  mod = registration.factory(requireShim);
} catch (error) {
  check('client factory 可执行', false, error.message);
}
check(
  'client 半只从模块表要 react（没有 react/jsx-runtime 依赖）',
  required.length > 0 && required.every((spec) => spec === 'react'),
  required.join(', ') || '(none)',
);

// ---------------------------------------------------------------- 3) 假 DSH 宿主：slot + layout

const layoutCalls = [];
const layoutStub = {
  selectPanel: (panelId) => {
    layoutCalls.push(panelId);
  },
};
const mainEntries = new Map();
const ctxStub = {
  slots: {
    inject: (_owner, callback) => {
      callback();
      return () => {};
    },
    register: (options, component) => {
      if (options?.name === 'main' && typeof options.key === 'string') {
        mainEntries.set(options.key, component);
      }
      return () => {};
    },
  },
  get: (name) => (name === 'layout' ? layoutStub : undefined),
};

let dispose = null;
try {
  dispose = mod.apply(ctxStub);
  check('client apply() 在带 layout 的宿主上跑通', true);
} catch (error) {
  check('client apply() 在带 layout 的宿主上跑通', false, error.message);
}
check(
  '两个 main 面板都注册上了',
  mainEntries.has('aifisher-canvas') && mainEntries.has('aifisher-library'),
  Array.from(mainEntries.keys()).join(', '),
);

// ---------------------------------------------------------------- 4) jsdom 里真渲染 + 点按钮

async function renderPanel(key) {
  const Panel = mainEntries.get(key);
  const container = window.document.createElement('div');
  container.style.width = '1000px';
  container.style.height = '700px';
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(Panel));
  await settle(400);
  return { container, root };
}

{
  const { container, root } = await renderPanel('aifisher-canvas');

  const panelRoot = container.querySelector('[data-dsh-aifisher-canvas="panel"]');
  check('画布面板渲染出根容器', panelRoot !== null);
  check(
    '画布面板根容器自带 position:relative（absolute 以面板为基准，不盖侧边栏）',
    (panelRoot?.style.position ?? '') === 'relative',
    panelRoot?.style.position ?? '(none)',
  );

  const button = container.querySelector('[data-dsh-aifisher-exit="canvas"]');
  check('画布面板有退出按钮', button !== null);
  check(
    '退出按钮文案是「退出画布」',
    (button?.textContent ?? '').includes('退出画布'),
    button?.textContent ?? '(none)',
  );
  check(
    '退出按钮有可读的无障碍名',
    (button?.getAttribute('aria-label') ?? '').includes('退出画布'),
    button?.getAttribute('aria-label') ?? '(none)',
  );

  button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(120);
  check(
    '点「退出画布」→ layout.selectPanel(null)（回 DSH 对话）',
    layoutCalls.length === 1 && layoutCalls[0] === null,
    JSON.stringify(layoutCalls),
  );

  // 画布应用在 jsdom 里 import 不到（URL import 失败），此时应退化成错误态，
  // 但退出按钮必须仍然在——加载失败也得能走人。
  check(
    '画布加载失败时退出按钮仍然可用',
    container.querySelector('[data-dsh-aifisher-exit="canvas"]') !== null,
    (container.textContent ?? '').slice(0, 60),
  );

  root.unmount();
}

{
  const { container, root } = await renderPanel('aifisher-library');

  const panelRoot = container.querySelector('[data-dsh-aifisher-library="panel"]');
  check('素材库面板渲染出根容器', panelRoot !== null);
  check(
    '素材库面板根容器自带 position:relative',
    (panelRoot?.style.position ?? '') === 'relative',
    panelRoot?.style.position ?? '(none)',
  );

  const button = container.querySelector('[data-dsh-aifisher-exit="library"]');
  check('素材库面板有退出按钮（返回对话）', (button?.textContent ?? '').includes('返回对话'), button?.textContent ?? '(none)');

  button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(120);
  check(
    '点「返回对话」→ layout.selectPanel(null)',
    layoutCalls.length === 2 && layoutCalls[1] === null,
    JSON.stringify(layoutCalls),
  );

  root.unmount();
}

// 宿主不给 layout 服务时：面板照常注册，只是按钮不渲染（不能把插件拖崩）
{
  const bareEntries = new Map();
  let applied = true;
  try {
    mod.apply({
      slots: {
        inject: (_owner, callback) => {
          callback();
          return () => {};
        },
        register: (options, component) => {
          if (options?.name === 'main') bareEntries.set(options.key, component);
          return () => {};
        },
      },
    });
  } catch (error) {
    applied = false;
    check('没有 layout 服务时 apply() 不抛错', false, error.message);
  }
  if (applied) {
    check('没有 layout 服务时 apply() 不抛错', true);
    const Panel = bareEntries.get('aifisher-canvas');
    const container = window.document.createElement('div');
    window.document.body.appendChild(container);
    const root = createRoot(container);
    let renderError = null;
    try {
      root.render(React.createElement(Panel));
      await settle(200);
    } catch (error) {
      renderError = error;
    }
    check('没有 layout 服务时面板仍能渲染（按钮自动隐藏）', renderError === null, renderError ? String(renderError) : '');
    check(
      '没有 layout 服务时不渲染退出按钮',
      container.querySelector('[data-dsh-aifisher-exit="canvas"]') === null,
      '',
    );
    root.unmount();
  }
}

// ---------------------------------------------------------------- 5) 品牌图 + 外壳补丁

{
  const res = await host.dispatch('GET', '/aifisher-mark-white.svg');
  check(
    '画布左上角项目菜单的品牌图已托管（/aifisher-mark-white.svg）',
    res.status === 200 && /svg/.test(String(res.headers['content-type'] ?? '')) && res.body.includes('<svg'),
    `status=${res.status} type=${res.headers['content-type']}`,
  );
  const branded = await host.dispatch('GET', '/brand/aifisher-mark-white.svg');
  check('品牌图也在 /brand/ 前缀下可用', branded.status === 200, `status=${branded.status}`);

  const header = readFileSync(join(ROOT, 'vendor/aifisher/src/stable/dialogs/canvasHeader.tsx'), 'utf8');
  check(
    'vendor：画布头部改成 absolute（不再横跨 DSH 窗口压住侧边栏）',
    header.includes('af-canvas-header absolute top-0 left-0') && !header.includes('af-canvas-header fixed top-0 left-0'),
  );
  const sidebar = readFileSync(join(ROOT, 'vendor/aifisher/src/stable/dialogs/canvasSidebar.tsx'), 'utf8');
  check('vendor：左侧节点工具条改成 absolute', sidebar.includes('absolute left-4 top-1/2'));
  const controls = readFileSync(join(ROOT, 'vendor/aifisher/src/stable/dialogs/canvasViewportControls.tsx'), 'utf8');
  check(
    'vendor：缩放控件/快捷键问号改成 absolute',
    controls.includes('absolute bottom-6 left-6 h-[42px]') && controls.includes('absolute bottom-6 left-[240px]'),
  );
  const minimap = readFileSync(join(ROOT, 'vendor/aifisher/src/stable/dialogs/canvasMinimap.tsx'), 'utf8');
  check('vendor：小地图改成 absolute', minimap.includes('absolute bottom-[80px] left-6'));

  const product = readFileSync(join(ROOT, 'lib/canvas/canvas-app.js'), 'utf8');
  check('画布产物里头部已是 absolute（补丁真的进了产物）', product.includes('af-canvas-header absolute top-0 left-0'));
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
