/**
 * 画布「资产库 / 本地 SKILL 预设」（host 半）
 *
 * 对应上游 `server/media/legacyLibraryRouter.js` 里画布真正会用到的那几条：
 *
 *   GET    /api/aifisher/canvas/library                          资产库列表（数组，不分页）
 *   POST   /api/aifisher/canvas/library                          把一份素材存进资产库
 *   PATCH  /api/aifisher/canvas/library/:id                      改 name/category/ownership
 *   DELETE /api/aifisher/canvas/library/:id                      删除资产库条目
 *   POST   /api/aifisher/canvas/library/import                   把库里的素材复制进某个项目
 *   GET    /api/aifisher/canvas/library/workflows                本地 SKILL 预设列表
 *   POST   /api/aifisher/canvas/library/workflows                把当前节点组合存成预设
 *   POST   /api/aifisher/canvas/library/workflows/import         把预设插进某个项目
 *   DELETE /api/aifisher/canvas/library/workflows/:id            删除本地 SKILL
 *
 * ── 与上游的形态差异（都是「本地化」而非「简化」）────────────────────────────
 *
 * 上游的资产库是 `LIBRARY_DIR/assets/<分类>/<文件>` 一棵**独立**的树，走 `/library/assets/...`
 * 服务；本插件只有一套素材树（`mediaStore`，URL 形状 `/api/aifisher/canvas/media/<项目>/<类型>/<文件>`），
 * 所以这里把「库」做成**同一套素材树上的一个保留项目 + 一份索引**：
 *
 *   - 条目的素材字节落在项目 `library` 下（保存到资产库 = 从原项目**复制**一份进来，
 *     原项目删了也不会把库里条目带坏）；
 *   - 元数据复用同目录同名侧车（`<文件>.json`），索引只存「可编辑的展示信息」；
 *   - 索引落 `$DSH_HOME/storages/dsh-aifisher-canvas/library.json`（与 media/ 同级），原子写；
 *   - 本地 SKILL 预设自带素材落在项目 `workflow-preset-<id>` 下：保存预设时把节点引用的
 *     本站素材**快照**进去，导入时再复制进目标项目并改写节点字段 —— 这样预设是自包含的，
 *     原项目被删/改名都不影响它（上游 `createWorkflowNodeAssetSnapshot` 的同一套思路）。
 *
 * 也就是说：「库里的条目就是本机素材」——没有云端账号校验，`ownership` 只是一个可编辑标签。
 *
 * 路径安全：任何来自请求体的项目 id / 条目标识都先校验（拒绝 `..`、绝对路径、盘符、控制字符），
 * 且文件名一律由 `mediaStore` 生成（带随机后缀），路由层不自己拼路径。
 *
 * 同源围栏：本函数**假定调用方已经过** `restRouter` 的 `rejectCrossOrigin`
 * （画布后端只有 `handleCanvasApi` 一个入口），自己不再重复判一遍。
 * 请求体上限 64MB —— 保存到资产库的常见形态是「本站素材 URL」，data URL 只用于画布编辑产物；
 * 大视频走 URL 分支（直接 copyFile，不经过内存）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { readJsonBody, sendJson } from '../http/httpUtil';
import { resolveDataDir } from './dataDir';
import {
  assertExtensionForType,
  mediaKindOf,
  MediaError,
  parseDataUrl,
  type MediaRecord,
  type MediaStore,
  type MediaType,
  type SaveMediaResult,
} from './mediaStore';

/** 资产库条目的素材副本所在项目（保留名，别拿它当普通项目用）。 */
const LIBRARY_PROJECT = 'library';
/** 本地 SKILL 预设自带素材的项目前缀。 */
const PRESET_PROJECT_PREFIX = 'workflow-preset-';

/** 条目标识：只允许 URL 安全字符（它是索引键，不是路径，但仍然收窄）。 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** 侧车元数据里允许原样带走/回给前端的字段（其余不外传，避免污染 mediaStore 记录）。 */
const META_TEXT_FIELDS = [
  'title',
  'prompt',
  'model',
  'imageModel',
  'videoModel',
  'audioModel',
  'textModel',
  'imageMode',
  'videoMode',
  'audioMode',
  'aspectRatio',
  'resultAspectRatio',
  'resolution',
  'nodeType',
  'sourceType',
] as const;
const META_NUMBER_FIELDS = ['duration', 'width', 'height'] as const;

export interface LibraryDeps {
  mediaStore: MediaStore;
  /** 索引文件路径；缺省 = `<mediaStore.rootDir 的同级>/library.json` */
  libraryFile?: string;
}

/** 路由层的失败（带上给前端的状态码与 code）。 */
export class LibraryError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, status = 400, code = 'INVALID_LIBRARY') {
    super(message);
    this.name = 'LibraryError';
    this.status = status;
    this.code = code;
  }
}

/** 资产库索引里的一条资产（展示/编辑信息；素材本体与其余元数据都在 mediaStore 里）。 */
export interface LibraryAssetRecord {
  id: string;
  name: string;
  category: string;
  ownership: string;
  /** 素材副本所在项目（固定 LIBRARY_PROJECT） */
  projectId: string;
  type: MediaType;
  filename: string;
  createdAt: string;
}

/** 一条本地 SKILL 预设（节点整份存进索引，与 canvas.json 存整份文档同一套路子）。 */
export interface WorkflowPresetRecord {
  id: string;
  name: string;
  category: string;
  projectId: string;
  coverFilename: string | null;
  nodes: unknown[];
  createdAt: string;
}

interface LibraryIndexShape {
  version: 1;
  assets: Record<string, LibraryAssetRecord>;
  workflows: Record<string, WorkflowPresetRecord>;
}

/** 索引文件缺省位置：与 media/ 同级（都在插件自己的数据目录下；v1.43 起该目录可自定义）。 */
export function defaultLibraryPath(mediaRootDir?: string): string {
  if (mediaRootDir) return join(dirname(resolve(mediaRootDir)), 'library.json');
  return join(resolveDataDir(), 'library.json');
}

function emptyIndex(): LibraryIndexShape {
  return { version: 1, assets: {}, workflows: {} };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toNumber(value: unknown): number | null {
  const parsed = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed)
    ? null
    : parsed;
}

/** 只挑白名单字段：既防止请求体往侧车里塞 url/filename/projectId，也统一两处取值。 */
function pickMeta(source: unknown): Record<string, string | number> {
  if (!isPlainRecord(source)) return {};
  const picked: Record<string, string | number> = {};
  for (const key of META_TEXT_FIELDS) {
    const value = text(source[key]);
    if (value) picked[key] = value;
  }
  for (const key of META_NUMBER_FIELDS) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) picked[key] = value;
  }
  return picked;
}

/** `x.png` → `images`（用 mediaStore 自己的扩展名白名单判定，不另抄一份）。 */
function mediaTypeForFilename(filename: string): MediaType | null {
  for (const type of ['images', 'videos', 'audios'] as const) {
    try {
      assertExtensionForType(filename, type);
      return type;
    } catch {
      /* 试下一种类型 */
    }
  }
  return null;
}

/** mime → 扩展名（照上游 getExtensionFromMimeType，缺省 .png）。 */
function extensionForMime(mimeType: string): string {
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/png') return '.png';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return '.mp3';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return '.wav';
  if (mime === 'audio/x-m4a' || mime === 'audio/m4a' || mime === 'audio/mp4') return '.m4a';
  if (mime === 'audio/ogg') return '.ogg';
  return '.png';
}

/** 用户给的名字 + 扩展名 → 一个合法的落盘文件名（mediaStore 还会再加随机后缀）。 */
function namedFile(name: string, extension: string): string {
  const base = basename(name).replace(/\.[^.]+$/, '') || 'asset';
  return `${base}${extension}`;
}

// ---------------------------------------------------------------- 索引

export function createLibraryStore(options: { filePath?: string } = {}) {
  const filePath = options.filePath ?? defaultLibraryPath();
  let data: LibraryIndexShape = load();
  /** 写操作串行化（与 canvas/store.ts 同一套：临时文件 + rename 原子替换）。 */
  let writing: Promise<void> = Promise.resolve();

  function load(): LibraryIndexShape {
    try {
      if (!existsSync(filePath)) return emptyIndex();
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<LibraryIndexShape>;
      return {
        version: 1,
        assets: isPlainRecord(parsed.assets) ? (parsed.assets as LibraryIndexShape['assets']) : {},
        workflows: isPlainRecord(parsed.workflows)
          ? (parsed.workflows as LibraryIndexShape['workflows'])
          : {},
      };
    } catch (error) {
      // 坏档不能让资产库整体不可用：另存一份坏档再开空库（canvas/store.ts 同款处理）
      try {
        if (existsSync(filePath)) renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败就忽略 */
      }
      console.error('[aifisher-canvas] 资产库索引读取失败，已重置为空库', error);
      return emptyIndex();
    }
  }

  function persist(): Promise<void> {
    writing = writing.then(async () => {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, filePath);
    });
    return writing;
  }

  return {
    filePath,

    stats(): Record<string, unknown> {
      return {
        path: filePath,
        assets: Object.keys(data.assets).length,
        workflows: Object.keys(data.workflows).length,
      };
    },

    listAssets(): LibraryAssetRecord[] {
      return Object.values(data.assets).sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
    },

    getAsset(id: string): LibraryAssetRecord | null {
      return data.assets[id] ?? null;
    },

    async addAsset(record: LibraryAssetRecord): Promise<LibraryAssetRecord> {
      data.assets[record.id] = record;
      await persist();
      return record;
    },

    /** 只改展示信息：素材路径与 id 保持不动（画布上的既有引用不会失效）。 */
    async updateAsset(
      id: string,
      fields: { name: string; category: string; ownership: string },
    ): Promise<LibraryAssetRecord | null> {
      const existing = data.assets[id];
      if (!existing) return null;
      data.assets[id] = { ...existing, ...fields };
      await persist();
      return data.assets[id];
    },

    async removeAsset(id: string): Promise<LibraryAssetRecord | null> {
      const existing = data.assets[id];
      if (!existing) return null;
      delete data.assets[id];
      await persist();
      return existing;
    },

    listWorkflows(): WorkflowPresetRecord[] {
      return Object.values(data.workflows).sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
    },

    getWorkflow(id: string): WorkflowPresetRecord | null {
      return data.workflows[id] ?? null;
    },

    async addWorkflow(record: WorkflowPresetRecord): Promise<WorkflowPresetRecord> {
      data.workflows[record.id] = record;
      await persist();
      return record;
    },

    async removeWorkflow(id: string): Promise<WorkflowPresetRecord | null> {
      const existing = data.workflows[id];
      if (!existing) return null;
      delete data.workflows[id];
      await persist();
      return existing;
    },
  };
}

export type LibraryStore = ReturnType<typeof createLibraryStore>;

/**
 * 索引按文件路径缓存：路由每次请求都拿同一个 store，
 * 写队列与内存副本才不会被重建（重建会读到旧盘内容）。
 */
const libraryStores = new Map<string, LibraryStore>();

function libraryStoreFor(deps: LibraryDeps): LibraryStore {
  const filePath = deps.libraryFile ?? defaultLibraryPath(deps.mediaStore.rootDir);
  let store = libraryStores.get(filePath);
  if (!store) {
    store = createLibraryStore({ filePath });
    libraryStores.set(filePath, store);
  }
  return store;
}

// ---------------------------------------------------------------- 出参形状（照前端真实消费）

/** 列表项：`CanvasLibraryGrid` 用 id/name/category/ownership/type/url，agent 的 assets 用 name/title/category/type。 */
function assetListItem(
  entry: LibraryAssetRecord,
  mediaStore: MediaStore,
): Record<string, unknown> | null {
  const resolved = mediaStore.resolveFile(entry.projectId, entry.type, entry.filename);
  if (!resolved) return null;
  const record = resolved.record ?? ({} as MediaRecord);
  const field = (key: string): string => (typeof record[key] === 'string' ? String(record[key]) : '');
  return {
    id: entry.id,
    name: entry.name,
    // title 取索引里的名字而不是侧车里的快照名：PATCH 改名后两边不能各说各话
    title: entry.name,
    category: entry.category,
    ownership: entry.ownership,
    url: mediaStore.urlFor(entry.projectId, entry.type, entry.filename),
    // 单数：画布网格按 'video'/'audio' 选播放器，agent 的 assets 也只认单数
    type: mediaKindOf(entry.type) ?? 'image',
    nodeType: record.nodeType ?? null,
    sourceType: record.sourceType ?? null,
    prompt: field('prompt'),
    model: field('model'),
    imageModel: field('imageModel'),
    videoModel: field('videoModel'),
    audioModel: field('audioModel'),
    textModel: field('textModel'),
    imageMode: field('imageMode'),
    videoMode: field('videoMode'),
    audioMode: field('audioMode'),
    aspectRatio: field('aspectRatio'),
    resultAspectRatio: field('resultAspectRatio'),
    resolution: field('resolution'),
    duration: toNumber(record.duration),
    width: toNumber(record.width),
    height: toNumber(record.height),
    createdAt: entry.createdAt,
  };
}

function assetListItems(store: LibraryStore, mediaStore: MediaStore): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const entry of store.listAssets()) {
    const item = assetListItem(entry, mediaStore);
    // 素材文件被手工删掉的死条目不出现在列表里（DELETE 仍可清掉它）
    if (item) items.push(item);
  }
  return items;
}

/**
 * `/library/import` 的入参：`assetNode()`（vendor/canvasAssetInsertion.ts）认
 * `type` = images/videos/audios（复数）、`url`、`nodeType`、`prompt/model/...`。
 */
function importedAssetEntry(
  record: SaveMediaResult,
  entry: LibraryAssetRecord,
  source: MediaRecord | null,
): Record<string, unknown> {
  const field = (key: string): string => (typeof source?.[key] === 'string' ? String(source[key]) : '');
  return {
    id: record.id,
    url: record.url,
    name: entry.name,
    // title 用索引里的名字（PATCH 改名后画布上新插入的节点标题跟着走）
    title: entry.name,
    prompt: field('prompt') || entry.name,
    type: record.type,
    mediaType: mediaKindOf(record.type) ?? 'image',
    nodeType: source?.nodeType ?? null,
    sourceType: source?.sourceType ?? null,
    model: field('model'),
    imageModel: field('imageModel'),
    videoModel: field('videoModel'),
    audioModel: field('audioModel'),
    textModel: field('textModel'),
    imageMode: field('imageMode'),
    videoMode: field('videoMode'),
    audioMode: field('audioMode'),
    aspectRatio: field('aspectRatio'),
    resultAspectRatio: field('resultAspectRatio'),
    resolution: field('resolution'),
    duration: toNumber(source?.duration),
    width: toNumber(source?.width),
    height: toNumber(source?.height),
    bytes: record.bytes,
    createdAt: record.createdAt,
  };
}

/** 预设列表项：`CanvasLibraryGrid`（workflow 模式）用 name/category/coverUrl。 */
function workflowListItem(
  preset: WorkflowPresetRecord,
  mediaStore: MediaStore,
): Record<string, unknown> {
  const cover =
    preset.coverFilename &&
    mediaStore.resolveFile(preset.projectId, 'images', preset.coverFilename);
  return {
    id: preset.id,
    name: preset.name,
    title: preset.name,
    category: preset.category,
    coverUrl: cover ? mediaStore.urlFor(preset.projectId, 'images', preset.coverFilename!) : '',
    nodeCount: preset.nodes.length,
    createdAt: preset.createdAt,
  };
}

// ---------------------------------------------------------------- 入参校验

/** 一段安全的目录名（项目 id / 条目标识）：拒绝空、`..`、分隔符、控制字符、盘符。 */
function safeSegment(value: unknown, label: string, max = 128): string {
  const trimmed = text(value);
  if (!trimmed || trimmed.length > max || trimmed === '.' || trimmed === '..') {
    throw new LibraryError(`${label}无效。`, 400, 'INVALID_LIBRARY_SEGMENT');
  }
  if (/[\\/\u0000-\u001f]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw new LibraryError(`${label}含非法字符。`, 400, 'INVALID_LIBRARY_SEGMENT');
  }
  return trimmed;
}

function libraryId(value: unknown): string {
  const id = text(value);
  if (!ID_PATTERN.test(id)) throw new LibraryError('条目 id 无效。', 400, 'INVALID_LIBRARY_ID');
  return id;
}

/** 项目 id：前端/agent 都会给，落盘前先归一化（缺省 default，与上游一致）。 */
function projectIdOf(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'default';
  return safeSegment(value, '项目 id');
}

function newLibraryId(): string {
  return `lib-${randomUUID()}`;
}

function newWorkflowId(): string {
  return `wf-${randomUUID()}`;
}

// ---------------------------------------------------------------- 节点素材快照 / 导入改写

interface AssetCandidate {
  record: Record<string, unknown> | unknown[];
  field: string | number;
  value: string;
}

/** 往节点树上写回新地址（`field` 可能是数组下标）。 */
function setAssetField(candidate: AssetCandidate, value: string): void {
  (candidate.record as Record<string | number, string>)[candidate.field] = value;
}

/**
 * 摘出节点树上所有「可能是素材引用」的字符串字段（照上游 collectNodeAssetCandidates）。
 *
 * 与上游的唯一差别：`assetId` 只在它本身看起来是 URL / data URL 时才当作素材引用。
 * 上游还会拿 `assetId` 去拼 `<项目>/<类型>/<assetId>.json` 侧车反查文件名，那是它「assetId =
 * 无扩展名 uuid」的约定；本插件的侧车是 `<文件全名>.json`、`record.id` 就是带扩展名的文件名，
 * 那套反查在这里不成立（画布节点上的素材引用始终伴随 resultUrl/url，不会只留 assetId）。
 */
function collectNodeAssetCandidates(root: Record<string, unknown> | unknown[]): AssetCandidate[] {
  const candidates: AssetCandidate[] = [];
  const pending: { record: unknown; owner: unknown; parameters: boolean }[] = [
    { record: root, owner: Array.isArray(root) ? undefined : root.projectId, parameters: false },
  ];
  const add = (
    record: Record<string, unknown> | unknown[],
    field: string | number,
    value?: unknown,
  ): void => {
    const resolved =
      value === undefined ? (record as Record<string | number, unknown>)[field] : value;
    if (typeof resolved === 'string' && resolved.trim()) {
      candidates.push({ record, field, value: resolved });
    }
  };
  while (pending.length) {
    const { record, owner, parameters } = pending.pop()!;
    if (!record || typeof record !== 'object') continue;
    if (Array.isArray(record)) {
      for (const item of record) pending.push({ record: item, owner, parameters });
      continue;
    }
    const node = record as Record<string, unknown>;
    const projectId = node.projectId ?? owner;
    // parameterValues 是「结构化输入引用」，只在它自己没有 assetId 时继续下钻
    if (parameters && !node.assetId) {
      for (const item of Object.values(node)) {
        pending.push({ record: item, owner: projectId, parameters: true });
      }
      continue;
    }
    for (const field of [
      'resultUrl',
      'url',
      'inputUrl',
      'lastFrame',
      'editorBackgroundUrl',
      'editorCanvasData',
      'coverUrl',
    ]) {
      add(node, field);
    }
    for (const field of ['resultUrls', 'urls', 'characterReferenceUrls']) {
      if (Array.isArray(node[field])) {
        node[field].forEach((value: unknown, index: number) =>
          add(node[field] as unknown[], index, value),
        );
      }
    }
    if (typeof node.assetId === 'string' && /^(data:|https?:\/\/|\/)/i.test(node.assetId)) {
      add(node, 'assetId');
    }
    for (const field of ['result', 'resultHistory', 'workflowOutputs', 'outputs']) {
      pending.push({ record: node[field], owner: projectId, parameters: false });
    }
    pending.push({ record: node.parameterValues, owner: projectId, parameters: true });
  }
  return candidates;
}

/**
 * 把节点树里每个素材引用交给 `resolve` 换一份新地址（同一份素材只处理一次）。
 * `resolve` 返回 null 表示「这个引用不动」（外链、空值、本插件不认的地址）。
 */
async function mapNodeAssets(
  nodes: unknown[],
  resolve: (value: string) => Promise<string | null>,
): Promise<unknown[]> {
  const clone = JSON.parse(JSON.stringify(nodes)) as unknown[];
  const replaced = new Map<string, string>();
  for (const node of clone) {
    if (!isPlainRecord(node)) continue;
    for (const candidate of collectNodeAssetCandidates(node)) {
      const cached = replaced.get(candidate.value);
      if (cached) {
        setAssetField(candidate, cached);
        continue;
      }
      const next = await resolve(candidate.value);
      if (!next) continue;
      replaced.set(candidate.value, next);
      setAssetField(candidate, next);
    }
  }
  return clone;
}

// ---------------------------------------------------------------- 处理函数

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof LibraryError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof MediaError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  sendJson(res, 500, {
    error: error instanceof Error ? error.message : '资产库处理失败。',
    code: 'LIBRARY_FAILED',
  });
}

/** 外链素材：拉一次字节（不跟随跳转，与 /proxy 同一策略）。 */
async function fetchRemoteBytes(rawUrl: string): Promise<{ bytes: Buffer; contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new LibraryError('外链素材地址无效。', 422, 'INVALID_LIBRARY_SOURCE_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LibraryError('只支持 http/https 外链。', 422, 'INVALID_LIBRARY_SOURCE_URL');
  }
  let response: Response;
  try {
    response = await fetch(parsed.href, {
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new LibraryError(
      `外链素材取数失败：${error instanceof Error ? error.message : String(error)}`,
      502,
      'LIBRARY_SOURCE_FETCH_FAILED',
    );
  }
  if (!response.ok) {
    throw new LibraryError(`外链素材取数失败（${response.status}）。`, 502, 'LIBRARY_SOURCE_FETCH_FAILED');
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? '',
  };
}

/**
 * 「保存到资产库」的源解析：data URL / 本站素材 URL / http(s) 外链，
 * 统一复制进 `library` 项目，返回新素材记录。
 */
async function copySourceIntoLibrary(
  mediaStore: MediaStore,
  sourceUrl: string,
  name: string,
  meta: Record<string, string | number>,
): Promise<SaveMediaResult> {
  if (sourceUrl.startsWith('data:')) {
    const { contentType } = parseDataUrl(sourceUrl);
    const extension = extensionForMime(contentType);
    const type = mediaTypeForFilename(`asset${extension}`) ?? 'images';
    return mediaStore.saveDataUrl(sourceUrl, {
      projectId: LIBRARY_PROJECT,
      type,
      filename: namedFile(name, extension),
      source: 'import',
      extra: meta,
    });
  }
  const local = mediaStore.localPathForUrl(sourceUrl);
  if (local) {
    // 原素材的侧车（分辨率/时长/模型名…）一并带进库里，导入画布时这些字段要用
    const source = mediaStore.resolveFile(local.projectId, local.type, local.filename)?.record ?? null;
    return mediaStore.copyFrom({
      sourcePath: local.path,
      projectId: LIBRARY_PROJECT,
      type: local.type,
      filename: local.filename,
      source: 'import',
      extra: { ...pickMeta(source), ...meta },
    });
  }
  if (/^https?:\/\//i.test(sourceUrl)) {
    const remote = await fetchRemoteBytes(sourceUrl);
    let filename = '';
    try {
      filename = decodeURIComponent(basename(new URL(sourceUrl).pathname));
    } catch {
      filename = '';
    }
    if (!extname(filename)) filename = namedFile(name, extensionForMime(remote.contentType));
    const type = mediaTypeForFilename(filename) ?? 'images';
    return mediaStore.save({
      projectId: LIBRARY_PROJECT,
      type,
      bytes: remote.bytes,
      filename,
      source: 'import',
      extra: meta,
    });
  }
  throw new LibraryError(
    '源素材不存在（只支持本站素材 URL、data URL 或 http(s) 外链）。',
    404,
    'LIBRARY_SOURCE_MISSING',
  );
}

/** POST /library —— 把一份素材存进资产库。 */
async function saveToLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LibraryDeps,
  store: LibraryStore,
): Promise<void> {
  const body = (await readJsonBody(req, 64 * 1024 * 1024)) as Record<string, unknown> | null;
  if (!isPlainRecord(body)) {
    throw new LibraryError('保存到资产库的数据无效。', 422, 'INVALID_LIBRARY_BODY');
  }
  const name = text(body.name);
  const category = text(body.category);
  const ownership = text(body.ownership);
  const sourceUrl = text(body.sourceUrl);
  // 长度上限照上游（name 200 / category 80 / ownership 120）
  if (!name || name.length > 200 || !category || category.length > 80 || ownership.length > 120) {
    throw new LibraryError('名称、分类或归属格式不正确。', 400, 'INVALID_LIBRARY_FIELDS');
  }
  if (!sourceUrl) {
    throw new LibraryError('sourceUrl 必填。', 422, 'INVALID_LIBRARY_BODY');
  }
  const record = await copySourceIntoLibrary(deps.mediaStore, sourceUrl, name, pickMeta(body.meta));
  const entry: LibraryAssetRecord = {
    id: newLibraryId(),
    name,
    category,
    ownership,
    projectId: LIBRARY_PROJECT,
    type: record.type,
    filename: record.filename,
    createdAt: new Date().toISOString(),
  };
  await store.addAsset(entry);
  const item = assetListItem(entry, deps.mediaStore);
  if (!item) {
    throw new LibraryError('素材已落盘但读不回来，请刷新资产库。', 500, 'LIBRARY_SAVE_VERIFY_FAILED');
  }
  sendJson(res, 200, { success: true, asset: item });
}

/** PATCH /library/:id —— 只改展示信息（AssetFields = {name, category, ownership}）。 */
async function editLibraryAsset(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LibraryDeps,
  store: LibraryStore,
  rawId: string,
): Promise<void> {
  const id = libraryId(rawId);
  const body = (await readJsonBody(req, 64 * 1024)) as Record<string, unknown> | null;
  const keys = isPlainRecord(body) ? Object.keys(body) : [];
  const name = isPlainRecord(body) ? text(body.name) : '';
  const category = isPlainRecord(body) ? text(body.category) : '';
  const ownership = isPlainRecord(body) ? text(body.ownership) : '';
  if (
    !isPlainRecord(body) ||
    keys.some((key) => !['name', 'category', 'ownership'].includes(key)) ||
    typeof body.name !== 'string' ||
    !name ||
    name.length > 200 ||
    typeof body.category !== 'string' ||
    !category ||
    category.length > 80 ||
    typeof body.ownership !== 'string' ||
    ownership.length > 120
  ) {
    throw new LibraryError('名称、分类或归属格式不正确。', 400, 'INVALID_LIBRARY_FIELDS');
  }
  const updated = await store.updateAsset(id, { name, category, ownership });
  if (!updated) throw new LibraryError('资产不存在。', 404, 'LIBRARY_ASSET_NOT_FOUND');
  const item = assetListItem(updated, deps.mediaStore);
  if (!item) throw new LibraryError('资产文件缺失，请刷新资产库。', 404, 'LIBRARY_FILE_MISSING');
  sendJson(res, 200, { success: true, asset: item });
}

/** DELETE /library/:id —— 摘掉索引条目，并把库里那份副本移进回收站。 */
async function deleteLibraryAsset(
  res: ServerResponse,
  deps: LibraryDeps,
  store: LibraryStore,
  rawId: string,
): Promise<void> {
  const id = libraryId(rawId);
  const removed = await store.removeAsset(id);
  if (!removed) throw new LibraryError('资产不存在。', 404, 'LIBRARY_ASSET_NOT_FOUND');
  // 副本只被这一条引用，顺手清掉（trash 语义，不真删）
  await deps.mediaStore
    .trash({ projectId: removed.projectId, type: removed.type, id: removed.filename })
    .catch(() => false);
  sendJson(res, 200, { success: true });
}

/** POST /library/import —— 把库里的素材复制进某个项目，返回可直接建节点的素材描述。 */
async function importLibraryAsset(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LibraryDeps,
  store: LibraryStore,
): Promise<void> {
  const body = (await readJsonBody(req, 64 * 1024)) as Record<string, unknown> | null;
  if (!isPlainRecord(body)) {
    throw new LibraryError('导入参数无效。', 422, 'INVALID_LIBRARY_BODY');
  }
  const id = libraryId(body.id);
  const projectId = projectIdOf(body.projectId);
  const entry = store.getAsset(id);
  if (!entry) throw new LibraryError('资产不存在。', 404, 'LIBRARY_ASSET_NOT_FOUND');
  const resolved = deps.mediaStore.resolveFile(entry.projectId, entry.type, entry.filename);
  if (!resolved) {
    throw new LibraryError('资产文件缺失，请重新保存到资产库。', 404, 'LIBRARY_FILE_MISSING');
  }
  const record = await deps.mediaStore.copyFrom({
    sourcePath: resolved.path,
    projectId,
    type: entry.type,
    filename: entry.filename,
    source: 'import',
  });
  sendJson(res, 200, {
    success: true,
    asset: importedAssetEntry(record, entry, resolved.record),
  });
}

/** 名称规范化（照上游 stripWorkflowPresetMediaExtension：去掉扩展名与尾部「工作流」）。 */
function stripPresetName(value: string): string {
  return value
    .trim()
    .replace(
      /\.(png|jpe?g|webp|gif|bmp|mp4|mov|webm|m4v|mkv|mp3|wav|m4a|ogg|aac|flac)(?=工作流?$|$)/i,
      '',
    )
    .replace(/工作流$/u, '')
    .trim();
}

/** 分类名：上游把它当目录名用，所以这里也做一次文件名规范化（本插件只当展示标签）。 */
function sanitizePresetCategory(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
}

function isWorkflowNode(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.type === 'string' &&
    value.type.length > 0 &&
    Number.isFinite(Number(value.x)) &&
    Number.isFinite(Number(value.y))
  );
}

/** POST /library/workflows —— 把当前节点组合存成本地 SKILL 预设（素材快照进预设自己的项目）。 */
async function createWorkflowPreset(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LibraryDeps,
  store: LibraryStore,
): Promise<void> {
  const body = (await readJsonBody(req, 64 * 1024 * 1024)) as Record<string, unknown> | null;
  if (!isPlainRecord(body)) {
    throw new LibraryError('预设数据无效。', 422, 'INVALID_WORKFLOW_PRESET');
  }
  const name = stripPresetName(text(body.name));
  const category = sanitizePresetCategory(text(body.category));
  const nodes = body.nodes;
  if (
    !name ||
    name.length > 200 ||
    !category ||
    category.length > 80 ||
    !Array.isArray(nodes) ||
    nodes.length < 1
  ) {
    throw new LibraryError('名称、分类与至少一个节点是必填的。', 400, 'INVALID_WORKFLOW_PRESET');
  }
  nodes.forEach((node, index) => {
    if (!isWorkflowNode(node)) {
      throw new LibraryError(`第 ${index + 1} 个节点数据无效。`, 400, 'INVALID_WORKFLOW_PRESET');
    }
  });

  const id = newWorkflowId();
  const projectId = `${PRESET_PROJECT_PREFIX}${id}`;
  const mediaStore = deps.mediaStore;
  try {
    const snapshot = await mapNodeAssets(nodes, async (value) => {
      if (value.startsWith('data:')) {
        const { contentType } = parseDataUrl(value);
        const extension = extensionForMime(contentType);
        const type = mediaTypeForFilename(`preset${extension}`) ?? 'images';
        const saved = await mediaStore.saveDataUrl(value, {
          projectId,
          type,
          filename: namedFile('preset', extension),
          source: 'import',
        });
        return saved.url;
      }
      const local = mediaStore.localPathForUrl(value);
      if (!local) return null;
      const copied = await mediaStore.copyFrom({
        sourcePath: local.path,
        projectId,
        type: local.type,
        filename: local.filename,
        source: 'import',
      });
      return copied.url;
    });

    let coverFilename: string | null = null;
    const coverDataUrl = text(body.coverDataUrl);
    if (coverDataUrl.startsWith('data:')) {
      const cover = await mediaStore.saveDataUrl(coverDataUrl, {
        projectId,
        type: 'images',
        filename: 'cover.png',
        source: 'import',
      });
      coverFilename = cover.filename;
    }

    const preset = await store.addWorkflow({
      id,
      name,
      category,
      projectId,
      coverFilename,
      nodes: snapshot,
      createdAt: new Date().toISOString(),
    });
    sendJson(res, 200, { success: true, workflow: workflowListItem(preset, mediaStore) });
  } catch (error) {
    // 半成品素材不能留在盘上：整个预设项目进回收站，索引没有条目就不会再被引用
    await mediaStore.trashProject(projectId).catch(() => false);
    throw error;
  }
}

/** POST /library/workflows/import —— 把预设里的素材复制进目标项目，并改写节点引用。 */
async function importWorkflowPreset(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LibraryDeps,
  store: LibraryStore,
): Promise<void> {
  const body = (await readJsonBody(req, 64 * 1024)) as Record<string, unknown> | null;
  if (!isPlainRecord(body)) {
    throw new LibraryError('导入参数无效。', 422, 'INVALID_LIBRARY_BODY');
  }
  const id = libraryId(body.id);
  const projectId = projectIdOf(body.projectId);
  const preset = store.getWorkflow(id);
  if (!preset) throw new LibraryError('本地 SKILL 不存在。', 404, 'WORKFLOW_PRESET_NOT_FOUND');
  const mediaStore = deps.mediaStore;
  const nodes = await mapNodeAssets(preset.nodes, async (value) => {
    const local = mediaStore.localPathForUrl(value);
    if (!local) return null;
    const copied = await mediaStore.copyFrom({
      sourcePath: local.path,
      projectId,
      type: local.type,
      filename: local.filename,
      source: 'import',
    });
    return copied.url;
  });
  sendJson(res, 200, {
    success: true,
    workflow: { name: preset.name, category: preset.category, nodes },
  });
}

/** DELETE /library/workflows/:id —— 删索引条目 + 预设自带的素材整体进回收站。 */
async function deleteWorkflowPreset(
  res: ServerResponse,
  deps: LibraryDeps,
  store: LibraryStore,
  rawId: string,
): Promise<void> {
  const id = libraryId(rawId);
  const removed = await store.removeWorkflow(id);
  if (!removed) throw new LibraryError('本地 SKILL 不存在。', 404, 'WORKFLOW_PRESET_NOT_FOUND');
  await deps.mediaStore.trashProject(removed.projectId).catch(() => false);
  sendJson(res, 200, { success: true });
}

/**
 * 处理 `/api/aifisher/canvas/library*`。
 * 已处理返回 true；未匹配返回 false（交回 restRouter 走 NOT_PORTED）。
 */
export async function handleLibraryApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: LibraryDeps;
}): Promise<boolean> {
  const { req, res, parts, deps } = input;
  if (parts[0] !== 'library') return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const store = libraryStoreFor(deps);

  try {
    // ---- GET/POST /library ----
    if (parts.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, assetListItems(store, deps.mediaStore));
        return true;
      }
      if (method === 'POST') {
        await saveToLibrary(req, res, deps, store);
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }

    // ---- POST /library/import ----
    if (parts.length === 2 && parts[1] === 'import') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      await importLibraryAsset(req, res, deps, store);
      return true;
    }

    // ---- /library/workflows ----
    if (parts[1] === 'workflows') {
      if (parts.length === 2) {
        if (method === 'GET') {
          sendJson(
            res,
            200,
            store.listWorkflows().map((preset) => workflowListItem(preset, deps.mediaStore)),
          );
          return true;
        }
        if (method === 'POST') {
          await createWorkflowPreset(req, res, deps, store);
          return true;
        }
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      if (parts.length === 3 && parts[2] === 'import') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return true;
        }
        await importWorkflowPreset(req, res, deps, store);
        return true;
      }
      if (parts.length === 3 && method === 'DELETE') {
        await deleteWorkflowPreset(res, deps, store, parts[2]);
        return true;
      }
      return false;
    }

    // ---- PATCH/DELETE /library/:id ----
    if (parts.length === 2) {
      if (method === 'PATCH') {
        await editLibraryAsset(req, res, deps, store, parts[1]);
        return true;
      }
      if (method === 'DELETE') {
        await deleteLibraryAsset(res, deps, store, parts[1]);
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }

    return false;
  } catch (error) {
    fail(res, error);
    return true;
  }
}
