/**
 * 「视频下方进度条」回归（v1.68）。
 *
 * 用户报障原话（2026-10-23）：「视频下方进度条拖到不了」。
 *
 * 真机取证（真 Chromium + 他本人那份 canvas.json + 967×544 / 362s / 56MB 的片子）：
 * 原生 `input[type=range]` 的拖动能走完（10% → 99% 落到 362.04s），所以坏的不是 seek 链路，
 * 是那根**16px 高、带半个拇指内缩、还依赖原生拖动**的滑杆。v1.68 把它换成自己吃指针的拖拽：
 *   · 整条轨道（20px 高 + 上下余量）按下即跳到落点，不再要求"戳中 12px 的拇指"；
 *   · 拖动期间读数/拇指 1:1 跟指针（本地 scrub 状态，播放时钟的回写不再把拇指拽回去）；
 *   · seek 按 120ms 节流、松手补最后一发（长片里 60Hz 连打会打乱解码器）；
 *   · 松手后真在寻址时显示「定位中…」；
 *   · 底栏收起时 `pointer-events-none`，不再吞掉视频底部的点击。
 *
 * 这个套件守的正是这五条（jsdom 真 DOM + 桩掉 media 元素的时长/位置）。
 *
 * 用法：node scripts/test-canvas-video-seek.mjs   （需要先 build）
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

const PROJECT_ID = 'proj-canvas-video-seek';
const DURATION = 200;
const VIDEO_URL = `/api/aifisher/canvas/media/${PROJECT_ID}/videos/seek.mp4`;

const host = await startHost();
{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '进度条拖拽验证',
    nodes: [
      {
        id: 'seek-video',
        type: 'Video',
        x: 80,
        y: 80,
        title: '长片（200s）',
        prompt: '',
        status: 'success',
        model: 'Seedance 2.5 Standard · API',
        videoModel: 'Seedance 2.5 Standard · API',
        resultUrl: VIDEO_URL,
        resultUrls: [VIDEO_URL],
        currentResultCount: 1,
        resultAspectRatio: '967/544',
        aspectRatio: '16:9',
        parentIds: [],
        projectId: PROJECT_ID,
      },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置「一段 200s 视频」的项目', save.status === 200, String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
await mountCanvasApp(window);
await settle(1200);
const doc = window.document;

const frame = await waitFor(() => doc.querySelector('[data-node-id="seek-video"]'));
check('画布上渲染出视频节点', !!frame);

/**
 * jsdom 没有媒体引擎：时长恒 NaN、currentTime 的写入也不会真寻址。
 * 这里把这三样桩掉，**记录每一次 currentTime 写入**（= 组件真正下发的 seek 次数与落点）。
 */
const media = { currentTime: 0, seeking: false, writes: [] };
const video = frame?.querySelector('video');
if (video) {
  Object.defineProperty(video, 'duration', { configurable: true, get: () => DURATION });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
  Object.defineProperty(video, 'seeking', { configurable: true, get: () => media.seeking });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => media.currentTime,
    set: (value) => {
      media.writes.push(Math.round(value * 1000) / 1000);
      media.currentTime = value;
    },
  });
  video.dispatchEvent(new window.Event('loadedmetadata'));
}
await settle(120);

const track = () => frame?.querySelector('[data-fisherai-video-seek-track="true"]') ?? null;
const range = () => frame?.querySelector('[data-fisherai-video-seek="true"]') ?? null;
const bar = () => frame?.querySelector('[data-fisherai-video-bar="true"]') ?? null;
const pending = () => frame?.querySelector('[data-fisherai-video-seek-pending="true"]') ?? null;

// jsdom 没有布局：轨道给一个 200×20 的假矩形（左边 0，所以 clientX 直接就是比例×200）
if (track()) {
  track().getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20,
    toJSON() { return {}; },
  });
}

check('底栏有「进度条轨道」这个新契约（data-fisherai-video-seek-track）', !!track());
check('原生 range 还在（键盘/无障碍要用），但已经 pointer-events-none',
  !!range() && String(range().className).includes('pointer-events-none'),
  String(range()?.className ?? '(missing)').slice(0, 60));
check('range 的 max 跟着真实时长（200）', Number(range()?.max) === DURATION, String(range()?.max));

/**
 * 指针事件：合成 MouseEvent 挂 pointer 的类型（jsdom 没有 PointerEvent）。
 * buttons=1 是"按住"的语义 —— 组件靠它识别"松手事件被别的层吃掉"。
 */
const pointer = (target, type, clientX, buttons = 1) => {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 10,
    button: 0,
    buttons,
  });
  target.dispatchEvent(event);
  return event;
};

// ---------------------------------------------------------------- 1) 按下即跳（不要求戳中拇指）
{
  media.writes.length = 0;
  pointer(track(), 'pointerdown', 100); // 50%
  await settle(40);
  check('按下轨道中间：立刻 seek 到 50%（100s）',
    Math.abs((media.writes.at(-1) ?? -1) - 100) < 0.5, JSON.stringify(media.writes));
  check('按下后读数跟到 1:40（拖动中拇指跟指针，不跟播放时钟）',
    String(range()?.value) === '100' || Math.abs(Number(range()?.value) - 100) < 0.5,
    String(range()?.value));
}

// ---------------------------------------------------------------- 2) 拖动节流 + 期间不被播放时钟拽回
{
  const before = media.writes.length;
  for (let step = 1; step <= 5; step += 1) pointer(track(), 'pointermove', 100 + step * 10);
  await settle(30);
  const commits = media.writes.length - before;
  check('连续 5 次 pointermove 不会打 5 次 seek（120ms 节流）', commits <= 2,
    `commits=${commits} writes=${JSON.stringify(media.writes)}`);
  check('拖动中读数仍是最后一个指针位置（150 → 75%）',
    Math.abs(Number(range()?.value) - 150) < 0.5, String(range()?.value));

  // 播放时钟回写：把元素位置改到别处再抛一次 timeupdate —— 拇指不许跳回去
  media.currentTime = 12;
  video.dispatchEvent(new window.Event('timeupdate'));
  await settle(30);
  check('拖动中 timeupdate 回写不会把拇指拽回（读数还在 150）',
    Math.abs(Number(range()?.value) - 150) < 0.5, String(range()?.value));
}

// ---------------------------------------------------------------- 3) 松手补最后一发 + 落点准
{
  media.writes.length = 0;
  media.seeking = false;
  pointer(track(), 'pointerup', 199, 0); // 99.5%
  await settle(40);
  const last = media.writes.at(-1) ?? -1;
  check('松手时补一发 seed 到松手位置（199s，误差 < 0.5s）', Math.abs(last - 199) < 0.5,
    JSON.stringify(media.writes));
  check('松手用的是**拖动后的真实位置**，不是前面节流丢下的那个',
    Math.abs(Number(range()?.value) - 199) < 0.5, String(range()?.value));
}

// ---------------------------------------------------------------- 4) 「定位中…」只在真寻址时出现
{
  media.seeking = true;
  media.currentTime = 0; // 离目标很远 = 还在解码
  media.writes.length = 0;
  pointer(track(), 'pointerdown', 20);
  pointer(track(), 'pointerup', 20, 0);
  await settle(240);
  check('松手后还在寻址 → 显示「定位中…」', !!pending(),
    (pending()?.textContent ?? '(missing)').trim());

  media.seeking = false;
  media.currentTime = 20;
  await settle(420);
  check('落到位（不再寻址且落点对上）→「定位中…」自己收掉', !pending(),
    pending()?.textContent ?? '');
}

// ---------------------------------------------------------------- 5) 底栏收起时不吞点击
{
  check('底栏收起时带 pointer-events-none（不再吃掉视频底部的点击）',
    String(bar()?.className ?? '').includes('pointer-events-none'),
    String(bar()?.className ?? '(missing)').slice(0, 80));
  const videoEl = frame?.querySelector('video');
  if (videoEl) videoEl.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await settle(60);
  check('悬停到视频上 → 底栏浮出来（不再 pointer-events-none）',
    bar() && !String(bar().className).includes('pointer-events-none'),
    String(bar()?.className ?? '(missing)').slice(0, 80));
}

// ---------------------------------------------------------------- 6) 产物 / 补丁源里真的接线了
{
  const player = readFileSync(join(ROOT, 'vendor/aifisher/src/stable/media/canvasVideoPlayer.tsx'), 'utf8');
  const patch = readFileSync(join(ROOT, 'scripts/patches/aifisher/src/stable/media/canvasVideoPlayer.tsx'), 'utf8');
  check('vendor 播放器有整条轨道（data-fisherai-video-seek-track）',
    player.includes('data-fisherai-video-seek-track'));
  check('vendor 播放器有 120ms 节流常量与「定位中」',
    player.includes('SCRUB_SEEK_INTERVAL_MS = 120') && player.includes('定位中'));
  check('补丁源（scripts/patches）与 vendor 一致（重建不会被冲掉）',
    player === patch, `${player.length} vs ${patch.length}`);
}

lines.push('');
lines.push(`SUMMARY pass=${lines.filter((line) => line.startsWith('PASS')).length} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
