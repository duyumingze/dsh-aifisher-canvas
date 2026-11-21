import type * as React from 'react';
import {
  cloneCanvasNodes,
  deleteCanvasNodes,
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

  // ---- dsh-aifisher-canvas：Shift+D / Alt+D 复制并移动（补丁 3.16）----
  //
  // 和 Ctrl+C/V 的两点差别：
  //   ① 落点是「原地偏移 40px」而不是鼠标处，复制完直接进抓取（Blender 的 Shift+D）；
  //   ② Esc 取消时连这批复制的节点一起撤掉（粘贴错了只能再删一次）。
  //
  // 复制前先 pushHistory：把「上一次提交之后攒下的改动」（建节点这类不会自己提交的操作）
  // 顺手落成一步，撤销才不会跨过它跳回很早以前。落在同一状态上是空操作，没有副作用。
  const DUPLICATE_OFFSET = 40;
  const duplicateSelection = hooks.useCallback(() => {
    const selected = nodes.filter((node) => selectedNodeIds.includes(node.id));
    if (!selected.length) return null;
    if (hasGeneratingCanvasNodes(selected)) {
      window.alert(GENERATING_COPY_MESSAGE);
      return null;
    }
    const previousSelection = [...selectedNodeIds];
    const adapter = window.__FISHERAI_CANVAS_CLIPBOARD__;
    const { newNodes, idMap } = (adapter?.clone ?? cloneCanvasNodes)(snapshot(selected), {
      offset: DUPLICATE_OFFSET,
      createId,
      preserveParentConnections: true,
    });
    if (!newNodes.length) return null;
    pushHistory?.();
    setNodes((current) =>
      (adapter?.insert ?? insertClonedCanvasNodes)(current, newNodes, idMap, {
        preserveChildConnections: false,
      }),
    );
    setSelectedNodeIds(newNodes.map((node) => node.id));
    return {
      ids: newNodes.map((node) => node.id),
      nodes: newNodes,
      previousSelection,
    };
  }, [nodes, selectedNodeIds, createId, setNodes, setSelectedNodeIds, pushHistory]);

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
    /** 复制并移动（Shift+D）：Esc 要把这批复制的节点整个撤掉。 */
    removeOnCancel: boolean;
    /** 取消复制时把选区还给复制前那些节点。 */
    previousSelection: string[];
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
        // Shift+D 复制并移动：Esc = 连刚复制出来的整批节点一起取消（Blender 同款）。
        // 位置不用回正 —— 它们本来就站在复制时的偏移落点上，整批删掉即可；
        // 这时画布状态已经回到复制前，所以不必再往撤销栈里补一步。
        if (grab.removeOnCancel) {
          const adapter = window.__FISHERAI_CANVAS_CLIPBOARD__;
          setNodes((current) => (adapter?.delete ?? deleteCanvasNodes)(current, grab.ids));
          setSelectedNodeIds(grab.previousSelection);
          return;
        }
        // 取消：把位置放回起手那一刻（不记历史）
        setNodes((current) =>
          current.map((node) => {
            const start = grab.positions.get(node.id);
            return start ? { ...node, x: start.x, y: start.y } : node;
          }),
        );
        return;
      }
      // 复制并移动：复制这一下本身也算一步 —— 复制完没移动也要能 Ctrl+Z 撤回去。
      if (!grab.moved && !grab.removeOnCancel) return;
      const commitHistory = pushHistory;
      if (!commitHistory) return;
      // 等 React 把最后一帧位置提交完再记历史（和 vendor 拖节点松手后的 deferFrame 同一做法）
      const run = () => commitHistory();
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
      else window.setTimeout(run, 16);
    },
    [pushHistory, setNodes, setSelectedNodeIds],
  );

  const startGrab = hooks.useCallback((forced?: {
    ids?: string[];
    nodes?: CanvasClipboardNode[];
    previousSelection?: string[];
    removeOnCancel?: boolean;
  }) => {
    if (grabRef.current) return;
    // 「复制并移动」会传入刚复制出来的那批：那次 setNodes 还没回到 props，不能用 nodes 算。
    const sourceNodes = forced?.nodes ?? nodes;
    const sourceIds = forced?.ids ?? selectedNodeIds;
    const ids = sourceIds.filter((id) => sourceNodes.some((node) => node.id === id));
    if (!ids.length) return;
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of sourceNodes) {
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
      removeOnCancel: Boolean(forced?.removeOnCancel),
      previousSelection: forced?.previousSelection ?? ids,
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
      // 调色合成器（全屏模态层 .cg-root）开着时，画布快捷键一律让路。
      // 用户 2026-11-12 报「再次调色后点击保存退出到主页面，调色节点和新的输出图像会消失」：
      // 合成器里按 X 删的是合成节点，同一个按键以前会顺着冒泡把画布上**选中的调色节点**
      // 也删掉（打开合成器点的就是它），子节点的连线被一起清掉，下一轮落图就找不到源节点了。
      // 判定和打标在 src/client/canvas/knife.ts 的 compositorOwnsPointer() 是同一个属性。
      if (document.querySelector('[data-fisherai-compositor]')) return;
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
      // Shift+D / Alt+D = 复制选中节点并跟着鼠标移动（Blender 的 duplicate；Alt 是同义键）
      if (
        key === 'd' &&
        (event.shiftKey || event.altKey) &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        // 抓取中再按不算：一次手势只复制一批
        if (!grabRef.current) {
          event.preventDefault();
          const duplicated = duplicateSelection();
          if (duplicated) {
            startGrab({
              ids: duplicated.ids,
              nodes: [...nodes, ...duplicated.nodes],
              previousSelection: duplicated.previousSelection,
              removeOnCancel: true,
            });
          }
        }
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
    duplicateSelection,
  ]);

  return { handleCopy, handlePaste, hasCopiedNodes };
}
