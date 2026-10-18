/**
 * 画布 host 后端 / 桥接 回归测试。
 *
 * 为什么要有它：画布本地后端（store + restRouter）与 agent 桥接（agentBridge）是
 * 纯 host 代码，却只有在真实页面里才会被用到。这里用「假 req/res + 捕获路由注册」
 * 把 lib/index.js 的 apply() 挂起来，然后**真的发请求**跑一遍：
 *   - 项目/文件夹/偏好的完整 CRUD 与 revision 乐观并发（409 冲突）
 *   - 未移植能力返回 501（而不是掉进 DSH 鉴权层 401）
 *   - 诊断上报通道（client 半的报错就是走这条回来的）
 *   - 桥接全链路：注册 → 工具下发指令 → 画布 poll 取走 → complete 回执 → 工具拿到结果
 *   - 静态产物路由（画布应用 JS 能取到，缺文件 404）
 *
 * 用法：node scripts/test-canvas-backend.mjs   （需要先 build）
 * 数据落在临时 DSH_HOME 下，不会碰真实画布数据。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { dirname, resolve } from 'node:path';
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
  // 真实 IncomingMessage 一定有 headers；这里给空对象，保证同源围栏读到的是 undefined 而不是抛错
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
  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
  json() {
    return JSON.parse(this.text());
  }
}

// ---------------------------------------------------------------- 挂载插件

const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-aifisher-test-'));
process.env.DSH_HOME = fakeHome;
// 技能目录要扫 `$DSH_AGENTS_HOME/skills`：指到假目录里，免得测试结果跟这台机器的
// `~/.agents/skills` 有没有东西挂钩（真机上它是空的，但回归不该依赖这个）。
process.env.DSH_AGENTS_HOME = join(fakeHome, 'agents-home');

const routes = new Map();
const tools = [];
const fakeWebServer = {
  register(route) {
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  },
};
const ctxStub = {
  get(name) {
    if (name === 'webServer') return fakeWebServer;
    if (name === 'skills') {
      // 只回 bundled 层（真机上 host 上下文里就是这个形状：文件系统 provider 在 agent 作用域，
      // 这里看不见用户/项目级技能）—— 画布侧技能目录必须自己扫盘补上那一层。
      return {
        list: async () => [
          {
            name: 'bundled-fixture',
            description: 'bundled 层样例',
            source: 'bundled',
            provider: 'dsh-fixture',
            invocation: { modelInvocable: true, userInvocable: true },
          },
          {
            name: 'override-me',
            description: 'bundled 层的同名条目（应当被用户自己的技能盖掉）',
            source: 'bundled',
            provider: 'dsh-fixture',
            invocation: { modelInvocable: true, userInvocable: true },
          },
        ],
        get: async (name) =>
          name === 'bundled-fixture'
            ? {
                name,
                description: 'bundled 层样例',
                content: '# bundled fixture body',
                source: 'bundled',
                provider: 'dsh-fixture',
                invocation: { modelInvocable: true, userInvocable: true },
              }
            : undefined,
      };
    }
    return undefined;
  },
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (tool) => { tools.push(tool); return () => {}; } },
};

const hostMod = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
hostMod.apply(ctxStub);

const canvasRoute = routes.get('/api/aifisher/canvas');
const appRoute = routes.get('/api/aifisher/canvas-app');
check('画布后端路由已注册', typeof canvasRoute?.handler === 'function');
check('画布应用静态路由已注册', typeof appRoute?.handler === 'function');

async function api(method, path, body) {
  const res = new FakeResponse();
  await canvasRoute.handler(makeReq(method, `/api/aifisher/canvas${path}`, body), res);
  await waitForFinish(res);
  return res;
}

/**
 * 静态文件是 createReadStream().pipe(res) 发出去的，handler 返回时管道还没写完，
 * 所以断言 body 之前必须等 Writable 的 finish 事件。
 */
function waitForFinish(res) {
  if (res.writableFinished) return Promise.resolve();
  return new Promise((resolve) => res.once('finish', resolve));
}

// ---------------------------------------------------------------- 项目 CRUD

{
  const empty = await api('GET', '/workflows');
  check('GET /workflows 空库返回数组', empty.statusCode === 200 && Array.isArray(empty.json()));

  const bad = await api('POST', '/workflows', { nope: true });
  check('POST /workflows 非法 body → 422', bad.statusCode === 422, String(bad.statusCode));

  const doc = {
    id: 'proj-1',
    revision: 0,
    title: '测试项目',
    nodes: [{ id: 'n1', type: 'Text', x: 0, y: 0 }],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const saved = await api('POST', '/workflows', doc);
  const savedBody = saved.json();
  check('保存返回 success/id/revision', saved.statusCode === 200 && savedBody.success === true && savedBody.id === 'proj-1' && savedBody.revision === 1, JSON.stringify(savedBody));

  const saved2 = (await api('POST', '/workflows', { ...doc, revision: 1 })).json();
  check('再次保存 revision 递增', saved2.revision === 2, JSON.stringify(saved2));

  const conflict = await api('POST', '/workflows', { ...doc, revision: 1 });
  check('落后 revision → 409 REVISION_CONFLICT', conflict.statusCode === 409 && conflict.json().code === 'REVISION_CONFLICT', `${conflict.statusCode} ${conflict.text()}`);

  const listed = (await api('GET', '/workflows')).json();
  check('列表含项目摘要与 nodeCount', listed.length === 1 && listed[0].nodeCount === 1 && listed[0].title === '测试项目', JSON.stringify(listed));

  const fetched = await api('GET', '/workflows/proj-1');
  check('GET /workflows/:id 取回文档', fetched.statusCode === 200 && fetched.json().revision === 2);

  const missing = await api('GET', '/workflows/nope');
  check('GET 不存在的项目 → 404', missing.statusCode === 404);

  const renamed = await api('PUT', '/workflows/proj-1/rename', { title: '改名后' });
  check('重命名生效', renamed.statusCode === 200 && renamed.json().title === '改名后');

  const moved = await api('PUT', '/workflows/proj-1/move', { folderId: 'folder-x' });
  check('移动项目生效', moved.statusCode === 200 && moved.json().folderId === 'folder-x');

  const cleanup = await api('POST', '/workflows/proj-1/cleanup', { preview: true });
  check('cleanup 返回 pendingDelete 数组', cleanup.statusCode === 200 && Array.isArray(cleanup.json().pendingDelete));

  // v1.1 起 restore 真的能用了（导出/导入的完整用例在 test-canvas-ui-services.mjs）：
  // 带 application/json 时 body 是「本机路径」形态；不带 content-type 就按原始归档字节解析。
  // 这个假请求没有 content-type，所以走字节分支 → 内容不是备份 → 422 ARCHIVE_FORMAT_UNKNOWN
  const restore = await api('POST', '/workflows/restore', {});
  check(
    'restore 收到非备份内容 → 422 ARCHIVE_FORMAT_UNKNOWN',
    restore.statusCode === 422 && restore.json().code === 'ARCHIVE_FORMAT_UNKNOWN',
    String(restore.statusCode),
  );
}

// ---------------------------------------------------------------- 文件夹 / 偏好

{
  const folder = (await api('POST', '/folders', { name: '未命名文件夹', parentId: null })).json();
  check('新建文件夹返回 id', typeof folder.id === 'string' && folder.parentId === null);

  const renamedFolder = (await api('POST', '/folders', { ...folder, name: '改名夹' })).json();
  check('带 id 的 POST 是重命名', renamedFolder.id === folder.id && renamedFolder.name === '改名夹');

  const list = (await api('GET', '/folders')).json();
  check('文件夹列表含新建项', list.some((item) => item.id === folder.id));

  // 删掉文件夹后，其下项目回到根目录（不能被连带删除）
  await api('PUT', '/workflows/proj-1/move', { folderId: folder.id });
  const removed = await api('DELETE', `/folders/${folder.id}`);
  check('删除文件夹返回 204', removed.statusCode === 204, String(removed.statusCode));
  const afterDelete = (await api('GET', '/workflows/proj-1')).json();
  check('删文件夹后项目回到根目录', afterDelete.folderId === null, JSON.stringify({ folderId: afterDelete.folderId }));

  const emptyPrefs = (await api('GET', '/preferences')).json();
  check('偏好初始为空且结构正确', emptyPrefs.values && emptyPrefs.browserImported === false);
  await api('PATCH', '/preferences', { set: { 'fisherai.model-picker.premium': '1' }, browserImported: true });
  const prefs = (await api('GET', '/preferences')).json();
  check('偏好写入后可读回', prefs.values['fisherai.model-picker.premium'] === '1' && prefs.browserImported === true);
  await api('PATCH', '/preferences', { remove: ['fisherai.model-picker.premium'] });
  check('偏好可删除', (await api('GET', '/preferences')).json().values['fisherai.model-picker.premium'] === undefined);
}

// ---------------------------------------------------------------- 诊断通道

{
  const posted = await api('POST', '/diagnostics', {
    level: 'error',
    message: '画布组件异常：boom',
    detail: { stack: 'at foo' },
    url: '/',
  });
  check('诊断上报返回 204', posted.statusCode === 204, String(posted.statusCode));
  const read = (await api('GET', '/diagnostics')).json();
  check('诊断可读回且保留 stack', read.entries.length === 1 && read.entries[0].message.includes('boom') && read.entries[0].detail.stack === 'at foo', JSON.stringify(read));
  await api('DELETE', '/diagnostics');
  check('诊断可清空', (await api('GET', '/diagnostics')).json().entries.length === 0);
  const invalid = await api('POST', '/diagnostics', { level: 'error' });
  check('诊断缺 message → 422', invalid.statusCode === 422);
}

// ---------------------------------------------------------------- 状态 / 501 兜底

{
  const status = (await api('GET', '/status')).json();
  check('status 报告库状态与桥接状态', status.ok === true && typeof status.store.path === 'string' && status.store.documents >= 1 && status.bridge !== null, JSON.stringify(status).slice(0, 200));

  // /library 现在是「资产库」的真实现（不再是 501 NOT_PORTED）；这条能力的升级断言见
  // scripts/test-canvas-library.mjs，这里改为「同一条底线换个仍然没移植的路径来守」。
  const library = await api('GET', '/library');
  check('资产库端点已接上（GET /library → 200 数组）', library.statusCode === 200 && Array.isArray(library.json()), `${library.statusCode} ${library.text().slice(0, 120)}`);

  const unported = await api('GET', '/public-workflows');
  check('未移植端点 → 501 NOT_PORTED（不掉进宿主鉴权）', unported.statusCode === 501 && unported.json().code === 'NOT_PORTED', String(unported.statusCode));
}

// ---------------------------------------------------------------- canvas_control 工具

const tool = tools.find((item) => item.name === 'canvas_control');
check('canvas_control 工具已注册', Boolean(tool));

function toolArgs(overrides) {
  return {
    action: 'read',
    // 工具参数是声明式 schema，这里直接给对象即可
    ...overrides,
  };
}

async function execute(args) {
  return tool.execute(toolArgs(args), { agent: { session: { id: 'sess-1' } } });
}

{
  const noCanvas = await execute({ action: 'read' });
  check('没有画布时 read → NO_OPEN_CANVAS', noCanvas.ok === false && noCanvas.code === 'NO_OPEN_CANVAS', JSON.stringify(noCanvas));

  const editWithoutRevision = await execute({ action: 'edit', operations: [{ kind: 'create', ref: 'a', type: 'Text', x: 0, y: 0 }] });
  check('edit 缺 revision → NEED_COMMAND', editWithoutRevision.ok === false && editWithoutRevision.code === 'NEED_COMMAND');

  const skills = await execute({ action: 'skills' });
  check('skills 动作仍可用', skills.ok === true && Array.isArray(skills.skills));
}

// ---------------------------------------------------------------- 桥接全链路

{
  // 画布侧注册（真实客户端每次 poll 都会带 clientId/projectId）
  const list = await api('POST', '/agent/external/list', { clientId: 'c1', projectId: 'proj-1' });
  check('外部连接 list 返回数组', list.statusCode === 200 && Array.isArray(list.json()));

  // 工具下发 read，此时应挂起等画布回执
  const pending = execute({ action: 'read' });

  // 画布长轮询立刻取到这条指令（队列非空时不挂起）
  const polled = await api('POST', '/agent/external/poll', { clientId: 'c1', projectId: 'proj-1' });
  const requests = polled.json();
  check('poll 取到待执行指令', Array.isArray(requests) && requests.length === 1, JSON.stringify(requests).slice(0, 200));
  const request = requests[0];
  check('指令带 requestId/projectId/sessionId/expiresAt', Boolean(request.requestId) && request.projectId === 'proj-1' && request.sessionId === 'sess-1' && request.expiresAt > Date.now(), JSON.stringify(request).slice(0, 200));
  check('指令 action 透传正确', request.command?.action === 'read', JSON.stringify(request.command));

  const claim = await api('POST', '/agent/external/claim', { clientId: 'c1', projectId: 'proj-1', requestId: request.requestId });
  check('claim 返回 external:false（本地无租约）', claim.json().external === false);

  const complete = await api('POST', '/agent/external/complete', {
    clientId: 'c1',
    projectId: 'proj-1',
    requestId: request.requestId,
    result: { ok: true, revision: 'r-1', nodes: [], groups: [], selectedNodeIds: [] },
  });
  check('complete 被接受', complete.statusCode === 200);

  const result = await pending;
  check('工具拿到画布回执', result.ok === true && result.result?.revision === 'r-1', JSON.stringify(result));

  const heartbeat = await api('POST', '/agent/external/heartbeat', { clientId: 'c1', projectId: 'proj-1' });
  check('heartbeat 正常', heartbeat.json().ok === true);

  const pair = await api('POST', '/agent/external/pair', { clientId: 'c1', projectId: 'proj-1', manageProjects: false });
  check('pair 返回无需配对的答复', 'command' in pair.json() && 'expiresAt' in pair.json());

  const statusAfter = (await api('GET', '/status')).json();
  check('status 能看到已连接的画布', Array.isArray(statusAfter.bridge.clients) && statusAfter.bridge.clients.some((c) => c.clientId === 'c1' && c.projectId === 'proj-1'), JSON.stringify(statusAfter.bridge).slice(0, 200));

  const release = await api('POST', '/agent/external/release', { clientId: 'c1', projectId: 'proj-1' });
  check('release 断开连接', release.json().ok === true);
  const afterRelease = (await api('GET', '/status')).json();
  check('release 后不再有该连接', afterRelease.bridge.clients.every((c) => c.clientId !== 'c1'));
}

// ---------------------------------------------------------------- ComfyUI 端点（含 vendor 前端的同款路径）

async function comfyApi(method, path, body) {
  const res = new FakeResponse();
  await routes.get('/api/comfy').handler(makeReq(method, `/api/comfy${path}`, body), res);
  await waitForFinish(res);
  return res;
}

{
  const capabilities = await comfyApi('GET', '/capabilities?outputType=videos');
  const list = capabilities.json().capabilities ?? [];
  check('GET /api/comfy/capabilities 返回能力清单',
    capabilities.statusCode === 200 && list.some((item) => item.workflowType === 'minimax-h3-t2va' && item.modes.includes('t2va')),
    JSON.stringify(list).slice(0, 200));

  const badType = await comfyApi('GET', '/capabilities?outputType=nope');
  check('非法 outputType → 400 INVALID_OUTPUT_TYPE',
    badType.statusCode === 400 && badType.json().code === 'INVALID_OUTPUT_TYPE',
    `${badType.statusCode} ${badType.text()}`);

  const images = await comfyApi('GET', '/capabilities?outputType=images');
  check('没有图片工作流时返回空清单', images.statusCode === 200 && images.json().capabilities.length === 0, images.text());

  // 这条曾经因为模板路径多退一级而永远 400 —— 断言就是那次修复的回归防护
  const template = await comfyApi('GET', '/workflow/minimax-h3-t2va');
  const templateBody = template.json();
  const nodeCount = templateBody.template ? Object.keys(templateBody.template).length : 0;
  check('GET /api/comfy/workflow/:type 真读到模板 JSON',
    template.statusCode === 200 && nodeCount > 10,
    `${template.statusCode} nodes=${nodeCount}`);

  const unknownTemplate = await comfyApi('GET', '/workflow/不存在的工作流');
  check('未知工作流 → 404', unknownTemplate.statusCode === 404, String(unknownTemplate.statusCode));

  // 画布前端（vendor 源码被改写后的路径）要走同一份实现
  const canvasCapabilities = await api('GET', '/comfy/capabilities?outputType=videos');
  check('画布命名空间下的 comfy capabilities 与 /api/comfy 完全一致',
    canvasCapabilities.statusCode === 200 && canvasCapabilities.text() === capabilities.text(),
    `${canvasCapabilities.statusCode}`);

  const prepared = await comfyApi('POST', '/prepare/minimax-h3-t2va', { text: '一只猫在雨里走' });
  const preparedBody = prepared.json();
  const preparedNodes = preparedBody.workflow ? Object.keys(preparedBody.workflow).length : 0;
  check('POST /api/comfy/prepare 组装出 t2va 工作流',
    prepared.statusCode === 200 && preparedBody.ok === true && preparedBody.mode === 't2va' && preparedNodes > 0,
    `${prepared.statusCode} mode=${preparedBody.mode} nodes=${preparedNodes}`);

  const badParams = await comfyApi('POST', '/prepare/minimax-h3-t2va', { text: '', mode: '不存在的模式' });
  check('参数非法 → 400 INVALID_COMFY_WORKFLOW',
    badParams.statusCode === 400 && badParams.json().code === 'INVALID_COMFY_WORKFLOW',
    `${badParams.statusCode} ${badParams.text().slice(0, 160)}`);

  const unknownPrepare = await comfyApi('POST', '/prepare/不存在的工作流', {});
  check('未知工作流的 prepare → 404', unknownPrepare.statusCode === 404, String(unknownPrepare.statusCode));
}

// ---------------------------------------------------------------- 同源围栏

{
  async function callRaw(prefix, method, path, headers) {
    const res = new FakeResponse();
    const req = makeReq(method, `${prefix}${path}`);
    req.headers = headers;
    await routes.get(prefix).handler(req, res);
    await waitForFinish(res);
    return res;
  }

  const crossOrigin = await callRaw('/api/aifisher/canvas', 'GET', '/workflows', {
    host: '127.0.0.1:19387',
    origin: 'https://evil.example',
  });
  check('跨站请求被拒绝（画布后端 → 403）', crossOrigin.statusCode === 403, String(crossOrigin.statusCode));

  const sameOrigin = await callRaw('/api/aifisher/canvas', 'GET', '/workflows', {
    host: '127.0.0.1:19387',
    origin: 'http://127.0.0.1:19387',
  });
  check('同源请求放行', sameOrigin.statusCode === 200, String(sameOrigin.statusCode));

  const noOrigin = await callRaw('/api/aifisher/canvas', 'GET', '/workflows', {});
  check('无 Origin（本机探针/curl）放行', noOrigin.statusCode === 200, String(noOrigin.statusCode));

  const crossCanvas = await callRaw('/api/aifisher/canvas', 'GET', '/workflows', {
    host: '127.0.0.1:19387',
    origin: 'https://evil.example',
  });
  check('跨站请求被拒绝（画布路由）', crossCanvas.statusCode === 403, String(crossCanvas.statusCode));

  const crossSkills = await callRaw('/api/aifisher/skills', 'GET', '', {
    host: '127.0.0.1:19387',
    origin: 'https://evil.example',
  });
  check('跨站请求被拒绝（技能路由）', crossSkills.statusCode === 403, String(crossSkills.statusCode));

  const crossComfy = await callRaw('/api/comfy', 'GET', '/ping', {
    host: '127.0.0.1:19387',
    origin: 'https://evil.example',
  });
  check('跨站请求被拒绝（ComfyUI 路由）', crossComfy.statusCode === 403, String(crossComfy.statusCode));
}

// ---------------------------------------------------------------- 技能目录（v1.44）
//
// 2026-10-18 用户原话「检查一下我是否能在画布正常使用skill技能，与画布进行协作」。
// 真机取证：`GET /api/aifisher/skills` 只回 4 条 bundled，用户自己的 10 条一条看不到、
// `/skills/:name` 直接 404 —— 根因是文件系统技能 provider 挂在 agent 作用域，host 上下文的
// ctx.skills 只看得见 global 层。修法 = 画布自己按官方那四个根扫盘（见 src/host/skills/skillsRouter.ts）。
// 这一块就是那套扫描/合并/过滤的回归：夹具技能写在临时 DSH_HOME 里，不碰真机数据。

{
  const skillsRoute = routes.get('/api/aifisher/skills');
  check('技能路由已注册（无条件挂，不再依赖 ctx.skills）', typeof skillsRoute?.handler === 'function');

  const callSkills = async (path, headers) => {
    const res = new FakeResponse();
    await skillsRoute.handler(makeReq('GET', `/api/aifisher/skills${path}`), res);
    await waitForFinish(res);
    return res;
  };

  /** 写一个夹具技能（`SKILL.md` 内容由调用方给）。 */
  const writeSkill = (root, dir, body) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'SKILL.md'), body, 'utf8');
  };

  const userSkills = join(fakeHome, 'skills');
  writeSkill(
    userSkills,
    'fixture-alpha',
    '---\nname: fixture-alpha\ndescription: 用户级夹具技能（中文正文要原样读出来）\n---\n\n# Alpha\n\n正文：一二三。\n',
  );
  writeSkill(
    userSkills,
    'override-me',
    '---\nname: override-me\ndescription: 用户自己的同名技能（应当盖掉 bundled 那条）\n---\n\n# User override\n',
  );
  writeSkill(
    userSkills,
    'hidden-skill',
    '---\nname: hidden-skill\ndescription: user-invocable:false 的技能不该出现在目录里\nuser-invocable: false\n---\n\n# Hidden\n',
  );
  writeSkill(
    userSkills,
    'legacy-skill',
    '---\nname: legacy-skill\ndescription: 旧式 invocation 键会被官方 provider 整条拒绝\nuserInvocable: true\n---\n\n# Legacy\n',
  );
  // 关闭的技能：只剩 SKILL.disabled.md → 不该列
  mkdirSync(join(userSkills, 'off-skill'), { recursive: true });
  writeFileSync(join(userSkills, 'off-skill', 'SKILL.disabled.md'), '---\nname: off-skill\n---\n', 'utf8');

  const listed = await callSkills('');
  const listedBody = listed.json();
  const names = (listedBody.skills ?? []).map((s) => s.name);
  check(
    '技能列表含用户自己的技能（扫 $DSH_HOME/skills）',
    listed.statusCode === 200 && names.includes('fixture-alpha'),
    `${listed.statusCode} ${names.join(',')}`,
  );
  check(
    '列表同时保留 bundled 层（ctx.skills）',
    names.includes('bundled-fixture'),
    names.join(','),
  );
  check(
    '同名条目以用户自己的为准（source=user，不是 bundled）',
    (listedBody.skills ?? []).find((s) => s.name === 'override-me')?.source === 'user',
    JSON.stringify((listedBody.skills ?? []).find((s) => s.name === 'override-me') ?? null),
  );
  check(
    'user-invocable:false 不列（官方 / 菜单也看不见）',
    !names.includes('hidden-skill'),
    names.join(','),
  );
  check('旧式 invocation 键技能不列', !names.includes('legacy-skill'), names.join(','));
  check('SKILL.disabled.md 的技能不列', !names.includes('off-skill'), names.join(','));

  const single = await callSkills('/fixture-alpha');
  const singleBody = single.json();
  check(
    'GET /skills/:name 读到完整正文（中文原样、UTF-8）',
    single.statusCode === 200 &&
      typeof singleBody.skill?.content === 'string' &&
      singleBody.skill.content.includes('正文：一二三') &&
      singleBody.skill.provider === 'dsh-skill-filesystem',
    `${single.statusCode} len=${singleBody.skill?.content?.length ?? 0}`,
  );

  const bundledOnly = await callSkills('/bundled-fixture');
  check(
    'bundled 技能还能走 ctx.skills 取正文（两层合并后 get 仍可用）',
    bundledOnly.statusCode === 200 && bundledOnly.json().skill?.content === '# bundled fixture body',
    String(bundledOnly.statusCode),
  );

  const hidden = await callSkills('/hidden-skill');
  check('不列的技能也读不到（404，不是「列不出来但能加载」）', hidden.statusCode === 404, String(hidden.statusCode));

  const badName = await callSkills('/..%2f..%2fetc%2fpasswd');
  check('非法技能名 → 404（不落到文件系统）', badName.statusCode === 404, String(badName.statusCode));

  // 项目层：`<cwd>/.dsh/skills` 会覆盖用户层的同名技能（官方 provider 的 rank 100 > 400）
  const projectCwd = join(fakeHome, 'workspace-fixture');
  writeSkill(join(projectCwd, '.dsh', 'skills'), 'project-only', '---\nname: project-only\ndescription: 项目级夹具技能\n---\n\n# Project\n');
  writeSkill(join(projectCwd, '.dsh', 'skills'), 'fixture-alpha', '---\nname: fixture-alpha\ndescription: 项目级同名技能（应当盖掉用户级那条）\n---\n\n# Project alpha\n');
  const withCwd = await callSkills(`?cwd=${encodeURIComponent(projectCwd)}`);
  const cwdBody = withCwd.json();
  const cwdNames = (cwdBody.skills ?? []).map((s) => s.name);
  check('带 ?cwd= 时能扫到项目级技能', cwdNames.includes('project-only'), cwdNames.join(','));
  check(
    '项目级同名技能盖掉用户级（source=project）',
    (cwdBody.skills ?? []).find((s) => s.name === 'fixture-alpha')?.source === 'project',
    JSON.stringify((cwdBody.skills ?? []).find((s) => s.name === 'fixture-alpha') ?? null),
  );
  const projectSingle = await callSkills(`/fixture-alpha?cwd=${encodeURIComponent(projectCwd)}`);
  check(
    '带 ?cwd= 的 get 读的是项目级那份正文',
    projectSingle.statusCode === 200 && projectSingle.json().skill.content.includes('Project alpha'),
    String(projectSingle.statusCode),
  );
  const relativeCwd = await callSkills('?cwd=relative%2Fpath');
  check(
    '相对路径的 ?cwd= 被忽略（不会拿进程 cwd 去拼）',
    relativeCwd.statusCode === 200 && !(relativeCwd.json().skills ?? []).some((s) => s.name === 'project-only'),
    String(relativeCwd.statusCode),
  );
}

// ---------------------------------------------------------------- 画布应用产物路由

{
  const res = new FakeResponse();
  await appRoute.handler(makeReq('GET', '/api/aifisher/canvas-app/canvas-app.js'), res);
  await waitForFinish(res);
  check('画布应用 JS 可取到', res.statusCode === 200 && res.text().length > 1_000_000, `${res.statusCode} ${res.text().length}`);
  check('画布应用 JS 带 no-store', res.headers['cache-control'] === 'no-store', String(res.headers['cache-control']));
  check('画布应用 JS 的 MIME 是 javascript', String(res.headers['content-type']).includes('javascript'), String(res.headers['content-type']));

  const chunk = new FakeResponse();
  await appRoute.handler(makeReq('GET', '/api/aifisher/canvas-app/mjStyleCatalog-DzJCaPGy.js'), chunk);
  await waitForFinish(chunk);
  check('画布应用的 chunk 也能取到', chunk.statusCode === 200 && chunk.text().length > 100_000, `${chunk.statusCode} ${chunk.text().length}`);

  const missing = new FakeResponse();
  await appRoute.handler(makeReq('GET', '/api/aifisher/canvas-app/not-exist.js'), missing);
  await waitForFinish(missing);
  check('缺文件返回 404', missing.statusCode === 404, String(missing.statusCode));
}

// ---------------------------------------------------------------- 落盘检查

{
  const dataFile = join(fakeHome, 'storages', 'dsh-aifisher-canvas', 'canvas.json');
  check('数据文件已落盘', existsSync(dataFile), dataFile);
}

rmSync(fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
