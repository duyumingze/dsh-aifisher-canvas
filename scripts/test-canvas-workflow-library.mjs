/**
 * 画布「工作流节点」面板 + 工作流配图回归（v1.28）。
 *
 * 用户 2026-10-17 原话：
 *   「左侧工作流节点做错了，点击后是在画布右键的样子。工作流节点里放置配置好的 comfui，可以自定义配图」
 *
 * 这条需求 = 一件事的修 + 一件事的做，所以分三段验：
 *
 *   A. host 侧配图契约（真插件路由，`/api/aifisher/canvas/workflow-covers`）
 *      空表 → 上传一张 png → 列表/取图/能力清单/工作流配置清单都带 coverUrl → 换图 URL 的
 *      `?v=` 会变且不产生孤儿文件 → 删除后各处都不再带 → 非法 dataUrl / 超限 / 非图片类型各有明确状态码。
 *
 *   B. 真画布（jsdom 挂 lib/canvas/canvas-app.js）
 *      ★ bug 本体：点左栏「工作流节点」**不再**弹出画布右键菜单（role=menu），而是打开本面板；
 *      面板里按卡片陈列配置好的工作流（有配图的显图、没配图的显占位）、能搜索过滤、
 *      点卡片真的把绑好该工作流的 ComfyUI 节点放到画布上、卡片上的「配图 / 清除配图」真的落盘、
 *      清单空了有明确空态、Esc 能关。
 *
 *   C. 产物与源码锚点（防止「面板能开、点卡片没反应」这类静默失败）
 *      产物里带面板/入口/配图接口的锚点；左栏那个按钮已经不再接 `onAddClick`（右键菜单）。
 *
 * 用法：node scripts/test-canvas-workflow-library.mjs   （需要先 build）
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}
function fatal(error) {
  console.log(lines.join('\n'));
  console.error('\nUNCAUGHT', error);
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_DATA_URL.split(',')[1], 'base64');

// ---------------------------------------------------------------- 假 ComfyUI（不需要真跑，只要节点对账不挡路）

process.env.AIFISHER_COMFY_WORKFLOW_TTL_MS = '0';
process.env.AIFISHER_COMFY_OBJECT_INFO_TTL_MS = '0';

/** 文生图：有提示词槽、有 steps 参数、有图片结果节点。 */
const T2I = {
  '6': { inputs: { text: '模板占位' }, class_type: 'CLIPTextEncode' },
  '3': { inputs: { seed: 7, steps: 12, cfg: 1 }, class_type: 'KSampler' },
  '9': { inputs: { filename_prefix: 'out', images: ['3', 0] }, class_type: 'SaveImage' },
};
/** 文生视频：输出节点是 VHS_VideoCombine（分类/输出类型与图片那份区分开，卡片上要看得到）。 */
const T2V = {
  '4': { inputs: { text: '视频模板占位' }, class_type: 'CLIPTextEncode' },
  '5': { inputs: { seed: 1, steps: 6 }, class_type: 'KSampler' },
  '7': { inputs: { filename_prefix: 'vid', images: ['5', 0] }, class_type: 'VHS_VideoCombine' },
};

// ---------------------------------------------------------------- host 半

const PROJECT_ID = 'proj-workflow-library';
const host = await startHost();
const storageRoot = path.join(host.fakeHome, 'storages', 'dsh-aifisher-canvas');
const workflowsDir = path.join(storageRoot, 'workflows');
{
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(path.join(workflowsDir, 'a-t2i.json'), JSON.stringify(T2I), 'utf8');
  writeFileSync(
    path.join(workflowsDir, 'a-t2i.meta.json'),
    JSON.stringify({ title: '本地文生图', category: '图片' }),
    'utf8',
  );
  writeFileSync(path.join(workflowsDir, 'b-t2v.json'), JSON.stringify(T2V), 'utf8');
  writeFileSync(
    path.join(workflowsDir, 'b-t2v.meta.json'),
    JSON.stringify({ title: '本地文生视频', category: '视频' }),
    'utf8',
  );
}
{
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '工作流节点验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, String(save.text).slice(0, 120));
}

const coverApi = (method, suffix = '', body) =>
  host.hostApi(method, `/workflow-covers${suffix}`, body);
const capabilities = async () => (await host.hostApi('GET', '/comfy/capabilities')).json();
const workflowConfigs = async () => (await host.hostApi('GET', '/comfy/workflow-config')).json();
const capabilityOf = async (id) =>
  ((await capabilities()).capabilities ?? []).find((item) => item.workflowType === id) ?? null;

// ---------------------------------------------------------------- A. host 侧配图契约

{
  const empty = await coverApi('GET');
  check(
    '配图接口初始是空表（没配过就是没有）',
    empty.status === 200 && empty.json().ok === true && empty.json().count === 0,
    String(empty.text).slice(0, 160),
  );

  const saved = await coverApi('POST', '/custom-a-t2i', { dataUrl: PNG_DATA_URL });
  const savedBody = saved.json();
  check(
    '上传一张 png 配图成功，回执里带 url 与字节数',
    saved.status === 200 &&
      savedBody.ok === true &&
      String(savedBody.cover?.url ?? '').includes('/workflow-covers/file/') &&
      savedBody.cover?.bytes === PNG_BYTES.length,
    String(saved.text).slice(0, 200),
  );
  check(
    '配图落在画布数据目录（不写进用户的工作流目录）',
    readFileSync(path.join(storageRoot, 'workflow-covers.json'), 'utf8').includes('custom-a-t2i') &&
      !readFileSync(path.join(storageRoot, 'workflow-covers.json'), 'utf8').includes(workflowsDir),
    path.join(storageRoot, 'workflow-covers.json'),
  );

  const listed = await coverApi('GET');
  const coverUrl = listed.json().covers?.['custom-a-t2i']?.url ?? '';
  check(
    '配图列表能读回这张图（带 updatedAt 做的 ?v= 破缓存）',
    listed.json().count === 1 && /[?&]v=\d+/.test(coverUrl),
    JSON.stringify(listed.json().covers ?? null),
  );

  const served = await host.dispatch('GET', coverUrl.split('?')[0]);
  check(
    '取图端点真的把字节吐回来（image/png + 与上传字节一致）',
    served.status === 200 &&
      String(served.headers?.['content-type'] ?? '').includes('image/png') &&
      served.body.length > 0,
    `${served.status} ${served.headers?.['content-type']} ${served.body.length}B`,
  );

  const capability = await capabilityOf('custom-a-t2i');
  check(
    '能力清单里这份工作流带上 coverUrl（画布节点靠它显示节点头部小图）',
    Boolean(capability) && String(capability.coverUrl ?? '').includes('/workflow-covers/file/'),
    JSON.stringify({ coverUrl: capability?.coverUrl, templateCover: capability?.template?.coverUrl }),
  );
  check(
    '能力清单的模板骨架里也有一份 coverUrl（老路径/新路径都能读到）',
    Boolean(capability?.template) &&
      capability.template.coverUrl === capability.coverUrl,
    JSON.stringify({ top: capability?.coverUrl, template: capability?.template?.coverUrl }),
  );
  const other = await capabilityOf('custom-b-t2v');
  check(
    '没配图的工作流不带 coverUrl（前端画占位，不画一张破图）',
    Boolean(other) && other.coverUrl === undefined,
    JSON.stringify({ coverUrl: other?.coverUrl }),
  );

  const configs = await workflowConfigs();
  const configA = (configs.configs ?? []).find((item) => item.id === 'custom-a-t2i');
  const configB = (configs.configs ?? []).find((item) => item.id === 'custom-b-t2v');
  check(
    '「ComfyUI 工作流配置」清单里也带 coverUrl（两个面板共用一份数据）',
    Boolean(configA?.coverUrl) && configB?.coverUrl === undefined,
    JSON.stringify({ a: configA?.coverUrl, b: configB?.coverUrl }),
  );

  // 换一张图：URL 的 v= 必须变（否则浏览器继续显示旧图），且目录里不留孤儿文件
  const before = (await coverApi('GET')).json().covers?.['custom-a-t2i']?.updatedAt ?? 0;
  await settle(20);
  await coverApi('POST', '/custom-a-t2i', { dataUrl: PNG_DATA_URL });
  const afterEntry = (await coverApi('GET')).json().covers?.['custom-a-t2i'];
  check(
    '换图之后 updatedAt 变新（前端靠它在 <img src> 上破缓存）',
    Number(afterEntry?.updatedAt ?? 0) > Number(before),
    JSON.stringify({ before, after: afterEntry?.updatedAt }),
  );
  const coversDir = path.join(storageRoot, 'workflow-covers');
  const files = (await import('node:fs')).readdirSync(coversDir);
  check('同一份工作流重复上传不会堆出一堆孤儿文件', files.length === 1, files.join(' | '));

  // 换成 jpg：后缀变了，旧文件要被清掉
  const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await coverApi('POST', '/custom-a-t2i', {
    dataUrl: `data:image/jpeg;base64,${jpgBytes.toString('base64')}`,
  });
  const jpgFiles = (await import('node:fs')).readdirSync(coversDir);
  check(
    '换类型（png → jpg）会把旧后缀的那张图清掉',
    jpgFiles.length === 1 && jpgFiles[0].endsWith('.jpg'),
    jpgFiles.join(' | '),
  );

  // 错误分支
  const badData = await coverApi('POST', '/custom-a-t2i', { dataUrl: 'not-a-data-url' });
  check(
    '非法 dataUrl 明确回 422 + code（不是静默失败）',
    badData.status === 422 && badData.json().code === 'COVER_DATA_INVALID',
    `${badData.status} ${badData.text.slice(0, 120)}`,
  );
  const badType = await coverApi('POST', '/custom-a-t2i', {
    dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
  });
  check(
    '非白名单图片类型回 415（svg 会被拦）',
    badType.status === 415 && badType.json().code === 'COVER_TYPE_UNSUPPORTED',
    `${badType.status} ${badType.text.slice(0, 120)}`,
  );
  const tooBig = await coverApi('POST', '/custom-a-t2i', {
    dataUrl: `data:image/png;base64,${Buffer.alloc(9 * 1024 * 1024, 7).toString('base64')}`,
  });
  check(
    '超过 8 MB 的图回 413（不会被默默截断）',
    tooBig.status === 413,
    `${tooBig.status} ${tooBig.text.slice(0, 120)}`,
  );
  const traversal = await traversalCase();
  check(
    '带路径分隔符的工作流 id 一律拒绝（防目录穿越）',
    traversal,
  );

  const removed = await coverApi('DELETE', '/custom-a-t2i');
  check(
    '删除配图回 removed=true',
    removed.status === 200 && removed.json().removed === true,
    String(removed.text).slice(0, 120),
  );
  const afterDelete = await coverApi('GET');
  const capabilityAfterDelete = await capabilityOf('custom-a-t2i');
  check(
    '删除后列表空、能力清单不再带 coverUrl',
    afterDelete.json().count === 0 && capabilityAfterDelete?.coverUrl === undefined,
    JSON.stringify({ count: afterDelete.json().count, coverUrl: capabilityAfterDelete?.coverUrl }),
  );
  const missingFile = await host.dispatch(
    'GET',
    String(coverUrl.split('?')[0] ?? '/api/aifisher/canvas/workflow-covers/file/none.png'),
  );
  check(
    '删掉之后取图端点回 404（不是拿一张旧图糊过去）',
    missingFile.status === 404,
    `${missingFile.status}`,
  );
}

async function traversalCase() {
  // `..%2F..%2Fevil` 在 URL 上是一个分段，decode 后是 `../../evil` —— host 必须直接拒绝
  const response = await host.dispatch(
    'POST',
    '/api/aifisher/canvas/workflow-covers/..%2F..%2Fevil',
    { dataUrl: PNG_DATA_URL },
  );
  if (response.status !== 422) return false;
  try {
    return JSON.parse(response.body).code === 'COVER_ID_INVALID';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- B. 真画布（jsdom）

// 挂画布之前先给 a-t2i 配一张图：面板第一次打开就应该看到「有配图」的卡片
await coverApi('POST', '/custom-a-t2i', { dataUrl: PNG_DATA_URL });

const { window, fetchCalls } = await createCanvasDom({ dispatch: host.dispatch });
const pageErrors = [];
window.addEventListener('error', (event) => {
  pageErrors.push(String(event.error?.stack ?? event.message ?? event));
});
seedResume(window, PROJECT_ID);
const { container, handle } = await mountCanvasApp(window);
await settle(1500);

const panel = () => window.document.querySelector('[data-fisherai-workflow-node-panel]');
const backdrop = () => window.document.querySelector('[data-fisherai-workflow-node-backdrop]');
const trigger = () => container.querySelector('[data-fisherai-workflow-node-trigger]');
const cards = () => [...window.document.querySelectorAll('[data-fisherai-workflow-node-item]')];
const cardIds = () => cards().map((item) => item.getAttribute('data-fisherai-workflow-node-item'));
const card = (id) =>
  window.document.querySelector(`[data-fisherai-workflow-node-item="${id}"]`);
const notice = () => window.document.querySelector('[data-fisherai-workflow-node-notice]');

async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
    await settle(150);
  }
  return last;
}
const savedNodes = async () => {
  const result = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  if (result.status !== 200) return [];
  try {
    return JSON.parse(result.text).nodes ?? [];
  } catch {
    return [];
  }
};
const readCanvas = async () => {
  const read = await host.tool('canvas_control').execute(
    { action: 'read' },
    { agent: { session: { id: 'sess-workflow-library' } } },
  );
  return read.result?.nodes ?? [];
};

// ---- B1. 入口：点它打开的是「工作流节点」面板，不是画布右键菜单（用户报的那个 bug）

check('左侧工具条有「工作流节点」按钮', Boolean(trigger()));
check('画布启动时拉过工作流清单（面板卡片的参数数量来自它）',
  fetchCalls.some((call) => call.includes('capabilities')),
  fetchCalls.filter((call) => call.includes('capabilities')).join(' | ') || '(none)');
check('未打开时页面上没有工作流节点面板', !panel());

{
  const menusBefore = window.document.querySelectorAll('[role="menu"]').length;
  trigger()?.click();
  await settle(400);
  const opened = Boolean(panel());
  const menusAfter = window.document.querySelectorAll('[role="menu"]').length;
  check('点「工作流节点」打开的是工作流节点面板', opened, String(Boolean(panel())));
  check(
    '★ 点「工作流节点」不再弹出画布右键菜单（用户报的「点击后是在画布右键的样子」）',
    menusAfter === menusBefore && !window.document.querySelector('[role="menu"]'),
    `menus ${menusBefore} → ${menusAfter}`,
  );
  check(
    '面板标记为打开、挂在画布容器里（继承画布主题变量）',
    window.document
      .querySelector('[data-fisherai-workflow-node]')
      ?.getAttribute('data-fisherai-workflow-node') === 'open' &&
      container.contains(panel()),
  );
  check('面板是 role=dialog + aria-label=工作流节点', 
    panel()?.getAttribute('role') === 'dialog' &&
      panel()?.getAttribute('aria-label') === '工作流节点');
}

// ---- B2. 卡片：配置好的工作流都在，配图/占位按工作流各自显示

{
  const ready = await waitFor(() => (cards().length >= 2 ? cards() : null));
  check('面板按卡片陈列配置好的 ComfyUI 工作流（预置的 2 份都在）',
    Boolean(ready) && cardIds().includes('custom-a-t2i') && cardIds().includes('custom-b-t2v'),
    JSON.stringify(cardIds()));
  check('卡片上显示工作流标题',
    String(card('custom-a-t2i')?.textContent ?? '').includes('本地文生图'),
    String(card('custom-a-t2i')?.textContent ?? '').slice(0, 120));
  const covered = card('custom-a-t2i')?.querySelector('[data-fisherai-workflow-node-cover]');
  check(
    '配了图的卡片显示的是那张自定义配图（<img> 指向 /workflow-covers/file/）',
    covered?.tagName === 'IMG' &&
      String(covered.getAttribute('src') ?? '').includes('/workflow-covers/file/') &&
      card('custom-a-t2i')?.getAttribute('data-fisherai-workflow-node-cover-state') === 'custom',
    `${covered?.tagName} ${covered?.getAttribute?.('src')}`,
  );
  const placeholder = card('custom-b-t2v')?.querySelector('[data-fisherai-workflow-node-cover]');
  check(
    '没配图的卡片显示占位（不是一张坏图）',
    placeholder?.getAttribute('data-fisherai-workflow-node-cover') === 'placeholder' &&
      card('custom-b-t2v')?.getAttribute('data-fisherai-workflow-node-cover-state') === 'placeholder',
    String(card('custom-b-t2v')?.getAttribute('data-fisherai-workflow-node-cover-state')),
  );
}

// ---- B3. 搜索过滤

{
  const input = window.document.querySelector('[data-fisherai-workflow-node-search]');
  check('面板有搜索框', Boolean(input));
  const typeIn = (value) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const before = cards().length;
  typeIn('视频');
  await settle(250);
  check(
    '输入「视频」后只剩视频那份工作流',
    cardIds().length === 1 && cardIds()[0] === 'custom-b-t2v',
    JSON.stringify(cardIds()),
  );
  typeIn('zzz-不存在');
  await settle(250);
  check(
    '搜不到时显示「没有匹配」的空态',
    Boolean(window.document.querySelector('[data-fisherai-workflow-node-empty]')),
    String(window.document.querySelector('[data-fisherai-workflow-node-empty]')?.textContent ?? ''),
  );
  typeIn('');
  await settle(250);
  check('清空搜索后卡片全部回来', cards().length === before, `${cards().length}/${before}`);
}

// ---- B4. 点卡片 = 把绑好这份工作流的节点放到画布上

{
  const before = (await readCanvas()).length;
  card('custom-b-t2v')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(700);
  const comfy = await waitFor(async () => {
    const node = (await savedNodes()).find((item) => item.comfyMode === 'custom-b-t2v');
    return node ?? null;
  });
  check(
    '点卡片在画布上建出一个绑好该工作流的 ComfyUI 节点',
    Boolean(comfy) && comfy.type === 'ComfyUI',
    JSON.stringify({ type: comfy?.type, comfyMode: comfy?.comfyMode, before }),
  );
  const element = comfy?.id ? container.querySelector(`[data-node-id="${comfy.id}"]`) : null;
  check(
    '建出来的节点渲染成通用本地工作流节点（提示词/参数控件都在）',
    Boolean(element?.querySelector('[data-fisherai-local-workflow-prompt]')) &&
      Boolean(element?.querySelector('[data-fisherai-local-workflow-parameter="steps"]')),
    element ? 'ok' : '(no element)',
  );
  check(
    '没配图的工作流，节点头部回落到品牌标（cover=brand）',
    element?.querySelector('[data-fisherai-local-workflow-cover="brand"]') !== null,
    String(element?.querySelector('[data-fisherai-local-workflow-cover]')?.getAttribute('data-fisherai-local-workflow-cover')),
  );
  check(
    '点完卡片有反馈（提示条 + 卡片高亮）',
    notice()?.getAttribute('data-fisherai-workflow-node-notice') === 'ok' &&
      String(card('custom-b-t2v')?.className ?? '').includes('border-[var(--af-selected)]'),
    String(notice()?.textContent ?? '').slice(0, 120),
  );
  check('点卡片不会把面板关掉（可以连着放好几份工作流）', Boolean(panel()));
}

// ---- B5. 卡片上「清除配图」

{
  const clearButton = card('custom-a-t2i')?.querySelector('[aria-label="清除配图"]');
  check('有配图的卡片上有「清除配图」按钮', Boolean(clearButton));
  clearButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(700);
  const clearedPlaceholder = card('custom-a-t2i')?.querySelector(
    '[data-fisherai-workflow-node-cover="placeholder"]',
  );
  check(
    '清除后卡片回到占位、host 那边也没了',
    Boolean(clearedPlaceholder) && (await coverApi('GET')).json().count === 0,
    JSON.stringify({ count: (await coverApi('GET')).json().count }),
  );
}

// ---- B6. 卡片上「配图」上传（真 File → FileReader → POST）

{
  const fileInput = window.document.querySelector('[data-fisherai-workflow-node-cover-input]');
  check('面板里有隐藏的图片选择框', Boolean(fileInput));
  card('custom-a-t2i')?.querySelector('[aria-label="配图"]')?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
  await settle(200);
  const file = new window.File([PNG_BYTES], 'cover.png', { type: 'image/png' });
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  const uploaded = await waitFor(async () =>
    (await coverApi('GET')).json().count === 1 ? true : null,
  );
  check('上传后 host 侧真的落了这张配图', Boolean(uploaded),
    JSON.stringify((await coverApi('GET')).json().covers ?? null));
  await settle(400);
  const coverImg = card('custom-a-t2i')?.querySelector('[data-fisherai-workflow-node-cover]');
  check(
    '上传成功后卡片立刻换成新配图（不用刷新页面）',
    coverImg?.tagName === 'IMG' &&
      String(coverImg.getAttribute('src') ?? '').includes('/workflow-covers/file/'),
    `${coverImg?.tagName} ${coverImg?.getAttribute?.('src')}`,
  );
  check(
    '提示条报告保存结果（含大小）',
    notice()?.getAttribute('data-fisherai-workflow-node-notice') === 'ok' &&
      /KB/.test(String(notice()?.textContent ?? '')),
    String(notice()?.textContent ?? '').slice(0, 120),
  );
}

// ---- B7. 配了图的工作流建出的节点，头部用自定义配图

{
  card('custom-a-t2i')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const comfy = await waitFor(async () => {
    const nodes = (await savedNodes()).filter((item) => item.comfyMode === 'custom-a-t2i');
    return nodes[0] ?? null;
  });
  const element = comfy?.id ? container.querySelector(`[data-node-id="${comfy.id}"]`) : null;
  const headImage = element?.querySelector('[data-fisherai-local-workflow-cover]');
  check(
    '配了图的工作流，建立来的节点头部换成自定义配图（cover=custom）',
    headImage?.getAttribute('data-fisherai-local-workflow-cover') === 'custom' &&
      String(headImage.getAttribute('src') ?? '').includes('/workflow-covers/file/'),
    `${headImage?.getAttribute('data-fisherai-local-workflow-cover')} ${headImage?.getAttribute('src')}`,
  );
}

// ---- B8. Esc 关闭 + 再次打开

{
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await settle(200);
  check('Esc 关闭面板', !panel() && !backdrop());
  trigger()?.click();
  await settle(300);
  check('再点一次能重新打开', Boolean(panel()));
  // 点遮罩关闭
  backdrop()?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  await settle(200);
  check('点遮罩关闭面板', !panel());
}

// ---- B9. 清单空了要有明确空态（放在最后：这里会把工作流目录清空）

{
  rmSync(path.join(workflowsDir, 'a-t2i.json'), { force: true });
  rmSync(path.join(workflowsDir, 'a-t2i.meta.json'), { force: true });
  rmSync(path.join(workflowsDir, 'b-t2v.json'), { force: true });
  rmSync(path.join(workflowsDir, 'b-t2v.meta.json'), { force: true });
  trigger()?.click();
  await settle(300);
  window.document.querySelector('[aria-label="刷新工作流清单"]')?.click();
  const empty = await waitFor(() =>
    window.document.querySelector('[data-fisherai-workflow-node-empty]'),
  );
  check('工作流目录空了之后面板给出明确空态（不是空白）', Boolean(empty),
    String(empty?.textContent ?? '').slice(0, 160));
  check('空态里有「打开工作流配置」的去处', Boolean(
    window.document.querySelector('[data-fisherai-workflow-node-empty] [aria-label="打开工作流配置"]'),
  ));
  window.document
    .querySelector('[data-fisherai-workflow-node-empty] [aria-label="打开工作流配置"]')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(400);
  check(
    '点它切到「ComfyUI 工作流配置」面板（工作流节点面板关掉）',
    !panel() &&
      Boolean(window.document.querySelector('[data-fisherai-workflow-config-dialog]')),
  );
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await settle(200);
}

// ---------------------------------------------------------------- C. 产物与源码锚点

{
  const repo = process.cwd();
  const sidebar = readFileSync(path.join(repo, 'src/canvas-ui/canvas/CanvasSidebar.tsx'), 'utf8');
  check(
    '左栏「工作流节点」不再接 onAddClick（那正是「点了像右键菜单」的根因）',
    !/actionButton\(\s*'工作流节点'/.test(sidebar) && sidebar.includes('onWorkflowNodesClick'),
    sidebar.match(/工作流节点[^\n]{0,80}/g)?.join(' | ') ?? '(none)',
  );

  const bundlePath = path.join(repo, 'lib/canvas/canvas-app.js');
  if (existSyncSafe(bundlePath)) {
    const bundle = readFileSync(bundlePath, 'utf8');
    check('产物里带工作流节点面板的锚点', bundle.includes('data-fisherai-workflow-node-panel'));
    check('产物里带工作流节点入口标记', bundle.includes('data-fisherai-workflow-node-trigger'));
    check('产物里带配图接口路径', bundle.includes('/workflow-covers/'));
    check('产物里带建节点事件名（点卡片靠它落节点）', bundle.includes('fisherai:add-canvas-node'));
  } else {
    check('产物里带工作流节点面板的锚点', false, 'lib/canvas/canvas-app.js 不存在');
  }

  const hostBundlePath = path.join(repo, 'lib/index.js');
  const hostBundle = readFileSync(hostBundlePath, 'utf8');
  check(
    'host 产物里带配图路由与索引文件（重启 DSH 后才生效）',
    hostBundle.includes('workflow-covers') && hostBundle.includes('workflow-covers.json'),
  );
}

function existSyncSafe(file) {
  try {
    return readFileSync(file).length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 收尾

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=200')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check(
    '工作流节点面板全程无运行时错误',
    errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)',
  );
  check('页面里没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || '(none)');
}

try {
  handle.dispose();
} catch {
  /* 卸载失败会在渲染测试里单独断言 */
}
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
