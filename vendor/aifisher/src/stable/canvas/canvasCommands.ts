import type * as React from 'react';
import {
  cloneCanvasNodes,
  hasGeneratingCanvasNodes,
  GENERATING_COPY_MESSAGE,
  insertClonedCanvasNodes,
  pointerToCanvasPoint,
  type CanvasClipboardNode,
  type CanvasClipboardViewport,
} from './canvasClipboard';

type ReactHooks = Pick<typeof React, 'useRef' | 'useCallback' | 'useEffect'>;
type SetNodes = React.Dispatch<React.SetStateAction<CanvasClipboardNode[]>>;

export interface CanvasCommandOptions {
  nodes: CanvasClipboardNode[];
  viewport: CanvasClipboardViewport;
  selectedNodeIds: string[];
  selectedConnection: unknown;
  setNodes: SetNodes;
  setSelectedNodeIds: (ids: string[]) => void;
  setContextMenu: (update: (menu: { isOpen: boolean }) => { isOpen: boolean }) => void;
  deleteNodes: (ids: string[]) => void;
  deleteSelectedConnection: (setNodes: SetNodes) => void;
  clearSelection: () => void;
  clearSelectionBox: () => void;
  undo: () => void;
  redo: () => void;
  autoAlignNodes: () => void;
  handleSaveWorkflow: () => void;
  focusOnNodes: (nodes: CanvasClipboardNode[], ids: string[]) => void;
  groupSelectedNodes: (ids: string[]) => void;
  /** 结束一次编辑时把当前状态推进撤销栈（G 抓取移动用；不给就不记历史）。 */
  pushHistory?: () => void;
}

function snapshot(nodes: CanvasClipboardNode[]): CanvasClipboardNode[] {
  // Preserve the existing persisted-node copy format, including unknown fields.
  return JSON.parse(JSON.stringify(nodes));
}

function isTextEditor(element: Element | null): boolean {
  return !!element?.closest('input,textarea,[contenteditable]');
}

/**
 * 键盘上按的是哪个字母（dsh-aifisher-canvas，补丁 3.8x）。
 *
 * 中文输入法开着时 `event.key` 会是 `Process` / `Unidentified`，只剩
 * `event.code`（KeyG / KeyX / KeyY）认得出按键 —— 用户 2026-11-12 报「按 g 之后按 xy
 * 没有锁轴」，所以两种都认，别让输入法状态把画布快捷键吞掉。
 */
function canvasHotkeyLetter(event: KeyboardEvent): string {
  const key = event.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  const code = event.code || '';
  if (code.length === 4 && code.startsWith('Key')) return code.slice(3).toLowerCase();
  return key;
}

/** Own the per-canvas clipboard and keyboard lifecycle using the original React runtime. */
export function useCanvasCommands(
  hooks: ReactHooks,
  createId: () => string,
  options: CanvasCommandOptions,
) {
  const clipboard = hooks.useRef<CanvasClipboardNode[]>([]);
  const pointer = hooks.useRef<{ clientX: number; clientY: number } | undefined>(undefined);
  const {
    nodes,
    viewport,
    selectedNodeIds,
    selectedConnection,
    setNodes,
    setSelectedNodeIds,
    setContextMenu,
    deleteNodes,
    deleteSelectedConnection,
    clearSelection,
    clearSelectionBox,
    undo,
    redo,
    autoAlignNodes,
    handleSaveWorkflow,
    focusOnNodes,
    groupSelectedNodes,
    pushHistory,
  } = options;

  hooks.useEffect(() => {
    const track = (event: PointerEvent) => {
      pointer.current = { clientX: event.clientX, clientY: event.clientY };
    };
    window.addEventListener('pointermove', track, { passive: true });
    return () => {
      window.removeEventListener('pointermove', track);
      pointer.current = undefined;
      clipboard.current = [];
    };
  }, []);

  const insertCopy = hooks.useCallback(
    (source: CanvasClipboardNode[], preserveConnections: boolean) => {
      if (!source.length) return;
      const bounds = document.getElementById('canvas-background')?.getBoundingClientRect();
      const targetPoint = pointerToCanvasPoint(pointer.current, viewport, bounds);
      const adapter = window.__FISHERAI_CANVAS_CLIPBOARD__;
      const { newNodes, idMap } = (adapter?.clone ?? cloneCanvasNodes)(snapshot(source), {
        offset: preserveConnections ? 50 : 20,
        createId,
        preserveParentConnections: preserveConnections,
        targetPoint,
      });
      setNodes((current) =>
        (adapter?.insert ?? insertClonedCanvasNodes)(current, newNodes, idMap, {
          preserveChildConnections: preserveConnections,
        }),
      );
      setSelectedNodeIds(newNodes.map((node) => node.id));
    },
    [viewport, createId, setNodes, setSelectedNodeIds],
  );

  const handleCopy = hooks.useCallback(() => {
    if (selectedNodeIds.length) {
      const selected = nodes.filter((node) => selectedNodeIds.includes(node.id));
      if (hasGeneratingCanvasNodes(selected)) {
        window.alert(GENERATING_COPY_MESSAGE);
        return;
      }
      clipboard.current = snapshot(selected);
    }
  }, [nodes, selectedNodeIds]);
  const handlePaste = hooks.useCallback(() => insertCopy(clipboard.current, true), [insertCopy]);
  const hasCopiedNodes = hooks.useCallback(() => clipboard.current.length > 0, []);

  // ---- dsh-aifisher-canvas：Blender 手感（G 抓取移动 / X 删除），见补丁 3.8x --------
  //
  // 位移以「起手位置 + 起手指针」为基准算，不累加增量：中途锁轴 / 缩放都不会漂。
  // 监听器只在抓取期间挂在 window 上（capture 阶段），落下 / 取消就摘掉；
  // 不用 effect 依赖 —— 拖动会不停改 nodes，effect 每次重跑会把手势打断。
  const grabRef = hooks.useRef<{
    ids: string[];
    positions: Map<string, { x: number; y: number }>;
    startX: number;
    startY: number;
    zoom: number;
    axis: 'x' | 'y' | null;
    moved: boolean;
    apply: () => void;
    stop: () => void;
  } | null>(null);

  const stopGrab = hooks.useCallback(
    (commit: boolean) => {
      const grab = grabRef.current;
      if (!grab) return;
      grabRef.current = null;
      grab.stop();
      if (!commit) {
        // 取消：把位置放回起手那一刻（不记历史）
        setNodes((current) =>
          current.map((node) => {
            const start = grab.positions.get(node.id);
            return start ? { ...node, x: start.x, y: start.y } : node;
          }),
        );
        return;
      }
      if (!grab.moved) return;
      const commitHistory = pushHistory;
      if (!commitHistory) return;
      // 等 React 把最后一帧位置提交完再记历史（和 vendor 拖节点松手后的 deferFrame 同一做法）
      const run = () => commitHistory();
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
      else window.setTimeout(run, 16);
    },
    [pushHistory, setNodes],
  );

  const startGrab = hooks.useCallback(() => {
    if (grabRef.current) return;
    const ids = selectedNodeIds.filter((id) => nodes.some((node) => node.id === id));
    if (!ids.length) return;
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      if (ids.includes(node.id)) positions.set(node.id, { x: node.x, y: node.y });
    }
    const origin = pointer.current ?? { clientX: 0, clientY: 0 };
    const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
    const grab: NonNullable<typeof grabRef.current> = {
      ids,
      positions,
      startX: origin.clientX,
      startY: origin.clientY,
      zoom,
      axis: null,
      moved: false,
      apply: () => undefined,
      stop: () => undefined,
    };
    const applyAt = (clientX: number, clientY: number) => {
      let dx = (clientX - grab.startX) / grab.zoom;
      let dy = (clientY - grab.startY) / grab.zoom;
      if (grab.axis === 'x') dy = 0;
      else if (grab.axis === 'y') dx = 0;
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) grab.moved = true;
      setNodes((current) =>
        current.map((node) => {
          const home = grab.positions.get(node.id);
          return home ? { ...node, x: home.x + dx, y: home.y + dy } : node;
        }),
      );
    };
    grab.apply = () => {
      const at = pointer.current;
      if (at) applyAt(at.clientX, at.clientY);
    };
    const onMove = (event: PointerEvent) => applyAt(event.clientX, event.clientY);
    const onDown = (event: PointerEvent) => {
      // 落下 / 取消这一下要吞掉：否则会立刻开始拖节点、或点空白把选区清掉
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 0) stopGrab(true);
      else stopGrab(false);
    };
    const onKey = (event: KeyboardEvent) => {
      // 输入法合成时 event.key 可能是 Process，用 canvasHotkeyLetter 退回 event.code
      const key = canvasHotkeyLetter(event);
      if (key === 'x' || key === 'y') {
        event.preventDefault();
        event.stopPropagation();
        grab.axis = grab.axis === key ? null : key;
        grab.apply();
        return;
      }
      if (event.key === 'Enter' || key === 'g') {
        event.preventDefault();
        event.stopPropagation();
        stopGrab(true);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        stopGrab(false);
      }
    };
    const previousCursor = document.body.style.cursor;
    grab.stop = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      document.body.style.cursor = previousCursor;
    };
    const onBlur = () => stopGrab(false);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    document.body.style.cursor = 'move';
    grabRef.current = grab;
  }, [nodes, pointer, selectedNodeIds, setNodes, stopGrab, viewport]);

  // 卸载时把还挂着的抓取监听摘掉（不靠 effect 依赖：拖动中 nodes 会不停变）
  hooks.useEffect(
    () => () => {
      grabRef.current?.stop();
      grabRef.current = null;
    },
    [],
  );

  hooks.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 焦点在输入框 / 文本节点里时让路。不再按 event.isComposing 整段跳过：
      // 中文输入法开着时单键（G / X / Y / A）不该被「合成状态」吃掉，
      // 真正的文本框已经由 isTextEditor 挡住了。
      if (
        isTextEditor(document.activeElement) ||
        (event.target instanceof Element && isTextEditor(event.target))
      )
        return;
      const key = canvasHotkeyLetter(event);
      // A = 全选节点 / Alt+A = 取消选择（Blender 手感；Ctrl+A 在画布里选节点而不是选网页文字）。
      // 用户 2026-11-12：「节点全选之后按 g 移动只会移动一个」——先得有个全选的口令。
      if (key === 'a' && !event.shiftKey) {
        if (event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          setSelectedNodeIds([]);
          return;
        }
        if (!event.altKey) {
          event.preventDefault();
          setSelectedNodeIds(nodes.map((node) => node.id));
          return;
        }
      }
      if (event.ctrlKey && key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if (event.ctrlKey && (key === 'y' || (event.shiftKey && key === 'z'))) {
        event.preventDefault();
        redo();
        return;
      }
      if (event.ctrlKey && key === 's') {
        event.preventDefault();
        handleSaveWorkflow();
        return;
      }
      if (event.ctrlKey && key === 'c') {
        handleCopy();
        return;
      }
      if (event.ctrlKey && key === 'g' && !event.shiftKey) {
        event.preventDefault();
        if (selectedNodeIds.length > 1) groupSelectedNodes(selectedNodeIds);
        return;
      }
      if (key === 'l' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (selectedNodeIds.length > 1) autoAlignNodes();
        return;
      }
      if (key === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        focusOnNodes(nodes, selectedNodeIds);
        return;
      }
      // G = 抓取移动（Blender 同款；再按 X / Y 锁轴）
      if (key === 'g' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        startGrab();
        return;
      }
      // X 与 Delete / Backspace 同义（Blender 里 X 就是删；Ctrl+X 之类不拦）
      if (
        key === 'delete' ||
        key === 'backspace' ||
        (key === 'x' && !event.ctrlKey && !event.metaKey && !event.altKey)
      ) {
        if (selectedNodeIds.length) {
          deleteNodes(selectedNodeIds);
          setContextMenu((menu) => ({ ...menu, isOpen: false }));
        } else if (selectedConnection) deleteSelectedConnection(setNodes);
      } else if (key === 'escape') {
        clearSelection();
        clearSelectionBox();
      }
      // Browser paste/media handling remains with the existing paste-event owner.
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    nodes,
    selectedNodeIds,
    selectedConnection,
    setNodes,
    setContextMenu,
    deleteNodes,
    deleteSelectedConnection,
    clearSelection,
    clearSelectionBox,
    undo,
    redo,
    autoAlignNodes,
    handleSaveWorkflow,
    focusOnNodes,
    groupSelectedNodes,
    handleCopy,
    startGrab,
  ]);

  return { handleCopy, handlePaste, hasCopiedNodes };
}
