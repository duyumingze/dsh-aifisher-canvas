/**
 * 画布「资产库 / 本地 SKILL 预设」回归测试。
 *
 * 覆盖 src/host/canvas/libraryRouter.ts 的全部端点（假 req/res 打真路由）：
 *   保存到资产库 / 列表 / 编辑 / 删除、把库里素材导入项目、
 *   本地 SKILL 预设的保存（含素材快照）/ 列表 / 导入（含素材复制 + 节点引用改写）/ 删除。
 *
 * 断言的重点是**前端真实消费的形状**（不猜）：
 *   - `canvasLibrary.tsx`：GET 返回数组；PATCH 回 `{success, asset.id === id}`；DELETE 回 `{success:true}`；
 *   - `canvasLibraryGrid.tsx`：列表项 id/name/category/ownership/type(单数)/url；
 *   - `canvasAssetInsertion.ts` + `assetNode()`：import 回的 asset.type 是**复数**、url 指向
 *     `/media/<项目>/<类型>/`、带 nodeType/prompt/model/aspectRatio…；
 *   - `canvasAssetControl.ts`（agent）：列表项 type ∈ image|video|audio、import 的 url 落在目标项目下；
 *   - `canvasWorkflowPresets.ts`：POST /library/workflows {name,category,coverDataUrl,nodes}；
 *     POST /library/workflows/import 回 `{workflow:{nodes:[{id,type,x,y}…]}}`。
 *
 * 另外覆盖：路径穿越（`..` / 绝对路径 / 盘符）、跨站 Origin 围栏、未匹配子路径仍 501。
 *
 * 用法：node scripts/test-canvas-library.mjs   （需要先 build）
 * 数据落在临时 DSH_HOME 下，不会碰真实画布数据。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lines = [];
let failures = 0;

function check(name, condition, extra = '') {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}

// ---------------------------------------------------------------- 假 req / res

function makeReq(method, url, body) {
  const stream = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')],
  );
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
  }
  writeHead(status, headers) {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    callback();
  }
  buffer() {
    return Buffer.concat(this.chunks);
  }
  text() {
    return this.buffer().toString('utf8');
  }
  json() {
    return JSON.parse(this.text());
  }
}

// ---------------------------------------------------------------- 挂载插件

const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-aifisher-library-'));
const workDir = mkdtempSync(join(tmpdir(), 'dsh-aifisher-library-fixtures-'));
process.env.DSH_HOME = fakeHome;

const routes = new Map();
const fakeWebServer = {
  register(route) {
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  },
};
const ctxStub = {
  get(name) {
    if (name === 'webServer') return fakeWebServer;
    if (name === 'skills') return { list: async () => [], get: async () => null };
    return undefined;
  },
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: () => () => {} },
};

const hostMod = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
hostMod.apply(ctxStub);

const canvasRoute = routes.get('/api/aifisher/canvas');
check('画布后端路由已注册', typeof canvasRoute?.handler === 'function');

function waitForFinish(res) {
  if (res.writableFinished) return Promise.resolve();
  return new Promise((done) => res.once('finish', done));
}

async function raw(method, path, body, headers) {
  const res = new FakeResponse();
  const req = makeReq(method, `/api/aifisher/canvas${path}`, body);
  if (headers) req.headers = headers;
  await canvasRoute.handler(req, res);
  await waitForFinish(res);
  return res;
}

async function api(method, path, body) {
  return raw(method, path, body);
}

/** 把列表项/导入结果里的 URL 去掉画布前缀，换成可以直接打路由的路径。 */
function toRoutePath(url) {
  return url.startsWith('/api/aifisher/canvas') ? url.slice('/api/aifisher/canvas'.length) : url;
}

// ---------------------------------------------------------------- 数据落点

const STORAGE_DIR = join(fakeHome, 'storages', 'dsh-aifisher-canvas');
const MEDIA_DIR = join(STORAGE_DIR, 'media');
const LIBRARY_FILE = join(STORAGE_DIR, 'library.json');
const TRASH_DIR = join(MEDIA_DIR, 'trash');

// ---------------------------------------------------------------- 造素材（真文件，走真上传管道）

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const pngPath = join(workDir, 'cover.png');
const mp4Path = join(workDir, 'clip.mp4');
const mp3Path = join(workDir, 'tone.mp3');
writeFileSync(pngPath, Buffer.from(PNG_BASE64, 'base64'));
writeFileSync(mp4Path, Buffer.from('ftypisom-video-bytes-'.repeat(32), 'utf8'));
writeFileSync(mp3Path, Buffer.from('ID3-audio-bytes-'.repeat(32), 'utf8'));
const pngBytes = readFileSync(pngPath);

// ---------------------------------------------------------------- 0. 初始状态

{
  const list = await api('GET', '/library');
  check('GET /library 空库返回数组', list.statusCode === 200 && Array.isArray(list.json()), `${list.statusCode} ${list.text().slice(0, 120)}`);

  const workflows = await api('GET', '/library/workflows');
  check('GET /library/workflows 空库返回数组', workflows.statusCode === 200 && Array.isArray(workflows.json()), `${workflows.statusCode}`);

  // 更深一层的未知子路径没人认领 → 交回 restRouter 走 NOT_PORTED（而不是假装 404）
  const unknown = await api('GET', '/library/nope/extra');
  check('未匹配的 /library 子路径仍回落 501 NOT_PORTED', unknown.statusCode === 501 && unknown.json().code === 'NOT_PORTED', `${unknown.statusCode} ${unknown.text().slice(0, 120)}`);

  // 形状匹配但方法不对 → 405（与素材路由同一套约定）
  const wrongMethod = await api('GET', '/library/nope');
  check('GET /library/:id（只有 PATCH/DELETE）→ 405', wrongMethod.statusCode === 405, `${wrongMethod.statusCode}`);

  const canvasProjects = await api('GET', '/workflows');
  check('画布项目库仍为空数组（资产库没往项目库里塞东西）', canvasProjects.statusCode === 200 && canvasProjects.json().length === 0);
}

// ---------------------------------------------------------------- 1. 先把素材放进一个普通项目（库的素材来源）

const source = {};
{
  const image = await api('POST', '/assets/import/images', { path: pngPath, projectId: 'proj-src', filename: 'cover.png' });
  source.image = image.json();
  check('素材导入（图片）走通', image.statusCode === 200 && source.image.url.startsWith('/api/aifisher/canvas/media/proj-src/images/'), `${image.statusCode} ${image.text().slice(0, 120)}`);

  const video = await api('POST', '/assets/import/videos', { path: mp4Path, projectId: 'proj-src', filename: 'clip.mp4' });
  source.video = video.json();
  check('素材导入（视频）走通', video.statusCode === 200 && source.video.url.includes('/videos/'), `${video.statusCode}`);

  const audio = await api('POST', '/assets/import/audios', { path: mp3Path, projectId: 'proj-src', filename: 'tone.mp3' });
  source.audio = audio.json();
  check('素材导入（音频）走通', audio.statusCode === 200 && source.audio.url.includes('/audios/'), `${audio.statusCode}`);
}

// ---------------------------------------------------------------- 2. 保存到资产库

const saved = {};
{
  const image = await api('POST', '/library', {
    sourceUrl: source.image.url,
    name: '雨夜街道',
    category: '场景',
    ownership: '短剧A',
    meta: { nodeType: 'Image', sourceType: 'generated', prompt: '雨夜街道', model: 'imagen-3', aspectRatio: '16:9' },
  });
  saved.image = image.json();
  check(
    'POST /library（本站素材）→ {success, asset}',
    image.statusCode === 200 &&
      saved.image.success === true &&
      typeof saved.image.asset?.id === 'string' &&
      saved.image.asset.name === '雨夜街道' &&
      saved.image.asset.category === '场景' &&
      saved.image.asset.ownership === '短剧A' &&
      saved.image.asset.type === 'image',
    `${image.statusCode} ${image.text().slice(0, 200)}`,
  );
  check(
    '库里的素材是库自己那份副本（URL 落在 library 项目下）',
    saved.image.asset.url.startsWith('/api/aifisher/canvas/media/library/images/'),
    String(saved.image.asset.url),
  );
  check('保存回执带画布建节点要用的元数据', saved.image.asset.prompt === '雨夜街道' && saved.image.asset.model === 'imagen-3' && saved.image.asset.nodeType === 'Image', JSON.stringify({ prompt: saved.image.asset.prompt, model: saved.image.asset.model }));

  const video = await api('POST', '/library', {
    sourceUrl: source.video.url,
    name: '镜头B',
    category: '分镜',
    ownership: '',
    meta: { nodeType: 'Video', sourceType: 'generated', duration: 3 },
  });
  saved.video = video.json();
  check('POST /library（视频）→ type=video、duration 保留', video.statusCode === 200 && saved.video.asset.type === 'video' && saved.video.asset.duration === 3, `${video.statusCode} ${JSON.stringify(saved.video.asset?.duration)}`);

  // data URL 分支（前端把画布编辑结果直接塞过来时走这条）
  const audio = await api('POST', '/library', {
    sourceUrl: `data:audio/mpeg;base64,${readFileSync(mp3Path).toString('base64')}`,
    name: '旁白',
    category: '音频',
    ownership: '短剧A',
    meta: { nodeType: 'Audio', sourceType: 'upload', prompt: '旁白' },
  });
  saved.audio = audio.json();
  check('POST /library（data URL）→ type=audio', audio.statusCode === 200 && saved.audio.asset.type === 'audio', `${audio.statusCode} ${audio.text().slice(0, 200)}`);

  // 上游旧形状：vendor 的命名空间改写只覆盖「前缀判断/模板拼接」那几处，
  // 画布里仍有拼 /library/media/... 的地方，这条路径不能因为形状旧就存不进库
  const legacyUrl = source.image.url.replace('/api/aifisher/canvas/media/', '/library/media/');
  const legacy = await api('POST', '/library', { sourceUrl: legacyUrl, name: '旧形状素材', category: '场景' });
  check('POST /library 也认上游 /library/media 旧形状', legacy.statusCode === 200 && legacy.json().asset?.name === '旧形状素材', `${legacy.statusCode} ${legacy.text().slice(0, 160)}`);
  const legacyRemoved = await api('DELETE', `/library/${legacy.json().asset.id}`);
  check('（清场）旧形状条目可删除', legacyRemoved.statusCode === 200, `${legacyRemoved.statusCode}`);

  const noName = await api('POST', '/library', { sourceUrl: source.image.url, name: '', category: '场景' });
  check('POST /library 缺名称 → 400 INVALID_LIBRARY_FIELDS', noName.statusCode === 400 && noName.json().code === 'INVALID_LIBRARY_FIELDS', `${noName.statusCode}`);

  const tooLong = await api('POST', '/library', { sourceUrl: source.image.url, name: 'x', category: 'y'.repeat(81) });
  check('POST /library 分类超长 → 400', tooLong.statusCode === 400, `${tooLong.statusCode}`);

  const noSource = await api('POST', '/library', { name: 'x', category: 'y' });
  check('POST /library 缺 sourceUrl → 422 INVALID_LIBRARY_BODY', noSource.statusCode === 422 && noSource.json().code === 'INVALID_LIBRARY_BODY', `${noSource.statusCode}`);

  const missing = await api('POST', '/library', { sourceUrl: 'D:\\secret\\nope.png', name: 'x', category: 'y' });
  check('POST /library 源文件不存在 → 404 LIBRARY_SOURCE_MISSING', missing.statusCode === 404 && missing.json().code === 'LIBRARY_SOURCE_MISSING', `${missing.statusCode} ${missing.text().slice(0, 160)}`);

  const traversalSource = await api('POST', '/library', { sourceUrl: '../../canvas.json', name: 'x', category: 'y' });
  check('POST /library 源地址穿越 → 404（不解析成路径）', traversalSource.statusCode === 404, `${traversalSource.statusCode}`);
}

// ---------------------------------------------------------------- 3. 列表

{
  const list = (await api('GET', '/library')).json();
  check('GET /library 列出 3 条', list.length === 3, `${list.length} ${JSON.stringify(list.map((item) => item.name))}`);
  const stamps = list.map((item) => Date.parse(String(item.createdAt)));
  check(
    '列表按保存时间倒序',
    stamps.every((value, index) => index === 0 || stamps[index - 1] >= value),
    JSON.stringify(list.map((item) => item.createdAt)),
  );
  check(
    '列表项带前端网格要的全部字段',
    list.every((item) => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.category === 'string' && typeof item.ownership === 'string' && typeof item.type === 'string' && typeof item.url === 'string'),
    JSON.stringify(list[0]).slice(0, 200),
  );
  check(
    '列表项 type 是单数（agent 的 assets 只认 image/video/audio）',
    list.every((item) => ['image', 'video', 'audio'].includes(item.type)),
    JSON.stringify(list.map((item) => item.type)),
  );
  check(
    'agent 的 assets 过滤条件能在真实列表上跑通',
    list.filter((item) => item && typeof item.id === 'string' && ['image', 'video', 'audio'].includes(item.type) && `${item.name} ${item.title} ${item.category}`.toLowerCase().includes('场景')).length === 1,
  );

  // 列表里的 URL 真能取到字节（画布把它当 <img src> / 侧边预览用）
  const fetched = await raw('GET', toRoutePath(list.find((item) => item.name === '雨夜街道').url));
  check('列表项 URL 可取到素材本体且字节一致', fetched.statusCode === 200 && fetched.buffer().equals(pngBytes), `${fetched.statusCode} ${fetched.buffer().length}`);

  check('library.json 已落盘', existsSync(LIBRARY_FILE), LIBRARY_FILE);
  const index = JSON.parse(readFileSync(LIBRARY_FILE, 'utf8'));
  check('library.json 索引含 3 条资产', Object.keys(index.assets ?? {}).length === 3, JSON.stringify(Object.keys(index.assets ?? {})));
  check('库里的素材副本落在 media/library/<类型>/ 下', existsSync(join(MEDIA_DIR, 'library', 'images')) && readdirSync(join(MEDIA_DIR, 'library', 'images')).some((name) => name.endsWith('.png')), join(MEDIA_DIR, 'library', 'images'));
}

// ---------------------------------------------------------------- 4. 编辑（PATCH AssetFields）

const imageId = saved.image.asset.id;
{
  const patched = await api('PATCH', `/library/${encodeURIComponent(imageId)}`, {
    name: '雨夜街道-改',
    category: '场景/夜景',
    ownership: '短剧B',
  });
  const body = patched.json();
  check(
    'PATCH /library/:id → {success:true, asset.id===id}（前端回执校验的形状）',
    patched.statusCode === 200 && body.success === true && body.asset?.id === imageId,
    `${patched.statusCode} ${patched.text().slice(0, 200)}`,
  );
  check('编辑后名称/分类/归属都更新', body.asset?.name === '雨夜街道-改' && body.asset?.category === '场景/夜景' && body.asset?.ownership === '短剧B', JSON.stringify({ name: body.asset?.name, category: body.asset?.category }));
  check('编辑不动素材地址（既有画布引用不失效）', body.asset?.url === saved.image.asset.url, String(body.asset?.url));

  const reloaded = (await api('GET', '/library')).json().find((item) => item.id === imageId);
  check('编辑结果可从列表读回', reloaded?.name === '雨夜街道-改' && reloaded?.ownership === '短剧B', JSON.stringify(reloaded?.name));

  const extraKey = await api('PATCH', `/library/${encodeURIComponent(imageId)}`, { name: 'a', category: 'b', ownership: '', extra: 1 });
  check('PATCH 带白名单外的字段 → 400', extraKey.statusCode === 400, `${extraKey.statusCode}`);

  const missingField = await api('PATCH', `/library/${encodeURIComponent(imageId)}`, { name: 'a', category: 'b' });
  check('PATCH 缺 ownership → 400', missingField.statusCode === 400, `${missingField.statusCode}`);

  const unknownId = await api('PATCH', '/library/lib-does-not-exist', { name: 'a', category: 'b', ownership: '' });
  check('PATCH 未知 id → 404 LIBRARY_ASSET_NOT_FOUND', unknownId.statusCode === 404 && unknownId.json().code === 'LIBRARY_ASSET_NOT_FOUND', `${unknownId.statusCode}`);

  const traversalId = await api('PATCH', '/library/..%2F..%2Fcanvas.json', { name: 'a', category: 'b', ownership: '' });
  check('PATCH 穿越 id → 400 INVALID_LIBRARY_ID', traversalId.statusCode === 400 && traversalId.json().code === 'INVALID_LIBRARY_ID', `${traversalId.statusCode} ${traversalId.text().slice(0, 120)}`);

  const wrongMethod = await api('PUT', '/library');
  check('PUT /library → 405', wrongMethod.statusCode === 405, `${wrongMethod.statusCode}`);
}

// ---------------------------------------------------------------- 5. 导入到项目

{
  const imported = await api('POST', '/library/import', { id: imageId, projectId: 'proj-lib' });
  const body = imported.json();
  check('POST /library/import → {success, asset}', imported.statusCode === 200 && body.success === true && typeof body.asset === 'object', `${imported.statusCode} ${imported.text().slice(0, 200)}`);
  check(
    '导入结果的 type 是复数（assetNode 认 images/videos/audios）',
    ['images', 'videos', 'audios'].includes(body.asset?.type),
    String(body.asset?.type),
  );
  check(
    '导入 URL 落在目标项目下（agent 的 URL 校验用这条）',
    body.asset.url.startsWith('/api/aifisher/canvas/media/proj-lib/images/'),
    String(body.asset?.url),
  );

  const onDisk = join(MEDIA_DIR, 'proj-lib', 'images', decodeURIComponent(body.asset.url.split('/').pop()));
  check('导入的素材真落盘到目标项目目录', existsSync(onDisk) && readFileSync(onDisk).equals(pngBytes), onDisk);

  const fetched = await raw('GET', toRoutePath(body.asset.url));
  check('导入后的素材 URL 可取回', fetched.statusCode === 200 && fetched.buffer().equals(pngBytes), `${fetched.statusCode}`);

  check(
    '导入结果带画布建节点需要的字段（name/title/prompt/nodeType/model/mediaType）',
    body.asset.name === '雨夜街道-改' && body.asset.title === '雨夜街道-改' && typeof body.asset.prompt === 'string' && body.asset.nodeType === 'Image' && body.asset.model === 'imagen-3' && body.asset.mediaType === 'image',
    JSON.stringify({ name: body.asset.name, title: body.asset.title, nodeType: body.asset.nodeType, mediaType: body.asset.mediaType }),
  );

  const again = await api('POST', '/library/import', { id: imageId, projectId: 'proj-lib' });
  check('再次导入是另一份副本（每次都复制，不复用同文件）', again.json().asset.url !== body.asset.url, `${again.json().asset.url}`);

  const defaultProject = await api('POST', '/library/import', { id: imageId });
  check('缺省 projectId → default 项目', defaultProject.statusCode === 200 && defaultProject.json().asset.url.includes('/media/default/'), String(defaultProject.json().asset?.url));

  const unknown = await api('POST', '/library/import', { id: 'lib-nope', projectId: 'proj-lib' });
  check('导入未知 id → 404 LIBRARY_ASSET_NOT_FOUND', unknown.statusCode === 404 && unknown.json().code === 'LIBRARY_ASSET_NOT_FOUND', `${unknown.statusCode}`);

  const pathTraversal = await api('POST', '/library/import', { id: imageId, projectId: '../evil' });
  check('导入穿越 projectId（..）→ 400', pathTraversal.statusCode === 400 && pathTraversal.json().code === 'INVALID_LIBRARY_SEGMENT', `${pathTraversal.statusCode} ${pathTraversal.text().slice(0, 120)}`);

  const driveLetter = await api('POST', '/library/import', { id: imageId, projectId: 'C:\\evil' });
  check('导入穿越 projectId（盘符）→ 400', driveLetter.statusCode === 400, `${driveLetter.statusCode}`);

  const absolute = await api('POST', '/library/import', { id: imageId, projectId: '/etc/evil' });
  check('导入穿越 projectId（绝对路径）→ 400', absolute.statusCode === 400, `${absolute.statusCode}`);

  check(
    '穿越尝试没有在 storages 外/内留下目录',
    !existsSync(join(STORAGE_DIR, 'evil')) && !existsSync(join(dirname(STORAGE_DIR), 'evil')),
    STORAGE_DIR,
  );
}

// ---------------------------------------------------------------- 6. 本地 SKILL 预设

let presetId = '';
let presetProject = '';
let presetNodeUrl = '';
let importedWorkflow = null;
{
  const presetAsset = (await api('GET', '/library')).json().find((item) => item.id === imageId);
  const nodes = [
    {
      id: 'node-a',
      type: 'Image',
      x: 100,
      y: 200,
      prompt: '雨夜街道',
      title: '素材节点',
      resultUrl: presetAsset.url,
      model: 'imagen-3',
      aspectRatio: '16:9',
    },
    { id: 'node-b', type: 'Text', x: 500, y: 200, prompt: '一段提示词', textContent: '一段提示词' },
  ];
  const created = await api('POST', '/library/workflows', {
    name: '雨夜组合.png',
    category: '图像 SKILL',
    coverDataUrl: `data:image/png;base64,${PNG_BASE64}`,
    nodes,
  });
  const body = created.json();
  presetId = body.workflow?.id;
  check(
    'POST /library/workflows → {success, workflow{id,name,category,coverUrl,nodeCount}}',
    created.statusCode === 200 && body.success === true && typeof presetId === 'string' && body.workflow.nodeCount === 2,
    `${created.statusCode} ${created.text().slice(0, 200)}`,
  );
  check('预设名去掉了媒体扩展名', body.workflow?.name === '雨夜组合', String(body.workflow?.name));
  check('预设封面 URL 已就绪（列表卡片要用）', String(body.workflow?.coverUrl).startsWith('/api/aifisher/canvas/media/workflow-preset-'), String(body.workflow?.coverUrl));

  const cover = await raw('GET', toRoutePath(body.workflow.coverUrl));
  check('预设封面可取到', cover.statusCode === 200 && cover.buffer().equals(pngBytes), `${cover.statusCode}`);

  const index = JSON.parse(readFileSync(LIBRARY_FILE, 'utf8'));
  const stored = index.workflows?.[presetId];
  presetProject = stored?.projectId ?? '';
  presetNodeUrl = String(stored?.nodes?.[0]?.resultUrl ?? '');
  check('预设索引里节点已落库', Array.isArray(stored?.nodes) && stored.nodes.length === 2, JSON.stringify(Object.keys(index.workflows ?? {})));
  check(
    '预设自带素材（快照进 workflow-preset 项目，原项目删了也不坏）',
    presetNodeUrl.startsWith('/api/aifisher/canvas/media/workflow-preset-') && presetProject.startsWith('workflow-preset-'),
    presetNodeUrl,
  );
  check(
    '快照素材真落盘',
    existsSync(join(MEDIA_DIR, presetProject, 'images', decodeURIComponent(presetNodeUrl.split('/').pop()))),
    join(MEDIA_DIR, presetProject, 'images'),
  );

  const list = (await api('GET', '/library/workflows')).json();
  check('GET /library/workflows 列出 1 条', list.length === 1 && list[0].id === presetId && list[0].category === '图像 SKILL', JSON.stringify(list).slice(0, 200));

  // 导入：素材复制进目标项目 + 节点引用改写
  const imported = await api('POST', '/library/workflows/import', { id: presetId, projectId: 'proj-wf' });
  const importedBody = imported.json();
  importedWorkflow = importedBody.workflow;
  check(
    'POST /library/workflows/import → {success, workflow{name,category,nodes}}',
    imported.statusCode === 200 && importedBody.success === true && Array.isArray(importedWorkflow?.nodes) && importedWorkflow.nodes.length === 2,
    `${imported.statusCode} ${imported.text().slice(0, 200)}`,
  );
  check(
    '导入节点引用被改写到目标项目',
    String(importedWorkflow?.nodes?.[0]?.resultUrl).startsWith('/api/aifisher/canvas/media/proj-wf/images/'),
    String(importedWorkflow?.nodes?.[0]?.resultUrl),
  );
  check(
    '导入时素材字节真的复制进目标项目',
    existsSync(join(MEDIA_DIR, 'proj-wf', 'images', decodeURIComponent(String(importedWorkflow.nodes[0].resultUrl).split('/').pop()))),
    join(MEDIA_DIR, 'proj-wf', 'images'),
  );
  check(
    '导入节点满足 instantiateWorkflowPreset 的硬要求（id/type/x/y）',
    importedWorkflow.nodes.every((node) => typeof node.id === 'string' && typeof node.type === 'string' && Number.isFinite(node.x) && Number.isFinite(node.y)),
    JSON.stringify(importedWorkflow.nodes.map((node) => ({ id: node.id, type: node.type, x: node.x, y: node.y }))),
  );
  check(
    '导入不改动节点的其他字段（prompt/model/aspectRatio 原样）',
    importedWorkflow.nodes[0].prompt === '雨夜街道' && importedWorkflow.nodes[0].model === 'imagen-3' && importedWorkflow.nodes[0].aspectRatio === '16:9',
    JSON.stringify({ prompt: importedWorkflow.nodes[0].prompt, model: importedWorkflow.nodes[0].model }),
  );
  check(
    '导入不会反过来改坏存库的预设（仍然指向 preset 项目的快照）',
    String(JSON.parse(readFileSync(LIBRARY_FILE, 'utf8')).workflows[presetId].nodes[0].resultUrl) === presetNodeUrl,
    presetNodeUrl,
  );

  const importedAgain = await api('POST', '/library/workflows/import', { id: presetId, projectId: 'proj-wf' });
  check('再次导入是另一份副本', importedAgain.json().workflow.nodes[0].resultUrl !== importedWorkflow.nodes[0].resultUrl);

  const noNodes = await api('POST', '/library/workflows', { name: '空的', category: '其他', nodes: [] });
  check('POST /library/workflows 没有节点 → 400 INVALID_WORKFLOW_PRESET', noNodes.statusCode === 400 && noNodes.json().code === 'INVALID_WORKFLOW_PRESET', `${noNodes.statusCode}`);

  const badNode = await api('POST', '/library/workflows', { name: '坏的', category: '其他', nodes: [{ id: 'n', type: 'Text' }] });
  check('POST /library/workflows 节点缺坐标 → 400', badNode.statusCode === 400, `${badNode.statusCode}`);

  const unknownWorkflow = await api('POST', '/library/workflows/import', { id: 'wf-nope', projectId: 'proj-wf' });
  check('导入未知预设 → 404 WORKFLOW_PRESET_NOT_FOUND', unknownWorkflow.statusCode === 404 && unknownWorkflow.json().code === 'WORKFLOW_PRESET_NOT_FOUND', `${unknownWorkflow.statusCode}`);

  const wrongMethod = await api('PUT', '/library/workflows');
  check('PUT /library/workflows → 405', wrongMethod.statusCode === 405, `${wrongMethod.statusCode}`);

  const unmatched = await api('GET', `/library/workflows/${presetId}/extra`);
  check('未匹配的预设子路径仍回落 501', unmatched.statusCode === 501, `${unmatched.statusCode}`);
}

// ---------------------------------------------------------------- 7. 删除

{
  const deletedWorkflow = await api('DELETE', `/library/workflows/${encodeURIComponent(presetId)}`);
  check('DELETE /library/workflows/:id → {success:true}', deletedWorkflow.statusCode === 200 && deletedWorkflow.json().success === true, `${deletedWorkflow.statusCode}`);
  check('预设列表已空', (await api('GET', '/library/workflows')).json().length === 0);
  check('预设自带的素材整体进了回收站', !existsSync(join(MEDIA_DIR, presetProject)) && existsSync(join(TRASH_DIR, presetProject)), join(TRASH_DIR, presetProject));

  const missingWorkflow = await api('DELETE', '/library/workflows/wf-nope');
  check('删除未知预设 → 404', missingWorkflow.statusCode === 404, `${missingWorkflow.statusCode}`);

  const imageBefore = (await api('GET', '/library')).json().find((item) => item.id === imageId);
  const copyName = decodeURIComponent(String(imageBefore.url).split('/').pop());
  const deleted = await api('DELETE', `/library/${encodeURIComponent(imageId)}`);
  check('DELETE /library/:id → {success:true}', deleted.statusCode === 200 && deleted.json().success === true, `${deleted.statusCode}`);
  const afterDelete = (await api('GET', '/library')).json();
  check('列表少一条且不再含该 id', afterDelete.length === 2 && !afterDelete.some((item) => item.id === imageId), `${afterDelete.length}`);
  check(
    '库里那份副本进了回收站（不真删）',
    !existsSync(join(MEDIA_DIR, 'library', 'images', copyName)) &&
      existsSync(join(TRASH_DIR, 'library', 'images', copyName)),
    copyName,
  );
  check('回收站里有对应目录', existsSync(join(TRASH_DIR, 'library')), join(TRASH_DIR, 'library'));

  const missing = await api('DELETE', '/library/lib-nope');
  check('删除未知资产 → 404', missing.statusCode === 404, `${missing.statusCode}`);
}

// ---------------------------------------------------------------- 8. 围栏与诊断

{
  const crossOrigin = await raw('POST', '/library', { name: 'x', category: 'y', sourceUrl: 'data:image/png;base64,AA==' }, {
    host: '127.0.0.1:19387',
    origin: 'https://evil.example',
  });
  check('跨站 Origin 保存到资产库被拒（403）', crossOrigin.statusCode === 403, `${crossOrigin.statusCode}`);

  const status = await api('GET', '/status');
  check('诊断接口仍可用（画布项目库不受影响）', status.statusCode === 200 && status.json().ok === true, `${status.statusCode}`);
  check('画布项目库仍是空的（资产库数据没串到项目库）', (await api('GET', '/workflows')).json().length === 0);

  const fetchList = (await api('GET', '/library')).json();
  check('删除后剩下的条目仍然形状正确', fetchList.every((item) => typeof item.url === 'string' && ['image', 'video', 'audio'].includes(item.type)));
}

rmSync(fakeHome, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
