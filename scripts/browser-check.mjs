/**
 * 真浏览器渲染检查（Chromium 截图）。
 *
 * 为什么需要它：jsdom 能验「逻辑链路 + 不崩」，但没有布局引擎，验不了
 * 「画布在容器里到底排成什么样」（w-screen 溢出、面板被侧边栏盖住这类问题）。
 * DSH 自己的页面需要 cookie，外部浏览器进不去，所以这里自己搭一个最小宿主页：
 *
 *   [frame: position:relative; height:100vh; display:grid]   ← 复刻 DSH 的 AppFrame
 *     [sidebar 240px][centerCol: static, grid item]           ← 复刻 DSH 的 centerCol（无 position）
 *        [.af-canvas-mount]                                   ← 画布挂载点（与 CanvasPanel 一致）
 *
 * 页面里的 fetch 指向本脚本起的静态服务；该服务把 /api/aifisher/canvas/* 直接交给
 * **真插件的路由处理器**（import lib/index.js + 假 webServer 捕获），所以画布拿到的是
 * 真数据。然后用 headless Chromium 截图，人（agent）可以直接看图核对布局。
 *
 * 用法：node scripts/browser-check.mjs [--keep]
 *   --keep  截图后不删临时 DSH_HOME / 用户数据目录，方便复现
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { decodePngGray, decodePngRgb, measureGridPattern, regionStats, rgbStats, quietBlock } from './lib/png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BROWSER_CHECK_PORT ?? 3199);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/**
 * 截图落盘目录。
 *
 * ⚠️ 本机注意：workspace-write 沙箱下 pwsh 是 Low 完整性，这一场**跑不起来** ——
 * 一是 `.dsh-tmp/shots` 里上一轮（完全权限跑的）留下的同名 PNG 删不掉（rmSync EPERM），
 * 二是 headless Chrome 在 Low 完整性下直接以 0x80000003 退出、一张图都不出。
 * 所以 browser-check 必须在**完全权限**的一次命令里跑（与完整构建同一条链）。
 */
const SHOTS = join(ROOT, '.dsh-tmp', 'shots');
const KEEP = process.argv.includes('--keep');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('找不到 Chrome/Edge，跳过浏览器检查。');
  process.exit(0);
}

// ---------------------------------------------------------------- 真插件路由（假 webServer 捕获）

const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-aifisher-browser-'));
process.env.DSH_HOME = fakeHome;

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
}

const routes = new Map();
const hostMod = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);

/**
 * 画布右侧对话面板（?chat=1 场景）的宿主桩。
 *
 * 真机上「画布对话」的正文来自 DSH 内核的 sessionController + agent/assistant-stream，
 * **回合收尾看 durable session/event（turn/end）**；这个脚本本来就是「真插件路由 + 假 DSH 宿主」，
 * 所以这里给一份最小假件：投递消息后按真机顺序回帧 —— 领进 turn → attempt 的
 * start/chunks/end → 持久 assistant/message → turn/end，让
 * 「面板 → host 路由 → 会话 → SSE → 回填消息」整圈在真浏览器里跑通。
 */
const chatListeners = new Map();
const emitChat = (name, ...args) => {
  for (const listener of chatListeners.get(name) ?? []) {
    try {
      listener(...args);
    } catch {
      /* 监听器自己吞错 */
    }
  }
};
const chatStub = {
  created: [],
  prompts: [],
  async create(request) {
    chatStub.created.push(request);
    return { sessionId: request.sessionId };
  },
  async prompt(request) {
    chatStub.prompts.push(request);
    const turn = chatStub.prompts.length;
    setTimeout(() => {
      emitChat('agent/inbox/claimed', {
        agent: { session: { id: request.sessionId } },
        message: { id: `msg-${turn}`, source: { kind: 'user', rpcId: request.requestId } },
        turn,
      });
      for (const frame of [
        { type: 'start', revision: 1 },
        { type: 'chunk', chunk: { type: 'text-delta', text: '已经按你说的' } },
        { type: 'chunk', chunk: { type: 'text-delta', text: '建好节点了。' } },
        { type: 'end', revision: 1 },
      ]) {
        emitChat('agent/assistant-stream', { agent: { session: { id: request.sessionId } }, frame });
      }
      const session = { header: { id: request.sessionId }, id: request.sessionId };
      emitChat('session/event', session, {
        type: 'assistant/message',
        seq: 100 + turn,
        time: Date.now(),
        data: {
          turn,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: '已经按你说的建好节点了。' }] },
        },
      });
      emitChat('session/event', session, {
        type: 'turn/end',
        seq: 200 + turn,
        time: Date.now(),
        data: { turn, reason: { kind: 'completed' } },
      });
    }, 200);
    return { accepted: true };
  },
  async cancel() {
    return { ok: true };
  },
  async modelCatalog() {
    return {
      default: { provider: 'fake-cloud', model: 'fake-chat' },
      groups: [{ id: 'fake-cloud', name: '假云端', models: [{ id: 'fake-chat', name: '假对话模型' }] }],
    };
  },
  async selectModel(request) {
    return { selected: { provider: request.provider, model: request.model } };
  },
};

hostMod.apply({
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      };
    }
    if (name === 'skills') return { list: async () => [], get: async () => null };
    if (name === 'sessionController') return chatStub;
    return undefined;
  },
  on(name, listener) {
    if (!chatListeners.has(name)) chatListeners.set(name, new Set());
    chatListeners.get(name).add(listener);
    return () => chatListeners.get(name)?.delete(listener);
  },
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: () => () => {} },
});

function pickRoute(pathname) {
  let best = null;
  for (const [prefix, route] of routes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, route };
    }
  }
  return best?.route ?? null;
}

async function dispatchApi(method, url, rawBody) {
  const route = pickRoute(url.pathname);
  if (!route) return { status: 404, body: JSON.stringify({ error: 'no route' }), type: 'application/json' };
  // agent 外部连接的长轮询在真机上挂起 20s：headless 的虚拟时间会卡在这次未决请求上，
  // 页面永远到不了 --virtual-time-budget，chrome 不退出。这里直接回空。
  if (url.pathname.endsWith('/agent/external/poll')) {
    return { status: 200, body: '[]', type: 'application/json' };
  }
  const req = Readable.from(rawBody && rawBody.length ? [rawBody] : []);
  req.method = method;
  req.url = `${url.pathname}${url.search}`;
  req.headers = { host: url.host, origin: ORIGIN, 'content-type': 'application/json' };
  const res = new FakeResponse();
  await route.handler(req, res);
  if (!res.writableFinished) await new Promise((done) => res.once('finish', done));
  return {
    status: res.statusCode,
    body: res.buffer(),
    type: res.headers['content-type'] ?? 'application/json',
  };
}

// 预置一个项目，让 dashboard 有东西可显示、也能直接 resume 进画布视图
const projectId = 'browser-proj';
{
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/workflows', ORIGIN),
    Buffer.from(
      JSON.stringify({
        id: projectId,
        revision: 0,
        title: '真浏览器验证项目',
        nodes: [
          { id: 'node-text', type: 'Text', x: 120, y: 120, title: '提示词节点', textContent: '一只猫在雨里走' },
          { id: 'node-image', type: 'Image', x: 520, y: 120 },
        ],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置项目 ${projectId} → ${saved.status}`);
}

/**
 * 提亮场景（?xglow=1）要一块**干净画布**，所以给它自己的空项目。
 *
 * 为什么不能共用 browser-proj：各场景会往同一个项目里建节点（workflow-node 的菜单建节点、
 * node-search 的两个节点、v1.25 接入口场景的「图片生成」+ 那条线），而且**画布会存盘**
 * （5s 自动保存）—— 于是「画布右中/右上那块空白对照区」随时可能被后来的场景占掉。
 * 踩过：接入口场景建出的工作流节点正好落在对照区里，提亮的像素对照直接假红
 * （far.max 242 ≈ 提亮圈的 253）。
 */
const emptyProjectId = 'browser-empty-proj';
{
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/workflows', ORIGIN),
    Buffer.from(
      JSON.stringify({
        id: emptyProjectId,
        revision: 0,
        title: '真浏览器验证项目（空画布）',
        nodes: [],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置空项目 ${emptyProjectId} → ${saved.status}`);
}

/**
 * 图片编辑场景（v1.26，?xedit=studio|annotate）的种子项目。
 *
 * 需要一个**能被浏览器真正解码**的图片节点（jsdom 那边用的 1x1 data URL 在真机上
 * 裁剪/标注会拿到 0 尺寸的画布）。所以这里用 zlib 现场编一张 320×240 的渐变 PNG，
 * 直接写进假 DSH_HOME 的素材目录 —— mediaStore.resolveFile 只按路径查文件，
 * 不需要 sidecar 也能被 `/api/aifisher/canvas/media/...` 取回。
 */
const editProjectId = 'browser-edit-proj';
const EDIT_IMAGE_URL = `/api/aifisher/canvas/media/${editProjectId}/images/edit-seed.png`;
{
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const width = 320;
  const height = 240;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const inCircle = (x - 160) ** 2 + (y - 120) ** 2 < 70 ** 2;
      raw[row + 1 + x * 3] = inCircle ? 245 : Math.round(20 + (120 * x) / (width - 1));
      raw[row + 2 + x * 3] = inCircle ? 245 : Math.round(30 + (90 * y) / (height - 1));
      raw[row + 3 + x * 3] = inCircle ? 245 : Math.round(90 + 120 * (1 - x / (width - 1)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const mediaDir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', editProjectId, 'images');
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(mediaDir, 'edit-seed.png'), png);
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/workflows', ORIGIN),
    Buffer.from(
      JSON.stringify({
        id: editProjectId,
        revision: 0,
        title: '图片编辑真机验证',
        nodes: [
          {
            id: 'node-edit-source',
            type: 'Image',
            x: 160,
            y: 120,
            title: '待编辑图片',
            prompt: '图片编辑真机验证',
            status: 'success',
            model: 'Upload',
            resultUrl: EDIT_IMAGE_URL,
            resultAspectRatio: '320/240',
            aspectRatio: '4:3',
            parentIds: [],
            projectId: editProjectId,
          },
        ],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置图片编辑项目 ${editProjectId}（${png.length}B PNG）→ ${saved.status}`);
}

/**
 * 叠图「切换」场景（v1.37，?xstack=1）的种子项目。
 *
 * 一张宿主卡 + 叠里两张（`stackItems`），三张用**颜色完全不同**的 PNG，
 * 这样切一下截图里就能直接看出「图真的换了」（靠 URL 断言只能证明 src 变了）。
 * 同时这几张必须是浏览器能真解码的图 —— 用 zlib 现场编，直接写进假 DSH_HOME 的素材目录。
 */
const stackProjectId = 'browser-stack-proj';
const STACK_COLORS = [
  { file: 'stack-a.png', rgb: [214, 40, 40] }, // 红
  { file: 'stack-b.png', rgb: [40, 160, 90] }, // 绿
  { file: 'stack-c.png', rgb: [50, 90, 220] }, // 蓝
];
const STACK_URLS = STACK_COLORS.map((item) => `/api/aifisher/canvas/media/${stackProjectId}/images/${item.file}`);
{
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const width = 320;
  const height = 240;
  const solidPng = ([red, green, blue]) => {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
      const row = y * (width * 3 + 1);
      raw[row] = 0; // filter: none
      for (let x = 0; x < width; x += 1) {
        // 中间留一条亮带：切换时更容易看出「换了一张」
        const band = x > width * 0.3 && x < width * 0.7 && y > height * 0.3 && y < height * 0.7;
        raw[row + 1 + x * 3] = band ? Math.min(255, red + 40) : red;
        raw[row + 2 + x * 3] = band ? Math.min(255, green + 40) : green;
        raw[row + 3 + x * 3] = band ? Math.min(255, blue + 40) : blue;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: truecolor
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  };
  const mediaDir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', stackProjectId, 'images');
  mkdirSync(mediaDir, { recursive: true });
  for (const item of STACK_COLORS) {
    writeFileSync(join(mediaDir, item.file), solidPng(item.rgb));
  }
  const stackNode = (id, title, url, x) => ({
    id,
    type: 'Image',
    x,
    y: 140,
    title,
    prompt: title,
    status: 'success',
    model: 'Upload',
    resultUrl: url,
    resultUrls: [url],
    resultAspectRatio: '320/240',
    aspectRatio: '4:3',
    parentIds: [],
    projectId: stackProjectId,
    width: 360,
    height: 270,
  });
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/workflows', ORIGIN),
    Buffer.from(
      JSON.stringify({
        id: stackProjectId,
        revision: 0,
        title: '叠图切换真机验证',
        nodes: [
          {
            ...stackNode('stack-host', '第一张', STACK_URLS[0], 200),
            stackItems: [
              stackNode('stack-2', '第二张', STACK_URLS[1], 700),
              stackNode('stack-3', '第三张', STACK_URLS[2], 1200),
            ],
          },
        ],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置叠图项目 ${stackProjectId}（3 张 PNG）→ ${saved.status}`);
}

/**
 * 视频生成历史场景（v1.64，?xvideo=1）的种子项目。
 *
 * 用户原话（2026-10-23）：「仿照图像生成历史记录，做视频生成历史记录功能」。
 *
 * 三条**浏览器能真解码**的小 mp4（`scripts/fixtures/video-history-*.mp4`：各 1.8KB，
 * 320×180 / 1 秒 / 纯红·纯绿·纯蓝）。用真视频而不是假 URL 有两个原因：
 *   ① 「设为主视频」换没换片，截图里一眼看得出来（颜色跟着走）；
 *   ② `videoWidth` 能读到 320 —— 顺手证明节点上的是真能播的视频，不是一张黑占位。
 */
const videoHistoryProjectId = 'browser-video-history-proj';
const VIDEO_HISTORY_FILES = ['video-history-red.mp4', 'video-history-green.mp4', 'video-history-blue.mp4'];
const VIDEO_HISTORY_URLS = VIDEO_HISTORY_FILES.map(
  (file) => `/api/aifisher/canvas/media/${videoHistoryProjectId}/videos/${file}`,
);
{
  const mediaDir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', videoHistoryProjectId, 'videos');
  mkdirSync(mediaDir, { recursive: true });
  for (const file of VIDEO_HISTORY_FILES) {
    copyFileSync(join(ROOT, 'scripts', 'fixtures', file), join(mediaDir, file));
  }
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/workflows', ORIGIN),
    Buffer.from(
      JSON.stringify({
        id: videoHistoryProjectId,
        revision: 0,
        title: '视频生成历史真机验证',
        nodes: [
          {
            id: 'video-history-host',
            type: 'Video',
            // 节点放低一点：扇形历史叠有一格是「往上摊」，贴顶时那一格会跑到视口外（量不到命中）
            x: 320,
            y: 300,
            title: '视频生成历史',
            prompt: '一条蓝色的小鱼游过珊瑚',
            status: 'success',
            model: 'Seedance 2.5 Standard · API',
            videoModel: 'Seedance 2.5 Standard · API',
            resultUrl: VIDEO_HISTORY_URLS[0],
            resultUrls: VIDEO_HISTORY_URLS,
            currentResultCount: 1,
            resultAspectRatio: '320/180',
            aspectRatio: '16:9',
            duration: 1,
            parentIds: [],
            projectId: videoHistoryProjectId,
            width: 384,
            height: 216,
          },
        ],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置视频生成历史项目 ${videoHistoryProjectId}（3 条 1.8KB mp4）→ ${saved.status}`);
}

/**
 * 扩图 / 尺寸两个场景（v1.38，?xoutpaint=1 / ?xresize=1）的种子项目。
 *
 * 都需要一张**浏览器能真解码**的图（jsdom 那边用的 1×1 data URL 在真机上量不出 320×240 /
 * 640×480）：直接复用上面图片编辑场景现场编出来的那张 320×240 PNG，复制一份进各自的素材目录。
 * 两个场景各用一个项目：它们都会往画布上加节点，共用一个项目会互相干扰（脚本里同一台 host
 * 是所有场景共享的）。
 */
const outpaintProjectId = 'browser-outpaint-proj';
const resizeProjectId = 'browser-resize-proj';
const outpaintImageUrl = `/api/aifisher/canvas/media/${outpaintProjectId}/images/outpaint-seed.png`;
const resizeImageUrl = `/api/aifisher/canvas/media/${resizeProjectId}/images/resize-seed.png`;
{
  const sourcePng = join(
    fakeHome,
    'storages',
    'dsh-aifisher-canvas',
    'media',
    editProjectId,
    'images',
    'edit-seed.png',
  );
  const seeds = [
    {
      projectId: outpaintProjectId,
      file: 'outpaint-seed.png',
      url: outpaintImageUrl,
      title: '扩图真机验证',
      nodeId: 'node-outpaint-source',
      nodeTitle: '待扩图的图',
      // 扩图会在源图右侧再落两张节点（源图 +400、+840），所以种子放得靠左一点；
      // 截图前场景里会滚轮缩小三档（≈61%）再往左平移一点，让「原图 → 扩图画面 →
      // 扩图 · 16:9」整条链连同生成节点下面那条 680px 的 composer 都进画面（交付图取证）。
      x: 140,
    },
    {
      projectId: resizeProjectId,
      file: 'resize-seed.png',
      url: resizeImageUrl,
      title: '尺寸真机验证',
      nodeId: 'node-resize-source',
      nodeTitle: '待改尺寸的图',
      x: 200,
    },
  ];
  for (const seed of seeds) {
    const mediaDir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', seed.projectId, 'images');
    mkdirSync(mediaDir, { recursive: true });
    copyFileSync(sourcePng, join(mediaDir, seed.file));
    const saved = await dispatchApi(
      'POST',
      new URL('/api/aifisher/canvas/workflows', ORIGIN),
      Buffer.from(
        JSON.stringify({
          id: seed.projectId,
          revision: 0,
          title: seed.title,
          nodes: [
            {
              id: seed.nodeId,
              type: 'Image',
              x: seed.x,
              y: 160,
              title: seed.nodeTitle,
              prompt: seed.title,
              status: 'success',
              model: 'Upload',
              resultUrl: seed.url,
              resultUrls: [seed.url],
              resultAspectRatio: '320/240',
              aspectRatio: '4:3',
              parentIds: [],
              projectId: seed.projectId,
              width: 320,
              height: 240,
            },
          ],
          groups: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
        'utf8',
      ),
    );
    console.log(`[browser] 预置 ${seed.title} 项目 ${seed.projectId} → ${saved.status}`);
  }
}

/**
 * 「新节点默认用上一次的模型」场景（v1.40，?xlastmodel=1）的种子项目。
 *
 * 用一个**空项目**：这一场要连建三个图片节点，共用一个有人用的项目会把别的场景的
 * 断言搅乱（同一台 host 是所有场景共享的）。
 */
const lastModelProjectId = 'browser-last-model-proj';
{
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/workflows', ORIGIN),
    Buffer.from(
      JSON.stringify({
        id: lastModelProjectId,
        revision: 0,
        title: '上次模型真机验证',
        nodes: [],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置「上次模型」空项目 ${lastModelProjectId} → ${saved.status}`);
}

/**
 * 切刀场景（v1.49，?xknife=1）的种子项目。
 *
 * 用户原话（2026-10-19）：
 *   「现在做一个新功能，像blender一样按住ctrl加鼠标右键切换到切刀工具，划过的线会断开连接」。
 *
 * C 同时接 A、B（`parentIds: [A, B]`）：切刀只能断开**被划过**的那条，
 * 另一条必须原样在 —— 身份读错（去拆 `data-edge-key` 之类）时这一场立刻红。
 * 三张图直接复用叠图场景现场编出来的 PNG（真浏览器能解码，截图里不是破图）。
 */
const knifeProjectId = 'browser-knife-proj';
const KNIFE_FILES = ['knife-a.png', 'knife-b.png', 'knife-c.png'];
const knifeUrl = (file) => `/api/aifisher/canvas/media/${knifeProjectId}/images/${file}`;
{
  const source = join(
    fakeHome,
    'storages',
    'dsh-aifisher-canvas',
    'media',
    stackProjectId,
    'images',
    'stack-a.png',
  );
  const dir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', knifeProjectId, 'images');
  mkdirSync(dir, { recursive: true });
  for (const file of KNIFE_FILES) copyFileSync(source, join(dir, file));
  const knifeNode = (id, title, x, y, extra = {}) => ({
    id,
    type: 'Image',
    x,
    y,
    title,
    prompt: title,
    status: 'success',
    model: 'Upload',
    resultUrl: knifeUrl(`${id}.png`),
    resultUrls: [knifeUrl(`${id}.png`)],
    resultAspectRatio: '320/240',
    aspectRatio: '4:3',
    parentIds: [],
    projectId: knifeProjectId,
    width: 320,
    height: 240,
    ...extra,
  });
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/workflows', ORIGIN),
    Buffer.from(
      JSON.stringify({
        id: knifeProjectId,
        revision: 0,
        title: '切刀真机验证',
        nodes: [
          knifeNode('knife-a', '上游 A', 120, 120),
          knifeNode('knife-b', '上游 B', 120, 520),
          knifeNode('knife-c', '下游 C', 760, 320, { parentIds: ['knife-a', 'knife-b'] }),
        ],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置切刀项目 ${knifeProjectId}（C 同时接 A、B）→ ${saved.status}`);
}

/**
 * 「项目归档」场景（v1.42，?xarchive=1）的种子项目。
 *
 * 带两个节点 + 两张素材：面板上「2 个节点 · 素材 2 个（x KB）」才有真数字可对，
 * 导出落盘后 node 侧也能去 `downloads/` 里数文件、核对归档里素材真的随行
 * （这两件事页面里验不了 —— 页面拿不到文件系统）。
 */
const archiveProjectId = 'browser-archive-proj';
const ARCHIVE_PROJECT_TITLE = '项目归档真机验证';
const ARCHIVE_MEDIA_FILES = ['archive-a.png', 'archive-b.png'];
{
  const dir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', archiveProjectId, 'images');
  mkdirSync(dir, { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  for (const file of ARCHIVE_MEDIA_FILES) writeFileSync(join(dir, file), png);
  const nodes = ARCHIVE_MEDIA_FILES.map((file, index) => ({
    id: `node-archive-${index + 1}`,
    type: 'Image',
    x: 160 + index * 340,
    y: 160,
    title: `归档素材 ${index + 1}`,
    prompt: `归档素材 ${index + 1}`,
    status: 'success',
    model: 'Upload',
    resultUrl: `/api/aifisher/canvas/media/${archiveProjectId}/images/${file}`,
    resultAspectRatio: '1/1',
    aspectRatio: '1:1',
    parentIds: [],
    projectId: archiveProjectId,
    width: 320,
    height: 320,
  }));
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/workflows', ORIGIN),
    Buffer.from(
      JSON.stringify({
        id: archiveProjectId,
        revision: 0,
        title: ARCHIVE_PROJECT_TITLE,
        nodes,
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置项目归档项目 ${archiveProjectId}（2 张素材）→ ${saved.status}`);
}

// 预置一份自定义工作流：第三个场景要真的建出「本地工作流节点」并量它的布局
{
  const workflowsDir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(
    join(workflowsDir, 'browser-t2i.json'),
    JSON.stringify({
      '4': { inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' }, class_type: 'CheckpointLoaderSimple' },
      '10': { inputs: { image: 'example.png', upload: 'image' }, class_type: 'LoadImage' },
      '5': { inputs: { width: 1024, height: 1024 }, class_type: 'EmptyLatentImage' },
      '6': { inputs: { text: '占位', clip: ['4', 1] }, class_type: 'CLIPTextEncode' },
      // v1.21：负向提示词节点（标题带 Negative → 变成节点上的负向文本槽 + 负向输入框）
      '7': {
        inputs: { text: '负向占位', clip: ['4', 1] },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'Negative' },
      },
      '3': { inputs: { seed: 1, steps: 20, cfg: 7.5, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }, class_type: 'KSampler' },
      '9': { inputs: { samples: ['3', 0], vae: ['4', 2] }, class_type: 'SaveImage' },
    }),
    'utf8',
  );
  writeFileSync(
    join(workflowsDir, 'browser-t2i.meta.json'),
    JSON.stringify({ title: '浏览器检查用文生图', parameters: { steps: { label: '迭代步数', type: 'number', min: 1, max: 60 } } }),
    'utf8',
  );
  console.log('[browser] 预置自定义工作流 browser-t2i（画布节点场景用）');
}

/**
 * 设置页那一场要用的一条真通道（走真插件的 /cloud-channels 路由写进假 DSH_HOME）。
 *
 * 为什么预置：2026-10-16 用户报「看不到模型名称」——根因是模型行里的类型下拉带着
 * `w-full`（Tailwind 产物里 `.w-full` 排在 `.w-28` 之后），把模型名那个 `flex-1`
 * 的 span 挤成 0 宽。光靠 jsdom 验不出来（没有布局引擎），所以在这一场里**量真宽度**：
 * 名字宽度必须 > 60px，类型下拉必须窄（一旦谁又给行内控件加回 w-full，这两条立刻红）。
 */
const CHANNEL_FIXTURE = {
  label: '浏览器检查通道',
  /**
   * 用魔搭的真实域名：设置页那一场会读「请求方言 = 自动」旁边那行小字，
   * 断言它按地址判成了「魔搭 ModelScope」（这条规则错了，图生图会**静默**退化成文生图）。
   * 这一场只渲染面板、不点「读取模型列表」，所以不会真的打网络。
   */
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  /** 带别名的模型：画布上显示「魔搭出图」，发给端点的仍是这个 ID。 */
  aliasModelId: 'Qwen/Qwen-Image-Edit',
  alias: '魔搭出图',
  /** 没别名的模型：列表里也必须看得见它的 ID。 */
  plainModelId: 'Wan2.2-T2V-A14B',
};
{
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/cloud-channels', ORIGIN),
    Buffer.from(
      JSON.stringify({
        action: 'save',
        channel: {
          label: CHANNEL_FIXTURE.label,
          baseUrl: CHANNEL_FIXTURE.baseUrl,
          apiKey: 'sk-browser-check',
          models: [
            { id: CHANNEL_FIXTURE.aliasModelId, kind: 'image', label: CHANNEL_FIXTURE.alias },
            { id: CHANNEL_FIXTURE.plainModelId, kind: 'video' },
          ],
        },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置 OpenAI 通道「${CHANNEL_FIXTURE.label}」→ ${saved.status}`);
}

/**
 * 视频节点「能接几张参考图」场景（v1.65，?xvideorefs=1）的种子项目。
 *
 * 用户原话（2026-10-23）：「视频生成图像参考只能拖入三张，修复一下，按 minimaxh3 的标准来」。
 *
 * 一个视频节点（模型 = 上面那条通道的视频模型，模式 = 多图参考）+ 10 张图排成 4 列 3 行。
 * 这一场在真浏览器里从头拖 10 次线：jsdom 那边已经验过数据链路，这里补的是**真布局**下
 * 「连接点真的点得到、拖到节点身上真的接上」——以及修复后的上限确实是 9（不是 3，也不是无限）。
 */
const videoRefsProjectId = 'browser-video-refs-proj';
/** 视频节点在画布上的位置（放右边，别和参考图重叠）。 */
const VIDEO_REFS_FRAME = { x: 1320, y: 60, width: 560, height: 420 };
const videoRefsImageIds = Array.from({ length: 10 }, (_, index) => `video-ref-image-${index + 1}`);
const VIDEO_REFS_IMAGE_URL = (index) =>
  `/api/aifisher/canvas/media/${videoRefsProjectId}/images/ref-${index + 1}.png`;
const VIDEO_REFS_MODEL_NAME = `${CHANNEL_FIXTURE.label} · ${CHANNEL_FIXTURE.plainModelId}`;
{
  const sourcePng = join(
    fakeHome,
    'storages',
    'dsh-aifisher-canvas',
    'media',
    editProjectId,
    'images',
    'edit-seed.png',
  );
  const mediaDir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', videoRefsProjectId, 'images');
  mkdirSync(mediaDir, { recursive: true });
  for (let index = 0; index < videoRefsImageIds.length; index += 1) {
    copyFileSync(sourcePng, join(mediaDir, `ref-${index + 1}.png`));
  }
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/workflows', ORIGIN),
    Buffer.from(
      JSON.stringify({
        id: videoRefsProjectId,
        revision: 0,
        title: '视频参考图数量真机验证',
        nodes: [
          ...videoRefsImageIds.map((id, index) => ({
            id,
            type: 'Image',
            x: 20 + (index % 4) * 300,
            y: 20 + Math.floor(index / 4) * 280,
            width: 280,
            height: 240,
            title: `参考图 ${index + 1}`,
            prompt: `参考图 ${index + 1}`,
            status: 'success',
            model: 'Upload',
            resultUrl: VIDEO_REFS_IMAGE_URL(index),
            resultUrls: [VIDEO_REFS_IMAGE_URL(index)],
            resultAspectRatio: '320/240',
            aspectRatio: '4:3',
            parentIds: [],
            projectId: videoRefsProjectId,
          })),
          {
            id: 'video-refs-host',
            type: 'Video',
            ...VIDEO_REFS_FRAME,
            title: '参考图数量验证',
            prompt: '雨滴打在窗上，镜头缓缓推近',
            status: 'idle',
            model: VIDEO_REFS_MODEL_NAME,
            videoModel: VIDEO_REFS_MODEL_NAME,
            videoMode: 'reference-video',
            resolution: '480p',
            aspectRatio: '16:9',
            duration: 5,
            parentIds: [],
            projectId: videoRefsProjectId,
          },
        ],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置视频参考图项目 ${videoRefsProjectId}（1 视频 + 10 张图）→ ${saved.status}`);
}


/**
 * 任务队列场景（?tasks=1）用的一条真通道：baseUrl 指向**本脚本自己**的 /tq-channel，
 * 于是「生成」是真的从插件 host 走出一条 HTTP 请求，我们能控制它多快回来：
 *   - Fast 模型立刻回一张图 → 面板上出现一行「完成 · 1 个结果」；
 *   - Slow 模型一直不回来 → 面板上留一行「运行中」，循环发光边框才有东西可量、可截。
 */
const TASK_QUEUE_CHANNEL = {
  label: '任务队列检查通道',
  slowModelId: 'TQ/Slow-Image',
  fastModelId: 'TQ/Fast-Image',
  baseUrl: `${ORIGIN}/tq-channel/v1`,
};
/**
 * v1.40「新节点默认用上一次的模型」场景里的**第二款图片模型**（画布上的显示名）。
 *
 * 直接借任务队列那条通道的图片模型：它本来就是画布目录里的一款真模型，
 * 往共享的 CHANNEL_FIXTURE 里再塞一个会改掉设置页「2 条模型」那条断言。
 * Node 侧（断言）与页面侧（探针）用同一个字符串。
 */
const LAST_MODEL_SECOND_TEXT = `${TASK_QUEUE_CHANNEL.label} · ${TASK_QUEUE_CHANNEL.fastModelId}`;

/** 假端点回的 1×1 PNG（面板只要「有结果」这个事实，图长什么样不重要）。 */
const TQ_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
{
  const saved = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/cloud-channels', ORIGIN),
    Buffer.from(
      JSON.stringify({
        action: 'save',
        channel: {
          label: TASK_QUEUE_CHANNEL.label,
          baseUrl: TASK_QUEUE_CHANNEL.baseUrl,
          apiKey: 'sk-task-queue-check',
          models: [
            { id: TASK_QUEUE_CHANNEL.fastModelId, kind: 'image' },
            { id: TASK_QUEUE_CHANNEL.slowModelId, kind: 'image' },
          ],
        },
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 预置任务队列通道「${TASK_QUEUE_CHANNEL.label}」→ ${saved.status}`);
}

// ---------------------------------------------------------------- 宿主页 + 静态资源 + API 代理

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const HOST_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>画布真浏览器检查</title>
<style>
  /* 复刻 DSH 的 AppFrame：position:relative 的网格框架 + 无 position 的中心列 */
  html, body { margin: 0; height: 100%; background: #1b1b1f; }
  #frame { position: relative; height: 100vh; display: grid; grid-template-columns: 240px minmax(0, 1fr); grid-template-rows: 100%; overflow: hidden; }
  #sidebar { background: #202024; color: #ddd; font: 13px/1.6 system-ui, sans-serif; padding: 12px; }
  #center { background: #0e0f13; min-width: 0; }
  #mount { position: absolute; inset: 0; }
  #probe { position: fixed; right: 8px; bottom: 8px; z-index: 9999; color: #9fe870; font: 11px/1.5 monospace; background: #000a; padding: 4px 6px; white-space: pre; }
</style>
</head>
<body>
  <div id="frame">
    <div id="sidebar">DSH 侧边栏（占位）</div>
    <div id="center"><div id="mount" class="af-canvas-mount"></div></div>
  </div>
  <div id="probe" style="position:fixed;right:6px;bottom:6px;z-index:99999;background:#000c;color:#9f9;font:10px/1.4 monospace;padding:6px;border-radius:4px;max-width:340px;white-space:pre-wrap;pointer-events:none">probing…</div>
  <script type="module">
    const params = new URLSearchParams(location.search);
    const resume = params.get('resume');
    if (resume) {
      // 与画布的「刷新恢复」同一条路径：预置 sessionStorage 后启动，画布会直接进画布视图
      sessionStorage.setItem('fisherai.canvas.resume.v1', JSON.stringify({
        version: 1, workflowId: resume, folderId: null, viewport: { x: 0, y: 0, zoom: 1 },
      }));
    }
    // 复刻 CanvasPanel：外层 relative 撑满，内层 absolute inset:0 作为画布容器
    const panel = document.createElement('div');
    panel.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:#0e0f13';
    const mount = document.getElementById('mount');
    mount.replaceWith(panel);
    panel.appendChild(mount);
    mount.style.cssText = 'position:absolute;inset:0';

    const errors = [];
    window.addEventListener('error', (event) => {
      const where = event.filename ? ' @' + String(event.filename).split('/').pop() + ':' + event.lineno : '';
      // v1.26：只有 message 时常看不出是谁抛的（「Uncaught  @canvas-app.js:3892」这种空消息），
      // 顺手带上前两行堆栈 + error.name，排查时不用再改脚本。
      const caught = event.error;
      const detail = caught && caught.stack
        ? ' | ' + String(caught.stack).split('\\n').slice(0, 3).join(' <- ')
        : caught && caught.name
          ? ' | ' + String(caught.name)
          : '';
      errors.push(String(event.message || '') + where + detail);
    });
    window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

    /**
     * 合成 PointerEvent 没有真实指针：vendor 的 handleNodePointerDown 一进来就
     * 'setPointerCapture(event.pointerId)'，浏览器对「不存在的指针 id」直接抛
     * NotFoundError（真实鼠标不会）。探针里点节点是为了「选中」，不需要真的按住拖动，
     * 所以在本宿主页把捕获相关三个方法做成 no-op —— 否则每次合成点击都会往 errors
     * 里塞一条假错误，把「画布运行时错误」那条检查弄红。
     * （只影响这个假宿主页；真机 DSH 页面不经过这里。）
     */
    if (window.Element) {
      window.Element.prototype.setPointerCapture = function () {};
      window.Element.prototype.releasePointerCapture = function () {};
      window.Element.prototype.hasPointerCapture = function () {
        return false;
      };
    }

    /**
     * 画布产物加载失败时**必须留下证据**：以前这里 import 抛错 → 整个模块结束 →
     * 探针一次都没 POST → 外面只看到「没收到页面探针」，只能靠猜。
     * 现在把失败原因（堆栈 + 资源加载错误）单独 POST 回去。
     */
    const reportBootError = (error) => {
      void fetch('/__probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: location.search || 'default',
          bootError: String((error && (error.stack || error.message)) || error),
          bootErrors: errors.slice(),
        }),
      }).catch(() => {});
    };

    let mod;
    try {
      mod = await import('/canvas-app/canvas-app.js');
    } catch (error) {
      reportBootError(error);
      throw error;
    }
    try {
      mod.mountCanvas(mount);
    } catch (error) {
      reportBootError(error);
      throw error;
    }
    window.__canvasHandle = mod;

    // 探针：把关键几何写进页面，截图里能直接看到数字
    const report = () => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
      const root = mount.firstElementChild;
      const probe = document.getElementById('probe');
      probe.textContent =
        'center=' + JSON.stringify(rect(document.getElementById('center'))) +
        '\\nmount=' + JSON.stringify(rect(mount)) +
        '\\ncanvasRoot=' + JSON.stringify(root ? rect(root) : [0, 0]) +
        '\\nsidebar=' + JSON.stringify(rect(document.getElementById('sidebar'))) +
        '\\nerrors=' + JSON.stringify(errors);
    };
    setInterval(report, 250);
    report();

    /**
     * 越界探针：画布里所有「定位过的盒」都不许越过侧边栏右缘。
     *
     * 上游是独占窗口的应用，外壳贴边元素原本是 position:fixed（相对窗口定位），
     * 嵌进 DSH 后会盖到左侧边栏上——那条侧边栏是面板唯一的出路。
     * 越界元素连同 class 名 POST 回本地服务，由脚本断言（断言不能靠看图）。
     */
    /**
     * ComfyUI 状态胶囊（v1.2）：画布头部那一枚「ComfyUI 待启动 / 运行中」指示灯。
     * host 的 /local-runtime/comfyui 报 idle/external，vendor 侧靠 3.8c 三行补丁才肯挂载，
     * 所以这里必须真在页面上看到它、并确认它被停靠进头部工具条（而不是浮在画布左下角）。
     */
    const comfyChip = () => {
      const chip = document.querySelector('[data-fisherai-comfyui-log-toggle]');
      if (!chip) return null;
      const host = chip.closest('[data-fisherai-comfyui-log-host]');
      const header = document.querySelector('.af-canvas-header');
      const r = chip.getBoundingClientRect();
      return {
        text: String(chip.textContent || '').trim(),
        docked: host?.dataset.dock ?? null,
        inHeader: !!header && header.contains(chip),
        rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      };
    };

    /**
     * 画布头部的账号插槽（v1.3 曾往里挂「未登录」登录入口，2026-10-16 已整体移除）。
     *
     * 这里只确认插槽本身还在（ComfyUI 状态胶囊靠它定位在头部），并且**没有**再冒出
     * 我们自己的登录入口（防止移除不干净）。
     */
    const accountSlot = () => ({
      slotPresent: !!document.querySelector('[data-fisherai-account-center-slot="true"]'),
      ourEntryPresent: !!document.querySelector('[data-fisherai-account-entry="true"]'),
    });

    /**
     * 画布头部的内容（shadcn 重设计后新增的断言）。
     *
     * 头部的三个可见件必须真在页面上、且宽度正常：
     *   - 项目菜单按钮（品牌图，点开是保存/导入/退出）
     *   - 项目标题按钮（点击可重命名）
     *   - 保存状态徽标（尚未保存 / 未保存 / 保存中 / 已保存）
     * jsdom 里能验 DOM，但「有没有被压成 0 宽 / 被别的层盖住」只有真机能量。
     */
    const headerProbe = () => {
      const header = document.querySelector('.af-canvas-header');
      if (!header) return { present: false };
      const rect = header.getBoundingClientRect();
      const menu = header.querySelector('[aria-label="项目菜单"]');
      const title = header.querySelector('button[title="点击重命名"]');
      const badge = header.querySelector('[data-slot="badge"]');
      const back = header.querySelector('[data-fisherai-back-to-library]');
      const comfySlot = header.querySelector('[data-fisherai-comfyui-slot="true"]');
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top) };
      };
      /**
       * v1.36：头部以前没有 z-index、底色类名（bg-surface）在主题里也不存在，
       * 于是被 vendor 的 #canvas-background（不透明底、DOM 顺序在后）整块盖住 ——
       * 真机上只有自带 z-index 的 ComfyUI 胶囊浮着，logo/项目名/保存状态全看不见也点不到。
       * 这几条用例都只量「盒子在不在」，量不出「被谁盖住」，所以这里补一个**命中测试**：
       * 头部左端那个点必须命中头部里的元素。量不到 rect（jsdom/headless 早期帧）就跳过。
       */
      const hit = (() => {
        if (rect.width < 10 || rect.height < 10) return null;
        const point = document.elementFromPoint(Math.round(rect.left + 16), Math.round(rect.top + rect.height / 2));
        return point ? { inside: header.contains(point), tag: point.tagName.toLowerCase() } : null;
      })();
      return {
        present: true,
        rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        menu: box(menu),
        title: box(title),
        titleText: String(title?.textContent ?? '').trim(),
        badgeText: String(badge?.textContent ?? '').trim(),
        badge: box(badge),
        back: box(back),
        backLabel: back ? back.getAttribute('aria-label') : null,
        comfySlot: box(comfySlot),
        onTop: hit,
        zIndex: getComputedStyle(header).zIndex,
        background: getComputedStyle(header).backgroundColor,
      };
    };

    /**
     * 画布点阵底纹（十字网格 + 鼠标圆形提亮）。
     *
     * 三件事只有真机能验：
     *   ① 十字真被浏览器算出了背景图（data URL svg）与随缩放变化的 background-size；
     *   ② 判题用的 CSS 变量真的跟着画布 transform 走（平移/缩放后 background-position 变）；
     *   ③ 鼠标移上去时遮罩圆心 = 指针局部坐标（offsetX/offsetY 在真浏览器里的语义）。
     * jsdom 没有布局与 CSS 计算，这三条在那边只能验「DOM 在不在」。
     */
    const gridProbe = () => {
      // v1.45：节点搜索场景要量「新建并移动」的屏幕位移 —— 这个探针每 250ms 会派发一次
      // pointermove(200,150)，还会临时改 #canvas-viewport-content 的 transform，会把跟随测出来
      // 的位移冲成 0。那一场在测量期间自己把开关打开，其它场景不受影响。
      if (window.__DSH_SKIP_GRID_PROBE__ === true) return { present: false, skipped: 'node-placement' };
      const canvas = document.getElementById('canvas-background');
      const layer = canvas?.querySelector('[data-canvas-grid="true"]');
      if (!canvas || !layer) return { present: false };
      const cross = layer.querySelector('.canvas-grid-cross.is-base');
      const highlight = layer.querySelector('.canvas-grid-cross.is-highlight');
      const crossStyle = cross ? getComputedStyle(cross) : null;
      const read = () => {
        const s = getComputedStyle(cross ?? layer);
        return {
          size: s.backgroundSize,
          position: s.backgroundPosition,
          zoom: layer.style.getPropertyValue('--canvas-grid-zoom'),
          dpr: layer.style.getPropertyValue('--canvas-grid-dpr'),
          panX: layer.style.getPropertyValue('--canvas-grid-pan-x'),
        };
      };
      /**
       * ⚠️ 这个探针必须**全程同步**。
       *
       * 页面只来得及 POST 一份探针：headless 带 --virtual-time-budget，虚拟时间走完
       * 浏览器就退出，任何 await（哪怕 setTimeout(0)）都可能让这份探针发不出去
       * ——表现成「服务端只收到页面刚加载时的空壳探针」，断言全假红。
       * （rAF 更不能用：虚拟时间下它可能根本不派发。）
       *
       * 所以这里用「先改 #canvas-viewport-content 的 inline transform，再同步读
       * computedStyle」逼一次样式重算：内联改动一定生效，而 getComputedStyle 会
       * 强制 flush pending style，读到的就是改动之后的值。网格层的 CSS 变量是在
       * MutationObserver 回调里写的，这里不等它 —— 直接验**样式规则本身**
       * 有没有跟着 transform 走（background-size/position 都是 calc(var(--…))）。
       */
      const viewport = document.getElementById('canvas-viewport-content');
      const original = viewport?.style.transform ?? null;
      if (viewport) viewport.style.transform = 'translate3d(-140px, 90px, 0) scale(1.25)';
      const after = read();
      const panFromTransform = Number.parseFloat(
        String(layer.style.getPropertyValue('--canvas-grid-pan-x') || '0'),
      );
      if (viewport && original !== null) viewport.style.transform = original;
      const before = read();

      /**
       * 网格层是靠 MutationObserver 把画布 transform 读成 CSS 变量的，而这份探针必须
       * 全程同步（见上）—— 等不到回调。所以这里换个更硬的验法：**把变量直接改掉**，
       * 再同步读 computedStyle。若渲染真的绑在变量上，格子尺寸/定位必须跟着变。
       * （Chrome 会把 calc() 算成像素值，所以只能这样验，不能只看原始表达式。）
       */
      const originalZoomVar = layer.style.getPropertyValue('--canvas-grid-zoom');
      const originalPanVar = layer.style.getPropertyValue('--canvas-grid-pan-x');
      layer.style.setProperty('--canvas-grid-zoom', '2');
      layer.style.setProperty('--canvas-grid-pan-x', '33');
      const bound = read();
      const restore = (name, value) => {
        if (value) layer.style.setProperty(name, value);
        else layer.style.removeProperty(name);
      };
      restore('--canvas-grid-zoom', originalZoomVar);
      restore('--canvas-grid-pan-x', originalPanVar);
      const restored = read();

      /**
       * 鼠标交互（v1.27：必须走**真实命中路径**）。
       *
       * 网格层 pointer-events:none（铺满画布、不能抢画布指针事件）→ 它**永远不是命中目标**，
       * 真实鼠标的 pointermove 落在「#canvas-background」（或节点）上，一格都到不了网格层。
       * v1.8～v1.26 把监听挂在网格层上、探针也 dispatchEvent 给网格层派发（合成事件绕过命中
       * 测试）→ 真机上一动不动却全绿。所以这里派发在**底盘**上、**不冒泡**：只有 window
       * 捕获阶段的监听收得到，谁把监听挂回网格层这几条立刻红。
       *
       * 把底盘临时钉到视口左上角，让 clientX/clientY 可以直接换算成本地坐标。
       */
      const originalPosition = canvas.style.position;
      const originalRect = canvas.getBoundingClientRect();
      canvas.style.position = 'fixed';
      canvas.style.left = '0px';
      canvas.style.top = '0px';
      const pinned = canvas.getBoundingClientRect();
      const readPointer = () => ({
        interactive: layer.getAttribute('data-canvas-grid-interactive'),
        maskX: layer.style.getPropertyValue('--canvas-grid-mx'),
        maskY: layer.style.getPropertyValue('--canvas-grid-my'),
        maskRadius: layer.style.getPropertyValue('--canvas-grid-mr'),
        highlightOpacity: highlight ? highlight.style.opacity : null,
      });
      const localX = Math.round(200 - pinned.left);
      const localY = Math.round(150 - pinned.top);

      // ① 旧路径（派发给网格层）：只留一条几何契约（遮罩圆心 = 局部坐标）。
      layer.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 200, clientY: 150 }),
      );
      const hover = {
        ...readPointer(),
        expectedX: Math.round(localX) + 'px',
        expectedY: Math.round(localY) + 'px',
      };

      // ② 真实命中路径：派发在底盘上、不冒泡。
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: false, clientX: 200, clientY: 150 }),
      );
      const realHover = {
        ...readPointer(),
        expectedX: Math.round(localX) + 'px',
        expectedY: Math.round(localY) + 'px',
      };

      // ③ 设置里的开关：关掉 → 网格层 off + 提亮层复位 + 再派指针也不亮（监听摘掉了）；
      //    打开 → 立刻恢复。
      const effects = window.__FISHERAI_CANVAS_EFFECTS__;
      const effectsProbe = {
        available: !!effects,
        off: null,
        afterOffMove: null,
        on: null,
        afterOnMove: null,
        stored: null,
      };
      if (effects) {
        effects.set('pointerGlow', false);
        effectsProbe.off = readPointer();
        canvas.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: false,
            clientX: Math.round(pinned.left) + 60,
            clientY: Math.round(pinned.top) + 80,
          }),
        );
        effectsProbe.afterOffMove = readPointer();
        effects.set('pointerGlow', true);
        effectsProbe.on = readPointer();
        canvas.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: false,
            clientX: Math.round(pinned.left) + 90,
            clientY: Math.round(pinned.top) + 110,
          }),
        );
        effectsProbe.afterOnMove = {
          ...readPointer(),
          expectedX: '90px',
          expectedY: '110px',
        };
        try {
          effectsProbe.stored = window.localStorage.getItem('dsh-aifisher-canvas.canvas-effects');
        } catch (error) {
          effectsProbe.stored = String(error);
        }
      }

      // 收尾：指针离开窗口 → 提亮层复位（后面的截图像素检查要的是没有光斑的画面）。
      canvas.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: false, relatedTarget: null }),
      );
      const cleared = readPointer();
      canvas.style.position = originalPosition;

      return {
        present: true,
        inBackground: layer.parentElement === canvas,
        isFirstChild: canvas.firstElementChild === layer,
        rect: {
          left: Math.round(originalRect.left),
          top: Math.round(originalRect.top),
          w: Math.round(originalRect.width),
          h: Math.round(originalRect.height),
        },
        backgroundImage: crossStyle?.backgroundImage ?? '',
        backgroundAttachment: crossStyle?.backgroundAttachment ?? '',
        /** 网格层自报的规格（数据属性，来自 canvasGrid.ts 的常量）。 */
        star: {
          spacing: layer.getAttribute('data-canvas-grid-spacing'),
          size: layer.getAttribute('data-canvas-grid-star'),
        },
        /**
         * 从真机算出来的 data URL 里把平铺块的几何扒出来 —— 验「1:1 绘制、星号不被拉伸」：
         * viewBox 必须等于间距、路径必须是「一横一竖」（H/V）而不是一个方块（点）。
         *
         * ⚠️ 这段跑在宿主页的模板字面量里（HOST_PAGE 本身是模板字符串），所以
         * **既不能出现反引号，也不能用带反斜杠的正则字面量**：模板会先把「反斜杠加 /」
         * 煮成「/」、把「反斜杠加 d」煮成「d」，于是 svg 后面那个 +xml 里的斜杠会把
         * 正则提前截断 → 整个页面脚本 SyntaxError，探针一次都发不出来（表现成
         * 「没收到页面探针」）。这里一律用字符串查找/切片，不写正则。
         */
        tile: (() => {
          const image = String(crossStyle?.backgroundImage ?? '');
          const marker = 'data:image/svg+xml,';
          const at = image.indexOf(marker);
          if (at < 0) return null;
          // Chrome 给的是 url("data:…")：尾巴上可能带引号与右括号，一层层削掉。
          let tail = image.slice(at + marker.length);
          for (const suffix of ['")', '"', ')']) {
            if (tail.endsWith(suffix)) {
              tail = tail.slice(0, -suffix.length);
              break;
            }
          }
          const svg = decodeURIComponent(tail);
          const attr = (name) => {
            const i = svg.indexOf(name + '="');
            if (i < 0) return null;
            const from = i + name.length + 2;
            const to = svg.indexOf('"', from);
            return to < 0 ? null : svg.slice(from, to);
          };
          const box = String(attr('viewBox') ?? '').split(' ').filter(Boolean);
          return {
            width: attr('width'),
            viewBox: box.length === 4 ? box[2] + ' ' + box[3] : null,
            stroke: attr('stroke'),
            strokeOpacity: attr('stroke-opacity'),
            strokeWidth: attr('stroke-width'),
            cross: svg.indexOf('H') >= 0 && svg.indexOf('V') >= 0,
            currentColor: svg.indexOf('currentColor') >= 0,
          };
        })(),
        /** 变量桩：把 --canvas-grid-zoom/pan-x 改成 2/33 后读到的 computedStyle。 */
        bound,
        restored,
        panFromTransform,
        zIndex: getComputedStyle(layer).zIndex,
        pointerEvents: getComputedStyle(layer).pointerEvents,
        theme: layer.getAttribute('data-canvas-grid-theme'),
        before,
        after,
        hover,
        realHover,
        effectsProbe,
        cleared,
        /**
         * 画布产物自己的诊断读数（v1.27）：interactive + effects（设置落点/localStorage）
         * + pointer（enabled/listening/last/paints）。真机「开关点了没反应」时先看这几个数。
         */
        moduleReport: (() => {
          const api = window.__canvasHandle;
          return api && typeof api.canvasGridReport === 'function' ? api.canvasGridReport() : null;
        })(),
      };
    };

    /**
     * 探针：把关键几何写进页面，截图里能直接看到数字。
     * 必须**全程同步**（含下面的网格探针）：见 gridProbe 的说明 —— headless 的
     * 虚拟时间预算走完就退出，任何 await 都可能让这份唯一的探针发不出去。
     */
    const leakReport = () => {
      const sidebarRect = document.getElementById('sidebar').getBoundingClientRect();
      const leaks = [];
      for (const el of mount.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        // 全屏模态（fixed 且铺满视口）本来就该盖住整个窗口：设置对话框、媒体预览、
        // 确认框都是这一类，不算「越界压住侧边栏」。头部/工具条/小地图不是全屏，仍然照查。
        if (cs.position === 'fixed' && r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2) continue;
        // 画布挂载容器自己：DSH 布局把它撑得比画布面板宽（改之前就有的宿主层现象），
        // 它没有任何可见绘制，也不是「贴边元素」，别进越界清单（否则 node-search / chat 场景恒红）。
        if (el.classList.contains('af-canvas-mount')) continue;
        // 节点内容（节点框与它内部的一切）：世界坐标里节点本来就能被拖到任意位置，
        // 越到侧边栏上方是画布的正常表现，不是「贴边元素跑到 DSH 界面上」。
        // 这条以前不会红，是因为场景里恰好没有节点落在侧边栏那一段；node-search 场景
        // 把节点建在画布左侧（x=200 附近）才暴露出来。
        if (el.closest('[data-node-id]')) continue;
        if (r.left >= sidebarRect.right - 1) continue;
        const cls = String(el.className ?? '').slice(0, 90);
        leaks.push(cls + ' @' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      // v1.15：项目看板头部的两个**站外入口**（AIFISHER「API 与服务」/ Work-Fisher「教程与案例」）
      // 必须不在页面上，同时确认这次移除没有连坐同文件注入的「设置」按钮。
      // 用字符串 includes，不用正则 —— 这是一段写在模板字面量里的宿主页脚本，正则里的反斜杠
      // 会被外层模板串吃掉（同一个坑在别处已经踩过一次）。
      const dashboardEl = document.querySelector('[data-fisherai-project-dashboard="true"]');
      const dashboardCopy = dashboardEl ? dashboardEl.textContent || '' : '';
      const resourceEntry = {
        dashboard: dashboardEl !== null,
        navs: document.querySelectorAll('[data-fisherai-resource-links="true"]').length,
        links: document.querySelectorAll('.fisherai-resource-link').length,
        stale:
          dashboardCopy.includes('API 与服务') ||
          dashboardCopy.includes('教程与案例') ||
          dashboardCopy.includes('api.work-fisher.com') ||
          dashboardCopy.includes('space.bilibili.com'),
        settings: document.querySelectorAll('[data-fisherai-dashboard-settings="true"]').length,
        // v1.42：项目库头部的「导入项目」按钮（看板视图里没有画布面板，导入只能从这儿进）
        importButton: document.querySelectorAll('[data-fisherai-project-import="true"]').length,
      };
      const payload = {
        label: location.search || 'default',
        resourceEntry,
        sidebarRight: Math.round(sidebarRect.right),
        headerLeft: Math.round(document.querySelector('.af-canvas-header')?.getBoundingClientRect().left ?? -1),
        errors,
        leaks,
        workflowLayout: workflowLayout(),
        settings: settingsProbe,
        comfyChip: comfyChip(),
        accountSlot: accountSlot(),
        header: headerProbe(),
        chatPanel: chatPanelProbe(),
        nodeSearch: searchSteps,
        workflowConfig: wfConfigSteps,
        taskQueue: taskQueueSteps,
        imageEditor: imageEditorSteps,
        /** v1.26：「保存为新图片」之后画布上到底有几个节点、各自结果图地址（image-saved 场景用） */
        editCanvas: (() => {
          if (!editScene) return null;
          return [...document.querySelectorAll('[data-node-id]')].map((node) => ({
            id: node.getAttribute('data-node-id') || '',
            src: String(node.querySelector('img')?.getAttribute('src') || ''),
          }));
        })(),
        /**
         * 任务队列面板的盒子（v1.24）：glow 场景要挑一块「没被面板盖住」的空白当参考区，
         * 面板会把画布右上角那团像素点亮起来 —— 以前 glow 的参考区正好在那里。
         */
        taskQueuePanel: (() => {
          const element = document.querySelector('[data-fisherai-task-queue="panel"]');
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return {
            left: Math.round(box.left),
            top: Math.round(box.top),
            width: Math.round(box.width),
            height: Math.round(box.height),
          };
        })(),
        portDrag: portDragSteps,
        /** v1.33：网格跟随画布的速度（?xgridpan=1 场景，见 buildGridPanScene） */
        gridPan: gridPanSteps,
        /** v1.37：叠图「切换」按钮（?xstack=1 场景，见 buildStackScene） */
        stack: stackSteps,
        /** v1.64：视频生成历史（?xvideo=1 场景，见 buildVideoHistoryScene） */
        videoHistory: videoHistorySteps,
        /** v1.65：视频节点能接几张参考图（?xvideorefs=1 场景，见 buildVideoRefsScene） */
        videoRefs: videoRefsSteps,
        /** v1.38：扩图（?xoutpaint=1 场景，见 buildOutpaintScene） */
        outpaint: outpaintSteps,
        /** v1.38：尺寸对话框（?xresize=1 场景，见 buildResizeScene） */
        resize: resizeSteps,
        /** v1.40：新节点默认用上一次的模型（?xlastmodel=1 场景，见 buildLastModelScene） */
        lastModel: lastModelSteps,
        /** v1.41：任务队列只在画布这一层（?qlayers=1 场景，见 buildQueueLayerScene） */
        queueLayers: queueLayerSteps,
        /** v1.42：项目归档（?xarchive=1 场景，见 buildArchiveScene） */
        archive: archiveSteps,
        /** v1.49：切刀（?xknife=1 场景，见 buildKnifeScene） */
        knife: knifeSteps,
      };
      // 网格探针会临时把底盘钉到视口左上角（让 offsetX 可预测），
      // 所以必须放在 leaks 采完之后 —— 否则那次临时移动会被当成「越界压住侧边栏」。
      // 接入口场景（v1.25）在**拖线**：它每 250ms 会派发 pointermove/pointerleave 把指针挪走，
      // 会把「正在拖的那根线指到哪个槽」冲掉，所以那段时间让网格/提亮探针让路。
      const portDragBusy = portDragSteps && portDragSteps.busy === true;
      if (portDragBusy) {
        payload.grid = { present: false, skipped: 'port-drag' };
      } else {
        try {
          payload.grid = gridProbe();
        } catch (error) {
          payload.grid = { present: false, error: String(error) };
        }
        // 网格探针最后会派发 pointerleave 把提亮圆心复位，所以提亮场景要**在它之后**重钉。
        pinGlow();
      }
      void fetch('/__probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    };

    /**
     * 本地工作流节点场景（?wf=1）：
     *   ① 从工具条 ➕ →「添加节点」→「ComfyUI 工作流」真建一个节点（上游这条入口是死的）；
     *   ② 量它的布局：节点框尺寸、左侧素材槽的 + 按钮圆心是否落在节点左缘（连线端点要对齐）、
     *      生成按钮/下拉框是否都在节点框内。
     * jsdom 没有布局引擎，这三件事只能在这里量。
     */
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const clickText = (root, selector, text) => {
      const el = [...root.querySelectorAll(selector)].find((node) =>
        (node.getAttribute('aria-label') || node.textContent || '').includes(text),
      );
      if (!el) return false;
      el.click();
      return true;
    };
    let wfSteps = { add: false, submenu: false, workflow: false };
    const wfScene = new URLSearchParams(location.search).get('wf') === '1';
    const buildWorkflowNode = async () => {
      if (!wfScene) return;
      await wait(1200);
      wfSteps.add = clickText(document, 'button', '添加节点');
      await wait(400);
      wfSteps.submenu = clickText(document, '[role="menuitem"]', '添加节点');
      await wait(400);
      wfSteps.workflow = clickText(document, '[role="menuitem"]', 'ComfyUI 工作流');
      await wait(1500);
    };
    const workflowLayout = () => {
      if (!wfScene) return null;
      const surface = mount.querySelector('[data-fisherai-local-workflow-node]');
      const frame = surface?.closest('[data-node-id]');
      if (!surface || !frame) return { ...wfSteps, rendered: false };
      const frameRect = frame.getBoundingClientRect();
      const slots = [...surface.querySelectorAll('[data-fisherai-connector-side="left"]')].map((button) => {
        const r = button.getBoundingClientRect();
        return { centerX: Math.round(r.left + r.width / 2), centerY: Math.round(r.top + r.height / 2) };
      });
      const inside = (r) =>
        !!r && r.left >= frameRect.left - 1 && r.right <= frameRect.right + 1 &&
        r.top >= frameRect.top - 1 && r.bottom <= frameRect.bottom + 1;
      const grid = surface.querySelector('[data-fisherai-local-workflow-parameters]');
      const prompt = surface.querySelector('[data-fisherai-local-workflow-prompt]');
      const negative = surface.querySelector('[data-fisherai-local-workflow-negative-prompt]');
      return {
        ...wfSteps,
        rendered: true,
        frame: {
          left: Math.round(frameRect.left),
          top: Math.round(frameRect.top),
          width: Math.round(frameRect.width),
          height: Math.round(frameRect.height),
        },
        slots,
        slotPitch: slots.length > 1 ? slots[1].centerY - slots[0].centerY : null,
        slotsOnLeftEdge: slots.every((slot) => Math.abs(slot.centerX - Math.round(frameRect.left)) <= 2),
        pickerInside: inside(surface.querySelector('[data-fisherai-local-workflow-picker]')?.getBoundingClientRect()),
        generateInside: inside(surface.querySelector('[data-fisherai-local-workflow-generate]')?.getBoundingClientRect()),
        promptInside: inside(surface.querySelector('[data-fisherai-local-workflow-prompt]')?.getBoundingClientRect()),
        parameterCount: surface.querySelectorAll('[data-fisherai-local-workflow-parameter]').length,
        /** v1.20 布局：参数区是横跨整宽的两列网格，提示词框在它上面 */
        parameterGrid: grid
          ? {
              columns: grid.getAttribute('data-columns'),
              width: Math.round(grid.getBoundingClientRect().width),
              box: inside(grid.getBoundingClientRect()),
            }
          : null,
        promptBox: prompt
          ? {
              width: Math.round(prompt.getBoundingClientRect().width),
              height: Math.round(prompt.getBoundingClientRect().height),
            }
          : null,
        /** v1.21：负向提示词框（在提示词框正下方、同一个右列里）与负向文本槽 */
        negativeSlot: !!surface.querySelector('[data-fisherai-local-workflow-slot="negativeText"]'),
        negativeBox: negative
          ? {
              inside: inside(negative.getBoundingClientRect()),
              width: Math.round(negative.getBoundingClientRect().width),
              height: Math.round(negative.getBoundingClientRect().height),
              gapToPrompt: prompt
                ? Math.round(negative.getBoundingClientRect().top - prompt.getBoundingClientRect().bottom)
                : null,
              sameLeft: prompt
                ? Math.abs(negative.getBoundingClientRect().left - prompt.getBoundingClientRect().left) <= 2
                : null,
            }
          : null,
        /** 第一个参数格里，标签列与控件列是不是真的左右排开（不是上下叠着） */
        firstParameterColumns: (() => {
          const cell = surface.querySelector('[data-fisherai-local-workflow-parameter]');
          if (!cell) return null;
          const label = cell.querySelector('span')?.getBoundingClientRect();
          const control = cell.querySelector('input,select')?.getBoundingClientRect();
          if (!label || !control) return null;
          return {
            labelRight: Math.round(label.right),
            controlLeft: Math.round(control.left),
            sameRow: Math.abs(label.top + label.height / 2 - (control.top + control.height / 2)) <= 3,
          };
        })(),
      };
    };

    /**
     * v1.25「接入口判定」场景（?wf=1 时一起跑，接在 workflowLayout 之后）：
     * 用户报障原话「这里接入的时候判定接入口与鼠标不准，修复一下」+
     * 「能不能做在接入的时候接入口与指针有交互效果，如放大然后发光」。
     *
     * 真机要验四件事（jsdom 一件都验不了：没有布局、没有命中测试）：
     *   ① 「+」圆的圆心压在节点左缘上 → 圆的外半边在节点框**外面**（旧实现只按节点矩形判
     *      命中的话，瞄准这半边松手就会被当成「没对上节点」）；
     *   ② 瞄准圆的外半边拖过去 → 落点必须是**那一槽**（素材槽），画布不许弹「新建节点」菜单；
     *   ③ 拖到槽旁边时那颗「+」真的放大 + 发光（读 computedStyle 的 transform/boxShadow）；
     *   ④ 瞄着**文本槽**丢一个图片节点 → 不接，也不许自动挪到别的槽上（旧实现会悄悄挪）。
     *
     * ⚠️ 这段代码在外层模板字面量里：**不许写反斜杠**（\d 会被外层吃掉变成 d），
     *    所以下面解析 transform 用 split 而不是正则。
     */
    const portDragSteps = { done: false };
    const portSleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const portUntil = async (probe, timeoutMs = 10000) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const value = probe();
        if (value) return value;
        await portSleep(120);
      }
      return null;
    };
    const portFramePoint = (el) => {
      const value = String((el && el.style && el.style.transform) || '');
      const open = value.indexOf('(');
      const close = value.indexOf(')');
      if (open < 0 || close < 0) return null;
      const parts = value.slice(open + 1, close).split(',');
      const x = parseFloat(parts[0]);
      const y = parseFloat(parts[1]);
      return Number.isFinite(x) && Number.isFinite(y) ? { x: x, y: y } : null;
    };
    const portRowText = (button) =>
      String((button && button.parentElement && button.parentElement.textContent) || '');
    const portMenuCalls = () => {
      const actions = window.__FISHERAI_CANVAS_CONTEXT_ACTIONS__;
      if (!actions || typeof actions.getDiagnostics !== 'function') return -1;
      return Number(actions.getDiagnostics().openCalls || 0);
    };
    const portPointer = (type, x, y) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      });
    const portFire = (target, type, x, y) => target.dispatchEvent(portPointer(type, x, y));
    const runPortDragScene = async () => {
      if (!wfScene) {
        portDragSteps.done = true;
        return;
      }
      try {
        const targetRoot = await portUntil(
          () => mount.querySelector('[data-fisherai-local-workflow-node]'),
          15000,
        );
        if (!targetRoot) {
          portDragSteps.error = 'no local workflow node';
          return;
        }
        const targetFrame = targetRoot.closest('[data-node-id]');
        const origin = portFramePoint(targetFrame) || { x: 0, y: 0 };
        // 等清单把槽位渲染齐（槽位来自后端能力清单，是异步到的）
        await portSleep(1200);
        const slotButtons = [...targetRoot.querySelectorAll('[data-fisherai-connector-side="left"]')];
        const slots = slotButtons.map((button, index) => {
          const rect = button.getBoundingClientRect();
          return {
            index: index,
            port: Number(button.getAttribute('data-fisherai-connector-port-index')),
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
            width: rect.width,
            row: portRowText(button),
          };
        });
        const frameRect = targetFrame.getBoundingClientRect();
        portDragSteps.target = {
          slotCount: slots.length,
          slots: slots.map((slot) => ({ port: slot.port, row: slot.row.slice(0, 16) })),
          /** 圆心压在节点左缘上（连线端点与端口对齐） */
          onEdge: slots.length > 0 && slots.every((slot) => Math.abs(slot.centerX - frameRect.left) <= 2),
          /** 圆的外半边在节点框外面：旧实现按节点矩形判命中的地方 */
          outsideHalf: slots.length > 0 && slots[0].centerX - 6 < frameRect.left,
        };
        // 源节点：用画布自己的建节点桥（与节点搜索同一条路）在左上放一张「图片生成」
        window.dispatchEvent(
          new CustomEvent('fisherai:add-canvas-node', {
            detail: { type: 'Image', point: { x: origin.x - 900, y: origin.y + 80 } },
          }),
        );
        const sourceFrame = await portUntil(() => {
          const frames = [...document.querySelectorAll('[data-node-id]')];
          return (
            frames.find((frame) => {
              if (frame === targetFrame) return false;
              const point = portFramePoint(frame);
              return point !== null && Math.abs(point.x - (origin.x - 900)) < 4;
            }) || null
          );
        }, 8000);
        if (!sourceFrame) {
          portDragSteps.error = 'no source node';
          return;
        }
        await portSleep(400);
        // v1.31：这颗刚建出来的图片节点（走同一条 createCanvasNode）默认模型必须跟着
        // 「设置里勾的通道模型」走 —— 现场预置的通道别名是「魔搭出图」；
        // 旧实现会被 applyFreshCanvasNodeDefaults 覆盖成上游内置的 GPT Image 2 · API（本插件没有那条后端）。
        // 注意：这段在外层模板字面量里，**不许写反斜杠**，所以用 indexOf 而不是正则。
        const sourceCopy = String(sourceFrame.textContent || '');
        portDragSteps.sourceModel = {
          hasChannelModel: sourceCopy.indexOf('魔搭出图') >= 0,
          hasVendorDefault: sourceCopy.indexOf('GPT Image 2') >= 0,
          sample: sourceCopy.slice(0, 160),
        };
        const outButton = sourceFrame.querySelector('[data-fisherai-connector-side="right"]');
        if (!outButton) {
          portDragSteps.error = 'source node has no right connector';
          return;
        }
        const outRect = outButton.getBoundingClientRect();
        const start = {
          x: outRect.left + outRect.width / 2,
          y: outRect.top + outRect.height / 2,
        };
        portDragSteps.start = {
          x: Math.round(start.x),
          y: Math.round(start.y),
          measurable: outRect.width > 1 && outRect.height > 1,
        };
        const surfaceEl = document.getElementById('canvas-background');
        const imageSlot = [...slots].reverse().find((slot) => slot.row.indexOf('◇') >= 0);
        const textSlot = slots.find((slot) => slot.row.indexOf('T') >= 0);
        if (!surfaceEl || !imageSlot || !textSlot) {
          portDragSteps.error = 'canvas surface / slot kinds not found';
          return;
        }
        portDragSteps.kinds = { image: imageSlot.port, text: textSlot.port };

        // ---- ① 瞄准素材槽「+」圆的**外半边**（圆心左 10px = 节点框外面）拖过去
        portDragSteps.busy = true;
        const menuBefore = portMenuCalls();
        const aim = { x: imageSlot.centerX - 10, y: imageSlot.centerY };
        const targetNodeId = targetFrame.getAttribute('data-node-id') || '';
        const edgesOfTarget = () =>
          [...document.querySelectorAll('[data-edge-key]')]
            .map((edge) => edge.getAttribute('data-edge-key') || '')
            .filter((key) => key.indexOf('-' + targetNodeId + '-') >= 0);
        const edgesBefore = [...document.querySelectorAll('[data-edge-key]')].length;
        portFire(outButton, 'pointerdown', start.x, start.y);
        await portSleep(60);
        // ---- v1.47：拖出来的虚线必须**跟着指针**（底盘不在窗口左上角时也不许偏）
        //
        // 用户报障原话「从图像拉出的线与鼠标指针有很大偏差」：上游把 clientX/clientY 直接
        // 当画布内坐标用，本插件的画布底盘左边是 DSH 侧边栏（这个宿主页复刻了 240px），
        // 于是虚线整体偏 (底盘左, 底盘上) / zoom。这里的判定只认一件事：
        // 指针停在空白处时，虚线自由端换算回屏幕坐标必须落回指针上（±2px）。
        const blankPoint = (() => {
          for (let step = 0; step < 8; step += 1) {
            const point = { x: start.x + 40 + step * 24, y: start.y + 20 + step * 12 };
            const hit = document.elementFromPoint(point.x, point.y);
            if (!hit) continue;
            if (hit.id === 'canvas-background' || hit.tagName.toLowerCase() === 'svg') return point;
          }
          return { x: start.x + 40, y: start.y + 20 };
        })();
        portFire(surfaceEl, 'pointermove', blankPoint.x, blankPoint.y);
        await new Promise((done) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(done)),
        );
        portDragSteps.tempLine = (() => {
          const surface = document.getElementById('canvas-background');
          const layer = document.getElementById('canvas-viewport-content');
          const dashed = [
            ...document.querySelectorAll('#canvas-viewport-content svg path[stroke-dasharray]'),
          ].pop();
          const d = dashed ? String(dashed.getAttribute('d') || '') : '';
          const tail = d.slice(d.lastIndexOf(',') + 1).trim().split(' ');
          const worldX = parseFloat(tail[0]);
          const worldY = parseFloat(tail[1]);
          const transform = String((layer && layer.style && layer.style.transform) || '');
          const openIndex = transform.indexOf('(');
          const closeIndex = transform.indexOf(')');
          const shift = transform.slice(openIndex + 1, closeIndex).split(',');
          const vx = parseFloat(shift[0]) || 0;
          const vy = parseFloat(shift[1]) || 0;
          const scaleIndex = transform.lastIndexOf('scale(');
          const zoom = scaleIndex < 0 ? 1 : parseFloat(transform.slice(scaleIndex + 6)) || 1;
          const rect = surface ? surface.getBoundingClientRect() : { left: 0, top: 0 };
          return {
            found: Number.isFinite(worldX) && Number.isFinite(worldY),
            pointer: [Math.round(blankPoint.x), Math.round(blankPoint.y)],
            world: [Math.round(worldX), Math.round(worldY)],
            canvasRect: [Math.round(rect.left), Math.round(rect.top)],
            zoom: zoom,
            /** 虚线端点换算回屏幕后与指针的差（像素）：0 = 跟手 */
            delta: [
              Math.round(rect.left + worldX * zoom + vx - blankPoint.x),
              Math.round(rect.top + worldY * zoom + vy - blankPoint.y),
            ],
            path: d.slice(0, 60),
          };
        })();
        portFire(surfaceEl, 'pointermove', aim.x, aim.y);
        await portSleep(120);
        // 网格探针每 250ms 会把指针挪到它钉住的位置，所以量发光前再补一次移动，
        // 并等两帧（发光走 rAF 节流）后再读样式。探针那一拍如果正好插在「补移动」和
        // 「读样式」之间，读到的是复位后的 identity —— 全量跑时偶发（2026-10-19 踩到：
        // 单独跑这一场绿、全量跑红）。这里改成轮询几轮，每轮都补一次指针移动，
        // 拿到「真的放大 + 有发光」就停。
        let glowStyle = null;
        portDragSteps.glow = { transform: '', boxShadow: 'none' };
        for (let glowAttempt = 0; glowAttempt < 6; glowAttempt += 1) {
          portFire(surfaceEl, 'pointermove', aim.x, aim.y);
          await new Promise((done) =>
            window.requestAnimationFrame(() => window.requestAnimationFrame(done)),
          );
          glowStyle = getComputedStyle(slotButtons[imageSlot.index]);
          portDragSteps.glow = {
            transform: String(glowStyle.transform || ''),
            boxShadow: String(glowStyle.boxShadow || 'none').slice(0, 90),
          };
          const glowTransformNow = portDragSteps.glow.transform;
          const glowOpen = glowTransformNow.indexOf('(');
          const glowComma = glowTransformNow.indexOf(',');
          const glowScaleNow =
            glowOpen >= 0 && glowComma > glowOpen
              ? Number(glowTransformNow.slice(glowOpen + 1, glowComma)) || 1
              : 1;
          if (glowScaleNow > 1.05 && portDragSteps.glow.boxShadow !== 'none') break;
          await portSleep(40);
        }
        // 诊断读数（BROWSER_DEBUG 时才看）：手势到底起没起来、发光模块绑没绑上、
        // 以及「瞄准点下面到底是哪个元素」（这是命中判定的第一现场）
        const aimElement = document.elementFromPoint(aim.x, aim.y);
        const centerHit = document.elementFromPoint(imageSlot.centerX, imageSlot.centerY);
        portDragSteps.diagnose = {
          dashedPaths: document.querySelectorAll('svg path[stroke-dasharray]').length,
          glow: typeof window.__FISHERAI_PORT_GLOW__ === 'function'
            ? window.__FISHERAI_PORT_GLOW__()
            : null,
          slotWidth: Math.round(slots[imageSlot.index].width),
          aimTag: aimElement ? aimElement.tagName : null,
          aimConnector: Boolean(aimElement && aimElement.closest('[data-fisherai-connector-node-id]')),
          aimClass: aimElement ? String(aimElement.className || '').slice(0, 60) : null,
          centerTag: centerHit ? centerHit.tagName : null,
          centerConnector: Boolean(centerHit && centerHit.closest('[data-fisherai-connector-node-id]')),
          centerClass: centerHit ? String(centerHit.className || '').slice(0, 60) : null,
          outTag: outButton.tagName,
        };
        portFire(surfaceEl, 'pointerup', aim.x, aim.y);
        await portSleep(700);
        const targetEdges = edgesOfTarget();
        portDragSteps.drop = {
          aimOutsideNode: aim.x < frameRect.left,
          edgesBefore: edgesBefore,
          edgesAfter: [...document.querySelectorAll('[data-edge-key]')].length,
          targetEdges: targetEdges,
          /** 落点真的接在素材槽（port 2）上：连线的 key 以「-<节点id>-2」结尾 */
          landOnAimedSlot: targetEdges.some((key) => key.endsWith('-' + targetNodeId + '-' + imageSlot.port)),
          menuOpened: portMenuCalls() !== menuBefore,
        };

        // ---- ② 瞄着文本槽丢图片节点：不许接、也不许自动挪到别的槽
        const menuBeforeInvalid = portMenuCalls();
        const nodeCountBefore = document.querySelectorAll('[data-node-id]').length;
        portFire(outButton, 'pointerdown', start.x, start.y);
        await portSleep(60);
        portFire(surfaceEl, 'pointermove', textSlot.centerX, textSlot.centerY);
        await portSleep(160);
        portFire(surfaceEl, 'pointerup', textSlot.centerX, textSlot.centerY);
        await portSleep(700);
        const invalidEdges = edgesOfTarget();
        portDragSteps.invalidDrop = {
          /** 文本槽上没有多出连线（不兼容就不接，不自动挪槽） */
          textSlotEdges: invalidEdges.filter((key) => key.endsWith('-' + targetNodeId + '-' + textSlot.port)),
          edgeDelta: [...document.querySelectorAll('[data-edge-key]')].length - edgesBefore - 1,
          menuOpened: portMenuCalls() !== menuBeforeInvalid,
          nodeDelta: document.querySelectorAll('[data-node-id]').length - nodeCountBefore,
        };
        portDragSteps.busy = false;
      } catch (error) {
        portDragSteps.error = String((error && error.stack) || error);
      } finally {
        portDragSteps.busy = false;
        portDragSteps.done = true;
      }
    };

    /**
     * 节点搜索场景（?search=1，v1.10）：
     *   ① 把鼠标停在画布上一个**已知点**，按 Shift+A → 面板要出现在鼠标旁边（不是屏幕角落）；
     *   ② 输入「视频」→ 高亮候选应该是视频生成（模糊排序的真机验证）；
     *   ③ Enter → 画布上要真多出一个落在鼠标那附近的节点；
     *   ④ 再按一次 Shift+A，搜工作流标题 → 选中后节点上应写着那份工作流（comfyMode）。
     * 这些只能在真机验：jsdom 没有布局，量不出「面板贴着鼠标」这件事。
     */
    const searchSteps = {
      panelOpened: false, atPointer: null, focused: false, queryIds: [],
      nodeDelta: 0, nodeAtPointer: null, workflowMode: null, done: false,
    };
    const searchScene = new URLSearchParams(location.search).get('search') === '1';
    /**
     * 宿主页脚本里的项目 id 只能从 URL 来（页面脚本没有 Node 侧那个 projectId 变量 ——
     * 踩过：直接引用会抛 ReferenceError: projectId is not defined，探针停在第一步）。
     */
    const resumedProjectId = new URLSearchParams(location.search).get('resume') ?? '';
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (probe, timeoutMs = 15000) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const value = probe();
        if (value) return value;
        await sleep(120);
      }
      return null;
    };
    const searchPanel = () => document.querySelector('[data-fisherai-node-search-panel]');
    const pressShiftA = () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true }),
      );
    };
    const typeQuery = (value) => {
      const input = searchPanel()?.querySelector('[data-fisherai-node-search-input]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const itemIds = () =>
      searchPanel()
        ? Array.from(searchPanel().querySelectorAll('[data-fisherai-node-search-item]')).map((item) =>
            item.getAttribute('data-command-id'),
          )
        : [];
    const pressEnter = () => {
      const input = searchPanel()?.querySelector('[data-fisherai-node-search-input]');
      if (!input) return false;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    };
    /**
     * 画布里的节点（真值来源：**页面 DOM**）。
     * 不读存盘文档：自动保存有 5s 间隔，新节点还没落盘就白等（踩过：等 12 秒也没等到）。
     * 画布每加一个节点都会立刻渲染出 [data-node-id]，那份就是用户眼前的东西。
     */
    const liveNodes = () => [...document.querySelectorAll('[data-node-id]')];
    /** 每个本地工作流节点当前选中的工作流（节点上的下拉框 value 就是 comfyMode）。 */
    const workflowModes = () =>
      [...document.querySelectorAll('[data-fisherai-local-workflow-picker]')].map((select) =>
        String(select.value ?? ''),
      );
    const buildNodeSearchNode = async () => {
      if (!searchScene) return;
      try {
        await runNodeSearchScene();
      } catch (error) {
        searchSteps.error = String((error && error.stack) || error);
      }
      searchSteps.done = true;
    };

    /**
     * 「ComfyUI 工作流配置」面板场景（?wfconf=1，v1.16）：
     *   ① 点左栏第三个按钮 → 面板出现，并且**在画布容器里**（配色/主题变量继承画布）；
     *   ② 左栏列出目录里的工作流、右栏列出候选字段（勾选清单）、顶部有「已选 N/M」；
     *   ③ 勾一个未勾的候选 → 保存 → 底栏出现 ok 提示、不再标「有未保存改动」；
     *   ④ 点「添加到画布」→ 面板关掉、画布上真的多一个工作流节点（下拉框指向那份工作流）；
     *   ⑤ 最后再打开一次面板 —— 截图就停在这个面板上（交付物要看的就是它）。
     * jsdom 里这些逻辑都验过（test-canvas-workflow-config），这里量的是**真布局与真点击**。
     */
    const wfConfigSteps = {
      opened: false, items: 0, rows: 0, selectedCount: 0, box: null, insideCanvas: false,
      dirValue: '', dirWidth: 0, dirEditable: false, applyVisible: false, scanComfyVisible: false,
      saved: false, notice: null, dirtyAfterSave: null, addClosed: false, nodeDelta: 0,
      pickerValues: [], reopened: false,
      // v1.19：节点图 + 右侧检查器（真浏览器里量得到尺寸，jsdom 量不到）
      graphNodes: 0, graphEdges: 0, graphBox: null, graphZoom: 0, wheelZoom: 0,
      fitVisible: false, nodeWidth: 0,
      inspectorMode: '', inspectorTitle: '', inspectorRows: 0, inspectorBox: null, nodeSelected: '',
      done: false,
    };
    const wfConfigScene = new URLSearchParams(location.search).get('wfconf') === '1';
    const wfConfigDialog = () => document.querySelector('[data-fisherai-workflow-config-dialog]');
    const runWorkflowConfigScene = async () => {
      const trigger = await until(() => document.querySelector('[data-fisherai-workflow-config-trigger]'));
      if (!trigger) return;
      trigger.click();
      const dialog = await until(() => wfConfigDialog());
      if (!dialog) return;
      wfConfigSteps.opened = true;
      const box = dialog.getBoundingClientRect();
      const mount = document.querySelector('.af-canvas-mount');
      wfConfigSteps.box = {
        width: Math.round(box.width),
        height: Math.round(box.height),
        left: Math.round(box.left),
        top: Math.round(box.top),
      };
      wfConfigSteps.insideCanvas = Boolean(mount && mount.contains(dialog));
      const items = await until(() => {
        const found = Array.from(dialog.querySelectorAll('[data-fisherai-workflow-config-item]'));
        return found.length ? found : null;
      });
      wfConfigSteps.items = items ? items.length : 0;
      const rows = await until(() => {
        const found = Array.from(dialog.querySelectorAll('[data-fisherai-workflow-config-candidate]'));
        return found.length ? found : null;
      });
      wfConfigSteps.rows = rows ? rows.length : 0;
      const countNode = dialog.querySelector('[data-fisherai-workflow-config-count]');
      wfConfigSteps.selectedCount = Number(
        (countNode && countNode.getAttribute('data-fisherai-workflow-config-count')) || 0,
      );

      // v1.18：底栏的工作流目录是**可编辑输入框**（真浏览器量宽度，验它没被挤成 0 宽）
      const dirInput = dialog.querySelector('input[aria-label="工作流目录"]');
      wfConfigSteps.dirValue = dirInput ? String(dirInput.value || '') : '';
      wfConfigSteps.dirWidth = dirInput ? Math.round(dirInput.getBoundingClientRect().width) : 0;
      wfConfigSteps.dirEditable = Boolean(dirInput && !dirInput.disabled && !dirInput.readOnly);
      const applyDirButton = dialog.querySelector('button[aria-label="应用目录"]');
      wfConfigSteps.applyVisible = Boolean(
        applyDirButton && applyDirButton.getBoundingClientRect().width > 0,
      );
      // v1.20：底栏「扫描 ComfyUI」按钮真渲染出来（扫 /object_info 拿下拉候选）
      const scanButton = dialog.querySelector('[data-fisherai-workflow-config-scan-comfy]');
      wfConfigSteps.scanComfyVisible = Boolean(
        scanButton && scanButton.getBoundingClientRect().width > 0,
      );

      const unchecked = (rows || []).find((row) => row.getAttribute('aria-checked') === 'false');
      if (unchecked) {
        unchecked.click();
        await sleep(250);
      }
      const saveButton = dialog.querySelector('button[aria-label="保存配置"]');
      if (saveButton) saveButton.click();
      const notice = await until(() => {
        const live = wfConfigDialog() && wfConfigDialog().querySelector('[data-fisherai-workflow-config-notice]');
        return live && live.getAttribute('data-fisherai-workflow-config-notice') === 'ok' ? live : null;
      });
      wfConfigSteps.saved = Boolean(notice);
      wfConfigSteps.notice = String((notice && notice.textContent) || '').slice(0, 90);
      const liveDialog = wfConfigDialog();
      wfConfigSteps.dirtyAfterSave = liveDialog
        ? liveDialog.getAttribute('data-fisherai-workflow-config-dirty')
        : null;

      const nodesBefore = document.querySelectorAll('[data-node-id]').length;
      const addButton = wfConfigDialog() && wfConfigDialog().querySelector('button[aria-label="添加到画布"]');
      if (addButton) addButton.click();
      const closed = await until(() => (wfConfigDialog() ? null : true));
      wfConfigSteps.addClosed = Boolean(closed);
      const nodesAfter = await until(() => {
        const count = document.querySelectorAll('[data-node-id]').length;
        return count > nodesBefore ? count : null;
      });
      wfConfigSteps.nodeDelta = nodesAfter ? nodesAfter - nodesBefore : 0;
      wfConfigSteps.pickerValues = Array.from(
        document.querySelectorAll('[data-fisherai-local-workflow-picker]'),
      ).map((element) => String(element.value || ''));

      // 再开一次：截图停在面板上
      const again = await until(() => document.querySelector('[data-fisherai-workflow-config-trigger]'));
      if (again) {
        again.click();
        const back = await until(() => wfConfigDialog());
        wfConfigSteps.reopened = Boolean(back);
      }

      // v1.19：节点图 + 右侧检查器。真浏览器里量尺寸/真点节点，最后截图就停在这一屏。
      const graphBox = await until(() => document.querySelector('[data-fisherai-workflow-config-graph]'));
      if (graphBox) {
        const nodeCards = await until(() => {
          const found = Array.from(document.querySelectorAll('[data-fisherai-workflow-config-graph-node]'));
          return found.length ? found : null;
        });
        wfConfigSteps.graphNodes = Number(graphBox.getAttribute('data-nodes'));
        wfConfigSteps.graphEdges = Number(graphBox.getAttribute('data-edges'));
        const graphRect = graphBox.getBoundingClientRect();
        wfConfigSteps.graphBox = {
          width: Math.round(graphRect.width),
          height: Math.round(graphRect.height),
        };
        const fitButton = document.querySelector('[data-fisherai-workflow-config-fit]');
        wfConfigSteps.fitVisible = Boolean(fitButton && fitButton.getBoundingClientRect().width > 0);
        if (fitButton) fitButton.click();
        await sleep(220);
        wfConfigSteps.graphZoom = Number(graphBox.getAttribute('data-zoom'));
        // 滚轮缩放（原生非 passive 监听）：在图上发一个真的 WheelEvent，看缩放读数有没有变
        const fitRect = graphBox.getBoundingClientRect();
        graphBox.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -240,
            clientX: fitRect.left + Math.min(240, fitRect.width / 2),
            clientY: fitRect.top + Math.min(200, fitRect.height / 2),
            bubbles: true,
            cancelable: true,
          }),
        );
        await sleep(200);
        wfConfigSteps.wheelZoom = Number(graphBox.getAttribute('data-zoom'));
        // 滚轮之后回到全景，截图要的是整张图
        if (fitButton) fitButton.click();
        await sleep(220);
        const firstNode = (nodeCards || [])[0];
        wfConfigSteps.nodeWidth = firstNode ? firstNode.getBoundingClientRect().width : 0;
        // 点一个有可勾字段的节点 → 检查器切成「节点模式」（参考图右侧那块浮层）
        const target = (nodeCards || []).find(
          (node) => Number(node.getAttribute('data-candidates')) > 0,
        );
        if (target) {
          target.click();
          const inspector = await until(() =>
            document.querySelector('[data-fisherai-workflow-config-inspector]'),
          );
          await sleep(200);
          if (inspector) {
            wfConfigSteps.inspectorMode = String(
              inspector.getAttribute('data-fisherai-workflow-config-inspector') || '',
            );
            wfConfigSteps.inspectorTitle = String(inspector.textContent || '').slice(0, 60);
            wfConfigSteps.inspectorRows = inspector.querySelectorAll(
              '[data-fisherai-workflow-config-candidate]',
            ).length;
            const inspectorRect = inspector.getBoundingClientRect();
            wfConfigSteps.inspectorBox = {
              width: Math.round(inspectorRect.width),
              height: Math.round(inspectorRect.height),
            };
          }
          wfConfigSteps.nodeSelected = String(target.getAttribute('data-selected') || '');
        }
      }
    };
    const buildWorkflowConfigScene = async () => {
      if (!wfConfigScene) return;
      try {
        await runWorkflowConfigScene();
      } catch (error) {
        wfConfigSteps.error = String((error && error.stack) || error);
      }
      wfConfigSteps.done = true;
    };
    const runNodeSearchScene = async () => {
      const background = await until(() => document.getElementById('canvas-background'));
      const rail = await until(() => document.querySelector('[data-fisherai-node-search-trigger]'));
      if (!background || !rail) {
        searchSteps.done = true;
        return;
      }
      const box = background.getBoundingClientRect();
      const point = { x: Math.round(box.left + box.width * 0.42), y: Math.round(box.top + box.height * 0.38) };
      // 网格探针的 pointermove 会干扰下面「新建并移动」的位移测量（见 gridProbe 顶部）
      window.__DSH_SKIP_GRID_PROBE__ = true;
      background.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: point.x, clientY: point.y }));
      await sleep(200);

      // ---- ① Shift+A 开面板，量它是不是贴着鼠标
      const nodesBefore = liveNodes().length;
      pressShiftA();
      const panel = await until(() => searchPanel());
      if (!panel) {
        searchSteps.done = true;
        return;
      }
      searchSteps.nodesBefore = nodesBefore;
      searchSteps.panelOpened = true;
      const panelBox = panel.getBoundingClientRect();
      searchSteps.atPointer = {
        dx: Math.round(panelBox.left - point.x),
        dy: Math.round(panelBox.top - point.y),
        width: Math.round(panelBox.width),
      };
      const blockBox = (document.querySelector('.af-canvas-mount') ?? document.body).getBoundingClientRect();
      searchSteps.focused = document.activeElement === panel.querySelector('[data-fisherai-node-search-input]');
      /**
       * 面板的定位包含块是谁：面板用 absolute + left/top，参照的是**最近的定位祖先**。
       * 这里把 1×1 探针插进同一父节点量一次（只作诊断用 —— 探针与面板的 offsetParent
       * 未必是同一个，所以期望值按「块有布局箱 + 夹到边距内」那条规则算，见下）。
       */
      const probeMarker = document.createElement('div');
      probeMarker.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;';
      panel.parentElement?.appendChild(probeMarker);
      const originBox = probeMarker.getBoundingClientRect();
      probeMarker.remove();
      const originWidth = blockBox.width > 0 ? blockBox.width : 0;
      const hasBox = originWidth > 0;
      /**
       * 期望 x 必须把**画布当前平移量**算进去：面板的落点用的是画布世界坐标，
       * 画布被平移过时屏幕位置 = 块左缘 + (光标x - 块左缘 - panX)（再夹到边距内）。
       * 踩过：漏了 panX，探针里画布恰恰平移了 -482px，于是「面板贴在光标那一列」误判成差 482。
       */
      const panX = (() => {
        const transform = document.getElementById('canvas-viewport-content')?.style.transform ?? '';
        searchSteps.rawTransform = transform;
        const open = transform.indexOf('translate3d(');
        if (open < 0) return 0;
        const value = transform.slice(open + 'translate3d('.length).split(',')[0];
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      })();
      searchSteps.panX = Math.round(panX);
      /**
       * 画布挂载容器是否被祖先 transform 缩放（DSH 面板容器可能带 transform，
       * 那会让「屏幕坐标」与「布局坐标」不成 1:1，夹取与落点都要按缩放算）。
       */
      const viewportLayer = document.getElementById('canvas-viewport-content');
      const mountsTransform = viewportLayer
        ? getComputedStyle(viewportLayer).transform
        : '(no layer)';
      searchSteps.viewportTransform = String(mountsTransform).slice(0, 80);
      searchSteps.panelStylePosition = {
        left: panel.style.left,
        top: panel.style.top,
        width: panel.style.width,
      };
      searchSteps.placementLog = window.__DSH_NODE_SEARCH_PLACEMENT__ ?? null;
      searchSteps.pointerLog = null;
      searchSteps.panelParent = (() => {        const chain = [];
        let node = panel.parentElement;
        for (let step = 0; node && step < 4; step += 1) {
          const cs = getComputedStyle(node);
          chain.push({
            tag: node.tagName.toLowerCase(),
            cls: String(node.className ?? '').slice(0, 40),
            position: cs.position,
            transform: String(cs.transform).slice(0, 40),
            left: Math.round(node.getBoundingClientRect().left),
          });
          node = node.parentElement;
        }
        return chain;
      })();
      const expectedLeft = hasBox
        ? Math.max(12, Math.min(point.x - originBox.left, originWidth - 380 - 12))
        : Math.max(12, Math.min(point.x - originBox.left, window.innerWidth - 380 - 12));
      searchSteps.containerOrigin = {
        left: Math.round(originBox.left),
        width: Math.round(originWidth),
        panelLeft: Math.round(panelBox.left),
      };
      // 面板实际落在哪个 x：包含块有布局箱时是 blockLeft + 夹住的偏移，否则就是夹住的偏移本身
      searchSteps.expectedLeft = Math.round(
        hasBox
          ? blockBox.left +
              Math.max(12, Math.min(point.x - blockBox.left - panX, originWidth - 380 - 12))
          : Math.max(12, Math.min(point.x - panX, window.innerWidth - 380 - 12)),
      );
      searchSteps.leftDelta = Math.round(panelBox.left - searchSteps.expectedLeft);
      // 「贴着鼠标」的硬指标：面板左缘 ≤ 光标 ≤ 面板右缘（面板从光标向右下展开，夹到边上时例外）
      searchSteps.cursorWithinPanel =
        point.x >= panelBox.left - 1 && point.x <= panelBox.right + 1;
      searchSteps.panelInsideCanvas =
        panelBox.left >= box.left - 1 && panelBox.right <= box.right + 1;
      searchSteps.pointerInCanvas = point.x >= box.left && point.x <= box.right;

      // ---- ② 模糊过滤：输入「视频」应只剩视频相关项，且第一项是视频生成
      typeQuery('视频');
      await sleep(250);
      searchSteps.queryIds = itemIds();

      // ---- ③ 建节点：点候选（与 Enter 同一条路 —— commit → 事件 → 画布建节点）。
      // 用 mousedown 而不是 Enter：真机里 Enter 会先被输入框的 IME/键盘处理链吃掉一次，
      // 点选是更稳的回归路径（Enter 的行为由 jsdom 那条 test:node-search 覆盖）。
      // 判定「真建出来了」用 vendor 桥的调用计数 + 节点框覆盖光标：DOM 里 [data-node-id] 的数量
      // 会因为画布的虚拟化/重渲染抖动（实测同一时刻会多出一个），不适合当唯一依据。
      const idsBefore = liveNodes().map((node) => node.getAttribute('data-node-id'));
      searchSteps.idsBefore = idsBefore;
      const bridgeBefore = window.__DSH_NODE_CREATE_CALLS__ ?? 0;
      const firstItem = document.querySelector('[data-fisherai-node-search-item]');
      firstItem?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await sleep(400);
      const after = await until(() => (liveNodes().length > idsBefore.length ? liveNodes() : null), 8000);
      searchSteps.bridgeCalls = (window.__DSH_NODE_CREATE_CALLS__ ?? 0) - bridgeBefore;
      searchSteps.createdNodeIds = after ? after.map((node) => node.getAttribute('data-node-id')) : [];
      // 新建的那个节点（DOM 里最后一个新 id）
      const created = after ? after[after.length - 1] ?? null : null;
      if (created) {
        const createdBox = created.getBoundingClientRect();
        searchSteps.nodeType = created.querySelector('[data-fisherai-local-workflow-node]') ? 'ComfyUI' : 'media';
        /**
         * 落点校验：节点框（NodeFrame）是按内容自动调尺寸的，框的左上角与光标差几十像素是正常的；
         * 但**连接端口的纵坐标**来自画布算出的世界坐标，所以这里改成比「落点换算出的屏幕上的一点」
         * 与节点框左缘的关系：节点框右缘应当离光标不远（节点以落点为中心铺开）。
         */
        searchSteps.nodeAtPointerDelta = {
          leftEdgeDx: Math.round(createdBox.left - point.x),
          rightEdgeDx: Math.round(createdBox.right - point.x),
          topDy: Math.round(createdBox.top - point.y),
          width: Math.round(createdBox.width),
        };
        searchSteps.nodeCoversPointer =
          point.x >= createdBox.left - 20 &&
          point.x <= createdBox.right + 20 &&
          point.y >= createdBox.top - 20 &&
          point.y <= createdBox.bottom + 20;

        // ---- ③b v1.45「新建并移动」：先跟手，左键放下后不再跟手
        const createdRect = () => (created ? created.getBoundingClientRect() : null);
        const followBefore = createdRect();
        const transformBefore = created.style.transform;
        // 第一次 pointermove 只定基线（面板可能刚建完节点，鼠标没动过）
        background.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: point.x, clientY: point.y }),
        );
        await sleep(50);
        background.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: point.x + 60, clientY: point.y + 40 }),
        );
        await sleep(250);
        const followAfter = createdRect();
        searchSteps.follow = {
          dx: followBefore && followAfter ? Math.round(followAfter.left - followBefore.left) : null,
          dy: followBefore && followAfter ? Math.round(followAfter.top - followBefore.top) : null,
          transformBefore: transformBefore,
          transformAfter: created.style.transform,
        };
        // 左键放下（这一次要被画布侧吞掉）
        background.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
        );
        await sleep(150);
        const droppedBefore = createdRect();
        background.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: point.x + 220, clientY: point.y + 160 }),
        );
        await sleep(250);
        const droppedAfter = createdRect();
        searchSteps.dropped = {
          dx: droppedBefore && droppedAfter ? Math.round(droppedAfter.left - droppedBefore.left) : null,
          dy: droppedBefore && droppedAfter ? Math.round(droppedAfter.top - droppedBefore.top) : null,
        };
        searchSteps.placementDiag = window.__DSH_NODE_PLACEMENT__ ?? null;
      }
      await sleep(200);

      // ---- ④ 再开一次，搜工作流（候选目录里每一份本地工作流都能搜到）
      pressShiftA();
      if (!(await until(() => searchPanel()))) {
        searchSteps.done = true;
        return;
      }
      // 假宿主预置那份工作流的标题（见本文件顶部写入 workflows 目录的 meta）
      typeQuery('浏览器检查用文生图');
      await sleep(300);
      // 用普通数组接住候选（NodeList 没有 find；也别把展开与 ?? 写在同一行里 —— 解析优先级会咬人）
      const items = searchPanel() ? Array.from(searchPanel().querySelectorAll('[data-fisherai-node-search-item]')) : [];
      const option = items.find((item) =>
        String(item.getAttribute('data-command-id') ?? '').startsWith('workflow:'),
      );
      searchSteps.workflowOption = option?.getAttribute('data-command-id') ?? null;
      searchSteps.workflowCandidates = items.map((item) => item.getAttribute('data-command-id'));
      const nodesBeforePick = liveNodes().length;
      option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      const picked = await until(() => (liveNodes().length > nodesBeforePick ? liveNodes() : null), 8000);
      searchSteps.pickedDelta = (picked?.length ?? nodesBeforePick) - nodesBeforePick;
      // 新节点上的工作流下拉 value 就是 comfyMode（与在节点上下拉里选中它是同一个状态）
      const modes = await until(() => {
        const values = workflowModes();
        return values.length ? values : null;
      }, 8000);
      searchSteps.workflowModes = modes ?? [];
      searchSteps.workflowMode =
        (modes ?? []).find((value) => value.startsWith('custom-')) ?? null;
      searchSteps.done = true;
    };

    /**
     * 设置页场景（?settings=1）：真打开「设置」对话框，逐个分区切过去，
     * 把每个分区里有没有错误提示、有没有它该有的东西记下来。
     *
     * 这一场专门盯 v1.1 补的四块后端：开源服务（ComfyUI 状态）、闭源服务（自配端点卡片）、
     * 存储（下载目录）、画布外观（背景图）。以前这四页打开就是红的 —— 接口根本不存在。
     */
    const settingsScene = new URLSearchParams(location.search).get('settings') === '1';
    /**
     * 设置 →「画布外观」页里那块「画布互动」开关的**取证场景**（?effects=1，v1.27）。
     * 只做一件事：开设置 → 切画布外观 → 等面板挂上 → 停在那一屏截图（截图就是交付物）。
     */
    const effectsScene = new URLSearchParams(location.search).get('effects') === '1';
    /**
     * 设置 →「闭源服务 → OpenAI 通道」面板的取证场景（?channels=1，v1.30）。
     * 只做一件事：开设置 → 切闭源服务 → 等通道面板挂上 → 把面板滚到可见处，停在那一屏截图。
     */
    const channelsScene = new URLSearchParams(location.search).get('channels') === '1';
    /**
     * 设置 →「存储 → 项目数据目录」面板的取证场景（?ddir=1，v1.43）。
     *
     * 用户 2026-10-18 原话「设置里添加项目自定义缓存目录」。这一场只做一件事：
     * 开设置 → 切存储 → 等面板挂上 → 把面板滚到可见处 → 停在那一屏截图（截图就是交付图），
     * 顺带量出「当前目录 / 默认目录 / 是否等重启」三个读数（真机上这些值来自 host 的 /data-dir）。
     */
    const dataDirScene = new URLSearchParams(location.search).get('ddir') === '1';
    const settingsProbe = { opened: false, sections: {} };
    const readSection = (dialog, id) => {
      const content = dialog.querySelector('[data-fisherai-settings-content="true"]');
      const text = (content?.innerText ?? '').replace(/\\s+/g, ' ');
      const alert = content?.querySelector('[role="alert"]');
      // v1.13：旧的「自配云端端点（OpenAI 兼容）」单端点卡片已移除 —— 这一页不该再出现它。
      // 但「OpenAI 通道」面板的**说明文字**里会提到这张卡片的旧名字（那是故意的指路文案），
      // 所以不能拿整段文本 includes —— 要扣掉我们那块面板里的出现次数，剩下的才算「卡片还在」。
      const panelEl = content?.querySelector('[data-fisherai-cloud-channels]');
      const panelText = (panelEl?.innerText ?? '').replace(/\\s+/g, ' ');
      const occurrences = (haystack) => haystack.split('自配云端端点').length - 1;
      return {
        hasContent: !!content,
        alertText: alert ? String(alert.textContent || '').slice(0, 160) : '',
        text: text.slice(0, 260),
        background: text.includes('背景'),
        comfyHeading: text.includes('ComfyUI'),
        gpuRow: text.includes('GPU'),
        legacyCard: occurrences(text) > occurrences(panelText),
        legacySecretField: !!content?.querySelector('[data-fisherai-secret-field="AIFISHER_CLOUD_BASE_URL"]'),
        // v1.11：闭源服务页顶部那块「OpenAI 通道」多通道面板（我们自己挂的 DOM，不走 vendor 组件）
        channelPanel: !!content?.querySelector('[data-fisherai-cloud-channels]'),
        channelHeading: text.includes('OpenAI 通道'),
        downloadDir: content?.querySelector('[data-fisherai-download-directory]')?.textContent ?? '',
        downloadSetting: text.includes('下载设置'),
        // v1.27：画布外观页里的「画布互动」开关（我们自己挂的原生 DOM 面板）
        effectsPanel: !!content?.querySelector('[data-fisherai-canvas-effects]'),
        effectsSwitch: (() => {
          const sw = content?.querySelector('[data-fisherai-canvas-effect="pointer-glow"]');
          return sw
            ? { role: sw.getAttribute('role'), ariaChecked: sw.getAttribute('aria-checked') }
            : null;
        })(),
      };
    };
    const walkSettings = async () => {
      if (!settingsScene) return;
      await wait(1500);
      window.dispatchEvent(new CustomEvent('fisherai:open-settings'));
      await wait(900);
      const dialog = document.querySelector('[data-fisherai-settings="true"]');
      settingsProbe.opened = !!dialog;
      if (!dialog) return;
      if (channelsScene) {
        // 只切到「闭源服务」，等我们那块通道面板挂上，然后停在这一屏（页面最后一次状态 = 截图）
        const tab = dialog.querySelector('[data-fisherai-settings-section="models"]');
        if (tab) tab.click();
        await until(() => dialog.querySelector('[data-fisherai-cloud-channels]'), 8000);
        await wait(700);
        const panelEl = dialog.querySelector('[data-fisherai-cloud-channels]');
        if (panelEl) panelEl.scrollIntoView({ block: 'start' });
        await wait(500);
        const box = panelEl ? panelEl.getBoundingClientRect() : null;
        const select = panelEl
          ? panelEl.querySelector('[data-fisherai-channel-dialect]')
          : null;
        const presets = panelEl
          ? Array.prototype.slice.call(panelEl.querySelectorAll('[data-fisherai-channel-preset]'))
          : [];
        settingsProbe.channelsShot = {
          panel: !!panelEl,
          width: box ? Math.round(box.width) : 0,
          height: box ? Math.round(box.height) : 0,
          cards: panelEl ? panelEl.querySelectorAll('[data-fisherai-cloud-channel]').length : 0,
          dialectOptions: select ? select.options.length : 0,
          dialectValue: select ? select.value : '(missing)',
          dialectHint: select && select.parentElement
            ? String(select.parentElement.textContent || '').replace(/\\s+/g, ' ').slice(0, 220)
            : '',
          presetLabels: presets.map(function (node) {
            return String(node.textContent || '').trim();
          }),
          text: panelEl ? String(panelEl.innerText || '').replace(/\\s+/g, ' ').slice(0, 320) : '',
        };
        return;
      }
      if (dataDirScene) {
        // 只切到「存储」，等我们那块「项目数据目录」面板挂上，然后停在那一屏（截图 = 交付图）
        const tab = dialog.querySelector('[data-fisherai-settings-section="storage"]');
        if (tab) tab.click();
        await until(() => dialog.querySelector('[data-fisherai-data-dir="panel"]'), 10000);
        await wait(900);
        const panelEl = dialog.querySelector('[data-fisherai-data-dir="panel"]');
        if (panelEl) panelEl.scrollIntoView({ block: 'center' });
        await wait(500);
        const box = panelEl ? panelEl.getBoundingClientRect() : null;
        settingsProbe.dataDirShot = {
          panel: !!panelEl,
          current: String(
            dialog.querySelector('[data-fisherai-data-dir-current]')?.textContent || '',
          ),
          defaultDir: String(
            dialog.querySelector('[data-fisherai-data-dir-default]')?.textContent || '',
          ),
          status: String(
            dialog.querySelector('[data-fisherai-data-dir-status]')?.textContent || '',
          ),
          overridden: panelEl ? panelEl.getAttribute('data-fisherai-data-dir-overridden') : null,
          restart: panelEl ? panelEl.getAttribute('data-fisherai-data-dir-restart') : null,
          input: String(dialog.querySelector('[data-fisherai-data-dir-input]')?.value || ''),
          applyLabel: dialog
            .querySelector('[data-fisherai-data-dir-apply]')
            ? String(dialog.querySelector('[data-fisherai-data-dir-apply]').textContent || '')
            : null,
          resetDisabled: dialog.querySelector('[data-fisherai-data-dir-reset]')?.disabled ?? null,
          width: box ? Math.round(box.width) : 0,
          height: box ? Math.round(box.height) : 0,
          text: panelEl ? String(panelEl.innerText || '').replace(/\\s+/g, ' ').slice(0, 240) : '',
        };
        return;
      }
      if (effectsScene) {
        // 只切到「画布外观」，等我们那块面板挂上，然后停在这一屏（页面最后一次状态 = 截图）
        const tab = dialog.querySelector('[data-fisherai-settings-section="appearance"]');
        if (tab) tab.click();
        await until(() => dialog.querySelector('[data-fisherai-canvas-effect="pointer-glow"]'), 8000);
        await wait(600);
        const panelEl = dialog.querySelector('[data-fisherai-canvas-effects]');
        const sw = dialog.querySelector('[data-fisherai-canvas-effect="pointer-glow"]');
        // 那块面板排在 vendor 的「界面主题 / 画布背景」之后，要滚到可见处截图里才看得见
        if (panelEl) panelEl.scrollIntoView({ block: 'center' });
        await wait(500);
        const box = panelEl ? panelEl.getBoundingClientRect() : null;
        settingsProbe.effectsShot = {
          panel: !!panelEl,
          switchLabel: sw ? sw.getAttribute('aria-label') : null,
          role: sw ? sw.getAttribute('role') : null,
          ariaChecked: sw ? sw.getAttribute('aria-checked') : null,
          state: panelEl ? panelEl.getAttribute('data-fisherai-canvas-effect-state') : null,
          width: box ? Math.round(box.width) : 0,
          height: box ? Math.round(box.height) : 0,
          text: panelEl ? String(panelEl.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) : '',
        };
        return;
      }
      for (const id of ['appearance', 'local-service', 'models', 'storage']) {
        const tab = dialog.querySelector('[data-fisherai-settings-section="' + id + '"]');
        if (!tab) {
          settingsProbe.sections[id] = { missingTab: true };
          continue;
        }
        tab.click();
        // 「开源服务」那一页要等 host 探本机（nvidia-smi + ComfyUI /object_info，冷启动能到几秒），
        // 固定等 1.8s 会在 ComfyUI 忙的时候闪成「检测中…」→ 改成轮询到真出现为止（最多 12s）
        if (id === 'local-service') {
          await until(() => readSection(dialog, id).comfyHeading === true, 12000);
        }
        await wait(1800);
        settingsProbe.sections[id] = readSection(dialog, id);
        /**
         * v1.27：「画布互动」开关。真机点一次，验三件事 —— 开关自己的 aria-checked 变了、
         * 画布网格层同步变 off（store → 网格层的订阅通路）、状态落进本机 localStorage。
         * 验完再点回来（后面的截图与其它场景都要看到互动着的画布）。
         */
        if (id === 'appearance') {
          const sw = dialog.querySelector('[data-fisherai-canvas-effect="pointer-glow"]');
          const panelState = () =>
            dialog
              .querySelector('[data-fisherai-canvas-effects]')
              ?.getAttribute('data-fisherai-canvas-effect-state') ?? null;
          const gridAttr = () =>
            document
              .querySelector('[data-canvas-grid="true"]')
              ?.getAttribute('data-canvas-grid-interactive') ?? null;
          const before = sw ? sw.getAttribute('aria-checked') : null;
          if (sw) sw.click();
          await wait(400);
          const stored = (() => {
            try {
              return window.localStorage.getItem('dsh-aifisher-canvas.canvas-effects');
            } catch (error) {
              return String(error);
            }
          })();
          settingsProbe.effects = {
            before: before,
            after: sw ? sw.getAttribute('aria-checked') : null,
            panelState: panelState(),
            grid: gridAttr(),
            stored: stored,
          };
          if (sw) sw.click();
          await wait(300);
          settingsProbe.effects.restored = sw ? sw.getAttribute('aria-checked') : null;
        }
        // 「OpenAI 通道」面板（v1.11）：它由 vendor 设置页那一行补丁调我们的全局挂上去，
        // 所以这里顺手点一次「+ 添加通道」，验它真的能长出一张通道卡片（纯前端草稿，不发请求）。
        if (id === 'models') {
          const panel = dialog.querySelector('[data-fisherai-cloud-channels]');
          const add = panel ? panel.querySelector('button') : null;
          const before = dialog.querySelectorAll('[data-fisherai-cloud-channel]').length;
          if (add) {
            add.click();
            await wait(500);
          }
          settingsProbe.channels = {
            panel: !!panel,
            addLabel: add ? String(add.textContent || '').trim().slice(0, 20) : '',
            before: before,
            after: dialog.querySelectorAll('[data-fisherai-cloud-channel]').length,
          };
          /**
           * 「请求方言」探针（v1.29）：参考图字段分歧（openai 用 image / 魔搭认 image_url）
           * 配错时**不报错、只把参考图丢掉**，所以那个下拉与它下面那行「自动当前判成了什么」
           * 必须真在页面上、真的按地址判出来 —— 这里读的就是那两处真 DOM。
           * ⚠️ 这段在 HOST_PAGE 模板字符串里：注释里不能出现反引号（会提前结束模板）。
           */
          const dialectSelect = panel ? panel.querySelector('[data-fisherai-channel-dialect]') : null;
          const presetButton = panel ? panel.querySelector('[data-fisherai-channel-preset]') : null;
          const presetButtons = panel
            ? Array.prototype.slice.call(panel.querySelectorAll('[data-fisherai-channel-preset]'))
            : [];
          settingsProbe.channelDialect = {
            selectPresent: !!dialectSelect,
            value: dialectSelect ? dialectSelect.value : '(missing)',
            optionCount: dialectSelect ? dialectSelect.options.length : 0,
            selectWidth: dialectSelect ? Math.round(dialectSelect.getBoundingClientRect().width) : 0,
            hintText: dialectSelect && dialectSelect.parentElement
              ? String(dialectSelect.parentElement.textContent || '').replace(/\\s+/g, ' ').slice(0, 160)
              : '(missing)',
            presetPresent: !!presetButton,
            presetLabel: presetButton ? String(presetButton.textContent || '').trim() : '(missing)',
            presetLabels: presetButtons.map(function (node) {
              return String(node.textContent || '').trim();
            }),
          };
          /**
           * 模型行布局探针（v1.12）：预置那条通道有一张 2 条模型的卡，卡片上的「模型（2）」
           * 默认是收起的，点开后才渲染行。这里量的是**真浏览器布局**：
           * 模型名 span 的宽度、类型下拉的宽度、别名输入框的值。
           */
          const toggle = panel
            ? panel.querySelector('[data-fisherai-channel-models-toggle]')
            : null;
          if (toggle) {
            toggle.click();
            await wait(700);
          }
          const rowsAll = dialog.querySelectorAll('[data-fisherai-channel-model-row]');
          const rows = Array.prototype.slice.call(rowsAll);
          const findRow = (mid) => rows.find((row) => row.getAttribute('data-fisherai-channel-model-row') === mid) || null;
          const nameOf = (mid) => {
            const row = findRow(mid);
            return row ? row.querySelector('[data-fisherai-channel-model-id="' + mid + '"]') : null;
          };
          const kindOf = (mid) => {
            const row = findRow(mid);
            return row ? row.querySelector('[data-fisherai-channel-model-kind="' + mid + '"]') : null;
          };
          const aliasOf = (mid) => {
            const row = findRow(mid);
            return row ? row.querySelector('[data-fisherai-channel-model-label="' + mid + '"]') : null;
          };
          const widthOf = (node) => (node ? Math.round(node.getBoundingClientRect().width) : 0);
          // ⚠️ 这两个常量由 **Node 侧插值**进来（HOST_PAGE 是模板字符串）：写成裸标识符会在
          //    页面里报 CHANNEL_FIXTURE is not defined，于是页面脚本中断、探针一次都发不出去。
          const ALIAS_ID = '${CHANNEL_FIXTURE.aliasModelId}';
          const PLAIN_ID = '${CHANNEL_FIXTURE.plainModelId}';
          settingsProbe.channelModels = {
            rows: rows.length,
            aliasName: nameOf(ALIAS_ID) ? String(nameOf(ALIAS_ID).textContent) : '(missing)',
            aliasNameWidth: widthOf(nameOf(ALIAS_ID)),
            plainName: nameOf(PLAIN_ID) ? String(nameOf(PLAIN_ID).textContent) : '(missing)',
            plainNameWidth: widthOf(nameOf(PLAIN_ID)),
            kindWidth: widthOf(kindOf(ALIAS_ID)),
            aliasValue: aliasOf(ALIAS_ID) ? aliasOf(ALIAS_ID).value : '(missing)',
            aliasEnabled: !!aliasOf(ALIAS_ID) && aliasOf(ALIAS_ID).disabled === false,
            plainAliasValue: aliasOf(PLAIN_ID) ? aliasOf(PLAIN_ID).value : '(missing)',
          };
        }
      }
      // 截图留的是**最后停在哪一页**：这里再切回「闭源服务」，让截图正好是 v1.11 的通道面板
      const modelsTab = dialog.querySelector('[data-fisherai-settings-section="models"]');
      if (modelsTab) {
        modelsTab.click();
        await wait(1200);
      }
    };
    await walkSettings();

    /**
     * 右侧对话面板场景（?chat=1）：真点启动球 → 打开面板 → 在 composer 里打字发送。
     *
     * 这一场验的是「聊天框控制画布」这条链的**真机表现**：面板是否贴在画布右缘
     * （vendor 的 fixed→absolute 补丁）、启动球会不会压住「退出画布」按钮、
     * 发出去的消息能不能拿到回答（面板 → host 路由 → DSH 会话 → SSE → 回填）。
     * 会话与流式正文由脚本里的宿主假件提供（见 chatStub）。
     */
    const chatScene = new URLSearchParams(location.search).get('chat') === '1';
    const chatPanelState = {
      opened: false,
      launcherPresent: false,
      sendEnabled: false,
      sent: false,
      replyText: '',
    };
    const openChatPanel = async () => {
      if (!chatScene) return;
      await wait(1600);
      const launcher = mount.querySelector('[data-fisherai-agent-launcher="true"]');
      chatPanelState.launcherPresent = !!launcher;
      if (!launcher) return;
      launcher.click();
      await wait(900);
      const panel = mount.querySelector('[data-fisherai-agent-panel="true"]');
      chatPanelState.opened = !!panel;
      if (!panel) return;
      const composer = panel.querySelector('textarea');
      if (!composer) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(composer, '帮我在画布上建一个文本节点');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(400);
      // 发送按钮的无障碍名带品牌前缀（上游是「发送给 AIFISHER Agent」，2026-10-25 起
      // 是「发送给 渡雨鸣泽 Agent」），所以按前缀匹配，改品牌名不会再打断这条链路。
      const send = panel.querySelector('[aria-label^="发送给"]');
      chatPanelState.sendEnabled = !!send && send.disabled === false;
      if (send && !send.disabled) {
        send.click();
        chatPanelState.sent = true;
        await wait(2500);
      }
      chatPanelState.replyText = String(panel.innerText || '').replace(/\\s+/g, ' ').slice(0, 400);
    };
    await openChatPanel();

    const chatPanelProbe = () => {
      if (!chatScene) return null;
      const launcher = mount.querySelector('[data-fisherai-agent-launcher="true"]');
      const panel = mount.querySelector('[data-fisherai-agent-panel="true"]');
      const exit = document.querySelector('[data-dsh-aifisher-exit="canvas"]');
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left),
          top: Math.round(r.top),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      };
      const mountRect = mount.getBoundingClientRect();
      const panelBox = box(panel);
      const launcherBox = box(launcher);
      const exitBox = box(exit);
      const overlaps = (a, b) =>
        !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return {
        ...chatPanelState,
        // 回答是流式回填的：chatPanelState.replyText 只是「发完那一刻的快照」——
        // 每次都重新读一遍面板正文，否则「回答比那 2.5s 窗口晚到一点」就会让等就绪的
        // waitForProbe 一直看着旧快照超时（现象是「没收到页面探针」，但截图里答案是有的）。
        // ⚠️ 这段注释在宿主页模板字面量里：**不能出现反引号**（会提前结束模板串）。
        replyText: String(panel?.innerText ?? chatPanelState.replyText)
          .replace(/\\s+/g, ' ')
          .slice(0, 400),
        panelBox,
        mountRight: Math.round(mountRect.right),
        mountLeft: Math.round(mountRect.left),
        dockedRight: !!panelBox && Math.abs(panelBox.right - Math.round(mountRect.right)) <= 3,
        widthLooksRight: !!panelBox && panelBox.width >= 240 && panelBox.width <= 640,
        panelInsideCanvas:
          !!panelBox &&
          panelBox.left >= Math.round(mountRect.left) - 2 &&
          panelBox.right <= Math.round(mountRect.right) + 3,
        launcherAboveExit: !overlaps(launcherBox, exitBox),
        text: String(panel?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 300),
      };
    };

    /**
     * 鼠标提亮的**视觉**取证（?xglow=1 场景）：
     * 探针本身不会把鼠标移到画布上，所以普通截图里看不到「周围圆形变亮」。
     * 这一支把提亮圆心钉在**左下那块空白画布**上（本地 ≈ (0.17w, 0.69h)），
     * 截图里那一块明显更亮 —— 供人眼核对。
     *
     * ⚠️ 必须**每次探针 tick 都重钉一次**（见 leakReport 里的调用）：① 页面刚加载时
     * 画布产物还在动态 import，网格层根本没挂上，一次性执行等于什么都没做（v1.7 的
     * glow 截图就是这么废掉的）；② 网格探针自己会派发 pointerleave 把圆心复位。
     * 参数名特意带 x 前缀：vendor 那边认 wf/glow 之类短参数来切场景，别撞上。
     */
    const glowScene = new URLSearchParams(location.search).get('xglow') === '1';
    const pinGlow = () => {
      if (!glowScene) return;
      const glowCanvas = document.getElementById('canvas-background');
      const glowLayer = glowCanvas?.querySelector('[data-canvas-grid="true"]');
      if (!glowCanvas || !glowLayer) return;
      const glowHighlight = glowLayer.querySelector('.canvas-grid-cross.is-highlight');
      const box = glowCanvas.getBoundingClientRect();
      glowLayer.style.setProperty('--canvas-grid-mx', Math.round(box.width * 0.17) + 'px');
      glowLayer.style.setProperty('--canvas-grid-my', Math.round(box.height * 0.69) + 'px');
      glowLayer.style.setProperty('--canvas-grid-mr', '190px');
      if (glowHighlight) glowHighlight.style.opacity = '1';
    };

    /**
     * 任务队列场景（?tasks=1，v1.24）：画布右侧面板 + 「运行中那行边框循环发光」。
     *
     * 真机上要验的四件事（jsdom 全都验不了或只能验一半）：
     *   ① 面板真的贴在**画布**右缘（不是整个 DSH 窗口右缘）、宽度正常；
     *   ② 运行中那行命中了发光动画 —— 读的是 computedStyle 的 animationName /
     *      animationDuration / iterationCount，以及 ::before 那层流光；
     *   ③ 「用时」真的在跳（隔 700ms 采两次 data-fisherai-task-elapsed-ms）；
     *   ④ 同一面板里已完成的行显示「用时 + N 个结果」。
     *
     * ⚠️ 那两条任务由**脚本（Node 侧）**在开浏览器之前就发出去，页面里只负责量。
     *    为什么：headless 的「--virtual-time-budget」是「有网络请求没落地就暂停虚拟时间」，
     *    页面里要是自己发起一条**永不返回**的慢请求，整个页面的定时器都会冻住 ——
     *    探针一次都发不出来（现象：截图看着正常，但报「没收到页面探针」）。
     *    把慢请求留在 Node 进程里，页面这边所有 fetch 都是瞬时的。
     */
    const taskQueueScene = new URLSearchParams(location.search).get('tasks') === '1';
    const taskQueueSteps = { done: false };
    const taskQueuePanelEl = () => document.querySelector('[data-fisherai-task-queue="panel"]');
    const taskQueueRow = (status) =>
      document.querySelector('[data-fisherai-task-queue-item][data-fisherai-task-status="' + status + '"]');
    const elapsedOf = (row) =>
      Number(
        row?.querySelector('[data-fisherai-task-elapsed-ms]')
          ?.getAttribute('data-fisherai-task-elapsed-ms') ?? 0,
      );
    const buildTaskQueueScene = async () => {
      if (!taskQueueScene) return;
      try {
        const panel = await until(taskQueuePanelEl, 20000);
        if (!panel) {
          taskQueueSteps.error = 'no panel';
          taskQueueSteps.done = true;
          return;
        }
        const canvasEl = document.querySelector('.af-canvas-mount') ?? mount;
        const canvasBox = canvasEl.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        taskQueueSteps.panel = {
          width: Math.round(panelBox.width),
          height: Math.round(panelBox.height),
          gapRight: Math.round(canvasBox.right - panelBox.right),
          // v1.36：用户要求「任务队列往上移」—— 现在贴画布右上角 top:8（以前 60）。
          gapTop: Math.round(panelBox.top - canvasBox.top),
          insideCanvas: mount.contains(panel),
          label: panel.getAttribute('aria-label') || '',
          text: String(panel.textContent || '').slice(0, 80),
        };
        const runningRow = await until(() => taskQueueRow('running'), 20000);
        if (!runningRow) {
          taskQueueSteps.error = 'no running row（Node 侧的慢任务没起来？）';
          taskQueueSteps.done = true;
          return;
        }
        const rowStyle = getComputedStyle(runningRow);
        const beforeStyle = getComputedStyle(runningRow, '::before');
        const dotStyle = getComputedStyle(
          runningRow.querySelector('[data-fisherai-task-dot]'),
        );
        taskQueueSteps.running = {
          animationName: String(rowStyle.animationName || ''),
          animationDuration: String(rowStyle.animationDuration || ''),
          animationIterationCount: String(rowStyle.animationIterationCount || ''),
          boxShadow: String(rowStyle.boxShadow || '').slice(0, 90),
          beforeAnimationName: String(beforeStyle.animationName || ''),
          beforeDuration: String(beforeStyle.animationDuration || ''),
          beforeHasGradient: String(beforeStyle.backgroundImage || '').indexOf('linear-gradient') >= 0,
          beforeMaskComposite: String(
            beforeStyle.maskComposite || beforeStyle.webkitMaskComposite || '',
          ),
          dotAnimationName: String(dotStyle?.animationName || ''),
          text: String(runningRow.textContent || '').slice(0, 220),
          elapsed: elapsedOf(runningRow),
          hasTimes: String(runningRow.textContent || '').indexOf(':') >= 0,
        };
        await wait(700);
        taskQueueSteps.runningElapsedAfter = elapsedOf(taskQueueRow('running'));
        // 已完成那条（Node 侧在开浏览器前就发完了 Fast 模型）
        const doneRow = await until(
          () => document.querySelector('[data-fisherai-task-queue-item="att-tq-fast"]'),
          20000,
        );
        taskQueueSteps.doneRow = {
          status: doneRow?.getAttribute('data-fisherai-task-status') || '',
          text: String(doneRow?.textContent || '').slice(0, 220),
        };
        taskQueueSteps.headerText = String(panel.textContent || '').slice(0, 40);
      } catch (error) {
        taskQueueSteps.error = String((error && error.stack) || error);
      }
      taskQueueSteps.done = true;
    };

    /**
     * 「任务队列只在画布这一层」（?qlayers=1，v1.41）。
     *
     * 用户 2026-10-18 原话：「任务队列希望只出现在画布这一层，现在点击设置啥的都看的见任务队列」。
     * 这里量的是 jsdom 量不到的两件事：
     *   ① 设置打开时面板是不是真的 display:none（jsdom 没有 CSS 引擎，只能验 inert 属性）；
     *   ② 面板原来那块像素现在归谁（elementFromPoint 不再命中队列 = 没有浮在设置上面）。
     * 顺带守「关掉设置后面板会回来」（纯 CSS 护栏不能把面板永久藏掉）。
     */
    const queueLayerScene = new URLSearchParams(location.search).get('qlayers') === '1';
    const queueLayerSteps = { done: false };
    const queueLayerReport = () => {
      const panel = document.querySelector('[data-fisherai-task-queue="panel"]');
      if (!panel) return null;
      const box = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      const hit = document.elementFromPoint(
        Math.round(box.left + box.width / 2),
        Math.round(box.top + 16),
      );
      return {
        display: String(style.display || ''),
        inert: panel.hasAttribute('inert'),
        width: Math.round(box.width),
        height: Math.round(box.height),
        hitInsideQueue: Boolean(hit && panel.contains(hit)),
        hit: hit ? hit.tagName.toLowerCase() : null,
        settingsOpen: Boolean(document.querySelector('[data-fisherai-settings="true"]')),
      };
    };
    const buildQueueLayerScene = async () => {
      if (!queueLayerScene) return;
      try {
        await until(() => document.querySelector('[data-fisherai-task-queue="panel"]'), 20000);
        await wait(1200);
        queueLayerSteps.before = queueLayerReport();
        window.dispatchEvent(new CustomEvent('fisherai:open-settings'));
        const dialog = await until(
          () => document.querySelector('[data-fisherai-settings="true"]'),
          10000,
        );
        if (!dialog) {
          queueLayerSteps.error = 'no settings dialog';
          queueLayerSteps.done = true;
          return;
        }
        await wait(700);
        queueLayerSteps.during = queueLayerReport();
        // 截图取证：停在「设置 → 画布外观」这一屏（任务队列的位置就在右上角，一眼能看出来）
        const tab = dialog.querySelector('[data-fisherai-settings-section="appearance"]');
        if (tab) tab.click();
        await wait(900);
        queueLayerSteps.duringAppearance = queueLayerReport();
      } catch (error) {
        queueLayerSteps.error = String((error && error.stack) || error);
      }
      queueLayerSteps.done = true;
    };

    /**
     * # 项目归档（?xarchive=1，v1.42）
     *
     * 用户 2026-10-18 原话：「在无限画布面板做一个项目导出导入的功能」。
     *
     * jsdom 已经把「面板接线 + 真上传导入 + 从路径导入 + 看板导入」全跑过了；
     * 这一场只补真机才量的出来的三件事：
     *   ① 头部那个「项目归档」图标按钮**真的能点**（elementFromPoint 命中它自己 ——
     *      头部被画布底盘盖住那类 bug 只有真机能看出来）；
     *   ② 面板在真布局里放得下、在画布区域内（不是被裁到屏幕外），且规模读数是真数字；
     *   ③ 点「导出到目录」→ host 真落盘（node 侧镜头外去数 downloads 里的文件并解开归档核对素材）。
     * 截图停在「面板 + 导出成功提示」，就是交付图。
     *
     * 注意：这一段是写进宿主页 <script> 的**模板字符串**内容，注释里不能出现反引号，
     *      否则会把外层模板串提前截断（报 SyntaxError: Unexpected identifier）。
     */
    const archiveScene = new URLSearchParams(location.search).get('xarchive') === '1';
    const archiveSteps = { done: false };
    const archiveReport = () => {
      const panel = document.querySelector('[data-fisherai-project-archive="panel"]');
      if (!panel) return null;
      const box = panel.getBoundingClientRect();
      const notice = document.querySelector('[data-fisherai-project-archive-notice]');
      const info = document.querySelector('[data-fisherai-project-archive-info]');
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        left: Math.round(box.left),
        top: Math.round(box.top),
        insideViewport:
          box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
        info: String(info ? info.textContent || '' : ''),
        dir: String(document.querySelector('[data-fisherai-project-archive-dir]')?.value || ''),
        noticeKind: notice ? notice.getAttribute('data-fisherai-project-archive-notice') : null,
        notice: String(notice ? notice.textContent || '' : ''),
        exportButtons: document.querySelectorAll('[data-fisherai-project-archive-export]').length,
      };
    };
    const buildArchiveScene = async () => {
      if (!archiveScene) return;
      try {
        const trigger = await until(
          () => document.querySelector('[data-fisherai-project-archive-trigger]'),
          20000,
        );
        if (!trigger) {
          archiveSteps.error = 'no archive trigger in header';
          archiveSteps.done = true;
          return;
        }
        const box = trigger.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(box.top + box.height / 2),
        );
        archiveSteps.trigger = {
          label: String(trigger.getAttribute('aria-label') || ''),
          width: Math.round(box.width),
          height: Math.round(box.height),
          onTop: Boolean(hit && (hit === trigger || trigger.contains(hit))),
          hit: hit ? hit.tagName.toLowerCase() : null,
        };
        trigger.click();
        const panel = await until(
          () => document.querySelector('[data-fisherai-project-archive="panel"]'),
          10000,
        );
        if (!panel) {
          archiveSteps.error = 'no archive panel after click';
          archiveSteps.done = true;
          return;
        }
        // 等规模读数落地（它是一次 /backup/info 请求）
        await until(() => {
          const info = document.querySelector('[data-fisherai-project-archive-info]');
          return info && /个节点/.test(String(info.textContent || ''));
        }, 12000);
        await wait(400);
        archiveSteps.opened = archiveReport();
        const exportButton = document.querySelector('[data-fisherai-project-archive-export]');
        archiveSteps.buttonBox = exportButton
          ? (() => {
              const r = exportButton.getBoundingClientRect();
              return { width: Math.round(r.width), height: Math.round(r.height) };
            })()
          : null;
        if (exportButton) exportButton.click();
        await until(() => {
          const notice = document.querySelector('[data-fisherai-project-archive-notice="ok"]');
          return notice ? true : null;
        }, 15000);
        await wait(400);
        archiveSteps.exported = archiveReport();
        archiveSteps.report = window.__FISHERAI_PROJECT_ARCHIVE__?.report?.() ?? null;
      } catch (error) {
        archiveSteps.error = String((error && error.stack) || error);
      }
      archiveSteps.done = true;
    };

    /**
     * 图片编辑 / 标注场景（?xedit=studio|annotate，v1.26）：
     *
     * 用户 2026-10-17 的原话：「点击保存为新图片没有添加到画布里。还有这里的图像编辑的
     * ui 美化还没有补全」（附了两张截图：图片编辑首页 / 标注工具条）。
     *
     * 这一场在**真浏览器**里把那条链路整条走完 —— 这些事 jsdom 全都验不了
     * （不解码图片、没有布局引擎、canvas.getContext 为 null）：
     *   ① 选中带结果图的节点 → 工具条点「图片编辑」→ nova 工作台真的全屏铺在画布上；
     *   ② 量工具按钮、头部/底栏高度、保存按钮禁用态（没应用编辑时不能存）；
     *   ③ 在裁剪画布上**真拖一个框**（pointerdown/move/up）→ 选区读数出现 → 应用裁剪；
     *   ④ 点「保存为新图片」→ POST /assets/images 落盘 → 画布上真的多出一个带
     *      '/api/aifisher/canvas/media/...' 图片地址的新节点（这就是用户报的那个 bug）；
     *   ⑤ 再打开一次工作台，截图停在新 UI 上；annotate 那场停在蒙版舞台（还画了一笔）。
     */
    const editScene = new URLSearchParams(location.search).get('xedit') || '';
    const imageEditorSteps = { done: false, mode: editScene };
    const editFrame = () => document.querySelector('[data-node-id="node-edit-source"]');
    const firePointerOn = (target, type, x, y) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          pointerId: 21,
          pointerType: 'mouse',
          isPrimary: true,
        }),
      );
    const selectEditNode = async () => {
      const frame = editFrame();
      if (!frame) return false;
      const box = frame.getBoundingClientRect();
      const x = Math.round(box.left + Math.min(80, box.width / 2));
      const y = Math.round(box.top + Math.min(28, box.height / 2));
      firePointerOn(frame, 'pointerdown', x, y);
      firePointerOn(frame, 'pointerup', x, y);
      frame.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
      await wait(600);
      return frame.getAttribute('data-node-selected') === 'true';
    };
    const openImageEditor = async () => {
      const toolbar = await until(
        () => document.querySelector('[data-fisherai-media-toolbar]'),
        10000,
      );
      const button =
        toolbar &&
        [...toolbar.querySelectorAll('button')].find(
          (node) => (node.getAttribute('aria-label') || '') === '图片编辑',
        );
      if (!button) return false;
      button.click();
      return !!(await until(
        () => document.querySelector('[data-fisherai-image-studio="editor"]'),
        10000,
      ));
    };
    const buildImageEditorScene = async () => {
      // xedit=saved 只用来回看「保存之后画布上多了个节点」，不跑交互
      if (!editScene || editScene === 'saved') return;
      /**
       * 宫格裁剪（v1.46，?xedit=grid）：用户「画布宫格裁剪ui还没有更新」的真机回归。
       *
       *  ① 工具条「宫格裁剪」→ nova 版宫格舞台（不是 vendor 的整屏 role=dialog aria-label=裁切图片）；
       *  ② 舞台铺满画布、图片解码成功（画布 > 100px）、默认 2×2 = 4 格；
       *  ③ **真拖第一条竖向切线**（pointerdown/move/up）→ 单格尺寸读数必须变；
       *  ④ 点 3×3 预设 → 张数变 9；导出序号填 1,3 → 张数变 2；
       *  ⑤ 保存 → 画布上多出 2 个带 /api/aifisher/canvas/media/ 结果图的节点；
       *  ⑥ 再打开一次宫格舞台，截图停在 nova 版界面上（交付图）。
       */
      if (editScene === 'grid') {
        try {
          await wait(900);
          imageEditorSteps.selected = await selectEditNode();
          const toolbar = await until(
            () => document.querySelector('[data-fisherai-media-toolbar]'),
            10000,
          );
          const open = toolbar
            ? [...toolbar.querySelectorAll('button')].find(
                (node) => (node.getAttribute('aria-label') || '') === '宫格裁剪',
              )
            : null;
          if (!open) throw new Error('工具条里没有「宫格裁剪」');
          open.click();
          const stage = await until(
            () => document.querySelector('[data-fisherai-image-workbench="grid"]'),
            10000,
          );
          if (!stage) throw new Error('宫格裁剪舞台没打开');
          await wait(700);
          const mountBox = document.querySelector('.af-canvas-mount').getBoundingClientRect();
          const stageBox = stage.getBoundingClientRect();
          const canvas = stage.querySelector('[data-fisherai-crop-canvas]');
          const canvasBox = canvas.getBoundingClientRect();
          const headerBox = stage.querySelector('header').getBoundingClientRect();
          const footerBox = stage.querySelector('footer').getBoundingClientRect();
          const presets = [...stage.querySelectorAll('[data-fisherai-grid-crop-preset]')];
          const cellValue = () =>
            String(stage.querySelector('[data-fisherai-grid-crop-cell]')?.textContent || '');
          imageEditorSteps.grid = {
            stage: true,
            coversCanvas:
              Math.abs(stageBox.width - mountBox.width) <= 2 &&
              Math.abs(stageBox.height - mountBox.height) <= 2,
            width: Math.round(stageBox.width),
            height: Math.round(stageBox.height),
            headerHeight: Math.round(headerBox.height),
            footerHeight: Math.round(footerBox.height),
            canvasWidth: Math.round(canvasBox.width),
            canvasHeight: Math.round(canvasBox.height),
            presets: presets.length,
            presetsInside: presets.every((node) => {
              const box = node.getBoundingClientRect();
              return (
                box.left >= Math.round(mountBox.left) && box.right <= Math.round(mountBox.right)
              );
            }),
            countText: String(
              stage.querySelector('[data-fisherai-grid-crop-count]')?.textContent || '',
            ),
            cellBefore: cellValue(),
            saveText: String(
              stage.querySelector('[data-fisherai-image-save="grid"]')?.textContent || '',
            ),
            vendorDialog: !!document.querySelector('[role="dialog"][aria-label="裁切图片"]'),
            sliders: stage.querySelectorAll('[data-slot="slider"]').length,
            ratios: stage.querySelectorAll('[data-fisherai-grid-crop-ratio]').length,
            orders: stage.querySelectorAll('[data-fisherai-grid-crop-order]').length,
          };
          if (canvasBox.width < 40 || canvasBox.height < 40) {
            imageEditorSteps.error = '宫格画布没量到尺寸（图片没加载？）';
            imageEditorSteps.done = true;
            return;
          }
          // ③ 真拖第一条竖向切线（2×2 默认等分 → 切线正好在画布中央）
          const cutX = Math.round(canvasBox.left + canvasBox.width / 2);
          const cutY = Math.round(canvasBox.top + canvasBox.height / 2);
          firePointerOn(canvas, 'pointerdown', cutX, cutY);
          firePointerOn(canvas, 'pointermove', cutX + 26, cutY);
          firePointerOn(canvas, 'pointerup', cutX + 26, cutY);
          await wait(350);
          imageEditorSteps.grid.cellAfterDrag = cellValue();
          // ④ 3×3 预设 + 导出序号 1,3
          stage.querySelector('[data-fisherai-grid-crop-preset="3x3"]')?.click();
          await wait(300);
          imageEditorSteps.grid.countAfterPreset = String(
            stage.querySelector('[data-fisherai-grid-crop-count]')?.textContent || '',
          );
          imageEditorSteps.grid.saveTextAfterPreset = String(
            stage.querySelector('[data-fisherai-image-save="grid"]')?.textContent || '',
          );
          const selection = stage.querySelector('[data-fisherai-grid-crop-selection]');
          if (selection) {
            // React 19 会接管 input.value 的 setter：直接赋值再派发 input 不会进 state，
            // 必须走原型上的原生 setter（与 scripts/browser-check 里别处改受控输入同一手法）。
            const setValue = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              'value',
            ).set;
            setValue.call(selection, '1,3');
            selection.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(300);
          }
          imageEditorSteps.grid.countAfterSelection = String(
            stage.querySelector('[data-fisherai-grid-crop-count]')?.textContent || '',
          );
          imageEditorSteps.grid.saveTextAfterSelection = String(
            stage.querySelector('[data-fisherai-image-save="grid"]')?.textContent || '',
          );
          // ⑤ 保存 → 画布上多节点（每格一张）
          // 注意：本场景与 image-editor / image-annotate 共用同一个项目，
          // 全量跑时画布上已经有前面两场存下的图 —— 这里只认「这一次新增」的节点
          // （按节点 id 差集，不能拿全量 img 数当断言，否则全量跑必红、单跑才绿）。
          const beforeIds = new Set(
            [...document.querySelectorAll('[data-node-id]')].map((node) =>
              node.getAttribute('data-node-id'),
            ),
          );
          const before = beforeIds.size;
          const saveButton = stage.querySelector('[data-fisherai-image-save="grid"]');
          imageEditorSteps.grid.saveEnabled = !!saveButton && !saveButton.disabled;
          if (saveButton) saveButton.click();
          const added = await until(() => {
            const frames = [...document.querySelectorAll('[data-node-id]')];
            return frames.length > before ? frames : null;
          }, 20000);
          imageEditorSteps.grid.saved = {
            nodeCountBefore: before,
            nodeCountAfter: document.querySelectorAll('[data-node-id]').length,
            stageClosed: !document.querySelector('[data-fisherai-image-workbench="grid"]'),
            imageSrcs: added
              ? added
                  .filter(
                    (node) => !beforeIds.has(node.getAttribute('data-node-id')),
                  )
                  .map((node) => String(node.querySelector('img')?.getAttribute('src') || ''))
              : [],
          };
          // ⑥ 再打开一次（截图停在 nova 版宫格舞台上）
          await wait(500);
          await selectEditNode();
          const again = await until(
            () => document.querySelector('[data-fisherai-media-toolbar]'),
            10000,
          );
          const openAgain = again
            ? [...again.querySelectorAll('button')].find(
                (node) => (node.getAttribute('aria-label') || '') === '宫格裁剪',
              )
            : null;
          openAgain?.click();
          imageEditorSteps.grid.reopened = !!(await until(
            () => document.querySelector('[data-fisherai-image-workbench="grid"]'),
            10000,
          ));
        } catch (error) {
          imageEditorSteps.error = String((error && error.stack) || error);
        }
        imageEditorSteps.done = true;
        return;
      }
      try {
        await wait(900);
        imageEditorSteps.selected = await selectEditNode();
        imageEditorSteps.opened = await openImageEditor();
        const studio = await until(
          () => document.querySelector('[data-fisherai-image-studio="editor"]'),
          10000,
        );
        if (!studio) {
          imageEditorSteps.error = '没打开图片编辑工作台';
          imageEditorSteps.done = true;
          return;
        }
        const mountEl = document.querySelector('.af-canvas-mount');
        const mountBox = mountEl.getBoundingClientRect();
        const studioBox = studio.getBoundingClientRect();
        const headBox = studio.querySelector('header').getBoundingClientRect();
        const footBox = studio.querySelector('footer').getBoundingClientRect();
        const tools = [...studio.querySelectorAll('[data-fisherai-image-tool]')].map((node) => {
          const box = node.getBoundingClientRect();
          return {
            tool: node.getAttribute('data-fisherai-image-tool'),
            width: Math.round(box.width),
            height: Math.round(box.height),
            left: Math.round(box.left),
            right: Math.round(box.right),
            disabled: !!node.disabled,
          };
        });
        const saveStudio = () => document.querySelector('[data-fisherai-image-save="studio"]');
        imageEditorSteps.studio = {
          coversCanvas:
            Math.abs(studioBox.width - mountBox.width) <= 2 &&
            Math.abs(studioBox.height - mountBox.height) <= 2,
          width: Math.round(studioBox.width),
          height: Math.round(studioBox.height),
          headerHeight: Math.round(headBox.height),
          footerHeight: Math.round(footBox.height),
          tools,
          allToolsInside: tools.every(
            (tool) => tool.left >= Math.round(mountBox.left) && tool.right <= Math.round(mountBox.right),
          ),
          saveDisabled: !!saveStudio()?.disabled,
          saveText: String(saveStudio()?.textContent || ''),
          vendorStudioGone: !document.querySelector('.af-image-studio'),
          status: String(studio.querySelector('[data-fisherai-image-status]')?.textContent || ''),
        };

        if (editScene === 'studio') {
          // ---- 裁剪 -> 应用 -> 保存为新图片 ----
          studio.querySelector('[data-fisherai-image-tool="crop"]').click();
          const cropCanvas = await until(
            () => document.querySelector('[data-fisherai-crop-canvas]'),
            10000,
          );
          await wait(400);
          const cropBox = cropCanvas.getBoundingClientRect();
          if (cropBox.width < 40 || cropBox.height < 40) {
            imageEditorSteps.error = '裁剪画布没量到尺寸（图片没加载？）';
            imageEditorSteps.done = true;
            return;
          }
          const x0 = Math.round(cropBox.left + cropBox.width * 0.18);
          const y0 = Math.round(cropBox.top + cropBox.height * 0.16);
          const x1 = Math.round(cropBox.left + cropBox.width * 0.72);
          const y1 = Math.round(cropBox.top + cropBox.height * 0.78);
          firePointerOn(cropCanvas, 'pointerdown', x0, y0);
          firePointerOn(cropCanvas, 'pointermove', Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2));
          firePointerOn(cropCanvas, 'pointermove', x1, y1);
          firePointerOn(cropCanvas, 'pointerup', x1, y1);
          await wait(350);
          const applyButton = document.querySelector('[data-fisherai-image-save="crop"]');
          imageEditorSteps.crop = {
            width: Math.round(cropBox.width),
            height: Math.round(cropBox.height),
            selection: String(
              document.querySelector('[data-fisherai-image-dimensions="selection"]')?.textContent || '',
            ),
            applyEnabled: !!applyButton && !applyButton.disabled,
          };
          if (!applyButton) {
            imageEditorSteps.error = '裁剪舞台没有应用按钮';
            imageEditorSteps.done = true;
            return;
          }
          applyButton.click();
          const applied = await until(() => {
            const status = document.querySelector('[data-fisherai-image-status]');
            return status && String(status.textContent || '').indexOf('已应用') >= 0 ? status : null;
          }, 10000);
          imageEditorSteps.applied = !!applied;
          imageEditorSteps.saveEnabledAfterApply = !!saveStudio() && !saveStudio().disabled;
          const before = document.querySelectorAll('[data-node-id]').length;
          saveStudio().click();
          const newNode = await until(() => {
            const frames = [...document.querySelectorAll('[data-node-id]')];
            if (frames.length <= before) return null;
            return frames.find((node) => node.getAttribute('data-node-id') !== 'node-edit-source');
          }, 20000);
          imageEditorSteps.saved = {
            nodeCountBefore: before,
            nodeCountAfter: document.querySelectorAll('[data-node-id]').length,
            newNodeId: newNode ? newNode.getAttribute('data-node-id') : '',
            imageSrc: newNode
              ? String(newNode.querySelector('img')?.getAttribute('src') || '')
              : '',
            studioClosed: !document.querySelector('[data-fisherai-image-studio="editor"]'),
          };
          // 截图停在**重新打开的工作台**上（真机证据：nova 版图片编辑长什么样）
          await wait(500);
          await selectEditNode();
          imageEditorSteps.reopened = await openImageEditor();
        } else {
          // ---- 蒙版舞台：真画一笔 → 应用编辑 → 保存为新图片（标注结果也要真的落到画布上）----
          const paintStroke = async (canvas) => {
            const box = canvas.getBoundingClientRect();
            if (box.width < 40 || box.height < 40) return false;
            const sx = Math.round(box.left + box.width * 0.24);
            const sy = Math.round(box.top + box.height * 0.62);
            firePointerOn(canvas, 'pointerdown', sx, sy);
            for (let step = 1; step <= 8; step += 1) {
              firePointerOn(
                canvas,
                'pointermove',
                Math.round(sx + (box.width * 0.42 * step) / 8),
                Math.round(sy - Math.sin((step / 8) * Math.PI) * box.height * 0.24),
              );
              await wait(30);
            }
            firePointerOn(canvas, 'pointerup', Math.round(sx + box.width * 0.42), sy);
            await wait(350);
            return true;
          };
          const openMaskStage = async () => {
            document.querySelector('[data-fisherai-image-tool="mask"]').click();
            const canvas = await until(
              () => document.querySelector('[data-fisherai-annotation-canvas]'),
              10000,
            );
            await wait(400);
            return canvas;
          };
          const annotationCanvas = await openMaskStage();
          if (!annotationCanvas) {
            imageEditorSteps.error = '蒙版舞台没打开';
            imageEditorSteps.done = true;
            return;
          }
          const canvasBox = annotationCanvas.getBoundingClientRect();
          if (canvasBox.width < 40 || canvasBox.height < 40) {
            imageEditorSteps.error = '标注画布没量到尺寸（图片没加载？）';
            imageEditorSteps.done = true;
            return;
          }
          const tools2 = [...document.querySelectorAll('[data-fisherai-annotation-tool]')].map(
            (node) => node.getAttribute('data-fisherai-annotation-tool'),
          );
          await paintStroke(annotationCanvas);
          imageEditorSteps.annotation = {
            tools: tools2,
            canvasWidth: Math.round(canvasBox.width),
            canvasHeight: Math.round(canvasBox.height),
            // 图片本身也是这个尺寸（canvas 贴在 img 上，量一下 img 对得上没有）
            imageWidth: Math.round(
              (annotationCanvas.parentElement?.querySelector('img')?.getBoundingClientRect() || { width: 0 })
                .width,
            ),
            strokeText: String(
              document.querySelector('[data-fisherai-image-status]')?.textContent || '',
            ),
            saveLabel: String(
              document.querySelector('[data-fisherai-image-save="annotation"]')?.getAttribute(
                'aria-label',
              ) || '',
            ),
            saveEnabled: !document.querySelector('[data-fisherai-image-save="annotation"]')?.disabled,
          };
          // 应用编辑（回到工作台成为一版）→ 保存为新图片（POST /assets/images 落盘 → 新节点）
          const beforeAnnotation = document.querySelectorAll('[data-node-id]').length;
          document.querySelector('[data-fisherai-image-save="annotation"]').click();
          const appliedAnnotation = await until(() => {
            const status = document.querySelector('[data-fisherai-image-status]');
            return status && String(status.textContent || '').indexOf('已应用') >= 0 ? status : null;
          }, 10000);
          const saveStudioAfterAnnotation = document.querySelector(
            '[data-fisherai-image-save="studio"]',
          );
          imageEditorSteps.annotation.applied =
            !!appliedAnnotation &&
            !!saveStudioAfterAnnotation &&
            !saveStudioAfterAnnotation.disabled;
          if (saveStudioAfterAnnotation) {
            saveStudioAfterAnnotation.click();
            const annotationNode = await until(() => {
              const frames = [...document.querySelectorAll('[data-node-id]')];
              return frames.length > beforeAnnotation ? frames[frames.length - 1] : null;
            }, 20000);
            imageEditorSteps.annotation.saved = {
              nodeCountBefore: beforeAnnotation,
              nodeCountAfter: document.querySelectorAll('[data-node-id]').length,
              imageSrc: String(annotationNode?.querySelector('img')?.getAttribute('src') || ''),
            };
          }
          // 截图停在**重新打开的蒙版舞台**上（真机证据：nova 版标注/蒙版长什么样，带一笔笔迹）
          await wait(500);
          await selectEditNode();
          if (await openImageEditor()) {
            const again = await openMaskStage();
            if (again) {
              await paintStroke(again);
              imageEditorSteps.annotation.reopened = true;
            }
          }
        }
      } catch (error) {
        imageEditorSteps.error = String((error && error.stack) || error);
      }
      imageEditorSteps.done = true;
    };

    /**
     * 网格跟随画布的**速度**（?xgridpan=1 场景，v1.33）。
     *
     * 用户报障（2026-10-17）：「移动画布的时候背后的网格和节点移动的速度不一致，
     * 网格的速度快，节点慢。」
     *
     * 根因：网格把画布 translate（CSS px）**乘了 devicePixelRatio** 才写进
     * --canvas-grid-pan-x，格子边长也乘了 dpr。CSS 背景的定位单位永远是 CSS px，
     * 于是网格的位移 = 节点位移 × dpr：本机 125% 缩放（dpr=1.25）下网格正好快 1.25 倍。
     * dpr=1 时那个乘子等于没写 —— 这也是为什么 jsdom（恒 1）和平时那套
     * --force-device-scale-factor=1 的真机检查一直没抓到。
     *
     * 所以这里量的是**与 dpr 无关的比值**，任何 dpr 下都必须成立：
     *   ① 画布平移 160px → 网格背景position 也必须移 160px（ratio = 1.000，不是 1.25）；
     *   ② 格子边长 = 24 × zoom（CSS px，和节点同一个坐标系）；
     *   ③ 顺带把 dpr 报回去，1.25 那一次跑出来才能和 1.0 对照。
     *
     * 网格的变量是 MutationObserver 从 transform 里读的（见 src/client/canvas/canvasGrid.ts），
     * 所以这里必须 await 一次让它落盘 —— 但探针定时器在**这之前**就已经立起来了
     * （见下面「探针定时器必须在任何 await 之前立起来」），不会失联。
     */
    const gridPanScene = new URLSearchParams(location.search).get('xgridpan') === '1';
    const gridPanSteps = { done: false, measure: null, ratio: null };
    const gridPanGeometry = () => {
      const layer = document.querySelector('[data-canvas-grid="true"]');
      const cross = layer ? layer.querySelector('.canvas-grid-cross.is-base') : null;
      if (!layer || !cross) return null;
      const style = getComputedStyle(cross);
      // 不用正则：这段代码写在模板字面量里，反斜杠会被外层模板串吃掉（同一个坑踩过）。
      const parts = String(style.backgroundPosition || '').split(' ');
      return {
        size: Number.parseFloat(String(style.backgroundSize || '0')) || 0,
        x: Number.parseFloat(parts[0] || '0') || 0,
        y: Number.parseFloat(parts[1] || '0') || 0,
      };
    };
    const buildGridPanScene = async () => {
      if (!gridPanScene) return;
      try {
        const layer = await until(() => document.querySelector('[data-canvas-grid="true"]'), 20000);
        const viewport = document.getElementById('canvas-viewport-content');
        if (!layer || !viewport) {
          gridPanSteps.error = '网格层或画布视口没挂上';
          gridPanSteps.done = true;
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        const setTransform = async (value) => {
          viewport.style.transform = value;
          // 等 MutationObserver 把 translate 读成 CSS 变量（异步，一帧足够）
          await wait(200);
        };
        await setTransform('translate3d(0px, 0px, 0) scale(1)');
        const before = gridPanGeometry();
        const varBefore = Number.parseFloat(layer.style.getPropertyValue('--canvas-grid-pan-x')) || 0;
        await setTransform('translate3d(-160px, 96px, 0) scale(1)');
        const after = gridPanGeometry();
        const varAfter = Number.parseFloat(layer.style.getPropertyValue('--canvas-grid-pan-x')) || 0;
        await setTransform('translate3d(-160px, 96px, 0) scale(1.5)');
        const zoomed = gridPanGeometry();
        const gridPanX = before && after ? Number((after.x - before.x).toFixed(3)) : null;
        const gridPanY = before && after ? Number((after.y - before.y).toFixed(3)) : null;
        gridPanSteps.measure = {
          dpr: dpr,
          /** 画布（节点）这一段的位移，单位 CSS px、带正负号 —— 网格必须**一模一样** */
          nodePanX: -160,
          nodePanY: 96,
          gridPanX: gridPanX,
          gridPanY: gridPanY,
          /** 网格层 CSS 变量里实际写的值（根因就在这里：它曾等于 160×dpr） */
          varPanX: Number((varAfter - varBefore).toFixed(3)),
          sizeZoom1: before ? before.size : null,
          sizeZoom1_5: zoomed ? zoomed.size : null,
          vars: {
            panX: layer.style.getPropertyValue('--canvas-grid-pan-x'),
            panY: layer.style.getPropertyValue('--canvas-grid-pan-y'),
            zoom: layer.style.getPropertyValue('--canvas-grid-zoom'),
            dpr: layer.style.getPropertyValue('--canvas-grid-dpr'),
          },
        };
        if (gridPanX !== null) {
          gridPanSteps.ratio = Number((gridPanX / -160).toFixed(4));
          gridPanSteps.ratioY = gridPanY === null ? null : Number((gridPanY / 96).toFixed(4));
        }
        /*
         * v1.48（用户「缩小画布就密密麻麻」）：三层嵌套矩阵在真机上的显隐。
         * 判据是屏幕间距 = spacing × zoom，结果写在每层 wrapper 的 inline opacity 上。
         * 量三档：1（小+大）、0.2（大+更大）、0.05（只剩最大一层）。
         */
        const readTiers = () =>
          [...document.querySelectorAll('[data-canvas-grid-tier]')].map((element) => ({
            id: element.getAttribute('data-canvas-grid-tier'),
            spacing: Number(element.getAttribute('data-canvas-grid-tier-spacing')),
            opacity: Number.parseFloat(element.style.opacity || '0'),
            visible: element.getAttribute('data-canvas-grid-tier-visible'),
          }));
        await setTransform('translate3d(0px, 0px, 0) scale(1)');
        const tiersAt1 = readTiers();
        await setTransform('translate3d(0px, 0px, 0) scale(0.2)');
        const tiersAt02 = readTiers();
        await setTransform('translate3d(0px, 0px, 0) scale(0.05)');
        const tiersAt005 = readTiers();
        gridPanSteps.tiers = { at1: tiersAt1, at02: tiersAt02, at005: tiersAt005 };
        /*
         * 量完把画布摆回原位。
         *
         * 为什么必须还原：越界检查（「画布里的定位元素不许越过侧边栏右缘」）是**每份探针都跑**的，
         * 而这里把 #canvas-viewport-content 缩放到了 1.5 —— 里面那张铺满的连线 SVG 的包围盒
         * 会跟着放大到侧边栏左侧（80,96 1773x1206），被当成「贴边元素越界」假红。
         * 这个场景量的是网格位移，不需要留下放大态。
         */
        await setTransform('translate3d(0px, 0px, 0) scale(1)');
      } catch (error) {
        gridPanSteps.error = String((error && error.stack) || error);
      }
      gridPanSteps.done = true;
    };

    /**
     * 叠图「切换」场景（?xstack=1，v1.37）。用户原话「给这种折叠起来的图添加一个切换按钮」。
     *
     * 这个按钮有三个「看起来做了、真机上其实没做」的失败模式，所以量三件事：
     *   ① 控制条压在卡内容之上、又在节点框里（rect 在节点框内、宽度不为 0）；
     *   ② elementFromPoint 命中「切换」按钮自己 —— 布局对但被卡内容/画布底盘盖住时点不动；
     *   ③ 真点三下：图依次换成第 2/3/1 张（三张 PNG 颜色不同，截图里也看得出来）+ 计数跟走 +
     *      画布节点数不变（切换是换内容，不是摊开/复制）。
     */
    const stackScene = new URLSearchParams(location.search).get('xstack') === '1';
    const stackSteps = { done: false, initial: null, afterFirst: null, afterWrap: null, hit: null };
    const stackShot = () => {
      const frame = document.querySelector('[data-node-id="stack-host"]');
      const control = frame?.querySelector('[data-fisherai-stack-controls="true"]');
      const button = frame?.querySelector('[data-fisherai-stack-switch="true"]');
      const img = frame?.querySelector('[data-fisherai-image-preview] img');
      if (!frame || !control || !button) return null;
      const frameRect = frame.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        src: img ? String(img.getAttribute('src') || '') : '',
        counter: (control.textContent || '').replace(/\s+/g, ''),
        position: control.getAttribute('data-fisherai-stack-position'),
        total: control.getAttribute('data-fisherai-stack-total'),
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        card: {
          left: Math.round(frameRect.left),
          top: Math.round(frameRect.top),
          width: Math.round(frameRect.width),
          height: Math.round(frameRect.height),
        },
        insideCard:
          rect.left >= frameRect.left - 1 &&
          rect.right <= frameRect.right + 1 &&
          rect.top >= frameRect.top - 1 &&
          rect.bottom <= frameRect.bottom + 1,
        visible:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.5 &&
          rect.width > 8 &&
          rect.height > 8,
      };
    };
    const clickStackSwitch = () => {
      const button = document.querySelector('[data-fisherai-stack-switch="true"]');
      if (!button) return false;
      button.click();
      return true;
    };
    const buildStackScene = async () => {
      if (!stackScene) return;
      try {
        const button = await until(
          () => document.querySelector('[data-fisherai-stack-switch="true"]'),
          20000,
        );
        if (!button) {
          stackSteps.error = '「切换」按钮没出现（叠图控制条没挂上）';
          stackSteps.done = true;
          return;
        }
        await wait(500);
        stackSteps.initial = stackShot();
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        stackSteps.hit = {
          tag: hit ? hit.tagName : null,
          text: hit ? String(hit.textContent || '').replace(/\s+/g, '').slice(0, 20) : null,
          onSwitch: !!(hit && (hit === button || button.contains(hit))),
        };
        stackSteps.nodeCount = document.querySelectorAll('[data-node-id]').length;
        clickStackSwitch();
        await wait(450);
        stackSteps.afterFirst = stackShot();
        clickStackSwitch();
        await wait(350);
        clickStackSwitch();
        await wait(550);
        stackSteps.afterWrap = stackShot();
        stackSteps.nodesAfter = document.querySelectorAll('[data-node-id]').length;
        // 截图停在第 2 张（绿卡 + 「切换 2/3」）：交付图一眼能看出「按一下真的换了」
        clickStackSwitch();
        await wait(500);
        stackSteps.final = stackShot();
      } catch (error) {
        stackSteps.error = String((error && error.stack) || error);
      }
      stackSteps.done = true;
    };

    /**
     * 视频生成历史（?xvideo=1，v1.64）。用户原话（2026-10-23）：
     * 「仿照图像生成历史记录，做视频生成历史记录功能」。
     *
     * jsdom 已经验过「药丸 -> 摊开 -> 设为主视频 -> 存盘」的数据链路，真机这一场补三件
     * 只有布局引擎才知道的事：
     *   ① 头部那枚药丸画在节点上方、elementFromPoint 真的点得到（头部被画布底盘盖住那类 bug）；
     *   ② 扇形历史格是摊到节点**外面**的：rect 在节点框外、中心点命中的是它自己
     *      （外框以前是 overflow-hidden，会把它们整块剪掉，jsdom 量不出来）；
     *   ③ 三条 mp4 在 Chrome 里真解码（videoWidth = 320），点「设为主视频」主片换成蓝的那条。
     * 截图停在「主片是蓝的 + 旁边摊着绿/红两条历史」这一屏（交付图）。
     */
    const videoHistoryScene = new URLSearchParams(location.search).get('xvideo') === '1';
    const videoHistorySteps = { done: false, initial: null, expanded: null, promoted: null, final: null };
    const videoHistoryFrame = () => document.querySelector('[data-node-id="video-history-host"]');
    const videoHistorySnapshot = () => {
      const frame = videoHistoryFrame();
      if (!frame) return null;
      const indicator = frame.querySelector('[data-fisherai-video-history-indicator="true"]');
      const main = frame.querySelector('[data-fisherai-video-streaming] video');
      const frameBox = frame.getBoundingClientRect();
      const items = [...frame.querySelectorAll('[data-fisherai-video-history]')].map((item) => {
        const box = item.getBoundingClientRect();
        const middle = document.elementFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(box.top + box.height / 2),
        );
        return {
          src: String(item.querySelector('video')?.getAttribute('src') || ''),
          left: Math.round(box.left),
          top: Math.round(box.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
          outside:
            box.left >= frameBox.right - 1 ||
            box.top >= frameBox.bottom - 1 ||
            box.right <= frameBox.left + 1 ||
            box.bottom <= frameBox.top + 1,
          hitSelf: Boolean(middle && (middle === item || item.contains(middle))),
        };
      });
      const pillBox = indicator ? indicator.getBoundingClientRect() : null;
      const pillHit = pillBox
        ? document.elementFromPoint(
            Math.round(pillBox.left + pillBox.width / 2),
            Math.round(pillBox.top + pillBox.height / 2),
          )
        : null;
      return {
        label: indicator ? String(indicator.textContent || '').replace(/\s+/g, '') : '',
        ariaLabel: indicator ? String(indicator.getAttribute('aria-label') || '') : '',
        expanded: indicator ? indicator.getAttribute('aria-expanded') : null,
        mainSrc: main ? String(main.getAttribute('src') || '') : '',
        mainWidth: main ? Number(main.videoWidth) : 0,
        mainHeight: main ? Number(main.videoHeight) : 0,
        frame: {
          left: Math.round(frameBox.left),
          top: Math.round(frameBox.top),
          width: Math.round(frameBox.width),
          height: Math.round(frameBox.height),
        },
        pill: pillBox
          ? {
              left: Math.round(pillBox.left),
              top: Math.round(pillBox.top),
              width: Math.round(pillBox.width),
              height: Math.round(pillBox.height),
              onTop: Boolean(pillHit && (pillHit === indicator || indicator.contains(pillHit))),
            }
          : null,
        pillAboveNode: pillBox ? pillBox.bottom <= frameBox.top + 2 : false,
        items,
        nodeCount: document.querySelectorAll('[data-node-id]').length,
      };
    };
    const buildVideoHistoryScene = async () => {
      if (!videoHistoryScene) return;
      try {
        const frame = await until(() => videoHistoryFrame(), 20000);
        if (!frame) {
          videoHistorySteps.error = '视频节点没出现';
          videoHistorySteps.done = true;
          return;
        }
        // 首帧解码要一点时间：等主片量到 videoWidth 再记初始态（截图与读数才是一回事）
        await until(() => Number(videoHistoryFrame()?.querySelector('video')?.videoWidth || 0) > 0, 8000);
        await wait(400);
        videoHistorySteps.initial = videoHistorySnapshot();
        const indicator = frame.querySelector('[data-fisherai-video-history-indicator="true"]');
        if (!indicator) {
          videoHistorySteps.error = '「历史 N」药丸没出现';
          videoHistorySteps.done = true;
          return;
        }
        indicator.click();
        await wait(700);
        videoHistorySteps.expanded = videoHistorySnapshot();
        const item = frame.querySelectorAll('[data-fisherai-video-history]')[1];
        const promote = item
          ? [...item.querySelectorAll('button')].find((button) =>
              String(button.textContent || '').includes('设为主视频'),
            )
          : null;
        if (!promote) {
          videoHistorySteps.error = '「设为主视频」按钮没出现';
          videoHistorySteps.done = true;
          return;
        }
        promote.click();
        await wait(900);
        videoHistorySteps.promoted = videoHistorySnapshot();
        // 交付图：再摊开一次 —— 主片已经换成蓝的，旁边是绿/红两条历史
        const again = videoHistoryFrame()?.querySelector('[data-fisherai-video-history-indicator="true"]');
        if (again) again.click();
        await wait(900);
        videoHistorySteps.final = videoHistorySnapshot();

        // ---- v1.66：截帧入口（真布局里点得开；真取帧链路由 scripts/verify-video-frames.mjs 单独验）----
        // 这里只做「虚拟时间安全」的断言：截帧要真解码视频再真上传，headless 的
        // --virtual-time-budget 在解码期间会把虚拟时钟跑完（等待窗口会假超时），
        // 所以真取帧放在 standalone 的 verify-video-frames（真时间、真 Chromium）里验。
        const frameTrigger = videoHistoryFrame()?.querySelector('[data-fisherai-video-frame-trigger="true"]');
        if (!frameTrigger) {
          videoHistorySteps.framesError = '截帧入口（截取视频帧）没出现';
        } else {
          videoHistoryFrame()?.querySelector('video')?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
          await wait(300);
          frameTrigger.click();
          await wait(250);
          videoHistorySteps.framesMenu = Boolean(
            videoHistoryFrame()?.querySelector('[data-fisherai-video-frame-menu="true"]'),
          );
          videoHistorySteps.framesMenuItems = [
            ...(videoHistoryFrame()?.querySelectorAll('[data-fisherai-video-frame-action]') || []),
          ].map((button) => String(button.getAttribute('data-fisherai-video-frame-action') || ''));
          // 收起菜单：交付图仍然停在「主片是蓝的 + 旁边摊着两条历史」
          frameTrigger.click();
          await wait(200);
          videoHistorySteps.framesMenuClosed = !videoHistoryFrame()?.querySelector(
            '[data-fisherai-video-frame-menu="true"]',
          );
        }
      } catch (error) {
        videoHistorySteps.error = String((error && error.stack) || error);
      }
      videoHistorySteps.done = true;
    };

    /**
     * 视频节点能接几张参考图（?xvideorefs=1，v1.65）。
     *
     * 用户原话（2026-10-23）：「视频生成图像参考只能拖入三张，修复一下，按 minimaxh3 的标准来」。
     *
     * jsdom 已经验过「拖线 → 准入 → 存盘」的数据链路，真机这一场补的是**真布局**下才成立的几件事：
     *   ① 10 张图的「连接输出」圆点在 DOM 里、rect 是真的（jsdom 里所有 rect 都是 0）；
     *   ② 从圆点拖到视频节点身上真的接上（连线命中走 elementFromPoint + 圆心吸附，
     *      jsdom 那两条都不可用，只能退回按节点矩形的公式）；
     *   ③ 接上去的条数就是注册表说的那个上限：9 张全上、第 10 张被拒（不是 3，也不是无限）。
     *
     * ⚠️ 这段代码在外层模板字面量里：**不许写反斜杠**（用 indexOf / split 代替正则）。
     */
    const videoRefsScene = new URLSearchParams(location.search).get('xvideorefs') === '1';
    const videoRefsSteps = { done: false };
    const videoRefsFrame = () => document.querySelector('[data-node-id="video-refs-host"]');
    const videoRefsIds = [
      'video-ref-image-1',
      'video-ref-image-2',
      'video-ref-image-3',
      'video-ref-image-4',
      'video-ref-image-5',
      'video-ref-image-6',
      'video-ref-image-7',
      'video-ref-image-8',
      'video-ref-image-9',
      'video-ref-image-10',
    ];
    const videoRefsPointer = (type, point) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      });
    /** 存盘后的 parentIds（= 用户真接上的那些）。 */
    const videoRefsParents = async () => {
      const response = await fetch('/api/aifisher/canvas/workflows/${videoRefsProjectId}', {
        cache: 'no-store',
      });
      if (!response.ok) return null;
      const document_ = await response.json();
      const node = (document_.nodes || []).find((item) => item.id === 'video-refs-host');
      return node ? node.parentIds || [] : null;
    };
    const buildVideoRefsScene = async () => {
      if (!videoRefsScene) return;
      try {
        const frame = await until(() => videoRefsFrame(), 20000);
        if (!frame) {
          videoRefsSteps.error = '视频节点没出现';
          videoRefsSteps.done = true;
          return;
        }
        const background = document.getElementById('canvas-background');
        if (!background) {
          videoRefsSteps.error = '画布底盘没出现';
          videoRefsSteps.done = true;
          return;
        }
        await wait(900);
        // 落点 = 视频节点身上（偏上一点，避开底下那条 composer）
        const frameBox = frame.getBoundingClientRect();
        const target = {
          x: Math.round(frameBox.left + frameBox.width / 2),
          y: Math.round(frameBox.top + 40),
        };
        videoRefsSteps.target = {
          x: target.x,
          y: target.y,
          frame: {
            left: Math.round(frameBox.left),
            top: Math.round(frameBox.top),
            width: Math.round(frameBox.width),
            height: Math.round(frameBox.height),
          },
        };
        const dragged = [];
        for (const id of videoRefsIds) {
          const imageFrame = document.querySelector('[data-node-id="' + id + '"]');
          if (!imageFrame) {
            dragged.push({ id: id, ok: false, reason: 'no frame' });
            continue;
          }
          /**
           * 连接圆平时是 hidden（group-hover/node:flex），只有**选中或真实 hover** 时才占地方：
           * 无头浏览器没有真指针，靠派发事件也点不出 CSS 的 :hover —— 所以先把这个节点点选上，
           * 圆才会 display:flex 拿到真 rect。这也正是用户的路径：先点节点，再从圆上拖线。
           */
          const selectBox = imageFrame.getBoundingClientRect();
          const selectPoint = {
            x: Math.round(selectBox.left + selectBox.width / 2),
            y: Math.round(selectBox.top + 18),
          };
          imageFrame.dispatchEvent(videoRefsPointer('pointerdown', selectPoint));
          background.dispatchEvent(videoRefsPointer('pointerup', selectPoint));
          await wait(120);
          const button = imageFrame.querySelector('[data-fisherai-connector-side="right"]');
          if (!button) {
            dragged.push({ id: id, ok: false, reason: 'no connector' });
            continue;
          }
          const box = button.getBoundingClientRect();
          const start = {
            x: Math.round(box.left + box.width / 2),
            y: Math.round(box.top + box.height / 2),
          };
          button.dispatchEvent(videoRefsPointer('pointerdown', start));
          background.dispatchEvent(videoRefsPointer('pointermove', target));
          background.dispatchEvent(videoRefsPointer('pointerup', target));
          dragged.push({
            id: id,
            ok: true,
            width: Math.round(box.width),
            height: Math.round(box.height),
            selected: String(imageFrame.getAttribute('data-node-selected') || ''),
          });
          await wait(180);
        }
        videoRefsSteps.dragged = dragged;
        // 存盘有防抖：轮询到 9 张都落盘（或超时）
        let parents = null;
        const end = Date.now() + 9000;
        while (Date.now() < end) {
          parents = await videoRefsParents();
          if (parents && parents.length >= 9) break;
          await wait(400);
        }
        const registry = globalThis.__FISHERAI_CHANNEL_MODELS__;
        const entry =
          registry && Array.isArray(registry.video)
            ? registry.video.find((item) => item.name === '${VIDEO_REFS_MODEL_NAME}')
            : null;
        const mode =
          entry && Array.isArray(entry.videoModes)
            ? entry.videoModes.find((item) => item.value === 'reference-video')
            : null;
        videoRefsSteps.registry = {
          found: Boolean(entry),
          maxInputs: entry ? entry.maxInputs : null,
          imageLimit: mode && mode.allowedInputs ? mode.allowedInputs.image : null,
        };
        videoRefsSteps.connected = {
          parents: parents || [],
          nodeCount: document.querySelectorAll('[data-node-id]').length,
        };
        /**
         * 交付图：先按 Esc 清选中（选中态会在底部拉出 composer 浮层，盖住下面两排参考图；
         * 用点空白来清会留一个框选虚线框，越界探针会把它当成画布压住了侧边栏），
         * 再点视口控件里的「显示所有节点」把整条链缩进画面 —— 截图要能一眼看出
         * 「9 条参考线接在视频节点上、第 10 张空着」。
         */
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(400);
        const fit = document.querySelector('[aria-label="显示所有节点"]');
        if (fit) {
          fit.click();
          await wait(900);
        }
        videoRefsSteps.fitted = Boolean(fit);
        const layer = document.querySelector('#canvas-viewport-content');
        videoRefsSteps.transform = layer ? String(layer.style.transform || '') : '';
        await wait(600);
      } catch (error) {
        videoRefsSteps.error = String((error && error.stack) || error);
      }
      videoRefsSteps.done = true;
    };

    /**
     * 扩图场景（?xoutpaint=1，v1.38 起，v1.39 改成「先出画面再接节点」）。
     *
     * 用户原话（v1.38）：「把这个功能移除，替换成扩图功能；……点击生成后不直接生图，
     * 先输出一个空的图像生成节点，填好提示词，由我来点击最后的生成」。
     * 用户原话（v1.39，附参考图：「原图 → 扩图画面 → 扩图 · 21:9」节点链）：
     * 「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」。
     *
     * 这一场在真浏览器里走完整条链路，量五件事：
     *   ① 工具条里 HD / AI 高清放大没了、「扩图」入口在；
     *   ② 面板真的弹出来、落在画布里，目标比例 / 九宫格位置 / 延展内容 / 预览都在；
     *   ③ 点「生成扩图画面」→ 画布上多**两张**节点：左「扩图画面」（真图片，自然尺寸
     *      427×240 = 320×240 源图扩到 16:9）、右「扩图 · 16:9」（空图、提示词已填、
     *      参考图连的是扩图画面）；
     *   ④ 「一条生成请求都没发出去」由 Node 侧数 host 收到的 /generate-* 请求
     *      （见 generationRequests），页面上看不出真假；
     *   ⑤ 落盘的那张 PNG 也要对：尺寸 427×240、贴右留下的左侧空白是透明的、右侧是原图内容。
     * 截图停在「左边扩图画面 + 右边等生成的空节点」上（交付图）。
     */
    const outpaintMode = new URLSearchParams(location.search).get('xoutpaint') || '';
    const outpaintSteps = { done: false, mode: outpaintMode, panel: null, after: null, reopening: null };
    const outpaintFrame = () => document.querySelector('[data-node-id="node-outpaint-source"]');
    const selectNodeFrame = async (frame, pointerId) => {
      if (!frame) return false;
      const box = frame.getBoundingClientRect();
      const x = Math.round(box.left + Math.min(80, box.width / 2));
      const y = Math.round(box.top + Math.min(28, box.height / 2));
      firePointerOn(frame, 'pointerdown', x, y);
      firePointerOn(frame, 'pointerup', x, y);
      frame.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
      await wait(600);
      return frame.getAttribute('data-node-selected') === 'true';
    };
    const clickToolbarButton = async (label) => {
      const toolbar = await until(
        () => document.querySelector('[data-fisherai-media-toolbar]'),
        10000,
      );
      if (!toolbar) return false;
      const button = [...toolbar.querySelectorAll('button')].find(
        (node) => (node.getAttribute('aria-label') || '') === label,
      );
      if (!button) return false;
      button.click();
      return true;
    };
    const readOutpaintPanel = () => {
      const panel = document.querySelector('[data-fisherai-outpaint-panel="true"]');
      if (!panel) return null;
      const mount = document.querySelector('.af-canvas-mount');
      const mountBox = mount ? mount.getBoundingClientRect() : null;
      const box = panel.getBoundingClientRect();
      const create = panel.querySelector('[data-fisherai-outpaint-create="true"]');
      const status = panel.querySelector('[data-fisherai-outpaint-status]');
      const preview = panel.querySelector('[data-fisherai-outpaint-preview="true"]');
      const previewImage = panel.querySelector('[data-fisherai-outpaint-preview-image="true"]');
      // 面板下半截会不会被节点上那条 composer 浮层（z-index 100）盖住？点一下按钮中心就知道。
      const createBox = create ? create.getBoundingClientRect() : null;
      const createHit =
        createBox && createBox.width > 0
          ? document.elementFromPoint(
              createBox.left + createBox.width / 2,
              createBox.top + createBox.height / 2,
            )
          : null;
      return {
        model: panel.getAttribute('data-fisherai-outpaint-model'),
        createHit: createHit ? panel.contains(createHit) : null,
        createHitLabel: createHit
          ? createHit.getAttribute('aria-label') || createHit.tagName
          : null,
        anchors: [...panel.querySelectorAll('[data-fisherai-outpaint-anchor]')].map((node) =>
          node.getAttribute('data-fisherai-outpaint-anchor'),
        ),
        ratios: [...panel.querySelectorAll('[data-fisherai-outpaint-ratio]')].map(
          (node) => node.getAttribute('data-fisherai-outpaint-ratio'),
        ),
        hasContentField: !!panel.querySelector('[data-fisherai-outpaint-content]'),
        previewSize: preview ? preview.getAttribute('data-fisherai-outpaint-preview-size') : null,
        previewLeft: previewImage ? previewImage.style.left : null,
        previewWidth: previewImage ? previewImage.style.width : null,
        createDisabled: create ? !!create.disabled : null,
        createLabel: create ? create.getAttribute('aria-label') || '' : '',
        status: status ? String(status.textContent || '') : '',
        rect: {
          left: Math.round(box.left),
          top: Math.round(box.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
        insideMount: mountBox
          ? box.left >= mountBox.left - 1 &&
            box.right <= mountBox.right + 1 &&
            box.top >= mountBox.top - 1 &&
            box.width > 120
          : null,
        text: String(panel.textContent || '').slice(0, 160),
      };
    };
    const buildOutpaintScene = async () => {
      if (!outpaintMode) return;
      try {
        const frame = await until(outpaintFrame, 20000);
        if (!frame) {
          outpaintSteps.error = '源图节点没出现';
          outpaintSteps.done = true;
          return;
        }
        outpaintSteps.selected = await selectNodeFrame(frame, 31);
        await wait(400);
        outpaintSteps.toolbar = {
          hasHdUpscale: !!document.querySelector('[aria-label="AI 高清放大"]'),
          hasOutpaintTrigger: !!document.querySelector('[data-fisherai-outpaint-trigger="true"]'),
        };
        const trigger = document.querySelector('[data-fisherai-outpaint-trigger="true"]');
        if (!trigger) {
          outpaintSteps.error = '扩图入口没出现（工具条没渲染？）';
          outpaintSteps.done = true;
          return;
        }
        trigger.click();
        await until(() => document.querySelector('[data-fisherai-outpaint-panel="true"]'), 8000);
        await wait(350);
        outpaintSteps.panel = readOutpaintPanel();
        // 选「贴右 + 16:9」、填一句延展内容：这样能证明三样选择都落到了画面/节点上。
        const anchor = document.querySelector('[data-fisherai-outpaint-anchor="right"]');
        if (anchor) anchor.click();
        const ratio = document.querySelector('[data-fisherai-outpaint-ratio="16:9"]');
        if (ratio) ratio.click();
        const content = document.querySelector('[data-fisherai-outpaint-content]');
        if (content) {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
          )?.set;
          if (setter) setter.call(content, '两侧延伸出更多沙滩和海面');
          content.dispatchEvent(new Event('input', { bubbles: true }));
          content.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await wait(250);
        outpaintSteps.active = {
          anchor: document
            .querySelector('[data-fisherai-outpaint-anchor="right"]')
            ?.getAttribute('aria-pressed'),
          ratio: document
            .querySelector('[data-fisherai-outpaint-ratio="16:9"]')
            ?.getAttribute('aria-pressed'),
          content: content ? content.value : null,
          previewSize: document
            .querySelector('[data-fisherai-outpaint-preview="true"]')
            ?.getAttribute('data-fisherai-outpaint-preview-size'),
          previewLeft: document.querySelector('[data-fisherai-outpaint-preview-image="true"]')
            ? document.querySelector('[data-fisherai-outpaint-preview-image="true"]').style.left
            : null,
        };
        // ?xoutpaint=panel 只取证面板本身（不创建节点，截图停在面板上）
        if (outpaintMode === 'panel') {
          await wait(900);
          outpaintSteps.reopening = readOutpaintPanel();
          outpaintSteps.done = true;
          return;
        }
        const before = document.querySelectorAll('[data-node-id]').length;
        outpaintSteps.before = before;
        const create = document.querySelector('[data-fisherai-outpaint-create="true"]');
        if (create) create.click();
        // 等**两张**节点都落下：①扩图画面（它是真图片，等它解码出 naturalWidth）②生成节点
        const compositeImage = await until(() => {
          const frames = [...document.querySelectorAll('[data-node-id]')];
          for (const node of frames) {
            const title = String(node.querySelector('[data-af-node-title]')?.textContent || '');
            if (!title.startsWith('扩图画面')) continue;
            const image = node.querySelector('[data-fisherai-image-preview] img');
            if (image && image.naturalWidth > 0) return image;
          }
          return null;
        }, 20000);
        await wait(700);
        const frames = [...document.querySelectorAll('[data-node-id]')];
        const compositeFrame =
          frames.find((node) =>
            String(node.querySelector('[data-af-node-title]')?.textContent || '').startsWith('扩图画面'),
          ) ?? null;
        const generationFrame =
          frames.find((node) =>
            String(node.querySelector('[data-af-node-title]')?.textContent || '').startsWith('扩图 · '),
          ) ?? null;
        const composer = generationFrame
          ? generationFrame.querySelector('[data-fisherai-generation-composer="image"]')
          : null;
        const composerText = composer ? String(composer.textContent || '') : '';
        const compositeTitle = compositeFrame
          ? String(compositeFrame.querySelector('[data-af-node-title]')?.textContent || '')
          : '';
        outpaintSteps.after = {
          nodeCount: document.querySelectorAll('[data-node-id]').length,
          compositeId: compositeFrame ? compositeFrame.getAttribute('data-node-id') : '',
          compositeTitle,
          compositeImageSrc: compositeImage ? compositeImage.getAttribute('src') : null,
          compositeNatural: compositeImage
            ? { width: compositeImage.naturalWidth, height: compositeImage.naturalHeight }
            : null,
          generationId: generationFrame ? generationFrame.getAttribute('data-node-id') : '',
          generationTitle: generationFrame
            ? String(generationFrame.querySelector('[data-af-node-title]')?.textContent || '')
            : '',
          selected: generationFrame ? generationFrame.getAttribute('data-node-selected') : null,
          hasResultImage: generationFrame
            ? !!generationFrame.querySelector('[data-fisherai-image-preview] img')
            : null,
          promptFilled: composerText.includes('向外扩图'),
          composerText: composerText.slice(0, 240),
          panelClosed: !document.querySelector('[data-fisherai-outpaint-panel="true"]'),
          transform: generationFrame ? generationFrame.style.transform : null,
        };
        /**
         * 截图停在新的两张节点上 —— 左边是画好的「扩图画面」（原图贴右、左侧留白），
         * 右边是空着等用户点生成的「扩图 · 16:9」（交付图取证）。
         * 三张卡横向摆了 1200px，先在画布背景上真滚三下滚轮缩小到 ≈61%，再往左平移 120px，
         * 让整条链连同生成节点下面的 composer 都进画面（滚轮是 vendor 的缩放路径，
         * deltaY 正向 = 缩小）。平移量刻意留小：世界原点仍在画布左缘右边，越界探针不受影响。
         */
        const mountBox = document.querySelector('.af-canvas-mount')?.getBoundingClientRect();
        const wheelTarget = document.querySelector('#canvas-background') ?? document.body;
        for (let step = 0; step < 3; step += 1) {
          wheelTarget.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: 120,
              clientX: mountBox ? Math.round(mountBox.left + mountBox.width / 2) : 720,
              clientY: mountBox ? Math.round(mountBox.top + mountBox.height / 2) : 450,
              bubbles: true,
              cancelable: true,
            }),
          );
          await wait(90);
        }
        // 再往左平移一点（alt+滚轮 = pan）：让生成节点下面的 composer 不要顶到画面右缘。
        // 平移量刻意留小（120px）：世界原点仍在画布左缘右边，越界探针不会把画布底盘当成贴边元素。
        wheelTarget.dispatchEvent(
          new WheelEvent('wheel', {
            altKey: true,
            deltaX: 120,
            deltaY: 0,
            clientX: mountBox ? Math.round(mountBox.left + mountBox.width / 2) : 720,
            clientY: mountBox ? Math.round(mountBox.top + mountBox.height / 2) : 450,
            bubbles: true,
            cancelable: true,
          }),
        );
        await wait(500);
        outpaintSteps.final = [...document.querySelectorAll('[data-node-id]')].map((node) => {
          const editor = node.querySelector('[data-fisherai-generation-composer="image"]');
          const image = node.querySelector('[data-fisherai-image-preview] img');
          return {
            id: node.getAttribute('data-node-id'),
            title: String(node.querySelector('[data-af-node-title]')?.textContent || ''),
            selected: node.getAttribute('data-node-selected'),
            composerText: editor ? String(editor.textContent || '').slice(0, 240) : null,
            hasResultImage: !!image,
            imageSize: image ? { width: image.naturalWidth, height: image.naturalHeight } : null,
          };
        });
      } catch (error) {
        outpaintSteps.error = String((error && error.stack) || error);
      }
      outpaintSteps.done = true;
    };

    /**
     * 尺寸场景（?xresize=1，v1.38）。用户原话「尺寸节点的ui还没有更新」。
     *
     * 量的是「nova 版对话框真的能用」：
     *   ① 点工具条「尺寸」→ 新的紧凑对话框（data-fisherai-image-resize）铺在画布里、不越界；
     *   ② 原图尺寸真的读出来了（320×240），点「2x」→ 目标 640×480；
     *   ③ 点保存 → POST 素材库 → 画布上多一个节点，那张图的自然尺寸就是 640×480
     *      （像素语义没被换壳改坏）；
     *   ④ 同一时刻只有一个「调整图片尺寸」对话框（vendor 那套整屏浮层没有一起渲染）。
     * 截图停在「重新打开的对话框 + 2x」上（交付图）。
     */
    const resizeScene = new URLSearchParams(location.search).get('xresize') === '1';
    const resizeSteps = { done: false, dialog: null, afterPreset: null, saved: null, reopened: null };
    const resizeFrame = () => document.querySelector('[data-node-id="node-resize-source"]');
    const readResizeDialog = () => {
      const dialog = document.querySelector('[data-fisherai-image-resize="true"]');
      if (!dialog) return null;
      const mount = document.querySelector('.af-canvas-mount');
      const mountBox = mount ? mount.getBoundingClientRect() : null;
      const box = dialog.getBoundingClientRect();
      const card = dialog.firstElementChild;
      const cardBox = card ? card.getBoundingClientRect() : null;
      const dims = dialog.querySelector('[data-fisherai-resize-dimensions]');
      const save = dialog.querySelector('[data-fisherai-image-save="resize"]');
      return {
        role: dialog.getAttribute('role'),
        label: dialog.getAttribute('aria-label'),
        original: dims ? dims.getAttribute('data-original') : null,
        target: dims ? dims.getAttribute('data-target') : null,
        presets: dialog.querySelectorAll('[data-fisherai-resize-preset]').length,
        inputs: {
          slider: !!dialog.querySelector('[aria-label="图片缩放滑块"]'),
          scale: !!dialog.querySelector('[aria-label="图片缩放倍数"]'),
          width: !!dialog.querySelector('[aria-label="图片宽度"]'),
          height: !!dialog.querySelector('[aria-label="图片高度"]'),
        },
        saveDisabled: save ? !!save.disabled : null,
        saveLabel: save ? save.getAttribute('aria-label') || '' : '',
        dialogsOnPage: document.querySelectorAll('[aria-label="调整图片尺寸"]').length,
        rect: {
          left: Math.round(box.left),
          top: Math.round(box.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
        card: cardBox
          ? { width: Math.round(cardBox.width), height: Math.round(cardBox.height) }
          : null,
        insideMount: mountBox
          ? box.left >= mountBox.left - 1 &&
            box.right <= mountBox.right + 1 &&
            box.top >= mountBox.top - 1 &&
            box.bottom <= mountBox.bottom + 1
          : null,
      };
    };
    const waitResizeDialog = () =>
      until(() => {
        const dialog = document.querySelector('[data-fisherai-image-resize="true"]');
        if (!dialog) return null;
        const dims = dialog.querySelector('[data-fisherai-resize-dimensions]');
        return dims && dims.getAttribute('data-original') ? dialog : null;
      }, 15000);
    const buildResizeScene = async () => {
      if (!resizeScene) return;
      try {
        const frame = await until(resizeFrame, 20000);
        if (!frame) {
          resizeSteps.error = '源图节点没出现';
          resizeSteps.done = true;
          return;
        }
        resizeSteps.selected = await selectNodeFrame(frame, 41);
        resizeSteps.opened = await clickToolbarButton('尺寸');
        await waitResizeDialog();
        await wait(300);
        resizeSteps.dialog = readResizeDialog();
        const preset = document.querySelector('[data-fisherai-resize-preset="2"]');
        if (preset) preset.click();
        await wait(400);
        resizeSteps.afterPreset = readResizeDialog();
        const before = document.querySelectorAll('[data-node-id]').length;
        resizeSteps.before = before;
        const save = document.querySelector('[data-fisherai-image-save="resize"]');
        if (save) save.click();
        const created = await until(() => {
          const frames = [...document.querySelectorAll('[data-node-id]')];
          if (frames.length <= before) return null;
          return (
            frames.find((node) => node.getAttribute('data-node-id') !== 'node-resize-source') || null
          );
        }, 20000);
        await wait(800);
        const img = created
          ? created.querySelector('[data-fisherai-image-preview] img') ||
            created.querySelector('img')
          : null;
        resizeSteps.saved = {
          nodeCount: document.querySelectorAll('[data-node-id]').length,
          createdId: created ? created.getAttribute('data-node-id') : '',
          naturalWidth: img ? img.naturalWidth : 0,
          naturalHeight: img ? img.naturalHeight : 0,
          src: img ? String(img.getAttribute('src') || '') : '',
          dialogClosed: !document.querySelector('[data-fisherai-image-resize="true"]'),
        };
        // 截图停在这里：重新选中源图 → 打开尺寸 → 2x（交付图：nova 版尺寸对话框）
        await selectNodeFrame(resizeFrame(), 42);
        await wait(400);
        await clickToolbarButton('尺寸');
        await waitResizeDialog();
        await wait(300);
        const again = document.querySelector('[data-fisherai-resize-preset="2"]');
        if (again) again.click();
        await wait(350);
        resizeSteps.reopened = readResizeDialog();
      } catch (error) {
        resizeSteps.error = String((error && error.stack) || error);
      }
      resizeSteps.done = true;
    };

    /**
     * 「新节点默认用上一次的模型」场景（?xlastmodel=1，v1.40）。
     *
     * 用户原话：「我刚建完一个节点后需要我再次调整模型，可不可以改成新的节点会默认使用
     * 上一次生成任务所使用的模型」。
     *
     * 真机验三件（jsdom 那边验的是「点下拉换模型」，这一场验的是**真浏览器里的接线与可见结果**）：
     *   ① 没记过时新建的图片节点 = 目录第一个模型（通道别名「魔搭出图」）；
     *   ② 记一次「上一次用的模型」（真机上就是用户在节点下拉里换过 / 生成过一次）→
     *      下一个新建的图片节点直接就是它，而**已经建好的节点不动**（记忆只影响新节点）；
     *   ③ reset 之后回到目录第一个（记忆不会粘死），并留下 localStorage 取证。
     *
     * 第二款模型用现场已经预置的「任务队列检查通道」那条图片模型 —— 它就是画布目录里的
     * 另一款真实模型，不必再往共享的通道 fixture 里塞东西（那会改掉设置页「2 条模型」的断言）。
     */
    const lastModelScene = new URLSearchParams(location.search).get('xlastmodel') === '1';
    const LAST_MODEL_SECOND = '${LAST_MODEL_SECOND_TEXT}';
    const lastModelSteps = {
      done: false,
      bridge: null,
      first: null,
      second: null,
      firstAfter: null,
      remembered: null,
      stored: null,
      third: null,
      reset: null,
    };
    /** 建一个图片节点，返回它的节点壳（按「多出来的那个 data-node-id」认，不依赖坐标）。 */
    const createImageNode = async (point) => {
      const before = [...document.querySelectorAll('[data-node-id]')].map((frame) =>
        frame.getAttribute('data-node-id'),
      );
      window.dispatchEvent(
        new CustomEvent('fisherai:add-canvas-node', { detail: { type: 'Image', point } }),
      );
      return until(() => {
        const frames = [...document.querySelectorAll('[data-node-id]')];
        return frames.find((frame) => before.indexOf(frame.getAttribute('data-node-id')) < 0) || null;
      }, 15000);
    };
    /**
     * 这个节点上「显示的是哪个模型」：选中它（composer 才渲染），把卡片正文摘一段回来。
     * 模型下拉按钮上写的就是模型显示名，所以文本里能直接判读。
     */
    const nodeModelText = async (frame) => {
      if (!frame) return '';
      await selectNodeFrame(frame, 71);
      await wait(400);
      return String(frame.textContent || '').slice(0, 400);
    };
    const buildLastModelScene = async () => {
      if (!lastModelScene) return;
      try {
        const bridge = window.__FISHERAI_CANVAS_LAST_MODEL__;
        lastModelSteps.bridge = {
          store: !!bridge,
          pick: typeof window.__FISHERAI_LAST_MODEL__ === 'function',
          remember: typeof window.__FISHERAI_REMEMBER_MODEL__ === 'function',
        };
        if (!bridge) {
          lastModelSteps.error = 'window.__FISHERAI_CANVAS_LAST_MODEL__ 没装';
          lastModelSteps.done = true;
          return;
        }
        // 先等画布把通道模型装进目录（注册表是异步拉的）。不 wait 的话第一发建节点请求
        // 会赶在画布挂载/注册表之前派发 —— 节点根本不会出现，只有第一条红（实测）。
        await until(() => {
          const names = window.__FISHERAI_CHANNEL_MODEL_NAMES__;
          return names && names.size > 0;
        }, 20000);
        await wait(400);
        bridge.reset();
        const first = await createImageNode({ x: 120, y: 140 });
        lastModelSteps.first = await nodeModelText(first);
        bridge.remember('image', LAST_MODEL_SECOND);
        const second = await createImageNode({ x: 900, y: 140 });
        lastModelSteps.second = await nodeModelText(second);
        lastModelSteps.remembered = bridge.report();
        lastModelSteps.stored = String(
          window.localStorage.getItem('dsh-aifisher-canvas.last-model') || '',
        );
        // 已经建好的那个节点不许被改（记忆只影响**新建**的节点）
        lastModelSteps.firstAfter = await nodeModelText(first);
        bridge.reset();
        const third = await createImageNode({ x: 1680, y: 140 });
        lastModelSteps.third = await nodeModelText(third);
        lastModelSteps.reset = bridge.report();
        /**
         * 交付图停在「第二款模型」那颗节点上：它的 composer 上就写着「上一次用的模型」，
         * 正是这张图要证明的事。三张卡横向铺了 1560px，先在画布背景上真滚三下滚轮缩到 ≈61%
         * （vendor 的缩放路径，deltaY 正向 = 缩小），整条链才都进画面。
         */
        if (second) {
          const mountBox = document.querySelector('.af-canvas-mount')?.getBoundingClientRect();
          const wheelTarget = document.querySelector('#canvas-background') ?? document.body;
          for (let step = 0; step < 3; step += 1) {
            wheelTarget.dispatchEvent(
              new WheelEvent('wheel', {
                deltaY: 120,
                clientX: mountBox ? Math.round(mountBox.left + mountBox.width / 2) : 720,
                clientY: mountBox ? Math.round(mountBox.top + mountBox.height / 2) : 450,
                bubbles: true,
                cancelable: true,
              }),
            );
            await wait(90);
          }
          await selectNodeFrame(second, 72);
          await wait(600);
          // composer 铺到节点右下，右边会顶到画面外：再往左平移一点（alt+滚轮 = pan）。
          // 平移量刻意留小：世界原点仍在画布左缘右边，越界探针不会把画布底盘当成贴边元素。
          wheelTarget.dispatchEvent(
            new WheelEvent('wheel', {
              altKey: true,
              deltaX: 160,
              deltaY: 0,
              clientX: mountBox ? Math.round(mountBox.left + mountBox.width / 2) : 720,
              clientY: mountBox ? Math.round(mountBox.top + mountBox.height / 2) : 450,
              bubbles: true,
              cancelable: true,
            }),
          );
          await wait(600);
        }
      } catch (error) {
        lastModelSteps.error = String((error && error.stack) || error);
      }
      lastModelSteps.done = true;
    };

    /**
     * 切刀场景（?xknife=1，v1.49）。
     *
     * 用户原话：「现在做一个新功能，像blender一样按住ctrl加鼠标右键切换到切刀工具，
     * 划过的线会断开连接」。
     *
     * jsdom 那边验的是逻辑（采样/命中/断开），这一场验的是**真浏览器里的手势与画面**：
     *   ① Ctrl + 右键真拖一刀 → 画布上出现刀口浮层、被划过的连线变红（预览）；
     *   ② 松手 → 只有被划过的那条连线从 DOM 里消失（C 同时接 A、B，只切 A 那条）；
     *   ③ 第二刀停在**拖拽中**当交付图：截图里能直接看到切刀线与红色高亮。
     * 取点用真浏览器的 getTotalLength / getPointAtLength / getScreenCTM，
     * 与画布缩放无关（点在哪、屏幕坐标就是哪）。
     */
    const knifeScene = new URLSearchParams(location.search).get('xknife') === '1';
    const knifeSteps = {
      done: false,
      bridge: null,
      before: null,
      after: null,
      preview: null,
      delivery: null,
      report: null,
      error: '',
    };
    const buildKnifeScene = async () => {
      if (!knifeScene) return;
      try {
        // ⚠️ 底盘/桥都要**等到画布真挂上**再取：场景函数与 mountCanvas 是同一条脚本，
        // 一开始这里还是空的（第一版就把 surface 在等之前抓死了，后面 dispatchEvent 直接 null）。
        const surfaceOf = () => document.getElementById('canvas-background');
        const edgeGroups = () =>
          [...document.querySelectorAll('#canvas-viewport-content g[data-fisherai-edge-parent-id]')];
        await until(() => surfaceOf() && edgeGroups().length >= 2, 20000);
        const surface = surfaceOf();
        if (!surface) throw new Error('画布底盘没挂上（#canvas-background 不存在）');
        knifeSteps.bridge = typeof window.__FISHERAI_CANVAS_KNIFE__?.cut === 'function';
        await wait(700);
        const edgeOf = (parentId) =>
          edgeGroups().find((group) => group.getAttribute('data-fisherai-edge-parent-id') === parentId) || null;
        /** 一条连线在屏幕上的点（progress 是曲线参数，0.18 处离另一条线足够远）。 */
        const pointOn = (group, progress) => {
          const path = group && group.querySelector('path[data-fisherai-edge-hit-target]');
          if (!path) return null;
          const matrix = path.getScreenCTM();
          if (!matrix) return null;
          const local = path.getPointAtLength(path.getTotalLength() * progress);
          const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix);
          return { x: screen.x, y: screen.y };
        };
        const pointer = (type, x, y, extra) => {
          const options = extra || {};
          return new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 2,
            buttons: options.buttons === undefined ? 2 : options.buttons,
            ctrlKey: true,
            pointerId: 71,
            pointerType: 'mouse',
            isPrimary: true,
          });
        };
        knifeSteps.before = edgeGroups().map((group) => group.getAttribute('data-fisherai-edge-parent-id'));

        // ---- 第一刀：真拖、真松手 → 只断开 A→C
        const target = pointOn(edgeOf('knife-a'), 0.18);
        if (!target) throw new Error('量不到 A→C 连线上的点');
        surface.dispatchEvent(pointer('pointerdown', target.x, target.y - 46));
        await wait(60);
        surface.dispatchEvent(pointer('pointermove', target.x, target.y - 20));
        await wait(60);
        surface.dispatchEvent(pointer('pointermove', target.x, target.y + 20));
        await wait(150);
        const overlay = document.querySelector('[data-fisherai-knife-overlay]');
        const hint = overlay?.querySelector('[data-fisherai-knife-hint]')?.getAttribute('d') || '';
        const stroke = overlay?.querySelector('[data-fisherai-knife-stroke]')?.getAttribute('d') || '';
        knifeSteps.preview = {
          overlay: !!overlay,
          strokeChars: stroke.length,
          hintChars: hint.length,
          hintCount: hint ? hint.split('M').length - 1 : 0,
        };
        surface.dispatchEvent(pointer('pointerup', target.x, target.y + 20));
        await wait(500);
        knifeSteps.after = edgeGroups().map((group) => group.getAttribute('data-fisherai-edge-parent-id'));

        // ---- 第二刀停在「拖到一半」：交付图里就是切刀正在切的样子
        const second = pointOn(edgeOf('knife-b'), 0.5);
        if (second) {
          surface.dispatchEvent(pointer('pointerdown', second.x, second.y - 70));
          await wait(80);
          surface.dispatchEvent(pointer('pointermove', second.x + 4, second.y - 30));
          await wait(80);
          surface.dispatchEvent(pointer('pointermove', second.x, second.y + 30, { buttons: 2 }));
          await wait(160);
          knifeSteps.delivery = {
            overlay: !!document.querySelector('[data-fisherai-knife-overlay]'),
            hint: !!document.querySelector('[data-fisherai-knife-hint]')?.getAttribute('d'),
          };
        }
        knifeSteps.report = window.__canvasHandle && typeof window.__canvasHandle.knifeReport === 'function'
          ? window.__canvasHandle.knifeReport()
          : null;
      } catch (error) {
        knifeSteps.error = String((error && error.stack) || error);
      }
      knifeSteps.done = true;
    };

    // ⚠️ 探针定时器必须在任何 await 之前立起来：headless 的 --virtual-time-budget
    //    会等页面的微任务/定时器都跑完，如果前面有长 await 把这段脚本卡住，探针一次都发不出去
    //    （现象：没收到页面探针）。所以这里先装探针，再启动那些要等 DOM 的场景流程。
    setInterval(leakReport, 250);
    setTimeout(leakReport, 1800);
    void buildNodeSearchNode();
    void buildWorkflowNode();
    void runPortDragScene();
    void buildWorkflowConfigScene();
    void buildTaskQueueScene();
    void buildQueueLayerScene();
    void buildImageEditorScene();
    void buildGridPanScene();
    void buildStackScene();
    void buildVideoHistoryScene();
    void buildVideoRefsScene();
    void buildOutpaintScene();
    void buildResizeScene();
    void buildLastModelScene();
    void buildArchiveScene();
    void buildKnifeScene();
  </script>
</body>
</html>`;

/** 页面探针：key = location.search（默认 'default'）。 */
const probes = new Map();

/**
 * 本轮真机检查中，画布发到 host 的**生成请求**（`/api/aifisher/canvas/generate-*`）计数。
 *
 * v1.38 的硬要求是「点扩图只落空节点、不直接生图」，而这件事最诚实的证据就是
 * **一条生成请求都没有发出去** —— 页面上看着没出图，可能是因为请求失败/排队，
 * 只有 host 侧真的没收到才算数。场景跑完（Chrome 退出）后再读这个数组。
 */
const generationRequests = [];

// 排查用：把**求值后**的宿主页写出来（模板字面量里的转义已经结算）就退出 ——
// 宿主页脚本在模板里，改坏一个反斜杠就会让整页 SyntaxError（表现成「没收到页面探针」），
// 先用它跑一次 node --check 比跑完整套快得多。
if (process.env.DUMP_HOST_PAGE) {
  mkdirSync(join(ROOT, '.dsh-tmp'), { recursive: true });
  const out = join(ROOT, '.dsh-tmp', 'host-page-cooked.html');
  writeFileSync(out, HOST_PAGE, 'utf8');
  console.log(`[browser] 宿主页已写出（不跑浏览器）：${out}`);
  process.exit(0);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  /**
   * `BROWSER_REQLOG=1` 打出**每一条**请求与它的收尾时间（含 `closed after …ms`）。
   *
   * 为什么要有它：「没收到页面探针」有一类真凶是**某条请求永远不回**——headless 的
   * `--virtual-time-budget` 会停在未落地的 fetch 上，页面的时钟跟着冻住，探针一条都发不出去，
   * 而截图里画布看着完全正常。2026-10-20 就是靠它抓到 `GET /api/aifisher/canvas/copilot`
   * 一直挂着（closed after 2758ms = 浏览器退出了它还没回），才把根因从「渲染坏了」纠正到
   * 「副驾轮询不该走 bridge」。
   */
  const reqStartedAt = Date.now();
  if (process.env.BROWSER_REQLOG) {
    console.log(`[browser][req] ${req.method} ${url.pathname}${url.search}`);
    res.on('close', () => {
      console.log(`[browser][req] ${req.method} ${url.pathname} closed after ${Date.now() - reqStartedAt}ms`);
    });
    res.on('finish', () => {
      console.log(`[browser][req] ${req.method} ${url.pathname} ${res.statusCode} after ${Date.now() - reqStartedAt}ms`);
    });
  }

  // 页面探针回传（越界检测）
  if (url.pathname === '/__probe') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      probes.set(parsed.label ?? 'default', parsed);
      if (parsed.bootError) {
        console.log(`[browser][boot] 画布产物加载/挂载失败：${String(parsed.bootError).split('\n')[0]}`);
        if (parsed.bootErrors?.length) {
          console.log(`[browser][boot] 页面错误：${parsed.bootErrors.join(' | ')}`);
        }
      } else if (process.env.BROWSER_DEBUG) {
        console.log(
          `[browser][probe] label=${parsed.label} header=${parsed.header?.present === true} grid=${parsed.grid?.present === true} leaks=${(parsed.leaks ?? []).length} errors=${(parsed.errors ?? []).length}`,
        );
      }
    } catch {
      /* 半截 body 就忽略 */
    }
    res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HOST_PAGE);
    return;
  }

  /**
   * 任务队列场景的假云端端点（渠道 baseUrl = `${ORIGIN}/tq-channel/v1`）。
   *
   * 为什么要它：面板上那行「运行中 + 边框循环发光」只有在**真有一条请求在飞**的时候才存在。
   * Slow 模型这里刻意不返回（等 60s），客户端断开（Chrome 截图退出）就把定时器清掉；
   * Fast 模型立刻回一张本站能取到的 PNG，让面板上同时有一行「完成」。
   */
  if (url.pathname.startsWith('/tq-channel/')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = null;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    } catch {
      body = null;
    }
    if (url.pathname.endsWith('/images/generations')) {
      const resultUrl = `${TASK_QUEUE_CHANNEL.baseUrl}/result.png`;
      if (body?.model === TASK_QUEUE_CHANNEL.slowModelId) {
        const timer = setTimeout(() => {
          try {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ created: 1, data: [{ url: resultUrl }] }));
          } catch {
            /* 客户端已经走了 */
          }
        }, 60_000);
        res.on('close', () => clearTimeout(timer));
        res.on('error', () => {});
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: 1, data: [{ url: resultUrl }] }));
      return;
    }
    if (url.pathname.endsWith('/result.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': TQ_PNG_BYTES.length });
      res.end(TQ_PNG_BYTES);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no such path' }, path: url.pathname }));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (/\/generate-(image|video|audio|text)$/.test(url.pathname))
      generationRequests.push(`${req.method ?? 'GET'} ${url.pathname}`);
    const result = await dispatchApi(req.method ?? 'GET', url, Buffer.concat(chunks));
    res.writeHead(result.status, { 'content-type': String(result.type) });
    res.end(result.body);
    return;
  }

  // 画布产物：/canvas-app/*  ← lib/canvas/*
  if (url.pathname.startsWith('/canvas-app/')) {
    const rel = url.pathname.slice('/canvas-app'.length);
    const file = resolve(join(ROOT, 'lib', 'canvas'), `.${rel}`);
    if (!file.startsWith(join(ROOT, 'lib', 'canvas')) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
    return;
  }

  // 素材库静态资源（画布可能会请求它们）
  for (const prefix of ['/creative-presets', '/mj-styles']) {
    if (url.pathname.startsWith(prefix)) {
      const file = resolve(join(ROOT, 'public'), `.${url.pathname}`);
      if (existsSync(file) && !statSync(file).isDirectory()) {
        res.writeHead(200, { 'content-type': extname(file) === '.png' ? 'image/png' : 'image/webp' });
        res.end(readFileSync(file));
        return;
      }
    }
  }

  // 品牌图：host 半把 /aifisher-mark-white.svg 挂在根路径上（画布头部项目菜单的 logo）
  for (const name of ['aifisher-mark-white.svg', 'aifisher-mark-black.svg']) {
    if (url.pathname === `/${name}` || url.pathname === `/brand/${name}`) {
      const file = join(ROOT, 'public', 'brand', name);
      if (existsSync(file)) {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end(readFileSync(file));
        return;
      }
    }
  }

  res.writeHead(404).end('not found');
});

await new Promise((done) => server.listen(PORT, '127.0.0.1', done));
console.log(`[browser] 宿主页 http://127.0.0.1:${PORT}/`);

// ---------------------------------------------------------------- 截图

mkdirSync(SHOTS, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'dsh-aifisher-chrome-'));

/**
 * 打开 headless Chrome 抓一屏。
 *
 * `scale` = 这一场的 devicePixelRatio（`--force-device-scale-factor`）。
 * ⚠️ **默认 1 是有历史原因的，也是一个盲区**：v1.33 之前的网格把画布 translate 乘了
 * devicePixelRatio 再喂给 background-position，而 dpr=1 时那个乘子等于没写 ——
 * 整套真机检查在 1.0 下跑了十几轮全绿，用户 125% 缩放的屏幕上网格却比节点快 1.25 倍。
 * 所以「与 dpr 相关的几何」必须另有 dpr=1.25 那一次（见 SCENES 里的 grid-pan-hidpi）。
 * 其余场景的像素断言（间距 24px 之类）都是按 dpr=1 校准的，别整体改成 1.25 跑。
 */
function shoot(name, url, budgetMs = 12000, scale = '1') {
  /**
   * 每一场用**全新的 Chrome profile**。
   *
   * 复用同一个 user-data-dir 时偶发过「Failed to fetch dynamically imported module
   *  …/canvas-app/canvas-app.js」（同一进程连跑两三场之后，页面产物拉不下来；
   * v1.33 加 grid-pan-hidpi 时真撞到一次）。换成一次性 profile 后不再复用脏状态。
   * 删 profile 时可能撞上 Chrome 还没放开的文件句柄（Windows），所以失败就留给系统临时目录。
   */
  const shotProfile = mkdtempSync(join(profile, 'run-'));
  return new Promise((done) => {
    const out = join(SHOTS, `${name}.png`);
    rmSync(out, { force: true });
    const debug = !!process.env.BROWSER_DEBUG;
    const child = spawn(
      chromePath,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--force-device-scale-factor=${scale}`,
        '--window-size=1440,900',
        `--user-data-dir=${shotProfile}`,
        `--virtual-time-budget=${budgetMs}`,
        // BROWSER_DEBUG=1 时把浏览器 stderr（含页面 console）打到终端上：
        // 「没收到页面探针」以前完全查不到原因，这个开关是那类问题的取证手段。
        ...(debug ? ['--enable-logging=stderr', '--v=1'] : []),
        `--screenshot=${out}`,
        url,
      ],
      { stdio: debug ? 'inherit' : 'ignore' },
    );
    child.on('exit', (code) => {
      try {
        rmSync(shotProfile, { recursive: true, force: true });
      } catch {
        /* Windows 上句柄还没放开：留给系统临时目录 */
      }
      done({ name, out, code, exists: existsSync(out) });
    });
  });
}

/**
 * 等页面探针回传（页面每 250ms POST 一次）。
 *
 * ready 是个可选判据：页面刚加载时第一份探针往往是「画布还没渲染出来」的空壳，
 * 直接拿第一份会让断言看到 present:false 的假象。所以这里等到**第一份满足判据的**探针，
 * 超时仍未出现才退回最后一份（并让断言自己报出来是哪种情况）。
 */
async function waitForProbe(key, ready = () => true, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    const current = probes.get(key) ?? null;
    if (current) {
      last = current;
      if (ready(current)) return current;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  return last;
}

let browserFailures = 0;

/**
 * 任务队列场景的「运行中」怎么做出来的（v1.24）。
 *
 * 这里由 Node 侧直接往真插件路由发两发生成：
 *   · Fast 模型立刻回图 → 面板上一条「完成 · 1 个结果」；
 *   · Slow 模型的假端点故意不回 → 面板上留一条「运行中」，循环发光边框才有东西可量、可截。
 * **不能在页面里发**：headless 的 `--virtual-time-budget` 遇到未落地的网络请求会暂停虚拟时间，
 * 页面定时器跟着冻住 → 探针一条都发不出来（第一版就这么翻的车）。
 */
let slowGenerationPending = null;
async function seedTaskQueueScenario(projectId) {
  const fast = await dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/generate-image', ORIGIN),
    Buffer.from(
      JSON.stringify({
        projectId,
        nodeId: 'node-tq-fast',
        generationAttemptId: 'att-tq-fast',
        prompt: '截图里的已完成任务：一只猫在雨里走过霓虹街道',
        imageModel: `${TASK_QUEUE_CHANNEL.label} · ${TASK_QUEUE_CHANNEL.fastModelId}`,
        resolution: '1K',
        aspectRatio: '1:1',
      }),
      'utf8',
    ),
  );
  console.log(`[browser] 任务队列场景：Fast 模型生成 → ${fast.status}`);
  slowGenerationPending = dispatchApi(
    'POST',
    new URL('/api/aifisher/canvas/generate-image', ORIGIN),
    Buffer.from(
      JSON.stringify({
        projectId,
        nodeId: 'node-tq-slow',
        generationAttemptId: 'att-tq-slow',
        prompt: '运行中的任务：同一只猫，但这是慢模型',
        imageModel: `${TASK_QUEUE_CHANNEL.label} · ${TASK_QUEUE_CHANNEL.slowModelId}`,
        resolution: '1K',
        aspectRatio: '1:1',
      }),
      'utf8',
    ),
  )
    .then((result) => {
      console.log(`[browser] 任务队列场景：Slow 模型生成收尾 → ${result.status}`);
      return result;
    })
    .catch(() => null);
  // 让日记里那条 running 先落地，再开浏览器（面板首次拉取就能看到它）
  await new Promise((done) => setTimeout(done, 400));
}
// 第 5 位可选 = 这一场的 --virtual-time-budget（默认 12000ms）。场景里 wait() 走的都是**虚拟时间**，
// 动作多的场景（settings 要切四个分区再展开模型列表量布局）会把预算走完 —— 页面还没执行到
// 「立探针定时器」那一步就被截图退出，现象是「没收到页面探针」。
//
// BROWSER_ONLY=workflow-node（逗号分隔可给多个）只跑指定的几场：调一场的断言时不用等全套十场。
const SCENES = [
  // 看板场景等到「看板真的渲染出来」才算就绪：v1.15 加的两条断言都是看板头部的事，
  // 拿页面刚加载时的空壳探针会看出一堆假象（设置按钮数 0）。
  ['dashboard', `${ORIGIN}/`, 'default', (probe) => probe.resourceEntry?.dashboard === true],
  ['canvas', `${ORIGIN}/?resume=${projectId}`, `?resume=${projectId}`,
    (probe) => probe.header?.present === true],
  ['workflow-node', `${ORIGIN}/?resume=${projectId}&wf=1`, `?resume=${projectId}&wf=1`,
    (probe) => probe.workflowLayout?.rendered === true && probe.portDrag?.done === true, 24000],
  // 视觉取证：把鼠标提亮圆心钉在画布中央，截图里能直接看到「周围圆形变亮」
  // （用**空项目**：这块画布必须是干净的，否则对照区随时被别的场景建出来的节点占掉）
  ['glow', `${ORIGIN}/?resume=${emptyProjectId}&xglow=1`, `?resume=${emptyProjectId}&xglow=1`,
    (probe) => probe.header?.present === true],
  ['settings', `${ORIGIN}/?resume=${projectId}&settings=1`, `?resume=${projectId}&settings=1`,
    (probe) => probe.settings?.opened === true, 24000],
  // 画布互动开关（v1.27）：只开设置 → 画布外观，停在那一屏（截图 = 交付图）
  ['effects', `${ORIGIN}/?resume=${projectId}&settings=1&effects=1`, `?resume=${projectId}&settings=1&effects=1`,
    (probe) => probe.settings?.effectsShot?.panel === true, 20000],
  // 「OpenAI 通道」面板取证（v1.30）：只开设置 → 闭源服务，停在通道面板那一屏（截图 = 交付图）
  ['channels', `${ORIGIN}/?resume=${projectId}&settings=1&channels=1`, `?resume=${projectId}&settings=1&channels=1`,
    (probe) => probe.settings?.channelsShot?.panel === true, 24000],
  // 节点搜索：等到「Shift+A 那条链路整条走完」（假 ComfyUI 的那个工作流目录里就一份自定义工作流）
  ['node-search', `${ORIGIN}/?resume=${projectId}&search=1`, `?resume=${projectId}&search=1`,
    (probe) => probe.nodeSearch?.done === true],
  // ComfyUI 工作流配置面板（v1.16）：开面板 → 勾参数 → 保存 → 添加到画布 → 再打开（截图停在面板上）
  ['workflow-config', `${ORIGIN}/?resume=${projectId}&wfconf=1`, `?resume=${projectId}&wfconf=1`,
    (probe) => probe.workflowConfig?.done === true, 24000],
  // 右侧对话面板：等到「发出去的消息真的拿到了回答」才算就绪（探针每 250ms 重发一次）
  ['chat', `${ORIGIN}/?resume=${projectId}&chat=1`, `?resume=${projectId}&chat=1`,
    (probe) => probe.chatPanel?.replyText?.includes('建好节点了') === true],
  // 任务队列（v1.24）：面板 + 运行中那行的循环发光边框（真去读 computedStyle 的动画名）
  ['task-queue', `${ORIGIN}/?resume=${projectId}&tasks=1`, `?resume=${projectId}&tasks=1`,
    (probe) => probe.taskQueue?.done === true, 20000],
  // 图片编辑（v1.26）：真开 nova 工作台 → 真拖裁剪框 → 应用 → 「保存为新图片」落盘 → 画布多一个节点
  ['image-editor', `${ORIGIN}/?resume=${editProjectId}&xedit=studio`, `?resume=${editProjectId}&xedit=studio`,
    (probe) => probe.imageEditor?.done === true, 30000],
  // 标注 / 蒙版舞台（v1.26）：真画一笔 → 应用编辑 → 保存 → 再打开，截图停在舞台上
  ['image-annotate', `${ORIGIN}/?resume=${editProjectId}&xedit=annotate`, `?resume=${editProjectId}&xedit=annotate`,
    (probe) => probe.imageEditor?.done === true, 34000],
  // 保存结果回看：画布上应该已经有「源图 + 裁剪结果」两个节点（截图给人眼看）
  ['image-saved', `${ORIGIN}/?resume=${editProjectId}&xedit=saved`, `?resume=${editProjectId}&xedit=saved`,
    (probe) => Array.isArray(probe.editCanvas) && probe.editCanvas.length >= 2, 20000],
  /**
   * 宫格裁剪（v1.46）：用户「画布宫格裁剪 ui 还没有更新」。
   * 场景 = 工具条「宫格裁剪」→ nova 舞台 → 真拖竖向切线 → 3×3 → 导出序号 1,3 →
   * 保存（画布上真的多出 2 个媒体节点）→ 再打开舞台截图（交付图）。
   */
  ['image-grid', `${ORIGIN}/?resume=${editProjectId}&xedit=grid`, `?resume=${editProjectId}&xedit=grid`,
    (probe) => probe.imageEditor?.done === true, 34000],
  /**
   * 网格跟随画布的**速度**（v1.33）：用户报「移动画布时网格比节点快」。
   * 同一块空画布跑两遍 —— dpr=1（历史默认，也是这个 bug 一直没被抓到的原因）与
   * dpr=1.25（本机 125% 缩放；根因就是网格把 translate 乘了 dpr）。
   * 两遍验的是同一件事：网格位移 ÷ 节点位移 = 1.000，格子边长 = 24 × zoom（CSS px）。
   * 第二遍的 URL 多一个 `xhidpi=1`，只是为了让页面探针的 key（= location.search）区分开。
   */
  ['grid-pan', `${ORIGIN}/?resume=${emptyProjectId}&xgridpan=1`, `?resume=${emptyProjectId}&xgridpan=1`,
    (probe) => probe.gridPan?.done === true, 20000, '1'],
  ['grid-pan-hidpi', `${ORIGIN}/?resume=${emptyProjectId}&xgridpan=1&xhidpi=1`, `?resume=${emptyProjectId}&xgridpan=1&xhidpi=1`,
    (probe) => probe.gridPan?.done === true, 20000, '1.25'],
  // 叠图「切换」（v1.37）：一叠 3 张（红/绿/蓝三张 PNG），真点「切换」→ 卡上的图真的换、计数跟走、节点数不变
  ['stack', `${ORIGIN}/?resume=${stackProjectId}&xstack=1`, `?resume=${stackProjectId}&xstack=1`,
    (probe) => probe.stack?.done === true, 22000],
  // 视频生成历史（v1.64）：药丸 → 摊开（在节点外面、不被剪）→ 设为主视频（主片换成蓝的那条）
  // v1.66 同一场再加「截帧」：截尾帧（只 1 张、真解码）→ 首尾帧（共 3 张，落在视频右侧）
  ['video-history', `${ORIGIN}/?resume=${videoHistoryProjectId}&xvideo=1`, `?resume=${videoHistoryProjectId}&xvideo=1`,
    (probe) => probe.videoHistory?.done === true, 26000],
  // 视频参考图数量（v1.65）：真拖 10 次线 → 9 张接上、第 10 张被拒（修复前只到 3 张）
  ['video-references', `${ORIGIN}/?resume=${videoRefsProjectId}&xvideorefs=1`, `?resume=${videoRefsProjectId}&xvideorefs=1`,
    (probe) => probe.videoRefs?.done === true, 32000],
  // 扩图（v1.38）：工具条「扩图」→ 面板 → 创建 → 画布上多一个**空**节点（提示词已填），一条生成请求都没发
  ['outpaint', `${ORIGIN}/?resume=${outpaintProjectId}&xoutpaint=1`, `?resume=${outpaintProjectId}&xoutpaint=1`,
    (probe) => probe.outpaint?.done === true, 26000],
  // 扩图面板（v1.38）：只开面板不创建 —— 交付图「入口长什么样」
  ['outpaint-panel', `${ORIGIN}/?resume=${outpaintProjectId}&xoutpaint=panel`, `?resume=${outpaintProjectId}&xoutpaint=panel`,
    (probe) => probe.outpaint?.done === true, 24000],
  // 尺寸（v1.38）：nova 版对话框真开、2x → 640×480、保存后画布上那张新图真是 640×480
  ['resize', `${ORIGIN}/?resume=${resizeProjectId}&xresize=1`, `?resume=${resizeProjectId}&xresize=1`,
    (probe) => probe.resize?.done === true, 26000],
  // 新节点默认用上一次的模型（v1.40）：真建三个图片节点 —— 没记过 / 记一次 / reset 后各一个
  ['last-model', `${ORIGIN}/?resume=${lastModelProjectId}&xlastmodel=1`, `?resume=${lastModelProjectId}&xlastmodel=1`,
    (probe) => probe.lastModel?.done === true, 26000],
  /**
   * 任务队列「只在画布这一层」（v1.41）：用户 2026-10-18 原话「任务队列希望只出现在画布这一层，
   * 现在点击设置啥的都看的见任务队列」。
   * 场景：画布上先确认面板在场 → 开设置 → 面板必须 display:none、原位置 elementFromPoint
   * 不再命中队列、且面板带 inert（浮层接管画布层）→ 停在这一屏截图（交付图）。
   */
  ['queue-layers', `${ORIGIN}/?resume=${projectId}&qlayers=1`, `?resume=${projectId}&qlayers=1`,
    (probe) => probe.queueLayers?.done === true, 26000],
  /**
   * 项目归档（v1.42）：用户 2026-10-18 原话「在无限画布面板做一个项目导出导入的功能」。
   * 场景：头部「项目归档」按钮（先确认它真的是命中目标）→ 面板规模读数 → 真点「导出到目录」
   * → 面板上出现成功提示（含落盘路径）。文件是否真落地由 node 侧在截图后去 downloads/ 核对。
   */
  ['archive', `${ORIGIN}/?resume=${archiveProjectId}&xarchive=1`, `?resume=${archiveProjectId}&xarchive=1`,
    (probe) => probe.archive?.done === true, 26000],
  /**
   * 项目数据目录（v1.43）：用户 2026-10-18 原话「设置里添加项目自定义缓存目录」。
   * 场景：开设置 → 切「存储」→ 等「项目数据目录（缓存）」面板挂上 → 停在这一屏（截图 = 交付图）。
   */
  ['data-dir', `${ORIGIN}/?resume=${projectId}&settings=1&ddir=1`, `?resume=${projectId}&settings=1&ddir=1`,
    (probe) => probe.settings?.dataDirShot?.panel === true, 24000],
  /**
   * 切刀（v1.49）：用户「像blender一样按住ctrl加鼠标右键切换到切刀工具，划过的线会断开连接」。
   * 场景：真派发 Ctrl + 右键拖拽划过 A→C → 只断开这一条（B→C 还在）→ 第二刀停在拖拽中当交付图。
   */
  ['knife', `${ORIGIN}/?resume=${knifeProjectId}&xknife=1`, `?resume=${knifeProjectId}&xknife=1`,
    (probe) => probe.knife?.done === true, 26000],
];
const onlyScenes = String(process.env.BROWSER_ONLY ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
for (const [label, url, probeKey, probeReady, budgetMs, scale] of onlyScenes.length
  ? SCENES.filter(([label]) => onlyScenes.includes(label))
  : SCENES) {
  // 任务队列那两发要**在开浏览器之前**发（原因见 seedTaskQueueScenario 的说明）
  if (label === 'task-queue') await seedTaskQueueScenario(projectId);
  // 每一场开始时记一下 host 已经收到几条生成请求：扩图那一场要证明「一条都没有新增」
  const generationBefore = generationRequests.length;
  const shot = await shoot(`canvas-${label === 'dashboard' ? 'dashboard' : label}`, url, budgetMs, scale ?? '1');
  const size = shot.exists ? statSync(shot.out).size : 0;
  console.log(`[browser] 截图 ${label}: exit=${shot.code} ${size} bytes (dpr=${scale ?? '1'}) → ${shot.out}`);

  // 越界断言：画布的定位元素不许越过侧边栏右缘（fixed→absolute 补丁的回归网）
  const probe = await waitForProbe(probeKey, probeReady);
  if (!probe) {
    browserFailures += 1;
    console.log(`[browser] FAIL  ${label}: 没收到页面探针（画布可能没挂起来）`);
    continue;
  }
  if (probe.bootError) {
    browserFailures += 1;
    console.log(`[browser] FAIL  ${label}: 画布产物加载/挂载失败：${probe.bootError}`);
    continue;
  }
  const ok = probe.leaks.length === 0;
  if (!ok) browserFailures += 1;
  console.log(
    `[browser] ${ok ? 'PASS' : 'FAIL'}  ${label}: 画布未越界到侧边栏（侧边栏右缘 ${probe.sidebarRight}px，画布头部 left=${probe.headerLeft}px）` +
      (ok ? '' : `\n        越界元素：\n          ${probe.leaks.join('\n          ')}`),
  );
  if (probe.headerLeft >= 0 && probe.headerLeft < probe.sidebarRight) {
    browserFailures += 1;
    console.log(`[browser] FAIL  ${label}: 画布头部仍在侧边栏上方（left=${probe.headerLeft} < ${probe.sidebarRight}）`);
  }
  if ((probe.errors ?? []).length > 0) {
    browserFailures += 1;
    console.log(`[browser] FAIL  ${label}: 画布运行时错误 ${JSON.stringify(probe.errors)}`);
  }

  // v1.15：看板头部那两个站外入口（用户「移除这两个功能」）—— 真浏览器里再确认一遍，
  // 顺带守住「移除没连坐同文件注入的设置按钮」。
  if (label === 'dashboard') {
    const entry = probe.resourceEntry ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('看板头部没有站外入口（AIFISHER API 与服务 / Work-Fisher 教程与案例）',
      entry.dashboard === true && entry.navs === 0 && entry.links === 0 && entry.stale === false,
      JSON.stringify(entry));
    report('看板头部的「设置」按钮仍在', entry.settings >= 1, JSON.stringify(entry));
    // v1.42：项目库头部必须有「导入项目」按钮（看板视图里画布面板没挂载，导入只能从这儿进）
    report('看板头部有「导入项目」按钮（v1.42）', entry.importButton >= 1, JSON.stringify(entry));
  }

  // 本地工作流节点场景：真建出节点 + 量布局（jsdom 量不了这些）
  if (label === 'workflow-node') {
    const layout = probe.workflowLayout;
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('菜单三步点完能建出本地工作流节点',
      layout?.rendered === true && layout.add && layout.submenu && layout.workflow,
      JSON.stringify(layout ? { add: layout.add, submenu: layout.submenu, workflow: layout.workflow, rendered: layout.rendered } : layout));
    if (layout?.rendered) {
      report('节点自己写回的尺寸够放下表单（宽 ≥ 600）', layout.frame.width >= 600,
        `${layout.frame.width}x${layout.frame.height}`);
      report('左侧素材槽的 + 按钮圆心落在节点左缘（连线端点对齐）',
        layout.slots.length > 0 && layout.slotsOnLeftEdge,
        `frame=${JSON.stringify(layout.frame)} slots=${JSON.stringify(layout.slots)}`);
      if (layout.slotPitch !== null)
        report('多槽之间按 34px 间距排（与 legacyPortY 一致）', layout.slotPitch === 34, `pitch=${layout.slotPitch}`);
      report('下拉/提示词/生成按钮都在节点框内',
        layout.pickerInside && layout.promptInside && layout.generateInside,
        JSON.stringify({ picker: layout.pickerInside, prompt: layout.promptInside, generate: layout.generateInside }));
      report('渲染出模板里的参数控件', layout.parameterCount >= 3, `params=${layout.parameterCount}`);
      // ---- v1.20：节点布局重排（参数横跨整宽两列；以前挤在右边一列、左边空一片）
      report('参数区是横跨整宽的两列网格（data-columns=2，宽度撑到节点内缘）',
        layout.parameterGrid?.columns === '2' &&
          Number(layout.parameterGrid?.width) >= layout.frame.width - 40 &&
          layout.parameterGrid?.box === true,
        JSON.stringify(layout.parameterGrid));
      report('参数格是「标签 + 控件」左右排（同一行，不是叠着）',
        layout.firstParameterColumns?.sameRow === true &&
          layout.firstParameterColumns.controlLeft > layout.firstParameterColumns.labelRight,
        JSON.stringify(layout.firstParameterColumns));
      report('提示词框够宽（v1.20：≥ 380px，不再只有右半边的三分之一）',
        Number(layout.promptBox?.width) >= 380 && Number(layout.promptBox?.height) >= 100,
        JSON.stringify(layout.promptBox));
      // ---- v1.21：负向提示词框与它的文本槽（真浏览器里量，jsdom 量不出位置关系）
      report('负向提示词槽渲染出来了（文本节点能接进第二个槽）',
        layout.negativeSlot === true);
      report('负向提示词框在提示词框正下方（同一个右列、间距 10px、不出框）',
        !!layout.negativeBox &&
          layout.negativeBox.inside === true &&
          layout.negativeBox.sameLeft === true &&
          layout.negativeBox.gapToPrompt >= 8 &&
          layout.negativeBox.gapToPrompt <= 12 &&
          Number(layout.negativeBox.height) >= 50,
        JSON.stringify(layout.negativeBox));
      report('节点宽度按布局写回（v1.20：720）', layout.frame.width === 720,
        `${layout.frame.width}`);
    }
    // ---- v1.25：接入口判定 + 端口跟着指针放大/发光（真拖一条线，不是看 CSS）
    const port = probe.portDrag ?? {};
    const portReport = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const glowScale = (() => {
      const match = /^matrix\(([\d.]+)/.exec(String(port.glow?.transform ?? ''));
      return match ? Number(match[1]) : 0;
    })();
    portReport('接入口探针跑完了（真拖线，没有半途报错）',
      port.done === true && !port.error,
      String(port.error ?? '').slice(0, 240));
    // v1.47「从图像拉出的线与鼠标指针有很大偏差」：虚线自由端必须落在指针上
    portReport('拖出来的虚线跟着指针（自由端与指针偏差 ≤ 2px）',
      port.tempLine?.found === true &&
        Math.abs(Number(port.tempLine?.delta?.[0])) <= 2 &&
        Math.abs(Number(port.tempLine?.delta?.[1])) <= 2,
      JSON.stringify(port.tempLine ?? null));
    // v1.31「新建节点默认模型不是我配的那个」：现场预置的通道模型别名是「魔搭出图」，
    // 这颗新建的图片节点上就该是它，而不是上游内置的 GPT Image 2 · API。
    portReport('新建 Image 节点的默认模型 = 通道里勾的模型（不再是上游内置 GPT Image 2 · API）',
      port.sourceModel?.hasChannelModel === true && port.sourceModel?.hasVendorDefault === false,
      JSON.stringify(port.sourceModel ?? null));
    portReport('「+」圆的圆心压在节点左缘上（连线端点与端口对齐）',
      port.target?.onEdge === true && Number(port.target?.slotCount) >= 2,
      JSON.stringify({ slots: port.target?.slotCount, onEdge: port.target?.onEdge }));
    portReport('圆的外半边在节点框外面（命中要按圆算，不能只看节点矩形）',
      port.target?.outsideHalf === true);
    portReport('瞄准「+」圆的外半边拖过去，落点就是那一槽（不再歪到别的槽）',
      port.drop?.aimOutsideNode === true && port.drop?.landOnAimedSlot === true,
      JSON.stringify({
        aimOutsideNode: port.drop?.aimOutsideNode,
        edges: port.drop?.targetEdges,
        // 判定失败时最有用的是「瞄准点下面到底是哪个元素」与拖线手势有没有起来
        ...(port.drop?.aimOutsideNode === true && port.drop?.landOnAimedSlot === true
          ? {}
          : { diagnose: port.diagnose, start: port.start, kinds: port.kinds }),
      }));
    portReport('端口接上的那次没有弹「新建节点」菜单（旧实现会把端口当成没命中节点）',
      port.drop?.menuOpened === false);
    portReport('拖到槽旁边时那颗「+」真的放大 + 发光（computedStyle 里读到的）',
      glowScale > 1.05 && String(port.glow?.boxShadow ?? 'none') !== 'none',
      JSON.stringify({ transform: port.glow?.transform, boxShadow: port.glow?.boxShadow }));
    portReport('瞄着文本槽丢图片节点：不接，也不自动挪到别的槽接上',
      Array.isArray(port.invalidDrop?.textSlotEdges) && port.invalidDrop.textSlotEdges.length === 0,
      JSON.stringify({ textSlotEdges: port.invalidDrop?.textSlotEdges, edgeDelta: port.invalidDrop?.edgeDelta }));
    portReport('那次不兼容的落点也没弹菜单、没凭空多出节点',
      port.invalidDrop?.menuOpened === false && Number(port.invalidDrop?.nodeDelta) === 0,
      JSON.stringify({ menuOpened: port.invalidDrop?.menuOpened, nodeDelta: port.invalidDrop?.nodeDelta }));
    if (process.env.BROWSER_DEBUG) console.log(`[browser][port] ${JSON.stringify(port)}`);
  }

  /**
   * 「ComfyUI 工作流配置」面板场景（?wfconf=1，v1.16）。
   * jsdom 已经把逻辑验完了（test:workflow-config），这里量的是真浏览器里的
   * 尺寸/容器归属/真点击链路（点按钮 → 保存 → 落节点）。
   */
  if (label === 'workflow-config') {
    const scene = probe.workflowConfig ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('点左栏第三个按钮打开「ComfyUI 工作流配置」面板', scene.opened === true,
      JSON.stringify({ items: scene.items, rows: scene.rows }));
    report('面板在画布容器里（配色继承画布主题，不飘到 DSH 页面上）', scene.insideCanvas === true);
    report('面板尺寸像样（宽 ≥ 720、高 ≥ 460）',
      Number(scene.box?.width) >= 720 && Number(scene.box?.height) >= 460, JSON.stringify(scene.box));
    report('左栏列出目录里的自定义工作流', Number(scene.items) >= 1, String(scene.items));
    report('右栏列出候选字段（可勾选的清单）', Number(scene.rows) >= 5, String(scene.rows));
    report('顶部显示「已选 N / M」', Number(scene.selectedCount) >= 1, String(scene.selectedCount));
    report('底栏工作流目录是可编辑输入框（v1.18：目录能自己改）',
      scene.dirEditable === true && Number(scene.dirWidth) >= 120,
      JSON.stringify({ editable: scene.dirEditable, width: scene.dirWidth, value: scene.dirValue }));
    report('目录输入框带的是当前目录（默认目录以 workflows 结尾）',
      /workflows[\\/]?$/i.test(String(scene.dirValue ?? '')), String(scene.dirValue ?? ''));
    report('「应用目录」按钮真渲染出来（不是 0 宽）', scene.applyVisible === true);
    report('底栏「扫描 ComfyUI」按钮真渲染出来（v1.20：扫 /object_info 拿下拉候选）',
      scene.scanComfyVisible === true);
    report('点「保存配置」成功（底栏出现 ok 提示）', scene.saved === true, String(scene.notice ?? ''));
    report('保存后面板不再标「有未保存改动」', scene.dirtyAfterSave === 'false', String(scene.dirtyAfterSave));
    report('「添加到画布」之后面板关掉', scene.addClosed === true);
    report('画布上真的多出一个节点', Number(scene.nodeDelta) >= 1, String(scene.nodeDelta));
    report('新节点的下拉框指向那份工作流',
      (scene.pickerValues ?? []).includes('custom-browser-t2i'), JSON.stringify(scene.pickerValues ?? []));
    report('截图停在面板上（交付物看得见的东西）', scene.reopened === true);
    // ---- v1.19：节点图 + 点节点配字段（参考图那套交互）
    report('中间是节点图（有节点有连线，真浏览器里量得到尺寸）',
      Number(scene.graphNodes) >= 5 &&
        Number(scene.graphEdges) >= 4 &&
        Number(scene.graphBox?.width) >= 400 &&
        Number(scene.graphBox?.height) >= 220,
      JSON.stringify({ nodes: scene.graphNodes, edges: scene.graphEdges, box: scene.graphBox }));
    report('「适应窗口」按钮真渲染出来，并且算出了可用缩放',
      scene.fitVisible === true && Number(scene.graphZoom) > 0,
      JSON.stringify({ fit: scene.fitVisible, zoom: scene.graphZoom }));
    report('图上滚轮真的缩放（原生非 passive 监听接上了，不是被画布吞掉）',
      Number(scene.wheelZoom) > Number(scene.graphZoom),
      JSON.stringify({ before: scene.graphZoom, after: scene.wheelZoom }));
    report('节点卡的视觉宽度 = host 的 170 × 图缩放（量纲对得上，没被二次缩放）',
      Number(scene.nodeWidth) > 0 &&
        Math.abs(Number(scene.nodeWidth) - 170 * Number(scene.graphZoom)) <= 1.5,
      JSON.stringify({ nodeWidth: Math.round(Number(scene.nodeWidth)), zoom: scene.graphZoom }));
    report('点节点 → 右侧检查器切成「这个节点」（不是全部字段）',
      String(scene.inspectorMode ?? '') !== '' &&
        String(scene.inspectorMode) !== 'all' &&
        Number(scene.inspectorRows) >= 1,
      JSON.stringify({ mode: scene.inspectorMode, rows: scene.inspectorRows }));
    report('检查器标题是「节点标题 · #id」',
      /#\d+/.test(String(scene.inspectorTitle ?? '')), String(scene.inspectorTitle ?? ''));
    report('截图停在「图 + 节点检查器」这一屏（交付图看得见参考图那种形态）',
      scene.nodeSelected === 'true' &&
        Number(scene.inspectorBox?.width) >= 200 &&
        Number(scene.inspectorBox?.height) >= 200,
      JSON.stringify({ selected: scene.nodeSelected, box: scene.inspectorBox }));
    if (scene.error) console.log(`[browser] 场景异常：${String(scene.error).slice(0, 300)}`);
  }

  /**
   * 右侧对话面板场景（?chat=1）：聊天框控制画布这条链的真机表现。
   */
  if (label === 'chat') {
    const panel = probe.chatPanel ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('点画布右下角的启动球能打开右侧对话面板',
      panel.launcherPresent === true && panel.opened === true,
      JSON.stringify({ launcher: panel.launcherPresent, opened: panel.opened }));
    report('面板贴在画布面板右缘（fixed→absolute 补丁，不越过 DSH 侧边栏）',
      panel.dockedRight === true && panel.panelInsideCanvas === true,
      JSON.stringify({ dockedRight: panel.dockedRight, panelBox: panel.panelBox, mountRight: panel.mountRight }));
    report('面板宽度正常（240~640px，没被压成一条）',
      panel.widthLooksRight === true, `${panel.panelBox?.width}px`);
    report('助手启动球不与「退出画布」按钮重叠',
      panel.launcherAboveExit === true, '');
    report('在面板里发一条消息能拿到回答（面板 → host → DSH 会话 → SSE → 回填）',
      panel.sent === true && String(panel.replyText ?? '').includes('建好节点了'),
      String(panel.replyText ?? '').slice(0, 200));
    report('面板上显示的是 DSH 那边的模型名（模型下拉不为空）',
      String(panel.text ?? '').includes('假对话模型'),
      String(panel.text ?? '').slice(0, 160));
    report('面板里没有「尚未移植 / 读取失败」这类噪声（批次与预算清单回空数组，不挂红字）',
      !/尚未移植|读取失败|批次记录读取失败/.test(String(panel.text ?? '')),
      String(panel.text ?? '').slice(0, 200));
  }

  /**
   * 画布场景（v1.2）：ComfyUI 状态胶囊。参考图里它常驻头部（余额左边），
   * 我们这边没有账号中继，所以它停靠在 header 的账号插槽位置。
   */
  if (label === 'canvas') {
    const chip = probe.comfyChip;
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('画布头部有 ComfyUI 状态胶囊（不托管进程时也要显示真实状态）',
      !!chip && chip.inHeader === true,
      chip ? JSON.stringify(chip) : 'missing');
    report('胶囊文案来自 host 的真实 phase（待启动 / 运行中…）',
      !!chip && /ComfyUI/.test(chip.text), chip?.text ?? '');
    /**
     * v1.36：用户原话「把右上角的 comfui 待启动移动到左边」。
     * 只量「在不在头部」不够 —— 必须确认它真在**左半边**（胶囊以前停在右侧账号插槽）。
     */
    report('ComfyUI 胶囊停在头部**左半边**（从右上角移到左边）',
      !!chip && !!probe.header?.rect && chip.rect.left + chip.rect.width / 2 <
        probe.header.rect.left + probe.header.rect.width / 2,
      JSON.stringify({
        chipCenter: chip ? chip.rect.left + chip.rect.width / 2 : null,
        headerMiddle: probe.header?.rect ? probe.header.rect.left + probe.header.rect.width / 2 : null,
      }));
    report('ComfyUI 胶囊停靠在左侧专用槽位（dock=topbar-left）',
      chip?.docked === 'topbar-left', String(chip?.docked));

    // 账号系统已于 2026-10-16 整体移除：插槽还在（胶囊靠它定位），我们的入口必须不在
    const account = probe.accountSlot ?? { slotPresent: false, ourEntryPresent: true };
    report('账号插槽仍在（ComfyUI 胶囊靠它停在头部）', account.slotPresent === true, JSON.stringify(account));
    report('画布头部不再有我们自己的账号入口（已移除）',
      account.ourEntryPresent === false, JSON.stringify(account));

    // shadcn 重设计：头部的三个可见件必须真在页面上、且有正常尺寸
    const header = probe.header ?? { present: false };
    report('画布头部渲染出 shadcn 版内容（标题 + 项目菜单 + 保存状态）',
      header.present === true &&
        (header.menu?.w ?? 0) >= 16 &&
        (header.title?.w ?? 0) >= 20 &&
        (header.badge?.w ?? 0) >= 20,
      JSON.stringify(header));
    report('头部标题显示当前项目名',
      typeof header.titleText === 'string' && header.titleText.length > 0,
      header.titleText ?? '(none)');
    report('保存状态徽标文案可读（尚未保存 / 未保存 / 保存中 / 已保存）',
      /尚未保存|未保存|保存中|已保存/.test(String(header.badgeText ?? '')),
      header.badgeText ?? '(none)');

    /**
     * v1.36：用户原话「在画布左上角添加返回项目库按钮」。
     * 这条同时守住了「头部真的画在画布之上」——以前头部被 #canvas-background 整块盖住，
     * 盒子照样量得到尺寸（所以老断言一直是绿的），但用户什么都看不见、也点不到。
     */
    report('左上角有「返回项目库」按钮（真的可见：尺寸够 + 命中测试落在头部内）',
      !!header.back && header.back.w >= 40 && header.back.h >= 20 &&
        header.onTop?.inside === true,
      JSON.stringify({ back: header.back, onTop: header.onTop }));
    report('「返回项目库」按钮带 aria-label=返回项目库（可访问）',
      header.backLabel === '返回项目库', String(header.backLabel));
    report('头部真的压在画布之上（不是被画布底盘盖住；z-index 生效）',
      header.onTop?.inside === true && String(header.zIndex) !== 'auto' &&
        String(header.background) !== 'rgba(0, 0, 0, 0)',
      JSON.stringify({ onTop: header.onTop, zIndex: header.zIndex, background: header.background }));
    report('头部右侧有 ComfyUI 胶囊的兜底槽位（结构契约还在）',
      !!probe.accountSlot?.slotPresent, JSON.stringify(probe.accountSlot ?? null));

    /**
     * 画布点阵底纹（小十字星 + 鼠标圆形提亮）。
     * 这几条只能在真机验：背景图是不是真的被算成 svg、格子大小跟不跟缩放、
     * 鼠标遮罩圆心是不是落在指针局部坐标。
     */
    const grid = probe.grid ?? { present: false };
    report('画布底盘里有十字星点阵层（且在最底层，节点压它上面）',
      grid.present === true && grid.inBackground === true && grid.isFirstChild === true,
      JSON.stringify({ present: grid.present, inBackground: grid.inBackground, isFirstChild: grid.isFirstChild }));
    if (grid.present) {
      report('点阵是 SVG 图（data:image/svg+xml）',
        /data:image\/svg\+xml/.test(String(grid.backgroundImage ?? '')),
        String(grid.backgroundImage ?? '').slice(0, 80));
      report('点阵规格来自常量：24px 间距 + 7×1 小十字星（v1.8：把点换成小十字星）',
        grid.star?.spacing === '24' && grid.star?.size === '7x1',
        JSON.stringify(grid.star ?? null));
      report('平铺块 1:1 绘制（viewBox = 间距，星号按真实 7px 渲染、不被拉伸）',
        Number(grid.tile?.width) === 24 && grid.tile?.viewBox === '24 24',
        JSON.stringify(grid.tile ?? null));
      report('标记形状是「一横一竖」的十字（不是方块点）',
        grid.tile?.cross === true && Number.parseFloat(String(grid.tile?.strokeWidth ?? '0')) <= 1.2,
        JSON.stringify(grid.tile ?? null));
      // v1.7 的事故：SVG 背景写成 currentColor → 图片文档里解析成黑色 → 深色画布上等于没有网格。
      report('星号颜色写死在 SVG 里（没有 currentColor）',
        grid.tile?.currentColor === false, JSON.stringify(grid.tile ?? null));
      report('暗色主题墨色是亮色 + 19% 不透明（真机上真的会画出来）',
        String(grid.tile?.stroke ?? '').toLowerCase() === '#ffffff' &&
          Math.abs(Number.parseFloat(String(grid.tile?.strokeOpacity ?? '0')) - 0.19) < 0.001,
        JSON.stringify({ stroke: grid.tile?.stroke, opacity: grid.tile?.strokeOpacity }));
      report('点阵层不抢指针事件（pointer-events: none）',
        grid.pointerEvents === 'none', String(grid.pointerEvents));
      report('点阵层有画布尺寸（铺满底盘）',
        (grid.rect?.w ?? 0) > 100 && (grid.rect?.h ?? 0) > 100,
        JSON.stringify(grid.rect));
      const sizeOf = (value) => Number.parseFloat(String(value ?? '').match(/[\d.]+/)?.[0] ?? '0');
      const before = sizeOf(grid.before?.size);
      const after = sizeOf(grid.after?.size);
      report('格子间距按 24px 铺（真机算出的 background-size 落在 22–27px）',
        before >= 22 && before <= 27, `${grid.before?.size} (zoom=${grid.before?.zoom} dpr=${grid.before?.dpr})`);
      // 「跟着画布缩放/平移走」用变量桩验：把 --canvas-grid-zoom 置 2、--canvas-grid-pan-x 置 33，
      // 计算样式里的格子尺寸/定位必须跟着变（Chrome 会把 calc 算成像素，只能这样反证绑定）。
      const boundSize = sizeOf(grid.bound?.size);
      report('放大画布时格子同步变宽（缩放变量 ×2 → 背景尺寸翻倍）',
        boundSize > before * 1.8 && boundSize < before * 2.2,
        `zoom:1→2 ⇒ ${grid.before?.size} → ${grid.bound?.size}`);
      report('平移画布时点阵跟着走（平移变量 33px → 背景定位右移 33px）',
        /33px/.test(String(grid.bound?.position ?? '')),
        `pan-x:0→33 ⇒ ${grid.restored?.position} → ${grid.bound?.position}`);
      report('画布 transform 已被底纹读成变量（pan/zoom 接线通了）',
        Number.parseFloat(String(grid.before?.zoom ?? '0')) > 0 &&
          Number.parseFloat(String(grid.before?.dpr ?? '0')) > 0 &&
          grid.panFromTransform !== null && Number.isFinite(grid.panFromTransform),
        `zoom=${grid.before?.zoom} dpr=${grid.before?.dpr} panX=${grid.panFromTransform}`);
      report('鼠标在画布上时提亮圆心 = 指针位置（圆形区域变亮）',
        grid.hover?.maskX === grid.hover?.expectedX &&
          grid.hover?.maskY === grid.hover?.expectedY &&
          grid.hover?.highlightOpacity === '1',
        JSON.stringify(grid.hover));
      report('真实命中路径下提亮圆心 = 指针位置（事件派发在 #canvas-background、不冒泡：只有 window 捕获监听收得到）',
        grid.realHover?.maskX === grid.realHover?.expectedX &&
          grid.realHover?.maskY === grid.realHover?.expectedY &&
          grid.realHover?.highlightOpacity === '1',
        JSON.stringify(grid.realHover));
      report('提亮半径是有限值（圆形范围被夹住）',
        Number.parseFloat(String(grid.hover?.maskRadius ?? '0')) >= 40 &&
          Number.parseFloat(String(grid.hover?.maskRadius ?? '0')) <= 190,
        String(grid.hover?.maskRadius));
      /**
       * v1.27「在设置里做一个开关」：真机验两条 —— 关掉后网格层自报 off 且指针完全不再画
       * （监听真的摘掉了，不是拿透明度遮），打开后立刻恢复。
       */
      report('「画布互动」开关能关掉：网格层自报 off + 提亮层复位',
        grid.effectsProbe?.available === true &&
          grid.effectsProbe?.off?.interactive === 'off' &&
          grid.effectsProbe?.off?.highlightOpacity === '0',
        JSON.stringify(grid.effectsProbe?.off ?? null));
      report('关掉之后真实指针再走过也不亮（指针监听真的摘掉了）',
        grid.effectsProbe?.afterOffMove?.maskX === '-9999px' &&
          grid.effectsProbe?.afterOffMove?.highlightOpacity === '0',
        JSON.stringify(grid.effectsProbe?.afterOffMove ?? null));
      report('重新打开后立刻恢复：指针再走一次就亮（interactive=on）',
        grid.effectsProbe?.on?.interactive === 'on' &&
          grid.effectsProbe?.afterOnMove?.maskX === grid.effectsProbe?.afterOnMove?.expectedX &&
          grid.effectsProbe?.afterOnMove?.maskY === grid.effectsProbe?.afterOnMove?.expectedY &&
          grid.effectsProbe?.afterOnMove?.highlightOpacity === '1',
        JSON.stringify(grid.effectsProbe?.afterOnMove ?? null));
      report('开关状态真的落在本机 localStorage（pointerGlow）',
        String(grid.effectsProbe?.stored ?? '').includes('pointerGlow'),
        String(grid.effectsProbe?.stored ?? '(null)'));
      report('指针离开窗口后提亮层复位（画面上不留残留光斑）',
        grid.cleared?.maskX === '-9999px' && grid.cleared?.highlightOpacity === '0',
        JSON.stringify(grid.cleared ?? null));
      report('诊断读数带上互动开关与指针跟随状态（真机排查用）',
        grid.moduleReport?.interactive === 'on' &&
          grid.moduleReport?.effects?.settings?.pointerGlow === true &&
          grid.moduleReport?.pointer?.listening === true &&
          (grid.moduleReport?.pointer?.paints ?? 0) > 0,
        JSON.stringify({
          interactive: grid.moduleReport?.interactive,
          effects: grid.moduleReport?.effects,
          pointer: grid.moduleReport?.pointer,
        }));

      /**
       * **像素级断言**（v1.8 新增）：上面全是 DOM/CSS 口径的检查，v1.7 就是在这种
       * 「全绿」下画了一堆看不见的黑十字。所以这里真去读截图像素：
       *   ① 空白画布区块里必须有比底色亮的星号像素（真画出来了，且是亮色）；
       *   ② 同一行左移 24px 后与原图最像 —— 真实渲染间距就是 24px（不是只写在 CSS 里）；
       *   ③ 星号要够淡（参考图的墨色 ≈ alpha 0.19）—— 亮成一片白同样不对。
       */
      const canvasRect = grid.rect ?? { left: 240, top: 48, w: 1176, h: 808 };
      const area = {
        left: canvasRect.left + 8,
        // 顶部 56px 是画布头部（标题/胶囊），别把它的像素当成底纹
        top: canvasRect.top + 56,
        width: Math.max(0, canvasRect.w - 16),
        height: Math.max(0, canvasRect.h - 64),
      };
      try {
        const png = decodePngGray(shot.out);
        const quiet = quietBlock(png, area, 120);
        const pattern = measureGridPattern(png, quiet);
        report('点阵真的画到像素上了（空白区块最亮像素比底色亮 ≥25）',
          pattern.inkMax - pattern.background >= 25,
          JSON.stringify({ ...pattern, quiet: { left: quiet.left, top: quiet.top, std: Number(quiet.std.toFixed(2)) } }));
        report('像素级间距 = 24px（这一行左移 24px 与原图差异最小）',
          pattern.pitch === 24, `pitch=${pattern.pitch} diff=${pattern.pitchDiff}`);
        /**
         * v1.48：大矩阵的星号更大更亮，而大星圆心**压在小星上**（同心嵌套），
         * 交点处会叠出 4 层 1px 笔画（小星 H/V + 大星 H/V）—— 真机实测 160，
         * 但只是**孤立的交点像素**，画面整体仍是淡的（p99≈52）。
         * 所以「不是一片白」分两条守：p99 仍按参考图的 0.19 口径 ≤90；
         * 最亮交点放宽到 ≤170（再亮就真的刺眼了）。
         */
        report('星号整体够淡（p99 比底色亮 ≤90，不是一片白）',
          pattern.inkP99 - pattern.background <= 90,
          `bg=${pattern.background} p99=${pattern.inkP99} max=${pattern.inkMax}`);
        report('最亮的大星交点也不刺眼（比底色亮 ≤170；v1.48 三层同心嵌套的叠墨）',
          pattern.inkMax - pattern.background <= 170,
          `bg=${pattern.background} max=${pattern.inkMax} p99=${pattern.inkP99}`);
      } catch (error) {
        browserFailures += 1;
        console.log(`[browser] FAIL  ${label}: 截图像素分析失败：${String(error)}`);
      }
    }
  }

  /**
   * 网格跟随速度（?xgridpan=1，v1.33）。
   *
   * 用户报障原文：「移动画布的时候背后的网格和节点移动的速度不一致，网格的速度快，节点慢。」
   * 根因是网格把画布 translate（CSS px）乘了 devicePixelRatio 再当 background-position 用
   * —— CSS 背景的几何单位永远是 CSS px，于是网格位移 = 节点位移 × dpr。
   * 本机缩放 125%（dpr=1.25）→ 网格正好快 1.25 倍；dpr=1 时乘子等于没写，所以一直没被抓到。
   *
   * 这两场（grid-pan / grid-pan-hidpi）验的是同一组**与 dpr 无关**的比值：
   *   ① 画布平移 160px → 网格背景必须也移 160px（ratio=1.000）；
   *   ② 格子边长 = 24 × zoom（CSS px，跟节点同一坐标系，不乘 dpr）。
   * dpr=1 那一场跑不红（bug 在 1.0 下本来就不可见），它的价值是「同一套断言在两种 dpr 下都成立」；
   * 真正拦住回归的是 1.25 那一场。
   */
  if (label === 'grid-pan' || label === 'grid-pan-hidpi') {
    const steps = probe.gridPan ?? {};
    const measure = steps.measure ?? null;
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('网格测速探针量到了画布几何', steps.done === true && !!measure,
      JSON.stringify(steps).slice(0, 300));
    if (measure) {
      const ratioX = measure.gridPanX === null ? null : measure.gridPanX / measure.nodePanX;
      const ratioY = measure.gridPanY === null ? null : measure.gridPanY / measure.nodePanY;
      report('横向：网格与节点同速（画布平移 -160px → 网格背景也移 -160px，不是 -160×dpr）',
        ratioX !== null && Math.abs(ratioX - 1) < 0.005,
        `网格 ${measure.gridPanX}px / 节点 ${measure.nodePanX}px = ${ratioX === null ? '?' : ratioX.toFixed(4)}（dpr=${measure.dpr}）`);
      report('纵向：网格与节点同速（96px → 96px）',
        ratioY !== null && Math.abs(ratioY - 1) < 0.005,
        `网格 ${measure.gridPanY}px / 节点 ${measure.nodePanY}px = ${ratioY === null ? '?' : ratioY.toFixed(4)}`);
      report('网格层变量写的就是画布 translate 本身（CSS px，不乘 dpr）',
        Math.abs(measure.varPanX - measure.nodePanX) < 0.5,
        `--canvas-grid-pan-x 增量 = ${measure.varPanX}（画布 ${measure.nodePanX}px，dpr=${measure.dpr}；乘 dpr 会变成 ${(measure.nodePanX * measure.dpr).toFixed(1)}）`);
      report('格子边长 = 24px（缩放 1 时；与节点同一坐标系）',
        Math.abs(measure.sizeZoom1 - 24) < 0.1,
        `background-size=${measure.sizeZoom1}px（dpr=${measure.dpr}，乘了 dpr 会变成 ${(24 * measure.dpr).toFixed(2)}）`);
      report('缩放 1.5 后格子边长 = 36px（跟着 zoom 走，且只跟 zoom）',
        Math.abs(measure.sizeZoom1_5 - 36) < 0.1,
        `background-size=${measure.sizeZoom1_5}px`);
      report('读数里报出 dpr（这一场跑在哪种缩放下，可回查）',
        Number(measure.dpr) > 0, `dpr=${measure.dpr}`);
      /**
       * v1.48（用户「缩小画布就密密麻麻」）：三层嵌套矩阵真机显隐。
       * 真浏览器里量的是每层 wrapper 的 inline opacity（JS 按屏幕间距算），不是只读报告。
       */
      const tiers = steps.tiers ?? null;
      const opacityOf = (list, id) =>
        (list ?? []).find((tier) => tier.id === id)?.opacity ?? null;
      report('三层嵌套矩阵都挂上了（24 / 120 / 600）',
        ['minor', 'major', 'super'].every(
          (id) =>
            (tiers?.at1 ?? []).find((tier) => tier.id === id)?.spacing ===
            { minor: 24, major: 120, super: 600 }[id],
        ),
        JSON.stringify(tiers?.at1 ?? null));
      report('zoom 1：小矩阵 + 大矩阵亮着，最大一层不出现',
        opacityOf(tiers?.at1, 'minor') > 0.99 &&
          opacityOf(tiers?.at1, 'major') > 0.99 &&
          opacityOf(tiers?.at1, 'super') < 0.001,
        JSON.stringify(tiers?.at1 ?? null));
      report('zoom 0.2：小矩阵已消失、大矩阵接棒、更大一层补进来（不再密密麻麻）',
        opacityOf(tiers?.at02, 'minor') < 0.001 &&
          opacityOf(tiers?.at02, 'major') > 0.99 &&
          opacityOf(tiers?.at02, 'super') > 0.99,
        JSON.stringify(tiers?.at02 ?? null));
      report('zoom 0.05：只剩最大一层（30px），画面不会被星号填满',
        opacityOf(tiers?.at005, 'minor') < 0.001 &&
          opacityOf(tiers?.at005, 'major') < 0.001 &&
          opacityOf(tiers?.at005, 'super') > 0.99,
        JSON.stringify(tiers?.at005 ?? null));
    }
  }

  /**
   * 叠图「切换」（?xstack=1，v1.37）。用户原话「给这种折叠起来的图添加一个切换按钮」。
   *
   * 三条真机断言分别守住三个「假绿」：
   *   ① 控制条虽然渲染了、但被卡内容或画布底盘盖住 → 一定点不到，`elementFromPoint` 会红；
   *   ② `src` 变了、但 `stackPosition` 没跟着走 → 计数会红（用户看不到「现在第几张」）；
   *   ③ 切换其实是「摊开/复制」→ 节点数会红（画布上会多出节点）。
   */
  if (label === 'stack') {
    const steps = probe.stack ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const initial = steps.initial ?? {};
    const afterFirst = steps.afterFirst ?? {};
    const afterWrap = steps.afterWrap ?? {};
    report('叠图宿主卡左下角出现了控制条与「切换」按钮（v1.37）', steps.initial !== null,
      JSON.stringify(steps).slice(0, 300));
    report('控制条在卡里、真看得见（rect 落在节点框内，不是 0 宽）',
      initial.insideCard === true && initial.visible === true,
      `insideCard=${initial.insideCard} visible=${initial.visible} rect=${JSON.stringify(initial.rect)} card=${JSON.stringify(initial.card)}`);
    report('「切换」按钮真的点得到（elementFromPoint 命中它自己，没被卡内容/画布底盘盖住）',
      steps.hit?.onSwitch === true, JSON.stringify(steps.hit));
    report('初始显示第 1 张（1/3）',
      String(initial.src ?? '').endsWith('stack-a.png') && String(initial.counter ?? '').includes('1/3'),
      `${initial.src} / ${initial.counter}`);
    report('真点一下「切换」→ 卡上的图换成第 2 张、计数变 2/3',
      String(afterFirst.src ?? '').endsWith('stack-b.png') &&
        String(afterFirst.counter ?? '').includes('2/3'),
      `${afterFirst.src} / ${afterFirst.counter}`);
    report('连点三下绕回第 1 张（环形，不用点回来）',
      String(afterWrap.src ?? '').endsWith('stack-a.png') &&
        String(afterWrap.counter ?? '').includes('1/3'),
      `${afterWrap.src} / ${afterWrap.counter}`);
    report('切换不会摊开/复制节点（画布上始终只有 1 个节点）',
      steps.nodeCount === 1 && steps.nodesAfter === 1,
      `${steps.nodeCount} -> ${steps.nodesAfter}`);
    report('截图停在换过来的那一张（第 2 张 / 2/3，交付图取证）',
      String(steps.final?.src ?? '').endsWith('stack-b.png') &&
        String(steps.final?.counter ?? '').includes('2/3'),
      `${steps.final?.src} / ${steps.final?.counter}`);
  }

  /**
   * 视频生成历史（?xvideo=1，v1.64）。用户原话「仿照图像生成历史记录，做视频生成历史记录功能」。
   *
   * 四条真机断言各守一个「jsdom 看不见」的失败模式：
   *   ① 药丸画在节点上方、但 hit-test 打到了画布底盘 → 用户点不动；
   *   ② 扇形历史格被节点外框的 overflow-hidden 剪掉 → rect 在框内、或中心点打不到它；
   *   ③ mp4 在真 Chrome 里解不出来（假 URL / 编码不支持）→ videoWidth 为 0，界面是一块黑；
   *   ④ 「设为主视频」只改了 React state、没真换片 → 主 video 的 src 不会变。
   */
  if (label === 'video-history') {
    const steps = probe.videoHistory ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const initial = steps.initial ?? {};
    const expanded = steps.expanded ?? {};
    const promoted = steps.promoted ?? {};
    const final = steps.final ?? {};
    report('视频节点渲染出来了，整条链路走完', steps.done === true && !steps.error,
      String(steps.error || '').slice(0, 200) || JSON.stringify(initial).slice(0, 200));
    report('节点头部有「历史 3」药丸（与图片节点同款）',
      String(initial.label ?? '').includes('历史 3') && initial.pill !== null,
      `${initial.label} pill=${JSON.stringify(initial.pill)}`);
    report('药丸的可读标签是「本次 1 · 历史 3」',
      String(initial.ariaLabel ?? '') === '本次 1 · 历史 3', String(initial.ariaLabel));
    report('药丸画在节点上方，且真的点得到（elementFromPoint 命中它自己）',
      initial.pillAboveNode === true && initial.pill?.onTop === true,
      `above=${initial.pillAboveNode} onTop=${initial.pill?.onTop}`);
    report('主视频在真 Chrome 里解码出来了（320×180，不是一块黑）',
      initial.mainWidth === 320 && initial.mainHeight === 180,
      `${initial.mainWidth}x${initial.mainHeight}`);
    report('点药丸 → 摊出 2 条历史，每条都是真 <video>',
      expanded.items?.length === 2 &&
        expanded.items.every((item) => String(item.src).includes('/videos/video-history-')),
      JSON.stringify((expanded.items ?? []).map((item) => item.src)));
    report('历史格摊在节点**外面**（没被外框剪掉：rect 在框外 + 中心点打得到它自己）',
      expanded.items?.length === 2 &&
        expanded.items.every((item) => item.outside === true && item.hitSelf === true),
      JSON.stringify(expanded.items));
    report('点第 2 条历史的「设为主视频」→ 主片换成蓝的那条',
      String(promoted.mainSrc ?? '').includes('video-history-blue.mp4'),
      String(promoted.mainSrc).slice(-40));
    report('换主视频不丢历史（药丸仍是历史 3）',
      String(promoted.label ?? '').includes('历史 3') || String(promoted.ariaLabel ?? '').includes('历史 3'),
      `${promoted.label} / ${promoted.ariaLabel}`);
    report('换片不会摊开/复制节点（画布上始终只有 1 个节点）',
      initial.nodeCount === 1 && expanded.nodeCount === 1 && promoted.nodeCount === 1,
      `${initial.nodeCount} / ${expanded.nodeCount} / ${promoted.nodeCount}`);
    // ---- v1.66：截帧入口（真布局）----
    report('视频底栏有「截取视频帧」入口，点开是三项菜单（首帧 / 尾帧 / 首尾帧）',
      steps.framesMenu === true &&
        JSON.stringify(steps.framesMenuItems) === JSON.stringify(['first', 'last', 'both']),
      `menu=${steps.framesMenu} items=${JSON.stringify(steps.framesMenuItems)} ${steps.framesError || ''}`);
    report('菜单能再点一下收起来（不会一直浮在节点上）', steps.framesMenuClosed === true,
      String(steps.framesMenuClosed));
    report('截图停在「主片是蓝的 + 旁边摊着两条历史」（交付图取证）',
      String(final.mainSrc ?? '').includes('video-history-blue.mp4') &&
        final.items?.length === 2 &&
        final.expanded === 'true',
      `${String(final.mainSrc).slice(-32)} items=${final.items?.length}`);
  }

  /**
   * 视频节点能接几张参考图（?xvideorefs=1，v1.65）。
   * 用户原话：「视频生成图像参考只能拖入三张，修复一下，按 minimaxh3 的标准来」。
   *
   * 真机这一场守的是「真布局下拖得动 + 上限就是 9」：
   *   ① 连接点在真布局里有 rect（jsdom 里全是 0，那半条只能靠公式兜底）；
   *   ② 从图片节点的输出圆拖到视频节点身上，9 张全接上（修复前第 4 张就断）；
   *   ③ 第 10 张被拒 —— 上限是 9，不是「干脆不设上限」；
   *   ④ 注册表里的 maxInputs 与模式声明的 9 自洽（别又写回一个小数字）。
   */
  if (label === 'video-references') {
    const steps = probe.videoRefs ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const dragged = Array.isArray(steps.dragged) ? steps.dragged : [];
    const parents = Array.isArray(steps.connected?.parents) ? steps.connected.parents : [];
    report('拖线场景走完（10 次 pointerdown/move/up 都派发了）',
      steps.done === true && !steps.error && dragged.length === 10,
      String(steps.error || '').slice(0, 200) || `dragged=${dragged.length}`);
    report('10 张图的「连接输出」在真布局里都有 rect（点得到才拖得动）',
      dragged.every((item) => item.ok === true && Number(item.width) > 0),
      JSON.stringify(dragged.map((item) => `${item.id}:${item.ok}:${item.width}`)));
    report('9 张参考图全部接上（修复前只到 3 张）',
      parents.length === 9,
      `parentIds=${parents.length} ${JSON.stringify(parents)}`);
    report('第 10 张被拒（上限 9，不是无穷）',
      parents.includes('video-ref-image-9') && !parents.includes('video-ref-image-10'),
      JSON.stringify(parents));
    report('注册表：多图参考声明 9 张、总输入上限 ≥ 10',
      steps.registry?.found === true &&
        steps.registry?.imageLimit === 9 &&
        Number(steps.registry?.maxInputs) >= 10,
      JSON.stringify(steps.registry));
    report('拖完线不会凭空多节点（画布上还是 11 个）',
      steps.connected?.nodeCount === 11, String(steps.connected?.nodeCount));
  }

  /**
   * 扩图（?xoutpaint=1，v1.39）。用户原话（附参考图：「原图 → 扩图画面 → 扩图 · 21:9」节点链）：
   * 「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」。
   *
   * 这一场最容易出现的三种「假绿」：
   *   ① 节点建出来了，但其实**顺手把生成也发了**（页面上还没出图，看起来像「没直接生图」）——
   *      所以由 Node 侧数 host 收到的 /generate-* 请求，必须一条都没有；
   *   ② 「扩图画面」只是个空壳节点（没有图 / 图是糊的）—— 所以要量 img 的 naturalWidth：
   *      320×240 的源图 + 16:9 必须解码出 427×240；
   *   ③ 面板画在了节点坐标里但被画布底盘/卡内容盖住 —— 用「落在 .af-canvas-mount 矩形内
   *      且宽度 > 120」来卡。
   */
  if (label === 'outpaint') {
    const steps = probe.outpaint ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const generatedDuringScene = generationRequests.length - generationBefore;
    const panel = steps.panel ?? {};
    const after = steps.after ?? {};
    report('扩图场景走完整条链路（选节点 → 开面板 → 生成扩图画面 → 两张节点）',
      steps.done === true && !steps.error, JSON.stringify(steps).slice(0, 240));
    report('工具条里已经没有「AI 高清放大」（v1.38 移除）',
      steps.toolbar?.hasHdUpscale === false, JSON.stringify(steps.toolbar));
    report('工具条里有「扩图」入口（data-fisherai-outpaint-trigger）',
      steps.toolbar?.hasOutpaintTrigger === true, JSON.stringify(steps.toolbar));
    report('扩图面板落在画布里、真看得见（宽 > 120px）',
      panel.insideMount === true && Number(panel.rect?.width) > 120,
      `rect=${JSON.stringify(panel.rect)} insideMount=${panel.insideMount}`);
    report('面板有 9 格「原图位置」+ 目标比例（含 16:9）',
      panel.anchors?.length === 9 && Array.isArray(panel.ratios) && panel.ratios.includes('16:9'),
      `anchors=${panel.anchors?.length} ratios=${JSON.stringify((panel.ratios ?? []).slice(0, 6))}`);
    report('面板有「延展内容」输入框（可空）', panel.hasContentField === true, '');
    report('面板没有被节点 composer 浮层盖住（点按钮中心命中的是面板自己）',
      panel.createHit === true, String(panel.createHitLabel));
    report('预览按目标比例铺好（320×240 + 16:9 → 427×240）',
      panel.previewSize === '427x240', String(panel.previewSize));
    report('面板显示这次要用的模型（不是空字符串）',
      typeof panel.model === 'string' && panel.model.length > 0, String(panel.model));
    report('位置 / 比例的选择真的记住了（aria-pressed）',
      steps.active?.anchor === 'true' && steps.active?.ratio === 'true',
      JSON.stringify(steps.active));
    report('预览跟着位置变（贴右 → 原图 left 从 12.4% 变 25.1%）',
      String(steps.active?.previewLeft ?? '').startsWith('25.'),
      String(steps.active?.previewLeft));
    report('延展内容真的填进去了',
      steps.active?.content === '两侧延伸出更多沙滩和海面', String(steps.active?.content));
    report('点「生成扩图画面」→ 画布上真的多**两张**节点',
      steps.before === 1 && after.nodeCount === 3, `${steps.before} -> ${after.nodeCount}`);
    report('先出图：扩图画面是一张真实的素材图（不是空壳节点）',
      typeof after.compositeImageSrc === 'string' &&
        after.compositeImageSrc.startsWith('/api/aifisher/canvas/media/'),
      String(after.compositeImageSrc).slice(-48));
    report('扩图画面的自然尺寸 = 目标比例（427×240，真解码出来的）',
      after.compositeNatural?.width === 427 && after.compositeNatural?.height === 240,
      JSON.stringify(after.compositeNatural ?? null));
    report('再接入节点：生成节点标题「扩图 · 16:9」',
      String(after.generationTitle || '').startsWith('扩图 · 16:9'), String(after.generationTitle));
    report('生成节点是**空**的（没有任何结果图 —— 创建 ≠ 生图）',
      after.hasResultImage === false, String(after.hasResultImage));
    report('生成节点的提示词已经填好（含「向外扩图」与延展内容）',
      after.promptFilled === true && String(after.composerText || '').includes('两侧延伸出更多沙滩和海面'),
      String(after.composerText || '').slice(0, 90));
    report('生成节点被选中（生成按钮就在它身上，用户直接点）',
      after.selected === 'true', String(after.selected));
    report('创建后面板自动收起（不挡着两张新节点）', after.panelClosed === true, '');
    report('**整场里 host 一条生成请求都没收到**（「不直接生图」的硬证据）',
      generatedDuringScene === 0,
      `${generatedDuringScene} 条${generatedDuringScene ? `：${generationRequests.slice(-2).join(' | ')}` : ''}`);

    // 落盘的那张 PNG 也要对：尺寸 + 左边（贴右留下的空白）真的透、右边是原图内容。
    let shot = null;
    try {
      const mediaDir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', outpaintProjectId, 'images');
      const files = readdirSync(mediaDir).filter((name) => /^annotation-.*\.png$/i.test(name));
      if (files.length >= 1) {
        shot = decodePngRgb(join(mediaDir, files[files.length - 1]));
      }
    } catch (error) {
      shot = null;
    }
    report('扩图画面真的落成了文件（annotation-*.png）', Boolean(shot), '');
    if (shot) {
      report('落盘 PNG 尺寸 = 427×240', shot.width === 427 && shot.height === 240,
        `${shot.width}x${shot.height}`);
      const blank = rgbStats(shot, { left: 4, top: 4, width: 90, height: 232 });
      const content = rgbStats(shot, { left: 140, top: 20, width: 260, height: 200 });
      report('留白那一条（贴右 → 左侧 107px）是透明的（RGB 全 0，不会被当成天空）',
        blank.mean[0] + blank.mean[1] + blank.mean[2] === 0, JSON.stringify(blank.mean));
      report('原图内容真的画进右侧（有色彩，不是一张空画布）',
        content.mean[0] + content.mean[1] + content.mean[2] > 30, JSON.stringify(content.mean));
    }

    const finalComposite = (steps.final ?? []).find((node) =>
      String(node.title || '').startsWith('扩图画面'),
    );
    const finalGeneration = (steps.final ?? []).find((node) =>
      String(node.title || '').startsWith('扩图 · '),
    );
    report('截图停在「扩图画面（有图）+ 扩图 · 16:9（空着等生成）」上（交付图取证）',
      finalComposite?.hasResultImage === true &&
        finalComposite?.imageSize?.width === 427 &&
        finalGeneration?.hasResultImage === false &&
        String(finalGeneration?.composerText || '').includes('向外扩图'),
      `${finalComposite?.title} / ${finalGeneration?.title}`);
  }

  /**
   * 扩图面板本身（?xoutpaint=panel，v1.39）：只开面板不创建，用来出「入口长什么样」那张交付图。
   */
  if (label === 'outpaint-panel') {
    const steps = probe.outpaint ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const panel = steps.reopening ?? {};
    report('面板只取证场景跑完了（没有创建节点）',
      steps.done === true && !steps.error && steps.after === null,
      JSON.stringify(steps).slice(0, 200));
    report('截图停在打开的面板上（交付图：扩图入口 + 目标比例/原图位置/延展内容）',
      panel.insideMount === true && Number(panel.rect?.width) > 120,
      JSON.stringify(panel.rect ?? null));
    report('面板上有「生成扩图画面」按钮、模型读数、9 格位置、预览',
      panel.createLabel === '生成扩图画面' &&
        String(panel.model || '').length > 0 &&
        panel.anchors?.length === 9 &&
        panel.previewSize === '427x240',
      `${panel.createLabel} / ${panel.model} / ${panel.anchors?.length} / ${panel.previewSize}`);
    report('面板整块都压在 composer 上面（按钮中心可点，不会被盖住）',
      panel.createHit === true && panel.rect?.height >= 320,
      `${panel.createHitLabel} / ${JSON.stringify(panel.rect)}`);
  }

  /**
   * 尺寸对话框（?xresize=1，v1.38）。用户原话「尺寸节点的ui还没有更新」。
   *
   * 三件事必须真：新的紧凑对话框铺在画布里不越界；2x 换算对（320×240 → 640×480）；
   * 保存出来的那张图**真的是** 640×480（像素语义没被换壳改坏）。
   */
  if (label === 'resize') {
    const steps = probe.resize ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const dialog = steps.dialog ?? {};
    const afterPreset = steps.afterPreset ?? {};
    const saved = steps.saved ?? {};
    report('尺寸场景走完整条链路（开对话框 → 2x → 保存 → 再打开）',
      steps.done === true && !steps.error, JSON.stringify(steps).slice(0, 240));
    report('「尺寸」打开的是 nova 版对话框（data-fisherai-image-resize + role=dialog）',
      dialog.role === 'dialog' && dialog.label === '调整图片尺寸', `${dialog.role}/${dialog.label}`);
    report('对话框严丝合缝地铺在画布里（不越到 DSH 侧边栏上）',
      dialog.insideMount === true,
      `dialog=${JSON.stringify(dialog.rect)} insideMount=${dialog.insideMount}`);
    report('同一时刻只有一个「调整图片尺寸」对话框（vendor 整屏浮层没有一起渲染）',
      dialog.dialogsOnPage === 1, String(dialog.dialogsOnPage));
    report('对话框是紧凑卡片（宽 ≤ 900px，不是整屏铺满）',
      Number(dialog.card?.width) > 0 && Number(dialog.card?.width) <= 900,
      JSON.stringify(dialog.card));
    report('四个尺寸输入都在（倍数滑杆 / 倍数 / 宽 / 高）',
      dialog.inputs?.slider === true &&
        dialog.inputs?.scale === true &&
        dialog.inputs?.width === true &&
        dialog.inputs?.height === true,
      JSON.stringify(dialog.inputs));
    report('原图尺寸真的读出来了（320×240）',
      dialog.original === '320x240', String(dialog.original));
    report('点「2x」→ 目标尺寸 640×480（等比换算没坏）',
      afterPreset.target === '640x480', String(afterPreset.target));
    report('点「保存尺寸图片」→ 画布上多一个节点',
      saved.nodeCount === 2 && !!saved.createdId, `${steps.before} -> ${saved.nodeCount} id=${saved.createdId}`);
    report('保存出来的那张图自然尺寸就是 640×480（像素语义与上游一致）',
      saved.naturalWidth === 640 && saved.naturalHeight === 480,
      `${saved.naturalWidth}x${saved.naturalHeight} src=${String(saved.src || '').slice(-40)}`);
    report('保存后对话框自己关掉', saved.dialogClosed === true, '');
    report('截图停在重新打开的对话框 + 2x 上（交付图取证）',
      steps.reopened !== null && steps.reopened.target === '640x480',
      JSON.stringify(steps.reopened?.rect ?? null));
  }

  /**
   * 新节点默认用上一次的模型（?xlastmodel=1，v1.40）。
   * 真机只验「接线与可见结果」：没记过 = 目录第一个；记过 = 下一个新节点就是它；
   * 已有节点不被改；reset 后回到第一个。点下拉那半条路由 test-canvas-last-model 守着。
   */
  if (label === 'last-model') {
    const steps = probe.lastModel ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const text = (value) => String(value ?? '');
    report('场景走完整条链路（三个图片节点都建出来）',
      steps.done === true && !steps.error, String(steps.error ?? '').slice(0, 240));
    report('三个桥都在（pick / remember / 诊断面板）',
      steps.bridge?.store === true && steps.bridge?.pick === true && steps.bridge?.remember === true,
      JSON.stringify(steps.bridge ?? null));
    report('没记过时新建图片节点 = 目录第一个模型（通道别名「魔搭出图」）',
      text(steps.first).indexOf(CHANNEL_FIXTURE.alias) >= 0 &&
        text(steps.first).indexOf(LAST_MODEL_SECOND_TEXT) < 0,
      text(steps.first).slice(0, 160));
    report('记一次「上一次用的模型」→ 下一个新建节点直接就是它',
      text(steps.second).indexOf(LAST_MODEL_SECOND_TEXT) >= 0 &&
        text(steps.second).indexOf(CHANNEL_FIXTURE.alias) < 0,
      text(steps.second).slice(0, 160));
    report('已经有结果的旧节点不会被改（记忆只影响新建节点）',
      text(steps.firstAfter).indexOf(CHANNEL_FIXTURE.alias) >= 0 &&
        text(steps.firstAfter).indexOf(LAST_MODEL_SECOND_TEXT) < 0,
      text(steps.firstAfter).slice(0, 160));
    report('记忆落盘在本机 localStorage（换页面也还在）',
      text(steps.stored).indexOf(LAST_MODEL_SECOND_TEXT) >= 0,
      text(steps.stored).slice(0, 160));
    report('诊断读数里有这次记下的模型',
      text(steps.remembered?.models?.image) === LAST_MODEL_SECOND_TEXT,
      JSON.stringify(steps.remembered?.models ?? null));
    report('reset 之后新建节点回到目录第一个（记忆不会粘死）',
      text(steps.third).indexOf(CHANNEL_FIXTURE.alias) >= 0 &&
        text(steps.third).indexOf(LAST_MODEL_SECOND_TEXT) < 0 &&
        text(steps.reset?.models?.image) === '',
      text(steps.third).slice(0, 160));
  }

  /**
   * 节点搜索场景（?search=1，v1.10）：Shift+A 的整条链路 —— 面板贴着鼠标弹出、
   * 模糊过滤、Enter 在鼠标处建节点、搜工作流标题能建出带 comfyMode 的 ComfyUI 节点。
   */
  if (label === 'node-search') {
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const search = probe.nodeSearch ?? {};
    report('Shift+A 弹出节点搜索面板', search.panelOpened === true, JSON.stringify(search));
    report('面板停在画布面上（不越出画布左右边缘）', search.panelInsideCanvas === true,
      `left=${search.atPointer?.dx ?? '?'} inside=${search.panelInsideCanvas}`);
    report('面板贴在光标那一列（按定位规则算出来的 x，容差 2px）',
      Math.abs(search.leftDelta ?? 99) <= 2,
      JSON.stringify({
        origin: search.containerOrigin,
        expectedLeft: search.expectedLeft,
        leftDelta: search.leftDelta,
      }));
    report('输入框自动聚焦（可以直接打字）', search.focused === true);
    report('输入「视频」后候选收敛到视频相关，第一项是视频生成',
      Array.isArray(search.queryIds) && search.queryIds[0] === 'type:Video' && search.queryIds.length <= 4,
      JSON.stringify(search.queryIds ?? null));
    report('点候选真建出了节点（vendor 桥只被调用一次）', search.bridgeCalls === 1,
      `bridgeCalls=${search.bridgeCalls} created=${JSON.stringify(search.createdNodeIds ?? null)}`);
    report('新节点就落在鼠标那一点上（节点框覆盖光标，容差 20px）',
      search.nodeCoversPointer === true, JSON.stringify(search.nodeAtPointerDelta ?? null));
    // v1.45：Blender 式「新建并移动」—— 确认后节点跟着鼠标，左键才放下
    report('确认后节点跟着鼠标走（屏幕位移 +60/+40）',
      search.follow?.dx === 60 && search.follow?.dy === 40,
      JSON.stringify(search.follow ?? null));
    report('左键放下后节点不再跟手',
      search.dropped?.dx === 0 && search.dropped?.dy === 0,
      JSON.stringify(search.dropped ?? null));
    report('搜工作流标题能命中该工作流候选',
      typeof search.workflowOption === 'string' && search.workflowOption.startsWith('workflow:'),
      JSON.stringify({ option: search.workflowOption ?? null, items: search.workflowCandidates ?? null }));
    report('点选工作流候选后建出的节点带着那份工作流（节点下拉 value = comfyMode）',
      search.pickedDelta === 1 && typeof search.workflowMode === 'string' && search.workflowMode.startsWith('custom-'),
      JSON.stringify({ delta: search.pickedDelta, mode: search.workflowMode ?? null, all: search.workflowModes ?? null }));
  }

  /**
   * 提亮场景（?xglow=1）：真去量像素 —— 钉住的圆心那块必须明显比空白区亮，
   * 否则「鼠标靠近会变亮」只是 CSS 里写着好看。
   */
  if (label === 'glow') {
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const canvasRect = probe.grid?.rect;
    if (!canvasRect) {
      report('提亮场景拿得到画布几何', false, '(no grid.rect)');
    } else {
      try {
        const png = decodePngGray(shot.out);
        const center = {
          left: canvasRect.left + canvasRect.w * 0.17 - 60,
          top: canvasRect.top + canvasRect.h * 0.69 - 60,
          width: 120,
          height: 120,
        };
        // 对照区：画布**右中**那块空白（节点卡片都在上半部分、参数对话框够不到这里），
        // 不靠「自动找安静块」，免得挑到提亮圈里自证失败。
        // v1.24 的任务队列面板钉在右上角（画布右缘、头部之下），原来那块「右上角空白」
        // 现在被面板占着（面板最亮像素 242，比提亮圈还亮 → 假红），所以对照区下移到面板下方。
        const farBox = {
          left: canvasRect.left + canvasRect.w - 400,
          top: canvasRect.top + 260,
          width: 240,
          height: 120,
        };
        const lit = regionStats(png, center);
        const far = regionStats(png, farBox);
        report('提亮有效：圆心那块的最亮像素明显高于空白区（真机像素）',
          lit.max >= 150 && lit.max - far.max >= 60,
          `lit.max=${lit.max} far.max=${far.max} farBox=${JSON.stringify(farBox)}`);
        report('提亮是渐变（圆心高亮像素占比 > 空白区）',
          lit.p99 - far.p99 >= 30,
          `lit.p99=${lit.p99} far.p99=${far.p99}`);
      } catch (error) {
        browserFailures += 1;
        console.log(`[browser] FAIL  ${label}: 截图像素分析失败：${String(error)}`);
      }
    }
  }

  /**
   * 任务队列场景（?tasks=1，v1.24）：用户要的是「右侧任务队列面板 + 运行中的任务带边框循环发光」。
   * 这里量的是 jsdom 量不到的东西：面板贴的是不是画布右缘、发光动画是不是真的在跑
   * （computedStyle 的 animationName / ::before 那层流光）、用时是不是在跳。
   */
  if (label === 'task-queue') {
    const scene = probe.taskQueue ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('画布右侧渲染出「任务队列」面板', scene.panel?.insideCanvas === true && Number(scene.panel?.width) > 200,
      JSON.stringify(scene.panel ?? null));
    report('面板贴的是画布右缘（不是整个 DSH 窗口右缘，间隙 ≤ 20px）',
      Number(scene.panel?.gapRight) >= 0 && Number(scene.panel?.gapRight) <= 20,
      JSON.stringify({ gapRight: scene.panel?.gapRight }));
    // v1.36：用户要求「任务队列往上移」—— 面板顶边要贴到画布顶（8px），不能还停在头部下面
    report('面板已经上移到画布右上角（顶边距画布顶 = 8px）',
      Math.abs(Number(scene.panel?.gapTop) - 8) <= 1,
      `gapTop=${scene.panel?.gapTop}px`);
    report('面板宽度在 240–360px（没被压成一条）',
      Number(scene.panel?.width) >= 240 && Number(scene.panel?.width) <= 360,
      `${scene.panel?.width}px`);
    report('面板 aria-label = 任务队列', scene.panel?.label === '任务队列', String(scene.panel?.label ?? ''));
    report('运行中那一行在真机里存在', typeof scene.running?.text === 'string' && scene.running.text.length > 0,
      String(scene.running?.text ?? '').slice(0, 120));
    report('行里能看到时间（时:分:秒 / 已运行）',
      scene.running?.hasTimes === true && String(scene.running?.text ?? '').includes('已运行'),
      String(scene.running?.text ?? '').slice(0, 160));
    // ---- 边框循环发光：这三条是用户那句「正在运行的任务要有边框循环发光特效」的直接回归点
    report('运行中那行真的在跑呼吸发光动画（animationName 命中 keyframes）',
      String(scene.running?.animationName ?? '').includes('af-task-queue-glow'),
      JSON.stringify({ name: scene.running?.animationName, duration: scene.running?.animationDuration }));
    report('动画是无限循环、2.4s 一轮',
      String(scene.running?.animationIterationCount ?? '') === 'infinite' &&
        Math.abs(Number.parseFloat(String(scene.running?.animationDuration ?? '0')) - 2.4) < 0.01,
      JSON.stringify({ count: scene.running?.animationIterationCount, duration: scene.running?.animationDuration }));
    report('边框那一圈是沿边循环流动的渐变光（::before 在跑 sweep 动画）',
      String(scene.running?.beforeAnimationName ?? '').includes('af-task-queue-sweep') &&
        scene.running?.beforeHasGradient === true,
      JSON.stringify({ name: scene.running?.beforeAnimationName, gradient: scene.running?.beforeHasGradient }));
    report('外发光是真的（box-shadow 不是 none）',
      typeof scene.running?.boxShadow === 'string' &&
        scene.running.boxShadow !== 'none' &&
        scene.running.boxShadow.length > 8,
      String(scene.running?.boxShadow ?? ''));
    report('用时在跳（700ms 后 elapsed 变大）',
      Number(scene.runningElapsedAfter) > Number(scene.running?.elapsed),
      `${scene.running?.elapsed} → ${scene.runningElapsedAfter}`);
    report('已完成那行显示「用时 + N 个结果」',
      scene.doneRow?.status === 'success' &&
        String(scene.doneRow?.text ?? '').includes('用时') &&
        String(scene.doneRow?.text ?? '').includes('个结果'),
      String(scene.doneRow?.text ?? '').slice(0, 160));
    report('同一面板里同时有「运行中」和「完成」两行（一处看全）',
      /运行中/.test(String(scene.running?.text ?? '')) &&
        /完成/.test(String(scene.doneRow?.text ?? '')),
      JSON.stringify({
        running: String(scene.running?.text ?? '').slice(0, 60),
        done: String(scene.doneRow?.text ?? '').slice(0, 60),
      }));
    if (scene.error) console.log(`[browser] 场景异常：${String(scene.error).slice(0, 300)}`);
  }

  /**
   * 任务队列「只在画布这一层」（?qlayers=1，v1.41）。
   *
   * 用户原话「任务队列希望只出现在画布这一层，现在点击设置啥的都看的见任务队列」——
   * 这条只能真机验：面板在设置打开时必须 `display:none`（jsdom 没有 CSS 引擎），
   * 而且它原来占的那块像素不能再命中它自己（`elementFromPoint`，证明没浮在设置上面）。
   * 同时守两条反向契约：画布层上它得在场、关掉设置后它得回来（护栏不能把它永久藏掉）。
   */
  if (label === 'queue-layers') {
    const scene = probe.queueLayers ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('基线：画布层上任务队列在场（有宽度、没被藏起来）',
      Number(scene.before?.width) >= 240 && scene.before?.display !== 'none',
      JSON.stringify(scene.before ?? null));
    report('基线：没有浮层时面板不带 inert',
      scene.before?.inert === false,
      String(scene.before?.inert));
    report('打开设置后任务队列整块消失（display:none）',
      scene.during?.settingsOpen === true && scene.during?.display === 'none',
      JSON.stringify(scene.during ?? null));
    report('打开设置后面板被浮层接管（带 inert，不是靠 z-index 遮住）',
      scene.during?.inert === true,
      String(scene.during?.inert));
    report('面板原来那块像素不再命中它自己（elementFromPoint 落在设置上）',
      scene.during?.hitInsideQueue === false,
      `hit=${scene.during?.hit ?? '(none)'}`);
    report('设置里切到「画布外观」后仍然看不见任务队列',
      scene.duringAppearance?.display === 'none' && scene.duringAppearance?.settingsOpen === true,
      JSON.stringify(scene.duringAppearance ?? null));
    if (scene.error) console.log(`[browser] 场景异常：${String(scene.error).slice(0, 300)}`);
  }

  /**
   * 项目归档场景（?xarchive=1，v1.42）。
   *
   * 页面里能验的：头部按钮真的是命中目标、面板放得下且读数有真实数字、
   * 点「导出到目录」后面板给出成功提示（含落盘目录）。
   * 页面里验不了的：文件到底有没有落地 —— 这里由 node 侧去假 DSH_HOME 的 `downloads/`
   * 数文件、解开归档确认素材随行（这才是「导出」这个词的真意思）。
   */
  if (label === 'archive') {
    const scene = probe.archive ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('头部有「项目归档」按钮且可访问',
      scene.trigger?.label === '项目归档' && Number(scene.trigger?.width) >= 20,
      JSON.stringify(scene.trigger ?? null));
    report('「项目归档」按钮真的能点（elementFromPoint 命中它自己 —— 头部没被画布底盘盖住）',
      scene.trigger?.onTop === true, `hit=${scene.trigger?.hit ?? '(none)'}`);
    report('点一下打开面板，面板在视口内、尺寸正常',
      Number(scene.opened?.width) >= 420 && Number(scene.opened?.height) >= 200 &&
        scene.opened?.insideViewport === true,
      JSON.stringify(scene.opened ? { w: scene.opened.width, h: scene.opened.height } : null));
    report('规模读数是真数字（2 个节点 / 素材 2 个）',
      /2 个节点/.test(String(scene.opened?.info ?? '')) &&
        /素材 2 个/.test(String(scene.opened?.info ?? '')),
      String(scene.opened?.info ?? ''));
    report('导出目录默认落在这台机器的下载目录里',
      /downloads$/i.test(String(scene.opened?.dir ?? '')),
      String(scene.opened?.dir ?? ''));
    report('「导出到目录」按钮存在且有可点尺寸',
      Number(scene.buttonBox?.width) >= 60 && Number(scene.buttonBox?.height) >= 24,
      JSON.stringify(scene.buttonBox ?? null));
    report('点导出后面板给出成功提示（ok）',
      scene.exported?.noticeKind === 'ok' && /已导出/.test(String(scene.exported?.notice ?? '')),
      String(scene.exported?.notice ?? '').slice(0, 160));
    report('提示里带落盘路径（downloads 目录）',
      /downloads/i.test(String(scene.exported?.notice ?? '')),
      String(scene.exported?.notice ?? '').slice(0, 160));
    report('排查读数记到了这次导出（saves ≥ 1）',
      Number(scene.report?.saves ?? 0) >= 1,
      JSON.stringify({ saves: scene.report?.saves, infoReads: scene.report?.infoReads }));
    // ---- node 侧：文件真的落地了吗？素材真的随行了吗？ ----
    const exportsDir = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'downloads');
    const archives = existsSync(exportsDir)
      ? readdirSync(exportsDir).filter((name) => name.endsWith('.fisherai'))
      : [];
    report('导出目录里真的出现了 .fisherai 文件', archives.length >= 1, archives.join(', '));
    let archive = null;
    if (archives.length) {
      try {
        archive = JSON.parse(readFileSync(join(exportsDir, archives[archives.length - 1]), 'utf8'));
      } catch {
        archive = null;
      }
    }
    report('落盘的是本插件归档格式（format/version/project.id 都对）',
      archive?.format === 'dsh-aifisher-project' && archive?.version === 1 &&
        archive?.project?.id === archiveProjectId,
      `${archive?.format} v${archive?.version} ${archive?.project?.id}`);
    report('素材真的随行了（2 张，且都是这个项目的）',
      Object.keys(archive?.media ?? {}).length === ARCHIVE_MEDIA_FILES.length &&
        Object.keys(archive?.media ?? {}).every((key) => key.startsWith(`${archiveProjectId}/`)),
      Object.keys(archive?.media ?? {}).join(','));
    if (scene.error) console.log(`[browser] 场景异常：${String(scene.error).slice(0, 300)}`);
  }

  /**
   * 图片编辑场景（?xedit=studio|annotate，v1.26）：用户报的两件事的真机回归。
   *
   *   「点击保存为新图片没有添加到画布里」→ 保存按钮点下去之后画布上必须真的多一个
   *   带 `/api/aifisher/canvas/media/` 结果图的节点（这是走完 POST /assets/images 的铁证）；
   *   「图像编辑的 ui 美化还没有补全」→ 工作台/舞台的几何与视觉：全屏铺在画布上、
   *   工具按钮在画布范围内、vendor 那套 `.af-image-studio` 不再出现、蒙版舞台的
   *   canvas 与图片严丝合缝（不能有偏移，否则画笔点位全错）。
   */
  if (label === 'image-editor' || label === 'image-annotate') {
    const scene = probe.imageEditor ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('选中有结果图的节点后能打开 nova 版图片编辑',
      scene.selected === true && !scene.error, String(scene.error ?? ''));
    report('工作台全屏铺在画布容器上（宽高与画布一致）',
      scene.studio?.coversCanvas === true,
      `${scene.studio?.width}x${scene.studio?.height}`);
    report('工作台头部 / 底栏高度在正常范围（48 / 48，不是被压扁）',
      Number(scene.studio?.headerHeight) >= 40 && Number(scene.studio?.footerHeight) >= 40,
      `header=${scene.studio?.headerHeight} footer=${scene.studio?.footerHeight}`);
    report('四个工具按钮都在画布范围内、尺寸正常（不是被挤成 0 宽）',
      Array.isArray(scene.studio?.tools) && scene.studio.tools.length === 4 &&
        scene.studio.allToolsInside === true &&
        scene.studio.tools.every((tool) => tool.width >= 60 && tool.height >= 24),
      JSON.stringify(scene.studio?.tools ?? null));
    report('vendor 的旧图片编辑界面不再出现（没有 .af-image-studio）',
      scene.studio?.vendorStudioGone === true);
    report('没应用编辑时「保存为新图片」是禁用态（文案仍是保存为新图片）',
      scene.studio?.saveDisabled === true && String(scene.studio?.saveText || '').includes('保存为新图片'),
      `${scene.studio?.saveText} disabled=${scene.studio?.saveDisabled}`);

    if (label === 'image-editor') {
      report('裁剪舞台画布量到了真实尺寸（图片解码成功）',
        Number(scene.crop?.width) > 100 && Number(scene.crop?.height) > 100,
        `${scene.crop?.width}x${scene.crop?.height}`);
      report('真拖一个框后出现选区读数（宽 × 高）',
        /\d+\s*×\s*\d+/.test(String(scene.crop?.selection ?? '')),
        String(scene.crop?.selection ?? ''));
      report('应用按钮可点（选区内有内容）', scene.crop?.applyEnabled === true);
      report('应用裁剪后回到工作台首页且状态是「本次编辑已应用」', scene.applied === true);
      report('应用后「保存为新图片」变成可点', scene.saveEnabledAfterApply === true);
      report('点保存后画布上真的多出一个节点（用户报的 bug 的直接回归点）',
        Number(scene.saved?.nodeCountAfter) === Number(scene.saved?.nodeCountBefore) + 1,
        `${scene.saved?.nodeCountBefore} → ${scene.saved?.nodeCountAfter}`);
      report('新节点的结果图是落盘的媒体地址（POST /assets/images 成功了）',
        String(scene.saved?.imageSrc ?? '').includes('/api/aifisher/canvas/media/'),
        String(scene.saved?.imageSrc ?? ''));
      report('保存完成后工作台自动关闭', scene.saved?.studioClosed === true);
      report('保存后再打开工作台仍然正常（截图停在这）', scene.reopened === true);
    } else {
      report('蒙版舞台六个工具都在（笔刷/橡皮/矩形/圆形/箭头/直线）',
        Array.isArray(scene.annotation?.tools) && scene.annotation.tools.length === 6,
        JSON.stringify(scene.annotation?.tools ?? null));
      report('标注 canvas 与图片尺寸一致（画笔点位不会偏）',
        Number(scene.annotation?.canvasWidth) > 100 &&
          Math.abs(Number(scene.annotation?.canvasWidth) - Number(scene.annotation?.imageWidth)) <= 2,
        `canvas=${scene.annotation?.canvasWidth} image=${scene.annotation?.imageWidth}`);
      report('真画一笔后状态行计数 +1',
        /\d+\s*笔标注/.test(String(scene.annotation?.strokeText ?? '')),
        String(scene.annotation?.strokeText ?? ''));
      report('蒙版舞台的保存按钮是「应用编辑」且可点',
        scene.annotation?.saveLabel === '应用编辑' && scene.annotation?.saveEnabled === true,
        `${scene.annotation?.saveLabel} enabled=${scene.annotation?.saveEnabled}`);
      report('「应用编辑」后回到工作台且保存为新图片可点', scene.annotation?.applied === true);
      report('点保存后画布上又多出一个节点（标注结果也落盘了）',
        Number(scene.annotation?.saved?.nodeCountAfter) ===
          Number(scene.annotation?.saved?.nodeCountBefore) + 1,
        `${scene.annotation?.saved?.nodeCountBefore} → ${scene.annotation?.saved?.nodeCountAfter}`);
      report('标注结果同样是落盘的媒体地址',
        String(scene.annotation?.saved?.imageSrc ?? '').includes('/api/aifisher/canvas/media/'),
        String(scene.annotation?.saved?.imageSrc ?? ''));
      report('保存后重新打开蒙版舞台仍然正常（截图停在这）',
        scene.annotation?.reopened === true);
    }
  }

  // 保存结果回看：画布上应该有两个节点，新节点带着 /media/ 结果图
  if (label === 'image-saved') {
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const nodes = Array.isArray(probe.editCanvas) ? probe.editCanvas : [];
    const saved = nodes.filter((node) => String(node.src || '').includes('/api/aifisher/canvas/media/'));
    report('画布上已经有「源图 + 保存出来的新图」两个节点', nodes.length >= 2,
      JSON.stringify(nodes.map((node) => node.id)));
    report('两个节点的结果图都是媒体地址（新图真的落盘了）',
      saved.length >= 2,
      JSON.stringify(nodes.map((node) => String(node.src || '').slice(-28))));
  }

  /**
   * 宫格裁剪（v1.46，?xedit=grid）：用户「画布宫格裁剪 ui 还没有更新」的真机回归。
   *
   * jsdom 只守结构（test-canvas-shadcn-ui 的第 5.6 段），这里量的是**真浏览器**才有的东西：
   * 舞台铺满画布、图片真的解码出尺寸、拖切线真的改了单格尺寸、3×3 与导出序号真的改了张数、
   * 保存真的走了 POST /assets/images（画布多出 2 个媒体节点）。
   */
  if (label === 'image-grid') {
    const scene = probe.imageEditor ?? {};
    const grid = scene.grid ?? {};
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('选中有结果图的节点后能打开 nova 版宫格裁剪',
      scene.selected === true && !scene.error, String(scene.error ?? ''));
    report('宫格舞台全屏铺在画布容器上（宽高与画布一致）',
      grid.coversCanvas === true, `${grid.width}x${grid.height}`);
    report('头部 / 底栏高度在正常范围（不是被压扁）',
      Number(grid.headerHeight) >= 40 && Number(grid.footerHeight) >= 40,
      `header=${grid.headerHeight} footer=${grid.footerHeight}`);
    report('宫格画布量到了真实尺寸（图片解码成功）',
      Number(grid.canvasWidth) > 100 && Number(grid.canvasHeight) > 100,
      `${grid.canvasWidth}x${grid.canvasHeight}`);
    report('vendor 那套旧裁剪器不再出现（没有 role=dialog[aria-label=裁切图片]）',
      grid.vendorDialog === false);
    report('默认 2×2 → 4 格，保存文案是「保存 4 张」',
      /4 格/.test(String(grid.countText)) && /保存 4 张/.test(String(grid.saveText)),
      `${grid.countText} / ${grid.saveText}`);
    report('6 个宫格预设都在画布范围内、尺寸正常',
      grid.presets === 6 && grid.presetsInside === true,
      `presets=${grid.presets} inside=${grid.presetsInside}`);
    report('工具条有 2 个间隙滑杆 / 7 个比例 / 4 个导出顺序',
      grid.sliders === 2 && grid.ratios === 7 && grid.orders === 4,
      `sliders=${grid.sliders} ratios=${grid.ratios} orders=${grid.orders}`);
    report('真拖第一条竖向切线后单格尺寸跟着变（切线真的可拖）',
      Boolean(grid.cellAfterDrag) && grid.cellAfterDrag !== grid.cellBefore,
      `${grid.cellBefore} → ${grid.cellAfterDrag}`);
    report('点 3×3 预设 → 9 格、保存文案变「保存 9 张」',
      /9 格/.test(String(grid.countAfterPreset)) && /保存 9 张/.test(String(grid.saveTextAfterPreset)),
      `${grid.countAfterPreset} / ${grid.saveTextAfterPreset}`);
    report('导出序号填 1,3 → 只导 2 张',
      /导出 2/.test(String(grid.countAfterSelection)) &&
        /保存 2 张/.test(String(grid.saveTextAfterSelection)),
      `${grid.countAfterSelection} / ${grid.saveTextAfterSelection}`);
    report('保存按钮可点', grid.saveEnabled === true);
    report('点保存后画布上真的多出 2 个节点（每格一张）',
      Number(grid.saved?.nodeCountAfter) === Number(grid.saved?.nodeCountBefore) + 2,
      `${grid.saved?.nodeCountBefore} → ${grid.saved?.nodeCountAfter}`);
    report('两张新图都是落盘的媒体地址（POST /assets/images 成功了）',
      Array.isArray(grid.saved?.imageSrcs) && grid.saved.imageSrcs.length === 2 &&
        grid.saved.imageSrcs.every((src) => String(src).includes('/api/aifisher/canvas/media/')),
      JSON.stringify((grid.saved?.imageSrcs ?? []).map((src) => String(src).slice(-24))));
    report('保存完成后宫格舞台自动关闭', grid.saved?.stageClosed === true);
    report('保存后再打开宫格舞台仍然正常（截图停在这）', grid.reopened === true);
  }

  /**
   * 项目数据目录取证场景（?ddir=1，v1.43）：设置 → 存储 里的「项目数据目录（缓存）」面板。
   *
   * 真机只验「面板真的挂在这一页上、读数是这台机器的真路径、按钮状态合理、有实际尺寸」
   * （截图就是交付图）。改目录/迁移的行为由 jsdom 的 `test:data-dir` 覆盖 ——
   * 真机上往别的盘写目录会污染测试机，不适合放进每次检查。
   */
  if (label === 'data-dir') {
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const shot = probe.settings?.dataDirShot ?? { panel: false };
    report('设置 → 存储里有「项目数据目录（缓存）」面板',
      shot.panel === true && Number(shot.width) > 400 && Number(shot.height) > 120,
      `${shot.width}×${shot.height}`);
    report('当前数据目录读数 = 这台机器的 DSH 数据目录（含 storages/dsh-aifisher-canvas）',
      /storages[\\/]+dsh-aifisher-canvas/i.test(String(shot.current || '')),
      String(shot.current || ''));
    report('默认目录读数也在',
      /storages[\\/]+dsh-aifisher-canvas/i.test(String(shot.defaultDir || '')),
      String(shot.defaultDir || ''));
    report('状态文案说清「正在使用默认目录 / 还没生效」',
      /正在使用默认目录|还没生效/.test(String(shot.status || '')),
      String(shot.status || ''));
    report('默认状态下 overridden=false、restart=false、「恢复默认」不可点',
      shot.overridden === 'false' && shot.restart === 'false' && shot.resetDisabled === true,
      JSON.stringify({ overridden: shot.overridden, restart: shot.restart, reset: shot.resetDisabled }));
    report('输入框预填了当前目录、应用按钮文案是「应用」',
      String(shot.input || '').toLowerCase() === String(shot.current || '').toLowerCase() &&
        /应用/.test(String(shot.applyLabel || '')),
      `${String(shot.input || '').slice(0, 60)} / ${shot.applyLabel}`);
  }

  /**
   * 切刀（?xknife=1，v1.49）：用户「像blender一样按住ctrl加鼠标右键切换到切刀工具，
   * 划过的线会断开连接」。这一场是真浏览器里**真派发 Ctrl + 右键拖拽**，验：
   * 起刀预览（浮层 + 红线高亮）、松手只断开被划过的那条、交付图停在「切到一半」。
   */
  if (label === 'knife') {
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const knife = probe.knife ?? {};
    report('切刀场景跑完了（真拖了 Ctrl+右键，没有半途报错）',
      knife.done === true && !knife.error, String(knife.error ?? '').slice(0, 240));
    report('切刀桥装上了（window.__FISHERAI_CANVAS_KNIFE__.cut）', knife.bridge === true);
    report('起刀时有刀口线 + 被划过的连线变红（只有那一条）',
      knife.preview?.overlay === true && Number(knife.preview?.strokeChars) > 0 &&
        Number(knife.preview?.hintCount) === 1,
      JSON.stringify(knife.preview ?? null));
    report('松手后只断开被划过的那条（A→C 没了，B→C 还在）',
      new Set(knife.before ?? []).size === 2 && (knife.before ?? []).includes('knife-a') &&
        (knife.before ?? []).includes('knife-b') &&
        JSON.stringify(knife.after) === JSON.stringify(['knife-b']),
      JSON.stringify({ before: knife.before, after: knife.after }));
    report('切刀读数：这一场开过 1 次、切中 1 条、断开 1 条、无错误',
      Number(knife.report?.sessions) >= 1 && knife.report?.targets === 1 && knife.report?.cuts === 1 &&
        (knife.report?.lastError ?? '') === '',
      JSON.stringify(knife.report));
    report('交付图停在「切到一半」（刀口与红线还在画面上）',
      knife.delivery?.overlay === true && knife.delivery?.hint === true,
      JSON.stringify(knife.delivery ?? null));
  }

  /**
   * 画布互动开关取证场景（?effects=1，v1.27）：设置 → 画布外观 里的「画布互动」面板。
   * 断言面板真的挂上了、开关是开着的、面板有实际尺寸（截图里看得见），截图就是交付图。
   */
  if (label === 'effects') {
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const shot = probe.settings?.effectsShot ?? { panel: false };
    report('设置 → 画布外观里有「画布互动」面板，开关是开着的',
      shot.panel === true && shot.role === 'switch' && shot.ariaChecked === 'true',
      JSON.stringify({ panel: shot.panel, role: shot.role, ariaChecked: shot.ariaChecked }));
    report('面板有实际尺寸（不是被挤成一条）、文案是「鼠标互动效果」',
      Number(shot.width) > 300 && Number(shot.height) > 60 && /鼠标互动效果/.test(String(shot.text)),
      `${shot.width}×${shot.height} ${String(shot.text).slice(0, 80)}`);
  }

  /**
   * 「OpenAI 通道」面板取证场景（?channels=1，v1.30）：设置 → 闭源服务 里的多通道面板。
   * 断言面板真的挂上了、有实际尺寸、方言下拉四项、两个一键预设都在 —— 截图就是交付图。
   */
  if (label === 'channels') {
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    const shot = probe.settings?.channelsShot ?? { panel: false };
    report('截图取证：设置 → 闭源服务 → OpenAI 通道面板在画面里（有实际尺寸）',
      shot.panel === true && Number(shot.width) > 600 && Number(shot.height) > 240 && Number(shot.cards) >= 1,
      `${shot.width}×${shot.height} cards=${shot.cards}`);
    report('请求方言下拉有四项（自动 / OpenAI 兼容 / 魔搭 / FisherAI）',
      shot.dialectOptions === 4 && shot.dialectValue === '',
      `options=${shot.dialectOptions} value=${shot.dialectValue}`);
    report('两个一键预设都在（魔搭 API-Inference + FisherAI）',
      Array.isArray(shot.presetLabels) &&
        shot.presetLabels.length === 2 &&
        /魔搭/.test(String(shot.presetLabels[0] || '')) &&
        /FisherAI/.test(String(shot.presetLabels[1] || '')),
      JSON.stringify(shot.presetLabels));
    report('面板说明里写清了 FisherAI 的路径差异（/image/generations）',
      /image\/generations/.test(String(shot.text || '')),
      String(shot.text || '').slice(0, 120));
  }

  /**
   * 设置页场景：v1.1 补的四块后端到底有没有把 UI 点亮。
   * 断言分两层：① 分区里**没有错误提示**（以前这四页全是红的）；② 分区里有它该有的东西。
   */
  if (label === 'settings') {
    const settings = probe.settings ?? { opened: false, sections: {} };
    const report = (name, good, extra = '') => {
      if (!good) browserFailures += 1;
      console.log(`[browser] ${good ? 'PASS' : 'FAIL'}  ${label}: ${name}${extra ? `  [${extra}]` : ''}`);
    };
    report('侧边栏「设置」能打开对话框', settings.opened === true);
    const section = (id) => settings.sections?.[id] ?? {};
    report('画布外观分区渲染出背景设置', section('appearance').background === true, section('appearance').alertText || '');
    report('开源服务分区显示 ComfyUI 状态（不再是报错页）',
      section('local-service').comfyHeading === true && section('local-service').gpuRow === true,
      section('local-service').alertText || section('local-service').text?.slice(0, 120));
    report('闭源服务分区不再有「自配云端端点」单端点卡片（v1.13 移除，只留方舟）',
      section('models').legacyCard === false && section('models').legacySecretField === false,
      section('models').alertText || section('models').text?.slice(0, 120));
    report('闭源服务分区挂上了「OpenAI 通道」多通道面板（v1.11）',
      section('models').channelPanel === true && section('models').channelHeading === true,
      JSON.stringify(settings.channels ?? {}) || section('models').text?.slice(0, 120));
    report('点「+ 添加通道」能长出一张通道卡片',
      (settings.channels?.after ?? 0) > (settings.channels?.before ?? 0),
      JSON.stringify(settings.channels ?? {}));
    /**
     * v1.29：请求方言（参考图放 image 还是 image_url）。
     *
     * 这条**没有报错可依赖** —— 魔搭对 OpenAI 形状的 `image` 不报错、直接把参考图丢掉，
     * 于是「图片编辑」静默变成「重新画一张」。所以设置页必须能看见这一项、能改，
     * 并且「自动」要当场把判定结果写出来（预置通道的地址是魔搭域名 → 应判成魔搭）。
     * v1.30 多了一套 FisherAI（work-fisher）方言 → 选项从 3 变 4。
     */
    const dialect = settings.channelDialect ?? {};
    report('通道卡片里有「请求方言」下拉，默认停在「自动」（自动 + OpenAI/魔搭/FisherAI 四项）',
      dialect.selectPresent === true && dialect.value === '' && dialect.optionCount === 4,
      JSON.stringify({ present: dialect.selectPresent, value: dialect.value, options: dialect.optionCount }));
    report('「自动」按地址判出来并写在界面上（魔搭域名 → 魔搭 ModelScope）',
      /自动/.test(dialect.hintText || '') && /魔搭 ModelScope/.test(dialect.hintText || ''),
      dialect.hintText || '(missing)');
    report('方言下拉有正常宽度（不是被挤成 0 宽的空白）',
      (dialect.selectWidth ?? 0) > 60 && (dialect.selectWidth ?? 0) < 520,
      `width=${dialect.selectWidth}`);
    report('面板上有「魔搭 API-Inference」一键预设（魔搭的 GET /models 里没有 Qwen-Image-2.1-Turbo）',
      dialect.presetPresent === true && /魔搭/.test(dialect.presetLabel || ''),
      dialect.presetLabel || '(missing)');
    report('面板上有「FisherAI（work-fisher）」一键预设（路径/尺寸/参考图三处都与 OpenAI 不同）',
      Array.isArray(dialect.presetLabels)
        && dialect.presetLabels.some(function (label) { return /FisherAI/.test(label); }),
      JSON.stringify(dialect.presetLabels));
    /**
     * v1.12：「模型名称看得见」+「每条模型能给别名」。
     * 这两条是 2026-10-16 用户报障的直接回归点，量的是真浏览器里的像素宽度。
     */
    const modelRows = settings.channelModels ?? {};
    report('通道卡片里能展开模型列表（预置那条 2 条模型）',
      modelRows.rows === 2,
      JSON.stringify(modelRows));
    report('模型行里看得见模型 ID（不是被挤成 0 宽的空白）',
      modelRows.aliasName === CHANNEL_FIXTURE.aliasModelId &&
        modelRows.aliasNameWidth > 60 &&
        modelRows.plainName === CHANNEL_FIXTURE.plainModelId &&
        modelRows.plainNameWidth > 60,
      JSON.stringify({ aliasName: modelRows.aliasName, aliasNameWidth: modelRows.aliasNameWidth, plainName: modelRows.plainName, plainNameWidth: modelRows.plainNameWidth }));
    report('类型下拉不再占满整行（行内控件不能带 w-full）',
      modelRows.kindWidth > 60 && modelRows.kindWidth < 160,
      `kindWidth=${modelRows.kindWidth}`);
    report('已保存的别名回填进行内输入框（可改）',
      modelRows.aliasValue === CHANNEL_FIXTURE.alias && modelRows.aliasEnabled === true && modelRows.plainAliasValue === '',
      JSON.stringify({ aliasValue: modelRows.aliasValue, aliasEnabled: modelRows.aliasEnabled, plainAliasValue: modelRows.plainAliasValue }));
    report('存储分区显示下载目录',
      section('storage').downloadSetting === true && /downloads/.test(section('storage').downloadDir || ''),
      section('storage').downloadDir || section('storage').alertText);
    /**
     * v1.27：「在设置里做一个开关」—— 画布外观页里真有一块「画布互动」面板，
     * 开关是 role=switch，点一下关掉（网格层同步 off、状态落 localStorage），再点恢复。
     */
    const effects = settings.effects ?? {};
    report('画布外观分区挂上了「画布互动」面板与 role=switch 的开关（v1.27）',
      section('appearance').effectsPanel === true &&
        section('appearance').effectsSwitch?.role === 'switch',
      JSON.stringify(section('appearance').effectsSwitch ?? null));
    report('开关默认是开的（aria-checked=true）',
      settings.effects?.before === 'true',
      String(settings.effects?.before));
    report('点开关能关掉：aria-checked 变 false、面板状态 off、画布网格层同步变 off',
      effects.after === 'false' && effects.panelState === 'off' && effects.grid === 'off',
      JSON.stringify(effects));
    report('关掉的状态写进本机 localStorage（pointerGlow:false）',
      String(effects.stored ?? '').includes('"pointerGlow":false'),
      String(effects.stored ?? '(null)'));
    report('再点一下恢复开（回来时开关是开着的）',
      effects.restored === 'true',
      String(effects.restored));
    for (const id of ['appearance', 'local-service', 'models', 'storage']) {
      report(`分区 ${id} 没有错误提示`, !section(id).alertText, section(id).alertText || '');
    }
    report('设置对话框仍在画布容器内交互（越界检查同上一段）', true);
  }
}
console.log(`[browser] SUMMARY fail=${browserFailures}`);

server.close();
// 任务队列场景里那条 Slow 请求是我们自己**故意不返回**的：关服之后把还挂着的连接掐掉，
// 否则进程会等着那几十秒的定时器（现象：SUMMARY 打完却迟迟不退出）。
server.closeAllConnections?.();
if (!KEEP) {
  rmSync(profile, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}
console.log(`[browser] 截图目录：${SHOTS}`);
