/**
 * 「自配 OpenAI 通道（多通道 + 每通道多模型）」回归（scripts/test-cloud-channels.mjs）。
 *
 * 起因（2026-10-16，用户原话「OpenAI通道我希望可以配置好几个，并且可以选择多条单独模型」）：
 * v1.4 起本插件只能配**一个** OpenAI 兼容端点（AIFISHER_CLOUD_BASE_URL），模型也只能从 vendor
 * 静态目录里挑，想用魔搭/中转站真实的模型 ID 时每个目录条目只能存一个覆盖值。
 * v1.11 把这些做成「通道」：一条通道 = 名称 + Base URL + API Key + 它提供哪些模型（可多选）。
 * v1.13 起那条旧的单端点**整体下架**（设置卡片、可写白名单、生成兜底、importLegacy 全没了），
 * 所以这里也顺手钉住「旧面已经不存在」的几条断言。
 *
 * 这条用例验三层：
 *   ① host 侧通道表：CRUD / 探测（GET /models）/ 密钥不回显 / 旧单端点已下架；
 *   ② 请求翻译：画布请求 → `{model, prompt, n, size, 参考图字段…}`（**不带**画布内部字段），
 *      并且按模型名分发到正确的通道；类型不匹配时给可读的 422；
 *      **请求方言**（openai 用 `image` / 魔搭用 `image_url`）与「n 无效就真的提交几次」
 *      也钉在这里（见 3c）—— 那条静默出错路径没有任何报错可依赖，只能靠断言守；
 *   ③ 画布侧：真挂画布，确认「运行时注册表」把通道模型塞进 vendor 目录、下拉白名单放行，
 *      并且点生图按钮能把请求打到该通道的假端点上、结果落素材库。
 *
 * 用法：node scripts/test-cloud-channels.mjs   （需要先 pnpm build）
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCanvasDom,
  mountCanvasApp,
  seedResume,
  settle,
  startHost,
} from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}

/** 1x1 透明 PNG（真字节：验落盘的确实是上游给的那张图）。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const IMAGE_MODEL_ID = 'Qwen/Qwen-Image';
const TEXT_MODEL_ID = 'Qwen/Qwen3-VL-30B';
const CHANNEL_LABEL = '魔搭 ModelScope';
/** 画布上的模型名 = `${通道名} · ${模型 ID}`（两个通道有同名模型时靠它分辨）。 */
const IMAGE_MODEL_NAME = `${CHANNEL_LABEL} · ${IMAGE_MODEL_ID}`;
const TEXT_MODEL_NAME = `${CHANNEL_LABEL} · ${TEXT_MODEL_ID}`;
/** 自定义模型名（别名）：填了它，画布上就显示这个短名字（见「自定义模型名」一节）。 */
const IMAGE_MODEL_ALIAS = '魔搭出图';
const PROJECT_ID = 'proj-cloud-channels';
const NODE_ID = 'node-channel-image';
const TEXT_REPLY = '你好，我是自配通道。';
/** 异步任务（魔搭那套）用的模型与任务号。 */
const ASYNC_MODEL_ID = 'async/Image-Async';
const ASYNC_FAIL_MODEL_ID = 'async/Image-Doomed';
const ASYNC_TASK_ID = 'task-ok';
const ASYNC_FAIL_TASK_ID = 'task-bad';
let asyncPolls = 0;
/** 魔搭方言那条通道的模型：请求形状按魔搭来（参考图放 image_url）。 */
const MS_MODEL_ID = 'ms/Qwen-Image-Turbo';
let msCalls = 0;
/**
 * FisherAI（work-fisher）方言那条通道的模型：**异步任务网关**
 * （POST /image/generations 回 task_id → 轮询 /image/generations/{id}），
 * 参考图必须先 POST /files/upload 换成公网直链再放进 `images`。
 */
const WF_MODEL_ID = 'workfisher-image-g-v2.5-lowprice';
const WF_FAIL_MODEL_ID = 'workfisher-image-g-v2.5-Doomed';
let wfUploads = 0;
/** 上传请求**尝试次数**（含被掐断的），用来量「重试真的发生了」。 */
let wfUploadAttempts = 0;
/** 还要掐断几次上传（模拟瞬时 ECONNRESET）。 */
let wfUploadFaults = 0;
/** 一直掐断（模拟链路彻底不通）。 */
let wfUploadDead = false;
let wfTaskSeq = 0;
/**
 * v1.31「画布节点上要看得见 403 的真原因」：打开后通用图片路由一律回 403 额度不足。
 * 用它把**同一个节点**第二次生成打成 403，验节点上的 errorMessage 没被 vendor 改写成
 * 「权限被拒绝。请检查 API Key 配置。」（那种改写会把「余额不足」误导成「密钥配错」）。
 */
let quotaGate = false;
const wfPolls = new Map();

// ---------------------------------------------------------------- 假 OpenAI 兼容端点

const received = [];
let base = '';
const upstream = createServer((req, res) => {
  // ---- FisherAI 上传链路：可以按开关「把连接掐掉」（模拟 ECONNRESET / socket hang up）----
  // 2026-10-17 用户报障「上传参考素材到通道「Fisher」失败：fetch failed（ECONNRESET）」：
  // 上传免费、可安全重放，所以这里守的就是「掐断一次 → 自己再试一次就好」「一直断 → 给可读回执」。
  if (req.method === 'POST' && req.url === '/v1/files/upload') {
    wfUploadAttempts += 1;
    if (wfUploadDead || wfUploadFaults > 0) {
      if (!wfUploadDead) wfUploadFaults -= 1;
      // 用 RST 关（而不是普通 FIN）：客户端看到的就是用户那条报错里的 ECONNRESET
      req.socket.resetAndDestroy?.() ?? req.socket.destroy();
      return;
    }
  }
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
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      return json(200, {
        object: 'list',
        data: [
          { id: IMAGE_MODEL_ID },
          { id: 'Qwen/Qwen-Image-Edit' },
          { id: 'Wan2.2-T2V-A14B' },
          { id: TEXT_MODEL_ID },
        ],
      });
    }
    if (req.method === 'GET' && /^\/result-[\w-]+\.png$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG_BYTES);
    }
    // ---- 魔搭方言那条通道的专用模型：每次提交回一个**不同**的结果 URL ----
    // （按次提交要把多份结果合并，撞成同一个 URL 会被去重掉，就验不出「真的提交了几次」）
    if (
      req.url === '/v1/images/generations' &&
      typeof body?.model === 'string' &&
      body.model.startsWith('ms/')
    ) {
      msCalls += 1;
      return json(200, { created: 1, model: body.model, data: [{ url: `${base}/result-ms-${msCalls}.png` }] });
    }
    // ---- 异步任务端点（魔搭那套：POST 只回 task_id，结果要轮询 /tasks/{id}）----
    if (req.url === '/v1/images/generations' && body?.model === ASYNC_MODEL_ID) {
      // 刻意把 task_status 写成 SUCCEED（魔搭实测就是这样，**不能信**它，必须去轮询）
      return json(200, { task_id: ASYNC_TASK_ID, task_status: 'SUCCEED', request_id: 'r1' });
    }
    if (req.url === '/v1/images/generations' && body?.model === ASYNC_FAIL_MODEL_ID) {
      return json(200, { task_id: ASYNC_FAIL_TASK_ID, task_status: 'RUNNING' });
    }
    if (req.method === 'GET' && req.url === `/v1/tasks/${ASYNC_TASK_ID}`) {
      asyncPolls += 1;
      if (asyncPolls === 1) return json(200, { task_id: ASYNC_TASK_ID, task_status: 'RUNNING', outputs: {} });
      return json(200, {
        task_id: ASYNC_TASK_ID,
        task_status: 'SUCCEED',
        output_images: [`${base}/result-2.png`],
      });
    }
    if (req.method === 'GET' && req.url === `/v1/tasks/${ASYNC_FAIL_TASK_ID}`) {
      return json(200, {
        task_id: ASYNC_FAIL_TASK_ID,
        task_status: 'FAILED',
        errors: { code: 500, message: '显存不够' },
      });
    }
    // ---- FisherAI（work-fisher）方言：/image/generations 是异步任务网关 ----
    // 真实形状（上游 relayProvider.js 实读）：提交回 {code,data:{task_id,status}}，
    // 轮询回 {code,data:{status,data:{content:{image_urls}},usage}}，状态机全大写。
    if (req.method === 'POST' && req.url === '/v1/files/upload') {
      wfUploads += 1;
      return json(200, { code: 'success', data: { url: `${base}/uploaded-${wfUploads}.png` } });
    }
    if (req.method === 'POST' && req.url === '/v1/image/generations') {
      const model = String(body?.model ?? '');
      if (model === WF_FAIL_MODEL_ID) {
        return json(200, { code: 'success', data: { task_id: 'wf-bad', status: 'SUBMITTED' } });
      }
      if (model.startsWith('workfisher-image-')) {
        return json(200, {
          code: 'success',
          data: { task_id: `wf-${++wfTaskSeq}`, status: 'SUBMITTED' },
        });
      }
    }
    if (req.method === 'GET' && /^\/v1\/image\/generations\/wf-(?:\d+|bad)$/.test(req.url)) {
      const taskId = req.url.split('/').pop();
      const polls = (wfPolls.get(taskId) ?? 0) + 1;
      wfPolls.set(taskId, polls);
      if (taskId === 'wf-bad' && polls >= 2) {
        return json(200, {
          code: 'success',
          data: { task_id: taskId, status: 'FAILURE', fail_reason: '内容未通过审核' },
        });
      }
      // 第一次故意回 IN_PROGRESS：证明我们真的等到了终态，而不是拿提交回执当结果
      if (polls === 1) return json(200, { code: 'success', data: { task_id: taskId, status: 'IN_PROGRESS' } });
      return json(200, {
        code: 'success',
        data: {
          task_id: taskId,
          status: 'SUCCESS',
          data: { content: { image_urls: [`${base}/result-${taskId}.png`] } },
          usage: { amount: 0.05355, currency: 'CNY' },
        },
      });
    }
    // ---- 额度不足（403）：上游原话照传，另外补一句人话 ----
    if (req.url === '/v1/images/generations' && body?.model === 'quota/Exhausted') {
      return json(403, { code: 'insufficient_user_quota', message: '用户额度不足，无法预扣 ¥0.048752' });
    }
    if (req.url === '/v1/images/generations') {
      if (quotaGate) {
        return json(403, {
          code: 'insufficient_user_quota',
          message: '用户额度不足，无法预扣 ¥0.048752',
        });
      }
      return json(200, { created: 1, model: body?.model, data: [{ url: `${base}/result-1.png` }] });
    }
    if (req.url === '/v1/chat/completions') {
      return json(200, {
        model: body?.model,
        choices: [{ message: { role: 'assistant', content: TEXT_REPLY } }],
      });
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no such path' }, path: req.url }));
  });
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
base = `http://127.0.0.1:${upstream.address().port}`;
const CHANNEL_BASE_URL = `${base}/v1`;

// ---------------------------------------------------------------- host 半

const host = await startHost({
  env: {
    // 这轮测的是自配通道：旧单端点（v1.13 已移除）与方舟都清掉，
    // 免得环境里残留的 AIFISHER_CLOUD_* 影响判断（它们的用例在 test-cloud-generation /
    // test-ark-generation 里）
    AIFISHER_CLOUD_BASE_URL: null,
    AIFISHER_CLOUD_API_KEY: null,
    ARK_API_KEY: null,
  },
});

const channelsApi = (method, path = '', body) => host.hostApi(method, `/cloud-channels${path}`, body);

/** 往假素材库里塞一张真字节图片，返回画布节点上那种本站 URL。 */
function seedLibraryImage(filename) {
  const dir = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', PROJECT_ID, 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), PNG_BYTES);
  return `/api/aifisher/canvas/media/${PROJECT_ID}/images/${filename}`;
}

// ---- 1. 通道表 CRUD + 探测 -------------------------------------------------

console.log('\n=== 通道表：读取 / 探测 / 保存 ===');
{
  const empty = await channelsApi('GET');
  const body = empty.json();
  check('空表：GET /cloud-channels 200', empty.status === 200, String(empty.status));
  check('空表：channels = []', Array.isArray(body.channels) && body.channels.length === 0);
  check(
    '空表：响应里已经没有 legacy 字段（v1.13 移除自配单端点）',
    body.legacy === undefined,
    JSON.stringify(body.legacy),
  );

  const probeCountBefore = received.length;
  const probe = await channelsApi('POST', '', {
    action: 'probe',
    baseUrl: CHANNEL_BASE_URL,
    apiKey: 'sk-channel-1',
  });
  const probeBody = probe.json();
  check('探测：GET {baseUrl}/models 成功', probe.status === 200, String(probe.status));
  check('探测：4 个模型 ID 都读到了', probeBody.models?.length === 4, JSON.stringify(probeBody.models));
  check(
    '探测：把 API Key 作为 Bearer 发出去',
    received
      .slice(probeCountBefore)
      .some((item) => item.headers?.authorization === 'Bearer sk-channel-1'),
    JSON.stringify(received.slice(probeCountBefore).map((item) => item.headers?.authorization)),
  );

  const unreachable = await channelsApi('POST', '', {
    action: 'probe',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-x',
  });
  check(
    '探测：端点不可达 → 502 CHANNEL_UNREACHABLE',
    unreachable.status === 502 && unreachable.json().code === 'CHANNEL_UNREACHABLE',
    `${unreachable.status} ${unreachable.text.slice(0, 120)}`,
  );

  const badUrl = await channelsApi('POST', '', {
    action: 'save',
    channel: { label: 'x', baseUrl: 'not-a-url' },
  });
  check(
    '保存：Base URL 不合法 → 422 CHANNEL_BASE_URL_INVALID',
    badUrl.status === 422 && badUrl.json().code === 'CHANNEL_BASE_URL_INVALID',
    `${badUrl.status} ${badUrl.text.slice(0, 120)}`,
  );

  const save = await channelsApi('POST', '', {
    action: 'save',
    channel: {
      label: CHANNEL_LABEL,
      baseUrl: CHANNEL_BASE_URL,
      apiKey: 'sk-channel-1',
      models: [
        { id: IMAGE_MODEL_ID, kind: 'image' },
        { id: TEXT_MODEL_ID, kind: 'text' },
        { id: 'Wan2.2-T2V-A14B', kind: 'video' },
      ],
    },
  });
  const savedBody = save.json();
  check(
    '保存：200 并回整张表',
    save.status === 200 && savedBody.channels?.length === 1,
    `${save.status} ${save.text.slice(0, 160)}`,
  );
  const saved = savedBody.channels?.[0] ?? {};
  check('保存：模型三条都进去了', saved.models?.length === 3, JSON.stringify(saved.models));
  check(
    '保存：密钥**不**回显（apiKeySet 才是给界面的字段）',
    saved.apiKey === undefined && saved.apiKeySet === true,
    JSON.stringify(saved),
  );
  check('保存：整张表里没有密钥值', !save.text.includes('sk-channel-1'), save.text.slice(0, 200));
  const channelId = saved.id;

  const listed = (await channelsApi('GET')).json();
  check(
    '再读一次：通道还在、三条模型都在',
    listed.channels?.length === 1 && listed.channels[0].models?.length === 3,
    JSON.stringify(listed.channels?.[0]?.models),
  );

  // ---- 2. 模型可用性（画布下拉的数据源）-----------------------------------
  const availability = (
    await host.hostApi('GET', '/generation/model-availability?resolution=1K&aspectRatio=1:1')
  ).json();
  const group = (availability.groups ?? []).find((item) => item.canonicalModel === IMAGE_MODEL_NAME);
  check(
    '可用性：通道模型成了一个模型组',
    Boolean(group),
    JSON.stringify((availability.groups ?? []).map((g) => g.canonicalModel)).slice(0, 200),
  );
  const variant = group?.variants?.[0];
  check('可用性：来源名是通道名', variant?.sourceLabel === CHANNEL_LABEL, String(variant?.sourceLabel));
  check(
    '可用性：标成已连接（否则画布下拉里不显示）',
    variant?.configured === true,
    String(variant?.configured),
  );
  check(
    '可用性：不编价格（null + 说明）',
    variant?.price === null && String(variant?.priceNote).includes('端点'),
    JSON.stringify(variant?.priceNote),
  );

  // ---- 3. 生成分发：图片 / 文本 / 类型不匹配 ------------------------------
  console.log('\n=== 生成分发 ===');
  const before = received.length;
  const image = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: PROJECT_ID,
    nodeId: NODE_ID,
    prompt: '一只猫在雨里走过霓虹街道',
    imageModel: IMAGE_MODEL_NAME,
    resolution: '1K',
    aspectRatio: '16:9',
    generateCount: 2,
  });
  const imageBody = JSON.parse(image.body);
  const call = received.slice(before).find((item) => item.url === '/v1/images/generations');
  check(
    '图片：请求打到通道的 /v1/images/generations',
    Boolean(call),
    JSON.stringify(received.slice(before).map((i) => i.url)),
  );
  check('图片：发出去的是**纯模型 ID**', call?.body?.model === IMAGE_MODEL_ID, String(call?.body?.model));
  check(
    '图片：提示词原样带过去',
    call?.body?.prompt === '一只猫在雨里走过霓虹街道',
    String(call?.body?.prompt),
  );
  check('图片：1K + 16:9 → 1024x576', call?.body?.size === '1024x576', String(call?.body?.size));
  check('图片：生成数量 → n', call?.body?.n === 2, String(call?.body?.n));
  check(
    '图片：鉴权用通道自己的 Key',
    call?.headers?.authorization === 'Bearer sk-channel-1',
    String(call?.headers?.authorization),
  );
  check(
    '图片：**不**把画布内部字段透给端点（imageModel/nodeId/projectId）',
    call?.body?.imageModel === undefined &&
      call?.body?.nodeId === undefined &&
      call?.body?.projectId === undefined,
    JSON.stringify(Object.keys(call?.body ?? {})),
  );
  check(
    '图片：200 且结果落素材库',
    image.status === 200 && String(imageBody.resultUrl).startsWith('/api/aifisher/canvas/media/'),
    `${image.status} ${String(imageBody.resultUrl).slice(0, 80)}`,
  );
  check(
    '图片：回执里带通道信息（排查用）',
    imageBody.channel === channelId && imageBody.channelLabel === CHANNEL_LABEL,
    JSON.stringify({ channel: imageBody.channel, label: imageBody.channelLabel }),
  );
  check(
    '图片：结果字节真的落盘',
    (() => {
      if (!imageBody.resultUrl) return false;
      const rel = decodeURIComponent(
        String(imageBody.resultUrl).split('?')[0].replace('/api/aifisher/canvas/media/', ''),
      );
      return existsSync(
        join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', ...rel.split('/')),
      );
    })(),
    String(imageBody.resultUrl).slice(0, 80),
  );

  const text = await host.dispatch('POST', '/api/aifisher/canvas/generate-text', {
    projectId: PROJECT_ID,
    prompt: '打个招呼',
    textModel: TEXT_MODEL_NAME,
  });
  const textBody = JSON.parse(text.body);
  const textCall = received.find((item) => item.url === '/v1/chat/completions');
  check('文本：打到通道的 /v1/chat/completions', Boolean(textCall), JSON.stringify(received.map((i) => i.url)));
  check('文本：model = 纯模型 ID', textCall?.body?.model === TEXT_MODEL_ID, String(textCall?.body?.model));
  check(
    '文本：没有 messages 时包成 chat 请求',
    textCall?.body?.messages?.[0]?.content === '打个招呼',
    JSON.stringify(textCall?.body).slice(0, 120),
  );
  check('文本：结果文本取回来了', textBody.text === TEXT_REPLY, JSON.stringify(textBody.text));

  // ---- 3b. 异步任务：POST 只回 task_id，结果要轮询（魔搭实测）----------------
  console.log('\n=== 异步任务（task_id 轮询） ===');
  {
    const widened = await channelsApi('POST', '', {
      action: 'save',
      channel: {
        id: channelId,
        label: CHANNEL_LABEL,
        baseUrl: CHANNEL_BASE_URL,
        models: [
          { id: IMAGE_MODEL_ID, kind: 'image' },
          { id: TEXT_MODEL_ID, kind: 'text' },
          { id: 'Wan2.2-T2V-A14B', kind: 'video' },
          { id: ASYNC_MODEL_ID, kind: 'image' },
          { id: ASYNC_FAIL_MODEL_ID, kind: 'image' },
        ],
      },
    });
    check(
      '通道扩到 5 条模型（含两条异步）',
      widened.status === 200 && widened.json().channels?.[0]?.models?.length === 5,
      `${widened.status} ${widened.text.slice(0, 140)}`,
    );

    const asyncStart = received.length;
    const done = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '异步出图',
      imageModel: `${CHANNEL_LABEL} · ${ASYNC_MODEL_ID}`,
      resolution: '1K',
      aspectRatio: '1:1',
    });
    const doneBody = JSON.parse(done.body);
    const calls = received.slice(asyncStart);
    const post = calls.find((item) => item.url === '/v1/images/generations');
    check(
      '异步：POST 带 X-ModelScope-Async-Mode（魔搭要靠它才真建任务）',
      post?.headers?.['x-modelscope-async-mode'] === 'true',
      String(post?.headers?.['x-modelscope-async-mode']),
    );
    const polls = calls.filter((item) => item.url === `/v1/tasks/${ASYNC_TASK_ID}`);
    check('异步：POST 回 task_id → 轮询 /tasks/{id}', polls.length >= 2, String(polls.length));
    check(
      '异步：轮询带 X-ModelScope-Task-Type: image_generation',
      polls[0]?.headers?.['x-modelscope-task-type'] === 'image_generation',
      String(polls[0]?.headers?.['x-modelscope-task-type']),
    );
    check(
      '异步：不把 POST 里的 task_status=SUCCEED 当结果（RUNNING 时继续轮询）',
      polls.length >= 2 && done.status === 200,
      `polls=${polls.length} status=${done.status}`,
    );
    check(
      '异步：收尾 output_images 被认出来并落素材库',
      done.status === 200 && String(doneBody.resultUrl).startsWith('/api/aifisher/canvas/media/'),
      `${done.status} ${String(doneBody.resultUrl).slice(0, 80)}`,
    );

    const failed = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '注定失败',
      imageModel: `${CHANNEL_LABEL} · ${ASYNC_FAIL_MODEL_ID}`,
      resolution: '1K',
      aspectRatio: '1:1',
    });
    const failedBody = JSON.parse(failed.body);
    check(
      '异步：任务 FAILED → 502 CHANNEL_TASK_FAILED 且带上端点给的原因',
      failed.status === 502 && failedBody.code === 'CHANNEL_TASK_FAILED' &&
        String(failedBody.error).includes('显存不够'),
      `${failed.status} ${failed.body.slice(0, 160)}`,
    );
  }

  // ---- 3c. 请求方言：参考图放哪个字段（魔搭只认 image_url）-----------------
  //
  // 2026-10-17 真机取证（scripts/verify-live-modelscope.mjs 复现）：同一张**纯红**参考图 +
  // 一个**一个字都没提颜色**的 prompt「保持原样输出」，看输出里的近红像素比例 ——
  //   image_url（数组）→ 100%；image → 9%；不带参考图 → 0%。
  // 即：用 `image` 时魔搭**不报错、不回 400，直接把参考图丢掉**按纯文生图跑完，
  // 于是「图片编辑」静默变成「重新画一张」。所以方言必须钉死在这个字段上。
  console.log('\n=== 请求方言（参考图字段 / 生成数量） ===');
  const REFERENCE = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
  {
    // ① 没显式配 → 按地址判定（这条通道只为验判定规则，存完即删，别影响后面的条数断言）
    const auto = await channelsApi('POST', '', {
      action: 'save',
      channel: { label: '魔搭自动判定', baseUrl: 'https://api-inference.modelscope.cn/v1', models: [] },
    });
    const autoChannels = auto.json().channels ?? [];
    const autoChannel = autoChannels.find((item) => item.label === '魔搭自动判定') ?? {};
    check(
      '方言：没配时按 Base URL 判定 —— 魔搭域名 → modelscope，本机地址 → openai',
      auto.status === 200 &&
        autoChannel.dialect === null &&
        autoChannel.dialectDetected === 'modelscope' &&
        autoChannels.find((item) => item.id === channelId)?.dialectDetected === 'openai',
      JSON.stringify(autoChannels.map((item) => [item.baseUrl, item.dialect, item.dialectDetected])),
    );
    await channelsApi('POST', '', { action: 'delete', id: autoChannel.id });

    // ② 显式方言优先于地址
    const msSave = await channelsApi('POST', '', {
      action: 'save',
      channel: {
        label: '魔搭方言',
        baseUrl: CHANNEL_BASE_URL,
        apiKey: 'sk-ms',
        dialect: 'modelscope',
        models: [{ id: MS_MODEL_ID, kind: 'image' }],
      },
    });
    const msChannel = (msSave.json().channels ?? []).find((item) => item.label === '魔搭方言') ?? {};
    check(
      '方言：显式 modelscope 存得住，且压过地址判定（本机地址本来会判成 openai）',
      msSave.status === 200 &&
        msChannel.dialect === 'modelscope' &&
        msChannel.dialectDetected === 'modelscope',
      JSON.stringify({ dialect: msChannel.dialect, detected: msChannel.dialectDetected }),
    );

    // ③ OpenAI 兼容那条仍是 `image`（单张给字符串）—— 不能为了魔搭把别家一起改了
    const beforeRef = received.length;
    await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '加一顶帽子',
      imageModel: IMAGE_MODEL_NAME,
      resolution: '1K',
      aspectRatio: '1:1',
      imageBase64: [REFERENCE],
    });
    const refCall = received.slice(beforeRef).find((item) => item.url === '/v1/images/generations');
    check(
      '方言：OpenAI 兼容那条照旧用 image（单张 = 字符串，没有 image_url）',
      refCall?.body?.image === REFERENCE && refCall?.body?.image_url === undefined,
      JSON.stringify(Object.keys(refCall?.body ?? {})),
    );

    // ④ 魔搭那条：参考图进 image_url（数组）、不带 n、按数量真的提交三次
    const msBefore = received.length;
    const msGen = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '给这张图加一顶帽子',
      imageModel: `魔搭方言 · ${MS_MODEL_ID}`,
      resolution: '1K',
      aspectRatio: '1:1',
      generateCount: 3,
      imageBase64: [REFERENCE],
    });
    const msBody = JSON.parse(msGen.body);
    const msPosts = received
      .slice(msBefore)
      .filter((item) => item.url === '/v1/images/generations');
    check(
      '方言：参考图放 image_url（数组），值就是画布送来的 data URL（不经公网也能编辑）',
      msPosts.length > 0 &&
        Array.isArray(msPosts[0]?.body?.image_url) &&
        msPosts[0].body.image_url[0] === REFERENCE,
      JSON.stringify(msPosts[0]?.body?.image_url).slice(0, 120),
    );
    check(
      '方言：**不**再带 OpenAI 的 image 字段（带了也会被静默丢掉）',
      msPosts.length > 0 && msPosts.every((item) => item.body?.image === undefined),
      JSON.stringify(msPosts.map((item) => Object.keys(item.body ?? {}))),
    );
    check(
      '方言：魔搭不认 n → 不带 n，改成真的提交 3 次（叫几张就有几张）',
      msPosts.length === 3 && msPosts.every((item) => item.body?.n === undefined),
      `posts=${msPosts.length} bodies=${JSON.stringify(msPosts.map((item) => item.body?.n))}`,
    );
    check(
      '方言：三次的结果合并成 3 张（resultUrls）',
      msGen.status === 200 && msBody.resultUrls?.length === 3,
      `${msGen.status} ${JSON.stringify(msBody.resultUrls)}`,
    );
    check(
      '方言：三张都落进素材库',
      (msBody.resultUrls ?? []).every((url) => String(url).startsWith('/api/aifisher/canvas/media/')),
      JSON.stringify(msBody.resultUrls),
    );
    check(
      '方言：回执里带 channelDialect（排查「图怎么不像编辑的」时第一眼就看它）',
      msBody.channelDialect === 'modelscope' && msBody.channelLabel === '魔搭方言',
      JSON.stringify({ dialect: msBody.channelDialect, label: msBody.channelLabel }),
    );

    // ⑤ 不认识的方言值 → 当「自动」（不留一个写死的错值赖着）
    const bogus = await channelsApi('POST', '', {
      action: 'save',
      channel: {
        id: msChannel.id,
        label: '魔搭方言',
        baseUrl: CHANNEL_BASE_URL,
        dialect: 'not-a-dialect',
        models: [{ id: MS_MODEL_ID, kind: 'image' }],
      },
    });
    const bogusChannel = (bogus.json().channels ?? []).find((item) => item.id === msChannel.id) ?? {};
    check(
      '方言：不认识的取值被丢掉 = 回到自动（按地址判定 openai）',
      bogusChannel.dialect === null && bogusChannel.dialectDetected === 'openai',
      JSON.stringify({ dialect: bogusChannel.dialect, detected: bogusChannel.dialectDetected }),
    );

    // 收尾：这条通道只为上面几验存在，删掉，别影响后面「两条通道」的条数断言
    await channelsApi('POST', '', { action: 'delete', id: msChannel.id });
  }

  // ---- 3c-bis. 参考素材：画布的结果 URL 带缓存戳（?t=）也要读得懂 ----------------
  //
  // 2026-10-17 用户截图报障：节点上「参考素材读不出来：/api/aifisher/canvas/media/<项目>/images/
  // media-f3e89ede.png?t=1792243183952」。那串 `?t=` 是 vendor `withTimestamp()` 给 <img> 破缓存
  // 挂的，而同一个 URL 正好是**下一张图的参考素材** —— host 半必须按「URL 去掉查询串 = 素材身份」
  // 解析（mediaStore.parseMediaUrlRef），否则「拿刚生成的图再编辑一次」永远失败。
  // 另一半诉求：素材已被删时不能再说「外链图片请先下载到素材库」（方向说反了）。
  console.log('\n=== 参考素材：缓存戳（?t=）与已删除素材 ===');
  {
    const plain = seedLibraryImage('ref-plain.png');
    const stamped = `${plain}?t=1792243183952`;

    const before = received.length;
    const gen = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '加一顶帽子',
      imageModel: IMAGE_MODEL_NAME,
      resolution: '1K',
      aspectRatio: '1:1',
      imageBase64: [stamped],
    });
    const call = received.slice(before).find((item) => item.url === '/v1/images/generations');
    check(
      '缓存戳：画布的结果 URL（带 ?t=…）照样被内联给端点',
      gen.status === 200 && String(call?.body?.image).startsWith('data:image/png;base64,'),
      `${gen.status} ${String(call?.body?.image).slice(0, 40)}`,
    );
    check(
      '缓存戳：内联的字节就是素材文件本身（?t= 没被算进文件名）',
      String(call?.body?.image) === `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      String(call?.body?.image).slice(-24),
    );

    const gone = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '加一顶帽子',
      imageModel: IMAGE_MODEL_NAME,
      resolution: '1K',
      aspectRatio: '1:1',
      imageBase64: [`/api/aifisher/canvas/media/${PROJECT_ID}/images/gone-forever.png?t=1`],
    });
    const goneBody = JSON.parse(gone.body);
    check(
      '素材已不在库里 → 404 CHANNEL_REFERENCE_MISSING（不再是那句「外链图片请先下载」）',
      gone.status === 404 && goneBody.code === 'CHANNEL_REFERENCE_MISSING',
      `${gone.status} ${goneBody.code} ${String(goneBody.error).slice(0, 60)}`,
    );
    check(
      '素材已不在库里的文案说的是「已不在素材库里」',
      String(goneBody.error).includes('已不在素材库里'),
      String(goneBody.error).slice(0, 80),
    );
  }

  // ---- 3d. 请求方言：FisherAI（work-fisher，/image/generations + 异步任务）------
  //
  // 依据：用户 2026-10-17 给的 curl 样例（size:"16:9" / resolution:"1k" / nsfw_check:false）
  // + 上游 AIFISHER server/providers/relayProvider.js 实读的协议：
  //   路径 /image/generations（单数）、提交只回 task_id、结果轮询 /image/generations/{id}、
  //   状态机全大写（SUBMITTED/IN_PROGRESS/SUCCESS/FAILURE）、结果埋在 data.data.content.image_urls、
  //   参考图**只收公网直链**（先 POST /files/upload，不收 base64）。
  // 这几处全都「配错不报错」（路径错是网关 404、参考图错是当没传），只能靠断言钉。
  console.log('\n=== 请求方言：FisherAI（work-fisher） ===');
  {
    const auto = await channelsApi('POST', '', {
      action: 'save',
      channel: { label: 'FisherAI 自动判定', baseUrl: 'https://api.work-fisher.com/v1', models: [] },
    });
    const autoChannel =
      (auto.json().channels ?? []).find((item) => item.label === 'FisherAI 自动判定') ?? {};
    check(
      '方言：work-fisher 域名不用配，「自动」就判成 workfisher',
      auto.status === 200 &&
        autoChannel.dialect === null &&
        autoChannel.dialectDetected === 'workfisher',
      JSON.stringify({ dialect: autoChannel.dialect, detected: autoChannel.dialectDetected }),
    );
    await channelsApi('POST', '', { action: 'delete', id: autoChannel.id });

    const saved = await channelsApi('POST', '', {
      action: 'save',
      channel: {
        label: 'FisherAI',
        baseUrl: CHANNEL_BASE_URL,
        apiKey: 'sk-wf',
        dialect: 'workfisher',
        models: [
          { id: WF_MODEL_ID, kind: 'image' },
          { id: WF_FAIL_MODEL_ID, kind: 'image' },
        ],
      },
    });
    const wfChannel = (saved.json().channels ?? []).find((item) => item.label === 'FisherAI') ?? {};
    check(
      '方言：显式 workfisher 存得住（本机地址本来会判成 openai）',
      saved.status === 200 && wfChannel.dialect === 'workfisher',
      JSON.stringify({ status: saved.status, dialect: wfChannel.dialect }),
    );

    const before = received.length;
    const gen = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: 'A red ceramic teapot on a white table',
      imageModel: `FisherAI · ${WF_MODEL_ID}`,
      resolution: '1K',
      aspectRatio: '16:9',
    });
    const genBody = JSON.parse(gen.body);
    const calls = received.slice(before);
    const post = calls.find((item) => item.method === 'POST' && item.url === '/v1/image/generations');
    check(
      '方言：路径是 /image/generations（单数），没有走 OpenAI 的 /images/generations',
      Boolean(post) && !calls.some((item) => item.url === '/v1/images/generations'),
      JSON.stringify(calls.map((item) => [item.method, item.url])),
    );
    check(
      '方言：宽高比走 size:"16:9"、档位走 resolution:"1k"（不是 1024x576 像素串）',
      post?.body?.size === '16:9' && post?.body?.resolution === '1k',
      JSON.stringify({ size: post?.body?.size, resolution: post?.body?.resolution }),
    );
    check(
      '方言：带 nsfw_check:false（文档样例里的字段，不传就按上游默认审核跑）',
      post?.body?.nsfw_check === false,
      String(post?.body?.nsfw_check),
    );
    check(
      '方言：一个任务只收 1 张 → n 固定 1（数量靠真的提交几次）',
      post?.body?.n === 1 && post?.body?.model === WF_MODEL_ID,
      JSON.stringify({ n: post?.body?.n, model: post?.body?.model }),
    );
    check(
      '方言：不发魔搭那套 X-ModelScope-Async-Mode 头（两家网关不是一回事）',
      post?.headers?.['x-modelscope-async-mode'] === undefined,
      String(post?.headers?.['x-modelscope-async-mode']),
    );
    const polls = calls.filter(
      (item) => item.method === 'GET' && /^\/v1\/image\/generations\/wf-\d+$/.test(item.url),
    );
    check(
      '方言：提交只回 task_id → 轮询「提交地址 + /{task_id}」',
      polls.length >= 2 && polls[0]?.url === '/v1/image/generations/wf-1',
      JSON.stringify(polls.map((item) => item.url)),
    );
    check(
      '方言：不拿 IN_PROGRESS 当结果（等到 SUCCESS 才收尾）',
      gen.status === 200 && polls.length >= 2,
      `status=${gen.status} polls=${polls.length}`,
    );
    check(
      '方言：结果从 data.data.content.image_urls 里认出来并落素材库',
      gen.status === 200 &&
        String(genBody.resultUrl).startsWith('/api/aifisher/canvas/media/') &&
        genBody.resultUrls?.length === 1,
      `${gen.status} ${JSON.stringify(genBody.resultUrls)}`,
    );
    check(
      '方言：回执带 channelDialect=workfisher（排查「图怎么不像编辑的」第一眼就看它）',
      genBody.channelDialect === 'workfisher' && genBody.channelLabel === 'FisherAI',
      JSON.stringify({ dialect: genBody.channelDialect, label: genBody.channelLabel }),
    );

    // 失败：状态机是大写的 FAILURE，原因在 fail_reason 里
    const failed = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '注定失败',
      imageModel: `FisherAI · ${WF_FAIL_MODEL_ID}`,
      resolution: '1K',
      aspectRatio: '1:1',
    });
    const failedBody = JSON.parse(failed.body);
    check(
      '方言：FAILURE → 502 CHANNEL_TASK_FAILED，并把 fail_reason 带给用户',
      failed.status === 502 &&
        failedBody.code === 'CHANNEL_TASK_FAILED' &&
        String(failedBody.error).includes('内容未通过审核'),
      `${failed.status} ${failed.body.slice(0, 160)}`,
    );

    // 参考图：data URL 必须先 /files/upload 换成公网直链，再放进 images
    const refBefore = received.length;
    const refGen = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '给这张图加一顶帽子',
      imageModel: `FisherAI · ${WF_MODEL_ID}`,
      resolution: '1K',
      aspectRatio: '1:1',
      imageBase64: [REFERENCE],
    });
    const refCalls = received.slice(refBefore);
    const upload = refCalls.find((item) => item.method === 'POST' && item.url === '/v1/files/upload');
    const refPost = refCalls.find((item) => item.method === 'POST' && item.url === '/v1/image/generations');
    check(
      '方言：参考图先 POST /files/upload 换公网直链（那边不收 base64）',
      Boolean(upload),
      JSON.stringify(refCalls.map((item) => [item.method, item.url])),
    );
    check(
      '方言：请求体里 images 是上传回来的直链，不是 data URL',
      Array.isArray(refPost?.body?.images) &&
        refPost.body.images.length === 1 &&
        /^https?:\/\/.+uploaded-\d+\.png$/.test(String(refPost.body.images[0])),
      JSON.stringify(refPost?.body?.images).slice(0, 160),
    );
    check(
      '方言：不带 OpenAI 的 image / 魔搭的 image_url（带了也会被静默丢掉）',
      refPost?.body?.image === undefined && refPost?.body?.image_url === undefined,
      JSON.stringify(Object.keys(refPost?.body ?? {})),
    );
    check(
      '方言：带参考图那次仍然出图成功',
      refGen.status === 200 && String(JSON.parse(refGen.body).resultUrl).startsWith('/api/aifisher/canvas/media/'),
      `${refGen.status} ${refGen.body.slice(0, 120)}`,
    );

    // 生成数量 2 → 真的提交两次（低价扩展版一个任务只回一张）
    const countBefore = received.length;
    const countGen = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '两只猫',
      imageModel: `FisherAI · ${WF_MODEL_ID}`,
      resolution: '2K',
      aspectRatio: '9:16',
      generateCount: 2,
    });
    const countBody = JSON.parse(countGen.body);
    const countPosts = received
      .slice(countBefore)
      .filter((item) => item.method === 'POST' && item.url === '/v1/image/generations');
    check(
      '方言：生成数量 2 → 真的提交 2 次（叫几张就有几张）',
      countPosts.length === 2 && countPosts.every((item) => item.body?.n === 1),
      `posts=${countPosts.length} n=${JSON.stringify(countPosts.map((item) => item.body?.n))}`,
    );
    check(
      '方言：2K + 9:16 原样翻成 resolution:"2k" / size:"9:16"',
      countPosts.every((item) => item.body?.resolution === '2k' && item.body?.size === '9:16'),
      JSON.stringify(countPosts.map((item) => [item.body?.resolution, item.body?.size])),
    );
    check(
      '方言：两次结果合并成 2 张',
      countGen.status === 200 && countBody.resultUrls?.length === 2,
      `${countGen.status} ${JSON.stringify(countBody.resultUrls)}`,
    );

    // ---- 3d-bis. 参考素材上传：瞬时被掐要自己重试，一直断要给可读回执（v1.35）---------
    //
    // 用户 2026-10-17 截图：「上传参考素材到通道「Fisher」失败：fetch failed（ECONNRESET）」。
    // 实测：同一台机器、同一份 2.2MB 素材，独立进程里连传 3 次全成（1.6s / 4.1s / 8.4s），
    // DSH 进程里也能「这次断、下次好」—— 属于**瞬时链路中断**，不是地址/字段配错。
    // 上传免费且无副作用，所以这一类失败必须自己重试，不能直接把它变成「这张图永远生成不了」。
    /** 每例用不同字节：直链缓存按「通道 + 字节 sha1」命中，混用会互相顶掉断言。 */
    const refBytes = (tag) =>
      `data:image/png;base64,${Buffer.concat([PNG_BYTES, Buffer.from(tag)]).toString('base64')}`;
    const genWith = (reference) =>
      host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
        projectId: PROJECT_ID,
        prompt: '加一顶帽子',
        imageModel: `FisherAI · ${WF_MODEL_ID}`,
        resolution: '1K',
        aspectRatio: '1:1',
        imageBase64: [reference],
      });

    // ① 直链缓存：同一份字节第二次生成不必再传 2MB 上行
    const cachedRef = refBytes('cache-hit');
    const cacheBefore = received.length;
    const cacheFirst = await genWith(cachedRef);
    const cacheSecond = await genWith(cachedRef);
    const cacheUploads = received
      .slice(cacheBefore)
      .filter((item) => item.method === 'POST' && item.url === '/v1/files/upload').length;
    check(
      '上传：同一份参考素材第二次生成直接复用直链（只有 1 次 /files/upload）',
      cacheUploads === 1 && cacheFirst.status === 200 && cacheSecond.status === 200,
      `uploads=${cacheUploads} status=${cacheFirst.status}/${cacheSecond.status}`,
    );

    // ② 瞬时掐断一次 → 自己再试一次就好
    const retryRef = refBytes('retry-once');
    wfUploadFaults = 1;
    const retryAttemptsBefore = wfUploadAttempts;
    const retryGen = await genWith(retryRef);
    const retryAttempts = wfUploadAttempts - retryAttemptsBefore;
    wfUploadFaults = 0;
    check(
      '上传：连接被掐一次（ECONNRESET / socket hang up）→ 自动重试，生成照常成功',
      retryGen.status === 200 && retryAttempts === 2,
      `status=${retryGen.status} attempts=${retryAttempts} ${retryGen.body.slice(0, 120)}`,
    );

    // ③ 一直掐断 → 3 次封顶后给可读回执，且绝不把请求硬发出去
    const deadRef = refBytes('retry-dead');
    const deadBefore = received.length;
    wfUploadDead = true;
    const deadGen = await genWith(deadRef);
    wfUploadDead = false;
    const deadBody = JSON.parse(deadGen.body);
    check(
      '上传：一直断 → 502 CHANNEL_UPLOAD_UNREACHABLE（不是静默当没传）',
      deadGen.status === 502 && deadBody.code === 'CHANNEL_UPLOAD_UNREACHABLE',
      `${deadGen.status} ${deadBody.code}`,
    );
    check(
      '上传：回执说清「试了几次 / 多大 / 什么原因」（3 次封顶，不再瞎试）',
      /试了 3 次/.test(String(deadBody.error)) &&
        /MB/.test(String(deadBody.error)) &&
        /ECONNRESET|socket hang up|fetch failed/.test(String(deadBody.error)),
      String(deadBody.error).slice(0, 200),
    );
    check(
      '上传：一直断时没有硬发出去（不生成、不计费）',
      !received.slice(deadBefore).some((item) => item.url === '/v1/image/generations'),
      JSON.stringify(received.slice(deadBefore).map((item) => item.url)),
    );
    check(
      '上传：hint 明说「免费、可安全重试」并给代理/VPN 方向',
      /免费/.test(String(deadBody.hint)) &&
        /重试/.test(String(deadBody.hint)) &&
        /代理|VPN/.test(String(deadBody.hint)),
      String(deadBody.hint).slice(0, 200),
    );

    // 收尾：这条通道只为上面几验存在，删掉，别影响后面「两条通道」的条数断言
    await channelsApi('POST', '', { action: 'delete', id: wfChannel.id });
  }

  // ---- 3e. 端点额度不足（403）：原话照传 + 补一句人话 -------------------------
  //
  // 2026-10-17 实测 FisherAI 真的会回 `403 insufficient_user_quota`（「用户额度不足，无法预扣 ¥0.048752」）。
  // 这种报错最容易被当成「画布坏了」；测试账号余额耗尽时也会撞上，所以文案必须能自解释。
  console.log('\n=== 端点额度不足（403） ===');
  {
    const quota = await channelsApi('POST', '', {
      action: 'save',
      channel: {
        label: '余额检查',
        baseUrl: CHANNEL_BASE_URL,
        apiKey: 'sk-quota',
        models: [{ id: 'quota/Exhausted', kind: 'image' }],
      },
    });
    const quotaChannel = (quota.json().channels ?? []).find((item) => item.label === '余额检查') ?? {};
    const out = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
      projectId: PROJECT_ID,
      prompt: '余额不足',
      imageModel: `余额检查 · quota/Exhausted`,
      resolution: '1K',
      aspectRatio: '1:1',
    });
    const outBody = JSON.parse(out.body);
    check(
      '额度不足：502 CLOUD_UPSTREAM_ERROR，且把上游原话（含金额）带出来',
      out.status === 502 &&
        outBody.code === 'CLOUD_UPSTREAM_ERROR' &&
        String(outBody.error).includes('用户额度不足') &&
        String(outBody.error).includes('0.048752'),
      `${out.status} ${out.body.slice(0, 180)}`,
    );
    check(
      '额度不足：hint 说清是账户余额的事（不是画布/密钥）并指路充值',
      /余额|额度/.test(String(outBody.hint)) && /充|充值/.test(String(outBody.hint)) &&
        /画布/.test(String(outBody.hint)),
      String(outBody.hint),
    );
    await channelsApi('POST', '', { action: 'delete', id: quotaChannel.id });
  }

  const mismatch = await host.dispatch('POST', '/api/aifisher/canvas/generate-video', {
    projectId: PROJECT_ID,
    prompt: 'x',
    videoModel: IMAGE_MODEL_NAME,
  });
  const mismatchBody = JSON.parse(mismatch.body);
  check(
    '类型不匹配：图片模型用在视频节点 → 422 CHANNEL_KIND_MISMATCH',
    mismatch.status === 422 && mismatchBody.code === 'CHANNEL_KIND_MISMATCH',
    `${mismatch.status} ${mismatch.body.slice(0, 160)}`,
  );
  check(
    '类型不匹配：文案说清是哪个通道的哪种模型',
    String(mismatchBody.error).includes('图片') && String(mismatchBody.error).includes(CHANNEL_LABEL),
    String(mismatchBody.error),
  );

  const orphan = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: PROJECT_ID,
    prompt: 'x',
    imageModel: '没人登记的模型',
  });
  check(
    '名字对不上任何通道、也没配旧端点 → 501 CLOUD_NOT_CONFIGURED',
    orphan.status === 501 && JSON.parse(orphan.body).code === 'CLOUD_NOT_CONFIGURED',
    `${orphan.status} ${orphan.body.slice(0, 140)}`,
  );

  // ---- 4. 第二条通道：同名模型分得清 --------------------------------------
  console.log('\n=== 多通道（同名模型） ===');
  const second = await channelsApi('POST', '', {
    action: 'save',
    channel: {
      label: '另一家中转',
      baseUrl: CHANNEL_BASE_URL,
      apiKey: 'sk-channel-2',
      models: [{ id: IMAGE_MODEL_ID, kind: 'image' }],
    },
  });
  check(
    '第二条通道保存成功',
    second.status === 200 && second.json().channels?.length === 2,
    `${second.status} ${second.text.slice(0, 120)}`,
  );
  const groups = (await host.hostApi('GET', '/generation/model-availability')).json().groups ?? [];
  const first = groups.find((item) => item.canonicalModel === IMAGE_MODEL_NAME);
  const secondGroup = groups.find((item) => item.canonicalModel === `另一家中转 · ${IMAGE_MODEL_ID}`);
  check(
    '同名模型在画布上是两个模型名（通道名在前）',
    Boolean(first) && Boolean(secondGroup),
    JSON.stringify(groups.map((g) => g.canonicalModel)).slice(0, 200),
  );

  const beforeSecond = received.length;
  await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: PROJECT_ID,
    prompt: 'x',
    imageModel: `另一家中转 · ${IMAGE_MODEL_ID}`,
    resolution: '1K',
    aspectRatio: '1:1',
  });
  const secondCall = received.slice(beforeSecond).find((item) => item.url === '/v1/images/generations');
  check(
    '按名字分发到第二条通道（用它的密钥）',
    secondCall?.headers?.authorization === 'Bearer sk-channel-2',
    String(secondCall?.headers?.authorization),
  );

  // ---- 4b. 自定义模型名（别名）--------------------------------------------
  //
  // 用户原话（2026-10-16）：「看不到模型名称，还有自定义模型名称」。
  // 「看不到」是界面的布局 bug（行内 select 带 w-full 把名字挤成 0 宽，见 browser-check）；
  // 「自定义模型名称」就是这里：每条模型可以另起一个短名字，**它就是画布上的模型名**，
  // 发给端点的仍必须是纯模型 ID。所以别名必须满足三条：原样回读、进可用性清单、按它分发。
  console.log('\n=== 自定义模型名（别名） ===');
  const aliasSave = await channelsApi('POST', '', {
    action: 'save',
    channel: {
      id: channelId,
      label: CHANNEL_LABEL,
      baseUrl: CHANNEL_BASE_URL,
      apiKey: 'sk-channel-1',
      models: [
        { id: IMAGE_MODEL_ID, kind: 'image', label: IMAGE_MODEL_ALIAS },
        { id: TEXT_MODEL_ID, kind: 'text' },
      ],
    },
  });
  const aliasChannel = (aliasSave.json().channels ?? []).find((item) => item.id === channelId) ?? {};
  check(
    '别名：保存后原样回来',
    aliasSave.status === 200 &&
      aliasChannel.models?.find((model) => model.id === IMAGE_MODEL_ID)?.label === IMAGE_MODEL_ALIAS,
    `${aliasSave.status} ${JSON.stringify(aliasChannel.models)}`,
  );
  const aliasGroups = (await host.hostApi('GET', '/generation/model-availability')).json().groups ?? [];
  check(
    '别名：画布可用性里的模型名就是别名（默认的「通道名 · 模型 ID」不再出现）',
    aliasGroups.some((item) => item.canonicalModel === IMAGE_MODEL_ALIAS) &&
      !aliasGroups.some((item) => item.canonicalModel === IMAGE_MODEL_NAME),
    JSON.stringify(aliasGroups.map((item) => item.canonicalModel)).slice(0, 240),
  );

  const beforeAlias = received.length;
  await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: PROJECT_ID,
    prompt: '按别名分发',
    imageModel: IMAGE_MODEL_ALIAS,
    resolution: '1K',
    aspectRatio: '1:1',
  });
  const aliasCall = received.slice(beforeAlias).find((item) => item.url === '/v1/images/generations');
  check(
    '别名：按别名分发到这条通道，发给端点的仍是**纯模型 ID**',
    aliasCall?.body?.model === IMAGE_MODEL_ID && aliasCall?.headers?.authorization === 'Bearer sk-channel-1',
    JSON.stringify({ model: aliasCall?.body?.model, auth: aliasCall?.headers?.authorization }),
  );

  // 兜底：别名会被当画布模型名用，太长/带换行会撑坏模型下拉 —— host 必须归一（压空格 + 截 80）
  const messyAlias = await channelsApi('POST', '', {
    action: 'save',
    channel: {
      id: channelId,
      label: CHANNEL_LABEL,
      baseUrl: CHANNEL_BASE_URL,
      apiKey: 'sk-channel-1',
      models: [{ id: IMAGE_MODEL_ID, kind: 'image', label: `  乱   名\n${'x'.repeat(200)}  ` }],
    },
  });
  const messyLabel =
    ((messyAlias.json().channels ?? []).find((item) => item.id === channelId)?.models ?? []).find(
      (model) => model.id === IMAGE_MODEL_ID,
    )?.label ?? '';
  check(
    '别名：控制字符压成空格、超长截到 80（不会撑坏模型下拉）',
    messyLabel.length === 80 && !messyLabel.includes('\n') && !messyLabel.includes('  '),
    JSON.stringify(messyLabel.slice(0, 30)) + ` len=${messyLabel.length}`,
  );

  // 清空别名 = 回到默认名（条目上不再有 label）
  const clearedAlias = await channelsApi('POST', '', {
    action: 'save',
    channel: {
      id: channelId,
      label: CHANNEL_LABEL,
      baseUrl: CHANNEL_BASE_URL,
      apiKey: 'sk-channel-1',
      models: [
        { id: IMAGE_MODEL_ID, kind: 'image', label: '   ' },
        { id: TEXT_MODEL_ID, kind: 'text' },
      ],
    },
  });
  const clearedChannel = (clearedAlias.json().channels ?? []).find((item) => item.id === channelId) ?? {};
  const backToDefault =
    ((await host.hostApi('GET', '/generation/model-availability')).json().groups ?? []).some(
      (item) => item.canonicalModel === IMAGE_MODEL_NAME,
    );
  check(
    '别名：清空后回到默认名（条目上不再有 label）',
    clearedChannel.models?.find((model) => model.id === IMAGE_MODEL_ID)?.label === undefined && backToDefault,
    JSON.stringify(clearedChannel.models),
  );

  // ---- 5. 旧单端点彻底下架（v1.13）----------------------------------------
  console.log('\n=== 旧单端点已下架 ===');
  const importGone = await channelsApi('POST', '', { action: 'importLegacy' });
  check(
    'importLegacy 已随单端点移除 → 422 CHANNEL_ACTION_UNKNOWN',
    importGone.status === 422 && importGone.json().code === 'CHANNEL_ACTION_UNKNOWN',
    `${importGone.status} ${importGone.text.slice(0, 120)}`,
  );
  process.env.AIFISHER_CLOUD_BASE_URL = `${base}/legacy-v1`;
  const stillGone = await channelsApi('POST', '', { action: 'importLegacy' });
  check(
    '就算环境变量还留着，也不再被当成「隐式通道」收编',
    stillGone.status === 422 && (await channelsApi('GET')).json().legacy === undefined,
    `${stillGone.status} ${stillGone.text.slice(0, 120)}`,
  );
  delete process.env.AIFISHER_CLOUD_BASE_URL;

  const sources = (await host.hostApi('GET', '/generation/sources')).json();
  const sourceBlocks = sources.blocks ?? [];
  const channelSources = sourceBlocks.filter((block) => String(block.source).startsWith('channel:'));
  check(
    '闭源服务来源清单：方舟卡片仍在，自配通道以只读块出现（v1.52）',
    sourceBlocks[0]?.source === 'ark' &&
      channelSources.length >= 1 &&
      channelSources.every(
        (block) =>
          block.accountManaged === true &&
          Array.isArray(block.secrets) &&
          block.secrets.length === 0,
      ),
    JSON.stringify(sourceBlocks.map((block) => block.source)),
  );
  check(
    '通道块里的模型名是画布显示名且 configured（Agent 准备生成要用它逐字匹配）',
    channelSources.some((block) =>
      (block.media ?? []).some(
        (media) =>
          media.kind === 'image' &&
          media.models.some((model) => typeof model.name === 'string' && model.name.length > 0 && model.configured === true),
      ),
    ),
    JSON.stringify(channelSources.map((block) => block.media?.map((media) => media.models?.map((model) => model.name)))).slice(0, 240),
  );

  // ---- 6. 删除 ------------------------------------------------------------
  const beforeDelete = ((await channelsApi('GET')).json().channels ?? []).length;
  const removed = await channelsApi('POST', '', { action: 'delete', id: channelId });
  check(
    '删除通道 → 200 且表里少一条',
    removed.status === 200 && removed.json().channels?.length === beforeDelete - 1,
    `${removed.status} before=${beforeDelete} after=${removed.json().channels?.length}`,
  );
  const gone = (await host.hostApi('GET', '/generation/model-availability')).json().groups ?? [];
  check(
    '删掉之后它的模型不再出现在可用性里',
    !gone.some((item) => item.canonicalModel === IMAGE_MODEL_NAME),
    JSON.stringify(gone.map((g) => g.canonicalModel)).slice(0, 160),
  );

  // 收尾：只留一条干净通道（两条模型）给画布用例用 —— 否则上面导入/新建留下的通道标签重复，
  // 画布上的「通道名 · 模型 ID」会撞名。图片那条**带别名**：画布那一段要验「别名就是画布模型名」。
  const leftovers = (await channelsApi('GET')).json().channels ?? [];
  for (const item of leftovers) await channelsApi('POST', '', { action: 'delete', id: item.id });
  const fresh = await channelsApi('POST', '', {
    action: 'save',
    channel: {
      label: CHANNEL_LABEL,
      baseUrl: CHANNEL_BASE_URL,
      apiKey: 'sk-channel-1',
      models: [
        { id: IMAGE_MODEL_ID, kind: 'image', label: IMAGE_MODEL_ALIAS },
        { id: TEXT_MODEL_ID, kind: 'text' },
      ],
    },
  });
  check(
    '收尾：只留一条干净通道（图片模型带别名，共两条模型）',
    fresh.status === 200 &&
      fresh.json().channels?.length === 1 &&
      fresh.json().channels[0].models?.length === 2 &&
      fresh.json().channels[0].models?.[0]?.label === IMAGE_MODEL_ALIAS,
    `${fresh.status} ${fresh.text.slice(0, 160)}`,
  );
}

// ---------------------------------------------------------------- 画布侧
//
// 这一段验的是「画布上真的能选到并跑通」：运行时注册表（CloudChannelModels.ts）把通道模型
// 原地追加进 vendor 的 IMAGE_MODELS，画布下拉白名单由 vendor 补丁 3.8g 放行。

console.log('\n=== 画布：模型目录 + 真发一次生成 ===');
{
  const IMAGE_NODE = {
    id: NODE_ID,
    type: 'Image',
    x: 0,
    y: 0,
    prompt: '一只猫在雨里走过霓虹街道',
    status: 'idle',
    // ★ 节点上存的是**别名**（自定义模型名）：注册表与白名单都要认这个名字
    imageModel: IMAGE_MODEL_ALIAS,
    imageMode: 'text-to-image',
    aspectRatio: '1:1',
    resolution: '1K',
    parentIds: [],
    projectId: PROJECT_ID,
    width: 224,
    height: 209,
    generateCount: 1,
  };
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '自配通道验证',
    nodes: [IMAGE_NODE],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目（节点用通道模型名）写入本地后端', save.status === 200, String(save.text).slice(0, 160));

  const nodeFetch = globalThis.fetch;
  const { window, fetchCalls } = await createCanvasDom({ dispatch: host.dispatch });
  {
    const routedFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      if (/^https?:\/\//i.test(url)) return nodeFetch(input, init);
      return routedFetch(input, init);
    };
    globalThis.fetch = window.fetch;
  }
  seedResume(window, PROJECT_ID);
  const { container, handle } = await mountCanvasApp(window);
  await settle(1500);

  const nodeElement = () => container.querySelector(`[data-node-id="${NODE_ID}"]`);
  const generateButton = () =>
    nodeElement()?.querySelector('button[aria-label="生成图片"]') ??
    nodeElement()?.querySelector('button[aria-label="正在生成图片"]');
  check(
    '画布渲染出那个节点',
    Boolean(nodeElement()),
    container.innerHTML.slice(0, 200).replace(/\s+/g, ' '),
  );
  check(
    '画布启动时读过通道表（注册表数据源）',
    fetchCalls.some((call) => call === 'GET /api/aifisher/canvas/cloud-channels'),
    fetchCalls.filter((call) => call.includes('cloud-channels')).join(' | ') || '(none)',
  );
  // 关键：注册表把通道模型追加进了 vendor 目录，所以节点上的模型名能被认出来；
  // 认不出来时 composer 会退回 models[0]，模型按钮上显示的就会是内置模型名。
  // 注意 composer 只在节点被选中时渲染，这条断言要放在 selectNode() 之后。

  async function selectNode() {
    const element = nodeElement();
    if (!element) return false;
    const options = {
      bubbles: true,
      cancelable: true,
      clientX: 60,
      clientY: 60,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      element.dispatchEvent(new window.MouseEvent(type, options));
    }
    return (
      (await waitFor(async () => element.getAttribute('data-node-selected') === 'true', 8000)) === true
    );
  }
  check('点一下节点能选中', await selectNode(), String(nodeElement()?.getAttribute('data-node-selected')));

  const button = await waitFor(async () => generateButton(), 8000);
  check('选中后渲染出生图按钮', Boolean(button));
  check('生图按钮可点（通道模型的 imageModes 有效）', button?.disabled === false, String(button?.disabled));
  // 别名链路：注册表把带 label 的条目按别名追加进 vendor 目录 + 白名单放行 + 节点显示。
  // 注意这两个全局挂在 **Node 的 globalThis** 上：画布产物在 harness 里是 `import()` 进来的
  // Node ESM（浏览器全局是灌到 globalThis 的），所以 window.X 永远读不到它们。
  const registry = globalThis.__FISHERAI_CHANNEL_MODELS__;
  check(
    '注册表按别名建条目（画布目录里查得到这个名字）',
    Boolean(registry?.image?.some((entry) => entry?.name === IMAGE_MODEL_ALIAS)),
    JSON.stringify((registry?.image ?? []).map((entry) => entry?.name)).slice(0, 200),
  );
  const whitelist = globalThis.__FISHERAI_CHANNEL_MODEL_NAMES__;
  check(
    '画布下拉白名单里有别名（否则它一个选项都露出不来）',
    Boolean(whitelist) && typeof whitelist.has === 'function' && whitelist.has(IMAGE_MODEL_ALIAS),
    '(no whitelist)',
  );
  const modelShown = await waitFor(
    async () => ((nodeElement()?.textContent ?? '').includes(IMAGE_MODEL_ALIAS) ? true : null),
    8000,
  );
  check(
    '节点上显示的就是别名（注册表生效，没退回默认模型）',
    modelShown === true,
    (nodeElement()?.textContent ?? '').slice(0, 160),
  );
  check(
    '节点上存的也是别名（host 靠它反查通道）',
    (await savedNode(host))?.imageModel === IMAGE_MODEL_ALIAS,
    String((await savedNode(host))?.imageModel),
  );

  const beforeCanvas = received.length;
  button?.click();
  const call = await waitFor(
    async () => received.slice(beforeCanvas).find((item) => item.url === '/v1/images/generations') ?? null,
    12000,
  );
  check(
    '点生图 → 请求真的打到了自配通道的端点',
    Boolean(call),
    JSON.stringify(received.slice(beforeCanvas).map((item) => item.url)),
  );
  check(
    '画布发的是 host 的 /generate-image',
    fetchCalls.some((item) => item === 'POST /api/aifisher/canvas/generate-image'),
    fetchCalls.filter((item) => item.includes('generate-image')).join(' | ') || '(none)',
  );
  check('通道端点收到的是纯模型 ID', call?.body?.model === IMAGE_MODEL_ID, String(call?.body?.model));
  check('通道端点收到 size=1024x1024', call?.body?.size === '1024x1024', String(call?.body?.size));

  const done = await waitFor(async () => {
    const node = await savedNode(host);
    return node?.status === 'success' ? node : null;
  }, 25000);
  check('节点最终 success', done?.status === 'success', String((await savedNode(host))?.status));
  check(
    '结果 URL 指向本站素材库',
    String(done?.resultUrl).startsWith('/api/aifisher/canvas/media/'),
    String(done?.resultUrl).slice(0, 80),
  );

  const diag = (await host.hostApi('GET', '/diagnostics?limit=200')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check(
    '画布这一段无运行时错误',
    errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)',
  );

  // ---- v1.31 ①：403 额度不足时，节点上要显示 host 说清楚的那句 ----
  //
  // 上游 canvasGeneration 原来只要看到消息里有 `403` 就把整句换成
  // 「权限被拒绝。请检查 API Key 配置。」—— 余额不足被说成密钥配错，用户只会去翻 Key。
  // 这里把**同一个节点**再点一次生成（假端点改回 403），验节点上落的是原话。
  quotaGate = true;
  const generateAgain =
    nodeElement()?.querySelector('button[aria-label="生成图片"]') ?? button;
  generateAgain?.click();
  const failedNode = await waitFor(async () => {
    const node = await savedNode(host);
    return node?.status === 'error' ? node : null;
  }, 25000);
  const failureText = String(failedNode?.errorMessage ?? '');
  check(
    '403 额度不足时节点落到 error',
    failedNode?.status === 'error',
    String((await savedNode(host))?.status),
  );
  check(
    '失败诊断码仍是 CLOUD_UPSTREAM_ERROR',
    failedNode?.generationDiagnosticCode === 'CLOUD_UPSTREAM_ERROR',
    String(failedNode?.generationDiagnosticCode),
  );
  check(
    '节点上显示的是上游原话「额度不足」（没被改写成「请检查 API Key」）',
    /额度不足/.test(failureText) && !/请检查 API Key/.test(failureText),
    failureText.slice(0, 240),
  );
  check(
    '节点上带得出 HTTP 403（用户能看出是端点拒绝）',
    /HTTP 403/.test(failureText),
    failureText.slice(0, 240),
  );
  quotaGate = false;

  // ---- v1.31 ②：新建节点的默认模型跟着通道走 ----
  //
  // 用户原话「新建节点的时候默认模型不是我配置好的」。根因有两截：
  //   · createCanvasNode 已经按 runtime.imageModels[0] 填好了模型，
  //     但 createFresh 里的 applyFreshCanvasNodeDefaults 又无条件覆盖成 GPT Image 2 · API
  //     （vendor 补丁 3.8i 改成「给了就尊重」）；
  //   · 通道模型原来追加在目录**末尾**，imageModels[0] 还是内置模型
  //     （CloudChannelModels 改成装在最前面）。
  // 两条缺一，新节点默认模型都不会是用户在设置里勾的那个。
  window.dispatchEvent(
    new window.CustomEvent('fisherai:add-canvas-node', {
      detail: { type: 'Image', point: { x: 760, y: 160 } },
    }),
  );
  const freshNode = await waitFor(async () => {
    const doc = await savedDocument(host);
    return (doc?.nodes ?? []).find((node) => node.id !== NODE_ID && node.type === 'Image') ?? null;
  }, 20000);
  check(
    '新建 Image 节点默认模型 = 通道里的模型（不再是上游内置 GPT Image 2 · API）',
    freshNode?.imageModel === IMAGE_MODEL_ALIAS,
    String(freshNode?.imageModel),
  );
  check(
    '新建节点的 model 字段与 imageModel 一致（不再一个内置一个通道）',
    freshNode?.model === IMAGE_MODEL_ALIAS,
    String(freshNode?.model),
  );

  try {
    handle.dispose();
  } catch {
    /* 卸载失败在渲染测试里单独断言 */
  }
}

/** 存盘的项目文档。 */
async function savedDocument(target) {
  const result = await target.hostApi('GET', `/workflows/${PROJECT_ID}`);
  if (result.status !== 200) return undefined;
  try {
    return JSON.parse(result.text);
  } catch {
    return undefined;
  }
}

/** 存盘的节点（画布把状态写回本地后端）。 */
async function savedNode(target) {
  const doc = await savedDocument(target);
  return (doc?.nodes ?? []).find((node) => node.id === NODE_ID);
}

async function waitFor(probe, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await settle(200);
  }
  return last;
}

// ---------------------------------------------------------------- 产物断言

console.log('\n=== 产物 ===');
{
  const canvasBundle = readFileSync(join(process.cwd(), 'lib/canvas/canvas-app.js'), 'utf8');
  check('画布产物里有通道注册表（provider 标记）', canvasBundle.includes('OpenAICompatibleProvider'));
  check('画布产物里有面板挂载点全局', canvasBundle.includes('__FISHERAI_MOUNT_CLOUD_CHANNELS__'));
  check(
    '画布产物里有画布下拉白名单的运行时集合',
    canvasBundle.includes('__FISHERAI_CHANNEL_MODEL_NAMES__'),
  );
  const hostBundle = readFileSync(join(process.cwd(), 'lib/index.js'), 'utf8');
  check('host 产物里有通道路由', hostBundle.includes('cloud-channels'));
  check('host 产物里有通道存储文件名', hostBundle.includes('cloud-channels.json'));
  // v1.12：设置面板的模型行 —— 名字必须能撑开（行内控件不能带 w-full），每条模型能填别名
  check('画布产物里有模型行的模型名标记', canvasBundle.includes('data-fisherai-channel-model-id'));
  check('画布产物里有别名输入框的标记', canvasBundle.includes('data-fisherai-channel-model-label'));
  check(
    '画布产物里模型行的类型下拉是窄的（w-full 会把它撑满整行、挤掉模型名）',
    canvasBundle.includes('w-24 shrink-0'),
  );
  // v1.31：两处 vendor 补丁必须真在源码里（否则上面两条行为断言会以别的方式悄悄绿掉）
  const frameworkSource = readFileSync(
    join(process.cwd(), 'vendor/aifisher/src/stable/nodes/nodeFramework.ts'),
    'utf8',
  );
  check(
    'vendor 补丁 3.8i：新节点默认模型尊重调用方给的模型',
    frameworkSource.includes('freshCanvasModel(candidate') &&
      !frameworkSource.includes(`      model: DEFAULT_CANVAS_IMAGE_MODEL,\n      imageModel: DEFAULT_CANVAS_IMAGE_MODEL,\n      resolution: '1K',`),
    frameworkSource.includes('freshCanvasModel') ? 'ok' : '补丁缺失',
  );
  const generationSource = readFileSync(
    join(process.cwd(), 'vendor/aifisher/src/stable/generation/canvasGeneration.ts'),
    'utf8',
  );
  check(
    'vendor 补丁 3.8j：host 的详细错误不再被改写成「请检查 API Key」',
    generationSource.includes('hostDetailed'),
    generationSource.includes('hostDetailed') ? 'ok' : '补丁缺失',
  );
  // v1.32：参考素材出请求体前要摘掉显示用缓存戳（3.8l）
  const requestSource = readFileSync(
    join(process.cwd(), 'vendor/aifisher/src/stable/generation/canvasGenerationRequests.ts'),
    'utf8',
  );
  check(
    'vendor 补丁 3.8l：参考素材 URL 的缓存戳（?t=）在出请求体前被摘掉',
    requestSource.includes('withoutCacheStamp(') &&
      !requestSource.includes(`      url: output?.url,`),
    requestSource.includes('withoutCacheStamp(') ? 'ok' : '补丁缺失',
  );
}

upstream.close();
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
