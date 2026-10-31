/**
 * 项目库（host 半，v1.84）。
 *
 * 用户 2026-10-30 原话：「无限画布ui设计要包含设置页、图像编辑页、扩图页的等。还有项目管理页」。
 * 四屏里「项目库」需要一个**比 `/workflows` 列表更厚**的数据面，这个文件就是它：
 *
 *   GET    /projects                       项目库首屏（卡片墙 / 列表都要的那一份）
 *   GET    /projects/<id>                  单个项目详情（右侧详情栏：最近生成 / 模型 / 备注）
 *   POST   /projects                       新建空项目 → { id, title }
 *   POST   /projects/<id>/status           {status:'active'|'archived'}  归档 / 取消归档
 *   POST   /projects/<id>/favorite         {favorite:boolean}            收藏
 *   POST   /projects/<id>/note             {note}                       项目备注
 *   POST   /projects/<id>/duplicate        复制项目（文档 + 素材一起复制）
 *   DELETE /projects/<id>                  删除（文档 + 素材进回收站）
 *
 * 为什么不在 `/workflows` 上直接加字段：
 *   - `/workflows` 是 vendor 的列表契约（dashboard 用它），形状不能动；
 *   - 这份列表每一项都要 stat 素材目录、扫节点、读最近生成，比 `/workflows` 贵一个量级，
 *     不该让 vendor 的每次列表都付这个代价。
 *
 * 口径（都来自真实文件，不用假数据）：
 *   - `mediaBytes` / `mediaFiles` = `<素材根>/<项目>/{images,videos,audios}` 里真实文件的大小；
 *   - `thumbUrl` = 最新一张图（没有图就退回文档里的 coverUrl）；
 *   - `recent[]` = 最近 4 张图，卡片墙「继续编辑」那一块和详情栏共用；
 *   - `models[]` = 素材 sidecar 里记过的模型名（去重，最近的在前）；
 *   - `running` = 生成日记里这个项目还在 loading 的任务数；
 *   - 画布尺寸 = 节点包围盒（拿不到尺寸的节点按 340×500 估，与节点卡默认一致）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJsonBody, sendJson } from '../http/httpUtil';
import type { CanvasStore } from './store';
import { MEDIA_URL_BASE, type MediaStore, type MediaType } from './mediaStore';
import type { GenerationJournal } from '../comfyui/generationJournal';

export interface ProjectsDeps {
  store: CanvasStore;
  mediaStore: MediaStore;
  /** 画布数据目录（统计 canvas.json / appearance 用）。 */
  dataDir: string;
  /** 生成日记（可选：缺省就没有「进行中任务」计数）。 */
  tasks?: GenerationJournal;
}

const MEDIA_TYPES: readonly MediaType[] = ['images', 'videos', 'audios'];
/** 单个项目最多扫这么多素材（防止一个病态项目把首屏拖死）。 */
const MAX_SCAN_FILES = 4000;
/** 节点包围盒缺省尺寸（与节点卡一致）。 */
const DEFAULT_NODE_SIZE = { width: 340, height: 500 };

export interface ProjectMediaFile {
  name: string;
  type: MediaType;
  bytes: number;
  mtimeMs: number;
  url: string;
}

export interface ProjectCard {
  id: string;
  title: string;
  folderId: string | null;
  status: 'active' | 'archived';
  favorite: boolean;
  note: string;
  nodeCount: number;
  groupCount: number;
  nodeTypes: Record<'image' | 'video' | 'audio' | 'text' | 'other', number>;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  mediaFiles: number;
  mediaBytes: number;
  documentBytes: number;
  createdAt: string;
  updatedAt: string;
  thumbUrl: string;
  recent: string[];
  models: string[];
  running: number;
  width: number;
  height: number;
}

interface MediaScan {
  files: ProjectMediaFile[];
  bytes: number;
  images: number;
  videos: number;
  audios: number;
}

function mediaUrlFor(projectId: string, type: MediaType, name: string): string {
  return `${MEDIA_URL_BASE}/${encodeURIComponent(projectId)}/${type}/${encodeURIComponent(name)}`;
}

/** 扫一个项目的素材目录：只读 dir + stat，不读文件内容。 */
function scanProjectMedia(rootDir: string, projectId: string): MediaScan {
  const result: MediaScan = { files: [], bytes: 0, images: 0, videos: 0, audios: 0 };
  const projectDir = join(rootDir, projectId);
  if (!existsSync(projectDir)) return result;
  for (const type of MEDIA_TYPES) {
    const dir = join(projectDir, type);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.') || name.endsWith('.json') || name.endsWith('.tmp')) continue;
      if (result.files.length >= MAX_SCAN_FILES) break;
      const path = join(dir, name);
      try {
        const info = statSync(path);
        if (!info.isFile()) continue;
        result.files.push({
          name,
          type,
          bytes: info.size,
          mtimeMs: info.mtimeMs,
          url: mediaUrlFor(projectId, type, name),
        });
        result.bytes += info.size;
        if (type === 'images') result.images += 1;
        else if (type === 'videos') result.videos += 1;
        else result.audios += 1;
      } catch {
        /* 单个文件读不到（被占用 / 刚删）就跳过，不让整个列表失败 */
      }
    }
  }
  result.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return result;
}

/** 素材 sidecar 里记过的模型（最近的在前，去重）。 */
async function modelsOf(rootDir: string, projectId: string, scan: MediaScan): Promise<string[]> {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const file of scan.files) {
    if (models.length >= 8) break;
    if (file.type !== 'images' && file.type !== 'videos') continue;
    try {
      const record = JSON.parse(
        await readFile(join(rootDir, projectId, file.type, `${file.name}.json`), 'utf8'),
      ) as { model?: unknown };
      const model = typeof record.model === 'string' ? record.model.trim() : '';
      if (!model || seen.has(model)) continue;
      seen.add(model);
      models.push(model);
    } catch {
      /* 没有 sidecar / 坏 JSON：这条素材不贡献模型名 */
    }
  }
  return models;
}

/** 节点类型计数 + 画布包围盒（视口尺寸也认，有的文档只存 viewport）。 */
function scanNodes(nodes: unknown[]): {
  nodeTypes: ProjectCard['nodeTypes'];
  width: number;
  height: number;
} {
  const nodeTypes: ProjectCard['nodeTypes'] = {
    image: 0,
    video: 0,
    audio: 0,
    text: 0,
    other: 0,
  };
  let maxX = 0;
  let maxY = 0;
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    const type = typeof node.type === 'string' ? node.type.toLowerCase() : '';
    if (type === 'image' || type === 'video' || type === 'audio' || type === 'text') {
      nodeTypes[type] += 1;
    } else {
      nodeTypes.other += 1;
    }
    const x = Number(node.x);
    const y = Number(node.y);
    const width = Number(node.width) || DEFAULT_NODE_SIZE.width;
    const height = Number(node.height) || DEFAULT_NODE_SIZE.height;
    if (Number.isFinite(x)) maxX = Math.max(maxX, x + width);
    if (Number.isFinite(y)) maxY = Math.max(maxY, y + height);
  }
  return {
    nodeTypes,
    width: Math.round(maxX) || 0,
    height: Math.round(maxY) || 0,
  };
}

/** 生成日记里这个项目还在跑的任务数（取不到就是 0）。 */
function runningCount(deps: ProjectsDeps, projectId: string): number {
  if (!deps.tasks) return 0;
  try {
    return deps.tasks
      .snapshot()
      .filter((task) => task.projectId === projectId && task.status === 'loading').length;
  } catch {
    return 0;
  }
}

function documentBytesOf(store: CanvasStore, projectId: string): number {
  const doc = store.getDocument(projectId);
  if (!doc) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(doc), 'utf8');
  } catch {
    return 0;
  }
}

async function buildCard(deps: ProjectsDeps, projectId: string): Promise<ProjectCard | null> {
  const doc = deps.store.getDocument(projectId);
  if (!doc) return null;
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const groups = Array.isArray(doc.groups) ? doc.groups : [];
  const scan = scanProjectMedia(deps.mediaStore.rootDir, projectId);
  const { nodeTypes, width, height } = scanNodes(nodes);
  const imageFiles = scan.files.filter((file) => file.type === 'images');
  const coverUrl = typeof doc.coverUrl === 'string' ? doc.coverUrl : '';
  return {
    id: projectId,
    title: typeof doc.title === 'string' && doc.title ? doc.title : '未命名项目',
    folderId: (doc.folderId as string | null | undefined) ?? null,
    status: doc.status === 'archived' ? 'archived' : 'active',
    favorite: doc.favorite === true,
    note: typeof doc.note === 'string' ? doc.note : '',
    nodeCount: nodes.length,
    groupCount: groups.length,
    nodeTypes,
    imageCount: nodeTypes.image,
    videoCount: nodeTypes.video,
    audioCount: nodeTypes.audio,
    mediaFiles: scan.files.length,
    mediaBytes: scan.bytes,
    documentBytes: documentBytesOf(deps.store, projectId),
    createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : '',
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '',
    thumbUrl: imageFiles[0]?.url ?? coverUrl,
    recent: imageFiles.slice(0, 4).map((file) => file.url),
    models: await modelsOf(deps.mediaStore.rootDir, projectId, scan),
    running: runningCount(deps, projectId),
    width,
    height,
  };
}

function totalBytesOf(dir: string, depth = 2): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (current: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (level > 0) walk(path, level - 1);
        continue;
      }
      try {
        total += statSync(path).size;
      } catch {
        /* 统计失败不影响别的 */
      }
    }
  };
  walk(dir, depth);
  return total;
}

/** 存储面板读数：素材总量 + 文档 + 外观/背景，按项目分类汇总。 */
function storageSummary(projects: ProjectCard[], deps: ProjectsDeps) {
  let documentBytes = 0;
  try {
    documentBytes = statSync(deps.store.filePath).size;
  } catch {
    documentBytes = 0;
  }
  const mediaBytes = projects.reduce((sum, item) => sum + item.mediaBytes, 0);
  const appearanceBytes = totalBytesOf(join(deps.dataDir, 'appearance'), 1);
  return {
    mediaBytes,
    documentBytes,
    appearanceBytes,
    totalBytes: mediaBytes + documentBytes + appearanceBytes,
    mediaFiles: projects.reduce((sum, item) => sum + item.mediaFiles, 0),
    projects: projects.length,
  };
}

async function listPayload(deps: ProjectsDeps) {
  const summaries = deps.store.listDocuments();
  const projects: ProjectCard[] = [];
  for (const summary of summaries) {
    const card = await buildCard(deps, summary.id);
    if (card) projects.push(card);
  }
  return {
    projects,
    folders: deps.store.listFolders(),
    storage: storageSummary(projects, deps),
    generatedAt: new Date().toISOString(),
  };
}

/** 详情：在卡片字段之外补「最近 12 张图」与分组数（详情栏/预览用）。 */
async function detailPayload(deps: ProjectsDeps, projectId: string) {
  const card = await buildCard(deps, projectId);
  if (!card) return null;
  const scan = scanProjectMedia(deps.mediaStore.rootDir, projectId);
  const images = scan.files.filter((file) => file.type === 'images');
  return {
    project: card,
    recentImages: images.slice(0, 12).map((file) => file.url),
    recentVideos: scan.files
      .filter((file) => file.type === 'videos')
      .slice(0, 4)
      .map((file) => file.url),
  };
}

async function duplicateProject(
  deps: ProjectsDeps,
  sourceId: string,
): Promise<{ id: string; title: string } | null> {
  const source = deps.store.getDocument(sourceId);
  if (!source) return null;
  const id = randomUUID();
  const title = `${typeof source.title === 'string' && source.title ? source.title : '未命名项目'} 副本`;

  // 素材**按原文件名**整目录复制（含 sidecar），再统一把文档里的项目 id 换成新 id。
  // 为什么不走 mediaStore.copyFrom：那个接口会重新生成随机文件名，节点的 resultUrl 就会
  // 指向源项目（复制件看起来能开，其实是在看别人的图），而且复制件删掉源项目就全黑。
  const sourceRef = `${MEDIA_URL_BASE}/${encodeURIComponent(sourceId)}/`;
  const targetRef = `${MEDIA_URL_BASE}/${encodeURIComponent(id)}/`;
  for (const type of MEDIA_TYPES) {
    const from = join(deps.mediaStore.rootDir, sourceId, type);
    const to = join(deps.mediaStore.rootDir, id, type);
    let names: string[] = [];
    try {
      names = readdirSync(from);
    } catch {
      continue;
    }
    let created = false;
    for (const name of names) {
      if (name.endsWith('.tmp')) continue;
      try {
        if (!created) {
          mkdirSync(to, { recursive: true });
          created = true;
        }
        copyFileSync(join(from, name), join(to, name));
        if (name.endsWith('.json')) continue;
        // sidecar 里的 projectId / url 也要指向新项目，否则详情栏的模型名对不上
        const sidecar = `${name}.json`;
        if (names.includes(sidecar)) {
          const raw = readFileSync(join(from, sidecar), 'utf8');
          writeFileSync(join(to, sidecar), raw.split(sourceRef).join(targetRef).split(sourceId).join(id), 'utf8');
        }
      } catch {
        /* 单个素材复制失败不拦整次复制 */
      }
    }
  }

  // 文档里的 resultUrl / projectId 一起换（把整份文档序列化后替换是最不容易漏的做法：
  // 节点、分组、viewport、素材引用都在同一个 JSON 里）。
  let cloned: Record<string, unknown> = { ...source };
  try {
    const serialized = JSON.stringify(source)
      .split(sourceRef)
      .join(targetRef)
      .split(`"${sourceId}"`)
      .join(`"${id}"`);
    cloned = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    /* 序列化失败就按原样复制（至少文档能打开） */
  }

  await deps.store.saveDocument({
    ...cloned,
    id,
    revision: 0,
    title,
    createdAt: undefined,
    updatedAt: undefined,
  });
  return { id, title };
}

/** 处理 `/projects*`；已处理返回 true（与其它 canvas 路由同一套签名）。 */
export async function handleProjectsApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: ProjectsDeps;
}): Promise<boolean> {
  const { req, res, parts, deps } = input;
  if (parts[0] !== 'projects') return false;
  const method = (req.method ?? 'GET').toUpperCase();

  if (parts.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, await listPayload(deps));
      return true;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req)) as { title?: unknown } | null;
      const title =
        typeof body?.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : '未命名项目';
      const saved = await deps.store.saveDocument({
        title,
        nodes: [],
        groups: [],
        revision: 0,
      });
      sendJson(res, 200, { id: saved.id, title });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const projectId = parts[1];

  if (parts.length === 2) {
    if (method === 'GET') {
      const detail = await detailPayload(deps, projectId);
      if (!detail) {
        sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, detail);
      return true;
    }
    if (method === 'DELETE') {
      const deleted = await deps.store.deleteDocument(projectId);
      if (!deleted) {
        sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
        return true;
      }
      const trashed = await deps.mediaStore.trashProject(projectId);
      sendJson(res, 200, { ok: true, id: projectId, mediaTrashed: trashed });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  if (parts.length === 3) {
    const action = parts[2];
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    if (action === 'status') {
      const body = (await readJsonBody(req)) as { status?: unknown } | null;
      const status = body?.status === 'archived' ? 'archived' : 'active';
      const updated = await deps.store.patchDocument(projectId, { status });
      if (!updated) {
        sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, { ok: true, status });
      return true;
    }
    if (action === 'favorite') {
      const body = (await readJsonBody(req)) as { favorite?: unknown } | null;
      const favorite = body?.favorite === true;
      const updated = await deps.store.patchDocument(projectId, { favorite });
      if (!updated) {
        sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, { ok: true, favorite });
      return true;
    }
    if (action === 'note') {
      const body = (await readJsonBody(req)) as { note?: unknown } | null;
      const note = typeof body?.note === 'string' ? body.note.slice(0, 2000) : '';
      const updated = await deps.store.patchDocument(projectId, { note });
      if (!updated) {
        sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, { ok: true, note });
      return true;
    }
    if (action === 'duplicate') {
      const created = await duplicateProject(deps, projectId);
      if (!created) {
        sendJson(res, 404, { error: '项目不存在。', code: 'NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, created);
      return true;
    }
  }

  sendJson(res, 404, { error: '未知的项目库接口。', code: 'NOT_FOUND', path: parts.join('/') });
  return true;
}

/** 诊断用：项目库接口的现状（`/status` 里报一份）。 */
export function projectsStatus(): Record<string, unknown> {
  return {
    endpoints: [
      'GET /projects',
      'GET /projects/<id>',
      'POST /projects',
      'POST /projects/<id>/status',
      'POST /projects/<id>/favorite',
      'POST /projects/<id>/note',
      'POST /projects/<id>/duplicate',
      'DELETE /projects/<id>',
    ],
    mediaRoot: MEDIA_URL_BASE,
  };
}
