/**
 * 媒体下载（host 半）。
 *
 * 上游 mediaDownloadFileName.ts 把「下载」整个交给它自己的 Electron/本地后端：
 * 画布上的下载按钮、素材预览的下载、设置页的存储分区，走的都是这几条：
 *
 *   GET    /media-download/settings                    → MediaDownloadSettings
 *   PATCH  /media-download/settings  {askEachTime}      → MediaDownloadSettings
 *   POST   /media-download/settings/directory          → MediaDownloadSettings | {status:'cancelled'}
 *   DELETE /media-download/settings/directory          → MediaDownloadSettings（恢复默认）
 *   POST   /media-download/save      {sourceUrl,fileName} → {status:'saved',fileName,directory}
 *   POST   /media-download/open-directory              → {status:'opened',foreground,directory,fileName}
 *
 * 注意 **客户端没有浏览器下载兜底**：save 拿不到 200 就弹「下载失败」。
 * 所以这几条不实现，画布上所有「下载」按钮都是坏的（这正是要补的）。
 *
 * 本插件的语义（与上游的差异，都是刻意的）：
 *   1. 默认下载目录 = <画布数据目录>/downloads（可用 PATCH {directory} 改；见 README）。
 *   2. 没有原生「选择文件夹」对话框：POST /settings/directory 一律回 {status:'cancelled'}，
 *      设置页会显示「已取消」，不会假装成功。想换目录就走 PATCH directory（agent/命令行可用）。
 *   3. askEachTime（每次询问保存位置）= 系统保存框，DSH 版没有。开启时 save 会明确回
 *      DOWNLOAD_DIALOG_UNSUPPORTED，让用户看到「关掉这个开关」而不是静默变行为。
 *   4. 素材来源只接受：本插件媒体 URL（读盘）/ http(s) / data:。任意本机路径一律 422 ——
 *      不接受「用下载器读任意文件」。
 *   5. 同名文件不覆盖：自动退让成 "名字 (2).ext"。
 *
 * 落盘：<画布数据目录>/downloads.json（原子写）。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { basename, extname, isAbsolute, join, parse, resolve } from 'node:path';
import { readJsonBody, sendJson } from '../http/httpUtil';
import { MediaError, parseDataUrl, type MediaStore } from './mediaStore';

export interface MediaDownloadDeps {
  mediaStore: MediaStore;
  /** 画布数据目录。 */
  dataDir: string;
}

/** 单个文件上限（远程下载/落盘都按这个拦）。 */
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 10 * 60 * 1000;
/** 文件名长度上限（含扩展名），够长又不会撞 Windows 路径限制。 */
const MAX_FILE_NAME = 120;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

interface DownloadSettings {
  /** 自定义目录（null = 用默认目录）。 */
  directory: string | null;
  askEachTime: boolean;
}

const DEFAULT_SETTINGS: DownloadSettings = { directory: null, askEachTime: false };

function settingsPath(dataDir: string): string {
  return join(dataDir, 'downloads.json');
}

export function defaultDownloadDirectory(dataDir: string): string {
  return join(dataDir, 'downloads');
}

async function readSettings(dataDir: string): Promise<DownloadSettings> {
  const file = settingsPath(dataDir);
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<DownloadSettings>;
    return {
      directory:
        typeof parsed.directory === 'string' && isAbsolute(parsed.directory)
          ? parsed.directory
          : null,
      askEachTime: parsed.askEachTime === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(dataDir: string, settings: DownloadSettings): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const file = settingsPath(dataDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
  await rename(tmp, file);
}

function currentDirectory(dataDir: string, settings: DownloadSettings): string {
  return settings.directory ?? defaultDownloadDirectory(dataDir);
}

function describeSettings(dataDir: string, settings: DownloadSettings) {
  const directory = currentDirectory(dataDir, settings);
  const exists = existsSync(directory);
  return {
    directory,
    defaultDirectory: defaultDownloadDirectory(dataDir),
    customDirectory: settings.directory !== null,
    askEachTime: settings.askEachTime,
    // 目录不存在只是「还没有第一次下载」，不算不可用 —— 保存时会 mkdir
    directoryAvailable: exists ? statSync(directory).isDirectory() : true,
  };
}

/** 文件名消毒：去掉路径成分与 Windows 非法字符，保留扩展名。 */
export function sanitizeDownloadFileName(raw: unknown): string | null {
  const name = basename(String(raw ?? '').trim());
  if (!name) return null;
  const ext = extname(name).slice(0, 16);
  let stem = name.slice(0, name.length - ext.length);
  stem = stem
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
  if (!stem) stem = 'download';
  if (WINDOWS_RESERVED.test(stem)) stem = `${stem}-file`;
  const room = Math.max(8, MAX_FILE_NAME - ext.length);
  return `${stem.slice(0, room)}${ext}`;
}

/** 同名不覆盖：a.png → a (2).png。 */
function uniqueTarget(directory: string, fileName: string): string {
  const { name, ext } = parse(fileName);
  let candidate = join(directory, `${name}${ext}`);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = join(directory, `${name} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

/**
 * 给「项目归档导出」用的目录读数（v1.42）。
 *
 * 项目导出与素材下载共用**同一个下载目录**（`downloads.json`）：用户只需要理解
 * 「下载/导出的东西都落到这一个目录」，面板上也只列一条路径。所以这里把私有设置
 * 读出来给 `projectArchiveRouter` 用，而不是另开一份 `exports.json`。
 */
export async function downloadDirectoryInfo(dataDir: string): Promise<{
  directory: string;
  defaultDirectory: string;
  customDirectory: boolean;
}> {
  const settings = await readSettings(dataDir);
  return {
    directory: currentDirectory(dataDir, settings),
    defaultDirectory: defaultDownloadDirectory(dataDir),
    customDirectory: settings.directory !== null,
  };
}

/** 同名不覆盖的落点（`a.fisherai` → `a (2).fisherai`）。项目归档导出复用同一口径。 */
export function uniqueDownloadTarget(directory: string, fileName: string): string {
  return uniqueTarget(directory, fileName);
}

/** 远程/本地取字节。返回 null 表示「这个 URL 我们不认」。 */
async function fetchSource(
  deps: MediaDownloadDeps,
  sourceUrl: string,
): Promise<{ bytes: Buffer; suggestedName: string | null } | null> {
  const local = deps.mediaStore.localPathForUrl(sourceUrl);
  if (local) {
    return { bytes: await readFile(local.path), suggestedName: local.filename };
  }
  if (/^data:/i.test(sourceUrl)) {
    const parsed = parseDataUrl(sourceUrl);
    return { bytes: parsed.buffer, suggestedName: null };
  }
  if (!/^https?:\/\//i.test(sourceUrl)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      throw new MediaError(
        `下载失败：源地址返回 ${response.status}。`,
        502,
        'DOWNLOAD_SOURCE_FAILED',
      );
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_BYTES) {
      throw new MediaError('下载失败：文件超过 2 GiB。', 413, 'DOWNLOAD_TOO_LARGE');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      throw new MediaError('下载失败：文件超过 2 GiB。', 413, 'DOWNLOAD_TOO_LARGE');
    }
    const fromHeader = response.headers.get('content-disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(fromHeader);
    let suggested: string | null = null;
    if (match?.[1]) {
      try {
        suggested = decodeURIComponent(match[1]);
      } catch {
        suggested = match[1];
      }
    }
    if (!suggested) {
      try {
        const tail = basename(new URL(sourceUrl).pathname);
        suggested = tail || null;
      } catch {
        suggested = null;
      }
    }
    return { bytes, suggestedName: suggested };
  } finally {
    clearTimeout(timer);
  }
}

/** 打开目录：Windows 用 explorer，macOS 用 open，Linux 用 xdg-open。 */
function openDirectory(directory: string): boolean {
  const command =
    process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [directory], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function handleSave(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MediaDownloadDeps,
): Promise<void> {
  const body = (await readJsonBody(req, 64 * 1024)) as {
    sourceUrl?: unknown;
    fileName?: unknown;
  } | null;
  if (!body || typeof body.sourceUrl !== 'string' || !body.sourceUrl) {
    sendJson(res, 422, { error: '缺少要下载的素材地址。', code: 'DOWNLOAD_SOURCE_MISSING' });
    return;
  }
  const settings = await readSettings(deps.dataDir);
  if (settings.askEachTime) {
    sendJson(res, 501, {
      error: 'DSH 版没有系统保存对话框：请关闭「每次下载时询问保存位置」，或直接下载到当前目录。',
      code: 'DOWNLOAD_DIALOG_UNSUPPORTED',
    });
    return;
  }

  let source: { bytes: Buffer; suggestedName: string | null } | null;
  try {
    source = await fetchSource(deps, body.sourceUrl);
  } catch (error) {
    if (error instanceof MediaError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return;
    }
    sendJson(res, 502, {
      error: error instanceof Error ? error.message : '下载失败。',
      code: 'DOWNLOAD_SOURCE_FAILED',
    });
    return;
  }
  if (!source) {
    sendJson(res, 422, {
      error: '只支持本插件素材、http(s) 链接与 data: 数据；不接受本机任意路径。',
      code: 'DOWNLOAD_SOURCE_UNSUPPORTED',
    });
    return;
  }

  const rawName =
    (typeof body.fileName === 'string' && body.fileName) || source.suggestedName || 'download.bin';
  const fileName = sanitizeDownloadFileName(rawName);
  if (!fileName) {
    sendJson(res, 422, { error: '下载文件名无效。', code: 'DOWNLOAD_NAME_INVALID' });
    return;
  }
  const directory = currentDirectory(deps.dataDir, settings);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    sendJson(res, 500, {
      error: `下载目录不可用：${error instanceof Error ? error.message : String(error)}`,
      code: 'DOWNLOAD_DIRECTORY_UNAVAILABLE',
    });
    return;
  }
  const target = uniqueTarget(directory, fileName);
  const tmp = `${target}.part`;
  try {
    await writeFile(tmp, source.bytes);
    await rename(tmp, target);
  } catch (error) {
    sendJson(res, 500, {
      error: `写入下载目录失败：${error instanceof Error ? error.message : String(error)}`,
      code: 'DOWNLOAD_WRITE_FAILED',
    });
    return;
  }
  sendJson(res, 200, { status: 'saved', fileName: basename(target), directory });
}

/**
 * 处理 /media-download/* 子路径；已处理返回 true。
 */
export async function handleMediaDownloadApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: MediaDownloadDeps;
}): Promise<boolean> {
  const { req, res, parts, deps } = input;
  const method = (req.method ?? 'GET').toUpperCase();

  if (parts[0] !== 'media-download') return false;
  const settings = await readSettings(deps.dataDir);

  if (parts.length === 2 && parts[1] === 'settings') {
    if (method === 'GET') {
      sendJson(res, 200, describeSettings(deps.dataDir, settings));
      return true;
    }
    if (method === 'PATCH' || method === 'POST') {
      const body = (await readJsonBody(req, 16 * 1024)) as {
        askEachTime?: unknown;
        directory?: unknown;
      } | null;
      if (!body) {
        sendJson(res, 422, { error: '下载设置无效。', code: 'DOWNLOAD_SETTINGS_INVALID' });
        return true;
      }
      const next: DownloadSettings = { ...settings };
      if (typeof body.askEachTime === 'boolean') next.askEachTime = body.askEachTime;
      if (body.directory === null) next.directory = null;
      else if (typeof body.directory === 'string') {
        const candidate = resolve(body.directory);
        if (!isAbsolute(candidate)) {
          sendJson(res, 422, { error: '下载目录必须是绝对路径。', code: 'DOWNLOAD_DIRECTORY_INVALID' });
          return true;
        }
        next.directory = candidate;
      }
      await writeSettings(deps.dataDir, next);
      sendJson(res, 200, describeSettings(deps.dataDir, next));
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  if (parts.length === 3 && parts[1] === 'settings' && parts[2] === 'directory') {
    if (method === 'POST') {
      // 没有原生目录选择器：明确回 cancelled（设置页会显示「已取消」）
      sendJson(res, 200, { status: 'cancelled' });
      return true;
    }
    if (method === 'DELETE') {
      await writeSettings(deps.dataDir, { ...settings, directory: null });
      sendJson(res, 200, describeSettings(deps.dataDir, { ...settings, directory: null }));
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  if (parts.length === 2 && parts[1] === 'save') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    await handleSave(req, res, deps);
    return true;
  }

  if (parts.length === 2 && parts[1] === 'open-directory') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const directory = currentDirectory(deps.dataDir, settings);
    if (!existsSync(directory)) {
      sendJson(res, 404, {
        error: '下载目录还不存在（还没有下载过文件）。',
        code: 'DOWNLOAD_DIRECTORY_MISSING',
      });
      return true;
    }
    const opened = openDirectory(directory);
    if (!opened) {
      sendJson(res, 501, {
        error: '这个平台没有可用的「打开目录」方式。',
        code: 'DOWNLOAD_OPEN_UNSUPPORTED',
      });
      return true;
    }
    sendJson(res, 200, {
      status: 'opened',
      // explorer 是异步拉起的，没法可靠判断是否跳到前台
      foreground: false,
      fileName: null,
      directory,
    });
    return true;
  }

  return false;
}

/** 诊断用：下载设置与目录状态。 */
export async function mediaDownloadStatus(dataDir: string): Promise<Record<string, unknown>> {
  const settings = await readSettings(dataDir);
  const directory = currentDirectory(dataDir, settings);
  return {
    directory,
    defaultDirectory: defaultDownloadDirectory(dataDir),
    customDirectory: settings.directory !== null,
    askEachTime: settings.askEachTime,
    directoryExists: existsSync(directory),
  };
}
