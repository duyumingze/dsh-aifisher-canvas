/**
 * 【本文件是 dsh-aifisher-canvas 的覆盖补丁，不是上游原文】
 * 由 scripts/patches/aifisher/ 覆盖到 vendor/aifisher/ 下，源文件在 scripts/patches/ 里。
 *
 * 上游这里只认「内置 MiniMax H3」这一条本地工作流：节点 comfyMode 必须是 minimax-h3-t2va，
 * 其余内置工作流全部标记为 retired（点了就报「此内置工作流已停用」）。
 * 本插件的后端有「目录式自定义工作流」（用户把 ComfyUI 导出的 API JSON 丢进 workflows 目录），
 * 于是这里补上**通用本地工作流**那一条路：
 *
 *   handleMiniMaxH3T2VAGenerate(id)：
 *     comfyMode === 'minimax-h3-t2va' → 上游原逻辑（MiniMax 专用节点）
 *     其它 comfyMode（自定义工作流）  → runLocalWorkflow()：
 *        按能力清单给的骨架收集「正向提示词 / 负向提示词 / 参数 / 连进来的素材 URL」
 *        → POST /api/aifisher/canvas/comfy/<id>
 *        → 成功后在源节点右侧落一个结果节点（Upload Image/Video/Audio）并选中它
 *
 *   v1.21：
 *     - 负向提示词也能接文本节点（请求体里就是 negativeText 这个键），没接线就用节点上的
 *       负向输入框；两处都没有就不发（它是可选的）。
 *     - 结果节点按「源节点右侧的网格」落位（planLocalWorkflowOutput）：以前每次都落在同一个
 *       (x, y)，同一个节点生成四张图就是四张叠在一起（用户报障「生成之后它的图会互相遮盖」）。
 *
 * 复用上游同一个运行入口（runtime.run = __FISHERAI_VIDEO_WORKFLOWS__ 客户端），
 * 所以超时、错误形状、loading 状态语义都跟 MiniMax 那条完全一致。
 */
import type * as React from 'react';
import type { CanvasNode } from '../nodes/canvasNodeOperations';
import { nodeHeight, nodeWidth } from '../nodes/canvasNodeRules';
import { buildMiniMaxH3Request } from '../media/minimaxH3';
import {
  createVideoWorkflowClient,
  localWorkflowDefinition,
  localWorkflowOutputNodeType,
  type LocalWorkflowDefinition,
  type VideoWorkflowClient,
  type VideoWorkflowRequest,
} from '../media/videoWorkflows';

const interruptedMessage =
  '本地工作流结果未确认，请先检查 ComfyUI 任务和素材库；不会自动重新生成。';
export function interruptedLocalWorkflowNode<T extends Record<string, unknown>>(node: T): T {
  if (!node.localWorkflowOperationId) return node;
  return {
    ...node,
    localWorkflowOperationId: undefined,
    status: 'error',
    errorMessage: interruptedMessage,
  };
}
interface Binding {
  getNodes(): CanvasNode[];
  getProjectId(): string | undefined;
  isActive(): boolean;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  setSelectedNodeIds(ids: string[]): void;
}
interface Runtime {
  createId(): string;
  /** 第一个参数是工作流 id：内置 minimax-h3-t2va 或自定义 custom-… */
  run(
    workflowType: string,
    request: VideoWorkflowRequest,
  ): ReturnType<VideoWorkflowClient['run']>;
}
const retiredHandlers = [
  'handleChangeAngleGenerate',
  'handleUpscaleGenerate',
  'handleQwenInpaintGenerate',
  'handleQwenOutpaintGenerate',
  'handleQwenPoseGenerate',
  'handleZImageTurboT2IGenerate',
  'handleKleinT2IGenerate',
  'handleKleinI2IGenerate',
  'handleKleinM2IGenerate',
  'handleKleinIS2IGenerate',
  'handleAuxPreprocessorGenerate',
  'handleKleinOutpaintGenerate',
  'handleVoxCPM2CloneGenerate',
  'handleVoxCPM2VoiceDesignGenerate',
  'handleIndexTTS2VectorEmoCloneGenerate',
  'handleIndexTTS2VectorMultiEmoCloneGenerate',
  'handleIndexTTS2AudioEmoCloneGenerate',
  'handleIndexTTS2AudioMultiEmoCloneGenerate',
  'handleQwen3TTSGenerate',
  'handleQwen3CloneGenerate',
  'handleQwen3VoiceDesignGenerate',
  'handleSam3InteractiveGenerate',
  'handleSam3TextGenerate',
  'handleSam3PointGenerate',
] as const;

/** 连接进来的父节点上取文本：文本节点可能是 textContent / resultText / prompt。 */
function connectedText(node: CanvasNode | undefined): string {
  if (!node) return '';
  const candidate = [node.textContent, node.resultText, node.prompt, node.text].find(
    (value) => typeof value === 'string' && value !== '',
  );
  return typeof candidate === 'string' ? candidate : '';
}

/** 连接进来的父节点上取素材地址（画布内的相对 URL，host 会直接读盘交给 ComfyUI）。 */
function connectedMediaUrl(node: CanvasNode | undefined): string {
  if (!node) return '';
  const candidate = [
    node.resultUrl,
    node.url,
    node.lastFrame,
    Array.isArray(node.resultUrls) ? node.resultUrls[0] : undefined,
  ].find((value) => typeof value === 'string' && value !== '');
  return typeof candidate === 'string' ? candidate : '';
}

/** 按骨架收集请求体：提示词 / 参数 / 素材，缺必填项就报可读错误。 */
function buildLocalWorkflowBody(
  definition: LocalWorkflowDefinition,
  source: CanvasNode,
  nodes: readonly CanvasNode[],
  projectId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    projectId,
    nodeId: source.id,
    // 自定义工作流的模式来自 meta.modes，缺省就是 default
    mode: 'default',
  };
  const prompt = typeof source.prompt === 'string' ? source.prompt.trim() : '';
  const textParameter = definition.textParameter;
  const missing: string[] = [];
  const parentIds = Array.isArray(source.parentIds) ? source.parentIds : [];
  definition.inputs.forEach((slot, index) => {
    const parentId = parentIds[index];
    const parent = parentId ? nodes.find((node) => node.id === parentId) : undefined;
    const value = slot.type === 'text' ? connectedText(parent) : connectedMediaUrl(parent);
    if (value) {
      body[slot.id] = value;
      return;
    }
    // 提示词槽没接线不算缺输入：可以退化成节点上那个提示词输入框（见下面的 text 兜底）
    if (slot.type === 'text' && slot.id === textParameter && prompt) return;
    if (slot.required) missing.push(slot.label);
  });
  if (missing.length)
    throw new Error(`还缺这些输入：${missing.join('、')}。请先在节点左侧连上对应素材。`);

  // 提示词兜底：文本槽接了节点就用它的内容（上面已写进 body），否则用输入框里的文字
  if (textParameter && body[textParameter] === undefined && prompt) body[textParameter] = prompt;
  if (
    textParameter &&
    body[textParameter] === undefined &&
    definition.inputs.some((slot) => slot.type === 'text' && slot.required)
  )
    throw new Error('请填写提示词（或把一个文本节点连到提示词槽上）。');

  // 负向提示词（v1.21）：负向槽接了文本节点时上面那轮已经写进 body.negativeText；
  // 没接线就用节点上那个负向输入框（node.negativePrompt）。两处都没有就不发（它是可选的）。
  const negativeParameter = definition.negativeTextParameter ?? '';
  const negativePrompt =
    typeof source.negativePrompt === 'string' ? source.negativePrompt.trim() : '';
  if (negativeParameter && body[negativeParameter] === undefined && negativePrompt) {
    body[negativeParameter] = negativePrompt;
  }

  const stored = (source.comfyParams || {}) as Record<string, unknown>;
  for (const parameter of definition.parameters) {
    const value = stored[parameter.id];
    const resolved = value === undefined || value === '' ? parameter.default : value;
    if (resolved === undefined || resolved === null || resolved === '') continue;
    body[parameter.id] = resolved;
  }
  return body;
}

// ---------------------------------------------------------------- 结果节点自动整理（v1.21）

/** 同一列里相邻结果节点的间距；列与列之间留得更宽（图可以很宽）。 */
const OUTPUT_GAP = 32;
const OUTPUT_COLUMN_GAP = 120;
/** 一列最多排几个，第 4 个另起一列。 */
const OUTPUT_ROWS = 3;
/** 量不到尺寸时用的格子大小：要盖得住竖图（9:16 在 252 基准下是 448 高）与横图（16:9 是 448 宽）。 */
const OUTPUT_MIN_CELL_WIDTH = 520;
const OUTPUT_MIN_CELL_HEIGHT = 480;

interface OutputRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isLocalWorkflowOutput(node: CanvasNode, sourceId: string, outputType: string): boolean {
  return (
    node.id !== sourceId &&
    node.type === outputType &&
    Array.isArray(node.parentIds) &&
    node.parentIds[0] === sourceId
  );
}

function outputRectOf(node: CanvasNode): OutputRect {
  const width = Number(nodeWidth(node));
  const height = Number(nodeHeight(node));
  return {
    x: Number(node.x) || 0,
    y: Number(node.y) || 0,
    width: Number.isFinite(width) && width > 0 ? width : OUTPUT_MIN_CELL_WIDTH,
    height: Number.isFinite(height) && height > 0 ? height : OUTPUT_MIN_CELL_HEIGHT,
  };
}

/** 两块区域有任意重叠（落位时用：新图不许压住任何东西）。 */
function intersects(a: OutputRect, b: OutputRect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/** 两块区域「基本压在一起」（判断旧版本叠出来的堆时用：错开一点不算）。 */
function stackedOn(a: OutputRect, b: OutputRect): boolean {
  const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) return false;
  return (
    overlapWidth >= Math.min(a.width, b.width) * 0.8 &&
    overlapHeight >= Math.min(a.height, b.height) * 0.8
  );
}

export interface LocalWorkflowOutputPlan {
  /** 新结果节点落点 */
  position: { x: number; y: number };
  /** 需要顺手挪开的老结果（只在「它们本来就压在一起」时才给） */
  moved: Map<string, { x: number; y: number }>;
}

/**
 * 同一个节点反复生成时，结果节点以前**每次都落在同一个 (x, y)**，于是几张图叠成一张
 * （用户报障：「生成之后它的图会互相遮盖」）。
 *
 * 现在按「源节点右侧的网格」落位：第一列从上往下排 3 个，再往右开新列；
 * 落位前先避开所有已有节点（含用户手拖乱放的结果），所以新图不会压住旧图。
 * 另外：升级前留下的「压在一起」的老结果会顺手摆开 —— 但只动那些真的叠在一起的，
 * 用户自己摆好的位置不抢。
 */
export function planLocalWorkflowOutput(
  nodes: readonly CanvasNode[],
  source: CanvasNode,
  definition: LocalWorkflowDefinition,
): LocalWorkflowOutputPlan {
  const outputType = localWorkflowOutputNodeType(definition.outputType);
  const sourceWidth = Math.max(240, Number(nodeWidth(source)) || 640);
  const baseX = source.x + sourceWidth + OUTPUT_COLUMN_GAP;
  const siblings = nodes.filter((node) => isLocalWorkflowOutput(node, source.id, outputType));
  const measured = new Map(siblings.map((node) => [node.id, outputRectOf(node)]));
  const cells = [...measured.values()];
  const cellWidth = Math.max(OUTPUT_MIN_CELL_WIDTH, ...cells.map((rect) => rect.width));
  const cellHeight = Math.max(OUTPUT_MIN_CELL_HEIGHT, ...cells.map((rect) => rect.height));
  const cellAt = (index: number) => ({
    x: baseX + Math.floor(index / OUTPUT_ROWS) * (cellWidth + OUTPUT_GAP),
    y: source.y + (index % OUTPUT_ROWS) * (cellHeight + OUTPUT_GAP),
  });
  const siblingIds = new Set(siblings.map((node) => node.id));
  const taken: OutputRect[] = nodes
    .filter((node) => !siblingIds.has(node.id))
    .map(outputRectOf);
  const place = (rect: OutputRect): { x: number; y: number } => {
    for (let index = 0; index < 96; index += 1) {
      const position = cellAt(index);
      const area = { ...position, width: rect.width, height: rect.height };
      if (!taken.some((other) => intersects(area, other))) {
        taken.push(area);
        return position;
      }
    }
    const fallback = cellAt(taken.length);
    taken.push({ ...fallback, width: rect.width, height: rect.height });
    return fallback;
  };
  const moved = new Map<string, { x: number; y: number }>();
  const clash = siblings.some((node, index) =>
    siblings.some(
      (other, otherIndex) =>
        index < otherIndex && stackedOn(measured.get(node.id)!, measured.get(other.id)!),
    ),
  );
  if (clash) {
    // 先按阅读顺序（上→下、左→右）把这一堆的重排，再排新图
    const ordered = [...siblings].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const node of ordered) moved.set(node.id, place(measured.get(node.id)!));
  } else {
    for (const rect of measured.values()) taken.push(rect);
  }
  return {
    position: place({ ...cellAt(0), width: cellWidth, height: cellHeight }),
    moved,
  };
}

/** 结果节点：与 MiniMax 那条一致，落成画布上的媒体节点并接管连线。 */
export function localWorkflowOutputNode(
  source: CanvasNode,
  definition: LocalWorkflowDefinition,
  projectId: string,
  url: string,
  id: string,
  prompt: string,
  position?: { x: number; y: number },
): CanvasNode {
  return {
    id,
    projectId,
    type: localWorkflowOutputNodeType(definition.outputType),
    x: position?.x ?? source.x + (Number(source.width) || 720) + 120,
    y: position?.y ?? source.y,
    prompt,
    status: 'success',
    progress: 100,
    resultUrl: url,
    resultUrls: [url],
    parentIds: [source.id],
    model: definition.label,
  } as CanvasNode;
}

/** Only MiniMax remains a dedicated local workflow; imported workflows own their own runs. */
export function createCanvasLocalWorkflows(binding: Binding, runtime: Runtime) {
  const projectId = binding.getProjectId();
  const pending = new Map<string, string>();
  let disposed = false;
  const active = () => !disposed && binding.isActive() && binding.getProjectId() === projectId;
  const retired = (id: string) => {
    if (!active()) return;
    binding.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? {
              ...node,
              status: 'error',
              errorMessage: '此内置工作流已停用。请从本地工作流导入对应 ComfyUI API JSON 后运行。',
            }
          : node,
      ),
    );
  };
  const publishError = (id: string, message: string) => {
    if (!active()) return;
    binding.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? { ...node, status: 'error', progress: 0, errorMessage: message, localWorkflowOperationId: undefined }
          : node,
      ),
    );
  };
  /**
   * 通用本地工作流（目录式自定义模板）：
   * 收集参数 → 提交 → 结果落成一个新的媒体节点。逻辑与 MiniMax 那条同构，只是
   * 请求体由能力清单的骨架决定，输出节点类型由工作流的 outputType 决定。
   */
  const runLocalWorkflow = async (id: string, source: CanvasNode) => {
    const workflowId = String(source.comfyMode || '');
    const definition = localWorkflowDefinition(workflowId);
    if (!definition) {
      publishError(
        id,
        `本地工作流「${workflowId || '(未选择)'}」不在当前清单里（模板文件可能已被删除）。请在上方下拉框里重新选择一个工作流。`,
      );
      return;
    }
    if (!projectId) {
      publishError(id, '请先保存当前项目，再运行本地工作流。');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = buildLocalWorkflowBody(definition, source, binding.getNodes(), projectId);
    } catch (error) {
      publishError(id, error instanceof Error ? error.message : '本地工作流输入无效');
      return;
    }
    const token = runtime.createId();
    const outputId = runtime.createId();
    pending.set(id, token);
    binding.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? {
              ...node,
              status: 'loading',
              progress: 10,
              errorMessage: undefined,
              localWorkflowOperationId: token,
            }
          : node,
      ),
    );
    try {
      const result = await runtime.run(workflowId, {
        ...(body as unknown as VideoWorkflowRequest),
        projectId,
        nodeId: id,
        mode: 'default',
      });
      if (!result || !result.success || typeof result.url !== 'string' || !result.url)
        throw new TypeError(interruptedMessage);
      if (!active() || pending.get(id) !== token) return;
      binding.setNodes((nodes) => {
        // v1.21：结果节点按「源节点右侧的网格」落位，同一节点的多张图不再互相遮盖
        const plan = planLocalWorkflowOutput(nodes, source, definition);
        return [
          ...nodes.map((node) => {
            if (node.id === id)
              return {
                ...node,
                status: 'success',
                progress: 100,
                errorMessage: undefined,
                localWorkflowOperationId: undefined,
              };
            const moved = plan.moved.get(node.id);
            return moved ? { ...node, x: moved.x, y: moved.y } : node;
          }),
          localWorkflowOutputNode(
            source,
            definition,
            projectId,
            result.url,
            outputId,
            typeof body[definition.textParameter || ''] === 'string'
              ? String(body[definition.textParameter || ''])
              : '',
            plan.position,
          ),
        ];
      });
      binding.setSelectedNodeIds([outputId]);
    } catch (error) {
      const message =
        error instanceof TypeError ||
        error instanceof SyntaxError ||
        (error instanceof Error && error.name === 'AbortError')
          ? interruptedMessage
          : error instanceof Error
            ? error.message
            : interruptedMessage;
      publishError(id, message);
    } finally {
      if (pending.get(id) === token) pending.delete(id);
    }
  };
  return {
    ...(Object.fromEntries(retiredHandlers.map((name) => [name, retired])) as Record<
      (typeof retiredHandlers)[number],
      (id: string) => void
    >),
    async handleMiniMaxH3T2VAGenerate(id: string) {
      if (!active() || pending.has(id)) return;
      const source = binding.getNodes().find((node) => node.id === id);
      if (!source || source.localWorkflowOperationId) return;
      // 非内置工作流 = 画布上那个「通用本地工作流节点」，走通用那条路
      if (source.comfyMode !== 'minimax-h3-t2va') {
        await runLocalWorkflow(id, source);
        return;
      }
      let request: VideoWorkflowRequest;
      try {
        if (!projectId) throw new Error('请先保存当前项目，再运行本地工作流。');
        request = buildMiniMaxH3Request(binding.getNodes(), source, projectId);
      } catch (error) {
        binding.setNodes((nodes) =>
          nodes.map((node) =>
            node.id === id
              ? {
                  ...node,
                  status: 'error',
                  errorMessage: error instanceof Error ? error.message : 'MiniMax H3 输入无效',
                }
              : node,
          ),
        );
        return;
      }
      const token = runtime.createId(),
        outputId = runtime.createId();
      pending.set(id, token);
      const output: CanvasNode = {
        id: outputId,
        projectId,
        type: 'Upload Video',
        x: source.x + 1020,
        y: source.y,
        prompt: request.text,
        status: 'loading',
        progress: 10,
        parentIds: [id],
        model: 'MiniMax H3',
        aspectRatio: request.aspectRatio,
        resolution: `${request.megapixels} MP`,
        duration: request.duration,
        videoDuration: request.duration,
        localWorkflowOperationId: token,
      };
      binding.setNodes((nodes) => [
        ...nodes.map((node) =>
          node.id === id
            ? {
                ...node,
                status: 'loading',
                localWorkflowOperationId: token,
                errorMessage: undefined,
              }
            : node,
        ),
        output,
      ]);
      binding.setSelectedNodeIds([outputId]);
      const publish = (patch: Partial<CanvasNode>, sourcePatch: Partial<CanvasNode>) => {
        if (!active() || pending.get(id) !== token) return;
        binding.setNodes((nodes) =>
          nodes.map((node) => {
            if (node.localWorkflowOperationId !== token) return node;
            if (node.id === outputId)
              return { ...node, ...patch, localWorkflowOperationId: undefined };
            if (node.id === id)
              return { ...node, ...sourcePatch, localWorkflowOperationId: undefined };
            return node;
          }),
        );
      };
      try {
        const result = await runtime.run('minimax-h3-t2va', request);
        if (!result.success || typeof result.url !== 'string' || !result.url)
          throw new TypeError(interruptedMessage);
        publish(
          {
            status: 'success',
            resultUrl: result.url,
            progress: 100,
            networkUrl: null,
            errorMessage: undefined,
          },
          { status: 'idle', errorMessage: undefined },
        );
      } catch (error) {
        const message =
          error instanceof TypeError ||
          error instanceof SyntaxError ||
          (error instanceof Error && error.name === 'AbortError')
            ? interruptedMessage
            : error instanceof Error
              ? error.message
              : interruptedMessage;
        publish(
          { status: 'error', errorMessage: message },
          { status: 'error', errorMessage: message },
        );
      } finally {
        if (pending.get(id) === token) pending.delete(id);
      }
    },
    dispose() {
      if (!disposed && binding.getProjectId() === projectId) {
        const tokens = new Set(pending.values());
        binding.setNodes((nodes) =>
          nodes.map((node) =>
            tokens.has(String(node.localWorkflowOperationId))
              ? interruptedLocalWorkflowNode(node)
              : node,
          ),
        );
      }
      disposed = true;
      pending.clear();
    },
  };
}

interface Options {
  getNodes(): CanvasNode[];
  setNodes: Binding['setNodes'];
  setSelectedNodeIds: Binding['setSelectedNodeIds'];
  projectId?: string;
  enabled: boolean;
}
export function useCanvasLocalWorkflows(
  hooks: Pick<typeof React, 'useRef' | 'useEffect'>,
  options: Options,
  createId: () => string,
) {
  const live = hooks.useRef(options);
  live.current = options;
  const owner = hooks.useRef<ReturnType<typeof createCanvasLocalWorkflows> | null>(null);
  hooks.useEffect(() => {
    if (!options.enabled) return;
    const controller = createCanvasLocalWorkflows(
      {
        getNodes: () => live.current.getNodes(),
        getProjectId: () => live.current.projectId,
        isActive: () => live.current.enabled,
        setNodes: (update) => live.current.setNodes(update),
        setSelectedNodeIds: (ids) => live.current.setSelectedNodeIds(ids),
      },
      {
        createId,
        run: (workflowType, request) =>
          (window.__FISHERAI_VIDEO_WORKFLOWS__ ?? createVideoWorkflowClient()).run(
            workflowType,
            request,
          ),
      },
    );
    owner.current = controller;
    return () => {
      controller.dispose();
      if (owner.current === controller) owner.current = null;
    };
  }, [options.enabled, options.projectId, createId]);
  return {
    ...Object.fromEntries(
      retiredHandlers.map((name) => [name, (id: string) => owner.current?.[name]?.(id)]),
    ),
    handleMiniMaxH3T2VAGenerate: (id: string) => owner.current?.handleMiniMaxH3T2VAGenerate(id),
  };
}
