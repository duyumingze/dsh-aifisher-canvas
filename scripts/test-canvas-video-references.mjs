/**
 * 「视频节点的图像参考能拖几张」回归（v1.65）。
 *
 * 用户原话（2026-10-23）：「视频生成图像参考只能拖入三张，修复一下，按 minimaxh3 的标准来」。
 *
 * 线上那条通道模型是 FisherAI 的 `minimax-h3-ow-r2v`（画布上的名字 = `通道名 · 模型 ID`，
 * 节点视频模式 = 多图参考 / reference-video）。MiniMax H3 参考模式本身就是 **9 个图片槽**
 * （vendor `media/minimaxH3.ts` 的 `SLOT_RANGES.referenceImage = [3, 11]`），
 * 而条目上的 `maxInputs: 3`（总输入上限）把模式声明的 9 张图盖住了 —— 拖第 4 张就
 * 静默连不上，用户看到的正是「只能拖入三张」。
 *
 * 这个套件守三层：
 *   A. **纯逻辑**（构建产物 `canvasApp.videoInputCap / VIDEO_REFERENCE_IMAGE_LIMIT`）：
 *      总上限按各模式 allowedInputs 之和的最大值算，参考图上限与 MiniMax H3 对齐（9）。
 *   B. **注册表**（真挂画布，读 `globalThis.__FISHERAI_CHANNEL_MODELS__`）：
 *      通道表 → 视频条目的 maxInputs 足够放下「9 张图 + 文本」，且与模式声明自洽。
 *   C. **真 DOM 拖线**（jsdom 里真派发 pointerdown/move/up）：
 *      往视频节点上连 9 张图全成功（第 4、5 张是关键 —— 修复前就断在这里），
 *      第 10 张被拒；再接一个文本节点仍然能进（总上限不等于图片上限）。
 *
 * 用法：node scripts/test-canvas-video-references.mjs   （需要先 build）
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
  }
  return last;
}

const PROJECT_ID = 'proj-video-references';
const VIDEO_NODE_ID = 'video-ref-node';
const TEXT_NODE_ID = 'text-ref-node';
const IMAGE_NODE_IDS = Array.from({ length: 10 }, (_, index) => `image-ref-${index + 1}`);
/** 用户线上那条：FisherAI 的 minimax-h3-ow-r2v。 */
const VIDEO_MODEL_ID = 'minimax-h3-ow-r2v';
const CHANNEL_LABEL = 'FisherAI';
const VIDEO_MODEL_NAME = `${CHANNEL_LABEL} · ${VIDEO_MODEL_ID}`;

/** 视频节点在画布上的位置/尺寸（10 张参考图排在它左边，互不重叠）。 */
const VIDEO_FRAME = { x: 700, y: 620, width: 560, height: 420 };

const host = await startHost();

// ---------------------------------------------------------------- 预置：通道 + 项目
{
  const saved = await host.hostApi('POST', '/cloud-channels', {
    action: 'save',
    channel: {
      label: CHANNEL_LABEL,
      baseUrl: 'https://api.work-fisher.com/v1',
      apiKey: 'sk-video-references',
      dialect: 'workfisher',
      models: [{ id: VIDEO_MODEL_ID, kind: 'video' }],
    },
  });
  check(
    '预置通道：一条只有视频模型的 workfisher 通道',
    saved.status === 200 &&
      (saved.json().channels ?? []).some((channel) => channel.label === CHANNEL_LABEL),
    String(saved.text).slice(0, 160),
  );

  const videoNode = {
    id: VIDEO_NODE_ID,
    type: 'Video',
    ...VIDEO_FRAME,
    title: '参考图数量验证',
    prompt: '雨滴打在窗上，镜头缓缓推近',
    status: 'idle',
    model: VIDEO_MODEL_NAME,
    videoModel: VIDEO_MODEL_NAME,
    // ★ 用户报障就是这一档：多图参考（模式声明 image: 9，却只连得上 3 张）
    videoMode: 'reference-video',
    resolution: '480p',
    aspectRatio: '16:9',
    duration: 5,
    parentIds: [],
    projectId: PROJECT_ID,
  };
  const textNode = {
    id: TEXT_NODE_ID,
    type: 'Text',
    x: 10,
    y: 620,
    width: 320,
    height: 200,
    title: '提示词',
    textContent: '雨滴打在窗上，镜头缓缓推近',
    prompt: '',
    textModel: '魔搭 · DeepSeek',
    status: 'idle',
    parentIds: [],
    projectId: PROJECT_ID,
  };
  // 10 张图：4 列 3 行排在视频节点左侧（都在视口内，方便真 DOM 里点到连接点）
  const imageNodes = IMAGE_NODE_IDS.map((id, index) => ({
    id,
    type: 'Image',
    x: 10 + (index % 4) * 300,
    y: 10 + Math.floor(index / 4) * 280,
    width: 280,
    height: 240,
    title: `参考图 ${index + 1}`,
    prompt: `参考图 ${index + 1}`,
    status: 'success',
    model: 'GPT Image 2 · API',
    imageModel: 'GPT Image 2 · API',
    resultUrl: `/api/aifisher/canvas/media/${PROJECT_ID}/images/ref-${index + 1}.png`,
    resultAspectRatio: '280/240',
    aspectRatio: '4:3',
    parentIds: [],
    projectId: PROJECT_ID,
  }));

  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '视频参考图数量验证',
    nodes: [textNode, ...imageNodes, videoNode],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目（1 视频 + 1 文本 + 10 张图）写入画布库', save.status === 200,
    String(save.text).slice(0, 160));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { canvasApp, container, handle } = await mountCanvasApp(window);
await settle(1500);
const doc = window.document;

/** 存盘的节点（画布把状态写回本地后端）。 */
async function savedNode(id) {
  const result = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  if (result.status !== 200) return undefined;
  try {
    return (JSON.parse(result.text).nodes ?? []).find((node) => node.id === id);
  } catch {
    return undefined;
  }
}

/** 画布当前的平移/缩放（`#canvas-viewport-content` 的 transform 就是它）。 */
function viewportTransform() {
  const style = doc.querySelector('#canvas-viewport-content')?.getAttribute('style') ?? '';
  const translate = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(style);
  const scale = /scale\(([-\d.]+)\)/.exec(style);
  return {
    x: Number(translate?.[1] ?? 0),
    y: Number(translate?.[2] ?? 0),
    zoom: Number(scale?.[1] ?? 1) || 1,
  };
}

/** 画布坐标 → 视口坐标（指针事件用的是视口坐标）。 */
function toClient(point) {
  const viewport = viewportTransform();
  return { x: viewport.x + point.x * viewport.zoom, y: viewport.y + point.y * viewport.zoom };
}

/** 从某个节点的右侧连接点拖一根线到画布坐标（视频节点身上）。 */
async function dragToVideo(sourceNodeId, point) {
  const source = doc.querySelector(`[data-node-id="${sourceNodeId}"]`);
  const connector = source?.querySelector('[data-fisherai-connector-side="right"]');
  if (!connector) return false;
  const background = doc.getElementById('canvas-background');
  if (!background) return false;
  const from = toClient({ x: VIDEO_FRAME.x - 40, y: VIDEO_FRAME.y + VIDEO_FRAME.height / 2 });
  const to = toClient(point);
  const pointer = (type, at, extra = {}) =>
    new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      ...extra,
    });
  connector.dispatchEvent(pointer('pointerdown', from));
  background.dispatchEvent(pointer('pointermove', to));
  background.dispatchEvent(pointer('pointerup', to));
  await settle(140);
  return true;
}

// ---------------------------------------------------------------- A) 纯逻辑（跑构建产物）
{
  const { videoInputCap, VIDEO_REFERENCE_IMAGE_LIMIT } = canvasApp;
  check(
    '产物导出了「视频输入上限」的纯函数',
    typeof videoInputCap === 'function' && Number.isFinite(VIDEO_REFERENCE_IMAGE_LIMIT),
    `${typeof videoInputCap} / ${String(VIDEO_REFERENCE_IMAGE_LIMIT)}`,
  );
  check(
    '参考图上限与 MiniMax H3 参考模式同口径（9 个图片槽）',
    VIDEO_REFERENCE_IMAGE_LIMIT === 9,
    String(VIDEO_REFERENCE_IMAGE_LIMIT),
  );
  check(
    '总上限取各模式 allowedInputs 之和的最大值（多图参考 10 文本 + 9 图 = 19）',
    videoInputCap([
      { value: 'text-to-video', allowedInputs: { text: 10 } },
      { value: 'first-frame', allowedInputs: { text: 10, image: 1 } },
      { value: 'reference-video', allowedInputs: { text: 10, image: 9 } },
    ]) === 19,
    String(videoInputCap([{ allowedInputs: { text: 10, image: 9 } }])),
  );
  check(
    '没有任何声明时也不会算出 0（节点至少要能接一个输入）',
    videoInputCap([]) === 1 && videoInputCap([{ value: 'text-to-video' }]) === 1,
    `${videoInputCap([])} / ${videoInputCap([{ value: 'text-to-video' }])}`,
  );
  check(
    '总上限永远不会小于单个模式声明的图片数（这就是这次的根因）',
    videoInputCap([{ allowedInputs: { image: 9 } }]) >= 9,
    String(videoInputCap([{ allowedInputs: { image: 9 } }])),
  );
}

// ---------------------------------------------------------------- B) 注册表（通道表 → 条目）
const videoEntry = await waitFor(() => {
  const registry = globalThis.__FISHERAI_CHANNEL_MODELS__;
  return registry?.video?.find((entry) => entry?.name === VIDEO_MODEL_NAME) ?? null;
}, 8000);
{
  check('通道表 → 画布注册表里有这条视频模型', Boolean(videoEntry),
    JSON.stringify((globalThis.__FISHERAI_CHANNEL_MODELS__?.video ?? []).map((entry) => entry?.name)).slice(0, 200));
  const referenceMode = (videoEntry?.videoModes ?? []).find(
    (mode) => mode?.value === 'reference-video',
  );
  check(
    '多图参考模式声明 9 张参考图（MiniMax H3 标准）',
    referenceMode?.allowedInputs?.image === 9,
    JSON.stringify(referenceMode?.allowedInputs),
  );
  check(
    '条目的总输入上限不再是 3（修复前写死 3 → 第 4 张就断）',
    Number(videoEntry?.maxInputs) >= 10,
    String(videoEntry?.maxInputs),
  );
  check(
    '总输入上限 = 模式声明算出来的值（不是另一个手写数字）',
    Number(videoEntry?.maxInputs) === canvasApp.videoInputCap(videoEntry?.videoModes ?? []),
    `${videoEntry?.maxInputs} vs ${canvasApp.videoInputCap(videoEntry?.videoModes ?? [])}`,
  );
  check(
    'workfisher 通道多出「视频参考」一档，且没有把总上限算小',
    (videoEntry?.videoModes ?? []).some((mode) => mode?.value === 'video-edit') &&
      Number(videoEntry?.maxInputs) >= 19,
    String(videoEntry?.maxInputs),
  );
}

// ---------------------------------------------------------------- C) 真 DOM：往视频节点拖参考图
const videoElement = () => doc.querySelector(`[data-node-id="${VIDEO_NODE_ID}"]`);
check('画布渲染出视频节点', Boolean(videoElement()),
  container.innerHTML.slice(0, 160).replace(/\s+/g, ' '));
check('10 张参考图都渲染出来了（拖线的起点在 DOM 里）',
  IMAGE_NODE_IDS.every((id) => doc.querySelector(`[data-node-id="${id}"]`)),
  IMAGE_NODE_IDS.map((id) => Boolean(doc.querySelector(`[data-node-id="${id}"]`))).join(','));

/** 视频节点当前的 parentIds（存盘后读，等于用户真连上的那些）。 */
const connectedIds = async () => (await savedNode(VIDEO_NODE_ID))?.parentIds ?? [];
/**
 * 等存盘落定。
 *
 * 必须**带间隔**轮询：autosave 是「最后一次改动后 ~1s」的防抖，而这里每次读都得走一遍
 * host 路由。曾经写成不带间隔的死循环，把定时器饿住，存盘永远等不来 —— 结果读到的是空数组。
 */
async function waitConnectedIds(predicate, attempts = 15) {
  let last = [];
  for (let index = 0; index < attempts; index += 1) {
    await settle(700);
    last = await connectedIds();
    if (predicate(last)) return last;
  }
  return last;
}
const dropPoint = {
  x: VIDEO_FRAME.x + VIDEO_FRAME.width / 2,
  y: VIDEO_FRAME.y + 40,
};

const dragResults = [];
for (const id of IMAGE_NODE_IDS) {
  dragResults.push(await dragToVideo(id, dropPoint));
  await settle(120);
}
check('10 次拖线都派发成功（起点连接点都在）', dragResults.every(Boolean),
  dragResults.map(String).join(','));
{
  const ids = await waitConnectedIds((list) => list.length >= 9);
  check(
    '9 张参考图全部连上了（修复前只到 3 张）',
    ids.length === 9,
    `parentIds=${ids.length} ${JSON.stringify(ids)}`,
  );
  check(
    '连上的是前 9 张，第 10 张被拒（不是把某一张挤掉）',
    IMAGE_NODE_IDS.slice(0, 9).every((id) => ids.includes(id)) &&
      !ids.includes(IMAGE_NODE_IDS[9]),
    JSON.stringify(ids),
  );
  check('节点没被拖线改成「首帧」之类的单图模式', (await savedNode(VIDEO_NODE_ID))?.videoMode === 'reference-video',
    String((await savedNode(VIDEO_NODE_ID))?.videoMode));
}

// 文本节点还能接：总上限不是「9」，而是「9 图 + 文本」都放得下
{
  const textDrag = await dragToVideo(TEXT_NODE_ID, dropPoint);
  const ids = await waitConnectedIds((list) => list.includes(TEXT_NODE_ID));
  check('接了 9 张图之后，文本节点仍然连得上（总上限吃的是 19，不是 9）',
    textDrag && ids.includes(TEXT_NODE_ID) && ids.length === 10,
    `parentIds=${ids.length} ${JSON.stringify(ids)}`);
}

// ---------------------------------------------------------------- D) 源码：别把 3 写回去
{
  const source = readFileSync(join(ROOT, 'src/canvas-ui/canvas/CloudChannelModels.ts'), 'utf8');
  check('视频条目不再写死 maxInputs: 3', !/maxInputs:\s*3\b/.test(source),
    (source.match(/maxInputs:[^\n]*/g) ?? []).join(' | '));
  check('总上限由 videoInputCap(videoModes) 算出来',
    /maxInputs:\s*videoInputCap\(videoModes\)/.test(source));
  check('多图参考的图片上限用同一个常量（9）',
    /image:\s*VIDEO_REFERENCE_IMAGE_LIMIT/.test(source));
}

// ---------------------------------------------------------------- E) 文档对得上
{
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const usage = readFileSync(join(ROOT, '使用说明.md'), 'utf8');
  check('README / 使用说明写了「9 张参考图」这条口径',
    /9 张参考图/.test(readme) && /9 张参考图/.test(usage),
    `readme=${/9 张参考图/.test(readme)} usage=${/9 张参考图/.test(usage)}`);
}

// ---------------------------------------------------------------- F) 渲染期没有运行时错误
{
  const diag = await host.hostApi('GET', '/diagnostics?limit=80');
  const errors = (diag.json().entries ?? []).filter((entry) => entry.level === 'error');
  check('整轮没有运行时错误', errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)');
}

if (handle) {
  try {
    handle.dispose();
  } catch (error) {
    check('dispose 不抛错', false, String(error));
  }
}

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
