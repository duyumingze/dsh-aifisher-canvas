/**
 * 火山方舟（豆包 Seedream）图片生成适配器（host 半）。
 *
 * ## 为什么需要这一层
 *
 * 画布的图片节点一律 POST `/api/aifisher/canvas/generate-image`，请求体是**AIFISHER 自己的形状**：
 *
 *   { prompt, imageModel: '豆包图片5.0-pro(方舟直连)', resolution: '2K', aspectRatio: '16:9',
 *     imageBase64: ['/api/aifisher/canvas/media/<项目>/images/<文件>'], imageMode: 'image-to-image',
 *     generateCount: 1, watermark: false, nodeId, projectId, … }
 *
 * 而方舟的 `/api/v3/images/generations` 要的是另一套：
 *
 *   { model, prompt, image, size, response_format, watermark, stream, layer_decomposition,
 *     sequential_image_generation(_options), tools }
 *
 * 上游 AIFISHER server 里每个 provider 各有一份这样的翻译；本插件只补**方舟**这一份，
 * 因为画布目录里那几条 `DoubaoImageProvider` 记录的端点本来就是 ark.cn-beijing.volces.com
 * （`豆包图片4.0(多参考)` / `4.5(多参考)` / `5.0-lite`，以及 vendor 补丁追加的 `5.0-pro(方舟直连)`），
 * 模型 ID 也写在目录里 —— 单一只源，不另造一份模型表。
 *
 * 文档依据（2026-10 核对）：
 *   - 端点 POST https://ark.cn-beijing.volces.com/api/v3/images/generations，Bearer 鉴权；
 *   - `size` 两种方式不可混用：①档位 1K/1.5K/2K（5.0 pro）/2K/3K/4K（5.0 lite）/2K/4K（4.5）/
 *     1K/2K/4K（4.0）；②宽x高像素值 + 总像素与宽高比范围限制；
 *   - `image` 支持 URL 或 `data:image/<小写格式>;base64,<…>`；单图字符串、多图数组；
 *   - `response_format` 默认 url（**24 小时失效**，所以要立刻下载进素材库）；
 *   - `watermark` 默认 true（右下角「AI 生成」），画布默认关掉，可由节点上的开关打开；
 *   - 组图（`sequential_image_generation=auto` + `max_images`）只有 5.0 lite / 4.5 / 4.0 支持，
 *     5.0 pro 不支持 —— 那种情况我们并发发 N 次请求再合并结果；
 *   - 图层拆分 `layer_decomposition` 只有 5.0 pro 支持，且 `size` 只能用档位。
 *
 * ## 配置
 *
 *   ARK_API_KEY       必填（界面：设置 → 闭源服务 → 火山方舟（豆包直连））
 *   ARK_BASE_URL      可选，默认 https://ark.cn-beijing.volces.com/api/v3
 *   ARK_IMAGE_PATH    可选，默认 /images/generations
 *   ARK_TIMEOUT_MS    可选，默认 600000
 *   ARK_WATERMARK     可选，'true'/'1' 时默认加水印（节点上的开关优先）
 *
 * 模型 ID 默认取目录里 `endpoint[模式].model`；界面上「自定义模型 ID」存下来的
 * `MODEL_ID_CUSTOM_<码点十六进制>` 会覆盖它（方舟的模型 ID 带日期后缀，用户换版本不用改代码）。
 *
 * 未配置 ARK_API_KEY 时回 501 `ARK_NOT_CONFIGURED` —— 画布上那几条方舟模型在设置页填 Key
 * 之前不会出现在模型下拉里，所以这个 501 主要出现在「旧节点 + 没配 Key」和 agent 直接调用时。
 */
import type { ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { sendJson } from '../http/httpUtil';
import { IMAGE_MODELS } from '../../../vendor/aifisher/src/config/modelConfig';
import { modelOverrideKey } from '../../../vendor/aifisher/src/shared/modelOverrideKey';
import {
  collectResultRefs,
  isObject,
  localizeCloudResult,
  type CloudGenerationDeps,
} from './cloudResult';

export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const ARK_DEFAULT_IMAGE_PATH = '/images/generations';
/** 目录里这几条记录的端点就是这个 host —— 认它比认 provider 名更耐上游改名。 */
const ARK_HOST = 'ark.cn-beijing.volces.com';
const DEFAULT_TIMEOUT_MS = 600_000;
/** 单次请求最多并发几条（5.0 pro 不支持组图时，N 张就是 N 次请求）。 */
const MAX_PARALLEL_REQUESTS = 4;
/** 一次请求最多带几张参考图（目录里的 maxInputs 缺省值）。 */
const DEFAULT_MAX_INPUTS = 10;
/** 单张参考图上限（目录里的 maxImageSizeMb 缺省值）。 */
const DEFAULT_MAX_IMAGE_MB = 10;
/** 内联成 data URL 后的请求体上限，防把几千万像素塞进一次 POST。 */
const MAX_INLINE_BYTES = 28 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface ArkConfig {
  apiKey: string;
  baseUrl: string;
  imagePath: string;
  timeoutMs: number;
  watermark: boolean;
}

function truthy(value: string | undefined): boolean {
  const text = (value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'on' || text === 'yes';
}

/** 读环境变量（每次调用都读：界面保存后立刻生效）。 */
export function readArkConfig(env: NodeJS.ProcessEnv = process.env): ArkConfig {
  const rawTimeout = Number(env.ARK_TIMEOUT_MS);
  return {
    apiKey: (env.ARK_API_KEY ?? '').trim(),
    baseUrl: (env.ARK_BASE_URL ?? '').trim().replace(/\/+$/, '') || ARK_DEFAULT_BASE_URL,
    imagePath: (env.ARK_IMAGE_PATH ?? '').trim() || ARK_DEFAULT_IMAGE_PATH,
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS,
    watermark: truthy(env.ARK_WATERMARK),
  };
}

export function arkConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(readArkConfig(env).apiKey);
}

// ---------------------------------------------------------------------------
// 目录（模型表就在 vendor 的 modelConfig 里，不复制一份）
// ---------------------------------------------------------------------------

interface CatalogEndpoint {
  url?: string;
  model?: string;
}

export interface ArkCatalogEntry {
  name: string;
  provider?: string;
  source?: string;
  maxInputs?: number;
  maxImageSizeMb?: number;
  supportedImageFormats?: string[];
  resolutions?: string[];
  imageModes?: { value: string; label?: string }[];
  endpoint?: Record<string, CatalogEndpoint>;
  /** 上游目录里记的单价（元/张）：数字或按分辨率档分档 */
  cost?: number | Record<string, number>;
}

/** 端点指向方舟（或 provider 标着 DoubaoImageProvider）的图片模型。 */
function isArkEntry(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  if (entry.provider === 'DoubaoImageProvider') return true;
  const endpoints = entry.endpoint;
  if (!isObject(endpoints)) return false;
  return Object.values(endpoints).some(
    (endpoint) => isObject(endpoint) && typeof endpoint.url === 'string' && endpoint.url.includes(ARK_HOST),
  );
}

/** 画布目录里所有方舟图片模型（设置页/模型可用性共用）。 */
export function arkImageEntries(): ArkCatalogEntry[] {
  return (IMAGE_MODELS as unknown[]).filter(isArkEntry) as unknown as ArkCatalogEntry[];
}

export function findArkImageEntry(name: unknown): ArkCatalogEntry | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  const target = name.trim();
  return arkImageEntries().find((entry) => entry.name === target) ?? null;
}

/** 方舟的模型 ID 直写（agent 可能直接给 `doubao-seedream-…`）—— 造一条等价记录。 */
function syntheticArkEntry(modelId: string): ArkCatalogEntry | null {
  // 只认图片模型：seedance 是方舟的视频模型（走异步任务接口，本适配器不管）
  if (!/^doubao-(seedream|seededit)/i.test(modelId)) return null;
  return {
    name: modelId,
    provider: 'DoubaoImageProvider',
    endpoint: {
      'text-to-image': { url: `${ARK_DEFAULT_BASE_URL}${ARK_DEFAULT_IMAGE_PATH}`, model: modelId },
      'image-to-image': { url: `${ARK_DEFAULT_BASE_URL}${ARK_DEFAULT_IMAGE_PATH}`, model: modelId },
    },
  };
}

/**
 * 这条记录真正会发给方舟的模型 ID：界面「自定义模型 ID」（`MODEL_ID_CUSTOM_<码点>`）优先，
 * 其次目录里该模式的 endpoint，再退到文生图那条。
 */
export function arkModelIdOf(entry: ArkCatalogEntry, mode = 'text-to-image'): string {
  const override = (process.env[modelOverrideKey(entry.name)] ?? '').trim();
  if (override) return override;
  return (
    entry.endpoint?.[mode]?.model ??
    entry.endpoint?.['text-to-image']?.model ??
    Object.values(entry.endpoint ?? {})[0]?.model ??
    ''
  );
}

/** 请求体里「用户选了哪个模型」（画布把模型名放在 imageModel 这类字段里）。 */
export function requestedModelName(body: Record<string, unknown> | null): string {
  if (!body) return '';
  for (const key of ['imageModel', 'videoModel', 'audioModel', 'textModel', 'model']) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export interface ArkImageTarget {
  entry: ArkCatalogEntry;
  /** 真正发给方舟的模型 ID（目录值 / 用户覆盖值 / 直写的 ID） */
  modelId: string;
  /** 用户请求的名字（回执里原样带回，便于排查） */
  requested: string;
}

/**
 * 这次 generate-image 该不该走方舟？该走就返回目标记录，否则 null（交给通用端点）。
 * 认名字（目录里的方舟记录）或认模型 ID（`doubao-seedream-*` 直写）。
 */
export function findArkImageTarget(body: Record<string, unknown> | null): ArkImageTarget | null {
  const requested = requestedModelName(body);
  if (!requested) return null;
  const entry = findArkImageEntry(requested) ?? syntheticArkEntry(requested);
  if (!entry) return null;
  const modelId = arkModelIdOf(entry, resolvedMode(body));
  if (!modelId) return null;
  return { entry, modelId, requested };
}

export function isArkImageModel(name: unknown): boolean {
  return findArkImageEntry(name) !== null;
}

// ---------------------------------------------------------------------------
// 能力表（按模型 ID 前缀）
// ---------------------------------------------------------------------------

export interface ArkCapability {
  /** 认这个模型 ID 的前缀 */
  prefix: string;
  /** 支持的 size 档位 */
  presets: string[];
  defaultPreset: string;
  /** 方式 2（宽x高）的总像素范围 */
  minPixels: number;
  maxPixels: number;
  /** 是否支持组图（sequential_image_generation） */
  sequential: boolean;
  /** 是否支持 layer_decomposition */
  layerDecomposition: boolean;
  /** 是否支持 output_format */
  outputFormat: boolean;
  /** 是否支持 tools:[{type:'web_search'}] */
  webSearch: boolean;
  /** 是否支持 background:'transparent' */
  background: boolean;
}

/** 档位 → 长边像素（方舟的「2K」档按 2048 长边理解，与官方 2048x2048 默认值一致）。 */
const TIER_SIDE: Readonly<Record<string, number>> = Object.freeze({
  '512': 512,
  '1K': 1024,
  '1.5K': 1536,
  '2K': 2048,
  '3K': 3072,
  '4K': 4096,
});

const ARK_CAPABILITIES: readonly ArkCapability[] = Object.freeze([
  {
    prefix: 'doubao-seedream-5-0-pro',
    presets: ['1K', '1.5K', '2K'],
    defaultPreset: '2K',
    minPixels: 921_600,
    maxPixels: 4_624_220,
    sequential: false,
    layerDecomposition: true,
    outputFormat: true,
    webSearch: false,
    background: true,
  },
  {
    prefix: 'doubao-seedream-5-0',
    presets: ['2K', '3K', '4K'],
    defaultPreset: '2K',
    minPixels: 3_686_400,
    maxPixels: 16_777_216,
    sequential: true,
    layerDecomposition: false,
    outputFormat: true,
    webSearch: true,
    background: false,
  },
  {
    prefix: 'doubao-seedream-4-5',
    presets: ['2K', '4K'],
    defaultPreset: '2K',
    minPixels: 3_686_400,
    maxPixels: 16_777_216,
    sequential: true,
    layerDecomposition: false,
    outputFormat: false,
    webSearch: false,
    background: false,
  },
  {
    prefix: 'doubao-seedream-4-0',
    presets: ['1K', '2K', '4K'],
    defaultPreset: '2K',
    minPixels: 921_600,
    maxPixels: 16_777_216,
    sequential: true,
    layerDecomposition: false,
    outputFormat: false,
    webSearch: false,
    background: false,
  },
]);

/** 认不出的方舟模型 ID 走最保守的一档（5.0 pro 的范围）：宁可被方舟拒，也不要静默贴错尺寸。 */
const ARK_FALLBACK_CAPABILITY: ArkCapability = Object.freeze({
  prefix: '',
  presets: ['1K', '1.5K', '2K'],
  defaultPreset: '2K',
  minPixels: 921_600,
  maxPixels: 4_624_220,
  sequential: false,
  layerDecomposition: false,
  outputFormat: false,
  webSearch: false,
  background: false,
});

export function arkCapabilityOf(modelId: string): ArkCapability {
  const id = (modelId ?? '').toLowerCase();
  return ARK_CAPABILITIES.find((entry) => id.startsWith(entry.prefix)) ?? ARK_FALLBACK_CAPABILITY;
}

function align16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16);
}

function parseRatio(value: unknown): [number, number] {
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)\s*[:：xX*]\s*(\d+(?:\.\d+)?)$/.exec(value.trim());
    if (match) {
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (width > 0 && height > 0) return [width, height];
    }
  }
  return [1, 1];
}

export interface ArkSize {
  size: string;
  /** 与用户选的档位/宽高比不一致时的说明（回执里带回，画布/日志都看得到） */
  note?: string;
}

/**
 * 把画布的「分辨率档位 + 宽高比」翻成方舟的 `size`。
 *
 * 优先用**宽x高**（方式 2）：画布上用户明确选了宽高比，档位字符串交给模型自己判断会把
 * 宽高比丢掉；算出像素值则两边都满足。档位按「长边 = 1K/1.5K/2K…」理解。档位不支持时取最接近
 * 的档位并留下说明；夹取后仍越界（极端宽高比）就退回档位字符串，交给方舟自己决定。
 */
export function arkSizeFor(
  capability: ArkCapability,
  resolution: unknown,
  aspectRatio: unknown,
): ArkSize {
  const requested = typeof resolution === 'string' ? resolution.trim() : '';
  const known = TIER_SIDE[requested] !== undefined ? requested : capability.defaultPreset;
  let tier = known;
  let note: string | undefined;
  if (!capability.presets.includes(tier)) {
    const target = TIER_SIDE[tier] ?? TIER_SIDE[capability.defaultPreset];
    tier = [...capability.presets].sort(
      (left, right) =>
        Math.abs((TIER_SIDE[left] ?? target) - target) - Math.abs((TIER_SIDE[right] ?? target) - target),
    )[0];
    note = `${requested || '未指定'} 不在该模型支持的档位（${capability.presets.join('/')}）内，已按 ${tier} 提交`;
  }
  const long = TIER_SIDE[tier];
  const [ratioWidth, ratioHeight] = parseRatio(aspectRatio);
  // 档位按「长边」理解：2K + 16:9 → 2048x1152（与方舟文档里 5.0 pro 的最小尺寸示例
  // 1280x720 —— 也就是 1K 档的 16:9 —— 同一套口径）。
  const ratio = ratioWidth / ratioHeight;
  let width = align16(ratio >= 1 ? long : long * ratio);
  let height = align16(ratio >= 1 ? long / ratio : long);
  const clamp = () => {
    const total = width * height;
    if (total < capability.minPixels) {
      const scale = Math.sqrt(capability.minPixels / total);
      width = align16(width * scale);
      height = align16(height * scale);
    } else if (total > capability.maxPixels) {
      const scale = Math.sqrt(capability.maxPixels / total);
      width = align16(width * scale);
      height = align16(height * scale);
    }
  };
  clamp();
  if (width * height < capability.minPixels || width * height > capability.maxPixels) {
    return { size: tier, note: note ?? `${tier} 档位下无法用像素值表达 ${String(aspectRatio ?? '1:1')}，改回档位提交` };
  }
  return { size: `${width}x${height}`, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// 费用预估（画布的模型下拉与节点价格标签都读 /generation/model-availability 里的 price）
// ---------------------------------------------------------------------------

/**
 * Seedream 5.0 Pro 的官方计价口径（2026-07-08 发布时公布，按**输入图 + 输出图**计费）：
 *   输出图 ≤ 236 万像素 → **0.3 元/张**；超过 236 万像素 → **0.6 元/张**；
 *   首张输入图免费，之后每张输入图 0.02 元。
 *
 * 这条规则对我们特别合适：host 半本来就要算 size（宽x高），像素数就在手上，
 * 所以画布上选的档位与宽高比能直接换成一个准确的单价 —— 例如
 *   2K + 16:9 → 2048x1152 = 235.9 万像素 → 0.3 元；2K + 1:1 → 2048x2048 = 419 万像素 → 0.6 元。
 * 4.0 / 4.5 / 5.0-lite 用画布目录里上游记的单价（元/张）。
 */
export const ARK_PRICE_5_PRO = Object.freeze({
  pixelThreshold: 2_360_000,
  withinThreshold: 0.3,
  overThreshold: 0.6,
  extraInputImage: 0.02,
});

const ARK_PRICE_NOTE = '火山方舟官方价（元/张），以方舟账单为准；每多一张输入参考图另有 0.02 元';

export interface ArkPriceEstimate {
  /** 元/张；给不出可靠数字时 null（画布显示「价格未知」，不编） */
  price: number | null;
  note: string;
}

function pixelsOfSize(size: string): number | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  return Number(match[1]) * Number(match[2]);
}

function catalogUnitPrice(entry: ArkCatalogEntry, tier: string): number | null {
  const cost = entry.cost;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) return cost;
  if (!cost || typeof cost !== 'object') return null;
  const exact = cost[tier];
  if (typeof exact === 'number' && Number.isFinite(exact)) return exact;
  const values = Object.values(cost).filter((value) => typeof value === 'number' && Number.isFinite(value));
  return values.length ? values[0] : null;
}

/**
 * 给画布下发的单价预估。
 * @param input 画布当前的选择（模型下拉/节点会把自己的档位与宽高比带过来）
 */
export function arkPriceFor(
  entry: ArkCatalogEntry,
  modelId: string,
  input: { resolution?: unknown; aspectRatio?: unknown; mode?: unknown } = {},
): ArkPriceEstimate {
  const mode = typeof input.mode === 'string' ? input.mode : '';
  if (mode === MODE_LAYER_DECOMPOSITION) {
    // 图层拆分输出「1 张底图 + 最多 16 个图层」，方舟怎么给这堆图层计价我们没有权威依据
    return { price: null, note: '图层拆分按输出图层计价，画布不预估：以方舟账单为准' };
  }
  const capability = arkCapabilityOf(modelId);
  if (capability.prefix === 'doubao-seedream-5-0-pro') {
    const { size } = arkSizeFor(capability, input.resolution, input.aspectRatio);
    const pixels = pixelsOfSize(size);
    if (pixels === null) return { price: null, note: ARK_PRICE_NOTE };
    const price =
      pixels > ARK_PRICE_5_PRO.pixelThreshold
        ? ARK_PRICE_5_PRO.overThreshold
        : ARK_PRICE_5_PRO.withinThreshold;
    return {
      price,
      note: `${ARK_PRICE_NOTE}（本张 ${size} ≈ ${(pixels / 10_000).toFixed(0)} 万像素 → ${price} 元）`,
    };
  }
  const tier =
    typeof input.resolution === 'string' && input.resolution.trim()
      ? input.resolution.trim()
      : capability.defaultPreset;
  const price = catalogUnitPrice(entry, tier);
  return price === null ? { price: null, note: '价格未知：以方舟账单为准' } : { price, note: ARK_PRICE_NOTE };
}

// ---------------------------------------------------------------------------
// 请求体翻译
// ---------------------------------------------------------------------------

const MODE_OF_IMAGE_INPUT = 'image-to-image';
const MODE_TEXT_TO_IMAGE = 'text-to-image';
const MODE_LAYER_DECOMPOSITION = 'layer-decomposition';

/** 与 vendor 的 resolveImageGenerationMode 同一套语义（只有这两个模式算「自动」）。 */
function resolvedMode(body: Record<string, unknown> | null): string {
  const current = typeof body?.imageMode === 'string' ? body.imageMode.trim() : '';
  if (current && current !== MODE_TEXT_TO_IMAGE && current !== MODE_OF_IMAGE_INPUT) return current;
  const references = referenceList(body);
  return references.length ? MODE_OF_IMAGE_INPUT : MODE_TEXT_TO_IMAGE;
}

function referenceList(body: Record<string, unknown> | null): string[] {
  if (!body) return [];
  const raw = body.imageBase64;
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

/** 扩展名 → 方舟说的图片格式。 */
const FORMAT_OF_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  '.bmp': 'bmp',
  '.tif': 'tiff',
  '.tiff': 'tiff',
  '.gif': 'gif',
  '.avif': 'avif',
});

const MIME_OF_FORMAT: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  gif: 'image/gif',
  avif: 'image/avif',
});

export class ArkRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 422, code = 'ARK_REQUEST_INVALID') {
    super(message);
    this.name = 'ArkRequestError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 参考素材 → 方舟能拿到的形式。
 *
 * 画布节点上存的是**本站相对 URL**（`/api/aifisher/canvas/media/…`），方舟不可能访问到，
 * 所以走素材库把字节读出来内联成 `data:image/png;base64,…`；远程 URL 与 data URL 原样带上。
 */
async function inlineReferences(
  body: Record<string, unknown>,
  entry: ArkCatalogEntry,
  deps: CloudGenerationDeps,
): Promise<string[]> {
  const references = referenceList(body);
  if (!references.length) return [];
  const maxInputs = entry.maxInputs ?? DEFAULT_MAX_INPUTS;
  if (references.length > maxInputs) {
    throw new ArkRequestError(
      `该模型最多支持 ${maxInputs} 张参考图，已连接 ${references.length} 张，请调整后重试。`,
      422,
      'ARK_INPUT_COUNT_EXCEEDED',
    );
  }
  const maxBytes = (entry.maxImageSizeMb ?? DEFAULT_MAX_IMAGE_MB) * 1024 * 1024;
  const supported = entry.supportedImageFormats ?? [];
  const mediaStore = deps.mediaStore;
  const inline: string[] = [];
  let total = 0;

  for (const reference of references) {
    const value = reference.trim();
    if (value.startsWith('data:')) {
      total += value.length;
      inline.push(value);
      continue;
    }
    if (/^https?:\/\//i.test(value)) {
      const local = mediaStore?.localPathForUrl(value);
      if (!local) {
        inline.push(value);
        continue;
      }
      const bytes = (await mediaStore!.readBytesForUrl(value))?.bytes;
      if (!bytes) {
        throw new ArkRequestError(`参考素材读不出来：${value}`, 404, 'ARK_REFERENCE_MISSING');
      }
      inline.push(await toDataUrl(bytes, local.filename, supported, maxBytes));
      total += bytes.byteLength;
      continue;
    }
    const local = mediaStore?.localPathForUrl(value);
    if (!local) {
      // 是我们素材库的 URL 但文件不在了（画布上那张图已被删/被清理）：这条与「外链图」
      // 是两种完全不同的处置，不能都塞进「请把素材先上传到画布素材库」。
      const ref = mediaStore?.parseUrl(value) ?? null;
      if (ref) {
        throw new ArkRequestError(
          `参考素材已不在素材库里：${ref.filename}。请重新选一张（从画布上重新连一次参考图，或重新上传）。`,
          404,
          'ARK_REFERENCE_MISSING',
        );
      }
      throw new ArkRequestError(
        `参考素材不是本站素材，也不是方舟能访问的 URL：${value}。请把素材先上传到画布素材库。`,
        422,
        'ARK_REFERENCE_UNREACHABLE',
      );
    }
    const bytes = (await mediaStore!.readBytesForUrl(value))?.bytes;
    if (!bytes) {
      throw new ArkRequestError(`参考素材读不出来：${value}`, 404, 'ARK_REFERENCE_MISSING');
    }
    inline.push(await toDataUrl(bytes, local.filename, supported, maxBytes));
    total += bytes.byteLength;
    if (total > MAX_INLINE_BYTES) {
      throw new ArkRequestError(
        `参考素材总量超过 ${Math.round(MAX_INLINE_BYTES / 1024 / 1024)}MB 上限，请减少参考图或压缩后再试。`,
        413,
        'ARK_REFERENCES_TOO_LARGE',
      );
    }
  }
  return inline;
}

function toDataUrl(
  bytes: Buffer,
  filename: string,
  supportedFormats: string[],
  maxBytes: number,
): string {
  if (bytes.byteLength > maxBytes) {
    throw new ArkRequestError(
      `参考素材 ${filename} 超过单张上限 ${Math.round(maxBytes / 1024 / 1024)}MB。`,
      413,
      'ARK_REFERENCE_TOO_LARGE',
    );
  }
  const extension = extname(filename).toLowerCase();
  const format = FORMAT_OF_EXTENSION[extension] ?? 'png';
  if (supportedFormats.length && !supportedFormats.includes(format)) {
    throw new ArkRequestError(
      `该模型不支持 ${format} 参考图（支持：${supportedFormats.join('/')}）。`,
      415,
      'ARK_REFERENCE_FORMAT_UNSUPPORTED',
    );
  }
  return `data:${MIME_OF_FORMAT[format] ?? 'image/png'};base64,${bytes.toString('base64')}`;
}

export interface ArkImagePayloadResult {
  payload: Record<string, unknown>;
  /** 一次请求要发几次（5.0 pro 不支持组图时，N 张 = N 次并发） */
  requests: number;
  notes: string[];
  /** 实际采用的 size（回执里给画布/日志看） */
  size: string;
}

/** 画布请求 → 方舟请求体。纯函数（参考图已内联好），方便单测。 */
export function buildArkImagePayload(input: {
  entry: ArkCatalogEntry;
  modelId: string;
  body: Record<string, unknown>;
  mode: string;
  images: string[];
  config: ArkConfig;
}): ArkImagePayloadResult {
  const { entry, modelId, body, mode, images, config } = input;
  const capability = arkCapabilityOf(modelId);
  const notes: string[] = [];
  const declaredModes = entry.imageModes?.map((item) => item.value) ?? [];
  if (declaredModes.length && !declaredModes.includes(mode)) {
    throw new ArkRequestError(
      `该模型不支持「${mode}」（支持：${declaredModes.join('/')}）。`,
      422,
      'ARK_MODE_UNSUPPORTED',
    );
  }
  const rawCount = Number(body.generateCount);
  const count = Number.isFinite(rawCount) ? Math.min(15, Math.max(1, Math.trunc(rawCount))) : 1;

  let size = '';
  if (mode === MODE_LAYER_DECOMPOSITION) {
    if (!capability.layerDecomposition) {
      throw new ArkRequestError('该模型不支持图层拆分。', 422, 'ARK_MODE_UNSUPPORTED');
    }
    if (!images.length) {
      throw new ArkRequestError('图层拆分需要一张待拆分的图片。', 422, 'ARK_INPUT_REQUIRED');
    }
    // 图层拆分只认档位（方舟文档：方式 1）
    size = TIER_SIDE[String(body.resolution ?? '')] !== undefined ? String(body.resolution) : capability.defaultPreset;
    if (!capability.presets.includes(size)) size = capability.defaultPreset;
  } else {
    const computed = arkSizeFor(capability, body.resolution, body.aspectRatio);
    size = computed.size;
    if (computed.note) notes.push(computed.note);
  }

  const payload: Record<string, unknown> = {
    model: modelId,
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    size,
    response_format: 'url',
    stream: false,
    watermark: typeof body.watermark === 'boolean' ? body.watermark : config.watermark,
  };
  if (images.length) payload.image = images.length === 1 ? images[0] : images;
  if (mode === MODE_LAYER_DECOMPOSITION) payload.layer_decomposition = true;
  if (capability.outputFormat) payload.output_format = 'png';
  if (body.background === 'transparent' && capability.background) payload.background = 'transparent';
  if (body.web_search === true && capability.webSearch) payload.tools = [{ type: 'web_search' }];

  let requests = 1;
  if (count > 1) {
    if (capability.sequential) {
      payload.sequential_image_generation = 'auto';
      payload.sequential_image_generation_options = { max_images: count };
    } else {
      requests = Math.min(MAX_PARALLEL_REQUESTS, count);
      if (requests < count) {
        notes.push(`该模型不支持一次生成 ${count} 张，本次按 ${requests} 张并发提交`);
      }
    }
  }

  return { payload, requests, notes, size };
}

// ---------------------------------------------------------------------------
// 结果归一
// ---------------------------------------------------------------------------

interface ArkResultItem {
  ref: { url?: string; base64?: string };
  extension?: string;
  size?: string;
  error?: string;
}

function extensionOfOutputFormat(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const format = value.trim().toLowerCase();
  if (format === 'png') return '.png';
  if (format === 'jpeg' || format === 'jpg') return '.jpg';
  if (format === 'webp') return '.webp';
  return undefined;
}

/** 方舟响应 → 结果条目（url/b64_json、真实格式、失败项的原因）。 */
export function collectArkResults(body: unknown): ArkResultItem[] {
  const items: ArkResultItem[] = [];
  const push = (node: unknown) => {
    if (!isObject(node)) return;
    const extension = extensionOfOutputFormat(node.output_format);
    const size = typeof node.size === 'string' ? node.size : undefined;
    const failure =
      isObject(node.error) && typeof node.error.message === 'string'
        ? node.error.message
        : typeof node.error === 'string'
          ? node.error
          : undefined;
    if (typeof node.url === 'string' && node.url.trim()) {
      items.push({ ref: { url: node.url.trim() }, ...(extension ? { extension } : {}), ...(size ? { size } : {}), ...(failure ? { error: failure } : {}) });
      return;
    }
    if (typeof node.b64_json === 'string' && node.b64_json.trim()) {
      items.push({ ref: { base64: node.b64_json.trim() }, ...(extension ? { extension } : {}), ...(size ? { size } : {}), ...(failure ? { error: failure } : {}) });
    }
  };
  const data = isObject(body) ? body.data : undefined;
  if (Array.isArray(data)) data.forEach(push);
  if (!items.length) {
    for (const ref of collectResultRefs(body)) items.push({ ref });
  }
  return items;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function arkErrorMessage(parsed: unknown, raw: string, status: number): { message: string; code?: string } {
  if (isObject(parsed) && isObject(parsed.error)) {
    const message = typeof parsed.error.message === 'string' ? parsed.error.message : '';
    const code = typeof parsed.error.code === 'string' ? parsed.error.code : undefined;
    if (message) return { message, ...(code ? { code } : {}) };
  }
  if (isObject(parsed) && typeof parsed.error === 'string' && parsed.error) {
    return { message: parsed.error };
  }
  if (raw) return { message: raw.slice(0, 400) };
  return { message: `HTTP ${status}` };
}

/** 401/403/404/429 这些「配错了」的情况给出可操作的下一步，而不是光回一句上游报错。 */
export function arkHint(status: number, code: string | undefined, modelId: string): string | undefined {
  const text = `${code ?? ''}`.toLowerCase();
  if (status === 401 || status === 403 || text.includes('authentication') || text.includes('accessdenied')) {
    return '方舟鉴权失败：请核对 API Key（设置 → 闭源服务 → 火山方舟，或环境变量 ARK_API_KEY）。';
  }
  if (status === 404 || text.includes('modelnotopen') || text.includes('invalidendpoint') || text.includes('modelnotfound')) {
    // 实测（2026-10-16）：Key 有效、端点可达，但账号一个 Seedream 都没开通时，
    // 方舟回的就是 404 ModelNotOpen —— 所以先把「去控制台开通」这条路说清楚。
    return (
      `方舟说模型不可用（${modelId}）：请在火山方舟控制台「开通管理」里开通这个模型` +
      `（https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement），` +
      '或在设置页的「自定义模型 ID」里改成你账号下已开通的推理接入点 ID（ep-…）。'
    );
  }
  if (status === 429 || text.includes('quota') || text.includes('ratelimit')) {
    return '方舟限流/额度不足：稍后重试，或检查方舟控制台的用量与限流配置。';
  }
  if (status === 400 || text.includes('invalidparameter')) {
    return '方舟拒绝了请求参数：把这里的 message 原文对照方舟文档核对尺寸/参考图限制。';
  }
  return undefined;
}

async function callArk(
  target: string,
  payload: Record<string, unknown>,
  config: ArkConfig,
  fetcher: typeof fetch,
): Promise<{ ok: true; parsed: unknown } | { ok: false; status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetcher(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
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
  if (!response.ok) return { ok: false, status: response.status, body: { parsed, raw } };
  return { ok: true, parsed };
}

/**
 * 处理一条走方舟的 `generate-image`。已处理返回 true（本函数总是自己回响应）。
 */
export async function handleArkImageGeneration(
  body: Record<string, unknown>,
  res: ServerResponse,
  deps: CloudGenerationDeps,
  target: ArkImageTarget,
): Promise<boolean> {
  const config = readArkConfig();
  if (!config.apiKey) {
    sendJson(res, 501, {
      error:
        '火山方舟（豆包）图片生成未配置：请在画布「设置 → 闭源服务 → 火山方舟（豆包直连）」里填 API Key，' +
        '或给 DSH 进程设置 ARK_API_KEY 后重启。',
      code: 'ARK_NOT_CONFIGURED',
      model: target.entry.name,
    });
    return true;
  }

  const mode = resolvedMode(body);
  let images: string[];
  let plan: ArkImagePayloadResult;
  try {
    images = await inlineReferences(body, target.entry, deps);
    plan = buildArkImagePayload({
      entry: target.entry,
      modelId: target.modelId,
      body: { ...body, imageMode: mode },
      mode,
      images,
      config,
    });
  } catch (error) {
    if (error instanceof ArkRequestError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return true;
    }
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : '方舟请求构造失败。',
      code: 'ARK_REQUEST_FAILED',
    });
    return true;
  }

  const endpoint = `${config.baseUrl}${config.imagePath}`;
  const fetcher = deps.fetcher ?? globalThis.fetch;
  const notes = [...plan.notes];
  const items: ArkResultItem[] = [];

  const responses = await Promise.all(
    Array.from({ length: plan.requests }, () =>
      callArk(endpoint, plan.payload, config, fetcher).catch((error: unknown) => ({
        ok: false as const,
        status: 502,
        body: {
          parsed: null,
          raw: '',
          thrown: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string }).code,
        },
      })),
    ),
  );

  for (const response of responses) {
    if (!response.ok) {
      const detail = response.body as { parsed?: unknown; raw?: string; thrown?: string; code?: string };
      if (detail.thrown) {
        sendJson(res, 502, {
          error: detail.code === 'ARK_UNREACHABLE' ? detail.thrown : `方舟调用失败：${detail.thrown}`,
          code: detail.code === 'ARK_UNREACHABLE' ? 'ARK_UNREACHABLE' : 'ARK_UPSTREAM_ERROR',
          endpoint,
          model: target.modelId,
        });
        return true;
      }
      const { message, code } = arkErrorMessage(detail.parsed, detail.raw ?? '', response.status);
      const hint = arkHint(response.status, code ?? detail.code, target.modelId);
      sendJson(res, 502, {
        error: `方舟生成失败（HTTP ${response.status}）：${message}`,
        code: 'ARK_UPSTREAM_ERROR',
        upstreamStatus: response.status,
        ...(code ? { upstreamCode: code } : {}),
        endpoint,
        model: target.modelId,
        ...(hint ? { hint } : {}),
        raw: isObject(detail.parsed) ? detail.parsed : (detail.raw ?? '').slice(0, 400),
      });
      return true;
    }
    // 200 也可能是「整体失败」：顶层 error + 空 data
    const parsed = response.parsed;
    if (isObject(parsed) && parsed.error && !Array.isArray(parsed.data)) {
      const { message, code } = arkErrorMessage(parsed, '', 200);
      sendJson(res, 502, {
        error: `方舟生成失败：${message}`,
        code: 'ARK_UPSTREAM_ERROR',
        ...(code ? { upstreamCode: code } : {}),
        endpoint,
        model: target.modelId,
      });
      return true;
    }
    items.push(...collectArkResults(parsed));
  }

  const usable = items.filter((item) => item.ref.url || item.ref.base64);
  for (const item of items) {
    if (!item.ref.url && !item.ref.base64 && item.error) notes.push(`方舟个别结果失败：${item.error}`);
  }
  if (!usable.length) {
    sendJson(res, 502, {
      error: '方舟返回里没有可识别的结果素材（既没有 url 也没有 b64_json）。',
      code: 'ARK_RESULT_UNRECOGNIZED',
      endpoint,
      model: target.modelId,
    });
    return true;
  }

  const projectId =
    typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : 'default';
  const nodeId = typeof body.nodeId === 'string' && body.nodeId ? body.nodeId : undefined;
  const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
  const urls: string[] = [];
  for (const item of usable) {
    const url = await localizeCloudResult(
      'image',
      item.ref,
      {
        projectId,
        ...(nodeId ? { nodeId } : {}),
        ...(prompt ? { prompt } : {}),
        model: target.modelId,
        ...(item.extension ? { extension: item.extension } : {}),
        provider: 'ark',
      },
      deps,
    );
    if (url) urls.push(url);
  }
  if (!urls.length) {
    sendJson(res, 502, { error: '方舟结果无法落盘。', code: 'ARK_RESULT_UNRECOGNIZED' });
    return true;
  }

  sendJson(res, 200, {
    success: true,
    provider: 'ark',
    model: target.modelId,
    requestedModel: target.requested,
    size: usable.find((item) => item.size)?.size ?? plan.size,
    resultUrl: urls[0],
    resultUrls: urls,
    ...(notes.length ? { notes } : {}),
  });
  return true;
}

// ---------------------------------------------------------------------------
// 诊断 / 设置页
// ---------------------------------------------------------------------------

/** 诊断用：方舟配置状态（**不回显密钥**）。 */
export function arkImageStatus(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const config = readArkConfig(env);
  const models = arkImageEntries().map((entry) => ({
    name: entry.name,
    /** 目录里写死的模型 ID；界面「自定义模型 ID」会覆盖它 */
    defaultModelId:
      entry.endpoint?.['text-to-image']?.model ??
      entry.endpoint?.['image-to-image']?.model ??
      null,
    modelId: (env[modelOverrideKey(entry.name)] ?? '').trim() || null,
  }));
  return {
    configured: Boolean(config.apiKey),
    apiKey: config.apiKey ? '已设置' : '未设置',
    baseUrl: config.baseUrl,
    imagePath: config.imagePath,
    timeoutMs: config.timeoutMs,
    watermark: config.watermark,
    models,
    hint: '设置 → 闭源服务 → 火山方舟（豆包直连）填 API Key；或用环境变量 ARK_API_KEY 后重启 DSH',
  };
}
