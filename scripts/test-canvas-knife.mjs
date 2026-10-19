/**
 * 切刀（Ctrl + 右键拖拽切开连线）回归 —— v1.49。
 *
 * 用户原话（2026-10-19）：
 *   「现在做一个新功能，像blender一样按住ctrl加鼠标右键切换到切刀工具，划过的线会断开连接」。
 *
 * 两半：
 *   A. **纯几何**（跑构建产物，不依赖布局）：
 *      `d` 解析（三次贝塞尔采样）→ 世界坐标 → 屏幕坐标 → 「这一刀划到没划到」→ 切哪几条。
 *      这几步是整套功能的地基：vendored 的 `<path>` 只有 `d` 字符串，jsdom 又没有
 *      `getPointAtLength()`，所以采样必须由我们自己算（见 src/client/canvas/knife.ts）。
 *   B. **真 DOM**（jsdom 里真挂画布、真派发 Ctrl + 右键拖拽）：
 *      ① 连线 `<g>` 带上了 (parentId, childId, portIndex) 身份属性（vendor 补丁 3.8t），
 *         切刀按身份断开，而不是猜 `data-edge-key`；
 *      ② 拖拽过程中有刀口预览与「会被切开的线」高亮；
 *      ③ 松手真的断开——**只断开被划过的那一条**，同一子节点上另一条连线原样保留；
 *      ④ Esc 取消一刀不落；不按 Ctrl 的右键不触发切刀；Ctrl+右键时右键菜单被压住；
 *      ⑤ 存盘之后文档里 `parentIds` 真的少了一项（刷新回来也不会复活）。
 *
 * 用法：node scripts/test-canvas-knife.mjs   （需要先 build）
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

// ---------------------------------------------------------------- 0) 预置项目
//
// A、B 都是 Image（有结果图，卡片会渲染），C 同时接 A、B：
// 这样「切掉 A→C」之后还能看到「B→C 没被误伤」——身份读错时这一条必红。
const PROJECT_ID = 'proj-canvas-knife';
const IMAGE = (file) => `/api/aifisher/canvas/media/${PROJECT_ID}/images/${file}`;

const makeNode = (id, title, x, y, extra = {}) => ({
  id,
  type: 'Image',
  x,
  y,
  title,
  prompt: title,
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
    title: '切刀验证',
    nodes: [
      makeNode('knife-a', '上游 A', 40, 40),
      makeNode('knife-b', '上游 B', 40, 360),
      makeNode('knife-c', '下游 C', 640, 160, { parentIds: ['knife-a', 'knife-b'] }),
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置「C 同时接 A、B」的项目写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { canvasApp, handle } = await mountCanvasApp(window);
await settle(1600);
const doc = window.document;

// ---------------------------------------------------------------- 1) 纯几何（构建产物）
{
  const {
    KNIFE_HIT_TOLERANCE,
    knifeCutTargets,
    knifeDistancePointSegment,
    knifePointsToScreen,
    knifeSegmentsCross,
    knifeStrokeHitsEdge,
    knifeViewportTransform,
    parseKnifePath,
  } = canvasApp;
  check(
    '产物导出了切刀的纯函数（parseKnifePath / knifeCutTargets …）',
    typeof parseKnifePath === 'function' &&
      typeof knifeCutTargets === 'function' &&
      typeof knifeViewportTransform === 'function',
    `${typeof parseKnifePath}/${typeof knifeCutTargets}/${typeof knifeViewportTransform}`,
  );

  const viewport = knifeViewportTransform('translate3d(120px, 40px, 0px) scale(0.5)');
  check(
    '认得出 vendor 写的 translate3d + scale',
    viewport?.x === 120 && viewport?.y === 40 && viewport?.zoom === 0.5,
    JSON.stringify(viewport),
  );
  const matrix = knifeViewportTransform('matrix(2, 0, 0, 2, 30, 60)');
  check(
    '万一改成 matrix(...) 也读得出来（zoom / 平移）',
    matrix?.zoom === 2 && matrix?.x === 30 && matrix?.y === 60,
    JSON.stringify(matrix),
  );
  check('读不出来时返回 null（不会把线画到错的位置）',
    knifeViewportTransform('') === null && knifeViewportTransform('rotate(3deg)') === null);

  // vendor 的 edgePath 就是这个形状：M start C c1, c2, end
  const curve = 'M 0 0 C 0 50, 100 50, 100 0';
  const points = parseKnifePath(curve);
  check('解析连线 `d`：从起点开始、到终点结束', points.length >= 3 &&
    Math.abs(points[0].x) < 1e-6 && Math.abs(points[0].y) < 1e-6 &&
    Math.abs(points[points.length - 1].x - 100) < 1e-6 &&
    Math.abs(points[points.length - 1].y) < 1e-6,
    JSON.stringify([points[0], points[points.length - 1]]));
  const middle = points[Math.round((points.length - 1) / 2)];
  check('三次贝塞尔中点算对了（(50, 37.5)，不是折线近似）',
    Math.abs(middle.x - 50) < 1e-6 && Math.abs(middle.y - 37.5) < 1e-6,
    JSON.stringify(middle));
  check('坏路径不炸、返回空数组', parseKnifePath('').length === 0 && parseKnifePath('nonsense').length === 0,
    `${parseKnifePath('').length}/${parseKnifePath('nonsense').length}`);

  const screen = knifePointsToScreen([{ x: 10, y: 20 }], { x: 100, y: 50, zoom: 2 }, { x: 5, y: 7 });
  check('世界坐标 → 屏幕坐标（先乘 zoom、再加平移与底盘原点）',
    screen[0].x === 125 && screen[0].y === 97, JSON.stringify(screen));

  check('点到线段距离：垂足 / 端点外 / 退化线段三种都对',
    Math.abs(knifeDistancePointSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }) - 5) < 1e-9 &&
      Math.abs(knifeDistancePointSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }) - 5) < 1e-9 &&
      Math.abs(knifeDistancePointSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }) - 5) < 1e-9);

  check('线段相交：交叉 true、远离 false、擦边（≤容差）true',
    knifeSegmentsCross({ x: 0, y: -5 }, { x: 10, y: 5 }, { x: 0, y: 5 }, { x: 10, y: -5 }) === true &&
      knifeSegmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 100 }, { x: 10, y: 100 }) === false &&
      knifeSegmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: KNIFE_HIT_TOLERANCE - 1 },
        { x: 10, y: KNIFE_HIT_TOLERANCE - 1 }) === true);

  const edge = { key: 'p|q|0', parentId: 'p', childId: 'q', portIndex: 0,
    points: [{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 100, y: 50 }] };
  check('一刀横着划过去 → 命中这条线',
    knifeStrokeHitsEdge([{ x: 50, y: 0 }, { x: 50, y: 100 }], edge.points) === true);
  check('一刀在远处划 → 不命中', knifeStrokeHitsEdge([{ x: 50, y: 200 }, { x: 50, y: 260 }], edge.points) === false);
  check('只点一下（没有位移）不算一刀', knifeStrokeHitsEdge([{ x: 50, y: 50 }], edge.points) === false);

  const targets = knifeCutTargets(
    [{ x: 50, y: 0 }, { x: 50, y: 100 }],
    // 第二条是**同一身份**的重复项（同一个 key）：只算一次；第三条在远处，不该被切。
    [edge, { ...edge }, { ...edge, key: 'r|s|0', parentId: 'r', childId: 's',
      points: [{ x: 0, y: 400 }, { x: 100, y: 400 }] }],
  );
  check('只切划到的那几条、按 key 去重（同一身份不会重复切）',
    targets.length === 1 && targets[0].parentId === 'p' && targets[0].portIndex === 0,
    JSON.stringify(targets.map((item) => item.key)));
}

// ---------------------------------------------------------------- 2) 真 DOM：身份属性
const edgeGroups = () => [...doc.querySelectorAll('#canvas-viewport-content g[data-fisherai-edge-parent-id]')];
await waitFor(() => edgeGroups().length >= 2, 8000);

{
  const groups = edgeGroups();
  check('两条连线都渲染出来了（A→C、B→C）', groups.length === 2,
    groups.map((g) => g.getAttribute('data-fisherai-edge-parent-id')).join(','));
  check('连线上有可读的父/子/端口身份（vendor 补丁 3.8t）',
    groups.every((g) =>
      g.getAttribute('data-fisherai-edge-parent-id') &&
      g.getAttribute('data-fisherai-edge-child-id') === 'knife-c' &&
      g.getAttribute('data-fisherai-edge-port-index') !== null),
    JSON.stringify(groups.map((g) => ({
      parent: g.getAttribute('data-fisherai-edge-parent-id'),
      child: g.getAttribute('data-fisherai-edge-child-id'),
      port: g.getAttribute('data-fisherai-edge-port-index'),
    }))));

  const edges = canvasApp.collectKnifeEdges(doc);
  check('切刀从画面读出两条连线的屏幕折线', edges.length === 2 &&
    edges.every((item) => item.childId === 'knife-c' && item.points.length > 2),
    JSON.stringify(edges.map((item) => ({ key: item.key, n: item.points.length }))));
  check('读出来的身份与画布一致（parentId 是 A / B 而不是拼出来的猜测）',
    edges.some((item) => item.parentId === 'knife-a') && edges.some((item) => item.parentId === 'knife-b'),
    edges.map((item) => item.parentId).join(','));
  check('连线的屏幕坐标落在画布内（不是 0×0 或 NaN）',
    edges.every((item) => item.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))));
}

// ---------------------------------------------------------------- 3) 真手势：Ctrl + 右键划一刀
const canvasBackground = doc.getElementById('canvas-background');
const overlay = () => doc.querySelector('[data-fisherai-knife-overlay]');
const knifePointer = (type, x, y, options = {}) =>
  new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 2,
    buttons: 2,
    ctrlKey: true,
    ...options,
  });

/** 取 (parentId) 那条连线在屏幕上的一个点，沿曲线 15% 处 —— 离另一条线足够远。 */
const pointOnEdge = (parentId, progress = 0.15) => {
  const edge = canvasApp.collectKnifeEdges(doc).find((item) => item.parentId === parentId);
  if (!edge) return null;
  return edge.points[Math.max(1, Math.round((edge.points.length - 1) * progress))];
};

{
  const point = pointOnEdge('knife-a');
  check('找得到 A→C 连线上的取样点', !!point, JSON.stringify(point));
  if (point) {
    canvasBackground.dispatchEvent(knifePointer('pointerdown', point.x, point.y - 40));
    check('Ctrl+右键按下 → 进入切刀（画布上出现刀口浮层）', !!overlay(),
      overlay() ? 'overlay' : '(missing)');
    canvasBackground.dispatchEvent(knifePointer('pointermove', point.x, point.y));
    canvasBackground.dispatchEvent(knifePointer('pointermove', point.x, point.y + 40));
    await settle(120);
    const strokePath = overlay()?.querySelector('[data-fisherai-knife-stroke]');
    const hintPath = overlay()?.querySelector('[data-fisherai-knife-hint]');
    check('拖拽中刀口线跟着画出来（白色虚线，d 非空）',
      !!strokePath?.getAttribute('d')?.includes('L'), strokePath?.getAttribute('d') ?? '(missing)');
    check('拖拽中「会被切开的线」高亮成红色（hint 有 d，且只有被划过的那条）',
      !!hintPath?.getAttribute('d') && (hintPath?.getAttribute('d') ?? '').split('M').length === 2,
      hintPath?.getAttribute('d') ?? '(missing)');
    canvasBackground.dispatchEvent(knifePointer('pointerup', point.x, point.y + 40));
    await settle(500);
    check('松手后刀口浮层收起', overlay() === null, overlay() ? 'still-there' : 'gone');
  }
}

{
  const report = canvasApp.knifeReport();
  check('切刀读数：这一场开过 1 次、切中 1 条、断开 1 条',
    report.sessions === 1 && report.targets === 1 && report.cuts === 1,
    JSON.stringify(report));
  check('切刀桥装上了（window.__FISHERAI_CANVAS_KNIFE__.cut 存在）', report.bridge === true);
  check('这一刀没有出错（lastError 为空）', report.lastError === '', report.lastError);

  const groups = edgeGroups();
  check('A→C 那条连线从画面上消失、B→C 原样保留',
    groups.length === 1 && groups[0].getAttribute('data-fisherai-edge-parent-id') === 'knife-b',
    groups.map((g) => g.getAttribute('data-fisherai-edge-parent-id')).join(','));
  check('切完读数里的连线也只剩 1 条', canvasApp.knifeReport().edges === 1);
}

// ---------------------------------------------------------------- 4) Esc 取消：一刀不落
{
  const point = pointOnEdge('knife-b', 0.5);
  check('找得到 B→C 连线上的取样点', !!point, JSON.stringify(point));
  if (point) {
    canvasBackground.dispatchEvent(knifePointer('pointerdown', point.x, point.y - 30));
    canvasBackground.dispatchEvent(knifePointer('pointermove', point.x, point.y + 30));
    await settle(60);
    check('第二刀按 Esc 之前还在（浮层在场）', !!overlay());
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle(60);
    check('按 Esc → 浮层立刻收起', overlay() === null);
    canvasBackground.dispatchEvent(knifePointer('pointerup', point.x, point.y + 30));
    await settle(120);
    check('Esc 取消之后连线还在（一刀没落）', edgeGroups().length === 1 &&
      canvasApp.knifeReport().cuts === 1, String(edgeGroups().length));
  }
}

// ---------------------------------------------------------------- 5) 不该触发的情况 + 右键菜单
{
  const point = pointOnEdge('knife-b', 0.5) ?? { x: 100, y: 100 };
  canvasBackground.dispatchEvent(knifePointer('pointerdown', point.x, point.y, { ctrlKey: false }));
  check('不按 Ctrl 的右键不进入切刀（正常右键菜单照旧）', overlay() === null);
  canvasBackground.dispatchEvent(knifePointer('pointerup', point.x, point.y, { ctrlKey: false }));

  // 收刀 600ms 内会主动压住 contextmenu；这里等窗口过去，验「平时右键菜单不被误伤」。
  await settle(800);
  // 「压住」不能只看 defaultPrevented —— vendor 自己的右键菜单也会 preventDefault。
  // 真判据是**事件有没有继续往下走**：切刀在 document 捕获阶段 stopPropagation，
  // 画布上的监听器就收不到；没按 Ctrl 时事件照常到达画布。
  const reached = [];
  const markReached = () => reached.push('canvas');
  canvasBackground.addEventListener('contextmenu', markReached);
  const plain = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: point.x, clientY: point.y,
  });
  canvasBackground.dispatchEvent(plain);
  check('平时在画布上右键 → 事件照常到达画布（右键菜单不会被切刀吞掉）',
    reached.length === 1, String(reached.length));

  const withCtrl = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, ctrlKey: true,
  });
  canvasBackground.dispatchEvent(withCtrl);
  canvasBackground.removeEventListener('contextmenu', markReached);
  check('按住 Ctrl 在画布上右键 → 事件被拦在捕获阶段（不会打断切刀手势）',
    reached.length === 1 && withCtrl.defaultPrevented === true, String(reached.length));
}

// ---------------------------------------------------------------- 6) 存盘后文档里真的少了这一项
await settle(4200);
{
  const saved = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  const nodes = saved.json().nodes ?? [];
  const downstream = nodes.find((node) => node.id === 'knife-c');
  check('存盘后 C 的 parentIds 只剩 B（A 真的被切开，不是只少画了一条线）',
    JSON.stringify(downstream?.parentIds) === JSON.stringify(['knife-b']),
    JSON.stringify(downstream?.parentIds));
  check('上游两个节点都还在（切刀只断连线，不删节点）',
    nodes.some((node) => node.id === 'knife-a') && nodes.some((node) => node.id === 'knife-b'),
    nodes.map((node) => node.id).join(','));
}

// ---------------------------------------------------------------- 7) 渲染期没有运行时错误
{
  const diag = await host.hostApi('GET', '/diagnostics?limit=50');
  const errors = (diag.json().entries ?? []).filter((entry) => entry.level === 'error');
  check('整轮没有运行时错误（切刀没把画布弄崩）', errors.length === 0,
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
