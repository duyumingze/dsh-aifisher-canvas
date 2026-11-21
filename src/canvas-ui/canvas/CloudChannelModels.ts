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
  /**
   * host 随 `/cloud-channels` 下发的视频参数表（目前只有 ZZAI 的 ComfyUI 系列带）：
   * 档位 / 宽高比 / 时长区间按**模型真收的**出下拉，别让人选到必然 400 的组合。
   */
  videoProfile?: ChannelVideoProfileLike;
  /**
   * 图像参数表（目前只有 ZZAI 的 Seedream 图层拆分系列带）：
   * `layerDecomposition` = 这个模型只做图层拆分（只吃一张图、档位是 auto/1k/1.5k/2k、
   * 一次产出底图 + N 个图层并按时输出张数计费）。
   */
  imageProfile?: ChannelImageProfileLike;
}

/** 与 host 的 `ChannelImageProfile` 同形（只取界面用得到的那几个字段）。 */
export interface ChannelImageProfileLike {
  layerDecomposition?: boolean;
  resolutions?: string[];
  outputNote?: string;
  /** 画质词表（GPT Image 2.6 系：auto/low/medium/high/xhigh/max）→ 节点上的「画质」下拉。 */
  qualities?: string[];
  defaultQuality?: string;
  /** 输出格式词表（png/jpeg/webp）→ 节点上的「输出格式」下拉。 */
  outputFormats?: string[];
  /** true = 端点 n 固定 1：不给「生成数量」，免得以为能一次出多张。 */
  fixedCount?: boolean;
}

/** 与 host 的 `ChannelVideoProfile` 同形（只取界面用得到的那几个字段）。 */
export interface ChannelVideoProfileLike {
  resolutions?: string[];
  aspectRatios?: string[];
  minSeconds?: number;
  maxSeconds?: number;
  /** 超分模型的质量词表（Ultra/Max/High/Medium/Low）。 */
  qualities?: string[];
  defaultQuality?: string;
  /** true = 只收一段源视频（不要把节点当文生视频用）。 */
  upscaler?: boolean;
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

function imageEntry(
  name: string,
  channelLabel: string,
  dialect?: string,
  profile?: ChannelImageProfileLike,
) {
  /**
   * 百炼（DashScope）这套图像模型（可灵 v3 系）只收三种宽高比、三档分辨率；
   * 参考图虽然模型支持，但端点只要公网 http(s) 直链，画布上的素材都在本机 ——
   * 所以「图生图」照常给（连线不该被静默挡住），真提交时 host 会给一条说清原因的 422
   * （CHANNEL_REFERENCE_NOT_PUBLIC），而不是让「图片编辑」悄悄变成「重新画一张」。
   */
  const dashscope = dialect === 'dashscope';
  /**
   * Midjourney（`/v1/midjourney/*`）与上面几套的差别落在节点上就是三件事：
   *   - 没有「分辨率」概念（只出宽高比），所以只留一档 1K，别让人以为能选 4K；
   *   - 一个任务**固定出 4 张候选**，`n` 无效，所以「生成数量」上限是 4（只决定留几张）；
   *   - 版本（--v）与速度（relax/fast/turbo）是它自己的参数，垫图则是 `image_urls`。
   * 参考图和 FisherAI 一样要公网直链，host 会自动上传并缓存 12h。
   */
  const midjourney = dialect === 'midjourney';
  /**
   * 图层拆分（ZZAI 的 Seedream 系列，2026-11-21 接）：这个模型**只做一件事** ——
   * 拿一张图拆成「底图 + 最多 16 个透明图层」。
   *
   * 三处必须跟着变的界面语义：
   *   - 档位换成 `自动 / 1K / 1.5K / 2K`（端点不认 4K，也不认 auto 以外的像素词）；
   *   - 只留一张图的输入（多图是 400，见模式里的 allowedInputs.image = 1）；
   *   - 没有「生成数量」（一次请求就是一遍拆分，按实际输出张数计费），所以高级参数里只留说明；
   *   - 提示词是**可选**的（空着 = 自动识别主要元素），所以条目挂 `promptOptional`。
   */
  const layer = profile?.layerDecomposition === true;
  /**
   * GPT Image 2.6 低价版（v1.105，ZZAI 的 `zhenzhen-image-g-v2.6-lowprice`）：
   * 与普通自配图像模型只差三处界面语义 ——
   *   - 档位 1K/2K/4K（随 `profile.resolutions` 出）；
   *   - 多两个自己的下拉「画质」（quality）与「输出格式」（output_format），值直接进请求体；
   *   - 端点 n 固定 1：**不给「生成数量」**（那个控件在这条路上只会让人以为能一次出多张）。
   * 参考图最多 16 张（与官方一致），所以 maxInputs / allowedInputs 一起放到 16。
   */
  const fixedCount = profile?.fixedCount === true;
  const referenceCap = fixedCount ? 16 : 14;
  const lazyInputs = layer ? { text: 10, image: 1 } : { text: 14, image: 14 };
  return {
    ...baseEntry(name, channelLabel),
    ...(layer
      ? {
          description:
            `自配通道「${channelLabel}」提供的图层拆分模型：一次产出 1 张底图 + 最多 16 个透明图层，`
            + '按实际输出张数计费。提示词可留空（自动识别主要元素）。',
        }
      : {}),
    ...(fixedCount && !layer
      ? {
          description:
            `自配通道「${channelLabel}」提供的 GPT Image 2.6 低价版：文生图 / 参考图编辑，`
            + '每次出 1 张（端点 n 固定 1）。1K ¥0.044/张，2K/4K 按实际用量结算。',
        }
      : {}),
    ...(midjourney
      ? {
          description:
            `自配通道「${channelLabel}」提供的 Midjourney Imagine：一个任务固定出 4 张候选，`
            + '「生成数量」只决定画布保留几张（计费按任务，与张数无关）。'
            + '参考图走垫图（公网直链，插件自动上传并缓存 12h）。',
        }
      : {}),
    // 有档位价的模型给画布一个「每张多少钱」的估算（2K/4K 是 estimate 实测值，最终按用量结算）
    ...(fixedCount && !layer ? { cost: { '1K': 0.044, '2K': 0.236, '4K': 0.315 } } : {}),
    maxInputs: layer ? 11 : referenceCap,
    // composer 的「没提示词不让生成」那道门按这个放行（vendor 补丁 3.13）
    ...(layer ? { promptOptional: true } : {}),
    supportedReferenceTypes: ['text', 'image'],
    supportedImageFormats: SUPPORTED_IMAGE_FORMATS,
    maxImageSizeMb: 20,
    maxResolution: '',
    resolutions: profile?.resolutions?.length
      ? [...profile.resolutions]
      : midjourney
        ? ['1K']
        : ['1K', '2K', '4K'],
    // 可灵 v3-omni 的 aspect_ratio 只有 16:9 / 9:16 / 1:1；选别的会被端点 400。
    // Midjourney 收 MJ 自己的宽高比词表（与 vendor 内置的 Midjourney 条目同口径）。
    // 图层拆分的画幅由输入图决定（端点不收 ratio），所以只给一个不参与请求的默认值。
    aspectRatios: midjourney
      ? ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']
      : dashscope
        ? ['16:9', '9:16', '1:1']
        : layer
          ? ['1:1']
          : ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'],
    // ★ 必需：没有 imageModes 时 composer 会认为「当前模型不支持文生图」，生成按钮直接禁用
    imageModes: layer
      ? [
          // 「图层拆分」是唯一的特殊功能；文生图/图生图两档留着只是为了「自动」不变成死路
          // （vendor 的 resolveImageGenerationMode 只认这两档名，否则连上图片就判成不支持）。
          { label: '图层拆分', value: 'layer-decomposition', allowedInputs: lazyInputs },
          { label: '文生图', value: 'text-to-image', allowedInputs: { text: 10 } },
          { label: '图生图', value: 'image-to-image', allowedInputs: lazyInputs },
        ]
      : [
          { label: '文生图', value: 'text-to-image', allowedInputs: { text: 16 } },
          {
            label: '图生图',
            value: 'image-to-image',
            allowedInputs: { text: 16, image: referenceCap },
          },
        ],
    advancedParams: layer
      ? []
      : midjourney
        ? [
            {
              key: 'generateCount',
              label: '保留结果数',
              type: 'slider',
              default: 1,
              // 一个任务固定 4 张候选，选 4 = 全留下
              min: 1,
              max: 4,
            },
            {
              key: 'version',
              label: '模型版本',
              type: 'select',
              default: '8.1',
              options: [
                { label: 'V8.2', value: '8.2' },
                { label: 'V8.1', value: '8.1' },
                { label: 'V7', value: '7' },
                { label: 'V6.1', value: '6.1' },
                { label: 'V5.2', value: '5.2' },
                { label: 'V5.1', value: '5.1' },
              ],
            },
            {
              key: 'speed',
              label: '生成速度',
              type: 'select',
              default: 'fast',
              options: [
                { label: 'Relax（最便宜，排队久）', value: 'relax' },
                { label: 'Fast', value: 'fast' },
                { label: 'Turbo（最快，约 2 倍价）', value: 'turbo' },
              ],
            },
          ]
        : fixedCount
          ? [
              ...(profile?.qualities?.length
                ? [
                    {
                      key: 'quality',
                      label: '画质',
                      type: 'select',
                      default: profile.defaultQuality ?? profile.qualities[0],
                      options: profile.qualities.map((quality) => ({
                        label: quality,
                        value: quality,
                      })),
                    },
                  ]
                : []),
              ...(profile?.outputFormats?.length
                ? [
                    {
                      key: 'output_format',
                      label: '输出格式',
                      type: 'select',
                      default: profile.outputFormats.includes('png')
                        ? 'png'
                        : profile.outputFormats[0],
                      options: profile.outputFormats.map((format) => ({
                        label: format,
                        value: format,
                      })),
                    },
                  ]
                : []),
            ]
          : [
              {
                key: 'generateCount',
                label: '生成数量',
                type: 'number',
                default: 1,
                min: 1,
                step: 1,
                // 可灵的 n 收 1–9；别的方言 host 侧统一夹在 8，这里只对百炼放到 9
                ...(dashscope ? { max: 9 } : {}),
              },
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

function videoEntry(
  name: string,
  channelLabel: string,
  videoReference = false,
  profile?: ChannelVideoProfileLike,
) {
  /**
   * 视频超分（v1.100，ZZAI 的 `Topaz-Upscale-LowPirce`）：节点上只需要「一段源视频 +
   * 目标档位 + 超分模型」。它**不认**提示词、秒数与宽高比（时长由上游读源视频），
   * 所以这里不给那 4 个生成模式，也不给时长滑杆 —— 否则用户会被要求填一个端点会忽略的值，
   * 而且空提示词会把生成按钮一直禁用。
   */
  const upscaler = profile?.upscaler === true;
  // ★ 必需，且值必须落在 vendor videoMode.ts 的词表里（image-to-video 之类不在词表里）
  const videoModes: VideoModeInputs[] = upscaler
    ? [{ label: '视频超分', value: 'video-edit', allowedInputs: { video: 1 } }]
    : [
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
  if (!upscaler && videoReference) {
    videoModes.push({ label: '视频参考', value: 'video-edit', allowedInputs: { text: 10, video: 1 } });
  }
  /**
   * 档位 / 宽高比 / 时长区间：有 host 下发的参数表就照它的来（ZZAI 的 ComfyUI 各工作流词表不同，
   * 例如通用档只有 16:9/9:16、武戏/文戏 5 秒起、漫剧只到 768p）—— 选到不支持的组合会被端点直接拒。
   */
  const resolutions = profile?.resolutions?.length ? [...profile.resolutions] : ['480p', '720p', '1080p'];
  const aspectRatios = profile?.aspectRatios?.length ? [...profile.aspectRatios] : ['16:9', '9:16', '1:1'];
  const minSeconds = Math.max(1, Math.round(profile?.minSeconds ?? 2));
  const maxSeconds = Math.max(minSeconds, Math.round(profile?.maxSeconds ?? 10));
  const defaultSeconds = Math.min(maxSeconds, Math.max(minSeconds, 5));
  const qualities = profile?.qualities ?? [];
  return {
    ...baseEntry(name, channelLabel),
    timeEstimate: upscaler ? '10min' : '5min',
    // composer 里「没有提示词就不许生成」的那道门：超分模型按 true 放行（vendor 补丁 3.12）
    promptOptional: upscaler,
    // 见 videoInputCap：跟各模式的 allowedInputs 走，别再写死一个小数字把参考图挡在外面
    maxInputs: videoInputCap(videoModes),
    supportedReferenceTypes: upscaler ? ['video'] : ['text', 'image'],
    supportedImageFormats: SUPPORTED_IMAGE_FORMATS,
    maxImageSizeMb: 20,
    resolutions,
    aspectRatios,
    videoModes,
    advancedParams: upscaler
      ? [
          ...(qualities.length
            ? [
                {
                  key: 'quality',
                  label: '超分模型',
                  type: 'select',
                  default: profile?.defaultQuality ?? qualities[0],
                  options: qualities.map((quality) => ({ label: quality, value: quality })),
                },
              ]
            : []),
        ]
      : [
          {
            key: 'duration',
            label: '生成时长',
            type: 'slider',
            default: defaultSeconds,
            min: minSeconds,
            max: maxSeconds,
            unit: 's',
          },
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
      // 视频模型的「视频参考」模式只给会**把本机视频上传成公网直链**的那两条链路
      // （FisherAI / ZZAI 的 host 侧 /files/upload）；别的方言收到 videos 是静默忽略。
      // 图像条目的宽高比/模式同样按方言收紧（百炼/可灵只收 16:9、9:16、1:1，参考图要公网直链）。
      const dialect = channel.dialectDetected ?? '';
      const entry =
        kind === 'video'
          ? videoEntry(
              name,
              channel.label,
              dialect === 'workfisher' || dialect === 'zhenzhen',
              model.videoProfile,
            )
          : kind === 'image'
            ? (builder as typeof imageEntry)(name, channel.label, dialect, model.imageProfile)
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
