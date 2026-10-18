/**
 * 提示词预设 / 创意库 / 提示词助手（host 半）。
 *
 * 上游这三块各有自己的后端文件；本插件把它们收进 /api/aifisher/canvas/*：
 *
 *   GET    /prompts/config                      提示词预设清单（PromptPresetConfig）
 *   POST   /prompts                             新建预设 → { success:true, preset }
 *   DELETE /prompts/<type>/<category>/<title>   删除预设 → { success:true }
 *   GET    /prompts/creative-library            收藏 + 自定义创意预设（SavedLibrary）
 *   POST   /prompts/creative-library            增量保存（favoriteChanges/customUpserts/customDeletes）→ SavedLibrary
 *   POST   /prompt-assistant/optimize-prompt    { prompt } → { optimizedPrompt }
 *   POST   /prompt-assistant/describe-image     { projectId, imageUrl, prompt? } → { description }
 *
 * 契约要点（来自 vendor 的 promptPresets.ts / CreativeLibrary.tsx / promptAssistant.ts）：
 *   - 预设清单的路径上游写在**站点根** `/library/prompts/prompt.json`，
 *     vendor 阶段已改写成 `/api/aifisher/canvas/prompts/config`（见 scripts/vendor-aifisher.mjs 3.8b 段）；
 *   - POST/DELETE 都必须回 `{success:true}`（usePromptMutation 只认它，60 秒超时）；
 *   - DELETE 的路由段是 `encodeURIComponent` 后拼 `/`，**不会转义 `-` 以外的斜杠**，
 *     所以 category/title 里带 `/` 会多出段：这里把第 3 段之后全部当 title 拼回去；
 *   - creative-library 的 GET/POST 都返回同一份 SavedLibrary；POST 是增量语义；
 *   - prompt-assistant 的错误体是 `{error, code, retryable}`（不是 message）。
 *
 * 落盘：<画布数据目录>/prompts.json（原子写）。
 *
 * 提示词助手的语义：本插件没有内置大模型，它走**用户自配的 OpenAI 通道**
 * （v1.13 起：取第一条带「文本」模型的通道；旧版单端点 `AIFISHER_CLOUD_BASE_URL` 已随那张
 * 设置卡片一起移除，见 host/canvas/sourceSettingsRouter.ts 的说明）。
 * 没配就回 501 + `PROMPT_ASSISTANT_NOT_CONFIGURED`（可读的说明，而不是 404）。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readJsonBody, sendJson } from '../http/httpUtil';
import {
  buildChannelRequest,
  readCloudChannels,
  type CloudChannel,
  type CloudChannelModel,
} from '../generation/cloudChannels';
import type { MediaStore } from './mediaStore';
import { validCreativePreset } from '../../../vendor/aifisher/src/stable/prompt/creativePresets';

export interface PromptDeps {
  dataDir: string;
  /** 可选：把本插件素材 URL 解析成本机文件（提示词助手看图用）。 */
  mediaStore?: MediaStore;
}

const PRESET_TYPES = ['text', 'image', 'video', 'audio'] as const;
type PresetType = (typeof PRESET_TYPES)[number];

interface PresetItem {
  title: string;
  prompt: string | string[];
  preview?: string;
  [key: string]: unknown;
}
interface PresetCategory {
  name: string;
  items: PresetItem[];
}
interface PromptPresetConfig {
  text: PresetCategory[];
  image: PresetCategory[];
  video: PresetCategory[];
  audio: PresetCategory[];
  [key: string]: unknown;
}
interface SavedLibrary {
  favorites: string[];
  custom: Array<Record<string, unknown>>;
}

/** 单个预设的字段上限（与前端校验对齐）。 */
const MAX_TITLE = 80;
const MAX_PROMPT = 20_000;
const MAX_CATEGORY = 80;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
/** 创意库上限（避免无限膨胀把 prompts.json 撑爆）。 */
const MAX_CUSTOM_PRESETS = 500;
const MAX_FAVORITES = 2_000;

function promptsPath(dataDir: string): string {
  return join(dataDir, 'prompts.json');
}

function emptyConfig(): PromptPresetConfig {
  return { text: [], image: [], video: [], audio: [] };
}

interface StoredPrompts {
  version: 1;
  presets: PromptPresetConfig;
  creative: SavedLibrary;
}

async function readStored(dataDir: string): Promise<StoredPrompts> {
  const file = promptsPath(dataDir);
  const empty: StoredPrompts = { version: 1, presets: emptyConfig(), creative: { favorites: [], custom: [] } };
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<StoredPrompts>;
    const presets = emptyConfig();
    for (const type of PRESET_TYPES) {
      const categories = (parsed.presets as PromptPresetConfig | undefined)?.[type];
      if (!Array.isArray(categories)) continue;
      presets[type] = categories
        .filter(
          (category): category is PresetCategory =>
            Boolean(category) &&
            typeof (category as PresetCategory).name === 'string' &&
            Array.isArray((category as PresetCategory).items),
        )
        .map((category) => ({
          name: category.name,
          items: category.items.filter(
            (item) => item && typeof item.title === 'string' && isPromptValue(item.prompt),
          ),
        }));
    }
    const creative = (parsed.creative as SavedLibrary | undefined) ?? { favorites: [], custom: [] };
    return {
      version: 1,
      presets,
      creative: {
        favorites: Array.isArray(creative.favorites)
          ? creative.favorites.filter((id): id is string => typeof id === 'string')
          : [],
        custom: Array.isArray(creative.custom) ? creative.custom.filter(validCreativePreset) : [],
      },
    };
  } catch {
    return empty;
  }
}

async function writeStored(dataDir: string, data: StoredPrompts): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const file = promptsPath(dataDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

function isPromptValue(value: unknown): value is string | string[] {
  if (typeof value === 'string') return true;
  return Array.isArray(value) && value.every((part) => typeof part === 'string');
}

function cleanText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max) : text;
}

function upsertPreset(
  config: PromptPresetConfig,
  type: PresetType,
  category: string,
  preset: PresetItem,
): void {
  const list = config[type];
  let bucket = list.find((entry) => entry.name === category);
  if (!bucket) {
    bucket = { name: category, items: [] };
    list.push(bucket);
  }
  const index = bucket.items.findIndex((item) => item.title === preset.title);
  if (index >= 0) bucket.items[index] = preset;
  else bucket.items.push(preset);
}

function removePreset(
  config: PromptPresetConfig,
  type: PresetType,
  category: string,
  title: string,
): boolean {
  const list = config[type];
  const bucket = list.find((entry) => entry.name === category);
  if (!bucket) return false;
  const remaining = bucket.items.filter((item) => item.title !== title);
  if (remaining.length === bucket.items.length) return false;
  bucket.items = remaining;
  // 分类空了就把分类也去掉，别在清单里留空壳
  if (remaining.length === 0) config[type] = list.filter((entry) => entry !== bucket);
  return true;
}

/**
 * 提示词助手用哪条通道的哪个模型？
 *
 * 取**第一条带「文本」模型的通道**（通道顺序 = 建通道的先后，见 cloudChannels 的排序），
 * 模型取该通道里第一条文本模型。v1.13 起没有别的选择口径了：旧版单端点 + `AIFISHER_CLOUD_TEXT_MODEL`
 * 已随那张设置卡片移除，要换模型就在通道面板里改勾选/别名。
 */
async function textChannelTarget(
  dataDir: string,
): Promise<{ channel: CloudChannel; model: CloudChannelModel } | null> {
  const channels = await readCloudChannels(dataDir);
  for (const channel of channels) {
    const model = channel.models.find((item) => item.kind === 'text');
    if (model) return { channel, model };
  }
  return null;
}

/** 云端聊天补全（提示词助手用）。没有可用文本通道返回 null。 */
async function cloudChat(deps: PromptDeps, messages: unknown[]): Promise<string | null> {
  const target = await textChannelTarget(deps.dataDir);
  if (!target) return null;
  const plan = buildChannelRequest({
    channel: target.channel,
    model: target.model,
    kind: 'text',
    body: { messages },
  });
  const response = await fetch(plan.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(target.channel.apiKey ? { authorization: `Bearer ${target.channel.apiKey}` } : {}),
    },
    body: JSON.stringify(plan.payload),
    signal: AbortSignal.timeout(Math.min(plan.timeoutMs, 120_000)),
  });
  const raw = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message =
      (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error) ||
      (isRecord(parsed) &&
        isRecord(parsed.error) &&
        typeof parsed.error.message === 'string' &&
        parsed.error.message) ||
      raw.slice(0, 300) ||
      `HTTP ${response.status}`;
    throw new Error(
      `通道「${target.channel.label}」返回错误（HTTP ${response.status}）：${message}`,
    );
  }
  const choices = isRecord(parsed) && Array.isArray(parsed.choices) ? parsed.choices : [];
  const first = choices[0];
  const content =
    isRecord(first) && isRecord(first.message) && typeof first.message.content === 'string'
      ? first.message.content
      : isRecord(parsed) && typeof parsed.text === 'string'
        ? parsed.text
        : '';
  return content.trim() || null;
}

/** 提示词助手的「没配模型」文案（两个动作共用）。 */
const ASSISTANT_NOT_CONFIGURED =
  '提示词助手需要一个文本模型：请在「设置 → 闭源服务 → OpenAI 通道」里添加一条通道，'
  + '点「读取模型列表」勾选一个文本模型并保存。';


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把画布素材/远程图片取成 data URL（describe-image 用）。 */
async function imageToDataUrl(deps: PromptDeps, imageUrl: string): Promise<string | null> {
  if (/^data:/i.test(imageUrl)) return imageUrl;
  const local = deps.mediaStore?.localPathForUrl(imageUrl) ?? null;
  try {
    let bytes: Buffer;
    let mime = 'image/png';
    if (local) {
      bytes = await readFile(local.path);
      const ext = local.filename.slice(local.filename.lastIndexOf('.')).toLowerCase();
      mime =
        ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'image/png';
    } else if (/^https?:\/\//i.test(imageUrl)) {
      const response = await fetch(imageUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      bytes = Buffer.from(await response.arrayBuffer());
      mime = response.headers.get('content-type')?.split(';')[0] ?? mime;
    } else {
      return null;
    }
    if (bytes.length > 20 * 1024 * 1024) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function assistantError(
  res: ServerResponse,
  status: number,
  error: string,
  code: string,
  retryable = false,
): void {
  sendJson(res, status, { error, code, retryable });
}

/** 处理 /prompts/* 与 /prompt-assistant/*；已处理返回 true。 */
export async function handlePromptApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: PromptDeps;
}): Promise<boolean> {
  const { req, res, parts, deps } = input;
  const method = (req.method ?? 'GET').toUpperCase();

  // ---- 提示词助手 ----
  if (parts[0] === 'prompt-assistant') {
    const action = parts[1];
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    if (action === 'optimize-prompt') {
      const body = (await readJsonBody(req, 128 * 1024)) as { prompt?: unknown } | null;
      const prompt = cleanText(body?.prompt, MAX_PROMPT);
      if (!prompt) {
        assistantError(res, 422, '请输入需要优化的提示词', 'PROMPT_EMPTY');
        return true;
      }
      if (!(await textChannelTarget(deps.dataDir))) {
        assistantError(
          res,
          501,
          ASSISTANT_NOT_CONFIGURED,
          'PROMPT_ASSISTANT_NOT_CONFIGURED',
        );
        return true;
      }
      try {
        const optimized = await cloudChat(deps, [
          {
            role: 'system',
            content:
              '你是提示词工程助手。把用户给的提示词改写得更具体、可执行，输出一段可直接用于图像/视频生成的提示词，不要解释、不要加引号。',
          },
          { role: 'user', content: prompt },
        ]);
        if (!optimized) {
          assistantError(res, 502, '云端端点没有返回提示词内容。', 'PROMPT_ASSISTANT_EMPTY', true);
          return true;
        }
        sendJson(res, 200, { optimizedPrompt: optimized });
      } catch (error) {
        assistantError(
          res,
          502,
          error instanceof Error ? error.message : '提示词优化失败。',
          'PROMPT_ASSISTANT_UPSTREAM_ERROR',
          true,
        );
      }
      return true;
    }
    if (action === 'describe-image') {
      const body = (await readJsonBody(req, 64 * 1024)) as {
        projectId?: unknown;
        imageUrl?: unknown;
        prompt?: unknown;
      } | null;
      const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl : '';
      if (!imageUrl) {
        assistantError(res, 422, '缺少要描述的图片地址。', 'IMAGE_URL_MISSING');
        return true;
      }
      if (!(await textChannelTarget(deps.dataDir))) {
        assistantError(
          res,
          501,
          `${ASSISTANT_NOT_CONFIGURED}（描述图片要选一个支持视觉输入的文本模型。）`,
          'PROMPT_ASSISTANT_NOT_CONFIGURED',
        );
        return true;
      }
      const dataUrl = await imageToDataUrl(deps, imageUrl);
      if (!dataUrl) {
        assistantError(res, 422, '读不到这张图片的字节。', 'IMAGE_UNREADABLE');
        return true;
      }
      const extra = cleanText(body?.prompt, 2_000);
      try {
        const description = await cloudChat(deps, [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: extra
                  ? `用中文描述这张图片的画面内容与风格，作为图像生成的提示词。补充要求：${extra}`
                  : '用中文描述这张图片的画面内容与风格，作为图像生成的提示词。',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ]);
        if (!description) {
          assistantError(res, 502, '云端端点没有返回描述内容。', 'PROMPT_ASSISTANT_EMPTY', true);
          return true;
        }
        sendJson(res, 200, { description });
      } catch (error) {
        assistantError(
          res,
          502,
          error instanceof Error ? error.message : '图片描述失败。',
          'PROMPT_ASSISTANT_UPSTREAM_ERROR',
          true,
        );
      }
      return true;
    }
    return false;
  }

  if (parts[0] !== 'prompts') return false;

  // ---- 创意库（收藏 + 自定义预设）----
  if (parts[1] === 'creative-library' && parts.length === 2) {
    const stored = await readStored(deps.dataDir);
    if (method === 'GET') {
      sendJson(res, 200, stored.creative);
      return true;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req, 8 * 1024 * 1024)) as {
        favoriteChanges?: unknown;
        customUpserts?: unknown;
        customDeletes?: unknown;
      } | null;
      if (!body) {
        sendJson(res, 422, { error: '创意库数据无效。', code: 'CREATIVE_INVALID' });
        return true;
      }
      const favorites = new Set(stored.creative.favorites);
      if (Array.isArray(body.favoriteChanges)) {
        for (const change of body.favoriteChanges) {
          if (!isRecord(change) || typeof change.id !== 'string') continue;
          if (change.saved === true) favorites.add(change.id);
          else favorites.delete(change.id);
        }
      }
      let custom = stored.creative.custom;
      if (Array.isArray(body.customUpserts) && body.customUpserts.length) {
        const byId = new Map(
          custom
            .filter((item) => typeof item.id === 'string')
            .map((item) => [String(item.id), item] as const),
        );
        for (const item of body.customUpserts) {
          if (!validCreativePreset(item)) continue;
          byId.set(item.id, item as unknown as Record<string, unknown>);
        }
        custom = [...byId.values()].slice(-MAX_CUSTOM_PRESETS);
      }
      if (Array.isArray(body.customDeletes) && body.customDeletes.length) {
        const removing = new Set(body.customDeletes.filter((id): id is string => typeof id === 'string'));
        custom = custom.filter((item) => !removing.has(String(item.id)));
      }
      const creative: SavedLibrary = {
        favorites: [...favorites].slice(0, MAX_FAVORITES),
        custom,
      };
      await writeStored(deps.dataDir, { ...stored, creative });
      sendJson(res, 200, creative);
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  // ---- 预设清单（上游是站点根的静态 prompt.json，vendor 已改写到这条）----
  if (parts[1] === 'config' && parts.length === 2) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const stored = await readStored(deps.dataDir);
    sendJson(res, 200, stored.presets);
    return true;
  }

  // ---- 新建预设 ----
  if (parts.length === 1) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const body = (await readJsonBody(req, MAX_PREVIEW_BYTES + 1024)) as Record<string, unknown> | null;
    const type = typeof body?.type === 'string' ? body.type : '';
    if (!PRESET_TYPES.includes(type as PresetType)) {
      sendJson(res, 422, { error: '预设类型无效。', code: 'PRESET_TYPE_INVALID' });
      return true;
    }
    const category = cleanText(body?.category, MAX_CATEGORY);
    const title = cleanText(body?.title, MAX_TITLE);
    if (!category || !title) {
      sendJson(res, 422, { error: '分类与名称都不能为空。', code: 'PRESET_NAME_REQUIRED' });
      return true;
    }
    if (!isPromptValue(body?.prompt)) {
      sendJson(res, 422, { error: '提示词内容无效。', code: 'PRESET_PROMPT_INVALID' });
      return true;
    }
    const prompt =
      typeof body?.prompt === 'string'
        ? body.prompt.slice(0, MAX_PROMPT)
        : (body?.prompt as string[]).map((part) => String(part).slice(0, MAX_PROMPT));
    const preview =
      typeof body?.previewBase64 === 'string' && body.previewBase64.startsWith('data:')
        ? body.previewBase64.slice(0, MAX_PREVIEW_BYTES)
        : undefined;
    const preset: PresetItem = { title, prompt, ...(preview ? { preview } : {}) };
    const stored = await readStored(deps.dataDir);
    upsertPreset(stored.presets, type as PresetType, category, preset);
    await writeStored(deps.dataDir, stored);
    sendJson(res, 200, { success: true, preset });
    return true;
  }

  // ---- 删除预设：/prompts/<type>/<category>/<title…> ----
  if (method === 'DELETE' && parts.length >= 4) {
    const type = parts[1];
    if (!PRESET_TYPES.includes(type as PresetType)) {
      sendJson(res, 422, { error: '预设类型无效。', code: 'PRESET_TYPE_INVALID' });
      return true;
    }
    const category = parts[2];
    // category/title 里的 `/` 不会被 encodeURIComponent 转义，第 3 段之后要拼回去
    const title = parts.slice(3).join('/');
    const stored = await readStored(deps.dataDir);
    const removed = removePreset(stored.presets, type as PresetType, category, title);
    if (removed) await writeStored(deps.dataDir, stored);
    sendJson(res, 200, { success: true, removed });
    return true;
  }

  return false;
}

/** 诊断用：提示词预设 / 创意库计数。 */
export async function promptStatus(dataDir: string): Promise<Record<string, unknown>> {
  const stored = await readStored(dataDir);
  return {
    presets: Object.fromEntries(
      PRESET_TYPES.map((type) => [
        type,
        stored.presets[type].reduce((sum, category) => sum + category.items.length, 0),
      ]),
    ),
    favorites: stored.creative.favorites.length,
    customPresets: stored.creative.custom.length,
    file: promptsPath(dataDir),
  };
}
