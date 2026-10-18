/**
 * 项目备份 / 恢复（host 半）—— 画布「项目归档」面板（v1.42）与 agent 的 projects 导出走这几条。
 *
 * 上游是 Electron 桌面版：导出走 `GET /workflows/<id>/backup`（浏览器直接下载，
 * 靠 Content-Disposition 命名），导入走 `POST /workflows/restore`
 * （有本机路径时 body 是 `{path}`，纯浏览器时 body 是文件原始字节），
 * 回执必须带 string 类型的 `id` —— 前端拿它 openProject。
 *
 * v1.42 在这个基础上补了两条（面板的「导出到本机目录」与规模预览）：
 *   GET  /workflows/<id>/backup/info   → 归档规模（节点数 / 素材个数与字节 / 估算归档大小 / 目标目录）
 *   POST /workflows/<id>/backup/save   → 把归档直接写到本机目录（默认 = 下载目录，body 可给一次性覆盖）
 *
 * 本插件的归档格式（自己定的 v1，够用且自描述）：
 *   {
 *     "format": "dsh-aifisher-project",
 *     "version": 1,
 *     "exportedAt": "2026-10-16T…",
 *     "project": { ...canvas.json 里的那份文档... },
 *     "media": { "<原项目id>/<类型>/<文件>": "<base64>" },   // 只带这个项目自己的素材
 *     "mediaOmitted": false                                  // 素材超上限时为 true
 *   }
 *
 * 恢复时：新建一个项目 id（不覆盖任何现有项目）→ 把文档里所有
 * `/api/aifisher/canvas/media/<旧id>/…`（含旧的 `/library/media/<旧id>/…`）改写成新 id →
 * 素材按 base64 写回新项目目录 → 存成新文档 → 回 `{ id }`。
 *
 * 上限：素材总量 512 MiB（超了就只带文档，并在回执/归档里标记 mediaOmitted）。
 * 本机路径形态的 path 只接受 `.fisherai` / `.json` 结尾的绝对路径
 * （同源围栏在 restRouter 已经拦了跨站请求）。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJsonBody, readRawBody, sendJson } from '../http/httpUtil';
import type { CanvasStore } from './store';
import { LEGACY_MEDIA_URL_PREFIX, MEDIA_URL_BASE, type MediaStore } from './mediaStore';
import { downloadDirectoryInfo, uniqueDownloadTarget } from './mediaDownloadRouter';

export interface ProjectArchiveDeps {
  store: CanvasStore;
  mediaStore: MediaStore;
  dataDir: string;
}

const ARCHIVE_FORMAT = 'dsh-aifisher-project';
const ARCHIVE_VERSION = 1;
/** 归档里素材总量上限（超出就只导出文档）。 */
const MAX_ARCHIVE_MEDIA_BYTES = 512 * 1024 * 1024;
/** 导入 body 上限（base64 会膨胀 ~1/3，留出余量）。 */
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

interface ArchiveMediaEntry {
  path: string;
  base64: string;
}

interface Archive {
  format: string;
  version: number;
  exportedAt: string;
  project: Record<string, unknown>;
  media: Record<string, string>;
  mediaOmitted: boolean;
  /** 旧版 `.json` 画布文档（没有 format 外壳、素材不随行）：v1.42 兼容读入。 */
  legacy?: boolean;
}

function safeFileStem(title: unknown, id: string): string {
  const raw = typeof title === 'string' && title.trim() ? title.trim() : `project-${id}`;
  return raw.replace(/[\\/:*?"<>|]/g, '-').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || 'project';
}

/** 收集某个项目目录下的素材（相对 media 根的路径 → 绝对路径）。 */
function collectProjectMedia(mediaRoot: string, projectId: string): Array<{ rel: string; abs: string }> {
  const projectDir = join(mediaRoot, projectId);
  if (!existsSync(projectDir)) return [];
  const found: Array<{ rel: string; abs: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      // 侧车 JSON（生成状态）不是素材，不进归档
      if (entry.name.endsWith('.json')) continue;
      found.push({ rel: relative(mediaRoot, abs).split(sep).join('/'), abs });
    }
  };
  walk(projectDir);
  return found;
}

async function buildArchive(
  deps: ProjectArchiveDeps,
  projectId: string,
): Promise<Archive | null> {
  const document = deps.store.getDocument(projectId);
  if (!document) return null;
  const media: Record<string, string> = {};
  let omitted = false;
  let total = 0;
  for (const item of collectProjectMedia(deps.mediaStore.rootDir, projectId)) {
    const size = statSync(item.abs).size;
    if (total + size > MAX_ARCHIVE_MEDIA_BYTES) {
      omitted = true;
      media[`${item.rel}`] = ''; // 占位：让导入端知道这里有素材但没带
      continue;
    }
    total += size;
    media[item.rel] = (await readFile(item.abs)).toString('base64');
  }
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    project: document as unknown as Record<string, unknown>,
    media,
    mediaOmitted: omitted,
  };
}

/**
 * 归档规模预览（`GET /workflows/:id/backup/info`，v1.42）。
 *
 * 只 stat、不读文件内容 —— 面板一打开就要显示「这个项目导出后大概多大」，
 * 真去把 500MB 素材读进内存再算就太蠢了。`archiveBytes` 是**估算**：
 * 文档字节 + 素材 base64（×4/3）+ 一点点 JSON 包装开销。
 */
function archiveInfo(deps: ProjectArchiveDeps, projectId: string) {
  const document = deps.store.getDocument(projectId);
  if (!document) return null;
  const files = collectProjectMedia(deps.mediaStore.rootDir, projectId);
  let mediaBytes = 0;
  for (const item of files) {
    try {
      mediaBytes += statSync(item.abs).size;
    } catch {
      /* 统计不到的按 0 算，不拦预览 */
    }
  }
  const documentBytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
  const omitted = mediaBytes > MAX_ARCHIVE_MEDIA_BYTES;
  const keptBytes = omitted ? 0 : mediaBytes;
  return {
    projectId,
    title: typeof document.title === 'string' ? document.title : '',
    nodeCount: Array.isArray(document.nodes) ? document.nodes.length : 0,
    groupCount: Array.isArray(document.groups) ? document.groups.length : 0,
    documentBytes,
    mediaFiles: files.length,
    mediaBytes,
    mediaOmitted: omitted,
    // base64 膨胀 4/3；多留 2KB 给归档外壳字段
    archiveBytes: documentBytes + Math.ceil(keptBytes * (4 / 3)) + 2048,
    maxMediaBytes: MAX_ARCHIVE_MEDIA_BYTES,
    fileName: `${safeFileStem(document.title, projectId)}.fisherai`,
  };
}

/** 一次性覆盖用的导出目录：只认绝对路径，且不许指到项目素材目录里去（那会混在一起）。 */
function resolveExportDirectory(raw: unknown, mediaRoot: string, fallback: string): string | null {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  // ⚠️ 必须先判「原始输入是不是绝对路径」再 resolve —— resolve() 会把相对路径补成
  // 绝对路径（相对 cwd），先 resolve 再 isAbsolute 永远为真，等于没校验。
  if (!isAbsolute(value)) return null;
  const candidate = resolve(value);
  const root = resolve(mediaRoot);
  if (candidate === root || candidate.startsWith(root + sep)) return null;
  return candidate;
}

/**
 * 把归档写到本机目录（`POST /workflows/:id/backup/save`，v1.42）。
 *
 * 为什么不用浏览器下载：Electron/无头浏览器对 `a[download]` 的支持不完全一致，
 * 500MB 的归档走一遍浏览器内存也不合适。这里由 host 直接落盘，回执给出**绝对路径**，
 * 面板上就能显示「导出到哪了」并一键打开目录（`/media-download/open-directory`）。
 */
async function saveArchiveToDirectory(
  deps: ProjectArchiveDeps,
  projectId: string,
  requestedDirectory: unknown,
): Promise<
  | {
      status: 'saved';
      path: string;
      fileName: string;
      directory: string;
      bytes: number;
      mediaFiles: number;
      mediaOmitted: boolean;
    }
  | { error: string; code: string; status?: number }
> {
  const info = archiveInfo(deps, projectId);
  if (!info) return { error: '项目不存在，无法导出。', code: 'PROJECT_NOT_FOUND', status: 404 };
  const settings = await downloadDirectoryInfo(deps.dataDir);
  const directory = resolveExportDirectory(
    requestedDirectory,
    deps.mediaStore.rootDir,
    settings.directory,
  );
  if (!directory) {
    return {
      error: '导出目录必须是绝对路径，且不能指向本插件的素材目录。',
      code: 'ARCHIVE_DIRECTORY_INVALID',
      status: 422,
    };
  }
  const archive = await buildArchive(deps, projectId);
  if (!archive) return { error: '项目不存在，无法导出。', code: 'PROJECT_NOT_FOUND', status: 404 };
  const body = Buffer.from(JSON.stringify(archive), 'utf8');
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return {
      error: `导出目录不可用：${error instanceof Error ? error.message : String(error)}`,
      code: 'ARCHIVE_DIRECTORY_UNAVAILABLE',
      status: 500,
    };
  }
  const target = uniqueDownloadTarget(directory, info.fileName);
  const tmp = `${target}.part`;
  try {
    await writeFile(tmp, body);
    await rename(tmp, target);
  } catch (error) {
    return {
      error: `写入导出目录失败：${error instanceof Error ? error.message : String(error)}`,
      code: 'ARCHIVE_WRITE_FAILED',
      status: 500,
    };
  }
  return {
    status: 'saved',
    path: target,
    fileName: basename(target),
    directory,
    bytes: body.length,
    mediaFiles: Object.keys(archive.media).length,
    mediaOmitted: archive.mediaOmitted,
  };
}

/** 把文档里指向旧项目 id 的素材 URL 改成新 id（新旧的 base 与旧的上游前缀都认）。 */
function rewriteMediaProjectId(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    let next = value;
    for (const base of [MEDIA_URL_BASE, LEGACY_MEDIA_URL_PREFIX]) {
      next = next.split(`${base}/${from}/`).join(`${base}/${to}/`);
    }
    return next;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteMediaProjectId(item, from, to));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = rewriteMediaProjectId(item, from, to);
    }
    return result;
  }
  return value;
}

function parseArchive(buffer: Buffer): { archive: Archive } | { error: string; code: string } {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    return { error: '这个文件不是项目备份（不是合法 JSON）。', code: 'ARCHIVE_INVALID_JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { error: '这个文件不是项目备份。', code: 'ARCHIVE_INVALID' };
  }
  const archive = parsed as Partial<Archive>;
  if (archive.format !== ARCHIVE_FORMAT) {
    /**
     * v1.42：兼容「旧版画布文档」`.json`（就是 canvas.json 里那份文档，没有 format 外壳、
     * 也没有随行素材）。判据只有一个：**有 nodes 数组**。这样面板的导入既能吃自己的
     * `.fisherai`，也能吃用户手里历史遗留的项目 JSON；不给素材就只是素材缺失（回执里说明）。
     */
    const candidate = parsed as { nodes?: unknown; id?: unknown; title?: unknown };
    if (Array.isArray(candidate.nodes) && !('format' in (parsed as object))) {
      return {
        archive: {
          format: 'canvas-document',
          version: 0,
          exportedAt: '',
          project: parsed as Record<string, unknown>,
          media: {},
          mediaOmitted: false,
          legacy: true,
        },
      };
    }
    return {
      error: `不认识的备份格式：${String(archive.format ?? '(缺失)')}。本插件只认 ${ARCHIVE_FORMAT}。`,
      code: 'ARCHIVE_FORMAT_UNKNOWN',
    };
  }
  if (Number(archive.version) > ARCHIVE_VERSION) {
    return {
      error: `备份版本（v${String(archive.version)}）比当前插件新，请先升级插件。`,
      code: 'ARCHIVE_VERSION_TOO_NEW',
    };
  }
  if (!archive.project || typeof archive.project !== 'object') {
    return { error: '备份里没有项目数据。', code: 'ARCHIVE_PROJECT_MISSING' };
  }
  return {
    archive: {
      format: archive.format,
      version: Number(archive.version) || ARCHIVE_VERSION,
      exportedAt: typeof archive.exportedAt === 'string' ? archive.exportedAt : '',
      project: archive.project as Record<string, unknown>,
      media: (archive.media as Record<string, string>) ?? {},
      mediaOmitted: archive.mediaOmitted === true,
      ...(archive.legacy === true ? { legacy: true } : {}),
    },
  };
}

/** 恢复：新建项目 + 写回素材。 */
async function restoreArchive(
  deps: ProjectArchiveDeps,
  buffer: Buffer,
): Promise<
  | {
      id: string;
      title: string;
      nodeCount: number;
      mediaRestored: number;
      mediaMissing: number;
      legacy: boolean;
    }
  | { error: string; code: string; status?: number }
> {
  const parsed = parseArchive(buffer);
  if ('error' in parsed) return parsed;
  const { archive } = parsed;
  const oldId = typeof archive.project.id === 'string' ? archive.project.id : '';
  const newId = randomUUID();
  // 旧版 `.json` 文档可能压根没有 id：没有「旧 id」就无从改写（硬替换空串会把
  // `media//` 这种双斜杠也搅进去），素材地址原样留着 —— 反正这种归档本来就不带素材。
  const project = (oldId
    ? rewriteMediaProjectId(archive.project, oldId, newId)
    : archive.project) as Record<string, unknown>;

  let restored = 0;
  let missing = 0;
  for (const [rel, base64] of Object.entries(archive.media)) {
    if (!base64) {
      missing += 1;
      continue;
    }
    // 归档里的路径是「<原项目id>/<类型>/<文件>」：恢复时必须换到新项目目录下，
    // 否则会把素材写回（甚至覆盖）原项目的文件。
    const relTarget =
      oldId && rel.startsWith(`${oldId}/`) ? `${newId}/${rel.slice(oldId.length + 1)}` : rel;
    // 越界路径一律拒（rel 来自归档文件，不能信）
    const target = resolve(deps.mediaStore.rootDir, relTarget);
    const root = resolve(deps.mediaStore.rootDir);
    if (!target.startsWith(root + sep)) continue;
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.part`;
    await writeFile(tmp, Buffer.from(base64, 'base64'));
    await rename(tmp, target);
    restored += 1;
  }

  const saved = await deps.store.saveDocument({
    ...project,
    id: newId,
    revision: 0,
  });
  // saveDocument 只回 { id, revision, success }，标题/节点数要回读一次存档
  const stored = deps.store.getDocument(saved.id);
  return {
    id: saved.id,
    title: typeof stored?.title === 'string' ? stored.title : '',
    nodeCount: Array.isArray(stored?.nodes) ? stored.nodes.length : 0,
    mediaRestored: restored,
    mediaMissing: missing,
    legacy: archive.legacy === true,
  };
}

/** 处理 /workflows/<id>/backup 与 /workflows/restore；已处理返回 true。 */
export async function handleProjectArchiveApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  parts: string[];
  deps: ProjectArchiveDeps;
}): Promise<boolean> {
  const { req, res, parts, deps } = input;
  const method = (req.method ?? 'GET').toUpperCase();
  if (parts[0] !== 'workflows') return false;

  if (parts.length === 2 && parts[1] === 'restore') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    let buffer: Buffer | null = null;
    if (contentType === 'application/json') {
      const raw = await readRawBody(req, 64 * 1024);
      let path = '';
      try {
        const body = raw ? (JSON.parse(raw.toString('utf8')) as { path?: unknown }) : null;
        path = typeof body?.path === 'string' ? body.path : '';
      } catch {
        path = '';
      }
      if (!path) {
        sendJson(res, 422, { error: '备份路径无效。', code: 'RESTORE_PATH_INVALID' });
        return true;
      }
      if (!isAbsolute(path) || !/\.(fisherai|json)$/i.test(path)) {
        sendJson(res, 422, {
          error: '只接受 .fisherai / .json 备份文件的绝对路径。',
          code: 'RESTORE_PATH_INVALID',
        });
        return true;
      }
      if (!existsSync(path)) {
        sendJson(res, 404, { error: `备份文件不存在：${path}`, code: 'RESTORE_FILE_MISSING' });
        return true;
      }
      buffer = await readFile(path);
    } else {
      buffer = await readRawBody(req, MAX_IMPORT_BYTES);
    }
    if (!buffer || buffer.length === 0) {
      sendJson(res, 422, {
        error: buffer ? '备份文件是空的。' : `备份文件超过 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MiB。`,
        code: 'RESTORE_BODY_INVALID',
      });
      return true;
    }
    const result = await restoreArchive(deps, buffer);
    if ('error' in result) {
      sendJson(res, result.status ?? 422, { error: result.error, code: result.code });
      return true;
    }
    sendJson(res, 200, {
      id: result.id,
      title: result.title,
      nodeCount: result.nodeCount,
      mediaRestored: result.mediaRestored,
      ...(result.mediaMissing ? { mediaMissing: result.mediaMissing } : {}),
      ...(result.legacy ? { legacy: true } : {}),
    });
    return true;
  }

  /**
   * v1.42：`/workflows/<id>/backup/info` 与 `/workflows/<id>/backup/save`。
   * 放在原来的 `/backup`（parts.length === 3）之前判，免得被它先吃掉。
   */
  if (parts.length === 4 && parts[2] === 'backup') {
    const projectId = parts[1];
    if (parts[3] === 'info') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const info = archiveInfo(deps, projectId);
      if (!info) {
        sendJson(res, 404, { error: '项目不存在，无法导出。', code: 'PROJECT_NOT_FOUND' });
        return true;
      }
      const settings = await downloadDirectoryInfo(deps.dataDir);
      sendJson(res, 200, {
        ...info,
        directory: settings.directory,
        defaultDirectory: settings.defaultDirectory,
        customDirectory: settings.customDirectory,
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
      });
      return true;
    }
    if (parts[3] === 'save') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const body = (await readJsonBody(req, 16 * 1024)) as { directory?: unknown } | null;
      const result = await saveArchiveToDirectory(deps, projectId, body?.directory);
      if ('error' in result) {
        sendJson(res, result.status ?? 500, { error: result.error, code: result.code });
        return true;
      }
      sendJson(res, 200, result);
      return true;
    }
  }

  if (parts.length === 3 && parts[2] === 'backup') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const projectId = parts[1];
    const archive = await buildArchive(deps, projectId);
    if (!archive) {
      sendJson(res, 404, { error: '项目不存在，无法导出。', code: 'PROJECT_NOT_FOUND' });
      return true;
    }
    const body = Buffer.from(JSON.stringify(archive), 'utf8');
    const fileName = `${safeFileStem(archive.project.title, projectId)}.fisherai`;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      // 非 ASCII 文件名用 RFC 5987 的 filename*，同时给一个 ASCII 兜底
      'content-disposition': `attachment; filename="project-${projectId}.fisherai"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    res.end(body);
    return true;
  }

  return false;
}

/** 诊断用：归档能力概览。 */
export function projectArchiveStatus(): Record<string, unknown> {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    maxMediaBytes: MAX_ARCHIVE_MEDIA_BYTES,
    routes: [
      'GET /workflows/<id>/backup',
      'GET /workflows/<id>/backup/info',
      'POST /workflows/<id>/backup/save',
      'POST /workflows/restore',
    ],
  };
}
