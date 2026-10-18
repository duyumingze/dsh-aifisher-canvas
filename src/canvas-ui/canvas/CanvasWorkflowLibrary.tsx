/**
 * 「工作流节点」面板（v1.28）
 *
 * 用户的报障 + 需求（2026-10-17 原话）：
 *   「左侧工作流节点做错了，点击后是在画布右键的样子。工作流节点里放置配置好的 comfui，可以自定义配图」
 *
 * 根因：左栏那个「工作流节点」按钮被接到 `onAddClick` 上 —— 那是「添加节点」的处理器，它做的是
 * `adapter.openCanvasMenu('global', …)`，于是点它弹出的是**画布右键菜单**（同一个菜单对象），
 * 和用户预期（「放配置好的工作流」）完全不是一回事。
 *
 * 现在：点它打开本面板 —— 把「配置好的 ComfyUI 工作流」按**卡片**陈列（每张卡片一张配图、
 * 标题、分类、参数数量），点卡片 = 在画布正中建一个绑好该工作流的 ComfyUI 节点；
 * 每张卡片的配图可以**自定义**（上传一张本地图片，落 host 的 workflow-covers，见
 * src/host/comfyui/workflowCovers.ts），也能清除。
 *
 * 结构契约（回归/真机检查依赖，改前先看 docs/canvas-ui-shadcn.md）：
 *   - 面板根 `role="dialog"` + `aria-label="工作流节点"` + `data-fisherai-workflow-node-panel`；
 *   - 每张卡片 `data-fisherai-workflow-node-item="<工作流 id>"`，
 *     封面 `data-fisherai-workflow-node-cover`（没配图时 `data-fisherai-workflow-node-cover="placeholder"`）；
 *   - 卡片上的两个动作按钮 aria-label 固定为「配图」「清除配图」；
 *   - 搜索框 `aria-label="搜索工作流"` + `data-fisherai-workflow-node-search`；
 *   - 空清单 `data-fisherai-workflow-node-empty`；提示条 `data-fisherai-workflow-node-notice="ok|error"`；
 *   - 底部「ComfyUI 工作流配置」按钮 aria-label = "打开工作流配置"（跳到 v1.16 那个配置面板）。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数），不要用本文件 import 的那份 ——
 *    产物里 React 有两份副本，用错那分量 React 19 不报错也不渲染（整块面板会消失）。
 */
import * as ReactTypes from 'react';
import { createPortal } from 'react-dom';
import {
  CircleCheckIcon,
  ImagePlusIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WorkflowIcon,
  XIcon,
} from 'lucide-react';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { cn } from '@/lib/utils';
import { canvasPortalTarget } from '@/lib/portal';
import {
  ensureLocalWorkflows,
  localWorkflowDefinition,
  resetLocalWorkflows,
} from '../../../vendor/aifisher/src/stable/media/videoWorkflows';
import { requestComfyWorkflowConfig, closeComfyWorkflowConfig } from './ComfyWorkflowConfigStore';
import {
  closeCanvasWorkflowLibrary,
  subscribeWorkflowLibraryRequest,
  workflowLibrarySnapshot,
} from './CanvasWorkflowLibraryStore';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'Fragment'
  | 'useState'
  | 'useRef'
  | 'useEffect'
  | 'useMemo'
  | 'useCallback'
  | 'useSyncExternalStore'
>;

interface Props {
  view: string;
  viewport?: { x: number; y: number; zoom: number };
  canvasRef?: ReactTypes.RefObject<HTMLElement | null>;
}

const BASE = '/api/aifisher/canvas/comfy/workflow-config';
/** 客户端也挡一道大小（host 上限同样 8 MB，见 workflowCovers.ts） */
const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** host 侧 workflowConfig.ts 的清单条目（只写用到的字段）。 */
interface WorkflowSummary {
  id: string;
  title: string;
  file: string;
  hasMeta: boolean;
  category: string;
  outputType: 'images' | 'videos' | 'audios';
  modes: string[];
  candidateCount: number;
  selectedCount: number;
  disabledCount: number;
  /** v1.28：自定义配图（没配过没有这个字段） */
  coverUrl?: string;
  diagnostics: Array<{ file: string; code: string; message: string }>;
}

const OUTPUT_LABELS: Record<string, string> = {
  images: '图片',
  videos: '视频',
  audios: '音频',
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 画布正中在世界坐标里的位置（点卡片把节点落在这儿）。 */
function canvasCenterPoint(viewport: Props['viewport']): { x: number; y: number } {
  const zoom = Number.isFinite(viewport?.zoom) && (viewport?.zoom ?? 0) > 0 ? viewport!.zoom : 1;
  const rect = (
    document.getElementById('canvas-background') ?? document.querySelector('.af-canvas-mount')
  )?.getBoundingClientRect();
  const width = rect && rect.width > 0 ? rect.width : window.innerWidth;
  const height = rect && rect.height > 0 ? rect.height : window.innerHeight;
  return {
    x: (width / 2 - (viewport?.x ?? 0)) / zoom,
    y: (height / 2 - (viewport?.y ?? 0)) / zoom,
  };
}

/** 滚轮护栏：画布在 document 上装了「画布永不滚动」的监听，面板内的滚动不能被它决定。 */
function onPanelWheel(event: ReactTypes.WheelEvent<HTMLDivElement>) {
  if (event.ctrlKey || event.metaKey) return;
  event.stopPropagation();
}

/** File → data URL（配图走 JSON + dataUrl，host 那边一行 base64 解析就够）。 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('读不出这张图片（浏览器没能解码）。'));
    reader.readAsDataURL(file);
  });
}

export function CanvasWorkflowLibrary(react: Runtime, props: Props) {
  const h = react.createElement;
  const store = react.useSyncExternalStore(
    subscribeWorkflowLibraryRequest,
    workflowLibrarySnapshot,
  );
  const open = store.open;
  const openVersion = store.version;

  const [list, setList] = react.useState<WorkflowSummary[] | null>(null);
  const [dir, setDir] = react.useState('');
  const [loading, setLoading] = react.useState(false);
  const [error, setError] = react.useState('');
  const [query, setQuery] = react.useState('');
  const [notice, setNotice] = react.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  /** 正在上传配图的工作流 id（按钮转圈/禁用用） */
  const [busyId, setBusyId] = react.useState('');
  /** 「已添加到画布」的那张卡片闪一下（用户点卡片后要看到反馈） */
  const [addedId, setAddedId] = react.useState('');

  const fileRef = react.useRef<HTMLInputElement | null>(null);
  /** 隐藏 file input 当前是在给哪个工作流换图（onChange 里要它） */
  const pendingIdRef = react.useRef('');
  const handledVersionRef = react.useRef(-1);

  const close = react.useCallback(() => {
    setNotice(null);
    setQuery('');
    setAddedId('');
    closeCanvasWorkflowLibrary();
  }, []);

  const loadList = react.useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${BASE}${refresh ? '?refresh=1' : ''}`, {
        headers: { Accept: 'application/json' },
      });
      const data = await readJson(response);
      if (!response.ok) {
        setList([]);
        setError(String(data.error ?? `读取工作流清单失败（HTTP ${response.status}）`));
        return;
      }
      setList(((data.configs as WorkflowSummary[] | undefined) ?? []).slice());
      setDir(String(data.dir ?? ''));
    } catch (cause) {
      setList([]);
      setError(cause instanceof Error ? cause.message : '读取工作流清单失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开（或重新请求打开）时拉清单：用户往工作流目录里丢 JSON 之后，重开面板就能看见
  react.useEffect(() => {
    if (!open) return;
    if (handledVersionRef.current === openVersion) return;
    handledVersionRef.current = openVersion;
    setNotice(null);
    setQuery('');
    setAddedId('');
    // 两块大浮层不要叠在一起：打开本面板时先把「ComfyUI 工作流配置」与画布右键菜单收掉
    closeComfyWorkflowConfig();
    window.dispatchEvent(new CustomEvent('fisherai:close-canvas-menu'));
    // 点卡片要能把 comfyMode 落到节点上，前提是这份工作流已经在画布模板表里
    // （ensureLocalWorkflows 把能力清单推进 canvasNodeRules.workflowTemplates）。幂等，调一次就好。
    void ensureLocalWorkflows();
    void loadList(true);
  }, [open, openVersion, loadList]);

  // Esc 关闭
  react.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, close]);

  /**
   * 让画布节点的「工作流清单」重拉一次 —— 配图变了之后节点头部那张小图也要跟着换。
   * 能力清单是 host 按工作流现算的（coverUrl 带 ?v=），重拉就拿到新 URL。
   */
  const refreshCanvasWorkflows = react.useCallback(() => {
    resetLocalWorkflows();
    void ensureLocalWorkflows();
  }, []);

  /** 点卡片：在画布正中建一个绑好这份工作流的 ComfyUI 节点。 */
  const addToCanvas = react.useCallback(
    (workflow: WorkflowSummary) => {
      const point = canvasCenterPoint(props.viewport);
      window.dispatchEvent(
        new CustomEvent('fisherai:add-canvas-node', {
          detail: { type: 'ComfyUI', comfyMode: workflow.id, point },
        }),
      );
      setAddedId(workflow.id);
      setNotice({ kind: 'ok', text: `已把「${workflow.title}」放到画布上。` });
      // 画布的右键菜单若正开着，先关掉（两层浮层叠在一起会互相盖）
      window.dispatchEvent(new CustomEvent('fisherai:close-canvas-menu'));
    },
    [props.viewport],
  );

  /** 选一张图 → 读到 data URL → POST 到 host。 */
  const pickCover = react.useCallback((workflow: WorkflowSummary) => {
    pendingIdRef.current = workflow.id;
    setNotice(null);
    fileRef.current?.click();
  }, []);

  const uploadCover = react.useCallback(
    async (workflowId: string, file: File) => {
      if (!/^image\//i.test(file.type)) {
        setNotice({ kind: 'error', text: '配图要选图片文件（png / jpg / webp / gif）。' });
        return;
      }
      if (file.size > MAX_COVER_BYTES) {
        setNotice({
          kind: 'error',
          text: `这张图 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 ${
            MAX_COVER_BYTES / 1024 / 1024
          } MB 上限。`,
        });
        return;
      }
      setBusyId(workflowId);
      setNotice(null);
      try {
        const dataUrl = await fileToDataUrl(file);
        const response = await fetch(
          `/api/aifisher/canvas/workflow-covers/${encodeURIComponent(workflowId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl }),
          },
        );
        const data = await readJson(response);
        if (!response.ok) {
          setNotice({
            kind: 'error',
            text:
              response.status === 404 || response.status === 501
                ? '当前 host 还没有配图接口：请重启一次 DSH 再试。'
                : String(data.error ?? `保存配图失败（HTTP ${response.status}）`),
          });
          return;
        }
        const cover = (data.cover ?? {}) as { url?: unknown; bytes?: unknown };
        setList((current) =>
          current
            ? current.map((item) =>
                item.id === workflowId
                  ? { ...item, coverUrl: String(cover.url ?? '') }
                  : item,
              )
            : current,
        );
        setNotice({ kind: 'ok', text: `配图已保存（${Math.round(Number(cover.bytes ?? 0) / 1024)} KB）。` });
        refreshCanvasWorkflows();
      } catch (cause) {
        setNotice({
          kind: 'error',
          text: cause instanceof Error ? cause.message : '保存配图失败',
        });
      } finally {
        setBusyId('');
      }
    },
    [refreshCanvasWorkflows],
  );

  const clearCover = react.useCallback(
    async (workflow: WorkflowSummary) => {
      setBusyId(workflow.id);
      setNotice(null);
      try {
        const response = await fetch(
          `/api/aifisher/canvas/workflow-covers/${encodeURIComponent(workflow.id)}`,
          { method: 'DELETE' },
        );
        const data = await readJson(response);
        if (!response.ok) {
          setNotice({
            kind: 'error',
            text: String(data.error ?? `清除配图失败（HTTP ${response.status}）`),
          });
          return;
        }
        setList((current) =>
          current
            ? current.map((item) =>
                item.id === workflow.id ? { ...item, coverUrl: undefined } : item,
              )
            : current,
        );
        setNotice({ kind: 'ok', text: `已清除「${workflow.title}」的配图。` });
        refreshCanvasWorkflows();
      } catch (cause) {
        setNotice({
          kind: 'error',
          text: cause instanceof Error ? cause.message : '清除配图失败',
        });
      } finally {
        setBusyId('');
      }
    },
    [refreshCanvasWorkflows],
  );

  const filtered = react.useMemo(() => {
    const items = list ?? [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) =>
      [item.title, item.id, item.category, item.file]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    );
  }, [list, query]);

  const openWorkflowConfig = () => {
    close();
    requestComfyWorkflowConfig();
  };

  const coverBox = (workflow: WorkflowSummary) => {
    if (workflow.coverUrl) {
      return h('img', {
        key: 'cover',
        src: workflow.coverUrl,
        alt: '',
        'data-fisherai-workflow-node-cover': workflow.id,
        className: 'size-full object-cover',
      });
    }
    return h(
      'div',
      {
        key: 'cover',
        'data-fisherai-workflow-node-cover': 'placeholder',
        className:
          'flex size-full flex-col items-center justify-center gap-1.5 text-muted-foreground/70',
      },
      h(WorkflowIcon, { className: 'size-7' }),
      h('span', { className: 'text-[10px]' }, '未配图'),
    );
  };

  const card = (workflow: WorkflowSummary) => {
    const definition = localWorkflowDefinition(workflow.id);
    const inputCount = definition?.inputs.length ?? 0;
    const parameterCount = definition?.parameters.length ?? 0;
    const added = addedId === workflow.id;
    const busy = busyId === workflow.id;
    return h(
      'div',
      {
        key: workflow.id,
        role: 'button',
        tabIndex: 0,
        'data-fisherai-workflow-node-item': workflow.id,
        'data-fisherai-workflow-node-output': workflow.outputType,
        'data-fisherai-workflow-node-cover-state': workflow.coverUrl ? 'custom' : 'placeholder',
        'aria-label': `把「${workflow.title}」添加到画布`,
        title: workflow.file,
        onClick: () => addToCanvas(workflow),
        onKeyDown: (event: ReactTypes.KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          addToCanvas(workflow);
        },
        className: cn(
          'group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-left',
          'transition-colors hover:border-[var(--af-selected)] focus-visible:outline-hidden',
          added ? 'border-[var(--af-selected)] ring-1 ring-[var(--af-selected)]' : 'border-border',
        ),
      },
      h(
        'div',
        {
          className:
            'relative aspect-video w-full overflow-hidden bg-secondary/60 ' +
            '[background-image:linear-gradient(135deg,var(--af-input),var(--af-surface-raised))]',
        },
        coverBox(workflow),
        h(
          'div',
          {
            className:
              'absolute right-1 top-1 flex items-center gap-1 opacity-0 transition-opacity ' +
              'group-hover:opacity-100 group-focus-within:opacity-100',
          },
          h(
            'button',
            {
              type: 'button',
              'aria-label': '配图',
              title: '换一张配图（本地图片，png/jpg/webp/gif）',
              disabled: busy,
              onClick: (event: ReactTypes.MouseEvent) => {
                // 别让点动作按钮变成「添加节点」
                event.stopPropagation();
                pickCover(workflow);
              },
              className:
                'flex size-6 items-center justify-center rounded-md border border-border ' +
                'bg-popover/90 text-muted-foreground hover:text-foreground ' +
                'disabled:cursor-not-allowed disabled:opacity-50',
            },
            h(ImagePlusIcon, { className: 'size-3.5' }),
          ),
          workflow.coverUrl
            ? h(
                'button',
                {
                  type: 'button',
                  'aria-label': '清除配图',
                  title: '清除这张配图',
                  disabled: busy,
                  onClick: (event: ReactTypes.MouseEvent) => {
                    event.stopPropagation();
                    void clearCover(workflow);
                  },
                  className:
                    'flex size-6 items-center justify-center rounded-md border border-border ' +
                    'bg-popover/90 text-muted-foreground hover:text-[var(--af-danger,#f87171)] ' +
                    'disabled:cursor-not-allowed disabled:opacity-50',
                },
                h(Trash2Icon, { className: 'size-3.5' }),
              )
            : null,
        ),
        busy
          ? h(
              'div',
              {
                'data-fisherai-workflow-node-uploading': 'true',
                className:
                  'absolute inset-0 flex items-center justify-center bg-background/60 text-[11px]',
              },
              '正在保存配图…',
            )
          : null,
      ),
      h(
        'div',
        { className: 'flex min-w-0 flex-col gap-1 p-2' },
        h(
          'span',
          { className: 'truncate text-xs font-semibold text-foreground' },
          workflow.title,
        ),
        h(
          'div',
          { className: 'flex items-center gap-1.5 text-[10px] text-muted-foreground' },
          h(
            'span',
            {
              className:
                'rounded-sm bg-secondary px-1.5 py-0.5 font-medium text-foreground/80',
            },
            OUTPUT_LABELS[workflow.outputType] ?? workflow.outputType,
          ),
          h('span', { className: 'truncate' }, workflow.category || 'custom'),
          h('span', { className: 'ml-auto shrink-0 tabular-nums' }, `${inputCount} 入`),
          h('span', { className: 'shrink-0 tabular-nums' }, `${parameterCount} 参`),
        ),
        h(
          'div',
          { className: 'flex items-center gap-1 text-[10px] text-muted-foreground' },
          h(PlusIcon, { className: 'size-3 shrink-0' }),
          h(
            'span',
            { className: 'truncate' },
            added ? '已添加到画布' : `已配置 ${workflow.selectedCount} 个字段`,
          ),
          workflow.hasMeta
            ? h('span', { className: 'ml-auto shrink-0 rounded-sm bg-secondary px-1' }, 'meta')
            : null,
        ),
      ),
    );
  };

  const body = h(
    'div',
    { className: 'min-h-0 flex-1 overflow-y-auto px-3 py-3', onWheel: onPanelWheel },
    error
      ? h(
          'div',
          {
            role: 'alert',
            'data-fisherai-workflow-node-error': 'true',
            className: 'mb-2 rounded-md border border-border bg-secondary/60 px-2 py-1.5 text-[11px]',
          },
          error,
        )
      : null,
    loading && !list
      ? h(
          'div',
          { className: 'px-2 py-8 text-center text-xs text-muted-foreground' },
          '正在读取工作流清单…',
        )
      : filtered.length
        ? h(
            'div',
            {
              'data-fisherai-workflow-node-grid': 'true',
              className: 'grid grid-cols-2 gap-2 sm:grid-cols-3',
            },
            filtered.map(card),
          )
        : h(
            'div',
            {
              'data-fisherai-workflow-node-empty': 'true',
              className:
                'mx-1 my-6 flex flex-col items-center gap-2 rounded-lg border border-dashed ' +
                'border-border px-4 py-8 text-center',
            },
            h(WorkflowIcon, { className: 'size-6 text-muted-foreground' }),
            h(
              'span',
              { className: 'text-xs font-medium' },
              list && list.length ? `没有匹配「${query}」的工作流` : '还没有配置好的 ComfyUI 工作流',
            ),
            h(
              'span',
              { className: 'max-w-[420px] text-[11px] leading-5 text-muted-foreground' },
              list && list.length
                ? '换个关键词试试；清单来自工作流目录里的 *.json。'
                : '把 ComfyUI 导出的 API 格式 JSON 丢进工作流目录，就出现在这里（也能在「ComfyUI 工作流配置」里调参数/标签）。',
            ),
            list && list.length
              ? null
              : h(
                  Button,
                  {
                    type: 'button',
                    size: 'sm',
                    variant: 'secondary',
                    'aria-label': '打开工作流配置',
                    onClick: openWorkflowConfig,
                    className: 'mt-1 h-7 gap-1 text-xs',
                  },
                  h(SlidersHorizontalIcon, { className: 'size-3.5' }),
                  '打开工作流配置',
                ),
          ),
  );

  const noticeBar = notice
    ? h(
        'div',
        {
          'data-fisherai-workflow-node-notice': notice.kind,
          role: notice.kind === 'error' ? 'alert' : 'status',
          className: cn(
            'flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-[11px]',
            notice.kind === 'error' ? 'text-[var(--af-danger,#f87171)]' : 'text-muted-foreground',
          ),
        },
        notice.kind === 'ok'
          ? h(CircleCheckIcon, { className: 'size-3.5 shrink-0' })
          : h(TriangleAlertIcon, { className: 'size-3.5 shrink-0' }),
        h('span', { className: 'truncate' }, notice.text),
      )
    : null;

  const panel = h(
    'div',
    {
      key: 'panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '工作流节点',
      'data-fisherai-workflow-node-panel': 'true',
      'data-fisherai-workflow-node-count': String(filtered.length),
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      onWheel: onPanelWheel,
      onContextMenu: (event: ReactTypes.MouseEvent) => event.preventDefault(),
      className:
        'flex max-h-[min(760px,88vh)] w-[min(880px,94vw)] flex-col overflow-hidden rounded-xl ' +
        'border border-border bg-popover text-popover-foreground shadow-2xl',
    },
    // 头部
    h(
      'div',
      { className: 'flex items-center gap-2 border-b border-border px-3 py-2' },
      h(WorkflowIcon, { className: 'size-4 shrink-0 text-muted-foreground' }),
      h('span', { className: 'text-sm font-medium' }, '工作流节点'),
      h(
        'span',
        { className: 'min-w-0 flex-1 truncate text-[11px] text-muted-foreground' },
        list ? `${list.length} 份配置好的工作流 · 点卡片放到画布` : '正在读取清单…',
      ),
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'icon-sm',
          'aria-label': '刷新工作流清单',
          title: '重新扫描工作流目录',
          onClick: () => void loadList(true),
          className: 'size-7 text-muted-foreground',
        },
        h(RefreshCwIcon, { className: loading ? 'size-3.5 animate-spin' : 'size-3.5' }),
      ),
      h(
        'button',
        {
          type: 'button',
          'aria-label': '关闭工作流节点',
          onClick: close,
          className: 'rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground',
        },
        h(XIcon, { className: 'size-4' }),
      ),
    ),
    // 搜索
    h(
      'div',
      { className: 'flex items-center gap-2 border-b border-border px-3 py-1.5' },
      h(SearchIcon, { className: 'size-3.5 shrink-0 text-muted-foreground' }),
      h(Input, {
        value: query,
        'aria-label': '搜索工作流',
        'data-fisherai-workflow-node-search': 'true',
        placeholder: '搜索工作流（名字 / 分类 / 文件名）',
        autoComplete: 'off',
        spellCheck: false,
        onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
        className: 'h-8 border-0 bg-transparent pl-0 text-xs shadow-none focus-visible:ring-0',
      }),
    ),
    body,
    noticeBar,
    // 底部：目录 + 配置入口
    h(
      'div',
      { className: 'flex items-center gap-2 border-t border-border px-3 py-2' },
      h(
        'span',
        { className: 'min-w-0 flex-1 truncate text-[10px] text-muted-foreground' },
        dir ? `工作流目录：${dir}` : '',
      ),
      h(
        Button,
        {
          type: 'button',
          variant: 'secondary',
          size: 'sm',
          'aria-label': '打开工作流配置',
          onClick: openWorkflowConfig,
          className: 'h-7 shrink-0 gap-1 text-xs',
        },
        h(SlidersHorizontalIcon, { className: 'size-3.5' }),
        'ComfyUI 工作流配置',
      ),
    ),
    h('input', {
      key: 'file',
      ref: fileRef,
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/gif',
      hidden: true,
      'data-fisherai-workflow-node-cover-input': 'true',
      onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        const workflowId = pendingIdRef.current;
        // 同一个文件选两次也要能触发 onChange
        event.target.value = '';
        if (!file || !workflowId) return;
        void uploadCover(workflowId, file);
      },
    }),
  );

  const backdrop = h(
    'div',
    {
      key: 'backdrop',
      'data-fisherai-workflow-node-backdrop': 'true',
      onPointerDown: (event: ReactTypes.PointerEvent) => {
        if (event.target === event.currentTarget) close();
      },
      className:
        'fixed inset-0 z-[11950] flex items-center justify-center bg-black/60 backdrop-blur-[2px]',
    },
    panel,
  );

  const watcher = h('div', {
    key: 'watcher',
    'data-fisherai-workflow-node': open ? 'open' : 'closed',
    hidden: true,
  });

  const root = h(react.Fragment, null, watcher, open ? backdrop : null);
  const target = canvasPortalTarget();
  if (target && open) return createPortal(root, target) as ReactTypes.ReactNode;
  return root;
}

CanvasWorkflowLibrary.displayName = 'CanvasWorkflowLibraryShadcn';
