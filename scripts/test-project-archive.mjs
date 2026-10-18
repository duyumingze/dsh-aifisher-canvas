/**
 * 「项目归档」（导出 / 导入）回归 —— v1.42。
 *
 * 用户 2026-10-18 原话（整轮需求只有这一句）：「在无限画布面板做一个项目导出导入的功能」。
 *
 * 这条需求跨两层，所以分两段验：
 *
 *   A. host 侧（真插件路由 + 临时 DSH_HOME）
 *      `GET /workflows/<id>/backup/info`（规模预览）、
 *      `POST /workflows/<id>/backup/save`（写到本机目录）、
 *      `GET /workflows/<id>/backup`（浏览器下载形态，v1.1 就有）、
 *      `POST /workflows/restore`（原始字节 / 本机路径 / 旧版 .json 文档三种形态）。
 *      守的点：素材真的随行、导入换新项目 id 且素材 URL 改写、同名不覆盖、
 *      导出目录必须是绝对路径且不能指进素材目录、坏归档的四种错误码。
 *
 *   B. 真画布（jsdom 挂 lib/canvas/canvas-app.js）
 *      头部有「项目归档」入口 → 面板里读得到规模读数 → 真点「导出到目录」落盘 →
 *      真上传一份备份（走 file input）→ 新项目出现在 host 上、面板收起、画布切过去 →
 *      「从路径导入」也能用 → 项目看板头部的「导入项目」按钮同样能导（看板视图里
 *      面板根本没挂载，这条路走的是 window 桥）。
 *
 * 用法：node scripts/test-project-archive.mjs   （需要先 build）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
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
function fatal(error) {
  console.log(lines.join('\n'));
  console.error('\nUNCAUGHT', error);
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const PROJECT_ID = 'proj-archive';
const PROJECT_TITLE = '归档验证项目';

const host = await startHost();
const dataDir = () => join(host.fakeHome, 'storages', 'dsh-aifisher-canvas');
const mediaRoot = () => join(dataDir(), 'media');
const downloadsDir = () => join(dataDir(), 'downloads');

/** host 侧素材：一个项目目录下的两张图（一张被文档引用，一张只是躺着）。 */
function seedMedia(projectId) {
  const dir = join(mediaRoot(), projectId, 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cover.png'), PNG);
  writeFileSync(join(dir, 'extra.png'), Buffer.concat([PNG, PNG]));
}

const api = host.hostApi;

// ---------------------------------------------------------------- A0. 预置项目

console.log('=== A0. 预置一个带素材的项目 ===');
{
  seedMedia(PROJECT_ID);
  const created = await api('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: PROJECT_TITLE,
    nodes: [
      {
        id: 'n1',
        type: 'Image',
        x: 0,
        y: 0,
        prompt: '归档验证',
        resultUrl: `/api/aifisher/canvas/media/${PROJECT_ID}/images/cover.png`,
      },
      {
        id: 'n2',
        type: 'Image',
        x: 400,
        y: 0,
        prompt: '第二张',
        resultUrl: `/api/aifisher/canvas/media/${PROJECT_ID}/images/extra.png?t=123`,
      },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('项目写进本地后端', created.status === 200, `${created.status} ${created.text.slice(0, 80)}`);
}

// ---------------------------------------------------------------- A1. 规模预览

console.log('\n=== A1. 规模预览（backup/info）===');
let info = null;
{
  const response = await api('GET', `/workflows/${PROJECT_ID}/backup/info`);
  info = response.status === 200 ? response.json() : null;
  check('GET backup/info 200', response.status === 200, String(response.status));
  check('回项目标题与节点数', info?.title === PROJECT_TITLE && info?.nodeCount === 2,
    JSON.stringify({ title: info?.title, nodeCount: info?.nodeCount }));
  check('素材个数按项目目录算（2 张）', info?.mediaFiles === 2, String(info?.mediaFiles));
  check('素材字节 = 两张图之和', info?.mediaBytes === PNG.length * 3,
    `${info?.mediaBytes} vs ${PNG.length * 3}`);
  check('估算归档大小 ≥ 素材字节（base64 会膨胀）',
    Number(info?.archiveBytes) > Number(info?.mediaBytes), `${info?.archiveBytes}`);
  check('素材没超上限（mediaOmitted=false）', info?.mediaOmitted === false);
  check('给出建议文件名（.fisherai）', String(info?.fileName ?? '').endsWith('.fisherai'),
    String(info?.fileName));
  check('给出导出目录与默认目录',
    typeof info?.directory === 'string' && typeof info?.defaultDirectory === 'string' &&
      info.directory.endsWith('downloads'), String(info?.directory));
  check('归档格式自述（format/version）',
    info?.format === 'dsh-aifisher-project' && info?.version === 1,
    `${info?.format} v${info?.version}`);

  const missing = await api('GET', '/workflows/no-such/backup/info');
  check('不存在的项目 → 404 PROJECT_NOT_FOUND',
    missing.status === 404 && missing.json().code === 'PROJECT_NOT_FOUND',
    `${missing.status} ${missing.json().code}`);
}

// ---------------------------------------------------------------- A2. 导出到本机目录

console.log('\n=== A2. 导出到本机目录（backup/save）===');
let savedPath = '';
{
  const saved = await api('POST', `/workflows/${PROJECT_ID}/backup/save`, {});
  const body = saved.status === 200 ? saved.json() : {};
  savedPath = String(body.path ?? '');
  check('POST backup/save 200', saved.status === 200, `${saved.status} ${saved.text.slice(0, 120)}`);
  check('回执给绝对路径 + 目录', savedPath.startsWith(downloadsDir()) === true &&
    body.directory === downloadsDir(), `${savedPath}`);
  check('文件名是「项目名.fisherai」', body.fileName === `${PROJECT_TITLE}.fisherai`,
    String(body.fileName));
  check('文件真的落盘了', existsSync(savedPath), savedPath);
  if (existsSync(savedPath)) {
    const raw = readFileSync(savedPath);
    check('回执 bytes = 文件真实大小', raw.length === body.bytes, `${raw.length} vs ${body.bytes}`);
    const archive = JSON.parse(raw.toString('utf8'));
    check('落盘的是本插件归档格式（format/version）',
      archive.format === 'dsh-aifisher-project' && archive.version === 1,
      `${archive.format} v${archive.version}`);
    check('素材以 base64 随行了（2 张）',
      Object.keys(archive.media ?? {}).length === 2,
      Object.keys(archive.media ?? {}).join(','));
    check('归档里带的是这个项目的文档', archive.project?.id === PROJECT_ID &&
      Array.isArray(archive.project?.nodes) && archive.project.nodes.length === 2);
    check('没有夹带别的项目', Object.keys(archive.media ?? {}).every((key) => key.startsWith(`${PROJECT_ID}/`)),
      Object.keys(archive.media ?? {}).join(','));
  }

  // 同名不覆盖：第二次导出应该退让成 "名字 (2).fisherai"
  const again = await api('POST', `/workflows/${PROJECT_ID}/backup/save`, {});
  const second = again.status === 200 ? again.json() : {};
  check('同名不覆盖（第二次是「名字 (2)」）',
    String(second.fileName ?? '').includes('(2)') && second.path !== savedPath,
    String(second.fileName));
  check('两次导出的文件都在', existsSync(savedPath) && existsSync(String(second.path ?? '')));
}

// ---------------------------------------------------------------- A3. 导出目录的边界

console.log('\n=== A3. 导出目录的边界 ===');
{
  const relative = await api('POST', `/workflows/${PROJECT_ID}/backup/save`, { directory: 'relative\\dir' });
  check('相对路径 → 422 ARCHIVE_DIRECTORY_INVALID',
    relative.status === 422 && relative.json().code === 'ARCHIVE_DIRECTORY_INVALID',
    `${relative.status} ${relative.json().code}`);

  const intoMedia = await api('POST', `/workflows/${PROJECT_ID}/backup/save`, {
    directory: join(mediaRoot(), PROJECT_ID, 'images'),
  });
  check('指进素材目录 → 422（不许和素材混在一起）',
    intoMedia.status === 422 && intoMedia.json().code === 'ARCHIVE_DIRECTORY_INVALID',
    `${intoMedia.status} ${intoMedia.json().code}`);

  const custom = join(host.fakeHome, 'exports-custom');
  const ok = await api('POST', `/workflows/${PROJECT_ID}/backup/save`, { directory: custom });
  check('一次性的自定义目录能用（不存在会建）', ok.status === 200 && existsSync(custom),
    `${ok.status} ${String(ok.json().path ?? '')}`);
  check('自定义目录里也有文件', existsSync(join(custom, `${PROJECT_TITLE}.fisherai`)));
  check('自定义目录不会被记成默认目录（下一次还是 downloads）',
    (await api('GET', `/workflows/${PROJECT_ID}/backup/info`)).json().directory === downloadsDir());

  const notAllowed = await api('POST', '/workflows/no-such/backup/save', {});
  check('导出不存在的项目 → 404', notAllowed.status === 404, String(notAllowed.status));
}

// ---------------------------------------------------------------- A4. 浏览器下载形态

console.log('\n=== A4. 浏览器下载形态（GET backup）===');
{
  const response = await host.dispatch('GET', `/api/aifisher/canvas/workflows/${PROJECT_ID}/backup`);
  const disposition = String(response.headers['content-disposition'] ?? '');
  check('GET /backup 回 attachment + .fisherai', response.status === 200 &&
    disposition.includes('attachment') && disposition.includes('.fisherai'), disposition.slice(0, 90));
  check('文件名带 RFC 5987 编码（中文项目名可用）',
    disposition.includes("filename*=UTF-8''"), disposition.slice(0, 120));
  let archive = null;
  try {
    archive = JSON.parse(response.body);
  } catch {
    archive = null;
  }
  check('下载形态也是同一份归档', archive?.format === 'dsh-aifisher-project' &&
    Object.keys(archive?.media ?? {}).length === 2);
}

// ---------------------------------------------------------------- A5. 导入（原始字节）

console.log('\n=== A5. 导入：原始字节 ===');
let importedId = '';
{
  const bytes = readFileSync(savedPath);
  const restored = await host.dispatch('POST', '/api/aifisher/canvas/workflows/restore', bytes);
  const body = restored.status === 200 ? JSON.parse(restored.body) : {};
  importedId = String(body.id ?? '');
  check('POST /workflows/restore 200 且回新的 id', restored.status === 200 &&
    typeof body.id === 'string' && body.id !== PROJECT_ID, `${restored.status} ${restored.body.slice(0, 120)}`);
  check('回执带标题与节点数（面板拿来提示）',
    body.title === PROJECT_TITLE && body.nodeCount === 2,
    JSON.stringify({ title: body.title, nodeCount: body.nodeCount }));
  check('回执写清素材恢复了几张', body.mediaRestored === 2, String(body.mediaRestored));
  check('不是 legacy 形态（真归档）', body.legacy === undefined);

  const opened = await api('GET', `/workflows/${importedId}`);
  const nodes = opened.json()?.nodes ?? [];
  check('导入后的项目确实存在', opened.status === 200, String(opened.status));
  check('素材 URL 改写成新项目 id',
    nodes[0]?.resultUrl === `/api/aifisher/canvas/media/${importedId}/images/cover.png`,
    String(nodes[0]?.resultUrl));
  check('带缓存戳的素材 URL 也改写了（?t= 保留）',
    nodes[1]?.resultUrl === `/api/aifisher/canvas/media/${importedId}/images/extra.png?t=123`,
    String(nodes[1]?.resultUrl));
  check('素材文件写到了新项目目录',
    existsSync(join(mediaRoot(), importedId, 'images', 'cover.png')) &&
      existsSync(join(mediaRoot(), importedId, 'images', 'extra.png')));
  check('原项目的素材没被动过（不是搬家）',
    existsSync(join(mediaRoot(), PROJECT_ID, 'images', 'cover.png')));
  check('导入不会覆盖原项目', (await api('GET', `/workflows/${PROJECT_ID}`)).status === 200);
}

/**
 * `POST /workflows/restore` 靠 Content-Type 分流：application/json = 本机路径，其它 = 原始字节。
 * 这里显式带上头（与浏览器里我们客户端的行为一致）。
 */
async function restoreFromPath(path) {
  return host.dispatch(
    'POST',
    '/api/aifisher/canvas/workflows/restore',
    JSON.stringify({ path }),
    { headers: { 'content-type': 'application/json' } },
  );
}

// ---------------------------------------------------------------- A6. 导入：本机路径 / 旧版 .json

console.log('\n=== A6. 导入：本机路径与旧版 .json ===');
{
  const fromPath = await restoreFromPath(savedPath);
  const fromPathBody = fromPath.status === 200 ? JSON.parse(fromPath.body) : {};
  check('本机路径形态也能导入（host 直接读盘）', fromPath.status === 200 &&
    typeof fromPathBody.id === 'string' && fromPathBody.id !== importedId,
    `${fromPath.status} ${fromPath.body.slice(0, 100)}`);

  const wrongExt = await restoreFromPath(join(host.fakeHome, 'x.txt'));
  check('非 .fisherai/.json 路径 → 422 RESTORE_PATH_INVALID',
    wrongExt.status === 422 && JSON.parse(wrongExt.body).code === 'RESTORE_PATH_INVALID',
    `${wrongExt.status} ${wrongExt.body.slice(0, 80)}`);

  const missingPath = await restoreFromPath(join(host.fakeHome, 'nope.fisherai'));
  check('路径不存在 → 404 RESTORE_FILE_MISSING',
    missingPath.status === 404 && JSON.parse(missingPath.body).code === 'RESTORE_FILE_MISSING',
    `${missingPath.status} ${missingPath.body.slice(0, 80)}`);

  // 旧版画布文档（没有 format 外壳、没有素材）
  const legacyDoc = {
    id: 'legacy-proj',
    title: '旧版画布文档',
    nodes: [{ id: 'ln1', type: 'Text', x: 0, y: 0, textContent: '老项目' }],
    groups: [],
  };
  const legacy = await host.dispatch(
    'POST',
    '/api/aifisher/canvas/workflows/restore',
    Buffer.from(JSON.stringify(legacyDoc), 'utf8'),
  );
  const legacyBody = legacy.status === 200 ? JSON.parse(legacy.body) : {};
  check('旧版 .json 文档也能导入（legacy 标记）', legacy.status === 200 &&
    legacyBody.legacy === true && typeof legacyBody.id === 'string',
    `${legacy.status} ${legacy.body.slice(0, 100)}`);
  check('旧版文档的节点数对得上', legacyBody.nodeCount === 1, String(legacyBody.nodeCount));
  check('旧版文档没有素材随行（不假装恢复）', legacyBody.mediaRestored === 0,
    String(legacyBody.mediaRestored));

  const bogus = await host.dispatch(
    'POST',
    '/api/aifisher/canvas/workflows/restore',
    Buffer.from(JSON.stringify({ format: 'nope' }), 'utf8'),
  );
  check('不认识的格式 → 422 ARCHIVE_FORMAT_UNKNOWN',
    bogus.status === 422 && JSON.parse(bogus.body).code === 'ARCHIVE_FORMAT_UNKNOWN',
    `${bogus.status} ${bogus.body.slice(0, 80)}`);

  const broken = await host.dispatch(
    'POST',
    '/api/aifisher/canvas/workflows/restore',
    Buffer.from('not json at all', 'utf8'),
  );
  check('不是 JSON → 422 ARCHIVE_INVALID_JSON',
    broken.status === 422 && JSON.parse(broken.body).code === 'ARCHIVE_INVALID_JSON',
    `${broken.status} ${broken.body.slice(0, 80)}`);

  const tooNew = await host.dispatch(
    'POST',
    '/api/aifisher/canvas/workflows/restore',
    Buffer.from(JSON.stringify({ format: 'dsh-aifisher-project', version: 99, project: { nodes: [] } }), 'utf8'),
  );
  check('版本比插件新 → 422 ARCHIVE_VERSION_TOO_NEW',
    tooNew.status === 422 && JSON.parse(tooNew.body).code === 'ARCHIVE_VERSION_TOO_NEW',
    `${tooNew.status} ${JSON.parse(tooNew.body).code}`);
}

// ---------------------------------------------------------------- B. 画布上的面板

console.log('\n=== B. 画布上的「项目归档」面板 ===');

/** 清掉 A 段建出来的临时项目，让 B 段只有两个项目可数。 */
for (const item of JSON.parse((await api('GET', '/workflows')).text)) {
  if (item.id !== PROJECT_ID) await api('DELETE', `/workflows/${item.id}`);
}
await api('DELETE', '/media-download/settings/directory');

const { window, fetchCalls } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { container } = await mountCanvasApp(window);
await settle(1600);

const $ = (selector) => window.document.querySelector(selector);
const $$ = (selector) => [...window.document.querySelectorAll(selector)];
function click(element) {
  if (!element) return false;
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
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
/** React 19 受控输入：走原生 setter + input 事件，直接改 value 不会被 React 采纳。 */
function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
/** 往隐藏的 file input 上塞一个文件（jsdom 里 files 是只读 getter，只能改属性描述符）。 */
function attachFile(input, file) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const panel = () => $('[data-fisherai-project-archive="panel"]');
const notice = () => $('[data-fisherai-project-archive-notice]');
const toast = (kind = 'ok') => $(`[data-fisherai-project-archive-toast="${kind}"]`);

// ---- B1. 入口 ----
const trigger = $('[data-fisherai-project-archive-trigger]');
check('头部有「项目归档」入口（data-fisherai-project-archive-trigger）', Boolean(trigger));
check('入口可访问（aria-label=项目归档）',
  trigger?.getAttribute('aria-label') === '项目归档', String(trigger?.getAttribute('aria-label')));
check('入口在头部左侧、紧挨「返回项目库」（同一个工具条里）',
  Boolean(trigger) && trigger.parentElement === $('.af-canvas-header')?.querySelector('[data-fisherai-back-to-library]')?.parentElement,
  String(trigger?.parentElement?.className ?? '').slice(0, 80));
check('面板默认是关着的', Boolean($('[data-fisherai-project-archive="closed"]')) && !panel());

// ---- B2. 打开面板 + 规模读数 ----
click(trigger);
const opened = await waitFor(() => panel());
check('点入口打开「项目归档」面板', Boolean(opened));
check('面板是 dialog + aria-label=项目归档',
  opened?.getAttribute('role') === 'dialog' && opened?.getAttribute('aria-label') === '项目归档',
  `${opened?.getAttribute('role')} / ${opened?.getAttribute('aria-label')}`);
check('面板带当前项目 id（导出按它走）',
  opened?.getAttribute('data-fisherai-project-archive-project') === PROJECT_ID,
  String(opened?.getAttribute('data-fisherai-project-archive-project')));

const infoText = await waitFor(() => {
  const text = String($('[data-fisherai-project-archive-info]')?.textContent ?? '');
  return /个节点/.test(text) ? text : '';
});
check('规模读数读到了（几个节点 / 几个素材）',
  /2 个节点/.test(String(infoText)) && /素材 2 个/.test(String(infoText)), String(infoText));
check('读数里有归档大小估算', /归档约/.test(String(infoText)), String(infoText));

const dirInput = $('[data-fisherai-project-archive-dir]');
check('导出目录输入框在（aria-label=导出目录）',
  dirInput?.getAttribute('aria-label') === '导出目录', String(dirInput?.getAttribute('aria-label')));
check('导出目录默认是数据目录下的 downloads',
  String(dirInput?.value ?? '') === downloadsDir(), String(dirInput?.value));
for (const label of ['导出到目录', '下载备份', '打开导出目录']) {
  check(`面板有「${label}」按钮`, Boolean($(`[aria-label="${label}"]`)));
}
check('导入区有「导入项目文件」按钮', Boolean($('[aria-label="导入项目文件"]')));
check('导入区有「本机备份路径」输入 + 「从路径导入」按钮',
  Boolean($('[aria-label="本机备份路径"]')) && Boolean($('[aria-label="从路径导入"]')));

// ---- B3. 真点「导出到目录」----
const filesBefore = existsSync(downloadsDir()) ? readdirSync(downloadsDir()).length : 0;
click($('[aria-label="导出到目录"]'));
const exportNotice = await waitFor(() => {
  const element = notice();
  return element?.getAttribute('data-fisherai-project-archive-notice') === 'ok' ? element : null;
});
check('点「导出到目录」提示成功', Boolean(exportNotice), String(notice()?.textContent ?? ''));
check('提示里写了落到哪个目录',
  String(exportNotice?.textContent ?? '').includes(downloadsDir()),
  String(exportNotice?.textContent ?? '').slice(0, 160));
const filesAfter = existsSync(downloadsDir()) ? readdirSync(downloadsDir()).length : 0;
check('导出目录里真的多了一个文件', filesAfter === filesBefore + 1, `${filesBefore} → ${filesAfter}`);

// ---- B4. 「下载到浏览器」在没有 createObjectURL 的环境要给可执行的指路 ----
// node 的 URL 上确实有 createObjectURL，但 jsdom 里的 a[download] 不会真下载 ——
// 这里按「浏览器不支持」那条分支验：**失败时不许静默**，必须告诉用户改走「导出到本机目录」。
let restoreCreateObjectUrl = null;
try {
  restoreCreateObjectUrl = globalThis.URL.createObjectURL;
  delete globalThis.URL.createObjectURL;
} catch {
  restoreCreateObjectUrl = null;
}
click($('[aria-label="下载备份"]'));
const downloadNotice = await waitFor(() => {
  const element = notice();
  const text = String(element?.textContent ?? '');
  return /导出到本机目录|已交给浏览器下载/.test(text) ? element : null;
});
check('「下载到浏览器」要么成功、要么明确指路「导出到本机目录」（不静默）',
  /导出到本机目录/.test(String(downloadNotice?.textContent ?? '')),
  String(downloadNotice?.textContent ?? '').slice(0, 140));
if (restoreCreateObjectUrl) globalThis.URL.createObjectURL = restoreCreateObjectUrl;

// ---- B5. 选文件导入（真上传一份备份）----
const latestArchive = (() => {
  const files = readdirSync(downloadsDir())
    .filter((name) => name.endsWith('.fisherai'))
    .map((name) => join(downloadsDir(), name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return files[0] ?? '';
})();
check('找到了刚导出的那份备份文件', Boolean(latestArchive), latestArchive);

/** 提示条活 8 秒：每段动作前先清掉上一条，免得「等到的是上一步的提示」。 */
function clearToasts() {
  for (const element of $$('[data-fisherai-project-archive-toast]')) element.remove();
}
/** host 上现在有几个项目（用来等「真的多出一个」，不是读一次就比）。 */
async function projectCount() {
  return JSON.parse((await api('GET', '/workflows')).text).length;
}
async function waitForProjectCount(expected, timeoutMs = 12000) {
  const value = await waitFor(async () => ((await projectCount()) === expected ? true : null), timeoutMs);
  return Boolean(value);
}

const projectsBefore = await projectCount();
clearToasts();
click($('[aria-label="导入项目文件"]'));
const pickerInput = await waitFor(() => $('[data-fisherai-project-archive-input]'));
check('点「选择文件导入」会真的弹出一个 file input（隐藏）', Boolean(pickerInput));
if (pickerInput && latestArchive) {
  const file = new window.File([readFileSync(latestArchive)], 'backup.fisherai', {
    type: 'application/json',
  });
  attachFile(pickerInput, file);
}
const importToast = await waitFor(() => toast('ok'), 12000);
check('导入成功的提示条出现在页面底部（toast）', Boolean(importToast),
  String(toast('ok')?.textContent ?? ''));
check('提示条写了项目名与素材张数',
  /已导入/.test(String(importToast?.textContent ?? '')) &&
    /素材 2 个已恢复/.test(String(importToast?.textContent ?? '')),
  String(importToast?.textContent ?? '').slice(0, 160));
check('host 上真的多了一个项目', await waitForProjectCount(projectsBefore + 1),
  `${projectsBefore} → ${await projectCount()}`);
/** 导入后面板与画布都换过一轮（openProject 会切 view），等头部重新出现再往下走。 */
check('导入后画布切到了那个新项目（头部还在、view=canvas）',
  Boolean(await waitFor(() => $('.af-canvas-header'), 12000)));
await settle(600);
check('导入成功后画布面板自己收起（不挡着新项目）', !panel());

// ---- B6. 从本机路径导入 ----
console.log('\n=== B6. 从本机路径导入 ===');
await waitFor(() => $('[data-fisherai-project-archive-trigger]'), 12000);
click($('[data-fisherai-project-archive-trigger]'));
await waitFor(() => panel());
const pathInput = await waitFor(() => $('[data-fisherai-project-archive-path-input]'));
check('重开面板后路径输入框在', Boolean(pathInput));
if (pathInput) setInputValue(pathInput, latestArchive);
await settle(250);
const pathButton = $('[aria-label="从路径导入"]');
check('填了路径后「从路径导入」可用',
  Boolean(pathButton) && pathButton.disabled !== true, String(pathButton?.disabled));
const projectsBeforePath = await projectCount();
clearToasts();
click(pathButton);
const pathToast = await waitFor(() => {
  const element = toast('ok');
  return element && /已导入/.test(String(element.textContent ?? '')) ? element : null;
}, 12000);
check('从路径导入也弹出成功提示', Boolean(pathToast), String(toast('ok')?.textContent ?? ''));
check('从路径导入也在 host 上多出一个项目', await waitForProjectCount(projectsBeforePath + 1),
  `${projectsBeforePath} → ${await projectCount()}`);

// ---- B7. 项目看板头部的「导入项目」按钮 ----
console.log('\n=== B7. 项目看板头部的「导入项目」 ===');
const backButton = await waitFor(() => $('[data-fisherai-back-to-library]'), 12000);
check('回到项目库的按钮在（准备切看板）', Boolean(backButton));
click(backButton);
const importButton = await waitFor(() => $('[data-fisherai-project-import="true"]'), 15000);
check('看板头部有「导入项目」按钮', Boolean(importButton),
  `dashboards=${$$('div.min-h-screen').length} settings=${$$('[data-fisherai-dashboard-settings]').length}`);
check('按钮可访问（aria-label=导入项目）',
  importButton?.getAttribute('aria-label') === '导入项目',
  String(importButton?.getAttribute('aria-label')));
check('看板视图里画布面板没挂载（这条路只能走 window 桥）', !$('[data-fisherai-project-archive="panel"]'));
check('装配层注册了 window 桥（vendor 半靠它触发导入）',
  typeof window.__FISHERAI_PROJECT_ARCHIVE__?.importFromPicker === 'function');
const projectsBeforeDashboard = await projectCount();
clearToasts();
click(importButton);
const dashboardPicker = await waitFor(() => $('[data-fisherai-project-archive-input]'));
check('看板点「导入项目」也会弹出 file input', Boolean(dashboardPicker));
if (dashboardPicker && latestArchive) {
  attachFile(
    dashboardPicker,
    new window.File([readFileSync(latestArchive)], 'backup.fisherai', { type: 'application/json' }),
  );
}
const dashboardToast = await waitFor(() => {
  const element = toast('ok');
  return element && /已导入/.test(String(element.textContent ?? '')) ? element : null;
}, 12000);
check('看板导入成功后也有提示条', Boolean(dashboardToast),
  String(toast('ok')?.textContent ?? ''));
check('看板导入也在 host 上多出一个项目',
  await waitForProjectCount(projectsBeforeDashboard + 1),
  `${projectsBeforeDashboard} → ${await projectCount()}`);
check('看板导入完成后切回画布（fisherai:open-project 生效）',
  Boolean(await waitFor(() => $('.af-canvas-header'), 12000)));

// ---- B8. 排查读数 ----
console.log('\n=== B8. 排查读数与产物 ===');
const report = window.__FISHERAI_PROJECT_ARCHIVE__?.report?.() ?? {};
check('桥的 report 里能看到保存/导入计数',
  Number(report.saves ?? 0) >= 1 && Number(report.imports ?? 0) >= 3,
  JSON.stringify({ saves: report.saves, imports: report.imports, infoReads: report.infoReads }));
check('report 里列了四条接口',
  Array.isArray(report.routes) && report.routes.length === 4, JSON.stringify(report.routes));

{
  const canvasBundle = readFileSync(join(ROOT, 'lib/canvas/canvas-app.js'), 'utf8');
  check('画布产物里有面板契约属性', canvasBundle.includes('data-fisherai-project-archive'));
  check('画布产物里有看板导入按钮契约', canvasBundle.includes('data-fisherai-project-import'));
  check('画布产物里有关键 bridge 名', canvasBundle.includes('__FISHERAI_PROJECT_ARCHIVE__'));
  const hostBundle = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  check('host 产物里有 backup/info 与 backup/save',
    hostBundle.includes('backup/info') && hostBundle.includes('backup/save'));
  check('host 产物里有导出目录的越界拒绝码',
    hostBundle.includes('ARCHIVE_DIRECTORY_INVALID'));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  check('README 写了项目归档', readme.includes('项目归档'));
  const doc = readFileSync(join(ROOT, 'docs/canvas-ui-shadcn.md'), 'utf8');
  check('docs/canvas-ui-shadcn.md 写了项目归档的结构契约', doc.includes('data-fisherai-project-archive'));
  const storage = readFileSync(join(ROOT, 'docs/storage-and-migration.md'), 'utf8');
  check('docs/storage-and-migration.md 写了面板里怎么导出导入',
    storage.includes('项目归档'));
}

// ---------------------------------------------------------------- 汇总

console.log(`\nSUMMARY ${failures === 0 ? 'PASS' : 'FAIL'}  ${lines.length - failures}/${lines.length} 项通过`);
if (failures > 0) {
  console.log('\n失败项：');
  for (const line of lines) if (line.startsWith('FAIL')) console.log(line);
}
process.exit(failures === 0 ? 0 : 1);
