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
 *   - Midjourney（同一个 work-fisher 网关的 `/v1/midjourney/*`）又是另一套：路径是
 *     `/midjourney/generations`（计费 SKU 由路径决定，`body.model` 不参与路由）、任务号在
 *     `data[0].task_id`、轮询 `/midjourney/tasks/{id}`、收尾给 `image_urls`（4 张）+ `grid_image_url`。
 *     一个任务固定出 4 张候选，`n` 传了也无效。
 */
export type ChannelDialect =
  | 'openai'
  | 'modelscope'
  | 'workfisher'
  | 'dashscope'
  | 'midjourney'
  | 'zhenzhen';

export const CHANNEL_DIALECTS: readonly ChannelDialect[] = Object.freeze([
  'openai',
  'modelscope',
  'workfisher',
  'dashscope',
  'midjourney',
  'zhenzhen',
]);

export const CHANNEL_DIALECT_LABELS: Readonly<Record<ChannelDialect, string>> = Object.freeze({
  openai: 'OpenAI 兼容',
  modelscope: '魔搭 ModelScope',
  workfisher: 'FisherAI（work-fisher）',
  dashscope: '阿里云百炼（DashScope）',
  midjourney: 'Midjourney（/v1/midjourney）',
  zhenzhen: 'ZZAI 真真AI（api.seedance.nz）',
});

/**
 * 百炼 / DashScope 系的异步图像任务网关（2026-11-11 用户给的
 * `kling/kling-v3-omni-image-generation` curl 就是这套）。
 *
 * 它和前面三套方言**没有一处相同**：提交路径是
 * `/api/v1/services/aigc/image-generation/generation`、请求体是
 * `{model, input:{messages:[{role,content:[{text}|{image}]}]}, parameters:{n,aspect_ratio,resolution}}`、
 * 必须带 `X-DashScope-Async: enable`、任务号埋在 `output.task_id`、
 * 轮询 `GET /api/v1/tasks/{id}`、结果在 `output.choices[0].message.content[].image`。
 * 少一处都是 400 / 空结果，且报错信息不会告诉你少的是哪一处。
 *
 * 覆盖三类地址：官方 `dashscope.aliyuncs.com`、按业务空间分域的
 * `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`、以及同协议的千问云镜像
 * `cn-beijing.maas.qianwenaiapi.com`。
 */
const DASHSCOPE_HOST_PATTERN =
  /(?:^|\.)(?:dashscope(?:-intl)?\.aliyuncs\.com|maas\.aliyuncs\.com|(?:dashscope|bailian|maas)\.(?:qianwenai|qianwenaiapi)\.com)$/;

/**
 * ZZAI 真真AI（`www.zzai.app` 的开发者 API，域名 `api.seedance.nz`）。
 *
 * 2026-11-21 用户给的是价格页 `/pricing?tag=comfyui` 上的 MiniMax H3 ComfyUI 系列
 * （`minimax-h3-comfyui-max` / `-max-10020`「WF漫剧版」/ `-max-10021`「JY特调」/
 * `-wuxi` 武戏 / `-wenxi` 文戏 / `-charswap` 角色替换）。它们走的是**旧版异步任务端点**
 * `POST /v1/video/generations`（单数 video）→ 轮询 `GET /v1/video/generations/{id}`，
 * 回执是 `{code:'success', data:{task_id, status, result_url, data:{content:{video_url}}}}`，
 * 与 FisherAI 那套**同形**；官方另外还有一个 `POST /v2/video_generation`（MiniMax V2 原生格式，
 * 任务号 `task_id`、结果 `task.content.url`），画布先接前者。
 *
 * 三处与 FisherAI 不同、照抄 FisherAI 会静默出错的地方：
 *   ① `seconds` 的合法区间按模型不同（通用 3–15、武戏/文戏 5–15），超区间是**提交即拒**；
 *   ② `metadata.resolution` 只收 480p/608p/768p/896p/1088p/1280p/1440p 这类**按短边**的档位，
 *      画布上的 `720p`/`1080p` 不在表里，原样发上去就是 400；
 *   ③ ComfyUI 通用档（`-max`）的 `metadata.ratio` 只有 16:9 / 9:16，画布给的 1:1、4:3 一律要被夹。
 */
const ZHENZHEN_HOST_PATTERN = /(?:^|\.)(?:seedance\.nz|zzai\.app|openzhenzhen\.com)$/;

/**
 * 按地址猜方言：魔搭 / FisherAI / 百炼 / ZZAI。
 *
 * **`midjourney` 故意不在自动判定里**（2026-11-11 用户原话「帮我再画布接一下 Midjourney 模型」）：
 * 它和 FisherAI 图像/视频**同一个域名、同一个密钥**，唯一的分界是路径 `/v1/midjourney/*`。
 * 按域名猜只会把它判成 workfisher，然后把聊天/图像那套请求体打到 Midjourney 路径上 ——
 * 所以这类通道必须在设置页显式选「Midjourney」，界面上也有「自动 → 判成了哪套」那行小字提醒。
 */
export function detectChannelDialect(baseUrl: string): ChannelDialect {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'modelscope.cn' || host.endsWith('.modelscope.cn')) return 'modelscope';
    if (host === 'work-fisher.com' || host.endsWith('.work-fisher.com')) return 'workfisher';
    if (ZHENZHEN_HOST_PATTERN.test(host)) return 'zhenzhen';
    if (DASHSCOPE_HOST_PATTERN.test(host)) return 'dashscope';
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
 * 只有 FisherAI 需要：图片是 `/image/generations`（**单数** image）、视频是
 * `/video/generations`（**单数** video，2026-10-20 用户给的 minimax-h3-ow-r2v curl）。
 * 照 OpenAI 的复数路径（`/images/generations`、`/videos/generations`）打过去只会拿到网关的 404，
 * 而报错里看不出是路径写错了 —— 实测 `/videos/generations` 就是 404 "Invalid URL"。
 */
const DIALECT_PATHS: Readonly<Partial<Record<ChannelDialect, Partial<Record<CloudKind, string>>>>> =
  Object.freeze({
    workfisher: Object.freeze({
      image: '/image/generations',
      video: '/video/generations',
    }),
    // 百炼的图像路径含 `/api/v1` 前缀（见 dashscopeApiPath：baseUrl 已经带 /api/v1 时不再叠一层）；
    // 文本走它的 OpenAI 兼容模式，路径与 OpenAI 一样是 chat/completions。
    dashscope: Object.freeze({
      text: '/compatible-mode/v1/chat/completions',
    }),
    // Midjourney：计费 SKU 由**路径**决定（`/midjourney/generations` = `midjourney-imagine`），
    // body.model 不参与路由。二次操作（upscale / variation / zoom …）是
    // `/midjourney/generations/{action}`，画布目前只接文生图/垫图这一条。
    midjourney: Object.freeze({
      image: '/midjourney/generations',
    }),
  });

/** FisherAI 换参考图直链的上传路径（挂 baseUrl 之后）。 */
export const WORKFISHER_UPLOAD_PATH = '/files/upload';

/**
 * ZZAI（api.seedance.nz）的 `/v1` 前缀该怎么补。
 *
 * 官方文档写的 Base URL 是**不带 `/v1`** 的 `https://api.seedance.nz`（路径里自带 `/v1`），
 * 而「OpenAI SDK 兼容」那节又让人填 `…/v1`；两边都有人照抄。所以这里自己补：
 * baseUrl 已经带 `/v1` 就原样，不带就补一个（照抄写死 `/v1/...` 会在 `…/v1` 上拼成 `/v1/v1/...`）。
 */
function zhenzhenV1Prefix(baseUrl: string): string {
  return /\/v1$/i.test(baseUrl.replace(/\/+$/u, '')) ? '' : '/v1';
}

/** ZZAI 各媒体类型的提交路径（相对 baseUrl）。 */
export function zhenzhenApiPath(baseUrl: string, kind: CloudKind): string {
  const prefix = zhenzhenV1Prefix(baseUrl);
  if (kind === 'video') return `${prefix}/video/generations`;
  if (kind === 'image') return `${prefix}/image/generations`;
  if (kind === 'audio') return `${prefix}/audio/generations`;
  return `${prefix}/chat/completions`;
}

/** ZZAI 的参考素材上传路径（multipart 的 `file`，回 `{url}`，24 小时有效）。 */
export function zhenzhenUploadPath(baseUrl: string): string {
  return `${zhenzhenV1Prefix(baseUrl)}/files/upload`;
}

/**
 * 一条视频模型在画布上**能选什么**（档位 / 宽高比 / 时长区间 / 素材上限）。
 *
 * 它同时喂两头：host 侧提交前按这些区间夹参数（端点不认识的档位是**提交即拒**，
 * 而且报错里只写 "invalid request"），client 侧按它出模型下拉的可选项
 * （见 `CloudChannelModels.videoEntry`），免得用户选到必然失败的组合。
 */
export interface ChannelVideoProfile {
  /** 该模型真收的档位词（小写 p 档）。 */
  resolutions: string[];
  /** 该模型真收的宽高比。 */
  aspectRatios: string[];
  minSeconds: number;
  maxSeconds: number;
  maxImages: number;
  maxAudios: number;
  maxVideos: number;
  seed: boolean;
  /**
   * 超分模型（v1.100，Topaz-Upscale）：
   *   - `qualities` 是它自己的「超分模型」词表（Ultra/Max/High/Medium/Low），画布上出一个下拉；
   *   - `upscaler: true` 表示**只收一段源视频**，不要提示词、不要秒数、不要宽高比 ——
   *     时长由上游从源视频读，画布上就不该逼用户填一个它会忽略的数字。
   */
  qualities?: string[];
  defaultQuality?: string;
  upscaler?: boolean;
}

/**
 * ZZAI 上 MiniMax H3 ComfyUI 系列的参数范围（2026-11-21 照 `https://api.seedance.nz/docs/llms.txt`
 * 逐个模型抄的，价格页 `/pricing?tag=comfyui` 上那一排就是它们）。
 *
 * 为什么必须逐条写而不是给一个通用区间：这一家**不同工作流的分辨率词表不一样**
 * （通用档到 1440p、漫剧/JY 只到 768p、武戏/文戏到 2160p 且多出 704p/928p），
 * 时长下限也不一样（武戏/文戏 5 秒起，其余 3 秒起）。少写一条，用户就会撞上
 * 「这个档这个模型不支持」的 400，而面板上看不出是哪一层的问题。
 */
const ZZAI_H3_PROFILES: Readonly<Record<string, ChannelVideoProfile>> = Object.freeze({
  'minimax-h3-comfyui-max': Object.freeze({
    resolutions: ['480p', '608p', '768p', '896p', '1088p', '1280p', '1440p'],
    aspectRatios: ['16:9', '9:16'],
    minSeconds: 3,
    maxSeconds: 15,
    maxImages: 9,
    maxAudios: 3,
    maxVideos: 0,
    seed: false,
  }),
  'minimax-h3-comfyui-max-10020': Object.freeze({
    resolutions: ['480p', '608p', '672p', '768p'],
    aspectRatios: ['16:9', '9:16'],
    minSeconds: 3,
    maxSeconds: 15,
    maxImages: 6,
    maxAudios: 3,
    maxVideos: 0,
    seed: false,
  }),
  'minimax-h3-comfyui-max-10021': Object.freeze({
    resolutions: ['480p', '608p', '672p', '768p'],
    aspectRatios: ['16:9', '9:16'],
    minSeconds: 3,
    maxSeconds: 15,
    maxImages: 9,
    maxAudios: 3,
    maxVideos: 0,
    seed: false,
  }),
  'minimax-h3-comfyui-wuxi': Object.freeze({
    resolutions: ['480p', '704p', '768p', '928p', '1088p', '1440p', '2160p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    minSeconds: 5,
    maxSeconds: 15,
    maxImages: 9,
    maxAudios: 3,
    maxVideos: 3,
    seed: true,
  }),
  'minimax-h3-comfyui-wenxi': Object.freeze({
    resolutions: ['480p', '704p', '768p', '928p', '1088p', '1440p', '2160p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    minSeconds: 5,
    maxSeconds: 15,
    maxImages: 9,
    maxAudios: 3,
    maxVideos: 3,
    seed: true,
  }),
  'minimax-h3-comfyui-charswap': Object.freeze({
    resolutions: ['480p', '768p', '1088p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    minSeconds: 5,
    maxSeconds: 15,
    maxImages: 9,
    maxAudios: 0,
    maxVideos: 1,
    seed: true,
  }),
  'minimax-h3-comfyui-digital-human': Object.freeze({
    resolutions: ['608p', '672p'],
    aspectRatios: ['9:16', '16:9'],
    minSeconds: 3,
    maxSeconds: 15,
    maxImages: 1,
    maxAudios: 1,
    maxVideos: 0,
    seed: true,
  }),
  // 按**运行时长**计费的那几个变体：固定 768p 档，参数表另有差异（见文档）。
  'minimax-h3-comfyui-max-10020-token': Object.freeze({
    resolutions: ['768p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
    minSeconds: 5,
    maxSeconds: 15,
    maxImages: 6,
    maxAudios: 3,
    maxVideos: 0,
    seed: false,
  }),
  'minimax-h3-comfyui-max-10021-token': Object.freeze({
    resolutions: ['768p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
    minSeconds: 5,
    maxSeconds: 15,
    maxImages: 6,
    maxAudios: 3,
    maxVideos: 1,
    seed: false,
  }),
  'minimax-h3-comfyui-charswap-token': Object.freeze({
    resolutions: ['768p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    minSeconds: 5,
    maxSeconds: 15,
    maxImages: 5,
    maxAudios: 0,
    maxVideos: 1,
    seed: false,
  }),
  'minimax-h3-comfyui-digital-human-token': Object.freeze({
    resolutions: ['768p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
    minSeconds: 3,
    maxSeconds: 15,
    maxImages: 1,
    maxAudios: 1,
    maxVideos: 0,
    seed: false,
  }),
});

/**
 * ZZAI 的「视频超分」模型（2026-11-21 用户给的
 * `https://www.zzai.app/pricing?kind=video&capability=video-upscale`）。
 *
 * 模型 ID 就是 `Topaz-Upscale-LowPirce`（上游把 Price 拼成了 Pirce，**这是官方 ID**，
 * 照抄才能命中；站点内部还有一个旧别名 `RH-Upscale`，也一并认）。
 *
 * 与 H3 那一排的差别不在路径（同样 `POST /v1/video/generations` → `GET /v1/video/generations/{id}`），
 * 而在**请求体**：它不收 prompt / seconds / ratio，只收一段源视频和两个自己的参数 ——
 *   `metadata.video_url`（数组，恰好 1 条，MP4）、`metadata.resolution`（720p/1080p/2K/4K，
 *   注意 2K/4K 是**大写 K**，与 H3 全小写的档位词不兼容）、`metadata.quality`
 *   （Ultra/Max/High/Medium/Low，默认 Max）。
 * 时长由上游按源视频读，计费 = 源视频秒数 × 质量单价 × 档位倍率（720p ×1 / 1080p ×2 / 2K ×3 / 4K ×4）。
 */
const ZZAI_TOPAZ_UPSCALER_PROFILE: ChannelVideoProfile = Object.freeze({
  resolutions: ['720p', '1080p', '2K', '4K'],
  // 超分保持源视频画幅，宽高比只用于界面预览（提交时不会带）
  aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  minSeconds: 0,
  maxSeconds: 0,
  maxImages: 0,
  maxAudios: 0,
  maxVideos: 1,
  seed: false,
  qualities: ['Ultra', 'Max', 'High', 'Medium', 'Low'],
  defaultQuality: 'Max',
  upscaler: true,
});

/** 该模型在这家端点上的参数表；认不出来（别家的视频模型）回 null = 原样透传，不做夹取。 */
export function zzaiVideoProfile(modelId: string): ChannelVideoProfile | null {
  const id = modelId.trim();
  if (id === 'Topaz-Upscale-LowPirce' || id === 'RH-Upscale') return ZZAI_TOPAZ_UPSCALER_PROFILE;
  return ZZAI_H3_PROFILES[id] ?? null;
}

/**
 * ZZAI 的**图层拆分**系列（2026-11-21 用户原话「帮我接这个模型 dola-seedream-5.0-flash-layer-decomposition，
 * 我要测试图层拆分功能」）。
 *
 * 这一族有 6 条（`seedream-v5-pro/flash/v5.5` 与海外站别名 `dola-seedream-5.0-pro/5.0-flash/5.5`，
 * 各自都带 `-layer-decomposition` 后缀），请求形状完全相同，所以按后缀认、不逐条枚举 ——
 * 官方定价页换一条 pro/flash 时不必回来改代码。
 *
 * 它们与同通道的 t2i/i2i **只有三处不同**，也正是必须单独认出来的原因：
 *   ① 必须恰好 1 张待拆图（`images` 只有一项；多图是 400）；
 *   ② 档位是 `auto` / `1k` / `1.5k` / `2k`（`4k` 不在表里，普通生成那套 `1k/2k/4k` 直接发会 400）；
 *   ③ 一次请求产出「1 张底图 + 最多 16 个透明图层」，**按实际输出张数计费**（实测 11 张 ¥1.232），
 *      所以「生成数量」对它没有意义 —— 叫 N 次就是 N 次翻倍的钱。
 */
const ZZAI_LAYER_DECOMPOSITION_PATTERN = /-layer-decomposition$/i;

/** 是不是 ZZAI 的图层拆分模型（只有 zhenzhen 方言走这套请求体）。 */
export function isLayerDecompositionModel(modelId: unknown): boolean {
  return typeof modelId === 'string' && ZZAI_LAYER_DECOMPOSITION_PATTERN.test(modelId.trim());
}

/**
 * 图像模型随 `/cloud-channels` 下发给界面的参数表（与视频的 `videoProfile` 同思路）：
 * 档位词按**模型真收的**出下拉，别让人选到必然 400 的组合。
 */
export interface ChannelImageProfile {
  /** true = 这个模型只做图层拆分（画布上带「图层拆分」特殊功能 + 只吃 1 张输入图）。 */
  layerDecomposition?: boolean;
  /** 该模型真收的档位词（图层拆分是 `auto`/`1k`/`1.5k`/`2k`）。 */
  resolutions?: string[];
  /** 一次生成的固定产出说明（界面提示用）。 */
  outputNote?: string;
  /**
   * 画质词表（GPT Image 2.6 系：`auto`/`low`/`medium`/`high`/`xhigh`/`max`）。
   * 有它 → 界面上出一个「画质」下拉，值直接进请求体的 `quality`。
   */
  qualities?: string[];
  defaultQuality?: string;
  /** 输出格式词表（`png`/`jpeg`/`webp`；SVG/GIF 只给文生图，画布不收）。 */
  outputFormats?: string[];
  /**
   * 一次请求固定出 1 张（端点 `n` 只收 1，传 2 是 400）：
   * 界面上就别给「生成数量」—— 那个控件在这条路上只会让人以为能一次出多张。
   */
  fixedCount?: boolean;
}

export const ZZAI_LAYER_DECOMPOSITION_PROFILE: ChannelImageProfile = Object.freeze({
  layerDecomposition: true,
  // 画布上的显示值用大写档位（与其它模型的 1K/2K 同形），映射在 zzaiLayerResolution。
  resolutions: ['自动', '1K', '1.5K', '2K'],
  outputNote: '一次产出 1 张底图 + 最多 16 个透明图层，按实际输出张数计费',
});

/**
 * ZZAI 的 **GPT Image 2.6 低价版**（2026-11-21 用户原话「在画布接入这个模型
 * zhenzhen-image-g-v2.6-lowprice」，定价页 `/pricing/zhenzhen-image-g-v2.6-lowprice?kind=image`）。
 *
 * 官方 llms.txt「GPT Image 2.6 低价版」一节 + 真机实测（2026-11-21）：
 *   POST {base}/v1/image/generations
 *   { model, prompt, size:'1:1', resolution:'1k|2k|4k',
 *     quality:'auto|low|medium|high|xhigh|max', output_format:'png|jpeg|webp',
 *     n:1, images:[≤16 张公网直链] }
 *   → **顶层 TaskDto**：{ id, task_id, model, status:'queued', created_at }
 *   GET {base}/v1/image/generations/{id}
 *   → { code:'success', data:{ task_id, status:'IN_PROGRESS' → 'SUCCESS',
 *       result_url, data:{ content:{ image_url, image_urls[] } } } }
 *
 * 注意提交与轮询是**两种包装**：提交是 OpenAI Video 风格的顶层对象（任务号在 `task_id`），
 * 轮询才是 `{code,data}` 两层。`channelTaskId` / `channelTaskState` 两边都认，所以这里不必分叉，
 * 但按 `{code:'success',data:{task_id}}` 去读提交回执会读空 —— 这是本轮真机踩到的第一处。
 *
 * 与同通道其它图像模型（Seedream 那套）**三处不同**，错一处要么 400、要么白花钱：
 *   ① 档位 / 画质 / 格式 / 张数都在**顶层**（Seedream 在 `metadata` 里）；
 *   ② `n` 固定 1 —— 实测 n=2 直接 400「supports 1K, 2K, 4K and n=1」，
 *      所以「生成数量」在这条路上不是「一次出几张」，要 N 张只能叫 N 次；
 *   ③ 1K 是**固定价** ¥0.044/张，2K/4K 按实际用量结算（estimate 实测 ¥0.236 / ¥0.315）。
 *
 * SVG / GIF 只给文生图且要额外字段（`svg.model` / `frame_count` / `size=auto`），
 * 画布的结果链路只收静态图，一并关掉 —— 给了入口就有人点，点了就是「提交成功、画布上没有图」。
 */
const ZZAI_GPT_IMAGE_PATTERN = /^zhenzhen-image-g-v2\.6-lowprice$/i;

/** 是不是 ZZAI 的 GPT Image 2.6 低价版（只有它走顶层 quality/output_format 那一套）。 */
export function isZzaiGptImageModel(modelId: unknown): boolean {
  return typeof modelId === 'string' && ZZAI_GPT_IMAGE_PATTERN.test(modelId.trim());
}

export const ZZAI_GPT_IMAGE_PROFILE: ChannelImageProfile = Object.freeze({
  resolutions: ['1K', '2K', '4K'],
  qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultQuality: 'auto',
  outputFormats: ['png', 'jpeg', 'webp'],
  fixedCount: true,
  outputNote: '每次出 1 张；1K ¥0.044/张，2K/4K 按实际用量结算',
});

/** 该图像模型在这家端点上的参数表；认不出来回 null = 走普通图像分支。 */
export function zzaiImageProfile(modelId: string): ChannelImageProfile | null {
  if (isZzaiGptImageModel(modelId)) return ZZAI_GPT_IMAGE_PROFILE;
  return isLayerDecompositionModel(modelId) ? ZZAI_LAYER_DECOMPOSITION_PROFILE : null;
}

/**
 * 图层拆分的**结果顺序与去重**。
 *
 * 2026-11-21 真机实测的坑：一次拆分回的 JSON 里同一个底图会出现**两次**，而且 URL 不同 ——
 *   `data.result_url`             = `https://rh-hk-images.xiaoyaoyou.com/…/c891f93e.png`
 *   `data.data.content.image_url` = `https://rh-hk-images-1252422369.cos.ap-hongkong.myqcloud.com/…/c891f93e.png`
 * 两个域名指向同一份对象，通用收集（collectResultRefs）按完整 URL 去重就会算成两张，
 * 于是画布上「13 张结果」里前两格都是底图 —— 用户点的「图层 1」其实是底图，后面全错位一格。
 *
 * 所以图层拆分这条链只认顺序表：`data.data.content.image_urls` 是上游按 zindex 排好的完整列表
 * （底图在最前、图层依次跟上），按**文件名**去重（同名的不同签名域名 = 同一张图）。
 * 列表缺失（少见）回空数组，由调用方退回通用收集。
 */
export function layerResultUrls(parsed: unknown): string[] {
  const content = (
    parsed as { data?: { data?: { content?: { image_urls?: unknown } } } } | null
  )?.data?.data?.content;
  const list = Array.isArray(content?.image_urls)
    ? content.image_urls.filter(
        (item): item is string => typeof item === 'string' && Boolean(item.trim()),
      )
    : [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of list) {
    const url = raw.trim();
    const file = url.split('?')[0].split('/').pop() ?? url;
    if (seen.has(file)) continue;
    seen.add(file);
    urls.push(url);
  }
  return urls;
}

/**
 * 图层的**几何**：文档画布尺寸 + 每一层该贴在哪儿、多大。
 *
 * 为什么必须有它（2026-11-21 用 PIL 对真机回执做过四种假设的像素对比）：
 * 图层 PNG 不是「整幅文档 + 透明」，而是**元素区域按统一倍数放大后的裁片**
 * （例：bbox 588×220 的图层 PNG 是 1062×397，两个方向都是 1.806 倍），
 * 所以贴回文档的正确做法是「按 bbox 的矩形**缩放**贴」——
 * 实测全量重建与原图最接近（平均通道差 17.6，其余假设 26.7 / 27.2）。
 * 拿不到 bbox 时退化成整幅文档（底图 zindex 0 就是这种，没有 boundingBox 字段）。
 *
 * `boundingBox.absolute` 是文档像素坐标 [x0, y0, x1, y1]（`normalized` 是同一组值 ÷ 文档尺寸 ×1000）。
 */
export interface LayerStackLayer {
  url: string;
  name?: string;
  /** 0 = 底图（最下层），越大越靠上。 */
  zindex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayerStack {
  /** 文档画布尺寸（= 底图尺寸）。 */
  width: number;
  height: number;
  layers: LayerStackLayer[];
}

/** `"1424x800"` → `{width, height}`；认不出来回 null。 */
function parseSize(value: unknown): { width: number; height: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * 从回执的 `data.data.content.layers[]` 取图层几何（按 zindex 升序 = 从下往上）。
 * 拿不到（老端点 / 没有 layers 字段）回 null，调用方退回「当普通多图处理」。
 */
export function layerStackOf(parsed: unknown): LayerStack | null {
  const content = (
    parsed as { data?: { data?: { content?: { layers?: unknown } } } } | null
  )?.data?.data?.content;
  const rawLayers = Array.isArray(content?.layers) ? content.layers : [];
  const items = rawLayers
    .map((raw, index) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item, index) => ({
      item,
      index,
      zindex: Number.isFinite(Number(item.zindex)) ? Number(item.zindex) : index,
      size: parseSize(item.size),
    }));
  if (!items.length) return null;
  // 文档尺寸 = 底图（zindex 0）的 size；底图缺失时取所有 size 里最大的那个
  const base = items.find((entry) => entry.zindex === 0) ?? items[0];
  let width = base?.size?.width ?? 0;
  let height = base?.size?.height ?? 0;
  if (!width || !height) {
    for (const entry of items) {
      if (!entry.size) continue;
      width = Math.max(width, entry.size.width);
      height = Math.max(height, entry.size.height);
    }
  }
  const layers: LayerStackLayer[] = [];
  for (const entry of items.slice().sort((a, b) => a.zindex - b.zindex)) {
    const url = typeof entry.item.url === 'string' ? entry.item.url.trim() : '';
    if (!url) continue;
    const box = (entry.item.boundingBox as { absolute?: unknown } | undefined)?.absolute;
    const values = Array.isArray(box) ? box.map((value) => Number(value)) : [];
    let x = 0;
    let y = 0;
    let w = width;
    let h = height;
    if (values.length === 4 && values.every((value) => Number.isFinite(value))) {
      x = Math.max(0, Math.min(width, Math.round(values[0])));
      y = Math.max(0, Math.min(height, Math.round(values[1])));
      w = Math.max(1, Math.min(width - x, Math.round(values[2] - values[0])));
      h = Math.max(1, Math.min(height - y, Math.round(values[3] - values[1])));
    }
    layers.push({
      url,
      ...(typeof entry.item.name === 'string' && entry.item.name.trim()
        ? { name: entry.item.name.trim().slice(0, 60) }
        : {}),
      zindex: entry.zindex,
      x,
      y,
      width: w,
      height: h,
    });
  }
  if (!layers.length || !width || !height) return null;
  return { width, height, layers };
}

/**
 * 画布档位 → 图层拆分端点真收的档位词。
 *
 * 端点只认 `auto` / `1k` / `1.5k` / `2k` 四个词（官网 llms.txt 的 metadata.resolution 表），
 * 画布下拉里的 `4K`、视频档 `720p/1080p` 一律夹到能跑的档：4K/2K→2k、1.5K→1.5k、1K→1k，
 * 认不出来按官方默认 `auto`（= 沿用输入图的分辨率档，最省也最不容易糊）。
 */
export function zzaiLayerResolution(body: Record<string, unknown> | null): string {
  const raw = typeof body?.resolution === 'string' ? body.resolution.trim().toLowerCase() : '';
  if (raw === '1.5k' || raw === '1.5') return '1.5k';
  if (raw === '1k' || raw === '720p') return '1k';
  if (raw === '2k' || raw === '4k' || raw === '1080p' || raw === '1440p') return '2k';
  return 'auto';
}

/**
 * GPT Image 2.6 低价版的档位：只有 `1k` / `2k` / `4k`，**认不出来按 1k**。
 *
 * 为什么不复用 zzaiImageResolution（它的默认是 2k）：这条模型 1K 是固定 ¥0.044，
 * 2K/4K 按实际用量结算（¥0.236 / ¥0.315 量级）—— 一个没填档位的请求不该悄悄按 2K 计费。
 */
export function zzaiGptImageResolution(body: Record<string, unknown> | null): string {
  const raw = typeof body?.resolution === 'string' ? body.resolution.trim().toLowerCase() : '';
  if (raw === '4k') return '4k';
  if (raw === '2k' || raw === '1440p' || raw === '1080p') return '2k';
  return '1k';
}

/**
 * 画质：`auto` / `low` / `medium` / `high` / `xhigh` / `max`。
 *
 * 画布的图片节点上 `quality` 字段默认是 `auto`（vendor 的 buildImageRequest 兜底写的），
 * 这个模型也正好吃 `auto`，所以认不出来就回 `auto` —— 别把一个端点不认识的词发上去。
 */
export function zzaiImageQuality(body: Record<string, unknown> | null): string {
  const raw = typeof body?.quality === 'string' ? body.quality.trim().toLowerCase() : '';
  const allowed = ZZAI_GPT_IMAGE_PROFILE.qualities ?? ['auto'];
  return allowed.find((item) => item === raw) ?? 'auto';
}

/** 输出格式：只收 `png` / `jpeg` / `webp`（`jpg` 是别名的兼容写法，这里统一成 `jpeg`）。 */
export function zzaiImageOutputFormat(body: Record<string, unknown> | null): string {
  const raw = typeof body?.output_format === 'string' ? body.output_format.trim().toLowerCase() : '';
  if (raw === 'jpg' || raw === 'jpeg') return 'jpeg';
  if (raw === 'webp') return 'webp';
  // 默认 png：结果要进画布 / 调色合成器，有损格式在这一步就开始掉细节。
  return 'png';
}

/** 这个视频模型是不是「只收源视频」的超分模型（画布上不必填提示词/时长）。 */
export function isVideoUpscaler(modelId: string): boolean {
  return zzaiVideoProfile(modelId)?.upscaler === true;
}

/**
 * 画布档位 → 超分端点真收的档位词。
 *
 * 与 H3 的 `closestVideoResolution` 不同：这家的大档位是 `2K`/`4K`（大写 K），
 * 小档位才是 `720p`/`1080p`（小写 p）。统一转成官方写法，猜不出来按文档默认 1080p。
 */
export function upscaleTargetResolution(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === '720p' || raw === '1080p') return raw;
  if (raw === '2k') return '2K';
  if (raw === '4k') return '4K';
  return '1080p';
}

/** 画布下拉 → 超分端点真收的质量词（大小写敏感：`Ultra`/`Max`/…；不认识按默认 Max）。 */
export function upscaleQuality(value: unknown): string {
  const allowed = ZZAI_TOPAZ_UPSCALER_PROFILE.qualities ?? ['Max'];
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const hit = allowed.find((item) => item.toLowerCase() === raw);
  return hit ?? ZZAI_TOPAZ_UPSCALER_PROFILE.defaultQuality ?? 'Max';
}

/** 画布档位（720p/1080p/1K…）→ 端点真收的档位。 */
export function closestVideoResolution(desired: string, allowed: readonly string[]): string | null {
  const raw = desired.trim().toLowerCase();
  if (!raw) return null;
  if (allowed.includes(raw)) return raw;
  const pick = /^(\d+(?:\.\d+)?)\s*[pP]$/.exec(raw);
  const wanted = pick ? Number(pick[1]) : null;
  if (wanted === null || !Number.isFinite(wanted)) return allowed[0] ?? null;
  let best = allowed[0] ?? null;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const digits = /^(\d+)\s*[pP]$/.exec(candidate);
    if (!digits) continue;
    const distance = Math.abs(Number(digits[1]) - wanted);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** 画布宽高比 → 端点真收的宽高比（按对数值最接近，1:1 这种两边都不像时取第一个）。 */
export function closestAspectRatio(desired: string, allowed: readonly string[]): string | null {
  const raw = desired.trim().toLowerCase();
  const parse = (value: string) => {
    const match = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(value);
    if (!match) return null;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!(a > 0) || !(b > 0)) return null;
    return a / b;
  };
  if (!raw) return null;
  if (allowed.includes(raw)) return raw;
  const wanted = parse(raw);
  if (wanted === null) return allowed[0] ?? null;
  let best = allowed[0] ?? null;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const value = parse(candidate);
    if (value === null) continue;
    const distance = Math.abs(Math.log(value) - Math.log(wanted));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** 视频时长 → 该模型允许的整秒（夹到区间里）。 */
export function clampSeconds(value: unknown, profile: Pick<ChannelVideoProfile, 'minSeconds' | 'maxSeconds'>): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(profile.maxSeconds, Math.max(profile.minSeconds, Math.round(seconds)));
}


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
  // 方言：显式给了 CHANNEL_DIALECTS 里的值才写进去；给空串、给别的值、或不给 = **自动**
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
  // 先把「名字里明说了是出图的」钉死：`kling/kling-v3-omni-image-generation` 同时带 kling（视频词根）
  // 与 image-generation，按下面「视频优先」的顺序会被猜成视频，于是勾进来挂到图片节点上是 422。
  [
    /(?:image[-_]?generation|image[-_]?edit|image[-_]?synthesis|text[-_]?to[-_]?image|t2i)$/i,
    'image' as CloudKind,
  ],
  [
    // `minimax-h3-comfyui-*`（ZZAI 的 ComfyUI 工作流系列）名里没有 t2v/video 这类词根，
    // 不单独列就会被落到下面的默认值「图像」—— 勾进来挂到视频节点上是 422。
    // `Topaz-Upscale-*` / `RH-Upscale` 是 ZZAI 的视频超分（v1.100），名字里同样没有 video。
    /(?:^|[-_/.])(?:t2v|i2v|v2v|video|veo|sora|kling|seedance|wan2|hunyuanvideo|hailuo|cogvideo|ltx|minimax-h3-comfyui|topaz[-_ ]?upscale|rh[-_ ]?upscale)/i,
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
    // 视频模型的参数表顺手带给界面：档位 / 宽高比 / 时长区间按模型**真收的**来出下拉，
    // 别让用户选到必然 400 的组合（ZZAI 的 ComfyUI 各工作流词表完全不同）。
    models: channel.models.map((model) => {
      const zhenzhen = channelDialect(channel) === 'zhenzhen';
      if (model.kind === 'video') {
        const profile = zhenzhen ? zzaiVideoProfile(model.id) : null;
        return profile ? { ...model, videoProfile: profile } : model;
      }
      // 图像侧同理：图层拆分模型要带档位表（`auto`/`1k`/`1.5k`/`2k`）与「只吃一张图」的语义，
      // 否则界面上会按普通文生图给它 1K/2K/4K 与 14 张参考图。
      if (model.kind === 'image') {
        const profile = zhenzhen ? zzaiImageProfile(model.id) : null;
        return profile ? { ...model, imageProfile: profile } : model;
      }
      return model;
    }),
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
  // 视频节点的参考素材（`body.videos`）与参考音频（`body.audios`）也要能过 /files/upload：
  // 表里没有的话上传会用 'image/png' 当 MIME，端点收到一个「名字是 .mp4、类型是 png」的文件。
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
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
 * 参考素材 → **公网 http(s) 直链**（百炼/可灵那条路只收这种）。
 *
 * 为什么不能像魔搭那样内联：可灵图像生成的 `content[].image` 文档写死了
 * 「参考图像的 URL，支持 HTTP 或 HTTPS 协议」，data URL 会直接被拒（或当没传）。
 * 画布上的素材都存在本机（`/api/aifisher/canvas/media/…`），外面看不见 ——
 * 所以这里**宁可报错也不偷偷丢掉参考图**：静默丢图听起来像「画布坏了」，用户根本无从下手。
 */
export async function publicChannelReferences(
  references: readonly string[],
  deps: { mediaStore?: MediaStore } = {},
): Promise<string[]> {
  const assets = await resolveReferenceAssets(references, deps);
  const urls: string[] = [];
  for (const asset of assets) {
    if (asset.kind === 'url') {
      urls.push(asset.url);
      continue;
    }
    const name = asset.kind === 'bytes' ? asset.filename : '（内联图）';
    throw new ChannelRequestError(
      `这条通道只收公网 http(s) 参考图，画布本机素材「${name}」不能直接提交。`,
      422,
      'CHANNEL_REFERENCE_NOT_PUBLIC',
      '可灵/百炼的图像任务要求参考图是公网直链；画布上的图片存在本机、外面访问不到。'
        + '先用「文生图」出图，或把这张图传到图床换成公网链接再连进来。',
    );
  }
  return urls;
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

/**
 * ZZAI 图像的档位词：`1k` / `2k` / `4k`（文档默认 2k）。
 *
 * 与 FisherAI 同一套口径，但视频档（720p/1080p）按长短边折到 1k/2k ——
 * 图像任务拿到画布的视频档只可能来自「模型类型勾错」，原样发上去是 400。
 */
export function zzaiImageResolution(body: Record<string, unknown> | null): string {
  const raw = typeof body?.resolution === 'string' ? body.resolution.trim().toLowerCase() : '';
  if (raw === '4k') return '4k';
  if (raw === '2k' || raw === '1440p' || raw === '1080p') return '2k';
  if (raw === '1k' || raw === '720p') return '1k';
  return '2k';
}

/**
 * 百炼的档位词：`1k` / `2k` / `4k`（可灵 v3-omni 三档都收，v3 只收前三档里的 1k/2k）。
 * 视频档（720p/1080p）一律按 1k —— 这个端点不收像素档，原样发上去是 400。
 */
export function dashscopeResolution(body: Record<string, unknown> | null): string {
  const raw = typeof body?.resolution === 'string' ? body.resolution.trim().toLowerCase() : '';
  if (raw === '4k') return '4k';
  if (raw === '2k' || raw === '1440p') return '2k';
  return '1k';
}

/**
 * 百炼的图像张数：端点收 1–9（`parameters.n`），比通用的 `countOf` 上限 8 多一张。
 * 用户填 9 却只出 8 张是那种「没有任何报错」的失望，所以按端点自己的范围夹。
 */
export function dashscopeCount(body: Record<string, unknown> | null): number {
  const raw = Number(body?.generateCount);
  return Number.isFinite(raw) && raw > 1 ? Math.min(Math.trunc(raw), 9) : 1;
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
  // FisherAI 与 ZZAI 都是顶层 `images[]`（公网直链），不是 OpenAI 的 `image`。
  if (dialect === 'workfisher' || dialect === 'zhenzhen') return { images: [...images] };
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
  /** 视频节点连过来的待编辑/参考视频（只有部分中转扩展模型收，见下面的分支）。 */
  videos?: readonly string[];
  /** 视频节点连过来的参考音频。 */
  audios?: readonly string[];
  dialect?: ChannelDialect;
}): Record<string, unknown> {
  const { kind, model, body } = input;
  const images = input.images ?? [];
  const videos = input.videos ?? [];
  const audios = input.audios ?? [];
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
  if (kind === 'image' && dialect === 'midjourney') {
    /**
     * Midjourney（`api.work-fisher.com` 的 `/v1/midjourney/*`，2026-11-11 用户给了价格页
     * https://api.work-fisher.com/pricing?search=Midjourney&kind=image）。
     *
     * **与同域名下 FisherAI 的图像/视频不是一套协议**，官方文档也特意写了
     * 「与历史 /mj/* Discord 代理协议不是同一套」：
     *
     *   POST {base}/midjourney/generations
     *   { model:'midjourney', prompt, size:'16:9', version:'8.1', speed:'fast',
     *     image_urls:[公网直链] }
     *   → { code:200, data:[{ status:'submitted', task_id:'task_…' }] }
     *   GET  {base}/midjourney/tasks/{task_id}
     *   → { id, status:'SUCCESS'|'IN_PROGRESS'|'FAILURE'|'MODAL', progress,
     *       grid_image_url, image_urls:[4 张], buttons:[{customId,label}] }
     *
     * 四处照抄（错一处都是 400 / 空结果，报错里看不出缺的是哪个）：
     *   ① 计费 SKU 由**路径**决定（kebab-case action），`body.model` 不参与路由 —— 这里写文档里的 `midjourney`；
     *   ② 任务号在 `data[0].task_id`（**数组**，不是工作流那套 `data.task_id`）；
     *   ③ 轮询是 `/midjourney/tasks/{id}` —— 既不是「提交地址 + /{id}」，也不是 `/v1/tasks/{id}`（实测 404 Invalid URL）；
     *   ④ 参考图走 `image_urls`（垫图），和 FisherAI 的 `images` 不是同一个字段名。
     *
     * 一个 Imagine 任务**固定出 4 张候选**（四宫格 + 4 张单图），`n` 传了也无效；
     * 画布的「生成数量」在这里表示「保留几张」，由 cloudGenerationRouter 在收尾时按 `image_urls` 截取。
     */
    const payload: Record<string, unknown> = { model: 'midjourney', prompt };
    const ratio = channelAspectRatio(body);
    if (ratio) payload.size = ratio;
    const version = typeof body?.version === 'string' ? body.version.trim() : '';
    if (version) payload.version = version;
    const speed = typeof body?.speed === 'string' ? body.speed.trim().toLowerCase() : '';
    if (speed === 'relax' || speed === 'fast' || speed === 'turbo') payload.speed = speed;
    // `count` 不发给端点（MJ 不收 n）；它只在 router 收尾时决定留几张。
    if (images.length) payload.image_urls = [...images];
    return payload;
  }
  if (kind === 'image' && dialect === 'zhenzhen') {
    /**
     * ZZAI 的异步图片任务（`POST /v1/image/generations` → `GET /v1/image/generations/{id}`）。
     *
     * 与 FisherAI 图像分支的区别：档位 / 宽高比 / 输出格式**全在 `metadata` 里**，顶层没有
     * `size` / `resolution`（文档里 Seedream 那套认 `metadata.width/height`，但传它不认识的
     * 分辨率词是 400，所以这里只发它列过的 `1k` / `2k` / `4k`）。
     * 参考图同样只收公网直链，调用方已经过 `/files/upload` 换好链接。
     */
    if (isLayerDecompositionModel(model.id)) {
      /**
       * 图层拆分（2026-11-21 实测通过，官方 docs/llms.txt 与定价页同一套）：
       *
       *   POST {base}/v1/image/generations
       *   { model:'dola-seedream-5.0-flash-layer-decomposition', images:[一张公网直链],
       *     prompt?: '可选：想拆哪些元素', metadata:{ resolution:'auto', output_format:'png' } }
       *   → { code:'success', data:{ task_id } }
       *   GET {base}/v1/image/generations/{id}
       *   → data.status='SUCCESS'、data.data.content.image_urls = [底图, 图层1, … 图层N]
       *     （按 zindex 排好；`layers[]` 里是同一批 URL 加名字/包围盒，画布只吃 URL 列表）
       *
       * 三处与普通图像分支不同，错一处都是白花钱：
       *   ① `images` 必须**恰好一张**（多图是 400；少图是「提交成功、跑完没结果」）；
       *   ② 档位换成 `auto`/`1k`/`1.5k`/`2k`（普通那套的 4k 不在表里）；
       *   ③ 底图给 `png`（默认 jpeg）—— 拆分结果后面要进调色合成器，有损底图会让图层对不上。
       *
       * `prompt` 是**可选**的（0~2000 字）：留空时上游按「自动识别主要元素」拆，
       * 这正是用户「我只想拆图」的场景，所以空串就不发这个字段。
       */
      if (!images.length) {
        throw new ChannelRequestError(
          '图层拆分需要一张待拆分的图片（这个模型不会凭空画图）。',
          422,
          'CHANNEL_LAYER_INPUT_REQUIRED',
          '把任意图片节点（或上传图片）连到图层拆分节点的输入端，再点生成。',
        );
      }
      const metadata: Record<string, unknown> = {
        resolution: zzaiLayerResolution(body),
        output_format: 'png',
      };
      const text = prompt.trim().slice(0, 2000);
      return {
        model: model.id,
        images: [images[0]],
        ...(text ? { prompt: text } : {}),
        metadata,
      };
    }
    const payload: Record<string, unknown> = { model: model.id, prompt };
    // GPT Image 2.6 低价版（v1.105）：顶层 size/resolution/quality/output_format/n=1。
    // 与下面 Seedream 那套（metadata）**不能混** —— 顶层字段是官方示例的写法，
    // 而 metadata 里只放 ratio 的写法在这条模型上会被当作「没给档位/画质」。
    if (isZzaiGptImageModel(model.id)) {
      payload.size = channelAspectRatio(body) ?? '1:1';
      payload.resolution = zzaiGptImageResolution(body);
      payload.quality = zzaiImageQuality(body);
      payload.output_format = zzaiImageOutputFormat(body);
      // n 固定 1（n=2 是 400）；参考图最多 16 张（多出来的由 router 在提交前拦）。
      payload.n = 1;
      if (images.length) payload.images = [...images.slice(0, 16)];
      return payload;
    }
    if (images.length) payload.images = [...images];
    const metadata: Record<string, unknown> = { resolution: zzaiImageResolution(body) };
    const ratio = channelAspectRatio(body);
    if (ratio) metadata.ratio = ratio;
    payload.metadata = metadata;
    return payload;
  }
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
  if (kind === 'image' && dialect === 'dashscope') {
    /**
     * 百炼（DashScope）异步图像任务 —— 与前面三套方言没有一处相同：
     *
     *   POST {base}/api/v1/services/aigc/image-generation/generation
     *   header X-DashScope-Async: enable
     *   { model, input: { messages: [{ role: 'user', content: [{ text }, { image }, …] }] },
     *     parameters: { n, aspect_ratio: '16:9', resolution: '1k' } }
     *   → { output: { task_id, task_status: 'PENDING' }, request_id }
     *
     * 四个必须照抄的点（缺一个都是 400 或空结果，报错里看不出缺的是哪个）：
     *   ① `content` 是**数组**、文本与参考图放在同一个数组里（不是 OpenAI 的 prompt 字段）；
     *   ② `n` / `aspect_ratio` / `resolution` 在 `parameters` 里，不在顶层；
     *   ③ 异步头必须带（缺了会报 "current user api does not support synchronous calls"）；
     *   ④ 一个 text 只能有**一个**，多传会报错 —— 所以这里只放一份 prompt。
     *
     * 参考图（`image`）只收公网 http(s) 直链，本机素材要先换链接（见 publicChannelReferences）；
     * 画布上暂时只给这类通道开「文生图」，等有公网图床再开图生图。
     */
    const content: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const image of images) content.push({ image });
    const parameters: Record<string, unknown> = { n: dashscopeCount(body) };
    const ratio = channelAspectRatio(body);
    if (ratio) parameters.aspect_ratio = ratio;
    parameters.resolution = dashscopeResolution(body);
    return {
      model: model.id,
      input: { messages: [{ role: 'user', content }] },
      parameters,
    };
  }
  if (kind === 'video' && dialect === 'workfisher') {
    /**
     * FisherAI 视频任务（2026-10-20 用户给的 minimax-h3-ow-r2v curl + 用真 key 实测的收尾形状）：
     *   POST {base}/video/generations
     *   { model, prompt, images: [公网直链], seconds: "5",
     *     metadata: { resolution: "480p", ratio: "16:9", audio_urls: [...], video_url: [...] } }
     *   → 回 `{ id, task_id, status: "queued", progress: 0 }`
     *   → GET {base}/video/generations/{id}，是**图片那套两层 data**：
     *     `{code:'success', data:{status:'IN_PROGRESS'|'SUCCESS', progress:'100%',
     *       usage:{amount,currency}, result_url, data:{content:{video_url}}}}`
     *     （状态全大写；视频地址同时出现在 `data.result_url` 与 `data.data.content.video_url`，
     *      collectResultRefs 两处都认，URL 相同所以去重后只剩一条）
     *
     * 与图片那套的四处不同，每一处配错都不报错：
     *   ① 路径是**单数** video（`/videos/generations` 实测 404 "Invalid URL"）；
     *   ② `seconds` 必须是**字符串**（实测传数字：`cannot unmarshal number into Go struct
     *      field .Alias.seconds of type string`）；
     *   ③ 档位/宽高比不在顶层，而在 `metadata` 里（`resolution` 必填且只有小写三档，
     *      例如 r2v 只收 1080p/480p/768p —— 大写 `480P` 会被拒）；
     *   ④ 参考图走顶层 `images`（数组，公网直链），不是 OpenAI 的 `image`。
     */
    const payload: Record<string, unknown> = { model: model.id, prompt };
    const seconds = Number(body?.duration);
    if (Number.isFinite(seconds) && seconds > 0) payload.seconds = String(seconds);
    if (images.length) payload.images = [...images];
    const metadata: Record<string, unknown> = {};
    const resolution =
      typeof body?.resolution === 'string' ? body.resolution.trim().toLowerCase() : '';
    if (resolution) metadata.resolution = resolution;
    const ratio = channelAspectRatio(body);
    if (ratio) metadata.ratio = ratio;
    // 画布视频节点自带的高级参数（有才带，别把未声明的字段塞给端点）
    if (typeof body?.generate_audio === 'boolean') metadata.generate_audio = body.generate_audio;
    const seed = Number(body?.seed);
    if (body?.seed !== undefined && body.seed !== '' && Number.isFinite(seed)) metadata.seed = seed;
    if (typeof body?.return_last_frame === 'boolean') {
      metadata.return_last_frame = body.return_last_frame;
    }
    // 文档样例里这两个都是**数组**；`-multi`/`g-omni` 一类模型才看它们，r2v 不带就整个省略。
    if (videos.length) metadata.video_url = [...videos];
    if (audios.length) metadata.audio_urls = [...audios];
    if (Object.keys(metadata).length) payload.metadata = metadata;
    return payload;
  }
  if (kind === 'video' && dialect === 'zhenzhen') {
    /**
     * ZZAI 的异步视频任务（MiniMax H3 ComfyUI 系列走这条，2026-11-21 接）：
     *
     *   POST {base}/v1/video/generations
     *   { model, prompt, images:[公网直链], seconds:"5",
     *     metadata:{ resolution:"480p", ratio:"16:9", audio_urls:[…], video_url:[…], seed } }
     *   → { code:'success', data:{ task_id } }（任务号也可能在顶层 `id`，channelTaskId 两边都认）
     *   GET {base}/v1/video/generations/{id}
     *   → { code:'success', data:{ status:'SUCCESS', result_url, data:{content:{video_url}} } }
     *
     * 三处**按模型夹**（表在 ZZAI_H3_PROFILES）：秒数区间、分辨率档、宽高比 ——
     * 这一家对不认识的档位是提交即拒，报错只写 "invalid request parameters"，
     * 从画布这边看不出是档位的问题。认不出来的模型（别家的 t2v/i2v）原样透传。
     * 参考视频 / 参考音频只在该模型真收时才带上（角色替换收视频、数字人收音频）。
     */
    // 超分模型（Topaz-Upscale-LowPirce / RH-Upscale，v1.100）：只收一段源视频 + 目标档位 + 超分质量。
    // 与 H3 那批**形状完全不同**（没有 prompt/seconds/ratio/images）—— 照 H3 的字段发过去
    // 端点不会报错，只会当没收到视频，最后回一句「没有结果」，所以单独一条分支。
    if (zzaiVideoProfile(model.id)?.upscaler === true) {
      const source = videos[0];
      if (!source) {
        throw new ChannelRequestError(
          '视频超分需要先连接一段源视频（MP4）：这个模型不按提示词生成，只把已有视频提升分辨率。',
          422,
          'CHANNEL_SOURCE_VIDEO_REQUIRED',
          '把「上传视频」或任意视频节点的输出连到超分节点的输入端，再点生成。',
        );
      }
      return {
        model: model.id,
        metadata: {
          video_url: [source],
          resolution: upscaleTargetResolution(body?.resolution),
          quality: upscaleQuality(body?.quality),
        },
      };
    }
    const profile = zzaiVideoProfile(model.id);
    const payload: Record<string, unknown> = { model: model.id, prompt };
    const requestedSeconds = Number(body?.duration);
    const seconds = profile
      ? clampSeconds(requestedSeconds, profile)
      : Number.isFinite(requestedSeconds) && requestedSeconds > 0
        ? Math.round(requestedSeconds)
        : null;
    if (seconds !== null) payload.seconds = String(seconds);
    if (images.length) {
      payload.images = [...images.slice(0, profile?.maxImages ?? images.length)];
    }
    const metadata: Record<string, unknown> = {};
    const rawResolution = typeof body?.resolution === 'string' ? body.resolution.trim() : '';
    if (profile) {
      const resolution = closestVideoResolution(rawResolution, profile.resolutions);
      if (resolution) metadata.resolution = resolution;
      const ratio = closestAspectRatio(channelAspectRatio(body) ?? '', profile.aspectRatios);
      if (ratio) metadata.ratio = ratio;
    } else {
      if (rawResolution) metadata.resolution = rawResolution.toLowerCase();
      const ratio = channelAspectRatio(body);
      if (ratio) metadata.ratio = ratio;
    }
    const seed = Number(body?.seed);
    if (body?.seed !== undefined && body.seed !== '' && Number.isFinite(seed)) {
      if (!profile || profile.seed) metadata.seed = Math.trunc(seed);
    }
    if (audios.length && (!profile || profile.maxAudios > 0)) {
      metadata.audio_urls = [...audios.slice(0, profile?.maxAudios ?? audios.length)];
    }
    if (videos.length && (!profile || profile.maxVideos > 0)) {
      metadata.video_url = [...videos.slice(0, profile?.maxVideos ?? videos.length)];
    }
    if (Object.keys(metadata).length) payload.metadata = metadata;
    return payload;
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

/**
 * 百炼的 API 根：`https://host` 或 `https://host/api/v1` 都兼容。
 *
 * 文档给的提交地址带 `/api/v1`（`…/api/v1/services/aigc/image-generation/generation`），
 * 而界面上的 Base URL 通常只填到域名 —— 两种写法都不该让人手动补。所以这里统一算出
 * 「到 api/v1 为止」的前缀，再加各自的资源路径。
 */
export function dashscopeApiRoot(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, '');
  return /\/api\/v1$/i.test(base) ? base : `${base}/api/v1`;
}

/** 百炼异步图像任务的提交路径（相对 Base URL）。 */
export function dashscopeImagePath(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, '');
  const prefix = /\/api\/v1$/i.test(base) ? '' : '/api/v1';
  return `${prefix}/services/aigc/image-generation/generation`;
}

/** 该通道该媒体类型该打哪个路径：用户显式填的 > 方言自带的 > OpenAI 默认。 */
export function channelPath(channel: CloudChannel, kind: CloudKind): string {
  const override = channel.paths?.[kind];
  if (override && override.startsWith('/')) return override;
  const dialect = channelDialect(channel);
  // 百炼的图像路径依赖 baseUrl 是否已经带 /api/v1，必须按实例算（见 dashscopeImagePath）；
  // 文本走兼容模式，路径固定。
  if (dialect === 'dashscope' && kind === 'image') return dashscopeImagePath(channel.baseUrl);
  // ZZAI 的路径同样取决于 baseUrl 有没有带 /v1（见 zhenzhenApiPath），必须按实例算。
  if (dialect === 'zhenzhen') return zhenzhenApiPath(channel.baseUrl, kind);
  return DIALECT_PATHS[dialect]?.[kind] ?? DEFAULT_PATHS[kind];
}

export function buildChannelRequest(input: {
  channel: CloudChannel;
  model: CloudChannelModel;
  kind: CloudKind;
  body: Record<string, unknown> | null;
  images?: readonly string[];
  videos?: readonly string[];
  audios?: readonly string[];
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

// ------------------------------------------------------------------ 异步任务（魔搭 / FisherAI / 百炼那套）

/**
 * 三套异步网关都走「提交拿号 → 轮询取结果」，但细节没有一处相同：
 *
 *   - **魔搭**：POST 立刻回 `{task_id, task_status}`（而且 task_status 当场就写 SUCCEED，不能信），
 *     要带 `X-ModelScope-Async-Mode` 才真建任务；轮询 `GET /tasks/{id}`（带 `X-ModelScope-Task-Type`），
 *     收尾是 `output_images: [...]`。
 *   - **FisherAI**：POST `/image/generations` 回任务号（或包在 `{code, data}` 里），
 *     轮询 `GET /image/generations/{id}`；状态机是大写的 NOT_START / SUBMITTED / IN_PROGRESS /
 *     SUCCESS / FAILURE，收尾把图片埋在 `data.data.content.image_urls[]`（`data.result_url` 兜底）。
 *     结果直链带签名、约 24 小时过期，**必须立刻下载转存**。
 *   - **百炼（DashScope）**：POST 回 `{output:{task_id, task_status:'PENDING'}}`，
 *     要带 `X-DashScope-Async: enable`；轮询 `GET {base}/api/v1/tasks/{id}`；
 *     状态在 `output.task_status`（PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED/UNKNOWN），
 *     收尾图片在 `output.choices[0].message.content[].image`。
 *
 * 所以头、轮询地址、状态字段、结果字段四处都按方言分流；只有「POST 没有结果素材却带着任务号
 * → 去轮询」这条判断是三家共用的。
 */
export function channelAsyncHeaders(dialect: ChannelDialect = 'modelscope'): Record<string, string> {
  // 百炼只认它自己的异步头；缺了这一句会直接报
  // "current user api does not support synchronous calls"（图像任务只支持异步）。
  if (dialect === 'dashscope') return { 'X-DashScope-Async': 'enable' };
  // 只有 FisherAI / ZZAI 那两套网关不认这个头；OpenAI 兼容的中转站一律忽略未知头，
  // 所以保持 v1.11 起的老行为（非文本请求都带），免得动到已经跑通的通道。
  // Midjourney 与 FisherAI 是同一个网关（/v1/midjourney/*），同样不带。
  if (dialect === 'zhenzhen') {
    // ZZAI 的入口有 Cloudflare 防护，文档明确要求带一个像样的 User-Agent
    // （Python-urllib 的默认值会被拦成 403 + 非 JSON 的 "error code: 1010"；Node fetch 的默认值同理不保险）。
    return { 'user-agent': CHANNEL_USER_AGENT };
  }
  if (dialect === 'workfisher' || dialect === 'midjourney') return {};
  return { 'X-ModelScope-Async-Mode': 'true' };
}

/** 发给端点时自称的身份（ZZAI 那套要求明确的 UA；别的方言沿用默认，不动已跑通的链路）。 */
export const CHANNEL_USER_AGENT = 'dsh-aifisher-canvas/1.100 (+https://github.com/duyumingze/dsh-aifisher-canvas)';

/** 轮询任务的请求地址与头（魔搭从 base 拼 /tasks/{id}；FisherAI 是「提交地址 + /{id}」）。 */
export function channelTaskPoll(input: {
  channel: CloudChannel;
  kind: CloudKind;
  taskId: string;
  /** 提交时用的地址；FisherAI 的轮询地址由它推导，缺省才退回 base + /image/generations。 */
  submitUrl?: string;
}): { url: string; headers: Record<string, string> } {
  const dialect = channelDialect(input.channel);
  if (dialect === 'midjourney') {
    // GET {base}/midjourney/tasks/{task_id}（与提交路径 /midjourney/generations 并列，
    // 不是「提交路径 + /{id}」）。baseUrl 里已含 /v1，所以完整地址是 /v1/midjourney/tasks/…
    return {
      url: `${input.channel.baseUrl.replace(/\/+$/u, '')}/midjourney/tasks/${encodeURIComponent(input.taskId)}`,
      headers: { accept: 'application/json' },
    };
  }
  if (dialect === 'workfisher' || dialect === 'zhenzhen') {
    const submit =
      (input.submitUrl && input.submitUrl.trim()) || `${input.channel.baseUrl}/image/generations`;
    return {
      url: `${submit.replace(/\/+$/, '')}/${encodeURIComponent(input.taskId)}`,
      headers: {
        accept: 'application/json',
        ...(dialect === 'zhenzhen' ? { 'user-agent': CHANNEL_USER_AGENT } : {}),
      },
    };
  }
  if (dialect === 'dashscope') {
    // GET {base}/api/v1/tasks/{task_id}（只要 Authorization，不要异步头）
    return {
      url: `${dashscopeApiRoot(input.channel.baseUrl)}/tasks/${encodeURIComponent(input.taskId)}`,
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

/**
 * 挑出真正装任务的那层。
 *
 * 三种包法：FisherAI `{code:'success', data:{…}}`；百炼 `{output:{task_id, task_status, choices}}`
 * （错误则只在根上回 `code`/`message`，没有 output）；魔搭直接在根上。
 */
export function channelTaskEnvelope(parsed: unknown): Record<string, unknown> {
  const body = (parsed ?? {}) as Record<string, unknown>;
  for (const key of ['data', 'output']) {
    const inner = body[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return body;
}

/**
 * 从响应里取任务 ID（魔搭 / FisherAI 都是 `task_id`，FisherAI 还包在 data 里）。
 *
 * Midjourney 的提交回执是 `{code:200, data:[{status:'submitted', task_id}]}` ——
 * `data` 是**数组**（`channelTaskEnvelope` 只认对象，所以这里单独扫一遍 data[]）。
 */
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
  if (Array.isArray(root.data)) {
    for (const item of root.data as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      for (const key of ['task_id', 'taskId']) {
        const value = entry[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
  }
  /**
   * 视频那套（`POST /video/generations`）**只回顶层 `id`**，没有 `task_id`、也没有 task_status。
   * 只认顶层：图片任务响应里的 `data.id` 是数据库行号（上游 relayProvider 特意注明
   * "data.id is a database row ID"），拿它去轮询会打到一个不存在的任务上。
   * 调用方只会在「没有结果素材」时才用这个值，所以成功响应里顺带出现的 id 不会被误用。
   */
  if (typeof root.id === 'string' && root.id.trim()) return root.id.trim();
  return null;
}

export type ChannelTaskState = 'running' | 'succeeded' | 'failed';

/**
 * 任务状态归一（魔搭：PENDING/RUNNING/SUCCEED；FisherAI：SUBMITTED/IN_PROGRESS/SUCCESS/FAILURE；
 * 百炼：PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED/UNKNOWN；
 * Midjourney：NOT_START/SUBMITTED/IN_PROGRESS/SUCCESS/FAILURE/MODAL）。
 *
 * 百炼「任务失败」还有一种没有 output 的形状：HTTP 200 + 根上 `{code, message, request_id}`。
 * 不把它当失败的话，轮询会一直读到「running」直到超时（15 分钟白等）。
 *
 * Midjourney 的 `MODAL` 是「任务在等补参数」（局部重绘要先给 mask）——画布不接二次补参，
 * 当 running 会白等到超时，所以按失败报出来。
 */
export function channelTaskState(parsed: unknown): { state: ChannelTaskState; raw: string } {
  const body = channelTaskEnvelope(parsed);
  const raw = String(body.task_status ?? body.status ?? '').trim();
  const value = raw.toUpperCase();
  if (['SUCCEED', 'SUCCEEDED', 'SUCCESS', 'COMPLETED', 'DONE', 'FINISHED'].includes(value)) {
    return { state: 'succeeded', raw };
  }
  if (
    [
      'FAILED',
      'FAIL',
      'FAILURE',
      'ERROR',
      'CANCELED',
      'CANCELLED',
      'REVOKED',
      'TIMEOUT',
      'UNKNOWN',
      'MODAL',
    ].includes(value)
  ) {
    return { state: 'failed', raw };
  }
  if (!raw) {
    const root = (parsed ?? {}) as Record<string, unknown>;
    const code = typeof root.code === 'string' ? root.code.trim() : '';
    if (code && typeof root.message === 'string' && root.message.trim()) {
      return { state: 'failed', raw: code };
    }
  }
  return { state: 'running', raw };
}

/** 任务失败时给用户看的原因（魔搭放在 `errors`，FisherAI 放在 `fail_reason`/`error.message`）。 */
export function channelTaskError(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const body = channelTaskEnvelope(parsed);
  for (const key of ['errors', 'fail_reason', 'failReason', 'failed_reason', 'message', 'error']) {
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

/**
 * Midjourney 收尾里的单图列表（`image_urls`，一个 Imagine 任务固定 4 张）。
 *
 * 为什么不用通用的 `collectResultRefs`：它会把 `grid_image_url`（四宫格大图）也当成一条结果，
 * 于是画布上多出一张 2×2 拼图，而它并不是用户要的「第 N 张」。这里只认 `image_urls`，
 * 拿到之后再按画布的「生成数量」截取（见 cloudGenerationRouter）。
 */
export function midjourneyImageUrls(parsed: unknown): string[] {
  const body = channelTaskEnvelope(parsed);
  const list = body.image_urls;
  if (!Array.isArray(list)) return [];
  return list
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
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
  const dialect = channelDialect(input.channel);
  const url =
    dialect === 'zhenzhen'
      ? `${baseUrl}${zhenzhenUploadPath(baseUrl)}`
      : `${baseUrl}${WORKFISHER_UPLOAD_PATH}`;
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
          ...(dialect === 'zhenzhen' ? { 'user-agent': CHANNEL_USER_AGENT } : {}),
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
