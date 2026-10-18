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
    // 二是中转站的临时 URL 过期后素材还在。
    const response = await fetcher(ref.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`下载结果失败 HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error('结果文件超过大小上限');
    return await save(bytes);
  } catch (error) {
    console.warn(
      `[aifisher-canvas] 云端结果落盘失败，回退为远程 URL：${error instanceof Error ? error.message : String(error)}`,
    );
    return ref.url ?? '';
  }
}
