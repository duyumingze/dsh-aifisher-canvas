/**
 * 一次性人工核验脚本（不参与回归）：用**真实的 DSH_HOME** 起一次 host 半，
 * 打一次 capabilities / custom-workflows，确认：
 *   1. 用户目录被创建 + README.md 落盘（真机路径）；
 *   2. 真实目录（当前是空的）不会影响内置工作流的能力清单。
 *
 * 只在本地手工跑：node scripts/check-custom-workflows-live.mjs
 */
import { Readable, Writable } from 'node:stream';

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
}

const routes = new Map();
const fakeWebServer = { register: (route) => (routes.set(route.path, route), () => {}) };
const ctxStub = {
  get: (name) => (name === 'webServer' ? fakeWebServer : name === 'skills' ? { list: async () => [], get: async () => null } : undefined),
  logger: { info(...a) { console.log('[info]', ...a); }, warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[err]', ...a) },
  tools: { register: () => () => {} },
};

const hostMod = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href);
hostMod.apply(ctxStub);

const route = routes.get('/api/comfy');
async function get(path) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = path;
  req.headers = {};
  const res = new FakeResponse();
  await route.handler(req, res);
  return { status: res.statusCode, body: res.text() };
}

console.log('DSH_HOME =', process.env.DSH_HOME ?? '(未设置 → 用 homedir()/.dsh)');
const capabilities = await get('/api/comfy/capabilities?outputType=videos');
console.log('capabilities', capabilities.status, capabilities.body.slice(0, 400));
const status = await get('/api/comfy/custom-workflows');
console.log('custom-workflows', status.status, JSON.stringify(JSON.parse(status.body), null, 2).slice(0, 1200));
