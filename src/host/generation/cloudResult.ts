/**
 * 云端生成结果的**归一与落盘**（host 半，被两个生成链路共用）。
 *
 * 抽出来的原因：`cloudGenerationRouter`（用户自配的通用端点）与
 * `arkImageProvider`（火山方舟直连）需要**同一套**「从五花八门的响应里挑出结果 → 下载/解码 →
 * 写进素材库」的逻辑。放在任何一边都会让另一边 import 回来，形成循环依赖。
 *
 * 这里只有两类东西：
 *   1. 纯函数：`collectResultRefs`（挑 URL/base64）、`extractText`、`toTextRequest`；
 *   2. `localizeCloudResult`：把一条结果落进素材库（拿远程 URL 时先下载），
 *      落盘失败**不把生成判失败** —— 原样返回远程 URL，让画布至少能显示出来。
 */
import { pushDiagnostic } from '../canvas/diagnostics';
import type { MediaStore, MediaType } from '../canvas/mediaStore';

export type CloudKind = 'image' | 'video' | 'audio' | 'text';

export const MEDIA_TYPE_OF: Readonly<Record<Exclude<CloudKind, 'text'>, MediaType>> = {
  image: 'images',
  video: 'videos',
  audio: 'audios',
};

/** 扩展名提示：上游只给 URL 或 base64 时，用它决定落盘后缀。 */
export const EXTENSION_OF: Readonly<Record<Exclude<CloudKind, 'text'>, string>> = {
  image: '.png',
  video: '.mp4',
  audio: '.mp3',
};

/** 单个结果文件的上限（与 mediaStore 的图片上限对齐，够用且防内存爆）。 */
export const MAX_RESULT_BYTES = 256 * 1024 * 1024;

/**
 * 下载重试计划（毫秒）：第 N 个元素是「第 N+1 次失败后、下一次之前」的等待。
 *
 * 为什么要有（2026-10-20 真机）：服务商的图床（`file1/file2.aitohumanize.com`）在任务回报
 * SUCCESS 的瞬间文件还没落地，直接 GET 是 404，隔几秒才可读。旧实现一次失败就回落到
 * 远程 URL —— 节点显示「成功」但画面是一块黑，而那个临时链接几分钟后就彻底 404、
 * 图永远找不回来（画布里已出现三个这样的节点）。重试把这「几秒」等回来。
 */
const DOWNLOAD_RETRY_DELAYS_MS = [500, 1500, 4000];

/** 上游图床偶尔回一张 HTML（Cloudflare 拦截页 / 网关错误页），存成 .png 就是坏图。 */
function looksLikeMarkup(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 64).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<');
}

interface DownloadFailure {
  reason: string;
  /** 值得重试的失败（超时 / 断连 / 4xx / 5xx / 空文件 / 标记页）。超大文件不重试。 */
  retryable: boolean;
}

/**
 * 把一条远程结果下载成字节，失败按 `DOWNLOAD_RETRY_DELAYS_MS` 退避重试。
 *
 * 每次尝试都新建请求：图床的 404 常常是「文件还没写完」，换一个时刻就能拿到 200。
 * 全部失败时抛出最后一次的原因（带上尝试次数），由调用方决定回落策略。
 */
async function downloadResultBytes(
  url: string,
  fetcher: typeof fetch,
  onAttempt?: (attempt: number, failure: DownloadFailure) => void,
): Promise<Buffer> {
  let failure: DownloadFailure = { reason: '还没开始下载', retryable: true };
  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`下载结果失败 HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error('下载到空文件');
      if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error('结果文件超过大小上限');
      if (looksLikeMarkup(bytes)) throw new Error('下载到的不是媒体文件（像 HTML 拦截页）');
      return bytes;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failure = { reason, retryable: !reason.includes('超过大小上限') };
      onAttempt?.(attempt, failure);
      if (!failure.retryable) break;
      const delay = DOWNLOAD_RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) break;
      await new Promise((done) => setTimeout(done, delay));
    }
  }
  throw new Error(`${failure.reason}（尝试 ${DOWNLOAD_RETRY_DELAYS_MS.length + 1} 次）`);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface ResultRef {
  url?: string;
  base64?: string;
}

/**
 * 从任意形状的响应里挑出结果 URL / base64。
 * 覆盖：OpenAI（data[].url / b64_json）、Responses（output[].url）、各家 relay
 * （resultUrl / resultUrls / url / videos[] / audios[] / images[]）、
 * 以及魔搭/百炼那套**异步任务**的收尾形状（output_images / output_videos / outputs）、
 * 和 FisherAI（work-fisher）那套**两层 data**：`{code, data:{status, data:{content:{image_urls}}}}`
 * （`result_url` 兜底；`image_urls`/`audio_urls`/`urls` 都是裸字符串数组）。
 */
export function collectResultRefs(body: unknown): ResultRef[] {
  const refs: ResultRef[] = [];
  const pushUrl = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) refs.push({ url: value.trim() });
  };
  const pushBase64 = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) refs.push({ base64: value.trim() });
  };
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isObject(node)) return;
    pushUrl(node.resultUrl);
    pushUrl(node.result_url);
    if (Array.isArray(node.resultUrls)) node.resultUrls.forEach(pushUrl);
    pushUrl(node.url);
    pushBase64(node.b64_json);
    pushUrl(node.video_url);
    pushUrl(node.audio_url);
    pushUrl(node.image_url);
    pushUrl(node.grid_image_url);
    pushUrl(node.file_url);
    pushUrl(node.output_url);
    visitList(node, depth);
  };
  /**
   * 列字段：数组里既可能是对象（OpenAI 的 data[]），也可能是**裸 URL 字符串**
   * （魔搭异步任务收尾就是 `output_images: ["https://…png"]`，FisherAI 是
   * `data.data.content.image_urls`）。`content`/`metadata` 是后者的嵌套壳。
   *
   * `video_urls` / `video_url` 是视频那套的收尾字段（FisherAI 视频任务与图片同构：
   * `{code, data:{status, data:{content:{video_urls:[…]}}}}`，单数 `video_url` 兜底）。
   */
  function visitList(node: Record<string, unknown>, depth: number) {
    for (const key of [
      'data',
      'output',
      'outputs',
      'output_images',
      'output_video',
      'output_videos',
      'generated_images',
      'image_urls',
      'audio_urls',
      'video_urls',
      'video_url',
      'urls',
      'videos',
      'audios',
      'images',
      'artifacts',
      'results',
      'content',
      'metadata',
    ]) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') pushUrl(item);
          else visit(item, depth + 1);
        }
      } else if (isObject(value)) {
        visit(value, depth + 1);
      }
    }
  }
  visit(body, 0);
  // 去重（同一个 URL 可能既在 resultUrls 又在 data[] 里）
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = ref.url ?? `base64:${ref.base64!.slice(0, 64)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 从任意形状的响应里取文本结果。 */
export function extractText(body: unknown): string | null {
  if (!isObject(body)) return null;
  const direct = body.text ?? body.output_text ?? body.result;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const choices = body.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isObject(choice)) continue;
      const message = choice.message;
      if (isObject(message) && typeof message.content === 'string' && message.content.trim()) {
        return message.content;
      }
      if (typeof choice.text === 'string' && choice.text.trim()) return choice.text;
    }
  }
  const output = body.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (isObject(item) && typeof item.content === 'string' && item.content.trim()) return item.content;
      // Responses API：output[].content[] = [{ type: 'output_text', text }]
      if (isObject(item) && Array.isArray(item.content)) {
        for (const part of item.content as unknown[]) {
          if (isObject(part) && typeof part.text === 'string' && part.text.trim()) return part.text;
        }
      }
    }
  }
  return null;
}

/** 把用户的 prompt 包成 OpenAI chat 请求（只有当 body 里没有 messages 时才动手）。 */
export function toTextRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(body.messages)) return body;
  const prompt =
    (typeof body.prompt === 'string' && body.prompt) ||
    (typeof body.text === 'string' && body.text) ||
    '';
  const { prompt: _p, text: _t, kind: _k, ...rest } = body;
  return { ...rest, messages: [{ role: 'user', content: prompt }] };
}

export interface CloudGenerationDeps {
  /** 落盘生成结果（拿到远程 URL 或 base64 时用）；不传就原样返回远程 URL */
  mediaStore?: MediaStore;
  /** 注入 fetcher 便于测试 */
  fetcher?: typeof fetch;
}

export interface LocalizeContext {
  projectId: string;
  nodeId?: string;
  prompt?: string;
  model?: string;
  /** 落盘扩展名（如 '.jpg'）：调用方知道上游产出的真实格式时给出；缺省按 kind 的默认值 */
  extension?: string;
  /** 侧车元数据里的来源标记（默认 'cloud'） */
  provider?: string;
}

/** 下载远程结果并存进素材库；失败就原样返回远程 URL（不因为落盘失败把生成判失败）。 */
export async function localizeCloudResult(
  kind: Exclude<CloudKind, 'text'>,
  ref: ResultRef,
  context: LocalizeContext,
  deps: CloudGenerationDeps,
): Promise<string> {
  const mediaStore = deps.mediaStore;
  const fetcher = deps.fetcher ?? globalThis.fetch;
  const type = MEDIA_TYPE_OF[kind];
  if (!mediaStore) {
    if (ref.url) return ref.url;
    return `data:application/octet-stream;base64,${ref.base64}`;
  }
  const save = (bytes: Buffer, filename?: string) =>
    mediaStore
      .save({
        projectId: context.projectId,
        type,
        bytes,
        ...(filename ? { filename } : {}),
        extension: context.extension ?? EXTENSION_OF[kind],
        source: 'generation',
        ...(context.nodeId ? { nodeId: context.nodeId } : {}),
        ...(context.prompt ? { prompt: context.prompt } : {}),
        ...(context.model ? { model: context.model } : {}),
        extra: { provider: context.provider ?? 'cloud' },
      })
      .then((record) => record.url);

  try {
    if (ref.base64) {
      return await save(Buffer.from(ref.base64, 'base64'));
    }
    if (!ref.url) throw new Error('结果里既没有 url 也没有 base64');
    if (ref.url.startsWith('data:')) {
      const comma = ref.url.indexOf(',');
      if (comma < 0) throw new Error('data URL 形状不对');
      return await save(Buffer.from(ref.url.slice(comma + 1), 'base64'));
    }
    // 远程结果下载回本地：一是画布能当同源素材处理（缩略图/加工都认），
    // 二是中转站的临时 URL 过期后素材还在。图床「任务完成、文件还没落地」的那几秒靠重试兜。
    const bytes = await downloadResultBytes(ref.url, fetcher, (attempt, failure) => {
      if (failure.retryable) {
        console.warn(
          `[aifisher-canvas] 云端结果第 ${attempt} 次下载失败（${failure.reason}），重试：${ref.url}`,
        );
      }
    });
    return await save(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[aifisher-canvas] 云端结果落盘失败，回退为远程 URL：${reason}（${ref.url}）`);
    // 回落到远程 URL 意味着这个节点的图随时会「变黑」：把它记进 /diagnostics，
    // 让「节点成功但没图」不再只能靠猜（GET /api/aifisher/canvas/diagnostics 能读到）。
    pushDiagnostic({
      level: 'warn',
      message: '云端结果未能落盘，已回退为远程 URL（链接过期后节点会空图）',
      detail: {
        kind,
        url: ref.url ?? '(base64)',
        projectId: context.projectId,
        nodeId: context.nodeId ?? null,
        model: context.model ?? null,
        reason,
      },
    });
    return ref.url ?? '';
  }
}
