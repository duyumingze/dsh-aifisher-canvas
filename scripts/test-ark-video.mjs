/**
 * 火山方舟（豆包 Seedance）**视频**生成回归（scripts/test-ark-video.mjs）。
 *
 * 全程用**真 HTTP 的假方舟**：一个 http 服务同时扮演方舟的异步任务接口
 * （`POST /api/v3/contents/generations/tasks` + `GET …/tasks/{id}`）和结果文件床
 * （方舟给的 `content.video_url` 会过期，host 半必须立刻把它下载进素材库）。
 *
 * 验的是「画布的视频请求 → 方舟任务请求 → 轮询 → 结果落素材库」这条链：
 *   - 分发：目录里的 `豆包视频2.0` / `豆包视频2.0 fast` 走方舟；别的视频模型仍走通道那套（501）
 *   - 请求翻译：content 数组（text / first_frame / last_frame / reference_image /
 *     reference_video / reference_audio）、resolution、ratio、duration、generate_audio、watermark
 *   - 素材：本站参考图内联成 data URL；参考视频/音频只认公网直链（本站素材明确拒绝）
 *   - 约束：参考音频必须有视觉参考、尾帧不能混参考素材、张数上限
 *   - 收尾：queued 不算收尾、failed 报原因、无任务号 / 超时都说得清
 *   - 设置页：sources / model-availability 里出现这条视频来源（configured 跟着 Key 走）
 *   - 模型 ID 覆盖：`MODEL_ID_CUSTOM_<码点>` 真的改掉发出去的 model
 *
 * 用法：node scripts/test-ark-video.mjs
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** 1x1 透明 PNG（参考图的真字节）。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
/** 一段假的 mp4 字节（只验「落盘的确实是结果文件」，不解码）。 */
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'latin1'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom', 'latin1'),
]);

const MODEL = '豆包视频2.0';
const MODEL_FAST = '豆包视频2.0 fast';
const MODEL_ID = 'doubao-seedance-2-0-260128';
const PUBLIC_VIDEO = 'https://cdn.example.com/ref/clip.mp4';
const PUBLIC_AUDIO = 'https://cdn.example.com/ref/bgm.mp3';

// ---------------------------------------------------------------------------
// 假方舟：异步任务接口 + 结果文件床
// ---------------------------------------------------------------------------
const received = [];
const pollCounts = new Map();
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

    if (req.method === 'GET' && /^\/result-\d+\.mp4$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(MP4_BYTES);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/v3/contents/generations/tasks') {
      const model = String(body?.model ?? '');
      if (model.includes('auth-bad')) {
        return json(401, { error: { code: 'AuthenticationError', message: 'invalid api key' } });
      }
      if (model.includes('notopened')) {
        return json(404, { error: { code: 'ModelNotOpen', message: 'the model has not been opened' } });
      }
      if (model.includes('badparam')) {
        return json(400, { error: { code: 'InvalidParameter', message: 'invalid duration' } });
      }
      if (model.includes('noid')) return json(200, { ok: true, nothing: 'useful' });
      if (model.includes('boom500')) return json(500, { error: { message: '方舟内部错误' } });
      // 任务号里带上「这条任务该怎么收尾」，后面的 GET 靠它分流
      const behaviour = model.includes('queued')
        ? '-queued'
        : model.includes('fail')
          ? '-fail'
          : model.includes('slow')
            ? '-slow'
            : '';
      return json(200, { id: `task-${++resultSeq}${behaviour}` });
    }

    if (req.method === 'GET' && req.url.startsWith('/api/v3/contents/generations/tasks/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const seen = (pollCounts.get(id) ?? 0) + 1;
      pollCounts.set(id, seen);
      if (id.includes('slow')) return json(200, { id, status: 'running', content: {} });
      if (id.includes('fail')) {
        return json(200, {
          id,
          status: 'failed',
          error: { code: 'OutputVideoSensitiveContentDetected', message: '内容审核未通过' },
        });
      }
      if (id.includes('queued') && seen === 1) {
        return json(200, { id, status: 'queued', content: {} });
      }
      return json(200, {
        id,
        status: 'succeeded',
        model: MODEL_ID,
        content: { video_url: `${base}/result-${resultSeq}.mp4` },
        usage: { completion_tokens: 1234, total_tokens: 1234 },
        created_at: 1,
        updated_at: 2,
      });
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

const host = await startHost({
  env: {
    ARK_API_KEY: 'ark-video-test-key',
    ARK_BASE_URL: `${base}/api/v3`,
    ARK_TIMEOUT_MS: '20000',
  },
});
const ART_ROOT = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media');

function generate(body) {
  return host.dispatch('POST', '/api/aifisher/canvas/generate-video', body);
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 最后一次提交到方舟的任务请求（落盘会再拉一次文件床，别把那条当成提交）。 */
function lastSubmit() {
  return [...received]
    .reverse()
    .find((item) => item.method === 'POST' && item.url === '/api/v3/contents/generations/tasks');
}

function lastPoll() {
  return [...received]
    .reverse()
    .find((item) => item.method === 'GET' && item.url.startsWith('/api/v3/contents/generations/tasks/'));
}

/** 往素材库直接塞一张真图（画布节点上的参考图就是这个形状的本站 URL）。 */
function seedReference(projectId, filename) {
  const dir = join(ART_ROOT, projectId, 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), PNG_BYTES);
  return `/api/aifisher/canvas/media/${projectId}/images/${filename}`;
}

/** 界面「自定义模型 ID」存下来的键名（与 vendor 的 modelOverrideKey 同形）。 */
function overrideKey(name) {
  return `MODEL_ID_CUSTOM_${Array.from(name)
    .map((char) => char.codePointAt(0).toString(16))
    .join('_')}`;
}

function contentOf(body) {
  return Array.isArray(body?.content) ? body.content : [];
}

function rolesOf(body) {
  return contentOf(body)
    .filter((part) => part.role)
    .map((part) => part.role);
}

function textOf(body) {
  return contentOf(body).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

const PROJECT = 'proj-ark-video';

// ---------------------------------------------------------------------------
console.log('\n=== 设置页 / 诊断：方舟视频来源 ===');
{
  const status = json((await host.hostApi('GET', '/status')).text);
  const names = (status.arkVideo?.models ?? []).map((item) => item.name);
  check(
    '诊断里有方舟视频卡片，目录含两条 Seedance 记录',
    [MODEL, MODEL_FAST].every((name) => names.includes(name)),
    names.join(' | '),
  );
  check(
    '诊断里视频模型 ID 来自目录',
    (status.arkVideo?.models ?? []).find((item) => item.name === MODEL)?.defaultModelId === MODEL_ID,
    String((status.arkVideo?.models ?? []).find((item) => item.name === MODEL)?.defaultModelId),
  );
  check(
    '诊断不回显方舟密钥',
    !JSON.stringify(status).includes('ark-video-test-key'),
  );

  const sources = json((await host.hostApi('GET', '/generation/sources')).text);
  const ark = (sources.blocks ?? []).find((block) => block.source === 'ark');
  const videoMedia = (ark?.media ?? []).find((media) => media.kind === 'video');
  check(
    '方舟卡片多了 video 一组模型，且 configured 跟 Key 走',
    videoMedia?.models?.length === 2 &&
      videoMedia.models.every((model) => model.configured === true && model.requiredSecrets[0] === 'ARK_API_KEY'),
    JSON.stringify(videoMedia?.models?.map((m) => m.name)),
  );

  const availability = json(
    (await host.hostApi('GET', '/generation/model-availability?resolution=720p&duration=11')).text,
  );
  const group = (availability.groups ?? []).find((item) => item.canonicalModel === 'Seedance 2.0');
  const variant = (group?.variants ?? []).find((item) => item.name === MODEL);
  check(
    '模型可用性里有「Seedance 2.0 › 火山方舟 › 豆包视频2.0」这一条',
    variant?.source === 'ark' &&
      variant?.sourceLabel === '火山方舟' &&
      variant?.configured === true &&
      variant?.requiredSecrets?.[0] === 'ARK_API_KEY',
    JSON.stringify(variant && { source: variant.source, configured: variant.configured }),
  );
  check(
    '视频单价是「元/秒」且写明 /秒（画布自己乘时长）',
    variant?.price === 1.35 && /\/秒/.test(String(variant?.priceLabel)) && /元\/秒/.test(String(variant?.priceNote)),
    `${variant?.price} / ${variant?.priceLabel}`,
  );
  check(
    'fast 那条独立成组（canonicalModel = Seedance 2.0 Fast）',
    (availability.groups ?? []).some(
      (item) => item.canonicalModel === 'Seedance 2.0 Fast' && item.variants.some((v) => v.name === MODEL_FAST),
    ),
  );

  // 节点上那个模型按钮（CanvasModelSelector）会过滤掉 selectable === false 的条目：
  // 上游把这两条方舟视频模型藏起来了，本插件必须在构建期把它们放回来，否则「下拉里选不到」。
  const catalog = readFileSync(join(ROOT, 'vendor/aifisher/src/config/modelConfig.ts'), 'utf8');
  const selectableOf = (name) => {
    const start = catalog.indexOf(`'${name}'`);
    const slice = catalog.slice(start, start + 400);
    return /selectable:\s*true/.test(slice);
  };
  check(
    '构建期补丁把两条方舟视频模型改成 selectable: true（否则节点模型按钮里选不到）',
    selectableOf(MODEL) && selectableOf(MODEL_FAST),
  );
  const policy = readFileSync(
    join(ROOT, 'vendor/aifisher/src/stable/generation/canvasModelCatalogPolicy.ts'),
    'utf8',
  );
  check(
    '常用模型白名单本来就含 Seedance 2.0 / Seedance 2.0 Fast（无需再补）',
    policy.includes("'Seedance 2.0'") && policy.includes("'Seedance 2.0 Fast'"),
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 文生视频：请求翻译 + 结果落盘 ===');
{
  const response = await generate({
    prompt: '一只猫在窗台打哈欠，晨光',
    videoModel: MODEL,
    videoMode: 'text-to-video',
    aspectRatio: '16:9',
    resolution: '720p',
    duration: 11,
    generate_audio: true,
    nodeId: 'node-t2v',
    projectId: PROJECT,
    generateCount: 1,
  });
  const body = json(response.body);
  const submit = lastSubmit();
  check('文生视频走方舟并成功', response.status === 200 && body.success === true, `${response.status} ${body.error ?? ''}`);
  check('提交的 model 是目录里的方舟模型 ID', submit?.body?.model === MODEL_ID, String(submit?.body?.model));
  check('content[0] 是 text，且提示词原样', contentOf(submit?.body)[0]?.type === 'text' && textOf(submit?.body).includes('一只猫'), textOf(submit?.body));
  check(
    'ratio / resolution / duration 按画布的选择提交',
    submit?.body?.ratio === '16:9' &&
      submit?.body?.resolution === '720p' &&
      submit?.body?.duration === 11,
    JSON.stringify({ ratio: submit?.body?.ratio, resolution: submit?.body?.resolution, duration: submit?.body?.duration }),
  );
  check(
    'generate_audio / watermark 跟着节点与配置走',
    submit?.body?.generate_audio === true && submit?.body?.watermark === false,
    JSON.stringify({ audio: submit?.body?.generate_audio, wm: submit?.body?.watermark }),
  );
  check('文生视频不带任何 role', rolesOf(submit?.body).length === 0, rolesOf(submit?.body).join(','));
  check('轮询地址是 /tasks/{id}', /\/api\/v3\/contents\/generations\/tasks\/task-\d+$/.test(lastPoll()?.url ?? ''), lastPoll()?.url);
  check('回执带任务号', typeof body.taskId === 'string' && body.taskId.startsWith('task-'), body.taskId);
  check(
    '结果落进素材库（视频目录 .mp4，字节来自文件床）',
    typeof body.resultUrl === 'string' &&
      body.resultUrl.startsWith(`/api/aifisher/canvas/media/${PROJECT}/videos/`) &&
      body.resultUrl.endsWith('.mp4') &&
      readFileSync(join(ART_ROOT, PROJECT, 'videos', decodeURIComponent(body.resultUrl.split('/').pop()))).equals(MP4_BYTES),
    String(body.resultUrl),
  );
  check('回执带上实际提交的四个参数', body.mode === 'text-to-video' && body.ratio === '16:9' && body.resolution === '720p' && body.duration === 11);
}

// ---------------------------------------------------------------------------
console.log('\n=== 首尾帧（i2v-first-last-frame）===');
{
  const first = seedReference(PROJECT, 'frame-first.png');
  const last = seedReference(PROJECT, 'frame-last.png');
  const response = await generate({
    prompt: '从白天过渡到夜晚',
    videoModel: MODEL,
    videoMode: 'i2v-first-last-frame',
    images: [first, last],
    aspectRatio: '16:9',
    resolution: '1080p',
    duration: 5,
    projectId: PROJECT,
  });
  const body = json(response.body);
  const submit = lastSubmit();
  const roles = rolesOf(submit?.body);
  check('首尾帧成功', response.status === 200 && body.success === true, `${response.status} ${body.error ?? ''}`);
  check('两张图分别成为 first_frame / last_frame', roles.join(',') === 'first_frame,last_frame', roles.join(','));
  check(
    '首帧是内联的 data URL（方舟访问不到本站素材）',
    contentOf(submit?.body)[1]?.image_url?.url?.startsWith('data:image/png;base64,'),
    String(contentOf(submit?.body)[1]?.image_url?.url).slice(0, 40),
  );
  check('有首尾帧时 ratio 提交 adaptive', submit?.body?.ratio === 'adaptive', String(submit?.body?.ratio));
  check('分辨率照节点选择提交 1080p', submit?.body?.resolution === '1080p', String(submit?.body?.resolution));
  check('内联提示里说清了「已内联」', (body.notes ?? []).some((note) => note.includes('内联')), JSON.stringify(body.notes));
}

// ---------------------------------------------------------------------------
console.log('\n=== 多模态参考（图 + 视频 + 音频）===');
{
  const image = seedReference(PROJECT, 'ref-subject.png');
  const response = await generate({
    prompt: '参考 @Image1 的主体，按 @Video1 的运镜，配 @Audio1 的节奏',
    videoModel: MODEL,
    videoMode: 'multimodal',
    images: [image],
    videos: [PUBLIC_VIDEO],
    audios: [PUBLIC_AUDIO],
    aspectRatio: '9:16',
    resolution: '720p',
    duration: 8,
    projectId: PROJECT,
  });
  const body = json(response.body);
  const submit = lastSubmit();
  const roles = rolesOf(submit?.body);
  check('多模态参考成功', response.status === 200 && body.success === true, `${response.status} ${body.error ?? ''}`);
  check(
    '三种素材各就各位（reference_image / reference_video / reference_audio）',
    roles.join(',') === 'reference_image,reference_video,reference_audio',
    roles.join(','),
  );
  check(
    '参考视频/音频是公网直链原样带上',
    contentOf(submit?.body).find((part) => part.role === 'reference_video')?.video_url?.url === PUBLIC_VIDEO &&
      contentOf(submit?.body).find((part) => part.role === 'reference_audio')?.audio_url?.url === PUBLIC_AUDIO,
  );
  check('比例照节点选择提交 9:16', submit?.body?.ratio === '9:16', String(submit?.body?.ratio));
}

// ---------------------------------------------------------------------------
console.log('\n=== 明确拒绝的输入 ===');
{
  const image = seedReference(PROJECT, 'ref-audio-only.png');
  // 1) 本站素材当参考视频：方舟访问不到，必须当场说清楚
  const localVideo = seedReference(PROJECT, 'local-clip.png');
  const localRef = await generate({
    prompt: '参考这段视频',
    videoModel: MODEL,
    videoMode: 'multimodal',
    images: [image],
    videos: [localVideo],
    projectId: PROJECT,
  });
  const localBody = json(localRef.body);
  check(
    '本站素材不能当参考视频：422 + 说清「要公网直链」',
    localRef.status === 422 &&
      localBody.code === 'ARK_REFERENCE_UNREACHABLE' &&
      /公网/.test(String(localBody.error)),
    `${localRef.status} ${localBody.code}`,
  );

  // 2) 只有音频、没有视觉参考
  const audioOnly = await generate({
    prompt: '照这段音频',
    videoModel: MODEL,
    videoMode: 'multimodal',
    audios: [PUBLIC_AUDIO],
    projectId: PROJECT,
  });
  const audioBody = json(audioOnly.body);
  check(
    '只给音频（无视觉参考）被拒：ARK_AUDIO_WITHOUT_VISUAL',
    audioOnly.status === 422 && audioBody.code === 'ARK_AUDIO_WITHOUT_VISUAL',
    `${audioOnly.status} ${audioBody.code}`,
  );

  // 3) 尾帧 + 参考素材混用
  const first = seedReference(PROJECT, 'mix-first.png');
  const last = seedReference(PROJECT, 'mix-last.png');
  const mixed = await generate({
    prompt: 'x',
    videoModel: MODEL,
    videoMode: 'i2v-first-last-frame',
    images: [first, last],
    videos: [PUBLIC_VIDEO],
    projectId: PROJECT,
  });
  const mixedBody = json(mixed.body);
  check(
    '尾帧与参考素材混用被拒：ARK_MODE_CONFLICT',
    mixed.status === 422 && mixedBody.code === 'ARK_MODE_CONFLICT',
    `${mixed.status} ${mixedBody.code}`,
  );

  // 4) 首帧模式却没有图
  const noFrame = await generate({
    prompt: 'x',
    videoModel: MODEL,
    videoMode: 'i2v-first-last-frame',
    projectId: PROJECT,
  });
  check(
    '首尾帧模式没连图 → ARK_FRAME_REQUIRED',
    noFrame.status === 422 && json(noFrame.body).code === 'ARK_FRAME_REQUIRED',
    `${noFrame.status} ${json(noFrame.body).code}`,
  );

  // 5) prompt 为空
  const noPrompt = await generate({
    prompt: '   ',
    videoModel: MODEL,
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  check(
    '没有提示词 → ARK_PROMPT_REQUIRED',
    noPrompt.status === 422 && json(noPrompt.body).code === 'ARK_PROMPT_REQUIRED',
    `${noPrompt.status} ${json(noPrompt.body).code}`,
  );

  // 6) 分辨率/时长越界：夹取 + 说明，而不是照原样发出去
  const clamped = await generate({
    prompt: '夹取',
    videoModel: MODEL,
    videoMode: 'text-to-video',
    resolution: '2K',
    duration: 30,
    projectId: PROJECT,
  });
  const clampedBody = json(clamped.body);
  const clampedSubmit = lastSubmit();
  check(
    '分辨率 2K → 720p、时长 30s → 15s，并在 notes 里说明',
    clamped.status === 200 &&
      clampedSubmit?.body?.resolution === '720p' &&
      clampedSubmit?.body?.duration === 15 &&
      (clampedBody.notes ?? []).length >= 2,
    JSON.stringify({ resolution: clampedSubmit?.body?.resolution, duration: clampedSubmit?.body?.duration, notes: clampedBody.notes }),
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 任务状态：queued 不算收尾 / 失败 / 超时 ===');
{
  // queued → succeeded：第一次轮询是 queued，必须继续等而不是当成失败
  const queued = await generate({
    prompt: '排队后成功',
    videoModel: 'doubao-seedance-queued-260128',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  const queuedBody = json(queued.body);
  check(
    'queued 不会当成收尾（继续轮询到 succeeded）',
    queued.status === 200 && queuedBody.success === true,
    `${queued.status} ${queuedBody.error ?? ''}`,
  );
  check('这条任务被轮询了不止一次', (pollCounts.get(queuedBody.taskId) ?? 0) >= 2, String(pollCounts.get(queuedBody.taskId)));

  // 任务失败：带上任务号与方舟给的原因
  const failed = await generate({
    prompt: '会被审核拦下',
    videoModel: 'doubao-seedance-fail-260128',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  const failedBody = json(failed.body);
  check(
    '任务失败 → 502 ARK_VIDEO_FAILED + 原因 + 任务号',
    failed.status === 502 &&
      failedBody.code === 'ARK_VIDEO_FAILED' &&
      /内容审核未通过/.test(String(failedBody.error)) &&
      typeof failedBody.taskId === 'string',
    `${failed.status} ${failedBody.code} ${failedBody.error}`,
  );

  // 超时：把轮询预算压到 1.2s，任务永远 running
  process.env.ARK_VIDEO_TIMEOUT_MS = '1200';
  const slow = await generate({
    prompt: '永远 running',
    videoModel: 'doubao-seedance-slow-260128',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  delete process.env.ARK_VIDEO_TIMEOUT_MS;
  const slowBody = json(slow.body);
  check(
    '轮询超时 → 504 ARK_VIDEO_TIMEOUT + 任务号（别急着重发）',
    slow.status === 504 &&
      slowBody.code === 'ARK_VIDEO_TIMEOUT' &&
      /倍|重复计费|别急着重发/.test(String(slowBody.error)),
    `${slow.status} ${slowBody.code}`,
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 上游报错 ===');
{
  const auth = await generate({
    prompt: 'x',
    videoModel: 'doubao-seedance-auth-bad-260128',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  const authBody = json(auth.body);
  check(
    '401 鉴权失败 → 502 + hint 指路 API Key',
    auth.status === 502 && authBody.upstreamStatus === 401 && /API Key/.test(String(authBody.hint)),
    `${auth.status} ${authBody.upstreamStatus}`,
  );

  const notOpen = await generate({
    prompt: 'x',
    videoModel: 'doubao-seedance-notopened-260128',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  const notOpenBody = json(notOpen.body);
  check(
    '404 ModelNotOpen → hint 说清「去控制台开通」',
    notOpen.status === 502 && /开通管理/.test(String(notOpenBody.hint)),
    `${notOpen.status} ${notOpenBody.hint}`,
  );

  const badParam = await generate({
    prompt: 'x',
    videoModel: 'doubao-seedance-badparam-260128',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  check(
    '400 参数被拒 → 502 + 上游原话',
    badParam.status === 502 &&
      json(badParam.body).upstreamStatus === 400 &&
      /invalid duration/.test(String(json(badParam.body).error)),
    `${badParam.status} ${json(badParam.body).error}`,
  );

  const noId = await generate({
    prompt: 'x',
    videoModel: 'doubao-seedance-noid-260128',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  check(
    '提交没回任务号 → 502 ARK_RESULT_UNRECOGNIZED',
    noId.status === 502 && json(noId.body).code === 'ARK_RESULT_UNRECOGNIZED',
    `${noId.status} ${json(noId.body).code}`,
  );

  const boom = await generate({
    prompt: 'x',
    videoModel: 'doubao-seedance-boom500-260128',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  check('500 → 502 + 上游原话', boom.status === 502 && /方舟内部错误/.test(String(json(boom.body).error)), `${boom.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 分发边界：只接管方舟视频，不串线 ===');
{
  // 别的云端视频模型（没有对应通道）仍然是 501，不能被方舟接管
  const other = await generate({
    prompt: 'x',
    videoModel: 'Seedance 2.5 Standard · API',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  check(
    '目录里非方舟的视频模型仍是 501 CLOUD_NOT_CONFIGURED',
    other.status === 501 && json(other.body).code === 'CLOUD_NOT_CONFIGURED',
    `${other.status} ${json(other.body).code}`,
  );

  // 模型 ID 直写（agent 常用）也要走方舟
  const direct = await generate({
    prompt: '直写模型 ID',
    videoModel: 'doubao-seedance-2-0-260128',
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  check(
    '直接给 doubao-seedance-… 也能走方舟',
    direct.status === 200 && json(direct.body).model === MODEL_ID,
    `${direct.status} ${json(direct.body).model ?? json(direct.body).error}`,
  );

  // 图片模型不会被视频这条接管
  const image = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    prompt: 'x',
    imageModel: MODEL,
    projectId: PROJECT,
  });
  check(
    '视频模型名出现在图片请求里不会被当成方舟图片模型',
    !json(image.body).code?.startsWith('ARK_'),
    `${image.status} ${json(image.body).code}`,
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 没配 Key / 自定义模型 ID ===');
{
  const saved = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  const unconfigured = await generate({
    prompt: 'x',
    videoModel: MODEL,
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  process.env.ARK_API_KEY = saved;
  check(
    '没配 ARK_API_KEY → 501 ARK_NOT_CONFIGURED（并指路设置页）',
    unconfigured.status === 501 &&
      json(unconfigured.body).code === 'ARK_NOT_CONFIGURED' &&
      /火山方舟/.test(String(json(unconfigured.body).error)),
    `${unconfigured.status} ${json(unconfigured.body).code}`,
  );

  process.env[overrideKey(MODEL)] = 'ep-2026customvideo';
  const overridden = await generate({
    prompt: '自定义接入点',
    videoModel: MODEL,
    videoMode: 'text-to-video',
    projectId: PROJECT,
  });
  delete process.env[overrideKey(MODEL)];
  check(
    '界面「自定义模型 ID」覆盖目录里的模型 ID',
    overridden.status === 200 && lastSubmit()?.body?.model === 'ep-2026customvideo',
    `${overridden.status} ${lastSubmit()?.body?.model}`,
  );
}

// ---------------------------------------------------------------------------
console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
if (fail) console.log(`FAILURES: ${failures.join(' | ')}`);
upstream.close();
process.exit(fail ? 1 : 0);
