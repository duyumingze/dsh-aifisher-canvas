/**
 * 极简 PNG 解码（scripts/lib/png.mjs）。
 *
 * 为什么要有它：点阵底纹最要命的一类故障是「DOM 对、CSS 对、画面上什么都没有」
 * —— v1.7 就栽在这儿（SVG 背景里写 `currentColor`，图片文档解析成黑色，
 * 深色画布上画了一堆看不见的黑十字，断言全绿）。所以 browser-check 现在要能
 * **读截图像素**，把「真的画出来了、墨色是亮的、间距是 24px」变成机器断言。
 *
 * 只做我们截图需要的那一种：8bit、非隔行、colorType 0/2/6，转成灰度返回。
 * 不引依赖（DSH 侧不允许随便装包），也不追求通用解码器。
 */
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = 0x89504e47;

/**
 * 解出**逐通道**位图：`{ width, height, channels, data }`（行优先、每像素 channels 个字节）。
 *
 * decodePngGray 与 decodePngRgb 共用它 —— 两种取用方式（灰度量底纹、RGB 量颜色）必须
 * 出自同一套反过滤实现，否则「灰度那份对、彩色那份错」这种偏门 bug 极难发现。
 */
function unfilterPng(path) {
  const buffer = readFileSync(path);
  if (buffer.readUInt32BE(0) !== SIGNATURE) throw new Error('不是 PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 6].includes(colorType)) {
    throw new Error(`不支持的 PNG：depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(width * height * channels);
  const prior = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[pos + i];
      const left = i >= channels ? line[i - channels] : 0;
      const up = prior[i];
      const upLeft = i >= channels ? prior[i - channels] : 0;
      let out;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + left;
      else if (filter === 2) out = value + up;
      else if (filter === 3) out = value + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else {
        throw new Error(`未知的行过滤器 ${filter}`);
      }
      line[i] = out & 0xff;
    }
    pos += stride;
    data.set(line, y * stride);
    prior.set(line);
  }
  return { width, height, channels, data };
}

/** 解出灰度图：{ width, height, data(Uint8Array, 行优先) }。 */
export function decodePngGray(path) {
  const png = unfilterPng(path);
  const { width, height, channels, data } = png;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    gray[i] = channels === 1
      ? data[s]
      : Math.round(0.299 * data[s] + 0.587 * data[s + 1] + 0.114 * data[s + 2]);
  }
  return { width, height, data: gray };
}

/**
 * 解出 RGB 图：`{ width, height, data(Uint8Array, 每像素 3 字节) }`。
 *
 * 灰度那份把色相丢了，验不了「这张图到底红没红」—— 而云端图像接口的**参考图有没有被用上**
 * 恰恰只能靠颜色量（见 verify-live-modelscope.mjs：同一 prompt、纯红参考图，看输出近红比例）。
 */
export function decodePngRgb(path) {
  const png = unfilterPng(path);
  const { width, height, channels, data } = png;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const d = i * 3;
    if (channels === 1) {
      rgb[d] = data[s]; rgb[d + 1] = data[s]; rgb[d + 2] = data[s];
    } else {
      rgb[d] = data[s]; rgb[d + 1] = data[s + 1]; rgb[d + 2] = data[s + 2];
    }
  }
  return { width, height, data: rgb };
}

/**
 * 区域颜色统计（默认**中央 50%**：结果图边缘常被模型加上边框/水印，会把比例带偏）。
 * 返回平均 RGB 与三个「近色」像素占比 —— 判「参考图的颜色有没有被带过来」用 nearRed 这类。
 */
export function rgbStats(png, box) {
  const area = box ?? {
    left: Math.floor(png.width * 0.25),
    top: Math.floor(png.height * 0.25),
    width: Math.floor(png.width * 0.5),
    height: Math.floor(png.height * 0.5),
  };
  const x0 = Math.max(0, Math.round(area.left));
  const y0 = Math.max(0, Math.round(area.top));
  const x1 = Math.min(png.width, Math.round(area.left + area.width));
  const y1 = Math.min(png.height, Math.round(area.top + area.height));
  let r = 0;
  let g = 0;
  let b = 0;
  let nearRed = 0;
  let nearGreen = 0;
  let nearBlue = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * png.width + x) * 3;
      const pr = png.data[i];
      const pg = png.data[i + 1];
      const pb = png.data[i + 2];
      r += pr; g += pg; b += pb; count += 1;
      if (pr > 170 && pg < 90 && pb < 90) nearRed += 1;
      if (pg > 150 && pr < 110 && pb < 110) nearGreen += 1;
      if (pb > 150 && pr < 110 && pg < 130) nearBlue += 1;
    }
  }
  const total = Math.max(1, count);
  return {
    pixels: count,
    mean: [Math.round(r / total), Math.round(g / total), Math.round(b / total)],
    nearRed: Number((nearRed / total).toFixed(3)),
    nearGreen: Number((nearGreen / total).toFixed(3)),
    nearBlue: Number((nearBlue / total).toFixed(3)),
  };
}

/** 编码一张纯色 PNG（colorType 2）—— 取证用的参考图/对照图就地造，不用外部素材。 */
export function encodeSolidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    raw[pos] = 0;
    pos += 1;
    for (let x = 0; x < width; x += 1) {
      raw[pos] = r; raw[pos + 1] = g; raw[pos + 2] = b;
      pos += 3;
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, payload) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 取一个矩形区域的统计量（越界自动裁剪）。 */
export function regionStats(png, box) {
  const x0 = Math.max(0, Math.round(box.left));
  const y0 = Math.max(0, Math.round(box.top));
  const x1 = Math.min(png.width, Math.round(box.left + box.width));
  const y1 = Math.min(png.height, Math.round(box.top + box.height));
  const values = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) values.push(png.data[y * png.width + x]);
  }
  values.sort((a, b) => a - b);
  const pick = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
  return {
    count: values.length,
    min: values[0] ?? 0,
    max: values[values.length - 1] ?? 0,
    median: pick(0.5),
    p90: pick(0.9),
    p99: pick(0.99),
  };
}

/**
 * 在给定区域里找最「安静」的方块（标准差最小）。
 *
 * 光看标准差不够：节点卡片内部、对话框空白处同样很平（std≈0），但它们**不是画布底纹**，
 * 拿去量点阵只会量到一片纯灰（v1.8 第一次跑就栽在这儿）。所以再要求方块的中位亮度
 * 接近画布底色（maxMedian，默认 ≤12：AIFISHER 深色画布是 #050505）。
 */
export function quietBlock(png, area, size = 120, options = {}) {
  const maxMedian = options.maxMedian ?? 12;
  const inkThreshold = options.inkThreshold ?? 20;
  const maxRun = options.maxRun ?? 14;
  const maxInkFraction = options.maxInkFraction ?? 0.12;
  let best = null;
  for (let y = Math.round(area.top); y + size <= area.top + area.height; y += 20) {
    for (let x = Math.round(area.left); x + size <= area.left + area.width; x += 20) {
      const values = [];
      for (let j = 0; j < size; j += 1) {
        for (let i = 0; i < size; i += 1) values.push(png.data[(y + j) * png.width + (x + i)]);
      }
      const n = values.length;
      const mean = values.reduce((total, value) => total + value, 0) / n;
      const std = Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / n);
      values.sort((a, b) => a - b);
      const median = values[Math.floor(n / 2)];
      if (median > maxMedian) continue;
      // 「有墨」的像素：星号（7px 的小十字）算墨，节点卡片边框/文字也算 —— 但后者的
      // 亮点会连成长条。用「最长连续亮段」把带边框的方块排除掉，否则量出来的周期是边框的。
      const bright = (px, py) => png.data[py * png.width + px] - median > inkThreshold;
      let ink = 0;
      let longest = 0;
      for (let j = 0; j < size; j += 1) {
        let runX = 0;
        let runY = 0;
        for (let i = 0; i < size; i += 1) {
          if (bright(x + i, y + j)) {
            ink += 1;
            runX += 1;
            longest = Math.max(longest, runX);
          } else runX = 0;
          if (bright(x + j, y + i)) {
            runY += 1;
            longest = Math.max(longest, runY);
          } else runY = 0;
        }
      }
      if (longest > maxRun) continue;
      if (ink / n > maxInkFraction) continue;
      if (!best || std < best.std) {
        best = { left: x, top: y, width: size, height: size, std, mean, median, inkFraction: ink / n };
      }
    }
  }
  return best;
}

/**
 * 在安静方块里量底纹：背景色（中位数）、星号亮度（最大值）、以及**真实像素间距**。
 * 间距用「同一行左移 L 后与原图最像」的 L 来定 —— 周期 24 时 L=24 差异最小。
 */
export function measureGridPattern(png, box, pitchRange = { from: 12, to: 34 }) {
  const background = regionStats(png, box).median;
  let best = null;
  for (let lag = pitchRange.from; lag <= pitchRange.to; lag += 1) {
    let diff = 0;
    let count = 0;
    for (let y = box.top + 4; y < box.top + box.height - 4; y += 1) {
      for (let x = box.left + 4; x < box.left + box.width - 4 - lag; x += 1) {
        diff += Math.abs(png.data[y * png.width + x] - png.data[y * png.width + x + lag]);
        count += 1;
      }
    }
    const mean = diff / Math.max(1, count);
    if (!best || mean < best.diff) best = { lag, diff: mean };
  }
  const stats = regionStats(png, box);
  return {
    background,
    inkMax: stats.max,
    inkP99: stats.p99,
    pitch: best?.lag ?? null,
    pitchDiff: Number((best?.diff ?? 0).toFixed(3)),
    std: Number((quietBlock(png, box, Math.min(60, box.width))?.std ?? 0).toFixed(2)),
  };
}
