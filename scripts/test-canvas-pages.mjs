/**
 * 页面层回归（v1.84）：项目库 + 设置。
 *
 * 用户 2026-10-30 拍板的两屏，验证分两段：
 *   A. **host 数据面**（`/api/aifisher/canvas/projects*`）：节点/素材统计、缩略图、模型、
 *      收藏/归档/备注/复制/新建/删除 —— 这一层是页面「不撒谎」的地基，必须真读盘；
 *   B. **DOM 结构**：点顶栏「项目库」/ 侧栏「设置」能真的把两屏挂出来，卡片/列表/详情/
 *      四个分组都在，交互（搜索、光标辉光开关、缩放档位、Esc 关闭）落到了对应的存储上。
 *
 * 用法：node scripts/test-canvas-pages.mjs（需要先 build）
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const PROJECT_ID = 'projects-page-check';
const COPY_SOURCE_ID = 'projects-page-copy';

const host = await startHost();

/** 素材根（与 host 的 defaultMediaRoot 同一套推导：$DSH_HOME/storages/dsh-aifisher-canvas/media）。 */
const MEDIA_ROOT = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media');

function seedMedia(projectId, type, name, bytes, record) {
  const dir = join(MEDIA_ROOT, projectId, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), Buffer.alloc(bytes, 7));
  if (record) writeFileSync(join(dir, `${name}.json`), JSON.stringify(record), 'utf8');
}

const IMAGE_NODE = (id, x, y, title) => ({
  id,
  type: 'Image',
  x,
  y,
  title,
  prompt: '项目库回归',
  status: 'success',
  resultUrl: '/api/aifisher/canvas/media/projects-page-check/images/a.png',
  parentIds: [],
});

const DOC = {
  id: PROJECT_ID,
  revision: 0,
  title: '殿前 · 概念长镜头',
  nodes: [IMAGE_NODE('n1', 0, 0, '镜头 01'), IMAGE_NODE('n2', 360, 0, '镜头 02'), {
    id: 'n3',
    type: 'Video',
    x: 720,
    y: 0,
    title: '推轨',
    parentIds: [],
  }, {
    id: 'n4',
    type: 'Text',
    x: 0,
    y: 540,
    title: '脚本',
    parentIds: [],
  }, {
    id: 'n5',
    type: 'Reroute',
    x: 360,
    y: 900,
    title: '转接',
    parentIds: [],
  }],
  groups: [{ id: 'g1', title: '场景 A' }, { id: 'g2', title: '场景 B' }],
  viewport: { x: 0, y: 0, zoom: 1 },
};

{
  const saved = await host.hostApi('POST', '/workflows', DOC);
  check('预置一个 5 节点 / 2 分组的项目', saved.status === 200, String(saved.text).slice(0, 100));
  seedMedia(PROJECT_ID, 'images', 'a.png', 2048, {
    model: 'flux-dev-fp8',
    createdAt: '2026-10-30T12:00:00.000Z',
  });
  seedMedia(PROJECT_ID, 'images', 'b.png', 4096, {
    model: 'flux-dev-fp8',
    createdAt: '2026-10-30T12:01:00.000Z',
  });
  seedMedia(PROJECT_ID, 'videos', 'v.mp4', 8192, {
    model: 'minimax-h3',
    createdAt: '2026-10-30T12:02:00.000Z',
  });
}

/* ============================ A. host 数据面 ============================ */

{
  const listed = await host.hostApi('GET', '/projects');
  const payload = listed.json();
  check('GET /projects 返回列表 + 存储读数', listed.status === 200 && Array.isArray(payload.projects), String(listed.status));
  const card = (payload.projects ?? []).find((item) => item.id === PROJECT_ID);
  check('列表里能按 id 找到刚写入的项目', Boolean(card));
  check('节点总数 = 5', card?.nodeCount === 5, String(card?.nodeCount));
  check(
    '节点类型分开计数（图片 2 / 视频 1 / 文本 1 / 其他 1）',
    card?.nodeTypes?.image === 2 && card?.nodeTypes?.video === 1 && card?.nodeTypes?.text === 1 && card?.nodeTypes?.other === 1,
    JSON.stringify(card?.nodeTypes),
  );
  check('图 / 视频计数与素材目录一致', card?.imageCount === 2 && card?.videoCount === 1, `${card?.imageCount}/${card?.videoCount}`);
  check('素材字节 = 2048+4096+8192', card?.mediaBytes === 2048 + 4096 + 8192, String(card?.mediaBytes));
  check('缩略图是本插件素材 URL（最新一张图）', String(card?.thumbUrl ?? '').includes(`/media/${PROJECT_ID}/images/b.png`), String(card?.thumbUrl));
  check('最近生成带上了两张图', (card?.recent ?? []).length === 2, String((card?.recent ?? []).length));
  check('模型来自素材 sidecar（flux-dev-fp8 / minimax-h3）', (card?.models ?? []).includes('flux-dev-fp8'), JSON.stringify(card?.models));
  check('画布尺寸 = 节点包围盒（> 900 × 900）', (card?.width ?? 0) > 900 && (card?.height ?? 0) > 900, `${card?.width}×${card?.height}`);
  check('存储读数有素材字节', (payload.storage?.mediaBytes ?? 0) >= 14336, String(payload.storage?.mediaBytes));
}

{
  const favorite = await host.hostApi('POST', `/projects/${PROJECT_ID}/favorite`, { favorite: true });
  const archived = await host.hostApi('POST', `/projects/${PROJECT_ID}/status`, { status: 'archived' });
  const note = await host.hostApi('POST', `/projects/${PROJECT_ID}/note`, { note: '殿前的雾再薄一点' });
  check('收藏 / 归档 / 备注三个动作都回 200', favorite.status === 200 && archived.status === 200 && note.status === 200, `${favorite.status}/${archived.status}/${note.status}`);
  const listed = await host.hostApi('GET', '/projects');
  const card = (listed.json().projects ?? []).find((item) => item.id === PROJECT_ID);
  check('归档状态与备注读得回来', card?.status === 'archived' && card?.favorite === true && card?.note === '殿前的雾再薄一点', `${card?.status}/${card?.favorite}/${card?.note}`);
  // 归档的项目仍然在列表里（项目库要能显示「已归档」分组），只是带 status
  check('归档项目仍在列表里（供「已归档」分组）', Boolean(card));
}

{
  const created = await host.hostApi('POST', '/projects', { title: '空白项目' });
  const createdBody = created.json();
  check('POST /projects 新建空项目并回 id', created.status === 200 && typeof createdBody.id === 'string', String(created.text).slice(0, 80));
  const detail = await host.hostApi('GET', `/projects/${createdBody.id}`);
  check('新项目详情可读、节点数为 0', detail.status === 200 && detail.json().project.nodeCount === 0, String(detail.status));
}

{
  const duplicated = await host.hostApi('POST', `/projects/${PROJECT_ID}/duplicate`);
  const copy = duplicated.json();
  check('复制项目回新 id', duplicated.status === 200 && typeof copy.id === 'string' && copy.id !== PROJECT_ID, String(duplicated.text).slice(0, 100));
  const detail = await host.hostApi('GET', `/projects/${copy.id}`);
  const project = detail.json().project;
  check('复制件节点数一致', project?.nodeCount === 5, String(project?.nodeCount));
  check('复制件素材一起复制（3 个文件 / 同字节）', project?.mediaFiles === 3 && project?.mediaBytes === 14336, `${project?.mediaFiles}/${project?.mediaBytes}`);
  check(
    '复制件素材落在自己的项目目录里',
    existsSync(join(MEDIA_ROOT, copy.id, 'images')) &&
      readdirSync(join(MEDIA_ROOT, copy.id, 'images')).some((name) => name.startsWith('a')),
    copy.id,
  );
  {
    const doc = await host.hostApi('GET', `/workflows/${copy.id}`);
    const nodeUrl = String(doc.json()?.nodes?.[0]?.resultUrl ?? '');
    check(
      '复制件的节点 resultUrl 指向新项目（不是源项目）',
      nodeUrl.includes(`/media/${copy.id}/`) && !nodeUrl.includes(`/media/${PROJECT_ID}/`),
      nodeUrl,
    );
  }
  const removed = await host.hostApi('DELETE', `/projects/${copy.id}`);
  check('DELETE 删除项目', removed.status === 200, String(removed.text).slice(0, 80));
  const gone = await host.hostApi('GET', `/projects/${copy.id}`);
  check('删除后详情 404', gone.status === 404, String(gone.status));
  check('删除后素材进回收站', existsSync(join(MEDIA_ROOT, 'trash', copy.id)), join(MEDIA_ROOT, 'trash', copy.id));
}

/* ============================ B. DOM 结构 ============================ */

// 把主项目恢复成「未归档」，DOM 段才能验卡片墙里真的有它。
await host.hostApi('POST', `/projects/${PROJECT_ID}/status`, { status: 'active' });

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { container, canvasApp, handle } = await mountCanvasApp(window);
await settle(1600);
const doc = window.document;

const waitFor = async (probe, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = probe();
    if (value) return value;
    await settle(80);
  }
  return null;
};
const click = (element) =>
  element?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
/** React 受控输入：必须走原生 setter，否则 React 认不出值变了。 */
const setInputValue = (element, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
};

{
  const back = container.querySelector('[data-fisherai-back-to-library]');
  check('画布顶栏有「项目库」按钮', Boolean(back));
  click(back);
  const page = await waitFor(() => doc.querySelector('[data-fisherai-page="projects"]'));
  check('项目库页面挂上了（兄弟图层）', Boolean(page));
  check('项目库页面铺在画布容器里（不是塞进 vendor 树）', page?.closest('.af-canvas-mount') === container);
  check('顶栏标题是「项目库」', String(page?.querySelector('.afg-crumb-title')?.textContent ?? '') === '项目库');

  const cards = () => [...doc.querySelectorAll('[data-fisherai-project-card]')];
  await waitFor(() => cards().length > 0);
  check('卡片墙渲染出真实项目', cards().length >= 2, String(cards().length));
  check(
    '主项目在卡片墙里（带 data-project-id）',
    cards().some((card) => card.getAttribute('data-project-id') === PROJECT_ID),
    cards().map((card) => card.getAttribute('data-project-id')).join(','),
  );
  check('卡片上有封面 URL（来自真实素材）', Boolean(cards().find((c) => c.getAttribute('data-project-id') === PROJECT_ID)?.querySelector('img')));
  check('卡片墙末尾有「新建项目」卡', Boolean(doc.querySelector('[data-fisherai-project-new]')));
  check('左栏四个视图分组都在', doc.querySelectorAll('[data-fisherai-projects-facet]').length === 4);
  check('左栏有筛选 chip（图片/视频/文本）', doc.querySelectorAll('[data-fisherai-projects-kind]').length === 4);

  // 搜索：按名称过滤
  const search = doc.querySelector('[data-fisherai-projects-search]');
  check('顶栏有搜索框', Boolean(search));
  setInputValue(search, '殿前');
  await settle(240);
  check('搜索「殿前」把卡片收到 1 张', cards().length === 1, String(cards().length));
  setInputValue(search, '');
  await settle(240);

  // 视图切换 → 列表 + 右侧详情
  const listToggle = page?.querySelector('button[aria-label="列表视图"]');
  check('顶栏有列表视图切换', Boolean(listToggle));
  click(listToggle);
  await settle(240);
  check('切到列表视图后表格行出现', doc.querySelectorAll('[data-fisherai-project-row]').length >= 2, String(doc.querySelectorAll('[data-fisherai-project-row]').length));
  check('列表视图有右侧详情栏', Boolean(doc.querySelector('[data-fisherai-project-drawer]')));
  check('详情栏里有「打开画布」', Boolean(doc.querySelector('[data-fisherai-project-open]')));

  // Esc 关闭
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(200);
  check('Esc 关掉项目库页面', !doc.querySelector('[data-fisherai-page="projects"]'));

  // 再打开一次 → 点「打开画布」→ 页面关掉且画布真的切到那个项目（fisherai:open-project 生效）
  click(back);
  const reopened = await waitFor(() => doc.querySelector('[data-fisherai-page="projects"]'));
  check('项目库能再次打开', Boolean(reopened));
  await waitFor(() => doc.querySelector('[data-fisherai-project-card]'));
  const openButton = doc
    .querySelector(`[data-project-id="${PROJECT_ID}"]`)
    ?.querySelector('[data-fisherai-project-open]');
  check('卡片上有「打开」动作', Boolean(openButton));
  click(openButton);
  await settle(1400);
  check('点「打开」关掉页面', !doc.querySelector('[data-fisherai-page="projects"]'));
  check(
    '画布切到了该项目（头部标题变成项目名）',
    String(doc.querySelector('[title="点击重命名"]')?.textContent ?? '').includes('殿前'),
    String(doc.querySelector('[title="点击重命名"]')?.textContent ?? '(none)').slice(0, 40),
  );
}

{
  const settingsButton = container.querySelector('[data-fisherai-open-settings-page]');
  check('侧栏「设置」按钮带页面层标记', Boolean(settingsButton));
  click(settingsButton);
  const page = await waitFor(() => doc.querySelector('[data-fisherai-page="settings"]'));
  check('设置页挂上了', Boolean(page));
  check('设置页铺在画布容器里', page?.closest('.af-canvas-mount') === container);
  check('五组设置分区都在（外观 / 生成 / 服务与通道 / 项目与数据 / 高级）', doc.querySelectorAll('[data-fisherai-settings-section]').length === 5);
  check(
    '外观分组有真实缩放读数（100）',
    doc.querySelector('[data-fisherai-settings-scale]')?.getAttribute('data-fisherai-settings-scale') === '100',
    String(doc.querySelector('[data-fisherai-settings-scale]')?.getAttribute('data-fisherai-settings-scale')),
  );
  check('主题三选都在', doc.querySelectorAll('[data-fisherai-settings-theme]').length === 3);
  check(
    '只有玻璃面板可点，另两款置灰',
    [...doc.querySelectorAll('[data-fisherai-settings-theme]')].filter((button) => !button.disabled).length === 1,
  );
  check('外观分组有 B 的实时预览画布', Boolean(doc.querySelector('[data-fisherai-settings-theme-canvas]')));
  check('未接入项挂了「设计稿」标签', [...doc.querySelectorAll('.afs-draft')].length >= 5, String(doc.querySelectorAll('.afs-draft').length));

  // 缩放：点 125 档
  const tick = [...doc.querySelectorAll('.afs-ticks span')].find((item) => item.textContent === '125');
  check('缩放刻度里有 125 档', Boolean(tick));
  click(tick);
  await settle(200);
  check('点 125 写进 localStorage[af.uiScale]', window.localStorage.getItem('af.uiScale') === '1.25', window.localStorage.getItem('af.uiScale'));
  check(
    'html 上的 --af-ui-scale 同步成 1.25',
    doc.documentElement.style.getPropertyValue('--af-ui-scale') === '1.25',
    doc.documentElement.style.getPropertyValue('--af-ui-scale'),
  );

  // 光标辉光：真的落到 CanvasEffectsStore 的存储上
  const glow = doc.querySelector('[data-fisherai-settings-grid-glow]');
  check('光标辉光开关初始为 on', glow?.getAttribute('data-fisherai-settings-grid-glow') === 'on', String(glow?.getAttribute('data-fisherai-settings-grid-glow')));
  click(glow);
  await settle(200);
  let effects = {};
  try {
    effects = JSON.parse(window.localStorage.getItem('dsh-aifisher-canvas.canvas-effects') ?? '{}');
  } catch {
    effects = {};
  }
  check('关掉辉光后落盘 pointerGlow=false', effects.pointerGlow === false, JSON.stringify(effects));

  // 旧版设置（v1.85）：入口整块移除，里面还在用的面板改由这一页给宿主
  check('不再有「高级设置 / 打开旧版设置」入口', !doc.querySelector('[data-fisherai-settings-advanced]'));
  check(
    '服务与通道分区在',
    Boolean(doc.querySelector('[data-fisherai-settings-section="services"]')),
  );
  const hosts = [...doc.querySelectorAll('[data-fisherai-settings-host]')].map((node) =>
    node.getAttribute('data-fisherai-settings-host'),
  );
  for (const id of ['local-service', 'source', 'channels', 'data-dir', 'downloads', 'update']) {
    check(`旧对话框面板有页内宿主：${id}`, hosts.includes(id), hosts.join(','));
  }
  check('个人资料（昵称 / 头像）搬进设置页', Boolean(doc.querySelector('[data-fisherai-settings-profile]')));
  check('目录两行改成页内「更换」（不再开旧对话框）',
    doc.querySelectorAll('[data-fisherai-settings-goto-host]').length === 2,
    String(doc.querySelectorAll('[data-fisherai-settings-goto-host]').length));
  const buildInfo = canvasApp.canvasAppBuildInfo?.() ?? {};
  check('构建信息里 vendorSettings 已关掉', buildInfo.pages?.vendorSettings === false, JSON.stringify(buildInfo.pages ?? {}));
  check('构建信息里 pages.settings 为真', buildInfo.pages?.settings === true, JSON.stringify(buildInfo.pages ?? {}));

  // 恢复默认
  click(doc.querySelector('[data-fisherai-settings-reset]'));
  await settle(220);
  check('恢复默认把缩放写回 1', window.localStorage.getItem('af.uiScale') === '1', window.localStorage.getItem('af.uiScale'));

  // 页面里能跳回项目库
  const toProjects = [...page?.querySelectorAll('button') ?? []].find(
    (button) => String(button.textContent ?? '').trim() === '项目库',
  );
  check('设置页顶栏有「项目库」入口', Boolean(toProjects));

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(200);
  check('Esc 关掉设置页', !doc.querySelector('[data-fisherai-page="settings"]'));
}

{
  const status = await host.hostApi('GET', '/status');
  const body = status.json();
  check('/status 里报了项目库接口清单', Array.isArray(body.projects?.endpoints) && body.projects.endpoints.length >= 6, String(body.projects?.endpoints?.length));
}

handle?.dispose?.();
await settle(120);

console.log(lines.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}  (${lines.length} checks)`);
// 全量回归脚本（run-all-regressions.mjs）只认 SUMMARY 行，缺了它会把这一套直接判红。
console.log(`SUMMARY pass=${lines.length - failures} fail=${failures}`);
process.exit(failures === 0 ? 0 : 1);
