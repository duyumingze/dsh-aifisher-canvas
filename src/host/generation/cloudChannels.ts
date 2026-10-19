/**
 * 「云端 OpenAI 通道」多通道存储 + 请求翻译（host 半）。
 *
 * 背景（2026-10-16，用户原话「OpenAI通道我希望可以配置好几个，并且可以选择多条单独模型」）：
 * v1.4 起本插件只支持**一个**通用 OpenAI 兼容端点（`AIFISHER_CLOUD_BASE_URL` + `_API_KEY`），
 * 而模型名只能从 vendor 静态目录里挑，想换成中转站/魔搭（ModelScope）真实的模型 ID 时，
 * 每个目录条目只能存**一个** `MODEL_ID_CUSTOM_*` 覆盖值 —— 多个通道、每个通道多条模型都做不到。
 *
 * 本模块提供：
 *   ① 多通道存储 `<画布数据目录>/cloud-channels.json`（通道 = 名称 + baseUrl + apiKey +
 *      可选按媒体类型的路径覆盖 + **它提供哪些模型**（每条 = 端点真实模型 ID + 画布媒体类型））；
 *   ② 模型名 → 通道 的解析（画布节点上存的名字形如 `魔搭 ModelScope · Qwen/Qwen-Image`；
 *      发给端点的 `model` 字段则是纯模型 ID —— 见 channelModelName 的说明）；
 *   ③ 画布请求 → OpenAI 形状请求的翻译（`{model, prompt, n, size, image…}`），
 *      以及参考图内联（画布存的是本站素材 URL，外部端点访问不到）；
 *   ④ `GET {baseUrl}/models` 探测，供界面**多选**模型。
 *
 * 三条红线：
 *   - 密钥只留在 host：`publicChannel()` 永远只回布尔量，不回 apiKey；
 *   - 通道写盘是原子替换（tmp + rename），坏文件当空处理，不让设置页炸掉；
 *   - 未配置任何通道时**不再有兜底端点**可掉：v1.13 起旧版 `AIFISHER_CLOUD_BASE_URL` 单端点已随
 *     那张设置卡片整体移除，没配通道、也不是方舟直连就如实回 501 `CLOUD_NOT_CONFIGURED`。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MediaStore } from '../canvas/mediaStore';
import type { CloudKind } from './cloudResult';

/** 通道能提供模型的四种媒体类型（与画布四个 composer 对应）。 */
export const CHANNEL_KINDS: readonly CloudKind[] = Object.freeze([
  'image',
  'video',
  'audio',
  'text',
]);

export interface CloudChannelModel {
  /** 端点真实模型 ID（发给端点的 `model` 字段就是它）。 */
  id: string;
  kind: CloudKind;
  /** 可选：这条模型在画布上的名字（缺省 = `${通道名} · ${id}`）。 */
  label?: string;
}

/**
 * 「请求方言」：同一件事各家写的字段名不一样，翻译时要按方言来。
 *
 * 分歧点不止一个，而且**都会静默出错**（2026-10-17 实测 / 2026-10-17 校对上游 relayProvider.js）：
 *   - 参考图放哪个字段：OpenAI 形状是 `image`，魔搭 API-Inference 认 `image_url`（数组）。
 *     魔搭**不报错**，只是把 `image` 丢掉、按纯文生图跑，于是「图片编辑」变成「重新画一张」。
 *   - FisherAI（api.work-fisher.com）那一套既不是 OpenAI 的 `/images/generations` 也不是
 *     `1024x576` 像素串：路径是 `/image/generations`（单数）、宽高比走 `size:"16:9"`、
 *     档位走 `resolution:"1k"`，而且是**异步任务网关**（提交拿 task_id → 轮询 `/image/generations/{id}`）。
 *     参考素材只收**公网直链**（先 POST /files/upload 换链接），data URL 一律不收。
 */
export type ChannelDialect = 'openai' | 'modelscope' | 'workfisher';

export const CHANNEL_DIALECTS: readonly ChannelDialect[] = Object.freeze([
  'openai',
  'modelscope',
  'workfisher',
]);

export const CHANNEL_DIALECT_LABELS: Readonly<Record<ChannelDialect, string>> = Object.freeze({
  openai: 'OpenAI 兼容',
  modelscope: '魔搭 ModelScope',
  workfisher: 'FisherAI（work-fisher）',
});

/** 按地址猜方言：`api-inference.modelscope.cn` → 魔搭；`api.work-fisher.com` → FisherAI。 */
export function detectChannelDialect(baseUrl: string): ChannelDialect {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'modelscope.cn' || host.endsWith('.modelscope.cn')) return 'modelscope';
    if (host === 'work-fisher.com' || host.endsWith('.work-fisher.com')) return 'workfisher';
  } catch {
    // 地址不合法是 normalizeBaseUrl 的活，这里只负责猜不出来时回 openai
  }
  return 'openai';
}

/** 一条通道**实际**用哪套方言：显式配了就用它，没配就按地址判定。 */
export function channelDialect(channel: Pick<CloudChannel, 'baseUrl' | 'dialect'>): ChannelDialect {
  return channel.dialect ?? detectChannelDialect(channel.baseUrl);
}

export interface CloudChannel {
  /** 稳定 slug：进键名与界面标识。 */
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  /** 按媒体类型覆盖路径；缺省见 DEFAULT_PATHS。 */
  paths: Partial<Record<CloudKind, string>>;
  /** 请求方言；**缺省 = 按 baseUrl 自动判定**（见 detectChannelDialect）。 */
  dialect?: ChannelDialect;
  timeoutMs: number;
  models: CloudChannelModel[];
  createdAt?: number;
  updatedAt?: number;
}

export const DEFAULT_PATHS: Readonly<Record<CloudKind, string>> = Object.freeze({
  image: '/images/generations',
  video: '/videos/generations',
  audio: '/audio/generations',
  text: '/chat/completions',
});

/**
 * 某套方言自己改路径的媒体类型（用户显式填的 `paths` 仍然压过这里）。
 *
 * 只有 FisherAI 需要：它是 `/image/generations`（**单数** image），照 OpenAI 的复数路径打过去
 * 只会拿到网关的 404，而报错里看不出是路径写错了。
 */
const DIALECT_PATHS: Readonly<Partial<Record<ChannelDialect, Partial<Record<CloudKind, string>>>>> =
  Object.freeze({
    workfisher: Object.freeze({ image: '/image/generations' }),
  });

/** FisherAI 换参考图直链的上传路径（挂 baseUrl 之后）。 */
export const WORKFISHER_UPLOAD_PATH = '/files/upload';

const DEFAULT_TIMEOUT_MS = 900_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_MODELS_PER_CHANNEL = 200;
const MAX_MODEL_ID_LENGTH = 160;
/** 自定义显示名（= 画布上的模型名）长度上限；界面输入框也按这个数字限长。 */
const MAX_MODEL_LABEL_LENGTH = 80;
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function cloudChannelsPath(dataDir: string): string {
  return join(dataDir, 'cloud-channels.json');
}

/** 通道请求/配置相关的错误（带可操作 hint，界面直接显示）。 */
export class ChannelRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  constructor(message: string, status = 422, code = 'CHANNEL_REQUEST_INVALID', hint?: string) {
    super(message);
    this.name = 'ChannelRequestError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

// ------------------------------------------------------------------ 存储

function sanitizeModel(input: unknown): CloudChannelModel | null {
  const record = (input ?? {}) as Record<string, unknown>;
  const rawId = typeof record.id === 'string' ? record.id.trim() : '';
  if (!rawId || rawId.length > MAX_MODEL_ID_LENGTH) return null;
  if (/[\s\u0000-\u001f]/.test(rawId)) return null;
  const kind =
    typeof record.kind === 'string' && (CHANNEL_KINDS as readonly string[]).includes(record.kind)
      ? (record.kind as CloudKind)
      : guessChannelModelKind(rawId);
  // 自定义显示名：控制字符换成空格、最长 80 —— 它会被当作**画布上的模型名**，
  // 太长或带换行会把模型下拉与节点撑坏（界面那边也限长，这里只是兜底）。
  const label = (typeof record.label === 'string' ? record.label : '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MODEL_LABEL_LENGTH);
  return { id: rawId, kind, ...(label ? { label } : {}) };
}

function sanitizePaths(input: unknown): Partial<Record<CloudKind, string>> {
  const record = (input ?? {}) as Record<string, unknown>;
  const paths: Partial<Record<CloudKind, string>> = {};
  for (const kind of CHANNEL_KINDS) {
    const value = record[kind];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('/')) continue;
    paths[kind] = trimmed;
  }
  return paths;
}

function normalizeBaseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return value.replace(/\/+$/, '');
}

/** 通道 slug → 键名/界面标识；只允许小写字母数字与 `-` `_`。 */
export function channelIdFromLabel(label: string, taken: readonly string[] = []): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  let base = ascii && CHANNEL_ID_PATTERN.test(ascii) ? ascii : 'channel';
  if (taken.includes(base)) {
    let index = 2;
    while (taken.includes(`${base}-${index}`)) index += 1;
    base = `${base}-${index}`;
  }
  return base;
}

/**
 * 校验 + 归一一条通道配置。
 * `previous` 是同一 id 的旧配置：**apiKey 缺省（undefined）= 保持旧值**，空串 = 清掉。
 */
export function sanitizeChannel(
  input: unknown,
  previous?: CloudChannel,
): { channel: CloudChannel } | { error: string; code: string } {
  const record = (input ?? {}) as Record<string, unknown>;
  const baseUrl = normalizeBaseUrl(typeof record.baseUrl === 'string' ? record.baseUrl : '');
  if (!baseUrl) {
    return {
      error: 'Base URL 必须是 http/https 地址（例如 https://api-inference.modelscope.cn/v1）。',
      code: 'CHANNEL_BASE_URL_INVALID',
    };
  }
  const rawId = typeof record.id === 'string' ? record.id.trim().toLowerCase() : '';
  const id = rawId && CHANNEL_ID_PATTERN.test(rawId) ? rawId : previous?.id ?? '';
  if (!id) {
    return { error: '通道标识不合法（只允许小写字母、数字、- 和 _）。', code: 'CHANNEL_ID_INVALID' };
  }
  const label =
    (typeof record.label === 'string' ? record.label.trim() : '') || previous?.label || id;
  if (label.length > 60) {
    return { error: '通道名称最长 60 个字符。', code: 'CHANNEL_LABEL_TOO_LONG' };
  }
  let apiKey: string;
  if (typeof record.apiKey === 'string') apiKey = record.apiKey.trim();
  else apiKey = previous?.apiKey ?? '';

  const rawTimeout = Number(record.timeoutMs);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= MIN_TIMEOUT_MS && rawTimeout <= MAX_TIMEOUT_MS
      ? Math.trunc(rawTimeout)
      : previous?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const rawModels = Array.isArray(record.models) ? record.models : previous?.models ?? [];
  const models: CloudChannelModel[] = [];
  const seen = new Set<string>();
  for (const item of rawModels.slice(0, MAX_MODELS_PER_CHANNEL * 2)) {
    const model = sanitizeModel(item);
    if (!model) continue;
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
    if (models.length >= MAX_MODELS_PER_CHANNEL) break;
  }

  const paths = sanitizePaths(record.paths !== undefined ? record.paths : previous?.paths);
  // 方言：显式给 `openai` / `modelscope` 才写进去；给空串、给别的值、或不给 = **自动**
  // （按地址判定）。这样界面上的「自动」是可回退的，不会有一个写死的旧值赖着不走。
  const rawDialect = typeof record.dialect === 'string' ? record.dialect.trim().toLowerCase() : '';
  const dialect = (CHANNEL_DIALECTS as readonly string[]).includes(rawDialect)
    ? (rawDialect as ChannelDialect)
    : undefined;
  const now = Date.now();
  return {
    channel: {
      id,
      label,
      baseUrl,
      apiKey,
      paths,
      ...(dialect ? { dialect } : {}),
      timeoutMs,
      models,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    },
  };
}

/** 读通道表；文件不存在/坏 JSON 都当空表（设置页不能因为坏文件打不开）。 */
export async function readCloudChannels(dataDir: string): Promise<CloudChannel[]> {
  const file = cloudChannelsPath(dataDir);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { channels?: unknown })?.channels)
      ? ((parsed as { channels: unknown[] }).channels as unknown[])
      : [];
  const channels: CloudChannel[] = [];
  for (const item of raw) {
    const result = sanitizeChannel(item);
    if ('channel' in result) channels.push(result.channel);
  }
  return channels;
}

export async function writeCloudChannels(
  dataDir: string,
  channels: readonly CloudChannel[],
): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const file = cloudChannelsPath(dataDir);
  const tmp = `${file}.tmp`;
  const body = JSON.stringify({ version: 1, channels }, null, 2);
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, file);
}

// ------------------------------------------------------------------ 模型类型推断

/**
 * 从模型 ID 猜画布媒体类型（界面里每条都能改，猜错的代价只是要手动改一次）。
 *
 * 顺序有意：先视频、再音频、再文本，最后才是图像 —— 因为 `Qwen/Qwen2.5-VL` 这类
 * 名字里同时带 `vl`（视觉）和 `qwen`，它是**文本**模型；而默认值（什么都没命中）
 * 取图像，因为画布上图片节点是最常用的那类。
 */
const KIND_HINTS: ReadonlyArray<readonly [RegExp, CloudKind]> = Object.freeze([
  [
    /(?:^|[-_/.])(?:t2v|i2v|v2v|video|veo|sora|kling|seedance|wan2|hunyuanvideo|hailuo|cogvideo|ltx)/i,
    'video' as CloudKind,
  ],
  [
    /(?:^|[-_/.])(?:tts|asr|audio|music|voice|speech|suno|mureka|cosyvoice|sambert)/i,
    'audio' as CloudKind,
  ],
  [
    /(?:^|[-_/.])(?:chat|llm|instruct|vl|vision|deepseek|glm|kimi|moonshot|qwen\d|qwq|gpt-4|gpt-5|gpt-oss|claude|gemini|minimax-m)/i,
    'text' as CloudKind,
  ],
  [
    /(?:image|t2i|i2i|flux|seedream|stable-diffusion|sd3|sdxl|kolors|dall-e|imagen|hunyuanimage|qwen-image)/i,
    'image' as CloudKind,
  ],
]);

export function guessChannelModelKind(id: string): CloudKind {
  for (const [pattern, kind] of KIND_HINTS) {
    if (pattern.test(id)) return kind;
  }
  return 'image';
}

// ------------------------------------------------------------------ 查询

export interface ResolvedChannelModel {
  channel: CloudChannel;
  model: CloudChannelModel;
}

/** 按模型 ID（画布节点上存的名字）找通道；精确 → 忽略大小写 → 画布显示名 → 端点 ID。 */
export function resolveChannelModel(
  channels: readonly CloudChannel[],
  name: string,
  kind?: CloudKind,
): ResolvedChannelModel | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const candidates: Array<ResolvedChannelModel & { canvasName: string }> = [];
  for (const channel of channels) {
    for (const model of channel.models) {
      if (kind && model.kind !== kind) continue;
      candidates.push({ channel, model, canvasName: channelModelName(channel, model) });
    }
  }
  return (
    candidates.find((item) => item.model.id === wanted) ??
    candidates.find((item) => item.canvasName === wanted) ??
    candidates.find((item) => item.model.id.toLowerCase() === wanted.toLowerCase()) ??
    candidates.find((item) => (item.model.label ?? '') === wanted) ??
    null
  );
}

/**
 * 一条通道模型在**画布上**的名字。
 *
 * 默认是 `${通道名} · ${端点模型 ID}`（与上游「同一 canonicalModel 的多个来源用名字后缀区分」同一套路数）：
 * 两个通道都提供 `gpt-image-1` 时，画布节点上存的名字仍然能分辨出该走哪条通道 ——
 * 否则二级来源选中后落到节点上的还是同一个名字，host 只能永远挑第一条通道（静默走错）。 */
export function channelModelName(channel: CloudChannel, model: CloudChannelModel): string {
  const label = model.label?.trim();
  if (label) return label;
  return `${channel.label} · ${model.id}`;
}

export interface ChannelModelEntry {
  name: string;
  modelId: string;
  kind: CloudKind;
  channelId: string;
  channelLabel: string;
}

/** 所有通道提供的模型（model-availability 与前端运行时注册表都用它）。 */
export function channelModelEntries(channels: readonly CloudChannel[]): ChannelModelEntry[] {
  const entries: ChannelModelEntry[] = [];
  for (const channel of channels) {
    for (const model of channel.models) {
      entries.push({
        name: channelModelName(channel, model),
        modelId: model.id,
        kind: model.kind,
        channelId: channel.id,
        channelLabel: channel.label,
      });
    }
  }
  return entries;
}

/** 界面用：**绝不回密钥**，只回「配没配」。 */
export function publicChannel(channel: CloudChannel): Record<string, unknown> {
  return {
    id: channel.id,
    label: channel.label,
    baseUrl: channel.baseUrl,
    apiKeySet: Boolean(channel.apiKey),
    paths: channel.paths,
    // dialect 缺省 = null（界面显示「自动」）；dialectDetected 是**实际生效**的那套，
    // 让用户一眼看出「自动」现在判成了什么，而不用去猜域名规则。
    dialect: channel.dialect ?? null,
    dialectDetected: channelDialect(channel),
    timeoutMs: channel.timeoutMs,
    models: channel.models,
    updatedAt: channel.updatedAt ?? null,
  };
}

// ------------------------------------------------------------------ 探测端点模型列表

export interface ChannelProbeResult {
  endpoint: string;
  models: string[];
  total: number | null;
  /** 端点自报的名字（某些中转站会回 name/display_name）。 */
  notes: string[];
}

function collectProbeModels(parsed: unknown): { ids: string[]; total: number | null } {
  const ids: string[] = [];
  let total: number | null = null;
  if (!parsed || typeof parsed !== 'object') return { ids, total };
  const body = parsed as Record<string, unknown>;
  if (typeof body.total === 'number' && Number.isFinite(body.total)) total = body.total;
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) ids.push(value.trim());
  };
  const list = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : Array.isArray((body.data as { models?: unknown })?.models)
        ? ((body.data as { models: unknown[] }).models as unknown[])
        : [];
  for (const item of list) {
    if (typeof item === 'string') {
      push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    push(record.id ?? record.model ?? record.name);
  }
  return { ids: [...new Set(ids)], total };
}

/**
 * 读 `GET {baseUrl}/models`（OpenAI 兼容的模型清单），供界面多选。
 *
 * 兼容三种形状：`{data:[{id}]}`（OpenAI/魔搭）、`{models:[...]}`、`{data:{models:[...]}}`。
 * 魔搭这类分页端点会带 `total`：清单少于 total 时再按 `?page_number=1&page_size=200` 取一次。
 */
export async function probeChannelModels(input: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): Promise<ChannelProbeResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new ChannelRequestError(
      'Base URL 必须是 http/https 地址。',
      422,
      'CHANNEL_BASE_URL_INVALID',
    );
  }
  const fetcher = input.fetcher ?? globalThis.fetch;
  const timeout = Math.min(Math.max(input.timeoutMs ?? 20_000, 3_000), 60_000);
  const request = async (url: string) => {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new ChannelRequestError(
        `读模型清单失败：端点不可达（${error instanceof Error ? error.message : String(error)}）。`,
        502,
        'CHANNEL_UNREACHABLE',
        '确认 Base URL 能在这台机器上访问（内网地址、需要代理的地址都可能不通）。',
      );
    }
    const raw = await response.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const message =
        (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
          ? ((parsed as { error: string }).error)
          : '') ||
        (parsed &&
        typeof parsed === 'object' &&
        typeof ((parsed as { error?: { message?: unknown } }).error?.message) === 'string'
          ? String((parsed as { error: { message: string } }).error.message)
          : '') ||
        raw.slice(0, 200) ||
        `HTTP ${response.status}`;
      throw new ChannelRequestError(
        `读模型清单失败（HTTP ${response.status}）：${message}`,
        502,
        response.status === 401 || response.status === 403
          ? 'CHANNEL_UNAUTHORIZED'
          : 'CHANNEL_MODELS_FAILED',
        response.status === 401 || response.status === 403
          ? '这个端点的 API Key 没通过校验：请核对 Key 是否属于当前 Base URL。'
          : undefined,
      );
    }
    return collectProbeModels(parsed);
  };

  const endpoint = `${baseUrl}/models`;
  let result = await request(endpoint);
  const notes: string[] = [];
  if (result.total !== null && result.ids.length < result.total) {
    try {
      const paged = await request(`${endpoint}?page_number=1&page_size=200`);
      if (paged.ids.length > result.ids.length) {
        notes.push(`端点回报共 ${result.total} 个模型，已按分页取回 ${paged.ids.length} 个。`);
        result = { ids: paged.ids, total: paged.total ?? result.total };
      }
    } catch {
      notes.push(`端点回报共 ${result.total} 个模型，分页请求失败，只拿到前 ${result.ids.length} 个。`);
    }
  }
  return { endpoint, models: result.ids.sort((a, b) => a.localeCompare(b)), total: result.total, notes };
}

// ------------------------------------------------------------------ 画布请求 → OpenAI 请求

const EXTENSION_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
});

function referenceList(body: Record<string, unknown> | null): string[] {
  if (!body) return [];
  const raw = body.imageBase64;
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

/**
 * 参考素材的三种真实形态：
 *   - `url`：本来就是公网 http(s) 直链（原样给端点）；
 *   - `inline`：`data:image/png;base64,…`（画布内联 / 上游回的就是这种）；
 *   - `bytes`：本站素材库里的文件（字节已经读出来了）。
 *
 * 为什么要分出来：OpenAI / 魔搭要的是**内联或公网链接**，FisherAI **只要公网链接**
 * （data URL 会被当没传）。所以同一份素材在两条路上要落成不同形状。
 */
type ReferenceAsset =
  | { kind: 'url'; url: string }
  | { kind: 'inline'; dataUrl: string }
  | { kind: 'bytes'; filename: string; mime: string; bytes: Buffer };

/** 参考素材 → 真实形态（越界/读不出来都抛 ChannelRequestError，文案给界面直接用）。 */
async function resolveReferenceAssets(
  references: readonly string[],
  deps: { mediaStore?: MediaStore; maxBytes?: number } = {},
): Promise<ReferenceAsset[]> {
  const maxBytes = deps.maxBytes ?? 20 * 1024 * 1024;
  const assets: ReferenceAsset[] = [];
  for (const reference of references) {
    const value = reference.trim();
    if (!value) continue;
    if (value.startsWith('data:')) {
      assets.push({ kind: 'inline', dataUrl: value });
      continue;
    }
    const local = deps.mediaStore?.localPathForUrl(value);
    if (local) {
      const read = await deps.mediaStore?.readBytesForUrl(value);
      if (!read?.bytes) {
        throw new ChannelRequestError(
          `参考素材读不出来：${local.filename}`,
          404,
          'CHANNEL_REFERENCE_MISSING',
        );
      }
      if (read.bytes.byteLength > maxBytes) {
        throw new ChannelRequestError(
          `参考素材 ${local.filename} 超过单张 ${Math.round(maxBytes / 1024 / 1024)}MB 上限。`,
          413,
          'CHANNEL_REFERENCE_TOO_LARGE',
        );
      }
      assets.push({
        kind: 'bytes',
        filename: local.filename,
        mime: EXTENSION_MIME[extname(local.filename).toLowerCase()] ?? 'image/png',
        bytes: read.bytes as Buffer,
      });
      continue;
    }
    // 是我们素材库的 URL，但盘上没有这个文件（被删了 / 从没落盘）。以前这种情况会被下面
    // 那条「外链图片请先下载到素材库」兜住 —— 说的方向完全相反，用户会去重复上传一张明明
    // 在画布上看得见的图。所以先按「已不在库里」报。
    const ref = deps.mediaStore?.parseUrl(value) ?? null;
    if (ref) {
      throw new ChannelRequestError(
        `参考素材已不在素材库里：${ref.filename}。`,
        404,
        'CHANNEL_REFERENCE_MISSING',
        '这张参考图可能已被删除或被清理过；请重新选一张（从画布上重新连一次参考图，或重新上传）。',
      );
    }
    if (/^https?:\/\//i.test(value)) {
      assets.push({ kind: 'url', url: value });
      continue;
    }
    throw new ChannelRequestError(
      `参考素材读不出来：${value}。`,
      422,
      'CHANNEL_REFERENCE_UNREACHABLE',
      '画布素材库里的图片才能内联给云端端点；外链图片请先下载到素材库。',
    );
  }
  return assets;
}

/**
 * 参考素材 → 远程端点能拿到的形式（内联）。
 *
 * 画布节点上存的是本站素材 URL（`/api/aifisher/canvas/media/…`），外部端点访问不到，
 * 所以走素材库把字节读出来内联成 `data:image/png;base64,…`；data URL 与公网 URL 原样带上。
 */
export async function inlineChannelReferences(
  references: readonly string[],
  deps: { mediaStore?: MediaStore; maxBytes?: number } = {},
): Promise<string[]> {
  const assets = await resolveReferenceAssets(references, deps);
  return assets.map((asset) => {
    if (asset.kind === 'url') return asset.url;
    if (asset.kind === 'inline') return asset.dataUrl;
    return `data:${asset.mime};base64,${asset.bytes.toString('base64')}`;
  });
}

/**
 * 参考素材 → FisherAI 的 `images[]`（**只收公网直链**）。
 *
 * 已经是公网链接的原样用；data URL / 本站素材先解码成字节，再 `POST /files/upload` 换直链。
 * 上传结果不吃缓存：签名链接会过期，缓存下来的反而是坏链接。
 */
export async function uploadChannelReferences(
  channel: CloudChannel,
  references: readonly string[],
  deps: { mediaStore?: MediaStore; maxBytes?: number; fetcher?: typeof fetch } = {},
): Promise<string[]> {
  const assets = await resolveReferenceAssets(references, deps);
  const urls: string[] = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]!;
    if (asset.kind === 'url') {
      urls.push(asset.url);
      continue;
    }
    const bytes =
      asset.kind === 'inline'
        ? Buffer.from(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1), 'base64')
        : asset.bytes;
    const mime =
      asset.kind === 'inline'
        ? /^data:([^;,]+)/.exec(asset.dataUrl)?.[1] ?? 'image/png'
        : asset.mime;
    const extension =
      (asset.kind === 'bytes' && extname(asset.filename).toLowerCase()) ||
      Object.entries(EXTENSION_MIME).find(([, value]) => value === mime)?.[0] ||
      '.png';
    urls.push(
      await uploadChannelAsset({
        channel,
        bytes,
        filename: `reference-${index + 1}${extension}`,
        ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      }),
    );
  }
  return urls;
}

function roundTo(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * 画布档位 + 宽高比 → `长边 x 短边` 像素串（`1328x1328` 这种，魔搭/OpenAI 图像端点都用它）。
 *
 * 档位口径：`1K/2K/4K` = 长边 1024/2048/4096；`720p/1080p` = 长边 1280/1920；
 * `512` 这类纯数字 = 长边就是它。宽高比按 `a:b` 解，短边按比例算，最后对齐到 16 的倍数
 * （扩散模型的 VAE 下采样要求），并夹在 256–4096 之间。给不出档位就回 null（那就不带 size 字段）。
 */
export function sizeForRequest(body: Record<string, unknown> | null): string | null {
  const resolution = typeof body?.resolution === 'string' ? body.resolution.trim() : '';
  let longSide: number | null = null;
  const kilo = /^(\d+(?:\.\d+)?)\s*[kK]$/.exec(resolution);
  if (kilo) longSide = Math.round(Number(kilo[1]) * 1024);
  if (longSide === null) {
    const progressive = /^(\d{3,4})\s*[pP]$/.exec(resolution);
    if (progressive) longSide = Math.round((Number(progressive[1]) * 16) / 9);
  }
  if (longSide === null) {
    const plain = /^(\d{3,4})$/.exec(resolution);
    if (plain) longSide = Number(plain[1]);
  }
  if (longSide === null || !Number.isFinite(longSide)) return null;
  longSide = Math.min(Math.max(longSide, 256), 4096);

  const ratio = typeof body?.aspectRatio === 'string' ? body.aspectRatio.trim() : '';
  const match = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i.exec(ratio);
  let width = longSide;
  let height = longSide;
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a > 0 && b > 0) {
      if (a >= b) {
        width = longSide;
        height = (longSide * b) / a;
      } else {
        height = longSide;
        width = (longSide * a) / b;
      }
    }
  }
  return `${roundTo(width, 16)}x${roundTo(height, 16)}`;
}

/**
 * FisherAI 的档位词：只认 `1k` / `2k` / `4k`（文档与上游 relayProvider 都是小写这三档）。
 *
 * 画布给的是 `1K`/`2K`/`4K`，也可能给 `720p`/`1080p` 这类视频档 —— 后者一律按 1k 处理，
 * 因为把这个端点不认识的档位原样发上去会 400，而不是自动降级。
 */
export function workfisherResolution(body: Record<string, unknown> | null): string {
  const raw = typeof body?.resolution === 'string' ? body.resolution.trim().toLowerCase() : '';
  if (raw === '4k') return '4k';
  if (raw === '2k' || raw === '1440p') return '2k';
  return '1k';
}

/** 画布的宽高比 → `16:9` 这种串（FisherAI 的 `size` 就收它；给不出 / 是 Auto 就不带）。 */
export function channelAspectRatio(body: Record<string, unknown> | null): string | null {
  const raw = typeof body?.aspectRatio === 'string' ? body.aspectRatio.trim() : '';
  const match = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i.exec(raw);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (!(a > 0 && b > 0)) return null;
  return `${a}:${b}`;
}

function promptOf(body: Record<string, unknown> | null): string {
  if (!body) return '';
  if (typeof body.prompt === 'string' && body.prompt.trim()) return body.prompt;
  if (typeof body.text === 'string' && body.text.trim()) return body.text;
  return '';
}

function countOf(body: Record<string, unknown> | null): number {
  const raw = Number(body?.generateCount);
  return Number.isFinite(raw) && raw > 1 ? Math.min(Math.trunc(raw), 8) : 1;
}

/**
 * 画布要求的生成数量（与 `buildChannelPayload` 里用的是同一个上限 8）。
 *
 * 为什么要把这个上限暴露出去：魔搭的图像端点**不认 OpenAI 的 `n`**（2026-10-17 实测 n=2
 * 仍只回 1 张图），于是 host 侧得按这个数量**真的提交几次**，否则用户在画布上把
 * 「生成数量」调成 3 却只拿到一张，界面上没有任何解释。
 */
export function channelRequestCount(body: Record<string, unknown> | null): number {
  return countOf(body);
}

/**
 * 参考图落进请求体的字段 —— **各家的分歧点，而且都是静默出错**。
 *
 * 2026-10-17 用纯红参考图 + 「一个字没提颜色」的 prompt 实测（判据=输出里近红像素比例）：
 *   - `image_url`（数组）：100% → 参考图真的被用上了；
 *   - `image`：9%（无参考图的对照是 0%）→ 等于**被丢掉**，只有 prompt 生效；
 *   - 魔搭对不认识的 `image` 字段不报错、不回 400，直接按纯文生图跑完回一张图。
 * 所以「图片编辑变成重新画一张」这种故障在日志里一个字都看不出来，只能靠字段名对。
 *
 * FisherAI 那边是 `images`（数组），但值必须是**公网 http(s) 直链**：
 * 上游文档明确不收 base64 / 本地路径，data URL 传过去只会被忽略或 400，
 * 所以调用方必须先过 `/files/upload`（见 uploadChannelAsset），这里只负责摆字段。
 */
function referenceFields(
  dialect: ChannelDialect,
  images: readonly string[],
): Record<string, unknown> {
  if (!images.length) return {};
  if (dialect === 'modelscope') return { image_url: [...images] };
  if (dialect === 'workfisher') return { images: [...images] };
  return { image: images.length === 1 ? images[0] : images };
}

/**
 * 画布请求 → 该通道该模型能吃的请求体。
 *
 * **只带标准字段**（`model` / `prompt` / `size` / `n` / 参考图字段 / messages），不把画布的内部字段
 * （nodeId、projectId、cost、imageModel…）透出去：很多中转站对未知字段是**严格校验**，
 * 414 报错说明里还看不出是我们多带字段导致的。
 *
 * `dialect` 决定三件事：
 *   - 参考图放哪个字段（见 referenceFields）；
 *   - 要不要带 `n`：魔搭图像端点不认 OpenAI 的 `n`，FisherAI 的「低价扩展版」一个任务只收 1 张，
 *     两者的数量都靠调用方**真的提交几次**（见 cloudGenerationRouter）；
 *   - 尺寸怎么写：OpenAI 是 `1024x576` 像素串，FisherAI 是 `size:"16:9"` + `resolution:"1k"` 两件套。
 */
export function buildChannelPayload(input: {
  kind: CloudKind;
  model: CloudChannelModel;
  body: Record<string, unknown> | null;
  images?: readonly string[];
  dialect?: ChannelDialect;
}): Record<string, unknown> {
  const { kind, model, body } = input;
  const images = input.images ?? [];
  const dialect = input.dialect ?? 'openai';
  const prompt = promptOf(body);
  if (kind === 'text') {
    const messages = Array.isArray(body?.messages)
      ? (body?.messages as unknown[])
      : [{ role: 'user', content: prompt }];
    const payload: Record<string, unknown> = { model: model.id, messages, stream: false };
    const temperature = Number(body?.temperature);
    if (Number.isFinite(temperature)) payload.temperature = temperature;
    return payload;
  }
  const count = countOf(body);
  if (kind === 'image' && dialect === 'workfisher') {
    /*
     * FisherAI 图像任务。`nsfw_check: false` 是他们文档里的必填项（用户给的 curl 样例也带着它），
     * 不传时上游按自己的默认值跑，画风/审核策略就跟用户在别处实测的对不上。
     * `n` 固定 1：低价扩展版一个任务只回一张，数量由 router 按次提交。
     */
    const payload: Record<string, unknown> = {
      model: model.id,
      prompt,
      n: 1,
      resolution: workfisherResolution(body),
      nsfw_check: false,
    };
    const ratio = channelAspectRatio(body);
    if (ratio) payload.size = ratio;
    return { ...payload, ...referenceFields(dialect, images) };
  }
  const payload: Record<string, unknown> = { model: model.id, prompt };
  if (count > 1 && dialect !== 'modelscope') payload.n = count;
  if (kind === 'image') {
    const size = sizeForRequest(body);
    if (size) payload.size = size;
    return { ...payload, ...referenceFields(dialect, images) };
  }
  if (kind === 'video') {
    const duration = Number(body?.duration);
    if (Number.isFinite(duration) && duration > 0) payload.duration = duration;
    return { ...payload, ...referenceFields(dialect, images) };
  }
  // audio：prompt 之外只带歌词（纯音乐类端点根本不看它）
  const lyrics = typeof body?.lyrics === 'string' ? body.lyrics.trim() : '';
  if (lyrics) payload.lyrics = lyrics;
  return payload;
}

export interface ChannelRequestPlan {
  url: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  /** 实际生效的请求方言（诊断/报错里回给用户看）。 */
  dialect: ChannelDialect;
  /** 诊断/报错里回给用户的端点地址（不含密钥）。 */
  endpoint: string;
}

/** 该通道该媒体类型该打哪个路径：用户显式填的 > 方言自带的 > OpenAI 默认。 */
export function channelPath(channel: CloudChannel, kind: CloudKind): string {
  const override = channel.paths?.[kind];
  if (override && override.startsWith('/')) return override;
  return DIALECT_PATHS[channelDialect(channel)]?.[kind] ?? DEFAULT_PATHS[kind];
}

export function buildChannelRequest(input: {
  channel: CloudChannel;
  model: CloudChannelModel;
  kind: CloudKind;
  body: Record<string, unknown> | null;
  images?: readonly string[];
}): ChannelRequestPlan {
  const url = `${input.channel.baseUrl}${channelPath(input.channel, input.kind)}`;
  const dialect = channelDialect(input.channel);
  return {
    url,
    payload: buildChannelPayload({ ...input, dialect }),
    timeoutMs: input.channel.timeoutMs,
    dialect,
    endpoint: url,
  };
}

// ------------------------------------------------------------------ 异步任务（魔搭 / FisherAI 那套）

/**
 * 两套异步网关都走「提交拿号 → 轮询取结果」，但细节没有一处相同：
 *
 *   - **魔搭**：POST 立刻回 `{task_id, task_status}`（而且 task_status 当场就写 SUCCEED，不能信），
 *     要带 `X-ModelScope-Async-Mode` 才真建任务；轮询 `GET /tasks/{id}`（带 `X-ModelScope-Task-Type`），
 *     收尾是 `output_images: [...]`。
 *   - **FisherAI**：POST `/image/generations` 回任务号（或包在 `{code, data}` 里），
 *     轮询 `GET /image/generations/{id}`；状态机是大写的 NOT_START / SUBMITTED / IN_PROGRESS /
 *     SUCCESS / FAILURE，收尾把图片埋在 `data.data.content.image_urls[]`（`data.result_url` 兜底）。
 *     结果直链带签名、约 24 小时过期，**必须立刻下载转存**。
 *
 * 所以头、轮询地址、状态字段、结果字段四处都按方言分流；只有「POST 没有结果素材却带着任务号
 * → 去轮询」这条判断是两家共用的。
 */
export function channelAsyncHeaders(dialect: ChannelDialect = 'modelscope'): Record<string, string> {
  // 只有 FisherAI 那套网关不认这个头；OpenAI 兼容的中转站一律忽略未知头，
  // 所以保持 v1.11 起的老行为（非文本请求都带），免得动到已经跑通的通道。
  if (dialect === 'workfisher') return {};
  return { 'X-ModelScope-Async-Mode': 'true' };
}

/** 轮询任务的请求地址与头（魔搭从 base 拼 /tasks/{id}；FisherAI 是「提交地址 + /{id}」）。 */
export function channelTaskPoll(input: {
  channel: CloudChannel;
  kind: CloudKind;
  taskId: string;
  /** 提交时用的地址；FisherAI 的轮询地址由它推导，缺省才退回 base + /image/generations。 */
  submitUrl?: string;
}): { url: string; headers: Record<string, string> } {
  if (channelDialect(input.channel) === 'workfisher') {
    const submit =
      (input.submitUrl && input.submitUrl.trim()) || `${input.channel.baseUrl}/image/generations`;
    return {
      url: `${submit.replace(/\/+$/, '')}/${encodeURIComponent(input.taskId)}`,
      headers: { accept: 'application/json' },
    };
  }
  return {
    url: `${input.channel.baseUrl}/tasks/${encodeURIComponent(input.taskId)}`,
    headers: {
      accept: 'application/json',
      'X-ModelScope-Task-Type': `${input.kind}_generation`,
    },
  };
}

/** 响应可能被 `{code:'success', data:{…}}` 包一层（FisherAI 全程如此）。挑出真正装任务的那层。 */
export function channelTaskEnvelope(parsed: unknown): Record<string, unknown> {
  const body = (parsed ?? {}) as Record<string, unknown>;
  const inner = body.data;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  return body;
}

/** 从响应里取任务 ID（魔搭 / FisherAI 都是 `task_id`，FisherAI 还包在 data 里）。 */
export function channelTaskId(parsed: unknown): string | null {
  const root = (parsed ?? {}) as Record<string, unknown>;
  for (const body of [channelTaskEnvelope(parsed), root]) {
    for (const key of ['task_id', 'taskId']) {
      const value = body[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if (typeof body.task_status === 'string' && typeof body.id === 'string' && body.id.trim()) {
      return body.id.trim();
    }
  }
  return null;
}

export type ChannelTaskState = 'running' | 'succeeded' | 'failed';

/** 任务状态归一（魔搭：PENDING/RUNNING/SUCCEED；FisherAI：SUBMITTED/IN_PROGRESS/SUCCESS/FAILURE）。 */
export function channelTaskState(parsed: unknown): { state: ChannelTaskState; raw: string } {
  const body = channelTaskEnvelope(parsed);
  const raw = String(body.task_status ?? body.status ?? '').trim();
  const value = raw.toUpperCase();
  if (['SUCCEED', 'SUCCEEDED', 'SUCCESS', 'COMPLETED', 'DONE', 'FINISHED'].includes(value)) {
    return { state: 'succeeded', raw };
  }
  if (
    ['FAILED', 'FAIL', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'REVOKED', 'TIMEOUT'].includes(
      value,
    )
  ) {
    return { state: 'failed', raw };
  }
  return { state: 'running', raw };
}

/** 任务失败时给用户看的原因（魔搭放在 `errors`，FisherAI 放在 `fail_reason`/`error.message`）。 */
export function channelTaskError(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const body = channelTaskEnvelope(parsed);
  for (const key of ['errors', 'fail_reason', 'failed_reason', 'message', 'error']) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const inner of ['message', 'error', 'msg']) {
        const message = record[inner];
        if (typeof message === 'string' && message.trim()) return message.trim();
      }
    }
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  for (const key of ['message', 'error']) {
    const value = root[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 参考素材直链缓存：同一通道 + 同一份字节，12 小时内不重复上传（签名直链本身约 24h 过期）。 */
const UPLOAD_URL_TTL_MS = 12 * 60 * 60 * 1000;
const UPLOAD_URL_CACHE_MAX = 64;
/** 一次上传最多试几次（每一步都免费、可安全重放，见 uploadChannelAsset）。 */
const UPLOAD_MAX_ATTEMPTS = 3;
/** 再试也不划算的封顶时间：过了它就别耗着用户。 */
const UPLOAD_TOTAL_BUDGET_MS = 180_000;
const uploadUrlCache = new Map<string, { url: string; at: number }>();

function uploadCacheKey(baseUrl: string, bytes: Uint8Array): string {
  return `${baseUrl.replace(/\/+$/u, '')}|${createHash('sha1').update(bytes).digest('hex')}`;
}

/** 清空直链缓存（回归用：同一进程里要重新量一次「真的发生了上传」）。 */
export function resetChannelUploadCache(): void {
  uploadUrlCache.clear();
}

/** 诊断读数：缓存里几条直链、上限、TTL（不含链接本身）。 */
export function channelUploadCacheReport(): { entries: number; maxEntries: number; ttlMs: number } {
  return { entries: uploadUrlCache.size, maxEntries: UPLOAD_URL_CACHE_MAX, ttlMs: UPLOAD_URL_TTL_MS };
}

function rememberUploadUrl(key: string, url: string): void {
  uploadUrlCache.delete(key);
  uploadUrlCache.set(key, { url, at: Date.now() });
  // 只留最近用过的，别让一张张参考图把进程内存占着
  while (uploadUrlCache.size > UPLOAD_URL_CACHE_MAX) {
    const oldest = uploadUrlCache.keys().next().value;
    if (oldest === undefined) break;
    uploadUrlCache.delete(oldest);
  }
}

/**
 * 把一张参考素材换成 FisherAI 能访问的**公网直链**（`POST {base}/files/upload`，multipart 的 `file`）。
 *
 * 为什么非走这一步：那边只收公网 http(s) 直链，base64 / data URL / 本地路径一律不收。
 * 更麻烦的是它拒的时候常常不是 400 —— 只是把参考图当没传，输出跟纯文生图一模一样，
 * 日志里一个字都看不出来。所以画布上的素材（本站 /api/aifisher/canvas/media/… 或内联 data URL）
 * 必须先换链接，再把链接塞进 `images`。
 *
 * 为什么敢重试到底（2026-10-17 用户报障「上传参考素材到通道「Fisher」失败：fetch failed（ECONNRESET）」）：
 * 上传**不花钱、无副作用**（最坏是对象存储里多一个同样的文件），而这条链路实测会偶发被重置
 * —— 同一台机器、同一份 2.2MB 素材，独立进程里连传 3 次都成，DSH 进程里也会「一次失败、下一次又好」。
 * 以前只重试「连接阶段」那几个码（`UND_ERR_CONNECT_TIMEOUT` 等），`ECONNRESET` 一出现就直通用户，
 * 于是一次瞬时中断就变成了「这张图永远生成不了」。
 *
 * 另外两点：每次尝试都换一条**新的**超时信号（复用同一条的话，第一次超时会把后面几次一起毙掉）；
 * 换回来的直链会按「通道 + 字节 sha1」缓存 12 小时，同一张参考图再生成时不必重传。
 */
export async function uploadChannelAsset(input: {
  channel: CloudChannel;
  bytes: Uint8Array;
  filename: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const fetcher = input.fetcher ?? globalThis.fetch;
  const extension = extname(input.filename).toLowerCase() || '.png';
  const mime = EXTENSION_MIME[extension] ?? 'image/png';
  const baseUrl = input.channel.baseUrl.replace(/\/+$/u, '');
  const url = `${baseUrl}${WORKFISHER_UPLOAD_PATH}`;
  const cacheKey = uploadCacheKey(baseUrl, input.bytes);
  const cached = uploadUrlCache.get(cacheKey);
  if (cached && Date.now() - cached.at < UPLOAD_URL_TTL_MS) {
    console.log(`[aifisher-canvas] 参考素材已在直链缓存里（${input.bytes.byteLength}B），跳过上传`);
    return cached.url;
  }
  const form = new FormData();
  // TS 5.9 的 BlobPart 要求 ArrayBufferView<ArrayBuffer>，而 Buffer 的类型是
  // Uint8Array<ArrayBufferLike>（可能包 SharedArrayBuffer 的签名）；运行时 Blob
  // 完全接受，这里只做类型收窄，不复制字节。
  form.append('file', new Blob([input.bytes as unknown as BlobPart], { type: mime }), `reference${extension}`);
  const attemptTimeoutMs = input.timeoutMs ?? 120_000;

  const started = Date.now();
  let attempts = 0;
  let response: Response | null = null;
  let lastError: unknown = null;
  while (attempts < UPLOAD_MAX_ATTEMPTS) {
    attempts += 1;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          ...(input.channel.apiKey ? { authorization: `Bearer ${input.channel.apiKey}` } : {}),
        },
        body: form,
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const elapsedMs = Date.now() - started;
      const retryable =
        attempts < UPLOAD_MAX_ATTEMPTS &&
        elapsedMs < UPLOAD_TOTAL_BUDGET_MS &&
        isRetryableUploadFailure(error);
      console.warn(
        `[aifisher-canvas] 参考素材上传失败（第 ${attempts}/${UPLOAD_MAX_ATTEMPTS} 次，` +
          `${input.bytes.byteLength}B，${(elapsedMs / 1000).toFixed(1)}s）：${describeFetchFailure(error)}` +
          (retryable ? ' → 这一步免费可重放，再试一次' : ''),
      );
      if (!retryable) break;
      await new Promise((done) => setTimeout(done, 400 * attempts));
    }
  }
  if (!response) {
    const elapsed = Date.now() - started;
    const sizeMb = Math.max(0.1, input.bytes.byteLength / 1024 / 1024).toFixed(1);
    throw new ChannelRequestError(
      `上传参考素材到通道「${input.channel.label}」失败（${sizeMb}MB，试了 ${attempts} 次 / ` +
        `${(elapsed / 1000).toFixed(1)}s）：${describeFetchFailure(lastError)}`,
      502,
      'CHANNEL_UPLOAD_UNREACHABLE',
      '这一步只是把参考图换成公网直链，免费、可安全重试：直接再点一次生成就行。' +
        '每次都断多半是这台机器到该域名的上行被拦（代理/VPN/公司网关最常见），先关掉代理再试；' +
        'FisherAI 的参考图必须是公网直链，base64 传过去会被它静默丢掉。',
    );
  }

  const raw = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const envelope = channelTaskEnvelope(parsed);
  const root = (parsed ?? {}) as Record<string, unknown>;
  const relative =
    (typeof envelope.url === 'string' && envelope.url.trim()) ||
    (typeof root.url === 'string' && root.url.trim()) ||
    '';
  if (!response.ok || !relative) {
    throw new ChannelRequestError(
      `通道「${input.channel.label}」没有返回参考素材的公网直链（HTTP ${response.status}）：${raw.slice(0, 200)}`,
      502,
      'CHANNEL_UPLOAD_REJECTED',
    );
  }
  if (/^https?:\/\//i.test(relative)) {
    rememberUploadUrl(cacheKey, relative);
    return relative;
  }
  // 少数网关回相对路径：按通道地址补成绝对链接
  try {
    const absolute = new URL(relative, `${baseUrl}/`).href;
    rememberUploadUrl(cacheKey, absolute);
    return absolute;
  } catch {
    throw new ChannelRequestError(
      `通道「${input.channel.label}」返回的素材链接不可用：${relative.slice(0, 120)}`,
      502,
      'CHANNEL_UPLOAD_REJECTED',
    );
  }
}

/**
 * `fetch failed` 真正有用的信息在 `error.cause.code` 里（undici 只把泛化的 TypeError 抛上来）。
 *
 * 2026-10-17 实测这台机器到 `api.work-fisher.com`（Cloudflare）**约 1/6 次连接会 10.5s 超时**
 * （`UND_ERR_CONNECT_TIMEOUT`），单看 `fetch failed` 完全分不清是「地址不通」还是「这次没连上」。
 */
export function describeFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  const detail = cause?.code ?? cause?.message;
  return detail && !message.includes(detail) ? `${message}（${detail}）` : message;
}

/**
 * 连接阶段就失败（**一个字节都没发出去**）。
 *
 * 这类可以安全重试：请求根本没到对面，不存在「重试一次就多扣一次钱」。
 * 反过来 `UND_ERR_SOCKET` / headers/body timeout 是已经发出去又断了 —— 那种不重试，
 * 尤其是提交请求（对端可能已经建了任务并在计费）。
 */
export function isConnectLevelFetchFailure(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? '';
  return [
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_CONNECT_ERROR',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
  ].includes(code);
}

/**
 * 参考素材上传可以重试的那些失败。
 *
 * 与 {@link isConnectLevelFetchFailure}（提交生成请求只认「一个字节都没发出去」）的分界线是**钱**：
 * 上传免费、无副作用，所以「发出去一半被重置」「连上了但管道被掐（socket hang up）」
 * 都能重放；提交任务那边重放等于重复计费，绝不能共用这套判断。
 *
 * `ECONNRESET` 正是 2026-10-17 用户截图里那条报错的 cause —— 以前它不在白名单里，
 * 一次瞬时中断就直接告诉用户「生成不了」。
 */
export function isRetryableUploadFailure(error: unknown): boolean {
  const record = error as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const code = record?.cause?.code ?? record?.code ?? '';
  if (
    [
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      'ECONNABORTED',
      'UND_ERR_SOCKET',
      'UND_ERR_CLOSED',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_CONNECT_ERROR',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
    ].includes(code)
  ) {
    return true;
  }
  // undici 有时把原因折成一句话（没有 code），同样算「链路断了一下」
  return /socket hang up|other side closed|fetch failed/i.test(String(record?.message ?? ''));
}

/** 诊断用（不回密钥）。 */
export function channelDiagnostics(channels: readonly CloudChannel[]): Record<string, unknown> {
  return {
    count: channels.length,
    /** 参考素材直链缓存（v1.35）：同一张图第二次起不再上传，条数/上限/TTL 一眼可见。 */
    uploads: channelUploadCacheReport(),
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey ? '已设置' : '未设置',
      /** `自动` = 没显式配，按地址判定为 dialect 那一栏。 */
      dialect: channel.dialect ?? '自动',
      dialectDetected: channelDialect(channel),
      models: channel.models.length,
      kinds: [...new Set(channel.models.map((model) => model.kind))].sort(),
    })),
  };
}
