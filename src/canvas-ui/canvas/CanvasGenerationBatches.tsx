/**
 * 生成批次确认卡（v1.58）—— DSH 版**唯一**的「确认本批生成与费用」入口。
 *
 * ## 为什么必须有这一块
 *
 * 上游把确认卡放在「画布内 Agent 面板」（`canvasAgentPanel`）里，而 DSH 版把那个面板整块
 * 换成了右侧的 DSH 原生会话（`CanvasChatDock`，见 CanvasShell 的 `SUPPRESS_VENDOR_AGENT_CSS`）。
 * Agent 用 `prepareGeneration` 准备好的批次会停在 `awaiting-approval`，可界面里没有任何地方
 * 能按下确认 —— 「准备 → 确认 → 跑完 → 推回会话」这条闭环在真机上断在第二步。
 *
 * 所以这里把上游那张卡搬到画布图层里：同一份 `canvasCreationControl` 快照、同一对
 * `approve/cancel`，只是渲染位置从被压掉的面板挪到画布右下角。
 *
 * ## 红线没动
 *
 * - 控制器由 `canvasApplication` 挂到 `window.__FISHERAI_CANVAS_GENERATION_BATCHES__`
 *   （vendor 补丁 3.8v），**只挂对象、不加协议动作**：`approve` 仍然只有页面里的 UI 能调，
 *   `canvas_control` 拿不到，Agent 依旧不能自己提交。
 * - 费用授权必须由人按下：这张卡不做倒计时自动确认，也不会替用户点。
 *
 * ## 过滤规则
 *
 * 只显示**当前项目**里 `pending` / `running` 的批次。同一会话同时只允许一个 pending 批次
 * （vendor 侧 CONFLICT），所以正常情况下最多一张卡。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）—— 产物里 React 有两份副本。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'useState'
  | 'useEffect'
  | 'useCallback'
  | 'useSyncExternalStore'
>;

/** 与 vendor `GenerationBatch` 同形（只取界面要用的字段）。 */
export interface GenerationBatchItem {
  nodeId: string;
  title: string;
  model: string;
  parameters: string;
  count: number;
  references: string[];
  dependsOn?: string[];
  state: 'pending' | 'submitted' | 'success' | 'failed' | 'unconfirmed' | 'stopped';
}

export interface GenerationBatch {
  id: string;
  projectId: string;
  sessionId: string;
  expiresAt: number;
  state: 'pending' | 'running' | 'finished' | 'cancelled';
  recovered?: boolean;
  authorizationId?: string;
  items: GenerationBatchItem[];
}

/** `canvasCreationControl` 里这张卡用到的那几个方法。 */
export interface GenerationBatchControl {
  getSnapshot(): GenerationBatch[];
  subscribe(listener: () => void): () => void;
  approve(id: string): Promise<void> | void;
  cancel(id: string): Promise<void> | void;
  getError?(): string;
}

export interface CanvasGenerationBatchesProps {
  /** 当前画布项目；不传就读画布自己的 resume 状态（与 @ 节点引用同一来源）。 */
  projectId?: string;
}

const EMPTY: GenerationBatch[] = [];

const ITEM_STATE_LABEL: Record<GenerationBatchItem['state'], string> = {
  pending: '等待确认',
  submitted: '已提交',
  success: '已完成',
  failed: '失败',
  unconfirmed: '请在节点核对',
  stopped: '未提交',
};

/**
 * 批次控制器：由 vendor 补丁 3.8v 在 `canvasApplication` 里挂上。
 * 拿不到（画布还没渲染到那一步 / 卸载中）就返回 null —— 卡片不渲染，不报错。
 */
export function batchesControl(): GenerationBatchControl | null {
  try {
    const holder = window as unknown as {
      __FISHERAI_CANVAS_GENERATION_BATCHES__?: GenerationBatchControl;
    };
    const value = holder.__FISHERAI_CANVAS_GENERATION_BATCHES__;
    if (!value || typeof value.getSnapshot !== 'function' || typeof value.subscribe !== 'function') {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** 当前打开的画布项目 id。 */
export function currentCanvasProjectId(): string | undefined {
  try {
    const holder = window as unknown as {
      __FISHERAI_CANVAS_SESSION__?: { load?: () => { workflowId?: unknown } | null };
    };
    const state = holder.__FISHERAI_CANVAS_SESSION__?.load?.();
    return typeof state?.workflowId === 'string' && state.workflowId ? state.workflowId : undefined;
  } catch {
    return undefined;
  }
}

/** 该显示哪几批：当前项目的、还没结束的。 */
export function visibleGenerationBatches(
  batches: readonly GenerationBatch[] | undefined,
  projectId?: string,
): GenerationBatch[] {
  if (!Array.isArray(batches)) return [];
  return batches.filter(
    (batch) =>
      (batch.state === 'pending' || batch.state === 'running') &&
      (!projectId || batch.projectId === projectId),
  );
}

/** 诊断上报（`canvasAppBuildInfo().generationBatches`）：卡到底挂上没有。 */
export function generationBatchesReport(): Record<string, unknown> {
  const control = batchesControl();
  const projectId = currentCanvasProjectId();
  const visible = visibleGenerationBatches(control?.getSnapshot(), projectId);
  return {
    bridged: Boolean(control),
    projectId: projectId ?? null,
    visible: visible.length,
    states: visible.map((batch) => batch.state),
    card: Boolean(document.querySelector('[data-fisherai-generation-batches="true"]')),
  };
}

const CARD_STYLE: ReactTypes.CSSProperties = {
  position: 'absolute',
  right: 16,
  bottom: 72,
  zIndex: 40,
  width: 340,
  maxWidth: 'calc(100% - 32px)',
  maxHeight: '60%',
  overflowY: 'auto',
  pointerEvents: 'auto',
  // 让原生滚轮落在这张卡上时不被画布的「永不滚动」监听吞掉
  overscrollBehavior: 'contain',
};

export function CanvasGenerationBatches(
  react: Runtime,
  props: CanvasGenerationBatchesProps = {},
): ReactTypes.ReactNode {
  const h = createElement(react);
  const [busy, setBusy] = react.useState<string | null>(null);

  /**
   * 控制器是画布应用渲染后才挂上的（补丁 3.8v），而且**切换项目时会换一个实例**
   * （`canvasCreation` 的 useMemo 依赖 documentEpoch）。所以这里不能缓存实例：
   * 订阅时读全局，再定时比对实例是否换了 —— 换了就重订阅并叫醒一次订阅者。
   * （踩过：缓存第一次找到的实例 → 换项目后一直读旧快照，卡片永远 0 批。）
   */
  const subscribe = react.useCallback((listener: () => void) => {
    let current = batchesControl();
    let release = current ? current.subscribe(listener) : () => {};
    const timer = window.setInterval(() => {
      const next = batchesControl();
      if (next === current) return;
      release();
      current = next;
      release = next ? next.subscribe(listener) : () => {};
      listener();
    }, 400);
    return () => {
      window.clearInterval(timer);
      release();
    };
  }, []);
  const getSnapshot = react.useCallback(
    () => batchesControl()?.getSnapshot() ?? EMPTY,
    [],
  );
  const snapshot = react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const control = batchesControl();
  const projectId = props.projectId ?? currentCanvasProjectId();
  const batches = visibleGenerationBatches(snapshot, projectId);
  if (!control || batches.length === 0) return null;

  const act = (batch: GenerationBatch, action: 'approve' | 'cancel') => {
    if (busy) return;
    setBusy(batch.id);
    const run = action === 'approve' ? control.approve(batch.id) : control.cancel(batch.id);
    void Promise.resolve(run)
      .catch(() => {})
      .finally(() => setBusy((current) => (current === batch.id ? null : current)));
  };

  return h(
    'div',
    {
      'data-fisherai-generation-batches': 'true',
      style: CARD_STYLE,
      // 画布 vendor 在 document 上装了「画布永不滚动」的 wheel 监听：这张卡自己可以滚，
      // 但滚轮不能冒到 document 去（否则长批次（分镜 24 个节点）滚不动）。
      onWheel: (event: { stopPropagation?: () => void }) => event.stopPropagation?.(),
    },
    batches.map((batch) => {
      const expired = batch.state === 'pending' && Date.now() >= batch.expiresAt;
      return h(
        'section',
        {
          key: batch.id,
          'data-fisherai-generation-batch': batch.id,
          className:
            'mb-2 rounded-lg border border-[var(--af-border-control)] bg-[var(--af-surface)] p-3 text-xs text-[var(--af-text-secondary)] shadow-lg',
        },
        h(
          'div',
          { className: 'mb-2 font-medium text-[var(--af-text)]' },
          `生成批次 · ${batch.items.length} 个节点`,
        ),
        h(
          'p',
          { className: 'mb-2' },
          batch.state === 'running'
            ? '正在执行本批；失败或配置变化会停止剩余任务。'
            : '确认后按以下配置提交，费用以服务商账单为准，不设费用封顶。本次确认 10 分钟内有效。撤销不能退回生成费用。',
        ),
        ...batch.items.map((item) =>
          h(
            'details',
            { key: item.nodeId, className: 'mb-2' },
            h(
              'summary',
              { className: 'cursor-pointer' },
              `${item.title} · ${item.model} · 数量 ${item.count} · ${ITEM_STATE_LABEL[item.state] ?? item.state}`,
            ),
            h(
              'pre',
              {
                className:
                  'mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[var(--af-text-secondary)]',
              },
              item.parameters,
            ),
            h('p', { className: 'mt-1' }, `引用：${(item.references ?? []).join('、') || '无'}`),
          ),
        ),
        expired
          ? h('p', { className: 'text-[var(--af-warning)]' }, '这批确认已过期（10 分钟）：重新准备一次。')
          : null,
        batch.state === 'pending'
          ? h(
              'div',
              { className: 'flex items-center gap-3' },
              h(
                'button',
                {
                  type: 'button',
                  'data-fisherai-generation-approve': batch.id,
                  disabled: expired || busy === batch.id,
                  onClick: () => act(batch, 'approve'),
                  className:
                    'rounded bg-[var(--af-primary)] px-3 py-1.5 text-[var(--af-on-primary)] disabled:opacity-50',
                },
                busy === batch.id ? '提交中…' : '确认本批生成与费用',
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-fisherai-generation-cancel': batch.id,
                  disabled: busy === batch.id,
                  onClick: () => act(batch, 'cancel'),
                  className: 'text-[var(--af-text-secondary)] disabled:opacity-50',
                },
                '取消',
              ),
            )
          : h(
              'button',
              {
                type: 'button',
                'data-fisherai-generation-cancel': batch.id,
                disabled: busy === batch.id,
                onClick: () => act(batch, 'cancel'),
                className: 'mt-2 text-[var(--af-text-secondary)] disabled:opacity-50',
              },
              '停止后续任务',
            ),
      );
    }),
  );
}
