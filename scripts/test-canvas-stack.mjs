/**
 * 「多选折叠成一叠」的**叠内切换**回归（v1.37）。
 *
 * 用户原话（2026-10-17，附一张叠了 3 张图的画布截图）：
 * 「给这种折叠起来的图添加一个切换按钮」。
 *
 * v1.21 的折叠只给了「展开」：卡上永远只看得见宿主那一张，想看叠在下面的另外两张
 * 只能展开（节点摊回画布）→ 看完再重新多选 + 折叠。v1.37 在宿主卡左下角加了
 * `N 张叠图 | 切换 2/3 | 展开` 这条控制条，切换 = **不展开**也能翻看这一叠。
 *
 * 这个套件守两件事：
 *   A. **纯逻辑**（`canvasApp.rotateStackHost`，跑在构建产物上）：
 *      环形顺序（含 Shift 往回拨之后再往前拨方向不能反）、壳字段不动、三张图一张不丢、
 *      不改入参、单张时不动作。
 *   B. **真 DOM**（jsdom 里真挂起画布、真点按钮）：
 *      控制条/计数/小标题会跟着换、卡不跳、不凭空多节点、存盘后 `stackPosition`
 *      与内容都在文档里、「展开」照旧能把三张摊回画布。
 *
 * 用法：node scripts/test-canvas-stack.mjs   （需要先 build）
 */
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
  }
  return last;
}

// ---------------------------------------------------------------- 0) 纯逻辑（不依赖 DOM）
//
// 先验算法，再验接线：真点击那条如果红了，就能立刻分清是「算法错」还是「按钮没接上」。

const PROJECT_ID = 'proj-canvas-stack';
const IMAGE = (file) => `/api/aifisher/canvas/media/${PROJECT_ID}/images/${file}`;
const P1 = IMAGE('stack-1.png');
const P2 = IMAGE('stack-2.png');
const P3 = IMAGE('stack-3.png');

const makeNode = (id, title, url, extra = {}) => ({
  id,
  type: 'Image',
  x: 0,
  y: 0,
  title,
  prompt: title,
  status: 'success',
  model: 'Upload',
  resultUrl: url,
  resultUrls: [url],
  resultAspectRatio: '320/240',
  aspectRatio: '4:3',
  parentIds: [],
  projectId: PROJECT_ID,
  width: 320,
  height: 240,
  ...extra,
});

const host = await startHost();
{
  const hostNode = makeNode('stack-host', '第一张', P1);
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '叠图切换验证',
    nodes: [
      {
        ...hostNode,
        stackItems: [
          makeNode('stack-2', '第二张', P2, { x: 520, y: 0 }),
          makeNode('stack-3', '第三张', P3, { x: 1040, y: 0 }),
        ],
      },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置「一叠 3 张」的项目写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { container, canvasApp, handle } = await mountCanvasApp(window);
await settle(1500);
const doc = window.document;

// ---------------------------------------------------------------- 0) 纯逻辑（跑构建产物）
{
  const { rotateStackHost, stackCounterOf, stackTotalOf, stackPositionOf } = canvasApp;
  check(
    '产物导出了叠图切换的纯函数（rotateStackHost / stackCounterOf …）',
    typeof rotateStackHost === 'function' && typeof stackCounterOf === 'function',
    `${typeof rotateStackHost}/${typeof stackCounterOf}`,
  );

  const fold = {
    id: 'host',
    type: 'Image',
    x: 12,
    y: 34,
    title: 'A',
    prompt: 'A',
    resultUrl: 'a.png',
    parentIds: ['upstream'],
    width: 320,
    height: 240,
    stackItems: [
      { id: 'b', type: 'Image', x: 500, y: 0, title: 'B', prompt: 'B', resultUrl: 'b.png' },
      { id: 'c', type: 'Image', x: 900, y: 0, title: 'C', prompt: 'C', resultUrl: 'c.png' },
    ],
  };
  const before = JSON.parse(JSON.stringify(fold));

  check('纯函数：叠了 3 张（含宿主）', stackTotalOf(fold) === 3, String(stackTotalOf(fold)));
  check('纯函数：初始计数 = 1/3',
    stackCounterOf(fold).position === 1 && stackCounterOf(fold).total === 3,
    JSON.stringify(stackCounterOf(fold)));

  const next1 = rotateStackHost(fold, 1);
  check('纯函数：往下拨一张 → 显示 B（内容真的换过来了）',
    next1.title === 'B' && next1.resultUrl === 'b.png' && next1.prompt === 'B',
    `${next1.title}/${next1.resultUrl}`);
  check('纯函数：壳字段不动（id / 位置 / 类型 / 连线 / 尺寸）',
    next1.id === 'host' && next1.x === 12 && next1.y === 34 && next1.type === 'Image' &&
      JSON.stringify(next1.parentIds) === JSON.stringify(['upstream']) &&
      next1.width === 320 && next1.height === 240,
    `id=${next1.id} x=${next1.x} y=${next1.y} parentIds=${JSON.stringify(next1.parentIds)}`);
  check('纯函数：计数走到 2/3', stackCounterOf(next1).position === 2, JSON.stringify(stackCounterOf(next1)));
  check('纯函数：被换下去的那张没丢（进了叠里，还带着自己的 id）',
    next1.stackItems.length === 2 && next1.stackItems.some((item) => item.id === 'host' && item.title === 'A'),
    JSON.stringify(next1.stackItems.map((item) => `${item.id}:${item.title}`)));
  check('纯函数：不改入参（画布状态不能被动原地改）',
    JSON.stringify(fold) === JSON.stringify(before), '');

  const next2 = rotateStackHost(next1, 1);
  check('纯函数：再拨一张 → 显示 C，计数 3/3',
    next2.title === 'C' && stackCounterOf(next2).position === 3,
    `${next2.title}/${stackCounterOf(next2).position}`);
  const wrap = rotateStackHost(next2, 1);
  check('纯函数：再拨一张绕回来 → 显示 A，计数 1/3',
    wrap.title === 'A' && stackCounterOf(wrap).position === 1,
    `${wrap.title}/${stackCounterOf(wrap).position}`);
  check('纯函数：绕一圈后三张图一张不少',
    new Set([
      wrap.resultUrl,
      ...wrap.stackItems.map((item) => item.resultUrl),
    ]).size === 3, JSON.stringify([wrap.resultUrl, ...wrap.stackItems.map((item) => item.resultUrl)]));

  // 往回拨之后再往前拨，方向不能反 —— 这里钉的是 stackItems 的「下一个在前」语义。
  const back = rotateStackHost(fold, -1);
  check('纯函数：Shift 往回拨 → 显示 C（环形：A 的上一张是 C）',
    back.title === 'C' && stackCounterOf(back).position === 3,
    `${back.title}/${stackCounterOf(back).position}`);
  const forwardAgain = rotateStackHost(back, 1);
  check('纯函数：往回拨一次之后再往前拨，方向不反（回到 A，不是 B）',
    forwardAgain.title === 'A' && stackCounterOf(forwardAgain).position === 1,
    `${forwardAgain.title}/${stackCounterOf(forwardAgain).position}`);
  check('纯函数：往回拨也不丢图（A/B/C 都在）',
    new Set([forwardAgain.resultUrl, ...forwardAgain.stackItems.map((item) => item.resultUrl)]).size === 3,
    JSON.stringify([forwardAgain.resultUrl, ...forwardAgain.stackItems.map((item) => item.resultUrl)]));

  const single = { id: 'solo', type: 'Image', x: 0, y: 0, title: 'solo' };
  check('纯函数：没叠东西时切换 = 原样返回（不造空 stackItems）',
    rotateStackHost(single, 1) === single && stackPositionOf(single) === 0, '');
  check('纯函数：整圈（step = 张数）等于不动',
    rotateStackHost(fold, 3) === fold, '');
}

// ---------------------------------------------------------------- 1) 卡上的控制条
const node = await waitFor(() => doc.querySelector(`[data-node-id="stack-host"]`));
check('画布上渲染出叠图宿主卡', !!node);
const controls = node?.querySelector('[data-fisherai-stack-controls="true"]') ?? null;
check('宿主卡左下角有叠图控制条（v1.37 新增）', !!controls,
  node ? `buttons=${node.querySelectorAll('button').length}` : '(no node)');
check('控制条自报「这一叠 3 张 / 现在第 1 张」',
  controls?.getAttribute('data-fisherai-stack-total') === '3' &&
    controls?.getAttribute('data-fisherai-stack-position') === '1',
  `total=${controls?.getAttribute('data-fisherai-stack-total')} pos=${controls?.getAttribute('data-fisherai-stack-position')}`);

const switchButton = () => node?.querySelector('[data-fisherai-stack-switch="true"]') ?? null;
const expandButton = () => node?.querySelector('[data-fisherai-stack-badge="true"]') ?? null;
check('「切换」按钮真的在（是个 button，不是 div 假按钮）',
  switchButton()?.tagName === 'BUTTON', switchButton()?.tagName ?? '(missing)');
check('「切换」按钮带计数 1/3（用户能看出这叠有几张、现在第几张）',
  (switchButton()?.textContent ?? '').includes('1/3'), switchButton()?.textContent ?? '(missing)');
check('「切换」按钮有可读的 aria-label（不只靠数字）',
  /切换叠图/.test(switchButton()?.getAttribute('aria-label') ?? ''),
  switchButton()?.getAttribute('aria-label') ?? '(missing)');
check('旧的「展开」按钮还在（切换没把解散功能挤掉）',
  expandButton() !== null && (expandButton()?.textContent ?? '').includes('展开'),
  expandButton()?.textContent ?? '(missing)');
check('卡后仍然垫着两层「纸」（切换不改叠图外观）',
  node?.querySelectorAll('[data-fisherai-stack-layer]').length === 2,
  String(node?.querySelectorAll('[data-fisherai-stack-layer]').length));

// ---------------------------------------------------------------- 2) 真点按钮：内容跟着换
const cardImage = () => node?.querySelector('[data-fisherai-image-preview] img[alt="生成结果"]')?.getAttribute('src') ?? null;
const cardTitle = () => node?.querySelector('[data-af-node-title]')?.textContent ?? '';
const transformOf = () => node?.style.transform ?? '';

check('初始显示第 1 张（第一张）', cardImage() === P1 && cardTitle().includes('第一张'),
  `${cardImage()} / ${cardTitle()}`);
const transformBefore = transformOf();

async function clickSwitch(shiftKey = false) {
  const button = switchButton();
  if (!button) return;
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  await settle(220);
}

await clickSwitch();
check('点一下「切换」→ 卡上换成第 2 张（图真的换了）', cardImage() === P2, cardImage() ?? '(null)');
check('点一下「切换」→ 小标题也跟着换成第二张（不是只换渲染）',
  cardTitle().includes('第二张'), cardTitle());
check('点一下「切换」→ 计数变 2/3',
  (switchButton()?.textContent ?? '').includes('2/3') &&
    controls?.getAttribute('data-fisherai-stack-position') === '2',
  `${switchButton()?.textContent} / pos=${controls?.getAttribute('data-fisherai-stack-position')}`);
check('切换时卡不跳（节点位置/尺寸一个像素没动）', transformOf() === transformBefore,
  `${transformBefore} -> ${transformOf()}`);
check('切换不凭空多出节点（还是 1 个）',
  doc.querySelectorAll('[data-node-id]').length === 1,
  String(doc.querySelectorAll('[data-node-id]').length));

await clickSwitch();
check('再点一下 → 第 3 张 / 3/3', cardImage() === P3 && (switchButton()?.textContent ?? '').includes('3/3'),
  `${cardImage()} / ${switchButton()?.textContent}`);
await clickSwitch();
check('再点一下绕回第 1 张 / 1/3（环形，不用点回来）',
  cardImage() === P1 && (switchButton()?.textContent ?? '').includes('1/3'),
  `${cardImage()} / ${switchButton()?.textContent}`);

await clickSwitch(true);
check('Shift+点击 → 往回拨到第 3 张（3/3）',
  cardImage() === P3 && (switchButton()?.textContent ?? '').includes('3/3'),
  `${cardImage()} / ${switchButton()?.textContent}`);
await clickSwitch(true);
check('再 Shift+点击 → 第 2 张（往回走也不会卡住）',
  cardImage() === P2 && (switchButton()?.textContent ?? '').includes('2/3'),
  `${cardImage()} / ${switchButton()?.textContent}`);

// ---------------------------------------------------------------- 3) 存盘后还是这一张
//
// 自动保存是 debounce 1.2s + 最快 3s 一次；切完等一轮再问后端要文档。
await settle(4200);
{
  const saved = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  const savedNode = (saved.json().nodes ?? []).find((item) => item.id === 'stack-host');
  check('存盘后宿主还是同一个节点 id（连线/结果/任务队列不掉）', !!savedNode);
  check('存盘后内容就是「第二张」（看到什么就存什么，刷新后不会跳回第一张）',
    savedNode?.title === '第二张' && savedNode?.resultUrl === P2, `${savedNode?.title} / ${savedNode?.resultUrl}`);
  check('存盘后计数也在文档里（刷新后仍是 2/3）', Number(savedNode?.stackPosition) === 1,
    String(savedNode?.stackPosition));
  check('存盘后叠里仍是两张（三张一张没丢）',
    Array.isArray(savedNode?.stackItems) && savedNode.stackItems.length === 2 &&
      savedNode.stackItems.some((item) => item.title === '第一张') &&
      savedNode.stackItems.some((item) => item.title === '第三张'),
    JSON.stringify((savedNode?.stackItems ?? []).map((item) => item.title)));
}

// ---------------------------------------------------------------- 4) 「展开」照旧能把三张摊回画布
{
  const before = doc.querySelectorAll('[data-node-id]').length;
  expandButton()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(700);
  const after = doc.querySelectorAll('[data-node-id]').length;
  check('点「展开」→ 画布上的节点从 1 个变 3 个', before === 1 && after === 3, `${before} -> ${after}`);
  const sources = [...doc.querySelectorAll('[data-fisherai-image-preview] img[alt="生成结果"]')]
    .map((img) => img.getAttribute('src'));
  check('摊开后三张图都在（切换过的叠展开不丢图）',
    new Set(sources).size === 3 && [P1, P2, P3].every((url) => sources.includes(url)),
    JSON.stringify(sources));
  check('摊开后控制条消失（这一叠已经解散）',
    doc.querySelector('[data-fisherai-stack-controls="true"]') === null, '');
}

// ---------------------------------------------------------------- 5) 渲染期没有运行时错误
{
  const diag = await host.hostApi('GET', '/diagnostics?limit=50');
  const errors = (diag.json().entries ?? []).filter((entry) => entry.level === 'error');
  check('整轮没有运行时错误（叠图切换没把画布弄崩）', errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)');
}

if (handle) {
  try {
    handle.dispose();
  } catch (error) {
    check('dispose 不抛错', false, String(error));
  }
}

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
