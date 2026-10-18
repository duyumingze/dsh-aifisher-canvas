/**
 * 本地工作流的「排队 → 等结果 → 落素材库」执行器（host 半）
 *
 * 移植自 AIFISHER:
 *   server/comfyui/legacyComfyGenerationRouter.js  （统一入口 POST /api/comfy/:workflowType）
 *   server/comfyui/comfyClient.js 的 queuePrompt / getHistory  （等结果 + 取输出）
 *   server/media/mediaAssetRouter.js 的「结果落库」那一段（saveMediaToFile 的等价物）
 *
 * 与上游的两处刻意差异：
 *   1. 上游靠 WebSocket 的 `executing{node:null}` 事件判定「跑完了」。本插件第一条实现走
 *      **轮询 /history**：少一条长连接要维护，超时/取消也更好控；退避间隔 1s→2s。
 *   2. 上游把结果下成 data URL 再交给素材库；这里直接拿字节写盘（mediaStore.save），
 *      少一次 base64 往返，2GB 的视频也不会把内存翻倍。
 *
 * 结果素材的 URL 是 `/api/aifisher/canvas/media/<projectId>/videos/<file>`，
 * 画布拿到就直接当 <video src> 用（同源，不需要 proxy）。
 */
import type { MediaRecord, MediaStore } from '../canvas/mediaStore';
import type { ComfyClient } from './comfyClient';
import type { GenerationJournal } from './generationJournal';

/** 输出类型（目录名）→ 与 ComfyUI 输出字段的对应关系。 */
export type OutputKind = 'images' | 'videos' | 'audios';

export interface OutputRef {
  filename: string;
  subfolder?: string;
  type?: string;
  kind: OutputKind;
}

/** 执行期的统一错误：带 code，路由直接透传给前端。 */
export class ComfyRunError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = 'ComfyRunError';
    this.code = code;
    this.status = status;
  }
}

interface HistoryEntry {
  outputs?: Record<string, Record<string, unknown>>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
}

/** 从 history 的一个条目里挑出「要落库的那个产出」。 */
export function extractOutput(
  history: Record<string, unknown>,
  promptId: string,
  outputNodeId?: string,
): OutputRef | null {
  const entry = history[promptId] as HistoryEntry | undefined;
  const outputs = entry?.outputs;
  if (!outputs) return null;

  const pickFrom = (nodeOutput: Record<string, unknown>): OutputRef | null => {
    const images = nodeOutput.images as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(images) && images.length) {
      return toRef(images[0], 'images');
    }
    const audio = nodeOutput.audio as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(audio) && audio.length) {
      return toRef(audio[0], 'audios');
    }
    // VideoHelperSuite 把视频预览放在历史的 gifs 字段里（上游注释同样提醒）
    const video =
      (nodeOutput.gifs as Array<Record<string, unknown>> | undefined)?.[0] ??
      (nodeOutput.videos as Array<Record<string, unknown>> | undefined)?.[0];
    if (video) return toRef(video, 'videos');
    return null;
  };

  if (outputNodeId && outputs[outputNodeId]) {
    const found = pickFrom(outputs[outputNodeId]);
    if (found) return found;
  }

  // 没指定 / 指定节点没产出：优先要 type==='output' 的，其次认第一个
  let fallback: OutputRef | null = null;
  for (const nodeOutput of Object.values(outputs)) {
    const found = pickFrom(nodeOutput);
    if (!found) continue;
    if (found.type === 'output') return found;
    fallback ??= found;
  }
  return fallback;
}

function toRef(raw: Record<string, unknown>, kind: OutputKind): OutputRef | null {
  const filename = typeof raw.filename === 'string' ? raw.filename : '';
  if (!filename) return null;
  return {
    filename,
    ...(typeof raw.subfolder === 'string' && raw.subfolder ? { subfolder: raw.subfolder } : {}),
    ...(typeof raw.type === 'string' && raw.type ? { type: raw.type } : {}),
    kind,
  };
}

/** ComfyUI 把执行失败的原因塞在 status.messages 里，挑出来给用户看。 */
function executionError(entry: HistoryEntry): string | null {
  if (entry.status?.status_str !== 'error') return null;
  const messages = Array.isArray(entry.status.messages) ? entry.status.messages : [];
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 'execution_error') continue;
    const data = message[1] as Record<string, unknown> | undefined;
    const detail = data?.exception_message ?? data?.exception_type;
    if (typeof detail === 'string' && detail) return detail;
  }
  return 'ComfyUI 执行失败';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitOptions {
  timeoutMs: number;
  /** 首次轮询间隔（之后线性退避到 pollMaxMs）。 */
  pollMs?: number;
  pollMaxMs?: number;
  /** 返回 true 时立刻放弃等待（用户点了取消）。 */
  isCancelled?: () => boolean;
}

/** 轮询 history 直到这一条 prompt 跑完 / 报错 / 超时。 */
export async function waitForPrompt(
  client: Pick<ComfyClient, 'getHistory'>,
  promptId: string,
  options: WaitOptions,
): Promise<HistoryEntry> {
  const started = Date.now();
  let interval = options.pollMs ?? 1000;
  const maxInterval = options.pollMaxMs ?? 4000;
  for (;;) {
    if (options.isCancelled?.()) {
      throw new ComfyRunError('生成任务已取消。', 'GENERATION_CANCELLED', 409);
    }
    let history: Record<string, unknown>;
    try {
      history = (await client.getHistory(promptId)) as Record<string, unknown>;
    } catch (error) {
      throw new ComfyRunError(
        `ComfyUI 查询任务失败：${error instanceof Error ? error.message : String(error)}`,
        'COMFY_UNAVAILABLE',
      );
    }
    const entry = history?.[promptId] as HistoryEntry | undefined;
    if (entry) {
      const failure = executionError(entry);
      if (failure) throw new ComfyRunError(failure, 'COMFY_EXECUTION_FAILED');
      if (entry.outputs && Object.keys(entry.outputs).length > 0) return entry;
    }
    if (Date.now() - started > options.timeoutMs) {
      throw new ComfyRunError(
        `ComfyUI 任务超时（${Math.round(options.timeoutMs / 1000)}s）`,
        'COMFY_TIMEOUT',
        504,
      );
    }
    await sleep(interval);
    interval = Math.min(maxInterval, Math.round(interval * 1.5));
  }
}

export interface RunWorkflowInput {
  client: ComfyClient;
  mediaStore: MediaStore;
  journal: GenerationJournal;
  /** 组装好的 prompt 图（调用方已经跑过 prepare handler） */
  workflow: Record<string, unknown>;
  /** 工作流元数据（注册表里那份） */
  meta: { id: string; title: string; outputNodeId: string; timeoutMs: number };
  projectId: string;
  nodeId?: string;
  prompt?: string;
  attemptId: string;
  clientId?: string;
}

/**
 * 提交 → 等待 → 取输出 → 落素材库。
 * 返回落库后的素材记录（router 把它包成 `{ success: true, url, asset }`）。
 */
export async function runComfyWorkflow(input: RunWorkflowInput): Promise<MediaRecord> {
  const { client, mediaStore, journal, workflow, meta, projectId, nodeId, attemptId } = input;

  const cancel = async () => {
    // 先清队列（还没开始执行的话这一步就够了），再打断正在跑的那个
    const task = journal.get(nodeId ?? '');
    if (task?.promptId) await client.deleteQueued(task.promptId).catch(() => {});
    await client.interrupt().catch(() => {});
  };
  journal.begin({
    nodeId: nodeId ?? attemptId,
    attemptId,
    projectId,
    type: 'workflow',
    model: meta.title,
    // 任务队列面板要的两样「简易参数」：这一行叫什么、这次提示词是什么
    title: meta.title,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    cancel,
  });

  let queued: { prompt_id: string };
  try {
    queued = await client.queuePrompt(workflow, input.clientId ?? 'dsh-aifisher-canvas');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    journal.fail(nodeId ?? attemptId, attemptId, { code: 'COMFY_UNAVAILABLE', error: message });
    throw new ComfyRunError(`无法提交到 ComfyUI：${message}`, 'COMFY_UNAVAILABLE');
  }
  journal.attachPromptId(nodeId ?? attemptId, attemptId, queued.prompt_id);

  try {
    const entry = await waitForPrompt(client, queued.prompt_id, {
      timeoutMs: meta.timeoutMs,
      // 回归测试把轮询压到几十毫秒，不然一个用例要等好几秒
      ...(Number(process.env.AIFISHER_COMFY_POLL_MS) > 0
        ? { pollMs: Number(process.env.AIFISHER_COMFY_POLL_MS), pollMaxMs: Number(process.env.AIFISHER_COMFY_POLL_MS) }
        : {}),
      isCancelled: () => journal.isCancelled(nodeId ?? attemptId, attemptId),
    });
    const output = extractOutput(
      { [queued.prompt_id]: entry },
      queued.prompt_id,
      meta.outputNodeId,
    );
    if (!output) {
      throw new ComfyRunError(
        `ComfyUI 没有返回可用产出（输出节点 ${meta.outputNodeId}）`,
        'COMFY_NO_OUTPUT',
      );
    }
    const { bytes, contentType } = await client.downloadView(output);
    if (bytes.byteLength === 0) {
      throw new ComfyRunError('ComfyUI 产出为空文件', 'COMFY_EMPTY_OUTPUT');
    }
    const record = await mediaStore.save({
      projectId,
      type: output.kind,
      bytes,
      filename: output.filename,
      ...(nodeId ? { nodeId } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      model: meta.title,
      source: 'generation',
      extra: {
        workflowType: meta.id,
        promptId: queued.prompt_id,
        ...(contentType ? { contentType } : {}),
      },
    });
    journal.succeed(nodeId ?? attemptId, attemptId, {
      resultUrl: record.url,
      resultUrls: [record.url],
    });
    return record;
  } catch (error) {
    const failure =
      error instanceof ComfyRunError
        ? error
        : new ComfyRunError(error instanceof Error ? error.message : String(error), 'COMFY_RUN_FAILED');
    if (failure.code !== 'GENERATION_CANCELLED') {
      journal.fail(nodeId ?? attemptId, attemptId, {
        code: failure.code,
        error: failure.message,
      });
    }
    throw failure;
  }
}
