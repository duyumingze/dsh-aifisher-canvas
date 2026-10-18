/**
 * 「ComfyUI 工作流配置」面板回归（scripts/test-canvas-workflow-config.mjs）。
 *
 * 用户 2026-10-17 的原话：「将skill社区替换成comfui工作流配置。参考图2」——
 * 参考图是上游「工作流节点库」那张大弹窗，核心交互是
 * 「选工作流 → 勾参数（已选 N/M）→ 起节点名 → 保存参数配置 / 直接添加到画布」。
 *
 * 这条链路跨三个地方，所以分三段验，每段都看**真东西**：
 *
 *   A. host 侧接口（真插件路由 + 真文件）
 *      清单 / 单个工作流的候选字段 / 保存写回 meta.json / 各类可读错误码。
 *   B. 真画布（jsdom 挂 lib/canvas/canvas-app.js）
 *      左栏第三个按钮还在不在、点开面板、候选行真的勾得上、保存真的落盘、
 *      「添加到画布」真的建出一个 comfyMode 正确的 ComfyUI 节点；
 *      v1.19 的节点图：图上节点/连线与 host 的 graph 一致、点节点 → 检查器只列它的字段、
 *      节点模式里勾选照样生效、✕ 回全部字段、「适应窗口」算出可用缩放。
 *   C. 产物与文档契约
 *      面板与 store 真的进了画布产物；左栏那个 aria-label 已经换掉（旧的 SKILL 社区不能再有）。
 *
 * 用法：node scripts/test-canvas-workflow-config.mjs   （需要先 build）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}

/** 夹具：带一个 LoadImage（素材槽）+ 一个 CLIPTextEncode（提示词）+ 采样参数 */
const T2I = {
  '1': { inputs: { image: 'example.png', upload: 'image' }, class_type: 'LoadImage', _meta: { title: '参考图' } },
  '6': { inputs: { text: '模板占位', clip: ['1', 0] }, class_type: 'CLIPTextEncode' },
  '7': { inputs: { text: '负向占位', clip: ['1', 0] }, class_type: 'CLIPTextEncode', _meta: { title: 'Negative' } },
  '3': { inputs: { seed: 7, steps: 12, cfg: 1.5, positive: ['6', 0] }, class_type: 'KSampler' },
  '9': { inputs: { filename_prefix: 'out', images: ['3', 0] }, class_type: 'SaveImage' },
};

const host = await startHost();
const workflowsDir = path.join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'workflows');
{
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(path.join(workflowsDir, 'cfg-t2i.json'), JSON.stringify(T2I, null, 2), 'utf8');
}

const metaPath = path.join(workflowsDir, 'cfg-t2i.meta.json');
const readMeta = () => (existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null);

// ---------------------------------------------------------------- A. host 侧接口

{
  const list = await host.hostApi('GET', '/comfy/workflow-config?refresh=1');
  const parsed = list.status === 200 ? JSON.parse(list.text) : {};
  const summary = (parsed.configs ?? []).find((item) => item.id === 'custom-cfg-t2i');
  check('清单接口列出刚丢进去的自定义工作流', Boolean(summary), list.text.slice(0, 200));
  check(
    '清单带上候选字段数（面板左栏的「已选 N/M」）',
    typeof summary?.candidateCount === 'number' && summary.candidateCount >= 6,
    JSON.stringify(summary && { candidateCount: summary.candidateCount, selectedCount: summary.selectedCount }),
  );
  check('还没配过时 hasMeta=false（面板会标「未配置」）', summary?.hasMeta === false, String(summary?.hasMeta));

  const detail = await host.hostApi('GET', '/comfy/workflow-config/custom-cfg-t2i');
  const view = detail.status === 200 ? JSON.parse(detail.text) : {};
  const byId = (id) => (view.candidates ?? []).find((item) => item.id === id);
  check('单个工作流的候选字段：LoadImage.image → 素材槽 imageUrl', byId('1.inputs.image')?.kind === 'media' &&
    byId('1.inputs.image')?.key === 'imageUrl', JSON.stringify(byId('1.inputs.image')));
  check('单个工作流的候选字段：CLIPTextEncode.text → 提示词槽 text',
    byId('6.inputs.text')?.kind === 'text' && byId('6.inputs.text')?.key === 'text',
    JSON.stringify(byId('6.inputs.text')));
  check('节点标题里带 Negative 的那条被认成负向提示词',
    byId('7.inputs.text')?.kind === 'negativeText',
    JSON.stringify(byId('7.inputs.text')));
  check('数字字段的控件类型是 number（面板据此显示类型徽章）',
    byId('3.inputs.steps')?.control === 'number' && byId('3.inputs.steps')?.defaultValue === 12,
    JSON.stringify(byId('3.inputs.steps')));
  check('被连线喂的字段不进候选（KSampler.positive 是 ["6",0]）',
    !byId('3.inputs.positive'), JSON.stringify(byId('3.inputs.positive')));
  check('已经自动推断出来的绑定是勾上状态（提示词/种子/步数/CFG）',
    ['6.inputs.text', '3.inputs.seed', '3.inputs.steps', '3.inputs.cfg'].every((id) => byId(id)?.selected === true),
    JSON.stringify(['6.inputs.text', '3.inputs.seed', '3.inputs.steps', '3.inputs.cfg'].map((id) => [id, byId(id)?.selected])));
  check('视图给出「已选数 / 总数」与分项（面板顶部那行）',
    view.totals?.selected === (view.candidates ?? []).filter((item) => item.selected).length &&
      view.totals?.media >= 1 && view.totals?.parameters >= 3,
    JSON.stringify(view.totals));

  // ---- v1.19：可视化配置的数据面（节点图）
  const graph = view.graph ?? {};
  const graphNodes = graph.nodes ?? [];
  const graphEdges = graph.edges ?? [];
  const nodeOf = (id) => graphNodes.find((node) => node.id === id);
  check('v1.19 视图带上节点图（可视化配置靠它画）', graphNodes.length === 5,
    JSON.stringify(graphNodes.map((node) => node.id)));
  check('节点图带坐标/尺寸（前端只画不排）',
    graphNodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y) && node.width > 0 && node.height > 0),
    JSON.stringify(graphNodes.map((node) => [node.id, node.x, node.y, node.width, node.height])));
  check('连线 = API JSON 里的 [来源节点, 输出序号]（夹具 4 条）', graphEdges.length === 4,
    JSON.stringify(graphEdges.map((edge) => `${edge.from}->${edge.to}.${edge.field}`)));
  const edgeToSave = graphEdges.find((edge) => edge.from === '3' && edge.to === '9');
  check('连线落在目标节点的那一行（SaveImage.images 是第 2 行）',
    edgeToSave?.field === 'images' && edgeToSave?.toRow === 1, JSON.stringify(edgeToSave));
  check('分层从左到右：1 → 6 → 3 → 9 的 x 单调递增',
    (() => {
      const x = (id) => nodeOf(id)?.x ?? -1;
      return x('1') < x('6') && x('6') < x('3') && x('3') < x('9');
    })(),
    JSON.stringify(graphNodes.map((node) => [node.id, node.x])));
  check('节点里每个 input 一行，被连线喂的标成 link',
    (nodeOf('1')?.rows ?? []).find((row) => row.field === 'image')?.valueType === 'string' &&
      (nodeOf('6')?.rows ?? []).find((row) => row.field === 'clip')?.linked === true,
    JSON.stringify((nodeOf('6')?.rows ?? []).map((row) => [row.field, row.valueType, row.display])));
  check('候选字段在图上被标出来（candidateId = 节点id.inputs.字段）',
    (nodeOf('1')?.rows ?? []).find((row) => row.field === 'image')?.candidateId === '1.inputs.image',
    JSON.stringify((nodeOf('1')?.rows ?? []).find((row) => row.field === 'image')));
  check('节点高度 = 26 + 5 + 行数*15 + 5（与前端 edgePath 同一套量纲）',
    graphNodes.every((node) => node.height === 36 + node.rows.length * 15),
    JSON.stringify(graphNodes.map((node) => [node.id, node.height, node.rows.length])));
  check('超过 maxRows 的字段图上折起来（夹具都很短，hiddenRows=0）',
    graphNodes.every((node) => node.hiddenRows === 0 && node.rows.length <= 16),
    JSON.stringify(graphNodes.map((node) => [node.id, node.rows.length, node.hiddenRows])));
  check('输出节点在图上被标出来（SaveImage #9）', nodeOf('9')?.isOutput === true, String(nodeOf('9')?.isOutput));
  check('图的 bounds 包住所有节点（前端「适应窗口」按它算）',
    (graph.bounds?.width ?? 0) >= Math.max(...graphNodes.map((node) => node.x + node.width)) &&
      (graph.bounds?.height ?? 0) >= Math.max(...graphNodes.map((node) => node.y + node.height)),
    JSON.stringify(graph.bounds));

  const saved = await host.hostApi('POST', '/comfy/workflow-config/custom-cfg-t2i', {
    title: '配置过的工作流',
    bindings: { text: '6.inputs.text', imageUrl: '1.inputs.image', cfg: '3.inputs.cfg', seed: null },
    parameters: { cfg: { label: 'CFG 强度（自定义）' } },
  });
  check('保存接口 200 并回新视图', saved.status === 200, saved.text.slice(0, 160));
  const meta = readMeta();
  check('配置真的写回 <名字>.meta.json', meta?.title === '配置过的工作流', JSON.stringify(meta));
  check('勾中的字段进 meta.bindings', meta?.bindings?.cfg === '3.inputs.cfg' && meta?.bindings?.imageUrl === '1.inputs.image',
    JSON.stringify(meta?.bindings));
  check('取消勾选的推断项以 null 落盘（第三态，不是「删掉这个键」）',
    meta?.bindings?.seed === null, JSON.stringify(meta?.bindings));
  check('参数中文标签进 meta.parameters', meta?.parameters?.cfg?.label === 'CFG 强度（自定义）',
    JSON.stringify(meta?.parameters));

  const after = await host.hostApi('GET', '/comfy/workflow-config/custom-cfg-t2i');
  const afterView = JSON.parse(after.text);
  check('重新读回来：seed 变回未勾选、cfg 带自定义标签',
    (afterView.candidates ?? []).find((item) => item.id === '3.inputs.seed')?.selected === false &&
      (afterView.candidates ?? []).find((item) => item.id === '3.inputs.cfg')?.label === 'CFG 强度（自定义）',
    JSON.stringify((afterView.candidates ?? []).filter((item) => ['3.inputs.seed', '3.inputs.cfg'].includes(item.id))));

  const bad = await host.hostApi('POST', '/comfy/workflow-config/custom-cfg-t2i', {
    bindings: { seed: '99.inputs.seed' },
  });
  check('位址写错回 422 BINDING_TARGET_MISSING（面板会把 error 文案显示在底栏）',
    bad.status === 422 && JSON.parse(bad.text).code === 'BINDING_TARGET_MISSING',
    `${bad.status} ${bad.text.slice(0, 160)}`);
}

// ---------------------------------------------------------------- A2. 工作流目录可自定义（v1.18）

const customDir = path.join(host.fakeHome, '我的工作流');
const dirSettingFile = path.join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'workflow-dir.json');
{
  const initial = JSON.parse((await host.hostApi('GET', '/comfy/workflow-config-dir')).text);
  check(
    'GET 目录状态：默认目录就是 storages/.../workflows，isCustom=false',
    initial.dir === workflowsDir && initial.defaultDir === workflowsDir && initial.isCustom === false,
    JSON.stringify(initial),
  );

  const relative = await host.hostApi('POST', '/comfy/workflow-config-dir', { dir: 'relative/dir' });
  check(
    '相对路径被拒（422 WORKFLOW_DIR_NOT_ABSOLUTE）',
    relative.status === 422 && JSON.parse(relative.text).code === 'WORKFLOW_DIR_NOT_ABSOLUTE',
    `${relative.status} ${relative.text.slice(0, 160)}`,
  );

  const missingParent = await host.hostApi('POST', '/comfy/workflow-config-dir', {
    dir: path.join(host.fakeHome, '没有这一层', '更没有这一层'),
  });
  check(
    '上一级也不存在 → 422 WORKFLOW_DIR_PARENT_MISSING（不乱建目录）',
    missingParent.status === 422 && JSON.parse(missingParent.text).code === 'WORKFLOW_DIR_PARENT_MISSING',
    `${missingParent.status} ${missingParent.text.slice(0, 160)}`,
  );

  const moved = await host.hostApi('POST', '/comfy/workflow-config-dir', { dir: customDir });
  const movedBody = moved.status === 200 ? JSON.parse(moved.text) : {};
  check(
    '改成自己的目录：200 + isCustom=true + 目录被自动新建',
    moved.status === 200 &&
      movedBody.isCustom === true &&
      movedBody.dir === customDir &&
      movedBody.created === true &&
      existsSync(customDir),
    moved.text.slice(0, 200),
  );
  check(
    '设置落在 storages 下的 workflow-dir.json（不是写进被选目录里）',
    existsSync(dirSettingFile) && JSON.parse(readFileSync(dirSettingFile, 'utf8')).dir === customDir,
    existsSync(dirSettingFile) ? readFileSync(dirSettingFile, 'utf8') : '(missing)',
  );

  const emptyList = JSON.parse((await host.hostApi('GET', '/comfy/workflow-config?refresh=1')).text);
  check(
    '换目录后清单读的是新目录（默认目录里那条看不见了）',
    emptyList.dir === customDir && (emptyList.configs ?? []).length === 0,
    JSON.stringify({ dir: emptyList.dir, count: (emptyList.configs ?? []).length }),
  );
  check('用户指定的目录只读：不往里塞 README.md', !existsSync(path.join(customDir, 'README.md')));
  check('默认目录仍会补 README.md（给第一次用的人看）', existsSync(path.join(workflowsDir, 'README.md')));

  writeFileSync(path.join(customDir, 'moved-t2i.json'), JSON.stringify(T2I, null, 2), 'utf8');
  const movedList = JSON.parse((await host.hostApi('GET', '/comfy/workflow-config?refresh=1')).text);
  check(
    '往新目录丢一份 JSON 立刻成为可配工作流',
    (movedList.configs ?? []).some((item) => item.id === 'custom-moved-t2i'),
    JSON.stringify((movedList.configs ?? []).map((item) => item.id)),
  );

  const movedSave = await host.hostApi('POST', '/comfy/workflow-config/custom-moved-t2i', {
    title: '搬过家的工作流',
    bindings: { text: '6.inputs.text' },
  });
  check(
    '保存写回的是新目录里的 meta.json',
    movedSave.status === 200 && existsSync(path.join(customDir, 'moved-t2i.meta.json')),
    `${movedSave.status} ${movedSave.text.slice(0, 160)}`,
  );

  const capability = JSON.parse((await host.hostApi('GET', '/comfy/workflows?refresh=1')).text);
  check(
    '画布能力清单跟着换目录（新目录那条在、默认目录那条不在）',
    (capability.workflows ?? []).some((item) => item.id === 'custom-moved-t2i') &&
      !(capability.workflows ?? []).some((item) => item.id === 'custom-cfg-t2i'),
    JSON.stringify((capability.workflows ?? []).map((item) => item.id)),
  );

  const reset = await host.hostApi('POST', '/comfy/workflow-config-dir', { reset: true });
  const resetBody = reset.status === 200 ? JSON.parse(reset.text) : {};
  const backList = JSON.parse((await host.hostApi('GET', '/comfy/workflow-config?refresh=1')).text);
  check(
    '恢复默认目录：isCustom=false、清单重新读默认目录',
    reset.status === 200 &&
      resetBody.isCustom === false &&
      resetBody.dir === workflowsDir &&
      backList.dir === workflowsDir &&
      (backList.configs ?? []).some((item) => item.id === 'custom-cfg-t2i'),
    JSON.stringify({ reset: resetBody, dir: backList.dir }),
  );
}

// ---------------------------------------------------------------- B. 真画布（jsdom）

const PROJECT_ID = 'proj-workflow-config';
{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '工作流配置验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window, fetchCalls } = await createCanvasDom({ dispatch: host.dispatch });
const pageErrors = [];
window.addEventListener('error', (event) => {
  pageErrors.push(String(event.error?.stack ?? event.message ?? event));
});
seedResume(window, PROJECT_ID);
const { container } = await mountCanvasApp(window);
await settle(1500);

/** 面板派发出去的建节点事件（用来区分「没派发」与「派发了但没关面板」）。 */
const nodeDispatches = [];
window.addEventListener('fisherai:add-canvas-node', (event) => nodeDispatches.push(event.detail));

const dialog = () => window.document.querySelector('[data-fisherai-workflow-config-dialog]');
const trigger = () => container.querySelector('[data-fisherai-workflow-config-trigger]');
const items = () => [...window.document.querySelectorAll('[data-fisherai-workflow-config-item]')];
const rows = () => [...window.document.querySelectorAll('[data-fisherai-workflow-config-candidate]')];
const rowById = (id) => window.document.querySelector(`[data-fisherai-workflow-config-candidate="${id}"]`);
const saveButton = () => window.document.querySelector('button[aria-label="保存配置"]');
const addButton = () => window.document.querySelector('button[aria-label="添加到画布"]');

async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await settle(150);
  }
  return last;
}

function click(element) {
  if (!element) return false;
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

const savedNodes = async () => {
  const result = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  if (result.status !== 200) return [];
  try {
    return JSON.parse(result.text).nodes ?? [];
  } catch {
    return [];
  }
};

// ---- B1. 入口

check('左侧工具条有「ComfyUI 工作流配置」按钮', Boolean(trigger()), String(Boolean(trigger())));
check(
  '工具条里已经没有「SKILL 社区」按钮（v1.16 被替换）',
  !container.querySelector('button[aria-label="SKILL 社区"]') &&
    !container.querySelector('[data-fisherai-skill-community-trigger]'),
);
check('未打开时页面上没有配置面板', !dialog());

click(trigger());
await settle(400);
check('点入口按钮打开面板', Boolean(dialog()),
  `triggers=${container.querySelectorAll('[data-fisherai-workflow-config-trigger]').length}`
    + ` dialogs=${window.document.querySelectorAll('[data-fisherai-workflow-config-dialog]').length}`);
check(
  '面板挂在画布容器里（继承画布主题变量，不飘到 DSH 页面上）',
  Boolean(dialog()) && container.contains(dialog()),
  String(Boolean(dialog())),
);
{
  const opened = await waitFor(async () => (items().length ? items() : null));
  check('左栏列出工作流（我们的夹具那条）', (opened ?? []).some((item) => item.getAttribute('data-fisherai-workflow-config-item') === 'custom-cfg-t2i'),
    JSON.stringify((opened ?? []).map((item) => item.getAttribute('data-fisherai-workflow-config-item'))));
  const fieldRows = await waitFor(async () => (rows().length ? rows() : null));
  check('右栏列出全部候选字段（面板打开就能看到）', (fieldRows ?? []).length >= 6, String((fieldRows ?? []).length));
  check(
    '顶部显示「已选 N / M」',
    Number(window.document.querySelector('[data-fisherai-workflow-config-count]')?.getAttribute('data-fisherai-workflow-config-count')) >= 1,
    String(window.document.querySelector('[data-fisherai-workflow-config-count]')?.textContent),
  );
  check(
    '上次保存的配置读回来了（seed 未勾 / CFG 有自定义标签）',
    rowById('3.inputs.seed')?.getAttribute('aria-checked') === 'false' &&
      String(rowById('3.inputs.cfg')?.textContent ?? '').includes('CFG 强度（自定义）'),
    JSON.stringify({
      seed: rowById('3.inputs.seed')?.getAttribute('aria-checked'),
      cfg: String(rowById('3.inputs.cfg')?.textContent ?? '').slice(0, 60),
    }),
  );
  check(
    '画布节点名称输入框带的是 meta.title',
    window.document.querySelector('input[aria-label="画布节点名称"]')?.value === '配置过的工作流',
    String(window.document.querySelector('input[aria-label="画布节点名称"]')?.value),
  );
  // ---- v1.20：底栏「扫描 ComfyUI」按钮（把 lora/模型名变成下拉的入口）
  const scanButton = window.document.querySelector('[data-fisherai-workflow-config-scan-comfy]');
  check(
    '底栏有「扫描 ComfyUI 参数」按钮（v1.20：扫 /object_info 拿下拉候选）',
    Boolean(scanButton) && scanButton.getAttribute('aria-label') === '扫描 ComfyUI 参数',
    String(scanButton?.getAttribute('aria-label')),
  );
}

// ---- B1b. 节点图 + 右侧检查器（v1.19：参考图那种「点节点 → 勾它的字段」）

{
  const graphBox = () => window.document.querySelector('[data-fisherai-workflow-config-graph]');
  const graphNodes = () => [...window.document.querySelectorAll('[data-fisherai-workflow-config-graph-node]')];
  const graphEdges = () => [...window.document.querySelectorAll('[data-fisherai-workflow-config-graph-edge]')];
  const graphNode = (id) =>
    window.document.querySelector(`[data-fisherai-workflow-config-graph-node="${id}"]`);
  const inspector = () => window.document.querySelector('[data-fisherai-workflow-config-inspector]');
  const backButton = () => window.document.querySelector('button[aria-label="返回全部字段"]');

  check('面板里有节点图，data-nodes/data-edges 与 host 一致',
    Boolean(graphBox()) &&
      graphBox().getAttribute('data-nodes') === '5' &&
      graphBox().getAttribute('data-edges') === '4',
    JSON.stringify({
      nodes: graphBox()?.getAttribute('data-nodes'),
      edges: graphBox()?.getAttribute('data-edges'),
    }));
  check('图上画出 5 个节点卡 + 4 条连线', graphNodes().length === 5 && graphEdges().length === 4,
    `${graphNodes().length} nodes / ${graphEdges().length} edges`);
  check('节点卡上带「已勾 n」（KSampler #3 上勾着 steps + cfg 两个）',
    graphNode('3')?.getAttribute('data-picked') === '2',
    String(graphNode('3')?.getAttribute('data-picked')));
  check('默认是「全部字段」检查器（v1.16 的全局勾选清单没丢）',
    inspector()?.getAttribute('data-fisherai-workflow-config-inspector') === 'all' && rows().length >= 6,
    `${inspector()?.getAttribute('data-fisherai-workflow-config-inspector')} rows=${rows().length}`);
  check('检查器里有过滤框（过滤参数）',
    Boolean(window.document.querySelector('input[aria-label="过滤参数"]')));

  const fitButton = window.document.querySelector('[data-fisherai-workflow-config-fit]');
  check('图上有「适应窗口」按钮', Boolean(fitButton));
  click(fitButton);
  await settle(150);
  check('点「适应窗口」后算出可用缩放（jsdom 量不到真尺寸，仍有读数）',
    Number(graphBox()?.getAttribute('data-zoom')) > 0,
    String(graphBox()?.getAttribute('data-zoom')));
  check('缩放读数挂在图上（左下那个百分比）',
    Boolean(window.document.querySelector('[data-fisherai-workflow-config-graph-zoom]')),
    String(window.document.querySelector('[data-fisherai-workflow-config-graph-zoom]')?.textContent ?? '(none)'));

  click(graphNode('3'));
  await settle(200);
  check('点图上的节点 → 检查器切成这个节点', inspector()?.getAttribute('data-fisherai-workflow-config-inspector') === '3',
    String(inspector()?.getAttribute('data-fisherai-workflow-config-inspector')));
  check('检查器标题是「节点标题 · #id」',
    String(inspector()?.textContent ?? '').includes('#3') &&
      String(inspector()?.textContent ?? '').includes('KSampler'),
    String(inspector()?.textContent ?? '').slice(0, 80));
  check('节点模式只列这个节点的字段（KSampler 的 seed/steps/cfg）',
    rows().length === 3 &&
      rows().every((row) => String(row.getAttribute('data-fisherai-workflow-config-candidate')).startsWith('3.inputs.')),
    JSON.stringify(rows().map((row) => row.getAttribute('data-fisherai-workflow-config-candidate'))));
  check('图上的选中态跟着变（data-selected）', graphNode('3')?.getAttribute('data-selected') === 'true',
    String(graphNode('3')?.getAttribute('data-selected')));

  click(rowById('3.inputs.seed'));
  await settle(120);
  check('节点模式里照样能勾（aria-checked 翻转）',
    rowById('3.inputs.seed')?.getAttribute('aria-checked') === 'true',
    String(rowById('3.inputs.seed')?.getAttribute('aria-checked')));
  click(rowById('3.inputs.seed'));
  await settle(120);
  check('再点一次取消（回到保存前那一版，交给 B2 继续验）',
    rowById('3.inputs.seed')?.getAttribute('aria-checked') === 'false',
    String(rowById('3.inputs.seed')?.getAttribute('aria-checked')));

  click(backButton());
  await settle(150);
  check('点 ✕ 回到「全部字段」',
    inspector()?.getAttribute('data-fisherai-workflow-config-inspector') === 'all' && rows().length >= 6,
    `${inspector()?.getAttribute('data-fisherai-workflow-config-inspector')} rows=${rows().length}`);
}

// ---- B2. 勾选 → 保存

{
  const before = rowById('3.inputs.seed')?.getAttribute('aria-checked') ?? '';
  click(rowById('3.inputs.seed'));
  await settle(200);
  check('点候选行能把它勾上（aria-checked 翻转）',
    before === 'false' && rowById('3.inputs.seed')?.getAttribute('aria-checked') === 'true',
    `${before} → ${rowById('3.inputs.seed')?.getAttribute('aria-checked')}`);
  check('勾选后标记成「有未保存改动」（按钮文案变「保存并添加到画布」）',
    dialog()?.getAttribute('data-fisherai-workflow-config-dirty') === 'true',
    String(dialog()?.getAttribute('data-fisherai-workflow-config-dirty')));

  click(saveButton());
  const notice = await waitFor(async () => {
    const node = window.document.querySelector('[data-fisherai-workflow-config-notice]');
    return node?.getAttribute('data-fisherai-workflow-config-notice') === 'ok' ? node : null;
  });
  check('点「保存配置」成功（底栏出现 ok 提示）', Boolean(notice), String(notice?.textContent ?? '(none)'));
  const meta = await waitFor(async () => {
    const parsed = readMeta();
    return parsed?.bindings?.seed ? parsed : null;
  });
  check('重新勾上的 seed 落进了 meta.bindings（面板 → host → 文件）',
    meta?.bindings?.seed === '3.inputs.seed',
    JSON.stringify(meta?.bindings));
  check('保存后不再标记「有未保存改动」',
    dialog()?.getAttribute('data-fisherai-workflow-config-dirty') === 'false',
    String(dialog()?.getAttribute('data-fisherai-workflow-config-dirty')));
}

// ---- B3. 添加到画布

{
  click(addButton());
  const closed = await waitFor(async () => (!dialog() ? true : null), 4000);
  const noticeNode = window.document.querySelector('[data-fisherai-workflow-config-notice]');
  check('点「添加到画布」后面板关闭（先保存再落节点）', Boolean(closed),
    `dialogs=${window.document.querySelectorAll('[data-fisherai-workflow-config-dialog]').length}`
      + ` dispatches=${JSON.stringify(nodeDispatches)}`
      + ` dirty=${dialog()?.getAttribute('data-fisherai-workflow-config-dirty')}`
      + ` notice=[${String(noticeNode?.textContent ?? '')}]`);
  const comfy = await waitFor(async () => {
    const node = (await savedNodes()).find((item) => item.type === 'ComfyUI');
    return node ?? null;
  });
  check('画布上真的多了一个 ComfyUI 工作流节点', Boolean(comfy), JSON.stringify((await savedNodes()).map((item) => item.type)));
  check(
    '节点的 comfyMode 指向面板里选的那条工作流',
    comfy?.comfyMode === 'custom-cfg-t2i',
    String(comfy?.comfyMode),
  );
  check('节点落在画布正中（不是 0,0 那种兜底）',
    comfy && (Math.abs(Number(comfy.x)) > 1 || Math.abs(Number(comfy.y)) > 1),
    JSON.stringify({ x: comfy?.x, y: comfy?.y }));
}

// ---- B4. 关闭与重开

{
  click(trigger());
  await settle(400);
  check('面板能再次打开', Boolean(dialog()));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle(250);
  check('Esc 关闭面板', !dialog());
}

// ---- B5. 目录可自定义（底栏输入框 → host 落盘 → 清单跟着换）

{
  const dirInput = () => window.document.querySelector('input[aria-label="工作流目录"]');
  const applyButton = () => window.document.querySelector('button[aria-label="应用目录"]');
  const resetButton = () => window.document.querySelector('button[aria-label="恢复默认目录"]');
  const typeDir = (value) => {
    const input = dirInput();
    if (!input) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return true;
  };

  click(trigger());
  await settle(600);
  check('底栏有可编辑的工作流目录输入框', Boolean(dirInput()), String(Boolean(dirInput())));
  check(
    '输入框初值就是当前目录（host 下发的）',
    dirInput()?.value === workflowsDir,
    String(dirInput()?.value),
  );
  check('默认目录时不显示「隐藏恢复默认」按钮', !resetButton());

  const canvasDir = path.join(host.fakeHome, '画布上换的目录');
  typeDir(canvasDir);
  await settle(100);
  click(applyButton());
  const applied = await waitFor(async () => (existsSync(canvasDir) && dirInput()?.value === canvasDir ? true : null));
  check('在面板里改目录 → host 真的建了目录并切过去', Boolean(applied), String(existsSync(canvasDir)));
  check(
    '切换成功有 ok 提示（底栏 notice）',
    window.document.querySelector('[data-fisherai-workflow-config-notice="ok"]') !== null,
    String(window.document.querySelector('[data-fisherai-workflow-config-notice]')?.textContent ?? '(none)'),
  );
  check('切到空目录后左栏清单清空', items().length === 0, String(items().length));
  check('自定义目录时出现「默认」按钮（一键回默认目录）', Boolean(resetButton()));

  click(resetButton());
  const restored = await waitFor(async () => (dirInput()?.value === workflowsDir ? true : null), 6000);
  check('点「默认」回到默认目录（输入框跟着回到默认路径）', Boolean(restored), String(dirInput()?.value));
  const restoredItem = await waitFor(
    async () =>
      items().some((item) => item.getAttribute('data-fisherai-workflow-config-item') === 'custom-cfg-t2i')
        ? true
        : null,
    6000,
  );
  check('回默认目录后原来那条工作流又回到左栏', Boolean(restoredItem),
    JSON.stringify(items().map((item) => item.getAttribute('data-fisherai-workflow-config-item'))));
  check('回默认目录后「默认」按钮消失', !resetButton());

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle(250);
  check('目录操作后仍能 Esc 关闭面板', !dialog());
}

check('整个过程零页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check(
  '面板通过画布命名空间读配置（不是直连裸 /api/comfy）',
  fetchCalls.some((call) => call.includes('/api/aifisher/canvas/comfy/workflow-config')),
  fetchCalls.filter((call) => call.includes('workflow-config')).join(' | ') || '(none)',
);

// ---------------------------------------------------------------- C. 产物与文档契约

{
  const canvasApp = readFileSync(path.join(process.cwd(), 'lib/canvas/canvas-app.js'), 'utf8');
  check('画布产物里有面板的实现（data-fisherai-workflow-config-dialog）',
    canvasApp.includes('data-fisherai-workflow-config-dialog'));
  check('画布产物里有工具条入口（data-fisherai-workflow-config-trigger）',
    canvasApp.includes('data-fisherai-workflow-config-trigger'));
  check('画布产物里有节点图（v1.19：data-fisherai-workflow-config-graph / -graph-node）',
    canvasApp.includes('data-fisherai-workflow-config-graph') &&
      canvasApp.includes('data-fisherai-workflow-config-graph-node'));
  check('画布产物里有「适应窗口」与检查器',
    canvasApp.includes('data-fisherai-workflow-config-fit') &&
      canvasApp.includes('data-fisherai-workflow-config-inspector'));
  // 注意：vendor 里那份上游 canvasSidebar.tsx 仍留在产物里（画布应用 import 了它），
  // 我们换的是 dependencies.Sidebar 槽位 —— 所以这里查**我们自己的**工具条源码。
  const ours = readFileSync(path.join(process.cwd(), 'src/canvas-ui/canvas/CanvasSidebar.tsx'), 'utf8');
  check('我们那份工具条源码里已经没有 SKILL 社区入口',
    !ours.includes("actionButton('SKILL 社区'") &&
      !ours.includes('skill-community-trigger') &&
      !ours.includes('PlusSquareIcon'));

  const hostBundle = readFileSync(path.join(process.cwd(), 'lib/index.js'), 'utf8');
  check('host 产物里有 workflow-config 路由', hostBundle.includes('/api/comfy/workflow-config'));
  check('host 产物里有节点图排版（v1.19：连线在图上显示 ← #节点）', hostBundle.includes('← #'));

  const readme = readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  check('README 记了这轮改动（ComfyUI 工作流配置）', readme.includes('ComfyUI 工作流配置'));
  check('README 记了可视化节点图（v1.19）', readme.includes('节点图'));
}

console.log(lines.join('\n'));
const pass = lines.length - failures;
console.log(`\nSUMMARY pass=${pass} fail=${failures}`);
process.exit(failures === 0 ? 0 : 1);
