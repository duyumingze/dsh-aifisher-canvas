/**
 * 视觉一致性（v1.59，P1 第三项）：角色/画风参考节点 → 镜头节点。
 *
 * ## 做法：不发明新协议，用画布自己的「上游输入 = 参考图」
 *
 * 上游画布准备生成时，会把目标节点的**上游节点结果**当参考图（`canvasCreationControl`
 * 里 `dependencies.slice(1)` 就是 references）。所以「锁脸 / 锁服装 / 锁画风」在这套画布里的
 * 正确表达不是新参数，而是：**把定妆节点连到每个镜头节点上**。
 *
 * 于是「视觉一致性」= 一组锚点节点 + 一次确定性 connect（host 端算好，一条 edit 下发），
 * vendor 一行不用改，生成链路也完全走既有逻辑。
 *
 * ## 纯函数
 *
 * 本文件只做两件事：算「该连哪几条」（`planLockOperations`）与「现在连没连」（`coverageReport`）。
 * 真正下发给画布的是普通 `{kind:'connect'}` operation，由调用方（index.ts / canvasJob.ts）执行。
 */

/** 参与「一致性」的节点类型（镜头/画面）。 */
const SHOT_TYPES = new Set(['image', 'video']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface ShotInfo {
  id: string;
  title: string;
  type: string;
  /** 标题里解析出的镜头号（没有就 null）。 */
  number: number | null;
  x: number;
  y: number;
  parentIds: string[];
  status: string;
  hasResult: boolean;
  resultUrl?: string;
}

export interface AnchorInput {
  nodeId: string;
  title: string;
  role: string;
}

/**
 * 从标题里解析镜头号：`镜头 3` / `分镜3` / `镜 03` / `shot 3` / `Shot #3`。
 * 只认 1–3 位数字，避免把「1920x1080」之类的数字当镜头号。
 */
export function shotNumberFromTitle(title: string): number | null {
  const text = title.trim();
  if (!text) return null;
  const match =
    /(?:镜头|分镜|镜|shot|sh)[\s#:：·\-_]*(\d{1,3})/i.exec(text) ?? /^(\d{1,3})[\s.、:：)·\-_]/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function hasResult(node: Record<string, unknown>): boolean {
  return (
    (typeof node.resultUrl === 'string' && node.resultUrl.length > 0) ||
    (Array.isArray(node.resultUrls) && node.resultUrls.length > 0)
  );
}

export function shotInfoOf(raw: unknown): ShotInfo | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const type = String(raw.type ?? '');
  if (!SHOT_TYPES.has(type.toLowerCase())) return null;
  const title = typeof raw.title === 'string' && raw.title ? raw.title : id;
  const parentIds = Array.isArray(raw.parentIds)
    ? raw.parentIds.filter((value): value is string => typeof value === 'string')
    : [];
  const resultUrl =
    typeof raw.resultUrl === 'string' && raw.resultUrl
      ? raw.resultUrl
      : Array.isArray(raw.resultUrls) && typeof raw.resultUrls[0] === 'string'
        ? raw.resultUrls[0]
        : undefined;
  return {
    id,
    title,
    type,
    number: shotNumberFromTitle(title),
    x: typeof raw.x === 'number' ? raw.x : 0,
    y: typeof raw.y === 'number' ? raw.y : 0,
    parentIds,
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    hasResult: hasResult(raw),
    ...(resultUrl ? { resultUrl } : {}),
  };
}

/**
 * 按「镜头顺序」排：标题里的镜头号优先；算不出的按坐标（先上后下、先左后右）。
 *
 * 分镜板与一致性覆盖率都用这一份顺序 —— 两处不一致会让用户觉得「板子顺序和锁定顺序不一样」。
 */
export function orderShots(nodes: readonly unknown[]): ShotInfo[] {
  const shots = nodes.flatMap((raw) => {
    const info = shotInfoOf(raw);
    return info ? [info] : [];
  });
  return shots.sort((a, b) => {
    if (a.number !== null && b.number !== null) return a.number - b.number;
    if (a.number !== null) return -1;
    if (b.number !== null) return 1;
    return a.y - b.y || a.x - b.x;
  });
}

export interface ConsistencyCoverage {
  /** 锚点 + 是否还在画布上 + 是否已经有结果图（没结果的锚点连过去也锁不住）。 */
  anchors: Array<AnchorInput & { found: boolean; ready: boolean }>;
  shots: number;
  /** 每个镜头都被**全部**锚点覆盖才算 covered。 */
  covered: number;
  uncovered: Array<{ id: string; title: string; missingAnchors: string[] }>;
  /** 画布上找不到的锚点 nodeId。 */
  missingAnchors: string[];
  /** 一句话结论（注入/界面都用它）。 */
  summary: string;
}

/**
 * 覆盖率：每个镜头是否已经把**全部锚点**接成上游。
 *
 * 为什么要「全部」：角色 + 画风两个锚点时，只接角色等于画风没锁，报 100% 会误导。
 */
export function coverageReport(
  nodes: readonly unknown[],
  anchors: readonly AnchorInput[],
): ConsistencyCoverage {
  const anchorIds = new Set(anchors.map((anchor) => anchor.nodeId).filter(Boolean));
  // 锚点自己通常是 Image 节点（定妆图/画风参考），不能算成「待锁的镜头」
  const shots = orderShots(nodes).filter((shot) => !anchorIds.has(shot.id));
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of nodes) {
    if (isRecord(raw) && typeof raw.id === 'string') byId.set(raw.id, raw);
  }
  const resolved = anchors.map((anchor) => {
    const node = byId.get(anchor.nodeId);
    return {
      ...anchor,
      found: Boolean(node),
      ready: Boolean(node && hasResult(node)),
    };
  });
  const usable = resolved.filter((anchor) => anchor.found);
  const missingAnchors = resolved.filter((anchor) => !anchor.found).map((anchor) => anchor.nodeId);

  const uncovered: Array<{ id: string; title: string; missingAnchors: string[] }> = [];
  let covered = 0;
  for (const shot of shots) {
    const missing = usable
      .filter((anchor) => anchor.nodeId !== shot.id && !shot.parentIds.includes(anchor.nodeId))
      .map((anchor) => anchor.nodeId);
    if (missing.length === 0) covered += 1;
    else uncovered.push({ id: shot.id, title: shot.title, missingAnchors: missing });
  }

  const summary =
    usable.length === 0
      ? anchors.length > 0
        ? `锚点节点已不在画布上（${missingAnchors.join('、')}），一致性锁定失效。`
        : '还没有参考锚点：把角色定妆/画风参考节点设为锚点，就能跨镜头锁脸锁服装。'
      : shots.length === 0
        ? '还没有镜头节点（Image/Video），先建镜头再锁参考。'
        : covered === shots.length
          ? `${shots.length} 个镜头都已引用 ${usable.length} 个锚点，一致性已锁定。`
          : `${shots.length} 个镜头里只有 ${covered} 个引用了锚点，${uncovered.length} 个还没锁。`;

  return {
    anchors: resolved,
    shots: shots.length,
    covered,
    uncovered,
    missingAnchors,
    summary,
  };
}

export interface LockPlan {
  operations: Array<Record<string, unknown>>;
  /** 实际会连的镜头（按设定顺序）。 */
  targets: Array<{ id: string; title: string }>;
  /** 已经连上的（不需要重复下发）。 */
  already: Array<{ id: string; title: string }>;
  /** 锚点里找不到的 nodeId。 */
  missingAnchors: string[];
  /** 指定的 target 里找不到/不是镜头节点的。 */
  unknownTargets: string[];
}

/**
 * 算「把锚点接到镜头上」要下发的 connect 操作。
 *
 * - `targetIds` 省略 → 所有镜头节点（不含锚点自己）；
 * - 已经连过的不重复下发（重复 connect 会被画布判重复边，或者干脆多一条）；
 * - 只连**还在画布上**的锚点；找不到的锚点原样回报，让调用方告诉用户重新设锚。
 */
export function planLockOperations(
  nodes: readonly unknown[],
  anchors: readonly AnchorInput[],
  targetIds?: readonly string[],
): LockPlan {
  const anchorIdsAll = new Set(anchors.map((anchor) => anchor.nodeId).filter(Boolean));
  const shots = orderShots(nodes).filter((shot) => !anchorIdsAll.has(shot.id));
  const shotById = new Map(shots.map((shot) => [shot.id, shot]));
  const allById = new Map<string, Record<string, unknown>>();
  for (const raw of nodes) {
    if (isRecord(raw) && typeof raw.id === 'string') allById.set(raw.id, raw);
  }
  const usableAnchors = anchors.filter(
    (anchor) => anchor.nodeId && allById.has(anchor.nodeId),
  );
  const missingAnchors = anchors
    .filter((anchor) => !allById.has(anchor.nodeId))
    .map((anchor) => anchor.nodeId);

  const anchorIds = new Set(usableAnchors.map((anchor) => anchor.nodeId));
  const wanted = Array.isArray(targetIds) && targetIds.length > 0 ? targetIds : shots.map((shot) => shot.id);
  const unknownTargets: string[] = [];
  const targets: Array<{ id: string; title: string }> = [];
  for (const id of wanted) {
    const shot = shotById.get(id);
    if (!shot || anchorIds.has(id)) {
      unknownTargets.push(id);
      continue;
    }
    targets.push({ id: shot.id, title: shot.title });
  }

  const operations: Array<Record<string, unknown>> = [];
  const already: Array<{ id: string; title: string }> = [];
  for (const target of targets) {
    const shot = shotById.get(target.id);
    if (!shot) continue;
    let allPresent = true;
    for (const anchor of usableAnchors) {
      if (shot.parentIds.includes(anchor.nodeId)) continue;
      allPresent = false;
      operations.push({ kind: 'connect', sourceId: anchor.nodeId, targetId: target.id });
    }
    if (allPresent && usableAnchors.length > 0) already.push(target);
  }

  return { operations, targets, already, missingAnchors, unknownTargets };
}

/** 解锁：把锚点与镜头之间的连线断开（只断这几条，不动别的连线）。 */
export function planUnlockOperations(
  nodes: readonly unknown[],
  anchors: readonly AnchorInput[],
  targetIds?: readonly string[],
): LockPlan {
  const anchorIdsAll = new Set(anchors.map((anchor) => anchor.nodeId).filter(Boolean));
  const shots = orderShots(nodes).filter((shot) => !anchorIdsAll.has(shot.id));
  const shotById = new Map(shots.map((shot) => [shot.id, shot]));
  const anchorIds = new Set(anchors.map((anchor) => anchor.nodeId).filter(Boolean));
  const wanted = Array.isArray(targetIds) && targetIds.length > 0 ? targetIds : shots.map((shot) => shot.id);
  const operations: Array<Record<string, unknown>> = [];
  const targets: Array<{ id: string; title: string }> = [];
  const unknownTargets: string[] = [];
  for (const id of wanted) {
    const shot = shotById.get(id);
    if (!shot || anchorIds.has(id)) {
      unknownTargets.push(id);
      continue;
    }
    targets.push({ id: shot.id, title: shot.title });
    for (const anchorId of shot.parentIds) {
      if (!anchorIds.has(anchorId)) continue;
      operations.push({ kind: 'disconnect', sourceId: anchorId, targetId: shot.id });
    }
  }
  return { operations, targets, already: [], missingAnchors: [], unknownTargets };
}
