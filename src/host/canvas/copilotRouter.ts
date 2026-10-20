/**
 * 画布助手 P1 的 HTTP 面（v1.59）：项目记忆 / 参考锚点 / 主动副驾 / 长任务。
 *
 * ## 为什么单独一个路由文件
 *
 * 这些能力都是「host 有数据、界面要读」：记忆在 `canvas-memory.json`，长任务在进程内，
 * 副驾建议是由两者 + 画布现状算出来的。放在 restRouter 里会让那个文件继续膨胀
 * （它已经 650 行），单独一块也方便回归直接打 HTTP。
 *
 * ## 端点（都在 `/api/aifisher/canvas` 下）
 *
 *   GET    /memory?projectId=…                 读某个项目的记忆 + 锚点
 *   POST   /memory  {projectId, kind, text, key?, importance?}  写一条（同 key 原地更新）
 *   DELETE /memory/:id?projectId=…             删一条
 *   PUT    /memory/anchors {projectId, anchors} 整体替换参考锚点
 *   GET    /copilot?projectId=…&live=1         副驾建议 + 记忆摘要 + 一致性覆盖率 + 进行中的长任务
 *                                              （`live=1` 才读活画布，默认读磁盘文档：后台轮询不许阻塞）
 *   GET    /jobs?projectId=…                   长任务列表
 *   GET    /jobs/:id                           单个长任务
 *   POST   /jobs/:id/cancel                    取消一个长任务
 *
 * 所有写接口都做同源检查（沿用 restRouter 的 rejectCrossOrigin）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, rejectCrossOrigin, sendJson } from '../http/httpUtil';
import type { CanvasStore } from './store';
import { buildCopilotSuggestions, copilotSummary } from './copilot';
import { coverageReport, type AnchorInput } from './consistency';
import type { CanvasJobs } from './canvasJob';
import type { GenerationPlans } from './generationPlans';
import type { ProjectMemory } from './projectMemory';

export interface CopilotApiDeps {
  memory: ProjectMemory;
  jobs: CanvasJobs;
  store: CanvasStore;
  plans?: GenerationPlans;
  /** 读当前打开的画布节点（优先于磁盘文档；拿不到返回 null）。 */
  liveNodes?: () => Promise<unknown[] | null>;
}

interface Parts {
  parts: string[];
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
}

function projectIdOf(source: Record<string, unknown> | URLSearchParams): string {
  const value =
    source instanceof URLSearchParams ? source.get('projectId') : source.projectId;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 画布节点：`live` 时优先读活的画布（刚建的节点也看得到），退回最近一次保存的文档。
 *
 * ⚠️ 默认**不**问活画布：`GET /copilot` 是界面每 30s 的后台轮询，
 * 问活画布要走 bridge 长轮询（页面不在轮询时要等满超时）。2026-10-20 真机检查里
 * 就是这一下把页面卡了 5s（headless 的虚拟时间在等这个 fetch）→ 探针一条都发不出去。
 * 所以：后台轮询读磁盘文档，只有用户真打开面板 / 真点锚点时才 `live=1`。
 */
async function nodesFor(projectId: string, deps: CopilotApiDeps, live = false): Promise<unknown[]> {
  if (live && deps.liveNodes) {
    try {
      const live = await deps.liveNodes();
      if (Array.isArray(live) && live.length > 0) return live;
    } catch {
      /* 画布没开/超时：退回磁盘文档 */
    }
  }
  const document = projectId ? deps.store.getDocument(projectId) : null;
  return document && Array.isArray(document.nodes) ? document.nodes : [];
}

async function anchorInputs(projectId: string, deps: CopilotApiDeps): Promise<AnchorInput[]> {
  return deps.memory.get(projectId).anchors.map((anchor) => ({
    nodeId: anchor.nodeId,
    title: anchor.title,
    role: anchor.role,
  }));
}

async function handleMemory(context: Parts, deps: CopilotApiDeps): Promise<boolean> {
  const { parts, method, url, req, res } = context;

  // /memory —— GET 读、POST 写
  if (parts.length === 1) {
    if (method === 'GET') {
      const projectId = projectIdOf(url.searchParams);
      if (!projectId) {
        sendJson(res, 422, { error: '缺少 projectId。', code: 'MISSING_PROJECT_ID' });
        return true;
      }
      sendJson(res, 200, deps.memory.get(projectId));
      return true;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req, 256 * 1024)) as Record<string, unknown> | null;
      const projectId = projectIdOf(body ?? {});
      if (!projectId) {
        sendJson(res, 422, { error: '缺少 projectId。', code: 'MISSING_PROJECT_ID' });
        return true;
      }
      const entry = await deps.memory.upsert(projectId, body ?? {});
      if (!entry) {
        sendJson(res, 422, {
          error: '记忆需要非空 text（kind 取 style/character/model/param/rule/note）。',
          code: 'INVALID_MEMORY',
        });
        return true;
      }
      sendJson(res, 200, { ok: true, projectId, entry });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  // PUT /memory/anchors
  if (parts[1] === 'anchors') {
    if (method !== 'PUT' && method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const body = (await readJsonBody(req, 256 * 1024)) as Record<string, unknown> | null;
    const projectId = projectIdOf(body ?? {});
    if (!projectId) {
      sendJson(res, 422, { error: '缺少 projectId。', code: 'MISSING_PROJECT_ID' });
      return true;
    }
    const anchors = Array.isArray(body?.anchors)
      ? (body.anchors as Array<{ nodeId?: unknown; title?: unknown; role?: unknown }>)
      : null;
    if (!anchors) {
      sendJson(res, 422, { error: 'anchors 必须是数组。', code: 'INVALID_ANCHORS' });
      return true;
    }
    const nodes = await nodesFor(projectId, deps, true);
    const known = new Set(
      nodes.flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const id = (raw as { id?: unknown }).id;
        return typeof id === 'string' ? [id] : [];
      }),
    );
    const saved = await deps.memory.setAnchors(projectId, anchors, known.size > 0 ? known : undefined);
    if (!saved) {
      sendJson(res, 422, { error: '没有可保存的锚点（nodeId 不在当前项目里？）。', code: 'INVALID_ANCHORS' });
      return true;
    }
    // 传了锚点却一个都没留下 = 全是幽灵 id：明确拒绝，别让界面以为「设置成功但列表空了」
    if (saved.length === 0 && anchors.length > 0) {
      sendJson(res, 422, {
        error: '这些 nodeId 不在当前项目里（锚点必须指向画布上真实存在的节点）。',
        code: 'INVALID_ANCHORS',
      });
      return true;
    }
    sendJson(res, 200, { ok: true, projectId, anchors: saved });
    return true;
  }

  // DELETE /memory/:id?projectId=
  if (method === 'DELETE' && parts.length === 2) {
    const projectId = projectIdOf(url.searchParams);
    const removed = projectId ? await deps.memory.remove(projectId, parts[1]!) : false;
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: '没有这条记忆。', code: 'NOT_FOUND' });
    return true;
  }

  sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
  return true;
}

async function handleCopilot(context: Parts, deps: CopilotApiDeps): Promise<boolean> {
  const { method, url, res } = context;
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const projectId = projectIdOf(url.searchParams);
  if (!projectId) {
    sendJson(res, 422, { error: '缺少 projectId。', code: 'MISSING_PROJECT_ID' });
    return true;
  }
  // `live=1` 才问活画布（见 nodesFor 的说明）；后台轮询走磁盘文档，绝不阻塞界面。
  const live = url.searchParams.get('live') === '1';
  const [nodes, memory, anchors] = await Promise.all([
    nodesFor(projectId, deps, live),
    Promise.resolve(deps.memory.get(projectId)),
    anchorInputs(projectId, deps),
  ]);
  const openJobs = deps.jobs
    .list(projectId)
    .filter((job) => job.state === 'running' || job.state === 'awaiting-approval' || job.state === 'waiting')
    .map((job) => ({ id: job.id, name: job.name, state: job.state }));
  const openBatches = deps.plans
    ? (deps.plans.list(projectId) as Array<{ state?: string }>).filter(
        (plan) => plan.state === 'pending' || plan.state === 'running',
      ).length
    : 0;
  const suggestions = buildCopilotSuggestions({ nodes, memory, openBatches, openJobs });
  const coverage = coverageReport(nodes, anchors);
  sendJson(res, 200, {
    ok: true,
    projectId,
    nodes: nodes.length,
    suggestions,
    summary: copilotSummary(suggestions),
    memory: {
      entries: memory.entries,
      anchors: memory.anchors,
      updatedAt: memory.updatedAt,
    },
    consistency: {
      shots: coverage.shots,
      covered: coverage.covered,
      uncovered: coverage.uncovered.length,
      missingAnchors: coverage.missingAnchors.length,
      summary: coverage.summary,
    },
    openBatches,
    jobs: openJobs,
  });
  return true;
}

async function handleJobs(context: Parts, deps: CopilotApiDeps): Promise<boolean> {
  const { parts, method, url, res } = context;
  if (parts.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const projectId = projectIdOf(url.searchParams);
    sendJson(res, 200, { ok: true, jobs: deps.jobs.list(projectId || undefined) });
    return true;
  }
  const job = deps.jobs.get(parts[1]!);
  if (!job) {
    sendJson(res, 404, { error: '没有这个长任务（DSH 重启过？）。', code: 'NOT_FOUND' });
    return true;
  }
  if (method === 'GET') {
    sendJson(res, 200, { ok: true, job });
    return true;
  }
  if (method === 'POST' && parts[2] === 'cancel') {
    const cancelled = deps.jobs.cancel(parts[1]!);
    sendJson(res, 200, { ok: true, job: cancelled ?? job });
    return true;
  }
  sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
  return true;
}

export async function handleCopilotApi(
  input: {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    parts: string[];
    deps: CopilotApiDeps;
  },
): Promise<boolean> {
  const { req, res, url, parts, deps } = input;
  const method = (req.method ?? 'GET').toUpperCase();
  if (!parts[0]) return false;
  if (parts[0] !== 'memory' && parts[0] !== 'copilot' && parts[0] !== 'jobs') return false;
  if (rejectCrossOrigin(req, res)) return true;
  const context: Parts = { parts, method, url, req, res };
  try {
    if (parts[0] === 'memory') return await handleMemory(context, deps);
    if (parts[0] === 'copilot') return await handleCopilot(context, deps);
    return await handleJobs(context, deps);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : '画布助手数据处理失败',
        code: 'COPILOT_ROUTE_FAILED',
      });
    }
    return true;
  }
}
