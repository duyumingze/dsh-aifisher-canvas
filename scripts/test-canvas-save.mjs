/**
 * 回归：**保存链路**（2026-10-20，用户报障「画布助手操作了之后很容易保存不上」）。
 *
 * 这套钉的是 v1.58 的三条契约，三条都是「曾经真的坏过 / 修过」的：
 *
 *   1. **改完就落盘**：canvas_control 的 edit 一返回，数据就应该在后端库里 ——
 *      不再等画布那 1.2s 防抖 + 5s 定时（那样一旦自动保存失败，改动就静默丢了）。
 *      回执里用 saved:"saved" 明说。
 *   2. **同一个字段两边都改，也必须存进去**：上游原来的处置是「三向合并冲突 → 停手」，
 *      而且会把这个文档的保存永久封锁（blocked 只有重新打开项目才清）。
 *      现在改成 rescueMerge：两边都保留、同 id 以本窗口为准、一定落盘。
 *   3. **没有死局**：冲突之后的任何一次编辑，仍然要能存进库。
 *
 * 用法：node scripts/test-canvas-save.mjs（需要先 build）
 */
import { mountCanvasApp, createCanvasDom, seedResume, settle, startHost } from './lib/canvas-harness.mjs';
import { rmSync } from 'node:fs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const host = await startHost();
const { window } = await createCanvasDom({ dispatch: host.dispatch });

const projectId = 'save-proj';
const seedNode = {
  id: 'seed-text',
  type: 'Text',
  x: 0,
  y: 0,
  title: '种子',
  prompt: '',
  textContent: '第一段',
  status: 'idle',
  parentIds: [],
  projectId,
};

{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '保存回归项目',
    nodes: [seedNode],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目写入本地后端', save.status === 200, JSON.stringify(save.json()));
}

seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(2000);

const tool = host.tool('canvas_control');
check('canvas_control 已注册', Boolean(tool));
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-save' } } });
const stored = async () => (await host.hostApi('GET', `/workflows/${projectId}`)).json();
const readRev = async () => String((await run({ action: 'read' })).result?.revision ?? '');

// ---------------------------------------------------------------- 1) 改完就落盘
{
  const before = await stored();
  const edit = await run({
    action: 'edit',
    revision: await readRev(),
    operations: [{ kind: 'create', ref: 'a', type: 'Text', x: 600, y: 600, title: '助手建的节点', text: '正文' }],
  });
  check('edit 执行成功', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 200));
  check('edit 回执带 saved:"saved"（改完就落盘）', edit.saved === 'saved', JSON.stringify(edit.saved));

  const after = await stored();
  const created = (after.nodes ?? []).find((node) => node.title === '助手建的节点');
  check('后端库里立刻有这次新建的节点', Boolean(created), `nodes=${(after.nodes ?? []).length}`);
  check('库里 revision 只推进了一格', Number(after.revision) === Number(before.revision) + 1, `before=${before.revision} after=${after.revision}`);
}

// ---------------------------------------------------------------- 2) 不同字段：合并照常生效
{
  const bump = await stored();
  const external = {
    ...bump,
    revision: bump.revision,
    nodes: [...bump.nodes, { ...seedNode, id: 'external-node', title: '别的窗口写的', x: -400, y: -400 }],
  };
  const bumped = await host.hostApi('POST', '/workflows', external);
  check('外部写者把库推到更新的 revision（制造 409）', bumped.status === 200, bumped.text.slice(0, 120));

  const edit = await run({
    action: 'edit',
    revision: await readRev(),
    operations: [{ kind: 'create', ref: 'b', type: 'Text', x: 900, y: 900, title: '冲突后的节点', text: 'x' }],
  });
  check('撞 409 之后 edit 仍成功', edit.ok === true, JSON.stringify(edit).slice(0, 160));
  const after = await stored();
  const ids = new Set((after.nodes ?? []).map((node) => node.id));
  check('外部写者的节点没有被覆盖掉', ids.has('external-node'));
  check('本窗口的节点也进了库', (after.nodes ?? []).some((node) => node.title === '冲突后的节点'));
}

// ---------------------------------------------------------------- 3) 同一字段：救援合并必须落盘
{
  const bump = await stored();
  const conflicting = {
    ...bump,
    revision: bump.revision,
    nodes: bump.nodes.map((node) => (node.id === 'seed-text' ? { ...node, x: 500 } : node)),
  };
  const bumped = await host.hostApi('POST', '/workflows', conflicting);
  check('外部写者改了 seed-text 的 x', bumped.status === 200, bumped.text.slice(0, 120));

  const edit = await run({
    action: 'edit',
    revision: await readRev(),
    operations: [{ kind: 'update', nodeId: 'seed-text', patch: { x: 900 } }],
  });
  check('同一字段冲突时 edit 仍成功', edit.ok === true, JSON.stringify(edit).slice(0, 200));
  check('这次保存没有被判成 failed', edit.saved !== 'failed', JSON.stringify(edit.saved));

  const after = await stored();
  const seed = (after.nodes ?? []).find((node) => node.id === 'seed-text');
  check('冲突后照样落盘：库里 x 是当前窗口的值', Number(seed?.x) === 900, `x=${seed?.x}`);
  check('救援合并没有丢节点', (after.nodes ?? []).length === (bump.nodes ?? []).length, `nodes=${(after.nodes ?? []).length}`);

  // 取证器（saveTelemetry）：409 这种「正常撞车」要以 warn 出现在 /diagnostics 里，
  // 不能报成 error（否则排查时看到的全是假故障）。
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const conflictEntry = (diag.entries ?? []).find(
    (entry) => entry.level === 'warn' && String(entry.message).includes('409'),
  );
  check('保存撞 409 会以 warn 上报到 /diagnostics', Boolean(conflictEntry), JSON.stringify(conflictEntry?.message ?? null));
}

// ---------------------------------------------------------------- 4) 没有死局：冲突之后继续编辑
{
  const before = await stored();
  const edit = await run({
    action: 'edit',
    revision: await readRev(),
    operations: [{ kind: 'create', ref: 'c', type: 'Text', x: 1200, y: 1200, title: '冲突之后再建', text: 'z' }],
  });
  check('冲突之后的 edit 仍成功', edit.ok === true, JSON.stringify(edit).slice(0, 160));
  const after = await stored();
  check(
    '冲突之后的编辑真的进了库（保存链路没被封锁）',
    (after.nodes ?? []).some((node) => node.title === '冲突之后再建'),
    `before=${before.revision} after=${after.revision}`,
  );
}

// ---------------------------------------------------------------- 5) 全程无运行时错误
{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('保存全程没有抛到页面级错误', errors.length === 0, errors.map((e) => e.message).join(' | ') || '(none)');
}

try {
  handle.dispose();
} catch {
  /* 卸载失败另有套件覆盖 */
}
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
