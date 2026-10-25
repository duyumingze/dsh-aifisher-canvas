/**
 * 摄影机参数 → 提示词（v1.69，画布助手 P3 第一项）。
 *
 * ## 为什么要有这一层
 *
 * 分镜链路里最容易被「写没了」的是**镜头语言**：焦段、光圈、机身的质感差异。
 * 以前它们只是 Agent 手写进 prompt 的一段中文描述，换一镜就忘、重试时被改写、
 * 也没法和「这一镜用广角」这种决定分开管理。
 *
 * 这个模块把它做成**结构化参数**：机身 / 镜头 / 焦段 / 光圈四选一组合，
 * 由确定性函数翻成英文光学描述追加到提示词末尾（模型对英文光学词条的响应
 * 比中文更稳），并保证「重复 apply 不会越堆越长」——同一段话只留一份。
 *
 * ## 为什么片段要短
 *
 * 写进去的片段会跟用户自己的提示词抢预算：SD 系模型在 77 个 CLIP token 处截断，
 * 而且 `read` 默认把正文截到 240 字。所以这里只留「模型真的认得出」的信息：
 * 机身名 + 镜头名 + 焦段的透视含义 + 光圈的景深含义，一句护栏、一个参数标签，
 * 整段控制在 ~250 字符内。
 *
 * ## 借鉴与边界
 *
 * 思路来自外部开源项目 infinite-canvas（AGPL-3.0）的「摄像机控制」面板，
 * **只借鉴分工方式**（机身/镜头/焦段/光圈分组 + 数值翻译成光学描述 + 末尾一行
 * 参数摘要 + 「不要把相机拍进画面」护栏），文案全部重写，没有复制其源码或字符串。
 *
 * ## 存在哪
 *
 * `<数据目录>/canvas-camera.json`，按项目存一套配置（和 canvas-memory.json 同一套
 * 原子写策略）。配置本身不改画布；把提示词写进节点的是 `camera op:"apply"`。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDataDir } from './dataDir';

/** 机身：名字本身就是模型的先验（色彩科学/质感都挂在名字上）。 */
export interface CameraBody {
  id: string;
  /** 写进提示词用的机身名（英文，模型认得）。 */
  name: string;
  /** 中文名，给 Agent 和用户看。 */
  zhName: string;
  /** 适合什么题材（给 Agent 选型用，不进提示词）。 */
  useCase: string;
}

export const CAMERA_BODIES: readonly CameraBody[] = [
  {
    id: 'arri-alexa-35',
    name: 'ARRI Alexa 35',
    zhName: '阿莱 Alexa 35',
    useCase: '现代剧情、广告、需要高宽容度的日戏',
  },
  {
    id: 'arri-alexa-mini-lf',
    name: 'ARRI Alexa Mini LF',
    zhName: '阿莱 Mini LF',
    useCase: '剧情片、人像叙事、品牌广告（默认）',
  },
  {
    id: 'panavision-dxl2',
    name: 'Panavision DXL2',
    zhName: '潘那维申 DXL2',
    useCase: '奢华广告、院线质感长片',
  },
  {
    id: 'red-komodo-6k',
    name: 'RED Komodo 6K',
    zhName: 'RED 科莫多 6K',
    useCase: '动作、手持、穿越机等运动镜头',
  },
  {
    id: 'red-v-raptor-8k',
    name: 'RED V-Raptor 8K',
    zhName: 'RED V-Raptor 8K',
    useCase: '科幻、大场面、需要极致清晰度的合成镜头',
  },
  {
    id: 'sony-venice-2',
    name: 'Sony Venice 2',
    zhName: '索尼 Venice 2',
    useCase: '夜景、弱光戏剧、高端广告',
  },
  {
    id: 'blackmagic-ursa-12k',
    name: 'Blackmagic URSA 12K',
    zhName: '黑魔法 URSA 12K',
    useCase: '独立电影、MV、实验影像',
  },
  {
    id: 'canon-c500-ii',
    name: 'Canon C500 Mark II',
    zhName: '佳能 C500 II',
    useCase: '剧集、婚礼电影、人物访谈',
  },
];

/** 镜头：虚化形状与反差的性格。 */
export interface CinemaLens {
  id: string;
  name: string;
  zhName: string;
  useCase: string;
}

export const CINEMA_LENSES: readonly CinemaLens[] = [
  {
    id: 'arri-signature-prime',
    name: 'ARRI Signature Prime',
    zhName: '阿莱大师定焦',
    useCase: '人物叙事、顶级商业片（默认）',
  },
  {
    id: 'cooke-s7i',
    name: 'Cooke S7/i',
    zhName: '库克 S7/i',
    useCase: '时代感叙事、古典人像（暖调）',
  },
  {
    id: 'zeiss-supreme-prime',
    name: 'Zeiss Supreme Prime',
    zhName: '蔡司至尊定焦',
    useCase: '科技感广告、现代剧情（中性锐利）',
  },
  {
    id: 'canon-sumire-prime',
    name: 'Canon Sumire Prime',
    zhName: '佳能 Sumire 定焦',
    useCase: '爱情片、梦境、人物特写（柔和）',
  },
  {
    id: 'anamorphic-cooke',
    name: 'Cooke Anamorphic',
    zhName: '库克变形宽银幕',
    useCase: '科幻、太空、夜戏（横向蓝光晕）',
  },
  {
    id: 'anamorphic-atlas',
    name: 'Atlas Orion Anamorphic',
    zhName: 'Atlas Orion 变形',
    useCase: 'MV、风格化广告（青色光晕）',
  },
  {
    id: 'vintage-leica-r',
    name: 'Vintage Leica R',
    zhName: '徕卡 R 老镜',
    useCase: '年代戏、怀旧 MV、文艺片',
  },
  {
    id: 'macro-100mm',
    name: 'Macro 100mm',
    zhName: '100mm 微距',
    useCase: '美食、珠宝、昆虫、细节特写',
  },
];

export const FOCAL_LENGTHS = [14, 18, 24, 35, 40, 50, 65, 85, 100, 135, 200] as const;
export const APERTURES = [1.2, 1.4, 1.8, 2, 2.8, 4, 5.6, 8, 11, 16] as const;
export type FocalLength = (typeof FOCAL_LENGTHS)[number];
export type Aperture = (typeof APERTURES)[number];

const FOCAL_LABELS: Record<number, { zhName: string; useCase: string }> = {
  14: { zhName: '超广角', useCase: '建筑内景、极端空间纵深' },
  18: { zhName: '超广角', useCase: '街拍、室内、逼仄空间' },
  24: { zhName: '广角', useCase: '环境交代、大场面' },
  35: { zhName: '小广角', useCase: '人物与环境同框的叙事镜头' },
  40: { zhName: '准标准', useCase: '构图平衡的对话戏' },
  50: { zhName: '标准', useCase: '接近人眼、日常人像' },
  65: { zhName: '中焦', useCase: '半身人像、讨喜肤色' },
  85: { zhName: '中长焦', useCase: '人物特写、背景压缩' },
  100: { zhName: '长焦', useCase: '特写、微距、强压缩' },
  135: { zhName: '长焦', useCase: '剧情特写、舞台感' },
  200: { zhName: '超长焦', useCase: '极致压缩、戏剧化特写' },
};

const APERTURE_LABELS: Record<number, { zhName: string; useCase: string }> = {
  1.2: { zhName: '极大光圈', useCase: '梦幻人像、高光溢出' },
  1.4: { zhName: '大光圈', useCase: '夜景人像、暗光' },
  1.8: { zhName: '大光圈', useCase: '半身人像、街头弱光' },
  2: { zhName: '大光圈', useCase: '人像、日常与锐度兼得' },
  2.8: { zhName: '中大光圈', useCase: '群像、叙事镜头' },
  4: { zhName: '中光圈', useCase: '群像、剧集、主体清晰' },
  5.6: { zhName: '中光圈', useCase: '纪实、环境可辨' },
  8: { zhName: '小光圈', useCase: '风光、建筑、前后皆清晰' },
  11: { zhName: '小光圈', useCase: '大场景、产品摆拍' },
  16: { zhName: '极小光圈', useCase: '日光风光、星芒' },
};

/** 焦段 → 透视含义（英文进提示词）。说的是「透视压缩」这件事，与画幅无关。 */
export function describeFocalLength(mm: number): string {
  const value = Math.round(mm);
  if (value <= 16) return `${value}mm ultra-wide angle, extreme spatial stretch, edge distortion`;
  if (value <= 24) return `${value}mm wide-angle, exaggerated depth, environment-forward framing`;
  if (value <= 35) return `${value}mm slight-wide cinematic perspective, natural depth`;
  if (value <= 50) return `${value}mm standard perspective, near human-eye view`;
  if (value <= 85) return `${value}mm short-telephoto perspective, mild compression, flattering faces`;
  if (value <= 135) return `${value}mm telephoto perspective, strong compression, isolated subject`;
  return `${value}mm long-telephoto perspective, extreme compression, flat backdrop`;
}

/** 光圈 → 景深/虚化含义（英文进提示词）。 */
export function describeAperture(f: number): string {
  if (f <= 1.4) return `f/${f} extremely shallow depth of field, huge creamy bokeh`;
  if (f <= 2) return `f/${f} very shallow depth of field, smooth bokeh`;
  if (f <= 2.8) return `f/${f} shallow depth of field, soft bokeh`;
  if (f <= 4) return `f/${f} moderate depth of field, gentle falloff`;
  if (f <= 5.6) return `f/${f} balanced depth of field, background keeps context`;
  if (f <= 8) return `f/${f} deep depth of field, everything sharp, documentary feel`;
  return `f/${f} very deep depth of field, front-to-back sharp`;
}

/** 一个项目的摄影参数（结构化的那一份）。 */
export interface CameraConfig {
  enabled: boolean;
  /** CameraBody['id'] */
  body: string;
  /** CinemaLens['id'] */
  lens: string;
  focalLength: number;
  aperture: number;
  updatedAt?: string;
}

export const DEFAULT_CAMERA: CameraConfig = {
  enabled: true,
  body: 'arri-alexa-mini-lf',
  lens: 'arri-signature-prime',
  focalLength: 50,
  aperture: 2.8,
};

/**
 * 提示词句首（用于**幂等**：重复 apply 时靠它定位旧片段，从句子开头切到末尾）。
 * 改这句话等于让所有已写入的旧片段失去定位能力，所以它被导出去给回归断言。
 */
export const CAMERA_CLAUSE_LEAD = 'camera direction only —';

/** 片段末尾的参数摘要行，例如 `[cam: arri-alexa-mini-lf/arri-signature-prime/50mm/f2.8]`。 */
const CAMERA_TAG_PATTERN = /\[cam:[^\]]*\]\s*$/;

export interface ResolvedCamera {
  body: CameraBody;
  lens: CinemaLens;
  focalLength: number;
  aperture: number;
}

const FALLBACK_BODY = CAMERA_BODIES.find((item) => item.id === DEFAULT_CAMERA.body) as CameraBody;
const FALLBACK_LENS = CINEMA_LENSES.find((item) => item.id === DEFAULT_CAMERA.lens) as CinemaLens;

export function resolveCamera(config: CameraConfig): ResolvedCamera {
  return {
    body: CAMERA_BODIES.find((item) => item.id === config.body) ?? FALLBACK_BODY,
    lens: CINEMA_LENSES.find((item) => item.id === config.lens) ?? FALLBACK_LENS,
    focalLength: config.focalLength,
    aperture: config.aperture,
  };
}

/**
 * 参数 → 一段可直接拼进 prompt 的英文片段（约 250 字符）。
 *
 * 结构：护栏（这是拍摄参数、镜头别入画）→ 机身 + 镜头（名字本身就是模型先验）
 * → 焦段（透视）→ 光圈（景深）→ 参数摘要行（也是幂等定位用）。
 * 刻意**不写**长篇光学论述：用户自己的提示词才是主体，这段是配角。
 */
export function buildCameraClause(config: CameraConfig): string {
  const { body, lens, focalLength, aperture } = resolveCamera(config);
  return [
    CAMERA_CLAUSE_LEAD,
    'no camera or gear in frame',
    `shot on ${body.name} with ${lens.name}`,
    describeFocalLength(focalLength),
    describeAperture(aperture),
    `[cam: ${body.id}/${lens.id}/${Math.round(focalLength)}mm/f${aperture}]`,
  ].join(', ');
}

/** 中文一句话（给 digest / 工具回执 / 用户看，不进提示词）。 */
export function cameraSummary(config: CameraConfig): string {
  const { body, lens } = resolveCamera(config);
  const state = config.enabled ? '' : '（已关闭）';
  return `${body.zhName} · ${lens.zhName} · ${Math.round(config.focalLength)}mm · f/${config.aperture}${state}`;
}

/**
 * 去掉提示词里的相机片段（幂等的基础）。
 *
 * 只认「提示词**以** `[cam: …]` 结尾」的形态：这样用户在我们写入之后又手动
 * 往后接了半句话时，宁可不动（返回原文）也不误删用户文字。切点在最后一句
 * `CAMERA_CLAUSE_LEAD`，因为片段是整段追加在末尾的。
 */
export function stripCameraClause(prompt: string): string {
  const text = prompt.trim();
  if (!CAMERA_TAG_PATTERN.test(text)) return text;
  const index = text.lastIndexOf(CAMERA_CLAUSE_LEAD);
  if (index < 0) {
    // 摘要行在、句首不在：只可能是用户自己写了个同形 tag，别多删，原样返回
    return text;
  }
  return text
    .slice(0, index)
    .replace(/[\s,，;；]+$/, '')
    .trim();
}

/** 把相机片段写进一条提示词：先剥旧的，再追加新的（重复调用长度不增长）。 */
export function applyCameraToPrompt(prompt: string, config: CameraConfig): string {
  const base = stripCameraClause(prompt);
  const clause = buildCameraClause(config);
  return base ? `${base}, ${clause}` : clause;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickNumber<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return (allowed as readonly number[]).includes(number) ? (number as T) : fallback;
}

/**
 * 校验/合并一次 `set` 的参数：只覆盖给了的字段，其余保持 `base`。
 * 非法组合（不存在的机身 id、不在档位里的焦距）直接报错，不静默取默认值 ——
 * 静默兜底会让 Agent 以为「85mm 生效了」，其实拍的是 50mm。
 */
export function normalizeCameraInput(
  input: unknown,
  base: CameraConfig = DEFAULT_CAMERA,
): { config: CameraConfig } | { error: string } {
  if (input !== undefined && input !== null && !isRecord(input)) {
    return { error: 'camera 参数必须是对象。' };
  }
  const raw = isRecord(input) ? input : {};
  let body = base.body;
  if (raw.body !== undefined) {
    const wanted = typeof raw.body === 'string' ? raw.body.trim() : '';
    const match = CAMERA_BODIES.find(
      (item) => item.id === wanted || item.name === wanted || item.zhName === wanted,
    );
    if (!match) {
      return { error: `没有这个机身：${wanted || '(空)'}。可选 ${CAMERA_BODIES.map((item) => item.id).join(' / ')}。` };
    }
    body = match.id;
  }
  let lens = base.lens;
  if (raw.lens !== undefined) {
    const wanted = typeof raw.lens === 'string' ? raw.lens.trim() : '';
    const match = CINEMA_LENSES.find(
      (item) => item.id === wanted || item.name === wanted || item.zhName === wanted,
    );
    if (!match) {
      return { error: `没有这个镜头：${wanted || '(空)'}。可选 ${CINEMA_LENSES.map((item) => item.id).join(' / ')}。` };
    }
    lens = match.id;
  }
  if (raw.focalLength !== undefined) {
    const wanted = Number(raw.focalLength);
    if (!(FOCAL_LENGTHS as readonly number[]).includes(wanted)) {
      return { error: `焦段只能是 ${FOCAL_LENGTHS.join(' / ')}（mm）。` };
    }
  }
  if (raw.aperture !== undefined) {
    const wanted = Number(raw.aperture);
    if (!(APERTURES as readonly number[]).includes(wanted)) {
      return { error: `光圈只能是 ${APERTURES.join(' / ')}（f/）。` };
    }
  }
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled;
  return {
    config: {
      enabled,
      body,
      lens,
      focalLength: pickNumber<FocalLength>(raw.focalLength, FOCAL_LENGTHS, base.focalLength as FocalLength),
      aperture: pickNumber<Aperture>(raw.aperture, APERTURES, base.aperture as Aperture),
    },
  };
}

/** 给 Agent 的选型目录（中文标签 + 适用题材，不含英文提示词正文）。 */
export function cameraCatalog(): Record<string, unknown> {
  return {
    bodies: CAMERA_BODIES.map((item) => ({ id: item.id, name: item.name, zhName: item.zhName, useCase: item.useCase })),
    lenses: CINEMA_LENSES.map((item) => ({ id: item.id, name: item.name, zhName: item.zhName, useCase: item.useCase })),
    focalLengths: FOCAL_LENGTHS.map((mm) => ({ mm, ...(FOCAL_LABELS[mm] ?? { zhName: '', useCase: '' }) })),
    apertures: APERTURES.map((f) => ({ f, ...(APERTURE_LABELS[f] ?? { zhName: '', useCase: '' }) })),
  };
}

interface CameraFileShape {
  version: 1;
  projects: Record<string, CameraConfig & { updatedAt: string }>;
}

export interface CameraStoreOptions {
  filePath?: string;
  now?: () => number;
}

export const MAX_CAMERA_PROJECTS = 200;

export function defaultCameraPath(): string {
  return `${resolveDataDir()}/canvas-camera.json`;
}

function emptyFile(): CameraFileShape {
  return { version: 1, projects: {} };
}

/** 每个项目一套摄影参数；没设过的项目回默认值（不落库）。 */
export function createCameraStore(options: CameraStoreOptions = {}) {
  const filePath = options.filePath ?? defaultCameraPath();
  const now = options.now ?? (() => Date.now());
  let data: CameraFileShape = load();
  let writing: Promise<void> = Promise.resolve();

  const iso = (): string => new Date(now()).toISOString();

  function load(): CameraFileShape {
    try {
      if (!existsSync(filePath)) return emptyFile();
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<CameraFileShape>;
      const projects: CameraFileShape['projects'] = {};
      for (const [projectId, raw] of Object.entries(parsed.projects ?? {})) {
        if (!projectId || !isRecord(raw)) continue;
        const normalized = normalizeCameraInput(raw, DEFAULT_CAMERA);
        if ('error' in normalized) continue;
        projects[projectId] = {
          ...normalized.config,
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : iso(),
        };
      }
      return { version: 1, projects };
    } catch (error) {
      try {
        if (existsSync(filePath)) renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败就忽略 */
      }
      console.error('[aifisher-canvas] 摄影参数文件读取失败，已重置为空库', error);
      return emptyFile();
    }
  }

  function persist(): Promise<void> {
    writing = writing.then(async () => {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, filePath);
    });
    return writing;
  }

  function pruneProjects(): void {
    const ids = Object.keys(data.projects);
    if (ids.length <= MAX_CAMERA_PROJECTS) return;
    const sorted = ids.sort(
      (a, b) =>
        (Date.parse(data.projects[a]?.updatedAt ?? '') || 0) -
        (Date.parse(data.projects[b]?.updatedAt ?? '') || 0),
    );
    for (const id of sorted.slice(0, ids.length - MAX_CAMERA_PROJECTS)) delete data.projects[id];
  }

  /** 读项目配置；没记过（或记录损坏）就回默认值，不落库。 */
  function getConfig(projectId: string): CameraConfig {
    const record = projectId ? data.projects[projectId] : undefined;
    if (!record) return { ...DEFAULT_CAMERA };
    const { updatedAt: _updatedAt, ...config } = record;
    return { ...config };
  }

  return {
    filePath,

    get: getConfig,

    /** 写一套配置（只覆盖给了的字段）。返回归一化后的配置。 */
    async set(projectId: string, input: unknown): Promise<{ config: CameraConfig } | { error: string }> {
      if (!projectId) return { error: '缺少 projectId。' };
      const normalized = normalizeCameraInput(input, getConfig(projectId));
      if ('error' in normalized) return normalized;
      data.projects[projectId] = { ...normalized.config, updatedAt: iso() };
      pruneProjects();
      await persist();
      return { config: { ...normalized.config } };
    },

    /** 恢复默认值（删除该项目记录）。 */
    async reset(projectId: string): Promise<CameraConfig> {
      if (projectId && data.projects[projectId]) {
        delete data.projects[projectId];
        await persist();
      }
      return { ...DEFAULT_CAMERA };
    },
  };
}

export type CameraStore = ReturnType<typeof createCameraStore>;
