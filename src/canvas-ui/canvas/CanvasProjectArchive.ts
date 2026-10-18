/**
 * 项目归档（导出 / 导入）的数据面 —— v1.42。
 *
 * 用户原话（2026-10-18）：「在无限画布面板做一个项目导出导入的功能」。
 *
 * 这一层只做「跟 host 说话 + 把结果变成人话」，**不碰 React**：
 *   - 面板（`CanvasProjectArchive.tsx`）从这里取数据；
 *   - 项目看板头部那个「导入项目」按钮（vendor 的 projectDashboardChrome 注入）也走这里
 *     —— 看板视图里面板根本没挂载（Controls 槽位只在画布视图渲染），所以导入这件事
 *     必须能在「没有面板」的情况下独立跑完。
 *
 * host 侧四条接口（`src/host/canvas/projectArchiveRouter.ts`）：
 *   GET  /workflows/<id>/backup            整份归档（浏览器直接下载，Content-Disposition 命名）
 *   GET  /workflows/<id>/backup/info       规模预览（节点数 / 素材个数与字节 / 估算大小 / 导出目录）
 *   POST /workflows/<id>/backup/save       把归档写到本机目录（默认 = 下载目录）
 *   POST /workflows/restore                导入：回 { id, title, nodeCount, mediaRestored, mediaMissing, legacy? }
 *
 * 为什么导出优先「写到本机目录」而不是浏览器下载：Electron/无头浏览器对 `a[download]`
 * 的支持并不完全一致，几百 MB 的归档过一次浏览器内存也不合适。host 直接落盘 + 回执给
 * 绝对路径，面板上就能显示「导出到哪了」并一键打开目录。浏览器下载作为备用按钮保留。
 */

/** 画布后端命名空间（与 restRouter 的 CANVAS_API_PREFIX 一致）。 */
export const ARCHIVE_API = '/api/aifisher/canvas';

export interface ProjectArchiveInfo {
  projectId: string;
  title: string;
  nodeCount: number;
  groupCount: number;
  /** 文档本身（节点/分组/视口…）序列化后的字节数 */
  documentBytes: number;
  mediaFiles: number;
  mediaBytes: number;
  /** 素材总量超过上限 → 归档只带文档 */
  mediaOmitted: boolean;
  /** 估算的归档大小（文档 + 素材 base64） */
  archiveBytes: number;
  maxMediaBytes: number;
  /** 建议文件名（`<项目名>.fisherai`） */
  fileName: string;
  /** 当前导出目录（= 素材下载目录） */
  directory: string;
  defaultDirectory: string;
  customDirectory: boolean;
  format: string;
  version: number;
}

export interface ProjectArchiveSaveResult {
  status: 'saved';
  path: string;
  fileName: string;
  directory: string;
  bytes: number;
  mediaFiles: number;
  mediaOmitted: boolean;
}

export interface ProjectArchiveRestoreReceipt {
  id: string;
  title?: string;
  nodeCount?: number;
  mediaRestored?: number;
  mediaMissing?: number;
  /** 旧版 `.json` 画布文档（没有随行素材） */
  legacy?: boolean;
}

/** 排查读数（`__FISHERAI_PROJECT_ARCHIVE__.report()` 与真机探针用）。 */
const stats = {
  infoReads: 0,
  saves: 0,
  downloads: 0,
  imports: 0,
  lastError: '',
  lastStatus: '' as string,
  lastToast: '',
};

/** 字节数 → 人话（面板与 toast 共用一个口径）。 */
export function formatBytes(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 「12 个节点 · 素材 8 个（3.4 MB）」；素材超上限时把「只带文档」说清楚。 */
export function archiveScaleText(info: ProjectArchiveInfo | null): string {
  if (!info) return '正在读取项目规模…';
  const parts = [`${info.nodeCount} 个节点`];
  parts.push(`素材 ${info.mediaFiles} 个（${formatBytes(info.mediaBytes)}）`);
  if (info.mediaOmitted) {
    parts.push(`超过上限 ${formatBytes(info.maxMediaBytes)}，归档只带文档`);
  }
  return parts.join(' · ');
}

/** 导入回执 → 人话（面板提示条 / 看板 toast 同一句）。 */
export function restoreReceiptText(receipt: ProjectArchiveRestoreReceipt): string {
  const title = receipt.title?.trim() || '未命名项目';
  const nodes = Number(receipt.nodeCount ?? 0) || 0;
  const restored = Number(receipt.mediaRestored ?? 0) || 0;
  const missing = Number(receipt.mediaMissing ?? 0) || 0;
  if (receipt.legacy) {
    return `已导入旧版项目「${title}」（${nodes} 个节点；这种 .json 文档不带素材，需要的话把素材单独拷过来）`;
  }
  const media = missing
    ? `素材 ${restored} 个已恢复、${missing} 个缺失`
    : `素材 ${restored} 个已恢复`;
  return `已导入「${title}」（${nodes} 个节点；${media}）`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorText(data: Record<string, unknown>, fallback: string): string {
  const message = typeof data.error === 'string' && data.error ? data.error : fallback;
  return message;
}

/**
 * host 半的错误 → 人话。
 *
 * 501 = 跑着的 DSH 进程里还是**旧版 host**（画布产物是 no-store 每次读盘，所以刷新页面
 * 就能拿到新前端，但 host 那一半必须重启进程才会换）。这一条不说清，用户会以为功能坏了。
 */
function hostErrorText(
  response: Response,
  data: Record<string, unknown>,
  fallback: string,
): string {
  if (response.status === 501) {
    return '当前 DSH 里跑的插件还是旧版 host：重启一次 DSH 之后「项目归档」才可用。';
  }
  return errorText(data, fallback);
}

/** 读归档规模（面板一打开就调；只 stat 素材，不读内容）。 */
export async function fetchProjectArchiveInfo(projectId: string): Promise<ProjectArchiveInfo> {
  if (!projectId) throw new Error('这个项目还没保存过，先保存一次再导出。');
  const response = await fetch(
    `${ARCHIVE_API}/workflows/${encodeURIComponent(projectId)}/backup/info`,
    { headers: { Accept: 'application/json' } },
  );
  const data = await readJson(response);
  if (!response.ok) {
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, `读取项目规模失败（HTTP ${response.status}）`));
  }
  stats.infoReads += 1;
  return data as unknown as ProjectArchiveInfo;
}

/** 把归档写到本机目录（默认 = 下载目录；`directory` 是**一次性覆盖**）。 */
export async function saveProjectArchiveToDirectory(
  projectId: string,
  directory?: string,
): Promise<ProjectArchiveSaveResult> {
  if (!projectId) throw new Error('这个项目还没保存过，先保存一次再导出。');
  const body: Record<string, unknown> = {};
  if (typeof directory === 'string' && directory.trim()) body.directory = directory.trim();
  const response = await fetch(
    `${ARCHIVE_API}/workflows/${encodeURIComponent(projectId)}/backup/save`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const data = await readJson(response);
  if (!response.ok) {
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, `导出失败（HTTP ${response.status}）`));
  }
  stats.saves += 1;
  stats.lastStatus = 'saved';
  return data as unknown as ProjectArchiveSaveResult;
}

/** 从 `content-disposition` 里取文件名（优先 RFC 5987 的 `filename*`，回退 ASCII 的 `filename`）。 */
export function archiveFileNameFromDisposition(disposition: string | null | undefined): string {
  const raw = String(disposition ?? '');
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(raw);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* 解不开就用 ASCII 那份 */
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(raw);
  if (plain?.[2]) return plain[2].trim();
  return '';
}

/**
 * 浏览器下载（备用路径）：GET /backup → blob → a[download]。
 *
 * jsdom/无头环境里 `URL.createObjectURL` 可能不可用 —— 那时明确抛一句「用导出到目录」，
 * 而不是把按钮变成静默无效。
 */
export async function downloadProjectArchive(projectId: string): Promise<{
  fileName: string;
  bytes: number;
}> {
  if (!projectId) throw new Error('这个项目还没保存过，先保存一次再导出。');
  const response = await fetch(`${ARCHIVE_API}/workflows/${encodeURIComponent(projectId)}/backup`);
  if (!response.ok) {
    const data = await readJson(response);
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, `下载失败（HTTP ${response.status}）`));
  }
  const blob = await response.blob();
  const fileName =
    archiveFileNameFromDisposition(
      response.headers.get('content-disposition') ?? response.headers.get('Content-Disposition'),
    ) || `project-${projectId}.fisherai`;
  const createObjectUrl = (URL as unknown as { createObjectURL?: (blob: Blob) => string })
    .createObjectURL;
  if (typeof createObjectUrl !== 'function') {
    throw new Error('这个浏览器不支持直接下载，请用上面的「导出到本机目录」。');
  }
  const objectUrl = createObjectUrl.call(URL, blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* 有些环境没有 revokeObjectURL */
      }
    }, 4000);
  }
  stats.downloads += 1;
  stats.lastStatus = 'downloaded';
  return { fileName, bytes: blob.size };
}

/** 导入一份备份文件（原始字节走 host 的 `/workflows/restore`）。 */
export async function restoreProjectArchiveFile(
  file: File,
): Promise<ProjectArchiveRestoreReceipt> {
  if (!file || typeof file.size !== 'number') throw new Error('没有选中文件。');
  if (file.size === 0) throw new Error('这个文件是空的。');
  const response = await fetch(`${ARCHIVE_API}/workflows/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await readJson(response);
  if (!response.ok) {
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, `导入失败（HTTP ${response.status}）`));
  }
  if (typeof data.id !== 'string' || !data.id) {
    stats.lastError = 'RESTORE_RECEIPT_INVALID';
    throw new Error('导入回执无效：host 没给出新项目 id。');
  }
  stats.imports += 1;
  stats.lastStatus = 'imported';
  return data as unknown as ProjectArchiveRestoreReceipt;
}

/** 导入本机路径上的备份（host 直接读盘，省掉一次整份上传）。 */
export async function restoreProjectArchivePath(
  path: string,
): Promise<ProjectArchiveRestoreReceipt> {
  const value = String(path ?? '').trim();
  if (!value) throw new Error('先填一个备份文件的绝对路径。');
  const response = await fetch(`${ARCHIVE_API}/workflows/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: value }),
  });
  const data = await readJson(response);
  if (!response.ok) {
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, `导入失败（HTTP ${response.status}）`));
  }
  if (typeof data.id !== 'string' || !data.id) {
    stats.lastError = 'RESTORE_RECEIPT_INVALID';
    throw new Error('导入回执无效：host 没给出新项目 id。');
  }
  stats.imports += 1;
  stats.lastStatus = 'imported';
  return data as unknown as ProjectArchiveRestoreReceipt;
}

/**
 * 打开一个项目（导入完成后切过去）。
 *
 * 为什么走事件而不是直接调 vendor：`openProject` 在 `canvasApplication` 内部，与本模块
 * 是两个模块实例；装配层那条 vendor 补丁 3.8r 只加了「监听 `fisherai:open-project`」，
 * 于是这里派发事件就够了（也顺带在 jsdom 回归里能被真跑一遍）。
 */
export function openProjectById(id: string): boolean {
  if (typeof id !== 'string' || !id) return false;
  window.dispatchEvent(new CustomEvent('fisherai:open-project', { detail: { id } }));
  return true;
}

let toastElement: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 一句会自己消失的提示（看板视图没有面板可放提示条，所以做成挂在 body 上的小胶囊）。
 *
 * 配色读画布的 `--af-*` 变量（画布容器里这些都存在），容器外也有兜底色，不会白底黑字。
 */
export function showArchiveToast(text: string, kind: 'ok' | 'error' = 'ok'): HTMLElement | null {
  const message = String(text ?? '').trim();
  stats.lastToast = message;
  if (!message) return null;
  if (typeof document === 'undefined') return null;
  if (toastElement) {
    toastElement.remove();
    toastElement = null;
  }
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  const element = document.createElement('div');
  element.dataset.fisheraiProjectArchiveToast = kind;
  element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  element.textContent = message;
  element.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:32px',
    'transform:translateX(-50%)',
    'z-index:12000',
    'max-width:min(620px,calc(100vw - 48px))',
    'padding:9px 14px',
    'border-radius:10px',
    'border:1px solid ' + (kind === 'error' ? 'var(--af-danger,#f87171)' : 'var(--af-border,#333a45)'),
    'background:var(--af-surface-raised,#1f2430)',
    'color:' + (kind === 'error' ? 'var(--af-danger,#f87171)' : 'var(--af-text,#e5e7eb)'),
    'font-size:12px',
    'line-height:1.6',
    'box-shadow:0 12px 32px rgba(0,0,0,.45)',
    'pointer-events:none',
    'white-space:pre-wrap',
  ].join(';');
  document.body.appendChild(element);
  toastElement = element;
  toastTimer = setTimeout(() => {
    toastElement = null;
    toastTimer = null;
    element.remove();
  }, 8000);
  return element;
}

/**
 * 「选文件 → 导入 → 打开 → 提示」一次跑完（看板头部按钮与面板里的「选择文件」共用）。
 *
 * 自己造 `<input type=file>` 而不是复用 vendor 那个隐藏 input：那个 input 只在画布视图
 * 渲染（看板视图根本不在 DOM 里），复用会静默点空。
 */
export function importProjectArchiveViaPicker(options: {
  onDone?: (receipt: ProjectArchiveRestoreReceipt) => void;
  onError?: (error: Error) => void;
  open?: boolean;
} = {}): void {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.fisherai,.json,application/json';
  input.dataset.fisheraiProjectArchiveInput = 'true';
  input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
  document.body.appendChild(input);
  const cleanup = () => {
    input.remove();
  };
  input.addEventListener(
    'change',
    () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) return;
      void (async () => {
        try {
          const receipt = await restoreProjectArchiveFile(file);
          showArchiveToast(restoreReceiptText(receipt), 'ok');
          if (options.open !== false) openProjectById(receipt.id);
          options.onDone?.(receipt);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          showArchiveToast(`导入失败：${failure.message}`, 'error');
          options.onError?.(failure);
        }
      })();
    },
    { once: true },
  );
  input.click();
}

/** 排查读数。 */
export function projectArchiveReport(): Record<string, unknown> {
  return {
    ...stats,
    api: ARCHIVE_API,
    routes: [
      'GET /workflows/<id>/backup',
      'GET /workflows/<id>/backup/info',
      'POST /workflows/<id>/backup/save',
      'POST /workflows/restore',
    ],
    toast: toastElement ? toastElement.textContent : '',
  };
}
