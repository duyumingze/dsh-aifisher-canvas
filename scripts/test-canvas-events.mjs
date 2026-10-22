/**
 * 生成事件推送回归（v1.57）：journal → 画布对话面板。
 *
 * 背景（2026-10-20「更智能的画布助手」P0 最后一项）：
 *   Agent 用 prepareGeneration 准备一批、用户点确认、生成要过几十秒才结束，而回合早就收尾了 ——
 *   agent 不知道结果，用户也不知道「跑完了没有」，只能再问一句。
 *   v1.57 把「一批跑完」推到发起这批的那个 DSH 会话（= 画布右侧对话面板），
 *   agent 于是可以在同一轮里 preview 自评、修失败、重新准备。
 *
 * 同时修掉一个主链路断点：画布 prepareGeneration 的最后一步要 POST /agent/plans
 * 落库拿 revision，DSH 版一直回 501 → 准备动作恒 UNAVAILABLE。本套件第一条就验证它通了。
 *
 * 本套件验证：
 *   1. `/agent/plans` 的 prepare / list / claim / record / finish（revision 单调递增）；
 *   2. 一批单节点跑完后，**一次**推送进发起会话，正文点名节点、错误码与审批提醒；
 *   3. 多节点批次要**等全部到终点**才推（先到的那个不单独打扰）；
 *   4. 没被 Agent 准备过的节点（用户自己在画布上点生成）不推；
 *   5. 没有 sessionController 时推不出去 → 下一次 pre-step 把事件补进消息列表（不丢）；
 *   6. `/events` 只读回看接口与 `/status.events` 诊断计数。
 *
 * 用法：node scripts/test-canvas-events.mjs   （需要先 build）
 */
import { mountCanvasApp, createCanvasDom, seedResume, startHost, settle } from './lib/canvas-harness.mjs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const projectId = 'events-proj';

/** 造一条「准备批次」请求体（字段照 vendor 的 GenerationBatch）。 */
function planBody(id, sessionId, nodeIds) {
  return {
    id,
    projectId,
    sessionId,
    expiresAt: Date.now() + 10 * 60_000,
    state: 'pending',
    items: nodeIds.map((nodeId) => ({
      nodeId,
      title: `节点 ${nodeId}`,
      model: '不存在的评测模型',
      parameters: '提示词：测试',
      count: 1,
      references: [],
      state: 'pending',
    })),
  };
}

/** 触发一次必然失败的云端生成（模型名在通道表里不存在 → 501 → journal.fail）。 */
async function failGeneration(host, nodeId) {
  return host.hostApi('POST', '/generate-image', {
    nodeId,
    generationAttemptId: `attempt-${nodeId}-${Date.now()}`,
    imageModel: '不存在的评测模型',
    prompt: '雨夜街口，霓虹',
    projectId,
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await settle(40);
  }
  return false;
}

// ================================================================================
// A. 有 sessionController：主动推送
// ================================================================================

const host = await startHost({
  chat: true,
  chatAutoReply: false,
  env: {
    AIFISHER_EVENTS_FLUSH_MS: '30',
    AIFISHER_EVENTS_MIN_GAP_MS: '0',
    AIFISHER_EVENTS_IDLE_FLUSH_MS: '1500',
  },
});

// ---------------------------------------------------------------- 1. 批次记录（主链路断点）

{
  const created = await host.hostApi('POST', '/agent/plans', planBody('plan-x', 'sess-x', ['node-x1']));
  const record = created.json();
  check(
    'POST /agent/plans 通了（不再是 501 NOT_PORTED）',
    created.status === 200 && record.id === 'plan-x' && record.revision === 1,
    `${created.status} ${created.text.slice(0, 160)}`,
  );
  check(
    '批次记录带回 sessionId 与 items（推送绑定要用）',
    record.sessionId === 'sess-x' && record.items?.[0]?.nodeId === 'node-x1',
    JSON.stringify({ sessionId: record.sessionId, items: record.items?.length }),
  );

  const list = (await host.hostApi('GET', `/agent/plans?projectId=${projectId}`)).json();
  check(
    'GET /agent/plans 按 projectId 列出刚准备的批次',
    Array.isArray(list) && list.some((item) => item.id === 'plan-x'),
    JSON.stringify(list.map((item) => item.id)),
  );

  const claimed = (await host.hostApi('POST', '/agent/plans/plan-x/claim', {
    projectId,
    revision: 1,
  })).json();
  check('claim 把批次标成 running 且 revision+1', claimed.state === 'running' && claimed.revision === 2, JSON.stringify(claimed.state));

  const recorded = (await host.hostApi('POST', '/agent/plans/plan-x/record', {
    projectId,
    revision: 2,
    nodeId: 'node-x1',
    state: 'success',
  })).json();
  check('record 更新条目状态且 revision+1', recorded.revision === 3, String(recorded.revision));

  const finished = (await host.hostApi('POST', '/agent/plans/plan-x/finish', {
    projectId,
    revision: 3,
  })).json();
  check('finish 收尾且 revision+1', finished.state === 'finished' && finished.revision === 4, JSON.stringify(finished.state));

  const invalid = await host.hostApi('POST', '/agent/plans', { id: 'bad' });
  check('缺 projectId/items 的批次被 422 拒绝', invalid.status === 422, String(invalid.status));
}

// ---------------------------------------------------------------- 2. 单节点批次：一次推送

const singleSession = 'sess-single';
const singlePlan = planBody('plan-single', singleSession, ['node-single']);
{
  const created = await host.hostApi('POST', '/agent/plans', singlePlan);
  check('准备单节点批次', created.status === 200, created.text.slice(0, 120));

  const before = host.chat.prompts.filter((item) => item.sessionId === singleSession).length;
  await failGeneration(host, 'node-single');

  const delivered = await waitFor(
    () => host.chat.prompts.filter((item) => item.sessionId === singleSession).length === before + 1,
  );
  const prompts = host.chat.prompts.filter((item) => item.sessionId === singleSession);
  const text = String(prompts[prompts.length - 1]?.content?.[0]?.text ?? '');
  check('一批跑完 → 往发起会话推了一条消息', delivered && prompts.length === before + 1, `prompts=${prompts.length}`);
  check(
    '推送正文点名节点与失败码',
    text.includes('【画布生成事件') && text.includes('node-single') && text.includes('CLOUD_NOT_CONFIGURED'),
    text.slice(0, 240),
  );
  check(
    '推送正文带审批红线提醒（重新准备可以，确认仍归用户）',
    text.includes('确认本批生成与费用'),
    text.slice(-160),
  );
  check('推送走 queue 模式（不抢正在进行的回合）', prompts[prompts.length - 1]?.mode === 'queue', String(prompts[prompts.length - 1]?.mode));

  const events = (await host.hostApi('GET', '/events?since=0&limit=50')).json();
  const failed = (events.events ?? []).find(
    (event) => event.nodeId === 'node-single' && event.type === 'failed',
  );
  check(
    '/events 能回看到这条 failed 事件（带批次 id 与错误码）',
    failed?.batchId === 'plan-single' && failed?.code === 'CLOUD_NOT_CONFIGURED',
    JSON.stringify(failed ?? null).slice(0, 200),
  );
  // 批次收口后同一个节点不会再补推：等两个合并窗口，计数必须不变
  const settledCount = host.chat.prompts.filter((item) => item.sessionId === singleSession).length;
  await settle(400);
  check(
    '批次收口后不会重复推（同一条事件只打扰一次）',
    host.chat.prompts.filter((item) => item.sessionId === singleSession).length === settledCount,
    `prompts=${host.chat.prompts.filter((item) => item.sessionId === singleSession).length}`,
  );
}

// ---------------------------------------------------------------- 3. 多节点批次：等全部到终点

const batchSession = 'sess-batch';
{
  await host.hostApi(
    'POST',
    '/agent/plans',
    planBody('plan-batch', batchSession, ['node-b1', 'node-b2']),
  );
  const before = host.chat.prompts.filter((item) => item.sessionId === batchSession).length;

  await failGeneration(host, 'node-b1');
  await settle(300);
  const mid = host.chat.prompts.filter((item) => item.sessionId === batchSession).length;
  check('批次里只结束一个节点时不单独推送', mid === before, `prompts=${mid}`);

  await failGeneration(host, 'node-b2');
  const delivered = await waitFor(
    () => host.chat.prompts.filter((item) => item.sessionId === batchSession).length === before + 1,
  );
  const prompts = host.chat.prompts.filter((item) => item.sessionId === batchSession);
  const text = String(prompts[prompts.length - 1]?.content?.[0]?.text ?? '');
  check('两个节点都结束后只推一条（合并成组）', delivered && prompts.length === before + 1, `prompts=${prompts.length}`);
  check(
    '合并后的正文同时点名两个节点',
    text.includes('node-b1') && text.includes('node-b2') && text.includes('共 2 个节点'),
    text.slice(0, 260),
  );
}

// ---------------------------------------------------------------- 4. 未被 Agent 准备的节点不推

{
  const strangerSession = 'sess-stranger';
  const before = host.chat.prompts.filter((item) => item.sessionId === strangerSession).length;
  await failGeneration(host, 'node-free');
  await settle(400);
  const after = host.chat.prompts.filter((item) => item.sessionId === strangerSession).length;
  check('用户自己在画布上生成的节点不会往任何会话推', before === after && after === 0, `prompts=${after}`);

  const events = (await host.hostApi('GET', '/events?since=0&limit=80')).json();
  const free = (events.events ?? []).find((event) => event.nodeId === 'node-free' && event.type === 'failed');
  check('未绑定节点仍然进 /events（只是不推送）', Boolean(free) && free.batchId === undefined, JSON.stringify(free ?? null).slice(0, 160));
}

// ---------------------------------------------------------------- 5. 诊断

{
  const status = (await host.hostApi('GET', '/status')).json();
  check(
    '/status 里有 events 与 plans 计数',
    status.events?.seq >= 1 &&
      (status.events?.journalEvents ?? 0) >= 1 &&
      (status.plans?.prepared ?? 0) >= 2,
    JSON.stringify({ events: status.events?.seq, plans: status.plans?.prepared }).slice(0, 200),
  );
  const recent = (await host.hostApi('GET', '/events?recent=5')).json();
  check('/events?recent= 回最近事件（新的在前）', Array.isArray(recent.events) && recent.events.length > 0, String(recent.events?.length));
}

// ---------------------------------------------------------------- 6. 真画布：prepareGeneration → 推送
// 这一段是 v1.57 的核心证据链：以前 prepareGeneration 恒 UNAVAILABLE（/agent/plans 回 501），
// 现在能走到 awaiting-approval，并且推送目标是真正发起调用的那个会话。cli 之外的每一步都走真路由。

{
  const canvasProject = 'events-canvas';
  const dataDir = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'cloud-channels.json'),
    JSON.stringify({
      version: 1,
      channels: [
        {
          id: 'events-channel',
          label: '评测通道',
          baseUrl: 'https://example.invalid/v1',
          apiKey: 'sk-test-only',
          paths: {},
          timeoutMs: 30_000,
          models: [{ id: 'events-image-model', kind: 'image', label: '评测图模型' }],
        },
      ],
    }),
    'utf8',
  );
  await host.hostApi('POST', '/workflows', {
    id: canvasProject,
    revision: 0,
    title: '事件推送验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });

  const { window } = await createCanvasDom({ dispatch: host.dispatch });
  seedResume(window, canvasProject);
  const { handle } = await mountCanvasApp(window);
  await settle(1600);

  const tool = host.tool('canvas_control');
  const sessionId = 'sess-canvas';
  const run = (args) => tool.execute(args, { agent: { session: { id: sessionId } } });

  const created = await run({
    action: 'edit',
    operations: [{ kind: 'create', ref: 'a', type: 'Image', x: 0, y: 0, title: '镜头A', prompt: '雨夜街口' }],
  });
  const nodeId = String(created?.result?.created?.[0]?.id ?? '');
  check('真画布里建了一个 Image 节点', Boolean(nodeId), JSON.stringify(created).slice(0, 200));

  const read = await run({ action: 'read' });
  const revision = read?.result?.revision;
  const prepared = await run({ action: 'prepareGeneration', revision, nodeIds: [nodeId] });
  check(
    'prepareGeneration 走到 awaiting-approval（v1.57 之前恒 UNAVAILABLE）',
    prepared.ok === true && prepared.result?.generationState === 'awaiting-approval',
    JSON.stringify(prepared).slice(0, 260),
  );
  check(
    '审批仍只在画布 UI：返回里只有计划 id，没有 approve 入口',
    typeof prepared.result?.generationPlanId === 'string' && prepared.result?.approved === undefined,
    JSON.stringify({ plan: prepared.result?.generationPlanId, approved: prepared.result?.approved }),
  );

  const plans = (await host.hostApi('GET', `/agent/plans?projectId=${canvasProject}`)).json();
  const plan = plans.find((item) => item.id === prepared.result?.generationPlanId);
  check(
    '批次记录落在发起会话上（推送目标）',
    plan?.sessionId === sessionId && plan?.items?.[0]?.nodeId === nodeId,
    JSON.stringify({ sessionId: plan?.sessionId, items: plan?.items?.length }),
  );

  const before = host.chat.prompts.filter((item) => item.sessionId === sessionId).length;

  // ---- v1.58：确认入口必须真的在页面上（真机曾断在这一步：面板被压掉，没有地方能点确认）
  const card = window.document.querySelector('[data-fisherai-generation-batches="true"]');
  check(
    '画布右下角出现「生成批次」确认卡（DSH 里唯一的确认入口）',
    Boolean(card) && String(card.textContent).includes('确认本批生成与费用'),
    String(card?.textContent ?? '(没有卡片)').slice(0, 160),
  );
  check(
    '确认卡列出的就是要生成的那个节点',
    Boolean(card) && String(card.textContent).includes('镜头A'),
    String(card?.textContent ?? '').slice(0, 160),
  );
  const planId = String(prepared.result?.generationPlanId ?? '');
  const approveButton = card?.querySelector('[data-fisherai-generation-approve]');
  check(
    '确认按钮绑在这批上（data-fisherai-generation-approve=批次 id）',
    Boolean(approveButton) && approveButton.getAttribute('data-fisherai-generation-approve') === planId,
    String(approveButton?.getAttribute('data-fisherai-generation-approve')),
  );

  // 真点一次「确认本批生成与费用」：批次必须真的被 claim（= 提交了生成），而不是只画个样子。
  // 注意：终点状态可能是 running（生成还在跑）或 finished（这个用例没有可用生成来源，
  // 提交后立刻失败收尾）。判「真的提交了」看 state 离开 pending 即可 —— 只等 running
  // 会在生成秒失败的环境里永远等不到（2026-10-22 复现 33/34）。
  approveButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const claimed = await waitFor(async () => {
    const list = (await host.hostApi('GET', `/agent/plans?projectId=${canvasProject}`)).json();
    const state = list.find((item) => item.id === planId)?.state;
    return state === 'running' || state === 'finished';
  }, 8000);
  check('点确认 → 批次被 claim（离开 pending）', claimed, `plan=${planId}`);

  const delivered = await waitFor(
    () => host.chat.prompts.filter((item) => item.sessionId === sessionId).length === before + 1,
    20000,
  );
  const prompts = host.chat.prompts.filter((item) => item.sessionId === sessionId);
  const text = String(prompts[prompts.length - 1]?.content?.[0]?.text ?? '');
  check('真画布准备的节点跑完 → 推回同一个会话', delivered, `prompts=${prompts.length}`);
  check(
    '推送正文点名真节点 id',
    text.includes(nodeId) && text.includes('【画布生成事件'),
    text.slice(0, 200),
  );

  try {
    handle.dispose();
  } catch {
    /* 卸载失败不影响结论 */
  }
}

rmSync(host.fakeHome, { recursive: true, force: true });

// ================================================================================
// B. 没有 sessionController：pre-step 兜底注入
// ================================================================================

const hostNoChat = await startHost({
  chatAutoReply: false,
  env: {
    AIFISHER_EVENTS_FLUSH_MS: '30',
    AIFISHER_EVENTS_IDLE_FLUSH_MS: '1500',
  },
});
{
  const sessionId = 'sess-pre';
  await hostNoChat.hostApi('POST', '/agent/plans', planBody('plan-pre', sessionId, ['node-pre']));
  await failGeneration(hostNoChat, 'node-pre');
  await settle(300);

  const decision = await hostNoChat.emit(
    'agent/pre-step',
    { agent: { session: { header: { id: sessionId } } } },
    async () => ({
      kind: 'enter',
      messages: [
        {
          id: 'msg-user',
          role: 'user',
          content: [{ type: 'text', text: '这批生成怎么样？' }],
          source: { kind: 'user' },
        },
      ],
    }),
  );
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  const notice = messages.find((message) =>
    String(message?.content?.[0]?.text ?? '').includes('画布生成事件'),
  );
  check(
    '推不出去时，会话下一次开始时把事件补进消息列表',
    Boolean(notice) && messages.length === 2,
    JSON.stringify(messages.map((message) => message?.source?.kind)),
  );
  check(
    '兜底注入的正文同样点名节点与失败码',
    String(notice?.content?.[0]?.text ?? '').includes('node-pre') &&
      String(notice?.content?.[0]?.text ?? '').includes('CLOUD_NOT_CONFIGURED'),
    String(notice?.content?.[0]?.text ?? '').slice(0, 200),
  );

  const second = await hostNoChat.emit(
    'agent/pre-step',
    { agent: { session: { header: { id: sessionId } } } },
    async () => ({
      kind: 'enter',
      messages: [
        {
          id: 'msg-user-2',
          role: 'user',
          content: [{ type: 'text', text: '继续' }],
          source: { kind: 'user' },
        },
      ],
    }),
  );
  const secondMessages = Array.isArray(second?.messages) ? second.messages : [];
  check(
    '兜底注入只发生一次（不会每回合重复塞）',
    secondMessages.length === 1,
    JSON.stringify(secondMessages.map((message) => message?.source?.kind)),
  );
}

rmSync(hostNoChat.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
