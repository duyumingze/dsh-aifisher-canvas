/**
 * 主动副驾（v1.59，P1 第四项）：在用户看得见的地方「安静待命」的建议引擎。
 *
 * ## 设计原则（用户认可的路线图里写明）
 *
 * - **低打扰**：只给 3–5 条、每条一句话；界面默认收起成一个小胶囊，不弹窗、不抢焦点；
 * - **可关**：界面上能彻底关掉（偏好存 localStorage），关掉之后画布不再出这个入口；
 * - **说人话**：建议面向「下一步做什么」，不是把 digest 的 hints 原样抛出来；
 * - **不花钱**：任何建议都不自动提交生成 —— 涉及生成的建议只是提示用户去和助手说，
 *   审批红线不动（确认费用永远由人点）。
 *
 * ## 为什么放 host
 *
 * 建议要用到「生成批次状态、项目记忆、一致性锚点、任务队列」这些 host 才有的东西；
 * 画布页面只负责显示（GET /copilot）。纯函数在这里，HTTP 与 UI 都只做搬运。
 */
import { coverageReport, orderShots, type AnchorInput } from './consistency';
import type { MemoryEntry, ProjectMemoryBlock } from './projectMemory';

export type SuggestionLevel = 'high' | 'medium' | 'low';

export interface CopilotSuggestion {
  /** 稳定 id（同一个问题每次算出同一个 id，界面不会闪）。 */
  id: string;
  level: SuggestionLevel;
  title: string;
  detail: string;
  /** 建议用户对助手说的一句话（界面上的「问助手」按钮用它）。 */
  ask?: string;
}

export interface CopilotInput {
  nodes: readonly unknown[];
  memory: ProjectMemoryBlock;
  /** 当前项目里还没结束的生成批次数（vendor 的 pending/running）。 */
  openBatches?: number;
  /** 任务队列里正在跑的任务数。 */
  runningTasks?: number;
  /** 正在跑的长任务（job）。 */
  openJobs?: Array<{ id: string; name: string; state: string }>;
}

const LEVEL_ORDER: Record<SuggestionLevel, number> = { high: 0, medium: 1, low: 2 };

/** 一次最多给几条（多了就变成噪音，与「低打扰」相反）。 */
export const MAX_SUGGESTIONS = 5;

function hasPrompt(node: Record<string, unknown>): boolean {
  const prompt = typeof node.prompt === 'string' ? node.prompt.trim() : '';
  const text = typeof node.textContent === 'string' ? node.textContent.trim() : '';
  return Boolean(prompt || text);
}

function isFailed(node: Record<string, unknown>): boolean {
  const status = String(node.status ?? '').toLowerCase();
  return status.includes('error') || status.includes('fail');
}

/**
 * 从画布现状 + 项目记忆算出建议。
 *
 * 顺序：失败 > 缺提示词 > 一致性 > 记忆空白 > 孤立节点 > 未分组。
 * 每条都带「对助手说什么」，因为绝大多数下一步其实是「让助手去做」。
 */
export function buildCopilotSuggestions(input: CopilotInput): CopilotSuggestion[] {
  const nodes = input.nodes.filter(
    (raw): raw is Record<string, unknown> =>
      Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw),
  );
  const generationNodes = nodes.filter((node) =>
    ['image', 'video', 'audio'].includes(String(node.type ?? '').toLowerCase()),
  );
  const suggestions: CopilotSuggestion[] = [];

  const failed = generationNodes.filter((node) => isFailed(node));
  if (failed.length > 0) {
    const titles = failed
      .slice(0, 3)
      .map((node) => String(node.title ?? node.id ?? ''))
      .filter(Boolean);
    suggestions.push({
      id: 'failed-nodes',
      level: 'high',
      title: `${failed.length} 个节点生成失败`,
      detail: `${titles.join('、')}${failed.length > 3 ? ' 等' : ''} 没出结果。可以让助手先看错误码，再决定换模型还是改提示词。`,
      ask: `有 ${failed.length} 个节点生成失败了，帮我看看错误原因并重新准备生成。`,
    });
  }

  const missingPrompt = generationNodes.filter((node) => !hasPrompt(node));
  if (missingPrompt.length > 0) {
    const titles = missingPrompt
      .slice(0, 3)
      .map((node) => String(node.title ?? node.id ?? ''))
      .filter(Boolean);
    suggestions.push({
      id: 'missing-prompt',
      level: 'medium',
      title: `${missingPrompt.length} 个节点还没有提示词`,
      detail: `${titles.join('、')}${missingPrompt.length > 3 ? ' 等' : ''} 是空的，先生成会得到随机结果。`,
      ask: `帮我把没有提示词的节点按项目风格补上提示词。`,
    });
  }

  const anchors: AnchorInput[] = input.memory.anchors.map((anchor) => ({
    nodeId: anchor.nodeId,
    title: anchor.title,
    role: anchor.role,
  }));
  const coverage = coverageReport(nodes, anchors);
  if (anchors.length === 0 && coverage.shots >= 2) {
    suggestions.push({
      id: 'no-anchors',
      level: 'low',
      title: '还没有参考锚点',
      detail: '多个镜头要同一个人/同一套画风时，把定妆图设为锚点并锁到镜头上，能少很多重抽。',
      ask: '帮我把这个项目里的角色定妆节点设为参考锚点，并锁到所有镜头节点上。',
    });
  } else if (anchors.length > 0 && coverage.uncovered.length > 0) {
    suggestions.push({
      id: 'consistency-gap',
      level: 'medium',
      title: `${coverage.uncovered.length} 个镜头没有引用锚点`,
      detail: coverage.summary,
      ask: '帮我把参考锚点接到还没锁定的镜头节点上，保持角色和画风一致。',
    });
  }

  const remembered = input.memory.entries.some(
    (entry: MemoryEntry) => entry.kind === 'style' || entry.kind === 'character',
  );
  if (!remembered && nodes.length >= 3) {
    suggestions.push({
      id: 'memory-empty',
      level: 'low',
      title: '项目风格还没记下来',
      detail: '把画风、角色、常用模型记进项目记忆后，新开对话不用再交代一遍。',
      ask: '这个项目的画风和角色设定是什么？帮我记进项目记忆。',
    });
  }

  const ids = new Set(nodes.map((node) => String(node.id ?? '')));
  const parentOf = new Set<string>();
  for (const node of nodes) {
    const parents = Array.isArray(node.parentIds) ? node.parentIds : [];
    for (const parent of parents) if (typeof parent === 'string') parentOf.add(parent);
  }
  const islands = nodes.filter((node) => {
    const id = String(node.id ?? '');
    const parents = Array.isArray(node.parentIds) ? node.parentIds : [];
    return id && parents.length === 0 && !parentOf.has(id);
  });
  if (islands.length >= 2 && nodes.length > 2) {
    suggestions.push({
      id: 'islands',
      level: 'low',
      title: `${islands.length} 个节点是孤立的`,
      detail: '没有连线也没有被引用；如果是同一组镜头，可以用分组或连线理一下顺序。',
      ask: '帮我把画布上的孤立节点整理一下（分组或连线）。',
    });
  }

  if (Array.isArray(input.openJobs) && input.openJobs.length > 0) {
    const job = input.openJobs[0]!;
    suggestions.push({
      id: `job-${job.id}`,
      level: 'medium',
      title: `长任务在进行：${job.name}`,
      detail:
        job.state === 'awaiting-approval'
          ? '批次已经准备好，等你在右下角点「确认本批生成与费用」。'
          : '正在等生成结果；失败会自动准备重试批次。',
    });
  }

  return suggestions
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    .slice(0, MAX_SUGGESTIONS);
}

/** 一句话摘要（状态条/诊断用）。 */
export function copilotSummary(suggestions: readonly CopilotSuggestion[]): string {
  if (suggestions.length === 0) return '画布状态正常，没有需要提醒的事。';
  const high = suggestions.filter((item) => item.level === 'high').length;
  return high > 0
    ? `${suggestions.length} 条建议，其中 ${high} 条要马上处理。`
    : `${suggestions.length} 条建议（不紧急，按需处理）。`;
}

/** 分镜板/副驾共用的镜头顺序（导出给测试直接比对）。 */
export function orderedShotIds(nodes: readonly unknown[]): string[] {
  return orderShots(nodes).map((shot) => shot.id);
}
