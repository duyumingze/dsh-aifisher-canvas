/**
 * 节点搜索的**候选目录 + 模糊匹配排序**（纯函数，不碰 React、不碰 DOM）。
 *
 * 单独拆出来的理由有两个：
 *   ① 回归脚本要能直接跑（`scripts/test-canvas-node-search.mjs` 直接对着这份模块断言），
 *      排序质量不该只能靠肉眼在画布上看；
 *   ② 候选来源会继续长（模型、素材、动作…），匹配与排序必须与「面板长什么样」解耦。
 *
 * 匹配算法（中英混排、顺序无关）：
 *   归一化（小写、去掉空格与常见分隔符）后依次判断
 *     ① 完全相等 → 分数最低
 *     ② 前缀 → 次之
 *     ③ 子串 → 再次（越靠前越好）
 *     ④ 子序列（按顺序命中即可，允许跳字）→ 最差，命中越分散扣分越多
 *   命中词首（空格/分隔符之后）有奖励。中文没有「词首」概念，靠子串/子序列这两档够用
 *   （「图片」能靠子序列搜到「图像生成」）。拼音首字母（图片 = tp）走 keywords 显式登记，
 *   不做全量拼音表。
 *
 * ⚠️ 本模块**刻意不 import 任何东西**（不 import React、不 import `@/ui/*`、也不 import vendor）：
 *    回归脚本在 node 里直接 import 这份 .ts 跑断言（`scripts/test-canvas-node-search.mjs`），
 *    node 的 ESM 解析器不认无扩展名 import，而 vendor 里的相对 import 全是无扩展名的。
 *    所以「工作流清单」由调用方作为参数传进来（组件传 vendor 的 localWorkflowOptions()）。
 */

/** 搜索候选：画布能凭空建出来的节点类型 / 工作流模板。 */
export interface CanvasNodeSearchEntry {
  /** 稳定 id（回归与真机检查的锚点）：`type:Image` / `workflow:custom-a-t2i` */
  id: string;
  /** 建节点时下发的 type（vendor 的 createCanvasNode 认这个字符串）。 */
  type: string;
  /** ComfyUI 节点指定用哪份工作流模板（vendor 的 node.comfyMode）。 */
  mode?: string;
  label: string;
  description: string;
  /** 显式登记的同义词与拼音首字母（只登记容易说出口的那几个）。 */
  keywords: string[];
  group: string;
}

export interface CanvasNodeSearchResult {
  entry: CanvasNodeSearchEntry;
  score: number;
  /** 排序用：命中在**归一化文本**里的下标（面板不依赖它，回归脚本用它验证排序）。 */
  hits: number[];
}

/** 建节点类型：与 vendor 的 nodeTypes / canvasContextMenu 的「添加节点」菜单一致。 */
const NODE_ENTRIES: ReadonlyArray<Omit<CanvasNodeSearchEntry, 'id'>> = [
  {
    type: 'Text',
    label: '文本',
    description: '脚本、文案、品牌文本',
    keywords: ['text', 'wenben', 'wb', '提示词', 'prompt', '文案', '脚本', '大模型'],
    group: '节点',
  },
  {
    type: 'Image',
    label: '图像生成',
    description: '文生图 / 图生图，模型与尺寸在节点上选',
    keywords: ['image', 'tuxiang', 'tupian', 'tx', 'tp', 'pic', '图片', '生图', '画图', '文生图', '图生图', '绘画'],
    group: '节点',
  },
  {
    type: 'Video',
    label: '视频生成',
    description: '文生视频 / 图生视频，模型与时长在节点上选',
    keywords: ['video', 'shipin', 'sp', 'donghua', '生视频', '视频', '文生视频', '图生视频', '动画'],
    group: '节点',
  },
  {
    type: 'Audio',
    label: '音频生成',
    description: '歌词音乐、背景音乐、音效',
    keywords: ['audio', 'yinpin', 'yp', '音乐', '声音', '配音', '音效', 'bgm'],
    group: '节点',
  },
  {
    type: 'ComfyUI',
    label: 'ComfyUI 工作流',
    description: '本地工作流节点（默认用清单里的第一个）',
    keywords: ['comfyui', 'comfy', 'gongzuoliu', 'gzl', '工作流', '本地', '节点'],
    group: '节点',
  },
  {
    type: 'Image Compare',
    label: '图片对比',
    description: '把两张图并排对比',
    keywords: ['compare', 'duibi', 'db', '对比', '比较', 'diff'],
    group: '节点',
  },
  {
    type: 'Image Composite',
    label: '图片拼合',
    description: '把多张图拼成一张',
    keywords: ['composite', 'pinhe', 'ph', '拼合', '拼接', '合图', 'collage'],
    group: '节点',
  },
  {
    // v1.70：调色节点（Color Grade）—— 多图进全屏合成器，一个效果一个节点
    type: 'Color Grade',
    label: '调色',
    description: '多图进合成器：调色、混合、蒙版，一个效果一个节点',
    keywords: ['color', 'grade', 'tiaose', 'ts', '调色', '校色', '合成', '合成器', 'blender', 'compositor', '色彩'],
    group: '节点',
  },
  {
    // v1.71：转接节点 —— 多数时候由 Shift+右键划选自动插入，这里留一个手动入口
    type: 'Junction',
    label: '转接',
    description: '一路进、一路出，只整理连线走向，不改求值结果',
    keywords: ['junction', 'reroute', 'zhuanjie', 'zj', '转接', '转接口', '中继', '合线'],
    group: '节点',
  },
];

/**
 * 工作流候选的两个来源形状（结构化声明，不从 vendor import —— 见文件头的说明）。
 * vendor 的 `LocalWorkflowOption` / `LocalWorkflowDefinition` 结构上满足它们。
 */
export interface NodeSearchWorkflowOption {
  id: string;
  label: string;
  outputType: string;
  custom: boolean;
}

export interface NodeSearchWorkflowDefinition {
  id: string;
  label: string;
  category: string;
  parameters: ReadonlyArray<unknown>;
  inputs: ReadonlyArray<unknown>;
}

/** 内置的 ComfyUI 工作流（vendor 的 workflowTemplates 里那条专用 MiniMax 节点）。 */
const BUILTIN_WORKFLOW = {
  id: 'minimax-h3-t2va',
  label: 'MiniMax H3 本地音视频',
  outputType: 'videos',
};

/** 分隔符：归一化时删掉，同时用于「命中词首」的判断。 */
const SEPARATORS = /[\s._\-+·:：/\\()[\]{}"'`,，。、！？!?]/;

/**
 * 「命中词首」只对 ASCII 有意义（空格/分隔符之后算词首）。
 * 中文没有词首概念，如果照样给奖励，「图片」在「图片对比」里的前缀命中会白拿 1.5 分，
 * 把本该赢的「图像生成」（关键词完全相等）挤下去 —— 所以只对 ASCII 命中给这个奖励。
 */
function isBoundary(text: string, index: number): boolean {
  return index > 0 && SEPARATORS.test(text[index - 1] ?? '');
}

/**
 * 候选字段的权重档位（越小越优先）。
 *
 * 这里刻意让**关键词完全相等**（6）压过**别的候选的标题前缀**（≈8.9）：
 * 中文用户说「图片」时想的是**图像生成**，而「图片对比 / 图片拼合」的标题恰好以「图片」开头。
 * 只按匹配档位排的话后者会赢 —— 那是错的。反过来，标题命中仍压过关键词的子串/子序列
 * （标题前缀 ≈8.9、关键词子串 = 46、关键词子序列 ≥126），所以「图像 → 图像生成」不受影响。
 * 实测校准过的查询：图像 / 图片 / tp / sp / 工作流 / comfy / 音pin。
 */
const FIELD_WEIGHT = { label: 0, description: 8, keyword: 6 } as const;

function workflowEntry(
  option: NodeSearchWorkflowOption,
  definitions: readonly NodeSearchWorkflowDefinition[],
): CanvasNodeSearchEntry {
  const definition = definitions.find((item) => item.id === option.id);
  const category = definition?.category ?? 'ComfyUI';
  const kind =
    option.outputType === 'images' ? '图片' : option.outputType === 'audios' ? '音频' : '视频';
  const parts: string[] = [];
  if (category && category !== 'custom') parts.push(category);
  parts.push(kind + '输出');
  if (definition?.parameters.length) parts.push(`${definition.parameters.length} 个参数`);
  if (definition?.inputs.length) parts.push(`${definition.inputs.length} 个输入槽`);
  return {
    id: `workflow:${option.id}`,
    type: 'ComfyUI',
    mode: option.id,
    label: option.label,
    description: parts.join(' · '),
    keywords: ['comfyui', 'workflow', 'gongzuoliu', 'gzl', '工作流', option.id],
    group: 'ComfyUI 工作流',
  };
}

/**
 * 组装候选目录：内置节点类型 + 当前注册的每一份 ComfyUI 工作流。
 *
 * 调用方每次都要把**最新**的工作流清单传进来（清单是异步 pull 回来的，回来之后立刻要能搜到）。
 * 不传（或传空）时只有内置 MiniMax 那一条 —— 与画布「没有自定义工作流时默认用内置」一致。
 */
export function buildNodeSearchCatalog(
  workflowOptions: readonly NodeSearchWorkflowOption[] = [],
  workflowDefinitions: readonly NodeSearchWorkflowDefinition[] = [],
): CanvasNodeSearchEntry[] {
  const entries: CanvasNodeSearchEntry[] = NODE_ENTRIES.map((entry) => ({
    ...entry,
    id: `type:${entry.type}`,
  }));
  if (!workflowOptions.length) {
    entries.push(workflowEntry({ ...BUILTIN_WORKFLOW, custom: false }, workflowDefinitions));
    return entries;
  }
  for (const option of workflowOptions) entries.push(workflowEntry(option, workflowDefinitions));
  return entries;
}

/** 归一化：小写 + 去掉空白与常见分隔符，让「5.0-pro」「5 0 pro」都能命中。 */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[\s._\-+·:：/\\()[\]{}"'`,，。、！？!?]+/g, '');
}

interface Match {
  score: number;
  hits: number[];
}

/**
 * 打分：返回 null = 不匹配；数字越小越靠前。
 * 候选文本取「标题 / 描述 / 关键词」里最好的那一份，所以关键词命中也能把候选顶上来。
 */
export function scoreSearchEntry(rawQuery: string, entry: CanvasNodeSearchEntry): Match | null {
  const query = normalizeSearchText(rawQuery);
  if (!query) return { score: 0, hits: [] };
  const candidates = [entry.label, entry.description, ...entry.keywords];
  let best: Match | null = null;

  for (const [index, raw] of candidates.entries()) {
    const text = normalizeSearchText(raw);
    if (!text) continue;
    const weight = index === 0 ? FIELD_WEIGHT.label : index === 1 ? FIELD_WEIGHT.description : FIELD_WEIGHT.keyword;
    const exact = text === query;
    const prefix = !exact && text.startsWith(query);
    const at = !exact && !prefix ? text.indexOf(query) : -1;
    let score: number;
    const hits: number[] = [];

    if (exact) {
      score = 0;
    } else if (prefix) {
      score = 10 + (text.length - query.length) * 0.2;
      for (let cursor = 0; cursor < query.length; cursor += 1) hits.push(cursor);
    } else if (at >= 0) {
      score = 40 + at * 4 + (text.length - query.length) * 0.2;
      for (let cursor = 0; cursor < query.length; cursor += 1) hits.push(at + cursor);
    } else {
      // 子序列：按顺序命中即可（中文里「图片」→「图像生成」的宽松匹配靠这一档）
      let cursor = 0;
      let gaps = 0;
      let spread = 0;
      for (const character of query) {
        const found = text.indexOf(character, cursor);
        if (found < 0) break;
        if (cursor > 0) {
          gaps += 1;
          spread += found - cursor;
        }
        hits.push(found);
        cursor = found + 1;
      }
      if (hits.length !== query.length) continue;
      score = 120 + gaps * 6 + spread * 2;
    }

    // 词首奖励：命中落在空格/分隔符之后（英文「seedream pro」那种更明显）
    let boundaryHits = 0;
    for (const hit of hits) if (isBoundary(raw, hit)) boundaryHits += 1;
    if (!exact) score -= boundaryHits * 1.5;
    score += weight;
    if (!best || score < best.score) best = { score, hits };
  }

  // 中英混排兜底：单个字段里凑不齐（「音pin」= 中文「音」+ 拼音「pin」）时，
  // 让各段各自去命中（可跨字段）。这是**兜底**，只在上面一个字段都没命中时才生效，
  // 不会把正常的排序搅乱。
  if (!best) best = matchMixedScript(rawQuery, entry);
  return best;
}

/** 查询按字符种类切段：连续中文一段、连续非中文一段。 */
function scriptGroups(query: string): string[] {
  const groups: string[] = [];
  let current = '';
  let currentIsCjk = false;
  for (const character of query) {
    const cjk = /[\u3400-\u9fff]/.test(character);
    if (!current || cjk === currentIsCjk) {
      current += character;
      currentIsCjk = cjk;
      continue;
    }
    groups.push(current);
    current = character;
    currentIsCjk = cjk;
  }
  if (current) groups.push(current);
  return groups;
}

/** 混排兜底：每段至少在一个字段里命中（可跨字段），分数取「段落数 × 每段基础分」。 */
function matchMixedScript(rawQuery: string, entry: CanvasNodeSearchEntry): Match | null {
  const groups = scriptGroups(normalizeSearchText(rawQuery));
  if (groups.length < 2) return null;
  const fields = [entry.label, entry.description, ...entry.keywords].map(normalizeSearchText);
  const hits: number[] = [];
  let score = 100;
  for (const group of groups) {
    let bestAt = -1;
    for (const text of fields) {
      const at = text.indexOf(group);
      if (at >= 0 && (bestAt < 0 || at < bestAt)) bestAt = at;
    }
    if (bestAt < 0) return null;
    hits.push(bestAt);
    score += bestAt * 2;
  }
  return { score, hits };
}

/** 排序后的候选列表。空查询按目录原顺序返回（节点类型在前、工作流在后）。 */
export function rankNodeSearch(
  query: string,
  catalog: CanvasNodeSearchEntry[],
  limit = 60,
): CanvasNodeSearchResult[] {
  if (!normalizeSearchText(query)) {
    return catalog.slice(0, limit).map((entry) => ({ entry, score: 0, hits: [] }));
  }
  const scored: CanvasNodeSearchResult[] = [];
  for (const entry of catalog) {
    const match = scoreSearchEntry(query, entry);
    if (match) scored.push({ entry, score: match.score, hits: match.hits });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.label.localeCompare(b.entry.label, 'zh'));
  return scored.slice(0, limit);
}
