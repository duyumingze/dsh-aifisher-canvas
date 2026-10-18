/**
 * 「扩图」（outpaint）的纯逻辑（v1.38 引入，v1.39 改成「先出画面、再接生成」）。
 *
 * 用户原话（2026-10-17，v1.38）：「把这个功能移除，替换成扩图功能；还有一点，这里的功能
 * 点击生成后模型走的是之前的通道。做一个调整，点击生成后不直接生图，先输出一个空的图像生成
 * 节点，填好提示词，由我来点击最后的生成」。
 *
 * 用户原话（2026-10-17，v1.39，附两张参考图：一张是带「目标比例 / 原图位置 / 延展内容」的扩图面板，
 * 一张是画布上「原图 → 扩图画面 → 扩图 · 21:9」三张串起来的节点链）：
 * 「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」。
 *
 * 于是这一版把「点一下」拆成**两步、两张节点**：
 *   ① 先在浏览器里把原图画进一张**更大的画布**（目标比例、原图落在九宫格的哪一格），
 *      导出 PNG、落进素材库，画布上多一张真实图片节点 —— 标题就叫「扩图画面」；
 *   ② 再建一个**空的**图片生成节点（提示词已填好、模型 = 用户自己的通道模型），
 *      把「扩图画面」连成它的参考图。真正的生成仍由用户点节点上那个按钮。
 *
 * 为什么合成放在浏览器而不是 host：
 *   - 扩图画面只是「把原图摆到更大的透明画布上」，没有编解码的必要（host 半没有 sharp，
 *     走 ffmpeg 反而更慢、还多一次进程调用）；
 *   - 画布本来就要拿这张图的像素才能显示，浏览器已经解码过一次。
 *   host 侧只借用现成的「dataURL 落盘」接口（/media/images/annotation）把字节存进素材库，
 *   所以这一版**不动 host 半**（用户刷新画布页就生效，不用重启 DSH）。
 *
 * 三条口径（v1.38 定、v1.39 不变）：
 *   ① **不直接生图**：生成节点 `status` 保持未生成，一条 /generate-* 请求都不发；
 *   ② **模型跟着通道走**：优先选用户自己通道里勾过的图像模型（`cloudChannelId`），
 *      绝不写死上游目录里那些 Relay / RunningHub 条目（本插件没有那些后端，点了只回 501）；
 *   ③ **节点上看到什么就发什么**（v1.34）：扩图画面的目标比例写进提示词，不是空串、也不夹带别的东西。
 *
 * 这一份是**纯函数**：不碰 DOM、不建节点、不发请求。真正够得着 setNodes 的只有 vendor 的
 * canvasApplication（vendor 补丁 3.8p），真正画像素的只有装配层 bootstrap（`prepare()`）。
 * 三段分工与 v1.37 叠图切换（CanvasStack.ts）同一套。
 */
import { IMAGE_MODELS } from '../../../vendor/aifisher/src/config/modelConfig';

/** 画布节点在这些字段上是宽松对象；这里只钉我们要读写的键。 */
export interface OutpaintSource {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  resultUrl?: string;
  title?: string;
  aspectRatio?: string;
  /** 结果图的真实宽高比，形如 `427/240`（vendor 的 canvasGeneration 会写这个字段）。 */
  resultAspectRatio?: string;
  uploadPending?: boolean;
  status?: string;
  [key: string]: unknown;
}

/** 原图落在扩图画面的哪一格（九宫格，行优先）。 */
export type OutpaintAnchor =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

export interface OutpaintAnchorSpec {
  value: OutpaintAnchor;
  label: string;
  hint: string;
  /** 0 = 贴左/上，1 = 居中，2 = 贴右/下。 */
  col: 0 | 1 | 2;
  row: 0 | 1 | 2;
}

/**
 * 九宫格。顺序 = 面板上 3×3 的顺序（原图位置在哪个角/边，就往对面延展）。
 *
 * 为什么不再用「方向」那个 7 项枚举：参考图里的面板给的是**位置**（九宫格），
 * 位置能同时表达「往哪边延」和「原图摆在画面哪一侧」，而方向只能表达前者。
 * 两者是一一映射的（左列 = 向右扩、中列 = 左右都扩 …），这里只留位置这一套。
 */
export const OUTPAINT_ANCHORS: OutpaintAnchorSpec[] = [
  { value: 'top-left', label: '左上', hint: '原图贴左上角，向右下方延展', col: 0, row: 0 },
  { value: 'top', label: '上', hint: '原图贴上边，向左右与下方延展', col: 1, row: 0 },
  { value: 'top-right', label: '右上', hint: '原图贴右上角，向左下方延展', col: 2, row: 0 },
  { value: 'left', label: '左', hint: '原图贴左边，向右延展', col: 0, row: 1 },
  { value: 'center', label: '居中', hint: '原图居中，四周一起延展', col: 1, row: 1 },
  { value: 'right', label: '右', hint: '原图贴右边，向左延展', col: 2, row: 1 },
  { value: 'bottom-left', label: '左下', hint: '原图贴左下角，向右上方延展', col: 0, row: 2 },
  { value: 'bottom', label: '下', hint: '原图贴下边，向左右与上方延展', col: 1, row: 2 },
  { value: 'bottom-right', label: '右下', hint: '原图贴右下角，向左上方延展', col: 2, row: 2 },
];

export function anchorSpec(value: unknown): OutpaintAnchorSpec {
  return OUTPAINT_ANCHORS.find((item) => item.value === value) ?? OUTPAINT_ANCHORS[4];
}

export interface OutpaintOptions {
  ratio?: string;
  anchor?: OutpaintAnchor | string;
  /** 用户手写的「延展内容」（可空）：原样拼进提示词，不发请求、不改算法。 */
  content?: string;
}

/** 一张图最多扩到多大（再大就先整体缩，避免画布/上传被撑爆）。 */
export const OUTPAINT_MAX_SIDE = 4096;
/** 「扩图画面」节点的标题（参考图里就叫这个，用户一眼能认出哪张是底图）。 */
export const OUTPAINT_COMPOSITE_TITLE = '扩图画面';
/** 画布默认节点宽（vendor nodeFramework 的 DEFAULT_NODE_SIZES.image[0]），落点用。 */
export const OUTPAINT_NODE_WIDTH = 360;
/** 两张新节点之间的横向间距（与 v1.21「结果图摆在源节点右侧」同一套手感）。 */
export const OUTPAINT_NODE_GAP = 80;

/** 面板上先给的比例：顺序照参考图（两行、16:9 在第二行第一格）。 */
export const OUTPAINT_PREFERRED_RATIOS = [
  '1:1',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '16:9',
  '9:16',
  '21:9',
  '2:1',
];

interface ModelLike {
  name?: unknown;
  imageModes?: Array<{ value?: unknown; allowedInputs?: Record<string, unknown> }>;
  aspectRatios?: unknown;
  resolutions?: unknown;
  cloudChannelId?: unknown;
  [key: string]: unknown;
}

function imageModels(): ModelLike[] {
  return (IMAGE_MODELS as unknown as ModelLike[]) ?? [];
}

/** 这个条目能不能做图生图（扩图必须有参考图）。 */
export function supportsImageToImage(model: ModelLike | null | undefined): boolean {
  if (!model) return false;
  return (model.imageModes ?? []).some((mode) => mode?.value === 'image-to-image');
}

/**
 * 扩图要用哪个模型：**先用户自己通道里的**，再退回目录里第一个能图生图的。
 *
 * 为什么要先挑通道：CloudChannelModels 把通道模型 `splice(0,0,…)` 装在目录最前，并给每条
 * 合成条目打上 `cloudChannelId`。上游目录里那些 Relay / RunningHub 条目本插件**没有后端**，
 * 选中它们点生成只会 501 —— 这正是用户说的「模型走的是之前的通道」。
 *
 * 返回 null 表示一个能用的都没有（面板据此禁用「生成」并给出说明）。
 */
export function resolveOutpaintModel(): ModelLike | null {
  const all = imageModels();
  const channel = all.find(
    (model) => typeof model?.cloudChannelId === 'string' && supportsImageToImage(model),
  );
  if (channel) return channel;
  return all.find((model) => supportsImageToImage(model)) ?? null;
}

/** 模型名（发给画布节点的 `imageModel` 就是它）。 */
export function outpaintModelName(model: ModelLike | null = resolveOutpaintModel()): string | null {
  const name = model?.name;
  return typeof name === 'string' && name.trim() ? name : null;
}

/** 目标比例候选：模型支持的 ∩ 首选顺序；一个都没有就把首选顺序当兜底。 */
export function outpaintRatios(model: ModelLike | null = resolveOutpaintModel()): string[] {
  const supported = Array.isArray(model?.aspectRatios)
    ? (model.aspectRatios as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const preferred = supported.length
    ? OUTPAINT_PREFERRED_RATIOS.filter((ratio) => supported.includes(ratio))
    : [];
  const rest = supported.filter((ratio) => !preferred.includes(ratio));
  const list = [...preferred, ...rest];
  return list.length ? list : [...OUTPAINT_PREFERRED_RATIOS];
}

/** 默认比例：面板打开时预选的那个（16:9 优先，否则第一个）。 */
export function defaultOutpaintRatio(model: ModelLike | null = resolveOutpaintModel()): string {
  const ratios = outpaintRatios(model);
  return ratios.includes('16:9') ? '16:9' : ratios[0];
}

/** `16:9` / `16/9` / `16x9` → 1.777…；解析不到返回 0（调用方自己兜底）。 */
export function outpaintRatioValue(ratio: unknown): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(ratio ?? ''));
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > 0 && height > 0 && Number.isFinite(width / height)) return width / height;
  }
  return 0;
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export interface OutpaintGeometry {
  /** 扩图画面（合成后的画布）像素尺寸。 */
  width: number;
  height: number;
  /** 原图画进画布后的像素尺寸（受 4096 上限影响时会等比缩小）。 */
  imageWidth: number;
  imageHeight: number;
  offsetX: number;
  offsetY: number;
  /** 四个方向各有多少像素是新画面（0 = 这一侧不用扩）。 */
  pad: { left: number; right: number; top: number; bottom: number };
  ratio: string;
  /** 原图被缩小的倍数（≤1，1 = 原像素）。 */
  scale: number;
}

/**
 * 算出「扩图画面」的画布尺寸与原图落点。
 *
 * 只朝一个方向长：目标比例比原图宽 → 高度不变、把宽度补到 `原高 × 比例`；
 * 反之宽度不变、把高度补到 `原宽 ÷ 比例`。这样**原图一个像素都不用重采样放大**，
 * 也永远不会出现「为了凑比例先把原图裁掉一块」——用户要的是延展、不是重构图。
 * 超过 OUTPAINT_MAX_SIDE 才整体等比缩小（缩的是画布，不是裁原图）。
 */
export function outpaintGeometry(input: {
  width: number;
  height: number;
  ratio?: string;
  anchor?: string;
}): OutpaintGeometry {
  const sourceWidth = Math.max(1, Math.round(finite(input.width, 1)));
  const sourceHeight = Math.max(1, Math.round(finite(input.height, 1)));
  const aspect = sourceWidth / sourceHeight;
  const target = outpaintRatioValue(input.ratio) || aspect;
  const spec = anchorSpec(input.anchor);
  let width = sourceWidth;
  let height = sourceHeight;
  if (target > aspect + 1e-6) width = Math.round(sourceHeight * target);
  else if (target < aspect - 1e-6) height = Math.round(sourceWidth / target);
  let scale = 1;
  const longest = Math.max(width, height);
  if (longest > OUTPAINT_MAX_SIDE) {
    scale = OUTPAINT_MAX_SIDE / longest;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  const imageWidth = Math.min(width, Math.max(1, Math.round(sourceWidth * scale)));
  const imageHeight = Math.min(height, Math.max(1, Math.round(sourceHeight * scale)));
  const offsetX = Math.max(
    0,
    spec.col === 0 ? 0 : spec.col === 1 ? Math.floor((width - imageWidth) / 2) : width - imageWidth,
  );
  const offsetY = Math.max(
    0,
    spec.row === 0 ? 0 : spec.row === 1 ? Math.floor((height - imageHeight) / 2) : height - imageHeight,
  );
  return {
    width,
    height,
    imageWidth,
    imageHeight,
    offsetX,
    offsetY,
    pad: {
      left: offsetX,
      right: Math.max(0, width - imageWidth - offsetX),
      top: offsetY,
      bottom: Math.max(0, height - imageHeight - offsetY),
    },
    ratio: String(input.ratio ?? ''),
    scale,
  };
}

/**
 * 原图的「宽高比」读数（面板预览用）：优先 `resultAspectRatio`（真实像素，形如 `427/240`），
 * 退 `aspectRatio`（`4:3`），再退回 16:9。
 *
 * `exact` 表示这两个数**是原图像素**（面板上可以照实写「1470 × 630」），
 * 为 false 时只是比例（面板只写目标画幅，不编像素数）。
 */
export function outpaintSourceSize(source: OutpaintSource | null | undefined): {
  width: number;
  height: number;
  exact: boolean;
} {
  const direct = /^\s*(\d+(?:\.\d+)?)\s*[/x×:]\s*(\d+(?:\.\d+)?)\s*$/.exec(
    String(source?.resultAspectRatio ?? ''),
  );
  if (direct) {
    const width = Number(direct[1]);
    const height = Number(direct[2]);
    // 太小的一律当比例（`4/3` 这种是上游拿比例写进 resultAspectRatio 的老数据，不是像素）。
    if (width >= 32 && height >= 32) return { width, height, exact: true };
    if (width > 0 && height > 0) {
      return { width: Math.round((1000 * width) / height), height: 1000, exact: false };
    }
  }
  const ratio = outpaintRatioValue(source?.aspectRatio);
  if (ratio > 0) return { width: Math.round(1000 * ratio), height: 1000, exact: false };
  return { width: 16, height: 9, exact: false };
}

/** 「向哪边延展」那句话（提示词用，由 pad 反推，不依赖 anchor 标签）。 */
function extendPhrase(pad: OutpaintGeometry['pad']): string {
  const left = pad.left > 0;
  const right = pad.right > 0;
  const top = pad.top > 0;
  const bottom = pad.bottom > 0;
  if (left && right && top && bottom) return '向四周';
  if (left && right) return '向左右两侧';
  if (top && bottom) return '向上下两侧';
  const sides = [top && '上方', bottom && '下方', left && '左侧', right && '右侧'].filter(
    (side): side is string => Boolean(side),
  );
  return sides.length ? `只向画面${sides.join('与')}` : '向四周';
}

/**
 * 提示词：一句能直接看懂的中文，不说黑话、也不引用任何内部字段。
 *
 * 四个约束写进去是因为图生图端点**不会**替我们记住它们：
 *   ① 参考图就是「扩图画面」：中间是原图、留白是要补的新画面（透明 = 还没画的内容）；
 *   ② 只延展、不重绘原内容（否则扩图会变成「重画一张」）；
 *   ③ 新区域与原图无缝衔接、光照/风格一致；
 *   ④ 目标比例明确（端点的 `size` 只吃比例，文字里再写一遍更稳）。
 */
export function outpaintPrompt(geometry: OutpaintGeometry, ratio: string, content?: string): string {
  const target = String(ratio || geometry.ratio || '').trim() || '目标';
  const extra = typeof content === 'string' ? content.trim() : '';
  return [
    `基于参考图向外扩图：参考图是一张已经按 ${target} 画幅铺好的「扩图画面」，原图内容保持不变，原图以外的留白区域需要补全。`,
    `${extendPhrase(geometry.pad)}延展画面，补全自然连贯的环境与细节；新生成的区域要与原图无缝衔接，光照方向、色彩与画面风格保持一致，看不出接缝。`,
    extra ? `补全内容：${extra}` : '',
    `目标画幅比例 ${target}，输出完整画面，不添加文字、水印或边框。`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 生成节点标题（卡上一眼能认出这是哪一版扩图）。 */
export function outpaintTitle(ratio: string): string {
  return `扩图 · ${String(ratio || '').trim()}`;
}

/** 扩图源图的校验（面板/装配层复用同一份中文文案）。 */
export function assertOutpaintSource(source: OutpaintSource | null | undefined): void {
  if (!source || typeof source.id !== 'string' || !source.id) {
    throw new Error('找不到这张图片，请刷新后重试。');
  }
  if (!['Image', 'Upload Image'].includes(String(source.type))) {
    throw new Error('只有图片节点可以扩图。');
  }
  if (!source.resultUrl) throw new Error('这张图片还没有结果，先等它生成完成。');
  if (source.uploadPending) throw new Error('图片还在上传，稍后再试。');
  if (String(source.status) === 'loading') throw new Error('图片还在生成，稍后再试。');
}

export interface OutpaintPlan {
  ratio: string;
  anchor: OutpaintAnchorSpec;
  model: string;
  geometry: OutpaintGeometry;
  prompt: string;
  /** 「扩图画面」节点字段（不含 resultUrl：地址要等素材库落盘之后才有）。 */
  compositePatch: Record<string, unknown>;
  /** 生成节点字段（空图、提示词已填、模型 = 通道模型、状态 idle）。 */
  draftPatch: Record<string, unknown>;
  positions: { composite: { x: number; y: number }; draft: { x: number; y: number } };
}

/**
 * 算出「点一下扩图」要落下的**两张**节点。
 *
 * 它**只是数据**：不建节点、不画像素、不发请求（那些分别在装配层与 vendor 补丁里）。
 * 校验失败直接抛中文错误 —— 面板把它原样显示给用户。
 */
export function buildOutpaintPlan(
  source: OutpaintSource,
  options: OutpaintOptions = {},
  geometry: OutpaintGeometry = outpaintGeometry({
    width: 16,
    height: 9,
    ratio: options.ratio,
    anchor: options.anchor,
  }),
): OutpaintPlan {
  assertOutpaintSource(source);
  const model = resolveOutpaintModel();
  const modelName = outpaintModelName(model);
  if (!modelName) {
    throw new Error('没有可用的图像模型：请先在「设置 → 闭源服务」里配一条通道并勾选图像模型。');
  }
  const ratios = outpaintRatios(model);
  const ratio =
    String(options.ratio ?? '') && ratios.includes(String(options.ratio))
      ? String(options.ratio)
      : defaultOutpaintRatio(model);
  const anchor = anchorSpec(options.anchor);
  const prompt = outpaintPrompt(geometry, ratio, options.content);
  const sourceWidth = Math.max(160, finite(source.width, OUTPAINT_NODE_WIDTH));
  const baseX = finite(source.x, 0);
  const baseY = finite(source.y, 0);
  const compositeX = baseX + sourceWidth + OUTPAINT_NODE_GAP;
  return {
    ratio,
    anchor,
    model: modelName,
    geometry,
    prompt,
    compositePatch: {
      title: OUTPAINT_COMPOSITE_TITLE,
      status: 'success',
      model: 'Upload',
      prompt: '',
      aspectRatio: ratio,
      resultAspectRatio: `${geometry.width}/${geometry.height}`,
      resolution: '1K',
    },
    draftPatch: {
      imageModel: modelName,
      imageMode: 'image-to-image',
      resolution: '1K',
      aspectRatio: ratio,
      generateCount: 1,
      title: outpaintTitle(ratio),
      prompt,
      // 关键：草稿是「还没生成」的状态。用户自己点节点上的生成才会真的发请求。
      status: 'idle',
      errorMessage: undefined,
      generationAttemptId: undefined,
      generationStartTime: undefined,
      resultUrl: undefined,
      resultUrls: undefined,
    },
    positions: {
      composite: { x: compositeX, y: baseY },
      draft: { x: compositeX + OUTPAINT_NODE_WIDTH + OUTPAINT_NODE_GAP, y: baseY },
    },
  };
}

/** 面板/排查用读数（真机上「点了没反应」时先看这里）。 */
export function outpaintReport(): Record<string, unknown> {
  const model = resolveOutpaintModel();
  return {
    model: outpaintModelName(model),
    channelModel: Boolean(model?.cloudChannelId),
    ratios: outpaintRatios(model),
    anchors: OUTPAINT_ANCHORS.map((item) => item.value),
    preferredRatios: [...OUTPAINT_PREFERRED_RATIOS],
    maxSide: OUTPAINT_MAX_SIDE,
    bridge: Boolean(
      (window as unknown as { __FISHERAI_OUTPAINT__?: unknown }).__FISHERAI_OUTPAINT__,
    ),
  };
}
