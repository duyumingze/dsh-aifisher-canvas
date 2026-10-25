/**
 * 「视频截帧」回归（v1.66）。
 *
 * 用户原话（2026-10-23）：「完善视频截取首尾帧功能」。
 *
 * 上游只有「一次性截首尾帧」：两帧一起、原尺寸 PNG、落在 `source.x + 400`，
 * 而且不会把视口带过去 —— 节点在视口外时用户看到的就是「点了没反应」。
 * 这一版补齐四件事，本套件逐条钉住：
 *   A. 纯逻辑：输出尺寸上限（FRAME_MAX_EDGE）/ 尾帧候选序列（含空白兜底顺序）/
 *      空白帧判定 / 贴右避让落位（首上尾下、列间距、列与列之间）。
 *   B. 真 DOM（jsdom 真挂画布、真点菜单）：菜单三项 → 单截尾帧只出一个节点 →
 *      首尾帧出两个 → 位置按落位算法避让已有节点 → 焦点带过去 → 存盘后 title/x/y/prompt 都对。
 *   C. 源码级：vendor 那三处接线还在（空帧跳过 / 落位桥 / focus），别被上游改写法静默弄丢。
 *
 * 用法：node scripts/test-canvas-video-frames.mjs   （需要先 build）
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';
import { encodeSolidPng } from './lib/png.mjs';

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
    // 必须让出 macrotask：紧循环里 await 同步值只会跑微任务，setTimeout 永不触发
    await settle(60);
  }
  return last;
}

const PROJECT_ID = 'proj-canvas-video-frames';
const MEDIA = (kind, file) => `/api/aifisher/canvas/media/${PROJECT_ID}/${kind}/${file}`;
const VIDEO = MEDIA('videos', 'frames-source.mp4');
const dataUrl = (rgb) =>
  `data:image/png;base64,${encodeSolidPng(320, 180, rgb).toString('base64')}`;
const FIRST_FRAME = dataUrl([200, 40, 40]);
const LAST_FRAME = dataUrl([40, 80, 200]);

// 落位预期（与 CanvasFrameLayout 同一套口径：帧宽 365、列间距 60、纵向间距 40）
const SOURCE_WIDTH = 320;
const SOURCE_HEIGHT = 180;
const FRAME_WIDTH = 365;
const FRAME_HEIGHT = Math.round((FRAME_WIDTH / (SOURCE_WIDTH / SOURCE_HEIGHT)) * 100) / 100;
const COLUMN_ONE = SOURCE_WIDTH + 60; // 380
const COLUMN_TWO = COLUMN_ONE + FRAME_WIDTH + 60; // 805
const COLUMN_THREE = COLUMN_TWO + FRAME_WIDTH + 60; // 1230

const host = await startHost();
{
  const videoNode = {
    id: 'video-source',
    type: 'Video',
    x: 0,
    y: 0,
    title: '截帧源视频',
    prompt: '一段用来截帧的片子',
    status: 'success',
    model: 'Seedance 2.5 Standard · API',
    videoModel: 'Seedance 2.5 Standard · API',
    resultUrl: VIDEO,
    resultUrls: [VIDEO],
    resultAspectRatio: `${SOURCE_WIDTH}/${SOURCE_HEIGHT}`,
    aspectRatio: '16:9',
    duration: 5,
    parentIds: [],
    projectId: PROJECT_ID,
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT,
  };
  // 挡在第一列的位置上：截帧必须挪到第二列，而不是叠在它身上
  const blocker = {
    id: 'frame-blocker',
    type: 'Image',
    x: COLUMN_ONE,
    y: -140,
    title: '挡路的图',
    prompt: '',
    status: 'success',
    model: 'Upload',
    resultUrl: MEDIA('images', 'blocker.png'),
    resultAspectRatio: `${FRAME_WIDTH}/205`,
    aspectRatio: '16:9',
    parentIds: [],
    projectId: PROJECT_ID,
    width: FRAME_WIDTH,
    height: 205,
  };
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '视频截帧验证',
    nodes: [videoNode, blocker],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目：一个视频节点 + 一个挡在第一列位置的图片节点', save.status === 200,
    String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { canvasApp, handle } = await mountCanvasApp(window);
await settle(1500);
const doc = window.document;

// ---------------------------------------------------------------- A) 纯逻辑（跑构建产物）
{
  const {
    FRAME_MAX_EDGE,
    TAIL_SEEK_OFFSETS,
    frameTargetSize,
    isBlankFrameSamples,
    tailTimes,
    placeFrameNodes,
    frameRectsOverlap,
    estimateNodeSize,
    FRAME_LAYOUT_GAP,
  } = canvasApp;
  check('产物导出了截帧 / 落位的纯函数',
    [frameTargetSize, tailTimes, isBlankFrameSamples, placeFrameNodes].every(
      (value) => typeof value === 'function',
    ));
  check('输出最长边上限是 2048（不搬 4K 原图）', FRAME_MAX_EDGE === 2048, String(FRAME_MAX_EDGE));
  check('尾帧第一个候选是 duration - 0.05（与 lastFrame 缩略图同口径）',
    TAIL_SEEK_OFFSETS[0] === 0.05, String(TAIL_SEEK_OFFSETS[0]));

  const big = frameTargetSize(3840, 2160);
  check('4K 帧按最长边 2048 缩放（3840×2160 → 2048×1152）',
    big.width === 2048 && big.height === 1152 && Math.abs(big.scale - 2048 / 3840) < 1e-9,
    `${big.width}×${big.height} scale=${big.scale}`);
  const small = frameTargetSize(320, 180);
  check('小图不放大（320×180 原样）', small.width === 320 && small.height === 180 && small.scale === 1,
    `${small.width}×${small.height}`);
  check('非法尺寸退化成 1×1（不抛错）',
    JSON.stringify(frameTargetSize(0, 0)) === JSON.stringify({ width: 1, height: 1, scale: 1 }),
    JSON.stringify(frameTargetSize(0, 0)));

  const times = tailTimes(10);
  check('尾帧候选：从晚到早 4 档（9.95 / 9.8 / 9.5 / 8.8）',
    JSON.stringify(times) === JSON.stringify([9.95, 9.8, 9.5, 8.8]), JSON.stringify(times));
  check('尾帧候选：偏移不会把时间推到负数',
    tailTimes(0.1).every((time) => time >= 0), JSON.stringify(tailTimes(0.1)));
  check('尾帧候选：重复偏移只留一个',
    tailTimes(5, [0.05, 0.05, 0.2]).length === 2, JSON.stringify(tailTimes(5, [0.05, 0.05, 0.2])));
  check('尾帧候选：时长非法 → 空数组',
    tailTimes(Number.NaN).length === 0 && tailTimes(0).length === 0);

  check('空白帧判定：alpha 全 0 才算空白',
    isBlankFrameSamples([]) === true &&
      isBlankFrameSamples([[0, 0, 0, 0], [0, 0, 0, 0]]) === true &&
      isBlankFrameSamples([[0, 0, 0, 0], [9, 9, 9, 255]]) === false);

  const source = { id: 'v', type: 'Video', x: 0, y: 0, width: 320, height: 180, resultAspectRatio: '320/180' };
  const two = placeFrameNodes(source, [{ title: '视频首帧' }, { title: '视频尾帧' }], []);
  check('落位：两张在同一列、贴视频右侧 60px', two.length === 2 && two.every((rect) => rect.x === 380) &&
    FRAME_LAYOUT_GAP === 60, JSON.stringify(two.map((rect) => [rect.x, rect.y])));
  check('落位：两张上下分开、尾帧在首帧下方（按节点高 + 40）',
    two[1].y - two[0].y > FRAME_HEIGHT && Math.abs(two[1].y - two[0].y - (FRAME_HEIGHT + 40)) < 0.01,
    `${two[0].y} → ${two[1].y}（帧高 ${FRAME_HEIGHT}）`);
  check('落位：整组以视频中线为中心（首帧中线在视频中线之上）',
    Math.abs((two[0].y + two[1].y + FRAME_HEIGHT) / 2 - 90) < 0.01,
    String((two[0].y + two[1].y + FRAME_HEIGHT) / 2));
  const one = placeFrameNodes(source, [{ title: '视频尾帧' }], []);
  check('落位：只截一帧时它垂直居中', one.length === 1 && Math.abs(one[0].y + FRAME_HEIGHT / 2 - 90) < 0.01,
    JSON.stringify(one));

  const blocker = { id: 'b', type: 'Image', x: 380, y: -140, width: 365, height: 205 };
  const avoided = placeFrameNodes(source, [{ title: '首' }, { title: '尾' }], [blocker]);
  check('落位：第一列被占就整列右移（380 → 805）', avoided.every((rect) => rect.x === 805),
    JSON.stringify(avoided.map((rect) => rect.x)));
  check('落位：多列都被占时贴着画布最右再往右',
    placeFrameNodes(source, [{ title: '首' }], [blocker, { id: 'c', type: 'Image', x: 805, y: -60, width: 365, height: 205 }])
      .every((rect) => rect.x === 1230),
    JSON.stringify(placeFrameNodes(source, [{ title: '首' }], [blocker, { id: 'c', type: 'Image', x: 805, y: -60, width: 365, height: 205 }]).map((rect) => rect.x)));
  check('矩形相交判定：贴边不算相交',
    frameRectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }) === false &&
      frameRectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 10, height: 10 }) === true);
  check('尺寸估算：没写宽高的视频节点按 385×216 兜底',
    JSON.stringify(estimateNodeSize({ type: 'Video', x: 0, y: 0 })) === JSON.stringify({ width: 385, height: 216.5625 }),
    JSON.stringify(estimateNodeSize({ type: 'Video', x: 0, y: 0 })));

  // 装配层真的把两个桥挂出去了（vendor 只认 window 上的桥）
  check('装配层挂了取帧桥（capture / targetSize / tailTimes）',
    !!window.__FISHERAI_VIDEO_FRAMES__ &&
      ['capture', 'targetSize', 'tailTimes'].every(
        (key) => typeof window.__FISHERAI_VIDEO_FRAMES__[key] === 'function',
      ),
    Object.keys(window.__FISHERAI_VIDEO_FRAMES__ ?? {}).join(','));
  check('装配层挂了落位桥（place）',
    !!window.__FISHERAI_FRAME_LAYOUT__ && typeof window.__FISHERAI_FRAME_LAYOUT__.place === 'function');
}

// ------------------------------------- A2) v1.67 加固：seek 等待不再靠"单次事件快照"
//
// 报障「截取视频首尾帧失败了」的真身：旧写法把判定挂在 `seeked` 上，事件来的时候
// `readyState` 还没到 2 / `currentTime` 差几毫秒，条件就永远不再评估 → 白等 15s 报
// 「视频定位超时」。这一段用假元素把「事件来得太早」「事件根本不来」两种情况钉住。
{
  const {
    seekLanded,
    clampSeekTime,
    mediaStateText,
    waitUntil,
    SEEK_TOLERANCE_SEC,
    PAINT_WAIT_MS,
  } = canvasApp;
  check('产物导出了 v1.67 的等待 / 判定函数',
    [seekLanded, clampSeekTime, mediaStateText, waitUntil].every((value) => typeof value === 'function'),
    [seekLanded, clampSeekTime, mediaStateText, waitUntil].map((value) => typeof value).join(','));
  check('落点容差放宽到 0.5s（Chromium 会吸到最近可解码帧）', SEEK_TOLERANCE_SEC === 0.5,
    String(SEEK_TOLERANCE_SEC));
  check('空白帧最多等 800ms 才判"真没画面"', PAINT_WAIT_MS === 800, String(PAINT_WAIT_MS));

  const fakeVideo = (state = {}) => {
    const listeners = new Map();
    const video = {
      currentTime: 0,
      duration: 362.04,
      readyState: 1,
      seeking: false,
      seekable: { length: 0, start: () => 0, end: () => 0 },
      addEventListener(name, listener) {
        const list = listeners.get(name) ?? [];
        list.push(listener);
        listeners.set(name, list);
      },
      removeEventListener(name, listener) {
        const list = listeners.get(name) ?? [];
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
      },
      emit(name) {
        for (const listener of [...(listeners.get(name) ?? [])]) listener();
      },
      listenerCount() {
        let total = 0;
        for (const list of listeners.values()) total += list.length;
        return total;
      },
      ...state,
    };
    return video;
  };

  // ① seek 到底算不算落到位
  check('落点判定：readyState 还不到 2 就是没落到位',
    seekLanded({ currentTime: 361.99, readyState: 1, seeking: false }, 361.99) === false);
  check('落点判定：仍在寻址就是没落到位',
    seekLanded({ currentTime: 361.99, readyState: 4, seeking: true }, 361.99) === false);
  check('落点判定：差 0.3s 也算落到位（容差 0.5）',
    seekLanded({ currentTime: 362.24, readyState: 4, seeking: false }, 361.99) === true);
  check('落点判定：差 0.9s 不算（真的跑偏了）',
    seekLanded({ currentTime: 362.9, readyState: 4, seeking: false }, 361.99) === false);

  // ② 按 seekable 钳制：拿不到 range 的远端素材只能到已缓冲处
  const partiallySeekable = { seekable: { length: 1, start: () => 0, end: () => 20.064 } };
  check('钳制：seekable 只到 20s 时，361.99s 退到 20.01s 附近而不是硬等',
    Math.abs(clampSeekTime(partiallySeekable, 361.99) - (20.064 - 0.05)) < 1e-6,
    String(clampSeekTime(partiallySeekable, 361.99)));
  check('钳制：seekable 到片尾时不动目标',
    clampSeekTime({ seekable: { length: 1, start: () => 0, end: () => 362.043 } }, 361.993) === 361.993);
  check('钳制：读不到 seekable（老浏览器 / 假元素）时原样返回',
    clampSeekTime({ seekable: { length: 0, start: () => 0, end: () => 0 } }, 9.95) === 9.95);

  // ③ 现场描述要能定位
  const stateText = mediaStateText({ currentTime: 361.9935, duration: 362.043478, readyState: 1, seeking: true });
  check('现场描述带 readyState / 寻址中 / 落点 / 时长',
    stateText.includes('readyState=1') && stateText.includes('仍在寻址') &&
      stateText.includes('361.99') && stateText.includes('362.04'),
    stateText);

  // ④ 关键回归：事件来得太早 → 轮询把它捡回来（旧写法在这里会卡满超时）
  {
    const video = fakeVideo({ seeking: true, readyState: 1, currentTime: 361.99 });
    const started = Date.now();
    const done = waitUntil(video, {
      ready: () => !video.seeking && video.readyState >= 2,
      timeoutMs: 5000,
      timeoutMessage: () => '不该超时',
      wake: ['seeked'],
    });
    await settle(80);
    video.seeking = true; // seeked 来得太早：那一刻还不满足
    video.readyState = 1;
    video.emit('seeked');
    await settle(80);
    video.seeking = false;
    video.readyState = 4; // 之后再满足（不会再有任何事件）
    await done;
    check('事件来得太早也丢不了（轮询 40ms 后在 1.5s 内通过）',
      Date.now() - started < 1500, `${Date.now() - started}ms`);
    check('通过后把唤醒监听摘干净（不留泄漏）', video.listenerCount() === 0,
      String(video.listenerCount()));
  }

  // ⑤ 关键回归：一个事件都不来，只靠状态变化也能通过
  {
    const video = fakeVideo({ readyState: 1 });
    const done = waitUntil(video, {
      ready: () => video.readyState >= 2,
      timeoutMs: 2000,
      timeoutMessage: () => '不该超时',
    });
    setTimeout(() => { video.readyState = 2; }, 140);
    await done;
    check('一个事件都不来也能靠轮询通过（不依赖 seeked 一定送达）', true);
  }

  // ⑥ 坏掉要立刻失败，不要白等
  {
    const video = fakeVideo();
    let failure = null;
    try {
      await waitUntil(video, {
        ready: () => false,
        failed: () => new Error('解码错误 code=4'),
        timeoutMs: 5000,
        timeoutMessage: () => '不该超时',
      });
    } catch (error) {
      failure = error;
    }
    check('failed() 一返回错误就立刻失败（不等超时）',
      failure instanceof Error && failure.message.includes('code=4'), failure?.message ?? 'no error');
  }

  // ⑦ 超时文案要带现场
  {
    const video = fakeVideo({ readyState: 1, seeking: false, currentTime: 361.99 });
    let failure = null;
    try {
      await waitUntil(video, {
        ready: () => false,
        timeoutMs: 120,
        timeoutMessage: () => `视频定位超时（${mediaStateText(video)}）`,
      });
    } catch (error) {
      failure = error;
    }
    check('超时文案带现场（readyState + 落点），不再是干巴巴一句"等待超时"',
      failure instanceof Error && failure.message.includes('readyState=1') && failure.message.includes('361.99'),
      failure?.message ?? 'no error');
    check('超时后同样摘干净监听', video.listenerCount() === 0, String(video.listenerCount()));
  }

  // ⑧ abort 立刻结束
  {
    const controller = new AbortController();
    const video = fakeVideo();
    const done = waitUntil(video, {
      ready: () => false,
      timeoutMs: 5000,
      signal: controller.signal,
      timeoutMessage: () => '不该超时',
    }).then(() => 'resolved', (error) => error);
    await settle(60);
    controller.abort();
    const outcome = await done;
    check('signal 一 abort 就退出（不退化成等满超时）',
      outcome instanceof Error && outcome.name === 'AbortError', String(outcome));
  }
}

const videoCard = await waitFor(() => doc.querySelector('[data-node-id="video-source"]'));
check('画布上渲染出视频节点', !!videoCard);
const trigger = () => videoCard?.querySelector('[data-fisherai-video-frame-trigger="true"]') ?? null;
const menu = () => videoCard?.querySelector('[data-fisherai-video-frame-menu="true"]') ?? null;
const action = (mode) =>
  videoCard?.querySelector(`[data-fisherai-video-frame-action="${mode}"]`) ?? null;
const frameStatus = () =>
  videoCard?.querySelector('[data-fisherai-video-frame-status]') ?? null;
const statusText = () => (frameStatus()?.textContent ?? '').trim();
const frameNodes = () =>
  [...(doc.querySelectorAll('[data-node-id]') ?? [])].filter((node) => {
    const title = node.querySelector('[data-af-node-title]')?.textContent ?? '';
    return title.includes('视频首帧') || title.includes('视频尾帧');
  });

{
  check('视频底部工具条有「截取视频帧」入口（菜单触发器）', !!trigger(),
    videoCard?.querySelectorAll('button').length + ' buttons');
  check('菜单默认收起', menu() === null);
  trigger()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(200);
  check('点入口 → 弹出截帧菜单', !!menu());
  check('菜单三项：首帧 / 尾帧 / 首尾帧各一张',
    ['first', 'last', 'both'].every((mode) => !!action(mode)),
    [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])]
      .map((item) => item.textContent)
      .join(' | '));
}

// ---------------------------------------------------------------- B) 真 DOM：点菜单 → 落节点
const captureCalls = [];
const focusCalls = [];
{
  const click = (element) =>
    element?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const pick = async (mode) => {
    // 上一段断言可能已经把菜单摊开了：只按一次，别把它又收回去
    if (!menu()) {
      click(trigger());
      await settle(150);
    }
    click(action(mode));
  };

  // jsdom 解不了视频：把取帧桥换成桩（真实取帧在真浏览器检查里跑），记录它被要求取哪几帧
  window.__FISHERAI_VIDEO_FRAMES__ = {
    capture: async (url, roles, signal) => {
      captureCalls.push({ url, roles: [...roles], aborted: Boolean(signal?.aborted) });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return roles.map((role) => ({
        role,
        data: role === 'first' ? FIRST_FRAME : LAST_FRAME,
        width: 320,
        height: 180,
        time: role === 'first' ? 0 : 4.95,
      }));
    },
    targetSize: canvasApp.frameTargetSize,
    tailTimes: canvasApp.tailTimes,
  };
  window.__FISHERAI_FOCUS_NODES__ = (ids) => focusCalls.push([...ids]);

  // ① 首尾帧各一张
  await pick('both');
  await waitFor(() => statusText() === '已截取首尾帧', 15000);
  check('点「首尾帧各一张」→ 画布多出 2 个截帧节点', frameNodes().length === 2,
    String(frameNodes().length));
  check('取帧桥被要求取 first + last 两帧',
    JSON.stringify(captureCalls[0]?.roles) === JSON.stringify(['first', 'last']),
    JSON.stringify(captureCalls[0]?.roles));
  check('取的是这条片子的地址（本地素材不过代理）', captureCalls[0]?.url === VIDEO,
    captureCalls[0]?.url);
  check('点完菜单自动收起', menu() === null);
  check('成功回执写的是「已截取首尾帧」', statusText() === '已截取首尾帧', statusText());
  check('截完把「视频 + 新节点」一起聚焦进视口',
    Array.isArray(focusCalls[0]) && focusCalls[0][0] === 'video-source' && focusCalls[0].length === 3,
    JSON.stringify(focusCalls[0]));

  // ② 只截尾帧（不应该再多出一个首帧节点）
  await settle(2800); // 等回执自己消失，顺带确认它真的会消失
  check('成功回执 2.6s 后自己消失（不挡画面）', frameStatus() === null,
    frameStatus()?.textContent ?? '(gone)');
  await pick('last');
  await waitFor(() => statusText() === '已截取尾帧', 15000);
  check('点「截取尾帧」→ 只多出 1 个节点（另一侧空帧被跳过）', frameNodes().length === 3,
    String(frameNodes().length));
  check('第二次只要求取 last 一帧',
    JSON.stringify(captureCalls[1]?.roles) === JSON.stringify(['last']),
    JSON.stringify(captureCalls[1]?.roles));
  check('成功回执写的是「已截取尾帧」', statusText() === '已截取尾帧', statusText());

  // ③ 只截首帧
  await settle(2800);
  await pick('first');
  await waitFor(() => statusText() === '已截取首帧', 15000);
  check('点「截取首帧」→ 再多 1 个节点', frameNodes().length === 4, String(frameNodes().length));
  check('漏不出空帧节点（每个截帧节点都没报视频错误）',
    frameNodes().every((node) => !node.querySelector('[data-fisherai-video-error]')));
}

// 存盘后落到文档里的字段（位置 / 标题 / 提示词）
await settle(5200);
{
  const saved = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  const nodes = saved.json().nodes ?? [];
  const frames = nodes.filter((node) => ['视频首帧', '视频尾帧'].includes(node.title));
  check('存盘后截帧节点共 4 个（首尾帧 2 + 尾帧 1 + 首帧 1）', frames.length === 4,
    frames.map((node) => node.title).join(','));
  check('截帧节点都指向真实落盘图片（不是 data URL 留在文档里）',
    frames.every(
      (node) =>
        typeof node.resultUrl === 'string' &&
        node.resultUrl.startsWith(`/api/aifisher/canvas/media/${PROJECT_ID}/images/`),
    ),
    frames.map((node) => String(node.resultUrl).slice(-28)).join(','));
  check('截帧节点的 prompt 是空的（标题不会混进下游提示词）',
    frames.every((node) => node.prompt === ''), frames.map((node) => node.prompt).join('|'));
  check('截帧节点的父节点是源视频',
    frames.every((node) => JSON.stringify(node.parentIds) === JSON.stringify(['video-source'])),
    JSON.stringify(frames[0]?.parentIds));
  const both = frames.filter((node) => node.x === COLUMN_TWO);
  check('第一批两张落在第二列（第一列被挡路图占着）',
    both.length >= 2 && both.every((node) => node.x === COLUMN_TWO),
    frames.map((node) => `${node.title}@${node.x},${Math.round(node.y)}`).join(' | '));
  check('首帧在尾帧之上（同列、间距 = 帧高 + 40）',
    both.length >= 2 &&
      Math.abs(both.find((node) => node.title === '视频尾帧').y -
        both.find((node) => node.title === '视频首帧').y - (FRAME_HEIGHT + 40)) < 0.6,
    both.map((node) => `${node.title}@${Math.round(node.y)}`).join(' | '));
  const later = frames.filter((node) => node.x >= COLUMN_THREE);
  check('后来的单帧各自落到新的空列（1230 / 1655），没有叠在第一批上',
    later.length === 2 &&
      new Set(later.map((node) => node.x)).size === 2 &&
      later.every((node) => node.x > COLUMN_TWO) &&
      Math.abs(later[0].y - later[1].y) < 0.6,
    later.map((node) => `${node.title}@${node.x},${Math.round(node.y)}`).join(' | '));
  check('一张都没压到挡路图或源视频的矩形里',
    frames.every(
      (node) =>
        !(node.x < SOURCE_WIDTH && node.y < SOURCE_HEIGHT && node.x + 40 > 0) &&
        !(node.x < COLUMN_ONE + FRAME_WIDTH && node.x + FRAME_WIDTH > COLUMN_ONE && node.y < 65),
    ),
    frames.map((node) => `${node.x},${Math.round(node.y)}`).join(' | '));
}

// ---------------------------------------------------------------- C) 源码级接线
{
  const vendorMedia = readFileSync(
    join(ROOT, 'vendor/aifisher/src/stable/media/canvasMediaOperations.ts'),
    'utf8',
  );
  check('vendor：空帧被跳过（单截一帧不会造空节点）',
    vendorMedia.includes('const wanted = frames.filter(') && vendorMedia.includes('frame.data.length > 0'));
  check('vendor：位置问落位桥（不再写死 +400）',
    vendorMedia.includes('__FISHERAI_FRAME_LAYOUT__') && vendorMedia.includes('spots[index]?.x'));
  check('vendor：带 focus 的截帧把视口带过去',
    vendorMedia.includes('__FISHERAI_FOCUS_NODES__?.([sourceId, ...pending.map'));
  check('vendor：截帧节点 prompt 留空',
    vendorMedia.includes("prompt: '',"));
  // v1.67：远端素材必过 /proxy，代理不透传 Range 时浏览器把视频当"不可寻址"，尾帧永远取不到
  const mediaRouter = readFileSync(
    join(ROOT, 'src/host/canvas/mediaRouter.ts'),
    'utf8',
  );
  check('host 代理透传 Range（206 + Content-Range，远端视频才能 seek / 截尾帧）',
    mediaRouter.includes('req.headers.range') &&
      mediaRouter.includes("'content-range'") &&
      mediaRouter.includes('response.status === 206'));
  const player = readFileSync(
    join(ROOT, 'vendor/aifisher/src/stable/media/canvasVideoPlayer.tsx'),
    'utf8',
  );
  check('播放器：三项菜单 + 成功回执都在',
    player.includes('data-fisherai-video-frame-action') &&
      player.includes('首尾帧各一张') &&
      player.includes('已截取首尾帧'));
  const dev = readFileSync(join(ROOT, 'README.dev.md'), 'utf8');
  check('README.dev 记了这轮改动（v1.66 视频截帧 + 补丁 3.8x）',
    dev.includes('v1.66') && dev.includes('视频截帧') && dev.includes('3.8x'));
}

// ---------------------------------------------------------------- D) 渲染期没有运行时错误
{
  const diag = await host.hostApi('GET', '/diagnostics?limit=50');
  const errors = (diag.json().entries ?? []).filter((entry) => entry.level === 'error');
  check('整轮没有运行时错误（截帧没把画布弄崩）', errors.length === 0,
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
