/**
 * 调色合成器的**输入节点**回归（v1.106）—— 2026-11-22 用户三条要求：
 *   ①「接入调色节点之后这里输入的图间距大一点，可以解散自由调整」
 *      → 缩略图行距 6 → 14、行高可拖（右下角手柄）、缩略图可拖着换顺序；
 *   ②「加上阿尔法透明输出端口，输出来的是遮罩图」
 *      → 每张图多一个 α 口（Blender Image 节点的 Color / Alpha 双口），吐黑白遮罩；
 *   ③「shift+ctrl+鼠标右键接到了输出端，我之前的要求是接到预览」
 *      → Shift+Ctrl+左键 = 接预览，Shift+Ctrl+右键 = 接输出。
 *
 * 真渲染（α 遮罩的像素）在 browser-check 的 compositor-alpha 场景里验：jsdom 没有 WebGL。
 *
 * 用法：node scripts/test-canvas-compositor-input.mjs   （需要先 build）
 */
import { rmSync } from 'node:fs';
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const PROJECT_ID = 'proj-compositor-input';
const IMAGE = (file) => `/api/aifisher/canvas/media/${PROJECT_ID}/images/${file}`;

const host = await startHost();
{
  const image = (id, file, x) => ({
    id,
    type: 'Image',
    x,
    y: 40,
    title: id,
    prompt: id,
    status: 'success',
    model: 'Upload',
    resultUrl: IMAGE(file),
    resultUrls: [IMAGE(file)],
    resultAspectRatio: '4/3',
    aspectRatio: '4:3',
    parentIds: [],
    projectId: PROJECT_ID,
  });
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '输入节点验证',
    nodes: [
      image('src-a', 'a.png', 40),
      image('src-b', 'b.png', 260),
      image('src-c', 'c.png', 480),
      {
        id: 'grade-1',
        type: 'Color Grade',
        x: 760,
        y: 120,
        title: '调色',
        status: 'idle',
        parentIds: ['src-a', 'src-b', 'src-c'],
        projectId: PROJECT_ID,
      },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置「三张图 → 调色」的项目写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
globalThis.window = window;
globalThis.document = window.document;
try {
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
} catch {
  /* 覆盖不了也不影响这些断言 */
}
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.Image = window.Image;
if (window.CSS) globalThis.CSS = window.CSS;

seedResume(window, PROJECT_ID);
const { canvasApp, handle } = await mountCanvasApp(window);
await settle(1600);
const doc = window.document;

const pointer = (type, target, options) =>
  target?.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options }),
  );

// ---------------------------------------------------------------- 0) 纯函数契约
{
  const {
    inputColorPortCount,
    inputTotalPortCount,
    inputTotalPortCount: total,
    isAlphaInputPort,
    alphaPortOfSlot,
    slotOfInputPort,
    remapInputPorts,
    normalizeSlotOrder,
  } = canvasApp;
  check(
    '输入节点双口契约：3 张图 = 3 个彩色口 + 3 个 α 口（2N）',
    inputColorPortCount(3) === 3 && total(3) === 6 && inputTotalPortCount(0) === 2,
    `color=${inputColorPortCount(3)} total=${total(3)}`,
  );
  check(
    'α 口排在彩色口之后（老图的 fromPort 0..N-1 语义不变）',
    isAlphaInputPort(0, 3) === false &&
      isAlphaInputPort(3, 3) === true &&
      alphaPortOfSlot(1, 3) === 4 &&
      slotOfInputPort(4, 3) === 1 &&
      slotOfInputPort(1, 3) === 1,
  );

  const edges = [
    { id: 'e0', fromNode: 'input', fromPort: 0, toNode: 'out', toPort: 0 },
    { id: 'a1', fromNode: 'input', fromPort: 4, toNode: 'mix', toPort: 2 },
    { id: 'x', fromNode: 'fx', fromPort: 0, toNode: 'out', toPort: 0 },
  ];
  // 把第 0 张挪到第 2 位（新位置 0/1/2 = 旧 1/2/0）
  const remapped = remapInputPorts(edges, [1, 2, 0], 3);
  check(
    '换顺序后连线跟着**图**走：彩色口 0 → 2',
    remapped[0].fromPort === 2 && remapped[0].id.includes('input:2->out:0'),
    JSON.stringify(remapped[0]),
  );
  check(
    '换顺序后 α 口一起搬：第 1 张的 α 口 4 → 3',
    remapped[1].fromPort === 3,
    String(remapped[1].fromPort),
  );
  check('别的节点上的连线不动', remapped[2].fromPort === 0 && remapped[2].fromNode === 'fx');
  check(
    '存下来的顺序必须是合法排列（张数不对 / 重复 / 越界都当没有）',
    JSON.stringify(normalizeSlotOrder([1, 2, 0], 3)) === '[1,2,0]' &&
      normalizeSlotOrder([1, 1, 0], 3) === null &&
      normalizeSlotOrder([0, 1], 3) === null &&
      normalizeSlotOrder([0, 1, 3], 3) === null &&
      normalizeSlotOrder(null, 3) === null,
  );
}

// ---------------------------------------------------------------- 1) 打开合成器
const openButton = doc.querySelector('[data-fisherai-open-compositor]');
check('调色节点卡片上有「合成器」按钮', !!openButton);
openButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(400);
const overlay = doc.querySelector('.cg-root');
check('合成器打开', !!overlay);

const report = () => canvasApp.compositorReport();
const nodeOf = (kind) =>
  [...(overlay?.querySelectorAll('.cg-node') ?? [])].find(
    (element) => element.dataset.nodeId === kind,
  );
const inputNode = () => nodeOf('input');
const outPorts = () => [...(inputNode()?.querySelectorAll('.cg-port.cg-out') ?? [])];
const alphaPorts = () => outPorts().filter((port) => port.dataset.alpha === 'true');
const colorPorts = () => outPorts().filter((port) => port.dataset.alpha !== 'true');
const thumbs = () => [...(inputNode()?.querySelectorAll('.cg-thumb') ?? [])];

check(
  '输入节点开出 6 个输出口（3 彩色 + 3 α）',
  outPorts().length === 6 && colorPorts().length === 3 && alphaPorts().length === 3,
  `outs=${outPorts().length} color=${colorPorts().length} alpha=${alphaPorts().length}`,
);
check(
  '三个彩色口都带着自己的图（端口号 0/1/2）',
  colorPorts()
    .map((port) => port.dataset.port)
    .join(',') === '0,1,2',
  colorPorts().map((port) => port.dataset.port).join(','),
);
check(
  '三个 α 口端口号排在后面（3/4/5）',
  alphaPorts()
    .map((port) => port.dataset.port)
    .join(',') === '3,4,5',
  alphaPorts().map((port) => port.dataset.port).join(','),
);
check(
  'α 口有虚线样式 + 口外那颗 α 小字（和彩色口一眼分得开）',
  alphaPorts().every((port) => port.classList.contains('cg-alpha')) &&
    alphaPorts().every((port) => port.querySelector('.cg-port-tag')?.textContent === 'α'),
  alphaPorts()[0]?.className ?? '',
);
check(
  'α 口提示语写的是「遮罩 N（透明通道）」',
  (alphaPorts()[0]?.getAttribute('title') ?? '').startsWith('遮罩 1') &&
    (alphaPorts()[0]?.getAttribute('title') ?? '').includes('透明通道'),
  alphaPorts()[0]?.getAttribute('title') ?? '',
);
check(
  'α 口长在同一张缩略图下方（比彩色口低 15px）',
  Number.parseFloat(alphaPorts()[0].style.top) -
    Number.parseFloat(colorPorts()[0].style.top) ===
    15,
  `${colorPorts()[0].style.top} -> ${alphaPorts()[0].style.top}`,
);

// ---------------------------------------------------------------- 2) 间距 / 行高
{
  const style = doc.querySelector('style[data-fisherai-compositor-style]');
  check(
    '缩略图行距调大到 14px（用户「输入的图间距大一点」）',
    (style?.textContent ?? '').includes('.cg-node-body .cg-thumb + .cg-thumb { margin-top: 14px; }'),
  );
  check(
    '三张缩略图都在、默认行高 96px',
    thumbs().length === 3 && thumbs().every((thumb) => thumb.style.height === '96px'),
    thumbs().map((thumb) => thumb.style.height).join(','),
  );
  const grip = inputNode()?.querySelector('.cg-node-grip');
  check('输入节点右下角有行高把手', !!grip);

  // 拖 40px 抬高
  pointer('pointerdown', grip, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
  pointer('pointermove', window, { buttons: 0, clientX: 300, clientY: 340 });
  pointer('pointerup', window, { button: 0, buttons: 0, clientX: 300, clientY: 340 });
  await settle(80);
  check(
    '拖动把手：行高 96 → 136，缩略图跟着变高',
    report().input.rowHeight === 136 && thumbs().every((thumb) => thumb.style.height === '136px'),
    `rowHeight=${report().input.rowHeight} thumb=${thumbs()[0]?.style.height}`,
  );
  check(
    'α 口跟着缩略图重新对齐（行高变大后仍在彩色口下方 15px）',
    Number.parseFloat(alphaPorts()[0].style.top) -
      Number.parseFloat(colorPorts()[0].style.top) ===
      15,
    `${colorPorts()[0].style.top} -> ${alphaPorts()[0].style.top}`,
  );
  // 双击复位
  pointer('dblclick', inputNode()?.querySelector('.cg-node-grip'), { button: 0 });
  await settle(80);
  check('双击把手复位到 96px', report().input.rowHeight === 96, String(report().input.rowHeight));
}

// ---------------------------------------------------------------- 3) 拖缩略图换顺序
{
  const beforeSlots = report().input.slots.map((slot) => slot.url);
  const edgesBefore = report().edges.filter((edge) => edge.from === 'input');
  const step = 96 + 14;
  const first = thumbs()[0];
  pointer('pointerdown', first, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
  pointer('pointermove', window, { buttons: 0, clientX: 300, clientY: 300 + step * 2 });
  pointer('pointerup', window, { button: 0, buttons: 0, clientX: 300, clientY: 300 + step * 2 });
  await settle(120);

  const afterSlots = report().input.slots.map((slot) => slot.url);
  check(
    '把第 1 张拖到第 3 位：槽位顺序变成 b,c,a',
    afterSlots[0] === beforeSlots[1] &&
      afterSlots[1] === beforeSlots[2] &&
      afterSlots[2] === beforeSlots[0],
    afterSlots.join(' , '),
  );
  check(
    '顺序存进输入节点的 params.order（重开合成器还是这个顺序）',
    report().input.order.join(',') === '1,2,0',
    report().input.order.join(','),
  );
  const edgesAfter = report().edges.filter((edge) => edge.from === 'input');
  check(
    '连线跟着图走：原来接第 1 张的两条边（输出+预览）现在都从端口 2 出来',
    edgesBefore.filter((edge) => edge.fromPort === 0).length === 2 &&
      edgesAfter.filter((edge) => edge.fromPort === 2).length === 2 &&
      edgesAfter.length === 6 &&
      edgesAfter.filter((edge) => edge.fromPort === 1).length === 2,
    edgesBefore.map((edge) => edge.fromPort).join(',') +
      ' -> ' +
      edgesAfter.map((edge) => edge.fromPort).join(','),
  );

  // Ctrl+Z 撤销：顺序与端口都要回去
  doc.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle(120);
  check(
    'Ctrl+Z 撤销换顺序：槽位与端口一起回到原位',
    report().input.slots.map((slot) => slot.url).join(',') === beforeSlots.join(',') &&
      report().edges.filter((edge) => edge.from === 'input' && edge.fromPort === 0).length === 2,
    report().input.slots.map((slot) => slot.url).join(','),
  );

  // 缩略图几乎铺满卡片：横着拖必须是「搬整张卡片」，不能把「拖节点」这个手势吃掉
  const inputBefore = report().nodes.find((node) => node.id === 'input');
  const dragThumb = thumbs()[0];
  pointer('pointerdown', dragThumb, { button: 0, buttons: 1, clientX: 300, clientY: 300 });
  pointer('pointermove', window, { buttons: 0, clientX: 380, clientY: 302 });
  pointer('pointermove', window, { buttons: 0, clientX: 460, clientY: 304 });
  pointer('pointerup', window, { button: 0, buttons: 0, clientX: 460, clientY: 304 });
  await settle(120);
  const inputAfter = report().nodes.find((node) => node.id === 'input');
  check(
    '横着拖缩略图 = 搬整张卡片（节点 x 跟着走 +160，顺序不变）',
    (inputAfter?.x ?? 0) - (inputBefore?.x ?? 0) === 160 &&
      report().input.order.join(',') === '0,1,2',
    `x ${inputBefore?.x} -> ${inputAfter?.x} order=${report().input.order.join(',')}`,
  );
}

// ---------------------------------------------------------------- 4) Shift+Ctrl 手势
{
  const clearEdges = async () => {
    for (let guard = 0; guard < 12; guard += 1) {
      const hit = overlay?.querySelector('.cg-edge-hit');
      if (!hit) break;
      hit.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await settle(30);
    }
  };
  const toViewer = () => report().edges.filter((edge) => edge.to === 'viewer');
  const toOutput = () => report().edges.filter((edge) => edge.to === 'output');
  const head = inputNode()?.querySelector('.cg-node-head');

  await clearEdges();
  check('先断开默认的两条线', toViewer().length === 0 && toOutput().length === 0);

  // Shift+Ctrl+左键 = 接预览（用户 2026-11-22：「我之前的要求是接到预览」）
  pointer('pointerdown', head, { button: 0, buttons: 1, shiftKey: true, ctrlKey: true });
  pointer('pointerup', head, { button: 0, buttons: 0, shiftKey: true, ctrlKey: true });
  await settle(60);
  check(
    'Shift+Ctrl+左键接到**预览**（不再接输出）',
    toViewer().length === 1 && toOutput().length === 0,
    `viewer=${toViewer().length} output=${toOutput().length}`,
  );

  // Shift+Ctrl+右键 = 接输出
  pointer('pointerdown', head, {
    button: 2,
    buttons: 2,
    shiftKey: true,
    ctrlKey: true,
    clientX: 200,
    clientY: 200,
  });
  pointer('pointerup', head, { button: 2, buttons: 0, shiftKey: true, ctrlKey: true });
  await settle(60);
  check(
    'Shift+Ctrl+右键接到**输出**（右键不会被划选合并吞掉）',
    toOutput().length === 1 && toViewer().length === 1,
    `viewer=${toViewer().length} output=${toOutput().length}`,
  );
  check(
    '接输出用的是输入节点的彩色口 0（不是 α 口）',
    toOutput()[0]?.fromPort === 0,
    String(toOutput()[0]?.fromPort),
  );

  // 不按修饰键的右键仍然只做划选（不能顺手再接一条）
  const before = report().edges.length;
  pointer('pointerdown', head, { button: 2, buttons: 2, clientX: 200, clientY: 260 });
  pointer('pointerup', head, { button: 2, buttons: 0, clientX: 200, clientY: 260 });
  await settle(60);
  check(
    'Shift+Ctrl 之外的右键不改连线（留给合线 / 切刀）',
    report().edges.length === before,
    `${before} -> ${report().edges.length}`,
  );
}

// ---------------------------------------------------------------- 5) α 口真的能接线
{
  const before = report().edges.filter((edge) => edge.from === 'input' && edge.fromPort === 3);
  check('默认图不接 α 口（老图语义不变）', before.length === 0, String(before.length));
  const alpha = alphaPorts()[0];
  pointer('pointerdown', alpha, { button: 0, buttons: 1, clientX: 400, clientY: 400 });
  // 松手落在「预览」节点的输入口上：jsdom 没有布局，坐标按编辑器同一套换算推出来
  const view = report().view;
  const viewerNodeReport = report().nodes.find((node) => node.id === 'viewer');
  const dropX = view.x + (viewerNodeReport?.x ?? 720) * view.scale;
  const dropY = view.y + ((viewerNodeReport?.y ?? 360) + 17) * view.scale;
  pointer('pointermove', window, { buttons: 0, clientX: dropX, clientY: dropY });
  pointer('pointerup', window, { button: 0, buttons: 0, clientX: dropX, clientY: dropY });
  await settle(80);
  const wired = report().edges.filter((edge) => edge.from === 'input' && edge.fromPort === 3);
  check(
    'α 口能拖线接进预览（端口号 = 3，即第 1 张图的遮罩）',
    wired.length === 1 && wired[0].to === 'viewer',
    JSON.stringify(report().edges.filter((edge) => edge.from === 'input')),
  );
}

// ---------------------------------------------------------------- 6) 运行时无错误
{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check(
    '输入节点链路全程无运行时错误',
    errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)',
  );
}

try {
  handle.dispose();
} catch {
  /* 卸载失败不影响本套件结论 */
}
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
