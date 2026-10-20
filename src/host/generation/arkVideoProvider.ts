/**
 * 火山方舟（豆包 Seedance）**视频**生成适配器（host 半）。
 *
 * ## 为什么需要这一层
 *
 * 画布的视频节点 POST `/api/aifisher/canvas/generate-video`，请求体是 AIFISHER 自己的形状：
 *
 *   { prompt, videoModel: '豆包视频2.0', images: ['/api/aifisher/canvas/media/…'],
 *     videos: [], audios: [], aspectRatio: '16:9', resolution: '720p',
 *     videoMode: 'text-to-video' | 'i2v-first-last-frame' | 'multimodal', duration: 5,
 *     generate_audio: true, nodeId, projectId, … }
 *
 * 而方舟的视频是**异步任务**接口，形状完全不同（2026-10 核对，用户给的 curl 与方舟文档一致）：
 *
 *   POST {base}/contents/generations/tasks
 *     { model, content: [ {type:'text', text}, {type:'image_url', image_url:{url}, role:'reference_image'} … ],
 *       generate_audio, ratio, duration, resolution, watermark }
 *     → { id }
 *   GET  {base}/contents/generations/tasks/{id}
 *     → { id, status: 'queued'|'running'|'succeeded'|'failed'|'cancelled',
 *         content: { video_url }, error: { code, message }, usage: { completion_tokens, … } }
 *
 * 上游 AIFISHER 的 `豆包视频2.0` / `豆包视频2.0 fast` 两条目录记录（`DoubaoVideoProvider`）端点本来
 * 就指向方舟，模型 ID 也写在目录里 —— 单一只源，不另造一份模型表（与 arkImageProvider 同一原则）。
 *
 * ## content 里的 role（方舟对 Seedance 2.x 的定义）
 *
 *   - `first_frame` / `last_frame`：首帧 / 尾帧（首尾帧模式，最多各一张，且**不能**与参考素材混用）
 *   - `reference_image`：参考图（≤9 张）
 *   - `reference_video`：参考视频（≤3 条）
 *   - `reference_audio`：参考音频（≤3 条，且**必须**至少有一个视觉参考）
 *
 * 参考素材的形态限制（这条很关键，决定了「画布素材能不能直接喂」）：
 *   - 图片：`image_url.url` 可以吃 URL，也可以吃 `data:image/<格式>;base64,…`，
 *     所以本站素材**内联成 data URL** 就能用（方舟访问不到 127.0.0.1）；
 *   - 视频 / 音频：官方只收**公网可访问的 https 直链**，不吃 data URL，
 *     所以本站素材（`/api/aifisher/canvas/media/…`）会在这一层被明确拒掉，
 *     并说明「把参考视频/音频放到公网直链再连」—— 而不是发出去等方舟回一个看不懂的 400。
 *
 * ## 配置（与图片那条共用 ARK_API_KEY / ARK_BASE_URL）
 *
 *   ARK_API_KEY          必填（设置 → 闭源服务 → 火山方舟（豆包直连））
 *   ARK_BASE_URL         可选，默认 https://ark.cn-beijing.volces.com/api/v3
 *   ARK_VIDEO_PATH       可选，默认 /contents/generations/tasks
 *   ARK_VIDEO_TIMEOUT_MS 可选，轮询总预算，默认 900000（15 分钟）；未设则退到 ARK_TIMEOUT_MS
 *   ARK_WATERMARK        可选，'true'/'1' 时默认加水印（节点上的开关优先）
 *
 * 模型 ID 同样认界面的「自定义模型 ID」（`MODEL_ID_CUSTOM_<码点十六进制>`）—— 方舟的
 * 模型 ID 带日期后缀、账号也可能只开通了推理接入点（`ep-…`），换版本不用改代码。
 */
import type { ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { sendJson } from '../http/httpUtil';
import { VIDEO_MODELS } from '../../../vendor/aifisher/src/config/modelConfig';
import { modelOverrideKey } from '../../../vendor/aifisher/src/shared/modelOverrideKey';
import {
  ARK_DEFAULT_BASE_URL,
  ArkRequestError,
  arkErrorMessage,
  arkHint,
  readArkConfig,
  requestedModelName,
} from './arkImageProvider';
import {
  collectResultRefs,
  isObject,
  localizeCloudResult,
  type CloudGenerationDeps,
} from './cloudResult';

export const ARK_DEFAULT_VIDEO_PATH = '/contents/generations/tasks';
/** 认端点比认 provider 名更耐上游改名（与 arkImageProvider 同一判据）。 */
const ARK_HOST = 'ark.cn-beijing.volces.com';
/** 轮询总预算：Seedance 2.0 的 11s 片子实测常在 2–6 分钟，给足 15 分钟。 */
const DEFAULT_VIDEO_TIMEOUT_MS = 900_000;
/** 提交本身很快；给 2 分钟就够，别让一次挂住的 POST 吃掉整段预算。 */
const SUBMIT_TIMEOUT_MS = 120_000;
/** 单次轮询查询的超时：慢了就当这一次没回来，下一轮再问。 */
const POLL_REQUEST_TIMEOUT_MS = 30_000;
/** 轮询间隔：2s 起，每次 ×1.4，封顶 8s。 */
const POLL_START_MS = 2_000;
const POLL_MAX_MS = 8_000;
/** 连续失败几次才认输（与云端通道同一口径：轮询偶发断连不等于任务失败）。 */
const MAX_POLL_FAILURES = 8;

/** 方舟允许的分辨率档位（Seedance 2.x）。 */
const ALLOWED_RESOLUTIONS = ['480p', '720p', '1080p', '4k'] as const;
/** 方舟允许的宽高比；`adaptive` 由首尾帧决定。 */
const ALLOWED_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const;

const MAX_FRAME_IMAGES = 2;
const MAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_VIDEOS = 3;
const MAX_REFERENCE_AUDIOS = 3;
/** 单张参考图上限（方舟对图生视频的常见上限）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 内联成 data URL 后的请求体总量上限，防把几千万像素塞进一次 POST。 */
const MAX_INLINE_BYTES = 40 * 1024 * 1024;

const MODE_TEXT_TO_VIDEO = 'text-to-video';
const MODE_OMNI_TEXT_TO_VIDEO = 'omni-text-to-video';
const MODE_FIRST_FRAME = 'first-frame';
const MODE_OMNI_IMAGE_TO_VIDEO = 'omni-image-to-video';
const MODE_FIRST_LAST_FRAME = 'i2v-first-last-frame';
const MODE_MULTIMODAL = 'multimodal';
const MODE_REFERENCE_VIDEO = 'reference-video';
const MODE_VIDEO_EDIT = 'video-edit';
const MODE_MOTION_CONTROL = 'motion-control';

/** 这些模式的首图是**首帧**（而不是参考图）。 */
const FRAME_MODES: ReadonlySet<string> = new Set([
  MODE_FIRST_FRAME,
  MODE_OMNI_IMAGE_TO_VIDEO,
  MODE_FIRST_LAST_FRAME,
]);

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface ArkVideoConfig {
  apiKey: string;
  baseUrl: string;
  tasksPath: string;
  timeoutMs: number;
  watermark: boolean;
}

function truthy(value: string | undefined): boolean {
  const text = (value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'on' || text === 'yes';
}

/** 读环境变量（每次调用都读：界面保存后立刻生效，与图片那条一致）。 */
export function readArkVideoConfig(env: NodeJS.ProcessEnv = process.env): ArkVideoConfig {
  const image = readArkConfig(env);
  const rawTimeout = Number(env.ARK_VIDEO_TIMEOUT_MS ?? env.ARK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_VIDEO_TIMEOUT_MS;
  return {
    apiKey: image.apiKey,
    baseUrl: image.baseUrl,
    tasksPath: (env.ARK_VIDEO_PATH ?? '').trim() || ARK_DEFAULT_VIDEO_PATH,
    // 轮询预算尊重用户配置，只压一个 30 分钟上限（再长等于把宿主进程挂在那儿）。
    // 下限不夹：调试时想设 5 秒就设 5 秒，交给设的人自己承担。
    timeoutMs: Math.min(timeoutMs, 1_800_000),
    watermark: image.watermark,
  };
}

export function arkVideoConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(readArkVideoConfig(env).apiKey);
}

// ---------------------------------------------------------------------------
// 目录（模型表就在 vendor 的 modelConfig 里，不复制一份）
// ---------------------------------------------------------------------------

interface CatalogEndpoint {
  url?: string;
  model?: string;
}

export interface ArkVideoEntry {
  name: string;
  provider?: string;
  canonicalModel?: string;
  description?: string;
  maxInputs?: number;
  resolutions?: string[];
  aspectRatios?: string[];
  videoModes?: { value: string; label?: string; allowedInputs?: Record<string, number> }[];
  endpoint?: Record<string, CatalogEndpoint>;
  /** 目录里记的单价（元/秒）：数字或按分辨率档分档 */
  cost?: number | Record<string, number>;
  /** 该模型默认是否生成音频（上游目录里的同名字段） */
  generate_audio?: boolean;
}

/** 端点指向方舟的视频任务接口（或 provider 标着 DoubaoVideoProvider）的视频模型。 */
function isArkVideoEntry(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  if (entry.provider === 'DoubaoVideoProvider') return true;
  const endpoints = entry.endpoint;
  if (!isObject(endpoints)) return false;
  return Object.values(endpoints).some(
    (endpoint) =>
      isObject(endpoint) &&
      typeof endpoint.url === 'string' &&
      endpoint.url.includes(ARK_HOST) &&
      endpoint.url.includes('/contents/generations'),
  );
}

/** 画布目录里所有方舟视频模型（设置页 / 模型可用性共用）。 */
export function arkVideoEntries(): ArkVideoEntry[] {
  return (VIDEO_MODELS as unknown[]).filter(isArkVideoEntry) as unknown as ArkVideoEntry[];
}

export function findArkVideoEntry(name: unknown): ArkVideoEntry | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  const target = name.trim();
  return arkVideoEntries().find((entry) => entry.name === target) ?? null;
}

/** 方舟的模型 ID 直写（agent 可能直接给 `doubao-seedance-…`）—— 造一条等价记录。 */
function syntheticArkVideoEntry(modelId: string): ArkVideoEntry | null {
  if (!/^doubao-seedance/i.test(modelId)) return null;
  const endpoint = { url: `${ARK_DEFAULT_BASE_URL}${ARK_DEFAULT_VIDEO_PATH}`, model: modelId };
  return {
    name: modelId,
    provider: 'DoubaoVideoProvider',
    resolutions: [...ALLOWED_RESOLUTIONS],
    aspectRatios: [...ALLOWED_RATIOS],
    videoModes: [
      { value: MODE_TEXT_TO_VIDEO },
      { value: MODE_FIRST_FRAME },
      { value: MODE_FIRST_LAST_FRAME },
      { value: MODE_MULTIMODAL },
    ],
    endpoint: {
      [MODE_TEXT_TO_VIDEO]: endpoint,
      [MODE_FIRST_FRAME]: endpoint,
      [MODE_FIRST_LAST_FRAME]: endpoint,
      [MODE_MULTIMODAL]: endpoint,
    },
  };
}

/** 这条记录真正会发给方舟的模型 ID：界面「自定义模型 ID」优先，其次目录里该模式的端点。 */
export function arkVideoModelIdOf(entry: ArkVideoEntry, mode = MODE_TEXT_TO_VIDEO): string {
  const override = (process.env[modelOverrideKey(entry.name)] ?? '').trim();
  if (override) return override;
  return (
    entry.endpoint?.[mode]?.model ??
    entry.endpoint?.[MODE_TEXT_TO_VIDEO]?.model ??
    Object.values(entry.endpoint ?? {})[0]?.model ??
    ''
  );
}

export interface ArkVideoTarget {
  entry: ArkVideoEntry;
  modelId: string;
  requested: string;
}

/** 这次 generate-video 该不该走方舟？该走就返回目标记录，否则 null（交给通道那套）。 */
export function findArkVideoTarget(body: Record<string, unknown> | null): ArkVideoTarget | null {
  const requested = requestedModelName(body);
  if (!requested) return null;
  const entry = findArkVideoEntry(requested) ?? syntheticArkVideoEntry(requested);
  if (!entry) return null;
  const modelId = arkVideoModelIdOf(entry, requestedVideoMode(body, entry));
  if (!modelId) return null;
  return { entry, modelId, requested };
}

export function isArkVideoModel(name: unknown): boolean {
  return findArkVideoEntry(name) !== null;
}

// ---------------------------------------------------------------------------
// 费用预估（画布视频 composer 显示「单价 × 时长」）
// ---------------------------------------------------------------------------

const ARK_VIDEO_PRICE_NOTE = '火山方舟官方价（元/秒），以方舟账单为准';

export interface ArkVideoPriceEstimate {
  /** 元/秒；给不出可靠数字时 null（画布显示「价格未知」，不编） */
  price: number | null;
  note: string;
}

function catalogSecondPrice(entry: ArkVideoEntry, resolution: string): number | null {
  const cost = entry.cost;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) return cost;
  if (!cost || typeof cost !== 'object') return null;
  const exact = cost[resolution];
  if (typeof exact === 'number' && Number.isFinite(exact)) return exact;
  const values = Object.values(cost).filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  return values.length ? values[0] : null;
}

/**
 * 画布下发的**每秒**单价预估（画布自己再乘时长与数量）。
 *
 * 方舟视频按「档位 + 时长」计费，目录里上游记的就是「元/秒」的分档价，所以这里直接用，
 * 不自己编公式；档位不在表里就退到第一条价并说明。
 */
export function arkVideoPriceFor(
  entry: ArkVideoEntry,
  input: { resolution?: unknown; duration?: unknown } = {},
): ArkVideoPriceEstimate {
  const known = entry.resolutions ?? [...ALLOWED_RESOLUTIONS];
  const requested = typeof input.resolution === 'string' ? input.resolution.trim() : '';
  const resolution = known.includes(requested) ? requested : (known[0] ?? '720p');
  const price = catalogSecondPrice(entry, resolution);
  if (price === null) return { price: null, note: '价格未知：以方舟账单为准' };
  const duration = Number(input.duration);
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : null;
  return {
    price,
    note: seconds
      ? `${ARK_VIDEO_PRICE_NOTE}（${resolution} × ${seconds}s ≈ ${(price * seconds).toFixed(2)} 元）`
      : `${ARK_VIDEO_PRICE_NOTE}（${resolution} 档 ${price} 元/秒）`,
  };
}

// ---------------------------------------------------------------------------
// 请求体翻译
// ---------------------------------------------------------------------------

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}

function modeLabel(mode: string): string {
  return (
    {
      [MODE_TEXT_TO_VIDEO]: '文生视频',
      [MODE_OMNI_TEXT_TO_VIDEO]: '文生视频',
      [MODE_FIRST_FRAME]: '首帧',
      [MODE_OMNI_IMAGE_TO_VIDEO]: '首帧',
      [MODE_FIRST_LAST_FRAME]: '首尾帧',
      [MODE_MULTIMODAL]: '多模态',
      [MODE_REFERENCE_VIDEO]: '视频参考',
      [MODE_VIDEO_EDIT]: '视频编辑',
      [MODE_MOTION_CONTROL]: '动作控制',
    } as Record<string, string>
  )[mode] ?? mode;
}

/**
 * 这次该按哪个模式翻。
 *
 * 画布会把 `effectiveVideoMode()` 的结果放在 `videoMode` 里（已经按模型声明的词表解析过），
 * 但 agent 直接调用时可能只给连接素材，所以缺省时按「连了什么」自己推：
 * 有视频/音频 → 多模态；没有图 → 文生视频；有图 → 首帧（该模型声明了首帧模式时）否则多模态。
 */
export function requestedVideoMode(
  body: Record<string, unknown> | null,
  entry?: ArkVideoEntry | null,
): string {
  const declared = typeof body?.videoMode === 'string' ? body.videoMode.trim() : '';
  const supported = new Set((entry?.videoModes ?? []).map((item) => item.value));
  if (declared && (!supported.size || supported.has(declared))) return declared;
  const images = stringList(body?.images);
  const videos = stringList(body?.videos);
  const audios = stringList(body?.audios);
  if (videos.length || audios.length) {
    return supported.has(MODE_MULTIMODAL) || !supported.size ? MODE_MULTIMODAL : MODE_REFERENCE_VIDEO;
  }
  if (!images.length) return MODE_TEXT_TO_VIDEO;
  if (images.length >= 2 && supported.has(MODE_FIRST_LAST_FRAME)) return MODE_FIRST_LAST_FRAME;
  if (supported.has(MODE_FIRST_FRAME)) return MODE_FIRST_FRAME;
  if (supported.has(MODE_FIRST_LAST_FRAME)) return MODE_FIRST_LAST_FRAME;
  return MODE_MULTIMODAL;
}

interface ContentPart {
  type: 'text' | 'image_url' | 'video_url' | 'audio_url';
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
  role?: string;
}

export interface ArkVideoMedia {
  /** 已内联成 data URL（或本来就是公网 URL）的图片，顺序＝画布连线顺序 */
  images: string[];
  /** 参考视频 / 音频：只能是一条条公网直链 */
  videos: string[];
  audios: string[];
}

export interface ArkVideoPayloadResult {
  payload: Record<string, unknown>;
  notes: string[];
  /** 回执里给画布/日志看 */
  mode: string;
  ratio: string;
  resolution: string;
  duration: number;
}

/** 画布请求 → 方舟视频任务请求体。纯函数（素材已解析好），方便单测。 */
export function buildArkVideoPayload(input: {
  entry: ArkVideoEntry;
  modelId: string;
  body: Record<string, unknown>;
  media: ArkVideoMedia;
  config: Pick<ArkVideoConfig, 'watermark'>;
}): ArkVideoPayloadResult {
  const { entry, modelId, body, media, config } = input;
  const notes: string[] = [];
  const mode = requestedVideoMode(body, entry);
  const declaredMode = typeof body.videoMode === 'string' ? body.videoMode.trim() : '';
  if (declaredMode && declaredMode !== mode) {
    notes.push(
      `视频模式「${declaredMode}」不在该模型声明的词表里，已按 ${modeLabel(mode)} 提交`,
    );
  }
  if (!Number.isFinite(Number(body.duration)) && body.duration !== undefined) {
    notes.push(`未识别的时长「${String(body.duration)}」，已按默认值提交`);
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const content: ContentPart[] = [];
  if (prompt) content.push({ type: 'text', text: prompt });

  const frames = mode === MODE_FIRST_LAST_FRAME;
  let frameImages = 0;
  let referenceImages = 0;
  if (FRAME_MODES.has(mode)) {
    if (!media.images.length) {
      throw new ArkRequestError(
        `该模式（${modeLabel(mode)}）需要至少一张图作首帧，节点上还没连接图片。`,
        422,
        'ARK_FRAME_REQUIRED',
      );
    }
    const wanted = frames ? MAX_FRAME_IMAGES : 1;
    if (media.images.length > wanted && frames) {
      throw new ArkRequestError(
        `首尾帧模式最多连接 ${MAX_FRAME_IMAGES} 张图（首帧 + 尾帧），已连接 ${media.images.length} 张。`,
        422,
        'ARK_INPUT_COUNT_EXCEEDED',
      );
    }
    content.push({ type: 'image_url', image_url: { url: media.images[0] }, role: 'first_frame' });
    frameImages = 1;
    if (frames && media.images[1]) {
      content.push({ type: 'image_url', image_url: { url: media.images[1] }, role: 'last_frame' });
      frameImages = 2;
    }
    // 首帧之外多出来的图按参考图处理（首尾帧模式不允许，前面已经拒掉了）
    for (const url of media.images.slice(frameImages)) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
      referenceImages += 1;
    }
  } else {
    for (const url of media.images) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
      referenceImages += 1;
    }
  }

  const hasLastFrame = content.some((part) => part.role === 'last_frame');
  if (hasLastFrame && (media.videos.length || media.audios.length || referenceImages)) {
    throw new ArkRequestError(
      '首尾帧（尾帧）不能与参考图 / 参考视频 / 参考音频同时使用：请拆成两次生成，或去掉尾帧。',
      422,
      'ARK_MODE_CONFLICT',
    );
  }
  if (referenceImages > MAX_REFERENCE_IMAGES) {
    throw new ArkRequestError(
      `该模型最多支持 ${MAX_REFERENCE_IMAGES} 张参考图，已连接 ${referenceImages} 张，请调整后重试。`,
      422,
      'ARK_INPUT_COUNT_EXCEEDED',
    );
  }
  if (media.videos.length > MAX_REFERENCE_VIDEOS) {
    throw new ArkRequestError(
      `该模型最多支持 ${MAX_REFERENCE_VIDEOS} 条参考视频，已连接 ${media.videos.length} 条。`,
      422,
      'ARK_INPUT_COUNT_EXCEEDED',
    );
  }
  if (media.audios.length > MAX_REFERENCE_AUDIOS) {
    throw new ArkRequestError(
      `该模型最多支持 ${MAX_REFERENCE_AUDIOS} 条参考音频，已连接 ${media.audios.length} 条。`,
      422,
      'ARK_INPUT_COUNT_EXCEEDED',
    );
  }
  for (const url of media.videos) {
    content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
  }
  for (const url of media.audios) {
    content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
  }
  // 方舟：参考音频必须搭配视觉参考（首帧或参考图/视频），否则直接拒
  if (media.audios.length && !media.images.length && !media.videos.length) {
    throw new ArkRequestError(
      '参考音频必须搭配至少一张图（首帧/参考图）或一条参考视频，单独给音频方舟不接受。',
      422,
      'ARK_AUDIO_WITHOUT_VISUAL',
    );
  }
  if (!prompt) {
    throw new ArkRequestError(
      '方舟视频生成需要提示词（Prompt）；请先在节点上写提示词或连接文本节点。',
      422,
      'ARK_PROMPT_REQUIRED',
    );
  }

  // 分辨率：只认方舟的四个档；不认识的按 720p（该模型目录里的默认档，也是 Seedance 的默认）并说明
  const knownResolutions = entry.resolutions ?? [...ALLOWED_RESOLUTIONS];
  const requestedResolution =
    typeof body.resolution === 'string' ? body.resolution.trim() : '';
  const fallbackResolution = knownResolutions.includes('720p')
    ? '720p'
    : (knownResolutions.find((item) => (ALLOWED_RESOLUTIONS as readonly string[]).includes(item)) ??
      '720p');
  const resolution = knownResolutions.includes(requestedResolution)
    ? requestedResolution
    : fallbackResolution;
  if (requestedResolution && resolution !== requestedResolution) {
    notes.push(`分辨率「${requestedResolution}」不在该模型支持的档位内，已按 ${resolution} 提交`);
  }

  // 比例：有首尾帧时由画面决定，其余按节点选的（不在词表里退 16:9）
  const requestedRatio = typeof body.aspectRatio === 'string' ? body.aspectRatio.trim() : '';
  let ratio = '16:9';
  if (frameImages) {
    ratio = 'adaptive';
    if (requestedRatio && requestedRatio !== 'adaptive') {
      notes.push('首帧/尾帧模式下比例由画面决定（adaptive），节点上的比例设置不参与提交');
    }
  } else if ((ALLOWED_RATIOS as readonly string[]).includes(requestedRatio)) {
    ratio = requestedRatio;
  } else if (requestedRatio) {
    notes.push(`比例「${requestedRatio}」不在方舟支持的范围内，已按 16:9 提交`);
  }

  // 时长：方舟按整数秒；目录给的滑块范围是 4–15，越界就夹取并说明
  const rawDuration = Number(body.duration);
  const duration = Number.isFinite(rawDuration)
    ? Math.min(15, Math.max(4, Math.round(rawDuration)))
    : 5;
  if (Number.isFinite(rawDuration) && duration !== Math.round(rawDuration)) {
    notes.push(`时长 ${Math.round(rawDuration)}s 超出方舟支持范围（4–15s），已按 ${duration}s 提交`);
  }

  const payload: Record<string, unknown> = {
    model: modelId,
    content,
    resolution,
    ratio,
    duration,
    generate_audio:
      typeof body.generate_audio === 'boolean'
        ? body.generate_audio
        : body.generate_audio === undefined
          ? entry.generate_audio !== false
          : Boolean(body.generate_audio),
    watermark: typeof body.watermark === 'boolean' ? body.watermark : config.watermark,
  };

  return { payload, notes, mode, ratio, resolution, duration };
}

// ---------------------------------------------------------------------------
// 参考素材：图片内联成 data URL；视频/音频只认公网直链
// ---------------------------------------------------------------------------

const FORMAT_OF_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  '.gif': 'gif',
  '.bmp': 'bmp',
});

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * 一张图 → 方舟能拿到的形式。
 *
 * 本站素材（`/api/aifisher/canvas/media/…`）方舟访问不到，所以读字节内联成
 * `data:image/<小写格式>;base64,…`；本来就是 data URL 或外链的照原样。
 */
async function inlineImage(
  value: string,
  deps: CloudGenerationDeps,
  total: { bytes: number },
): Promise<string> {
  const trimmed = value.trim();
  if (trimmed.startsWith('data:')) return trimmed;
  const mediaStore = deps.mediaStore;
  const local = mediaStore?.localPathForUrl(trimmed) ?? null;
  if (!local) {
    // 不是本站素材：外链原样交给方舟；既不是外链也不是本站素材 → 明说
    if (isHttpUrl(trimmed)) return trimmed;
    throw new ArkRequestError(
      `参考素材不是本站素材，也不是方舟能访问的 URL：${trimmed}。请把素材先上传到画布素材库。`,
      422,
      'ARK_REFERENCE_UNREACHABLE',
    );
  }
  const read = await mediaStore!.readBytesForUrl(trimmed);
  if (!read) {
    throw new ArkRequestError(
      `参考素材已不在素材库里：${local.filename}。请重新选一张（从画布上重新连一次参考图，或重新上传）。`,
      404,
      'ARK_REFERENCE_MISSING',
    );
  }
  const bytes = read.bytes;
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ArkRequestError(
      `参考图 ${read.filename} 超过单张上限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB。`,
      413,
      'ARK_REFERENCE_TOO_LARGE',
    );
  }
  total.bytes += bytes.byteLength;
  if (total.bytes > MAX_INLINE_BYTES) {
    throw new ArkRequestError(
      `参考图总量超过 ${Math.round(MAX_INLINE_BYTES / 1024 / 1024)}MB 上限，请减少参考图或压缩后再试。`,
      413,
      'ARK_REFERENCES_TOO_LARGE',
    );
  }
  const format = FORMAT_OF_EXTENSION[extname(read.filename).toLowerCase()] ?? 'png';
  return `data:image/${format};base64,${bytes.toString('base64')}`;
}

/**
 * 参考视频 / 音频 → 方舟能拿到的形式。
 *
 * 官方只收公网 https 直链（不吃 data URL），所以本站素材在这里**明确拒绝**，
 * 说清楚「怎么办」而不是让方舟回一个看不懂的 400。
 */
function publicReference(value: string, label: '参考视频' | '参考音频', deps: CloudGenerationDeps): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('data:')) {
    throw new ArkRequestError(
      `方舟不接受 ${label}的 data URL（内容内联）：请把这条素材放到公网可访问的 http(s) 直链，或改用参考图。`,
      422,
      'ARK_REFERENCE_UNREACHABLE',
    );
  }
  const local = deps.mediaStore?.localPathForUrl(trimmed) ?? null;
  if (local) {
    throw new ArkRequestError(
      `${label}需要公网可直链：画布素材 ${local.filename} 只存在本机，方舟访问不到。` +
        '请把这条素材放到公网 http(s) 直链后，用「网络素材」连进来；或者改用参考图（图片支持内联）。',
      422,
      'ARK_REFERENCE_UNREACHABLE',
    );
  }
  if (!isHttpUrl(trimmed)) {
    throw new ArkRequestError(
      `${label}不是方舟能访问的 URL：${trimmed}。请给公网 http(s) 直链。`,
      422,
      'ARK_REFERENCE_UNREACHABLE',
    );
  }
  return trimmed;
}

/** 把节点上连的素材解析成「方舟能吃的形态」；问题都在这里当场抛清楚。 */
export async function resolveArkVideoMedia(
  body: Record<string, unknown>,
  deps: CloudGenerationDeps,
): Promise<ArkVideoMedia & { notes: string[] }> {
  const notes: string[] = [];
  const total = { bytes: 0 };
  const rawImages = stringList(body.images);
  const images: string[] = [];
  for (const value of rawImages) images.push(await inlineImage(value, deps, total));
  if (total.bytes) {
    const size = total.bytes >= 1024 * 1024
      ? `${(total.bytes / 1024 / 1024).toFixed(1)}MB`
      : `${Math.max(1, Math.round(total.bytes / 1024))}KB`;
    notes.push(`参考图已内联成 data URL 提交（${size}）：方舟访问不到本机素材。`);
  }
  const videos = stringList(body.videos).map((value) => publicReference(value, '参考视频', deps));
  const audios = stringList(body.audios).map((value) => publicReference(value, '参考音频', deps));
  return { images, videos, audios, notes };
}

// ---------------------------------------------------------------------------
// 任务提交与轮询
// ---------------------------------------------------------------------------

interface ArkCallResult {
  ok: boolean;
  status: number;
  parsed: unknown;
  raw: string;
}

async function arkJson(
  target: string,
  init: { method: 'GET' | 'POST'; body?: unknown; apiKey: string; timeoutMs: number },
  fetcher: typeof fetch,
): Promise<ArkCallResult> {
  let response: Response;
  try {
    response = await fetcher(target, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${init.apiKey}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (error) {
    throw Object.assign(
      new Error(`方舟端点不可达：${error instanceof Error ? error.message : String(error)}`),
      { code: 'ARK_UNREACHABLE', status: 502, endpoint: target },
    );
  }
  const raw = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { ok: response.ok, status: response.status, parsed, raw };
}

/** 方舟任务状态 → 我们认的三态（认不出的继续轮询，别把 queued 当失败）。 */
export function arkTaskState(parsed: unknown): 'queued' | 'succeeded' | 'failed' | 'unknown' {
  if (!isObject(parsed)) return 'unknown';
  const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
  if (status === 'succeeded' || status === 'success' || status === 'completed') return 'succeeded';
  if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'error') {
    return 'failed';
  }
  if (status === 'queued' || status === 'running' || status === 'pending' || status === 'processing') {
    return 'queued';
  }
  return 'unknown';
}

function arkTaskFailureReason(parsed: unknown): string {
  if (!isObject(parsed)) return '';
  if (isObject(parsed.error)) {
    const message = typeof parsed.error.message === 'string' ? parsed.error.message : '';
    const code = typeof parsed.error.code === 'string' ? parsed.error.code : '';
    if (message) return code ? `${message}（${code}）` : message;
  }
  if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  return '';
}

/** 任务成功后从收尾响应里取视频 URL（方舟是 `content.video_url`，兜底走通用归一）。 */
export function arkVideoUrlOf(parsed: unknown): string | null {
  if (isObject(parsed)) {
    const content = parsed.content;
    if (isObject(content) && typeof content.video_url === 'string' && content.video_url.trim()) {
      return content.video_url.trim();
    }
  }
  const ref = collectResultRefs(parsed).find((item) => item.url);
  return ref?.url ?? null;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 处理一条走方舟的 `generate-video`。已处理返回 true（本函数总是自己回响应）。 */
export async function handleArkVideoGeneration(
  body: Record<string, unknown>,
  res: ServerResponse,
  deps: CloudGenerationDeps,
  target: ArkVideoTarget,
): Promise<boolean> {
  const config = readArkVideoConfig();
  if (!config.apiKey) {
    sendJson(res, 501, {
      error:
        '火山方舟（豆包）视频生成未配置：请在画布「设置 → 闭源服务 → 火山方舟（豆包直连）」里填 API Key，' +
        '或给 DSH 进程设置 ARK_API_KEY 后重启。',
      code: 'ARK_NOT_CONFIGURED',
      model: target.entry.name,
    });
    return true;
  }

  const fetcher = deps.fetcher ?? globalThis.fetch;
  const endpoint = `${config.baseUrl}${config.tasksPath}`;
  let media: ArkVideoMedia & { notes: string[] };
  let plan: ArkVideoPayloadResult;
  try {
    media = await resolveArkVideoMedia(body, deps);
    plan = buildArkVideoPayload({
      entry: target.entry,
      modelId: target.modelId,
      body,
      media,
      config,
    });
  } catch (error) {
    if (error instanceof ArkRequestError) {
      sendJson(res, error.status, {
        error: error.message,
        code: error.code,
        model: target.modelId,
        requestedModel: target.requested,
      });
      return true;
    }
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : '方舟视频请求构造失败。',
      code: 'ARK_REQUEST_FAILED',
    });
    return true;
  }

  let submitted: ArkCallResult;
  try {
    submitted = await arkJson(
      endpoint,
      { method: 'POST', body: plan.payload, apiKey: config.apiKey, timeoutMs: SUBMIT_TIMEOUT_MS },
      fetcher,
    );
  } catch (error) {
    sendJson(res, 502, {
      error: error instanceof Error ? error.message : '方舟视频任务提交失败。',
      code: 'ARK_UNREACHABLE',
      endpoint,
      model: target.modelId,
    });
    return true;
  }
  if (!submitted.ok) {
    const { message, code } = arkErrorMessage(submitted.parsed, submitted.raw, submitted.status);
    const hint = arkHint(submitted.status, code, target.modelId);
    sendJson(res, 502, {
      error: `方舟视频任务提交失败（HTTP ${submitted.status}）：${message}`,
      code: 'ARK_UPSTREAM_ERROR',
      upstreamStatus: submitted.status,
      ...(code ? { upstreamCode: code } : {}),
      endpoint,
      model: target.modelId,
      ...(hint ? { hint } : {}),
      raw: isObject(submitted.parsed) ? submitted.parsed : submitted.raw.slice(0, 400),
    });
    return true;
  }
  const taskId = isObject(submitted.parsed) && typeof submitted.parsed.id === 'string'
    ? submitted.parsed.id
    : '';
  if (!taskId) {
    sendJson(res, 502, {
      error: '方舟没有返回任务号（既没有 id 也没有可识别的结果），无法轮询。',
      code: 'ARK_RESULT_UNRECOGNIZED',
      endpoint,
      model: target.modelId,
      raw: isObject(submitted.parsed) ? submitted.parsed : submitted.raw.slice(0, 400),
    });
    return true;
  }

  // ---- 轮询到收尾 ----
  const pollUrl = `${endpoint}/${encodeURIComponent(taskId)}`;
  const deadline = Date.now() + config.timeoutMs;
  let interval = POLL_START_MS;
  let failures = 0;
  let last: unknown = null;
  for (;;) {
    if (Date.now() > deadline) {
      sendJson(res, 504, {
        error:
          `方舟视频任务在 ${Math.round(config.timeoutMs / 1000)}s 内没有结束（任务号 ${taskId}）。` +
          '它可能还在跑：稍后到方舟控制台「视频生成」里看这条任务的结果，别急着重发（会重复计费）。',
        code: 'ARK_VIDEO_TIMEOUT',
        taskId,
        endpoint,
        model: target.modelId,
      });
      return true;
    }
    await new Promise((done) => setTimeout(done, interval));
    interval = Math.min(Math.round(interval * 1.4), POLL_MAX_MS);
    let queried: ArkCallResult;
    try {
      queried = await arkJson(
        pollUrl,
        { method: 'GET', apiKey: config.apiKey, timeoutMs: POLL_REQUEST_TIMEOUT_MS },
        fetcher,
      );
    } catch (error) {
      failures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      if (failures >= MAX_POLL_FAILURES) {
        sendJson(res, 502, {
          error:
            `查询方舟视频任务状态连续 ${failures} 次失败：${reason}（任务号 ${taskId}，可能还在跑；它已经计费，别急着重发）。`,
          code: 'ARK_UNREACHABLE',
          taskId,
          endpoint,
          model: target.modelId,
        });
        return true;
      }
      console.warn(
        `[aifisher-canvas] 方舟视频轮询第 ${failures} 次失败，稍后重试：${reason}`,
      );
      continue;
    }
    last = queried.parsed;
    if (!queried.ok) {
      // 5xx / 429 是网关抖动：跟「这一次没回来」一样按可重试处理
      if (queried.status >= 500 || queried.status === 429) {
        failures += 1;
        if (failures < MAX_POLL_FAILURES) {
          console.warn(
            `[aifisher-canvas] 方舟视频轮询拿到 HTTP ${queried.status}，稍后重试`,
          );
          continue;
        }
      }
      const { message, code } = arkErrorMessage(queried.parsed, queried.raw, queried.status);
      sendJson(res, 502, {
        error: `查询方舟视频任务状态失败（HTTP ${queried.status}）：${message}`,
        code: 'ARK_UPSTREAM_ERROR',
        upstreamStatus: queried.status,
        ...(code ? { upstreamCode: code } : {}),
        taskId,
        endpoint,
        model: target.modelId,
      });
      return true;
    }
    failures = 0;
    const state = arkTaskState(queried.parsed);
    if (state === 'failed') {
      const reason = arkTaskFailureReason(queried.parsed);
      sendJson(res, 502, {
        error: `方舟视频任务失败${reason ? `：${reason}` : '（方舟没给原因）'}。`,
        code: 'ARK_VIDEO_FAILED',
        taskId,
        endpoint,
        model: target.modelId,
        ...(isObject(queried.parsed) && isObject(queried.parsed.error)
          ? { upstreamCode: String((queried.parsed.error as Record<string, unknown>).code ?? '') }
          : {}),
      });
      return true;
    }
    if (state === 'succeeded') break;
  }

  const videoUrl = arkVideoUrlOf(last);
  if (!videoUrl) {
    sendJson(res, 502, {
      error: '方舟任务成功了，但收尾响应里没有可识别的视频地址（content.video_url）。',
      code: 'ARK_RESULT_UNRECOGNIZED',
      taskId,
      endpoint,
      model: target.modelId,
      raw: isObject(last) ? last : '',
    });
    return true;
  }

  const projectId =
    typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : 'default';
  const nodeId = typeof body.nodeId === 'string' && body.nodeId ? body.nodeId : undefined;
  const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
  const url = await localizeCloudResult(
    'video',
    { url: videoUrl },
    {
      projectId,
      ...(nodeId ? { nodeId } : {}),
      ...(prompt ? { prompt } : {}),
      model: target.modelId,
      provider: 'ark',
    },
    deps,
  );
  if (!url) {
    sendJson(res, 502, { error: '方舟视频结果无法落盘。', code: 'ARK_RESULT_UNRECOGNIZED', taskId });
    return true;
  }

  sendJson(res, 200, {
    success: true,
    provider: 'ark',
    model: target.modelId,
    requestedModel: target.requested,
    taskId,
    resultUrl: url,
    resultUrls: [url],
    mode: plan.mode,
    ratio: plan.ratio,
    resolution: plan.resolution,
    duration: plan.duration,
    ...(media.notes.length || plan.notes.length ? { notes: [...media.notes, ...plan.notes] } : {}),
    ...(isObject(last) && isObject(last.usage) ? { usage: last.usage } : {}),
  });
  return true;
}

// ---------------------------------------------------------------------------
// 诊断 / 设置页
// ---------------------------------------------------------------------------

export function arkVideoStatus(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const config = readArkVideoConfig(env);
  return {
    configured: Boolean(config.apiKey),
    baseUrl: config.baseUrl,
    tasksPath: config.tasksPath,
    timeoutMs: config.timeoutMs,
    watermark: config.watermark,
    models: arkVideoEntries().map((entry) => ({
      name: entry.name,
      defaultModelId: entry.endpoint?.[MODE_TEXT_TO_VIDEO]?.model ?? null,
      modelId: (env[modelOverrideKey(entry.name)] ?? '').trim() || null,
    })),
  };
}
