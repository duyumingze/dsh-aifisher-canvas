/**
 * 主动副驾（v1.59，P1 第四项）。
 *
 * ## 用户认可的边界
 *
 * 「发现空节点/失败任务时给建议（低打扰、可关）」：
 *   - **低打扰**：没有建议时**整个界面什么都不显示**（连入口都没有）；有建议才在画布左下角
 *     冒出一个小胶囊；点开才是面板。不弹窗、不抢焦点、不自动改画布。
 *   - **可关**：面板里有「不再提示」，写入 localStorage；以后连胶囊都不出现
 *     （设置里没有额外开关 —— 与用户「不要多一个设置项」的偏好一致）。
 *   - **不花钱**：建议只是文字 + 一个「问助手」按钮（把话递进右侧对话面板），
 *     不会自动提交任何生成。
 *
 * ## 数据从哪来
 *
 * host 的 `GET /api/aifisher/canvas/copilot?projectId=`：失败节点 / 缺提示词 / 一致性缺口 /
 * 记忆空白 / 孤立节点 / 进行中的长任务，都在 host 侧算好（src/host/canvas/copilot.ts）。
 * 组件只负责显示与两个小操作（删一条记忆、删一个锚点）。
 *
 * ⚠️ hooks 必须用注入进来的 React（产物里有两份 React）。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import { BotIcon, MessageSquareIcon, SparklesIcon, TrashIcon, XIcon } from 'lucide-react';

type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'Fragment' | 'useState' | 'useEffect' | 'useMemo' | 'useCallback' | 'useRef'
>;

export interface CopilotSuggestion {
  id: string;
  level: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  ask?: string;
}

export interface CopilotMemoryEntry {
  id: string;
  kind: string;
  text: string;
  key?: string;
}

export interface CopilotSnapshot {
  suggestions: CopilotSuggestion[];
  summary: string;
  memory: {
    entries: CopilotMemoryEntry[];
    anchors: Array<{ nodeId: string; title: string; role: string }>;
  };
  consistency: {
    shots: number;
    covered: number;
    uncovered: number;
    summary: string;
  };
  jobs: Array<{ id: string; name: string; state: string }>;
}

/** 「不再提示」= 关掉副驾；键名单独一份，避免和画布偏好撞车。 */
export const COPILOT_ENABLED_STORAGE_KEY = 'aifisher.copilot.enabled';

const KIND_LABEL: Record<string, string> = {
  style: '画风',
  character: '角色',
  model: '模型',
  param: '参数',
  rule: '约束',
  note: '其他',
};

const LEVEL_DOT: Record<CopilotSuggestion['level'], string> = {
  high: 'bg-rose-500',
  medium: 'bg-amber-400',
  low: 'bg-sky-400',
};

export function copilotEnabled(): boolean {
  try {
    return window.localStorage.getItem(COPILOT_ENABLED_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setCopilotEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(COPILOT_ENABLED_STORAGE_KEY);
    else window.localStorage.setItem(COPILOT_ENABLED_STORAGE_KEY, '0');
  } catch {
    /* 隐私模式下写不了 localStorage：本次会话内仍然生效（state） */
  }
}

/**
 * 把一条建议递给右侧对话面板（CanvasChatDock 监听这个事件）。
 *
 * 除了派发事件，还直接尝试把文字填进对话面板的输入框：DSH 的 composer 是内核组件，
 * 没有「外部设值」的公开入口，这里用 React 认识的原生 setter + input 事件（受控输入框的
 * 标准写法）。找不到输入框就只派发事件，绝不报错 —— 建议本身是旁路能力。
 */
export function askCopilot(text: string): void {
  try {
    window.dispatchEvent(new CustomEvent('aifisher:copilot-ask', { detail: { text } }));
  } catch {
    /* 没有 CustomEvent（极老环境）就忽略 */
  }
  try {
    const dock =
      document.querySelector('[data-dsh-aifisher-chat="body"]') ??
      document.querySelector('[data-dsh-aifisher-chat]');
    const textarea = dock?.querySelector('textarea') as HTMLTextAreaElement | null;
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
      return;
    }
    const editable = dock?.querySelector('[contenteditable="true"]') as HTMLElement | null;
    if (editable) {
      editable.focus();
      document.execCommand('insertText', false, text);
    }
  } catch {
    /* 填不进去就只保留事件派发：用户仍可手打 */
  }
}

/** 诊断上报：开没开 / 几条建议 / 记忆条数。 */
export function copilotReport(): Record<string, unknown> {
  const pill = document.querySelector('[data-fisherai-copilot-pill="true"]');
  const panel = document.querySelector('[data-fisherai-copilot="true"]');
  return {
    enabled: copilotEnabled(),
    pill: Boolean(pill),
    open: Boolean(panel),
    suggestions: panel
      ? panel.querySelectorAll('[data-fisherai-copilot-suggestion]').length
      : 0,
  };
}

/**
 * 面板从胶囊**正上方**展开（与 PILL_STYLE 同一条竖线），不再贴右缘：
 * 贴右缘会和退出按钮处在同一列，虽然底边（64）刚好在按钮上沿（50）之上，
 * 但窗口一矮就会压上去；居中展开与胶囊位置一致，用户视线不用横跳。
 */
const PANEL_STYLE: ReactTypes.CSSProperties = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  bottom: 64,
  zIndex: 46,
  width: 330,
  maxHeight: '58%',
  overflowY: 'auto',
  pointerEvents: 'auto',
};

/**
 * 副驾胶囊的位置：**底部中间、紧挨分镜板左侧**。
 *
 * 2026-10-23 用户报障（截图）：「退出画布」按钮压在副驾胶囊上，两个重叠。
 * 原因是这两个浮层抢同一个右下角：
 *   - DSH 层（画布外）的退出按钮：`right: 20`，宽 98 → 占距右缘 20..118；
 *   - 副驾胶囊原来 `right: 56`，宽 ~81 → 占距右缘 56..137。
 * 两个都贴底（bottom 24 / 20），水平区间交叠 62px，必然重叠。
 *
 * 右下角是**退出按钮**的地盘（它属于 DSH 层，必须始终可点、最靠外），所以让画布
 * 自己的浮层往中间让：胶囊右缘固定在画布中线外 54px（分镜板居中、半宽约 46.5，
 * 间隙 8px）。宽画布下副驾与分镜板连成一条底部工具带；窄画布下也只有胶囊左端
 * 会碰到缩放条，不会压到退出按钮。
 */
const PILL_STYLE: ReactTypes.CSSProperties = {
  position: 'absolute',
  right: 'calc(50% + 54px)',
  bottom: 24,
  zIndex: 46,
  pointerEvents: 'auto',
};

export interface CanvasCopilotProps {
  view?: string;
  projectId?: string;
  documentEpoch?: number;
}

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api/aifisher/canvas${path}`, init);
}

export function CanvasCopilot(
  react: Runtime,
  props: CanvasCopilotProps = {},
): ReactTypes.ReactNode {
  const h = createElement(react);
  const [enabled, setEnabled] = react.useState<boolean>(() => copilotEnabled());
  const [open, setOpen] = react.useState(false);
  const [snapshot, setSnapshot] = react.useState<CopilotSnapshot | null>(null);
  const [busy, setBusy] = react.useState('');

  const projectId = props.projectId ?? '';
  /** 用户打开面板时补一次**活画布**读数（后台轮询只读磁盘文档，见下面 load 的说明）。 */
  const reload = react.useRef<(live?: boolean) => void>(() => {});

  react.useEffect(() => {
    if (!enabled || !projectId) return undefined;
    let stopped = false;
    /**
     * `live` 只给「用户真的在看」的那一次（打开面板/刷新）：
     * 后台 30s 轮询走磁盘文档 —— `live=1` 要等 host 去问活画布，
     * 页面刚重载/画布没在轮询时那一下会把界面卡住（v1.61 真机检查踩到）。
     */
    const load = async (live = false) => {
      try {
        const response = await api(`/copilot?projectId=${encodeURIComponent(projectId)}${live ? '&live=1' : ''}`);
        if (!response.ok) return;
        const data = (await response.json()) as CopilotSnapshot;
        if (!stopped && data && Array.isArray(data.suggestions)) setSnapshot(data);
      } catch {
        /* 画布还没就绪 / 网络抖动：保持上一次快照，不清空 */
      }
    };
    void load();
    reload.current = (live) => void load(live === true);
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      stopped = true;
      reload.current = () => {};
      window.clearInterval(timer);
    };
  }, [enabled, projectId, props.documentEpoch]);

  const suggestions = react.useMemo(
    () => (snapshot && Array.isArray(snapshot.suggestions) ? snapshot.suggestions : []),
    [snapshot],
  );

  const removeEntry = react.useCallback(
    (id: string) => {
      if (!projectId) return;
      setBusy(id);
      void api(`/memory/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      })
        .catch(() => {})
        .finally(() => {
          setBusy('');
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  memory: {
                    ...current.memory,
                    entries: current.memory.entries.filter((entry) => entry.id !== id),
                  },
                }
              : current,
          );
        });
    },
    [projectId],
  );

  const removeAnchor = react.useCallback(
    (nodeId: string) => {
      if (!projectId || !snapshot) return;
      setBusy(nodeId);
      const anchors = snapshot.memory.anchors.filter((anchor) => anchor.nodeId !== nodeId);
      void api('/memory/anchors', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, anchors }),
      })
        .catch(() => {})
        .finally(() => {
          setBusy('');
          setSnapshot((current) =>
            current ? { ...current, memory: { ...current.memory, anchors } } : current,
          );
        });
    },
    [projectId, snapshot],
  );

  if (!enabled) return null;
  if (props.view !== undefined && props.view !== 'canvas') return null;

  // 低打扰：没有建议时不显示任何东西（连胶囊都不出现）
  if (suggestions.length === 0 && !open) return null;

  const pill = h(
    'button',
    {
      type: 'button',
      'data-fisherai-copilot-pill': 'true',
      'aria-label': open ? '收起副驾' : '副驾建议',
      'aria-expanded': open,
      title: suggestions[0]?.title ?? '副驾',
      /**
       * 2026-10-31 用户报障：「点击副驾后再次点击副驾不会关闭」。
       * 胶囊是开关，不是单向打开 —— 开着时再点一次收起（面板开着时胶囊仍在面板下方，
       * 不会被盖住）；只有「打开」这一下才去补一次活画布读数。
       */
      onClick: () => {
        if (open) {
          setOpen(false);
          return;
        }
        setOpen(true);
        reload.current(true);
      },
      style: PILL_STYLE,
      className:
        'flex h-9 items-center gap-1.5 rounded-full border border-[var(--af-border-control)] ' +
        'bg-[var(--af-surface)] px-3 text-xs text-[var(--af-text-secondary)] shadow-md ' +
        'transition-colors hover:text-[var(--af-text)]',
    },
    h(SparklesIcon, { className: 'size-3.5 text-amber-300' }),
    `副驾 ${suggestions.length}`,
  );

  if (!open) return pill;

  const memory = snapshot?.memory ?? { entries: [], anchors: [] };
  const consistency = snapshot?.consistency;

  const panel = h(
    'div',
    {
      'data-fisherai-copilot': 'true',
      style: PANEL_STYLE,
      className:
        'rounded-xl border border-[var(--af-border-control)] bg-[var(--af-surface)] shadow-xl',
      onWheel: (event: { stopPropagation?: () => void }) => event.stopPropagation?.(),
    },
    h(
      'div',
      { className: 'flex items-center justify-between border-b border-[var(--af-border-control)] px-3 py-2' },
      h(
        'div',
        { className: 'flex items-center gap-2 text-xs font-medium text-[var(--af-text)]' },
        h(BotIcon, { className: 'size-3.5' }),
        '副驾',
        h('span', { className: 'text-[var(--af-text-secondary)]' },
          snapshot?.summary ?? '正在读取画布状态…'),
      ),
      h(
        'button',
        {
          type: 'button',
          'aria-label': '收起副驾',
          onClick: () => setOpen(false),
          className: 'flex size-7 items-center justify-center rounded-md text-[var(--af-text-secondary)] hover:bg-[var(--af-hover)]',
        },
        h(XIcon, { className: 'size-3.5' }),
      ),
    ),

    h(
      'div',
      { className: 'flex flex-col gap-1.5 px-3 py-2' },
      ...suggestions.map((item) =>
        h(
          'div',
          {
            key: item.id,
            'data-fisherai-copilot-suggestion': item.id,
            className: 'rounded-lg border border-[var(--af-border-control)] px-2 py-1.5',
          },
          h(
            'div',
            { className: 'flex items-start gap-1.5' },
            h('span', { className: `mt-1 size-1.5 shrink-0 rounded-full ${LEVEL_DOT[item.level] ?? 'bg-slate-400'}` }),
            h(
              'div',
              { className: 'min-w-0' },
              h('p', { className: 'text-[11px] font-medium text-[var(--af-text)]' }, item.title),
              h('p', { className: 'mt-0.5 text-[10px] leading-4 text-[var(--af-text-secondary)]' }, item.detail),
            ),
          ),
          item.ask
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    askCopilot(String(item.ask));
                    setOpen(false);
                  },
                  className:
                    'mt-1.5 flex items-center gap-1 rounded-md border border-[var(--af-border-control)] ' +
                    'px-1.5 py-0.5 text-[10px] text-[var(--af-text-secondary)] hover:text-[var(--af-text)]',
                },
                h(MessageSquareIcon, { className: 'size-3' }),
                '问助手',
              )
            : null,
        ),
      ),
      suggestions.length === 0
        ? h('p', { className: 'px-1 py-2 text-[11px] text-[var(--af-text-secondary)]' }, '暂时没有建议。')
        : null,
    ),

    h('div', { className: 'border-t border-[var(--af-border-control)] px-3 py-2' },
      h(
        'p',
        { className: 'mb-1 flex items-center justify-between text-[10px] font-medium text-[var(--af-text-secondary)]' },
        '项目记忆',
        h('span', null, `${memory.entries.length} 条`),
      ),
      memory.entries.length === 0
        ? h('p', { className: 'text-[10px] text-[var(--af-text-secondary)]' },
            '还没有记忆：对助手说「记住这个项目的画风和角色」即可写入，下次会话自动带上。')
        : h(
            'div',
            { className: 'flex flex-col gap-1' },
            ...memory.entries.slice(0, 8).map((entry) =>
              h(
                'div',
                { key: entry.id, className: 'group flex items-start gap-1' },
                h(
                  'span',
                  { className: 'mt-0.5 shrink-0 rounded bg-[var(--af-hover)] px-1 text-[9px] text-[var(--af-text-secondary)]' },
                  KIND_LABEL[entry.kind] ?? entry.kind,
                ),
                h('span', { className: 'min-w-0 flex-1 break-all text-[10px] leading-4 text-[var(--af-text)]' },
                  entry.text),
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-label': '删除这条记忆',
                    disabled: busy === entry.id,
                    onClick: () => removeEntry(entry.id),
                    className:
                      'mt-0.5 shrink-0 text-[var(--af-text-secondary)] opacity-0 transition-opacity ' +
                      'hover:text-[var(--af-text)] group-hover:opacity-100 disabled:opacity-40',
                  },
                  h(TrashIcon, { className: 'size-3' }),
                ),
              ),
            ),
          ),
      h(
        'p',
        { className: 'mt-2 text-[10px] text-[var(--af-text-secondary)]' },
        consistency
          ? `一致性：${consistency.summary}`
          : '一致性：正在读取…',
      ),
      memory.anchors.length > 0
        ? h(
            'div',
            { className: 'mt-1 flex flex-wrap gap-1' },
            ...memory.anchors.map((anchor) =>
              h(
                'span',
                {
                  key: anchor.nodeId,
                  className:
                    'flex items-center gap-1 rounded-full border border-[var(--af-border-control)] ' +
                    'px-1.5 py-0.5 text-[9px] text-[var(--af-text-secondary)]',
                },
                `锚点·${anchor.title}`,
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-label': `移除锚点 ${anchor.title}`,
                    disabled: busy === anchor.nodeId,
                    onClick: () => removeAnchor(anchor.nodeId),
                    className: 'hover:text-[var(--af-text)] disabled:opacity-40',
                  },
                  h(XIcon, { className: 'size-2.5' }),
                ),
              ),
            ),
          )
        : null,
    ),

    h(
      'div',
      { className: 'flex items-center justify-between border-t border-[var(--af-border-control)] px-3 py-1.5' },
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            setCopilotEnabled(false);
            setEnabled(false);
            setOpen(false);
          },
          className: 'text-[10px] text-[var(--af-text-secondary)] hover:text-[var(--af-text)]',
        },
        '不再提示',
      ),
      snapshot ? h('span', { className: 'text-[9px] text-[var(--af-text-secondary)]' },
        snapshot.jobs.length > 0 ? `长任务 ${snapshot.jobs.length}` : '空闲') : null,
    ),
  );

  return h(react.Fragment, null, pill, panel);
}
