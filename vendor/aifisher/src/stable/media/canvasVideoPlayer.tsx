import { GenerationWaiting } from './GenerationWaiting';
import type * as ReactTypes from 'react';
import {
  useCanvasVideoPlayback,
  type VideoRuntime,
  type VideoNode,
} from './useCanvasVideoPlayback';
import { currentVideoFrame, firstLastVideoFrames } from './videoSnapshots';
import { readableMediaUrl, type MediaMetadata } from './generationMediaMetadata';
import { videoDisplayAspectRatio } from './mediaNodeSizing';
import { installMediaDownloadFileName } from './mediaDownloadFileName';

/**
 * dsh-aifisher-canvas v1.64 —— 视频生成历史（覆盖文件，见 scripts/vendor-aifisher.mjs 3.8w）。
 *
 * 用户原话（2026-10-23）：「仿照图像生成历史记录，做视频生成历史记录功能」。
 *
 * 上游的视频播放器只认 `resultUrl`（这一条），所以在这里补齐图片节点早就有的那套：
 *   · 节点头部一枚 `历史 N` 药丸（`renderHeader` 从 canvasMediaCards 传进来，
 *     与图片卡同一处落点，头部外观因此完全一致）；
 *   · 点开在节点周围扇形摊出 `resultUrls.slice(1)`，每个都是一条能悬停预览的真视频，
 *     角上是「下载历史视频 N」与「设为主视频」两枚按钮（对照 canvasImagePreview 的
 *     「下载历史图片 N」/「设为主图」）；
 *   · 「设为主视频」= 把那条换到 `resultUrls[0]`，并把跟着上一条片子走的
 *     `lastFrame / resultAspectRatio / naturalWidth / naturalHeight` 清掉（新片加载完
 *     `useCanvasVideoPlayback` 会用 loadedmetadata 再量一遍写回）。
 *
 * 数据侧的合并（每次生成把新结果并进 resultUrls）不在这里，见
 * `src/canvas-ui/canvas/CanvasVideoHistory.ts` 与 vendor 补丁里 canvasGeneration /
 * generationRecovery 两处；本文件只读桥、调 `promote()`。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）：产物里 React 有两份副本
 *    （canvas-ui 一份 / vendor 一份），用错那份既不报错也不渲染。这条与上游其余组件一致。
 */

interface VideoHistoryApi {
  urls(node: VideoNode): string[];
  label(node: VideoNode): string;
  promote(node: VideoNode, url: unknown): Record<string, unknown> | null;
}

function videoHistoryApi(): VideoHistoryApi | undefined {
  return (window as unknown as { __FISHERAI_VIDEO_RESULT_HISTORY__?: VideoHistoryApi })
    .__FISHERAI_VIDEO_RESULT_HISTORY__;
}

/**
 * v1.66：取帧算法在插件（`src/canvas-ui/canvas/CanvasVideoFrames.ts`），这里只通过桥调用。
 * 桥不在（单测直接挂组件 / 老产物）时退回上游的 `firstLastVideoFrames`，功能不至于消失。
 */
type VideoFrameRole = 'first' | 'last';
type VideoFrameMode = 'first' | 'last' | 'both';
interface VideoFrameCaptureApi {
  capture(
    url: string,
    roles: readonly VideoFrameRole[],
    signal?: AbortSignal,
  ): Promise<Array<{ role: VideoFrameRole; data: string; time: number }>>;
}
function videoFrameApi(): VideoFrameCaptureApi | undefined {
  return (window as unknown as { __FISHERAI_VIDEO_FRAMES__?: VideoFrameCaptureApi })
    .__FISHERAI_VIDEO_FRAMES__;
}

/** v1.66：截帧菜单项（文案即契约，回归按 `data-fisherai-video-frame-action` 点）。 */
const FRAME_MENU_ITEMS: ReadonlyArray<{ mode: VideoFrameMode; label: string; hint: string }> = [
  { mode: 'first', label: '截取首帧', hint: '第一帧' },
  { mode: 'last', label: '截取尾帧', hint: '最后一帧' },
  { mode: 'both', label: '首尾帧各一张', hint: '共 2 张' },
];

/**
 * v1.68：进度条改成**自己吃指针的拖拽**，不再依赖原生 `<input type=range>` 的手感。
 *
 * 用户报障原话（2026-10-23）：「视频下方进度条拖到不了」。
 *
 * 真机取证（真 Chromium + 他本人那份 canvas.json + 那段 967×544 / 362s / 56MB 的片子）：
 * 原生滑块的拖动能走完（10% → 99% 落到 362.04s），所以坏的不是 seek 链路，是**这根细滑杆的交互**：
 *   · 原生 range 只有 16px 高、拇指 12px；画布缩到 70% 就只剩半个手指高，没戳中拇指 = 什么都不发生
 *     （底栏那片渐变还会把这次按压吞掉，看着就是「拖不动」）；
 *   · 原生拖动的值映射带半个拇指的内缩（点 85% 只到 86.8%），想拖到片尾得把手移出轨道 ——
 *     正好是「拖到不了（片尾）」的手感；
 *   · 拖动途中底栏的受控回写跟着播放时钟走，长片里拇指会被新的 time 拽回去一下。
 * 现在：**整条轨道都能按**（按下即跳到落点）、拖动期间拇指/读数 1:1 跟手（本地 scrub 状态，
 * 不听播放时钟）、seek 按 120ms 节流并在松手时补最后一发；松手后真在寻址时显示「定位中…」，
 * 不让慢解码看起来像"没拖到"。
 */
const SCRUB_SEEK_INTERVAL_MS = 120;
const SCRUB_SETTLE_TOLERANCE_SEC = 0.6;
const SCRUB_PENDING_TIMEOUT_MS = 5000;

/**
 * 这个节点现在有哪些片子（主视频在前）。
 * 桥没装（只有单测直接挂组件才会发生）时退回最简单的读法，面板照常能看。
 */
function historyUrls(node: VideoNode): string[] {
  const api = videoHistoryApi();
  if (api) return api.urls(node);
  const stored = (node as { resultUrls?: unknown }).resultUrls;
  const urls = (Array.isArray(stored) ? stored : []).filter(
    (url): url is string => typeof url === 'string' && Boolean(url.trim()),
  );
  return urls.length ? urls : typeof node.resultUrl === 'string' && node.resultUrl ? [node.resultUrl] : [];
}

/** 药丸的可读文案：`历史 5` / `本次 2` / `本次 2 · 历史 6`（与图片同一套口径）。 */
function historyLabel(node: VideoNode, urls: string[]): string {
  const api = videoHistoryApi();
  if (api) return api.label(node);
  const current = Number((node as { currentResultCount?: unknown }).currentResultCount);
  if (!Number.isFinite(current)) return `历史 ${urls.length}`;
  return current === urls.length ? `本次 ${current}` : `本次 ${current} · 历史 ${urls.length}`;
}

type Icon = ReactTypes.ComponentType<{
  size?: number;
  className?: string;
  fill?: string;
}>;
interface Components {
  MuteIcon: Icon;
  VolumeIcon: Icon;
  PlayIcon: Icon;
  PauseIcon: Icon;
  FramesIcon: Icon;
  SnapshotIcon: Icon;
  DownloadIcon: Icon;
  Spinner: Icon;
  ImageIcon: Icon;
  VideoIcon: Icon;
  Tooltip: ReactTypes.ComponentType<{
    text: string;
    children: ReactTypes.ReactNode;
  }>;
  nodeWidth(node: VideoNode): number;
  nodeHeight(node: VideoNode): number;
}
interface Props {
  data: VideoNode;
  selected?: boolean;
  inputUrl?: string;
  /** v1.64：节点头部由本组件画（好在标题右边塞「历史 N」那枚药丸）。 */
  renderHeader?(historyControl: ReactTypes.ReactNode): ReactTypes.ReactNode;
  onSnapshot?(data: string): void | Promise<unknown>;
  onSnapshotFirstLast?(first: string, last: string): void | Promise<unknown>;
  /** 第二个参数是节点补丁（v1.64 起「设为主视频」会带 resultUrl/resultUrls）。 */
  onUpdate?(id: string, metadata: MediaMetadata): void;
}
export function CanvasVideoPlayer(
  React: VideoRuntime,
  { data, selected, inputUrl, renderHeader, onSnapshot, onSnapshotFirstLast, onUpdate }: Props,
  {
    MuteIcon,
    VolumeIcon,
    PlayIcon,
    PauseIcon,
    FramesIcon,
    SnapshotIcon,
    DownloadIcon,
    ImageIcon,
    VideoIcon,
    Tooltip,
    nodeWidth,
    nodeHeight,
  }: Components,
) {
  const playback = useCanvasVideoPlayback(React, data, onUpdate),
    {
      videoRef,
      playing,
      time,
      duration,
      muted,
      volume,
      buffering,
      error: playbackError,
    } = playback;
  const [hover, setHover] = React.useState(false),
    [expanded, setExpanded] = React.useState(false),
    [snapshotBusy, setSnapshotBusy] = React.useState(false),
    [snapshotError, setSnapshotError] = React.useState(''),
    // v1.66：截帧菜单（首帧 / 尾帧 / 首尾帧各一张）与成功回执
    [frameMenu, setFrameMenu] = React.useState(false),
    [snapshotNote, setSnapshotNote] = React.useState(''),
    // v1.68：进度条自己的拖拽状态（拖动中拇指跟指针走，不听播放时钟）
    [scrubbing, setScrubbing] = React.useState(false),
    [scrubTime, setScrubTime] = React.useState(0),
    [seekPending, setSeekPending] = React.useState(false);
  const operationRef = React.useRef<AbortController | null>(null),
    ownerRef = React.useRef<object | null>(null),
    seekTrackRef = React.useRef<HTMLDivElement | null>(null),
    seekInputRef = React.useRef<HTMLInputElement | null>(null),
    /** 拖动会话：active / pointerId / 最新目标 / 上次真正 seek 的时刻 / 尾发定时器 / 落点探测定时器。 */
    scrubRef = React.useRef({
      active: false,
      pointerId: -1,
      target: 0,
      lastSeekAt: 0,
      tailTimer: 0,
      landingTimer: 0,
    });
  React.useEffect(() => {
    ownerRef.current = {};
    setSnapshotBusy(false);
    setSnapshotError('');
    setSnapshotNote('');
    setFrameMenu(false);
    // 换片（含「设为主视频」）就把扇形收起来 —— 摊着的是上一组历史，位置已经对不上了
    setExpanded(false);
    // v1.68：换片时把拖拽态也收干净（旧片的目标时长对不上新片）
    scrubRef.current.active = false;
    scrubRef.current.target = 0;
    setScrubbing(false);
    setSeekPending(false);
    return () => {
      ownerRef.current = null;
      operationRef.current?.abort();
      operationRef.current = null;
      // v1.68：定时器必须在这一轮卸载前摘掉，否则旧片的 seek 会打到新片上
      window.clearTimeout(scrubRef.current.tailTimer);
      window.clearTimeout(scrubRef.current.landingTimer);
      scrubRef.current.tailTimer = 0;
      scrubRef.current.landingTimer = 0;
      scrubRef.current.active = false;
    };
  }, [data.id, data.projectId, data.resultUrl]);
  // 成功回执自己消失（失败的那条留到下一次操作/换片，用户要能看清原因）
  React.useEffect(() => {
    if (!snapshotNote) return undefined;
    const timer = setTimeout(() => setSnapshotNote(''), 2600);
    return () => clearTimeout(timer);
  }, [snapshotNote]);
  const isLoading = data.status === 'loading',
    hasResult = !!data.resultUrl;
  const urls = historyUrls(data),
    multiple = urls.length > 1;
  /** v1.68：拖动中读数跟指针，不跟播放时钟（否则长片里拇指会被 timeupdate 拽回去）。 */
  const displayTime = scrubbing ? scrubTime : time;
  const togglePlay = (event: ReactTypes.SyntheticEvent) => {
    event.stopPropagation();
    void playback.toggle();
  };
  const toggleSound = (event: ReactTypes.SyntheticEvent) => {
    event.stopPropagation();
    playback.toggleMuted();
  };
  const changeVolume = (event: ReactTypes.ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    playback.changeVolume(Number(event.currentTarget.value));
  };
  const seek = (event: ReactTypes.ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    // v1.68：拖动中由 scrub 接管（键盘方向键仍走这里）
    if (scrubRef.current.active) return;
    playback.seek(Number(event.currentTarget.value));
  };
  /**
   * v1.68：指针位置 → 目标秒数。**按整条轨道算**（不学原生滑块那半个拇指的内缩），
   * 所以点最右边就是片尾、点最左边就是 0。
   */
  const timeAtPointer = (clientX: number): number | null => {
    const track = seekTrackRef.current;
    if (!track || !(duration > 0)) return null;
    const rect = track.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };
  /** 落点探测：松手后真在寻址就显示「定位中…」，落到位（或超时）就收掉。 */
  const watchSeekLanding = (target: number) => {
    const scrub = scrubRef.current;
    window.clearTimeout(scrub.landingTimer);
    setSeekPending(true);
    const startedAt = Date.now();
    const tick = () => {
      const video = videoRef.current;
      const landed =
        !video ||
        (!video.seeking &&
          video.readyState >= 2 &&
          Number.isFinite(video.currentTime) &&
          Math.abs(video.currentTime - target) <= SCRUB_SETTLE_TOLERANCE_SEC);
      if (landed || Date.now() - startedAt > SCRUB_PENDING_TIMEOUT_MS) {
        setSeekPending(false);
        return;
      }
      scrub.landingTimer = window.setTimeout(tick, 100);
    };
    scrub.landingTimer = window.setTimeout(tick, 140);
  };
  /**
   * v1.68：把拖动落点写下去。`commit` = 必须立刻 seek（按下 / 松手 / 键盘）；
   * 否则按 `SCRUB_SEEK_INTERVAL_MS` 节流（长片里 60Hz 连打会把解码器打乱），
   * 并且**始终留一发尾发**，保证松手前最后一个位置会被提交。
   */
  const applyScrub = (target: number, commit: boolean) => {
    const scrub = scrubRef.current;
    scrub.target = target;
    setScrubTime(target);
    const now = Date.now();
    if (commit) {
      scrub.lastSeekAt = now;
      playback.seek(target);
      return;
    }
    const wait = SCRUB_SEEK_INTERVAL_MS - (now - scrub.lastSeekAt);
    if (wait <= 0) {
      scrub.lastSeekAt = now;
      playback.seek(target);
      return;
    }
    if (scrub.tailTimer) return;
    scrub.tailTimer = window.setTimeout(() => {
      scrub.tailTimer = 0;
      if (!scrubRef.current.active) return;
      scrubRef.current.lastSeekAt = Date.now();
      playback.seek(scrubRef.current.target);
    }, wait);
  };
  const startScrub = (event: ReactTypes.PointerEvent<HTMLDivElement>) => {
    if (event.button !== undefined && event.button > 0) return;
    const target = timeAtPointer(event.clientX);
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    const scrub = scrubRef.current;
    scrub.active = true;
    scrub.pointerId = event.pointerId;
    scrub.lastSeekAt = 0;
    setScrubbing(true);
    setSeekPending(false);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* jsdom / 老浏览器没有指针捕获：靠 onPointerMove 在轨道上也能拖 */
    }
    // 点过轨道之后方向键也能接着用（input 现在 pointer-events:none，不会被点中）
    try {
      seekInputRef.current?.focus({ preventScroll: true });
    } catch {
      /* 老浏览器不认 preventScroll */
    }
    applyScrub(target, true);
  };
  const moveScrub = (event: ReactTypes.PointerEvent<HTMLDivElement>) => {
    const scrub = scrubRef.current;
    if (!scrub.active) return;
    if (event.buttons === 0) {
      // 指针捕获丢了（例如松手事件被别的层吃掉）：按松手处理，别让读数永远停在拖动态
      finishScrub(event.clientX);
      return;
    }
    const target = timeAtPointer(event.clientX);
    if (target === null) return;
    event.stopPropagation();
    applyScrub(target, false);
  };
  const finishScrub = (clientX: number) => {
    const scrub = scrubRef.current;
    if (!scrub.active) return;
    scrub.active = false;
    window.clearTimeout(scrub.tailTimer);
    scrub.tailTimer = 0;
    const target = timeAtPointer(clientX) ?? scrub.target;
    applyScrub(target, true);
    setScrubbing(false);
    watchSeekLanding(target);
  };
  const endScrub = (event: ReactTypes.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    finishScrub(event.clientX);
  };
  const formatTime = (value: number) => {
    const seconds = Number.isFinite(value) ? Math.max(0, value) : 0;
    return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0')}`;
  };
  const frameStyle = (): ReactTypes.CSSProperties => {
    return {
      aspectRatio: `${videoDisplayAspectRatio(data)} / 1`,
    };
  };
  /**
   * 历史叠的落位：与图片那套同一份几何 —— 绕当前这张按「右 / 上 / 右上 / 左」四角一圈圈往外排，
   * 一圈 4 个，间距 16px。视觉上就是「从节点里抽出来」的一叠。
   */
  const optionStyle = (index: number): ReactTypes.CSSProperties => {
    const width = nodeWidth(data),
      height = nodeHeight(data);
    const ring = Math.floor(index / 4) + 1;
    const offsets = [
      { left: (width + 16) * ring, top: 0 },
      { left: 0, top: -(height + 16) * ring },
      { left: (width + 16) * ring, top: -(height + 16) * ring },
      { left: -(width + 16) * ring, top: 0 },
    ];
    return { width: `${width}px`, height: `${height}px`, ...offsets[index % 4], zIndex: 50 };
  };
  const downloadHistory = (url: string, button: HTMLButtonElement) => {
    const adapter = window.__FISHERAI_MEDIA_DOWNLOAD__ || installMediaDownloadFileName();
    let extension = '';
    try {
      extension =
        new URL(url, window.location.origin).pathname
          .match(/\.([a-z0-9]+)$/i)?.[1]
          .toLowerCase() || '';
    } catch {
      /* data URL: 用视频的默认后缀 */
    }
    extension ||= 'mp4';
    void adapter.download(data, url, extension, button);
  };
  const promoteHistory = (url: string) => {
    const patch = videoHistoryApi()?.promote(data, url);
    // 已经在主位 / 不在历史里 → 什么都不做，只把扇形收起来
    if (patch) onUpdate?.(data.id, patch as unknown as MediaMetadata);
    setExpanded(false);
  };
  const capture = async (ends: boolean) => {
    const owner = ownerRef.current,
      video = videoRef.current;
    if (!owner || !video || !data.resultUrl || operationRef.current) return;
    const request = new AbortController();
    operationRef.current = request;
    setSnapshotBusy(true);
    setSnapshotError('');
    const valid = () => ownerRef.current === owner && !request.signal.aborted;
    try {
      if (ends) {
        const [first, last] = await firstLastVideoFrames(data.resultUrl, request.signal);
        if (valid()) await onSnapshotFirstLast?.(first, last);
      } else {
        const frame = currentVideoFrame(video);
        if (valid()) await onSnapshot?.(frame);
      }
    } catch (cause) {
      if (valid()) setSnapshotError(cause instanceof Error ? cause.message : '截图失败，请重试');
    } finally {
      if (operationRef.current === request) {
        operationRef.current = null;
        if (valid()) setSnapshotBusy(false);
      }
    }
  };
  /**
   * v1.66：按角色截帧（首帧 / 尾帧 / 两张）。
   *
   * 与「截图」不同：截图取的是**播放器当前停住的那一帧**；这里用一个独立解码器取视频的
   * 首/尾帧，不动播放进度。单帧时另一侧传空串，vendor 侧（补丁 3.8x）会跳过空帧，
   * 所以不会再多掉一个要删的节点。
   */
  const captureFrames = async (mode: VideoFrameMode) => {
    const owner = ownerRef.current;
    if (!owner || !data.resultUrl || operationRef.current || !onSnapshotFirstLast) return;
    const request = new AbortController();
    operationRef.current = request;
    setFrameMenu(false);
    setSnapshotBusy(true);
    setSnapshotError('');
    setSnapshotNote('');
    const valid = () => ownerRef.current === owner && !request.signal.aborted;
    const note = mode === 'both' ? '已截取首尾帧' : mode === 'first' ? '已截取首帧' : '已截取尾帧';
    try {
      const url = readableMediaUrl(data.resultUrl);
      const roles: VideoFrameRole[] = mode === 'both' ? ['first', 'last'] : [mode];
      const bridge = videoFrameApi();
      let frames: Array<{ role: VideoFrameRole; data: string }>;
      if (bridge) {
        frames = await bridge.capture(url, roles, request.signal);
      } else {
        // 桥没装（单测直接挂组件 / 老产物）：退回上游的一次性首尾帧
        const [first, last] = await firstLastVideoFrames(url, request.signal);
        frames = [
          ...(mode !== 'last' ? [{ role: 'first' as const, data: first }] : []),
          ...(mode !== 'first' ? [{ role: 'last' as const, data: last }] : []),
        ];
      }
      if (!valid()) return;
      const first = frames.find((frame) => frame.role === 'first')?.data ?? '';
      const last = frames.find((frame) => frame.role === 'last')?.data ?? '';
      if (!first && !last) throw new Error('没有截到画面，请稍后重试');
      await onSnapshotFirstLast(first, last);
      if (valid()) setSnapshotNote(note);
    } catch (cause) {
      if (valid()) setSnapshotError(cause instanceof Error ? cause.message : '截图失败，请重试');
    } finally {
      if (operationRef.current === request) {
        operationRef.current = null;
        if (valid()) setSnapshotBusy(false);
      }
    }
  };
  const snapshot = (event: ReactTypes.SyntheticEvent) => {
    event.stopPropagation();
    void capture(false);
  };
  /** 头部那枚药丸：与图片预览的 `历史 N` 同款（文案、无障碍标签、展开箭头都一样）。 */
  const indicatorLabel = historyLabel(data, urls);
  const historyControl =
    multiple && hasResult && !isLoading ? (
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setExpanded(!expanded);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') setExpanded(false);
        }}
        data-fisherai-video-history-indicator="true"
        aria-label={indicatorLabel}
        title={indicatorLabel}
        aria-expanded={expanded}
        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-[var(--af-surface)] text-[var(--af-text-secondary)] hover:bg-[var(--af-hover)] hover:text-[var(--af-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--af-focus)] transition-colors"
      >
        <span>历史 {urls.length}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    ) : null;

  const content = (
    <div
      // v1.64：外框不能再 overflow-hidden —— 历史叠是**摊到节点外面**的扇形，
      // 剪裁在节点边界上就只剩看不见的一角。圆角挪给里面那层视频（见下面 streaming 层）。
      className={'w-full h-full rounded-lg overflow-visible'}
      onMouseEnter={() => setHover(!0)}
      onMouseLeave={() => {
        setHover(!1);
        // 底栏收起来时菜单跟着收（菜单挂在底栏里，留着会浮在节点外面）
        setFrameMenu(false);
      }}
    >
      {(hasResult || isLoading) && data.resultUrl ? (
        <div
          data-af-media-chrome
          className={'relative w-full h-full group/video-container'}
          style={frameStyle()}
        >
          <div
            data-fisherai-video-streaming={'true'}
            className={'absolute inset-0 overflow-hidden rounded-lg bg-black'}
          >
            <video
              ref={videoRef}
              src={data.resultUrl}
              loop={false}
              muted={muted}
              playsInline={!0}
              preload={selected ? 'auto' : 'metadata'}
              className={'w-full h-full object-cover cursor-pointer pointer-events-auto'}
              onClick={(event) => {
                togglePlay(event);
              }}
            />
          </div>
          {buffering && !playbackError ? (
            <div
              data-fisherai-video-buffering={'true'}
              role={'status'}
              className={
                'pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/45 text-xs font-medium text-white/90'
              }
            >
              {'正在准备视频…'}
            </div>
          ) : null}
          {playbackError ? (
            <div
              data-fisherai-video-error={'true'}
              role={'alert'}
              className={
                'absolute inset-0 z-20 grid place-items-center bg-black/75 px-6 text-center text-xs font-medium text-rose-200'
              }
            >
              <div>
                <p>{playbackError}</p>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    playback.retry();
                  }}
                >
                  重新加载视频
                </button>
              </div>
            </div>
          ) : null}
          {hasResult && (
            <div
              data-fisherai-video-volume={'true'}
              className={`absolute top-2 left-2 z-30 flex h-8 items-center gap-1.5 rounded-lg border border-white/15 bg-black/55 px-1.5 text-white backdrop-blur-sm transition-all duration-200 ${hover ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type={'button'}
                aria-label={muted ? '取消静音' : '静音'}
                onClick={toggleSound}
                className={'grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-white/10'}
              >
                {muted || volume === 0 ? <MuteIcon size={14} /> : <VolumeIcon size={14} />}
              </button>
              <input
                type={'range'}
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={changeVolume}
                aria-label={'视频音量'}
                aria-valuetext={Math.round(volume * 100) + '%'}
                className={'h-3 w-20 cursor-pointer accent-white'}
              />
              <span className={'w-7 text-right text-[10px] tabular-nums text-white/80'}>
                {Math.round(volume * 100) + '%'}
              </span>
            </div>
          )}
          {hasResult && (
            <div
              /**
               * v1.68：**收起来时要 pointer-events-none**。以前只把透明度收到 0，
               * 那片 56px 高的渐变仍然在吃按下事件 —— 在视频底部想点播放/拖进度条，
               * 只要没精确戳到轨道就"什么都不发生"，这也是「拖到不了」的一部分。
               */
              data-fisherai-video-bar={'true'}
              className={`absolute bottom-0 left-0 right-0 z-30 px-3 pb-2.5 pt-8 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex items-center gap-2.5 transition-all duration-300 ease-out ${hover || scrubbing ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                aria-label={playing ? '暂停视频' : '播放视频'}
                onClick={togglePlay}
                onPointerDown={(event) => event.stopPropagation()}
                className={'text-white hover:text-white/80 shrink-0 transition-colors z-50'}
              >
                {playing ? (
                  <PauseIcon size={16} fill={'currentColor'} />
                ) : (
                  <PlayIcon size={16} fill={'currentColor'} />
                )}
              </button>
              <span
                className={
                  'text-[11px] text-white/90 tabular-nums min-w-[34px] text-right shrink-0 leading-none'
                }
              >
                {formatTime(displayTime)}
              </span>
              <div className={'flex-1 flex items-center'}>
                {/* v1.68：整条轨道（含上下 2px 余量）都吃指针；range 只当拇指与无障碍控件。 */}
                <div
                  ref={seekTrackRef}
                  data-fisherai-video-seek-track={'true'}
                  onPointerDown={startScrub}
                  onPointerMove={moveScrub}
                  onPointerUp={endScrub}
                  onPointerCancel={endScrub}
                  onLostPointerCapture={(event) => {
                    if (scrubRef.current.active) finishScrub(event.clientX);
                  }}
                  className={
                    'relative w-full flex items-center h-5 py-0.5 touch-none select-none cursor-pointer'
                  }
                >
                  <div
                    className={
                      'absolute left-0 right-0 h-1 bg-white/20 rounded-full pointer-events-none'
                    }
                  >
                    <div
                      className={'absolute left-0 top-0 h-full bg-white rounded-full'}
                      style={{ width: `${(displayTime / (duration || 1)) * 100}%` }}
                    />
                  </div>
                  <input
                    ref={seekInputRef}
                    aria-label={'视频播放进度'}
                    type={'range'}
                    min={'0'}
                    max={duration || 0}
                    step={'0.01'}
                    value={displayTime}
                    onChange={seek}
                    data-fisherai-video-seek={'true'}
                    className={`relative w-full h-4 bg-transparent appearance-none z-10 pointer-events-none touch-none
                      [&::-webkit-slider-thumb]:appearance-none
                      [&::-webkit-slider-thumb]:w-3
                      [&::-webkit-slider-thumb]:h-3
                      [&::-webkit-slider-thumb]:rounded-full
                      [&::-webkit-slider-thumb]:bg-white
                      [&::-webkit-slider-thumb]:shadow-lg
                      [&::-moz-range-thumb]:w-3
                      [&::-moz-range-thumb]:h-3
                      [&::-moz-range-thumb]:rounded-full
                      [&::-moz-range-thumb]:bg-white
                      [&::-moz-range-thumb]:shadow-lg
                      [&::-moz-range-thumb]:border-0`}
                  />
                </div>
              </div>
              <span
                className={
                  'text-[11px] text-white/90 tabular-nums min-w-[34px] shrink-0 leading-none'
                }
              >
                {formatTime(duration)}
              </span>
              {seekPending && (
                <span
                  role={'status'}
                  data-fisherai-video-seek-pending={'true'}
                  className={
                    'pointer-events-none absolute right-2 top-0 -translate-y-full rounded bg-black/60 px-1.5 py-0.5 text-[10px] leading-none text-white/85 backdrop-blur-sm'
                  }
                >
                  {'定位中…'}
                </span>
              )}
              {(onSnapshot || onSnapshotFirstLast) && (
                <div className={'flex items-center gap-1.5 shrink-0'}>
                  {onSnapshotFirstLast && (
                    <div className={'relative'}>
                      <Tooltip text={'截取首帧 / 尾帧'}>
                        <button
                          aria-label="截取视频帧"
                          aria-haspopup="menu"
                          aria-expanded={frameMenu}
                          data-fisherai-video-frame-trigger="true"
                          disabled={snapshotBusy}
                          onClick={(event) => {
                            event.stopPropagation();
                            setFrameMenu(!frameMenu);
                          }}
                          className={
                            'flex items-center gap-0.5 text-white hover:text-blue-400 transition-colors disabled:opacity-50'
                          }
                        >
                          <FramesIcon size={16} />
                          <svg
                            width={8}
                            height={8}
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            aria-hidden="true"
                          >
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </button>
                      </Tooltip>
                      {frameMenu && (
                        <div
                          role={'menu'}
                          aria-label={'截取视频帧'}
                          data-fisherai-video-frame-menu="true"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === 'Escape') setFrameMenu(false);
                          }}
                          className={
                            'absolute bottom-[calc(100%+6px)] right-0 z-50 w-36 overflow-hidden rounded-md ' +
                            'border border-white/15 bg-black/80 py-1 text-[11px] text-white shadow-xl backdrop-blur-sm'
                          }
                        >
                          {FRAME_MENU_ITEMS.map((item) => (
                            <button
                              key={item.mode}
                              type="button"
                              role={'menuitem'}
                              data-fisherai-video-frame-action={item.mode}
                              disabled={snapshotBusy}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                void captureFrames(item.mode);
                              }}
                              className={
                                'flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left ' +
                                'hover:bg-white/10 disabled:opacity-50'
                              }
                            >
                              <span>{item.label}</span>
                              <span className={'text-[10px] text-white/45'}>{item.hint}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <Tooltip text={'截图（当前画面）'}>
                    <button
                      aria-label="视频截图"
                      disabled={snapshotBusy}
                      onClick={snapshot}
                      className={'text-white hover:text-blue-400 transition-colors disabled:opacity-50'}
                    >
                      <SnapshotIcon size={16} />
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          )}
          {/* ---- v1.64：历史叠（扇形摊在节点周围；悬停即预览，按钮才动数据）---- */}
          {expanded &&
            urls.slice(1).map((url, index) => (
              <div
                className={
                  'group/item absolute overflow-hidden rounded-lg bg-[var(--af-media-bg)] shadow-2xl ' +
                  'animate-in fade-in zoom-in-95 border border-[var(--af-border-control)]'
                }
                style={optionStyle(index)}
                data-fisherai-video-history={url}
                data-fisherai-video-history-index={index + 1}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                key={url}
              >
                <video
                  src={url}
                  muted
                  playsInline
                  loop
                  preload={'metadata'}
                  aria-label={`历史视频 ${index + 1}`}
                  className={'w-full h-full object-contain'}
                  onMouseEnter={(event) => {
                    const video = event.currentTarget;
                    video.dataset.hovered = 'true';
                    void video
                      .play()
                      .then(() => {
                        if (video.dataset.hovered !== 'true') video.pause();
                      })
                      .catch(() => {});
                  }}
                  onMouseLeave={(event) => {
                    const video = event.currentTarget;
                    video.dataset.hovered = '';
                    video.pause();
                    video.currentTime = 0;
                  }}
                />
                <span
                  className={
                    'pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 ' +
                    'text-[10px] font-medium tabular-nums text-white/90 backdrop-blur-sm'
                  }
                >
                  {index + 2}
                </span>
                <div
                  data-af-media-chrome
                  className={
                    'absolute top-2 right-2 flex gap-2 opacity-0 group-hover/item:opacity-100 transition-opacity duration-300'
                  }
                >
                  <button
                    type="button"
                    onClick={(event) => downloadHistory(url, event.currentTarget)}
                    aria-label={`下载历史视频 ${index + 1}`}
                    className={
                      'inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-white/20 ' +
                      'bg-black/50 text-white shadow-xl backdrop-blur-md transition-all hover:bg-black'
                    }
                  >
                    <DownloadIcon size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => promoteHistory(url)}
                    className={
                      'inline-flex h-9 cursor-pointer items-center justify-center rounded-md border border-white/20 ' +
                      'bg-black/50 px-4 text-sm font-bold text-white shadow-xl backdrop-blur-md transition-all hover:bg-black'
                    }
                  >
                    {'设为主视频'}
                  </button>
                </div>
              </div>
            ))}
          {isLoading && <GenerationWaiting operation="视频生成" />}
        </div>
      ) : (
        <div
          className={`relative w-full h-full bg-[var(--af-surface)] text-[var(--af-text)] flex flex-col items-center justify-center gap-3

          ${!selected || isLoading ? 'rounded-lg' : 'rounded-lg border border-dashed border-[var(--af-border-control)]'}`}
        >
          {inputUrl && (
            <div className={'absolute inset-0 z-0'}>
              <img
                src={inputUrl}
                alt={'Input Frame'}
                className={'w-full h-full object-cover opacity-30 blur-sm'}
                draggable={!1}
              />
              <div className="absolute inset-0 bg-[var(--af-surface)] opacity-70" />
              <div
                data-af-media-chrome
                className={
                  'absolute top-2 left-2 px-2 py-1 bg-black/60 rounded text-[10px] text-white font-medium flex items-center gap-1'
                }
              >
                <ImageIcon size={10} />
                {'Input Frame'}
              </div>
            </div>
          )}
          {isLoading ? (
            <GenerationWaiting operation="视频生成" />
          ) : (
            <div className={'relative z-10 flex flex-col items-center gap-3'}>
              <div className={'text-[var(--af-text-muted)]'}>
                <VideoIcon size={40} />
              </div>
              {selected && inputUrl && (
                <div
                  className={
                    'absolute top-[calc(100%+8px)] left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--af-surface)] px-2 py-1 text-[var(--af-text-secondary)] text-sm font-medium'
                  }
                >
                  {'准备生成视频'}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
  return (
    <div
      data-fisherai-video-player="true"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {/* 头部（标题 / 尺寸 / 历史药丸）：由 canvasMediaCards 经 renderHeader 传进来。
          它自己就是 `bottom: calc(100% + 4px)` 的绝对定位，所以外层只要有 position: relative 就落对了位置。 */}
      {renderHeader ? (
        renderHeader(historyControl)
      ) : (
        <div className={'absolute right-0'} style={{ bottom: 'calc(100% + 4px)' }}>
          {historyControl}
        </div>
      )}
      {content}
      {(snapshotError || snapshotBusy || snapshotNote) && (
        <div
          role={snapshotError ? 'alert' : 'status'}
          data-fisherai-video-frame-status={snapshotError ? 'error' : snapshotBusy ? 'busy' : 'done'}
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 40,
            zIndex: 40,
            background: snapshotError ? 'var(--af-danger-bg)' : 'var(--af-surface-raised)',
            color: snapshotError ? 'var(--af-danger)' : 'var(--af-text)',
            fontSize: 12,
            padding: 8,
            borderRadius: 6,
          }}
        >
          {snapshotError || (snapshotBusy ? '正在截取视频画面…' : snapshotNote)}
        </div>
      )}
    </div>
  );
}
