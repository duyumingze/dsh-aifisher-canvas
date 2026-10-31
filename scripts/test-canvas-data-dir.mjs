/**
 * 「项目数据目录（缓存）」回归 —— v1.43。
 *
 * 用户 2026-10-18 原话（整轮需求只有这一句）：「设置里添加项目自定义缓存目录」。
 *
 * 分两段验：
 *
 *   A. host 侧（真插件路由 + 临时 DSH_HOME）
 *      `GET/POST/DELETE /api/aifisher/canvas/data-dir`：校验五条边界（空/相对/是文件/就是默认目录/
 *      互为父子）、复制现有数据、写指针、**重启后真的用新目录**（再 apply 一个 host 实例来验）、
 *      恢复默认把指针删掉。
 *
 *   B. 真画布（jsdom 挂 lib/canvas/canvas-app.js）
 *      设置 → 存储 分区里出现「项目数据目录」面板 → 读数与默认目录对得上 →
 *      填相对路径点应用 → 明确报错 → 填合法目录点应用 → 提示「重启一次 DSH 生效」+ 备份复制了几份 →
 *      面板状态变成「已改到新目录但还没生效」→ 点「恢复默认」→ 回到默认。
 *
 * 用法：node scripts/test-canvas-data-dir.mjs   （需要先 build）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const PROJECT_ID = 'proj-data-dir';

const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-aifisher-datadir-'));
const defaultDir = () => join(fakeHome, 'storages', 'dsh-aifisher-canvas');
const pointerFile = () => join(defaultDir(), 'data-dir.json');
const newDir = () => join(fakeHome, 'custom-data');

const host = await startHost({ fakeHome });
const api = host.hostApi;

// ---------------------------------------------------------------- A0. 预置数据

console.log('=== A0. 预置一个项目 + 一张素材 ===');
{
  mkdirSync(join(defaultDir(), 'media', PROJECT_ID, 'images'), { recursive: true });
  writeFileSync(join(defaultDir(), 'media', PROJECT_ID, 'images', 'cover.png'), PNG);
  const saved = await api('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '数据目录验证',
    nodes: [
      {
        id: 'n1',
        type: 'Image',
        x: 0,
        y: 0,
        prompt: '数据目录验证',
        resultUrl: `/api/aifisher/canvas/media/${PROJECT_ID}/images/cover.png`,
      },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('项目写进默认目录', saved.status === 200, String(saved.status));
  check('默认目录里真的出现了 canvas.json', existsSync(join(defaultDir(), 'canvas.json')));
}

// ---------------------------------------------------------------- A1. 现状读数

console.log('\n=== A1. 现状读数 ===');
{
  const response = await api('GET', '/data-dir');
  const body = response.status === 200 ? response.json() : {};
  check('GET /data-dir 200', response.status === 200, String(response.status));
  check('active = 默认目录（进程正在用的那个）',
    (body.active ?? '').toLowerCase().endsWith(join('storages', 'dsh-aifisher-canvas').toLowerCase()),
    String(body.active));
  check('pending = active（还没设过自定义目录）', body.pending === body.active,
    `${body.pending} vs ${body.active}`);
  check('overridden=false / restartRequired=false',
    body.overridden === false && body.restartRequired === false,
    JSON.stringify({ overridden: body.overridden, restartRequired: body.restartRequired }));
  check('给出指针文件与默认目录读数',
    typeof body.pointerFile === 'string' && typeof body.default === 'string' &&
      body.default === body.active,
    String(body.pointerFile));
  check('给出重启后会用的 canvas.json / media 目录',
    String(body.canvasFile ?? '').endsWith('canvas.json') &&
      String(body.mediaDir ?? '').endsWith('media'),
    `${body.canvasFile} / ${body.mediaDir}`);
  const status = await api('GET', '/status');
  check('/status 里也能看到 dataDir（排查入口）',
    Boolean(status.json()?.dataDir) && status.json().dataDir.active === body.active,
    JSON.stringify(status.json()?.dataDir ?? null));
}

// ---------------------------------------------------------------- A2. 五条边界

console.log('\n=== A2. 边界校验 ===');
{
  const empty = await api('POST', '/data-dir', { directory: '   ' });
  check('空路径 → 422 DATA_DIR_EMPTY',
    empty.status === 422 && empty.json().code === 'DATA_DIR_EMPTY',
    `${empty.status} ${empty.json().code}`);

  const relative = await api('POST', '/data-dir', { directory: 'relative\\dir' });
  check('相对路径 → 422 DATA_DIR_NOT_ABSOLUTE',
    relative.status === 422 && relative.json().code === 'DATA_DIR_NOT_ABSOLUTE',
    `${relative.status} ${relative.json().code}`);

  const asFile = join(fakeHome, 'a-file.txt');
  writeFileSync(asFile, 'x');
  const isFile = await api('POST', '/data-dir', { directory: asFile });
  check('指向一个文件 → 422 DATA_DIR_IS_FILE',
    isFile.status === 422 && isFile.json().code === 'DATA_DIR_IS_FILE',
    `${isFile.status} ${isFile.json().code}`);

  const same = await api('POST', '/data-dir', { directory: defaultDir() });
  check('就是默认目录 → 422 DATA_DIR_SAME（该用「恢复默认」）',
    same.status === 422 && same.json().code === 'DATA_DIR_SAME',
    `${same.status} ${same.json().code}`);

  const nested = await api('POST', '/data-dir', { directory: join(defaultDir(), 'media', 'nested') });
  check('默认目录的子目录 → 422 DATA_DIR_NESTED',
    nested.status === 422 && nested.json().code === 'DATA_DIR_NESTED',
    `${nested.status} ${nested.json().code}`);

  check('这些失败都没写指针文件', !existsSync(pointerFile()));
}

// ---------------------------------------------------------------- A3. 应用新目录 + 复制

console.log('\n=== A3. 应用新目录（带复制）===');
{
  const applied = await api('POST', '/data-dir', { directory: newDir() });
  const body = applied.status === 200 ? applied.json() : {};
  check('POST /data-dir 200（合法目录）', applied.status === 200,
    `${applied.status} ${applied.text.slice(0, 120)}`);
  check('回执说清要重启（restartRequired=true / status=pending-restart）',
    body.restartRequired === true && body.status === 'pending-restart',
    JSON.stringify({ restartRequired: body.restartRequired, status: body.status }));
  check('pending 指向新目录', String(body.pending ?? '').toLowerCase() === newDir().toLowerCase(),
    String(body.pending));
  check('active 仍是旧目录（进程没热切换）',
    String(body.active ?? '').toLowerCase() !== newDir().toLowerCase(), String(body.active));
  check('回执带复制统计（至少 2 个文件：canvas.json + 素材）',
    Number(body.migration?.copiedFiles ?? 0) >= 2,
    JSON.stringify(body.migration ?? null));
  check('指针文件写在默认目录里（搬走数据后仍找得到）', existsSync(pointerFile()),
    pointerFile());
  check('新目录里真的有 canvas.json', existsSync(join(newDir(), 'canvas.json')));
  check('新目录里真的带上了素材',
    existsSync(join(newDir(), 'media', PROJECT_ID, 'images', 'cover.png')));
  check('旧目录没被删（只复制不搬）', existsSync(join(defaultDir(), 'canvas.json')));

  const again = await api('GET', '/data-dir');
  check('再读现状：restartRequired=true、overridden=true',
    again.json().restartRequired === true && again.json().overridden === true,
    JSON.stringify({ restartRequired: again.json().restartRequired, overridden: again.json().overridden }));

  // 同目录再应用一次：幂等（文件都在了 → 全部跳过），不会把新目录里的东西盖掉
  const sameAgain = await api('POST', '/data-dir', { directory: newDir() });
  check('把「已经配好的那个」再应用一次是幂等的（200，复制 0 份）',
    sameAgain.status === 200 && Number(sameAgain.json().migration?.copiedFiles ?? -1) === 0,
    `${sameAgain.status} ${JSON.stringify(sameAgain.json().migration ?? null)}`);
}

// ---------------------------------------------------------------- A4. 「重启后」真的用新目录

console.log('\n=== A4. 重启语义（再起一个 host 实例）===');
let restarted;
{
  // startHost 会重新 import + apply 一遍（同一进程、同一 DSH_HOME）——
  // 这正是「重启 DSH 之后」的效果：store / mediaStore / 各设置文件都按指针重算。
  restarted = await startHost({ fakeHome });
  const status = await restarted.hostApi('GET', '/status');
  const storePath = String(status.json()?.store?.path ?? '');
  check('重启后 store 落在新目录', storePath.toLowerCase() === join(newDir(), 'canvas.json').toLowerCase(),
    storePath);
  check('重启后用到的数据目录 = 新目录',
    String(status.json()?.dataDir?.active ?? '').toLowerCase() === newDir().toLowerCase(),
    String(status.json()?.dataDir?.active ?? ''));
  check('重启后 restartRequired=false（已经切过去了）',
    status.json()?.dataDir?.restartRequired === false,
    String(status.json()?.dataDir?.restartRequired));
  const projects = await restarted.hostApi('GET', '/workflows');
  const list = JSON.parse(projects.text);
  check('重启后项目还在（复制过来的 canvas.json 被读到了）',
    list.length === 1 && list[0].id === PROJECT_ID, JSON.stringify(list.map((item) => item.id)));
  check('重启后素材库根目录也在新目录',
    String(status.json()?.media?.rootDir ?? '').toLowerCase().startsWith(newDir().toLowerCase()),
    String(status.json()?.media?.rootDir ?? ''));
}

// ---------------------------------------------------------------- A5. 恢复默认

console.log('\n=== A5. 恢复默认 ===');
{
  // 用「重启后的那个实例」来删：它才是当前跑着的进程（active=新目录、pending=新目录）。
  // 用最初那个实例删的话，它在记忆里 active 还是默认目录，restartRequired 会算成 false —— 语义没错，
  // 但那不是用户会看到的那一面。
  const reset = await restarted.hostApi('DELETE', '/data-dir');
  check('DELETE /data-dir 200', reset.status === 200, String(reset.status));
  check('回执说清要重启（该进程还在用新目录）', reset.json().restartRequired === true,
    String(reset.json().restartRequired));
  check('指针文件被删掉', !existsSync(pointerFile()));
  const status = await restarted.hostApi('GET', '/data-dir');
  check('pending 回到默认目录',
    String(status.json().pending ?? '').toLowerCase() === defaultDir().toLowerCase(),
    String(status.json().pending));
  check('自定义目录本身没被删（用户的数据还在那儿）', existsSync(join(newDir(), 'canvas.json')));

  const restored = await startHost({ fakeHome });
  const restoredStatus = await restored.hostApi('GET', '/status');
  check('重启后回到默认目录',
    String(restoredStatus.json()?.store?.path ?? '').toLowerCase() ===
      join(defaultDir(), 'canvas.json').toLowerCase(),
    String(restoredStatus.json()?.store?.path ?? ''));
}

// ---------------------------------------------------------------- B. 设置页里的面板

console.log('\n=== B. 设置 → 存储 → 项目数据目录 ===');
{
  await api('DELETE', '/data-dir');
  const { window } = await createCanvasDom({ dispatch: host.dispatch });
  seedResume(window, PROJECT_ID);
  await mountCanvasApp(window);
  await settle(1500);

  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];
  const click = (element) => {
    if (!element) return false;
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  };
  async function waitFor(probe, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await probe();
      if (last) return last;
      await settle(120);
    }
    return last;
  }
  const setInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };

  window.dispatchEvent(new window.CustomEvent('fisherai:open-settings'));
  const settingsPage = await waitFor(() => $('[data-fisherai-page="settings"]'));
  check('设置页打开了（v1.85：页面层，不是旧对话框）', Boolean(settingsPage));
  check('旧版设置对话框没有出现', $('[data-fisherai-settings="true"]') === null);
  const dataTab = await waitFor(() => $('[data-fisherai-settings-nav="data"]'));
  click(dataTab);
  const panel = await waitFor(() => $('[data-fisherai-data-dir="panel"]'));
  check('「项目与数据」分区里有「项目数据目录」面板', Boolean(panel));
  check('面板可访问（有标题 id + aria-labelledby）',
    panel?.getAttribute('aria-labelledby') === 'fisherai-data-dir-title' &&
      Boolean($('#fisherai-data-dir-title')),
    String(panel?.getAttribute('aria-labelledby')));

  const current = await waitFor(() => {
    const text = String($('[data-fisherai-data-dir-current]')?.textContent ?? '');
    return text && text !== '（读不到）' ? text : '';
  });
  check('当前目录读数 = 默认目录（这条 host 正在用的那个）',
    String(current).toLowerCase() === defaultDir().toLowerCase(), String(current));
  check('默认目录读数也写出来了',
    String($('[data-fisherai-data-dir-default]')?.textContent ?? '').toLowerCase() ===
      defaultDir().toLowerCase(),
    String($('[data-fisherai-data-dir-default]')?.textContent ?? ''));
  const statusText = String($('[data-fisherai-data-dir-status]')?.textContent ?? '');
  check('状态文案说「正在使用默认目录」', /正在使用默认目录/.test(statusText), statusText);
  check('输入框预填当前目录',
    String($('[data-fisherai-data-dir-input]')?.value ?? '').toLowerCase() ===
      defaultDir().toLowerCase(),
    String($('[data-fisherai-data-dir-input]')?.value ?? ''));
  check('「恢复默认」在没改过时不可点',
    $('[aria-label="恢复默认数据目录"]')?.disabled === true);
  check('有「复制现有数据」勾选项且默认勾上',
    $('[data-fisherai-data-dir-migrate]')?.checked === true);

  // 相对路径 → 明确报错
  const input = $('[data-fisherai-data-dir-input]');
  setInputValue(input, 'relative\\dir');
  await settle(200);
  click($('[aria-label="应用数据目录"]'));
  const errorNotice = await waitFor(() => {
    const element = $('[data-fisherai-data-dir-notice="error"]');
    return element ? element : null;
  });
  check('填相对路径点应用 → 面板报错（不假装成功）',
    /绝对路径/.test(String(errorNotice?.textContent ?? '')),
    String(errorNotice?.textContent ?? ''));

  // 合法目录 → 提示「重启生效 + 复制了几份」
  const target = join(fakeHome, 'panel-target');
  setInputValue(input, target);
  await settle(200);
  click($('[aria-label="应用数据目录"]'));
  const okNotice = await waitFor(() => {
    const element = $('[data-fisherai-data-dir-notice="ok"]');
    return element ? element : null;
  });
  check('填合法目录点应用 → 面板给出 OK 提示',
    Boolean(okNotice), String(okNotice?.textContent ?? ''));
  check('提示里写清「重启一次 DSH」才生效',
    /重启一次 DSH/.test(String(okNotice?.textContent ?? '')),
    String(okNotice?.textContent ?? ''));
  check('提示里带复制统计', /已复制 \d+ 个文件/.test(String(okNotice?.textContent ?? '')),
    String(okNotice?.textContent ?? ''));
  const afterText = await waitFor(() => {
    const text = String($('[data-fisherai-data-dir-status]')?.textContent ?? '');
    return /还没生效/.test(text) ? text : '';
  });
  check('面板状态变成「还没生效」', Boolean(afterText), String(afterText));
  check('面板标记 restart=true（真机/回归都能读）',
    panel?.getAttribute('data-fisherai-data-dir-restart') === 'true',
    String(panel?.getAttribute('data-fisherai-data-dir-restart')));
  check('host 上指针文件写好了（面板操作真的落到 host）', existsSync(pointerFile()));
  check('新目录里也有数据（复制的）', existsSync(join(target, 'canvas.json')));

  // 恢复默认
  click($('[aria-label="恢复默认数据目录"]'));
  const resetNotice = await waitFor(() => {
    const element = $('[data-fisherai-data-dir-notice="ok"]');
    return element && /恢复默认目录/.test(String(element.textContent ?? '')) ? element : null;
  });
  check('点「恢复默认」也能恢复',
    Boolean(resetNotice), String(resetNotice?.textContent ?? ''));
  check('恢复之后指针文件没了', !existsSync(pointerFile()));
  check('面板回到默认（overridden=false）',
    panel?.getAttribute('data-fisherai-data-dir-overridden') === 'false',
    String(panel?.getAttribute('data-fisherai-data-dir-overridden')));
}

// ---------------------------------------------------------------- C. 产物与文档

console.log('\n=== C. 产物与文档 ===');
{
  const canvasBundle = readFileSync(join(ROOT, 'lib/canvas/canvas-app.js'), 'utf8');
  check('画布产物里有面板契约属性', canvasBundle.includes('data-fisherai-data-dir'));
  check('画布产物里有挂载点桥名', canvasBundle.includes('__FISHERAI_MOUNT_DATA_DIR__'));
  check('画布产物里没有残留的「storages/dsh-aifisher-canvas」硬编码解析（走 resolveDataDir）',
    !canvasBundle.includes("join(home_'storages'"));
  const hostBundle = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  check('host 产物里有 data-dir 接口与错误码',
    hostBundle.includes('DATA_DIR_NOT_ABSOLUTE') && hostBundle.includes('DATA_DIR_NESTED'));
  check('host 产物里有指针文件名', hostBundle.includes('data-dir.json'));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  check('README 写了「项目数据目录」', readme.includes('项目数据目录'));
  const doc = readFileSync(join(ROOT, 'docs/canvas-ui-shadcn.md'), 'utf8');
  check('docs/canvas-ui-shadcn.md 写了数据目录面板的契约',
    doc.includes('data-fisherai-data-dir'));
  const storage = readFileSync(join(ROOT, 'docs/storage-and-migration.md'), 'utf8');
  check('docs/storage-and-migration.md 写了怎么改数据目录',
    storage.includes('项目数据目录'));
}

// 收尾：临时 host 目录不删（--keep 一致性），但把自定义目录清掉免得占空间
try {
  rmSync(newDir(), { recursive: true, force: true });
} catch {
  /* 删不掉不影响结论 */
}

console.log(`\nSUMMARY ${failures === 0 ? 'PASS' : 'FAIL'}  ${lines.length - failures}/${lines.length} 项通过`);
if (failures > 0) {
  console.log('\n失败项：');
  for (const line of lines) if (line.startsWith('FAIL')) console.log(line);
}
process.exit(failures === 0 ? 0 : 1);
