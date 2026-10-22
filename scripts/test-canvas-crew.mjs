/**
 * 画布助手 P2（v1.63）回归：资产库 + 多 agent 协作。
 *
 * 验证口径：
 *   1. 资产库增删改查与统计；同名同类型原地更新；
 *   2. 资产能挂画布定妆节点（link），并作为参考锚点被 use 锁到镜头上；
 *   3. intent 编译时自动把资产锁定串织进每一镜（文字层一致性）；
 *   4. crew plan 产出可直接派给子代理的任务包：角色、交付契约、边界、压过的上下文；
 *   5. crew receive 逐条校验交付（合格收、不合格列出原因），apply 时才展开成节点；
 *   6. 子代理交付的 locks 能批量登记回资产库（默认 import，可关）。
 *
 * 用法：node scripts/test-canvas-crew.mjs    （需要先 build）
 */
import { mountCanvasApp, createCanvasDom, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const host = await startHost();
const projectId = 'crew-proj';
{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: 'P2 资产与协作',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入', save.status === 200);
}
const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
await mountCanvasApp(window);
await settle(1500);

const tool = host.tool('canvas_control');
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-crew' } } });
const readNodes = async () => {
  const read = await run({ action: 'read' });
  return Array.isArray(read.result?.nodes) ? read.result.nodes : [];
};

// ---------------------------------------------------------------- 1. 资产库增改查

const LIN = '林溯：35 岁男性，短寸头，左眉有一道疤，深灰风衣，沉默寡言';
const SHOP = '旧书店：木地板，高书架顶到天花板，午后斜光里全是浮尘';
let linId = '';
let shopId = '';

{
  const added = await run({
    action: 'assetlibrary',
    assetlibrary: { op: 'add', kind: 'character', name: '林溯', prompt: LIN, tags: ['主角'] },
  });
  linId = String(added.result?.entry?.id ?? '');
  check('资产 add 成功', Boolean(linId) && added.result?.entry?.name === '林溯', JSON.stringify(added).slice(0, 200));

  const shop = await run({
    action: 'assetlibrary',
    assetlibrary: { op: 'add', kind: 'scene', name: '旧书店', prompt: SHOP },
  });
  shopId = String(shop.result?.entry?.id ?? '');
  check('场景资产 add 成功', Boolean(shopId), JSON.stringify(shop).slice(0, 160));

  // 同名同类型 = 原地更新，不新增
  const again = await run({
    action: 'assetlibrary',
    assetlibrary: { op: 'add', kind: 'character', name: '林溯', prompt: LIN + '，左手戴旧手表' },
  });
  check('同名同类型原地更新（id 不变）', again.result?.entry?.id === linId, JSON.stringify(again.result?.entry?.id));
  const list = await run({ action: 'assetlibrary', assetlibrary: { op: 'list' } });
  check('资产列表 2 条', list.result?.entries?.length === 2, JSON.stringify(list.result?.entries?.map((e) => e.name)));
  check(
    '统计按类型分组',
    list.result?.summary?.byKind?.character === 1 && list.result?.summary?.byKind?.scene === 1,
    JSON.stringify(list.result?.summary),
  );

  const imported = await run({
    action: 'assetlibrary',
    assetlibrary: {
      op: 'import',
      locks: [{ kind: 'prop', name: '旧手表', prompt: '旧手表：表盘发黄，皮表带磨白' }],
    },
  });
  check('批量导入锁 1 条', imported.result?.entries?.length === 1 && imported.result?.rejected?.length === 0, JSON.stringify(imported.result).slice(0, 200));
}

// ---------------------------------------------------------------- 2. 挂定妆节点 + intent 自动织入

{
  const edit = await run({
    action: 'edit',
    operations: [{ kind: 'create', ref: 'look', type: 'Text', x: 0, y: 0, title: '锚点·角色01 林溯', text: LIN }],
  });
  const lookId = String((edit.result?.created ?? []).find((item) => item.ref === 'look')?.id ?? '');
  check('定妆节点已建好', Boolean(lookId), JSON.stringify(edit.result?.created));

  const linked = await run({ action: 'assetlibrary', assetlibrary: { op: 'link', id: linId, nodeId: lookId } });
  check('link 绑定定妆节点', linked.result?.entry?.nodeId === lookId, JSON.stringify(linked.result?.entry?.nodeId));

  const applied = await run({
    action: 'intent',
    intent: { op: 'apply', brief: '林溯走进旧书店。她抬头看见窗外的雪。', shots: 2, columns: 2 },
  });
  check('intent apply 成功', applied.ok === true && applied.result?.ok === true, JSON.stringify(applied).slice(0, 200));
  const nodes = await readNodes();
  const shots = nodes.filter((node) => /^镜头 \d{2} · /.test(node.title ?? ''));
  check('画布上 2 个镜头', shots.length === 2, JSON.stringify(shots.map((n) => n.title)));
  check(
    '每镜自动织入角色与场景锁定串',
    shots.every((node) => String(node.prompt).includes('左眉有一道疤') && String(node.prompt).includes('旧书店：木地板')),
    JSON.stringify(shots.map((n) => n.prompt)),
  );

  // 3. use：资产 → 参考锚点，并锁到全部镜头上
  const used = await run({ action: 'assetlibrary', assetlibrary: { op: 'use', id: linId } });
  check('use 成功登记锚点并锁镜头', used.ok === true && (used.result?.operations ?? 0) > 0, JSON.stringify(used).slice(0, 240));
  check(
    '覆盖率：2 个镜头全部覆盖',
    used.result?.coverage?.shots === 2 && used.result?.coverage?.covered === 2,
    JSON.stringify(used.result?.coverage),
  );
  check(
    '锚点出现在项目记忆里',
    Array.isArray(used.result?.coverage?.anchors) && used.result.coverage.anchors.some((a) => a.title === '林溯'),
    JSON.stringify(used.result?.coverage?.anchors),
  );

  const noNode = await run({ action: 'assetlibrary', assetlibrary: { op: 'use', id: shopId } });
  check('没挂节点的资产 use 被拒并给出下一步', noNode.ok === false && noNode.code === 'NEED_NODE', JSON.stringify(noNode).slice(0, 200));
}

// ---------------------------------------------------------------- 4. crew plan：任务包

{
  const plan = await run({
    action: 'crew',
    crew: { op: 'plan', brief: '雨夜，林溯在旧书店里找一封十年前的信，最后在旧手表里找到。6 个镜头。', shots: 6 },
  });
  check('crew plan 成功', plan.ok === true && Array.isArray(plan.result?.plan?.assignments), JSON.stringify(plan).slice(0, 200));
  const assignments = plan.result?.plan?.assignments ?? [];
  const roles = assignments.map((item) => item.role);
  check('复杂任务自动带上导演角色', roles.includes('director'), JSON.stringify(roles));
  check('必有分镜与审片', roles.includes('storyboard') && roles.includes('review'), JSON.stringify(roles));
  check('已有资产时不派设定角色', !roles.includes('sets'), JSON.stringify(roles));
  check(
    '每个任务包都有交付契约与边界',
    assignments.every(
      (item) =>
        typeof item.task === 'string' &&
        item.task.length > 10 &&
        typeof item.deliverable === 'string' &&
        item.deliverable.includes('{') &&
        typeof item.boundary === 'string' &&
        item.boundary.includes('不要调用 canvas_control'),
    ),
    JSON.stringify(assignments.map((item) => item.boundary).slice(0, 1)),
  );
  check(
    '上下文被压过（≤ 1600 字符，不含整份节点列表）',
    assignments.every((item) => JSON.stringify(item.context).length <= 1600),
    JSON.stringify(assignments.map((item) => JSON.stringify(item.context).length)),
  );
  check(
    '上下文含资产名与风格，但不含节点正文',
    assignments.every(
      (item) =>
        !('nodes' in (item.context ?? {})) &&
        (Array.isArray(item.context.assets) || item.role === 'review'),
    ),
    JSON.stringify(assignments[0]?.context),
  );

  const explicit = await run({ action: 'crew', crew: { op: 'plan', brief: '短句剧本。', roles: ['director', 'storyboard', 'sets', 'review'] } });
  check('显式指定角色时按指定派活', explicit.result?.plan?.assignments?.length === 4, JSON.stringify(explicit.result?.plan?.roles));
}

// ---------------------------------------------------------------- 5. crew receive：校验与展开

{
  const received = await run({
    action: 'crew',
    crew: {
      op: 'receive',
      role: 'storyboard',
      deliverable: {
        shots: [
          { title: '镜头 01 · 雨夜书店', prompt: '雨夜旧书店，窗光斜切进来，画面清晰锐利，不出现文字与水印' },
          { title: '镜头 02 · 旧手表', prompt: '表盘发黄的旧手表特写，台灯暖光', type: 'Image' },
          { title: '坏镜头', prompt: '   ' },
        ],
        locks: [{ kind: 'character', name: '林溯', prompt: LIN }],
      },
      apply: true,
    },
  });
  check('receive 成功', received.ok === true, JSON.stringify(received).slice(0, 240));
  check('合格镜头 2 条', received.result?.acceptedShots?.length === 2, JSON.stringify(received.result?.acceptedShots?.map((s) => s.title)));
  check('空提示词逐条拒绝', received.result?.rejected?.length === 1 && received.result.rejected[0].reason.includes('prompt'), JSON.stringify(received.result?.rejected));
  check('交付的 locks 批量登记回资产库', (received.result?.imported?.length ?? 0) >= 1, JSON.stringify(received.result?.imported?.map((e) => e.name)));
  check('apply 后画布出现 2 个新节点', (received.result?.created?.length ?? 0) === 2, JSON.stringify(received.result?.created));

  const nodes = await readNodes();
  check(
    '新节点标题保留子代理给的「镜头 NN」',
    ['镜头 01 · 雨夜书店', '镜头 02 · 旧手表'].every((title) => nodes.some((node) => node.title === title)),
    JSON.stringify(nodes.map((n) => n.title)),
  );

  const empty = await run({ action: 'crew', crew: { op: 'receive', role: 'storyboard', deliverable: {} } });
  check('空交付返回明确错误', empty.ok === false && empty.code === 'INVALID', JSON.stringify(empty).slice(0, 160));
}

const summary = `SUMMARY pass=${lines.length - failures} fail=${failures}`;
console.log(lines.join('\n'));
console.log(summary);
process.exit(failures === 0 ? 0 : 1);
