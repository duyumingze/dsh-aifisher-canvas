/**
 * 「视频生成历史」（v1.64）。
 *
 * 用户原话（2026-10-23）：
 *   「仿照图像生成历史记录，做视频生成历史记录功能」
 *
 * 参照物是**图片节点**上来就有的那套（上游 `media/canvasImagePreview.tsx`）：
 *   - 每次生成都把新结果**并进** `resultUrls`（`resultUrl` 永远是最新那张），
 *     所以节点天生留着「这一张之前生成过的一串」；
 *   - 节点头部一枚 `历史 N` 药丸，点开就在节点周围扇形摊出前面那些（每张都能下载 / 设为主图）；
 *   - `currentResultCount` 记的是「本批出了几张」，于是文案会在
 *     `本次 2` / `本次 2 · 历史 5` / `历史 5` 之间切换。
 *
 * 视频侧此前是**每次生成直接覆盖** `resultUrl / resultUrls`（`canvasGeneration.ts` 的
 * Video 分支），慢的、贵的视频重跑一次，上一条就永远找不回来了。这里把口径对齐图片：
 * 本文件管**数据**（合并 / 提取主视频 / 文案 / 诊断读数），画布那一侧只留薄壳：
 *
 *   · vendor 补丁 3.8w 让 `canvasGeneration.ts`、`generationRecovery.ts` 在视频成功时
 *     调 `merge()`（走的是装配层挂在 `window / globalThis` 上的桥，见 `install()`），
 *     拿不到桥时退回旧行为（只记这一次的结果），不会把生成链路带崩；
 *   · `scripts/patches/aifisher/.../canvasVideoPlayer.tsx`（整文件覆盖）读 `urls()` / `label()`
 *     画那枚药丸与扇形叠，点「设为主视频」调 `promote()`。
 *
 * 为什么是纯函数 + 全局桥：算法与边界（去重、上限、主视频换位时清掉上一帧 / 比例）
 * 要在**构建产物**上直接验（`canvasApp.mergeVideoResultHistory` 等由 mount.tsx 转出），
 * 不必先在 jsdom 里真跑一次出片；同时 vendor 那两份文件不该 import 插件的实现
 * （它们由构建期从上游整树复制，见 README「关键约束」）。
 */

/**
 * 一条视频的历史上限。
 * 比图片（20）低：视频结果在展开时每一个都是真的 `<video>`（`preload=metadata`），
 * 摊 20 个会把中端机器的解码器压出卡顿；12 条足够翻「刚才那条不满意的那几版」。
 */
export const VIDEO_RESULT_HISTORY_LIMIT = 12;

/** 视频节点上我们读写的键（画布节点是宽松对象，只钉这一块）。 */
export interface VideoHistoryNode {
  type?: string;
  resultUrl?: unknown;
  resultUrls?: unknown;
  currentResultCount?: unknown;
  resultAspectRatio?: unknown;
  naturalWidth?: unknown;
  naturalHeight?: unknown;
  lastFrame?: unknown;
  [key: string]: unknown;
}

/** 合并后的落库字段（与图片那套 `ImageResultHistoryUpdate` 同名同义）。 */
export interface VideoHistoryUpdate {
  resultUrl?: string;
  resultUrls: string[];
  currentResultCount: number;
}

export interface VideoHistoryItem {
  url: string;
  /** 在 `resultUrls` 里的下标（主视频是 0，历史从 1 起）。 */
  index: number;
}

export interface VideoResultHistoryAdapter {
  merge(node: VideoHistoryNode, generatedUrls: readonly unknown[]): VideoHistoryUpdate;
  promote(node: VideoHistoryNode, url: unknown): Record<string, unknown> | null;
  urls(node: VideoHistoryNode): string[];
  items(node: VideoHistoryNode): VideoHistoryItem[];
  label(node: VideoHistoryNode): string;
  report(node: VideoHistoryNode): Record<string, unknown>;
}

function isNodeLike(value: unknown): value is VideoHistoryNode {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 去掉空串与重复（保序）——同一批生成里偶尔会回同一个 URL 两次。 */
function uniqueUrls(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const url = value.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/**
 * 节点上现在的历史列表（主视频在前）。
 *
 * 老数据只有 `resultUrl` 没有 `resultUrls` 时也要能用（视频节点在 v1.64 之前全是这种），
 * 所以这里与图片预览同一套口径：`resultUrls` 优先，缺了就退化成单元素数组。
 */
export function videoResultUrls(node: VideoHistoryNode | null | undefined): string[] {
  if (!isNodeLike(node)) return [];
  const stored = Array.isArray(node.resultUrls) ? uniqueUrls(node.resultUrls) : [];
  if (stored.length) {
    // 主视频必须排在 0：老数据/手改过的文档里两者可能不同步，这里以 resultUrl 为准把它提到最前。
    const main = typeof node.resultUrl === 'string' ? node.resultUrl.trim() : '';
    const rest = stored.filter((url) => url !== main);
    return main ? [main, ...rest] : stored;
  }
  return uniqueUrls([node.resultUrl]);
}

/** 本次生成了几条（脏数据/越界一律当作「没记」→ 只显示历史数）。 */
export function videoCurrentResultCount(node: VideoHistoryNode | null | undefined): number | null {
  if (!isNodeLike(node)) return null;
  const total = videoResultUrls(node).length;
  const raw = Number(node.currentResultCount);
  if (!Number.isFinite(raw) || raw < 0) return null;
  return Math.min(total, Math.trunc(raw));
}

/**
 * 把这一批新结果并进历史（与 `mergeImageResultHistory` 一字不差的语义）：
 *   - 新的在前、旧的在后、去重；
 *   - `resultUrl` = 这一批的第一条（没生成出新东西时保留原主视频，避免视频消失）；
 *   - `currentResultCount` = 这一批的条数（UI 用它区分「本次」与「历史」）。
 */
export function mergeVideoResultHistory(
  node: VideoHistoryNode | null | undefined,
  generatedUrls: readonly unknown[],
): VideoHistoryUpdate {
  const generated = uniqueUrls(generatedUrls);
  const previous = videoResultUrls(node);
  const resultUrls = uniqueUrls([...generated, ...previous]).slice(0, VIDEO_RESULT_HISTORY_LIMIT);
  return {
    resultUrl: generated[0] || previous[0],
    resultUrls,
    currentResultCount: generated.length,
  };
}

/** 历史里除主视频以外的那些（展开扇形、回归都读这一份）。 */
export function videoHistoryItems(node: VideoHistoryNode | null | undefined): VideoHistoryItem[] {
  return videoResultUrls(node)
    .map((url, index) => ({ url, index }))
    .filter((item) => item.index > 0);
}

/**
 * 节点头部那枚药丸的文案（与图片完全一致的口径）：
 *   `历史 5` / `本次 2` / `本次 2 · 历史 6`。
 */
export function videoHistoryLabel(node: VideoHistoryNode | null | undefined): string {
  const total = videoResultUrls(node).length;
  const current = videoCurrentResultCount(node);
  if (current == null) return `历史 ${total}`;
  return current === total ? `本次 ${current}` : `本次 ${current} · 历史 ${total}`;
}

/**
 * 「设为主视频」：把历史里的某一条提到第一位。
 *
 * 同时清掉三样**跟着上一条视频走**的字段：
 *   - `lastFrame`：首/尾帧预览与「用最后一帧接着生成」都读它，换片了还留着就是错帧；
 *   - `resultAspectRatio` / `naturalWidth` / `naturalHeight`：旧片比例，新片加载完
 *     `useCanvasVideoPlayback` 会用 `loadedmetadata` 再量一遍并写回。
 *
 * 返回 null = 这条已经在主位（或根本不在历史里），UI 据此「什么都不做」。
 */
export function promoteVideoResult(
  node: VideoHistoryNode | null | undefined,
  url: unknown,
): Record<string, unknown> | null {
  const target = typeof url === 'string' ? url.trim() : '';
  const list = videoResultUrls(node);
  const index = list.indexOf(target);
  if (index <= 0) return null;
  const resultUrls = [...list];
  [resultUrls[0], resultUrls[index]] = [resultUrls[index], resultUrls[0]];
  return {
    resultUrl: target,
    resultUrls,
    resultAspectRatio: undefined,
    naturalWidth: undefined,
    naturalHeight: undefined,
    lastFrame: undefined,
  };
}

/** 排查读数（`__FISHERAI_VIDEO_RESULT_HISTORY__.report(node)`）。 */
export function videoHistoryReport(node: VideoHistoryNode | null | undefined): Record<string, unknown> {
  const urls = videoResultUrls(node);
  return {
    label: videoHistoryLabel(node),
    total: urls.length,
    current: videoCurrentResultCount(node),
    limit: VIDEO_RESULT_HISTORY_LIMIT,
    main: urls[0] ?? null,
    items: urls.slice(1).map((url, index) => ({ index: index + 1, url })),
  };
}

interface VideoHistoryHolder {
  __FISHERAI_VIDEO_RESULT_HISTORY__?: VideoResultHistoryAdapter;
}

/**
 * 装配层调用：把桥挂到 `window` 与 `globalThis`。
 *
 * 两处都写是有意的 —— 浏览器里两者是同一个对象，jsdom 里不是（vendor 读 `window`、
 * 回归脚本有时读 `globalThis`），见 README 的「跨 bundle 的桥走全局」。
 * 返回 dispose（卸载画布时把桥摘掉，避免留着指向已卸载实例的函数）。
 */
export function installVideoResultHistory(): { dispose: () => void } {
  const adapter: VideoResultHistoryAdapter = {
    merge: mergeVideoResultHistory,
    promote: promoteVideoResult,
    urls: videoResultUrls,
    items: videoHistoryItems,
    label: videoHistoryLabel,
    report: videoHistoryReport,
  };
  const holders = [
    window as unknown as VideoHistoryHolder,
    globalThis as unknown as VideoHistoryHolder,
  ].filter((holder, index, all) => all.indexOf(holder) === index);
  for (const holder of holders) holder.__FISHERAI_VIDEO_RESULT_HISTORY__ = adapter;
  return {
    dispose() {
      for (const holder of holders) {
        if (holder.__FISHERAI_VIDEO_RESULT_HISTORY__ === adapter) {
          delete holder.__FISHERAI_VIDEO_RESULT_HISTORY__;
        }
      }
    },
  };
}

declare global {
  interface Window {
    /** dsh-aifisher-canvas v1.64：视频生成历史（合并 / 主视频换位 / 文案）。 */
    __FISHERAI_VIDEO_RESULT_HISTORY__?: VideoResultHistoryAdapter;
  }
}
