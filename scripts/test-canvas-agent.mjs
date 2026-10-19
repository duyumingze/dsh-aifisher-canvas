/**
 * canvas_control ↔ 真实画布 的端到端回归测试（jsdom）。
 *
 * 这是「agent 能操控画布」这条目标的自动化验证：画布应用**真的挂着**（不是模拟客户端），
 * canvas_control 工具**真的**经过 host 桥接把指令长轮询下发，画布内部的 controlExecutor
 * **真的**在它自己的状态上执行，结果再回执给工具。
 *
 * 链路：
 *   tool.execute(read/edit/undo/focus)
 *     → agentBridge 入队 + 长轮询下发
 *       → 画布 canvasExternalClient.poll 取走
 *         → 画布 controlExecutor 执行
 *           → complete 回执 → 工具返回
 *
 * 关键点：这里**不能**短路 poll（harness 的 shortPoll 选项留给渲染测试），
 * 否则画布取不到指令，链路就断了。
 *
 * 用法：node scripts/test-canvas-agent.mjs   （需要先 build）
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

const host = await startHost();
const { window } = await createCanvasDom({ dispatch: host.dispatch });

// ---------------------------------------------------------------- 预置一个项目并让画布直接进画布视图

const projectId = 'agent-proj';
{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: 'agent 验证项目',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, JSON.stringify(save.json()));
}

seedResume(window, projectId);

const { container, handle } = await mountCanvasApp(window);
await settle(1500);

check('画布进入画布视图（取回了预置项目）',
  host.dispatch && (await host.hostApi('GET', `/workflows/${projectId}`)).status === 200,
  '');

// 画布视图的标志：顶部标题栏 + 场景容器；这里用「上游把这些请求发出去了」间接确认
const canvasViewRendered = container.innerHTML.includes('agent 验证项目');
check('画布视图渲染出项目标题', canvasViewRendered, container.innerHTML.slice(0, 160).replace(/\s+/g, ' '));

// ---------------------------------------------------------------- 画布是否已在桥接里注册

const bridgeStatus = (await host.hostApi('GET', '/status')).json();
check('画布已在桥接里注册（长轮询生效）',
  Array.isArray(bridgeStatus.bridge?.clients) && bridgeStatus.bridge.clients.some((client) => client.projectId === projectId),
  JSON.stringify(bridgeStatus.bridge).slice(0, 240));

const tool = host.tool('canvas_control');
check('canvas_control 工具已注册', Boolean(tool));

const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-agent' } } });

// ---------------------------------------------------------------- read

let revision = '';
{
  const read = await run({ action: 'read' });
  check('read 拿到画布状态', read.ok === true && read.result?.ok === true, JSON.stringify(read).slice(0, 240));
  revision = String(read.result?.revision ?? '');
  check('read 返回 revision 令牌', revision.length > 0, revision.slice(0, 40));
  check('read 返回空节点列表', Array.isArray(read.result?.nodes) && read.result.nodes.length === 0, JSON.stringify(read.result?.nodes).slice(0, 120));
}

// ---------------------------------------------------------------- edit：建两个节点并连线

let operationId = '';
let createdIds = [];
{
  const edit = await run({
    action: 'edit',
    revision,
    operations: [
      { kind: 'create', ref: 'a', type: 'Text', x: 120, y: 80, title: '提示词' },
      { kind: 'create', ref: 'b', type: 'Image', x: 480, y: 80 },
      { kind: 'connect', sourceId: 'a', targetId: 'b' },
    ],
  });
  check('edit 执行成功', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 300));
  createdIds = (edit.result?.created ?? []).map((item) => item.id);
  operationId = String(edit.result?.operationId ?? '');
  check('edit 回执给出 created 映射', createdIds.length === 2, JSON.stringify(edit.result?.created));
}

// ---------------------------------------------------------------- read 核对真的改到了画布

{
  const read = await run({ action: 'read' });
  const nodes = read.result?.nodes ?? [];
  check('read 看到两个新节点', nodes.length === 2, `nodes=${nodes.length}`);
  const types = nodes.map((node) => node.type).sort();
  check('节点类型与创建一致', JSON.stringify(types) === JSON.stringify(['Image', 'Text']), JSON.stringify(types));
  const image = nodes.find((node) => node.type === 'Image');
  check('连线写进了 target 的 parentIds', Array.isArray(image?.parentIds) && image.parentIds.length === 1, JSON.stringify(image?.parentIds));
  const text = nodes.find((node) => node.type === 'Text');
  check('创建时给的标题落到了节点上', text?.title === '提示词', JSON.stringify(text?.title));
}

// ---------------------------------------------------------------- focus

{
  const focus = await run({ action: 'focus', nodeIds: createdIds });
  check('focus 成功', focus.ok === true && focus.result?.ok === true, JSON.stringify(focus).slice(0, 200));
  const missing = await run({ action: 'focus', nodeIds: ['不存在的节点'] });
  check('focus 不存在的节点 → NOT_FOUND（失败提到工具顶层）', missing.ok === false && missing.code === 'NOT_FOUND', JSON.stringify(missing).slice(0, 200));
}

// ---------------------------------------------------------------- undo：回到编辑前

{
  const read = await run({ action: 'read' });
  const currentRevision = String(read.result?.revision ?? '');
  const undo = await run({ action: 'undo', revision: currentRevision, operationId });
  check('undo 执行成功', undo.ok === true && undo.result?.ok === true, JSON.stringify(undo).slice(0, 240));
  const after = await run({ action: 'read' });
  check('undo 后节点被撤销', (after.result?.nodes ?? []).length === 0, `nodes=${(after.result?.nodes ?? []).length}`);
}

// ---------------------------------------------------------------- Text 节点：正文进 textContent，别落进提示词

let bodyNodeId = '';
{
  const read = await run({ action: 'read' });
  const rev = String(read.result?.revision ?? '');
  const script = '《测试剧本》\n第一场：正文应该出现在文本区里。';
  const edit = await run({
    action: 'edit',
    revision: rev,
    operations: [
      { kind: 'create', ref: 't', type: 'Text', x: 120, y: 320, title: '剧本', prompt: script },
    ],
  });
  check('文本节点：只给 prompt 也能建出来', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 240));
  bodyNodeId = String((edit.result?.created ?? []).find((item) => item.ref === 't')?.id ?? '');
  const after = await run({ action: 'read' });
  const node = (after.result?.nodes ?? []).find((item) => item.id === bodyNodeId);
  check('文本节点：内容写进 textContent（正文）', node?.textContent === script, JSON.stringify({ textContent: node?.textContent, prompt: node?.prompt }).slice(0, 220));
  check('文本节点：提示词框保持为空', node?.prompt === '', JSON.stringify(node?.prompt));
}

{
  const read = await run({ action: 'read' });
  const rev = String(read.result?.revision ?? '');
  const next = '改写后的正文';
  const edit = await run({
    action: 'edit',
    revision: rev,
    operations: [{ kind: 'update', nodeId: bodyNodeId, patch: { prompt: next } }],
  });
  check('文本节点：update 只给 prompt 也改正文', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 240));
  const after = await run({ action: 'read' });
  const node = (after.result?.nodes ?? []).find((item) => item.id === bodyNodeId);
  check('文本节点：update 后正文更新、提示词仍为空', node?.textContent === next && node?.prompt === '', JSON.stringify({ textContent: node?.textContent, prompt: node?.prompt }).slice(0, 220));
}

{
  const read = await run({ action: 'read' });
  const rev = String(read.result?.revision ?? '');
  const edit = await run({
    action: 'edit',
    revision: rev,
    operations: [
      { kind: 'create', ref: 't2', type: 'Text', x: 120, y: 560, text: '正文甲', prompt: '模板乙' },
    ],
  });
  check('文本节点：text + prompt 可以分别落正文与模板', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 240));
  const id = String((edit.result?.created ?? []).find((item) => item.ref === 't2')?.id ?? '');
  const after = await run({ action: 'read' });
  const node = (after.result?.nodes ?? []).find((item) => item.id === id);
  check('文本节点：显式 text 落 textContent、prompt 落模板', node?.textContent === '正文甲' && node?.prompt === '模板乙', JSON.stringify({ textContent: node?.textContent, prompt: node?.prompt }).slice(0, 220));
}

// ---------------------------------------------------------------- revision 冲突要真的报出来

{
  const stale = await run({
    action: 'edit',
    revision: '早已过期的令牌',
    operations: [{ kind: 'create', ref: 'x', type: 'Text', x: 0, y: 0 }],
  });
  check('过期 revision → CONFLICT（失败提到工具顶层）', stale.ok === false && stale.code === 'CONFLICT', JSON.stringify(stale).slice(0, 200));
}

// ---------------------------------------------------------------- 全程无运行时错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('agent 操控全程无运行时错误', errors.length === 0, errors.map((e) => e.message).join(' | ') || '(none)');
}

try {
  handle.dispose();
} catch {
  /* 卸载失败会在渲染测试里单独断言 */
}
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
