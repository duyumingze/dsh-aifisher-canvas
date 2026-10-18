/**
 * 提交前对账（host 半）：把工作流模板里的「节点类型 + 模型文件名」与本机 ComfyUI 实际装的东西对齐。
 *
 * 为什么需要：
 *   工作流模板 JSON 是写好死的（上游 AIFISHER 那份），里面写的是作者机器上的模型文件名。
 *   换一台机器（或同一台机器换了量化版本）就必然对不上——ComfyUI 会在校验阶段直接拒绝：
 *   `value not in list: minimax_h3_fl2va_int8_convrot.safetensors`，前端只能拿到一句看不懂的英文。
 *   这台机器上就是这样：模板要 `..._fl2va_int8_...`，实际装的是 `..._fl2va_pruned_int8_...`。
 *
 * 做法（两级）：
 *   1. 节点类型：拿 /object_info 的键集合核对，缺哪个 class_type 直接报「需要装哪个节点包」；
 *   2. 模型文件：只对已知的模型输入字段（unet_name / clip_name / vae_name / lora_name / ckpt_name）
 *      做比对。取值不在候选列表里时，按「去掉量化后缀后的核心名」找唯一匹配 → 自动替换（记进报告）；
 *      找不到或匹配到多个 → 报 409 + 把可用候选项带出去（前端能直接把话说明白）。
 *
 * 与上游 workflowRequirements.js 的差异：上游只**提取**要求清单给 UI 看，不做替换；
 * 这里多做一步自动替换 —— 不然「量化版本号不同」这种最常见的情况会白白卡死。
 */
import type { ComfyClient } from './comfyClient';
import { ComfyWorkflowError } from './workflowRegistry';

/** 需要核对文件名的输入字段（照上游 MODEL_INPUT_TYPES，去掉了用不到的分类名）。 */
const MODEL_FIELDS = ['unet_name', 'clip_name', 'vae_name', 'lora_name', 'ckpt_name'] as const;

/** 归一化时要去掉的「量化/格式/打包」噪音词。 */
const NOISE_TOKENS = new Set([
  'safetensors',
  'ckpt',
  'pt',
  'bin',
  'gguf',
  'fp8',
  'fp16',
  'fp32',
  'bf16',
  'int4',
  'int8',
  'nvfp4',
  'awq',
  'gptq',
  'pruned',
  'convrot',
  'scaled',
  'e4m3fn',
  'e5m2',
  'comfy',
  'comfyui',
  'distill',
  'distilled',
  'turbo',
  'v',
]);

/**
 * 拆成「核心词集合」：小写、按非字母数字切分、去掉扩展名与量化噪音词。
 * `minimax_h3_fl2va_pruned_int8_convrot.safetensors` → {minimax,h3,fl2va}
 */
export function coreTokens(filename: string): Set<string> {
  const withoutExt = filename.replace(/\.[a-z0-9]+$/i, '');
  return new Set(
    withoutExt
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token && !NOISE_TOKENS.has(token) && !/^\d+$/.test(token)),
  );
}

/** 两个文件名是否「同一个东西的不同量化/打包版本」。 */
export function sameModelCore(a: string, b: string): boolean {
  const left = coreTokens(a);
  const right = coreTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  if (left.size !== right.size) return false;
  for (const token of left) if (!right.has(token)) return false;
  return true;
}

export interface ModelSubstitution {
  nodeId: string;
  field: string;
  from: string;
  to: string;
}

export interface ReconcileReport {
  substitutions: ModelSubstitution[];
  /** 用到的节点类型（诊断/能力清单可用） */
  nodeTypes: string[];
}

interface ObjectInfoNode {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
}

/** 一个输入字段的候选值列表（当且仅当它是「字符串枚举」时才认定为模型选择框）。 */
function enumOptions(spec: unknown): string[] | null {
  if (!Array.isArray(spec) || !Array.isArray(spec[0])) return null;
  const list = spec[0];
  if (list.length === 0) return null;
  return list.every((item) => typeof item === 'string') ? (list as string[]) : null;
}

export interface ModelResolver {
  /** 对账一份工作流：就地返回修正后的图（不修改入参对象）。 */
  reconcile(workflow: Record<string, { inputs?: Record<string, unknown>; class_type?: string }>): Promise<ReconcileReport>;
  /** 清缓存（测试用 / 用户装了新模型后手动刷新）。 */
  invalidate(): void;
}

export function createModelResolver(
  client: Pick<ComfyClient, 'objectInfo'>,
  options: { ttlMs?: number } = {},
): ModelResolver {
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  let cache: { at: number; info: Record<string, ObjectInfoNode> } | null = null;

  async function info(): Promise<Record<string, ObjectInfoNode>> {
    if (cache && Date.now() - cache.at < ttlMs) return cache.info;
    let loaded: Record<string, ObjectInfoNode>;
    try {
      loaded = (await client.objectInfo()) as Record<string, ObjectInfoNode>;
    } catch (error) {
      throw new ComfyWorkflowError(
        `无法读取 ComfyUI 节点清单（/object_info）：${error instanceof Error ? error.message : String(error)}`,
        503,
        'COMFY_UNAVAILABLE',
      );
    }
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new ComfyWorkflowError('ComfyUI 返回的节点清单格式不对。', 502, 'COMFY_BAD_OBJECT_INFO');
    }
    cache = { at: Date.now(), info: loaded };
    return loaded;
  }

  return {
    invalidate() {
      cache = null;
    },

    async reconcile(workflow) {
      const objectInfo = await info();
      const substitutions: ModelSubstitution[] = [];
      const nodeTypes: string[] = [];

      // 第一轮：节点类型是否齐全（缺节点比缺模型更难自己修，先把话说清楚）
      const missingNodes: string[] = [];
      for (const [nodeId, node] of Object.entries(workflow)) {
        const classType = node?.class_type;
        if (typeof classType !== 'string' || !classType) continue;
        if (!nodeTypes.includes(classType)) nodeTypes.push(classType);
        if (!objectInfo[classType]) missingNodes.push(`${nodeId}(${classType})`);
      }
      if (missingNodes.length) {
        throw new ComfyWorkflowError(
          `本机 ComfyUI 缺少这些节点：${missingNodes.join('、')}。` +
            '请在 ComfyUI-Manager 里安装对应自定义节点包后重试。',
          409,
          'COMFY_NODE_MISSING',
        );
      }

      // 第二轮：模型文件名对账
      const missingModels: string[] = [];
      for (const [nodeId, node] of Object.entries(workflow)) {
        const classType = node?.class_type;
        const inputs = node?.inputs;
        if (typeof classType !== 'string' || !inputs) continue;
        const spec = objectInfo[classType]?.input;
        for (const field of MODEL_FIELDS) {
          const current = inputs[field];
          if (typeof current !== 'string' || !current) continue;
          const candidates = enumOptions(spec?.required?.[field] ?? spec?.optional?.[field]);
          if (!candidates) continue; // 不是枚举选择框（或本机该字段是自由文本），不做替换
          if (candidates.includes(current)) continue;
          const matches = candidates.filter((candidate) => sameModelCore(candidate, current));
          if (matches.length === 1) {
            substitutions.push({ nodeId, field, from: current, to: matches[0] });
            inputs[field] = matches[0];
            continue;
          }
          // 找不到：给「同类候选」名单（按核心词交集排序），让用户知道该装/该选哪个
          const related = candidates
            .map((candidate) => {
              const shared = [...coreTokens(candidate)].filter((token) => coreTokens(current).has(token));
              return { candidate, score: shared.length };
            })
            .filter((item) => item.score > 0)
            .sort((left, right) => right.score - left.score)
            .slice(0, 6)
            .map((item) => item.candidate);
          missingModels.push(
            `${nodeId}.${field}=${current}` +
              (related.length
                ? `（本机相近的：${related.join(' / ')}）`
                : `（本机 ${candidates.length ? `可用：${candidates.slice(0, 6).join(' / ')}` : '没有同名类模型'}）`),
          );
        }
      }
      if (missingModels.length) {
        throw new ComfyWorkflowError(
          `本机 ComfyUI 缺少工作流需要的模型（或文件名对不上）：${missingModels.join('；')}。` +
            '请放到对应 models 子目录（或改用相近版本）后重试。',
          409,
          'COMFY_MODEL_MISSING',
        );
      }

      return { substitutions, nodeTypes };
    },
  };
}
