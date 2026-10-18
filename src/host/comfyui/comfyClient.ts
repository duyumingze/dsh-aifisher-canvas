/**
 * ComfyUI 客户端（host 半）
 *
 * 移植自 AIFISHER:
 *   server/comfyui/comfyClient.js         - HTTP 客户端（/prompt /history /view /upload）
 *   server/comfyui/comfyServerAddress.js - 地址配置
 *   server/local/comfyProcess.js          - 本地 ComfyUI 进程拉起（21.8KB，体量大，二期再搬）
 *
 * 第一版：只保留 HTTP 客户端，假设 ComfyUI 已经在本地跑着（127.0.0.1:8188）。
 * 用户可以自己启动 ComfyUI，或者用 --address 指向远程实例。
 * 本地进程自启（comfyProcess.js）作为二期目标。
 *
 * 关键 API（与原版一致）：
 *   POST /prompt            - 提交工作流
 *   GET  /history/<id>      - 查执行结果
 *   GET  /view?filename=.. - 取输出图
 *   POST /upload/image      - 上传输入图
 *   GET  /system_stats      - 健康检查
 *
 * 上传有两种入参（上游只有一个 `uploadImage(url)`，既吃 data:/本地路径也吃 http URL）：
 *   uploadImage(file, filename)   - 已经在内存里的字节（本插件第一版就有，调用点不能破）
 *   uploadImageUrl(url, [name])   - 远程 URL：host 先自己取字节，再走同一套 multipart 上传
 * 两者共用同一个 multipart 实现（上传 endpoint / 字段名 / overwrite 行为只有一份）。
 */
import { randomUUID } from 'node:crypto';

export interface ComfyClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 上传远程素材时「取字节」这一步的超时（默认 60s；与调 ComfyUI 的 timeoutMs 分开算）。 */
  uploadUrlTimeoutMs?: number;
  /** 上传远程素材时的字节上限（默认 64MB），超了直接中断，不把内存撑爆。 */
  uploadUrlMaxBytes?: number;
}

export interface QueuePromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

/** POST /upload/image 的返回：ComfyUI 把文件落在 input/<subfolder>/<name>。 */
export interface UploadedFile {
  name: string;
  subfolder: string;
  type: string;
}

/** 取远程素材的默认超时/上限（下载大视频时 30s 太紧，单独放宽一档）。 */
const DEFAULT_UPLOAD_URL_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_URL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 从 URL 的 path 推一个 ComfyUI 认的文件名。
 * - 取不到（URL 不合法 / path 没有文件名）就退回 upload.bin；
 * - 加一段随机前缀：上传带 overwrite=true，两张不同来源但同名的参考图（都叫 image.png）
 *   会互相覆盖，最后两个节点指向同一个文件（静默出错）。
 */
function filenameFromUrl(url: string): string {
  let base = 'upload.bin';
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    if (last && last !== '.' && last !== '..') base = last;
  } catch {
    // URL 不合法时用兜底名；真正的报错留给下载那一步（这里不吞语义）
  }
  // 文件名只留最后一段，顺手剔掉控制字符/路径分隔符，防目录穿越与非法文件名
  const safe = base.replace(/[\\/\u0000-\u001f]/g, '_').slice(-120);
  return `${randomUUID().slice(0, 8)}_${safe}`;
}

export function createComfyClient(options: ComfyClientOptions = {}) {
  const {
    baseUrl = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188',
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    uploadUrlTimeoutMs = DEFAULT_UPLOAD_URL_TIMEOUT_MS,
    uploadUrlMaxBytes = DEFAULT_UPLOAD_URL_MAX_BYTES,
  } = options;

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(new URL(path, baseUrl).href, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ComfyUI ${res.status}: ${text.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 原样发一个请求并还给调用方 Response（不解析 JSON）。
   * /interrupt、/queue 这类控制端点返回空体或非 JSON，用 call() 会炸在 res.json()。
   */
  async function callRaw(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(new URL(path, baseUrl).href, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ComfyUI ${res.status}: ${text.slice(0, 200)}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 唯一的 multipart 上传实现：两种入参都汇到这里。 */
  async function postUpload(bytes: Buffer, filename: string): Promise<UploadedFile> {    const form = new FormData();
    // @types/node 的 Buffer 是 Uint8Array<ArrayBufferLike>（联合里含 SharedArrayBuffer），
    // 而本程序里的 BlobPart 要求 ArrayBufferView<ArrayBuffer>，直接塞会报类型错。
    // 运行时上传用的 Buffer 一定是普通 ArrayBuffer 支撑的，这里做零拷贝视图 + 明确收窄，
    // 不复制一份字节、也不用 any。
    const view = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    form.append('image', new Blob([view]), filename);
    form.append('overwrite', 'true');
    return call<UploadedFile>('/upload/image', {
      method: 'POST',
      body: form,
    });
  }

  /**
   * 取远程素材的字节。
   * 为什么要 host 自己取：ComfyUI 的 /upload/image 只吃 multipart，不认 URL；
   * 上游 comfyClient.uploadImage(url) 也是这么做的（后端 fetch 完再上传）。
   */
  async function download(url: string): Promise<Buffer> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`素材 URL 不合法：${url.slice(0, 120)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`素材 URL 只支持 http/https，收到 ${parsed.protocol}（${url.slice(0, 120)}）`);
    }

    const tooLarge = () =>
      new Error(`素材超过 ${uploadUrlMaxBytes} 字节上限：${parsed.href.slice(0, 200)}`);

    let res: Response;
    try {
      res = await fetchImpl(parsed.href, { signal: AbortSignal.timeout(uploadUrlTimeoutMs) });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`取素材超时（${uploadUrlTimeoutMs}ms）：${parsed.href.slice(0, 200)}`);
      }
      throw error;
    }
    if (!res.ok) {
      throw new Error(`取素材失败 ${res.status}：${parsed.href.slice(0, 200)}`);
    }

    // 有 Content-Length 就先判一刀，省得白拉几十兆
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > uploadUrlMaxBytes) throw tooLarge();

    if (!res.body) {
      const whole = Buffer.from(await res.arrayBuffer());
      if (whole.byteLength > uploadUrlMaxBytes) throw tooLarge();
      return whole;
    }

    // 边读边数：没有 Content-Length（chunked）时也能在超限的那一刻掐断连接
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        if (size > uploadUrlMaxBytes) {
          await reader.cancel();
          throw tooLarge();
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (size === 0) throw new Error(`素材为空：${parsed.href.slice(0, 200)}`);
    return Buffer.concat(chunks);
  }

  /** 取输出图 URL（让前端直接 <img src> 用）。 */
  function buildViewUrl(params: { filename: string; subfolder?: string; type?: string }): string {
    const url = new URL('/view', baseUrl);
    url.searchParams.set('filename', params.filename);
    if (params.subfolder) url.searchParams.set('subfolder', params.subfolder);
    url.searchParams.set('type', params.type ?? 'output');
    return url.href;
  }

  return {
    /** ComfyUI 是否在线 */
    async ping(): Promise<boolean> {
      try {
        await call('/system_stats');
        return true;
      } catch {
        return false;
      }
    },

    /** 提交工作流（prompt 图），返回 prompt_id */
    async queuePrompt(workflow: Record<string, unknown>, clientId: string) {
      return call<QueuePromptResponse>('/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: workflow,
          client_id: clientId,
        }),
      });
    },

    /** 查某次执行的历史 */
    async getHistory(promptId: string) {
      return call<Record<string, unknown>>(`/history/${encodeURIComponent(promptId)}`);
    },

    /**
     * 本机装了什么节点与模型（提交前对账用）。
     * 不传 classType 就是整份清单（几 MB，按 TTL 缓存，别每次请求都拉）。
     */
    async objectInfo(classType?: string) {
      return call<Record<string, unknown>>(
        classType ? `/object_info/${encodeURIComponent(classType)}` : '/object_info',
      );
    },

    /** 取输出图 URL（让前端直接 <img src> 用） */
    viewUrl(params: { filename: string; subfolder?: string; type?: string }): string {
      return buildViewUrl(params);
    },

    /** 上传输入图（内存字节版）：filename 由调用方给，落盘位置就是 ComfyUI 返回的 name。 */
    async uploadImage(file: Buffer, filename: string): Promise<UploadedFile> {
      return postUpload(file, filename);
    },

    /**
     * 上传输入图（远程 URL 版）：先取字节，再走和 uploadImage 同一套 multipart 上传。
     * 组装工作流的参考素材就走这里（对应上游的 uploadImage(url) 调用）。
     */
    async uploadImageUrl(url: string, filename?: string): Promise<UploadedFile> {
      const bytes = await download(url);
      return postUpload(bytes, filename ?? filenameFromUrl(url));
    },

    /**
     * 下载一次执行产出（/view）。
     * URL 由 viewUrl() 自己拼 —— 调用方给不了任意地址，也就顺带满足了上游那条
     * 「结果地址必须来自本机 ComfyUI」的约束。
     */
    async downloadView(params: {
      filename: string;
      subfolder?: string;
      type?: string;
    }): Promise<{ bytes: Buffer; contentType: string | null }> {
      const res = await callRaw(buildViewUrl(params));
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, contentType: res.headers.get('content-type') };
    },

    /** 中断当前正在执行的任务（用户点「取消」）。 */
    async interrupt(): Promise<void> {
      await callRaw('/interrupt', { method: 'POST' });
    },

    /** 把还没开始执行的任务从队列里删掉。 */
    async deleteQueued(promptId: string): Promise<void> {
      await callRaw('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
      });
    },

    /** 原生 WebSocket 地址（用于实时进度） */
    wsUrl(clientId: string): string {
      const wsBase = baseUrl.replace(/^http/, 'ws');
      return `${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`;
    },
  };
}

export type ComfyClient = ReturnType<typeof createComfyClient>;
