/**
 * 合成器参数的单位与范围 —— 只影响界面，不改变存储值。
 *
 * 为什么单独一层：用户 2026-10-29 报「色相饱和节点稍微移动一点点就超过预期了，
 * 0 到 1 这个取值不是很合理」。根因是滑块把「0..1 的归一化值」直接摆给用户看：
 * 色相 -1..1 横跨 720°，一条 100px 的滑轨每像素 7°；饱和度显示 0.35 也读不出是多少。
 * 现在存储值仍是引擎用的归一化数（老项目里的 params 不用迁移），界面按专业单位显示：
 *   色相 ±180°（1° 步进）、饱和度/明度 ±100%、色温 2000–12000K、曝光 EV……
 * 滑块本身也在 editor.ts 里换成了全宽 + Shift 微调 + 双击复位。
 */

export interface ParamMeta {
  label: string;
  /** 显示单位下的最小值（不是存储值）。 */
  min: number;
  max: number;
  /** 显示单位下的步进。 */
  step: number;
  /** 显示值 = 存储值 × scale；缺省 1。 */
  scale?: number;
  /** 单位后缀（° / % / K / EV）。 */
  unit?: string;
  /** 数字框的小数位；缺省按 step 推断。 */
  digits?: number;
}

/**
 * 所有数字参数的显示口径。
 *
 * 色相刻意收紧到 ±180°：0..1 那套里 ±1 = 整圈 720°，滑块动一格就是几度；
 * ±180° 已经覆盖全部色相（超过半圈就是往回绕），再配合 Shift 微调就够了。
 */
export const PARAM_META: Record<string, ParamMeta> = {
  brightness: { label: '亮度', min: -100, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  contrast: { label: '对比度', min: -100, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  // 色彩平衡（四轮调色）的数字不走这套通用口径：它的界面在 wheels-ui.ts 里自己画，
  // 数值就是参照图上的 0.00 / 1.00 / 25.00，没有 ±100% 换算。
  exposure: { label: '曝光', min: -4, max: 4, step: 0.05, unit: 'EV', digits: 2 },
  gamma: { label: 'Gamma', min: 0.1, max: 4, step: 0.01, digits: 2 },
  hue: { label: '色相', min: -180, max: 180, step: 1, scale: 360, unit: '°', digits: 0 },
  saturation: { label: '饱和度', min: -100, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  lightness: { label: '明度', min: -100, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  amount: { label: '强度', min: 0, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  softness: { label: '柔和', min: 0, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  roundness: { label: '圆度', min: 0, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  radius: { label: '半径', min: 0, max: 64, step: 1, digits: 0 },
  factor: { label: '混合', min: 0, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  width: { label: '宽度', min: 5, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  height: { label: '高度', min: 5, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  angle: { label: '角度', min: 0, max: 360, step: 1, unit: '°', digits: 0 },
  offset: { label: '偏移', min: -50, max: 50, step: 1, scale: 100, unit: '%', digits: 0 },
  translateX: { label: 'X', min: -50, max: 50, step: 1, scale: 100, unit: '%', digits: 0 },
  translateY: { label: 'Y', min: -50, max: 50, step: 1, scale: 100, unit: '%', digits: 0 },
  scale: { label: '缩放', min: 10, max: 300, step: 1, scale: 100, unit: '%', digits: 0 },
  rotation: { label: '旋转', min: -180, max: 180, step: 1, unit: '°', digits: 0 },
  temperature: { label: '色温', min: 2000, max: 12000, step: 50, unit: 'K', digits: 0 },
  tint: { label: '色调', min: -100, max: 100, step: 1, scale: 100, unit: '%', digits: 0 },
  // 布尔参数只用到标签（控件是勾选框）
  invert: { label: '反相', min: 0, max: 1, step: 1, digits: 0 },
};

/** 没有登记的参数用旧口径兜底（-1..1），别让新参数把界面搞崩。 */
export function paramMeta(key: string): ParamMeta {
  return (
    PARAM_META[key] || {
      label: key,
      min: -1,
      max: 1,
      step: 0.01,
      digits: 2,
    }
  );
}

export function scaleOf(key: string): number {
  const scale = paramMeta(key).scale;
  return typeof scale === 'number' && Number.isFinite(scale) && scale !== 0 ? scale : 1;
}

/** 存储值 → 显示值。 */
export function toDisplay(key: string, raw: number): number {
  return (Number.isFinite(raw) ? raw : 0) * scaleOf(key);
}

/** 显示值 → 存储值。 */
export function toRaw(key: string, display: number): number {
  return (Number.isFinite(display) ? display : 0) / scaleOf(key);
}

/** 数字框里那一串（含单位）。 */
export function formatParam(key: string, raw: number): string {
  const meta = paramMeta(key);
  const value = toDisplay(key, raw);
  const digits = typeof meta.digits === 'number' ? meta.digits : meta.step >= 1 ? 0 : 2;
  const rounded = Math.abs(value) < 10 ** -digits / 2 ? 0 : value;
  const text = rounded.toFixed(digits);
  return `${text}${meta.unit || ''}`;
}

/** 滑块/数字框的显示范围。 */
export function displayBounds(key: string): { min: number; max: number; step: number } {
  const meta = paramMeta(key);
  return { min: meta.min, max: meta.max, step: meta.step };
}

/** 数字框里输入的是显示值；解析失败就当没改。 */
export function parseDisplay(key: string, text: string): number | null {
  const cleaned = String(text)
    .replace(/[^\d.+-]/g, '')
    .trim();
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return clampRaw(key, toRaw(key, value));
}

export function clampRaw(key: string, raw: number): number {
  const meta = paramMeta(key);
  const low = toRaw(key, meta.min);
  const high = toRaw(key, meta.max);
  return Math.max(Math.min(low, high), Math.min(Math.max(low, high), raw));
}

/** 是不是「双向」参数：滑块填充从中间往两边长。 */
export function isBipolar(key: string): boolean {
  const meta = paramMeta(key);
  return meta.min < 0 && meta.max > 0;
}
