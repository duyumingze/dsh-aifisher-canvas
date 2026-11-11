/**
 * 「阿里云百炼（DashScope）方言」回归（scripts/test-cloud-channels-dashscope.mjs）。
 *
 * 起因（2026-11-11，用户原话「帮我在画布接一下这个模型
 * kling/kling-v3-omni-image-generation」并贴了 curl）：
 *
 *   POST https://…/api/v1/services/aigc/image-generation/generation
 *   X-DashScope-Async: enable
 *   { model, input:{messages:[{role:'user',content:[{text}]}]},
 *     parameters:{ n, aspect_ratio, resolution } }
 *   → { output:{ task_id, task_status:'PENDING' } }
 *   GET  {base}/api/v1/tasks/{task_id}
 *   → { output:{ task_status:'SUCCEEDED', choices:[{ message:{ content:[{image:'https://…'}] } }] } }
 *
 * 这套和 OpenAI / 魔搭 / FisherAI **没有一处相同**，而配错的表现是 400 或空结果
 * （报错里看不出缺的是哪个字段）。所以这里用真 HTTP 的假上游把五件事钉死：
 *   ① 路径、异步头、请求体形状（input.messages + parameters，没有顶层 prompt）；
 *   ② 任务号在 output.task_id、轮询地址是 /api/v1/tasks/{id}（baseUrl 带不带 /api/v1 都要对）；
 *   ③ 结果从 output.choices[0].message.content[].image 里认出来并落素材库；
 *   ④ 只收公网直链参考图 —— 本机素材给可操作的 422，不静默丢掉；
 *   ⑤ 模型类型推断：名字带 image-generation 的不能被 `kling` 这个视频词根带偏成视频。
 *
 * 用法：node scripts/test-cloud-channels-dashscope.mjs   （需要先 pnpm build）
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

const MODEL_ID = 'kling/kling-v3-omni-image-generation';
const CHANNEL_ID = 'dashscope';
const CHANNEL_LABEL = '百炼回归';
const OK_TASK = 'task-ds-ok';
const BAD_TASK = 'task-ds-bad';
const SUBMIT_PATH = '/api/v1/services/aigc/image-generation/generation';

const received = [];
let submitCount = 0;
/** 任务 → 已经被轮询几次（第一次给 PENDING，之后给 SUCCEEDED，验「没把 PENDING 当结果」）。 */
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

    if (req.url === '/ds-result.png' || String(req.url).startsWith('/ds-result.png?')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_BYTES);
      return;
    }

    if (req.method === 'POST' && req.url === SUBMIT_PATH) {
      submitCount += 1;
      const taskId = String(body?.model ?? '').includes('doomed') ? BAD_TASK : OK_TASK;
      return json(200, {
        output: { task_id: taskId, task_status: 'PENDING' },
        request_id: 'rid-submit',
      });
    }

    if (req.method === 'GET' && req.url.startsWith('/api/v1/tasks/')) {
      const taskId = decodeURIComponent(req.url.slice('/api/v1/tasks/'.length));
      const polls = (pollCounts.get(taskId) ?? 0) + 1;
      pollCounts.set(taskId, polls);
      if (taskId === BAD_TASK) {
        // 百炼「任务失败」还有一种没有 output 的形状：HTTP 200 + 根上 code/message。
        return json(200, {
          request_id: 'rid-bad',
          code: 'InvalidParameter',
          message: 'num_images_per_prompt must be 1',
        });
      }
      if (polls < 2) {
        return json(200, { request_id: 'rid-poll', output: { task_id: taskId, task_status: 'RUNNING' } });
      }
      return json(200, {
        request_id: 'rid-poll',
        output: {
          task_id: taskId,
          task_status: 'SUCCEEDED',
          finished: true,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: [
                  { type: 'image', image: `${base}/ds-result.png?a=1` },
                  { type: 'image', image: `${base}/ds-result.png?a=2` },
                ],
              },
            },
          ],
        },
        usage: { image_count: 2, size: '1024*1024', SR: '1080' },
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

/** 最后一次提交（排除结果图床与轮询 GET）。 */
function lastSubmit() {
  return [...received].reverse().find((item) => item.method === 'POST' && item.url === SUBMIT_PATH);
}
function pollCalls() {
  return received.filter((item) => item.method === 'GET' && item.url.startsWith('/api/v1/tasks/'));
}

async function saveChannel(patch = {}) {
  return channelsApi('POST', {
    action: 'save',
    channel: {
      id: CHANNEL_ID,
      label: CHANNEL_LABEL,
      baseUrl: base,
      apiKey: 'sk-dashscope-test',
      dialect: 'dashscope',
      paths: {},
      models: [{ id: MODEL_ID, kind: 'image' }],
      ...patch,
    },
  });
}

// ---------------------------------------------------------------------------
console.log('\n=== 通道：方言与模型类型 ===');
{
  const saved = await saveChannel();
  const channel = (saved.json().channels ?? []).find((item) => item.id === CHANNEL_ID) ?? {};
  check('保存通道：200', saved.status === 200, String(saved.status));
  check(
    '方言：显式 dashscope 存得住，dialectDetected 也是 dashscope',
    channel.dialect === 'dashscope' && channel.dialectDetected === 'dashscope',
    JSON.stringify({ dialect: channel.dialect, detected: channel.dialectDetected }),
  );
  check('密钥不回显（只有 apiKeySet）', channel.apiKey === undefined && channel.apiKeySet === true);

  // 不写 kind 时按 ID 猜：`kling/…-image-generation` 不能被 kling 这个视频词根带偏
  const guessed = await saveChannel({ id: 'dashscope-guess', models: [{ id: MODEL_ID }] });
  const guessChannel = (guessed.json().channels ?? []).find((item) => item.id === 'dashscope-guess') ?? {};
  check(
    '类型推断：kling/kling-v3-omni-image-generation → image（不是 video）',
    guessChannel.models?.[0]?.kind === 'image',
    JSON.stringify(guessChannel.models?.[0] ?? null),
  );
  await channelsApi('POST', { action: 'delete', id: 'dashscope-guess' });
}

// ---------------------------------------------------------------------------
console.log('\n=== 出图：路径 / 异步头 / input.messages + parameters ===');
let firstGeneration = null;
{
  const result = await generate({
    projectId: 'proj-dashscope',
    nodeId: 'n-ds',
    prompt: '一间有着精致窗户的花店，漂亮的木质门，摆放着花朵',
    imageModel: MODEL_ID,
    aspectRatio: '9:16',
    resolution: '2K',
    generateCount: 2,
  });
  const body = JSON.parse(result.body);
  firstGeneration = body;
  check('出图 → 200', result.status === 200, `status=${result.status} ${result.body.slice(0, 200)}`);

  const submit = lastSubmit() ?? {};
  check(
    '提交路径 = /api/v1/services/aigc/image-generation/generation',
    submit.url === SUBMIT_PATH,
    String(submit.url),
  );
  check(
    '带 X-DashScope-Async: enable（缺了会报 current user api does not support synchronous calls）',
    submit.headers?.['x-dashscope-async'] === 'enable',
    String(submit.headers?.['x-dashscope-async']),
  );
  check('鉴权头是 Bearer', submit.headers?.authorization === 'Bearer sk-dashscope-test');
  check('model 是纯模型 ID', submit.body?.model === MODEL_ID, String(submit.body?.model));
  check('没有把画布字段（prompt / projectId / nodeId）透给端点',
    submit.body?.prompt === undefined && submit.body?.projectId === undefined && submit.body?.nodeId === undefined,
    JSON.stringify(Object.keys(submit.body ?? {})).slice(0, 160));

  const message = submit.body?.input?.messages?.[0] ?? {};
  check(
    'input.messages[0] = {role:user, content:[{text}]}',
    message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content[0]?.text === '一间有着精致窗户的花店，漂亮的木质门，摆放着花朵',
    JSON.stringify(message).slice(0, 200),
  );
  const parameters = submit.body?.parameters ?? {};
  check(
    'parameters = {n:2, aspect_ratio:"9:16", resolution:"2k"}',
    parameters.n === 2 && parameters.aspect_ratio === '9:16' && parameters.resolution === '2k',
    JSON.stringify(parameters),
  );

  const polls = pollCalls();
  check(
    '任务号取自 output.task_id，轮询 /api/v1/tasks/{id}',
    polls.length >= 2 && polls[0]?.url === `/api/v1/tasks/${OK_TASK}`,
    `${polls.length} 次 · ${polls[0]?.url}`,
  );
  check('轮询 GET 不带异步头（只有提交需要）', polls[0]?.headers?.['x-dashscope-async'] === undefined);
  check('没把 PENDING/RUNNING 当结果（至少轮询两次才收尾）', (pollCounts.get(OK_TASK) ?? 0) >= 2,
    `polls=${pollCounts.get(OK_TASK) ?? 0}`);

  check(
    '结果从 output.choices[].message.content[].image 认出来（两张）',
    Array.isArray(body.resultUrls) && body.resultUrls.length === 2,
    JSON.stringify(body.resultUrls ?? null),
  );
  check(
    '返回的是本站素材 URL（临时链接已下载转存）',
    String(body.resultUrl).startsWith('/api/aifisher/canvas/media/'),
    String(body.resultUrl),
  );
  const filePath = diskPathOf(body.resultUrl);
  check('结果文件真的落盘', existsSync(filePath), filePath.slice(-70));
  if (existsSync(filePath)) {
    check('落盘内容与图床字节一致', readFileSync(filePath).equals(PNG_BYTES));
  }
  check('回执带 channelDialect=dashscope（排查「图怎么不对」第一眼就看它）',
    body.channelDialect === 'dashscope' && body.channelLabel === CHANNEL_LABEL,
    JSON.stringify({ dialect: body.channelDialect, label: body.channelLabel }));
}

// ---------------------------------------------------------------------------
console.log('\n=== Base URL 已经带 /api/v1 也不叠两层 ===');
{
  const before = submitCount;
  const saved = await saveChannel({ baseUrl: `${base}/api/v1` });
  check('保存带 /api/v1 的 Base URL：200', saved.status === 200, String(saved.status));
  const result = await generate({ projectId: 'proj-dashscope', prompt: '测试', imageModel: MODEL_ID });
  const body = JSON.parse(result.body);
  check('出图 → 200', result.status === 200, `status=${result.status} ${result.body.slice(0, 160)}`);
  check('提交路径没有变成 /api/v1/api/v1/…', lastSubmit()?.url === SUBMIT_PATH, String(lastSubmit()?.url));
  check('轮询路径仍是 /api/v1/tasks/{id}', pollCalls().at(-1)?.url === `/api/v1/tasks/${OK_TASK}`,
    String(pollCalls().at(-1)?.url));
  check('默认 generateCount=1 → parameters.n=1', lastSubmit()?.body?.parameters?.n === 1,
    JSON.stringify(lastSubmit()?.body?.parameters ?? null));
  check('这一轮真的提交了（不是复用上一轮）', submitCount === before + 1, `${before} → ${submitCount}`);
  check('resultUrl 仍是本站素材', String(body.resultUrl).startsWith('/api/aifisher/canvas/media/'));

  // 端点收 1–9 张；通用的 countOf 上限是 8，别把用户填的 9 悄悄变成 8
  const nine = await generate({
    projectId: 'proj-dashscope',
    prompt: '九张',
    imageModel: MODEL_ID,
    generateCount: 9,
  });
  check('生成数量 9 → parameters.n=9（不被通用上限 8 夹掉）',
    nine.status === 200 && lastSubmit()?.body?.parameters?.n === 9,
    `status=${nine.status} n=${lastSubmit()?.body?.parameters?.n}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 参考图：只收公网直链，本机素材给可操作的 422 ===');
{
  const before = submitCount;
  const result = await generate({
    projectId: 'proj-dashscope',
    prompt: '把这张图改成水彩',
    imageModel: MODEL_ID,
    imageBase64: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
  });
  const body = JSON.parse(result.body);
  check('本机/内联参考图 → 422', result.status === 422, `status=${result.status} ${result.body.slice(0, 160)}`);
  check('错误码是 CHANNEL_REFERENCE_NOT_PUBLIC', body.code === 'CHANNEL_REFERENCE_NOT_PUBLIC', String(body.code));
  check(
    'hint 说清了原因（要公网直链，画布素材在外访问不到）',
    /公网/.test(String(body.hint)) && /本机/.test(String(body.hint)),
    String(body.hint).slice(0, 120),
  );
  check('**没有**把请求发出去（不静默丢图、也不白花钱）', submitCount === before, `${before} → ${submitCount}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 任务失败：HTTP 200 + 根上 code/message 也要认成失败 ===');
{
  const saved = await saveChannel({ models: [{ id: `${MODEL_ID}-doomed`, kind: 'image' }] });
  check('保存 doomed 模型：200', saved.status === 200, String(saved.status));
  const result = await generate({ projectId: 'proj-dashscope', prompt: 'x', imageModel: `${MODEL_ID}-doomed` });
  const body = JSON.parse(result.body);
  check('任务失败 → 502', result.status === 502, `status=${result.status} ${result.body.slice(0, 160)}`);
  check('错误码是 CHANNEL_TASK_FAILED', body.code === 'CHANNEL_TASK_FAILED', String(body.code));
  check('把端点原话带回来（num_images_per_prompt must be 1）',
    String(body.error).includes('num_images_per_prompt must be 1'), String(body.error).slice(0, 160));
  check('带任务号，方便去端点后台查', String(body.taskId) === BAD_TASK, String(body.taskId));
}

// ---------------------------------------------------------------------------
console.log('\n=== 产物契约 ===');
{
  const hostBundle = readFileSync(resolve(ROOT, 'lib/index.js'), 'utf8');
  check('产物里有百炼提交路径', hostBundle.includes('services/aigc/image-generation/generation'));
  check('产物里有 X-DashScope-Async', hostBundle.includes('X-DashScope-Async'));
}

upstream.close();
console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
if (fail) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
}
process.exit(fail ? 1 : 0);
