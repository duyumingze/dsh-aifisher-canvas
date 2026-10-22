/**
 * 资产库（v1.63，画布助手 P2 第四项；与「意图编译器」「一致性」配套）。
 *
 * 和项目记忆的分工：
 *   - 项目记忆（canvas-memory.json）= 提示性条目（风格、规则、参数偏好），注入给每回合，
 *     适合「一两句话的偏好」；
 *   - 资产库（canvas-assets.json）= **可复用资产卡片**（角色/场景/道具/画风），每条带
 *     一段逐字复用的锁定串 +（可选）画布上的定妆节点，适合「一次定版、多镜头引用」。
 *
 * 为什么单独存：资产条目要能被 `intent` 编译进每个镜头的提示词、被 `assetlibrary`
 * 的 use 动作登记成锚点、被界面列出；把它们塞进 40 条上限的项目记忆会被挤掉。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataDir } from './dataDir';

export const ASSET_KINDS = ['character', 'scene', 'prop', 'style'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface AssetEntry {
  id: string;
  kind: AssetKind;
  /** 资产名（角色名/场景名/道具名） */
  name: string;
  /** 锁定串：跨镜头逐字复用的一段外形/风格描述 */
  prompt: string;
  /** 检索标签（可选） */
  tags: string[];
  /** 画布上的定妆节点（可选）：有它就能被 use 成参考锚点 */
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetLibraryOptions {
  filePath?: string;
  now?: () => number;
}

interface ProjectAssets {
  entries: AssetEntry[];
  updatedAt: string;
}

interface AssetFileShape {
  version: 1;
  projects: Record<string, ProjectAssets>;
}

export const ASSET_PROMPT_LIMIT = 600;
export const MAX_ASSETS_PER_PROJECT = 60;
export const MAX_ASSET_PROJECTS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asKind(value: unknown): AssetKind {
  return ASSET_KINDS.includes(value as AssetKind) ? (value as AssetKind) : 'character';
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ASSET_PROMPT_LIMIT ? `${flat.slice(0, ASSET_PROMPT_LIMIT - 1)}…` : flat;
}

export function defaultAssetPath(): string {
  return `${resolveDataDir()}/canvas-assets.json`;
}

function emptyFile(): AssetFileShape {
  return { version: 1, projects: {} };
}

export function createAssetLibrary(options: AssetLibraryOptions = {}) {
  const filePath = options.filePath ?? defaultAssetPath();
  const now = options.now ?? (() => Date.now());
  let data: AssetFileShape = load();
  let writing: Promise<void> = Promise.resolve();

  const iso = (): string => new Date(now()).toISOString();

  function load(): AssetFileShape {
    try {
      if (!existsSync(filePath)) return emptyFile();
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<AssetFileShape>;
      const projects: AssetFileShape['projects'] = {};
      for (const [projectId, raw] of Object.entries(parsed.projects ?? {})) {
        if (!projectId || !isRecord(raw)) continue;
        const entries = Array.isArray(raw.entries)
          ? raw.entries.flatMap((item): AssetEntry[] => {
              if (!isRecord(item)) return [];
              const name = typeof item.name === 'string' ? item.name.trim() : '';
              const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
              if (!name) return [];
              return [
                {
                  id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
                  kind: asKind(item.kind),
                  name,
                  prompt: clip(prompt),
                  tags: Array.isArray(item.tags)
                    ? item.tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag))
                    : [],
                  ...(typeof item.nodeId === 'string' && item.nodeId ? { nodeId: item.nodeId } : {}),
                  createdAt: typeof item.createdAt === 'string' ? item.createdAt : iso(),
                  updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : iso(),
                },
              ];
            })
          : [];
        projects[projectId] = {
          entries: entries.slice(0, MAX_ASSETS_PER_PROJECT),
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : iso(),
        };
      }
      return { version: 1, projects };
    } catch (error) {
      try {
        if (existsSync(filePath)) renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败就忽略 */
      }
      console.error('[aifisher-canvas] 资产库文件读取失败，已重置为空库', error);
      return emptyFile();
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

  function pruneProjects(): void {
    const ids = Object.keys(data.projects);
    if (ids.length <= MAX_ASSET_PROJECTS) return;
    const sorted = ids.sort(
      (a, b) =>
        (Date.parse(data.projects[a]?.updatedAt ?? '') || 0) -
        (Date.parse(data.projects[b]?.updatedAt ?? '') || 0),
    );
    for (const id of sorted.slice(0, ids.length - MAX_ASSET_PROJECTS)) delete data.projects[id];
  }

  function block(projectId: string, create = false): ProjectAssets | null {
    const existing = data.projects[projectId];
    if (existing) return existing;
    if (!create) return null;
    const fresh: ProjectAssets = { entries: [], updatedAt: iso() };
    data.projects[projectId] = fresh;
    pruneProjects();
    return fresh;
  }

  function list(projectId: string): AssetEntry[] {
    if (!projectId) return [];
    return (block(projectId)?.entries ?? []).map((entry) => ({ ...entry, tags: [...entry.tags] }));
  }

  /**
   * 新增或更新。
   *   - 给 id → 按 id 原地更新；
   *   - 不给 id → 按 kind+name 判重（同名同类型覆盖，不会越记越多）。
   * 返回 null = 参数不合法（缺 name）。
   */
  async function upsert(projectId: string, input: unknown): Promise<AssetEntry | null> {
    if (!projectId || !isRecord(input)) return null;
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) return null;
    const target = block(projectId, true);
    if (!target) return null;
    const kind = asKind(input.kind);
    const id = typeof input.id === 'string' ? input.id : '';
    const prompt = typeof input.prompt === 'string' ? clip(input.prompt) : '';
    const tags = Array.isArray(input.tags)
      ? Array.from(
          new Set(
            input.tags
              .filter((tag): tag is string => typeof tag === 'string')
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
        ).slice(0, 12)
      : [];
    const nodeId = typeof input.nodeId === 'string' && input.nodeId ? input.nodeId : undefined;
    const existing = id
      ? target.entries.find((entry) => entry.id === id)
      : target.entries.find((entry) => entry.kind === kind && entry.name === name);
    if (existing) {
      existing.name = name;
      existing.kind = kind;
      if (prompt) existing.prompt = prompt;
      if (tags.length) existing.tags = tags;
      if (nodeId) existing.nodeId = nodeId;
      else if (isRecord(input) && input.nodeId === null) delete existing.nodeId;
      existing.updatedAt = iso();
      target.updatedAt = existing.updatedAt;
      await persist();
      return { ...existing, tags: [...existing.tags] };
    }
    if (target.entries.length >= MAX_ASSETS_PER_PROJECT) {
      // 资产卡片不像记忆那样值钱到要归档；满了直接拒绝，由人决定删哪个。
      return null;
    }
    const entry: AssetEntry = {
      id: randomUUID(),
      kind,
      name,
      prompt,
      tags,
      ...(nodeId ? { nodeId } : {}),
      createdAt: iso(),
      updatedAt: iso(),
    };
    target.entries.push(entry);
    target.updatedAt = entry.updatedAt;
    await persist();
    return { ...entry, tags: [...entry.tags] };
  }

  async function remove(projectId: string, id: string): Promise<boolean> {
    const target = block(projectId);
    if (!target || !id) return false;
    const before = target.entries.length;
    target.entries = target.entries.filter((entry) => entry.id !== id);
    if (target.entries.length === before) return false;
    target.updatedAt = iso();
    await persist();
    return true;
  }

  /** 给资产挂上（或解绑）画布节点：挂上之后 use 才能把它变成参考锚点。 */
  async function setNode(projectId: string, id: string, nodeId: string | null): Promise<AssetEntry | null> {
    const target = block(projectId);
    const entry = target?.entries.find((item) => item.id === id);
    if (!target || !entry) return null;
    if (nodeId) entry.nodeId = nodeId;
    else delete entry.nodeId;
    entry.updatedAt = iso();
    target.updatedAt = entry.updatedAt;
    await persist();
    return { ...entry, tags: [...entry.tags] };
  }

  function get(projectId: string, id: string): AssetEntry | null {
    const entry = block(projectId)?.entries.find((item) => item.id === id);
    return entry ? { ...entry, tags: [...entry.tags] } : null;
  }

  /** 锁定串：默认只取有 prompt 的角色/场景/道具（画风也算锁定串）。 */
  function locksFor(
    projectId: string,
    kinds: readonly AssetKind[] = ['character', 'scene', 'prop', 'style'],
  ): string[] {
    const wanted = new Set(kinds);
    return list(projectId)
      .filter((entry) => wanted.has(entry.kind) && entry.prompt)
      .map((entry) => entry.prompt);
  }

  /** 已挂节点的资产 → 参考锚点（给 consistency/use 复用）。 */
  function anchorsFor(projectId: string): Array<{ nodeId: string; title: string; role: string }> {
    return list(projectId).flatMap((entry) =>
      entry.nodeId
        ? [
            {
              nodeId: entry.nodeId,
              title: entry.name,
              role: entry.kind === 'character' ? 'character' : entry.kind === 'style' ? 'style' : 'prop',
            },
          ]
        : [],
    );
  }

  function summary(projectId: string): {
    entries: number;
    byKind: Record<AssetKind, number>;
    linked: number;
  } {
    const entries = list(projectId);
    const byKind = { character: 0, scene: 0, prop: 0, style: 0 };
    for (const entry of entries) byKind[entry.kind] += 1;
    return { entries: entries.length, byKind, linked: entries.filter((entry) => entry.nodeId).length };
  }

  return { filePath, list, upsert, remove, setNode, get, locksFor, anchorsFor, summary };
}

export type AssetLibrary = ReturnType<typeof createAssetLibrary>;
