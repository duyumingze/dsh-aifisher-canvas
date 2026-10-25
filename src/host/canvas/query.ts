/**
 * 定向查询（v1.69，画布助手 P3 第二项）：只取「这一小块」画布，不读整张。
 *
 * ## 为什么要有这一层
 *
 * `read` 是整张画布：几十个节点时它回的是几十条正文（截断后也有几 KB），
 * 而 Agent 常常只想知道「这个镜头的上游是什么」「有没有叫『雨棚』的节点」。
 * 每次为这点信息付整张画布的上下文，长链路（job / intent / crew）最先撞这堵墙。
 *
 * 所以这里在 **host 侧**做纯函数查询：一次 `read` 拿到节点（毫秒级、不经过模型），
 * 再用 `query` 只把命中的几条 + 它们之间的连线交给模型。画布协议不变。
 *
 * ## 查询方式
 *
 * - 按节点取邻域：`{nodeId, path:"self"|"upstream"|"downstream"|"connected", depth?:1-3}`；
 * - 按关键词/类型找节点：`{keyword?, type?}`（标题、提示词、正文都参与匹配）；
 * - 分页：`page` / `pageSize`（默认 20、上限 50），大项目也只回一页。
 *
 * 借鉴与边界：思路来自外部开源项目 infinite-canvas（AGPL-3.0）把画布工具拆成
 * `get_node` / `get_upstream_nodes` / `get_downstream_nodes` / `query_canvas_nodes` 的做法；
 * 代码是这里自己写的纯函数，没有复制其源码。
 */

/** 返回给模型的提示词/正文截断长度（要全文请 `read detail:"full"`）。 */
export const QUERY_PROMPT_LIMIT = 160;
export const QUERY_DEFAULT_PAGE_SIZE = 20;
export const QUERY_MAX_PAGE_SIZE = 50;
export const QUERY_MAX_DEPTH = 3;

export type QueryPath = 'self' | 'upstream' | 'downstream' | 'connected';
const QUERY_PATHS: readonly QueryPath[] = ['self', 'upstream', 'downstream', 'connected'];

export interface QueryNodeSummary {
  id: string;
  type: string;
  title?: string;
  model?: string;
  status?: string;
  x?: number;
  y?: number;
  parentIds: string[];
  childIds: string[];
  promptChars: number;
  textChars: number;
  hasResult: boolean;
  /** 提示词/正文的前 160 字（要全文用 read detail:"full"）。 */
  excerpt?: string;
  /** 按节点取邻域时标出这条是怎么被带进来的。 */
  role?: 'root' | 'upstream' | 'downstream' | 'related';
  depth?: number;
}

export interface QueryResult {
  nodes: QueryNodeSummary[];
  /** 返回节点之间的连线（只含两端都在结果里的边）。 */
  edges: Array<{ from: string; to: string }>;
  total: number;
  page: number;
  pageSize: number;
  matchedBy: 'node' | 'keyword';
  hint: string;
  truncated?: boolean;
}

export interface QueryError {
  error: string;
  code: 'NOT_FOUND' | 'INVALID';
}

export type QueryOutcome = QueryResult | QueryError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function parentIdsOf(node: Record<string, unknown>): string[] {
  return Array.isArray(node.parentIds)
    ? node.parentIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : [];
}

function hasResult(node: Record<string, unknown>): boolean {
  return (
    (typeof node.resultUrl === 'string' && node.resultUrl.length > 0) ||
    (Array.isArray(node.resultUrls) && node.resultUrls.length > 0)
  );
}

function excerptOf(node: Record<string, unknown>): string | undefined {
  const source =
    typeof node.prompt === 'string' && node.prompt.trim()
      ? node.prompt
      : typeof node.textContent === 'string'
        ? node.textContent
        : '';
  const flat = source.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > QUERY_PROMPT_LIMIT ? `${flat.slice(0, QUERY_PROMPT_LIMIT - 1)}…` : flat;
}

/**
 * 在画布节点上跑一次定向查询。
 *
 * `nodes` 就是画布 `read` 回的 `nodes` 数组；本函数不碰 I/O，回归里可以直接喂假节点。
 */
export function queryCanvas(nodes: readonly unknown[], input: unknown): QueryOutcome {
  const params = isRecord(input) ? input : {};
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of nodes) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id) byId.set(id, raw);
  }
  const childIdsOf = new Map<string, string[]>();
  for (const [id, node] of byId) {
    for (const parentId of parentIdsOf(node)) {
      const list = childIdsOf.get(parentId) ?? [];
      list.push(id);
      childIdsOf.set(parentId, list);
    }
  }

  const page = boundedInt(params.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const pageSize = boundedInt(params.pageSize, 1, QUERY_MAX_PAGE_SIZE, QUERY_DEFAULT_PAGE_SIZE);

  const summaryOf = (raw: Record<string, unknown>, extra: Partial<QueryNodeSummary> = {}): QueryNodeSummary | null => {
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) return null;
    const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
    const text = typeof raw.textContent === 'string' ? raw.textContent : '';
    const excerpt = excerptOf(raw);
    return {
      id,
      type: typeof raw.type === 'string' ? raw.type : 'Unknown',
      ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
      ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
      ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
      ...(typeof raw.x === 'number' ? { x: raw.x } : {}),
      ...(typeof raw.y === 'number' ? { y: raw.y } : {}),
      parentIds: parentIdsOf(raw),
      childIds: [...(childIdsOf.get(id) ?? [])],
      promptChars: prompt.length,
      textChars: text.length,
      hasResult: hasResult(raw),
      ...(excerpt ? { excerpt } : {}),
      ...extra,
    };
  };

  const buildEdges = (list: readonly QueryNodeSummary[]): Array<{ from: string; to: string }> => {
    const present = new Set(list.map((item) => item.id));
    const edges: Array<{ from: string; to: string }> = [];
    for (const item of list) {
      for (const parentId of item.parentIds) {
        if (present.has(parentId)) edges.push({ from: parentId, to: item.id });
      }
    }
    return edges;
  };

  const paginate = (
    list: QueryNodeSummary[],
    matchedBy: QueryResult['matchedBy'],
    hint: string,
  ): QueryResult => {
    const total = list.length;
    const start = (page - 1) * pageSize;
    const slice = list.slice(start, start + pageSize);
    const result: QueryResult = {
      nodes: slice,
      edges: buildEdges(slice),
      total,
      page,
      pageSize,
      matchedBy,
      hint,
    };
    if (start + slice.length < total) {
      result.truncated = true;
      result.hint = `${hint} 还有 ${total - start - slice.length} 条没返回：带 page:${page + 1} 取下一页，或缩小 pageSize 看重点是哪些。`;
    }
    return result;
  };

  // ---------------------------------------------------------------- 按节点取邻域
  const rootId = typeof params.nodeId === 'string' ? params.nodeId.trim() : '';
  if (rootId) {
    const root = byId.get(rootId);
    if (!root) {
      return {
        error: `画布上没有节点 ${rootId}。先 read（或 action:"query" 带 keyword）拿真实 id。`,
        code: 'NOT_FOUND',
      };
    }
    const rawPath = typeof params.path === 'string' ? params.path.trim() : 'self';
    const path = (QUERY_PATHS as readonly string[]).includes(rawPath) ? (rawPath as QueryPath) : null;
    if (!path) {
      return { error: `path 只能是 ${QUERY_PATHS.join(' / ')}。`, code: 'INVALID' };
    }
    const depth = path === 'self' ? 0 : boundedInt(params.depth, 1, QUERY_MAX_DEPTH, 1);
    const roleOf = new Map<string, { role: QueryNodeSummary['role']; depth: number }>();
    const rootSummary = summaryOf(root, { role: 'root', depth: 0 });
    if (!rootSummary) return { error: '根节点缺少 id。', code: 'INVALID' };
    roleOf.set(rootSummary.id, { role: 'root', depth: 0 });

    // 广度优先：每一跳按方向取父/子
    let frontier = [rootSummary.id];
    for (let step = 1; step <= depth; step += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const node = byId.get(id);
        if (!node) continue;
        const parents = path === 'downstream' ? [] : parentIdsOf(node);
        const children = path === 'upstream' ? [] : (childIdsOf.get(id) ?? []);
        for (const candidate of [...parents, ...children]) {
          if (roleOf.has(candidate)) continue;
          roleOf.set(candidate, {
            role: path === 'upstream' || path === 'downstream' ? (path as QueryNodeSummary['role']) : 'related',
            depth: step,
          });
          next.push(candidate);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    const list: QueryNodeSummary[] = [];
    for (const [id, meta] of roleOf) {
      const node = byId.get(id);
      if (!node) continue;
      const summary = summaryOf(node, { role: meta.role, depth: meta.depth });
      if (summary) list.push(summary);
    }
    // 根在前，其余按深度、再按标题/坐标稳定排序，保证多次查询顺序一致
    list.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.id.localeCompare(b.id));
    return paginate(
      list,
      'node',
      path === 'self'
        ? '这是节点本身；要上游/下游再带 path:"upstream" | "downstream"（depth 1-3）。'
        : `邻域按 ${path} 方向取了 ${depth} 跳；连线只列两端都在结果里的。`,
    );
  }

  // ---------------------------------------------------------------- 按关键词/类型
  const keyword = typeof params.keyword === 'string' ? params.keyword.trim().toLowerCase() : '';
  const wantedType = typeof params.type === 'string' ? params.type.trim().toLowerCase() : '';
  const list: QueryNodeSummary[] = [];
  for (const [id, node] of byId) {
    const type = typeof node.type === 'string' ? node.type : '';
    if (wantedType && type.toLowerCase() !== wantedType) continue;
    if (keyword) {
      const haystack = [
        typeof node.title === 'string' ? node.title : '',
        typeof node.prompt === 'string' ? node.prompt : '',
        typeof node.textContent === 'string' ? node.textContent : '',
        id,
      ]
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(keyword)) continue;
    }
    const summary = summaryOf(node);
    if (summary) list.push(summary);
  }
  list.sort(
    (a, b) => (b.y ?? 0) - (a.y ?? 0) || (a.x ?? 0) - (b.x ?? 0) || a.id.localeCompare(b.id),
  );
  return paginate(
    list,
    'keyword',
    keyword || wantedType
      ? `按${keyword ? `关键词「${keyword}」` : ''}${wantedType ? `${keyword ? ' + ' : ''}类型 ${wantedType}` : ''}匹配到 ${list.length} 个节点。`
      : `画布上共 ${list.length} 个节点（分页返回）。要全文用 read detail:"full"。`,
  );
}
