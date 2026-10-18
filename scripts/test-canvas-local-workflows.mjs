/**
 * 画布上的「通用本地工作流节点」回归测试（jsdom 真挂载画布 + 假 ComfyUI + 真插件路由）。
 *
 * 覆盖的是 v1.0 新接的那条链路 —— 用户把 ComfyUI 的 Export (API) JSON 丢进
 * $DSH_HOME/storages/dsh-aifisher-canvas/workflows/ 之后，能在**画布页面上**用它：
 *
 *   ① 能力清单带回「节点参数骨架」→ 画布把它注册成 workflowTemplates[0]
 *   ② 左侧工具条 ➕ / 右键菜单 → 「添加节点」→「ComfyUI 工作流」建出本地工作流节点
 *      （上游那两条入口原来都只派发「打开工作流库」事件，而工作流库没移植 → 死路）
 *   ③ 节点上渲染出工作流下拉、提示词框、参数控件、与连线端点对齐的素材槽
 *   ④ 点「生成」→ POST /api/aifisher/canvas/comfy/<id> → 结果落成一个媒体节点
 *   ⑤ 必填素材没连接时给出可读错误（不会静默提交）
 *   ⑥ 把上一个节点产出的图片连进来 → 素材先上传到 ComfyUI，文件名写回模板
 *   ⑦ v1.21：
 *      a) 负向提示词是 text 输入槽（文本节点能接进去）；不接线时节点上有输入框，
 *         接上以后输入框消失、只剩一行只读提示；正负提示词分别写进模板的正/负节点
 *      b) 同一个节点反复生成，结果图自动按网格排开（以前每次都落在同一个点、互相遮盖）
 *      c) 多选图片 → 工具条「折叠」把这一叠收进最上面那张（stackItems）→ 卡上有徽章，
 *         点「展开」两张图重新摊到画布上（解散）
 *
 * 注：canvas_control 的 read 是**白名单投影**（只有 id/type/x/y/title/prompt/parentIds/…），
 * 看不到 comfyMode / comfyParams / resultUrl，所以节点字段一律以「画布自己存盘的文档」为准：
 * GET /api/aifisher/canvas/workflows/<项目> 拿到的就是画布真正写进去的内容。
 *
 * 用法：node scripts/test-canvas-local-workflows.mjs   （需要先 build）
 */
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}
/** 断言中途崩了也要把已跑完的结果打出来（否则只能看到一句 TypeError）。 */
function fatal(error) {
  console.log(lines.join('\n'));
  console.error('\nUNCAUGHT', error);
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

// ---------------------------------------------------------------- 夹具工作流

/** 文生图：SaveImage 输出 → images；提示词 + seed/steps/cfg/width/height 自动绑定。 */
const T2I = {
  '4': { inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' }, class_type: 'CheckpointLoaderSimple' },
  '5': { inputs: { width: 1024, height: 1024, batch_size: 1 }, class_type: 'EmptyLatentImage' },
  '6': { inputs: { text: '模板占位', clip: ['4', 1] }, class_type: 'CLIPTextEncode' },
  // v1.21：负向提示词节点（标题带 Negative → 推断成负向槽）
  '7': {
    inputs: { text: '模板负向占位', clip: ['4', 1] },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Negative' },
  },
  '3': {
    inputs: {
      seed: 1,
      steps: 20,
      cfg: 7.5,
      sampler_name: 'euler',
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
    class_type: 'KSampler',
  },
  '9': { inputs: { samples: ['3', 0], vae: ['4', 2] }, class_type: 'SaveImage' },
};
const T2I_META = {
  title: '本地文生图',
  bindings: { sampler_name: '3.inputs.sampler_name' },
  parameters: {
    steps: { label: '迭代步数', type: 'number', min: 1, max: 60, step: 1 },
    sampler_name: { label: '采样器' },
  },
};

/** 图生视频：写死文件名的 LoadImage → 自动要求 image，并把 imageUrl 绑到它。 */
const I2V = {
  '10': { inputs: { image: 'example.png', upload: 'image' }, class_type: 'LoadImage' },
  '6': { inputs: { text: '模板占位', clip: ['10', 0] }, class_type: 'CLIPTextEncode' },
  '3': { inputs: { seed: 7, steps: 12, cfg: 1 }, class_type: 'KSampler' },
  '12': {
    inputs: { format: 'video/h264-mp4', images: ['3', 0], frame_rate: 16 },
    class_type: 'VHS_VideoCombine',
  },
};
const I2V_META = { title: '本地图生视频' };

const CLASS_TYPES = new Set();
for (const graph of [T2I, I2V]) {
  for (const node of Object.values(graph)) CLASS_TYPES.add(node.class_type);
}

const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.alloc(32, 7),
]);

// ---------------------------------------------------------------- 假 ComfyUI

const comfy = { prompts: [], outputsByPrompt: new Map(), uploads: 0, viewHits: [] };

const comfyServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const json = (value, status = 200) => {
      const buf = Buffer.from(JSON.stringify(value));
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
      res.end(buf);
    };
    if (url.pathname === '/system_stats') return json({ system: { comfyui_version: 'test' } });
    if (url.pathname === '/object_info') {
      const info = {};
      for (const classType of CLASS_TYPES) info[classType] = { input: { required: {} } };
      // v1.20：KSampler.sampler_name 在真 ComfyUI 里是 COMBO —— 画布节点要把它变成下拉
      info.KSampler.input.required.sampler_name = [['euler', 'euler_ancestral', 'dpmpp_2m'], {}];
      return json(info);
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const parsed = JSON.parse(body.toString('utf8'));
      comfy.prompts.push(parsed);
      const id = `p${comfy.prompts.length}`;
      const graph = parsed?.prompt ?? {};
      let outputId = '';
      let kind = 'images';
      for (const [nodeId, node] of Object.entries(graph)) {
        const type = node?.class_type ?? '';
        if (/^SaveImage/.test(type)) {
          outputId = nodeId;
          kind = 'images';
          break;
        }
        if (/^VHS_VideoCombine$/.test(type)) {
          outputId = nodeId;
          kind = 'videos';
        }
      }
      comfy.outputsByPrompt.set(id, { outputId, kind });
      return json({ prompt_id: id, number: comfy.prompts.length, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.split('/')[2];
      const meta = comfy.outputsByPrompt.get(id) ?? { outputId: '', kind: 'images' };
      const nodeOutput =
        meta.kind === 'videos'
          ? { gifs: [{ filename: 'local_out.mp4', subfolder: '', type: 'output' }] }
          : { images: [{ filename: 'local_out.png', subfolder: '', type: 'output' }] };
      return json({
        [id]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { [meta.outputId]: nodeOutput },
        },
      });
    }
    if (url.pathname === '/view') {
      comfy.viewHits.push(url.search);
      const video = url.searchParams.get('filename')?.endsWith('.mp4');
      const bytes = video ? FAKE_MP4 : FAKE_PNG;
      res.writeHead(200, {
        'content-type': video ? 'video/mp4' : 'image/png',
        'content-length': bytes.length,
      });
      return res.end(bytes);
    }
    if (url.pathname === '/upload/image') {
      comfy.uploads += 1;
      return json({ name: 'uploaded-local.png', subfolder: '', type: 'input' });
    }
    if (url.pathname === '/interrupt' || url.pathname === '/queue') return json({});
    return json({ error: 'not found', path: url.pathname }, 404);
  });
});
await new Promise((done) => comfyServer.listen(0, '127.0.0.1', done));
process.env.COMFYUI_URL = `http://127.0.0.1:${comfyServer.address().port}`;
process.env.AIFISHER_COMFY_POLL_MS = '40';
process.env.AIFISHER_COMFY_OBJECT_INFO_TTL_MS = '0';
process.env.AIFISHER_COMFY_WORKFLOW_TTL_MS = '0';

// ---------------------------------------------------------------- 起插件宿主 + 丢两个工作流进去

const host = await startHost();
const workflowsDir = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'workflows');
mkdirSync(workflowsDir, { recursive: true });
writeFileSync(join(workflowsDir, 'a-t2i.json'), JSON.stringify(T2I), 'utf8');
writeFileSync(join(workflowsDir, 'a-t2i.meta.json'), JSON.stringify(T2I_META), 'utf8');
writeFileSync(join(workflowsDir, 'b-i2v.json'), JSON.stringify(I2V), 'utf8');
writeFileSync(join(workflowsDir, 'b-i2v.meta.json'), JSON.stringify(I2V_META), 'utf8');

const projectId = 'proj-local-workflow';
{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '本地工作流验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window, fetchCalls } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
const { container, handle } = await mountCanvasApp(window);
await settle(1500);

const tool = host.tool('canvas_control');
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-local-workflow' } } });
/** canvas_control 的 read（白名单投影：拿 revision 与节点清单）。 */
const readCanvas = async () => {
  const read = await run({ action: 'read' });
  return { revision: String(read.result?.revision ?? ''), nodes: read.result?.nodes ?? [] };
};
/** 画布真正存盘的文档（节点字段的唯一可信来源）。 */
const savedNodes = async () => {
  const result = await host.hostApi('GET', `/workflows/${projectId}`);
  if (result.status !== 200) return [];
  try {
    return JSON.parse(result.text).nodes ?? [];
  } catch {
    return [];
  }
};
async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await settle(200);
  }
  return last;
}
const savedNode = async (id) => (await savedNodes()).find((node) => node.id === id);

// ---------------------------------------------------------------- 1. 画布把本地工作流注册成模板

check(
  '画布启动时拉取了能力清单（本地工作流注册的入口）',
  fetchCalls.some((call) => call.includes('GET /api/aifisher/canvas/comfy/capabilities')),
  fetchCalls.filter((call) => call.includes('capabilities')).join(' | ') || '(none)',
);

// ---------------------------------------------------------------- 2. 从 UI 建出一个本地工作流节点

function clickButton(label) {
  const element = [...window.document.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === label,
  );
  if (!element) return false;
  element.click();
  return true;
}
/** 画布右键/加号菜单里的项（`<button role="menuitem">`，文案里带快捷方式后缀）。 */
function clickMenuItem(label) {
  const element = [...window.document.querySelectorAll('[role="menuitem"]')].find((item) =>
    (item.textContent || '').includes(label),
  );
  if (!element) return false;
  element.click();
  return true;
}

let firstNodeId = '';
{
  const clickedAdd = clickButton('添加节点');
  await settle(400);
  const openedNodeMenu = clickMenuItem('添加节点'); // 菜单里的「添加节点」→ 节点类型子菜单
  await settle(400);
  const clickedWorkflow = clickMenuItem('ComfyUI 工作流');
  await settle(800);
  const nodes = await waitFor(async () => {
    const list = await readCanvas();
    return list.nodes.length ? list.nodes : null;
  });
  const comfyNode = (nodes ?? []).find((node) => node.type === 'ComfyUI');
  firstNodeId = String(comfyNode?.id ?? '');
  check('左侧工具条的「添加节点」能打开菜单', clickedAdd);
  check('菜单能进到节点类型子菜单', openedNodeMenu);
  check('「ComfyUI 工作流」能建出节点（上游这里原来只派发没人听的库事件）',
    clickedWorkflow && Boolean(comfyNode),
    JSON.stringify((nodes ?? []).map((node) => node.type)));
  const saved = await waitFor(async () => {
    const node = await savedNode(firstNodeId);
    return node?.comfyMode ? node : null;
  });
  check('新建的本地工作流节点默认用清单里的第一个自定义工作流',
    saved?.comfyMode === 'custom-a-t2i',
    String(saved?.comfyMode));
}

// ---------------------------------------------------------------- 3. 节点 UI：下拉/提示词/参数/素材槽

const nodeElement = () => container.querySelector(`[data-node-id="${firstNodeId}"]`);

{
  const element = nodeElement();
  check('节点渲染成通用本地工作流节点', Boolean(element?.querySelector('[data-fisherai-local-workflow-node]')));
  const picker = element?.querySelector('[data-fisherai-local-workflow-picker]');
  const optionValues = [...(picker?.querySelectorAll('option') ?? [])].map((option) => option.value);
  check('工作流下拉同时列出两个自定义工作流',
    optionValues.includes('custom-a-t2i') && optionValues.includes('custom-b-i2v'),
    JSON.stringify(optionValues));
  check('下拉里也能切回内置 MiniMax H3（切回去会渲染成上游那个专用节点）',
    optionValues.includes('minimax-h3-t2va'),
    JSON.stringify(optionValues));
  check('下拉当前值就是这个节点的工作流', picker?.value === 'custom-a-t2i', String(picker?.value));
  check('渲染出提示词输入框', Boolean(element?.querySelector('[data-fisherai-local-workflow-prompt]')));
  const parameterIds = [...(element?.querySelectorAll('[data-fisherai-local-workflow-parameter]') ?? [])].map(
    (item) => item.getAttribute('data-fisherai-local-workflow-parameter'),
  );
  check('渲染出模板里的参数控件（seed/steps/cfg）',
    ['seed', 'steps', 'cfg'].every((key) => parameterIds.includes(key)),
    JSON.stringify(parameterIds));
  const stepsLabel = element
    ?.querySelector('[data-fisherai-local-workflow-parameter="steps"]')
    ?.textContent?.trim();
  check('参数标签用 meta.parameters 里的中文名', String(stepsLabel).includes('迭代步数'), String(stepsLabel));
  check('提示词作为可连接的文本槽渲染（能接文本节点）',
    Boolean(element?.querySelector('[data-fisherai-local-workflow-slot="text"]')),
    JSON.stringify([...(element?.querySelectorAll('[data-fisherai-local-workflow-slot]') ?? [])].map((item) => item.getAttribute('data-fisherai-local-workflow-slot'))));
  // ---- v1.20 布局重排：参数横跨整宽的两列网格（以前挤在右边一列、节点被拉得很高）
  const paramGrid = element?.querySelector('[data-fisherai-local-workflow-parameters]');
  check('参数区是横跨整宽的网格容器（data-columns=2）',
    paramGrid?.getAttribute('data-columns') === '2' &&
      paramGrid?.querySelectorAll('[data-fisherai-local-workflow-parameter]').length === parameterIds.length,
    JSON.stringify({
      columns: paramGrid?.getAttribute('data-columns'),
      cells: paramGrid?.querySelectorAll('[data-fisherai-local-workflow-parameter]').length,
      expected: parameterIds.length,
    }));
  const promptNode = element?.querySelector('[data-fisherai-local-workflow-prompt]');
  check('参数网格排在提示词框之后（不再与提示词抢右边那一列）',
    Boolean(promptNode) && Boolean(paramGrid) &&
      typeof promptNode.compareDocumentPosition === 'function' &&
      (promptNode.compareDocumentPosition(paramGrid) & 4) === 4,
    'prompt before parameters');
  // ---- v1.20：ComfyUI 扫到的枚举（KSampler.sampler_name）在节点上变成下拉
  const samplerSelect = await waitFor(() =>
    element?.querySelector('[data-fisherai-local-workflow-select="sampler_name"]'),
  );
  check('扫 ComfyUI 拿到的枚举让参数变成下拉（node 上的 select 带候选）',
    Boolean(samplerSelect) &&
      [...(samplerSelect?.querySelectorAll('option') ?? [])].length >= 3 &&
      [...(samplerSelect?.querySelectorAll('option') ?? [])].some((option) => option.value === 'dpmpp_2m'),
    JSON.stringify([...(samplerSelect?.querySelectorAll('option') ?? [])].map((option) => option.value)));
  const saved = await waitFor(async () => {
    const node = await savedNode(firstNodeId);
    return node?.width ? node : null;
  });
  check('节点自己写回尺寸（上游默认的 240px 占位卡尺寸放不下表单）',
    saved?.width === 720 && Number(saved.height) > 300,
    `${saved?.width}x${saved?.height}`);
  // ---- v1.25：接入口的 DOM 契约
  // 连线命中判定（canvasConnectionHooks 的覆盖补丁）靠这三个属性 + data-fisherai-port 找端口：
  // 按节点矩形判定的话，圆露在节点框外的那半圈会被漏掉（用户报障「判定接入口与鼠标不准」）。
  // jsdom 没有布局量不了命中，所以这里守的是**属性契约**，命中本身在 browser-check 的真机场景里量。
  const portButtons = [...(element?.querySelectorAll('[data-fisherai-connector-side="left"]') ?? [])];
  const portIndices = portButtons.map((button) =>
    String(button.getAttribute('data-fisherai-connector-port-index')),
  );
  check('每个输入槽的「+」都带端口契约（node-id / side / port-index）',
    portButtons.length >= 2 &&
      portButtons.every(
        (button) =>
          button.getAttribute('data-fisherai-connector-node-id') === firstNodeId &&
          button.getAttribute('data-fisherai-connector-side') === 'left',
      ),
    JSON.stringify(portIndices));
  check('端口下标就是槽位下标（0..n-1，不重号）',
    portIndices.join(',') === portIndices.map((_, index) => String(index)).join(','),
    JSON.stringify(portIndices));
  check('端口按钮带发光钩子 data-fisherai-port（拖动时按距离放大/发光的锚点）',
    portButtons.every((button) => button.getAttribute('data-fisherai-port') === 'true') &&
      Boolean(element?.querySelector('[data-fisherai-connector-side="right"][data-fisherai-port="true"]')),
    `${portButtons.length} 个输入端口`);
}

// ---------------------------------------------------------------- 4. 填提示词 + 改参数 → 生成 → 结果节点

function setControl(element, value) {
  const proto =
    element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : element.tagName === 'SELECT'
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  element.dispatchEvent(
    new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
  );
}

{
  const element = nodeElement();
  setControl(element.querySelector('[data-fisherai-local-workflow-prompt]'), '一只猫在雨里走过霓虹街道');
  setControl(element.querySelector('[data-fisherai-local-workflow-parameter="steps"] input'), '31');
  const sampler = element.querySelector('[data-fisherai-local-workflow-select="sampler_name"]');
  if (sampler) setControl(sampler, 'dpmpp_2m');
  await settle(200);

  const persisted = await waitFor(async () => {
    const node = await savedNode(firstNodeId);
    return node?.prompt === '一只猫在雨里走过霓虹街道' ? node : null;
  });
  check('提示词写进了节点数据', persisted?.prompt === '一只猫在雨里走过霓虹街道', JSON.stringify(persisted?.prompt));
  check('参数改动写进了节点数据', persisted?.comfyParams?.steps === 31, JSON.stringify(persisted?.comfyParams));
  check('下拉选中的值也写进了节点数据',
    !sampler || (await waitFor(async () => (await savedNode(firstNodeId))?.comfyParams?.sampler_name === 'dpmpp_2m')) === true,
    JSON.stringify((await savedNode(firstNodeId))?.comfyParams));

  nodeElement().querySelector('[data-fisherai-local-workflow-generate]').click();
  await settle(2500);

  const graph = comfy.prompts[0]?.prompt ?? {};
  check('提交了本地工作流请求', comfy.prompts.length === 1, `prompts=${comfy.prompts.length}`);
  check('提示词写进了模板的提示词节点', graph['6']?.inputs?.text === '一只猫在雨里走过霓虹街道', JSON.stringify(graph['6']?.inputs?.text));
  check('参数写进了模板的采样节点', graph['3']?.inputs?.steps === 31, JSON.stringify(graph['3']?.inputs?.steps));
  check('下拉选中的采样器写进了模板', graph['3']?.inputs?.sampler_name === 'dpmpp_2m', JSON.stringify(graph['3']?.inputs?.sampler_name));
  check('页面上的状态徽标变成已完成',
    nodeElement()?.querySelector('[data-fisherai-local-workflow-status]')?.textContent?.includes('已完成'),
    nodeElement()?.querySelector('[data-fisherai-local-workflow-status]')?.textContent);

  const output = await waitFor(async () => {
    const nodes = await savedNodes();
    return nodes.find((node) => node.type === 'Upload Image' && (node.parentIds || []).includes(firstNodeId)) ?? null;
  });
  check('结果落成一个图片节点并连回源节点',
    Boolean(output) && String(output.resultUrl).startsWith('/api/aifisher/canvas/media/'),
    JSON.stringify({ type: output?.type, url: output?.resultUrl }));
  check('结果字节真的从 ComfyUI /view 取回过', comfy.viewHits.length === 1, `viewHits=${comfy.viewHits.length}`);

  // ---------------------------------------------------------------- 5. 第二个节点：换成图生视频 + 缺素材的报错

  clickButton('添加节点');
  await settle(400);
  clickMenuItem('添加节点');
  await settle(400);
  clickMenuItem('ComfyUI 工作流');
  await settle(800);
  const secondId = await waitFor(async () => {
    const list = (await readCanvas()).nodes.filter(
      (node) => node.type === 'ComfyUI' && node.id !== firstNodeId,
    );
    return list.length ? String(list[0].id) : null;
  });
  const secondElement = () => container.querySelector(`[data-node-id="${secondId}"]`);
  setControl(secondElement().querySelector('[data-fisherai-local-workflow-picker]'), 'custom-b-i2v');
  await settle(400);
  check('下拉切换到图生视频工作流后写回了节点',
    (await waitFor(async () => (await savedNode(secondId))?.comfyMode === 'custom-b-i2v')) === true,
    String((await savedNode(secondId))?.comfyMode));
  check('切换后渲染出 image 素材槽（LoadImage 推断出来的）',
    Boolean(secondElement()?.querySelector('[data-fisherai-local-workflow-slot="imageUrl"]')),
    JSON.stringify([...(secondElement()?.querySelectorAll('[data-fisherai-local-workflow-slot]') ?? [])].map((item) => item.getAttribute('data-fisherai-local-workflow-slot'))));

  setControl(secondElement().querySelector('[data-fisherai-local-workflow-prompt]'), '让猫咪抬头');
  await settle(200);
  secondElement().querySelector('[data-fisherai-local-workflow-generate]').click();
  await settle(800);
  const errorText = secondElement()?.querySelector('[data-fisherai-local-workflow-error]')?.textContent ?? '';
  check('必填素材没连接时给出可读错误、不提交',
    errorText.includes('还缺这些输入') && errorText.includes('参考图') && comfy.prompts.length === 1,
    `${errorText} | prompts=${comfy.prompts.length}`);

  // ---------------------------------------------------------------- 6. 连上上一个节点的产出 → 素材上传并写回模板

  const edit = await run({
    action: 'edit',
    revision: (await readCanvas()).revision,
    operations: [{ kind: 'connect', sourceId: output.id, targetId: secondId }],
  });
  check('把图片节点的产出连到本地工作流节点上',
    edit.ok === true && edit.result?.ok === true,
    JSON.stringify(edit).slice(0, 240));

  secondElement().querySelector('[data-fisherai-local-workflow-generate]').click();
  await settle(2500);

  const secondGraph = comfy.prompts[1]?.prompt ?? {};
  check('第二次生成真的提交了（素材齐全后不再报错）', comfy.prompts.length === 2, `prompts=${comfy.prompts.length}`);
  check('素材先上传到 ComfyUI 的 /upload/image', comfy.uploads >= 1, `uploads=${comfy.uploads}`);
  check('上传回来的文件名写进了模板的 LoadImage 节点',
    secondGraph['10']?.inputs?.image === 'uploaded-local.png',
    JSON.stringify(secondGraph['10']?.inputs?.image));
  check('提示词也进了第二个模板',
    secondGraph['6']?.inputs?.text === '让猫咪抬头',
    JSON.stringify(secondGraph['6']?.inputs?.text));
  const video = await waitFor(async () => {
    const nodes = await savedNodes();
    return nodes.find((node) => node.type === 'Upload Video' && (node.parentIds || []).includes(secondId)) ?? null;
  });
  check('视频结果落成 Upload Video 节点（输出类型跟着工作流走）',
    Boolean(video) && String(video.resultUrl).includes('/videos/'),
    JSON.stringify({ type: video?.type, url: video?.resultUrl }));
}

// ---------------------------------------------------------------- 7. v1.21：负向提示词接文本节点 / 结果自动整理 / 多选折叠成一叠

/** 这个源节点产出的结果节点（画布文档里的）。 */
const outputsOf = async (sourceId) =>
  (await savedNodes()).filter(
    (node) =>
      node.type === 'Upload Image' &&
      Array.isArray(node.parentIds) &&
      node.parentIds[0] === sourceId,
  );

{
  // ---- 7.1 骨架：负向提示词从「参数控件」升级成 text 输入槽
  const capability = await host.hostApi('GET', '/comfy/capabilities?outputType=images');
  const template = (capability.json()?.capabilities ?? []).find(
    (item) => item.workflowType === 'custom-a-t2i',
  )?.template;
  const slotIds = (template?.inputs ?? []).map((slot) => slot.id);
  check('能力清单里负向提示词是 text 输入槽（紧跟在正向槽后面）',
    template?.negativeTextParameter === 'negativeText' &&
      slotIds[0] === 'text' &&
      slotIds[1] === 'negativeText' &&
      (template?.inputs ?? [])[1]?.type === 'text',
    JSON.stringify({ negativeTextParameter: template?.negativeTextParameter, slotIds }));
  check('负向提示词不再出现在参数控件里（不会又当参数又当槽）',
    !(template?.parameters ?? []).some((item) => item.id === 'negativeText'),
    JSON.stringify((template?.parameters ?? []).map((item) => item.id)));

  const element = nodeElement();
  const negativeBox = element?.querySelector('[data-fisherai-local-workflow-negative-prompt]');
  check('节点上渲染出负向提示词输入框', Boolean(negativeBox));
  check('负向提示词槽可以连文本节点',
    Boolean(element?.querySelector('[data-fisherai-local-workflow-slot="negativeText"]')),
    JSON.stringify([...(element?.querySelectorAll('[data-fisherai-local-workflow-slot]') ?? [])].map(
      (item) => item.getAttribute('data-fisherai-local-workflow-slot'),
    )));

  setControl(negativeBox, '模糊，低质量');
  await settle(220);
  const savedNegative = await waitFor(async () => {
    const node = await savedNode(firstNodeId);
    return node?.negativePrompt === '模糊，低质量' ? node : null;
  });
  check('负向提示词写进节点数据（node.negativePrompt）',
    savedNegative?.negativePrompt === '模糊，低质量',
    JSON.stringify(savedNegative?.negativePrompt));

  // ---- 7.2 生成时负向提示词真的进了模板的负向节点
  nodeElement().querySelector('[data-fisherai-local-workflow-generate]').click();
  await settle(2500);
  const negativeGraph = comfy.prompts.at(-1)?.prompt ?? {};
  check('负向提示词写进模板的负向节点',
    negativeGraph['7']?.inputs?.text === '模糊，低质量',
    JSON.stringify(negativeGraph['7']?.inputs?.text));
  check('正向提示词仍然写进正向节点',
    negativeGraph['6']?.inputs?.text === '一只猫在雨里走过霓虹街道',
    JSON.stringify(negativeGraph['6']?.inputs?.text));

  // ---- 7.3 两个文本节点分别接到正向槽与负向槽
  const created = await run({
    action: 'edit',
    revision: (await readCanvas()).revision,
    operations: [
      { kind: 'create', ref: 'pos', type: 'Text', x: -1400, y: 0, prompt: '文本节点给的正向' },
      { kind: 'create', ref: 'neg', type: 'Text', x: -1400, y: 400, prompt: '文本节点给的负向' },
    ],
  });
  const posId = created.result?.created?.find((item) => item.ref === 'pos')?.id;
  const negId = created.result?.created?.find((item) => item.ref === 'neg')?.id;
  check('建出两个文本节点（用来喂正向 / 负向提示词）',
    Boolean(posId) && Boolean(negId),
    JSON.stringify(created.result?.created));
  await settle(400);
  const wire = async (sourceId) =>
    run({
      action: 'edit',
      revision: (await readCanvas()).revision,
      operations: [{ kind: 'connect', sourceId, targetId: firstNodeId }],
    });
  const wiredPositive = posId ? await wire(posId) : null;
  await settle(500);
  const wiredNegative = negId ? await wire(negId) : null;
  await settle(600);
  const wired = await waitFor(async () => {
    const node = await savedNode(firstNodeId);
    return Array.isArray(node?.parentIds) && node.parentIds[0] === posId && node.parentIds[1] === negId
      ? node
      : null;
  });
  check('两个文本节点分别落到正向槽（parentIds[0]）与负向槽（parentIds[1]）',
    Boolean(wired),
    JSON.stringify({
      pos: wiredPositive?.result?.ok,
      neg: wiredNegative?.result?.ok,
      parentIds: (await savedNode(firstNodeId))?.parentIds,
    }));

  // ---- 7.4 接上文本节点之后：输入框不再显示，只剩一行只读提示
  const linkedElement = nodeElement();
  check('正向提示词槽接上文本节点后，输入框不再显示',
    !linkedElement?.querySelector('[data-fisherai-local-workflow-prompt]'));
  check('负向提示词槽接上文本节点后，输入框也不再显示',
    !linkedElement?.querySelector('[data-fisherai-local-workflow-negative-prompt]'));
  check('两处都换成只读的「来自文本节点」提示',
    Boolean(linkedElement?.querySelector('[data-fisherai-local-workflow-linked="text"]')) &&
      Boolean(linkedElement?.querySelector('[data-fisherai-local-workflow-linked="negativeText"]')),
    JSON.stringify([...(linkedElement?.querySelectorAll('[data-fisherai-local-workflow-linked]') ?? [])].map(
      (item) => item.getAttribute('data-fisherai-local-workflow-linked'),
    )));

  // ---- 7.5 再生成一次：正负提示词都来自文本节点
  nodeElement().querySelector('[data-fisherai-local-workflow-generate]').click();
  await settle(2500);
  const linkedGraph = comfy.prompts.at(-1)?.prompt ?? {};
  check('正向提示词取自文本节点',
    linkedGraph['6']?.inputs?.text === '文本节点给的正向',
    JSON.stringify(linkedGraph['6']?.inputs?.text));
  check('负向提示词取自文本节点',
    linkedGraph['7']?.inputs?.text === '文本节点给的负向',
    JSON.stringify(linkedGraph['7']?.inputs?.text));

  // ---- 7.6 同一节点的多张结果图自动整理（不再互相遮盖）
  const outputs = await waitFor(async () => {
    const list = await outputsOf(firstNodeId);
    return list.length >= 2 ? list : null;
  });
  const overlaps = (outputs ?? []).some((node, index) =>
    (outputs ?? []).some(
      (other, otherIndex) =>
        index < otherIndex &&
        Math.abs(Number(node.x) - Number(other.x)) < 40 &&
        Math.abs(Number(node.y) - Number(other.y)) < 40,
    ),
  );
  check('同一节点的多张结果图落点互不相同（以前每次都落在同一个点）',
    (outputs ?? []).length >= 2 && !overlaps,
    JSON.stringify((outputs ?? []).map((node) => [node.x, node.y])));
  const sourceNode = await savedNode(firstNodeId);
  const sourceRight = Number(sourceNode?.x ?? 0) + 720;
  check('结果图都排在源节点右侧',
    (outputs ?? []).length >= 2 && (outputs ?? []).every((node) => Number(node.x) > sourceRight),
    JSON.stringify({ sourceRight, positions: (outputs ?? []).map((node) => [node.x, node.y]) }));

  // ---- 7.7 多选两张图 → 折叠成一叠 → 展开（解散）
  const [firstOutput, secondOutput] = outputs ?? [];
  if (firstOutput && secondOutput) {
    const imageCountBefore = (await savedNodes()).filter((node) => node.type === 'Upload Image').length;
    await run({ action: 'focus', nodeIds: [firstOutput.id, secondOutput.id] });
    await settle(400);
    const collapseButton = window.document.querySelector('[data-fisherai-collapse-stack]');
    check('多选图片后，多选工具条上出现「折叠」按钮', Boolean(collapseButton));
    collapseButton?.click();
    await settle(600);
    const stacked = await waitFor(async () => {
      const list = await savedNodes();
      const host = list.find((node) => Array.isArray(node.stackItems) && node.stackItems.length);
      return host ?? null;
    });
    check('折叠后画布上只剩一张，被收起来的那张存进 stackItems',
      Boolean(stacked) && stacked.stackItems.length === 1,
      JSON.stringify({ host: stacked?.id, count: stacked?.stackItems?.length }));
    const imageCountAfter = (await savedNodes()).filter((node) => node.type === 'Upload Image').length;
    check('折叠后那张图从画布节点清单里摘出去了（不再占位置 / 不会被框选到）',
      imageCountAfter === imageCountBefore - 1,
      JSON.stringify({ before: imageCountBefore, after: imageCountAfter }));
    const badgeHost = stacked ? window.document.querySelector(`[data-node-id="${stacked.id}"]`) : null;
    check('折叠宿主卡后面垫了两层「纸」',
      Boolean(badgeHost?.querySelector('[data-fisherai-stack-layer="1"]')) &&
        Boolean(badgeHost?.querySelector('[data-fisherai-stack-layer="2"]')));
    const badge = badgeHost?.querySelector('[data-fisherai-stack-badge]');
    check('宿主卡左下角有「N 张叠图 · 展开」徽章', Boolean(badge), String(badge?.textContent ?? ''));
    badge?.click();
    await settle(800);
    await waitFor(async () => {
      const list = await savedNodes();
      return list.some((node) => Array.isArray(node.stackItems)) ? null : list.length ? list : null;
    });
    const expandedOutputs = await outputsOf(firstNodeId);
    check('点「展开」后两张图都回到画布上（stackItems 清空）',
      expandedOutputs.length >= 2 &&
        (await savedNodes()).every((node) => !Array.isArray(node.stackItems)),
      JSON.stringify({
        outputs: expandedOutputs.length,
        stacks: (await savedNodes()).filter((node) => Array.isArray(node.stackItems)).length,
      }));
    check('展开后两张图彼此错开（解散是摊开，不是原样压回去）',
      expandedOutputs.length >= 2 &&
        expandedOutputs.every((node, index) =>
          expandedOutputs.every(
            (other, otherIndex) =>
              index >= otherIndex ||
              Math.abs(Number(node.x) - Number(other.x)) >= 40 ||
              Math.abs(Number(node.y) - Number(other.y)) >= 40,
          ),
        ),
      JSON.stringify(expandedOutputs.map((node) => [node.x, node.y])));
  } else {
    check('多选图片折叠：没有足够的结果图可测', false, 'need 2 outputs');
  }
}

// ---------------------------------------------------------------- 8. 全程无运行时错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=200')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('本地工作流节点全程无运行时错误', errors.length === 0, errors.map((e) => e.message).join(' | ') || '(none)');
}

try {
  handle.dispose();
} catch {
  /* 卸载失败会在渲染测试里单独断言 */
}
comfyServer.close();
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
