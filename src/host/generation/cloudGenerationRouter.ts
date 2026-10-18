/**
 * 云端模型生成代理（host 半）。
 *
 * 背景：画布的「云端模型」节点（`src/config/modelConfig.ts` 里那批）生成时不走本地 ComfyUI，
 * 而是把请求交给后端代跑 —— 因为 API Key 不能进浏览器。上游 AIFISHER server 里那套是
 * 「服务商矩阵」（work-fisher relay / runninghub / 即梦 / 豆包直连…），每个都有各自的私密协议和密钥，
 * 未移植也不该照猜。
 *
 * 本文件负责**第一层**：把画布发来的「AIFISHER 形状」请求（{prompt, imageModel, resolution,
 * aspectRatio, imageBase64…}）分发到真正会讲那种协议的后端。目前两条路：
 *
 *   ① 用户自配的 OpenAI 兼容通道（v1.11，多通道）—— 见 `cloudChannels.ts`。
 *      模型名就是**端点真实的模型 ID**（用户在自己的中转站/魔搭上勾选的那些），host 按名字反查通道，
 *      把请求翻译成 `{model, prompt, n, size, image…}` 再发出去。多个通道可以并存，各带各的密钥。
 *   ② 火山方舟直连 —— 请求的模型在目录里标着 `DoubaoImageProvider` 且端点指向
 *      ark.cn-beijing.volces.com 时，交给 `arkImageProvider.ts` 翻成方舟的
 *      `{model, prompt, image, size, watermark…}`。这条**不需要**任何通道，
 *      只要配了 ARK_API_KEY（设置 → 闭源服务 → 火山方舟）。
 *
 * v1.4–v1.12 还有第三条「旧版单端点」路（`AIFISHER_CLOUD_BASE_URL`：其余模型原样转给一个自建
 * AIFISHER 兼容端点），已在 v1.13 随那张设置卡片**整体移除**（2026-10-16，用户要求「移除这个
 * api 配置」）。现在模型不在任何通道、也不是方舟直连时 → 501 `CLOUD_NOT_CONFIGURED`，
 * 提示去「闭源服务 → OpenAI 通道」加通道，而不是让人去猜环境变量。
 *
 * 两条路都共用同一套响应归一化：`extractText` / `collectResultRefs` / `localizeCloudResult`
 * （见 cloudResult.ts），所以画布只需要认 `{ resultUrl | resultUrls | text }`。
 *
 * 一条配置都没有时返回 501 `CLOUD_NOT_CONFIGURED`（带可操作提示），而不是让前端拿到 401/NOT_PORTED 猜谜。
 */
import type { ServerResponse } from 'node:http';
import { sendJson } from '../http/httpUtil';
import {
  collectResultRefs,
  extractText,
  isObject,
  localizeCloudResult,
  toTextRequest,
  type CloudGenerationDeps,
  type CloudKind,
} from './cloudResult';
import {
  findArkImageTarget,
  handleArkImageGeneration,
  readArkConfig,
} from './arkImageProvider';
import {
  ChannelRequestError,
  buildChannelRequest,
  channelAsyncHeaders,
  channelDialect,
  channelRequestCount,
  channelTaskError,
  channelTaskId,
  channelTaskPoll,
  channelTaskState,
  describeFetchFailure,
  inlineChannelReferences,
  isConnectLevelFetchFailure,
  readCloudChannels,
  resolveChannelModel,
  uploadChannelReferences,
  type ChannelDialect,
  type ChannelRequestPlan,
  type CloudChannel,
  type CloudChannelModel,
  type ResolvedChannelModel,
} from './cloudChannels';

export type { CloudKind } from './cloudResult';
export {
  collectResultRefs,
  extractText,
  toTextRequest,
  type CloudGenerationDeps,
} from './cloudResult';

/** 媒体类型的中文名（报错文案用）。 */
const KIND_LABELS: Readonly<Record<CloudKind, string>> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
};

/** 响应可能要装下 base64 图片，别用默认的小上限。 */
export const CLOUD_REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;

/** 请求体里「用户选了哪个模型」的字段名（画布把模型名放在 imageModel/videoModel/… 里）。 */
export function requestedModelName(body: Record<string, unknown> | null): string {
  if (!body) return '';
  for (const key of ['imageModel', 'videoModel', 'audioModel', 'textModel', 'model']) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 参考素材列表（画布存的是本站素材 URL，名字里的 base64 是历史遗留）。 */
function referenceList(body: Record<string, unknown> | null): string[] {
  if (!body) return [];
  const raw = body.imageBase64;
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

/** 上游报错文本归一：OpenAI 形状的 `{error:{message}}` 与 `{error:'...'}` 都要认。 */
function upstreamErrorMessage(parsed: unknown, raw: string, status: number): string {
  return (
    (isObject(parsed) && typeof parsed.error === 'string' && parsed.error) ||
    (isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === 'string'
      ? parsed.error.message
      : '') ||
    raw.slice(0, 400) ||
    `HTTP ${status}`
  );
}

interface FinishContext {
  body: Record<string, unknown> | null;
  provider: string;
  model?: string;
  /** 自配通道：回执里带上通道信息（含实际生效的请求方言），画布/日志能看出这批图是走哪条通道、哪套方言来的。 */
  channel?: { id: string; label: string; dialect?: ChannelDialect };
}

/** 三条路共用的收尾：文本取 text，媒体取 resultUrl/resultUrls 并落素材库。 */
async function finishCloudResponse(
  kind: CloudKind,
  parsed: unknown,
  raw: string,
  res: ServerResponse,
  deps: CloudGenerationDeps,
  context: FinishContext,
): Promise<boolean> {
  const body = context.body;
  const projectId =
    typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : 'default';
  const nodeId = typeof body?.nodeId === 'string' && body.nodeId ? body.nodeId : undefined;
  const prompt =
    (typeof body?.prompt === 'string' && body.prompt) ||
    (typeof body?.text === 'string' && body.text) ||
    undefined;
  const channel = context.channel
    ? {
        channel: context.channel.id,
        channelLabel: context.channel.label,
        ...(context.channel.dialect ? { channelDialect: context.channel.dialect } : {}),
      }
    : {};

  if (kind === 'text') {
    const text = extractText(parsed);
    if (!text) {
      sendJson(res, 502, {
        error: '云端返回里没有可识别的文本结果。',
        code: 'CLOUD_RESULT_UNRECOGNIZED',
        raw: isObject(parsed) ? parsed : raw.slice(0, 400),
        ...channel,
      });
      return true;
    }
    sendJson(res, 200, {
      ...(isObject(parsed) ? parsed : {}),
      text,
      provider: context.provider,
      model:
        context.model ??
        (isObject(parsed) && typeof parsed.model === 'string' ? parsed.model : undefined),
      ...channel,
    });
    return true;
  }

  const refs = collectResultRefs(parsed);
  if (!refs.length) {
    sendJson(res, 502, {
      error: '云端返回里没有可识别的结果素材（既没有 url 也没有 b64_json）。',
      code: 'CLOUD_RESULT_UNRECOGNIZED',
      raw: isObject(parsed) ? parsed : raw.slice(0, 400),
      ...channel,
    });
    return true;
  }
  const urls: string[] = [];
  for (const ref of refs) {
    const url = await localizeCloudResult(
      kind,
      ref,
      {
        projectId,
        ...(nodeId ? { nodeId } : {}),
        ...(prompt ? { prompt } : {}),
        ...(context.model ? { model: context.model } : {}),
        provider: context.provider,
      },
      deps,
    );
    if (url) urls.push(url);
  }
  if (!urls.length) {
    sendJson(res, 502, { error: '云端结果无法落盘。', code: 'CLOUD_RESULT_UNRECOGNIZED', ...channel });
    return true;
  }
  sendJson(res, 200, {
    success: true,
    provider: context.provider,
    resultUrl: urls[0],
    resultUrls: urls,
    ...(context.model ? { model: context.model } : {}),
    ...(isObject(parsed) && typeof parsed.created === 'number' ? { createdAt: parsed.created } : {}),
    ...channel,
  });
  return true;
}

/**
 * 把 POST 的响应体读成 `{ parsed, raw }`（用 text 读再自己 parse：报错时上游常回 HTML）。
 */
async function readUpstreamBody(response: Response): Promise<{ parsed: unknown; raw: string }> {
  const raw = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { parsed, raw };
}

/**
 * 一次提交/轮询的失败形状（POST 不可达、上游非 2xx、轮询超时/失败都用它）。
 * 抽出来是为了让「按次提交」（魔搭的多张）与单次提交共用同一套文案与状态码。
 */
interface ChannelAttemptError {
  status: number;
  code: string;
  message: string;
  hint?: string;
  endpoint?: string;
  /** 异步任务失败时带上任务号，方便用户去端点后台查。 */
  taskId?: string;
}

/** 提交一次（POST）—— 只负责发出去，不解读结果。 */
async function postChannelRequest(input: {
  plan: ChannelRequestPlan;
  kind: CloudKind;
  channel: CloudChannel;
  fetcher: typeof fetch;
  authHeader: Record<string, string>;
}): Promise<{ ok: true; response: Response } | { ok: false; error: ChannelAttemptError }> {
  const { plan, kind, channel, fetcher, authHeader } = input;
  /**
   * 连接阶段失败可以重来，**已发出去的不行**。
   *
   * 2026-10-17 实测：这台机器到 api.work-fisher.com（Cloudflare）约 1/6 次连接 10.5s 超时
   * （`UND_ERR_CONNECT_TIMEOUT`），一次失败就报「不可达」等于把三成用户的不敢重试。
   * 而「请求已发出、响应没回来」绝不能重放 —— 对端可能已经建了任务并在计费。
   */
  const MAX_CONNECT_ATTEMPTS = 3;
  let reason = '';
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetcher(plan.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(kind === 'text' ? {} : channelAsyncHeaders(plan.dialect)),
          ...authHeader,
        },
        body: JSON.stringify(plan.payload),
        signal: AbortSignal.timeout(plan.timeoutMs),
      });
      return { ok: true, response };
    } catch (error) {
      reason = describeFetchFailure(error);
      if (attempt < MAX_CONNECT_ATTEMPTS && isConnectLevelFetchFailure(error)) {
        console.warn(
          `[aifisher-canvas] 通道「${channel.label}」提交时连接没建立（第 ${attempt} 次），重试：${reason}`,
        );
        await new Promise((done) => setTimeout(done, 400 * attempt));
        continue;
      }
      break;
    }
  }
  return {
    ok: false,
    error: {
      status: 502,
      code: 'CLOUD_UNREACHABLE',
      message: `云端通道「${channel.label}」不可达：${reason}`,
      hint: '确认这台机器能访问该地址（内网地址、需要代理的地址都可能不通）；'
        + '若报的是「已发出但没回应」，别急着重发 —— 对端可能已经建了任务并在计费。',
      endpoint: plan.endpoint,
    },
  };
}

/**
 * POST 响应 → 收尾响应。异步端点（魔搭实测）只回 task_id 时按
 * `GET {base}/tasks/{id}` 轮询到收尾，再原样交给归一化。
 */
async function resolveChannelResult(input: {
  kind: CloudKind;
  channel: CloudChannel;
  response: Response;
  plan: ChannelRequestPlan;
  fetcher: typeof fetch;
  authHeader: Record<string, string>;
}): Promise<{ ok: true; parsed: unknown; raw: string } | { ok: false; error: ChannelAttemptError }> {
  const { kind, channel, response, plan, fetcher, authHeader } = input;
  let { parsed, raw } = await readUpstreamBody(response);
  if (!response.ok) {
    const message = `云端通道「${channel.label}」生成失败（HTTP ${response.status}）：${upstreamErrorMessage(parsed, raw, response.status)}`;
    /**
     * 「额度不足」这类 403 是账户余额的事，不是请求写错了（2026-10-17 实测 FisherAI：
     * `insufficient_user_quota` + 「用户额度不足，无法预扣 ¥0.048752」）。上游原话照传，
     * 另外补一句人话，免得被当成「画布又坏了」。
     */
    const quotaExhausted = /insufficient_user_quota|insufficient_quota|额度不足|余额不足/i.test(
      `${raw} ${message}`,
    );
    return {
      ok: false,
      error: {
        status: 502,
        code: 'CLOUD_UPSTREAM_ERROR',
        message,
        ...(quotaExhausted
          ? {
              hint:
                `通道「${channel.label}」的账户余额/额度不足 —— 到该服务商的充值页充完值再试；` +
                '这条 403 是端点侧拒绝，与画布、与密钥格式都无关。',
            }
          : {}),
        endpoint: plan.endpoint,
      },
    };
  }
  // 异步端点：没有素材但有 task_id → 轮询到收尾再归一（魔搭的 task_status 当场就是 SUCCEED，不能信）
  const taskId = kind === 'text' ? null : channelTaskId(parsed);
  if (taskId && !collectResultRefs(parsed).length) {
    const completed = await pollChannelTask({
      kind,
      channel,
      taskId,
      submitUrl: plan.url,
      fetcher,
      authHeader,
    });
    if ('error' in completed) return { ok: false, error: completed.error };
    parsed = completed.parsed;
    raw = completed.raw;
  }
  return { ok: true, parsed, raw };
}

/** 把一份收尾响应里的结果素材并进 `urls`/`b64`（供按次提交时合并多份结果）。 */
function collectInto(parsed: unknown, urls: string[], b64: string[]): void {
  for (const ref of collectResultRefs(parsed)) {
    if (ref.url) urls.push(ref.url);
    else if (ref.base64) b64.push(ref.base64);
  }
}

/** 多份结果 → 一份「像端点回的那样」的收尾响应，继续走同一套归一化与落盘。 */
function mergeChannelResults(urls: readonly string[], b64: readonly string[]): Record<string, unknown> {
  return {
    output_images: [...urls],
    ...(b64.length ? { data: b64.map((value) => ({ b64_json: value })) } : {}),
  };
}

/**
 * 自配通道那一条：画布请求 → `{model, prompt, n, size, image_url…}` → 端点 → 归一化。
 *
 * 关于「生成数量」：只有 OpenAI 兼容那套能靠请求体里的 `n` 一次出多张。魔搭**不认 `n`**
 * （实测 n=2 只回 1 张），FisherAI 的低价扩展版**一个任务只收 1 张** —— 所以这两种方言
 * 按数量**真的提交几次**并合并结果：叫了 3 张就得有 3 张，不能让那个控件变成空转。
 */
async function handleChannelGeneration(
  kind: CloudKind,
  body: Record<string, unknown>,
  res: ServerResponse,
  deps: CloudGenerationDeps,
  resolved: ResolvedChannelModel,
): Promise<boolean> {
  const { channel, model } = resolved;
  const fetcher = deps.fetcher ?? globalThis.fetch;
  const references = referenceList(body);
  const dialect = channelDialect(channel);

  let images: string[] = [];
  if (references.length && (kind === 'image' || kind === 'video')) {
    try {
      // FisherAI 只收公网直链：data URL / 本站素材要先 /files/upload 换链接；
      // 其它两套方言要的是内联（或原样带公网链接）。
      images =
        dialect === 'workfisher'
          ? await uploadChannelReferences(channel, references, {
              ...(deps.mediaStore ? { mediaStore: deps.mediaStore } : {}),
              fetcher,
            })
          : await inlineChannelReferences(references, {
              ...(deps.mediaStore ? { mediaStore: deps.mediaStore } : {}),
            });
    } catch (error) {
      if (error instanceof ChannelRequestError) {
        sendJson(res, error.status, {
          error: error.message,
          code: error.code,
          ...(error.hint ? { hint: error.hint } : {}),
          channel: channel.id,
          channelLabel: channel.label,
        });
        return true;
      }
      throw error;
    }
  }

  const plan = buildChannelRequest({ channel, model, kind, body, images });
  const authHeader: Record<string, string> = channel.apiKey
    ? { authorization: `Bearer ${channel.apiKey}` }
    : {};
  const fail = (error: ChannelAttemptError): true => {
    sendJson(res, error.status, {
      error: error.message,
      code: error.code,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.endpoint ? { endpoint: error.endpoint } : {}),
      ...(error.taskId ? { taskId: error.taskId } : {}),
      channel: channel.id,
      channelLabel: channel.label,
      model: model.id,
      channelDialect: plan.dialect,
    });
    return true;
  };

  const first = await postChannelRequest({ plan, kind, channel, fetcher, authHeader });
  if (!first.ok) return fail(first.error);
  const settled = await resolveChannelResult({
    kind,
    channel,
    response: first.response,
    plan,
    fetcher,
    authHeader,
  });
  if (!settled.ok) return fail(settled.error);

  let parsed = settled.parsed;
  let raw = settled.raw;

  const wanted = kind === 'text' ? 1 : channelRequestCount(body);
  // 魔搭与 FisherAI 都不认「一次多张」：魔搭忽略 n，FisherAI 的低价扩展版一个任务只回一张。
  // 所以叫了几张就真的提交几次，再把结果合并 —— 不能让「生成数量」那个控件空转。
  if ((plan.dialect === 'modelscope' || plan.dialect === 'workfisher') && wanted > 1) {
    const urls: string[] = [];
    const b64: string[] = [];
    collectInto(parsed, urls, b64);
    // 只补「还差几张」：万一某个模型一次就回了多张，别再画蛇添足多提交
    const missing = Math.max(0, wanted - (urls.length + b64.length));
    const rest = await Promise.all(
      Array.from({ length: missing }, () =>
        submitChannelOnce({ plan, kind, channel, fetcher, authHeader }),
      ),
    );
    const failures = rest.filter((item) => !item.ok) as Array<{ ok: false; error: ChannelAttemptError }>;
    for (const item of rest) {
      if (item.ok) collectInto(item.parsed, urls, b64);
    }
    if (!urls.length && !b64.length) {
      return fail(
        failures[0]?.error ?? {
          status: 502,
          code: 'CLOUD_RESULT_UNRECOGNIZED',
          message: `云端通道「${channel.label}」没有产出任何结果素材。`,
        },
      );
    }
    parsed = mergeChannelResults(urls, b64);
    raw = JSON.stringify(parsed);
    if (failures.length) {
      console.warn(
        `[aifisher-canvas] 通道「${channel.label}」按次提交 ${wanted} 次，其中 ${failures.length} 次失败` +
          `（仍然返回 ${urls.length + b64.length} 张）：${failures.map((item) => item.error.message).join(' / ')}`,
      );
    }
  }

  return finishCloudResponse(kind, parsed, raw, res, deps, {
    body,
    provider: 'cloud',
    model: model.id,
    channel: { id: channel.id, label: channel.label, dialect: plan.dialect },
  });
}

/** 「提交一次 + 轮询到收尾」，供按次提交的方言复用。 */
async function submitChannelOnce(input: {
  plan: ChannelRequestPlan;
  kind: CloudKind;
  channel: CloudChannel;
  fetcher: typeof fetch;
  authHeader: Record<string, string>;
}): Promise<{ ok: true; parsed: unknown } | { ok: false; error: ChannelAttemptError }> {
  const posted = await postChannelRequest(input);
  if (!posted.ok) return posted;
  const settled = await resolveChannelResult({ ...input, response: posted.response });
  if (!settled.ok) return settled;
  return { ok: true, parsed: settled.parsed };
}

/**
 * 轮询异步任务直到收尾（或超时/失败）。
 *
 * 间隔 2s 起、每次 ×1.5、上限 6s；总预算取通道的超时（默认 15 分钟）——
 * 与「视频动辄十几分钟」的现实一致，且不给宿主进程留下无限轮询。
 */
async function pollChannelTask(input: {
  kind: CloudKind;
  channel: CloudChannel;
  taskId: string;
  /** 提交时用的地址：FisherAI 的轮询地址就是「提交地址 + /{task_id}」。 */
  submitUrl?: string;
  fetcher: typeof fetch;
  authHeader: Record<string, string>;
}): Promise<{ parsed: unknown; raw: string } | { error: ChannelAttemptError }> {
  const { kind, channel, taskId, fetcher, authHeader } = input;
  const poll = channelTaskPoll({
    channel,
    kind,
    taskId,
    ...(input.submitUrl ? { submitUrl: input.submitUrl } : {}),
  });
  const budgetMs = Math.min(Math.max(channel.timeoutMs, 60_000), 1_800_000);
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  let interval = 2_000;
  /**
   * 连续失败几次才认输。
   *
   * 为什么要有这个：轮询 GET 偶发**把长连接挂住或直接掐断**（2026-10-17 实测 FisherAI 的
   * `/image/generations/{id}`：第一次 30s 超时、下一次就正常回 SUCCESS）。这既不是「任务失败」
   * 也不是「端点不可达」，只是那一次请求没回来 —— 一次失败就放弃，会把一个正在跑、
   * 已经在计费的任务判成失败，而且用户看到的是一句没法处理的 `fetch failed`。
   */
  const MAX_POLL_FAILURES = 8;
  let failures = 0;
  for (;;) {
    if (Date.now() > deadline) {
      return {
        error: {
          status: 504,
          code: 'CHANNEL_TASK_TIMEOUT',
          taskId,
          message:
            `云端通道「${channel.label}」的任务在 ${Math.round(budgetMs / 1000)}s 内没结束` +
            `（任务号 ${taskId}）。可以稍后到端点后台看它是否还在跑。`,
        },
      };
    }
    await new Promise((done) => setTimeout(done, interval));
    interval = Math.min(Math.round(interval * 1.5), 6_000);
    let response: Response;
    try {
      response = await fetcher(poll.url, {
        method: 'GET',
        headers: { ...poll.headers, ...authHeader },
        // 20s：单次查询不该占着预算；慢了就当这一次没回来，下一轮再问
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      failures += 1;
      const reason = describeFetchFailure(error);
      if (failures >= MAX_POLL_FAILURES) {
        return {
          error: {
            status: 502,
            code: 'CLOUD_UNREACHABLE',
            taskId,
            message:
              `查询云端通道「${channel.label}」的任务状态连续 ${failures} 次失败：${reason}` +
              `（任务号 ${taskId}，可能还在跑；它已经计费，别急着重发）。`,
          },
        };
      }
      console.warn(
        `[aifisher-canvas] 通道「${channel.label}」轮询第 ${failures} 次失败，稍后重试：${reason}`,
      );
      continue;
    }
    const read = await readUpstreamBody(response);
    if (!response.ok) {
      // 有些端点在任务跑完后会把 /tasks/{id} 变成 404/"task not found"：这时只要最后一次
      // 响应里**有结果素材**就当成功（魔搭实测过一次这种情况），否则如实报错。
      if (collectResultRefs(read.parsed).length) return read;
      // 5xx / 429 是网关侧的抖动，跟「这一次没回来」一样按可重试处理
      if (response.status >= 500 || response.status === 429) {
        failures += 1;
        if (failures < MAX_POLL_FAILURES) {
          console.warn(
            `[aifisher-canvas] 通道「${channel.label}」轮询拿到 HTTP ${response.status}，稍后重试`,
          );
          continue;
        }
      }
      return {
        error: {
          status: 502,
          code: 'CLOUD_UPSTREAM_ERROR',
          taskId,
          message: `查询云端通道「${channel.label}」的任务状态失败（HTTP ${response.status}）：${upstreamErrorMessage(read.parsed, read.raw, response.status)}`,
        },
      };
    }
    failures = 0;
    const status = channelTaskState(read.parsed);
    if (status.state === 'succeeded') return read;
    if (status.state === 'failed') {
      const reason = channelTaskError(read.parsed);
      return {
        error: {
          status: 502,
          code: 'CHANNEL_TASK_FAILED',
          taskId,
          message: `云端通道「${channel.label}」的任务失败${reason ? `：${reason}` : '（端点没给原因）'}。`,
        },
      };
    }
  }
}

/**
 * 处理 `/api/aifisher/canvas/generate-<kind>`。已处理返回 true。
 *
 * `body` 由调用方读好传进来（restRouter 那边已经有读 body 的统一入口），
 * 这样本模块不必关心 node:http 的流细节，也方便单测。
 * `deps.dataDir` = 画布数据目录（读自配通道表用）；缺省则跳过第 ① 条。
 */
export async function handleCloudGeneration(
  kind: CloudKind,
  body: Record<string, unknown> | null,
  res: ServerResponse,
  deps: CloudGenerationDeps & { dataDir?: string } = {},
): Promise<boolean> {
  if (body === null) {
    sendJson(res, 422, { error: '请求体不是合法 JSON。', code: 'INVALID_BODY' });
    return true;
  }

  // ① 用户自配的 OpenAI 通道：模型名就是端点模型 ID（v1.11，可以有多个通道）
  const modelName = requestedModelName(body);
  let channels: CloudChannel[] = [];
  if (deps.dataDir) {
    channels = await readCloudChannels(deps.dataDir);
    if (channels.length) {
      const resolved = resolveChannelModel(channels, modelName, kind);
      if (resolved) return handleChannelGeneration(kind, body, res, deps, resolved);
      // 名字对不上这个媒体类型、但对得上别的类型 → 明确说是「勾错了类型」，
      // 否则会掉到旧版端点那里拿到一句莫名其妙的 400。对不上任何通道就继续往下走。
      const other = resolveChannelModel(channels, modelName);
      if (other) {
        sendJson(res, 422, {
          error:
            `模型「${other.model.id}」在通道「${other.channel.label}」里登记的是` +
            `${KIND_LABELS[other.model.kind]}模型，不能在${KIND_LABELS[kind]}节点上使用。`,
          code: 'CHANNEL_KIND_MISMATCH',
          model: other.model.id,
          expectedKind: other.model.kind,
          receivedKind: kind,
          channel: other.channel.id,
          channelLabel: other.channel.label,
          hint: '到「设置 → 闭源服务 → OpenAI 通道」把这条模型的类型改成正确的，或换一个节点。',
        });
        return true;
      }
    }
  }

  // ② 目录里标着方舟直连的图片模型先走方舟：它有自己的请求形状（size/image/watermark…），
  // 原样转给自配通道只会拿到方舟的 400。视频/音频方舟走的是另一套异步任务接口，暂不接管。
  if (kind === 'image') {
    const target = findArkImageTarget(body);
    if (target) return handleArkImageGeneration(body, res, deps, target);
  }

  // 没配通道、也不是方舟直连：如实说清楚去哪儿配（旧版单端点 AIFISHER_CLOUD_BASE_URL 已在
  // v1.13 移除，这里不再兜底转发）。
  sendJson(res, 501, {
    error:
      '云端模型生成未配置：画布可以继续用本地 ComfyUI 工作流。' +
      '要启用云端模型，请在「设置 → 闭源服务 → OpenAI 通道」里添加通道并勾选模型；' +
      '用火山方舟（豆包）直连则只需填 ARK_API_KEY。',
    code: 'CLOUD_NOT_CONFIGURED',
    ...(modelName ? { model: modelName } : {}),
    ...(channels.length ? { channels: channels.map((channel) => channel.id) } : {}),
  });
  return true;
}

/** `/api/aifisher/canvas/generate-<kind>` → kind；不是这条路由返回 null。 */
export function cloudKindOfPath(pathname: string): CloudKind | null {
  const match = /^\/api\/aifisher\/canvas\/generate-(image|video|audio|text)$/.exec(pathname);
  if (!match) return null;
  return match[1] as CloudKind;
}

/** 诊断用：云端生成可用性（**不回显密钥**，只回通道名/条数）。 */
export async function cloudGenerationStatus(dataDir: string): Promise<Record<string, unknown>> {
  const channels = await readCloudChannels(dataDir);
  const arkReady = Boolean(readArkConfig().apiKey);
  const usable = channels.filter((channel) => channel.models.length > 0);
  return {
    configured: usable.length > 0 || arkReady,
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      apiKeySet: Boolean(channel.apiKey),
      models: channel.models.length,
    })),
    arkConfigured: arkReady,
    hint:
      usable.length || arkReady
        ? null
        : '在「设置 → 闭源服务 → OpenAI 通道」里添加通道并勾选模型，或填 ARK_API_KEY 用方舟直连。',
  };
}

export type { CloudChannel, CloudChannelModel };
