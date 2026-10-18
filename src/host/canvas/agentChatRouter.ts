/**
 * 画布右侧对话面板的后端（host 半）。
 *
 * 上游 AIFISHER 的 Agent 面板（vendor 的 canvasAgentPanel / canvasAgentChat / agentClient）
 * 按一套 HTTP 契约说话，我们**不改 vendor 一行**，在这里把那套契约实现出来：
 *
 *   GET/PUT /api/aifisher/canvas/agent/workspace?projectId=…  每个项目的助手草稿（revision 乐观并发）
 *   GET     /api/aifisher/canvas/agent/codex/status           Codex 直连（本插件没有这条后端）→ 诚实回「未接入」
 *   GET     /api/aifisher/canvas/agent/codex/sessions         同上，回空列表
 *   GET     /api/aifisher/canvas/chat/models                  模型下拉的候选（DSH 的模型目录）
 *   POST    /api/aifisher/canvas/chat/stream                  发一条消息，SSE 回 delta/done/error
 *   POST    /api/aifisher/canvas/chat                         同一件事的非流式版本
 *   GET     /api/aifisher/canvas/chat/sessions                对话历史列表
 *   GET     /api/aifisher/canvas/chat/sessions/:id            一份对话的全部消息
 *   DELETE  /api/aifisher/canvas/chat/sessions/:id
 *   POST    /api/aifisher/canvas/chat/actions/:requestId      画布动作回执（我们不下发 canvas_action，兼容用）
 *   POST    /api/aifisher/canvas/chat/tools/search-nodes      节点搜索
 *
 * 「大脑」在 canvasChatHub：一条画布对话 = 一个 DSH 会话，靠 sessionController 投递消息、
 * 靠 agent/assistant-stream 收流式正文。于是画布助手天然拥有 canvas_control 工具
 * （read/edit/undo/focus…，走 agentBridge 长轮询下发到画布），不需要另配模型与密钥。
 *
 * 未移植的能力（SKILL / 导演台）明确回 501 + code，而不是假装 404 —— 否则面板只能显示
 * 一句无信息量的「请求失败」。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonBody, sendJson } from '../http/httpUtil';
import type { AgentChatStore, ChatSessionRecord, ChatStoredMessage } from './agentChatStore';
import type { CanvasChatHub, CanvasActionNote } from './canvasChatHub';
import type { MediaStore } from './mediaStore';

/** 一条附件（面板 media 数组的元素）。 */
interface ChatMediaInput {
  type?: unknown;
  url?: unknown;
  base64?: unknown;
}

/** 面板一起带过来的「引用节点」。 */
interface ChatNodeInput {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  prompt?: unknown;
  textContent?: unknown;
  model?: unknown;
  imageModel?: unknown;
  videoModel?: unknown;
  audioModel?: unknown;
  comfyMode?: unknown;
}

export interface AgentChatDeps {
  /** 画布数据目录（上传的附件与对话存档都落这儿）。 */
  dataDir: string;
  /** 对话存档（会话映射 + 消息 + 助手草稿）。 */
  store: AgentChatStore;
  /** DSH 会话大脑；宿主没给 sessionController 时为 null（路由会回 503 说明原因）。 */
  chat: CanvasChatHub | null;
  mediaStore?: MediaStore | null;
}

/** 附件落盘目录（base64 图片要变成 agent 能读的文件）。 */
const UPLOAD_DIR = 'agent-chat-uploads';

function notPorted(res: ServerResponse, what: string): void {
  sendJson(res, 501, {
    error: `${what}尚未移植到 DSH 版画布。`,
    code: 'NOT_PORTED',
  });
}

function isUuidLike(value: string): boolean {
  return /^[A-Za-z0-9_-]{6,80}$/.test(value);
}

/** 从 base64 头几个字节猜扩展名（面板给的是裸 base64，不带 mime）。 */
function imageExtension(base64: string): string {
  if (base64.startsWith('/9j/')) return 'jpg';
  if (base64.startsWith('iVBOR')) return 'png';
  if (base64.startsWith('R0lGOD')) return 'gif';
  if (base64.startsWith('UklGR')) return 'webp';
  if (base64.startsWith('Qk0')) return 'bmp';
  return 'png';
}

/** 把面板带上来的附件变成 agent 能用的东西（路径或 URL），并生成一行提示。 */
function describeMedia(media: ChatMediaInput[], deps: AgentChatDeps): string[] {
  const notes: string[] = [];
  let index = 0;
  for (const item of media) {
    index += 1;
    const kind = typeof item.type === 'string' ? item.type : 'file';
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '附件';
    const base64 = typeof item.base64 === 'string' ? item.base64 : '';
    if (base64) {
      try {
        const dir = join(deps.dataDir, UPLOAD_DIR);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${imageExtension(base64)}`);
        writeFileSync(file, Buffer.from(base64, 'base64'));
        notes.push(`[${label}附件 ${index}：${file}]`);
        continue;
      } catch (error) {
        notes.push(
          `[${label}附件 ${index}：写入失败（${error instanceof Error ? error.message : String(error)}）]`,
        );
        continue;
      }
    }
    const url = typeof item.url === 'string' ? item.url : '';
    if (!url) {
      notes.push(`[${label}附件 ${index}：内容不可用]`);
      continue;
    }
    const local = deps.mediaStore?.localPathForUrl(url) ?? null;
    notes.push(local ? `[${label}附件 ${index}：${local.path}]` : `[${label}附件 ${index}：${url}]`);
  }
  return notes;
}

/** 引用节点的极简描述：够模型判断「用户在说哪个节点」，细节让 canvas_control read 去拿。 */
function describeNodes(nodes: ChatNodeInput[]): string[] {
  if (nodes.length === 0) return [];
  const lines = nodes.slice(0, 12).map((node, index) => {
    const id = typeof node.id === 'string' ? node.id : `#${index + 1}`;
    const type = typeof node.type === 'string' ? node.type : '节点';
    const title = typeof node.title === 'string' ? node.title : '';
    const text = [node.prompt, node.textContent]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' / ')
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    const model = [node.imageModel, node.videoModel, node.audioModel, node.model]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(',');
    return `- ${id}（${type}${title ? ` · ${title}` : ''}）${text ? ` ${text}` : ''}${model ? ` [${model}]` : ''}`;
  });
  const more = nodes.length > 12 ? `\n（还有 ${nodes.length - 12} 个引用节点未列出）` : '';
  return [`[用户在画布上引用了这些节点]\n${lines.join('\n')}${more}`];
}

/** 把用户消息 + 附件 + 引用节点拼成投给 agent 的正文。 */
export function composeChatPrompt(
  message: string,
  media: ChatMediaInput[],
  nodes: ChatNodeInput[],
  deps: AgentChatDeps,
): string {
  const blocks: string[] = [];
  const text = message.trim();
  if (text) blocks.push(text);
  const mediaNotes = describeMedia(media, deps);
  if (mediaNotes.length) blocks.push(mediaNotes.join('\n'));
  const nodeNotes = describeNodes(nodes);
  if (nodeNotes.length) blocks.push(nodeNotes.join('\n'));
  return blocks.join('\n\n') || '（用户发送了空消息）';
}

function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

/** 写一个 SSE 事件块（agentClient 的解析器按「空行分块 + event:/data:」读）。 */
function writeEvent(res: ServerResponse, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* 客户端已经断开：写失败不是错误 */
  }
}

export interface AgentChatRouterInput {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** 相对 /api/aifisher/canvas 的路径段。 */
  parts: string[];
  deps: AgentChatDeps;
}

/** 处理一条画布对话路由；已处理返回 true。 */
export async function handleAgentChatApi(input: AgentChatRouterInput): Promise<boolean> {
  const { req, res, url, parts, deps } = input;
  const method = (req.method ?? 'GET').toUpperCase();
  if (parts[0] === 'agent' && parts[1] === 'workspace') return handleWorkspace(input, method);
  if (parts[0] === 'agent' && parts[1] === 'codex') return handleCodexStub(res, parts, method);
  // 服务端授权的「连续生成」与「生成批次记录」这两套后端没有移植（它们上游挂在闭源服务上）。
  // 面板一打开就会读这两份清单：读接口如实回空数组（于是面板那块什么都不显示），
  // 写成 501 反而会在对话里挂一行红字（用户看到的「读取失败」）。
  if (parts[0] === 'agent' && (parts[1] === 'plans' || parts[1] === 'budgets')) {
    if (method === 'GET') {
      sendJson(res, 200, []);
      return true;
    }
    notPorted(res, parts[1] === 'plans' ? '画布生成批次记录' : '连续生成授权（预算）');
    return true;
  }
  if (parts[0] !== 'chat') return false;

  if (parts.length === 1) {
    // 非流式发消息（agentClient.sendMessage；面板走的是 /chat/stream）
    if (method === 'POST') {
      await handleChatOnce(req, res, deps);
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  const section = parts[1];
  if (section === 'models' && method === 'GET') {
    await handleModels(res, deps);
    return true;
  }
  if (section === 'stream' && method === 'POST') {
    await handleStream(req, res, deps);
    return true;
  }
  if (section === 'sessions') return handleSessions(req, res, parts, method, deps);
  if (section === 'actions' && method === 'POST') {
    // 我们不让 agent 走「下发 canvas_action 让页面执行」那条路（它用的是 canvas_control 工具），
    // 但面板收到 canvas_result 时仍可能回执；接了并确认，免得前端把回执失败当错误。
    await readJsonBody(req, 1024 * 1024);
    sendJson(res, 200, { success: true });
    return true;
  }
  if (section === 'tools' && parts[2] === 'search-nodes' && method === 'POST') {
    await handleSearchNodes(req, res);
    return true;
  }
  if (section === 'tools' && parts[2] === 'inspect-media') {
    notPorted(res, '画布素材解析（抽帧 / 语音识别）');
    return true;
  }
  notPorted(res, `画布对话接口 ${url.pathname}`);
  return true;
}

/** 助手草稿：面板靠它判断「可以发消息了」，读不到会一直卡在未就绪。 */
async function handleWorkspace(input: AgentChatRouterInput, method: string): Promise<boolean> {
  const { req, res, url, deps } = input;
  const projectId = (url.searchParams.get('projectId') ?? '').trim();
  if (!projectId) {
    sendJson(res, 422, { error: '缺少 projectId。', code: 'MISSING_PROJECT_ID' });
    return true;
  }
  if (method === 'GET') {
    const draft = deps.store.getWorkspace(projectId);
    sendJson(res, 200, { projectId, revision: draft.revision, value: draft.value });
    return true;
  }
  if (method === 'PUT') {
    const body = (await readJsonBody(req, 256 * 1024)) as
      | { revision?: unknown; value?: unknown }
      | null;
    const revision = Number(body?.revision);
    const value = body?.value;
    if (!Number.isSafeInteger(revision) || revision < 0 || !value || typeof value !== 'object') {
      sendJson(res, 422, { error: '助手草稿格式无效。', code: 'INVALID' });
      return true;
    }
    const result = deps.store.putWorkspace(projectId, revision, value as Record<string, unknown>);
    if (!result.ok) {
      sendJson(res, 409, {
        error: '助手草稿已被更新，请刷新后重试。',
        code: 'REVISION_CONFLICT',
        projectId,
        revision: result.revision,
      });
      return true;
    }
    sendJson(res, 200, { projectId, revision: result.revision });
    return true;
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

/**
 * Codex 直连的两个读接口。
 *
 * 上游面板一打开就会问 `/agent/codex/status`：本插件没有 Codex 桥（那条链要本机装并登录
 * Codex CLI/桌面版），所以**明确回「未安装/未登录 + 空模型表」**。这不是糊弄：面板据此
 * 只展示 API 模型、不显示登录引导，也不会有红色错误条（404 会让它显示「Codex 连接失败」）。
 */
function handleCodexStub(res: ServerResponse, parts: string[], method: string): boolean {
  if (method !== 'GET') {
    sendJson(res, 501, { error: 'DSH 版画布没有 Codex 直连通道。', code: 'NOT_PORTED' });
    return true;
  }
  if (parts[2] === 'status') {
    sendJson(res, 200, {
      installed: false,
      connected: false,
      loginPending: false,
      models: [],
      version: '',
    });
    return true;
  }
  if (parts[2] === 'sessions') {
    sendJson(res, 200, []);
    return true;
  }
  sendJson(res, 501, { error: 'DSH 版画布没有 Codex 直连通道。', code: 'NOT_PORTED' });
  return true;
}

/** 模型下拉：`{default, models:[{id,label,vision}]}`（id 形状 `provider/model`）。 */
async function handleModels(res: ServerResponse, deps: AgentChatDeps): Promise<void> {
  if (!deps.chat || !deps.chat.available()) {
    // 宿主没给 sessionController 时如实回 503：面板会显示「读取失败，点击重试」并禁用发送，
    // 比给出一个点了必然失败的模型好。
    sendJson(res, 503, {
      error: 'DSH 会话服务不可用，画布对话无法接入。',
      code: 'CHAT_UNAVAILABLE',
      models: [],
    });
    return;
  }
  const catalog = await deps.chat.models();
  sendJson(res, 200, catalog);
}

/** 对话历史的三个动作：列表 / 读取 / 删除。 */
async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  method: string,
  deps: AgentChatDeps,
): Promise<boolean> {
  if (parts.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, deps.store.listSessions());
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  const id = parts[2] ?? '';
  if (!id) {
    sendJson(res, 422, { error: '缺少对话 id。', code: 'INVALID' });
    return true;
  }
  if (parts.length === 3) {
    if (method === 'GET') {
      const record = deps.store.getSession(id);
      if (!record) {
        sendJson(res, 404, { error: '对话不存在。', code: 'NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, {
        id: record.id,
        topic: record.topic,
        createdAt: new Date(record.createdAt).toISOString(),
        messages: record.messages,
      });
      return true;
    }
    if (method === 'DELETE') {
      const ok = deps.store.deleteSession(id);
      if (!ok) {
        sendJson(res, 404, { error: '对话不存在。', code: 'NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, { success: true, recoverable: false });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  // /chat/sessions/:id/skill | /official-drama | /drama…
  notPorted(res, '画布对话的 SKILL / 导演台扩展');
  return true;
}

/** 节点搜索（面板的「找节点」入口）。 */
async function handleSearchNodes(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req, 2 * 1024 * 1024)) as
    | { query?: unknown; type?: unknown; nodes?: unknown }
    | null;
  const query = typeof body?.query === 'string' ? body.query.trim().toLowerCase() : '';
  const type = typeof body?.type === 'string' ? body.type : '';
  const nodes = Array.isArray(body?.nodes) ? (body!.nodes as ChatNodeInput[]) : [];
  const results = nodes
    .filter((node) => {
      if (!node || typeof node !== 'object') return false;
      if (type && node.type !== type) return false;
      if (!query) return true;
      return [node.title, node.prompt, node.textContent, node.id]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(query));
    })
    .slice(0, 30)
    .map((node) => ({
      id: typeof node.id === 'string' ? node.id : '',
      title: typeof node.title === 'string' && node.title ? node.title : String(node.type ?? '节点'),
      locateUrl: typeof node.id === 'string' ? `locate://${node.id}` : '',
    }))
    .filter((item) => item.id);
  sendJson(res, 200, { results, total: results.length });
}

/** 发一条消息（非流式）：给脚本/测试用，行为与 /chat/stream 的收尾一致。 */
async function handleChatOnce(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentChatDeps,
): Promise<void> {
  const body = await readChatBody(req, deps);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error, code: body.code });
    return;
  }
  if (!deps.chat || !deps.chat.available()) {
    sendJson(res, 503, { error: 'DSH 会话服务不可用。', code: 'CHAT_UNAVAILABLE' });
    return;
  }
  try {
    const result = await deps.chat.runTurn({
      chatId: body.chatId,
      text: body.prompt,
      ...(body.model ? { model: body.model } : {}),
      ...(body.projectId ? { projectId: body.projectId } : {}),
    });
    const record = appendTurnMessages(deps, body, result.text);
    sendJson(res, 200, {
      response: result.text,
      topic: record?.topic ?? '新对话',
      messageCount: record?.messages.length ?? 0,
    });
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    sendJson(res, failure.code === 'CHAT_BUSY' ? 409 : 502, {
      error: failure.message ?? '画布对话失败。',
      code: failure.code ?? 'CHAT_FAILED',
    });
  }
}

interface ParsedChatBody {
  ok: true;
  chatId: string;
  prompt: string;
  model: string | null;
  projectId: string | null;
  raw: string;
}

interface ChatBodyError {
  ok: false;
  status: number;
  error: string;
  code: string;
}

/** 读 /chat/stream 与 /chat 的请求体（含附件转文件）。 */
async function readChatBody(
  req: IncomingMessage,
  deps: AgentChatDeps,
): Promise<ParsedChatBody | ChatBodyError> {
  const body = (await readJsonBody(req, 64 * 1024 * 1024)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 422, error: '请求内容无效。', code: 'INVALID' };
  }
  const rawMessage = typeof body.message === 'string' ? body.message : '';
  const media = Array.isArray(body.media) ? (body.media as ChatMediaInput[]) : [];
  const nodes = Array.isArray(body.nodes) ? (body.nodes as ChatNodeInput[]) : [];
  const chatIdRaw = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const chatId = isUuidLike(chatIdRaw) ? chatIdRaw : randomUUID();
  const prompt = composeChatPrompt(rawMessage, media, nodes, deps);
  return {
    ok: true,
    chatId,
    prompt,
    model: typeof body.model === 'string' && body.model ? body.model : null,
    projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : null,
    raw: rawMessage || (media.length ? '（附件）' : prompt),
  };
}

/** 一个回合结束后落库：用户那条 + 助手那条，并回最新记录。 */
function appendTurnMessages(
  deps: AgentChatDeps,
  parsed: ParsedChatBody,
  answer: string,
): ChatSessionRecord | null {
  const timestamp = new Date().toISOString();
  const messages: ChatStoredMessage[] = [
    { role: 'user', content: parsed.raw, timestamp },
    { role: 'assistant', content: answer, timestamp },
  ];
  return deps.store.appendMessages(parsed.chatId, messages);
}

/**
 * 流式回合（面板实际走这条）。
 *
 * SSE 事件（与 vendor 的 agentClient.parseEventBlock 对齐）：
 *   delta          {token}                              正文增量
 *   canvas_result  {action, ok, operationId?}           画布动作卡片
 *   done           {response, topic, messageCount}      收尾（面板以此为准替换整段正文）
 *   error          {error, code, retryable}             失败
 * 另外每 15s 写一行 SSE 注释当心跳：面板的解析器会忽略空块，但连接不会被中间设备掐掉。
 */
async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentChatDeps,
): Promise<void> {
  const parsed = await readChatBody(req, deps);
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.error, code: parsed.code });
    return;
  }
  if (!deps.chat || !deps.chat.available()) {
    // 在开 SSE 之前就拒掉：让面板拿到一条明确的 JSON 错误（agentClient 对非 2xx 走这条分支），
    // 而不是先收到 200 再收到一个 error 事件。
    sendJson(res, 503, { error: 'DSH 会话服务不可用，画布对话无法接入。', code: 'CHAT_UNAVAILABLE' });
    return;
  }

  openSse(res);
  const controller = new AbortController();
  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) {
      try {
        res.write(': ping\n\n');
      } catch {
        /* 断开时忽略 */
      }
    }
  }, 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    // 面板点「停止」或直接关掉面板 = 客户端断开 → 同时打断 DSH 那边的回合
    controller.abort();
  };
  // 只看 res：`res.writableEnded` 为 true 时是我们自己收的尾（正常结束），不算断开。
  // （不监听 req 的 close —— Node 在请求体读完/响应结束后也会发它，会把回合误判为取消。）
  res.on('close', () => {
    if (!res.writableEnded) close();
  });

  try {
    const result = await deps.chat.runTurn({
      chatId: parsed.chatId,
      text: parsed.prompt,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      onDelta: (token) => writeEvent(res, 'delta', { token }),
      onCanvasResult: (action: CanvasActionNote) =>
        writeEvent(res, 'canvas_result', {
          action: action.action,
          ok: action.ok,
          ...(action.operationId ? { operationId: action.operationId } : {}),
        }),
      signal: controller.signal,
    });
    const record = appendTurnMessages(deps, parsed, result.text);
    if (!closed) {
      writeEvent(res, 'done', {
        response: result.text,
        topic: record?.topic ?? '新对话',
        messageCount: record?.messages.length ?? 0,
      });
    }
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    if (!closed) {
      writeEvent(res, 'error', {
        error: failure.message ?? '画布对话失败。',
        code: failure.code ?? 'CHAT_FAILED',
        retryable: false,
      });
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed) {
      closed = true;
      try {
        res.end();
      } catch {
        /* 已断开 */
      }
    }
  }
}
