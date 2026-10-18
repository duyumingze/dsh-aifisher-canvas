/**
 * 「ComfyUI 工作流配置」面板的 host 半（画布左栏那个入口的数据面）。
 *
 * 背景：目录式自定义工作流（customWorkflows.ts）以前只能靠手写 `<名字>.meta.json` 配
 * 「哪些字段要在画布节点上暴露、叫什么名字」。这一层把它变成可视化的读/写接口：
 *
 *   GET  /api/comfy/workflow-config            工作流清单（含每个的已选参数数 / 诊断）
 *   GET  /api/comfy/workflow-config/<id>       单个工作流的全部候选字段 + 当前选择
 *   POST /api/comfy/workflow-config/<id>       保存（写回 <file>.meta.json）
 *
 * 「候选字段」= 模板 JSON 里**写死在节点上**的每个 input（被连线喂的 [id, slot] 不算），
 * 与上游 workflowManager 的 BindingCandidate 是同一个思路：用户在候选清单里勾哪几个，
 * 哪几个才会长到画布节点上。区别是上游那套要 definitions/deployments/binding-sets/attestation
 * 一整套后端（本插件没有、也不搬），这里直接落在 meta.json 的 `bindings` 上 ——
 * 于是同一份配置手写和面板改完全等价。
 *
 * 数据落点与语义（与 customWorkflows.ts 严格一致）：
 *   meta.title / meta.category          → 画布节点标题 / 分组
 *   meta.bindings.<键> = "节点id.inputs.字段"  → 勾选：这个字段暴露成节点参数/素材槽
 *   meta.bindings.<键> = null                 → 取消勾选「自动推断出来的」那条绑定
 *   meta.parameters.<键> = { label… }          → 参数在节点上的中文标签/控件类型
 *   meta.defaults.<键>                       → 节点初值
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { PromptGraph, PromptNode } from './workflows/minimaxH3T2VA';
import {
  CustomWorkflowError,
  customWorkflowsDir,
  customWorkflowsStatus,
  defaultCustomWorkflowsDir,
  effectiveBindings,
  getCustomWorkflow,
  invalidateCustomWorkflows,
  labelOfKey,
  listCustomWorkflows,
  loadCustomWorkflowTemplate,
  parseBindingTarget,
  sortedGraphNodeIds,
  type BindingTarget,
  type CustomOutputType,
  type CustomWorkflowDiagnostic,
  type CustomWorkflowEntry,
} from './customWorkflows';
import { buildWorkflowGraph, type WorkflowGraphView } from './workflowGraph';
import { widgetFieldSpec } from './widgetOptions';
import { workflowCoverUrl } from './workflowCovers';

// ---------------------------------------------------------------- 类型

/** 候选字段的种类：决定它会长成素材槽还是参数控件。 */
export type WorkflowCandidateKind = 'parameter' | 'media' | 'text' | 'negativeText';

export interface WorkflowCandidate {
  /** 绑定位址 `${nodeId}.inputs.${field}`（稳定 id，勾选状态靠它对齐） */
  id: string;
  /** 面板建议的绑定键（被勾上时写进 meta.bindings 的那个键） */
  key: string;
  nodeId: string;
  classType: string;
  nodeTitle: string;
  field: string;
  kind: WorkflowCandidateKind;
  /** 画布控件类型（meta.parameters 里声明过的优先） */
  control: 'text' | 'number' | 'toggle' | 'select';
  /** 模板里那个字段现在的值类型（number/string/boolean） */
  valueType: string;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
  /** 候选值从哪来：meta.parameters 里手写的（meta）还是扫 ComfyUI /object_info 得来的（comfyui） */
  optionsSource?: 'meta' | 'comfyui';
  min?: number;
  max?: number;
  step?: number;
  /** 当前是否已勾选（来自 effectiveBindings） */
  selected: boolean;
  /** 已勾选时它实际用的绑定键（可能与建议 key 不同 —— 老 meta.json 里写过别的名字） */
  bindingKey?: string;
  /** 中文标签（先看 meta.parameters 的声明，再按已知键名映射，最后退回「节点标题 · 字段」） */
  label: string;
  /** label 是用户在 meta.parameters 里写死的（true）还是自动推断的（false） */
  labelIsCustom: boolean;
}

export interface WorkflowConfigSummary {
  id: string;
  title: string;
  file: string;
  metaFile: string;
  hasMeta: boolean;
  category: string;
  outputType: CustomOutputType;
  modes: string[];
  candidateCount: number;
  selectedCount: number;
  disabledCount: number;
  /** 工作流自己的配图（v1.28，左侧「工作流节点」面板的卡片封面；没配过就没有这个字段） */
  coverUrl?: string;
  /** 这个工作流自己的诊断（坏 meta / 认不出输出节点…） */
  diagnostics: CustomWorkflowDiagnostic[];
}

export interface WorkflowConfigView {
  ok: true;
  dir: string;
  /** 默认目录（面板底栏的「恢复默认」回到这里） */
  defaultDir: string;
  /** 当前目录是用户自定义的（false = 默认目录） */
  isCustom: boolean;
  workflow: {
    id: string;
    title: string;
    file: string;
    metaFile: string;
    metaPath: string;
    hasMeta: boolean;
    category: string;
    outputType: CustomOutputType;
    modes: string[];
    timeoutMs: number;
    outputNodeId: string;
    promptNodeId: string | null;
    negativePromptNodeId: string | null;
    /** v1.20：提示词真正写进哪个位址（可能是上游字符串节点的 value） */
    promptTarget: string | null;
    negativePromptTarget: string | null;
    requiredInputs: string[];
  };
  candidates: WorkflowCandidate[];
  /**
   * 可视化用的节点图（v1.19）。参考图里那张「ComfyUI 节点图 + 点节点看字段」就靠它：
   * 排版（坐标/连线/每行显示什么）全在 host 算好，前端只负责画与交互。
   */
  graph: WorkflowGraphView;
  /** 生效的绑定表（推断 + meta，已摘掉 disabled） */
  bindings: Array<{
    key: string;
    label: string;
    targets: string[];
    inferred: boolean;
    declared: boolean;
  }>;
  /** 被显式关掉的自动推断键 */
  disabled: string[];
  /** 绑定位址在模板里找不到的绑定（meta 写错/模板换了） */
  missing: Array<{ key: string; targets: string[] }>;
  totals: { fields: number; selected: number; parameters: number; media: number };
  diagnostics: CustomWorkflowDiagnostic[];
}

export interface WorkflowConfigSaveInput {
  title?: string;
  category?: string;
  outputNodeId?: string | null;
  outputType?: CustomOutputType;
  bindings?: Record<string, string | string[] | null>;
  parameters?: Record<
    string,
    { label?: string; type?: 'text' | 'number' | 'toggle' | 'select'; min?: number; max?: number; step?: number } | null
  >;
  defaults?: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------- 小工具

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLink(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number'
  );
}

/** `<file>.json` → `<file>.meta.json`（与 customWorkflows.ts 的侧车命名同一套）。 */
function metaFileNameOf(file: string): string {
  return `${basename(file, extname(file))}.meta.json`;
}

function metaPathOf(entry: CustomWorkflowEntry): string {
  return join(customWorkflowsDir(), metaFileNameOf(entry.file));
}

function diagnosticsOf(file: string, metaFile: string): CustomWorkflowDiagnostic[] {
  const status = customWorkflowsStatus();
  return status.errors.filter((item) => item.file === file || item.file === metaFile);
}

/** 读现有 meta 原文（存在但不是合法 JSON 时抛 409，绝不悄悄覆盖用户的文件）。 */
function readMetaObject(entry: CustomWorkflowEntry): Record<string, unknown> {
  const path = metaPathOf(entry);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CustomWorkflowError(
      `${basename(path)} 不是合法 JSON（${messageOf(error)}）：先把文件修好，或删掉它重新配。`,
      409,
      'META_UNPARSEABLE',
    );
  }
  if (!isRecord(parsed)) {
    throw new CustomWorkflowError(
      `${basename(path)} 的最外层必须是一个对象（现在是 ${Array.isArray(parsed) ? '数组' : typeof parsed}）。`,
      409,
      'META_UNPARSEABLE',
    );
  }
  return parsed;
}

// ---------------------------------------------------------------- 候选字段枚举

/** 素材入口节点：类名 → 素材种类（这些字段在画布上是连线槽，不是输入框）。 */
function mediaKindOfNode(classType: string, field: string): 'image' | 'video' | 'audio' | null {
  const type = classType.toLowerCase();
  if (/loadimage/.test(type) && (field === 'image' || field === 'mask')) return 'image';
  if (/loadvideo|vhs_loadvideo/.test(type) && field === 'video') return 'video';
  if (/loadaudio/.test(type) && field === 'audio') return 'audio';
  return null;
}

const NEGATIVE_HINT = /negative|neg_|负面|负向|反向|不想要/i;

/** 参数键名在不同节点上撞车时的补位：`steps` → `steps_12`。 */
function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function mediaKey(mediaKind: 'image' | 'video' | 'audio', taken: Set<string>): string {
  const base = mediaKind === 'image' ? 'imageUrl' : mediaKind === 'video' ? 'videoUrl' : 'audioUrl';
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base.replace(/Url$/, `${index}Url`)}`)) index += 1;
  return base.replace(/Url$/, `${index}Url`);
}

function controlOf(value: unknown, hintType: string | undefined): 'text' | 'number' | 'toggle' | 'select' {
  if (hintType === 'text' || hintType === 'number' || hintType === 'toggle' || hintType === 'select') {
    return hintType;
  }
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'toggle';
  return 'text';
}

/**
 * 枚举模板里所有可绑定字段。
 *
 * 顺序：节点 id 数值序 → 节点内 inputs 声明顺序（也就是 ComfyUI 里从上到下的顺序），
 * 这样面板里勾选出来的序列和用户在 ComfyUI 里看到的一致，不会跳来跳去。
 */
export function workflowCandidates(entry: CustomWorkflowEntry): {
  candidates: WorkflowCandidate[];
  bindings: WorkflowConfigView['bindings'];
  missing: WorkflowConfigView['missing'];
} {
  let graph: PromptGraph;
  try {
    graph = loadCustomWorkflowTemplate(entry);
  } catch (error) {
    throw new CustomWorkflowError(`读不到工作流模板：${messageOf(error)}`, 500, 'TEMPLATE_UNREADABLE');
  }

  // 绑定位址 → 绑定键（同一个字段被多条绑定命中时，第一条赢）
  const targetToKey = new Map<string, string>();
  const effective = effectiveBindings(entry);
  const bindings: WorkflowConfigView['bindings'] = [];
  const missing: WorkflowConfigView['missing'] = [];
  for (const [key, raw] of Object.entries(effective)) {
    const targets = (Array.isArray(raw) ? raw : [raw]).filter(
      (item): item is string => typeof item === 'string' && item.trim() !== '',
    );
    if (!targets.length) continue;
    bindings.push({
      key,
      label: entry.parameterHints[key]?.label ?? labelOfKey(key),
      targets,
      inferred: entry.bindings[key] === undefined,
      declared: entry.bindings[key] !== undefined,
    });
    const alive: string[] = [];
    for (const target of targets) {
      const parsed = parseBindingTarget(target);
      const node = parsed ? graph[parsed.nodeId] : undefined;
      if (!parsed || !node || !(parsed.field in (node.inputs ?? {}))) {
        continue;
      }
      alive.push(target);
      if (!targetToKey.has(target)) targetToKey.set(target, key);
    }
    if (!alive.length) missing.push({ key, targets });
  }

  const taken = new Set<string>(Object.keys(effective));
  const candidates: WorkflowCandidate[] = [];

  for (const nodeId of sortedGraphNodeIds(graph)) {
    const node: PromptNode = graph[nodeId];
    const inputs = node.inputs ?? {};
    const classType = node.class_type ?? '';
    const nodeTitle = String(node._meta?.title ?? '').trim() || classType;

    for (const [field, value] of Object.entries(inputs)) {
      // 被连线喂的字段不是「可配置参数」：它的值由上游节点算出来
      if (isLink(value)) continue;

      const id = `${nodeId}.inputs.${field}`;
      const mediaKind = mediaKindOfNode(classType, field);
      // 推断出来的提示词落点：可能是编码器自己的 text，也可能是上游字符串节点的 value
      const isPrompt = id === entry.promptTarget;
      const isNegativePrompt = id === entry.negativePromptTarget;
      const widget = widgetFieldSpec(classType, field);
      let kind: WorkflowCandidateKind;
      let key: string;
      if (mediaKind) {
        kind = 'media';
        // 已经有绑定指向这个字段时沿用它的键，否则按 imageUrl / image2Url 生成
        key = targetToKey.get(id) ?? mediaKey(mediaKind, taken);
      } else if (isNegativePrompt) {
        kind = 'negativeText';
        key = 'negativeText';
      } else if (isPrompt) {
        kind = 'text';
        key = 'text';
      } else if (field === 'text' && NEGATIVE_HINT.test(nodeTitle + ' ' + classType)) {
        kind = 'negativeText';
        key = targetToKey.get(id) ?? uniqueKey('negativeText', taken);
      } else if (field === 'text' && /text|prompt|encode/i.test(classType)) {
        kind = 'text';
        key = targetToKey.get(id) ?? uniqueKey('text', taken);
      } else {
        kind = 'parameter';
        key = targetToKey.get(id) ?? uniqueKey(field, taken);
      }
      // 提示词的键被改名成 text/negativeText 时，老 meta 里那个别名键上的标签要跟着走
      const existingKey = targetToKey.get(id);
      const hintKey = existingKey && existingKey !== key ? existingKey : key;
      const hint = entry.parameterHints[hintKey] ?? entry.parameterHints[key];
      const scannedOptions =
        widget?.control === 'select' && widget.options?.length
          ? widget.options.map((optionValue) => ({ value: optionValue, label: optionValue }))
          : undefined;
      const options = hint?.options?.length ? hint.options : scannedOptions;
      const control: WorkflowCandidate['control'] = mediaKind
        ? 'text'
        : (hint?.type ??
          (widget?.control === 'select' && options?.length ? 'select' : controlOf(value, hint?.type)));
      taken.add(key);
      const selected = targetToKey.has(id);
      const bindingKey = selected
        ? isPrompt
          ? 'text'
          : isNegativePrompt
            ? 'negativeText'
            : targetToKey.get(id)!
        : undefined;
      candidates.push({
        id,
        key,
        nodeId,
        classType,
        nodeTitle,
        field,
        kind,
        control,
        valueType: typeof value,
        ...(value !== undefined && !isLink(value) ? { defaultValue: value } : {}),
        ...(options?.length
          ? {
              options: options.map((option) => ({ ...option })),
              optionsSource: hint?.options?.length ? 'meta' : 'comfyui',
            }
          : {}),
        ...(hint?.min !== undefined ? { min: hint.min } : {}),
        ...(hint?.max !== undefined ? { max: hint.max } : {}),
        ...(hint?.step !== undefined ? { step: hint.step } : {}),
        selected,
        ...(bindingKey ? { bindingKey } : {}),
        label:
          hint?.label ??
          (kind === 'parameter'
            ? `${nodeTitle} · ${labelOfKey(field)}`
            : labelOfKey(key)),
        labelIsCustom: typeof hint?.label === 'string' && hint.label !== '',
      });
    }
  }

  return { candidates, bindings, missing };
}

// ---------------------------------------------------------------- 读

/** 工作流清单（左栏那一列）。 */
export function listWorkflowConfigs(): {
  ok: true;
  dir: string;
  defaultDir: string;
  isCustom: boolean;
  configs: WorkflowConfigSummary[];
  errors: CustomWorkflowDiagnostic[];
} {
  const status = customWorkflowsStatus();
  const configs: WorkflowConfigSummary[] = listCustomWorkflows().map((entry) => {
    const metaFile = metaFileNameOf(entry.file);
    let candidateCount = 0;
    let selectedCount = Object.keys(effectiveBindings(entry)).length;
    try {
      candidateCount = workflowCandidates(entry).candidates.length;
    } catch {
      // 模板读不到也别让整份清单崩掉：候选数按 0 报，诊断在下面
      candidateCount = 0;
      selectedCount = Object.keys(effectiveBindings(entry)).length;
    }
    const coverUrl = workflowCoverUrl(entry.id);
    return {
      id: entry.id,
      title: entry.title,
      file: entry.file,
      metaFile,
      hasMeta: existsSync(join(customWorkflowsDir(), metaFile)),
      category: entry.category,
      outputType: entry.outputType,
      modes: [...entry.modes],
      candidateCount,
      selectedCount,
      disabledCount: entry.disabledBindings.length,
      // v1.28：配图（没有就省略，前端按「未配图」画占位）
      ...(coverUrl ? { coverUrl } : {}),
      diagnostics: diagnosticsOf(entry.file, metaFile),
    };
  });
  return {
    ok: true,
    dir: status.dir,
    defaultDir: status.defaultDir ?? defaultCustomWorkflowsDir(),
    isCustom: status.isCustom === true,
    configs,
    errors: status.errors,
  };
}

/** 单个工作流的配置视图。 */
export function readWorkflowConfig(id: string): WorkflowConfigView {
  const entry = getCustomWorkflow(id);
  if (!entry) {
    throw new CustomWorkflowError(
      `未知的自定义工作流：${id}。请确认 JSON 已放进 ${customWorkflowsDir()}。`,
      404,
      'UNKNOWN_WORKFLOW',
    );
  }
  const metaFile = metaFileNameOf(entry.file);
  const metaPath = metaPathOf(entry);
  const { candidates, bindings, missing } = workflowCandidates(entry);
  // 可视化图：候选字段 id 一并带进去，图上就能把「可勾的行」标出来（点节点后右侧才有内容）
  const graph = buildWorkflowGraph(loadCustomWorkflowTemplate(entry), {
    outputNodeId: entry.outputNodeId,
    candidateIds: new Set(candidates.map((candidate) => candidate.id)),
  });
  const selected = candidates.filter((item) => item.selected).length;
  return {
    ok: true,
    dir: customWorkflowsDir(),
    defaultDir: defaultCustomWorkflowsDir(),
    isCustom: customWorkflowsStatus().isCustom,
    workflow: {
      id: entry.id,
      title: entry.title,
      file: entry.file,
      metaFile,
      metaPath,
      hasMeta: existsSync(metaPath),
      category: entry.category,
      outputType: entry.outputType,
      modes: [...entry.modes],
      timeoutMs: entry.timeoutMs,
      outputNodeId: entry.outputNodeId,
      promptNodeId: entry.promptNodeId,
      negativePromptNodeId: entry.negativePromptNodeId,
      promptTarget: entry.promptTarget,
      negativePromptTarget: entry.negativePromptTarget,
      requiredInputs: [...entry.requiredInputs],
    },
    candidates,
    graph,
    bindings,
    disabled: [...entry.disabledBindings],
    missing,
    totals: {
      fields: candidates.length,
      // 生效绑定里可能在模板里已经找不到（missing），所以按候选上的勾选数报，注释里写清口径
      selected,
      parameters: candidates.filter((item) => item.kind !== 'media').length,
      media: candidates.filter((item) => item.kind === 'media').length,
    },
    diagnostics: diagnosticsOf(entry.file, metaFile),
  };
}

// ---------------------------------------------------------------- 写

const BINDING_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
const PARAMETER_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'toggle', 'select']);
const OUTPUT_TYPES: ReadonlySet<string> = new Set(['images', 'videos', 'audios']);

function invalid(message: string, code = 'INVALID_WORKFLOW_CONFIG'): never {
  throw new CustomWorkflowError(message, 422, code);
}

/** 校验并归一化一条绑定位址：节点与字段都必须在模板里真实存在。 */
function validateBindingTarget(
  key: string,
  target: unknown,
  graph: PromptGraph,
): string | string[] | null {
  if (target === null) return null;
  const list = Array.isArray(target) ? target : [target];
  if (!list.length) invalid(`绑定 ${key} 没有任何位址。`);
  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) {
      invalid(`绑定 ${key} 的位址必须是字符串（如 "6.inputs.text"）。`);
    }
    const text = item.trim();
    const parsed = parseBindingTarget(text);
    if (!parsed) {
      invalid(`绑定 ${key} 的位址写法不对：${text}（应为 "节点id.inputs.字段"）。`);
    }
    assertTargetInGraph(key, parsed.nodeId, parsed.field, graph);
    result.push(text);
  }
  return result.length === 1 ? result[0] : result;
}

function assertTargetInGraph(
  key: string,
  nodeId: string,
  field: string,
  graph: PromptGraph,
): void {
  const node = graph[nodeId];
  if (!node || typeof node.class_type !== 'string') {
    invalid(`绑定 ${key} 指向的节点 ${nodeId} 在模板里不存在。`, 'BINDING_TARGET_MISSING');
  }
  const inputs = node.inputs ?? {};
  if (!(field in inputs)) {
    invalid(
      `绑定 ${key} 指向的字段 ${nodeId}.inputs.${field} 不存在（该节点有：${Object.keys(inputs).join('、') || '(无)'}）。`,
      'BINDING_TARGET_MISSING',
    );
  }
  if (isLink(inputs[field])) {
    invalid(
      `绑定 ${key} 指向的字段 ${nodeId}.inputs.${field} 是被连线喂的，改它会把上游节点顶掉。`,
      'BINDING_TARGET_LINKED',
    );
  }
}

/**
 * 保存配置：把面板上的完整状态写回 `<file>.meta.json`。
 *
 * 注意 bindings 是**整份替换**（不是合并）：面板每次都把「勾了哪些、关了哪些」全量发上来，
 * 合并语义会让「取消勾选」永远删不掉旧键。
 */
export function saveWorkflowConfig(id: string, input: unknown): WorkflowConfigView {
  const entry = getCustomWorkflow(id);
  if (!entry) {
    throw new CustomWorkflowError(
      `未知的自定义工作流：${id}。请确认 JSON 已放进 ${customWorkflowsDir()}。`,
      404,
      'UNKNOWN_WORKFLOW',
    );
  }
  if (!isRecord(input)) invalid('请求体必须是一个 JSON 对象。');

  const graph = loadCustomWorkflowTemplate(entry);
  const meta = readMetaObject(entry);

  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) invalid('title 不能为空。');
    const title = input.title.trim();
    if (title.length > 120) invalid('title 最长 120 个字符。');
    meta.title = title;
  }
  if (input.category !== undefined) {
    if (typeof input.category !== 'string' || !input.category.trim()) invalid('category 不能为空。');
    meta.category = input.category.trim().slice(0, 60);
  }
  if (input.outputType !== undefined) {
    const outputType = String(input.outputType);
    if (!OUTPUT_TYPES.has(outputType)) {
      invalid('outputType 只能是 images / videos / audios 之一。');
    }
    meta.outputType = outputType;
  }
  if (input.outputNodeId !== undefined) {
    if (input.outputNodeId === null || input.outputNodeId === '') {
      meta.outputNodeId = null;
    } else {
      const nodeId = String(input.outputNodeId).trim();
      if (!graph[nodeId]) invalid(`输出节点 ${nodeId} 在模板里不存在。`, 'OUTPUT_NODE_MISSING');
      meta.outputNodeId = nodeId;
    }
  }

  if (input.bindings !== undefined) {
    if (!isRecord(input.bindings)) invalid('bindings 必须是一个对象。');
    const bindings: Record<string, string | string[]> = {};
    const disabled: string[] = [];
    for (const [key, target] of Object.entries(input.bindings)) {
      if (!BINDING_KEY_PATTERN.test(key)) {
        invalid(`绑定键 ${JSON.stringify(key)} 不合法：只能用字母、数字、下划线，且不能以数字开头。`);
      }
      const normalized = validateBindingTarget(key, target, graph);
      if (normalized === null) disabled.push(key);
      else bindings[key] = normalized;
    }
    if (Object.keys(bindings).length) meta.bindings = bindings;
    else delete meta.bindings;
    // 显式关闭的推断键要留下来（null 是第三态，不能删）
    if (disabled.length) {
      const merged: Record<string, unknown> = { ...(isRecord(meta.bindings) ? meta.bindings : {}) };
      for (const key of disabled) merged[key] = null;
      meta.bindings = merged;
    }
  }

  if (input.parameters !== undefined) {
    if (!isRecord(input.parameters)) invalid('parameters 必须是一个对象。');
    const parameters: Record<string, Record<string, unknown>> = {};
    for (const [key, raw] of Object.entries(input.parameters)) {
      if (!BINDING_KEY_PATTERN.test(key)) invalid(`参数键 ${JSON.stringify(key)} 不合法。`);
      if (raw === null) continue;
      if (!isRecord(raw)) invalid(`parameters.${key} 必须是对象或 null。`);
      const hint: Record<string, unknown> = {};
      if (raw.label !== undefined) {
        if (typeof raw.label !== 'string') invalid(`parameters.${key}.label 必须是字符串。`);
        const label = raw.label.trim();
        if (label.length > 40) invalid(`parameters.${key}.label 最长 40 个字符。`);
        if (label) hint.label = label;
      }
      if (raw.type !== undefined) {
        const type = String(raw.type);
        if (!PARAMETER_TYPES.has(type)) {
          invalid(`parameters.${key}.type 只能是 text / number / toggle / select。`);
        }
        hint.type = type;
      }
      for (const field of ['min', 'max', 'step'] as const) {
        if (raw[field] === undefined) continue;
        const value = Number(raw[field]);
        if (!Number.isFinite(value)) invalid(`parameters.${key}.${field} 必须是数字。`);
        hint[field] = value;
      }
      if (Object.keys(hint).length) parameters[key] = hint;
    }
    if (Object.keys(parameters).length) meta.parameters = parameters;
    else delete meta.parameters;
  }

  if (input.defaults !== undefined) {
    if (!isRecord(input.defaults)) invalid('defaults 必须是一个对象。');
    const defaults: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.defaults)) {
      if (!BINDING_KEY_PATTERN.test(key)) invalid(`defaults 里的键 ${JSON.stringify(key)} 不合法。`);
      if (value === null) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        invalid(`defaults.${key} 只能是字符串 / 数字 / 布尔。`);
      }
      defaults[key] = value;
    }
    if (Object.keys(defaults).length) meta.defaults = defaults;
    else delete meta.defaults;
  }

  const path = metaPathOf(entry);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
  // 立刻丢掉扫描缓存：保存完马上 GET 就能看到新配置（不用等 2 秒 TTL）
  invalidateCustomWorkflows();
  return readWorkflowConfig(id);
}
