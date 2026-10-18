import type * as React from 'react';
import {
  createNodeOperations,
  createNodeMenuOperations,
  createCanvasNode,
  updateCanvasNode,
  connectNewCanvasNode,
  type CanvasNode,
  type NodeRuntime,
} from './canvasNodeOperations';
import { installNodeFramework } from './nodeFramework';
import type {
  WorkflowCanvasNodeRecord,
  WorkflowVerifiedCanvasInsertion,
  WorkflowCanvasOutputValue,
} from '../local/workflowCanvasNodes';
import type { WorkflowCanvasBlueprint } from '../local/workflowManagerClient';

export { createNodeOperations, createNodeMenuOperations } from './canvasNodeOperations';
export { useCanvasContextMenu } from '../canvas/canvasContextHooks';
export { createCanvasTextActions } from '../canvas/canvasTextActions';
type Hooks = Pick<typeof React, 'useState' | 'useRef' | 'useCallback' | 'useEffect'>;
type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
interface NodeStore {
  getNodes(): CanvasNode[];
  setNodes: Setter<CanvasNode[]>;
  setSelected: Setter<string[]>;
}
interface StateRuntime extends NodeRuntime {
  getWidth(node: CanvasNode): number;
  layout(options: {
    nodes: CanvasNode[];
    selectedNodeIds: string[];
    setNodes: Setter<CanvasNode[]>;
  }): {
    autoAlignNodes: (...args: never[]) => void;
    gridLayoutNodes: (...args: never[]) => void;
  };
}
/**
 * dsh-aifisher-canvas 追加：节点搜索面板（Shift+A）的「按类型建节点」事件桥。
 *
 * 面板（src/canvas-ui/canvas/CanvasNodeSearch.tsx）拿不到画布的 store，所以走 window 事件；
 * 这里用**完整的** NodeRuntime 建节点 —— 与右键菜单的 createCanvasNode 是同一条路，
 * 于是默认模型、尺寸、连线端口全都一致。
 *
 * 监听器只在画布挂载时装一次：runtime 与 store 由 getter 每次读最新值。
 * 为什么不在 effect 里依赖它们（踩过）：那些引用每次渲染都会变，effect 会「卸载→重装」上千次，
 * 每次中间都有一小段没有监听器的窗口 —— 落在里面的点击会**静默丢失**
 * （现象：开头两次建节点成功，之后点了什么都不发生，画布与日志都不报错）。
 */
export function attachCanvasNodeCreateBridge(
  current: () => { runtime: NodeRuntime; getNodes: () => CanvasNode[]; setNodes: (nodes: CanvasNode[]) => void; setSelected: (ids: string[]) => void },
): () => void {
  const listener: EventListener = (event) => {
    try {
      const detail = (event as CustomEvent<{
        type?: string;
        comfyMode?: string;
        point?: { x?: number; y?: number };
      }>).detail;
      if (!detail || typeof detail.type !== 'string' || detail.type.length === 0) return;
      const point = detail.point;
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const { runtime, getNodes, setNodes, setSelected } = current();
      (window as { __DSH_NODE_CREATE_CALLS__?: number }).__DSH_NODE_CREATE_CALLS__ =
        ((window as { __DSH_NODE_CREATE_CALLS__?: number }).__DSH_NODE_CREATE_CALLS__ ?? 0) + 1;
      let node = createCanvasNode(runtime, detail.type, { x: point.x, y: point.y }, undefined);
      if (detail.comfyMode && node.type === 'ComfyUI') {
        const updated = updateCanvasNode([node], node.id, { comfyMode: detail.comfyMode }, runtime);
        if (updated[0]) node = updated[0];
      }
      setNodes([...getNodes(), node]);
      setSelected([node.id]);
    } catch (error) {
      // 静默失败会让用户看到「面板能开、候选能选，但点了不出节点」——
      // 这种「什么都不发生」最难排查，所以这里必须把原因喊出来。
      console.error('[aifisher-canvas] 建节点失败', error);
    }
  };
  window.addEventListener('fisherai:add-canvas-node', listener);
  return () => window.removeEventListener('fisherai:add-canvas-node', listener);
}

function workflowNode(node: CanvasNode | undefined): node is CanvasNode & WorkflowCanvasNodeRecord {
  return node?.type === 'ComfyUI' && node.kind === 'workflow';
}
function eventDetail<T>(event: Event): T {
  return (event as CustomEvent<T>).detail;
}

/** Listeners act on one live store; no side effects run inside React state updaters. */
export function attachWorkflowNodeEvents(
  store: NodeStore,
  runtime: Pick<StateRuntime, 'getWidth' | 'createId'>,
) {
  const frames = new Set<number>();
  const listeners = new Map<string, EventListener>();
  const listen = <T>(name: string, handler: (detail: T) => void) => {
    const listener: EventListener = (event) => handler(eventDetail<T>(event));
    listeners.set(name, listener);
    window.addEventListener(name, listener);
  };
  const capture = (nodes: CanvasNode[], id: string) =>
    window.__FISHERAI_WORKFLOW_NODES__?.captureExample(nodes, id);
  listen<
    | WorkflowCanvasBlueprint
    | {
        blueprint: WorkflowCanvasBlueprint;
        verified?: WorkflowVerifiedCanvasInsertion;
        requestId?: string;
      }
  >('fisherai:add-workflow-node', (detail) => {
    const adapter = window.__FISHERAI_WORKFLOW_NODES__;
    if (!adapter || !detail) return;
    const request = 'blueprint' in detail ? detail : { blueprint: detail };
    const blueprint = request.blueprint;
    if (!blueprint) return;
    const before = store.getNodes();
    const definitionId = blueprint.workflowRef?.definitionId;
    if (definitionId)
      before
        .filter(workflowNode)
        .filter((node) => node.workflowRef?.definitionId === definitionId)
        .some((node) => capture(before, node.id));
    const position = {
      x: before.length
        ? Math.max(...before.map((node) => node.x + runtime.getWidth(node))) + 80
        : 160,
      y: before.length ? Math.min(...before.map((node) => node.y)) : 140,
    };
    const inserted = request.verified
      ? adapter.instantiateVerifiedRun(blueprint, request.verified, position)
      : adapter.instantiateExample(blueprint, position);
    const nodes = inserted.nodes as CanvasNode[];
    if (!nodes.length || nodes.some((node) => before.some((existing) => existing.id === node.id)))
      return;
    const after = [...before, ...nodes];
    store.setNodes(after);
    store.setSelected(inserted.selectedNodeIds);
    const workflow = nodes.find(workflowNode);
    if (workflow) capture(after, workflow.id);
    const frame = requestAnimationFrame(() => {
      frames.delete(frame);
      if (!nodes.every((node) => store.getNodes().some((existing) => existing.id === node.id)))
        return;
      window.dispatchEvent(
        new CustomEvent('fisherai:workflow-canvas-inserted', {
          detail: {
            requestId: request.requestId,
            nodeIds: inserted.selectedNodeIds,
            workflowNodeId: workflow?.id ?? '',
            nodes,
          },
        }),
      );
    });
    frames.add(frame);
  });
  listen<{ nodeId: string; blueprint: WorkflowCanvasBlueprint }>(
    'fisherai:update-workflow-node',
    (detail) => {
      const adapter = window.__FISHERAI_WORKFLOW_NODES__;
      if (!adapter || !detail?.nodeId || !detail.blueprint) return;
      const before = store.getNodes();
      const target = before.find((node) => node.id === detail.nodeId);
      if (!workflowNode(target)) return;
      const updated = adapter.updateNode(target, detail.blueprint);
      store.setNodes(before.map((node) => (node.id === target.id ? updated : node)));
    },
  );
  listen<{ workflowNodeId: string; slotIndex: number; sourceNode: CanvasNode }>(
    'fisherai:add-workflow-input-node',
    (detail) => {
      const adapter = window.__FISHERAI_WORKFLOW_NODES__;
      if (
        !adapter ||
        !detail?.sourceNode?.id ||
        !Number.isInteger(detail.slotIndex) ||
        detail.slotIndex < 0
      )
        return;
      const nodes = store.getNodes(),
        slot = detail.slotIndex;
      const target = nodes.find((node) => node.id === detail.workflowNodeId);
      if (
        !workflowNode(target) ||
        nodes.some((node) => node.id === detail.sourceNode.id) ||
        target.parentIds?.[slot] ||
        !adapter
          .getInputSlots(target)
          .some((input) => input.slotIndex === slot && input.source === 'input-port')
      )
        return;
      const source = installNodeFramework().create({
        ...detail.sourceNode,
        x: target.x - 440,
        y: target.y + slot * (detail.sourceNode.type === 'Upload Audio' ? 240 : 380),
        parentIds: [],
        sourcePortIndices: [],
      }) as CanvasNode;
      if (!adapter.canConnect(target, source, slot, 0)) return;
      const capacity = adapter.getInputCapacity(target);
      const parents = Array.from(
        { length: capacity },
        (_, index) => target.parentIds?.[index] ?? '',
      );
      const ports = Array.from(
        { length: capacity },
        (_, index) => target.sourcePortIndices?.[index] ?? 0,
      );
      parents[slot] = source.id;
      ports[slot] = 0;
      const updated = {
        ...target,
        parentIds: parents,
        sourcePortIndices: ports,
        ...(target.executionState?.status === 'validation-error'
          ? { status: 'idle', executionState: { status: 'idle' as const }, errorMessage: undefined }
          : {}),
      };
      const after = [...nodes.map((node) => (node.id === target.id ? updated : node)), source];
      store.setNodes(after);
      store.setSelected([target.id, source.id]);
      capture(after, target.id);
    },
  );
  listen<{
    sourceNodeId: string;
    runId: string;
    outputs: (WorkflowCanvasOutputValue & { portIndex?: number })[];
  }>('fisherai:add-workflow-output-nodes', (detail) => {
    if (!detail?.sourceNodeId || !detail.runId || !Array.isArray(detail.outputs)) return;
    const nodes = store.getNodes(),
      source = nodes.find((node) => node.id === detail.sourceNodeId);
    if (!workflowNode(source)) return;
    // Replayed results are only accepted for the currently observed workflow run.
    if (source.executionState?.runId !== detail.runId) return;
    const existing = new Set(
      nodes
        .filter(
          (node) =>
            node.workflowSourceRunId === detail.runId && node.parentIds?.includes(source.id),
        )
        .map((node) => node.workflowSourcePortId),
    );
    const created: CanvasNode[] = [];
    for (const output of detail.outputs) {
      if (!output || typeof output.portId !== 'string' || existing.has(output.portId)) continue;
      existing.add(output.portId);
      const type =
        output.mediaKind === 'video'
          ? 'Upload Video'
          : output.mediaKind === 'audio'
            ? 'Upload Audio'
            : ['image', 'mask'].includes(output.mediaKind)
              ? 'Upload Image'
              : 'Text';
      const value =
        typeof output.value === 'string'
          ? output.value
          : output.value === undefined
            ? ''
            : JSON.stringify(output.value, null, 2);
      created.push({
        id: runtime.createId(),
        type,
        x: source.x + runtime.getWidth(source) + 180,
        y: source.y + created.length * 360,
        title: output.label || '工作流结果',
        prompt: value || source.title || '',
        textContent: type === 'Text' ? value : undefined,
        status: 'success',
        progress: 100,
        resultUrl: typeof output.url === 'string' ? output.url : undefined,
        parentIds: [source.id],
        sourcePortIndices: [
          Number.isInteger(output.portIndex) && Number(output.portIndex) >= 0
            ? Number(output.portIndex)
            : 0,
        ],
        workflowSourceRunId: detail.runId,
        workflowSourcePortId: output.portId,
        model: source.title || 'ComfyUI 工作流',
        projectId: source.projectId,
      });
    }
    if (!created.length) return;
    const after = [...nodes, ...created];
    store.setNodes(after);
    store.setSelected(created.map((node) => node.id));
    capture(after, source.id);
  });
  return () => {
    listeners.forEach((listener, name) => window.removeEventListener(name, listener));
    frames.forEach(cancelAnimationFrame);
  };
}

export function useCanvasNodes(hooks: Hooks, runtime: StateRuntime) {
  const [nodes, publishNodes] = hooks.useState<CanvasNode[]>([]);
  const current = hooks.useRef(nodes);
  const [selectedNodeIds, setSelectedNodeIds] = hooks.useState<string[]>([]);
  const setNodes = hooks.useCallback<Setter<CanvasNode[]>>((update) => {
    const next = typeof update === 'function' ? update(current.current) : update;
    current.current = next;
    publishNodes(next);
  }, []);
  const getNodes = hooks.useCallback(() => current.current, []);
  const operations = createNodeOperations({ nodes, setNodes, setSelectedNodeIds }, runtime);
  const menu = createNodeMenuOperations(
    { nodes, setNodes, setSelectedNodeIds, ...operations },
    runtime,
  );
  const layout = runtime.layout({ nodes, setNodes, selectedNodeIds });
  const getWidth = runtime.getWidth,
    createId = runtime.createId;
  hooks.useEffect(
    () =>
      attachWorkflowNodeEvents(
        { getNodes, setNodes, setSelected: setSelectedNodeIds },
        { getWidth, createId },
      ),
    [getNodes, setNodes, getWidth, createId],
  );
  // dsh-aifisher-canvas 追加：节点搜索面板（Shift+A）的「按类型建节点」出口。
  // 只在挂载时装一次监听器，runtime/store 走 ref 读最新值 —— 依赖数组写它们会让
  // effect 每次渲染都重装（中间有一小段没监听器的空档，事件正好落在里面就静默丢失）。
  const nodeCreateRef = hooks.useRef({ runtime, getNodes, setNodes, setSelected: setSelectedNodeIds });
  nodeCreateRef.current = { runtime, getNodes, setNodes, setSelected: setSelectedNodeIds };
  hooks.useEffect(
    () => attachCanvasNodeCreateBridge(() => nodeCreateRef.current),
    [],
  );
  const selectedId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : undefined;
  const networkUrl = nodes.find((node) => node.id === selectedId)?.networkUrl;
  hooks.useEffect(() => {
    if (!selectedId || typeof networkUrl !== 'string' || !networkUrl) return;
    const controller = new AbortController();
    void fetch('/api/aifisher/canvas/verify-tos-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ networkUrl }),
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (!controller.signal.aborted && result?.exists === false)
          setNodes((latest) =>
            latest.map((node) =>
              node.id === selectedId && node.networkUrl === networkUrl
                ? { ...node, networkUrl: undefined }
                : node,
            ),
          );
      })
      .catch(() => {
        /* Verification failure is not evidence that an asset has expired. */
      });
    return () => controller.abort();
  }, [selectedId, networkUrl, setNodes]);
  return {
    nodes,
    setNodes,
    getNodes,
    selectedNodeIds,
    configureAgentNode: (nodes: CanvasNode[], id: string, patch: Partial<CanvasNode>) => updateCanvasNode(nodes, id, patch, runtime),
    createAgentNode: (type: string, point: { x: number; y: number }, projectId: string) => createCanvasNode(runtime, type, point, projectId),
    connectAgentNodes: (nodes: CanvasNode[], sourceId: string, targetId: string, sourcePort?: number) => connectNewCanvasNode(nodes, sourceId, targetId, runtime, sourcePort),
    setSelectedNodeIds,
    ...operations,
    ...menu,
    ...layout,
    clearSelection: () => setSelectedNodeIds([]),
  };
}
