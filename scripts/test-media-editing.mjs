/**
 * 媒体加工（ffmpeg）回归测试。
 *
 * 覆盖 src/host/canvas/mediaEditingRouter.ts + src/host/media/ffmpeg.ts 的全部端点：
 *   缩略图（图片/视频）、图片裁切、宫格切分、视频抽帧、视频裁剪、音频裁剪、
 *   编辑记录读写、图片标注（dataURL 落盘）。
 *
 * 做法：
 *   1. 先用 ffmpeg 的 lavfi 造真素材（1 秒 testsrc+sine 视频、200x100 的 PNG、1 秒 sine 的 mp3）；
 *   2. startHost() 起假宿主 → 走 POST /assets/import/<type> 把本机文件导进素材库（省掉原始 body 上传）；
 *   3. 对每个端点真发请求，并用 ffmpeg 独立探测产物（时长/分辨率）——不复用 host 的解析代码；
 *   4. 另外 fork 一个 `--ffmpeg-off` 子进程，验证「本机没有 ffmpeg」时端点回 503 FFMPEG_UNAVAILABLE。
 *
 * 用法：node scripts/test-media-editing.mjs   （需要先 build）
 * 数据落在临时 DSH_HOME 下，不会碰真实画布数据。
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ORIGIN, startHost } from './lib/canvas-harness.mjs';

const FFMPEG_OFF = process.argv.includes('--ffmpeg-off');
const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}

// ---------------------------------------------------------------- ffmpeg 探测（测试自己找，顺序同插件）

function findFfmpeg() {
  const override = process.env.DSH_AIFISHER_FFMPEG?.trim();
  if (override && !['off', 'none', 'disabled'].includes(override.toLowerCase()) && existsSync(override)) {
    return override;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (existsSync(candidate)) return candidate;
  }
  const roots = process.env.DSH_AIFISHER_COMFY_ROOT
    ? [process.env.DSH_AIFISHER_COMFY_ROOT]
    : // 本机整合包从 E: 挪到 G: 过，两个都试（顺序 = 优先 G:）
      ['G:\\ComfyUI-aki-v3.2-duyumingze', 'E:\\ComfyUI-aki-v3.2-duyumingze'];
  for (const root of roots) {
    const binaries = join(root, 'python', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
    try {
      const hit = readdirSync(binaries)
        .filter((name) => /^ffmpeg.*\.exe$/i.test(name))
        .sort()
        .pop();
      if (hit) return join(binaries, hit);
    } catch {
      /* 这个根目录下没有整合包 */
    }
  }
  return null;
}

function run(binary, args, tolerateFailure = false) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !tolerateFailure) {
          reject(new Error(`${error.message}\n${String(stderr).slice(-400)}`));
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/** 独立实现一份 `ffmpeg -i` 解析（不 import 插件代码，避免自证）。 */
async function probe(binary, file) {
  const { stderr } = await run(binary, ['-hide_banner', '-i', file], true);
  const durationMatch = /Duration:\s*(\d+):(\d{2}):(\d+(?:\.\d+)?)/.exec(stderr);
  const streamLines = stderr.split(/\r?\n/).filter((line) => /Stream #\d+:\d+/.test(line));
  const videoLine = streamLines.find((line) => /:\s*Video:/.test(line));
  const sizeMatch = videoLine ? /,\s*(\d{2,5})x(\d{2,5})(?=[\s,\[])/.exec(videoLine) : null;
  return {
    duration: durationMatch
      ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
      : null,
    width: sizeMatch ? Number(sizeMatch[1]) : null,
    height: sizeMatch ? Number(sizeMatch[2]) : null,
    hasVideo: Boolean(videoLine),
    hasAudio: streamLines.some((line) => /:\s*Audio:/.test(line)),
  };
}

// ---------------------------------------------------------------- 造素材

const workDir = mkdtempSync(join(tmpdir(), 'dsh-media-edit-'));

async function makeFixtures(binary) {
  const video = join(workDir, 'testsrc.mp4');
  const png = join(workDir, 'pattern.png');
  const mp3 = join(workDir, 'tone.mp3');
  try {
    await run(binary, [
      '-y', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      video,
    ]);
  } catch {
    // 没有 libx264 的 build 退回 mpeg4
    await run(binary, [
      '-y', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      video,
    ]);
  }
  await run(binary, [
    '-y', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=200x100:rate=1',
    '-frames:v', '1',
    png,
  ]);
  try {
    await run(binary, ['-y', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-q:a', '2', mp3]);
  } catch {
    await run(binary, ['-y', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', mp3]);
  }
  return { video, png, mp3 };
}

// ---------------------------------------------------------------- 假 req / res（原始 body / 二进制响应）

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
  text() {
    return this.buffer().toString('utf8');
  }
}

let host = null;

async function dispatchRaw(method, pathname, payload, headers = {}) {
  let route = null;
  for (const [prefix, candidate] of host.routes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      if (!route || prefix.length > route.prefix.length) route = { prefix, handler: candidate.handler };
    }
  }
  if (!route) return { statusCode: 404, headers: {}, buffer: () => Buffer.alloc(0), text: () => '' };
  const req = Readable.from(payload === undefined ? [] : [payload]);
  req.method = method;
  req.url = pathname;
  req.headers = { host: new URL(ORIGIN).host, origin: ORIGIN, ...headers };
  const res = new FakeResponse();
  await route.handler(req, res);
  if (!res.writableFinished) await new Promise((done) => res.once('finish', done));
  return res;
}

/** 画布命名空间下的原始请求（GET 二进制 / 自定义头用）；已经带前缀的 URL 直接用。 */
const raw = (method, path, payload, headers) =>
  dispatchRaw(method, path.startsWith('/api/') ? path : `/api/aifisher/canvas${path}`, payload, headers);

/** 画布命名空间下的 JSON 请求。 */
async function api(method, path, body) {
  const res = await host.hostApi(method, path, body);
  let parsed = null;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text: res.text };
}

// ---------------------------------------------------------------- ffmpeg-off 子进程模式

if (FFMPEG_OFF) {
  // 这个模式只验证「本机没有 ffmpeg」时的降级路径：所有依赖 ffmpeg 的端点必须是 503 + FFMPEG_UNAVAILABLE
  process.env.DSH_AIFISHER_FFMPEG = 'off';
  const offHost = await startHost();
  host = offHost;

  const offPngPath = join(workDir, 'off.png');
  const offPngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  writeFileSync(offPngPath, offPngBytes);
  // 视频/音频只需要「类型对得上」：ffmpeg 不可用时报错发生在解析素材之前，
  // 素材内容是什么无所谓（这里直接复用同一份字节，只换文件名）。
  writeFileSync(join(workDir, 'off.mp4'), offPngBytes);
  writeFileSync(join(workDir, 'off.mp3'), offPngBytes);

  async function importOff(type, filename) {
    const res = await raw(
      'POST',
      `/assets/import/${type}`,
      Buffer.from(JSON.stringify({ path: join(workDir, filename), projectId: 'off-proj', filename })),
      { 'content-type': 'application/json' },
    );
    return JSON.parse(res.text())?.url ?? '';
  }
  const offImage = await importOff('images', 'off.png');
  const offVideo = await importOff('videos', 'off.mp4');
  const offAudio = await importOff('audios', 'off.mp3');
  check('off 子进程：素材导入成功（后续 503 断言才有意义）', Boolean(offImage && offVideo && offAudio), `${offImage}`);

  const cases = [
    ['缩略图', 'GET', `/media/thumbnail?url=${encodeURIComponent(offImage)}&max=64`, null],
    ['图片裁切', 'POST', '/media/images/crop', { projectId: 'off-proj', imageUrl: offImage, rect: { x: 0, y: 0, width: 1, height: 1 } }],
    ['宫格切分', 'POST', '/media/images/grid', { projectId: 'off-proj', imageUrl: offImage, columns: 2, rows: 2 }],
    ['视频抽帧', 'POST', '/media/videos/frames', { projectId: 'off-proj', videoUrl: offVideo, times: [0] }],
    ['视频裁剪', 'POST', '/trim-video', { projectId: 'off-proj', videoUrl: offVideo, startTime: 0, endTime: 1 }],
    ['音频裁剪', 'POST', '/trim-audio', { projectId: 'off-proj', audioUrl: offAudio, startTime: 0, endTime: 1 }],
  ];
  for (const [label, method, path, body] of cases) {
    const result =
      method === 'GET' ? await raw('GET', path) : await raw('POST', path, Buffer.from(JSON.stringify(body)));
    let parsed = null;
    try {
      parsed = JSON.parse(result.text());
    } catch {
      parsed = null;
    }
    check(
      `没有 ffmpeg 时「${label}」回 503 FFMPEG_UNAVAILABLE`,
      result.statusCode === 503 && parsed?.code === 'FFMPEG_UNAVAILABLE',
      `${result.statusCode} ${result.text().slice(0, 120)}`,
    );
  }
  // 不依赖 ffmpeg 的端点仍然要能用
  const annotation = await raw(
    'POST',
    '/media/images/annotation',
    Buffer.from(
      JSON.stringify({
        projectId: 'off-proj',
        dataUrl: `data:image/png;base64,${readFileSync(offPngPath).toString('base64')}`,
      }),
    ),
  );
  check('没有 ffmpeg 时图片标注（纯落盘）仍然可用', annotation.statusCode === 201, String(annotation.statusCode));

  const pass = lines.filter((line) => line.startsWith('PASS')).length;
  console.log(lines.join('\n'));
  console.log(`\nSUMMARY pass=${pass} fail=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- 主流程

const ffmpeg = findFfmpeg();
check('本机找到 ffmpeg（测试前置条件）', Boolean(ffmpeg), ffmpeg ?? 'not-found');
if (!ffmpeg) {
  console.log(lines.join('\n'));
  console.log(`\nSUMMARY pass=${lines.filter((l) => l.startsWith('PASS')).length} fail=${failures}`);
  process.exit(1);
}

const { video, png, mp3 } = await makeFixtures(ffmpeg);
const videoInfo = await probe(ffmpeg, video);
check(
  '测试素材：1 秒 320x240 带音轨的视频',
  videoInfo.hasVideo && videoInfo.hasAudio && videoInfo.width === 320 && videoInfo.height === 240 && videoInfo.duration > 0.8,
  JSON.stringify(videoInfo),
);

host = await startHost();

const projectId = 'proj-media-1';
const otherProject = 'proj-media-other';

async function importAsset(type, path, filename, project = projectId) {
  const res = await api('POST', `/assets/import/${type}`, { path, projectId: project, filename });
  return res.status === 200 ? res.body?.url : null;
}

const imageUrl = await importAsset('images', png, 'pattern.png');
const videoUrl = await importAsset('videos', video, 'testsrc.mp4');
const audioUrl = await importAsset('audios', mp3, 'tone.mp3');
const otherImageUrl = await importAsset('images', png, 'other.png', otherProject);
check('素材导入成功（图片/视频/音频）', Boolean(imageUrl && videoUrl && audioUrl), `${imageUrl} | ${videoUrl} | ${audioUrl}`);

/** 把响应字节落到临时文件，交给 ffmpeg 独立探测。 */
async function probeResponse(label, response) {
  const file = join(workDir, `out-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  writeFileSync(file, response.buffer());
  return { file, info: await probe(ffmpeg, file) };
}

// ---------------------------------------------------------------- 1. 缩略图

{
  const thumb = await raw('GET', `/media/thumbnail?url=${encodeURIComponent(imageUrl)}&max=64`);
  check('图片缩略图返回 200', thumb.statusCode === 200, `${thumb.statusCode} ${thumb.text().slice(0, 120)}`);
  check('缩略图 MIME 是图片', String(thumb.headers['content-type'] ?? '').startsWith('image/'), String(thumb.headers['content-type']));
  check('缩略图字节非空', thumb.buffer().length > 0, `${thumb.buffer().length}B`);
  const { info } = await probeResponse('thumb-image', thumb);
  check(
    '图片缩略图按 max 等比缩小（200x100 塞进 128 边界 → 128x64）',
    info.width === 128 && info.height === 64,
    JSON.stringify(info),
  );
  const clampedThumb = await raw('GET', `/media/thumbnail?url=${encodeURIComponent(imageUrl)}&max=1`);
  const clampedInfo = (await probeResponse('thumb-clamped', clampedThumb)).info;
  check(
    'max 低于 128 被钳到 128（照抄上游 normalizeMaxSize）',
    clampedThumb.statusCode === 200 && clampedInfo.width === 128,
    JSON.stringify(clampedInfo),
  );

  const again = await raw('GET', `/media/thumbnail?url=${encodeURIComponent(imageUrl)}&max=64`);
  check(
    '缩略图命中缓存（两次字节完全一致）',
    again.statusCode === 200 && Buffer.compare(again.buffer(), thumb.buffer()) === 0,
    `${thumb.buffer().length}B vs ${again.buffer().length}B`,
  );

  const videoThumb = await raw('GET', `/media/thumbnail?url=${encodeURIComponent(videoUrl)}&max=200`);
  check('视频缩略图返回 200（上游只支持图片）', videoThumb.statusCode === 200, `${videoThumb.statusCode} ${videoThumb.text().slice(0, 120)}`);
  const videoThumbInfo = await probeResponse('thumb-video', videoThumb);
  check(
    '视频缩略图取到第一帧且等比缩放（320x240 → 200x150）',
    videoThumbInfo.info.hasVideo && videoThumbInfo.info.width === 200 && videoThumbInfo.info.height === 150,
    JSON.stringify(videoThumbInfo.info),
  );

  const notFound = await raw('GET', `/media/thumbnail?url=${encodeURIComponent(`/api/aifisher/canvas/media/${projectId}/images/nope.png`)}&max=64`);
  check('缩略图：素材不存在 → 404 MEDIA_NOT_FOUND', notFound.statusCode === 404 && JSON.parse(notFound.text()).code === 'MEDIA_NOT_FOUND', `${notFound.statusCode} ${notFound.text().slice(0, 120)}`);

  // 安全：任意本机路径必须被拒（这个端点不能被当成文件读取器）
  const localPath = await raw('GET', `/media/thumbnail?url=${encodeURIComponent('C:\\Windows\\win.ini')}&max=64`);
  check('缩略图：拒绝任意本机路径 → 422 INVALID_MEDIA_URL', localPath.statusCode === 422 && JSON.parse(localPath.text()).code === 'INVALID_MEDIA_URL', `${localPath.statusCode} ${localPath.text().slice(0, 120)}`);
  const fileUrl = await raw('GET', `/media/thumbnail?url=${encodeURIComponent('file:///C:/Windows/win.ini')}`);
  check('缩略图：拒绝 file:// → 422', fileUrl.statusCode === 422, `${fileUrl.statusCode}`);

  const audioThumb = await raw('GET', `/media/thumbnail?url=${encodeURIComponent(audioUrl)}&max=64`);
  check('缩略图：音频素材 → 415', audioThumb.statusCode === 415, `${audioThumb.statusCode}`);

  // 上游前端（stableMediaDomAdapter / projectDashboardChrome）拼的是 /library/media/... 形状，
  // 移植版虽然把素材放在 /api/aifisher/canvas/media/ 下，这两种形状都要认
  const libraryShape = `/library/media/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageUrl.split('/').pop())}`;
  const legacyThumb = await raw('GET', `/media/thumbnail?url=${encodeURIComponent(libraryShape)}&max=200`);
  check('缩略图也认上游的 /library/media/... 素材形状', legacyThumb.statusCode === 200 && legacyThumb.buffer().length > 0, `${legacyThumb.statusCode} ${legacyThumb.text().slice(0, 100)}`);

  const noUrl = await raw('GET', '/media/thumbnail?max=64');
  check('缩略图缺 url 参数 → 422', noUrl.statusCode === 422, `${noUrl.statusCode}`);
}

// ---------------------------------------------------------------- 2. 图片裁切

{
  const crop = await api('POST', '/media/images/crop', {
    projectId,
    imageUrl,
    rect: { x: 10, y: 20, width: 80, height: 40 },
  });
  check('图片裁切返回 201', crop.status === 201, `${crop.status} ${crop.text.slice(0, 160)}`);
  check('裁切返回 { success, asset.url }', crop.body?.success === true && typeof crop.body?.asset?.url === 'string');
  const croppedUrl = crop.body?.asset?.url ?? '';
  check('裁切产物 url 在素材库命名空间下', croppedUrl.startsWith(`/api/aifisher/canvas/media/${projectId}/images/`), croppedUrl);
  check(
    '裁切产物记录了 cropRect/operation/sourceUrl',
    JSON.stringify(crop.body?.asset?.cropRect) === JSON.stringify({ x: 10, y: 20, width: 80, height: 40 }) &&
      crop.body?.asset?.operation === 'crop' &&
      crop.body?.asset?.sourceUrl === imageUrl,
    JSON.stringify({ rect: crop.body?.asset?.cropRect, op: crop.body?.asset?.operation }),
  );

  const fetched = await raw('GET', croppedUrl);
  check('裁切产物能 GET 到且非空', fetched.statusCode === 200 && fetched.buffer().length > 0, `${fetched.statusCode} ${fetched.buffer().length}B`);
  check('裁切产物 MIME 是 image/png', fetched.headers['content-type'] === 'image/png', String(fetched.headers['content-type']));
  const { info } = await probeResponse('crop', fetched);
  check('裁切产物尺寸就是请求的 80x40', info.width === 80 && info.height === 40, JSON.stringify(info));

  const tooBig = await api('POST', '/media/images/crop', {
    projectId,
    imageUrl,
    rect: { x: 150, y: 0, width: 80, height: 40 },
  });
  check('裁切区域超出图片范围 → 400', tooBig.status === 400, `${tooBig.status} ${tooBig.text.slice(0, 120)}`);

  const negative = await api('POST', '/media/images/crop', { projectId, imageUrl, rect: { x: -1, y: 0, width: 10, height: 10 } });
  check('裁切参数为负 → 400', negative.status === 400, String(negative.status));

  const wrongKind = await api('POST', '/media/images/crop', { projectId, imageUrl: videoUrl, rect: { x: 0, y: 0, width: 10, height: 10 } });
  check('拿视频当图片裁 → 415', wrongKind.status === 415, `${wrongKind.status}`);

  const crossProject = await api('POST', '/media/images/crop', {
    projectId,
    imageUrl: otherImageUrl,
    rect: { x: 0, y: 0, width: 10, height: 10 },
  });
  check('跨项目素材 → 403 CROSS_PROJECT_MEDIA', crossProject.status === 403 && crossProject.body?.code === 'CROSS_PROJECT_MEDIA', `${crossProject.status} ${crossProject.text.slice(0, 120)}`);

  const arbitraryPath = await api('POST', '/media/images/crop', { projectId, imageUrl: 'D:\\secret.png', rect: { x: 0, y: 0, width: 1, height: 1 } });
  check('裁切：任意本机路径 → 422', arbitraryPath.status === 422 && arbitraryPath.body?.code === 'INVALID_MEDIA_URL', `${arbitraryPath.status}`);

  // v1.32：画布的结果 URL 带缓存戳（`?t=<毫秒>`，vendor withTimestamp() 加的，给 <img> 破缓存）；
  // 它同时是「编辑/裁剪这张刚生成的图」的入参，解析时必须把查询串摘掉（以前 ?t= 会被算进文件名）。
  const stampedCrop = await api('POST', '/media/images/crop', {
    projectId,
    imageUrl: `${imageUrl}?t=1792243183952`,
    rect: { x: 10, y: 20, width: 80, height: 40 },
  });
  check(
    '裁切：带缓存戳（?t=…）的素材 URL 照样认（画布的结果 URL 就长这样）',
    stampedCrop.status === 201 &&
      String(stampedCrop.body?.asset?.url).startsWith(`/api/aifisher/canvas/media/${projectId}/images/`),
    `${stampedCrop.status} ${stampedCrop.text.slice(0, 160)}`,
  );
}

// ---------------------------------------------------------------- 3. 宫格切分

{
  const grid = await api('POST', '/media/images/grid', { projectId, imageUrl, columns: 2, rows: 2 });
  check('宫格切分返回 201', grid.status === 201, `${grid.status} ${grid.text.slice(0, 160)}`);
  check('宫格返回 { success, assets }', grid.body?.success === true && Array.isArray(grid.body?.assets), String(grid.body?.assets?.length));
  check('2x2 切出 4 块', grid.body?.assets?.length === 4, String(grid.body?.assets?.length));

  const sizes = [];
  for (const [index, asset] of (grid.body?.assets ?? []).entries()) {
    const fetched = await raw('GET', asset.url);
    const { info } = await probeResponse(`grid-${index}`, fetched);
    sizes.push(`${info.width}x${info.height}`);
    if (index === 0) {
      check(
        '宫格块带 gridRow/gridColumn/gridRows/gridColumns 元数据',
        asset.gridRow === 0 && asset.gridColumn === 0 && asset.gridRows === 2 && asset.gridColumns === 2,
        JSON.stringify({ r: asset.gridRow, c: asset.gridColumn }),
      );
    }
  }
  check('每块尺寸是 100x50（200x100 均分）', sizes.every((size) => size === '100x50'), sizes.join(','));

  const tooMany = await api('POST', '/media/images/grid', { projectId, imageUrl, columns: 11, rows: 1 });
  check('宫格列数超限 → 400', tooMany.status === 400, String(tooMany.status));

  const badGuides = await api('POST', '/media/images/grid', { projectId, imageUrl, columns: 2, rows: 1, columnGuides: [0.9, 0.1] });
  check('列分割线不递增 → 400', badGuides.status === 400, String(badGuides.status));

  const customGuides = await api('POST', '/media/images/grid', { projectId, imageUrl, columns: 2, rows: 1, columnGuides: [0.25] });
  const firstCell = customGuides.body?.assets?.[0];
  if (firstCell) {
    const fetched = await raw('GET', firstCell.url);
    const { info } = await probeResponse('grid-custom', fetched);
    check('自定义分割线生效（0.25 → 50x100）', info.width === 50 && info.height === 100, JSON.stringify(info));
  } else {
    check('自定义分割线生效（0.25 → 50x100）', false, customGuides.text.slice(0, 120));
  }
}

// ---------------------------------------------------------------- 4. 视频抽帧

{
  const frames = await api('POST', '/media/videos/frames', {
    projectId,
    videoUrl,
    times: [0, 0.5],
    roles: ['first', 'screenshot'],
  });
  check('抽帧返回 201', frames.status === 201, `${frames.status} ${frames.text.slice(0, 160)}`);
  check('抽帧返回 { success, assets }', frames.body?.success === true && Array.isArray(frames.body?.assets), String(frames.body?.assets?.length));
  check('抽 2 帧得到 2 个产物', frames.body?.assets?.length === 2, String(frames.body?.assets?.length));
  check(
    '帧产物记录 frameTime/frameRole',
    frames.body?.assets?.[0]?.frameTime === 0 && frames.body?.assets?.[0]?.frameRole === 'first' && frames.body?.assets?.[1]?.frameRole === 'screenshot',
    JSON.stringify(frames.body?.assets?.map((a) => [a.frameTime, a.frameRole])),
  );

  const dims = [];
  for (const [index, asset] of (frames.body?.assets ?? []).entries()) {
    const fetched = await raw('GET', asset.url);
    const { info } = await probeResponse(`frame-${index}`, fetched);
    dims.push(`${info.width}x${info.height}`);
  }
  check('帧产物是原分辨率图片（320x240）', dims.every((size) => size === '320x240'), dims.join(','));

  const empty = await api('POST', '/media/videos/frames', { projectId, videoUrl, times: [] });
  check('抽帧 times 为空 → 400', empty.status === 400, String(empty.status));

  const beyond = await api('POST', '/media/videos/frames', { projectId, videoUrl, times: [99] });
  check('抽帧时间超出素材时长 → 400', beyond.status === 400, `${beyond.status} ${beyond.text.slice(0, 120)}`);

  const many = await api('POST', '/media/videos/frames', { projectId, videoUrl, times: Array.from({ length: 21 }, (_, i) => i * 0.01) });
  check('抽帧超过 20 帧 → 400', many.status === 400, String(many.status));

  const absurd = await api('POST', '/media/videos/frames', { projectId, videoUrl, times: [1e21] });
  check('抽帧时间离谱（1e21）→ 400（不会把怪参数拼给 ffmpeg）', absurd.status === 400, `${absurd.status}`);
}

// ---------------------------------------------------------------- 5. 视频裁剪

{
  const trimmed = await api('POST', '/trim-video', { projectId, videoUrl, startTime: 0.1, endTime: 0.6 });
  check('视频裁剪返回 200', trimmed.status === 200, `${trimmed.status} ${trimmed.text.slice(0, 160)}`);
  check('裁剪返回 { success, url, filename, duration, asset }', trimmed.body?.success === true && typeof trimmed.body?.url === 'string' && typeof trimmed.body?.filename === 'string' && typeof trimmed.body?.duration === 'number', JSON.stringify({ url: trimmed.body?.url, duration: trimmed.body?.duration }));
  check('裁剪产物 url 在 videos 目录下', String(trimmed.body?.url ?? '').includes(`/media/${projectId}/videos/`), String(trimmed.body?.url));
  check('时长≈0.5 秒', Math.abs(Number(trimmed.body?.duration) - 0.5) < 0.2, String(trimmed.body?.duration));

  const fetched = await raw('GET', trimmed.body?.url);
  check('裁剪产物能 GET 到且非空', fetched.statusCode === 200 && fetched.buffer().length > 0, `${fetched.statusCode} ${fetched.buffer().length}B`);
  check('裁剪产物 MIME 是 video/mp4', fetched.headers['content-type'] === 'video/mp4', String(fetched.headers['content-type']));
  const { info } = await probeResponse('trim-video', fetched);
  check(
    'ffmpeg 独立探测：产物 0.5 秒、带视频流与音频流、分辨率不变',
    info.hasVideo && info.hasAudio && info.width === 320 && info.height === 240 && Math.abs((info.duration ?? 0) - 0.5) < 0.25,
    JSON.stringify(info),
  );

  const clamp = await api('POST', '/trim-video', { projectId, videoUrl, startTime: 0.5, endTime: 5 });
  const clampedFile = join(workDir, 'clamped.mp4');
  writeFileSync(clampedFile, (await raw('GET', clamp.body?.url)).buffer());
  const clamped = await probe(ffmpeg, clampedFile);
  check(
    'endTime 超出素材时长时收口到实际末尾（不产出空文件）',
    clamp.status === 200 && Number(clamp.body?.duration) < 1.2 && (clamped.duration ?? 0) > 0.2,
    `${clamp.status} duration=${clamp.body?.duration} probe=${clamped.duration}`,
  );

  const bad = await api('POST', '/trim-video', { projectId, videoUrl, startTime: 0.5, endTime: 0.5 });
  check('结束时间不晚于开始时间 → 400', bad.status === 400, String(bad.status));

  const startBeyond = await api('POST', '/trim-video', { projectId, videoUrl, startTime: 30, endTime: 31 });
  check('开始时间超出素材时长 → 400', startBeyond.status === 400, `${startBeyond.status} ${startBeyond.text.slice(0, 120)}`);

  const tooLong = await api('POST', '/trim-video', { projectId, videoUrl, startTime: 0, endTime: 9999 });
  check('单次裁剪超过 600 秒 → 413', tooLong.status === 413, String(tooLong.status));
}

// ---------------------------------------------------------------- 6. 音频裁剪

{
  const trimmed = await api('POST', '/trim-audio', { projectId, audioUrl, startTime: 0, endTime: 0.4 });
  check('音频裁剪返回 200', trimmed.status === 200, `${trimmed.status} ${trimmed.text.slice(0, 160)}`);
  check('音频裁剪返回 url/filename/duration', typeof trimmed.body?.url === 'string' && typeof trimmed.body?.filename === 'string' && typeof trimmed.body?.duration === 'number', JSON.stringify(trimmed.body?.url));
  check('音频产物落在 audios 目录', String(trimmed.body?.url ?? '').includes(`/media/${projectId}/audios/`), String(trimmed.body?.url));

  const fetched = await raw('GET', trimmed.body?.url);
  check('音频产物能 GET 到且非空', fetched.statusCode === 200 && fetched.buffer().length > 0, `${fetched.statusCode} ${fetched.buffer().length}B`);
  check('音频产物 MIME 是 audio/*', String(fetched.headers['content-type'] ?? '').startsWith('audio/'), String(fetched.headers['content-type']));
  const { info } = await probeResponse('trim-audio', fetched);
  check(
    'ffmpeg 独立探测：音频产物 0.4 秒、纯音频',
    info.hasAudio && !info.hasVideo && Math.abs((info.duration ?? 0) - 0.4) < 0.2,
    JSON.stringify(info),
  );

  const wrongKind = await api('POST', '/trim-audio', { projectId, audioUrl: videoUrl, startTime: 0, endTime: 0.4 });
  check('拿视频当音频裁 → 415', wrongKind.status === 415, String(wrongKind.status));
}

// ---------------------------------------------------------------- 7. 图片标注（dataURL 落盘）

{
  const pngBytes = readFileSync(png);
  const annotation = await api('POST', '/media/images/annotation', {
    projectId,
    sourceUrl: imageUrl,
    dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`,
    mode: 'mask',
    strokes: [{ x: 1, y: 2 }],
  });
  check('标注落盘返回 201', annotation.status === 201, `${annotation.status} ${annotation.text.slice(0, 160)}`);
  check('标注返回 { success, asset }', annotation.body?.success === true && typeof annotation.body?.asset?.url === 'string');
  check(
    '标注记录 annotationMode/strokes',
    annotation.body?.asset?.annotationMode === 'mask' && Array.isArray(annotation.body?.asset?.strokes),
    JSON.stringify({ mode: annotation.body?.asset?.annotationMode }),
  );
  const fetched = await raw('GET', annotation.body?.asset?.url);
  check(
    '标注产物字节与回传的 PNG 完全一致（原样落盘，不重编码）',
    fetched.statusCode === 200 && Buffer.compare(fetched.buffer(), pngBytes) === 0,
    `${fetched.buffer().length}B vs ${pngBytes.length}B`,
  );

  const notDataUrl = await api('POST', '/media/images/annotation', { projectId, dataUrl: 'https://example.com/x.png' });
  check('标注 dataUrl 不合法 → 400', notDataUrl.status === 400, String(notDataUrl.status));

  const crossRef = await api('POST', '/media/images/annotation', {
    projectId,
    sourceUrl: otherImageUrl,
    dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`,
  });
  check('标注引用其他项目素材 → 403', crossRef.status === 403, `${crossRef.status} ${crossRef.text.slice(0, 120)}`);
}

// ---------------------------------------------------------------- 8. 编辑记录

{
  const nodeId = 'node-edit-1';
  const empty = await api('GET', `/media/edits/${projectId}/${nodeId}`);
  check(
    '编辑记录不存在时返回 2xx + edit:null（不能 4xx，前端加载节点会无条件拉它）',
    empty.status === 200 && empty.body?.success === true && empty.body?.edit === null,
    `${empty.status} ${empty.text.slice(0, 120)}`,
  );

  const saved = await api('PUT', `/media/edits/${projectId}/${nodeId}`, {
    annotation: { strokes: [{ x: 1 }] },
    compare: { beforeUrl: imageUrl, afterUrl: imageUrl, position: 0.5, angle: 0 },
  });
  check('保存编辑记录返回 200', saved.status === 200 && saved.body?.success === true, `${saved.status} ${saved.text.slice(0, 120)}`);
  check('编辑记录带 updatedAt', typeof saved.body?.edit?.updatedAt === 'string', String(saved.body?.edit?.updatedAt));

  const loaded = await api('GET', `/media/edits/${projectId}/${nodeId}`);
  check(
    '编辑记录可读回（annotation/compare 原样）',
    loaded.status === 200 && loaded.body?.edit?.annotation?.strokes?.length === 1 && loaded.body?.edit?.compare?.position === 0.5,
    JSON.stringify(loaded.body?.edit?.annotation),
  );

  const cross = await api('PUT', `/media/edits/${projectId}/${nodeId}`, { annotation: { src: otherImageUrl } });
  check('编辑记录引用其他项目素材 → 403', cross.status === 403 && cross.body?.code === 'CROSS_PROJECT_MEDIA', `${cross.status}`);
}

// ---------------------------------------------------------------- 9. 不吞别人的路由

{
  // 说明：`/library` 已经由 src/host/canvas/libraryRouter.ts 实现（资产库），不再回 501；
  // 这条断言守的是「媒体路由没有吞掉别人的路由」，所以换一个仍未移植的路径来验。
  const notPorted = await api('GET', '/public-workflows');
  check('未移植路径仍然回 501 NOT_PORTED（媒体路由没有吞掉一切）', notPorted.status === 501 && notPorted.body?.code === 'NOT_PORTED', `${notPorted.status}`);
  const assets = await api('GET', `/assets/images?projectId=${projectId}`);
  check('素材列表接口仍然可用', assets.status === 200 && Array.isArray(assets.body?.assets), String(assets.status));
  const wrongMethod = await api('POST', '/media/thumbnail?url=x');
  check('GET 专用端点用 POST → 405', wrongMethod.status === 405, String(wrongMethod.status));
}

// ---------------------------------------------------------------- 10. 没有 ffmpeg 时的降级（子进程）

{
  const script = fileURLToPath(import.meta.url);
  try {
    const stdout = execFileSync(process.execPath, [script, '--ffmpeg-off'], {
      env: { ...process.env, DSH_AIFISHER_FFMPEG: 'off' },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('PASS') || line.startsWith('FAIL')) {
        if (line.startsWith('FAIL')) failures += 1;
        lines.push(line);
      }
    }
    check('「没有 ffmpeg」子进程用例整体通过', !stdout.includes('FAIL'), '');
  } catch (error) {
    const stdout = String(error?.stdout ?? '');
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('PASS') || line.startsWith('FAIL')) lines.push(line);
    }
    check('「没有 ffmpeg」子进程用例整体通过', false, String(error?.message ?? error).slice(0, 200));
  }
}

// ---------------------------------------------------------------- 收尾

rmSync(workDir, { recursive: true, force: true });
console.log(lines.join('\n'));
const pass = lines.filter((line) => line.startsWith('PASS')).length;
console.log(`\nSUMMARY pass=${pass} fail=${failures}`);
process.exit(failures === 0 ? 0 : 1);
