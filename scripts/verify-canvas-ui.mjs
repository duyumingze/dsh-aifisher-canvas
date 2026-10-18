/**
 * verify-canvas-ui.mjs —— 断言「shadcn 重设计」真的进了画布产物。
 *
 * 这类断言只能看产物：vendor 源码与装配层都对，但打包/别名/样式注入任何一环出问题，
 * 用户看到的就还是旧界面。检查项：
 *   ① 产物里存在我们新头部/工具条/控制条的特征串；
 *   ② 产物里带 shadcn 的 data-slot 标记（说明 radix 组件被真的打进来了）；
 *   ③ 注入样式里有画布作用域的 shadcn 复位与 token 桥接（--color-* → --af-*）。
 *
 * 用法：node scripts/verify-canvas-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BUNDLE = path.join(REPO, 'lib', 'canvas', 'canvas-app.js');

const lines = [];
let failures = 0;
function check(name, ok, extra = '') {
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
  if (!ok) failures += 1;
}

if (!fs.existsSync(BUNDLE)) {
  console.error(`[ui] 找不到 ${path.relative(REPO, BUNDLE)}，先跑 pnpm build`);
  process.exit(1);
}
const bundle = fs.readFileSync(BUNDLE, 'utf8');

// ① 重设计特征：新头部保留了 af-canvas-header 定位串，且带 shadcn 的类名与组件标记。
check(
  '产物里头部保留 af-canvas-header 贴边定位（真机越界检查依赖）',
  bundle.includes('af-canvas-header absolute top-0 left-0'),
);
check(
  '产物里头部用 shadcn Badge（保存状态）',
  bundle.includes('inline-flex w-fit shrink-0 items-center justify-center'),
);
check(
  '产物里项目菜单用 shadcn DropdownMenu',
  bundle.includes('data-slot="dropdown-menu-content"') || bundle.includes('dropdown-menu-content'),
);
check('产物里缩放控件用 shadcn Slider', bundle.includes('data-slot="slider"') || bundle.includes('slider-thumb'));
check('产物里左侧工具条仍保留「添加节点」aria-label（真机建节点场景依赖）', bundle.includes('添加节点'));
check('产物里设置按钮仍是「设置」（真机设置场景依赖）', bundle.includes('设置'));
check(
  '产物里有节点搜索面板（Shift+A：面板 / 输入框 / 建节点事件三件套）',
  bundle.includes('data-fisherai-node-search-panel') &&
    bundle.includes('data-fisherai-node-search-input') &&
    bundle.includes('fisherai:add-canvas-node'),
);
check(
  '产物里有节点搜索的工具栏入口（aria-label=搜索节点）',
  bundle.includes('data-fisherai-node-search-trigger') && bundle.includes('搜索节点'),
);
check(
  '产物里 ComfyUI 胶囊的停靠槽位还在（data-fisherai-account-center-slot）',
  bundle.includes('data-fisherai-account-center-slot'),
);
// v1.36：用户「在画布左上角添加返回项目库按钮；把右上角的 comfui 待启动移动到左边」
check(
  '产物里有「返回项目库」按钮（data-fisherai-back-to-library + aria-label）',
  bundle.includes('data-fisherai-back-to-library') && bundle.includes('返回项目库'),
);
check(
  '产物里有 ComfyUI 胶囊的左侧停靠槽位（data-fisherai-comfyui-slot）',
  bundle.includes('data-fisherai-comfyui-slot'),
);
check(
  'vendor 补丁让胶囊优先停左侧（dockComfyPanel → topbar-left）',
  bundle.includes('topbar-left'),
);
check(
  '任务队列上移到画布右上角（top:8 + 头部让位变量 --fisherai-task-queue-inset）',
  bundle.includes('fisherai-task-queue-inset'),
);
check(
  '产物里小地图保留 data-fisherai-minimap 标记',
  bundle.includes('data-fisherai-minimap'),
);

// ② portal：产物里要有 radix 的浮层包装（浮层是真的走 radix 渲染的）。
//    浮层到底挂在哪个容器里由运行时回归断言（scripts/test-canvas-shadcn-ui.mjs），
//    因为 minify 会把我们自己的函数名改短、无法按名字查。
check(
  '产物里带 radix 浮层包装（data-radix-popper-content-wrapper）',
  bundle.includes('data-radix-popper-content-wrapper'),
);

// ③ 样式：作用域复位 + token 桥接。
const stylePatch = fs.readFileSync(path.join(REPO, 'src', 'client', 'canvas', 'styles.ts'), 'utf8');
check(
  'styles.ts 仍以 .af-canvas-mount 为作用域注入（不污染 DSH 页面）',
  stylePatch.includes('.af-canvas-mount'),
);
const generated = fs.readFileSync(path.join(REPO, 'vendor', 'aifisher', 'tailwind.generated.ts'), 'utf8');
check('生成样式含 shadcn 作用域复位（.af-canvas-mount *,）', /\.af-canvas-mount \*/.test(generated));
check(
  '生成样式含暗色变体（按 data-af-theme 属性，不是 .dark 类）',
  generated.includes('data-af-theme'),
);
check(
  '生成样式含 shadcn token → 画布变量的桥接（--color-border: var(--af-border) 形态）',
  /--color-border:\s*var\(--af-border\)|--af-border\)/.test(generated),
);

lines.push('');
lines.push(`SUMMARY pass=${lines.filter((l) => l.startsWith('PASS')).length} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
