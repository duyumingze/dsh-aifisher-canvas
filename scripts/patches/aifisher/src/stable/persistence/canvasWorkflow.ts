/**
 * ⚠️ 本文件是 **dsh-aifisher-canvas 的整文件覆盖补丁**，对应
 * `vendor/aifisher/src/stable/persistence/canvasWorkflow.ts`（每次构建由
 * scripts/vendor-aifisher.mjs 覆盖上去）。改这里，不要改 vendor 里的副本。
 *
 * 为什么必须覆盖（2026-10-20）：
 *   用户报障「画布助手操作了之后很容易保存不上」。复现后确认是上游这套乐观并发的
 *   一个**死局**，不是偶发网络问题：
 *     1. 保存撞上 409 → 上游会重读服务端版本做三向合并再重试（这一步是对的）；
 *     2. 但如果两边改了**同一个字段**，mergeWorkflow 抛 WorkflowConflictError，
 *        上游就把 `blocked` 置 true —— 之后**每一次**保存都在第一行直接抛错，
 *        POST 都不发，直到重新打开项目；
 *     3. 于是画布还能继续编辑、节点照常出现，但一个字都存不进去；页面上只有右下角
 *        一个「保存冲突」小提示，刷新一次才恢复（而且丢失期间的全部编辑）。
 *   助手在画布上批量改标题/提示词/坐标，正好是最容易和用户本地编辑撞同一字段的操作。
 *
 * 本补丁改三处（都在「怎么保存」上，不动上游的排版/渲染）：
 *   A. 保存/读取请求带 20s 超时。没有超时时，一次挂住的 POST 会让保存队列永远占着
 *      （canvasAutoSave 的 inFlight 一直 true），之后自动保存全被判成 busy，
 *      控制台一声不响，页面看着正常 —— 同一个「保存不上」的另一种形态。
 *   B. 三向合并失败时改走 rescueMerge（两边都保留：按 id 并集，同 id 以本窗口为准），
 *      让保存**一定落盘**，同时提示用户「已自动合并，请核对」。
 *   C. 删掉「冲突后永久封锁保存」：冲突只提示一次，下一次保存照常重读服务端再合并。
 *      宁可让某个字段以后到的为准，也不能让整份文档从此写不进去。
 */
import {useCanvasSaveFeedback} from './canvasSaveFeedback';
import type * as React from 'react';
import { freshProjectDocument, type ProjectDocument } from './canvasProjectDocument';
import { useCanvasProjectFiles } from './canvasProjectFiles';
import { createToast } from '../design/designSystem';
import { interruptedMediaNode } from '../media/mediaOperationRecovery';
import { interruptedLocalWorkflowNode } from '../generation/canvasLocalWorkflows';
import {
  mergeWorkflow,
  sameWorkflowValue,
  WorkflowConflictError,
  type WorkflowRecord,
} from './workflowMerge';

type Hooks = Pick<typeof React, 'useState' | 'useRef' | 'useEffect' | 'useCallback'>;
export interface CanvasWorkflowProps {
  nodes: WorkflowRecord[];
  groups: WorkflowRecord[];
  viewport: { x: number; y: number; zoom: number };
  canvasTitle: string;
  isMinimapOpen: boolean;
  setNodes: (nodes: WorkflowRecord[]) => void;
  setGroups: (groups: WorkflowRecord[]) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  setCanvasTitle: (title: string) => void;
  setEditingTitleValue: (title: string) => void;
  setViewport: (viewport: CanvasWorkflowProps['viewport']) => void;
  setIsMinimapOpen: (open: boolean) => void;
  onPanelOpen?: () => void;
}
interface SaveOptions {
  snapshot?: WorkflowRecord;
  createBackup?: boolean;
  savedBy?: string;
  savedAt?: number;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function content(document: WorkflowRecord) {
  return {
    title: document.title,
    nodes: document.nodes,
    groups: document.groups,
    viewport: document.viewport,
    isMinimapOpen: document.isMinimapOpen,
  };
}
function stale(): Error {
  return Object.assign(new Error('画布已切换，忽略旧保存结果。'), { code: 'STALE_WORKFLOW' });
}

/**
 * 保存前瘦身（补丁 D）：把节点上残留的大块内联数据（`lastFrame` 里按原尺寸
 * 存的 PNG 之类，单张 4–5MB）剔掉，只保留媒体文件 URL。
 *
 * 为什么必须做：项目文档一旦超过保存接口 32MiB 上限，POST 会被服务端直接掐断，
 * 浏览器只看到 `TypeError: Failed to fetch` —— 保存、自动保存、导出全部失败，
 * 界面上还看不出真正原因。历史项目里已经存进去的旧数据也靠这里兜住。
 */
const INLINE_DATA_LIMIT = 300_000;
function slimDocument(document: WorkflowRecord): WorkflowRecord {
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  let dropped = 0;
  const slimNodes = nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    let copy: Record<string, unknown> | null = null;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.length < INLINE_DATA_LIMIT || !value.startsWith('data:')) continue;
      copy ??= { ...(node as Record<string, unknown>) };
      delete copy[key];
      dropped += value.length;
    }
    return (copy ?? node) as WorkflowRecord;
  });
  if (!dropped) return document;
  console.warn(`[aifisher-canvas] 保存前剔除了 ${(dropped / 1048576).toFixed(1)}MB 内联数据（尾帧缩略图等）`);
  return { ...document, nodes: slimNodes };
}
function validateDocument(value: unknown, id?: string): WorkflowRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('项目数据格式无效。');
  const doc = value as WorkflowRecord;
  const revision = Number(doc.revision ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('项目版本号无效。');
  doc.revision = revision;
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.groups) || (id && doc.id !== id))
    throw new Error('项目数据或编号不匹配。');
  for (const collection of [doc.nodes, doc.groups]) {
    const ids = new Set<string>();
    for (const item of collection) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id))
        throw new Error('项目节点或分组编号无效。');
      ids.add(item.id);
    }
  }
  if (doc.viewport !== undefined) {
    const view = doc.viewport as CanvasWorkflowProps['viewport'];
    if (!view || ![view.x, view.y, view.zoom].every(Number.isFinite) || view.zoom <= 0)
      throw new Error('项目视口无效。');
  }
  return doc;
}

/** 保存/读取的超时（补丁 A）：挂住的请求不能把保存队列永久占住。 */
const REQUEST_TIMEOUT_MS = 20_000;
function abortAfter(init?: RequestInit): RequestInit | undefined {
  if (init?.signal) return init;
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
      return { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  } catch {
    /* 老内核没有 AbortSignal.timeout：退回不带超时，至少行为和上游一致 */
  }
  return init;
}

async function request(url: string, init?: RequestInit): Promise<WorkflowRecord> {
  const response = await fetch(url, abortAfter(init));
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(typeof body.error === 'string' ? body.error : '项目保存或读取失败。'),
      {
        code: response.status === 409 ? 'REVISION_CONFLICT' : (body.code ?? response.status),
      },
    );
  return body;
}

/**
 * 冲突救援合并（补丁 B）。
 *
 * 三向合并只能处理「两边改的不是同一个字段」；同一字段两边都改了就只能二选一。
 * 上游的选择是「哪个都不写、停手」，代价是**整份文档从此保存不上**。这里改成
 * 「两边都保留、一定落盘」：
 *   - 节点/分组按 id 取并集，同一个 id 以**本窗口**（用户眼前这份）为准；
 *   - 服务端独有的条目接在后面（另一个窗口/上一页刚写进去的内容不丢）；
 *   - revision 用服务端的，保证这次 POST 能过乐观并发校验。
 * 被牺牲的只有「同一个 id 的同一个字段两边都改」的那一个字段，且会提示用户核对。
 */
function rescueMerge(remote: WorkflowRecord, local: WorkflowRecord): WorkflowRecord {
  const union = (remoteItems: unknown, localItems: unknown): unknown[] => {
    const localList = Array.isArray(localItems) ? localItems : [];
    const remoteList = Array.isArray(remoteItems) ? remoteItems : [];
    const seen = new Set<string>();
    const merged: unknown[] = localList.slice();
    for (const item of localList) {
      const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
      if (typeof id === 'string' && id) seen.add(id);
    }
    for (const item of remoteList) {
      const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
      if (typeof id === 'string' && id && seen.has(id)) continue;
      merged.push(item);
    }
    return merged;
  };
  return {
    ...remote,
    ...local,
    id: remote.id,
    revision: remote.revision,
    nodes: union(remote.nodes, local.nodes),
    groups: union(remote.groups, local.groups),
  };
}

/** Own workflow identity, network ordering, loaded baseline, and original panel behavior. */
export function useCanvasWorkflow(hooks: Hooks, props: CanvasWorkflowProps) {
  const [workflowId, setId] = hooks.useState<string | null>(null);
  const [workflowRevision, setRevision] = hooks.useState(0);
  const [isWorkflowPanelOpen, setPanel] = hooks.useState(false);
  const [workflowPanelY, setPanelY] = hooks.useState(0);
  const current = hooks.useRef(props);
  const base = hooks.useRef<WorkflowRecord | null>(null);
  const targetId = hooks.useRef<string | null>(null);
  const epoch = hooks.useRef(0);
  const loading = hooks.useRef(false);
  const queue = hooks.useRef<Promise<unknown>>(Promise.resolve());
  const notice = hooks.useRef<HTMLElement | null>(null);
  // React publishes state asynchronously. Retain the accepted merge until its
  // input catches up, including between queued saves.
  const pendingView = hooks.useRef<{
    before: WorkflowRecord;
    displayed: WorkflowRecord;
    after: WorkflowRecord;
    replacement?: boolean;
  } | null>(null);
  hooks.useEffect(() => {
    current.current = props;
  });
  const dismiss = hooks.useCallback(() => {
    notice.current?.remove();
    notice.current = null;
  }, []);
  hooks.useEffect(
    () => () => {
      epoch.current += 1;
      dismiss();
    },
    [dismiss],
  );

  const displayedView = hooks.useCallback(() => {
    const p = current.current;
    return {
      title: p.canvasTitle,
      nodes: p.nodes,
      groups: p.groups,
      viewport: p.viewport,
      isMinimapOpen: p.isMinimapOpen,
    };
  }, []);
  const view = hooks.useCallback(() => {
    const raw = displayedView();
    const pending = pendingView.current;
    if (!pending) return raw;
    // A user may edit an accepted merge before React has committed it. Rebase the
    // committed UI changes first so that such edits are not competing branches.
    const displayed = displayedView();
    if (pending.replacement) {
      // A file opens an entirely new document. Until React commits it, the old
      // display is not an edit of that document. Once committed, the canvas
      // may normalize newly inserted nodes (e.g. empty text fields); merge those
      // against the imported graph instead of treating them as competing adds.
      if (sameWorkflowValue(displayed, pending.displayed)) return pending.after as typeof raw;
      const merged = content(mergeWorkflow(pending.after, displayed, raw));
      pendingView.current = sameWorkflowValue(raw, merged) ? null : {
        before: copy(raw), displayed: copy(displayed), after: copy(merged),
      };
      return merged as typeof raw;
    }
    const accepted = content(mergeWorkflow(pending.displayed, displayed, pending.after));
    const merged = content(mergeWorkflow(pending.before, raw, accepted));
    if (sameWorkflowValue(raw, merged)) {
      pendingView.current = null;
    } else {
      pendingView.current = { before: copy(raw), displayed: copy(displayed), after: copy(merged) };
    }
    return merged as typeof raw;
  }, [displayedView]);
  hooks.useEffect(() => {
    // Observe committed display states even when there is no save between them.
    // A genuine conflict is reported by the save operation, never from render.
    if (pendingView.current) {
      try {
        view();
      } catch {
        /* Keep both baselines for explicit conflict handling. */
      }
    }
  });
  const apply = hooks.useCallback((document: WorkflowRecord, includeViewport = true) => {
    const p = current.current;
    const title = typeof document.title === 'string' ? document.title : 'Untitled';
    p.setNodes(document.nodes as WorkflowRecord[]);
    p.setGroups(document.groups as WorkflowRecord[]);
    p.setCanvasTitle(title);
    p.setEditingTitleValue(title);
    if (includeViewport && document.viewport)
      p.setViewport(document.viewport as CanvasWorkflowProps['viewport']);
    if (includeViewport && typeof document.isMinimapOpen === 'boolean')
      p.setIsMinimapOpen(document.isMinimapOpen);
  }, []);
  const showConflict = hooks.useCallback(() => {
    if (notice.current) return;
    const element = createToast({
      message: '保存冲突：当前编辑仍保留，尚未全部保存。可下载副本后重新打开项目核对。',
      tone: 'danger',
    });
    element.dataset.fisheraiWorkflowConflict = 'true';
    Object.assign(element.style, {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      maxWidth: '420px',
      zIndex: '10000',
    });
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '下载当前副本';
    button.className = 'fisherai-button';
    button.style.marginTop = '10px';
    button.addEventListener('click', () => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify({ ...base.current, ...displayedView() }, null, 2)], {
          type: 'application/json',
        }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'canvas-conflict.json';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    element.append(document.createElement('br'), button);
    document.body.append(element);
    notice.current = element;
  }, [displayedView]);
  /**
   * 「已自动合并」提示（补丁 B）：不是失败，只是告诉用户某处被合并过、值得核对。
   * 8 秒后自己消失，不挡操作。
   */
  const showMergedNotice = hooks.useCallback((message: string) => {
    if (notice.current) return;
    const element = createToast({ message, tone: 'neutral' });
    Object.assign(element.style, {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      maxWidth: '420px',
      zIndex: '10000',
    });
    document.body.append(element);
    notice.current = element;
    window.setTimeout(() => {
      if (notice.current === element) {
        element.remove();
        notice.current = null;
      }
    }, 8000);
  }, []);

  const handleSaveWorkflow = hooks.useCallback(
    (coverUrl?: string, folderId?: string | null, options: SaveOptions = {}) => {
      const owner = epoch.current;
      const run = async () => {
        if (owner !== epoch.current || loading.current) throw stale();
        // 补丁 C：这里原来有一道 `if (blocked.current) throw WorkflowConflictError('document')`
        // —— 一次字段级冲突就会让它之后每次都直接抛错，整份文档再也存不进去。
        // 现在不再拦截：每次保存都照常走「POST → 409 → 重读服务端 → 合并 → 重发」。
        try {
          targetId.current ??= crypto.randomUUID();
          const original = copy(
            base.current ?? {
              id: targetId.current,
              revision: 0,
              nodes: [],
              groups: [],
              title: 'Untitled',
            },
          );
          const startView = copy(view());
          let draft = copy({
            ...original,
            ...startView,
            id: targetId.current,
            revision: Number(original.revision ?? 0),
            ...(folderId !== undefined ? { folderId } : {}),
            ...(coverUrl !== undefined ? { coverUrl } : {}),
            createBackup: !!options.createBackup,
            lastSavedBy: options.savedBy,
            lastSavedAt: options.savedAt,
          });
          const post = (document: WorkflowRecord) =>
            request('/api/aifisher/canvas/workflows', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // 瘦身只作用于本次请求体：大块内联尾帧不进文档，避免顶爆接口体积上限。
              body: JSON.stringify(slimDocument(document)),
            });
          let result: WorkflowRecord;
          let rescued = false;
          try {
            result = await post(draft);
          } catch (error) {
            if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error;
            if (owner !== epoch.current) throw stale();
            const remote = validateDocument(
              await request(`/api/aifisher/canvas/workflows/${encodeURIComponent(String(draft.id))}`),
              String(draft.id),
            );
            if (owner !== epoch.current) throw stale();
            try {
              draft = mergeWorkflow(original, draft, remote) as typeof draft;
            } catch (mergeError) {
              // 同一个字段两边都改了：三向合并救不了 → 两边都保留，保证写得进去。
              if (!(mergeError instanceof WorkflowConflictError)) throw mergeError;
              draft = rescueMerge(remote, draft) as typeof draft;
              rescued = true;
            }
            result = await post(draft);
          }
          if (owner !== epoch.current) throw stale();
          if (
            result.success === false ||
            result.id !== draft.id ||
            typeof result.revision !== 'number' ||
            !Number.isInteger(result.revision) ||
            result.revision <= Number(draft.revision)
          )
            throw new Error('保存回执无效，尚不能确认保存成功。');
          const latestView = copy(view());
          const unchanged = sameWorkflowValue(startView, latestView);
          const saved: WorkflowRecord = { ...draft, revision: result.revision };
          delete saved.createBackup;
          base.current = saved;
          setId(String(result.id));
          setRevision(Number(result.revision));
          if (!sameWorkflowValue(startView, content(draft))) {
            try {
              const rebased = unchanged
                ? saved
                : mergeWorkflow(
                    { ...original, ...startView },
                    { ...original, ...latestView },
                    saved,
                  );
              pendingView.current = {
                before: copy(displayedView()),
                displayed: copy(displayedView()),
                after: copy(content(rebased)),
              };
              apply(rebased);
            } catch {
              // 这里的合并失败只影响「界面上要不要回填」，保存本身已经成功了。
              showConflict();
              return { id: result.id, revision: result.revision, unchanged: false };
            }
          }
          if (rescued) {
            dismiss();
            showMergedNotice('保存冲突已自动合并：两边的内容都保留了，请核对最近这一处改动。');
          } else dismiss();
          return { id: result.id, revision: result.revision, unchanged };
        } catch (error) {
          if (
            owner === epoch.current &&
            (error as { code?: string }).code === 'REVISION_CONFLICT'
          ) {
            showConflict();
          }
          throw error;
        }
      };
      const operation = queue.current.then(run, run);
      queue.current = operation.catch(() => undefined);
      return operation;
    },
    [view, displayedView, apply, dismiss, showConflict, showMergedNotice],
  );

  const handleLoadWorkflow = hooks.useCallback(
    async (id: string) => {
      const owner = ++epoch.current;
      loading.current = true;
      queue.current = Promise.resolve();
      try {
        const isPublic = id.startsWith('public:');
        const rawId = isPublic ? id.slice(7) : id;
        const data = validateDocument(
          await request(
            `/api/aifisher/canvas/${isPublic ? 'public-workflows' : 'workflows'}/${encodeURIComponent(rawId)}`,
          ),
          isPublic ? undefined : rawId,
        );
        if (owner !== epoch.current) return null;
        const document = copy(data);
        if (isPublic) {
          document.id = null;
          document.revision = 0;
          document.status = 'work';
          document.folderId = null;
          delete document.createdAt;
          delete document.updatedAt;
        }
        base.current = copy(document);
        document.nodes = (document.nodes as WorkflowRecord[]).map(node => interruptedLocalWorkflowNode(interruptedMediaNode(node)));
        targetId.current = isPublic ? null : rawId;
        pendingView.current = {
          before: copy(displayedView()),
          displayed: copy(displayedView()),
          after: copy(content({ ...displayedView(), ...document })),
        };
        dismiss();
        setId(targetId.current);
        setRevision(Number(document.revision ?? 0));
        apply(document);
        current.current.setSelectedNodeIds([]);
        setPanel(false);
        return { ...document, nodeCount: (document.nodes as unknown[]).length };
      } catch (error) {
        if (owner === epoch.current) console.error('Failed to load workflow:', error);
        return null;
      } finally {
        if (owner === epoch.current) loading.current = false;
      }
    },
    [apply, dismiss, displayedView],
  );
  const getWorkflowEpoch = hooks.useCallback(() => epoch.current, []);
  const importDocument = hooks.useCallback((input: ProjectDocument, projectId: string = crypto.randomUUID()) => {
    const document = freshProjectDocument(input, projectId);
    validateDocument(document);
    epoch.current += 1;
    loading.current = false;
    queue.current = Promise.resolve();
    base.current = copy(document);
    targetId.current = String(document.id);
    pendingView.current = {
      before: copy(displayedView()), displayed: copy(displayedView()),
      after: copy(content({ ...displayedView(), ...document })),
      replacement: true,
    };
    dismiss();
    setId(targetId.current);
    setRevision(0);
    apply(document);
    current.current.setSelectedNodeIds([]);
    setPanel(false);
    return document;
  }, [apply, dismiss, displayedView]);
  const resetWorkflowId = hooks.useCallback(() => {
    epoch.current += 1;
    loading.current = false;
    base.current = null;
    pendingView.current = null;
    targetId.current = null;
    queue.current = Promise.resolve();
    dismiss();
    setId(null);
    setRevision(0);
  }, [dismiss]);
  const handleWorkflowsClick = hooks.useCallback((event: { currentTarget: HTMLElement }) => {
    setPanelY(event.currentTarget.getBoundingClientRect().top);
    setPanel((value) => !value);
    current.current.onPanelOpen?.();
  }, []);
  const closeWorkflowPanel = hooks.useCallback(() => setPanel(false), []);
  return {
    workflowId,
    workflowRevision,
    isWorkflowPanelOpen,
    workflowPanelY,
    handleSaveWorkflow,
    handleLoadWorkflow,
    handleWorkflowsClick,
    closeWorkflowPanel,
    resetWorkflowId,
    getWorkflowEpoch,
    useSaveFeedback:(options:Parameters<typeof useCanvasSaveFeedback>[1])=>useCanvasSaveFeedback(hooks,options),
    importDocument,
    useProjectFiles: (options: Parameters<typeof useCanvasProjectFiles>[1]) => useCanvasProjectFiles(hooks, options),
  };
}
