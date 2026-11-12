/**
 * 色彩平衡（四轮调色）的求值口径：**显示域 + 按亮度分区**。
 *
 * 为什么改（用户 2026-11-12）：「它色彩平衡节点效果是不是不对，反正效果是乱的，
 * 调暗部会动全局，调高光会动别的」—— 两处硬伤都在这里：
 *   ① 原来按线性域求值。界面上的数字是「百分数」（暗部 +0.20），喂进线性域就相当于
 *      把黑位抬到 48% 灰；把暗部圆点推向蓝，R/G 两通道的负偏移（线性 −0.30）比中间灰
 *      （线性 0.216）还大，整片中间调被剪成纯蓝 —— 于是「动一点点，整张图都变了」。
 *   ② 原来是 ASC CDL 那套 lift/gamma/gain：lift 是全局加、gain 是全局乘，
 *      只有两端固定，中间整段跟着走 —— 所以「调暗部会动全局」。
 *
 * 现在：数字按显示（sRGB 编码）域直接算，0.10 就是十分之一；四个轮子各管一段亮度：
 *   暗部 → 只改黑位（0 → 0.50 递减），中间灰与高光钉住；
 *   中灰 → 只改中间调（pow 的 gamma 形），黑与白钉住；
 *   亮部 → 只改高光（0.50 → 1 递增），黑位钉住；
 *   偏移 → 本来就是全图，整体加减。
 * 分区权重按输入亮度算（BT.709 luma），所以有彩色的暗处也算暗部，和达芬奇/PS 手感一致。
 *
 * 这里放三样东西：
 *   · 分区常数（COLOR_BALANCE_*）—— shader 与参考实现共用同一套数字；
 *   · `colorBalanceShaderBody()` —— 引擎真正跑的 GLSL（插值上面的常数）；
 *   · `applyColorBalance()` —— 与 shader 逐行对应的 JS 参考实现，回归在 jsdom 里直接验
 *     「暗部不动高光」这类口径（jsdom 没有 WebGL，跑不了真 GLSL）。
 * 改公式时两边一起改，回归会盯着。
 */

/**
 * 暗部权重：亮度 0 时 1，到 0.50 衰减到 0。
 *
 * 0.50 这个分界是刻意的：中间灰（0.5）必须**一个像素都不动** —— 用户报的
 * 「调暗部会动全局」最直接的反证就是这里；smoothstep 两端导数为 0，所以过渡仍然平滑。
 */
export const CB_SHADOW_END = 0.5;
/** 亮部权重：亮度 0.50 起上升，1.0 到满（和暗部在中间灰处正好接上）。 */
export const CB_HIGHLIGHT_START = 0.5;
/** 偏移的总量程：界面上 25.00 = 中性，±25 对应 ±0.5（半条亮度量程）。 */
export const CB_OFFSET_SCALE = 50;

export interface ColorBalanceWeights {
  shadow: number;
  mid: number;
  highlight: number;
}

export type ColorBalanceParams = Record<string, unknown>;

function glslFloat(value: number): string {
  return value.toFixed(3);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** GLSL 的 smoothstep（edge0 < edge1）。 */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 输入亮度（BT.709，和 shader 里的 vec3(0.2126, 0.7152, 0.0722) 一致）。 */
export function colorBalanceLuma(rgb: readonly [number, number, number]): number {
  return Math.max(0, Math.min(1, 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]));
}

/** 亮度 → 三个分区的权重（三者和为 1，中间调兜底）。 */
export function colorBalanceWeights(luma: number): ColorBalanceWeights {
  const l = Math.max(0, Math.min(1, Number.isFinite(luma) ? luma : 0));
  const shadow = 1 - smoothstep(0, CB_SHADOW_END, l);
  const highlight = smoothstep(CB_HIGHLIGHT_START, 1, l);
  return { shadow, mid: Math.max(0, 1 - shadow - highlight), highlight };
}

/**
 * 与 shader 逐行对应的参考实现（显示域，输入输出都是 sRGB 编码的 0..1）。
 *
 * 不做上限钳制（中间纹理是 RGBA16F，允许 >1 继续往下走），只兜住负数；
 * shader 那边也是这么写的。
 */
export function applyColorBalance(
  rgb: readonly [number, number, number],
  params: ColorBalanceParams = {},
): [number, number, number] {
  const lift: [number, number, number] = [
    numberOr(params.liftR, 0),
    numberOr(params.liftG, 0),
    numberOr(params.liftB, 0),
  ];
  const gamma: [number, number, number] = [
    numberOr(params.gammaR, 0),
    numberOr(params.gammaG, 0),
    numberOr(params.gammaB, 0),
  ];
  const gain: [number, number, number] = [
    numberOr(params.gainR, 1),
    numberOr(params.gainG, 1),
    numberOr(params.gainB, 1),
  ];
  const offset: [number, number, number] = [
    numberOr(params.offsetR, 25),
    numberOr(params.offsetG, 25),
    numberOr(params.offsetB, 25),
  ];

  const base: [number, number, number] = [
    Math.max(0, rgb[0]),
    Math.max(0, rgb[1]),
    Math.max(0, rgb[2]),
  ];
  const weights = colorBalanceWeights(colorBalanceLuma(base));
  const out: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    let value = base[index];
    // 暗部：只抬/压黑位
    value += lift[index] * weights.shadow;
    // 中灰：pow 形 gamma，黑与白钉住
    const exponent = 1 / Math.max(1 + gamma[index], 0.05);
    value += (Math.pow(Math.max(value, 0), exponent) - value) * weights.mid;
    // 亮部：黑位钉住，往白上乘
    value *= 1 + (gain[index] - 1) * weights.highlight;
    // 偏移：整幅一起加减
    value += (offset[index] - 25) / CB_OFFSET_SCALE;
    out[index] = Math.max(0, value);
  }
  return out;
}

/** 引擎里「色彩平衡」的 fragment body（和 applyColorBalance 同一套公式与常数）。 */
export function colorBalanceShaderBody(): string {
  const shadowEnd = glslFloat(CB_SHADOW_END);
  const highlightStart = glslFloat(CB_HIGHLIGHT_START);
  const offsetScale = glslFloat(CB_OFFSET_SCALE);
  return `
    vec4 texel = texture(u_tex, v_uv);
    // 显示域：界面上的数字就是百分数（不先转线性，否则 0.20 会把黑位抬到 48% 灰）。
    vec3 c = max(texel.rgb, vec3(0.0));
    float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    float wShadow = 1.0 - smoothstep(0.0, ${shadowEnd}, l);
    float wHighlight = smoothstep(${highlightStart}, 1.0, l);
    float wMid = max(1.0 - wShadow - wHighlight, 0.0);

    vec3 lift = vec3(u_p[0], u_p[1], u_p[2]);
    vec3 gamma = vec3(u_p[3], u_p[4], u_p[5]);
    vec3 gain = vec3(u_p[6], u_p[7], u_p[8]);
    vec3 offset = (vec3(u_p[9], u_p[10], u_p[11]) - 25.0) / ${offsetScale};

    // 暗部：只改黑位（中间灰以上权重为 0）
    c += lift * wShadow;
    // 中灰：只改中间调（黑与白钉住）
    c += (pow(max(c, vec3(0.0)), vec3(1.0) / max(vec3(1.0) + gamma, vec3(0.05))) - c) * wMid;
    // 亮部：黑位钉住，白以上按倍数走
    c *= 1.0 + (gain - vec3(1.0)) * wHighlight;
    // 偏移：整幅一起加减
    c += offset;
    fragColor = vec4(max(c, 0.0), texel.a);
  `;
}
