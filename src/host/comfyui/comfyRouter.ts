/**
 * ComfyUI 路由（host 半，挂到 DSH webServer）
 *
 * 给前端画布节点调用的代理层。
 * DSH webServer 不是 Express，这里用一个 prefix 路由 '/api/comfy'，
 * handler 内部按 pathname + method 分发。
 *
 *   - GET  /api/comfy/ping
 *   - GET  /api/comfy/workflows            ← 从 workflowRegistry 读真注册表（含用户目录里的自定义工作流）
 *   - GET  /api/comfy/workflow/:type      ← 取某工作流的 API 模板 JSON
 *   - GET  /api/comfy/capabilities?outputType=videos
 *                                         ← 能力清单（画布前端走 /api/aifisher/canvas/comfy/capabilities，
 *                                            两处共用本文件的 sendComfyCapabilities）
 *   - GET  /api/comfy/custom-workflows    ← 自定义工作流目录诊断（读到了几个、哪些 JSON 坏了）
 *   - GET  /api/comfy/widget-options      ← ComfyUI 字段候选值快照（v1.20：lora/模型下拉的列表来源）
 *   - POST /api/comfy/prepare/:type       ← 按参数动态组装工作流，返回 prompt 图（不排队、不执行）
 *                                            ?reconcile=1 时顺带做一次提交前对账（默认关）
 *   - POST /api/comfy/:workflowType       ← **统一本地工作流入口**（上游 legacyComfyGenerationRouter）：
 *                                            组装 → 排队 → 等结果 → 落素材库 → { success, url, asset }
 *                                            画布「ComfyUI 节点 → 生成」走的就是这条
 *   - POST /api/comfy/run
 *   - GET  /api/comfy/history/:id
 *   - GET  /api/comfy/generation-status/:nodeId  ← 结果回收（画布 useVideoResults 轮询它）
 *   - POST /api/comfy/generation-cancel/:nodeId
 *
 * :workflowType 有两类：
 *   1) 内置（WORKFLOW_HANDLERS 里写死的，例如 minimax-h3-t2va）；
 *   2) 自定义（用户把 ComfyUI 的 Export (API) JSON 放进
 *      $DSH_HOME/storages/dsh-aifisher-canvas/workflows/，见 customWorkflows.ts）——
 *      查不到内置 handler 时回落到通用 handler，所以新增自定义工作流**不需要改这里**。
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComfyClient } from './comfyClient';
import type { WebServerLike } from '../http/httpUtil';
import { readJsonBody, rejectCrossOrigin, sendJson } from '../http/httpUtil';
import {
  ComfyWorkflowError,
  getWorkflowMeta,
  listWorkflows,
  loadWorkflowTemplate,
  WORKFLOW_REGISTRY,
} from './workflowRegistry';
import {
  normalizeMiniMaxH3Params,
  prepareMiniMaxH3T2VAWorkflow,
  type MiniMaxH3Params,
  type PromptGraph,
  type ReferenceUploader,
} from './workflows/minimaxH3T2VA';
import {
  CustomWorkflowError,
  customWorkflowTemplate,
  customWorkflowsDirState,
  customWorkflowsStatus,
  getCustomWorkflow,
  invalidateCustomWorkflows,
  listCustomWorkflows,
  normalizeCustomWorkflowParams,
  prepareCustomWorkflow,
  setCustomWorkflowsDir,
  type CustomWorkflowParams,
} from './customWorkflows';
import { ComfyRunError, runComfyWorkflow } from './workflowRun';
import { listWorkflowConfigs, readWorkflowConfig, saveWorkflowConfig } from './workflowConfig';
import { workflowCoverUrl } from './workflowCovers';
import {
  ensureWidgetSnapshot,
  readWidgetSnapshot,
  widgetSnapshotSummary,
} from './widgetOptions';
import { taskResponse, type GenerationJournal } from './generationJournal';
import type { ModelResolver } from './modelResolver';
import type { MediaStore } from '../canvas/mediaStore';

/**
 * 工作流 type → 动态组装 handler + 参数归一化。
 * 单独一张表而不是塞进 workflowRegistry：handler 要 import loadWorkflowTemplate，
 * registry 若反过来 import handler 就成了循环依赖。
 * 键必须同时存在于 WORKFLOW_REGISTRY（拿 outputNodeId / timeoutMs 等元数据）。
 * **只放内置工作流**；自定义工作流由 resolveWorkflowHandler 回落到通用 handler。
 */
interface WorkflowHandler {
  /** 原始 body → 校验过的参数（各工作流自己那份） */
  normalize: (body: unknown) => MiniMaxH3Params;
  /** 参数 + 客户端 → ComfyUI API 格式的 prompt 图 */
  prepare: (client: ReferenceUploader, params: MiniMaxH3Params) => Promise<PromptGraph>;
}

const WORKFLOW_HANDLERS: Readonly<Record<string, WorkflowHandler>> = {
  'minimax-h3-t2va': {
    normalize: normalizeMiniMaxH3Params,
    prepare: prepareMiniMaxH3T2VAWorkflow,
  },
};

/** 路由层眼里的参数：内置与自定义工作流都只需要 text / mode（其余字段各自处理）。 */
export interface WorkflowParams {
  mode: string;
  text?: string;
}

/** 路由层用的统一 handler 形状（把内置那份的参数类型擦成 WorkflowParams）。 */
interface ResolvedHandler {
  normalize: (body: unknown) => WorkflowParams;
  prepare: (client: ReferenceUploader, params: WorkflowParams) => Promise<PromptGraph>;
}

/**
 * 查一个 workflowType 的 handler：
 *   1) 内置表里有就用内置的；
 *   2) 否则看它是不是用户目录里的自定义工作流 —— 是就回落到通用 handler（照 meta 的 bindings 组装）。
 * 这就是「零 wiring」的关键：新增自定义工作流不用改这张表，也不用改 src/host/index.ts。
 */
function resolveWorkflowHandler(type: string): ResolvedHandler | null {
  const builtin = WORKFLOW_HANDLERS[type];
  if (builtin) {
    return {
      normalize: (body) => builtin.normalize(body),
      // 内置表是「按 type 定参数类型」的，这里收窄回 MiniMaxH3Params（表里目前只有它）
      prepare: (client, params) => builtin.prepare(client, params as MiniMaxH3Params),
    };
  }
  if (!getCustomWorkflow(type)) return null;
  return {
    normalize: (body) => normalizeCustomWorkflowParams(type, body),
    prepare: (client, params) => prepareCustomWorkflow(type, client, params as CustomWorkflowParams),
  };
}

/** 已知的 workflowType（内置 handler + 自定义目录），404 时回给调用方便于排查。 */
function knownWorkflowIds(): string[] {
  return [...Object.keys(WORKFLOW_HANDLERS), ...listCustomWorkflows().map((entry) => entry.id)];
}

/**
 * 组装/执行阶段的错误统一取 status + code。
 * 三类错误（内置工作流 / 自定义工作流 / 运行期）形状一致，只是归属不同模块，这里合并判断。
 */
function httpErrorOf(error: unknown): { status: number; code: string; message: string } | null {
  if (
    error instanceof ComfyWorkflowError ||
    error instanceof ComfyRunError ||
    error instanceof CustomWorkflowError
  ) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return null;
}

/** 路由层需要的额外依赖（媒体库 + 任务日记 + 提交前对账）。 */
export interface ComfyRouteDeps {
  mediaStore: MediaStore;
  journal: GenerationJournal;
  /** 用 ComfyUI /object_info 核对节点与模型文件名；不传就跳过对账 */
  modelResolver?: ModelResolver;
}

/**
 * 把「画布里的素材 URL」接到 ComfyUI 上传通道上。
 *
 * 为什么需要：画布节点上存的是本插件自己的相对地址
 * （`/api/aifisher/canvas/media/<项目>/images/<文件>`），不能直接 fetch，也不该绕一圈回环
 * HTTP。host 手上就有这些字节，直接读盘交给 uploadImage(bytes)。
 * 非本插件地址（http(s) 的外链素材）仍走 uploadImageUrl。
 * 这一段等价于上游 comfyWorkflowRouter 里的 assertProjectMedia 解析。
 */
function uploaderFor(client: ComfyClient, mediaStore: MediaStore): ReferenceUploader {
  return {
    async uploadImageUrl(url: string, filename?: string) {
      const local = await mediaStore.readBytesForUrl(url).catch(() => null);
      if (local) return client.uploadImage(local.bytes, filename ?? local.filename);
      return client.uploadImageUrl(url, filename);
    },
  };
}


/** 能力清单允许的 outputType（照上游）。 */
const OUTPUT_TYPES: ReadonlySet<string> = new Set(['images', 'audios', 'videos']);

/**
 * GET capabilities 的实现（两个前缀共用一份，避免复制逻辑）：
 *   - /api/comfy/capabilities                        （本文件注册）
 *   - /api/aifisher/canvas/comfy/capabilities        （画布前端 vendor 改写后的路径，见 canvas/restRouter.ts）
 * 参数从传入的 URL 里取，调用方只管把自己解析好的 URL 递进来。
 */
export function sendComfyCapabilities(url: URL, res: ServerResponse): void {
  const outputType = url.searchParams.get('outputType');
  if (outputType && !OUTPUT_TYPES.has(outputType)) {
    sendJson(res, 400, { error: '能力输出类型无效', code: 'INVALID_OUTPUT_TYPE' });
    return;
  }
  const capabilities = listWorkflows()
    .filter((workflow) => !outputType || workflow.outputType === outputType)
    .map((workflow) => {
      // 自定义工作流额外回一份「节点参数骨架」（有哪些参数、哪些是素材入口、控件类型），
      // 画布拿到就能直接渲染成节点，不必自己去解析 ComfyUI 模板 JSON。
      const custom = getCustomWorkflow(workflow.id);
      // 工作流配图（v1.28）：左侧「工作流节点」面板的卡片封面 + 节点头部的小图都读它
      const coverUrl = workflowCoverUrl(workflow.id);
      return {
        workflowType: workflow.id,
        title: workflow.title,
        category: workflow.category,
        outputType: workflow.outputType,
        requiredInputs: workflow.requiredInputs,
        // 上游能力清单里没有 modes，画布这边需要它来渲染「模式」下拉/连线规则
        modes: workflow.modes,
        ...(coverUrl ? { coverUrl } : {}),
        ...(custom
          ? { template: { ...customWorkflowTemplate(custom), ...(coverUrl ? { coverUrl } : {}) } }
          : {}),
      };
    });
  sendJson(res, 200, { capabilities });
}

async function handleComfy(
  req: IncomingMessage,
  res: ServerResponse,
  client: ComfyClient,
  deps: ComfyRouteDeps,
  /** 画布命名空间转发进来时，真实 pathname 由调用方给出（req.url 仍是 /api/aifisher/canvas/...） */
  pathOverride?: string,
): Promise<void> {
  // 同源围栏（与画布/账号路由一致：裸挂 webServer、没有 DSH 的 cookie 鉴权）
  if (rejectCrossOrigin(req, res)) return;
  // 转发进来的路径要带上原始查询串（?outputType=videos、?attemptId=… 全靠它）
  const search = pathOverride ? new URL(req.url ?? '/', 'http://x').search : '';
  const url = new URL(`${pathOverride ?? req.url ?? '/'}${search}`, 'http://x');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // GET /api/comfy/ping
  if (path === '/api/comfy/ping' && method === 'GET') {
    const online = await client.ping();
    sendJson(res, 200, {
      online,
      url: process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188',
    });
    return;
  }

  // GET /api/comfy/workflows  —— 从 workflowRegistry 读真注册表
  if (path === '/api/comfy/workflows' && method === 'GET') {
    sendJson(res, 200, { workflows: listWorkflows() });
    return;
  }

  // GET /api/comfy/custom-workflows  —— 自定义工作流目录的只读诊断
  // （读到了几个、哪些 JSON/meta 坏了、每个工作流认出来的参数名；排查「丢进去没生效」用）
  // ?refresh=1 时先丢掉扫描缓存立刻重扫（平时是 ~2 秒 TTL，等它自己过期也行）
  if (path === '/api/comfy/custom-workflows' && method === 'GET') {
    if (url.searchParams.get('refresh') === '1') invalidateCustomWorkflows();
    sendJson(res, 200, { ok: true, ...customWorkflowsStatus() });
    return;
  }

  // GET /api/comfy/workflow-config  —— 「ComfyUI 工作流配置」面板的工作流清单
  //   ?refresh=1 先丢掉扫描缓存立刻重扫（面板打开、点「重新扫描」时用）
  if (path === '/api/comfy/workflow-config' && method === 'GET') {
    if (url.searchParams.get('refresh') === '1') invalidateCustomWorkflows();
    try {
      sendJson(res, 200, listWorkflowConfigs());
    } catch (error) {
      const http = httpErrorOf(error);
      sendJson(res, http?.status ?? 500, {
        error: error instanceof Error ? error.message : '读取工作流清单失败',
        code: http?.code ?? 'WORKFLOW_CONFIG_FAILED',
      });
    }
    return;
  }

  // GET/POST /api/comfy/workflow-config-dir  —— 自定义工作流目录（v1.18 起可改到任意路径）
  //   GET  读当前目录 + 默认目录（面板底栏那个输入框初值）
  //   POST { dir: "D:\\ComfyUI\\我的工作流" } 改过去；{ dir: null } 或 { reset: true } 回默认
  if (path === '/api/comfy/workflow-config-dir') {
    if (method === 'GET') {
      sendJson(res, 200, customWorkflowsDirState());
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, 8 * 1024);
      if (body === null) {
        sendJson(res, 422, { error: '请求体不是合法 JSON', code: 'INVALID_BODY' });
        return;
      }
      try {
        sendJson(res, 200, setCustomWorkflowsDir(body));
      } catch (error) {
        const http = httpErrorOf(error);
        sendJson(res, http?.status ?? 500, {
          error: error instanceof Error ? error.message : '保存工作流目录失败',
          code: http?.code ?? 'WORKFLOW_DIR_FAILED',
        });
      }
      return;
    }
    sendJson(res, 405, { error: '只支持 GET / POST', code: 'METHOD_NOT_ALLOWED' });
    return;
  }

  // GET /api/comfy/workflow-config/<id>  —— 单个工作流的候选字段 / 保存配置
  const configMatch = /^\/api\/comfy\/workflow-config\/([^/]+)$/.exec(path);
  if (configMatch && (method === 'GET' || method === 'POST')) {
    const id = decodeURIComponent(configMatch[1]);
    try {
      if (method === 'GET') {
        if (url.searchParams.get('refresh') === '1') invalidateCustomWorkflows();
        sendJson(res, 200, readWorkflowConfig(id));
        return;
      }
      const body = await readJsonBody(req, 256 * 1024);
      if (body === null) {
        sendJson(res, 422, { error: '请求体不是合法 JSON', code: 'INVALID_BODY' });
        return;
      }
      sendJson(res, 200, saveWorkflowConfig(id, body));
    } catch (error) {
      const http = httpErrorOf(error);
      sendJson(res, http?.status ?? 500, {
        error: error instanceof Error ? error.message : '工作流配置读写失败',
        code: http?.code ?? 'WORKFLOW_CONFIG_FAILED',
      });
    }
    return;
  }

  // GET /api/comfy/widget-options  —— v1.20：扫 ComfyUI 的 /object_info，拿每个字段的候选值
  //   用户原话：「我想要切换个 lora 模型，但是要我输入文字，能否自动扫描我的 comfui 做出列表让我选」。
  //   快照落盘在 storages/dsh-aifisher-canvas/comfy-widget-options.json：
  //     - 默认 5 分钟内复用（object_info 几 MB，不能每次请求都拉）；
  //     - ComfyUI 没开时回上次落盘的那份（否则「想配工作流得先开 ComfyUI」太别扭）；
  //     - ?refresh=1 强制重扫（面板上的「扫描 ComfyUI」与画布节点首次挂载都走它）。
  //   响应是 { ok, fetchedAt, classes: { 类名: { 字段: { control, options… } } } }，
  //   扫描失败也回 200 + ok:false + 旧快照，前端照常能渲染（只是少了下拉候选）。
  if (path === '/api/comfy/widget-options' && method === 'GET') {
    const refresh = url.searchParams.get('refresh') === '1';
    try {
      const snapshot = await ensureWidgetSnapshot(client, {
        refresh,
        baseUrl: process.env.COMFYUI_URL?.trim() || 'http://127.0.0.1:8188',
      });
      sendJson(res, 200, {
        // summary 里自带 ok（= 快照是否存在），必须先展开再显式写本次扫描的结果，
        // 否则「扫描失败但读到了旧快照」会被覆盖成 ok:true。
        ...widgetSnapshotSummary(snapshot),
        ok: true,
        classes: snapshot.classes,
      });
    } catch (error) {
      const cached = readWidgetSnapshot();
      sendJson(res, 200, {
        ...widgetSnapshotSummary(cached),
        ok: false,
        code: 'COMFY_UNAVAILABLE',
        error: error instanceof Error ? error.message : '扫描 ComfyUI 失败',
        classes: cached?.classes ?? {},
      });
    }
    return;
  }

  // GET /api/comfy/capabilities?outputType=videos
  if (path === '/api/comfy/capabilities' && method === 'GET') {
    sendComfyCapabilities(url, res);
    return;
  }

  // GET /api/comfy/workflow/:type  —— 取某个工作流的 API 模板 JSON
  const templateMatch = /^\/api\/comfy\/workflow\/([^/]+)$/.exec(path);
  if (templateMatch && method === 'GET') {
    const id = decodeURIComponent(templateMatch[1]);
    const meta = getWorkflowMeta(id);
    if (!meta) {
      sendJson(res, 404, { error: 'unknown workflow type', id, known: knownWorkflowIds() });
      return;
    }
    const template = await loadWorkflowTemplate(id);
    if (!template) {
      // 注册表里有、文件却找不到：模板 JSON 没跟着产物走（内置）或用户目录里的文件被删了（自定义）
      const source = WORKFLOW_REGISTRY[id]?.templateFile ?? getCustomWorkflow(id)?.file ?? id;
      sendJson(res, 500, {
        error: `工作流模板文件缺失或读不到：${source}`,
        code: 'TEMPLATE_MISSING',
        id,
      });
      return;
    }
    sendJson(res, 200, { id, template });
    return;
  }

  // POST /api/comfy/prepare/:type  —— 动态组装工作流（只出 prompt 图，不排队）
  const prepareMatch = /^\/api\/comfy\/prepare\/([^/]+)$/.exec(path);
  if (prepareMatch && method === 'POST') {
    const type = decodeURIComponent(prepareMatch[1]);
    const handler = resolveWorkflowHandler(type);
    const meta = getWorkflowMeta(type);
    if (!handler || !meta) {
      sendJson(res, 404, {
        error: 'unknown workflow type',
        id: type,
        known: knownWorkflowIds(),
      });
      return;
    }
    // 提示词上限 20000 字符（中文 UTF-8 一个字 3 字节），16KB 的默认上限不够用
    const body = await readJsonBody(req, 256 * 1024);
    if (body === null) {
      sendJson(res, 422, { error: '请求体不是合法 JSON', code: 'INVALID_BODY' });
      return;
    }
    try {
      const params = handler.normalize(body);
      const workflow = await handler.prepare(uploaderFor(client, deps.mediaStore), params);
      // 可选对账：?reconcile=1 或 body.reconcile=true 时顺带核一遍节点/模型文件名。
      // prepare 的默认行为（只出图、不对账）保持不变；开了就多回一份 resolvedModels，
      // 让用户能在真跑之前先确认「这份模板在本机跑得起来」。
      const bodyRecord = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const wantReconcile = url.searchParams.get('reconcile') === '1' || bodyRecord.reconcile === true;
      const reconciled =
        wantReconcile && deps.modelResolver
          ? await deps.modelResolver.reconcile(workflow as never)
          : null;
      sendJson(res, 200, {
        ok: true,
        workflowType: type,
        mode: params.mode,
        // 组装结果直接喂 /api/comfy/run：{ workflow } 就是它的 body 字段名
        workflow,
        // 执行侧要用的元数据（上游从注册表读，这里一并回给调用方）
        outputNodeId: meta.outputNodeId,
        timeoutMs: meta.timeoutMs,
        ...(reconciled
          ? { resolvedModels: reconciled.substitutions, nodeTypes: reconciled.nodeTypes }
          : {}),
      });
    } catch (e) {
      const http = httpErrorOf(e);
      if (http) {
        sendJson(res, http.status, { error: http.message, code: http.code });
        return;
      }
      // 走到这里基本是取素材 / 上传失败（本机 ComfyUI 没起、URL 取不到…）
      sendJson(res, 502, {
        error: e instanceof Error ? e.message : '组装工作流失败',
        code: 'COMFY_PREPARE_FAILED',
      });
    }
    return;
  }

  // POST /api/comfy/run
  if (path === '/api/comfy/run' && method === 'POST') {
    const body = (await readJsonBody(req)) as {
      workflow?: unknown;
      clientId?: unknown;
    } | null;
    if (!body || typeof body.workflow !== 'object' || body.workflow === null) {
      sendJson(res, 422, { error: 'workflow 必填' });
      return;
    }
    try {
      const result = await client.queuePrompt(
        body.workflow as Record<string, unknown>,
        typeof body.clientId === 'string' ? body.clientId : 'dsh-aifisher',
      );
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 502, {
        error: e instanceof Error ? e.message : 'ComfyUI 调用失败',
        code: 'COMFY_UNAVAILABLE',
      });
    }
    return;
  }

  // GET /api/comfy/generation-status/:nodeId  —— 结果回收（画布 useVideoResults 每 10s 拉一次）
  // POST /api/comfy/generation-cancel/:nodeId
  const statusMatch = /^\/api\/comfy\/generation-(status|cancel)\/([^/]+)$/.exec(path);
  if (statusMatch) {
    const [, verb, rawNodeId] = statusMatch;
    const nodeId = decodeURIComponent(rawNodeId);
    if (verb === 'cancel') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const body = (await readJsonBody(req)) as { attemptId?: unknown; projectId?: unknown } | null;
      const attemptId = typeof body?.attemptId === 'string' ? body.attemptId : undefined;
      const result = await deps.journal.cancel(nodeId, attemptId);
      if (!result) {
        sendJson(res, 409, { error: '该生成任务当前不可取消。', code: 'GENERATION_NOT_FOUND' });
        return;
      }
      if (!result.ok) {
        sendJson(res, 409, {
          error:
            result.code === 'GENERATION_ATTEMPT_CONFLICT'
              ? '这次操作针对的任务已被更新的尝试替代。'
              : '该生成任务当前不可取消。',
          code: result.code,
          status: result.task.status,
        });
        return;
      }
      sendJson(res, 200, {
        success: true,
        status: 'cancelled',
        code: result.task.code,
        remoteMayContinue: false,
      });
      return;
    }
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const requestedAttemptId = url.searchParams.get('attemptId') ?? '';
    const task = deps.journal.get(nodeId);
    if (requestedAttemptId && task?.attemptId !== requestedAttemptId) {
      // 记录对不上：媒体文件不能证明「整次尝试」完成（可能是部分产出）
      sendJson(res, 200, { status: 'missing', attemptId: requestedAttemptId });
      return;
    }
    if (task) {
      sendJson(res, 200, taskResponse(task));
      return;
    }
    // 没有日记（进程重启过）时从素材库反查该节点最近产出的素材 —— 上游同款兜底
    if (requestedAttemptId) {
      sendJson(res, 200, { status: 'missing', attemptId: requestedAttemptId });
      return;
    }
    const latest = await deps.mediaStore.findLatestForNode(nodeId);
    if (latest) {
      sendJson(res, 200, {
        status: 'success',
        type: latest.kind,
        resultUrl: latest.url,
        resultUrls: [latest.url],
        createdAt: latest.createdAt,
        model: latest.model,
        aspectRatio: latest.aspectRatio,
        resolution: latest.resolution,
      });
      return;
    }
    sendJson(res, 200, { status: 'missing' });
    return;
  }

  // GET /api/comfy/history/:id
  const historyMatch = /^\/api\/comfy\/history\/([^/]+)$/.exec(path);
  if (historyMatch && method === 'GET') {
    try {
      const history = await client.getHistory(decodeURIComponent(historyMatch[1]));
      sendJson(res, 200, history);
    } catch (e) {
      sendJson(res, 502, {
        error: e instanceof Error ? e.message : '查历史失败',
      });
    }
    return;
  }

  // POST /api/comfy/:workflowType  —— 统一本地工作流入口（上游 legacyComfyGenerationRouter）
  // 放在最后：上面那些具名路由（ping/workflows/custom-workflows/capabilities/workflow/prepare/run/
  // history/generation-*）都是单段或更长，先匹配完才轮到这条兜底。
  const unifiedMatch = /^\/api\/comfy\/([^/]+)$/.exec(path);
  if (unifiedMatch && method === 'POST') {
    const type = decodeURIComponent(unifiedMatch[1]);
    // 内置优先，查不到就回落到「用户目录里的自定义工作流」通用 handler
    const meta = getWorkflowMeta(type);
    const handler = resolveWorkflowHandler(type);
    if (!meta || !handler) {
      sendJson(res, 404, {
        error: `未知的本地工作流：${type}`,
        code: 'UNKNOWN_WORKFLOW',
        known: knownWorkflowIds(),
      });
      return;
    }
    // 视频工作流可能跑十几分钟：明确关掉本请求上的 socket 超时，不靠宿主默认值
    req.setTimeout?.(0);
    res.setTimeout?.(0);
    const body = (await readJsonBody(req, 4 * 1024 * 1024)) as Record<string, unknown> | null;
    if (body === null) {
      sendJson(res, 422, { error: '请求体不是合法 JSON', code: 'INVALID_BODY' });
      return;
    }
    const projectId =
      typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : 'default';
    const nodeId = typeof body.nodeId === 'string' && body.nodeId ? body.nodeId : undefined;
    const attemptId =
      typeof body.generationAttemptId === 'string' && body.generationAttemptId
        ? body.generationAttemptId
        : randomUUID();
    try {
      const params = handler.normalize(body);
      const workflow = await handler.prepare(uploaderFor(client, deps.mediaStore), params);
      // 提交前对账：模板里的节点类型与模型文件名未必等于本机装的那份。
      // 能唯一匹配就自动换成实际文件名，匹配不上就报 409 + 可用候选（见 modelResolver.ts）。
      const reconciled = deps.modelResolver
        ? await deps.modelResolver.reconcile(workflow as never)
        : null;
      if (reconciled?.substitutions.length) {
        for (const item of reconciled.substitutions) {
          console.warn(
            `[aifisher-canvas] 模型文件名对不上，已自动替换：节点 ${item.nodeId}.${item.field} ${item.from} → ${item.to}`,
          );
        }
      }
      const record = await runComfyWorkflow({
        client,
        mediaStore: deps.mediaStore,
        journal: deps.journal,
        workflow: workflow as unknown as Record<string, unknown>,
        meta: { id: meta.id, title: meta.title, outputNodeId: meta.outputNodeId, timeoutMs: meta.timeoutMs },
        projectId,
        ...(nodeId ? { nodeId } : {}),
        prompt: params.text,
        attemptId,
      });
      // 形状照上游 legacyComfyGenerationRouter：{ success: true, url, asset }
      sendJson(res, 200, {
        success: true,
        url: record.url,
        asset: record,
        workflowType: type,
        mode: params.mode,
        ...(reconciled?.substitutions.length
          ? { resolvedModels: reconciled.substitutions }
          : {}),
      });
    } catch (e) {
      const http = httpErrorOf(e);
      if (http) {
        sendJson(res, http.status, { error: http.message, code: http.code });
        return;
      }
      sendJson(res, 502, {
        error: e instanceof Error ? e.message : '本地工作流执行失败',
        code: 'COMFY_RUN_FAILED',
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'unknown comfy route', path });
}

/** 把 ComfyUI 路由挂到 DSH webServer 上。返回 disposer。 */
export function attachComfyRoutes(
  webServer: WebServerLike,
  client: ComfyClient,
  deps: ComfyRouteDeps,
): () => void {
  return webServer.register({
    kind: 'prefix',
    path: '/api/comfy',
    handler: (req, res) => handleComfy(req, res, client, deps),
  });
}

/**
 * 画布命名空间下的 ComfyUI 转发器。
 *
 * 画布前端（vendor 进来的上游源码）请求的是 `/api/aifisher/canvas/comfy/...`
 * —— vendor 脚本把上游的 `/api/comfy/...` 整体改写过。逻辑不复制：这里把剩余路径
 * （`/capabilities`、`/minimax-h3-t2va` …）拼回 `/api/comfy` 前缀再交给同一个 handleComfy。
 */
export interface ComfyDelegate {
  /** 处理 `/api/aifisher/canvas/comfy/<rest>`；已处理返回 true */
  handle(req: IncomingMessage, res: ServerResponse, restPath: string): Promise<boolean>;
}

export function createComfyDelegate(client: ComfyClient, deps: ComfyRouteDeps): ComfyDelegate {
  /** 画布命名空间只放行「本文件真的实现过」的路径；其余交回 restRouter 报 501/404。 */
  function isKnown(path: string): boolean {
    if (
      path === '/api/comfy/ping' ||
      path === '/api/comfy/workflows' ||
      path === '/api/comfy/custom-workflows' ||
      path === '/api/comfy/workflow-config' ||
      path === '/api/comfy/workflow-config-dir' ||
      path === '/api/comfy/widget-options' ||
      path === '/api/comfy/capabilities' ||
      path === '/api/comfy/run'
    ) {
      return true;
    }
    if (
      /^\/api\/comfy\/workflow\/[^/]+$/.test(path) ||
      /^\/api\/comfy\/workflow-config\/[^/]+$/.test(path) ||
      /^\/api\/comfy\/prepare\/[^/]+$/.test(path) ||
      /^\/api\/comfy\/history\/[^/]+$/.test(path) ||
      /^\/api\/comfy\/generation-(status|cancel)\/[^/]+$/.test(path)
    ) {
      return true;
    }
    // 统一生成入口：单段路径一律放行，由 handleComfy 判「未知工作流」并回已知清单
    // （用户目录里的自定义工作流 id 也是单段，所以走同一条）
    const type = path.slice('/api/comfy/'.length);
    return !type.includes('/');
  }

  return {
    async handle(req, res, restPath) {
      // restPath 是「画布命名空间之后」的剩余路径，两种形状都要认：
      //   /comfy/minimax-h3-t2va      （画布前端调本地工作流，vendor 改写产物）
      //   /generation-status/<id>     （画布结果回收，本来就是画布前缀下的路径）
      const suffix = restPath === '/comfy' ? '' : restPath.startsWith('/comfy/') ? restPath.slice('/comfy'.length) : restPath;
      const path = `/api/comfy${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
      if (!isKnown(path)) return false;
      await handleComfy(req, res, client, deps, path);
      return true;
    },
  };
}

