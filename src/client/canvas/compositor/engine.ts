/**
 * 合成器求值引擎（WebGL2）—— 一个效果一个 fragment shader，节点结果落在 FBO 上。
 *
 * 三条硬约束（决定了「像不像专业调色软件」）：
 *   1. **中间纹理用 RGBA16F**（有 EXT_color_buffer_float 时）：8bit 下 lift/gamma/gain
 *      一叠就 banding，高光也会被截断；
 *   2. **计算在 linear**：贴图是 sRGB 编码，进 shader 先转线性，出结果再编码回 sRGB；
 *   3. **按节点缓存**：key = 参数 + 上游版本。拖滑块只重算该节点及其下游，
 *      否则 4K 图一拖就卡死（Composite 现在就是全量重画）。
 *
 * 参数传递用统一 `u_p[16]` 数组：效果作者只写 shader 和 PARAM_ORDER，
 * 绑定逻辑不用逐个效果手写。
 *
 * 上游引用是 `{node, port}` 而不是裸 nodeId：输入节点有 N 个输出口，
 * 每口一张不同的图，光靠 nodeId 分不出来。
 */

import {
  evaluationOrder,
  paramsOf,
  specOf,
  type CompositorGraph,
  type CompositorInputImage,
  type CompositorKind,
  type CompositorNode,
} from './graph';
import { buildCurveLut, curvesAreIdentity, type CurveParams } from './curves';
import type { ScopeImage } from './scopes';

const MAX_PARAMS = 16;

/** 上游引用：哪个节点的哪个输出口。 */
export interface UpstreamRef {
  node: string;
  port: number;
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** 每个效果的 shader 头；效果 body 只写 main 里的计算。 */
const FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_p[${MAX_PARAMS}];

float srgbToLinear1(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
vec3 srgbToLinear(vec3 c) {
  return vec3(srgbToLinear1(c.r), srgbToLinear1(c.g), srgbToLinear1(c.b));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}
`;

/** 参数顺序：决定 node.params 的哪个字段进 u_p 的哪个槽。 */
const PARAM_ORDER: Partial<Record<CompositorKind, string[]>> = {
  brightnessContrast: ['brightness', 'contrast'],
  colorBalance: [
    'liftR',
    'liftG',
    'liftB',
    'gammaR',
    'gammaG',
    'gammaB',
    'gainR',
    'gainG',
    'gainB',
    'offsetR',
    'offsetG',
    'offsetB',
  ],
  whiteBalance: ['temperature', 'tint'],
  exposure: ['exposure'],
  gamma: ['gamma'],
  hueSaturation: ['hue', 'saturation', 'lightness'],
  vignette: ['amount', 'softness', 'roundness'],
  grain: ['amount'],
  sharpen: ['amount'],
  blur: ['radius'],
  transform: ['translateX', 'translateY', 'scale', 'rotation'],
  mix: ['factor'],
  alphaOver: ['factor'],
  ellipseMask: ['width', 'height', 'softness', 'invert'],
  boxMask: ['width', 'height', 'softness', 'invert'],
  gradientMask: ['angle', 'offset', 'softness', 'invert'],
};

/** 混合模式 → shader 里的整数 id（W3C Compositing Level 1 的顺序）。 */
export const MIX_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'colorDodge',
  'colorBurn',
  'hardLight',
  'softLight',
  'difference',
  'exclusion',
  'add',
  'subtract',
] as const;

export const MIX_MODE_LABELS: Record<(typeof MIX_MODES)[number], string> = {
  normal: '正常',
  multiply: '正片叠底',
  screen: '滤色',
  overlay: '叠加',
  darken: '变暗',
  lighten: '变亮',
  colorDodge: '颜色减淡',
  colorBurn: '颜色加深',
  hardLight: '强光',
  softLight: '柔光',
  difference: '差值',
  exclusion: '排除',
  add: '相加',
  subtract: '相减',
};

/** 各效果的 body。参数按 PARAM_ORDER 取。 */
const EFFECT_BODIES: Partial<Record<CompositorKind, string>> = {
  brightnessContrast: `
    vec4 texel = texture(u_tex, v_uv);
    vec3 c = srgbToLinear(texel.rgb);
    c = c * (1.0 + u_p[0]);
    c = (c - 0.5) * (1.0 + u_p[1]) + 0.5;
    fragColor = vec4(linearToSrgb(c), texel.a);
  `,
  colorBalance: `
    vec4 texel = texture(u_tex, v_uv);
    vec3 c = srgbToLinear(texel.rgb);
    vec3 lift = vec3(u_p[0], u_p[1], u_p[2]);
    vec3 gamma = vec3(u_p[3], u_p[4], u_p[5]);
    vec3 gain = vec3(u_p[6], u_p[7], u_p[8]);
    // 偏移：界面上 25.00 是中性，+25 相当于线性加 0.5（整体提亮/压暗）
    vec3 offset = vec3(u_p[9], u_p[10], u_p[11]) / 25.0 - vec3(1.0);
    c = max(c + offset * 0.5, 0.0);
    // ASC CDL 的 lift/gamma/gain：slope = gain - lift，offset = lift。
    // 中性值（lift 0 / gamma 0 / gain 1）代进去正好是恒等，所以数字就是界面上的数字。
    vec3 slope = max(gain - lift, vec3(0.0));
    c = max(c * slope + lift, 0.0);
    c = pow(c, vec3(1.0) / max(vec3(1.0) + gamma, vec3(0.05)));
    fragColor = vec4(linearToSrgb(c), texel.a);
  `,
  whiteBalance: `
    vec4 texel = texture(u_tex, v_uv);
    vec3 c = srgbToLinear(texel.rgb);
    // 以 5600K 为中性：色温每翻一倍，红/蓝增益按对数各走一段（近似 Planckian 轴）
    float kelvin = clamp(u_p[0], 1000.0, 20000.0);
    float stops = log2(kelvin / 5600.0);
    vec3 gain = vec3(exp2(stops * 0.25), 1.0, exp2(-stops * 0.30));
    // 色调：绿→洋红（负 = 偏绿，正 = 偏洋红）
    float tint = clamp(u_p[1], -1.0, 1.0);
    gain.g *= exp2(-tint * 0.32);
    gain.r *= exp2(tint * 0.10);
    gain.b *= exp2(tint * 0.10);
    c *= gain;
    fragColor = vec4(linearToSrgb(c), texel.a);
  `,
  curves: `
    vec4 texel = texture(u_tex, v_uv);
    // 曲线在 sRGB 域逐通道查表（8bit 在暗部的精度比 scene-linear 好，和 PS/达芬奇一致）
    vec3 s = clamp(texel.rgb, 0.0, 1.0);
    vec3 mapped;
    mapped.r = texture(u_lut, vec2((s.r * 255.0 + 0.5) / 256.0, 0.5)).r;
    mapped.g = texture(u_lut, vec2((s.g * 255.0 + 0.5) / 256.0, 0.5)).g;
    mapped.b = texture(u_lut, vec2((s.b * 255.0 + 0.5) / 256.0, 0.5)).b;
    fragColor = vec4(mapped, texel.a);
  `,
  exposure: `
    vec4 texel = texture(u_tex, v_uv);
    vec3 c = srgbToLinear(texel.rgb) * exp2(u_p[0]);
    fragColor = vec4(linearToSrgb(c), texel.a);
  `,
  gamma: `
    vec4 texel = texture(u_tex, v_uv);
    vec3 c = srgbToLinear(texel.rgb);
    c = pow(max(c, 0.0), vec3(1.0 / max(0.05, u_p[0])));
    fragColor = vec4(linearToSrgb(c), texel.a);
  `,
  hueSaturation: `
    vec4 texel = texture(u_tex, v_uv);
    vec3 c = srgbToLinear(texel.rgb);
    // 色相旋转用 YIQ 近似，够用且不像 HSV 往返那样在低饱和处抖动
    float angle = u_p[0] * 6.2831853;
    float cosA = cos(angle), sinA = sin(angle);
    mat3 hue = mat3(
      0.299 + 0.701 * cosA + 0.168 * sinA, 0.587 - 0.587 * cosA + 0.330 * sinA, 0.114 - 0.114 * cosA - 0.497 * sinA,
      0.299 - 0.299 * cosA - 0.328 * sinA, 0.587 + 0.413 * cosA + 0.035 * sinA, 0.114 - 0.114 * cosA + 0.292 * sinA,
      0.299 - 0.300 * cosA + 1.250 * sinA, 0.587 - 0.588 * cosA - 1.050 * sinA, 0.114 + 0.886 * cosA - 0.203 * sinA
    );
    c = hue * c;
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(luma), c, 1.0 + u_p[1]);
    c = c * (1.0 + u_p[2]);
    fragColor = vec4(linearToSrgb(c), texel.a);
  `,
  vignette: `
    vec4 texel = texture(u_tex, v_uv);
    vec3 c = srgbToLinear(texel.rgb);
    vec2 d = (v_uv - 0.5) * vec2(1.0, mix(1.0, 0.6, u_p[2]));
    float r = length(d) * 1.41421356;
    float edge = smoothstep(0.0, max(0.001, 1.0 - u_p[1]), r);
    c *= 1.0 - u_p[0] * edge;
    fragColor = vec4(linearToSrgb(c), texel.a);
  `,
  grain: `
    vec4 texel = texture(u_tex, v_uv);
    vec3 c = srgbToLinear(texel.rgb);
    float n = fract(sin(dot(v_uv * 1024.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    c += n * u_p[0];
    fragColor = vec4(linearToSrgb(c), texel.a);
  `,
  sharpen: `
    vec4 texel = texture(u_tex, v_uv);
    vec3 c = srgbToLinear(texel.rgb);
    vec2 o = u_texel * 1.5;
    vec3 blur =
      srgbToLinear(texture(u_tex, v_uv + vec2(-o.x, 0.0)).rgb) +
      srgbToLinear(texture(u_tex, v_uv + vec2(o.x, 0.0)).rgb) +
      srgbToLinear(texture(u_tex, v_uv + vec2(0.0, -o.y)).rgb) +
      srgbToLinear(texture(u_tex, v_uv + vec2(0.0, o.y)).rgb);
    blur *= 0.25;
    c = c + (c - blur) * u_p[0] * 2.0;
    fragColor = vec4(linearToSrgb(c), texel.a);
  `,
  transform: `
    vec2 uv = v_uv - 0.5;
    float a = -u_p[3] * 0.0174532925;
    uv = mat2(cos(a), sin(a), -sin(a), cos(a)) * uv;
    uv = uv / max(0.01, u_p[2]) + 0.5 - vec2(u_p[0], -u_p[1]);
    vec4 texel = (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ? vec4(0.0) : texture(u_tex, uv);
    fragColor = texel;
  `,
  ellipseMask: `
    vec2 d = (v_uv - 0.5) / vec2(max(0.01, u_p[0]) * 0.5, max(0.01, u_p[1]) * 0.5);
    float inside = 1.0 - smoothstep(1.0 - u_p[2], 1.0, length(d));
    float a = u_p[3] > 0.5 ? 1.0 - inside : inside;
    fragColor = vec4(vec3(a), a);
  `,
  boxMask: `
    vec2 half_ = vec2(max(0.01, u_p[0]), max(0.01, u_p[1])) * 0.5;
    vec2 q = abs(v_uv - 0.5);
    float inside = (1.0 - smoothstep(half_.x - u_p[2] * 0.5, half_.x, q.x)) *
                   (1.0 - smoothstep(half_.y - u_p[2] * 0.5, half_.y, q.y));
    float a = u_p[3] > 0.5 ? 1.0 - inside : inside;
    fragColor = vec4(vec3(a), a);
  `,
  gradientMask: `
    float a = -u_p[0] * 0.0174532925;
    vec2 dir = vec2(cos(a), sin(a));
    float t = dot(v_uv - 0.5, dir) + 0.5 + u_p[1];
    float edge = max(0.001, u_p[2]);
    float v = smoothstep(0.0, edge, t) * (1.0 - smoothstep(1.0 - edge, 1.0, t));
    if (u_p[3] > 0.5) v = 1.0 - v;
    fragColor = vec4(vec3(v), v);
  `,
};

/**
 * 双输入节点的 body（mix / alphaOver）。输入约定：A 口 = 上层，B 口 = 底层。
 */
const DUAL_BODIES: Partial<Record<CompositorKind, string>> = {
  mix: `
    vec4 top = texture(u_tex, v_uv);      // A 口
    vec4 bottom = texture(u_tex2, v_uv);  // B 口
    // 系数口（toPort=2）：接灰度/蒙版时按像素控混合量，乘在滑块上；
    // 没接线时绑的是一张全白 1×1，等价于只用滑块（老图语义不变）。
    float f = clamp(u_p[0], 0.0, 1.0) * clamp(texture(u_tex3, v_uv).r, 0.0, 1.0);
    int mode = int(u_p[1] + 0.5);
    vec3 a = srgbToLinear(top.rgb);
    vec3 b = srgbToLinear(bottom.rgb);
    vec3 r = a;
    if (mode == 1) r = a * b;
    else if (mode == 2) r = 1.0 - (1.0 - a) * (1.0 - b);
    else if (mode == 3) r = mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, b));
    else if (mode == 4) r = min(a, b);
    else if (mode == 5) r = max(a, b);
    else if (mode == 6) r = a / max(1.0 - b, 0.0001);
    else if (mode == 7) r = 1.0 - (1.0 - a) / max(b, 0.0001);
    else if (mode == 8) r = mix(b, a, step(0.5, a));
    else if (mode == 9) r = (1.0 - 2.0 * b) * a * a + 2.0 * b * a;
    else if (mode == 10) r = abs(a - b);
    else if (mode == 11) r = a + b - 2.0 * a * b;
    else if (mode == 12) r = a + b;
    else if (mode == 13) r = a - b;
    vec3 outColor = mix(b, r, f);
    float alpha = mix(bottom.a, 1.0, f);
    fragColor = vec4(linearToSrgb(outColor), alpha);
  `,
  alphaOver: `
    vec4 top = texture(u_tex, v_uv);
    vec4 bottom = texture(u_tex2, v_uv);
    float f = clamp(u_p[0], 0.0, 1.0);
    float topAlpha = top.a * f;
    vec3 c = mix(bottom.rgb, top.rgb, topAlpha);
    float a = topAlpha + bottom.a * (1.0 - topAlpha);
    fragColor = vec4(c, a);
  `,
};

/**
 * 三输入节点：mix 的 A / B / 系数。第三个 sampler 只在 tri 编译时声明，
 * 单/双输入节点不背这份 uniform。
 */
const TRIPLE_INPUTS = new Set<CompositorKind>(['mix']);

interface ProgramBundle {
  program: WebGLProgram;
  uTex: WebGLUniformLocation | null;
  uTex2: WebGLUniformLocation | null;
  uTex3: WebGLUniformLocation | null;
  uLut: WebGLUniformLocation | null;
  uTexel: WebGLUniformLocation | null;
  uParams: WebGLUniformLocation | null;
}

interface RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

interface TargetCache {
  key: string;
  target: RenderTarget;
  version: number;
}

interface InputCache {
  url: string;
  texture: WebGLTexture;
  version: number;
  loading: boolean;
}

export class CompositorEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositorEngineError';
  }
}

/**
 * 一个合成器实例对应编辑器里的一块画布。
 * 生命周期跟随编辑器：close 时必须 destroy()，否则 GL 上下文与纹理不会释放。
 */
export class CompositorEngine {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private vao: WebGLVertexArrayObject | null = null;
  private programs = new Map<string, ProgramBundle>();
  private targets = new Map<string, TargetCache>();
  private inputs = new Map<number, InputCache>();
  /** 1×1 全白纹理：mix 的系数口没接线时用它，shader 里乘出来就等于「只用滑块」。 */
  private white: WebGLTexture | null = null;
  /** 曲线 LUT：key = 四组控制点，最多留 12 张（拖滑块时每条曲线一张，够用）。 */
  private curveLuts = new Map<string, WebGLTexture>();
  /** 示波器降采样目标（固定 RGBA8，readPixels 读 UNSIGNED_BYTE 才是合法组合）。 */
  private scopeTarget: RenderTarget | null = null;
  private version = 0;
  private halfFloat = false;
  private width = 1;
  private height = 1;
  private graph: CompositorGraph;
  private images: CompositorInputImage[] = [];
  private disposed = false;
  /** 输入图加载完 / 加载失败时通知编辑器重绘。 */
  onInvalidate: (() => void) | null = null;
  /** 求值过程中的错误（shader 编译失败 / 环），供编辑器顶栏显示。 */
  lastError = '';

  constructor(canvas: HTMLCanvasElement, graph: CompositorGraph) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new CompositorEngineError('这个环境不支持 WebGL2，无法运行合成器。');
    this.gl = gl;
    this.canvas = canvas;
    this.graph = graph;
    this.halfFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.setupGeometry();
  }

  private setupGeometry(): void {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new CompositorEngineError('WebGL2 顶点数组创建失败。');
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;
  }

  setGraph(graph: CompositorGraph): void {
    this.graph = graph;
  }

  setImages(images: CompositorInputImage[]): void {
    this.images = images;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.targets.clear();
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** 换图后调用：只丢渲染缓存，输入纹理按 URL 命中会复用。 */
  invalidate(): void {
    this.targets.clear();
  }

  private compile(body: string, dual: boolean, lut = false, tri = false): ProgramBundle {
    const gl = this.gl;
    const source =
      FRAGMENT_HEADER +
      (dual ? 'uniform sampler2D u_tex2;\n' : '') +
      (tri ? 'uniform sampler2D u_tex3;\n' : '') +
      (lut ? 'uniform sampler2D u_lut;\n' : '') +
      'void main() {' +
      body +
      '}';
    const vertex = gl.createShader(gl.VERTEX_SHADER);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vertex || !fragment) throw new CompositorEngineError('shader 创建失败。');
    gl.shaderSource(vertex, VERTEX_SHADER);
    gl.compileShader(vertex);
    if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS)) {
      throw new CompositorEngineError(`顶点 shader 编译失败：${gl.getShaderInfoLog(vertex) || ''}`);
    }
    gl.shaderSource(fragment, source);
    gl.compileShader(fragment);
    if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
      throw new CompositorEngineError(`片元 shader 编译失败：${gl.getShaderInfoLog(fragment) || ''}`);
    }
    const program = gl.createProgram();
    if (!program) throw new CompositorEngineError('program 创建失败。');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new CompositorEngineError(`program 链接失败：${gl.getProgramInfoLog(program) || ''}`);
    }
    return {
      program,
      uTex: gl.getUniformLocation(program, 'u_tex'),
      uTex2: gl.getUniformLocation(program, 'u_tex2'),
      uTex3: gl.getUniformLocation(program, 'u_tex3'),
      uLut: gl.getUniformLocation(program, 'u_lut'),
      uTexel: gl.getUniformLocation(program, 'u_texel'),
      uParams: gl.getUniformLocation(program, 'u_p'),
    };
  }

  private programFor(kind: CompositorKind): ProgramBundle {
    const dual = !!DUAL_BODIES[kind];
    const tri = TRIPLE_INPUTS.has(kind);
    const lut = kind === 'curves';
    const cacheKey = `${kind}:${tri ? 'tri' : dual ? 'dual' : 'single'}${lut ? ':lut' : ''}`;
    const cached = this.programs.get(cacheKey);
    if (cached) return cached;
    const body = DUAL_BODIES[kind] ?? EFFECT_BODIES[kind] ?? 'vec4 t = texture(u_tex, v_uv); fragColor = t;';
    const bundle = this.compile(body, dual, lut, tri);
    this.programs.set(cacheKey, bundle);
    return bundle;
  }

  private createTarget(width: number, height: number, float = this.halfFloat): RenderTarget {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new CompositorEngineError('渲染目标创建失败。');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (float) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new CompositorEngineError('渲染目标不完整（可能是 half-float 不受支持）。');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { texture, framebuffer, width, height };
  }

  /** 1×1 透明占位纹理：图还没 decode 完时下游照常渲染，不闪黑。 */
  private emptyTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new CompositorEngineError('占位纹理创建失败。');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  /** 1×1 全白纹理（系数口空接时的中性值）。 */
  private whiteTexture(): WebGLTexture {
    if (this.white) return this.white;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new CompositorEngineError('占位纹理创建失败。');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.white = texture;
    return texture;
  }

  private uploadImage(image: HTMLImageElement): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new CompositorEngineError('图片纹理创建失败。');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  /** 曲线节点用的 256×1 LUT（同一组控制点只建一次；身份曲线用一张固定的恒等表）。 */
  private curveLutFor(node: CompositorNode): WebGLTexture {
    const params = paramsOf(node) as CurveParams;
    const identity = curvesAreIdentity(params);
    const key = identity ? 'identity' : JSON.stringify(params);
    const cached = this.curveLuts.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new CompositorEngineError('曲线 LUT 创建失败。');
    const data = identity
      ? (() => {
          const lut = new Uint8Array(256 * 4);
          for (let index = 0; index < 256; index += 1) {
            lut[index * 4] = index;
            lut[index * 4 + 1] = index;
            lut[index * 4 + 2] = index;
            lut[index * 4 + 3] = 255;
          }
          return lut;
        })()
      : buildCurveLut(params);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    // 参数组合会随拖动不断变化，缓存别无限长
    if (this.curveLuts.size >= 12) {
      const oldest = this.curveLuts.keys().next().value as string | undefined;
      if (oldest) {
        const stale = this.curveLuts.get(oldest);
        if (stale) gl.deleteTexture(stale);
        this.curveLuts.delete(oldest);
      }
    }
    this.curveLuts.set(key, texture);
    return texture;
  }

  /** 输入节点第 port 个输出口的纹理（同一 URL 只上传一次，异步加载）。 */
  private ensureInput(port: number): WebGLTexture | null {
    const image = this.images[port];
    if (!image) return null;
    const cached = this.inputs.get(port);
    if (cached && cached.url === image.url) return cached.texture;
    if (cached) {
      this.gl.deleteTexture(cached.texture);
      this.inputs.delete(port);
    }
    const placeholder = this.emptyTexture();
    this.inputs.set(port, { url: image.url, texture: placeholder, version: ++this.version, loading: true });
    const element = new Image();
    element.crossOrigin = 'anonymous';
    element.decoding = 'async';
    element.onload = () => {
      if (this.disposed) return;
      try {
        const texture = this.uploadImage(element);
        const current = this.inputs.get(port);
        if (current && current.texture !== texture) this.gl.deleteTexture(current.texture);
        this.inputs.set(port, {
          url: image.url,
          texture,
          version: ++this.version,
          loading: false,
        });
        this.targets.clear();
        this.onInvalidate?.();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.onInvalidate?.();
      }
    };
    element.onerror = () => {
      this.lastError = `图片加载失败：${image.url.slice(0, 120)}`;
      this.onInvalidate?.();
    };
    element.src = image.url;
    return placeholder;
  }

  private paramFloats(node: CompositorNode): Float32Array {
    const values = new Float32Array(MAX_PARAMS);
    const order = PARAM_ORDER[node.kind] || [];
    const params = paramsOf(node);
    order.forEach((name, index) => {
      if (index >= MAX_PARAMS) return;
      const value = params[name];
      if (typeof value === 'number') values[index] = value;
      else if (typeof value === 'boolean') values[index] = value ? 1 : 0;
    });
    // mix 的模式占第 2 槽（顺序表里只有 factor）
    if (node.kind === 'mix') {
      const mode = String(params.mode || 'normal') as (typeof MIX_MODES)[number];
      values[1] = Math.max(0, MIX_MODES.indexOf(mode));
    }
    return values;
  }

  private refOf(nodeId: string | null, port: number): UpstreamRef | null {
    return nodeId ? { node: nodeId, port } : null;
  }

  /** 缓存 key：参数 + 上游版本。上游变了，整条下游都要重算。 */
  private keyOf(node: CompositorNode, upstream: (UpstreamRef | null)[]): string {
    const versions = upstream.map((ref) => {
      if (!ref) return 'null';
      const node = this.graph.nodes.find((item) => item.id === ref.node);
      if (node?.kind === 'input') {
        const input = this.inputs.get(ref.port);
        return `in${ref.port}:${input?.version ?? 0}`;
      }
      return `${ref.node}:${this.targets.get(ref.node)?.version ?? 0}`;
    });
    return [node.kind, JSON.stringify(paramsOf(node)), versions.join(',')].join('|');
  }

  private textureOf(ref: UpstreamRef | null): WebGLTexture | null {
    if (!ref) return null;
    const node = this.graph.nodes.find((item) => item.id === ref.node);
    if (node?.kind === 'input') return this.ensureInput(ref.port);
    return this.targets.get(ref.node)?.target.texture ?? null;
  }

  private renderNode(node: CompositorNode, upstream: (UpstreamRef | null)[]): RenderTarget {
    const gl = this.gl;
    const bundle = this.programFor(node.kind);
    const existing = this.targets.get(node.id);
    const next =
      existing && existing.target.width === this.width && existing.target.height === this.height
        ? existing.target
        : this.createTarget(this.width, this.height);
    if (existing && existing.target !== next) {
      gl.deleteFramebuffer(existing.target.framebuffer);
      gl.deleteTexture(existing.target.texture);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(bundle.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textureOf(upstream[0]));
    if (bundle.uTex) gl.uniform1i(bundle.uTex, 0);
    if (bundle.uTex2) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.textureOf(upstream[1]));
      gl.uniform1i(bundle.uTex2, 1);
    }
    if (bundle.uTex3) {
      // 系数口：没接线就绑全白（factor = 滑块值），接了就按像素取 .r
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.textureOf(upstream[2]) ?? this.whiteTexture());
      gl.uniform1i(bundle.uTex3, 3);
    }
    if (bundle.uLut) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.curveLutFor(node));
      gl.uniform1i(bundle.uLut, 2);
    }
    if (bundle.uTexel) gl.uniform2f(bundle.uTexel, 1 / this.width, 1 / this.height);
    if (bundle.uParams) gl.uniform1fv(bundle.uParams, this.paramFloats(node));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets.set(node.id, { key: this.keyOf(node, upstream), target: next, version: ++this.version });
    return next;
  }

  /**
   * 求值并返回结果纹理。targetId 是 output 或 viewer。
   * 返回 null 表示图不完整（比如 output 口没接）。
   */
  evaluate(targetId: string): WebGLTexture | null {
    if (this.disposed) return null;
    this.lastError = '';
    const graph = this.graph;
    const result = evaluationOrder(graph, targetId);
    if (result.error) {
      this.lastError = result.error;
      return null;
    }
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const id of result.order) {
      const node = byId.get(id);
      if (!node || node.kind === 'input') continue;
      const spec = specOf(node.kind);
      const upstream: (UpstreamRef | null)[] = [];
      for (let port = 0; port < Math.max(1, spec.inputs); port += 1) {
        const edge = graph.edges.find((item) => item.toNode === id && item.toPort === port);
        upstream.push(this.refOf(edge ? edge.fromNode : null, edge ? edge.fromPort : port));
      }
      if (spec.inputs > 0 && !upstream.some(Boolean)) continue;
      const key = this.keyOf(node, upstream);
      const cached = this.targets.get(id);
      if (cached && cached.key === key) continue;
      this.renderNode(node, upstream);
    }
    return this.targets.get(targetId)?.target.texture ?? null;
  }

  /** 把结果纹理画到可见画布（不动 FBO 缓存）。 */
  present(targetId: string): boolean {
    const texture = this.targets.get(targetId)?.target.texture ?? null;
    if (!texture) return false;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const bundle = this.programFor('output');
    gl.useProgram(bundle.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (bundle.uTex) gl.uniform1i(bundle.uTex, 0);
    if (bundle.uTexel) gl.uniform2f(bundle.uTexel, 1 / this.width, 1 / this.height);
    if (bundle.uParams) gl.uniform1fv(bundle.uParams, new Float32Array(MAX_PARAMS));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    return true;
  }

  /**
   * 把 targetId 的结果渲染进一块 RGBA8 缓冲并读回（自下而上）。
   *
   * 为什么不直接 readPixels 中间纹理：中间纹理是 RGBA16F，WebGL2 规定它的合法
   * readPixels 组合是 RGBA/FLOAT，用 UNSIGNED_BYTE 读会 INVALID_OPERATION、拿回全 0
   * —— 表现就是「导出/预览统计全黑」。统一先画进 RGBA8 再读，两条路径都不会踩格式坑。
   */
  private readRgba8(targetId: string, target: RenderTarget): Uint8Array | null {
    const texture = this.targets.get(targetId)?.target.texture;
    if (!texture) return null;
    const gl = this.gl;
    const w = target.width;
    const h = target.height;
    const bundle = this.programFor('output');
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(bundle.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (bundle.uTex) gl.uniform1i(bundle.uTex, 0);
    if (bundle.uTexel) gl.uniform2f(bundle.uTexel, 1 / w, 1 / h);
    if (bundle.uParams) gl.uniform1fv(bundle.uParams, new Float32Array(MAX_PARAMS));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return pixels;
  }

  /**
   * 把结果降采样到一块小缓冲并读回 CPU，供示波器（直方图/波形/矢量）统计。
   * 只读已经求值好的 target 纹理，不会触发重算；尺寸默认 256×160（几万像素，够统计且便宜）。
   */
  readScope(targetId: string, width = 256, height = 160): ScopeImage | null {
    if (this.disposed) return null;
    if (!this.targets.get(targetId)) return null;
    const gl = this.gl;
    const w = Math.max(16, Math.min(512, Math.round(width)));
    const h = Math.max(16, Math.min(512, Math.round(height)));
    if (!this.scopeTarget || this.scopeTarget.width !== w || this.scopeTarget.height !== h) {
      if (this.scopeTarget) {
        gl.deleteFramebuffer(this.scopeTarget.framebuffer);
        gl.deleteTexture(this.scopeTarget.texture);
      }
      this.scopeTarget = this.createTarget(w, h, false);
    }
    const pixels = this.readRgba8(targetId, this.scopeTarget);
    if (!pixels) return null;
    // GL 的行是自下而上，翻成自上而下（波形图/矢量图的纵向要靠这个才对）
    const flipped = new Uint8Array(pixels.length);
    const row = w * 4;
    for (let y = 0; y < h; y += 1) {
      flipped.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    }
    return { width: w, height: h, pixels: flipped };
  }

  /** 把结果读回 dataURL（导出用）。用 2D 画布中转，顺手解决 GL 上下翻转。 */
  exportDataUrl(targetId: string): string | null {
    if (this.disposed) return null;
    if (!this.targets.get(targetId)) return null;
    const gl = this.gl;
    const size = { width: this.width, height: this.height };
    // 全尺寸的 RGBA8 中转：4K 约 33MB，只在点「应用」时用一次
    const staging = this.createTarget(size.width, size.height, false);
    const pixels = this.readRgba8(targetId, staging);
    gl.deleteFramebuffer(staging.framebuffer);
    gl.deleteTexture(staging.texture);
    if (!pixels) return null;
    const flip = document.createElement('canvas');
    flip.width = size.width;
    flip.height = size.height;
    const context = flip.getContext('2d');
    if (!context) return null;
    const image = context.createImageData(size.width, size.height);
    const row = size.width * 4;
    for (let y = 0; y < size.height; y += 1) {
      const source = (size.height - 1 - y) * row;
      image.data.set(pixels.subarray(source, source + row), y * row);
    }
    context.putImageData(image, 0, 0);
    return flip.toDataURL('image/png');
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const bundle of this.programs.values()) gl.deleteProgram(bundle.program);
    for (const target of this.targets.values()) {
      gl.deleteFramebuffer(target.target.framebuffer);
      gl.deleteTexture(target.target.texture);
    }
    for (const input of this.inputs.values()) gl.deleteTexture(input.texture);
    if (this.white) {
      gl.deleteTexture(this.white);
      this.white = null;
    }
    for (const lut of this.curveLuts.values()) gl.deleteTexture(lut);
    if (this.scopeTarget) {
      gl.deleteFramebuffer(this.scopeTarget.framebuffer);
      gl.deleteTexture(this.scopeTarget.texture);
      this.scopeTarget = null;
    }
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.programs.clear();
    this.targets.clear();
    this.inputs.clear();
    this.curveLuts.clear();
  }
}

/** 图里有没有「至少一条从 input 通到 output 的路径」。编辑器用它判断能否导出。 */
export function hasOutputPath(graph: CompositorGraph): boolean {
  const output = graph.nodes.find((node) => node.kind === 'output');
  if (!output) return false;
  return graph.edges.some((edge) => edge.toNode === output.id);
}
