/**
 * 画布本地后端路由（host 半）。
 *
 * 挂在 `/api/aifisher/canvas` 前缀下 —— 这个命名空间是刻意选的：
 *   - 收在插件自己的 /api/aifisher/* 里，不去抢 DSH 内核的 /api/*；
 *   - 又比 /api/aifisher/skills 更具体，不会盖掉它；
 *   - 与静态资源前缀 /api/aifisher/canvas-app 不冲突（后者不是 `canvas/`）。
 *
 * 上游前端（vendor/aifisher）里的 `/api/xxx` 字符串已在 vendor 阶段整体改写为
 * `/api/aifisher/canvas/xxx`，所以这里按同一套路径分发即可。
 *
 * 没实现的后端能力（生成、媒体处理、agent、本地 runtime…）统一返回 501 + 明确 code，
 * 让前端的失败分支拿到可读错误，而不是撞上 DSH 的 /api 鉴权层（那会返回 401）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { WebServerLike } from '../http/httpUtil';
import { readJsonBody, rejectCrossOrigin, sendJson } from '../http/httpUtil';
import { RevisionConflictError, type CanvasStore } from './store';
import { clearDiagnostics, pushDiagnostic, readDiagnostics } from './diagnostics';
import { handleMediaApi } from './mediaRouter';
import { handleMediaEditing, mediaEditingStatus } from './mediaEditingRouter';
import { handleLibraryApi } from './libraryRouter';
import { handleAppearanceApi, appearanceStatus } from './appearanceRouter';
import { handleMediaDownloadApi, mediaDownloadStatus } from './mediaDownloadRouter';
import { handleLocalRuntimeApi } from './localRuntimeRouter';
import { handlePromptApi, promptStatus } from './promptRouter';
import { handleProjectArchiveApi, projectArchiveStatus } from './projectArchiveRouter';
import { dataDirStatus } from './dataDir';
import { handleDataDirApi } from './dataDirRouter';
import { handleSourceSettingsApi, sourceSettingsStatus } from './sourceSettingsRouter';
import { handleCloudChannelsApi } from './cloudChannelsRouter';
import { handleTaskQueueApi, trackCloudTask } from './taskQueueRouter';
import type { GenerationEvents } from './generationEvents';
import type { GenerationPlans } from './generationPlans';
import { handleWorkflowCoversApi } from './workflowCoversRouter';
import { workflowCoversStatus } from '../comfyui/workflowCovers';
import type { GenerationJournal } from '../comfyui/generationJournal';
import { channelDiagnostics, readCloudChannels } from '../generation/cloudChannels';
import { handleAgentChatApi, type AgentChatDeps } from './agentChatRouter';
import type { ComfyClient } from '../comfyui/comfyClient';
import {
  CLOUD_REQUEST_LIMIT_BYTES,
  cloudGenerationStatus,
  cloudKindOfPath,
  handleCloudGeneration,
} from '../generation/cloudGenerationRouter';
import { arkImageStatus } from '../generation/arkImageProvider';
import type { MediaStore } from './mediaStore';
import type { ComfyDelegate } from '../comfyui/comfyRouter';

/** 前缀：client 半按这个前缀调用（vendor 源码里的 /api/ 就是改写成它）。 */
export const CANVAS_API_PREFIX = '/api/aifisher/canvas';

/** agent 外部控制通道：/api/aifisher/canvas/agent/external/*（对应上游 canvasExternalClient）。 */
export interface CanvasBridgeLike {
  /** 处理 agent/external 下的子路径；已处理返回 true。 */
  handle(
    subPath: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean>;
  /** 诊断信息。 */
  status(): Record<string, unknown>;
}

/** 本路由的附加依赖：素材库、媒体加工、ComfyUI 转发（都可能缺省 —— 缺省即回落 NOT_PORTED）。 */
export interface CanvasApiExtras {
  mediaStore?: MediaStore;
  comfy?: ComfyDelegate;
  /** 原始 ComfyUI 客户端（「设置 → 开源服务」的本机状态查询用）。 */
  comfyClient?: ComfyClient;
  /** ComfyUI 服务地址（显示与「打开网页端」用）。 */
  comfyBaseUrl?: string;
  /**
   * 画布右侧对话面板的依赖（v1.9）：对话存档 + DSH 会话大脑。
   * 缺省时 /agent/workspace 与 /chat/* 会回 503（面板会显示「DSH 会话服务不可用」）。
   */
  chat?: AgentChatDeps | null;
  /**
   * 生成任务日记（v1.24）：本地 ComfyUI 与云端两条链路都往里写，
   * `/tasks` 接口把它列成画布右侧「任务队列」面板。缺省时该面板显示「不可用」。
   */
  tasks?: GenerationJournal;
  /**
   * 生成事件总线（v1.57）：journal 的事件 → 批次 → 画布对话面板。
   * `/events` 是它的只读回看接口（诊断 / 将来的界面增量拉取用）。
   */
  events?: GenerationEvents;
  /**
   * 生成批次记录（v1.57）：画布 prepareGeneration 落库要它，`/status` 里也报一份计数。
   */
  plans?: GenerationPlans;
}

function segment(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

/** 上游没实现的后端能力：明确告知「未移植」，而不是假装 404。 */
function notPorted(res: ServerResponse, pathname: string): void {
  sendJson(res, 501, {
    error: `该画布后端能力尚未移植到 DSH：${pathname}`,
    code: 'NOT_PORTED',
    path: pathname,
  });
}

export async function handleCanvasApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: CanvasStore,
  bridge: CanvasBridgeLike | null,
  extras: CanvasApiExtras = {},
): Promise<void> {
  // 同源围栏：本路由是裸挂 webServer 的（没有 DSH 的 cookie + Host/Origin 鉴权），
  // 且 readJsonBody 不看 content-type，跨站页面用 text/plain 简单请求就能绕过预检写数据。
  if (rejectCrossOrigin(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://x');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const rest = pathname.slice(CANVAS_API_PREFIX.length);
  const parts = segment(rest);

  // ---- agent 外部控制通道（画布 -> 后端的长轮询） ----
  if (parts[0] === 'agent' && parts[1] === 'external') {
    if (bridge) {
      const sub = `/${parts.slice(2).join('/')}`;
      if (await bridge.handle(sub, method, req, res)) return;
    }
    sendJson(res, 503, { error: '画布控制通道不可用。', code: 'BRIDGE_UNAVAILABLE' });
    return;
  }

  // ---- 诊断：库状态（我自己排查用，也给 UI 显示） ----
  if (parts[0] === 'status' && parts.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      store: { path: store.filePath, ...store.stats() },
      bridge: bridge?.status() ?? null,
      // 媒体加工是否可用（本机有没有 ffmpeg 是排查抽帧/裁剪 503 的第一现场）
      media: extras.mediaStore ? { ...extras.mediaStore.stats(), ...mediaEditingStatus() } : null,
      // 云端模型生成是否配好（不回显密钥）：画布上的云端模型节点报「未配置」时先看这里
      cloud: await cloudGenerationStatus(dirname(store.filePath)),
      // 火山方舟（豆包）直连：图片模型的 API Key / 端点 / 目录里的模型 ID
      ark: arkImageStatus(),
      // 画布外观背景图 / 媒体下载 / 闭源服务 / 提示词（v1.1 补的四块）
      appearance: await appearanceStatus(dirname(store.filePath)),
      downloads: await mediaDownloadStatus(dirname(store.filePath)),
      sources: await sourceSettingsStatus(dirname(store.filePath)),
      // 自配 OpenAI 通道（v1.11）：几条通道、各几条模型、配没配密钥（不回密钥）
      cloudChannels: channelDiagnostics(await readCloudChannels(dirname(store.filePath))),
      prompts: await promptStatus(dirname(store.filePath)),
      archive: projectArchiveStatus(),
      // 项目数据目录（v1.43）：当前在用 / 重启后会用的那个 / 是否等重启
      dataDir: dataDirStatus(dirname(store.filePath)),
      // 画布右侧对话面板（v1.9）：DSH 会话服务是否可用、有几条活跃回合
      chat: extras.chat
        ? { ...(extras.chat.chat?.status() ?? {}), store: extras.chat.store.stats() }
        : null,
      // 生成任务队列（v1.24）：「面板上是空的 / 刷新后任务没了」先看这里
      tasks: extras.tasks ? extras.tasks.stats() : null,
      // 生成事件（v1.57）：seq 一直在涨但没人收到推送时，先看这里（openBatches / bindings）
      events: extras.events ? extras.events.stats() : null,
      // 生成批次记录（v1.57）：prepareGeneration 的落库与状态（pending 一直不动 = 用户还没确认）
      plans: extras.plans ? extras.plans.stats() : null,
      // 工作流配图（v1.28）：左侧「工作流节点」面板里每张卡片的封面图
      workflowCovers: workflowCoversStatus(),
    });
    return;
  }

  // ---- 诊断：画布运行时错误回传（client 半上报，agent 读取） ----
  if (parts[0] === 'diagnostics') {
    if (method === 'GET') {
      const raw = Number(url.searchParams.get('limit') ?? 50);
      sendJson(res, 200, { entries: readDiagnostics(Number.isFinite(raw) ? raw : 50) });
      return;
    }
    if (method === 'DELETE') {
      clearDiagnostics();
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req, 256 * 1024)) as {
        level?: unknown;
        message?: unknown;
        detail?: unknown;
        url?: unknown;
      } | null;
      if (!body || typeof body.message !== 'string') {
        sendJson(res, 422, { error: '诊断数据无效。', code: 'INVALID' });
        return;
      }
      const level = body.level === 'warn' || body.level === 'info' ? body.level : 'error';
      const record = pushDiagnostic({
        level,
        message: body.message,
        detail: { ...(body.detail as object | undefined), url: body.url },
      });
      // 同时打到 host 日志，便于在 DSH 控制台直接看到
      console.error(`[aifisher-canvas][client] ${record.message}`);
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // ---- 生成任务队列（v1.24，画布右侧那块面板）----
  // 数据源是生成任务日记（本地 ComfyUI + 云端两条链路都写它），见 canvas/taskQueueRouter.ts。
  // 日记没接上（老装配 / 单测里没给）时明确回 503，面板会显示「任务队列不可用」。
  if (parts[0] === 'tasks') {
    if (!extras.tasks) {
      sendJson(res, 503, { error: '生成任务日记未就绪。', code: 'TASKS_UNAVAILABLE' });
      return;
    }
    if (await handleTaskQueueApi({ req, res, url, parts, deps: { journal: extras.tasks } })) return;
  }

  // ---- 生成事件（v1.57）：journal → 批次 → 画布对话面板 ----
  // 推送本身走 DSH 会话（sessionController.prompt），这里只给只读回看：
  //   GET /events?since=<seq>&limit=50  增量拉取（旧的在前）
  //   GET /events?recent=20&hint=1      最近 N 条（新的在前）
  // 没有消费者也能用：真机排查时先看它，再对 /status 里的 events 计数。
  if (parts[0] === 'events' && parts.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!extras.events) {
      sendJson(res, 503, { error: '生成事件总线未就绪。', code: 'EVENTS_UNAVAILABLE' });
      return;
    }
    const rawSince = url.searchParams.get('since');
    const rawLimit = Number(url.searchParams.get('limit') ?? 50);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
    if (url.searchParams.get('recent') !== null) {
      const rawRecent = Number(url.searchParams.get('recent') ?? 20);
      const recent = extras.events.recent(Number.isFinite(rawRecent) ? rawRecent : 20);
      sendJson(res, 200, { ok: true, seq: extras.events.stats().seq, events: recent, stats: extras.events.stats() });
      return;
    }
    const page = extras.events.since(
      rawSince === null || rawSince === '' ? undefined : Number(rawSince),
      limit,
    );
    sendJson(res, 200, {
      ok: true,
      seq: page.seq,
      events: page.events,
      stats: extras.events.stats(),
      hint:
        '生成事件按批次成组推送到发起 canvas_control 的 DSH 会话（画布对话面板）；' +
        '这里只是只读回看，approve 仍然只在画布 UI。',
    });
    return;
  }

  // ---- 工作流配图（v1.28，左侧「工作流节点」面板里每张卡片的封面）----
  // 数据面在 comfyui/workflowCovers.ts（索引 + 图片本体都落在画布数据目录，不写用户的工作流目录）。
  if (parts[0] === 'workflow-covers') {
    try {
      if (
        await handleWorkflowCoversApi({
          req,
          res,
          url,
          parts,
          deps: { dataDir: dirname(store.filePath) },
        })
      )
        return;
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : '工作流配图处理失败',
          code: 'COVER_ROUTE_FAILED',
        });
      }
      return;
    }
  }

  // ---- 偏好设置 ----
  if (parts[0] === 'preferences' && parts.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, store.preferences());
      return;
    }
    if (method === 'PATCH' || method === 'POST') {
      const body = (await readJsonBody(req, 512 * 1024)) as Record<string, unknown> | null;
      if (!body) {
        sendJson(res, 422, { error: '偏好数据无效。', code: 'INVALID' });
        return;
      }
      await store.patchPreferences(body);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // ---- 文件夹 ----
  if (parts[0] === 'folders') {
    if (parts.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, store.listFolders());
        return;
      }
      if (method === 'POST') {
        const body = (await readJsonBody(req, 512 * 1024)) as Record<string, unknown> | null;
        if (!body) {
          sendJson(res, 422, { error: '文件夹数据无效。', code: 'INVALID' });
          return;
        }
        // 带 id 的 POST 是「重命名/更新」，不带的才是「新建」
        if (typeof body.id === 'string' && body.id) {
          const updated = await store.renameFolder(body as never);
          if (!updated) {
            sendJson(res, 404, { error: '文件夹不存在。', code: 'NOT_FOUND' });
            return;
          }
          sendJson(res, 200, updated);
          return;
        }
        const folder = await store.createFolder(
          typeof body.name === 'string' ? body.name : '',
          typeof body.parentId === 'string' ? body.parentId : null,
        );
        sendJson(res, 200, folder);
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (parts.length === 2 && method === 'DELETE') {
      const ok = await store.deleteFolder(parts[1]);
      if (!ok) {
        sendJson(res, 404, { error: '文件夹不存在。', code: 'NOT_FOUND' });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }
    notPorted(res, pathname);
    return;
  }

  // ---- 项目（上游叫 workflow） ----
  if (parts[0] === 'workflows') {
    // GET /workflows —— dashboard 列表
    if (parts.length === 1 && method === 'GET') {
      sendJson(res, 200, store.listDocuments());
      return;
    }
    // POST /workflows —— 保存（整份文档）
    if (parts.length === 1 && method === 'POST') {
      const body = (await readJsonBody(req, 32 * 1024 * 1024)) as Record<string, unknown> | null;
      if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.groups)) {
        sendJson(res, 422, { error: '项目数据格式无效。', code: 'INVALID' });
        return;
      }
      try {
        const result = await store.saveDocument(body);
        sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          sendJson(res, 409, {
            error: error.message,
            code: 'REVISION_CONFLICT',
            revision: error.currentRevision,
          });
          return;
        }
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : '保存失败。',
          code: 'SAVE_FAILED',
        });
      }
      return;
    }
    // POST /workflows/restore + GET /workflows/:id/backup —— 项目备份/恢复（v1.1 补）
    if (extras.mediaStore) {
      const archiveDeps = {
        store,
        mediaStore: extras.mediaStore,
        dataDir: dirname(store.filePath),
      };
      if (await handleProjectArchiveApi({ req, res, parts, deps: archiveDeps })) return;
    }
    if (parts.length >= 2) {
      const id = parts[1];
      // GET /workflows/:id
      if (parts.length === 2 && method === 'GET') {
        const doc = store.getDocument(id);
        if (!doc) {
          sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
          return;
        }
        sendJson(res, 200, doc);
        return;
      }
      // DELETE /workflows/:id
      if (parts.length === 2 && method === 'DELETE') {
        const ok = await store.deleteDocument(id);
        if (!ok) {
          sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }
      // PUT /workflows/:id/rename
      if (parts.length === 3 && parts[2] === 'rename' && method === 'PUT') {
        const body = (await readJsonBody(req)) as { title?: unknown } | null;
        if (!body || typeof body.title !== 'string') {
          sendJson(res, 422, { error: '标题无效。', code: 'INVALID' });
          return;
        }
        const updated = await store.renameDocument(id, body.title);
        if (!updated) {
          sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
          return;
        }
        sendJson(res, 200, updated);
        return;
      }
      // PUT /workflows/:id/move
      if (parts.length === 3 && parts[2] === 'move' && method === 'PUT') {
        const body = (await readJsonBody(req)) as { folderId?: unknown } | null;
        const folderId = typeof body?.folderId === 'string' ? body.folderId : null;
        const updated = await store.moveDocument(id, folderId);
        if (!updated) {
          sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
          return;
        }
        sendJson(res, 200, updated);
        return;
      }
      // POST /workflows/:id/cleanup
      if (parts.length === 3 && parts[2] === 'cleanup' && method === 'POST') {
        const body = (await readJsonBody(req)) as { preview?: unknown } | null;
        sendJson(res, 200, store.cleanup(id, body?.preview === true));
        return;
      }
      // PUT /workflows/:id —— 上游用 POST /workflows 保存，这里兼容一下直传
      if (parts.length === 2 && (method === 'PUT' || method === 'PATCH')) {
        const body = (await readJsonBody(req, 32 * 1024 * 1024)) as Record<string, unknown> | null;
        if (!body) {
          sendJson(res, 422, { error: '项目数据格式无效。', code: 'INVALID' });
          return;
        }
        try {
          sendJson(res, 200, await store.saveDocument({ ...body, id }));
        } catch (error) {
          if (error instanceof RevisionConflictError) {
            sendJson(res, 409, {
              error: error.message,
              code: 'REVISION_CONFLICT',
              revision: error.currentRevision,
            });
            return;
          }
          sendJson(res, 500, { error: '保存失败。', code: 'SAVE_FAILED' });
        }
        return;
      }
    }
    notPorted(res, pathname);
    return;
  }

  // ---- 本地工作流（ComfyUI）----
  // 画布前端调的是 `/api/aifisher/canvas/comfy/<工作流>`（vendor 把上游 /api/comfy 整体改写过），
  // 结果回收则调画布前缀下的 `/generation-status|generation-cancel/:nodeId`。
  // 两者都交给同一份 ComfyUI 路由（comfyui/comfyRouter.ts 的 createComfyDelegate），逻辑不复制。
  if (parts[0] === 'comfy' || parts[0] === 'generation-status' || parts[0] === 'generation-cancel') {
    try {
      if (extras.comfy && (await extras.comfy.handle(req, res, `/${parts.join('/')}`))) return;
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : '本地工作流处理失败',
        code: 'COMFY_ROUTE_FAILED',
      });
      return;
    }
    notPorted(res, pathname);
    return;
  }

  // ---- 生成并发查询 ----
  // 画布提交前会问一次「这个模型还能不能并发」；本地 ComfyUI 自己在服务端排队，这里恒不阻塞。
  if (parts[0] === 'generation-concurrency' && parts.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    sendJson(res, 200, {
      blocked: false,
      inFlight: 0,
      maxConcurrent: 0,
      modelName: url.searchParams.get('modelName') ?? '',
    });
    return;
  }

  // ---- 云端模型生成（/generate-image|video|audio|text）----
  // 画布上的「云端模型」节点走这里，host 按模型名分发：
  //   ① 用户自配的 OpenAI 通道（多通道，见 generation/cloudChannels.ts）
  //   ② 火山方舟（豆包）直连
  // 两条都对不上时回 501 CLOUD_NOT_CONFIGURED —— 比笼统的 NOT_PORTED 更能说明「该配什么」。
  // （v1.4–v1.12 的第三条「旧版单端点 AIFISHER_CLOUD_BASE_URL」已在 v1.13 移除。）
  {
    const cloudKind = cloudKindOfPath(pathname);
    if (cloudKind) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const body = (await readJsonBody(req, CLOUD_REQUEST_LIMIT_BYTES)) as Record<string, unknown> | null;
      // v1.24：云端生成也要出现在画布右侧的任务队列面板里（面板是「一处看全」，
      // 不区分本地/云端）。日记在响应收尾时按状态码写成功/失败，云端任务没有取消钩子。
      const settle = extras.tasks
        ? trackCloudTask({ journal: extras.tasks, kind: cloudKind, body, res })
        : null;
      try {
        await handleCloudGeneration(cloudKind, body, res, {
          ...(extras.mediaStore ? { mediaStore: extras.mediaStore } : {}),
          // 自配通道表在画布数据目录里（store.filePath 的同级）
          dataDir: dirname(store.filePath),
        });
      } finally {
        settle?.();
      }
      return;
    }
  }

  // ---- 画布外观（背景图）/ 闭源服务设置 / 提示词 / 本机运行环境 / 媒体下载 ----
  // 这几块是 v1.1 补的：上游画布一直在调，但 host 半原先没有对应实现，表现是
  // 「设置」对话框六个分区里有四个打开即报错、画布上所有「下载」按钮弹「下载失败」。
  //
  // 整块套一层 try/catch：这些处理函数会去 spawn 外部命令（nvidia-smi）、读文件、发 HTTP，
  // 一旦有异常冒出来就会变成「路由 handler 返回的 Promise 被拒绝」——在 Node 里那是未捕获的
  // Promise 拒绝，足以把 DSH 宿主进程带走（画布还在用，人先下线了）。宁可回 500 + code。
  try {
    const dataDir = dirname(store.filePath);
    // 项目数据目录（v1.43）：设置 → 存储 里改「缓存目录」走这三条
    if (await handleDataDirApi({ req, res, parts, activeDir: dataDir })) return;
    if (await handleAppearanceApi({ req, res, url, parts, deps: { dataDir } })) return;
    if (await handleSourceSettingsApi({ req, res, url, parts, deps: { dataDir } })) return;
    // 自配 OpenAI 通道（v1.11）：多通道 CRUD + 读端点模型清单（供界面多选）
    if (await handleCloudChannelsApi({ req, res, parts, deps: { dataDir } })) return;
    if (
      await handlePromptApi({
        req,
        res,
        url,
        parts,
        deps: { dataDir, ...(extras.mediaStore ? { mediaStore: extras.mediaStore } : {}) },
      })
    )
      return;
    if (extras.comfyClient && extras.comfyBaseUrl) {
      if (
        await handleLocalRuntimeApi({
          req,
          res,
          url,
          parts,
          deps: { comfy: extras.comfyClient, baseUrl: extras.comfyBaseUrl },
        })
      )
        return;
    }
    if (extras.mediaStore) {
      if (
        await handleMediaDownloadApi({
          req,
          res,
          url,
          parts,
          deps: { mediaStore: extras.mediaStore, dataDir },
        })
      )
        return;
    }
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : '本机服务处理失败',
        code: 'SERVICE_ROUTE_FAILED',
      });
    }
    return;
  }

  // ---- 媒体：资产库/本地预设 + 加工（抽帧/裁剪/裁切/网格/缩略图）+ 素材库（上传/列表/删除/取回/代理）----
  // 顺序有意：资产库路由要先拿到 `/library*`（它靠 mediaStore 落盘，缺 mediaStore 时整体回落 NOT_PORTED）。
  if (extras.mediaStore) {
    const deps = { mediaStore: extras.mediaStore };
    try {
      if (await handleLibraryApi({ req, res, url, parts, deps })) return;
      if (await handleMediaEditing({ req, res, url, parts, deps })) return;
      if (await handleMediaApi({ req, res, url, parts, deps })) return;
    } catch (error) {
      // 媒体链路里任何意外都不能把异常抛出路由（那会变成连接被掐断，前端只看到网络错误）
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : '媒体处理失败',
        code: 'MEDIA_FAILED',
      });
      return;
    }
  }

  // ---- 画布右侧对话面板（v1.9）：助手草稿 / 模型清单 / 对话历史 / 流式回合 ----
  // 放在最后一步之前：它自己只管 /agent/workspace、/agent/codex/*、/chat/*，
  // 其余路径原样返回 false 继续往下走。
  if (extras.chat) {
    try {
      if (await handleAgentChatApi({ req, res, url, parts, deps: extras.chat })) return;
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : '画布对话处理失败',
          code: 'CHAT_ROUTE_FAILED',
        });
      }
      return;
    }
  }

  notPorted(res, pathname);
}

/** 把画布本地后端挂到 DSH webServer 上。返回 disposer。 */
export function attachCanvasApi(
  webServer: WebServerLike,
  store: CanvasStore,
  bridge: CanvasBridgeLike | null,
  extras: CanvasApiExtras = {},
): () => void {
  return webServer.register({
    kind: 'prefix',
    path: CANVAS_API_PREFIX,
    handler: (req, res) => handleCanvasApi(req, res, store, bridge, extras),
  });
}
