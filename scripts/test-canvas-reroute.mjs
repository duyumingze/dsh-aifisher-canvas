/**
 * 转接（Shift + 右键划选合并）回归 —— v1.71。
 *
 * 用户原话（2026-10-29）：
 *   「加一个shift+鼠标右键划过的线合并并添加转接口的功能」；
 *   追问后确认：**同源才合并**（同一个输出口分出去的几条线并成一条主干，
 *   不同上游各得一个转接点），并且合成器与主画布两个都要。
 *
 * 这一套守主画布这半：
 *   A. 纯函数：命中线 → 按 parentId 分组（同源合成一组）、节点落点换算；
 *   B. 真 DOM + 真手势：同一个上游的两条线（ra→rc、ra→rd）被 Shift+右键划过 →
 *      只生成**一个** Junction，结构变成 ra→J、J→rc、J→rd；
 *   C. 透传：Junction 卡片显示上游 ra 的图（canvasSceneData 把 Junction 解析成上游）；
 *   D. 不误伤：Ctrl+右键切刀照旧能切（两条手势共存）；
 *   E. 落盘：junction 的 parentIds / rc、rd 的新 parentIds 真的写进文档。
 *
 * 用法：node scripts/test-canvas-reroute.mjs   （需要先 build）
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

const PROJECT_ID = 'proj-canvas-reroute';
const IMAGE = (file) => `/api/aifisher/canvas/media/${PROJECT_ID}/images/${file}`;

const makeNode = (id, x, y, extra = {}) => ({
  id,
  type: 'Image',
  x,
  y,
  title: id,
  prompt: id,
  status: 'success',
  model: 'Upload',
  resultUrl: IMAGE(`${id}.png`),
  resultUrls: [IMAGE(`${id}.png`)],
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
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '转接验证',
    // 一个上游、两个下游：两条线同源，划过后应该并成一个转接点
    nodes: [
      makeNode('ra', 40, 40),
      makeNode('rc', 640, 120, { parentIds: ['ra'] }),
      makeNode('rd', 640, 520, { parentIds: ['ra'] }),
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置「一个上游接两个下游」的项目写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { canvasApp, handle } = await mountCanvasApp(window);
await settle(1800);
const doc = window.document;

const edgeGroups = () => [...doc.querySelectorAll('#canvas-viewport-content g[data-fisherai-edge-parent-id]')];
await waitFor(() => edgeGroups().length >= 2, 8000);
const background = doc.getElementById('canvas-background');

// ---------------------------------------------------------------- 1) 纯函数
{
  check(
    '产物导出了转接的纯函数与尺寸常量',
    typeof canvasApp.rerouteGroupsFromHits === 'function' &&
      typeof canvasApp.canvasWorldPoint === 'function' &&
      canvasApp.JUNCTION_WIDTH === 34 &&
      canvasApp.JUNCTION_HEIGHT === 34,
    `${typeof canvasApp.rerouteGroupsFromHits}/${canvasApp.JUNCTION_WIDTH}x${canvasApp.JUNCTION_HEIGHT}`,
  );
  const stroke = [{ x: 500, y: 100 }, { x: 500, y: 500 }];
  const hits = [
    { key: 'ra|rc|0', parentId: 'ra', childId: 'rc', portIndex: 0, points: [{ x: 300, y: 200 }, { x: 700, y: 200 }] },
    { key: 'ra|rd|0', parentId: 'ra', childId: 'rd', portIndex: 0, points: [{ x: 300, y: 400 }, { x: 700, y: 400 }] },
    { key: 'rb|rc|0', parentId: 'rb', childId: 'rc', portIndex: 0, points: [{ x: 300, y: 150 }, { x: 700, y: 150 }] },
  ];
  const groups = canvasApp.rerouteGroupsFromHits(stroke, hits);
  check(
    '同源的两条线并成一组、不同上游各一组',
    groups.length === 2 &&
      groups.some((group) => group.parentId === 'ra' && group.children.length === 2) &&
      groups.some((group) => group.parentId === 'rb' && group.children.length === 1),
    JSON.stringify(groups.map((group) => [group.parentId, group.children.length])),
  );
  check(
    '转接点落点按 34×34 居中（左上角 = 交点 - 半宽高）',
    groups.every((group) => Number.isFinite(group.x) && Number.isFinite(group.y)) &&
      groups.some((group) => Math.abs(group.x - (500 - 17)) < 1),
    JSON.stringify(groups.map((group) => [group.x, group.y])),
  );
}

// ---------------------------------------------------------------- 2) 真手势：Shift+右键划两条同源线
const pointOnEdge = (parentId, progress = 0.5) => {
  const edge = canvasApp.collectKnifeEdges(doc).find((item) => item.parentId === parentId);
  if (!edge) return null;
  return edge.points[Math.max(1, Math.round((edge.points.length - 1) * progress))];
};

{
  const groups = edgeGroups();
  check('两条同源连线都渲染出来了（ra→rc、ra→rd）', groups.length === 2 &&
    groups.every((g) => g.getAttribute('data-fisherai-edge-parent-id') === 'ra'),
    groups.map((g) => `${g.getAttribute('data-fisherai-edge-parent-id')}->${g.getAttribute('data-fisherai-edge-child-id')}`).join(','));

  const edges = canvasApp.collectKnifeEdges(doc);
  const mids = edges.map((edge) => edge.points[Math.floor(edge.points.length / 2)]);
  const x = Math.round(mids.reduce((sum, mid) => sum + mid.x, 0) / mids.length);
  const top = Math.min(...mids.map((mid) => mid.y)) - 40;
  const bottom = Math.max(...mids.map((mid) => mid.y)) + 40;
  const pointer = (type, cx, cy, extra = {}) =>
    background.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: cx,
      clientY: cy,
      button: 2,
      buttons: 2,
      shiftKey: true,
      ...extra,
    }));

  pointer('pointerdown', x, top);
  check('Shift+右键按下 → 进入合并手势（浮层出现、命中线高亮成绿色）', !!doc.querySelector('[data-fisherai-knife-overlay]'));
  pointer('pointermove', x, top + (bottom - top) / 2);
  pointer('pointermove', x, bottom);
  await settle(120);
  const hint = doc.querySelector('[data-fisherai-knife-overlay] [data-fisherai-knife-hint]');
  check(
    '合并手势的高亮是绿色（不是切刀的红）',
    (hint?.getAttribute('stroke') ?? '').includes('96, 220, 160'),
    hint?.getAttribute('stroke') ?? '(missing)',
  );
  pointer('pointerup', x, bottom);
  await settle(600);
}

{
  const report = canvasApp.knifeReport();
  check(
    'Shift+右键读数：合过 1 次、划中 2 条、新增 1 个转接点',
    report.sessions === 1 && report.targets === 2 && report.merges === 1 && report.cuts === 0,
    JSON.stringify(report.lastGesture),
  );
  check('转接桥装上了（window.__FISHERAI_CANVAS_REROUTE__.merge 存在）', report.bridgeReroute === true);
  check('这一下没有出错（lastError 为空）', report.lastError === '', report.lastError);

  const groups = edgeGroups();
  const parentIds = groups.map((g) => g.getAttribute('data-fisherai-edge-parent-id'));
  const childIds = groups.map((g) => g.getAttribute('data-fisherai-edge-child-id'));
  check(
    '结构变成「上游 → 转接 → 两个下游」（中间节点多了一条进、两条出）',
    groups.length === 3 &&
      parentIds.filter((id) => id === 'ra').length === 1 &&
      childIds.filter((id) => id === 'rc').length === 1 &&
      childIds.filter((id) => id === 'rd').length === 1,
    groups.map((g) => `${g.getAttribute('data-fisherai-edge-parent-id')}->${g.getAttribute('data-fisherai-edge-child-id')}`).join(','),
  );
  check(
    '转接点是 34×34 的小圆点（不是 160 宽的卡片）',
    !!doc.querySelector('[data-fisherai-junction]') &&
      [...doc.querySelectorAll('[data-fisherai-junction]')].length === 1,
    String([...doc.querySelectorAll('[data-fisherai-junction]')].length),
  );
  check(
    '转接点卡片显示上游 ra 的图（canvasSceneData 把 Junction 解析成上游）',
    [...doc.querySelectorAll('img[alt="转接上游"]')].some((img) => (img.getAttribute('src') ?? '').includes('ra.png')),
    [...doc.querySelectorAll('img[alt="转接上游"]')].map((img) => img.getAttribute('src')).join(','),
  );
}

// ---------------------------------------------------------------- 3) Ctrl+右键切刀不被带坏
{
  // 切「转接 → rc」这一条：与合并手势互不干扰，也不会顺手把转接节点的上游切没
  const edge = canvasApp.collectKnifeEdges(doc).find((item) => item.childId === 'rc');
  const target = edge ? edge.points[Math.floor(edge.points.length / 2)] : null;
  check('找得到「转接 → rc」连线上的取样点', !!target, JSON.stringify(target));
  if (target) {
    const pointer = (type, cx, cy, extra = {}) =>
      background.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        button: 2,
        buttons: 2,
        ctrlKey: true,
        ...extra,
      }));
    pointer('pointerdown', target.x, target.y - 20);
    pointer('pointermove', target.x, target.y + 20);
    pointer('pointerup', target.x, target.y + 20);
    await settle(400);
    const report = canvasApp.knifeReport();
    check('Ctrl+右键照旧是切刀（cuts=1、merges 不变）', report.cuts === 1 && report.merges === 1,
      JSON.stringify({ cuts: report.cuts, merges: report.merges }));
  }
}

// ---------------------------------------------------------------- 4) 落盘
await settle(4200);
{
  const saved = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  const nodes = saved.json().nodes ?? [];
  const junction = nodes.find((node) => node.type === 'Junction');
  check(
    '存盘后转接节点存在、只有一个上游 ra、尺寸 34×34',
    !!junction && JSON.stringify(junction.parentIds) === JSON.stringify(['ra']) &&
      junction.width === 34 && junction.height === 34,
    JSON.stringify(junction && { parents: junction.parentIds, w: junction.width, h: junction.height }),
  );
  const rd = nodes.find((node) => node.id === 'rd');
  const rc = nodes.find((node) => node.id === 'rc');
  check(
    '存盘后 rd 的上游换成了转接节点',
    !!junction && JSON.stringify(rd?.parentIds) === JSON.stringify([junction.id]),
    JSON.stringify(rd?.parentIds),
  );
  check(
    '存盘后 rc 的上游被切刀断开（两种手势共存，没互相吞）',
    Array.isArray(rc?.parentIds) && rc.parentIds.length === 0,
    JSON.stringify(rc?.parentIds),
  );
  check(
    '三个上游/下游节点都还在（转接不删节点）',
    ['ra', 'rc', 'rd'].every((id) => nodes.some((node) => node.id === id)),
    nodes.map((node) => node.id).join(','),
  );
}

// ---------------------------------------------------------------- 5) 没有运行时错误
{
  const diag = await host.hostApi('GET', '/diagnostics?limit=50');
  const errors = (diag.json().entries ?? []).filter((entry) => entry.level === 'error');
  check('整轮没有运行时错误（转接没把画布弄崩）', errors.length === 0,
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
