/**
 * sync-shadcn-ui.mjs —— 把 shadcn/ui 官方 registry 的组件源码 vendor 进本插件。
 *
 * 为什么不用 `shadcn add`：
 *   本机 GitHub 不可达（CLI 的模板/骨架走 git clone），但 registry 的 HTTPS 端点可用。
 *   这里直接拉 `https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`，
 *   把 files[].content 落盘到 src/canvas-ui/ui/，并做两处必要改写：
 *
 *   1. `import { cn } from "cn"` → `from "@/lib/utils/"`（registry 用包名占位，本项目用路径别名）
 *   2. `@/registry/new-york-v4/...` → `@/canvas-ui/...`（registry 内部跨组件引用用的路径）
 *
 * 依赖（radix-ui / class-variance-authority / clsx / tailwind-merge）已在本包 dependencies 里。
 * 需要升级某个组件时直接重跑本脚本（幂等：同名文件覆盖，内容来自 registry 当前版本）。
 *
 * 用法：
 *   node scripts/sync-shadcn-ui.mjs            # 同步 COMPONENTS 清单
 *   node scripts/sync-shadcn-ui.mjs --list     # 只打印清单与来源 URL
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const UI_DIR = path.join(REPO, 'src', 'canvas-ui', 'ui');const REGISTRY = 'https://ui.shadcn.com/r/styles/new-york-v4';

/** 画布重设计用到的组件清单（含 registry 依赖，registryDependencies 由脚本自动补齐）。 */
const COMPONENTS = [
  'button',
  'input',
  'textarea',
  'label',
  'badge',
  'separator',
  'kbd',
  'spinner',
  'skeleton',
  'card',
  'tabs',
  'tooltip',
  'popover',
  'dropdown-menu',
  'context-menu',
  'dialog',
  'alert-dialog',
  'sheet',
  'slider',
  'switch',
  'toggle',
  'toggle-group',
  'select',
  'scroll-area',
  'empty',
  'item',
  'field',
  'input-group',
  'command',
];

async function fetchItem(name) {
  const url = `${REGISTRY}/${name}.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} (${url})`);
  return response.json();
}

/** 递归解析 registryDependencies，返回「先依赖后自身」的安装顺序。 */
async function resolveOrder(roots) {
  const items = new Map();
  const order = [];
  const visiting = new Set();
  async function visit(name) {
    if (order.includes(name) || visiting.has(name)) return;
    visiting.add(name);
    const item = items.get(name) ?? (await fetchItem(name));
    items.set(name, item);
    for (const dependency of item.registryDependencies ?? []) await visit(dependency);
    visiting.delete(name);
    order.push(name);
  }
  for (const name of roots) await visit(name);
  return { order, items };
}

function rewrite(content) {
  return content
    .replace(/from "cn"/g, 'from "@/lib/utils"')
    .replace(/from "\.\/utils"/g, 'from "@/lib/utils"')
    .replace(/from "@\/registry\/new-york-v4\/([^"]+)"/g, 'from "@/ui/$1"')
    .replace(/from "@\/registry\/default\/([^"]+)"/g, 'from "@/ui/$1"')
    /**
     * 浮层容器改写（本插件特有，务必保留）：
     * 上游 registry 里每个 `XxxPrimitive.Portal` 都 portal 到 document.body，
     * 而画布的 shadcn 变量只落在 .af-canvas-mount 内 → 浮层会读到 DSH 那份主题、
     * 卸载时还会把浮层留在 DSH 页面上。这里统一注入容器，落到画布容器内部。
     * 详见 src/canvas-ui/lib/portal.ts。
     */
    .replace(
      /<([A-Za-z]+Primitive)\.Portal>/g,
      '<$1.Portal container={canvasPortalTarget()}>',
    )
    .replace(
      /(<[A-Za-z]+Primitive)\.Portal\b(?! container=)/g,
      '$1.Portal container={canvasPortalTarget()}',
    )
    .replace(
      /from "radix-ui"/g,
      'from "radix-ui"\nimport { canvasPortalTarget } from "@/lib/portal"',
    );
}
const listOnly = process.argv.includes('--list');
if (listOnly) {
  for (const name of COMPONENTS) console.log(`${name}\t${REGISTRY}/${name}.json`);
  process.exit(0);
}

const { order, items } = await resolveOrder(COMPONENTS);
fs.mkdirSync(UI_DIR, { recursive: true });

const externalDeps = new Set();
let written = 0;
for (const name of order) {
  const item = items.get(name);
  for (const dependency of item.dependencies ?? []) if (dependency !== 'cn') externalDeps.add(dependency);
  for (const file of item.files ?? []) {
    const base = path.basename(file.path);
    const target = path.join(UI_DIR, base);
    fs.writeFileSync(target, `${rewrite(file.content).trimEnd()}\n`, 'utf8');
    written += 1;
    console.log(`[shadcn] ${name} → src/canvas-ui/ui/${base}`);
  }
}

console.log(`\n[shadcn] 写入 ${written} 个文件（${order.length} 个 registry item）`);
console.log(`[shadcn] 需要的外部依赖：${Array.from(externalDeps).sort().join(', ')}`);
