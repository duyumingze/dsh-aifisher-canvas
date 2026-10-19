/**
 * 生成事件总线（v1.57）：把生成任务日记的事件，按「**批次**」成组交给画布对话面板。
 *
 * ## 为什么是批次而不是单条任务
 *
 * Agent 用 `prepareGeneration` 一次准备一批（3 个镜头），用户点一次「确认本批生成与费用」，
 * 画布逐个提交。三个任务各自结束的时刻差很远（图片 10s、视频 60s+）。如果每结束一个就推一条，
 * 面板会被灌进 3 条系统消息、模型也被叫醒 3 次；而用户真正要知道的是「**这一批跑完了，接下来干吗**」。
 * 所以这里的关键词是**成组**：一批的节点全部到终点（success / failed / cancelled）才交付一次。
 *
 * 兜底：某个节点卡住（提交失败停在 unconfirmed、或日记被清掉）不能让整批永远静默。
 * 第一条终点事件之后最多再等 `idleFlushMs`（默认 90s），到点就带着「还有 N 个没结束」交付。
 *
 * ## 身份与绑定
 *
 * - 事件里的 `nodeId` 就是画布节点 id（云端链路 nodeId、ComfyUI 链路也一样）；
 * - 绑定来自 `POST /api/aifisher/canvas/agent/plans`（画布提交准备批次时带 sessionId + items），
 *   也就是**只有 Agent 准备的批次才会有推送** —— 用户在画布上直接点生成、或从任务队列面板发起的那
 *   些，不进这里（任务队列面板本来就是它们的实时视图）。
 * - 绑定默认 2 小时过期：用户准备了却一直没确认，那些节点后来自己点了生成，也不该冒出推送。
 *
 * ## 事件口径
 *
 * 日记的 `superseded`（节点又开跑一轮、上一轮作废）**不算终点**：新一轮会有自己的 begin + 终点。
 * 把它当终点的话，同一节点连续重跑会让批次提前收口，推出去的结论还是错的。
 */
import { randomUUID } from 'node:crypto';
import type {
  GenerationJournal,
  GenerationJournalEvent,
  GenerationTaskSnapshot,
  GenerationTaskStatus,
  GenerationTaskType,
} from '../comfyui/generationJournal';

export type GenerationEventType = GenerationJournalEvent['type'];

/** GET /events 里的一条（JSON 化后直接给界面/agent 看）。 */
export interface GenerationEventRecord {
  /** 单调递增序号：客户端按它增量拉取（`?since=`）。 */
  seq: number;
  /** 事件时刻（epoch ms）。 */
  at: number;
  type: GenerationEventType;
  nodeId: string;
  projectId?: string;
  /** 媒体类型：image / video / audio / text / workflow（本地 ComfyUI）。 */
  kind: GenerationTaskType;
  /** 界面上那一行的标题：ComfyUI 是工作流名，云端是模型名。 */
  title: string;
  model?: string;
  status: GenerationTaskStatus;
  durationMs?: number;
  /** 产出个数（图片可能一次多张）。 */
  resultCount: number;
  /** 失败码（COMFY_NODE_MISSING / CLOUD_NOT_CONFIGURED / GENERATION_SUPERSEDED …）。 */
  code?: string;
  error?: string;
  /** 属于哪个准备批次（只有 Agent 准备的批次才有）。 */
  batchId?: string;
}

/** 一批交付时给推送层的内容。 */
export interface GenerationBatchResult {
  batchId: string;
  /** 准备这批的 DSH 会话（画布对话面板 = 一个 DSH 会话）。 */
  sessionId: string;
  projectId?: string;
  /** 本批已经到终点的节点事件（按准备顺序）。 */
  events: GenerationEventRecord[];
  /** 到点还没结束的节点（推文里要如实说明，别让模型以为全跑完了）。 */
  unfinished: Array<{ nodeId: string; title: string }>;
}

interface BatchState {
  id: string;
  sessionId: string;
  projectId?: string;
  /** 准备时的节点顺序（推送按这个顺序列，跟用户确认卡片一致）。 */
  nodeIds: string[];
  preparedAt: number;
  /** nodeId → 终点事件（只放 success / failed / cancelled，且不是 superseded）。 */
  finished: Map<string, GenerationEventRecord>;
  /** 兜底交付定时器（第一条终点事件之后启动）。 */
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

export interface GenerationEventsOptions {
  journal: GenerationJournal;
  /** 事件环形缓冲上限（默认 200；GET /events 与诊断用）。 */
  maxEvents?: number;
  /**
   * 第一条终点事件后最多再等多久（默认 90s）。
   * 环境变量 `AIFISHER_EVENTS_IDLE_FLUSH_MS` 可覆盖（回归测试用很小的值）。
   */
  idleFlushMs?: number;
  /** 绑定有效期（默认 2h）。 */
  bindingTtlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_IDLE_FLUSH_MS = 90_000;
const DEFAULT_BINDING_TTL_MS = 2 * 60 * 60_000;
/** 同时保留多少批（防止未确认的批次无限堆积）。 */
const MAX_BATCHES = 20;

const KIND_LABELS: Readonly<Record<GenerationTaskType, string>> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
  workflow: '本地工作流',
};

const STATUS_LABELS: Readonly<Record<GenerationTaskStatus, string>> = {
  loading: '生成中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};

function envNumber(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 一行事件的中文描述（推送文案与 /events 的 hint 共用）。 */
export function describeGenerationEvent(event: GenerationEventRecord): string {
  const parts: string[] = [];
  parts.push(`${KIND_LABELS[event.kind] ?? event.kind}`);
  if (event.model && event.model !== event.title) parts.push(event.model);
  const status = STATUS_LABELS[event.status] ?? event.status;
  if (event.type === 'superseded') {
    parts.push('上一轮已被新的尝试替代');
  } else if (event.status === 'success') {
    const count = event.resultCount > 0 ? event.resultCount : 1;
    parts.push(`成功，${count} 个结果`);
    if (event.durationMs !== undefined) parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
  } else if (event.status === 'failed') {
    parts.push('失败');
    if (event.code) parts.push(event.code);
    if (event.error) parts.push(clip(event.error, 160));
  } else {
    parts.push(status);
    if (event.code) parts.push(event.code);
  }
  return parts.join(' · ');
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 一批事件 → 推给画布对话面板的一段话。
 *
 * 语气是「宿主在报状态」而不是「用户在提要求」：开头点明不是用户发言（不然模型会当成新指令），
 * 结尾给下一步（preview 自评 / 修原因重试 / 不必复述），并重申审批红线。
 */
export function formatGenerationBatch(payload: GenerationBatchResult): string {
  const lines: string[] = [];
  lines.push('【画布生成事件｜宿主自动推送，不是用户发言，也不是一条新任务】');
  const total = payload.events.length + payload.unfinished.length;
  lines.push(`你之前准备的那批生成已结束（共 ${total} 个节点）：`);
  for (const event of payload.events) {
    lines.push(`- 节点 ${event.nodeId}「${event.title}」：${describeGenerationEvent(event)}`);
  }
  for (const pending of payload.unfinished) {
    lines.push(`- 节点 ${pending.nodeId}「${pending.title}」：还没有结束（超时未回，去看节点状态）`);
  }
  lines.push(
    '下一步（按需，不用复述这段事件，也不要把它当成用户的新要求）：' +
      '成功的用 canvas_control action:"preview" 拿本机文件路径、再用 read_image 看画面自评；' +
      '失败的先修原因（缺节点/模型未开通/提示词或参数），再 action:"prepareGeneration" 重新准备，' +
      '**最后仍然要用户点「确认本批生成与费用」，不要尝试提交或绕过**。',
  );
  return lines.join('\n');
}

/** 多批合并成一条消息（同一会话短时间内收口两批时）。 */
export function formatGenerationBatches(list: readonly GenerationBatchResult[]): string {
  return list.map(formatGenerationBatch).join('\n\n');
}

export function createGenerationEvents(options: GenerationEventsOptions) {
  const journal = options.journal;
  const now = options.now ?? (() => Date.now());
  const maxEvents = Math.max(20, options.maxEvents ?? DEFAULT_MAX_EVENTS);
  const idleFlushMs =
    options.idleFlushMs ?? envNumber('AIFISHER_EVENTS_IDLE_FLUSH_MS') ?? DEFAULT_IDLE_FLUSH_MS;
  const bindingTtlMs = options.bindingTtlMs ?? DEFAULT_BINDING_TTL_MS;

  /** 事件环形缓冲（旧 → 新）。 */
  const events: GenerationEventRecord[] = [];
  let seq = 0;
  const batches = new Map<string, BatchState>();
  /** nodeId → batchId（同一个节点被下一批重新准备时覆盖）。 */
  const byNode = new Map<string, string>();
  const completeListeners = new Set<(payload: GenerationBatchResult) => void>();
  let journalEvents = 0;
  let completedBatches = 0;

  function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
    // 不要让兜底定时器拽着进程不退（关 DSH 时不该等它）
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  }

  function dropBatch(batch: BatchState): void {
    if (batch.idleTimer) clearTimeout(batch.idleTimer);
    batch.idleTimer = undefined;
    batch.closed = true;
    batches.delete(batch.id);
    for (const nodeId of batch.nodeIds) {
      if (byNode.get(nodeId) === batch.id) byNode.delete(nodeId);
    }
  }

  /** 绑定过期清理（绑定只活 2 小时，避免「半年前准备好的节点」冒出推送）。 */
  function pruneBindings(): void {
    const deadline = now() - bindingTtlMs;
    for (const batch of [...batches.values()]) {
      if (batch.preparedAt < deadline) dropBatch(batch);
    }
  }

  function closeBatch(batch: BatchState): void {
    if (batch.closed) return;
    const orderedEvents: GenerationEventRecord[] = [];
    const unfinished: Array<{ nodeId: string; title: string }> = [];
    for (const nodeId of batch.nodeIds) {
      const event = batch.finished.get(nodeId);
      if (event) {
        orderedEvents.push(event);
        continue;
      }
      unfinished.push({ nodeId, title: nodeId });
    }
    const payload: GenerationBatchResult = {
      batchId: batch.id,
      sessionId: batch.sessionId,
      ...(batch.projectId ? { projectId: batch.projectId } : {}),
      events: orderedEvents,
      unfinished,
    };
    dropBatch(batch);
    if (orderedEvents.length === 0) return; // 一个终点事件都没有：不打扰用户
    completedBatches += 1;
    for (const listener of [...completeListeners]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(
          `[aifisher-canvas] 生成批次订阅者抛错（已忽略）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  function armIdleTimer(batch: BatchState): void {
    if (batch.idleTimer || batch.closed) return;
    batch.idleTimer = unrefTimer(
      setTimeout(() => {
        batch.idleTimer = undefined;
        if (!batch.closed) closeBatch(batch);
      }, Math.max(0, idleFlushMs)),
    );
  }

  function recordOf(event: GenerationJournalEvent): GenerationEventRecord {
    const task: GenerationTaskSnapshot = event.task;
    const batchId = byNode.get(task.nodeId);
    const batch = batchId ? batches.get(batchId) : undefined;
    const projectId = task.projectId ?? batch?.projectId;
    const at = task.finishedAtMs ?? now();
    return {
      seq: ++seq,
      at,
      type: event.type,
      nodeId: task.nodeId,
      ...(projectId ? { projectId } : {}),
      kind: task.type,
      title: clip(task.title ?? task.model ?? task.nodeId, 80) || task.nodeId,
      ...(task.model ? { model: clip(task.model, 80) } : {}),
      status: task.status,
      ...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
      resultCount: task.resultUrls?.length ?? (task.resultUrl ? 1 : 0),
      ...(task.code ? { code: clip(task.code, 80) } : {}),
      ...(task.error ? { error: clip(task.error, 240) } : {}),
      ...(batchId ? { batchId } : {}),
    };
  }

  function onJournalEvent(event: GenerationJournalEvent): void {
    journalEvents += 1;
    const record = recordOf(event);
    events.push(record);
    while (events.length > maxEvents) events.shift();

    const batchId = byNode.get(event.task.nodeId);
    if (!batchId) return;
    const batch = batches.get(batchId);
    if (!batch || batch.closed) return;
    if (event.type === 'begin' || event.type === 'superseded') return;
    // success / failed / cancelled：这个节点到终点了
    if (!batch.finished.has(record.nodeId)) {
      batch.finished.set(record.nodeId, record);
      armIdleTimer(batch);
    } else {
      batch.finished.set(record.nodeId, record); // 同一节点重复终局：以最后一条为准
    }
    if (batch.finished.size >= batch.nodeIds.length) closeBatch(batch);
  }

  const unsubscribe = journal.subscribe(onJournalEvent);

  return {
    /**
     * 绑定一批节点到某个 DSH 会话（由 plans 路由在「准备批次」时调用）。
     *
     * 同一个节点被下一批重新准备时，从上一批里摘掉（上一批少一个节点等待）；
     * 上一批因此空了就直接丢弃，不留一条永远收不了口的僵尸批次。
     */
    bindNodes(sessionId: string, nodeIds: readonly string[], batchId?: string): string {
      pruneBindings();
      const unique = [...new Set(nodeIds.filter((id) => typeof id === 'string' && id))];
      const id = batchId && batchId.trim() ? batchId.trim() : `batch-${randomUUID()}`;
      const existing = batches.get(id);
      if (existing) {
        for (const nodeId of existing.nodeIds) {
          if (byNode.get(nodeId) === id) byNode.delete(nodeId);
        }
        dropBatch(existing);
      }
      // 从别的批次里摘掉这些节点
      for (const other of [...batches.values()]) {
        let changed = false;
        for (const nodeId of unique) {
          if (!other.nodeIds.includes(nodeId)) continue;
          other.nodeIds = other.nodeIds.filter((item) => item !== nodeId);
          other.finished.delete(nodeId);
          if (byNode.get(nodeId) === other.id) byNode.delete(nodeId);
          changed = true;
        }
        if (changed && other.nodeIds.length === 0) dropBatch(other);
        else if (changed && other.finished.size >= other.nodeIds.length && other.finished.size > 0) {
          closeBatch(other);
        }
      }
      if (batches.size >= MAX_BATCHES) {
        const oldest = [...batches.values()].sort((a, b) => a.preparedAt - b.preparedAt)[0];
        if (oldest) dropBatch(oldest);
      }
      batches.set(id, {
        id,
        sessionId,
        nodeIds: unique,
        preparedAt: now(),
        finished: new Map(),
        closed: false,
      });
      for (const nodeId of unique) byNode.set(nodeId, id);
      return id;
    },

    /** 某会话当前还挂着几条准备批次（诊断用）。 */
    batchesFor(sessionId: string): string[] {
      return [...batches.values()]
        .filter((batch) => batch.sessionId === sessionId)
        .map((batch) => batch.id);
    },

    /** 批次收口的订阅（推送层用）。 */
    onBatchComplete(listener: (payload: GenerationBatchResult) => void): () => void {
      completeListeners.add(listener);
      return () => {
        completeListeners.delete(listener);
      };
    },

    /** GET /events：按序号增量拉取（`since` 之后的，旧的在前）。 */
    since(since?: number, limit = 50): { seq: number; events: GenerationEventRecord[] } {
      const from = Number.isFinite(since) && (since as number) > 0 ? Math.floor(since as number) : 0;
      const size = Math.max(1, Math.min(maxEvents, Math.floor(limit)));
      const picked = events.filter((event) => event.seq > from).slice(0, size);
      return { seq, events: picked };
    },

    /** 最近 N 条（新的在前），诊断/界面用。 */
    recent(limit = 20): GenerationEventRecord[] {
      const size = Math.max(1, Math.min(maxEvents, Math.floor(limit)));
      return events.slice(-size).reverse();
    },

    stats(): Record<string, unknown> {
      return {
        seq,
        kept: events.length,
        journalEvents,
        completedBatches,
        openBatches: batches.size,
        bindings: byNode.size,
        idleFlushMs,
        bindingTtlMs,
        sessions: [...new Set([...batches.values()].map((batch) => batch.sessionId))],
      };
    },

    /** 卸载时摘订阅（插件热重载/测试收尾用）。 */
    dispose(): void {
      unsubscribe();
      for (const batch of [...batches.values()]) dropBatch(batch);
      completeListeners.clear();
    },
  };
}

export type GenerationEvents = ReturnType<typeof createGenerationEvents>;
