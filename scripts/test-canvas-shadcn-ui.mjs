/**
 * 画布 shadcn/ui 重设计的结构回归（scripts/test-canvas-shadcn-ui.mjs）。
 *
 * 背景：2026-10-16 把画布「核心操控面」——头部栏 / 左侧工具条 / 缩放控件 / 小地图 ——
 * 换成了 shadcn/ui（nova 风）重绘版。换的方式**不是改 vendor**，而是在装配层
 * （src/client/canvas/stage.tsx）替换 dependencies 槽位，所以这里必须验的是
 * 「产物真的用了新组件 + 结构契约没被破坏」：
 *
 *   1. 头部根元素仍是 `.af-canvas-header` 且贴边定位（browser-check 靠它查越界）；
 *   2. ComfyUI 状态胶囊的停靠契约：`[data-fisherai-account-center-slot]` 是头部工具条
 *      的直接子元素（vendor 的 comfyLogPanel 用 insertBefore 插到它前面）；
 *   3. 左侧工具条的「添加节点」按钮 aria-label 还在 —— browser-check 的
 *      workflow-node 场景就是靠它点开菜单建节点的；
 *   4. 点「添加节点」能弹出画布菜单（`role=menu`），且菜单项仍是 `role=menuitem`
 *      （browser-check 靠 `[role=menuitem]` 找「添加节点 / ComfyUI 工作流」）；
 *   5. shadcn 浮层 portal 回**画布容器内部**（不是 document.body）：
 *      否则浮层读不到画布的 `--af-*` 主题变量，卸载时还会留在 DSH 页面上；
 *   6. 缩放百分比、快捷键说明按钮、小地图 DOM 都还在。
 *
 * 用法：node scripts/test-canvas-shadcn-ui.mjs   （需要先 build）
 */
import {
  createCanvasDom,
  mountCanvasApp,
  seedResume,
  settle,
  startHost,
} from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}

async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await settle(120);
  }
  return last;
}

const PROJECT_ID = 'proj-shadcn-ui';
/**
 * 预置**一个图片节点**而不是空项目：
 *   ① 小地图只在有节点时才渲染（vendor 的 minimapScene 无 frame 就返回 null）；
 *   ② 真机检查里「节点几何」这套断言也依赖有节点。
 */
const SEED_NODE = {
  id: 'node-shadcn-1',
  type: 'Image',
  x: 0,
  y: 0,
  prompt: '界面重设计验证',
  status: 'idle',
  imageModel: '豆包图片5.0-pro(方舟直连)',
  imageMode: 'text-to-image',
  aspectRatio: '16:9',
  resolution: '1K',
  parentIds: [],
  projectId: PROJECT_ID,
  width: 224,
  height: 209,
  generateCount: 1,
  watermark: false,
};
/**
 * 第二个节点：**带结果图的图片节点** —— 图片编辑 / 标注两个入口只在
 * `imageTypes.has(node.type) && node.resultUrl` 时才出现在节点工具条上（v1.26）。
 * 用 1x1 PNG 的 data URL：jsdom 不解码图片，但入口的存在性只看 `resultUrl` 字段。
 */
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const IMAGE_NODE = {
  id: 'node-shadcn-image',
  type: 'Image',
  x: 320,
  y: 0,
  prompt: '图片编辑回归',
  status: 'success',
  imageModel: '豆包图片5.0-pro(方舟直连)',
  imageMode: 'text-to-image',
  aspectRatio: '16:9',
  resolution: '2K',
  parentIds: [],
  projectId: PROJECT_ID,
  width: 224,
  height: 209,
  generateCount: 1,
  watermark: false,
  resultUrl: ONE_PIXEL_PNG,
  resultAspectRatio: '1/1',
};
const host = await startHost();
{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: 'shadcn 界面验证',
    nodes: [SEED_NODE, IMAGE_NODE],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目（含一个节点，小地图才有内容）写入本地后端', save.status === 200,
    String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { container, handle } = await mountCanvasApp(window);
await settle(1500);

// ---------------------------------------------------------------- 1. 头部栏

const header = container.querySelector('.af-canvas-header');
check('头部栏仍带 .af-canvas-header 且已渲染', Boolean(header));
check(
  '头部贴边定位仍是 absolute top-0 left-0（真机越界检查依赖）',
  typeof header?.className === 'string' &&
    header.className.includes('af-canvas-header absolute top-0 left-0'),
  String(header?.className).slice(0, 120),
);
check(
  '头部有「项目菜单」按钮（品牌下拉）',
  Boolean(header?.querySelector('[aria-label="项目菜单"]')),
);
check(
  '头部有项目标题按钮（点击重命名）',
  Boolean(header?.querySelector('[title="点击重命名"]')),
);

/**
 * v1.36 头部左边的两个新件（用户 2026-10-17 原话：
 * 「在画布左上角添加返回项目库按钮；把右上角的 comfui 待启动移动到左边」）。
 *
 * 背景：头部以前没有 z-index、底色类名 `bg-surface` 在主题里根本不存在，
 * 于是被 vendor 的 `#canvas-background`（不透明底、DOM 里排在后面）整块盖住 ——
 * 真机上 logo/项目名/保存状态全看不见也点不到，只剩自带 z-index 的 ComfyUI 胶囊浮着。
 * 这里把「头部必须压在画布之上」钉成结构契约（browser-check 再用 elementFromPoint 真机验）。
 */
check(
  '头部自带 z-index 叠层（z-50：不被画布底盘 #canvas-background 盖住）',
  /\bz-50\b/.test(String(header?.className ?? '')),
  String(header?.className ?? '(none)').slice(0, 160),
);
check(
  '头部底色用的是画布真实存在的新 token（bg-[var(--af-surface)]，不是不存在的 bg-surface）',
  String(header?.className ?? '').includes('bg-[var(--af-surface)]') &&
    !/\bbg-surface\b/.test(String(header?.className ?? '')),
  String(header?.className ?? '(none)').slice(0, 200),
);
check(
  '头部右侧给任务队列让位（padding-right 读 --fisherai-task-queue-inset）',
  String(header?.style?.paddingRight ?? header?.getAttribute('style') ?? '').includes(
    '--fisherai-task-queue-inset',
  ),
  String(header?.getAttribute('style') ?? '(none)'),
);

const backButton = header?.querySelector('[data-fisherai-back-to-library]');
check(
  '头部左边有「返回项目库」按钮（aria-label=返回项目库）',
  Boolean(backButton) && backButton?.getAttribute('aria-label') === '返回项目库',
  String(backButton?.textContent ?? '(none)'),
);
check(
  '「返回项目库」按钮是头部左侧工具条的第一个可交互件（左上一眼可见）',
  Boolean(backButton) &&
    backButton === header?.querySelector('button, [data-slot="button"]'),
  String(backButton?.className ?? '(none)').slice(0, 120),
);

const comfySlot = header?.querySelector('[data-fisherai-comfyui-slot="true"]');
check('头部左侧有 ComfyUI 胶囊的停靠槽位（data-fisherai-comfyui-slot）', Boolean(comfySlot));
check(
  '左侧槽位在头部**左半边**（胶囊从右上角移到左边）',
  Boolean(comfySlot) &&
    Boolean(header) &&
    comfySlot.getBoundingClientRect().left < header.getBoundingClientRect().left + 240,
  comfySlot ? String(comfySlot.className) : '(none)',
);
check(
  '左侧槽位的父节点就是头部左侧工具条（vendor 用 slot.append(host) 停靠）',
  Boolean(comfySlot) &&
    comfySlot.parentElement !== header &&
    comfySlot.parentElement?.parentElement === header,
  comfySlot?.parentElement ? String(comfySlot.parentElement.className).slice(0, 120) : '(none)',
);

// 停靠契约：账号插槽必须是头部右侧工具条的直接子元素
const slot = header?.querySelector('[data-fisherai-account-center-slot="true"]');
const toolbar = slot?.parentElement;
check('头部仍有 ComfyUI 胶囊的停靠槽位（data-fisherai-account-center-slot）', Boolean(slot));
check(
  '槽位的父节点就是头部工具条（vendor 用 insertBefore 插到这个位置）',
  Boolean(toolbar) && toolbar !== header && toolbar?.parentElement === header,
  toolbar ? String(toolbar.className).slice(0, 120) : '(none)',
);

// 保存状态换成 shadcn Badge
const statusBadge = header?.querySelector('[data-slot="badge"]');
check('保存状态渲染为 shadcn Badge（data-slot=badge）', Boolean(statusBadge),
  String(statusBadge?.textContent ?? '(none)'));
check(
  '保存状态文案仍是中文可读的（尚未保存 / 未保存 / 保存中 / 已保存）',
  /尚未保存|未保存|保存中|已保存/.test(String(statusBadge?.textContent ?? '')),
  String(statusBadge?.textContent ?? '(none)'),
);

// ---------------------------------------------------------------- 2. 左侧工具条

const rail = container.querySelector('[role="toolbar"][aria-label="画布工具"]');
check('左侧工具条（role=toolbar / aria-label=画布工具）已渲染', Boolean(rail));
check(
  '工具条定位仍是 absolute left-4 top-1/2（真机断言同款定位）',
  typeof rail?.className === 'string' && rail.className.includes('absolute left-4 top-1/2'),
  String(rail?.className).slice(0, 120),
);
const addButton = rail?.querySelector('button[aria-label="添加节点"]');
check('工具条有「添加节点」按钮（真机建节点场景的入口）', Boolean(addButton));
for (const label of ['资产', '工作流节点', 'ComfyUI 工作流配置', '历史', '设置', '搜索节点']) {
  check(`工具条有「${label}」按钮`, Boolean(rail?.querySelector(`button[aria-label="${label}"]`)));
}
// v1.16：原来的「SKILL 社区」入口换成「ComfyUI 工作流配置」（用户截图要求），旧的不能留
check(
  '工具条里已经没有「SKILL 社区」入口（v1.16 被 ComfyUI 工作流配置替换）',
  !rail?.querySelector('button[aria-label="SKILL 社区"]') &&
    !rail?.querySelector('[data-fisherai-skill-community-trigger]'),
);
check(
  '「ComfyUI 工作流配置」用的是独立触发属性（面板靠它被唤起 / 真机检查靠它找按钮）',
  Boolean(rail?.querySelector('[data-fisherai-workflow-config-trigger]')),
);
check(
  '「搜索节点」按钮与「添加节点」是两个独立按钮（真机靠 aria-label=添加节点 找菜单入口）',
  addButton !== rail?.querySelector('button[aria-label="搜索节点"]') &&
    Boolean(rail?.querySelector('[data-fisherai-node-search-trigger]')),
);

// ---------------------------------------------------------------- 3. 点开菜单（真交互）

{
  addButton?.click();
  const menu = await waitFor(async () => container.querySelector('[role="menu"]'), 5000);
  check('点「添加节点」弹出画布菜单（role=menu）', Boolean(menu),
    String(menu?.getAttribute('aria-label') ?? '(none)'));
  check(
    '菜单项仍是 role=menuitem（真机 workflow-node 场景靠它选类型）',
    Boolean(menu?.querySelector('[role="menuitem"]')),
  );
  const labels = menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent) : [];
  check(
    '主菜单有「上传 / 添加资产 / 添加节点 / 撤销 / 重做 / 粘贴」',
    ['上传', '添加资产', '添加节点', '撤销', '重做', '粘贴'].every((label) =>
      labels.some((text) => String(text).includes(label)),
    ),
    labels.join(' | ').slice(0, 200),
  );

  // 真机 workflow-node 场景的路径：主菜单点「添加节点」→ 子菜单里选「ComfyUI 工作流」
  const addNodeItem = menu
    ? [...menu.querySelectorAll('[role="menuitem"]')].find((n) =>
        String(n.textContent).includes('添加节点'),
      )
    : null;
  check('主菜单能点开「添加节点」子菜单', Boolean(addNodeItem));
  addNodeItem?.click();
  const submenu = await waitFor(async () => {
    const items = [...container.querySelectorAll('[role="menuitem"]')].map((n) => String(n.textContent));
    return items.some((text) => text.includes('ComfyUI 工作流')) ? items : null;
  }, 5000);
  check(
    '子菜单里有「ComfyUI 工作流」入口（真机靠它建节点）',
    Array.isArray(submenu),
    Array.isArray(submenu) ? submenu.join(' | ').slice(0, 200) : '(none)',
  );

  // 关掉菜单，免得影响后续断言
  window.document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await settle(200);
}

// ---------------------------------------------------------------- 4. shadcn 浮层 portal 位置

{
  const trigger = header?.querySelector('[aria-label="项目菜单"]');
  trigger?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  trigger?.click();
  const content = await waitFor(
    async () => window.document.querySelector('[data-slot="dropdown-menu-content"]'),
    5000,
  );
  check('项目菜单能打开（shadcn DropdownMenu 渲染出 data-slot=dropdown-menu-content）',
    Boolean(content));
  check(
    'shadcn 浮层 portal 到画布容器内部（而不是 document.body）',
    Boolean(content) && container.contains(content),
    content ? (container.contains(content) ? 'inside-canvas' : 'outside-canvas') : '(none)',
  );
  const items = content ? [...content.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent) : [];
  // v1.42：原来那项叫「导入项目 JSON」（直接弹 vendor 的隐藏 file input），
  // 现在统一收进「项目归档」面板（导出/导入并排，导入完有回执）。
  for (const label of ['保存', '项目归档', '退出项目']) {
    check(`项目菜单里有「${label}」`, items.some((text) => String(text).includes(label)),
      items.join(' | ').slice(0, 160));
  }
  window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(200);
}

// ---------------------------------------------------------------- 5. 缩放控件 / 小地图

{
  const zoomBar = container.querySelector('.absolute.bottom-6.left-6');
  check('左下缩放控制条已渲染（保留 absolute bottom-6 left-6 定位）', Boolean(zoomBar),
    String(zoomBar?.className ?? '(none)').slice(0, 120));
  check('缩放条里有「打开/关闭小地图」按钮',
    Boolean(zoomBar?.querySelector('[aria-label="打开小地图"], [aria-label="关闭小地图"]')));
  check('缩放条里有「显示所有节点」按钮',
    Boolean(zoomBar?.querySelector('[aria-label="显示所有节点"]')));
  const slider = zoomBar?.querySelector('[data-slot="slider"]');
  check('缩放滑杆是 shadcn Slider（data-slot=slider）', Boolean(slider));
  check('缩放百分比有显示（xx%）', /\d+%/.test(String(zoomBar?.textContent ?? '')),
    String(zoomBar?.textContent ?? '(none)'));
  check('小地图 DOM 已渲染（data-fisherai-minimap）',
    Boolean(container.querySelector('[data-fisherai-minimap]')));
  check('小地图视口框已渲染（data-fisherai-minimap-viewport）',
    Boolean(container.querySelector('[data-fisherai-minimap-viewport]')));
  check('快捷键说明按钮在（aria-label=快捷键说明）',
    Boolean(container.querySelector('[aria-label="快捷键说明"]')));

  // ---------------------------------------------------------------- 5.1 滑杆真的能缩（单位契约）
  //
  // 2026-10-17 用户报障：「这里的滑轮用不了」（附滑杆放大截图）。根因是**单位串了**：
  // 滑杆是百分比刻度（5..500），而 vendor 的 onSliderZoom 吃的是缩放倍率（0.05..5，
  // sliderViewport 里 `Math.min(5, Math.max(0.05, value))`）—— 以前把 100 当倍率传进去，
  // 被 clamp 成 5 → 500%，滑杆永远钉在最右端、拖也拖不动。
  //
  // 这条断言走的是**完整链路**（Radix 的键盘处理 → zoomFromSlider → vendor handleSliderZoom
  // → viewport 状态 → 百分比读数 + 真 transform），所以单位再串一次就必红。
  // jsdom 里拖拽（pointer capture）不可靠，键盘步进是同一套 onValueChange 路径。
  {
    const zoomValue = () => {
      const node = zoomBar?.querySelector('[data-fisherai-zoom-value]');
      return node ? Number(node.getAttribute('data-fisherai-zoom-value')) : null;
    };
    const readScale = () => {
      const layer = container.querySelector('#canvas-viewport-content');
      const matched = String(layer?.style.transform ?? '').match(/scale\(([-\d.]+)\)/);
      return matched ? Number(matched[1]) : null;
    };
    const percentButton = [...(zoomBar?.querySelectorAll('button') ?? [])]
      .find((node) => /^\d+%$/.test(String(node.textContent ?? '').trim()));
    percentButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(200);
    const base = zoomValue();
    check('点百分比按钮回到 100%', base === 100, `zoom=${base} scale=${readScale()}`);

    const thumb = slider?.querySelector('[data-slot="slider-thumb"]');
    thumb?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    thumb?.dispatchEvent(new window.FocusEvent('focus', { bubbles: false }));
    thumb?.focus?.();
    thumb?.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    await settle(200);
    const stepped = zoomValue();
    check(
      '滑杆按方向键 → 缩放按 5% 步进（100%→105%），不是 500%',
      stepped === 105,
      `zoom=${stepped}`,
    );
    check(
      '百分比读数是缩放倍率的百分比（105% ↔ transform scale 1.05）',
      Math.abs((readScale() ?? 0) - 1.05) < 0.011,
      `scale=${readScale()}`,
    );
    percentButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(150);
  }
}

// ---------------------------------------------------------------- 5.5 节点搜索（Shift+A）

{
  const background = window.document.getElementById('canvas-background');
  background?.dispatchEvent(
    new window.MouseEvent('pointermove', { bubbles: true, clientX: 240, clientY: 180 }),
  );
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true }),
  );
  const searchPanel = await waitFor(
    async () => window.document.querySelector('[data-fisherai-node-search-panel]'),
    3000,
  );
  check('Shift+A 在弹出的搜索面板（data-fisherai-node-search-panel）', Boolean(searchPanel));
  check('搜索面板有输入框（aria-label=搜索节点）',
    Boolean(searchPanel?.querySelector('[aria-label="搜索节点"]')));
  check('搜索面板在画布容器里（portal 到画布，而不是 DSH 页面）',
    Boolean(searchPanel && container.contains(searchPanel)));
  check('候选列表有节点类型与 ComfyUI 工作流两组',
    Boolean(searchPanel?.querySelector('[data-command-id="type:Image"]')) &&
      Boolean(searchPanel?.querySelector('[data-command-group="ComfyUI 工作流"]')),
    String([...(searchPanel?.querySelectorAll('[data-command-id]') ?? [])]
      .map((item) => item.getAttribute('data-command-id'))
      .join(',')));
  searchPanel
    ?.querySelector('[data-fisherai-node-search-input]')
    ?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle(150);
  check('Esc 关闭搜索面板', !window.document.querySelector('[data-fisherai-node-search-panel]'));
}

// ---------------------------------------------------------------- 5.6 图片编辑 / 标注（v1.26）

/**
 * 用户 2026-10-17 报障两件：「点击保存为新图片没有添加到画布里」+「图像编辑的 ui 美化还没有补全」。
 *
 * 第一件是 host 的 405（`POST /api/aifisher/canvas/assets/images` 被列表分支吞掉），
 * 回归在 scripts/test-canvas-generation.mjs 的 4.1 段（走的是真 HTTP 链路）。
 * 这里守第二件的**结构契约**：图片编辑/标注换成了 canvas-ui 里的 nova 版，
 * 入口、工具、保存按钮、portal 位置、以及「vendor 那套 `.af-image-studio` 不再出现」。
 *
 * jsdom 不解码图片（Image 不触发 load、canvas.getContext 为 null），所以只验 DOM 契约；
 * 视觉与真交互在 scripts/browser-check.mjs 的 image-editor 场景里量。
 */
{
  const imageNode = () => container.querySelector('[data-node-id="node-shadcn-image"]');
  check('预置的「带结果图的图片节点」已渲染', Boolean(imageNode()));
  const selectNode = async () => {
    const element = imageNode();
    if (!element) return false;
    const options = {
      bubbles: true,
      cancelable: true,
      clientX: 340,
      clientY: 40,
      button: 0,
      buttons: 1,
      pointerId: 7,
      pointerType: 'mouse',
      isPrimary: true,
    };
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'])
      element.dispatchEvent(new window.MouseEvent(type, options));
    return (await waitFor(async () => element.getAttribute('data-node-selected') === 'true')) === true;
  };
  check('图片节点能选中（工具条只在选中态渲染）', await selectNode(),
    String(imageNode()?.getAttribute('data-node-selected')));

  const toolbar = await waitFor(async () => container.querySelector('[data-fisherai-media-toolbar]'), 8000);
  check('选中后出现节点媒体工具条（data-fisherai-media-toolbar）', Boolean(toolbar));
  check('工具条里有「图片编辑」入口（v1.26 起打开 nova 版工作台）',
    Boolean(toolbar?.querySelector('button[aria-label="图片编辑"]')));
  check('工具条里有「标注」入口（v1.26 起打开 nova 版标注器）',
    Boolean(toolbar?.querySelector('button[aria-label="标注"]')));
  // 宫格裁剪（v1.46 起 nova 版）/ 全景 / 角度仍各自走自己的实现，入口必须还在
  for (const label of ['宫格裁剪', '全景图', '角度', '尺寸']) {
    check(`工具条里「${label}」入口仍在`, Boolean(toolbar?.querySelector(`button[aria-label="${label}"]`)));
  }
  // v1.38：AI 高清放大（SeedVR2 / RunningHub）整块移除，原位置换成「扩图」
  check('工具条里已经没有了「AI 高清放大」（v1.38 换成扩图）',
    !toolbar?.querySelector('button[aria-label="AI 高清放大"]'));
  check('工具条里「扩图」入口在（data-fisherai-outpaint-trigger）',
    Boolean(toolbar?.querySelector('[data-fisherai-outpaint-trigger="true"]')));

  // ---- 图片编辑（Crop 槽位 = CanvasImageStudio）----
  toolbar?.querySelector('button[aria-label="图片编辑"]')?.click();
  const studio = await waitFor(async () =>
    container.querySelector('[data-fisherai-image-studio="editor"]'), 8000);
  check('「图片编辑」打开 nova 版工作台（data-fisherai-image-studio=editor）', Boolean(studio));
  check('工作台是 role=dialog + aria-label=图片编辑',
    studio?.getAttribute('role') === 'dialog' && studio?.getAttribute('aria-label') === '图片编辑',
    `${studio?.getAttribute('role')} / ${studio?.getAttribute('aria-label')}`);
  check('工作台 portal 在画布容器里（不是 document.body）',
    Boolean(studio && container.contains(studio)),
    studio ? (container.contains(studio) ? 'inside-canvas' : 'outside-canvas') : '(none)');
  check('vendor 的旧图片编辑界面不再出现（没有 .af-image-studio）',
    !container.querySelector('.af-image-studio'));
  for (const tool of ['crop', 'mask', 'brush', 'compose']) {
    check(`工作台有「${tool}」工具按钮`,
      Boolean(studio?.querySelector(`[data-fisherai-image-tool="${tool}"]`)));
  }
  check('工具按钮是 shadcn Button（data-slot=button）',
    studio?.querySelector('[data-fisherai-image-tool="crop"]')?.getAttribute('data-slot') === 'button');
  check('只有一个图片节点时「组合」不可点（没有素材可叠）',
    studio?.querySelector('[data-fisherai-image-tool="compose"]')?.disabled === true);
  const studioSave = () => studio?.querySelector('[data-fisherai-image-save="studio"]');
  check('「保存为新图片」按钮在（aria-label 与文案一致）',
    studioSave()?.getAttribute('aria-label') === '保存为新图片' &&
      String(studioSave()?.textContent ?? '').includes('保存为新图片'),
    String(studioSave()?.textContent ?? '(none)'));
  check('还没应用编辑时「保存为新图片」是禁用态（与 vendor 语义一致）',
    studioSave()?.disabled === true);
  for (const label of ['撤销编辑', '重做编辑', '关闭图片编辑']) {
    check(`工作台有「${label}」按钮`, Boolean(studio?.querySelector(`[aria-label="${label}"]`)));
  }
  check('工作台有尺寸/版本读数（data-fisherai-image-dimensions）',
    Boolean(studio?.querySelector('[data-fisherai-image-dimensions]')));
  check('工作台有状态行（data-fisherai-image-status）',
    Boolean(studio?.querySelector('[data-fisherai-image-status]')));

  // 进「蒙版」：同一套标注舞台（initialMask），保存文案是「应用编辑」
  studio?.querySelector('[data-fisherai-image-tool="mask"]')?.click();
  const maskStage = await waitFor(async () =>
    container.querySelector('[data-fisherai-image-workbench="annotation"]'), 8000);
  check('「蒙版」打开标注舞台（data-fisherai-image-workbench=annotation）', Boolean(maskStage));
  check('标注舞台 portal 在画布容器里', Boolean(maskStage && container.contains(maskStage)));
  for (const tool of ['brush', 'eraser', 'rectangle', 'circle', 'arrow', 'line']) {
    check(`标注舞台有「${tool}」工具`,
      Boolean(maskStage?.querySelector(`[data-fisherai-annotation-tool="${tool}"]`)));
  }
  check('标注绘制区 canvas 在（aria-label=标注绘制区域）',
    maskStage?.querySelector('[data-fisherai-annotation-canvas]')?.getAttribute('aria-label') ===
      '标注绘制区域');
  check('标注舞台的保存按钮是「应用编辑」',
    maskStage?.querySelector('[data-fisherai-image-save="annotation"]')?.getAttribute('aria-label') ===
      '应用编辑' &&
      String(maskStage?.querySelector('[data-fisherai-image-save="annotation"]')?.textContent ?? '')
        .includes('应用编辑'));
  for (const label of ['撤销标注', '重做标注', '清除标注']) {
    check(`标注舞台有「${label}」按钮`, Boolean(maskStage?.querySelector(`[aria-label="${label}"]`)));
  }
  check('标注舞台有粗细/不透明度滑杆（shadcn Slider）',
    maskStage?.querySelectorAll('[data-slot="slider"]').length === 2,
    String(maskStage?.querySelectorAll('[data-slot="slider"]').length));
  check('标注舞台有 8 个常用色 + 自定义取色',
    maskStage?.querySelectorAll('[data-fisherai-annotation-color]').length === 8 &&
      Boolean(maskStage?.querySelector('input[aria-label="自定义颜色"]')),
    String(maskStage?.querySelectorAll('[data-fisherai-annotation-color]').length));
  check('studio 里的蒙版舞台不显示「标准/遮罩」切换（模式由工具决定）',
    maskStage?.querySelectorAll('[data-fisherai-annotation-mask]').length === 0);

  // ✕ 回到图片编辑（不是关掉整个工作台）
  const maskClose = maskStage?.querySelector('[aria-label="关闭标注"]');
  check('蒙版舞台有「关闭标注」按钮（返回图片编辑首页）', Boolean(maskClose));
  maskClose?.click();
  await settle(200);
  check('关掉蒙版舞台后回到图片编辑首页',
    Boolean(container.querySelector('[data-fisherai-image-studio="editor"]')) &&
      !container.querySelector('[data-fisherai-image-workbench="annotation"]'));

  // 保存按钮的文案在保存中会变（这里只验「禁用时文案仍是保存为新图片」）
  check('工作台保存按钮文案是「保存为新图片」',
    String(studio?.querySelector('[data-fisherai-image-save="studio"]')?.textContent ?? '').includes('保存为新图片'));

  // ---- 「标注」入口：独立标注器（带标准/遮罩切换）----
  toolbar?.querySelector('button[aria-label="标注"]')?.click();
  const annotation = await waitFor(async () =>
    container.querySelector('[data-fisherai-image-workbench="annotation"]'), 8000);
  check('「标注」打开 nova 版标注器', Boolean(annotation));
  check('独立标注器有「标准 / 遮罩」切换（data-fisherai-annotation-mask）',
    annotation?.querySelectorAll('[data-fisherai-annotation-mask]').length === 2,
    String(annotation?.querySelectorAll('[data-fisherai-annotation-mask]').length));
  check('独立标注器保存文案默认「保存」',
    String(annotation?.querySelector('[data-fisherai-image-save="annotation"]')?.textContent ?? '')
      .includes('保存'));
  annotation?.querySelector('[aria-label="关闭标注"]')?.click();
  await settle(200);
  check('关掉标注器后舞台消失',
    !container.querySelector('[data-fisherai-image-workbench="annotation"]'));
  // 关掉工作台（标注器与工作台是两块独立的 dialog，这里确保它不残留）
  container
    .querySelector('[data-fisherai-image-studio="editor"] [aria-label="关闭图片编辑"]')
    ?.click();
  await settle(200);
  check('关掉图片编辑后工作台消失',
    !container.querySelector('[data-fisherai-image-studio="editor"]'));

  // ---- 宫格裁剪：v1.46 起是 nova 版宫格舞台（几何/切线/导出仍复用 vendor 纯函数）----
  //
  // ⚠️ 这里必须**重新选中 + 重新查一次**工具条：上面开关过两块 dialog，节点可能已经失焦、
  //    节点卡那棵子树也被重渲染过，早先拿到的 `toolbar` 引用会脱离文档（点它没反应）。
  await selectNode();
  const gridBar = await waitFor(
    async () => container.querySelector('[data-fisherai-media-toolbar]'),
    8000,
  );
  const gridButton = gridBar?.querySelector('button[aria-label="宫格裁剪"]');
  check('重新选中后「宫格裁剪」按钮还在工具条里', Boolean(gridButton));
  gridButton?.click();
  const gridStage = await waitFor(
    async () => container.querySelector('[data-fisherai-image-workbench="grid"]'),
    8000,
  );
  check('「宫格裁剪」打开 nova 版宫格舞台（data-fisherai-image-workbench=grid）',
    Boolean(gridStage));
  check('宫格舞台是 role=dialog + aria-label=宫格裁剪',
    gridStage?.getAttribute('role') === 'dialog' &&
      gridStage?.getAttribute('aria-label') === '宫格裁剪',
    `${gridStage?.getAttribute('role')} / ${gridStage?.getAttribute('aria-label')}`);
  check('宫格舞台 portal 在画布容器里（不是 document.body）',
    Boolean(gridStage && container.contains(gridStage)));
  check('vendor 那套旧裁剪器没有一起渲染出来（没有 role=dialog[aria-label=裁切图片]）',
    !window.document.querySelector('[role="dialog"][aria-label="裁切图片"]'));
  check('宫格舞台有选区画布（data-fisherai-crop-canvas）',
    Boolean(gridStage?.querySelector('[data-fisherai-crop-canvas]')));
  const gridPresets = [...(gridStage?.querySelectorAll('[data-fisherai-grid-crop-preset]') ?? [])];
  check('宫格舞台有 6 个宫格预设（2x2/3x3/3x4/4x3/1x4/4x1）',
    gridPresets.length === 6 &&
      ['2x2', '3x3', '3x4', '4x3', '1x4', '4x1'].every((id) =>
        gridPresets.some((node) => node.getAttribute('data-fisherai-grid-crop-preset') === id)),
    String(gridPresets.map((node) => node.getAttribute('data-fisherai-grid-crop-preset')).join(',')));
  check('默认选中 2×2 预设（aria-pressed）',
    gridStage?.querySelector('[data-fisherai-grid-crop-preset="2x2"]')?.getAttribute('aria-pressed') ===
      'true');
  check('宫格舞台有横向 / 竖向分割读数（默认 2 × 2）',
    gridStage?.querySelector('[data-fisherai-grid-crop-columns]')?.textContent === '2' &&
      gridStage?.querySelector('[data-fisherai-grid-crop-rows]')?.textContent === '2',
    `${gridStage?.querySelector('[data-fisherai-grid-crop-columns]')?.textContent} / ${gridStage?.querySelector('[data-fisherai-grid-crop-rows]')?.textContent}`);
  for (const label of ['减少横向分割', '增加横向分割', '减少竖向分割', '增加竖向分割', '恢复等分']) {
    check(`宫格舞台有「${label}」按钮`, Boolean(gridStage?.querySelector(`[aria-label="${label}"]`)));
  }
  check('宫格舞台有两个间隙滑杆（shadcn Slider：上下 / 左右）',
    gridStage?.querySelectorAll('[data-slot="slider"]').length === 2 &&
      Boolean(gridStage?.querySelector('[data-fisherai-grid-crop-row-gap]')) &&
      Boolean(gridStage?.querySelector('[data-fisherai-grid-crop-column-gap]')),
    String(gridStage?.querySelectorAll('[data-slot="slider"]').length));
  check('宫格舞台有 7 个裁切比例按钮',
    gridStage?.querySelectorAll('[data-fisherai-grid-crop-ratio]').length === 7,
    String(gridStage?.querySelectorAll('[data-fisherai-grid-crop-ratio]').length));
  check('宫格舞台有 4 个导出顺序（逐行 / 逐列 / 蛇形 / 倒序）',
    gridStage?.querySelectorAll('[data-fisherai-grid-crop-order]').length === 4 &&
      ['row', 'column', 'snake', 'reverse'].every((value) =>
        Boolean(gridStage?.querySelector(`[data-fisherai-grid-crop-order="${value}"]`))),
    String(gridStage?.querySelectorAll('[data-fisherai-grid-crop-order]').length));
  check('默认导出顺序是逐行（aria-pressed）',
    gridStage?.querySelector('[data-fisherai-grid-crop-order="row"]')?.getAttribute('aria-pressed') ===
      'true');
  const exportInput = gridStage?.querySelector('[data-fisherai-grid-crop-selection]');
  check('宫格舞台有导出序号输入框（aria-label=导出格子序号）',
    exportInput?.getAttribute('aria-label') === '导出格子序号' &&
      exportInput?.getAttribute('placeholder') === '全部 / 1,3,5-8');
  check('宫格舞台有张数读数（默认 2×2 = 4 格）',
    String(gridStage?.querySelector('[data-fisherai-grid-crop-count]')?.textContent ?? '').includes(
      '4 格',
    ),
    String(gridStage?.querySelector('[data-fisherai-grid-crop-count]')?.textContent ?? ''));
  check('宫格舞台有单格尺寸读数',
    Boolean(gridStage?.querySelector('[data-fisherai-grid-crop-cell]')));
  const gridSave = gridStage?.querySelector('[data-fisherai-image-save="grid"]');
  check('宫格保存按钮在（aria-label=保存宫格裁剪，文案带张数）',
    gridSave?.getAttribute('aria-label') === '保存宫格裁剪' &&
      String(gridSave?.textContent ?? '').includes('保存 4 张'),
    String(gridSave?.textContent ?? '(none)'));
  check('图片没加载完时宫格保存是禁用态（与裁剪舞台同一口径）', gridSave?.disabled === true);
  check('宫格舞台没有出现 vendor 的旧工具条（原生 select / 恢复等分文案以外的旧控件）',
    gridStage?.querySelectorAll('select').length === 0,
    String(gridStage?.querySelectorAll('select').length));
  // activateModal 的 Esc 契约：整块舞台关掉（回到画布）
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await settle(250);
  check('Esc 关闭宫格舞台',
    !container.querySelector('[data-fisherai-image-workbench="grid"]'));
}

// ---------------------------------------------------------------- 5.7 尺寸对话框（v1.38，nova 版）

/** 重新选中那个带结果图的节点（5.7 / 5.8 共用；早先的 toolbar 引用可能已脱离文档）。 */
const selectToolbarImageNode = async () => {
  const element = container.querySelector('[data-node-id="node-shadcn-image"]');
  if (!element) return false;
  const options = {
    bubbles: true,
    cancelable: true,
    clientX: 340,
    clientY: 40,
    button: 0,
    buttons: 1,
    pointerId: 13,
    pointerType: 'mouse',
    isPrimary: true,
  };
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'])
    element.dispatchEvent(new window.MouseEvent(type, options));
  return (
    (await waitFor(async () => element.getAttribute('data-node-selected') === 'true', 4000)) === true
  );
};

/**
 * 用户原话（2026-10-17）：「尺寸节点的ui还没有更新」。
 *
 * 上游那套是**整屏**的浮层（fixed inset-0 + 原生 range + 裸按钮），与 v1.26 之后
 * 图片编辑族（工作台 / 裁剪 / 标注）不是一套视觉语言。这一版换成 nova 的紧凑卡片，
 * 像素语义（等比换算 / 上限 / 保存为新图片）仍走 vendor 纯函数与 `saveResize`。
 *
 * jsdom 不解码图片（`new Image()` 不触发 load），所以这里只验**结构契约**：
 * 入口、portal 位置、四个输入、快捷倍率、保存按钮（禁用态）、尺寸读数、关闭。
 * 真机的换算与落盘在 scripts/browser-check.mjs 的 `resize` 场景里量。
 */
{
  // 前面的对话框开关过，早先的 toolbar 引用可能已经脱离文档 —— 重新选中再取一次
  await selectToolbarImageNode();
  const bar = await waitFor(async () => container.querySelector('[data-fisherai-media-toolbar]'), 8000);
  const resizeButton = bar?.querySelector('button[aria-label="尺寸"]');
  check('工具条里「尺寸」入口还在', Boolean(resizeButton));
  resizeButton?.click();
  const dialog = await waitFor(
    async () => container.querySelector('[data-fisherai-image-resize="true"]'),
    8000,
  );
  check('「尺寸」打开 nova 版对话框（data-fisherai-image-resize）', Boolean(dialog));
  check('尺寸对话框是 role=dialog + aria-label=调整图片尺寸',
    dialog?.getAttribute('role') === 'dialog' && dialog?.getAttribute('aria-label') === '调整图片尺寸',
    `${dialog?.getAttribute('role')}/${dialog?.getAttribute('aria-label')}`);
  check('尺寸对话框 portal 在画布容器里（不是 document.body）',
    Boolean(dialog && container.contains(dialog)));
  check('同一时刻只有一个「调整图片尺寸」节点（vendor 那套整屏浮层没有一起渲染出来）',
    window.document.querySelectorAll('[aria-label="调整图片尺寸"]').length === 1,
    String(window.document.querySelectorAll('[aria-label="调整图片尺寸"]').length));
  for (const label of ['图片缩放滑块', '图片缩放倍数', '图片宽度', '图片高度']) {
    check(`尺寸对话框有「${label}」输入`, Boolean(dialog?.querySelector(`[aria-label="${label}"]`)));
  }
  check('尺寸对话框有 4 个快捷倍率（0.5/1/2/4）',
    dialog?.querySelectorAll('[data-fisherai-resize-preset]').length === 4,
    String(dialog?.querySelectorAll('[data-fisherai-resize-preset]').length));
  check('快捷倍率是 shadcn Button（data-slot=button）',
    dialog?.querySelector('[data-fisherai-resize-preset="2"]')?.getAttribute('data-slot') === 'button');
  check('尺寸对话有「原图 → 目标」读数（data-fisherai-resize-dimensions）',
    Boolean(dialog?.querySelector('[data-fisherai-resize-dimensions]')));
  const resizeSave = () => dialog?.querySelector('[data-fisherai-image-save="resize"]');
  check('尺寸对话框的保存按钮在（aria-label=保存尺寸图片）',
    resizeSave()?.getAttribute('aria-label') === '保存尺寸图片' &&
      String(resizeSave()?.textContent ?? '').includes('保存尺寸图片'),
    String(resizeSave()?.textContent ?? '(none)'));
  check('图片没加载完时保存是禁用态（jsdom 不解码图片 —— 真机由 browser-check 量）',
    resizeSave()?.disabled === true,
    `disabled=${resizeSave()?.disabled}`);
  check('图片没加载完时状态行显示「正在载入图片…」',
    String(dialog?.querySelector('[data-fisherai-resize-status]')?.textContent ?? '').includes('正在载入'),
    String(dialog?.querySelector('[data-fisherai-resize-status]')?.textContent ?? '(none)'));
  dialog?.querySelector('[aria-label="关闭尺寸"]')?.click();
  await settle(200);
  check('点 ✕ 关闭尺寸对话框',
    !container.querySelector('[data-fisherai-image-resize="true"]'));
}

// ---------------------------------------------------------------- 5.8 扩图面板（v1.38 起，v1.39 结构契约）

/**
 * 用户原话（2026-10-17 v1.38）：「把这个功能移除，替换成扩图功能……点击生成后不直接生图，
 * 先输出一个空的图像生成节点，填好提示词，由我来点击最后的生成」。
 * 用户原话（v1.39，附参考图）：「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」。
 *
 * 这里只验**面板本身的结构**（九宫格位置 / 比例 / 延展内容 / 预览 / 主按钮）；
 * 「点一下 → 真的先落一张扩图画面、再接一个空节点、一条生成请求都不发」那条在
 * `scripts/test-canvas-outpaint.mjs` 里真点真查后端文档。
 */
{
  const bar = await waitFor(async () => container.querySelector('[data-fisherai-media-toolbar]'), 8000);
  const trigger = bar?.querySelector('[data-fisherai-outpaint-trigger="true"]');
  check('工具条里「扩图」按钮在（data-fisherai-outpaint-trigger）', Boolean(trigger));
  trigger?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const panel = await waitFor(
    async () => container.querySelector('[data-fisherai-outpaint-panel="true"]'),
    8000,
  );
  check('点「扩图」打开面板（role=dialog + aria-label=扩图）', Boolean(panel));
  check('扩图面板里有 9 格「原图位置」（data-fisherai-outpaint-anchor）',
    panel?.querySelectorAll('[data-fisherai-outpaint-anchor]').length === 9,
    String(panel?.querySelectorAll('[data-fisherai-outpaint-anchor]').length));
  check('「原图位置」是一组可访问的开关（aria-pressed + aria-label=原图位置 居中）',
    panel?.querySelector('[data-fisherai-outpaint-anchor="center"]')?.getAttribute('aria-pressed') ===
      'true' &&
      panel?.querySelector('[data-fisherai-outpaint-anchor="center"]')?.getAttribute('aria-label') ===
        '原图位置 居中',
    String(panel?.querySelector('[data-fisherai-outpaint-anchor="center"]')?.getAttribute('aria-label')));
  check('扩图面板里有「延展内容」输入框（可空）',
    Boolean(panel?.querySelector('[data-fisherai-outpaint-content]')));
  check('扩图面板里有扩图画面预览（预览 + 里面的原图）',
    Boolean(panel?.querySelector('[data-fisherai-outpaint-preview="true"]')) &&
      Boolean(panel?.querySelector('[data-fisherai-outpaint-preview-image="true"]')));
  check('扩图面板里有「生成扩图画面」按钮',
    panel?.querySelector('[data-fisherai-outpaint-create="true"]')?.getAttribute('aria-label') ===
      '生成扩图画面');
  check('扩图面板写明「先出画面、再接生成节点、生成由你点」',
    String(panel?.textContent ?? '').includes('先出扩图画面') &&
      String(panel?.textContent ?? '').includes('生成由你点'),
    String(panel?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 50));
  check('扩图面板显示模型读数（data-fisherai-outpaint-model-name）',
    Boolean(panel?.querySelector('[data-fisherai-outpaint-model-name]')));
  panel?.querySelector('[aria-label="关闭扩图"]')?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await settle(150);
  check('点 ✕ 关闭扩图面板',
    !container.querySelector('[data-fisherai-outpaint-panel="true"]'));
}

// ---------------------------------------------------------------- 5.9 返回项目库（v1.36，真点）

/**
 * 用户原话「在画布左上角添加返回项目库按钮」。按钮必须**真的能回到项目列表** ——
 * 不是只画一个箭头。走的是 vendor 的 `onBack = backToProjects`（view → 'dashboard'），
 * 所以断言「点完头部消失 + 看板文案出现」。
 *
 * 放在最后一步跑：回看板会换掉整棵视图树，前面的断言已经全部量完。
 */
{
  const back = container.querySelector('[data-fisherai-back-to-library]');
  check('返回前头部还在（点击前状态正常）', Boolean(container.querySelector('.af-canvas-header')));
  back?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  /**
   * v1.84：这个按钮从「onBack() 退出画布」改成打开页面层项目库（用户 2026-10-30 要的
   * 「项目管理页」）。看板那条路仍然存在（品牌下拉 → 退出项目），B7 在
   * test-project-archive.mjs 里验；这里只验新行为 + Esc 回来。
   */
  const page = await waitFor(async () => window.document.querySelector('[data-fisherai-page="projects"]'), 8000);
  check(
    '点「返回项目库」打开页面层项目库（v1.84）',
    Boolean(page) && Boolean(page?.querySelector('.afg-top')) && /新建项目/.test(String(page?.textContent ?? '')),
    String(page?.querySelector('.afg-crumb-title')?.textContent ?? '(none)'),
  );
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(240);
  check(
    'Esc 关掉项目库后回到画布（头部还在）',
    Boolean(container.querySelector('.af-canvas-header')) && !window.document.querySelector('[data-fisherai-page]'),
  );
}

// ---------------------------------------------------------------- 6. 卸载不残留

{
  handle.dispose();
  await settle(200);
  check('卸载后 shadcn 浮层不残留在 DSH 页面上',
    window.document.querySelector('[data-slot="dropdown-menu-content"]') === null);
  check('卸载后画布容器已清空', container.childElementCount === 0,
    `children=${container.childElementCount}`);
}

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
