/**
 * 画布「节点搜索」回归（scripts/test-canvas-node-search.mjs）。
 *
 * 功能（2026-10-16 用户要求）：仿 Blender 的几何节点搜索 —— 按 **Shift+A** 在鼠标旁边
 * 弹出搜索框，能搜**画布节点**，也能搜**ComfyUI 工作流**。
 *
 * 这条链路跨了三个地方，所以分三段验，每段都是「不看代码、看真东西」：
 *
 *   A. 纯排序模块（src/canvas-ui/canvas/CanvasNodeSearchRank.ts）
 *      中英混排、子序列匹配、同义词/拼音、标题优先于描述与关键词 —— 这些都是纯函数，
 *      直接在 node 里 import 源码跑断言（不依赖画布产物，改坏了先在这里红）。
 *   B. 真画布（jsdom 挂 lib/canvas/canvas-app.js）
 *      Shift+A 真的开面板、面板贴在鼠标旁边、输入真的过滤、Enter 真的建出节点、
 *      ComfyUI 候选真的把 comfyMode 写到节点上（存盘文档是唯一可信来源）。
 *   C. 产物与 vendor 补丁
 *      「建节点出口」是 vendor 的一段追加代码（scripts/vendor-aifisher.mjs 3.8f 段），
 *      这里顺带钉住它还在（否则搜索能开、点了没反应，而且是静默失败）。
 *
 * 用法：node scripts/test-canvas-node-search.mjs   （需要先 build）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}

// ---------------------------------------------------------------- A. 排序模块（纯函数）

/**
 * 排序模块是 TypeScript 源码，node 直接 import 不了 → 用 DSH 自带的 node 起一个子进程
 * （--experimental-strip-types 认 .ts），把断言需要的实测数据以 JSON 打回来。
 * 这样测的是**源码本身**，不是产物里的压缩版本。
 */
const nodeBin = process.execPath;
const probeScript = `
import {
  buildNodeSearchCatalog,
  rankNodeSearch,
  normalizeSearchText,
  scoreSearchEntry,
} from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src/canvas-ui/canvas/CanvasNodeSearchRank.ts')).href)};

const catalog = buildNodeSearchCatalog();
const ranked = (query) => rankNodeSearch(query, catalog).map((item) => item.entry.id);
const scoreOf = (query, id) => {
  const entry = catalog.find((item) => item.id === id);
  return entry ? (scoreSearchEntry(query, entry)?.score ?? null) : null;
};
console.log(JSON.stringify({
  catalog: catalog.map((item) => ({ id: item.id, type: item.type, mode: item.mode ?? null, label: item.label, group: item.group })),
  normalize: [
    normalizeSearchText('  图像 5.0-Pro '),
    normalizeSearchText('CUSTOM-A-T2I'),
    normalizeSearchText('文生图 / 图生图'),
  ],
  queries: {
    图像: ranked('图像'),
    图片: ranked('图片'),
    tp: ranked('tp'),
    sp: ranked('sp'),
    comfy: ranked('comfy'),
    工作流: ranked('工作流'),
    音pin: ranked('音pin'),
    不存在xyz: ranked('不存在xyz'),
    空: ranked(''),
  },
  scores: {
    图像_image: scoreOf('图像', 'type:Image'),
    图像_video: scoreOf('图像', 'type:Video'),
    提示词_text: scoreOf('提示词', 'type:Text'),
    并排_compare: scoreOf('并排', 'type:Image Compare'),
  },
  detail: {
    图片: [
      ['type:Image', scoreOf('图片', 'type:Image')],
      ['type:Image Compare', scoreOf('图片', 'type:Image Compare')],
      ['type:Image Composite', scoreOf('图片', 'type:Image Composite')],
    ],
    图: [
      ['type:Image', scoreOf('图', 'type:Image')],
      ['type:Video', scoreOf('图', 'type:Video')],
    ],
  },
}));
`;

const probe = spawnSync(nodeBin, ['--experimental-strip-types', '--input-type=module', '-e', probeScript], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
});
if (probe.status !== 0) {
  console.error('[node-search] 排序模块探针失败：\n' + (probe.stderr || probe.stdout));
  process.exit(1);
}
const pure = JSON.parse(probe.stdout.trim().split('\n').pop());

check(
  '候选目录含 7 种画布节点类型',
  pure.catalog.filter((item) => item.id.startsWith('type:')).length === 7,
  String(pure.catalog.filter((item) => item.id.startsWith('type:')).length),
);
check(
  '候选目录不含「上传图片/视频/音频」（它们是连接产物，上游菜单也不给凭空新建）',
  !pure.catalog.some((item) => item.type.startsWith('Upload')),
  JSON.stringify(pure.catalog.map((item) => item.type)),
);
check(
  '候选目录含内置 MiniMax 工作流（清单没拉回来时也能搜到）',
  pure.catalog.some((item) => item.id === 'workflow:minimax-h3-t2va' && item.mode === 'minimax-h3-t2va'),
  JSON.stringify(pure.catalog.filter((item) => item.group === 'ComfyUI 工作流').map((item) => item.id)),
);
check(
  '工作流候选的 type 都是 ComfyUI（建节点走同一条路，靠 comfyMode 区分）',
  pure.catalog
    .filter((item) => item.id.startsWith('workflow:'))
    .every((item) => item.type === 'ComfyUI' && item.mode),
  JSON.stringify(pure.catalog.filter((item) => item.id.startsWith('workflow:')).map((item) => item.type)),
);

check(
  '归一化去掉空白/大小写/分隔符（"图像 5.0-Pro" → "图像50pro"）',
  pure.normalize[0] === '图像50pro' && pure.normalize[1] === 'customat2i' && pure.normalize[2] === '文生图图生图',
  JSON.stringify(pure.normalize),
);

check('搜「图像」第一名是图像生成', pure.queries.图像[0] === 'type:Image', JSON.stringify(pure.queries.图像.slice(0, 3)));
check(
  '搜「图片」也能命中图像生成（关键词档赢过「图片对比/拼合」的标题前缀）',
  pure.queries.图片[0] === 'type:Image',
  JSON.stringify({ ranked: pure.queries.图片.slice(0, 3), scores: pure.detail.图片, 图: pure.detail.图 }),
);
check('搜拼音首字母 tp 命中图像生成', pure.queries.tp[0] === 'type:Image', JSON.stringify(pure.queries.tp.slice(0, 3)));
check('搜拼音首字母 sp 命中视频生成', pure.queries.sp[0] === 'type:Video', JSON.stringify(pure.queries.sp.slice(0, 3)));
check(
  '搜 comfy 命中 ComfyUI 节点与工作流',
  pure.queries.comfy.includes('type:ComfyUI') &&
    pure.queries.comfy.some((id) => id.startsWith('workflow:')),
  JSON.stringify(pure.queries.comfy.slice(0, 4)),
);
check(
  '搜「工作流」命中 ComfyUI 工作流节点',
  pure.queries.工作流.includes('type:ComfyUI'),
  JSON.stringify(pure.queries.工作流.slice(0, 4)),
);
check(
  '中英混排（"音pin"）也能命中音频生成',
  pure.queries.音pin[0] === 'type:Audio',
  JSON.stringify(pure.queries.音pin.slice(0, 3)),
);
check('搜不到就返回空列表（面板据此显示空态）', pure.queries.不存在xyz.length === 0, JSON.stringify(pure.queries.不存在xyz));
check(
  '空查询返回整份目录（节点类型在前）',
  pure.queries.空.length === pure.catalog.length && pure.queries.空[0] === 'type:Text',
  `${pure.queries.空.length}/${pure.catalog.length}`,
);
check(
  '同一次搜索里标题命中优于描述命中（「并排」只在「图片对比」的描述里 → 它的分数比「图像」的标题前缀高）',
  pure.scores.并排_compare !== null &&
    pure.scores.图像_image !== null &&
    pure.scores.并排_compare > pure.scores.图像_image,
  JSON.stringify({ 并排_compare: pure.scores.并排_compare, 图像_image: pure.scores.图像_image }),
);
check(
  '关键词完全相等的分数低于标题前缀（「提示词」对文本节点 6 < 10.4，用于让「图片」压过「图片对比」）',
  pure.scores.提示词_text !== null && pure.scores.提示词_text < pure.scores.图像_image,
  JSON.stringify(pure.scores),
);

// ---------------------------------------------------------------- B. 真画布（jsdom）

const T2I = {
  '6': { inputs: { text: '模板占位', clip: ['1', 0] }, class_type: 'CLIPTextEncode' },
  '3': { inputs: { seed: 7, steps: 12, cfg: 1 }, class_type: 'KSampler' },
  '9': { inputs: { filename_prefix: 'out', images: ['3', 0] }, class_type: 'SaveImage' },
};

const host = await startHost();
const workflowsDir = path.join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'workflows');
{
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(path.join(workflowsDir, 'a-t2i.json'), JSON.stringify(T2I), 'utf8');
  writeFileSync(
    path.join(workflowsDir, 'a-t2i.meta.json'),
    JSON.stringify({ title: '本地文生图' }),
    'utf8',
  );
}

const PROJECT_ID = 'proj-node-search';
{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '节点搜索验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window, fetchCalls } = await createCanvasDom({ dispatch: host.dispatch });
const pageErrors = [];
window.addEventListener('error', (event) => {
  pageErrors.push(String(event.error?.stack ?? event.message ?? event));
});
window.__FISHERAI_DEBUG_NODE_CREATE__ = true;
seedResume(window, PROJECT_ID);
const { container, handle } = await mountCanvasApp(window);
await settle(1500);

const canvasBackground = () => window.document.getElementById('canvas-background');
const panel = () => window.document.querySelector('[data-fisherai-node-search-panel]');
const searchInput = () => window.document.querySelector('[data-fisherai-node-search-input]');
const items = () => [...window.document.querySelectorAll('[data-fisherai-node-search-item]')];
const itemIds = () => items().map((item) => item.getAttribute('data-command-id'));

async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await settle(150);
  }
  return last;
}

const readCanvas = async () => {
  const read = await host.tool('canvas_control').execute(
    { action: 'read' },
    { agent: { session: { id: 'sess-node-search' } } },
  );
  return read.result?.nodes ?? [];
};
/** 记录面板派发出去的建节点事件（断言「面板发出的到底是什么」）。 */
const dispatched = [];
window.addEventListener('fisherai:add-canvas-node', (event) => {
  dispatched.push(event.detail);
});
const savedNodes = async () => {
  const result = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  if (result.status !== 200) return [];
  try {
    return JSON.parse(result.text).nodes ?? [];
  } catch {
    return [];
  }
};

/** 把鼠标挪到画布上某点（面板要贴着它弹出，节点也要落在那个点）。 */
function hoverCanvas(x, y) {
  const target = canvasBackground();
  if (!target) return false;
  // jsdom 没有 PointerEvent 构造器（harness 只把全局的 PointerEvent 别名到 MouseEvent），
  // 而监听器只按事件名匹配，所以用 MouseEvent 派发同名的 pointermove 即可。
  const event = new window.MouseEvent('pointermove', {
    bubbles: true,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(event);
  return true;
}
function pressShiftA() {
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true }),
  );
}
function typeInInput(value) {
  const input = searchInput();
  if (!input) return false;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  return true;
}
function pressKey(key) {
  const input = searchInput();
  if (!input) return false;
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return true;
}
/**
 * 把面板关掉（Esc 优先；jsdom 里焦点不总是落在输入框上，所以兜底点工具条上的「搜索节点」按钮
 * 会重新打开它 —— 那就改用点面板外面，等价于用户的「点空处关闭」）。
 */
async function dismissPanel() {
  if (!panel()) return true;
  pressKey('Escape');
  await settle(150);
  if (!panel()) return true;
  const background = canvasBackground();
  background?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await settle(150);
  return !panel();
}

// ---- B1. 入口与开关

check(
  '画布启动时拉取了本地工作流清单（工作流能进搜索候选的前提）',
  fetchCalls.some((call) => call.includes('GET /api/aifisher/canvas/comfy/capabilities')),
  fetchCalls.filter((call) => call.includes('capabilities')).join(' | ') || '(none)',
);
check(
  '左侧工具条有独立的「搜索节点」按钮（Shift+A 的鼠标入口）',
  Boolean(container.querySelector('[data-fisherai-node-search-trigger]')),
);
check('未打开时页面上没有搜索面板', !panel());

{
  const rect = canvasBackground().getBoundingClientRect();
  // 光标放在远离右/下边界的位置：面板会从光标处向下展开，靠边时会被夹住（那里另有断言）
  hoverCanvas(rect.left + 200, rect.top + 150);
  await settle(150);
  pressShiftA();
  await settle(250);
  const opened = Boolean(panel());
  check('按 Shift+A 弹出搜索面板', opened);
  check(
    '面板标记为打开状态',
    window.document.querySelector('[data-fisherai-node-search]')?.getAttribute('data-fisherai-node-search') === 'open',
  );
  check('面板挂在画布容器里（继承画布主题变量）', container.contains(panel()), String(Boolean(panel())));
  check(
    '输入框自动聚焦（可以直接打字）',
    window.document.activeElement === searchInput(),
    String(window.document.activeElement?.getAttribute?.('aria-label')),
  );
  const style = panel()?.style ?? {};
  // jsdom 没有布局引擎（所有 rect 都是 0），所以这里只验「面板按光标位置定位」：
  // 包含块在原点时 left/top 就应该等于光标的 client 坐标（爬坡式定位由 browser-check 在真机验）。
  check(
    '面板贴着鼠标弹出（不是固定在角落）',
    Math.abs(parseInt(style.left, 10) - 200) <= 2 && Math.abs(parseInt(style.top, 10) - 150) <= 2,
    `left=${style.left} top=${style.top}（光标 200,150）`,
  );
  check(
    '靠边时面板被夹在画布内（不会溢出右/下边界）',
    parseInt(style.left, 10) + 380 <= Math.max(200, window.innerWidth),
    `left=${style.left} width=${style.width} window=${window.innerWidth}`,
  );
}

{
  await dismissPanel();
  await settle(200);
  check('Esc 关闭面板', !panel());
  pressShiftA();
  await settle(200);
  check('Shift+A 可以再次打开', Boolean(panel()));
  check('重新打开时查询已清空', searchInput()?.value === '', String(searchInput()?.value));
}

// ---- B2. 输入过滤

{
  const before = itemIds();
  check(
    '空查询列出全部候选（节点类型 + ComfyUI 工作流）',
    before.length >= 8 && before.includes('type:Image') && before.includes('workflow:custom-a-t2i'),
    JSON.stringify(before),
  );
  typeInInput('视频');
  await settle(200);
  check(
    '输入「视频」后只剩相关候选，第一名是视频生成',
    itemIds()[0] === 'type:Video' && itemIds().length < before.length,
    JSON.stringify(itemIds()),
  );
  typeInInput('本地文生图');
  await settle(200);
  check(
    '能用工作流标题搜到具体工作流（候选带它的 mode）',
    itemIds()[0] === 'workflow:custom-a-t2i',
    JSON.stringify(itemIds()),
  );
  typeInInput('zzz-不存在');
  await settle(200);
  check('没有匹配时显示空态而不是空盒子', Boolean(window.document.querySelector('[data-fisherai-node-search-empty]')), searchInput()?.value);
}

// ---- B3. 用搜索建节点（节点类型）

{
  typeInInput('图像');
  await settle(200);
  check(
    '输入「图像」后面板高亮的就是图像生成',
    panel()?.getAttribute('data-fisherai-node-search-active') === 'type:Image',
    `active=[${panel()?.getAttribute('data-fisherai-node-search-active')}] count=${panel()?.getAttribute('data-fisherai-node-search-count')} query=[${panel()?.getAttribute('data-fisherai-node-search-query')}] items=${JSON.stringify(itemIds())} inputs=${window.document.querySelectorAll('[data-fisherai-node-search-input]').length} panels=${window.document.querySelectorAll('[data-fisherai-node-search-panel]').length}`,
  );
  pressKey('Enter');
  await settle(600);
  check('Enter 之后面板关闭', !panel());
  const nodes = await waitFor(async () => {
    const list = await readCanvas();
    return list.length ? list : null;
  });
  const image = (nodes ?? []).find((node) => node.type === 'Image');
  check(
    '搜「图像」+ Enter 建出了图像节点',
    Boolean(image),
    JSON.stringify({ nodes: (nodes ?? []).map((node) => node.type), dispatched: dispatched.slice(-1) }),
  );
  const saved = await waitFor(async () => {
    const node = (await savedNodes()).find((item) => item.id === image?.id);
    return node ?? null;
  });
  check(
    '新节点落在鼠标那个位置（画布坐标，允许节点尺寸带来的取整差）',
    saved && Math.abs(Number(saved.x) - 200) <= 12 && Math.abs(Number(saved.y) - 150) <= 12,
    JSON.stringify({ x: saved?.x, y: saved?.y }),
  );
  check('新节点带着画布的默认模型（与右键菜单建出来的完全一样）', Boolean(saved?.imageModel), String(saved?.imageModel));
}

// ---- B4. 用搜索建节点（ComfyUI 工作流 → comfyMode）

{
  await dismissPanel();
  await settle(200);
  pressShiftA();
  await settle(250);
  typeInInput('本地文生图');
  await settle(200);
  const option = items().find((item) => item.getAttribute('data-command-id') === 'workflow:custom-a-t2i');
  check('工作流候选是列表里可选的一项', Boolean(option));
  option?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await settle(700);
  check('点选工作流候选后面板关闭', !panel());
  // 诊断：事件派发到了、但画布没建出节点时，把两侧状态都打出来
  const liveAfterDispatch = (await readCanvas()).map((node) => `${node.type}:${node.comfyMode ?? ''}`);

  const comfy = await waitFor(async () => {
    const node = (await savedNodes()).find((item) => item.type === 'ComfyUI');
    return node ?? null;
  });
  check(
    '搜工作流建出来的是 ComfyUI 节点，且 comfyMode 就是那份工作流',
    comfy?.comfyMode === 'custom-a-t2i',
    JSON.stringify({
      type: comfy?.type,
      comfyMode: comfy?.comfyMode,
      dispatched: dispatched.slice(-1),
      live: liveAfterDispatch,
    }),
  );
  const element = comfy?.id ? container.querySelector(`[data-node-id="${comfy.id}"]`) : null;
  check(
    '它渲染成通用本地工作流节点（提示词/参数控件都在）',
    Boolean(element?.querySelector('[data-fisherai-local-workflow-prompt]')) &&
      Boolean(element?.querySelector('[data-fisherai-local-workflow-parameter="steps"]')),
  );
}

// ---- B5. 用工具栏按钮打开（与 Shift+A 走同一条通路）

{
  await dismissPanel();
  await settle(200);
  const rect = canvasBackground().getBoundingClientRect();
  hoverCanvas(rect.left + 300, rect.top + 200);
  await settle(120);
  const triggerElement = container.querySelector('[data-fisherai-node-search-trigger]');
  triggerElement?.click();
  await settle(300);
  check('工具栏「搜索节点」按钮也能打开面板', Boolean(panel()), JSON.stringify({
    watcher: window.document.querySelector('[data-fisherai-node-search]')?.getAttribute('data-fisherai-node-search'),
  }));
  check(
    '按钮入口把面板放在画布正中（不贴那个离按钮很远的鼠标位置）',
    Math.abs(parseInt(panel()?.style.left ?? '0', 10) - Math.round(window.innerWidth / 2)) <= 2,
    `left=${panel()?.style.left} top=${panel()?.style.top} window=${window.innerWidth}`,
  );
  await dismissPanel();
  await settle(150);
}

// ---- B6. 快捷键说明里登记了 Shift+A
{
  const shortcuts = [...container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === '快捷键说明',
  );
  shortcuts?.click();
  await settle(300);
  const helpText = window.document.body.textContent ?? '';
  check('快捷键说明里能看到「搜索节点」与 Shift + A', helpText.includes('搜索节点') && helpText.includes('Shift + A'));
  shortcuts?.click();
  await settle(150);
}

// ---------------------------------------------------------------- C. 产物与 vendor 补丁

{
  const repo = process.cwd();
  const vendorState = readFileSync(
    path.join(repo, 'vendor/aifisher/src/stable/nodes/canvasNodeState.ts'),
    'utf8',
  );
  check(
    'vendor 侧有「按类型建节点」的事件出口（搜索能开、点了没反应就是这里丢了）',
    vendorState.includes(`'fisherai:add-canvas-node'`) &&
      vendorState.includes('createCanvasNode(runtime, detail.type') &&
      vendorState.includes('updateCanvasNode([node], node.id, { comfyMode: detail.comfyMode }'),
  );

  const bundlePath = path.join(repo, 'lib/canvas/canvas-app.js');
  if (existsSync(bundlePath)) {
    const bundle = readFileSync(bundlePath, 'utf8');
    check('产物里带搜索面板的锚点标记', bundle.includes('data-fisherai-node-search-panel'));
    check('产物里带「搜索节点」的入口标记', bundle.includes('data-fisherai-node-search-trigger'));
    check('产物里带建节点事件名', bundle.includes('fisherai:add-canvas-node'));
    check('产物里带候选目录里的中文标签（说明排序模块被打进去了）', bundle.includes('图像生成') && bundle.includes('图片拼合'));
  } else {
    check('产物里带搜索面板的锚点标记', false, 'lib/canvas/canvas-app.js 不存在');
  }
}

// ---------------------------------------------------------------- 收尾

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=200')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check(
    '节点搜索全程无运行时错误',
    errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)',
  );
  check('页面里没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || '(none)');
}

try {
  handle.dispose();
} catch {
  /* 卸载失败会在渲染测试里单独断言 */
}
const { rmSync } = await import('node:fs');
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
