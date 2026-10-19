/**
 * 生成批次记录（host 半，v1.57）：`/api/aifisher/canvas/agent/plans*` 的本地实现。
 *
 * ## 为什么非做不可
 *
 * 上游画布在 `prepareGeneration` 的最后一步会 `journal.prepare(batch)`（POST /agent/plans）
 * 把批次落进它的数据库，**拿到带 revision 的记录才返回 awaiting-approval**；
 * 那一步失败，整个准备动作直接 `UNAVAILABLE`。DSH 版一直没有这份后端（早先回 501），
 * 于是「Agent 准备 → 用户在画布点确认」这条主链路其实是断的 —— v1.57 之前 `prepareGeneration`
 * 恒失败。这里补上最小可用的实现，同时它就是生成事件推送的**绑定来源**：
 * 批次里带 `sessionId`（= 发起 canvas_control 的 DSH 会话）与 `items[].nodeId`，
 * 正好是「这批生成跑完该推给谁」的全部信息。
 *
 * ## 契约（照 vendor 的 generationPlanClient，一个字段不多）
 *
 *   GET  /agent/plans?projectId=…               该项目的批次列表（数组，新的在前）
 *   POST /agent/plans                           { id, projectId, sessionId, expiresAt, state, items[] } → 记录 + revision
 *   POST /agent/plans/:id/claim                 { projectId, revision } → state:"running"
 *   POST /agent/plans/:id/record                { projectId, revision, nodeId, state, attemptId? } → 更新条目
 *   POST /agent/plans/:id/finish                { projectId, revision } → state:"finished"
 *
 * `revision` 我们**不做乐观并发校验**：上游那份是「服务端权威 + 多端同时改」，本插件是
 * 单机单人（一台机器上一个画布页面），revision 只用来满足前端的形状校验。硬校验只会让
 * 「同一次 approve 里的连续 record 调用」因为毫秒级时序被 409 打断 —— 那是纯自伤。
 *
 * ## 落盘
 *
 * **只存内存**（进程内）。理由：这些记录的唯一消费方是同一个画布页面的 `restore()`；
 * DSH 重启后画布页也重新加载，而旧的 pending 批次本来就无法再确认（approve 闭包已丢），
 * 复活它反而会让用户对着一个点不动的卡片。重启后 restore 拿到空数组，画布如实什么都不显示。
 * 已结束的批次保留最近 `MAX_PLANS` 条，防止熬一整晚后内存里堆几千条。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '../http/httpUtil';

export type GenerationPlanState = 'pending' | 'running' | 'finished' | 'cancelled';
export type GenerationPlanItemState =
  | 'pending'
  | 'submitted'
  | 'success'
  | 'failed'
  | 'unconfirmed'
  | 'stopped';

export interface GenerationPlanItem {
  nodeId: string;
  title: string;
  model: string;
  parameters: string;
  count: number;
  references: string[];
  dependsOn?: string[];
  state: GenerationPlanItemState;
}

/** 画布侧 `GenerationPlanRecord`（= GenerationBatch + revision），字段原样透传。 */
export interface GenerationPlanRecord {
  id: string;
  projectId: string;
  sessionId: string;
  expiresAt: number;
  state: GenerationPlanState;
  authorizationId?: string;
  recovered?: boolean;
  items: GenerationPlanItem[];
  revision: number;
  /**
   * 本插件自己加的收尾时刻（epoch ms，不是上游字段）。
   *
   * 只用来让 `list()` 把「很久以前就结束的批次」藏起来：画布每次打开项目都会 restore 一次，
   * 全都返回的话，用户每开一次项目就会被一堆旧卡片糊一遍。上游有数据库与清理策略，
   * 我们内存版用这个字段做一个 10 分钟窗口。vendor 把 record 展开进 batch，多一个键无副作用。
   */
  finishedAt?: number;
}

/** 已结束的批次在 `list()` 里再露多久（毫秒）。 */
const FINISHED_VISIBLE_MS = 10 * 60_000;

export interface GenerationPlansOptions {
  /** 最多保留多少条（默认 20，与画布侧 entries 上限一致）。 */
  maxPlans?: number;
  /** 新批次落库后的回调（生成事件推送据此绑定 nodeId → sessionId）。 */
  onPrepare?(record: GenerationPlanRecord): void;
}

/** 内存里保留的批次数上限（含 pending/running）。 */
const MAX_PLANS = 20;

const ITEM_STATES = new Set<GenerationPlanItemState>([
  'pending',
  'submitted',
  'success',
  'failed',
  'unconfirmed',
  'stopped',
]);
const PLAN_STATES = new Set<GenerationPlanState>(['pending', 'running', 'finished', 'cancelled']);

function normalizeItem(raw: unknown): GenerationPlanItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const nodeId = typeof item.nodeId === 'string' ? item.nodeId : '';
  if (!nodeId) return null;
  const state = typeof item.state === 'string' && ITEM_STATES.has(item.state as GenerationPlanItemState)
    ? (item.state as GenerationPlanItemState)
    : 'pending';
  return {
    nodeId,
    title: typeof item.title === 'string' && item.title ? item.title : nodeId,
    model: typeof item.model === 'string' ? item.model : '',
    parameters: typeof item.parameters === 'string' ? item.parameters : '',
    count: Number.isSafeInteger(item.count) && (item.count as number) > 0 ? (item.count as number) : 1,
    references: Array.isArray(item.references)
      ? item.references.filter((value): value is string => typeof value === 'string')
      : [],
    ...(Array.isArray(item.dependsOn)
      ? {
          dependsOn: item.dependsOn.filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          ),
        }
      : {}),
    state,
  };
}

export function createGenerationPlans(options: GenerationPlansOptions = {}) {
  const maxPlans = Math.max(4, options.maxPlans ?? MAX_PLANS);
  /** id → 记录（Map 插入顺序就是「准备先后」，列表时反过来）。 */
  const records = new Map<string, GenerationPlanRecord>();
  let prepared = 0;
  let updated = 0;

  function prune(): void {
    if (records.size <= maxPlans) return;
    // 先扔最早的**已结束**批次；全都还在跑就扔最早的那条（理论上画布侧也限制 20 条）
    for (const [id, record] of [...records]) {
      if (records.size <= maxPlans) return;
      if (record.state === 'pending' || record.state === 'running') continue;
      records.delete(id);
    }
    for (const id of [...records.keys()]) {
      if (records.size <= maxPlans) return;
      records.delete(id);
    }
  }

  return {
    /** POST /agent/plans —— 落一条准备批次。缺 id/projectId/sessionId/items 视为无效。 */
    prepare(body: unknown): { ok: true; record: GenerationPlanRecord } | { ok: false; error: string } {
      if (!body || typeof body !== 'object') return { ok: false, error: '批次数据无效。' };
      const raw = body as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
      const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
      if (!id || !projectId) return { ok: false, error: '批次缺少 id 或 projectId。' };
      const items = Array.isArray(raw.items)
        ? raw.items.map(normalizeItem).filter((item): item is GenerationPlanItem => item !== null)
        : [];
      if (items.length === 0) return { ok: false, error: '批次里没有可生成的节点。' };
      const state =
        typeof raw.state === 'string' && PLAN_STATES.has(raw.state as GenerationPlanState)
          ? (raw.state as GenerationPlanState)
          : 'pending';
      const record: GenerationPlanRecord = {
        id,
        projectId,
        sessionId,
        expiresAt:
          Number.isFinite(raw.expiresAt) && (raw.expiresAt as number) > 0
            ? Math.floor(raw.expiresAt as number)
            : Date.now() + 10 * 60_000,
        state,
        ...(typeof raw.authorizationId === 'string' && raw.authorizationId
          ? { authorizationId: raw.authorizationId }
          : {}),
        items,
        revision: 1,
      };
      records.set(id, record);
      prepared += 1;
      prune();
      try {
        options.onPrepare?.(record);
      } catch (error) {
        console.error(
          `[aifisher-canvas] 批次准备回调失败（已忽略）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return { ok: true, record };
    },

    /** GET /agent/plans?projectId=… （新的在前；不带 projectId 时返回全部）。 */
    list(projectId?: string): GenerationPlanRecord[] {
      const wanted = typeof projectId === 'string' && projectId ? projectId : '';
      const now = Date.now();
      return [...records.values()]
        .filter((record) => !wanted || record.projectId === wanted)
        // 已结束的老批次不再回给 restore（见 finishedAt 的注释）
        .filter(
          (record) =>
            record.state === 'pending' ||
            record.state === 'running' ||
            record.finishedAt === undefined ||
            now - record.finishedAt < FINISHED_VISIBLE_MS,
        )
        .reverse();
    },

    get(id: string): GenerationPlanRecord | null {
      return records.get(id) ?? null;
    },

    /** POST /agent/plans/:id/claim —— 用户点了确认，批次开始跑。 */
    claim(id: string): GenerationPlanRecord | null {
      const record = records.get(id);
      if (!record) return null;
      record.state = 'running';
      record.revision += 1;
      updated += 1;
      return record;
    },

    /** POST /agent/plans/:id/record —— 更新某个节点在批次里的状态。 */
    recordItem(
      id: string,
      input: { nodeId?: unknown; state?: unknown; attemptId?: unknown },
    ): { record: GenerationPlanRecord; changed: boolean } | null {
      const record = records.get(id);
      if (!record) return null;
      const nodeId = typeof input.nodeId === 'string' ? input.nodeId : '';
      const state =
        typeof input.state === 'string' && ITEM_STATES.has(input.state as GenerationPlanItemState)
          ? (input.state as GenerationPlanItemState)
          : '';
      if (!nodeId || !state) return { record, changed: false };
      const item = record.items.find((candidate) => candidate.nodeId === nodeId);
      if (!item) return { record, changed: false };
      if (item.state === state) return { record, changed: false };
      item.state = state;
      record.revision += 1;
      updated += 1;
      return { record, changed: true };
    },

    /** POST /agent/plans/:id/finish —— 整批收尾。 */
    finish(id: string): GenerationPlanRecord | null {
      const record = records.get(id);
      if (!record) return null;
      record.state = record.state === 'cancelled' ? 'cancelled' : 'finished';
      record.finishedAt = Date.now();
      record.revision += 1;
      updated += 1;
      return record;
    },

    stats(): Record<string, unknown> {
      let open = 0;
      for (const record of records.values()) {
        if (record.state === 'pending' || record.state === 'running') open += 1;
      }
      return {
        kept: records.size,
        open,
        prepared,
        updated,
        plans: [...records.values()].map((record) => ({
          id: record.id,
          projectId: record.projectId,
          sessionId: record.sessionId,
          state: record.state,
          revision: record.revision,
          items: record.items.map((item) => `${item.nodeId}:${item.state}`),
        })),
      };
    },
  };
}

export type GenerationPlans = ReturnType<typeof createGenerationPlans>;

/**
 * 把 `/agent/plans*` 路由实现出来。
 *
 * 返回 true 表示已处理（包括 4xx/5xx —— 调用方只管「这条路径归我了」）。
 * 路径形状由 agentChatRouter 切好传进来：
 *   parts = ['agent','plans'] / ['agent','plans', id, 'claim'|'record'|'finish']
 */
export async function handleGenerationPlansApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  plans: GenerationPlans;
}): Promise<boolean> {
  const { req, res, url, parts, plans } = input;
  const method = (req.method ?? 'GET').toUpperCase();

  // /agent/plans —— 列表 / 新建
  if (parts.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, plans.list(url.searchParams.get('projectId') ?? undefined));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const result = plans.prepare(body);
      if (!result.ok) {
        sendJson(res, 422, { error: result.error, code: 'INVALID' });
        return true;
      }
      sendJson(res, 200, result.record);
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }

  const id = parts[2] ?? '';
  const action = parts[3] ?? '';
  if (!id) {
    sendJson(res, 422, { error: '缺少批次 id。', code: 'INVALID' });
    return true;
  }
  if (parts.length !== 4 || method !== 'POST') {
    sendJson(res, 404, { error: '没有这个批次记录接口。', code: 'NOT_FOUND' });
    return true;
  }

  if (action === 'claim') {
    await readJsonBody(req, 256 * 1024);
    const record = plans.claim(id);
    if (!record) {
      sendJson(res, 404, { error: '没有这条批次记录（DSH 重启过？）。', code: 'NOT_FOUND' });
      return true;
    }
    sendJson(res, 200, record);
    return true;
  }

  if (action === 'record') {
    const body = (await readJsonBody(req, 256 * 1024)) as
      | { nodeId?: unknown; state?: unknown; attemptId?: unknown }
      | null;
    const result = plans.recordItem(id, body ?? {});
    if (!result) {
      sendJson(res, 404, { error: '没有这条批次记录（DSH 重启过？）。', code: 'NOT_FOUND' });
      return true;
    }
    sendJson(res, 200, result.record);
    return true;
  }

  if (action === 'finish') {
    await readJsonBody(req, 256 * 1024);
    const record = plans.finish(id);
    if (!record) {
      sendJson(res, 404, { error: '没有这条批次记录（DSH 重启过？）。', code: 'NOT_FOUND' });
      return true;
    }
    sendJson(res, 200, record);
    return true;
  }

  sendJson(res, 404, { error: '没有这个批次记录接口。', code: 'NOT_FOUND' });
  return true;
}
