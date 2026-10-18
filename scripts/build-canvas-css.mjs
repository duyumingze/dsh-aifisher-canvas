/**
 * build-canvas-css.mjs —— 生成画布用的 Tailwind CSS，并包成 TS 模块。
 *
 * 为什么要这一步：
 *   AIFISHER 是 Vite + @tailwindcss/vite 应用，组件里大量用 Tailwind 工具类。
 *   本插件用 tsdown 打包，没有 Vite 的 CSS 管线，所以要自己跑一次 Tailwind CLI，
 *   把 class 扫出来编译成静态 CSS，再作为字符串塞进 client bundle 运行时注入。
 *
 * 关键取舍：**不要 preflight**。
 *   `@import 'tailwindcss'` 会连带 preflight（全局 reset：* 的 margin/border/box-sizing…），
 *   而这段 CSS 是注入到 DSH 自己的页面里的，preflight 会把 DSH 的界面一起重置。
 *   这里只取 theme + utilities 两层。
 *
 * 输出：
 *   .dsh-build/tailwind.css          —— 原始产物（调试用）
 *   vendor/aifisher/tailwind.generated.ts —— `export const TAILWIND_CSS = '...'`
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const INPUT = path.join(REPO, 'src', 'client', 'canvas', 'tailwind-entry.css');
const OUT_DIR = path.join(REPO, '.dsh-build');
const OUT_CSS = path.join(OUT_DIR, 'tailwind.css');
const OUT_TS = path.join(REPO, 'vendor', 'aifisher', 'tailwind.generated.ts');

// @tailwindcss/cli 的入口（pnpm 布局下就在本包 node_modules 里）
//
// 为什么要两处候选：这台机器把项目从 E: 搬到了 D:（E: 已不存在），搬迁工具把 pnpm 的
// **符号链接解引用成了真实目录**，于是 `node_modules/@tailwindcss/cli` 变成了一个「没有
// 兄弟姐妹」的包目录 —— 它 import 的 `mri` / `enhanced-resolve` 等依赖其实躺在
// `node_modules/.pnpm/@tailwindcss+cli@<版本>/node_modules/` 下，而 Node 从那个真实目录
// 往上找是找不到的（报 `Cannot find package 'mri'`）。
// 从 `.pnpm` 里的真实路径启动 CLI，依赖解析就恢复正常，且**不用改动 node_modules**。
// 所以 **`.pnpm` 真实路径优先**：直连路径在「解引用过的 node_modules」上是坏的（文件在、
// 依赖找不到），只有它不存在时才回退到直连路径（正常的 pnpm 符号链接布局下也够用）。
const CLI_CANDIDATES = [
  ...(() => {
    const pnpmDir = path.join(REPO, 'node_modules', '.pnpm');
    if (!fs.existsSync(pnpmDir)) return [];
    return fs
      .readdirSync(pnpmDir)
      .filter((name) => name.startsWith('@tailwindcss+cli@'))
      .sort()
      .reverse()
      .map((name) =>
        path.join(pnpmDir, name, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs'),
      );
  })(),
  path.join(REPO, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs'),
].filter((candidate) => fs.existsSync(candidate));

const CLI = CLI_CANDIDATES[0];

if (CLI === undefined) {
  console.error(
    '[canvas-css] 找不到 Tailwind CLI（试过 node_modules 直连路径与 .pnpm 真实路径）\n先跑 pnpm install。',
  );
  process.exit(1);
}
if (!fs.existsSync(path.join(REPO, 'vendor', 'aifisher', 'src'))) {
  console.error('[canvas-css] vendor/aifisher/src 不存在，先跑 pnpm vendor。');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const result = spawnSync(process.execPath, [CLI, '-i', INPUT, '-o', OUT_CSS, '--minify'], {
  cwd: REPO,
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.error(`[canvas-css] Tailwind CLI 退出码 ${result.status}`);
  process.exit(result.status ?? 1);
}

const css = fs.readFileSync(OUT_CSS, 'utf8');
fs.writeFileSync(
  OUT_TS,
  `/**
 * 由 scripts/build-canvas-css.mjs 生成，请勿手改。
 * 来源：src/client/canvas/tailwind-entry.css（theme + utilities，**不含 preflight**）
 * 字节数：${Buffer.byteLength(css, 'utf8')}
 */
export const TAILWIND_CSS = ${JSON.stringify(css)};
`,
);

console.log(
  `[canvas-css] 生成 ${path.relative(REPO, OUT_TS)}（${(Buffer.byteLength(css, 'utf8') / 1024).toFixed(0)} KB）`,
);
