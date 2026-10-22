/**
 * 意图编译器（v1.63，画布助手 P2 第一项）。
 *
 * 背景：P0 给了「感知(digest)/规划(recipe)/执行/反馈」，P1 给了记忆层。但仍然要模型
 * 自己把「一句话意图」翻译成 shots[]：数镜头、切句、拼风格串、补光/质感/限制、
 * 决定 image 还是 video、挂参数 —— 每一次翻译都靠一次推理，且同一个 brief 两次结果不一样。
 *
 * 这个模块把翻译搬到 host，做成**纯函数**：
 *   brief（自然语言）+ 项目记忆/资产库 → 结构化 shot list（确定性、可复现）
 *
 * 设计口径：
 *   1. 只做「可判定」的翻译：镜头数、画幅、时长、类型都从明确线索里取，取不到用保守默认；
 *   2. 不编造画面内容：brief 里的句子是唯一内容来源；句子不够时如实少出镜头并写 missing；
 *   3. 风格与锁定串来自项目记忆/资产库（显式入参优先），每镜逐字复用 —— 这是文字层的一致性；
 *   4. 质量锚点与限制是固定串，可用入参覆盖，但不会随 brief 漂移；
 *   5. 参数只在给了 model 时才挂：recipe 的 configure 需要 model+parameters 同时给，
 *      单给 parameters 会被忽略（见 docs/canvas-agent-contract.md 第 3 节）。
 */

export const MAX_INTENT_SHOTS = 24;
const MAX_PROMPT_CHARS = 1200;
const MAX_TITLE_BEAT_CHARS = 14;

/** 固定串：质感锚点（与 project 里 canvas-shots/v1 契约同一口径，短版）。 */
export const DEFAULT_QUALITY_ANCHOR = '画面清晰锐利，影调层次分明，材质细节自然，无塑料感与过曝';
/** 固定串：画面内限制（陈述式，不用负向清单：Flux 系模型不吃负向提示词）。 */
export const DEFAULT_LIMIT_CLAUSE = '画面内不出现文字与水印，主体结构完整';

const CN_NUMBERS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16,
};

export interface IntentShot {
  title: string;
  prompt: string;
  type: 'Image' | 'Video';
  model?: string;
  parameters?: Record<string, unknown>;
}

export interface IntentPlan {
  brief: string;
  shots: IntentShot[];
  count: number;
  requestedShots: number | null;
  beats: number;
  style: string;
  locks: string[];
  constraints: string[];
  type: 'Image' | 'Video';
  aspectRatio: string | null;
  duration: number | null;
  columns: number;
  notes: string[];
  missing: string[];
}

export interface IntentContext {
  /** 项目记忆里的风格条目（kind=style）。 */
  style?: readonly string[];
  /** 项目记忆里的角色条目（kind=character），作为锁定串。 */
  characters?: readonly string[];
  /** 项目记忆里的规则条目（kind=rule），作为约束串。 */
  rules?: readonly string[];
  /** 资产库里的锁定串（角色/场景/道具/画风）。 */
  locks?: readonly string[];
}

export interface IntentOptions {
  /** 每镜是否带资产/角色锁定串，默认 true。 */
  includeLocks?: boolean;
  /** 覆盖默认质感锚点。 */
  qualityAnchor?: string;
  /** 覆盖默认限制串。 */
  limitClause?: string;
}

type Failure = { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clipTitle(beat: string): string {
  const flat = beat
    .replace(/[\s"“”'‘’《》【】\[\]（）()]+/g, ' ')
    .replace(/[。！？；，、,.!?;:：]+$/g, '')
    .trim();
  if (!flat) return '画面';
  return flat.length > MAX_TITLE_BEAT_CHARS ? `${flat.slice(0, MAX_TITLE_BEAT_CHARS)}…` : flat;
}

/**
 * 把 brief 切成「可独立成镜的段」：
 * 先按行，再按句末标点；句子太长（> 90 字）时再按逗号切一刀 —— 这是为了在
 * 「只给了 3 句话却要 6 个镜头」时仍能给出 6 个有内容来源的镜头，而不是复制同一句。
 */
export function splitBrief(brief: string): string[] {
  const segments: string[] = [];
  const push = (raw: string): void => {
    const value = raw.replace(/^[\s\-*·•\d.、)）(（]+/, '').trim();
    if (!value) return;
    segments.push(value);
  };
  for (const line of brief.replace(/\r\n?/g, '\n').split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[#>\-*]{2,}/.test(trimmed)) continue;
    const sentences = trimmed.split(/(?<=[。！？；!?;])/);
    for (const sentence of sentences) {
      const value = sentence.trim();
      if (!value) continue;
      if (value.length > 90) {
        const clauses = value.split(/(?<=[，,])/);
        if (clauses.length > 1) {
          for (const clause of clauses) push(clause);
          continue;
        }
      }
      push(value);
    }
  }
  return segments;
}

function detectShots(input: Record<string, unknown>, brief: string): number | null {
  const explicit = Number(input.shots ?? input.count);
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  const match = brief.match(/(\d{1,2})\s*(?:个|条|组|张)?\s*(?:镜头|分镜|shots?)/i);
  if (match) return Number(match[1]);
  const cn = brief.match(/([一二两三四五六七八九十]{1,3})\s*(?:个|条|组)?\s*(?:镜头|分镜)/);
  if (cn) {
    const value = CN_NUMBERS[cn[1]];
    if (value) return value;
  }
  return null;
}

function detectAspect(input: Record<string, unknown>, brief: string): string | null {
  const explicit = text(input.aspectRatio ?? input.aspect);
  if (/^\d{1,2}:\d{1,2}$/.test(explicit)) return explicit;
  const match = brief.match(/(\d{1,2}\s*:\s*\d{1,2})/);
  return match ? match[1].replace(/\s+/g, '') : null;
}

function detectDuration(input: Record<string, unknown>, brief: string): number | null {
  const explicit = Number(input.duration ?? input.seconds);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(60, explicit);
  const match = brief.match(/(\d{1,2}(?:\.\d)?)\s*(?:s|秒)/i);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return Math.min(60, value);
  }
  return null;
}

function detectType(input: Record<string, unknown>, brief: string): 'Image' | 'Video' {
  const explicit = text(input.type).toLowerCase();
  if (explicit === 'video') return 'Video';
  if (explicit === 'image') return 'Image';
  return /视频|短片|动态|运镜|seedance|即梦|i2v|t2v/i.test(brief) ? 'Video' : 'Image';
}

/**
 * 段数不够时按逗号**细分最长的句子**，直到够数或没有可切的逗号。
 * 只增加切分点，不复制文本 —— 每个镜头的内容仍然来自 brief。
 */
function subdivideToReach(segments: readonly string[], target: number): string[] {
  const out = [...segments];
  let guard = 0;
  while (out.length < target && guard < 64) {
    guard += 1;
    let best = -1;
    let bestLength = 0;
    for (let index = 0; index < out.length; index += 1) {
      const value = out[index]!;
      const clauses = value.split(/(?<=[，,])/).filter((part) => part.trim());
      if (clauses.length > 1 && value.length > bestLength) {
        best = index;
        bestLength = value.length;
      }
    }
    if (best < 0) break;
    const clauses = out[best]!
      .split(/(?<=[，,])/)
      .map((part) => part.trim())
      .filter(Boolean);
    out.splice(best, 1, ...clauses);
  }
  return out;
}

/** 把 segments 均匀分到 count 组（前面的组多拿一个）；组内用「；」连接。 */
export function distributeBeats(segments: readonly string[], count: number): string[][] {  const total = segments.length;
  if (count <= 0 || total === 0) return [];
  const groups: string[][] = [];
  const base = Math.floor(total / count);
  const extra = total % count;
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    const group = segments.slice(cursor, cursor + Math.max(1, size));
    cursor += group.length;
    if (group.length > 0) groups.push(group);
  }
  return groups;
}

function assemblePrompt(parts: readonly string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    // 去掉段尾的句读再拼：否则会出现「雨夜追车。；林溯…」这种双标点
    const value = part
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[。；;，,、\s]+$/g, '');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    kept.push(value);
  }
  const joined = kept.join('；');
  return joined.length > MAX_PROMPT_CHARS ? joined.slice(0, MAX_PROMPT_CHARS - 1) + '…' : joined;
}

export function compileIntent(
  rawInput: unknown,
  context: IntentContext = {},
  options: IntentOptions = {},
): { plan: IntentPlan } | Failure {
  if (!isRecord(rawInput)) {
    return { error: 'intent 需要对象参数，例如 { op:"compile", brief:"雨夜追车，6 个镜头，16:9" }。' };
  }
  const brief = text(rawInput.brief);
  if (!brief) return { error: 'intent 需要非空 brief（一句话意图或剧本段落）。' };

  const segments = splitBrief(brief);
  if (segments.length === 0) return { error: 'brief 里没有可用的句子，先给一段有内容的描述。' };

  const requested = detectShots(rawInput, brief);
  const target = Math.max(1, Math.min(MAX_INTENT_SHOTS, requested ?? segments.length));
  // 句子不够时先按逗号细分（不复制文本），仍不够才少出镜头
  const expanded = subdivideToReach(segments, target);
  const count = Math.max(1, Math.min(MAX_INTENT_SHOTS, Math.min(target, expanded.length)));
  const notes: string[] = [];
  const missing: string[] = [];
  if (requested !== null && requested > expanded.length) {
    notes.push(
      `brief 只切出 ${expanded.length} 段内容，已按 ${count} 个镜头生成（请求 ${requested} 个）；补齐内容后再编译。`,
    );
  }
  if (requested !== null && requested > MAX_INTENT_SHOTS) {
    notes.push(`镜头数上限 ${MAX_INTENT_SHOTS}，已截断。`);
  }

  const type = detectType(rawInput, brief);
  const aspectRatio = detectAspect(rawInput, brief);
  const duration = type === 'Video' ? detectDuration(rawInput, brief) : null;
  const model = text(rawInput.model) || undefined;
  const columns = (() => {
    const value = Number(rawInput.columns);
    return Number.isFinite(value) ? Math.max(1, Math.min(6, Math.trunc(value))) : Math.min(3, count);
  })();

  const styleParts = (context.style ?? []).map((item) => item.trim()).filter(Boolean);
  const explicitStyle = text(rawInput.style);
  if (explicitStyle) styleParts.unshift(explicitStyle);
  const style = styleParts.join('；');

  const includeLocks = options.includeLocks !== false && rawInput.includeLocks !== false;
  const lockParts = includeLocks
    ? [
        ...(context.locks ?? []),
        ...(context.characters ?? []),
      ]
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  const locks = Array.from(new Set(lockParts));

  const constraints = (context.rules ?? []).map((item) => item.trim()).filter(Boolean);
  const qualityAnchor = text(rawInput.qualityAnchor) || options.qualityAnchor || DEFAULT_QUALITY_ANCHOR;
  const limitClause = text(rawInput.limitClause) || options.limitClause || DEFAULT_LIMIT_CLAUSE;

  const groups = distributeBeats(expanded, count);
  const parameters: Record<string, unknown> = {};
  if (aspectRatio) parameters.aspectRatio = aspectRatio;
  if (duration !== null) parameters.duration = duration;
  if (model && Object.keys(parameters).length === 0) {
    notes.push('没从 brief 里读出画幅/时长；模型参数未附带，需要时显式给 aspectRatio/duration。');
  }
  if (!model) {
    const desiredParts = [aspectRatio ? `画幅 ${aspectRatio}` : '', duration !== null ? `时长 ${duration}s` : '']
      .filter(Boolean)
      .join('、');
    if (desiredParts) {
      notes.push(`想用 ${desiredParts}：给 model 后才会写进 configure（画布要求 model+parameters 同时给）。`);
    }
  }

  const shots: IntentShot[] = groups.map((group, index) => {
    const beat = group.join('；');
    const prompt = assemblePrompt([style, beat, ...locks, ...constraints, qualityAnchor, limitClause]);
    const title = `镜头 ${String(index + 1).padStart(2, '0')} · ${clipTitle(beat)}`;
    return {
      title,
      prompt,
      type,
      ...(model ? { model } : {}),
      ...(model && Object.keys(parameters).length > 0 ? { parameters: { ...parameters } } : {}),
    };
  });

  if (shots.length < target) {
    missing.push(`少 ${target - shots.length} 个镜头的画面内容`);
  }

  return {
    plan: {
      brief,
      shots,
      count: shots.length,
      requestedShots: requested,
      beats: expanded.length,
      style,
      locks,
      constraints,
      type,
      aspectRatio,
      duration,
      columns,
      notes,
      missing,
    },
  };
}
