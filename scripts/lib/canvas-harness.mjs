/**
 * 画布测试公共装置：把一个「假 DSH 宿主」搭起来。
 *
 * 做两件事：
 *   1. startHost()  —— import lib/index.js 并用假 webServer 捕获路由注册，
 *                      于是可以对**真实的**插件路由发请求（等价于同源 fetch）；
 *   2. createCanvasDom() —— 建 jsdom 环境、把浏览器全局灌进 globalThis，
 *                      并让 window.fetch 走上面的路由分发器。
 *
 * 这不是浏览器：jsdom 没有 WebGL/真实布局。但它足以验证「模块图 + 数据链路 + 不崩」。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ORIGIN = 'http://127.0.0.1:19387';

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
    // 客户端挂断后处理器仍可能往里写（流式接口的收尾就是），这里吞掉流错误：
    // 真实的 node res 也会把这种写失败交给调用方的回调，不会掀翻进程。
    this.on('error', () => {});
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

/** 启动 host 半（真路由、临时 DSH_HOME）。 */
export async function startHost(options = {}) {
  const fakeHome = options.fakeHome ?? mkdtempSync(join(tmpdir(), 'dsh-aifisher-test-'));
  process.env.DSH_HOME = fakeHome;
  // 用例可以用 options.env 覆盖/删除环境变量（值传 null = 删掉该环境变量）。
  const env = {
    ...(options.env ?? {}),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete process.env[key];
    else process.env[key] = String(value);
  }

  const routes = new Map();
  const tools = [];
  const logs = [];
  const fakeWebServer = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const record = (level) => (...args) => {
    logs.push(
      `${level} ${args
        .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
        .join(' ')}`,
    );
  };

  // ---- 画布对话面板的宿主桩（options.chat）------------------------------------
  // 真机上「画布对话」的正文来自 DSH 的 sessionController + agent/assistant-stream；
  // 这里把这两样做成可控的假件：prompt() 默认自动回一段流式文本（可关掉换成手动 emit）。
  const listeners = new Map();
  const chat = {
    created: [],
    prompts: [],
    cancelled: [],
    selectedModels: [],
    promptCountBySession: new Map(),
  };
  /**
   * 直接派发一个宿主事件（绕过 cordis，直接调插件注册的监听器）。
   * 返回第一个非 undefined 的返回值 —— `agent/pre-step` 这种瀑布用它拿回决定。
   */
  const emit = async (name, ...args) => {
    const results = [];
    for (const listener of [...(listeners.get(name) ?? [])]) {
      try {
        results.push(await listener(...args));
      } catch (error) {
        logs.push(`error listener ${name}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return results.find((value) => value !== undefined);
  };
  const emitStream = (sessionId, frame) =>
    void emit('agent/assistant-stream', { agent: { session: { id: sessionId } }, frame });
  /** 派发一个 durable 会话事件（`session/event`：session, event）—— v1.13 起回合收尾看它。 */
  const emitSessionEvent = (sessionId, event) =>
    void emit('session/event', { header: { id: sessionId }, id: sessionId }, event);
  /** 派发「用户消息被领进某个 turn」（真实宿主由 agent 循环发出）。 */
  const emitInboxClaimed = (sessionId, requestId, turn) =>
    void emit('agent/inbox/claimed', {
      agent: { session: { id: sessionId } },
      message: { id: `msg-${turn}`, source: { kind: 'user', rpcId: requestId } },
      turn,
    });
  const sessionController = {
    async create(request) {
      chat.created.push({ ...request });
      return { sessionId: request.sessionId };
    },
    async prompt(request) {
      chat.prompts.push({ ...request });
      chat.promptCountBySession.set(
        request.sessionId,
        (chat.promptCountBySession.get(request.sessionId) ?? 0) + 1,
      );
      if (options.chatAutoReply === false) return { accepted: true };
      const text = typeof options.chatReply === 'function'
        ? options.chatReply(request)
        : (options.chatReply ?? `收到：${request.content?.[0]?.text ?? ''}`);
      const turn = chat.promptCountBySession.get(request.sessionId);
      setTimeout(() => {
        // 真机顺序：消息被领进 turn → attempt 的 start/chunks/end → 持久 assistant/message → turn/end
        emitInboxClaimed(request.sessionId, request.requestId, turn);
        emitStream(request.sessionId, { type: 'start', revision: 1 });
        for (const token of String(text).match(/.{1,8}/gs) ?? []) {
          emitStream(request.sessionId, { type: 'chunk', chunk: { type: 'text-delta', text: token } });
        }
        emitStream(request.sessionId, { type: 'end', revision: 1 });
        if (options.chatAutoDurable !== false) {
          emitSessionEvent(request.sessionId, {
            type: 'assistant/message',
            seq: 100 + turn,
            time: Date.now(),
            data: {
              turn,
              step: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: String(text) }] },
            },
          });
          emitSessionEvent(request.sessionId, {
            type: 'turn/end',
            seq: 200 + turn,
            time: Date.now(),
            data: { turn, reason: { kind: 'completed' } },
          });
        }
      }, 0);
      return { accepted: true };
    },
    async cancel(request) {
      chat.cancelled.push(request.sessionId);
      return { ok: true };
    },
    async modelCatalog() {
      return (
        options.modelCatalog ?? {
          default: { provider: 'fake-cloud', model: 'fake-chat' },
          groups: [
            {
              id: 'fake-cloud',
              name: '假云端',
              models: [{ id: 'fake-chat', name: '假对话模型' }],
            },
          ],
        }
      );
    },
    async selectModel(request) {
      chat.selectedModels.push({ ...request });
      return { selected: { provider: request.provider, model: request.model } };
    },
  };

  const ctxStub = {
    get(name) {
      if (name === 'webServer') return fakeWebServer;
      if (name === 'skills') return { list: async () => [], get: async () => null };
      // 画布对话默认**不**提供 sessionController（老宿主/未 compose 的场景），
      // 要用它得显式 startHost({ chat: true })。
      if (name === 'sessionController' && options.chat !== true) return undefined;
      if (name === 'sessionController') return sessionController;
      // 模型清单的「来源有没有配密钥」探测（v1.13）：只有显式传了才生效，否则不过滤。
      if (name === 'llm') return options.llm;
      if (name === 'settings') return options.settings;
      if (name === 'credentials') return options.credentials;
      return undefined;
    },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name)?.delete(listener);
    },
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    tools: {
      register: (tool) => {
        tools.push(tool);
        return () => {};
      },
    },
  };

  const hostMod = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
  hostMod.apply(ctxStub);

  function pickRoute(pathname) {
    let best = null;
    for (const [prefix, route] of routes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        if (!best || prefix.length > best.prefix.length) best = { prefix, route };
      }
    }
    return best?.route ?? null;
  }

  /** 把一次 HTTP 请求派发给真实路由处理器。 */
  async function dispatch(method, url, body, options = {}) {
    const target = new URL(url, ORIGIN);
    const route = pickRoute(target.pathname);
    if (!route) {
      return {
        status: 404,
        body: JSON.stringify({ error: 'no route', path: target.pathname }),
        headers: { 'content-type': 'application/json' },
      };
    }
    if (options.shortPoll && target.pathname.endsWith('/agent/external/poll')) {
      await new Promise((done) => setTimeout(done, options.shortPoll));
      return { status: 200, body: '[]', headers: { 'content-type': 'application/json' } };
    }
    /**
     * body 支持四种形态（v1.42 起）：
     *   - `undefined`            → 空 body（GET）
     *   - 字符串                 → **原样**当请求体字节。既有套件都传 `JSON.stringify(...)`，
     *                             与以前「JSON.parse 再 stringify」的字节完全一致，行为不变；
     *   - `ArrayBuffer` / Buffer → 原始字节（项目归档导入这类二进制上传）；
     *   - Blob/File              → 读成 ArrayBuffer 再当字节；
     *   - 其它对象               → JSON.stringify（`hostApi(method, path, body)` 走这条）。
     */
    const bodyToChunks = async (body) => {
      if (body === undefined || body === null) return [];
      if (Buffer.isBuffer(body)) return [body];
      if (typeof body === 'string') return [Buffer.from(body, 'utf8')];
      if (body instanceof ArrayBuffer) return [Buffer.from(new Uint8Array(body))];
      if (ArrayBuffer.isView(body)) {
        return [Buffer.from(body.buffer, body.byteOffset, body.byteLength)];
      }
      if (typeof body.arrayBuffer === 'function') {
        return [Buffer.from(new Uint8Array(await body.arrayBuffer()))];
      }
      /**
       * jsdom 的 Blob/File **没有** arrayBuffer()/stream()/text()（实测 jsdom 26 三个都是
       * undefined），但它的 FileReader 能读自己的 Blob。所以这里按 Blob 形状退回
       * FileReader —— 只有在 createCanvasDom 之后 globalThis.FileReader 才存在。
       */
      if (typeof body.size === 'number' && typeof globalThis.FileReader === 'function') {
        const bytes = await new Promise((resolve, reject) => {
          const reader = new globalThis.FileReader();
          reader.onload = () => resolve(Buffer.from(new Uint8Array(reader.result)));
          reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
          reader.readAsArrayBuffer(body);
        });
        return [bytes];
      }
      return [Buffer.from(JSON.stringify(body), 'utf8')];
    };
    const chunks = await bodyToChunks(body);
    const req = Readable.from(chunks);
    req.method = method;
    req.url = `${target.pathname}${target.search}`;
    // v1.42：允许用例/客户端带 content-type —— `/workflows/restore` 靠它分流
    // （application/json = 本机路径；其它 = 原始归档字节）。
    req.headers = { host: target.host, origin: ORIGIN, ...(options.headers ?? {}) };
    const res = new FakeResponse();
    // 模拟「客户端中途挂断」（面板点停止 / 关掉面板）：流式接口应当据此打断宿主回合。
    if (options.abortAfterMs) {
      setTimeout(() => {
        try {
          res.destroy();
        } catch {
          /* 已经结束 */
        }
      }, options.abortAfterMs);
    }
    await route.handler(req, res);
    if (!res.writableFinished && !res.destroyed) await new Promise((done) => res.once('finish', done));
    return { status: res.statusCode, body: res.text(), headers: res.headers, destroyed: res.destroyed };
  }

  /** 直接调画布本地后端（测试自己造数据/读状态用）。 */
  async function hostApi(method, path, body) {
    const result = await dispatch(method, `/api/aifisher/canvas${path}`, body);
    return { status: result.status, text: result.body, json: () => JSON.parse(result.body) };
  }

  return {
    fakeHome,
    routes,
    tools,
    logs,
    dispatch,
    hostApi,
    tool: (name) => tools.find((item) => item.name === name),
    // 画布对话用：假 sessionController 记录 + 流式帧注入 + 宿主事件直调
    chat,
    sessionController,
    emitStream,
    emitSessionEvent,
    emitInboxClaimed,
    emit,
  };
}

/** 建 jsdom 环境并把浏览器全局灌进 globalThis。 */
export async function createCanvasDom(options = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="host"></div></body></html>',
    { url: `${ORIGIN}/`, pretendToBeVisual: true },
  );
  const { window } = dom;

  class StubObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  window.ResizeObserver = StubObserver;
  window.IntersectionObserver = StubObserver;
  window.matchMedia ??= () => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  window.requestIdleCallback ??= (cb) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
  window.EventSource ??= class {
    constructor() {}
    close() {}
    addEventListener() {}
  };
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';

  const fetchCalls = [];
  /**
   * 把 fetch 的 headers 归一成小写 key 的普通对象（支持 Headers / 对象 / 数组三种写法），
   * 好让 dispatch 把它塞进 req.headers —— 客户端的 `Content-Type` 决定 host 怎么读 body。
   */
  const normalizeHeaders = (headers) => {
    const result = {};
    if (!headers) return result;
    if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
      headers.forEach((value, key) => {
        result[String(key).toLowerCase()] = String(value);
      });
      return result;
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && pair.length === 2) result[String(pair[0]).toLowerCase()] = String(pair[1]);
      }
      return result;
    }
    if (typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers)) {
        result[String(key).toLowerCase()] = String(value);
      }
    }
    return result;
  };
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const method = String(init.method ?? 'GET').toUpperCase();
    fetchCalls.push(`${method} ${url}`);
    // body 原样交给 dispatch：字符串就是字节（JSON 字符串与以前等价），
    // Blob/File/ArrayBuffer 走原始字节（v1.42：项目归档导入要能上传二进制）
    const body = init.body === undefined ? undefined : init.body;
    const { status, body: text, headers } = await options.dispatch(method, url, body, {
      headers: normalizeHeaders(init.headers),
    });
    return new Response(text, { status, headers });
  };

  const globals = {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    // Radix 的 Slider 会做 `form instanceof HTMLFormElement`（表单 reset 联动），
    // 少这个全局就会在 jsdom 里抛「HTMLFormElement is not defined」——画布一挂就白屏。
    HTMLFormElement: window.HTMLFormElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    HTMLDivElement: window.HTMLDivElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    HTMLDocument: window.HTMLDocument,
    ShadowRoot: window.ShadowRoot ?? null,
    NodeList: window.NodeList,
    EventTarget: window.EventTarget,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    PointerEvent: window.PointerEvent ?? window.MouseEvent,
    DragEvent: window.DragEvent ?? window.Event,
    ClipboardEvent: window.ClipboardEvent ?? window.Event,
    InputEvent: window.InputEvent ?? window.Event,
    FocusEvent: window.FocusEvent ?? window.Event,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    requestIdleCallback: window.requestIdleCallback,
    ResizeObserver: StubObserver,
    IntersectionObserver: StubObserver,
    MutationObserver: window.MutationObserver,
    // tiptap（文本节点编辑器）在挂载时会用 `document.createTreeWalker(..., NodeFilter.SHOW_TEXT)`
    // 读全局的 NodeFilter；jsdom 不给这个全局 → 建文本节点时抛「NodeFilter is not defined」。
    NodeFilter: window.NodeFilter,
    matchMedia: window.matchMedia,
    fetch: window.fetch,
    EventSource: window.EventSource,
    DOMParser: window.DOMParser,
    Image: window.Image,
    Audio: window.Audio ?? class { play() {} pause() {} },
    File: window.File,
    Blob: window.Blob,
    FileReader: window.FileReader,
    FormData: window.FormData,
    XMLHttpRequest: window.XMLHttpRequest,
    alert: () => {},
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });

  return { dom, window, fetchCalls };
}

/** 让 React 渲染与网络回调跑完。 */
export async function settle(ms = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** 把一个容器加到 body 并挂载画布应用。 */
export async function mountCanvasApp(window) {
  const canvasApp = await import(pathToFileURL(join(ROOT, 'lib/canvas/canvas-app.js')).href);
  const container = window.document.createElement('div');
  container.className = 'af-canvas-mount';
  container.style.width = '1280px';
  container.style.height = '800px';
  window.document.body.appendChild(container);
  const handle = canvasApp.mountCanvas(container);
  return { canvasApp, container, handle };
}

/** 预置一条「上次打开的项目」，让画布启动后直接进画布视图（等价于刷新恢复）。 */
export function seedResume(window, workflowId, viewport = { x: 0, y: 0, zoom: 1 }) {
  window.sessionStorage.setItem(
    'fisherai.canvas.resume.v1',
    JSON.stringify({ version: 1, workflowId, folderId: null, viewport }),
  );
}
