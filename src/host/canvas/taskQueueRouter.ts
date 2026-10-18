/**
 * 生成「任务队列」接口（host 半，v1.24）。
 *
 * 画布右侧那块任务队列面板（src/canvas-ui/canvas/CanvasTaskQueue.tsx）读这里：
 *
 *   GET    /api/aifisher/canvas/tasks?limit=30   最近的任务（新的在前）+ 运行中条数
 *   POST   /api/aifisher/canvas/tasks/cancel      { taskId } 或 { nodeId, attemptId }
 *   DELETE /api/aifisher/canvas/tasks             清掉**已结束**的（正在跑的不动）
 *
 * 数据源就是生成任务日记（comfyui/generationJournal.ts，内存）：画布上两条生成链路
 * （本地 ComfyUI 工作流、云端 OpenAI 通道 / 方舟直连）都往里写，所以面板是**一处看全**，
 * 不用分两个面板、也不用轮询两个接口。
 *
 * 与 `/generation-status/:nodeId` 的分工（别混）：那是**结果回收**协议，回答「这一次尝试
 * 该不该把结果写回节点」，状态词表是 pending/success/failed/cancelled；这里是**给人看的
 * 队列视图**，状态词表统一成 running/success/failed/cancelled，时间戳全部给 epoch 毫秒
 * （面板要每秒钟刷一次「已运行 3.4s」，不想拿 ISO 字符串反解析）。
 *
 * 取消只有本地工作流能真取消（日记里挂了 cancel 钩子 → 清 ComfyUI 队列 / interrupt）。
 * 云端那几条是一次阻塞到收尾的 HTTP 调用，面板上不给取消按钮，这里也如实回 409。
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '../http/httpUtil';
import { requestedModelName } from '../generation/cloudGenerationRouter';
import type { GenerationJournal, GenerationTask, GenerationTaskType } from '../comfyui/generationJournal';

export interface TaskQueueDeps {
  journal: GenerationJournal;
}

/** 面板那一行要的字段（JSON 化后直接喂 UI）。 */
export interface TaskQueueItem {
  id: string;
  nodeId: string;
  projectId?: string;
  /** 任务类型：workflow=本地 ComfyUI，其余是云模型的媒体类型。 */
  kind: GenerationTaskType;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  /** 大标题：ComfyUI 是工作流标题，云端是模型名（缺省由 UI 兜底成类型中文名）。 */
  title: string;
  model?: string;
  /** 提示词片段（已截断，面板只显示开头）。 */
  prompt?: string;
  code?: string;
  error?: string;
  createdAt: string;
  createdAtMs: number;
  startedAtMs: number;
  finishedAtMs?: number;
  /** 已运行 / 总耗时（毫秒）：正在跑的按「此刻」算。 */
  elapsedMs: number;
  durationMs?: number;
  /** 产出个数（图片可能一次多张）。 */
  resultCount: number;
  /** 面板是否给「取消」按钮：只有挂了取消钩子在跑的任务才有。 */
  cancellable: boolean;
}

/** 提示词在面板里只占一行：截到 240 字，省得把一条长提示撑成整屏。 */
const PROMPT_LIMIT = 240;

function clipPrompt(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > PROMPT_LIMIT ? `${trimmed.slice(0, PROMPT_LIMIT)}…` : trimmed;
}

/** 日记任务 → 面板任务（状态词表与时间字段在这里归一）。 */
export function toTaskQueueItem(
  task: Omit<GenerationTask, 'cancel'> & { elapsedMs?: number; cancellable?: boolean },
  now = Date.now(),
): TaskQueueItem {
  const resultCount =
    task.resultUrls?.length ?? (task.resultUrl ? 1 : 0);
  return {
    id: task.id,
    nodeId: task.nodeId,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    kind: task.type,
    status: task.status === 'loading' ? 'running' : task.status,
    title: task.title ?? task.model ?? '',
    ...(task.model ? { model: task.model } : {}),
    ...(clipPrompt(task.prompt) ? { prompt: clipPrompt(task.prompt)! } : {}),
    ...(task.code ? { code: task.code } : {}),
    ...(task.error ? { error: task.error } : {}),
    createdAt: task.createdAt,
    createdAtMs: task.createdAtMs,
    startedAtMs: task.startedAtMs,
    ...(task.finishedAtMs ? { finishedAtMs: task.finishedAtMs } : {}),
    elapsedMs:
      typeof task.elapsedMs === 'number'
        ? task.elapsedMs
        : Math.max(0, (task.finishedAtMs ?? now) - task.startedAtMs),
    ...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
    resultCount,
    cancellable: task.cancellable === true && task.status === 'loading',
  };
}

function parseLimit(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.min(60, Math.floor(value));
}

/** 处理 `/api/aifisher/canvas/tasks*`；已处理返回 true。 */
export async function handleTaskQueueApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: TaskQueueDeps;
}): Promise<boolean> {
  const { req, res, url, parts, deps } = input;
  if (parts[0] !== 'tasks') return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const { journal } = deps;

  // GET /tasks —— 列表
  if (parts.length === 1) {
    if (method === 'DELETE') {
      const removed = journal.clearFinished();
      sendJson(res, 200, { ok: true, removed, ...journal.stats() });
      return true;
    }
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const now = Date.now();
    const tasks = journal.list(parseLimit(url.searchParams.get('limit'))).map((task) =>
      toTaskQueueItem(task, now),
    );
    sendJson(res, 200, {
      ok: true,
      serverTime: now,
      ...journal.stats(),
      tasks,
    });
    return true;
  }

  // POST /tasks/cancel —— 取消一条正在跑的任务
  if (parts.length === 2 && parts[1] === 'cancel') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const body = (await readJsonBody(req)) as {
      taskId?: unknown;
      nodeId?: unknown;
      attemptId?: unknown;
    } | null;
    const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
    const nodeId = typeof body?.nodeId === 'string' ? body.nodeId : '';
    const attemptId = typeof body?.attemptId === 'string' ? body.attemptId : undefined;
    const target = taskId ? journal.getById(taskId) : nodeId ? journal.get(nodeId) : undefined;
    if (!target) {
      sendJson(res, 404, {
        error: '没有这条生成任务（可能已经结束，或 DSH 重启过）。',
        code: 'TASK_NOT_FOUND',
      });
      return true;
    }
    if (!target.cancel) {
      sendJson(res, 409, {
        error:
          target.status === 'loading'
            ? '这条任务在执行侧没有注册取消钩子（云端通道的请求是一次阻塞到收尾的调用），面板不能取消它。'
            : '这条任务已经结束，不需要取消。',
        code: 'TASK_NOT_CANCELLABLE',
        status: target.status,
      });
      return true;
    }
    const result = await journal.cancel(target.nodeId, attemptId ?? target.attemptId);
    if (!result) {
      sendJson(res, 404, { error: '没有这条生成任务。', code: 'TASK_NOT_FOUND' });
      return true;
    }
    if (!result.ok) {
      sendJson(res, 409, {
        error:
          result.code === 'GENERATION_ATTEMPT_CONFLICT'
            ? '这条任务已被更新的尝试替代。'
            : '这条任务已经结束，不需要取消。',
        code: result.code,
        status: result.task.status,
      });
      return true;
    }
    sendJson(res, 200, { ok: true, task: toTaskQueueItem(result.task) });
    return true;
  }

  sendJson(res, 404, { error: '没有这个任务队列接口。', code: 'NOT_FOUND', path: parts.join('/') });
  return true;
}

/** 云模型类型的中文名（任务标题的兜底，模型名取不到时才用）。 */
const CLOUD_KIND_TITLES: Readonly<Record<'image' | 'video' | 'audio' | 'text', string>> = {
  image: '云端图片',
  video: '云端视频',
  audio: '云端音频',
  text: '云端文本',
};

/**
 * 把一次云端生成请求挂进任务日记，返回「收尾」函数（调用方在响应写完、或抛错之后调）。
 *
 * 为什么要读响应体：云端生成是一次阻塞到收尾的 POST，失败信息（code/error）只在
 * `sendJson` 写出去的那个 JSON 里，而 `handleCloudGeneration` 的分支有十来处、各自直接
 * 写响应。与其在每一处插一次日记，不如在这一层把 `res.end` 包一层，**只抄一份响应体**，
 * 响应本身原样透传（sendJson 一次性写完，正常就一个 chunk）。
 *
 * 云端任务**不注册取消钩子**：请求已经在等端点返回，面板上不给取消按钮（见本文件头部说明）。
 */
export function trackCloudTask(input: {
  journal: GenerationJournal;
  kind: 'image' | 'video' | 'audio' | 'text';
  body: Record<string, unknown> | null;
  res: ServerResponse;
}): () => void {
  const { journal, kind, body, res } = input;
  const nodeId = typeof body?.nodeId === 'string' ? body.nodeId : '';
  const attemptId =
    typeof body?.generationAttemptId === 'string' && body.generationAttemptId
      ? body.generationAttemptId
      : `cloud-${kind}-${randomUUID()}`;
  const model = requestedModelName(body);
  const prompt =
    (typeof body?.prompt === 'string' && body.prompt) ||
    (typeof body?.text === 'string' && body.text) ||
    undefined;
  // 结果回收按 nodeId 索引；云端请求万一没带 nodeId（画布老版本），就用 attemptId 当键。
  const key = nodeId || attemptId;
  journal.begin({
    nodeId: key,
    attemptId,
    type: kind,
    ...(model ? { model, title: model } : { title: CLOUD_KIND_TITLES[kind] }),
    ...(prompt ? { prompt } : {}),
  });

  const chunks: string[] = [];
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
  let settled = false;
  (res as unknown as { end: unknown }).end = ((chunk?: unknown, ...rest: unknown[]) => {
    try {
      if (typeof chunk === 'string') chunks.push(chunk);
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk).toString('utf8'));
    } catch {
      /* 抄不动就算了：真正写响应不能因为诊断信息失败而中断 */
    }
    return originalEnd(chunk, ...rest);
  }) as typeof res.end;

  return () => {
    if (settled) return;
    settled = true;
    const status = res.statusCode ?? 0;
    let payload: Record<string, unknown> | null = null;
    try {
      payload = chunks.length ? (JSON.parse(chunks.join('')) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }
    if (status >= 200 && status < 300) {
      const urls = Array.isArray(payload?.resultUrls)
        ? payload.resultUrls.filter((value): value is string => typeof value === 'string')
        : [];
      const single = typeof payload?.resultUrl === 'string' ? payload.resultUrl : undefined;
      journal.succeed(key, attemptId, {
        ...(single ? { resultUrl: single } : {}),
        ...(urls.length ? { resultUrls: urls } : {}),
      });
      return;
    }
    journal.fail(key, attemptId, {
      code: typeof payload?.code === 'string' ? payload.code : `CLOUD_HTTP_${status}`,
      error:
        typeof payload?.error === 'string' && payload.error
          ? payload.error
          : `云端生成失败（HTTP ${status}）。`,
    });
  };
}
