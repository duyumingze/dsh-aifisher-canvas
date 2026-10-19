/**
 * 画布点阵底纹的回归（scripts/test-canvas-grid.mjs）。
 *
 * 背景（2026-10-16）：用户要求「画布希望有个小十字型字间隔一个方块背景，与鼠标有交互效果
 * 鼠标周围圆形区域变亮」。实现是纯 DOM 的一层，插在 vendor 的 `#canvas-background` 底盘里
 * 当第一个孩子（见 src/client/canvas/canvasGrid.ts），所以这里要验的是四件事：
 *
 *   1. **挂载位置**：网格层真的在底盘里、且是第一个孩子（=画在所有节点下方），
 *      全程 pointer-events:none（不能抢画布的指针事件）；
 *   2. **跟着画布平移缩放**：把 `#canvas-viewport-content` 的 transform 改掉（等价于
 *      用户在画布上平移/缩放），网格的 pan/zoom 变量要跟着变 —— 这是「格子跟手」的关键；
 *   3. **鼠标交互（v1.27 修的真实命中路径）**：事件必须派发到**真实命中的元素**
 *      （`#canvas-background`）上且不冒泡 —— 只有 window 捕获监听收得到；旧实现把监听挂在
 *      pointer-events:none 的网格层上，合成事件能触发、真鼠标永远不会（用户 v1.27 报
 *      「现在画布与鼠标没有互动效果」）。这条同时验遮罩圆心/半径夹取/提亮 opacity/复位。
 *   4. **设置里的开关（v1.27）**：开设置 → 画布外观 → 「画布互动」面板 → 点开关：
 *      网格层立刻 off、指针完全不再画（监听摘掉）、再点恢复、关对话框面板不残留。
 *   5. **卸载干净**：dispose() 之后网格层从 DOM 消失（否则切回对话还会留一层）。
 *
 * v1.8（用户附官方画布截图：「我要的是这种样式的，把点替换成小型十字星，鼠标靠近会变亮」）
 * 起，规格是**可以断言的硬数字**，这里连参考图量出来的间距一起钉住：
 *   间距 24px（参考图量出来就是 24px）、星号 7px×1px（v1.7 那个约 9px 长 2px 粗的十字太大）、
 *   平铺块 1:1（viewBox = 24，星号按真实像素渲染而不是被 background-size 拉伸放大）。
 *
 * 另外验一条纯静态的契约：注入的样式表里必须有 `mask-image`（圆形提亮）、
 * 「格子几何只用 CSS px（zoom / translate 原值，不掺 dpr）」和按主题分色的两条规则。
 *
 * v1.33 起多守一件事：**网格与节点必须同速**。用户原话「移动画布的时候背后的网格和节点
 * 移动的速度不一致，网格的速度快，节点慢」—— 根因是几何里乘了 devicePixelRatio，而 jsdom
 * 恒为 1（所以这条 bug 在 24 套回归里活了很久）。2b 那一节把 dpr 改成 1.25 / 2 再平移画布，
 * 变量必须一动不动；真机上还有 browser-check 的 grid-pan / grid-pan-hidpi 两场守同一个比值。
 *
 * 用法：node scripts/test-canvas-grid.mjs   （需要先 build）
 */
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

const PROJECT_ID = 'proj-canvas-grid';
const host = await startHost();
{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '点阵底纹验证',
    nodes: [
      {
        id: 'node-grid-1',
        type: 'Image',
        x: 0,
        y: 0,
        prompt: '底纹验证节点',
        status: 'idle',
        imageModel: '豆包图片5.0-pro(方舟直连)',
        imageMode: 'text-to-image',
        aspectRatio: '16:9',
        resolution: '1K',
        parentIds: [],
        projectId: PROJECT_ID,
        width: 224,
        height: 209,
        generateCount: 1,
        watermark: false,
      },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { container, canvasApp, handle } = await mountCanvasApp(window);
await settle(1500);

const doc = window.document;
const canvasBackground = await waitFor(async () => doc.getElementById('canvas-background'));
check('画布底盘 #canvas-background 渲染出来了（网格有宿主）', !!canvasBackground);

// ---------------------------------------------------------------- 1) 挂载位置与结构

const gridLayer = canvasBackground?.querySelector('[data-canvas-grid="true"]') ?? null;
check('网格层挂在画布底盘里', !!gridLayer);
check(
  '网格层是底盘的第一个孩子（所以画在所有节点下方）',
  !!gridLayer && canvasBackground.firstElementChild === gridLayer,
  gridLayer ? `prev=${gridLayer.previousElementSibling?.tagName ?? '(none)'}` : '',
);
check(
  '网格层不抢指针事件（pointer-events: none）',
  !!gridLayer && gridLayer.getAttribute('aria-hidden') === 'true',
  gridLayer?.getAttribute('aria-hidden') ?? '',
);

const base = gridLayer?.querySelector('.canvas-grid-cross.is-base') ?? null;
const highlight = gridLayer?.querySelector('.canvas-grid-cross.is-highlight') ?? null;
check('两层十字星都在（静态底纹 + 提亮层）', !!base && !!highlight);

// ---- v1.48：三层嵌套矩阵（Blender 式：大矩阵包小矩阵，缩小时小的先消失） ----
const tierElements = gridLayer ? [...gridLayer.querySelectorAll('[data-canvas-grid-tier]')] : [];
check('三层嵌套矩阵都在（minor → major → super）',
  tierElements.length === 3,
  tierElements.map((el) => el.getAttribute('data-canvas-grid-tier')).join(','));
check('网格层自报三层间距 = 24,120,600（后一层正好包住前一层）',
  gridLayer?.getAttribute('data-canvas-grid-tiers') === '24,120,600',
  gridLayer?.getAttribute('data-canvas-grid-tiers') ?? '');
check('每层都带 base + highlight 两层星号（提亮也按层叠）',
  tierElements.every((el) =>
    !!el.querySelector('.canvas-grid-cross.is-base') &&
    !!el.querySelector('.canvas-grid-cross.is-highlight')),
  tierElements.map((el) => el.querySelectorAll('.canvas-grid-cross').length).join(','));
check('每颗大星都压在小星上（120 / 24 = 5、600 / 120 = 5 —— 同心嵌套）',
  tierElements.length === 3 &&
    Number(tierElements[1].getAttribute('data-canvas-grid-tier-spacing')) ===
      5 * Number(tierElements[0].getAttribute('data-canvas-grid-tier-spacing')) &&
    Number(tierElements[2].getAttribute('data-canvas-grid-tier-spacing')) ===
      5 * Number(tierElements[1].getAttribute('data-canvas-grid-tier-spacing')),
  tierElements.map((el) => el.getAttribute('data-canvas-grid-tier-spacing')).join(','));

// ---- v1.8 规格：24px 间距 + 7×1 小十字星 + 1:1 平铺块（参考图量出来的数字） ----
check('网格层自报间距 = 24px（参考图量出来的规格）',
  gridLayer?.getAttribute('data-canvas-grid-spacing') === '24',
  gridLayer?.getAttribute('data-canvas-grid-spacing') ?? '');
check('网格层自报星号 = 7x1（v1.7 那个约 9px 长 2px 粗的十字要收成小星号）',
  gridLayer?.getAttribute('data-canvas-grid-star') === '7x1',
  gridLayer?.getAttribute('data-canvas-grid-star') ?? '');
check('网格层自报墨色 = #ffffff@0.19（深色画布上必须是亮色）',
  gridLayer?.getAttribute('data-canvas-grid-ink') === '#ffffff@0.19',
  gridLayer?.getAttribute('data-canvas-grid-ink') ?? '');

{
  const styleText = doc.getElementById('dsh-aifisher-canvas-styles')?.textContent ?? '';
  check('注入的样式表里有网格规则', styleText.includes('[data-canvas-grid='));
  check('样式表含圆形遮罩（mask-image radial-gradient）',
    /mask-image:\s*radial-gradient\(circle var\(--canvas-grid-mr\)/.test(styleText));
  /**
   * v1.33（用户报障「移动画布的时候背后的网格和节点移动的速度不一致，网格的速度快，节点慢」）：
   * 根因是网格的几何里乘了 devicePixelRatio。CSS 背景的单位永远是 CSS px，乘了 dpr
   * 就等于「网格位移 = 节点位移 × dpr」。这里把「不许掺 dpr」钉在样式表上：
   *   ① 格子边长 = 24 × zoom，只有一个乘子；
   *   ② 整个样式表里不存在 var(--canvas-grid-dpr)（它只剩读数的身份）；
   *   ③ 不用 background-attachment: fixed —— 它的定位面积是视口，缩放时格子相位会随
   *      「画布原点 / zoom」漂移，与节点脱节。
   */
  check('格子边长 = 24px × zoom（只有一个乘子，不乘 dpr）',
    /background-size:\s*calc\(24px \* var\(--canvas-grid-zoom\)\)/.test(styleText),
    (styleText.match(/background-size:\s*calc\(24px[^;]*;/) ?? ['(未找到规则)'])[0]);
  // v1.48：三层各有一条「间距 × zoom」的规则，所有乘子都只有 zoom 一个。
  check('大矩阵的边长也按自己的间距铺（120px × zoom）',
    styleText.includes('background-size: calc(120px * var(--canvas-grid-zoom))'),
    (styleText.match(/background-size:\s*calc\(120px[^;]*;/) ?? ['(未找到规则)'])[0]);
  check('最大一层同样按自己的间距铺（600px × zoom）',
    styleText.includes('background-size: calc(600px * var(--canvas-grid-zoom))'),
    (styleText.match(/background-size:\s*calc\(600px[^;]*;/) ?? ['(未找到规则)'])[0]);
  check('dpr 不参与任何几何计算（样式表里没有 var(--canvas-grid-dpr)）',
    !styleText.includes('var(--canvas-grid-dpr)'));
  check('点阵锚在画布原点（没有 background-attachment: fixed，缩放时不相对节点漂移）',
    !styleText.includes('background-attachment: fixed'));
  check('样式表含 data:image/svg+xml 的十字图（不是纯色块）',
    /background-image:\s*url\("data:image\/svg\+xml/.test(styleText));
  check('十字图层被定为 fixed 定位的重复背景',
    /\.canvas-grid-cross\s*\{[^}]*background-repeat:\s*repeat/.test(styleText));
  check('样式表按主题分色（深浅两套星号，每层各一套）',
    styleText.includes("html[data-af-theme='light']") &&
      styleText.includes(
        "html[data-af-theme='light'] .af-canvas-mount [data-canvas-grid='true'] " +
          "[data-canvas-grid-tier='minor'] .canvas-grid-cross.is-base",
      ));
  check('样式表带三层各自的显隐规则（wrapper 透明度，JS 按屏幕间距写）',
    /\[data-canvas-grid-tier\]\s*\{[^}]*opacity:\s*0/.test(styleText) ||
      /\.canvas-grid-tier\s*\{[^}]*opacity:\s*0/.test(styleText));
  check('壁纸打开时隐藏网格（不与背景图打架）',
    /:has\(\.af-wallpaper\)\s*\[data-canvas-grid='true'\]/.test(styleText));

  // 平铺块几何：从样式表里的 data URL 解出 SVG 再看 —— 1:1 才不会被拉伸成糊块。
  const tiles = (() => {
    const found = [];
    const marker = 'url("data:image/svg+xml,';
    let at = styleText.indexOf(marker);
    while (at >= 0) {
      const from = at + marker.length;
      const to = styleText.indexOf('"', from);
      found.push(decodeURIComponent(styleText.slice(from, to)));
      at = styleText.indexOf(marker, to);
    }
    return found;
  })();
  // 12 张图 = 3 层 × 深浅主题 × 基础/提亮；顺序按 GRID_TIERS：minor 4 张、major 4 张、super 4 张。
  check('一共 12 张写死了颜色的星号图（3 层 × 深浅两套 × 基础/提亮）',
    tiles.length === 12, String(tiles.length));
  check('SVG 里没有 currentColor（图片文档不继承宿主 color，会解析成黑色 → 看不见）',
    tiles.every((svg) => !svg.includes('currentColor')),
    tiles.filter((svg) => svg.includes('currentColor')).length + ' 张用了 currentColor');
  check('墨色写在 SVG 自己身上（stroke + stroke-opacity）',
    tiles.every((svg) => svg.includes('stroke="#') && svg.includes('stroke-opacity="')),
    String(tiles[0] ?? '').slice(0, 140));
  check('深色主题墨色是亮色 + 19% 不透明（参考图量出来的 alpha≈0.19）',
    /stroke="#ffffff" stroke-opacity="0.19"/.test(String(tiles[0] ?? '')),
    String(tiles[0] ?? '').slice(0, 140));
  check('大矩阵的星号更大更亮（11px / alpha 0.26；同尺寸同墨色就分不出层次）',
    /stroke="#ffffff" stroke-opacity="0.26"/.test(String(tiles[4] ?? '')) &&
      String(tiles[4] ?? '').includes('M55.5 60.5H65.5'),
    String(tiles[4] ?? '').slice(0, 160));
  check('最大一层的星号再大一档（15px / alpha 0.32）',
    /stroke="#ffffff" stroke-opacity="0.32"/.test(String(tiles[8] ?? '')) &&
      String(tiles[8] ?? '').includes('M293.5 300.5H307.5'),
    String(tiles[8] ?? '').slice(0, 160));

  const tile = (() => {
    const svg = tiles[0] ?? '';
    if (!svg) return null;
    const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    return {
      width: /width="([\d.]+)"/.exec(svg)?.[1] ?? null,
      viewBox: box ? `${box[1]} ${box[2]}` : null,
      stroke: /stroke-width="([\d.]+)"/.exec(svg)?.[1] ?? null,
      cross: /H/.test(svg) && /V/.test(svg),
      svg,
    };
  })();
  check('平铺块 = 间距（width/viewBox 都是 24）',
    tile?.width === '24' && tile?.viewBox === '24 24',
    `${tile?.width} / ${tile?.viewBox}`);
  check('三层的平铺块分别 = 24 / 120 / 600（1:1 绘制，星号不被拉伸）',
    tiles.length === 12 &&
      tiles.slice(0, 4).every((svg) => /width="24"/.test(svg) && /viewBox="0 0 24 24"/.test(svg)) &&
      tiles.slice(4, 8).every((svg) => /width="120"/.test(svg) && /viewBox="0 0 120 120"/.test(svg)) &&
      tiles.slice(8, 12).every((svg) => /width="600"/.test(svg) && /viewBox="0 0 600 600"/.test(svg)),
    tiles.map((svg) => /width="([\d.]+)"/.exec(svg)?.[1] ?? '?').join(','));
  check('标记是一横一竖的十字（H + V），不是方块点',
    tile?.cross === true, String(tile?.cross));
  check('星号线宽 1px（更细的小星号，参考图的墨色 alpha≈0.19 不变）',
    Number.parseFloat(String(tile?.stroke ?? '0')) === 1, String(tile?.stroke));
  check('星号半像素对中（1px 线压在整数像素上：圆心 12.5）',
    tile ? tile.svg.includes('M9.5 12.5') || tile.svg.includes('12.5') : false,
    String(tile?.svg ?? '').slice(0, 120));
}

// ---------------------------------------------------------------- 2) 跟着画布平移缩放

function setViewportTransform(value) {
  const viewport = doc.getElementById('canvas-viewport-content');
  if (!viewport) return null;
  viewport.style.transform = value;
  return viewport;
}

{
  const probe = canvasApp.canvasGridReport?.();
  check('产物导出 canvasGridReport（排查接口）', !!probe);
  check('诊断接口认到网格层已挂载', probe?.mounted === true, JSON.stringify(probe?.variables ?? null));
  check('网格层在底盘内 / 是第一个孩子（诊断口径一致）',
    probe?.inCanvasBackground === true && probe?.isFirstChild === true,
    `${probe?.inCanvasBackground} / ${probe?.isFirstChild}`);
  check('诊断回报的星号几何 = 24 间距 / 7×1 星号 / 亮色墨',
    probe?.star?.spacing === 24 && probe?.star?.arm === 3 &&
      probe?.star?.stroke === 1 && probe?.star?.size === 7 &&
      probe?.star?.ink === '#ffffff@0.19',
    JSON.stringify(probe?.star ?? null));
}

setViewportTransform('translate3d(-120px, 64px, 0) scale(1.5)');
await settle(60);
{
  const probe = canvasApp.canvasGridReport();
  const vars = probe?.variables ?? {};
  const dpr = window.devicePixelRatio || 1;
  check('缩放变量跟上了画布 scale', Number.parseFloat(vars.zoom) === 1.5, String(vars.zoom));
  /**
   * v1.33 的核心断言：**平移变量就是画布 translate 本身（CSS px）**。
   * 以前这里写的是 `-120 * dpr` —— 那条断言本身就是 bug 的帮凶（jsdom 的 dpr 恒为 1，
   * 所以「乘 dpr」在回归里永远等于原值）。125% 缩放的屏幕上它会让网格快 1.25 倍。
   */
  check('平移变量 = 画布 translate 原值（CSS px，不乘 dpr）',
    Math.abs(Number.parseFloat(vars.panX) - -120) < 0.01 &&
      Math.abs(Number.parseFloat(vars.panY) - 64) < 0.01,
    `${vars.panX} / ${vars.panY} (dpr=${dpr})`);
  check('诊断口径自报 CSS px，且平移与画布 transform 一致（「网格比节点快」首查读数）',
    probe?.geometry === 'css-px' && probe?.panMatchesTransform === true,
    `geometry=${probe?.geometry} panMatchesTransform=${probe?.panMatchesTransform} dpr=${probe?.devicePixelRatio}`);
}

// ---------------------------------------------------------------- 2b) dpr 不参与几何（v1.33）

/**
 * 用户报障「移动画布的时候背后的网格和节点移动的速度不一致，网格的速度快，节点慢」。
 *
 * 根因：`--canvas-grid-pan-x` 写的是 `translate × devicePixelRatio`。jsdom 恒为 dpr=1，
 * 所以这段代码在 24 套回归里一直是「正确」的。这一节把 window.devicePixelRatio 改成
 * 1.25 / 2，再让画布平移一次 —— 变量必须**一点不变**。谁把 dpr 乘回去，这里立刻红。
 */
{
  const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  const setDpr = (value) => {
    try {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => value });
      return true;
    } catch {
      return false;
    }
  };
  const panSpeedAt = async (dpr) => {
    if (!setDpr(dpr)) return null;
    setViewportTransform('translate3d(0px, 0px, 0) scale(1)');
    await settle(60);
    const before = Number.parseFloat(canvasApp.canvasGridReport()?.variables?.panX ?? 'NaN');
    setViewportTransform('translate3d(-160px, 96px, 0) scale(1)');
    await settle(60);
    const after = Number.parseFloat(canvasApp.canvasGridReport()?.variables?.panX ?? 'NaN');
    return { dpr, before, after, speed: after - before };
  };
  const normal = await panSpeedAt(1);
  const hidpi = await panSpeedAt(1.25);
  const retina = await panSpeedAt(2);
  try {
    if (original) Object.defineProperty(window, 'devicePixelRatio', original);
    else delete window.devicePixelRatio;
  } catch {
    /* jsdom 有时候把 devicePixelRatio 定义成不可配置的：留着也不影响后面的断言（没人再用 dpr） */
  }
  setViewportTransform('translate3d(-120px, 64px, 0) scale(1.5)');
  await settle(60);

  check('dpr=1 时网格平移速度 = 画布平移速度（-160px）',
    normal !== null && Math.abs(normal.speed - -160) < 0.01,
    normal ? `speed=${normal.speed}` : '(devicePixelRatio 不可写，跳过)');
  check('dpr=1.25 时网格平移速度仍是 -160px（不是 -200px：网格不会比节点快 1.25 倍）',
    hidpi !== null && Math.abs(hidpi.speed - -160) < 0.01,
    hidpi ? `speed=${hidpi.speed}（乘了 dpr 会是 ${(-160 * 1.25).toFixed(0)}）` : '(skip)');
  check('dpr=2 时网格平移速度仍是 -160px（不是 -320px）',
    retina !== null && Math.abs(retina.speed - -160) < 0.01,
    retina ? `speed=${retina.speed}（乘了 dpr 会是 ${(-160 * 2).toFixed(0)}）` : '(skip)');
}

// ---------------------------------------------------------------- 2c) Blender 式三层显隐（v1.48）

/**
 * 用户原话：「画布背景的星型矩阵，缩小画布就密密麻麻的，能不能参考 blender 的，
 * 大的矩阵包裹小的矩阵，缩放到一点程度后小的矩阵就消失」。
 *
 * 判据是**屏幕上的格子间距**（spacing × zoom）：24×zoom < 8px 时 minor 整层隐藏；
 * 120×zoom 接棒；缩到 0.05 时只剩 600px 那层（屏幕间距 30px），画面不会变成噪声。
 */
{
  const opacityOf = (probe, id) =>
    (probe?.tiers ?? []).find((tier) => tier.id === id)?.opacity ?? null;
  const styleOpacityOf = (id) =>
    Number.parseFloat(
      (tierElements.find((el) => el.getAttribute('data-canvas-grid-tier') === id)?.style.opacity) ??
        'NaN',
    );
  const atZoom = async (zoom) => {
    setViewportTransform(`translate3d(0px, 0px, 0) scale(${zoom})`);
    await settle(80);
    return canvasApp.canvasGridReport();
  };

  const near = await atZoom(1);
  check('zoom 1：小矩阵亮着（24px 间距）',
    (opacityOf(near, 'minor') ?? 0) > 0.99, JSON.stringify(near?.tiers ?? null));
  check('zoom 1：大矩阵也亮着（120px 间距，压在小星上）',
    (opacityOf(near, 'major') ?? 0) > 0.99, String(opacityOf(near, 'major')));
  check('zoom 1：最大一层不出现（600px 屏幕间距太大）',
    (opacityOf(near, 'super') ?? 1) < 0.001, String(opacityOf(near, 'super')));
  check('显隐真的写到了 DOM 的 opacity 上（不是只算在报告里）',
    Math.abs(styleOpacityOf('minor') - 1) < 0.01,
    `style.opacity=${styleOpacityOf('minor')}`);

  const mid = await atZoom(0.2);
  check('zoom 0.2：小矩阵已经消失（24×0.2 = 4.8px，缩小后不再密密麻麻）',
    (opacityOf(mid, 'minor') ?? 1) < 0.001, String(opacityOf(mid, 'minor')));
  check('zoom 0.2：大矩阵接棒（120×0.2 = 24px，仍是原来的疏密观感）',
    (opacityOf(mid, 'major') ?? 0) > 0.99, String(opacityOf(mid, 'major')));
  check('zoom 0.2：更大一层补进来（600×0.2 = 120px）',
    (opacityOf(mid, 'super') ?? 0) > 0.99, String(opacityOf(mid, 'super')));
  check('诊断里报出每层的屏幕间距（minor→4.8 / major→24 / super→120）',
    (mid?.tiers ?? []).map((tier) => tier.screenSpacing).join(',') === '4.8,24,120',
    JSON.stringify((mid?.tiers ?? []).map((tier) => [tier.id, tier.screenSpacing, tier.opacity])));

  const far = await atZoom(0.05);
  check('zoom 0.05：只剩最大一层（600×0.05 = 30px），画面不会被星号填满',
    (opacityOf(far, 'minor') ?? 1) < 0.001 &&
      (opacityOf(far, 'major') ?? 1) < 0.001 &&
      (opacityOf(far, 'super') ?? 0) > 0.99,
    JSON.stringify(
      (far?.tiers ?? []).map((tier) => [tier.id, tier.screenSpacing, tier.opacity]),
    ));
  check('最小缩放 0.05 下仍有一层可见（不会整块空白）',
    (far?.tiers ?? []).some((tier) => tier.visible === true && tier.opacity > 0.99),
    JSON.stringify((far?.tiers ?? []).filter((tier) => tier.visible)));

  setViewportTransform('translate3d(-120px, 64px, 0) scale(1.5)');
  await settle(80);
}

// ---------------------------------------------------------------- 3) 鼠标交互（真实命中路径）

/**
 * ⚠️ v1.27 修的那个 bug 就死在这一段。
 *
 * 网格层必须 `pointer-events: none`（它铺满画布，绝不能抢画布的指针事件），而
 * **pointer-events:none 的元素永远不是命中目标** —— 真实鼠标的 pointermove 落在
 * `#canvas-background`（或节点）上，一帧都不会到网格层。v1.8～v1.26 把监听挂在网格层自己
 * 身上，回归里又用 `layer.dispatchEvent(...)` 派发（合成事件绕过命中测试）→ 回归全绿、
 * 真机上一点反应都没有（用户 v1.27 原话：「现在画布与鼠标没有互动效果」）。
 *
 * 所以这里改成：**派发到真实命中的元素（画布底盘）上、并且不冒泡**。
 * 只有「window 捕获阶段」的监听收得到这种事件 —— 谁把监听挂回网格层，这几条立刻红。
 *
 * jsdom 里没有布局（所有 rect 都是 0×0），实现会退回事件自带的 offsetX/offsetY，
 * 所以这里显式定义 offset（相对底盘自身的坐标，与遮罩圆心同一个坐标系）。
 */
function pointerEvent(type, offsetX, offsetY, options = {}) {
  const event = new window.MouseEvent(type, { bubbles: false, cancelable: true, ...options });
  Object.defineProperty(event, 'offsetX', { value: offsetX });
  Object.defineProperty(event, 'offsetY', { value: offsetY });
  return event;
}

{
  // 派发在底盘上、不冒泡：只有 window 捕获监听能收到（= 真实鼠标的那条路）。
  canvasBackground.dispatchEvent(pointerEvent('pointermove', 260, 140));
  await settle(120);

  const probe = canvasApp.canvasGridReport();
  const vars = probe?.variables ?? {};
  check('指针在画布上移动后遮罩圆心落在指针位置（真实命中路径：事件派发在画布底盘上）',
    vars.maskX === '260px' && vars.maskY === '140px',
    `${vars.maskX} / ${vars.maskY}`);
  const radius = Number.parseFloat(vars.maskRadius);
  check('遮罩半径被夹在合法范围内（40 ≤ r ≤ 190）',
    Number.isFinite(radius) && radius >= 40 && radius <= 190,
    String(vars.maskRadius));
  check('提亮层被显形（opacity 1）', probe?.highlightOpacity === '1', String(probe?.highlightOpacity));
  check('诊断读数：监听已挂上（listening=true）且真的画过（paints ≥ 1）',
    probe?.pointer?.listening === true && (probe?.pointer?.paints ?? 0) >= 1,
    JSON.stringify(probe?.pointer ?? null));

  canvasBackground.dispatchEvent(pointerEvent('pointermove', 321, 111));
  await settle(120);
  const moved = canvasApp.canvasGridReport();
  check('移动指针时圆心跟着走',
    moved?.variables?.maskX === '321px' && moved?.variables?.maskY === '111px',
    `${moved?.variables?.maskX} / ${moved?.variables?.maskY}`);

  // 指针离开窗口（pointerout 的 relatedTarget 为空）= 不能再有 pointermove，必须复位
  canvasBackground.dispatchEvent(new window.MouseEvent('pointerout', { bubbles: false, relatedTarget: null }));
  await settle(120);
  const left = canvasApp.canvasGridReport();
  check('指针离开窗口后提亮层复位（圆心移出元素 + opacity 0）',
    left?.variables?.maskX === '-9999px' && left?.highlightOpacity === '0',
    `${left?.variables?.maskX} / ${left?.highlightOpacity}`);
  check('复位后不再有 transform 轮询（listening 保持，running 停掉不泄漏）',
    left?.pointer?.listening === true,
    JSON.stringify(left?.pointer ?? null));

  // 窗口失焦也兜一次（面板把指针挡住时 pointerout 不一定到）
  canvasBackground.dispatchEvent(pointerEvent('pointermove', 150, 90));
  await settle(80);
  window.dispatchEvent(new window.Event('blur'));
  await settle(80);
  check('窗口失焦后提亮层同样复位',
    canvasApp.canvasGridReport()?.variables?.maskX === '-9999px');
}

// ---------------------------------------------------------------- 3.5) 设置页开关（画布互动）

/**
 * v1.27 用户要求的第二件事：「在设置里做一个开关」。
 * 这里真开设置对话框 → 切「画布外观」→ 找我们那块「画布互动」面板 → 点开关，
 * 验四件事：vendor 设置页里真的挂上了、点一下网格层立刻跟着关、关掉后指针完全不再画、
 * 再点一下恢复（并且关掉设置对话框后面板不残留）。
 */
{
  window.dispatchEvent(new window.CustomEvent('fisherai:open-settings'));
  const dialog = await waitFor(async () => doc.querySelector('[data-fisherai-settings="true"]'));
  check('设置对话框打开了', !!dialog);

  const appearanceTab = dialog?.querySelector('[data-fisherai-settings-section="appearance"]');
  check('设置里还有「画布外观」分区', !!appearanceTab);
  appearanceTab?.click();
  const effectsPanel = await waitFor(async () => doc.querySelector('[data-fisherai-canvas-effects]'));
  check('「画布外观」页里挂上了「画布互动」面板（vendor 补丁的宿主 div + 我们注册的全局）',
    !!effectsPanel);
  check('面板确实挂在 vendor 给的宿主 div 里',
    effectsPanel?.parentElement?.getAttribute('data-fisherai-settings-page') === 'appearance',
    effectsPanel?.parentElement?.getAttribute('data-fisherai-settings-page') ?? '(no parent attr)');

  const toggle = effectsPanel?.querySelector('[data-fisherai-canvas-effect="pointer-glow"]') ?? null;
  check('开关是 role=switch 的可访问按钮（不只是个装饰方块）',
    toggle?.getAttribute('role') === 'switch' && !!toggle?.getAttribute('aria-label'),
    `${toggle?.getAttribute('role')} / ${toggle?.getAttribute('aria-label')}`);
  check('默认开着：aria-checked=true 且面板状态 on',
    toggle?.getAttribute('aria-checked') === 'true' &&
      effectsPanel?.getAttribute('data-fisherai-canvas-effect-state') === 'on',
    `${toggle?.getAttribute('aria-checked')} / ${effectsPanel?.getAttribute('data-fisherai-canvas-effect-state')}`);

  const readStored = () => {
    try {
      return JSON.parse(window.localStorage.getItem('dsh-aifisher-canvas.canvas-effects') ?? 'null');
    } catch {
      return null;
    }
  };
  check('用户没动过时不预先写盘（默认值不落 localStorage）', readStored() === null,
    JSON.stringify(readStored()));

  // ---- 关掉 ----
  toggle?.click();
  await settle(150);
  check('点一下开关就关掉（aria-checked=false）',
    toggle?.getAttribute('aria-checked') === 'false');
  check('面板状态文案跟着变（off）',
    effectsPanel?.getAttribute('data-fisherai-canvas-effect-state') === 'off');
  check('关掉后写进本机 localStorage（pointerGlow=false）',
    readStored()?.pointerGlow === false, JSON.stringify(readStored()));
  check('网格层立刻收到（data-canvas-grid-interactive=off）',
    gridLayer?.getAttribute('data-canvas-grid-interactive') === 'off',
    String(gridLayer?.getAttribute('data-canvas-grid-interactive')));
  check('关掉后提亮层复位（opacity 0）', highlight?.style.opacity === '0',
    String(highlight?.style.opacity));

  const paintsBefore = canvasApp.canvasGridReport()?.pointer?.paints ?? 0;
  canvasBackground.dispatchEvent(pointerEvent('pointermove', 180, 90));
  await settle(150);
  const offProbe = canvasApp.canvasGridReport();
  check('关掉后指针怎么动都不亮（指针监听已摘掉，不是靠透明度遮）',
    offProbe?.variables?.maskX === '-9999px' &&
      offProbe?.highlightOpacity === '0' &&
      (offProbe?.pointer?.paints ?? 0) === paintsBefore,
    `${offProbe?.variables?.maskX} / ${offProbe?.highlightOpacity} / paints=${offProbe?.pointer?.paints}`);
  check('关掉后诊断读数说 listening=false',
    offProbe?.pointer?.listening === false, JSON.stringify(offProbe?.pointer ?? null));

  // ---- 再开 ----
  toggle?.click();
  await settle(150);
  canvasBackground.dispatchEvent(pointerEvent('pointermove', 200, 120));
  await settle(150);
  const onProbe = canvasApp.canvasGridReport();
  check('再点一下恢复（aria-checked=true）', toggle?.getAttribute('aria-checked') === 'true');
  check('恢复后指针互动又活了',
    onProbe?.variables?.maskX === '200px' && onProbe?.highlightOpacity === '1' &&
      onProbe?.pointer?.listening === true,
    `${onProbe?.variables?.maskX} / ${onProbe?.highlightOpacity} / ${onProbe?.pointer?.listening}`);
  check('恢复后诊断读数说 interactive=on',
    onProbe?.interactive === 'on', String(onProbe?.interactive));

  // ---- 面板的退订：关掉设置对话框不能把监听留在后台 ----
  const closeButton = dialog?.querySelector('[aria-label="关闭设置"]');
  check('设置对话框有关闭按钮', !!closeButton);
  closeButton?.click();
  await settle(350);
  check('关掉设置对话框后「画布互动」面板跟着卸载（不残留 DOM）',
    doc.querySelector('[data-fisherai-canvas-effects]') === null);
}

// ---------------------------------------------------------------- 4) 诊断与卸载

{
  const diag = await host.hostApi('GET', '/diagnostics?limit=80');
  const entries = diag.json().entries ?? [];
  const errors = entries.filter((entry) => entry.level === 'error');
  check('整个过程没有运行时错误', errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)');
  check('网格挂载有诊断留痕',
    entries.some((entry) => String(entry.message).includes('画布网格底纹已挂载')),
    entries.filter((e) => String(e.message).includes('网格')).map((e) => e.message).join(' | ') || '(none)');
}

{
  const loaded = (await host.hostApi('GET', '/diagnostics?limit=80'))
    .json()
    .entries?.find((entry) => String(entry.message).includes('画布应用已加载'));
  check('「画布应用已加载」里带上了 grid 段', loaded?.detail?.grid !== undefined,
    JSON.stringify(loaded?.detail?.grid ?? null).slice(0, 160));
}

if (handle) {
  handle.dispose();
  await settle(120);
  check('dispose 后网格层从 DOM 移除（不留残层）',
    doc.querySelector('[data-canvas-grid="true"]') === null);
}

console.log(lines.join('\n'));
console.log(`\nSUMMARY pass=${lines.filter((line) => line.startsWith('PASS')).length} fail=${failures}`);
process.exit(failures === 0 ? 0 : 1);
