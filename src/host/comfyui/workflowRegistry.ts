/**
 * ComfyUI 工作流注册表（host 半）
 *
 * 移植自 AIFISHER:
 *   server/comfyui/workflowRegistry.js
 *   server/comfyui/workflows/MiniMax-H3-T2VA-api.json
 *
 * 这里放「静态元数据 + 模板 JSON 读取」；按参数改写节点图的动态组装 handler 在
 * workflows/minimaxH3T2VA.ts（上游把它作为 handler 挂在本注册表里，我们放在路由层查表，
 * 免得 registry ↔ workflows/ 互相 import 成环）。
 *
 * 工作流清单：
 *   - minimax-h3-t2va  MiniMax H3 本地音视频（t2va/i2va/fl2va/l2va/ref2va）
 *   - custom-<文件名>  用户在 $DSH_HOME/storages/dsh-aifisher-canvas/workflows/ 里放的自定义模板
 *                     （见 customWorkflows.ts：惰性同步扫描 + TTL 缓存，不需要任何 wiring）
 */
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  getCustomWorkflow,
  listCustomWorkflows,
  loadCustomWorkflowTemplate,
} from './customWorkflows';

export interface WorkflowMeta {
  /** 稳定 id，路由用 */
  id: string;
  /** 中文标题 */
  title: string;
  /** 能力分组（画布前端的 VideoCapability.category） */
  category: string;
  /** 输出类型 */
  outputType: 'videos' | 'images' | 'audios';
  /** 支持的模式（与 workflows/minimaxH3T2VA.ts 的 MINIMAX_H3_MODES 同源，上游也是两处各一份） */
  modes: readonly string[];
  /** 默认超时（ms） */
  timeoutMs: number;
  /** ComfyUI 输出节点 id（VHS_VideoCombine / SaveImage 等） */
  outputNodeId: string;
  /** 模板 JSON 文件名（相对于 workflows/ 目录） */
  templateFile: string;
  /** 必填输入 */
  requiredInputs: readonly string[];
}

/**
 * 参数/工作流错误：带上 HTTP 状态与 code，让路由直接透传给前端。
 * 放在本模块是因为 workflows/* 与 comfyRouter 都已经依赖它 —— 谁都不必再反向 import 对方。
 */
export class ComfyWorkflowError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'INVALID_COMFY_WORKFLOW') {
    super(message);
    this.name = 'ComfyWorkflowError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 本模块所在目录 = 产物 lib/（host 半是单文件 bundle，`import.meta.url` 就是 lib/index.js）。
 * 注意不要再套一层 dirname：上游第一版写成 `dirname(fileURLToPath(new URL('.', url)))`，
 * 多退了一级到包根，于是模板 JSON 从来没被读到（/api/comfy/workflow/:type 一直 400）。
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** 包根（lib/ 的上一级）—— 源码工作区里就是仓库根。 */
const PACKAGE_ROOT = dirname(MODULE_DIR);

/**
 * 模板 JSON 的候选目录。
 * tsdown 只打包 JS，不会把 workflows/*.json 拷进 lib/，所以按部署形态依次找：
 *   1) 源码工作区：link 安装（junction）时就是仓库里的那一份，也是当前的常态；
 *   2) lib/workflows：将来若在构建里加一步资源拷贝，放这里最直观；
 *   3) 包根/workflows：兼容「手工把 JSON 放到包根」的老做法。
 */
const TEMPLATE_DIRS = [
  resolve(PACKAGE_ROOT, 'src', 'host', 'comfyui', 'workflows'),
  resolve(MODULE_DIR, 'workflows'),
  resolve(PACKAGE_ROOT, 'workflows'),
];

export const WORKFLOW_REGISTRY: Readonly<Record<string, WorkflowMeta>> = Object.freeze({
  'minimax-h3-t2va': Object.freeze({
    id: 'minimax-h3-t2va',
    title: 'MiniMax H3 本地音视频',
    category: 'minimax-h3',
    outputType: 'videos',
    modes: ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'] as const,
    timeoutMs: 1_800_000,
    outputNodeId: '303',
    templateFile: 'MiniMax-H3-T2VA-api.json',
    requiredInputs: ['text'] as const,
  }),
});

/** 列出所有工作流（给 /api/comfy/workflows 用），去掉内部字段。 */
export function listWorkflows(): Array<Omit<WorkflowMeta, 'templateFile' | 'outputNodeId'>> {
  const builtin = Object.values(WORKFLOW_REGISTRY).map(
    ({ templateFile: _t, outputNodeId: _o, ...rest }) => rest,
  );
  // 用户目录里的自定义模板并进来。扫描是同步 + TTL 缓存的（listWorkflows 是同步 API，
  // sendComfyCapabilities 直接同步调它）；单个坏 JSON 只会记诊断并跳过。
  const custom = listCustomWorkflows().map((entry) => ({
    id: entry.id,
    title: entry.title,
    category: entry.category,
    outputType: entry.outputType,
    modes: entry.modes,
    timeoutMs: entry.timeoutMs,
    requiredInputs: entry.requiredInputs,
  }));
  return [...builtin, ...custom];
}

/**
 * 路由真正用到的元数据（内置与自定义工作流都满足这一份）。
 * 单独一个类型是为了让 comfyRouter 不必关心元数据是从注册表还是从用户目录来的。
 */
export interface ResolvedWorkflowMeta {
  id: string;
  title: string;
  outputNodeId: string;
  timeoutMs: number;
}

/** 按 id 取元数据：内置优先，其次用户目录里的自定义工作流（找不到返回 null）。 */
export function getWorkflowMeta(id: string): ResolvedWorkflowMeta | null {
  const builtin = WORKFLOW_REGISTRY[id];
  if (builtin) return builtin;
  const custom = getCustomWorkflow(id);
  if (!custom) return null;
  return {
    id: custom.id,
    title: custom.title,
    outputNodeId: custom.outputNodeId,
    timeoutMs: custom.timeoutMs,
  };
}

/** 在候选目录里找模板文件，返回第一个存在的；都没找到返回 null。 */
async function findTemplateFile(fileName: string): Promise<string | null> {
  for (const dir of TEMPLATE_DIRS) {
    const filePath = resolve(dir, fileName);
    try {
      await access(filePath);
      return filePath;
    } catch {
      // 换下一个候选目录
    }
  }
  return null;
}

/**
 * 读某个工作流的 API 模板 JSON（让前端/agent 能取到完整节点图）。
 * 内置工作流从包内候选目录找；自定义工作流直接读用户目录里那份文件。
 */
export async function loadWorkflowTemplate(id: string): Promise<Record<string, unknown> | null> {
  const meta = WORKFLOW_REGISTRY[id];
  if (meta) {
    const filePath = await findTemplateFile(meta.templateFile);
    if (!filePath) return null;
    const raw = await readFile(filePath, 'utf8');
    // 每次都是新的 parse 结果：组装 handler 会就地改写节点 inputs，不能共用同一份实例。
    return JSON.parse(raw) as Record<string, unknown>;
  }
  const custom = getCustomWorkflow(id);
  if (!custom) return null;
  try {
    return loadCustomWorkflowTemplate(custom) as unknown as Record<string, unknown>;
  } catch {
    // 扫描到读取之间的竞态（文件被删/改坏）：当作「模板不可用」，由路由回 500 说清楚
    return null;
  }
}
