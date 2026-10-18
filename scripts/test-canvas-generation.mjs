/**
 * 本地工作流生成闭环回归测试（host 半 + 假 ComfyUI）。
 *
 * 覆盖这条链路：
 *   画布「ComfyUI 节点 → 生成」
 *     → POST /api/aifisher/canvas/comfy/minimax-h3-t2va   （vendor 改写后的路径）
 *     → 组装 prompt 图（模板 JSON + 参数改写 + 参考素材上传）
 *     → 提交 ComfyUI /prompt → 轮询 /history → /view 取字节
 *     → 落素材库（media/<projectId>/videos/…）
 *     → 返回 { success, url, asset }
 *   以及配套的：素材上传/列表/删除/取回、结果回收（generation-status）、取消、同源围栏。
 *
 * 假 ComfyUI 是一个真的 node:http 服务：只实现用到的 6 个端点，按 prompt 里的文本决定
 * 「立刻完成」还是「永远不完成」（后者用于取消用例）。
 *
 * 用法：node scripts/test-canvas-generation.mjs   （需要先 build）
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ORIGIN, ROOT, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 一段假的 mp4 字节（含 ftyp box 的味道不重要，只验证「原样落盘」）。 */
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(64, 0x11),
]);
/** 1x1 PNG（素材上传用）。 */
const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------- 假 ComfyUI
const TEMPLATE = JSON.parse(
  readFileSync(join(ROOT, 'src/host/comfyui/workflows/MiniMax-H3-T2VA-api.json'), 'utf8'),
);

/**
 * 假 /object_info：节点类型照模板真实需要的那些，模型候选名故意用「这台机器上真实的文件名」
 * ——它们与模板里写的不一样（多了 pruned、量化后缀不同），用来验证提交前对账能自动替换。
 */
function buildObjectInfo(mode = 'normal') {
  const info = {};
  for (const node of Object.values(TEMPLATE)) {
    const classType = node.class_type;
    if (!classType || info[classType]) continue;
    info[classType] = { input: { required: {} } };
  }
  if (mode === 'missing-node') delete info['MiniMaxH3AudioConditioningT8'];
  info.UNETLoader.input.required.unet_name = [
    mode === 'missing-model'
      ? ['wan2.2_t2v_high_noise.safetensors']
      : ['minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
    { tooltip: 'diffusion_models' },
  ];
  info.CLIPLoader.input.required.clip_name = [
    ['qwen3vl_32b_minimax_h3_int8_convrot.safetensors'],
    { tooltip: 'text_encoders' },
  ];
  info.VAELoader.input.required.vae_name = [
    ['minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors'],
    { tooltip: 'vae' },
  ];
  return info;
}

const comfy = {
  prompts: [],
  uploads: 0,
  viewHits: [],
  historyCalls: 0,
  interrupt: 0,
  queueDeletes: [],
  objectInfoCalls: 0,
  /** object_info 的应答模式：normal / missing-node / missing-model */
  objectInfoMode: 'normal',
  /** 记下每个 prompt 的 id → 是否永不完成（用提示词里的「取消」当标记） */
  stalled: new Set(),
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
      return json(buildObjectInfo(comfy.objectInfoMode));
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const parsed = JSON.parse(body.toString('utf8'));
      comfy.prompts.push(parsed);
      const id = `p${comfy.prompts.length}`;
      const text = String(parsed?.prompt?.['234']?.inputs?.value ?? '');
      if (text.includes('取消')) comfy.stalled.add(id);
      return json({ prompt_id: id, number: comfy.prompts.length, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) {
      comfy.historyCalls += 1;
      const id = url.pathname.split('/')[2];
      if (comfy.stalled.has(id)) return json({});
      return json({
        [id]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: {
            '303': {
              gifs: [{ filename: 'MiniMax_out.mp4', subfolder: '', type: 'output' }],
            },
          },
        },
      });
    }
    if (url.pathname === '/view') {
      comfy.viewHits.push(url.search);
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': FAKE_MP4.length });
      return res.end(FAKE_MP4);
    }
    if (url.pathname === '/upload/image') {
      comfy.uploads += 1;
      return json({ name: 'uploaded-ref.png', subfolder: '', type: 'input' });
    }
    if (url.pathname === '/interrupt') {
      comfy.interrupt += 1;
      return json({});
    }
    if (url.pathname === '/queue') {
      comfy.queueDeletes.push(JSON.parse(body.toString('utf8') || '{}'));
      return json({});
    }
    return json({ error: 'not found', path: url.pathname }, 404);
  });
});
await new Promise((done) => comfyServer.listen(0, '127.0.0.1', done));
const comfyPort = comfyServer.address().port;
process.env.COMFYUI_URL = `http://127.0.0.1:${comfyPort}`;
process.env.AIFISHER_COMFY_POLL_MS = '40';
// 对账结果默认缓存 5 分钟；测试里要来回切 object_info 的应答，所以关掉缓存
process.env.AIFISHER_COMFY_OBJECT_INFO_TTL_MS = '0';

// ---------------------------------------------------------------- 起插件宿主
const host = await startHost();

/** 走真实路由的原始 body 请求（素材上传、Range 取文件用）。 */
class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
  }
  writeHead(status, headers) {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    callback();
  }
  buffer() {
    return Buffer.concat(this.chunks);
  }
  text() {
    return this.buffer().toString('utf8');
  }
}

async function dispatchRaw(method, pathname, payload, headers = {}) {
  let route = null;
  for (const [prefix, candidate] of host.routes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      if (!route || prefix.length > route.prefix.length) route = { prefix, handler: candidate.handler };
    }
  }
  if (!route) return { status: 404, text: () => '', buffer: () => Buffer.alloc(0), headers: {} };
  const req = Readable.from(payload === undefined ? [] : [payload]);
  req.method = method;
  req.url = pathname;
  req.headers = { host: new URL(ORIGIN).host, origin: ORIGIN, ...headers };
  const res = new FakeResponse();
  await route.handler(req, res);
  if (!res.writableFinished) await new Promise((done) => res.once('finish', done));
  return res;
}

const api = (method, path, body) => host.hostApi(method, path, body);
const json = async (method, path, body) => {
  const res = await api(method, path, body);
  let parsed = null;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
};

const projectId = 'proj-gen-1';
const nodeId = 'node-gen-1';

// ---------------------------------------------------------------- 1. 能力清单
{
  const direct = await json('GET', '/comfy/capabilities?outputType=videos');
  check('画布命名空间下能取到能力清单', direct.status === 200 && Array.isArray(direct.body?.capabilities), `${direct.status}`);
  const capability = direct.body?.capabilities?.[0];
  check(
    '能力清单里的工作流是 minimax-h3-t2va',
    capability?.workflowType === 'minimax-h3-t2va',
    String(capability?.workflowType),
  );
  check(
    '能力清单带 modes（画布要用它渲染模式下拉）',
    Array.isArray(capability?.modes) && capability.modes.includes('t2va'),
    JSON.stringify(capability?.modes),
  );
  const plain = await host.dispatch('GET', '/api/comfy/capabilities');
  check('裸 /api/comfy/capabilities 也通', plain.status === 200, String(plain.status));
  const ping = await host.dispatch('GET', '/api/comfy/ping');
  check('ComfyUI ping 报告在线', ping.status === 200 && JSON.parse(ping.body).online === true);
}

// ---------------------------------------------------------------- 2. 文生视频全链路
let generatedUrl = '';
{
  const started = Date.now();
  const result = await json('POST', '/comfy/minimax-h3-t2va', {
    projectId,
    nodeId,
    text: '一只猫在雨里走过霓虹街道',
    mode: 't2va',
    aspectRatio: '16:9',
    duration: 8,
    megapixels: 0.4,
    generationAttemptId: 'att-1',
  });
  check('本地工作流生成返回 200', result.status === 200, `${result.status} ${result.text ?? ''}`);
  check('返回 { success: true, url }', result.body?.success === true && typeof result.body?.url === 'string');
  generatedUrl = result.body?.url ?? '';
  check(
    '素材 URL 落在本插件媒体命名空间下',
    generatedUrl.startsWith(`/api/aifisher/canvas/media/${projectId}/videos/`),
    generatedUrl,
  );
  check('返回的 asset 带 nodeId 与来源', result.body?.asset?.nodeId === nodeId && result.body?.asset?.source === 'generation');
  check('假 ComfyUI 真的收到了 prompt', comfy.prompts.length === 1, `prompts=${comfy.prompts.length}`);
  const graph = comfy.prompts[0]?.prompt ?? {};
  check('提示词写进了模板的文本节点 234', graph['234']?.inputs?.value === '一只猫在雨里走过霓虹街道');
  check('模式 T2VA 写进了条件节点 307', graph['307']?.inputs?.task_type === 'T2VA');
  check('时长写进了节点 236', Number(graph['236']?.inputs?.value) === 8);
  // 模板里写的是 ..._fl2va_int8_... / ..._nvfp4_awq，本机（假 ComfyUI）装的是别的量化版本
  check(
    '模型文件名自动对账（unet）',
    graph['227']?.inputs?.unet_name === 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    String(graph['227']?.inputs?.unet_name),
  );
  check(
    '模型文件名自动对账（clip）',
    graph['238']?.inputs?.clip_name === 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
    String(graph['238']?.inputs?.clip_name),
  );
  check(
    '对账结果回报给调用方',
    Array.isArray(result.body?.resolvedModels) && result.body.resolvedModels.length === 2,
    JSON.stringify(result.body?.resolvedModels),
  );
  check('VAE 文件名本来就一致，不该出现在替换里', !JSON.stringify(result.body?.resolvedModels ?? []).includes('vae_name'));
  check('轮询过 history', comfy.historyCalls >= 1, `calls=${comfy.historyCalls}`);
  check('取过 /view 结果字节', comfy.viewHits.length === 1, JSON.stringify(comfy.viewHits));
  check('全链路耗时在可控范围（异步轮询真的在退避）', Date.now() - started < 5000, `${Date.now() - started}ms`);

  // 素材文件真的能取回来，且字节完全一致
  const file = await dispatchRaw('GET', generatedUrl);
  check('生成的素材能取回', file.statusCode === 200, `${file.statusCode}`);
  check('取回的字节与 ComfyUI 输出一致', Buffer.compare(file.buffer(), FAKE_MP4) === 0, `${file.buffer().length}B`);
  check('素材 MIME 是 video/mp4', file.headers['content-type'] === 'video/mp4', String(file.headers['content-type']));

  const ranged = await dispatchRaw('GET', generatedUrl, undefined, { range: 'bytes=4-11' });
  check('素材支持 Range（视频拖进度条）', ranged.statusCode === 206, `${ranged.statusCode}`);
  check('Range 响应带 content-range', String(ranged.headers['content-range'] ?? '').startsWith('bytes 4-11/'), String(ranged.headers['content-range']));

  const missing = await dispatchRaw('GET', `/api/aifisher/canvas/media/${projectId}/videos/nope.mp4`);
  check('不存在的素材返回 404', missing.statusCode === 404, `${missing.statusCode}`);
}

// ---------------------------------------------------------------- 3. 结果回收（日记 + 素材兜底）
{
  const status = await json('GET', `/generation-status/${nodeId}?attemptId=att-1`);
  check('generation-status 报 success', status.status === 200 && status.body?.status === 'success', JSON.stringify(status.body));
  check('generation-status 带 resultUrl', status.body?.resultUrl === generatedUrl, String(status.body?.resultUrl));

  const stale = await json('GET', `/generation-status/${nodeId}?attemptId=att-OLD`);
  check('attemptId 对不上时报 missing（旧 UI 不能覆盖新结果）', stale.body?.status === 'missing', JSON.stringify(stale.body));
}

// ---------------------------------------------------------------- 4. 素材上传 / 列表 / 兜底恢复 / 删除
{
  const upload = await dispatchRaw('POST', '/api/aifisher/canvas/assets/upload/images', FAKE_PNG, {
    'content-type': 'image/png',
    'x-filename': encodeURIComponent('参考图.png'),
    'x-project-id': projectId,
    'x-node-id': 'node-fallback',
  });
  const uploaded = JSON.parse(upload.text());
  check('素材上传返回 url', upload.statusCode === 200 && typeof uploaded.url === 'string', `${upload.statusCode} ${upload.text().slice(0, 120)}`);
  const uploadedUrl = uploaded.url;
  check('上传素材按 at 类型进 images 目录', uploadedUrl.includes(`/media/${projectId}/images/`), uploadedUrl);

  const fetched = await dispatchRaw('GET', uploadedUrl);
  check('上传的素材能取回', fetched.statusCode === 200 && Buffer.compare(fetched.buffer(), FAKE_PNG) === 0);

  const list = await json('GET', `/assets/images?projectId=${projectId}&limit=20&offset=0`);
  check('素材列表返回 assets/total/hasMore', Array.isArray(list.body?.assets) && list.body?.total === 1, JSON.stringify(list.body).slice(0, 160));
  check('列表里的素材带原始文件名', list.body?.assets?.[0]?.originalName === '参考图.png', String(list.body?.assets?.[0]?.originalName));

  // 日记里没有这个节点的任务 → 走「素材库反查」兜底（上游 findLatestMediaResult 同款）
  const fallback = await json('GET', '/generation-status/node-fallback');
  check('没有任务日记时从素材库反查到结果', fallback.body?.status === 'success' && fallback.body?.resultUrl === uploadedUrl, JSON.stringify(fallback.body).slice(0, 160));

  const empty = await json('GET', '/generation-status/node-never-existed');
  check('两条路都查不到时报 missing', empty.body?.status === 'missing', JSON.stringify(empty.body));

  // ---------------------------------------------------------------- 4.1 编辑结果落盘（「保存为新图片」那条链）
  //
  // 2026-10-17 用户报障：「点击保存为新图片没有添加到画布里」，画布上状态行还显示
  // `method not allowed`。根因在 mediaRouter 的列表分支：`GET/POST /assets/<kind>s`
  // 共用同一个 if，非 GET 直接被判 405 —— 而裁剪/标注/组合的图片正是 **POST data URL**
  // 到这个路径。这里走的是完整链路（data URL → 落盘 → 返回 url），列表分支再吞掉 POST 就必红。
  {
    const dataUrl = `data:image/png;base64,${FAKE_PNG.toString('base64')}`;
    const saved = await json('POST', '/assets/images', {
      data: dataUrl,
      prompt: '裁切',
      projectId,
    });
    check(
      'POST /assets/images 接受 data URL（「保存为新图片」不再 405）',
      saved.status === 200 && typeof saved.body?.url === 'string',
      `${saved.status} ${JSON.stringify(saved.body).slice(0, 140)}`,
    );
    check(
      'data URL 落盘的素材进 images 目录',
      typeof saved.body?.url === 'string' && saved.body.url.includes(`/media/${projectId}/images/`),
      String(saved.body?.url),
    );
    const fetched = await dispatchRaw('GET', saved.body?.url ?? '/nope');
    check(
      '落盘后的编辑结果能原样取回',
      fetched.statusCode === 200 && Buffer.compare(fetched.buffer(), FAKE_PNG) === 0,
      `${fetched.statusCode} ${fetched.buffer().length}B`,
    );
    const listed = await json('GET', `/assets/images?projectId=${projectId}`);
    check(
      '列表里能看到刚落盘的编辑结果',
      listed.body?.total === 2,
      JSON.stringify(listed.body).slice(0, 140),
    );
    const wrongMethod = await json('PUT', '/assets/images', { data: dataUrl });
    check('列表路径上的其它方法仍是 405（只放行 POST 落盘）', wrongMethod.status === 405,
      `${wrongMethod.status}`);
    const notDataUrl = await json('POST', '/assets/images', { data: 'not-a-data-url' });
    check('data 不是 data URL 时仍是 422', notDataUrl.status === 422, `${notDataUrl.status}`);
  }

  const removed = await json('DELETE', `/assets/images/${encodeURIComponent(list.body.assets[0].id)}?projectId=${projectId}`);
  check('删除素材返回成功回执', removed.status === 200 && removed.body?.success === true, `${removed.status}`);
  const after = await json('GET', `/assets/images?projectId=${projectId}`);
  // 上面 4.1 又存了一张，所以删掉一张后应该还剩一张
  check('删除后列表只剩一张（4.1 落盘的那张还在）', after.body?.total === 1, JSON.stringify(after.body));
}

// ---------------------------------------------------------------- 5. 参考素材走本机媒体（画布内素材 → ComfyUI 上传）
{
  const upload = await dispatchRaw('POST', '/api/aifisher/canvas/assets/upload/images', FAKE_PNG, {
    'content-type': 'image/png',
    'x-filename': 'ref2.png',
    'x-project-id': projectId,
  });
  const uploadedUrl = JSON.parse(upload.text()).url;
  const before = comfy.uploads;
  const prepared = await json('POST', '/comfy/prepare/minimax-h3-t2va', {
    text: '角色转身 <Picture 1>',
    mode: 'ref2va',
    referenceImageUrls: [uploadedUrl],
    aspectRatio: '9:16',
    duration: 5,
  });
  check('动态组装（ref2va）返回 200', prepared.status === 200, `${prepared.status} ${JSON.stringify(prepared.body).slice(0, 160)}`);
  check('画布内素材被直接读盘上传给了 ComfyUI', comfy.uploads === before + 1, `uploads=${comfy.uploads}`);
  const graph = prepared.body?.workflow ?? {};
  check('参考图被挂到条件节点的动态输入上', graph['307']?.inputs?.['ref_images.ref_image_0']?.[0] === '330', JSON.stringify(graph['307']?.inputs?.['ref_images.ref_image_0']));
  check('参考图节点用的是上传后的文件名', graph['330']?.inputs?.image === 'uploaded-ref.png', String(graph['330']?.inputs?.image));
  check('提示词里的 @图片1 已被规范化', String(graph['234']?.inputs?.value) === '角色转身 <Picture 1>', String(graph['234']?.inputs?.value));
}

// ---------------------------------------------------------------- 6. 取消
{
  const cancelNode = 'node-cancel-1';
  const pending = api('POST', '/comfy/minimax-h3-t2va', {
    projectId,
    nodeId: cancelNode,
    text: '取消：这段永远不会完成',
    mode: 't2va',
    aspectRatio: '16:9',
    duration: 8,
    generationAttemptId: 'att-cancel',
  });
  // 等它排上队（假 ComfyUI 把带「取消」的 prompt 标成永不完成 → 执行器会一直轮询）
  const queuedBefore = comfy.stalled.size;
  for (let i = 0; i < 60 && comfy.stalled.size === queuedBefore; i += 1) await sleep(25);
  const running = await json('GET', `/generation-status/${cancelNode}`);
  check('执行中的任务报 pending', running.body?.status === 'pending', JSON.stringify(running.body));

  const cancelled = await json('POST', `/generation-cancel/${cancelNode}`, { attemptId: 'att-cancel' });
  check('取消请求被接受', cancelled.status === 200 && cancelled.body?.success === true, `${cancelled.status} ${JSON.stringify(cancelled.body)}`);
  check('取消时通知了 ComfyUI 中断', comfy.interrupt >= 1, `interrupt=${comfy.interrupt}`);
  check('取消时清了 ComfyUI 队列', comfy.queueDeletes.length >= 1, JSON.stringify(comfy.queueDeletes));

  const result = await pending;
  const parsed = JSON.parse(result.text);
  check('被取消的生成以 409 + GENERATION_CANCELLED 结束', result.status === 409 && parsed.code === 'GENERATION_CANCELLED', `${result.status} ${result.text.slice(0, 120)}`);

  const after = await json('GET', `/generation-status/${cancelNode}?attemptId=att-cancel`);
  check('取消后的状态是 cancelled', after.body?.status === 'cancelled', JSON.stringify(after.body));

  const wrongAttempt = await json('POST', `/generation-cancel/${cancelNode}`, { attemptId: 'att-OTHER' });
  check('用错 attemptId 取消会被拒', wrongAttempt.status === 409, `${wrongAttempt.status}`);
}

// ---------------------------------------------------------------- 7. 参数校验 / 同源围栏 / 未移植路径
{
  const noText = await json('POST', '/comfy/minimax-h3-t2va', { projectId, mode: 't2va' });
  check('缺提示词 → 400', noText.status === 400, `${noText.status} ${JSON.stringify(noText.body)}`);

  const badMode = await json('POST', '/comfy/minimax-h3-t2va', { projectId, text: 'x', mode: 'nope' });
  check('非法模式 → 400', badMode.status === 400, `${badMode.status}`);

  const unknown = await json('POST', '/comfy/not-a-workflow', { projectId, text: 'x' });
  check('未知工作流 → 404', unknown.status === 404, `${unknown.status}`);

  const cross = await dispatchRaw('POST', '/api/aifisher/canvas/comfy/minimax-h3-t2va', Buffer.from('{}'), {
    origin: 'http://evil.example',
  });
  check('跨站 Origin 调生成被 403', cross.statusCode === 403, `${cross.statusCode}`);

  const notPorted = await json('GET', '/storyboard/anything');
  check('未移植能力仍返回 501 NOT_PORTED', notPorted.status === 501 && notPorted.body?.code === 'NOT_PORTED', `${notPorted.status}`);

  const concurrency = await json('GET', '/generation-concurrency?modelName=MiniMax%20H3&mode=t2va');
  check('并发查询返回不阻塞', concurrency.status === 200 && concurrency.body?.blocked === false, `${concurrency.status}`);
}

// ---------------------------------------------------------------- 8. 提交前对账（缺节点 / 缺模型）
{
  comfy.objectInfoMode = 'missing-node';
  const nodeMissing = await json('POST', '/comfy/minimax-h3-t2va', {
    projectId,
    nodeId: 'node-missing-node',
    text: '缺节点用例',
    mode: 't2va',
  });
  check(
    '缺自定义节点 → 409 + COMFY_NODE_MISSING 并点名缺哪个',
    nodeMissing.status === 409 &&
      nodeMissing.body?.code === 'COMFY_NODE_MISSING' &&
      String(nodeMissing.body?.error).includes('MiniMaxH3AudioConditioningT8'),
    `${nodeMissing.status} ${JSON.stringify(nodeMissing.body).slice(0, 200)}`,
  );

  comfy.objectInfoMode = 'missing-model';
  const modelMissing = await json('POST', '/comfy/minimax-h3-t2va', {
    projectId,
    nodeId: 'node-missing-model',
    text: '缺模型用例',
    mode: 't2va',
  });
  check(
    '缺模型 / 文件名对不上且无法唯一匹配 → 409 + COMFY_MODEL_MISSING',
    modelMissing.status === 409 && modelMissing.body?.code === 'COMFY_MODEL_MISSING',
    `${modelMissing.status} ${JSON.stringify(modelMissing.body).slice(0, 240)}`,
  );
  check('对账失败时不会把任务丢给 ComfyUI', comfy.prompts.length === 2, `prompts=${comfy.prompts.length}`);
  comfy.objectInfoMode = 'normal';
}

// ---------------------------------------------------------------- 收尾
comfyServer.close();
console.log(lines.join('\n'));
const pass = lines.length - failures;
console.log(`\nSUMMARY pass=${pass} fail=${failures}`);
process.exit(failures === 0 ? 0 : 1);
