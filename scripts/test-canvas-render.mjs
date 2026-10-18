/**
 * 画布渲染回归测试（jsdom）。
 *
 * 目标：在没有真实浏览器的前提下，把 `lib/canvas/canvas-app.js` **真的挂起来渲染一次**，
 * 并把画布内部的 fetch 接到 host 半真实的路由处理器上（同一个进程里跑插件 apply()），
 * 于是这一条链就全通了：
 *
 *   mountCanvas → CanvasStage → CanvasApplication(dashboard) → useWorkflow → 本地后端
 *   → 项目列表回到界面 → 渲染出项目卡片
 *
 * 断言三件事：
 *   1. 画布应用能 import 并挂载（模块图健全）；
 *   2. 渲染出 dashboard 结构，并且**从本地后端取回了项目**（列表内容出现在 DOM 里）；
 *   3. 整个渲染过程**没有运行时错误**（画布把异常回传到 /diagnostics，这里读回来）。
 *
 * 说明：jsdom 不是浏览器。它没有 WebGL/Canvas 2D，也没有真实布局，所以这里验的是
 * 「逻辑链路 + 不崩」，视觉仍然要在页面里看。
 *
 * 用法：node scripts/test-canvas-render.mjs   （需要先 build）
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://127.0.0.1:19387';
const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

// ---------------------------------------------------------------- 1) 起 host 半（假 webServer，真路由）

const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-aifisher-render-'));
process.env.DSH_HOME = fakeHome;

const routes = new Map();
const fakeWebServer = {
  register(route) {
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  },
};
const ctxStub = {
  get(name) {
    if (name === 'webServer') return fakeWebServer;
    if (name === 'skills') return { list: async () => [], get: async () => null };
    return undefined;
  },
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: () => () => {} },
};

const hostMod = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
hostMod.apply(ctxStub);

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
  }
  writeHead(status, headers) {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    callback();
  }
  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function pickRoute(pathname) {
  let best = null;
  for (const [prefix, route] of routes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, route };
    }
  }
  return best?.route ?? null;
}

async function dispatch(method, url, body) {
  const target = new URL(url, ORIGIN);
  const route = pickRoute(target.pathname);
  if (!route) return { status: 404, body: JSON.stringify({ error: 'no route', path: target.pathname }), headers: { 'content-type': 'application/json' } };
  // 上游客户端的长轮询在真机上由后端挂起 20s；这里给个短挂起，避免测试里 20s 空等 + 忙循环
  if (target.pathname.endsWith('/agent/external/poll')) {
    await new Promise((done) => setTimeout(done, 300));
    return { status: 200, body: '[]', headers: { 'content-type': 'application/json' } };
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = method;
  req.url = `${target.pathname}${target.search}`;
  req.headers = { host: target.host, origin: ORIGIN };
  const res = new FakeResponse();
  await route.handler(req, res);
  if (!res.writableFinished) await new Promise((done) => res.once('finish', done));
  return { status: res.statusCode, body: res.text(), headers: res.headers };
}

/** 直接调 host 路由（测试自己造数据用，不经过画布）。 */
async function hostApi(method, path, body) {
  const result = await dispatch(method, `/api/aifisher/canvas${path}`, body);
  return { status: result.status, json: () => JSON.parse(result.body) };
}

// ---------------------------------------------------------------- 2) jsdom 环境

const { JSDOM } = await import('jsdom');
const dom = new JSDOM(
  '<!doctype html><html><head></head><body><div id="dsh-aifisher-host"></div></body></html>',
  { url: `${ORIGIN}/`, pretendToBeVisual: true },
);
const { window } = dom;

// jsdom 缺的能力补上；补不了的（canvas 2D/WebGL）返回 null，让上游代码走降级分支
class StubObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
window.ResizeObserver = StubObserver;
window.IntersectionObserver = StubObserver;
window.matchMedia ??= () => ({
  matches: false,
  media: '',
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
window.requestIdleCallback ??= (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
window.EventSource ??= class {
  constructor() {}
  close() {}
  addEventListener() {}
};
window.HTMLCanvasElement.prototype.getContext = () => null;
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';

/** 相对路径 fetch → 本进程里的 host 路由（等价于浏览器的同源请求）。 */
const fetchCalls = [];
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  const method = String(init.method ?? 'GET').toUpperCase();
  fetchCalls.push(`${method} ${url}`);
  const { status, body, headers } = await dispatch(method, url, init.body ? JSON.parse(String(init.body)) : undefined);
  return new Response(body, { status, headers });
};

const globals = {
  window,
  document: window.document,
  location: window.location,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLCanvasElement: window.HTMLCanvasElement,
  HTMLDivElement: window.HTMLDivElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  HTMLDocument: window.HTMLDocument,
  ShadowRoot: window.ShadowRoot ?? null,
  NodeList: window.NodeList,
  EventTarget: window.EventTarget,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  PointerEvent: window.PointerEvent ?? window.MouseEvent,
  DragEvent: window.DragEvent ?? window.Event,
  ClipboardEvent: window.ClipboardEvent ?? window.Event,
  InputEvent: window.InputEvent ?? window.Event,
  FocusEvent: window.FocusEvent ?? window.Event,
  DOMRect: window.DOMRect,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  requestIdleCallback: window.requestIdleCallback,
  ResizeObserver: StubObserver,
  IntersectionObserver: StubObserver,
  MutationObserver: window.MutationObserver,
  matchMedia: window.matchMedia,
  fetch: window.fetch,
  EventSource: window.EventSource,
  DOMParser: window.DOMParser,
  Image: window.Image,
  Audio: window.Audio ?? class { play() {} pause() {} },
  File: window.File,
  Blob: window.Blob,
  FileReader: window.FileReader,
  FormData: window.FormData,
  XMLHttpRequest: window.XMLHttpRequest,
  alert: () => {},
};
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });

// ---------------------------------------------------------------- 3) 先放一个项目进本地后端

{
  const save = await hostApi('POST', '/workflows', {
    id: 'render-proj',
    revision: 0,
    title: '渲染验证项目',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目写入本地后端', save.status === 200 && save.json().revision === 1, JSON.stringify(save.json()));
}

// ---------------------------------------------------------------- 4) 挂载画布应用

const canvasApp = await import(pathToFileURL(join(ROOT, 'lib/canvas/canvas-app.js')).href);
check('画布应用导出 mountCanvas', typeof canvasApp.mountCanvas === 'function');

const container = window.document.createElement('div');
container.className = 'af-canvas-mount';
container.style.width = '1280px';
container.style.height = '800px';
window.document.body.appendChild(container);

let handle = null;
let mountError = null;
try {
  handle = canvasApp.mountCanvas(container);
} catch (error) {
  mountError = error;
}
check('mountCanvas 不抛错', mountError === null, mountError ? String(mountError && mountError.stack).split('\n').slice(0, 4).join(' | ') : '');

/** 让 React 渲染 + 网络回调跑完。 */
async function settle(ms = 600) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((done) => setTimeout(done, 25));
  }
}
await settle(1200);

const html = container.innerHTML;
check('画布渲染出了 DOM', html.length > 200, `html=${html.length}B`);
check('渲染出 dashboard 结构', html.includes('data-fisherai-project-dashboard') || html.includes('aifisher') || html.includes('项目'), html.slice(0, 160).replace(/\s+/g, ' '));
check('dashboard 显示了本地后端里的项目', html.includes('渲染验证项目'), html.includes('渲染验证项目') ? '' : `html head=${html.slice(0, 240).replace(/\s+/g, ' ')}`);
// v1.15：用户「移除这两个功能」—— 看板头部那两个站外入口（AIFISHER「API 与服务」、
// Work-Fisher「教程与案例」）不该再出现。判定用注入的 data 属性 + 两个文案，
// 因为有观察者会反复 reconcile，只看一次 snapshot 不够。
check('看板头部没有站外资源入口（v1.15 移除 AIFISHER / Work-Fisher）',
  !window.document.querySelector('[data-fisherai-resource-links="true"]') &&
    !html.includes('API 与服务') &&
    !html.includes('教程与案例') &&
    !html.includes('api.work-fisher.com') &&
    !html.includes('space.bilibili.com'),
  `resourceLinks=${window.document.querySelectorAll('[data-fisherai-resource-links="true"]').length} / 文案=${html.includes('API 与服务') || html.includes('教程与案例')}`);
check('看板头部的设置按钮仍在（只删掉两个站外入口，没连坐）',
  window.document.querySelector('[data-fisherai-dashboard-settings="true"]') !== null,
  window.document.querySelector('[data-fisherai-dashboard-settings="true"]')?.textContent ?? '(missing)');
check('画布向前端注入了样式表', window.document.getElementById('dsh-aifisher-canvas-styles') !== null);
check('样式含面板内适配（视口尺寸类退回容器）',
  (window.document.getElementById('dsh-aifisher-canvas-styles')?.textContent ?? '').includes('.af-canvas-mount .w-screen'),
  '');
check('画布根视图确实用了 w-screen（所以适配规则是必需的）', html.includes('w-screen') || html.includes('h-screen'), '');
check('画布确实请求了本地后端', fetchCalls.some((call) => call.includes('/api/aifisher/canvas/workflows')), fetchCalls.slice(0, 6).join(' , ') || '(none)');

// ---------------------------------------------------------------- 4b) v1.2 的三块前端能力真挂上了
//
// v1.1 把 host 侧 /media-download/* 与 /prompt-assistant/* 写好了却没装前端：
// 节点工具条的「下载」只认 window.__FISHERAI_MEDIA_DOWNLOAD__，缺了就直接抛「素材不可用」；
// 画布头部也一直没有 ComfyUI 状态胶囊。这里逐条断言全局适配器与胶囊 DOM 真到位。
check('装上了下载适配器（window.__FISHERAI_MEDIA_DOWNLOAD__）',
  typeof window.__FISHERAI_MEDIA_DOWNLOAD__?.download === 'function' &&
    typeof window.__FISHERAI_MEDIA_DOWNLOAD__?.getSettings === 'function',
  String(typeof window.__FISHERAI_MEDIA_DOWNLOAD__));
check('装上了提示词助手客户端（window.__FISHERAI_PROMPT_ASSISTANT__）',
  typeof window.__FISHERAI_PROMPT_ASSISTANT__?.optimizePrompt === 'function',
  String(typeof window.__FISHERAI_PROMPT_ASSISTANT__));
check('装上了本机运行环境客户端（window.__FISHERAI_LOCAL_RUNTIME__）',
  typeof window.__FISHERAI_LOCAL_RUNTIME__?.getComfyProcess === 'function',
  String(typeof window.__FISHERAI_LOCAL_RUNTIME__));
check('ComfyUI 状态胶囊已挂载（host 报 idle 时也要出现）',
  window.document.querySelector('[data-fisherai-comfyui-log-toggle]') !== null,
  window.document.querySelector('[data-fisherai-comfyui-log-toggle]')?.textContent ?? '(missing)');

// ---------------------------------------------------------------- 4c) v1.34 提示词不许沿谱系串味
//
// 用户原话：「提示词输入出现污染问题，前面的提示词会输入到后边的提示词」。
// 上游 buildPrompt 是**沿 parentIds 一路往上爬**收集文本节点的，于是
//   Text（整段场景描述） → 图片 A → 图片 B（只写了「修复一下…」）
// 这条链上，B 的输入框里只有那句话，真正发出去的却是「整段场景描述 + 那句话」
// （素材库侧车 media/<项目>/images/<文件>.json 的 prompt 字段就是这个拼接结果）。
// 下面拿**构建产物** lib/canvas/canvas-app.js 里真正在用的调度器验一遍：
// 直连的文本节点照旧生效，隔层的祖先不再继承。
{
  const scheduler = window.__FISHERAI_GENERATION_SCHEDULER__;
  check('装上了生成调度器（window.__FISHERAI_GENERATION_SCHEDULER__）',
    typeof scheduler?.buildPrompt === 'function', String(typeof scheduler));
  if (typeof scheduler?.buildPrompt === 'function') {
    const scene = '当代草原场景，午后。一位25岁的成熟女性，松松挽起的低盘发。';
    const fix = '修复一下，人物出现了三条腿';
    const graph = [
      { id: 'text-scene', type: 'Text', x: 0, y: 0, prompt: '', textContent: scene },
      { id: 'image-a', type: 'Image', x: 420, y: 0, prompt: '', parentIds: ['text-scene'] },
      { id: 'image-b', type: 'Image', x: 840, y: 0, prompt: fix, parentIds: ['image-a'] },
    ];
    const direct = scheduler.buildPrompt(graph, graph[1]);
    check('直连文本节点的图片仍然带上那段正文（原有能力不变）', direct === scene, direct);
    const downstream = scheduler.buildPrompt(graph, graph[2]);
    check('隔一层的祖先正文不再并进下游节点的提示词（v1.34 污染修复）',
      downstream === fix, downstream);
    const deeper = [...graph,
      { id: 'image-c', type: 'Image', x: 1260, y: 0, prompt: '再来一张', parentIds: ['image-b'] }];
    const thirdHop = scheduler.buildPrompt(deeper, deeper[3]);
    check('第三跳也不继承最上游的正文', thirdHop === '再来一张', thirdHop);
    // 直接连两个文本节点：两段都发，顺序按 y 再按 x（老行为保留，别把直连能力砍了）
    const twins = [
      { id: 'text-late', type: 'Text', x: 500, y: 0, prompt: '', textContent: '第二段' },
      { id: 'text-early', type: 'Text', x: 0, y: 0, prompt: '', textContent: '第一段' },
      { id: 'image-two', type: 'Image', x: 900, y: 0, prompt: '', parentIds: ['text-late', 'text-early'] },
    ];
    const twoTexts = scheduler.buildPrompt(twins, twins[2]);
    check('直接连两个文本节点时按 y/x 顺序拼接（老行为保留）',
      twoTexts === '第一段\n第二段', JSON.stringify(twoTexts));
    // 文本节点：自己那一段（ownText）+ 直连的文本父节点都照旧进请求
    const textChain = [
      { id: 'text-up', type: 'Text', x: 0, y: 0, prompt: '', textContent: '上游正文' },
      { id: 'text-down', type: 'Text', x: 400, y: 0, prompt: '', textContent: '自己的正文', parentIds: ['text-up'] },
    ];
    const textNode = scheduler.buildPrompt(textChain, textChain[1]);
    check('文本节点自己 + 直连文本父节点都进请求（老行为保留）',
      textNode === '上游正文\n自己的正文', JSON.stringify(textNode));
    // 节点自己的 prompt 与直连文本同时存在时：两段都在，正文在前
    const mixed = [
      { id: 'text-mix', type: 'Text', x: 0, y: 0, prompt: '', textContent: '接进来的正文' },
      { id: 'image-mix', type: 'Image', x: 500, y: 0, prompt: '自己的提示词', parentIds: ['text-mix'] },
    ];
    const mixedPrompt = scheduler.buildPrompt(mixed, mixed[1]);
    check('直连正文 + 自己的提示词两段都在（拼接顺序不变）',
      mixedPrompt === '接进来的正文\n自己的提示词', JSON.stringify(mixedPrompt));
  }
}

// ---------------------------------------------------------------- 5) 渲染期没有运行时错误

{
  const diag = await hostApi('GET', '/diagnostics?limit=50');
  const entries = diag.json().entries ?? [];
  const errors = entries.filter((entry) => entry.level === 'error');
  check('渲染期间没有运行时错误', errors.length === 0, errors.map((e) => `${e.message}`).join(' | ') || '(none)');
  const info = entries.filter((entry) => entry.level === 'info');
  check('画布自报已加载（诊断通道连通）', info.some((entry) => entry.message.includes('画布应用已加载')), JSON.stringify(info).slice(0, 200));
  const measured = info.find((entry) => entry.message.includes('画布容器已测量'));
  // jsdom 没有布局引擎，尺寸必然量到 0 —— 这里只断言「自检确实上报了」。
  // 真机上的宽度/高度就靠这条诊断回报（agent 读 /diagnostics 即可判断容器有没有尺寸）。
  check('画布自报容器尺寸（布局自检已生效）', measured !== undefined && measured.detail !== undefined, JSON.stringify(measured?.detail ?? null));
  const loaded = info.find((entry) => entry.message.includes('画布应用已加载'));
  const installers = loaded?.detail?.installers ?? [];
  check('装配清单包含 v1.2 新装的四个模块',
    ['installMediaDownloadFileName', 'installPromptAssistant', 'installLocalRuntimeClient', 'installComfyLogPanel']
      .every((name) => installers.includes(name)),
    installers.join(','));
}

// ---------------------------------------------------------------- 6) 卸载要干净

if (handle) {
  let disposeError = null;
  try {
    handle.dispose();
  } catch (error) {
    disposeError = error;
  }
  check('dispose 不抛错', disposeError === null, disposeError ? String(disposeError) : '');
  check('dispose 后样式表被移除', window.document.getElementById('dsh-aifisher-canvas-styles') === null);
  check('dispose 后容器被清空', container.innerHTML === '', `${container.innerHTML.length}B`);
  // 胶囊挂在 document.body 上（不在容器里），必须靠装配的撤销函数摘掉，否则关掉面板后
  // 它会留在 DSH 对话页面上。
  check('dispose 后 ComfyUI 胶囊被摘掉（不留在 DSH 页面上）',
    window.document.querySelector('[data-fisherai-comfyui-log-host]') === null);
}

rmSync(fakeHome, { recursive: true, force: true });
void existsSync;

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
