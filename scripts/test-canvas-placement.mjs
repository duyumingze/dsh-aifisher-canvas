/**
 * 对话建节点落位回归（v1.53）：验证 agent 通过 canvas_control 建的节点
 * 不会遮罩画布上已有节点。
 *
 * 背景（2026-10-20 用户反馈「对话生成的节点会遮罩其他的节点」）：
 *   create 只把 x/y 原样交给画布，未给坐标时落 0,0 —— agent 连续建节点时全部叠在一点，
 *   新节点（数组尾部、最后渲染）就盖在已有节点上面。
 *
 * 本套件验证：
 *   1. 空画布 create 无坐标 → 落 (0,0)；
 *   2. 显式坐标落在空地 → 原样保留；
 *   3. 显式坐标与已有节点重叠 → host 自动挪到右侧空位；
 *   4. 一批多个 create（无坐标）彼此不重叠，也不与已有节点重叠；
 *   5. 全程无运行时错误。
 *
 * 用法：node scripts/test-canvas-placement.mjs   （需要先 build）
 */
import { mountCanvasApp, createCanvasDom, seedResume, settle, startHost, ROOT } from './lib/canvas-harness.mjs';
import { rmSync } from 'node:fs';

void ROOT;
const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

// 与 vendor nodeFramework DEFAULT_NODE_SIZES / host nodePlacement 保持一致
const SIZE = {
  text: [360, 300],
  image: [360, 420],
  video: [420, 360],
  audio: [360, 220],
};
const sizeOf = (node) => SIZE[String(node.type ?? '').toLowerCase()] ?? [360, 320];
const intersects = (a, b) => {
  const [aw, ah] = sizeOf(a);
  const [bw, bh] = sizeOf(b);
  return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y;
};
const countOverlaps = (nodes) => {
  let count = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (intersects(nodes[i], nodes[j])) count += 1;
    }
  }
  return count;
};

const host = await startHost();
const projectId = 'placement-proj';

{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '落位避让验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, JSON.stringify(save.json()).slice(0, 160));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(1500);

const tool = host.tool('canvas_control');
check('canvas_control 工具已注册', Boolean(tool));
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-placement' } } });
const readNodes = async () => {
  const read = await run({ action: 'read' });
  return Array.isArray(read.result?.nodes) ? read.result.nodes : [];
};

// ---------------------------------------------------------------- 1. 空画布无坐标 → (0,0)

{
  const edit = await run({
    action: 'edit',
    operations: [{ kind: 'create', ref: 'text', type: 'Text', title: '剧本', text: '测试正文' }],
  });
  check('空画布上无坐标 create 成功', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 200));
  const nodes = await readNodes();
  const text = nodes.find((node) => node.type === 'Text');
  check('空画布无坐标 create 落在 (0,0)', text?.x === 0 && text?.y === 0, JSON.stringify({ x: text?.x, y: text?.y }));
}

// ---------------------------------------------------------------- 2. 显式空位 → 原样保留

{
  const edit = await run({
    action: 'edit',
    operations: [{ kind: 'create', ref: 'free', type: 'Image', x: 2000, y: 2000, title: '空位图' }],
  });
  check('显式空位 create 成功', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 200));
  const nodes = await readNodes();
  const free = nodes.find((node) => node.title === '空位图');
  check('显式空位坐标原样保留', free?.x === 2000 && free?.y === 2000, JSON.stringify({ x: free?.x, y: free?.y }));
}

// ---------------------------------------------------------------- 3. 与已有节点重叠 → 自动挪开

{
  const before = await readNodes();
  const edit = await run({
    action: 'edit',
    operations: [{ kind: 'create', ref: 'overlap', type: 'Image', x: 0, y: 0, title: '重叠图' }],
  });
  check('重叠坐标 create 成功（被 host 改位）', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 200));
  const nodes = await readNodes();
  const created = nodes.find((node) => node.title === '重叠图');
  const others = before.filter((node) => node.id !== created?.id);
  check(
    '与已有节点重叠的 create 被挪到空地',
    Boolean(created) && !others.some((node) => intersects(created, node)),
    JSON.stringify({ x: created?.x, y: created?.y, others: others.map((node) => [node.title, node.x, node.y]) }),
  );
  check('挪位后没有完全堆在原点', created?.x !== 0 || created?.y !== 0, JSON.stringify({ x: created?.x, y: created?.y }));
}

// ---------------------------------------------------------------- 4. 一批多个无坐标 create → 互不重叠

{
  const before = await readNodes();
  const edit = await run({
    action: 'edit',
    operations: [
      { kind: 'create', ref: 'v1', type: 'Video', title: '视频1' },
      { kind: 'create', ref: 'v2', type: 'Video', title: '视频2' },
      { kind: 'create', ref: 'a1', type: 'Audio', title: '音频1' },
    ],
  });
  check('一批三个无坐标 create 成功', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 200));
  const nodes = await readNodes();
  const batch = nodes.filter((node) => ['视频1', '视频2', '音频1'].includes(node.title));
  check('一批 create 全部落地', batch.length === 3, JSON.stringify(batch.map((node) => [node.title, node.x, node.y])));
  check(
    '一批 create 彼此不重叠',
    batch.length === 3 && countOverlaps(batch) === 0,
    JSON.stringify(batch.map((node) => [node.title, node.x, node.y])),
  );
  const allOverlaps = countOverlaps(nodes);
  check('画布上所有节点两两不重叠（含此前节点）', allOverlaps === 0, `overlaps=${allOverlaps}`);
  void before;
}

// ---------------------------------------------------------------- 5. 运行时无错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('落位链路全程无运行时错误', errors.length === 0, errors.map((entry) => entry.message).join(' | ') || '(none)');
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
