/**
 * 「视频截帧」真机取证（v1.66）：在真 Chromium 里跑**构建产物里的** captureVideoFrames。
 *
 * 用户原话（2026-10-23）：「完善视频截取首尾帧功能」。
 *
 * 为什么不放进 browser-check：那一套用 `--virtual-time-budget` 控制退出时机，而截帧要
 * **真解码视频**（几百毫秒）再**真上传**（fetch）——解码期间虚拟时钟会被一路快进，
 * 函数内部的等待窗口直接假超时（实测：1.2s 后节点还没出现、until 全被烧完）。
 * 所以这里用**真时间**起一个 headless Chrome：
 *   ① 页面 import 构建产物 `lib/canvas/canvas-app.js`（就是画布用的那一份），
 *   ② 直接调 `captureVideoFrames`（不经过 UI），
 *   ③ 把返回的 data URL 画回 canvas 读像素 —— 证明首/尾帧真有画面、尺寸对、尾帧不是透明帧，
 *   ④ 顺手验 `frameTargetSize` 的 2048 上限与 `tailTimes` 的落点序列。
 *
 * 用法：node scripts/verify-video-frames.mjs   （需要先 build）
 * 退出码 0 = 全绿；1 = 有失败。
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VERIFY_FRAMES_PORT ?? 3212);
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('找不到 Chrome/Edge，跳过真机取证。');
  process.exit(0);
}
if (!existsSync(join(ROOT, 'lib/canvas/canvas-app.js'))) {
  console.error('lib/canvas/canvas-app.js 不存在，先 build。');
  process.exit(1);
}
/**
 * 用户报障的那段真片子（2026-10-23「截取视频首尾帧失败了」）：
 * 967×544 / 362.04s / 56.7MB / 23fps / 28 个关键帧，关键帧间隔 ~13s。
 * 只在本机存在时才跑（别的机器上跳过），路径可用 FRAME_REAL_VIDEO 覆盖。
 */
const REAL_VIDEO = process.env.FRAME_REAL_VIDEO
  ?? 'C:\\Users\\duyumingze\\.dsh\\storages\\dsh-aifisher-canvas\\media\\fabc7dd7-59cf-4042-9d6b-30eb7ba69e41\\videos\\media-a2442064.mp4';
const HAS_REAL = existsSync(REAL_VIDEO);

const PAGE = `<!doctype html><meta charset="utf-8"><body><pre id="out">pending</pre>
<script type="module">
const out = document.getElementById('out');
const REAL = ${HAS_REAL ? 'true' : 'false'};
const pixels = (dataUrl) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0, 4, 4);
      const data = context.getImageData(1, 1, 1, 1).data;
      resolve({ width: img.naturalWidth, height: img.naturalHeight, pixel: [data[0], data[1], data[2], data[3]] });
    };
    img.onerror = () => reject(new Error('frame image failed to decode'));
    img.src = dataUrl;
  });
(async () => {
  const result = {};
  try {
    const app = await import('/canvas/canvas-app.js');
    result.exported = typeof app.captureVideoFrames === 'function';
    const started = performance.now();
    const frames = await app.captureVideoFrames('/v/video-history-red.mp4', ['first', 'last']);
    result.totalMs = Math.round(performance.now() - started);
    result.frames = [];
    for (const frame of frames) {
      const probe = await pixels(frame.data);
      result.frames.push({ role: frame.role, time: frame.time, ...probe });
    }
    // 只截尾帧：不应该带回首帧
    const tail = await app.captureVideoFrames('/v/video-history-blue.mp4', ['last']);
    result.tailOnly = tail.length === 1 && tail[0].role === 'last';
    result.tailPixel = (await pixels(tail[0].data)).pixel;
    // 纯逻辑：上限与尾帧序列（外加 v1.67 的等待判定）
    result.callback = app.frameTargetSize(3840, 2160);
    result.tailTimes = app.tailTimes(10);
    result.seekLanded = [
      app.seekLanded({ currentTime: 361.99, readyState: 1, seeking: false }, 361.99),
      app.seekLanded({ currentTime: 362.24, readyState: 4, seeking: false }, 361.99),
    ];
    result.clamped = app.clampSeekTime({ seekable: { length: 1, start: () => 0, end: () => 20 } }, 361.99);
    // 用户报障的那段真片子（967x544 / 362s / 56MB）：必须能截出首尾帧，不能卡满超时
    if (REAL) {
      const t0 = performance.now();
      try {
        const real = await app.captureVideoFrames('/v/real.mp4', ['first', 'last'], undefined, { timeoutMs: 8000 });
        result.real = { ms: Math.round(performance.now() - t0), frames: [] };
        for (const frame of real) {
          const probe = await pixels(frame.data);
          result.real.frames.push({ role: frame.role, time: frame.time, ...probe });
        }
      } catch (error) {
        result.real = { ms: Math.round(performance.now() - t0), error: String((error && error.message) || error) };
      }
    }
  } catch (error) {
    result.error = String((error && error.stack) || error);
  }
  out.textContent = JSON.stringify(result, null, 2);
  await fetch('/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) }).catch(() => {});
})();
</script>`;

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/log') {
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/results') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      let results = null;
      try {
        results = JSON.parse(body);
      } catch {
        results = { error: 'results not json' };
      }
      finish(results);
    });
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    return;
  }
  if (url.pathname.startsWith('/v/')) {
    const name = url.pathname.slice(3);
    const fromFixtures = name !== 'real.mp4';
    const file = fromFixtures ? join(ROOT, 'scripts', 'fixtures', name) : REAL_VIDEO;
    if (!existsSync(file)) {
      res.writeHead(404).end('no video');
      return;
    }
    const size = statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
      const start = Number(startRaw) || 0;
      const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': size });
    createReadStream(file).pipe(res);
    return;
  }
  if (url.pathname.startsWith('/canvas/')) {
    const file = join(ROOT, 'lib', 'canvas', url.pathname.slice('/canvas/'.length));
    if (!existsSync(file)) {
      res.writeHead(404).end('no chunk');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404).end('nope');
});

let child = null;
let settled = false;
function finish(results) {
  if (settled) return;
  settled = true;
  const lines = [];
  let failures = 0;
  const check = (name, good, extra = '') => {
    if (!good) failures += 1;
    lines.push(`${good ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
  };
  check('真 Chromium 里 import 了构建产物并调到了 captureVideoFrames',
    results?.exported === true && !results?.error, String(results?.error ?? '').slice(0, 300));
  const frames = Array.isArray(results?.frames) ? results.frames : [];
  const first = frames.find((frame) => frame.role === 'first');
  const last = frames.find((frame) => frame.role === 'last');
  check('首帧 / 尾帧都截到了（两帧）', frames.length === 2 && !!first && !!last,
    JSON.stringify(frames.map((frame) => frame.role)));
  check('两帧都是 320×180（fixture 的真实尺寸，没有被放大）',
    first?.width === 320 && first?.height === 180 && last?.width === 320 && last?.height === 180,
    `${first?.width}x${first?.height} / ${last?.width}x${last?.height}`);
  check('首帧真有画面（红色 fixture：不透明且红通道最高）',
    Array.isArray(first?.pixel) && first.pixel[3] === 255 && first.pixel[0] > 150 &&
      first.pixel[0] >= first.pixel[2],
    JSON.stringify(first?.pixel));
  check('尾帧真有画面（不是透明帧 / 不是黑帧）',
    Array.isArray(last?.pixel) && last.pixel[3] === 255 &&
      last.pixel[0] + last.pixel[1] + last.pixel[2] > 30,
    JSON.stringify(last?.pixel));
  check('尾帧的取帧时间落在 duration - 0.05 上（与 lastFrame 同口径）',
    last?.time === 0.95, String(last?.time));
  check('只要求 last 时只返回一条（单帧不配多余的首帧）', results?.tailOnly === true,
    JSON.stringify(results?.tailOnly));
  check('蓝色 fixture 的尾帧是蓝色的（说明取的是那条片子而不是缓存旧帧）',
    Array.isArray(results?.tailPixel) && results.tailPixel[2] > 150 &&
      results.tailPixel[2] >= results.tailPixel[0],
    JSON.stringify(results?.tailPixel));
  check('frameTargetSize 把 4K 压到最长边 2048',
    results?.callback?.width === 2048 && results?.callback?.height === 1152,
    JSON.stringify(results?.callback));
  check('tailTimes(10) 是 9.95 / 9.8 / 9.5 / 8.8',
    JSON.stringify(results?.tailTimes) === JSON.stringify([9.95, 9.8, 9.5, 8.8]),
    JSON.stringify(results?.tailTimes));
  check('整轮取帧耗时在合理范围（< 8s）', Number(results?.totalMs ?? 99999) < 8000,
    `${results?.totalMs}ms`);
  /**
   * v1.67 加固：等待判定从「单次 seeked 快照」改成「事件唤醒 + 40ms 轮询」。
   * 这两条在真浏览器里直接验纯逻辑，防止以后又改回"事件来了看一眼就放弃"。
   */
  check('seek 落点判定：readyState=1 时不算到位、差 0.25s 算到位',
    JSON.stringify(results?.seekLanded) === JSON.stringify([false, true]),
    JSON.stringify(results?.seekLanded));
  check('seekable 只到 20s 时把片尾目标钳到 19.95s（不再硬等一个到不了的位置）',
    Math.abs(Number(results?.clamped) - 19.95) < 1e-6, String(results?.clamped));

  // ---- 用户报障的那段真片子 ----
  if (results?.real) {
    const realFrames = Array.isArray(results.real.frames) ? results.real.frames : [];
    const realFirst = realFrames.find((frame) => frame.role === 'first');
    const realLast = realFrames.find((frame) => frame.role === 'last');
    check('报障真片子（967×544 / 362s / 56.7MB）能截出首帧 + 尾帧',
      !results.real.error && realFrames.length === 2 && !!realFirst && !!realLast,
      String(results.real.error ?? JSON.stringify(realFrames.map((frame) => frame.role))).slice(0, 300));
    check('报障真片子：两帧都是原尺寸（967×544，没有被放大/压扁）',
      realFirst?.width === 967 && realFirst?.height === 544 &&
        realLast?.width === 967 && realLast?.height === 544,
      `${realFirst?.width}x${realFirst?.height} / ${realLast?.width}x${realLast?.height}`);
    check('报障真片子：尾帧落在 duration - 0.05 上（361.99s）',
      Math.abs(Number(realLast?.time) - 361.993) < 0.06, String(realLast?.time));
    check('报障真片子：尾帧不是透明帧 / 黑帧（探针像素不透明）',
      Array.isArray(realLast?.pixel) && realLast.pixel[3] === 255, JSON.stringify(realLast?.pixel));
    check('报障真片子：整轮耗时 < 8s（不再卡满 15s 报"视频定位超时"）',
      Number(results.real.ms ?? 99999) < 8000, `${results.real.ms}ms`);
  } else {
    lines.push('SKIP  本机没有那段 56MB 报障片段，跳过真片子取证');
  }
  lines.push('');
  lines.push(`SUMMARY pass=${lines.filter((line) => line.startsWith('PASS')).length} fail=${failures}`);
  console.log(lines.join('\n'));
  child?.kill();
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

server.listen(PORT, '127.0.0.1', () => {
  child = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${join(ROOT, '.dsh-tmp', 'verify-frames-profile')}`,
      `http://127.0.0.1:${PORT}/`,
    ],
    { stdio: 'ignore' },
  );
  setTimeout(() => {
    if (settled) return;
    console.log('FAIL  页面 180s 内没有回传结果（Chrome 没启动/页面报错）');
    console.log('\nSUMMARY pass=0 fail=1');
    child?.kill();
    server.close();
    process.exit(1);
  }, 180_000).unref();
});
