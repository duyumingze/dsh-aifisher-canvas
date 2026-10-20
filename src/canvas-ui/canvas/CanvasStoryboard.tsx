/**
 * 轻量分镜板（v1.59，P1 第五项）。
 *
 * ## 只做一件事：按镜头顺序「看」
 *
 * 路线图里对它的限定是「按镜头顺序排列/播放，不搬完整导演台」。所以这里**不**做
 * 时间轴、轨道、转场、音频混音 —— 就是一条可横向滚动的缩略图带 + 一个播放键：
 *   - 顺序：标题里的镜头号（镜头 3 / 分镜03 / shot 3）优先，算不出的按坐标（上→下、左→右）；
 *   - 点一张：把画布聚焦到那个节点（复用 vendor 的 `__FISHERAI_FOCUS_NODES__`）；
 *   - 播放：每 1.5s 前进一张并聚焦，播到结尾自动停（像翻画稿，不是视频播放器）。
 *
 * ## 为什么挂在 Controls 槽位
 *
 * 画布只给这一个槽位同时喂了 `nodes` / `viewport` / `projectId` / `documentEpoch`
 * （见 src/client/canvas/stage.tsx 的 CanvasViewportControlsBound）。为了一个缩略图带
 * 去改 vendor 的依赖契约不值得 —— 这是 e2e 最容易崩的地方。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）：产物里有两份 React。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import { ClapperboardIcon, PauseIcon, PlayIcon, XIcon } from 'lucide-react';

type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'Fragment' | 'useState' | 'useEffect' | 'useRef' | 'useCallback'
>;

/** 画布节点里分镜板真正用到的字段（其余忽略）。 */
export interface StoryboardNode {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  status?: unknown;
  x?: unknown;
  y?: unknown;
  resultUrl?: unknown;
  resultUrls?: unknown;
}

export interface StoryboardShot {
  id: string;
  title: string;
  type: string;
  status: string;
  /** 标题里解析出的镜头号（算不出就 null）。 */
  number: number | null;
  /** 第一张结果图的 URL（没有就空串）。 */
  thumb: string;
  x: number;
  y: number;
}

/** 播放时每张停留多久（毫秒）。 */
export const STORYBOARD_PLAY_INTERVAL_MS = 1500;

/** 分镜板只关心有画面的节点。 */
const SHOT_TYPES = new Set(['image', 'video']);

/**
 * 从标题解析镜头号：`镜头 3` / `分镜3` / `镜 03` / `shot 3` / 标题开头 `01.`。
 * 只认 1–3 位数字，避免把 `1920x1080` 之类当镜头号。
 */
export function storyboardNumber(title: string): number | null {
  const text = String(title ?? '').trim();
  if (!text) return null;
  const match =
    /(?:镜头|分镜|镜|shot|sh)[\s#:：·\-_]*(\d{1,3})/i.exec(text) ?? /^(\d{1,3})[\s.、:：)·\-_]/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function thumbOf(node: Record<string, unknown>): string {
  if (typeof node.resultUrl === 'string' && node.resultUrl) return node.resultUrl;
  const list = Array.isArray(node.resultUrls) ? node.resultUrls : [];
  const first = list.find((value): value is string => typeof value === 'string' && value.length > 0);
  return first ?? '';
}

/**
 * 节点 → 分镜顺序。
 *
 * 排序规则与 host 侧一致性覆盖率（src/host/canvas/consistency.ts 的 orderShots）**同一套**：
 * 两边不一致会出现「板子上的第 3 张和锁定顺序的第 3 个不是同一个镜头」。
 */
export function buildStoryboardShots(nodes: readonly unknown[]): StoryboardShot[] {
  const shots: StoryboardShot[] = [];
  for (const raw of nodes) {
    const node = record(raw);
    if (!node) continue;
    const id = typeof node.id === 'string' ? node.id : '';
    if (!id) continue;
    const type = String(node.type ?? '');
    if (!SHOT_TYPES.has(type.toLowerCase())) continue;
    const title = typeof node.title === 'string' && node.title ? node.title : id;
    shots.push({
      id,
      title,
      type,
      status: typeof node.status === 'string' ? node.status : 'unknown',
      number: storyboardNumber(title),
      thumb: thumbOf(node),
      x: typeof node.x === 'number' ? node.x : 0,
      y: typeof node.y === 'number' ? node.y : 0,
    });
  }
  return shots.sort((a, b) => {
    if (a.number !== null && b.number !== null) return a.number - b.number;
    if (a.number !== null) return -1;
    if (b.number !== null) return 1;
    return a.y - b.y || a.x - b.x;
  });
}

/** 聚焦到某个节点：优先用 vendor 挂的全局入口，退回全量聚焦。 */
export function focusStoryboardNode(
  id: string,
  fallback?: (nodeIds: string[]) => void,
): void {
  const holder = window as unknown as {
    __FISHERAI_FOCUS_NODES__?: (nodeIds: readonly string[]) => void;
  };
  if (typeof holder.__FISHERAI_FOCUS_NODES__ === 'function') {
    holder.__FISHERAI_FOCUS_NODES__([id]);
    return;
  }
  fallback?.([id]);
}

export interface CanvasStoryboardProps {
  view?: string;
  nodes?: unknown[];
  selectedNodeIds?: string[];
  documentEpoch?: number;
  /** 兜底聚焦（vendor 没挂全局入口时）。 */
  onFocusFallback?: (nodeIds: string[]) => void;
}

const PANEL_STYLE: ReactTypes.CSSProperties = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  bottom: 84,
  zIndex: 45,
  width: 620,
  maxWidth: 'calc(100% - 340px)',
  pointerEvents: 'auto',
};

const BUTTON_STYLE: ReactTypes.CSSProperties = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  bottom: 24,
  zIndex: 45,
  pointerEvents: 'auto',
};

const STATUS_DOT: Record<string, string> = {
  success: 'bg-emerald-400',
  loading: 'bg-sky-400 animate-pulse',
  error: 'bg-rose-500',
  failed: 'bg-rose-500',
};

/** 诊断上报：分镜板开没开、认出几个镜头、播到第几张。 */
export function storyboardReport(): Record<string, unknown> {
  const panel = document.querySelector('[data-fisherai-storyboard="true"]');
  const cards = panel ? panel.querySelectorAll('[data-fisherai-storyboard-shot]').length : 0;
  const playing = panel?.querySelector('[data-fisherai-storyboard-playing="true"]') !== null && panel !== null;
  return { open: Boolean(panel), shots: cards, playing };
}

export function CanvasStoryboard(
  react: Runtime,
  props: CanvasStoryboardProps = {},
): ReactTypes.ReactNode {
  const h = createElement(react);
  const [open, setOpen] = react.useState(false);
  const [playing, setPlaying] = react.useState(false);
  const [index, setIndex] = react.useState(0);
  const shots = buildStoryboardShots(Array.isArray(props.nodes) ? props.nodes : []);
  const shotsRef = react.useRef(shots);
  shotsRef.current = shots;

  // 切项目（documentEpoch 变）就收起并停止播放：旧项目的镜头序号在这里没有意义。
  react.useEffect(() => {
    setPlaying(false);
    setIndex(0);
  }, [props.documentEpoch]);

  // 播放：按时聚焦下一张；到结尾或组件卸载就停。
  react.useEffect(() => {
    if (!playing || !open) return undefined;
    const timer = window.setInterval(() => {
      const list = shotsRef.current;
      if (list.length === 0) {
        setPlaying(false);
        return;
      }
      setIndex((current) => {
        const next = current + 1;
        if (next >= list.length) {
          setPlaying(false);
          return list.length - 1;
        }
        const target = list[next];
        if (target) focusStoryboardNode(target.id, props.onFocusFallback);
        return next;
      });
    }, STORYBOARD_PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, open, props.onFocusFallback]);

  /** 打开时先聚焦当前那张（让用户知道「从哪儿开始」）。 */
  const startPlayback = react.useCallback(() => {
    const list = shotsRef.current;
    if (list.length === 0) return;
    const start = index >= list.length ? 0 : index;
    setIndex(start);
    const target = list[start];
    if (target) focusStoryboardNode(target.id, props.onFocusFallback);
    setPlaying(true);
  }, [index, props.onFocusFallback]);

  const toggleButton = h(
    'button',
    {
      type: 'button',
      'aria-label': '分镜板',
      'data-fisherai-storyboard-toggle': 'true',
      title: shots.length > 0 ? `分镜板（${shots.length} 镜）` : '分镜板',
      onClick: () => setOpen((value: boolean) => !value),
      style: BUTTON_STYLE,
      className:
        'flex h-9 items-center gap-1.5 rounded-full border border-[var(--af-border-control)] ' +
        'bg-[var(--af-surface)] px-3 text-xs text-[var(--af-text-secondary)] shadow-md ' +
        'transition-colors hover:text-[var(--af-text)]',
    },
    h(ClapperboardIcon, { className: 'size-3.5' }),
    '分镜',
    shots.length > 0 ? `${shots.length}` : '',
  );

  if (!open) return h(react.Fragment, null, toggleButton);

  const panel = h(
    'div',
    {
      'data-fisherai-storyboard': 'true',
      'data-fisherai-storyboard-playing': playing ? 'true' : 'false',
      style: PANEL_STYLE,
      className:
        'rounded-xl border border-[var(--af-border-control)] bg-[var(--af-surface)] ' +
        'shadow-xl backdrop-blur-sm',
      // 画布在 document 上装了「永不滚动」的 wheel 监听：面板自己滚动，但别冒上去
      onWheel: (event: { stopPropagation?: () => void }) => event.stopPropagation?.(),
    },
    h(
      'div',
      { className: 'flex items-center justify-between gap-2 border-b border-[var(--af-border-control)] px-3 py-2' },
      h(
        'div',
        { className: 'flex items-center gap-2 text-xs font-medium text-[var(--af-text)]' },
        h(ClapperboardIcon, { className: 'size-3.5' }),
        `分镜板 · ${shots.length} 镜`,
        shots.length > 0 ? h('span', { className: 'text-[var(--af-text-secondary)]' },
          `· 当前 ${Math.min(index + 1, shots.length)}`) : null,
      ),
      h(
        'div',
        { className: 'flex items-center gap-1' },
        h(
          'button',
          {
            type: 'button',
            'aria-label': playing ? '暂停播放' : '播放分镜',
            onClick: () => (playing ? setPlaying(false) : startPlayback()),
            disabled: shots.length === 0,
            className:
              'flex h-7 items-center gap-1 rounded-md px-2 text-[11px] ' +
              'text-[var(--af-text-secondary)] hover:bg-[var(--af-hover)] disabled:opacity-40',
          },
          playing ? h(PauseIcon, { className: 'size-3' }) : h(PlayIcon, { className: 'size-3' }),
          playing ? '暂停' : '播放',
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-label': '关闭分镜板',
            onClick: () => {
              setPlaying(false);
              setOpen(false);
            },
            className: 'flex size-7 items-center justify-center rounded-md text-[var(--af-text-secondary)] hover:bg-[var(--af-hover)]',
          },
          h(XIcon, { className: 'size-3.5' }),
        ),
      ),
    ),
    shots.length === 0
      ? h(
          'p',
          { className: 'px-3 py-6 text-center text-xs text-[var(--af-text-secondary)]' },
          '这个项目还没有 Image / Video 镜头节点。',
        )
      : h(
          'div',
          { className: 'flex gap-2 overflow-x-auto px-3 py-2.5' },
          ...shots.map((shot, position) =>
            h(
              'button',
              {
                key: shot.id,
                type: 'button',
                'data-fisherai-storyboard-shot': shot.id,
                'data-fisherai-storyboard-active': position === index && playing ? 'true' : 'false',
                title: shot.title,
                onClick: () => {
                  setIndex(position);
                  setPlaying(false);
                  focusStoryboardNode(shot.id, props.onFocusFallback);
                },
                className:
                  'group relative flex w-[104px] shrink-0 flex-col gap-1 rounded-lg border p-1 text-left ' +
                  (position === index && playing
                    ? 'border-[var(--af-primary)] '
                    : 'border-[var(--af-border-control)] ') +
                  'bg-[var(--af-canvas,#050505)] hover:border-[var(--af-primary)]',
              },
              h(
                'span',
                {
                  className:
                    'absolute left-1 top-1 z-10 rounded bg-black/60 px-1 text-[10px] ' +
                    'font-semibold text-white/90',
                },
                String(position + 1),
              ),
              h(
                'span',
                { className: 'relative flex h-[58px] w-full items-center justify-center overflow-hidden rounded bg-black/40' },
                shot.thumb
                  ? h('img', {
                      src: shot.thumb,
                      alt: shot.title,
                      className: 'h-full w-full object-cover',
                      draggable: false,
                    })
                  : h('span', { className: 'text-[10px] text-[var(--af-text-secondary)]' },
                      shot.type.toLowerCase() === 'video' ? '视频' : '无画面'),
                h('span', {
                  className:
                    'absolute right-1 top-1 size-1.5 rounded-full ' +
                    (STATUS_DOT[shot.status.toLowerCase()] ?? 'bg-slate-500'),
                }),
              ),
              h(
                'span',
                { className: 'line-clamp-2 break-all text-[10px] leading-3 text-[var(--af-text-secondary)] group-hover:text-[var(--af-text)]' },
                shot.title,
              ),
            ),
          ),
        ),
  );

  return h(react.Fragment, null, toggleButton, panel);
}
