/**
 * 极简 PSD（Photoshop 8BPS）编码器 —— 只写「RGB / 8bit / 每层一个普通像素图层」这一种形态。
 *
 * 为什么要自己写（用户 2026-11-21：「psd节点可以下载导入ps里」）：图层拆分的结果就是一叠
 * 带位置的透明图层，用户想拿进 Photoshop 继续做。浏览器端没有现成库，而 PSD 的容器格式
 * 本身很简单 —— 一个头、四段（颜色模式 / 图像资源 / 图层与蒙版 / 合成图），
 * 其中只有「图层与蒙版」段需要精确的字节数（错了 Photoshop 直接拒绝打开）。
 *
 * 写进去的东西：
 *   · 每层一个像素图层，`left/top/right/bottom` 就是它在文档里的矩形（不是整幅），
 *     所以图层**位置**与**尺寸**在 PS 里完全一致（PS 里双击还能继续位移）；
 *   · 每层 4 个通道：-1（透明）+ R + G + B，**非预乘**（PSD 就是这么存的）；
 *   · 混合模式 `norm`、不透明度 255、图层名 = 上游给的名字（没有就「图层 N」）。
 *
 * 刻意不做的事：图像资源（ICC/EXIF）、图层蒙版、编组、调整图层、RLE 压缩。
 * 这些都只是「更小」或「更花」，不影响 PS 打开与编辑；不做能少一大片出错面。
 */

/** 一层要写进 PSD 的像素（已经缩放到自己的矩形尺寸）。 */
export interface PsdLayerInput {
  name: string;
  /** 在文档里的矩形（左上角原点，像素）。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA 非预乘，长度 = width * height * 4。 */
  rgba: Uint8ClampedArray;
}

export interface PsdInput {
  width: number;
  height: number;
  /** 从下往上；写入时按顺序 = PSD 的图层顺序（第一个在最下面）。 */
  layers: readonly PsdLayerInput[];
  /** 合成图（PS 打开时先看到的扁平结果），RGBA 非预乘。 */
  composite: Uint8ClampedArray;
}

/** 逐段写字节（PSD 的字段顺序不能乱，也不能有对齐错误）。 */
class ByteWriter {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  u8(value: number): void {
    this.parts.push(new Uint8Array([value & 0xff]));
    this.length += 1;
  }

  u16(value: number): void {
    this.parts.push(new Uint8Array([(value >> 8) & 0xff, value & 0xff]));
    this.length += 2;
  }

  /** PSD 的 i16/i32 一律大端；负数用补码（图层 top/left 可能为 0，通道 id -1 一定是负的）。 */
  i16(value: number): void {
    this.u16(value < 0 ? 0x10000 + value : value);
  }

  u32(value: number): void {
    this.parts.push(
      new Uint8Array([
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      ]),
    );
    this.length += 4;
  }

  bytes(value: Uint8Array | Uint8ClampedArray): void {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.parts.push(chunk);
    this.length += chunk.byteLength;
  }

  ascii(value: string): void {
    this.bytes(new TextEncoder().encode(value));
  }

  /** Pascal 字符串：1 字节长度 + 内容，**补到 4 的倍数**（含长度字节）。 */
  pascal(value: string, padTo = 4): void {
    const encoded = new TextEncoder().encode(value.slice(0, 255));
    this.u8(encoded.byteLength);
    this.bytes(encoded);
    const used = 1 + encoded.byteLength;
    const pad = (padTo - (used % padTo)) % padTo;
    for (let index = 0; index < pad; index += 1) this.u8(0);
  }

  get size(): number {
    return this.length;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

/** RGBA 交错 → 单通道平面（PSD 的通道是**平面**存储：整张 R、整张 G…）。 */
function planeOf(rgba: Uint8ClampedArray, channel: 0 | 1 | 2 | 3): Uint8Array {
  const pixels = Math.floor(rgba.length / 4);
  const plane = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) plane[index] = rgba[index * 4 + channel];
  return plane;
}

/**
 * 生成 .psd 字节。
 *
 * 布局（PSD 官方文档的顺序，一个都不能少）：
 *   ① 文件头 ② 颜色模式数据 ③ 图像资源 ④ 图层与蒙版 ⑤ 合成图像数据
 */
export function buildPsd(input: PsdInput): Uint8Array {
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  const layers = input.layers
    .map((layer) => ({
      ...layer,
      width: Math.max(1, Math.round(layer.width)),
      height: Math.max(1, Math.round(layer.height)),
      x: Math.round(layer.x),
      y: Math.round(layer.y),
    }))
    .filter((layer) => layer.rgba.length >= layer.width * layer.height * 4);

  const out = new ByteWriter();

  // ---- ① 文件头（26 字节）---------------------------------------------
  out.ascii('8BPS');
  out.u16(1); // version
  out.u32(0); // reserved（6 字节）
  out.u16(0);
  out.u16(4); // channels：A / R / G / B
  out.u32(height);
  out.u32(width);
  out.u16(8); // depth
  out.u16(3); // color mode = RGB

  // ---- ② 颜色模式数据 / ③ 图像资源：都空 ------------------------------
  out.u32(0);
  out.u32(0);

  // ---- ④ 图层与蒙版 ----------------------------------------------------
  const layerSection = new ByteWriter();
  const layerInfo = new ByteWriter();
  layerInfo.i16(layers.length);
  // 图层记录（先全部写完，再写通道数据 —— 两段在同一个 layer info 里，顺序不能反）
  const channelPlanes = layers.map((layer) => [
    planeOf(layer.rgba, 3), // A
    planeOf(layer.rgba, 0), // R
    planeOf(layer.rgba, 1), // G
    planeOf(layer.rgba, 2), // B
  ]);
  layers.forEach((layer, index) => {
    const top = Math.max(0, layer.y);
    const left = Math.max(0, layer.x);
    const bottom = Math.min(height, layer.y + layer.height);
    const right = Math.min(width, layer.x + layer.width);
    layerInfo.u32(top);
    layerInfo.u32(left);
    layerInfo.u32(bottom);
    layerInfo.u32(right);
    layerInfo.u16(4); // 每层 4 个通道
    // 通道 id + 数据长度（含 2 字节压缩标志）
    const planeSize = (bottom - top) * (right - left);
    for (let channel = 0; channel < 4; channel += 1) {
      layerInfo.i16(channel === 0 ? -1 : channel - 1); // -1=A, 0=R, 1=G, 2=B
      layerInfo.u32(2 + planeSize);
    }
    layerInfo.ascii('8BIM'); // 混合模式签名
    layerInfo.ascii('norm'); // 正常
    layerInfo.u8(255); // opacity
    layerInfo.u8(0); // clipping
    layerInfo.u8(0); // flags
    layerInfo.u8(0); // filler
    const extra = new ByteWriter();
    extra.u32(0); // 图层蒙版数据
    extra.u32(0); // 混合范围
    extra.pascal(layer.name || `图层 ${index + 1}`);
    layerInfo.u32(extra.size);
    layerInfo.bytes(extra.finish());
  });
  // 通道像素：每层按 A/R/G/B 的顺序，各写「压缩方式 + 像素」
  layers.forEach((layer, index) => {
    const top = Math.max(0, layer.y);
    const left = Math.max(0, layer.x);
    const bottom = Math.min(height, layer.y + layer.height);
    const right = Math.min(width, layer.x + layer.width);
    const rowWidth = right - left;
    const rowCount = bottom - top;
    for (const plane of channelPlanes[index]) {
      layerInfo.u16(0); // compression = raw
      if (left === layer.x && top === layer.y && rowWidth === layer.width && rowCount === layer.height) {
        layerInfo.bytes(plane);
        continue;
      }
      // 超出文档的图层要按文档裁一刀（PS 的图层矩形不能越界）
      const cropped = new Uint8Array(rowWidth * rowCount);
      for (let row = 0; row < rowCount; row += 1) {
        const sourceStart = (row + top - layer.y) * layer.width + (left - layer.x);
        cropped.set(
          plane.subarray(sourceStart, sourceStart + rowWidth),
          row * rowWidth,
        );
      }
      layerInfo.bytes(cropped);
    }
  });

  const layerInfoBytes = layerInfo.finish();
  layerSection.u32(
    layerInfoBytes.byteLength + (layerInfoBytes.byteLength % 2 === 0 ? 0 : 1),
  );
  layerSection.bytes(layerInfoBytes);
  if (layerInfoBytes.byteLength % 2 !== 0) layerSection.u8(0); // 段长必须偶数
  layerSection.u32(0); // 全局图层蒙版信息（空）
  const layerSectionBytes = layerSection.finish();
  out.u32(layerSectionBytes.byteLength);
  out.bytes(layerSectionBytes);

  // ---- ⑤ 合成图像数据（PS 打开时先看到的那张）-------------------------
  out.u16(0); // compression = raw
  out.bytes(planeOf(input.composite, 0));
  out.bytes(planeOf(input.composite, 1));
  out.bytes(planeOf(input.composite, 2));
  out.bytes(planeOf(input.composite, 3));

  return out.finish();
}

/** 下载文件名：去掉路径里不允许的字符，补 .psd。 */
export function psdFileName(name: string): string {
  const base = (name || '图层文档')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return `${base || '图层文档'}.psd`;
}

/** 触发浏览器下载（返回字节数，供回执/日志用）。 */
export function savePsd(bytes: Uint8Array, fileName: string): number {
  // 拷一份独立缓冲：Blob 只收 ArrayBuffer（不能是 SharedArrayBuffer 视图）
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy.buffer], { type: 'image/vnd.adobe.photoshop' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器取消下载，给一个延时
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return bytes.byteLength;
}
