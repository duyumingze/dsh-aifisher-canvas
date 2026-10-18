/**
 * 工作流配图（v1.28，host 半）
 *
 * 用户 2026-10-17 原话：「工作流节点里放置配置好的 comfui，可以自定义配图」。
 * 于是每个**配置好的 ComfyUI 工作流**除了名字/分类/参数，还可以有一张自己的封面图：
 * 左侧「工作流节点」面板里按图卡片陈列，点卡片把这份工作流直接放到画布上。
 *
 * 为什么配图**不**写进工作流的 meta 侧车（`<名字>.meta.json`）：
 *   ① meta 是用户手写/ComfyUI 目录里的可读配置，塞一段 base64 进去会把文件撑爆；
 *   ② 工作流目录 v1.18 起可以指到用户自己的目录（可能是 ComfyUI 的导出目录）——
 *      本插件在那里「只读不写」，多出图片文件属于污染；
 *   ③ 配图是**外观**，不是工作流能不能跑的一部分：放在画布数据目录里，
 *      换目录/删 JSON 都不会连带丢一张图；按工作流 id（`custom-<文件名 slug>`）索引，
 *      同一份工作流在换目录后 id 不变，配图自然跟过去。
 *
 * 落点：
 *   $DSH_HOME/storages/dsh-aifisher-canvas/workflow-covers.json   索引（id → 文件名/大小/时间）
 *   $DSH_HOME/storages/dsh-aifisher-canvas/workflow-covers/      图片本体（文件名 = id 的 sha1 + 后缀）
 *
 * 为什么不直接拿 id 当文件名：自定义工作流的 id 会带中文（`custom-我的工作流`），
 * 当文件名在 Windows 上虽然能写，但 URL/编码/大小写不敏感的坑很多，用 sha1 更稳。
 *
 * 失败策略：索引坏了当空表（配图丢一张不影响工作流能不能跑），写盘失败抛
 * WorkflowCoverError（路由层回具体状态码，界面能直接显示原因）。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../canvas/dataDir';

/** 一张配图的大小上限（8 MB：足够放一张截图/预览图，又不会把索引与磁盘塞爆）。 */
export const WORKFLOW_COVER_MAX_BYTES = 8 * 1024 * 1024;

/** 允许的图片类型 → 落盘后缀。 */
const COVER_TYPES: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** 一张配图的索引条目。 */
export interface WorkflowCoverEntry {
  /** 磁盘上的文件名（`workflow-covers/` 下） */
  file: string;
  mime: string;
  bytes: number;
  /** 保存时间（epoch 毫秒）：同时用作 URL 上的 cache-buster */
  updatedAt: number;
}

interface CoverIndex {
  version: 1;
  covers: Record<string, WorkflowCoverEntry>;
}

/** 配图相关的错误：路由层按 status/code 透传（面板直接把 message 显示出来）。 */
export class WorkflowCoverError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'INVALID_COVER') {
    super(message);
    this.name = 'WorkflowCoverError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- 路径

/** 与 customWorkflows / mediaStore 同一套数据根（v1.43 起可自定义，见 canvas/dataDir.ts）。 */
function storageRoot(): string {
  return resolveDataDir();
}

/** 配图本体目录。 */
export function workflowCoversDir(): string {
  return join(storageRoot(), 'workflow-covers');
}

/** 配图索引文件。 */
export function workflowCoversIndexPath(): string {
  return join(storageRoot(), 'workflow-covers.json');
}

function ensureDir(): void {
  try {
    mkdirSync(workflowCoversDir(), { recursive: true });
  } catch {
    // 读的时候还会再失败一次并给出更具体的错误，这里不抛
  }
}

// ---------------------------------------------------------------- 索引

let indexCache: CoverIndex | null = null;

function emptyIndex(): CoverIndex {
  return { version: 1, covers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEntry(value: unknown): WorkflowCoverEntry | null {
  if (!isRecord(value)) return null;
  const file = typeof value.file === 'string' ? value.file.trim() : '';
  if (!file || /[\\/\0\r\n]/.test(file) || file === '.' || file === '..') return null;
  const mime = typeof value.mime === 'string' ? value.mime : 'image/png';
  const bytes = Number(value.bytes);
  const updatedAt = Number(value.updatedAt);
  return {
    file,
    mime,
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

function readIndex(): CoverIndex {
  if (indexCache) return indexCache;
  const path = workflowCoversIndexPath();
  if (!existsSync(path)) {
    indexCache = emptyIndex();
    return indexCache;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const covers: Record<string, WorkflowCoverEntry> = {};
    const rawCovers = isRecord(parsed) && isRecord(parsed.covers) ? parsed.covers : {};
    for (const [id, raw] of Object.entries(rawCovers)) {
      const entry = normalizeEntry(raw);
      if (entry) covers[id] = entry;
    }
    indexCache = { version: 1, covers };
  } catch {
    // 索引坏了当空表：配图全丢也不该让工作流面板打不开
    indexCache = emptyIndex();
  }
  return indexCache;
}

function writeIndex(index: CoverIndex): void {
  const path = workflowCoversIndexPath();
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    throw new WorkflowCoverError(
      `保存工作流配图索引失败：${path}（${error instanceof Error ? error.message : String(error)}）`,
      500,
      'COVER_INDEX_WRITE_FAILED',
    );
  }
}

/** 丢掉索引缓存（测试/诊断用：外部手改 workflow-covers.json 后重新读）。 */
export function invalidateWorkflowCovers(): void {
  indexCache = null;
}

// ---------------------------------------------------------------- 读

/** 全部配图（id → 索引条目）。 */
export function listWorkflowCovers(): Record<string, WorkflowCoverEntry> {
  return { ...readIndex().covers };
}

/** 某工作流的配图条目（没配过 → null）。 */
export function getWorkflowCover(id: string): WorkflowCoverEntry | null {
  return readIndex().covers[id] ?? null;
}

/**
 * 配图对外的 URL（没配过 → null）。
 *
 * 带上 `?v=<updatedAt>`：换图之后文件名会变（sha1 不变、后缀可能不变，但索引时间变了），
 * 靠它让浏览器/`<img>` 立刻拿到新图，而不是继续显示缓存里的旧图。
 */
export function workflowCoverUrl(id: string | undefined): string | null {
  if (!id) return null;
  const entry = readIndex().covers[id];
  if (!entry) return null;
  return `/api/aifisher/canvas/workflow-covers/file/${encodeURIComponent(entry.file)}?v=${entry.updatedAt}`;
}

/** 磁盘上的配图绝对路径（文件名必须来自索引，防目录穿越）。 */
export function workflowCoverPath(file: string): string | null {
  const name = typeof file === 'string' ? file.trim() : '';
  if (!name || /[\\/\0\r\n]/.test(name) || name === '.' || name === '..') return null;
  const path = join(workflowCoversDir(), name);
  return existsSync(path) ? path : null;
}

/** 读一份配图的字节 + 类型（面板/测试用；路由层直接流文件，不走这里）。 */
export function readWorkflowCoverFile(
  file: string,
): { path: string; mime: string; bytes: Buffer } | null {
  const path = workflowCoverPath(file);
  if (!path) return null;
  try {
    const bytes = readFileSync(path);
    const indexed = Object.values(readIndex().covers).find((entry) => entry.file === file);
    return { path, mime: indexed?.mime ?? 'image/png', bytes };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 写

/** 工作流 id 的合法形状：只允许字母数字与常见分隔符（含中文 —— id 里有中文是常态）。 */
function assertWorkflowId(id: string): string {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value || value.length > 160) {
    throw new WorkflowCoverError('工作流 id 无效（空或过长）。', 422, 'COVER_ID_INVALID');
  }
  if (/[\\/\0\r\n]/.test(value) || value === '.' || value === '..') {
    throw new WorkflowCoverError(`工作流 id 不能包含路径分隔符：${value}`, 422, 'COVER_ID_INVALID');
  }
  return value;
}

/** data URL → { mime, data }；只认白名单里的图片类型。 */
function parseImageDataUrl(value: unknown): { mime: string; data: Buffer } {
  if (typeof value !== 'string' || !value) {
    throw new WorkflowCoverError(
      '请求里缺少 dataUrl（形如 data:image/png;base64,...）。',
      422,
      'COVER_DATA_MISSING',
    );
  }
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/is.exec(value.trim());
  if (!match) {
    throw new WorkflowCoverError(
      '配图必须是 base64 编码的 data URL（data:image/png;base64,...）。',
      422,
      'COVER_DATA_INVALID',
    );
  }
  const mime = match[1].toLowerCase();
  if (!COVER_TYPES[mime]) {
    throw new WorkflowCoverError(
      `不支持的图片类型：${mime}（可用：${Object.keys(COVER_TYPES).join('、')}）。`,
      415,
      'COVER_TYPE_UNSUPPORTED',
    );
  }
  let data: Buffer;
  try {
    data = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  } catch {
    throw new WorkflowCoverError('配图的 base64 解不开。', 422, 'COVER_DATA_INVALID');
  }
  if (data.length === 0) {
    throw new WorkflowCoverError('配图内容是空的。', 422, 'COVER_DATA_EMPTY');
  }
  if (data.length > WORKFLOW_COVER_MAX_BYTES) {
    throw new WorkflowCoverError(
      `配图太大：${(data.length / 1024 / 1024).toFixed(1)} MB（上限 ${WORKFLOW_COVER_MAX_BYTES / 1024 / 1024} MB）。`,
      413,
      'COVER_TOO_LARGE',
    );
  }
  return { mime, data };
}

/** id → 磁盘文件名（sha1 前 16 位 + 类型后缀，换图时文件名稳定、覆盖写）。 */
function coverFileFor(id: string, mime: string): string {
  return `${createHash('sha1').update(id).digest('hex').slice(0, 16)}${COVER_TYPES[mime] ?? '.png'}`;
}

/**
 * 保存（或替换）一份配图。
 *
 * 入参接受 `{ dataUrl }` 与裸字符串两种写法（面板用前者，命令行探针用后者更省事）。
 * 返回落盘后的索引条目。
 */
export function saveWorkflowCover(id: string, input: unknown): WorkflowCoverEntry {
  const workflowId = assertWorkflowId(id);
  const dataUrl = isRecord(input) ? (input.dataUrl ?? input.data) : input;
  const { mime, data } = parseImageDataUrl(dataUrl);
  ensureDir();
  const file = coverFileFor(workflowId, mime);
  const path = join(workflowCoversDir(), file);
  try {
    writeFileSync(path, data);
  } catch (error) {
    throw new WorkflowCoverError(
      `写配图失败：${path}（${error instanceof Error ? error.message : String(error)}）`,
      500,
      'COVER_WRITE_FAILED',
    );
  }
  const index = readIndex();
  const previous = index.covers[workflowId];
  const entry: WorkflowCoverEntry = {
    file,
    mime,
    bytes: data.length,
    updatedAt: Date.now(),
  };
  const next: CoverIndex = {
    version: 1,
    covers: { ...index.covers, [workflowId]: entry },
  };
  try {
    writeIndex(next);
  } catch (error) {
    // 索引没写成就把刚落的图删掉，别留一张没人引用的孤儿文件
    try {
      rmSync(path, { force: true });
    } catch {
      /* 删不掉也只是多一个文件 */
    }
    throw error;
  }
  indexCache = next;
  // 换类型（png → jpg）时旧文件后缀不同，顺手清掉
  if (previous && previous.file !== file) {
    try {
      rmSync(join(workflowCoversDir(), previous.file), { force: true });
    } catch {
      /* 同上 */
    }
  }
  return entry;
}

/** 删除某工作流的配图（没配过 → false）。 */
export function deleteWorkflowCover(id: string): boolean {
  const workflowId = assertWorkflowId(id);
  const index = readIndex();
  const entry = index.covers[workflowId];
  if (!entry) return false;
  const covers = { ...index.covers };
  delete covers[workflowId];
  const next: CoverIndex = { version: 1, covers };
  writeIndex(next);
  indexCache = next;
  try {
    rmSync(join(workflowCoversDir(), entry.file), { force: true });
  } catch {
    /* 索引已经摘掉，文件删不掉只是留个孤儿 */
  }
  return true;
}

// ---------------------------------------------------------------- 诊断

/** 只读诊断（挂到 /status：面板显示不出配图时先看这里）。 */
export function workflowCoversStatus(): {
  dir: string;
  indexPath: string;
  count: number;
  covers: Record<string, { file: string; bytes: number; updatedAt: number; url: string }>;
} {
  const covers = readIndex().covers;
  const out: Record<string, { file: string; bytes: number; updatedAt: number; url: string }> = {};
  for (const [id, entry] of Object.entries(covers)) {
    out[id] = {
      file: entry.file,
      bytes: entry.bytes,
      updatedAt: entry.updatedAt,
      url: workflowCoverUrl(id) ?? '',
    };
  }
  return {
    dir: workflowCoversDir(),
    indexPath: workflowCoversIndexPath(),
    count: Object.keys(covers).length,
    covers: out,
  };
}

/** 索引里指向的文件还在不在（诊断用：手删了 workflow-covers/ 下的图时能看出来）。 */
export function workflowCoverFileExists(entry: WorkflowCoverEntry): boolean {
  try {
    return statSync(join(workflowCoversDir(), entry.file)).isFile();
  } catch {
    return false;
  }
}
