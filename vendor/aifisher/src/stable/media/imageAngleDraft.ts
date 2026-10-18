/**
 * 「角度 / 全景图」草稿节点（**整文件覆盖**，dsh-aifisher-canvas v1.38）。
 *
 * 上游这一份的唯一职责：在源图右边建一个 Image 节点、配好图生图参数、把源图连成参考图，
 * 然后**立刻** `handleGenerate`（那一步在 canvasApplication 里，补丁 3.8p 已去掉）。
 *
 * 这次改两件事：
 *   ① **模型不再写死**。上游是
 *        `IMAGE_MODELS.find(m => m.endpoint['image-to-image'].model === 'workfisher-image-g-v2.5-lowprice')`
 *      —— 也就是永远挑「GPT Image 2.5 · API 低价扩展版」那条 Relay 旧通道。本插件没有那条后端，
 *      用户点生成会 501；他自己的通道（魔搭 / Fisher / 任意 OpenAI 兼容端点）根本用不上。
 *      现在改成：**先问装配层的 `__FISHERAI_RESOLVE_IMAGE_TOOL_MODEL__`（与「扩图」同一套选择口径：
 *      用户通道里的图像模型优先）**，解析不到才退回目录里第一个能图生图的条目。
 *   ② 草稿仍然是「空节点 + 提示词/参数已填」，生成按钮留给用户点（3.8p 去掉了自动生成）。
 *
 * 注意：这个文件是覆盖文件，路径必须与 vendor 一致，否则构建直接报「vendor 里没有这个文件」。
 */
import { IMAGE_MODELS } from '../../config/modelConfig';
import type { CanvasNode } from '../nodes/canvasNodeOperations';
import { imageAngleDescription, normalizeImageAngle, type ImageAngle } from '../prompt/imageAngle';
export const panoramaPrompt = `基于参考图片重建同一场景，生成覆盖水平360度、垂直180度的完整球面全景等距柱状投影贴图。以原图主要内容为前方视线中心，向两侧和背后合理补全空间。整张画面承载完整经纬度范围，优先2:1展开；不要只生成宽幅风景、鱼眼图或多图拼版。左右边缘无缝连续，顶部天顶与底部地面自然闭合，避免接缝、断层、重复主体及局部拉伸。保持原图光照、材质、人物身份与画面风格，封闭空间保留合理出入口。不添加文字、水印、边框或界面。`;
type ModelEntry = (typeof IMAGE_MODELS)[number] & {
  cloudChannelId?: unknown;
  imageModes?: Array<{ value?: unknown }>;
};
const usable = (model: ModelEntry | undefined): model is ModelEntry =>
  Boolean(model) && (model!.imageModes ?? []).some((mode) => mode?.value === 'image-to-image');
/**
 * 这次草稿该用哪个模型（调用时解析，通道注册表是异步拉的）。
 *
 * 与 `src/canvas-ui/canvas/CanvasOutpaint.ts` 的 `resolveOutpaintModel()` 保持同一口径：
 * 通道模型优先（CloudChannelModels 装的合成条目带 cloudChannelId），再退回目录里第一个能图生图的。
 * 两份代码故意不互相 import —— vendor 覆盖文件不反向依赖 src（否则覆盖就失去「自包含」的意义）。
 */
export function draftImageModel(): ModelEntry | null {
  // ⚠️ 桥读写用 **window**（jsdom 里 globalThis 是另一个对象；见装配层 bootstrap 的注释）
  const bridge = (window as unknown as {
    __FISHERAI_RESOLVE_IMAGE_TOOL_MODEL__?: () => { name?: unknown } | null;
  }).__FISHERAI_RESOLVE_IMAGE_TOOL_MODEL__;
  if (typeof bridge === 'function') {
    try {
      const picked = bridge();
      const name = typeof picked?.name === 'string' ? picked.name : '';
      const match = (IMAGE_MODELS as ModelEntry[]).find((model) => model.name === name);
      if (usable(match)) return match;
    } catch {
      /* 桥坏了不能拦住建草稿，退回目录里第一个可用的 */
    }
  }
  const channel = (IMAGE_MODELS as ModelEntry[]).find(
    (model) => typeof model.cloudChannelId === 'string' && usable(model),
  );
  if (channel) return channel;
  return (IMAGE_MODELS as ModelEntry[]).find(usable) ?? null;
}
interface Runtime {
  create(type: string, point: { x: number; y: number }, projectId: string): CanvasNode;
  configure(nodes: CanvasNode[], id: string, patch: Partial<CanvasNode>): CanvasNode[];
  connect(nodes: CanvasNode[], sourceId: string, targetId: string): CanvasNode[];
  width(node: CanvasNode): number;
}
export function createImageAngleDraft(
  nodes: CanvasNode[],
  sourceId: string,
  angle: ImageAngle | null,
  projectId: string,
  runtime: Runtime,
) {
  const source = nodes.find((node) => node.id === sourceId);
  if (
    !source?.resultUrl ||
    !['Image', 'Upload Image'].includes(source.type) ||
    source.uploadPending
  )
    throw new Error('原图尚未准备好，请稍后重试。');
  const model = draftImageModel();
  if (!model) throw new Error('没有可用的图像模型：请先在「设置 → 闭源服务」里配置通道。');
  const aspectRatios = Array.isArray(model.aspectRatios) ? model.aspectRatios : [];
  /**
   * 目标比例必须落在**这个模型支持的比例表**里。
   *
   * 上游把全景写死 '2:1'、角度写死 source.aspectRatio/16:9 —— 那是照着 Relay 那条模型的
   * aspectRatios 写的。换成用户通道之后（合成条目的比例表只有 1:1 / 2:3 / 3:2 / 3:4 / 4:3 /
   * 9:16 / 16:9 / 21:9），'2:1' 不在表里，composer 的比例下拉会落到一个不存在的值上。
   * 所以这里按「首选 → 次选 → 表里第一个」降级，绝不塞一个模型不认的比例。
   */
  const pickRatio = (preferred: readonly string[], fallback: string) => {
    for (const ratio of preferred) if (aspectRatios.includes(ratio)) return ratio;
    return typeof aspectRatios[0] === 'string' ? aspectRatios[0] : fallback;
  };
  const modelRatio = angle
    ? pickRatio(
        [String(source.aspectRatio ?? ''), '16:9', '4:3', '1:1'],
        '16:9',
      )
    : // 2:1 等距柱状最理想；模型不认就挑**最接近 2.0** 的（16:9=1.78 比 21:9=2.33 更近），
      // 提示词里仍然写着「优先 2:1 展开」，这里是画布档位的妥协。
      pickRatio(['2:1', '16:9', '21:9', '3:2', '1:1'], '2:1');
  const settings = normalizeImageAngle(angle),
    description = imageAngleDescription(settings);
  const draft = runtime.create(
    'Image',
    { x: source.x + runtime.width(source) + 80, y: source.y },
    projectId,
  );
  const configured = runtime.configure([...nodes, draft], draft.id, {
    imageModel: model.name,
    imageMode: 'image-to-image',
    resolution: '1K',
    generateCount: 1,
    aspectRatio: modelRatio,
    title: angle ? `角度 · ${description.direction} · ${description.elevation}` : '全景图',
    prompt: angle ? '' : panoramaPrompt,
    imageAngle: angle ? settings : null,
    status: 'idle',
  });
  const connected = runtime.connect(configured, sourceId, draft.id);
  if (!connected.find((node) => node.id === draft.id)?.parentIds?.includes(sourceId))
    throw new Error('当前图像模型不支持参考图片，请先选择支持图生图的模型。');
  return { nodes: connected, id: draft.id };
}
