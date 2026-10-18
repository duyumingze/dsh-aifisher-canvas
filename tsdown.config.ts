import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

/**
 * DSH 插件有三个产物，格式完全不同：
 *
 *   lib/index.js              → host 半（Node ESM）：账号 / ComfyUI / 静态资源 / canvas_control 工具
 *   lib/client/apply.js       → client 半（浏览器）：slot 注册 + React 面板（react 用 DSH 模块表那份）
 *   lib/client/canvas-app.js  → 画布应用（浏览器 ESM）：vendor 进来的 AIFISHER 画布，自成一体
 *
 * client 半必须打成 DSH ModuleLoader 认的形态：
 *
 *   window.__ModuleLoader__.load({
 *     id: '<包名>',
 *     factory: (require) => { var module = { exports: {} }; ... return module.exports; },
 *   });
 *
 * 也就是「CJS 代码外面裹一层懒加载工厂」。react 由浏览器模块表注入，所以保持 external。
 *
 * 画布应用不一样：它带自己的 React 19 与 react-dom 19（AIFISHER 上游就是 React 19，
 * DSH 模块表给的是 React 18，混用会让 hooks 分发器对不上）。它由 host 半作为普通静态
 * JS 文件提供（/api/aifisher/client/canvas-app.js），CanvasPanel 打开时用动态 import 拉取，
 * 所以不必裹 ModuleLoader 外壳，直接输出浏览器 ESM。
 */

const REPO = path.dirname(fileURLToPath(import.meta.url));

/**
 * AIFISHER 源码里有用 Vite 的 `?url` 语义 import 的 SVG（模型商标），
 * rolldown 默认不认识。这里把 .svg 变成 data URL 字符串导出，行为与 Vite 的
 * assetsInlineLimit 内联一致（这些 svg 都很小）。
 */
function svgAsDataUrl() {
  return {
    name: 'aifisher-svg-as-data-url',
    load(id: string) {
      const file = id.split('?')[0];
      if (!file.endsWith('.svg')) return null;
      let svg: string;
      try {
        svg = fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      return { code: `export default ${JSON.stringify(url)};`, moduleType: 'js' as const };
    },
  };
}

/** three / @react-three/* 的替身（见 src/client/canvas/stubs/ 里的说明）。 */
const THREE_STUBS = {
  three: path.join(REPO, 'src/client/canvas/stubs/three.ts'),
  '@react-three/fiber': path.join(REPO, 'src/client/canvas/stubs/react-three-fiber.tsx'),
  '@react-three/drei': path.join(REPO, 'src/client/canvas/stubs/react-three-drei.tsx'),
};

/**
 * `@/*` → src/canvas-ui/*（shadcn 组件内部用它互相引用、并 import `@/lib/utils`）。
 * tsconfig 里也有同样的 paths（给编辑器/类型检查用），但打包器不读那份，
 * 所以这里显式再声明一次；host 半与 client 半不带这个别名 —— 它们不引 shadcn 代码。
 */
const CANVAS_ALIAS = { '@': path.join(REPO, 'src', 'canvas-ui') };

export default defineConfig([
  {
    // host 半：Node ESM + 类型声明
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    dts: true,
    // 清理由 scripts/clean.mjs 统一做：三入口并行构建时 clean 会互相删文件
    clean: false,
    sourcemap: false,
  },
  {
    // client 半：CJS + ModuleLoader 工厂包裹（react 走 DSH 模块表）
    entry: { 'client/apply': 'src/client/apply.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    external: ['react', 'react/jsx-runtime'],
    // tsdown 会把 tsconfig 的 jsxImportSource 透传给 rolldown，但 runtime 又留在 classic，
    // 于是 rolldown 直接报 "importSource cannot be set when runtime is classic"。
    // 这里显式指定 automatic runtime（react-jsx）把它掰回来。
    inputOptions: { jsx: 'react-jsx' },
    // 包是 type:module，默认会把 cjs 产物命名成 apply.cjs；但 exports 里写的是 apply.js
    outExtensions: () => ({ js: '.js' }),
    outputOptions: {
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-aifisher-canvas')}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
      footer: `return module.exports; } });`,
    },
  },
  {
    // 画布应用：浏览器 ESM，自带 React 19，全部依赖打进产物。
    // 单独一个 outDir 是有意的：产品代码按目录整体挂到 /api/aifisher/canvas-app 上，
    // 这样它在运行时按相对路径 import 自己的 chunk（./xxx.js）也能正确解析。
    entry: { 'canvas-app': 'src/client/canvas/mount.tsx' },
    outDir: 'lib/canvas',
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    minify: true,
    alias: { ...THREE_STUBS, ...CANVAS_ALIAS },
    plugins: [svgAsDataUrl()],
    /**
     * 画布内 shadcn 组件的 JSX 走 `@/lib/react` 的 `h` 工厂，而不是标准
     * `react/jsx-runtime` —— 产物里有两份 React，shadcn 组件必须与画布渲染器
     * 用同一份，否则 React 19 抛 #130。详见 src/canvas-ui/lib/react.ts。
     * host 半与 client 半不设这个，仍是标准 runtime。
     */
    inputOptions: { jsx: { mode: 'automatic', jsxImportSource: '@/lib/react' } },
    // 默认会把 dependencies/peerDependencies 判为 external；画布必须自成一体，
    // 所以这里显式要求「全都打进来」（react / react-dom / tiptap / lucide / wavesurfer…）。
    // 注意：**react/react-dom 不能设成 external** —— 产物是浏览器 ESM，external 会退化成
    // CommonJS 互操作里的 `require('react')`，浏览器里直接抛
    // 「Calling `require` for "react" in an environment that doesn't expose the require function」。
    noExternal: [/.*/],
    define: {
      __FISHERAI_BUILD__: JSON.stringify('dsh-aifisher-canvas'),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
  },
]);
