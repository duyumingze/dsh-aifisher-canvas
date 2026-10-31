/**
 * 设置页的数据面（v1.84）—— 把散在七个弹层里的设置项收拢到一处读，**不碰 React**。
 *
 * 设计稿 pages/settings-1.html 的三组（外观与主题 / 生成 / 项目与数据）里，能真接上的都接了：
 *
 *   | 行 | 真实来源 |
 *   |---|---|
 *   | 界面缩放 | `../../client/canvas/uiScale`（localStorage['af.uiScale']，6 档 + 快捷键） |
 *   | 画布网格（光标辉光） | `./CanvasEffectsStore`（localStorage['dsh-aifisher-canvas.canvas-effects']） |
 *   | 画布背景图 | host `/appearance/background`（appearanceRouter.ts，20 MiB / 4096² 上限） |
 *   | 本地 ComfyUI | host `/local-runtime/status`（只读：本插件不托管进程，见 localRuntimeRouter） |
 *   | 新建节点默认模型 | `./CanvasLastModel`（v1.40 的「跟上次用的一样」） |
 *   | 项目数据目录 | host `/data-dir`（dataDirRouter.ts，改路径要重启 DSH） |
 *   | 导出目录 | host `/media-download/settings`（mediaDownloadRouter.ts） |
 *
 * 没接上的（主题另两款皮肤 / 生成中 V1·V3 / 动效 G1·G3 / 并发生成数）在页面上**置灰**
 * 并挂「设计稿」标签 —— 用户 2026-10-31 拍板：「置灰 + 设计稿小标签，只有真实现的能点」。
 */

export const SETTINGS_API = '/api/aifisher/canvas';

/** 插件版本（页面左下角与「关于」行显示；与 package.json 同步）。 */
export const CANVAS_UI_VERSION = '1.85.0';

export interface ComfyStatus {
  /** 是否真的连上了（`/local-runtime/status` 的 comfyui.status === 'ready' 视为可用）。 */
  online: boolean;
  address: string;
  workflows: number;
  gpu: string;
  models: number;
  error: string;
}

export interface DataDirInfo {
  active: string;
  pending: string;
  default: string;
  overridden: boolean;
  restartRequired: boolean;
  canvasFile: string;
  mediaDir: string;
}

export interface DownloadSettings {
  directory: string;
  defaultDirectory: string;
  customDirectory: boolean;
  askEachTime: boolean;
  directoryAvailable: boolean;
}

export interface BackgroundInfo {
  id: string;
  width: number;
  height: number;
  bytes: number;
  url: string;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 生成页「本地 ComfyUI」那一行：连不上也返回一份可读状态，不抛（设置页不该因为服务没开就白屏）。 */
export async function fetchComfyStatus(): Promise<ComfyStatus> {
  const empty: ComfyStatus = { online: false, address: '', workflows: 0, gpu: '', models: 0, error: '' };
  try {
    const response = await fetch(`${SETTINGS_API}/local-runtime/status`);
    const data = await readJson(response);
    if (!response.ok) {
      return { ...empty, error: typeof data.error === 'string' ? data.error : `HTTP ${response.status}` };
    }
    const comfyui = (data.comfyui ?? {}) as Record<string, unknown>;
    const gpu = (data.gpu ?? {}) as Record<string, unknown>;
    const models = (data.models ?? {}) as Record<string, unknown>;
    const status = typeof comfyui.status === 'string' ? comfyui.status : '';
    return {
      online: status === 'ready' || status === 'partial',
      address: typeof comfyui.address === 'string' ? comfyui.address : '',
      workflows: Number(comfyui.workflowCount) || 0,
      gpu: typeof gpu.name === 'string' ? gpu.name : '',
      models: Number(models.total) || 0,
      error: '',
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchDataDir(): Promise<DataDirInfo | null> {
  try {
    const response = await fetch(`${SETTINGS_API}/data-dir`);
    const data = await readJson(response);
    if (!response.ok) return null;
    return {
      active: String(data.active ?? ''),
      pending: String(data.pending ?? ''),
      default: String(data.default ?? ''),
      overridden: data.overridden === true,
      restartRequired: data.restartRequired === true,
      canvasFile: String(data.canvasFile ?? ''),
      mediaDir: String(data.mediaDir ?? ''),
    };
  } catch {
    return null;
  }
}

export async function fetchDownloadSettings(): Promise<DownloadSettings | null> {
  try {
    const response = await fetch(`${SETTINGS_API}/media-download/settings`);
    const data = await readJson(response);
    if (!response.ok) return null;
    return {
      directory: String(data.directory ?? ''),
      defaultDirectory: String(data.defaultDirectory ?? ''),
      customDirectory: data.customDirectory === true,
      askEachTime: data.askEachTime === true,
      directoryAvailable: data.directoryAvailable !== false,
    };
  } catch {
    return null;
  }
}

/** 让 host 在资源管理器里打开导出目录（与素材「下载」共用一条设置）。 */
export async function openDownloadDirectory(): Promise<boolean> {
  try {
    const response = await fetch(`${SETTINGS_API}/media-download/open-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function fetchBackground(): Promise<BackgroundInfo | null> {
  try {
    const response = await fetch(`${SETTINGS_API}/appearance/background`);
    const data = await readJson(response);
    if (!response.ok) return null;
    const image = (data.image ?? null) as Record<string, unknown> | null;
    if (!image || typeof image.id !== 'string') return null;
    return {
      id: image.id,
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
      bytes: Number(image.bytes) || 0,
      url: String(image.url ?? ''),
    };
  } catch {
    return null;
  }
}

/** 换背景图：把文件原始字节 POST 上去（host 读文件头拿尺寸，不合规会回 415/422）。 */
export async function uploadBackground(file: File): Promise<BackgroundInfo> {
  const buffer = await file.arrayBuffer();
  const response = await fetch(`${SETTINGS_API}/appearance/background`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: buffer,
  });
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `换背景失败（HTTP ${response.status}）`);
  }
  const image = (data.image ?? null) as Record<string, unknown> | null;
  if (!image || typeof image.id !== 'string') throw new Error('背景图返回格式无效。');
  return {
    id: image.id,
    width: Number(image.width) || 0,
    height: Number(image.height) || 0,
    bytes: Number(image.bytes) || 0,
    url: String(image.url ?? ''),
  };
}

export async function clearBackground(): Promise<void> {
  const response = await fetch(`${SETTINGS_API}/appearance/background`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`清除背景失败（HTTP ${response.status}）`);
}

/** 复制一段文本（路径行用；剪贴板不可用时退回一个可选中文本的兜底）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 无权限 / 非安全上下文：落到下面的兜底 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.('copy') ?? false;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
