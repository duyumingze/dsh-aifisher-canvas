/**
 * 插件静态资源托管。
 *
 * client 端 catalog 里图片 URL 是绝对路径：
 *   /creative-presets/style-643.webp
 *   /mj-styles/xxxx.webp
 * DSH webServer 的 fallback 已经被 frontend-static（DSH 自己的 SPA）占用，
 * 我们用 prefix 路由把这两个前缀指向插件 public/ 下对应子目录。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebServerLike } from './http/httpUtil';
import { serveStaticFile } from './http/httpUtil';

/**
 * 解析包根目录。
 *
 * 不能写死相对深度：源码在 src/host/staticAssets.ts（上溯两级到包根），
 * 但产物是 lib/index.js（只上溯一级），同一份代码两种布局。
 * 所以先用包自引用解析 package.json（package.json 已导出 ./package.json），
 * 失败再逐级上溯找 public/creative-presets。
 */
function resolvePackageRoot(): string {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve('dsh-aifisher-canvas/package.json'));
  } catch {
    // 落到下面的目录探测
  }
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(dir, 'public', 'creative-presets'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fileURLToPath(new URL('..', import.meta.url));
}

export function attachStaticAssets(webServer: WebServerLike): void {
  const pkgRoot = resolvePackageRoot();
  const roots: Array<{ prefix: string; dir: string }> = [
    { prefix: '/creative-presets', dir: resolve(pkgRoot, 'public', 'creative-presets') },
    { prefix: '/mj-styles', dir: resolve(pkgRoot, 'public', 'mj-styles') },
    { prefix: '/brand', dir: resolve(pkgRoot, 'public', 'brand') },
  ];

  for (const { prefix, dir } of roots) {
    webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        // pathname 可能就是 prefix 本身（目录请求）或 prefix/foo.webp
        serveStaticFile(dir, pathname.slice(prefix.length) || '/', req, res);
      },
    });
  }

  /**
   * 画布自己的品牌图在源码里是**根路径**字面量（`vendor/.../dialogs/canvasHeader.tsx`
   * 写的是 `src="/aifisher-mark-white.svg"`，上游把它放在 Vite 的 public/ 根下）。
   * 我们不打算为了这个改 vendor，所以直接把这两个文件名挂在根路径上：
   * 文件放在 public/brand/，但对外就是上游原本的 URL，vendor 一行不用动。
   *
   * 不挂的话画布左上角那个「项目菜单」按钮是一张裂图（菜单本身还能点，但看起来像坏了），
   * 而「保存退出 / 退出项目」就在那个菜单里。
   *
   * ⚠️ 这两个文件名里的**内容**已经是渡雨鸣泽的标识（2026-10-25 换的）：
   * 文件名沿用上游是为了不动 vendor / 回归脚本里写死的 URL，映射关系见
   * public/brand/README.md。要换回别的版本就覆盖 public/brand/ 里同名文件。
   */
  for (const file of ['aifisher-mark-white.svg', 'aifisher-mark-black.svg']) {
    webServer.register({
      kind: 'exact',
      path: `/${file}`,
      handler: (req, res) => {
        serveStaticFile(resolve(pkgRoot, 'public', 'brand'), `/${file}`, req, res);
      },
    });
  }

  // 画布应用（自己构建出来的浏览器 ESM，含按相对路径引用的 chunk）：
  // 整目录挂在 /api/aifisher/canvas-app 下，靠 no-store 保证每次重新构建后
  // 页面拿到的是新代码（开发期反复 pnpm build + 刷新）。
  const canvasAppDir = resolve(pkgRoot, 'lib', 'canvas');
  webServer.register({
    kind: 'prefix',
    path: CANVAS_APP_PREFIX,
    handler: (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      const rest = pathname.slice(CANVAS_APP_PREFIX.length) || '/';
      if (!existsSync(canvasAppDir)) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(
          '画布应用尚未构建：缺少 lib/canvas。请在插件目录执行 pnpm build 后刷新页面。',
        );
        return;
      }
      serveStaticFile(canvasAppDir, rest, req, res, { 'cache-control': 'no-store' });
    },
  });
}

/** 画布应用（浏览器 ESM）的挂载前缀。client 半按这个前缀拼 URL 动态 import。 */
export const CANVAS_APP_PREFIX = '/api/aifisher/canvas-app';
