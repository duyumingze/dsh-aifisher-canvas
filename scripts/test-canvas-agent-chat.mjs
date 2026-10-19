/**
 * 画布右侧对话面板的回归测试（host 路由 + 面板 DOM）。
 *
 * 面板（vendor 的 canvasAgentPanel）是上游代码，我们没改它 —— 我们提供的是它要的那套后端契约。
 * 这个脚本因此**按面板真实发出的请求**来验证：
 *
 *   助手草稿   GET/PUT /agent/workspace?projectId=…   （revision 乐观并发，面板靠它判断「可以发消息了」）
 *   模型清单   GET     /chat/models                    （面板的下拉读它；空 = 发送按钮永远禁用）
 *   Codex 桩   GET     /agent/codex/{status,sessions}  （没移植，但必须回「未接入」而不是 404）
 *   流式回合   POST    /chat/stream                    （SSE：delta / canvas_result / done / error）
 *   对话历史   GET/DELETE /chat/sessions[/:id]
 *   节点搜索   POST    /chat/tools/search-nodes
 *
 * 「大脑」是 DSH 会话：这里用 harness 的假 sessionController + assistant-stream 帧 + durable
 * session/event（turn/end、assistant/message）来替身，断言消息真的投递到了会话上
 * （sessionId/cwd/正文）、流式正文真的回到了面板、失败真的回了错、历史真的落盘。
 * v1.13 起：**回合收尾只认 durable turn/end**（一次 attempt 的 end 帧不算），所以多步/失败的
 * 用例都显式发 durable 事件。
 *
 * 用法：node scripts/test-canvas-agent-chat.mjs   （需要先 build）
 */
import {
  mountCanvasApp,
  createCanvasDom,
  seedResume,
  settle,
  startHost,
  ROOT,
} from './lib/canvas-harness.mjs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

void ROOT;
const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

/** 超时用例会把 DSH_AIFISHER_CHAT_TIMEOUT_MS 写进 process.env（harness 故意的，宿主多处惰读环境变量），
 *  后面建的宿主得显式清掉这个键，否则 300ms 的超时会串到不相干的用例上。 */
const NO_CHAT_TIMEOUT = { DSH_AIFISHER_CHAT_TIMEOUT_MS: null };

/** SSE 文本 → {events:[name], data:[parsed]}，与 vendor 的 agentClient.parseEventBlock 同规则。 */function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const name = block
      .split(/\r?\n/)
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!name || !data) continue;
    events.push({ name, data: JSON.parse(data) });
  }
  return events;
}

// ================================================================ 一、宿主给了会话服务
const host = await startHost({ chat: true });

// ---- 模型清单
{
  const models = await host.hostApi('GET', '/chat/models');
  const body = models.json();
  check('模型清单返回 200', models.status === 200, String(models.status));
  check(
    '模型清单来自 DSH 模型目录（provider/model 形状）',
    body.models?.[0]?.id === 'fake-cloud/fake-chat' && body.default === 'fake-cloud/fake-chat',
    JSON.stringify(body).slice(0, 200),
  );
  check(
    '模型清单带 label（面板下拉显示它）',
    body.models?.[0]?.label === '假对话模型',
    JSON.stringify(body.models?.[0]),
  );
}

// ---- 助手草稿（面板的 workspace.ready 全靠它）
{
  const empty = await host.hostApi('GET', '/agent/workspace?projectId=proj-chat');
  const body = empty.json();
  check(
    '助手草稿初读：revision 0 + value.prompt 是字符串',
    empty.status === 200 && body.revision === 0 && typeof body.value?.prompt === 'string',
    JSON.stringify(body).slice(0, 200),
  );
  const first = await host.hostApi('PUT', '/agent/workspace?projectId=proj-chat', {
    revision: 0,
    value: { ...body.value, prompt: '写一段提示词', modelId: 'fake-cloud/fake-chat' },
  });
  check('助手草稿保存成功并 +1', first.status === 200 && first.json().revision === 1, first.text.slice(0, 160));
  const stale = await host.hostApi('PUT', '/agent/workspace?projectId=proj-chat', {
    revision: 0,
    value: { prompt: '过期写入' },
  });
  check(
    '过期 revision 写入 → 409 REVISION_CONFLICT（面板会提示重试）',
    stale.status === 409 && stale.json().code === 'REVISION_CONFLICT',
    stale.text.slice(0, 160),
  );
  const reread = await host.hostApi('GET', '/agent/workspace?projectId=proj-chat');
  check(
    '助手草稿真的落盘了（重新读到刚才写的内容）',
    reread.json().value?.prompt === '写一段提示词' && reread.json().revision === 1,
    JSON.stringify(reread.json()).slice(0, 200),
  );
}

// ---- Codex 桩：必须 200 +「未接入」，不能 404（否则面板常驻一条红色错误）
{
  const status = await host.hostApi('GET', '/agent/codex/status');
  const body = status.json();
  check(
    'Codex 状态桩：200 + installed/connected=false + 空模型表',
    status.status === 200 && body.installed === false && body.connected === false && Array.isArray(body.models) && body.models.length === 0,
    status.text.slice(0, 200),
  );
  const sessions = await host.hostApi('GET', '/agent/codex/sessions?projectId=proj-chat');
  check('Codex 历史桩：200 + 空数组', sessions.status === 200 && Array.isArray(sessions.json()), sessions.text.slice(0, 120));
}

// ---- 批次记录（v1.57 起是真实现，空库回空清单）/ 连续生成授权仍未移植（读空清单，写 501）
{
  const plans = await host.hostApi('GET', '/agent/plans?projectId=proj-chat');
  check(
    '/agent/plans 读接口回 200 + 数组（v1.57 起是批次记录真实现）',
    plans.status === 200 && Array.isArray(plans.json()) && plans.json().length === 0,
    plans.text.slice(0, 120),
  );
  const budgets = await host.hostApi('GET', '/agent/budgets?projectId=proj-chat');
  check(
    '/agent/budgets 读接口回 200 + 空数组（面板不显示「读取失败」）',
    budgets.status === 200 && Array.isArray(budgets.json()) && budgets.json().length === 0,
    budgets.text.slice(0, 120),
  );
  const write = await host.hostApi('POST', '/agent/budgets', { projectId: 'proj-chat' });
  check(
    '连续生成授权的写入仍是 501 NOT_PORTED（不假装成功）',
    write.status === 501 && write.json().code === 'NOT_PORTED',
    write.text.slice(0, 160),
  );
}

// ---- 流式回合
const chatId = 'chat-session-1';
const stream = async (target, body) =>
  target.dispatch('POST', '/api/aifisher/canvas/chat/stream', body);
{
  const response = await stream(host, {
    sessionId: chatId,
    projectId: 'proj-chat',
    message: '帮我在画布上建一个文本节点',
    model: 'fake-cloud/fake-chat',
    canvasControl: true,
  });
  const events = parseSse(response.body);
  check(
    '流式回合返回 200 + text/event-stream',
    response.status === 200 && String(response.headers['content-type']).includes('text/event-stream'),
    `${response.status} ${response.headers['content-type']}`,
  );
  check('流式回合先发 delta（面板用它做打字机）', events.some((event) => event.name === 'delta' && typeof event.data.token === 'string'), events.map((e) => e.name).join(',') || '(none)');
  const done = events.find((event) => event.name === 'done')?.data;
  check(
    '流式回合以 done 收尾，正文完整',
    done?.response === '收到：帮我在画布上建一个文本节点' && typeof done?.messageCount === 'number',
    JSON.stringify(done).slice(0, 200),
  );
  check(
    'delta 拼起来等于 done.response（面板中途与收尾一致）',
    events.filter((event) => event.name === 'delta').map((event) => event.data.token).join('') === done?.response,
    '',
  );
}

// ---- 消息真的投递到了 DSH 会话上
{
  const created = host.chat.created[0];
  check(
    '为这条画布对话建了一个 DSH 会话（session-<uuid>）',
    host.chat.created.length === 1 && /^session-[0-9a-f-]{36}$/.test(String(created?.sessionId)),
    JSON.stringify(host.chat.created),
  );
  check(
    '会话工作目录 = 画布数据目录（同一会话每次必须一致）',
    String(created?.cwd ?? '').includes('dsh-aifisher-canvas'),
    String(created?.cwd ?? ''),
  );
  const prompt = host.chat.prompts[0];
  check(
    '用户消息原样投给了会话（queue 模式）',
    prompt?.sessionId === created?.sessionId && prompt?.mode === 'queue' && prompt?.content?.[0]?.text === '帮我在画布上建一个文本节点',
    JSON.stringify(prompt).slice(0, 240),
  );
  check(
    '面板选的模型被翻译成 selectModel(provider, model)',
    host.chat.selectedModels[0]?.provider === 'fake-cloud' && host.chat.selectedModels[0]?.model === 'fake-chat',
    JSON.stringify(host.chat.selectedModels[0]),
  );
}

// ---- 第二条消息复用同一个 DSH 会话（上下文连续）
{
  await stream(host, { sessionId: chatId, message: '再连一条线', model: 'fake-cloud/fake-chat' });
  check(
    '同一条画布对话复用同一个 DSH 会话（不会每次新建）',
    host.chat.created.length === 1 && host.chat.prompts.length === 2 && host.chat.prompts[1]?.sessionId === host.chat.created[0]?.sessionId,
    `created=${host.chat.created.length} prompts=${host.chat.prompts.length}`,
  );
}

// ---- 会话历史（面板的「对话历史」抽屉）
{
  const list = (await host.hostApi('GET', '/chat/sessions')).json();
  check(
    '对话历史列表：标题取自第一条用户消息、消息计数正确',
    list.length === 1 && list[0].id === chatId && list[0].topic === '帮我在画布上建一个文本节点' && list[0].messageCount === 4,
    JSON.stringify(list).slice(0, 240),
  );
  const one = (await host.hostApi('GET', `/chat/sessions/${chatId}`)).json();
  check(
    '对话内容：user/assistant 成对且正文来自 DSH 流',
    one.messages?.length === 4 && one.messages[0].role === 'user' && one.messages[1].role === 'assistant' && one.messages[1].content === '收到：帮我在画布上建一个文本节点',
    JSON.stringify(one.messages?.slice(0, 2)).slice(0, 240),
  );
}

// ---- 附件 + 引用节点（面板会把图片转 base64、节点摘要一起带上）
{
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFPh5JwAAAAAElFTkSuQmCC';
  await stream(host, {
    sessionId: chatId,
    message: '照着这张图改',
    media: [{ type: 'image', base64: png }],
    nodes: [{ id: 'node-1', type: 'Image', title: '主图', imageModel: 'doubao-seedream-5-0-pro' }],
  });
  const text = host.chat.prompts.at(-1)?.content?.[0]?.text ?? '';
  const attachment = /\[图片附件 1：([^\]]+)\]/.exec(text)?.[1] ?? '';
  check('图片附件被落成 agent 能读的本地文件', attachment.length > 0 && existsSync(attachment), attachment);
  check('引用节点摘要进了正文（含模型名）', text.includes('node-1') && text.includes('doubao-seedream-5-0-pro'), text.slice(0, 200));
}

// ---- search-nodes
{
  const search = await host.hostApi('POST', '/chat/tools/search-nodes', {
    query: '主图',
    nodes: [
      { id: 'n1', type: 'Image', title: '主图' },
      { id: 'n2', type: 'Text', title: '提示词' },
    ],
  });
  const body = search.json();
  check(
    '节点搜索只回命中的那一个',
    search.status === 200 && body.total === 1 && body.results[0].id === 'n1',
    JSON.stringify(body).slice(0, 200),
  );
}

// ---- 停止：客户端断开 = 打断 DSH 回合
{
  const cancelHost = await startHost({ chat: true, chatAutoReply: false });
  const response = await cancelHost.dispatch(
    'POST',
    '/api/aifisher/canvas/chat/stream',
    { sessionId: 'chat-cancel', message: '问一个问题' },
    { abortAfterMs: 80 },
  );
  check(
    '面板点停止（客户端挂断）→ 画布对话会打断 DSH 回合',
    cancelHost.chat.cancelled.length === 1 && cancelHost.chat.cancelled[0] === cancelHost.chat.prompts[0]?.sessionId,
    `cancelled=${JSON.stringify(cancelHost.chat.cancelled)}`,
  );
  check(
    '被打断的回合不会给面板发 done（前端只会看到连接结束，不会把半截当完整答案）',
    !parseSse(response.body).some((event) => event.name === 'done'),
    parseSse(response.body).map((event) => event.name).join(',') || '(none)',
  );
  rmSync(cancelHost.fakeHome, { recursive: true, force: true });
}

// ---- 宿主一直不收尾时不能挂死（超时兜底）
{
  const slowHost = await startHost({
    chat: true,
    chatAutoReply: false,
    env: { DSH_AIFISHER_CHAT_TIMEOUT_MS: '300' },
  });
  const response = await slowHost.dispatch('POST', '/api/aifisher/canvas/chat/stream', {
    sessionId: 'chat-slow',
    message: '你好',
  });
  const events = parseSse(response.body);
  check(
    '回合没有任何 end 帧 → 超时后以 error 收尾（面板不会永久转圈）',
    events.some((event) => event.name === 'error' && String(event.data.error).includes('超时')),
    events.map((event) => `${event.name}:${event.data.error ?? ''}`).join('|') || '(none)',
  );
  rmSync(slowHost.fakeHome, { recursive: true, force: true });
}

// ---- v1.13：收尾看 durable turn/end，不看 attempt 的 end 帧
//   真机踩坑：带工具调用的回合每个 step 各有一个 attempt（各有 start/chunks/end），
//   拿第一个 attempt 的 end 当收尾 → 面板只回一句空话；模型没密钥时更是彻底静默。
{
  const stepHost = await startHost({ chat: true, chatAutoReply: false, env: NO_CHAT_TIMEOUT });
  const pending = stepHost.dispatch('POST', '/api/aifisher/canvas/chat/stream', {
    sessionId: 'chat-steps',
    message: '帮我在画布上建一个文本节点',
    model: 'fake-cloud/fake-chat',
  });
  await settle(120);
  const dshSession = stepHost.chat.prompts[0]?.sessionId;
  const requestId = stepHost.chat.prompts[0]?.requestId;
  await stepHost.emitInboxClaimed(dshSession, requestId, 1);

  // 第 1 步：模型说一句 + 调工具（正文之后紧跟一个 end 帧）
  await stepHost.emitStream(dshSession, { type: 'start', revision: 1 });
  await stepHost.emitStream(dshSession, { type: 'chunk', chunk: { type: 'text-delta', text: '我先看看画布。' } });
  await stepHost.emitStream(dshSession, { type: 'end', revision: 2 });
  await stepHost.emitSessionEvent(dshSession, {
    type: 'assistant/message',
    seq: 5,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先看看画布。' },
          { type: 'tool-call', id: 'call-1', name: 'canvas_control', arguments: '{}' },
        ],
      },
    },
  });
  await settle(80);
  const midStream = (await stepHost.hostApi('GET', '/status')).json();
  check(
    '一次 attempt 的 end 帧不再当回合收尾（工具调用的回合不会被截断）',
    midStream.chat?.activeTurns === 1,
    JSON.stringify(midStream.chat).slice(0, 200),
  );

  // 第 2 步：最终答复 + 回合收尾
  await stepHost.emitStream(dshSession, { type: 'start', revision: 3 });
  await stepHost.emitStream(dshSession, { type: 'chunk', chunk: { type: 'text-delta', text: '节点建好了。' } });
  await stepHost.emitStream(dshSession, { type: 'end', revision: 4 });
  await stepHost.emitSessionEvent(dshSession, {
    type: 'assistant/message',
    seq: 6,
    data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '节点建好了。' }] } },
  });
  await stepHost.emitSessionEvent(dshSession, {
    type: 'turn/end',
    seq: 7,
    data: { turn: 1, reason: { kind: 'completed' } },
  });
  const stepped = await pending;
  const stepEvents = parseSse(stepped.body);
  check(
    '多步回合的 done 用最后一次 assistant/message 的完整正文（不是第 1 步那句）',
    stepEvents.find((event) => event.name === 'done')?.data?.response === '节点建好了。',
    JSON.stringify(stepEvents.find((event) => event.name === 'done')?.data).slice(0, 200),
  );
  check(
    'delta 仍把两步的正文流给面板（打字机不受影响）',
    stepEvents.filter((event) => event.name === 'delta').map((event) => event.data.token).join('') ===
      '我先看看画布。节点建好了。',
    stepEvents.filter((event) => event.name === 'delta').map((event) => event.data.token).join(''),
  );
  check(
    '/status 里能看到 durable 收尾计数（真机排查用）',
    midStream.chat?.durableBound === true,
    JSON.stringify(midStream.chat?.durableBound),
  );
  rmSync(stepHost.fakeHome, { recursive: true, force: true });
}

// ---- v1.13：回合失败必须如实回面板（「点击发送没有回应」的真凶）
{
  const failHost = await startHost({ chat: true, chatAutoReply: false, env: NO_CHAT_TIMEOUT });
  const pending = failHost.dispatch('POST', '/api/aifisher/canvas/chat/stream', {
    sessionId: 'chat-fail',
    message: '你好，介绍一下你自己',
    model: 'deepseek-official/deepseek-flash',
  });
  await settle(120);
  const dshSession = failHost.chat.prompts[0]?.sessionId;
  await failHost.emitInboxClaimed(dshSession, failHost.chat.prompts[0]?.requestId, 1);
  const failure = {
    message: 'llm-deepseek: no API key for provider route "deepseek-official"',
    code: 'MISSING_CREDENTIAL',
  };
  await failHost.emitStream(dshSession, { type: 'start', revision: 1 });
  await failHost.emitStream(dshSession, {
    type: 'chunk',
    chunk: { type: 'finish', reason: { kind: 'error', failure } },
  });
  await failHost.emitStream(dshSession, { type: 'end', revision: 2 });
  await failHost.emitSessionEvent(dshSession, {
    type: 'turn/end',
    seq: 9,
    data: { turn: 1, reason: { kind: 'error', error: failure } },
  });
  const failed = await pending;
  const failEvents = parseSse(failed.body);
  check(
    '回合失败（模型没密钥）如实回给面板：error 事件带 code',
    failEvents.some((event) => event.name === 'error' && event.data.code === 'MISSING_CREDENTIAL'),
    failEvents.map((event) => `${event.name}:${event.data.code ?? ''}`).join(',') || '(none)',
  );
  check(
    '失败文案写清楚「去干什么」（换模型 / 配密钥），不是一句无信息量的请求失败',
    String(failEvents.find((event) => event.name === 'error')?.data?.error ?? '').includes('密钥') &&
      String(failEvents.find((event) => event.name === 'error')?.data?.error ?? '').includes(
        'deepseek-official/deepseek-flash',
      ),
    String(failEvents.find((event) => event.name === 'error')?.data?.error ?? '').slice(0, 200),
  );
  check(
    '失败的回合不发 done（面板不会把空话当回答）',
    !failEvents.some((event) => event.name === 'done'),
    failEvents.map((event) => event.name).join(','),
  );
  const failedRecord = (await failHost.hostApi('GET', '/chat/sessions/chat-fail')).json();
  check(
    '失败的回合不落库成一条空的助手消息（历史里不会出现空气泡）',
    Array.isArray(failedRecord.messages) && failedRecord.messages.length === 0,
    JSON.stringify(failedRecord).slice(0, 200),
  );
  rmSync(failHost.fakeHome, { recursive: true, force: true });
}

// ---- v1.13：历史库里遗留的空助手消息读出来就丢掉（面板不再渲染空气泡）
{
  const seededHome = mkdtempSync(join(tmpdir(), 'dsh-aifisher-seed-'));
  const dataDir = join(seededHome, 'storages', 'dsh-aifisher-canvas');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'agent-chat.json'),
    JSON.stringify({
      version: 1,
      sessions: {
        'chat-legacy': {
          id: 'chat-legacy',
          dshSessionId: 'session-legacy',
          topic: '历史对话',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [
            { role: 'user', content: '你好，介绍一下你自己', timestamp: new Date().toISOString() },
            { role: 'assistant', content: '', timestamp: new Date().toISOString() },
          ],
        },
      },
      workspaces: {},
    }),
    'utf8',
  );
  const seedHost = await startHost({
    chat: true,
    chatAutoReply: false,
    fakeHome: seededHome,
    env: NO_CHAT_TIMEOUT,
  });
  const record = (await seedHost.hostApi('GET', '/chat/sessions/chat-legacy')).json();
  check(
    '读库时丢掉历史遗留的空助手消息（早先静默失败的回合不再显示成空气泡）',
    record.messages?.length === 1 && record.messages[0].role === 'user',
    JSON.stringify(record.messages),
  );
  const list = (await seedHost.hostApi('GET', '/chat/sessions')).json();
  check(
    '会话列表的消息计数也用清理后的条数',
    list[0]?.messageCount === 1,
    JSON.stringify(list).slice(0, 200),
  );
  rmSync(seededHome, { recursive: true, force: true });
}

// ---- v1.13：模型清单的顺序与来源过滤（面板第一项 = 默认选中的那条）
{
  const modelHost = await startHost({
    chat: true,
    chatAutoReply: false,
    env: NO_CHAT_TIMEOUT,
    modelCatalog: {
      default: { provider: 'good-provider', model: 'good-chat' },
      groups: [
        { id: 'dead-provider', name: '没配密钥的来源', models: [{ id: 'dead-chat', name: '同名模型' }] },
        { id: 'good-provider', name: '好来源', models: [{ id: 'good-chat', name: '同名模型' }] },
        { id: 'deepseek-account', name: '账号来源', models: [{ id: 'acct-chat', name: '同名模型' }] },
      ],
    },
    llm: {
      listConfigurableProviders: () => [
        { provider: 'dead-provider', displayName: '没配密钥的来源', settingsNs: 'llm-dead', settingsPath: ['provider'] },
        { provider: 'good-provider', displayName: '好来源', settingsNs: 'llm-good', settingsPath: ['provider'] },
        { provider: 'deepseek-account', displayName: '账号来源', settingsNs: 'llm-account', settingsPath: [] },
      ],
    },
    settings: {
      describe: () => [
        { ns: 'llm-dead', value: { provider: { apiKeyEnv: 'DEAD_API_KEY' } } },
        { ns: 'llm-good', value: { provider: { apiKeyEnv: 'GOOD_API_KEY' } } },
      ],
    },
    credentials: { describe: (ref) => ({ configured: ref === 'GOOD_API_KEY' }) },
  });
  const body = (await modelHost.hostApi('GET', '/chat/models')).json();
  check(
    '证明没配密钥的来源从清单里去掉（面板不会默认选到一个必然失败的模型）',
    !body.models.some((item) => String(item.id).startsWith('dead-provider/')),
    JSON.stringify(body.models).slice(0, 240),
  );
  check(
    '默认模型排第一（面板第一帧取列表第一项，顺序就是默认选中谁）',
    body.models[0]?.id === 'good-provider/good-chat' && body.default === 'good-provider/good-chat',
    JSON.stringify(body).slice(0, 200),
  );
  check(
    '登录即用的账号来源始终保留',
    body.models.some((item) => item.id === 'deepseek-account/acct-chat'),
    JSON.stringify(body.models.map((item) => item.id)),
  );
  check(
    '跨来源同名模型补上来源名（下拉里分得清两条同名模型）',
    body.models[0]?.label === '好来源 · 同名模型',
    JSON.stringify(body.models.map((item) => item.label)),
  );
  rmSync(modelHost.fakeHome, { recursive: true, force: true });

  // Remote 那层 credentials.describe(refs[]) 回的是「按 ref 命名的对象」，两种形状都要认
  const remoteShapeHost = await startHost({
    chat: true,
    chatAutoReply: false,
    env: NO_CHAT_TIMEOUT,
    modelCatalog: {
      default: { provider: 'good-provider', model: 'good-chat' },
      groups: [
        { id: 'dead-provider', name: '没配密钥的来源', models: [{ id: 'dead-chat', name: '模型' }] },
        { id: 'good-provider', name: '好来源', models: [{ id: 'good-chat', name: '模型' }] },
      ],
    },
    llm: {
      listConfigurableProviders: () => [
        { provider: 'dead-provider', settingsNs: 'llm-dead', settingsPath: ['provider'] },
        { provider: 'good-provider', settingsNs: 'llm-good', settingsPath: ['provider'] },
      ],
    },
    settings: {
      describe: () => [
        { ns: 'llm-dead', value: { provider: { apiKeyEnv: 'DEAD_API_KEY' } } },
        { ns: 'llm-good', value: { provider: { apiKeyEnv: 'GOOD_API_KEY' } } },
      ],
    },
    credentials: {
      describe: (ref) => ({ [String(ref)]: { configured: String(ref) === 'GOOD_API_KEY' } }),
    },
  });
  const remoteBody = (await remoteShapeHost.hostApi('GET', '/chat/models')).json();
  check(
    'credentials.describe 回「按 ref 命名的对象」时也认（两种服务形状都兜住）',
    !remoteBody.models.some((item) => String(item.id).startsWith('dead-provider/')) &&
      remoteBody.models.some((item) => item.id === 'good-provider/good-chat'),
    JSON.stringify(remoteBody.models).slice(0, 200),
  );
  rmSync(remoteShapeHost.fakeHome, { recursive: true, force: true });
}

// ---- 上下文提示注入（agent/pre-step 瀑布）
{
  const dshSessionId = host.chat.created[0].sessionId;
  let captured = null;
  const decision = await host.emit(
    'agent/pre-step',
    { agent: { session: { header: { id: dshSessionId } } } },
    async () => {
      captured = {
        kind: 'enter',
        messages: [
          { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '用户这一句' }] },
        ],
      };
      return captured;
    },
  );
  const injected = decision?.messages?.[0];
  check(
    '画布会话的第一回合插入了「画布助手模式」上下文提示（在用户消息之前）',
    decision?.messages?.length === 2 && String(injected?.content?.[0]?.text ?? '').includes('画布助手模式') && decision.messages[1] === captured.messages[0],
    JSON.stringify(decision?.messages?.map((m) => m.content?.[0]?.text?.slice(0, 24))).slice(0, 240),
  );
  check(
    '注入的消息带 source（kind=plugin:…），不是伪装成用户消息',
    String(injected?.source?.kind ?? '').includes('plugin:'),
    JSON.stringify(injected?.source),
  );
  const second = await host.emit(
    'agent/pre-step',
    { agent: { session: { header: { id: dshSessionId } } } },
    async () => ({ kind: 'enter', messages: captured.messages }),
  );
  check('同一个会话不会反复注入（只第一回合一次）', second?.messages?.length === 1, JSON.stringify(second?.messages?.length));
  const other = await host.emit(
    'agent/pre-step',
    { agent: { session: { header: { id: 'session-不是画布的会话' } } } },
    async () => ({ kind: 'enter', messages: captured.messages }),
  );
  check('别人的会话一个字节都不碰', other?.messages?.length === 1, JSON.stringify(other?.messages?.length));
}

// ---- 画布没打开时的失败要可读
{
  const tool = host.tool('canvas_control');
  const result = await tool.execute({ action: 'read' }, { agent: { session: { id: host.chat.created[0].sessionId } } });
  check(
    '画布没打开时 canvas_control 回 NO_OPEN_CANVAS + 提示（画布对话里也能看到原因）',
    result.ok === false && result.code === 'NO_OPEN_CANVAS' && typeof result.hint === 'string',
    JSON.stringify(result).slice(0, 200),
  );
}

// ================================================================ 二、宿主没给会话服务
{
  const bare = await startHost();
  const models = await bare.hostApi('GET', '/chat/models');
  check(
    '没有 sessionController 时说清楚「会话服务不可用」而不是 404',
    models.status === 503 && models.json().code === 'CHAT_UNAVAILABLE',
    bare.hostApi ? models.text.slice(0, 160) : '',
  );
  const stream = await bare.hostApi('POST', '/chat/stream', { sessionId: 'chat-x', message: '你好' });
  check('同一场景下 /chat/stream 回 503 + code', stream.status === 503 && stream.json().code === 'CHAT_UNAVAILABLE', stream.text.slice(0, 160));
  const status = (await bare.hostApi('GET', '/status')).json();
  check('/status 里能看到画布对话段（chat.available=false）', status.chat !== undefined && status.chat.available === false, JSON.stringify(status.chat).slice(0, 200));
  rmSync(bare.fakeHome, { recursive: true, force: true });
}

// ================================================================ 三、面板真的挂在画布上
const domHost = await startHost({ chat: true, chatAutoReply: false, env: NO_CHAT_TIMEOUT });
const { window } = await createCanvasDom({ dispatch: domHost.dispatch, shortPoll: 5 });
const projectId = 'chat-panel-proj';
{
  await domHost.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '对话面板验证项目',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  seedResume(window, projectId);
  const { container, handle } = await mountCanvasApp(window);
  await settle(1500);

  const bridge = window.__FISHERAI_AGENT_MODEL_AVAILABILITY__;
  check('画布装上了 DSH 模型桥（__FISHERAI_AGENT_MODEL_AVAILABILITY__）', Boolean(bridge), typeof bridge);
  const filtered = bridge?.filter([]);
  check(
    '模型桥给的是 DSH 的模型（不是上游那份空的闭源目录）',
    Array.isArray(filtered) && filtered[0]?.id === 'fake-cloud/fake-chat' && filtered[0]?.label === '假对话模型',
    JSON.stringify(filtered).slice(0, 200),
  );

  const launcher = container.querySelector('[data-fisherai-agent-launcher="true"]');
  check('画布右下有助手入口（启动球）', Boolean(launcher), launcher?.className ?? '(none)');
  check(
    '启动球贴在画布面板内、且不压「退出画布」按钮（fixed→absolute + 抬高）',
    Boolean(launcher) && launcher.className.includes('absolute bottom-20 right-6') && !launcher.className.includes('fixed'),
    launcher?.className ?? '(none)',
  );
  check(
    '助手入口在画布容器内部（不是挂在 DSH 页面上）',
    Boolean(launcher?.closest('.af-canvas-mount')),
    '',
  );

  launcher?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(400);
  const panel = container.querySelector('[data-fisherai-agent-panel="true"]');
  check('点击后右侧对话面板出现', Boolean(panel), panel?.className?.slice(0, 120) ?? '(none)');
  check(
    '面板贴的是画布面板右缘（vendor 补丁：fixed→absolute）',
    Boolean(panel) && panel.className.includes('absolute top-0 right-0 h-full') && !panel.className.includes('fixed'),
    panel?.className?.slice(0, 160) ?? '(none)',
  );
  check(
    '面板也画在画布容器内部（不会越出到 DSH 侧边栏上）',
    Boolean(panel?.closest('.af-canvas-mount')),
    '',
  );
  const textarea = container.querySelector('[data-fisherai-agent-panel="true"] textarea');
  check('面板里有输入框（composer）', Boolean(textarea), textarea ? 'ok' : '(none)');

  // 面板的模型下拉读的是我们的桥：说明 —— 界面文案里应出现假模型的名字
  const panelText = panel?.textContent ?? '';
  check(
    '面板显示出 DSH 的模型名（模型下拉不是空的）',
    panelText.includes('假对话模型'),
    panelText.replace(/\s+/g, ' ').slice(0, 160),
  );

  // ---- 画布对话真的能控制画布：面板的回合里调 canvas_control → 画布执行 → 回执回到面板
  const turnPromise = domHost.dispatch('POST', '/api/aifisher/canvas/chat/stream', {
    sessionId: 'chat-panel-1',
    projectId,
    message: '帮我建一个文本节点',
    model: 'fake-cloud/fake-chat',
    canvasControl: true,
  });
  await settle(200);
  const dshSessionId = domHost.chat.prompts.at(-1)?.sessionId;
  const canvasTool = domHost.tool('canvas_control');
  const exec = (args) => canvasTool.execute(args, { agent: { session: { id: dshSessionId } } });
  const read = await exec({ action: 'read' });
  const edit = await exec({
    action: 'edit',
    revision: String(read.result?.revision ?? ''),
    operations: [{ kind: 'create', ref: 'a', type: 'Text', x: 120, y: 120, title: '助手建的' }],
  });
  check(
    '画布对话里的 canvas_control 真的改到了画布（画布在轮询 → 桥接下发 → 执行）',
    read.ok === true && edit.ok === true && edit.result?.ok === true,
    JSON.stringify(edit).slice(0, 240),
  );
  await domHost.emitStream(dshSessionId, { type: 'chunk', chunk: { type: 'text-delta', text: '已经建好了。' } });
  await domHost.emitStream(dshSessionId, { type: 'end', revision: 9 });
  // 一次 attempt 的 end 之后回合仍在跑（v1.13）：等 durable turn/end 才收尾
  await settle(60);
  const midPanel = (await domHost.hostApi('GET', '/status')).json();
  check(
    '面板那条回合也只在 durable turn/end 收尾（attempt end 不再提前结束）',
    midPanel.chat?.activeTurns === 1,
    `${JSON.stringify(midPanel.chat).slice(0, 420)} cancelled=${JSON.stringify(domHost.chat.cancelled)}`,
  );
  await domHost.emitSessionEvent(dshSessionId, {
    type: 'assistant/message',
    seq: 30,
    data: {
      turn: domHost.chat.promptCountBySession.get(dshSessionId),
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '已经建好了。' }] },
    },
  });
  await domHost.emitSessionEvent(dshSessionId, {
    type: 'turn/end',
    seq: 31,
    data: { turn: domHost.chat.promptCountBySession.get(dshSessionId), reason: { kind: 'completed' } },
  });
  const turn = await turnPromise;
  const turnEvents = parseSse(turn.body);
  check(
    '画布动作以 canvas_result 事件回到面板（消息下面那张「画布动作」卡片）',
    turnEvents.some(
      (event) => event.name === 'canvas_result' && event.data.action === 'edit' && event.data.ok === true,
    ),
    turnEvents.map((event) => event.name).join(',') || '(none)',
  );
  check(
    '同一回合既有流式正文也有 done 收尾',
    turnEvents.filter((event) => event.name === 'delta').map((event) => event.data.token).join('') === '已经建好了。' &&
      turnEvents.some((event) => event.name === 'done' && event.data.response === '已经建好了。'),
    JSON.stringify(turnEvents.map((event) => event.name)),
  );

  try {
    handle.dispose();
  } catch {
    /* 卸载失败在渲染测试里单独断言 */
  }
}
rmSync(domHost.fakeHome, { recursive: true, force: true });
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
