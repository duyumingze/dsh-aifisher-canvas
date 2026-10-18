/**
 * 画布外观：背景图（host 半）。
 *
 * 上游 canvasAppearance.ts 把背景图存在它自己的 server 上，契约写死在客户端里：
 *
 *   GET    /appearance/background          → { image: BackgroundImage | null }
 *   POST   /appearance/background          body = 图片原始字节（Content-Type 就是 MIME）→ { image }
 *   DELETE /appearance/background          → { image: null }
 *   GET    /appearance/background/<id>     → 图片字节（image.url 必须恰好是这条路径）
 *
 * BackgroundImage = { id, width, height, bytes, url }，客户端解析时校验得很严：
 *   id     /^[a-zA-Z0-9-]{16,80}$/
 *   url    必须等于 `/api/aifisher/canvas/appearance/background/${id}`
 *   width/height 必须是 1..4096 的安全整数；bytes 1..20MiB
 * 任何一条不满足，前端 parseBackgroundImage 直接返回 null，用户看到的是「背景服务返回内容无效」。
 * 所以这里必须真读到图片尺寸——本插件没有 sharp，用**纯 JS 读文件头**（只支持 jpg/png/webp，
 * 与前端白名单一致），不依赖 ffmpeg。
 *
 * 落盘位置：<画布数据目录>/appearance/background.<ext>（+ background.json 存元数据），
 * 原子写：先写 .tmp 再 rename。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readRawBody, sendJson } from '../http/httpUtil';

export interface AppearanceDeps {
  /** 画布数据目录（= canvas.json 所在目录的兄弟文件都放这里）。 */
  dataDir: string;
}

/** 与前端 MAX_BACKGROUND_BYTES 一致。 */
const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024;
/** 与前端 parseBackgroundImage 一致（超了前端会当无效响应）。 */
const MAX_DIMENSION = 4096;

const MIME_EXT: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
});
const EXT_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
});

interface StoredBackground {
  id: string;
  ext: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

function appearanceDir(dataDir: string): string {
  return join(dataDir, 'appearance');
}
function metaPath(dataDir: string): string {
  return join(appearanceDir(dataDir), 'background.json');
}
function imagePath(dataDir: string, ext: string): string {
  return join(appearanceDir(dataDir), `background${ext}`);
}

async function readStored(dataDir: string): Promise<StoredBackground | null> {
  const file = metaPath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<StoredBackground>;
    if (
      typeof parsed.id !== 'string' ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(parsed.id) ||
      typeof parsed.ext !== 'string' ||
      !EXT_MIME[parsed.ext] ||
      !Number.isSafeInteger(parsed.width) ||
      !Number.isSafeInteger(parsed.height) ||
      !Number.isSafeInteger(parsed.bytes)
    ) {
      return null;
    }
    if (!existsSync(imagePath(dataDir, parsed.ext))) return null;
    return {
      id: parsed.id,
      ext: parsed.ext,
      width: parsed.width as number,
      height: parsed.height as number,
      bytes: parsed.bytes as number,
      sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : '',
    };
  } catch {
    return null;
  }
}

function toImage(stored: StoredBackground | null) {
  if (!stored) return null;
  return {
    id: stored.id,
    width: stored.width,
    height: stored.height,
    bytes: stored.bytes,
    url: `/api/aifisher/canvas/appearance/background/${stored.id}`,
  };
}

/**
 * 读图片文件头拿宽高。只处理前端允许的三种格式（jpg/png/webp）。
 * 拿不到就返回 null，调用方回 422（比存进去再让前端判「无效响应」清楚得多）。
 */
export function readImageSize(buffer: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') {
      // 89 50 4E 47 0D 0A 1A 0A | IHDR 长度(4) + 'IHDR'(4) + width(4) + height(4)
      if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        // 填充字节 0xFF 与无长度字段的标记
        if (marker === 0xff) {
          offset += 1;
          continue;
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
          offset += 2;
          continue;
        }
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) return null;
        // SOF0..SOF15（0xC4=DHT、0xC8=JPG、0xCC=DAC 不是 SOF）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + length;
      }
      return null;
    }
    if (mime === 'image/webp') {
      if (buffer.length < 30) return null;
      if (buffer.toString('latin1', 0, 4) !== 'RIFF') return null;
      if (buffer.toString('latin1', 8, 12) !== 'WEBP') return null;
      const chunk = buffer.toString('latin1', 12, 16);
      if (chunk === 'VP8X') {
        // 24 位小端「宽-1 / 高-1」
        const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
        const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
        return { width, height };
      }
      if (chunk === 'VP8 ') {
        // 有损：14 位宽高，位于 26/28
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === 'VP8L') {
        // 无损：28 位（14+14）打包在 21..25
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

async function saveBackground(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AppearanceDeps,
): Promise<void> {
  const mime = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) {
    sendJson(res, 415, {
      error: '背景图只支持 JPG、PNG、WebP。',
      code: 'BACKGROUND_TYPE_UNSUPPORTED',
    });
    return;
  }
  const body = await readRawBody(req, MAX_BACKGROUND_BYTES + 1024);
  if (!body || body.length === 0) {
    sendJson(res, 422, {
      error: body ? '背景图片不能为空。' : '背景图片超过 20 MiB。',
      code: body ? 'BACKGROUND_EMPTY' : 'BACKGROUND_TOO_LARGE',
    });
    return;
  }
  if (body.length > MAX_BACKGROUND_BYTES) {
    sendJson(res, 413, {
      error: '背景图片不能超过 20 MiB。',
      code: 'BACKGROUND_TOO_LARGE',
    });
    return;
  }
  const size = readImageSize(body, mime);
  if (!size || !size.width || !size.height) {
    sendJson(res, 422, {
      error: '读不到背景图片的尺寸，请换一张完整的 JPG/PNG/WebP。',
      code: 'BACKGROUND_SIZE_UNREADABLE',
    });
    return;
  }
  if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
    sendJson(res, 422, {
      error: `背景图片尺寸不能超过 ${MAX_DIMENSION}×${MAX_DIMENSION}（当前 ${size.width}×${size.height}）。`,
      code: 'BACKGROUND_TOO_LARGE_DIMENSION',
    });
    return;
  }

  const previous = await readStored(deps.dataDir);
  const stored: StoredBackground = {
    id: randomUUID(),
    ext,
    width: size.width,
    height: size.height,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  const dir = appearanceDir(deps.dataDir);
  mkdirSync(dir, { recursive: true });
  const tmpImage = `${imagePath(deps.dataDir, ext)}.tmp`;
  const tmpMeta = `${metaPath(deps.dataDir)}.tmp`;
  await writeFile(tmpImage, body);
  await writeFile(tmpMeta, JSON.stringify(stored), 'utf8');
  await rename(tmpImage, imagePath(deps.dataDir, ext));
  await rename(tmpMeta, metaPath(deps.dataDir));
  // 换了扩展名就把上一份删掉，别在磁盘上留孤儿
  if (previous && previous.ext !== ext) {
    await rm(imagePath(deps.dataDir, previous.ext), { force: true });
  }
  sendJson(res, 200, { image: toImage(stored) });
}

async function removeBackground(res: ServerResponse, deps: AppearanceDeps): Promise<void> {
  const stored = await readStored(deps.dataDir);
  if (stored) {
    await rm(imagePath(deps.dataDir, stored.ext), { force: true });
    await rm(metaPath(deps.dataDir), { force: true });
  }
  sendJson(res, 200, { image: null });
}

async function serveBackgroundImage(
  res: ServerResponse,
  deps: AppearanceDeps,
  id: string,
): Promise<void> {
  const stored = await readStored(deps.dataDir);
  if (!stored || stored.id !== id) {
    sendJson(res, 404, { error: '背景图不存在。', code: 'BACKGROUND_NOT_FOUND' });
    return;
  }
  const bytes = await readFile(imagePath(deps.dataDir, stored.ext));
  res.writeHead(200, {
    'content-type': EXT_MIME[stored.ext],
    'content-length': String(bytes.length),
    // 换背景时 id 会变，所以可以放心让浏览器长期缓存
    'cache-control': 'public, max-age=31536000, immutable',
  });
  res.end(bytes);
}

/**
 * 处理 /appearance/* 子路径；已处理返回 true。
 * 与其它画布路由同一套签名（见 mediaEditingRouter 的 handleMediaEditing）。
 */
export async function handleAppearanceApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: AppearanceDeps;
}): Promise<boolean> {
  const { req, res, parts, deps } = input;
  const method = (req.method ?? 'GET').toUpperCase();

  if (parts[0] !== 'appearance') return false;

  // /appearance/background/<id>
  if (parts[1] === 'background' && parts.length === 3) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    await serveBackgroundImage(res, deps, parts[2]);
    return true;
  }

  if (parts[1] !== 'background' || parts.length !== 2) return false;

  if (method === 'GET') {
    sendJson(res, 200, { image: toImage(await readStored(deps.dataDir)) });
    return true;
  }
  if (method === 'POST' || method === 'PUT') {
    await saveBackground(req, res, deps);
    return true;
  }
  if (method === 'DELETE') {
    await removeBackground(res, deps);
    return true;
  }
  sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
  return true;
}

/** 诊断用：背景图当前状态（不回显字节）。 */
export async function appearanceStatus(
  dataDir: string,
): Promise<Record<string, unknown>> {
  const stored = await readStored(dataDir);
  return stored
    ? {
        present: true,
        id: stored.id,
        ext: stored.ext,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
      }
    : { present: false };
}
