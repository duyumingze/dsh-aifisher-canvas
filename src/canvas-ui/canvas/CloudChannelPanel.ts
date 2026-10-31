/**
 * 「OpenAI 通道」设置面板（画布设置 → 闭源服务）。
 *
 * 用户原话（2026-10-16）：「OpenAI通道我希望可以配置好几个，并且可以选择多条单独模型」。
 * v1.4 起这里只有**一个**通用 OpenAI 兼容端点（AIFISHER_CLOUD_BASE_URL），模型也只能从
 * vendor 的静态目录里挑，想换成中转站/魔搭真实模型 ID 时每个目录条目只能存一个覆盖值。
 *
 * 本面板给的是「通道」这个概念：
 *   一条通道 = 名称 + Base URL + API Key（可只留 host，界面永不回显）+ 可选按媒体类型的路径覆盖
 *   + **它提供哪些模型**（点「读取端点模型列表」拉 `GET /models`，然后勾选；也能手填模型 ID）。
 * 勾中的模型会进画布的模型下拉（见 ./CloudChannelModels.ts 与 vendor 补丁 3.8g）。
 *
 * 三个实现约束（都是踩过的坑）：
 *   - **不写 React**：设置页是 vendor 用原生 DOM 搭的，而插件里有**两份 React 19**
 *     （vendor 画布那份 + src/canvas-ui 那份），往 vendor 的 DOM 里塞一棵别的 React 树
 *     会踩 #130。这里全部用原生 DOM + Tailwind 类（Tailwind 会扫 src/canvas-ui，见 tailwind-entry.css）。
 *   - **不改 vendor 文件就能挂上去**：用一个 MutationObserver 盯 `[data-fisherai-settings-page="models"]`，
 *     出现就挂、被 React 卸载（切分区会让 tabpanel 整个重挂，因为外层带 key={section}）就自然消失。
 *   - **密钥只进不出**：界面上永远只有「已保存/未配置」两种占位；留空 = 保持原值。
 */
import {
  channelModelRegistrySnapshot,
  installChannelModelRegistry,
  refreshChannelModelRegistry,
  type ChannelKind,
  type ChannelLike,
} from './CloudChannelModels';

export type CloudChannelKind = ChannelKind;

/** 请求方言（与 host 的 ChannelDialect 同一套值）。 */
export type ChannelDialect = 'openai' | 'modelscope' | 'workfisher';

const API = '/api/aifisher/canvas/cloud-channels';
const PANEL_ATTRIBUTE = 'data-fisherai-cloud-channels';

const KIND_LABELS: Readonly<Record<ChannelKind, string>> = Object.freeze({
  image: '图像',
  video: '视频',
  audio: '音频',
  text: '文本',
});

const KIND_ORDER: readonly ChannelKind[] = ['image', 'video', 'audio', 'text'];

const DIALECT_LABELS: Readonly<Record<ChannelDialect, string>> = Object.freeze({
  openai: 'OpenAI 兼容',
  modelscope: '魔搭 ModelScope',
  workfisher: 'FisherAI（work-fisher）',
});

/**
 * 按地址猜方言 —— 与 host 的 `detectChannelDialect` 同一套规则（这里只是为了在输入时
 * 立刻显示「自动 → 判成了哪套」，真正的判定仍在 host，界面不改请求行为）。
 */
export function guessDialect(baseUrl: string): ChannelDialect {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    if (host === 'modelscope.cn' || host.endsWith('.modelscope.cn')) return 'modelscope';
    if (host === 'work-fisher.com' || host.endsWith('.work-fisher.com')) return 'workfisher';
  } catch {
    // 地址还没填完/填错：按 openai 显示，host 那边保存时会自己校验
  }
  return 'openai';
}

/** 「请求方言」下面那行小字：把「实际会用哪套、参考图落在哪个字段」写清楚。 */
function dialectHintText(draft: ChannelDraft): string {
  if (draft.dialect === 'modelscope') {
    return '参考图放 image_url（数组）；异步任务靠 task_id 轮询。';
  }
  if (draft.dialect === 'workfisher') {
    return '路径 /image/generations、宽高比走 size、档位走 resolution（1k/2k/4k）；'
      + '参考图先传成公网直链（/files/upload）再放进 images；异步任务轮询 /image/generations/{id}。';
  }
  if (draft.dialect === 'openai') {
    return '参考图放 image（单张=字符串，多张=数组）。';
  }
  const detected = guessDialect(draft.baseUrl);
  const detail =
    detected === 'modelscope'
      ? '参考图放 image_url（数组）'
      : detected === 'workfisher'
        ? '路径 /image/generations、size 收宽高比、resolution 收 1k/2k/4k、参考图走公网直链'
        : '参考图放 image（单张=字符串）';
  return `自动：当前判为「${DIALECT_LABELS[detected]}」——${detail}。`;
}

/**
 * 「魔搭 API-Inference」一键预设。
 *
 * 它存在的理由（2026-10-17 实测）：魔搭的 `GET /models` 只回报 36 个模型，里面**没有**
 * `Qwen/Qwen-Image-2.1-Turbo`（用户实际在用的那个）—— 光靠「读取模型列表」勾不出来，
 * 必须手填 ID。预设把地址、方言与这两个图像模型一次填好，省掉手抄。
 */
const MODELSCOPE_PRESET = Object.freeze({
  label: '魔搭',
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  models: Object.freeze([
    { id: 'Qwen/Qwen-Image-2.1-Turbo', kind: 'image' as ChannelKind },
    { id: 'Qwen/Qwen-Image-Edit', kind: 'image' as ChannelKind },
  ]),
});

/**
 * 「FisherAI（work-fisher）」一键预设。
 *
 * 它存在的理由：这套端点的路径、尺寸写法、参考图上传方式**三处都与 OpenAI 兼容不同**
 * （`/image/generations` 单数路径、`size:"16:9"` + `resolution:"1k"` 两件套、
 * 参考图必须先 `/files/upload` 换成公网直链），而且**配错不报错**：路径错是网关 404、
 * 参考图错是「当没传」，出图看起来就是「编辑没生效」。
 *
 * 只预设用户实测的那一条（低价扩展版）；这个网关的 `GET /models` 其实回报 290 个模型、
 * 里面 `workfisher-image-*` 全套都有，想要别的点「读取模型列表」自己勾即可。
 */
const WORKFISHER_PRESET = Object.freeze({
  label: 'FisherAI',
  baseUrl: 'https://api.work-fisher.com/v1',
  models: Object.freeze([
    { id: 'workfisher-image-g-v2.5-lowprice', kind: 'image' as ChannelKind },
  ]),
});

interface ChannelModelDto {
  id: string;
  kind: ChannelKind;
  /** 自定义显示名（= 这条模型在画布上的名字）；缺省 = `${通道名} · ${id}`。 */
  label?: string;
}

interface ChannelDto {
  id: string;
  label: string;
  baseUrl: string;
  apiKeySet: boolean;
  paths?: Partial<Record<ChannelKind, string>>;
  /** 显式配的方言；null/缺省 = 自动（按 baseUrl 判定）。 */
  dialect?: ChannelDialect | null;
  /** host 实际生效的方言（「自动」时就是它判出来的那套）。 */
  dialectDetected?: ChannelDialect;
  timeoutMs?: number;
  models: ChannelModelDto[];
}

interface ChannelsPayload {
  channels?: ChannelDto[];
  defaults?: Partial<Record<ChannelKind, string>>;
}

interface ChannelDraft {
  /** 界面身份（新建时是本地序号，保存成功后换成服务端 id）。 */
  key: string;
  /** 服务端 id；新建通道留空，由 host 按名字生成。 */
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  apiKeySet: boolean;
  paths: Partial<Record<ChannelKind, string>>;
  /** 请求方言：空串 = 自动（按地址判定），与 host 的 dialect 缺省语义一致。 */
  dialect: ChannelDialect | '';
  timeoutMs: number;
  /** 已勾选的模型：模型 ID → { 媒体类型, 自定义显示名 }。 */
  models: Map<string, ChannelModelDraft>;
  /** 端点探测回来的模型 ID（勾选框的全集）。 */
  probed: string[];
  probedNote: string;
  /** 卡片展开状态（模型列表默认收起 —— 实测魔搭一次回几百个）。 */
  modelsOpen: boolean;
  filter: string;
  dirty: boolean;
}

interface ChannelModelDraft {
  kind: ChannelKind;
  /** 自定义显示名；空串 = 用默认的 `${通道名} · ${模型 ID}`（与 host 的 channelModelName 一致）。 */
  label: string;
}

/** 别名长度上限（与 host 的 MAX_MODEL_LABEL_LENGTH 对齐）。 */
const MAX_MODEL_LABEL_LENGTH = 80;

/** 某套方言某媒体类型的默认路径（与 host 的 channelPath 对齐；界面只用于占位提示）。 */
function defaultPathFor(dialect: ChannelDialect, kind: ChannelKind): string {
  if (dialect === 'workfisher' && kind === 'image') return '/image/generations';
  if (kind === 'image') return '/images/generations';
  if (kind === 'video') return '/videos/generations';
  if (kind === 'audio') return '/audio/generations';
  return '/chat/completions';
}

// ------------------------------------------------------------------ 小工具

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const CARD = 'rounded-lg border border-[var(--af-border)] bg-[var(--af-surface-raised)]';
/**
 * 表单控件的基础样式，**不含宽度**。
 *
 * 为什么必须拆开（2026-10-16 用户报「看不到模型名称」的根因）：
 * Tailwind 产物里 `.w-full` 排在 `.w-28` 之后（同一优先级、后写的赢），所以
 * `${INPUT} w-28` 上的 `w-28` 会被 `w-full` 完全盖掉 —— 行内的类型下拉就变成整行宽，
 * 而模型名那个 `flex-1`（basis 0）的 span 被挤成 0 宽，整列名字全部看不见。
 * 结论：**要限宽就别带 w-full**，用 INPUT_BASE 自己配宽度；需要占满一行的地方用 INPUT。
 */
const INPUT_BASE =
  'min-w-0 rounded-lg border border-[var(--af-border)] bg-[var(--af-input)] px-3 py-2 text-sm text-[var(--af-text)] outline-none focus:border-[var(--af-info)]';
const INPUT = `${INPUT_BASE} w-full`;
const BUTTON =
  'rounded-lg border border-[var(--af-border-control)] px-3 py-2 text-sm font-medium text-[var(--af-text)] hover:bg-[var(--af-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--af-focus)] disabled:cursor-not-allowed disabled:opacity-40';
const BUTTON_PRIMARY =
  'rounded-lg bg-[var(--af-primary)] px-3 py-2 text-sm font-bold text-[var(--af-on-primary)] hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--af-focus)] disabled:cursor-not-allowed disabled:opacity-40';
const LABEL = 'text-sm font-medium text-[var(--af-text-secondary)]';
const MUTED = 'text-xs leading-5 text-[var(--af-text-muted)]';

function button(label: string, className = BUTTON): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

/**
 * `<option>`（v1.85）。不用 `new Option(...)`：那依赖 `Option` 这个浏览器全局，
 * jsdom 的测试宿主只灌了常用全局，没灌它 —— 面板被挂进新设置页之后，回归里
 * 第一帧就抛「Option is not defined」（browser-check 里没事，只有 jsdom 炸）。
 */
function optionElement(label: string, value: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.textContent = label;
  node.value = value;
  return node;
}

/** 模型 ID → 媒体类型（与 host 的 guessChannelModelKind 同一套启发式，界面里可改）。 */
export function guessKind(id: string): ChannelKind {
  const value = id.toLowerCase();
  if (/(?:^|[-_/.])(?:t2v|i2v|v2v|video|veo|sora|kling|seedance|wan2|hunyuanvideo|hailuo|cogvideo|ltx)/.test(value))
    return 'video';
  if (/(?:^|[-_/.])(?:tts|asr|audio|music|voice|speech|suno|mureka|cosyvoice|sambert)/.test(value))
    return 'audio';
  if (
    /(?:^|[-_/.])(?:chat|llm|instruct|vl|vision|deepseek|glm|kimi|moonshot|qwen\d|qwq|gpt-4|gpt-5|gpt-oss|claude|gemini|minimax-m)/.test(
      value,
    )
  )
    return 'text';
  return 'image';
}

async function callApi(body: Record<string, unknown>): Promise<ChannelsPayload> {
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | (ChannelsPayload & { error?: string; hint?: string; code?: string })
    | null;
  if (!response.ok) {
    const message = payload?.error || `请求失败（HTTP ${response.status}）`;
    throw new Error(payload?.hint ? `${message}（${payload.hint}）` : message);
  }
  return payload ?? {};
}

async function loadChannels(): Promise<ChannelsPayload> {
  const response = await fetch(API, { cache: 'no-store' });
  if (!response.ok) throw new Error(`读取通道失败（HTTP ${response.status}）`);
  return ((await response.json().catch(() => ({}))) ?? {}) as ChannelsPayload;
}

function draftOf(channel: ChannelDto, index: number): ChannelDraft {
  return {
    key: `c${index}`,
    id: channel.id,
    label: channel.label ?? channel.id,
    baseUrl: channel.baseUrl ?? '',
    apiKey: '',
    apiKeySet: Boolean(channel.apiKeySet),
    paths: { ...(channel.paths ?? {}) },
    dialect: channel.dialect ?? '',
    timeoutMs: channel.timeoutMs ?? 900_000,
    models: new Map(
      (channel.models ?? []).map((model) => [
        model.id,
        { kind: model.kind, label: model.label ?? '' },
      ]),
    ),
    probed: [],
    probedNote: '',
    modelsOpen: false,
    filter: '',
    dirty: false,
  };
}

function emptyDraft(index: number): ChannelDraft {
  return {
    key: `new${index}`,
    id: '',
    label: '',
    baseUrl: '',
    apiKey: '',
    apiKeySet: false,
    paths: {},
    dialect: '',
    timeoutMs: 900_000,
    models: new Map(),
    probed: [],
    probedNote: '',
    modelsOpen: true,
    filter: '',
    dirty: true,
  };
}

/** 「+ 魔搭 API-Inference」预设草稿：地址、方言与两个图像模型一次填好。 */
function modelscopeDraft(index: number): ChannelDraft {
  const draft = emptyDraft(index);
  draft.key = `ms${index}`;
  draft.label = MODELSCOPE_PRESET.label;
  draft.baseUrl = MODELSCOPE_PRESET.baseUrl;
  // 方言留「自动」：地址已经是魔搭域名，host 会判成 modelscope；显式写死反而在换镜像域名时要改两处
  draft.dialect = '';
  draft.models = new Map(
    MODELSCOPE_PRESET.models.map((model) => [model.id, { kind: model.kind, label: '' }]),
  );
  draft.probed = MODELSCOPE_PRESET.models.map((model) => model.id);
  draft.probedNote =
    '预设的两个模型是手写的：魔搭的 GET /models 只回报少量模型，Qwen/Qwen-Image-2.1-Turbo 不在其中。'
    + '填好 API Key 后点「保存通道」即可在画布模型下拉里选到它（图生图会带上参考图）。';
  return draft;
}

/** 「+ FisherAI（work-fisher）」预设草稿：地址、方言与在用的低价扩展版一次填好。 */
function workfisherDraft(index: number): ChannelDraft {
  const draft = emptyDraft(index);
  draft.key = `wf${index}`;
  draft.label = WORKFISHER_PRESET.label;
  draft.baseUrl = WORKFISHER_PRESET.baseUrl;
  // 同样留「自动」：api.work-fisher.com 这个域名 host 会判成 workfisher
  draft.dialect = '';
  draft.models = new Map(
    WORKFISHER_PRESET.models.map((model) => [model.id, { kind: model.kind, label: '' }]),
  );
  draft.probed = WORKFISHER_PRESET.models.map((model) => model.id);
  draft.probedNote =
    '预设的模型是手写的便捷版；这个网关的 GET /models 其实回报 290 个模型'
    + '（workfisher-image-* 全套都在），想要别的点「读取模型列表」自己勾。'
    + '填好 API Key 后点「保存通道」；出图走异步任务（提交→轮询），参考图会先上传成公网直链。';
  return draft;
}

// ------------------------------------------------------------------ 面板

export function mountCloudChannelPanel(host: HTMLElement): () => void {
  const panel = el('section', 'space-y-4');
  panel.setAttribute(PANEL_ATTRIBUTE, 'true');
  host.prepend(panel);

  let drafts: ChannelDraft[] = [];
  let newCount = 0;
  let disposed = false;
  const globalStatus = el('p', 'text-sm text-[var(--af-text-secondary)]');
  globalStatus.setAttribute('role', 'status');
  const list = el('div', 'space-y-4');

  const setStatus = (message: string, tone: 'info' | 'error' = 'info') => {
    globalStatus.textContent = message;
    globalStatus.className =
      tone === 'error' ? 'text-sm text-[var(--af-warning)]' : 'text-sm text-[var(--af-text-secondary)]';
  };

  /** 保存后：重画列表 + 把注册表灌进全局（不刷新页面也能在模型下拉里看到新模型）。 */
  const applyPayload = (payload: ChannelsPayload, message?: string) => {
    if (disposed) return;
    drafts = (payload.channels ?? []).map((channel, index) => draftOf(channel, index));
    render();
    if (message) setStatus(message);
  };

  const refreshRegistry = async (payload?: ChannelsPayload) => {
    if (payload?.channels) {
      installChannelModelRegistry(payload.channels as unknown as ChannelLike[]);
      window.dispatchEvent(new CustomEvent('fisherai:model-sources-changed'));
      return;
    }
    const result = await refreshChannelModelRegistry();
    if (result) window.dispatchEvent(new CustomEvent('fisherai:model-sources-changed'));
  };

  const snapshot = () => channelModelRegistrySnapshot();

  // ---------------------------------------------------------------- 渲染

  const renderList = () => {
    list.replaceChildren(
      ...(drafts.length
        ? drafts.map((draft) => renderCard(draft))
        : [
            el(
              'p',
              `${CARD} px-5 py-4 text-sm text-[var(--af-text-muted)]`,
              '还没有通道。点上面的「+ 添加通道」。',
            ),
          ]),
    );
  };

  /** 重画整块面板（先 header、再各通道卡片、最后状态行）。 */
  const render = () => {
    if (disposed) return;
    panel.replaceChildren(renderHeader(), list, globalStatus);
    renderList();
  };

  const renderHeader = () => {
    const header = el('div', `${CARD} px-6 py-5 space-y-3`);
    const title = el('div', 'flex items-center gap-3');
    title.append(el('h3', 'text-xl font-bold text-[var(--af-text)]', 'OpenAI 通道'));
    const registry = snapshot();
    const badge = el(
      'span',
      'text-xs px-2 py-0.5 rounded-full font-bold bg-[var(--af-info-bg)] text-[var(--af-info)]',
      `${drafts.length} 条通道 · ${registry.names} 个模型可选`,
    );
    title.append(badge);
    header.append(title);
    header.append(
      el(
        'p',
        MUTED,
        '把你自己买的 OpenAI 兼容端点（中转站、魔搭 API-Inference、自建网关…）加成通道，'
          + '点「读取模型列表」勾选要用的模型 —— 勾中的模型会直接出现在画布节点与助手的模型下拉里，'
          + '画布上的名字默认是「通道名 · 端点模型 ID」（两个通道有同名模型时靠它分辨），'
          + '每条还能单独填「别名」换成好读的名字；发给端点的仍是纯模型 ID；密钥不出本机。',
      ),
    );
    header.append(
      el(
        'p',
        MUTED,
        '「请求方言」决定参考图落在哪个字段、路径与尺寸怎么写：OpenAI 兼容用 image、尺寸给 1024x576；'
          + '魔搭只认 image_url（数组）；FisherAI 走 /image/generations，宽高比给 size、档位给 resolution，'
          + '参考图要先换成公网直链。填错**不会报错** —— 魔搭会把参考图整张丢掉、FisherAI 会把路径错报成 404，'
          + '看到的都像「编辑没生效」。选「自动」就按 Base URL 的域名判定。',
      ),
    );
    const actions = el('div', 'flex flex-wrap items-center gap-3');
    const add = button('+ 添加通道', BUTTON_PRIMARY);
    add.addEventListener('click', () => {
      drafts = [...drafts, emptyDraft(newCount++)];
      render();
      setStatus('填好 Base URL（和 API Key）后点「读取模型列表」，勾选模型再保存。');
    });
    actions.append(add);
    const preset = button('+ 魔搭 API-Inference');
    preset.setAttribute('data-fisherai-channel-preset', 'modelscope');
    preset.addEventListener('click', () => {
      drafts = [...drafts, modelscopeDraft(newCount++)];
      render();
      setStatus(
        '已按魔搭 API-Inference 预设填好地址与两个图像模型（Qwen/Qwen-Image-2.1-Turbo、'
          + 'Qwen/Qwen-Image-Edit）—— 填上 API Key、点「保存通道」即可在画布上用。',
      );
    });
    actions.append(preset);
    const fisherPreset = button('+ FisherAI（work-fisher）');
    fisherPreset.setAttribute('data-fisherai-channel-preset', 'workfisher');
    fisherPreset.addEventListener('click', () => {
      drafts = [...drafts, workfisherDraft(newCount++)];
      render();
      setStatus(
        '已按 FisherAI 预设填好地址（api.work-fisher.com/v1）与图像模型'
          + '（workfisher-image-g-v2.5-lowprice）—— 填上 API Key、点「保存通道」即可在画布上用。',
      );
    });
    actions.append(fisherPreset);
    const reload = button('重新读取');
    reload.addEventListener('click', () => {
      void (async () => {
        try {
          applyPayload(await loadChannels(), '已重新读取。');
        } catch (error) {
          setStatus(error instanceof Error ? error.message : '读取失败。', 'error');
        }
      })();
    });
    actions.append(reload);
    header.append(actions);
    header.append(
      el(
        'p',
        MUTED,
        '提示：这里是**唯一**配云端端点的地方 —— 旧的「自配云端端点（OpenAI 兼容）」单端点卡片'
          + '已在 v1.13 移除，环境变量 AIFISHER_CLOUD_BASE_URL 也不再被读取。',
      ),
    );
    return header;
  };

  const cardStatus = (draft: ChannelDraft) => {
    if (!draft.dirty) return '';
    return '有未保存的修改';
  };

  const renderModels = (draft: ChannelDraft, rerender: () => void, markDirty: () => void) => {
    const box = el('div', 'space-y-2');
    const ids = new Set<string>(draft.models.keys());
    for (const id of draft.probed) ids.add(id);
    const all = [...ids].sort((a, b) => a.localeCompare(b));
    const filter = draft.filter.trim().toLowerCase();
    const visible = filter ? all.filter((id) => id.toLowerCase().includes(filter)) : all;

    const toolbar = el('div', 'flex flex-wrap items-center gap-2');
    const filterInput = el('input', `${INPUT} max-w-xs`, '') as HTMLInputElement;
    filterInput.placeholder = `筛选模型（共 ${all.length} 个）`;
    filterInput.value = draft.filter;
    filterInput.setAttribute('data-fisherai-channel-filter', '');
    filterInput.addEventListener('input', () => {
      draft.filter = filterInput.value;
      const fresh = renderModels(draft, rerender, markDirty);
      box.replaceWith(fresh);
    });
    toolbar.append(filterInput);
    // 注意：这里**不能**用 INPUT（它带 w-full，会占满一行并把后面的按钮顶到下一行）
    const allKind = el('select', `${INPUT_BASE} w-40 shrink-0`) as HTMLSelectElement;
    allKind.setAttribute('data-fisherai-channel-mark-kind', '');
    for (const kind of KIND_ORDER) allKind.append(optionElement(KIND_LABELS[kind], kind));
    const markAll = button('把下面列出的都标为');
    markAll.addEventListener('click', () => {
      for (const id of visible) {
        draft.models.set(id, {
          kind: allKind.value as ChannelKind,
          label: draft.models.get(id)?.label ?? '',
        });
      }
      draft.dirty = true;
      rerender();
    });
    const checkAll = button('全选');
    checkAll.addEventListener('click', () => {
      for (const id of visible) {
        draft.models.set(id, {
          kind: draft.models.get(id)?.kind ?? guessKind(id),
          label: draft.models.get(id)?.label ?? '',
        });
      }
      draft.dirty = true;
      rerender();
    });
    const uncheckAll = button('全不选');
    uncheckAll.addEventListener('click', () => {
      for (const id of visible) draft.models.delete(id);
      draft.dirty = true;
      rerender();
    });
    toolbar.append(allKind, markAll, checkAll, uncheckAll);
    box.append(toolbar);

    const rows = el('div', 'max-h-72 overflow-y-auto rounded-lg border border-[var(--af-border)]');
    if (!visible.length) {
      rows.append(
        el(
          'p',
          'px-3 py-4 text-xs text-[var(--af-text-muted)]',
          all.length
            ? '没有匹配的模型。'
            : '还没有模型：点上面的「读取模型列表」从端点取，或在下面手填模型 ID。',
        ),
      );
    }
    for (const id of visible.slice(0, 400)) {
      const current = draft.models.get(id);
      const checked = Boolean(current);
      /**
       * 行结构：勾选框 · 模型 ID · 类型 · 别名。
       *
       * 三个都必须 `shrink-0` + 明确宽度（除了 ID 那个 flex-1），否则长模型 ID
       * 会把这些控件压扁；反过来 ID 用 `min-w-0 flex-1 truncate` 才不会被挤成 0 宽。
       * 行**不再是 `<label>`**：里面的 select/input 一旦被 label 包住，点它们会有
       * 「连带勾选/取消勾选」的行为（改名时很致命），所以改成 div + 点名字切换勾选。
       */
      const row = el('div', 'flex items-center gap-3 px-3 py-1.5 hover:bg-[var(--af-hover)]');
      row.setAttribute('data-fisherai-channel-model-row', id);
      const box_ = el('input', 'shrink-0') as HTMLInputElement;
      box_.type = 'checkbox';
      box_.checked = checked;
      box_.setAttribute('data-fisherai-channel-model-check', id);
      box_.setAttribute('aria-label', `选择模型 ${id}`);
      const toggle = () => {
        if (draft.models.has(id)) draft.models.delete(id);
        else draft.models.set(id, { kind: guessKind(id), label: '' });
        draft.dirty = true;
        rerender();
      };
      box_.addEventListener('change', toggle);
      // 名字这一列是「看不见模型名称」那个 bug 的窗口：必须能撑开、能截断、悬停可看全
      const name = el(
        'span',
        'min-w-0 flex-1 cursor-pointer truncate text-sm text-[var(--af-text)]',
        id,
      );
      name.setAttribute('data-fisherai-channel-model-id', id);
      name.title = id;
      name.addEventListener('click', toggle);

      const kindSelect = el('select', `${INPUT_BASE} w-24 shrink-0`) as HTMLSelectElement;
      kindSelect.setAttribute('data-fisherai-channel-model-kind', id);
      for (const kind of KIND_ORDER) kindSelect.append(optionElement(KIND_LABELS[kind], kind));
      kindSelect.value = current?.kind ?? guessKind(id);
      kindSelect.disabled = !checked;
      kindSelect.addEventListener('change', () => {
        const entry = draft.models.get(id);
        if (!entry) return;
        entry.kind = kindSelect.value as ChannelKind;
        markDirty();
      });

      const labelInput = el('input', `${INPUT_BASE} w-40 shrink-0`, '') as HTMLInputElement;
      labelInput.setAttribute('data-fisherai-channel-model-label', id);
      labelInput.placeholder = '别名（可选）';
      labelInput.maxLength = MAX_MODEL_LABEL_LENGTH;
      labelInput.value = current?.label ?? '';
      labelInput.disabled = !checked;
      labelInput.title = `自定义显示名：画布上就显示这个名字（留空 = ${draft.label || '通道名'} · ${id}）`;
      // 这里**只改草稿不重画**：一重画输入框就失焦，边打字边丢字。
      labelInput.addEventListener('input', () => {
        const entry = draft.models.get(id);
        if (!entry) return;
        entry.label = labelInput.value;
        markDirty();
      });

      row.append(box_, name, kindSelect, labelInput);
      rows.append(row);
    }
    if (visible.length > 400) {
      rows.append(el('p', 'px-3 py-2 text-xs text-[var(--af-text-muted)]', `只显示前 400 个（共 ${visible.length} 个），用筛选缩小范围。`));
    }
    box.append(rows);
    box.append(
      el(
        'p',
        MUTED,
        '勾中的模型会进画布模型下拉：默认名字是「通道名 · 端点模型 ID」（两个通道有同名模型时靠它分辨），'
          + '在行尾「别名」里填一个短名字就改用别名 —— 别名就是画布节点上存的那串名字，'
          + '所以别让两条通道的别名撞车。发给端点的永远是纯模型 ID。',
      ),
    );

    const manual = el('div', 'flex items-center gap-2');
    const manualInput = el('input', `${INPUT} max-w-sm`) as HTMLInputElement;
    manualInput.placeholder = '手填模型 ID（例如 Qwen/Qwen-Image）';
    manualInput.setAttribute('data-fisherai-channel-manual-id', '');
    const manualAdd = button('添加');
    manualAdd.addEventListener('click', () => {
      const id = manualInput.value.trim();
      if (!id) return;
      const existing = draft.models.get(id);
      draft.models.set(id, { kind: existing?.kind ?? guessKind(id), label: existing?.label ?? '' });
      if (!draft.probed.includes(id)) draft.probed = [...draft.probed, id];
      draft.dirty = true;
      rerender();
    });
    manual.append(manualInput, manualAdd);
    box.append(manual);
    if (draft.probedNote) box.append(el('p', MUTED, draft.probedNote));
    return box;
  };

  const renderCard = (draft: ChannelDraft) => {
    const card = el('section', `${CARD} px-5 py-4 space-y-3`);
    card.setAttribute('data-fisherai-cloud-channel', draft.id || draft.key);
    const rerenderCard = () => {
      const fresh = renderCard(draft);
      card.replaceWith(fresh);
    };

    const head = el('div', 'flex flex-wrap items-center gap-3');
    const labelInput = el('input', `${INPUT} max-w-xs`) as HTMLInputElement;
    labelInput.value = draft.label;
    labelInput.placeholder = '通道名称（例如 魔搭 / 我的中转）—— 会出现在画布模型名前，起短一点更好读';
    labelInput.addEventListener('input', () => {
      draft.label = labelInput.value;
      draft.dirty = true;
    });
    const state = el(
      'span',
      `text-xs px-2 py-0.5 rounded-full font-bold ${
        draft.apiKeySet
          ? 'bg-[var(--af-success-bg)] text-[var(--af-success)]'
          : 'bg-[var(--af-surface-raised)] text-[var(--af-text-muted)]'
      }`,
      draft.apiKeySet ? '密钥已保存' : '未配置密钥',
    );
    const openToggle = button(draft.modelsOpen ? '收起模型' : `模型（${draft.models.size}）`);
    openToggle.setAttribute('data-fisherai-channel-models-toggle', '');
    openToggle.addEventListener('click', () => {
      draft.modelsOpen = !draft.modelsOpen;
      rerenderCard();
    });
    const remove = button('删除');
    remove.addEventListener('click', () => {
      if (!draft.id) {
        drafts = drafts.filter((item) => item.key !== draft.key);
        render();
        return;
      }
      if (!window.confirm(`删除通道「${draft.label || draft.id}」？画布上用到它模型的节点会失效。`)) return;
      void (async () => {
        try {
          const payload = await callApi({ action: 'delete', id: draft.id });
          applyPayload(payload, `已删除通道「${draft.label || draft.id}」。`);
          await refreshRegistry(payload);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : '删除失败。', 'error');
        }
      })();
    });
    head.append(labelInput, state, openToggle, remove);
    card.append(head);

    const status = el('p', MUTED, cardStatus(draft));
    status.setAttribute('role', 'status');

    /** 就地改草稿（打字时不重画，免得输入框失焦）时把「有未保存的修改」刷出来。 */
    const markDirty = () => {
      draft.dirty = true;
      status.textContent = cardStatus(draft);
    };

    const baseRow = el('div', 'grid gap-3 md:grid-cols-3');
    const baseField = el('label', 'space-y-1');
    baseField.append(el('span', LABEL, 'Base URL'));
    const baseInput = el('input', INPUT) as HTMLInputElement;
    baseInput.value = draft.baseUrl;
    baseInput.placeholder = 'https://api-inference.modelscope.cn/v1';
    baseInput.addEventListener('input', () => {
      draft.baseUrl = baseInput.value;
      draft.dirty = true;
      status.textContent = cardStatus(draft);
      // 「自动」时把判定结果跟着地址实时刷出来（host 那边同一套规则）
      dialectHint.textContent = dialectHintText(draft);
    });
    baseField.append(baseInput, el('span', MUTED, 'OpenAI 兼容端点的根地址（含 /v1）；不带结尾斜杠。'));
    const keyField = el('label', 'space-y-1');
    keyField.append(el('span', LABEL, 'API Key'));
    const keyInput = el('input', INPUT) as HTMLInputElement;
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.placeholder = draft.apiKeySet ? '•••••••• · 已保存（留空即保持不变）' : '未配置';
    keyInput.addEventListener('input', () => {
      draft.apiKey = keyInput.value;
      draft.dirty = true;
      status.textContent = cardStatus(draft);
    });
    keyField.append(keyInput, el('span', MUTED, '密钥只存在本机 host（cloud-channels.json），界面永不回显。'));

    /**
     * 请求方言：**参考图放哪个字段**。配错不会报错，只会静默丢掉参考图
     * （2026-10-17 实测魔搭：`image` 时「图片编辑」变成「重新画一张」），所以这一项必须能看见、能改。
     */
    const dialectField = el('label', 'space-y-1');
    dialectField.append(el('span', LABEL, '请求方言'));
    const dialectSelect = el('select', INPUT) as HTMLSelectElement;
    dialectSelect.setAttribute('data-fisherai-channel-dialect', draft.id || draft.key);
    dialectSelect.append(optionElement('自动（按地址判定）', ''));
    for (const dialect of ['openai', 'modelscope', 'workfisher'] as const) {
      dialectSelect.append(optionElement(DIALECT_LABELS[dialect], dialect));
    }
    dialectSelect.value = draft.dialect;
    const dialectHint = el('span', MUTED, dialectHintText(draft));
    dialectSelect.addEventListener('change', () => {
      draft.dialect = dialectSelect.value as ChannelDialect | '';
      draft.dirty = true;
      status.textContent = cardStatus(draft);
      dialectHint.textContent = dialectHintText(draft);
    });
    dialectField.append(dialectSelect, dialectHint);

    baseRow.append(baseField, keyField, dialectField);
    card.append(baseRow);

    const advanced = el('details', 'space-y-2');
    advanced.append(el('summary', 'text-xs text-[var(--af-text-secondary)]', '高级：按类型的路径与超时'));
    const pathRow = el('div', 'grid gap-2 md:grid-cols-4 pt-2');
    for (const kind of KIND_ORDER) {
      const field = el('label', 'space-y-1');
      field.append(el('span', MUTED, `${KIND_LABELS[kind]}路径`));
      const input = el('input', INPUT) as HTMLInputElement;
      input.value = draft.paths[kind] ?? '';
      input.placeholder = `/…（默认 ${defaultPathFor(
        draft.dialect === '' ? guessDialect(draft.baseUrl) : draft.dialect,
        kind,
      )}）`;
      input.addEventListener('input', () => {
        const value = input.value.trim();
        if (value) draft.paths[kind] = value;
        else delete draft.paths[kind];
        draft.dirty = true;
      });
      field.append(input);
      pathRow.append(field);
    }
    const timeoutField = el('label', 'space-y-1');
    timeoutField.append(el('span', MUTED, '超时（毫秒）'));
    const timeoutInput = el('input', INPUT) as HTMLInputElement;
    timeoutInput.value = String(draft.timeoutMs);
    timeoutInput.addEventListener('input', () => {
      const value = Number(timeoutInput.value);
      if (Number.isFinite(value) && value >= 5000) draft.timeoutMs = Math.trunc(value);
      draft.dirty = true;
    });
    timeoutField.append(timeoutInput);
    advanced.append(pathRow, timeoutField);
    card.append(advanced);

    if (draft.modelsOpen) card.append(renderModels(draft, rerenderCard, markDirty));

    const footer = el('div', 'flex flex-wrap items-center gap-3');
    const probe = button('读取模型列表');
    probe.addEventListener('click', () => {
      void (async () => {
        probe.disabled = true;
        status.textContent = '正在读取端点模型列表…';
        try {
          const result = (await callApi({
            action: 'probe',
            ...(draft.id ? { id: draft.id } : {}),
            baseUrl: draft.baseUrl,
            ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
          })) as ChannelsPayload & { models?: string[]; total?: number | null; notes?: string[]; endpoint?: string };
          const models = Array.isArray(result.models) ? result.models : [];
          draft.probed = models;
          draft.modelsOpen = true;
          draft.probedNote = `来自 ${result.endpoint ?? draft.baseUrl}/models：${models.length} 个模型${
            Array.isArray(result.notes) && result.notes.length ? ` · ${result.notes.join(' ')}` : ''
          }`;
          status.textContent = models.length
            ? `读到 ${models.length} 个模型，勾选要用的（类型可逐条改），然后保存。`
            : '这个端点没有回报任何模型，请用下面的「手填模型 ID」。';
          rerenderCard();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : '读取失败。';
        } finally {
          probe.disabled = false;
        }
      })();
    });
    const save = button('保存通道', BUTTON_PRIMARY);
    save.addEventListener('click', () => {
      void (async () => {
        save.disabled = true;
        status.textContent = '保存中…';
        try {
          const payload = await callApi({
            action: 'save',
            channel: {
              ...(draft.id ? { id: draft.id } : {}),
              label: draft.label || draft.baseUrl,
              baseUrl: draft.baseUrl,
              ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
              paths: draft.paths,
              // 空串 = 自动（host 的 sanitizeChannel 会把它当缺省，按地址判定）
              dialect: draft.dialect,
              timeoutMs: draft.timeoutMs,
              models: [...draft.models].map(([id, model]) => ({
                id,
                kind: model.kind,
                ...(model.label.trim() ? { label: model.label.trim() } : {}),
              })),
            },
          });
          applyPayload(payload, `已保存「${draft.label || draft.baseUrl}」的通道与模型。`);
          await refreshRegistry(payload);
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : '保存失败。';
          save.disabled = false;
        }
      })();
    });
    footer.append(save, probe, status);
    card.append(footer);
    return card;
  };

  // 首次加载
  void (async () => {
    try {
      const payload = await loadChannels();
      drafts = (payload.channels ?? []).map((channel, index) => draftOf(channel, index));
      render();
      await refreshRegistry(payload);
      const registry = snapshot();
      setStatus(
        drafts.length
          ? `${drafts.length} 条通道已读取；当前 ${registry.names} 个通道模型可选（画布模型下拉里能看到）。`
          : '通道与密钥都存在本机画布数据目录的 cloud-channels.json 里，不会上传到任何地方。',
      );
    } catch (error) {
      render();
      setStatus(error instanceof Error ? error.message : '读取通道失败。', 'error');
    }
  })();

  return () => {
    disposed = true;
    panel.remove();
  };
}

interface PanelHolder {
  __FISHERAI_MOUNT_CLOUD_CHANNELS__?: (host: HTMLElement) => void;
}

/**
 * 注册「设置页挂载点」的全局（vendor 补丁 3.8h 会在挂完闭源服务页之后调它）。
 * 返回撤销函数（画布卸载时摘掉全局）。
 */
export function registerCloudChannelPanel(): () => void {
  const holder = globalThis as unknown as PanelHolder;
  holder.__FISHERAI_MOUNT_CLOUD_CHANNELS__ = (host: HTMLElement) => {
    try {
      mountCloudChannelPanel(host);
    } catch (error) {
      // 面板挂不上不该拦住设置页（vendor 那一行调用点没有 try）
      console.error('[aifisher-canvas] 挂载「OpenAI 通道」面板失败', error);
    }
  };
  return () => {
    if (holder.__FISHERAI_MOUNT_CLOUD_CHANNELS__) delete holder.__FISHERAI_MOUNT_CLOUD_CHANNELS__;
  };
}
