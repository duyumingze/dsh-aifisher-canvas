/**
 * 画布助手 P1 · 视觉一致性纯逻辑回归（v1.59）。
 *
 * 为什么单独一套：一致性是「锚点节点 → 镜头节点的上游连线」，判定全部是纯函数
 * （镜头号解析、排序、覆盖率、该连哪几条）。这些规则一旦错了，界面和 host 会各说各话
 * （分镜板上的第 3 张 ≠ 锁定顺序的第 3 个），而且不报错 —— 只能靠断言守住。
 *
 * 本套件验证：
 *   1. 镜头号解析：镜头 3 / 分镜03 / shot 4 / 01. 开头；1920x1080 不算；
 *   2. 排序：有号的按号、没号的按坐标、锚点自己不算镜头；
 *   3. 覆盖率：全部锚点都接上才算 covered；锚点从画布上消失时如实报告；
 *   4. 锁定计划：只连缺失的、跳过已连的、忽略幽灵锚点、排除锚点自身；
 *   5. 解锁计划：只断「锚点→镜头」这几条，别的连线不动。
 *
 * 用法：node scripts/test-canvas-consistency.mjs   （需要先 build）
 */
import {
  coverageReport,
  orderShots,
  planLockOperations,
  planUnlockOperations,
  shotNumberFromTitle,
} from './lib/plugin-exports.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

// ---------------------------------------------------------------- 1. 镜头号解析

{
  const cases = [
    ['镜头 3', 3],
    ['分镜03', 3],
    ['镜 12 特写', 12],
    ['Shot 4 - 雨夜', 4],
    ['01. 开场', 1],
    ['第 2 镜', null],
    ['1920x1080', null],
    ['', null],
  ];
  for (const [title, expected] of cases) {
    const actual = shotNumberFromTitle(title);
    check(`镜头号「${title}」→ ${String(expected)}`, actual === expected, String(actual));
  }
}

// ---------------------------------------------------------------- 2. 排序

{
  const nodes = [
    { id: 'a', type: 'Image', title: '镜头 10', x: 0, y: 0 },
    { id: 'b', type: 'Image', title: '镜头 2', x: 900, y: 900 },
    { id: 'c', type: 'Video', title: '无编号 A', x: 500, y: 0 },
    { id: 'd', type: 'Image', title: '无编号 B', x: 100, y: 800 },
    { id: 't', type: 'Text', title: '剧本', x: 0, y: 0 },
    { id: 'anchor', type: 'Image', title: '角色定妆', x: 0, y: -500 },
  ];
  const ordered = orderShots(nodes).map((shot) => shot.id);
  // orderShots 只做排序、不认锚点（锚点排除在 coverageReport / planLockOperations 里做）：
  // 所以定妆图（无编号、y=-500）会排在无编号那一组的最前面。
  check(
    '有镜头号的排前面且按号升序，无编号的按坐标，Text 不算镜头',
    JSON.stringify(ordered) === JSON.stringify(['b', 'a', 'anchor', 'c', 'd']),
    JSON.stringify(ordered),
  );

  const anchorInput = [{ nodeId: 'anchor', title: '角色定妆', role: 'character' }];
  const coverage = coverageReport(nodes, anchorInput);
  check(
    '锚点自己不被算成「待锁的镜头」',
    coverage.shots === 4 && !coverage.uncovered.some((item) => item.id === 'anchor'),
    JSON.stringify({ shots: coverage.shots }),
  );
  check(
    '没连锚点的镜头都在 uncovered 里',
    coverage.covered === 0 && coverage.uncovered.length === 4,
    JSON.stringify({ covered: coverage.covered, uncovered: coverage.uncovered.length }),
  );
}

// ---------------------------------------------------------------- 3. 覆盖率

{
  const nodes = [
    { id: 'anchor-a', type: 'Image', title: '角色定妆', resultUrl: '/a.png' },
    { id: 'anchor-b', type: 'Image', title: '画风参考' },
    { id: 'shot-1', type: 'Image', title: '镜头 1', parentIds: ['anchor-a', 'anchor-b'] },
    { id: 'shot-2', type: 'Image', title: '镜头 2', parentIds: ['anchor-a'] },
    { id: 'shot-3', type: 'Image', title: '镜头 3', parentIds: [] },
  ];
  const coverage = coverageReport(nodes, [
    { nodeId: 'anchor-a', title: '角色定妆', role: 'character' },
    { nodeId: 'anchor-b', title: '画风参考', role: 'style' },
  ]);
  check(
    '「全部锚点都接上」才算 covered（只接角色不算）',
    coverage.covered === 1 && coverage.uncovered.length === 2,
    JSON.stringify({ covered: coverage.covered, uncovered: coverage.uncovered.map((item) => item.id) }),
  );
  const missingShot = coverage.uncovered.find((item) => item.id === 'shot-2');
  check(
    'uncovered 里点名缺哪个锚点',
    JSON.stringify(missingShot?.missingAnchors) === JSON.stringify(['anchor-b']),
    JSON.stringify(missingShot ?? null),
  );
  check('锚点是否已经有结果图也如实报告', coverage.anchors.find((a) => a.nodeId === 'anchor-b')?.ready === false, JSON.stringify(coverage.anchors));

  const ghost = coverageReport(nodes, [{ nodeId: 'ghost', title: '幽灵', role: 'character' }]);
  check('幽灵锚点进 missingAnchors 且不参与覆盖判定', ghost.missingAnchors.length === 1, JSON.stringify(ghost.missingAnchors));
  check('没有锚点时给出「先设锚点」的提示', coverageReport(nodes, []).summary.includes('还没有参考锚点'), coverageReport(nodes, []).summary);
}

// ---------------------------------------------------------------- 4. 锁定计划

{
  const nodes = [
    { id: 'anchor', type: 'Image', title: '角色定妆', resultUrl: '/a.png' },
    { id: 'shot-1', type: 'Image', title: '镜头 1', parentIds: ['anchor', 'text-1'] },
    { id: 'shot-2', type: 'Image', title: '镜头 2', parentIds: [] },
    { id: 'text-1', type: 'Text', title: '剧本' },
  ];
  const plan = planLockOperations(nodes, [{ nodeId: 'anchor', title: '角色定妆', role: 'character' }]);
  check(
    '只给没连上的镜头下发连线（已连的跳过）',
    plan.operations.length === 1 && plan.operations[0].targetId === 'shot-2',
    JSON.stringify(plan.operations),
  );
  check('already 里列出已连上的镜头', plan.already.length === 1 && plan.already[0].id === 'shot-1', JSON.stringify(plan.already));
  check('连线方向是 锚点 → 镜头', plan.operations.every((op) => op.kind === 'connect' && op.sourceId === 'anchor'), JSON.stringify(plan.operations));

  const scoped = planLockOperations(nodes, [{ nodeId: 'anchor', title: 'x', role: 'character' }], ['shot-2', 'text-1']);
  check(
    '指定 nodeIds 时只锁那几个，非镜头节点进 unknownTargets',
    scoped.operations.length === 1 && scoped.unknownTargets.length === 1,
    JSON.stringify(scoped),
  );

  const ghost = planLockOperations(nodes, [{ nodeId: 'ghost', title: '幽灵', role: 'character' }]);
  check('幽灵锚点不产生连线，但会回报', ghost.operations.length === 0 && ghost.missingAnchors.length === 1, JSON.stringify(ghost));

  const unlock = planUnlockOperations(nodes, [{ nodeId: 'anchor', title: 'x', role: 'character' }]);
  check(
    '解锁只断 锚点→镜头 的连线（不动剧本文本连线）',
    unlock.operations.length === 1 &&
      unlock.operations[0].kind === 'disconnect' &&
      unlock.operations[0].targetId === 'shot-1' &&
      unlock.operations[0].sourceId === 'anchor',
    JSON.stringify(unlock.operations),
  );
}

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
