/**
 * 【本文件是 dsh-aifisher-canvas 的覆盖补丁，不是上游原文】
 * 由 scripts/patches/aifisher/ 覆盖到 vendor/aifisher/ 下，源文件在 scripts/patches/ 里。
 *
 * 相对上游多了两件事：
 *   1) run 的 workflowType 从字面量 'minimax-h3-t2va' 放宽成 string —— 画布上现在还有
 *      「用户自己丢进 workflows 目录」的自定义工作流（custom-<文件名>），它们走同一条
 *      POST /api/aifisher/canvas/comfy/<id> 通道；
 *   2) 一张**本地工作流清单**：从后端能力清单（GET …/comfy/capabilities）拉回来，
 *      既喂给画布节点渲染（提示词/参数/素材槽），也把「画布能自己渲染的那种工作流」的
 *      模板推进 canvasNodeRules 的 workflowTemplates（节点尺寸、连线端口、连线校验都靠它）。
 *
 * 上游原文保留在下面（导出与行为不变），所以原本只用 minimax 的代码不受影响。
 */
import { workflowTemplates } from '../nodes/canvasNodeRules';

export type VideoWorkflowType = string;

export type MiniMaxH3Mode = 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va';

export type VideoWorkflowRequest = {
  projectId: string;
  nodeId?: string;
  text: string;
  mode: MiniMaxH3Mode;
  imageUrl?: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  aspectRatio: string;
  megapixels: number;
  duration: number;
  seed?: number;
  /** 自定义工作流的请求体比这宽松（参数名由 meta.bindings 决定），所以留一个开口 */
  [key: string]: unknown;
};

export type VideoCapability = {
  workflowType: VideoWorkflowType;
  title: string;
  category: string;
  outputType: 'videos' | 'images' | 'audios';
  requiredInputs: string[];
  modes?: string[];
  /** v1.28：这份工作流的自定义配图（左侧「工作流节点」面板的卡片封面 + 节点头部小图） */
  coverUrl?: string;
  /** 只有自定义工作流带这个（后端算好的节点骨架） */
  template?: LocalWorkflowTemplatePayload;
};

export type VideoWorkflowResult = {
  success: true;
  url: string;
  asset?: Record<string, unknown>;
};

async function readJson<T>(response: Response): Promise<T> {
  const result = await response.json() as T & { error?: unknown };
  if (!response.ok) {
    throw new Error(result?.error ? String(result.error) : `本地视频工作流失败 (${response.status})`);
  }
  return result;
}

export function createVideoWorkflowClient(fetcher: typeof fetch = globalThis.fetch) {
  return {
    async getCapabilities(): Promise<VideoCapability[]> {
      const result = await fetcher('/api/aifisher/canvas/comfy/capabilities?outputType=videos').then(
        (response) => readJson<{ capabilities: VideoCapability[] }>(response),
      );
      return result.capabilities;
    },
    /** 不带 outputType 的全量能力清单（画布要同时看图片/视频/音频工作流）。 */
    async listCapabilities(): Promise<VideoCapability[]> {
      const result = await fetcher('/api/aifisher/canvas/comfy/capabilities').then((response) =>
        readJson<{ capabilities: VideoCapability[] }>(response),
      );
      return result.capabilities;
    },
    run(
      workflowType: VideoWorkflowType,
      request: VideoWorkflowRequest,
    ): Promise<VideoWorkflowResult> {
      return fetcher(`/api/aifisher/canvas/comfy/${encodeURIComponent(workflowType)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }).then((response) => readJson<VideoWorkflowResult>(response));
    },
  };
}

export type VideoWorkflowClient = ReturnType<typeof createVideoWorkflowClient>;

declare global {
  interface Window {
    __FISHERAI_VIDEO_WORKFLOWS__?: VideoWorkflowClient;
  }
}

export function installVideoWorkflows(
  client = createVideoWorkflowClient(),
): VideoWorkflowClient {
  window.__FISHERAI_VIDEO_WORKFLOWS__ = client;
  return client;
}

// ================================================================ 本地工作流清单

/** 后端 customWorkflowTemplate() 的形状（见 src/host/comfyui/customWorkflows.ts）。 */
export interface LocalWorkflowTemplatePayload {
  label: string;
  category: string;
  outputType: 'images' | 'videos' | 'audios';
  textParameter: string | null;
  negativeTextParameter?: string | null;
  /** v1.28：用户自定义的配图（host 侧 workflowCovers，没配过就没有这个字段） */
  coverUrl?: string;
  inputs: Array<{ id: string; label: string; type: string; required?: boolean }>;
  outputs: Array<{ id: string; label: string; type: string }>;
  parameters: Array<{
    id: string;
    label: string;
    type: string;
    default?: unknown;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    step?: number;
    /** v1.20：这个参数在 ComfyUI 模板里落在哪个节点/字段（查下拉候选要用） */
    classType?: string;
    field?: string;
  }>;
  defaults: Record<string, unknown>;
}

/** 画布节点用的一份清单条目：后端骨架 + 几个画布自己要用的字段。 */
export interface LocalWorkflowDefinition extends LocalWorkflowTemplatePayload {
  id: string;
  /** 画布能自己渲染成节点的工作流（自定义模板）；内置 minimax 有专用节点，这里是 false */
  custom: boolean;
}

/** 工作流选择器里的一项（自定义 + 内置都给，方便来回切）。 */
export interface LocalWorkflowOption {
  id: string;
  label: string;
  outputType: string;
  custom: boolean;
}

let definitions: LocalWorkflowDefinition[] = [];
let options: LocalWorkflowOption[] = [];
let loadPromise: Promise<LocalWorkflowDefinition[]> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[aifisher-canvas] 本地工作流清单订阅者出错', error);
    }
  }
}

/** 画布能自己渲染的工作流（顺序 = 后端返回顺序 = 文件名排序）。 */
export function localWorkflowDefinitions(): readonly LocalWorkflowDefinition[] {
  return definitions;
}

/** 工作流选择器的候选项（自定义在前）。 */
export function localWorkflowOptions(): readonly LocalWorkflowOption[] {
  return options;
}

/** 按 id 取清单条目（节点渲染与运行都靠它）。 */
export function localWorkflowDefinition(id: string | undefined): LocalWorkflowDefinition | undefined {
  if (!id) return undefined;
  return definitions.find((item) => item.id === id);
}

/** 清单变化（拉回来了 / 重新拉了）时回调，返回取消订阅函数。 */
export function subscribeLocalWorkflows(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 画布新建 ComfyUI 节点时的默认工作流 id（有自定义工作流就用第一个）。 */
export function preferredLocalWorkflowId(): string | undefined {
  return definitions[0]?.id;
}

/** 结果节点类型（画布上的 Upload Image / Video / Audio）。 */
export function localWorkflowOutputNodeType(
  outputType: string | undefined,
): 'Upload Image' | 'Upload Video' | 'Upload Audio' {
  return outputType === 'images'
    ? 'Upload Image'
    : outputType === 'audios'
      ? 'Upload Audio'
      : 'Upload Video';
}

/**
 * 把清单推进 canvasNodeRules 的 workflowTemplates —— 那是一个**可变的导出数组**，
 * 画布的节点尺寸（legacyWorkflowHeight）、连线端口位置（legacyPortY）、连线校验
 * （validateConnection 用 template.inputs）都从它读，所以推进去这三件事自动成立。
 *
 * 放在数组**最前面**：这样从侧边栏/右键菜单新建的 ComfyUI 节点默认就是自定义工作流
 * （本机没装 MiniMax 那套节点包时，内置 minimax-h3-t2va 是跑不起来的），
 * 想用 MiniMax 就在节点上的工作流选择器里切回去 —— 切回去会渲染成上游那个专用节点。
 */
function registerTemplates(): void {
  for (const definition of [...definitions].reverse()) {
    const entry = {
      id: definition.id,
      label: definition.label,
      category: definition.category || 'custom',
      inputs: definition.inputs.map((slot) => ({
        id: slot.id,
        label: slot.label,
        type: slot.type,
      })),
      outputs: definition.outputs.map((output) => ({
        id: output.id,
        label: output.label,
        type: output.type,
      })),
      parameters: definition.parameters.map((parameter) => ({
        id: parameter.id,
        label: parameter.label,
        type: parameter.type,
        ...(parameter.default !== undefined ? { default: parameter.default } : {}),
        ...(parameter.options ? { options: [...parameter.options] } : {}),
        ...(parameter.min !== undefined ? { min: parameter.min } : {}),
        ...(parameter.max !== undefined ? { max: parameter.max } : {}),
        ...(parameter.step !== undefined ? { step: parameter.step } : {}),
      })),
    };
    const index = workflowTemplates.findIndex((item) => item.id === entry.id);
    if (index >= 0) workflowTemplates[index] = entry;
    else workflowTemplates.unshift(entry);
  }
  notify();
}

/**
 * 拉一次后端能力清单并把自定义工作流注册进画布。
 * 幂等：重复调用共用同一个 Promise；失败只记日志（画布照常能用内置节点）。
 */
export function ensureLocalWorkflows(
  client: VideoWorkflowClient = window.__FISHERAI_VIDEO_WORKFLOWS__ ?? createVideoWorkflowClient(),
): Promise<LocalWorkflowDefinition[]> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const capabilities = await client.listCapabilities();
      definitions = capabilities
        .filter((item) => item?.template && typeof item.template === 'object')
        .map((item) => {
          const template = item.template as LocalWorkflowTemplatePayload;
          // v1.28：配图两种位置都认（能力清单顶层 / 模板骨架里），老 host 没有就是 undefined
          const coverUrl = item.coverUrl ?? template.coverUrl;
          return {
            ...template,
            id: item.workflowType,
            custom: true,
            ...(coverUrl ? { coverUrl } : {}),
          };
        });
      options = [
        ...definitions.map((item) => ({
          id: item.id,
          label: item.label,
          outputType: item.outputType,
          custom: true,
        })),
        // 内置的也列出来：本机装好了 MiniMax 节点包时，用户要能切回那个专用节点
        ...capabilities
          .filter((item) => !item?.template)
          .map((item) => ({
            id: item.workflowType,
            label: item.title,
            outputType: item.outputType,
            custom: false,
          })),
      ];
      registerTemplates();
    } catch (error) {
      console.warn('[aifisher-canvas] 拉取本地工作流清单失败（画布仍可用内置节点）', error);
      loadPromise = null;
    }
    return definitions;
  })();
  return loadPromise;
}

/** 测试/诊断用：忘掉已加载的清单与 Promise。 */
export function resetLocalWorkflows(): void {
  definitions = [];
  options = [];
  loadPromise = null;
  notify();
}

// ================================================================ ComfyUI 字段候选值（v1.20）

/**
 * ComfyUI 的 `/object_info` 里，每个节点每个输入都写着「能填什么」：
 *   LoraLoader.lora_name   → ["a.safetensors", "b.safetensors", …]
 *   KSampler.sampler_name  → ["euler", "dpmpp_2m", …]
 * 用户在 issue 里说的「想要切换个 lora 模型，但是要我输入文字，能否自动扫描我的 comfui
 * 做出列表让我选」就是这件事：把文本输入升级成下拉，候选来自这份扫描结果。
 *
 * 数据面在 host（src/host/comfyui/widgetOptions.ts）：它拉 /object_info、抽成小快照、
 * 落盘 + 5 分钟 TTL。这里只负责「拉一次 → 缓存 → 通知节点重渲染」。
 */
export interface ComfyWidgetField {
  control: 'select' | 'number' | 'text' | 'toggle';
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

export type ComfyWidgetClasses = Record<string, Record<string, ComfyWidgetField>>;

let widgetClasses: ComfyWidgetClasses = {};
let widgetPromise: Promise<void> | null = null;
const widgetListeners = new Set<() => void>();

function notifyWidgets(): void {
  for (const listener of [...widgetListeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[aifisher-canvas] ComfyUI 候选值订阅者出错', error);
    }
  }
}

/** 某个节点某个字段的候选值（没扫到就 null → 节点退回文本输入框）。 */
export function comfyWidgetField(
  classType: string | undefined,
  field: string | undefined,
): ComfyWidgetField | null {
  if (!classType || !field) return null;
  return widgetClasses[classType]?.[field] ?? null;
}

/** 候选值变化时回调（节点用来触发重渲染），返回取消订阅函数。 */
export function subscribeComfyWidgets(listener: () => void): () => void {
  widgetListeners.add(listener);
  return () => widgetListeners.delete(listener);
}

/**
 * 拉一次候选值快照。幂等（共用同一个 Promise），失败只记日志 ——
 * 下拉列表是增强，拉不到就还是文本输入框，不能因此让节点渲染不出来。
 */
export function ensureComfyWidgetOptions(force = false): Promise<void> {
  // 已经拿到过一份就别每建一个节点都再拉一次（快照本身有 5 分钟 TTL，要新的用 force）
  if (!force && Object.keys(widgetClasses).length) return Promise.resolve();
  if (widgetPromise) return widgetPromise;
  widgetPromise = (async () => {
    try {
      const response = await fetch(
        `/api/aifisher/canvas/comfy/widget-options${force ? '?refresh=1' : ''}`,
        { headers: { Accept: 'application/json' } },
      );
      const data = (await response.json()) as { classes?: ComfyWidgetClasses } | null;
      if (data && data.classes && typeof data.classes === 'object') {
        widgetClasses = data.classes;
        notifyWidgets();
      }
    } catch (error) {
      console.warn('[aifisher-canvas] 拉取 ComfyUI 字段候选值失败（参数仍是文本输入框）', error);
    } finally {
      widgetPromise = null;
    }
  })();
  return widgetPromise;
}

/** 测试/诊断用：忘掉候选值缓存。 */
export function resetComfyWidgetOptions(): void {
  widgetClasses = {};
  widgetPromise = null;
  notifyWidgets();
}

/**
 * 面板底栏「扫描 ComfyUI」会派发这个事件：装了新 lora 之后点一下，
 * 已经挂在画布上的节点也要重新拿一份候选（不用刷新页面）。
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('fisherai:comfy-widgets-refresh', () => {
    void ensureComfyWidgetOptions(true);
  });
}
