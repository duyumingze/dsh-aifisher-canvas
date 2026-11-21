/**
 * 图层文档（图层拆分的结果）在**画布侧**的形态与工具。
 *
 * 背景（用户 2026-11-21 报障）：「接入调色节点后它的图层混合方式不对，顺序也不对，
 * 我想要走的是通过混合节点的方式来混合，并且保留正确的位置」。
 *
 * 三条结论定了这里的形状：
 *   ① **位置不能丢**。上游回的每一层都是「元素区域按统一倍数放大后的裁片」
 *      （实测 bbox 588×220 的图层 PNG 是 1062×397，两个方向都 1.806 倍），
 *      贴回文档的正确做法是按 bbox 矩形**缩放**贴 —— 用 PIL 对真机回执做过四种假设的像素对比，
 *      这种假设与原图最接近（平均通道差 17.6，其余 26.7 / 27.2）。
 *      所以 host 把 `boundingBox.absolute` 一起带下来（见 cloudChannels.layerStackOf）。
 *   ② **顺序按 zindex**（0 = 底图 = 最下层），合成从下往上叠。
 *   ③ 主画布上只该看见**一个**节点（用户原话「这样拆分出来的图堆叠的形式不好看，就做成一个psd节点」），
 *      所以图层文档挂在节点的 `layerStack` 字段上，节点本身只显示一张扁平合成图。
 *
 * 这里的 flatten 就是那张「扁平合成图」：按位置把各层画到文档尺寸的画布上，再落进素材库。
 * 没有 2D 画布的环境（jsdom）回 `{ ok: false }`，调用方退回用底图充当预览。
 *
 * 另外还有 `downloadLayerStackPsd`：把同一份图层文档写成真的 .psd（见 psdWriter.ts），
 * 用户拿到就能丢进 Photoshop 继续做（用户 2026-11-21：「psd节点可以下载导入ps里」）。
 */
import { buildPsd, psdFileName, savePsd, type PsdLayerInput } from './psdWriter';

/**
 * 与 host 的 `LayerStack` 严格同形（画布节点上存的就是它，host 在 `/generate-image`
 * 的回执里随 `layerStack` 下发；座标是**文档像素**，不是归一化值）。
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
  width: number;
  height: number;
  layers: LayerStackLayer[];
}

/** 按 zindex 从下往上排（底图在最前）。 */
export function sortedLayers(stack: LayerStack | null | undefined): LayerStackLayer[] {
  if (!stack || !Array.isArray(stack.layers)) return [];
  return [...stack.layers].sort((a, b) => (a.zindex ?? 0) - (b.zindex ?? 0));
}

/** 校验 + 归一：节点上存的是宽松对象，读的时候要挡掉坏数据。 */
export function normalizeLayerStack(value: unknown): LayerStack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const width = Number(record.width);
  const height = Number(record.height);
  const rawLayers = Array.isArray(record.layers) ? record.layers : [];
  if (!(width > 0) || !(height > 0) || !rawLayers.length) return null;
  const layers: LayerStackLayer[] = [];
  for (const raw of rawLayers) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!url) continue;
    const x = Number(item.x);
    const y = Number(item.y);
    const w = Number(item.width);
    const h = Number(item.height);
    layers.push({
      url,
      ...(typeof item.name === 'string' && item.name ? { name: item.name } : {}),
      zindex: Number.isFinite(Number(item.zindex)) ? Number(item.zindex) : layers.length,
      x: Number.isFinite(x) ? Math.max(0, Math.min(width, x)) : 0,
      y: Number.isFinite(y) ? Math.max(0, Math.min(height, y)) : 0,
      width: Number.isFinite(w) && w > 0 ? Math.min(width, w) : width,
      height: Number.isFinite(h) && h > 0 ? Math.min(height, h) : height,
    });
  }
  if (!layers.length) return null;
  return { width: Math.round(width), height: Math.round(height), layers };
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** 扁平合成图上传（与本插件其它落盘走同一条「标注」路由）。 */
async function uploadPng(projectId: string, dataUrl: string): Promise<string> {
  const response = await fetch('/api/aifisher/canvas/media/images/annotation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, dataUrl, mode: 'draw' }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) throw new Error(`保存合成图失败（HTTP ${response.status}）`);
  const url =
    body && typeof body === 'object' ? (body as { asset?: { url?: unknown } }).asset?.url : undefined;
  if (typeof url !== 'string' || !url) throw new Error('保存合成图失败：服务端没有返回素材地址。');
  return url;
}

export interface FlattenResult {
  ok: boolean;
  /** 素材库 URL（成功时）。 */
  url?: string;
  /** 原始 dataURL（成功时，调用方一般不直接用）。 */
  dataUrl?: string;
  reason?: string;
}

/**
 * 把图层文档按位置扁平合成一张 PNG 并落进素材库。
 *
 * `fallbackUrl`：画布 2D 不可用（jsdom / 极端环境）或某层加载失败时用它（= 底图）——
 * 宁可预览是一张底图，也不要让节点变成空卡。
 */
export async function flattenLayerStack(
  stack: LayerStack,
  options: { projectId: string; fallbackUrl?: string },
): Promise<FlattenResult> {
  const layers = sortedLayers(stack);
  if (!layers.length) return { ok: false, reason: '没有图层。' };
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(stack.width));
    canvas.height = Math.max(1, Math.round(stack.height));
  } catch {
    return { ok: false, reason: '画布不可用。', ...(options.fallbackUrl ? { url: options.fallbackUrl } : {}) };
  }
  const context = canvas.getContext('2d');
  if (!context) {
    return {
      ok: false,
      reason: '这个环境没有 2D 画布（用底图充当预览）。',
      ...(options.fallbackUrl ? { url: options.fallbackUrl } : {}),
    };
  }
  for (const layer of layers) {
    const image = await loadImage(layer.url);
    if (!image) {
      return {
        ok: false,
        reason: `有图层加载失败：${layer.name ?? layer.url.slice(-40)}`,
        ...(options.fallbackUrl ? { url: options.fallbackUrl } : {}),
      };
    }
    // 关键：按 bbox 矩形缩放贴（图层 PNG 比元素大，是等比例放大的裁片）
    context.drawImage(image, layer.x, layer.y, layer.width, layer.height);
  }
  let dataUrl = '';
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '导出合成图失败。',
      ...(options.fallbackUrl ? { url: options.fallbackUrl } : {}),
    };
  }
  try {
    const url = await uploadPng(options.projectId, dataUrl);
    return { ok: true, url, dataUrl };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '保存合成图失败。',
      ...(options.fallbackUrl ? { url: options.fallbackUrl } : {}),
    };
  }
}

interface LayerStackBridge {
  flatten(stack: LayerStack, projectId: string, fallbackUrl?: string): Promise<FlattenResult>;
  downloadPsd(
    stack: LayerStack,
    name: string,
  ): Promise<{ ok: boolean; bytes?: number; error?: string }>;
}

declare global {
  interface Window {
    __FISHERAI_LAYER_STACK__?: LayerStackBridge;
  }
}

/**
 * 把图层文档打成真的 .psd 并下载（一层一个图层、位置/顺序/透明度原样）。
 *
 * 每层先画到「自己 bbox 尺寸」的画布上取像素 —— 这样 PSD 里的图层矩形就是 bbox，
 * 而不是整幅文档（整幅的话 11 层每层都是 4.5MB，文件会白白大十倍，PS 里也不好看）。
 */
export async function downloadLayerStackPsd(
  stack: LayerStack,
  name: string,
): Promise<{ ok: boolean; bytes?: number; error?: string }> {
  const normalized = normalizeLayerStack(stack) ?? stack;
  const layers = sortedLayers(normalized);
  if (!layers.length) return { ok: false, error: '没有图层可以导出。' };
  const documentWidth = Math.max(1, Math.round(normalized.width));
  const documentHeight = Math.max(1, Math.round(normalized.height));

  const layerInputs: PsdLayerInput[] = [];
  for (const [index, layer] of layers.entries()) {
    const image = await loadImage(layer.url);
    if (!image) return { ok: false, error: `第 ${index + 1} 层图片加载失败。` };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(layer.width));
    canvas.height = Math.max(1, Math.round(layer.height));
    const context = canvas.getContext('2d');
    if (!context) return { ok: false, error: '这个环境没有 2D 画布，导不出 PSD。' };
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    layerInputs.push({
      name: layer.name || `${index === 0 ? '底图' : `图层 ${index}`}`,
      x: layer.x,
      y: layer.y,
      width: canvas.width,
      height: canvas.height,
      rgba: context.getImageData(0, 0, canvas.width, canvas.height).data,
    });
  }

  // 合成图（PS 打开时先看到的那张）：按位置叠起来
  const compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = documentWidth;
  compositeCanvas.height = documentHeight;
  const compositeContext = compositeCanvas.getContext('2d');
  if (!compositeContext) return { ok: false, error: '这个环境没有 2D 画布，导不出 PSD。' };
  for (const layer of layers) {
    const image = await loadImage(layer.url);
    if (!image) continue;
    compositeContext.drawImage(image, layer.x, layer.y, layer.width, layer.height);
  }
  const composite = compositeContext.getImageData(0, 0, documentWidth, documentHeight).data;

  const bytes = buildPsd({
    width: documentWidth,
    height: documentHeight,
    layers: layerInputs,
    composite,
  });
  const saved = savePsd(bytes, psdFileName(name));
  return { ok: true, bytes: saved };
}

/**
 * 挂给 vendor 节点卡用的桥（节点卡不能 import 本模块）。
 *
 * 调用方是 `canvasImagePreview` 的两个按钮（vendor 补丁 3.13）：
 *   · 「转成 PSD」→ `flatten(...)`：得到扁平合成图写回节点；
 *   · 「下载 PSD」→ `downloadPsd(...)`：直接存一份带图层的 .psd。
 */
export function installLayerStackBridge(target: Window = window): { dispose: () => void } {
  const previous = target.__FISHERAI_LAYER_STACK__;
  const bridge: LayerStackBridge = {
    flatten: (stack, projectId, fallbackUrl) =>
      flattenLayerStack(normalizeLayerStack(stack) ?? stack, {
        projectId: projectId || 'default',
        ...(fallbackUrl ? { fallbackUrl } : {}),
      }),
    downloadPsd: (stack, name) => downloadLayerStackPsd(normalizeLayerStack(stack) ?? stack, name),
  };
  target.__FISHERAI_LAYER_STACK__ = bridge;
  return {
    dispose() {
      if (target.__FISHERAI_LAYER_STACK__ !== bridge) return;
      if (previous) target.__FISHERAI_LAYER_STACK__ = previous;
      else delete target.__FISHERAI_LAYER_STACK__;
    },
  };
}
