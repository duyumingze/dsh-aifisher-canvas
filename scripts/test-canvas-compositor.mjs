/**
 * 调色节点 / 合成器回归（v1.70）。
 *
 * 用户 2026-10-28 定的形态：
 *   主画布上一个「调色」节点 → 点按钮进全屏合成器；
 *   合成器里预置 输入 / 输出 / 预览 三个节点，一个效果一个节点，
 *   Shift+点击节点接到预览，结果写回节点。
 *
 * 用户 2026-10-29 追加（本文件 60 → 105 项）：
 *   串线（拖到线上松手自动插入）、端口命中放大、参数专业单位、曲线节点、示波器，
 *   以及「应用后调色节点右侧落一张成品图」的落位桥。
 *
 * 两段：
 *   A. **图结构纯逻辑**（跑构建产物）：默认图、动态输出口、一个输入口只留一条线、
 *      求值顺序、环检测、脏图归一化。
 *   B. **真 DOM**（jsdom 里真挂画布）：Color Grade 节点能建出来、卡片上有「合成器」按钮、
 *      点它打开全屏层且里面正好三个节点、Esc 能关掉。
 *
 * 真渲染（WebGL 纹理 / 导出的 PNG 像素）在 browser-check 里另验 —— jsdom 的
 * canvas 没有 GL 上下文，这一段只能验 DOM 装配。
 *
 * 用法：node scripts/test-canvas-compositor.mjs   （需要先 build）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCanvasDom,
  mountCanvasApp,
  seedResume,
  settle,
  startHost,
} from './lib/canvas-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const PROJECT_ID = 'proj-canvas-compositor';
const IMAGE = (file) => `/api/aifisher/canvas/media/${PROJECT_ID}/images/${file}`;

// ---------------------------------------------------------------- 0) 预置项目
//
// 上游一张 Image（有结果图，卡片会渲染）→ 一个 Color Grade 节点。
const host = await startHost();
{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '调色验证',
    nodes: [
      {
        id: 'grade-src',
        type: 'Image',
        x: 40,
        y: 40,
        title: '上游',
        prompt: '上游',
        status: 'success',
        model: 'Upload',
        resultUrl: IMAGE('src.png'),
        resultUrls: [IMAGE('src.png')],
        resultAspectRatio: '320/240',
        aspectRatio: '4:3',
        parentIds: [],
        projectId: PROJECT_ID,
        width: 320,
        height: 240,
      },
      {
        id: 'grade-1',
        type: 'Color Grade',
        x: 640,
        y: 120,
        title: '调色',
        status: 'idle',
        parentIds: ['grade-src'],
        projectId: PROJECT_ID,
      },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置「图像 → 调色」的项目写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
globalThis.window = window;
globalThis.document = window.document;
// Node 24 把 globalThis.navigator 设成只读，直接赋值会抛；这里用 defineProperty 覆盖。
try {
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
} catch {
  // 覆盖不了也不影响图结构这层断言
}
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.Image = window.Image;
if (window.CSS) globalThis.CSS = window.CSS;

seedResume(window, PROJECT_ID);
const { canvasApp, handle } = await mountCanvasApp(window);
await settle(1600);
const doc = window.document;

/** 关合成器走「放弃修改」：第一次只提示，第二次才真关（防止把调好的色一键清掉）。 */
const discardClose = async () => {
  const button = doc.querySelector('.cg-root [data-act="cancel"]');
  if (!button) return;
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(30);
  const again = doc.querySelector('.cg-root [data-act="cancel"]');
  if (!again) return;
  again.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(60);
};

// ---------------------------------------------------------------- 1.5) 顶栏让位
//
// 用户 2026-10-29 报「没有应用按钮啊？」：DSH 桌面窗口的 titleBarOverlay 原生
// − ▢ ✕ 画在网页上方，调色面板右上角的「保存并退出」被整个盖住。

{
  check(
    '窗口按钮让位：浏览器里 0px',
    canvasApp.compositorTopbarInset('Mozilla/5.0 Chrome/140 Safari/537.36', null, 1920) === 0,
  );
  check(
    '窗口按钮让位：Electron 取不到几何时兜底 152px',
    canvasApp.compositorTopbarInset('Mozilla/5.0 Chrome/140 Electron/33.2.0 Safari/537.36', null, 1920) === 152,
  );
  const geometry = { visible: true, getTitlebarAreaRect: () => ({ x: 0, width: 1782 }) };
  check(
    '窗口按钮让位：按 WCO 几何算（1920−1782 = 138）',
    canvasApp.compositorTopbarInset('Electron/33', geometry, 1920) === 138,
  );
  check(
    '窗口按钮让位：几何拿不到时 Electron 仍让 152',
    canvasApp.compositorTopbarInset(
      'Electron/33',
      { visible: true, getTitlebarAreaRect: () => null },
      1920,
    ) === 152,
  );
  // 用户 2026-10-30 报「上方的按钮点不动」：DSH 桌面窗口顶上 40px 是系统
  // caption 带，网页收不到点击。顶栏要整体往下让出一条。
  check(
    '标题栏让位：浏览器里 0px',
    canvasApp.compositorTitlebarInset('Mozilla/5.0 Chrome/140 Safari/537.36', null) === 0,
  );
  check(
    '标题栏让位：Electron 取不到几何时兜底 40px（DSH 的 titleBarOverlay.height）',
    canvasApp.compositorTitlebarInset('Mozilla/5.0 Chrome/140 Electron/33.2.0 Safari/537.36', null) === 40,
  );
  check(
    '标题栏让位：按 WCO 几何高度算（42 → 42）',
    canvasApp.compositorTitlebarInset('Electron/33', {
      visible: true,
      getTitlebarAreaRect: () => ({ x: 1700, width: 220, height: 42 }),
    }) === 42,
  );
  check(
    '标题栏让位：异常高度不会把整块面板顶飞（钳到 96）',
    canvasApp.compositorTitlebarInset('Electron/33', {
      visible: true,
      getTitlebarAreaRect: () => ({ x: 0, width: 10, height: 400 }),
    }) === 96,
  );
}

// ---------------------------------------------------------------- 1.6) 保存时导哪个口
//
// 用户 2026-10-29：「在画布调完色之后没有图像输出出来」——典型情况是效果只接进了预览链，
// 输出节点还接着原图，按输出导出等于没调色。这里的规则要钉死。

{
  const nodes = [
    { id: 'input', kind: 'input', x: 0, y: 0, params: {} },
    { id: 'output', kind: 'output', x: 0, y: 0, params: {} },
    { id: 'viewer', kind: 'viewer', x: 0, y: 0, params: {} },
    { id: 'grade', kind: 'colorBalance', x: 0, y: 0, params: {} },
    { id: 'grade2', kind: 'hueSaturation', x: 0, y: 0, params: {} },
  ];
  const edge = (fromNode, toNode) => ({
    id: `${fromNode}-${toNode}`,
    fromNode,
    fromPort: 0,
    toNode,
    toPort: 0,
  });
  const graph = (...edges) => ({ version: 1, nodes, edges });
  const targets = (...edges) => canvasApp.chooseApplyTargets(graph(...edges)).join(',');

  check(
    '默认图（输出/预览都接原图）→ 先导输出',
    targets(edge('input', 'output'), edge('input', 'viewer')) === 'output,viewer',
  );
  check(
    '只在预览链上调了色、输出还接着原图 → 先导预览（否则导出的是没调色的图）',
    targets(edge('input', 'output'), edge('grade', 'viewer')) === 'viewer,output',
  );
  check(
    '输出没接线、预览接了效果 → 退回预览',
    targets(edge('grade', 'viewer')) === 'viewer,output',
  );
  check(
    '两条链各自接了效果 → 仍按输出优先（Blender 语义）',
    targets(edge('grade', 'output'), edge('grade2', 'viewer')) === 'output,viewer',
  );
  check('输出和预览都没接线 → 没有可导出的口', targets() === '');
  check(
    '「输出是不是原图直连」随接线变化',
    canvasApp.targetIsRawInput(graph(edge('input', 'output')), 'output') === true &&
      canvasApp.targetIsRawInput(graph(edge('grade', 'output')), 'output') === false,
  );
}

// ---------------------------------------------------------------- 1) 产物符号

check(
  '产物导出合成器纯函数',
  typeof canvasApp.createDefaultGraph === 'function' &&
    typeof canvasApp.connect === 'function' &&
    typeof canvasApp.evaluationOrder === 'function' &&
    typeof canvasApp.normalizeGraph === 'function',
);
check(
  '产物导出串线 / 示波器 / 曲线 / 单位换算纯函数（v1.73）',
  typeof canvasApp.insertNodeIntoEdge === 'function' &&
    typeof canvasApp.canInsertIntoEdge === 'function' &&
    typeof canvasApp.curveValue === 'function' &&
    typeof canvasApp.buildCurveLut === 'function' &&
    typeof canvasApp.histogramOf === 'function' &&
    typeof canvasApp.waveformOf === 'function' &&
    typeof canvasApp.vectorscopeOf === 'function' &&
    typeof canvasApp.toDisplay === 'function' &&
    typeof canvasApp.formatParam === 'function',
);
check(
  '产物导出达芬奇同款示波器的纯函数（分量图 / 10-bit 量程 / 矢量靶位）',
  typeof canvasApp.paradeOf === 'function' &&
    typeof canvasApp.vectorscopeTargets === 'function' &&
    canvasApp.SCOPE_MAX === 1023 &&
    typeof canvasApp.SKIN_TONE_ANGLE === 'number',
);

const bundle = readFileSync(join(ROOT, 'lib/canvas/canvas-app.js'), 'utf8');
check('产物里有调色节点类型（Color Grade）', bundle.includes('Color Grade'));
check('产物里有合成器桥（__FISHERAI_COMPOSITOR__）', bundle.includes('__FISHERAI_COMPOSITOR__'));

// ---------------------------------------------------------------- 2) 图结构

{
  const { createDefaultGraph, outputPortCount } = canvasApp;
  const single = createDefaultGraph(1);
  check(
    '默认图含输入 / 输出 / 预览三个节点',
    single.nodes.length === 3 &&
      single.nodes.some((node) => node.kind === 'input') &&
      single.nodes.some((node) => node.kind === 'output') &&
      single.nodes.some((node) => node.kind === 'viewer'),
    `nodes=${single.nodes.map((node) => node.kind).join(',')}`,
  );
  check(
    '单图输入：输入→输出 与 输入→预览 各一条',
    single.edges.filter((edge) => edge.toNode === 'output').length === 1 &&
      single.edges.filter((edge) => edge.toNode === 'viewer').length === 1,
    `edges=${single.edges.length}`,
  );
  check(
    '输入节点的输出口数跟着图片数走（0 张也留 1 个）',
    outputPortCount('input', 0) === 1 && outputPortCount('input', 5) === 5,
  );

  const triple = createDefaultGraph(3);
  check(
    '三图输入：三条进输出、三条进预览',
    triple.edges.filter((edge) => edge.toNode === 'output').length === 3 &&
      triple.edges.filter((edge) => edge.toNode === 'viewer').length === 3,
    `edges=${triple.edges.length}`,
  );
  check(
    '三图输入：第 2 张图对应输出口 1',
    triple.edges.some(
      (edge) => edge.fromNode === 'input' && edge.fromPort === 1 && edge.toNode === 'output',
    ),
  );
}

// ---------------------------------------------------------------- 3) 连接语义

{
  const { connect, createDefaultGraph, disconnectEdge, removeNode } = canvasApp;
  let graph = createDefaultGraph(1);
  graph = connect(graph, 'input', 0, 'output', 0);
  const incoming = graph.edges.filter((edge) => edge.toNode === 'output');
  check('同一输入口后连覆盖先连（输出只留一条）', incoming.length === 1, `incoming=${incoming.length}`);

  graph = connect(graph, 'input', 2, 'output', 0);
  const replaced = graph.edges.filter((edge) => edge.toNode === 'output');
  check(
    '换一张图接输出：旧线消失、新线带着新端口',
    replaced.length === 1 && replaced[0].fromPort === 2,
    `port=${replaced[0]?.fromPort}`,
  );

  graph = disconnectEdge(graph, replaced[0].id);
  check('断开连线后输出口空出来', graph.edges.filter((edge) => edge.toNode === 'output').length === 0);

  const withNode = {
    ...graph,
    nodes: [...graph.nodes, { id: 'fx', kind: 'brightnessContrast', x: 0, y: 0, params: {} }],
  };
  const removed = removeNode(withNode, 'fx');
  check(
    '删节点时连带删掉两侧的边',
    !removed.nodes.some((node) => node.id === 'fx') &&
      !removed.edges.some((edge) => edge.fromNode === 'fx' || edge.toNode === 'fx'),
  );
}

// ---------------------------------------------------------------- 4) 求值顺序与环

{
  const { createDefaultGraph, evaluationOrder } = canvasApp;
  const graph = createDefaultGraph(1);
  const result = evaluationOrder(graph, 'output');
  check(
    '求值顺序：上游在前、目标最后',
    result.order[0] === 'input' && result.order[result.order.length - 1] === 'output',
    result.order.join('>'),
  );
  check('求值目标不存在时报错', !!evaluationOrder(graph, 'nope').error);

  const cyclic = {
    version: 1,
    nodes: [
      { id: 'a', kind: 'brightnessContrast', x: 0, y: 0, params: {} },
      { id: 'b', kind: 'blur', x: 0, y: 0, params: {} },
    ],
    edges: [
      { id: 'e1', fromNode: 'a', fromPort: 0, toNode: 'b', toPort: 0 },
      { id: 'e2', fromNode: 'b', fromPort: 0, toNode: 'a', toPort: 0 },
    ],
  };
  check('环被识别（不无限递归）', !!evaluationOrder(cyclic, 'a').error);
}

// ---------------------------------------------------------------- 5) 脏图归一化

{
  const { normalizeGraph, paramsOf } = canvasApp;
  const dirty = {
    nodes: [
      { id: 'input', kind: 'input', x: 0, y: 0 },
      { id: 'x', kind: 'not-a-real-kind', x: 1, y: 1 },
      { id: 'y', kind: 'blur', x: 2, y: 2 },
    ],
    edges: [
      { fromNode: 'input', fromPort: 0, toNode: 'y', toPort: 0 },
      { fromNode: 'ghost', fromPort: 0, toNode: 'y', toPort: 0 },
    ],
  };
  const normalized = normalizeGraph(dirty, 1);
  check('未知 kind 被丢掉', !normalized.nodes.some((node) => node.id === 'x'));
  check('悬空边被丢掉', !normalized.edges.some((edge) => edge.fromNode === 'ghost'));
  check('空图回落到默认图', normalizeGraph(null, 2).nodes.length === 3);
  check(
    '参数缺省值补齐（旧图没有新字段也不崩）',
    paramsOf({ id: 'y', kind: 'blur', x: 0, y: 0, params: {} }).radius === 8,
  );

  // 示波器状态（v1.74）：看哪张图、开没开、面板宽高都跟着 compositorGraph 存
  const withScope = normalizeGraph(
    { ...dirty, scope: { kind: 'parade', visible: false, width: 420, height: 260 } },
    1,
  );
  check(
    '示波器状态随图存取（kind / 开合 / 宽高都保留）',
    withScope.scope?.kind === 'parade' &&
      withScope.scope?.visible === false &&
      withScope.scope?.width === 420 &&
      withScope.scope?.height === 260,
    JSON.stringify(withScope.scope ?? null),
  );
  check(
    '老图没有 scope 段 → 留 undefined（编辑器回默认波形图）',
    normalizeGraph(dirty, 1).scope === undefined,
  );
}

// ---------------------------------------------------------------- 6) v1.73 纯逻辑
//
// 用户 2026-10-29：「把它移动到两条线之间会自动连接」「连线判定太小」
// 「色相饱和节点稍微移动一点点就超过预期」「曲线节点」「直方图等专业调色工具」。

{
  const { createDefaultGraph, insertNodeIntoEdge, canInsertIntoEdge } = canvasApp;
  check(
    '能串线的节点：一进一出才行（蒙版/预览/输出不行）',
    canInsertIntoEdge('brightnessContrast') &&
      canInsertIntoEdge('curves') &&
      canInsertIntoEdge('reroute') &&
      !canInsertIntoEdge('ellipseMask') &&
      !canInsertIntoEdge('viewer') &&
      !canInsertIntoEdge('output'),
  );
  const base = createDefaultGraph(1);
  const withNode = {
    ...base,
    nodes: [...base.nodes, { id: 'fx', kind: 'brightnessContrast', x: 0, y: 0, params: {} }],
  };
  const target = withNode.edges.find((edge) => edge.toNode === 'viewer');
  const spliced = insertNodeIntoEdge(withNode, 'fx', target.id);
  check(
    '把节点拖到连线上：旧线拆掉、换成「上游→节点→下游」两条',
    !spliced.edges.some((edge) => edge.id === target.id) &&
      spliced.edges.some(
        (edge) => edge.fromNode === 'input' && edge.fromPort === target.fromPort && edge.toNode === 'fx',
      ) &&
      spliced.edges.some((edge) => edge.fromNode === 'fx' && edge.toNode === 'viewer'),
    `edges=${spliced.edges.length}`,
  );
  check(
    '串线不改下游的输入口（槽位原样保留）',
    spliced.edges.some((edge) => edge.fromNode === 'fx' && edge.toNode === 'viewer' && edge.toPort === target.toPort),
  );
  check(
    '已经在链上的节点不会被串成自己接自己',
    insertNodeIntoEdge(spliced, 'input', spliced.edges[0].id) === spliced,
  );
}

{
  const { curveValue, buildCurveLut, normalizeCurvePoints } = canvasApp;
  check(
    '曲线默认是恒等直线',
    Math.abs(curveValue([0, 0, 1, 1], 0.37) - 0.37) < 0.01,
    String(curveValue([0, 0, 1, 1], 0.37)),
  );
  check(
    '曲线控制点能抬起中间调（单调插值不越界）',
    curveValue([0, 0, 0.5, 0.7, 1, 1], 0.5) > 0.68 &&
      curveValue([0, 0, 0.5, 0.7, 1, 1], 0.5) < 0.72,
    String(curveValue([0, 0, 0.5, 0.7, 1, 1], 0.5)),
  );
  check(
    '曲线：乱序/越界的点被规范成有序 0..1',
    JSON.stringify(normalizeCurvePoints([1.2, 5, -0.3, -1, 0.5, 0.4]).map((point) => [point.x, point.y])) ===
      JSON.stringify([
        [0, 0],
        [0.5, 0.4],
        [1, 1],
      ]),
  );
  const lut = buildCurveLut({ points: [0, 0, 0.5, 0.7, 1, 1] });
  check(
    '曲线 LUT：中间调抬高、黑/白位不越界',
    lut[128 * 4] > 150 && lut[0] === 0 && lut[255 * 4] === 255,
    `mid=${lut[128 * 4]}`,
  );
  const channelLut = buildCurveLut({ points: [0, 0, 1, 1], pointsR: [0, 0, 0.5, 0.2, 1, 1] });
  check(
    '曲线分通道：R 曲线只压 R 通道',
    channelLut[128 * 4] < 110 && channelLut[128 * 4 + 1] === 128,
    `r=${channelLut[128 * 4]} g=${channelLut[128 * 4 + 1]}`,
  );
}

{
  const { toDisplay, toRaw, formatParam } = canvasApp;
  check(
    '色相按专业单位显示：±180° / 1° 步进（不再是 0..1）',
    toDisplay('hue', 0.5) === 180 && toRaw('hue', 90) === 0.25 && formatParam('hue', 0.25) === '90°',
    `${toDisplay('hue', 0.5)} / ${toRaw('hue', 90)} / ${formatParam('hue', 0.25)}`,
  );
  check(
    '饱和度 / 曝光 / 色温都有单位',
    formatParam('saturation', 0.35) === '35%' &&
      formatParam('exposure', -0.5) === '-0.50EV' &&
      formatParam('temperature', 5600) === '5600K',
    `${formatParam('saturation', 0.35)} ${formatParam('exposure', -0.5)} ${formatParam('temperature', 5600)}`,
  );
}

{
  const { histogramOf, waveformOf, vectorscopeOf } = canvasApp;
  // 2×2：黑、白、红、绿
  const image = {
    width: 2,
    height: 2,
    pixels: new Uint8Array([
      0, 0, 0, 255,
      255, 255, 255, 255,
      255, 0, 0, 255,
      0, 255, 0, 255,
    ]),
  };
  const histogram = histogramOf(image, 64);
  check(
    '直方图：黑/白/红/绿落进对应 bin',
    histogram.r[0] === 2 && histogram.r[63] === 2 && histogram.g[63] === 2 && histogram.b[0] === 3,
    `r0=${histogram.r[0]} r63=${histogram.r[63]} g63=${histogram.g[63]} b0=${histogram.b[0]}`,
  );
  check(
    '直方图：读出暗部 / 高光裁切比例',
    Math.abs(histogram.clipShadow - 7 / 12) < 1e-6 && Math.abs(histogram.clipHighlight - 5 / 12) < 1e-6,
    `${histogram.clipShadow.toFixed(3)} / ${histogram.clipHighlight.toFixed(3)}`,
  );
  const waveform = waveformOf(image, 16, 16);
  let waveformTotal = 0;
  for (const value of waveform.counts) waveformTotal += value;
  check('波形图：每个像素都落进一列', waveformTotal === 4, `total=${waveformTotal}`);
  // 波形图带颜色统计：2×2 里红/绿/白/黑各一个，红格平均色就该是纯红
  let waveformRedPixel = -1;
  for (let index = 0; index < waveform.counts.length; index += 1) {
    if (waveform.counts[index] === 1 && waveform.red[index] === 255 && waveform.blue[index] === 0) {
      waveformRedPixel = index;
      break;
    }
  }
  check(
    '波形图：累计每格平均色（供彩色波形上色）',
    waveformRedPixel >= 0 &&
      waveform.red[waveformRedPixel] === 255 &&
      waveform.green[waveformRedPixel] === 0 &&
      waveform.green.some((value) => value === 255),
    `redCell=${waveformRedPixel}`,
  );
  const vectorscope = vectorscopeOf(image, 32);
  let vectorscopeTotal = 0;
  for (const value of vectorscope.counts) vectorscopeTotal += value;
  check(
    '矢量图：只统计有饱和度的像素（黑白落中心被略过）',
    vectorscopeTotal === 2,
    `total=${vectorscopeTotal}`,
  );

  // ---- 分量图（RGB Parade）：三路各自的纵向分布，三路共用峰值
  const parade = canvasApp.paradeOf(image, 16, 16);
  const pr = (col, row) => parade.r[row * parade.columns + col];
  const pg = (col, row) => parade.g[row * parade.columns + col];
  const pb = (col, row) => parade.b[row * parade.columns + col];
  // 2×2 图：x=0 列是黑+红，x=1 列是白+绿 → 列索引 0 与 8（16 列），
  // 值 0 落在最后一行、值 255 落在第 0 行（上亮下暗）
  check(
    '分量图：三路各画各的通道分布（红在头顶、绿在脚下）',
    pr(0, 0) === 1 && pr(0, 15) === 1 && pr(8, 0) === 1 && pg(8, 0) === 2 && pg(0, 15) === 2,
    `r=${pr(0, 0)},${pr(0, 15)},${pr(8, 0)} g=${pg(8, 0)},${pg(0, 15)}`,
  );
  check(
    '分量图：三路共用峰值（通道像素少就暗一截，与达芬奇一致）',
    parade.peak === 2 && pb(8, 0) === 1 && pb(0, 15) === 2,
    `peak=${parade.peak} b=${pb(8, 0)},${pb(0, 15)}`,
  );

  // ---- 矢量图靶位与肤色线：不写死角度，用 75% 彩条反算 BT.601
  const targets = canvasApp.vectorscopeTargets();
  const red = targets.find((target) => target.label === 'R');
  const degrees = (radian) => (radian * 180) / Math.PI;
  check(
    '矢量图：六个 75% 彩条靶位（R 在 108.6°、半径约 0.79）',
    targets.length === 6 &&
      Math.abs(degrees(red.angle) - 108.6) < 0.6 &&
      Math.abs(red.radius - 0.792) < 0.01 &&
      // 六个靶位不是正圆：按 BT.601 算出来 R/G/Mg/Cy 约 0.79、B/Yl 约 0.76，都在靶环附近
      targets.every((target) => target.radius > 0.74 && target.radius < 0.82),
    `targets=${targets.length} R=${degrees(red.angle).toFixed(1)}°/${red.radius.toFixed(3)}`,
  );
  check(
    '矢量图：肤色线在 I 轴上（约 128°）',
    Math.abs(degrees(canvasApp.SKIN_TONE_ANGLE) - 128) < 2,
    `${degrees(canvasApp.SKIN_TONE_ANGLE).toFixed(1)}°`,
  );
}

// ---------------------------------------------------------------- 6) 真 DOM：卡片与编辑器

const button = doc.querySelector('[data-fisherai-open-compositor]');
check('调色节点卡片上有「合成器」按钮', !!button);
if (button) {
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(300);
  const overlay = doc.querySelector('.cg-root');
  check('点按钮打开合成器全屏层', !!overlay);
  check(
    '合成器预置三个节点（输入 / 输出 / 预览）',
    overlay?.querySelectorAll('.cg-node').length === 3,
    `nodes=${overlay?.querySelectorAll('.cg-node').length ?? 0}`,
  );
  check(
    '输入节点按上游图片数给输出口（1 张 = 1 个）',
    overlay?.querySelectorAll('.cg-port.cg-out').length === 1,
    `outs=${overlay?.querySelectorAll('.cg-port.cg-out').length ?? 0}`,
  );
  check(
    '上方只有一块预览画布（以预览节点为主）',
    overlay?.querySelectorAll('.cg-preview canvas').length === 1,
    `canvases=${overlay?.querySelectorAll('.cg-preview canvas').length ?? 0}`,
  );
  // 用户 2026-10-28 报「打开合成器一条线都没有」：默认图里明明有两条边，
  // 端口坐标却因为选择器写错（.cg-port.out vs 实际 cg-out）全被跳过。
  check(
    '默认连线真的画出来了（输入→输出 / 输入→预览 各一条）',
    overlay?.querySelectorAll('.cg-edge').length === 2,
    `edges=${overlay?.querySelectorAll('.cg-edge').length ?? 0}`,
  );
  check(
    '连线层在 stage 坐标里（不跟着节点层缩放）',
    !!overlay?.querySelector('.cg-stage > .cg-edges'),
  );
  check(
    '预览标签以「预览 VIEWER」为主',
    overlay?.querySelector('.cg-preview-label')?.textContent === '预览 VIEWER',
    overlay?.querySelector('.cg-preview-label')?.textContent ?? '',
  );
  check(
    '顶栏主动作是「保存并退出」（不再叫「应用」，避免用户找不到）',
    overlay?.querySelector('[data-act="apply"]')?.textContent === '保存并退出',
    overlay?.querySelector('[data-act="apply"]')?.textContent ?? '',
  );
  check(
    '「放弃修改」要二次确认（拆掉按钮的旧「取消」语义）',
    overlay?.querySelector('[data-act="cancel"]')?.textContent === '放弃修改',
  );
  check(
    '浏览器里顶栏右侧不让位（--cg-topbar-right=0px）',
    overlay?.style.getPropertyValue('--cg-topbar-right') === '0px',
    overlay?.style.getPropertyValue('--cg-topbar-right') ?? '',
  );

  // ---- 手势：中键平移 / 左键框选 / 点线断开（jsdom 没有布局，坐标用固定视图换算） ----
  const report = () => canvasApp.compositorReport();
  const stageElement = overlay?.querySelector('.cg-stage');
  const send = (type, target, options) =>
    target?.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options }));

  // 用户 2026-10-29 报的四件事，逐条钉住：
  // ① 参数在节点里（右侧面板拆掉）；② 预览能缩放平移；③ 新建节点跟随鼠标；
  // ④ Shift+右键在连线上也能起手（以前压在线上就被 stage/world 判断吞掉）。
  check(
    '参数长在节点里：没有右侧属性面板',
    !overlay?.querySelector('.cg-inspector') && !overlay?.querySelector('.cg-field'),
  );
  check('画布左下角有快捷键提示条', !!overlay?.querySelector('.cg-hintbar'));

  const previewBox = overlay?.querySelector('.cg-preview');
  check(
    '预览有缩放读数（默认 100%）',
    overlay?.querySelector('.cg-preview-zoom')?.textContent === '100%',
    overlay?.querySelector('.cg-preview-zoom')?.textContent ?? '',
  );
  previewBox?.dispatchEvent(
    new window.WheelEvent('wheel', {
      deltaY: -200,
      clientX: 400,
      clientY: 200,
      bubbles: true,
      cancelable: true,
    }),
  );
  check('滚轮放大预览', report().preview?.zoom > 1, `zoom=${report().preview?.zoom}`);
  check(
    '缩放读数跟着变',
    overlay?.querySelector('.cg-preview-zoom')?.textContent !== '100%',
    overlay?.querySelector('.cg-preview-zoom')?.textContent ?? '',
  );
  const previewBefore = report().preview;
  send('pointerdown', previewBox, { button: 0, clientX: 200, clientY: 120 });
  send('pointermove', window, { clientX: 240, clientY: 150 });
  send('pointerup', window, { button: 0, clientX: 240, clientY: 150 });
  check(
    '拖动平移预览',
    report().preview.x - previewBefore.x === 40 && report().preview.y - previewBefore.y === 30,
    `${JSON.stringify(previewBefore)} -> ${JSON.stringify(report().preview)}`,
  );
  previewBox?.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  check(
    '双击复位到 100% / 居中',
    report().preview.zoom === 1 && report().preview.x === 0 && report().preview.y === 0,
    JSON.stringify(report().preview),
  );

  // 调色面板是全屏模态层：画布的切刀/合线手势不能隔着它接管（会把转接点建到下面的画布上）
  const knifeSessions = canvasApp.knifeReport().sessions;
  doc.getElementById('canvas-background')?.dispatchEvent(
    new window.MouseEvent('pointerdown', {
      button: 2,
      buttons: 2,
      shiftKey: true,
      clientX: 300,
      clientY: 200,
      bubbles: true,
      cancelable: true,
    }),
  );
  check(
    '调色面板打开时画布合线手势不接管',
    canvasApp.knifeReport().sessions === knifeSessions,
    `sessions=${canvasApp.knifeReport().sessions}`,
  );

  // Shift+右键划选：默认两条线（输入→输出 / 输入→预览）同源，应该并成一个转接点
  const wireCount = () => overlay?.querySelectorAll('.cg-edge').length ?? 0;
  check('合并前画面里是两条连线', wireCount() === 2, `wires=${wireCount()}`);
  send('pointerdown', stageElement, { button: 2, buttons: 2, shiftKey: true, clientX: 550, clientY: 120 });
  send('pointermove', window, { buttons: 2, shiftKey: true, clientX: 550, clientY: 300 });
  send('pointermove', window, { buttons: 2, shiftKey: true, clientX: 550, clientY: 480 });
  send('pointerup', window, { button: 2, buttons: 0, shiftKey: true, clientX: 550, clientY: 480 });
  await settle(80);
  check(
    '划过后多出一个转接点节点（4 个节点）',
    overlay?.querySelectorAll('.cg-node').length === 4,
    `nodes=${overlay?.querySelectorAll('.cg-node').length ?? 0}`,
  );
  check(
    '同源两条线并成一条主干再分出两条（共 3 条连线）',
    wireCount() === 3,
    `wires=${wireCount()}`,
  );
  check(
    '转接点只有一条进、一条出',
    overlay?.querySelectorAll('.cg-node-compact .cg-port').length === 2,
    `ports=${overlay?.querySelectorAll('.cg-node-compact .cg-port').length ?? 0}`,
  );

  // 起手正好压在连线上（.cg-edge-hit）也要能划：用户报的「划过线段不建转接点」
  const edgeHit = overlay?.querySelector('.cg-edge-hit');
  check('连线有可命中层', !!edgeHit);
  send('pointerdown', edgeHit, { button: 2, buttons: 2, shiftKey: true, clientX: 600, clientY: 120 });
  send('pointermove', window, { buttons: 2, shiftKey: true, clientX: 600, clientY: 260 });
  send('pointermove', window, { buttons: 2, shiftKey: true, clientX: 600, clientY: 400 });
  send('pointerup', window, { button: 2, buttons: 0, shiftKey: true, clientX: 600, clientY: 400 });
  await settle(80);
  check(
    '在连线上起手也能合并出转接点（5 个节点）',
    overlay?.querySelectorAll('.cg-node').length === 5,
    `nodes=${overlay?.querySelectorAll('.cg-node').length ?? 0}`,
  );

  // Shift+A 添加节点：参数控件在卡片里，节点跟着鼠标走、左键放下（和主画布一致）
  const known = new Set(report().nodes.map((node) => node.id));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', shiftKey: true, bubbles: true }));
  await settle(40);
  const menuItems = [...doc.querySelectorAll('.cg-menu-item')];
  check('Shift+A 打开节点菜单', menuItems.length > 0, `items=${menuItems.length}`);
  const contrastItem = menuItems.find((item) => item.textContent === '亮度/对比度');
  check('菜单里有「亮度/对比度」', !!contrastItem);
  contrastItem?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(40);
  const added = report().nodes.find((node) => !known.has(node.id));
  check('新节点进入跟随状态（placing）', !!added && report().placing === added.id, `placing=${report().placing}`);
  check(
    '新节点的参数控件在卡片体内',
    (doc.querySelectorAll(`[data-node-id="${added?.id}"] .cg-param`).length ?? 0) === 2,
    `params=${doc.querySelectorAll(`[data-node-id="${added?.id}"] .cg-param`).length ?? 0}`,
  );
  const startX = added?.x ?? 0;
  const startY = added?.y ?? 0;
  send('pointermove', window, { clientX: 400, clientY: 400 });
  send('pointermove', window, { clientX: 460, clientY: 440 });
  const following = report().nodes.find((node) => node.id === added?.id);
  check(
    '节点跟着鼠标移动（位移 ÷ 缩放）',
    following?.x - startX === 60 && following?.y - startY === 40,
    `${JSON.stringify({ startX, startY, now: [following?.x, following?.y] })}`,
  );
  send('pointerdown', stageElement, { button: 0, clientX: 460, clientY: 440 });
  check('放下那一下不再起框选', !overlay?.querySelector('.cg-marquee'));
  check('左键放下后结束跟随', report().placing === null, `placing=${report().placing}`);
  send('pointermove', window, { clientX: 700, clientY: 700 });
  const settled = report().nodes.find((node) => node.id === added?.id);
  check(
    '放下后不再跟鼠标',
    settled?.x === following?.x && settled?.y === following?.y,
    `${JSON.stringify([following?.x, following?.y, settled?.x, settled?.y])}`,
  );

  const beforePan = report().view;
  send('pointerdown', stageElement, { button: 1, clientX: 100, clientY: 100 });
  send('pointermove', window, { clientX: 140, clientY: 130 });
  send('pointerup', window, { button: 1, clientX: 140, clientY: 130 });
  check(
    '中键拖动平移视图（左键不再平移）',
    report().view.x - beforePan.x === 40 && report().view.y - beforePan.y === 30,
    `${JSON.stringify(beforePan)} -> ${JSON.stringify(report().view)}`,
  );

  send('pointerdown', stageElement, { button: 0, clientX: 600, clientY: 50 });
  check('左键在空白处按下出现框选矩形', !!overlay?.querySelector('.cg-marquee'));
  send('pointermove', window, { clientX: 950, clientY: 300 });
  send('pointerup', window, { button: 0, clientX: 950, clientY: 300 });
  check('松开后框选矩形消失', !overlay?.querySelector('.cg-marquee'));
  check(
    '左键框选命中框住的节点（输出节点，不含预览）',
    report().selection?.includes('output') && !report().selection?.includes('viewer'),
    `selection=${JSON.stringify(report().selection)}`,
  );

  const hitPath = overlay?.querySelector('.cg-edge-hit');
  const wiresBeforeClick = report().edgeCount;
  hitPath?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(50);
  check(
    '点连线断开一条',
    report().edgeCount === wiresBeforeClick - 1,
    `edges=${report().edgeCount} (before=${wiresBeforeClick})`,
  );

  // 用户 2026-10-29：「希望按退出也会输出保存图像」——有改动时 Esc 不再悄悄关掉。
  // jsdom 没有 WebGL，保存必然失败；这里钉住「失败要报出来、面板不关」，而不是静默丢弃。
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(220);
  check(
    '有改动时 Esc 走保存（jsdom 无 WebGL：报引擎未就绪、面板不关）',
    !!doc.querySelector('.cg-root') &&
      /引擎/.test(String(doc.querySelector('.cg-toast.cg-show')?.textContent || '')),
    String(doc.querySelector('.cg-toast.cg-show')?.textContent || ''),
  );
  await discardClose();
  check('「放弃修改」点两次才关闭（防误吞调色）', !doc.querySelector('.cg-root'));
}

// ---------------------------------------------------------------- 7) v1.73 交互与落位
//
// 用户 2026-10-29 报的一串：
//   「把它移动到两条线之间会自动连接」「节点与节点之间的连线判定太小」
//   「色相饱节点稍微移动一点点就超过预期，0 到 1 这个取值不是很合理」
//   「曲线节点」「直方图啊等专业的调色工具」「退出调色节点时应该在调色节点后添加调整好的图像」。

{
  const dispatch = (type, target, options) =>
    target?.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options }));
  const report = () => canvasApp.compositorReport();

  doc
    .querySelector('[data-fisherai-open-compositor]')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(300);
  const overlay = doc.querySelector('.cg-root');
  const stageElement = overlay?.querySelector('.cg-stage');
  check('重新打开合成器（上一轮没应用，图不落盘）', !!overlay);

  // ---- 示波器：达芬奇同款的波形图 / 分量图 / 矢量图（不再有直方图）
  check(
    '预览右侧有示波器面板与三个 tab（波形图 / 分量图 / 矢量图）',
    overlay?.querySelectorAll('.cg-scope-tab').length === 3 &&
      !!overlay?.querySelector('.cg-scope-canvas') &&
      [...(overlay?.querySelectorAll('.cg-scope-tab') || [])]
        .map((tab) => tab.textContent)
        .join(',') === '波形图,分量图,矢量图',
    [...(overlay?.querySelectorAll('.cg-scope-tab') || [])].map((tab) => tab.textContent).join(','),
  );
  check(
    '示波器默认打开、默认波形图',
    report().scope?.visible === true && report().scope?.kind === 'waveform',
    `${report().scope?.visible}/${report().scope?.kind}`,
  );
  dispatch('click', overlay?.querySelector('.cg-scope-tab[data-scope="parade"]'));
  check('点「分量图」切到 RGB Parade', report().scope?.kind === 'parade', String(report().scope?.kind));
  dispatch('click', overlay?.querySelector('.cg-scope-tab[data-scope="vectorscope"]'));
  check('点「矢量图」切到矢量图', report().scope?.kind === 'vectorscope', String(report().scope?.kind));
  dispatch('click', overlay?.querySelector('.cg-scope-tab[data-scope="waveform"]'));
  check('点「波形图」切回来', report().scope?.kind === 'waveform', String(report().scope?.kind));
  check(
    '示波器面板有宽度/高度两条拉动条',
    !!overlay?.querySelector('.cg-scope-grip-x') && !!overlay?.querySelector('.cg-scope-grip-y'),
  );
  // 拖左边缘往左 90px = 变宽 90px（面板在右边，往左拖才是变大）
  const gripX = overlay?.querySelector('.cg-scope-grip-x');
  const widthBefore = report().scope?.width ?? 0;
  dispatch('pointerdown', gripX, { clientX: 900, clientY: 300, button: 0 });
  dispatch('pointermove', window, { clientX: 810, clientY: 300 });
  dispatch('pointerup', window, { clientX: 810, clientY: 300, button: 0 });
  check(
    '拖左边缘能改示波器宽度',
    (report().scope?.width ?? 0) > widthBefore,
    `${widthBefore} → ${report().scope?.width}`,
  );
  const gripY = overlay?.querySelector('.cg-scope-grip-y');
  dispatch('pointerdown', gripY, { clientX: 1000, clientY: 300, button: 0 });
  dispatch('pointermove', window, { clientX: 1000, clientY: 420 });
  dispatch('pointerup', window, { clientX: 1000, clientY: 420, button: 0 });
  check('拖下边缘能改示波器高度', (report().scope?.height ?? 0) > 0, `height=${report().scope?.height}`);
  dispatch('dblclick', gripX);
  check(
    '双击拉动条复位成默认大小（268px / 跟预览等高）',
    report().scope?.width === 268 && report().scope?.height === 0,
    `${report().scope?.width}×${report().scope?.height}`,
  );
  dispatch('click', overlay?.querySelector('[data-act="scopes"]'));
  check('顶栏「示波器」能收起面板', report().scope?.visible === false);
  dispatch('click', overlay?.querySelector('[data-act="scopes"]'));
  check('再点一次展开', report().scope?.visible === true);

  // ---- 参数单位：色相 ±180°、饱和度 ±100%（不再是 0..1）
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', shiftKey: true, bubbles: true }));
  await settle(40);
  const known = new Set(report().nodes.map((node) => node.id));
  [...doc.querySelectorAll('.cg-menu-item')].find((item) => item.textContent === '色相/饱和度')?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
  await settle(60);
  const added = report().nodes.find((node) => !known.has(node.id));
  const hueNode = () => doc.querySelector(`[data-node-id="${added?.id}"]`);
  check('色相/饱和度节点建出来了', !!added && !!hueNode());
  check(
    '数字参数换成全宽滑块（不再是原生 range）',
    hueNode()?.querySelectorAll('.cg-slider').length === 3 &&
      hueNode()?.querySelectorAll('input[type="range"]').length === 0,
    `sliders=${hueNode()?.querySelectorAll('.cg-slider').length ?? 0}`,
  );
  check(
    '色相显示成角度、饱和度显示成百分比',
    hueNode()?.querySelector('.cg-slider[data-param="hue"] .cg-slider-value')?.textContent === '0°' &&
      hueNode()?.querySelector('.cg-slider[data-param="saturation"] .cg-slider-value')?.textContent === '0%',
    `${hueNode()?.querySelector('.cg-slider[data-param="hue"] .cg-slider-value')?.textContent} / ${
      hueNode()?.querySelector('.cg-slider[data-param="saturation"] .cg-slider-value')?.textContent
    }`,
  );

  // 放下这个节点（先挪到右下角，别压到连线上）—— 注意：跟随状态下第一次左键永远是「放下」，
  // 所以在放稳之前不能去拖滑块（和主画布一致）。
  dispatch('pointermove', window, { clientX: 100, clientY: 100 });
  dispatch('pointermove', window, { clientX: 1060, clientY: 640 });
  dispatch('pointerdown', stageElement, { button: 0, clientX: 1060, clientY: 640 });
  check('放到了空白处：没有误连', report().edgeCount === 2, `edges=${report().edgeCount}`);
  check(
    '放下后位置正确（位移 ÷ 缩放）',
    report().nodes.find((node) => node.id === added?.id)?.x === 788,
    JSON.stringify(report().nodes.find((node) => node.id === added?.id)),
  );

  // 滑块拖动：点轨道 75% = 绝对值；Shift 拖动 = 0.12× 微调。
  // jsdom 没有布局（rect 全 0），给滑块喂一个 400px 的假宽度来量比例。
  const hueSlider = hueNode()?.querySelector('.cg-slider[data-param="hue"]');
  hueSlider.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 400,
    height: 18,
    right: 400,
    bottom: 18,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  });
  dispatch('pointerdown', hueSlider, { button: 0, clientX: 300, clientY: 9 });
  dispatch('pointerup', hueSlider, { button: 0, clientX: 300, clientY: 9 });
  const hueAt75 = String(hueNode()?.querySelector('.cg-slider[data-param="hue"] .cg-slider-value')?.textContent);
  check('点滑轨 75% 处 = +90°（±180° 量程）', hueAt75 === '90°', hueAt75);
  const hueBeforeFine = Number(hueAt75.replace('°', ''));
  dispatch('pointerdown', hueSlider, { button: 0, shiftKey: true, clientX: 100, clientY: 9 });
  dispatch('pointermove', hueSlider, { clientX: 130, clientY: 9 });
  dispatch('pointerup', hueSlider, { clientX: 130, clientY: 9 });
  const hueAfterFine = Number(
    String(hueNode()?.querySelector('.cg-slider[data-param="hue"] .cg-slider-value')?.textContent).replace('°', ''),
  );
  check(
    'Shift 拖动是微调（同样 30px 只走约 3°）',
    hueAfterFine > hueBeforeFine && Math.abs(hueAfterFine - hueBeforeFine) < 12,
    `${hueBeforeFine} -> ${hueAfterFine}`,
  );

  // ---- 把节点拖到「输入→预览」这条线上松手：自动串进去
  const card = hueNode();
  dispatch('pointerdown', card, { button: 0, clientX: 900, clientY: 520 });
  dispatch('pointermove', window, { clientX: 500, clientY: 375 });
  const splicing = !!overlay?.querySelector('.cg-edge-splice');
  check('拖到线上时那条线高亮（松手就插）', splicing || report().insertTarget !== null, `splice=${splicing}`);
  dispatch('pointerup', window, { button: 0, clientX: 500, clientY: 375 });
  await settle(60);
  check(
    '松手后节点串进连线：边数 2 → 3',
    report().edgeCount === 3,
    `edges=${report().edgeCount} node=${JSON.stringify(report().nodes.find((node) => node.id === added?.id))}`,
  );
  check('插完不再有高亮残留', report().insertTarget === null && !overlay?.querySelector('.cg-edge-splice'));

  // ---- 曲线节点：通道 + 可拖曲线
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', shiftKey: true, bubbles: true }));
  await settle(40);
  [...doc.querySelectorAll('.cg-menu-item')].find((item) => item.textContent === '曲线')?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
  await settle(60);
  const curveSvg = overlay?.querySelector('.cg-curve');
  check('曲线节点有曲线编辑区（不是「暂无参数」）', !!curveSvg);
  check(
    '曲线默认两个端点、通道下拉是自绘的 RGB/R/G/B 四项',
    curveSvg?.querySelectorAll('.cg-curve-point').length === 2 &&
      curveSvg?.closest('.cg-node-body')?.querySelector('.cg-select-button .cg-select-label')
        ?.textContent === 'RGB 主曲线',
    `points=${curveSvg?.querySelectorAll('.cg-curve-point').length ?? 0}`,
  );
  {
    // 自绘下拉：点开才生成列表，四项都在、且是深色 .cg-select-option（不是原生 select）
    const trigger = curveSvg?.closest('.cg-node-body')?.querySelector('.cg-select-button');
    dispatch('click', trigger);
    await settle(20);
    const options = [...doc.querySelectorAll('.cg-select-list .cg-select-option')];
    check(
      '通道下拉点开有四项、且不再有原生 select',
      options.length === 4 &&
        !curveSvg?.closest('.cg-node-body')?.querySelector('select') &&
        options.map((option) => option.textContent.replace('✓', '')).join(',') ===
          'RGB 主曲线,R 红通道,G 绿通道,B 蓝通道',
      `options=${options.map((option) => option.textContent).join('|')}`,
    );
    dispatch('click', options[2]);
    await settle(20);
    check(
      '选「G 绿通道」后按钮标题跟着变',
      curveSvg?.closest('.cg-node-body')?.querySelector('.cg-select-label')?.textContent === 'G 绿通道',
      String(curveSvg?.closest('.cg-node-body')?.querySelector('.cg-select-label')?.textContent),
    );
    dispatch('click', options[0] ?? trigger);
    await settle(10);
  }
  check(
    '曲线编辑器在节点体内、有对角参考线',
    !!curveSvg?.closest('.cg-node-body') && !!curveSvg?.querySelector('.cg-curve-diagonal'),
  );
  dispatch('pointerdown', stageElement, { button: 0, clientX: 1120, clientY: 700 });
  await settle(40);

  // ---- 端口命中区放大 + 拖线吸附
  const styleText = doc.querySelector('style[data-fisherai-compositor-style]')?.textContent || '';
  check('端口有 26px 的透明命中区（::after 外扩）', styleText.includes('.cg-port::after'));
  check('拖线时节点会亮起输入口（.cg-snap-target）', styleText.includes('.cg-snap-target'));

  await discardClose();
  check('「放弃修改」二次确认后关闭（第二轮）', !doc.querySelector('.cg-root'));
}

// ---------------------------------------------------------------- 7.5) v1.75 四轮调色
//
// 用户 2026-10-29 给的参照图是 Blender 的 Color Balance 节点：暗部 / 中灰 / 亮部 / 偏移
// 四个色轮，每个轮子下面是「亮度 + R/G/B」数字、四条彩色细滑轨、一条亮度长条。
// 先验色轮圆点 ↔ 三通道的纯数学，再在真 DOM 里验节点长得对不对、拖得动不动。

{
  const { wheelDotFromRgb, wheelRgbFromDot, wheelNeutralLabels, WHEEL_NODE_WIDTH } = canvasApp;
  const neutral = wheelDotFromRgb([0.25, 0.25, 0.25]);
  check(
    '色轮：三通道相等时白点在正中心',
    Math.abs(neutral.x) < 1e-6 && Math.abs(neutral.y) < 1e-6,
    JSON.stringify(neutral),
  );
  const red = wheelDotFromRgb([0.6, -0.3, -0.3]);
  const degrees = (Math.atan2(red.y, red.x) * 180) / Math.PI;
  check(
    '色轮：纯红推到左上 120°、半径到盘边（和盘面色相一致）',
    Math.abs(degrees - 120) < 1 && Math.abs(Math.hypot(red.x, red.y) - 1) < 0.01,
    `${degrees.toFixed(1)}° r=${Math.hypot(red.x, red.y).toFixed(3)}`,
  );
  const green = wheelDotFromRgb([-0.3, 0.6, -0.3]);
  const blue = wheelDotFromRgb([-0.3, -0.3, 0.6]);
  check(
    '色轮：绿在左下、蓝在右侧',
    Math.abs((Math.atan2(green.y, green.x) * 180) / Math.PI + 120) < 1 &&
      Math.abs((Math.atan2(blue.y, blue.x) * 180) / Math.PI) < 1,
  );
  const roundTrip = wheelRgbFromDot(red.x, red.y, 0);
  check(
    '色轮：通道 → 白点 → 通道 往返一致（拖动可逆）',
    Math.abs(roundTrip[0] - 0.6) < 1e-6 &&
      Math.abs(roundTrip[1] + 0.3) < 1e-6 &&
      Math.abs(roundTrip[2] + 0.3) < 1e-6,
    JSON.stringify(roundTrip),
  );
  const top = wheelRgbFromDot(0, 1, 0);
  check(
    '色轮：拖到顶部是洋红方向（R 升、G 降、亮度不变）',
    top[0] > 0.4 && top[1] < -0.4 && Math.abs(top[2]) < 0.02 && Math.abs(top[0] + top[1] + top[2]) < 1e-6,
    JSON.stringify(top),
  );
  check(
    '四轮中性数字就是参照图上的 0.00 / 0.00 / 1.00 / 25.00',
    JSON.stringify(wheelNeutralLabels().map((item) => item.neutral)) ===
      JSON.stringify(['0.00', '0.00', '1.00', '25.00']),
    JSON.stringify(wheelNeutralLabels()),
  );
  check('四轮卡片宽度够横排四个色轮（792px）', WHEEL_NODE_WIDTH === 792, String(WHEEL_NODE_WIDTH));
}

{
  const dispatch = (type, target, options) =>
    target?.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options }));
  const report = () => canvasApp.compositorReport();
  doc
    .querySelector('[data-fisherai-open-compositor]')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(300);
  const overlay = doc.querySelector('.cg-root');
  const stageElement = overlay?.querySelector('.cg-stage');
  check('重新打开合成器（四轮调色这一轮）', !!overlay);

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', shiftKey: true, bubbles: true }));
  await settle(40);
  [...doc.querySelectorAll('.cg-menu-item')]
    .find((item) => item.textContent === '色彩平衡')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(80);
  const added = report().nodes.find((node) => node.kind === 'colorBalance');
  const card = added ? doc.querySelector(`[data-node-id="${added.id}"]`) : null;
  check('「色彩平衡」节点建出来了（四轮调色卡片）', !!card && card.classList.contains('cg-node-wheels'));
  check(
    '四个色轮按 暗部 / 中灰 / 亮部 / 偏移 横排',
    [...(card?.querySelectorAll('.cg-wheel-name') || [])].map((element) => element.textContent).join(',') ===
      '暗部,中灰,亮部,偏移',
    [...(card?.querySelectorAll('.cg-wheel-name') || [])].map((element) => element.textContent).join(','),
  );
  // 方案 C：盘面是 CSS 梯度（conic 色相 + radial 明度），不是 canvas ——
  // 缩放节点时按矢量重画，不会像位图那样被拉伸糊掉。这里把「不许退回 canvas」钉住。
  check(
    '每个轮子都是矢量盘面（4 个 .cg-wheel 面 + 白点 + 外圈亮度弧，且没有 canvas 盘面）',
    card?.querySelectorAll('.cg-wheel').length === 4 &&
      card?.querySelectorAll('canvas.cg-wheel').length === 0 &&
      card?.querySelectorAll('.cg-wheel-overlay .cg-wheel-dot').length === 4 &&
      card?.querySelectorAll('.cg-wheel-overlay .cg-wheel-arc').length === 4,
    `wheels=${card?.querySelectorAll('.cg-wheel').length ?? 0}`,
  );
  check(
    '数字行：前三个轮子各 4 个（亮度 + RGB），偏移 3 个',
    card?.querySelectorAll('.cg-wheel-value').length === 15 &&
      card?.querySelectorAll('.cg-wheel-block[data-range="offset"] .cg-wheel-value').length === 3,
    `values=${card?.querySelectorAll('.cg-wheel-value').length ?? 0}`,
  );
  const valuesOf = (range) =>
    [...(card?.querySelectorAll(`.cg-wheel-block[data-range="${range}"] .cg-wheel-value`) || [])].map(
      (input) => input.value,
    );
  check(
    '默认数字和参照图一致（0.00 ×2 / 1.00 / 25.00）',
    valuesOf('lift').join(',') === '0.00,0.00,0.00,0.00' &&
      valuesOf('gain').join(',') === '1.00,1.00,1.00,1.00' &&
      valuesOf('offset').join(',') === '25.00,25.00,25.00',
    `${valuesOf('lift')} | ${valuesOf('gain')} | ${valuesOf('offset')}`,
  );
  check(
    '细滑轨 15 条（白/R/G/B；偏移三条）+ 每轮一条亮度长条',
    card?.querySelectorAll('.cg-wheel-mini').length === 15 &&
      card?.querySelectorAll('.cg-wheel-bar').length === 4,
    `minis=${card?.querySelectorAll('.cg-wheel-mini').length ?? 0} bars=${card?.querySelectorAll('.cg-wheel-bar').length ?? 0}`,
  );

  // 先把跟随中的节点放下，否则第一次左键永远被「放下」吞掉
  dispatch('pointermove', window, { clientX: 200, clientY: 200 });
  dispatch('pointermove', window, { clientX: 480, clientY: 360 });
  dispatch('pointerdown', stageElement, { button: 0, clientX: 480, clientY: 360 });
  await settle(40);
  check('四轮卡片放下后不再跟随鼠标', report().placing === null, `placing=${report().placing}`);

  // 盘内拖动：红在左上 120°，拖到那一片 → R 升、G/B 降、亮度数字仍是 0.00
  const liftWheel = card?.querySelector('.cg-wheel[data-range="lift"]');
  dispatch('pointerdown', liftWheel, { button: 0, clientX: 40, clientY: 28 });
  dispatch('pointerup', liftWheel, { button: 0, clientX: 40, clientY: 28 });
  const lifted = valuesOf('lift');
  check(
    '拖色轮白点：R 升高、G/B 降低，平均亮度仍是 0.00',
    Number(lifted[0]) === 0 && Number(lifted[1]) > 0.3 && Number(lifted[2]) < 0 && Number(lifted[3]) < 0,
    lifted.join(','),
  );

  // 外圈上下拖：三通道同时加减（色偏保留）
  dispatch('pointerdown', liftWheel, { button: 0, clientX: 4, clientY: 56 });
  dispatch('pointermove', liftWheel, { clientX: 4, clientY: 16 });
  dispatch('pointerup', liftWheel, { clientX: 4, clientY: 16 });
  const ringed = valuesOf('lift').map(Number);
  check(
    '拖外圈亮度环：三通道同时抬高，通道之间的差不变',
    ringed[0] > 0.2 &&
      Math.abs(ringed[1] - lifted[1] - ringed[0]) < 0.02 &&
      Math.abs(ringed[2] - lifted[2] - ringed[0]) < 0.02,
    `${lifted.join(',')} -> ${ringed.join(',')}`,
  );

  // 偏移的 R 细滑轨：按轨道比例设绝对值（0 → 25、1 → 50）
  const offsetMini = card?.querySelector('.cg-wheel-mini[data-range="offset"][data-channel="R"]');
  if (offsetMini) {
    offsetMini.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 5,
      right: 100,
      bottom: 5,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });
  }
  dispatch('pointerdown', offsetMini, { button: 0, clientX: 75, clientY: 2 });
  dispatch('pointerup', offsetMini, { button: 0, clientX: 75, clientY: 2 });
  check('拖彩色细滑轨能改单通道（偏移 R 拖到 75% = 37.50）', valuesOf('offset')[0] === '37.50', valuesOf('offset').join(','));

  // ↺ 复位：整个轮子回 25.00
  dispatch('click', card?.querySelector('.cg-wheel-block[data-range="offset"] .cg-wheel-reset'));
  await settle(20);
  check('↺ 把偏移轮复位回 25.00', valuesOf('offset').join(',') === '25.00,25.00,25.00', valuesOf('offset').join(','));

  // 数字框直接输入
  const gainInput = card?.querySelector('.cg-wheel-value[data-range="gain"][data-channel="master"]');
  if (gainInput) {
    gainInput.value = '1.30';
    gainInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle(20);
  }
  const gainValues = valuesOf('gain').map(Number);
  check(
    '亮度数字框能直接输入（1.30 → 三通道一起到 1.30）',
    Math.abs(gainValues[0] - 1.3) < 0.001 &&
      Math.abs(gainValues[1] - 1.3) < 0.001 &&
      Math.abs(gainValues[2] - 1.3) < 0.001,
    gainValues.join(','),
  );

  await discardClose();
  check('「放弃修改」二次确认后关闭（第三轮）', !doc.querySelector('.cg-root'));
}

// ---------------------------------------------------------------- 7.7) Ctrl+Z 撤销 / 重做（v1.78）
//
// 用户 2026-10-29：「添加 ctrl+z 撤销功能」。
// 调色面板里的改动大多是连续拖动，所以历史按「整张图快照」走：
//   ① 新增节点 → Ctrl+Z 撤掉 → Ctrl+Shift+Z 重做；
//   ② 拖一次滑块 = 一步（撤销回到拖动前的值，不是几十步）；
//   ③ Delete 删节点、点线断开都能撤销；
//   ④ 顶栏 ↶ ↷ 按钮与快捷键同一套历史。

{
  const dispatch = (type, target, options) =>
    target?.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options }));
  const report = () => canvasApp.compositorReport();
  const press = (options) =>
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options }));

  doc
    .querySelector('[data-fisherai-open-compositor]')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(300);
  const overlay = doc.querySelector('.cg-root');
  const stageElement = overlay?.querySelector('.cg-stage');
  check('重新打开合成器（撤销这一轮）', !!overlay);
  check(
    '刚打开时撤销/重做都不可点（没有历史）',
    report().history?.canUndo === false &&
      report().history?.canRedo === false &&
      overlay?.querySelector('[data-act="undo"]')?.disabled === true &&
      overlay?.querySelector('[data-act="redo"]')?.disabled === true,
    JSON.stringify(report().history),
  );

  // ---- ① 新增节点 → Ctrl+Z / Ctrl+Shift+Z
  const nodesBeforeAdd = report().nodeCount;
  press({ key: 'a', shiftKey: true });
  await settle(40);
  [...doc.querySelectorAll('.cg-menu-item')]
    .find((item) => item.textContent === '亮度/对比度')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(60);
  const nodesAfterAdd = report().nodeCount;
  check('Shift+A 新增一个节点', nodesAfterAdd === nodesBeforeAdd + 1, `${nodesBeforeAdd} -> ${nodesAfterAdd}`);
  check(
    '新增之后撤销按钮变可点',
    report().history?.canUndo === true &&
      overlay?.querySelector('[data-act="undo"]')?.disabled === false,
    JSON.stringify(report().history),
  );

  press({ key: 'z', ctrlKey: true });
  await settle(150);
  check('Ctrl+Z 撤掉刚建的节点', report().nodeCount === nodesBeforeAdd, `nodes=${report().nodeCount}`);
  check('撤销后重做可用', report().history?.canRedo === true, JSON.stringify(report().history));

  dispatch('click', overlay?.querySelector('[data-act="redo"]'));
  await settle(150);
  check('顶栏 ↷ 能重做回来', report().nodeCount === nodesAfterAdd, `nodes=${report().nodeCount}`);

  press({ key: 'z', ctrlKey: true });
  await settle(150);
  check('再按 Ctrl+Z 又撤掉', report().nodeCount === nodesBeforeAdd, `nodes=${report().nodeCount}`);
  press({ key: 'z', ctrlKey: true, shiftKey: true });
  await settle(150);
  check('Ctrl+Shift+Z 再重做回来', report().nodeCount === nodesAfterAdd, `nodes=${report().nodeCount}`);

  // 放稳这个节点（撤销/重做会把整张卡重建，按住跟随时第一次左键只是「放下」）
  dispatch('pointermove', window, { clientX: 180, clientY: 160 });
  dispatch('pointermove', window, { clientX: 560, clientY: 430 });
  dispatch('pointerdown', stageElement, { button: 0, clientX: 560, clientY: 430 });
  await settle(60);
  const added = report().nodes.find((node) => node.kind === 'brightnessContrast');
  const cardOf = () => doc.querySelector(`[data-node-id="${added?.id}"]`);
  check('重做回来的节点画在画布上（卡片已重建）', !!added && !!cardOf());
  const brightnessValue = () =>
    String(cardOf()?.querySelector('.cg-slider[data-param="brightness"] .cg-slider-value')?.textContent ?? '');

  // ---- ② 拖一次滑块 = 一步撤销
  const valueBefore = brightnessValue();
  const slider = cardOf()?.querySelector('.cg-slider[data-param="brightness"]');
  if (slider) {
    slider.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 200, height: 18, right: 200, bottom: 18, x: 0, y: 0,
      toJSON() {
        return {};
      },
    });
  }
  dispatch('pointerdown', slider, { button: 0, clientX: 150, clientY: 9 });
  dispatch('pointermove', slider, { button: 0, clientX: 160, clientY: 9 });
  dispatch('pointerup', slider, { button: 0, clientX: 160, clientY: 9 });
  const valueAfter = brightnessValue();
  check('拖亮度滑块改了值', !!valueBefore && valueAfter !== valueBefore, `${valueBefore} -> ${valueAfter}`);

  press({ key: 'z', ctrlKey: true });
  await settle(150);
  check(
    'Ctrl+Z 把这一次拖动整体撤回（回到拖前的值）',
    brightnessValue() === valueBefore,
    `${valueAfter} -> ${brightnessValue()}（期望 ${valueBefore}）`,
  );
  press({ key: 'z', ctrlKey: true, shiftKey: true });
  await settle(150);
  check('Ctrl+Shift+Z 重做这次参数修改', brightnessValue() === valueAfter, brightnessValue());

  // ---- ③ Delete 删节点 → 撤销
  const countBeforeDelete = report().nodeCount;
  dispatch('pointerdown', cardOf(), { button: 0, clientX: 560, clientY: 430 });
  dispatch('pointerup', window, { button: 0, clientX: 560, clientY: 430 });
  await settle(40);
  press({ key: 'Delete' });
  await settle(80);
  check('Delete 删掉节点', report().nodeCount === countBeforeDelete - 1, `nodes=${report().nodeCount}`);
  press({ key: 'z', ctrlKey: true });
  await settle(150);
  check('Ctrl+Z 把删掉的节点找回来', report().nodeCount === countBeforeDelete, `nodes=${report().nodeCount}`);

  // ---- ④ 点线断开 → 撤销
  const edgesBefore = report().edgeCount;
  doc.querySelector('.cg-edge-hit')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(80);
  check('点连线断开一条', report().edgeCount === edgesBefore - 1, `edges=${report().edgeCount}`);
  press({ key: 'z', ctrlKey: true });
  await settle(150);
  check('Ctrl+Z 把断开的连线接回去', report().edgeCount === edgesBefore, `edges=${report().edgeCount}`);

  await discardClose();
  check('撤销这一轮结束后能正常关掉（放弃修改二次确认）', !doc.querySelector('.cg-root'));
}

// ---------------------------------------------------------------- 7.9) v1.79：避让 / 搜索 / 三输入 / 圆角
//
// 用户 2026-10-30 的六条报障里，能在 jsdom 验的部分：
//   · 插入长节点后自动挪位（纯函数 + 真 DOM 各一半）；
//   · Shift+A 能模糊搜索（中文 / 拼音首字母 / 英文）；
//   · 混合节点三个输入口（A / B / 系数），且下拉是自绘的（原生 select 弹层是白板）；
//   · 色轮/端口这类圆形控件必须显式 corner-shape: round（DSH 主题把 50% 变成超椭圆，
//     真渲染在 browser-check 里量，这里先钉住样式表里那句声明）。
{
  // ---- 纯逻辑：矩形避让只回「挪动清单」，锚点（用户放下的节点）不动
  const sizeOf = (node) => ({
    width: node.kind === 'mix' ? 792 : 224,
    height: node.kind === 'mix' ? 150 : 180,
  });
  const graphOf = (nodes) => ({ version: 1, nodes, edges: [] });
  const node = (id, kind, x, y) => ({ id, kind, x, y, params: {} });

  const rightPush = canvasApp.resolveNodeOverlaps(
    graphOf([node('src', 'input', 80, 220), node('fx', 'mix', 400, 240), node('out', 'viewer', 720, 300)]),
    'fx',
    sizeOf,
  );
  check(
    '自动避让：右侧被宽节点压住的卡片推到锚点右边（400 + 792 + 40）',
    rightPush.length === 1 && rightPush[0].id === 'out' && rightPush[0].x === 1232,
    JSON.stringify(rightPush),
  );
  const wideLeft = canvasApp.resolveNodeOverlaps(
    graphOf([node('src', 'input', 80, 220), node('fx', 'mix', 200, 240)]),
    'fx',
    sizeOf,
  );
  check(
    '自动避让：锚点自己不动（左侧被压就推左边那张，不把用户放下的节点挪走）',
    !wideLeft.some((placement) => placement.id === 'fx') &&
      wideLeft.some((placement) => placement.id === 'src' && placement.x === 200 - 40 - 224),
    JSON.stringify(wideLeft),
  );
  const cascade = canvasApp.resolveNodeOverlaps(
    graphOf([
      node('fx', 'mix', 200, 200),
      node('a', 'viewer', 900, 200),
      node('b', 'output', 1100, 200),
    ]),
    'fx',
    sizeOf,
  );
  const cascadeX = (id) => cascade.find((placement) => placement.id === id)?.x;
  check(
    '自动避让：级联推动（第一张让到 1032，第二张继续躺在它右边 1296）',
    cascadeX('a') === 1032 && cascadeX('b') === 1296,
    JSON.stringify(cascade),
  );
  check(
    '自动避让：没有重叠时给空清单（不制造无意义的历史步）',
    canvasApp.resolveNodeOverlaps(
      graphOf([node('a', 'viewer', 0, 0), node('b', 'viewer', 1000, 0)]),
      'a',
      sizeOf,
    ).length === 0,
  );

  // ---- 纯逻辑：混合节点三输入 + 端口名
  check(
    '混合节点三个输入口（A / B / 系数）',
    canvasApp.INPUT_PORT_LABELS.mix?.length === 3 &&
      canvasApp.inputPortLabel('mix', 0) === 'A 上层' &&
      canvasApp.inputPortLabel('mix', 1) === 'B 底层' &&
      /系数/.test(canvasApp.inputPortLabel('mix', 2)),
    `${canvasApp.inputPortLabel('mix', 0)} / ${canvasApp.inputPortLabel('mix', 1)} / ${canvasApp.inputPortLabel('mix', 2)}`,
  );

  // ---- 纯逻辑：模糊搜索（中文子序列 / 拼音首字母 / 英文）
  const firstKind = (query) => canvasApp.searchNodeKinds(query)[0]?.kind;
  check('节点搜索：拼音首字母 scph → 色彩平衡', firstKind('scph') === 'colorBalance', String(firstKind('scph')));
  check('节点搜索：中文子序列「色饱」→ 色相/饱和度', firstKind('色饱') === 'hueSaturation', String(firstKind('色饱')));
  check('节点搜索：英文 blur → 模糊', firstKind('blur') === 'blur', String(firstKind('blur')));
  check('节点搜索：hh 的第一条是混合', firstKind('hh') === 'mix', String(firstKind('hh')));
  check(
    '节点搜索：空查询列出全部可建节点（不含输入/输出/预览）',
    canvasApp.searchNodeKinds('').length === canvasApp.creatableNodeCount() &&
      canvasApp.creatableNodeCount() === 18,
    `${canvasApp.searchNodeKinds('').length} / ${canvasApp.creatableNodeCount()}`,
  );
  check(
    '节点搜索：字母子序列打乱也算命中（近似容错）',
    canvasApp.fuzzyScore('cb', 'colorBalance') > 0 && canvasApp.fuzzyScore('zzzz', 'blur') === 0,
  );

  // ---- 真 DOM：宽节点串进连线后自动挪位（用户 2026-10-30 的正面需求）
  const dispatch = (type, target, options) =>
    target?.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options }));
  doc
    .querySelector('[data-fisherai-open-compositor]')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(300);
  const overlay = doc.querySelector('.cg-root');
  check('打开合成器（v1.79 这一轮）', !!overlay);
  const stageElement = overlay?.querySelector('.cg-stage');
  const report = () => canvasApp.compositorReport();

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', shiftKey: true, bubbles: true }));
  await settle(40);
  const search = doc.querySelector('.cg-menu-search input');
  check('Shift+A 菜单顶部有搜索框', !!search);
  check('打开菜单时搜索框自动聚焦', doc.activeElement === search);
  {
    // 搜「色彩平衡」（792px 宽），拖到输入→预览那条线上松手
    search.value = 'scph';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(30);
    const hits = [...doc.querySelectorAll('.cg-menu-item')];
    check(
      '输入 scph 命中的第一条是「色彩平衡」',
      hits[0]?.textContent.startsWith('色彩平衡'),
      hits[0]?.textContent ?? '',
    );
    hits[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(60);
    // jsdom 没有布局：节点起点 = 鼠标世界坐标 − 半宽，按「让它落在 输入→预览 线的中点」
    // 反推需要的位移（默认视图 x=60/y=40、scale=1）
    dispatch('pointermove', window, { clientX: 100, clientY: 100 });
    dispatch('pointermove', window, { clientX: 672, clientY: 455 });
    dispatch('pointerdown', stageElement, { button: 0, clientX: 672, clientY: 455 });
    await settle(80);
    const nodesNow = report().nodes;
    const wide = nodesNow.find((node) => node.kind === 'colorBalance');
    const upstream = nodesNow.find((node) => node.id === 'input');
    const viewer = nodesNow.find((node) => node.id === 'viewer');
    check('宽节点拖到线上松手：串进连线（2 → 3 条边）', report().edgeCount === 3, `edges=${report().edgeCount}`);
    check(
      '自动挪位：宽节点站到上游右边 40px（不遮住输入图像）',
      !!wide && !!upstream && wide.x === upstream.x + 224 + 40,
      `wide=${wide?.x} upstream=${upstream?.x}`,
    );
    check(
      '自动挪位：下游「预览」被推到宽节点右边 40px（792 + 40）',
      !!wide && !!viewer && viewer.x >= wide.x + 792 + 40,
      `wide=${wide?.x} viewer=${viewer?.x}`,
    );
    const output = nodesNow.find((node) => node.id === 'output');
    check(
      '自动挪位只动挡路的：不挡的卡片原地不动（输出与宽节点在纵向上真重叠时才被推走）',
      !!wide && (output?.x === 720 || (output?.x ?? 0) >= wide.x + 792 + 40),
      `wide=${wide?.x} output=${output?.x}`,
    );
  }

  // ---- 真 DOM：搜索建混合节点 + 三输入口 + 自绘下拉
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', shiftKey: true, bubbles: true }));
  await settle(40);
  const searchTwo = doc.querySelector('.cg-menu-search input');
  if (searchTwo) {
    searchTwo.value = 'hh';
    searchTwo.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(30);
    const items = [...doc.querySelectorAll('.cg-menu-item')];
    check(
      '输入 hh 后只剩匹配项，第一条是「混合」',
      items.length > 0 && items.length < canvasApp.creatableNodeCount() && items[0]?.textContent.startsWith('混合'),
      `items=${items.length} first=${items[0]?.textContent ?? ''}`,
    );
    searchTwo.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(60);
    // 先把跟随中的节点放到左下角空白处（否则第一次左键会被「放下」吞掉）
    dispatch('pointermove', window, { clientX: 120, clientY: 700 });
    dispatch('pointermove', window, { clientX: 60, clientY: 660 });
    dispatch('pointerdown', stageElement, { button: 0, clientX: 60, clientY: 660 });
    await settle(40);
  }
  const mixNode = [...(overlay?.querySelectorAll('.cg-node') || [])].find((element) =>
    element.querySelector('.cg-node-title')?.textContent?.includes('混合'),
  );
  check('回车直接在画布上建出「混合」节点', !!mixNode);
  check(
    '混合节点画了三个输入口、顺序是 A / B / 系数',
    mixNode?.querySelectorAll('.cg-port.cg-in').length === 3,
    `ports=${mixNode?.querySelectorAll('.cg-port.cg-in').length ?? 0}`,
  );
  check(
    '三个输入口的悬停提示分别是 A 上层 / B 底层 / 系数',
    [...(mixNode?.querySelectorAll('.cg-port.cg-in') || [])]
      .map((port) => port.title)
      .join(',') === 'A 上层,B 底层,系数（灰度 / 蒙版）',
    [...(mixNode?.querySelectorAll('.cg-port.cg-in') || [])].map((port) => port.title).join(','),
  );
  const modeSelect = mixNode?.querySelector('.cg-select');
  check(
    '混合模式是自绘下拉（不是原生 select）',
    !!modeSelect && !mixNode?.querySelector('select'),
  );
  check(
    '自绘下拉默认显示「正常」',
    modeSelect?.querySelector('.cg-select-label')?.textContent === '正常',
    String(modeSelect?.querySelector('.cg-select-label')?.textContent),
  );
  dispatch('click', modeSelect?.querySelector('.cg-select-button'));
  await settle(20);
  const modeOptions = [...doc.querySelectorAll('.cg-select-list .cg-select-option')];
  check(
    '点开下拉列出 14 种混合模式（深色自绘列表）',
    modeOptions.length === 14,
    `options=${modeOptions.length}`,
  );
  dispatch('click', modeOptions.find((option) => option.textContent.includes('正片叠底')));
  await settle(20);
  check(
    '选「正片叠底」后按钮标题跟着变',
    modeSelect?.querySelector('.cg-select-label')?.textContent === '正片叠底',
    String(modeSelect?.querySelector('.cg-select-label')?.textContent),
  );

  // ---- 样式表：圆形控件必须带 corner-shape: round（DSH 主题把 50% 变超椭圆）
  const css = doc.querySelector('style[data-fisherai-compositor-style]')?.textContent || '';
  const circleRule = css.slice(Math.max(0, css.indexOf('.cg-root .cg-wheel,')));
  check(
    '色轮/端口这些圆形控件显式 corner-shape: round（用户报「色轮变方」的根因）',
    /\.cg-root \.cg-wheel::before/.test(circleRule.slice(0, 400)) &&
      circleRule.slice(0, 400).includes('corner-shape: round'),
    circleRule.slice(0, 90),
  );
  check('调色面板用暗色 color-scheme（原生控件不闪白）', /color-scheme: dark/.test(css));

  await discardClose();
  check('v1.79 这一轮结束后能关掉（放弃修改二次确认）', !doc.querySelector('.cg-root'));
}

// ---------------------------------------------------------------- 8) 「应用」后落一张成品图
//
// 用户：「退出调色节点时应该会在调色节点后添加调整好的图像」。
// 合成结果的写回在浏览器里跑（这里没有 WebGL），所以直接调 host 侧的落位桥验结构。

{
  const before = doc.querySelectorAll('#canvas-viewport-content [data-node-id]').length;
  const bridge = window.__FISHERAI_CANVAS_GRADE_RESULT__;
  check('主画布装配了调色结果落位桥', typeof bridge?.place === 'function');
  const placed = bridge?.place({
    sourceId: 'grade-1',
    url: IMAGE('graded.png'),
    graph: { version: 1, nodes: [], edges: [] },
    title: '调色结果',
  });
  const after = doc.querySelectorAll('#canvas-viewport-content [data-node-id]').length;
  check('落位成功并返回新节点 id', placed?.ok === true && typeof placed?.id === 'string', JSON.stringify(placed));
  check('画布上多了一张图（调色节点后面那张成品图）', after === before + 1, `${before} -> ${after}`);
  check(
    '新图显示调色结果',
    !!doc.querySelector(`[data-node-id="${placed?.id}"] img[src*="graded.png"]`),
  );
  check(
    '调色节点自己也显示结果（回写 resultUrl）',
    !!doc.querySelector('[data-node-id="grade-1"] img[src*="graded.png"]'),
  );
  const failed = bridge?.place({ sourceId: 'missing-node', url: IMAGE('x.png') });
  check('找不到调色节点时给可读错误（不乱建节点）', failed?.ok === false && !!failed?.error, JSON.stringify(failed));
}

// ---------------------------------------------------------------- 9) 「应用」落盘请求
//
// 真渲染在浏览器里验，这里只验**请求形状**：合成结果 → annotation 接口 → 素材 URL。
// 接口本身（base64 解码、写 images/、记 asset）由 test-media-editing 守着。

{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body });
    return {
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          success: true,
          asset: {
            url: '/api/aifisher/canvas/media/proj-canvas-compositor/images/annotation.png',
          },
        }),
    };
  };
  try {
    const url = await canvasApp.uploadCompositorDataUrl(
      'proj-canvas-compositor',
      'data:image/png;base64,AAAA',
    );
    check(
      '「应用」把 dataURL 发到 annotation 落盘接口',
      calls[0]?.url === '/api/aifisher/canvas/media/images/annotation',
      calls[0]?.url,
    );
    check(
      '「应用」拿到素材 URL（可供下游当参考图）',
      url === '/api/aifisher/canvas/media/proj-canvas-compositor/images/annotation.png',
      url,
    );
    const body = JSON.parse(String(calls[0]?.body || '{}'));
    check(
      '请求体带 projectId 与 dataUrl',
      body.projectId === 'proj-canvas-compositor' && String(body.dataUrl).startsWith('data:image/png'),
    );

    globalThis.fetch = async () => ({
      ok: false,
      status: 413,
      text: async () => JSON.stringify({ error: '标注结果大小无效。' }),
    });
    let message = null;
    try {
      await canvasApp.uploadCompositorDataUrl('proj', 'data:image/png;base64,AA');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('落盘失败时把服务端错误原样抛给节点卡', message === '标注结果大小无效。', String(message));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

handle?.unmount?.();

// ---------------------------------------------------------------- 收尾

console.log(lines.join('\n'));
// 注：现有套件都认 `SUMMARY pass=N fail=M`，runner 按这一行判绿。
console.log(`\nSUMMARY pass=${lines.length - failures} fail=${failures}`);
process.exit(failures ? 1 : 0);
