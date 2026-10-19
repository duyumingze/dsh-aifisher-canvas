/**
 * 目录式自定义工作流模板（host 半）
 *
 * 目的：让用户把自己在 ComfyUI 里导出的 **API 格式 JSON**（工作流菜单 → Export (API)）
 * 丢进 `$DSH_HOME/storages/dsh-aifisher-canvas/workflows/`，就自动变成画布上可选、可跑的
 * 工作流，**不依赖任何特定节点包**（内置的 minimax-h3-t2va 需要本机装 T8mars 那套低阶节点，
 * 没装就必然 COMFY_NODE_MISSING）。
 *
 * 零 wiring：本模块只被 workflowRegistry 惰性调用（listWorkflows / loadWorkflowTemplate），
 * comfyRouter 在查不到内置 handler 时回落到这里的通用 handler。
 * `src/host/index.ts` 一行都不用改，新能力自动生效。
 *
 * 目录约定：
 *   workflows/
 *     ├── 我的图生视频.json        每个 *.json = 一个工作流（ComfyUI API 格式的 prompt 图）
 *     ├── 我的图生视频.meta.json   可选侧车：标题 / 输出节点 / 参数绑定等，覆盖自动推断
 *     └── README.md               本模块自动写入的使用说明（给用户看的）
 *
 * 为什么扫描是「惰性 + 同步 readdirSync + TTL 缓存」：
 *   listWorkflows() 是同步 API，sendComfyCapabilities() 直接同步调它，所以这里不能改成异步；
 *   又不能每次请求都去 readdir（画布会反复拉能力清单），于是加一层 ~2 秒的 TTL 缓存。
 *   坏 JSON 只记一条诊断并跳过，绝不让整个能力清单崩掉。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { resolveDataDir } from '../canvas/dataDir';
import type { PromptGraph, PromptNode, ReferenceUploader } from './workflows/minimaxH3T2VA';
import { widgetFieldSpec } from './widgetOptions';

/** 输出类型：与 WorkflowMeta.outputType / 素材库目录名同一套。 */
export type CustomOutputType = 'videos' | 'images' | 'audios';

const OUTPUT_TYPES: ReadonlySet<string> = new Set(['videos', 'images', 'audios']);

/** 默认超时：视频 30 分钟，图片/音频 10 分钟（与内置工作流的量级一致）。 */
const VIDEO_TIMEOUT_MS = 30 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 10 * 60 * 1000;

/** 目录扫描的 TTL（可用 AIFISHER_COMFY_WORKFLOW_TTL_MS 覆盖，0 = 每次都重新扫，测试用）。 */
const DEFAULT_TTL_MS = 2000;

/** 提示词长度上限（与内置工作流一致：中文一个字 3 字节，16KB 的默认 body 上限不够用）。 */
const MAX_TEXT_LENGTH = 20_000;
const DEFAULT_CATEGORY = 'custom';
const README_FILE = 'README.md';

/** 绑定值的形状：单个位址（`6.inputs.text`）或一组位址（按数组下标逐个映射）。 */
export type BindingTarget = string | string[];

/** 一条模板层面的诊断（坏 JSON / meta 写错 / 绑定目标不存在…），挂到只读状态端点上给排查用。 */
export interface CustomWorkflowDiagnostic {
  /** 出问题的文件名（目录级问题为空串） */
  file: string;
  code: string;
  message: string;
}

/** 一个自定义工作流的完整元数据（都来自扫描 + meta 侧车）。 */
export interface CustomWorkflowEntry {
  /** `custom-<文件名 slug>` */
  id: string;
  title: string;
  category: string;
  outputType: CustomOutputType;
  modes: readonly string[];
  timeoutMs: number;
  /** 结果输出节点 id；探测不到时为空串（执行器会退化成「扫 history 里任意输出」） */
  outputNodeId: string;
  requiredInputs: readonly string[];
  /** 模板 JSON 的绝对路径 */
  templatePath: string;
  /** 文件名（诊断用） */
  file: string;
  promptNodeId: string | null;
  negativePromptNodeId: string | null;
  /**
   * 提示词真正的绑定位址（`70.inputs.value` / `6.inputs.text`）。
   * v1.20 起「提示词节点」可能只是个字符串生产者，提示词写在它的 `value` 字段上，
   * 所以单靠 promptNodeId 推不出位址 —— 面板与画布模板都以这个为准。
   */
  promptTarget: string | null;
  negativePromptTarget: string | null;
  /** 用户在 meta.json 里声明的绑定（原样，空对象表示没声明） */
  bindings: Readonly<Record<string, BindingTarget>>;
  /**
   * 用户在 meta.json 里显式关掉的绑定键（`"bindings": { "width": null }`）。
   *
   * 为什么需要这个第三态：`inferredBindings` 会自动推断 text/seed/steps/cfg/width/height/imageUrl，
   * 只写 `bindings` 只能「加」或「改」，没法表达「这条推断我不要」。而「ComfyUI 工作流配置」
   * 面板（画布左栏 → ComfyUI 工作流配置）要让用户取消勾选任意一条，包括推断出来的那些。
   */
  disabledBindings: readonly string[];
  /** 自动推断出来的绑定（只在用户没声明同名键时生效） */
  inferredBindings: Readonly<Record<string, BindingTarget>>;
  /** meta.defaults：请求没给这个参数时用这里的默认值 */
  defaults: Readonly<Record<string, unknown>>;
  /** meta.parameters：可选的参数控件声明（标签/控件类型/选项/上下限），覆盖自动推断 */
  parameterHints: Readonly<Record<string, CustomWorkflowParameterHint>>;
}

/** meta.parameters 里的一条：让用户自己决定某个绑定在画布节点上长什么样。 */
export interface CustomWorkflowParameterHint {
  label?: string;
  type?: 'text' | 'number' | 'toggle' | 'select';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

/** 参数归一化结果：路由层只关心 text/mode，组装时用 values/media。 */
export interface CustomWorkflowParams {
  mode: string;
  text?: string;
  /** 非素材类绑定：绑定键 → 原值（数字/布尔/字符串） */
  values: Record<string, unknown>;
  /** 素材类绑定：绑定键 → 待上传的 URL 列表 */
  media: Record<string, string[]>;
}

/**
 * 画布节点要用的「参数骨架」（节点长什么样、发什么请求）。
 *
 * 为什么由 host 算而不是画布自己猜：画布拿到的只有能力清单（id/标题/输出类型），
 * 而「这个工作流有哪些可填参数、哪些是素材入口、每个字段是数字还是文本」只有读过模板 JSON
 * 的 host 知道。把骨架放进 capabilities，画布就只是渲染，不用二次解析 ComfyUI 模板。
 *
 * 形状与 vendor 里 canvasNodeRules 的 WorkflowTemplate 对齐（inputs/parameters/outputs），
 * 这样能力清单到模板几乎是直接映射。
 */
export interface CustomWorkflowInputSlot {
  /** 绑定键，同时是请求体里的字段名 */
  id: string;
  label: string;
  /** text = 可接文本节点；image/video/audio/mask = 素材；any = 不挑 */
  type: 'text' | 'image' | 'video' | 'audio' | 'mask' | 'any';
  required: boolean;
}

export interface CustomWorkflowParameter {
  /** 绑定键，同时是请求体里的字段名 */
  id: string;
  label: string;
  type: 'text' | 'number' | 'toggle' | 'select';
  default?: unknown;
  options?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  /**
   * 这个参数在 ComfyUI 模板里落在哪个节点/字段（v1.20）。
   * 画布节点拿它去查 `GET /api/comfy/widget-options` —— 用户新装了 lora、
   * 或者能力清单是 ComfyUI 没开时拉的，节点也能自己补上下拉候选。
   */
  classType?: string;
  field?: string;
}

export interface CustomWorkflowTemplate {
  /** 模板标题（节点上显示的默认标题） */
  label: string;
  category: string;
  outputType: CustomOutputType;
  /** 提示词字段名（没找到可写提示词的节点时为 null）；v1.21 起它同时是一个 text 输入槽 */
  textParameter: string | null;
  /** 负向提示词字段名（可选）；v1.21 起也是一个 text 输入槽，不再算参数控件 */
  negativeTextParameter: string | null;
  /** 输入槽位（正向/负向提示词槽 + 素材槽），顺序 = 节点左边从上到下的连线顺序 */
  inputs: CustomWorkflowInputSlot[];
  outputs: Array<{ id: string; label: string; type: string }>;
  parameters: CustomWorkflowParameter[];
  /** 参数缺省值（画布节点初值用） */
  defaults: Record<string, unknown>;
}

/**
 * 自定义工作流的参数/模板错误。
 * 形状与 ComfyWorkflowError 一致（status + code），路由层统一按这两项透传给前端。
 * 单独一个类是为了避免 customWorkflows ↔ workflowRegistry 互相 import 成环
 * （workflowRegistry 要 import 本模块拿清单）。
 */
export class CustomWorkflowError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'INVALID_COMFY_WORKFLOW') {
    super(message);
    this.name = 'CustomWorkflowError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- 目录（v1.18 起可自定义）

/** 目录设置文件名（与 canvas.json 同级放在插件数据目录下）。 */
const DIR_SETTING_FILE = 'workflow-dir.json';

/** 插件数据根（v1.43 起可由「设置 → 存储 → 项目数据目录」改，见 canvas/dataDir.ts）。 */
function storageRoot(): string {
  return resolveDataDir();
}

/** 默认目录：$DSH_HOME/storages/dsh-aifisher-canvas/workflows。 */
export function defaultCustomWorkflowsDir(): string {
  return join(storageRoot(), 'workflows');
}

/** 目录设置文件：`{ "version": 1, "dir": "D:\\ComfyUI\\我的工作流" }`，dir=null 表示用默认目录。 */
export function customWorkflowsDirSettingPath(): string {
  return join(storageRoot(), DIR_SETTING_FILE);
}

/**
 * 读设置（进程内缓存，`invalidateCustomWorkflows()` 会一起丢弃）。
 * 文件坏了就当没配 → 退回默认目录：这是「面板打不开」和「目录读不了」之间唯一合理的选择。
 */
let dirSettingCache: { dir: string | null } | null = null;

function readDirSetting(): string | null {
  if (dirSettingCache) return dirSettingCache.dir;
  let dir: string | null = null;
  try {
    const path = customWorkflowsDirSettingPath();
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isRecord(parsed) && typeof parsed.dir === 'string' && parsed.dir.trim()) {
        dir = parsed.dir.trim();
      }
    }
  } catch {
    dir = null;
  }
  dirSettingCache = { dir };
  return dir;
}

/** 生效的目录：设置里的那个优先，否则默认目录（$DSH_HOME/.../workflows）。 */
export function customWorkflowsDir(): string {
  return readDirSetting() ?? defaultCustomWorkflowsDir();
}

/** 目录状态（面板底栏 / `GET /api/comfy/workflow-config-dir` 用）。 */
export interface CustomWorkflowsDirState {
  ok: true;
  /** 当前生效目录 */
  dir: string;
  /** 默认目录（面板上「恢复默认」回到这里） */
  defaultDir: string;
  /** 当前是用户自定义的（false = 默认目录） */
  isCustom: boolean;
  exists: boolean;
  settingFile: string;
  /** 本次操作新建了目录（面板提示「目录已创建」用） */
  created: boolean;
}

function dirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function customWorkflowsDirState(options: { created?: boolean } = {}): CustomWorkflowsDirState {
  const dir = customWorkflowsDir();
  return {
    ok: true,
    dir,
    defaultDir: defaultCustomWorkflowsDir(),
    isCustom: readDirSetting() !== null,
    exists: dirExists(dir),
    settingFile: customWorkflowsDirSettingPath(),
    created: options.created === true,
  };
}

/** 两个绝对路径是不是同一个（Windows 大小写不敏感）。 */
function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * 改自定义工作流目录。
 *   请求体 `{ dir: "D:\\ComfyUI\\我的工作流" }`   → 改成它（不存在时父目录在就自动建）
 *   请求体 `{ dir: null }` / `{ dir: "" }` / `{ reset: true }` → 恢复默认目录
 *
 * 写盘位置是 storages 下的 workflow-dir.json，不是被选目录本身 —— 于是「把目录指到
 * 别处（甚至别的盘上的 ComfyUI 导出目录）」不依赖当前目录还能不能读。
 */
export function setCustomWorkflowsDir(input: unknown): CustomWorkflowsDirState {
  const body = isRecord(input) ? input : {};
  const raw = typeof body.dir === 'string' ? body.dir.trim() : '';
  const wantsReset = body.reset === true || raw === '' || body.dir === null;

  let target = defaultCustomWorkflowsDir();
  let created = false;

  if (!wantsReset) {
    // 用户从资源管理器复制来的路径常带引号，先脱掉；再要求必须是绝对路径
    let text = raw;
    if (
      (text.startsWith('"') && text.endsWith('"') && text.length > 1) ||
      (text.startsWith("'") && text.endsWith("'") && text.length > 1)
    ) {
      text = text.slice(1, -1).trim();
    }
    if (!text) {
      throw new CustomWorkflowError('目录不能是空字符串。', 422, 'WORKFLOW_DIR_EMPTY');
    }
    if (!isAbsolute(text)) {
      throw new CustomWorkflowError(
        `工作流目录必须是绝对路径（如 D:\\ComfyUI\\我的工作流），收到的是：${text}`,
        422,
        'WORKFLOW_DIR_NOT_ABSOLUTE',
      );
    }
    target = resolve(text);
    if (existsSync(target) && !dirExists(target)) {
      // 存在但不是目录（同名文件）
      throw new CustomWorkflowError(
        `这个路径是个文件，不是目录：${target}`,
        422,
        'WORKFLOW_DIR_NOT_DIRECTORY',
      );
    }
    if (!dirExists(target)) {
      const parent = dirname(target);
      if (!existsSync(parent)) {
        throw new CustomWorkflowError(
          `目录不存在，它的上一级也不存在：${parent}。先把上级目录建好，或把路径写对再试。`,
          422,
          'WORKFLOW_DIR_PARENT_MISSING',
        );
      }
      try {
        mkdirSync(target, { recursive: true });
        created = true;
      } catch (error) {
        throw new CustomWorkflowError(
          `建不了目录：${target}（${messageOf(error)}）`,
          422,
          'WORKFLOW_DIR_CREATE_FAILED',
        );
      }
    }
  }

  // 指回默认目录就等于「没自定义」——设置文件里存 null，面板上显示为默认
  const useCustom = !wantsReset && !samePath(target, defaultCustomWorkflowsDir());
  const dir = useCustom ? target : null;
  const settingPath = customWorkflowsDirSettingPath();
  try {
    mkdirSync(dirname(settingPath), { recursive: true });
    const temp = `${settingPath}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, dir }, null, 2)}\n`, 'utf8');
    renameSync(temp, settingPath);
  } catch (error) {
    throw new CustomWorkflowError(
      `保存目录设置失败：${settingPath}（${messageOf(error)}）`,
      500,
      'WORKFLOW_DIR_SAVE_FAILED',
    );
  }
  // 立刻生效：设置缓存与扫描缓存一起丢掉，下一次 listCustomWorkflows() 就扫新目录
  dirSettingCache = { dir };
  invalidateCustomWorkflows();
  return customWorkflowsDirState({ created });
}

// ---------------------------------------------------------------- 小工具

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ComfyUI API 格式里的连线：[来源节点 id, 输出序号]。 */
function isLink(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number'
  );
}

/** 一份 prompt 图的最小判定：里面确实有带 class_type 的节点。 */
function looksLikeGraph(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (!keys.length) return false;
  const nodes = keys.filter((key) => {
    const node = value[key];
    return isRecord(node) && typeof node.class_type === 'string';
  });
  // 允许少量非节点键（比如手写文件里混了注释/extra），但绝大多数键必须是节点
  return nodes.length > 0 && nodes.length >= keys.length * 0.8;
}

/**
 * 把任意 JSON 认成 prompt 图。
 * 兼容两种「手滑」写法：直接存了 /prompt 的请求体（`{ prompt: {...} }`）或 `{ workflow: {...} }`。
 */
export function asPromptGraph(value: unknown): PromptGraph | null {
  if (!isRecord(value)) return null;
  for (const key of ['prompt', 'workflow'] as const) {
    const inner = value[key];
    if (isRecord(inner) && looksLikeGraph(inner)) return inner as PromptGraph;
  }
  return looksLikeGraph(value) ? (value as PromptGraph) : null;
}

/** 节点 id 按数值序排（ComfyUI 的 id 基本是数字；非数字的排前面，保证顺序稳定）。 */
export function sortedGraphNodeIds(graph: PromptGraph): string[] {
  return Object.keys(graph)
    .filter((id) => graph[id] && typeof graph[id]?.class_type === 'string')
    .sort((left, right) => {
      const a = Number(left);
      const b = Number(right);
      const aNum = Number.isFinite(a);
      const bNum = Number.isFinite(b);
      if (aNum && bNum) return a - b;
      if (aNum) return -1;
      if (bNum) return 1;
      return left.localeCompare(right);
    });
}

/** 文件名 → id 里那段 slug（保留中文，其余非字母数字压成 -）。 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) return slug;
  // 全是符号的文件名：给一个稳定的短哈希，别产生空 id
  return `wf-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
}

// ---------------------------------------------------------------- 模板读取

/** 读 + 解析一份模板 JSON，返回全新的 prompt 图（组装会就地改写，绝不共用实例）。 */
function readTemplateGraph(filePath: string): PromptGraph {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new CustomWorkflowError(
      `读不到工作流模板：${filePath}（${messageOf(error)}）`,
      500,
      'TEMPLATE_MISSING',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CustomWorkflowError(
      `工作流模板不是合法 JSON：${basename(filePath)}（${messageOf(error)}）`,
      500,
      'TEMPLATE_INVALID',
    );
  }
  const graph = asPromptGraph(parsed);
  if (!graph) {
    throw new CustomWorkflowError(
      `工作流模板里没有节点：${basename(filePath)}。` +
        '请用 ComfyUI 的「工作流菜单 → Export (API)」导出（不是 Save/Export 那份 UI 格式）。',
      500,
      'TEMPLATE_INVALID',
    );
  }
  return graph;
}

// ---------------------------------------------------------------- 自动推断

/** 输出节点规则：数组越靠前优先级越高（多条命中时取优先级最高的那个节点）。 */
const OUTPUT_RULES: ReadonlyArray<{ pattern: RegExp; outputType: CustomOutputType }> = [
  { pattern: /^VHS_VideoCombine$/, outputType: 'videos' },
  { pattern: /^SaveWEBM$/, outputType: 'videos' },
  { pattern: /^SaveVideo/, outputType: 'videos' },
  { pattern: /^SaveAnimatedWEBP$/, outputType: 'images' },
  { pattern: /^SaveImage/, outputType: 'images' },
  { pattern: /^PreviewImage$/, outputType: 'images' },
  { pattern: /^SaveAudio/, outputType: 'audios' },
  { pattern: /^PreviewAudio$/, outputType: 'audios' },
];

/**
 * 一个节点算哪类输出。
 * VHS_VideoCombine 既能存视频也能只存音频（format 以 audio 开头，例如 audio/mp3），
 * 所以它先单独判一刀，再走通用规则表。
 */
function nodeOutputKind(node: PromptNode): CustomOutputType | null {
  const classType = node.class_type ?? '';
  if (classType === 'VHS_VideoCombine') {
    const format = node.inputs?.format;
    if (typeof format === 'string' && /^audio/i.test(format.trim())) return 'audios';
  }
  for (const rule of OUTPUT_RULES) if (rule.pattern.test(classType)) return rule.outputType;
  return null;
}

/** 节点在规则表里的优先级（数值越小越优先）。 */
function outputRank(node: PromptNode): number {
  const classType = node.class_type ?? '';
  const index = OUTPUT_RULES.findIndex((rule) => rule.pattern.test(classType));
  return index >= 0 ? index : OUTPUT_RULES.length;
}

/** 「negative」味道的节点不该被当成正向提示词节点（标题/类名都看）。 */
const NEGATIVE_HINT = /negative|neg_|负面|负向|反向|不想要/i;

/** 文本节点打分：CLIPTextEncode 最正，其次类名里带 text/prompt 的。 */
function textNodeScore(classType: string): number {
  if (/CLIPTextEncode/i.test(classType)) return 0;
  if (/text|prompt/i.test(classType)) return 1;
  return 2;
}

/**
 * 字符串生产者节点：rgthree / ComfyUI 核心里的 PrimitiveString*、String Literal、
 * Textbox、字符串拼接这类节点。它们的输出是 TEXT，被 CLIPTextEncode.text 连线喂进去，
 * 于是「提示词写在哪儿」这个问题从「找 CLIPTextEncode」变成「往上游找字符串节点」。
 *
 * 排除文本编码器本身（CLIPTextEncode 类名里也有 Text）：那是消费者不是生产者。
 */
function isStringProducer(classType: string): boolean {
  if (!/primitive|string|concat|literal|textbox/i.test(classType)) return false;
  return !/clip|encode|sampler|lora|checkpoint|vae|image|audio|video|save|load/i.test(classType);
}

/** 一个节点上「写死的字符串」落在哪个字段（按常见命名优先，最后退到第一个字符串输入）。 */
const STRING_VALUE_FIELDS = ['value', 'text', 'string', 'text_a', 'text_b', 'prompt'] as const;

function primaryStringField(node: PromptNode | undefined): string | null {
  const inputs = node?.inputs;
  if (!inputs) return null;
  for (const field of STRING_VALUE_FIELDS) {
    if (typeof inputs[field] === 'string' && !isLink(inputs[field])) return field;
  }
  for (const [field, value] of Object.entries(inputs)) {
    if (typeof value === 'string' && !isLink(value)) return field;
  }
  return null;
}

/** 提示词真正的落点：`节点 id + 字段名`（v1.20 起可能是上游字符串节点的 `value` 而不是 `text`）。 */
export interface TextTarget {
  nodeId: string;
  field: string;
  /** 从消费者一路走过来的节点 id（含两端），负向判断时要把它们的标题/类名都看一眼 */
  via: string[];
}

/**
 * 沿 `text` 输入往上游找「写死的字符串」：
 *   - 这个字段本来就是字符串 → 就是它（老形状：CLIPTextEncode.text = "一只猫"）；
 *   - 字段是连线 [id, slot] → 上游是字符串生产者（PrimitiveString* 等）→ 用它的字符串字段。
 * 最多走 3 跳（Primitive → Concat → CLIPTextEncode 这种也够用）。
 */
function resolveTextTarget(
  graph: PromptGraph,
  nodeId: string,
  field: string,
  depth = 0,
): TextTarget | null {
  const node = graph[nodeId];
  const value = node?.inputs?.[field];
  if (typeof value === 'string') return { nodeId, field, via: [nodeId] };
  if (!isLink(value) || depth >= 3) return null;
  const up = graph[value[0]];
  if (!up || !isStringProducer(up.class_type ?? '')) return null;
  const upField = primaryStringField(up);
  if (!upField) return null;
  const resolved = resolveTextTarget(graph, value[0], upField, depth + 1);
  return resolved ? { ...resolved, via: [nodeId, ...resolved.via] } : null;
}

/** 一个节点（含它下游的消费者）是不是「负向」味道：标题和类名都看。 */
function looksNegative(graph: PromptGraph, target: TextTarget): boolean {
  for (const nodeId of target.via) {
    const node = graph[nodeId];
    const title = String(node?._meta?.title ?? '');
    const classType = node?.class_type ?? '';
    if (NEGATIVE_HINT.test(title) || NEGATIVE_HINT.test(classType)) return true;
  }
  return false;
}

/**
 * 找提示词的落点（正向 / 负向各一个）。
 *
 * 两条路径都认：
 *   ① **消费者路径**（主流）：节点有 `text` 输入 → 写死字符串就是它，被连线喂就往上游找
 *      字符串节点。打分看消费者类名（CLIPTextEncode = 0 分最优先）；
 *   ② **生产者兜底**：没找到任何消费者时，把「写死字符串的字符串生产者」本身当候选
 *      （有的工作流把 PrimitiveString 直接当输入用）。
 *
 * v1.20 修的就是 ①：以前只找「自己有写死 text 的节点」，用户这种
 * `PrimitiveStringMultiline(value="正面提示词") → CLIPTextEncode.text` 的接法里
 * 两个字符串节点的字段叫 `value` 不叫 `text`，于是整份工作流被判成「不需要提示词」。
 */
function findTextTargets(graph: PromptGraph): { positive: TextTarget | null; negative: TextTarget | null } {
  interface Candidate {
    target: TextTarget;
    score: number;
    negative: boolean;
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (target: TextTarget, score: number) => {
    const id = `${target.nodeId}.inputs.${target.field}`;
    if (seen.has(id)) return;
    seen.add(id);
    candidates.push({ target, score, negative: looksNegative(graph, target) });
  };

  for (const nodeId of sortedGraphNodeIds(graph)) {
    const node = graph[nodeId];
    const inputs = node.inputs ?? {};
    // ① 消费者：这个节点有 text 输入（写死，或被字符串节点喂）
    if ('text' in inputs) {
      const target = resolveTextTarget(graph, nodeId, 'text');
      if (target) add(target, textNodeScore(node.class_type ?? ''));
    }
    // ② 生产者兜底：字符串节点自己的写死值（分数更低，只有 ① 全空时才配被选上）
    if (isStringProducer(node.class_type ?? '')) {
      const field = primaryStringField(node);
      if (field) add({ nodeId, field, via: [nodeId] }, 3);
    }
  }

  const best = (list: readonly Candidate[]): TextTarget | null => {
    if (!list.length) return null;
    // sort 稳定：同分保持原顺序（= 节点 id 升序），与旧行为一致
    return [...list].sort((left, right) => left.score - right.score)[0].target;
  };
  const negatives = candidates.filter((item) => item.negative);
  const positives = candidates.filter((item) => !item.negative);
  const positive = best(positives.length ? positives : candidates);
  const negative = best(
    negatives.filter((item) => `${item.target.nodeId}.inputs.${item.target.field}` !==
      (positive ? `${positive.nodeId}.inputs.${positive.field}` : '')),
  );
  return { positive, negative };
}

/** 模板里「写死了文件名」的 LoadImage 节点（这类节点就是要用户喂图的入口）。 */
function loadImageNodes(graph: PromptGraph): string[] {
  return sortedGraphNodeIds(graph).filter((id) => {
    const node = graph[id];
    return (
      /^LoadImage$/i.test(node.class_type ?? '') &&
      typeof node.inputs?.image === 'string' &&
      !isLink(node.inputs?.image)
    );
  });
}

/** 自动绑定的常见采样参数 → 候选字段名（按顺序找）。 */
const AUTO_FIELDS: ReadonlyArray<{ param: string; fields: readonly string[] }> = [
  { param: 'seed', fields: ['seed', 'noise_seed'] },
  { param: 'steps', fields: ['steps'] },
  { param: 'cfg', fields: ['cfg'] },
  { param: 'width', fields: ['width'] },
  { param: 'height', fields: ['height'] },
  { param: 'duration', fields: ['duration'] },
];

/**
 * 全图唯一命中时才算「这个参数就是给它的」。
 * 只认写死在模板里的数字（被连线喂的字段不能覆盖，否则会把上游节点的输入顶掉）。
 */
function uniqueFieldTarget(graph: PromptGraph, fields: readonly string[]): string | null {
  const hits: string[] = [];
  for (const id of sortedGraphNodeIds(graph)) {
    const inputs = graph[id].inputs ?? {};
    for (const field of fields) {
      const value = inputs[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        hits.push(`${id}.inputs.${field}`);
        break;
      }
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

interface Inference {
  outputNodeId: string;
  outputType: CustomOutputType | null;
  promptNodeId: string | null;
  negativePromptNodeId: string | null;
  /** 提示词真正的落点（可能是上游字符串节点的 value 字段） */
  promptTarget: TextTarget | null;
  negativePromptTarget: TextTarget | null;
  /** 全部文本落点候选（meta.promptNode 覆盖时用来找对应字段） */
  textTargets: readonly TextTarget[];
  requiredInputs: string[];
  inferredBindings: Record<string, BindingTarget>;
}

/** 从 prompt 图里推断：输出节点/类型、提示词节点、必填输入、可自动绑定的参数。 */
function infer(graph: PromptGraph): Inference {
  const ids = sortedGraphNodeIds(graph);

  let outputNodeId = '';
  let outputType: CustomOutputType | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const kind = nodeOutputKind(graph[id]);
    if (!kind) continue;
    const rank = outputRank(graph[id]);
    if (rank < bestRank) {
      bestRank = rank;
      outputNodeId = id;
      outputType = kind;
    }
  }

  const { positive, negative } = findTextTargets(graph);
  const images = loadImageNodes(graph);

  const inferredBindings: Record<string, BindingTarget> = {};
  if (positive) inferredBindings.text = `${positive.nodeId}.inputs.${positive.field}`;
  if (negative) inferredBindings.negativeText = `${negative.nodeId}.inputs.${negative.field}`;
  // 只有一个图片入口时，「imageUrl」默认就是给它（多图入口需要用户用 meta 写清楚）
  if (images.length === 1) inferredBindings.imageUrl = `${images[0]}.inputs.image`;
  for (const { param, fields } of AUTO_FIELDS) {
    const target = uniqueFieldTarget(graph, fields);
    if (target) inferredBindings[param] = target;
  }

  const requiredInputs: string[] = [];
  if (positive) requiredInputs.push('text');
  if (images.length) requiredInputs.push('image');

  return {
    outputNodeId,
    outputType,
    promptNodeId: positive?.nodeId ?? null,
    negativePromptNodeId: negative?.nodeId ?? null,
    promptTarget: positive,
    negativePromptTarget: negative,
    textTargets: [positive, negative].filter((item): item is TextTarget => item !== null),
    requiredInputs,
    inferredBindings,
  };
}

// ---------------------------------------------------------------- meta 侧车

/** 参数别名：绑定键 → 请求体里也能接受的字段名（兼容画布上游的几种写法）。 */
const PARAM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  text: ['prompt'],
  imageUrl: ['image', 'image_url', 'firstFrameUrl', 'lastFrameUrl', 'sourceImageUrl'],
  negativeText: ['negativePrompt', 'negative_text'],
};

/** 按绑定键从请求体里取值（含别名）。空串/undefined/null 都当没给。 */
function pickParam(raw: Record<string, unknown>, key: string): unknown {
  const direct = raw[key];
  if (direct !== undefined && direct !== null && direct !== '') return direct;
  for (const alias of PARAM_ALIASES[key] ?? []) {
    const value = raw[alias];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  // 参考图列表只在 imageUrl 的语义上兜底：取第一张
  if (key === 'imageUrl' && Array.isArray(raw.referenceImageUrls) && raw.referenceImageUrls.length) {
    return raw.referenceImageUrls[0];
  }
  return undefined;
}

/** 素材类绑定键：以 Url/Urls 结尾，或是这几个一眼就是素材的字段名。 */
const MEDIA_KEYS: ReadonlySet<string> = new Set([
  'image',
  'mask',
  'video',
  'audio',
  'firstFrame',
  'lastFrame',
  'referenceImage',
  'referenceVideo',
  'referenceAudio',
]);

function isMediaBindingKey(key: string): boolean {
  return /urls?$/i.test(key) || MEDIA_KEYS.has(key);
}

/** 素材 URL 列表：去空、去非字符串。 */
function normalizeUrlList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
}

/** 把一个绑定位址拆成「节点 id + 字段名」：`6.inputs.text` / `307.inputs.ref_images.ref_image_0`。 */
export function parseBindingTarget(target: string): { nodeId: string; field: string } | null {
  const match = /^([^.\s]+)\.inputs\.(.+)$/.exec(target.trim());
  if (!match) return null;
  return { nodeId: match[1], field: match[2] };
}

// ---------------------------------------------------------------- 扫描与缓存

interface ScanResult {
  dir: string;
  entries: CustomWorkflowEntry[];
  errors: CustomWorkflowDiagnostic[];
}

let cache: { at: number; result: ScanResult } | null = null;
/** 上一次扫描的报错指纹：只有报错集合变了才打日志，免得每 2 秒刷一次。 */
let lastErrorSignature = '';

function ttlMs(): number {
  const raw = Number(process.env.AIFISHER_COMFY_WORKFLOW_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * 目录不存在就建，并补一份 README.md（写不进去只记诊断，不影响其它能力）。
 *
 * `writeReadme` 只在**默认目录**下为 true：用户自己指过来的目录（v1.18 可自定义）只读不写 ——
 * 不然把目录指到 ComfyUI 的导出目录里，会莫名其妙多一个 README.md。
 */
function ensureDir(dir: string, errors: CustomWorkflowDiagnostic[], writeReadme = true): void {
  try {
    mkdirSync(dir, { recursive: true });
    if (!writeReadme) return;
    const readmePath = join(dir, README_FILE);
    if (!existsSync(readmePath)) writeFileSync(readmePath, README_CONTENT, 'utf8');
  } catch (error) {
    errors.push({
      file: '',
      code: 'WORKFLOW_DIR_UNAVAILABLE',
      message: `自定义工作流目录不可用：${dir}（${messageOf(error)}）`,
    });
  }
}

/** 侧车文件名：`foo.json` → `foo.meta.json`。 */
function metaFileNameOf(file: string): string {
  return `${basename(file, extname(file))}.meta.json`;
}

interface MetaRead {
  values: Record<string, unknown>;
  /** 记诊断时归属的文件名：有 meta 文件就写 meta 文件名（用户要改的是它） */
  source: string;
}

function readMetaFile(dir: string, file: string, errors: CustomWorkflowDiagnostic[]): MetaRead {
  const metaName = metaFileNameOf(file);
  const metaPath = join(dir, metaName);
  if (!existsSync(metaPath)) return { values: {}, source: file };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (error) {
    errors.push({ file: metaName, code: 'META_INVALID', message: `meta.json 不是合法 JSON：${messageOf(error)}` });
    return { values: {}, source: metaName };
  }
  if (!isRecord(parsed)) {
    errors.push({ file: metaName, code: 'META_INVALID', message: 'meta.json 的最外层必须是一个对象。' });
    return { values: {}, source: metaName };
  }
  return { values: parsed, source: metaName };
}

/**
 * 归一化 meta.bindings：值必须是 `节点id.inputs.字段` 字符串或这类字符串的数组；
 * `null` 是**显式关闭**（把自动推断出来的同名绑定摘掉），收进 disabled。
 */
function normalizeBindings(
  value: unknown,
  file: string,
  errors: CustomWorkflowDiagnostic[],
): { bindings: Record<string, BindingTarget>; disabled: string[] } {
  const empty: { bindings: Record<string, BindingTarget>; disabled: string[] } = {
    bindings: {},
    disabled: [],
  };
  if (value === undefined) return empty;
  if (!isRecord(value)) {
    errors.push({ file, code: 'META_INVALID', message: 'meta.bindings 必须是一个对象（如 {"text": "6.inputs.text"}）。' });
    return empty;
  }
  const bindings: Record<string, BindingTarget> = {};
  const disabled: string[] = [];
  for (const [key, target] of Object.entries(value)) {
    if (target === null) {
      disabled.push(key);
      continue;
    }
    if (typeof target === 'string' && target.trim()) {
      bindings[key] = target.trim();
      continue;
    }
    if (Array.isArray(target)) {
      const list = target.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
      if (list.length) {
        bindings[key] = list.map((item) => item.trim());
        continue;
      }
    }
    errors.push({
      file,
      code: 'META_INVALID',
      message: `meta.bindings.${key} 写法不对：应为 "节点id.inputs.字段"（或这种字符串的数组，或 null 表示关闭自动推断）。`,
    });
  }
  return { bindings, disabled };
}

/**
 * 解析一个 meta 里的节点 id 覆盖。
 *   undefined → 用推断值
 *   null / ''  → 显式关掉（不再要求这个输入）
 *   其它字符串 → 必须真实存在，否则记诊断并退回推断值
 */
function resolveNodeOverride(
  metaValue: unknown,
  inferred: string | null,
  graph: PromptGraph,
  key: string,
  file: string,
  errors: CustomWorkflowDiagnostic[],
): string | null {
  if (metaValue === undefined) return inferred;
  if (metaValue === null || metaValue === '') return null;
  const id = String(metaValue).trim();
  if (graph[id] && typeof graph[id]?.class_type === 'string') return id;
  errors.push({
    file,
    code: 'META_INVALID',
    message: `meta.${key}=${id} 在模板里找不到这个节点，已退回自动推断。`,
  });
  return inferred;
}

/**
 * 解析 meta.parameters：两种写法都认
 *   { "steps": { "label": "步数", "type": "number", "min": 1, "max": 60 } }
 *   { "steps": "步数" }                      （只给标签，控件类型照推断）
 * 坏条目只记诊断并跳过，不影响工作流本身能不能跑。
 */
function normalizeParameterHints(
  value: unknown,
  file: string,
  errors: CustomWorkflowDiagnostic[],
): Record<string, CustomWorkflowParameterHint> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push({
      file,
      code: 'META_INVALID',
      message: 'meta.parameters 必须是一个对象（如 {"steps": {"label": "步数", "type": "number"}}）。',
    });
    return {};
  }
  const result: Record<string, CustomWorkflowParameterHint> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' && raw.trim()) {
      result[key] = { label: raw.trim() };
      continue;
    }
    if (!isRecord(raw)) {
      errors.push({ file, code: 'META_INVALID', message: `meta.parameters.${key} 写法不对（应为字符串或对象）。` });
      continue;
    }
    const hint: CustomWorkflowParameterHint = {};
    if (typeof raw.label === 'string' && raw.label.trim()) hint.label = raw.label.trim();
    if (raw.type !== undefined) {
      const type = String(raw.type).toLowerCase();
      if (type === 'text' || type === 'number' || type === 'toggle' || type === 'select') {
        hint.type = type;
      } else {
        errors.push({
          file,
          code: 'META_INVALID',
          message: `meta.parameters.${key}.type 只能是 text/number/toggle/select，收到 ${JSON.stringify(raw.type)}。`,
        });
      }
    }
    if (Array.isArray(raw.options)) {
      const options = raw.options
        .map((option) =>
          isRecord(option) && option.value !== undefined
            ? { value: String(option.value), label: String(option.label ?? option.value) }
            : null,
        )
        .filter((option): option is { value: string; label: string } => option !== null);
      if (options.length) hint.options = options;
    }
    for (const field of ['min', 'max', 'step'] as const) {
      const number = Number(raw[field]);
      if (raw[field] !== undefined && Number.isFinite(number)) hint[field] = number;
    }
    result[key] = hint;
  }
  return result;
}

/**
 * 把「绑到同一个提示词位址」的别名键并进约定的 `text` / `negativeText`。
 *
 * 场景：v1.20 之前用户手写 meta 时，面板建议的键就是字段名本身 ——
 * `"value": "70.inputs.value"`、`"value2": "72.inputs.value"`。现在推断已经认得出
 * 这两个字符串节点就是正/负向提示词，如果不合并，画布节点上会同时出现
 * 「提示词」大输入框（来自 text 绑定）和「正面提示词」小参数（来自 value 绑定），
 * 看起来像两个都能填的提示词。合并规则：
 *   - 只并「单个位址且正好等于提示词位址」的键，数组/多目标绑定一律不动；
 *   - 用户显式关掉 text / negativeText（bindings.text = null）时不并 —— 那是明确的意图；
 *   - 别名键上的中文标签搬到 text / negativeText 上（用户起的名字要留着）。
 */
function mergeTextAliases(
  bindings: Record<string, BindingTarget>,
  inferred: Record<string, BindingTarget>,
  disabled: readonly string[],
  hints: Record<string, CustomWorkflowParameterHint>,
  canonicalKey: 'text' | 'negativeText',
  target: string | null,
): void {
  if (!target || disabled.includes(canonicalKey)) return;
  const current = bindings[canonicalKey] ?? inferred[canonicalKey];
  const first = Array.isArray(current) ? current[0] : current;
  if (first !== target) return;
  for (const map of [bindings, inferred]) {
    for (const key of Object.keys(map)) {
      if (key === canonicalKey) continue;
      const value = map[key];
      const list = Array.isArray(value) ? value : [value];
      if (list.length !== 1 || list[0] !== target) continue;
      delete map[key];
      const hint = hints[key];
      if (hint && !hints[canonicalKey]) hints[canonicalKey] = hint;
      delete hints[key];
    }
  }
}

function buildEntry(
  dir: string,
  file: string,
  errors: CustomWorkflowDiagnostic[],
): CustomWorkflowEntry {
  const templatePath = join(dir, file);
  const id = `custom-${slugify(basename(file, extname(file)))}`;
  const graph = readTemplateGraph(templatePath);
  const inference = infer(graph);
  const { values: meta, source: metaSource } = readMetaFile(dir, file, errors);

  // ---- 标题/分组 ----
  const title =
    typeof meta.title === 'string' && meta.title.trim()
      ? meta.title.trim()
      : basename(file, extname(file));
  const category =
    typeof meta.category === 'string' && meta.category.trim()
      ? meta.category.trim()
      : DEFAULT_CATEGORY;

  // ---- 输出节点与输出类型 ----
  const outputNodeId =
    resolveNodeOverride(meta.outputNodeId, inference.outputNodeId || null, graph, 'outputNodeId', metaSource, errors) ??
    '';
  let outputType = inference.outputType;
  if (meta.outputType !== undefined) {
    if (typeof meta.outputType === 'string' && OUTPUT_TYPES.has(meta.outputType)) {
      outputType = meta.outputType as CustomOutputType;
    } else {
      errors.push({
        file: metaSource,
        code: 'META_INVALID',
        message: `meta.outputType 只能是 videos/images/audios 之一，收到 ${JSON.stringify(meta.outputType)}。`,
      });
    }
  }
  if (!outputType) {
    errors.push({
      file,
      code: 'OUTPUT_NODE_UNDETECTED',
      message:
        '没能从模板里认出输出节点（VHS_VideoCombine / SaveWEBM / SaveVideo / SaveImage / SaveAudio…），' +
        '先按 videos 处理；请在 meta.json 里写明 outputNodeId 与 outputType。',
    });
    outputType = 'videos';
  }

  // ---- 提示词节点（meta 覆盖后要重算 text 绑定） ----
  const promptNodeId = resolveNodeOverride(
    meta.promptNode ?? meta.promptNodeId,
    inference.promptNodeId,
    graph,
    'promptNode',
    metaSource,
    errors,
  );
  const negativePromptNodeId = resolveNodeOverride(
    meta.negativePromptNode ?? meta.negativePromptNodeId,
    inference.negativePromptNodeId,
    graph,
    'negativePromptNode',
    metaSource,
    errors,
  );

  /** 一个「提示词节点」→ 真正该写值的位址（字符串生产者的 value / 编码器的 text，必要时往上游追）。 */
  const textTargetForNode = (nodeId: string | null): string | null => {
    if (!nodeId) return null;
    const hit = inference.textTargets.find((item) => item.nodeId === nodeId);
    if (hit) return `${hit.nodeId}.inputs.${hit.field}`;
    if (graph[nodeId] && 'text' in (graph[nodeId].inputs ?? {})) {
      const resolved = resolveTextTarget(graph, nodeId, 'text');
      if (resolved) return `${resolved.nodeId}.inputs.${resolved.field}`;
    }
    const field = primaryStringField(graph[nodeId]);
    return field ? `${nodeId}.inputs.${field}` : `${nodeId}.inputs.text`;
  };
  const promptTarget = textTargetForNode(promptNodeId);
  const negativePromptTarget = textTargetForNode(negativePromptNodeId);

  const declared = normalizeBindings(meta.bindings, metaSource, errors);
  const bindings = declared.bindings;
  const disabledBindings = declared.disabled;
  const inferredBindings: Record<string, BindingTarget> = { ...inference.inferredBindings };
  if (promptTarget) inferredBindings.text = promptTarget;
  else delete inferredBindings.text;
  if (negativePromptTarget) inferredBindings.negativeText = negativePromptTarget;
  else delete inferredBindings.negativeText;

  const defaults = isRecord(meta.defaults) ? meta.defaults : {};
  const parameterHints = normalizeParameterHints(meta.parameters, metaSource, errors);

  // 老 meta 里把提示词绑在自己起的名字上（比如 "value": "70.inputs.value"）：
  // 推断已经认出这就是提示词，于是把那条别名并进约定的 text / negativeText ——
  // 否则画布节点会同时冒出「提示词」大框和「正面提示词」重复参数。
  mergeTextAliases(bindings, inferredBindings, disabledBindings, parameterHints, 'text', promptTarget);
  mergeTextAliases(
    bindings,
    inferredBindings,
    disabledBindings,
    parameterHints,
    'negativeText',
    negativePromptTarget,
  );

  // ---- 必填输入 ----
  let requiredInputs: string[];
  if (Array.isArray(meta.requiredInputs)) {
    requiredInputs = meta.requiredInputs
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
  } else {
    requiredInputs = inference.requiredInputs.filter((key) => key !== 'text');
    if (promptTarget) requiredInputs.unshift('text');
  }
  // 被显式关掉的绑定不算必填（用户就是在说「这个字段我不要在画布上填」）
  if (disabledBindings.length) requiredInputs = requiredInputs.filter((key) => !disabledBindings.includes(key));
  // 声明了 text 必填、却没有任何地方能写提示词 → 记一条诊断（运行时也会明确报错）
  if (requiredInputs.includes('text') && !bindings.text && !inferredBindings.text) {
    errors.push({
      file,
      code: 'TEXT_TARGET_MISSING',
      message:
        'requiredInputs 里有 text，但模板里没找到可写入提示词的节点；' +
        '请在 meta.json 里设置 promptNode 或 bindings.text。',
    });
  }

  // ---- 超时 ----
  let timeoutMs = outputType === 'videos' ? VIDEO_TIMEOUT_MS : IMAGE_TIMEOUT_MS;
  if (meta.timeoutMs !== undefined) {
    if (typeof meta.timeoutMs === 'number' && Number.isFinite(meta.timeoutMs) && meta.timeoutMs > 0) {
      timeoutMs = Math.min(meta.timeoutMs, 24 * 60 * 60 * 1000);
    } else {
      errors.push({ file: metaSource, code: 'META_INVALID', message: 'meta.timeoutMs 必须是正数（毫秒）。' });
    }
  }

  // ---- modes ----
  let modes: string[] = [];
  if (Array.isArray(meta.modes)) {
    modes = meta.modes
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
  }
  if (!modes.length) modes = ['default'];

  return {
    id,
    title,
    category,
    outputType,
    modes,
    timeoutMs,
    outputNodeId,
    requiredInputs,
    templatePath,
    file,
    promptNodeId,
    negativePromptNodeId,
    promptTarget,
    negativePromptTarget,
    bindings,
    disabledBindings,
    inferredBindings,
    defaults,
    parameterHints,
  };
}

function scanOnce(): ScanResult {
  const dir = customWorkflowsDir();
  const errors: CustomWorkflowDiagnostic[] = [];
  const entries: CustomWorkflowEntry[] = [];
  // 只有默认目录才补 README（用户自己指的目录只读，见 ensureDir 的注释）
  ensureDir(dir, errors, readDirSetting() === null);

  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.json') && !name.toLowerCase().endsWith('.meta.json'))
      .sort();
  } catch (error) {
    errors.push({
      file: '',
      code: 'WORKFLOW_DIR_UNREADABLE',
      message: `读不到自定义工作流目录：${dir}（${messageOf(error)}）`,
    });
    return { dir, entries, errors };
  }

  const seen = new Set<string>();
  for (const file of files) {
    try {
      const entry = buildEntry(dir, file, errors);
      if (seen.has(entry.id)) {
        errors.push({
          file,
          code: 'WORKFLOW_ID_CONFLICT',
          message: `工作流 id 重复（${entry.id}）：文件名 slug 撞车了，改一个文件名再试。`,
        });
        continue;
      }
      seen.add(entry.id);
      entries.push(entry);
    } catch (error) {
      // 单个坏 JSON 只记一条诊断，绝不让整份能力清单崩掉
      errors.push({
        file,
        code: error instanceof CustomWorkflowError ? error.code : 'WORKFLOW_SCAN_FAILED',
        message: messageOf(error),
      });
    }
  }

  // 报错集合变了才打日志（能力清单会被画布反复拉，不能每 2 秒刷屏）
  const signature = errors.map((item) => `${item.file}|${item.code}`).join(',');
  if (signature !== lastErrorSignature) {
    lastErrorSignature = signature;
    for (const item of errors) {
      console.warn(`[aifisher-canvas] 自定义工作流：${item.file || '(目录)'} ${item.code} ${item.message}`);
    }
  }

  return { dir, entries, errors };
}

/** 惰性扫描（带 TTL 缓存）。任何情况下都不抛异常。 */
function scan(): ScanResult {
  const ttl = ttlMs();
  if (cache && Date.now() - cache.at < ttl) return cache.result;
  const result = scanOnce();
  cache = { at: Date.now(), result };
  return result;
}

/** 丢掉缓存，下次访问重新读目录（`GET /api/comfy/custom-workflows?refresh=1` 与测试用）。 */
export function invalidateCustomWorkflows(): void {
  cache = null;
  // 目录设置也一起失效：手改了 workflow-dir.json 之后，刷新一下就生效
  dirSettingCache = null;
}

/** 全部自定义工作流（按文件名排序，保证能力清单逐字节稳定）。 */
export function listCustomWorkflows(): readonly CustomWorkflowEntry[] {
  return scan().entries;
}

/** 按 id 找一个自定义工作流。 */
export function getCustomWorkflow(id: string): CustomWorkflowEntry | null {
  return scan().entries.find((entry) => entry.id === id) ?? null;
}

/** 只读诊断：读到了几个、哪些坏了（挂到 GET /api/comfy/custom-workflows）。 */
export function customWorkflowsStatus(): {
  dir: string;
  defaultDir: string;
  isCustom: boolean;
  settingFile: string;
  count: number;
  workflows: Array<Record<string, unknown>>;
  errors: CustomWorkflowDiagnostic[];
} {
  const { dir, entries, errors } = scan();
  return {
    dir,
    defaultDir: defaultCustomWorkflowsDir(),
    isCustom: readDirSetting() !== null,
    settingFile: customWorkflowsDirSettingPath(),
    count: entries.length,
    workflows: entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      file: entry.file,
      outputType: entry.outputType,
      outputNodeId: entry.outputNodeId,
      promptNodeId: entry.promptNodeId,
      negativePromptNodeId: entry.negativePromptNodeId,
      promptTarget: entry.promptTarget,
      negativePromptTarget: entry.negativePromptTarget,
      requiredInputs: [...entry.requiredInputs],
      modes: [...entry.modes],
      params: Object.keys(effectiveBindings(entry)),
      // 画布节点会长成什么样（参数/素材入口/控件类型），排「丢进去但节点上少了个字段」时看这里
      template: customWorkflowTemplate(entry),
    })),
    errors,
  };
}

/** 读某个自定义工作流的模板（每次都是全新的 parse 结果）。 */
export function loadCustomWorkflowTemplate(entry: CustomWorkflowEntry): PromptGraph {
  return readTemplateGraph(entry.templatePath);
}

/** 生效的绑定表：自动推断打底，meta 声明覆盖，最后摘掉被显式关掉的键。 */
export function effectiveBindings(entry: CustomWorkflowEntry): Record<string, BindingTarget> {
  const merged: Record<string, BindingTarget> = { ...entry.inferredBindings, ...entry.bindings };
  for (const key of entry.disabledBindings) delete merged[key];
  return merged;
}

// ---------------------------------------------------------------- 画布节点参数骨架

/** 常见绑定键 → 中文标签（没命中就用键名本身，至少不难看）。 */
const KEY_LABELS: Readonly<Record<string, string>> = {
  text: '提示词',
  negativeText: '负向提示词',
  imageUrl: '参考图',
  image: '参考图',
  mask: '遮罩',
  firstFrameUrl: '首帧',
  lastFrameUrl: '尾帧',
  videoUrl: '参考视频',
  audioUrl: '参考音频',
  referenceImageUrls: '参考图片',
  referenceVideoUrls: '参考视频',
  referenceAudioUrls: '参考音频',
  seed: '随机种子',
  steps: '采样步数',
  cfg: 'CFG 强度',
  width: '宽度',
  height: '高度',
  duration: '时长',
  fps: '帧率',
};

/** 绑定键 → 中文标签（「ComfyUI 工作流配置」面板也用它，别再写第二份）。 */
export function labelOfKey(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/** 绑定键 → 画布连线的素材类型（拿不准就 any，任何素材都能接）。 */
export function mediaKindOfKey(key: string): 'image' | 'video' | 'audio' | 'any' {
  if (/mask/i.test(key)) return 'image'; // 遮罩在画布里就是一张图
  if (/audio|voice|sound|music|tts/i.test(key)) return 'audio';
  if (/video|movie|clip/i.test(key)) return 'video';
  if (/image|frame|photo|picture|pic\b/i.test(key)) return 'image';
  return 'any';
}

/** 读模板里那个目标字段当前的写死值（用来猜控件类型与默认值）。 */
function targetValue(graph: PromptGraph, target: BindingTarget): unknown {
  const first = Array.isArray(target) ? target[0] : target;
  if (typeof first !== 'string') return undefined;
  const parsed = parseBindingTarget(first);
  if (!parsed) return undefined;
  const value = graph[parsed.nodeId]?.inputs?.[parsed.field];
  return isLink(value) ? undefined : value;
}

/** 绑定目标里的第一个位址（参数在 ComfyUI 里的落点：查枚举候选用）。 */
function firstBindingTarget(target: BindingTarget): { nodeId: string; field: string } | null {
  const first = Array.isArray(target) ? target[0] : target;
  return typeof first === 'string' ? parseBindingTarget(first) : null;
}

const OUTPUT_LABELS: Readonly<Record<CustomOutputType, { label: string; type: string }>> = {
  videos: { label: '视频结果', type: 'video' },
  images: { label: '图片结果', type: 'image' },
  audios: { label: '音频结果', type: 'audio' },
};

/**
 * 把一个自定义工作流翻译成「画布节点参数骨架」（见 CustomWorkflowTemplate 的注释）。
 *
 * 推导规则：
 *   - `text` / `negativeText` 绑定 → 节点上的文本输入槽（两个都能接文本节点；不接线时
 *     分别退化成节点上的正向提示词框 / 负向提示词框），v1.21 起负向提示词也走这条路；
 *   - 素材类绑定键（以 Url/Urls 结尾，或叫 image/mask/firstFrame…）→ 连线的输入槽；
 *   - 其余绑定键 → 参数控件。控件类型优先取 meta.parameters 的声明，否则按模板里那个字段
 *     当前的值猜（数字 → number、布尔 → toggle、其它 → text）；默认值取 meta.defaults，
 *     再退到模板里的原值。
 */
export function customWorkflowTemplate(entry: CustomWorkflowEntry): CustomWorkflowTemplate {
  const bindings = effectiveBindings(entry);
  const hints = entry.parameterHints;
  let graph: PromptGraph | null = null;
  try {
    graph = loadCustomWorkflowTemplate(entry);
  } catch {
    // 模板读不到（扫描到读取之间被删/改坏）：骨架退化成「只有键名」也比什么都没有强
    graph = null;
  }

  const inputs: CustomWorkflowInputSlot[] = [];
  const parameters: CustomWorkflowParameter[] = [];
  const defaults: Record<string, unknown> = { ...entry.defaults };
  const required = new Set(entry.requiredInputs);
  const hasTextBinding = Boolean(bindings.text);
  const negativeTextParameter = bindings.negativeText ? 'negativeText' : null;

  // 提示词槽排在最前：与画布节点左边从上到下的连线顺序一致
  if (hasTextBinding) {
    inputs.push({
      id: 'text',
      label: hints.text?.label ?? labelOfKey('text'),
      type: 'text',
      required: required.has('text'),
    });
  }
  // 负向提示词也是**文本槽**（v1.21）：正向/负向都能把文本节点接进来。
  // 不接线时退化成画布节点上的负向输入框（node.negativePrompt），不再是「参数控件」——
  // 否则节点上只有一个单行参数框，接不了文本节点（用户报障原话：
  //「comfui 节点还不能把文本输入接入负面提示词」）。
  if (negativeTextParameter) {
    inputs.push({
      id: negativeTextParameter,
      label: hints.negativeText?.label ?? labelOfKey('negativeText'),
      type: 'text',
      required: false,
    });
  }

  for (const key of Object.keys(bindings)) {
    // 正向/负向提示词已经在上面变成文本输入槽了，不能再长成参数控件
    if (key === 'text' || key === negativeTextParameter) continue;
    const hint = hints[key];
    const target = firstBindingTarget(bindings[key]);
    const classType = graph && target ? (graph[target.nodeId]?.class_type ?? '') : '';
    const widget = target ? widgetFieldSpec(classType, target.field) : null;
    if (isMediaBindingKey(key)) {
      const kind = mediaKindOfKey(key);
      const requiredFlag =
        required.has(key) ||
        // 推断出来的必填是粗粒度的（'image'），映射到第一个对应的素材键上
        (kind !== 'any' && required.has(kind) && !inputs.some((slot) => slot.type === kind));
      inputs.push({ id: key, label: hint?.label ?? labelOfKey(key), type: kind, required: requiredFlag });
      continue;
    }
    // ComfyUI 扫描到的枚举候选（v1.20）：用户声明过 options/type 的优先，其次看 ComfyUI 那边
    const scannedOptions =
      widget?.control === 'select' && widget.options?.length
        ? widget.options.map((value) => ({ value, label: value }))
        : undefined;
    const options = hint?.options?.length ? hint.options : scannedOptions;
    const raw = graph ? targetValue(graph, bindings[key]) : undefined;
    const type =
      hint?.type ??
      (typeof raw === 'number'
        ? 'number'
        : typeof raw === 'boolean'
          ? 'toggle'
          : options?.length
            ? 'select'
            : 'text');
    const defaultValue = entry.defaults[key] !== undefined ? entry.defaults[key] : raw;
    if (defaultValue !== undefined) defaults[key] = defaultValue;
    const numeric = widget?.control === 'number' ? widget : null;
    parameters.push({
      id: key,
      label: hint?.label ?? labelOfKey(key),
      type,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(options?.length ? { options: [...options] } : {}),
      ...(hint?.min !== undefined ? { min: hint.min } : numeric?.min !== undefined ? { min: numeric.min } : {}),
      ...(hint?.max !== undefined ? { max: hint.max } : numeric?.max !== undefined ? { max: numeric.max } : {}),
      ...(hint?.step !== undefined ? { step: hint.step } : numeric?.step !== undefined ? { step: numeric.step } : {}),
      ...(classType ? { classType } : {}),
      ...(target ? { field: target.field } : {}),
    });
  }

  const output = OUTPUT_LABELS[entry.outputType];
  return {
    label: entry.title,
    category: entry.category,
    outputType: entry.outputType,
    textParameter: hasTextBinding ? 'text' : null,
    negativeTextParameter,
    inputs,
    outputs: [{ id: 'result', label: output.label, type: output.type }],
    parameters,
    defaults,
  };
}

// ---------------------------------------------------------------- 参数归一化

function requireEntry(id: string): CustomWorkflowEntry {
  const entry = getCustomWorkflow(id);
  if (!entry) {
    throw new CustomWorkflowError(
      `未知的自定义工作流：${id}。请确认 JSON 已放进 ${customWorkflowsDir()}。`,
      404,
      'UNKNOWN_WORKFLOW',
    );
  }
  return entry;
}

/** 模式：meta.modes 里有的就用；单模式（default）工作流对画布发来的 mode 一律宽容。 */
function normalizeMode(entry: CustomWorkflowEntry, value: unknown): string {
  const requested = typeof value === 'string' && value.trim() ? value.trim() : '';
  if (!requested) return entry.modes[0] ?? 'default';
  if (entry.modes.includes(requested)) return requested;
  if (entry.modes.length === 1 && entry.modes[0] === 'default') return 'default';
  throw new CustomWorkflowError(
    `工作流「${entry.title}」不支持模式 ${requested}（可用：${entry.modes.join('、')}）。`,
    400,
    'INVALID_COMFY_WORKFLOW',
  );
}

/**
 * 校验并归一化调用方参数（自定义工作流的通用版）。
 * 素材类参数（imageUrl/firstFrameUrl/referenceImageUrls…）只做 URL 收集，真正的上传在 prepare 里做。
 */
export function normalizeCustomWorkflowParams(id: string, body: unknown): CustomWorkflowParams {
  const entry = requireEntry(id);
  const raw = isRecord(body) ? body : {};
  const mode = normalizeMode(entry, raw.mode);
  const bindings = effectiveBindings(entry);

  const values: Record<string, unknown> = {};
  const media: Record<string, string[]> = {};

  // 必填提示词：模板声明要 text 就必须给（错误文案要能直接摆在画布节点上）
  if (entry.requiredInputs.includes('text')) {
    const text = pickParam(raw, 'text');
    if (typeof text !== 'string' || !text.trim()) {
      throw new CustomWorkflowError(
        `工作流「${entry.title}」需要提示词：请在请求里带上 text。`,
        400,
        'INVALID_COMFY_WORKFLOW',
      );
    }
  }

  for (const [key, targets] of Object.entries(bindings)) {
    let value = pickParam(raw, key);
    if (value === undefined) value = entry.defaults[key];
    if (value === undefined || value === null || value === '') continue;

    if (key === 'text' || key === 'negativeText') {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_TEXT_LENGTH) {
        throw new CustomWorkflowError(
          `提示词过长（上限 ${MAX_TEXT_LENGTH} 字符）。`,
          400,
          'INVALID_COMFY_WORKFLOW',
        );
      }
      values[key] = trimmed;
      continue;
    }

    // 画布用 -1 表示随机种子（与内置工作流同一套约定）
    if (key === 'seed' && (value === -1 || value === '-1')) {
      values[key] = Math.floor(Math.random() * 4_294_967_296);
      continue;
    }

    if (isMediaBindingKey(key)) {
      const urls = normalizeUrlList(value);
      if (urls.length) media[key] = urls;
      continue;
    }

    // 数组目标 + 数组值：逐个映射；其余原样写入
    values[key] = Array.isArray(value) && Array.isArray(targets) ? value.slice(0, targets.length) : value;
  }

  return {
    mode,
    ...(typeof values.text === 'string' ? { text: values.text } : {}),
    values,
    media,
  };
}

// ---------------------------------------------------------------- 组装

/** 把值写进 `节点id.inputs.字段`；写不进去（节点/字段不存在）记成问题，最后一次性抛给用户。 */
function writeTargets(
  graph: PromptGraph,
  targets: BindingTarget,
  value: unknown,
  key: string,
  problems: string[],
): void {
  const list = Array.isArray(targets) ? targets : [targets];
  const values = Array.isArray(value) ? value : [value];
  list.forEach((target, index) => {
    const parsed = parseBindingTarget(target);
    if (!parsed) {
      problems.push(`${key} → ${target}（位址应形如 6.inputs.text）`);
      return;
    }
    const node = graph[parsed.nodeId];
    if (!node || typeof node.class_type !== 'string') {
      problems.push(`${key} → 模板里没有节点 ${parsed.nodeId}`);
      return;
    }
    node.inputs = node.inputs ?? {};
    if (!(parsed.field in node.inputs)) {
      problems.push(`${key} → 节点 ${parsed.nodeId}（${node.class_type}）没有输入字段 ${parsed.field}`);
      return;
    }
    // 值比目标少：剩下的目标保持模板原值
    const next = values.length === 1 ? values[0] : values[index];
    if (next === undefined) return;
    node.inputs[parsed.field] = next;
  });
}

/**
 * 组装自定义工作流：读模板 → 写标量参数 → 上传参考素材并写回文件名 → 返回 prompt 图。
 *
 * @param id 工作流 id（custom-…）
 * @param client 上传参考素材用的客户端（真实现是 comfyClient；画布内素材由 uploaderFor 直接读盘）
 * @param params 已经过 normalizeCustomWorkflowParams 的参数
 */
export async function prepareCustomWorkflow(
  id: string,
  client: ReferenceUploader,
  params: CustomWorkflowParams,
): Promise<PromptGraph> {
  const entry = requireEntry(id);
  const graph = loadCustomWorkflowTemplate(entry);
  const bindings = effectiveBindings(entry);
  const problems: string[] = [];

  if (params.values.text !== undefined && !bindings.text) {
    problems.push('模板里没有可写入提示词的节点（请设置 meta.promptNode 或 meta.bindings.text）');
  }

  for (const [key, value] of Object.entries(params.values)) {
    const targets = bindings[key];
    if (!targets) continue;
    writeTargets(graph, targets, value, key, problems);
  }

  for (const [key, urls] of Object.entries(params.media)) {
    const targets = bindings[key];
    if (!targets) continue;
    const names: string[] = [];
    for (const url of urls) {
      const uploaded = await client.uploadImageUrl(url);
      names.push(uploaded.name);
    }
    writeTargets(graph, targets, names.length === 1 ? names[0] : names, key, problems);
  }

  if (problems.length) {
    throw new CustomWorkflowError(
      `工作流「${entry.title}」的参数绑定有问题：${problems.join('；')}。` +
        `请修正 ${entry.file} 或它的 meta.json。`,
      500,
      'INVALID_BINDING',
    );
  }

  return graph;
}

// ---------------------------------------------------------------- 目录说明

/**
 * 自动写进用户目录的说明（只写一次，用户改过就不再覆盖）。
 * 内容是给用户看的，所以刻意写全：目录约定、meta 字段、bindings 写法、例子。
 */
const README_CONTENT = `# 自定义 ComfyUI 工作流模板

把 ComfyUI 里导出的 **API 格式 JSON**（工作流菜单 → Export (API)）放到本目录，
DSH 的 aifisher-canvas 插件就会自动把它列进「可选工作流」，可以直接跑。
不需要装任何特定的自定义节点包，能用什么取决于你本机 ComfyUI 装了什么。

本文件由插件自动生成，只写一次；你可以随便改，删掉也会在下次扫描时补回来。

## 目录约定

    workflows/
      ├── 我的图生视频.json        每个 *.json = 一个工作流（必须与文件名同名）
      ├── 我的图生视频.meta.json   可选：覆盖标题/输出节点/参数绑定（同目录同名 + .meta.json）
      └── README.md

- 文件名就是工作流名（后缀 .json 去掉）。工作流 id 自动取做 \`custom-<文件名>\`（小写、空格转 -）。
- 改完文件等约 2 秒（扫描有 2 秒缓存）就会生效，不用重启 DSH。
- 故意做成「目录式」：导出 JSON 丢进来就行，不需要在插件里写代码。

## 在画布上用

刷新画布页面（清单是页面加载时拉的），然后：

1. 左侧工具条的 ➕ →「添加节点」→「ComfyUI 工作流」→ 画布上出现一个**本地工作流节点**
   （默认就是本目录里排第一的那个工作流）；
2. 节点顶部下拉可以换成本目录里的任意工作流（也能切回内置的 MiniMax H3）；
3. 右边填提示词、调参数；左边一列是输入槽，可以从别的节点拖线把素材接进来（标 \`*\` 的是必填）；
4. 点「生成」，跑完的结果会在节点右侧落成一个新的媒体节点（图片/视频/音频看输出类型）。

## 自动推断（meta 不写也能跑）

| 项目 | 推断方式 |
|---|---|
| outputType / outputNodeId | VHS_VideoCombine、SaveWEBM、SaveVideo → 视频；SaveImage、PreviewImage、SaveAnimatedWEBP → 图片；SaveAudio、PreviewAudio → 音频；VHS_VideoCombine 的 format 以 audio 开头时算音频 |
| promptNodeId | 找有 \`text\` 输入的节点：写死字符串就是它；被连线喂时沿上游找**字符串节点**（PrimitiveString* / String / Textbox…），提示词写在它的 \`value\` 字段上也算。优先 CLIPTextEncode，其次类名带 text/prompt；标题/类名带 negative/负面 的算负向提示词 |
| requiredInputs | 有提示词节点 → text；模板里有 LoadImage（写死了 image 文件名）→ image |
| 其它参数 | seed/noise_seed、steps、cfg、width、height、duration 这几个字段全图唯一命中时自动绑定 |
| 参数的下拉候选 | 从 ComfyUI \`/object_info\` 扫（lora_name / ckpt_name / model_name / sampler_name… 谁有枚举谁就变下拉），快照存在 storages/dsh-aifisher-canvas/comfy-widget-options.json，ComfyUI 没开时用上次扫到的那份 |
| modes | 默认 ["default"] |
| timeoutMs | 视频 30 分钟，图片/音频 10 分钟 |

推断不准就用 meta.json 覆盖。

## 参数下拉（v1.20）

ComfyUI 里是**枚举**的字段（lora_name / ckpt_name / model_name / sampler_name…）会在画布节点上
变成下拉框，候选就是你本机装的那些。列表来自 ComfyUI 的 \`/object_info\`，攒成快照存在
\`storages/dsh-aifisher-canvas/comfy-widget-options.json\`；
- ComfyUI 没开也能用上次扫到的那份（先开一次扫一遍即可）；
- 装了新模型之后：面板底栏点「扫描 ComfyUI」重扫（不用重启、不用刷新页面）；
- 想用自己写死的候选：照旧在 meta.parameters 里写 \`options\`（优先级高于扫描结果）。

## meta.json 字段

    {
      "title": "我的图生视频",
      "category": "custom",
      "outputType": "videos",
      "outputNodeId": "12",
      "promptNode": "6",
      "negativePromptNode": "7",
      "requiredInputs": ["text", "image"],
      "modes": ["default"],
      "timeoutMs": 1800000,
      "bindings": {
        "text": "6.inputs.text",
        "negativeText": "7.inputs.text",
        "imageUrl": "10.inputs.image",
        "seed": "3.inputs.seed",
        "steps": "3.inputs.steps",
        "width": "5.inputs.width",
        "height": "5.inputs.height"
      },
      "defaults": { "steps": 20, "cfg": 7 },
      "parameters": {
        "steps": { "label": "迭代步数", "type": "number", "min": 1, "max": 60, "step": 1 },
        "cfg": "CFG 强度"
      }
    }

- 全部字段都可选。\`promptNode\` 写成 null 表示「这个工作流不需要提示词」。
- \`defaults\` 里的值在请求没给对应参数时使用。
- \`parameters\` 决定**画布节点上那个参数控件长什么样**（不写也能跑，按模板里的值推断）：
  值写成字符串 = 只换标签；写成对象 = 可指定 \`label\` / \`type\`(text|number|toggle|select) /
  \`options\`([{value,label}]) / \`min\` / \`max\` / \`step\`。缺省值统一看 \`defaults\`。
- 查看「最终会被画布渲染成什么」：\`GET /api/comfy/custom-workflows\` 的 \`template\` 字段。

## bindings 写法

\`"参数名": "节点id.inputs.字段名"\`，字段名可以是 ComfyUI 的 Autogrow 动态输入
（例如 \`"307.inputs.ref_images.ref_image_0"\`）。

- 参数名随便起，请求体里带同名键就会被写进去；\`text\` / \`negativeText\` 是约定的提示词。
- 素材类参数（以 \`Url\`/\`Urls\` 结尾，或叫 image/video/audio/mask/firstFrame/lastFrame）会先通过
  ComfyUI 的 \`/upload/image\` 上传，再把返回的文件名写进目标字段（LoadImage 认的就是文件名）。
- \`imageUrl\` 还接受别名 image / firstFrameUrl / lastFrameUrl / referenceImageUrls[0]。
- 多个参考图：把目标写成数组，参数给数组，按下标逐个对应：
  \`"referenceImageUrls": ["10.inputs.image", "11.inputs.image"]\`
- \`seed\` 给 -1 表示随机（与画布内置工作流同一套约定）。

## 请求示例

    POST /api/aifisher/canvas/comfy/custom-我的图生视频
    {
      "projectId": "某个项目 id",
      "nodeId": "画布节点 id",
      "text": "一只猫在雨里走过霓虹街道",
      "negativeText": "模糊, 低质量",
      "imageUrl": "/api/aifisher/canvas/media/<项目>/images/xxx.png",
      "seed": -1,
      "steps": 24
    }

返回 \`{ success: true, url, asset, workflowType }\`，\`url\` 就是落在素材库里的产物地址，
画布可以直接当 \`<video src>\` / \`<img src>\` 用。

排查：

- \`GET /api/comfy/custom-workflows\` —— 读到了几个、哪些 JSON 坏了、每个工作流认出来的参数名。
- \`GET /api/comfy/workflow/custom-<文件名>\` —— 取回原始模板 JSON。
- \`POST /api/comfy/prepare/custom-<文件名>\` —— 只组装不执行，用来核对参数写进了哪个节点。
`;

