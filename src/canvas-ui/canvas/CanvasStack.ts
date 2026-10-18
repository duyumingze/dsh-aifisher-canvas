/**
 * 「多选折叠成一叠」的叠内切换（v1.37）。
 *
 * 用户原话（2026-10-17，附一张叠了 3 张图的画布截图）：
 * 「给这种折叠起来的图添加一个切换按钮」。
 *
 * 背景（v1.21 那套折叠）：选中几张图 → 「折叠」把除最上面那张之外的节点**从文档里摘出来**
 * 塞进宿主节点的 `stackItems`，宿主卡后面垫两层纸，左下角一个「N 张叠图 · 展开」。
 * 问题：卡上**永远只看得见宿主那一张**，想看叠在下面的另外两张只能「展开」
 * （节点摊回画布）→ 看完再重新多选 + 折叠，来回好几趟。
 *
 * 这里的「切换」= 在**不展开**的前提下把叠在下面的某一张提成宿主卡显示：
 *   - 内容字段（标题 / 提示词 / 结果图 / 模型 / 参数 / 状态 …）与被提上来的那张**整组交换**；
 *   - 壳字段（id / 位置 / 类型 / 尺寸 / 连线）留给宿主自己 —— id 不动，所以连线、生成结果、
 *     任务队列、素材引用都还指着同一个节点；位置不动，所以切换时卡不跳；
 *   - 交换是**真的换内容**（不是只换渲染），于是 v1.34 那条口径不用破：
 *     看到什么就发什么 —— 切到第 2 张之后点生成，发出去的就是第 2 张的提示词。
 *
 * 为什么是纯函数：画布那边只有 `canvasApplication` 的 effect 够得着 `setNodes`，
 * 补丁里只留三行壳（见 scripts/vendor-aifisher.mjs 的 3.8o），算法与边界全在这里，
 * 回归可以直接在构建产物上单调它（`canvasApp.rotateStackHost`）+ 再真点一遍按钮。
 */

/** 叠图宿主/叠内条目在数据上是什么形状（画布节点是宽松对象，这里只钉我们读写的键）。 */
export interface StackNode {
  id?: string;
  x?: number;
  y?: number;
  type?: string;
  width?: number;
  height?: number;
  parentIds?: unknown;
  sourcePortIndices?: unknown;
  stackItems?: StackNode[];
  /** 这一叠里「当前显示的是第几张」（0 = 最初折叠时的宿主，越大越靠下）。 */
  stackPosition?: number;
  [key: string]: unknown;
}

/**
 * 「壳」字段：切换内容时**一律不动**。
 * id/位置/类型/连线/尺寸 属于这个节点在画布上的身份；stackItems / stackPosition 是本功能自己的账本。
 */
const SHELL_KEYS = new Set([
  'id',
  'x',
  'y',
  'type',
  'width',
  'height',
  'parentIds',
  'sourcePortIndices',
  'stackItems',
  'stackPosition',
]);

function isNodeLike(value: unknown): value is StackNode {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 叠在宿主下面的那些（老数据/脏数据一律过滤掉）。 */
export function stackItemsOf(node: StackNode): StackNode[] {
  return Array.isArray(node.stackItems) ? node.stackItems.filter(isNodeLike) : [];
}

/** 这一叠一共几张（含宿主自己）。1 = 没叠。 */
export function stackTotalOf(node: StackNode): number {
  return stackItemsOf(node).length + 1;
}

/** 当前显示的是第几张（0 基；越界/脏数据按 0 处理）。 */
export function stackPositionOf(node: StackNode): number {
  const total = stackTotalOf(node);
  const raw = Number(node.stackPosition);
  if (!Number.isFinite(raw) || raw < 1) return 0;
  return Math.trunc(raw) % total;
}

/** 「2/3」这种人看的计数（UI 与回归共用一份口径）。 */
export function stackCounterOf(node: StackNode): { position: number; total: number } {
  return { position: stackPositionOf(node) + 1, total: stackTotalOf(node) };
}

/** 只取内容字段（把壳剥掉），用于「把这张的内容搬到宿主身上」。 */
function contentFieldsOf(node: StackNode): StackNode {
  const content: StackNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (SHELL_KEYS.has(key)) continue;
    content[key] = value;
  }
  return content;
}

/**
 * 被换下去的那张：**整份拷贝**（id / 位置 / 连线都留着），只摘掉本功能自己的账本。
 * 保留 id 很重要 —— 展开时 `expand()` 靠 item.id 把节点放回文档；丢了 id 那张图就没了。
 */
function demotedCopyOf(node: StackNode): StackNode {
  const copy: StackNode = { ...node };
  delete copy.stackItems;
  delete copy.stackPosition;
  return copy;
}

/**
 * 把这一叠往前/往后拨 `step` 张（默认 +1 = 下一张，-1 = 上一张；环形）。
 *
 * 返回新的宿主节点（不改原对象）；没得拨（只有一张 / step 是整圈）时原样返回，
 * 调用方据此判断「什么都没发生」。
 */
export function rotateStackHost<T extends StackNode>(node: T, step = 1): T {
  const items = stackItemsOf(node);
  if (!items.length) return node;
  const total = items.length + 1;
  const rawStep = Number(step);
  const delta = Number.isFinite(rawStep) ? Math.trunc(rawStep) : 1;
  const offset = ((delta % total) + total) % total;
  if (offset === 0) return node;

  const promotedIndex = offset - 1;
  const promoted = items[offset - 1];
  /**
   * 环形顺序必须保住：`stackItems` 的语义是「**下一个**在前」——
   * 也就是 [下一张, 再下一张, …, 上一张]。轮转之后仍然要成立，否则
   * 先按 Shift 往回拨一次、再往前点，方向就反了（看着像「切换按钮时灵时不灵」）。
   *
   *   环： [宿主, i0, i1, …, i(n-1)]
   *   提到 i(k-1) 之后，新的「下一个」序列 = i(k), i(k+1), …, i(n-1), 旧宿主, i0, …, i(k-2)
   */
  const stackItems = [
    ...items.slice(offset),
    demotedCopyOf(node),
    ...items.slice(0, promotedIndex),
    // 叠里套叠（折叠套折叠）：里面那几张摊平接在队尾，别丢
    ...stackItemsOf(promoted),
  ];

  const next: StackNode = {
    // 内容 = 被提上来的那张
    ...contentFieldsOf(promoted),
    // 壳 = 宿主自己的
    id: node.id,
    x: node.x,
    y: node.y,
    type: node.type ?? promoted.type,
    parentIds: node.parentIds,
    sourcePortIndices: node.sourcePortIndices,
    width: node.width ?? promoted.width,
    height: node.height ?? promoted.height,
    stackItems,
    stackPosition: (stackPositionOf(node) + offset) % total,
  };
  // 老数据里没有这几个键时别硬写 undefined 进去（存盘后变成 null 更容易踩坑）
  for (const key of ['id', 'x', 'y', 'type', 'parentIds', 'sourcePortIndices', 'width', 'height']) {
    if (next[key] === undefined) delete next[key];
  }
  return next as T;
}

/** 排查读数（`__FISHERAI_CANVAS_STACK__.report()` 用）：这一叠现在长什么样。 */
export function stackReport(node: StackNode): Record<string, unknown> {
  const items = stackItemsOf(node);
  const counter = stackCounterOf(node);
  return {
    hostId: node.id ?? null,
    total: counter.total,
    position: counter.position,
    title: typeof node.title === 'string' ? node.title : null,
    resultUrl: typeof node.resultUrl === 'string' ? node.resultUrl : null,
    items: items.map((item) => ({
      id: item.id ?? null,
      title: typeof item.title === 'string' ? item.title : null,
      resultUrl: typeof item.resultUrl === 'string' ? item.resultUrl : null,
    })),
  };
}
