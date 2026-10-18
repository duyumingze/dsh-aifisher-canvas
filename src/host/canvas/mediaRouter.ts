/**
 * 画布素材接口（host 半）
 *
 * 对应上游 server/media/mediaAssetRouter.js（40KB）里画布真正会用到的那几条：
 *
 *   POST   /api/aifisher/canvas/assets/upload/<kind>s       原始 body + x-filename 头
 *   POST   /api/aifisher/canvas/assets/import/<kind>s       { path, projectId, nodeId }（本机文件）
 *   POST   /api/aifisher/canvas/assets/<kind>s              { data: dataURL, ... }
 *   GET    /api/aifisher/canvas/assets/<kind>s?projectId=&limit=&offset=
 *   DELETE /api/aifisher/canvas/assets/<kind>s/<id>?projectId=
 *   POST   /api/aifisher/canvas/assets/<kind>s/<id>/trash?projectId=
 *
 *   GET    /api/aifisher/canvas/media/<projectId>/<kind>s/<file>   素材本体（画布直接当 src 用）
 *   GET    /api/aifisher/canvas/proxy?url=                          给跨域素材兜一层代理
 *
 * 上游还支持 2GB 视频分片、内容嗅探、目录授权、回收站恢复等；本插件第一版只到
 * 「上传→落盘→列表→删除（进回收站）→取回」。没做的路径统一回落 NOT_PORTED。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { readJsonBody, readRawBody, sendJson } from '../http/httpUtil';
import {
  assertExtensionForType,
  MediaError,
  mediaTypeOf,
  parseDataUrl,
  type MediaStore,
  type MediaType,
} from './mediaStore';

/** 素材接口用的最小依赖。 */
export interface MediaRouterDeps {
  mediaStore: MediaStore;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof MediaError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  sendJson(res, 500, {
    error: error instanceof Error ? error.message : '素材处理失败',
    code: 'MEDIA_FAILED',
  });
}

/** 流式回一个素材文件（支持 Range 到「整段」级别：视频拖动进度条需要 206）。 */
function serveMediaFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
): void {
  const stat = statSync(filePath);
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  // 文件名带随机后缀，内容不会变 —— 可以放心长缓存
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
  };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (Number.isFinite(start) && start <= end && start < stat.size) {
        const bounded = Math.min(end, stat.size - 1);
        res.writeHead(206, {
          ...headers,
          'content-range': `bytes ${start}-${bounded}/${stat.size}`,
          'content-length': bounded - start + 1,
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(filePath, { start, end: bounded }).pipe(res);
        return;
      }
    }
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

/** 给跨域素材兜一层代理（画布的 readableMediaUrl 会用它）。 */
async function proxyRemote(res: ServerResponse, rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    sendJson(res, 422, { error: '代理地址无效。', code: 'INVALID_PROXY_URL' });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    sendJson(res, 422, { error: '只允许代理 http/https 地址。', code: 'INVALID_PROXY_URL' });
    return;
  }
  // 与上游 externalUrlPolicy 同向：不跟随跳转（跳转后的地址可能是内网/回环）
  let response: Response;
  try {
    response = await fetch(parsed.href, {
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    sendJson(res, 502, {
      error: `代理取数失败：${error instanceof Error ? error.message : String(error)}`,
      code: 'PROXY_FAILED',
    });
    return;
  }
  if (!response.ok || !response.body) {
    sendJson(res, 502, { error: `代理取数失败（${response.status}）`, code: 'PROXY_FAILED' });
    return;
  }
  const headers: Record<string, string> = {
    'cache-control': 'private, max-age=600',
  };
  const contentType = response.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  const length = response.headers.get('content-length');
  if (length) headers['content-length'] = length;
  res.writeHead(200, headers);
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(value);
  }
  res.end();
}

/**
 * 处理画布命名空间下与素材/媒体文件相关的请求。
 * 已处理返回 true；未匹配返回 false（交回 restRouter 走 NOT_PORTED）。
 */
export async function handleMediaApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps: MediaRouterDeps;
}): Promise<boolean> {
  const { req, res, url, parts, deps } = input;
  const { mediaStore } = deps;
  const method = (req.method ?? 'GET').toUpperCase();

  // ---- 素材文件本体：/media/<projectId>/<kind>s/<file> ----
  if (
    parts[0] === 'media' &&
    parts.length === 4 &&
    parts[1] !== 'thumbnail' &&
    parts[1] !== 'edits' &&
    mediaTypeOf(parts[2]) !== null
  ) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const resolved = mediaStore.resolveFile(parts[1], parts[2] as MediaType, parts[3]);
    if (!resolved) {
      sendJson(res, 404, { error: '素材不存在。', code: 'MEDIA_NOT_FOUND' });
      return true;
    }
    serveMediaFile(req, res, resolved.path);
    return true;
  }

  // ---- 跨域代理 ----
  if (parts[0] === 'proxy' && parts.length === 1) {
    const target = url.searchParams.get('url') ?? '';
    if (!target) {
      sendJson(res, 422, { error: 'url 必填。', code: 'INVALID_PROXY_URL' });
      return true;
    }
    await proxyRemote(res, target);
    return true;
  }

  if (parts[0] !== 'assets') return false;

  try {
    // ---- 列表：GET /assets/<kind>s ----
    //
    // ⚠️ 只有 GET 走这里。以前这里对所有「非 GET」直接回 405 —— 而画布把编辑结果
    // （裁剪/标注/组合的 data URL）正是 POST 到同一个路径 `/assets/<kind>s`，
    // 于是「保存为新图片」永远拿到 405 method not allowed，图片根本没落进素材库，
    // 画布上也就不会出现新节点。POST 必须继续往下走到下面的 data URL 落盘分支。
    if (parts.length === 2) {
      const type = mediaTypeOf(parts[1]);
      if (!type) {
        sendJson(res, 400, { error: '素材类型无效。', code: 'INVALID_MEDIA_TYPE' });
        return true;
      }
      // 非 GET 不在这里收口：POST 由下面的「data URL 落盘」处理，
      // 其余方法在那一支里回 405（语义与原来一致，只是不再吞掉 POST）。
      if (method === 'GET') {
        const projectId = url.searchParams.get('projectId') ?? 'default';
        const limit = Number(url.searchParams.get('limit') ?? 20);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const page = await mediaStore.list({
          projectId,
          type,
          limit: Number.isFinite(limit) ? limit : 20,
          offset: Number.isFinite(offset) ? offset : 0,
        });
        sendJson(res, 200, page);
        return true;
      }
    }

    // ---- 上传：POST /assets/upload/<kind>s（原始 body） ----
    if (parts.length === 3 && parts[1] === 'upload') {
      const type = mediaTypeOf(parts[2]);
      if (!type) {
        sendJson(res, 400, { error: '素材类型无效。', code: 'INVALID_MEDIA_TYPE' });
        return true;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      const filename = decodeURIComponent(String(req.headers['x-filename'] ?? '')) || 'upload';
      const projectId = String(req.headers['x-project-id'] ?? '') || 'default';
      const nodeId = String(req.headers['x-node-id'] ?? '') || undefined;
      assertExtensionForType(filename, type);
      const bytes = await readRawBody(req);
      if (!bytes) {
        sendJson(res, 413, { error: '素材读取失败或超过大小上限。', code: 'MEDIA_TOO_LARGE' });
        return true;
      }
      const record = await mediaStore.save({
        projectId,
        type,
        bytes,
        filename,
        ...(nodeId ? { nodeId } : {}),
        source: 'upload',
      });
      sendJson(res, 200, { url: record.url, asset: record });
      return true;
    }

    // ---- 本机文件导入：POST /assets/import/<kind>s ----
    if (parts.length === 3 && parts[1] === 'import') {
      const type = mediaTypeOf(parts[2]);
      if (!type) {
        sendJson(res, 400, { error: '素材类型无效。', code: 'INVALID_MEDIA_TYPE' });
        return true;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      const body = (await readJsonBody(req, 64 * 1024)) as {
        path?: unknown;
        projectId?: unknown;
        nodeId?: unknown;
        filename?: unknown;
      } | null;
      const sourcePath = typeof body?.path === 'string' ? body.path : '';
      if (!sourcePath) {
        sendJson(res, 422, { error: 'path 必填。', code: 'INVALID_MEDIA_IMPORT' });
        return true;
      }
      const absolute = resolve(sourcePath);
      if (!existsSync(absolute)) {
        sendJson(res, 404, { error: '源文件不存在。', code: 'MEDIA_SOURCE_MISSING' });
        return true;
      }
      const filename =
        typeof body?.filename === 'string' && body.filename ? body.filename : basename(absolute);
      assertExtensionForType(filename, type);
      const bytes = await readFile(absolute);
      const record = await mediaStore.save({
        projectId: typeof body?.projectId === 'string' && body.projectId ? body.projectId : 'default',
        type,
        bytes,
        filename,
        ...(typeof body?.nodeId === 'string' && body.nodeId ? { nodeId: body.nodeId } : {}),
        source: 'import',
      });
      sendJson(res, 200, { url: record.url, asset: record });
      return true;
    }

    // ---- data URL 落盘：POST /assets/<kind>s ----
    if (parts.length === 2) {
      const type = mediaTypeOf(parts[1]);
      if (type) {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return true;
        }
        const body = (await readJsonBody(req, 256 * 1024 * 1024)) as {
          data?: unknown;
          prompt?: unknown;
          projectId?: unknown;
          nodeId?: unknown;
          filename?: unknown;
        } | null;
        const data = typeof body?.data === 'string' ? body.data : '';
        if (!data.startsWith('data:')) {
          sendJson(res, 422, { error: 'data 必须是 data URL。', code: 'INVALID_DATA_URL' });
          return true;
        }
        const { contentType } = parseDataUrl(data);
        const extension = contentType.includes('video')
          ? '.mp4'
          : contentType.includes('audio')
            ? '.mp3'
            : '.png';
        const record = await mediaStore.saveDataUrl(data, {
          projectId:
            typeof body?.projectId === 'string' && body.projectId
              ? body.projectId
              : String(req.headers['x-project-id'] ?? '') || 'default',
          type,
          filename: typeof body?.filename === 'string' && body.filename ? body.filename : `media${extension}`,
          extension,
          ...(typeof body?.nodeId === 'string' && body.nodeId ? { nodeId: body.nodeId } : {}),
          ...(typeof body?.prompt === 'string' && body.prompt ? { prompt: body.prompt } : {}),
          source: 'upload',
        });
        sendJson(res, 200, { url: record.url, asset: record });
        return true;
      }
    }

    // ---- 删除 / 回收站：/assets/<kind>s/<id>[/trash] ----
    if (parts.length >= 3) {
      const type = mediaTypeOf(parts[1]);
      if (!type) {
        sendJson(res, 400, { error: '素材类型无效。', code: 'INVALID_MEDIA_TYPE' });
        return true;
      }
      const id = parts[2];
      const trashed = parts.length === 4 && parts[3] === 'trash';
      if (parts.length > 4 || (parts.length === 4 && !trashed)) {
        sendJson(res, 404, { error: '未知的素材路由。', code: 'NOT_PORTED' });
        return true;
      }
      const allowed = trashed ? method === 'POST' : method === 'DELETE';
      if (!allowed) {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      const projectId = url.searchParams.get('projectId') ?? 'default';
      const ok = await mediaStore.trash({ projectId, type, id });
      if (!ok) {
        sendJson(res, 404, { error: '素材不存在。', code: 'MEDIA_NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, { success: true });
      return true;
    }
  } catch (error) {
    fail(res, error);
    return true;
  }

  return false;
}
