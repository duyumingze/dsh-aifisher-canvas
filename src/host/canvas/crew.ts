/**
 * 多 agent 协作（v1.63，画布助手 P2 第三项）。
 *
 * 取舍先写清楚：host **不能**替 DSH 起子代理（进程内没有 spawn/subagent 能力），
 * 硬造「多 agent」只会变成一套假的并发。所以这里只做两件确定性的事：
 *
 *   1. `plan`：把「一句话意图」切成**可直接派给 DSH 子代理的任务包** —— 角色、任务、
 *      交付 JSON 契约、边界（不许提交生成/不许改画布）、以及**压过的上下文**
 *      （摘要 + 风格 + 资产名，不是整份剧本）；
 *   2. `receive`：把子代理交回来的结果**校验并归一**（shots/locks），再交给 recipe
 *      展开成节点 —— 于是「多 agent」是协议，不是口头约定。
 *
 * 为什么不让每个子代理自己读画布：读一次画布 = 一次 bridge 往返 + 一整份节点列表，
 * 4 个子代理就是 4 份上下文；上下文由主编排一次打包，子代理只做自己那一段。
 */
import { MAX_INTENT_SHOTS } from './intent';

export type CrewRole = 'director' | 'storyboard' | 'sets' | 'review';

export const CREW_ROLES: readonly CrewRole[] = ['director', 'storyboard', 'sets', 'review'];

export const ROLE_LABELS: Record<CrewRole, string> = {
  director: '导演',
  storyboard: '分镜',
  sets: '设定（资产）',
  review: '审片',
};

export interface CrewAssignment {
  role: CrewRole;
  label: string;
  task: string;
  deliverable: string;
  boundary: string;
  context: Record<string, unknown>;
}

export interface CrewContext {
  projectTitle?: string;
  style?: string;
  assets?: ReadonlyArray<{ name: string; kind: string }>;
  shotCount?: number;
  /** 项目摘要里的统计/提示（不带节点正文）。 */
  digest?: Record<string, unknown>;
}

const MAX_BRIEF_IN_CONTEXT = 600;
const MAX_CONTEXT_CHARS = 1600;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 紧凑上下文：超过上限时优先砍 digest，再砍 brief（保风格与资产名）。 */
function compactContext(context: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(context);
  if (encoded.length <= MAX_CONTEXT_CHARS) return context;
  const next = { ...context };
  delete next.digest;
  if (JSON.stringify(next).length <= MAX_CONTEXT_CHARS) return next;
  if (typeof next.brief === 'string') next.brief = clip(next.brief, 220);
  return next;
}

export interface CrewPlan {
  brief: string;
  shotCount: number;
  roles: CrewRole[];
  assignments: CrewAssignment[];
  notes: string[];
}

export function planCrew(
  rawInput: unknown,
  context: CrewContext = {},
): { plan: CrewPlan } | { error: string } {
  if (!isRecord(rawInput)) {
    return { error: 'crew 需要对象参数，例如 { op:"plan", brief:"雨夜追车短片，6 个镜头" }。' };
  }
  const brief = text(rawInput.brief);
  if (!brief) return { error: 'crew 需要非空 brief（要拆给子代理的意图/剧本）。' };

  const requested = Number(rawInput.shots ?? context.shotCount ?? 0);
  const shotCount = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_INTENT_SHOTS, Math.trunc(requested)) : 0;
  const notes: string[] = [];
  if (!shotCount) notes.push('没给镜头数：分镜角色自己按内容决定，最多 ' + MAX_INTENT_SHOTS + ' 镜。');

  const explicitRoles = Array.isArray(rawInput.roles)
    ? rawInput.roles.filter((role): role is CrewRole => CREW_ROLES.includes(role as CrewRole))
    : [];
  const assets = context.assets ?? [];
  const roles: CrewRole[] = explicitRoles.length
    ? explicitRoles
    : [
        // 复杂任务才值得过一道「导演」：短 brief 且镜头少时直接进分镜，省一轮子代理
        ...(brief.length > 120 || shotCount > 4 ? (['director'] as CrewRole[]) : []),
        'storyboard',
        ...(assets.length === 0 ? (['sets'] as CrewRole[]) : []),
        'review',
      ];

  const shotHint = shotCount ? `${shotCount} 个` : `最多 ${MAX_INTENT_SHOTS} 个`;
  const style = context.style ?? '';
  const baseContext = compactContext({
    brief: clip(brief, MAX_BRIEF_IN_CONTEXT),
    project: context.projectTitle ?? '',
    style,
    assets: assets.map((asset) => `${asset.kind}:${asset.name}`),
    shots: shotCount || undefined,
    digest: context.digest,
  });

  const boundary =
    '边界：只输出 JSON，不要调用 canvas_control / prepareGeneration，不要改画布；' +
    '生成与费用确认永远由用户在主会话里按下。不要复述任务书。';

  const assignments: CrewAssignment[] = [];
  for (const role of roles) {
    if (role === 'director') {
      assignments.push({
        role,
        label: ROLE_LABELS[role],
        task:
          `把这段意图拆成 ${shotHint}镜：每镜只给【标题（镜头 NN · 一句话）+ 画面内容（主体/动作/环境/景别）+ 转场或时间线索】，` +
          '不要写光线与质感细节，也不要写提示词，那是分镜角色的活。',
        deliverable: '{"shots":[{"title":"镜头 01 · …","beat":"一句话画面内容","shot":"景别","note":"转场/时间"}]}',
        boundary,
        context: baseContext,
      });
    } else if (role === 'storyboard') {
      assignments.push({
        role,
        label: ROLE_LABELS[role],
        task:
          `把意图（或导演给的镜头清单）写成可直接进画布的逐镜提示词：每镜 ≤600 字，必须含主体、场景、光线与方向、` +
          '色彩/影调、质感锚点、画面内限制；标题一律「镜头 NN · 短语」；不要写台词与音效。',
        deliverable:
          '{"shots":[{"title":"镜头 01 · …","prompt":"…","type":"Image","duration":null}]}',
        boundary,
        context: baseContext,
      });
    } else if (role === 'sets') {
      assignments.push({
        role,
        label: ROLE_LABELS[role],
        task:
          '从意图里提取角色/场景/道具，各给一条**逐字复用**的锁定串（外形六要素 / 场景全景 15–25° 微俯视），' +
          '不要给建模备注；名称用「角色名/场景名」，同一角色只出一条。',
        deliverable: '{"locks":[{"kind":"character","name":"…","prompt":"…"}]}',
        boundary,
        context: baseContext,
      });
    } else {
      assignments.push({
        role,
        label: ROLE_LABELS[role],
        task:
          '拿到成图后逐镜审片：只看它是否兑现了提示词（主体/光/一致性/构图/质感），' +
          '每镜给 pass/attention/fail + 一句原因 + 一条可执行的修改建议；不要重写整段提示词。',
        deliverable: '{"verdicts":[{"nodeId":"…","title":"…","verdict":"attention","reason":"…","fix":"…"}]}',
        boundary,
        context: baseContext,
      });
    }
  }

  return {
    plan: {
      brief,
      shotCount,
      roles,
      assignments,
      notes,
    },
  };
}

export interface CrewReceiveResult {
  role: CrewRole | 'unknown';
  acceptedShots: Array<{ title: string; prompt: string; type: 'Image' | 'Video' }>;
  acceptedLocks: Array<{ kind: string; name: string; prompt: string }>;
  rejected: Array<{ index: number; reason: string }>;
  notes: string[];
}

/**
 * 校验子代理交付。验收口径与 recipe 一致（标题/提示词非空、≤24 镜），
 * 不合格的条目**逐条拒绝**并说明原因，不做静默截断 —— 让人知道哪一条被丢了。
 */
export function receiveCrew(rawInput: unknown): { result: CrewReceiveResult } | { error: string } {
  if (!isRecord(rawInput)) return { error: 'crew receive 需要对象参数 { role, deliverable }。' };
  const deliverable = rawInput.deliverable;
  if (!isRecord(deliverable)) {
    return { error: 'crew receive 需要 deliverable 对象（子代理交付的 JSON）。' };
  }
  const role = CREW_ROLES.includes(rawInput.role as CrewRole) ? (rawInput.role as CrewRole) : 'unknown';
  const rejected: Array<{ index: number; reason: string }> = [];
  const notes: string[] = [];
  const acceptedShots: CrewReceiveResult['acceptedShots'] = [];
  const acceptedLocks: CrewReceiveResult['acceptedLocks'] = [];

  const rawShots = deliverable.shots;
  if (rawShots !== undefined) {
    if (!Array.isArray(rawShots)) return { error: 'deliverable.shots 必须是数组。' };
    rawShots.forEach((item, index) => {
      if (!isRecord(item)) {
        rejected.push({ index, reason: '不是对象' });
        return;
      }
      const prompt = text(item.prompt);
      if (!prompt) {
        rejected.push({ index, reason: '缺 prompt' });
        return;
      }
      if (acceptedShots.length >= MAX_INTENT_SHOTS) {
        rejected.push({ index, reason: `超过 ${MAX_INTENT_SHOTS} 镜上限` });
        return;
      }
      const type = text(item.type).toLowerCase() === 'video' ? 'Video' : 'Image';
      const title = text(item.title) || `镜头 ${String(acceptedShots.length + 1).padStart(2, '0')}`;
      acceptedShots.push({ title, prompt, type });
    });
  }

  const rawLocks = deliverable.locks;
  if (rawLocks !== undefined) {
    if (!Array.isArray(rawLocks)) return { error: 'deliverable.locks 必须是数组。' };
    rawLocks.forEach((item, index) => {
      if (!isRecord(item)) {
        rejected.push({ index, reason: '不是对象' });
        return;
      }
      const name = text(item.name);
      const prompt = text(item.prompt);
      if (!name || !prompt) {
        rejected.push({ index, reason: '缺 name 或 prompt' });
        return;
      }
      const kind = ['character', 'scene', 'prop', 'style'].includes(text(item.kind)) ? text(item.kind) : 'character';
      acceptedLocks.push({ kind, name, prompt });
    });
  }

  if (acceptedShots.length === 0 && acceptedLocks.length === 0 && rejected.length === 0) {
    return {
      error:
        'deliverable 里没有可验收的内容：镜头角色交 {shots:[…]}，设定角色交 {locks:[…]}，审片角色交 {verdicts:[…]}。',
    };
  }
  if (role === 'review') {
    const verdicts = deliverable.verdicts;
    notes.push(
      Array.isArray(verdicts)
        ? `收到 ${verdicts.length} 条审片结论（本动作只校验镜头/设定，审片结论请写回 review 记录或直接讲给用户）。`
        : '审片角色应交付 {verdicts:[…]}，本次没有收到。',
    );
  }
  if (acceptedShots.length > 0) {
    notes.push('shots 已归一：可用 action:"recipe" recipe:{name:"shot-list", shots:[…]} 一次展开成节点。');
  }
  if (acceptedLocks.length > 0) {
    notes.push('locks 已归一：可用 action:"assetlibrary" op:"add" 逐条登记，或用 op:"import" 批量登记。');
  }

  return { result: { role, acceptedShots, acceptedLocks, rejected, notes } };
}
