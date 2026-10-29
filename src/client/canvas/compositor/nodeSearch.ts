/**
 * Shift+A 添加节点的模糊搜索（用户 2026-10-30：「shift+a可以模糊输入查找节点」）。
 *
 * 为什么单独一层：匹配规则要能回归（不依赖 DOM），菜单只管把 results 画出来。
 * 匹配口径：
 *   ① 中文名**子序列**匹配（"平" → 色彩平衡；"色饱" → 色相/饱和度）；
 *   ② 拼音首字母（"scph" → 色彩平衡，"q x" → 曲线），中文输入法只敲首字母也能找；
 *   ③ 英文 / kind 名（"blur" → 模糊，"color balance" → 色彩平衡，空格忽略）；
 *   ④ 分段奖励：连在一起、命中词首的分数更高，所以 "hh" 排在最前的是「混合」。
 * 一个查询词都可能命中，空查询 = 全部。
 */

import { NODE_SPECS, type CompositorKind } from './graph';

/** 菜单里可以新建的节点（输入/输出/预览是固定节点，不参与搜索）。 */
const CREATABLE: CompositorKind[] = (Object.keys(NODE_SPECS) as CompositorKind[]).filter(
  (kind) => kind !== 'input' && kind !== 'output' && kind !== 'viewer',
);

/**
 * 每种节点的检索别名：拼音首字母 + 英文名 + 近义写法。
 * 不做完整拼音（B 大卡），首字母已经够用，而且不会因为多音字匹配错。
 */
const ALIASES: Record<string, string> = {
  reroute: 'zjd reroute 转接',
  colorBalance: 'scph colorbalance balance 调色 色彩平衡',
  whiteBalance: 'bph whitebalance 白平衡',
  curves: 'qx curves curve 曲线',
  hueSaturation: 'xbhd huesaturation hue saturation 色相饱和度',
  brightnessContrast: 'lddbd brightness contrast 亮度对比度',
  exposure: 'bg exposure 曝光',
  gamma: 'gamma 伽马',
  mix: 'hh mix blend 混合',
  alphaOver: 'alpha sd alphaover over 上叠 叠加',
  blur: 'mh blur 模糊',
  sharpen: 'rh sharpen 锐化',
  vignette: 'aj vignette 暗角',
  grain: 'kl grain noise 颗粒',
  transform: 'bh transform 变换',
  ellipseMask: 'tymb ellipsemask ellipse mask 椭圆蒙版',
  boxMask: 'jxmb boxmask box rectangle mask 矩形蒙版',
  gradientMask: 'jbmb gradientmask gradient mask 渐变蒙版',
};

export interface NodeSearchHit {
  kind: CompositorKind;
  label: string;
  category: string;
  score: number;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s/\\_\-·（）()]+/g, '');
}

/**
 * 子序列匹配打分：0 = 不匹配。
 * 每个命中的字符 1 分；连续命中 +1；命中词首（开头或紧跟分隔符）+2；
 * 最后按目标串长度轻微归一 —— 短名字在同等匹配下更靠前。
 */
export function fuzzyScore(query: string, text: string): number {
  const q = normalize(query);
  const t = normalize(text);
  if (!q) return 0;
  if (!t) return 0;
  if (q === t) return 100;
  const substring = t.indexOf(q);
  if (substring >= 0) {
    // 整段命中：按命中位置给分（越靠前越好），再加长度奖励
    return 60 + q.length * 2 + (substring === 0 ? 10 : 0) - Math.min(10, t.length - q.length);
  }
  let score = 0;
  let cursor = 0;
  let lastIndex = -1;
  for (const char of q) {
    const found = t.indexOf(char, cursor);
    if (found < 0) return 0;
    score += 1;
    if (found === lastIndex + 1) score += 1;
    const previous = found > 0 ? t[found - 1] : '';
    if (!previous || !/[a-z0-9]/.test(previous)) score += 2;
    lastIndex = found;
    cursor = found + 1;
  }
  return Math.max(1, score - Math.min(6, Math.max(0, t.length - q.length - 2) * 0.5));
}

/** 一个节点对一条查询的最佳分数（名字 / kind / 分类 / 别名里取最高）。 */
export function nodeMatchScore(kind: CompositorKind, query: string): number {
  const spec = NODE_SPECS[kind];
  const candidates = [spec.label, kind, spec.category, ALIASES[kind] ?? ''];
  let best = 0;
  for (const candidate of candidates) best = Math.max(best, fuzzyScore(query, candidate));
  return best;
}

/**
 * 搜索节点：空查询按分类顺序返回全部；否则按分数降序（同分保持分类顺序）。
 * 菜单直接用这个列表分节渲染。
 */
export function searchNodeKinds(query: string): NodeSearchHit[] {
  const trimmed = query.trim();
  const hits: NodeSearchHit[] = [];
  CREATABLE.forEach((kind, order) => {
    const score = trimmed ? nodeMatchScore(kind, trimmed) : 1;
    if (!score) return;
    hits.push({
      kind,
      label: NODE_SPECS[kind].label,
      category: NODE_SPECS[kind].category,
      // 空查询按原始顺序；有查询时用「分数 - 序号」保持同分稳定
      score: score * 1000 - order,
    });
  });
  if (trimmed) hits.sort((a, b) => b.score - a.score);
  return hits;
}

/** 回归用：菜单里可以新建的节点总数（不含输入/输出/预览）。 */
export function creatableNodeCount(): number {
  return CREATABLE.length;
}
