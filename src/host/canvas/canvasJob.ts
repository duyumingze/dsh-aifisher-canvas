/**
 * 后台长任务编排（v1.59，P1 第二项）：一次对话提交「做完整短片」。
 *
 * ## 它解决什么
 *
 * 路线图里的原话：「一次对话提交『做完整短片』，plan 执行、失败重试、审批点不变」。
 * 之前要建 6 个镜头：模型挨个 create/configure/prepare，每一步一次推理 + 一次工具往返；
 * 生成失败还得等用户回来问一句「好了吗」。
 *
 * 现在 host 端跑一条**确定性流水线**，模型只调用一次 `canvas_control {action:"job"}`：
 *
 *   read → shots（recipe 展开）→ lock（参考锚点接线）→ prepare（准备批次）
 *        → await（等用户确认 + 等生成结束）→ retry（失败自动再准备一批）→ report
 *
 * ## 三条不动的红线
 *
 * 1. **审批只在画布 UI**：本模块只调用 `prepareGeneration`（产出 awaiting-approval），
 *    从不调用 approve —— 用户仍要在画布右下角点「确认本批生成与费用」；
 * 2. **重试也不花钱**：失败后「自动重试」= 自动再准备一批（仍然 awaiting-approval），
 *    而不是自动提交。所以界面上会再出现一张确认卡，用户点一下即可；
 * 3. **用户随时能停**：`job cancel` 只把任务标记取消并停止后续步骤，不替用户取消正在跑的生成
 *    （那在任务队列面板里，用户自己决定）。
 *
 * ## 为什么是「一条流水线」而不是图执行器
 *
 * 「做完整短片」的确定性部分就是固定的几段：切镜头、摆坐标、锁参考、准备批次。
 * 做成通用 DAG 会把复杂度堆到没人维护；固定流水线 + 可选步骤（lock/retry）已经覆盖
 * 六个镜头这个真实场景，而且每一步的失败都能精确落在某个 step 上（status 里看得见）。
 */
import { randomUUID } from 'node:crypto';
import { buildShotListRecipe } from './recipe';
import { coverageReport, planLockOperations, type AnchorInput } from './consistency';
import type { GenerationBatchResult, GenerationEvents } from './generationEvents';

export type CanvasJobState =
  | 'running'
  | 'awaiting-approval'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CanvasJobStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting';

export interface CanvasJobStep {
  id: string;
  label: string;
  state: CanvasJobStepState;
  detail?: string;
}

export interface CanvasJobRetry {
  /** 失败后是否自动再准备一批（默认 true）。 */
  enabled: boolean;
  /** 最多自动重试几轮（默认 2，不含首轮）。 */
  maxAttempts: number;
  /** 已经重试过几轮。 */
  attempts: number;
}

/** 对外快照（JSON 安全，给 HTTP / 工具返回 / 诊断）。 */
export interface CanvasJobSnapshot {
  id: string;
  name: string;
  projectId: string;
  sessionId: string;
  state: CanvasJobState;
  steps: CanvasJobStep[];
  planIds: string[];
  shotNodeIds: string[];
  shotTitles: Record<string, string>;
  retry: CanvasJobRetry;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  summary?: string;
}

/** 内部状态：多几个字段（当前批次、唤醒函数、取消标记）。 */
interface JobInternal extends CanvasJobSnapshot {
  planId?: string;
  lastBatch?: GenerationBatchResult;
  wake?: (reason: WaitReason) => void;
  cancelled: boolean;
}

type WaitReason = 'batch' | 'timeout' | 'cancel';

export interface CanvasJobBridgeLike {
  request(
    command: Record<string, unknown>,
    options?: { sessionId?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
}

export interface CanvasJobPlansLike {
  get(id: string): { state: string } | null;
}

export interface CanvasJobMemoryLike {
  get(projectId: string): {
    anchors: Array<{ nodeId: string; title: string; role: string }>;
  };
}

export interface CanvasJobDeps {
  bridge: CanvasJobBridgeLike;
  events: GenerationEvents;
  plans?: CanvasJobPlansLike;
  /** 项目记忆（参考锚点从它读）。 */
  memory?: CanvasJobMemoryLike;
  /** 把一句话推进画布对话面板（不阻断流程；失败由调用方兜底）。 */
  notify?: (sessionId: string, text: string) => void;
  now?: () => number;
  /** 等用户确认 + 等生成结束的上限（默认 30 分钟）。 */
  awaitTimeoutMs?: number;
}

export interface CanvasJobInput {
  name?: unknown;
  shots?: unknown;
  columns?: unknown;
  anchorId?: unknown;
  /** 采不采用项目记忆里的参考锚点（默认 true）。 */
  lockAnchors?: unknown;
  /** 采不采用「准备批次」（默认 true）。false = 只建节点不准备生成。 */
  prepare?: unknown;
  retry?: unknown;
}

export interface CanvasJobCreateResult {
  job: CanvasJobSnapshot;
  error?: string;
}

const MAX_JOBS = 12;
const DEFAULT_AWAIT_TIMEOUT_MS = 30 * 60_000;
const STEP_ORDER = ['read', 'shots', 'lock', 'prepare', 'await', 'retry', 'report'] as const;

const STEP_LABELS: Record<(typeof STEP_ORDER)[number], string> = {
  read: '读取画布',
  shots: '展开镜头节点',
  lock: '锁定参考锚点',
  prepare: '准备生成批次',
  await: '等待确认与生成',
  retry: '失败自动重试',
  report: '汇总结果',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createCanvasJobs(deps: CanvasJobDeps) {
  const now = deps.now ?? (() => Date.now());
  const awaitTimeoutMs = deps.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const jobs = new Map<string, JobInternal>();
  let created = 0;
  let completed = 0;
  let retried = 0;

  function step(job: JobInternal, id: string): CanvasJobStep | undefined {
    return job.steps.find((item) => item.id === id);
  }

  function mark(job: JobInternal, id: string, state: CanvasJobStepState, detail?: string): void {
    const target = step(job, id);
    if (!target) return;
    target.state = state;
    if (detail !== undefined) target.detail = detail;
    job.updatedAt = now();
  }

  function snapshot(job: JobInternal): CanvasJobSnapshot {
    return {
      id: job.id,
      name: job.name,
      projectId: job.projectId,
      sessionId: job.sessionId,
      state: job.state,
      steps: job.steps.map((item) => ({ ...item })),
      planIds: [...job.planIds],
      shotNodeIds: [...job.shotNodeIds],
      shotTitles: { ...job.shotTitles },
      retry: { ...job.retry },
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.summary ? { summary: job.summary } : {}),
    };
  }

  function isTerminal(job: JobInternal): boolean {
    return job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled';
  }

  function finish(job: JobInternal, state: CanvasJobState, summary: string, error?: string): void {
    if (isTerminal(job)) return;
    job.state = state;
    job.summary = summary;
    if (error) job.error = error;
    job.finishedAt = now();
    job.updatedAt = now();
    if (state === 'completed') completed += 1;
    deps.notify?.(job.sessionId, summary);
  }

  function prune(): void {
    if (jobs.size <= MAX_JOBS) return;
    for (const [id, job] of [...jobs]) {
      if (jobs.size <= MAX_JOBS) return;
      if (isTerminal(job)) jobs.delete(id);
    }
  }

  /** 当前项目的参考锚点。 */
  function anchorsOf(job: JobInternal): AnchorInput[] {
    if (!job.projectId) return [];
    const memory = deps.memory?.get(job.projectId);
    return (memory?.anchors ?? []).map((anchor) => ({
      nodeId: anchor.nodeId,
      title: anchor.title,
      role: anchor.role,
    }));
  }

  /**
   * 等一批生成收口 / 超时 / 被取消。
   *
   * 三条来源收敛到同一个 `wake`：批次事件、定时器、cancel。`settled` 保证只结束一次。
   */
  function waitForBatch(job: JobInternal): Promise<WaitReason> {
    return new Promise<WaitReason>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => done('timeout'), awaitTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      function done(reason: WaitReason): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.wake = undefined;
        resolve(reason);
      }
      job.wake = (reason) => done(reason);
    });
  }

  const unsubscribeEvents = deps.events.onBatchComplete((payload) => {
    for (const job of jobs.values()) {
      if (job.planId && job.planId === payload.batchId) {
        job.lastBatch = payload;
        job.wake?.('batch');
      }
    }
  });

  /** 用户在画布上点了「取消」批次：任务不该继续干等。 */
  const planWatch = setInterval(() => {
    if (!deps.plans) return;
    for (const job of jobs.values()) {
      if (!job.planId) continue;
      const record = deps.plans.get(job.planId);
      if (record && record.state === 'cancelled') job.wake?.('cancel');
    }
  }, 5000);
  (planWatch as unknown as { unref?: () => void }).unref?.();

  async function readCanvas(sessionId: string): Promise<{ revision: string; nodes: unknown[] }> {
    const result = await deps.bridge.request({ action: 'read' }, { sessionId, timeoutMs: 30_000 });
    const revision = typeof result.revision === 'string' ? result.revision : '';
    if (!revision) throw new Error('画布没有返回 revision（可能没有打开项目）。');
    return { revision, nodes: Array.isArray(result.nodes) ? result.nodes : [] };
  }

  async function edit(
    sessionId: string,
    revision: string,
    operations: unknown[],
  ): Promise<Record<string, unknown>> {
    const result = await deps.bridge.request(
      { action: 'edit', revision, operations },
      { sessionId, timeoutMs: 60_000 },
    );
    if (result.ok === false) {
      throw new Error(`画布拒绝了操作：${String(result.code ?? 'CANVAS_REJECTED')}`);
    }
    return result;
  }

  async function prepare(
    sessionId: string,
    nodeIds: string[],
  ): Promise<string> {
    const { revision } = await readCanvas(sessionId);
    const result = await deps.bridge.request(
      { action: 'prepareGeneration', revision, nodeIds },
      { sessionId, timeoutMs: 60_000 },
    );
    if (result.ok === false) {
      throw new Error(
        `准备生成失败：${String(result.code ?? 'PREPARE_FAILED')}${
          result.message ? `（${String(result.message)}）` : ''
        }`,
      );
    }
    const planId = typeof result.generationPlanId === 'string' ? result.generationPlanId : '';
    if (!planId) throw new Error('准备生成成功但没有返回批次 id。');
    return planId;
  }

  async function run(job: JobInternal, input: CanvasJobInput): Promise<void> {
    try {
      // ---- 1) 读画布 ----
      mark(job, 'read', 'running');
      const first = await readCanvas(job.sessionId);
      mark(job, 'read', 'done', `${first.nodes.length} 个已有节点`);

      // ---- 2) 展开镜头 ----
      mark(job, 'shots', 'running');
      const planned = buildShotListRecipe(
        {
          name: 'shot-list',
          shots: input.shots,
          ...(input.columns !== undefined ? { columns: input.columns } : {}),
          ...(typeof input.anchorId === 'string' ? { anchorId: input.anchorId } : {}),
        },
        first.nodes,
      );
      if ('error' in planned) throw new Error(planned.error);
      const editResult = await edit(job.sessionId, first.revision, planned.operations);
      const created = Array.isArray(editResult.created)
        ? (editResult.created as Array<{ ref?: unknown; id?: unknown }>)
        : [];
      const byRef = new Map<string, string>();
      for (const item of created) {
        if (typeof item.ref === 'string' && typeof item.id === 'string') byRef.set(item.ref, item.id);
      }
      job.shotNodeIds = planned.placed
        .map((item) => byRef.get(item.ref) ?? '')
        .filter((id) => Boolean(id));
      for (const placed of planned.placed) {
        const id = byRef.get(placed.ref);
        if (id) job.shotTitles[id] = placed.title;
      }
      if (job.shotNodeIds.length === 0) {
        throw new Error('镜头节点没有创建成功（画布没有返回 created）。');
      }
      mark(job, 'shots', 'done', `${job.shotNodeIds.length} 个镜头节点`);
      if (job.cancelled) {
        finish(job, 'cancelled', `【画布长任务】「${job.name}」已取消（节点已建好，不会准备生成）。`);
        return;
      }

      // ---- 3) 锁参考（可选）----
      const anchors = anchorsOf(job);
      if (input.lockAnchors === false || anchors.length === 0) {
        mark(job, 'lock', 'skipped', anchors.length === 0 ? '项目没有参考锚点' : '本次不锁参考');
      } else {
        mark(job, 'lock', 'running');
        const second = await readCanvas(job.sessionId);
        const plan = planLockOperations(second.nodes, anchors, job.shotNodeIds);
        if (plan.operations.length > 0) {
          await edit(job.sessionId, second.revision, plan.operations);
        }
        const coverage = coverageReport(second.nodes, anchors);
        mark(
          job,
          'lock',
          'done',
          `接上 ${plan.operations.length} 条参考连线` +
            (plan.missingAnchors.length ? `，${plan.missingAnchors.length} 个锚点已失效` : '') +
            (coverage.shots > 0 ? `（覆盖率 ${coverage.covered}/${coverage.shots}）` : ''),
        );
      }

      // ---- 4) 准备批次 ----
      if (input.prepare === false) {
        mark(job, 'prepare', 'skipped', '本次只建节点，不准备生成');
        mark(job, 'await', 'skipped');
        mark(job, 'retry', 'skipped');
        mark(job, 'report', 'done');
        finish(
          job,
          'completed',
          `【画布长任务】「${job.name}」已建好 ${job.shotNodeIds.length} 个镜头节点（未准备生成）。`,
        );
        return;
      }
      mark(job, 'prepare', 'running');
      let planId = await prepare(job.sessionId, job.shotNodeIds);
      job.planIds.push(planId);
      job.planId = planId;
      mark(job, 'prepare', 'done', `批次 ${planId.slice(0, 8)}…`);
      // 等确认这一步先描述清楚「要等确认」，而不是笼统的「等待」
      mark(job, 'await', 'pending', '等用户确认与生成结果');
      job.state = 'awaiting-approval';
      job.updatedAt = now();
      deps.notify?.(
        job.sessionId,
        `【画布长任务｜宿主自动推送，不是用户发言】「${job.name}」的 ${job.shotNodeIds.length} 个镜头已准备好生成，` +
          '请到画布右下角点「确认本批生成与费用」。确认后任务会自动等结果；失败会再准备一批重试。',
      );

      // ---- 5) 等结果 + 失败重试 ----
      let failedIds: string[] = [];
      for (;;) {
        if (job.cancelled) {
          finish(job, 'cancelled', `【画布长任务】「${job.name}」已取消。`);
          return;
        }
        mark(job, 'await', 'waiting');
        /**
         * 状态要区分「等用户确认」和「等生成结果」：
         * 批次还是 pending → 人还没点确认（awaiting-approval）；running → 真的在生成（waiting）。
         * 之前一律写 waiting，界面上看不出「卡在哪儿」。
         */
        const planState = deps.plans?.get(job.planId ?? '')?.state;
        job.state = planState === 'running' ? 'waiting' : 'awaiting-approval';
        job.updatedAt = now();
        const reason = await waitForBatch(job);
        if (reason === 'cancel') {
          finish(job, 'cancelled', `【画布长任务】「${job.name}」的批次被取消，任务结束。`);
          return;
        }
        if (reason === 'timeout') {
          mark(job, 'await', 'failed', '等确认/生成超时');
          finish(
            job,
            'failed',
            `【画布长任务】「${job.name}」等了 ${Math.round(awaitTimeoutMs / 60000)} 分钟还没收口（可能没点确认），任务已结束。`,
            'AWAIT_TIMEOUT',
          );
          return;
        }
        const events = job.lastBatch?.events ?? [];
        const failed = events.filter((event) => event.status === 'failed');
        failedIds = failed.map((event) => event.nodeId);
        const cancelledCount = events.filter((event) => event.status === 'cancelled').length;
        mark(
          job,
          'await',
          failed.length > 0 ? 'failed' : 'done',
          `${events.length - failed.length} 成功 / ${failed.length} 失败${
            cancelledCount ? ` / ${cancelledCount} 取消` : ''
          }`,
        );
        job.lastBatch = undefined;

        if (failed.length === 0) break;

        if (job.retry.enabled && job.retry.attempts < job.retry.maxAttempts) {
          job.retry.attempts += 1;
          retried += 1;
          mark(job, 'retry', 'running', `第 ${job.retry.attempts} 次重试：${failedIds.length} 个失败节点`);
          planId = await prepare(job.sessionId, failedIds);
          job.planIds.push(planId);
          job.planId = planId;
          job.state = 'awaiting-approval';
          job.updatedAt = now();
          mark(job, 'retry', 'waiting', `重试批次 ${planId.slice(0, 8)}…，等用户确认`);
          deps.notify?.(
            job.sessionId,
            `【画布长任务｜宿主自动推送】「${job.name}」有 ${failedIds.length} 个节点生成失败，` +
              `已自动准备好第 ${job.retry.attempts} 次重试批次，请到画布右下角点「确认本批生成与费用」。`,
          );
          continue;
        }
        mark(
          job,
          'retry',
          job.retry.enabled ? 'failed' : 'skipped',
          job.retry.enabled ? '重试次数用尽' : '未开启自动重试',
        );
        break;
      }

      mark(job, 'report', 'done');
      const total = job.shotNodeIds.length;
      if (failedIds.length > 0) {
        finish(
          job,
          'completed',
          `【画布长任务】「${job.name}」跑完：${total - failedIds.length}/${total} 成功，` +
            `${failedIds.length} 个仍失败（已重试 ${job.retry.attempts} 次）。` +
            '可以让我看失败节点的错误码再调整。',
        );
      } else {
        finish(
          job,
          'completed',
          `【画布长任务】「${job.name}」全部完成：${total} 个镜头都出了结果` +
            (job.retry.attempts > 0 ? `（自动重试 ${job.retry.attempts} 次）` : '') +
            '。',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mark(job, 'report', 'failed', message.slice(0, 200));
      finish(job, 'failed', `【画布长任务】「${job.name}」失败：${message.slice(0, 200)}`, message.slice(0, 400));
    }
  }

  return {
    /**
     * 新建一个长任务：校验参数 → 起任务 → **立刻**返回快照（不等生成）。
     */
    create(
      input: CanvasJobInput,
      context: { sessionId: string; projectId?: string },
    ): CanvasJobCreateResult {
      const shots = Array.isArray(input.shots) ? input.shots : [];
      if (shots.length === 0) {
        return { job: emptyJob(), error: 'job 需要非空 shots（每个镜头至少 prompt）。' };
      }
      if (shots.length > 24) return { job: emptyJob(), error: 'job 的 shots 最多 24 个。' };
      const retryInput = isRecord(input.retry) ? input.retry : {};
      const maxAttempts =
        Number.isFinite(retryInput.maxAttempts) && (retryInput.maxAttempts as number) >= 0
          ? Math.min(5, Math.trunc(retryInput.maxAttempts as number))
          : 2;
      const job: JobInternal = {
        id: randomUUID(),
        name:
          typeof input.name === 'string' && input.name.trim()
            ? input.name.trim().slice(0, 80)
            : '未命名长任务',
        projectId: context.projectId ?? '',
        sessionId: context.sessionId,
        state: 'running',
        steps: STEP_ORDER.map((id) => ({ id, label: STEP_LABELS[id], state: 'pending' })),
        planIds: [],
        shotNodeIds: [],
        shotTitles: {},
        retry: { enabled: retryInput.enabled !== false, maxAttempts, attempts: 0 },
        createdAt: now(),
        updatedAt: now(),
        cancelled: false,
      };
      jobs.set(job.id, job);
      created += 1;
      prune();
      void run(job, input);
      return { job: snapshot(job) };
    },

    list(projectId?: string): CanvasJobSnapshot[] {
      return [...jobs.values()]
        .filter((job) => !projectId || job.projectId === projectId || !job.projectId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(snapshot);
    },

    get(id: string): CanvasJobSnapshot | null {
      const job = jobs.get(id);
      return job ? snapshot(job) : null;
    },

    /** 取消：标记 + 唤醒等待 + 停止后续步骤（不替用户取消正在跑的生成）。 */
    cancel(id: string): CanvasJobSnapshot | null {
      const job = jobs.get(id);
      if (!job) return null;
      job.cancelled = true;
      if (!isTerminal(job)) {
        finish(job, 'cancelled', `【画布长任务】「${job.name}」已取消。`);
      }
      job.wake?.('cancel');
      return snapshot(job);
    },

    stats(): Record<string, unknown> {
      const open = [...jobs.values()].filter(
        (job) => job.state === 'running' || job.state === 'awaiting-approval' || job.state === 'waiting',
      ).length;
      return { kept: jobs.size, open, created, completed, retried, awaitTimeoutMs };
    },

    dispose(): void {
      unsubscribeEvents();
      clearInterval(planWatch);
      jobs.clear();
    },
  };
}

function emptyJob(): CanvasJobSnapshot {
  return {
    id: '',
    name: '',
    projectId: '',
    sessionId: '',
    state: 'failed',
    steps: [],
    planIds: [],
    shotNodeIds: [],
    shotTitles: {},
    retry: { enabled: false, maxAttempts: 0, attempts: 0 },
    createdAt: 0,
    updatedAt: 0,
  };
}

export type CanvasJobs = ReturnType<typeof createCanvasJobs>;
