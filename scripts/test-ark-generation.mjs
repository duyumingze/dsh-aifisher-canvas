/**
 * 火山方舟（豆包）图片生成回归（scripts/test-ark-generation.mjs）。
 *
 * 全程用**真 HTTP 的假方舟**：一个 http 服务同时扮演 `POST /api/v3/images/generations`
 * 和结果图床（方舟返回的 url 24 小时失效，host 半必须立刻把它下载进素材库）。
 *
 * 验的是「画布的 AIFISHER 形状请求 → 方舟形状请求 → 结果落素材库」这条翻译链：
 *   - 按模型名分发：目录里标着方舟直连的模型走方舟；别的模型仍然走通用云端端点
 *   - 请求翻译：model / prompt / size（档位+宽高比 → 宽x高，越界夹取并说明）/ response_format /
 *     watermark / output_format / sequential_image_generation / layer_decomposition
 *   - 参考图：本站素材 URL → data:image/png;base64,…（方舟访问不到 127.0.0.1）
 *   - 结果：url 下载落盘（扩展名跟着方舟的 output_format）、b64_json 直接落盘、多张并入 resultUrls
 *   - 组图：5.0 pro 不支持 sequential → 并发 N 次请求；5.0 lite 支持 → 一次请求带 max_images
 *   - 错误：未配 Key 501、鉴权 401 / 模型未开通 404 / 500 / 顶层 error / 认不出的形状 / 端点不可达
 *   - 设置页：/generation/sources 多一张方舟卡片、密钥只回布尔量、模型可用性按来源标记
 *   - 模型 ID 覆盖：界面的「自定义模型 ID」（MODEL_ID_CUSTOM_<码点>）真的改掉发出去的 model
 *
 * 用法：node scripts/test-ark-generation.mjs
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startHost, ROOT } from './lib/canvas-harness.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL  ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

/** 1x1 透明 PNG（真字节：验落盘内容确实来自「方舟」）。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const MODEL_5_PRO = '豆包图片5.0-pro(方舟直连)';
const MODEL_5_LITE = '豆包图片5.0-lite';
const MODEL_4_5 = '豆包图片4.5(多参考)';
const ARK_5_PRO_ID = 'doubao-seedream-5-0-pro-260628';

// ---------------------------------------------------------------------------
// 假方舟：生成端点 + 结果图床（顺带扮演通用云端端点，验两条路互不串线）
// ---------------------------------------------------------------------------
const received = [];
let resultSeq = 0;

const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    received.push({ url: req.url, method: req.method, headers: req.headers, body });

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && /^\/result-\d+\.png$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_BYTES);
      return;
    }

    // 通用云端端点（不是方舟）：返回 OpenAI 形状，用来反证「没被方舟接管」
    if (req.url === '/v1/images/generations') {
      json(200, { created: 1, data: [{ url: `${base}/result-999.png` }] });
      return;
    }

    if (req.url === '/api/v3/images/generations') {
      const model = String(body?.model ?? '');
      if (model.includes('boom-401')) return json(401, { error: { code: 'AuthenticationError', message: 'invalid api key' } });
      if (model.includes('modelnotopen')) return json(404, { error: { code: 'ModelNotOpen', message: 'the model has not been opened' } });
      if (model.includes('boom-500')) return json(500, { error: { message: '方舟内部错误' } });
      if (model.includes('toperror')) return json(200, { error: { code: 'InvalidParameter', message: '整体失败' } });
      if (model.includes('weird')) return json(200, { ok: true, nothing: 'useful' });
      if (model.includes('multib64')) {
        return json(200, { created: 1, model, data: [{ b64_json: PNG_BYTES.toString('base64'), output_format: 'jpeg' }] });
      }
      const count = Number(body?.sequential_image_generation_options?.max_images) || 1;
      const data = Array.from({ length: count }, () => {
        resultSeq += 1;
        return { url: `${base}/result-${resultSeq}.png`, size: body?.size, output_format: 'png' };
      });
      return json(200, { created: 1234, model, data, usage: { generated_images: data.length } });
    }

    json(404, { error: 'no such path' });
  });
});

let base = '';
await new Promise((done) => {
  upstream.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${upstream.address().port}`;
    done();
  });
});

const host = await startHost();
const ART_ROOT = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media');

function generate(body) {
  return host.dispatch('POST', '/api/aifisher/canvas/generate-image', body);
}

/** 最后一次生成调用（落盘会再拉一次图床，别把那条当成生成请求）。 */
function lastCall() {
  return [...received].reverse().find((item) => !/^\/result-\d+\.png$/.test(item.url));
}

function callsTo(url) {
  return received.filter((item) => item.url === url);
}

function diskPathOf(url) {
  const rel = decodeURIComponent(String(url).replace('/api/aifisher/canvas/media/', ''));
  return join(ART_ROOT, ...rel.split('/'));
}

/** 往素材库直接塞一张真图（画布节点上的参考图就是这个形状的本站 URL）。 */
function seedReference(projectId, filename) {
  const dir = join(ART_ROOT, projectId, 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), PNG_BYTES);
  return `/api/aifisher/canvas/media/${projectId}/images/${filename}`;
}

function setArkBase() {
  process.env.ARK_BASE_URL = `${base}/api/v3`;
  process.env.ARK_API_KEY = 'ark-test-key';
}

/** 界面「自定义模型 ID」存下来的键名（与 vendor 的 modelOverrideKey 同形）。 */
function overrideKey(name) {
  return `MODEL_ID_CUSTOM_${Array.from(name)
    .map((char) => char.codePointAt(0).toString(16))
    .join('_')}`;
}

setArkBase();

// ---------------------------------------------------------------------------
console.log('\n=== 设置页 / 诊断：方舟卡片与目录 ===');
{
  const status = await host.hostApi('GET', '/status');
  const body = status.json();
  const names = (body.ark?.models ?? []).map((item) => item.name);
  check(
    '方舟目录含 4 条直连图片模型（含补丁追加的 5.0 pro）',
    [MODEL_5_PRO, MODEL_5_LITE, MODEL_4_5, '豆包图片4.0(多参考)'].every((name) => names.includes(name)),
    names.join(' | '),
  );
  const pro = (body.ark?.models ?? []).find((item) => item.name === MODEL_5_PRO);
  check('5.0 pro 的默认模型 ID 来自目录', pro?.defaultModelId === ARK_5_PRO_ID, String(pro?.defaultModelId));
  check('诊断里不回显方舟密钥', body.ark?.apiKey === '已设置' && !JSON.stringify(body).includes('ark-test-key'), String(body.ark?.apiKey));

  const sources = await host.hostApi('GET', '/generation/sources');
  const blocks = sources.json().blocks ?? [];
  const ark = blocks.find((block) => block.source === 'ark');
  check(
    '来源清单只剩方舟卡片（自配单端点卡片 v1.13 已移除）',
    blocks.length === 1 && ark === blocks[0],
    blocks.map((b) => b.source).join(','),
  );
  check('方舟卡片是单密钥 + ARK_API_KEY + 图片模型', ark?.singleKey === true && ark?.secrets?.[0]?.key === 'ARK_API_KEY' && ark?.media?.[0]?.kind === 'image');
  check('已配 Key → 卡片密钥 configured:true', ark?.secrets?.[0]?.configured === true);
  check(
    '这张卡片的 image 一组只列方舟直连的图片模型（别的目录模型不来冒名）',
    (ark?.media ?? [])
      .filter((m) => m.kind === 'image')
      .flatMap((m) => m.models ?? [])
      .every((m) => [MODEL_5_PRO, MODEL_5_LITE, MODEL_4_5, '豆包图片4.0(多参考)'].includes(m.name)),
  );
  check(
    '同一张卡片的 video 一组只列方舟直连的视频模型（Seedance，v1.60）',
    (ark?.media ?? [])
      .filter((m) => m.kind === 'video')
      .flatMap((m) => m.models ?? [])
      .every((m) => ['豆包视频2.0', '豆包视频2.0 fast'].includes(m.name)),
  );

  const availability = await host.hostApi('GET', '/generation/model-availability');
  const groups = availability.json().groups ?? [];
  const proGroup = groups.find((group) => group.canonicalModel === MODEL_5_PRO);
  const liteGroup = groups.find((group) => group.canonicalModel === MODEL_5_LITE);
  check(
    '模型可用性：方舟模型标 source=ark / sourceLabel=火山方舟 / configured',
    proGroup?.variants?.[0]?.source === 'ark' &&
      proGroup?.variants?.[0]?.sourceLabel === '火山方舟' &&
      proGroup?.variants?.[0]?.configured === true &&
      proGroup?.variants?.[0]?.requiredSecrets?.[0] === 'ARK_API_KEY',
    JSON.stringify(proGroup?.variants?.[0] && { source: proGroup.variants[0].source, configured: proGroup.variants[0].configured }),
  );
  check(
    '方舟模型走方舟、目录里其余云端模型不再出现在可用性里（v1.13 后没有它们的后端）',
    liteGroup?.variants?.[0]?.source === 'ark' &&
      !groups.some((group) => group.canonicalModel === 'Seedream v5 Pro'),
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 文生图：请求翻译 ===');
{
  const result = await generate({
    projectId: 'proj-ark',
    nodeId: 'n1',
    prompt: '一只猫',
    imageModel: MODEL_5_PRO,
    resolution: '2K',
    aspectRatio: '16:9',
    imageMode: 'text-to-image',
    generateCount: 1,
  });
  const body = JSON.parse(result.body);
  check('文生图 → 200', result.status === 200, `status=${result.status} ${result.body.slice(0, 200)}`);
  check('返回本站素材 URL', typeof body.resultUrl === 'string' && body.resultUrl.startsWith('/api/aifisher/canvas/media/'), body.resultUrl);
  check('provider=ark / model=目录里的方舟 ID', body.provider === 'ark' && body.model === ARK_5_PRO_ID, `${body.provider} ${body.model}`);

  const call = lastCall();
  check('打到方舟路径 /api/v3/images/generations', call?.url === '/api/v3/images/generations', call?.url);
  check('Bearer 用方舟密钥', call?.headers?.authorization === 'Bearer ark-test-key', call?.headers?.authorization);
  check('model 用目录里的方舟 ID', call?.body?.model === ARK_5_PRO_ID, String(call?.body?.model));
  check('prompt 原样透传', call?.body?.prompt === '一只猫', String(call?.body?.prompt));
  check('2K + 16:9 → size=2048x1152（宽高比真的带过去了）', call?.body?.size === '2048x1152', String(call?.body?.size));
  check('response_format=url / stream=false', call?.body?.response_format === 'url' && call?.body?.stream === false);
  check('watermark 默认关（节点没开）', call?.body?.watermark === false, String(call?.body?.watermark));
  check('5.0 pro 请求 output_format=png（落盘扩展名与内容一致）', call?.body?.output_format === 'png');
  check('文生图不带 image / 不带组图参数', call?.body?.image === undefined && call?.body?.sequential_image_generation === undefined);

  const file = diskPathOf(body.resultUrl);
  check('结果真的落盘且字节来自方舟图床', existsSync(file) && readFileSync(file).equals(PNG_BYTES), file.slice(-60));
  check('落盘扩展名跟着 output_format', file.endsWith('.png'), file.slice(-12));
}

// ---------------------------------------------------------------------------
console.log('\n=== 尺寸档位：越界夹取 + 最小像素抬升 ===');
{
  await generate({
    projectId: 'proj-ark',
    prompt: 'x',
    imageModel: MODEL_5_PRO,
    resolution: '4K',
    aspectRatio: '16:9',
    imageMode: 'text-to-image',
  });
  const call = lastCall();
  check('5.0 pro 不支持 4K → 夹到 2K 档（2048x1152）', call?.body?.size === '2048x1152', String(call?.body?.size));
  const sized = JSON.parse((await generate({
    projectId: 'proj-ark',
    prompt: 'x',
    imageModel: MODEL_5_PRO,
    resolution: '4K',
    aspectRatio: '16:9',
    imageMode: 'text-to-image',
  })).body);
  check(
    '夹取时把原因带回来（notes）',
    Array.isArray(sized.notes) && sized.notes.some((note) => String(note).includes('已按 2K 提交')),
    JSON.stringify(sized.notes),
  );

  await generate({
    projectId: 'proj-ark',
    prompt: 'x',
    imageModel: MODEL_5_PRO,
    resolution: '1K',
    aspectRatio: '16:9',
    imageMode: 'text-to-image',
  });
  check('1K + 16:9 低于方舟最小总像素 → 抬到 1280x720', lastCall()?.body?.size === '1280x720', String(lastCall()?.body?.size));

  await generate({
    projectId: 'proj-ark',
    prompt: 'x',
    imageModel: MODEL_5_PRO,
    resolution: '1K',
    aspectRatio: '1:1',
    imageMode: 'text-to-image',
  });
  check('1K + 1:1 → 1024x1024', lastCall()?.body?.size === '1024x1024', String(lastCall()?.body?.size));
}

// ---------------------------------------------------------------------------
console.log('\n=== 图生图：本站素材内联成 data URL ===');
{
  const reference = seedReference('proj-ark', 'ref-one.png');
  const result = await generate({
    projectId: 'proj-ark',
    nodeId: 'n2',
    prompt: '把它变成油画',
    imageModel: MODEL_5_PRO,
    resolution: '1K',
    aspectRatio: '1:1',
    imageMode: 'image-to-image',
    imageBase64: [reference],
  });
  check('图生图 → 200', result.status === 200, result.body.slice(0, 200));
  const call = lastCall();
  const image = call?.body?.image;
  check('单张参考图是字符串而非数组', typeof image === 'string', Array.isArray(image) ? 'array' : typeof image);
  check('内联成 data:image/png;base64', typeof image === 'string' && image.startsWith('data:image/png;base64,'), String(image).slice(0, 30));
  check(
    '内联字节与素材文件一致',
    typeof image === 'string' &&
      Buffer.from(image.slice('data:image/png;base64,'.length), 'base64').equals(PNG_BYTES),
  );

  const second = seedReference('proj-ark', 'ref-two.png');
  await generate({
    projectId: 'proj-ark',
    prompt: '融合',
    imageModel: MODEL_5_PRO,
    resolution: '1K',
    aspectRatio: '1:1',
    imageMode: 'image-to-image',
    imageBase64: [reference, second],
  });
  const multi = lastCall()?.body?.image;
  check('多张参考图是数组且长度正确', Array.isArray(multi) && multi.length === 2, Array.isArray(multi) ? String(multi.length) : typeof multi);

  const missing = await generate({
    projectId: 'proj-ark',
    prompt: 'x',
    imageModel: MODEL_5_PRO,
    imageMode: 'image-to-image',
    imageBase64: ['/not-a-media/url.png'],
  });
  check(
    '既不是本站素材也不是可访问 URL → 422 明说',
    missing.status === 422 && JSON.parse(missing.body).code === 'ARK_REFERENCE_UNREACHABLE',
    `${missing.status} ${missing.body.slice(0, 120)}`,
  );

  // v1.32：画布节点上存的结果 URL 带缓存戳（`?t=<毫秒>`，vendor withTimestamp 加的），
  // 而它同时是下一张图的参考素材 —— host 半必须按「去掉查询串 = 素材身份」去读盘。
  const stamped = `${seedReference('proj-ark', 'ref-stamped.png')}?t=1792243183952`;
  const withStamp = await generate({
    projectId: 'proj-ark',
    nodeId: 'n2b',
    prompt: '把它的腿修好',
    imageModel: MODEL_5_PRO,
    resolution: '1K',
    aspectRatio: '1:1',
    imageMode: 'image-to-image',
    imageBase64: [stamped],
  });
  check(
    '带缓存戳（?t=…）的本站素材照样内联（画布的结果 URL 就长这样）',
    withStamp.status === 200 &&
      String(lastCall()?.body?.image).startsWith('data:image/png;base64,'),
    `${withStamp.status} ${String(lastCall()?.body?.image).slice(0, 30)}`,
  );
  check(
    '缓存戳没被算进文件名：内联字节与素材文件一致',
    String(lastCall()?.body?.image) ===
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
  );

  const gone = await generate({
    projectId: 'proj-ark',
    prompt: 'x',
    imageModel: MODEL_5_PRO,
    imageMode: 'image-to-image',
    imageBase64: ['/api/aifisher/canvas/media/proj-ark/images/gone-forever.png?t=1'],
  });
  const goneBody = JSON.parse(gone.body);
  check(
    '素材库里那张图不在了 → 404 ARK_REFERENCE_MISSING（不再说成「请先把素材上传到素材库」）',
    gone.status === 404 && goneBody.code === 'ARK_REFERENCE_MISSING',
    `${gone.status} ${goneBody.code} ${String(goneBody.error).slice(0, 60)}`,
  );
  check(
    '素材已不在库里的文案说的是「已不在素材库里」',
    String(goneBody.error).includes('已不在素材库里'),
    String(goneBody.error).slice(0, 80),
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 组图：5.0 pro 并发多次、5.0 lite 用 sequential ===');
{
  const before = callsTo('/api/v3/images/generations').length;
  const pro = await generate({
    projectId: 'proj-ark',
    nodeId: 'n3',
    prompt: '三张',
    imageModel: MODEL_5_PRO,
    resolution: '1K',
    aspectRatio: '1:1',
    imageMode: 'text-to-image',
    generateCount: 3,
  });
  const proBody = JSON.parse(pro.body);
  const proCalls = callsTo('/api/v3/images/generations').length - before;
  check('5.0 pro 不支持组图 → 发 3 次请求', proCalls === 3, String(proCalls));
  check('3 张结果都并入 resultUrls', Array.isArray(proBody.resultUrls) && proBody.resultUrls.length === 3, JSON.stringify(proBody.resultUrls?.length));
  check('每一张都真的落盘', (proBody.resultUrls ?? []).every((url) => existsSync(diskPathOf(url))));

  const beforeLite = callsTo('/api/v3/images/generations').length;
  const lite = await generate({
    projectId: 'proj-ark',
    nodeId: 'n4',
    prompt: '三张',
    imageModel: MODEL_5_LITE,
    resolution: '2K',
    aspectRatio: '1:1',
    imageMode: 'text-to-image',
    generateCount: 3,
  });
  const liteBody = JSON.parse(lite.body);
  const liteCalls = callsTo('/api/v3/images/generations').length - beforeLite;
  const liteRequest = callsTo('/api/v3/images/generations').at(-1);
  check('5.0 lite 支持组图 → 只发 1 次请求', liteCalls === 1, String(liteCalls));
  check(
    '一次性请求带 sequential_image_generation=auto + max_images=3',
    liteRequest?.body?.sequential_image_generation === 'auto' &&
      liteRequest?.body?.sequential_image_generation_options?.max_images === 3,
    JSON.stringify(liteRequest?.body?.sequential_image_generation_options),
  );
  check('组图返回 3 张', Array.isArray(liteBody.resultUrls) && liteBody.resultUrls.length === 3, String(liteBody.resultUrls?.length));
  check('5.0 lite 的模型 ID 用目录值', liteRequest?.body?.model === 'doubao-seedream-5-0-260128', String(liteRequest?.body?.model));
}

// ---------------------------------------------------------------------------
console.log('\n=== b64_json 结果 + 扩展名跟随方舟声明 ===');
{
  // 用「自定义模型 ID」把请求指到「返回 b64 的假分支」——顺带验这条覆盖链路真的生效
  const key = overrideKey(MODEL_5_PRO);
  await host.hostApi('POST', '/config/keys', { [key]: 'doubao-seedream-5-0-pro-multib64' });
  const b64 = await generate({
    projectId: 'proj-ark',
    nodeId: 'n5',
    prompt: 'b64',
    imageModel: MODEL_5_PRO,
    resolution: '1K',
    aspectRatio: '1:1',
    imageMode: 'text-to-image',
  });
  const b64Body = JSON.parse(b64.body);
  check(
    '界面存的「自定义模型 ID」真的改掉发出去的 model',
    lastCall()?.body?.model === 'doubao-seedream-5-0-pro-multib64',
    String(lastCall()?.body?.model),
  );
  check('b64_json 结果落盘', b64.status === 200 && existsSync(diskPathOf(b64Body.resultUrl)), b64.body.slice(0, 120));
  check(
    '落盘扩展名跟 output_format=jpeg（不硬写 .png）',
    String(b64Body.resultUrl).endsWith('.jpg'),
    String(b64Body.resultUrl).slice(-12),
  );
  await host.hostApi('POST', '/config/keys', { [key]: '' });
  await generate({
    projectId: 'proj-ark',
    prompt: 'after-reset',
    imageModel: MODEL_5_PRO,
    resolution: '1K',
    aspectRatio: '1:1',
    imageMode: 'text-to-image',
  });
  check('清空覆盖后回到目录里的模型 ID', lastCall()?.body?.model === ARK_5_PRO_ID, String(lastCall()?.body?.model));
}

// ---------------------------------------------------------------------------
console.log('\n=== 图层拆分 ===');
{
  const noImage = await generate({
    projectId: 'proj-ark',
    prompt: '拆图层',
    imageModel: MODEL_5_PRO,
    imageMode: 'layer-decomposition',
  });
  check(
    '没有输入图 → 422 ARK_INPUT_REQUIRED',
    noImage.status === 422 && JSON.parse(noImage.body).code === 'ARK_INPUT_REQUIRED',
    `${noImage.status} ${noImage.body.slice(0, 120)}`,
  );

  const reference = seedReference('proj-ark', 'layer-src.png');
  await generate({
    projectId: 'proj-ark',
    nodeId: 'n6',
    prompt: '拆图层',
    imageModel: MODEL_5_PRO,
    resolution: '2K',
    aspectRatio: '16:9',
    imageMode: 'layer-decomposition',
    imageBase64: [reference],
  });
  const call = lastCall();
  check('layer_decomposition=true', call?.body?.layer_decomposition === true);
  check('图层拆分的 size 用档位字符串而非宽x高', call?.body?.size === '2K', String(call?.body?.size));

  const unsupported = await generate({
    projectId: 'proj-ark',
    prompt: '拆图层',
    imageModel: MODEL_5_LITE,
    imageMode: 'layer-decomposition',
    imageBase64: [reference],
  });
  check(
    '5.0 lite 不支持图层拆分 → 422 ARK_MODE_UNSUPPORTED',
    unsupported.status === 422 && JSON.parse(unsupported.body).code === 'ARK_MODE_UNSUPPORTED',
    `${unsupported.status} ${unsupported.body.slice(0, 120)}`,
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== watermark 开关 ===');
{
  await generate({
    projectId: 'proj-ark',
    prompt: '带水印',
    imageModel: MODEL_5_PRO,
    resolution: '1K',
    aspectRatio: '1:1',
    imageMode: 'text-to-image',
    watermark: true,
  });
  check('节点上打开水印 → watermark:true', lastCall()?.body?.watermark === true, String(lastCall()?.body?.watermark));
}

// ---------------------------------------------------------------------------
console.log('\n=== 错误路径 ===');
{
  const savedKey = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  const unconfigured = await generate({ prompt: 'x', imageModel: MODEL_5_PRO, imageMode: 'text-to-image' });
  const unconfiguredBody = JSON.parse(unconfigured.body);
  check(
    '没配 ARK_API_KEY → 501 ARK_NOT_CONFIGURED（提示去哪儿填）',
    unconfigured.status === 501 &&
      unconfiguredBody.code === 'ARK_NOT_CONFIGURED' &&
      String(unconfiguredBody.error).includes('ARK_API_KEY'),
    `${unconfigured.status} ${unconfiguredBody.code}`,
  );
  process.env.ARK_API_KEY = savedKey;
  const key = overrideKey(MODEL_5_PRO);

  await host.hostApi('POST', '/config/keys', { [key]: 'doubao-seedream-5-0-pro-boom-401' });
  const denied = JSON.parse((await generate({ prompt: 'x', imageModel: MODEL_5_PRO, imageMode: 'text-to-image' })).body);
  check(
    '鉴权失败 → 502 且给出「去核对 API Key」的提示',
    denied.code === 'ARK_UPSTREAM_ERROR' &&
      denied.upstreamStatus === 401 &&
      String(denied.hint).includes('API Key'),
    `${denied.upstreamStatus} ${denied.hint}`,
  );

  await host.hostApi('POST', '/config/keys', { [key]: 'doubao-seedream-5-0-pro-modelnotopen' });
  const notOpen = JSON.parse((await generate({ prompt: 'x', imageModel: MODEL_5_PRO, imageMode: 'text-to-image' })).body);
  check(
    '模型未开通（ModelNotOpen）→ 提示去方舟控制台开通 + 给出开通管理链接',
    notOpen.upstreamStatus === 404 &&
      String(notOpen.hint).includes('已开通') &&
      String(notOpen.hint).includes('console.volcengine.com/ark/region:ark+cn-beijing/openManagement'),
    `${notOpen.upstreamStatus} ${notOpen.hint}`,
  );

  await host.hostApi('POST', '/config/keys', { [key]: 'doubao-seedream-5-0-pro-boom-500' });
  const boom = JSON.parse((await generate({ prompt: 'x', imageModel: MODEL_5_PRO, imageMode: 'text-to-image' })).body);
  check(
    '上游 500 → 502 且带上方舟错误原文',
    boom.upstreamStatus === 500 && String(boom.error).includes('方舟内部错误'),
    String(boom.error),
  );

  await host.hostApi('POST', '/config/keys', { [key]: 'doubao-seedream-5-0-pro-toperror' });
  const top = JSON.parse((await generate({ prompt: 'x', imageModel: MODEL_5_PRO, imageMode: 'text-to-image' })).body);
  check(
    'HTTP 200 但顶层 error → 502（不当成成功）',
    top.code === 'ARK_UPSTREAM_ERROR' && String(top.error).includes('整体失败'),
    String(top.error),
  );

  await host.hostApi('POST', '/config/keys', { [key]: 'doubao-seedream-5-0-pro-weird' });
  const weird = JSON.parse((await generate({ prompt: 'x', imageModel: MODEL_5_PRO, imageMode: 'text-to-image' })).body);
  check('认不出的响应 → 502 ARK_RESULT_UNRECOGNIZED', weird.code === 'ARK_RESULT_UNRECOGNIZED', weird.code);

  await host.hostApi('POST', '/config/keys', { [key]: '' });
  process.env.ARK_BASE_URL = 'http://127.0.0.1:1/api/v3';
  const unreachable = JSON.parse((await generate({ prompt: 'x', imageModel: MODEL_5_PRO, imageMode: 'text-to-image' })).body);
  check(
    '方舟端点不可达 → 502 ARK_UNREACHABLE',
    unreachable.code === 'ARK_UNREACHABLE',
    `${unreachable.code} ${String(unreachable.error).slice(0, 80)}`,
  );
  setArkBase();
}

// ---------------------------------------------------------------------------
console.log('\n=== 与自配通道互不串线 ===');
{
  const other = await generate({
    projectId: 'proj-cloud',
    prompt: 'x',
    imageModel: 'Seedream 5.0 Pro · API',
    resolution: '1K',
    aspectRatio: '1:1',
    imageMode: 'text-to-image',
  });
  check(
    '非方舟模型 + 没配通道 → 501 CLOUD_NOT_CONFIGURED（没被方舟接管）',
    other.status === 501 && JSON.parse(other.body).code === 'CLOUD_NOT_CONFIGURED',
    `${other.status} ${other.body.slice(0, 100)}`,
  );

  // 目录里那些上游「服务商矩阵」模型（relay / runninghub / 即梦…）在本插件里没有后端了：
  // v1.13 移除单端点后它们不该再出现在模型可用性里（否则画布下拉会出现点了必失败的名字）。
  const availability = (await host.hostApi('GET', '/generation/model-availability')).json();
  const names = (availability.groups ?? []).map((group) => group.canonicalModel);
  check(
    '目录里的非方舟云端模型不再出现在可用性里',
    !names.includes('Seedream 5.0 Pro · API') && !names.includes('GPT Image 2 · API'),
    JSON.stringify(names).slice(0, 200),
  );
  check(
    '方舟模型仍然在（这条后端没动）',
    names.includes(MODEL_5_PRO),
    JSON.stringify(names).slice(0, 200),
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 费用预估（元/张，画布下拉与节点价格标签读的就是这个 price）===');
{
  const variants = async (resolution, aspectRatio, mode) => {
    const query = `resolution=${encodeURIComponent(resolution)}&aspectRatio=${encodeURIComponent(aspectRatio)}${mode ? `&mode=${encodeURIComponent(mode)}` : ''}`;
    const body = (await host.hostApi('GET', `/generation/model-availability?${query}`)).json();
    const of = (canonical) => body.groups.find((group) => group.canonicalModel === canonical)?.variants?.[0];
    return { body, of };
  };

  const wide = await variants('2K', '16:9');
  const pro = wide.of(MODEL_5_PRO);
  check(
    '2K + 16:9（2048x1152 ≈235.9 万像素）→ 0.3 元/张',
    pro?.price === 0.3,
    JSON.stringify(pro?.price),
  );
  check(
    '估价按官方像素口径注明（≈ + 非精确 + 以方舟账单为准）',
    pro?.priceExact === false && String(pro?.priceNote).includes('方舟') && String(pro?.priceNote).includes('236'),
    String(pro?.priceNote).slice(0, 90),
  );

  const square = await variants('2K', '1:1');
  check(
    '2K + 1:1（2048x2048 = 419 万像素 >236 万）→ 0.6 元/张',
    square.of(MODEL_5_PRO)?.price === 0.6,
    JSON.stringify(square.of(MODEL_5_PRO)?.price),
  );

  const small = await variants('1K', '1:1');
  check('1K + 1:1 → 0.3 元/张', small.of(MODEL_5_PRO)?.price === 0.3, JSON.stringify(small.of(MODEL_5_PRO)?.price));

  const layers = await variants('2K', '16:9', 'layer-decomposition');
  check(
    '图层拆分不预估（price:null，不编数字）',
    layers.of(MODEL_5_PRO)?.price === null,
    JSON.stringify(layers.of(MODEL_5_PRO)?.price),
  );

  const flat = await variants('2K', '1:1');
  check('5.0 lite 用目录单价 0.22 元/张', flat.of(MODEL_5_LITE)?.price === 0.22, JSON.stringify(flat.of(MODEL_5_LITE)?.price));
  check('4.5 用目录单价 0.25 元/张', flat.of(MODEL_4_5)?.price === 0.25, JSON.stringify(flat.of(MODEL_4_5)?.price));
  check(
    '4.0 用目录单价 0.2 元/张',
    flat.of('豆包图片4.0(多参考)')?.price === 0.2,
    JSON.stringify(flat.of('豆包图片4.0(多参考)')?.price),
  );
  check(
    '非方舟变体仍然不给价格（不冒充）',
    flat.body.groups
      .filter((group) => group.canonicalModel === 'Seedream v5 Pro')
      .flatMap((group) => group.variants)
      .every((variant) => variant.price === null),
  );
  const allVariants = flat.body.groups.flatMap((group) => group.variants ?? []);
  check(
    '变体字段齐全：price 数字或 null / priceExact 布尔 / requiredSecrets 数组',
    allVariants.length > 0 &&
      allVariants.every(
        (variant) =>
          typeof variant.name === 'string' &&
          (variant.price === null || typeof variant.price === 'number') &&
          typeof variant.priceExact === 'boolean' &&
          Array.isArray(variant.requiredSecrets),
      ),
    String(allVariants.length),
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 设置页保存方舟密钥 ===');
{
  const savedKey = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  const cleared = await host.hostApi('GET', '/generation/sources');
  check('清掉 Key → 方舟卡片 configured:false', cleared.json().blocks.find((b) => b.source === 'ark')?.secrets?.[0]?.configured === false);
  const availability = await host.hostApi('GET', '/generation/model-availability');
  check(
    '没配 Key 时方舟模型 configured:false（画布下拉里不会出现）',
    (availability.json().groups.find((group) => group.canonicalModel === MODEL_5_PRO)?.variants ?? []).every(
      (variant) => variant.configured === false,
    ),
  );
  delete process.env.ARK_API_KEY;
  const saved = await host.hostApi('POST', '/config/keys', { ARK_API_KEY: 'ark-saved-key' });
  check('保存 ARK_API_KEY → {success:true}', saved.status === 200 && saved.json().success === true, saved.text.slice(0, 100));
  check('保存即刻生效（host 进程内）', process.env.ARK_API_KEY === 'ark-saved-key');
  const keys = await host.hostApi('GET', '/config/keys');
  check('GET keys 不回显方舟密钥', !JSON.stringify(keys.json()).includes('ark-saved-key'), keys.text.slice(0, 160));
  check('GET keys 给出方舟已配置的布尔量', keys.json().ARK_ENDPOINT_CONFIGURED === 'true');
  const after = await host.hostApi('GET', '/generation/sources');
  check('保存后卡片 configured:true', after.json().blocks.find((b) => b.source === 'ark')?.secrets?.[0]?.configured === true);

  await host.hostApi('POST', '/config/keys', { ARK_API_KEY: '' });
  process.env.ARK_API_KEY = savedKey;
}

// ---------------------------------------------------------------------------
console.log('\n=== 产物契约 ===');
{
  const hostBundle = readFileSync(resolve(ROOT, 'lib/index.js'), 'utf8');
  check('产物里有方舟适配器', hostBundle.includes('ARK_NOT_CONFIGURED') && hostBundle.includes('doubao-seedream'));
  check('产物里方舟模型进了画布目录（vendor 补丁生效）', hostBundle.includes(MODEL_5_PRO));
  check('产物里带方舟环境变量开关', hostBundle.includes('ARK_API_KEY') && hostBundle.includes('ARK_BASE_URL'));
  const canvasSrc = readFileSync(resolve(ROOT, 'lib/canvas/canvas-app.js'), 'utf8');
  check(
    '画布产物里方舟模型已可选（selectable 补丁 + 常用清单）',
    canvasSrc.includes(MODEL_5_PRO) && canvasSrc.includes('豆包图片5.0-lite'),
  );
}

delete process.env.ARK_API_KEY;
delete process.env.ARK_BASE_URL;
upstream.close();

console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
if (fail) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
}
process.exit(fail ? 1 : 0);
