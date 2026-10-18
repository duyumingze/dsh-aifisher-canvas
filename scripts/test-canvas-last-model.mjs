/**
 * 「新建节点默认用上一次生成任务那个模型」回归（v1.40）。
 *
 * 用户原话（2026-10-18）：
 *   「我刚建完一个节点后需要我再次调整模型，可不可以改成新的节点会默认使用上一次生成任务所使用的模型」
 *
 * 这条用例守四件事：
 *   A. **纯逻辑**（跑在构建产物上）：按 image/video/audio/text 分桶记、只认还留在目录里的名字、
 *      存档读写（含坏存档 / 脏值 / 非法 kind）、写盘次数只在真变化时 +1。
 *   B. **画布内真行为**：在节点上**真点模型下拉**换到另一款 → 节点存盘换掉、记忆跟着换 →
 *      再新建一个 Image 节点，默认模型就是那一款（这才是用户要的效果）。
 *      另外守两条反向：记忆里的模型已经不在目录里 → 回落目录第一个（绝不把节点写成打不通的模型）；
 *      图片记忆不能串到视频节点。
 *   C. **产物 / 补丁存在性**：桥在、vendor 补丁真的落进源码（建节点时问、换模型/发生成时记）。
 *
 * 为什么「回落目录第一个」是硬要求：v1.31 用户报过「新建节点默认模型不是我配置好的」，
 * 那是节点被写成一条本插件没有后端的模型（点生成只回 501）。这条特性绝不能把它带回来。
 *
 * 用法：node scripts/test-canvas-last-model.mjs    （需要先 build）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

async function waitFor(probe, timeoutMs = 9000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await settle(120);
  }
  return last;
}

const PROJECT_ID = 'proj-canvas-last-model';
/**
 * 一条通道 + 两个图片模型 + 一个视频模型。
 *
 * 「两个图片模型」是这条特性的前提：第一个是新建节点的默认值（模型目录第一个），
 * 第二个用来验「换成它之后，下一个新节点默认也是它」。视频模型那一条守「分桶不许串」。
 */
const CHANNEL = {
  label: '记忆测试通道',
  /** 第一个图片模型带别名：画布上就叫「记忆A」（= 目录第一个 = 没记过时的默认值）。 */
  imageAId: 'Qwen/Qwen-Image',
  imageAAlias: '记忆A',
  /** 第二个图片模型不带别名：画布上的名字就是「通道名 · 模型 ID」。 */
  imageBId: 'Qwen/Qwen-Image-Edit',
  videoId: 'Wan2.2-T2V-A14B',
};
const IMAGE_A = CHANNEL.imageAAlias;
const IMAGE_B = `${CHANNEL.label} · ${CHANNEL.imageBId}`;
const VIDEO_A = `${CHANNEL.label} · ${CHANNEL.videoId}`;
/** 换个不存在的名字（通道被删 / 模型被取消勾选 / 改了别名之后的样子）。 */
const GONE_MODEL = '早就被删掉的通道 · 不存在的模型';

const SEED_NODE_ID = 'node-last-model-seed';

const host = await startHost();
{
  const saved = await host.hostApi('POST', '/cloud-channels', {
    action: 'save',
    channel: {
      label: CHANNEL.label,
      // 环回闭端口：这条用例要**真点一次生成**（验「发起生成时把模型记下来」），
      // 但绝不能真花钱／真等远端 —— 端口 9 一连接就被拒，请求立即失败，
      // 而「记模型」发生在发请求之前，正好只验这一件事。
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-last-model-check',
      // 顺序有意义：imageA 必须是目录里的**第一个**图片模型
      models: [
        { id: CHANNEL.imageAId, kind: 'image', label: CHANNEL.imageAAlias },
        { id: CHANNEL.imageBId, kind: 'image' },
        { id: CHANNEL.videoId, kind: 'video' },
      ],
    },
  });
  check('预置一条通道（两个图片模型 + 一个视频模型）', saved.status === 200,
    String(saved.text).slice(0, 120));
}
{
  const saved = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '上次模型回归',
    nodes: [
      {
        id: SEED_NODE_ID,
        type: 'Image',
        x: 40,
        y: 40,
        title: '拿它换模型',
        prompt: '一只猫趴在窗台上',
        status: 'idle',
        imageModel: IMAGE_A,
        imageMode: 'text-to-image',
        aspectRatio: '1:1',
        resolution: '1K',
        parentIds: [],
        projectId: PROJECT_ID,
        width: 360,
        height: 420,
        generateCount: 1,
      },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目（节点用第一个图片模型）写入本地后端', saved.status === 200,
    String(saved.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { container, canvasApp, handle } = await mountCanvasApp(window);
await settle(1800);
const doc = window.document;

/** 存盘的项目文档（画布把节点写回本地后端）。 */
async function savedDocument() {
  const result = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  if (result.status !== 200) return undefined;
  try {
    return JSON.parse(result.text);
  } catch {
    return undefined;
  }
}

/** 画布上已保存的节点（按 id）。 */
async function savedNode(id) {
  const document_ = await savedDocument();
  return (document_?.nodes ?? []).find((node) => node.id === id);
}

const nodeElement = (id) => container.querySelector(`[data-node-id="${id}"]`);

/** 点一下节点（composer / 模型下拉只在节点被选中时渲染）。 */
function clickNode(element) {
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
  return true;
}

/** 用画布自己的建节点桥新建一个节点（与右键菜单 / 节点搜索同一条路）。 */
async function addCanvasNode(type, point) {
  const before = new Set(((await savedDocument())?.nodes ?? []).map((node) => node.id));
  window.dispatchEvent(
    new window.CustomEvent('fisherai:add-canvas-node', { detail: { type, point } }),
  );
  return waitFor(async () => {
    const nodes = (await savedDocument())?.nodes ?? [];
    const created = nodes.filter((node) => !before.has(node.id) && node.type === type);
    return created.length ? created[created.length - 1] : null;
  }, 20000);
}

/**
 * 在节点的模型下拉里真点一次：一级「brand」→ 二级「版本 / 模型」→ 选中。
 *
 * 三级飞出层是「模型 → 来源」，我们这条通道的两个模型都只有**一个来源**，
 * 所以点二级那一行就直接选中（vendor 的 versionRow 对单来源就是这么处理的）。
 * 返回 detail 供断言展示（哪一步没走通，不能只看到一条红）。
 */
async function changeModelThroughPicker(frame, targetName) {
  const detail = { composer: false, opened: false, brands: [], versions: [], selected: false, reason: '' };
  if (!frame) {
    detail.reason = 'no frame';
    return detail;
  }
  clickNode(frame);
  await settle(400);
  const composer = frame.querySelector('[data-fisherai-generation-composer="image"]');
  if (!composer) {
    detail.reason = 'no composer';
    return detail;
  }
  detail.composer = true;
  // 模型下拉按钮的特征：有 aria-expanded、没有 aria-label（composer 里另一个 aria-expanded
  // 是「特殊功能」按钮，它带 aria-label——按这个把它们分开）。
  const button = [...composer.querySelectorAll('button[aria-expanded]')].find(
    (candidate) => !candidate.hasAttribute('aria-label'),
  );
  if (!button) {
    detail.reason = 'no model button';
    return detail;
  }
  button.click();
  const picker = await waitFor(
    () => (composer.querySelector('[data-fisherai-model-brand-header]') ? composer.querySelector('[data-fisherai-model-picker]') : null),
    12000,
  );
  if (!picker) {
    detail.reason = 'picker not ready';
    return detail;
  }
  detail.opened = true;
  const brands = [...picker.querySelectorAll('[data-fisherai-model-brand-header]')];
  detail.brands = brands.map((brand) => String(brand.getAttribute('data-fisherai-model-brand-header')));
  const brand = brands.find((candidate) => String(candidate.textContent ?? '').includes(CHANNEL.label));
  if (!brand) {
    detail.reason = 'no channel brand';
    return detail;
  }
  brand.click();
  const flyout = await waitFor(
    () => (composer.querySelector('[data-fisherai-model-flyout] [data-fisherai-model-header]')
      ? composer.querySelector('[data-fisherai-model-flyout]')
      : null),
    6000,
  );
  if (!flyout) {
    detail.reason = 'no version flyout';
    return detail;
  }
  const rows = [...flyout.querySelectorAll('[data-fisherai-model-header]')];
  detail.versions = rows.map((row) => String(row.getAttribute('data-fisherai-model-header')));
  const row = rows.find((candidate) => candidate.getAttribute('data-fisherai-model-header') === targetName);
  if (!row) {
    detail.reason = 'no target version';
    return detail;
  }
  row.click();
  detail.selected = true;
  return detail;
}

// ---------------------------------------------------------------- A) 纯逻辑（构建产物）
console.log('\n=== A) 纯逻辑：分桶 / 只认目录里的名字 / 存档 ===');
{
  const {
    CANVAS_LAST_MODEL_STORAGE_KEY,
    CANVAS_MODEL_KINDS,
    asCanvasModelKind,
    canvasLastModelReport,
    lastModelFor,
    pickCanvasModel,
    rememberLastModel,
    resetCanvasLastModel,
  } = canvasApp;
  check(
    '产物导出了「上次模型」的纯函数（remember / pick / report / reset / 键名）',
    typeof rememberLastModel === 'function' &&
      typeof pickCanvasModel === 'function' &&
      typeof canvasLastModelReport === 'function' &&
      typeof resetCanvasLastModel === 'function' &&
      CANVAS_LAST_MODEL_STORAGE_KEY === 'dsh-aifisher-canvas.last-model',
    `${typeof rememberLastModel}/${typeof pickCanvasModel}/${CANVAS_LAST_MODEL_STORAGE_KEY}`,
  );
  check(
    '分桶口径固定为 image / video / audio / text（与节点类型一一对应）',
    Array.isArray(CANVAS_MODEL_KINDS) &&
      CANVAS_MODEL_KINDS.join(',') === 'image,video,audio,text',
    String(CANVAS_MODEL_KINDS),
  );
  check(
    '非法 kind 一律不认（不会往存档里写奇怪的桶）',
    asCanvasModelKind('image') === 'image' && asCanvasModelKind('Image') === null && asCanvasModelKind(42) === null,
    String(asCanvasModelKind('Image')),
  );

  resetCanvasLastModel();
  check(
    '没记过时四个桶都是空（不会凭空给一个默认模型）',
    lastModelFor('image') === '' && lastModelFor('video') === '' &&
      lastModelFor('audio') === '' && lastModelFor('text') === '',
    JSON.stringify(canvasLastModelReport().models),
  );
  check('没记过时 pick 也回空串（调用方自己回落目录第一个）', pickCanvasModel('image', [IMAGE_A, IMAGE_B]) === '',
    String(pickCanvasModel('image', [IMAGE_A, IMAGE_B])));

  const writesBefore = canvasLastModelReport().writes;
  check('记住一个图片模型 → 能读回来', rememberLastModel('image', IMAGE_B) === IMAGE_B && lastModelFor('image') === IMAGE_B,
    lastModelFor('image'));
  check('分桶互不影响（图片记了，视频桶还是空）',
    lastModelFor('video') === '' && lastModelFor('audio') === '' && lastModelFor('text') === '',
    JSON.stringify(canvasLastModelReport().models));
  check('名字首尾空白被削掉（存档里不会留「 模型 」这种脏值）',
    rememberLastModel('video', `  ${VIDEO_A}  `) === VIDEO_A && lastModelFor('video') === VIDEO_A,
    lastModelFor('video'));
  const writesAfterTwo = canvasLastModelReport().writes;
  rememberLastModel('image', IMAGE_B);
  check('同一个名字重复记 → 不再写盘（这个函数会在生成入口被调用）',
    canvasLastModelReport().writes === writesAfterTwo,
    `${writesBefore} -> ${writesAfterTwo} -> ${canvasLastModelReport().writes}`);
  rememberLastModel('image', '   ');
  rememberLastModel('nope', IMAGE_A);
  rememberLastModel('image', 42);
  check('空串 / 非法 kind / 非字符串都不写（也不会把已有的覆盖掉）',
    lastModelFor('image') === IMAGE_B && asCanvasModelKind('nope') === null,
    lastModelFor('image'));

  check('pick：记忆里的模型还在目录里 → 返回目录里的那个名字',
    pickCanvasModel('image', [IMAGE_A, IMAGE_B]) === IMAGE_B,
    String(pickCanvasModel('image', [IMAGE_A, IMAGE_B])));
  const missesBefore = canvasLastModelReport().misses;
  check('pick：记忆里的模型已经不在目录里 → 回空串（回落目录第一个，绝不写成打不通的模型）',
    pickCanvasModel('image', [IMAGE_A]) === '' &&
      canvasLastModelReport().misses === missesBefore + 1,
    `${missesBefore} -> ${canvasLastModelReport().misses}`);

  const stored = window.localStorage.getItem(CANVAS_LAST_MODEL_STORAGE_KEY);
  let parsed = null;
  try {
    parsed = JSON.parse(String(stored));
  } catch {
    parsed = null;
  }
  check('落盘是本机 localStorage（键 dsh-aifisher-canvas.last-model，按 kind 存名字）',
    parsed?.image === IMAGE_B && parsed?.video === VIDEO_A,
    String(stored).slice(0, 120));

  resetCanvasLastModel();
  check('reset 清空记忆并摘掉存档键',
    lastModelFor('image') === '' && window.localStorage.getItem(CANVAS_LAST_MODEL_STORAGE_KEY) === null,
    String(window.localStorage.getItem(CANVAS_LAST_MODEL_STORAGE_KEY)));

  // 坏存档：当没记过（不能把画布弄崩、也不能让新节点落一条诡异模型）
  // 注意必须**先 reset 再写坏存档**：reset 会把「已读过存档」的标记摘掉，
  // 否则下一次读命中的是内存缓存，这条断言会假绿（根本没读坏存档）。
  resetCanvasLastModel();
  window.localStorage.setItem(CANVAS_LAST_MODEL_STORAGE_KEY, '{这不是 JSON');
  check('存档坏掉时当没记过（不抛、也不把画布弄崩）',
    lastModelFor('image') === '' && lastModelFor('video') === '',
    JSON.stringify(canvasLastModelReport().models));
  // 脏值：非字符串 / 未知桶都要被忽略，合法的那条照读
  resetCanvasLastModel();
  window.localStorage.setItem(
    CANVAS_LAST_MODEL_STORAGE_KEY,
    JSON.stringify({ image: `  ${IMAGE_A}  `, video: 42, bogus: 'x' }),
  );
  check('存档里的脏值被忽略（非字符串的桶回空、名字仍会削空白）',
    lastModelFor('image') === IMAGE_A && lastModelFor('video') === '',
    `${JSON.stringify(canvasLastModelReport().models)}`);
  resetCanvasLastModel();
}

// ---------------------------------------------------------------- B) 画布内真行为
console.log('\n=== B) 画布：换模型 → 下一个新节点跟着换 ===');
{
  check(
    '画布挂载后桥都在（window 与 globalThis 各一份：vendor 读 globalThis，回归读 window）',
    typeof window.__FISHERAI_LAST_MODEL__ === 'function' &&
      typeof window.__FISHERAI_REMEMBER_MODEL__ === 'function' &&
      typeof window.__FISHERAI_CANVAS_LAST_MODEL__?.report === 'function' &&
      typeof globalThis.__FISHERAI_LAST_MODEL__ === 'function',
    `${typeof window.__FISHERAI_LAST_MODEL__}/${typeof globalThis.__FISHERAI_LAST_MODEL__}`,
  );

  const seedFrame = nodeElement(SEED_NODE_ID);
  check('画布渲染出那个种子节点', Boolean(seedFrame),
    container.innerHTML.slice(0, 160).replace(/\s+/g, ' '));

  // ① 没记过任何模型时，新建节点的默认模型 = 目录第一个（不能让这条特性改掉原有默认）
  const firstFresh = await addCanvasNode('Image', { x: 620, y: 80 });
  check('没记过时新建 Image 节点默认 = 目录第一个图片模型',
    firstFresh?.imageModel === IMAGE_A,
    String(firstFresh?.imageModel));

  // ② 在这个节点上真点下拉，换到第二个模型
  const freshFrame = firstFresh ? nodeElement(firstFresh.id) : null;
  const picked = await changeModelThroughPicker(freshFrame, IMAGE_B);
  check('能在节点上真打开模型下拉并选中第二个模型',
    picked.selected,
    JSON.stringify(picked));

  const switched = firstFresh
    ? await waitFor(async () => {
      const node = await savedNode(firstFresh.id);
      return node?.imageModel === IMAGE_B ? node : null;
    }, 20000)
    : null;
  check('换完模型节点真的存盘换掉了（不是只改了下拉显示）',
    switched?.imageModel === IMAGE_B,
    String(switched?.imageModel ?? (await savedNode(firstFresh?.id ?? ''))?.imageModel));

  const afterSwitch = window.__FISHERAI_CANVAS_LAST_MODEL__.report();
  check('换模型那一刻就记下来了（不必等点生成）',
    afterSwitch.models.image === IMAGE_B,
    JSON.stringify(afterSwitch.models));

  // ③ 这才是用户要的效果：下一个新节点默认就是刚才换的那个模型
  const secondFresh = await addCanvasNode('Image', { x: 620, y: 520 });
  check('再新建 Image 节点 → 默认模型 = 上一次生成任务用的那个',
    secondFresh?.imageModel === IMAGE_B,
    String(secondFresh?.imageModel));
  check('新节点的 model 字段与 imageModel 一致（不会一个记忆值一个内置值）',
    secondFresh?.model === IMAGE_B && secondFresh?.model !== IMAGE_A,
    String(secondFresh?.model));

  // ④ 记忆里的模型已经不在目录里（通道被删 / 取消勾选）→ 回落目录第一个
  window.__FISHERAI_CANVAS_LAST_MODEL__.remember('image', GONE_MODEL);
  const thirdFresh = await addCanvasNode('Image', { x: 1080, y: 80 });
  check('记忆的模型已经不在目录里 → 回落目录第一个（绝不写成一条打不通的模型）',
    thirdFresh?.imageModel === IMAGE_A && thirdFresh?.imageModel !== GONE_MODEL,
    String(thirdFresh?.imageModel));

  // ⑤ 分桶不串：图片记忆不许影响视频节点的默认模型
  window.__FISHERAI_CANVAS_LAST_MODEL__.remember('image', IMAGE_B);
  const videoNode = await addCanvasNode('Video', { x: 1080, y: 560 });
  check('视频节点的默认模型 = 目录第一个视频模型（图片记忆不串桶）',
    videoNode?.videoModel === VIDEO_A,
    String(videoNode?.videoModel));
  check('建视频节点后图片桶还是原来那条（没被视频节点带偏）',
    window.__FISHERAI_CANVAS_LAST_MODEL__.report().models.image === IMAGE_B,
    JSON.stringify(window.__FISHERAI_CANVAS_LAST_MODEL__.report().models));

  // ⑥ 生成入口也记账（用户嘴里的口径：上一次**生成任务**用的模型）
  //
  // 用种子节点（有提示词、模型 = 第一个图片模型）真点一次「生成图片」：
  // 目标是「记账发生在发请求之前」，所以这条通道特意指向环回闭端口 ——
  // 请求立即失败，页面不会真的出图，也不会花额度。
  window.__FISHERAI_CANVAS_LAST_MODEL__.reset();
  const seedForGenerate = nodeElement(SEED_NODE_ID);
  clickNode(seedForGenerate);
  await settle(500);
  const generateButton = seedForGenerate?.querySelector('button[aria-label="生成图片"]') ??
    seedForGenerate?.querySelector('button[aria-label="正在生成图片"]');
  check('种子节点上有可点的「生成图片」按钮（有提示词、模型可用）',
    Boolean(generateButton) && generateButton.getAttribute('aria-label') === '生成图片',
    String(generateButton?.getAttribute('aria-label')));
  generateButton?.click();
  const recorded = await waitFor(
    () => (window.__FISHERAI_CANVAS_LAST_MODEL__.report().models.image === IMAGE_A ? true : null),
    20000,
  );
  check('真点一次生成 → 这一次任务的模型被记成「上一次生成任务所使用的模型」',
    recorded === true,
    JSON.stringify(window.__FISHERAI_CANVAS_LAST_MODEL__.report().models));

  // 生成入口这一笔记的是「那次任务用的模型」——拿它建新节点必须跟上
  const fourthFresh = await addCanvasNode('Image', { x: 620, y: 980 });
  check('生成一次之后再建节点 → 默认就是刚才那次任务的模型',
    fourthFresh?.imageModel === IMAGE_A,
    String(fourthFresh?.imageModel));

  // ⑦ 整轮没有运行时错误
  await settle(600);
  const diag = await host.hostApi('GET', '/diagnostics?limit=80');
  const errors = (diag.json().entries ?? []).filter((entry) => entry.level === 'error');
  check('整轮没有运行时错误', errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)');
}

// ---------------------------------------------------------------- C) 产物与补丁
console.log('\n=== C) 产物 / vendor 补丁 ===');
{
  const canvasBundle = readFileSync(join(process.cwd(), 'lib/canvas/canvas-app.js'), 'utf8');
  check('画布产物里有三个桥名（vendor 只认这几个字符串）',
    canvasBundle.includes('__FISHERAI_LAST_MODEL__') &&
      canvasBundle.includes('__FISHERAI_REMEMBER_MODEL__') &&
      canvasBundle.includes('__FISHERAI_CANVAS_LAST_MODEL__'));
  check('画布产物里有本机存档键', canvasBundle.includes('dsh-aifisher-canvas.last-model'));
  check('画布产物里有「新节点默认用上一次的模型」装配器',
    canvasBundle.includes('installCanvasLastModelSupport'));

  const operations = readFileSync(
    join(process.cwd(), 'vendor/aifisher/src/stable/nodes/canvasNodeOperations.ts'),
    'utf8',
  );
  check('vendor 补丁 3.8q：建节点时先问记忆（createCanvasNode 不再直接取 imageModels[0]）',
    operations.includes('__FISHERAI_LAST_MODEL__') &&
      operations.includes('freshModel(runtime.imageModels') &&
      !operations.includes('const image = runtime.imageModels[0],'),
    operations.includes('freshModel(') ? 'ok' : '补丁缺失');
  check('vendor 补丁 3.8q：换模型时记账（updateCanvasNode 里调 __FISHERAI_REMEMBER_MODEL__）',
    operations.includes('__FISHERAI_REMEMBER_MODEL__') && operations.includes("['image', patch.imageModel]"),
    operations.includes('rememberModel(kind, name)') ? 'ok' : '补丁缺失');

  const generation = readFileSync(
    join(process.cwd(), 'vendor/aifisher/src/stable/generation/canvasGeneration.ts'),
    'utf8',
  );
  check('vendor 补丁 3.8q：发起生成时记账（handleGenerate 拿到 modelName 后记一次）',
    generation.includes('__FISHERAI_REMEMBER_MODEL__') &&
      generation.includes("rememberModel(node.type.toLowerCase(), modelName)"),
    generation.includes('rememberModel(') ? 'ok' : '补丁缺失');
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
