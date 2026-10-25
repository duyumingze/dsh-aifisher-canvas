/**
 * 创作进度（v1.69，画布助手 P3 第三项）：把「做到第几步、哪版方案已经确认」写进磁盘。
 *
 * ## 为什么要有这一层
 *
 * 之前的项目状态散在三处：记忆（风格/角色）、资产库（定版串）、锚点（定妆节点）——
 * 都是「设定」，唯独没有「**进度**」。于是换个会话/刷新页面之后，Agent 只能从
 * 节点长相去猜「剧本写了没、分镜拆了没、用户确认的是哪一版」，猜错的代价是重做。
 *
 * 这里给一条与节点一一对应的阶段线（intake → … → complete），外加三样东西：
 *   - `brief`：用户最初那句话（原话，不转述）；
 *   - `approvedPlan`：**用户已经点头的版本**（改了就要覆盖，别拿旧版当依据）；
 *   - `approvedNodeIds` / `referenceNodeIds`：哪些节点是定下来的、哪些是参考。
 *
 * ## 存在哪
 *
 * `<数据目录>/canvas-progress.json`，按项目一条，与 canvas-memory.json 同一套原子写策略。
 *
 * 借鉴与边界：相位机的想法来自外部开源项目 infinite-canvas（AGPL-3.0）的
 * `set_agent_state`（phase + approvedPlan + approvedNodeIds + referenceNodeIds 落盘续跑）；
 * 阶段名按本插件的分镜链路重定，代码自己写。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDataDir } from './dataDir';

/** 阶段线：从接单到成片。顺序即推进方向，`complete` 之后不再有下一步。 */
export const PHASES = [
  'intake',
  'concept',
  'script',
  'breakdown',
  'references',
  'storyboard',
  'video',
  'audio',
  'review',
  'complete',
] as const;

export type Phase = (typeof PHASES)[number];

export const PHASE_LABELS: Record<Phase, string> = {
  intake: '接单（明确要做什么）',
  concept: '概念（定调性/画风）',
  script: '剧本（正文/台词）',
  breakdown: '拆解（分场与镜头表）',
  references: '参考（定妆/画风锚点）',
  storyboard: '分镜（逐镜画面）',
  video: '视频（逐镜成片）',
  audio: '音频（配音/音乐）',
  review: '审片（筛与改）',
  complete: '完成',
};

export function nextPhase(phase: Phase): Phase | null {
  const index = PHASES.indexOf(phase);
  if (index < 0 || index >= PHASES.length - 1) return null;
  return PHASES[index + 1] ?? null;
}

export interface ProgressHistoryItem {
  phase: Phase;
  at: string;
}

export interface ProjectProgress {
  phase: Phase;
  /** 用户最初那句话（原话）。 */
  brief: string;
  /** 用户已经确认的方案；改了要覆盖，别留旧版误导后续会话。 */
  approvedPlan: string;
  /** 已定稿的节点（镜头/主图）。 */
  approvedNodeIds: string[];
  /** 作为参考的节点（定妆/画风/场景板）。 */
  referenceNodeIds: string[];
  /** 一句话备注（下一步做什么、卡在哪）。 */
  note: string;
  updatedAt: string;
  /** 阶段变更轨迹（最多 20 条，旧的丢）。 */
  history: ProgressHistoryItem[];
}

export const BRIEF_LIMIT = 600;
export const PLAN_LIMIT = 4000;
export const NOTE_LIMIT = 500;
export const MAX_NODE_IDS = 60;
export const MAX_HISTORY = 20;
export const MAX_PROGRESS_PROJECTS = 200;

export interface ProgressStoreOptions {
  filePath?: string;
  now?: () => number;
}

interface ProgressFileShape {
  version: 1;
  projects: Record<string, ProjectProgress>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asPhase(value: unknown): Phase | null {
  return (PHASES as readonly string[]).includes(value as string) ? (value as Phase) : null;
}

function clipText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function idList(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const id = item.trim();
    if (id) seen.add(id);
  }
  return [...seen].slice(0, MAX_NODE_IDS);
}

export function defaultProgressPath(): string {
  return `${resolveDataDir()}/canvas-progress.json`;
}

function emptyFile(): ProgressFileShape {
  return { version: 1, projects: {} };
}

export function createProgressStore(options: ProgressStoreOptions = {}) {
  const filePath = options.filePath ?? defaultProgressPath();
  const now = options.now ?? (() => Date.now());
  let data: ProgressFileShape = load();
  let writing: Promise<void> = Promise.resolve();

  const iso = (): string => new Date(now()).toISOString();

  function load(): ProgressFileShape {
    try {
      if (!existsSync(filePath)) return emptyFile();
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ProgressFileShape>;
      const projects: ProgressFileShape['projects'] = {};
      for (const [projectId, raw] of Object.entries(parsed.projects ?? {})) {
        if (!projectId || !isRecord(raw)) continue;
        const phase = asPhase(raw.phase);
        if (!phase) continue;
        projects[projectId] = {
          phase,
          brief: clipText(raw.brief, BRIEF_LIMIT),
          approvedPlan: clipText(raw.approvedPlan, PLAN_LIMIT),
          approvedNodeIds: idList(raw.approvedNodeIds) ?? [],
          referenceNodeIds: idList(raw.referenceNodeIds) ?? [],
          note: clipText(raw.note, NOTE_LIMIT),
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : iso(),
          history: Array.isArray(raw.history)
            ? raw.history.flatMap((item): ProgressHistoryItem[] => {
                if (!isRecord(item)) return [];
                const itemPhase = asPhase(item.phase);
                if (!itemPhase) return [];
                return [{ phase: itemPhase, at: typeof item.at === 'string' ? item.at : iso() }];
              }).slice(-MAX_HISTORY)
            : [],
        };
      }
      return { version: 1, projects };
    } catch (error) {
      try {
        if (existsSync(filePath)) renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败就忽略 */
      }
      console.error('[aifisher-canvas] 创作进度文件读取失败，已重置为空库', error);
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
    if (ids.length <= MAX_PROGRESS_PROJECTS) return;
    const sorted = ids.sort(
      (a, b) =>
        (Date.parse(data.projects[a]?.updatedAt ?? '') || 0) -
        (Date.parse(data.projects[b]?.updatedAt ?? '') || 0),
    );
    for (const id of sorted.slice(0, ids.length - MAX_PROGRESS_PROJECTS)) delete data.projects[id];
  }

  /**
   * 写进度：只覆盖给了的字段。
   *
   * `phase` 第一次写必须给（不然不知道停在哪一步）；之后可以只更新方案/节点清单。
   * 阶段**变了**才记历史（同一阶段反复更新方案不刷屏）。非法 phase 直接报错，
   * 不静默落到 intake —— 否则 Agent 会以为「已经推进到审片了」。
   */
  async function set(
    projectId: string,
    input: unknown,
  ): Promise<{ progress: ProjectProgress; changed: boolean } | { error: string }> {
    if (!projectId) return { error: '缺少 projectId。' };
    if (input !== undefined && input !== null && !isRecord(input)) {
      return { error: 'progress 参数必须是对象。' };
    }
    const raw = isRecord(input) ? input : {};
    const existing = data.projects[projectId];
    const wantedPhase = raw.phase === undefined ? null : asPhase(raw.phase);
    if (raw.phase !== undefined && !wantedPhase) {
      return { error: `phase 只能是 ${PHASES.join(' / ')}。` };
    }
    if (!existing && !wantedPhase) {
      return { error: `第一次写进度必须给 phase（${PHASES.join(' / ')}）。` };
    }
    const approved = idList(raw.approvedNodeIds);
    if (raw.approvedNodeIds !== undefined && approved === null) {
      return { error: 'approvedNodeIds 必须是节点 id 的字符串数组。' };
    }
    const references = idList(raw.referenceNodeIds);
    if (raw.referenceNodeIds !== undefined && references === null) {
      return { error: 'referenceNodeIds 必须是节点 id 的字符串数组。' };
    }
    const stamp = iso();
    const phase = wantedPhase ?? existing!.phase;
    const changed = phase !== existing?.phase;
    const history = existing ? [...existing.history] : [];
    if (changed) {
      history.push({ phase, at: stamp });
      while (history.length > MAX_HISTORY) history.shift();
    }
    const progress: ProjectProgress = {
      phase,
      brief: raw.brief === undefined ? existing?.brief ?? '' : clipText(raw.brief, BRIEF_LIMIT),
      approvedPlan:
        raw.approvedPlan === undefined
          ? existing?.approvedPlan ?? ''
          : clipText(raw.approvedPlan, PLAN_LIMIT),
      approvedNodeIds: approved ?? existing?.approvedNodeIds ?? [],
      referenceNodeIds: references ?? existing?.referenceNodeIds ?? [],
      note: raw.note === undefined ? existing?.note ?? '' : clipText(raw.note, NOTE_LIMIT),
      updatedAt: stamp,
      history,
    };
    data.projects[projectId] = progress;
    pruneProjects();
    await persist();
    return { progress: { ...progress, history: [...history] }, changed };
  }

  return {
    filePath,

    get(projectId: string): ProjectProgress | null {
      const record = projectId ? data.projects[projectId] : undefined;
      if (!record) return null;
      return { ...record, history: [...record.history] };
    },

    set,

    async clear(projectId: string): Promise<boolean> {
      if (!projectId || !data.projects[projectId]) return false;
      delete data.projects[projectId];
      await persist();
      return true;
    },
  };
}

export type ProgressStore = ReturnType<typeof createProgressStore>;

/**
 * 注入进会话的一段话（画布对话每回合跟项目记忆拼在一起）。
 * 没有进度就返回空串 —— 别往会话里塞一个空标题。
 */
export function formatProgressForPrompt(progress: ProjectProgress | null): string {
  if (!progress) return '';
  const next = nextPhase(progress.phase);
  const parts = [`【画布创作进度｜宿主自动注入，不是用户发言】阶段：${PHASE_LABELS[progress.phase]}（${progress.phase}）`];
  if (progress.brief) parts.push(`用户原话：${progress.brief}`);
  if (progress.approvedPlan) parts.push(`已确认方案：${progress.approvedPlan}`);
  if (progress.approvedNodeIds.length) parts.push(`已定稿节点：${progress.approvedNodeIds.join('、')}`);
  if (progress.referenceNodeIds.length) parts.push(`参考节点：${progress.referenceNodeIds.join('、')}`);
  if (progress.note) parts.push(`备注：${progress.note}`);
  parts.push(
    next
      ? `下一步是 ${PHASE_LABELS[next]}（${next}）；推进用 canvas_control action:"progress" op:"set" phase:"${next}"，用户点头的方案写进 approvedPlan。`
      : '已经到完成阶段；要继续做新的一轮，用 action:"progress" 把 phase 改回去并写新的 brief。',
  );
  return parts.join('\n');
}
