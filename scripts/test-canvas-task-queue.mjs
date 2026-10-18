/**
 * 画布右侧「任务队列」面板回归（v1.24）。
 *
 * 用户 2026-10-17 原话（整轮需求只有这一句 + 一张「已检测到外部 ComfyUI 服务」的胶囊截图）：
 *   「在画布右侧添加一个任务队列面板，显示简易参数，如时间等，正在运行的任务要有边框循环发光特效」
 *
 * 这条需求跨两层，所以分两段验：
 *
 *   A. host 侧 `GET/POST/DELETE /api/aifisher/canvas/tasks`（真插件路由 + 假端点）
 *      空表 → 云端成功 / 云端失败 → 本地工作流「运行中 → 取消」→ 成功、
 *      以及**同一节点两轮并发**时老的那轮被标成 GENERATION_SUPERSEDED（面板不留僵尸行）。
 *      同时守一条回归：`/generation-status/:nodeId` 的结果回收语义不能被这次重构动到。
 *
 *   B. 真画布（jsdom 挂 lib/canvas/canvas-app.js）
 *      面板挂在画布容器里、贴右缘、渲染行与简易参数（HH:MM:SS / 用时 / 产出数 / 错误）、
 *      运行中那行命中「边框循环发光」的 CSS（keyframes + mask 抠环都在注入的 style 里）、
 *      用时每秒在跳、收起成右缘窄轨道（带运行中角标）再展开、取消按钮只给可取消的行、
 *      清空已完成。
 *
 * 用法：node scripts/test-canvas-task-queue.mjs   （需要先 build）
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}
function fatal(error) {
  console.log(lines.join('\n'));
  console.error('\nUNCAUGHT', error);
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

// ---------------------------------------------------------------- 假云端通道端点

const IMAGE_MODEL_ID = 'Qwen/Qwen-Image';
const SLOW_MODEL_ID = 'Qwen/Qwen-Image-Slow';
const FAIL_MODEL_ID = 'Qwen/Qwen-Image-Broken';
const CHANNEL_LABEL = '任务队列通道';
const modelName = (id) => `${CHANNEL_LABEL} · ${id}`;

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
/** 慢模型的拖时（毫秒）：面板要在这段窗口里看到「运行中 + 发光 + 用时在跳」。 */
const SLOW_MS = 6000;

const received = [];
let upstreamBase = '';
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
    received.push({ url: req.url, method: req.method, body });
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      return json(200, { object: 'list', data: [{ id: IMAGE_MODEL_ID }] });
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/result-')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG_BYTES);
    }
    if (req.url === '/v1/images/generations') {
      if (body?.model === FAIL_MODEL_ID) {
        return json(500, { error: { message: '显存不够', code: 'OOM' } });
      }
      const reply = () =>
        json(200, {
          created: 1,
          model: body?.model,
          data: [{ url: `${upstreamBase}/v1/result-1.png` }],
        });
      if (body?.model === SLOW_MODEL_ID) {
        setTimeout(reply, SLOW_MS);
        return;
      }
      return reply();
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no such path' }, path: req.url }));
  });
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

// ---------------------------------------------------------------- 假 ComfyUI

/** 文生图（无模型加载器 → 不需要对账）；Negative 标题的字符串节点被推断成负向槽。 */
const T2I = {
  '6': { inputs: { text: '模板占位' }, class_type: 'CLIPTextEncode' },
  '7': { inputs: { text: '模板负向占位' }, class_type: 'CLIPTextEncode', _meta: { title: 'Negative' } },
  '3': {
    inputs: { seed: 1, steps: 8, cfg: 7, positive: ['6', 0], negative: ['7', 0] },
    class_type: 'KSampler',
  },
  '9': { inputs: { filename_prefix: 'tq', images: ['3', 0] }, class_type: 'SaveImage' },
};
const T2I_META = { title: '任务队列 T2I' };
/** history 在 readyAt 之前返回空表（模拟「还在跑」），所以能观察到 running 状态。 */
const COMFY_SLOW_MS = 3000;

const comfy = { prompts: [], readyAt: new Map(), viewHits: [] };
/** 本机「装了什么节点」——提交前对账会查 /object_info，缺了会直接 409 COMFY_NODE_MISSING。 */
const COMFY_CLASS_TYPES = new Set(Object.values(T2I).map((node) => node.class_type));
const comfyServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const json = (payload, status = 200) => {
      const buf = Buffer.from(JSON.stringify(payload));
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
      res.end(buf);
    };
    if (url.pathname === '/system_stats') return json({ system: { comfyui_version: 'test' } });
    if (url.pathname === '/object_info') {
      const info = {};
      for (const classType of COMFY_CLASS_TYPES) info[classType] = { input: { required: {} } };
      return json(info);
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const parsed = JSON.parse(body || '{}');
      comfy.prompts.push(parsed);
      const id = `tqp${comfy.prompts.length}`;
      let outputId = '';
      for (const [nodeId, node] of Object.entries(parsed?.prompt ?? {})) {
        if (/^SaveImage/.test(node?.class_type ?? '')) {
          outputId = nodeId;
          break;
        }
      }
      comfy.readyAt.set(id, { at: Date.now() + COMFY_SLOW_MS, outputId });
      return json({ prompt_id: id, number: comfy.prompts.length, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.split('/')[2];
      const meta = comfy.readyAt.get(id);
      // 还没到「跑完」的时刻 → 回空表（画布侧会按退避继续轮询）
      if (!meta || Date.now() < meta.at) return json({});
      return json({
        [id]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: {
            [meta.outputId]: { images: [{ filename: 'tq_out.png', subfolder: '', type: 'output' }] },
          },
        },
      });
    }
    if (url.pathname === '/view') {
      comfy.viewHits.push(url.search);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_BYTES.length });
      return res.end(PNG_BYTES);
    }
    if (url.pathname === '/interrupt' || url.pathname === '/queue') return json({});
    return json({ error: 'not found', path: url.pathname }, 404);
  });
});
await new Promise((done) => comfyServer.listen(0, '127.0.0.1', done));
process.env.COMFYUI_URL = `http://127.0.0.1:${comfyServer.address().port}`;
process.env.AIFISHER_COMFY_POLL_MS = '60';
process.env.AIFISHER_COMFY_OBJECT_INFO_TTL_MS = '0';
process.env.AIFISHER_COMFY_WORKFLOW_TTL_MS = '0';

// ---------------------------------------------------------------- host 半

const PROJECT_ID = 'proj-task-queue';
const host = await startHost({
  env: {
    // 这轮只看自配通道：旧单端点（已移除）与方舟都清掉，免得环境残留影响判断
    AIFISHER_CLOUD_BASE_URL: null,
    AIFISHER_CLOUD_API_KEY: null,
    ARK_API_KEY: null,
  },
});

const tasksApi = (method = 'GET', path = '', body) => host.hostApi(method, `/tasks${path}`, body);
const tasksBody = async () => {
  const result = await tasksApi('GET', '?limit=30');
  return { status: result.status, body: result.json() };
};
const taskById = async (id) => (await tasksBody()).body.tasks?.find((item) => item.id === id);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 等一条任务变成期望状态（host 侧写状态是异步的）。 */
async function waitTask(id, predicate, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await taskById(id);
    if (last && predicate(last)) return last;
    await sleep(60);
  }
  return last;
}
async function waitTasks(predicate, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < end) {
    last = (await tasksBody()).body.tasks ?? [];
    if (predicate(last)) return last;
    await sleep(60);
  }
  return last;
}

// ---- 0. 空状态 ------------------------------------------------------------
console.log('\n=== A0. 空状态 ===');
{
  const { status, body } = await tasksBody();
  check('GET /tasks 200 且 ok', status === 200 && body.ok === true, `${status} ${JSON.stringify(body).slice(0, 160)}`);
  check('空表：tasks = []', Array.isArray(body.tasks) && body.tasks.length === 0, JSON.stringify(body.tasks));
  check('空表：running = 0', body.running === 0, String(body.running));
  check('带 serverTime（面板不靠猜时钟）', Number.isFinite(body.serverTime), String(body.serverTime));
  const stats = await host.hostApi('GET', '/status');
  check(
    '/status 里也有任务统计（排查「面板是空的」第一现场）',
    stats.status === 200 && JSON.parse(stats.text).tasks?.total === 0,
    JSON.parse(stats.text).tasks && JSON.stringify(JSON.parse(stats.text).tasks),
  );
}

// ---- 1. 云端图片：成功进队列 ----------------------------------------------
await host.hostApi('POST', '/cloud-channels', {
  action: 'save',
  channel: {
    label: CHANNEL_LABEL,
    baseUrl: `${upstreamBase}/v1`,
    apiKey: 'sk-task-queue',
    models: [
      { id: IMAGE_MODEL_ID, kind: 'image' },
      { id: SLOW_MODEL_ID, kind: 'image' },
      { id: FAIL_MODEL_ID, kind: 'image' },
    ],
  },
});

console.log('\n=== A1. 云端图片：成功 ===');
let cloudTaskId = '';
{
  const result = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: PROJECT_ID,
    nodeId: 'node-cloud-ok',
    generationAttemptId: 'att-cloud-ok',
    prompt: '一只猫在雨里走过霓虹街道',
    imageModel: modelName(IMAGE_MODEL_ID),
    resolution: '1K',
    aspectRatio: '1:1',
  });
  check('云端图片生成 200', result.status === 200, `${result.status} ${result.body.slice(0, 200)}`);
  const task = await waitTask('att-cloud-ok', (item) => item.status === 'success');
  cloudTaskId = task?.id ?? '';
  check('任务队列里出现这条云端任务', Boolean(task), JSON.stringify(task));
  check('attemptId 就是 generationAttemptId（和节点记录对得上）', task?.id === 'att-cloud-ok', String(task?.id));
  check('kind = image', task?.kind === 'image', String(task?.kind));
  check('status = success', task?.status === 'success', String(task?.status));
  check('标题是模型名（面板那一行的大标题）', String(task?.title).includes(IMAGE_MODEL_ID), String(task?.title));
  check('提示词带上了（面板只显示开头一段）', task?.prompt === '一只猫在雨里走过霓虹街道', String(task?.prompt));
  check(
    '时间字段齐全：startedAtMs / finishedAtMs 都是毫秒数且后者 ≥ 前者',
    Number.isFinite(task?.startedAtMs) &&
      Number.isFinite(task?.finishedAtMs) &&
      task.finishedAtMs >= task.startedAtMs,
    JSON.stringify({ startedAtMs: task?.startedAtMs, finishedAtMs: task?.finishedAtMs }),
  );
  check(
    'durationMs 与 elapsedMs 一致（面板「用时 x.xs」用的就是它）',
    task?.durationMs === task.finishedAtMs - task.startedAtMs && task?.elapsedMs === task.durationMs,
    JSON.stringify({ durationMs: task?.durationMs, elapsedMs: task?.elapsedMs, startedAtMs: task?.startedAtMs, finishedAtMs: task?.finishedAtMs }),
  );
  check('产出数 = 1', task?.resultCount === 1, String(task?.resultCount));
  check('云端任务不给「取消」（没有取消钩子）', task?.cancellable === false, String(task?.cancellable));
  check(
    '老字段 createdAt（ISO）还在（/generation-status 一直在用）',
    typeof task?.createdAt === 'string' && !Number.isNaN(Date.parse(task.createdAt)),
    String(task?.createdAt),
  );
}

// ---- 2. 云端失败：错误码与文案都要落到队列里 ------------------------------
console.log('\n=== A2. 云端图片：失败 ===');
{
  const result = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: PROJECT_ID,
    nodeId: 'node-cloud-bad',
    generationAttemptId: 'att-cloud-bad',
    prompt: '会失败的图',
    imageModel: modelName(FAIL_MODEL_ID),
    resolution: '1K',
    aspectRatio: '1:1',
  });
  check('失败请求回 502', result.status === 502, String(result.status));
  const task = await waitTask('att-cloud-bad', (item) => item.status === 'failed');
  check('任务队列里这条是 failed', task?.status === 'failed', String(task?.status));
  check('带上 host 的错误码', task?.code === 'CLOUD_UPSTREAM_ERROR', String(task?.code));
  check(
    '错误文案来自真实响应体（不是只写 HTTP 502）',
    typeof task?.error === 'string' && task.error.includes('显存不够'),
    String(task?.error).slice(0, 200),
  );
  check('失败也算了用时', Number.isFinite(task?.durationMs), String(task?.durationMs));
}

// ---- 3. 本地工作流：运行中 → 取消 ----------------------------------------
const workflowsDir = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'workflows');
mkdirSync(workflowsDir, { recursive: true });
writeFileSync(join(workflowsDir, 'tq-t2i.json'), JSON.stringify(T2I), 'utf8');
writeFileSync(join(workflowsDir, 'tq-t2i.meta.json'), JSON.stringify(T2I_META), 'utf8');

console.log('\n=== A3. 本地工作流：运行中 / 计时 / 取消 ===');
{
  const pending = host.dispatch('POST', '/api/aifisher/canvas/comfy/custom-tq-t2i', {
    projectId: PROJECT_ID,
    nodeId: 'node-comfy-1',
    generationAttemptId: 'att-comfy-1',
    text: '本地工作流提示词',
    negativeText: '低质量',
  });
  const running = await waitTask('att-comfy-1', (item) => item.status === 'running', 4000);
  check('本地工作流在队列里是 running（提交后立刻可见）', running?.status === 'running', JSON.stringify(running));
  check('kind = workflow', running?.kind === 'workflow', String(running?.kind));
  check('标题是工作流标题（meta.title）', running?.title === T2I_META.title, String(running?.title));
  check('提示词带上了', running?.prompt === '本地工作流提示词', String(running?.prompt));
  check('只有本地工作流可取消（cancellable = true）', running?.cancellable === true, String(running?.cancellable));
  check('运行中没有 finishedAtMs', running?.finishedAtMs === undefined, String(running?.finishedAtMs));
  const firstElapsed = (await taskById('att-comfy-1'))?.elapsedMs ?? 0;
  await sleep(250);
  const secondElapsed = (await taskById('att-comfy-1'))?.elapsedMs ?? 0;
  check('运行中的 elapsedMs 随时间增长（面板「已运行 3.4s」的数据源）', secondElapsed > firstElapsed, `${firstElapsed} → ${secondElapsed}`);

  const cancel = await tasksApi('POST', '/cancel', { taskId: 'att-comfy-1' });
  check('POST /tasks/cancel 200', cancel.status === 200 && cancel.json().ok === true, `${cancel.status} ${cancel.text.slice(0, 160)}`);
  const cancelled = await waitTask('att-comfy-1', (item) => item.status === 'cancelled');
  check('取消后队列里是 cancelled', cancelled?.status === 'cancelled', String(cancelled?.status));
  check('取消带 GENERATION_CANCELLED 码', cancelled?.code === 'GENERATION_CANCELLED', String(cancelled?.code));
  const settled = await pending;
  check('挂起的生成请求随之收尾（不会永远挂着）', settled.status !== 200, `${settled.status} ${settled.body.slice(0, 160)}`);
}

// ---- 4. 本地工作流：成功后队列与结果回收都要正确 --------------------------
console.log('\n=== A4. 本地工作流：成功 + 结果回收回归 ===');
{
  const result = await host.dispatch('POST', '/api/aifisher/canvas/comfy/custom-tq-t2i', {
    projectId: PROJECT_ID,
    nodeId: 'node-comfy-2',
    generationAttemptId: 'att-comfy-2',
    text: '第二轮提示词',
  });
  check('本地工作流生成 200', result.status === 200, `${result.status} ${result.body.slice(0, 200)}`);
  const body = JSON.parse(result.body);
  check('回 { success:true, url }', body.success === true && typeof body.url === 'string', JSON.stringify(body).slice(0, 200));
  const task = await waitTask('att-comfy-2', (item) => item.status === 'success');
  check('队列里 success', task?.status === 'success', String(task?.status));
  check('产出数 = 1', task?.resultCount === 1, String(task?.resultCount));
  check(
    '/generation-status 的结果回收语义没被这次重构动到',
    await (async () => {
      const status = await host.hostApi('GET', `/generation-status/node-comfy-2?attemptId=att-comfy-2`);
      const parsed = JSON.parse(status.text);
      return parsed.status === 'success' && parsed.resultUrl === body.url;
    })(),
    '检查 /generation-status 的 status 与 resultUrl',
  );
  const stale = await host.hostApi('GET', `/generation-status/node-comfy-2?attemptId=att-OLD`);
  check('attemptId 对不上仍报 missing（旧 UI 不能覆盖新结果）', JSON.parse(stale.text).status === 'missing');
  const all = (await tasksBody()).body.tasks ?? [];
  check(
    '同一个节点跑第二轮不会把第一轮的历史顶掉（每条 attempt 一行）',
    all.some((item) => item.id === 'att-comfy-1') && all.some((item) => item.id === 'att-comfy-2'),
    JSON.stringify(all.map((item) => item.id)),
  );
  const orderOf = (id) => all.findIndex((item) => item.id === id);
  check(
    '列表新的在前（刚跑完的那条比更早的云端任务靠前）',
    orderOf('att-comfy-2') >= 0 && orderOf('att-comfy-2') < orderOf('att-cloud-ok'),
    JSON.stringify(all.map((item) => item.id)),
  );
}

// ---- 5. 同一节点两轮并发：老的那轮被标成被取代 ----------------------------
console.log('\n=== A5. 同节点并发：不留僵尸行 ===');
{
  const first = host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: PROJECT_ID,
    nodeId: 'node-dup',
    generationAttemptId: 'att-dup-1',
    prompt: '第一轮',
    imageModel: modelName(SLOW_MODEL_ID),
    resolution: '1K',
    aspectRatio: '1:1',
  });
  await waitTask('att-dup-1', (item) => item.status === 'running', 3000);
  const second = host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: PROJECT_ID,
    nodeId: 'node-dup',
    generationAttemptId: 'att-dup-2',
    prompt: '第二轮',
    imageModel: modelName(SLOW_MODEL_ID),
    resolution: '1K',
    aspectRatio: '1:1',
  });
  const superseded = await waitTask('att-dup-1', (item) => item.status === 'cancelled', 3000);
  check('上一轮被标成被取代（不会永远显示运行中）', superseded?.status === 'cancelled', String(superseded?.status));
  check('取代码是 GENERATION_SUPERSEDED', superseded?.code === 'GENERATION_SUPERSEDED', String(superseded?.code));
  const latest = (await tasksBody()).body.tasks ?? [];
  check(
    '新一轮还在跑，且两轮都在列表里',
    latest.filter((item) => item.nodeId === 'node-dup' && item.status === 'running').length === 1,
    JSON.stringify(latest.filter((item) => item.nodeId === 'node-dup').map((item) => [item.id, item.status])),
  );
  await Promise.all([first, second]);
}

// ---- 6. 清空已完成 --------------------------------------------------------
console.log('\n=== A6. 删除接口 ===');
{
  const before = await tasksBody();
  const expectedRemoved = before.body.tasks.filter((item) => item.status !== 'running').length;
  const removed = await tasksApi('DELETE');
  check('DELETE /tasks 200', removed.status === 200, String(removed.status));
  check(
    '只清掉已结束的（条数对得上）',
    removed.json().removed === expectedRemoved,
    `${removed.json().removed} vs ${expectedRemoved}`,
  );
  const after = await tasksBody();
  check('清空后列表里不再有已结束的任务', (after.body.tasks ?? []).every((item) => item.status === 'running'), JSON.stringify((after.body.tasks ?? []).map((i) => i.status)));
}

// ---------------------------------------------------------------- B. 面板（jsdom 画布）

console.log('\n=== B. 画布右侧面板 ===');
// 面板这一段要干净的初始状态：清空已完成 + 等剩下的都落地
await tasksApi('DELETE');
await sleep(200);
await tasksApi('DELETE');

await host.hostApi('POST', '/workflows', {
  id: PROJECT_ID,
  revision: 0,
  title: '任务队列验证',
  nodes: [],
  groups: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});

/**
 * ⚠️ 真 fetch 必须在 createCanvasDom **之前**抓：它会当场把 globalThis.fetch 换成
 * 「直接派发给插件路由的假 fetch」，之后抓到的那份就是假的。
 */
const nodeFetch = globalThis.fetch;
const { window } = await createCanvasDom({ dispatch: host.dispatch });
/**
 * jsdom 装置把 window.fetch 换成了「直接派发给插件路由的假 fetch」，而插件 host 半自己
 * 调云端端点用的是 globalThis.fetch。两者混在一起时，host 对**假云端端点**的请求也会被
 * 塞进路由分发器（回 no route 404）—— 云端任务就永远起不来。所以这里照
 * test-cloud-channels 的做法：绝对 URL 走真 fetch，相对路径才走路由分发。
 */
const routedFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (/^https?:\/\//i.test(raw)) return nodeFetch(input, init);
  return routedFetch(input, init);
};
globalThis.fetch = window.fetch;
seedResume(window, PROJECT_ID);
const { container } = await mountCanvasApp(window);
await settle(1600);

const $ = (selector) => window.document.querySelector(selector);
const $$ = (selector) => [...window.document.querySelectorAll(selector)];
const panel = () => $('[data-fisherai-task-queue="panel"]');
const rail = () => $('[data-fisherai-task-queue="rail"]');
const rowOf = (id) => $(`[data-fisherai-task-queue-item="${id}"]`);
const rows = () => $$('[data-fisherai-task-queue-item]');
function click(element) {
  if (!element) return false;
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}
async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await settle(120);
  }
  return last;
}

check('画布挂载后右侧就有任务队列面板（默认展开）', Boolean(panel()), `panels=${$$('[data-fisherai-task-queue]').length}`);
check('面板挂在画布容器里（继承画布主题变量）', Boolean(panel()) && container.contains(panel()), String(Boolean(panel())));
check('面板 aria-label = 任务队列', panel()?.getAttribute('aria-label') === '任务队列', String(panel()?.getAttribute('aria-label')));
check('面板标题里写着「任务队列」', String(panel()?.textContent).includes('任务队列'));
{
  const style = (panel()?.parentElement ?? window.document).querySelector('[data-fisherai-task-queue-style]');
  const css = style?.textContent ?? '';
  check('注入了面板样式表', Boolean(style), String(Boolean(style)));
  check('样式表里有循环扫光 keyframes', css.includes('af-task-queue-sweep'), css.slice(0, 60));
  check('样式表里有呼吸发光 keyframes', css.includes('af-task-queue-glow'));
  check('边框是「抠成 1px 环」实现的（mask-composite）', css.includes('mask-composite') && css.includes('padding: 1px'));
  check('动画只挂在 running 行上（选择器带状态）', css.includes("[data-fisherai-task-status='running']::before"));
  check('尊重 prefers-reduced-motion', css.includes('prefers-reduced-motion'));
}
{
  const style = panel()?.getAttribute('style') ?? '';
  check(
    '贴在画布右上角（绝对定位 right:12px / top:8px；v1.36 用户要求「往上移」）',
    style.includes('position: absolute') && style.includes('right: 12px') && style.includes('top: 8px'),
    style,
  );
  // 面板从 top:8 起会盖住头部右端 —— 头部靠这个变量把保存状态让出来（v1.36）
  const inset = container.style.getPropertyValue('--fisherai-task-queue-inset');
  check(
    '展开时把「占位宽度」写给头部（--fisherai-task-queue-inset = 306px）',
    inset === '306px',
    inset || '(none)',
  );
}

// ---- B0. 只在画布这一层（v1.41）------------------------------------------
//
// 用户 2026-10-18 原话：「任务队列希望只出现在画布这一层，现在点击设置啥的都看的见任务队列」。
// 机制：接管型浮层都走 vendor 的 activateModal，它给浮层路径上的兄弟节点加 inert；
// 面板是画布容器的直接子节点 → 浮层一开就带 inert → 样式表把 `[inert]` 设成 display:none。
// jsdom 没有 CSS 引擎，所以这里守两件事：
//   ① 样式表里有那条守卫规则（选择器 + display:none，真机由 browser-check 量 display）；
//   ② 真开一次设置，面板**真的**拿到 inert、关掉设置**真的**被摘掉（这条是行为断言）。
{
  const css = window.document.querySelector('[data-fisherai-task-queue-style]')?.textContent ?? '';
  check(
    '样式表里有「浮层打开时面板不出现」的守卫规则（[inert] → display:none）',
    css.includes('[data-fisherai-task-queue][inert]') && /display:\s*none/.test(css),
    css.slice(css.indexOf('[data-fisherai-task-queue][inert]'), css.indexOf('[data-fisherai-task-queue][inert]') + 80),
  );
  check('平时（没有浮层）面板不带 inert', panel()?.hasAttribute('inert') === false, String(panel()?.getAttribute('inert')));

  window.dispatchEvent(new window.CustomEvent('fisherai:open-settings'));
  const settingsDialog = await waitFor(() => $('[data-fisherai-settings="true"]'), 6000);
  check('设置对话框真的打开了（vendor 的 activateModal 生效）', Boolean(settingsDialog), String(Boolean(settingsDialog)));
  check('设置打开时面板拿到 inert（浮层接管了画布这一层）', panel()?.hasAttribute('inert') === true, String(panel()?.getAttribute('inert')));
  check(
    '面板自己的位置/内容没被改动（只是被盖掉，不是被卸载）',
    Boolean(panel()) && (panel()?.getAttribute('style') ?? '').includes('right: 12px'),
    String(Boolean(panel())),
  );

  click(settingsDialog?.querySelector('button[aria-label="关闭设置"]'));
  const released = await waitFor(() => $('[data-fisherai-settings="true"]') === null && panel()?.hasAttribute('inert') === false, 6000);
  check('关掉设置后 inert 被摘掉、面板回到画布层', released === true || (released === false && panel()?.hasAttribute('inert') === false), String(panel()?.hasAttribute('inert')));
  check('关掉设置后面板还在（没被这次开关弄丢）', Boolean(panel()), String(Boolean(panel())));
}

// ---- B1. 空态 -------------------------------------------------------------
{
  const empty = await waitFor(() => $('[data-fisherai-task-queue-empty]'));
  check('没有任务时显示空态', Boolean(empty), String(Boolean(empty)));
  check('空态文案给的是「暂无生成任务」', String(empty?.textContent).includes('暂无生成任务'), String(empty?.textContent).slice(0, 60));
  check('空闲时角标写「空闲」', String(panel()?.textContent).includes('空闲'), String(panel()?.textContent).slice(0, 80));
}

// ---- B2. 运行中：行 + 发光选择器 + 用时在跳 ------------------------------
const panelSlow = host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
  projectId: PROJECT_ID,
  nodeId: 'node-panel-slow',
  generationAttemptId: 'att-panel-slow',
  prompt: '面板上的运行中任务：一只猫在雨里走过霓虹街道',
  imageModel: modelName(SLOW_MODEL_ID),
  resolution: '1K',
  aspectRatio: '1:1',
});
{
  const runningRow = await waitFor(() => $('[data-fisherai-task-queue-item][data-fisherai-task-status="running"]'), 6000);
  check('面板上出现「运行中」那一行', Boolean(runningRow), `rows=${rows().length}`);
  check(
    '这一行命中的就是「边框循环发光」的选择器（状态属性驱动）',
    runningRow?.getAttribute('data-fisherai-task-status') === 'running' &&
      runningRow?.matches('[data-fisherai-task-queue-item][data-fisherai-task-status="running"]'),
    String(runningRow?.getAttribute('data-fisherai-task-status')),
  );
  check('行里有类型标签（图片）', String(runningRow?.textContent).includes('图片'), String(runningRow?.textContent).slice(0, 80));
  check('行里有开始时刻 HH:MM:SS', /\d{2}:\d{2}:\d{2}/.test(String(runningRow?.textContent)), String(runningRow?.textContent).slice(0, 120));
  check('行里写着「运行中」', String(runningRow?.textContent).includes('运行中'));
  check('运行中的云端任务没有「取消」按钮（做不到的事不给按钮）', !runningRow?.querySelector('[data-fisherai-task-cancel]'));
  check('顶部角标显示「1 运行中」', String(panel()?.textContent).includes('1 运行中'), String(panel()?.textContent).slice(0, 80));
  const elapsedNode = runningRow?.querySelector('[data-fisherai-task-elapsed-ms]');
  const firstElapsed = Number(elapsedNode?.getAttribute('data-fisherai-task-elapsed-ms'));
  await settle(900);
  const secondElapsed = Number(
    $('[data-fisherai-task-queue-item][data-fisherai-task-status="running"]')
      ?.querySelector('[data-fisherai-task-elapsed-ms]')
      ?.getAttribute('data-fisherai-task-elapsed-ms'),
  );
  check('用时在实时跳动（0.5s 心跳）', secondElapsed > firstElapsed, `${firstElapsed} → ${secondElapsed}`);
  check('用时文本形如「已运行 2.3s」', /已运行 \d/.test(String(runningRow?.textContent)), String(runningRow?.textContent).slice(0, 140));

  // 有任务在跑时收起：右缘窄轨道要带角标（收起了也看得出还在跑）
  click($('button[aria-label="收起任务队列"]'));
  await settle(250);
  check('点「收起任务队列」后展开面板消失', !panel(), `panels=${$$('[data-fisherai-task-queue="panel"]').length}`);
  check('收起成右缘窄轨道', Boolean(rail()), String(Boolean(rail())));
  check(
    '窄轨也跟着上移（top:8，不是掉回 60）',
    String(rail()?.getAttribute('style') ?? '').includes('top: 8'),
    String(rail()?.getAttribute('style') ?? '(none)'),
  );
  check(
    '收起后头部让位缩小（--fisherai-task-queue-inset = 44px）',
    container.style.getPropertyValue('--fisherai-task-queue-inset') === '44px',
    container.style.getPropertyValue('--fisherai-task-queue-inset') || '(none)',
  );
  check(
    '轨道上有运行中角标',
    Boolean(rail()?.querySelector('[data-fisherai-task-queue-rail-badge]')),
    String(rail()?.textContent),
  );
  check(
    '收起状态落盘（刷新后还记得）',
    window.localStorage.getItem('dsh-aifisher-canvas.taskQueue.open') === '0',
    String(window.localStorage.getItem('dsh-aifisher-canvas.taskQueue.open')),
  );
  click($('button[aria-label="展开任务队列"]'));
  await settle(300);
  check('点「展开任务队列」后展开面板回来', Boolean(panel()) && !rail(), `panels=${$$('[data-fisherai-task-queue="panel"]').length}`);
  check(
    '展开状态也落盘',
    window.localStorage.getItem('dsh-aifisher-canvas.taskQueue.open') === '1',
    String(window.localStorage.getItem('dsh-aifisher-canvas.taskQueue.open')),
  );
}

// ---- B3. 结束后：行变完成、带产出数 --------------------------------------
{
  await panelSlow;
  // 注意：这一行**一直都在**（从运行中就在），所以要等的是它的状态属性变 success，
  // 而不是「行出现了」——否则会在它还在跑的那一秒就拿到一个 running 的快照。
  const doneRow = await waitFor(() => {
    const row = rowOf('att-panel-slow');
    return row?.getAttribute('data-fisherai-task-status') === 'success' ? row : null;
  }, 12000);
  check('任务结束后那一行变 success', doneRow?.getAttribute('data-fisherai-task-status') === 'success', String(doneRow?.getAttribute('data-fisherai-task-status')));
  check('完成后显示「用时 x」而不是「已运行」', String(doneRow?.textContent).includes('用时'), String(doneRow?.textContent).slice(0, 140));
  check('带产出数（1 个结果）', String(doneRow?.textContent).includes('1 个结果'), String(doneRow?.textContent).slice(0, 160));
  check(
    '抬头的运行中角标没了（角标切回空闲/条数）',
    panel()?.querySelector('[data-fisherai-task-queue-badge="running"]') === null,
    String(panel()?.querySelector('[data-fisherai-task-queue-badge]')?.textContent),
  );
}

// ---- B4. 失败行把错误码显示出来 ------------------------------------------
{
  await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: PROJECT_ID,
    nodeId: 'node-panel-bad',
    generationAttemptId: 'att-panel-bad',
    prompt: '会失败的任务',
    imageModel: modelName(FAIL_MODEL_ID),
    resolution: '1K',
    aspectRatio: '1:1',
  });
  const failedRow = await waitFor(() => $('[data-fisherai-task-queue-item="att-panel-bad"]'), 6000);
  check('失败的行渲染出来了', failedRow?.getAttribute('data-fisherai-task-status') === 'failed', String(failedRow?.getAttribute('data-fisherai-task-status')));
  const errorNode = failedRow?.querySelector('[data-fisherai-task-error]');
  check('失败行有错误行', Boolean(errorNode), String(Boolean(errorNode)));
  check('错误行里带错误码', String(errorNode?.textContent).includes('CLOUD_UPSTREAM_ERROR'), String(errorNode?.textContent).slice(0, 120));
  check('失败行没有产出数', !String(failedRow?.textContent).includes('个结果'));
}

// ---- B5. 本地工作流：取消按钮 + 真取消 ------------------------------------
{
  const pending = host.dispatch('POST', '/api/aifisher/canvas/comfy/custom-tq-t2i', {
    projectId: PROJECT_ID,
    nodeId: 'node-panel-comfy',
    generationAttemptId: 'att-panel-comfy',
    text: '面板上要取消的那次',
  });
  const runningRow = await waitFor(
    () => {
      const row = rowOf('att-panel-comfy');
      return row?.getAttribute('data-fisherai-task-status') === 'running' ? row : null;
    },
    6000,
  );
  check('本地工作流的运行中行也进面板', Boolean(runningRow), String(runningRow?.getAttribute('data-fisherai-task-status')));
  check('这一行写着工作流类型', String(runningRow?.textContent).includes('工作流'), String(runningRow?.textContent).slice(0, 80));
  const cancelButton = runningRow?.querySelector('[data-fisherai-task-cancel]');
  check('可取消的行上有「取消」按钮', Boolean(cancelButton), String(Boolean(cancelButton)));
  click(cancelButton);
  const cancelledRow = await waitFor(
    () => {
      const row = rowOf('att-panel-comfy');
      return row?.getAttribute('data-fisherai-task-status') === 'cancelled' ? row : null;
    },
    8000,
  );
  check('点取消后面板上变「已取消」', Boolean(cancelledRow), String(rowOf('att-panel-comfy')?.getAttribute('data-fisherai-task-status')));
  const settled = await pending;
  check('取消后挂起的请求收尾（画布拉不到结果）', settled.status !== 200, String(settled.status));
}

// ---- B6. 清空已完成 -------------------------------------------------------
{
  const clearButton = $('button[aria-label="清空已完成任务"]');
  check('有已完成任务时出现「清空已完成任务」按钮', Boolean(clearButton));
  click(clearButton);
  const empty = await waitFor(() => $('[data-fisherai-task-queue-empty]'), 6000);
  check('清空后回到空态', Boolean(empty), `rows=${rows().length}`);
}

// ---------------------------------------------------------------- C. 产物契约

console.log('\n=== C. 产物与文档 ===');
{
  const hostBundle = await import('node:fs').then((fs) =>
    fs.readFileSync(join(process.cwd(), 'lib/index.js'), 'utf8'),
  );
  check('host 产物里有任务队列路由', hostBundle.includes('api/aifisher/canvas/tasks') || hostBundle.includes('/tasks'), `len=${hostBundle.length}`);
  check('host 产物里保留了 GENERATION_SUPERSEDED', hostBundle.includes('GENERATION_SUPERSEDED'));
  const canvasBundle = await import('node:fs').then((fs) =>
    fs.readFileSync(join(process.cwd(), 'lib/canvas/canvas-app.js'), 'utf8'),
  );
  check('画布产物里有面板的定位属性', canvasBundle.includes('data-fisherai-task-queue'));
  check('画布产物里有发光 keyframes', canvasBundle.includes('af-task-queue-sweep') && canvasBundle.includes('af-task-queue-glow'));
  const readme = await import('node:fs').then((fs) =>
    fs.readFileSync(join(process.cwd(), 'README.md'), 'utf8'),
  );
  check('README 写了任务队列', readme.includes('任务队列'));
  const doc = await import('node:fs').then((fs) =>
    fs.readFileSync(join(process.cwd(), 'docs/canvas-ui-shadcn.md'), 'utf8'),
  );
  check('docs/canvas-ui-shadcn.md 写了任务队列的结构契约', doc.includes('任务队列'));
}

// ---------------------------------------------------------------- 汇总

console.log(`\nSUMMARY ${failures === 0 ? 'PASS' : 'FAIL'}  ${lines.length - failures}/${lines.length} 项通过`);
if (failures > 0) {
  console.log('\n失败项：');
  for (const line of lines) if (line.startsWith('FAIL')) console.log(line);
}
process.exit(failures === 0 ? 0 : 1);
