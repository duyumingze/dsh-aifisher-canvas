/**
 * vendor-aifisher.mjs —— 把 AIFISHER 开源画布源码树 "vendored" 进本插件。
 *
 * 为什么要 vendor（复制）而不是引用：
 *   隔壁仓库 AIFISHER-main 是 Vite 应用，本插件是 tsdown 打包的 DSH Web 插件，
 *   两边构建链、React 版本、CSS 管线都不同。跨仓库相对路径引用既打不了包，
 *   也会让插件安装包丢失源码。所以复制一份进 vendor/，由本插件自己的构建链打包。
 *
 * 脚本做四件事：
 *   1. 复制 src/ 整棵树 + 许可证/SOURCE-SCOPE 到 vendor/aifisher/（保持 src/ 层级，
 *      这样源码里 `../../../package.json` 这种相对路径依然解析得到）；
 *   2. 生成 vendor/aifisher/package.json，给上面的 import 提供 version；
 *   3. 摘掉源码里的 `import './x.css'`（浏览器 bundle 里 import CSS 没法处理），
 *      把 CSS 文件按首次出现顺序收集起来；
 *   4. 生成 vendor/aifisher/styles.generated.ts：把所有 CSS 拼成一个字符串导出，
 *      client 半在运行时一次性注入 <style>。
 *      —— 顺带把 canvas.css 里 `html, body, #root { height:100% }` 那段中立化：
 *         那段是给 AIFISHER 独立外壳用的，直接注进 DSH 页面会把 DSH 自己的布局搞坏。
 *
 * 用法：pnpm vendor   （或 node scripts/vendor-aifisher.mjs）
 * 源目录可用环境变量 AIFISHER_SRC 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/**
 * 上游源码树在哪。
 * 仍然允许 AIFISHER_SRC 覆盖，但默认改成「按候选顺序自动探测」而不是写死盘符 ——
 * 这台机器搬过好几次家（E: 已不存在；2026-10-16 实测上游源码落在
 * `D:\Program Files\AIFISHER-main`，插件本体在 D:\AllAssets\DSH插件\dsh-aifisher-canvas），
 * 写死盘符就再也构建不了。
 * 顺序：环境变量 → 与仓库同级（../AIFISHER-main，最稳） → D:\Program Files\AIFISHER-main
 * → D:\AllAssets\DSH插件\AIFISHER-main → G:/开源项目 → E:/开源项目（历史路径，留着兜底）。
 */
const SRC_CANDIDATES = [
  process.env.AIFISHER_SRC,
  path.resolve(REPO, '..', 'AIFISHER-main'),
  'D:/Program Files/AIFISHER-main',
  'D:/AllAssets/DSH插件/AIFISHER-main',
  'G:/开源项目/AIFISHER-main',
  'E:/开源项目/AIFISHER-main',
].filter((value) => typeof value === 'string' && value.length > 0);

const SRC_ROOT = SRC_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'package.json')));
const VENDOR = path.join(REPO, 'vendor', 'aifisher');

if (!SRC_ROOT) {
  console.error(
    `[vendor] 找不到 AIFISHER 源码，试过这些目录：\n  - ${SRC_CANDIDATES.join('\n  - ')}\n` +
      '用环境变量 AIFISHER_SRC 指定源码树根目录。',
  );
  process.exit(1);
}

// ---------------------------------------------------------------- 1) 复制源码树

const SKIP_DIRS = new Set(['test', '__tests__', 'node_modules', '.git']);
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function copyTree(from, to, stats) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyTree(path.join(from, entry.name), path.join(to, entry.name), stats);
      continue;
    }
    if (SKIP_FILE.test(entry.name)) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    stats.files += 1;
  }
}

fs.rmSync(VENDOR, { recursive: true, force: true });
const stats = { files: 0 };
copyTree(path.join(SRC_ROOT, 'src'), path.join(VENDOR, 'src'), stats);

for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'SOURCE-SCOPE.md']) {
  const from = path.join(SRC_ROOT, name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(VENDOR, name));
}

// 源码里有 `import { version } from '../../../package.json'`，需要一个真 package.json 兜底
const upstream = JSON.parse(fs.readFileSync(path.join(SRC_ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(VENDOR, 'package.json'),
  `${JSON.stringify(
    {
      name: 'aifisher-canvas-vendor',
      version: upstream.version,
      private: true,
      type: 'module',
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(VENDOR, 'VENDOR.md'),
  [
    '# 这里是从 AIFISHER 源码树复制过来的代码',
    '',
    `- 上游仓库：${SRC_ROOT}`,
    `- 上游版本：${upstream.version}`,
    '- 由 `scripts/vendor-aifisher.mjs` 生成，**不要手改**；要改就改脚本或写适配层。',
    '- 许可证沿用上游 `LICENSE`（AIFISHER Noncommercial Source License 1.0，非商用）。',
    '',
  ].join('\n'),
);

// ---------------------------------------------------------------- 2) 摘 CSS import + 收集 CSS

const cssFiles = [];
const cssSeen = new Set();
let touched = 0;

const SIDE_EFFECT_CSS = /^[ \t]*import\s+['"]([^'"]+\.css)['"];?[ \t]*\r?\n/gm;

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

walk(path.join(VENDOR, 'src'), (file) => {
  if (!/\.(ts|tsx|mts|cts)$/.test(file)) return;
  const original = fs.readFileSync(file, 'utf8');
  let next = original;

  // 只允许「副作用式」CSS import；带绑定的形式要显式报错，避免悄悄丢样式
  const boundCss = /^[ \t]*import\s+\w+\s+from\s+['"]([^'"]+\.css)['"]/m.exec(original);
  if (boundCss) {
    throw new Error(`[vendor] 暂不支持带绑定的 CSS import：${boundCss[1]} @ ${path.relative(VENDOR, file)}`);
  }

  next = next.replace(SIDE_EFFECT_CSS, (_m, spec) => {
    const rel = path
      .relative(path.join(VENDOR, 'src'), path.resolve(path.dirname(file), spec))
      .replace(/\\/g, '/');
    if (!cssSeen.has(rel)) {
      cssSeen.add(rel);
      cssFiles.push(rel);
    }
    return '';
  });

  if (next !== original) {
    fs.writeFileSync(file, next);
    touched += 1;
  }
});

// ---------------------------------------------------------------- 3) 改后端 REST 命名空间

/**
 * AIFISHER 前端调自己的后端一律写 `/api/xxx`。DSH 主进程也在 /api 下挂路由
 * （平台账号 RPC 占着 /api/account，抢了会让桌面版起不来），所以插件的一切 HTTP
 * 必须收进自己的命名空间。这里把源码里「以 /api/ 开头的字符串字面量」统一改写成
 * `/api/aifisher/canvas/xxx`：
 *
 *   '/api/workflows'          → '/api/aifisher/canvas/workflows'
 *   `/api/folders/${id}`      → `/api/aifisher/canvas/folders/${id}`
 *
 * 只匹配「引号后面紧跟 /api/」的形式，绝对 URL（https://host/api/…）与
 * 其他不以 / 开头的写法都不会被误伤（脚本会打印命中数，异常时肉眼可见）。
 */
const API_LITERAL = /(['"`])\/api\//g;
let apiRewrites = 0;
let apiFiles = 0;

walk(path.join(VENDOR, 'src'), (file) => {
  if (!/\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(file)) return;
  const original = fs.readFileSync(file, 'utf8');
  let hits = 0;
  const next = original.replace(API_LITERAL, (_m, quote) => {
    hits += 1;
    return `${quote}/api/aifisher/canvas/`;
  });
  if (hits > 0) {
    fs.writeFileSync(file, next);
    apiRewrites += hits;
    apiFiles += 1;
  }
});

// ---------------------------------------------------------------- 3.5) 修上游缺陷

/**
 * 上游缺陷（已确认，会真崩）：nodes/canvasNodeRules.ts 里
 *   positive(window.__FISHERAI_WORKFLOW_NODES__?.getNodeSize(node).width)
 * `?.` 只保护到方法调用：没有该全局时 `undefined?.getNodeSize(node)` → undefined，
 * 紧接着 `.width` 就 TypeError。而 nodeWidth/nodeHeight 在**每次渲染**都会被调用，
 * 所以只要页面里出现一个 ComfyUI workflow 节点就会白屏。
 *
 * 这里补一个 `?.`（语义等价于上游意图：拿不到就给默认值 520）。
 * 属于「移植期必须修的上游 bug」，改的是 vendor 副本，上游仓库不动。
 */
const UNGUARDED_NODE_SIZE =
  /__FISHERAI_WORKFLOW_NODES__\?\.getNodeSize\(node\)\.(width|height)/g;
let bugFixes = 0;
walk(path.join(VENDOR, 'src'), (file) => {
  if (!/canvasNodeRules\.ts$/.test(file)) return;
  const original = fs.readFileSync(file, 'utf8');
  const next = original.replace(UNGUARDED_NODE_SIZE, (_m, field) => {
    bugFixes += 1;
    return `__FISHERAI_WORKFLOW_NODES__?.getNodeSize(node)?.${field}`;
  });
  if (next !== original) fs.writeFileSync(file, next);
});
if (bugFixes === 0) {
  throw new Error(
    '[vendor] 预期修复的 canvasNodeRules 缺 ?. 缺陷没找到 —— 上游可能已修，请核对后删掉这条补丁',
  );
}

// ---------------------------------------------------------------- 3.6) 媒体 URL 命名空间归一化

/**
 * 上游把「素材是不是本站素材」的判断写死成 `/library/media/...` 前缀
 * （素材库在它自己的 server 里就是挂在 /library 下的）。本插件的素材 URL 是
 * `/api/aifisher/canvas/media/<项目>/<类型>/<文件>`，于是这几处判断会把**我们自己生成/上传的素材**
 * 判成外部资源，表现是：
 *   - 节点图上的缩略图增强层不生效（stableMediaDomAdapter.toPreviewUrl 直接返回原图）；
 *   - dashboard 的项目封面不做预览（projectDashboardChrome）；
 *   - agent 的 media 动作（crop / grid / frames / trim）在进入媒体端点前就回 UNAVAILABLE（canvasMediaControl）。
 *
 * 只改「前缀判断 / 模板拼接」两种形态，不碰真正的 fetch 路径
 * （例如 promptPresets 的 `/library/prompts/prompt.json` 是上游另一个后端，必须原样保留）。
 */
const MEDIA_NAMESPACE_TEMPLATE = /\/library\/media\/\$\{/g;
const MEDIA_NAMESPACE_CHECK = /startsWith\((['"])\/library\/(?:media\/)?\1\)/g;
let mediaNamespaceRewrites = 0;

walk(path.join(VENDOR, 'src'), (file) => {
  if (!/\.(ts|tsx)$/.test(file)) return;
  const original = fs.readFileSync(file, 'utf8');
  let hits = 0;
  let next = original.replace(MEDIA_NAMESPACE_TEMPLATE, () => {
    hits += 1;
    return '/api/aifisher/canvas/media/${';
  });
  next = next.replace(MEDIA_NAMESPACE_CHECK, (_m, quote) => {
    hits += 1;
    return `startsWith(${quote}/api/aifisher/canvas/media/${quote})`;
  });
  if (hits > 0) {
    fs.writeFileSync(file, next);
    mediaNamespaceRewrites += hits;
  }
});
if (mediaNamespaceRewrites < 4) {
  throw new Error(
    `[vendor] 媒体命名空间归一化只命中 ${mediaNamespaceRewrites} 处（预期 ≥4）—— 上游可能改了判断写法，请核对`,
  );
}
console.log(
  `[vendor] 素材 URL 命名空间归一化：${mediaNamespaceRewrites} 处（/library/media → /api/aifisher/canvas/media）`,
);

// ---------------------------------------------------------------- 3.7) 画布外壳贴边元素：fixed → absolute

/**
 * 上游画布是**独占整个窗口**的应用，所以它的「外壳贴边元素」都用 `position: fixed`
 * 相对窗口定位：
 *   - 头部（`fixed top-0 left-0 w-full`，不透明，56px 高）
 *   - 左侧节点工具条（`fixed left-4 top-1/2`）
 *   - 左下缩放控件 / 快捷键问号
 *   - 小地图（`fixed bottom-[80px] left-6`）
 *
 * 嵌进 DSH 后这些元素是相对**整个 DSH 窗口**定位的，而画布只占中间的 main 区：
 * 结果是它们全部跑到左侧边栏上面（头部盖住侧边栏顶部、工具条压在侧边栏中段、
 * 缩放控件压住侧边栏左下角），把 DSH 自己的导航——也就是面板唯一的出口——挡住。
 *
 * 改成 absolute 后，包含块变成最近的定位祖先 = CanvasPanel 的容器（position:relative），
 * 于是它们贴在**画布面板**的边上（这正是本来想要的语义）。
 *
 * 只改这一批「贴边/贴角」元素：右键菜单、媒体工具条、提示气泡那些是**鼠标坐标**定位的
 * （left/top 直接来自 clientX/clientY，见 canvasContextMenu/canvasWorkflow），
 * 它们的坐标系就是视口，改成 absolute 会整体偏移，所以保持 fixed 不动。
 * 全屏对话框（fixed inset-0）同理保持 fixed：它们是模态，盖住整个窗口是预期行为。
 */
const ANCHORED_SHELL_PATCHES = [
  {
    file: 'src/stable/dialogs/canvasHeader.tsx',
    from: 'af-canvas-header fixed top-0 left-0',
    to: 'af-canvas-header absolute top-0 left-0',
    why: '头部横跨整个窗口时会压住侧边栏顶部（新建会话/品牌行）',
  },
  {
    file: 'src/stable/dialogs/canvasSidebar.tsx',
    from: 'fixed left-4 top-1/2 -translate-y-1/2',
    to: 'absolute left-4 top-1/2 -translate-y-1/2',
    why: '左侧节点工具条贴窗口左缘时会压在 DSH 侧边栏中段',
  },
  {
    file: 'src/stable/dialogs/canvasViewportControls.tsx',
    from: 'fixed bottom-6 left-6 h-[42px]',
    to: 'absolute bottom-6 left-6 h-[42px]',
    why: '缩放控件贴窗口左下角时会压在 DSH 侧边栏底部',
  },
  {
    file: 'src/stable/dialogs/canvasViewportControls.tsx',
    from: 'fixed bottom-6 left-[240px] z-50 group',
    to: 'absolute bottom-6 left-[240px] z-50 group',
    why: '快捷键问号跟缩放控件同一排，一起贴画布左边',
  },
  {
    file: 'src/stable/dialogs/canvasMinimap.tsx',
    from: 'fixed bottom-[80px] left-6',
    to: 'absolute bottom-[80px] left-6',
    why: '小地图贴窗口左下角时会压在 DSH 侧边栏底部',
  },
  {
    file: 'src/stable/agent/canvasAgentPanel.tsx',
    from: 'fixed top-0 right-0 h-full border-l flex flex-col z-40',
    to: 'absolute top-0 right-0 h-full border-l flex flex-col z-40',
    why: '右侧对话面板 fixed 时贴的是整个 DSH 窗口的右缘（越过画布面板、压住侧边栏），应贴画布面板右缘',
  },
  {
    file: 'src/stable/agent/canvasAgentChrome.tsx',
    from: 'fixed bottom-6 right-6 rounded-full',
    to: 'absolute bottom-20 right-6 rounded-full',
    why: '助手启动球 fixed 时浮在整个 DSH 窗口右下角，且与我们的「退出画布」按钮重叠；改成贴画布右下并抬高一点',
  },
];

{
  const missing = [];
  for (const patch of ANCHORED_SHELL_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      missing.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      missing.push(`${patch.file}: "${patch.from}" 命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (missing.length > 0) {
    throw new Error(
      `[vendor] 画布外壳 fixed→absolute 补丁没对齐（上游可能改了写法，请核对）：\n  - ${missing.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 画布外壳 fixed→absolute：${ANCHORED_SHELL_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8) 本地工作流节点的入口（两处一行改写）

/**
 * 上游「ComfyUI 节点」只有两条创建路径：旧项目里存着的节点，以及**工作流库**
 * （`fisherai:open-workflow-library` → workflowManager 那套 workflow-runtime）。
 * 本插件没移植 workflow-runtime（它连带 definition store / binding compiler / deployment /
 * run store，见 README 的「还没接上的两块」），于是那个事件没有任何监听者 ——
 * 结果就是：画布上根本没法新建 ComfyUI 节点，我们换掉的通用本地工作流节点没人能到达。
 *
 * 这里把两个入口改到「真的能建出节点」的路上：
 *   ① 右键/加号菜单里的「ComfyUI 工作流」→ 直接建节点（`createCanvasNode('ComfyUI')`
 *      取 workflowTemplates[0]，也就是自定义工作流清单里的第一个；没有自定义工作流时
 *      就是内置的 MiniMax H3，与上游行为一致）；
 *   ② 左侧工具条的「工作流节点」按钮 → 打开同一个「添加节点」菜单（原来派发的是那个没人听的
 *      工作流库事件）。
 *
 * 每条断言「恰好命中 1 次」：上游改了写法就报错，不会静默失效。
 */
const UI_ENTRY_PATCHES = [
  {
    file: 'src/stable/dialogs/canvasContextMenu.tsx',
    from: `                action: () => {
                  onClose();
                  window.dispatchEvent(new CustomEvent('fisherai:open-workflow-library'));
                },`,
    to: `                action: () => {
                  // dsh-aifisher-canvas 覆盖：上游这里打开「工作流库」（未移植），
                  // 改为直接建一个本地工作流节点（模板取 workflowTemplates[0]）。
                  props.onSelectType('ComfyUI');
                },`,
    why: '「ComfyUI 工作流」菜单项原来只派发一个没人监听的工作流库事件',
  },
  {
    file: 'src/stable/dialogs/canvasSidebar.tsx',
    from: `    { label: '工作流节点', action: props.onWorkflowsClick, icon: <Workflow size={20} /> },`,
    to: `    { label: '工作流节点', action: props.onAddClick, icon: <Workflow size={20} /> },`,
    why: '左侧工具条的「工作流节点」原来也只派发那个没人监听的工作流库事件',
  },
];

{
  const missing = [];
  for (const patch of UI_ENTRY_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      missing.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      missing.push(`${patch.file}: ${patch.why} —— 补丁锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (missing.length > 0) {
    throw new Error(
      `[vendor] 本地工作流节点入口补丁没对齐（上游可能改了写法，请核对）：\n  - ${missing.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 本地工作流节点入口：${UI_ENTRY_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8b) UI 补全期的两处一行改写

/**
 * ① projectDashboardChrome 注入的样式表把 dashboard 根写成 `height: 100dvh`。
 *    `dvh` 是**视口**高度：上游是独占窗口的应用，所以对；嵌进 DSH 面板后视口比面板高
 *    （顶栏 + 面板容器），dashboard 会顶出容器、底部被裁、封面区被压。
 *    改成 `100%` —— 包含块是画布挂载容器（CanvasPanel 的 position:relative 盒子），
 *    与既有的「fixed→absolute」补丁同一个坐标系。
 *
 * ② promptPresets 的 `load()` 拉的是上游**另一个后端**的 `/library/prompts/prompt.json`
 *    （3.6 段注释里特意保留过它）。本插件现在自己实现了提示词预设后端，
 *    把这条路径也收进 `/api/aifisher/canvas/*` 命名空间，前端一行逻辑不用改。
 *
 * 每条断言「恰好命中 1 次」：上游改了写法就报错，不会静默失效。
 */
const UI_TEXT_PATCHES = [
  {
    file: 'src/stable/navigation/projectDashboardChrome.ts',
    from: `    \${DASHBOARD_SELECTOR} {
      height: 100dvh;`,
    to: `    \${DASHBOARD_SELECTOR} {
      /* dsh-aifisher-canvas 覆盖：面板内没有「视口高」这回事，100dvh 会顶出容器 */
      height: 100%;`,
    why: 'dashboard 根容器用了视口单位高度，嵌进面板会溢出',
  },
  {
    file: 'src/stable/prompt/promptPresets.ts',
    from: '`/library/prompts/prompt.json?t=${now()}`',
    to: '`/api/aifisher/canvas/prompts/config?t=${now()}`',
    why: '提示词预设清单原来指向未移植的上游后端路径',
  },
];

{
  const missing = [];
  for (const patch of UI_TEXT_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      missing.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      missing.push(`${patch.file}: ${patch.why} —— 补丁锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (missing.length > 0) {
    throw new Error(
      `[vendor] UI 补全期改写没对齐（上游可能改了写法，请核对）：\n  - ${missing.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] UI 补全期改写：${UI_TEXT_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8c) 画布头部的 ComfyUI 状态胶囊

/**
 * 上游的「ComfyUI 状态胶囊」（`installComfyLogPanel`）是给**托管进程**那套后端写的：
 *   - 挂载门槛认 `startable || running || phase === 'error'`；
 *   - 「待启动」时给一个「启动」按钮；
 *   - 「待启动」的说明写着「开始生成时会自动启动」。
 *
 * 本插件的后端是**只读**的（不托管 ComfyUI 进程，见 src/host/canvas/localRuntimeRouter.ts），
 * 于是三处都对不上：
 *   ① `startable` 恒为 false、没连上时 phase 是 `idle` → 胶囊永远不出现（参考图里它一直在）；
 *   ② 出现也带一个点了没用的「启动」按钮（后端回 status:'disabled'）；
 *   ③ 文案承诺「自动启动」，而本插件不会自动启动任何进程。
 *
 * 只改这三行，落到 DSH 的真实语义：胶囊常驻、只报告状态、不承诺它做不到的事。
 * 每条断言「恰好命中 1 次」：上游改了写法就报错，不会静默失效。
 */
const COMFY_CHIP_PATCHES = [
  {
    file: 'src/stable/local/comfyLogPanel.ts',
    from: `    if (!state.startable && !state.running && state.phase !== 'error') return;`,
    to: `    if (!state.startable && !state.running && !['error', 'idle', 'unavailable'].includes(String(state.phase))) return;`,
    why: 'DSH 不托管 ComfyUI 进程（startable 恒为 false），不认 idle 的话状态胶囊永远不出现',
  },
  {
    file: 'src/stable/local/comfyLogPanel.ts',
    from: `      power.hidden = ['external', 'unavailable', 'error'].includes(nextPhase);`,
    to: `      power.hidden = ['external', 'unavailable', 'error', 'idle'].includes(nextPhase);`,
    why: '「待启动」时那个启动按钮点了也起不来（后端明确回 disabled），藏掉避免死按钮',
  },
  {
    file: 'src/stable/local/comfyLogPanel.ts',
    from: `          ? '已配置好本机 ComfyUI。开始生成时会自动启动，也可以现在手动启动（首次约 1-2 分钟）。'`,
    to: `          ? 'DSH 版不托管 ComfyUI 进程：请用绘世启动器启动它，这里显示它的运行状态与队列。'`,
    why: '上游承诺「生成时会自动启动」，本插件不会自动启动任何进程，文案要说实话',
  },
];

{
  const missing = [];
  for (const patch of COMFY_CHIP_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      missing.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      missing.push(`${patch.file}: ${patch.why} —— 补丁锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (missing.length > 0) {
    throw new Error(
      `[vendor] ComfyUI 状态胶囊补丁没对齐（上游可能改了写法，请核对）：\n  - ${missing.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] ComfyUI 状态胶囊：${COMFY_CHIP_PATCHES.length} 处`);
}

/**
 * 3.8n) ComfyUI 状态胶囊停靠到**左侧**（v1.36）。
 *
 * 用户 2026-10-17 原话：「把右上角的 comfui 待启动移动到左边」。
 *
 * 上游 `dockComfyPanel` 只会把胶囊塞到「账号插槽」左边（顶栏右端）。我们这边没有账号
 * 系统、插槽只是个空位，于是胶囊和保存状态徽标挤在同一个角上。现在给头部左侧工具条
 * 加一个专用槽位 `[data-fisherai-comfyui-slot="true"]`（见 src/canvas-ui/canvas/
 * CanvasHeader.tsx），这里让 dock 逻辑**优先**认它：
 *   - 找到左侧槽位就 append 进去，下拉面板改为「贴着胶囊左缘向下展开」；
 *   - 找不到（项目看板视图没有这个头部）才回落到原来的账号插槽，再退到 body 左下角。
 * 两条锚点各断言「恰好命中 1 次」。
 */
const COMFY_CHIP_DOCK_PATCHES = [
  {
    file: 'src/stable/local/comfyLogPanel.ts',
    from: `  const account = root.querySelector<HTMLElement>('[data-fisherai-account-center-slot="true"]');`,
    to: `  // v1.36：左侧专用槽位优先（用户要求把胶囊从右上角移到左边）。
  const leftSlot = root.querySelector<HTMLElement>('[data-fisherai-comfyui-slot="true"]');
  const dockedPanel = host.querySelector<HTMLElement>('[data-fisherai-comfyui-log-panel]');
  if (leftSlot && dockedPanel) {
    if (host.parentElement !== leftSlot) leftSlot.append(host);
    host.dataset.dock = 'topbar-left';
    host.style.cssText =
      'position:relative;left:auto;bottom:auto;z-index:70;flex:none;font-family:Inter,"Microsoft YaHei UI",system-ui,sans-serif;';
    dockedPanel.style.left = '0px';
    dockedPanel.style.right = 'auto';
    dockedPanel.style.top = 'calc(100% + 8px)';
    dockedPanel.style.bottom = '';
    return;
  }
  const account = root.querySelector<HTMLElement>('[data-fisherai-account-center-slot="true"]');`,
    why: '胶囊停在右上角（账号插槽左边），和保存状态挤在一起；左侧槽位优先',
  },
  {
    file: 'src/stable/local/comfyLogPanel.ts',
    from: `  if (host.dataset.dock !== 'topbar') return;`,
    to: `  if (host.dataset.dock !== 'topbar' && host.dataset.dock !== 'topbar-left') return;`,
    why: '胶囊从左侧槽位掉出来时要能回落到 body（否则切到项目看板后它会消失）',
  },
];

{
  const missing = [];
  for (const patch of COMFY_CHIP_DOCK_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      missing.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      missing.push(`${patch.file}: ${patch.why} —— 补丁锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (missing.length > 0) {
    throw new Error(
      `[vendor] ComfyUI 胶囊左侧停靠补丁没对齐（上游可能改了写法，请核对）：\n  - ${missing.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] ComfyUI 胶囊左侧停靠：${COMFY_CHIP_DOCK_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8d) 方舟（豆包）直连模型进画布可选清单

/**
 * 画布目录（vendor/aifisher/src/config/modelConfig.ts）里本来就有三条**火山方舟直连**的图片模型：
 *   `豆包图片4.0(多参考)` / `豆包图片4.5(多参考)` / `豆包图片5.0-lite`
 * 端点都是 https://ark.cn-beijing.volces.com/api/v3/images/generations，模型 ID 也写在目录里
 * （doubao-seedream-4-0-250828 / 4-5-251128 / 5-0-260128）。但上游把它们标成 `selectable: false`，
 * canonicalModel 又不在「新建节点只提供常用模型」的白名单里，于是**画布上选不到** ——
 * 只有上游自己的 server 按 provider 名把请求转出去时才用得上。
 *
 * 本插件实现了同一条直连链路（src/host/generation/arkImageProvider.ts），所以把它们放回清单：
 *   ① 追加一条 5.0 pro（用户手上那条 curl 的模型 doubao-seedream-5-0-pro-260628；
 *      上游目录里没有 5.0 pro 的直连档），形状照抄上面三条；
 *   ② 把三条已有记录的 `selectable` 改 true —— 没配 ARK_API_KEY 时画布模型下拉仍然看不到它们，
 *      因为 model-availability 会把它们的 configured 标成 false（画布只列已连接的来源）；
 *   ③ 把这四个 canonicalModel 加进 canvasModelCatalogPolicy 的常用清单（画布下拉的硬过滤）。
 *
 * 每条断言「恰好命中」N 次：上游改了写法就报错，不会静默失效。
 */
const ARK_SEEDREAM_5_PRO_ENTRY = `    {
        // dsh-aifisher-canvas 追加：火山方舟（豆包）直连的 Seedream 5.0 Pro。
        // 上游目录里只有 4.0 / 4.5 / 5.0-lite 三条方舟直连档；用户手上的模型是 5.0 pro，
        // 所以照同样的形状补一条（host 半的 arkImageProvider 按 provider 与端点认它）。
        name:                       '豆包图片5.0-pro(方舟直连)',
        description:                '火山方舟直连的 doubao-seedream-5-0-pro，支持文生图 / 图生图 / 图层拆分',
        timeEstimate:               '1min',
        provider:                   'DoubaoImageProvider',
        maxConcurrent:              0,
        useProxy:                   false,
        maxInputs:                  10,
        supportedReferenceTypes:    ['text', 'image'],
        supportedImageFormats:      ['jpeg', 'png', 'webp', 'bmp', 'tiff'],
        maxImageSizeMb:             10,
        maxResolution:              '4624220',
        resolutions:                ['1K', '2K'],
        aspectRatios:               ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'],
        imageModes: [
            { label: '文生图', value: 'text-to-image', allowedInputs: { 'text': 10 } },
            { label: '图生图', value: 'image-to-image', allowedInputs: { 'text': 10, 'image': 10 } },
            { label: '图层拆分', value: 'layer-decomposition', allowedInputs: { 'text': 10, 'image': 1 } }
        ],
        endpoint: {
            'text-to-image':       { url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations', model: 'doubao-seedream-5-0-pro-260628' },
            'image-to-image':      { url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations', model: 'doubao-seedream-5-0-pro-260628' },
            'layer-decomposition': { url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations', model: 'doubao-seedream-5-0-pro-260628' }
        },
        advancedParams: [
            { key: 'watermark', label: 'AI 生成水印', type: 'toggle', default: false },
            { key: 'generateCount', label: '生成数量', type: 'slider', default: 1, min: 1, max: 4 }
        ]
    },
`;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 上游已有、但被 `selectable: false` 藏起来的方舟直连图片模型。 */
const ARK_DIRECT_MODEL_NAMES = [
  '豆包图片4.0(多参考)',
  '豆包图片4.5(多参考)',
  '豆包图片5.0-lite',
];

/**
 * 同理，上游还有两条**方舟直连的视频模型**（Seedance 2.0 / 2.0 fast，端点是
 * `/api/v3/contents/generations/tasks`）也标着 `selectable: false`。
 *
 * 本插件 v1.60 补上了方舟的视频链路（src/host/generation/arkVideoProvider.ts），
 * 所以同样把它们放回可选清单。**不需要**动 canvasModelCatalogPolicy：它们的
 * canonicalModel `Seedance 2.0` / `Seedance 2.0 Fast` 本来就在常用清单里，
 * 只是之前没有本插件的后端能真的出片（选了一按生成就是 501）。
 */
const ARK_DIRECT_VIDEO_NAMES = ['豆包视频2.0', '豆包视频2.0 fast'];

const ARK_CATALOG_PATCHES = [
  {
    file: 'src/config/modelConfig.ts',
    pattern: /(export const IMAGE_MODELS = \[\r?\n)/,
    expect: 1,
    replace: (match) => `${match}${ARK_SEEDREAM_5_PRO_ENTRY}`,
    why: '给目录补一条方舟直连的 doubao-seedream-5-0-pro（上游只有 4.0/4.5/5.0-lite）',
  },
  ...[...ARK_DIRECT_MODEL_NAMES, ...ARK_DIRECT_VIDEO_NAMES].map((name) => ({
    file: 'src/config/modelConfig.ts',
    pattern: new RegExp(`(name:\\s*'${escapeRegExp(name)}',[\\s\\S]{0,320}?selectable:\\s*)false`),
    expect: 1,
    replace: (_match, head) => `${head}true`,
    why: `把 ${name} 放回画布可选清单（上游标了 selectable: false）`,
  })),
  {
    file: 'src/stable/generation/canvasModelCatalogPolicy.ts',
    pattern: /( {2}'Midjourney Imagine',\r?\n {2}'Seedream v5 Pro',\r?\n)/,
    expect: 1,
    replace: (match) =>
      `${match}\n  // dsh-aifisher-canvas 追加：方舟（豆包）直连的图片模型（只有填了 ARK_API_KEY 才连得上来源）\n  '豆包图片5.0-pro(方舟直连)',\n  '豆包图片5.0-lite',\n  '豆包图片4.5(多参考)',\n  '豆包图片4.0(多参考)',\n`,
    why: '画布下拉只列常用模型白名单里的 canonicalModel，方舟直连的几条不在里面',
  },
];

{
  const problems = [];
  for (const patch of ARK_CATALOG_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = [...original.matchAll(new RegExp(patch.pattern.source, `${patch.pattern.flags}g`))].length;
    if (hits !== patch.expect) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 ${patch.expect} 次）`);
      continue;
    }
    fs.writeFileSync(target, original.replace(patch.pattern, patch.replace));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 方舟直连模型清单补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(
    `[vendor] 方舟（豆包）直连模型：目录补 1 条 + 开放 ${ARK_DIRECT_MODEL_NAMES.length} 条图片 + ` +
      `${ARK_DIRECT_VIDEO_NAMES.length} 条视频 + 常用清单加 4 条`,
  );
}

// ---------------------------------------------------------------- 3.8e) 生成失败的「怎么办」要显示到画布上

/**
 * host 半在方舟回错时除了 `error` 还会带一个 `hint`（『去哪个页面开通』『核对 API Key』这类
 * 可操作的话）。但上游的 `responseBody` 只把 `result.error` 抛成 Error —— `hint` 永远丢在半路，
 * 用户看到的就只有方舟那句英文原文（2026-10-16 用户截图上就是这条：404 ModelNotOpen，
 * 既不知道要做什么，也不知道是我们没接通还是他自己没开通）。
 *
 * 所以把 hint 接在 error 后面抛出：画布节点上的错误文案来自 `error.message`，
 * 接在这里就直接出现在用户眼前，不需要动节点渲染那一层。
 */
const GENERATION_ERROR_HINT_PATCHES = [
  {
    file: 'src/stable/generation/generationClient.ts',
    from: `  if (!response.ok)
    throw Object.assign(
      new Error(typeof result.error === 'string' ? result.error : '生成请求未能完成。'),
      {`,
    to: `  if (!response.ok) {
    // dsh-aifisher-canvas：把 host 半的可操作提示（hint）一起抛出去 —— 否则它永远到不了画布
    const failureMessage = typeof result.error === 'string' ? result.error : '生成请求未能完成。';
    const failureHint = typeof result.hint === 'string' ? result.hint.trim() : '';
    throw Object.assign(
      new Error(failureHint ? \`\${failureMessage}（\${failureHint}）\` : failureMessage),
      {`,
    why: 'canvas 只显示 error 字段，host 给的 hint（去方舟控制台开通/核对 Key）到不了用户眼前',
  },
  {
    // 上一条把无大括号的 if 体扩成了多行语句，必须补上闭合大括号，
    // 否则 vendor 产物是语法错误（lexical declaration in single-statement context）。
    file: 'src/stable/generation/generationClient.ts',
    from: `        status: response.status,
      },
    );
  return result;`,
    to: `        status: response.status,
      },
    );
  }
  return result;`,
    why: 'hint 补丁引入的多行 if 体需要补回右大括号',
  },
];

{
  const problems = [];
  for (const patch of GENERATION_ERROR_HINT_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 生成失败提示补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 生成失败提示：${GENERATION_ERROR_HINT_PATCHES.length} 处（hint 接进 error.message）`);
}

// ------------------------------------------------- 3.8e-bis) 结果图链接失效时，别只留一块黑

/**
 * 云端生成的结果如果在 host 侧没能落进素材库，画布节点的 `resultUrl` 就是服务商的
 * **临时链接**（`https://file*.aitohumanize.com/file/<hash>.png`）。链接过期后 <img> 直接 404，
 * 节点看上去「成功但一块黑」—— 2026-10-20 用户就是这么遇到三个节点的。
 *
 * 上游的预览组件（canvasImagePreview.tsx）只挂了 onLoad，没有 onError。补一个：
 * 图片加载失败时把 <img> 隐藏、在同一个容器里放一句人话，并把失败留痕交给 client 半的
 * `installImageLoadTelemetry`（它监听 window 的 error 捕获阶段，不依赖这处补丁）。
 *
 * 不渲染 React 状态（那要动组件签名，跨版本容易碎）：直接操作 DOM —— 这个容器就是
 * 媒体底板，补丁失败也只是「没提示」（和上游行为一致），不会把画布搞崩。
 */
const IMAGE_RESULT_MISSING_PATCH = {
  file: 'src/stable/media/canvasImagePreview.tsx',
  from: `              <img
                src={node.resultUrl}
                key={node.resultUrl}
                onLoad={metadata}
                alt={'生成结果'}
                className={'w-full h-full object-cover pointer-events-none'}
              />`,
  to: `              <img
                src={node.resultUrl}
                key={node.resultUrl}
                onLoad={metadata}
                onError={(event) => {
                  // dsh-aifisher-canvas：结果链接失效（云端临时的图床链接过期 / 没落盘）时，
                  // 不要只留一块黑。提示放在同一个媒体底板里，不新增 DOM 层级。
                  const img = event.currentTarget;
                  const host = img.parentElement as HTMLElement | null;
                  if (!host) return;
                  img.style.opacity = '0';
                  if (host.querySelector('[data-af-image-missing]')) return;
                  const tip = document.createElement('div');
                  tip.setAttribute('data-af-image-missing', '1');
                  tip.textContent = '图片链接已失效\\n云端临时链接过期后不再可读，重新生成即可恢复';
                  tip.style.cssText =
                    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
                    'padding:16px;text-align:center;white-space:pre-line;' +
                    'font:12px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
                    'color:#e2e8f0;background:rgba(0,0,0,.45)';
                  host.appendChild(tip);
                }}
                alt={'生成结果'}
                className={'w-full h-full object-cover pointer-events-none'}
              />`,
  why: '云端结果回落到临时链接后，过期即 404，节点只剩一块黑（用户无法分辨「没生成」和「链接失效」）',
};

{
  const target = path.join(VENDOR, IMAGE_RESULT_MISSING_PATCH.file);
  if (!fs.existsSync(target)) {
    throw new Error(`[vendor] 结果失效提示补丁没对齐：${IMAGE_RESULT_MISSING_PATCH.file} 不存在`);
  }
  const original = fs.readFileSync(target, 'utf8');
  const hits = original.split(IMAGE_RESULT_MISSING_PATCH.from).length - 1;
  if (hits !== 1) {
    throw new Error(
      `[vendor] 结果失效提示补丁没对齐（上游可能改了写法，请核对）：` +
        `${IMAGE_RESULT_MISSING_PATCH.file}: ${IMAGE_RESULT_MISSING_PATCH.why} —— 锚点命中 ${hits} 次（预期 1 次）`,
    );
  }
  fs.writeFileSync(target, original.split(IMAGE_RESULT_MISSING_PATCH.from).join(IMAGE_RESULT_MISSING_PATCH.to));
  console.log('[vendor] 结果图失效提示：1 处（画布预览 onError → 「图片链接已失效」）');
}

// ---------------------------------------------------------------- 3.8f) 节点搜索面板的「建节点」出口

/**
 * 画布的「节点搜索面板」（Shift+A，仿 Blender，见 src/canvas-ui/canvas/CanvasNodeSearch.tsx）
 * 在 src/canvas-ui 里，拿不到 vendor 的 node store —— 那在 useCanvasNodes 的闭包里。
 *
 * 上游同一个文件里已经有**现成的先例**：`fisherai:add-workflow-node` 就是由
 * canvasNodeState 的 attachWorkflowNodeEvents 直接写 store 的（它同样需要 setNodes +
 * setSelected，而这两个引用是稳定的、不依赖渲染期）。所以给「按类型建节点」也开一条同样形状的
 * 事件，比新增一个 Dependencies 依赖项安全得多：
 *   - 不动 vendor 的依赖契约（CanvasApplication 的 useNodes() 少解构一个字段照样能跑，
 *     而上游升级时不认识我们新加的依赖项、会整体崩）；
 *   - 事件监听器随 useCanvasNodes 的 effect 装/卸，画布卸载即失效。
 *
 * 语义要点：
 *   ① 落点用的是**画布坐标**（面板按 #canvas-background 的 rect 与 viewport 换算好再传）；
 *   ② type 直接交给 vendor 的 createCanvasNode（与右键菜单同一条路），所以每种节点类型的
 *      默认模型/尺寸/端口都由画布自己决定，这里不重复一套；
 *   ③ `comfyMode` 交给 updateCanvasNode（走它的索引重建分支）—— 上游换工作流时就是这么做的，
 *      这样「搜索某个具体工作流」建出来的节点与在节点下拉里选中它是同一个状态；
 *   ④ **必须挂在 useCanvasNodes 里、拿完整的 runtime**：attachWorkflowNodeEvents 收到的
 *      `runtime` 只有 `{getWidth, createId}`（见它的形参类型），而 createCanvasNode 要用
 *      `runtime.imageModels / videoModels / audioModels / textModels / templates` ——
 *      拿那个残缺的 runtime 会抛「Cannot read properties of undefined (reading '0')」
 *      （踩过：现象是「搜索能开、候选能选、点了不建节点」，而且不报错到用户眼前）。
 *      桥接函数幂等 + 只装一次监听器，所以挂在 effect 里也只会有一个实例。
 *
 * 两处断言「恰好命中 N 次」：上游改了写法就报错，不会静默失效。
 */
const NODE_CREATE_BRIDGE_ANCHOR = `  hooks.useEffect(
    () =>
      attachWorkflowNodeEvents(
        { getNodes, setNodes, setSelected: setSelectedNodeIds },
        { getWidth, createId },
      ),
    [getNodes, setNodes, getWidth, createId],
  );`;

const NODE_CREATE_BRIDGE_CODE = [
  `  hooks.useEffect(`,
  `    () =>`,
  `      attachWorkflowNodeEvents(`,
  `        { getNodes, setNodes, setSelected: setSelectedNodeIds },`,
  `        { getWidth, createId },`,
  `      ),`,
  `    [getNodes, setNodes, getWidth, createId],`,
  `  );`,
  `  // dsh-aifisher-canvas 追加：节点搜索面板（Shift+A）的「按类型建节点」出口。`,
  `  // 只在挂载时装一次监听器，runtime/store 走 ref 读最新值 —— 依赖数组写它们会让`,
  `  // effect 每次渲染都重装（中间有一小段没监听器的空档，事件正好落在里面就静默丢失）。`,
  `  const nodeCreateRef = hooks.useRef({ runtime, getNodes, setNodes, setSelected: setSelectedNodeIds });`,
  `  nodeCreateRef.current = { runtime, getNodes, setNodes, setSelected: setSelectedNodeIds };`,
  `  hooks.useEffect(`,
  `    () => attachCanvasNodeCreateBridge(() => nodeCreateRef.current),`,
  `    [],`,
  `  );`,
].join('\n');

const NODE_CREATE_BRIDGE_HELPER = `/**
 * dsh-aifisher-canvas 追加：节点搜索面板（Shift+A）的「按类型建节点」事件桥。
 *
 * 面板（src/canvas-ui/canvas/CanvasNodeSearch.tsx）拿不到画布的 store，所以走 window 事件；
 * 这里用**完整的** NodeRuntime 建节点 —— 与右键菜单的 createCanvasNode 是同一条路，
 * 于是默认模型、尺寸、连线端口全都一致。
 *
 * detail.place === true 时再进入「新建并移动」（Blender 手感）：
 *   - 节点出现在落点上，随后跟着鼠标走（屏幕位移 ÷ 画布当前缩放）；
 *   - 下一次左键按下 = 放下，并且**这一次 pointerdown 被吞掉**（不吞会顺带开始拖节点，
 *     点在空白处还会清掉刚建好的选中态）；Esc / 画布卸载也会结束跟随。
 *   面板点选（mousedown）之后没有 pointerdown，所以不会把「点候选」误当成放下；
 *   其它调用方（工作流库、browser-check）不传 place，行为完全不变。
 *
 * 监听器只在画布挂载时装一次：runtime 与 store 由 getter 每次读最新值。
 * 为什么不在 effect 里依赖它们（踩过）：那些引用每次渲染都会变，effect 会「卸载→重装」上千次，
 * 每次中间都有一小段没有监听器的窗口 —— 落在里面的点击会**静默丢失**
 * （现象：开头两次建节点成功，之后点了什么都不发生，画布与日志都不报错）。
 */
export function attachCanvasNodeCreateBridge(
  current: () => { runtime: NodeRuntime; getNodes: () => CanvasNode[]; setNodes: Setter<CanvasNode[]>; setSelected: Setter<string[]> },
): () => void {
  let stopPlacement: (() => void) | undefined;
  const listener: EventListener = (event) => {
    try {
      const detail = (event as CustomEvent<{
        type?: string;
        comfyMode?: string;
        point?: { x?: number; y?: number };
        place?: boolean;
      }>).detail;
      if (!detail || typeof detail.type !== 'string' || detail.type.length === 0) return;
      const point = detail.point;
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const { runtime, setNodes, setSelected } = current();
      (window as { __DSH_NODE_CREATE_CALLS__?: number }).__DSH_NODE_CREATE_CALLS__ =
        ((window as { __DSH_NODE_CREATE_CALLS__?: number }).__DSH_NODE_CREATE_CALLS__ ?? 0) + 1;
      let node = createCanvasNode(runtime, detail.type, { x: point.x, y: point.y }, undefined);
      if (detail.comfyMode && node.type === 'ComfyUI') {
        const updated = updateCanvasNode([node], node.id, { comfyMode: detail.comfyMode }, runtime);
        if (updated[0]) node = updated[0];
      }
      setNodes((nodes) => [...nodes, node]);
      setSelected([node.id]);
      if (detail.place === true) {
        stopPlacement?.();
        stopPlacement = attachPointerPlacement(node.id, current);
      }
    } catch (error) {
      // 静默失败会让用户看到「面板能开、候选能选，但点了不出节点」——
      // 这种「什么都不发生」最难排查，所以这里必须把原因喊出来。
      console.error('[aifisher-canvas] 建节点失败', error);
    }
  };
  window.addEventListener('fisherai:add-canvas-node', listener);
  return () => {
    window.removeEventListener('fisherai:add-canvas-node', listener);
    stopPlacement?.();
    stopPlacement = undefined;
  };
}

/** 画布当前缩放：读 #canvas-viewport-content 的内联 transform（量不到就当 1）。 */
function canvasZoom(): number {
  const transform = document.getElementById('canvas-viewport-content')?.style.transform ?? '';
  const scale = /scale\\(\\s*([-0-9.eE+]+)\\s*\\)/.exec(transform);
  const zoom = scale ? Number.parseFloat(scale[1]) : 1;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * 「新建并移动」：把刚建出来的节点挂到鼠标上，下一次左键放下。
 *
 * 为什么按「屏幕位移 ÷ 缩放」而不是每次重算世界坐标：画布自己拖节点就是这么算的
 * （vendor 的 updateNodeDrag：movementX / viewport.zoom），不需要知道画布原点，
 * 中途滚轮缩放也不会跳一下。
 *
 * 为什么放下时要吞掉 pointerdown：用户那一下只是想「确定落点」。传下去会让画布立刻
 * 开始拖这个节点；点在空白处还会把刚建好的选中态清掉。
 */
function attachPointerPlacement(
  id: string,
  current: () => { getNodes: () => CanvasNode[]; setNodes: Setter<CanvasNode[]> },
): () => void {
  const scope = window as unknown as {
    __DSH_NODE_PLACEMENT__?: {
      moves: number;
      flushes: number;
      stops: number;
      zoom: number;
      last: number[];
      log: string[];
    };
  };
  const diag =
    scope.__DSH_NODE_PLACEMENT__ ??
    (scope.__DSH_NODE_PLACEMENT__ = { moves: 0, flushes: 0, stops: 0, zoom: 1, last: [], log: [] });
  const note = (line: string) => {
    diag.log.push(line);
    if (diag.log.length > 40) diag.log.splice(0, diag.log.length - 40);
  };
  note('attach ' + id);
  let lastX: number | null = null;
  let lastY: number | null = null;
  let frame = 0;
  let pendingX = 0;
  let pendingY = 0;

  const flush = () => {
    frame = 0;
    if (pendingX === 0 && pendingY === 0) return;
    const dx = pendingX;
    const dy = pendingY;
    pendingX = 0;
    pendingY = 0;
    diag.flushes += 1;
    note('flush ' + dx + ',' + dy);
    current().setNodes((nodes) =>
      nodes.map((node) => (node.id === id ? { ...node, x: node.x + dx, y: node.y + dy } : node)),
    );
  };

  const onMove = (event: PointerEvent) => {
    diag.moves += 1;
    diag.last = [event.clientX, event.clientY];
    if (lastX === null || lastY === null) {
      // 第一次移动只定基线：落点已经由建节点那一步给过了，不需要再挪一下
      lastX = event.clientX;
      lastY = event.clientY;
      note('baseline ' + event.clientX + ',' + event.clientY);
      return;
    }
    const zoom = canvasZoom();
    diag.zoom = zoom;
    pendingX += (event.clientX - lastX) / zoom;
    pendingY += (event.clientY - lastY) / zoom;
    lastX = event.clientX;
    lastY = event.clientY;
    if (frame === 0) frame = window.requestAnimationFrame(flush);
  };

  const stop = (reason = 'manual') => {
    diag.stops += 1;
    note('stop ' + reason);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    if (frame !== 0) window.cancelAnimationFrame(frame);
    frame = 0;
    pendingX = 0;
    pendingY = 0;
  };

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      // 右键/中键：结束跟随但**不吞事件**（右键菜单、中键平移要照常工作）
      stop('other-button');
      return;
    }
    const target = event.target;
    const element = target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
    // 点在画布里 → 吞掉（否则会立刻开始拖节点/清选中）；
    // 点在画布外（工具栏、会话栏…）→ 只结束跟随，让那次点击照常生效，不做「死点击」。
    const insideCanvas = !!element?.closest('#canvas-background, .af-canvas-mount');
    stop('down');
    if (insideCanvas) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') stop('escape');
  };

  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  return stop;
}

`;

{
  const target = path.join(VENDOR, 'src/stable/nodes/canvasNodeState.ts');
  if (!fs.existsSync(target)) {
    throw new Error('[vendor] 节点搜索建节点出口：vendor 里找不到 canvasNodeState.ts');
  }
  const original = fs.readFileSync(target, 'utf8');
  const anchorHits = original.split(NODE_CREATE_BRIDGE_ANCHOR).length - 1;
  // 桥接函数插在 workflowNode() 判定函数之前（同文件、模块作用域，能用到 createCanvasNode）
  const helperAnchor = 'function workflowNode(';
  const helperHits = original.split(helperAnchor).length - 1;
  if (anchorHits !== 1 || helperHits !== 1) {
    throw new Error(
      `[vendor] 节点搜索建节点出口没对齐：useCanvasNodes 的 effect 锚点命中 ${anchorHits} 次（预期 1 次）、` +
        `函数插入锚点命中 ${helperHits} 次（预期 1 次）—— 上游可能改了这段写法，请核对`,
    );
  }
  const patched = original
    .split(helperAnchor)
    .join(NODE_CREATE_BRIDGE_HELPER + helperAnchor)
    .split(NODE_CREATE_BRIDGE_ANCHOR)
    .join(NODE_CREATE_BRIDGE_CODE);
  fs.writeFileSync(target, patched);
  console.log('[vendor] 节点搜索：fisherai:add-canvas-node 建节点出口 1 处（完整 runtime）');
}

// ---------------------------------------------------------------- 3.8g) 自配 OpenAI 通道的模型进画布可选清单

/**
 * v1.11「多通道 + 每通道多模型」（用户原话「OpenAI通道我希望可以配置好几个，并且可以选择多条单独模型」）。
 *
 * host 半（src/host/generation/cloudChannels.ts）按**模型名**把请求分发到用户自己配的通道。
 * 名字要出现在画布的模型下拉里，得同时满足两件事：
 *
 *   ① 该名字在 composer 的候选清单里 —— 这条**不用打 vendor 补丁**：
 *      src/canvas-ui/canvas/CloudChannelModels.ts 直接**原地往 IMAGE_MODELS / VIDEO_MODELS /
 *      AUDIO_MODELS / TEXT_MODELS 里追加**合成条目（数组身份不变，于是 canvasComponents 的注入、
 *      stage.tsx 的 models/catalog、连线校验全都自动认它；保存通道时先摘旧的再追加，可重复安装）。
 *      为什么不用「补丁成 [...STATIC, ...global]」：stage.tsx 里那两个目录对象是**模块级常量**，
 *      补 vendor 那四处也救不了它 —— 而请求构造（advancedParams、视频时长）用的正是它。
 *
 *   ② 该名字通过画布下拉的**常用模型白名单** —— 这条必须打补丁：
 *      `canvasModelCatalogPolicy.ts` 的 `COMMON_CANVAS_MODELS` 是模块级 Set（模块求值时固化），
 *      运行时往目录里追加也进不去。所以把过滤函数改成「静态白名单 ∪ 运行时名字集合」，
 *      运行时集合由 CloudChannelModels.ts 装在 `globalThis.__FISHERAI_CHANNEL_MODEL_NAMES__`
 *      上（保存通道后当场刷新，不用重启 DSH、也不用刷新页面）。
 *
 * 锚点断言「恰好命中 1 次」：上游改了写法就报错，不会静默失效。
 */
const CHANNEL_POLICY_PATCH = {
  file: 'src/stable/generation/canvasModelCatalogPolicy.ts',
  from: `export const filterCanvasModelGroups: ModelGroupFilter = (groups) =>
  groups.filter((group) => COMMON_CANVAS_MODELS.has(group.canonicalModel));`,
  to: `export const filterCanvasModelGroups: ModelGroupFilter = (groups) => {
  // dsh-aifisher-canvas：自配 OpenAI 通道勾选的模型走运行时白名单
  // （src/canvas-ui/canvas/CloudChannelModels.ts 安装，vendor 补丁 3.8g 段）。
  const channelNames = (globalThis as any).__FISHERAI_CHANNEL_MODEL_NAMES__;
  return groups.filter(
    (group) =>
      COMMON_CANVAS_MODELS.has(group.canonicalModel) ||
      (channelNames instanceof Set && channelNames.has(group.canonicalModel)),
  );
};`,
  why: '画布下拉只列常用模型白名单里的 canonicalModel，用户自配通道的模型不在里面',
};

{
  const problems = [];
  const target = path.join(VENDOR, CHANNEL_POLICY_PATCH.file);
  if (!fs.existsSync(target)) {
    problems.push(`${CHANNEL_POLICY_PATCH.file}（文件不存在）`);
  } else {
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(CHANNEL_POLICY_PATCH.from).length - 1;
    if (hits !== 1) {
      problems.push(
        `${CHANNEL_POLICY_PATCH.file}: ${CHANNEL_POLICY_PATCH.why} —— 锚点命中 ${hits} 次（预期 1 次）`,
      );
    } else {
      fs.writeFileSync(
        target,
        original.split(CHANNEL_POLICY_PATCH.from).join(CHANNEL_POLICY_PATCH.to),
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 自配通道模型白名单补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log('[vendor] 自配 OpenAI 通道：画布下拉放行运行时模型名 1 处');
}

// ---------------------------------------------------------------- 3.8h) 通道管理面板挂进「设置 → 闭源服务」

/**
 * 设置页是 vendor 用原生 DOM 搭的（`mountSourceSettings` 把卡片 prepend 进
 * `[data-fisherai-settings-page="models"]`）。我们要把「OpenAI 通道」多通道面板也放进去，
 * 但不能改 vendor 的实现 —— 只在它挂完设置页之后多调一次我们自己的挂载函数：
 *
 *   globalThis.__FISHERAI_MOUNT_CLOUD_CHANNELS__(host)
 *
 * 这个全局由画布装配层注册（src/client/canvas/bootstrap.ts 的 installCloudChannelPanel），
 * 面板本体在 src/canvas-ui/canvas/CloudChannelPanel.ts（纯 DOM + Tailwind，不写 React ——
 * 产物里有两份 React 19，往 vendor 的 DOM 里塞另一棵 React 树会踩 #130）。
 *
 * 为什么不写「MutationObserver 等这一页出现」：画布本身是 DOM 变动大户（拖动/缩放节点），
 * 观察整棵文档等于每次变动都扫一遍 DOM。设置页切换分区时外层容器带 key={section}，
 * 那一页会整体重挂 —— 所以这里挂一次就够了，React 卸载时我们的面板跟着一起消失。
 *
 * 锚点断言「恰好命中 1 次」（含缩进，避免撞到同名调用）。
 */
const CLOUD_CHANNEL_PANEL_PATCH = {
  file: 'src/stable/settings/canvasSettings.tsx',
  from: `      else if (section === 'models')
        pageDisposeRef.current = mountSourceSettings(host, createSourceSettingsClient());`,
  to: `      else if (section === 'models') {
        pageDisposeRef.current = mountSourceSettings(host, createSourceSettingsClient());
        // dsh-aifisher-canvas：自配 OpenAI 通道（多通道 + 每通道多模型）面板。
        // 全局由画布装配层注册（bootstrap.ts 的 installCloudChannelPanel）。
        (globalThis as any).__FISHERAI_MOUNT_CLOUD_CHANNELS__?.(host);
      }`,
  why: '把「OpenAI 通道」多通道面板挂进「设置 → 闭源服务」页',
};

{
  const problems = [];
  const target = path.join(VENDOR, CLOUD_CHANNEL_PANEL_PATCH.file);
  if (!fs.existsSync(target)) {
    problems.push(`${CLOUD_CHANNEL_PANEL_PATCH.file}（文件不存在）`);
  } else {
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(CLOUD_CHANNEL_PANEL_PATCH.from).length - 1;
    if (hits !== 1) {
      problems.push(
        `${CLOUD_CHANNEL_PANEL_PATCH.file}: ${CLOUD_CHANNEL_PANEL_PATCH.why} —— 锚点命中 ${hits} 次（预期 1 次）`,
      );
    } else {
      fs.writeFileSync(
        target,
        original.split(CLOUD_CHANNEL_PANEL_PATCH.from).join(CLOUD_CHANNEL_PANEL_PATCH.to),
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 通道面板挂载补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log('[vendor] 自配 OpenAI 通道：设置页挂载点 1 处');
}

// ---------------------------------------------------------------- 3.8k) 画布互动效果开关挂进「设置 → 画布外观」

/**
 * 用户原话（v1.27，2026-10-17）：「现在画布与鼠标没有互动效果，在设置里做一个开关」。
 *
 * 「画布外观」这一页是 vendor 的 React 组件 `CanvasAppearanceSettings`（主题 + 背景图），
 * 页里**没有**任何宿主节点能塞我们自己的 DOM。所以补两条锚点：
 *   ① 在 `<CanvasAppearanceSettings />` 之后再渲染一个
 *      `[data-fisherai-settings-page="appearance"]` 空 div —— 我们自己的面板挂进它；
 *      面板必须是纯 DOM（src/canvas-ui/canvas/CanvasEffectsPanel.ts）：产物里有两份 React 19，
 *      往 vendor 的 React 树里塞第二棵会踩 #130。
 *   ② 这个分区挂页时调 `__FISHERAI_MOUNT_CANVAS_EFFECTS__(host)`（装配层注册，见
 *      src/client/canvas/bootstrap.ts 的 installCanvasEffectsSupport），并把返回的 disposer
 *      记进 pageDisposeRef —— 切分区/关对话框时组件退订，监听器不泄漏。
 *
 * 两条都断言「恰好命中 1 次」：上游改了写法就报错，不会静默失效。
 */
const CANVAS_EFFECTS_PANEL_PATCHES = [
  {
    file: 'src/stable/settings/canvasSettings.tsx',
    from: `            ) : section === 'appearance' ? (
              <CanvasAppearanceSettings />`,
    to: `            ) : section === 'appearance' ? (
              <div className="space-y-6">
                <CanvasAppearanceSettings />
                {/* dsh-aifisher-canvas：「画布互动」开关面板的宿主（原生 DOM，见 CanvasEffectsPanel.ts） */}
                <div ref={hostRef} data-fisherai-settings-page="appearance" />
              </div>`,
    why: '在「画布外观」页里给「画布互动」开关面板留宿主 div',
  },
  {
    file: 'src/stable/settings/canvasSettings.tsx',
    from: `      else if (section === 'local-service')
        pageDisposeRef.current = mountLocalRuntimeSettings(
          host,
          window.__FISHERAI_LOCAL_RUNTIME__ ?? createLocalRuntimeClient(),
        );`,
    to: `      else if (section === 'local-service')
        pageDisposeRef.current = mountLocalRuntimeSettings(
          host,
          window.__FISHERAI_LOCAL_RUNTIME__ ?? createLocalRuntimeClient(),
        );
      else if (section === 'appearance')
        // dsh-aifisher-canvas：画布互动效果开关（挂载点由装配层注册，返回 disposer 交给 pageDisposeRef）
        pageDisposeRef.current =
          (globalThis as any).__FISHERAI_MOUNT_CANVAS_EFFECTS__?.(host) ?? null;`,
    why: '「画布外观」页挂好后把画布互动开关面板挂上去，并接管它的退订',
  },
];

{
  const problems = [];
  for (const patch of CANVAS_EFFECTS_PANEL_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 画布互动开关挂载补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log('[vendor] 画布互动开关：设置页「画布外观」挂载点 2 处');
}

// ---------------------------------------------------------------- 3.8i) 看板头部的两个站外入口整块移除

/**
 * 用户 2026-10-17 原话（附一张看板头部截图，红框里是两个胶囊）：「移除这两个功能」。
 *
 * `projectDashboardChrome` 里的 `resources` 是**两个站外链接**，被注入到项目看板头部
 * （工具栏左边、设置按钮前）：
 *   ① AIFISHER「API 与服务」→ https://api.work-fisher.com/
 *   ② Work-Fisher「教程与案例」→ B 站教学主页
 *
 * 两个都不该在本插件里出现：插件没有 AIFISHER 的服务/账号体系（账号早在 v1.3 就整体移除），
 * 教学主页也不是画布功能 —— 它们只是上游给自己客户端留的导流口，点了就跳出 DSH。
 *
 * 两条一起改，缺一就会出现「数据没了但空 nav 还插在头部」：
 *   ① `resources` 清空（顺带给它一个显式类型，空数组下 for-of 的元素类型才不是 never）；
 *   ② `reconcileProjectDashboard` 里那次 `insertBefore(createResourceLinks(), toolbar)` 删掉
 *      （这是唯一的注入点；`createResourceLinks` 随之成为死代码，留在 vendor 里不影响产物）。
 * 观察者每次 reconcile 都会跑，所以只有同时删掉注入点才算真移除。
 *
 * 每条断言「恰好命中 1 次」：上游改了写法就报错，不会静默失效。
 */
const DASHBOARD_RESOURCE_PATCHES = [
  {
    file: 'src/stable/navigation/projectDashboardChrome.ts',
    from: `const resources = [
  {
    href: 'https://api.work-fisher.com/',
    label: 'AIFISHER',
    description: 'API 与服务',
    accessibleLabel: '打开 AIFISHER 服务',
    image: '/aifisher-mark-white.svg',
    imageClassName: 'fisherai-resource-link__mark',
  },
  {
    href: 'https://space.bilibili.com/17919458?spm_id_from=333.1007.0.0',
    label: 'Work-Fisher',
    description: '教程与案例',
    accessibleLabel: '打开 Work-Fisher 教学主页',
    image: '/community-placeholder.svg',
    imageClassName: 'fisherai-resource-link__avatar',
  },
] as const;`,
    to: `// dsh-aifisher-canvas 覆盖（v1.15，用户原话「移除这两个功能」）：
// 上游在项目看板头部注入两个**站外**入口 —— AIFISHER「API 与服务」(api.work-fisher.com)、
// Work-Fisher「教程与案例」(B 站教学主页)。本插件没有 AIFISHER 的服务/账号体系
// （账号 v1.3 已整体移除），教学主页也不是画布功能，两块一起去掉。
const resources: ReadonlyArray<{
  href: string;
  label: string;
  description: string;
  accessibleLabel: string;
  image: string;
  imageClassName: string;
}> = [];`,
    why: '看板头部的两个站外资源入口（AIFISHER API 与服务 / Work-Fisher 教程与案例）数据清空',
  },
  {
    file: 'src/stable/navigation/projectDashboardChrome.ts',
    from: `  if (!header.querySelector(RESOURCE_LINKS_SELECTOR)) {
    header.insertBefore(createResourceLinks(), toolbar);
  }`,
    to: `  // dsh-aifisher-canvas 覆盖（v1.15）：站外资源入口不再注入 —— 见文件顶部 resources 的说明。
  // 这里是唯一的注入点，删掉它空 nav 也不会出现在看板头部。`,
    why: '看板头部那次 createResourceLinks() 注入调用',
  },
];

{
  const missing = [];
  for (const patch of DASHBOARD_RESOURCE_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      missing.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      missing.push(`${patch.file}: ${patch.why} —— 补丁锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (missing.length > 0) {
    throw new Error(
      `[vendor] 看板站外入口移除补丁没对齐（上游可能改了写法，请核对）：\n  - ${missing.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 看板站外入口移除：${DASHBOARD_RESOURCE_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8j) 多选折叠成一叠（v1.21）
/**
 * 用户原话（2026-10-17）：「多选图片能进行折叠处理（比如原本四张图可以叠成一张，还可以解散）」。
 *
 * 落法（不进 vendor 新文件，三处正则补丁 + 一个全局桥）：
 *   ① canvasApplication.tsx：注册 `window.__FISHERAI_CANVAS_STACK__`（collapse / expand）。
 *      折叠 = 把选中的节点**从文档里摘下来**塞进最上面那张的 `stackItems` —— 于是它不占位置、
 *      不会被框选/拖动/自动排列碰到，存盘后刷新也保持折叠；展开 = 原样放回去并按网格摊开。
 *   ② dialogs/canvasSelectionBounds.tsx：多选工具条加一个「折叠」按钮（只对纯图片多选出现）。
 *   ③ nodes/canvasNodeFrame.tsx：折叠宿主卡后面垫两层「纸」+ 左下角「N 张叠图 · 展开」徽章。
 *
 * 每条断言「恰好命中 1 次」：上游改了写法就报错，不会静默失效。
 */
const STACK_PATCHES = [
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `  React.useEffect(() => {
    window.__FISHERAI_FOCUS_NODES__ = focusNodes;
    return () => {
      if (window.__FISHERAI_FOCUS_NODES__ === focusNodes) {
        delete window.__FISHERAI_FOCUS_NODES__;
      }
    };
  }, [focusNodes]);`,
    to: `  React.useEffect(() => {
    window.__FISHERAI_FOCUS_NODES__ = focusNodes;
    return () => {
      if (window.__FISHERAI_FOCUS_NODES__ === focusNodes) {
        delete window.__FISHERAI_FOCUS_NODES__;
      }
    };
  }, [focusNodes]);
  // ---------------------------------------------------------------- dsh-aifisher-canvas v1.21
  // 多选折叠成一叠：选中几个节点 → 收进最上面那张的 stackItems 里（节点从文档里摘下，
  // 所以不占位置、不会被框选/拖动/自动排列碰到；存盘后刷新仍然折叠）。
  // 展开时把这一叠**摊开**摆到宿主右边 —— 否则放回原来的点会又叠在一起，等于没解散。
  React.useEffect(() => {
    type StackNode = CanvasNode & { stackItems?: CanvasNode[] };
    const sizeOf = (node: CanvasNode) => ({
      width: Math.max(160, Number(getNodeWidth(node)) || 300),
      height: Math.max(120, Number(getNodeHeight(node)) || 280),
    });
    const bridge = {
      collapse(ids: readonly string[]) {
        const wanted = [...new Set(ids)];
        if (wanted.length < 2) return;
        const members = wanted
          .map((id) => nodes.find((node) => node.id === id))
          .filter((node): node is StackNode => Boolean(node))
          .sort((a, b) => a.y - b.y || a.x - b.x);
        if (members.length < 2) return;
        const [host, ...rest] = members;
        const carried = Array.isArray(host.stackItems) ? host.stackItems : [];
        const stackItems = [...carried, ...rest.map((node) => ({ ...node }))];
        setNodes((current) =>
          current
            .filter((node) => node.id === host.id || !wanted.includes(node.id))
            .map((node) => (node.id === host.id ? { ...node, stackItems } : node)),
        );
        setSelectedNodeIds([host.id]);
      },
      expand(hostId: string) {
        setNodes((current) => {
          const host = current.find((node) => node.id === hostId) as StackNode | undefined;
          const items = host && Array.isArray(host.stackItems) ? host.stackItems : [];
          if (!host || !items.length) return current;
          const known = new Set(current.map((node) => node.id));
          // 复制粘贴出来的副本：stackItems 里的 id 还指着原节点 —— 撞了就换新 id，
          // 叠内互相引用也一起改（否则展开等于把原图又放一遍）
          const remap = new Map<string, string>();
          const restored = items.flatMap((item) => {
            if (!item || typeof item.id !== 'string') return [];
            const nextId = known.has(item.id) ? createId() : item.id;
            if (nextId !== item.id) remap.set(item.id, nextId);
            known.add(nextId);
            return [{ ...item, id: nextId }];
          });
          const stripped = current.map((node) =>
            node.id === hostId ? { ...node, stackItems: undefined } : node,
          );
          if (!restored.length) return stripped;
          const cellWidth = Math.max(300, ...restored.map((node) => sizeOf(node).width));
          const cellHeight = Math.max(280, ...restored.map((node) => sizeOf(node).height));
          const hostSize = sizeOf(host);
          const baseX = host.x + hostSize.width + 80;
          const placed = restored.map((node, index) => ({
            ...node,
            parentIds: Array.isArray(node.parentIds)
              ? node.parentIds.map((id: string) => remap.get(id) ?? id)
              : node.parentIds,
            x: baseX + Math.floor(index / 2) * (cellWidth + 24),
            y: host.y + (index % 2) * (cellHeight + 24),
          }));
          return [...stripped, ...placed];
        });
      },
    };
    (window as unknown as { __FISHERAI_CANVAS_STACK__?: typeof bridge }).__FISHERAI_CANVAS_STACK__ =
      bridge;
    return () => {
      const scope = window as unknown as { __FISHERAI_CANVAS_STACK__?: typeof bridge };
      if (scope.__FISHERAI_CANVAS_STACK__ === bridge) scope.__FISHERAI_CANVAS_STACK__ = undefined;
    };
  }, [nodes, setNodes, setSelectedNodeIds, getNodeWidth, getNodeHeight, createId]);`,
    why: '多选折叠/展开的全局桥（画布的 nodes 状态只有这里够得着）',
  },
  {
    file: 'src/stable/dialogs/canvasSelectionBounds.tsx',
    from: `    accent = '#3b82f6',
    borderColor = isSelected ? accent : '#444';`,
    to: `    accent = '#3b82f6',
    borderColor = isSelected ? accent : '#444';
  // dsh-aifisher-canvas v1.21：纯图片多选时，多选工具条上给一个「折叠」（叠成一张，可随时解散）
  const stackableTypes = new Set(['Image', 'Upload Image']);
  const canCollapseStack =
    selectedNodes.length > 1 &&
    selectedNodes.every((node) => stackableTypes.has(String(node.type || '')));`,
    why: '多选工具条要判断「这组选中是不是纯图片」',
  },
  {
    file: 'src/stable/dialogs/canvasSelectionBounds.tsx',
    from: `          {onCreateCollage && (
            <button
              onClick={onCreateCollage}`,
    to: `          {canCollapseStack && (
            <button
              data-fisherai-collapse-stack="true"
              title={'把选中的图片叠成一张（节点上的「展开」可以随时解散）'}
              onClick={() => window.__FISHERAI_CANVAS_STACK__?.collapse(selectedNodes.map((node) => node.id))}
              className={
                'bg-[var(--af-input)] border border-[var(--af-border-control)] hover:bg-[var(--af-surface-raised)] text-[var(--af-text)] text-sm px-4 py-2.5 rounded-[12px] flex items-center gap-2 transition-colors'
              }
            >
              <svg
                width={'16'}
                height={'16'}
                viewBox={'0 0 24 24'}
                fill={'none'}
                stroke={'currentColor'}
                strokeWidth={'2'}
              >
                <rect x={'4'} y={'7'} width={'16'} height={'14'} rx={'2'} />
                <path d={'M4 7 24 24M8 4 4 7M12 3 8 4'} />
              </svg>
              {'折叠'}
            </button>
          )}
          {onCreateCollage && (
            <button
              onClick={onCreateCollage}`,
    why: '多选工具条的「折叠」按钮（拼图/排列/打组那一排）',
  },
  {
    file: 'src/stable/nodes/canvasNodeFrame.tsx',
    from: `  const width = dependencies.getWidth(data),
    height = dependencies.getHeight(data),
    zoom = validZoom(props.zoom),
    inverse = 1 / zoom;`,
    to: `  const width = dependencies.getWidth(data),
    height = dependencies.getHeight(data),
    zoom = validZoom(props.zoom),
    inverse = 1 / zoom,
    // dsh-aifisher-canvas v1.21：这张卡里叠着几张（>0 时卡后面垫纸 + 左下角给「展开」徽章）
    stackCount = Array.isArray(data.stackItems) ? (data.stackItems as unknown[]).length : 0;`,
    why: '折叠宿主卡要数出自己叠了几张',
  },
  {
    file: 'src/stable/nodes/canvasNodeFrame.tsx',
    from: `      <div className="relative group/nodecard flex flex-col items-center">
        <div`,
    to: `      <div className="relative group/nodecard flex flex-col items-center">
        {stackCount > 0 && (
          <>
            <div
              data-fisherai-stack-layer="2"
              aria-hidden="true"
              className="absolute inset-0 rounded-lg border border-[var(--af-border-control)] bg-[var(--af-surface-raised)] shadow-2xl"
              style={{ transform: 'translate(16px, 16px) rotate(2.4deg)' }}
            />
            <div
              data-fisherai-stack-layer="1"
              aria-hidden="true"
              className="absolute inset-0 rounded-lg border border-[var(--af-border-control)] bg-[var(--af-surface-raised)] shadow-2xl"
              style={{ transform: 'translate(8px, 8px) rotate(1.2deg)' }}
            />
          </>
        )}
        <div`,
    why: '折叠宿主卡的「一叠纸」视觉效果',
  },
  {
    file: 'src/stable/nodes/canvasNodeFrame.tsx',
    from: `          {props.children}
        </div>`,
    to: `          {props.children}
          {stackCount > 0 && (
            <div
              data-fisherai-stack-badge="true"
              role="button"
              tabIndex={0}
              aria-label={\`展开 \${stackCount + 1} 张叠图\`}
              title={\`这一叠有 \${stackCount + 1} 张，展开后摊在旁边\`}
              className="absolute left-2 bottom-2 z-[60] flex items-center gap-1.5 rounded-full border border-[var(--af-border-control)] bg-[var(--af-input)] px-2 py-1 text-[10px] font-semibold text-[var(--af-text)] shadow-xl pointer-events-auto"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                window.__FISHERAI_CANVAS_STACK__?.expand(data.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                window.__FISHERAI_CANVAS_STACK__?.expand(data.id);
              }}
            >
              <span>{\`\${stackCount + 1} 张叠图\`}</span>
              <span className="text-[var(--af-info)]">展开</span>
            </div>
          )}
        </div>`,
    why: '折叠宿主卡左下角的「N 张叠图 · 展开」徽章',
  },
  {
    file: 'src/stable/nodes/canvasNodeFrame.tsx',
    from: `  return component ? React.createElement(component, props) : null;
}`,
    to: `  return component ? React.createElement(component, props) : null;
}

declare global {
  interface Window {
    /** dsh-aifisher-canvas v1.21：多选折叠成一叠（canvasApplication 里注册）。 */
    __FISHERAI_CANVAS_STACK__?: {
      collapse(ids: readonly string[]): void;
      expand(hostId: string): void;
    };
  }
}`,
    why: '折叠桥的 window 类型声明',
  },
];

{
  const missing = [];
  for (const patch of STACK_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      missing.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      missing.push(`${patch.file}: ${patch.why} —— 补丁锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (missing.length > 0) {
    throw new Error(
      `[vendor] 多选折叠补丁没对齐（上游可能改了写法，请核对）：\n  - ${missing.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 多选折叠（叠图）：${STACK_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8o) 叠图「切换」按钮（v1.37）
/**
 * 用户原话（2026-10-17，附一张叠了 3 张图的画布截图）：「给这种折叠起来的图添加一个切换按钮」。
 *
 * v1.21 的折叠只给了「展开」一条路：卡上永远只看得见宿主那一张，想看下面那两张就得先展开
 * （节点摊回画布）→ 看完再重新多选 + 折叠。这里的「切换」= **不展开**也能翻看这一叠：
 *
 *   ① canvasApplication.tsx：给 `__FISHERAI_CANVAS_STACK__` 桥加一个 `rotate(hostId, step)`，
 *      它只做一件事 —— 把「纯函数算好的下一个宿主节点」替换进当前 nodes（只有这个 effect 够得着
 *      setNodes）。算法本身在 `src/canvas-ui/canvas/CanvasStack.ts`（可回归、可单测），
 *      通过装配层注册的 `window.__FISHERAI_STACK_ROTATE__` 拿进来。
 *   ② nodes/canvasNodeFrame.tsx：左下角那枚「N 张叠图 · 展开」徽章扩成一条控制条 ——
 *      `N 张叠图` + **`切换 2/3`** + `展开`。切换按钮走 `rotate(id, ±1)`（Shift+点击 = 上一张），
 *      `data-fisherai-stack-controls / -switch / -badge` 三个属性给回归与真机探针用。
 *   ③ 同一个文件：给窗口桥补 `rotate` 与 `__FISHERAI_STACK_ROTATE__` 的类型声明。
 *
 * 为什么不是「只换渲染」：切换要真的换内容（标题/提示词/结果图一起走），否则「看到第 2 张、
 * 点生成却发出第 1 张的提示词」—— 那正是 v1.34 刚修掉的那类串味。壳字段（id/位置/连线/尺寸）
 * 一律不动，所以连线、生成结果、任务队列都还指着同一个节点，卡也不会跳。
 *
 * 每条断言「恰好命中 1 次」：上游改了写法就报错，不会静默失效。
 */
const STACK_SWITCH_PATCHES = [
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `          return [...stripped, ...placed];
        });
      },
    };`,
    to: `          return [...stripped, ...placed];
        });
      },
      // dsh-aifisher-canvas v1.37：叠内「切换」—— 在不展开的前提下把叠在下面的某一张提成宿主卡。
      // 算法在 src/canvas-ui/canvas/CanvasStack.ts（纯函数，装配层注册成 __FISHERAI_STACK_ROTATE__）；
      // 这里只负责把它算出来的新宿主替换进当前 nodes —— 只有这个 effect 够得着 setNodes。
      rotate(hostId: string, step?: number) {
        const rotate = (
          window as unknown as {
            __FISHERAI_STACK_ROTATE__?: (node: CanvasNode, step?: number) => CanvasNode;
          }
        ).__FISHERAI_STACK_ROTATE__;
        if (typeof rotate !== 'function') return;
        setNodes((current) =>
          current.map((node) => (node.id === hostId ? rotate(node as CanvasNode, step) : node)),
        );
      },
    };`,
    why: '折叠桥加 rotate（叠内切换）',
  },
  {
    file: 'src/stable/nodes/canvasNodeFrame.tsx',
    from: `    // dsh-aifisher-canvas v1.21：这张卡里叠着几张（>0 时卡后面垫纸 + 左下角给「展开」徽章）
    stackCount = Array.isArray(data.stackItems) ? (data.stackItems as unknown[]).length : 0;`,
    to: `    // dsh-aifisher-canvas v1.21：这张卡里叠着几张（>0 时卡后面垫纸 + 左下角给「展开」徽章）
    stackCount = Array.isArray(data.stackItems) ? (data.stackItems as unknown[]).length : 0,
    // dsh-aifisher-canvas v1.37：这一叠现在显示第几张（「切换」按钮上的 2/3 就是它）
    stackPosition = (() => {
      const total = stackCount + 1;
      const raw = Number((data as { stackPosition?: unknown }).stackPosition);
      return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) % total : 0;
    })();`,
    why: '折叠宿主卡要知道自己现在显示第几张',
  },
  {
    file: 'src/stable/nodes/canvasNodeFrame.tsx',
    from: `          {stackCount > 0 && (
            <div
              data-fisherai-stack-badge="true"
              role="button"
              tabIndex={0}
              aria-label={\`展开 \${stackCount + 1} 张叠图\`}
              title={\`这一叠有 \${stackCount + 1} 张，展开后摊在旁边\`}
              className="absolute left-2 bottom-2 z-[60] flex items-center gap-1.5 rounded-full border border-[var(--af-border-control)] bg-[var(--af-input)] px-2 py-1 text-[10px] font-semibold text-[var(--af-text)] shadow-xl pointer-events-auto"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                window.__FISHERAI_CANVAS_STACK__?.expand(data.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                window.__FISHERAI_CANVAS_STACK__?.expand(data.id);
              }}
            >
              <span>{\`\${stackCount + 1} 张叠图\`}</span>
              <span className="text-[var(--af-info)]">展开</span>
            </div>
          )}`,
    to: `          {stackCount > 0 && (
            <div
              data-fisherai-stack-controls="true"
              data-fisherai-stack-total={stackCount + 1}
              data-fisherai-stack-position={stackPosition + 1}
              className="absolute left-2 bottom-2 z-[60] flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--af-border-control)] bg-[var(--af-input)] p-1 text-[10px] font-semibold text-[var(--af-text)] shadow-xl pointer-events-auto"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span className="px-1 text-[var(--af-text-secondary)]">{\`\${stackCount + 1} 张叠图\`}</span>
              <button
                type="button"
                data-fisherai-stack-switch="true"
                aria-label={\`切换叠图（当前第 \${stackPosition + 1}/\${stackCount + 1} 张，点击看下一张）\`}
                title={\`切换显示这一叠里的下一张；Shift+点击 = 上一张（当前第 \${stackPosition + 1}/\${stackCount + 1} 张）\`}
                className="flex items-center gap-1 rounded-full border border-[var(--af-border-control)] bg-[var(--af-surface)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--af-text)] hover:bg-[var(--af-surface-raised)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--af-info)] pointer-events-auto"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  window.__FISHERAI_CANVAS_STACK__?.rotate(data.id, event.shiftKey ? -1 : 1);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  window.__FISHERAI_CANVAS_STACK__?.rotate(data.id, event.shiftKey ? -1 : 1);
                }}
              >
                <span>{'切换'}</span>
                <span className="text-[var(--af-info)]">{\`\${stackPosition + 1}/\${stackCount + 1}\`}</span>
              </button>
              <button
                type="button"
                data-fisherai-stack-badge="true"
                aria-label={\`展开 \${stackCount + 1} 张叠图\`}
                title={\`这一叠有 \${stackCount + 1} 张，展开后摊在旁边\`}
                className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-[var(--af-info)] hover:bg-[var(--af-surface-raised)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--af-info)] pointer-events-auto"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  window.__FISHERAI_CANVAS_STACK__?.expand(data.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  window.__FISHERAI_CANVAS_STACK__?.expand(data.id);
                }}
              >
                <span>{'展开'}</span>
              </button>
            </div>
          )}`,
    why: '折叠宿主卡左下角：N 张叠图 + 切换 N/M + 展开（v1.37）',
  },
  {
    file: 'src/stable/nodes/canvasNodeFrame.tsx',
    from: `    __FISHERAI_CANVAS_STACK__?: {
      collapse(ids: readonly string[]): void;
      expand(hostId: string): void;
    };`,
    to: `    __FISHERAI_CANVAS_STACK__?: {
      collapse(ids: readonly string[]): void;
      expand(hostId: string): void;
      /** v1.37：叠内切换（step 缺省 = 下一张，-1 = 上一张，环形）。 */
      rotate(hostId: string, step?: number): void;
    };
    /** v1.37：叠内切换的纯逻辑（src/canvas-ui/canvas/CanvasStack.ts，装配层注册）。 */
    __FISHERAI_STACK_ROTATE__?: (node: unknown, step?: number) => unknown;`,
    why: '折叠桥补 rotate / 纯逻辑全局的类型声明',
  },
];

{
  const problems = [];
  for (const patch of STACK_SWITCH_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 补丁锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 叠图切换补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 叠图切换（切换按钮）：${STACK_SWITCH_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8i) 新节点的默认模型要跟着用户配的通道走

/**
 * v1.31（用户原话「新建节点的时候默认模型不是我配置好的」）。
 *
 * 上游 `createCanvasNode` 明明已经把「模型目录里的第一个模型」写进 `model` / `imageModel`：
 *
 *   const image = runtime.imageModels[0];            // 本插件里 = 用户通道勾选的模型
 *   ... createFresh({ model: image?.name, imageModel: image?.name, ... })
 *
 * 但 `createFresh` 接着调 `applyFreshCanvasNodeDefaults`，后者**无条件**把这两个字段覆盖成
 * 上游内置的 `GPT Image 2 · API` / `Seedance 2.5 Standard · API`。本插件没有这两条后端
 * （走的是自配 OpenAI 通道 / 方舟直连 / 本地 ComfyUI），于是新节点一建出来就是一条打不通的
 * 模型：点生成 → `501 CLOUD_NOT_CONFIGURED`（实测：POST /api/aifisher/canvas/generate-image
 * 带 `imageModel: "GPT Image 2 · API"` 就回这条）。
 *
 * 改法：调用方给了模型就尊重它，只有上游原生的 `GPT Image 2`（不带 `· API`）仍然换成 `· API`
 * 那条，没给才兜底。渠道表的「通道模型排在最前」在 src/canvas-ui/canvas/CloudChannelModels.ts，
 * 两边合起来才等于「新节点默认就是我在设置里勾的那个模型」。
 */
const FRESH_MODEL_PATCHES = [
  {
    file: 'src/stable/nodes/nodeFramework.ts',
    from: `function applyFreshCanvasNodeDefaults(candidate: Record<string, unknown>): Record<string, unknown> {`,
    to: `/**
 * dsh-aifisher-canvas：全新节点该用哪个模型。
 *
 * 调用方（createCanvasNode）已经填好「目录里的第一个模型」——在本插件里那就是用户自己
 * 通道勾选的模型；这里再无条件覆盖，新节点就会落回上游内置的 GPT Image 2 · API，
 * 而本插件没有那条后端（点生成只会 501）。所以给了就尊重，只有上游原生名才换成 · API 那条。
 */
function freshCanvasModel(
  candidate: Record<string, unknown>,
  key: 'imageModel' | 'videoModel',
  fallback: string,
): string {
  const explicit = candidate[key];
  if (typeof explicit === 'string') {
    const trimmed = explicit.trim();
    if (trimmed && trimmed !== NATIVE_DEFAULT_IMAGE_MODEL) return trimmed;
  }
  return fallback;
}

function applyFreshCanvasNodeDefaults(candidate: Record<string, unknown>): Record<string, unknown> {`,
    why: '新节点默认模型的解析入口',
  },
  {
    file: 'src/stable/nodes/nodeFramework.ts',
    from: `  if (type === 'image') {
    return {
      ...candidate,
      model: DEFAULT_CANVAS_IMAGE_MODEL,
      imageModel: DEFAULT_CANVAS_IMAGE_MODEL,
      resolution: '1K',
    };
  }`,
    to: `  if (type === 'image') {
    const imageModel = freshCanvasModel(candidate, 'imageModel', DEFAULT_CANVAS_IMAGE_MODEL);
    return {
      ...candidate,
      model: imageModel,
      imageModel,
      resolution: candidate.resolution || '1K',
    };
  }`,
    why: '新 Image 节点无条件覆盖 imageModel',
  },
  {
    file: 'src/stable/nodes/nodeFramework.ts',
    from: `  if (type === 'video') {
    return {
      ...candidate,
      model: DEFAULT_CANVAS_VIDEO_MODEL,
      videoModel: DEFAULT_CANVAS_VIDEO_MODEL,
      resolution: '720p',
    };
  }`,
    to: `  if (type === 'video') {
    const videoModel = freshCanvasModel(candidate, 'videoModel', DEFAULT_CANVAS_VIDEO_MODEL);
    return {
      ...candidate,
      model: videoModel,
      videoModel,
      resolution: candidate.resolution || '720p',
    };
  }`,
    why: '新 Video 节点无条件覆盖 videoModel',
  },
];

{
  const problems = [];
  for (const patch of FRESH_MODEL_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 新节点默认模型补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 新节点默认模型跟着通道走：${FRESH_MODEL_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8q) 新节点默认用「上一次生成任务那个模型」

/**
 * v1.40（用户原话「我刚建完一个节点后需要我再次调整模型，可不可以改成新的节点会默认使用
 * 上一次生成任务所使用的模型」）。
 *
 * 3.8i 之后新节点的默认模型是**模型目录的第一个**（= 用户通道里的第一条模型）。用户实际用法是
 * 在第二款/第三个通道的模型之间来回切，于是每建一个节点都要再调一次下拉。
 *
 * 这里把「上一次用的模型」接进两处（记忆本身在浏览器半 src/canvas-ui/canvas/CanvasLastModel.ts，
 * 装配层注册成 window 上的两个回调，vendor 只读它们，不引入新依赖）：
 *
 *   ① `createCanvasNode`：建节点前按 kind（image/video/audio/text）问一次
 *      `__FISHERAI_LAST_MODEL__(kind, names)`。它**只返回还留在目录里的名字**
 *      （通道被删 / 取消勾选 / 改名就返回空串），拿到空串照旧回落到 `models[0]` ——
 *      绝不能把节点写成一条打不通的模型，那正是 3.8i 修掉的「默认模型点生成 501」。
 *   ② 记的两处入口：
 *      · `updateCanvasNode`：用户在节点上换模型（画布下拉 / composer 的 changeComposerModel 都会
 *        走到这里，patch 里带 imageModel/videoModel/audioModel/textModel）；
 *      · `canvasGeneration.handleGenerate`：真发起一次生成任务时的 modelName（用户嘴里的口径；
 *        它也是唯一能覆盖「节点上的模型是程序设的、没经过下拉」的路径）。
 *
 * 两条都 try/catch 包住：记忆层坏掉最多是「默认模型又回到目录第一个」，不能拦住建节点/改模型/生成。
 */
const LAST_MODEL_PATCHES = [
  {
    file: 'src/stable/nodes/canvasNodeOperations.ts',
    from: `  const image = runtime.imageModels[0],
    video = runtime.videoModels[0];
  const audio = runtime.audioModels[0],
    text = runtime.textModels[0];`,
    to: `  // dsh-aifisher-canvas（v1.40）：新建节点的默认模型 = **上一次生成任务用过的那个模型**。
  // 记忆在浏览器半（src/canvas-ui/canvas/CanvasLastModel.ts），装配层把它注册成
  // globalThis.__FISHERAI_LAST_MODEL__(kind, names)：只返**还留在目录里**的名字，
  // 通道被删 / 取消勾选 / 改名就返回空 —— 这里照旧回落到目录第一个模型。
  const freshModel = (models: Model[], kind: string): Model | undefined => {
    const pick = (
      globalThis as {
        __FISHERAI_LAST_MODEL__?: (kind: string, names: string[]) => string;
      }
    ).__FISHERAI_LAST_MODEL__;
    if (typeof pick === 'function') {
      try {
        const remembered = pick(kind, models.map((entry) => entry.name));
        const hit = remembered ? models.find((entry) => entry.name === remembered) : undefined;
        if (hit) return hit;
      } catch {
        // 记忆层坏了不能拦住建节点
      }
    }
    return models[0];
  };
  const image = freshModel(runtime.imageModels, 'image'),
    video = freshModel(runtime.videoModels, 'video');
  const audio = freshModel(runtime.audioModels, 'audio'),
    text = freshModel(runtime.textModels, 'text');`,
    why: '新节点默认模型的取值口',
  },
  {
    file: 'src/stable/nodes/canvasNodeOperations.ts',
    from: `  const updated = { ...original, ...patch };
  if (updated.type === 'ComfyUI' && patch.comfyMode) {`,
    to: `  const updated = { ...original, ...patch };
  // dsh-aifisher-canvas（v1.40）：在节点上换模型就把这个模型记成「下一次新建节点的默认模型」。
  // 按字段名反推 kind 就够了（imageModel / videoModel / audioModel / textModel）。
  const rememberModel = (
    globalThis as {
      __FISHERAI_REMEMBER_MODEL__?: (kind: string, name: string) => void;
    }
  ).__FISHERAI_REMEMBER_MODEL__;
  if (typeof rememberModel === 'function') {
    const chosen: Array<[string, unknown]> = [
      ['image', patch.imageModel],
      ['video', patch.videoModel],
      ['audio', patch.audioModel],
      ['text', patch.textModel],
    ];
    for (const [kind, value] of chosen) {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name) continue;
      try {
        rememberModel(kind, name);
      } catch {
        // 记忆层坏了不能拦住改模型
      }
    }
  }
  if (updated.type === 'ComfyUI' && patch.comfyMode) {`,
    why: '换模型时没有记账',
  },
  {
    file: 'src/stable/generation/canvasGeneration.ts',
    from: `        const catalog =
          node.type === 'Image'`,
    to: `        // dsh-aifisher-canvas（v1.40）：这一次生成任务用的模型就是「上一次生成任务所使用的模型」，
        // 记下来给新建节点当默认值（节点上换过模型还没点生成时，updateCanvasNode 那条也会记）。
        if (modelName) {
          const rememberModel = (
            globalThis as {
              __FISHERAI_REMEMBER_MODEL__?: (kind: string, name: string) => void;
            }
          ).__FISHERAI_REMEMBER_MODEL__;
          if (typeof rememberModel === 'function') {
            try {
              rememberModel(node.type.toLowerCase(), modelName);
            } catch {
              // 记忆层坏了不能拦住生成
            }
          }
        }
        const catalog =
          node.type === 'Image'`,
    why: '发起生成时不记模型',
  },
];

{
  const problems = [];
  for (const patch of LAST_MODEL_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 上一次生成模型记忆补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 新节点默认用上一次的模型：${LAST_MODEL_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8r) 项目归档（导出 / 导入，v1.42）

/**
 * v1.42，用户 2026-10-18 原话：「在无限画布面板做一个项目导出导入的功能」。
 *
 * host 侧早就有 `GET /workflows/<id>/backup` 与 `POST /workflows/restore`（v1.1 补的），
 * 但**画布上没有任何入口**：导出只有 agent 桥那一条（`projectRuntime.download`），
 * 导入埋在品牌下拉的「导入项目 JSON」里、且直接弹一个 file input —— 导入完有没有成功、
 * 素材带没带过来，用户一概看不见。这次补一个真面板（`src/canvas-ui/canvas/CanvasProjectArchive.tsx`），
 * 顺手补两条 host 接口（规模预览 / 直接落盘导出）。
 *
 * vendor 侧只需要三件事（别的一律放装配层与 src/canvas-ui）：
 *
 *   ① `canvasApplication.tsx` 挂一个 `fisherai:open-project` 监听 —— 导入成功后要「切到新项目」，
 *      而 `openProject`（loadProject + setView）只在这个组件里。面板那边派发事件即可。
 *   ② `canvasApplication.tsx` 给 Controls 多喂一个 `projectId` —— 面板要按 id 读规模/导出，
 *      上游只把 workflowId 喂给了 SidePanels。
 *   ③ `projectDashboardChrome.ts` 在项目看板头部注入「导入项目」按钮（和已有的「设置」按钮同款）：
 *      看板视图里 Controls 槽位根本没渲染，导入入口只能在这儿。按钮只调装配层注册的
 *      `window.__FISHERAI_PROJECT_ARCHIVE__.importFromPicker()`，不引新依赖。
 *
 * 每条锚点断言「恰好命中 1 次」：上游改了写法就报错，不会静默失效。
 */
const PROJECT_ARCHIVE_PATCHES = [
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `  React.useEffect(() => {
    const ke = () => setSettingsOpen(true);
    return (
      window.addEventListener('fisherai:open-settings', ke),
      () => window.removeEventListener('fisherai:open-settings', ke)
    );
  }, [setSettingsOpen]);`,
    to: `  React.useEffect(() => {
    const ke = () => setSettingsOpen(true);
    return (
      window.addEventListener('fisherai:open-settings', ke),
      () => window.removeEventListener('fisherai:open-settings', ke)
    );
  }, [setSettingsOpen]);
  // dsh-aifisher-canvas（v1.42）：项目归档（导出/导入）面板导入完成后，靠这个事件把新项目切过来。
  // 面板与 host 都在装配层/浏览器半，只有 openProject 在组件内部（它要 loadProject + setView）。
  // 依赖写空数组：openProject 每次渲染都是新函数，但它的闭包只用到稳定 setter，
  // 抓第一份就够；写成 [openProject] 会在每次渲染时反复解绑/重绑窗口监听。
  React.useEffect(() => {
    const openProjectEvent = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id !== 'string' || !id) return;
      void openProject(id);
    };
    window.addEventListener('fisherai:open-project', openProjectEvent);
    return () => window.removeEventListener('fisherai:open-project', openProjectEvent);
  }, []);`,
    why: '项目归档面板导入后没法切到新项目（缺 fisherai:open-project 监听）',
  },
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `      React.createElement(Controls, {
        key: 'controls',
        view,`,
    to: `      React.createElement(Controls, {
        key: 'controls',
        view,
        // dsh-aifisher-canvas（v1.42）：项目归档面板要按 id 读规模 / 导出。
        // 上游只把 workflowId 喂给了 SidePanels，Controls 槽位拿不到。
        projectId: workflowId || void 0,`,
    why: 'Controls 槽位拿不到当前项目 id（项目归档面板读规模用）',
  },
  {
    file: 'src/stable/navigation/projectDashboardChrome.ts',
    from: `const SETTINGS_BUTTON_SELECTOR = '[data-fisherai-dashboard-settings="true"]';`,
    to: `const SETTINGS_BUTTON_SELECTOR = '[data-fisherai-dashboard-settings="true"]';
// dsh-aifisher-canvas（v1.42）：项目看板头部的「导入项目」按钮（幂等 reconcile 用）
const IMPORT_PROJECT_SELECTOR = '[data-fisherai-project-import="true"]';`,
    why: '看板头部「导入项目」按钮的选择器没定义',
  },
  {
    file: 'src/stable/navigation/projectDashboardChrome.ts',
    from: `  button.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('fisherai:open-settings'));
  });
  return button;
}`,
    to: `  button.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('fisherai:open-settings'));
  });
  return button;
}

/**
 * dsh-aifisher-canvas（v1.42）：项目看板头部的「导入项目」按钮。
 *
 * 用户 2026-10-18 原话：「在无限画布面板做一个项目导出导入的功能」。导入逻辑在
 * src/canvas-ui（CanvasProjectArchive.ts：选文件 → host restore → 打开新项目 → 弹回执），
 * 这里属于 vendor 半 —— 两个模块实例，所以只通过装配层注册的 window 桥
 * \`__FISHERAI_PROJECT_ARCHIVE__.importFromPicker()\` 触发；桥还没装好时退回派发
 * \`fisherai:project-import\` 事件（装配层同样监听它）。
 *
 * 不自己造 file input：导入完的「打开新项目 + 回执提示」都在画布那一侧，
 * 两边各做一半会变成「导入了但看起来什么都没发生」。
 */
function createImportProjectButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fisherai-dashboard-settings';
  button.dataset.fisheraiProjectImport = 'true';
  button.setAttribute('aria-label', '导入项目');
  button.title = '导入项目备份（.fisherai 含素材 / 旧版 .json 文档）';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 4v10M8 8l4-4 4 4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);

  const label = document.createElement('span');
  label.className = 'fisherai-dashboard-settings__label';
  label.textContent = '导入项目';
  button.append(svg, label);
  button.addEventListener('click', () => {
    const bridge = (
      window as unknown as {
        __FISHERAI_PROJECT_ARCHIVE__?: {
          importFromPicker?: (options?: { open?: boolean }) => void;
        };
      }
    ).__FISHERAI_PROJECT_ARCHIVE__;
    if (bridge && typeof bridge.importFromPicker === 'function') {
      bridge.importFromPicker();
      return;
    }
    window.dispatchEvent(new CustomEvent('fisherai:project-import'));
  });
  return button;
}`,
    why: '看板头部没有「导入项目」按钮',
  },
  {
    file: 'src/stable/navigation/projectDashboardChrome.ts',
    from: `  if (!toolbar.querySelector(SETTINGS_BUTTON_SELECTOR)) {
    const newProject = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === '新建项目',
    );
    toolbar.insertBefore(createSettingsButton(), newProject ?? null);
  }`,
    to: `  if (!toolbar.querySelector(SETTINGS_BUTTON_SELECTOR)) {
    const newProject = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === '新建项目',
    );
    toolbar.insertBefore(createSettingsButton(), newProject ?? null);
  }
  // dsh-aifisher-canvas（v1.42）：「导入项目」按钮（在「新建项目」左边、设置按钮右边）。
  // 观察者每次 reconcile 都会跑，所以这里必须按 data 属性幂等判断。
  if (!toolbar.querySelector(IMPORT_PROJECT_SELECTOR)) {
    const newProject = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === '新建项目',
    );
    toolbar.insertBefore(createImportProjectButton(), newProject ?? null);
  }`,
    why: '看板头部没有把「导入项目」按钮插进工具栏',
  },
  {
    file: 'src/stable/navigation/projectDashboardChrome.ts',
    from: `  document.querySelectorAll(SETTINGS_BUTTON_SELECTOR).forEach((element) => element.remove());`,
    to: `  document.querySelectorAll(SETTINGS_BUTTON_SELECTOR).forEach((element) => element.remove());
  document.querySelectorAll(IMPORT_PROJECT_SELECTOR).forEach((element) => element.remove());`,
    why: '卸载时没有清掉「导入项目」按钮',
  },
];

{
  const problems = [];
  for (const patch of PROJECT_ARCHIVE_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 项目归档补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 项目归档（导出/导入）：${PROJECT_ARCHIVE_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8s) 「项目数据目录」挂进「设置 → 存储」（v1.43）

/**
 * v1.43，用户 2026-10-18 原话：「设置里添加项目自定义缓存目录」。
 *
 * 「存储」这一页由 vendor 的 `mountMediaDownloadSettings(host, …)` 挂一张卡（下载目录），
 * `host` 就是 JSX 里那个 `<div ref={hostRef} data-fisherai-settings-page="storage" />`。
 * 我们只在这行之后**再挂一张卡**（原生 DOM，见 src/canvas-ui/canvas/CanvasDataDirPanel.ts），
 * 并把两边的 disposer 串起来交给 pageDisposeRef —— 切分区/关对话框时一起退订。
 *
 * 为什么必须串：vendor 那一行是 `pageDisposeRef.current = mountMediaDownloadSettings(...)`，
 * 直接再赋一次会把下载目录面板的 disposer 冲掉（它会一直挂在 DOM 里，下次进存储页会出现两张卡）。
 *
 * 锚点断言「恰好命中 1 次」。
 */
const DATA_DIR_PANEL_PATCHES = [
  {
    file: 'src/stable/settings/canvasSettings.tsx',
    from: `      else if (section === 'storage')
        pageDisposeRef.current = mountMediaDownloadSettings(host, installMediaDownloadFileName());`,
    to: `      else if (section === 'storage') {
        // dsh-aifisher-canvas（v1.43）：「项目数据目录（缓存）」面板挂在下载目录那张卡下面。
        // 两边的 disposer 都要留着 —— 只赋一个会漏掉另一个（切页后会留下孤儿面板）。
        const disposeDownload = mountMediaDownloadSettings(host, installMediaDownloadFileName());
        const disposeDataDir =
          (globalThis as any).__FISHERAI_MOUNT_DATA_DIR__?.(host) ?? null;
        pageDisposeRef.current = () => {
          disposeDownload();
          disposeDataDir?.();
        };
      }`,
    why: '「存储」页里没有「项目数据目录」面板的挂载点',
  },
];

{
  const problems = [];
  for (const patch of DATA_DIR_PANEL_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 项目数据目录面板补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 项目数据目录（设置 → 存储）：${DATA_DIR_PANEL_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8t) 切刀（Ctrl + 右键拖拽切开连线，v1.49）

/**
 * v1.49，用户 2026-10-19 原话：
 *   「现在做一个新功能，像blender一样按住ctrl加鼠标右键切换到切刀工具，划过的线会断开连接」。
 *
 * 两处改动：
 *   ① **连线 `<g>` 上补三个身份属性**。断线要的是 `(parentId, childId, portIndex)` 这组真身份，
 *      而 vendor 只给了 `data-edge-key`（`<parent>-<child>-<port>` 用 `-` 拼起来）——
 *      节点 id 里也可能有 `-`，拆错就会断开**别的**线。属性化之后读的人不用猜。
 *   ② **画布应用里挂 `__FISHERAI_CANVAS_KNIFE__.cut(edges)`**：只有这里握着 `setNodes` 与
 *      连接适配器（双击断线走的就是同一个 `adapter.disconnect`），所以「真断开」只能落在这一层。
 *      与 v1.37 叠图切换、v1.38 扩图是同一套分工：手势/几何/预览在
 *      `src/client/canvas/knife.ts`（装配层，读渲染出来的 `<path>` 采样），
 *      这里只留「够得着 nodes」的那一层薄壳。
 *
 * 撤销 / 脏标记不用额外写：`setNodes` 之后既有的 nodes 变更 effect 会 push 历史并置 dirty，
 * 与双击断线完全同一条路径。
 *
 * 每条锚点断言命中次数：上游改了写法就报错，不会静默失效。
 */
const KNIFE_PATCHES = [
  {
    file: 'src/stable/canvas/canvasEdges.tsx',
    from: `            data-edge-key={\`\${edge.parentId}-\${edge.childId}-\${edge.portIndex}\`}
`,
    to: `            data-edge-key={\`\${edge.parentId}-\${edge.childId}-\${edge.portIndex}\`}
            data-fisherai-edge-parent-id={edge.parentId}
            data-fisherai-edge-child-id={edge.childId}
            data-fisherai-edge-port-index={edge.portIndex}
`,
    why: '连线上没有可读的「父/子/端口」身份，切刀就只能猜 data-edge-key（会断错线）',
  },
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `  React.useEffect(() => {
    window.__FISHERAI_FOCUS_NODES__ = focusNodes;`,
    to: `  // ---------------------------------------------------------------- dsh-aifisher-canvas v1.49
  // 切刀（Ctrl + 右键拖拽）：把「被划过的连线」真的断开。
  // 手势/几何在 src/client/canvas/knife.ts（从渲染出来的 <path> 采样，命中后再来这里）；
  // 只有这里够得着 setNodes 与连接适配器，所以桥只做一件事：拿一串连线身份去断开。
  // 双击断线走的就是同一个 adapter.disconnect，撤销/脏标记由既有的 nodes 变更 effect 照旧处理。
  React.useEffect(() => {
    const holder = window as unknown as {
      __FISHERAI_CANVAS_KNIFE__?: {
        cut(
          edges: ReadonlyArray<{ parentId: string; childId: string; portIndex?: number }>,
        ): number;
      };
    };
    const bridge = {
      cut(edges: ReadonlyArray<{ parentId: string; childId: string; portIndex?: number }>) {
        const adapter = window.__FISHERAI_CANVAS_CONNECTIONS__;
        if (!adapter || !Array.isArray(edges) || edges.length === 0) return 0;
        let next = getNodes();
        let cut = 0;
        for (const identity of edges) {
          if (!identity || typeof identity.parentId !== 'string' || typeof identity.childId !== 'string')
            continue;
          const updated = adapter.disconnect(next, {
            parentId: identity.parentId,
            childId: identity.childId,
            portIndex: typeof identity.portIndex === 'number' ? identity.portIndex : undefined,
          });
          if (updated !== next) {
            next = updated;
            cut += 1;
          }
        }
        if (!cut) return 0;
        flushSync(() => {
          setNodes(next);
          setSelectedConnection(null);
        });
        return cut;
      },
    };
    holder.__FISHERAI_CANVAS_KNIFE__ = bridge;
    return () => {
      if (holder.__FISHERAI_CANVAS_KNIFE__ === bridge) holder.__FISHERAI_CANVAS_KNIFE__ = undefined;
    };
  }, [getNodes, setNodes, setSelectedConnection]);
  React.useEffect(() => {
    window.__FISHERAI_FOCUS_NODES__ = focusNodes;`,
    why: '画布应用里没有「按连线身份断开」的桥，切刀切完只能画个样子',
  },
];

{
  const problems = [];
  for (const patch of KNIFE_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 切刀补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 切刀（Ctrl + 右键）：${KNIFE_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8j) 别把 host 说清楚了的错误再改写掉

/**
 * v1.31（用户报「生图失败」时节点上只写着「权限被拒绝。请检查 API Key 配置。」）。
 *
 * host 半（`cloudGenerationRouter`）对 403 会拼一句能照做的话，例如
 *
 *   云端通道「Fisher」生成失败（HTTP 403）：{"code":"insufficient_user_quota",
 *   "message":"用户额度不足，无法预扣 ¥0.048752"}（通道「Fisher」的账户余额/额度不足 ——
 *   到该服务商的充值页充完值再试；这条 403 是端点侧拒绝，与画布、与密钥格式都无关。）
 *
 * `generationClient` 已经把 `error` + `hint` 拼好后抛出来了，但上游这里只要看到消息里出现
 * `403` 就把整句换成「权限被拒绝。请检查 API Key 配置。」—— 余额不足被说成密钥配错，
 * 用户只会去翻 Key。所以：host 给的详细消息原样显示，只对没有上下文的干巴错误保留兜底。
 */
const HOST_MESSAGE_PATCH = {
  file: 'src/stable/generation/canvasGeneration.ts',
  from: `        const message = /permission_denied|\\b403\\b/i.test(failure.message)
          ? '权限被拒绝。请检查 API Key 配置。'
          : failure.message || '生成任务失败';`,
  to: `        const rawMessage = failure.message || '生成任务失败';
        // dsh-aifisher-canvas：host 半给的「HTTP 状态 + 上游原话 + 可操作 hint」原样显示
        // （403 里最常见的是额度不足，不是密钥错）。
        const hostDetailed = /^云端(通道|模型)/.test(rawMessage);
        const message =
          !hostDetailed && /permission_denied|\\b403\\b/i.test(rawMessage)
            ? '权限被拒绝。请检查 API Key 配置。'
            : rawMessage;`,
  why: '上游把含 403 的错误一律改写成「请检查 API Key」，把余额不足误导成密钥配错',
};

{
  const target = path.join(VENDOR, HOST_MESSAGE_PATCH.file);
  const problems = [];
  if (!fs.existsSync(target)) {
    problems.push(`${HOST_MESSAGE_PATCH.file}（文件不存在）`);
  } else {
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(HOST_MESSAGE_PATCH.from).length - 1;
    if (hits !== 1) {
      problems.push(
        `${HOST_MESSAGE_PATCH.file}: ${HOST_MESSAGE_PATCH.why} —— 锚点命中 ${hits} 次（预期 1 次）`,
      );
    } else {
      fs.writeFileSync(target, original.split(HOST_MESSAGE_PATCH.from).join(HOST_MESSAGE_PATCH.to));
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 错误文案补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log('[vendor] 生成失败文案：host 的详细原因不再被改写成「请检查 API Key」1 处');
}

// ---------------------------------------------------------------- 3.8l) 参考素材别带缓存戳

/**
 * v1.32（用户截图里节点上写着「参考素材读不出来：…/images/media-f3e89ede.png?t=1792243183952」）。
 *
 * 因果链是这样的：画布的结果 URL 由上游 `withTimestamp()` 挂了一个缓存戳
 * （`?t=<毫秒>`，纯粹是给 `<img>` 破缓存用的）；这个 URL 又正好是**下一张图的参考素材**
 * ——`inputMedia()` / `imageReferences()` 原样把它塞进请求体的 `imageBase64`；host 半按
 * 「URL = 素材身份」解析，查询串被当成文件名的一部分 → `existsSync` 落空 → 报读不出来。
 * 「AI 高清放大」那条也一样（`imageBase64: [source.resultUrl]`）。
 *
 * host 半的真修法在 `mediaStore.parseMediaUrlRef`（一律先 `new URL(rawUrl, 占位 origin)`
 * 只取 pathname）。这里再做一层：缓存戳只服务于显示，不该进请求体。两半都改的原因是
 * **生效方式不同** —— 画布产物是 no-store，刷新页面即生效；host 半要重启 DSH。
 *
 * 只对本插件自己的素材 URL 动手：公网签名直链（例如方舟 24h 链接、FisherAI 回传的直链）
 * 的查询串是签名的一部分，动了就 403。
 */
const CACHE_STAMP_PATCHES = [
  {
    file: 'src/stable/generation/canvasGenerationRequests.ts',
    from: `/** Resolve the selected workflow output, preserving its media type and port. */
export function inputMedia(`,
    to: `/**
 * dsh-aifisher-canvas：把「显示用缓存戳」从素材 URL 上摘掉。
 *
 * 节点上存的是 \`.../media-x.png?t=1792243183952\`（withTimestamp 加的），而它同时是
 * 下一张图的参考素材；host 按路径找文件时查询串会被算进文件名。只摘本插件素材 URL 的，
 * 公网签名直链的查询串是签名的一部分，不能动。
 */
export function withoutCacheStamp(url: string | undefined): string | undefined {
  if (typeof url !== 'string' || !url) return url;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (!url.includes('/api/aifisher/canvas/media/') && !url.includes('/library/media/')) return url;
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}
/** Resolve the selected workflow output, preserving its media type and port. */
export function inputMedia(`,
    why: '参考素材 URL 上的缓存戳清理函数',
  },
  {
    file: 'src/stable/generation/canvasGenerationRequests.ts',
    from: `    return {
      kind: output?.mediaKind ?? port?.mediaKind ?? 'unknown',
      url: output?.url,
      value: output?.value,
    };`,
    to: `    return {
      kind: output?.mediaKind ?? port?.mediaKind ?? 'unknown',
      url: withoutCacheStamp(output?.url),
      value: output?.value,
    };`,
    why: '工作流输出端口当参考素材时也带缓存戳',
  },
  {
    file: 'src/stable/generation/canvasGenerationRequests.ts',
    from: `    url:
      text(kind === 'video' ? source.networkUrl || source.resultUrl : source.resultUrl) ||
      undefined,`,
    to: `    url:
      withoutCacheStamp(
        text(kind === 'video' ? source.networkUrl || source.resultUrl : source.resultUrl),
      ) || undefined,`,
    why: '图片/视频/音频节点的结果 URL 当参考素材时带缓存戳',
  },
  {
    file: 'src/stable/media/canvasImageUpscale.ts',
    from: `import { generateImage } from '../generation/generationClient';`,
    to: `import { generateImage } from '../generation/generationClient';
import { withoutCacheStamp } from '../generation/canvasGenerationRequests';`,
    why: 'AI 高清放大也要用缓存戳清理函数',
  },
  {
    file: 'src/stable/media/canvasImageUpscale.ts',
    from: `          imageBase64: [source.resultUrl],`,
    to: `          imageBase64: [withoutCacheStamp(source.resultUrl) ?? source.resultUrl],`,
    why: 'AI 高清放大把带缓存戳的结果 URL 当参考图',
  },
];

{
  const problems = [];
  for (const patch of CACHE_STAMP_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 参考素材缓存戳补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 参考素材摘掉显示用缓存戳：${CACHE_STAMP_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8m) 提示词别把上游谱系串成一条
//
/**
 * v1.34（用户报「提示词输入出现污染问题，前面的提示词会输入到后边的提示词」）。
 *
 * 上游 `buildPrompt` 收集提示词时是**沿 parentIds 一路往上爬**的：把整条上游谱系里
 * 所有非空正文的 Text 节点都捞出来，按 y/x 拼成一段，再拼上本节点自己的 prompt。
 *
 * 于是一条再普通不过的改图链就会串味：
 *
 *   Text（整段场景描述） → 图片 A → 图片 B（输入框里只写了「修复一下，人物出现了三条腿」）
 *
 * B 的输入框里只有那句话，真正发出去的却是「整段场景描述 + 那句话」。证据在素材库侧车：
 * `media/<项目>/images/<文件>.json` 里 B 那条 resultUrl 的 `prompt` 字段就是拼接后的全文。
 * 模型拿着完整场景描述整张重画，改图越改越坏。
 *
 * 真机口径应该是「输入框里显示什么，就只发什么」（同步链路 `resolveConnectedText` 的注释
 * 写的也是「只把**第一个直接连入**的 Text 节点作为实时文本源」，两处语义本来就该一致）。
 * 所以这里把上行遍历砍成**只看直接父节点**，不再递归祖辈。
 *
 * 直连的文本节点照旧生效（把它接在提示词槽上仍然是标准用法），只是不再「隔空继承」。
 */
const PROMPT_LINEAGE_PATCH = {
  file: 'src/stable/generation/generationScheduler.ts',
  from: `      const visited = new Set<string>();
      const upstreamTextNodes = new Map<string, GenerationPromptNode>();

      const pending = [...(node.parentIds ?? [])];
      while (pending.length) {
        const nodeId = pending.pop()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);
        const candidate = nodesById.get(nodeId);
        if (!candidate) continue;
        if (candidate.type.toLowerCase() === 'text' && text(candidate.textContent)) {
          upstreamTextNodes.set(candidate.id, candidate);
        }
        for (const parentId of candidate.parentIds ?? []) pending.push(parentId);
      }`,
  to: `      const upstreamTextNodes = new Map<string, GenerationPromptNode>();

      // dsh-aifisher-canvas（v1.34）：上游文本只认**直接连入**的那一层，不再顺着 parentIds 爬谱系。
      // 爬谱系会把「前面那个节点的提示词」并进这一条请求 —— 用户报的提示词污染就是它：
      // 文本节点 → 图片 A → 图片 B（改图）时，B 的输入框里只有「修复一下，人物出现了三条腿」，
      // 真正发出去的却是整段场景描述 + 这句子（素材库侧车 JSON 的 prompt 就是证据），
      // 模型照着重画一遍，改图越改越坏。原则：输入框里显示什么，这里就只发什么。
      const pending = [...(node.parentIds ?? [])];
      while (pending.length) {
        const nodeId = pending.pop()!;
        const candidate = nodesById.get(nodeId);
        if (!candidate || candidate.id === node.id) continue;
        if (candidate.type.toLowerCase() === 'text' && text(candidate.textContent)) {
          upstreamTextNodes.set(candidate.id, candidate);
        }
      }`,
  why: '提示词沿上游谱系继承（前面节点的正文被并进后面节点的请求）',
};

{
  const target = path.join(VENDOR, PROMPT_LINEAGE_PATCH.file);
  const problems = [];
  if (!fs.existsSync(target)) {
    problems.push(`${PROMPT_LINEAGE_PATCH.file}（文件不存在）`);
  } else {
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(PROMPT_LINEAGE_PATCH.from).length - 1;
    if (hits !== 1) {
      problems.push(
        `${PROMPT_LINEAGE_PATCH.file}: ${PROMPT_LINEAGE_PATCH.why} —— 锚点命中 ${hits} 次（预期 1 次）`,
      );
    } else {
      fs.writeFileSync(
        target,
        original.split(PROMPT_LINEAGE_PATCH.from).join(PROMPT_LINEAGE_PATCH.to),
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 提示词谱系补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log('[vendor] 提示词只认直接连入的文本节点（不再沿谱系继承）1 处');
}

// ---------------------------------------------------------------- 3.8p) 扩图（v1.38 / v1.39）：移除 AI 高清放大，先出画面再接生成节点

/**
 * 用户原话（2026-10-17 v1.38，附一张图片节点工具条截图，指着 HD 那个按钮）：
 *   「把这个功能移除，替换成扩图功能；还有一点，这里的功能点击生成后模型走的是之前的通道。
 *    做一个调整，点击生成后不直接生图，先输出一个空的图像生成节点，填好提示词，
 *    由我来点击最后的生成」。
 * 用户原话（2026-10-17 v1.39，附两张参考图：一张带「目标比例 / 原图位置 / 延展内容」的扩图面板，
 * 一张画布上「原图 → 扩图画面 → 扩图 · 21:9」的节点链）：
 *   「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」。
 *
 * 四段改动：
 *   ① **AI 高清放大（SeedVR2 / RunningHub 国内站）整条拆掉**：`canvasImageUpscale` 的 hook
 *      调用连模型目录里那条 `SeedVr2ImageProvider` 一起删。它点了直接生图，而且只用一条
 *      写死的旧通道（要另外绑 RH 的 Key，本插件也没有这条后端）。
 *   ② **「角度 / 全景图」不再自动生成**：这两处原来建完草稿就 `void handleGenerate(...)`，
 *      于是用户还没看见节点、没挑模型，图就已经发出去了 —— 而且用的是上游写死的那条
 *      Relay 低价版（`imageAngleDraft` 里 find 'workfisher-image-g-v2.5-lowprice'）。
 *      现在只落节点（补丁 3.9 段覆盖的 `imageAngleDraft.ts` 负责改成「跟着用户通道走」）。
 *   ③ **扩图的第一段（v1.39）**：工具条调 `__FISHERAI_CANVAS_OUTPAINT__.create()`，
 *      这个桥先调装配层的 `prepare()` 把原图画成「扩图画面」，落盘素材库，
 *      再建「扩图画面」（真实图片）+「扩图 · 比例」（空生成节点、参考图 = 扩图画面）。
 *   ④ 真正画像素在 `src/client/canvas/bootstrap.ts`、算法在 `src/canvas-ui/canvas/CanvasOutpaint.ts`；
 *      这里只留「够得着 setNodes」的那一层壳 —— 与 v1.37 叠图切换同一套分工。
 *
 * 每条锚点都断言命中次数：上游改了写法就报错，不会静默失效。
 */
const OUTPAINT_PATCHES = [
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `import { useCanvasImageUpscale } from '../media/canvasImageUpscale';
`,
    to: '',
    why: 'AI 高清放大的 hook 连同 import 一起离开画布应用',
  },
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `  const handleUpscaleImage = useCanvasImageUpscale(React, {
    projectId: workflowId || undefined,
    enabled: view === 'canvas',
    getNodes,
    setNodes,
    select: setSelectedNodeIds,
  });`,
    to: `  // ---------------------------------------------------------------- dsh-aifisher-canvas v1.39
  // 扩图桥：先把原图画成一张「扩图画面」存进素材库，再落两张节点
  //   ①「扩图画面」= 真实图片（Upload Image），原图按目标比例/九宫格位置摆好，其余留白；
  //   ②「扩图 · 比例」= 空生成节点（提示词已填、模型 = 用户通道模型、status=idle），
  //      参考图连的是那张扩图画面。
  // 像素由装配层画（window.__FISHERAI_OUTPAINT__.prepare，见 src/client/canvas/bootstrap.ts），
  // 算法在 src/canvas-ui/canvas/CanvasOutpaint.ts；这个 effect 只负责「存图 + setNodes 那一层」，
  // 因为只有 canvasApplication 够得着 createAgentNode / setNodes。
  React.useEffect(() => {
    const holder = window as unknown as {
      __FISHERAI_CANVAS_OUTPAINT__?: {
        create(
          sourceId: string,
          options?: { ratio?: string; anchor?: string; content?: string },
        ): Promise<{
          ok: boolean;
          id?: string;
          compositeId?: string;
          url?: string;
          prompt?: string;
          model?: string;
          error?: string;
        }>;
      };
    };
    const bridge = {
      async create(
        sourceId: string,
        options?: { ratio?: string; anchor?: string; content?: string },
      ) {
        if (!workflowId || view !== 'canvas') return { ok: false, error: '请先打开项目。' };
        const source = getNodes().find((node) => node.id === sourceId);
        if (!source) return { ok: false, error: '找不到这张图片，请刷新后重试。' };
        const builder = (window as unknown as {
          __FISHERAI_OUTPAINT__?: {
            prepare(
              node: unknown,
              options?: { ratio?: string; anchor?: string; content?: string },
            ): Promise<{
              dataUrl: string;
              plan: {
                compositePatch: Record<string, unknown>;
                draftPatch: Record<string, unknown>;
                positions: {
                  composite: { x: number; y: number };
                  draft: { x: number; y: number };
                };
              };
            }>;
          };
        }).__FISHERAI_OUTPAINT__;
        if (!builder || typeof builder.prepare !== 'function')
          return { ok: false, error: '扩图模块还没装配好，请刷新页面后重试。' };
        let prepared: Awaited<ReturnType<typeof builder.prepare>>;
        try {
          prepared = await builder.prepare(source, options);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : '生成扩图画面失败。',
          };
        }
        if (!prepared || typeof prepared.dataUrl !== 'string' || !prepared.plan)
          return { ok: false, error: '扩图画面没画出来，请重试。' };
        // 「扩图画面」先落素材库：借的是 host 现成的 dataURL 落盘接口（与图片标注同一条）。
        const localSource =
          typeof source.resultUrl === 'string' &&
          source.resultUrl.startsWith('/api/aifisher/canvas/media/')
            ? source.resultUrl
            : undefined;
        let assetUrl = '';
        try {
          const response = await fetch('/api/aifisher/canvas/media/images/annotation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId: workflowId,
              dataUrl: prepared.dataUrl,
              sourceUrl: localSource,
              mode: 'draw',
            }),
          });
          const body = (await response.json()) as { asset?: { url?: unknown }; error?: unknown };
          if (!response.ok) {
            throw new Error(typeof body?.error === 'string' ? body.error : '扩图画面保存失败。');
          }
          assetUrl = typeof body?.asset?.url === 'string' ? body.asset.url : '';
          if (!assetUrl) throw new Error('素材库没有返回扩图画面的地址。');
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : '扩图画面保存失败。' };
        }
        // 两张节点：先「扩图画面」，再「扩图 · 比例」（空图，生成留给用户在节点上点）。
        const composite = createAgentNode(
          'Upload Image',
          prepared.plan.positions.composite,
          workflowId,
        );
        const compositeWidth = Number((composite as unknown as { width?: unknown }).width);
        const draftPoint = {
          x:
            Number(prepared.plan.positions.composite.x) +
            (Number.isFinite(compositeWidth) && compositeWidth > 0 ? compositeWidth : 360) +
            80,
          y: Number(prepared.plan.positions.composite.y),
        };
        const draft = createAgentNode('Image', draftPoint, workflowId);
        let next = configureAgentNode([...getNodes(), composite], composite.id, {
          ...prepared.plan.compositePatch,
          resultUrl: assetUrl,
          resultUrls: [assetUrl],
        } as never);
        next = configureAgentNode([...next, draft], draft.id, prepared.plan.draftPatch as never);
        next = connectAgentNodes(next, composite.id, draft.id);
        const connected = next.find((node) => node.id === draft.id);
        if (!connected || !(connected.parentIds ?? []).includes(composite.id))
          return {
            ok: false,
            error: '当前图像模型不支持参考图：请先在模型下拉里选一个支持图生图的模型。',
          };
        flushSync(() => {
          setNodes(next);
          setSelectedNodeIds([draft.id]);
        });
        return {
          ok: true,
          id: draft.id,
          compositeId: composite.id,
          url: assetUrl,
          prompt: String(prepared.plan.draftPatch.prompt ?? ''),
          model: String(prepared.plan.draftPatch.imageModel ?? ''),
        };
      },
    };
    holder.__FISHERAI_CANVAS_OUTPAINT__ = bridge;
    return () => {
      if (holder.__FISHERAI_CANVAS_OUTPAINT__ === bridge)
        holder.__FISHERAI_CANVAS_OUTPAINT__ = undefined;
    };
  }, [
    workflowId,
    view,
    createAgentNode,
    configureAgentNode,
    connectAgentNodes,
    getNodes,
    setNodes,
    setSelectedNodeIds,
  ]);`,
    why: 'AI 高清放大整条拆掉，换成扩图桥（先出扩图画面，再接图像生成节点）',
  },
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `        onResizeImage: handleStartResize,
        onUpscaleImage: handleUpscaleImage,
`,
    to: `        onResizeImage: handleStartResize,
`,
    why: '工具条不再有「AI 高清放大」入口，这个回调也就不该再传下去',
  },
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `            void handleGenerate(result.id);
`,
    to: '',
    expect: 2,
    why: '「生成全景图 / 角度」建完草稿不再自动生图（用户要自己点最后的生成）',
  },
  {
    file: 'src/config/modelConfig.ts',
    from: `    {
        name: 'SeedVR2 高清放大 · RH',
        description: '图片工具栏专用；按 RH 云端应用公开字段接入，使用应用默认放大设置。费用以 RunningHub 账单为准。',
        provider: 'SeedVr2ImageProvider', source: 'runninghub', canonicalModel: 'SeedVR2',
        timeEstimate: '20min', maxConcurrent: 1, useProxy: false, maxInputs: 1,
        supportedReferenceTypes: ['image'], supportedImageFormats: ['png', 'jpeg', 'webp'],
        maxImageSizeMb: 30, resolutions: ['Auto'], aspectRatios: ['Auto'], cost: undefined,
        imageModes: [{ label: '高清放大', value: 'image-to-image', allowedInputs: { image: 1 } }],
        endpoint: { 'image-to-image': { url: 'https://www.runninghub.cn/task/openapi/ai-app/run', model: '2097920992202022914' } },
        advancedParams: [],
    },
`,
    to: '',
    why: 'AI 高清放大（SeedVR2/RH）这条模型条目整体移除',
  },
  {
    file: 'src/stable/dialogs/panoramaGenerate.tsx',
    from: `            {error || 'GPT2.5 低价版 · 自动连接原图，生成结果保留为新图片。'}`,
    to: `            {error || '会新建一个图片节点（提示词已填、原图已连上），生成由你在节点上点。'}`,
    why: '全景图面板不再宣称走「GPT2.5 低价版」，也不再假装会自动出图',
  },
  {
    file: 'src/stable/dialogs/panoramaGenerate.tsx',
    from: `            label="生成全景图"`,
    to: `            label="创建全景图节点"`,
    why: '全景图按钮语义变成「只建节点」',
  },
  {
    file: 'src/stable/dialogs/canvasImageAngle.tsx',
    from: `                : 'GPT2.5 低价版 · 自动连接原图，按账户实际用量计费。')}`,
    to: `                : '会新建一个角度节点（参数已填、原图已连上），生成由你在节点上点。')}`,
    why: '角度面板不再宣称走「GPT2.5 低价版」，也不再假装会自动出图',
  },
  {
    file: 'src/stable/dialogs/canvasImageAngle.tsx',
    from: `            label={editing ? '应用设置' : '生成新角度'}`,
    to: `            label={editing ? '应用设置' : '创建角度节点'}`,
    why: '角度按钮语义变成「只建节点」',
  },
];

{
  const problems = [];
  for (const patch of OUTPAINT_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const expected = patch.expect ?? 1;
    const hits = original.split(patch.from).length - 1;
    if (hits !== expected) {
      problems.push(
        `${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 ${expected} 次）`,
      );
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 扩图补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 扩图 / 移除高清放大：${OUTPAINT_PATCHES.length} 处`);
}

// ---------------------------------------------------------------- 3.8u) 文本节点的正文别落进「提示词」框（v1.50）

/**
 * 用户报障（2026-10-19）：「发现一个问题，它生成的内容不在文本里，反而在提示词里」。
 *
 * 画布对 Text 节点有**两个文本字段**：
 *   - `textContent`：节点大画布区里的「正文」（用户眼里的文本）；
 *   - `prompt`：「转换模板」（节点下方生成面板里的提示词框），只在发起大模型请求时
 *     与正文拼接（generationScheduler.buildPrompt：上游文本 + 正文 + 模板）。
 * 而 agent 控制通道的 create 只认一个 `prompt` 字段，executor 又原样写进 `node.prompt`
 * —— 于是 agent 建的文本节点，文字全出现在提示词框里、正文一片空白；接给下游时
 * buildPrompt 只认 textContent，这个节点等于没接上。
 *
 * 口径（与用户直觉一致）：
 *   ① create：只给 prompt → 当正文（写 textContent，prompt 留空）；
 *      同时给 text + prompt → text 是正文、prompt 是转换模板；
 *   ② update：只给 prompt → 改写正文；显式 text → 改正文（prompt 不动）。
 * `text` 两个字段都进 validCanvasControl 的白名单（否则指令会被判 INVALID）。
 */
const TEXT_NODE_BODY_PATCHES = [
  {
    file: 'src/stable/agent/canvasControlExecutor.ts',
    from: `          node.title = operation.title || '';
          node.prompt = operation.prompt || '';`,
    to: `          node.title = operation.title || '';
          // dsh-aifisher-canvas：Text 节点的正文是 textContent，prompt 是「转换模板」。
          // 混用会让 agent 写入的文字出现在提示词框里、正文一片空白（下游也读不到）。
          // ① 只给 prompt → 当正文；② 显式 text → 正文 + prompt 作模板。
          if (node.type === 'Text') {
            if (typeof operation.text === 'string') {
              node.textContent = operation.text;
              node.prompt = operation.prompt || '';
            } else {
              node.textContent = operation.prompt || '';
              node.prompt = '';
            }
          } else {
            node.prompt = operation.prompt || '';
          }`,
    why: 'create 把所有类型的 prompt 一律写进 node.prompt，文本节点的正文被落在提示词框',
  },
  {
    file: 'src/stable/agent/canvasControlExecutor.ts',
    from: `          } else if (operation.kind === 'update') next.nodes[index] = { ...next.nodes[index], ...operation.patch };`,
    to: `          } else if (operation.kind === 'update') {
            const current = next.nodes[index];
            const fields: Partial<CanvasNode> & { text?: string } = { ...operation.patch };
            if (typeof fields.text === 'string') {
              // 显式 text：正文写入 textContent；prompt 留给转换模板。
              if (current.type === 'Text') fields.textContent = fields.text;
              delete fields.text;
            } else if (current.type === 'Text' && typeof fields.prompt === 'string') {
              // 只给 prompt（旧口径）：当正文改，避免同样落进提示词框。
              fields.textContent = fields.prompt;
              fields.prompt = '';
            }
            next.nodes[index] = { ...current, ...fields };
          }`,
    why: 'update 的 prompt 打在 Text 节点上同样错了字段（正文 vs 转换模板）',
  },
  {
    file: 'src/shared/canvasControlProtocol.js',
    from: `const patch = value => exact(value, ['title', 'prompt', 'x', 'y']) && Object.keys(value).length > 0
  && Object.entries(value).every(([key, entry]) => ['x', 'y'].includes(key) ? coordinate(entry)
    : typeof entry === 'string' && entry.length <= (key === 'prompt' ? Infinity : 500));`,
    to: `const patch = value => exact(value, ['title', 'prompt', 'text', 'x', 'y']) && Object.keys(value).length > 0
  && Object.entries(value).every(([key, entry]) => ['x', 'y'].includes(key) ? coordinate(entry)
    : typeof entry === 'string' && entry.length <= (['prompt', 'text'].includes(key) ? Infinity : 500));`,
    why: 'update patch 要能带 text（文本节点的正文），否则指令被判 INVALID',
  },
  {
    file: 'src/shared/canvasControlProtocol.js',
    from: `    if (op.kind === 'create') return exact(op, ['kind', 'ref', 'type', 'x', 'y', 'title', 'prompt'])`,
    to: `    if (op.kind === 'create') return exact(op, ['kind', 'ref', 'type', 'x', 'y', 'title', 'prompt', 'text'])`,
    why: 'create 要能带 text（正文），否则正文与 prompt 模板混用没有出口',
  },
  {
    file: 'src/shared/canvasControlProtocol.js',
    from: `      && (op.prompt === undefined || typeof op.prompt === 'string');`,
    to: `      && (op.prompt === undefined || typeof op.prompt === 'string')
      && (op.text === undefined || typeof op.text === 'string');`,
    why: 'create.text 的类型校验（长度不限，与 prompt 同口径）',
  },
  {
    file: 'src/shared/canvasControlProtocol.d.ts',
    from: `  | { kind: 'create'; ref: string; type: 'Image' | 'Video' | 'Audio' | 'Text'; x: number; y: number; title?: string; prompt?: string }
  | { kind: 'update'; nodeId: string; patch: { title?: string; prompt?: string; x?: number; y?: number } }`,
    to: `  | { kind: 'create'; ref: string; type: 'Image' | 'Video' | 'Audio' | 'Text'; x: number; y: number; title?: string; prompt?: string; text?: string }
  | { kind: 'update'; nodeId: string; patch: { title?: string; prompt?: string; text?: string; x?: number; y?: number } }`,
    why: '类型也要认 text，否则 executor 里 operation.text 通不过 tsc',
  },
];

{
  const problems = [];
  for (const patch of TEXT_NODE_BODY_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 文本节点正文补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 文本节点正文：${TEXT_NODE_BODY_PATCHES.length} 处（正文 → textContent）`);
}

// ---------------------------------------------------------------- 3.8v) 生成批次确认卡（v1.58）

/**
 * DSH 版把上游「画布内 Agent 面板」整块压掉了（`CanvasShell` 的 SUPPRESS_VENDOR_AGENT_CSS），
 * 而「确认本批生成与费用」那张卡正好画在那个面板里 —— 于是 Agent 准备的批次停在
 * awaiting-approval，界面上**没有任何地方能按确认**，v1.57 的推送链路永远等不到批次收口。
 *
 * 桥只做一件事：把 `canvasCreation` 控制器挂到 window，由
 * `src/canvas-ui/canvas/CanvasGenerationBatches.tsx` 在画布图层里画确认卡。
 * **只挂对象、不新增协议动作** —— `approve` 仍然只有页面里的 UI 能调，`canvas_control`
 * 拿不到，审批红线不动。
 *
 * 为什么挂在 `restore(activeProjectId)` 的 effect 后面：`canvasCreation` 在切项目时会被
 * useMemo 重建，卡片组件自己会按全局实例比对重订阅（见 CanvasGenerationBatches 的注释）。
 */
const GENERATION_BATCHES_PATCHES = [
  {
    file: 'src/stable/canvas/canvasApplication.tsx',
    from: `  React.useEffect(() => {
    if (activeProjectId) void canvasCreation.restore(activeProjectId).catch(() => {});
  }, [activeProjectId, canvasCreation]);`,
    to: `  React.useEffect(() => {
    if (activeProjectId) void canvasCreation.restore(activeProjectId).catch(() => {});
  }, [activeProjectId, canvasCreation]);
  // ---------------------------------------------------------------- dsh-aifisher-canvas v1.58
  // 生成批次的确认 UI 在 DSH 版里被压掉了（上游那块卡在 canvasAgentPanel 里）。
  // 把控制器挂到 window，由 src/canvas-ui/canvas/CanvasGenerationBatches.tsx 画确认卡。
  // 只暴露对象，不新增任何 canvas 协议动作 —— approve 仍然只有页面里的 UI 能调。
  React.useEffect(() => {
    const holder = window as unknown as {
      __FISHERAI_CANVAS_GENERATION_BATCHES__?: typeof canvasCreation;
    };
    holder.__FISHERAI_CANVAS_GENERATION_BATCHES__ = canvasCreation;
    return () => {
      if (holder.__FISHERAI_CANVAS_GENERATION_BATCHES__ === canvasCreation) {
        holder.__FISHERAI_CANVAS_GENERATION_BATCHES__ = undefined;
      }
    };
  }, [canvasCreation]);`,
    why: '画布把生成批次控制器交出来（确认卡是 DSH 版唯一的审批入口）',
  },
];

{
  const problems = [];
  for (const patch of GENERATION_BATCHES_PATCHES) {
    const target = path.join(VENDOR, patch.file);
    if (!fs.existsSync(target)) {
      problems.push(`${patch.file}（文件不存在）`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const hits = original.split(patch.from).length - 1;
    if (hits !== 1) {
      problems.push(`${patch.file}: ${patch.why} —— 锚点命中 ${hits} 次（预期 1 次）`);
      continue;
    }
    fs.writeFileSync(target, original.split(patch.from).join(patch.to));
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] 生成批次确认卡补丁没对齐（上游可能改了写法，请核对）：\n  - ${problems.join('\n  - ')}`,
    );
  }
  console.log(`[vendor] 生成批次确认卡：${GENERATION_BATCHES_PATCHES.length} 处（控制器挂 window）`);
}

// ---------------------------------------------------------------- 3.9) 整文件覆盖（scripts/patches/aifisher/**）

/**
 * 正则改写只适合「一句话/一个属性」级别的补丁。当某个上游文件需要**换掉整份实现**
 * （例如把「已停用的旧版工作流节点」换成我们自己的通用本地工作流节点），继续堆正则
 * 只会变成一坨没人敢改的东西，而且上游一改写法就静默失效。
 *
 * 所以这里加一层「覆盖文件」机制：
 *   scripts/patches/aifisher/<与 vendor/aifisher 相同的相对路径>   ← 覆盖 vendor 里的同名文件
 *
 * 规则：
 *   - 每条覆盖都必须**命中 vendor 里已存在的文件**（写错路径 / 上游删了文件 → 直接报错），
 *     这样不会悄悄多出一个没人引用的孤儿文件；
 *   - 覆盖发生在所有正则改写**之后**：补丁文件是我们自己写的，里面的 URL 一律直接写
 *     `/api/aifisher/canvas/...`，不能再被 3) 段的 `/api/` 正则改一遍（会变成双前缀）；
 *   - 覆盖文件的 CSS import 不受 2) 段处理（我们不在补丁里 import CSS）。
 */
const PATCH_ROOT = path.join(REPO, 'scripts', 'patches', 'aifisher');
let overridden = 0;

if (fs.existsSync(PATCH_ROOT)) {
  const patchFiles = [];
  walk(PATCH_ROOT, (file) => patchFiles.push(file));
  const problems = [];
  for (const file of patchFiles.sort()) {
    const rel = path.relative(PATCH_ROOT, file).replace(/\\/g, '/');
    const target = path.join(VENDOR, rel);
    if (!fs.existsSync(target)) {
      problems.push(`${rel}（vendor 里没有这个文件：上游改了路径或删了它）`);
      continue;
    }
    fs.copyFileSync(file, target);
    overridden += 1;
    console.log(`[vendor] 覆盖：${rel}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `[vendor] scripts/patches/aifisher 里的覆盖文件对不上 vendor（请核对路径）：\n  - ${problems.join('\n  - ')}`,
    );
  }
}

// ---------------------------------------------------------------- 4) 生成样式模块

/**
 * canvas.css 顶部那段是 AIFISHER 独立外壳的全局规则：
 *   html, body, #root { width/height:100%; margin:0; overflow:hidden }
 *   body { color/background-color }
 * 注入到 DSH 页面里会连带改掉 DSH 自己的 html/body。这里用容器选择器替换掉，
 * 保持文件里其余规则（.text-node-typography / .tiptap-editor / .custom-scrollbar ...）原样。
 */
const SHELL_BLOCK = /html,\s*\r?\nbody,\s*\r?\n#root\s*\{[^}]*\}\s*\r?\nbody\s*\{[^}]*\}/m;
const SHELL_BLOCK_REPLACEMENT = `.af-canvas-mount {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  overscroll-behavior: none;
  color: var(--af-text);
  background-color: var(--af-canvas, #050505);
}`;

/**
 * 上游 canvas.css 顶部还有 Tailwind 的构建期指令：
 *   @import 'tailwindcss' source(none);
 *   @source "../";
 *   @source not "../**\/*.test.*";
 * 这两类是给 Vite+Tailwind 编译用的，运行时注入的 CSS 里必须去掉：
 * 浏览器会把 `@import 'tailwindcss'` 当相对 URL 去请求（404 噪音）。
 * Tailwind 的编译由 scripts/build-canvas-css.mjs 按 tailwind-entry.css 单独跑。
 */
const TAILWIND_DIRECTIVE = /^[ \t]*@(import\s+['"]tailwindcss[^'"]*['"][^;]*|source\b.*)[ \t]*;?[ \t]*\r?\n/gm;

const parts = [];
let neutralized = false;
let strippedDirectives = 0;
for (const rel of cssFiles) {
  const abs = path.join(VENDOR, 'src', rel);
  let css = fs.readFileSync(abs, 'utf8');
  const before = css;
  css = css.replace(SHELL_BLOCK, () => {
    neutralized = true;
    return SHELL_BLOCK_REPLACEMENT;
  });
  css = css.replace(TAILWIND_DIRECTIVE, () => {
    strippedDirectives += 1;
    return '';
  });
  if (css !== before) {
    // 替换结果写回源码树，保持 "vendor 里的 CSS 就是最终生效的 CSS" 这一直觉
    fs.writeFileSync(abs, css);
  }
  parts.push(`/* ===== ${rel} ===== */\n${css.trim()}`);
}

const stylesModule = `/**
 * 由 scripts/vendor-aifisher.mjs 生成，请勿手改。
 *
 * 上游源码里 \`import './x.css'\` 已被摘掉，CSS 汇总到这里，
 * 由 client 半在挂载画布时注入一个 <style data-aifisher-canvas>。
 * 顺序 = 源码里首次 import 的顺序。
 */
export const AIFISHER_CSS_FILES: readonly string[] = ${JSON.stringify(cssFiles, null, 2)};

export const AIFISHER_CSS = ${JSON.stringify(parts.join('\n\n'))};
`;

fs.writeFileSync(path.join(VENDOR, 'styles.generated.ts'), stylesModule);

console.log(
  [
    `[vendor] 源：${SRC_ROOT}`,
    `[vendor] 落点：${VENDOR}`,
    `[vendor] 复制文件：${stats.files}`,
    `[vendor] 改写 CSS import 的文件：${touched}`,
    `[vendor] 收集 CSS：${cssFiles.length} 个`,
    `[vendor] canvas.css 外壳规则中立化：${neutralized ? '已处理' : '未命中（注意：CSS 结构可能变了）'}`,
    `[vendor] 摘掉 Tailwind 构建期指令：${strippedDirectives} 条`,
    `[vendor] /api/ 命名空间改写：${apiRewrites} 处（${apiFiles} 个文件）`,
    `[vendor] 整文件覆盖（scripts/patches/aifisher）：${overridden} 个`,
  ].join('\n'),
);
