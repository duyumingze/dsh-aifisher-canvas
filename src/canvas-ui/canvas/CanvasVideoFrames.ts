/**
 * 「截取视频首帧 / 尾帧」（v1.66，v1.67 加固）。
 *
 * 用户原话（2026-10-23）：「完善视频截取首尾帧功能」；同晚报障「截取视频首尾帧失败了」。
 *
 * 上游（`vendor/.../media/videoSnapshots.ts`）的 `firstLastVideoFrames` 能跑，但只做一件事：
 * 两个帧一起截、原尺寸 PNG、没有任何失败兜底。用起来缺的是：
 *   1. **只能成对截**：只想要尾帧接着生成时，也会多掉一个首帧节点要删；
 *   2. **尾帧可能取不到画面**：把 `currentTime` 设到 `duration - 0.000001`，某些编码/封装下
 *      seek 落点已经越过最后一帧 → 画布上什么都没画（透明/黑），却当成成功上传了；
 *   3. **大文件没有上限**：4K 一帧 PNG 8–25MB，上传慢、预览卡（README 里 lastFrame 那条
 *      教训同源：内联大帧会把文档顶爆，这里落盘但同样不该原尺寸搬）；
 *   4. 失败原因只有一句「视频截图等待超时」，定位不到是哪一步。
 *
 * v1.67 的加固（2026-10-23 报障后重写等待逻辑）：
 *   · **单次事件快照不再决定成败**：旧写法只挂在 `seeked` 上「事件来了看一眼」，
 *     只要那一刻 `readyState` 还没到 2、或 `currentTime` 差几毫秒，条件就永远不再评估 →
 *     白白等满 15s 报「视频定位超时」。现在改成「事件唤醒 + 40ms 轮询」，
 *     条件成立就过，事件丢了也能自己捡回来；
 *   · **落点容差 0.5s**：Chromium 会把手感位置吸到最近的可解码帧，`|ct - target| < 0.02`
 *     这种判定对 23fps / 关键帧稀疏的片子本来就过紧；
 *   · **按 `seekable` 钳制**：拿不到 range 的远端素材（代理只回 200）seekable 只有已缓冲那段，
 *     硬拖到片尾必然卡死 —— 先钳到能到的最远处再试；
 *   · **空白不是失败**：画布/解码器晚一拍画上帧是常态，空白时等下一帧再探（最多 800ms），
 *     仍空才换下一档落点；
 *   · **超时就换一个解码器重试一次**：偶发卡死的 `<video>` 不会第二次再卡；
 *   · 错误文案带现场（`readyState` / 是否仍在寻址 / 落点 / 时长），下次再报能一眼定位。
 *
 * 落位不在这里（见 `CanvasFrameLayout.ts`），本文件只管"截出什么"。
 */

/** 截帧输出的最长边（像素）。2048 足够当参考图/首尾帧，又不至于把几十 MB 的 PNG 搬来搬去。 */
export const FRAME_MAX_EDGE = 2048;
/** 单次取帧每一步的等待上限（毫秒）。大文件首次解码可能慢，但超过 15s 基本就是坏了。 */
export const FRAME_TIMEOUT_MS = 15000;
/** 尾帧单个候选落点的等待上限（毫秒）：本地 seek 实测 150–250ms，8s 对慢速远端也够宽裕。 */
export const TAIL_SEEK_TIMEOUT_MS = 8000;
/** seek 落点容差（秒）：Chromium 会吸到最近可解码帧，片尾几帧的偏差仍是想要的那一帧。 */
export const SEEK_TOLERANCE_SEC = 0.5;
/** 空白帧最多等多久（毫秒）：解码器晚一拍画上帧是常态，但超过这个数就是真没画面。 */
export const PAINT_WAIT_MS = 800;
/**
 * 尾帧的候选落点（秒，从片尾往前退）。
 * 第一个 0.05 与 `inspectVideo` 里 lastFrame 缩略图同口径 —— 大多数封装取到的是真正的最后一帧；
 * 真拿到空白画面（seek 越过末帧）再往前退，直到有画面为止。
 */
export const TAIL_SEEK_OFFSETS: readonly number[] = [0.05, 0.2, 0.5, 1.2];
/** 轮询间隔（毫秒）：40ms ≈ 一帧多，既不烧 CPU 又不会漏掉几十毫秒的窗口。 */
const POLL_MS = 40;

export type VideoFrameRole = 'first' | 'last';

export interface CapturedVideoFrame {
  role: VideoFrameRole;
  /** `data:image/png;base64,...`（已按 FRAME_MAX_EDGE 缩放）。 */
  data: string;
  /** 输出图尺寸（缩放后，不是视频原始尺寸）。 */
  width: number;
  height: number;
  /** 实际取帧的时间点（秒）。 */
  time: number;
}

export interface FrameCaptureOptions {
  /** 最长边上限，默认 FRAME_MAX_EDGE。 */
  maxEdge?: number;
  /** 每一步的等待上限，默认 FRAME_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 尾帧候选落点，默认 TAIL_SEEK_OFFSETS（回归用得到）。 */
  tailOffsets?: readonly number[];
  /** 失败后是否换一个解码器重试一次，默认 true（回归里关掉好钉住耗时）。 */
  retryOnTimeout?: boolean;
}

export interface VideoFrameCaptureAdapter {
  capture(
    url: string,
    roles: readonly VideoFrameRole[],
    signal?: AbortSignal,
    options?: FrameCaptureOptions,
  ): Promise<CapturedVideoFrame[]>;
  targetSize(width: number, height: number, maxEdge?: number): FrameTargetSize;
  tailTimes(duration: number, offsets?: readonly number[]): number[];
}

export interface FrameTargetSize {
  width: number;
  height: number;
  /** 0 < scale ≤ 1；=1 表示不缩放。 */
  scale: number;
}

/** 等待逻辑只用到这几件事，回归里可以喂假元素。 */
export interface FrameVideoLike {
  currentTime: number;
  duration: number;
  readyState: number;
  seeking: boolean;
  seekable: { length: number; start(index: number): number; end(index: number): number };
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * 输出尺寸：最长边不超过 `maxEdge`，保持比例；非法尺寸返回 1×1（宁可小，不要抛）。
 * 纯函数，回归直接调。
 */
export function frameTargetSize(
  width: number,
  height: number,
  maxEdge: number = FRAME_MAX_EDGE,
): FrameTargetSize {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.round(width) : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.round(height) : 1;
  const limit = Number.isFinite(maxEdge) && maxEdge > 0 ? maxEdge : FRAME_MAX_EDGE;
  const longest = Math.max(safeWidth, safeHeight);
  const scale = Math.min(1, limit / longest);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
    scale,
  };
}

/**
 * 尾帧候选时间点（秒）：`duration - offset`，越小的时间越靠前。
 * 过滤掉 ≤0 的点、按时间从晚到早去重；duration 不合法时返回空数组。
 */
export function tailTimes(
  duration: number,
  offsets: readonly number[] = TAIL_SEEK_OFFSETS,
): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const seen = new Set<string>();
  const times: number[] = [];
  for (const offset of offsets) {
    if (!Number.isFinite(offset) || offset < 0) continue;
    const time = Math.max(0, duration - offset);
    const key = time.toFixed(6);
    if (seen.has(key)) continue;
    seen.add(key);
    times.push(time);
  }
  return times.sort((a, b) => b - a);
}

/**
 * 采样像素是否"什么都没有"（画布没画上帧时是透明黑：alpha 全 0）。
 * `samples` 是 RGBA 数组列表；空列表按空白处理（探针失败也当没画面，好再退一步重试）。
 */
export function isBlankFrameSamples(samples: readonly (readonly number[])[]): boolean {
  if (!samples.length) return true;
  return samples.every((pixel) => (pixel[3] ?? 0) === 0);
}

/**
 * 把 seek 目标钳到「这段视频现在真能到的地方」。
 *
 * 远端素材走 `/proxy` 时拿不到 206（整段 200），`seekable` 只有已缓冲的那一截；
 * 硬拖到片尾会一直等不到 `seeked`。这里退到能到的最后一点，至少能截到画面。
 * 没有 `seekable`（老浏览器 / 假元素）时原样返回。
 */
export function clampSeekTime(
  video: Pick<FrameVideoLike, 'seekable'>,
  time: number,
  tolerance: number = SEEK_TOLERANCE_SEC,
): number {
  if (!Number.isFinite(time)) return 0;
  const seekable = video.seekable;
  if (!seekable || !seekable.length) return Math.max(0, time);
  try {
    const end = seekable.end(seekable.length - 1);
    if (Number.isFinite(end) && end > 0 && time > end - 0.05) {
      return Math.max(0, Math.round((end - Math.min(0.05, tolerance)) * 1000) / 1000);
    }
  } catch {
    /* 部分实现读 seekable 会抛，按"能到"处理 */
  }
  return Math.max(0, time);
}

/** seek 是否已经落到位：不再寻址、有可画数据、落点在容差内。 */
export function seekLanded(
  video: Pick<FrameVideoLike, 'currentTime' | 'readyState' | 'seeking'>,
  time: number,
  tolerance: number = SEEK_TOLERANCE_SEC,
): boolean {
  if (video.seeking || video.readyState < 2) return false;
  if (!Number.isFinite(video.currentTime)) return false;
  return Math.abs(video.currentTime - time) <= tolerance;
}

/** 现场描述，拼进错误文案（下次再报障能一眼看出卡在哪一步）。 */
export function mediaStateText(
  video: Pick<FrameVideoLike, 'currentTime' | 'duration' | 'readyState' | 'seeking'>,
): string {
  const parts = [`readyState=${video.readyState}`];
  if (video.seeking) parts.push('仍在寻址');
  if (Number.isFinite(video.currentTime)) parts.push(`落点 ${video.currentTime.toFixed(2)}s`);
  if (Number.isFinite(video.duration)) parts.push(`时长 ${video.duration.toFixed(2)}s`);
  return parts.join('，');
}

function abortError(): Error {
  return new DOMException('截图已取消', 'AbortError');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitOptions {
  /** 什么算"好了"。 */
  ready: () => boolean;
  /** 什么算"坏了"（返回 Error 就立刻失败）。 */
  failed?: () => Error | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 超时文案（延迟求值：能带上当时的现场）。 */
  timeoutMessage: () => string;
  /** 额外的唤醒事件；即使一个事件都没来，轮询也会把它捞回来。 */
  wake?: readonly string[];
}

/**
 * 事件唤醒 + 轮询的等待。
 *
 * 这是 v1.67 修「截取首尾帧卡满 15s 报超时」的核心：旧写法把判定挂在单个事件上，
 * 事件来的时候 `readyState` / `currentTime` 差一点就永远不再评估；现在条件每 40ms
 * 重新算一次，事件只是拿来提前唤醒。
 */
export async function waitUntil(video: FrameVideoLike, options: WaitOptions): Promise<void> {
  const { ready, failed, timeoutMs, signal, timeoutMessage, wake = [] } = options;
  if (signal?.aborted) throw abortError();
  const check = (): Error | null | true => {
    if (signal?.aborted) return abortError();
    const failure = failed?.();
    if (failure) return failure;
    return ready() ? true : null;
  };
  const immediate = check();
  if (immediate === true) return;
  if (immediate instanceof Error) throw immediate;

  const deadline = Date.now() + Math.max(1, timeoutMs);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearInterval(timer);
      for (const name of wake) video.removeEventListener(name, wakeHandler);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const wakeHandler = () => {
      const verdict = check();
      if (verdict === true) finish(null);
      else if (verdict instanceof Error) finish(verdict);
    };
    const aborted = () => finish(abortError());
    timer = setInterval(() => {
      const verdict = check();
      if (verdict === true) finish(null);
      else if (verdict instanceof Error) finish(verdict);
      else if (Date.now() >= deadline) finish(new Error(timeoutMessage()));
    }, POLL_MS);
    for (const name of wake) video.addEventListener(name, wakeHandler);
    signal?.addEventListener('abort', aborted, { once: true });
    // 兜底：轮询已经在跑，这里只补一次"立刻可能就绪"的评估
    wakeHandler();
  });
}

/** 等 `loadeddata`（有第一帧可画），顺手把媒体错误翻译成人话。 */
async function loadVideo(
  video: HTMLVideoElement,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  const failed = () => {
    const error = (video as HTMLVideoElement & { error?: MediaError | null }).error;
    if (!error) return null;
    return new Error(
      error.code === 4
        ? '视频读取失败（浏览器不支持这个编码，或文件损坏）'
        : `视频读取失败（解码错误 code=${error.code}）`,
    );
  };
  try {
    video.src = url;
    video.load();
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error('视频加载失败');
  }
  await waitUntil(video, {
    ready: () => video.readyState >= 2,
    failed,
    timeoutMs,
    signal,
    timeoutMessage: () =>
      `视频首帧加载超时（可能是文件过大或网络太慢；${mediaStateText(video)}），请稍后重试`,
    wake: ['loadeddata', 'canplay', 'progress', 'error'],
  });
}

function seekVideo(
  video: HTMLVideoElement,
  time: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const target = clampSeekTime(video, time);
  try {
    video.currentTime = target;
  } catch (cause) {
    return Promise.reject(cause instanceof Error ? cause : new Error('视频定位失败'));
  }
  return waitUntil(video, {
    ready: () => seekLanded(video, target),
    timeoutMs,
    signal,
    timeoutMessage: () =>
      `视频定位超时（拖到 ${target.toFixed(2)}s 没等到画面；${mediaStateText(video)}），请稍后重试`,
    wake: ['seeked', 'timeupdate', 'canplay', 'loadeddata', 'progress'],
  });
}

/** 把视频当前帧画进 canvas（按 target 缩放），返回 PNG dataURL。 */
function drawFrame(video: HTMLVideoElement, target: FrameTargetSize): string {
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建截图画布');
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    throw new Error('无法读取此视频画面（编码或跨域限制），可先把它保存到本地素材再截');
  }
}

/** 抽 4×4 像素判断这一帧到底有没有画面（透明 = 没画上）。 */
function probeBlank(video: HTMLVideoElement): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const context = canvas.getContext('2d');
  if (!context) return false;
  try {
    context.drawImage(video, 0, 0, 4, 4);
  } catch {
    return false;
  }
  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, 4, 4).data;
  } catch {
    // 读不了像素（污染画布）不等于空白：交给后面 toDataURL 去报真正的错
    return false;
  }
  const samples: number[][] = [];
  for (let index = 0; index < pixels.length; index += 4) {
    samples.push([pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]]);
  }
  return isBlankFrameSamples(samples);
}

/**
 * 等"这一帧真的画上去了"。空白时每 40ms 重探一次，最多 `PAINT_WAIT_MS`。
 * 返回 true = 有画面，false = 一直是空白（交给调用方换下一档落点）。
 */
async function waitForPaintedFrame(
  video: HTMLVideoElement,
  signal: AbortSignal | undefined,
  budgetMs: number = PAINT_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(POLL_MS, budgetMs);
  for (;;) {
    if (signal?.aborted) throw abortError();
    if (!probeBlank(video)) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('超时');
}

/**
 * 一次完整的取帧（一个独立的 `<video>` 解码器）。
 * 失败时由 `captureVideoFrames` 决定要不要换个解码器再来一次。
 */
async function captureOnce(
  url: string,
  wanted: readonly VideoFrameRole[],
  signal: AbortSignal | undefined,
  options: { timeoutMs: number; maxEdge: number; tailOffsets: readonly number[] },
): Promise<CapturedVideoFrame[]> {
  const video = document.createElement('video');
  try {
    await loadVideo(video, url, options.timeoutMs, signal);
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('无法读取视频时长（文件可能损坏）');
    }
    const target = frameTargetSize(video.videoWidth, video.videoHeight, options.maxEdge);
    const frames: CapturedVideoFrame[] = [];

    if (wanted.includes('first')) {
      let time = 0;
      if (!(await waitForPaintedFrame(video, signal))) {
        // 首帧空白：往前挪一点再试一次（有些片子开头带一帧空图）
        const retry = Math.min(0.05, video.duration / 2);
        if (retry > 0) {
          await seekVideo(video, retry, options.timeoutMs, signal);
          time = retry;
        }
        if (!(await waitForPaintedFrame(video, signal))) {
          throw new Error('视频首帧没有画面（可能是空片头），无法截取');
        }
      }
      frames.push({
        role: 'first',
        data: drawFrame(video, target),
        width: target.width,
        height: target.height,
        time,
      });
    }

    if (wanted.includes('last')) {
      const candidates = tailTimes(video.duration, options.tailOffsets);
      if (!candidates.length) throw new Error('无法读取视频时长（文件可能损坏）');
      const seekBudget = Math.min(options.timeoutMs, TAIL_SEEK_TIMEOUT_MS);
      let captured: CapturedVideoFrame | null = null;
      let lastError: Error | null = null;
      for (const time of candidates) {
        try {
          await seekVideo(video, time, seekBudget, signal);
          if (!(await waitForPaintedFrame(video, signal))) continue;
          captured = {
            role: 'last',
            data: drawFrame(video, target),
            width: target.width,
            height: target.height,
            time,
          };
          break;
        } catch (cause) {
          if (signal?.aborted) throw abortError();
          lastError = cause instanceof Error ? cause : new Error(String(cause));
        }
      }
      if (!captured) {
        throw lastError ?? new Error('视频尾帧没有画面（片尾可能是空白），无法截取');
      }
      frames.push(captured);
    }

    return frames;
  } finally {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* 释放失败不该盖住真正的错误 */
    }
  }
}

/**
 * 截取首帧 / 尾帧。
 *
 * `url` 必须是**页面可直接读取**的地址（跨域素材由调用方先过 `/api/aifisher/canvas/proxy`，
 * 播放器里用 `readableMediaUrl` 做这件事）—— 这里不重复发明 URL 策略。
 *
 * 超时会**换一个新的解码器重试一次**：老 `<video>` 偶发卡在寻址状态（尤其是同一页面里
 * 还有别的解码器在跑时）不会第二次再卡。
 */
export async function captureVideoFrames(
  url: string,
  roles: readonly VideoFrameRole[],
  signal?: AbortSignal,
  options: FrameCaptureOptions = {},
): Promise<CapturedVideoFrame[]> {
  const wanted = [...new Set(roles)].filter((role): role is VideoFrameRole =>
    role === 'first' || role === 'last',
  );
  if (!url || wanted.length === 0) return [];
  if (signal?.aborted) throw abortError();
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Number(options.timeoutMs)
      : FRAME_TIMEOUT_MS;
  const maxEdge =
    Number.isFinite(options.maxEdge) && (options.maxEdge ?? 0) > 0
      ? Number(options.maxEdge)
      : FRAME_MAX_EDGE;
  const resolved = {
    timeoutMs,
    maxEdge,
    tailOffsets: options.tailOffsets ?? TAIL_SEEK_OFFSETS,
  };

  try {
    return await captureOnce(url, wanted, signal, resolved);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (options.retryOnTimeout === false || !isTimeoutError(error)) throw error;
    return captureOnce(url, wanted, signal, resolved);
  }
}

interface VideoFrameCaptureHolder {
  __FISHERAI_VIDEO_FRAMES__?: VideoFrameCaptureAdapter;
}

/**
 * 装配层调用：把取帧桥挂到 `window` 与 `globalThis`。
 *
 * 两处都写与 `CanvasVideoHistory` 同一理由：浏览器里同一个对象，jsdom 里不是；vendor 读 `window`，
 * 回归脚本有时读 `globalThis`。桥不在时 vendor 播放器退回上游的 `firstLastVideoFrames`。
 */
export function installVideoFrameCapture(): { dispose: () => void } {
  const adapter: VideoFrameCaptureAdapter = {
    capture: captureVideoFrames,
    targetSize: frameTargetSize,
    tailTimes,
  };
  const holders = [
    window as unknown as VideoFrameCaptureHolder,
    globalThis as unknown as VideoFrameCaptureHolder,
  ].filter((holder, index, all) => all.indexOf(holder) === index);
  for (const holder of holders) holder.__FISHERAI_VIDEO_FRAMES__ = adapter;
  return {
    dispose() {
      for (const holder of holders) {
        if (holder.__FISHERAI_VIDEO_FRAMES__ === adapter) delete holder.__FISHERAI_VIDEO_FRAMES__;
      }
    },
  };
}

declare global {
  interface Window {
    /** dsh-aifisher-canvas v1.66：视频截帧（首帧 / 尾帧 / 上限 / 空白兜底）。 */
    __FISHERAI_VIDEO_FRAMES__?: VideoFrameCaptureAdapter;
  }
}
