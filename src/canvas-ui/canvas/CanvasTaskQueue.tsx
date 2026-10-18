/**
 * 画布右侧的「任务队列」面板（v1.24）。
 *
 * 用户 2026-10-17 原话（整轮需求只有这一句 + 一张「已检测到外部 ComfyUI 服务」的胶囊截图）：
 *   「在画布右侧添加一个任务队列面板，显示简易参数，如时间等，正在运行的任务要有边框循环发光特效」
 *
 * 三条都照做了，落点如下：
 *   1. **画布右侧**：portal 到画布容器内部（`canvasPortalTarget()`），绝对定位贴画布右上角
 *      （v1.36 起 `top:8 / right:12`；用户 2026-10-17 说「任务队列往上移」，以前是 top:60）。
 *      收起后是一条右缘窄轨道（同样 top:8），轨道上带运行中角标 —— 面板不会
 *      「关了就彻底看不见还有任务在跑」。贴右上角会盖住头部右端的保存状态，所以这里还往
 *      画布容器写 `--fisherai-task-queue-inset`（306/44px）给头部让位。
 *   2. **简易参数**：每行 = 标题（工作流名 / 模型名）+ 类型 + 开始时刻（HH:MM:SS）
 *      + 用时（正在跑的每秒刷新）+ 产出数；失败的行补一行错误原因。提示词只给开头两行，
 *      想全看就靠 `title` 悬浮。数据来自 host 的 `GET /api/aifisher/canvas/tasks`
 *      （canvas/taskQueueRouter.ts，本地 ComfyUI 与云端两条链路都写进同一份日记）。
 *   3. **运行中的行带边框循环发光**：见本文件的 GLOW_CSS —— 一圈沿边框循环流动的渐变光
 *      （mask 抠成 1px 环 + background-position 动画），外加 box-shadow 呼吸。
 *      `prefers-reduced-motion` 下两样都停，只留静态描边。
 *
 * 4. **只在画布这一层**（v1.41，用户 2026-10-18 原话：「任务队列希望只出现在画布这一层，
 *    现在点击设置啥的都看的见任务队列」）：任何接管全屏的浮层（设置 / 图片编辑 / 媒体预览 /
 *    资源库…）打开时面板必须**整块不出现**，而不是浮在它上面。做法见 LAYER_GUARD_CSS ——
 *    这些浮层都走 vendor 的 `activateModal`，它会给「浮层路径上的所有兄弟节点」加 `inert`，
 *    而本面板正是被 portal 到画布容器里、与画布应用根节点并列的那一层，于是它天然会拿到
 *    `inert`。所以「只在画布层可见」不需要逐个浮层登记，也不会漏掉以后新加的浮层。
 *
 * 结构契约（回归 / 真机检查依赖，改前看 docs/canvas-ui-shadcn.md）：
 *   - 根：`data-fisherai-task-queue="panel" | "rail"`；收起态那条轨道要能点开；
 *   - 层级：浮层开着时面板带 `inert`，样式表把 `[data-fisherai-task-queue][inert]` 设成
 *     `display:none`（真实浏览器里量 display；jsdom 只守属性 + 样式串）；
 *   - 行：`data-fisherai-task-queue-item="<任务 id>"` + `data-fisherai-task-status`
 *     （running/success/failed/cancelled）+ `data-fisherai-task-kind`；
 *   - 用时：`data-fisherai-task-elapsed-ms`（脚本读这个数，不去猜文本格式）；
 *   - 空态：`data-fisherai-task-queue-empty`；读取出错：`data-fisherai-task-queue-error`；
 *   - 取消按钮 aria-label = 「取消任务」；收起/展开 = 「收起任务队列」/「展开任务队列」；
 *     清空已完成 = 「清空已完成任务」。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）—— 产物里 React 有两份副本，
 *    用错那分 React 19 不报错也不渲染（面板会整块消失）。
 */
import * as ReactTypes from 'react';
import { createPortal } from 'react-dom';
import {
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  ImageIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MusicIcon,
  Trash2Icon,
  TriangleAlertIcon,
  TypeIcon,
  VideoIcon,
  WorkflowIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { canvasPortalTarget } from '@/lib/portal';
import {
  setTaskQueueOpen,
  subscribeTaskQueue,
  taskQueueSnapshot,
  toggleTaskQueue,
} from './TaskQueueStore';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'Fragment'
  | 'useState'
  | 'useEffect'
  | 'useRef'
  | 'useCallback'
  | 'useSyncExternalStore'
>;

interface Props {
  view: string;
}

const BASE = '/api/aifisher/canvas/tasks';
/** 有任务在跑时刷得动一点（1.2s）；全空闲放慢到 2.5s（再慢就会「刚点完生图，面板上半天没反应」）。 */
const RUNNING_POLL_MS = 1200;
const IDLE_POLL_MS = 2500;
/** 用时文本每 0.5s 重算一次 —— 1s 看起来会「卡半拍」，0.2s 又太费。 */
const TICK_MS = 500;

type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled';
type TaskKind = 'image' | 'video' | 'audio' | 'text' | 'workflow';

interface TaskItem {
  id: string;
  nodeId: string;
  projectId?: string;
  kind: TaskKind;
  status: TaskStatus;
  title: string;
  model?: string;
  prompt?: string;
  code?: string;
  error?: string;
  createdAt: string;
  createdAtMs: number;
  startedAtMs: number;
  finishedAtMs?: number;
  elapsedMs: number;
  durationMs?: number;
  resultCount: number;
  cancellable: boolean;
}

const KIND_META: Record<TaskKind, { label: string; icon: ReactTypes.ComponentType<{ className?: string }> }> = {
  workflow: { label: '工作流', icon: WorkflowIcon },
  image: { label: '图片', icon: ImageIcon },
  video: { label: '视频', icon: VideoIcon },
  audio: { label: '音频', icon: MusicIcon },
  text: { label: '文本', icon: TypeIcon },
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: '运行中',
  success: '完成',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_TEXT: Record<TaskStatus, string> = {
  running: 'text-[var(--af-focus)]',
  success: 'text-[var(--af-success)]',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
};

/**
 * 状态点的底色。
 *
 * ⚠️ 不要用 `STATUS_TEXT.replace('text-','bg-')` 那种拼字符串的写法：Tailwind 是**扫源码文本**
 *    生成 class 的，拼出来的 `bg-[var(--af-success)]` 在源码里不存在 → 那条 CSS 根本不会被
 *    产出，点会变成透明（本文件就踩过）。整张表写全。
 */
const STATUS_DOT: Record<TaskStatus, string> = {
  running: 'bg-[var(--af-focus)]',
  success: 'bg-[var(--af-success)]',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
};

/** 运行中那行的一圈循环流光 + 呼吸外发光（细节见文件头第 3 条）。 */
const GLOW_CSS = `
[data-fisherai-task-queue-item][data-fisherai-task-status='running'] {
  position: relative;
  isolation: isolate;
  animation: af-task-queue-glow 2.4s ease-in-out infinite;
}
[data-fisherai-task-queue-item][data-fisherai-task-status='running']::before {
  content: '';
  position: absolute;
  inset: -1px;
  padding: 1px;
  border-radius: inherit;
  background-image: linear-gradient(110deg,
    rgba(34, 211, 238, 0) 0%,
    rgba(34, 211, 238, 0.85) 16%,
    rgba(167, 139, 250, 0.95) 34%,
    rgba(244, 114, 182, 0.85) 52%,
    rgba(34, 211, 238, 0) 72%,
    rgba(34, 211, 238, 0) 100%);
  background-size: 200% 100%;
  background-position: 0% 50%;
  background-repeat: repeat-x;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: af-task-queue-sweep 2.4s linear infinite;
  pointer-events: none;
  z-index: 1;
}
[data-fisherai-task-queue-item][data-fisherai-task-status='running'] [data-fisherai-task-dot] {
  animation: af-task-queue-dot 1.6s ease-in-out infinite;
}
/* 收起态的右缘角标：同一套呼吸光（面板收起时也要看得出「还有任务在跑」） */
[data-fisherai-task-queue-rail-badge] {
  animation: af-task-queue-glow 2.4s ease-in-out infinite;
}
@keyframes af-task-queue-sweep {
  0% { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}
@keyframes af-task-queue-glow {
  0%, 100% { box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.16), 0 0 10px 0 rgba(34, 211, 238, 0.08); }
  50% { box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.45), 0 0 18px 1px rgba(34, 211, 238, 0.22); }
}
@keyframes af-task-queue-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.82); }
}
@media (prefers-reduced-motion: reduce) {
  [data-fisherai-task-queue-item][data-fisherai-task-status='running'],
  [data-fisherai-task-queue-item][data-fisherai-task-status='running']::before,
  [data-fisherai-task-queue-item][data-fisherai-task-status='running'] [data-fisherai-task-dot],
  [data-fisherai-task-queue-rail-badge] {
    animation: none !important;
  }
}
`;

/**
 * 「只在画布这一层」的层级护栏（v1.41）。
 *
 * 用户 2026-10-18 原话：「任务队列希望只出现在画布这一层，现在点击设置啥的都看的见任务队列」。
 *
 * 根因不是层级写高了，而是**面板根本不属于画布图层**：它被 portal 到画布容器里、
 * `right:12/top:8` 绝对定位，看起来像画布的一部分；设置对话框在 vendor 里是
 * `fixed inset-0 z-[100]`（图片预览也是 z-100、资源库 z-50…），而面板为了压住节点上的
 * 浮层（工具条 / composer）一路写到了 `z-[11000]` —— 于是任何 z<11000 的接管型浮层
 * 打开时，任务队列都**浮在它上面**。这些浮层里只有一部分（工作流配置 11900 / 工作流节点
 * 11950 / 节点搜索 12000）碰巧比它高，所以只有「设置 / 媒体预览 / 图片编辑」这几处露馅。
 *
 * 为什么不去逐个登记浮层选择器：vendor 的接管型浮层（设置 / 图片裁剪 / 标注 / 尺寸 /
 * 媒体预览 / 资源库 / 比较 / 组合 / 角度 / 创意库 / 工作流管理器）**全部**经
 * `design/modalFocus.ts` 的 `activateModal()` 打开，它在打开期间沿浮层路径把**所有兄弟节点**
 * 加 `inert`、关闭时还原（vendor 树一个字不改就能用）。本面板是画布容器的直接子节点、
 * 与画布应用根节点并列 → 浮层一开它就带 `inert`。所以这条规则是「画布层被压到下面时，
 * 面板跟着一起下去」，与将来新增的浮层自动对齐。
 *
 * 注意：`inert` 只禁用交互、**不隐藏**，所以这里必须显式 `display: none`。
 * 关闭浮层后属性被摘掉，面板立刻回来（纯 CSS，不需要重渲染）。
 */
const LAYER_GUARD_CSS = `
[data-fisherai-task-queue][inert] {
  display: none !important;
}
`;

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 开始时刻：本机时区的 HH:MM:SS（面板上最常被扫一眼的就是它）。 */
function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 用时：秒级以内给一位小数，分钟级给「1m 04s」，再长给「1h 02m」。 */
export function formatTaskDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** 滚轮护栏：画布在 document 上装了「画布永不滚动」的监听，面板内的滚动不能被它决定。 */
function onPanelWheel(event: ReactTypes.WheelEvent<HTMLDivElement>) {
  if (event.ctrlKey || event.metaKey) return;
  event.stopPropagation();
}

export function CanvasTaskQueue(react: Runtime, props: Props) {
  const h = react.createElement;
  const store = react.useSyncExternalStore(subscribeTaskQueue, taskQueueSnapshot);
  const open = store.open;

  const [items, setItems] = react.useState<TaskItem[] | null>(null);
  const [running, setRunning] = react.useState(0);
  const [error, setError] = react.useState('');
  const [now, setNow] = react.useState<number>(() => Date.now());
  const [cancelling, setCancelling] = react.useState('');
  /** 轮询间隔要跟着「有没有任务在跑」变，但放在 effect 依赖里会让定时器反复重建。 */
  const runningRef = react.useRef(0);

  const load = react.useCallback(async () => {
    try {
      const response = await fetch(`${BASE}?limit=30`, { headers: { Accept: 'application/json' } });
      const data = await readJson(response);
      if (!response.ok) {
        // 读失败时**保留**上一次的列表：正在跑的行突然整块消失比报个错更让人困惑
        setError(
          typeof data.error === 'string' && data.error
            ? data.error
            : `读取任务队列失败（HTTP ${response.status}）`,
        );
        return;
      }
      const tasks = Array.isArray(data.tasks) ? (data.tasks as TaskItem[]) : [];
      const runningCount = Number(data.running ?? tasks.filter((item) => item.status === 'running').length);
      setItems(tasks);
      setRunning(Number.isFinite(runningCount) ? runningCount : 0);
      runningRef.current = Number.isFinite(runningCount) ? runningCount : 0;
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取任务队列失败');
    }
  }, []);

  // 轮询：有在跑的 1.2s，全空闲 4s。卸载/切视图时一定要清掉定时器（画布会反复重挂载）。
  react.useEffect(() => {
    if (props.view !== 'canvas') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (stopped) return;
      const delay = runningRef.current > 0 ? RUNNING_POLL_MS : IDLE_POLL_MS;
      timer = setTimeout(() => {
        void load().then(schedule);
      }, delay);
    };
    void load().then(schedule);
    // 回到这个标签页时立刻补一次（长时间切走期间结束的任务不必等下一轮）
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      void load();
    };
    try {
      document.addEventListener('visibilitychange', onVisible);
    } catch {
      /* 老环境没有这个事件：只是少一次即时刷新 */
    }
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        document.removeEventListener('visibilitychange', onVisible);
      } catch {
        /* 同上 */
      }
    };
  }, [props.view, load]);

  // 用时文本的心跳：只有存在运行中的任务时才需要每 0.5s 重渲染
  react.useEffect(() => {
    if (running <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  /**
   * 画布容器宽度（v1.36）：头部要不要为面板让位，取决于画布够不够宽。
   *
   * 为什么需要：面板 286 + 右缘 12 已经占掉窄画布的一大半。窗口变窄（比如 1280 宽、
   * 右边会话栏还开着 → 画布只剩 ~556px）时，如果头部还硬留 318px，左边那组
   * （返回项目库 / 品牌 / 项目名 / ComfyUI 胶囊）会和保存状态徽标叠在一起。
   * 所以窄画布下**不让位**：徽标被面板盖住，也比两组文字压在一起好看。
   * 量不到宽度（jsdom / headless 早期帧 rect=0）按「宽画布」处理，行为与之前一致。
   */
  const [canvasWidth, setCanvasWidth] = react.useState(0);
  react.useEffect(() => {
    const target = canvasPortalTarget();
    if (!target) return;
    const measure = () => {
      const rect = target.getBoundingClientRect();
      setCanvasWidth(Math.round(rect.width || target.clientWidth || 0));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(target);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  /**
   * 把「面板占掉画布右上角多少」写给头部（v1.36）。
   *
   * 面板从 `top:8` 起贴右上角，而头部是画布顶部那条 48px 的栏 —— 保存状态徽标会正好
   * 被面板/窄轨盖住。头部读 `--fisherai-task-queue-inset`（见 CanvasHeader 的
   * HEADER_RIGHT_INSET），这里按开合状态写这个变量：
   *   展开 = 面板宽 286 + 右缘 12 + 与徽标的 8px 间隙 = 306
   *   收起 = 窄轨宽约 30 + 右缘 0 + 间隙 = 44
   * 画布窄于 820px 时写 0（见上面 canvasWidth 的说明）。
   * 变量写在 portal 容器（画布挂载点）上，头部是它的后代，继承得到。
   * 卸载/切视图时移除 —— 变量残留会让头部一直留一块空白。
   */
  react.useEffect(() => {
    const target = canvasPortalTarget();
    if (!target) return;
    const roomy = canvasWidth === 0 || canvasWidth >= 820;
    const inset = !roomy ? '0px' : open ? '306px' : '44px';
    target.style.setProperty('--fisherai-task-queue-inset', inset);
    /**
     * 再窄一档（画布 < 680px）连 ComfyUI 胶囊也得收起来：面板 286 + 右缘 12 已经占掉
     * 半张画布，左边那组（返回项目库 / 品牌 / 项目名 / 胶囊）会钻到面板底下。
     * 头部把胶囊槽位的 `display` 读这个变量（默认 flex），窗口拉宽自动回来。
     */
    const tooNarrow = canvasWidth > 0 && canvasWidth < 680;
    target.style.setProperty('--fisherai-comfy-slot-display', tooNarrow ? 'none' : 'flex');
    return () => {
      target.style.removeProperty('--fisherai-task-queue-inset');
      target.style.removeProperty('--fisherai-comfy-slot-display');
    };
  }, [open, canvasWidth]);

  /**
   * 画布自己的生成开跑/收尾时**立刻刷一次**（不等下一轮轮询）。
   *
   * 为什么：画布上点「生成」到面板上冒出那一行之间，如果只靠 2.5s 的轮询，用户会看到
   * 「点了没反应」；而 vendor 的 generationScheduler 在每次 acquire/release 时都会 notify，
   * 正好是「有任务开始 / 有任务结束」这两个时刻（本地 ComfyUI 与云端两条链路都走它）。
   * 拿不到 scheduler（老产物 / 单测没装）时就只是少这次即时刷新，轮询照旧。
   */
  react.useEffect(() => {
    if (props.view !== 'canvas') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | undefined;
    let lastVersion = -1;
    const attach = () => {
      if (stopped) return;
      const scheduler = (
        window as unknown as {
          __FISHERAI_GENERATION_SCHEDULER__?: {
            subscribe?(listener: () => void): () => void;
            version?(): number;
          };
        }
      ).__FISHERAI_GENERATION_SCHEDULER__;
      if (!scheduler?.subscribe) {
        // scheduler 是懒装的：晚一点再挂（挂不上也无所谓，轮询兜着）
        timer = setTimeout(attach, 1000);
        return;
      }
      lastVersion = typeof scheduler.version === 'function' ? scheduler.version() : -1;
      unsubscribe = scheduler.subscribe(() => {
        const version = typeof scheduler.version === 'function' ? scheduler.version() : lastVersion + 1;
        if (version === lastVersion) return;
        lastVersion = version;
        void load();
      });
    };
    attach();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        unsubscribe?.();
      } catch {
        /* 订阅器已经没了：不用管 */
      }
    };
  }, [props.view, load]);

  const cancelTask = react.useCallback(
    async (taskId: string) => {
      setCancelling(taskId);
      try {
        const response = await fetch(`${BASE}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ taskId }),
        });
        const data = await readJson(response);
        setError(
          response.ok
            ? ''
            : typeof data.error === 'string' && data.error
              ? data.error
              : `取消任务失败（HTTP ${response.status}）`,
        );
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '取消任务失败');
      } finally {
        setCancelling('');
      }
    },
    [load],
  );

  const clearFinished = react.useCallback(async () => {
    try {
      const response = await fetch(BASE, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const data = await readJson(response);
      if (!response.ok) {
        setError(
          typeof data.error === 'string' && data.error
            ? data.error
            : `清空任务失败（HTTP ${response.status}）`,
        );
        return;
      }
      setError('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清空任务失败');
    }
  }, [load]);

  if (props.view !== 'canvas') return null;

  const list = items ?? [];
  const finishedCount = list.filter((item) => item.status !== 'running').length;
  const styleTag = h(
    'style',
    { key: 'style', 'data-fisherai-task-queue-style': 'true' },
    `${GLOW_CSS}\n${LAYER_GUARD_CSS}`,
  );

  /** 正在跑的那一行：用时按「此刻」算（心跳驱动），结束了的用 host 给的 durationMs。 */
  const elapsedOf = (item: TaskItem): number => {
    if (item.status !== 'running') {
      return typeof item.durationMs === 'number' ? item.durationMs : item.elapsedMs;
    }
    const live = now - item.startedAtMs;
    return Number.isFinite(live) && live > 0 ? live : Math.max(0, item.elapsedMs);
  };

  const row = (item: TaskItem) => {
    const kind = KIND_META[item.kind] ?? KIND_META.workflow;
    const KindIcon = kind.icon;
    const elapsed = elapsedOf(item);
    const title = item.title || item.model || kind.label;
    const statusTone = STATUS_TEXT[item.status] ?? STATUS_TEXT.cancelled;
    const StatusIcon =
      item.status === 'success'
        ? CircleCheckIcon
        : item.status === 'failed'
          ? TriangleAlertIcon
          : item.status === 'cancelled'
            ? BanIcon
            : LoaderCircleIcon;
    return h(
      'div',
      {
        key: item.id,
        'data-fisherai-task-queue-item': item.id,
        'data-fisherai-task-status': item.status,
        'data-fisherai-task-kind': item.kind,
        className:
          'relative flex flex-col gap-1 rounded-md border border-border/70 ' +
          'bg-secondary/45 px-2 py-1.5',
      },
      h(
        'div',
        { className: 'flex items-center gap-1.5' },
        h(
          'span',
          {
            'data-fisherai-task-dot': 'true',
            'aria-hidden': 'true',
            className: cn(
              'size-1.5 shrink-0 rounded-full',
              STATUS_DOT[item.status] ?? STATUS_DOT.cancelled,
            ),
          },
        ),
        h(
          'span',
          {
            title: item.prompt ? `${title}\n\n${item.prompt}` : title,
            className: 'min-w-0 flex-1 truncate text-[11px] font-medium text-foreground',
          },
          title,
        ),
        h(
          'span',
          {
            'data-fisherai-task-kind-label': kind.label,
            className:
              'inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-secondary px-1 ' +
              'text-[9px] leading-[14px] text-muted-foreground',
          },
          h(KindIcon, { className: 'size-2.5' }),
          kind.label,
        ),
      ),
      h(
        'div',
        {
          'data-fisherai-task-elapsed-ms': String(Math.round(elapsed)),
          className: 'flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground',
        },
        h(ClockIcon, { className: 'size-2.5 shrink-0 opacity-70' }),
        h('span', null, formatClock(item.startedAtMs)),
        h('span', { className: 'opacity-40' }, '·'),
        h('span', null, item.status === 'running' ? `已运行 ${formatTaskDuration(elapsed)}` : `用时 ${formatTaskDuration(elapsed)}`),
        item.status === 'success' && item.resultCount > 0
          ? h(
              react.Fragment,
              { key: 'results' },
              h('span', { className: 'opacity-40' }, '·'),
              h('span', null, `${item.resultCount} 个结果`),
            )
          : null,
      ),
      item.prompt
        ? h(
            'div',
            {
              title: item.prompt,
              className:
                'line-clamp-2 text-[10px] leading-[1.45] text-muted-foreground/85',
            },
            item.prompt,
          )
        : null,
      item.status === 'failed' && (item.error || item.code)
        ? h(
            'div',
            {
              'data-fisherai-task-error': 'true',
              title: [item.code, item.error].filter(Boolean).join(' · '),
              className: 'line-clamp-2 text-[10px] leading-[1.45] text-destructive',
            },
            [item.code, item.error].filter(Boolean).join(' · '),
          )
        : null,
      h(
        'div',
        { className: 'flex items-center justify-between gap-1' },
        h(
          'span',
          {
            className: cn(
              'inline-flex items-center gap-1 text-[10px]',
              statusTone,
            ),
          },
          h(StatusIcon, {
            className: cn('size-2.5', item.status === 'running' && 'animate-spin'),
          }),
          STATUS_LABEL[item.status] ?? item.status,
        ),
        item.cancellable
          ? h(
              'button',
              {
                type: 'button',
                'aria-label': '取消任务',
                'data-fisherai-task-cancel': item.id,
                disabled: cancelling === item.id,
                onClick: () => void cancelTask(item.id),
                className:
                  'rounded-sm px-1 text-[10px] text-muted-foreground transition-colors ' +
                  'hover:bg-accent hover:text-foreground disabled:opacity-50',
              },
              cancelling === item.id ? '取消中…' : '取消',
            )
          : null,
      ),
    );
  };

  const header = h(
    'div',
    {
      className:
        'flex h-8 shrink-0 items-center gap-1.5 border-b border-border/80 px-2',
    },
    h(ListChecksIcon, { className: 'size-3.5 shrink-0 text-muted-foreground' }),
    h('span', { className: 'text-[11px] font-semibold text-foreground' }, '任务队列'),
    running > 0
      ? h(
          'span',
          {
            'data-fisherai-task-queue-badge': 'running',
            className:
              'inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 ' +
              'text-[9.5px] leading-[14px] text-[var(--af-focus)]',
          },
          h('span', {
            'aria-hidden': 'true',
            className: 'size-1 rounded-full bg-[var(--af-focus)]',
          }),
          `${running} 运行中`,
        )
      : h(
          'span',
          {
            'data-fisherai-task-queue-badge': 'idle',
            className: 'text-[9.5px] leading-[14px] text-muted-foreground',
          },
          list.length > 0 ? `${list.length} 条` : '空闲',
        ),
    h('span', { className: 'flex-1' }),
    finishedCount > 0
      ? h(
          'button',
          {
            type: 'button',
            'aria-label': '清空已完成任务',
            title: '清空已完成任务',
            onClick: () => void clearFinished(),
            className:
              'rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          },
          h(Trash2Icon, { className: 'size-3' }),
        )
      : null,
    h(
      'button',
      {
        type: 'button',
        'aria-label': '收起任务队列',
        title: '收起任务队列',
        onClick: () => setTaskQueueOpen(false),
        className:
          'rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
      },
      h(ChevronRightIcon, { className: 'size-3.5' }),
    ),
  );

  const body = h(
    'div',
    {
      'data-fisherai-task-queue-list': 'true',
      // 原生 overflow-y-auto，别换 Radix ScrollArea：那个 display:table 包裹层会把行顶出面板
      className: 'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5',
      onWheel: onPanelWheel,
    },
    error
      ? h(
          'div',
          {
            'data-fisherai-task-queue-error': 'true',
            className:
              'rounded-sm border border-destructive/40 bg-destructive/10 px-1.5 py-1 ' +
              'text-[10px] leading-[1.45] text-destructive',
          },
          error,
        )
      : null,
    items === null
      ? h(
          'div',
          {
            className:
              'flex items-center justify-center gap-1 py-4 text-[10px] text-muted-foreground',
          },
          h(CircleDashedIcon, { className: 'size-3 animate-spin' }),
          '读取中…',
        )
      : list.length === 0
        ? h(
            'div',
            {
              'data-fisherai-task-queue-empty': 'true',
              className:
                'flex flex-col items-center gap-1 px-2 py-5 text-center ' +
                'text-[10px] leading-[1.5] text-muted-foreground',
            },
            h(ListChecksIcon, { className: 'size-4 opacity-50' }),
            h('span', null, '暂无生成任务'),
            h('span', { className: 'opacity-70' }, '在画布上点生成后，任务会出现在这里'),
          )
        : list.map(row),
  );

  const panel = h(
    'div',
    {
      role: 'region',
      'aria-label': '任务队列',
      'data-fisherai-task-queue': 'panel',
      'data-fisherai-task-queue-running': String(running),
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      onWheel: onPanelWheel,
      onContextMenu: (event: ReactTypes.MouseEvent) => event.preventDefault(),
      /**
       * v1.36：用户原话「任务队列往上移」—— 以前在 `top:60`（头部下面 12px），
       * 现在贴到画布右上角 `top:8`，与头部第一条控制线对齐；头部的保存状态靠
       * `--fisherai-task-queue-inset` 让位（见 CanvasHeader / 上面的 effect）。
       */
      style: { position: 'absolute', right: 12, top: 8, maxHeight: 'calc(100% - 88px)' },
      className:
        'z-[11000] flex w-[286px] flex-col overflow-hidden rounded-xl border border-border ' +
        'bg-popover/95 text-popover-foreground shadow-xl backdrop-blur-md',
    },
    header,
    body,
  );

  /** 收起态：右缘一条竖轨道（点它展开）。有任务在跑时角标带同样的呼吸光。 */
  const rail = h(
    'div',
    {
      'data-fisherai-task-queue': 'rail',
      'data-fisherai-task-queue-running': String(running),
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      // v1.36：窄轨跟着面板一起上移（贴右上角），否则收起后整条轨道会「掉」到 60px。
      style: { position: 'absolute', right: 0, top: 8 },
      className:
        'z-[11000] flex flex-col items-center gap-1 rounded-l-lg border border-r-0 ' +
        'border-border bg-popover/90 px-1 py-1.5 shadow-lg backdrop-blur-md',
    },
    h(
      'button',
      {
        type: 'button',
        'aria-label': '展开任务队列',
        title: '展开任务队列',
        onClick: () => toggleTaskQueue(),
        className:
          'flex flex-col items-center gap-1 rounded-sm p-0.5 text-muted-foreground ' +
          'transition-colors hover:bg-accent hover:text-foreground',
      },
      h(ChevronLeftIcon, { className: 'size-3.5' }),
      h(ListChecksIcon, { className: 'size-3.5' }),
    ),
    running > 0
      ? h(
          'span',
          {
            'data-fisherai-task-queue-rail-badge': 'true',
            title: `${running} 个任务正在运行`,
            className:
              'flex size-4 items-center justify-center rounded-full bg-secondary ' +
              'text-[9px] font-semibold leading-none text-[var(--af-focus)]',
          },
          String(running),
        )
      : null,
  );

  const root = h(react.Fragment, null, styleTag, open ? panel : rail);
  const target = canvasPortalTarget();
  if (target) return createPortal(root, target) as ReactTypes.ReactNode;
  return root;
}

CanvasTaskQueue.displayName = 'CanvasTaskQueueShadcn';
