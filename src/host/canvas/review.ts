/**
 * 质量评估（v1.63，画布助手 P2 第二项）。
 *
 * 定位：**只做能判定的事**，不假装懂画面。
 *   - 结构层：提示词缺光/缺质感锚点/缺限制/过长过短、镜头是否引用全部参考锚点；
 *   - 结果层：节点状态（failed/loading）、结果文件是否存在/非空/格式/像素尺寸；
 *   - 失败层：错误码归因，直接给出「该重试哪几个节点」的清单。
 * 主观画质（构图是否好看、人物像不像）明确留给 agent 用 preview + read_image 看图，
 * 这里给一段固定的评审 rubric，避免凭文件大小瞎打分。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export type ReviewLevel = 'pass' | 'info' | 'attention' | 'fail';

export interface ReviewCheck {
  id:
    | 'prompt-missing'
    | 'prompt-length'
    | 'prompt-light'
    | 'prompt-quality'
    | 'prompt-limits'
    | 'anchor-coverage'
    | 'result-missing'
    | 'result-file'
    | 'result-small'
    | 'generation-failed'
    | 'generation-loading'
    | 'model-missing';
  level: ReviewLevel;
  detail: string;
}

export interface NodeReview {
  nodeId: string;
  title: string;
  type: string;
  verdict: Exclude<ReviewLevel, 'pass'> | 'pass';
  checks: ReviewCheck[];
  /** 视觉判断交给 agent：这条只在有结果时出现。 */
  media?: Array<{ url: string; path: string | null; width: number | null; height: number | null; bytes: number | null }>;
}

export interface ReviewReport {
  summary: {
    nodes: number;
    pass: number;
    attention: number;
    fail: number;
    /** 值得重新准备生成的节点（结果缺失/生成失败）。 */
    retry: string[];
  };
  nodes: NodeReview[];
  rubric: string[];
  hint: string;
}

export interface MediaProbe {
  bytes: number;
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'unknown';
  width: number | null;
  height: number | null;
}

export interface ReviewInput {
  nodes: readonly unknown[];
  /**
   * 一致性覆盖率的缺口（直接取 coverageReport().uncovered）。
   * 传空数组 = 每个镜头都接好了全部锚点；不传 = 项目还没有锚点，跳过这项检查。
   */
  uncovered?: ReadonlyArray<{ id: string; title: string; missingAnchors: readonly string[] }>;
  /** resultUrl → 本机绝对路径。 */
  resolvePath?: (url: string) => string | null;
}

const LIGHT_HINTS = /光|灯|窗|日照|月光|逆光|侧光|顶光|底光|环境光|阴影|反射|fire|sun|light/i;
const QUALITY_HINTS = /清晰|锐利|质感|影调|细节|颗粒|写实|realistic|detail|texture|sharp/i;
const LIMIT_HINTS = /不出现|不要|避免|禁止|无文字|无水印|no text|watermark|结构完整/i;
const MIN_PROMPT = 12;
const MAX_PROMPT = 1600;
const SMALL_FILE_BYTES = 4 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resultUrlsOf(node: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (Array.isArray(node.resultUrls)) {
    for (const item of node.resultUrls) {
      if (typeof item === 'string' && item) urls.push(item);
    }
  }
  const single = str(node.resultUrl);
  if (single) urls.unshift(single);
  return Array.from(new Set(urls));
}

/** 只读文件头：PNG/JPEG/WebP/GIF 的格式与像素尺寸足够判断「是不是空图/坏图」。 */
export function probeImageFile(path: string): MediaProbe | null {
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    return null;
  }
  let buffer = Buffer.alloc(0);
  try {
    const fd = openSync(path, 'r');
    try {
      const chunk = Buffer.alloc(Math.min(65_536, Math.max(64, bytes)));
      const read = readSync(fd, chunk, 0, chunk.length, 0);
      buffer = chunk.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { bytes, format: 'unknown', width: null, height: null };
  }
  return { bytes, ...decodeHeader(buffer) };
}

function decodeHeader(buffer: Buffer): Omit<MediaProbe, 'bytes'> {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { format: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { format: 'webp', width, height };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { format: 'webp', width: null, height: null };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      // SOF0..SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return { format: 'jpeg', width: null, height: null };
  }
  return { format: 'unknown', width: null, height: null };
}

function verdictOf(checks: readonly ReviewCheck[]): NodeReview['verdict'] {
  if (checks.some((check) => check.level === 'fail')) return 'fail';
  if (checks.some((check) => check.level === 'attention')) return 'attention';
  return 'pass';
}

export const REVIEW_RUBRIC = [
  '看得清主体与动作是否落在这句提示词描述的状态上，而不是「像不像一张好图」。',
  '光：画面里能不能指出光源在哪、朝哪个方向衰减；无源侧光=不合格。',
  '一致性：同一角色在不同镜头的脸型/发型/服装/年龄是否稳定；不一致先查锚点连线与锁定串。',
  '构图：主体是否被裁切、有没有被画框边缘切断肢体；留白是否符合镜头景别。',
  '质感：皮肤/布料/金属是否有材质层次；避免塑料感、过曝、糊成一团的背景。',
];

export function reviewCanvas(input: ReviewInput): ReviewReport {
  const uncovered = new Map<string, readonly string[]>();
  for (const item of input.uncovered ?? []) uncovered.set(item.id, item.missingAnchors);
  const reviews: NodeReview[] = [];
  const retry: string[] = [];

  for (const raw of input.nodes) {
    if (!isRecord(raw)) continue;
    const nodeId = str(raw.id);
    if (!nodeId) continue;
    const type = str(raw.type) || 'unknown';
    const prompt = str(raw.prompt).trim();
    const status = str(raw.status).toLowerCase();
    const title = str(raw.title) || nodeId;
    const checks: ReviewCheck[] = [];
    const isMediaNode = /image|video|audio/i.test(type);

    if (isMediaNode && !prompt) {
      checks.push({ id: 'prompt-missing', level: 'fail', detail: '节点没有提示词，生成不出内容。' });
    } else if (prompt) {
      if (prompt.length < MIN_PROMPT) {
        checks.push({ id: 'prompt-length', level: 'attention', detail: `提示词只有 ${prompt.length} 字，信息量不足以约束画面。` });
      } else if (prompt.length > MAX_PROMPT) {
        checks.push({ id: 'prompt-length', level: 'attention', detail: `提示词 ${prompt.length} 字，过长会冲淡主体；建议压到 600 字内。` });
      }
      if (!LIGHT_HINTS.test(prompt)) {
        checks.push({ id: 'prompt-light', level: 'attention', detail: '没有写光源与方向（窗/灯/天光/逆光…），容易出无源侧光与 AI 味。' });
      }
      if (!QUALITY_HINTS.test(prompt)) {
        checks.push({ id: 'prompt-quality', level: 'info', detail: '没有质感锚点（清晰/锐利/影调/材质），画质容易发糊。' });
      }
      if (!LIMIT_HINTS.test(prompt)) {
        checks.push({ id: 'prompt-limits', level: 'info', detail: '没有画面内限制（不出现文字水印/结构完整），成图风险更高。' });
      }
    }

    if (isMediaNode) {
      const missing = uncovered.get(nodeId);
      if (missing && missing.length > 0) {
        checks.push({
          id: 'anchor-coverage',
          level: 'attention',
          detail: `没接上 ${missing.length} 个参考锚点（${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}），一致性靠文字硬撑。`,
        });
      }
    }

    const urls = resultUrlsOf(raw);
    const media: NonNullable<NodeReview['media']> = [];
    if (status === 'failed') {
      const code = str(raw.errorCode) || str(raw.code) || str(raw.error) || 'UNKNOWN';
      checks.push({ id: 'generation-failed', level: 'fail', detail: `生成失败：${code}。修原因后重新准备这一批（仍要用户确认）。` });
      retry.push(nodeId);
    } else if (/loading|generating|running|queued|pending/.test(status)) {
      checks.push({ id: 'generation-loading', level: 'info', detail: '还在生成中，等它到终点再看结果。' });
    } else if (urls.length === 0) {
      checks.push({ id: 'result-missing', level: 'info', detail: '还没有生成结果。' });
    }

    for (const url of urls) {
      const path = input.resolvePath ? input.resolvePath(url) : null;
      if (!path) {
        media.push({ url, path: null, width: null, height: null, bytes: null });
        continue;
      }
      const probe = probeImageFile(path);
      if (!probe) {
        checks.push({ id: 'result-file', level: 'fail', detail: `结果文件不在磁盘上：${path}` });
        media.push({ url, path, width: null, height: null, bytes: null });
        retry.push(nodeId);
        continue;
      }
      media.push({ url, path, width: probe.width, height: probe.height, bytes: probe.bytes });
      if (probe.bytes === 0) {
        checks.push({ id: 'result-file', level: 'fail', detail: `结果文件是 0 字节：${path}` });
        retry.push(nodeId);
      } else if (probe.bytes < SMALL_FILE_BYTES) {
        checks.push({ id: 'result-small', level: 'attention', detail: `结果只有 ${probe.bytes} 字节，可能是空白图/坏图。` });
      }
      if (probe.format === 'unknown') {
        checks.push({ id: 'result-file', level: 'attention', detail: `结果不是可识别的图片格式（${path}）。` });
      }
    }
    reviews.push({
      nodeId,
      title,
      type,
      verdict: verdictOf(checks),
      checks,
      ...(media.length ? { media } : {}),
    });
  }

  const count = (level: ReviewLevel): number => reviews.filter((review) => review.verdict === level).length;
  const summary = {
    nodes: reviews.length,
    pass: count('pass'),
    attention: count('attention'),
    fail: count('fail'),
    retry: Array.from(new Set(retry)),
  };

  return {
    summary,
    nodes: reviews,
    rubric: REVIEW_RUBRIC,
    hint:
      '先看 summary.retry 与 fail 项（可直接重试），再用 preview + read_image 打开 media[].path 按 rubric 做视觉判断；' +
      '本报告不评价构图好坏，也不自动改画布。',
  };
}

/**
 * 确定性修补：只**追加**缺失的固定串，不重写用户/技能的原文。
 * 返回可直接喂给 edit 的 update operations（agent 决定是否 apply）。
 *
 * `patch.prompt` 必须是**拼好的完整提示词**：画布的 update 只认 title/prompt/text/x/y，
 * 传别的字段（如 promptAppend）会让整次 edit 以 INVALID 失败。
 */
export function planPromptFixes(
  report: ReviewReport,
  prompts: ReadonlyMap<string, string>,
): {
  patches: Array<{ nodeId: string; append: string; prompt: string }>;
  operations: Array<Record<string, unknown>>;
} {
  const patches: Array<{ nodeId: string; append: string; prompt: string }> = [];
  const operations: Array<Record<string, unknown>> = [];
  for (const review of report.nodes) {
    const appends: string[] = [];
    if (review.checks.some((check) => check.id === 'prompt-light')) {
      appends.push('光源：画面内有明确的光源与照射方向（窗光/灯/天光），阴影随之衰减');
    }
    if (review.checks.some((check) => check.id === 'prompt-quality')) {
      appends.push('质感：画面清晰锐利，影调层次分明，材质细节自然');
    }
    if (review.checks.some((check) => check.id === 'prompt-limits')) {
      appends.push('画面内不出现文字与水印，主体结构完整');
    }
    if (appends.length === 0) continue;
    const original = (prompts.get(review.nodeId) ?? '').trim();
    if (!original) continue;
    const append = appends.join('；');
    const prompt = `${original.replace(/[；;]\s*$/, '')}；${append}`;
    patches.push({ nodeId: review.nodeId, append, prompt });
    operations.push({ kind: 'update', nodeId: review.nodeId, patch: { prompt } });
  }
  return { patches, operations };
}
