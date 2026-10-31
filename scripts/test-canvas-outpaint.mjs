/**
 * 「扩图」回归（v1.38 引入，v1.39 改成「先出扩图画面，再接生成节点」）。
 *
 * 用户原话（2026-10-17 v1.38，附一张图片节点工具条截图，指着上面那个 HD 按钮）：
 *   「把这个功能移除，替换成扩图功能；还有一点，这里的功能点击生成后模型走的是之前的通道。
 *    做一个调整，点击生成后不直接生图，先输出一个空的图像生成节点，填好提示词，
 *    由我来点击最后的生成；尺寸节点的ui还没有更新；检查其他类似的功能是否正常」。
 * 用户原话（2026-10-17 v1.39，附两张参考图：扩图面板 + 「原图 → 扩图画面 → 扩图 · 21:9」节点链）：
 *   「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」。
 *
 * 这个套件守五件事：
 *   A. **纯逻辑**（跑在构建产物上）：九宫格 → 画布几何（原图落在哪、哪几边是新画面）、
 *      提示词/标题/两张节点的字段；模型**跟着用户通道走**；脏输入抛中文错误。
 *   B. **工具条/面板**：HD 没了，「扩图」在；面板有目标比例（比例表）+ 原图位置九宫格 +
 *      延展内容 + 预览（原图在扩图画面里的位置）。
 *   C. **真点一次「生成扩图画面」**：画布上多**两张**节点 ——
 *      ①「扩图画面」（真实图片、像素是 427×240、原图按几何摆进去）；
 *      ②「扩图 · 16:9」（空图、提示词已填、模型是通道模型、参考图 = 扩图画面），
 *      并且**一条生成请求都没发出去**（fetchCalls 里没有 /generate-image）。
 *   D. 同类功能（全景图 / 角度）仍然是「只建节点」，没被这次改动带坏。
 *   E. 整轮没有运行时错误。
 *
 * ⚠️ jsdom 没有 canvas 实现（harness 里 getContext 恒 null）：这里**替换掉**
 *    HTMLCanvasElement.getContext/toDataURL 与 Image 的加载，让 compose 这条真代码路径
 *    照常跑（像素位置由 drawImage 的入参断言，产物尺寸由落盘 PNG 的 IHDR 断言）。
 *    真正的绘制（透明留白 / 原图内容）在 browser-check 的 outpaint 场景里真机量。
 *
 * 用法：node scripts/test-canvas-outpaint.mjs   （需要先 build）
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';
import { decodePngGray, encodeSolidPng } from './lib/png.mjs';

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

const PROJECT_ID = 'proj-canvas-outpaint';
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
/** 通道模型：画布上叫「扩图测试通道 · Outpaint/Image-Edit」，节点上只记通道名 · 模型 ID。 */
const CHANNEL = {
  label: '扩图测试通道',
  modelId: 'Outpaint/Image-Edit',
};
const CHANNEL_MODEL_NAME = `${CHANNEL.label} · ${CHANNEL.modelId}`;
/** 上游那条旧通道的模型名（扩图绝不能写死用它，本插件没有后端 → 501）。 */
const LEGACY_MODEL_NAME = 'GPT Image 2.5 · API 低价扩展版';
/** 源图真实像素（假 Image 报的就是这两个数；320×240 + 16:9 → 427×240）。 */
const SOURCE_PIXELS = { width: 320, height: 240 };
const EXTEND_CONTENT = '两侧延伸出更多沙滩和海面';

const host = await startHost();
{
  const saved = await host.hostApi('POST', '/cloud-channels', {
    action: 'save',
    channel: {
      label: CHANNEL.label,
      baseUrl: 'https://api-inference.modelscope.cn/v1',
      apiKey: 'sk-outpaint-check',
      models: [{ id: CHANNEL.modelId, kind: 'image' }],
    },
  });
  check('预置一条「带图像模型」的自配通道', saved.status === 200, String(saved.text).slice(0, 120));
}
const SOURCE_NODE = {
  id: 'node-outpaint-source',
  type: 'Image',
  x: 0,
  y: 0,
  title: '待扩图',
  prompt: '扩图回归的源图',
  status: 'success',
  model: 'Upload',
  imageModel: CHANNEL_MODEL_NAME,
  imageMode: 'text-to-image',
  aspectRatio: '4:3',
  resolution: '1K',
  parentIds: [],
  projectId: PROJECT_ID,
  width: 320,
  height: 240,
  resultUrl: ONE_PIXEL_PNG,
  resultAspectRatio: '320/240',
};
{
  const saved = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '扩图回归',
    nodes: [SOURCE_NODE],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置「带结果图的图片节点」写入本地后端', saved.status === 200, String(saved.text).slice(0, 120));
}

const { window, fetchCalls } = await createCanvasDom({ dispatch: host.dispatch });

/**
 * jsdom 没有 canvas / 图片解码：这里把这两层换成「能跑通代码、能取证」的替身。
 *  - Image：`src` 一赋值就在下一 tick 触发 onload，`naturalWidth/Height` = 320×240；
 *  - canvas：getContext 返回记录 drawImage 入参的假上下文，toDataURL 按 this.width/height
 *    真编一张同尺寸 PNG（尺寸可以从落盘文件反查，像素位置靠 drawImage 入参断言）。
 */
const drawCalls = [];
{
  const context = {
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    clearRect() {},
    drawImage(image, x, y, width, height) {
      drawCalls.push({
        src: String(image && (image.src || image._src || '')),
        x,
        y,
        width,
        height,
        naturalWidth: image && image.naturalWidth,
        naturalHeight: image && image.naturalHeight,
      });
    },
  };
  window.HTMLCanvasElement.prototype.getContext = () => context;
  window.HTMLCanvasElement.prototype.toDataURL = function toDataUrl() {
    const width = Math.max(1, Number(this.width) || 1);
    const height = Math.max(1, Number(this.height) || 1);
    return `data:image/png;base64,${encodeSolidPng(width, height, [32, 32, 32]).toString('base64')}`;
  };
  class FakeImage {
    constructor() {
      this.naturalWidth = SOURCE_PIXELS.width;
      this.naturalHeight = SOURCE_PIXELS.height;
      this.width = SOURCE_PIXELS.width;
      this.height = SOURCE_PIXELS.height;
      this.crossOrigin = '';
      this.onload = null;
      this.onerror = null;
      this._src = '';
    }
    set src(value) {
      this._src = String(value);
      window.setTimeout(() => {
        if (typeof this.onload === 'function') this.onload();
      }, 0);
    }
    get src() {
      return this._src;
    }
  }
  window.Image = FakeImage;
}

seedResume(window, PROJECT_ID);
const { container, canvasApp, handle } = await mountCanvasApp(window);
await settle(1800);
const doc = window.document;

/** 按标题找节点壳（节点的 data-node-id 与标题文本都在 DOM 上）。
 *  用 startsWith 是因为 vendor 会把结果图的像素尺寸接在标题元素里（如「扩图画面427x240」）。 */
const framesByTitle = (title) =>
  [...doc.querySelectorAll('[data-node-id]')].filter((node) =>
    String(node.querySelector('[data-af-node-title]')?.textContent ?? '')
      .trim()
      .startsWith(title),
  );

// ---------------------------------------------------------------- A) 纯逻辑（构建产物）
{
  const {
    OUTPAINT_ANCHORS,
    OUTPAINT_COMPOSITE_TITLE,
    OUTPAINT_MAX_SIDE,
    anchorSpec,
    buildOutpaintPlan,
    outpaintGeometry,
    outpaintPrompt,
    outpaintRatioValue,
    outpaintRatios,
    outpaintSourceSize,
    outpaintTitle,
    resolveOutpaintModel,
  } = canvasApp;
  check(
    '产物导出了扩图的纯函数（outpaintGeometry / buildOutpaintPlan / outpaintPrompt …）',
    typeof outpaintGeometry === 'function' &&
      typeof buildOutpaintPlan === 'function' &&
      typeof outpaintPrompt === 'function' &&
      typeof resolveOutpaintModel === 'function',
    `${typeof outpaintGeometry}/${typeof buildOutpaintPlan}/${typeof outpaintPrompt}`,
  );

  check(
    '原图位置是 9 格（行优先，第一格左上、第五格居中）',
    Array.isArray(OUTPAINT_ANCHORS) &&
      OUTPAINT_ANCHORS.length === 9 &&
      OUTPAINT_ANCHORS[0].value === 'top-left' &&
      OUTPAINT_ANCHORS[4].value === 'center',
    String(OUTPAINT_ANCHORS?.length),
  );
  check(
    '未知位置退回「居中」（不崩、也不生成半句提示词）',
    anchorSpec('nope').value === 'center',
    anchorSpec('nope').value,
  );
  check('「扩图画面」标题是常量（面板/节点/回归共用一份）', OUTPAINT_COMPOSITE_TITLE === '扩图画面',
    OUTPAINT_COMPOSITE_TITLE);

  const model = resolveOutpaintModel();
  check(
    '扩图模型跟着**用户通道**走（不是上游写死的 Relay 低价版）',
    model?.name === CHANNEL_MODEL_NAME,
    `${model?.name}`,
  );
  check(
    '解析出的模型确实是通道模型（带 cloudChannelId）',
    typeof model?.cloudChannelId === 'string',
    String(model?.cloudChannelId),
  );
  const ratios = outpaintRatios(model);
  check('目标比例顺序照参考图（1:1 开头，16:9 在第二行第一格）',
    ratios[0] === '1:1' && ratios[5] === '16:9', ratios.slice(0, 6).join(','));
  check('比例解析（16:9 → 1.7777…，脏值 → 0）',
    Math.abs(outpaintRatioValue('16:9') - 16 / 9) < 1e-6 && outpaintRatioValue('nope') === 0,
    `${outpaintRatioValue('16:9')}`);

  // 320×240（4:3）→ 16:9：高度不变、宽度补到 240 × 16/9 = 427
  const wide = outpaintGeometry({ width: 320, height: 240, ratio: '16:9', anchor: 'center' });
  check('16:9 扩图：画布 427×240、原图仍是 320×240（不重采样）',
    wide.width === 427 && wide.height === 240 && wide.imageWidth === 320 && wide.imageHeight === 240,
    `${wide.width}x${wide.height} / ${wide.imageWidth}x${wide.imageHeight}`);
  check('原图居中：左右各补 53/54 像素（427-320=107 分两半）',
    wide.offsetX === 53 && wide.pad.left === 53 && wide.pad.right === 54 && wide.pad.top === 0 && wide.pad.bottom === 0,
    JSON.stringify({ offsetX: wide.offsetX, pad: wide.pad }));

  const left = outpaintGeometry({ width: 320, height: 240, ratio: '16:9', anchor: 'left' });
  check('原图贴左：offsetX=0、空白全在右边（107）',
    left.offsetX === 0 && left.pad.right === 107 && left.pad.left === 0,
    JSON.stringify({ offsetX: left.offsetX, pad: left.pad }));
  const right = outpaintGeometry({ width: 320, height: 240, ratio: '16:9', anchor: 'right' });
  check('原图贴右：空白全在左边（107）',
    right.offsetX === 107 && right.pad.left === 107 && right.pad.right === 0,
    JSON.stringify({ offsetX: right.offsetX, pad: right.pad }));

  const tall = outpaintGeometry({ width: 320, height: 240, ratio: '9:16', anchor: 'center' });
  check('竖幅扩图（9:16）：宽度不变、高度 320 ÷ 0.5625 = 569，上下补边',
    tall.width === 320 && tall.height === 569 && tall.imageWidth === 320 && tall.imageHeight === 240,
    `${tall.width}x${tall.height}`);
  check('竖幅居中：offsetY = (569-240)/2 向下取整 = 164',
    tall.offsetY === 164 && tall.pad.top === 164 && tall.pad.bottom === 165,
    JSON.stringify({ offsetY: tall.offsetY, pad: tall.pad }));

  const huge = outpaintGeometry({ width: 3000, height: 1500, ratio: '1:4', anchor: 'center' });
  check('超长画布会先缩到 4096 上限（不裁原图）',
    Math.max(huge.width, huge.height) === OUTPAINT_MAX_SIDE &&
      huge.imageWidth <= huge.width &&
      huge.imageHeight <= huge.height,
    `${huge.width}x${huge.height} scale=${huge.scale}`);

  const size = outpaintSourceSize(SOURCE_NODE);
  check('面板读得到原图像素（resultAspectRatio=320/240 → exact）',
    size.width === 320 && size.height === 240 && size.exact === true,
    JSON.stringify(size));

  const prompt = outpaintPrompt(wide, '16:9', '');
  check(
    '提示词写清「目标比例 16:9」与「扩图画面」（不是空串、也不说黑话）',
    prompt.includes('16:9') && prompt.includes('扩图画面'),
    prompt.slice(0, 40),
  );
  check(
    '提示词要求「保持原图内容、无缝衔接」（否则扩图会变成重画一张）',
    prompt.includes('保持不变') && prompt.includes('无缝衔接'),
    '',
  );
  check(
    '左右都扩时措辞是「向左右两侧」（居中 + 16:9 的实况）',
    prompt.includes('向左右两侧'),
    prompt.slice(24, 60),
  );
  check(
    '单向扩图的措辞不同（贴左 → 只向右侧）',
    outpaintPrompt(left, '16:9', '').includes('只向画面右侧'),
    outpaintPrompt(left, '16:9', '').slice(24, 50),
  );
  const withContent = outpaintPrompt(wide, '16:9', EXTEND_CONTENT);
  check('用户填的「延展内容」原样进提示词',
    withContent.includes(EXTEND_CONTENT), withContent.slice(-80));
  check('标题能一眼看出是哪个比例', outpaintTitle('16:9') === '扩图 · 16:9', outpaintTitle('16:9'));

  const plan = buildOutpaintPlan(
    SOURCE_NODE,
    { anchor: 'center', ratio: '16:9', content: EXTEND_CONTENT },
    wide,
  );
  check('①「扩图画面」节点的标题 = 扩图画面', plan.compositePatch.title === '扩图画面',
    String(plan.compositePatch.title));
  check('①「扩图画面」记着真实像素比（427/240），刷新后画布按它摆',
    plan.compositePatch.resultAspectRatio === '427/240',
    String(plan.compositePatch.resultAspectRatio));
  check('② 生成节点是图生图（imageMode=image-to-image）',
    plan.draftPatch.imageMode === 'image-to-image', String(plan.draftPatch.imageMode));
  check('② 生成节点模型 = 通道模型', plan.draftPatch.imageModel === CHANNEL_MODEL_NAME,
    String(plan.draftPatch.imageModel));
  check('② 生成节点比例 = 选的目标比例', plan.draftPatch.aspectRatio === '16:9',
    String(plan.draftPatch.aspectRatio));
  check('② 生成节点提示词已经填好（含延展内容）',
    String(plan.draftPatch.prompt).includes('向外扩图') && String(plan.draftPatch.prompt).includes(EXTEND_CONTENT),
    String(plan.draftPatch.prompt).slice(0, 24));
  check('② 生成节点状态是「还没生成」（status=idle，不写 loading）',
    plan.draftPatch.status === 'idle', String(plan.draftPatch.status));
  check(
    '② 生成节点不带结果也不是 loading（即：创建 ≠ 生图）',
    plan.draftPatch.resultUrl === undefined &&
      plan.draftPatch.resultUrls === undefined &&
      plan.draftPatch.generationAttemptId === undefined,
    '',
  );
  check('落点：扩图画面在源图右侧（0+320+80），生成节点再往右 360+80',
    plan.positions.composite.x === 400 && plan.positions.composite.y === 0 &&
      plan.positions.draft.x === 840 && plan.positions.draft.y === 0,
    JSON.stringify(plan.positions));
  check('生成节点模型不是上游那条旧通道',
    plan.draftPatch.imageModel !== LEGACY_MODEL_NAME, String(plan.draftPatch.imageModel));

  let threw = '';
  try {
    buildOutpaintPlan({ ...SOURCE_NODE, type: 'Video' }, {}, wide);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('对视频节点扩图会被拒绝，并给出中文原因', threw.includes('图片节点'), threw);

  threw = '';
  try {
    buildOutpaintPlan({ ...SOURCE_NODE, resultUrl: undefined }, {}, wide);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('没有结果图的节点会被拒绝（不是静默建一个空画面）', threw.includes('结果'), threw);
}

// ---------------------------------------------------------------- B) 工具条：HD 没了，扩图面板在
const imageNode = () => container.querySelector(`[data-node-id="${SOURCE_NODE.id}"]`);
check('画布上渲染出源图节点', Boolean(imageNode()));
{
  const element = imageNode();
  const options = {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 40,
    button: 0,
    buttons: 1,
    pointerId: 9,
    pointerType: 'mouse',
    isPrimary: true,
  };
  if (element) {
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'])
      element.dispatchEvent(new window.MouseEvent(type, options));
  }
}
const toolbar = await waitFor(async () => container.querySelector('[data-fisherai-media-toolbar]'));
check('选中后出现节点媒体工具条', Boolean(toolbar));
check(
  '工具条里已经没有「AI 高清放大」入口（v1.38 移除）',
  !toolbar?.querySelector('button[aria-label="AI 高清放大"]'),
  '',
);
const trigger = toolbar?.querySelector('[data-fisherai-outpaint-trigger="true"]');
check('工具条里有「扩图」按钮（aria-label=扩图）', trigger?.getAttribute('aria-label') === '扩图',
  String(trigger?.getAttribute('aria-label')));
check('「扩图」按钮是 aria-expanded 的可展开控件', trigger?.getAttribute('aria-expanded') === 'false',
  String(trigger?.getAttribute('aria-expanded')));

// ---------------------------------------------------------------- C) 真点：两张节点 + 真画好的画面
let createdId = '';
let compositeId = '';
{
  trigger?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const panel = await waitFor(async () => container.querySelector('[data-fisherai-outpaint-panel="true"]'));
  check('点「扩图」打开面板（role=dialog + aria-label=扩图）',
    panel?.getAttribute('role') === 'dialog' && panel?.getAttribute('aria-label') === '扩图',
    `${panel?.getAttribute('role')}/${panel?.getAttribute('aria-label')}`);
  check('面板 portal 在画布容器里（不是 document.body）', Boolean(panel && container.contains(panel)));
  check('面板显示这次要用的模型 = 通道模型',
    panel?.getAttribute('data-fisherai-outpaint-model') === CHANNEL_MODEL_NAME,
    String(panel?.getAttribute('data-fisherai-outpaint-model')));
  check('面板有 9 个「原图位置」按钮（九宫格）',
    panel?.querySelectorAll('[data-fisherai-outpaint-anchor]').length === 9,
    String(panel?.querySelectorAll('[data-fisherai-outpaint-anchor]').length));
  check('面板有目标比例按钮（含 16:9）',
    Boolean(panel?.querySelector('[data-fisherai-outpaint-ratio="16:9"]')));
  check('面板有「延展内容」输入框（可空）',
    Boolean(panel?.querySelector('[data-fisherai-outpaint-content]')));
  const preview = panel?.querySelector('[data-fisherai-outpaint-preview="true"]');
  const previewImage = panel?.querySelector('[data-fisherai-outpaint-preview-image="true"]');
  check('面板有扩图画面预览（原图按目标比例/位置摆进去）',
    Boolean(preview) && Boolean(previewImage) &&
      preview?.getAttribute('data-fisherai-outpaint-preview-size') === '427x240',
    String(preview?.getAttribute('data-fisherai-outpaint-preview-size')));
  {
    const leftPercent = Number.parseFloat(String(previewImage?.style.left ?? 'NaN'));
    const widthPercent = Number.parseFloat(String(previewImage?.style.width ?? 'NaN'));
    check('预览里原图居中：left ≈ 53/427、宽度 ≈ 320/427',
      Math.abs(leftPercent - 12.41) < 0.5 && Math.abs(widthPercent - 74.94) < 0.5,
      `left=${leftPercent} width=${widthPercent}`);
  }
  /**
   * v1.83「真正的整页扩图」：面板不再长在节点卡里（节点气泡放到 880/560 都会越出画布），
   * 而是挂成画布容器的兄弟图层 —— 顶栏 + 大舞台 + 右侧 362 参数栏三块齐全。
   * jsdom 没有布局引擎，这里验的是「结构上真的离开了节点、三块都在」，像素尺寸由
   * browser-check 的 outpaint / outpaint-panel 两场真机量。
   */
  check('整页工作台不在节点卡里（不是节点气泡）',
    Boolean(panel) && Boolean(imageNode()) && !imageNode().contains(panel));
  check('整页工作台的三块都在：顶栏 / 舞台 / 参数栏',
    Boolean(panel?.querySelector('.afw-top')) &&
      Boolean(panel?.querySelector('.afo-stage')) &&
      Boolean(panel?.querySelector('.afo-insp')),
    `${Boolean(panel?.querySelector('.afw-top'))}/${Boolean(panel?.querySelector('.afo-stage'))}/${Boolean(panel?.querySelector('.afo-insp'))}`);
  check('舞台把四个待补区域都标出来了（斜纹 + 虚线）',
    panel?.querySelectorAll('.afo-zone').length === 4,
    String(panel?.querySelectorAll('.afo-zone').length));
  check('每侧延展多少像素写在画面上了（+ 53 px）',
    String([...(panel?.querySelectorAll('.afo-ext-chip') ?? [])].map((node) => node.textContent)).includes('+ 53 px'),
    String([...(panel?.querySelectorAll('.afo-ext-chip') ?? [])].map((node) => node.textContent)).slice(0, 60));
  check('参数栏给出了目标输出尺寸（427 × 240）',
    String(panel?.textContent ?? '').includes('427') &&
      String(panel?.querySelector('.afo-size')?.textContent ?? '').includes('240'),
    String(panel?.querySelector('.afo-size')?.textContent ?? '').slice(0, 40));
  check('整页工作台有「关闭扩图」按钮（Esc 同效）',
    Boolean(panel?.querySelector('[aria-label="关闭扩图"]')));
  const create = panel?.querySelector('[data-fisherai-outpaint-create="true"]');
  check('「生成扩图画面」按钮可用',
    Boolean(create) && create.disabled === false && create.getAttribute('aria-label') === '生成扩图画面',
    `disabled=${create?.disabled} label=${create?.getAttribute('aria-label')}`);

  // 选「贴右 + 16:9」+ 填延展内容，这样断言能证明选择真的落到了画面/节点上
  panel?.querySelector('[data-fisherai-outpaint-anchor="right"]')?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  panel?.querySelector('[data-fisherai-outpaint-ratio="16:9"]')?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  const content = panel?.querySelector('[data-fisherai-outpaint-content]');
  if (content) {
    // React 19 的受控 textarea 只认原型上的 value setter（直接 content.value=… 不会触发 onChange）
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (setter) setter.call(content, EXTEND_CONTENT);
    content.dispatchEvent(new window.Event('input', { bubbles: true }));
    content.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  await settle(150);
  check('位置按钮会记住选择（aria-pressed=true）',
    panel?.querySelector('[data-fisherai-outpaint-anchor="right"]')?.getAttribute('aria-pressed') === 'true',
    String(panel?.querySelector('[data-fisherai-outpaint-anchor="right"]')?.getAttribute('aria-pressed')));
  check('填的延展内容真的进 state（输入框 value 还在）',
    String(content?.value ?? '') === EXTEND_CONTENT, String(content?.value ?? ''));

  const before = doc.querySelectorAll('[data-node-id]').length;
  create?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const created = await waitFor(async () => {
    const frames = [...doc.querySelectorAll('[data-node-id]')];
    return frames.length > before ? frames : null;
  }, 12000);
  await settle(600);
  check('点一下 → 画布上真的多了**两张**节点（扩图画面 + 生成节点）',
    before === 1 && created?.length === 3,
    `${before} -> ${created?.length}`);

  const compositeNodes = framesByTitle('扩图画面');
  const generationNodes = framesByTitle('扩图 · 16:9');
  check('① 画出「扩图画面」节点（标题就是这四个字）', compositeNodes.length === 1,
    String(compositeNodes.length));
  check('② 生成节点标题 = 扩图 · 16:9', generationNodes.length === 1, String(generationNodes.length));
  compositeId = compositeNodes[0]?.getAttribute('data-node-id') ?? '';
  createdId = generationNodes[0]?.getAttribute('data-node-id') ?? '';
  check('新节点都拿到了 id', Boolean(compositeId) && Boolean(createdId), `${compositeId} / ${createdId}`);

  const compositeImage = compositeNodes[0]?.querySelector('[data-fisherai-image-preview] img');
  check('「扩图画面」是一张**真图片**（有结果图，不是空壳）',
    Boolean(compositeImage) && String(compositeImage?.getAttribute('src')).startsWith('/api/aifisher/canvas/media/'),
    String(compositeImage?.getAttribute('src')));
  check('生成节点被选中（生成按钮就在它身上，用户直接点）',
    generationNodes[0]?.getAttribute('data-node-selected') === 'true',
    String(generationNodes[0]?.getAttribute('data-node-selected')));
  const composerText = String(
    generationNodes[0]?.querySelector('[data-fisherai-generation-composer="image"]')?.textContent ?? '',
  );
  check('生成节点的提示词已经填好（编辑器里能看到「向外扩图」与延展内容）',
    composerText.includes('向外扩图') && composerText.includes(EXTEND_CONTENT),
    composerText.slice(0, 90));
  check('生成节点自己**还没有结果图**（等用户点生成）',
    !generationNodes[0]?.querySelector('[data-fisherai-image-preview] img'), '');
  check('面板建完就收起（不挡着新节点）',
    container.querySelector('[data-fisherai-outpaint-panel="true"]') === null, '');
  // vendor 的节点位移可能是 translate(...) 也可能被优化成 translate3d(...)，两种都认。
  const nodeX = (node) => {
    const match = /translate(?:3d)?\(\s*([-\d.]+)px/.exec(String(node?.style?.transform ?? ''));
    return match ? Number(match[1]) : NaN;
  };
  check('「扩图画面」在原图右侧、生成节点在它右侧（先图后节点）',
    nodeX(compositeNodes[0]) > nodeX(imageNode()) &&
      nodeX(generationNodes[0]) > nodeX(compositeNodes[0]),
    `${imageNode()?.style.transform} / ${compositeNodes[0]?.style.transform} / ${generationNodes[0]?.style.transform}`);

  const generationCalls = fetchCalls.filter((call) => /generate-image/.test(call));
  check('创建时**一条生成请求都没发**（用户要自己点最后的生成）',
    generationCalls.length === 0, generationCalls.slice(0, 2).join(' | ') || '(none)');
  check('扩图画面真的走过「dataURL 落盘」接口（POST /media/images/annotation）',
    fetchCalls.some((call) => /POST \/api\/aifisher\/canvas\/media\/images\/annotation/.test(call)),
    fetchCalls.filter((call) => /annotation/.test(call)).slice(-1)[0] || '(none)');
  check('真画了一次：原图按几何画进画布（贴右 → x=107, 320×240）',
    drawCalls.length === 1 &&
      drawCalls[0].x === 107 &&
      drawCalls[0].y === 0 &&
      drawCalls[0].width === 320 &&
      drawCalls[0].height === 240,
    JSON.stringify(drawCalls[0] ?? null));
  check('画布尺寸是目标比例（toDataURL 前 canvas 被设成 427×240）',
    drawCalls.length === 1 && drawCalls[0].naturalWidth === 320 && drawCalls[0].naturalHeight === 240,
    JSON.stringify(drawCalls[0] ?? null));
}

// ---------------------------------------------------------------- C2) 存盘后：两张节点 / 连线 / 像素都在
{
  await settle(4200);
  const saved = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  const nodes = saved.json().nodes ?? [];
  const composite = nodes.find((node) => node.id === compositeId);
  const draft = nodes.find((node) => node.id === createdId);
  check('自动保存后两张节点都在文档里（刷新不丢）',
    Boolean(composite) && Boolean(draft), `${compositeId} / ${createdId}`);
  check('「扩图画面」存的是素材库地址（不是 data: 也不算丢失）',
    typeof composite?.resultUrl === 'string' &&
      composite.resultUrl.startsWith('/api/aifisher/canvas/media/'),
    String(composite?.resultUrl));
  check('「扩图画面」状态是 success（它就是成品图）',
    composite?.status === 'success' && composite?.resultAspectRatio === '427/240',
    `${composite?.status} ${composite?.resultAspectRatio}`);
  check('存盘后的提示词就是「向外扩图 + 延展内容」那一版',
    typeof draft?.prompt === 'string' && draft.prompt.includes('向外扩图') && draft.prompt.includes(EXTEND_CONTENT),
    String(draft?.prompt).slice(0, 40));
  check('存盘后的模型 = 通道模型（不是 GPT Image 2.5 · API 低价扩展版）',
    draft?.imageModel === CHANNEL_MODEL_NAME && draft?.imageModel !== LEGACY_MODEL_NAME,
    String(draft?.imageModel));
  check('存盘后的模式是图生图', draft?.imageMode === 'image-to-image', String(draft?.imageMode));
  check('存盘后比例 = 16:9', draft?.aspectRatio === '16:9', String(draft?.aspectRatio));
  check('生成节点的参考图是**扩图画面**（先出图、再接节点）',
    Array.isArray(draft?.parentIds) && draft.parentIds.includes(compositeId),
    JSON.stringify(draft?.parentIds));
  check('生成节点没再连着原图（参考的是扩好的画布，不是原图）',
    !(draft?.parentIds ?? []).includes(SOURCE_NODE.id), JSON.stringify(draft?.parentIds));
  check('存盘后状态仍不是 success/loading（等用户点生成）',
    draft?.status !== 'success' && draft?.status !== 'loading',
    String(draft?.status));
  check('存盘后没有凭空多出一个结果图', !draft?.resultUrl, String(draft?.resultUrl));

  const mediaDir = join(
    host.fakeHome,
    'storages',
    'dsh-aifisher-canvas',
    'media',
    PROJECT_ID,
    'images',
  );
  let files = [];
  try {
    files = readdirSync(mediaDir).filter((name) => /^annotation-.*\.png$/i.test(name));
  } catch {
    files = [];
  }
  check('扩图画面真的落成了一文件（annotation-*.png）', files.length === 1,
    files.join(',') || '(none)');
  if (files.length === 1) {
    const png = decodePngGray(join(mediaDir, files[0]));
    check('落盘 PNG 的像素尺寸就是扩图画面的 427×240', png.width === 427 && png.height === 240,
      `${png.width}x${png.height}`);
  }
}

// ---------------------------------------------------------------- D) 同类功能：全景图草稿不再自动生图
{
  // 重新选中源图（上面创建完换了选择）
  const element = imageNode();
  const options = {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 40,
    button: 0,
    buttons: 1,
    pointerId: 11,
    pointerType: 'mouse',
    isPrimary: true,
  };
  if (element) {
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'])
      element.dispatchEvent(new window.MouseEvent(type, options));
  }
  const bar = await waitFor(async () => container.querySelector('[data-fisherai-media-toolbar]'));
  bar?.querySelector('button[aria-label="全景图"]')?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  const menuItem = await waitFor(async () => {
    const items = [...doc.querySelectorAll('[role="menuitem"]')];
    return items.find((item) => String(item.textContent).includes('生成全景图')) ?? null;
  });
  check('「全景图」菜单还在（同类功能没被误删）', Boolean(menuItem));
  menuItem?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const generateButton = await waitFor(
    async () => doc.querySelector('[data-fisherai-image-tool-generate="true"]'),
    8000,
  );
  check('全景图面板打开，主按钮改成语义正确的「创建全景图节点」',
    generateButton?.getAttribute('aria-label') === '创建全景图节点',
    String(generateButton?.getAttribute('aria-label')));
  check('全景图面板不再宣称走「GPT2.5 低价版」',
    !String(doc.body.textContent ?? '').includes('GPT2.5 低价版'),
    String(doc.body.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60));

  const before = doc.querySelectorAll('[data-node-id]').length;
  const callsBefore = fetchCalls.filter((call) => /generate-image/.test(call)).length;
  generateButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(900);
  check('点「创建全景图节点」→ 画布上多一个节点（草稿）',
    doc.querySelectorAll('[data-node-id]').length === before + 1,
    `${before} -> ${doc.querySelectorAll('[data-node-id]').length}`);
  const callsAfter = fetchCalls.filter((call) => /generate-image/.test(call)).length;
  check('全景图草稿**不再自动生图**（v1.38 去掉了 create→handleGenerate）',
    callsAfter === callsBefore, `${callsBefore} -> ${callsAfter}`);

  await settle(4200);
  const saved = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  const panorama = (saved.json().nodes ?? []).find(
    (node) => typeof node.title === 'string' && node.title === '全景图',
  );
  check('全景图草稿也记录了提示词（不是空节点）',
    typeof panorama?.prompt === 'string' && panorama.prompt.includes('360'),
    String(panorama?.prompt).slice(0, 30));
  check('全景图草稿的模型也 = 通道模型（不再写死旧的 Relay 模型）',
    panorama?.imageModel === CHANNEL_MODEL_NAME && panorama?.imageModel !== LEGACY_MODEL_NAME,
    String(panorama?.imageModel));
  check('全景图草稿连着原图（图生图）',
    Array.isArray(panorama?.parentIds) && panorama.parentIds.includes(SOURCE_NODE.id),
    JSON.stringify(panorama?.parentIds));
  check('全景图草稿的比例落在该模型支持的比例表里（不会塞一个模型不认的 2:1）',
    ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(String(panorama?.aspectRatio)),
    String(panorama?.aspectRatio));
}

// ---------------------------------------------------------------- E) 同类功能：角度草稿同样是「只建节点」
{
  const element = imageNode();
  const options = {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 40,
    button: 0,
    buttons: 1,
    pointerId: 12,
    pointerType: 'mouse',
    isPrimary: true,
  };
  if (element) {
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'])
      element.dispatchEvent(new window.MouseEvent(type, options));
  }
  const bar = await waitFor(async () => container.querySelector('[data-fisherai-media-toolbar]'));
  bar?.querySelector('button[aria-label="角度"]')?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  const anglePanel = await waitFor(
    async () => doc.querySelector('[role="dialog"][aria-label="调整图片角度"]'),
    8000,
  );
  check('「角度」面板还在（同类功能没被误删）', Boolean(anglePanel));
  const applyButton = anglePanel?.querySelector('[data-fisherai-image-tool-generate="true"]');
  check('角度面板的主按钮语义正确（创建角度节点，而不是「生成新角度」）',
    applyButton?.getAttribute('aria-label') === '创建角度节点',
    String(applyButton?.getAttribute('aria-label')));
  check('角度面板不再宣称走「GPT2.5 低价版」',
    !String(anglePanel?.textContent ?? '').includes('GPT2.5 低价版'),
    String(anglePanel?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60));

  const before = doc.querySelectorAll('[data-node-id]').length;
  const callsBefore = fetchCalls.filter((call) => /generate-image/.test(call)).length;
  applyButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(900);
  check('点「创建角度节点」→ 画布上多一个草稿节点',
    doc.querySelectorAll('[data-node-id]').length === before + 1,
    `${before} -> ${doc.querySelectorAll('[data-node-id]').length}`);
  const callsAfter = fetchCalls.filter((call) => /generate-image/.test(call)).length;
  check('角度草稿也**不再自动生图**', callsAfter === callsBefore, `${callsBefore} -> ${callsAfter}`);

  await settle(4200);
  const saved = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  const angleNode = (saved.json().nodes ?? []).find(
    (node) => typeof node.title === 'string' && node.title.startsWith('角度 · '),
  );
  check('角度草稿带着视角参数（imageAngle 在）',
    Boolean(angleNode?.imageAngle) && typeof angleNode.imageAngle === 'object',
    JSON.stringify(angleNode?.imageAngle ?? null).slice(0, 60));
  check('角度草稿的模型 = 通道模型（不再写死旧的 Relay 模型）',
    angleNode?.imageModel === CHANNEL_MODEL_NAME && angleNode?.imageModel !== LEGACY_MODEL_NAME,
    String(angleNode?.imageModel));
  check('角度草稿连着原图（图生图）',
    Array.isArray(angleNode?.parentIds) && angleNode.parentIds.includes(SOURCE_NODE.id),
    JSON.stringify(angleNode?.parentIds));
}

// ---------------------------------------------------------------- F) 运行时没有报错
{
  const diag = await host.hostApi('GET', '/diagnostics?limit=50');
  const errors = (diag.json().entries ?? []).filter((entry) => entry.level === 'error');
  check('整轮没有运行时错误（扩图没把画布弄崩）', errors.length === 0,
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
