/**
 * 画布皮肤配套的回归（v1.81）：界面缩放 + 生成中噪波圆点阵。
 *
 * 只验「纯逻辑 + DOM 结构」，不验像素（像素在 browser-check 的 canvas-ui-scale 场景与
 * 设计稿对照里看）。这样跑一次几秒钟，不用起浏览器。
 *
 * 用法：node scripts/test-canvas-skin.mjs（需要先 build）
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const { JSDOM } = await import('jsdom');
const dom = new JSDOM(
  `<!doctype html><html data-af-theme="dark"><head></head><body>
    <div class="af-canvas-mount" id="mount"></div>
  </body></html>`,
  { url: 'http://127.0.0.1:19387/', pretendToBeVisual: true },
);

const { window } = dom;
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
window.HTMLCanvasElement.prototype.getContext = () => null;
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
window.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

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
  NodeList: window.NodeList,
  EventTarget: window.EventTarget,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  PointerEvent: window.PointerEvent ?? window.MouseEvent,
  DragEvent: window.DragEvent ?? window.Event,
  InputEvent: window.InputEvent ?? window.Event,
  FocusEvent: window.FocusEvent ?? window.Event,
  DOMRect: window.DOMRect,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  ResizeObserver: StubObserver,
  IntersectionObserver: StubObserver,
  MutationObserver: window.MutationObserver,
  matchMedia: window.matchMedia,
  fetch: window.fetch,
  Image: window.Image,
  File: window.File,
  Blob: window.Blob,
  FileReader: window.FileReader,
  FormData: window.FormData,
  XMLHttpRequest: window.XMLHttpRequest,
  alert: () => {},
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });

const app = await import(pathToFileURL(join(ROOT, 'lib/canvas/canvas-app.js')).href);

// ---------------------------------------------------------------- 1) 界面缩放

const ui = {
  steps: app.UI_SCALE_STEPS,
  initial: app.currentUiScale(),
};

check('界面缩放：档位就是设计稿那 6 档（80/90/100/110/125/150）',
  JSON.stringify(ui.steps) === JSON.stringify([0.8, 0.9, 1, 1.1, 1.25, 1.5]),
  JSON.stringify(ui.steps));

const installed = app.installCanvasUiScale();
check('界面缩放：装上就把 --af-ui-scale 写进 documentElement',
  document.documentElement.style.getPropertyValue('--af-ui-scale') !== '',
  document.documentElement.style.getPropertyValue('--af-ui-scale'));

app.setUiScale(1.25);
check('界面缩放：setUiScale 真改了 CSS 变量',
  document.documentElement.style.getPropertyValue('--af-ui-scale') === '1.25',
  document.documentElement.style.getPropertyValue('--af-ui-scale'));
check('界面缩放：值落进 localStorage（下次打开沿用）',
  window.localStorage.getItem('af.uiScale') === '1.25',
  String(window.localStorage.getItem('af.uiScale')));

app.setUiScale(9);
check('界面缩放：上限夹到 150%', app.currentUiScale() === 1.5, String(app.currentUiScale()));
app.resetUiScale();
check('界面缩放：点击读数恢复 100%', app.currentUiScale() === 1, String(app.currentUiScale()));

const before = app.currentUiScale();
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }));
check('界面缩放：Ctrl + = 放大一档', app.currentUiScale() > before,
  `${before} → ${app.currentUiScale()}`);
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }));
check('界面缩放：Ctrl + 0 复位 100%', app.currentUiScale() === 1, String(app.currentUiScale()));

// 输入框里的 Ctrl+± 不抢（文本编辑器自己用）
const input = document.createElement('input');
document.body.append(input);
input.focus();
const scaleBeforeInput = app.currentUiScale();
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }));
check('界面缩放：输入框里的 Ctrl + = 不抢（留给文本编辑）',
  app.currentUiScale() === scaleBeforeInput, String(app.currentUiScale()));
input.remove();

installed();
check('界面缩放：卸载后 CSS 变量被撤掉（不污染 DSH 其它界面）',
  document.documentElement.style.getPropertyValue('--af-ui-scale') === '');

// ---------------------------------------------------------------- 2) 生成中噪波点阵

const host = document.getElementById('mount');
const overlay = document.createElement('div');
overlay.setAttribute('data-fisherai-regeneration-overlay', 'true');
overlay.className = 'af-generation-waiting';
overlay.innerHTML = '<span class="af-generation-waiting-ring"></span><strong>正在生成</strong>';
Object.defineProperty(overlay, 'clientWidth', { value: 340, configurable: true });
Object.defineProperty(overlay, 'clientHeight', { value: 466, configurable: true });
host.append(overlay);

const disposeDots = app.installCanvasGenerationDots();

const layer = overlay.querySelector('.af-gen-dots');
check('生成中：遮罩里插进了点阵层（插在第一个孩子，不挡中央文字）',
  Boolean(layer) && overlay.firstElementChild === layer,
  overlay.firstElementChild?.className ?? '');

const circles = overlay.querySelectorAll('.af-gen-dots circle');
check('生成中：点距 20px、340×466 的节点约 391 个圆点（设计稿同规格）',
  circles.length === 391,
  String(circles.length));
check('生成中：默认几乎不可见（缺省半径 0.9 / 透明度 0.025）',
  circles[0]?.getAttribute('r') === '0.9' || Number(circles[0]?.getAttribute('r')) < 1.4,
  `r=${circles[0]?.getAttribute('r')} alpha=${circles[0]?.getAttribute('fill-opacity')}`);
check('生成中：圆点颜色是青色（不是白噪波）',
  circles[0]?.getAttribute('fill') === '#5eead4',
  String(circles[0]?.getAttribute('fill')));
check('生成中：底部有一条不定进度线', Boolean(overlay.querySelector('.af-gen-bar')));

// 噪波是随时间变化的：等两帧后应有圆被放大/提亮
await new Promise((done) => setTimeout(done, 120));
const bright = [...circles].filter((circle) => Number(circle.getAttribute('fill-opacity')) > 0.25);
check('生成中：噪波真的在挑一部分圆放大发光（不是整层呼吸、也不是满屏全亮）',
  bright.length > 10 && bright.length < circles.length * 0.5,
  `${bright.length}/${circles.length}`);

// React 重渲染把层冲掉时补回来
layer.remove();
await new Promise((done) => setTimeout(done, 0));
check('生成中：层被冲掉后会自己补回来（MutationObserver）',
  Boolean(overlay.querySelector('.af-gen-dots') && overlay.querySelector('svg')));

const report = app.generationDotsReport();
check('生成中：诊断读数能看出挂了几个遮罩 / 多少个点',
  report.overlays === 1 && report.dots === 391,
  JSON.stringify(report));

// 动画持续性（v1.88 修「一张静帧」）：200ms 内圆点的 r / 透明度必须真的在变
const painted = () =>
  [...overlay.querySelectorAll('.af-gen-dots circle')].map(
    (circle) => `${circle.getAttribute('r')}|${circle.getAttribute('fill-opacity')}`,
  );
const dotsBefore = painted();
await new Promise((done) => setTimeout(done, 200));
const dotsAfter = painted();
const moved = dotsAfter.filter((value, index) => value !== dotsBefore[index]).length;
check('生成中：点阵真的在动（200ms 内过半圆点在变，不是一张静帧）',
  dotsAfter.length === 391 && moved > dotsAfter.length * 0.5,
  `${moved}/${dotsAfter.length}`);

// 上一轮生成结束（遮罩摘掉、rAF 停）→ 下一轮生成开始：循环重启后必须立刻动。
// 回归的是「ensureLoop 没清 lastPaint，time - lastPaint 一直为负，新点阵冻住上一轮的时长」。
disposeDots();
const disposeRestart = app.installCanvasGenerationDots();
const resumeBefore = painted();
await new Promise((done) => setTimeout(done, 200));
const resumeAfter = painted();
const resumed = resumeAfter.filter((value, index) => value !== resumeBefore[index]).length;
check('生成中：停一轮再挂回来，点阵立刻恢复动画（不沿用上一轮的时间）',
  resumed > resumeAfter.length * 0.5,
  `${resumed}/${resumeAfter.length}`);

disposeRestart();
check('生成中：卸载后把自己插的层清干净',
  !overlay.querySelector('.af-gen-dots') && !overlay.querySelector('.af-gen-bar'));

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
