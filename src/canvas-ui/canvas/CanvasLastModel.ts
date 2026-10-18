/**
 * 「新建节点默认用上一次的模型」（v1.40）。
 *
 * 用户原话（2026-10-18）：
 *   「我刚建完一个节点后需要我再次调整模型，可不可以改成新的节点会默认使用上一次生成任务所使用的模型」
 *
 * 现状是：新建 Image/Video/Audio/Text 节点时，模型 = 模型目录里的第一个（本插件里就是
 * 用户在设置里勾的第一条通道模型，见 CloudChannelModels 的 splice(0,0,…) + vendor 补丁 3.8i）。
 * 只要用户顺手换过模型（第二款、第三个通道），每建一个新节点都得再换一次。
 *
 * 这里记的就是「上一次用的那个模型」：
 *   · 记的时机有两处，都在 vendor 半（补丁 3.8q），靠 window 上的桥回调：
 *       ① 用户在节点上换模型（画布下拉 / composer 的 changeComposerModel → updateCanvasNode）；
 *       ② 真的发起一次生成任务（canvasGeneration 的 handleGenerate 拿到 modelName 的那一刻）。
 *     ② 是用户嘴里的口径（「上一次生成任务所使用的模型」），① 是它的超集：
 *     换过模型还没点生成时，下一次建节点也该是这个模型。
 *   · 用的时机只有一处：createCanvasNode 建新节点时按 kind 问一次（image/video/audio/text 分桶）。
 *     **必须在还留在目录里的模型里挑** —— 通道被删、模型被取消勾选、别名被改了，
 *     记忆里的名字就查不到，此时照旧回落到目录第一个（绝不能把节点写成一条打不通的模型，
 *     那正是 v1.31 用户报的「默认模型不是我配置好的」，点了只回 501）。
 *
 * 落点：本机 localStorage（`dsh-aifisher-canvas.last-model`）。这是「这台机器上我上次用了什么」，
 * 与项目数据无关，所以不进 canvas.json；换台机器/清站点数据就重新学一次。
 * localStorage 不可用（隐私模式 / 被禁）时退化成「本次会话内内存生效」，功能照常。
 *
 * 不 import 任何东西（含 React）：vendor 半只读 window 上的两个函数，回归直接读这一份。
 */

/** 分桶口径与节点类型一一对应（Text 节点用 text 桶）。 */
export type CanvasModelKind = 'image' | 'video' | 'audio' | 'text';

/** localStorage 键名（回归与文档都引用它，别改字符串本身）。 */
export const CANVAS_LAST_MODEL_STORAGE_KEY = 'dsh-aifisher-canvas.last-model';

/** 分桶顺序固定：报告与诊断按这个顺序输出，方便对照。 */
export const CANVAS_MODEL_KINDS: readonly CanvasModelKind[] = ['image', 'video', 'audio', 'text'];

export interface CanvasLastModelSnapshot {
  image: string;
  video: string;
  audio: string;
  text: string;
}

const EMPTY: CanvasLastModelSnapshot = Object.freeze({ image: '', video: '', audio: '', text: '' });

let current: CanvasLastModelSnapshot = { ...EMPTY };
/** 是否已经读过 localStorage（懒读：模块 import 时 localStorage 可能还不存在）。 */
let loaded = false;
/** 存档是否可用（不可用只在报告里留痕，不影响功能）。 */
let storageState: 'unused' | 'ok' | 'unavailable' = 'unused';
/** 写盘次数（诊断读数：不该每帧都写）。 */
let writes = 0;
/** `pickCanvasModel` 的命中/未命中计数（「记忆里的模型已经不在目录里」要有读数）。 */
let hits = 0;
let misses = 0;

function storage(): Storage | null {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

/** 只认这四个桶；别的字符串一律当没记过（防止存档里被写进奇怪键）。 */
export function asCanvasModelKind(value: unknown): CanvasModelKind | null {
  return typeof value === 'string' && (CANVAS_MODEL_KINDS as readonly string[]).includes(value)
    ? (value as CanvasModelKind)
    : null;
}

/** 模型名归一：只留非空字符串，去首尾空白。 */
function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalize(value: unknown): CanvasLastModelSnapshot {
  if (!value || typeof value !== 'object') return { ...EMPTY };
  const record = value as Record<string, unknown>;
  const result: CanvasLastModelSnapshot = { ...EMPTY };
  for (const kind of CANVAS_MODEL_KINDS) result[kind] = normalizeName(record[kind]);
  return result;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (!store) {
    storageState = 'unavailable';
    return;
  }
  try {
    const raw = store.getItem(CANVAS_LAST_MODEL_STORAGE_KEY);
    storageState = 'ok';
    if (!raw) return;
    current = normalize(JSON.parse(raw));
  } catch {
    // 存档坏掉 / 被手改坏：当没记过，下一次写入会覆盖掉它。
    storageState = 'ok';
    current = { ...EMPTY };
  }
}

function persist(): void {
  const store = storage();
  if (!store) {
    storageState = 'unavailable';
    return;
  }
  try {
    store.setItem(CANVAS_LAST_MODEL_STORAGE_KEY, JSON.stringify(current));
    storageState = 'ok';
    writes += 1;
  } catch {
    // 配额满 / 被禁：本次会话内内存里仍然是新的，功能不受影响。
    storageState = 'unavailable';
  }
}

/** 某个桶记着的模型名（没记过就是空串）。 */
export function lastModelFor(kind: unknown): string {
  const bucket = asCanvasModelKind(kind);
  if (!bucket) return '';
  load();
  return current[bucket];
}

/**
 * 记下「这个 kind 上次用的模型」。
 *
 * 返回归一后的名字（非法入参返回空串且不写盘）。名字没变就不写盘 ——
 * 这个函数会被生成入口调用，写盘次数要可控。
 */
export function rememberLastModel(kind: unknown, name: unknown): string {
  const bucket = asCanvasModelKind(kind);
  const model = normalizeName(name);
  if (!bucket || !model) return '';
  load();
  if (current[bucket] === model) return model;
  current = { ...current, [bucket]: model };
  persist();
  return model;
}

/**
 * 建新节点时挑模型：记忆里的那个还留在目录里就用它，否则回落到目录第一个。
 *
 * 返回**目录里的那个名字**（不是记忆里的字符串），保证写进节点的名字一定在目录里；
 * 没记过 / 已经不在目录里都返回空串，调用方自己回落到 `models[0]`。
 */
export function pickCanvasModel(kind: unknown, available: readonly string[]): string {
  const remembered = lastModelFor(kind);
  if (!remembered) return '';
  const match = available.find((candidate) => candidate === remembered);
  if (!match) {
    misses += 1;
    return '';
  }
  hits += 1;
  return match;
}

/**
 * 清空记忆（回归用；也是「想重新学一次」的入口）。
 *
 * `loaded` 故意退回 false：清完之后下一次读写会**重新从存档读一遍**（读到的是空，
 * 与直接清空等价）—— 回归正是靠这一点验「存档坏掉 / 存档里有脏值」的处理，
 * 不必为了测 load 路径重新 import 一份产物。
 */
export function resetCanvasLastModel(): void {
  loaded = false;
  current = { ...EMPTY };
  hits = 0;
  misses = 0;
  const store = storage();
  if (!store) {
    storageState = 'unavailable';
    return;
  }
  try {
    store.removeItem(CANVAS_LAST_MODEL_STORAGE_KEY);
    storageState = 'ok';
  } catch {
    storageState = 'unavailable';
  }
}

/** 排查读数（`__FISHERAI_CANVAS_LAST_MODEL__.report()` 与诊断面板用）。 */
export function canvasLastModelReport(): {
  models: CanvasLastModelSnapshot;
  storage: 'unused' | 'ok' | 'unavailable';
  writes: number;
  hits: number;
  misses: number;
} {
  load();
  return {
    models: { ...current },
    storage: storageState,
    writes,
    hits,
    misses,
  };
}
