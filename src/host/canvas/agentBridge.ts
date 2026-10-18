/**
 * 画布 agent 控制通道（host 半）。
 *
 * 为什么要复用 AIFISHER 的「外部连接」协议：
 *   上游已经有一套完整的「agent ↔ 打开的画布」通道：画布侧的 canvasExternalClient
 *   长轮询后端、把 CanvasActionRequest 交给画布内部的 controlExecutor 执行、再回执结果。
 *   我们只要在 DSH host 上实现**同一套 HTTP 契约**，画布侧代码（vendor 副本）一行不用改，
 *   canvas_control 工具也就自动拿到了 read/edit/undo/focus 乃至 projects/assets/models
 *   这些已经实现好的动作。
 *
 * 端点（上游客户端 canvasExternalClient.ts 的写法，已在 vendor 阶段改写到我们的命名空间）：
 *   POST /api/aifisher/canvas/agent/external/list      → 授权列表（本地单人版恒为空）
 *   POST .../poll                                      → 长轮询取指令（最长 25s，空则 []）
 *   POST .../claim   {requestId}                       → 租约（本地版直接给 {external:false}）
 *   POST .../finish  {requestId}                       → 释放租约（空操作）
 *   POST .../complete{requestId,result}                → 回执结果（唤醒等结果的工具调用）
 *   POST .../heartbeat                                 → 保活
 *   POST .../activate /pair /revoke /release           → 兼容上游 UI 的配对流程（本地版是空操作）
 *
 * 配对模型：DSH 里没有「页面注册表」，所以按 sessionId/最近活跃来定位页面 ——
 * 画布每次 poll 都带 clientId + projectId，bridge 记住「当前有画布在轮询」以及它打开的项目；
 * 工具调用优先按 exec 的 session id 命中，命中不到就用最近活跃的那个，都没有就报 NO_OPEN_CANVAS。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readJsonBody, sendJson } from '../http/httpUtil';

/** 一条待执行指令（与 vendor 侧 CanvasActionRequest 同形，command 由调用方给全）。 */
export interface CanvasActionRequest {
  requestId: string;
  projectId: string;
  sessionId: string;
  command: Record<string, unknown>;
  expiresAt: number;
}

/** 画布侧返回的结果（结构由 canvasControlProtocol 的 CanvasResult 定义）。 */
export type CanvasActionResult = Record<string, unknown>;

interface ClientEntry {
  clientId: string;
  projectId: string;
  lastSeen: number;
}

interface Waiter {
  resolve: (requests: CanvasActionRequest[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingResult {
  resolve: (result: CanvasActionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CanvasBridgeOptions {
  /** 长轮询挂起时长（上游客户端超时 25s，这里略短一点，保证总有响应） */
  pollTimeoutMs?: number;
  /** 工具等待画布回执的默认超时 */
  requestTimeoutMs?: number;
}

export interface CanvasBridge {
  handle(
    subPath: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean>;
  /** 让画布执行一条指令并等回执。 */
  request(
    command: Record<string, unknown>,
    options?: { sessionId?: string; timeoutMs?: number },
  ): Promise<CanvasActionResult>;
  status(): Record<string, unknown>;
}

/** 没有画布在轮询时抛这个，工具据此给出人类可读的提示。 */
export class CanvasNotOpenError extends Error {
  readonly code = 'NO_OPEN_CANVAS';
  constructor(message = '画布没有打开，或没有打开任何项目。') {
    super(message);
  }
}

/** 画布迟迟不回执。 */
export class CanvasTimeoutError extends Error {
  readonly code = 'CANVAS_TIMEOUT';
  constructor(message = '画布在超时时间内没有回执。') {
    super(message);
  }
}

export function createCanvasBridge(options: CanvasBridgeOptions = {}): CanvasBridge {
  const pollTimeoutMs = options.pollTimeoutMs ?? 20_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  /** clientId → 最近一次 poll 的信息 */
  const clients = new Map<string, ClientEntry>();
  /** 最近一次 poll 过的 clientId（用于「只有一块画布」时的兜底命中） */
  let lastClientId: string | null = null;
  /** 正在挂起的长轮询 */
  let waiter: Waiter | null = null;
  /** 待取走的指令 */
  const queue: CanvasActionRequest[] = [];
  /** 等回执的工具调用 */
  const pending = new Map<string, PendingResult>();

  /**
   * 选一个「当前在轮询的画布」。
   *
   * 局限（有意为之）：DSH 的页面注册表在客户端，host 看不到「哪个页面属于哪个会话」，
   * 而画布侧的长轮询只带 clientId/projectId。所以这里用「最近一次 poll 的 client」
   * 作为命中目标 —— 单机单人、画布面板只开一个的前景下足够准；
   * 若将来要支持多窗口，就让画布在 poll 里带上 sessionId（改 client 半那几行）。
   */
  function activeClient(): ClientEntry | null {
    if (lastClientId) {
      const preferred = clients.get(lastClientId);
      if (preferred) return preferred;
    }
    const first = clients.values().next();
    return first.done ? null : first.value;
  }

  function flushQueue(): void {
    if (!waiter || queue.length === 0) return;
    const current = waiter;
    waiter = null;
    clearTimeout(current.timer);
    current.resolve(queue.splice(0, queue.length));
  }

  function holdPoll(clientId: string, projectId: string): Promise<CanvasActionRequest[]> {
    // 同一时刻只保留一个挂起的长轮询：新的 poll 到达说明旧的已经断了
    if (waiter) {
      const previous = waiter;
      waiter = null;
      clearTimeout(previous.timer);
      previous.resolve([]);
    }
    void clientId;
    void projectId;
    return new Promise<CanvasActionRequest[]>((resolve) => {
      const timer = setTimeout(() => {
        waiter = null;
        resolve([]);
      }, pollTimeoutMs);
      waiter = { resolve, timer };
    });
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const body = await readJsonBody(req, 1024 * 1024);
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  }

  function touch(body: Record<string, unknown>): { clientId: string; projectId: string } {
    const clientId = typeof body.clientId === 'string' ? body.clientId : 'anonymous';
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    clients.set(clientId, { clientId, projectId, lastSeen: Date.now() });
    lastClientId = clientId;
    // 只保留最近活跃的若干连接，避免长期运行后无限增长
    if (clients.size > 16) {
      const sorted = [...clients.values()].sort((a, b) => a.lastSeen - b.lastSeen);
      for (const entry of sorted.slice(0, clients.size - 16)) clients.delete(entry.clientId);
    }
    return { clientId, projectId };
  }

  return {
    async handle(subPath, method, req, res) {
      if (method !== 'POST') {
        // 上游客户端全部用 POST（含 list/refresh）
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      const body = await readBody(req);

      switch (subPath) {
        case '/list': {
          touch(body);
          // 本地单人版没有「授权/配对」概念：列表恒空，画布 UI 会显示未配对但不报错
          sendJson(res, 200, []);
          return true;
        }
        case '/heartbeat': {
          touch(body);
          sendJson(res, 200, { ok: true });
          return true;
        }
        case '/poll': {
          const { clientId, projectId } = touch(body);
          if (queue.length > 0) {
            sendJson(res, 200, queue.splice(0, queue.length));
            return true;
          }
          const requests = await holdPoll(clientId, projectId);
          sendJson(res, 200, requests);
          return true;
        }
        case '/claim': {
          touch(body);
          // external:false → 画布侧会在执行完后自己 finish（本地版没有外部租约）
          sendJson(res, 200, { external: false });
          return true;
        }
        case '/finish': {
          touch(body);
          sendJson(res, 200, { ok: true });
          return true;
        }
        case '/complete': {
          touch(body);
          const requestId = typeof body.requestId === 'string' ? body.requestId : '';
          const result = (body.result ?? {}) as CanvasActionResult;
          const pendingResult = requestId ? pending.get(requestId) : undefined;
          if (pendingResult && requestId) {
            pending.delete(requestId);
            clearTimeout(pendingResult.timer);
            pendingResult.resolve(result);
          }
          sendJson(res, 200, { ok: true });
          return true;
        }
        case '/activate':
        case '/pair': {
          touch(body);
          // 画布 UI 的配对面板需要这几个字段，本地版给一份「无需配对」的答复
          sendJson(res, 200, {
            command: '',
            codexCommand: '',
            desktopCommand: '',
            expiresAt: 0,
          });
          return true;
        }
        case '/revoke':
        case '/release': {
          const clientId = typeof body.clientId === 'string' ? body.clientId : '';
          if (clientId) clients.delete(clientId);
          if (lastClientId === clientId) lastClientId = null;
          sendJson(res, 200, { ok: true });
          return true;
        }
        default: {
          sendJson(res, 404, { error: `unknown external endpoint: ${subPath}` });
          return true;
        }
      }
    },

    request(command, requestOptions = {}) {
      const client = activeClient();
      if (!client) throw new CanvasNotOpenError();
      if (!client.projectId) {
        throw new CanvasNotOpenError('画布已打开，但还没有进入任何项目 —— 请先在画布里新建或打开一个项目。');
      }
      const timeoutMs = requestOptions.timeoutMs ?? requestTimeoutMs;
      const request: CanvasActionRequest = {
        requestId: randomUUID(),
        projectId: client.projectId,
        sessionId: requestOptions.sessionId ?? 'dsh',
        command,
        expiresAt: Date.now() + timeoutMs,
      };
      const done = new Promise<CanvasActionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.requestId);
          reject(new CanvasTimeoutError());
        }, timeoutMs);
        pending.set(request.requestId, { resolve, reject, timer });
      });
      queue.push(request);
      flushQueue();
      return done;
    },

    status() {
      const now = Date.now();
      return {
        clients: [...clients.values()].map((entry) => ({
          clientId: entry.clientId,
          projectId: entry.projectId,
          lastSeen: entry.lastSeen,
          idleMs: now - entry.lastSeen,
        })),
        queued: queue.length,
        pendingRequests: pending.size,
        polling: waiter !== null,
      };
    },
  };
}
