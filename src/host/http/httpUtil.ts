/**
 * DSH webServer 是 node:http 原生路由（不是 Express），
 * handler 直接吃 IncomingMessage / ServerResponse。
 * 这个文件提供最小 JSON 响应 + body 读取 + 静态文件服务工具。
 *
 * 路由注册范式：
 *   ctx.webServer.register({ kind: 'prefix', path: '/api/aifisher/canvas', handler })
 *   // kind: 'exact' 精确匹配 pathname；'prefix' 最长前缀匹配
 *   // 前缀务必取本插件自己的命名空间：DSH 内核也在 /api/ 下挂路由
 *   // （例如平台账号 RPC 就占着 /api/account），抢了会让宿主启动流程报错。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

/** webServer.register 接收的 route 形状（只取我们用到的字段）。 */
export interface WebServerRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

/** duck-typed webServer 服务（避免硬依赖 @deepseek-ai/dsh-host-webserver）。 */
export interface WebServerLike {
  register(route: WebServerRoute): () => void;
}

/**
 * 同源围栏。
 *
 * 背景：插件的 /api/aifisher/* 是用 ctx.webServer.register 裸挂的，**没有** DSH 那层
 * cookie + Host/Origin 鉴权（DSH 的 webserver 本身不做鉴权）。虽然浏览器对跨站
 * 读响应有 CORS 兜着，但「能被任意本地进程/页面触发写操作」仍然是不必要的暴露。
 * 这里做最小成本的收敛：带 Origin 头的跨站请求直接 403；没有 Origin 的（curl、
 * 本机探针、同源 GET）放行。
 *
 * 返回 true 表示「已拒绝」，调用方应立即 return。
 */
export function rejectCrossOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers?.origin;
  if (!origin) return false;
  const host = req.headers?.host;
  let sameOrigin = false;
  try {
    sameOrigin = Boolean(host) && new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin) return false;
  sendJson(res, 403, { error: '跨站请求被拒绝。', code: 'CROSS_ORIGIN_DENIED' });
  return true;
}

/** 读原始 body（素材上传走这条路：Content-Type 是素材本身，body 就是字节）。 */
export function readRawBody(
  req: IncomingMessage,
  limitBytes = 64 * 1024 * 1024,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

/** 发一个 JSON 响应。 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

/** 读 JSON body（带 16kb 上限，防恶意大 body）。失败返回 null。 */
export function readJsonBody(
  req: IncomingMessage,
  limitBytes = 16 * 1024,
): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) finish({});
      try {
        finish(JSON.parse(text));
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * 从 rootDir 下提供一个静态文件。pathname 已经是 URL 里的 pathname，
 * 会做路径穿越防护。文件不存在返回 404；目录请求尝试 index.html。
 *
 * extraHeaders 用来覆盖/补充响应头：插件自己构建出来的 JS（画布应用）
 * 必须带 `cache-control: no-store`，否则改完代码浏览器会一直用旧缓存。
 */
export function serveStaticFile(
  rootDir: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  extraHeaders: Record<string, string> = {},
): void {
  const decoded = decodeURIComponent(pathname);
  const target = resolve(normalize(join(rootDir, decoded)));
  if (target !== rootDir && !target.startsWith(rootDir + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(target)) {
    res.writeHead(404);
    res.end();
    return;
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(target);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  const filePath = st.isDirectory() ? join(target, 'index.html') : target;
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const type = MIME[filePath.slice(filePath.lastIndexOf('.'))] ?? 'application/octet-stream';
  // 素材库图片/视频不做 no-store，允许浏览器缓存。
  // ETag（v1.70）：画布应用那几个大文件靠 304 省掉重复传输；内容变了（重建）etag 就变。
  let etag = '';
  try {
    const fileStat = statSync(filePath);
    etag = `W/"${fileStat.size.toString(16)}-${Math.round(fileStat.mtimeMs).toString(16)}"`;
  } catch {
    /* 拿不到 stat 就不带 etag，按普通 200 返回 */
  }
  const cacheable: Record<string, string> = etag ? { etag } : {};
  for (const name of ['cache-control', 'content-type']) {
    if (extraHeaders[name]) cacheable[name] = extraHeaders[name];
  }
  const ifNoneMatch = req.headers['if-none-match'];
  if (
    etag &&
    typeof ifNoneMatch === 'string' &&
    ifNoneMatch.split(',').some((value) => value.trim() === etag)
  ) {
    res.writeHead(304, cacheable);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': type, ...cacheable, ...extraHeaders });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}
