/**
 * MiniMax H3 本地音视频工作流：动态组装 handler（host 半）
 *
 * 移植自 AIFISHER:
 *   server/comfyui/workflows/MiniMax-H3-T2VA.js   （prepareMiniMaxH3T2VAWorkflow / 节点改写）
 *   server/comfyui/comfyWorkflowRouter.js         （normalizeRequest / ComfyWorkflowError）
 *
 * 这里只搬「校验参数 → 按参数改写模板图」两步，产出可直接提交给 ComfyUI /prompt 的 API 格式图。
 * 排队执行、等结果、把结果落到素材库**不在**本模块：上游那一段依赖 projectId + library 目录 +
 * 视频格式白名单，本插件没有素材库，所以执行交给上层（POST /api/comfy/run 或画布自己的执行通道）。
 *
 * 与上游的两处刻意差异（适配本插件，不改上游的行为语义）：
 *   1. 模板 JSON 目录不再来自 RUNTIME_PATHS.SERVER_DIR，改用 workflowRegistry.loadWorkflowTemplate()
 *      （由它用 import.meta.url 推导模块目录 + 候选目录找文件）；
 *   2. 参考素材上传走 comfyClient.uploadImageUrl(url)：上游是 comfyClient.uploadImage(url)，
 *      语义完全一样（传 URL → 后端取字节 → 上传到 ComfyUI → 拿回落盘文件名），
 *      只是本插件的 comfyClient 把「内存字节」和「远程 URL」拆成了两个方法。
 */
import { ComfyWorkflowError, loadWorkflowTemplate } from '../workflowRegistry';

/** 注册表 id（必须与 workflowRegistry.ts 里的键一致）。 */
const WORKFLOW_ID = 'minimax-h3-t2va';

/** MiniMax H3 条件节点：task_type、首尾帧、参考素材都写在它的 inputs 上。 */
const CONDITIONING_NODE = '307';

/**
 * 本工作流支持的模式。
 * 与 workflowRegistry 里那条 `modes` 是同一份信息 —— 上游也是两处各写一份
 * （comfyWorkflowRouter.js 的 MINIMAX_MODES 与本文件同名的 MINIMAX_H3_MODES），
 * 这里的用途是：给 handler 的入参一个精确联合类型，并在直接调用（绕过路由）时兜底校验。
 */
export const MINIMAX_H3_MODES = ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'] as const;

export type MiniMaxH3Mode = (typeof MINIMAX_H3_MODES)[number];

const MODE_SET: ReadonlySet<string> = new Set(MINIMAX_H3_MODES);

/** 画面比例 → ResolutionSelector 节点的枚举值（照上游 1:1）。 */
const ASPECT_RATIO_LABELS: Readonly<Record<string, string>> = Object.freeze({
  '1:1': '1:1 (Square)',
  '2:3': '2:3 (Portrait Photo)',
  '3:2': '3:2 (Photo)',
  '3:4': '3:4 (Portrait Standard)',
  '4:3': '4:3 (Standard)',
  '9:16': '9:16 (Portrait Widescreen)',
  '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
});

/** 参数校验用的比例白名单（与上面的映射表同源，避免两处漂移）。 */
const ASPECT_RATIOS: ReadonlySet<string> = new Set(Object.keys(ASPECT_RATIO_LABELS));

/** 画布模式 → 条件节点的 task_type 枚举。 */
const TASK_TYPES: Readonly<Record<MiniMaxH3Mode, string>> = Object.freeze({
  t2va: 'T2VA',
  i2va: 'I2VA',
  fl2va: 'FL2VA',
  l2va: 'L2VA',
  ref2va: 'Ref2VA',
});

/** 参考素材数量上限（照上游）。 */
const MAX_REFERENCES = Object.freeze({ image: 9, video: 3, audio: 3 });

/**
 * 运行时追加的素材节点 id，与模板固有的 17 个节点不冲突。
 * 图片 330+ / 视频 340+ / 音频 350+，逐个叠加。
 */
const NODE_IDS = Object.freeze({
  firstFrame: '320',
  lastFrame: '321',
  refImage: (index: number) => String(330 + index),
  refVideo: (index: number) => String(340 + index),
  refAudio: (index: number) => String(350 + index),
});

/** ComfyUI API 格式里的一条连线：[来源节点 id, 输出序号]。 */
type NodeRef = [string, number];

/** ComfyUI API 格式的节点。inputs 是开放的：不同 class_type 的字段差别很大。 */
export interface PromptNode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: { title?: string };
}

/** ComfyUI API 格式的完整 prompt 图：节点 id → 节点。 */
export type PromptGraph = Record<string, PromptNode>;

/**
 * 组装阶段真正用到的最小客户端接口。
 * 只声明用到的能力，既让 handler 能拿真 comfyClient（结构上兼容）调用，
 * 也让测试替身不必伪造整个 ComfyClient。
 */
export interface ReferenceUploader {
  uploadImageUrl(url: string, filename?: string): Promise<{ name: string }>;
}

/** 交给 handler 的调用参数（= normalizeMiniMaxH3Params 的输出）。 */
export interface MiniMaxH3Params {
  text: string;
  mode: MiniMaxH3Mode;
  aspectRatio: string;
  megapixels: number;
  duration: number;
  seed?: number;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
}

/**
 * 提示词里的素材引用统一成 MiniMax H3 认识的尖括号标记。
 * 画布上用户会写 @图片1 / {image 1} / image 1 等好几种写法，模型只认 <Picture 1>。
 */
export function canonicalizeMiniMaxH3Mentions(text: unknown): string {
  return String(text || '')
    .replace(/@图片\s*(\d+)/gi, '<Picture $1>')
    .replace(/\{image\s*(\d+)\}/gi, '<Picture $1>')
    .replace(/\bimage\s+(\d+)\b/gi, '<Picture $1>')
    .replace(/\bvideo\s+(\d+)\b/gi, '<Video $1>')
    .replace(/\{video\s*(\d+)\}/gi, '<Video $1>')
    .replace(/@视频\s*(\d+)/gi, '<Video $1>')
    .replace(/\baudio\s+(\d+)\b/gi, '<Audio $1>')
    .replace(/\{audio\s*(\d+)\}/gi, '<Audio $1>')
    .replace(/@音频\s*(\d+)/gi, '<Audio $1>');
}

/** 读到有限数就用它，否则退回 fallback（上游 numberOr 的 TS 版）。 */
function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 上游的 uniqueUrls：去空、去重、截断到上限。 */
function uniqueUrls(values: unknown, maximum: number): string[] {
  const list = Array.isArray(values) ? values : [];
  return [...new Set(list.filter((item): item is string => typeof item === 'string' && item !== ''))]
    .slice(0, maximum);
}

/** 把一段内存素材上传到 ComfyUI，返回落盘文件名（LoadImage/LoadAudio/VHS_LoadVideo 认的就是它）。 */
async function uploadReference(
  client: ReferenceUploader,
  url: string,
): Promise<string> {
  const uploaded = await client.uploadImageUrl(url);
  return uploaded.name;
}

/** 追加一个 LoadImage 节点（首尾帧 / 参考图片都用它）。 */
async function addLoadImage(
  workflow: PromptGraph,
  client: ReferenceUploader,
  nodeId: string,
  url: string,
  title: string,
): Promise<NodeRef> {
  const image = await uploadReference(client, url);
  workflow[nodeId] = {
    inputs: { image },
    class_type: 'LoadImage',
    _meta: { title },
  };
  return [nodeId, 0];
}

/** 追加一个 LoadAudio 节点（参考音频）。 */
async function addLoadAudio(
  workflow: PromptGraph,
  client: ReferenceUploader,
  nodeId: string,
  url: string,
  title: string,
): Promise<NodeRef> {
  const audio = await uploadReference(client, url);
  workflow[nodeId] = {
    inputs: { audio },
    class_type: 'LoadAudio',
    _meta: { title },
  };
  return [nodeId, 0];
}

/**
 * 追加一个 VHS_LoadVideo 节点（参考视频）。
 * 返回两个输出口：视频当参考图用，音轨另接一路（MiniMax H3 的参考视频要能带上原声）。
 */
async function addLoadVideo(
  workflow: PromptGraph,
  client: ReferenceUploader,
  nodeId: string,
  url: string,
  title: string,
): Promise<{ images: NodeRef; audio: NodeRef }> {
  const video = await uploadReference(client, url);
  workflow[nodeId] = {
    inputs: {
      video,
      force_rate: 0,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
    class_type: 'VHS_LoadVideo',
    _meta: { title },
  };
  // 输出序号按 ComfyUI object_info 核对：0=IMAGE，1=frame_count，2=AUDIO，3=video_info。
  return { images: [nodeId, 0], audio: [nodeId, 2] };
}

/** 汇总本次要用的参考素材（照上游：ref*Urls 别名 + 兼容老字段 imageUrl）。 */
function referenceUrls(params: MiniMaxH3Params): {
  images: string[];
  videos: string[];
  audios: string[];
} {
  return {
    images: uniqueUrls(params.referenceImageUrls, MAX_REFERENCES.image),
    videos: uniqueUrls(params.referenceVideoUrls, MAX_REFERENCES.video),
    audios: uniqueUrls(params.referenceAudioUrls, MAX_REFERENCES.audio),
  };
}

/** i2va / l2va / fl2va：把首帧、尾帧接到条件节点的 first_frame / last_frame。 */
async function configureKeyframes(
  workflow: PromptGraph,
  client: ReferenceUploader,
  params: MiniMaxH3Params,
  mode: MiniMaxH3Mode,
): Promise<void> {
  const conditioning = workflow[CONDITIONING_NODE].inputs;
  // normalizeMiniMaxH3Params 已经把 imageUrl 折进 firstFrameUrl/lastFrameUrl，
  // 所以这里不必再兜一层 params.imageUrl（上游那句兜底在路由之后永远走不到）。
  const firstFrameUrl = params.firstFrameUrl ?? null;
  const lastFrameUrl = params.lastFrameUrl ?? null;

  if ((mode === 'i2va' || mode === 'fl2va') && firstFrameUrl) {
    conditioning.first_frame = await addLoadImage(
      workflow, client, NODE_IDS.firstFrame, firstFrameUrl, 'AIFISHER 首帧',
    );
  }
  if ((mode === 'l2va' || mode === 'fl2va') && lastFrameUrl) {
    conditioning.last_frame = await addLoadImage(
      workflow, client, NODE_IDS.lastFrame, lastFrameUrl, 'AIFISHER 尾帧',
    );
  }
}

/** ref2va：把参考图片 / 视频 / 音频挂到条件节点的 Autogrow 动态输入上。 */
async function configureReferences(
  workflow: PromptGraph,
  client: ReferenceUploader,
  params: MiniMaxH3Params,
): Promise<void> {
  const conditioning = workflow[CONDITIONING_NODE].inputs;
  const references = referenceUrls(params);

  // 这些是 Autogrow 动态输入，键名必须是「父名.子名」形式；
  // 写成别的形式不会报错，只会被静默丢弃。
  for (const [index, url] of references.images.entries()) {
    conditioning[`ref_images.ref_image_${index}`] = await addLoadImage(
      workflow, client, NODE_IDS.refImage(index), url, `AIFISHER 参考图片 ${index + 1}`,
    );
  }
  for (const [index, url] of references.videos.entries()) {
    const loaded = await addLoadVideo(
      workflow, client, NODE_IDS.refVideo(index), url, `AIFISHER 参考视频 ${index + 1}`,
    );
    conditioning[`ref_videos.ref_video_${index}`] = loaded.images;
    conditioning[`ref_video_audios.ref_video_audio_${index}`] = loaded.audio;
  }
  for (const [index, url] of references.audios.entries()) {
    conditioning[`ref_audios.ref_audio_${index}`] = await addLoadAudio(
      workflow, client, NODE_IDS.refAudio(index), url, `AIFISHER 参考音频 ${index + 1}`,
    );
  }
}

/** 必填文本：非空字符串 + 长度上限（照上游 normalizeText）。 */
function normalizeText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    throw new ComfyWorkflowError(`${label}无效`);
  }
  return value.trim();
}

/** 区间数值（照上游 normalizeNumber）。 */
function normalizeNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new ComfyWorkflowError(`${label}无效`);
  }
  return number;
}

/**
 * 素材地址校验。
 * 上游这里会调 assertProjectMedia：把 `/library/media/<projectId>/...` 解析成本机文件路径，
 * 校验「属于当前项目 + 文件真的存在」。本插件没有素材库（媒体上传/落盘还没移植），
 * 所以只做「非空字符串」这一层；真正的可达性由上传那一步（fetch）报错。
 */
function assertMediaUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ComfyWorkflowError(`${label}无效`);
  }
  return value.trim();
}

/** 可选素材地址。 */
function optionalMediaUrl(value: unknown, label: string): string | undefined {
  if (value == null || value === '') return undefined;
  return assertMediaUrl(value, label);
}

/** 素材列表：最多 maximum 个、去重、每个都校验（照上游 normalizeMediaList）。 */
function normalizeMediaList(value: unknown, maximum: number, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ComfyWorkflowError(`${label}最多支持 ${maximum} 个`);
  }
  return [...new Set(value.map((url, index) => assertMediaUrl(url, `${label}${index + 1}`)))];
}

/** 非空字符串取值（`||` 的 unknown 版，避免把 0/'' 之外的东西当字符串用）。 */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * 校验并归一化调用方参数（移植上游 normalizeRequest）。
 * 与上游的差异：projectId / nodeId 不接收 —— 它们只用于把结果素材写进素材库，本插件没有素材库。
 */
export function normalizeMiniMaxH3Params(body: unknown): MiniMaxH3Params {
  const raw = (body ?? {}) as Record<string, unknown>;

  const aspectRatio = String(raw.aspectRatio || '16:9');
  if (!ASPECT_RATIOS.has(aspectRatio)) {
    throw new ComfyWorkflowError('视频画面比例无效');
  }

  // 没写 mode 时：给了图就当参考模式，否则纯文生（照上游）。
  const imageUrl = firstString(raw.imageUrl);
  const mode = String(raw.mode || (imageUrl ? 'ref2va' : 't2va')).toLowerCase();
  if (!MODE_SET.has(mode)) {
    throw new ComfyWorkflowError('MiniMax H3 生成模式无效');
  }
  const typedMode = mode as MiniMaxH3Mode;

  // 兼容上游的 imageUrl 简写：i2va 当首帧、l2va 当尾帧、ref2va 当第一张参考图。
  const firstFrameUrl = optionalMediaUrl(
    firstString(raw.firstFrameUrl, typedMode === 'i2va' ? imageUrl : null),
    '首帧图片',
  );
  const lastFrameUrl = optionalMediaUrl(
    firstString(raw.lastFrameUrl, typedMode === 'l2va' ? imageUrl : null),
    '尾帧图片',
  );
  const legacyReference = typedMode === 'ref2va' && imageUrl ? [imageUrl] : [];
  const referenceImageUrls = normalizeMediaList(
    raw.referenceImageUrls ?? (legacyReference.length ? legacyReference : null),
    MAX_REFERENCES.image,
    '参考图片',
  );
  const referenceVideoUrls = normalizeMediaList(raw.referenceVideoUrls, MAX_REFERENCES.video, '参考视频');
  const referenceAudioUrls = normalizeMediaList(raw.referenceAudioUrls, MAX_REFERENCES.audio, '参考音频');

  // 模式必填项（错误文案照上游，前端按文案直接展示）。
  if (typedMode === 'i2va' && !firstFrameUrl) {
    throw new ComfyWorkflowError('首帧模式需要连接一张首帧图片');
  }
  if (typedMode === 'fl2va' && (!firstFrameUrl || !lastFrameUrl)) {
    throw new ComfyWorkflowError('首尾帧模式需要同时连接首帧和尾帧图片');
  }
  if (typedMode === 'l2va' && !lastFrameUrl) {
    throw new ComfyWorkflowError('尾帧模式需要连接一张尾帧图片');
  }
  if (
    typedMode === 'ref2va'
    && referenceImageUrls.length + referenceVideoUrls.length + referenceAudioUrls.length === 0
  ) {
    throw new ComfyWorkflowError('参考模式至少需要连接一个图片、视频或音频素材');
  }

  const seed = normalizeSeed(raw.seed);

  return {
    text: normalizeText(raw.text, '视频提示词', 20_000),
    mode: typedMode,
    ...(firstFrameUrl ? { firstFrameUrl } : {}),
    ...(lastFrameUrl ? { lastFrameUrl } : {}),
    ...(referenceImageUrls.length ? { referenceImageUrls } : {}),
    ...(referenceVideoUrls.length ? { referenceVideoUrls } : {}),
    ...(referenceAudioUrls.length ? { referenceAudioUrls } : {}),
    aspectRatio,
    megapixels: normalizeNumber(raw.megapixels ?? 0.4, '视频像素规模', 0.1, 2),
    duration: normalizeNumber(raw.duration ?? 8, '视频时长', 1, 60),
    ...(seed === undefined ? {} : { seed }),
  };
}

/** 随机种子：不传就交给 handler 随机；传了必须是 [-1, 0xffffffff] 的整数（照上游 withSeed）。 */
function normalizeSeed(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < -1 || seed > 0xffffffff) {
    throw new ComfyWorkflowError('随机种子无效');
  }
  return seed;
}

/**
 * 组装 MiniMax H3 工作流（移植上游 prepareMiniMaxH3T2VAWorkflow）。
 *
 * @param client 上传参考素材用的客户端（真实现是 createComfyClient() 的返回值）
 * @param params 已经过 normalizeMiniMaxH3Params 的参数
 * @returns ComfyUI API 格式的 prompt 图，可直接作为 /api/comfy/run 的 workflow
 */
export async function prepareMiniMaxH3T2VAWorkflow(
  client: ReferenceUploader,
  params: MiniMaxH3Params,
): Promise<PromptGraph> {
  const template = await loadWorkflowTemplate(WORKFLOW_ID);
  if (!template) {
    throw new ComfyWorkflowError(`工作流模板缺失：${WORKFLOW_ID}`, 500, 'TEMPLATE_MISSING');
  }
  // loadWorkflowTemplate 每次都是 readFile + JSON.parse，给的是全新对象；
  // 下面的改写是就地修改，绝不能让多个请求共用同一份模板实例。
  const workflow = template as unknown as PromptGraph;

  // 路由已经校验过 mode；这里再挡一次是给「直接 import 本函数」的调用方兜底（照上游）。
  const mode: MiniMaxH3Mode = MODE_SET.has(params.mode) ? params.mode : 't2va';

  workflow['234'].inputs.value = canonicalizeMiniMaxH3Mentions(params.text);

  const resolution = workflow['235'].inputs;
  resolution.aspect_ratio = ASPECT_RATIO_LABELS[params.aspectRatio] ?? ASPECT_RATIO_LABELS['16:9'];
  resolution.megapixels = numberOr(params.megapixels, numberOr(resolution.megapixels, 0.4));
  workflow['236'].inputs.value = numberOr(params.duration, numberOr(workflow['236'].inputs.value, 8));

  // 画布用 -1 表示随机种子。
  const seed = numberOr(params.seed, -1);
  workflow['306'].inputs.noise_seed = seed >= 0 ? seed : Math.floor(Math.random() * 4294967296);

  workflow[CONDITIONING_NODE].inputs.task_type = TASK_TYPES[mode];

  if (mode === 'ref2va') await configureReferences(workflow, client, params);
  else await configureKeyframes(workflow, client, params, mode);

  return workflow;
}
