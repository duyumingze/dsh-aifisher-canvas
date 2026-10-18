/**
 * 画布「云端模型生成」闭环回归（scripts/test-canvas-cloud-generation.mjs）。
 *
 * 起因（2026-10-16）：host 侧 v1.4 把方舟直连（arkImageProvider）与通用云端端点
 * （cloudGenerationRouter）都接好了，画布上也能选中「豆包图片5.0-pro(方舟直连)」，
 * 但**点节点上的生图按钮没有任何反应** —— 因为 src/client/canvas/stage.tsx 里
 * `useGeneration` 一直是空实现（只 console.warn 一句），节点状态根本不推进。
 *
 * 这条用例就在真挂起来的画布上把那个按钮点下去，验到「节点变成功 + 结果落素材库」：
 *
 *   建项目（预置一个 Image 节点，模型=方舟直连）
 *     → 挂画布（jsdom，window.fetch 接回 host 真实路由）
 *     → 点 [aria-label="生成图片"]
 *     → POST /api/aifisher/canvas/generate-image（上游 useCanvasGeneration 发出）
 *     → host 翻成方舟形状 → 假方舟 → 结果下载落素材库
 *     → 节点 status=success，resultUrl 指向 /api/aifisher/canvas/media/…
 *   以及「没配 Key 时要点得出错误来」——以前是静默无反应，现在必须把 501 的文案写到节点上。
 *
 * 用法：node scripts/test-canvas-cloud-generation.mjs   （需要先 build）
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

/** 1x1 透明 PNG（真字节：验落盘的确实是「方舟」给的那张图）。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const MODEL_5_PRO = '豆包图片5.0-pro(方舟直连)';
const ARK_MODEL_ID = 'doubao-seedream-5-0-pro-260628';
const PROJECT_ID = 'proj-cloud-generate';
const NODE_ID = 'node-cloud-image';
/** v1.32：接在第一个节点右边、把它的结果当参考图的第二个节点。 */
const NODE2_ID = 'node-cloud-image-2';

// ---------------------------------------------------------------- 假方舟（生成端点 + 图床）

const received = [];
let base = '';
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
    if (req.method === 'GET' && /^\/result-\d+\.png$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG_BYTES);
    }
    if (req.url === '/api/v3/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          created: 1,
          model: body?.model,
          data: [{ url: `${base}/result-1.png`, size: body?.size, output_format: 'png' }],
        }),
      );
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such path', path: req.url }));
  });
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
base = `http://127.0.0.1:${upstream.address().port}`;

// ---------------------------------------------------------------- host 半 + 预置项目

const host = await startHost({
  env: { ARK_API_KEY: 'ark-test-key', ARK_BASE_URL: `${base}/api/v3` },
});

const IMAGE_NODE = {
  id: NODE_ID,
  type: 'Image',
  x: 0,
  y: 0,
  prompt: '一只猫在雨里走过霓虹街道',
  status: 'idle',
  imageModel: MODEL_5_PRO,
  imageMode: 'text-to-image',
  aspectRatio: '16:9',
  resolution: '1K',
  parentIds: [],
  projectId: PROJECT_ID,
  width: 224,
  height: 209,
  generateCount: 1,
  watermark: false,
};

/**
 * v1.32：第二个节点，**参考图 = 第一个节点的结果**。
 *
 * 第一个节点成功后，它的 `resultUrl` 会带客户端加的缓存戳（`?t=<毫秒>`，vendor 的
 * `withTimestamp()` 加的）。以前这个带戳的 URL 会被原样塞进请求体，host 按路径找文件时
 * 把 `?t=…` 当成文件名的一部分 → 「参考素材读不出来」。这条用例就走一遍真画布：
 * 点第二个节点的生成 → 假方舟收到的 `image` 必须是 data URL（缓存戳不进请求体）。
 */
const IMAGE_NODE_2 = {
  id: NODE2_ID,
  type: 'Image',
  x: 420,
  y: 0,
  prompt: '把这张图里的腿修成两条',
  status: 'idle',
  imageModel: MODEL_5_PRO,
  imageMode: 'image-to-image',
  aspectRatio: '16:9',
  resolution: '1K',
  parentIds: [NODE_ID],
  sourcePortIndices: [0],
  projectId: PROJECT_ID,
  width: 224,
  height: 209,
  generateCount: 1,
  watermark: false,
};

{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '云端生成验证',
    nodes: [IMAGE_NODE, IMAGE_NODE_2],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目（含一个方舟模型的 Image 节点）写入本地后端',
    save.status === 200, String(save.text).slice(0, 160));
}

/** 画布真正存盘的文档（节点字段的唯一可信来源）。 */
async function savedNode(id = NODE_ID) {
  const result = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  if (result.status !== 200) return undefined;
  try {
    return (JSON.parse(result.text).nodes ?? []).find((node) => node.id === id);
  } catch {
    return undefined;
  }
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

// ---------------------------------------------------------------- 挂画布（进画布视图）

/**
 * host 半出网用的真 fetch。createCanvasDom 会把 `globalThis.fetch` / `window.fetch` 都换成
 * 「转发回 host 路由」的那份，而 host 半发往方舟端点、发往结果图床的请求走的正是
 * `globalThis.fetch` —— 不区分开就会被劫持成一次插件内路由查询（得到 404 no route）。
 * 所以这里包一层：相对路径（画布自己的请求，无论走 window.fetch 还是裸 fetch）照旧转发给
 * host 路由，绝对 URL（host 半出网）交给真 fetch。
 */
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

const nodeElement = (id = NODE_ID) => container.querySelector(`[data-node-id="${id}"]`);
const generateButton = (id = NODE_ID) =>
  nodeElement(id)?.querySelector('button[aria-label="生成图片"]') ??
  nodeElement(id)?.querySelector('button[aria-label="正在生成图片"]');

check('画布进入画布视图并渲染出那个 Image 节点', Boolean(nodeElement()),
  container.innerHTML.slice(0, 200).replace(/\s+/g, ' '));

/**
 * 选中节点 —— 图片节点的生成按钮在 Composer 里，而 Composer 只在 `props.selected` 时渲染
 * （canvasMediaCards 的 `controls = props.selected && …`）。jsdom 里没有 PointerEvent，
 * 用 MouseEvent 派发同名事件即可（React 按事件类型监听）。
 */
async function selectNode(id = NODE_ID) {
  const element = nodeElement(id);
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
  return (await waitFor(async () => element.getAttribute('data-node-selected') === 'true', 8000)) === true;
}

check('点一下节点能选中（生成按钮只在选中态的 Composer 里）', await selectNode(),
  String(nodeElement()?.getAttribute('data-node-selected')));

// ---------------------------------------------------------------- 1. 生成按钮可用（不是禁用态）

{
  const button = await waitFor(async () => generateButton(), 8000);
  check('选中后渲染出生图按钮', Boolean(button));
  // 以前这里是「点了没反应」的根源之一：host 没实现 /generation-concurrency 时按钮会一直
  // checking → disabled。host 现在恒回 blocked:false，所以按钮必须可点。
  check('生图按钮不是禁用态（并发查询不再把它卡在 checking）',
    button?.disabled === false, String(button?.disabled));
  check('画布确实问过并发状态', fetchCalls.some((call) => call.includes('generation-concurrency')),
    fetchCalls.filter((call) => call.includes('concurrency')).join(' | ') || '(none)');
}

// ---------------------------------------------------------------- 2. 点下去 → 真的提交 → 节点成功

{
  generateButton().click();
  const loading = await waitFor(async () => {
    const node = await savedNode();
    return node?.status === 'loading' ? node : null;
  }, 8000);
  check('点生图后节点进入 loading（不再是点了毫无反应）', loading?.status === 'loading',
    String((await savedNode())?.status));

  const call = await waitFor(
    async () => received.find((item) => item.url === '/api/v3/images/generations') ?? null,
    12000,
  );
  check('画布把请求发到了 host 的 /generate-image（fetch 记录）',
    fetchCalls.some((item) => item === 'POST /api/aifisher/canvas/generate-image'),
    fetchCalls.filter((item) => item.includes('generate-image')).join(' | ') || '(none)');
  check('host 把它翻成方舟形状发给了假方舟', Boolean(call), JSON.stringify(received.map((item) => item.url)));
  check('用的是节点上选的那个方舟模型 ID', call?.body?.model === ARK_MODEL_ID, String(call?.body?.model));
  check('提示词原样带过去', call?.body?.prompt === IMAGE_NODE.prompt, String(call?.body?.prompt));
  // 1K + 16:9 本来算 1024x576，低于 5.0 pro 的最小像素（921600），host 按模型范围夹到 1280x720。
  check('档位+宽高比翻成方舟的宽x高（并按模型最小像素夹取）', call?.body?.size === '1280x720',
    String(call?.body?.size));
  check('鉴权用配置里的 Key', call?.headers?.authorization === 'Bearer ark-test-key',
    String(call?.headers?.authorization));

  // inspectImage 在 jsdom 里没有图片加载事件，靠它自己的 5s 超时收尾，所以这里要等够。
  const done = await waitFor(async () => {
    const node = await savedNode();
    return node?.status === 'success' ? node : null;
  }, 25000);
  check('节点最终变成 success', done?.status === 'success', String((await savedNode())?.status));
  check('结果 URL 指向本站素材库', String(done?.resultUrl).startsWith('/api/aifisher/canvas/media/'),
    String(done?.resultUrl));
  check('结果图字节真的落盘了（方舟 url 24 小时失效，必须立刻下载）', (() => {
    if (!done?.resultUrl) return false;
    // 节点上的 URL 带客户端加的缓存戳（?t=…），落盘路径要去掉查询串。
    const rel = decodeURIComponent(
      String(done.resultUrl).split('?')[0].replace('/api/aifisher/canvas/media/', ''),
    );
    return existsSync(join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', ...rel.split('/')));
  })(), String(done?.resultUrl));
}

// ---------------------------------------------------------------- 2b. 拿「刚生成的图」当参考图再生成一次（v1.32）

/**
 * 用户 2026-10-17 的报障就在这一步：节点上写着
 *   「参考素材读不出来：/api/aifisher/canvas/media/<项目>/images/media-xxxx.png?t=1792243183952」
 * —— 那张图明明在素材库里。因果链：结果 URL 带显示用缓存戳（`withTimestamp()` 加的），
 * 而它同时是下一张图的参考素材；缓存戳不该进请求体（vendor 补丁 3.8l），host 解析素材
 * URL 时也必须先归一 pathname（mediaStore.parseMediaUrlRef）。这条端到端把两半一起钉住。
 */
{
  check('第二个节点渲染出来了（参考图 = 第一个节点的结果）', Boolean(nodeElement(NODE2_ID)),
    container.innerHTML.length ? '' : '(empty)');
  check('第二个节点能选中', await selectNode(NODE2_ID),
    String(nodeElement(NODE2_ID)?.getAttribute('data-node-selected')));

  const before = received.length;
  const button = await waitFor(async () => generateButton(NODE2_ID), 8000);
  check('第二个节点也有生图按钮且可点', button?.disabled === false, String(button?.disabled));
  button?.click();

  const refCall = await waitFor(
    async () =>
      received.slice(before).find((item) => item.url === '/api/v3/images/generations') ?? null,
    15000,
  );
  const image = refCall?.body?.image;
  check(
    '图生图：缓存戳（?t=…）没进请求体，参考图被内联成 data URL',
    typeof image === 'string' && image.startsWith('data:image/png;base64,'),
    String(image).slice(0, 40),
  );
  check(
    '图生图：内联的正是上一个节点产出的那张图（不是空占位）',
    typeof image === 'string' &&
      image === `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    String(image).slice(-24),
  );
  const secondDone = await waitFor(async () => {
    const node = await savedNode(NODE2_ID);
    return node?.status === 'success' ? node : null;
  }, 25000);
  const secondFinal = (await savedNode(NODE2_ID)) ?? {};
  check('图生图那次也跑成功了（没有卡在「参考素材读不出来」）',
    secondDone?.status === 'success',
    `${secondFinal.status} ${secondFinal.errorMessage ?? ''}`);
}

// ---------------------------------------------------------------- 3. 没配 Key 时要点得出错误来

{
  const savedKey = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  try {
    await settle(300);
    // 2b 选中了第二个节点，这里要切回第一个（生成按钮只在选中态的 Composer 里）
    await selectNode(NODE_ID);
    const button = await waitFor(async () => generateButton(NODE_ID), 8000);
    check('切回第一个节点后生图按钮还在', Boolean(button));
    button?.click();
    const errored = await waitFor(async () => {
      const node = await savedNode();
      return node?.status === 'error' ? node : null;
    }, 15000);
    check('没配 Key 时节点变成 error（而不是静默无反应）', errored?.status === 'error',
      String((await savedNode())?.status));
    check('错误文案说清去哪儿填 Key', String(errored?.errorMessage).includes('ARK_API_KEY'),
      String(errored?.errorMessage).slice(0, 120));
  } finally {
    process.env.ARK_API_KEY = savedKey;
  }
}

// ---------------------------------------------------------------- 4. 全程无运行时错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=200')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('生成全程无运行时错误', errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)');
}

try {
  handle.dispose();
} catch {
  /* 卸载失败在渲染测试里单独断言 */
}
upstream.close();
rmSync(host.fakeHome, { recursive: true, force: true });
void mkdirSync;
void readFileSync;

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
