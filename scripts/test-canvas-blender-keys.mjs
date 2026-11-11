/**
 * 主画布的 Blender 手感回归（v1.94）：G 抓取移动 / X 锁轴 / X 删除。
 *
 * 用户 2026-11-11 原话：「选中按 g 键移动，再次点击 x 或沿着对应的轴向移动。
 * 还有删除节点可以用 x 来删除。仿照 blender 的操作逻辑」。
 *
 * 实现分两处、规则完全一致：
 *   - 主画布：scripts/vendor-aifisher.mjs 补丁 3.8x 改 vendor 的 canvasCommands.ts
 *     （React hook 里握着 nodes / viewport / setNodes，只能在那里动状态）；
 *   - 调色面板：src/client/canvas/compositor/editor.ts 的 startGrab（test-canvas-compositor 守）。
 *
 * 这里只验主画布：节点真跟着指针走、锁轴只走一个方向、左键落下、Esc 还原、X 删除。
 * 用法：node scripts/test-canvas-blender-keys.mjs   （需要先 build）
 */
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';
import { rmSync } from 'node:fs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const host = await startHost();
const projectId = 'blender-keys-proj';

{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: 'G/X 手感验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(1500);
const doc = window.document;

const tool = host.tool('canvas_control');
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-blender-keys' } } });
const readNodes = async () => {
  const read = await run({ action: 'read' });
  return Array.isArray(read.result?.nodes) ? read.result.nodes : [];
};

const key = (options) =>
  doc.dispatchEvent(
    new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options }),
  );
const pointer = (type, target, options) =>
  target?.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, cancelable: true, buttons: 1, ...options }),
  );

// 用「建节点」事件建一张图：它会被自动选中（和 Shift+A 建节点同一条桥）
window.dispatchEvent(
  new window.CustomEvent('fisherai:add-canvas-node', {
    detail: { type: 'Image', point: { x: 200, y: 200 } },
  }),
);
await settle(400);

let nodes = await readNodes();
const target = nodes[0];
check('建出一张 Image 并被选中（键盘手势的前提）', Boolean(target), JSON.stringify(nodes).slice(0, 200));

const canvasBackground = doc.getElementById('canvas-background');
check('找得到画布底盘（G 的落下点在这上面）', Boolean(canvasBackground));

// 指针先放到一个已知点：G 的起手基准、以及随后位移都从它算
const start = { x: 300, y: 300 };
pointer('pointermove', window, { clientX: start.x, clientY: start.y, buttons: 0 });

// ---------------------------------------------------------------- 1) G 抓取：节点跟着指针走
key({ key: 'g' });
pointer('pointermove', window, { clientX: 420, clientY: 380, buttons: 0 });
await settle(120);
nodes = await readNodes();
let moved = nodes.find((node) => node.id === target.id);
check(
  'G 抓取：节点跟着指针走（位移 ÷ 缩放 = +120 / +80）',
  moved && moved.x - target.x === 120 && moved.y - target.y === 80,
  JSON.stringify({ start: [target.x, target.y], now: [moved?.x, moved?.y] }),
);

// ---------------------------------------------------------------- 2) X 锁轴：只走横向
key({ key: 'x' });
pointer('pointermove', window, { clientX: 500, clientY: 460, buttons: 0 });
await settle(120);
nodes = await readNodes();
const locked = nodes.find((node) => node.id === target.id);
check(
  '抓取中按 X 锁轴：只走横向（纵向回到起手高度）',
  locked && locked.x - target.x === 200 && locked.y === target.y,
  JSON.stringify({ start: [target.x, target.y], now: [locked?.x, locked?.y] }),
);

// 再按一次 X 解锁：两个方向都跟着走
key({ key: 'x' });
pointer('pointermove', window, { clientX: 520, clientY: 500, buttons: 0 });
await settle(120);
nodes = await readNodes();
const free = nodes.find((node) => node.id === target.id);
check(
  '再按一次 X 解锁：两个方向都跟着走',
  free && free.x - target.x === 220 && free.y - target.y === 200,
  JSON.stringify({ start: [target.x, target.y], now: [free?.x, free?.y] }),
);

// ---------------------------------------------------------------- 3) 左键落下：结束抓取
pointer('pointerdown', canvasBackground, { button: 0, buttons: 1, clientX: 520, clientY: 500 });
pointer('pointerup', window, { button: 0, buttons: 0, clientX: 520, clientY: 500 });
await settle(160);
pointer('pointermove', window, { clientX: 760, clientY: 640, buttons: 0 });
await settle(120);
nodes = await readNodes();
const settledDown = nodes.find((node) => node.id === target.id);
check(
  '左键落下后不再跟随鼠标',
  settledDown && settledDown.x === free?.x && settledDown.y === free?.y,
  JSON.stringify({ before: [free?.x, free?.y], after: [settledDown?.x, settledDown?.y] }),
);

// ---------------------------------------------------------------- 4) Esc 取消：位置还原
const beforeCancel = settledDown;
pointer('pointermove', window, { clientX: 700, clientY: 700, buttons: 0 });
key({ key: 'g' });
pointer('pointermove', window, { clientX: 900, clientY: 900, buttons: 0 });
await settle(120);
nodes = await readNodes();
const midCancel = nodes.find((node) => node.id === target.id);
check(
  'Esc 之前确实移动了（抓取进行中）',
  midCancel && midCancel.x !== beforeCancel.x,
  JSON.stringify([beforeCancel?.x, midCancel?.x]),
);
key({ key: 'Escape' });
await settle(160);
nodes = await readNodes();
const restored = nodes.find((node) => node.id === target.id);
check(
  'G 抓取中按 Esc 取消：位置完全还原',
  restored && restored.x === beforeCancel.x && restored.y === beforeCancel.y,
  JSON.stringify({ before: [beforeCancel?.x, beforeCancel?.y], after: [restored?.x, restored?.y] }),
);

// ---------------------------------------------------------------- 5) X 删除选中节点
const beforeDelete = nodes.length;
key({ key: 'x' });
await settle(400);
nodes = await readNodes();
check(
  '按 X 删除选中节点（和 Delete 同义）',
  nodes.length === beforeDelete - 1 && !nodes.some((node) => node.id === target.id),
  `nodes=${beforeDelete} -> ${nodes.length}`,
);

// ---------------------------------------------------------------- 6) 运行时无错误
{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('G/X 链路全程无运行时错误', errors.length === 0, errors.map((entry) => entry.message).join(' | ') || '(none)');
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
