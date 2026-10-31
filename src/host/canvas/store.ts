/**
 * 画布本地后端（host 半）：项目 / 文件夹 / 界面偏好。
 *
 * 为什么要有这一层：AIFISHER 的前端把「项目」当成后端资源（GET/POST /api/workflows…）。
 * 移植到 DSH 后没有那套后端，但画布的保存/自动保存/dashboard 都按那套契约调用。
 * 与其改上游前端，不如在 DSH host 里实现同一份契约的**本地版**：
 *   - 数据落成一个 JSON 文件（原子写：先写 .tmp 再 rename）；
 *   - 默认位置 $DSH_HOME/storages/dsh-aifisher-canvas/canvas.json；
 *   - revision 语义与上游一致：客户端提交 revision ≤ 已存版本才算成功，服务端 +1，
 *     落后了就返回冲突（409 / REVISION_CONFLICT），前端会走冲突提示而不是静默丢数据。
 *
 * 上游前端请求形状（对应 vendor 里的调用点，已改写命名空间为 /api/aifisher/canvas/*）：
 *   POST   /workflows                body=整份文档 → {id, revision, success}
 *   GET    /workflows/:id            → 文档
 *   PUT    /workflows/:id/rename     {title}
 *   PUT    /workflows/:id/move       {folderId}
 *   DELETE /workflows/:id
 *   POST   /workflows/:id/cleanup    {preview}    → {pendingDelete: string[]}
 *   GET    /folders                  → 文件夹数组
 *   POST   /folders                  {name,parentId} 或 {…folder,name}（重命名）
 *   DELETE /folders/:id
 *   GET    /preferences              → {values, browserImported}
 *   PATCH  /preferences              {set?, remove?, browserImported?}
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataDir } from './dataDir';

/** 画布文档（上游叫 workflow，字段沿用它们那一套）。 */
export interface CanvasDocument {
  id: string;
  revision: number;
  title?: string;
  nodes: unknown[];
  groups: unknown[];
  folderId?: string | null;
  coverUrl?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSavedBy?: string;
  lastSavedAt?: number;
  [key: string]: unknown;
}

export interface CanvasFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface CanvasProjectSummary {
  id: string;
  title: string;
  folderId: string | null;
  coverUrl?: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

interface StoreShape {
  version: 1;
  documents: Record<string, CanvasDocument>;
  folders: Record<string, CanvasFolder>;
  preferences: { values: Record<string, string>; browserImported: boolean };
}

/** 冲突：客户端提交的 revision 落后于库里已存的版本。 */
export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';
  constructor(readonly currentRevision: number) {
    super('项目已被更早/并发的保存推进，请重新读取后再保存。');
  }
}

export interface CanvasStoreOptions {
  /** 数据文件路径；缺省用 $DSH_HOME/storages/dsh-aifisher-canvas/canvas.json */
  filePath?: string;
}

export function defaultStorePath(): string {
  // v1.43：数据目录可由「设置 → 存储 → 项目数据目录」改（canvas/dataDir.ts）
  return join(resolveDataDir(), 'canvas.json');
}

function emptyStore(): StoreShape {
  return {
    version: 1,
    documents: {},
    folders: {},
    preferences: { values: {}, browserImported: false },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createCanvasStore(options: CanvasStoreOptions = {}) {
  const filePath = options.filePath ?? defaultStorePath();
  let data: StoreShape = load();
  /** 写操作串行化，避免两个并发请求互相覆盖文件。 */
  let writing: Promise<void> = Promise.resolve();

  function load(): StoreShape {
    try {
      if (!existsSync(filePath)) return emptyStore();
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      const base = emptyStore();
      return {
        version: 1,
        documents: parsed.documents ?? base.documents,
        folders: parsed.folders ?? base.folders,
        preferences: {
          values: parsed.preferences?.values ?? {},
          browserImported: parsed.preferences?.browserImported === true,
        },
      };
    } catch (error) {
      // 文件坏了不能让整个插件起不来：另存一份坏档再开空库。
      try {
        if (existsSync(filePath)) {
          renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
        }
      } catch {
        /* 备份失败就忽略 */
      }
      console.error('[aifisher-canvas] 画布数据文件读取失败，已重置为空库', error);
      return emptyStore();
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

  function summary(doc: CanvasDocument): CanvasProjectSummary {
    return {
      id: doc.id,
      title: typeof doc.title === 'string' && doc.title ? doc.title : '未命名项目',
      folderId: (doc.folderId as string | null | undefined) ?? null,
      ...(typeof doc.coverUrl === 'string' && doc.coverUrl ? { coverUrl: doc.coverUrl } : {}),
      nodeCount: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
      createdAt: doc.createdAt ?? nowIso(),
      updatedAt: doc.updatedAt ?? doc.createdAt ?? nowIso(),
    };
  }

  return {
    filePath,

    /** GET /workflows —— dashboard 列表（按更新时间倒序）。 */
    listDocuments(): CanvasProjectSummary[] {
      return Object.values(data.documents)
        .map(summary)
        .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    },

    getDocument(id: string): CanvasDocument | null {
      return data.documents[id] ?? null;
    },

    /**
     * 按节点 id 反查它所在的项目（v1.51：`@[标题](aifisher-node:id)` 只带节点 id）。
     *
     * 节点 id 是画布生成的 UUID，全库唯一；这里按项目逐个找，命中即返回。
     * 找不到（节点被删了 / 项目被删了）返回 null，调用方安静地跳过。
     */
    findNode(nodeId: string): { document: CanvasDocument; node: Record<string, unknown> } | null {
      for (const document of Object.values(data.documents)) {
        const node = (document.nodes ?? []).find(
          (item): item is Record<string, unknown> =>
            Boolean(item) &&
            typeof item === 'object' &&
            (item as { id?: unknown }).id === nodeId,
        );
        if (node) return { document, node };
      }
      return null;
    },

    hasDocument(id: string): boolean {
      return Boolean(data.documents[id]);
    },

    /**
     * POST /workflows —— 上游把整份文档 POST 上来，靠 revision 做乐观并发：
     * 只有「客户端 revision ≥ 服务端 revision」才接受，成功后服务端 revision +1。
     */
    async saveDocument(input: Record<string, unknown>): Promise<{
      id: string;
      revision: number;
      success: true;
    }> {
      const id = typeof input.id === 'string' && input.id ? input.id : randomUUID();
      const incomingRevision = Number(input.revision ?? 0);
      const existing = data.documents[id];
      const currentRevision = existing ? Number(existing.revision ?? 0) : 0;
      if (existing && (!Number.isFinite(incomingRevision) || incomingRevision < currentRevision)) {
        throw new RevisionConflictError(currentRevision);
      }
      const revision = currentRevision + 1;
      // createBackup 之类的瞬时字段不落库
      const { createBackup: _backup, ...rest } = input;
      const stored: CanvasDocument = {
        ...(existing ?? {}),
        ...rest,
        id,
        revision,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
        nodes: Array.isArray(input.nodes) ? input.nodes : (existing?.nodes ?? []),
        groups: Array.isArray(input.groups) ? input.groups : (existing?.groups ?? []),
      };
      data.documents[id] = stored;
      await persist();
      return { id, revision, success: true };
    },

    async renameDocument(id: string, title: string): Promise<CanvasProjectSummary | null> {
      const doc = data.documents[id];
      if (!doc) return null;
      doc.title = title;
      doc.updatedAt = nowIso();
      await persist();
      return summary(doc);
    },

    async moveDocument(id: string, folderId: string | null): Promise<CanvasProjectSummary | null> {
      const doc = data.documents[id];
      if (!doc) return null;
      doc.folderId = folderId;
      doc.updatedAt = nowIso();
      await persist();
      return summary(doc);
    },

    /**
     * 只改几个标量字段（v1.84，项目库用）。
     *
     * 项目库要改的「归档状态 / 收藏 / 备注」都不属于画布内容，走 saveDocument 会要一份
     * 完整文档（客户端手里没有）并且顺手把 revision 推一格 —— 那会让正在打开的画布
     * 下一个 saved 撞 409。这里只合并字段、不碰 revision 与主体。
     */
    async patchDocument(
      id: string,
      patch: Record<string, unknown>,
    ): Promise<CanvasProjectSummary | null> {
      const doc = data.documents[id];
      if (!doc) return null;
      Object.assign(doc, patch);
      doc.updatedAt = nowIso();
      await persist();
      return summary(doc);
    },

    async deleteDocument(id: string): Promise<boolean> {
      if (!data.documents[id]) return false;
      delete data.documents[id];
      await persist();
      return true;
    },

    listFolders(): CanvasFolder[] {
      return Object.values(data.folders).sort(
        (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
      );
    },

    async createFolder(name: string, parentId: string | null): Promise<CanvasFolder> {
      const folder: CanvasFolder = {
        id: randomUUID(),
        name: name || '未命名文件夹',
        parentId: parentId ?? null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      data.folders[folder.id] = folder;
      await persist();
      return folder;
    },

    /** POST /folders（带 id）—— 上游用同一个端点做重命名。 */
    async renameFolder(folder: CanvasFolder): Promise<CanvasFolder | null> {
      const existing = data.folders[folder.id];
      if (!existing) return null;
      data.folders[folder.id] = {
        ...existing,
        ...folder,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
      };
      await persist();
      return data.folders[folder.id];
    },

    async deleteFolder(id: string): Promise<boolean> {
      if (!data.folders[id]) return false;
      delete data.folders[id];
      // 文件夹下的项目回到根目录，而不是跟着消失
      for (const doc of Object.values(data.documents)) {
        if (doc.folderId === id) doc.folderId = null;
      }
      await persist();
      return true;
    },

    /**
     * POST /workflows/:id/cleanup —— 上游在这里清理项目关联的媒体文件。
     * 本地后端目前不落媒体文件，所以「待清理清单」恒为空，
     * 前端拿到的就是一个合法的空结果（不会报错、也不会误删东西）。
     */
    cleanup(_id: string, preview: boolean): { pendingDelete: string[] } {
      void preview;
      return { pendingDelete: [] };
    },

    preferences(): { values: Record<string, string>; browserImported: boolean } {
      return {
        values: { ...data.preferences.values },
        browserImported: data.preferences.browserImported === true,
      };
    },

    async patchPreferences(body: Record<string, unknown>): Promise<void> {
      const set = (body.set ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(set)) {
        if (typeof value === 'string') data.preferences.values[key] = value;
        else if (value === null) delete data.preferences.values[key];
        else data.preferences.values[key] = String(value);
      }
      const remove = Array.isArray(body.remove) ? (body.remove as unknown[]) : [];
      for (const key of remove) {
        if (typeof key === 'string') delete data.preferences.values[key];
      }
      if (body.browserImported === true) data.preferences.browserImported = true;
      await persist();
    },

    /** 给排查用：库里有几个项目/文件夹。 */
    stats(): { documents: number; folders: number; bytes: number } {
      let bytes = 0;
      try {
        bytes = existsSync(filePath) ? readFileSync(filePath).byteLength : 0;
      } catch {
        bytes = 0;
      }
      return {
        documents: Object.keys(data.documents).length,
        folders: Object.keys(data.folders).length,
        bytes,
      };
    },
  };
}

export type CanvasStore = ReturnType<typeof createCanvasStore>;
