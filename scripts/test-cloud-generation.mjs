/**
 * 云端生成代理回归（scripts/test-cloud-generation.mjs）。
 *
 * v1.13 起「自配云端端点（OpenAI 兼容）」单端点已被移除（那张设置卡片 + AIFISHER_CLOUD_BASE_URL
 * 一起下架），所以这条链路改由**用户自配的 OpenAI 通道**来验（通道 -> 请求翻译 -> 归一化 ->
 * 落素材库），全程用**真 HTTP 的假上游**：
 *   - 没配通道 → 501 CLOUD_NOT_CONFIGURED（提示指向「闭源服务 → OpenAI 通道」，不再提环境变量）
 *   - 图片：data[0].url 指向远端 → 下载后落素材库，返回同源 resultUrl（文件真的在盘上）
 *   - 图片：data[0].b64_json → 直接落盘
 *   - 文本：choices[0].message.content → { text }，且没有 messages 时自动包成 chat 请求
 *   - 鉴权头带上 Authorization: Bearer
 *   - 上游 4xx/5xx → 502 CLOUD_UPSTREAM_ERROR，并把上游错误原文带回来
 *   - 上游返回无法识别的形状 → 502 CLOUD_RESULT_UNRECOGNIZED
 *   - 远端结果下载失败 → 不吃掉结果，回落成远程 URL
 *   - 通道端点不可达 → 502 CLOUD_UNREACHABLE
 *   - 通道的 paths.image 覆盖可改路径
 *   - /api/aifisher/canvas/status 暴露云端通道状态且不回显密钥
 *
 * 用法：node scripts/test-cloud-generation.mjs
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startHost, ROOT } from './lib/canvas-harness.mjs';

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

/** 1x1 透明 PNG（真字节：用来验落盘后文件内容确实来自上游）。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------------------
// 假云端上游：一个 http 服务同时扮演「生成端点」和「结果图床」
// ---------------------------------------------------------------------------
const received = [];
let flakyHits = 0;
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    received.push({ url: req.url, method: req.method, headers: req.headers, body });

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // 结果「图床」：生成端点回给画布的远端 URL 指回这里
    if (req.url === '/fake-result.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_BYTES);
      return;
    }

    // 「任务已完成、文件还没落地」的图床：前两次 404，第三次才可读。
    // host 侧的落盘下载必须重试，否则节点会永远指向一个临时链接（过期即空图）。
    if (req.url === '/flaky-result.png') {
      flakyHits += 1;
      if (flakyHits <= 2) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not yet');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_BYTES);
      return;
    }

    if (req.url === '/v1/images/generations' || req.url === '/v1/custom/path') {
      if (body?.model === 'boom') return json(500, { error: { message: '显卡烧了' } });
      if (body?.model === 'weird') return json(200, { ok: true, nothing: 'useful' });
      if (body?.model === 'b64') return json(200, { data: [{ b64_json: PNG_BYTES.toString('base64') }] });
      if (body?.model === 'deadlink') return json(200, { data: [{ url: 'http://127.0.0.1:1/nope.png' }] });
      if (body?.model === 'flaky') return json(200, { data: [{ url: `${base}/flaky-result.png` }] });
      return json(200, { created: 123, data: [{ url: `${base}/fake-result.png` }] });
    }
    if (req.url === '/v1/chat/completions') {
      return json(200, {
        model: 'fake-text',
        choices: [{ message: { role: 'assistant', content: '你好，我是假上游。' } }],
      });
    }
    return json(404, { error: 'no such path' });
  });
});

let base = '';
await new Promise((done) => {
  upstream.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${upstream.address().port}`;
    done();
  });
});
const BASE_URL = `${base}/v1`;
const CHANNEL_LABEL = '回归通道';

const host = await startHost({
  env: {
    // 这轮测的是自配通道；旧单端点已移除，方舟的用例在 test-ark-generation 里
    AIFISHER_CLOUD_BASE_URL: null,
    AIFISHER_CLOUD_API_KEY: null,
    ARK_API_KEY: null,
  },
});

function generate(kind, body) {
  return host.dispatch('POST', `/api/aifisher/canvas/generate-${kind}`, body);
}

const channelsApi = (method, body) => host.hostApi(method, '/cloud-channels', body);

/** 本站素材 URL → 磁盘路径（验落盘用）。 */
function diskPathOf(url) {
  const rel = decodeURIComponent(String(url).replace('/api/aifisher/canvas/media/', ''));
  return join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', ...rel.split('/'));
}

/**
 * 最后一次「生成调用」。
 * 注意不能用 received.at(-1)：落盘时还会去图床拉一次结果字节，
 * 那条请求也在 received 里，会把真正要断言的那条挤掉。
 */
function lastCall() {
  return [...received].reverse().find((item) => item.url !== '/fake-result.png');
}

/** 存通道（同 id 覆盖）；返回整张表。 */
async function saveChannel(patch = {}) {
  const saved = await channelsApi('POST', {
    action: 'save',
    channel: {
      id: 'regression',
      label: CHANNEL_LABEL,
      baseUrl: BASE_URL,
      apiKey: 'sk-test-123',
      paths: {},
      models: [
        { id: 'fake-image', kind: 'image' },
        { id: 'b64', kind: 'image' },
        { id: 'boom', kind: 'image' },
        { id: 'weird', kind: 'image' },
        { id: 'deadlink', kind: 'image' },
        { id: 'flaky', kind: 'image' },
        { id: 'fake-text', kind: 'text' },
      ],
      ...patch,
    },
  });
  return saved;
}

// ---------------------------------------------------------------------------
console.log('\n=== 没有通道时：501 且指路到通道面板 ===');
{
  const empty = await channelsApi('GET');
  check('起步：通道表是空的', empty.json().channels?.length === 0, empty.text.slice(0, 120));
  check(
    '起步：响应里不再有 legacy 字段（v1.13 移除了单端点）',
    empty.json().legacy === undefined,
    JSON.stringify(empty.json().legacy),
  );

  const result = await generate('image', { prompt: 'x', imageModel: 'fake-image' });
  const body = JSON.parse(result.body);
  check('未配置 → 501', result.status === 501, `status=${result.status}`);
  check('未配置 → code=CLOUD_NOT_CONFIGURED', body.code === 'CLOUD_NOT_CONFIGURED', body.code);
  check(
    '未配置 → 提示指向「OpenAI 通道」，不再提 AIFISHER_CLOUD_BASE_URL',
    String(body.error).includes('OpenAI 通道') && !String(body.error).includes('AIFISHER_CLOUD_BASE_URL'),
    body.error,
  );

  const saved = await saveChannel();
  check('建通道：200 且回整张表', saved.status === 200 && saved.json().channels?.length === 1, String(saved.status));
}

// ---------------------------------------------------------------------------
console.log('\n=== 图片：远端 url → 落素材库 ===');
{
  const result = await generate('image', {
    projectId: 'proj-cloud',
    nodeId: 'n1',
    prompt: '一只猫',
    imageModel: 'fake-image',
  });
  const body = JSON.parse(result.body);
  check('远端 url → 200', result.status === 200, `status=${result.status} ${result.body.slice(0, 160)}`);
  check(
    '返回 resultUrl 是本站素材 URL',
    typeof body.resultUrl === 'string' && body.resultUrl.startsWith('/api/aifisher/canvas/media/'),
    body.resultUrl,
  );
  check('resultUrls[0] === resultUrl', Array.isArray(body.resultUrls) && body.resultUrls[0] === body.resultUrl);
  check('回执里带上通道名（知道这批图走哪条通道来的）', body.channelLabel === CHANNEL_LABEL, String(body.channelLabel));
  const filePath = diskPathOf(body.resultUrl);
  check('结果文件真的落盘', existsSync(filePath), filePath.slice(-70));
  if (existsSync(filePath)) {
    check('落盘内容与上游图床字节一致', readFileSync(filePath).equals(PNG_BYTES));
  }
  check(
    '上游收到 Bearer 鉴权头',
    lastCall()?.headers?.authorization === 'Bearer sk-test-123',
    lastCall()?.headers?.authorization,
  );
  check('prompt 原样透传', lastCall()?.body?.prompt === '一只猫');
  check('发给上游的是纯模型 ID', lastCall()?.body?.model === 'fake-image', String(lastCall()?.body?.model));
  check('打到默认路径 /v1/images/generations', lastCall()?.url === '/v1/images/generations', lastCall()?.url);
}

// ---------------------------------------------------------------------------
console.log('\n=== 图片：b64_json → 直接落盘 ===');
{
  const result = await generate('image', { projectId: 'proj-cloud', prompt: 'b64', imageModel: 'b64' });
  const body = JSON.parse(result.body);
  check('b64_json → 200', result.status === 200, `status=${result.status}`);
  const filePath = diskPathOf(body.resultUrl);
  check('b64 结果落盘且字节正确', existsSync(filePath) && readFileSync(filePath).equals(PNG_BYTES));
}

// ---------------------------------------------------------------------------
console.log('\n=== 文本 ===');
{
  const result = await generate('text', { prompt: '打个招呼', textModel: 'fake-text' });
  const body = JSON.parse(result.body);
  check('文本 → 200', result.status === 200, `status=${result.status}`);
  check('choices[].message.content → text', body.text === '你好，我是假上游。', JSON.stringify(body.text));
  check('没有 messages 时自动包成 chat 请求', Array.isArray(lastCall()?.body?.messages), JSON.stringify(lastCall()?.body).slice(0, 120));
  check('打到默认路径 /v1/chat/completions', lastCall()?.url === '/v1/chat/completions', lastCall()?.url);
}

// ---------------------------------------------------------------------------
console.log('\n=== 提示词助手：走第一条带文本模型的通道 ===');
{
  const optimize = await host.dispatch('POST', '/api/aifisher/canvas/prompt-assistant/optimize-prompt', {
    prompt: '一只猫',
  });
  const body = JSON.parse(optimize.body);
  check('有文本通道 → 200', optimize.status === 200, `status=${optimize.status} ${optimize.body.slice(0, 120)}`);
  check(
    '返回 optimizedPrompt（取自通道端点的 chat 回复）',
    body.optimizedPrompt === '你好，我是假上游。',
    JSON.stringify(body.optimizedPrompt),
  );
  check(
    '打到通道的 /v1/chat/completions，模型是纯模型 ID',
    lastCall()?.url === '/v1/chat/completions' && lastCall()?.body?.model === 'fake-text',
    `${lastCall()?.url} ${lastCall()?.body?.model}`,
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 错误路径 ===');
{
  const result = await generate('image', { prompt: 'x', imageModel: 'boom' });
  const body = JSON.parse(result.body);
  check('上游 500 → 502', result.status === 502, `status=${result.status}`);
  check(
    '上游错误原文带回来',
    body.code === 'CLOUD_UPSTREAM_ERROR' && String(body.error).includes('显卡烧了'),
    body.error,
  );

  const weird = await generate('image', { prompt: 'x', imageModel: 'weird' });
  const weirdBody = JSON.parse(weird.body);
  check(
    '无法识别的响应 → 502 CLOUD_RESULT_UNRECOGNIZED',
    weird.status === 502 && weirdBody.code === 'CLOUD_RESULT_UNRECOGNIZED',
    weirdBody.code,
  );

  const dead = await generate('image', { prompt: 'x', imageModel: 'deadlink' });
  const deadBody = JSON.parse(dead.body);
  check(
    '远端结果下载失败 → 不吃掉结果，回落远程 URL',
    dead.status === 200 && deadBody.resultUrl === 'http://127.0.0.1:1/nope.png',
    JSON.stringify(deadBody.resultUrl),
  );

  // 落盘重试（2026-10-20）：服务商图床常常「任务已经 SUCCESS、文件还没落地」，
  // 前几次 GET 是 404。旧实现一次失败就把临时链接写进节点 —— 链接过期后节点只剩一块黑。
  const flaky = await generate('image', { prompt: 'x', imageModel: 'flaky' });
  const flakyBody = JSON.parse(flaky.body);
  check(
    '图床前两次 404 → 重试后照样落盘（节点不指向临时链接）',
    flaky.status === 200 && String(flakyBody.resultUrl).startsWith('/api/aifisher/canvas/media/'),
    `${flaky.status} ${String(flakyBody.resultUrl).slice(0, 80)}`,
  );
  const flakyPath = diskPathOf(flakyBody.resultUrl || '');
  check(
    '重试落盘的文件内容与图床字节一致',
    existsSync(flakyPath) && readFileSync(flakyPath).equals(PNG_BYTES),
    flakyPath.slice(-60),
  );
  check('图床被请求 3 次（2 次 404 + 1 次 200）', flakyHits === 3, `hits=${flakyHits}`);

  await saveChannel({ baseUrl: 'http://127.0.0.1:1/v1' });
  const unreachable = await generate('image', { prompt: 'x', imageModel: 'fake-image' });
  const unreachableBody = JSON.parse(unreachable.body);
  check(
    '通道不可达 → 502 CLOUD_UNREACHABLE',
    unreachable.status === 502 && unreachableBody.code === 'CLOUD_UNREACHABLE',
    `${unreachableBody.code} ${String(unreachableBody.error).slice(0, 80)}`,
  );
  check(
    '不可达时说清是哪条通道',
    String(unreachableBody.error).includes(CHANNEL_LABEL),
    String(unreachableBody.error).slice(0, 100),
  );
  await saveChannel({ baseUrl: BASE_URL });
}

// ---------------------------------------------------------------------------
console.log('\n=== 路径可配置 / 请求体校验 / 状态端点 ===');
{
  await saveChannel({ paths: { image: '/custom/path' } });
  const result = await generate('image', { prompt: 'x', imageModel: 'fake-image' });
  check(
    '通道的 paths.image 覆盖生效（拼在 baseUrl 之后）',
    result.status === 200 && lastCall()?.url === '/v1/custom/path',
    `status=${result.status} url=${lastCall()?.url}`,
  );
  await saveChannel({ paths: {} });

  // 空 body：readJsonBody 把「空」当 {}（不是 null），于是走默认 projectId —— 这本身是合理行为，
  // 断言它别炸即可；真正的坏 JSON 才该 422（下面手工造一个）。
  const empty = await generate('image', { imageModel: 'fake-image' });
  const emptyBody = JSON.parse(empty.body);
  check(
    '空 body → 不炸，落到 default 项目',
    empty.status === 200 && String(emptyBody.resultUrl).includes('/media/default/'),
    `status=${empty.status} ${emptyBody.resultUrl}`,
  );

  const { Readable } = await import('node:stream');
  const route = host.routes.get('/api/aifisher/canvas');
  const brokenReq = Readable.from([Buffer.from('{not json', 'utf8')]);
  brokenReq.method = 'POST';
  brokenReq.url = '/api/aifisher/canvas/generate-image';
  brokenReq.headers = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' };
  const { Writable } = await import('node:stream');
  const brokenChunks = [];
  const brokenRes = new (class extends Writable {
    constructor() {
      super();
      this.statusCode = 0;
      this.headers = {};
    }
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers ?? {});
      return this;
    }
    _write(chunk, _e, cb) {
      brokenChunks.push(chunk);
      cb();
    }
  })();
  await route.handler(brokenReq, brokenRes);
  check(
    '坏 JSON body → 422 INVALID_BODY',
    brokenRes.statusCode === 422 && Buffer.concat(brokenChunks).toString('utf8').includes('INVALID_BODY'),
    `${brokenRes.statusCode} ${Buffer.concat(brokenChunks).toString('utf8').slice(0, 80)}`,
  );

  const status = await host.hostApi('GET', '/status');
  const statusBody = JSON.parse(status.text);
  check('canvas/status 暴露云端通道状态', statusBody.cloud?.configured === true, JSON.stringify(statusBody.cloud));
  check(
    '状态里只有通道名/条数，没有密钥',
    statusBody.cloud?.channels?.[0]?.label === CHANNEL_LABEL &&
      !JSON.stringify(statusBody.cloud).includes('sk-test-123'),
    JSON.stringify(statusBody.cloud),
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 产物契约 ===');
{
  const hostBundle = readFileSync(resolve(ROOT, 'lib/index.js'), 'utf8');
  check('产物里有云端代理', hostBundle.includes('CLOUD_NOT_CONFIGURED'));
  check('产物里有通道存储文件名', hostBundle.includes('cloud-channels.json'));
}

upstream.close();

console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
if (fail) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
}
process.exit(fail ? 1 : 0);
