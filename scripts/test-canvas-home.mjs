/**
 * 画布首屏回归（v1.86）：「打开画布」点一次就进画布。
 *
 * 用户 2026-10-31 原话：「打开无限画布后要点击两次才能进入画布，第一次点击好像才正式
 * 激活项目管理器」。
 *
 * 真机根因（用 CDP 真鼠标 + 20ms 采样在正在跑的 DSH 里复现过）：
 *   点「打开画布」只派发 `fisherai:open-project`，vendor 还要过一遍 `loadProject`
 *   （HTTP + reset）才 `setView('canvas')`。这中间项目库先 `closeCanvasPage()`，
 *   而首屏看门（homePage 的 ensureHome）看到「底下还是旧看板 + 页面层一屏都没开」
 *   就判定「用户回到了项目库」，立刻把项目库**重新挂一份**：列表重拉、视图归位、
 *   卡片墙闪一下——画布在它下面悄悄起来了。于是用户必须再点一次（第二次时
 *   `#canvas-background` 已经在，关掉就不会再弹回来）。
 *
 * 这一套只验这条链路（一个进程只挂一次画布，进度与 test-canvas-pages 分开）：
 *   ① 没有 resume 时首屏 = 项目库（盖住 vendor 旧看板）；
 *   ② 点一次「打开画布」→ vendor 画布底盘 `#canvas-background` 出现；
 *   ③ 全程不允许出现「项目库不在 && 画布没起」的帧（那就是被弹回来的窗口）；
 *   ④ 项目库只挂过一份、`fisherai:open-project` 只派发一次、最后关掉露出画布。
 *
 * ⚠️ jsdom 的假 fetch 是微任务级的：不给 `/workflows/<id>` 加延迟，项目会在下一帧
 * 之前就切完，这条竞态永远复现不出来（真机上必然发生）。所以这里按真机延迟来打。
 *
 * 用法：node scripts/test-canvas-home.mjs（需要先 build）
 */
import { createCanvasDom, mountCanvasApp, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const PROJECT_ID = 'home-single-click';

const host = await startHost();
const DOC = {
  id: PROJECT_ID,
  revision: 0,
  title: '渡口 · 单镜',
  nodes: [
    {
      id: 'n1',
      type: 'Image',
      x: 0,
      y: 0,
      title: '镜头 01',
      prompt: '首屏回归',
      status: 'success',
      resultUrl: '/api/aifisher/canvas/media/home-single-click/images/a.png',
      parentIds: [],
    },
  ],
  groups: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};
const saved = await host.hostApi('POST', '/workflows', DOC);
check('预置一个项目给首屏项目库', saved.status === 200, String(saved.text).slice(0, 80));

// 真机 loadProject 要过一次网络；这里按 200ms 打（见文件头）。
const slowDispatch = async (method, url, body, context) => {
  const path = String(url).split('?')[0];
  if (method === 'GET' && /\/workflows\/[^/]+$/.test(path)) await settle(200);
  return host.dispatch(method, url, body, context);
};

const { window, fetchCalls } = await createCanvasDom({ dispatch: slowDispatch });
// 故意不调用 seedResume：这就是「打开无限画布」的第一次，vendor 从 dashboard 起。
const { container, handle } = await mountCanvasApp(window);
const doc = window.document;

const waitFor = async (probe, timeout = 12000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = probe();
    if (value) return value;
    await settle(80);
  }
  return null;
};

const pageSel = '[data-fisherai-page="projects"]';
const page = await waitFor(() => doc.querySelector(pageSel));
check('打开画布 = 项目库首屏（页面层挂上了）', Boolean(page));
check(
  '项目库铺在画布容器里（兄弟图层，不是塞进 vendor 树）',
  page?.closest('.af-canvas-mount') === container,
);
check(
  '项目库压住 vendor 那张旧看板（首屏不再露出旧界面）',
  Boolean(doc.querySelector('[data-fisherai-project-dashboard="true"]')),
);

// 卡片墙要等一次 /projects 回来才有内容。
const openButton = await waitFor(() =>
  [...doc.querySelectorAll(`${pageSel} button`)].find((button) =>
    String(button.textContent ?? '').replace(/\s+/g, '').includes('打开画布'),
  ),
);
check('首屏项目库上有「打开画布」主按钮', Boolean(openButton));

// 采样：项目库在不在 / 画布底盘在不在；同时数「项目库被挂了几份」与 opening 事件次数。
const samples = [];
const pageNodes = new Set();
let openEvents = 0;
const onOpen = () => {
  openEvents += 1;
};
window.addEventListener('fisherai:open-project', onOpen, true);
const sampler = window.setInterval(() => {
  const current = doc.querySelector(pageSel);
  if (current) pageNodes.add(current);
  samples.push({
    page: Boolean(current),
    canvas: Boolean(doc.getElementById('canvas-background')),
  });
}, 10);

// 项目库每次「重新打开」都会把列表重拉一遍（`useEffect([open, pageKey])` → reload）。
// 所以「/projects 被多拉了一次」就是「项目库被首屏看门重开过」的硬证据 ——
// 不依赖帧采样能不能撞上那一瞬间（jsdom 里 React 可能把关闭+重开并到同一帧）。
const projectListFetches = () =>
  fetchCalls.filter((call) => call === 'GET /api/aifisher/canvas/projects').length;
const listFetchesBefore = projectListFetches();

openButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

const deadline = Date.now() + 6000;
while (Date.now() < deadline && !doc.getElementById('canvas-background')) await settle(50);
await settle(500);
window.clearInterval(sampler);
window.removeEventListener('fisherai:open-project', onOpen, true);

const gapFrames = samples.filter((item) => !item.page && !item.canvas).length;
check('点一次「打开画布」就进了画布（vendor 画布底盘出现）', Boolean(doc.getElementById('canvas-background')));
check(
  '项目库没有先关掉再弹回来（不存在「项目库不在 && 画布没起」的帧）',
  gapFrames === 0,
  `${gapFrames} / ${samples.length} 帧`,
);
check('项目库只挂过一份（没有被首屏看门重开）', pageNodes.size === 1, `nodes=${pageNodes.size}`);
check(
  '项目库没有被重开（没有为了重开再拉一遍 /projects）',
  projectListFetches() === listFetchesBefore,
  `${listFetchesBefore} → ${projectListFetches()}`,
);
check('一次点击只派发一次 fisherai:open-project', openEvents === 1, `events=${openEvents}`);
check('项目库最后关掉了，画布露出来', !doc.querySelector(pageSel));
check(
  '画布真的切到了那个项目（头部标题变成项目名）',
  String(doc.querySelector('[title="点击重命名"]')?.textContent ?? '').includes('渡口'),
  String(doc.querySelector('[title="点击重命名"]')?.textContent ?? '(none)').slice(0, 40),
);

handle?.dispose?.();
await settle(150);

console.log(lines.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}  (${lines.length} checks)`);
console.log(`SUMMARY pass=${lines.length - failures} fail=${failures}`);
process.exit(failures === 0 ? 0 : 1);
