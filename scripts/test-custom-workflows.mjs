/**
 * 目录式自定义工作流模板回归测试（host 半 + 假 ComfyUI）。
 *
 * 覆盖这条链路：
 *   用户把 ComfyUI 的 Export (API) JSON 丢进 $DSH_HOME/storages/dsh-aifisher-canvas/workflows/
 *     → 惰性扫描（readdirSync + TTL 缓存）推成工作流元数据
 *     → GET /api/comfy/capabilities?outputType=…  /  /api/comfy/workflows  列出来
 *     → GET /api/comfy/workflow/<id>                                       取模板
 *     → POST /api/comfy/prepare/<id>                                       按 bindings/推断组装（含素材上传）
 *     → POST /api/comfy/<id>  与  POST /api/aifisher/canvas/comfy/<id>      真跑：
 *          组装 → modelResolver.reconcile → runComfyWorkflow → { success, url, asset, workflowType }
 *   以及：坏 JSON 只记诊断不炸清单、/api/comfy/custom-workflows 状态端点、必填/绑定写错的可读报错。
 *
 * 假 ComfyUI 是真的 node:http 服务，只实现用到的端点；输出节点的类型由提交上来的图自己认，
 * 于是「SaveImage → images」「VHS_VideoCombine → videos」两条结果回收路径都能真跑一遍。
 *
 * 用法：node scripts/test-custom-workflows.mjs   （需要先 build）
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORIGIN, ROOT, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}

// ---------------------------------------------------------------- 夹具模板

/** 文生图（SDXL 那种最普通的形状）：输出图片，参数全靠自动推断。 */
const SD_T2I = {
  '4': { inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' }, class_type: 'CheckpointLoaderSimple' },
  '5': { inputs: { width: 1024, height: 1024, batch_size: 1 }, class_type: 'EmptyLatentImage' },
  '6': {
    inputs: { text: '模板里的正向占位', clip: ['4', 1] },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Positive' },
  },
  '7': {
    inputs: { text: '模板里的负向占位', clip: ['4', 1] },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Negative' },
  },
  '3': {
    inputs: {
      seed: 12345,
      steps: 20,
      cfg: 7.5,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
    class_type: 'KSampler',
  },
  '8': { inputs: { samples: ['3', 0], vae: ['4', 2] }, class_type: 'VAEDecode' },
  '9': { inputs: { images: ['8', 0], filename_prefix: 'dsh' }, class_type: 'SaveImage' },
};

/** sd-t2i 的侧车：覆盖标题/分组/超时，并给 steps/cfg 一个默认值。 */
const SD_T2I_META = {
  title: '我的文生图（SDXL）',
  category: 'custom-t2i',
  timeoutMs: 300000,
  defaults: { steps: 24, cfg: 6.5 },
  // 画布节点上的控件长什么样（对象 = 详细声明，字符串 = 只给标签）
  parameters: {
    steps: { label: '迭代步数', type: 'number', min: 1, max: 60, step: 1 },
    cfg: 'CFG 强度',
  },
};

/** 图生视频：有一个写死文件名的 LoadImage（→ 自动要求 image，并把 imageUrl 绑到它）。 */
const I2V = {
  '10': { inputs: { image: 'example.png', upload: 'image' }, class_type: 'LoadImage', _meta: { title: '参考图' } },
  '6': { inputs: { text: '模板占位提示词', clip: ['10', 0] }, class_type: 'CLIPTextEncode' },
  '3': { inputs: { seed: 7, steps: 12, cfg: 1 }, class_type: 'KSampler' },
  '12': {
    inputs: { format: 'video/h264-mp4', images: ['3', 0], frame_rate: 16 },
    class_type: 'VHS_VideoCombine',
  },
};

/** 中文文件名 + SaveAudio → 验证 id slug 与 audios 归类。 */
const AUDIO = {
  '2': { inputs: { text: '占位' }, class_type: 'CLIPTextEncode' },
  '20': { inputs: { audio: ['2', 0], filename_prefix: 'tts' }, class_type: 'SaveAudio' },
};

/** 绑定目标写错（模板里没有 99 号节点）→ 组装时必须报可读错误。 */
const BAD_BINDING = {
  '9': { inputs: { images: ['1', 0] }, class_type: 'SaveImage' },
  '1': { inputs: { value: 1 }, class_type: 'EmptyLatentImage' },
};
const BAD_BINDING_META = { bindings: { seed: '99.inputs.seed' } };

/** 有人直接存了 /prompt 的请求体（包了一层 prompt）；meta 里全是错值，验证「宽容 + 诊断」。 */
const WRAPPED = {
  prompt: {
    '40': { inputs: { text: '占位' }, class_type: 'CLIPTextEncode' },
    '41': { inputs: { samples: ['40', 0] }, class_type: 'VAEDecode' },
    '9': { inputs: { images: ['41', 0] }, class_type: 'SaveImage' },
  },
};
const WRAPPED_META = { outputType: 'bogus', timeoutMs: -5, promptNode: '404' };

/**
 * v1.20 用户报障的那份形状（原话「我工作流里有字符串节点作为提示词输入，但是它识别出
 * 这个工作流不需要提示词」）：
 *   提示词不在 CLIPTextEncode 上，而是两个 PrimitiveStringMultiline 的 **value** 字段，
 *   被连线喂进 CLIPTextEncode.text。旧推断只找「自己有写死 text 的节点」，于是判成没有提示词。
 * 顺带：LoraLoader.lora_name 在真 ComfyUI 里是枚举 —— 要能变成下拉。
 */
const STRING_T2I = {
  '70': { inputs: { value: '' }, class_type: 'PrimitiveStringMultiline', _meta: { title: '正面提示词' } },
  '71': { inputs: { ckpt_name: 'waiIllustriousSDXL_v170.safetensors' }, class_type: 'CheckpointLoaderSimple' },
  '72': { inputs: { value: '' }, class_type: 'PrimitiveStringMultiline', _meta: { title: '负面提示词' } },
  '76': {
    inputs: { lora_name: 'wlop.safetensors', strength_model: 0.75, model: ['71', 0] },
    class_type: 'LoraLoader',
  },
  '77': { inputs: { text: ['70', 0], clip: ['76', 1] }, class_type: 'CLIPTextEncode' },
  '78': { inputs: { text: ['72', 0], clip: ['76', 1] }, class_type: 'CLIPTextEncode' },
  '84': { inputs: { seed: 34663893509277 }, class_type: 'Seed (rgthree)' },
  '85': {
    inputs: {
      seed: ['84', 0],
      steps: 26,
      cfg: 6.5,
      sampler_name: 'dpmpp_2m',
      model: ['76', 0],
      positive: ['77', 0],
      negative: ['78', 0],
    },
    class_type: 'KSampler',
  },
  '92': { inputs: { images: ['85', 0], filename_prefix: 'out' }, class_type: 'SaveImage' },
};
/** 用户那份 meta 的样子：提示词绑在自己起的键上（value/value2），不是约定的 text/negativeText。 */
const STRING_T2I_META = {
  title: '字符串节点提示词',
  bindings: {
    value: '70.inputs.value',
    value2: '72.inputs.value',
    lora_name: '76.inputs.lora_name',
    strength_model: '76.inputs.strength_model',
    seed: '84.inputs.seed',
  },
  parameters: {
    value: { label: '正面提示词' },
    value2: { label: '负面提示词' },
    lora_name: { label: 'lora模型' },
    strength_model: { label: '强度' },
  },
};

/** 后加/后删用的夹具（验证「不重启也能生效」）。 */
const EXTRA = { '30': { inputs: { images: ['31', 0] }, class_type: 'SaveImage' }, '31': { inputs: {}, class_type: 'VAEDecode' } };

/** 所有夹具里出现过的 class_type —— 假 /object_info 必须一个不缺，否则对账会报缺节点。 */
function collectClassTypes() {
  const types = new Set();
  for (const graph of [SD_T2I, I2V, AUDIO, BAD_BINDING, EXTRA, STRING_T2I]) {
    for (const node of Object.values(graph)) if (node.class_type) types.add(node.class_type);
  }
  for (const node of Object.values(WRAPPED.prompt)) if (node.class_type) types.add(node.class_type);
  return types;
}

/** 一段假的 mp4 / png 字节（只验证「原样落盘」）。 */
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(64, 0x11),
]);
const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------- 假 ComfyUI

function buildObjectInfo() {
  const info = {};
  for (const classType of collectClassTypes()) info[classType] = { input: { required: {} } };
  // 本机装的是「带 pruned 的另一个量化版」，用来验证提交前对账会按核心名自动替换
  info.CheckpointLoaderSimple.input.required.ckpt_name = [
    ['sd_xl_base_1.0_pruned.safetensors'],
    { tooltip: 'checkpoints' },
  ];
  // v1.20：真 ComfyUI 里这些是 COMBO（枚举）—— 它们该变成画布节点上的下拉
  info.LoraLoader.input.required.lora_name = [
    ['wlop.safetensors', 'detail-tweaker.safetensors', 'ghost-mix.safetensors'],
    {},
  ];
  info.LoraLoader.input.required.strength_model = ['FLOAT', { default: 1, min: -10, max: 10, step: 0.05 }];
  info.KSampler.input.required.sampler_name = [['euler', 'dpmpp_2m', 'dpmpp_sde'], {}];
  return info;
}

const comfy = {
  /** 提交上来的 prompt（含图）与它们的输出节点信息 */
  prompts: [],
  outputsByPrompt: new Map(),
  uploads: 0,
  viewHits: [],
  objectInfoCalls: 0,
};

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
      comfy.objectInfoCalls += 1;
      return json(buildObjectInfo());
    }
    if (url.pathname === '/input/sample.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': FAKE_PNG.length });
      return res.end(FAKE_PNG);
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const parsed = JSON.parse(body.toString('utf8'));
      comfy.prompts.push(parsed);
      const id = `p${comfy.prompts.length}`;
      const graph = parsed?.prompt ?? {};
      // 认输出节点：与插件自己的推断同源（SaveImage→图片 / VHS_VideoCombine→视频）
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
          ? { gifs: [{ filename: 'custom_out.mp4', subfolder: '', type: 'output' }] }
          : { images: [{ filename: 'custom_out.png', subfolder: '', type: 'output' }] };
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
      return json({ name: 'uploaded-custom.png', subfolder: '', type: 'input' });
    }
    if (url.pathname === '/interrupt') return json({});
    if (url.pathname === '/queue') return json({});
    return json({ error: 'not found', path: url.pathname }, 404);
  });
});
await new Promise((done) => comfyServer.listen(0, '127.0.0.1', done));
const comfyPort = comfyServer.address().port;
process.env.COMFYUI_URL = `http://127.0.0.1:${comfyPort}`;
process.env.AIFISHER_COMFY_POLL_MS = '40';
// 对账缓存默认 5 分钟、目录扫描默认 2 秒：测试里要立刻看到文件变化，两个都关掉
process.env.AIFISHER_COMFY_OBJECT_INFO_TTL_MS = '0';
process.env.AIFISHER_COMFY_WORKFLOW_TTL_MS = '0';

// ---------------------------------------------------------------- 起插件宿主

const host = await startHost();
const workflowsDir = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'workflows');

const json = async (method, path, body) => {
  const res = await host.hostApi(method, path, body);
  let parsed = null;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text: res.text };
};
/** 裸 /api/comfy/* 的请求（不走画布命名空间）。 */
const plain = async (method, path, body) => {
  const res = await host.dispatch(method, `/api/comfy${path}`, body);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text: res.body };
};

const projectId = 'proj-custom-1';

// ---------------------------------------------------------------- 1. 目录与目录说明

{
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, 'sd-t2i.json'), JSON.stringify(SD_T2I, null, 2), 'utf8');
  writeFileSync(join(workflowsDir, 'sd-t2i.meta.json'), JSON.stringify(SD_T2I_META, null, 2), 'utf8');
  writeFileSync(join(workflowsDir, 'i2v.json'), JSON.stringify(I2V, null, 2), 'utf8');
  writeFileSync(join(workflowsDir, '我的流程.json'), JSON.stringify(AUDIO, null, 2), 'utf8');
  writeFileSync(join(workflowsDir, 'bad-binding.json'), JSON.stringify(BAD_BINDING, null, 2), 'utf8');
  writeFileSync(
    join(workflowsDir, 'bad-binding.meta.json'),
    JSON.stringify(BAD_BINDING_META, null, 2),
    'utf8',
  );
  // 两个坏的：一个 JSON 语法错，一个根本不是节点图
  writeFileSync(join(workflowsDir, 'broken.json'), '{ "1": { "inputs": {} ', 'utf8');
  writeFileSync(join(workflowsDir, 'not-a-graph.json'), JSON.stringify([1, 2, 3]), 'utf8');
  // 包了一层 prompt 的写法；meta 里全是错值（宽容处理 + 记诊断）
  writeFileSync(join(workflowsDir, 'wrapped.json'), JSON.stringify(WRAPPED, null, 2), 'utf8');
  writeFileSync(join(workflowsDir, 'wrapped.meta.json'), JSON.stringify(WRAPPED_META, null, 2), 'utf8');
  // v1.20：字符串节点当提示词 + 别名键的 meta + lora 枚举
  writeFileSync(join(workflowsDir, 'string-t2i.json'), JSON.stringify(STRING_T2I, null, 2), 'utf8');
  writeFileSync(
    join(workflowsDir, 'string-t2i.meta.json'),
    JSON.stringify(STRING_T2I_META, null, 2),
    'utf8',
  );

  const list = await plain('GET', '/workflows');
  const ids = (list.body?.workflows ?? []).map((item) => item.id);
  check('目录不存在时被自动创建，并写入 README.md',
    existsSync(join(workflowsDir, 'README.md')) &&
      readFileSync(join(workflowsDir, 'README.md'), 'utf8').includes('Export (API)'),
    workflowsDir);
  check('内置工作流仍在清单里（自定义不挤掉它）', ids.includes('minimax-h3-t2va'), ids.join(','));
  check('自定义工作流进了 /api/comfy/workflows',
    ids.includes('custom-sd-t2i') && ids.includes('custom-i2v'),
    ids.join(','));
  check('中文文件名也能生成 id', ids.includes('custom-我的流程'), ids.join(','));
  const sd = (list.body?.workflows ?? []).find((item) => item.id === 'custom-sd-t2i');
  check('meta.title 覆盖标题', sd?.title === '我的文生图（SDXL）', String(sd?.title));
  check('meta.category 覆盖分组', sd?.category === 'custom-t2i', String(sd?.category));
  check('meta.timeoutMs 覆盖默认超时', sd?.timeoutMs === 300000, String(sd?.timeoutMs));
  check('推断出 outputType=images', sd?.outputType === 'images', String(sd?.outputType));
  check('推断出 requiredInputs=[text]',
    Array.isArray(sd?.requiredInputs) && sd.requiredInputs.length === 1 && sd.requiredInputs[0] === 'text',
    JSON.stringify(sd?.requiredInputs));
  check('没写 modes 的工作流默认 [default]',
    Array.isArray(sd?.modes) && sd.modes.length === 1 && sd.modes[0] === 'default',
    JSON.stringify(sd?.modes));
}

// ---------------------------------------------------------------- 2. 能力清单（两个命名空间）

{
  const images = await json('GET', '/comfy/capabilities?outputType=images');
  const imageIds = (images.body?.capabilities ?? []).map((item) => item.workflowType);
  check('画布命名空间的能力清单列出图片类的自定义工作流',
    images.status === 200 && imageIds.includes('custom-sd-t2i'),
    JSON.stringify(imageIds));

  const videos = await plain('GET', '/capabilities?outputType=videos');
  const videoIds = (videos.body?.capabilities ?? []).map((item) => item.workflowType);
  check('裸 /api/comfy/capabilities 同时给出内置与自定义视频工作流',
    videoIds.includes('minimax-h3-t2va') && videoIds.includes('custom-i2v'),
    JSON.stringify(videoIds));
  const i2v = (videos.body?.capabilities ?? []).find((item) => item.workflowType === 'custom-i2v');
  check('图生视频自动要求 text + image',
    JSON.stringify(i2v?.requiredInputs) === JSON.stringify(['text', 'image']),
    JSON.stringify(i2v?.requiredInputs));

  const audios = await plain('GET', '/capabilities?outputType=audios');
  const audioIds = (audios.body?.capabilities ?? []).map((item) => item.workflowType);
  check('SaveAudio → audios 归类', audioIds.includes('custom-我的流程'), JSON.stringify(audioIds));

  // 画布节点参数骨架（template）：画布靠它渲染节点，不再自己解析 ComfyUI 模板
  check('自定义工作流带上画布节点参数骨架',
    i2v?.template && typeof i2v.template === 'object' && i2v.template.outputType === 'videos',
    JSON.stringify(i2v?.template && Object.keys(i2v.template)));
  check('骨架里提示词是文本输入槽（可接文本节点），且排在最前',
    i2v?.template?.inputs?.[0]?.id === 'text' &&
      i2v.template.inputs[0].type === 'text' &&
      i2v.template.inputs[0].required === true,
    JSON.stringify(i2v?.template?.inputs));
  check('骨架里 LoadImage 变成 image 类型的素材槽（必填）',
    i2v?.template?.inputs?.some(
      (slot) => slot.id === 'imageUrl' && slot.type === 'image' && slot.required === true,
    ),
    JSON.stringify(i2v?.template?.inputs));
  check('骨架里采样参数进 parameters（数字控件 + 模板里的原值做默认）',
    ['seed', 'steps', 'cfg'].every((key) => {
      const parameter = i2v?.template?.parameters?.find((item) => item.id === key);
      return parameter && parameter.type === 'number' && typeof parameter.default === 'number';
    }),
    JSON.stringify(i2v?.template?.parameters));
  check('骨架里给出一个视频输出口',
    i2v?.template?.outputs?.length === 1 &&
      i2v.template.outputs[0].type === 'video' &&
      i2v.template.outputType === 'videos',
    JSON.stringify(i2v?.template?.outputs));
  check('内置工作流不带 template（画布用自己那份写死的 MiniMax 节点）',
    !(videos.body?.capabilities ?? []).find((item) => item.workflowType === 'minimax-h3-t2va')?.template);

  const canvasCapabilities = await json('GET', '/comfy/capabilities?outputType=videos');
  check('画布命名空间与 /api/comfy 的能力清单逐字节一致',
    canvasCapabilities.text === videos.text,
    `${canvasCapabilities.status}`);

  const bad = await plain('GET', '/capabilities?outputType=nope');
  check('非法 outputType 仍然 400', bad.status === 400 && bad.body?.code === 'INVALID_OUTPUT_TYPE');
}

// ---------------------------------------------------------------- 3. 模板读取 + 状态端点

{
  const template = await plain('GET', '/workflow/custom-sd-t2i');
  const nodes = template.body?.template ? Object.keys(template.body.template).length : 0;
  check('GET /api/comfy/workflow/:id 取回自定义模板',
    template.status === 200 && template.body?.id === 'custom-sd-t2i' && nodes === 7,
    `${template.status} nodes=${nodes}`);

  const missing = await plain('GET', '/workflow/custom-不存在');
  check('未知工作流取模板 → 404', missing.status === 404, `${missing.status}`);

  const status = await plain('GET', '/custom-workflows');
  const errorFiles = (status.body?.errors ?? []).map((item) => item.file);
  check('状态端点报出读到了几个自定义工作流',
    status.status === 200 && status.body?.count === 6,
    `${status.status} count=${status.body?.count}`);
  check('状态端点点名坏 JSON（语法坏 + 形状坏）',
    errorFiles.includes('broken.json') && errorFiles.includes('not-a-graph.json'),
    JSON.stringify(errorFiles));
  check('meta 里的错值只记诊断、工作流照样注册（退回推断值）',
    status.body?.errors?.some((item) => item.file === 'wrapped.meta.json' && item.code === 'META_INVALID') &&
      status.body.workflows.some(
        (item) => item.id === 'custom-wrapped' && item.outputType === 'images' && item.outputNodeId === '9',
      ),
    JSON.stringify(status.body?.errors?.filter((item) => item.file === 'wrapped.meta.json')));
  check('状态端点列出每个工作流认出来的参数名',
    Array.isArray(status.body?.workflows?.[0]?.params) &&
      status.body.workflows.some((item) => item.id === 'custom-sd-t2i' && item.params.includes('text') && item.params.includes('seed')),
    JSON.stringify(status.body?.workflows?.find((item) => item.id === 'custom-sd-t2i')?.params));

  const sdStatus = status.body?.workflows?.find((item) => item.id === 'custom-sd-t2i');
  check('状态端点直接给出画布节点骨架（排查「节点上少了个字段」用）',
    Array.isArray(sdStatus?.template?.parameters) &&
      sdStatus.template.parameters.some((item) => item.id === 'seed'),
    JSON.stringify(sdStatus?.template && Object.keys(sdStatus.template)));
  check('meta.parameters 的标签/控件类型/上下限覆盖自动推断',
    sdStatus?.template?.parameters?.find((item) => item.id === 'steps')?.label === '迭代步数' &&
      sdStatus?.template?.parameters?.find((item) => item.id === 'steps')?.max === 60 &&
      sdStatus?.template?.parameters?.find((item) => item.id === 'cfg')?.label === 'CFG 强度',
    JSON.stringify(sdStatus?.template?.parameters));
  check('meta.parameters 只给字符串 = 只换标签，控件类型照推断（cfg → number）',
    sdStatus?.template?.parameters?.find((item) => item.id === 'cfg')?.type === 'number');
  check('meta.defaults 原样带进骨架（画布节点初值就是它）',
    sdStatus?.template?.defaults?.steps === 24 && sdStatus?.template?.defaults?.cfg === 6.5,
    JSON.stringify(sdStatus?.template?.defaults));
  check('单个坏 JSON 不影响其它工作流（能力清单照样有 6 个自定义）',
    (await plain('GET', '/workflows')).body.workflows.filter((item) => item.id.startsWith('custom-')).length === 6);

  // ?refresh=1 立刻重扫（平时是 2 秒 TTL；这条也证明缓存开关真的接在端点上）
  rmSync(join(workflowsDir, 'broken.json'));
  const refreshed = await plain('GET', '/custom-workflows?refresh=1');
  check('?refresh=1 立刻重扫并报出目录里的新状态',
    !refreshed.body?.errors?.some((item) => item.file === 'broken.json') &&
      refreshed.body?.count === 6,
    JSON.stringify(refreshed.body?.errors));
  writeFileSync(join(workflowsDir, 'broken.json'), '{ "1": { "inputs": {} ', 'utf8');
}

// ---------------------------------------------------------------- 4. 组装（prepare）

{
  const prepared = await plain('POST', '/prepare/custom-sd-t2i', {
    text: '一只猫在雨里走过霓虹街道',
    negativeText: '模糊, 低质量',
    seed: 42,
    width: 768,
  });
  const graph = prepared.body?.workflow ?? {};
  check('POST /api/comfy/prepare/:id 组装自定义工作流',
    prepared.status === 200 && prepared.body?.ok === true && prepared.body?.workflowType === 'custom-sd-t2i',
    `${prepared.status} ${prepared.text.slice(0, 160)}`);
  check('提示词写进自动推断的正向文本节点', graph['6']?.inputs?.text === '一只猫在雨里走过霓虹街道', String(graph['6']?.inputs?.text));
  check('负向提示词写进自动推断的负向文本节点', graph['7']?.inputs?.text === '模糊, 低质量', String(graph['7']?.inputs?.text));
  check('seed 写进自动绑定的采样节点', graph['3']?.inputs?.seed === 42, String(graph['3']?.inputs?.seed));
  check('meta.defaults 生效（请求没给 steps → 用 24）', graph['3']?.inputs?.steps === 24, String(graph['3']?.inputs?.steps));
  check('meta.defaults 生效（cfg → 6.5）', graph['3']?.inputs?.cfg === 6.5, String(graph['3']?.inputs?.cfg));
  check('请求给的 width 覆盖模板值', graph['5']?.inputs?.width === 768, String(graph['5']?.inputs?.width));
  check('没给的参数保持模板原值', graph['5']?.inputs?.height === 1024, String(graph['5']?.inputs?.height));
  check('回给调用方的元数据带着输出节点与超时',
    prepared.body?.outputNodeId === '9' && prepared.body?.timeoutMs === 300000,
    `${prepared.body?.outputNodeId} / ${prepared.body?.timeoutMs}`);

  const seedRandom = await plain('POST', '/prepare/custom-sd-t2i', { text: 'x', seed: -1 });
  const randomSeed = seedRandom.body?.workflow?.['3']?.inputs?.seed;
  check('seed=-1 按画布约定变成随机整数',
    Number.isInteger(randomSeed) && randomSeed >= 0 && randomSeed !== -1,
    String(randomSeed));

  const noText = await plain('POST', '/prepare/custom-sd-t2i', { negativeText: 'x' });
  check('必填提示词缺失 → 400 + 可读中文',
    noText.status === 400 && String(noText.body?.error).includes('提示词'),
    `${noText.status} ${noText.text.slice(0, 120)}`);

  const badBinding = await plain('POST', '/prepare/custom-bad-binding', { seed: 5 });
  check('绑定目标写错时能报出是哪个键、哪个位址',
    badBinding.status === 500 &&
      badBinding.body?.code === 'INVALID_BINDING' &&
      String(badBinding.body?.error).includes('99'),
    `${badBinding.status} ${badBinding.text.slice(0, 200)}`);

  const unknown = await plain('POST', '/prepare/custom-没这个', {});
  check('未知自定义工作流的 prepare → 404', unknown.status === 404, `${unknown.status}`);

  // 素材：走已有 uploader（host 取 URL 字节 → POST /upload/image → 文件名写回 LoadImage）
  const before = comfy.uploads;
  const i2v = await plain('POST', '/prepare/custom-i2v', {
    text: '一只猫走过雨夜',
    imageUrl: `http://127.0.0.1:${comfyPort}/input/sample.png`,
  });
  check('图生视频组装成功', i2v.status === 200, `${i2v.status} ${i2v.text.slice(0, 160)}`);
  check('参考素材真的上传给了 ComfyUI', comfy.uploads === before + 1, `uploads=${comfy.uploads}`);
  check('上传后的文件名写进 LoadImage.inputs.image',
    i2v.body?.workflow?.['10']?.inputs?.image === 'uploaded-custom.png',
    String(i2v.body?.workflow?.['10']?.inputs?.image));
  check('提示词写进文本节点', i2v.body?.workflow?.['6']?.inputs?.text === '一只猫走过雨夜');

  const alias = await plain('POST', '/prepare/custom-i2v', {
    text: '别名走一遍',
    image: `http://127.0.0.1:${comfyPort}/input/sample.png`,
  });
  check('imageUrl 的别名 image 也认', alias.status === 200 && comfy.uploads === before + 2, `${alias.status}`);

  // 可选对账：先验模板再跑（默认不开，开了就多回一份 resolvedModels）
  const noReconcile = await plain('POST', '/prepare/custom-sd-t2i', { text: '不对账' });
  check('prepare 默认不做对账（行为没变）',
    noReconcile.body?.resolvedModels === undefined &&
      noReconcile.body?.workflow?.['4']?.inputs?.ckpt_name === 'sd_xl_base_1.0.safetensors',
    JSON.stringify(noReconcile.body?.resolvedModels));

  const reconciled = await plain('POST', '/prepare/custom-sd-t2i?reconcile=1', { text: '对账一次' });
  check('prepare?reconcile=1 会做提交前对账并回报替换',
    reconciled.status === 200 &&
      Array.isArray(reconciled.body?.resolvedModels) &&
      reconciled.body.resolvedModels[0]?.to === 'sd_xl_base_1.0_pruned.safetensors' &&
      reconciled.body?.workflow?.['4']?.inputs?.ckpt_name === 'sd_xl_base_1.0_pruned.safetensors',
    JSON.stringify(reconciled.body?.resolvedModels));
}

// ---------------------------------------------------------------- 5. 真跑：组装 → 对账 → 排队 → 落库

let imageUrl = '';
{
  const before = comfy.prompts.length;
  const result = await json('POST', '/comfy/custom-sd-t2i', {
    projectId,
    nodeId: 'node-custom-1',
    text: '一只猫在雨里走过霓虹街道',
    negativeText: '模糊',
    seed: 42,
    generationAttemptId: 'att-custom-1',
  });
  check('画布命名空间下跑自定义工作流返回 200',
    result.status === 200,
    `${result.status} ${result.text.slice(0, 200)}`);
  check('返回 { success: true, url, asset }',
    result.body?.success === true && typeof result.body?.url === 'string',
    JSON.stringify(result.body).slice(0, 200));
  check('返回的 workflowType 是自定义那个',
    result.body?.workflowType === 'custom-sd-t2i',
    String(result.body?.workflowType));
  imageUrl = result.body?.url ?? '';
  check('图片产物落进素材库 images 目录',
    imageUrl.startsWith(`/api/aifisher/canvas/media/${projectId}/images/`),
    imageUrl);
  check('假 ComfyUI 真的收到了 prompt', comfy.prompts.length === before + 1, `prompts=${comfy.prompts.length}`);
  const graph = comfy.prompts[comfy.prompts.length - 1]?.prompt ?? {};
  check('提交的图里带着提示词', graph['6']?.inputs?.text === '一只猫在雨里走过霓虹街道');
  // 模板写的是 sd_xl_base_1.0.safetensors，本机（假 ComfyUI）装的是 ..._pruned
  check('提交前对账对本机模型文件名做了自动替换',
    graph['4']?.inputs?.ckpt_name === 'sd_xl_base_1.0_pruned.safetensors',
    String(graph['4']?.inputs?.ckpt_name));
  check('对账结果回给调用方',
    Array.isArray(result.body?.resolvedModels) && result.body.resolvedModels.length === 1,
    JSON.stringify(result.body?.resolvedModels));

  const status = await json('GET', `/generation-status/node-custom-1?attemptId=att-custom-1`);
  check('结果回收（generation-status）报 success',
    status.body?.status === 'success' && status.body?.resultUrl === imageUrl,
    JSON.stringify(status.body).slice(0, 160));
}

// 视频路径：裸 /api/comfy/<id> 入口 + 参考素材上传 + VHS_VideoCombine 输出
{
  const result = await plain('POST', '/custom-i2v', {
    projectId,
    nodeId: 'node-custom-2',
    text: '一只猫走过雨夜',
    imageUrl: `http://127.0.0.1:${comfyPort}/input/sample.png`,
    generationAttemptId: 'att-custom-2',
  });
  check('裸 /api/comfy/<自定义id> 也能真跑', result.status === 200, `${result.status} ${result.text.slice(0, 200)}`);
  check('视频产物落进素材库 videos 目录',
    String(result.body?.url).startsWith(`/api/aifisher/canvas/media/${projectId}/videos/`),
    String(result.body?.url));
  const graph = comfy.prompts[comfy.prompts.length - 1]?.prompt ?? {};
  check('跑的时候也把参考图上传并写进了 LoadImage',
    graph['10']?.inputs?.image === 'uploaded-custom.png',
    String(graph['10']?.inputs?.image));

  const audio = await plain('POST', '/custom-我的流程', {
    projectId,
    nodeId: 'node-custom-3',
    text: '念一段台词',
    generationAttemptId: 'att-custom-3',
  });
  check('中文 id 的工作流也能通过 URL 调起来', audio.status === 200, `${audio.status} ${audio.text.slice(0, 160)}`);
  check('取回了结果字节（/view 真被调用过）', comfy.viewHits.length >= 3, `viewHits=${comfy.viewHits.length}`);

  const unknown = await plain('POST', '/custom-没这个', { projectId, text: 'x' });
  check('未知自定义 id 的统一入口 → 404 UNKNOWN_WORKFLOW',
    unknown.status === 404 && unknown.body?.code === 'UNKNOWN_WORKFLOW',
    `${unknown.status} ${unknown.text.slice(0, 160)}`);
  check('404 里带着已知清单（含自定义 id）',
    Array.isArray(unknown.body?.known) && unknown.body.known.includes('custom-sd-t2i'),
    JSON.stringify(unknown.body?.known));
}

// ---------------------------------------------------------------- 6. 懒加载：不重启也能看到文件变化

{
  writeFileSync(join(workflowsDir, 'extra.json'), JSON.stringify(EXTRA, null, 2), 'utf8');
  const added = await plain('GET', '/workflows');
  check('新丢进来的 JSON 立刻被识别（不需要重启）',
    added.body.workflows.some((item) => item.id === 'custom-extra'),
    added.body.workflows.map((item) => item.id).join(','));

  rmSync(join(workflowsDir, 'extra.json'));
  const removed = await plain('GET', '/workflows');
  check('删掉文件后也从清单里消失',
    !removed.body.workflows.some((item) => item.id === 'custom-extra'),
    removed.body.workflows.map((item) => item.id).join(','));
}

// ---------------------------------------------------------------- 7. 「ComfyUI 工作流配置」面板的读写接口（v1.16）

{
  // 清单：两个命名空间都要能读（画布前端走 /api/aifisher/canvas/comfy/...）
  const list = await json('GET', '/comfy/workflow-config?refresh=1');
  const ids = (list.body?.configs ?? []).map((item) => item.id);
  check('工作流配置清单能读出来（画布命名空间）',
    list.status === 200 && list.body?.ok === true && ids.includes('custom-sd-t2i') && ids.includes('custom-i2v'),
    `${list.status} ${ids.join(',')}`);
  const sdSummary = (list.body?.configs ?? []).find((item) => item.id === 'custom-sd-t2i');
  check('清单带上「候选字段数 / 已选参数数」（面板左栏的 已选 N/M）',
    typeof sdSummary?.candidateCount === 'number' && sdSummary.candidateCount > 0 &&
      typeof sdSummary?.selectedCount === 'number' && sdSummary.selectedCount > 0,
    JSON.stringify(sdSummary && {
      candidateCount: sdSummary.candidateCount,
      selectedCount: sdSummary.selectedCount,
    }));
  check('清单带上工作流文件名与 meta 文件名（面板要显示写回哪个侧车）',
    sdSummary?.file === 'sd-t2i.json' && sdSummary?.metaFile === 'sd-t2i.meta.json',
    `${sdSummary?.file} / ${sdSummary?.metaFile}`);
  check('裸 /api/comfy/workflow-config 也能读（delegate 白名单放行）',
    (await plain('GET', '/workflow-config')).status === 200);

  // 单个工作流：候选字段 = 模板里写死的每个 input（被连线喂的不算）
  const i2vView = await json('GET', '/comfy/workflow-config/custom-i2v');
  const candidates = i2vView.body?.candidates ?? [];
  const find = (id) => candidates.find((item) => item.id === id);
  check('候选字段里认出 LoadImage 的 image 是素材槽',
    find('10.inputs.image')?.kind === 'media' && find('10.inputs.image')?.key === 'imageUrl',
    JSON.stringify(find('10.inputs.image')));
  check('候选字段里认出 CLIPTextEncode 的 text 是提示词槽',
    find('6.inputs.text')?.kind === 'text' && find('6.inputs.text')?.key === 'text',
    JSON.stringify(find('6.inputs.text')));
  check('候选字段里带上采样参数（seed/steps/cfg 都是数字控件）',
    ['3.inputs.seed', '3.inputs.steps', '3.inputs.cfg'].every(
      (id) => find(id)?.control === 'number' && typeof find(id)?.defaultValue === 'number',
    ),
    JSON.stringify(['3.inputs.seed', '3.inputs.steps', '3.inputs.cfg'].map((id) => find(id) && {
      id,
      control: find(id).control,
      value: find(id).defaultValue,
    })));
  check('被连线喂的字段不进候选清单（KSampler.model 是 ["4",0] 这种连线）',
    !find('3.inputs.model'),
    JSON.stringify(find('3.inputs.model')));
  check('候选字段标出「当前是否已勾选」（推断出来的两条应是勾上的）',
    find('6.inputs.text')?.selected === true && find('10.inputs.image')?.selected === true,
    JSON.stringify({ text: find('6.inputs.text')?.selected, image: find('10.inputs.image')?.selected }));
  check('视图给出「候选字段总数 / 已选数 / 参数与素材槽的分项」',
    i2vView.body?.totals?.fields === candidates.length &&
      typeof i2vView.body?.totals?.parameters === 'number' &&
      typeof i2vView.body?.totals?.media === 'number',
    JSON.stringify(i2vView.body?.totals));

  // 保存：完整状态写回 <file>.meta.json（title + 勾选 + 取消勾选的推断项 + 参数标签）
  const saved = await json('POST', '/comfy/workflow-config/custom-i2v', {
    title: '我的图生视频（配置过）',
    bindings: {
      text: '6.inputs.text',
      imageUrl: '10.inputs.image',
      steps: '3.inputs.steps',
      // cfg 是自动推断出来的：写 null 才是「取消勾选」
      cfg: null,
      seed: null,
    },
    parameters: { steps: { label: '采样步数（自定义）' } },
    defaults: { steps: 18 },
  });
  check('保存配置返回 200 并回新的视图', saved.status === 200 && saved.body?.ok === true,
    `${saved.status} ${saved.text.slice(0, 200)}`);
  check('保存后画布节点名称（meta.title）变了',
    saved.body?.workflow?.title === '我的图生视频（配置过）',
    String(saved.body?.workflow?.title));

  const metaPath = join(workflowsDir, 'i2v.meta.json');
  const metaOnDisk = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
  check('配置真的落到 <file>.meta.json（不是只在内存里）',
    metaOnDisk?.title === '我的图生视频（配置过）' &&
      metaOnDisk?.bindings?.steps === '3.inputs.steps' &&
      metaOnDisk?.bindings?.cfg === null,
    JSON.stringify(metaOnDisk));
  check('参数标签写进 meta.parameters', metaOnDisk?.parameters?.steps?.label === '采样步数（自定义）',
    JSON.stringify(metaOnDisk?.parameters));
  check('默认值写进 meta.defaults', metaOnDisk?.defaults?.steps === 18, JSON.stringify(metaOnDisk?.defaults));

  // 保存后立刻生效：能力清单里的节点骨架跟着变（不用等扫描 TTL）
  const afterCapabilities = await plain('GET', '/capabilities?outputType=videos');
  const i2vCapability = (afterCapabilities.body?.capabilities ?? []).find(
    (item) => item.workflowType === 'custom-i2v',
  );
  check('取消勾选的 cfg 不再长到画布节点上',
    !i2vCapability?.template?.parameters?.some((item) => item.id === 'cfg'),
    JSON.stringify((i2vCapability?.template?.parameters ?? []).map((item) => item.id)));
  check('新勾的 steps 带着自定义标签与默认值出现在节点上',
    i2vCapability?.template?.parameters?.find((item) => item.id === 'steps')?.label === '采样步数（自定义）' &&
      i2vCapability?.template?.parameters?.find((item) => item.id === 'steps')?.default === 18,
    JSON.stringify(i2vCapability?.template?.parameters));

  // 显式关掉提示词：连 requiredInputs 都不该再要求它（面板里取消勾选提示词就是这个语义）
  const noText = await json('POST', '/comfy/workflow-config/custom-i2v', {
    bindings: { text: null, imageUrl: '10.inputs.image' },
  });
  check('显式关掉 text：requiredInputs 不再要求提示词',
    noText.status === 200 && !(noText.body?.workflow?.requiredInputs ?? []).includes('text'),
    JSON.stringify(noText.body?.workflow?.requiredInputs));
  check('显式关掉的键记在 disabled 里（面板重新打开能看到「没勾」）',
    (noText.body?.disabled ?? []).includes('text'),
    JSON.stringify(noText.body?.disabled));
  const noTextCapabilities = await plain('GET', '/capabilities?outputType=videos');
  const noTextI2v = (noTextCapabilities.body?.capabilities ?? []).find(
    (item) => item.workflowType === 'custom-i2v',
  );
  check('关掉 text 之后画布节点上不再有提示词槽',
    !(noTextI2v?.template?.inputs ?? []).some((slot) => slot.id === 'text'),
    JSON.stringify((noTextI2v?.template?.inputs ?? []).map((slot) => slot.id)));

  // 校验：位址写错 / 指向连线字段 / 未知工作流，都要给可读的错误码
  const missingTarget = await json('POST', '/comfy/workflow-config/custom-i2v', {
    bindings: { seed: '99.inputs.seed' },
  });
  check('绑定位址指向不存在的节点 → 422 BINDING_TARGET_MISSING',
    missingTarget.status === 422 && missingTarget.body?.code === 'BINDING_TARGET_MISSING',
    `${missingTarget.status} ${missingTarget.text.slice(0, 200)}`);

  const linkedTarget = await json('POST', '/comfy/workflow-config/custom-i2v', {
    bindings: { frames: '12.inputs.images' },
  });
  check('绑定指向被连线喂的字段 → 422 BINDING_TARGET_LINKED',
    linkedTarget.status === 422 && linkedTarget.body?.code === 'BINDING_TARGET_LINKED',
    `${linkedTarget.status} ${linkedTarget.text.slice(0, 200)}`);

  const badBody = await json('POST', '/comfy/workflow-config/custom-i2v', { bindings: [] });
  check('bindings 不是对象 → 422 INVALID_WORKFLOW_CONFIG',
    badBody.status === 422 && badBody.body?.code === 'INVALID_WORKFLOW_CONFIG',
    `${badBody.status} ${badBody.text.slice(0, 160)}`);

  const unknownWorkflow = await json('GET', '/comfy/workflow-config/custom-没这个');
  check('读未知工作流 → 404 UNKNOWN_WORKFLOW',
    unknownWorkflow.status === 404 && unknownWorkflow.body?.code === 'UNKNOWN_WORKFLOW',
    `${unknownWorkflow.status}`);

  // 保存必须保留 meta.json 里的其它字段（timeoutMs / category 这些面板不管的）
  const sdSaved = await json('POST', '/comfy/workflow-config/custom-sd-t2i', {
    bindings: {
      text: '6.inputs.text',
      negativeText: '7.inputs.text',
      steps: '3.inputs.steps',
    },
  });
  const sdMeta = JSON.parse(readFileSync(join(workflowsDir, 'sd-t2i.meta.json'), 'utf8'));
  check('保存时保留 meta.json 里面板不管的字段（timeoutMs / category）',
    sdSaved.status === 200 && sdMeta.timeoutMs === 300000 && sdMeta.category === 'custom-t2i',
    JSON.stringify({ timeoutMs: sdMeta.timeoutMs, category: sdMeta.category }));
  check('保存后 meta.bindings 是整份替换（只剩这次勾的三条）',
    JSON.stringify(Object.keys(sdMeta.bindings ?? {}).sort()) ===
      JSON.stringify(['negativeText', 'steps', 'text'].sort()),
    JSON.stringify(Object.keys(sdMeta.bindings ?? {})));
  check('没勾选、也没被取消的推断项照旧生效（width/height 仍在节点参数里）',
    ['width', 'height'].every((key) => (sdSaved.body?.bindings ?? []).some((item) => item.key === key)),
    JSON.stringify((sdSaved.body?.bindings ?? []).map((item) => item.key)));
}

// ---------------------------------------------------------------- 8. v1.20：字符串节点提示词 + ComfyUI 枚举下拉

{
  // ---- 8.1 提示词落点：PrimitiveStringMultiline.value（不是 CLIPTextEncode.text）
  const status = await plain('GET', '/custom-workflows?refresh=1');
  const entry = (status.body?.workflows ?? []).find((item) => item.id === 'custom-string-t2i');
  check('字符串节点的 value 被认成提示词（旧版会判成「不需要提示词」）',
    entry?.promptNodeId === '70' && entry?.promptTarget === '70.inputs.value',
    JSON.stringify({ promptNodeId: entry?.promptNodeId, promptTarget: entry?.promptTarget }));
  check('负向提示词也认到上游那个字符串节点（按节点标题判断正负）',
    entry?.negativePromptTarget === '72.inputs.value',
    JSON.stringify({
      negativePromptNodeId: entry?.negativePromptNodeId,
      negativePromptTarget: entry?.negativePromptTarget,
    }));
  check('提示词仍然是必填输入（画布节点会显示提示词框与文本槽）',
    Array.isArray(entry?.requiredInputs) && entry.requiredInputs.includes('text'),
    JSON.stringify(entry?.requiredInputs));

  const images = await plain('GET', '/capabilities?outputType=images');
  const capability = (images.body?.capabilities ?? []).find(
    (item) => item.workflowType === 'custom-string-t2i',
  );
  const template = capability?.template ?? {};
  check('画布节点骨架里 textParameter 有值（节点不再显示「这个工作流不需要提示词」）',
    template.textParameter === 'text',
    JSON.stringify({ textParameter: template.textParameter }));
  check('文本输入槽排在最前、标签沿用 meta 里的「正面提示词」',
    template.inputs?.[0]?.id === 'text' && template.inputs?.[0]?.label === '正面提示词',
    JSON.stringify(template.inputs));
  check('老 meta 里绑到同一字段的别名键（value / value2）被并进 text / negativeText',
    !template.parameters?.some((item) => item.id === 'value' || item.id === 'value2') &&
      !template.parameters?.some((item) => item.id === 'negativeText'),
    JSON.stringify((template.parameters ?? []).map((item) => item.id)));
  // v1.21：负向提示词从「参数控件」升级成**文本输入槽**——文本节点能接进去
  //（用户原话：「comfui 节点还不能把文本输入接入负面提示词」）
  check('负向提示词是一个 text 输入槽（紧跟在正向槽后面，标签沿用 meta）',
    template.negativeTextParameter === 'negativeText' &&
      template.inputs?.[1]?.id === 'negativeText' &&
      template.inputs?.[1]?.type === 'text' &&
      template.inputs?.[1]?.label === '负面提示词',
    JSON.stringify({
      negativeTextParameter: template.negativeTextParameter,
      inputs: (template.inputs ?? []).slice(0, 2),
    }));
  check('负向提示词槽不是必填（不接文本节点时节点上有输入框兜底）',
    template.inputs?.[1]?.required === false,
    JSON.stringify(template.inputs?.[1]));

  const prepared = await plain('POST', '/prepare/custom-string-t2i', {
    text: '正面写进字符串节点',
    negativeText: '负面也写进字符串节点',
    seed: 5,
  });
  const graph = prepared.body?.workflow ?? {};
  check('提示词写进 PrimitiveStringMultiline.inputs.value',
    prepared.status === 200 && graph['70']?.inputs?.value === '正面写进字符串节点',
    `${prepared.status} ${String(graph['70']?.inputs?.value)}`);
  check('负向提示词写进另一个字符串节点的 value',
    graph['72']?.inputs?.value === '负面也写进字符串节点',
    String(graph['72']?.inputs?.value));
  check('字符串节点被连线喂的 CLIPTextEncode 没被顶掉',
    Array.isArray(graph['77']?.inputs?.text) && graph['77'].inputs.text[0] === '70',
    JSON.stringify(graph['77']?.inputs?.text));

  // ---- 8.2 ComfyUI 枚举候选（/object_info → 下拉）
  const options = await plain('GET', '/widget-options?refresh=1');
  check('扫描 ComfyUI 的 /object_info 成功，并回报扫到多少个下拉字段',
    options.status === 200 && options.body?.ok === true && Number(options.body?.fields) >= 2,
    JSON.stringify({ ok: options.body?.ok, fields: options.body?.fields }));
  check('lora 候选列表来自 ComfyUI（不是死的）',
    (options.body?.classes?.LoraLoader?.lora_name?.options ?? []).includes('detail-tweaker.safetensors'),
    JSON.stringify(options.body?.classes?.LoraLoader?.lora_name));
  check('数值字段也带上 ComfyUI 的上下限（滑块/数字框能夹住）',
    options.body?.classes?.LoraLoader?.strength_model?.min === -10,
    JSON.stringify(options.body?.classes?.LoraLoader?.strength_model));
  check('快照落盘到 storages（ComfyUI 没开时还能用上次那份）',
    existsSync(join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'comfy-widget-options.json')),
    join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'comfy-widget-options.json'));
  check('画布命名空间也能读候选值（delegate 白名单放行）',
    (await json('GET', '/comfy/widget-options')).status === 200);

  // 有了快照之后，画布骨架里的 lora 参数变成下拉（候选 = ComfyUI 扫到的那些）
  const withOptions = await plain('GET', '/capabilities?outputType=images');
  const stringCapability = (withOptions.body?.capabilities ?? []).find(
    (item) => item.workflowType === 'custom-string-t2i',
  );
  const lora = (stringCapability?.template?.parameters ?? []).find((item) => item.id === 'lora_name');
  check('lora 参数在画布节点上变成 select，并带上 ComfyUI 的候选',
    lora?.type === 'select' &&
      (lora.options ?? []).length === 3 &&
      (lora.options ?? []).some((option) => option.value === 'detail-tweaker.safetensors'),
    JSON.stringify(lora));
  check('参数带上 ComfyUI 落点（classType/field），节点自己能再查一次候选',
    lora?.classType === 'LoraLoader' && lora?.field === 'lora_name',
    JSON.stringify({ classType: lora?.classType, field: lora?.field }));

  // 面板候选：同一个字段也要能告诉用户「这是下拉、候选从哪来」
  const view = await json('GET', '/comfy/workflow-config/custom-string-t2i');
  const candidates = view.body?.candidates ?? [];
  const find = (id) => candidates.find((item) => item.id === id);
  check('面板候选把字符串节点标成提示词（kind=text、建议键 text）',
    find('70.inputs.value')?.kind === 'text' && find('70.inputs.value')?.key === 'text',
    JSON.stringify(find('70.inputs.value')));
  check('面板候选里负向提示词的标签沿用老 meta（负面提示词）',
    find('72.inputs.value')?.kind === 'negativeText' && find('72.inputs.value')?.label === '负面提示词',
    JSON.stringify(find('72.inputs.value')));
  check('面板候选里 lora 字段是下拉 + 候选来自 ComfyUI 扫描',
    find('76.inputs.lora_name')?.control === 'select' &&
      find('76.inputs.lora_name')?.optionsSource === 'comfyui' &&
      (find('76.inputs.lora_name')?.options ?? []).length === 3,
    JSON.stringify(find('76.inputs.lora_name')));

  // 面板保存 = 把老别名键正式换名：bindings 里只剩 text/negativeText
  const renamed = await json('POST', '/comfy/workflow-config/custom-string-t2i', {
    title: '字符串节点提示词（配置过）',
    bindings: {
      text: '70.inputs.value',
      negativeText: '72.inputs.value',
      lora_name: '76.inputs.lora_name',
    },
    parameters: { text: { label: '正面提示词' } },
  });
  const stringMeta = JSON.parse(readFileSync(join(workflowsDir, 'string-t2i.meta.json'), 'utf8'));
  const metaKeys = Object.keys(stringMeta.bindings ?? {});
  check('面板保存后老别名键被正式换名（只剩 text / negativeText，不再有 value / value2）',
    renamed.status === 200 &&
      metaKeys.includes('text') &&
      metaKeys.includes('negativeText') &&
      !metaKeys.includes('value') &&
      !metaKeys.includes('value2'),
    JSON.stringify(metaKeys));
}

// ---------------------------------------------------------------- 收尾

comfyServer.close();
console.log(lines.join('\n'));
const pass = lines.length - failures;
console.log(`\nSUMMARY pass=${pass} fail=${failures}`);
process.exit(failures === 0 ? 0 : 1);
