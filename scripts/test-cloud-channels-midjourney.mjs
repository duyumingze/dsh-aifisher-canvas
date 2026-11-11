/**
 * 「Midjourney 方言」回归（scripts/test-cloud-channels-midjourney.mjs）。
 *
 * 起因（2026-11-11，用户原话「帮我再画布接一下Midjourney模型」+ 价格页
 * https://api.work-fisher.com/pricing?search=Midjourney&kind=image）。
 *
 * 这套接口和同域名下的 FisherAI 图像/视频**不是一套协议**（官方文档原话：
 * 「与历史 /mj/* Discord 代理协议不是同一套」）：
 *
 *   POST {base}/midjourney/generations
 *   { model:'midjourney', prompt, size:'16:9', version:'8.1', speed:'fast', image_urls:[…] }
 *   → { code:200, data:[{ status:'submitted', task_id:'task_…' }] }
 *   GET  {base}/midjourney/tasks/{task_id}
 *   → { id, status:'SUCCESS'|'IN_PROGRESS'|'FAILURE'|'MODAL', grid_image_url, image_urls:[4 张] }
 *
 * 所以这里用真 HTTP 的假上游把六件事钉死：
 *   ① 路径 `/midjourney/generations`、请求体（没有 n / resolution，参考图叫 image_urls）；
 *   ② 任务号在 `data[0].task_id`（**数组**），轮询 `/midjourney/tasks/{id}`；
 *   ③ 一个任务固定 4 张候选：画布的「生成数量」只决定留几张，四宫格大图不算结果；
 *   ④ 参考图先 POST /files/upload 换公网直链，再放进 image_urls（不收 base64）；
 *   ⑤ FAILURE / MODAL 都要有可读的失败文案；
 *   ⑥ 同域名**不能**按地址猜成 midjourney（否则 FisherAI 的通道会全部走错协议）。
 *
 * 用法：node scripts/test-cloud-channels-midjourney.mjs   （需要先 pnpm build）
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
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

/** 1x1 透明 PNG（真字节：验落盘的确实是上游给的那张图）。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const MODEL_ID = 'midjourney-imagine';
const CHANNEL_ID = 'fisher-mj';
const CHANNEL_LABEL = 'MJ 回归';
const OK_TASK = 'task-mj-ok';
const BAD_TASK = 'task-mj-bad';
const MODAL_TASK = 'task-mj-modal';
const GRID_TASK = 'task-mj-grid';
/** 只回四宫格的任务（验「已计费的任务别白掉」的回退）。 */
const gridOnlyTasks = new Set([GRID_TASK]);
const SUBMIT_PATH = '/v1/midjourney/generations';
const POLL_PREFIX = '/v1/midjourney/tasks/';

const received = [];
let submitCount = 0;
let uploadCount = 0;
const pollCounts = new Map();

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
    const image = () => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_BYTES);
    };

    // 四张候选 + 四宫格 + 上传回来的垫图，都用同一份真 PNG 字节
    if (req.method === 'GET' && /^\/(mj-\d\.png|mj-grid\.png|uploaded-\d+\.png)/.test(String(req.url))) {
      return image();
    }

    if (req.method === 'POST' && req.url === '/v1/files/upload') {
      uploadCount += 1;
      return json(200, { code: 'success', data: { url: `${base}/uploaded-${uploadCount}.png` } });
    }

    if (req.method === 'POST' && req.url === SUBMIT_PATH) {
      submitCount += 1;
      // 请求体里的 model 恒为 midjourney（文档：不参与路由），所以用 prompt 区分三种收尾
      const prompt = String(body?.prompt ?? '');
      if (prompt.includes('doomed')) return json(200, { code: 200, data: [{ status: 'submitted', task_id: BAD_TASK }] });
      if (prompt.includes('modal')) return json(200, { code: 200, data: [{ status: 'submitted', task_id: MODAL_TASK }] });
      if (prompt.includes('gridonly')) return json(200, { code: 200, data: [{ status: 'submitted', task_id: GRID_TASK }] });
      return json(200, { code: 200, data: [{ status: 'submitted', task_id: OK_TASK }] });
    }

    if (req.method === 'GET' && req.url.startsWith(POLL_PREFIX)) {
      const taskId = decodeURIComponent(req.url.slice(POLL_PREFIX.length));
      const polls = (pollCounts.get(taskId) ?? 0) + 1;
      pollCounts.set(taskId, polls);
      if (taskId === BAD_TASK) {
        return json(200, {
          id: taskId,
          status: 'FAILURE',
          progress: '100%',
          failReason: '提示词触发了上游内容审核',
          fail_reason: '提示词触发了上游内容审核',
        });
      }
      if (taskId === MODAL_TASK) {
        return json(200, { id: taskId, status: 'MODAL', progress: '15%' });
      }
      // 第一次给排队中：验「没把 SUBMITTED/IN_PROGRESS 当结果」
      if (polls < 2) return json(200, { id: taskId, status: 'IN_PROGRESS', progress: '40%' });
      if (gridOnlyTasks.has(taskId)) {
        // 少数情况下上游只回四宫格（没有裁剪后的 image_urls）
        return json(200, {
          id: taskId,
          status: 'SUCCESS',
          progress: '100%',
          grid_image_url: `${base}/mj-grid.png`,
        });
      }
      return json(200, {
        id: taskId,
        status: 'SUCCESS',
        progress: '100%',
        action: 'IMAGINE',
        grid_image_url: `${base}/mj-grid.png`,
        image_urls: [0, 1, 2, 3].map((index) => `${base}/mj-${index}.png`),
        buttons: [
          { customId: 'MJ::JOB::upsample::1::abc', label: 'U1' },
          { customId: 'MJ::JOB::variation::1::abc', label: 'V1' },
        ],
        prompt: 'a cat',
      });
    }

    return json(404, { error: 'no such path', url: req.url });
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
  env: { AIFISHER_CLOUD_BASE_URL: null, AIFISHER_CLOUD_API_KEY: null, ARK_API_KEY: null },
});

const generate = (body) => host.dispatch('POST', '/api/aifisher/canvas/generate-image', body);
const channelsApi = (method, body) => host.hostApi(method, '/cloud-channels', body);

function diskPathOf(url) {
  const rel = decodeURIComponent(String(url).replace('/api/aifisher/canvas/media/', ''));
  return join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', ...rel.split('/'));
}

function lastSubmit() {
  return [...received].reverse().find((item) => item.method === 'POST' && item.url === SUBMIT_PATH);
}
function pollCalls() {
  return received.filter((item) => item.method === 'GET' && item.url.startsWith(POLL_PREFIX));
}

async function saveChannel(patch = {}) {
  return channelsApi('POST', {
    action: 'save',
    channel: {
      id: CHANNEL_ID,
      label: CHANNEL_LABEL,
      baseUrl: `${base}/v1`,
      apiKey: 'sk-mj-test',
      dialect: 'midjourney',
      paths: {},
      models: [{ id: MODEL_ID, kind: 'image' }],
      ...patch,
    },
  });
}

// ---------------------------------------------------------------------------
console.log('\n=== 通道：方言显式保存，同域名不被自动判成 Midjourney ===');
{
  const saved = await saveChannel();
  const channel = (saved.json().channels ?? []).find((item) => item.id === CHANNEL_ID) ?? {};
  check('保存通道：200', saved.status === 200, String(saved.status));
  check(
    '方言：显式 midjourney 存得住，dialectDetected 也是 midjourney',
    channel.dialect === 'midjourney' && channel.dialectDetected === 'midjourney',
    JSON.stringify({ dialect: channel.dialect, detected: channel.dialectDetected }),
  );
  check('密钥不回显（只有 apiKeySet）', channel.apiKey === undefined && channel.apiKeySet === true);

  // 同一个 work-fisher 域名（这里是本机假上游，所以显式指一个 work-fisher 域名）不能自动判成 midjourney：
  // 那样 FisherAI 的图像/视频通道会全部走到 Midjourney 路径上。
  const auto = await channelsApi('POST', {
    action: 'save',
    channel: {
      id: 'mj-auto-guess',
      label: '自动判定探针',
      baseUrl: 'https://api.work-fisher.com/v1',
      apiKey: 'sk-auto',
      paths: {},
      models: [{ id: MODEL_ID, kind: 'image' }],
    },
  });
  const autoChannel = (auto.json().channels ?? []).find((item) => item.id === 'mj-auto-guess') ?? {};
  check(
    '同域名「自动」→ workfisher（不会被猜成 midjourney；这类通道必须显式选）',
    autoChannel.dialect === null && autoChannel.dialectDetected === 'workfisher',
    JSON.stringify({ dialect: autoChannel.dialect, detected: autoChannel.dialectDetected }),
  );
  await channelsApi('POST', { action: 'delete', id: 'mj-auto-guess' });
}

// ---------------------------------------------------------------------------
console.log('\n=== 出图：路径 / 请求体 / data[0].task_id / 轮询路径 ===');
let firstGeneration = null;
{
  const result = await generate({
    projectId: 'proj-mj',
    nodeId: 'n-mj',
    prompt: 'a cat sitting on a windowsill, cinematic light',
    imageModel: `${CHANNEL_LABEL} · ${MODEL_ID}`,
    aspectRatio: '16:9',
    resolution: '1K',
    generateCount: 2,
    version: '8.1',
    speed: 'turbo',
  });
  const body = JSON.parse(result.body);
  firstGeneration = body;
  check('出图 → 200', result.status === 200, `status=${result.status} ${result.body.slice(0, 200)}`);

  const submit = lastSubmit() ?? {};
  check('提交路径 = /v1/midjourney/generations', submit.url === SUBMIT_PATH, String(submit.url));
  check('model 写文档里的 midjourney（计费 SKU 由路径决定，不参与路由）',
    submit.body?.model === 'midjourney', String(submit.body?.model));
  check('prompt 原样透传',
    submit.body?.prompt === 'a cat sitting on a windowsill, cinematic light',
    String(submit.body?.prompt).slice(0, 80));
  check('宽高比走 size、版本走 version、速度走 speed',
    submit.body?.size === '16:9' && submit.body?.version === '8.1' && submit.body?.speed === 'turbo',
    JSON.stringify({ size: submit.body?.size, version: submit.body?.version, speed: submit.body?.speed }));
  check('不带 n（MJ 一个任务固定 4 张，n 无效）', submit.body?.n === undefined,
    JSON.stringify(Object.keys(submit.body ?? {})).slice(0, 160));
  check('不带 resolution（MJ 没有分辨率档位）', submit.body?.resolution === undefined);
  check('没有把画布字段（projectId / nodeId / generateCount）透给端点',
    submit.body?.projectId === undefined &&
      submit.body?.nodeId === undefined &&
      submit.body?.generateCount === undefined,
    JSON.stringify(Object.keys(submit.body ?? {})).slice(0, 160));
  check('不带魔搭的异步头 X-ModelScope-Async-Mode',
    submit.headers?.['x-modelscope-async-mode'] === undefined,
    String(submit.headers?.['x-modelscope-async-mode']));
  check('鉴权头是 Bearer', submit.headers?.authorization === 'Bearer sk-mj-test');

  const polls = pollCalls();
  check(
    '任务号取自 data[0].task_id，轮询 /v1/midjourney/tasks/{id}',
    polls.length >= 2 && polls[0]?.url === `${POLL_PREFIX}${OK_TASK}`,
    `${polls.length} 次 · ${polls[0]?.url}`,
  );
  check('没把 IN_PROGRESS 当结果（至少轮询两次才收尾）', (pollCounts.get(OK_TASK) ?? 0) >= 2,
    `polls=${pollCounts.get(OK_TASK) ?? 0}`);

  check(
    '一个任务 4 张候选 → generateCount=2 只保留 2 张',
    Array.isArray(body.resultUrls) && body.resultUrls.length === 2,
    JSON.stringify(body.resultUrls ?? null),
  );
  check(
    '四宫格 grid_image_url 不算结果',
    !(body.resultUrls ?? []).some((url) => String(url).includes('mj-grid')),
    JSON.stringify(body.resultUrls ?? null).slice(0, 120),
  );
  check('返回的是本站素材 URL（临时链接已下载转存）',
    String(body.resultUrl).startsWith('/api/aifisher/canvas/media/'), String(body.resultUrl));
  const filePath = diskPathOf(body.resultUrl);
  check('结果文件真的落盘', existsSync(filePath), filePath.slice(-70));
  if (existsSync(filePath)) {
    check('落盘内容与图床字节一致', readFileSync(filePath).equals(PNG_BYTES));
  }
  check('回执带 channelDialect=midjourney（排查「图怎么不对」第一眼就看它）',
    body.channelDialect === 'midjourney' && body.channelLabel === CHANNEL_LABEL,
    JSON.stringify({ dialect: body.channelDialect, label: body.channelLabel }));
}

// ---------------------------------------------------------------------------
console.log('\n=== 生成数量：默认 1 张，超过 4 也只留 4 张；版本/速度默认值 ===');
{
  const one = await generate({
    projectId: 'proj-mj',
    prompt: '一只猫',
    imageModel: `${CHANNEL_LABEL} · ${MODEL_ID}`,
  });
  const oneBody = JSON.parse(one.body);
  check('默认 generateCount=1 → 1 张',
    one.status === 200 && Array.isArray(oneBody.resultUrls) && oneBody.resultUrls.length === 1,
    `status=${one.status} urls=${(oneBody.resultUrls ?? []).length}`);
  check('节点没给 version/speed 时请求体里也不带（由端点默认）',
    lastSubmit()?.body?.version === undefined && lastSubmit()?.body?.speed === undefined,
    JSON.stringify({ version: lastSubmit()?.body?.version, speed: lastSubmit()?.body?.speed }));

  const eight = await generate({
    projectId: 'proj-mj',
    prompt: '八张',
    imageModel: `${CHANNEL_LABEL} · ${MODEL_ID}`,
    generateCount: 8,
  });
  const eightBody = JSON.parse(eight.body);
  check('生成数量 8 → 只有 4 张候选（不凭空多出图）',
    eight.status === 200 && (eightBody.resultUrls ?? []).length === 4,
    `status=${eight.status} urls=${(eightBody.resultUrls ?? []).length}`);

  // 只回四宫格的上游：任务已计费，至少把那张图交出去（不报「没认出结果」）
  const grid = await generate({
    projectId: 'proj-mj',
    prompt: 'gridonly',
    imageModel: `${CHANNEL_LABEL} · ${MODEL_ID}`,
  });
  const gridBody = JSON.parse(grid.body);
  check('上游只回四宫格时回退成 1 张图（已计费的任务不白掉）',
    grid.status === 200 && (gridBody.resultUrls ?? []).length === 1,
    `status=${grid.status} ${grid.body.slice(0, 160)}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 参考图：先 /files/upload 换公网直链，再放进 image_urls ===');
{
  const before = received.length;
  const result = await generate({
    projectId: 'proj-mj',
    prompt: '把这张图改成水彩',
    imageModel: `${CHANNEL_LABEL} · ${MODEL_ID}`,
    imageBase64: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
  });
  const calls = received.slice(before);
  const upload = calls.find((item) => item.method === 'POST' && item.url === '/v1/files/upload');
  const post = calls.find((item) => item.method === 'POST' && item.url === SUBMIT_PATH);
  check('参考图先 POST /v1/files/upload 换公网直链', Boolean(upload),
    JSON.stringify(calls.map((item) => [item.method, item.url])));
  check(
    '请求体里 image_urls 是上传回来的直链，不是 data URL',
    Array.isArray(post?.body?.image_urls) &&
      post.body.image_urls.length === 1 &&
      /^https?:\/\/.+uploaded-\d+\.png$/.test(String(post.body.image_urls[0])),
    JSON.stringify(post?.body?.image_urls).slice(0, 160),
  );
  check(
    '不带 FisherAI 的 images / OpenAI 的 image / 魔搭的 image_url（带了会被静默丢掉）',
    post?.body?.images === undefined &&
      post?.body?.image === undefined &&
      post?.body?.image_url === undefined,
    JSON.stringify(Object.keys(post?.body ?? {})),
  );
  check('带参考图那次仍然出图成功',
    result.status === 200 && String(JSON.parse(result.body).resultUrl).startsWith('/api/aifisher/canvas/media/'),
    `${result.status} ${result.body.slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 失败形状：FAILURE / MODAL / 非图像节点 ===');
{
  const failed = await generate({
    projectId: 'proj-mj',
    prompt: 'doomed',
    imageModel: `${CHANNEL_LABEL} · ${MODEL_ID}`,
  });
  const failedBody = JSON.parse(failed.body);
  check('任务失败 → 502', failed.status === 502, `status=${failed.status} ${failed.body.slice(0, 160)}`);
  check('错误码是 CHANNEL_TASK_FAILED', failedBody.code === 'CHANNEL_TASK_FAILED', String(failedBody.code));
  check('把端点原话带回来', String(failedBody.error).includes('内容审核'), String(failedBody.error).slice(0, 160));
  check('带任务号，方便去端点后台查', String(failedBody.taskId) === BAD_TASK, String(failedBody.taskId));

  const modal = await generate({
    projectId: 'proj-mj',
    prompt: 'modal',
    imageModel: `${CHANNEL_LABEL} · ${MODEL_ID}`,
  });
  const modalBody = JSON.parse(modal.body);
  check('MODAL 按失败报，不等 15 分钟超时', modal.status === 502 && modalBody.code === 'CHANNEL_TASK_FAILED',
    `status=${modal.status} code=${modalBody.code}`);
  check('MODAL 的文案说清了「等待补参数 / 画布不支持二次补参」',
    /MODAL/.test(String(modalBody.error)) && /补参/.test(String(modalBody.error)),
    String(modalBody.error).slice(0, 160));

  // ① 把 MJ 的模型勾成图片模型、却接到视频节点：先被「模型类型不匹配」挡住（也是 422）
  const video = await host.dispatch('POST', '/api/aifisher/canvas/generate-video', {
    projectId: 'proj-mj',
    prompt: '镜头推进',
    videoModel: `${CHANNEL_LABEL} · ${MODEL_ID}`,
  });
  const videoBody = JSON.parse(video.body);
  check('图片模型接到视频节点 → 422 CHANNEL_KIND_MISMATCH',
    video.status === 422 && videoBody.code === 'CHANNEL_KIND_MISMATCH',
    `${video.status} ${video.body.slice(0, 160)}`);

  // ② 真勾成视频模型（比如 midjourney-video）时，方言层也要说清「只翻了图像」
  await saveChannel({ models: [{ id: 'midjourney-video', kind: 'video' }] });
  const videoGen = await host.dispatch('POST', '/api/aifisher/canvas/generate-video', {
    projectId: 'proj-mj',
    prompt: '镜头推进',
    videoModel: `${CHANNEL_LABEL} · midjourney-video`,
  });
  const videoGenBody = JSON.parse(videoGen.body);
  check('Midjourney 方言接视频节点 → 422（说清只翻了图像）',
    videoGen.status === 422 && videoGenBody.code === 'CHANNEL_KIND_UNSUPPORTED',
    `${videoGen.status} ${videoGen.body.slice(0, 160)}`);
  await saveChannel();
}

// ---------------------------------------------------------------------------
console.log('\n=== 产物契约 ===');
{
  const hostBundle = readFileSync(resolve(ROOT, 'lib/index.js'), 'utf8');
  check('产物里有 Midjourney 提交路径', hostBundle.includes('midjourney/generations'));
  check('产物里有 Midjourney 轮询路径', hostBundle.includes('midjourney/tasks/'));
}

upstream.close();
console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
if (fail) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
}
process.exit(fail ? 1 : 0);
