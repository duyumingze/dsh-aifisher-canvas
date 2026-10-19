/**
 * 生成任务日记（内存版）
 *
 * 用途是给画布上三条客户端逻辑提供「任务可查」：
 *   1. `useVideoResults` / `useImageResults` → 每 10s 轮询 `GET /generation-status/:nodeId?attemptId=`
 *      做结果回收（vendor/aifisher/src/stable/generation/generationRecovery.ts）；
 *   2. `canvasTaskControl`（agent 的 tasks/cancelTask 动作）→ `GET /generation-status/:nodeId`
 *      与 `GET /generation-cancel/:nodeId`；
 *   3. v1.24 起：**画布右侧的任务队列面板**（src/canvas-ui/canvas/CanvasTaskQueue.tsx）
 *      → `GET /api/aifisher/canvas/tasks`（见 canvas/taskQueueRouter.ts）。
 *
 * 上游有一份持久化日记（server/generation/generationTaskJournal.js，落 SQLite），
 * 本插件第一版只做内存：进程重启后查不到任务 → 返回 status:"missing"，客户端会再花 30s
 * 从素材库（mediaStore 的 sidecar）反查，那条路已经够用（见 restRouter 的 generation-status）。
 *
 * 所有写操作都带 attemptId 校验：迟到的任务结果不能覆盖更新的那次尝试（上游同款约束）。
 *
 * ## v1.24 的结构变化（做任务队列面板时踩出来的）
 *
 * 以前是「一个 nodeId 一张任务」的 Map，同一个节点跑第二次就把上一次的**整条记录**覆盖掉：
 * 面板会看到「上一轮凭空消失」，而且没有开始/结束时间可显示。现在改成：
 *   - `tasks`：attemptId → 任务（一轮生成一条，历史保留）；
 *   - `byNode`：nodeId → 最近一次尝试的 attemptId（`get(nodeId)` / 取消 / 结果回收仍按节点取）；
 *   - `order`：加入顺序（旧→新），用于「最近 N 条」与超量清理。
 *
 * 兼容性铁律：`get/succeed/fail/isCancelled/cancel/attachPromptId` 的签名与语义**一个字都没改**，
 * 它们喂的是画布已有的结果回收链路（`/generation-status/:nodeId` → taskResponse）。新增的
 * `list/clearFinished/stats` 只给任务队列面板用，不参与回收判定。
 */
export type GenerationTaskStatus = 'loading' | 'success' | 'failed' | 'cancelled';

/** 任务类型：画布上四个云模型节点 + 本地 ComfyUI 工作流。 */
export type GenerationTaskType = 'image' | 'video' | 'audio' | 'text' | 'workflow';

export interface GenerationTask {
  /** 任务 id（= attemptId，任务队列面板按它去重/取消）。 */
  id: string;
  nodeId: string;
  attemptId: string;
  projectId?: string;
  type: GenerationTaskType;
  model?: string;
  /**
   * 面板上那一行的大标题：ComfyUI 是工作流标题，云端模型是模型名。
   * 缺省时面板回落到 model / type 的中文名。
   */
  title?: string;
  /** 用户这次输入的提示词（面板只显示开头一段，不做换行展开）。 */
  prompt?: string;
  status: GenerationTaskStatus;
  code?: string;
  error?: string;
  resultUrl?: string;
  resultUrls?: string[];
  text?: string;
  /** ISO 时间（历史字段，`/generation-status` 的响应体一直在用）。 */
  createdAt: string;
  /** 同一时刻的 epoch 毫秒（面板算「已运行多少秒」用，免得两边解析字符串）。 */
  createdAtMs: number;
  /** 真正开始执行的时刻（目前等于 createdAt，异步排队的场景留给以后）。 */
  startedAtMs: number;
  finishedAtMs?: number;
  durationMs?: number;
  /** ComfyUI 的 prompt_id（取消时用它清队列） */
  promptId?: string;
  /** 由调用方（任务执行器）注册的取消钩子 */
  cancel?: () => Promise<void> | void;
}

/** 内存里保留的历史条数上限（含正在跑的）。面板一次最多显示 30 条，60 条够翻。 */
const MAX_TASKS = 60;

/**
 * 任务事件（v1.57）：**唯一**的订阅出口，供「生成事件推送」用
 * （canvas/generationEvents.ts → 画布对话面板）。
 *
 * 只发下面五种，语义与日记里的写操作一一对应：
 *   - `begin`      新一轮开始（每轮一条）；
 *   - `success` / `failed` / `cancelled`  真正的终局；
 *   - `superseded` 同一节点又发起了新一轮，上一轮被标成 cancelled（**不是**终局，
 *                  新一轮还会来 begin + 终局 —— 订阅方别把它当成「这个节点结束了」）。
 *
 * 快照里 strip 掉取消钩子（函数不能 JSON 化），其余字段原样，省得订阅方再记一遍。
 */
export type GenerationJournalEventType = 'begin' | 'success' | 'failed' | 'cancelled' | 'superseded';

export type GenerationTaskSnapshot = Omit<GenerationTask, 'cancel'>;

export interface GenerationJournalEvent {
  type: GenerationJournalEventType;
  task: GenerationTaskSnapshot;
}

function snapshotOf(task: GenerationTask): GenerationTaskSnapshot {
  const { cancel: _cancel, ...rest } = task;
  return { ...rest };
}

export interface BeginTaskInput {
  nodeId: string;
  attemptId: string;
  projectId?: string;
  type: GenerationTaskType;
  model?: string;
  title?: string;
  prompt?: string;
  cancel?: GenerationTask['cancel'];
}

export function createGenerationJournal() {
  /** attemptId → 任务 */
  const tasks = new Map<string, GenerationTask>();
  /** nodeId → 最近一次尝试的 attemptId */
  const byNode = new Map<string, string>();
  /** 加入顺序（旧 → 新） */
  const order: string[] = [];
  /** 事件订阅者（v1.57，生成事件推送）。只有一个发布点：emit()。 */
  const listeners = new Set<(event: GenerationJournalEvent) => void>();

  /**
   * 发一条任务事件。
   *
   * 订阅方抛错绝不能让生成链路失败（推送只是旁路）：逐个 try/catch，吞掉并打日志。
   * 没人订阅时提前返回，连快照都不做。
   */
  function emit(type: GenerationJournalEventType, task: GenerationTask): void {
    if (listeners.size === 0) return;
    const taskSnapshot = snapshotOf(task);
    for (const listener of [...listeners]) {
      try {
        listener({ type, task: taskSnapshot });
      } catch (error) {
        console.error(
          `[aifisher-canvas] 生成事件订阅者抛错（已忽略）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** 超量时优先扔掉最早那条**已结束**的；还在跑的一条都不扔。 */
  function prune(): void {
    while (order.length > MAX_TASKS) {
      const index = order.findIndex((id) => tasks.get(id)?.status !== 'loading');
      if (index < 0) return;
      const [id] = order.splice(index, 1);
      const task = id ? tasks.get(id) : undefined;
      if (id) tasks.delete(id);
      if (task && byNode.get(task.nodeId) === id) byNode.delete(task.nodeId);
    }
  }

  /**
   * 按 (nodeId, attemptId) 找任务。
   *
   * 调用方以前习惯传 `nodeId ?? attemptId` 当节点键，所以这里**先按 attemptId 找**，
   * 找不到再按节点索引找；找到之后由调用方自己比对 attemptId（迟到的结果不能覆盖新尝试）。
   */
  function resolve(nodeId: string, attemptId?: string): GenerationTask | undefined {
    if (attemptId) {
      const direct = tasks.get(attemptId);
      if (direct) return direct;
    }
    const indexed = byNode.get(nodeId);
    return indexed ? tasks.get(indexed) : undefined;
  }

  function finish(task: GenerationTask, status: GenerationTaskStatus, now: number): void {
    task.status = status;
    task.finishedAtMs = now;
    task.durationMs = Math.max(0, now - task.startedAtMs);
  }

  return {
    begin(input: BeginTaskInput): GenerationTask {
      const now = Date.now();
      // 同一节点的上一轮还在跑：标成「被取代」。不这么做的话，那个旧 attemptId 的任务
      // 永远不会收到 succeed/fail，面板上就挂一条永远是「运行中」的僵尸行。
      const previousId = byNode.get(input.nodeId);
      const previous = previousId ? tasks.get(previousId) : undefined;
      if (previous && previous.status === 'loading' && previous.attemptId !== input.attemptId) {
        finish(previous, 'cancelled', now);
        previous.code = 'GENERATION_SUPERSEDED';
        previous.error = '这个节点又发起了新一轮生成，上一轮已作废。';
        emit('superseded', previous);
      }
      // 同一个 attemptId 重复 begin（重试/重放）：把旧的那条从顺序表里摘掉，别留重复行。
      const existingIndex = order.indexOf(input.attemptId);
      if (existingIndex >= 0) order.splice(existingIndex, 1);
      const task: GenerationTask = {
        id: input.attemptId,
        nodeId: input.nodeId,
        attemptId: input.attemptId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        type: input.type,
        ...(input.model ? { model: input.model } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        status: 'loading',
        createdAt: new Date(now).toISOString(),
        createdAtMs: now,
        startedAtMs: now,
        ...(input.cancel ? { cancel: input.cancel } : {}),
      };
      tasks.set(task.id, task);
      byNode.set(input.nodeId, task.id);
      order.push(task.id);
      prune();
      emit('begin', task);
      return task;
    },

    /** 记下 ComfyUI 的 prompt_id（取消时要按它清队列）。 */
    attachPromptId(nodeId: string, attemptId: string, promptId: string): void {
      const task = resolve(nodeId, attemptId);
      if (task?.attemptId === attemptId) task.promptId = promptId;
    },

    succeed(
      nodeId: string,
      attemptId: string,
      result: {
        resultUrl?: string;
        resultUrls?: string[];
        text?: string;
        /** 面板上补一条更准确的结果数（ComfyUI 一次可能出多张）。 */
        resultCount?: number;
      },
    ): void {
      const task = resolve(nodeId, attemptId);
      if (task?.attemptId !== attemptId) return;
      finish(task, 'success', Date.now());
      task.resultUrl = result.resultUrl;
      task.resultUrls =
        result.resultUrls ??
        (result.resultUrl ? [result.resultUrl] : undefined);
      if (result.text !== undefined) task.text = result.text;
      emit('success', task);
    },

    fail(nodeId: string, attemptId: string, failure: { code?: string; error: string }): void {
      const task = resolve(nodeId, attemptId);
      if (task?.attemptId !== attemptId) return;
      finish(task, 'failed', Date.now());
      task.code = failure.code;
      task.error = failure.error;
      emit('failed', task);
    },

    /** 执行器在轮询间隙调用：返回 true 表示这次尝试已被取消，应立刻停止等待。 */
    isCancelled(nodeId: string, attemptId: string): boolean {
      const task = resolve(nodeId, attemptId);
      return task?.attemptId === attemptId && task.status === 'cancelled';
    },

    /** 某节点最近一次尝试（结果回收 / 取消都按它取）。 */
    get(nodeId: string): GenerationTask | undefined {
      const indexed = byNode.get(nodeId);
      return indexed ? tasks.get(indexed) : undefined;
    },

    /** 按任务 id 取（任务队列面板取消时用）。 */
    getById(id: string): GenerationTask | undefined {
      return tasks.get(id);
    },

    /**
     * 取消。attemptId 不匹配时拒绝（旧 UI 不能取消新任务）。
     * 返回 undefined 表示没有这个任务。
     */
    async cancel(
      nodeId: string,
      attemptId?: string,
    ): Promise<{ ok: boolean; task: GenerationTask; code?: string } | undefined> {
      const task = resolve(nodeId, attemptId);
      if (!task) return undefined;
      if (attemptId && task.attemptId !== attemptId) {
        return { ok: false, task, code: 'GENERATION_ATTEMPT_CONFLICT' };
      }
      if (task.status !== 'loading') {
        return { ok: false, task, code: 'GENERATION_NOT_CANCELLABLE' };
      }
      finish(task, 'cancelled', Date.now());
      task.code = 'GENERATION_CANCELLED';
      task.error = '生成任务已取消。';
      emit('cancelled', task);
      try {
        await task.cancel?.();
      } catch {
        // 远端可能已经跑完：日记里已经标成 cancelled，真正的判定交给结果回收
      }
      return { ok: true, task };
    },

    /**
     * 订阅任务事件（v1.57 生成事件推送）。返回取消订阅函数。
     *
     * 事件是**旁路**：订阅方拿到的 task 是快照，改它不会影响日记；抛错也不会影响生成。
     */
    subscribe(listener: (event: GenerationJournalEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** 诊断用快照（旧→新，含全部历史）。 */
    snapshot(): Array<Omit<GenerationTask, 'cancel'>> {
      return [...tasks.values()].map(({ cancel: _cancel, ...rest }) => rest);
    },

    /**
     * 任务队列面板要的列表：**新的在前**，最多 limit 条（默认 30）。
     *
     * 返回体里 strip 掉取消钩子（函数不能 JSON 化），换成 `cancellable` 布尔 —— 面板据此
     * 决定给不给「取消」按钮；同时补上 `elapsedMs`（正在跑的按当前时刻算），这样面板不用
     * 自己拿两种时钟去猜。
     */
    list(limit = 30): Array<
      Omit<GenerationTask, 'cancel'> & { elapsedMs: number; cancellable: boolean }
    > {
      const now = Date.now();
      const size = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TASKS, Math.floor(limit))) : 30;
      const picked: Array<
        Omit<GenerationTask, 'cancel'> & { elapsedMs: number; cancellable: boolean }
      > = [];
      for (let i = order.length - 1; i >= 0 && picked.length < size; i -= 1) {
        const id = order[i];
        const task = id ? tasks.get(id) : undefined;
        if (!task) continue;
        const { cancel, ...rest } = task;
        picked.push({
          ...rest,
          cancellable: task.status === 'loading' && Boolean(cancel),
          elapsedMs: Math.max(0, (task.finishedAtMs ?? now) - task.startedAtMs),
        });
      }
      return picked;
    },

    /** 正在跑 / 已结束的条数（面板顶部的角标与 host 日志用）。 */
    stats(): { total: number; running: number; finished: number } {
      let running = 0;
      for (const task of tasks.values()) if (task.status === 'loading') running += 1;
      return { total: tasks.size, running, finished: tasks.size - running };
    },

    /** 清空**已结束**的任务（正在跑的一条不动）。返回清掉的条数。 */
    clearFinished(): number {
      let removed = 0;
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const id = order[i];
        const task = id ? tasks.get(id) : undefined;
        if (!task || task.status === 'loading') continue;
        order.splice(i, 1);
        tasks.delete(task.id);
        if (byNode.get(task.nodeId) === task.id) byNode.delete(task.nodeId);
        removed += 1;
      }
      return removed;
    },
  };
}

export type GenerationJournal = ReturnType<typeof createGenerationJournal>;

/** 日记里的任务 → `/generation-status/:nodeId` 的响应体（照上游 taskResponse）。 */
export function taskResponse(task: GenerationTask): Record<string, unknown> {
  const diagnostics = {
    attemptId: task.attemptId,
    durationMs: task.durationMs,
    diagnosticCode: task.code,
  };
  if (task.status === 'loading') return { status: 'pending', attemptId: task.attemptId };
  if (task.status === 'success') {
    return {
      status: 'success',
      type: task.type,
      resultUrl: task.resultUrl,
      resultUrls: task.resultUrls,
      text: task.text,
      createdAt: task.createdAt,
      model: task.model,
      ...diagnostics,
    };
  }
  return {
    status: task.status,
    code: task.code,
    error: task.error,
    ...diagnostics,
  };
}
