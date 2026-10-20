/**
 * 画布项目记忆（v1.59，P1 第一项）：把「这个项目的风格/角色/参数/教训」沉淀下来。
 *
 * ## 为什么要有这一层
 *
 * 用户 2026-10-20 认可的路线图里，P1 第一条就是「画布助手记忆：项目风格/角色/参数沉淀，
 * 跨会话注入」。在此之前，画布对话每次都从零开始：上一轮说过的「黄昏海边、冷色调、
 * 别用贵模型」换一个会话就没了，用户得重新交代一遍。
 *
 * ## 存在哪
 *
 * `<数据目录>/canvas-memory.json`（默认 `$DSH_HOME/storages/dsh-aifisher-canvas/`）。
 * 与 canvas.json 同一套原子写策略（先写 .tmp 再 rename）。只存**文本条目**与
 * **视觉一致性锚点**，不存密钥、不存媒体。
 *
 * ## 数据形状
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "projects": {
 *     "<projectId>": {
 *       "entries": [
 *         { "id": "…", "kind": "style", "text": "黄昏海边，冷色调，低饱和", "key": "look",
 *           "importance": 3, "source": "agent", "createdAt": "…", "updatedAt": "…" }
 *       ],
 *       "anchors": [
 *         { "nodeId": "…", "title": "角色A · 定妆", "role": "character", "createdAt": "…" }
 *       ],
 *       "updatedAt": "…"
 *     }
 *   }
 * }
 * ```
 *
 * ## 为什么用 key 去重
 *
 * 模型很容易把「风格」记成三条重复条目（每次对话追加一条）。同一 `kind` 下给了 `key`
 * 就**原地更新**那一条（`look` / `model` / `negative` …），没给 key 就当独立事实追加。
 * 每个项目封顶 40 条、每条 400 字：注入进上下文的是整个项目的一段短文，不能无限长。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataDir } from './dataDir';

/** 记忆种类：决定它在注入块里的分组与称呼。 */
export const MEMORY_KINDS = ['style', 'character', 'model', 'param', 'rule', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 锚点角色：角色定妆 / 画风参考 / 道具。 */
export const ANCHOR_ROLES = ['character', 'style', 'prop'] as const;
export type AnchorRole = (typeof ANCHOR_ROLES)[number];

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  /** 正文（≤ MEMORY_TEXT_LIMIT）。 */
  text: string;
  /** 同类里的稳定键：给了就原地更新，不给就新增。 */
  key?: string;
  /** 1–4，模型给的重要性提示（注入时按它排序，大的在前）。 */
  importance: number;
  /** 谁写进来的：agent（canvas_control）/ user（界面上写）/ auto（宿主自己记的）。 */
  source: 'agent' | 'user' | 'auto';
  createdAt: string;
  updatedAt: string;
}

/** 视觉一致性锚点：一张「角色/画风参考」节点，把它接到镜头节点上就锁住了脸/服装/画风。 */
export interface ConsistencyAnchor {
  nodeId: string;
  title: string;
  role: AnchorRole;
  createdAt: string;
}

export interface ProjectMemoryBlock {
  projectId: string;
  entries: MemoryEntry[];
  anchors: ConsistencyAnchor[];
  updatedAt: string;
}

interface MemoryFileShape {
  version: 1;
  projects: Record<string, Omit<ProjectMemoryBlock, 'projectId'>>;
}

/** 单条记忆正文上限（超了截断并留 `…`）。 */
export const MEMORY_TEXT_LIMIT = 400;
/** 每个项目最多保留多少条记忆。 */
export const MAX_ENTRIES_PER_PROJECT = 40;
/** 每个项目最多几个锚点。 */
export const MAX_ANCHORS_PER_PROJECT = 12;
/** 最多保留多少个项目的记忆（老的整块丢弃，防止文件无限增长）。 */
export const MAX_PROJECTS = 200;

export interface ProjectMemoryOptions {
  /** 数据文件路径；缺省 `<数据目录>/canvas-memory.json`。 */
  filePath?: string;
  now?: () => number;
}

function emptyFile(): MemoryFileShape {
  return { version: 1, projects: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asKind(value: unknown): MemoryKind {
  return MEMORY_KINDS.includes(value as MemoryKind) ? (value as MemoryKind) : 'note';
}

function asRole(value: unknown): AnchorRole {
  return ANCHOR_ROLES.includes(value as AnchorRole) ? (value as AnchorRole) : 'character';
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MEMORY_TEXT_LIMIT ? `${flat.slice(0, MEMORY_TEXT_LIMIT - 1)}…` : flat;
}

export function defaultMemoryPath(): string {
  return `${resolveDataDir()}/canvas-memory.json`;
}

export function createProjectMemory(options: ProjectMemoryOptions = {}) {
  const filePath = options.filePath ?? defaultMemoryPath();
  const now = options.now ?? (() => Date.now());
  let data: MemoryFileShape = load();
  let writing: Promise<void> = Promise.resolve();
  let writes = 0;

  function iso(): string {
    return new Date(now()).toISOString();
  }

  function load(): MemoryFileShape {
    try {
      if (!existsSync(filePath)) return emptyFile();
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<MemoryFileShape>;
      const projects: MemoryFileShape['projects'] = {};
      for (const [projectId, raw] of Object.entries(parsed.projects ?? {})) {
        if (!projectId || !isRecord(raw)) continue;
        const entries = Array.isArray(raw.entries)
          ? raw.entries.flatMap((item): MemoryEntry[] => {
              if (!isRecord(item) || typeof item.text !== 'string' || !item.text.trim()) return [];
              return [
                {
                  id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
                  kind: asKind(item.kind),
                  text: clip(item.text),
                  ...(typeof item.key === 'string' && item.key ? { key: item.key } : {}),
                  importance:
                    Number.isFinite(item.importance) && (item.importance as number) > 0
                      ? Math.min(4, Math.max(1, Math.trunc(item.importance as number)))
                      : 2,
                  source:
                    item.source === 'user' || item.source === 'auto' || item.source === 'agent'
                      ? item.source
                      : 'agent',
                  createdAt: typeof item.createdAt === 'string' ? item.createdAt : iso(),
                  updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : iso(),
                },
              ];
            })
          : [];
        const anchors = Array.isArray(raw.anchors)
          ? raw.anchors.flatMap((item): ConsistencyAnchor[] => {
              if (!isRecord(item) || typeof item.nodeId !== 'string' || !item.nodeId) return [];
              return [
                {
                  nodeId: item.nodeId,
                  title: typeof item.title === 'string' && item.title ? item.title : item.nodeId,
                  role: asRole(item.role),
                  createdAt: typeof item.createdAt === 'string' ? item.createdAt : iso(),
                },
              ];
            })
          : [];
        projects[projectId] = {
          entries: entries.slice(0, MAX_ENTRIES_PER_PROJECT),
          anchors: anchors.slice(0, MAX_ANCHORS_PER_PROJECT),
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : iso(),
        };
      }
      return { version: 1, projects };
    } catch (error) {
      // 坏档不能让插件起不来：另存一份，然后从空库开始
      try {
        if (existsSync(filePath)) renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败就忽略 */
      }
      console.error('[aifisher-canvas] 项目记忆文件读取失败，已重置为空库', error);
      return emptyFile();
    }
  }

  function persist(): Promise<void> {
    writing = writing.then(async () => {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, filePath);
      writes += 1;
    });
    return writing;
  }

  function block(projectId: string, create = false): Omit<ProjectMemoryBlock, 'projectId'> | null {
    const existing = data.projects[projectId];
    if (existing) return existing;
    if (!create) return null;
    const fresh: Omit<ProjectMemoryBlock, 'projectId'> = { entries: [], anchors: [], updatedAt: iso() };
    data.projects[projectId] = fresh;
    pruneProjects();
    return fresh;
  }

  /** 项目太多时丢最久没更新的整块（记忆是提示性数据，不做长期归档）。 */
  function pruneProjects(): void {
    const ids = Object.keys(data.projects);
    if (ids.length <= MAX_PROJECTS) return;
    const sorted = ids.sort(
      (a, b) =>
        (Date.parse(data.projects[a]?.updatedAt ?? '') || 0) -
        (Date.parse(data.projects[b]?.updatedAt ?? '') || 0),
    );
    for (const id of sorted.slice(0, ids.length - MAX_PROJECTS)) delete data.projects[id];
  }

  function readBlock(projectId: string): ProjectMemoryBlock {
    const found = block(projectId);
    return {
      projectId,
      entries: found ? found.entries.map((entry) => ({ ...entry })) : [],
      anchors: found ? found.anchors.map((anchor) => ({ ...anchor })) : [],
      updatedAt: found?.updatedAt ?? '',
    };
  }

  /**
   * 设锚点（整体替换）。`nodeId` 必须在传进来的 `knownNodeIds` 里 —— 锚点是「哪个节点」，
   * 指向不存在的节点等于锁空，宁可直接拒绝（返回 null）。
   */
  async function writeAnchors(
    projectId: string,
    anchors: ReadonlyArray<{ nodeId?: unknown; title?: unknown; role?: unknown }>,
    knownNodeIds?: ReadonlySet<string>,
  ): Promise<ConsistencyAnchor[] | null> {
    if (!projectId || !Array.isArray(anchors)) return null;
    const target = block(projectId, true);
    if (!target) return null;
    const seen = new Set<string>();
    const next: ConsistencyAnchor[] = [];
    for (const raw of anchors.slice(0, MAX_ANCHORS_PER_PROJECT)) {
      if (!isRecord(raw)) continue;
      const nodeId = typeof raw.nodeId === 'string' ? raw.nodeId : '';
      if (!nodeId || seen.has(nodeId)) continue;
      if (knownNodeIds && !knownNodeIds.has(nodeId)) continue;
      seen.add(nodeId);
      next.push({
        nodeId,
        title: typeof raw.title === 'string' && raw.title ? raw.title.slice(0, 80) : nodeId,
        role: asRole(raw.role),
        createdAt: iso(),
      });
    }
    target.anchors = next;
    target.updatedAt = iso();
    await persist();
    return next.map((anchor) => ({ ...anchor }));
  }

  return {
    filePath,

    /** 读某个项目的记忆块（没有就回空块，不落库）。 */
    get: readBlock,

    /** 所有项目 id（诊断用）。 */
    projects(): string[] {
      return Object.keys(data.projects);
    },

    /**
     * 写一条记忆。
     *
     * - 给了 `key` 且同 kind 下已有同 key → 原地更新（`id` 不变，`createdAt` 保留）；
     * - 否则新增；单项目超过上限时先丢最不重要的（importance 低、最旧）。
     * - 文本为空 → 返回 null（调用方回 INVALID），不写空条目。
     */
    async upsert(
      projectId: string,
      input: { kind?: unknown; text?: unknown; key?: unknown; importance?: unknown; source?: unknown },
    ): Promise<MemoryEntry | null> {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!projectId || !text) return null;
      const kind = asKind(input.kind);
      const key = typeof input.key === 'string' && input.key.trim() ? input.key.trim().slice(0, 60) : undefined;
      const importance = Number.isFinite(input.importance)
        ? Math.min(4, Math.max(1, Math.trunc(input.importance as number)))
        : 2;
      const source =
        input.source === 'user' || input.source === 'auto' ? input.source : 'agent';
      const target = block(projectId, true);
      if (!target) return null;
      const stamp = iso();
      const existing = key
        ? target.entries.find((entry) => entry.kind === kind && entry.key === key)
        : undefined;
      let entry: MemoryEntry;
      if (existing) {
        existing.text = clip(text);
        existing.importance = importance;
        existing.updatedAt = stamp;
        existing.source = source;
        entry = existing;
      } else {
        entry = {
          id: randomUUID(),
          kind,
          text: clip(text),
          ...(key ? { key } : {}),
          importance,
          source,
          createdAt: stamp,
          updatedAt: stamp,
        };
        target.entries.push(entry);
        if (target.entries.length > MAX_ENTRIES_PER_PROJECT) {
          target.entries.sort((a, b) => b.importance - a.importance || Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
          target.entries = target.entries.slice(0, MAX_ENTRIES_PER_PROJECT);
        }
      }
      target.updatedAt = stamp;
      await persist();
      return { ...entry };
    },

    /** 删一条（返回是否真的删掉了）。 */
    async remove(projectId: string, id: string): Promise<boolean> {
      const target = block(projectId);
      if (!target || !id) return false;
      const index = target.entries.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      target.entries.splice(index, 1);
      target.updatedAt = iso();
      await persist();
      return true;
    },

    /**
     * 设锚点（整体替换，见上面 writeAnchors）。
     */
    setAnchors: writeAnchors,

    /** 加一个锚点（已存在则只更新角色/标题）。 */
    async addAnchor(
      projectId: string,
      anchor: { nodeId?: unknown; title?: unknown; role?: unknown },
    ): Promise<ConsistencyAnchor[] | null> {
      if (!projectId) return null;
      const nodeId = typeof anchor.nodeId === 'string' ? anchor.nodeId : '';
      if (!nodeId) return null;
      const current = readBlock(projectId).anchors;
      const next = [
        ...current.filter((item) => item.nodeId !== nodeId),
        {
          nodeId,
          title: typeof anchor.title === 'string' && anchor.title ? anchor.title.slice(0, 80) : nodeId,
          role: asRole(anchor.role),
        },
      ];
      return writeAnchors(projectId, next);
    },

    /** 删锚点。 */
    async removeAnchor(projectId: string, nodeId: string): Promise<ConsistencyAnchor[] | null> {
      if (!projectId || !nodeId) return null;
      const next = readBlock(projectId).anchors.filter((item) => item.nodeId !== nodeId);
      return writeAnchors(projectId, next);
    },

    /**
     * 注入进上下文的紧凑文本（画布会话每回合最多插一条）。
     *
     * 条数少时全给；多了只给最重要的 12 条 + 一句「还有 N 条」。**不返回空块**（返回 ''）：
     * 没有记忆就不要往会话里塞一段空标题。
     */
    formatForPrompt(projectId: string, options: { title?: string; limit?: number } = {}): string {
      const found = data.projects[projectId];
      if (!found || (found.entries.length === 0 && found.anchors.length === 0)) return '';
      const limit = Math.max(1, Math.min(20, options.limit ?? 12));
      const labels: Record<MemoryKind, string> = {
        style: '画风',
        character: '角色',
        model: '模型',
        param: '参数',
        rule: '约束',
        note: '其他',
      };
      const lines: string[] = [];
      lines.push(
        `【画布项目记忆${options.title ? `｜${options.title}` : ''}｜宿主自动注入，不是用户发言】`,
      );
      const sorted = [...found.entries].sort(
        (a, b) => b.importance - a.importance || Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
      );
      for (const entry of sorted.slice(0, limit)) {
        lines.push(`- ${labels[entry.kind]}：${entry.text}`);
      }
      if (sorted.length > limit) lines.push(`- （还有 ${sorted.length - limit} 条，用 canvas_control action:"memory" 查看）`);
      if (found.anchors.length > 0) {
        const anchored = found.anchors
          .map((anchor) => `${anchor.title}（${anchor.role === 'style' ? '画风' : anchor.role === 'prop' ? '道具' : '角色'}·${anchor.nodeId}）`)
          .join('、');
        lines.push(
          `参考锚点：${anchored}。准备生成前用 action:"consistency" op:"lock" 把这些锚点接到镜头节点上（锁脸/锁服装/锁画风）。`,
        );
      }
      lines.push('（这些是历史偏好；与用户本轮要求冲突时以本轮为准，可用 action:"memory" 更新。）');
      return lines.join('\n');
    },

    stats(): Record<string, unknown> {
      const projects = Object.values(data.projects);
      return {
        path: filePath,
        projects: projects.length,
        entries: projects.reduce((sum, item) => sum + item.entries.length, 0),
        anchors: projects.reduce((sum, item) => sum + item.anchors.length, 0),
        writes,
      };
    },
  };
}

export type ProjectMemory = ReturnType<typeof createProjectMemory>;
