/**
 * 画布缩略图管线（v1.107，性能 P1-1）。
 *
 * 背景：用户画布素材 441 个文件 615MB，其中 178 张 PNG 合计 270.8 MPix（RGBA8 解码 ≈ 1.01GB），
 * 单张最大 3840×2160 / 12.5MB；而节点卡显示尺寸只有 360×420。也就是说每张 4K 原图都被
 * **按原尺寸解码进内存**，平移缩放时整层重新栅格化 —— 这是「一次浏览下来越来越卡」的主要来源。
 *
 * 做法（零原生依赖、零 vendor 改动）：
 *   1. 只观察节点层（`[data-canvas-nodes-layer]`）里的 `<img>`（节点卡）。图片预览 / 裁剪 /
 *      对比这些需要原图的浮层不在这一层里，不受影响。
 *   2. 图片真的加载完、且 `naturalWidth >= 1600` 才动手（小图缩了只会更糊）。
 *   3. 先 `HEAD ...?w=1024` 问 host 有没有缩略图：
 *        - 有（`x-aifisher-thumb: hit`）→ 把 `<img>` 的 src 换成缩略图 URL；
 *        - 没有 → 就用**已经解码好的这张图**（`createImageBitmap(img)`，不再走网络）
 *          画到 OffscreenCanvas，导出 webp 交给 `POST /media/thumb` 落盘，然后换 src。
 *      生成放在浏览器而不是 host：插件不加 sharp/libvips 这类原生依赖（本机连 ffmpeg 都没有，
 *      现有 `/media/thumbnail` 在这台机上是不可用的），而 Chromium 手上本来就有解码好的位图。
 *   4. 按 URL 去重 + 最多 2 个并发，避开手势期间（`data-canvas-gesture`）与页面隐藏时干活。
 *
 * 为什么改 src 不会跟 React 打架：vendor 的 `<img src={resultUrl}>` 在 re-render 时只在
 * prop 变化时才写 DOM；我们改的是 DOM 属性，`resultUrl` 没变 → React 不会覆盖回来。这与
 * textPreview / canvasGrid / knife「在 DOM 侧做同位观察」是同一条路线。
 *
 * 已知取舍：节点卡里一律用 1024px 宽的缩略图，放到 **300% 以上**缩放时大图会略软；
 * 双击进图片预览看到的是原图（那条链路不走这里）。
 */

const API_BASE = '/api/aifisher/canvas';

/** 节点卡用的缩略图宽度（host 端只认 256/512/1024/2048）。 */
export const THUMB_WIDTH = 1024;
/** 小于这个宽度（naturalWidth）的图不缩：卡片显示尺寸本来就不大。 */
export const THUMB_MIN_NATURAL_WIDTH = 1600;
/** 同时最多几张在生成（每张一次 drawImage + webp 编码，多了会顶掉手势预算）。 */
const MAX_CONCURRENT = 2;
/** 手势中把活往后推。 */
const GESTURE_DEFER_MS = 400;

const NODES_LAYER = '[data-canvas-nodes-layer]';
const MEDIA_URL_RE = /\/api\/aifisher\/canvas\/media\/([^/?#]+)\/(images|videos|audios)\/([^/?#]+)/;

/** 是不是本插件素材库的 URL（远程直链、data URL 一律不动）。 */
export function isCanvasMediaUrl(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && MEDIA_URL_RE.test(raw);
}

/** 同一张素材的缩略图 URL（带 `?w=`；已有 query 就用 `&`）。 */
export function thumbnailUrlOf(raw: string, width: number = THUMB_WIDTH): string {
  if (!raw) return raw;
  const hashIndex = raw.indexOf('#');
  const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}w=${width}`;
}

/** 这张图值不值得换成缩略图。 */
export function shouldDownscale(
  naturalWidth: number,
  width: number = THUMB_WIDTH,
  minimum: number = THUMB_MIN_NATURAL_WIDTH,
): boolean {
  return Number.isFinite(naturalWidth) && naturalWidth >= Math.max(minimum, width * 1.5);
}

interface ThumbStats {
  scanned: number;
  candidates: number;
  flipped: number;
  generated: number;
  failed: number;
  skippedSmall: number;
}

const stats: ThumbStats = {
  scanned: 0,
  candidates: 0,
  flipped: 0,
  generated: 0,
  failed: 0,
  skippedSmall: 0,
};

/** 排查用读数（真机「图还是糊的 / 卡没下降」时先看这几个数）。 */
export function canvasThumbsReport(): Record<string, unknown> | null {
  const layer = document.querySelector(NODES_LAYER);
  const imgs = layer ? layer.querySelectorAll('img') : [];
  let thumbed = 0;
  for (const img of imgs) {
    if ((img as HTMLElement).dataset.fisheraiThumb === 'on') thumbed += 1;
  }
  return {
    mounted: Boolean(layer),
    width: THUMB_WIDTH,
    minNaturalWidth: THUMB_MIN_NATURAL_WIDTH,
    layerImages: imgs.length,
    thumbedNow: thumbed,
    ...stats,
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('缩略图读取失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 在画布容器上装缩略图管线。返回卸载函数（必须调用，否则观察者与监听会留）。
 */
export function installCanvasThumbs(container: HTMLElement): () => void {
  if (typeof window === 'undefined') return () => {};
  let disposed = false;
  /** url → 已知结论（命中/已生成/失败），避免同一张图反复问。 */
  const known = new Map<string, 'hit' | 'made' | 'failed'>();
  /** url → 正在跑的任务。 */
  const inflight = new Map<string, Promise<boolean>>();
  const queue: { url: string; image: HTMLImageElement }[] = [];
  let running = 0;

  const flip = (url: string) => {
    const layer = document.querySelector(NODES_LAYER);
    if (!layer) return;
    for (const node of layer.querySelectorAll('img')) {
      const image = node as HTMLImageElement;
      if (image.dataset.fisheraiThumb === 'on') continue;
      if (image.getAttribute('src') !== url) continue;
      image.dataset.fisheraiThumbFull = url;
      image.dataset.fisheraiThumb = 'on';
      image.setAttribute('src', thumbnailUrlOf(url));
      stats.flipped += 1;
    }
  };

  const canProduce = () =>
    typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function';

  /** 没有缩略图时，用浏览器手里这张已解码的图生成一份。 */
  const generate = async (url: string, image: HTMLImageElement): Promise<boolean> => {
    if (!canProduce()) return false;
    try {
      const bitmap = await createImageBitmap(image);
      const scale = THUMB_WIDTH / bitmap.width;
      const canvas = new OffscreenCanvas(
        THUMB_WIDTH,
        Math.max(1, Math.round(bitmap.height * scale)),
      );
      const context = canvas.getContext('2d');
      if (!context) return false;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
      if (!blob || blob.size === 0) return false;
      const data = await blobToDataUrl(blob);
      const response = await fetch(`${API_BASE}/media/thumb`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, width: THUMB_WIDTH, data }),
      });
      if (!response.ok) return false;
      stats.generated += 1;
      return true;
    } catch {
      return false;
    }
  };

  const ensure = (url: string, image: HTMLImageElement): Promise<boolean> => {
    const existing = known.get(url);
    if (existing === 'hit' || existing === 'made') {
      flip(url);
      return Promise.resolve(true);
    }
    const pending = inflight.get(url);
    if (pending) return pending;
    const task = (async () => {
      try {
        // 先问 host：也许上一轮已经生成过了（重开项目时走这条，一次请求就换完）。
        const head = await fetch(thumbnailUrlOf(url), { method: 'HEAD' });
        if (head.ok && head.headers.get('x-aifisher-thumb') === 'hit') {
          known.set(url, 'hit');
          flip(url);
          return true;
        }
        const made = await generate(url, image);
        known.set(url, made ? 'made' : 'failed');
        if (made) {
          flip(url);
          return true;
        }
        stats.failed += 1;
        return false;
      } catch {
        stats.failed += 1;
        known.set(url, 'failed');
        return false;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, task);
    return task;
  };

  const pump = () => {
    if (disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      window.setTimeout(pump, 1200);
      return;
    }
    // 手势期间不干活：这里每张图都要 drawImage + 编码，会直接吃掉帧预算。
    if (container.getAttribute('data-canvas-gesture')) {
      window.setTimeout(pump, GESTURE_DEFER_MS);
      return;
    }
    while (running < MAX_CONCURRENT && queue.length) {
      const next = queue.shift()!;
      running += 1;
      void ensure(next.url, next.image).finally(() => {
        running -= 1;
        pump();
      });
    }
  };

  const consider = (image: HTMLImageElement) => {
    if (disposed) return;
    const source = image.getAttribute('src');
    if (!source || !isCanvasMediaUrl(source)) return;
    if (source.includes('?w=') || source.includes('&w=')) return;
    if (image.dataset.fisheraiThumb) return;
    if (image.closest('[data-fisherai-image-preview]')) return;
    stats.scanned += 1;
    const naturalWidth = image.naturalWidth || 0;
    if (!shouldDownscale(naturalWidth)) {
      stats.skippedSmall += 1;
      image.dataset.fisheraiThumb = 'skip';
      return;
    }
    stats.candidates += 1;
    image.dataset.fisheraiThumb = 'queued';
    // 已经问过的 URL 立即换（重开项目时不必等队列）。
    const status = known.get(source);
    if (status === 'hit' || status === 'made') {
      flip(source);
      return;
    }
    queue.push({ url: source, image });
    pump();
  };

  const onLoad = (event: Event) => {
    // ⚠️ 不要用 `instanceof HTMLImageElement`：jsdom 里没有这个全局构造器（回归直接抛
    // ReferenceError），而 Element 一定是有的。按 tagName 判更稳。
    const target = event.target as Element | null;
    if (!target || !(target instanceof Element) || target.tagName !== 'IMG') return;
    if (!target.closest(NODES_LAYER)) return;
    consider(target as HTMLImageElement);
  };

  const scan = (root: ParentNode) => {
    for (const node of root.querySelectorAll('img')) {
      const image = node as HTMLImageElement;
      if (!image.closest(NODES_LAYER)) continue;
      // 已经在 DOM 里且加载完成的（挂载晚于图片 load 的情况）直接判一次。
      if (image.complete && image.naturalWidth) consider(image);
    }
  };

  // load 不冒泡，用捕获阶段收（与 canvasGrid 的「窗口捕获」同一条教训）。
  container.addEventListener('load', onLoad, true);
  scan(document);

  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) continue;
              if (node.tagName === 'IMG') {
                const image = node as HTMLImageElement;
                if (image.complete && image.naturalWidth) consider(image);
              } else {
                scan(node);
              }
            }
          }
        })
      : null;
  observer?.observe(container, { childList: true, subtree: true });

  return () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    container.removeEventListener('load', onLoad, true);
    queue.length = 0;
    // 卸载时把换过 src 的图还原，避免画布复用同一批节点时拿到「贴在别的 URL 上」的缩略图。
    const layer = document.querySelector(NODES_LAYER);
    if (layer) {
      for (const node of layer.querySelectorAll('img[data-fisherai-thumb="on"]')) {
        const image = node as HTMLImageElement;
        const full = image.dataset.fisheraiThumbFull;
        if (full) image.setAttribute('src', full);
        delete image.dataset.fisheraiThumb;
        delete image.dataset.fisheraiThumbFull;
      }
    }
  };
}
