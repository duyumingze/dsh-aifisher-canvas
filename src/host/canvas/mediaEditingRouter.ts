/**
 * 媒体加工接口（host 半）—— 视频抽帧 / 视频裁剪 / 音频裁剪 / 图片裁切 / 网格切分 / 缩略图 / 编辑记录
 *
 * 这些能力画布都调，上游实现在 server/media/mediaEditingRouter.js（sharp + 自带 ffmpeg）
 * 与 server/media/thumbnailCache.js（sharp 缩略图）。本插件没有 sharp，全部改走 ffmpeg：
 *
 *   GET    /media/thumbnail?url=<素材 URL>&max=<px>      图片/视频缩略图（image/webp）
 *   POST   /media/images/crop                            { projectId, imageUrl, rect }        → { success, asset }
 *   POST   /media/images/grid                            { projectId, imageUrl, columns, rows, … } → { success, assets }
 *   POST   /media/images/annotation                      { projectId, sourceUrl, dataUrl, … } → { success, asset }
 *   POST   /media/videos/frames                          { projectId, videoUrl, times, roles } → { success, assets }
 *   POST   /trim-video                                   { projectId, videoUrl, startTime, endTime } → { success, url, filename, duration, asset }
 *   POST   /trim-audio                                   同上（audios）
 *   GET/PUT /media/edits/<projectId>/<nodeId>            节点编辑记录（标注/蒙版/对比）
 *
 * 响应字段刻意照抄上游：前端 `assetNode()` 会读 asset.url/type/width/height/prompt/model/duration，
 * agent 的 media 动作会读 result.assets（或 result.asset 单数）。
 *
 * 与上游的差异（都写在各处注释里，这里给总览）：
 *   1. 没有 sharp：图片处理全走 ffmpeg，产物统一 PNG（上游是 sharp 的 png/webp）。
 *   2. 缩略图支持视频（上游只支持图片），并对图片/视频共用一个磁盘缓存。
 *   3. 素材来源放宽到「本插件媒体 URL / http(s) / data:」三种；任意本机路径一律 422，
 *      不接受「读任意文件」。跨项目引用仍然 403（与上游一致）。
 *   4. 编辑记录 GET 在记录不存在时返回 200 + { edit: null }（上游 404）—— 前端加载节点时
 *      会无条件拉它，404 会被当成错误弹提示。
 *   5. 未做：上游的目录授权、分片上传、sharp 重编码（标注只落盘，不再压一遍）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { readJsonBody, sendJson } from '../http/httpUtil';
import { createFfmpegRunner, FfmpegError, type FfmpegRunner } from '../media/ffmpeg';
import {
  MEDIA_URL_BASE,
  MediaError,
  parseDataUrl,
  parseMediaUrlRef,
  type MediaStore,
  type MediaType,
} from './mediaStore';

export interface MediaEditingDeps {
  mediaStore: MediaStore;
}

/** 产物统一挂这个 model（上游同款字符串），前端 assetNode 会把它写进节点。 */
const EDIT_MODEL = 'AIFISHER 媒体编辑';

const OPERATION_PROMPT: Readonly<Record<string, string>> = Object.freeze({
  crop: '图片裁切',
  grid: '图片宫格拆分',
  annotation: '图片标注',
  'video-frame': '视频画面提取',
  'video-trim': '视频时间段导出',
  'audio-trim': '音频时间段导出',
});

/** 上限：宫格 10x10 且总数 ≤64（照上游）、一次抽帧 ≤20、单次裁剪 ≤10 分钟。 */
const MAX_GRID_AXIS = 10;
const MAX_GRID_CELLS = 64;
const MAX_GRID_GAP = 4096;
const MAX_FRAMES = 20;
const MAX_TRIM_SECONDS = 600;
/** 时间参数上限（24 小时）：挡住 1e21 这种会被拼进 ffmpeg 参数的离谱输入。 */
const MAX_TIME_SECONDS = 86_400;
/** 尺寸上限：超过这个值一律拒（避免构造超大中间产物）。 */
const MAX_DIMENSION = 16384;
/** 远程素材与 data URL 的字节上限（本机素材库文件的上限由 mediaStore 管）。 */
const MAX_REMOTE_BYTES = 512 * 1024 * 1024;
const MAX_DATA_URL_BYTES = 64 * 1024 * 1024;
const MAX_ANNOTATION_BYTES = 25 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 60_000;
/** 缩略图尺寸（与上游 normalizeMaxSize 一致）。 */
const THUMB_DEFAULT = 960;
const THUMB_MIN = 128;
const THUMB_MAX = 2048;
/** 单次 ffmpeg 任务的超时：裁剪长视频要留够时间。 */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * ffmpeg 运行器在模块加载时创建一次：
 *   - 探测结果全局复用（`-encoders` 只跑一次）；
 *   - 启动诊断（可用/不可用）也随之在插件 apply 时打出来，用户一眼能看到。
 */
const ffmpeg: FfmpegRunner = createFfmpegRunner();

const EXT_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
});

const DEFAULT_EXT: Readonly<Record<MediaType, string>> = Object.freeze({
  images: '.png',
  videos: '.mp4',
  audios: '.mp3',
});

const DEFAULT_MIME: Readonly<Record<MediaType, string>> = Object.freeze({
  images: 'image/png',
  videos: 'video/mp4',
  audios: 'audio/mpeg',
});

// ---------------------------------------------------------------- 基础工具

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof MediaError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof FfmpegError) {
    const status =
      error.code === 'FFMPEG_UNAVAILABLE'
        ? 503
        : error.code === 'FFMPEG_TIMEOUT'
          ? 504
          : error.code === 'MEDIA_PROBE_FAILED'
            ? 415
            : 500;
    // FFMPEG_UNAVAILABLE 是环境问题（启动时已经诊断过一次），不要每个请求刷一遍日志
    if (status >= 500 && error.code !== 'FFMPEG_UNAVAILABLE') {
      console.error(`[aifisher-canvas][media] ${error.code}: ${error.message}`);
    }
    sendJson(res, status, { error: error.message, code: error.code });
    return;
  }
  console.error('[aifisher-canvas][media] 媒体加工未预期失败：', error);
  sendJson(res, 500, {
    error: error instanceof Error ? error.message : '媒体加工失败。',
    code: 'MEDIA_EDIT_FAILED',
  });
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req, limitBytes);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MediaError('请求体必须是 JSON 对象。', 422, 'INVALID_MEDIA_EDIT');
  }
  return body as Record<string, unknown>;
}

function normalizeInteger(value: unknown, label: string, minimum = 0): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw new MediaError(`${label}无效。`, 400, 'INVALID_MEDIA_EDIT');
  }
  return number;
}

function normalizeTime(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new MediaError(`${label}无效。`, 400, 'INVALID_MEDIA_EDIT');
  }
  return number;
}

/** projectId / nodeId 只允许一段安全目录名（mediaStore 内部也有一份，这里用于编辑记录路径）。 */
function safeSegment(value: string, label: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed.length > 128 || trimmed === '.' || trimmed === '..' || /[\\/\u0000-\u001f]/.test(trimmed)) {
    throw new MediaError(`${label}无效。`, 400, 'INVALID_MEDIA_SEGMENT');
  }
  return trimmed;
}

/** 所有中间产物都放 <rootDir>/.tmp，用完即删（缩略图缓存除外，见 thumbnail 注释）。 */
function tmpDirFor(mediaStore: MediaStore): string {
  const dir = join(mediaStore.rootDir, '.tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 素材 URL（本插件形状 或 上游 /library/media 形状）→ 三段式引用；不是这两种形状返回 null。
 *
 * 解析**统一走 mediaStore 的 parseMediaUrlRef**：这里以前抄了一份，两份都只对 `http(s):` 归一
 * pathname，相对形状把 `?t=…` 缓存戳当成了文件名的一部分（画布的结果 URL 就带这个戳，
 * 于是「编辑/裁剪一张刚生成的图」会报素材不存在）。少一份拷贝就少一次这种分叉。
 */
const parseMediaUrl = parseMediaUrlRef;

function canonicalMediaUrl(ref: { projectId: string; type: MediaType; filename: string }): string {
  return `${MEDIA_URL_BASE}/${encodeURIComponent(ref.projectId)}/${ref.type}/${encodeURIComponent(ref.filename)}`;
}

// ---------------------------------------------------------------- 素材来源解析

/** 已落到本机磁盘的输入素材（远程/data URL 会带回 cleanup）。 */
interface InputFile {
  path: string;
  kind: MediaType;
  /** 本插件素材库 URL 才能知道归属项目；远程/data URL 为 null。 */
  projectId: string | null;
  cleanup: () => Promise<void>;
}

const NOOP_CLEANUP = async (): Promise<void> => {};

function kindFromContentType(contentType: string): MediaType | null {
  const value = contentType.toLowerCase();
  if (value.startsWith('image/')) return 'images';
  if (value.startsWith('video/')) return 'videos';
  if (value.startsWith('audio/')) return 'audios';
  return null;
}

function kindFromName(name: string): MediaType | null {
  const ext = extname(name).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].includes(ext)) return 'images';
  if (['.mp4', '.webm', '.mov', '.m4v', '.mkv'].includes(ext)) return 'videos';
  if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext)) return 'audios';
  return null;
}

function extensionFor(contentType: string, kind: MediaType): string {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[mime] ?? DEFAULT_EXT[kind];
}

/**
 * 把画布传来的 url 变成磁盘上的一个文件。
 * 只接受三种来源：本插件媒体库 URL、http(s)、data:。任意本机路径（file://、C:\...、/etc/...）
 * 一律拒绝 —— 这个端点不能被当成「任意文件读取器」。
 */
async function materialize(rawUrl: string, mediaStore: MediaStore): Promise<InputFile> {
  const value = String(rawUrl ?? '').trim();
  if (!value) throw new MediaError('url 必填。', 422, 'INVALID_MEDIA_URL');

  const ref = parseMediaUrl(value);
  if (ref) {
    const local = mediaStore.localPathForUrl(canonicalMediaUrl(ref));
    if (!local) throw new MediaError('素材不存在。', 404, 'MEDIA_NOT_FOUND');
    return { path: local.path, kind: local.type, projectId: ref.projectId, cleanup: NOOP_CLEANUP };
  }

  if (/^data:/i.test(value)) {
    if (value.length > MAX_DATA_URL_BYTES) {
      throw new MediaError('data URL 超过大小上限。', 413, 'MEDIA_TOO_LARGE');
    }
    const { buffer, contentType } = parseDataUrl(value);
    const kind = kindFromContentType(contentType);
    if (!kind) throw new MediaError('无法识别 data URL 的素材类型。', 415, 'UNSUPPORTED_MEDIA_TYPE');
    if (buffer.byteLength > MAX_ANNOTATION_BYTES * 2) {
      throw new MediaError('data URL 超过大小上限。', 413, 'MEDIA_TOO_LARGE');
    }
    const path = join(tmpDirFor(mediaStore), `${randomUUID()}${extensionFor(contentType, kind)}`);
    await writeFile(path, buffer);
    return { path, kind, projectId: null, cleanup: async () => rm(path, { force: true }).then(() => undefined, () => undefined) };
  }

  if (/^https?:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new MediaError('远程素材地址无效。', 422, 'INVALID_MEDIA_URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new MediaError('只接受 http/https 远程素材。', 422, 'INVALID_MEDIA_URL');
    }
    // 与 mediaRouter 的代理同向：不跟随跳转（跳转目标可能是内网/回环）
    let response: Response;
    try {
      response = await fetch(parsed.href, { redirect: 'error', signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
    } catch (error) {
      throw new MediaError(
        `远程素材下载失败：${error instanceof Error ? error.message : String(error)}`,
        502,
        'MEDIA_FETCH_FAILED',
      );
    }
    if (!response.ok || !response.body) {
      throw new MediaError(`远程素材下载失败（${response.status}）。`, 502, 'MEDIA_FETCH_FAILED');
    }
    const contentType = response.headers.get('content-type') ?? '';
    const kind = kindFromContentType(contentType) ?? kindFromName(parsed.pathname);
    if (!kind) throw new MediaError('无法判断远程素材类型。', 415, 'UNSUPPORTED_MEDIA_TYPE');

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (!chunk) continue;
      size += chunk.byteLength;
      if (size > MAX_REMOTE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new MediaError('远程素材超过大小上限。', 413, 'MEDIA_TOO_LARGE');
      }
      chunks.push(Buffer.from(chunk));
    }
    const path = join(tmpDirFor(mediaStore), `${randomUUID()}${extensionFor(contentType, kind)}`);
    await writeFile(path, Buffer.concat(chunks));
    return { path, kind, projectId: null, cleanup: async () => rm(path, { force: true }).then(() => undefined, () => undefined) };
  }

  throw new MediaError('只接受本插件素材 URL、http(s) 链接或 data URL。', 422, 'INVALID_MEDIA_URL');
}

/**
 * 产物归属项目：素材库 URL 里带项目，请求体里的 projectId 用来做交叉校验。
 * 上游是「请求体 projectId 为准 + 素材必须属于该项目」，这里反过来取素材的项目，
 * 避免请求体传默认值把产物写到错误的项目目录里。
 */
function outputProject(raw: unknown, input: InputFile): string {
  const requested = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  if (input.projectId && requested && requested !== input.projectId) {
    throw new MediaError('素材不属于当前项目。', 403, 'CROSS_PROJECT_MEDIA');
  }
  return input.projectId ?? requested ?? 'default';
}

function requireKind(input: InputFile, expected: MediaType, message: string): void {
  if (input.kind !== expected) throw new MediaError(message, 415, 'UNSUPPORTED_MEDIA_TYPE');
}

// ---------------------------------------------------------------- 产物落库

interface SaveAssetInput {
  mediaStore: MediaStore;
  projectId: string;
  type: MediaType;
  bytes: Buffer;
  filename: string;
  sourceUrl: string;
  operation: string;
  nodeId?: string;
  extra?: Record<string, unknown>;
}

/**
 * 把加工产物落进素材库，并补上上游前端会读的字段。
 * mediaStore 的 sidecar 就是 asset 本体，所以这里不再造第二份结构。
 */
async function saveAsset(input: SaveAssetInput) {
  return input.mediaStore.save({
    projectId: input.projectId,
    type: input.type,
    bytes: input.bytes,
    filename: input.filename,
    source: 'edit',
    prompt: OPERATION_PROMPT[input.operation] ?? '媒体编辑',
    model: EDIT_MODEL,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    extra: {
      operation: input.operation,
      sourceUrl: input.sourceUrl,
      sourceUrls: [input.sourceUrl],
      sourceStatus: 'available',
      mimeType: DEFAULT_MIME[input.type],
      format: extname(input.filename).replace('.', '') || undefined,
      ...(input.extra ?? {}),
    },
  });
}

function nodeIdOf(body: Record<string, unknown>): string | undefined {
  return typeof body.nodeId === 'string' && body.nodeId.trim() ? body.nodeId.trim() : undefined;
}

// ---------------------------------------------------------------- 图片裁切

async function cropImage(req: IncomingMessage, res: ServerResponse, deps: MediaEditingDeps): Promise<void> {
  const body = await readBody(req, 1024 * 1024);
  const rawRect = (body.rect ?? {}) as Record<string, unknown>;
  const x = normalizeInteger(rawRect.x, '裁切横坐标');
  const y = normalizeInteger(rawRect.y, '裁切纵坐标');
  const width = normalizeInteger(rawRect.width, '裁切宽度', 1);
  const height = normalizeInteger(rawRect.height, '裁切高度', 1);
  if ([x, y, width, height].some((value) => value > MAX_DIMENSION)) {
    throw new MediaError('裁切参数超出上限。', 413, 'MEDIA_TOO_LARGE');
  }

  const sourceUrl = String(body.imageUrl ?? '');
  const input = await materialize(sourceUrl, deps.mediaStore);
  requireKind(input, 'images', '图片裁切只接受图片素材。');
  const projectId = outputProject(body.projectId, input);

  try {
    const info = await ffmpeg.info(input.path);
    if (info.width && info.height && (x + width > info.width || y + height > info.height)) {
      throw new MediaError('裁切区域超出图片范围。', 400, 'INVALID_MEDIA_EDIT');
    }
    const bytes = await renderToBuffer(deps.mediaStore, [
      '-i', input.path,
      '-vf', `crop=${width}:${height}:${x}:${y}`,
      '-frames:v', '1',
    ], QUICK_TIMEOUT_MS);
    const record = await saveAsset({
      mediaStore: deps.mediaStore,
      projectId,
      type: 'images',
      bytes,
      filename: 'crop.png',
      sourceUrl,
      operation: 'crop',
      nodeId: nodeIdOf(body),
      extra: { cropRect: { x, y, width, height }, width, height },
    });
    sendJson(res, 201, { success: true, asset: record });
  } finally {
    await input.cleanup();
  }
}

// ---------------------------------------------------------------- 图片宫格切分

/** 与上游 normalizeGuides 同一套语义：不给就用等分线，给了必须严格递增且落在 (0,1) 内。 */
function normalizeGuides(value: unknown, count: number, label: string): number[] {
  const expected = count - 1;
  const normalized =
    value == null
      ? Array.from({ length: expected }, (_, index) => (index + 1) / count)
      : Array.isArray(value)
        ? value.map(Number)
        : null;
  if (
    !normalized ||
    normalized.length !== expected ||
    normalized.some(
      (guide, index) =>
        !Number.isFinite(guide) || guide <= 0 || guide >= 1 || (index > 0 && guide <= normalized[index - 1]),
    )
  ) {
    throw new MediaError(`${label}无效。`, 400, 'INVALID_MEDIA_EDIT');
  }
  return normalized;
}

/** 与上游 buildGridRanges 一致：间距从格子内侧两边各吃掉一半，首尾不吃。 */
function buildGridRanges(size: number, guides: number[], gap: number): Array<{ start: number; size: number }> {
  const boundaries = [0, ...guides.map((guide) => Math.round(guide * size)), size];
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const insetStart = index === 0 ? 0 : Math.ceil(gap / 2);
    const insetEnd = index === boundaries.length - 2 ? 0 : Math.floor(gap / 2);
    const left = start + insetStart;
    const cell = end - insetEnd - left;
    if (cell < 1) throw new MediaError('宫格间距超过单格尺寸。', 400, 'INVALID_MEDIA_EDIT');
    return { start: left, size: cell };
  });
}

async function splitImageGrid(req: IncomingMessage, res: ServerResponse, deps: MediaEditingDeps): Promise<void> {
  const body = await readBody(req, 1024 * 1024);
  const columns = normalizeInteger(body.columns, '宫格列数', 1);
  const rows = normalizeInteger(body.rows, '宫格行数', 1);
  if (columns > MAX_GRID_AXIS || rows > MAX_GRID_AXIS || columns * rows > MAX_GRID_CELLS) {
    throw new MediaError('宫格数量超过限制。', 400, 'INVALID_MEDIA_EDIT');
  }
  const horizontalGap = normalizeInteger(body.horizontalGap ?? 0, '横向间距');
  const verticalGap = normalizeInteger(body.verticalGap ?? 0, '纵向间距');
  if (horizontalGap > MAX_GRID_GAP || verticalGap > MAX_GRID_GAP) {
    throw new MediaError('宫格间距超出上限。', 413, 'MEDIA_TOO_LARGE');
  }

  const sourceUrl = String(body.imageUrl ?? '');
  const input = await materialize(sourceUrl, deps.mediaStore);
  requireKind(input, 'images', '宫格切分只接受图片素材。');
  const projectId = outputProject(body.projectId, input);

  try {
    const info = await ffmpeg.info(input.path);
    if (!info.width || !info.height) throw new MediaError('读不到图片尺寸，无法切分。', 415, 'MEDIA_PROBE_FAILED');
    const columnGuides = normalizeGuides(body.columnGuides, columns, '列分割线');
    const rowGuides = normalizeGuides(body.rowGuides, rows, '行分割线');
    const columnRanges = buildGridRanges(info.width, columnGuides, horizontalGap);
    const rowRanges = buildGridRanges(info.height, rowGuides, verticalGap);

    const assets = [];
    // 顺序照上游：行优先、列次之（前端按 row/column 摆位）
    for (let row = 0; row < rowRanges.length; row += 1) {
      for (let column = 0; column < columnRanges.length; column += 1) {
        const horizontal = columnRanges[column];
        const vertical = rowRanges[row];
        const bytes = await renderToBuffer(deps.mediaStore, [
          '-i', input.path,
          '-vf', `crop=${horizontal.size}:${vertical.size}:${horizontal.start}:${vertical.start}`,
          '-frames:v', '1',
        ], QUICK_TIMEOUT_MS);
        assets.push(
          await saveAsset({
            mediaStore: deps.mediaStore,
            projectId,
            type: 'images',
            bytes,
            filename: 'grid.png',
            sourceUrl,
            operation: 'grid',
            nodeId: nodeIdOf(body),
            extra: {
              gridColumn: column,
              gridRow: row,
              gridColumns: columns,
              gridRows: rows,
              horizontalGap,
              verticalGap,
              width: horizontal.size,
              height: vertical.size,
            },
          }),
        );
      }
    }
    sendJson(res, 201, { success: true, assets });
  } finally {
    await input.cleanup();
  }
}

// ---------------------------------------------------------------- 视频抽帧

async function extractFrames(req: IncomingMessage, res: ServerResponse, deps: MediaEditingDeps): Promise<void> {
  const body = await readBody(req, 1024 * 1024);
  const times = Array.isArray(body.times) ? body.times.map((time) => normalizeTime(time, '画面时间')) : [];
  if (times.length === 0 || times.length > MAX_FRAMES) {
    throw new MediaError(`一次可提取 1 到 ${MAX_FRAMES} 个画面。`, 400, 'INVALID_MEDIA_EDIT');
  }
  if (times.some((time) => time > MAX_TIME_SECONDS)) {
    throw new MediaError('画面时间超出上限。', 400, 'INVALID_MEDIA_EDIT');
  }
  const roles = Array.isArray(body.roles) ? body.roles : [];

  const sourceUrl = String(body.videoUrl ?? '');
  const input = await materialize(sourceUrl, deps.mediaStore);
  requireKind(input, 'videos', '抽帧只接受视频素材。');
  const projectId = outputProject(body.projectId, input);

  try {
    const info = await ffmpeg.info(input.path);
    if (info.duration !== null) {
      const overshoot = times.find((time) => time > info.duration! + 0.05);
      if (overshoot !== undefined) {
        throw new MediaError(`画面时间 ${overshoot}s 超出素材时长 ${info.duration.toFixed(2)}s。`, 400, 'INVALID_MEDIA_EDIT');
      }
    }
    const assets = [];
    for (let index = 0; index < times.length; index += 1) {
      const time = times[index];
      const role = ['first', 'last', 'screenshot'].includes(String(roles[index])) ? String(roles[index]) : 'screenshot';
      const bytes = await renderToBuffer(deps.mediaStore, [
        '-ss', String(time),
        '-i', input.path,
        '-frames:v', '1',
      ], QUICK_TIMEOUT_MS);
      assets.push(
        await saveAsset({
          mediaStore: deps.mediaStore,
          projectId,
          type: 'images',
          bytes,
          filename: 'frame.png',
          sourceUrl,
          operation: 'video-frame',
          nodeId: nodeIdOf(body),
          extra: {
            frameTime: time,
            frameRole: role,
            width: info.width,
            height: info.height,
          },
        }),
      );
    }
    sendJson(res, 201, { success: true, assets });
  } finally {
    await input.cleanup();
  }
}

// ---------------------------------------------------------------- 视频 / 音频裁剪

/** 起止时间校验 + 按素材实际时长收口（超出时裁到末尾，避免产出空文件）。 */
function normalizeRange(
  body: Record<string, unknown>,
  duration: number | null,
): { start: number; end: number; length: number } {
  const start = normalizeTime(body.startTime, '开始时间');
  const end = normalizeTime(body.endTime, '结束时间');
  if (start > MAX_TIME_SECONDS || end > MAX_TIME_SECONDS) {
    throw new MediaError('时间参数超出上限。', 400, 'INVALID_MEDIA_EDIT');
  }
  if (end <= start) throw new MediaError('结束时间必须晚于开始时间。', 400, 'INVALID_MEDIA_EDIT');
  if (end - start > MAX_TRIM_SECONDS) {
    throw new MediaError(`单次裁剪不能超过 ${MAX_TRIM_SECONDS} 秒。`, 413, 'MEDIA_TOO_LARGE');
  }
  let effectiveEnd = end;
  if (duration !== null) {
    if (start >= duration) {
      throw new MediaError(`开始时间超出素材时长 ${duration.toFixed(2)}s。`, 400, 'INVALID_MEDIA_EDIT');
    }
    effectiveEnd = Math.min(end, duration);
  }
  return { start, end: effectiveEnd, length: effectiveEnd - start };
}

async function trimVideo(req: IncomingMessage, res: ServerResponse, deps: MediaEditingDeps): Promise<void> {
  const body = await readBody(req, 1024 * 1024);
  const sourceUrl = String(body.videoUrl ?? '');
  const input = await materialize(sourceUrl, deps.mediaStore);
  requireKind(input, 'videos', '视频裁剪只接受视频素材。');
  const projectId = outputProject(body.projectId, input);

  try {
    const info = await ffmpeg.info(input.path);
    const range = normalizeRange(body, info.duration);
    // 优先 libx264；老 build 只有 mpeg4（原生编码器必然存在），质量差一点但不会失败
    const videoCodec = (await ffmpeg.hasEncoder('libx264')) ? 'libx264' : 'mpeg4';
    const args = [
      '-ss', String(range.start),
      '-i', input.path,
      '-t', String(range.length),
      '-c:v', videoCodec,
      ...(videoCodec === 'libx264' ? ['-preset', 'veryfast', '-crf', '23'] : ['-b:v', '2M']),
      '-pix_fmt', 'yuv420p',
      ...((await ffmpeg.hasEncoder('aac')) ? ['-c:a', 'aac', '-b:a', '128k'] : []),
      '-movflags', '+faststart',
    ];
    const { bytes, path } = await renderToFile(deps.mediaStore, args, '.mp4', JOB_TIMEOUT_MS);
    try {
      const outInfo = await ffmpeg.info(path).catch(() => null);
      const duration = outInfo?.duration ?? range.length;
      const record = await saveAsset({
        mediaStore: deps.mediaStore,
        projectId,
        type: 'videos',
        bytes,
        filename: 'trim.mp4',
        sourceUrl,
        operation: 'video-trim',
        nodeId: nodeIdOf(body),
        extra: {
          trimStart: range.start,
          trimEnd: range.end,
          duration,
          width: outInfo?.width ?? info.width,
          height: outInfo?.height ?? info.height,
        },
      });
      sendJson(res, 200, { success: true, url: record.url, filename: record.filename, duration, asset: record });
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  } finally {
    await input.cleanup();
  }
}

async function trimAudio(req: IncomingMessage, res: ServerResponse, deps: MediaEditingDeps): Promise<void> {
  const body = await readBody(req, 1024 * 1024);
  const sourceUrl = String(body.audioUrl ?? '');
  const input = await materialize(sourceUrl, deps.mediaStore);
  requireKind(input, 'audios', '音频裁剪只接受音频素材。');
  const projectId = outputProject(body.projectId, input);

  try {
    const info = await ffmpeg.info(input.path);
    const range = normalizeRange(body, info.duration);
    // 上游产物是 mp3；本机 build 没有 libmp3lame 时退回 aac（.m4a 容器）
    const useMp3 = await ffmpeg.hasEncoder('libmp3lame');
    const extension = useMp3 ? '.mp3' : '.m4a';
    const args = [
      '-ss', String(range.start),
      '-i', input.path,
      '-t', String(range.length),
      '-vn',
      ...(useMp3 ? ['-c:a', 'libmp3lame', '-q:a', '2'] : (await ffmpeg.hasEncoder('aac')) ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    ];
    const { bytes, path } = await renderToFile(deps.mediaStore, args, extension, JOB_TIMEOUT_MS);
    try {
      const outInfo = await ffmpeg.info(path).catch(() => null);
      const duration = outInfo?.duration ?? range.length;
      const record = await saveAsset({
        mediaStore: deps.mediaStore,
        projectId,
        type: 'audios',
        bytes,
        filename: `trim${extension}`,
        sourceUrl,
        operation: 'audio-trim',
        nodeId: nodeIdOf(body),
        extra: {
          trimStart: range.start,
          trimEnd: range.end,
          duration,
          mimeType: useMp3 ? 'audio/mpeg' : 'audio/mp4',
        },
      });
      sendJson(res, 200, { success: true, url: record.url, filename: record.filename, duration, asset: record });
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  } finally {
    await input.cleanup();
  }
}

// ---------------------------------------------------------------- 图片标注（dataURL 落盘）

/**
 * 上游这里收的是**前端合成好的 PNG dataURL**（canvasMediaControl 的 annotate 分支在浏览器里
 * 画好标注再回传），服务端只用 sharp 解码后重存一份。所以移植版就是「dataURL 落盘」：
 * 不做重编码（没有 sharp），字节原样进素材库。
 */
async function saveAnnotation(req: IncomingMessage, res: ServerResponse, deps: MediaEditingDeps): Promise<void> {
  const body = await readBody(req, 48 * 1024 * 1024);
  const dataUrl = String(body.dataUrl ?? '');
  if (!dataUrl.startsWith('data:')) {
    throw new MediaError('标注结果必须是 data URL。', 400, 'INVALID_DATA_URL');
  }
  const { buffer, contentType } = parseDataUrl(dataUrl);
  if (!contentType.startsWith('image/')) {
    throw new MediaError('标注结果必须是图片。', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_ANNOTATION_BYTES) {
    throw new MediaError('标注结果大小无效。', 413, 'ANNOTATION_TOO_LARGE');
  }
  const mode = ['draw', 'mask', 'erase'].includes(String(body.mode)) ? String(body.mode) : 'draw';
  const strokes = Array.isArray(body.strokes) ? body.strokes : [];

  // sourceUrl 可选：给了就必须是本项目里的图片素材（与上游一致），没给就按请求体 projectId 落库
  const sourceUrl = String(body.sourceUrl ?? '');
  let projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : 'default';
  if (sourceUrl) {
    const input = await materialize(sourceUrl, deps.mediaStore);
    try {
      requireKind(input, 'images', '标注来源必须是图片素材。');
      projectId = outputProject(body.projectId, input);
    } finally {
      await input.cleanup();
    }
  }

  const record = await saveAsset({
    mediaStore: deps.mediaStore,
    projectId,
    type: 'images',
    bytes: buffer,
    filename: `annotation${extensionFor(contentType, 'images')}`,
    sourceUrl,
    operation: 'annotation',
    nodeId: nodeIdOf(body),
    extra: { annotationMode: mode, strokes, mimeType: contentType.split(';')[0].trim(), format: extname(extensionFor(contentType, 'images')).replace('.', '') },
  });
  sendJson(res, 201, { success: true, asset: record });
}

// ---------------------------------------------------------------- 编辑记录（标注/蒙版/对比）

function editStatePath(mediaStore: MediaStore, projectId: string, nodeId: string): string {
  return join(mediaStore.rootDir, safeSegment(projectId, '项目标识'), 'edits', `${safeSegment(nodeId, '节点标识')}.json`);
}

/** 编辑状态里引用的素材必须属于同一个项目（照抄上游 validateProjectMediaReferences 的意图）。 */
function assertProjectRefs(value: unknown, projectId: string): void {
  if (typeof value === 'string') {
    const ref = parseMediaUrl(value);
    if (ref && ref.projectId !== projectId) {
      throw new MediaError('编辑状态引用了其他项目的素材。', 403, 'CROSS_PROJECT_MEDIA');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertProjectRefs(item, projectId);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) assertProjectRefs(item, projectId);
  }
}

async function putEditState(req: IncomingMessage, res: ServerResponse, parts: string[], deps: MediaEditingDeps): Promise<void> {
  const projectId = safeSegment(parts[2], '项目标识');
  const nodeId = safeSegment(parts[3], '节点标识');
  const body = await readBody(req, 4 * 1024 * 1024);
  const state = {
    annotation: body.annotation ?? null,
    mask: body.mask ?? null,
    compare: body.compare ?? null,
  };
  assertProjectRefs(state, projectId);
  const edit = { projectId, nodeId, ...state, updatedAt: new Date().toISOString() };
  const target = editStatePath(deps.mediaStore, projectId, nodeId);
  mkdirSync(join(deps.mediaStore.rootDir, projectId, 'edits'), { recursive: true });
  // tmp + rename 原子写，和其他落盘处同一套做法
  const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(edit, null, 2), 'utf8');
  await rename(temporary, target);
  sendJson(res, 200, { success: true, edit });
}

async function getEditState(res: ServerResponse, parts: string[], deps: MediaEditingDeps): Promise<void> {
  const projectId = safeSegment(parts[2], '项目标识');
  const nodeId = safeSegment(parts[3], '节点标识');
  const target = editStatePath(deps.mediaStore, projectId, nodeId);
  if (!existsSync(target)) {
    // 上游这里 404；但前端每次加载节点都会拉一次，4xx 会被当成错误提示，所以给空结构
    sendJson(res, 200, { success: true, edit: null });
    return;
  }
  const edit = JSON.parse(await readFile(target, 'utf8')) as unknown;
  sendJson(res, 200, { success: true, edit });
}

// ---------------------------------------------------------------- 缩略图

function normalizeThumbMax(value: string | null): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return THUMB_DEFAULT;
  return Math.min(THUMB_MAX, Math.max(THUMB_MIN, parsed));
}

function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string, contentType: string): void {
  const info = statSync(filePath);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': info.size,
    // 文件名带内容指纹，可以放心长缓存
    'cache-control': 'private, max-age=31536000, immutable',
  });
  if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

/**
 * 缩略图。上游只支持图片（sharp + webp 缓存），这里图片/视频都能出：
 * 视频取第一帧。缓存放 <rootDir>/.tmp/thumbnails，key 带 size+mtime，
 * 画布每次渲染都会请求一批缩略图，没有缓存会把磁盘打满。
 */
async function serveThumbnail(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: MediaEditingDeps,
): Promise<void> {
  const target = url.searchParams.get('url') ?? '';
  const max = normalizeThumbMax(url.searchParams.get('max'));
  const input = await materialize(target, deps.mediaStore);
  try {
    if (input.kind === 'audios') {
      throw new MediaError('缩略图只支持图片与视频。', 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    const useWebp = await ffmpeg.hasEncoder('libwebp');
    const extension = useWebp ? '.webp' : '.png';
    const cacheDir = join(tmpDirFor(deps.mediaStore), 'thumbnails');
    mkdirSync(cacheDir, { recursive: true });
    let stamp = '';
    try {
      const info = statSync(input.path);
      stamp = `${info.size}:${info.mtimeMs}`;
    } catch {
      /* 拿不到指纹也不影响生成，只是缓存键弱一点 */
    }
    const key = createHash('sha256').update(`${input.path}:${stamp}:${max}:${extension}`).digest('hex').slice(0, 32);
    const cached = join(cacheDir, `${key}${extension}`);
    if (!existsSync(cached)) {
      // 临时名必须保留扩展名：ffmpeg 靠扩展名猜输出封装格式，`.part` 会让 muxer 直接初始化失败
      const temporary = join(cacheDir, `${key}.${randomUUID().slice(0, 8)}${extension}`);
      try {
        await ffmpeg.run(
          [
            '-hide_banner', '-v', 'error',
            '-i', input.path,
            '-vf', `scale=${max}:${max}:force_original_aspect_ratio=decrease`,
            '-frames:v', '1', '-update', '1',
            '-an', '-sn',
            temporary,
          ],
          { timeoutMs: QUICK_TIMEOUT_MS },
        );
        await rename(temporary, cached);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    serveFile(req, res, cached, useWebp ? 'image/webp' : 'image/png');
  } finally {
    await input.cleanup();
  }
}

// ---------------------------------------------------------------- ffmpeg 产物工具

/** 跑一次 ffmpeg 把单个产物写到临时文件，返回字节与路径（调用方负责删）。 */
async function renderToFile(
  mediaStore: MediaStore,
  args: readonly string[],
  extension: string,
  timeoutMs: number,
): Promise<{ bytes: Buffer; path: string }> {
  const dir = tmpDirFor(mediaStore);
  const path = join(dir, `${randomUUID()}${extension}`);
  try {
    await ffmpeg.run(['-y', '-hide_banner', '-v', 'error', ...args, path], { timeoutMs });
    return { bytes: await readFile(path), path };
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 图片产物的便捷版本：临时文件直接删掉，只留字节。 */
async function renderToBuffer(mediaStore: MediaStore, args: readonly string[], timeoutMs: number): Promise<Buffer> {
  const { bytes, path } = await renderToFile(mediaStore, [...args, '-update', '1'], '.png', timeoutMs);
  await rm(path, { force: true }).catch(() => undefined);
  return bytes;
}

// ---------------------------------------------------------------- 路由入口

/** 诊断用（restRouter 的 /status 想显示「媒体加工能不能用」时挂这个即可）。 */
export function mediaEditingStatus(): { ffmpeg: ReturnType<FfmpegRunner['probe']> } {
  return { ffmpeg: ffmpeg.probe() };
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: 'method not allowed' });
}

/** 已处理返回 true；未匹配返回 false（交回 restRouter）。 */
export async function handleMediaEditing(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: MediaEditingDeps;
}): Promise<boolean> {
  const { req, res, url, parts, deps } = input;
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    // ---- 缩略图：GET /media/thumbnail?url=&max= ----
    if (parts[0] === 'media' && parts[1] === 'thumbnail' && parts.length === 2) {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(res);
        return true;
      }
      await serveThumbnail(req, res, url, deps);
      return true;
    }

    // ---- 图片编辑：POST /media/images/{crop,grid,annotation} ----
    if (parts[0] === 'media' && parts[1] === 'images' && parts.length === 3) {
      if (parts[2] !== 'crop' && parts[2] !== 'grid' && parts[2] !== 'annotation') return false;
      if (method !== 'POST') {
        methodNotAllowed(res);
        return true;
      }
      if (parts[2] === 'crop') await cropImage(req, res, deps);
      else if (parts[2] === 'grid') await splitImageGrid(req, res, deps);
      else await saveAnnotation(req, res, deps);
      return true;
    }

    // ---- 视频抽帧：POST /media/videos/frames ----
    if (parts[0] === 'media' && parts[1] === 'videos' && parts[2] === 'frames' && parts.length === 3) {
      if (method !== 'POST') {
        methodNotAllowed(res);
        return true;
      }
      await extractFrames(req, res, deps);
      return true;
    }

    // ---- 编辑记录：GET/PUT /media/edits/<projectId>/<nodeId> ----
    if (parts[0] === 'media' && parts[1] === 'edits' && parts.length === 4) {
      if (method === 'PUT') await putEditState(req, res, parts, deps);
      else if (method === 'GET') await getEditState(res, parts, deps);
      else {
        methodNotAllowed(res);
        return true;
      }
      return true;
    }

    // ---- 视频 / 音频裁剪 ----
    if (parts.length === 1 && parts[0] === 'trim-video') {
      if (method !== 'POST') {
        methodNotAllowed(res);
        return true;
      }
      await trimVideo(req, res, deps);
      return true;
    }
    if (parts.length === 1 && parts[0] === 'trim-audio') {
      if (method !== 'POST') {
        methodNotAllowed(res);
        return true;
      }
      await trimAudio(req, res, deps);
      return true;
    }
  } catch (error) {
    // 失败的响应也算「已处理」：restRouter 不会替我们兜错误
    fail(res, error);
    return true;
  }

  return false;
}
