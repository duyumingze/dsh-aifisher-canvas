/**
 * 本地媒体库（host 半）
 *
 * 上游 AIFISHER 的媒体库分散在 server/media/ 一大票文件里（mediaAssetRouter 40KB、
 * mediaArtifact、thumbnailCache、legacyLibraryRouter…），都建立在「LIBRARY_DIR + 项目目录 +
 * 每个素材一份 .json 元数据」这套约定上。本插件只保留这套约定的最小可用子集：
 *
 *   磁盘布局（rootDir 缺省 = $DSH_HOME/storages/dsh-aifisher-canvas/media）：
 *     media/<projectId>/images/<file>          ← 图片
 *     media/<projectId>/videos/<file>          ← 视频
 *     media/<projectId>/audios/<file>          ← 音频
 *     media/<projectId>/<type>/<file>.json     ← 同目录同名 sidecar 元数据
 *     media/trash/<projectId>/<type>/<file>    ← 删除后移到这里（不真删，便于找回）
 *
 *   对外 URL（与上游 `.../media/<projectId>/<type>/<file>` 同形，画布把它当 <img>/<video> src）：
 *     /api/aifisher/canvas/media/<projectId>/<type>/<file>
 *
 * 为什么要 sidecar 元数据：`/generation-status/:nodeId` 的恢复逻辑要在「没有任务日记」时
 * 从素材库里反查「这个节点最近产出的素材」（上游 findLatestMediaResult 就是这么做的）。
 *
 * 所有写入都是 tmp + rename 原子写，与 canvas/store.ts 同一套做法。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { copyFile, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { resolveDataDir } from './dataDir';

/** 素材大类（单数，与画布前端 MediaKind 一致）。 */
export type MediaKind = 'image' | 'video' | 'audio';
/** 目录名 / URL 段（复数，与上游目录约定一致）。 */
export type MediaType = 'images' | 'videos' | 'audios';

const TYPE_BY_KIND: Readonly<Record<MediaKind, MediaType>> = {
  image: 'images',
  video: 'videos',
  audio: 'audios',
};
const KIND_BY_TYPE: Readonly<Record<MediaType, MediaKind>> = {
  images: 'image',
  videos: 'video',
  audios: 'audio',
};

/** URL 前缀（restRouter 用它挂路由，mediaStore 用它拼 URL —— 只此一处定义）。 */
export const MEDIA_URL_BASE = '/api/aifisher/canvas/media';

/** 上游的素材 URL 形状前缀（只用于**解析**旧形状，本插件自己只生成 MEDIA_URL_BASE）。 */
export const LEGACY_MEDIA_URL_PREFIX = '/library/media';

/** 各类型的扩展名白名单（照上游 mediaAssetRouter 的 MEDIA_EXTENSIONS）。 */
const EXTENSIONS: Readonly<Record<MediaType, readonly string[]>> = Object.freeze({
  images: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'],
  videos: ['.mp4', '.webm', '.mov', '.m4v', '.mkv'],
  audios: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
});

/** 单文件上限（照上游：图片 50MB、视频 2GB、音频 500MB）。 */
const MAX_BYTES: Readonly<Record<MediaType, number>> = Object.freeze({
  images: 50 * 1024 * 1024,
  videos: 2 * 1024 * 1024 * 1024,
  audios: 500 * 1024 * 1024,
});

/** 素材记录（= sidecar JSON 的形状，也是列表接口返回的元素）。 */
export interface MediaRecord {
  id: string;
  projectId: string;
  type: MediaType;
  kind: MediaKind;
  filename: string;
  /** 原始文件名（用户上传时的那份），仅供展示 */
  originalName?: string;
  url: string;
  bytes: number;
  createdAt: string;
  nodeId?: string;
  prompt?: string;
  model?: string;
  source: 'generation' | 'upload' | 'import' | 'edit';
  /** 视频/音频时长（秒）、图片尺寸等，探测到才写 */
  duration?: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
  resolution?: string;
  /** 上游 workflow 运行额外带的字段（runId 等），保留给前端展示 */
  [extra: string]: unknown;
}

export class MediaError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'INVALID_MEDIA') {
    super(message);
    this.name = 'MediaError';
    this.status = status;
    this.code = code;
  }
}

export function defaultMediaRoot(): string {
  // v1.43：数据目录可由「设置 → 存储 → 项目数据目录」改（见 canvas/dataDir.ts）。
  // 这里每次都现算：进程启动时构造一次 mediaStore，换目录要重启（接口会讲清）。
  return join(resolveDataDir(), 'media');
}

export function isMediaType(value: unknown): value is MediaType {
  return value === 'images' || value === 'videos' || value === 'audios';
}

/**
 * 复数目录名 → 单数 kind；也接受单数输入（前端两种写法都出现过：
 * `assets/upload/${kind}s` 是复数，`assets/${kind}s` 也是复数，但 `?type=image` 有单数）。
 */
export function mediaKindOf(value: unknown): MediaKind | null {
  if (value === 'image' || value === 'video' || value === 'audio') return value;
  if (isMediaType(value)) return KIND_BY_TYPE[value];
  return null;
}

export function mediaTypeOf(value: unknown): MediaType | null {
  if (isMediaType(value)) return value;
  if (value === 'image' || value === 'video' || value === 'audio') return TYPE_BY_KIND[value];
  return null;
}

/** projectId 只允许一段安全的目录名（上游是 uuid，这里宽松一点但擋住穿越）。 */
function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || trimmed === '.' || trimmed === '..') {
    throw new MediaError(`${label}无效`, 400, 'INVALID_MEDIA_SEGMENT');
  }
  // 分隔符 / 控制字符 / 盘符（`C:foo` 这种 Windows 相对盘路径）都不许出现在一段目录名里
  if (/[\\/\u0000-\u001f]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw new MediaError(`${label}含非法字符`, 400, 'INVALID_MEDIA_SEGMENT');
  }
  return trimmed;
}

/** 素材 URL 的三段式引用（项目 + 类型 + 文件）。 */
export interface MediaUrlRef {
  projectId: string;
  type: MediaType;
  filename: string;
}

/** 认这两种形状：本插件的 `/api/aifisher/canvas/media/…` 与上游遗留的 `/library/media/…`。 */
function mediaUrlPrefixes(extra: readonly string[] = []): string[] {
  return [...extra, `${MEDIA_URL_BASE}/`, `${LEGACY_MEDIA_URL_PREFIX}/`];
}

/**
 * 素材 URL → 三段式引用。**不是**本插件的素材 URL（也不是上游 `/library/media` 旧形状）→ null。
 *
 * 这里的核心是**先把查询串/锚点归一掉**：画布客户端会给结果素材挂缓存戳
 * （vendor `canvasGeneration.ts` 的 `withTimestamp()` →
 * `…/images/media-f3e89ede.png?t=1792243183952`），而这个带戳的 URL 就是下一张图的**参考素材**。
 * 旧写法只对 `http(s):` 走 `new URL().pathname`（顺带吃到查询串），相对形状直接当路径用 →
 * `?t=…` 被当成文件名的一部分 → `existsSync` 必然 false → 云端通道报
 * 「参考素材读不出来」。现在相对/绝对/带查询串/带锚点一律过 `new URL(rawUrl, 占位 origin)`，
 * 只取 pathname。
 */
export function parseMediaUrlRef(
  rawUrl: string,
  extraPrefixes: readonly string[] = [],
): MediaUrlRef | null {
  const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!value) return null;
  let pathname: string;
  try {
    // 占位 origin 只用来让相对形状也能解析（相对 URL 的 pathname 与原本一致）。
    pathname = new URL(value, 'http://media.invalid').pathname;
  } catch {
    return null;
  }
  const prefix = mediaUrlPrefixes(extraPrefixes).find((candidate) => pathname.startsWith(candidate));
  if (!prefix) return null;
  let parts: string[];
  try {
    parts = pathname
      .slice(prefix.length)
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (parts.length !== 3) return null;
  const [rawProjectId, rawType, filename] = parts;
  // 复数目录名是规范形状；上游有拼出单数（`…/image/x.png`）的地方，照 mediaTypeOf 归一。
  const type = mediaTypeOf(rawType);
  if (!type || !filename) return null;
  try {
    return { projectId: safeSegment(rawProjectId, '项目 id'), type, filename };
  } catch {
    return null;
  }
}

/** 落盘文件名：只保留 ASCII 安全字符 + 短随机后缀（避免重名互相覆盖、避免 URL 编码问题）。 */
function storedFilename(originalName: unknown, type: MediaType): string {
  const raw = typeof originalName === 'string' && originalName ? basename(originalName) : 'media';
  const ext = extname(raw).toLowerCase();
  const safeExt = EXTENSIONS[type].includes(ext) ? ext : EXTENSIONS[type][0];
  const base =
    raw
      .slice(0, raw.length - extname(raw).length)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 40) || 'media';
  return `${base}-${randomUUID().slice(0, 8)}${safeExt}`;
}

/** 从一个 data URL 拆出 content-type 与字节。 */
export function parseDataUrl(dataUrl: string): { buffer: Buffer; contentType: string } {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) throw new MediaError('data URL 格式无效', 400, 'INVALID_DATA_URL');
  const contentType = match[1] || 'application/octet-stream';
  const buffer = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  return { buffer, contentType };
}

/** 扩展名是否与类型匹配（上传时挡「图片接口塞 mp4」这类错配）。 */
export function assertExtensionForType(filename: string, type: MediaType): void {
  const ext = extname(filename).toLowerCase();
  if (!ext || !EXTENSIONS[type].includes(ext)) {
    throw new MediaError(
      `文件扩展名与素材类型不匹配：${filename}`,
      415,
      'UNSUPPORTED_MEDIA_EXTENSION',
    );
  }
}

export interface SaveMediaInput {
  projectId: string;
  type: MediaType;
  bytes: Buffer;
  /** 原始文件名（用于推断扩展名与展示） */
  filename?: string;
  /** 不含扩展名时的扩展名提示（如 'generation' 场景已知要 .mp4） */
  extension?: string;
  nodeId?: string;
  prompt?: string;
  model?: string;
  source: MediaRecord['source'];
  extra?: Record<string, unknown>;
}

export interface SaveMediaResult extends MediaRecord {
  /** 绝对路径（host 内部用：上传给 ComfyUI、给 ffmpeg 处理） */
  path: string;
}

export interface MediaStoreOptions {
  rootDir?: string;
  urlBase?: string;
}

export function createMediaStore(options: MediaStoreOptions = {}) {
  const rootDir = resolve(options.rootDir ?? defaultMediaRoot());
  const urlBase = options.urlBase ?? MEDIA_URL_BASE;
  const trashDir = join(rootDir, 'trash');

  function typeDir(projectId: string, type: MediaType): string {
    return join(rootDir, safeSegment(projectId, '项目 id'), type);
  }

  function urlFor(projectId: string, type: MediaType, filename: string): string {
    return `${urlBase}/${encodeURIComponent(projectId)}/${type}/${encodeURIComponent(filename)}`;
  }

  async function writeAtomic(target: string, bytes: Buffer): Promise<void> {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${randomUUID().slice(0, 8)}`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }

  async function writeRecord(dir: string, record: MediaRecord): Promise<void> {
    await writeAtomic(join(dir, `${record.filename}.json`), Buffer.from(JSON.stringify(record, null, 2), 'utf8'));
  }

  /** 保存一份素材（写文件 + 写 sidecar），返回带本机路径的记录。 */
  async function save(input: SaveMediaInput): Promise<SaveMediaResult> {
    const { projectId, type } = input;
    const limit = MAX_BYTES[type];
    if (input.bytes.byteLength === 0) {
      throw new MediaError('素材内容为空', 415, 'INVALID_MEDIA_CONTENT');
    }
    if (input.bytes.byteLength > limit) {
      throw new MediaError(
        `素材超过大小上限（${Math.round(limit / 1024 / 1024)} MB）`,
        413,
        'MEDIA_TOO_LARGE',
      );
    }
    const requested = input.filename ?? `media${input.extension ?? ''}`;
    // 扩展名提示：调用方给的是「没有扩展名的基名 + extension」时拼起来再算落盘名
    const withExt = input.extension && !extname(requested) ? `${requested}${input.extension}` : requested;
    assertExtensionForType(withExt, type);

    const dir = typeDir(projectId, type);
    const filename = storedFilename(withExt, type);
    const path = join(dir, filename);
    await writeAtomic(path, input.bytes);

    const record: MediaRecord = {
      id: filename,
      projectId,
      type,
      kind: KIND_BY_TYPE[type],
      filename,
      ...(requested !== filename ? { originalName: basename(requested) } : {}),
      url: urlFor(projectId, type, filename),
      bytes: input.bytes.byteLength,
      createdAt: new Date().toISOString(),
      source: input.source,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.extra ?? {}),
    };
    await writeRecord(dir, record);
    return { ...record, path };
  }

  /** 保存 data URL（生成结果回传、前端把 data: 素材交给后端落盘时走这里）。 */
  async function saveDataUrl(
    dataUrl: string,
    input: Omit<SaveMediaInput, 'bytes'>,
  ): Promise<SaveMediaResult> {
    const { buffer } = parseDataUrl(dataUrl);
    return save({ ...input, bytes: buffer });
  }

  /**
   * 把一份**已在盘上**的素材复制进某个项目（不经过内存）。
   *
   * 用途：资产库条目在库里各留一份副本（保存到资产库 = 从项目复制进 `library` 项目），
   * 本地 SKILL 预设自带素材（保存预设时快照进 `workflow-preset-<id>`，导入时再复制进目标项目）。
   * 这三条都会搬大文件（视频能到几百 MB），所以走 copyFile 而不是 readFile + save。
   * 侧车元数据照 `save()` 的约定写；`extra` 里的键请只放标量展示字段（url/filename 会被覆盖）。
   */
  async function copyFrom(input: {
    sourcePath: string;
    projectId: string;
    type: MediaType;
    /** 目标文件名（只用来推断扩展名与展示名，落盘名仍会加随机后缀防重名） */
    filename?: string;
    source?: MediaRecord['source'];
    extra?: Record<string, unknown>;
  }): Promise<SaveMediaResult> {
    const projectId = safeSegment(input.projectId, '项目 id');
    const { type } = input;
    if (!existsSync(input.sourcePath)) {
      throw new MediaError('源素材不存在', 404, 'MEDIA_SOURCE_MISSING');
    }
    const bytes = await fileSize(input.sourcePath);
    if (bytes === 0) {
      throw new MediaError('素材内容为空', 415, 'INVALID_MEDIA_CONTENT');
    }
    const limit = MAX_BYTES[type];
    if (bytes > limit) {
      throw new MediaError(
        `素材超过大小上限（${Math.round(limit / 1024 / 1024)} MB）`,
        413,
        'MEDIA_TOO_LARGE',
      );
    }
    const requested = input.filename ?? basename(input.sourcePath);
    assertExtensionForType(requested, type);
    const dir = typeDir(projectId, type);
    const filename = storedFilename(requested, type);
    const path = join(dir, filename);
    mkdirSync(dir, { recursive: true });
    await copyFile(input.sourcePath, path);

    const record: MediaRecord = {
      id: filename,
      projectId,
      type,
      kind: KIND_BY_TYPE[type],
      filename,
      ...(requested !== filename ? { originalName: basename(requested) } : {}),
      url: urlFor(projectId, type, filename),
      bytes,
      createdAt: new Date().toISOString(),
      source: input.source ?? 'import',
      ...(input.extra ?? {}),
    };
    await writeRecord(dir, record);
    return { ...record, path };
  }

  /**
   * 把本插件自己的媒体 URL 解析成本机文件路径。
   * `null` 表示「不是本插件的媒体 URL」——调用方应按普通远程 URL 处理。
   * 画布里的参考素材就是这么传进来的：节点上存的是 `/api/aifisher/canvas/media/<项目>/<类型>/<文件>`，
   * 而 ComfyUI 上传需要真正的字节（走 HTTP 回环也行，但直接读盘更快、也不依赖当前监听端口）。
   *
   * 同时认上游的 `/library/media/<项目>/<类型>/<文件>` 形状：vendor 的命名空间改写只覆盖
   * 「前缀判断 / 模板拼接」那几处，画布里仍然有拼出旧形状的地方（例如 workflowCanvasNodes 的正则），
   * 旧形状在 DSH 里没有路由（一定是 404），把它归一到同一棵素材树只会更对。
   *
   * 返回里带 projectId：资产库/预设复制素材时要按「项目 + 类型 + 文件」三要素定位源文件。
   *
   * URL 上的缓存戳（`?t=…`，见 `parseMediaUrlRef` 注释）由 parseMediaUrlRef 统一吃掉；
   * 「是我们素材库的 URL 但文件不在了」也返回 null —— 想区分这种情况用 `parseMediaUrlRef`。
   */
  function localPathForUrl(rawUrl: string): {
    path: string;
    filename: string;
    type: MediaType;
    projectId: string;
  } | null {
    const ref = parseMediaUrlRef(rawUrl, [`${urlBase}/`]);
    if (!ref) return null;
    const target = resolve(rootDir, ref.projectId, ref.type, ref.filename);
    const dir = resolve(rootDir, ref.projectId, ref.type);
    // 双保险：解析结果必须仍在对应目录内（文件名来自 URL，不能信）
    if (target !== dir && !target.startsWith(dir + sep)) return null;
    if (!existsSync(target)) return null;
    return { path: target, filename: ref.filename, type: ref.type, projectId: ref.projectId };
  }

  /** 读了文件内容（给「把画布素材上传给 ComfyUI」用）。 */
  async function readBytesForUrl(rawUrl: string): Promise<{ bytes: Buffer; filename: string } | null> {
    const local = localPathForUrl(rawUrl);
    if (!local) return null;
    return { bytes: await readFile(local.path), filename: local.filename };
  }

  /** 解析一个媒体文件（供路由直接流式返回）。 */
  function resolveFile(
    projectId: string,
    type: MediaType,
    filename: string,
  ): { path: string; record: MediaRecord | null } | null {
    const dir = typeDir(projectId, type);
    const target = resolve(dir, filename);
    if (target !== dir && !target.startsWith(dir + sep)) return null;
    if (!existsSync(target)) return null;
    const record = readRecordSync(dir, filename);
    return { path: target, record };
  }

  /** sidecar 很小，流式返回时用同步读，省一轮 await。 */
  function readRecordSync(dir: string, filename: string): MediaRecord | null {
    const sidecar = join(dir, `${filename}.json`);
    try {
      if (!existsSync(sidecar)) return null;
      return JSON.parse(readFileSync(sidecar, 'utf8')) as MediaRecord;
    } catch {
      return null;
    }
  }

  /** 列出某项目某类型的素材（按创建时间倒序）。 */
  async function list(input: {
    projectId: string;
    type: MediaType;
    limit?: number;
    offset?: number;
  }): Promise<{ assets: MediaRecord[]; total: number; hasMore: boolean }> {
    const dir = typeDir(input.projectId, input.type);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return { assets: [], total: 0, hasMore: false };
    }
    const records: MediaRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      try {
        const raw = await readFile(join(dir, name), 'utf8');
        const record = JSON.parse(raw) as MediaRecord;
        // 文件被手工删掉时不要把死记录列出来
        if (record?.filename && existsSync(join(dir, record.filename))) records.push(record);
      } catch {
        /* 坏 sidecar 跳过 */
      }
    }
    records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 20)));
    return {
      assets: records.slice(offset, offset + limit),
      total: records.length,
      hasMore: offset + limit < records.length,
    };
  }

  /** 移入回收站（不真删：上游也是 trash 语义）。 */
  async function trash(input: {
    projectId: string;
    type: MediaType;
    id: string;
  }): Promise<boolean> {
    const dir = typeDir(input.projectId, input.type);
    const filename = basename(input.id);
    const source = resolve(dir, filename);
    // 文件名来自请求体，先确认它没跑出该类型目录，再确认真的存在
    if (source === dir || !source.startsWith(dir + sep) || !existsSync(source)) return false;
    const target = join(trashDir, safeSegment(input.projectId, '项目 id'), input.type, filename);
    mkdirSync(dirname(target), { recursive: true });
    try {
      await rename(source, target);
    } catch {
      // 跨盘/占用时退回复制 + 删除
      try {
        await copyFile(source, target);
        await unlink(source);
      } catch {
        return false;
      }
    }
    try {
      await unlink(`${source}.json`).catch(() => {});
      await writeFile(`${target}.json`, JSON.stringify({ trashedAt: new Date().toISOString() }));
    } catch {
      /* 元数据不是必需品 */
    }
    return true;
  }

  /**
   * 把整个项目目录移进回收站（本地 SKILL 预设删除时清掉它自带的素材副本）。
   * 与 `trash()` 同一套语义：不真删，只是搬到 `trash/<项目>`。
   */
  async function trashProject(projectId: string): Promise<boolean> {
    const safe = safeSegment(projectId, '项目 id');
    const source = join(rootDir, safe);
    if (!existsSync(source)) return false;
    // 同名目录已经进过回收站时加时间戳，避免 rename 覆盖失败
    const target = join(trashDir, existsSync(join(trashDir, safe)) ? `${safe}-${Date.now()}` : safe);
    mkdirSync(dirname(target), { recursive: true });
    try {
      await rename(source, target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 反查「某个节点最近产出的素材」（generation-status 恢复用）。
   * 上游是扫 LIBRARY_DIR/media 下所有项目 + 类型；这里同样扫，但只在必要时才做。
   */
  async function findLatestForNode(nodeId: string): Promise<MediaRecord | null> {
    let projects: string[] = [];
    try {
      projects = (await readdir(rootDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== 'trash')
        .map((entry) => entry.name);
    } catch {
      return null;
    }
    let latest: MediaRecord | null = null;
    for (const projectId of projects) {
      for (const type of ['images', 'videos', 'audios'] as const) {
        const dir = join(rootDir, projectId, type);
        let names: string[] = [];
        try {
          names = await readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
          try {
            const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as MediaRecord;
            if (record?.nodeId !== nodeId || !record.filename) continue;
            if (!latest || record.createdAt > latest.createdAt) latest = record;
          } catch {
            /* 跳过坏记录 */
          }
        }
      }
    }
    return latest;
  }

  /** 数据类型 → 目录/URL 的映射（诊断接口用）。 */
  function stats(): Record<string, unknown> {
    return { rootDir, urlBase, exists: existsSync(rootDir) };
  }

  async function fileSize(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }

  return {
    rootDir,
    urlBase,
    urlFor,
    save,
    saveDataUrl,
    copyFrom,
    resolveFile,
    /** 素材 URL → 三段式引用（缓存戳已归一；**不**看文件在不在，用来区分「不是本站素材」与「已不在库里」）。 */
    parseUrl: (rawUrl: string): MediaUrlRef | null => parseMediaUrlRef(rawUrl, [`${urlBase}/`]),
    localPathForUrl,
    readBytesForUrl,
    list,
    trash,
    trashProject,
    findLatestForNode,
    stats,
    fileSize,
  };
}

export type MediaStore = ReturnType<typeof createMediaStore>;
