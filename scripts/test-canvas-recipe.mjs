/**
 * recipe（shot-list）回归（v1.55）：验证「剧本 → 镜头节点」一次调用展开。
 *
 * 背景（2026-10-20「更智能的画布助手」规划 P0 第二项）：
 *   现在 agent 建 6 个分镜节点要逐个 create + 自己算坐标，既慢又容易重叠；
 *   recipe 把结构化 shots 交给 host 确定性展开成一条普通 edit。
 *
 * 本套件验证：
 *   1. recipe 一次建出全部镜头（title/type/prompt 正确）；
 *   2. 排布在 anchor（剧本）正下方，两列网格，不与 anchor 重叠；
 *   3. 再跑一次 recipe 时自动让到已有内容右侧，不与任何已有节点重叠；
 *   4. shots 为空 / 超上限 时返回 INVALID；
 *   5. 默认不把镜头连到剧本节点（parentIds 为空）；
 *   6. 全程无运行时错误。
 *
 * 用法：node scripts/test-canvas-recipe.mjs   （需要先 build）
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

const host = await startHost();
const projectId = 'recipe-proj';

{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: 'recipe 验证',
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
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-recipe' } } });
const readNodes = async () => {
  const read = await run({ action: 'read' });
  return Array.isArray(read.result?.nodes) ? read.result.nodes : [];
};

// ---------------------------------------------------------------- 准备剧本节点（anchor）

let scriptId = '';
{
  const edit = await run({
    action: 'edit',
    operations: [
      { kind: 'create', ref: 'script', type: 'Text', x: 0, y: 0, title: '剧本', text: '最后一班渡轮。' },
    ],
  });
  scriptId = String((edit.result?.created ?? []).find((item) => item.ref === 'script')?.id ?? '');
  check('剧本节点已建好', Boolean(scriptId), JSON.stringify(edit.result?.created));
}

// ---------------------------------------------------------------- 1. recipe 一次展开三镜

{
  const recipe = await run({
    action: 'recipe',
    recipe: {
      name: 'shot-list',
      anchorId: scriptId,
      columns: 2,
      shots: [
        { title: '镜头1 · 大全景', prompt: '黄昏码头，渡轮离岸' },
        { title: '镜头2 · 中景', prompt: '女孩冲到栈桥尽头', type: 'Image' },
        { title: '镜头3 · 空镜', prompt: '纸船顺水漂远', type: 'Video' },
      ],
    },
  });
  check('recipe 调用成功', recipe.ok === true && recipe.result?.ok === true, JSON.stringify(recipe).slice(0, 260));
  check('recipe 回带 created 三个镜头', Array.isArray(recipe.result?.created) && recipe.result.created.length === 3, JSON.stringify(recipe.result?.created));
  check('recipe 标记 anchorFound', recipe.result?.recipe?.anchorFound === true, JSON.stringify(recipe.result?.recipe));
  check(
    'recipe 回带 snapshot（省掉验证 read）',
    Array.isArray(recipe.result?.snapshot?.nodes) && recipe.result.snapshot.nodes.length === 4,
    JSON.stringify(recipe.result?.snapshot?.nodes?.length),
  );

  const nodes = await readNodes();
  const shots = nodes.filter((node) => node.type === 'Image' || node.type === 'Video');
  check('画布上出现三个镜头节点', shots.length === 3, JSON.stringify(shots.map((node) => node.title)));
  check(
    '镜头标题与类型正确',
    shots.some((node) => node.title === '镜头1 · 大全景' && node.type === 'Image') &&
      shots.some((node) => node.title === '镜头3 · 空镜' && node.type === 'Video'),
    JSON.stringify(shots.map((node) => [node.title, node.type])),
  );
  check(
    '镜头提示词写入正确',
    shots.find((node) => node.title === '镜头2 · 中景')?.prompt === '女孩冲到栈桥尽头',
    JSON.stringify(shots.map((node) => node.prompt)),
  );
  check(
    '默认不把镜头连到剧本节点',
    shots.every((node) => !Array.isArray(node.parentIds) || node.parentIds.length === 0),
    JSON.stringify(shots.map((node) => node.parentIds)),
  );

  const anchor = nodes.find((node) => node.id === scriptId);
  const shot1 = shots.find((node) => node.title === '镜头1 · 大全景');
  const shot2 = shots.find((node) => node.title === '镜头2 · 中景');
  const shot3 = shots.find((node) => node.title === '镜头3 · 空镜');
  check(
    '镜头排在剧本正下方（两列）',
    shot1 && shot2 && shot3 &&
      shot1.y > 300 &&
      shot1.y === shot2.y &&
      shot3.y > shot1.y &&
      shot1.x === 0 &&
      shot2.x > shot1.x,
    JSON.stringify([shot1, shot2, shot3].map((node) => [node?.x, node?.y])),
  );
  check(
    '镜头与剧本节点不重叠',
    shots.every((node) => !intersects(node, anchor)),
    JSON.stringify([anchor, ...shots]),
  );
}

// ---------------------------------------------------------------- 2. 再跑一次 recipe：自动让到右侧

{
  const before = await readNodes();
  const recipe = await run({
    action: 'recipe',
    recipe: {
      name: 'shot-list',
      anchorId: scriptId,
      columns: 2,
      shots: [
        { title: '补拍A', prompt: '空镜A' },
        { title: '补拍B', prompt: '空镜B' },
      ],
    },
  });
  check('第二次 recipe 成功', recipe.ok === true && recipe.result?.ok === true, JSON.stringify(recipe).slice(0, 200));
  const nodes = await readNodes();
  const added = nodes.filter((node) => ['补拍A', '补拍B'].includes(node.title));
  check('第二次 recipe 的节点全部落地', added.length === 2, JSON.stringify(added.map((node) => [node.title, node.x, node.y])));
  check(
    '第二次 recipe 不再盖住已有节点',
    added.length === 2 && added.every((node) => !before.some((old) => intersects(node, old))),
    JSON.stringify(added.map((node) => [node.title, node.x, node.y])),
  );
}

// ---------------------------------------------------------------- 3. 参数校验

{
  const empty = await run({ action: 'recipe', recipe: { name: 'shot-list', shots: [] } });
  check('空 shots 返回 INVALID', empty.ok === false && empty.code === 'INVALID', JSON.stringify(empty).slice(0, 200));

  const tooMany = await run({
    action: 'recipe',
    recipe: {
      name: 'shot-list',
      shots: Array.from({ length: 25 }, (_, index) => ({ prompt: `镜头${index}` })),
    },
  });
  check('超过 24 镜返回 INVALID', tooMany.ok === false && tooMany.code === 'INVALID', JSON.stringify(tooMany).slice(0, 200));

  const unknown = await run({ action: 'recipe', recipe: { name: 'nope', shots: [{ prompt: 'x' }] } });
  check('未知 recipe 名返回 INVALID', unknown.ok === false && unknown.code === 'INVALID', JSON.stringify(unknown).slice(0, 200));
}

// ---------------------------------------------------------------- 4. 无运行时错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('recipe 链路全程无运行时错误', errors.length === 0, errors.map((entry) => entry.message).join(' | ') || '(none)');
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
