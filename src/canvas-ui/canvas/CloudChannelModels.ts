/**
 * 自配 OpenAI 通道的模型 → 画布能用的「模型条目」（运行时注册表）。
 *
 * 为什么需要它：画布的四个 composer 都从**静态目录**
 * `vendor/aifisher/src/config/modelConfig.ts` 里取模型（档位、宽高比、模式、高级参数都在条目上），
 * 而用户自己端点上的模型 ID（`Qwen/Qwen-Image`、`Wan2.2-T2V-A14B`…）当然不在那份目录里。
 *
 * 做法：**往那四个数组（IMAGE_MODELS / VIDEO_MODELS / AUDIO_MODELS / TEXT_MODELS）原地追加**
 * 合成的条目，保存时再把上一轮追加的摘掉。这样做的好处是一次改动四处生效，且**数组身份不变**：
 *   - `vendor/.../app/canvasComponents.ts` 里 `models: IMAGE_MODELS` 引的就是同一个数组 → 四个下拉都有了；
 *   - `src/client/canvas/stage.tsx` 模块级的 `models` / `catalog`（喂 useCanvasGeneration 与连线校验）
 *     也是同一个数组 → 请求构造能拿到 advancedParams（否则视频时长会恒为 4）；
 *   - 装在**最前面** → `runtime.imageModels[0]` 就是用户自己通道勾的第一个模型，于是新建节点
 *     的默认模型跟着通道走。v1.30 及以前是追加在末尾（当时默认模型被 vendor 硬编码成
 *     `GPT Image 2 · API`，追加在末尾等于「不影响默认值」；那条路本插件没有后端，新节点点生成
 *     只会 501，所以 v1.31 两头一起改：「不覆盖显式模型」的 vendor 补丁 3.8i + 这里的排在最前）。
 *
 * 唯一改不动的是画布下拉的**常用模型白名单**（`canvasModelCatalogPolicy.ts` 里那个模块级 Set，
 * 在模块求值时就固化了），所以那处走 vendor 补丁（scripts/vendor-aifisher.mjs 3.8g 段）读本模块装的
 * 全局 `__FISHERAI_CHANNEL_MODEL_NAMES__`。
 *
 * 条目形状是照 vendor 各处的硬要求写的（有 subagent 取证报告）：
 *   - image 必须有 `imageModes`、video 必须有 `videoModes`，否则「生成」按钮是禁用的；
 *   - 文本条目的 cost 只能是数字（对象会显示「¥NaN」），这里改用 priceTextByMode 显示「动态」；
 *   - 音频条目不写 cost 会被硬编码成 0.2（假的 ¥0.20），所以显式给 0；
 *   - `provider` 里**不能**出现 doubao/ark 字眼 —— host 靠这两个特征判定「方舟直连」，
 *     这里用 OpenAICompatibleProvider（图标也正好落回 OpenAI 那枚）。
 */
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  TEXT_MODELS,
  VIDEO_MODELS,
} from '../../../vendor/aifisher/src/config/modelConfig';

/** 通道模型的四种媒体类型（与画布四个 composer 一一对应）。 */
export type CloudChannelKind = 'image' | 'video' | 'audio' | 'text';
export type ChannelKind = CloudChannelKind;

export interface ChannelModelLike {
  id: string;
  kind: ChannelKind;
  label?: string;
}

export interface ChannelLike {
  id: string;
  label: string;
  /**
   * host 判定的**实际生效**方言（`publicChannel()` 里的 `dialectDetected`）。
   * 只有 `workfisher`（FisherAI）那条链路会**把本机素材上传成公网直链**再提交，
   * 所以只有它给小视频节点挂「视频参考」模式（见 videoEntry 的第三个参数）。
   */
  dialectDetected?: string;
  models: ChannelModelLike[];
}

const PROVIDER = 'OpenAICompatibleProvider';
const SUPPORTED_IMAGE_FORMATS = ['jpeg', 'png', 'webp'];

function baseEntry(name: string, channelLabel: string) {
  return {
    name,
    description: `自配通道「${channelLabel}」提供的模型；请求形状与计费都以该端点为准。`,
    timeEstimate: '2min',
    provider: PROVIDER,
    source: 'dsh_cloud',
    selectable: true,
    maxConcurrent: 0,
    useProxy: false,
  } as Record<string, unknown>;
}

function imageEntry(name: string, channelLabel: string) {
  return {
    ...baseEntry(name, channelLabel),
    maxInputs: 14,
    supportedReferenceTypes: ['text', 'image'],
    supportedImageFormats: SUPPORTED_IMAGE_FORMATS,
    maxImageSizeMb: 20,
    maxResolution: '',
    resolutions: ['1K', '2K', '4K'],
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'],
    // ★ 必需：没有 imageModes 时 composer 会认为「当前模型不支持文生图」，生成按钮直接禁用
    imageModes: [
      { label: '文生图', value: 'text-to-image', allowedInputs: { text: 14 } },
      { label: '图生图', value: 'image-to-image', allowedInputs: { text: 14, image: 14 } },
    ],
    advancedParams: [
      { key: 'generateCount', label: '生成数量', type: 'number', default: 1, min: 1, step: 1 },
    ],
  };
}

/**
 * 视频「多图参考」能接几张图：**9 张**，与 MiniMax H3 参考模式同口径
 * （vendor `media/minimaxH3.ts` 的 `SLOT_RANGES.referenceImage = [3, 11]`，正好 9 个图片槽）。
 *
 * 用户原话（2026-10-23）：「视频生成图像参考只能拖入三张，修复一下，按 minimaxh3 的标准来」。
 */
export const VIDEO_REFERENCE_IMAGE_LIMIT = 9;

/** 一个模式声明的输入上限（`allowedInputs` 的键就是 text / image / video / audio）。 */
export interface VideoModeInputs {
  value?: string;
  label?: string;
  allowedInputs?: Partial<Record<string, number>>;
}

/**
 * 视频条目的「总输入上限」（`maxInputs`）该怎么算。
 *
 * `maxInputs` 只是粗糙兜底 —— 真正按模式准入的是每个模式的 `allowedInputs`
 * （vendor `canvasNodeRules.validateConnection` 两道都判：先 `parents.length >= maxInputs`，
 * 再按素材种类查 `allowedInputs`）。以前这里写死 3，于是「多图参考」明明声明了 9 张图，
 * 拖到第 4 张就先撞上总上限 —— 用户看到的就是「只能拖入三张」，且没有任何提示说明是哪个上限。
 *
 * 所以按**各模式 allowedInputs 之和的最大值**算：声明的准入范围与实际能连的数量永远一致，
 * 改模式上限时不必再回来同步这个数。
 */
export function videoInputCap(modes: readonly VideoModeInputs[]): number {
  let cap = 1;
  for (const mode of modes) {
    const total = Object.values(mode.allowedInputs ?? {}).reduce<number>((sum, value) => {
      const count = Number(value);
      return sum + (Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0);
    }, 0);
    if (total > cap) cap = total;
  }
  return cap;
}

function videoEntry(name: string, channelLabel: string, videoReference = false) {
  // ★ 必需，且值必须落在 vendor videoMode.ts 的词表里（image-to-video 之类不在词表里）
  const videoModes: VideoModeInputs[] = [
    { label: '文生视频', value: 'text-to-video', allowedInputs: { text: 10 } },
    { label: '首帧', value: 'first-frame', allowedInputs: { text: 10, image: 1 } },
    { label: '首尾帧', value: 'i2v-first-last-frame', allowedInputs: { text: 10, image: 2 } },
    {
      label: '多图参考',
      value: 'reference-video',
      allowedInputs: { text: 10, image: VIDEO_REFERENCE_IMAGE_LIMIT },
    },
  ];
  // 视频参考（v1.62，用户原话「帮我配置一个视频参考通道」）：
  // FisherAI（workfisher 方言）的 host 链路会把画布上的本机视频当成 `body.videos`，
  // 先 POST /files/upload 换成公网直链，再放进 metadata.video_url 提交；
  // 所以只有这类通道才多这一档，别的方言收到视频会**静默丢掉**（不如不给这一档）。
  // 值用 video-edit：vendor 的 resolveVideoGenerationMode 在「连了视频」时优先挑它。
  if (videoReference) {
    videoModes.push({ label: '视频参考', value: 'video-edit', allowedInputs: { text: 10, video: 1 } });
  }
  return {
    ...baseEntry(name, channelLabel),
    timeEstimate: '5min',
    // 见 videoInputCap：跟各模式的 allowedInputs 走，别再写死一个小数字把参考图挡在外面
    maxInputs: videoInputCap(videoModes),
    supportedReferenceTypes: ['text', 'image'],
    supportedImageFormats: SUPPORTED_IMAGE_FORMATS,
    maxImageSizeMb: 20,
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    videoModes,
    advancedParams: [
      { key: 'duration', label: '生成时长', type: 'slider', default: 5, min: 2, max: 10, unit: 's' },
      { key: 'generateCount', label: '生成数量', type: 'number', default: 1, min: 1, step: 1 },
    ],
  };
}

function textEntry(name: string, channelLabel: string) {
  return {
    ...baseEntry(name, channelLabel),
    maxInputs: 4,
    supportedReferenceTypes: ['text', 'image'],
    supportedImageFormats: SUPPORTED_IMAGE_FORMATS,
    maxImageSizeMb: 10,
    maxResolution: '4096*4096',
    resolutions: [],
    aspectRatios: [],
    // 价格未知时显示「动态」而不是 ¥0.00（cost 写对象会让 composer 显示出 ¥NaN）
    priceTextByMode: { 'multimodal-chat': { default: '按你自配端点的账单结算' } },
    languageModes: [
      { label: '多模态对话', value: 'multimodal-chat', allowedInputs: { text: 10, image: 4 } },
    ],
    advancedParams: [],
  };
}

function audioEntry(name: string, channelLabel: string) {
  return {
    ...baseEntry(name, channelLabel),
    maxInputs: 1,
    supportedReferenceTypes: ['text'],
    supportedAudioFormats: ['mp3', 'wav', 'm4a'],
    resolutions: [],
    aspectRatios: [],
    // 不写 cost 会被 canvasAudioNode 硬编码成 0.2（假的 ¥0.20）
    cost: 0,
    audioModes: [
      { label: '生成音频', value: 'generate-audio', allowedInputs: { text: 10 } },
      { label: '背景音乐', value: 'instrumental', allowedInputs: { text: 10 } },
    ],
    advancedParams: [
      { key: 'generateCount', label: '生成数量', type: 'number', default: 1, min: 1, step: 1 },
    ],
  };
}

/**
 * 一条通道模型在**画布上**的名字（必须与 host 的 `channelModelName` 完全一致 ——
 * 画布节点存的就是这个名字，host 靠它反查通道）。
 *
 * 默认 `${通道名} · ${端点模型 ID}`：两个通道都提供 `gpt-image-1` 时画布上仍然分得清，
 * 否则二级来源选完落到节点上的还是同一个名字，host 只能永远挑第一条通道。
 * 通道里给某条模型单独写了 label 就用 label。
 */
export function channelModelDisplayName(channel: ChannelLike, model: ChannelModelLike): string {
  const label = model.label?.trim();
  if (label) return label;
  return `${channel.label} · ${model.id}`;
}

/** 通道表 → 四个 composer 的模型条目。 */
export function buildChannelModelEntries(
  channels: readonly ChannelLike[],
): Record<ChannelKind, Record<string, unknown>[]> {
  const result: Record<ChannelKind, Record<string, unknown>[]> = {
    image: [],
    video: [],
    audio: [],
    text: [],
  };
  const seen = new Set<string>();
  for (const channel of channels) {
    for (const model of channel.models ?? []) {
      const kind: ChannelKind = model.kind ?? 'image';
      if (!result[kind]) continue;
      const name = channelModelDisplayName(channel, model);
      const key = `${kind}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const builder =
        kind === 'image'
          ? imageEntry
          : kind === 'video'
            ? videoEntry
            : kind === 'audio'
              ? audioEntry
              : textEntry;
      // 视频模型的「视频参考」模式只给 workfisher（FisherAI）通道：只有那条链路会把本机视频
      // 上传成公网直链（host 侧 /files/upload），别的方言收到 videos 是静默忽略。
      const entry =
        kind === 'video'
          ? (builder as typeof videoEntry)(name, channel.label, channel.dialectDetected === 'workfisher')
          : builder(name, channel.label);
      result[kind].push({
        ...entry,
        cloudChannelId: channel.id,
        cloudModelId: model.id,
      });
    }
  }
  return result;
}

/** 画布要放行的模型名（`canvasModelCatalogPolicy` 的运行时白名单）。 */
export function channelModelNames(channels: readonly ChannelLike[]): string[] {
  const names = new Set<string>();
  for (const channel of channels) {
    for (const model of channel.models ?? []) names.add(channelModelDisplayName(channel, model));
  }
  return [...names];
}

interface RegistryGlobal {
  __FISHERAI_CHANNEL_MODEL_NAMES__?: Set<string>;
  __FISHERAI_CHANNEL_MODELS__?: Record<ChannelKind, unknown[]>;
}

/** 四个静态目录数组（原地追加，所以下游拿到的都是同一份引用）。 */
const CATALOG_ARRAYS: Record<ChannelKind, unknown[]> = {
  image: IMAGE_MODELS as unknown as unknown[],
  video: VIDEO_MODELS as unknown as unknown[],
  audio: AUDIO_MODELS as unknown as unknown[],
  text: TEXT_MODELS as unknown as unknown[],
};

/** 上一轮追加进去的条目（重新安装时先摘掉，避免画布重挂后越积越多）。 */
const installed: Record<ChannelKind, unknown[]> = {
  image: [],
  video: [],
  audio: [],
  text: [],
};

export interface RegistrySnapshot {
  names: number;
  byKind: Record<ChannelKind, number>;
  equipped: Record<ChannelKind, number>;
}

/** 把通道表装进画布目录（可重复调用：先摘旧的，再追加新的）。 */
export function installChannelModelRegistry(channels: readonly ChannelLike[]): RegistrySnapshot {
  const entries = buildChannelModelEntries(channels);
  for (const kind of Object.keys(CATALOG_ARRAYS) as ChannelKind[]) {
    const array = CATALOG_ARRAYS[kind];
    for (const entry of installed[kind]) {
      const index = array.indexOf(entry);
      if (index >= 0) array.splice(index, 1);
    }
    // 与静态目录重名的（用户端点恰好也用某个内置模型名）不追加合成条目：
    // 静态那条元数据更全，而 host 已经给同名模型加了一条「来自该通道」的来源变体。
    const existing = new Set(
      array
        .map((item) => (item as { name?: unknown })?.name)
        .filter((name): name is string => typeof name === 'string'),
    );
    const fresh = entries[kind].filter((entry) => !existing.has(String(entry.name)));
    // 排在最前：第一个已配置通道的第一个模型 = 「新建节点」的默认模型（vendor 补丁 3.8i 让它被尊重）。
    // 用 splice 而不是 unshift(...many)：几百个通道模型时 unshift 的参数个数会顶到调用栈上限。
    array.splice(0, 0, ...fresh);
    installed[kind] = fresh;
  }
  const names = channelModelNames(channels);
  const target = globalThis as unknown as RegistryGlobal;
  target.__FISHERAI_CHANNEL_MODEL_NAMES__ = new Set(names);
  target.__FISHERAI_CHANNEL_MODELS__ = entries;
  return {
    names: names.length,
    byKind: {
      image: entries.image.length,
      video: entries.video.length,
      audio: entries.audio.length,
      text: entries.text.length,
    },
    equipped: {
      image: installed.image.length,
      video: installed.video.length,
      audio: installed.audio.length,
      text: installed.text.length,
    },
  };
}

/** 清空注册表（画布卸载时用；不摘也不会错，只是留着上一轮的条目）。 */
export function clearChannelModelRegistry(): void {
  installChannelModelRegistry([]);
}

/** 画布诊断 / 排查用。 */
export function channelModelRegistrySnapshot(): RegistrySnapshot {
  const target = globalThis as unknown as RegistryGlobal;
  const entries = target.__FISHERAI_CHANNEL_MODELS__;
  return {
    names: target.__FISHERAI_CHANNEL_MODEL_NAMES__?.size ?? 0,
    byKind: {
      image: entries?.image?.length ?? 0,
      video: entries?.video?.length ?? 0,
      audio: entries?.audio?.length ?? 0,
      text: entries?.text?.length ?? 0,
    },
    equipped: {
      image: installed.image.length,
      video: installed.video.length,
      audio: installed.audio.length,
      text: installed.text.length,
    },
  };
}

/**
 * 拉一次 `/cloud-channels` 并安装注册表。
 *
 * 画布启动时调一次（刷新页面后已配好的通道模型立刻可选），
 * 用户在设置里保存通道后再调一次（这样不用刷新页面，重新打开模型下拉就能选到）。
 */
export async function refreshChannelModelRegistry(): Promise<
  (RegistrySnapshot & { channels: number }) | null
> {
  try {
    const response = await fetch('/api/aifisher/canvas/cloud-channels', { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = (await response.json()) as { channels?: ChannelLike[] };
    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    return { ...installChannelModelRegistry(channels), channels: channels.length };
  } catch {
    // 画布不能因为这条失败而白屏：注册表保持空，模型下拉里就没有通道模型而已
    return null;
  }
}
