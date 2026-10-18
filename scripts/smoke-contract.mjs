/**
 * 契约烟测：在没有浏览器的情况下，验证两半产物真的符合 DSH 的加载器契约。
 *
 *   client 半：用 stub 的 window.__ModuleLoader__ 接住注册 → 用 stub require 跑 factory
 *              → 调 apply(stubCtx)，看它到底注册了哪些 slot
 *   host   半：直接 import 产物，检查导出形状，并用 stub ctx 调 apply，
 *              看路由与 canvas_control 工具是否真的注册上
 *
 * 用法：npm run smoke（需要先 npm run build）
 *
 * 注意：这不等于浏览器里的视觉验证。侧边栏图标/面板长什么样，仍然要在页面上看。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lines = [];
let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  lines.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

// ---------------- client 半 ----------------
const clientSrc = readFileSync(join(ROOT, 'lib/client/apply.js'), 'utf8');
let registration;
const sandbox = { console, window: {} };
sandbox.window.__ModuleLoader__ = { load: (reg) => { registration = reg; } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(clientSrc, sandbox, { filename: 'lib/client/apply.js' });
  check('client 产物执行并注册模块', true);
} catch (e) {
  check('client 产物执行并注册模块', false, e.message);
}

check('注册 id 等于包名', registration?.id === 'dsh-aifisher-canvas', String(registration?.id));
check('注册带 factory', typeof registration?.factory === 'function');

const required = [];
const ReactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? null, children: args.slice(2) }),
  Fragment: Symbol.for('react.fragment'),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
};
const requireShim = (spec) => {
  required.push(spec);
  if (spec === 'react') return ReactStub;
  if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: ReactStub.Fragment };
  throw new Error(`unexpected require("${spec}")`);
};

let mod;
try {
  mod = registration.factory(requireShim);
  check('factory 返回 exports 对象', !!mod && typeof mod === 'object');
} catch (e) {
  check('factory 返回 exports 对象', false, e.message);
}
check('exports.apply 是函数', typeof mod?.apply === 'function');
check('exports.inject 声明了 slots', Array.isArray(mod?.inject) && mod.inject.includes('slots'),
  JSON.stringify(mod?.inject));
check('只向模块表要了 react', required.every((s) => s.startsWith('react')), required.join(', ') || '(none)');

// 面板出口：client 产物必须真的接上 DSH 的 layout（面板没有内置返回控件）
check('client 产物含面板退出（ctx.layout.selectPanel(null)）',
  clientSrc.includes('selectPanel') && clientSrc.includes('data-dsh-aifisher-exit'),
  '');
check('client 产物不 require react/jsx-runtime（模块表只有 react）',
  !clientSrc.includes('require("react/jsx-runtime")') && !clientSrc.includes("require('react/jsx-runtime')"),
  '');
// 现场事故的护栏：产物里不许出现「直接读 layout 属性」的写法。
// cordis 的 ctx 是服务代理，读没有写进 inject 的服务属性会抛错（见下面真实上下文那组检查）。
// 先去掉注释：文档里会引用这个错误写法，别让它把产物检查带偏。
const clientCode = clientSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('client 产物不直接读 ctx.layout 属性（必须走 ctx.get("layout")）',
  !/\.layout\b/.test(clientCode),
  '');

const slots = [];
const stubSlotsCtx = {
  slots: {
    inject: (_owner, cb) => { cb(); return () => {}; },
    register: (options, component) => { slots.push({ options, component }); return () => {}; },
  },
};
try {
  const plugin = mod.default ?? mod;
  const dispose = await plugin.apply(stubSlotsCtx);
  check('client apply() 跑通', true);
  check('注册了 slot', slots.length > 0, `count=${slots.length}`);
  const names = slots.map((s) => s.options?.name ?? s.options?.id ?? '(unnamed)');
  check('slot 名字可读', names.every((n) => typeof n === 'string' && n.length > 0), names.join(' | '));
  check('每个 slot 都带组件', slots.every((s) => s.component !== undefined));

  // sidebar.panellist 的 id 必须与 main 的 key 相同，否则点选会抛错
  const panelIds = slots.filter((s) => s.options?.name === 'sidebar.panellist').map((s) => s.options.id);
  const mainKeys = slots.filter((s) => s.options?.name === 'main').map((s) => s.options.key);
  check('每个侧边栏面板都有对应的 main 页',
    panelIds.length > 0 && panelIds.every((id) => mainKeys.includes(id)),
    `panels=[${panelIds.join(',')}] mainKeys=[${mainKeys.join(',')}]`);

  if (typeof dispose === 'function') {
    dispose();
    check('apply 返回的清理函数可调用', true);
  }
} catch (e) {
  check('client apply() 跑通', false, e.message);
}

// ---------------- 真实 cordis 上下文 ----------------
// 这一组是那次「应用无法启动」的复现与锁死：
// apply() 里直接读 ctx.layout。cordis 的 ctx 是服务代理，读一个没有写进本插件 inject
// 的服务属性会当场抛 `cannot get property "layout" without inject`（跟服务有没有提供无关）。
// 异常发生在 apply() 里 → 整个 client 半 failed → DSH 中止启动：
//   web boot: 1 entry did not activate
//   dsh-aifisher-canvas: failed
// stub ctx 是普通对象，读属性不会抛错，所以这组检查必须用真的 cordis 上下文。
try {
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const cordisRegistrations = [];
  class SlotService extends Service {
    constructor(ctx) {
      super(ctx, 'slots');
    }
    inject(_key, callback) {
      return callback() ?? (() => {});
    }
    register(options) {
      cordisRegistrations.push(options?.name);
      return () => {};
    }
  }
  class LayoutService extends Service {
    constructor(ctx) {
      super(ctx, 'layout');
    }
    selectPanel() {
      return null;
    }
  }
  // 两种宿主都跑：没有 layout 服务（老版本/裁剪版）与有 layout 服务。
  for (const withLayout of [false, true]) {
    const root = new Context();
    await root.plugin(SlotService);
    if (withLayout) await root.plugin(LayoutService);
    await root.plugin({ name: 'dsh-aifisher-canvas', inject: mod.inject, apply: mod.apply });
    await root.fiber.dispose();
  }
  check('真实 cordis 上下文里 apply() 跑通（取 layout 服务不再抛错）', true,
    `注册 ${cordisRegistrations.length} 次 / 无 layout 的宿主也跑通`);
} catch (e) {
  check('真实 cordis 上下文里 apply() 跑通（取 layout 服务不再抛错）', false, e.message);
}

// ---------------- host 半 ----------------
let hostMod;
try {
  hostMod = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
  check('host 产物可 import', true);
} catch (e) {
  check('host 产物可 import', false, e.message);
}
check('host 导出 apply/inject/name',
  typeof hostMod?.apply === 'function' && Array.isArray(hostMod?.inject) && typeof hostMod?.name === 'string',
  JSON.stringify({ name: hostMod?.name, inject: hostMod?.inject }));

const hostCalls = [];
const routeLike = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    return (...args) => {
      const first = args[0];
      const label = first && typeof first === 'object' ? (first.path ?? first.name ?? first.kind ?? '') : String(first ?? '');
      hostCalls.push(`${String(prop)}${label ? `:${label}` : ''}`);
    };
  },
});
const services = {
  webServer: routeLike,
  skills: { list: async () => [], get: async () => null },
};
const ctxStub = {
  get: (name) => services[name],
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: (tool) => { hostCalls.push(`tools.register:${tool?.name}`); } },
};

try {
  hostMod.apply(ctxStub);
  check('host apply() 跑通', true);
  check('host 挂了 webServer 路由', hostCalls.some((c) => c.startsWith('register:')),
    hostCalls.filter((c) => c.startsWith('register')).join(', ') || '(none)');
  check('host 注册了 canvas_control 工具', hostCalls.includes('tools.register:canvas_control'),
    hostCalls.filter((c) => c.startsWith('tools')).join(', ') || '(none)');
  check('host 挂了画布本地后端路由', hostCalls.includes('register:/api/aifisher/canvas'),
    hostCalls.join(', '));
  check('host 挂了画布应用静态路由', hostCalls.includes('register:/api/aifisher/canvas-app'),
    hostCalls.join(', '));
  check('host 托管画布品牌图（画布头部菜单不再裂图）',
    hostCalls.includes('register:/aifisher-mark-white.svg') && hostCalls.includes('register:/brand'),
    hostCalls.filter((c) => c.includes('brand') || c.includes('mark')).join(', ') || '(none)');
} catch (e) {
  check('host apply() 跑通', false, e.message);
}

// ---------------- host 产物里的新能力（本地工作流生成 / 媒体库） ----------------
{
  let hostSrc = '';
  try {
    hostSrc = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  } catch (e) {
    check('host 产物可读', false, e.message);
  }
  if (hostSrc) {
    check('host 产物含本地工作流统一入口', hostSrc.includes('UNKNOWN_WORKFLOW'));
    check('host 产物含提交前对账（缺节点/缺模型）',
      hostSrc.includes('COMFY_NODE_MISSING') && hostSrc.includes('COMFY_MODEL_MISSING'));
    check('host 产物含媒体库 URL 命名空间', hostSrc.includes('/api/aifisher/canvas/media'));
    check('host 产物含任务日记与取消', hostSrc.includes('GENERATION_CANCELLED'));
    check('host 产物含素材回收站语义', hostSrc.includes('trash'));
    check('host 产物含自定义工作流的「画布节点骨架」推导',
      hostSrc.includes('textParameter') && hostSrc.includes('parameterHints'),
      '');
    // 画布右侧对话面板（v1.9）：大脑是 DSH 会话，契约是上游 agentClient 那套
    check('host 产物含画布对话的 DSH 会话桥（sessionController + 流式帧）',
      hostSrc.includes('sessionController') && hostSrc.includes('agent/assistant-stream'),
      '');
    check('host 产物含画布对话的失败码与超时兜底',
      hostSrc.includes('CHAT_UNAVAILABLE') && hostSrc.includes('CHAT_BUSY') && hostSrc.includes('本轮没有收尾'),
      '');
    check('host 产物含画布助手上下文提示（第一回合注入）',
      hostSrc.includes('画布助手模式') && hostSrc.includes('plugin:dsh-aifisher-canvas'),
      '');
    check('host 产物把会话存档落在画布数据目录',
      hostSrc.includes('agent-chat.json'),
      '');
  }
}

// ---------------- 画布应用产物 ----------------
const canvasEntry = join(ROOT, 'lib/canvas/canvas-app.js');
let canvasSrc = '';
try {
  canvasSrc = readFileSync(canvasEntry, 'utf8');
  check('画布应用产物存在', true, `${(canvasSrc.length / 1024 / 1024).toFixed(2)} MB`);
} catch (e) {
  check('画布应用产物存在', false, e.message);
}

if (canvasSrc) {
  // 必须是浏览器能直接吃的 ESM：不能残留裸模块说明符。
  // 注意断言写法：`from` 必须出现在**语句起始**（`;from"x"` / 行首 / 文件头），
  // 否则会把 Tailwind 里的 CSS 属性名（`"gradient-from":[{from:I()}]`）当成 import 误报。
  const bare = [...canvasSrc.matchAll(/(?:^|[;\n])\s*import[^;\n]*?from\s*"(?!\.|\/)([^"]+)"/g)].map(
    (m) => m[1],
  );
  check('画布产物没有裸模块 import', bare.length === 0, [...new Set(bare)].join(', ') || '(none)');
  // 自带 React 19（与 DSH 模块表的 18 隔离）
  check('画布产物自带 React 19', canvasSrc.includes('19.') && canvasSrc.includes('react-dom'));
  // AIFISHER 的后端调用必须已改写到插件命名空间
  check('画布产物用 /api/aifisher/canvas/ 命名空间', canvasSrc.includes('/api/aifisher/canvas/'));
  check('画布产物不再直呼上游 /api/ 路径', !/["'`]\/api\/(workflows|folders|preferences)/.test(canvasSrc));
  // 样式注入（Tailwind 工具类 + 上游 CSS）
  check('画布产物内置样式注入', canvasSrc.includes('dsh-aifisher-canvas-styles'));
  // 上游缺陷修复：nodeWidth/nodeHeight 的 getNodeSize 双 ?.
  check('上游 getNodeSize 缺 ?. 缺陷已修', !/getNodeSize\(node\)\.(width|height)/.test(canvasSrc));

  // 本地工作流节点（vendor 覆盖 + 入口补丁的产物断言）
  check('画布产物含通用本地工作流节点（下拉/提示词/生成按钮）',
    canvasSrc.includes('data-fisherai-local-workflow-node') &&
      canvasSrc.includes('data-fisherai-local-workflow-picker') &&
      canvasSrc.includes('data-fisherai-local-workflow-generate'),
    '');
  check('画布产物含本地工作流清单（拉能力清单 + 注册模板）',
    canvasSrc.includes('本地工作流清单') || canvasSrc.includes('localWorkflowDefinition'),
    '');
  check('入口补丁已生效：工作流库事件只剩画布应用自己那两处（菜单/侧边栏/旧节点都不再派发）',
    (canvasSrc.match(/open-workflow-library/g) ?? []).length === 2,
    `open-workflow-library x${(canvasSrc.match(/open-workflow-library/g) ?? []).length}`);
  check('旧的「已停用」占位节点文案已不在产物里',
    !canvasSrc.includes('此内置工作流已停用。原节点参数'),
    '');

  // 「工作流节点」面板 + 工作流配图（v1.28）：
  // 用户报障「左侧工作流节点做错了，点击后是在画布右键的样子」——入口不许再接 onAddClick，
  // 面板与配图接口的锚点必须在产物里（少一个就是「面板能开但点不动 / 配图存不下来」）。
  check('画布产物含「工作流节点」面板与入口锚点',
    canvasSrc.includes('data-fisherai-workflow-node-panel') &&
      canvasSrc.includes('data-fisherai-workflow-node-trigger'),
    '');
  check('画布产物含工作流配图接口（上传/清除/取图）',
    canvasSrc.includes('/workflow-covers/'),
    '');
  check('画布节点头部会用自定义配图（cover=custom/brand 两态）',
    canvasSrc.includes('data-fisherai-local-workflow-cover'),
    '');

  // 云端模型生成（2026-10-16 修「点生图没反应」）：useGeneration 曾经是空实现，
  // 产物里那句「尚未接入 DSH」的 console.warn 就是那个症状；现在必须是上游实现发的请求。
  check('画布产物不再把云端生成当未接入（没有 useGeneration 的空实现提示）',
    !canvasSrc.includes('尚未接入 DSH'),
    '');
  check('画布产物会调 host 的云端生成端点（/generate-<kind>）',
    canvasSrc.includes('/api/aifisher/canvas/generate-'),
    '');
  // 生成失败时 host 半的 hint（去方舟控制台开通 / 核对 Key）必须能到用户眼前：
  // 上游 generationClient 只抛 result.error，于是补丁把 hint 接进 error.message。
  // 变量名会被 minify，所以认那段「把 hint 用全角括号接在 error 后面」的形状。
  check('画布产物会把 host 的失败提示（hint）接进错误文案',
    /（\$\{\w+\}）/.test(canvasSrc) && canvasSrc.includes('hint'), '');

  // 右侧对话面板（v1.9）：面板本体是 vendor 的，我们要保证①它真的被打进产物、
  // ②它的两个贴边元素已被补丁改成贴画布、③模型清单走我们的桥而不是上游那份空的闭源目录。
  check('画布产物含右侧对话面板与启动球',
    canvasSrc.includes('data-fisherai-agent-panel') && canvasSrc.includes('data-fisherai-agent-launcher'),
    '');
  check('对话面板已贴画布右缘（vendor 补丁 fixed→absolute）',
    canvasSrc.includes('absolute top-0 right-0 h-full border-l flex flex-col z-40') &&
      !canvasSrc.includes('fixed top-0 right-0 h-full border-l flex flex-col z-40'),
    '');
  check('助手启动球已贴画布右下且不压「退出画布」',
    canvasSrc.includes('absolute bottom-20 right-6 rounded-full') &&
      !canvasSrc.includes('fixed bottom-6 right-6 rounded-full'),
    '');
  check('画布产物装了 DSH 模型桥（面板的下拉读它）',
    canvasSrc.includes('__FISHERAI_AGENT_MODEL_AVAILABILITY__') &&
      canvasSrc.includes('/api/aifisher/canvas/chat/models'),
    '');
}

// ---------------- vendor 补丁机制 ----------------
{
  const vendorScript = readFileSync(join(ROOT, 'scripts/vendor-aifisher.mjs'), 'utf8');
  check('vendor 脚本含「整文件覆盖」机制（scripts/patches/aifisher/**）',
    vendorScript.includes('scripts/patches/aifisher') && vendorScript.includes('整文件覆盖'),
    '');
  const patchFiles = ['src/stable/media/videoWorkflows.ts',
    'src/stable/nodes/canvasLegacyWorkflowNode.tsx',
    'src/stable/generation/canvasLocalWorkflows.ts'];
  const missing = patchFiles.filter((file) => {
    try {
      readFileSync(join(ROOT, 'scripts/patches/aifisher', file), 'utf8');
      return false;
    } catch {
      return true;
    }
  });
  check('三个覆盖补丁文件都在（清单/节点/运行）', missing.length === 0, missing.join(', ') || '(none)');
  const applied = patchFiles.filter((file) => {
    try {
      return readFileSync(join(ROOT, 'vendor/aifisher', file), 'utf8').includes('dsh-aifisher-canvas 的覆盖补丁');
    } catch {
      return false;
    }
  });
  check('覆盖补丁已真的落到 vendor/aifisher 里', applied.length === patchFiles.length,
    `${applied.length}/${patchFiles.length}`);
}

const pass = lines.filter((l) => l.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
