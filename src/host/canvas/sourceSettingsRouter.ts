/**
 * 「闭源服务」设置页 + 网络素材校验（host 半）。
 *
 * 上游这一页是 AIFISHER 的**服务商矩阵**：relay / runninghub / 即梦 … 每个渠道一组密钥，
 * 密钥存在后端，模型目录与价格由后端发布。本插件在这一页只留一张诚实卡片：
 *
 *   「火山方舟（豆包）直连」—— 只认 ARK_API_KEY，模型表就是画布自己目录里那几条
 *   `DoubaoImageProvider`（图片）与 `DoubaoVideoProvider`（视频，Seedance）记录
 *   （见 generation/arkImageProvider.ts 与 generation/arkVideoProvider.ts）。
 *
 * 用户自配的端点走**另一块自己的面板**：「OpenAI 通道」（多通道 + 每条通道勾模型，
 * 见 host/canvas/cloudChannelsRouter.ts 与 canvas-ui/canvas/CloudChannelPanel.ts）。
 * 而 v1.4–v1.12 那张「自配云端端点（OpenAI 兼容）」单端点卡片（`AIFISHER_CLOUD_BASE_URL`）
 * 已在 v1.13 **整体移除**（2026-10-16，用户要求「移除这个 api 配置」）—— 卡片、可写白名单、
 * 生成链路与模型来源全部撤掉，旧键改成**明确拒绝**并指路到通道面板，不再静默忽略。
 *
 *   GET  /generation/sources                   { blocks: [ ark ] }
 *   GET  /config/keys                          { ARK_ENDPOINT_CONFIGURED, … }
 *   POST /config/keys    { 键值对 }            白名单落盘 + 立刻生效 → { success: true }
 *   GET  /generation/model-availability?…      { groups: ModelGroup[] }（方舟 + 自配通道，价格未知）
 *   POST /verify-tos-url { networkUrl }        { exists: boolean }
 *
 * 契约细节来自 vendor 的 sourceSettingsClient.ts / sourceSettings.ts：
 *   - POST /config/keys 必须回 `{success:true}`，否则界面报「未收到保存成功回执」；
 *   - GET /config/keys 只被用来读旧版 RunningHub 字段（字符串），所以多回几个字段无害；
 *   - blocks 里**只给「配置没配置」的布尔量**，密钥值永远不回给前端（上游注释明确要求，
 *     否则掩码会被当密钥存回去）；
 *   - model-availability 的前端超时只有 2 秒，必须快（纯内存合成 + 读一次小文件）。
 *
 * 密钥落盘：<画布数据目录>/cloud-keys.json（仅本机；不含任何内置密钥）。
 * 支持从界面改的键（白名单）＝火山方舟那套环境变量；改完**立即生效**（写进 process.env），
 * 重启后由 applySavedCloudKeys() 重新灌回去。
 *
 * 不支持的键（COMFYUI_ROOT / COMFYUI_AUTO_START / COMFYUI_URL）明确拒绝并说明原因 ——
 * 本插件不托管 ComfyUI 进程，安装目录这套没有意义；宁可报错也不假装保存成功
 * （上游前端「验证并添加目录」那条路不检查 status 就取 root，静默成功会造成假象）。
 */
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonBody, sendJson } from '../http/httpUtil';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  TEXT_MODELS,
  VIDEO_MODELS,
} from '../../../vendor/aifisher/src/config/modelConfig';
import { modelOverrideKey } from '../../../vendor/aifisher/src/shared/modelOverrideKey';
import {
  arkImageEntries,
  arkModelIdOf,
  arkPriceFor,
  isArkImageModel,
  readArkConfig,
  type ArkCatalogEntry,
} from '../generation/arkImageProvider';
import {
  arkVideoEntries,
  arkVideoPriceFor,
  isArkVideoModel,
  readArkVideoConfig,
  type ArkVideoEntry,
} from '../generation/arkVideoProvider';
import {
  channelModelEntries,
  readCloudChannels,
  type CloudChannel,
} from '../generation/cloudChannels';

export interface SourceSettingsDeps {
  dataDir: string;
}

/** 能从界面改、且真的会改行为的键。 */
export const SETTINGS_KEY_WHITELIST: readonly string[] = Object.freeze([
  // 火山方舟（豆包）直连 —— 图片（Seedream）与视频（Seedance）共用同一个 Key / 域名
  'ARK_API_KEY',
  'ARK_BASE_URL',
  'ARK_IMAGE_PATH',
  'ARK_TIMEOUT_MS',
  'ARK_WATERMARK',
  // 视频任务接口（异步任务：提交 → 轮询）
  'ARK_VIDEO_PATH',
  'ARK_VIDEO_TIMEOUT_MS',
]);

/** 每个模型一条的「自定义模型 ID」键：`MODEL_ID_CUSTOM_<码点十六进制>`（与 vendor 同形）。 */
const MODEL_OVERRIDE_KEY = /^MODEL_ID_CUSTOM_[0-9a-f]+(?:_[0-9a-f]+)*$/;

/** 密钥类键：GET /config/keys **永不回显**它们的值（上游注释明确要求，否则掩码会被当密钥存回去）。 */
const SECRET_KEYS: readonly string[] = Object.freeze(['ARK_API_KEY']);

/** 明确拒绝的键 → 给用户的原因。 */
const REFUSED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  AIFISHER_CLOUD_BASE_URL:
    '「自配云端端点」已在 v1.13 移除：请到「闭源服务 → OpenAI 通道」里添加通道（可以配好几条），'
    + '密钥也填在那里。',
  AIFISHER_CLOUD_API_KEY:
    '「自配云端端点」的密钥已随那张卡片移除：请把密钥填到「闭源服务 → OpenAI 通道」的通道上。',
  AIFISHER_CLOUD_IMAGE_PATH:
    '单端点已移除：按媒体类型的路径改在通道的「路径覆盖」里配。',
  AIFISHER_CLOUD_VIDEO_PATH:
    '单端点已移除：按媒体类型的路径改在通道的「路径覆盖」里配。',
  AIFISHER_CLOUD_AUDIO_PATH:
    '单端点已移除：按媒体类型的路径改在通道的「路径覆盖」里配。',
  AIFISHER_CLOUD_TEXT_PATH:
    '单端点已移除：按媒体类型的路径改在通道的「路径覆盖」里配。',
  AIFISHER_CLOUD_TIMEOUT_MS: '单端点已移除：超时改在通道上配置。',
  COMFYUI_ROOT:
    'DSH 版不托管 ComfyUI 进程，也不需要它的安装目录：请用绘世启动器启动 ComfyUI。',
  COMFYUI_AUTO_START: 'DSH 版不会自动启动 ComfyUI（进程由绘世启动器管理）。',
  COMFYUI_URL: 'ComfyUI 地址在 host 进程启动时读取；请改环境变量 COMFYUI_URL 后重启 DSH。',
});

function keysPath(dataDir: string): string {
  return join(dataDir, 'cloud-keys.json');
}

async function readKeys(dataDir: string): Promise<Record<string, string>> {
  const file = keysPath(dataDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

async function writeKeys(dataDir: string, keys: Record<string, string>): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const file = keysPath(dataDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(keys, null, 2), 'utf8');
  await rename(tmp, file);
}

/**
 * 把落盘的键灌进 process.env（白名单里的，以及每条 `MODEL_ID_CUSTOM_*`）。
 * 返回生效的键名。环境变量优先：显式配置过的环境不该被界面里存过的值覆盖。
 */
export async function applySavedCloudKeys(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const keys = await readKeys(dataDir);
  const names = [
    ...SETTINGS_KEY_WHITELIST,
    ...Object.keys(keys).filter((name) => MODEL_OVERRIDE_KEY.test(name)),
  ];
  const applied: string[] = [];
  for (const name of names) {
    const value = keys[name];
    if (!value) continue;
    if (env[name] !== undefined && env[name] !== '') continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

interface CatalogModel {
  name?: unknown;
  brand?: unknown;
  provider?: unknown;
  tier?: unknown;
  variantLabel?: unknown;
  canonicalModel?: unknown;
  vision?: unknown;
  [key: string]: unknown;
}

function catalogOf(kind: 'image' | 'video' | 'text' | 'audio'): CatalogModel[] {
  const source =
    kind === 'image'
      ? IMAGE_MODELS
      : kind === 'video'
        ? VIDEO_MODELS
        : kind === 'text'
          ? TEXT_MODELS
          : AUDIO_MODELS;
  return source as unknown as CatalogModel[];
}

/**
 * 「火山方舟（豆包）直连」卡片。
 *
 * 只列画布目录里那几条方舟模型 —— 它们的 `endpoint[...].model` 就是方舟模型 ID，
 * host 半的 arkImageProvider / arkVideoProvider 按同一份目录翻译请求，所以这里不做第二份模型表。
 *
 * 图片（Seedream）与视频（Seedance）共用同一把 ARK_API_KEY，所以是**一张卡片、两种媒体**：
 * 视频那条 `configured` 同样看 Key —— 画布 agent 的 prepareGeneration 就是靠这份 blocks
 * 判断「这个模型能不能生成」的。
 */
function arkBlock(env: NodeJS.ProcessEnv) {
  const config = readArkConfig(env);
  const videoConfig = readArkVideoConfig(env);
  const configured = Boolean(config.apiKey);
  const videoConfigured = Boolean(videoConfig.apiKey);
  const models = arkImageEntries().map((entry) => {
    const override = (env[modelOverrideKey(entry.name)] ?? '').trim();
    const defaultModelId =
      entry.endpoint?.['text-to-image']?.model ?? entry.endpoint?.['image-to-image']?.model ?? '';
    return {
      name: entry.name,
      vision: 'unknown',
      ...(override ? { customModelId: override } : {}),
      ...(defaultModelId ? { modelIds: [defaultModelId] } : {}),
      tier: 'standard',
      variantLabel: null,
      requiredSecrets: ['ARK_API_KEY'],
      configured,
    };
  });
  const videoModels = arkVideoEntries().map((entry) => {
    const override = (env[modelOverrideKey(entry.name)] ?? '').trim();
    const defaultModelId =
      entry.endpoint?.['text-to-video']?.model ?? entry.endpoint?.['multimodal']?.model ?? '';
    return {
      name: entry.name,
      vision: 'unknown',
      ...(override ? { customModelId: override } : {}),
      ...(defaultModelId ? { modelIds: [defaultModelId] } : {}),
      tier: 'standard',
      variantLabel: '视频',
      requiredSecrets: ['ARK_API_KEY'],
      configured: videoConfigured,
    };
  });
  return {
    source: 'ark',
    label: '火山方舟（豆包直连）',
    singleKey: true,
    secrets: [{ key: 'ARK_API_KEY', configured }],
    media: [
      { kind: 'image', models },
      { kind: 'video', models: videoModels },
    ],
  };
}

/**
 * 由本机模型目录 + 用户自配通道合成「模型可用性」分组。
 *
 * v1.13 起本插件只有两条云端后端：
 *   ① **火山方舟（豆包）直连**的图片模型 —— 目录里标着 `DoubaoImageProvider` 且端点指向方舟，
 *      可用性看 ARK_API_KEY，且给「元/张」的价格预估；
 *   ② 用户自配的 **OpenAI 通道**（v1.11 起）—— 每条勾选的模型一个变体，来源标成通道名，
 *      价格一律未知（计费由用户自己的端点决定）。
 *
 * 目录里其余模型（relay / runninghub / 即梦 / 厂商 CLI…）属于上游服务商矩阵，本插件没有它们的
 * 后端，**不再出现在这里**（v1.13 之前它们被标成「自配云端端点」，那条单端点已移除）。
 * 画布模型下拉按 `sourceLabel` 让用户选「从哪家出」，选中的名字原样进 imageModel，host 据此分发。
 *
 * 价格：方舟图片模型给**元/张**的预估（5.0 pro 按官方「≤236 万像素 0.3 元、超过 0.6 元」的
 * 像素口径算，其余用目录里上游记的单价），所以 query 里画布当前选的档位与宽高比要带进来 ——
 * 这正是画布 modelPicker / 节点价格标签调用这条接口时传的参数。给不出可靠数字就回 null
 * （画布显示「价格未知」），不编数字。
 */
function modelGroups(
  env: NodeJS.ProcessEnv,
  query: {
    resolution?: string | null;
    aspectRatio?: string | null;
    mode?: string | null;
    duration?: number | null;
    generateAudio?: boolean | null;
  } = {},
  channels: readonly CloudChannel[] = [],
) {
  const arkReady = Boolean(readArkConfig(env).apiKey);
  const groups = new Map<string, Record<string, unknown>>();

  /** 目录条目的能力词表（`xxxModes` / `xxxReferenceTypes`）—— 只用来在模型下拉里显示标签。 */
  const capabilitiesOf = (model: CatalogModel): string[] => {
    const caps: string[] = [];
    for (const key of Object.keys(model)) {
      if (!/(Modes|ReferenceTypes)$/.test(key)) continue;
      const value = model[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item === 'string' && item && !caps.includes(item)) caps.push(item);
      }
    }
    return caps;
  };
  // 通道模型的合成条目也挂在本机目录上（见 src/client/canvas/stage.tsx 的安装器），
  // 所以能力词表按名字从目录里取 —— 一二级下拉都靠它显示「文生图 / 首帧」这类标签。
  const capsByName = new Map<string, string[]>();
  const mergeCaps = (name: string, caps: readonly string[]) => {
    if (!caps.length) return;
    const merged = capsByName.get(name) ?? [];
    for (const cap of caps) if (!merged.includes(cap)) merged.push(cap);
    capsByName.set(name, merged);
  };
  for (const kind of ['image', 'video', 'text', 'audio'] as const) {
    for (const model of catalogOf(kind)) {
      const name = typeof model.name === 'string' ? model.name : '';
      if (name) mergeCaps(name, capabilitiesOf(model));
    }
  }

  // ① 火山方舟直连的图片模型（唯一的「目录模型」后端）
  for (const model of catalogOf('image')) {
    const name = typeof model.name === 'string' ? model.name : '';
    if (!name || !isArkImageModel(name)) continue;
    const canonical = (typeof model.canonicalModel === 'string' && model.canonicalModel) || name;
    const group = groups.get(canonical) ?? {
      canonicalModel: canonical,
      brand: '火山方舟',
      capabilities: capsByName.get(name) ?? [],
      available: arkReady,
      variants: [] as Record<string, unknown>[],
    };
    if (arkReady) group.available = true;
    const entry = model as unknown as ArkCatalogEntry;
    const estimate = arkPriceFor(entry, arkModelIdOf(entry), {
      resolution: query.resolution,
      aspectRatio: query.aspectRatio,
      mode: query.mode,
    });
    (group.variants as Record<string, unknown>[]).push({
      name,
      source: 'ark',
      sourceLabel: '火山方舟',
      variantLabel:
        typeof model.variantLabel === 'string' && model.variantLabel ? model.variantLabel : null,
      tier: typeof model.tier === 'string' && model.tier ? model.tier : 'standard',
      premium: model.premium === true,
      price: estimate ? estimate.price : null,
      priceLabel: null,
      priceNote: estimate?.note ?? '价格以方舟账单为准。',
      priceExact: false,
      configured: arkReady,
      requiredSecrets: ['ARK_API_KEY'],
    });
    groups.set(canonical, group);
  }

  // ①b 火山方舟直连的**视频**模型（Seedance，异步任务接口）
  //
  // 与图片同一条原则：模型名逐字取目录，host 的 arkVideoProvider 按同一份目录翻译请求。
  // 价格是**元/秒**（目录里上游记的分档价）—— 画布的视频 composer 会自己乘时长与数量，
  // 所以这里给单价、并在 priceLabel 上写明「/秒」，免得二级下拉把它读成整条片子的价。
  const arkVideoReady = Boolean(readArkVideoConfig(env).apiKey);
  for (const model of catalogOf('video')) {
    const name = typeof model.name === 'string' ? model.name : '';
    if (!name || !isArkVideoModel(name)) continue;
    const canonical = (typeof model.canonicalModel === 'string' && model.canonicalModel) || name;
    const group = groups.get(canonical) ?? {
      canonicalModel: canonical,
      brand: '火山方舟',
      capabilities: capsByName.get(name) ?? [],
      available: arkVideoReady,
      variants: [] as Record<string, unknown>[],
    };
    if (arkVideoReady) group.available = true;
    const estimate = arkVideoPriceFor(model as unknown as ArkVideoEntry, {
      resolution: query.resolution,
      duration: query.duration,
    });
    (group.variants as Record<string, unknown>[]).push({
      name,
      source: 'ark',
      sourceLabel: '火山方舟',
      variantLabel:
        typeof model.variantLabel === 'string' && model.variantLabel ? model.variantLabel : '视频',
      tier: typeof model.tier === 'string' && model.tier ? model.tier : 'standard',
      premium: model.premium === true,
      price: estimate.price,
      priceLabel: estimate.price === null ? null : `≈¥${estimate.price}/秒`,
      priceNote: estimate.note,
      priceExact: false,
      configured: arkVideoReady,
      requiredSecrets: ['ARK_API_KEY'],
    });
    groups.set(canonical, group);
  }

  // ② 用户自配的 OpenAI 通道（v1.11）：每条勾选的模型 = 一个变体，来源标成通道名。
  // 画布的模型下拉正是「一级模型名、二级来源」，所以两个通道都提供同一个模型 ID 时，
  // 用户能在二级里选「从哪条通道出图」—— 这正是多通道要的效果。
  for (const entry of channelModelEntries(channels)) {
    const group = groups.get(entry.name) ?? {
      canonicalModel: entry.name,
      brand: entry.channelLabel,
      capabilities: capsByName.get(entry.name) ?? [],
      available: true,
      variants: [] as Record<string, unknown>[],
    };
    group.available = true;
    (group.variants as Record<string, unknown>[]).push({
      name: entry.name,
      // 上游 variant 的 source 字段沿用 `dsh_cloud`（画布侧的通道注册表 CloudChannelModels.ts 同值）——
      // 现在它只表示「用户自配的 OpenAI 通道」，旧版单端点已不存在。
      source: 'dsh_cloud',
      sourceLabel: entry.channelLabel,
      variantLabel: KIND_LABELS[entry.kind] ?? null,
      tier: 'standard',
      premium: false,
      price: null,
      priceLabel: null,
      priceNote: `自有通道「${entry.channelLabel}」：计费与可用性以该端点为准。`,
      priceExact: false,
      configured: true,
      requiredSecrets: [],
    });
    groups.set(entry.name, group);
  }
  return [...groups.values()];
}

/** 媒体类型的中文名（通道来源的 variantLabel 用）。 */
const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
});

/**
 * 自配 OpenAI 通道 → `SourceBlock`（v1.52）。
 *
 * 缺口背景：`/generation/sources` 原先只回方舟一张卡，而 `canvasCreationControl`
 * 是靠这份 blocks 判断模型是否 configured —— 于是自配通道的模型（比如 Fisher 的
 * GPT-Image-2.5-flare）在节点上手点能生成，agent 的 prepareGeneration 却恒 UNAVAILABLE。
 *
 * 现在每条通道合成一张 block：
 *   - `source: "channel:<id>"`、`accountManaged: true`：设置页不会渲染密钥输入框和
 *     「保存密钥」按钮，只显示通道名与模型目录；密钥仍然只在「OpenAI 通道」面板里管；
 *   - 模型名用 `channelModelName()` 的**画布显示名** —— 节点上存的就是它，必须逐字对上；
 *   - 一律 `configured: true`：通道存在且勾选了这条模型，就是可用的
 *     （真正调用失败由 generate 阶段报错，不在这里预判）。
 *
 * **与生成确认无关**：审批仍然只在画布 UI 上（canvasCreationControl.approve 不暴露给
 * canvas_control）。这里只是让「准备生成」能看到这些模型。
 */
function channelBlocks(channels: readonly CloudChannel[]): Record<string, unknown>[] {
  return channels.map((channel) => {
    const media = new Map<string, Array<Record<string, unknown>>>();
    for (const entry of channelModelEntries([channel])) {
      const models = media.get(entry.kind) ?? [];
      models.push({
        name: entry.name,
        vision: 'unknown',
        tier: 'standard',
        variantLabel: KIND_LABELS[entry.kind] ?? null,
        requiredSecrets: [],
        configured: true,
      });
      media.set(entry.kind, models);
    }
    return {
      source: `channel:${channel.id}`,
      label: `${channel.label}（自配通道）`,
      singleKey: false,
      accountManaged: true,
      secrets: [],
      media: [...media.entries()].map(([kind, models]) => ({ kind, models })),
    };
  });
}

/** 私网/环回地址不探测（避免把 host 变成内网探针）。 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 网络素材是否还在（上游用它清理过期的 networkUrl）。
 * 判定原则与前端一致：**只有明确的「不存在」才回 false**，
 * 网络错误 / 超时 / 私网地址一律回 true（不能让不确定把用户的素材链接清掉）。
 */
async function verifyNetworkUrl(networkUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(networkUrl);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  if (isPrivateHost(parsed.hostname)) return true;
  try {
    const response = await fetch(parsed.href, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(5_000),
    });
    if ([401, 403, 404, 410].includes(response.status)) return false;
    return true;
  } catch {
    return true;
  }
}

/** 处理 /config/keys、/generation/*、/verify-tos-url；已处理返回 true。 */
export async function handleSourceSettingsApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: SourceSettingsDeps;
}): Promise<boolean> {
  const { req, res, url, parts, deps } = input;
  const method = (req.method ?? 'GET').toUpperCase();

  if (parts[0] === 'config' && parts[1] === 'keys' && parts.length === 2) {
    const stored = await readKeys(deps.dataDir);
    if (method === 'GET') {
      // 只回「非密钥」的配置；密钥值永不回前端（上游用布尔量代替）。
      // 旧版自配单端点的 AIFISHER_CLOUD_BASE_URL 已移除，这里连它都不再回显。
      sendJson(res, 200, {
        ARK_ENDPOINT_CONFIGURED: readArkConfig().apiKey ? 'true' : '',
        ...Object.fromEntries(
          Object.entries(stored)
            .filter(([key]) => !SECRET_KEYS.includes(key))
            .map(([key, value]) => [key, value]),
        ),
      });
      return true;
    }
    if (method === 'POST' || method === 'PATCH') {
      const body = (await readJsonBody(req, 64 * 1024)) as Record<string, unknown> | null;
      if (!body) {
        sendJson(res, 422, { error: '配置内容无效。', code: 'KEYS_INVALID' });
        return true;
      }
      for (const [key, value] of Object.entries(body)) {
        const refused = REFUSED_KEYS[key];
        if (refused && typeof value === 'string' && value) {
          sendJson(res, 409, { error: refused, code: 'KEY_NOT_SUPPORTED', key });
          return true;
        }
      }
      const next = { ...stored };
      for (const [key, value] of Object.entries(body)) {
        if (typeof value !== 'string') continue;
        if (value === '') delete next[key];
        else next[key] = value;
        if (SETTINGS_KEY_WHITELIST.includes(key) || MODEL_OVERRIDE_KEY.test(key)) {
          // 立刻生效：方舟直连每次调用都读 process.env
          if (value === '') delete process.env[key];
          else process.env[key] = value;
        }
      }
      await writeKeys(deps.dataDir, next);
      sendJson(res, 200, { success: true });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  if (parts[0] === 'generation' && parts[1] === 'sources' && parts.length === 2) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    // 方舟直连 + 用户自配的 OpenAI 通道（v1.52）。
    // 后者是 canvas_creation 的「准备生成」能认出通道模型的前提（见 channelBlocks 的注释）；
    // 用户自配端点仍走「OpenAI 通道」面板管理，这里只是合成只读的来源描述。
    const channels = await readCloudChannels(deps.dataDir);
    sendJson(res, 200, { blocks: [arkBlock(process.env), ...channelBlocks(channels)] });
    return true;
  }

  if (parts[0] === 'generation' && parts[1] === 'model-availability') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    // 纯内存合成：前端这条的超时只有 2 秒。
    // 画布会把当前选的档位/宽高比/模式/时长带过来，方舟的单价预估要用它们（见 modelGroups）。
    // 自配通道表要读一次磁盘（小文件），所以放在这条 await 里。
    const rawDuration = Number(url.searchParams.get('duration'));
    const rawGenerateAudio = url.searchParams.get('generateAudio');
    sendJson(res, 200, {
      groups: modelGroups(
        process.env,
        {
          resolution: url.searchParams.get('resolution'),
          aspectRatio: url.searchParams.get('aspectRatio'),
          mode: url.searchParams.get('mode'),
          duration: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
          generateAudio:
            rawGenerateAudio === null ? null : rawGenerateAudio === 'true',
        },
        await readCloudChannels(deps.dataDir),
      ),
    });
    return true;
  }

  if (parts[0] === 'verify-tos-url' && parts.length === 1) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const body = (await readJsonBody(req, 16 * 1024)) as { networkUrl?: unknown } | null;
    const networkUrl = typeof body?.networkUrl === 'string' ? body.networkUrl : '';
    if (!networkUrl) {
      sendJson(res, 200, { exists: true });
      return true;
    }
    sendJson(res, 200, { exists: await verifyNetworkUrl(networkUrl) });
    return true;
  }

  return false;
}

/** 诊断用：闭源服务配置状态（不回显密钥）。 */
export async function sourceSettingsStatus(dataDir: string): Promise<Record<string, unknown>> {
  const stored = await readKeys(dataDir);
  const ark = readArkConfig();
  return {
    arkConfigured: Boolean(ark.apiKey),
    arkBaseUrl: ark.baseUrl,
    arkWatermark: ark.watermark,
    savedKeys: Object.keys(stored).sort(),
    envManaged: SETTINGS_KEY_WHITELIST.filter(
      (key) => (process.env[key] ?? '') !== '' && stored[key] === undefined,
    ),
  };
}
