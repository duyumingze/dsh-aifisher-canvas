/**
 * ComfyUI 的「字段候选值」快照（host 半）—— v1.20。
 *
 * 用户报障（2026-10-17）：「我想要切换个 lora 模型，但是要我输入文字，能否自动扫描我的
 * comfui 做出列表让我选」。根因不是画布控件不支持下拉（`parameters[].type === 'select'`
 * 早就能渲染成 `<select>`），而是**候选值从哪来**：模板 JSON 里只写着当前那个文件名，
 * 清单里没有别的模型名。真正的候选在 ComfyUI 的 `GET /object_info` 里：
 * 每个节点每个输入的枚举值（`["LoraLoader", {"input": {"required": {"lora_name":
 * [[...所有 lora 文件名...], {}]}}}]`）。
 *
 * 所以这里做三件事：
 *   1. 拉 `/object_info`，把「每个 class_type 每个字段的枚举候选 / 数值上下限」抽出来
 *      压成一份小快照（几十 KB，不是几 MB 的原始 object_info）；
 *   2. 落盘到 `$DSH_HOME/storages/dsh-aifisher-canvas/comfy-widget-options.json` ——
 *      **ComfyUI 没启动也还能用上次扫到的列表**（用户不可能为了填个工作流先把 ComfyUI 拉起来）；
 *   3. 给两处消费者提供**同步**读接口（能力清单 / 工作流配置面板都是同步 API）：
 *      `widgetFieldSpec(classType, field)`。
 *
 * 刷新时机：`GET /api/comfy/widget-options`（面板上的「扫描 ComfyUI」、画布节点挂载时各一次），
 * 快照超过 TTL（默认 5 分钟）才真去拉。所以「在 ComfyUI 里新装了一个 lora →
 * 刷新画布页面 / 点一下扫描」就能出现在下拉里。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../canvas/dataDir';
import type { ComfyClient } from './comfyClient';

/** 一个字段能填什么：枚举候选 + 控件类型 + 数值上下限。 */
export interface WidgetFieldSpec {
  /** select = ComfyUI 的 COMBO（有候选列表）；其余是普通控件 */
  control: 'select' | 'number' | 'text' | 'toggle';
  /** 枚举候选（control === 'select' 时按 ComfyUI 返回的顺序，已去重） */
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

export interface WidgetOptionsSnapshot {
  version: 1;
  /** 拉到这份清单的时间（毫秒） */
  fetchedAt: number;
  /** 当时连的 ComfyUI 地址（诊断用：换过地址就能看出快照是旧的） */
  baseUrl: string;
  /** class_type → 字段名 → 规格 */
  classes: Record<string, Record<string, WidgetFieldSpec>>;
}

/** 单个枚举最多留多少个候选（防某个自定义节点返回几万条把面板拖死）。 */
const MAX_OPTIONS = 4000;
/** 快照 TTL：5 分钟内复用，不重复拉 object_info（几 MB 的响应）。 */
const DEFAULT_TTL_MS = 5 * 60_000;
const SNAPSHOT_FILE = 'comfy-widget-options.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 插件数据根（v1.43 起可自定义，见 canvas/dataDir.ts；与 canvas.json 同级）。 */
function storageRoot(): string {
  return resolveDataDir();
}

/** 快照文件路径（诊断端点会回它，用户想手看也行）。 */
export function widgetOptionsPath(): string {
  return join(storageRoot(), SNAPSHOT_FILE);
}

function ttlMs(): number {
  const raw = Number(process.env.AIFISHER_COMFY_WIDGET_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

// ---------------------------------------------------------------- 解析 object_info

/** 数值型输入的上下限（INT/FLOAT 的 options 里就这几个键有用）。 */
function numericSpec(meta: Record<string, unknown>): WidgetFieldSpec {
  const spec: WidgetFieldSpec = { control: 'number' };
  for (const key of ['min', 'max', 'step'] as const) {
    const value = Number(meta[key]);
    if (meta[key] !== undefined && Number.isFinite(value)) spec[key] = value;
  }
  return spec;
}

/** 一个输入的规格；认不出来（未知类型）返回 null（即「不提供候选，画布按模板值猜控件」）。 */
function parseInputSpec(spec: unknown): WidgetFieldSpec | null {
  if (!Array.isArray(spec) || !spec.length) return null;
  const tag = spec[0];
  const meta = isRecord(spec[1]) ? spec[1] : {};
  // 老式写法：[["a.safetensors", "b.safetensors"], {...}]
  if (Array.isArray(tag)) {
    if (!tag.length || !tag.every((item) => typeof item === 'string')) return null;
    return { control: 'select', options: uniqueStrings(tag as string[]) };
  }
  if (typeof tag !== 'string') return null;
  const type = tag.toUpperCase();
  if (type === 'COMBO') {
    // 新式写法：["COMBO", { options: [...] }]
    const list = Array.isArray(meta.options) ? meta.options : null;
    if (!list || !list.length) return null;
    const strings = list.filter((item): item is string => typeof item === 'string');
    return strings.length ? { control: 'select', options: uniqueStrings(strings) } : null;
  }
  if (type === 'INT' || type === 'FLOAT') return numericSpec(meta);
  if (type === 'BOOLEAN') return { control: 'toggle' };
  if (type === 'STRING') {
    // multiline 文本就是普通输入框（画布那边有大文本框的字段自成一体）
    return { control: 'text' };
  }
  return null;
}

function uniqueStrings(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= MAX_OPTIONS) break;
  }
  return result;
}

/**
 * object_info → 快照。
 * 只保留「能推导出控件规格」的字段，因此产物比 object_info 小两个数量级。
 */
export function parseObjectInfo(
  objectInfo: unknown,
  baseUrl: string,
): WidgetOptionsSnapshot {
  const classes: Record<string, Record<string, WidgetFieldSpec>> = {};
  if (!isRecord(objectInfo)) {
    return { version: 1, fetchedAt: Date.now(), baseUrl, classes };
  }
  for (const [classType, node] of Object.entries(objectInfo)) {
    if (!isRecord(node)) continue;
    const input = isRecord(node.input) ? node.input : null;
    if (!input) continue;
    const fields: Record<string, WidgetFieldSpec> = {};
    for (const group of ['required', 'optional'] as const) {
      const spec = input[group];
      if (!isRecord(spec)) continue;
      for (const [field, raw] of Object.entries(spec)) {
        if (fields[field]) continue; // required 优先
        const parsed = parseInputSpec(raw);
        if (parsed) fields[field] = parsed;
      }
    }
    if (Object.keys(fields).length) classes[classType] = fields;
  }
  return { version: 1, fetchedAt: Date.now(), baseUrl, classes };
}

// ---------------------------------------------------------------- 读写快照

let memory: WidgetOptionsSnapshot | null = null;
/** 读盘只试一次：文件不存在/坏了就别每次请求都 readFile。 */
let diskTried = false;
let loading: Promise<WidgetOptionsSnapshot> | null = null;

function readDisk(): WidgetOptionsSnapshot | null {
  const path = widgetOptionsPath();
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.classes)) return null;
    const fetchedAt = Number(parsed.fetchedAt);
    return {
      version: 1,
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      classes: parsed.classes as WidgetOptionsSnapshot['classes'],
    };
  } catch {
    return null;
  }
}

/** 同步读当前快照（内存优先，其次磁盘；都没有就 null）。 */
export function readWidgetSnapshot(): WidgetOptionsSnapshot | null {
  if (memory) return memory;
  if (!diskTried) {
    diskTried = true;
    memory = readDisk();
  }
  return memory;
}

function writeDisk(snapshot: WidgetOptionsSnapshot): void {
  try {
    const path = widgetOptionsPath();
    mkdirSync(storageRoot(), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, 'utf8');
    renameSync(temp, path);
  } catch {
    // 落盘失败不影响本次内存里的快照（下次启动会重新扫）
  }
}

/** 丢掉内存快照（测试 / 手动刷新用；磁盘那份留着兜底）。 */
export function invalidateWidgetSnapshot(): void {
  memory = null;
  diskTried = true;
}

/** 某个节点某个字段的规格；没有快照/字段不在里面 → null。 */
export function widgetFieldSpec(classType: string, field: string): WidgetFieldSpec | null {
  const snapshot = readWidgetSnapshot();
  if (!snapshot || !classType || !field) return null;
  return snapshot.classes[classType]?.[field] ?? null;
}

/** 某个字段的枚举候选（拿不到就是空数组：调用方退回原来的文本输入框）。 */
export function widgetOptionsFor(classType: string, field: string): string[] {
  const spec = widgetFieldSpec(classType, field);
  return spec?.control === 'select' ? (spec.options ?? []) : [];
}

/** 快照概览（端点回给前端的头部信息 + 面板上的「已扫描 N 个字段」）。 */
export function widgetSnapshotSummary(snapshot: WidgetOptionsSnapshot | null): {
  ok: boolean;
  fetchedAt: number;
  baseUrl: string;
  classes: number;
  fields: number;
  options: number;
  file: string;
} {
  const classes = snapshot ? Object.keys(snapshot.classes).length : 0;
  let fields = 0;
  let options = 0;
  for (const classFields of Object.values(snapshot?.classes ?? {})) {
    for (const spec of Object.values(classFields)) {
      if (spec.control !== 'select') continue;
      fields += 1;
      options += spec.options?.length ?? 0;
    }
  }
  return {
    ok: Boolean(snapshot),
    fetchedAt: snapshot?.fetchedAt ?? 0,
    baseUrl: snapshot?.baseUrl ?? '',
    classes,
    fields,
    options,
    file: widgetOptionsPath(),
  };
}

/**
 * 确保手里有一份不太旧的快照。
 *   - 有新鲜快照（未过 TTL）且没要求 refresh → 直接返回，不发请求；
 *   - 否则拉一次 /object_info；失败时**退回旧快照**（有的话），ComfyUI 没开也能配置工作流。
 */
export async function ensureWidgetSnapshot(
  client: Pick<ComfyClient, 'objectInfo'>,
  options: { refresh?: boolean; baseUrl?: string } = {},
): Promise<WidgetOptionsSnapshot> {
  const cached = readWidgetSnapshot();
  if (!options.refresh && cached && Date.now() - cached.fetchedAt < ttlMs()) return cached;
  if (loading) return loading;
  loading = (async () => {
    try {
      const info = await client.objectInfo();
      const snapshot = parseObjectInfo(info, options.baseUrl ?? '');
      memory = snapshot;
      diskTried = true;
      writeDisk(snapshot);
      return snapshot;
    } catch (error) {
      if (cached) return cached; // 旧快照兜底：UI 至少还有上次的列表
      throw error;
    } finally {
      loading = null;
    }
  })();
  return loading;
}
