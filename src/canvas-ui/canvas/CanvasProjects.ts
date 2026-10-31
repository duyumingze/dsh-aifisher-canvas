/**
 * 项目库的数据面（v1.84）—— 只跟 host 说话 + 把数字变成人话，**不碰 React**。
 *
 * 为什么单开一层而不是在页面里直接 fetch：
 *   - 回归（scripts/test-canvas-pages.mjs）要能在没有渲染的情况下验「归档 / 收藏 / 复制」
 *     这些动作真的落到 host 上；
 *   - 页面里那些格式化（相对时间 / 规模 / 存储）与卡片、详情栏、顶栏三处共用，
 *     散在 JSX 里早晚出现「卡片写 3 天前、详情写 72 小时前」。
 *
 * 对应 host 路由见 src/host/canvas/projectsRouter.ts（`/api/aifisher/canvas/projects*`）。
 */

/** 画布后端命名空间（与 restRouter 的 CANVAS_API_PREFIX 一致）。 */
export const PROJECTS_API = '/api/aifisher/canvas';

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

export interface ProjectsStorage {
  mediaBytes: number;
  documentBytes: number;
  appearanceBytes: number;
  totalBytes: number;
  mediaFiles: number;
  projects: number;
}

export interface ProjectsPayload {
  projects: ProjectCard[];
  folders: Array<{ id: string; name: string; parentId: string | null }>;
  storage: ProjectsStorage;
  generatedAt: string;
}

export interface ProjectDetail {
  project: ProjectCard;
  recentImages: string[];
  recentVideos: string[];
}

/** 排查读数（诊断面板与回归脚本读它）。 */
const stats = {
  listReads: 0,
  detailReads: 0,
  lastError: '',
  lastAction: '',
  lastUpdatedAt: '',
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hostErrorText(response: Response, data: Record<string, unknown>, fallback: string): string {
  const message = typeof data.error === 'string' ? data.error : '';
  if (message) return message;
  return `${fallback}（HTTP ${response.status}）`;
}

/** 首屏：全部项目 + 存储读数。 */
export async function fetchProjects(): Promise<ProjectsPayload> {
  const response = await fetch(`${PROJECTS_API}/projects`);
  const data = await readJson(response);
  stats.listReads += 1;
  if (!response.ok) {
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, '读不到项目列表'));
  }
  const payload = data as unknown as ProjectsPayload;
  if (!Array.isArray(payload.projects)) {
    stats.lastError = 'PROJECTS_PAYLOAD_INVALID';
    throw new Error('项目列表返回格式无效。');
  }
  stats.lastUpdatedAt = typeof payload.generatedAt === 'string' ? payload.generatedAt : '';
  return payload;
}

export async function fetchProjectDetail(id: string): Promise<ProjectDetail> {
  const response = await fetch(`${PROJECTS_API}/projects/${encodeURIComponent(id)}`);
  const data = await readJson(response);
  stats.detailReads += 1;
  if (!response.ok) {
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, '读不到项目详情'));
  }
  return data as unknown as ProjectDetail;
}

async function postAction(
  id: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${PROJECTS_API}/projects/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  if (!response.ok) {
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, `操作失败：${action}`));
  }
  stats.lastAction = action;
  return data;
}

/** 归档 / 取消归档。 */
export async function setProjectStatus(
  id: string,
  status: 'active' | 'archived',
): Promise<'active' | 'archived'> {
  const data = await postAction(id, 'status', { status });
  return data.status === 'archived' ? 'archived' : 'active';
}

export async function setProjectFavorite(id: string, favorite: boolean): Promise<boolean> {
  const data = await postAction(id, 'favorite', { favorite });
  return data.favorite === true;
}

export async function setProjectNote(id: string, note: string): Promise<void> {
  await postAction(id, 'note', { note });
}

export async function duplicateProject(id: string): Promise<{ id: string; title: string }> {
  const data = await postAction(id, 'duplicate');
  if (typeof data.id !== 'string' || !data.id) throw new Error('复制回执无效：host 没给新项目 id。');
  return { id: data.id, title: typeof data.title === 'string' ? data.title : '' };
}

/** 新建空项目，返回新 id（页面拿到就 openProjectById 切过去）。 */
export async function createProject(title = '未命名项目'): Promise<{ id: string; title: string }> {
  const response = await fetch(`${PROJECTS_API}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await readJson(response);
  if (!response.ok) {
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, '新建项目失败'));
  }
  if (typeof data.id !== 'string' || !data.id) throw new Error('新建回执无效：host 没给项目 id。');
  stats.lastAction = 'create';
  return { id: data.id, title: typeof data.title === 'string' ? data.title : title };
}

/** 删除项目（文档 + 素材进回收站）。 */
export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`${PROJECTS_API}/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const data = await readJson(response);
    stats.lastError = String(data.code ?? response.status);
    throw new Error(hostErrorText(response, data, '删除项目失败'));
  }
  stats.lastAction = 'delete';
}

/** 字节数 → 人话（与项目归档同一个口径）。 */
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

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 21:40 / M 月 D 日。 */
export function relativeTime(iso: string, now = Date.now()): string {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return '—';
  const diff = now - value;
  if (diff < 0) return '刚刚';
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * hour) return `${Math.floor(diff / hour)} 小时前`;
  const date = new Date(value);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (value >= startOfToday - 24 * hour) return `昨天 ${clock}`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 「19 节点 · 11 图 · 3 视频」这种规模摘要（卡片与列表共用）。 */
export function projectScaleText(project: ProjectCard): string {
  const parts = [`${project.nodeCount} 节点`];
  if (project.imageCount) parts.push(`${project.imageCount} 图`);
  if (project.videoCount) parts.push(`${project.videoCount} 视频`);
  if (!project.imageCount && !project.videoCount && project.mediaFiles) {
    parts.push(`${project.mediaFiles} 素材`);
  }
  return parts.join(' · ');
}

/** 「图 11 · 视频 3」这种分项（列表列 / 详情 2×2 用）。 */
export function projectContentText(project: ProjectCard): string {
  const parts: string[] = [];
  if (project.imageCount) parts.push(`图 ${project.imageCount}`);
  if (project.videoCount) parts.push(`视频 ${project.videoCount}`);
  if (project.audioCount) parts.push(`音频 ${project.audioCount}`);
  return parts.length ? parts.join(' · ') : '—';
}

/** 画布尺寸读数（节点包围盒；空项目退回「空白」）。 */
export function projectCanvasText(project: ProjectCard): string {
  if (!project.width || !project.height) return '空白';
  return `${project.width} × ${project.height}`;
}

export function projectsApiReport(): Record<string, unknown> {
  return { ...stats };
}
