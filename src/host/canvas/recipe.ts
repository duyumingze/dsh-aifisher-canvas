/**
 * recipe：把结构化镜头列表一次展开成画布节点（v1.55）。
 *
 * 规划背景（2026-10-20「更智能的画布助手」）：现在「剧本 → 6 个镜头节点」要模型
 * 逐个 create，每节点一次推理 + 一次工具往返，还要自己算坐标（算错就遮罩，见 v1.53）。
 * recipe 把这种**确定性展开**搬到 host：
 *   - 输入 = 结构化 shots（title/prompt/type/model/parameters）；
 *   - 输出 = 一批标准 edit operations（create + 可选 configure）；
 *   - 画布侧只收到一条普通 edit，vendor 一行不用改。
 *
 * 排布规则（不遮罩优先）：
 *   1. 有 anchor（通常是剧本节点）→ 排到 anchor 正下方；
 *   2. 下方放不下/会碰到已有节点 → 排到已有内容右侧；
 *   3. 右侧也不行 → 内容下方；
 *   4. 空画布 → (0,0)。
 *   网格 3 列（可配 1–6），单元格 460×460，镜头之间留 40px。
 *
 * 注意：**默认不把镜头连到剧本节点**。画布的 Text→Image 连线会把上游 textContent
 * 与自身 prompt 拼在一起（见项目记忆），整段剧本会污染每个镜头的提示词；
 * anchor 只用来定排布起点，不建立连线。需要连线的场景由 agent 显式 connect。
 */
import { nodeSizeOf } from './nodePlacement';

export interface ShotPlacement {
  ref: string;
  x: number;
  y: number;
  type: string;
  title: string;
}

export interface ShotListRecipeResult {
  operations: Array<Record<string, unknown>>;
  count: number;
  placed: ShotPlacement[];
  anchorFound: boolean;
}

export interface RecipeFailure {
  error: string;
}

export const MAX_SHOTS = 24;
export const DEFAULT_COLUMNS = 3;
const CELL_WIDTH = 460;
const CELL_HEIGHT = 460;
const PLACEMENT_MARGIN = 40;

function failure(message: string): RecipeFailure {
  return { error: message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function gridOverlaps(
  startX: number,
  startY: number,
  width: number,
  height: number,
  nodes: readonly unknown[],
  gap: number,
): boolean {
  return nodes.some((raw) => {
    if (!isRecord(raw)) return false;
    const x = raw.x;
    const y = raw.y;
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    const [nodeWidth, nodeHeight] = nodeSizeOf(raw);
    return (
      startX < x + nodeWidth + gap &&
      startX + width + gap > x &&
      startY < y + nodeHeight + gap &&
      startY + height + gap > y
    );
  });
}

function chooseStart(
  nodes: readonly unknown[],
  anchor: Record<string, unknown> | undefined,
  width: number,
  height: number,
): { x: number; y: number } {
  const valid = nodes.filter(
    (raw): raw is Record<string, unknown> =>
      isRecord(raw) && typeof raw.x === 'number' && typeof raw.y === 'number',
  );
  if (valid.length === 0) return { x: 0, y: 0 };

  const gap = PLACEMENT_MARGIN;
  const left = Math.min(...valid.map((node) => node.x as number));
  const top = Math.min(...valid.map((node) => node.y as number));
  const right = Math.max(...valid.map((node) => (node.x as number) + nodeSizeOf(node)[0]));
  const bottom = Math.max(...valid.map((node) => (node.y as number) + nodeSizeOf(node)[1]));

  const candidates: Array<{ x: number; y: number }> = [];
  if (anchor) {
    candidates.push({
      x: anchor.x as number,
      y: (anchor.y as number) + nodeSizeOf(anchor)[1] + gap * 2,
    });
  }
  candidates.push({ x: right + gap * 2, y: top });
  candidates.push({ x: left, y: bottom + gap * 2 });

  for (const candidate of candidates) {
    if (!gridOverlaps(candidate.x, candidate.y, width, height, valid, gap / 2)) return candidate;
  }
  return candidates[0];
}

export function buildShotListRecipe(
  input: unknown,
  nodes: readonly unknown[],
): ShotListRecipeResult | RecipeFailure {
  if (!isRecord(input)) {
    return failure('recipe 需要对象参数，例如 {name:"shot-list", shots:[{prompt:"…"}]}。');
  }
  if (input.name !== undefined && input.name !== 'shot-list') {
    return failure(`未知 recipe：${String(input.name)}。目前只支持 shot-list。`);
  }
  const rawShots = input.shots;
  if (!Array.isArray(rawShots) || rawShots.length === 0) {
    return failure('shot-list 需要非空 shots 数组（每项至少含 prompt）。');
  }
  if (rawShots.length > MAX_SHOTS) {
    return failure(`shots 最多 ${MAX_SHOTS} 个，收到 ${rawShots.length} 个。`);
  }

  const shots: Array<{ title: string; prompt: string; type: 'Image' | 'Video'; model?: string; parameters?: Record<string, unknown> }> = [];
  for (let index = 0; index < rawShots.length; index += 1) {
    const raw = rawShots[index];
    if (!isRecord(raw)) return failure(`shots[${index}] 必须是对象。`);
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    if (!prompt) return failure(`shots[${index}] 需要非空 prompt。`);
    const type = raw.type === 'Video' ? 'Video' : 'Image';
    const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined;
    const parameters = isRecord(raw.parameters) ? { ...raw.parameters } : undefined;
    shots.push({
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `镜头 ${index + 1}`,
      prompt,
      type,
      ...(model ? { model } : {}),
      ...(parameters ? { parameters } : {}),
    });
  }

  const requestedColumns = Number(input.columns);
  const columns = Number.isFinite(requestedColumns)
    ? Math.max(1, Math.min(6, Math.trunc(requestedColumns)))
    : DEFAULT_COLUMNS;
  const rows = Math.ceil(shots.length / columns);
  const width = columns * CELL_WIDTH;
  const height = rows * CELL_HEIGHT;

  const anchorId = typeof input.anchorId === 'string' ? input.anchorId : '';
  const anchor = anchorId
    ? (nodes.find(
        (raw): raw is Record<string, unknown> =>
          isRecord(raw) && raw.id === anchorId && typeof raw.x === 'number' && typeof raw.y === 'number',
      ))
    : undefined;
  const start = chooseStart(nodes, anchor, width, height);

  const operations: Array<Record<string, unknown>> = [];
  const placed: ShotPlacement[] = [];
  shots.forEach((shot, index) => {
    const ref = `shot${index + 1}`;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = start.x + column * CELL_WIDTH;
    const y = start.y + row * CELL_HEIGHT;
    operations.push({
      kind: 'create',
      ref,
      type: shot.type,
      x,
      y,
      title: shot.title,
      prompt: shot.prompt,
    });
    if (shot.model && shot.parameters) {
      operations.push({
        kind: 'configure',
        nodeId: ref,
        model: shot.model,
        parameters: shot.parameters,
      });
    }
    placed.push({ ref, x, y, type: shot.type, title: shot.title });
  });

  return {
    operations,
    count: shots.length,
    placed,
    anchorFound: Boolean(anchor),
  };
}
