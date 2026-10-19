/**
 * `canvas_control` 的 read 结果减重。
 *
 * 背景（2026-10-20 用户反馈「用对话控制画布太慢」）：
 * 画布 read 会把每个节点整块回传 —— Text 节点带着完整正文（剧本/分镜几百字），
 * Image 节点带着 parameters JSON。一块 39 节点的画布单次 read 约 40KB，
 * 而每个工具回合模型都要重新读一遍：慢在上下文，不在画布。
 *
 * 所以默认把正文截到 240 字（够识别节点内容），保留 id/type/坐标/标题/模型/
 * 连线/分组这些**操作必须**的字段；`detail:"full"` 走原样（模型要改长文时用）。
 *
 * 注意：这里只裁**回给模型**的形状，画布侧的数据与校验都不受影响。
 */

/** 单个文本字段（prompt / textContent）默认保留的最大字符数。 */
export const READ_TEXT_LIMIT = 240;

/** digest 视图最多列出的节点条数（超出只保留统计，避免大项目撑爆上下文）。 */
export const DIGEST_NODE_LIMIT = 200;

/** 有「提示词」语义的生成类节点（Text 节点用 textContent，不走这条提示）。 */
const GENERATION_TYPES = new Set(['image', 'video', 'audio']);

export interface SummaryNode {
  id?: unknown;
  type?: string;
  title?: string;
  model?: string;
  status?: string;
  x?: unknown;
  y?: unknown;
  parentIds: string[];
  promptChars: number;
  textChars: number;
}

export interface CanvasDigest {
  counts: {
    nodes: number;
    groups: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
  };
  nodes: SummaryNode[];
  groups: Array<{ id?: unknown; label?: unknown; nodeIds: unknown[] }>;
  edgeCount: number;
  selectedNodeIds: unknown[];
  hints: string[];
  truncated?: boolean;
  hint: string;
}

/**
 * 项目摘要（v1.54）：把 read 的全量节点压成「agent 一次就能看懂项目全貌」的形状。
 *
 * 与默认 read 的区别：
 *   - 不返回节点正文/参数，只给 id/type/title/model/status/坐标/连线/promptChars/textChars；
 *   - 附带 counts（按类型/状态）、edgeCount、groups、selectedNodeIds；
 *   - 附带 hints：缺提示词、正在生成、生成失败、孤岛节点、未分组——直接告诉 agent 下一步该干嘛。
 */
export function buildCanvasDigest(result: unknown): unknown {
  const record = result as Record<string, unknown>;
  const rawNodes = Array.isArray(record.nodes) ? record.nodes : [];
  const rawGroups = Array.isArray(record.groups) ? record.groups : [];

  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const nodes: SummaryNode[] = [];
  const childIds = new Set<string>();
  let edgeCount = 0;

  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const node = raw as Record<string, unknown>;
    const type = typeof node.type === 'string' ? node.type : 'Unknown';
    byType[type] = (byType[type] ?? 0) + 1;
    const status = typeof node.status === 'string' ? node.status : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const parentIds = Array.isArray(node.parentIds)
      ? node.parentIds.filter((id): id is string => typeof id === 'string')
      : [];
    edgeCount += parentIds.length;
    for (const id of parentIds) childIds.add(id);
    if (nodes.length < DIGEST_NODE_LIMIT) {
      nodes.push({
        id: node.id,
        type,
        ...(typeof node.title === 'string' && node.title ? { title: node.title } : {}),
        ...(typeof node.model === 'string' && node.model ? { model: node.model } : {}),
        ...(typeof node.status === 'string' ? { status } : {}),
        ...(typeof node.x === 'number' ? { x: node.x } : {}),
        ...(typeof node.y === 'number' ? { y: node.y } : {}),
        parentIds,
        promptChars: typeof node.prompt === 'string' ? node.prompt.length : 0,
        textChars: typeof node.textContent === 'string' ? node.textContent.length : 0,
      });
    }
  }

  const hints: string[] = [];

  const missingPrompt = rawNodes.filter((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const node = raw as Record<string, unknown>;
    if (!GENERATION_TYPES.has(String(node.type ?? '').toLowerCase())) return false;
    const prompt = typeof node.prompt === 'string' ? node.prompt.trim() : '';
    const text = typeof node.textContent === 'string' ? node.textContent.trim() : '';
    return !prompt && !text;
  }).length;
  if (missingPrompt > 0) {
    hints.push(`${missingPrompt} 个生成节点还没有提示词，先补提示词再 prepareGeneration。`);
  }

  const loading = byStatus.loading ?? 0;
  if (loading > 0) hints.push(`有 ${loading} 个节点正在生成，等结果时不要重复提交。`);

  const failed = Object.entries(byStatus)
    .filter(([status]) => /error|fail/i.test(status))
    .reduce((sum, [, count]) => sum + count, 0);
  if (failed > 0) hints.push(`有 ${failed} 个节点生成失败，可重试或调整提示词。`);

  const island = rawNodes.filter((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const node = raw as Record<string, unknown>;
    const id = typeof node.id === 'string' ? node.id : '';
    const parentIds = Array.isArray(node.parentIds) ? node.parentIds : [];
    return Boolean(id) && parentIds.length === 0 && !childIds.has(id);
  }).length;
  if (island > 0 && rawNodes.length > 1) hints.push(`${island} 个节点是孤立节点（没有连线）。`);

  if (rawGroups.length === 0 && rawNodes.length > 2) {
    hints.push('节点还没有分组，可用 group 把相关节点收进一组。');
  }

  const digest: CanvasDigest = {
    counts: { nodes: rawNodes.length, groups: rawGroups.length, byType, byStatus },
    nodes,
    groups: rawGroups.map((raw) => {
      const group = raw as Record<string, unknown>;
      return {
        id: group.id,
        label: group.label,
        nodeIds: Array.isArray(group.nodeIds) ? group.nodeIds : [],
      };
    }),
    edgeCount,
    selectedNodeIds: Array.isArray(record.selectedNodeIds) ? record.selectedNodeIds : [],
    hints,
    hint: '这是项目摘要；要节点全文/参数请再 read 并带 view:"nodes"（detail:"full" 取全文）。',
  };
  if (rawNodes.length > DIGEST_NODE_LIMIT) digest.truncated = true;
  // 注意：不要展开 record —— read 的原始返回里 nodes 是**全量节点**（带正文/参数），
  // 展开就等于把原文又传了一遍，digest 白做。真机验证踩到过：顶层仍回传 7 个完整节点。
  return {
    ...(record.ok === true ? { ok: true } : {}),
    ...(typeof record.revision === 'string' ? { revision: record.revision } : {}),
    view: 'digest',
    digest,
  };
}

export interface SummarizeCanvasReadOptions {
  /** 不裁剪（对应工具参数 `detail:"full"`）。 */
  full?: boolean;
  /** 覆盖默认的截断长度（edit 回带的快照用更短的 160）。 */
  maxTextChars?: number;
  /** 输出项目摘要（对应工具参数 `view:"digest"`）。 */
  digest?: boolean;
}

/**
 * 把一次画布 read 结果裁成适合进模型的形状。
 *
 * - 只认 `{ok:true, nodes:[…]}`；其它形状（错误、models、assets…）原样返回；
 * - `prompt` / `textContent` 超长时截断并打 `textTruncated: true`；
 * - 顶层带 `readSummary.hint` 告诉模型「要全文就带 detail:"full"」——
 *   不写这句，模型会以为自己读到的是全部正文，改长文时只改前半段。
 */
export function summarizeCanvasRead(
  result: unknown,
  options: SummarizeCanvasReadOptions = {},
): unknown {
  const { full = false, maxTextChars = READ_TEXT_LIMIT, digest = false } = options;
  if (digest && result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (record.ok === true && Array.isArray(record.nodes)) return buildCanvasDigest(result);
  }
  if (full || !result || typeof result !== 'object') return result;
  const record = result as Record<string, unknown>;
  if (record.ok !== true || !Array.isArray(record.nodes)) return result;

  let truncated = false;
  const nodes = record.nodes.map((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const next = { ...(node as Record<string, unknown>) };
    for (const key of ['prompt', 'textContent'] as const) {
      const value = next[key];
      if (typeof value === 'string' && value.length > maxTextChars) {
        next[key] = `${value.slice(0, maxTextChars)}…`;
        next.textTruncated = true;
        truncated = true;
      }
    }
    return next;
  });

  if (!truncated) return { ...record, nodes };
  return {
    ...record,
    nodes,
    readSummary: {
      maxTextChars,
      hint: '节点正文已截断；需要读全文请再调用一次 read 并带 detail:"full"。',
    },
  };
}
