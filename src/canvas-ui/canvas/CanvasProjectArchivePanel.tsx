/**
 * 「项目归档」面板（v1.42）—— 项目的导出 / 导入。
 *
 * 用户原话（2026-10-18）：「在无限画布面板做一个项目导出导入的功能」。
 *
 * 为什么要有面板而不是一个按钮：导出/导入是一对**有状态**的动作（导出要告诉你
 * 「大概多大、存到哪、存好了没」，导入要告诉你「导进来了几个节点、几张素材、缺了什么」），
 * 直接触发浏览器下载/上传会把失败原因吞掉。所以两块并排放在一个面板里：
 *
 *   导出：规模读数（节点数 / 素材个数与字节）+ 导出目录（= 素材下载目录，可改）
 *         + 「导出到该目录」（host 落盘、回执给绝对路径）+ 「下载到浏览器」（备用）
 *   导入：选 `.fisherai` 备份（含素材）或旧版 `.json` 文档 → 新建一个项目并打开
 *
 * 结构契约（回归 / 真机检查依赖，改前先看 docs/canvas-ui-shadcn.md）：
 *   - 面板根：`role="dialog"` + `aria-label="项目归档"` + `data-fisherai-project-archive="panel"`
 *   - 规模读数：`data-fisherai-project-archive-info`（文本里含「个节点」「素材」）
 *   - 导出目录输入框：`aria-label="导出目录"` + `data-fisherai-project-archive-dir`
 *   - 三个动作按钮的 aria-label 固定：`导出到目录` / `下载备份` / `打开导出目录`
 *   - 导入：`aria-label="导入项目文件"`（+ `data-fisherai-project-archive-import`）、
 *     路径输入 `aria-label="本机备份路径"`、`aria-label="从路径导入"`
 *   - 提示条：`data-fisherai-project-archive-notice="ok|error"`
 *   - 遮罩：`data-fisherai-project-archive-backdrop`
 *
 * ⚠️ hooks 必须用**注入进来的 React**（第一个参数）：产物里有两份 React 副本，
 *    用错那份 React 19 既不报错也不渲染（整块面板会消失）。
 */
import * as ReactTypes from 'react';
import { createPortal } from 'react-dom';
import {
  ArchiveIcon,
  CircleCheckIcon,
  DownloadIcon,
  FolderOpenIcon,
  ImportIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { cn } from '@/lib/utils';
import { canvasPortalTarget } from '@/lib/portal';
import {
  archiveScaleText,
  formatBytes,
  importProjectArchiveViaPicker,
  restoreProjectArchivePath,
  restoreReceiptText,
  saveProjectArchiveToDirectory,
  downloadProjectArchive,
  fetchProjectArchiveInfo,
  openProjectById,
  showArchiveToast,
  type ProjectArchiveInfo,
  type ProjectArchiveRestoreReceipt,
} from './CanvasProjectArchive';
import {
  closeCanvasProjectArchive,
  projectArchiveSnapshot,
  subscribeProjectArchive,
} from './CanvasProjectArchiveStore';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'Fragment'
  | 'useState'
  | 'useRef'
  | 'useEffect'
  | 'useCallback'
  | 'useSyncExternalStore'
>;

interface Props {
  view: string;
  /** 当前项目 id（vendor 补丁 3.8r 给 Controls 多喂的一个 prop；空 = 还没保存过） */
  projectId?: string;
}

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

/** 滚轮护栏：画布在 document 上装了「画布永不滚动」的监听，面板内的滚动不能被它决定。 */
function onPanelWheel(event: ReactTypes.WheelEvent<HTMLDivElement>) {
  if (event.ctrlKey || event.metaKey) return;
  event.stopPropagation();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause) return cause;
  return fallback;
}

export function CanvasProjectArchive(react: Runtime, props: Props) {
  const h = react.createElement;
  const store = react.useSyncExternalStore(subscribeProjectArchive, projectArchiveSnapshot);
  const open = store.open;
  const openVersion = store.version;
  const projectId = typeof props.projectId === 'string' ? props.projectId : '';

  const [info, setInfo] = react.useState<ProjectArchiveInfo | null>(null);
  const [directory, setDirectory] = react.useState('');
  const [pathInput, setPathInput] = react.useState('');
  const [busy, setBusy] = react.useState('');
  const [notice, setNotice] = react.useState<Notice | null>(null);
  const handledVersion = react.useRef(-1);

  const close = react.useCallback(() => {
    setNotice(null);
    setBusy('');
    closeCanvasProjectArchive();
  }, []);

  /**
   * 拉一次规模读数（面板一打开、导出成功后都会调）。
   *
   * ⚠️ `quiet=true` 时**不许清掉提示条**：导出成功后的「已导出到 …」正是这一刻要给人看的，
   *    成功回读时顺手 setNotice(null) 会让提示一闪不见（第一版就这么翻的车）。
   */
  const loadInfo = react.useCallback(
    async (quiet = false) => {
      if (!projectId) {
        setInfo(null);
        setNotice({ kind: 'error', text: '这个项目还没保存过：先按 Ctrl+S 保存一次，再导出。' });
        return;
      }
      try {
        const next = await fetchProjectArchiveInfo(projectId);
        setInfo(next);
        setDirectory(next.directory || next.defaultDirectory || '');
        if (!quiet) setNotice(null);
      } catch (cause) {
        setInfo(null);
        setNotice({ kind: 'error', text: errorMessage(cause, '读取项目规模失败。') });
      }
    },
    [projectId],
  );

  react.useEffect(() => {
    if (!open) return;
    if (handledVersion.current === openVersion) return;
    handledVersion.current = openVersion;
    setNotice(null);
    setBusy('');
    setPathInput('');
    // 两块大浮层不要叠在一起：打开本面板时先收掉别的面板与画布右键菜单
    window.dispatchEvent(new CustomEvent('fisherai:close-canvas-menu'));
    void loadInfo();
  }, [open, openVersion, loadInfo]);

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

  /** 导出到本机目录：host 落盘，回执里就有绝对路径。 */
  const exportToDirectory = react.useCallback(async () => {
    if (busy) return;
    setBusy('export');
    setNotice(null);
    try {
      const result = await saveProjectArchiveToDirectory(projectId, directory.trim() || undefined);
      setDirectory(result.directory);
      setNotice({
        kind: 'ok',
        text:
          `已导出 ${result.fileName}（${formatBytes(result.bytes)}）到 ${result.directory}` +
          (result.mediaOmitted ? '；素材超过上限，这次只带了文档。' : ''),
      });
      await loadInfo(true);
    } catch (cause) {
      setNotice({ kind: 'error', text: errorMessage(cause, '导出失败。') });
    } finally {
      setBusy('');
    }
  }, [busy, directory, loadInfo, projectId]);

  /** 改导出目录（= 素材下载目录，与「下载」共用一条设置）。 */
  const saveDirectory = react.useCallback(async () => {
    const value = directory.trim();
    if (!value) {
      setNotice({ kind: 'error', text: '导出目录不能为空。要恢复默认就把它清空后点「用默认目录」。' });
      return;
    }
    setBusy('directory');
    setNotice(null);
    try {
      const response = await fetch('/api/aifisher/canvas/media-download/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: value }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        setNotice({
          kind: 'error',
          text: String(data.error ?? `保存目录失败（HTTP ${response.status}）`),
        });
        return;
      }
      const nextDirectory = String(data.directory ?? value);
      setDirectory(nextDirectory);
      setNotice({ kind: 'ok', text: `导出目录已改成 ${nextDirectory}` });
      await loadInfo(true);
    } catch (cause) {
      setNotice({ kind: 'error', text: errorMessage(cause, '保存目录失败。') });
    } finally {
      setBusy('');
    }
  }, [directory, loadInfo]);

  const resetDirectory = react.useCallback(async () => {
    setBusy('directory');
    setNotice(null);
    try {
      const response = await fetch('/api/aifisher/canvas/media-download/settings/directory', {
        method: 'DELETE',
      });
      const data = await readJson(response);
      if (!response.ok) {
        setNotice({
          kind: 'error',
          text: String(data.error ?? `恢复默认目录失败（HTTP ${response.status}）`),
        });
        return;
      }
      setDirectory(String(data.directory ?? ''));
      setNotice({ kind: 'ok', text: `已恢复默认目录：${String(data.directory ?? '')}` });
      await loadInfo(true);
    } catch (cause) {
      setNotice({ kind: 'error', text: errorMessage(cause, '恢复默认目录失败。') });
    } finally {
      setBusy('');
    }
  }, [loadInfo]);

  const downloadToBrowser = react.useCallback(async () => {
    if (busy) return;
    setBusy('download');
    setNotice(null);
    try {
      const result = await downloadProjectArchive(projectId);
      setNotice({
        kind: 'ok',
        text: `已交给浏览器下载 ${result.fileName}（${formatBytes(result.bytes)}），在浏览器的下载目录里。`,
      });
    } catch (cause) {
      setNotice({ kind: 'error', text: errorMessage(cause, '下载失败。') });
    } finally {
      setBusy('');
    }
  }, [busy, projectId]);

  const openDirectory = react.useCallback(async () => {
    setBusy('open-directory');
    setNotice(null);
    try {
      const response = await fetch('/api/aifisher/canvas/media-download/open-directory', {
        method: 'POST',
      });
      const data = await readJson(response);
      if (!response.ok) {
        setNotice({
          kind: 'error',
          text: String(data.error ?? `打开目录失败（HTTP ${response.status}）`),
        });
        return;
      }
      setNotice({ kind: 'ok', text: `已打开 ${String(data.directory ?? directory)}` });
    } catch (cause) {
      setNotice({ kind: 'error', text: errorMessage(cause, '打开目录失败。') });
    } finally {
      setBusy('');
    }
  }, [directory]);

  const importFromPicker = react.useCallback(() => {
    setNotice(null);
    importProjectArchiveViaPicker({
      onDone: (receipt: ProjectArchiveRestoreReceipt) => {
        // 导入成功后面板会立刻收起（用户要看的是新项目），所以回执必须留在页面级的
        // toast 上 —— 只写面板里的提示条等于什么都没说（v1.42 第一版就是这个问题）。
        showArchiveToast(restoreReceiptText(receipt), 'ok');
        setNotice({ kind: 'ok', text: restoreReceiptText(receipt) });
        close();
      },
      onError: (error) => {
        setNotice({ kind: 'error', text: `导入失败：${error.message}` });
      },
    });
  }, [close]);

  const importFromPath = react.useCallback(async () => {
    if (busy) return;
    setBusy('import-path');
    setNotice(null);
    try {
      const receipt = await restoreProjectArchivePath(pathInput);
      showArchiveToast(restoreReceiptText(receipt), 'ok');
      setNotice({ kind: 'ok', text: restoreReceiptText(receipt) });
      openProjectById(receipt.id);
      close();
    } catch (cause) {
      setNotice({ kind: 'error', text: errorMessage(cause, '导入失败。') });
    } finally {
      setBusy('');
    }
  }, [busy, close, pathInput]);

  const watcher = h('div', {
    key: 'watcher',
    'data-fisherai-project-archive': open ? 'open' : 'closed',
    hidden: true,
  });

  if (!open) return h(react.Fragment, null, watcher);

  const scaleText = archiveScaleText(info);
  const exporting = busy === 'export' || busy === 'download';
  const importBusy = busy === 'import-path';

  const section = (children: ReactTypes.ReactNode) =>
    h('div', { className: 'flex flex-col gap-2.5 px-4 py-3.5' }, children);

  const panel = h(
    'div',
    {
      key: 'panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '项目归档',
      'data-fisherai-project-archive': 'panel',
      'data-fisherai-project-archive-project': projectId,
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      onWheel: onPanelWheel,
      onContextMenu: (event: ReactTypes.MouseEvent) => event.preventDefault(),
      className:
        'flex max-h-[min(720px,88vh)] w-[min(620px,94vw)] flex-col overflow-hidden rounded-xl ' +
        'border border-border bg-popover text-popover-foreground shadow-2xl',
    },
    // ---- 头部 ----
    h(
      'div',
      { className: 'flex items-center gap-2 border-b border-border px-3 py-2' },
      h(ArchiveIcon, { className: 'size-4 shrink-0 text-muted-foreground' }),
      h('span', { className: 'text-sm font-medium' }, '项目归档'),
      h(
        'span',
        { className: 'min-w-0 flex-1 truncate text-[11px] text-muted-foreground' },
        info?.title ? `${info.title} · ${scaleText}` : projectId ? scaleText : '项目还没保存过',
      ),
      h(
        'button',
        {
          type: 'button',
          'aria-label': '关闭项目归档',
          onClick: close,
          className: 'rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground',
        },
        h(XIcon, { className: 'size-4' }),
      ),
    ),
    // ---- 正文 ----
    h(
      'div',
      { className: 'min-h-0 flex-1 overflow-y-auto' },
      section([
        h(
          'div',
          { key: 'title', className: 'flex items-center gap-2' },
          h(DownloadIcon, { className: 'size-3.5 text-muted-foreground' }),
          h('span', { className: 'text-xs font-semibold' }, '导出当前项目'),
          info?.mediaOmitted
            ? h(
                'span',
                { className: 'rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground' },
                '素材超上限',
              )
            : null,
        ),
        h(
          'p',
          {
            key: 'scale',
            'data-fisherai-project-archive-info': 'true',
            className: 'text-[11px] leading-5 text-muted-foreground',
          },
          info
            ? `${scaleText} · 归档约 ${formatBytes(info.archiveBytes)}`
            : projectId
              ? '正在读取项目规模…'
              : '这个项目还没保存过：先按 Ctrl+S 保存一次，再导出。',
        ),
        h(
          'div',
          { key: 'dir', className: 'flex items-center gap-1.5' },
          h(Input, {
            value: directory,
            'aria-label': '导出目录',
            'data-fisherai-project-archive-dir': 'true',
            placeholder: '导出目录（绝对路径，默认 = 下载目录）',
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
              setDirectory(event.target.value),
            className: 'h-8 flex-1 text-[11px]',
          }),
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'secondary',
              'aria-label': '保存导出目录',
              title: '把这个目录存成导出目录（与素材「下载」共用一条设置）',
              disabled: busy === 'directory' || !directory.trim(),
              onClick: () => void saveDirectory(),
              className: 'h-8 shrink-0 text-xs',
            },
            '保存目录',
          ),
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'ghost',
              'aria-label': '恢复默认导出目录',
              title: '恢复成默认目录（<画布数据目录>/downloads）',
              disabled: busy === 'directory',
              onClick: () => void resetDirectory(),
              className: 'h-8 shrink-0 text-xs',
            },
            '默认',
          ),
        ),
        h(
          'div',
          { key: 'actions', className: 'flex flex-wrap items-center gap-1.5' },
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              'aria-label': '导出到目录',
              'data-fisherai-project-archive-export': 'true',
              title: '把整份 .fisherai（含素材）写到上面的目录',
              disabled: exporting || !projectId,
              onClick: () => void exportToDirectory(),
              className: 'h-8 gap-1 text-xs',
            },
            h(ArchiveIcon, { className: 'size-3.5' }),
            busy === 'export' ? '导出中…' : '导出到目录',
          ),
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'secondary',
              'aria-label': '下载备份',
              title: '交给浏览器下载（备用：浏览器下载目录）',
              disabled: exporting || !projectId,
              onClick: () => void downloadToBrowser(),
              className: 'h-8 gap-1 text-xs',
            },
            h(DownloadIcon, { className: 'size-3.5' }),
            '下载到浏览器',
          ),
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'ghost',
              'aria-label': '打开导出目录',
              title: '在文件管理器里打开导出目录',
              disabled: busy === 'open-directory',
              onClick: () => void openDirectory(),
              className: 'h-8 gap-1 text-xs',
            },
            h(FolderOpenIcon, { className: 'size-3.5' }),
            '打开目录',
          ),
        ),
      ]),
      h('div', { key: 'sep', className: 'h-px bg-border' }),
      section([
        h(
          'div',
          { key: 'title', className: 'flex items-center gap-2' },
          h(ImportIcon, { className: 'size-3.5 text-muted-foreground' }),
          h('span', { className: 'text-xs font-semibold' }, '导入项目备份'),
        ),
        h(
          'p',
          {
            key: 'hint',
            className: 'text-[11px] leading-5 text-muted-foreground',
          },
          '选一个 .fisherai 备份（带素材）或旧版 .json 画布文档。导入会新建一个项目，' +
            '不覆盖现有项目；归档里的素材会写进新项目目录，画布上的素材地址自动改写。',
        ),
        h(
          'div',
          { key: 'actions', className: 'flex flex-wrap items-center gap-1.5' },
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              'aria-label': '导入项目文件',
              'data-fisherai-project-archive-import': 'true',
              disabled: importBusy,
              onClick: importFromPicker,
              className: 'h-8 gap-1 text-xs',
            },
            h(ImportIcon, { className: 'size-3.5' }),
            '选择文件导入',
          ),
        ),
        h(
          'div',
          { key: 'path', className: 'flex items-center gap-1.5' },
          h(Input, {
            value: pathInput,
            'aria-label': '本机备份路径',
            'data-fisherai-project-archive-path-input': 'true',
            placeholder: '或直接填备份文件的绝对路径（host 直接读盘，不经过浏览器上传）',
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
              setPathInput(event.target.value),
            onKeyDown: (event: ReactTypes.KeyboardEvent<HTMLInputElement>) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void importFromPath();
            },
            className: 'h-8 flex-1 text-[11px]',
          }),
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'secondary',
              'aria-label': '从路径导入',
              disabled: importBusy || !pathInput.trim(),
              onClick: () => void importFromPath(),
              className: 'h-8 shrink-0 text-xs',
            },
            importBusy ? '导入中…' : '从路径导入',
          ),
        ),
      ]),
    ),
    // ---- 提示条 ----
    notice
      ? h(
          'div',
          {
            'data-fisherai-project-archive-notice': notice.kind,
            role: notice.kind === 'error' ? 'alert' : 'status',
            className: cn(
              'flex items-start gap-1.5 border-t border-border px-3 py-2 text-[11px] leading-5',
              notice.kind === 'error'
                ? 'text-[var(--af-danger,#f87171)]'
                : 'text-muted-foreground',
            ),
          },
          notice.kind === 'ok'
            ? h(CircleCheckIcon, { className: 'mt-0.5 size-3.5 shrink-0' })
            : h(TriangleAlertIcon, { className: 'mt-0.5 size-3.5 shrink-0' }),
          h('span', { className: 'min-w-0 break-all' }, notice.text),
        )
      : null,
  );

  const backdrop = h(
    'div',
    {
      key: 'backdrop',
      'data-fisherai-project-archive-backdrop': 'true',
      onPointerDown: (event: ReactTypes.PointerEvent) => {
        if (event.target === event.currentTarget) close();
      },
      className:
        'fixed inset-0 z-[11960] flex items-center justify-center bg-black/60 backdrop-blur-[2px]',
    },
    panel,
  );

  const root = h(react.Fragment, null, watcher, backdrop);
  const target = canvasPortalTarget();
  if (target) return createPortal(root, target) as ReactTypes.ReactNode;
  return root;
}

CanvasProjectArchive.displayName = 'CanvasProjectArchiveShadcn';
