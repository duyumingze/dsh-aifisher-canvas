/**
 * 本机运行环境（host 半）—— 画布「设置 → 开源服务」那一页要的数据。
 *
 * 上游这个模块是「AIFISHER 自己托管本机 ComfyUI 进程」的那套后端（discover / start / stop /
 * logs / 节点编号扩展安装）。本插件**不托管 ComfyUI 进程**（用户用绘世启动器自己启），
 * 所以这里给出的是**只读的、真实的**一部分：
 *
 *   GET    /local-runtime/status                          本机环境总览（GPU / ComfyUI / 工作流 / 模型）
 *   POST   /local-runtime/refresh                         同上，跳过缓存
 *   GET    /local-runtime/comfyui                         ComfyUI 进程状态
 *   POST   /local-runtime/comfyui/start | /stop            明确回 disabled（不托管进程）
 *   GET    /local-runtime/comfyui/logs?lines=             {state, logs:{stdout,stderr}}
 *   POST   /local-runtime/comfyui/discover                不扫盘，只回当前配置
 *   POST   /local-runtime/comfyui/validate-directory      不校验（DSH 版不用安装目录）→ 409 + error
 *   POST   /local-runtime/comfyui/select-directory        {status:'cancelled'}（没有原生目录选择器）
 *   GET    /local-runtime/comfyui/extensions/node-ids     扩展不在本插件管理范围 → unavailable
 *
 * 契约细节（都来自 vendor/aifisher/src/stable/local/localRuntimeClient.ts 与 localRuntimeSettings.ts）：
 *   - status 的 gpu / models / comfyui 三块**都必须存在**（UI 无 `?.` 兜底），
 *     且 comfyui.address/status、gpu.available、models.total、comfyui.workflowCount 是硬需求；
 *   - **`comfyui.process` 必须有**，否则整块「启动/停止/打开网页端/目录/节点编号」控件都不渲染；
 *     画布头部的 ComfyUI 状态胶囊（installComfyLogPanel）也只看 process（phase/running/startable）；
 *   - `readComfyProcess` 的豁免规则：非 2xx 时只有 body.status === 'failed' 不抛异常，
 *     其余一律抛 body.error —— 所以「不支持」要用 2xx + status:'disabled' 表达，
 *     「校验失败」用非 2xx + error（不带 status）表达，避免 UI 静默走成功分支。
 *
 * 缓存：状态查询会打 ComfyUI 的 /object_info（几 MB），所以整份结果缓存 10 秒，
 * `/refresh` 强制绕开。GPU 用 nvidia-smi 探测，同样缓存，失败就是「未检测到」。
 */
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http/httpUtil';
import type { ComfyClient } from '../comfyui/comfyClient';
import { listWorkflows, loadWorkflowTemplate } from '../comfyui/workflowRegistry';
import { listCustomWorkflows, loadCustomWorkflowTemplate } from '../comfyui/customWorkflows';

export interface LocalRuntimeDeps {
  /** 已经建好的 ComfyUI 客户端（画布生成链路用的同一个）。 */
  comfy: ComfyClient;
  /** ComfyUI 服务地址（显示与「打开网页端」用）。 */
  baseUrl: string;
}

const STATUS_TTL_MS = 10_000;
const GPU_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

interface GpuInfo {
  available: boolean;
  sufficient: boolean;
  name?: string;
  vramTotalBytes?: number;
  vramFreeBytes?: number;
}

/** ComfyUI object_info 里「模型文件名枚举」的输入名 → 归类。 */
const MODEL_INPUTS: Readonly<Record<string, string>> = Object.freeze({
  ckpt_name: 'checkpoints',
  unet_name: 'diffusionModels',
  diffusion_model: 'diffusionModels',
  clip_name: 'textEncoders',
  text_encoder: 'textEncoders',
  vae_name: 'vaes',
  lora_name: 'loras',
});

let gpuCache: { at: number; value: GpuInfo } | null = null;

/** 探测不到就是「没独显 / 驱动没装」——与上游语义一致，不是错误。 */
const GPU_UNKNOWN: GpuInfo = Object.freeze({ available: false, sufficient: false });

function runSmi(): Promise<GpuInfo> {
  return new Promise((resolve) => {
    try {
      execFile(
        'nvidia-smi',
        ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error || !stdout) {
            resolve(GPU_UNKNOWN);
            return;
          }
          const first = String(stdout).trim().split(/\r?\n/)[0] ?? '';
          const [name, total, free] = first.split(',').map((part) => part.trim());
          const totalMib = Number(total);
          const freeMib = Number(free);
          if (!Number.isFinite(totalMib) || totalMib <= 0) {
            resolve(GPU_UNKNOWN);
            return;
          }
          // 「够不够」按上游的语义给个保守判断：可用显存 ≥ 8 GiB 才算够跑常见视频模型
          resolve({
            available: true,
            sufficient: Number.isFinite(freeMib) ? freeMib >= 8 * 1024 : false,
            ...(name ? { name } : {}),
            vramTotalBytes: Math.round(totalMib * 1024 * 1024),
            ...(Number.isFinite(freeMib) ? { vramFreeBytes: Math.round(freeMib * 1024 * 1024) } : {}),
          });
        },
      );
    } catch {
      // 受限环境（DSH 的沙箱、某些安全软件）里 spawn 会**同步抛** EPERM/EACCES，
      // 不走回调。这里必须接住：这个 Promise 一拒绝就会一路冒到路由层，
      // 变成「一次未捕获的 Promise 拒绝」——在 Node 里那是会把整个宿主进程带走的。
      // 探不到 GPU 只是「没有独显」，界面照样该渲染（对应 vendor 的 gpu.available=false）。
      resolve(GPU_UNKNOWN);
    }
  });
}

async function detectGpu(): Promise<GpuInfo> {
  if (gpuCache && Date.now() - gpuCache.at < GPU_TTL_MS) return gpuCache.value;
  // 再兜一层：runSmi 已经不会拒绝了，但探测本身不该有任何机会把路由打崩
  const value = await runSmi().catch(() => GPU_UNKNOWN);
  gpuCache = { at: Date.now(), value };
  return value;
}

/** 直接从 ComfyUI 拉一个 JSON 端点（client 没暴露 system_stats / queue）。 */
async function comfyJson<T>(baseUrl: string, path: string): Promise<T | null> {
  try {
    const response = await fetch(new URL(path, baseUrl).href, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

interface ObjectInfoNode {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
}

/** 从 object_info 里抽模型清单（各 loader 节点的文件名枚举）。 */
function extractComfyModels(objectInfo: Record<string, ObjectInfoNode>) {
  const buckets: Record<string, Set<string>> = {
    checkpoints: new Set(),
    diffusionModels: new Set(),
    textEncoders: new Set(),
    vaes: new Set(),
    loras: new Set(),
  };
  for (const node of Object.values(objectInfo ?? {})) {
    for (const group of [node?.input?.required, node?.input?.optional]) {
      if (!group || typeof group !== 'object') continue;
      for (const [inputName, bucket] of Object.entries(MODEL_INPUTS)) {
        const entry = (group as Record<string, unknown>)[inputName];
        if (!Array.isArray(entry)) continue;
        const options = entry[0];
        if (!Array.isArray(options)) continue;
        for (const option of options) {
          if (typeof option === 'string' && option) buckets[bucket]?.add(option);
        }
      }
    }
  }
  return buckets;
}

/** 工作流的节点类型清单（只读模板 JSON；坏文件跳过）。只在 ComfyUI 在线时才算兼容性。 */
async function workflowClassTypes(): Promise<Array<{ id: string; title: string; types: string[] }>> {
  const listed = listWorkflows();
  const custom = listCustomWorkflows();
  const customById = new Map(custom.map((entry) => [entry.id, entry]));
  const result: Array<{ id: string; title: string; types: string[] }> = [];
  for (const item of listed) {
    try {
      const template = customById.has(item.id)
        ? loadCustomWorkflowTemplate(customById.get(item.id)!)
        : await loadWorkflowTemplate(item.id);
      if (!template) continue;
      const types = new Set<string>();
      for (const node of Object.values(template as Record<string, unknown>)) {
        const classType = (node as { class_type?: unknown })?.class_type;
        if (typeof classType === 'string' && classType) types.add(classType);
      }
      result.push({ id: item.id, title: item.title, types: [...types] });
    } catch {
      // 单个工作流读不出来不影响整页
    }
  }
  return result;
}

async function buildStatus(deps: LocalRuntimeDeps) {
  const online = await deps.comfy.ping();
  const [gpu, stats, queue] = await Promise.all([
    detectGpu(),
    online ? comfyJson<{ system?: { comfyui_version?: string } }>(deps.baseUrl, '/system_stats') : null,
    online
      ? comfyJson<{ queue_running?: unknown[]; queue_pending?: unknown[] }>(deps.baseUrl, '/queue')
      : null,
  ]);

  let objectInfo: Record<string, ObjectInfoNode> | null = null;
  if (online) {
    try {
      objectInfo = (await deps.comfy.objectInfo()) as Record<string, ObjectInfoNode>;
    } catch {
      objectInfo = null;
    }
  }
  const buckets = objectInfo ? extractComfyModels(objectInfo) : null;
  // 注意：buckets 是「名字 → Set」的普通对象（不是 Map），这里必须 Object.values；
  // 写成 buckets.values() 在 ComfyUI 在线那一支会直接抛 TypeError（status 整个 500）。
  const modelTotal = buckets
    ? Object.values(buckets).reduce((sum, set) => sum + set.size, 0)
    : 0;

  // 工作流清单是本机模板（内置 + 目录式自定义），**不需要 ComfyUI 在线**就能数出来；
  // 逐条的兼容性（缺哪些节点类型）才需要 object_info。
  const workflowCount = listWorkflows().length;
  const workflows = online && objectInfo ? await workflowClassTypes() : [];
  const knownTypes = new Set(Object.keys(objectInfo ?? {}));
  const workflowItems = workflows.map((item) => {
    const missing = item.types.filter((type) => !knownTypes.has(type));
    return {
      type: item.id,
      title: item.title,
      status: missing.length === 0 ? ('ready' as const) : ('incompatible' as const),
      missingNodeTypes: missing,
      missingModels: [] as Array<{ type: string; name: string }>,
    };
  });

  const process = {
    ...processState(deps, online),
    actions: ['打开绘世启动器（G:\\ComfyUI-aki-v3.2-duyumingze）启动 ComfyUI'],
  };

  const status: Record<string, unknown> = {
    localOnly: true,
    gpu: {
      status: gpu.available ? 'ready' : 'unavailable',
      available: gpu.available,
      sufficient: gpu.sufficient,
      ...(gpu.name ? { name: gpu.name } : {}),
      ...(gpu.vramTotalBytes ? { vramTotalBytes: gpu.vramTotalBytes } : {}),
      ...(gpu.vramFreeBytes ? { vramFreeBytes: gpu.vramFreeBytes } : {}),
      ...(gpu.available ? {} : { message: '没有检测到 nvidia-smi（无独显或驱动未装）。' }),
    },
    models: {
      // 本插件不内置任何模型：模型全在本机 ComfyUI 那边
      status: 'optional-empty',
      directory: '',
      total: 0,
      byType: {},
      items: [],
      message: '本插件不内置模型；生成用的是本机 ComfyUI 的模型。',
    },
    comfyui: {
      status: online ? (workflowItems.some((item) => item.status === 'ready') ? 'ready' : 'partial') : 'unavailable',
      address: process.address,
      workflowCount,
      compatibleWorkflowCount: online
        ? workflowItems.filter((item) => item.status === 'ready').length
        : 0,
      incompatibleWorkflowCount: workflowItems.filter((item) => item.status === 'incompatible').length,
      nodeTypeCount: knownTypes.size,
      version: stats?.system?.comfyui_version ?? null,
      ...(buckets
        ? {
            models: {
              total: modelTotal,
              checkpoints: [...buckets.checkpoints],
              diffusionModels: [...buckets.diffusionModels],
              textEncoders: [...buckets.textEncoders],
              vaes: [...buckets.vaes],
              loras: [...buckets.loras],
            },
          }
        : {}),
      workflows: workflowItems,
      queueRemaining: queue?.queue_pending?.length ?? 0,
      process,
      ...(online
        ? {}
        : { message: `连不上 ${deps.baseUrl}：确认 ComfyUI 已启动（绘世启动器）。` }),
    },
    diagnostics: [
      `ComfyUI 地址：${deps.baseUrl}（COMFYUI_URL 可改，改完需重启 DSH）`,
      '工作流清单来自本机目录式自定义工作流 + 内置模板；逐条兼容性按节点类型核对。',
      '模型文件名与工作流不一致时，提交前会自动按唯一匹配替换（见 modelResolver）。',
    ],
  };
  return status;
}

let statusCache: { at: number; value: Record<string, unknown> } | null = null;

async function statusOf(deps: LocalRuntimeDeps, force: boolean) {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const value = await buildStatus(deps);
  statusCache = { at: Date.now(), value };
  return value;
}

/**
 * ComfyUI 进程状态。
 *
 * 「不托管」体现在 owned/startable：我们既不起它也不停它。
 * 但 **phase 要说真话**：
 *   - 连上了 → `external`（别人起的服务，我们只读）；
 *   - 没连上 → `idle`（**已配置好地址、等你自己启动**），而不是 `unavailable`
 *     （那是「压根没配置」）。
 * 画布头部的状态胶囊（vendor …/local/comfyLogPanel.ts 的 PHASE_LABEL）就是按 phase 取文案的，
 * 说成 unavailable 会显示成「ComfyUI 未配置」，与事实不符。
 */
function processState(deps: LocalRuntimeDeps, online: boolean) {
  const address = online ? new URL(deps.baseUrl).host : null;
  return {
    phase: online ? ('external' as const) : ('idle' as const),
    autoStart: false,
    running: online,
    owned: false,
    startable: false,
    address,
    message: online
      ? '已检测到本机 ComfyUI 服务（非 DSH 启动）。DSH 版不托管 ComfyUI 进程。'
      : '没有连上 ComfyUI。请用绘世启动器启动它，或用 COMFYUI_URL 指向别的地址后重启 DSH。',
  };
}

/** 处理 /local-runtime/* 子路径；已处理返回 true。 */
export async function handleLocalRuntimeApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: LocalRuntimeDeps;
}): Promise<boolean> {
  const { req, res, url, parts, deps } = input;
  const method = (req.method ?? 'GET').toUpperCase();
  if (parts[0] !== 'local-runtime') return false;

  // ---- 总览 ----
  if (parts.length === 1) return false;
  if (parts[1] === 'status' && parts.length === 2) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    sendJson(res, 200, await statusOf(deps, false));
    return true;
  }
  if (parts[1] === 'refresh' && parts.length === 2) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    sendJson(res, 200, await statusOf(deps, true));
    return true;
  }

  // ---- ComfyUI 进程 ----
  if (parts[1] === 'comfyui') {
    const action = parts[2];
    if (!action) {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      sendJson(res, 200, processState(deps, await deps.comfy.ping()));
      return true;
    }
    if (action === 'start' || action === 'stop') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      // 2xx + status:'disabled' —— readComfyProcess 只对 'failed' 豁免，所以这里不能给 4xx
      const online = await deps.comfy.ping();
      sendJson(res, 200, {
        status: 'disabled',
        message: online
          ? 'ComfyUI 已经在运行（本机外部进程），DSH 版不接管它的启停。'
          : 'DSH 版不托管 ComfyUI 进程：请用绘世启动器启动，或用 COMFYUI_URL 指向已有服务后重启 DSH。',
        address: online ? new URL(deps.baseUrl).host : undefined,
      });
      return true;
    }
    if (action === 'logs') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const requested = Number(url.searchParams.get('lines') ?? 200);
      const limit = Number.isFinite(requested) ? Math.min(2000, Math.max(1, requested)) : 200;
      const online = await deps.comfy.ping();
      const note = online
        ? '（ComfyUI 由外部启动，DSH 拿不到它的标准输出；请在绘世启动器窗口看滚动日志）'
        : '（ComfyUI 未运行）';
      sendJson(res, 200, {
        state: processState(deps, online),
        logs: {
          stdout: { available: false, lines: [note].slice(0, limit) },
          stderr: { available: false, lines: [] },
        },
      });
      return true;
    }
    if (action === 'discover') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      // 不扫盘：DSH 版用 COMFYUI_URL 指路，不需要安装目录
      sendJson(res, 200, {
        candidates: [],
        configuredRoot: deps.baseUrl,
        scope: 'DSH 版不扫描本机磁盘；ComfyUI 地址由 COMFYUI_URL 配置。',
      });
      return true;
    }
    if (action === 'select-directory') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      sendJson(res, 200, { status: 'cancelled' });
      return true;
    }
    if (action === 'validate-directory') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      // 非 2xx 且不带 status:'failed' → 客户端抛异常，UI 直接显示这句话（绝不会静默「成功」）
      sendJson(res, 409, {
        error:
          'DSH 版不用 ComfyUI 安装目录：请用绘世启动器启动 ComfyUI，并用环境变量 COMFYUI_URL（默认 http://127.0.0.1:8188）指向它。',
        code: 'COMFYUI_ROOT_UNSUPPORTED',
      });
      return true;
    }
    if (action === 'extensions' && parts[3] === 'node-ids') {
      const install = parts[4] === 'install';
      if (install) {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
          return true;
        }
        sendJson(res, 200, {
          id: 'fisherai_node_ids',
          name: 'AIFISHER 节点编号',
          bundledVersion: 'n/a',
          installedVersion: 'n/a',
          status: 'unavailable',
          changed: false,
          restartRequired: false,
        });
        return true;
      }
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      sendJson(res, 200, {
        id: 'fisherai_node_ids',
        name: 'AIFISHER 节点编号',
        bundledVersion: 'n/a',
        installedVersion: null,
        status: 'unavailable',
        installable: false,
        message: 'DSH 版不管理 ComfyUI 扩展（本插件不随包该扩展）。',
      });
      return true;
    }
    return false;
  }

  // ---- 厂商 CLI（libtv / dreamina）：上游是「后端代跑 CLI」，本插件不做 ----
  if (parts[1] === 'libtv-cli' || parts[1] === 'dreamina-cli') {
    sendJson(res, 501, {
      error: '本插件不接管厂商 CLI（LibTV / 即梦）的安装与登录。',
      code: 'CLI_NOT_SUPPORTED',
    });
    return true;
  }

  return false;
}
