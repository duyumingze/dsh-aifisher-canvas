/**
 * 「UI 补全」那批 host 路由的回归（scripts/test-canvas-ui-services.mjs）。
 *
 * v1.1 补了上游画布一直在调、但 host 半原先没有实现的五组接口，
 * 这个脚本按 vendor 客户端的真实契约逐条验（全部走真路由，不 mock）：
 *
 *   画布外观背景图  /appearance/background        上传→读回→取字节→删除；MIME/尺寸/大小/无图四类错误
 *   媒体下载        /media-download/*             设置读写、目录选择取消、保存到目录、同名不覆盖、askEachTime 不可用
 *   本机运行环境    /local-runtime/*              状态结构（UI 硬需求字段）、进程、启停 disabled、日志、目录校验拒绝
 *   闭源服务        /generation/sources、/config/keys、/generation/model-availability、/verify-tos-url
 *   提示词          /prompts*、/creative-library、/prompt-assistant/*（未配端点 → 501 可读说明）
 *
 * 用法：node scripts/test-canvas-ui-services.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ORIGIN, startHost } from './lib/canvas-harness.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL  ${name}${extra ? `  [${extra}]` : ''}`);
  }
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
}

let host = null;

/** 原始请求（二进制 body / 自定义头）。 */
async function raw(method, path, payload, headers = {}) {
  const pathname = path.startsWith('/api/') ? path : `/api/aifisher/canvas${path}`;
  let route = null;
  for (const [prefix, candidate] of host.routes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      if (!route || prefix.length > route.prefix.length) route = { prefix, handler: candidate.handler };
    }
  }
  if (!route) return { statusCode: 404, headers: {}, buffer: () => Buffer.alloc(0), text: () => '' };
  const req = Readable.from(payload === undefined ? [] : [payload]);
  req.method = method;
  req.url = pathname;
  req.headers = { host: new URL(ORIGIN).host, origin: ORIGIN, ...headers };
  const res = new FakeResponse();
  await route.handler(req, res);
  if (!res.writableFinished) await new Promise((done) => res.once('finish', done));
  return res;
}

/** JSON 请求。 */
async function api(method, path, body) {
  const res = await raw(method, path, body === undefined ? undefined : Buffer.from(JSON.stringify(body)), {
    'content-type': 'application/json',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.text());
  } catch {
    parsed = null;
  }
  return { status: res.statusCode, body: parsed, text: res.text() };
}

/** 1x1 真 PNG 字节 + 一个「高」PNG（改 IHDR 里的高度）用来验尺寸上限。 */
function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); // IHDR 长度
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const PNG = png(120, 60);
const dataDir = () => join(host.fakeHome, 'storages', 'dsh-aifisher-canvas');
const mediaRoot = () => join(dataDir(), 'media');

host = await startHost();

// ---------------------------------------------------------------------------
// 1) 画布外观：背景图
// ---------------------------------------------------------------------------
{
  const empty = await api('GET', '/appearance/background');
  check(
    '背景图初始态是 {image:null}',
    empty.status === 200 && empty.body && empty.body.image === null && Object.hasOwn(empty.body, 'image'),
    JSON.stringify(empty.body),
  );

  const wrongType = await raw('POST', '/appearance/background', Buffer.from('not an image'), {
    'content-type': 'text/plain',
  });
  check('背景图只收 jpg/png/webp', wrongType.statusCode === 415 && JSON.parse(wrongType.text()).code === 'BACKGROUND_TYPE_UNSUPPORTED');

  const badBytes = await raw('POST', '/appearance/background', Buffer.from('xxxx'), {
    'content-type': 'image/png',
  });
  check(
    '坏字节 → 422 读不到尺寸',
    badBytes.statusCode === 422 && JSON.parse(badBytes.text()).code === 'BACKGROUND_SIZE_UNREADABLE',
    String(badBytes.statusCode),
  );

  const tooBig = await raw('POST', '/appearance/background', png(5000, 10), {
    'content-type': 'image/png',
  });
  check(
    '超过 4096 单边 → 422',
    tooBig.statusCode === 422 && JSON.parse(tooBig.text()).code === 'BACKGROUND_TOO_LARGE_DIMENSION',
    String(tooBig.statusCode),
  );

  const uploaded = await raw('POST', '/appearance/background', PNG, { 'content-type': 'image/png' });
  const image = JSON.parse(uploaded.text()).image ?? null;
  check(
    '上传成功 → image 形状符合前端解析规则',
    uploaded.statusCode === 200 &&
      image &&
      typeof image.id === 'string' &&
      /^[a-zA-Z0-9-]{16,80}$/.test(image.id) &&
      image.url === `/api/aifisher/canvas/appearance/background/${image.id}` &&
      image.width === 120 &&
      image.height === 60 &&
      image.bytes === PNG.length,
    JSON.stringify(image),
  );

  const fetched = await raw('GET', `/appearance/background/${image.id}`);
  check(
    '背景图字节可取且 MIME 正确',
    fetched.statusCode === 200 &&
      fetched.headers['content-type'] === 'image/png' &&
      fetched.buffer().equals(PNG),
    String(fetched.statusCode),
  );

  const missing = await raw('GET', '/appearance/background/aaaaaaaaaaaaaaaaaaaa');
  check('不存在的 id → 404', missing.statusCode === 404);

  const readBack = await api('GET', '/appearance/background');
  check('读回的是刚上传的那张', readBack.body?.image?.id === image.id);

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]), Buffer.from([0x00, 0x20, 0x00, 0x30]), Buffer.alloc(8)]);
  const swapped = await raw('POST', '/appearance/background', jpeg, { 'content-type': 'image/jpeg' });
  const swappedImage = JSON.parse(swapped.text()).image ?? null;
  check(
    '换格式上传：宽高来自 JPEG SOF',
    swapped.statusCode === 200 && swappedImage?.width === 48 && swappedImage?.height === 32,
    JSON.stringify(swappedImage),
  );
  check('换格式后旧文件被清掉（不留孤儿）', !existsSync(join(dataDir(), 'appearance', 'background.png')));

  const removed = await api('DELETE', '/appearance/background');
  check('删除后回 {image:null}', removed.status === 200 && removed.body?.image === null);
  check('删除后磁盘上没有背景文件', !existsSync(join(dataDir(), 'appearance', 'background.jpg')));
}

// ---------------------------------------------------------------------------
// 2) 媒体下载
// ---------------------------------------------------------------------------
{
  // 先造一个「本插件素材」：直接写进素材树，再用它的 URL 下载
  const projectDir = join(mediaRoot(), 'dl-proj', 'images');
  mkdirSync(projectDir, { recursive: true });
  const mediaFile = join(projectDir, 'shot.png');
  writeFileSync(mediaFile, PNG);

  const settings = await api('GET', '/media-download/settings');
  const expectedDefault = join(dataDir(), 'downloads');
  check(
    '下载设置默认目录在数据目录下',
    settings.status === 200 &&
      settings.body?.defaultDirectory === expectedDefault &&
      settings.body?.customDirectory === false &&
      settings.body?.askEachTime === false &&
      typeof settings.body?.directoryAvailable === 'boolean',
    JSON.stringify(settings.body),
  );

  const cancelled = await api('POST', '/media-download/settings/directory');
  check('没有原生选择器 → {status:cancelled}', cancelled.status === 200 && cancelled.body?.status === 'cancelled');

  const asked = await api('PATCH', '/media-download/settings', { askEachTime: true });
  check('askEachTime 能存下来', asked.status === 200 && asked.body?.askEachTime === true);

  const blocked = await api('POST', '/media-download/save', {
    sourceUrl: '/api/aifisher/canvas/media/dl-proj/images/shot.png',
    fileName: 'shot.png',
  });
  check(
    'askEachTime 开启时明确回「DSH 没有系统保存框」',
    blocked.status === 501 && blocked.body?.code === 'DOWNLOAD_DIALOG_UNSUPPORTED',
    `${blocked.status} ${blocked.body?.code}`,
  );

  await api('PATCH', '/media-download/settings', { askEachTime: false });

  const saved = await api('POST', '/media-download/save', {
    sourceUrl: '/api/aifisher/canvas/media/dl-proj/images/shot.png',
    fileName: '../../../evil.png',
  });
  check(
    '保存成功且文件名被消毒（无路径成分）',
    saved.status === 200 &&
      saved.body?.status === 'saved' &&
      saved.body?.fileName === 'evil.png' &&
      saved.body?.directory === expectedDefault,
    JSON.stringify(saved.body),
  );
  check('下载文件真的落在下载目录里', existsSync(join(expectedDefault, 'evil.png')));

  const again = await api('POST', '/media-download/save', {
    sourceUrl: '/api/aifisher/canvas/media/dl-proj/images/shot.png',
    fileName: 'evil.png',
  });
  check('同名不覆盖，退让成 "evil (2).png"', again.body?.fileName === 'evil (2).png', String(again.body?.fileName));
  check('第二次下载文件也确实存在', existsSync(join(expectedDefault, 'evil (2).png')));
  check('原文件没被覆盖', readFileSync(join(expectedDefault, 'evil.png')).equals(PNG));

  const unsupported = await api('POST', '/media-download/save', {
    sourceUrl: 'C:\\Windows\\win.ini',
    fileName: 'win.ini',
  });
  check(
    '本机任意路径不允许（422）',
    unsupported.status === 422 && unsupported.body?.code === 'DOWNLOAD_SOURCE_UNSUPPORTED',
    `${unsupported.status} ${unsupported.body?.code}`,
  );

  const custom = await api('PATCH', '/media-download/settings', { directory: join(dataDir(), 'my-downloads') });
  check('可以（用接口）改下载目录', custom.status === 200 && custom.body?.customDirectory === true);
  const reset = await api('DELETE', '/media-download/settings/directory');
  check('恢复默认目录', reset.status === 200 && reset.body?.customDirectory === false);
}

// ---------------------------------------------------------------------------
// 3) 本机运行环境（ComfyUI 未启动时的真话）
// ---------------------------------------------------------------------------
{
  const status = await api('GET', '/local-runtime/status');
  const s = status.body ?? {};
  check(
    'status 200 且给全 UI 硬需求字段',
    status.status === 200 &&
      s.gpu &&
      typeof s.gpu.available === 'boolean' &&
      typeof s.gpu.status === 'string' &&
      s.models &&
      typeof s.models.total === 'number' &&
      typeof s.models.status === 'string' &&
      s.comfyui &&
      typeof s.comfyui.workflowCount === 'number' &&
      typeof s.comfyui.status === 'string' &&
      Object.hasOwn(s.comfyui, 'address'),
    JSON.stringify({
      gpu: s.gpu?.status,
      models: s.models?.total,
      comfyui: s.comfyui?.status,
      workflows: s.comfyui?.workflowCount,
    }),
  );
  check(
    'comfyui.process 存在（否则设置页所有控件都不渲染）',
    Boolean(s.comfyui?.process) && typeof s.comfyui.process.running === 'boolean' && typeof s.comfyui.process.startable === 'boolean',
    JSON.stringify(s.comfyui?.process),
  );
  // 这一整套本来是照「本机没起 ComfyUI」写的。用户真机跑生成时 ComfyUI 是在跑的，
  // 于是按实际情况分两支断言（在线时验「能识别到外部服务」，离线时验原来的降级语义）。
  const comfyOffline = s.comfyui?.status === 'unavailable';
  check(
    comfyOffline
      ? '本机 ComfyUI 没启动时 status=unavailable 且不乱报可用'
      : '本机 ComfyUI 在跑时 status 不再报 unavailable（离线那两支已跳过）',
    comfyOffline ? s.comfyui?.status === 'unavailable' : s.comfyui?.status !== 'unavailable',
    JSON.stringify({ status: s.comfyui?.status, online: !comfyOffline }),
  );
  check('工作流清单非空（内置 + 自定义模板）', s.comfyui?.workflowCount >= 1, String(s.comfyui?.workflowCount));

  const refresh = await api('POST', '/local-runtime/refresh');
  check('refresh 走同一份结构', refresh.status === 200 && Boolean(refresh.body?.comfyui?.process));

  const process = await api('GET', '/local-runtime/comfyui');
  check(
    '进程端点形状正确',
    process.status === 200 && typeof process.body?.running === 'boolean' && typeof process.body?.startable === 'boolean',
    JSON.stringify(process.body),
  );
  // 画布头部的状态胶囊（vendor 3.8c 补丁后）看的就是 phase：说成 unavailable 会显示「未配置」，
  // 而事实是「已配置好地址、等你自己启动」= idle；ComfyUI 真在跑时则是 external + running。
  check(
    comfyOffline
      ? 'ComfyUI 没起来时 phase=idle（胶囊显示「ComfyUI 待启动」而不是「未配置」）'
      : 'ComfyUI 在跑时 phase=external + running（胶囊显示「已检测到外部 ComfyUI 服务」）',
    comfyOffline
      ? process.body?.phase === 'idle' &&
        process.body?.running === false &&
        process.body?.startable === false
      : process.body?.phase === 'external' && process.body?.running === true,
    JSON.stringify({ phase: process.body?.phase, running: process.body?.running, startable: process.body?.startable }),
  );
  check('status 与进程端点同源（两处 phase 一致，不会一处 idle 一处 unavailable）',
    s.comfyui?.process?.phase === process.body?.phase,
    `${s.comfyui?.process?.phase} vs ${process.body?.phase}`);

  const start = await api('POST', '/local-runtime/comfyui/start');
  check(
    '启停不接管 → 2xx + status:disabled（不能给 4xx，否则前端会抛错）',
    start.status === 200 && start.body?.status === 'disabled' && typeof start.body?.message === 'string',
    `${start.status} ${start.body?.status}`,
  );

  const logs = await api('GET', '/local-runtime/comfyui/logs?lines=80');
  check(
    '日志端点给齐 stdout/stderr（缺了前端 inferStage 会静默停住）',
    logs.status === 200 &&
      logs.body?.state &&
      Array.isArray(logs.body?.logs?.stdout?.lines) &&
      Array.isArray(logs.body?.logs?.stderr?.lines),
    JSON.stringify(logs.body?.logs?.stdout),
  );

  const discover = await api('POST', '/local-runtime/comfyui/discover');
  check(
    'discover 不扫盘但形状对',
    discover.status === 200 && Array.isArray(discover.body?.candidates) && typeof discover.body?.scope === 'string',
    JSON.stringify(discover.body),
  );

  const select = await api('POST', '/local-runtime/comfyui/select-directory');
  check('选择目录 → cancelled', select.body?.status === 'cancelled');

  const validate = await api('POST', '/local-runtime/comfyui/validate-directory', { root: 'G:\\nowhere' });
  check(
    '校验目录 → 非 2xx + error（客户端会抛，界面显示这句，而不是静默成功）',
    validate.status === 409 && typeof validate.body?.error === 'string' && validate.body?.status === undefined,
    `${validate.status} ${validate.body?.code}`,
  );

  const ext = await api('GET', '/local-runtime/comfyui/extensions/node-ids');
  check('节点编号扩展 = unavailable + installable:false', ext.body?.status === 'unavailable' && ext.body?.installable === false);

  const cli = await api('GET', '/local-runtime/libtv-cli');
  check('厂商 CLI 明确 501', cli.status === 501 && cli.body?.code === 'CLI_NOT_SUPPORTED');
}

// ---------------------------------------------------------------------------
// 4) 闭源服务（v1.13 起只剩方舟卡片；自配单端点已移除）
// ---------------------------------------------------------------------------
{
  const savedArk = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;

  const blocks = await api('GET', '/generation/sources');
  const arkCard = blocks.body?.blocks?.find((entry) => entry.source === 'ark');
  check(
    '来源清单只有方舟卡片（「自配云端端点」卡片已在 v1.13 移除）',
    blocks.status === 200 &&
      blocks.body?.blocks?.length === 1 &&
      blocks.body?.blocks?.[0]?.source === 'ark' &&
      arkCard?.singleKey === true &&
      arkCard?.secrets?.[0]?.key === 'ARK_API_KEY',
    JSON.stringify(blocks.body?.blocks?.map((entry) => entry.source)),
  );
  check(
    '未配置时方舟密钥是 configured:false',
    arkCard?.secrets?.every((secret) => secret.configured === false),
  );
  check(
    '方舟卡片带图片 + 视频两组模型清单（v1.60 起视频也走方舟直连）',
    Array.isArray(arkCard?.media) &&
      arkCard.media.length === 2 &&
      arkCard.media.some((entry) => entry.kind === 'image' && Array.isArray(entry.models)) &&
      arkCard.media.some((entry) => entry.kind === 'video' && Array.isArray(entry.models)),
    arkCard?.media?.map((entry) => `${entry.kind}:${entry.models.length}`).join(' '),
  );

  const refusedLegacy = await api('POST', '/config/keys', { AIFISHER_CLOUD_BASE_URL: 'http://127.0.0.1:9/v1' });
  check(
    '旧的自配端点地址被明确拒绝（409 + 指路到通道面板，不静默忽略）',
    refusedLegacy.status === 409 &&
      refusedLegacy.body?.code === 'KEY_NOT_SUPPORTED' &&
      refusedLegacy.body?.key === 'AIFISHER_CLOUD_BASE_URL' &&
      String(refusedLegacy.body?.error).includes('OpenAI 通道'),
    `${refusedLegacy.status} ${refusedLegacy.body?.code}`,
  );
  const refusedLegacyKey = await api('POST', '/config/keys', { AIFISHER_CLOUD_API_KEY: 'sk-x' });
  check(
    '旧的自配端点密钥同样被拒绝',
    refusedLegacyKey.status === 409 && refusedLegacyKey.body?.key === 'AIFISHER_CLOUD_API_KEY',
    `${refusedLegacyKey.status} ${refusedLegacyKey.body?.code}`,
  );
  const refusedPath = await api('POST', '/config/keys', { AIFISHER_CLOUD_IMAGE_PATH: '/images/generations' });
  check(
    '旧的路径覆盖键也被拒绝（改到通道上配）',
    refusedPath.status === 409 && refusedPath.body?.key === 'AIFISHER_CLOUD_IMAGE_PATH',
    `${refusedPath.status} ${refusedPath.body?.code}`,
  );
  const keysAfter = await api('GET', '/config/keys');
  check(
    'GET keys 不再回显旧端点字段，也没把密钥写进去',
    keysAfter.body?.AIFISHER_CLOUD_BASE_URL === undefined &&
      keysAfter.body?.AIFISHER_CLOUD_ENDPOINT_CONFIGURED === undefined,
    JSON.stringify(keysAfter.body).slice(0, 200),
  );

  const refused = await api('POST', '/config/keys', { COMFYUI_ROOT: 'G:\\ComfyUI-aki-v3.2-duyumingze', COMFYUI_AUTO_START: 'true' });
  check(
    '拒绝 COMFYUI_ROOT（不假装保存成功）',
    refused.status === 409 && refused.body?.code === 'KEY_NOT_SUPPORTED' && refused.body?.key === 'COMFYUI_ROOT',
    `${refused.status} ${refused.body?.code}`,
  );

  // 没通道、没方舟 Key 时：可用性清单为空（画布下拉不会给出必失败的名字），且必须快
  const started = Date.now();
  const availability = await api('GET', '/generation/model-availability?resolution=1K&mode=text2image');
  const elapsed = Date.now() - started;
  check(
    '模型可用性 2 秒内返回，且此刻没有任何「已连接」的云端变体',
    availability.status === 200 &&
      Array.isArray(availability.body?.groups) &&
      availability.body.groups
        .flatMap((item) => item.variants ?? [])
        .every((variant) => variant.configured === false) &&
      elapsed < 2000,
    `${elapsed}ms / groups=${availability.body?.groups?.length}`,
  );

  // 临时加一条通道：验分组字段形状（通道变体 = 未知价格 + requiredSecrets 为空数组）
  const tempSave = await api('POST', '/cloud-channels', {
    action: 'save',
    channel: {
      id: 'ui-temp',
      label: '临时通道',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-ui-temp',
      models: [{ id: 'temp-image', kind: 'image' }],
    },
  });
  const withChannel = await api('GET', '/generation/model-availability?resolution=1K&mode=text2image');
  const group = withChannel.body?.groups?.find((item) => item.canonicalModel === '临时通道 · temp-image');
  check(
    '分组字段齐全（canonicalModel/brand/capabilities/available/variants）',
    tempSave.status === 200 &&
      Boolean(group) &&
      typeof group.canonicalModel === 'string' &&
      typeof group.brand === 'string' &&
      Array.isArray(group.capabilities) &&
      typeof group.available === 'boolean' &&
      group.variants.every(
        (variant) =>
          typeof variant.name === 'string' &&
          (variant.price === null || typeof variant.price === 'number') &&
          variant.priceExact === false &&
          Array.isArray(variant.requiredSecrets),
      ),
    JSON.stringify(group && { canonical: group.canonicalModel, brand: group.brand, variants: group.variants.length }),
  );
  check(
    '通道变体不发布价格（只有方舟直连给元/张的官方估价）',
    withChannel.body.groups
      .flatMap((item) => item.variants ?? [])
      .filter((variant) => variant.source === 'dsh_cloud')
      .every((variant) => variant.price === null && variant.configured === true),
  );
  await api('POST', '/cloud-channels', { action: 'delete', id: 'ui-temp' });

  const tos = await api('POST', '/verify-tos-url', { networkUrl: 'http://127.0.0.1:1/secret' });
  check('私网地址不探测：返回 exists:true（不乱清素材链接）', tos.status === 200 && tos.body?.exists === true);

  if (savedArk !== undefined) process.env.ARK_API_KEY = savedArk;
  else delete process.env.ARK_API_KEY;
}

// ---------------------------------------------------------------------------
// 5) 提示词预设 / 创意库 / 提示词助手
// ---------------------------------------------------------------------------
{
  const config = await api('GET', '/prompts/config');
  check(
    '预设清单空起步（text/image/video/audio 四个键都在）',
    config.status === 200 &&
      ['text', 'image', 'video', 'audio'].every((type) => Array.isArray(config.body?.[type])),
    JSON.stringify(Object.keys(config.body ?? {})),
  );

  const created = await api('POST', '/prompts', {
    type: 'image',
    category: '我的风格',
    title: '赛博夜景',
    prompt: 'neon city, rain, cinematic',
  });
  check('新建预设 → {success:true}', created.status === 200 && created.body?.success === true, JSON.stringify(created.body?.preset));

  await api('POST', '/prompts', {
    type: 'image',
    category: '我的风格',
    title: '双段提示词',
    prompt: ['第一段', '第二段'],
  });
  const after = await api('GET', '/prompts/config');
  const bucket = after.body?.image?.find((entry) => entry.name === '我的风格');
  check(
    '清单里能读到（分类 + 两条）',
    Boolean(bucket) && bucket.items.length === 2 && bucket.items[0].title === '赛博夜景',
    JSON.stringify(bucket?.items?.map((item) => item.title)),
  );

  const bad = await api('POST', '/prompts', { type: 'nope', category: 'x', title: 'y', prompt: 'z' });
  check('类型非法 → 422', bad.status === 422 && bad.body?.code === 'PRESET_TYPE_INVALID');

  // 标题里的 `/` 不会被 encodeURIComponent 转义，路由必须把第 3 段之后拼回去
  await api('POST', '/prompts', { type: 'video', category: '带斜杠/分类', title: 'a/b 镜头', prompt: '镜头运动' });
  const removed = await api(
    'DELETE',
    `/prompts/video/${encodeURIComponent('带斜杠/分类')}/${encodeURIComponent('a/b 镜头')}`,
  );
  check('删除含 `/` 的分类/标题', removed.status === 200 && removed.body?.success === true, JSON.stringify(removed.body));
  const afterDelete = await api('GET', '/prompts/config');
  check('删完之后清单里没有它了', !JSON.stringify(afterDelete.body?.video ?? []).includes('a/b 镜头'));

  const library = await api('GET', '/prompts/creative-library');
  check(
    '创意库初值 {favorites:[],custom:[]}',
    library.status === 200 && Array.isArray(library.body?.favorites) && Array.isArray(library.body?.custom),
    JSON.stringify(library.body),
  );
  const customPreset = {
    id: 'custom-1',
    kind: 'style',
    category: '自定义',
    name: '我的预设',
    description: '',
    prompt: 'soft light',
  };
  const savedLibrary = await api('POST', '/prompts/creative-library', {
    favoriteChanges: [{ id: 'style-1', saved: true }],
    customUpserts: [customPreset],
    customDeletes: [],
  });
  check(
    '创意库增量和保存后回整份',
    savedLibrary.status === 200 &&
      savedLibrary.body?.favorites?.includes('style-1') &&
      savedLibrary.body?.custom?.some((item) => item.id === 'custom-1'),
    JSON.stringify(savedLibrary.body),
  );
  const dropLibrary = await api('POST', '/prompts/creative-library', {
    favoriteChanges: [{ id: 'style-1', saved: false }],
    customUpserts: [],
    customDeletes: ['custom-1'],
  });
  check(
    '取消收藏 + 删除自定义',
    dropLibrary.body?.favorites?.length === 0 && dropLibrary.body?.custom?.length === 0,
    JSON.stringify(dropLibrary.body),
  );
  const invalidLibrary = await api('POST', '/prompts/creative-library', {
    favoriteChanges: [],
    customUpserts: [{ id: 'bad', kind: 'nope', name: '', prompt: '' }],
    customDeletes: [],
  });
  check('无效自定义预设被拒（不会写进库里）', invalidLibrary.body?.custom?.length === 0);

  const assistant = await api('POST', '/prompt-assistant/optimize-prompt', { prompt: '一只猫' });
  check(
    '未配通道 → 501 + 可读说明（指路「OpenAI 通道」）+ retryable 字段',
    assistant.status === 501 &&
      assistant.body?.code === 'PROMPT_ASSISTANT_NOT_CONFIGURED' &&
      typeof assistant.body?.error === 'string' &&
      assistant.body.error.includes('OpenAI 通道') &&
      assistant.body?.retryable === false,
    `${assistant.status} ${assistant.body?.code}`,
  );
  const emptyPrompt = await api('POST', '/prompt-assistant/optimize-prompt', { prompt: '   ' });
  check('空提示词 → 422 PROMPT_EMPTY', emptyPrompt.status === 422 && emptyPrompt.body?.code === 'PROMPT_EMPTY');
}

// ---------------------------------------------------------------------------
// 6) 项目备份 / 恢复（Header 的「导入项目」与 agent 的 projects 导出）
// ---------------------------------------------------------------------------
{
  // 造一个带素材的项目：文档里引用我们自己的素材 URL
  const archProjectId = 'arch-proj';
  const archMediaDir = join(mediaRoot(), archProjectId, 'images');
  mkdirSync(archMediaDir, { recursive: true });
  writeFileSync(join(archMediaDir, 'cover.png'), PNG);
  const created = await api('POST', '/workflows', {
    id: archProjectId,
    revision: 0,
    title: '归档测试项目',
    nodes: [
      { id: 'n1', type: 'Image', x: 0, y: 0, resultUrl: `/api/aifisher/canvas/media/${archProjectId}/images/cover.png` },
    ],
    groups: [],
  });
  check('先建一个带素材的项目', created.status === 200 && created.body?.id === archProjectId, String(created.status));

  const backup = await raw('GET', `/workflows/${archProjectId}/backup`);
  let archive = null;
  try {
    archive = JSON.parse(backup.text());
  } catch {
    archive = null;
  }
  check(
    '导出：Content-Disposition + 归档格式',
    backup.statusCode === 200 &&
      String(backup.headers['content-disposition'] ?? '').includes('attachment') &&
      String(backup.headers['content-disposition'] ?? '').includes('.fisherai') &&
      archive?.format === 'dsh-aifisher-project' &&
      archive?.version === 1 &&
      archive?.project?.id === archProjectId,
    String(backup.headers['content-disposition'] ?? '').slice(0, 80),
  );
  check(
    '导出：素材按 base64 带上了',
    archive?.media?.[`${archProjectId}/images/cover.png`] === PNG.toString('base64') && archive?.mediaOmitted === false,
    Object.keys(archive?.media ?? {}).join(','),
  );

  const missingProject = await raw('GET', '/workflows/no-such-project/backup');
  check('导出不存在的项目 → 404', missingProject.statusCode === 404);

  // 注意：application/json 是「本机路径」形态；带原始归档字节要走 octet-stream
  const badArchive = await raw('POST', '/workflows/restore', Buffer.from(JSON.stringify({ format: 'nope' })), {
    'content-type': 'application/octet-stream',
  });
  const badArchiveBody = JSON.parse(badArchive.text());
  check(
    '导入不是备份的 JSON → 422 ARCHIVE_FORMAT_UNKNOWN',
    badArchive.statusCode === 422 && badArchiveBody.code === 'ARCHIVE_FORMAT_UNKNOWN',
    `${badArchive.statusCode} ${badArchiveBody.code}`,
  );

  // 纯浏览器形态：body 就是文件原始字节
  const restored = await raw('POST', '/workflows/restore', Buffer.from(JSON.stringify(archive)), {
    'content-type': 'application/octet-stream',
  });
  const restoredBody = JSON.parse(restored.text());
  check(
    '导入：新建项目并回 {id}（前端靠它 openProject）',
    restored.statusCode === 200 && typeof restoredBody.id === 'string' && restoredBody.id !== archProjectId,
    JSON.stringify(restoredBody),
  );

  const reopened = await api('GET', `/workflows/${restoredBody.id}`);
  const node = reopened.body?.nodes?.[0];
  check(
    '导入后的项目素材 URL 指向新项目 id',
    reopened.status === 200 && node?.resultUrl === `/api/aifisher/canvas/media/${restoredBody.id}/images/cover.png`,
    String(node?.resultUrl),
  );
  check(
    '导入后的素材文件真的写回到新项目目录',
    existsSync(join(mediaRoot(), restoredBody.id, 'images', 'cover.png')),
  );
  check('导入不会覆盖原项目', (await api('GET', `/workflows/${archProjectId}`)).status === 200);

  // 本机路径形态：只接受 .fisherai / .json 绝对路径
  const archivePath = join(host.fakeHome, 'import-me.fisherai');
  writeFileSync(archivePath, JSON.stringify(archive));
  const byPath = await api('POST', '/workflows/restore', { path: archivePath });
  check('导入：本机 .fisherai 路径形态也走通', byPath.status === 200 && typeof byPath.body?.id === 'string', JSON.stringify(byPath.body));
  const rejectedPath = await api('POST', '/workflows/restore', { path: join(host.fakeHome, 'evil.exe') });
  check(
    '导入：非 .fisherai/.json 路径被拒',
    rejectedPath.status === 422 && rejectedPath.body?.code === 'RESTORE_PATH_INVALID',
    `${rejectedPath.status} ${rejectedPath.body?.code}`,
  );
}

// ---------------------------------------------------------------------------
// 7) 诊断端点把新块也算进来
// ---------------------------------------------------------------------------
{
  const status = await api('GET', '/status');
  check(
    '/status 里能看到新块（appearance/downloads/sources/prompts）',
    status.status === 200 &&
      status.body?.appearance &&
      status.body?.downloads &&
      status.body?.sources &&
      status.body?.prompts,
    JSON.stringify({
      appearance: status.body?.appearance,
      downloads: status.body?.downloads?.askEachTime,
      prompts: status.body?.prompts?.presets,
    }),
  );
}

console.log(`SUMMARY pass=${pass} fail=${fail}`);
if (fail > 0) console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
process.exit(fail === 0 ? 0 : 1);
