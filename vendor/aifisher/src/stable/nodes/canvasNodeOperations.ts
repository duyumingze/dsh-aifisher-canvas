import type { Dispatch, SetStateAction } from 'react';
import { installNodeFramework } from './nodeFramework';
import { newNodeDimensions } from './nodeCreationDimensions';
// dsh-aifisher-canvas 追加：建节点要以指针为中心，尺寸跟画布同一套规则
import { nodeHeight, nodeWidth } from './canvasNodeRules';
import { installStableCanvasClipboard } from '../canvas/canvasClipboard';
import { connectCanvasNodes, type CanvasConnectionNode } from '../canvas/canvasConnections';
import type { CanvasViewport } from '../canvas/canvasNavigation';

export interface CanvasNode extends CanvasConnectionNode {
  x: number;
  y: number;
  kind?: string;
  comfyMode?: string;
  videoModel?: string;
  videoMode?: string;
}
interface Model {
  name: string;
  imageModes?: { value: string }[];
  videoModes?: { value: string }[];
  audioModes?: { value: string }[];
  languageModes?: { value: string }[];
  aspectRatios?: string[];
  resolutions?: string[];
}
export interface NodeRuntime {
  createId(): string;
  imageModels: Model[];
  videoModels: Model[];
  audioModels: Model[];
  textModels: Model[];
  templates: { id: string; inputs: { type: string }[] }[];
  mediaType(type: string): string;
  canConnect(
    source: CanvasNode,
    target: CanvasNode,
    nodes: CanvasNode[],
    port?: number,
  ): string | false | null;
  validateConnection(
    source: CanvasNode,
    target: CanvasNode,
    nodes: CanvasNode[],
    model?: string,
    mode?: string,
    port?: number,
  ): boolean;
}
export interface NodeOperationsOptions {
  nodes: CanvasNode[];
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
}
export interface NodeMenu {
  type: string;
  x: number;
  y: number;
  sourceNodeId?: string;
  sourceNodeIds?: string[];
  connectorSide?: 'left' | 'right';
  sourcePortIndex?: number;
}

/** Fresh media nodes use the project's last chosen dimensions, checked against their model. */
export function createCanvasNode(
  runtime: NodeRuntime,
  type: string,
  point: { x: number; y: number },
  projectId?: string,
): CanvasNode {
  // dsh-aifisher-canvas（v1.40）：新建节点的默认模型 = **上一次生成任务用过的那个模型**。
  // 记忆在浏览器半（src/canvas-ui/canvas/CanvasLastModel.ts），装配层把它注册成
  // globalThis.__FISHERAI_LAST_MODEL__(kind, names)：只返**还留在目录里**的名字，
  // 通道被删 / 取消勾选 / 改名就返回空 —— 这里照旧回落到目录第一个模型。
  const freshModel = (models: Model[], kind: string): Model | undefined => {
    const pick = (
      globalThis as {
        __FISHERAI_LAST_MODEL__?: (kind: string, names: string[]) => string;
      }
    ).__FISHERAI_LAST_MODEL__;
    if (typeof pick === 'function') {
      try {
        const remembered = pick(kind, models.map((entry) => entry.name));
        const hit = remembered ? models.find((entry) => entry.name === remembered) : undefined;
        if (hit) return hit;
      } catch {
        // 记忆层坏了不能拦住建节点
      }
    }
    return models[0];
  };
  const image = freshModel(runtime.imageModels, 'image'),
    video = freshModel(runtime.videoModels, 'video');
  const audio = freshModel(runtime.audioModels, 'audio'),
    text = freshModel(runtime.textModels, 'text');
  const upload = ['Upload Image', 'Upload Video', 'Upload Audio'].includes(type);
  const model =
    type === 'Image'
      ? image
      : type === 'Video'
        ? video
        : type === 'Audio'
          ? audio
          : type === 'Text'
            ? text
            : undefined;
  const template = type === 'ComfyUI' ? runtime.templates[0] : undefined;
  const node = installNodeFramework().createFresh({
    id: runtime.createId(),
    type,
    ...point,
    prompt: '',
    status: upload ? 'success' : 'idle',
    model: model?.name ?? (type === 'ComfyUI' ? 'ComfyUI' : 'Upload'),
    imageModel: type === 'Image' ? image?.name : undefined,
    videoModel: type === 'Video' ? video?.name : undefined,
    audioModel: type === 'Audio' ? audio?.name : undefined,
    textModel: type === 'Text' ? text?.name : undefined,
    imageMode: type === 'Image' ? (image?.imageModes?.[0]?.value ?? 'text-to-image') : undefined,
    videoMode: type === 'Video' ? (video?.videoModes?.[0]?.value ?? 'text-to-video') : undefined,
    audioMode: type === 'Audio' ? (audio?.audioModes?.[0]?.value ?? 'instrumental') : undefined,
    textMode: type === 'Text' ? (text?.languageModes?.[0]?.value ?? 'multimodal-chat') : undefined,
    comfyMode: template?.id,
    isCameraUIOpen: type === 'ComfyUI' ? true : undefined,
    aspectRatio: type === 'Video' ? '16:9' : '1:1',
    resolution: type === 'Video' ? '720p' : '1K',
    parentIds: template ? template.inputs.map(() => '') : [],
    projectId: projectId || undefined,
  }) as CanvasNode;
  if (type === 'Image' || type === 'Video') {
    const models = type === 'Image' ? runtime.imageModels : runtime.videoModels;
    const selectedModel = models.find((entry) => entry.name === node.model);
    Object.assign(node, newNodeDimensions(type, projectId, selectedModel));
  }
  return node;
}

export function updateCanvasNode(
  nodes: CanvasNode[],
  id: string,
  patch: Partial<CanvasNode>,
  runtime: NodeRuntime,
): CanvasNode[] {
  const original = nodes.find((node) => node.id === id);
  if (!original) return nodes;
  const updated = { ...original, ...patch };
  // dsh-aifisher-canvas（v1.40）：在节点上换模型就把这个模型记成「下一次新建节点的默认模型」。
  // 按字段名反推 kind 就够了（imageModel / videoModel / audioModel / textModel）。
  const rememberModel = (
    globalThis as {
      __FISHERAI_REMEMBER_MODEL__?: (kind: string, name: string) => void;
    }
  ).__FISHERAI_REMEMBER_MODEL__;
  if (typeof rememberModel === 'function') {
    const chosen: Array<[string, unknown]> = [
      ['image', patch.imageModel],
      ['video', patch.videoModel],
      ['audio', patch.audioModel],
      ['text', patch.textModel],
    ];
    for (const [kind, value] of chosen) {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name) continue;
      try {
        rememberModel(kind, name);
      } catch {
        // 记忆层坏了不能拦住改模型
      }
    }
  }
  if (updated.type === 'ComfyUI' && patch.comfyMode) {
    const template = runtime.templates.find((item) => item.id === patch.comfyMode);
    if (template) {
      updated.parentIds = template.inputs.map((_, index) => updated.parentIds?.[index] ?? '');
      updated.sourcePortIndices = template.inputs.map(
        (_, index) => updated.sourcePortIndices?.[index] ?? 0,
      );
    }
    if (patch.comfyMode === 'adjust-angle') updated.isCameraUIOpen = true;
  }
  if (
    patch.imageModel ||
    patch.videoModel ||
    patch.imageMode ||
    patch.videoMode ||
    patch.audioModel || patch.audioMode || patch.textModel || patch.languageMode || patch.textMode ||
    patch.comfyMode
  ) {
    const parents: string[] = [],
      ports: number[] = [];
    const indexed = updated.type === 'ComfyUI';
    const currentNodes = nodes.map((node) => (node.id === id ? updated : node));
    for (const [index, parentId] of (updated.parentIds ?? []).entries()) {
      const parent = currentNodes.find((node) => node.id === parentId);
      const sourcePort = updated.sourcePortIndices?.[index] ?? 0;
      const candidate = indexed
        ? updated
        : { ...updated, parentIds: parents, sourcePortIndices: ports };
      const valid =
        parent &&
        runtime.validateConnection(
          parent.kind === 'workflow' ? { ...parent, __fisherSourcePort: sourcePort } : parent,
          candidate,
          currentNodes,
          updated[`${updated.type.toLowerCase()}Model`] as string | undefined,
          (updated.type === 'Text' ? updated.languageMode || updated.textMode : updated[`${updated.type.toLowerCase()}Mode`] || updated.comfyMode) as string | undefined,
          indexed ? index : undefined,
        );
      if (valid || indexed) {
        parents.push(valid ? parentId : '');
        ports.push(valid ? sourcePort : 0);
      }
    }
    updated.parentIds = parents;
    if (updated.sourcePortIndices !== undefined || indexed) updated.sourcePortIndices = ports;
  }
  return nodes.map((node) => (node.id === id ? updated : node));
}

function worldPoint(x: number, y: number, viewport: CanvasViewport) {
  if (!Number.isFinite(viewport.zoom) || viewport.zoom <= 0) return undefined;
  const point = { x: (x - viewport.x) / viewport.zoom, y: (y - viewport.y) / viewport.zoom };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined;
}

export function createNodeOperations(options: NodeOperationsOptions, runtime: NodeRuntime) {
  const clipboard = installStableCanvasClipboard();
  const { setNodes, setSelectedNodeIds } = options;
  const addNode = (
    type: string,
    x: number,
    y: number,
    parentId: string | undefined,
    viewport: CanvasViewport,
    projectId?: string,
  ) => {
    const point = worldPoint(x, y, viewport);
    if (!point) return undefined;
    const created = createCanvasNode(runtime, type, point, projectId);
    // 用户 2026-10-30：「添加节点的时候节点位置不会以鼠标为中心点」
    created.x -= nodeWidth(created) / 2;
    created.y -= nodeHeight(created) / 2;
    setNodes((nodes) => {
      const parent = nodes.find((node) => node.id === parentId);
      if (parent) {
        if (created.type === 'ComfyUI') {
          if (created.parentIds?.length) created.parentIds[0] = parent.id;
        } else created.parentIds = [parent.id];
        if (created.type === 'Image Compare') {
          created.aspectRatio = parent.aspectRatio || '1:1';
          created.resultAspectRatio = parent.resultAspectRatio;
        }
      }
      return [...nodes, created];
    });
    setSelectedNodeIds([created.id]);
    return created.id;
  };
  const deleteNode = (id: string) => {
    setNodes((nodes) => clipboard.delete(nodes, [id]));
    setSelectedNodeIds((ids) => ids.filter((candidate) => candidate !== id));
  };
  const deleteNodes = (ids: string[]) => {
    setNodes((nodes) => clipboard.delete(nodes, ids));
    setSelectedNodeIds([]);
  };
  return {
    addNode,
    deleteNode,
    deleteNodes,
    updateNode: (id: string, patch: Partial<CanvasNode>) =>
      setNodes((nodes) => updateCanvasNode(nodes, id, patch, runtime)),
  };
}

/** New-node connections validate against each preceding insertion, including occupied slots. */
export function connectNewCanvasNode(
  nodes: CanvasNode[],
  sourceId: string,
  targetId: string,
  runtime: NodeRuntime,
  sourcePort = 0,
): CanvasNode[] {
  const source = nodes.find((node) => node.id === sourceId),
    target = nodes.find((node) => node.id === targetId);
  if (!source || !target) return nodes;
  let port: number | undefined, count: number | undefined;
  if (target.kind === 'workflow') {
    const workflow = window.__FISHERAI_WORKFLOW_NODES__;
    if (!workflow) return nodes;
    port = workflow.resolveAvailableInputSlot(target, source, sourcePort);
    if (port < 0 || !workflow.canConnect(target, source, port, sourcePort)) return nodes;
    count = workflow.getInputCapacity(target);
  } else if (target.type === 'ComfyUI') {
    const template =
      runtime.templates.find((item) => item.id === target.comfyMode) ?? runtime.templates[0];
    if (!template) return nodes;
    const media = runtime.mediaType(source.type);
    port = template.inputs.findIndex(
      (slot, index) => !target.parentIds?.[index] && (slot.type === 'any' || slot.type === media),
    );
    if (port < 0) return nodes;
    count = template.inputs.length;
  }
  const mode = runtime.canConnect(
    source.kind === 'workflow' ? { ...source, __fisherSourcePort: sourcePort } : source,
    target,
    nodes,
    port,
  );
  if (!mode) return nodes;
  if (target.type === 'Image Compare' && (target.parentIds?.length ?? 0) >= 2) return nodes;
  if ((target.type === 'Image Composite' || target.type === 'Color Grade') && (target.parentIds?.length ?? 0) >= 10) return nodes;
  return connectCanvasNodes(nodes, {
    parentId: sourceId,
    childId: targetId,
    sourcePortIndex: sourcePort,
    portIndex: port,
    inputCount: count,
    connectionMode: mode === 'default' ? undefined : mode,
    modeField:
      target.type === 'Image' ? 'imageMode' : target.type === 'Video' ? 'videoMode' : undefined,
  });
}

export function createNodeMenuOperations(
  options: NodeOperationsOptions & ReturnType<typeof createNodeOperations>,
  runtime: NodeRuntime,
) {
  return {
    handleSelectTypeFromMenu: (
      type: string,
      menu: NodeMenu,
      viewport: CanvasViewport,
      close: () => void,
      projectId?: string,
    ) => {
      if (type === 'DELETE') {
        if (menu.sourceNodeId) options.deleteNode(menu.sourceNodeId);
        close();
        return;
      }
      if (!['node-connector', 'add-nodes'].includes(menu.type) || !menu.sourceNodeId) {
        options.addNode(type, menu.x, menu.y, undefined, viewport, projectId);
        close();
        return;
      }
      const point = worldPoint(menu.x, menu.y, viewport);
      if (!point) {
        close();
        return;
      }
      const created = createCanvasNode(runtime, type, point, projectId);
      created.x -= nodeWidth(created) / 2;
      created.y -= nodeHeight(created) / 2;
      const ids = [
        ...new Set(menu.sourceNodeIds?.length ? menu.sourceNodeIds : [menu.sourceNodeId]),
      ];
      options.setNodes((nodes) => {
        const sources = ids.filter((id) => nodes.some((node) => node.id === id));
        if (!sources.length) return nodes;
        let next = [...nodes, created];
        const firstSource = nodes.find((node) => node.id === sources[0]);
        if (
          menu.connectorSide !== 'left' &&
          (created.type === 'Image Composite' || created.type === 'Color Grade') &&
          firstSource &&
          runtime.mediaType(firstSource.type) === 'image'
        ) {
          created.aspectRatio = firstSource.aspectRatio || '1:1';
          created.resultAspectRatio = firstSource.resultAspectRatio;
        }
        for (const id of sources)
          next =
            menu.connectorSide === 'left'
              ? connectNewCanvasNode(next, created.id, id, runtime)
              : connectNewCanvasNode(next, id, created.id, runtime, menu.sourcePortIndex ?? 0);
        return next;
      });
      options.setSelectedNodeIds([created.id]);
      close();
    },
  };
}
