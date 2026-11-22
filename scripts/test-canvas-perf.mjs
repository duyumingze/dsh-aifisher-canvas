/**
 * 画布性能 P0/P1 的回归（scripts/test-canvas-perf.mjs）。
 *
 * 背景（2026-11-22 用户原话「现在画布浏览起来还是有点卡」）：取证量到素材 441 个文件 615MB、
 * 178 张 PNG 合计 270.8 MPix（RGBA8 解码 ≈ 1.01GB），而节点卡只有 360×420；同时皮肤里
 * 65+ 处 `backdrop-filter: blur(18–20px)` 压在会动的画布上。于是这一版做两件事：
 *
 *   P0 手势降载（src/client/canvas/gesture.ts）
 *     - 平移/缩放/拖拽期间给容器打 `data-canvas-gesture`，样式里关掉全屏玻璃模糊、卡片大阴影、
 *       连线 feGaussianBlur、点阵提亮层；停手 180ms 恢复。
 *     - 这里验：滚轮在画布上 → `zoom`；拖拽 → `drag`（松手后延时清除）；画布外滚轮不触发；
 *       样式表里规则齐全；dispose 之后属性与监听都没了。
 *
 *   P1-1 缩略图管线（src/host/canvas/mediaRouter.ts + src/client/canvas/thumbs.ts）
 *     - `GET /media/...?w=1024`：有缩略图回缩略图（`x-aifisher-thumb: hit`），没有就先回原图
 *       且 `cache-control: no-store`（同一个 URL 之后要能换成缩略图）。
 *     - `POST /media/thumb` 落盘；非法 url / 宽度要拒。
 *     - 画布侧：节点层里的大图（naturalWidth ≥ 1600）在加载后换成 `?w=1024`，小图不动。
 *
 * 用法：node scripts/test-canvas-perf.mjs   （需要先 build）
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

const PROJECT_ID = 'proj-canvas-perf';
/** 1×1 的最小合法 PNG（内容无所谓，用例只关心「有没有这个文件」）。 */
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** 伪 webp 字节：host 只负责落盘与按扩展名回 content-type，不解码，所以内容可以随便。 */
const FAKE_WEBP = Buffer.from('RIFF0000WEBPVP8 00000000', 'utf8');

const host = await startHost();
let mediaUrl = '';

// ---------------------------------------------------------------- 1) host：缩略图路由
{
  const upload = await host.hostApi('POST', '/assets/images', {
    data: TINY_PNG_DATA_URL,
    projectId: PROJECT_ID,
    filename: 'perf-thumb.png',
  });
  const payload = upload.json();
  mediaUrl = typeof payload?.url === 'string' ? payload.url : '';
  check('素材上传成功（缩略图用例的宿主）', upload.status === 200 && !!mediaUrl, mediaUrl);

  const original = await host.dispatch('GET', mediaUrl);
  const miss = await host.dispatch('GET', `${mediaUrl}?w=1024`);
  check(
    '没有缩略图时 ?w= 如实回原图，并标 x-aifisher-thumb: miss',
    miss.status === 200 && miss.headers['x-aifisher-thumb'] === 'miss',
    `status=${miss.status} thumb=${miss.headers['x-aifisher-thumb'] ?? '(none)'}`,
  );
  check(
    'miss 响应不许被浏览器缓存（no-store）——否则同一 URL 永远换不成缩略图',
    String(miss.headers['cache-control'] ?? '').includes('no-store'),
    String(miss.headers['cache-control'] ?? ''),
  );
  check(
    'miss 回的就是原图（字节一致）',
    miss.body === original.body,
    `${original.body.length} vs ${miss.body.length}`,
  );

  const posted = await host.dispatch(
    'POST',
    '/api/aifisher/canvas/media/thumb',
    JSON.stringify({
      url: mediaUrl,
      width: 1024,
      data: `data:image/webp;base64,${FAKE_WEBP.toString('base64')}`,
    }),
  );
  check('POST /media/thumb 落盘成功', posted.status === 200, String(posted.body).slice(0, 120));

  const hit = await host.dispatch('GET', `${mediaUrl}?w=1024`);
  check(
    '生成过之后同一个 URL 回缩略图（x-aifisher-thumb: hit，content-type: image/webp）',
    hit.status === 200 &&
      hit.headers['x-aifisher-thumb'] === 'hit' &&
      String(hit.headers['content-type'] ?? '').includes('webp'),
    `${hit.headers['x-aifisher-thumb'] ?? '(none)'} / ${hit.headers['content-type'] ?? '(none)'}`,
  );
  check('hit 回的是刚写进去的那份字节', hit.body === FAKE_WEBP.toString('utf8'));

  const badWidth = await host.dispatch('GET', `${mediaUrl}?w=777`);
  check(
    '非法宽度（777）按原图处理，不瞎生成',
    badWidth.status === 200 && !badWidth.headers['x-aifisher-thumb'],
    String(badWidth.headers['x-aifisher-thumb'] ?? '(none)'),
  );

  const foreign = await host.dispatch(
    'POST',
    '/api/aifisher/canvas/media/thumb',
    JSON.stringify({ url: 'https://example.com/a.png', width: 1024, data: TINY_PNG_DATA_URL }),
  );
  check('外部 URL 不许写缩略图（只认素材库里的文件）', foreign.status === 404, String(foreign.status));

  const bigThumb = await host.dispatch('GET', `${mediaUrl}?w=2048`);
  check(
    '别的宽度是独立缓存（2048 还没生成 → miss）',
    bigThumb.headers['x-aifisher-thumb'] === 'miss',
    String(bigThumb.headers['x-aifisher-thumb'] ?? '(none)'),
  );

  const badWidthPost = await host.dispatch(
    'POST',
    '/api/aifisher/canvas/media/thumb',
    JSON.stringify({ url: mediaUrl, width: 999, data: TINY_PNG_DATA_URL }),
  );
  check('POST 里宽度不在白名单 → 422', badWidthPost.status === 422, String(badWidthPost.status));
}

// ---------------------------------------------------------------- 2) 画布：手势降载
{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '性能回归',
    nodes: [
      {
        id: 'perf-node-1',
        type: 'Image',
        x: 0,
        y: 0,
        prompt: '性能回归节点',
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

  const { window } = await createCanvasDom({ dispatch: host.dispatch });
  seedResume(window, PROJECT_ID);
  const { canvasApp, container, handle } = await mountCanvasApp(window);
  await settle(1500);

  const doc = window.document;
  const canvasBackground = await waitFor(async () => doc.getElementById('canvas-background'));
  check('画布底盘渲染出来了', !!canvasBackground);

  const styleText = doc.getElementById('dsh-aifisher-canvas-styles')?.textContent ?? '';
  check(
    '样式表里有「手势期间关玻璃模糊」的规则',
    styleText.includes("[data-canvas-gesture] [class*='backdrop-blur']") &&
      styleText.includes('backdrop-filter: none !important'),
  );
  check(
    '样式表里有「手势期间关卡片阴影 / 连线 filter / 点阵提亮层」的规定',
    styleText.includes("[class*='shadow-']") &&
      styleText.includes('.fisherai-canvas-edge path') &&
      styleText.includes('.canvas-grid-cross.is-highlight') &&
      styleText.includes('visibility: hidden'),
  );

  const gestureAttr = () => container.getAttribute('data-canvas-gesture');
  check('初始没有降载（静止画布照常有模糊/阴影）', gestureAttr() === null, String(gestureAttr()));

  // 滚轮落在画布上 → zoom 降载
  canvasBackground.dispatchEvent(
    new window.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, deltaY: -120 }),
  );
  check('画布上滚轮 → data-canvas-gesture="zoom"', gestureAttr() === 'zoom', String(gestureAttr()));
  await settle(280);
  check('停手 180ms 后恢复（属性被摘掉）', gestureAttr() === null, String(gestureAttr()));

  // 按住拖拽 → drag 降载；松手后延时清除
  const pointer = (type, x, y, options = {}) =>
    new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      ...options,
    });
  canvasBackground.dispatchEvent(pointer('pointerdown', 400, 300));
  check('只按下还没动 → 不降载（单击不该关掉模糊）', gestureAttr() === null, String(gestureAttr()));
  canvasBackground.dispatchEvent(pointer('pointermove', 470, 340));
  check('拖过阈值 → data-canvas-gesture="drag"', gestureAttr() === 'drag', String(gestureAttr()));
  canvasBackground.dispatchEvent(pointer('pointerup', 470, 340));
  await settle(280);
  check('松手 180ms 后恢复', gestureAttr() === null, String(gestureAttr()));

  // 画布外滚轮不触发（右栏对话 / 项目库的滚动不该被降载）
  doc.body.dispatchEvent(
    new window.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, deltaY: -120 }),
  );
  check('画布外滚轮不降载', gestureAttr() === null, String(gestureAttr()));

  check(
    'canvasGestureReport 能读到挂载状态与切换次数',
    (() => {
      const report = canvasApp.canvasGestureReport();
      return report?.mounted === true && Number(report.marks) >= 3 && report.idleMs === 180;
    })(),
    JSON.stringify(canvasApp.canvasGestureReport()),
  );

  // ---------------------------------------------------------------- 2b) 手势期不 setState（v1.108）
  /**
   * 手势期间 DOM transform 每个事件都写，React 状态按 90ms 合并。
   * 这里量的是「合并有没有生效」+「补齐时会不会被旧值写回去」+「按指针前补不补」。
   */
  {
    const viewportLayer = doc.getElementById('canvas-viewport-content');
    check('视口层存在（合并提交的宿主）', !!viewportLayer);
    const transformOf = () => String(viewportLayer?.style.transform ?? '');
    const scaleOf = () => {
      const matched = /scale\(([-0-9.eE+]+)\)/.exec(transformOf());
      return matched ? Number.parseFloat(matched[1]) : Number.NaN;
    };
    const translateOf = () => {
      const matched = /translate3d\(\s*([-0-9.eE+]+)px\s*,\s*([-0-9.eE+]+)px/.exec(transformOf());
      return matched ? `${matched[1]},${matched[2]}` : '';
    };
    const wheel = (options) =>
      canvasBackground.dispatchEvent(
        new window.WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: 400,
          clientY: 300,
          ...options,
        }),
      );
    const stats = () => window.__FISHERAI_CANVAS_VIEWPORT_STATS__?.();
    check(
      '视口探针挂在 window 上（真机也能读）',
      typeof stats() === 'object' && stats() !== null && typeof stats().stateSyncs === 'number',
      JSON.stringify(stats?.() ?? null),
    );

    // A) 滚轮缩放：每个事件都写 transform，状态合并提交。
    const scaleBefore = scaleOf();
    const syncsStart = Number(stats().stateSyncs);
    const ticksStart = Number(stats().wheelTicks);
    for (let index = 0; index < 6; index += 1) wheel({ deltaY: -120 });
    const scaleAfter = scaleOf();
    check(
      '滚轮缩放：transform 每个事件都落（跟手、不等 React）',
      Number.isFinite(scaleAfter) && scaleAfter > scaleBefore,
      `${scaleBefore} → ${scaleAfter}`,
    );
    check('滚轮缩放：wheel 计数 = 6', Number(stats().wheelTicks) - ticksStart === 6,
      String(Number(stats().wheelTicks) - ticksStart));
    const syncsZoom = Number(stats().stateSyncs) - syncsStart;
    check('滚轮缩放：6 连滚只提交 ≤3 次给 React', syncsZoom <= 3, String(syncsZoom));

    // B) Alt+滚轮平移：24 连滚，平移量每 tick 都落，状态仍然合并。
    await settle(160);
    const syncsPanStart = Number(stats().stateSyncs);
    const ticksPanStart = Number(stats().wheelTicks);
    const translateBefore = translateOf();
    for (let index = 0; index < 24; index += 1) wheel({ deltaY: 40, altKey: true });
    const transformAfterBurst = transformOf();
    check(
      'Alt+滚轮平移：24 tick 的平移量都落在 transform 上',
      translateOf() !== translateBefore,
      `${translateBefore} → ${translateOf()}`,
    );
    check('Alt+滚轮平移：wheel 计数 = 24', Number(stats().wheelTicks) - ticksPanStart === 24,
      String(Number(stats().wheelTicks) - ticksPanStart));
    const syncsBurst = Number(stats().stateSyncs) - syncsPanStart;
    check('Alt+滚轮平移：24 连滚只提交 ≤4 次给 React', syncsBurst <= 4, String(syncsBurst));

    await settle(260);
    const syncsSettled = Number(stats().stateSyncs) - syncsPanStart;
    check('停手后补齐一次（React 状态最终追上 DOM）', syncsSettled > syncsBurst,
      `${syncsBurst} → ${syncsSettled}`);
    check(
      '补齐时没有把 transform 写回旧值（渲染读的是最新视口）',
      transformOf() === transformAfterBurst,
      `${transformAfterBurst} vs ${transformOf()}`,
    );

    // C) 按下指针之前必须补齐：框选/建节点/连线都按 state 里的视口算起点。
    await settle(160);
    const syncsIdle = Number(stats().stateSyncs);
    wheel({ deltaY: 40, altKey: true });
    wheel({ deltaY: 40, altKey: true });
    const syncsMidBurst = Number(stats().stateSyncs);
    canvasBackground.dispatchEvent(
      new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 300, clientY: 200, button: 0, buttons: 1 }),
    );
    const syncsAfterPress = Number(stats().stateSyncs);
    check(
      '指针按下时立刻补齐视口（拖完立刻框选不会偏）',
      syncsAfterPress > syncsMidBurst,
      `${syncsIdle} → ${syncsMidBurst} → ${syncsAfterPress}`,
    );
    canvasBackground.dispatchEvent(
      new window.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 300, clientY: 200, button: 0, buttons: 0 }),
    );
  }

  // ---------------------------------------------------------------- 3) 缩略图：画布侧换 src
  const layer = await waitFor(async () => doc.querySelector('[data-canvas-nodes-layer]'));
  check('节点层渲染出来了（缩略图观察的宿主）', !!layer);

  if (layer && mediaUrl) {
    const big = doc.createElement('img');
    big.setAttribute('src', mediaUrl);
    layer.appendChild(big);
    Object.defineProperty(big, 'naturalWidth', { value: 3840, configurable: true });
    big.dispatchEvent(new window.Event('load'));
    await settle(600);
    check(
      '4K 图在节点层里被换成 ?w=1024 的缩略图',
      String(big.getAttribute('src')).endsWith('?w=1024'),
      String(big.getAttribute('src')),
    );
    check('换过的图打了 fisherai-thumb=on 标记', big.dataset.fisheraiThumb === 'on', String(big.dataset.fisheraiThumb));
    check(
      '原图 URL 记在 data 里（卸载时能还原）',
      String(big.dataset.fisheraiThumbFull) === mediaUrl,
      String(big.dataset.fisheraiThumbFull),
    );

    const small = doc.createElement('img');
    small.setAttribute('src', mediaUrl);
    layer.appendChild(small);
    Object.defineProperty(small, 'naturalWidth', { value: 800, configurable: true });
    small.dispatchEvent(new window.Event('load'));
    await settle(200);
    check(
      '小图（naturalWidth 800）不换（缩了只会更糊）',
      small.getAttribute('src') === mediaUrl && small.dataset.fisheraiThumb === 'skip',
      `${small.getAttribute('src')} / ${small.dataset.fisheraiThumb}`,
    );

    const remote = doc.createElement('img');
    remote.setAttribute('src', 'https://example.com/remote.png');
    layer.appendChild(remote);
    Object.defineProperty(remote, 'naturalWidth', { value: 4096, configurable: true });
    remote.dispatchEvent(new window.Event('load'));
    await settle(150);
    check('远程直链不动（只处理素材库 URL）', remote.getAttribute('src') === 'https://example.com/remote.png');

    const report = canvasApp.canvasThumbsReport();
    check(
      'canvasThumbsReport 报出层内图片数 / 已换缩略图数',
      report?.mounted === true && Number(report.thumbedNow) >= 1 && Number(report.width) === 1024,
      JSON.stringify(report),
    );
  }

  handle.dispose();
  await settle(200);
  check('dispose 之后降载属性不残留', container.getAttribute('data-canvas-gesture') === null);
}

console.log(
  lines
    .map((line) => (line.startsWith('FAIL') ? line : `\u001b[2m${line}\u001b[0m`))
    .join('\n'),
);
const failed = lines.filter((line) => line.startsWith('FAIL'));
if (failed.length) console.log(failed.join('\n'));
console.log(`SUMMARY pass=${lines.length - failures} fail=${failures}`);
process.exit(failures ? 1 : 0);
