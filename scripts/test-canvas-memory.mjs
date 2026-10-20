/**
 * 画布助手 P1 · 项目记忆与视觉一致性回归（v1.59）。
 *
 * 背景（2026-10-20 用户认可的路线图 P1）：
 *   - 「画布助手记忆：项目风格/角色/参数沉淀，跨会话注入」；
 *   - 「视觉一致性：角色参考图锁定，跨镜头锁脸/锁服装」。
 *
 * 本套件验证：
 *   1. `/memory` 增删改查；同 kind+key 是**原地更新**而不是追加重复条目；
 *   2. `/memory/anchors` 只接受**当前项目里真实存在**的节点；幽灵 id 被 422；
 *   3. canvas_control 的 action:"memory"（list/set）；
 *   4. action:"consistency" op:"lock" 真的把锚点连成镜头的上游（读回 parentIds 验证），
 *      覆盖率从 0/N 变成 N/N，op:"unlock" 再断回去；
 *   5. digest 带上记忆/一致性/副驾三个补充段（形状仍是 result.digest.*）；
 *   6. 画布对话下一回合会注入「画布项目记忆」（每份内容只注入一次）。
 *
 * 用法：node scripts/test-canvas-memory.mjs   （需要先 build）
 */
import { mountCanvasApp, createCanvasDom, seedResume, settle, startHost } from './lib/canvas-harness.mjs';
import { rmSync } from 'node:fs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const host = await startHost({ chat: true });
const projectId = 'memory-proj';

// 预置项目：一张「角色定妆」+ 两个镜头
{
  const saved = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '记忆与一致性验证',
    nodes: [
      { id: 'anchor-node', type: 'Image', x: 0, y: 0, title: '角色定妆', status: 'success' },
      { id: 'shot-1', type: 'Image', x: 500, y: 0, title: '镜头 1', status: 'idle' },
      { id: 'shot-2', type: 'Image', x: 900, y: 0, title: '镜头 2', status: 'idle' },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', saved.status === 200, String(saved.status));
}

// ---------------------------------------------------------------- 1. /memory 增删改查

let styleEntryId = '';
{
  const first = await host.hostApi('POST', '/memory', {
    projectId,
    kind: 'style',
    text: '黄昏海边，冷色调',
    key: 'look',
  });
  const entry = first.json().entry;
  styleEntryId = String(entry?.id ?? '');
  check(
    'POST /memory 写入一条画风记忆',
    first.status === 200 && entry?.kind === 'style' && entry?.text === '黄昏海边，冷色调',
    first.text.slice(0, 160),
  );

  const updated = await host.hostApi('POST', '/memory', {
    projectId,
    kind: 'style',
    text: '黄昏海边，冷色调，低饱和',
    key: 'look',
  });
  const next = updated.json().entry;
  const listAfter = (await host.hostApi('GET', `/memory?projectId=${projectId}`)).json();
  check(
    '同 kind+key 原地更新（id 不变、条目不翻倍）',
    next?.id === styleEntryId && listAfter.entries?.length === 1 && next?.text.includes('低饱和'),
    JSON.stringify({ id: next?.id, count: listAfter.entries?.length }),
  );

  const second = await host.hostApi('POST', '/memory', {
    projectId,
    kind: 'character',
    text: '女主：短发、深蓝外套',
  });
  check('没有 key 的记忆追加为新条目', second.status === 200, String(second.status));

  const list = (await host.hostApi('GET', `/memory?projectId=${projectId}`)).json();
  check('GET /memory 回两条记忆', list.entries?.length === 2, String(list.entries?.length));

  const removed = await host.hostApi('DELETE', `/memory/${styleEntryId}?projectId=${projectId}`);
  const afterRemove = (await host.hostApi('GET', `/memory?projectId=${projectId}`)).json();
  check(
    'DELETE /memory/:id 删掉一条',
    removed.status === 200 && afterRemove.entries?.length === 1,
    String(afterRemove.entries?.length),
  );

  const missingProject = await host.hostApi('GET', '/memory');
  check('缺少 projectId 时 422', missingProject.status === 422, String(missingProject.status));
}

// ---------------------------------------------------------------- 2. 锚点只接受真实节点

{
  const ghost = await host.hostApi('PUT', '/memory/anchors', {
    projectId,
    anchors: [{ nodeId: 'ghost-node', title: '不存在' }],
  });
  check('幽灵 nodeId 的锚点被 422 拒绝', ghost.status === 422, String(ghost.status));

  const real = await host.hostApi('PUT', '/memory/anchors', {
    projectId,
    anchors: [{ nodeId: 'anchor-node', title: '角色定妆', role: 'character' }],
  });
  const anchors = real.json().anchors;
  check(
    '真实节点的锚点保存成功',
    real.status === 200 && anchors?.length === 1 && anchors[0]?.nodeId === 'anchor-node',
    JSON.stringify(anchors),
  );
}

// ---------------------------------------------------------------- 3. 画布内：工具动作

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(1500);

const tool = host.tool('canvas_control');
check('canvas_control 工具已注册', Boolean(tool));
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-memory' } } });

{
  const listed = await run({ action: 'memory' });
  check(
    'action:"memory" op:"list" 回记忆与锚点',
    listed.ok === true &&
      listed.result?.entries?.length === 1 &&
      listed.result?.anchors?.length === 1,
    JSON.stringify({ entries: listed.result?.entries?.length, anchors: listed.result?.anchors?.length }),
  );

  const set = await run({
    action: 'memory',
    memory: { op: 'set', kind: 'model', text: '统一用 Fisher GPT-Image-2.5-lowprice', key: 'image-model' },
  });
  check('action:"memory" op:"set" 写入一条模型偏好', set.ok === true && set.result?.entry?.kind === 'model', JSON.stringify(set).slice(0, 200));

  const addAnchor = await run({ action: 'memory', memory: { op: 'anchor-add', role: 'style' }, nodeIds: ['shot-2'] });
  check(
    'action:"memory" op:"anchor-add" 追加锚点（角色 + 画风两个）',
    addAnchor.ok === true && addAnchor.result?.anchors?.length === 2,
    JSON.stringify(addAnchor.result?.anchors?.map((anchor) => anchor.nodeId)),
  );
  await run({ action: 'memory', memory: { op: 'anchor-remove' }, nodeIds: ['shot-2'] });
}

// ---------------------------------------------------------------- 4. 一致性锁定（真连线）

{
  const before = await run({ action: 'consistency' });
  check(
    '一致性 status：2 个镜头、0 个已锁',
    before.ok === true && before.result?.coverage?.shots === 2 && before.result?.coverage?.covered === 0,
    JSON.stringify(before.result?.coverage ?? {}).slice(0, 200),
  );

  const locked = await run({ action: 'consistency', consistency: { op: 'lock' } });
  check(
    '一致性 lock：为 2 个镜头下发 2 条连线',
    locked.ok === true && locked.result?.operations === 2,
    JSON.stringify({ operations: locked.result?.operations, coverage: locked.result?.coverage?.covered }),
  );
  check(
    'lock 之后覆盖率 2/2',
    locked.result?.coverage?.covered === 2 &&
      Array.isArray(locked.result?.coverage?.uncovered) &&
      locked.result.coverage.uncovered.length === 0,
    JSON.stringify(locked.result?.coverage ?? {}).slice(0, 200),
  );

  const read = await run({ action: 'read' });
  const nodes = Array.isArray(read.result?.nodes) ? read.result.nodes : [];
  const shot1 = nodes.find((node) => node.id === 'shot-1');
  const shot2 = nodes.find((node) => node.id === 'shot-2');
  check(
    '读回画布：两个镜头的上游都真的连上了锚点',
    Array.isArray(shot1?.parentIds) &&
      shot1.parentIds.includes('anchor-node') &&
      Array.isArray(shot2?.parentIds) &&
      shot2.parentIds.includes('anchor-node'),
    JSON.stringify({ shot1: shot1?.parentIds, shot2: shot2?.parentIds }),
  );

  const unlocked = await run({ action: 'consistency', consistency: { op: 'unlock' } });
  const afterRead = await run({ action: 'read' });
  const afterNodes = Array.isArray(afterRead.result?.nodes) ? afterRead.result.nodes : [];
  const reopened = afterNodes.find((node) => node.id === 'shot-1');
  check(
    '一致性 unlock 把参考连线断回去',
    unlocked.ok === true && Array.isArray(reopened?.parentIds) && reopened.parentIds.length === 0,
    JSON.stringify(reopened?.parentIds),
  );

  await run({ action: 'consistency', consistency: { op: 'lock' } });
}

// ---------------------------------------------------------------- 5. digest 补充段

{
  const digest = await run({ action: 'read', view: 'digest' });
  const data = digest.result?.digest;
  check(
    'digest 带记忆补充段（条数 + 锚点标题）',
    data?.memory?.entries === 2 && Array.isArray(data?.memory?.anchors) && data.memory.anchors.length === 1,
    JSON.stringify(data?.memory ?? {}).slice(0, 200),
  );
  check(
    'digest 带一致性补充段（shots/covered）',
    data?.consistency?.shots === 2 && data?.consistency?.covered === 2,
    JSON.stringify(data?.consistency ?? {}).slice(0, 200),
  );
  check(
    'digest 带副驾补充段（摘要字符串）',
    typeof data?.copilot?.summary === 'string' && Array.isArray(data?.copilot?.suggestions),
    JSON.stringify(data?.copilot ?? {}).slice(0, 160),
  );
}

// ---------------------------------------------------------------- 6. 会话注入（每份内容只一次）

{
  const chatSessionKey = 'chat-memory';
  const before = host.chat.created.length;
  const turn = await host.hostApi('POST', '/chat/stream', {
    sessionId: chatSessionKey,
    message: '这个项目是什么风格？',
    projectId,
  });
  check('画布对话回合完成', turn.status === 200, String(turn.status));
  await settle(400);
  // 真正的 DSH 会话 id 由 hub.ensureSession 生成（`session-…`），不是面板的 chatId ——
  // 记忆注入按 DSH 会话 id 命中，所以这里必须取 controller.create 收到的那个。
  const dshSessionId = String(host.chat.created[before]?.sessionId ?? '');

  const decision = await host.emit(
    'agent/pre-step',
    { agent: { session: { header: { id: dshSessionId } } } },
    async () => ({
      kind: 'enter',
      messages: [
        {
          id: 'msg-user',
          role: 'user',
          content: [{ type: 'text', text: '继续' }],
          source: { kind: 'user' },
        },
      ],
    }),
  );
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  const memoryNotice = messages.find((message) =>
    String(message?.content?.[0]?.text ?? '').includes('画布项目记忆'),
  );
  check(
    '画布会话下一回合注入项目记忆',
    Boolean(memoryNotice),
    JSON.stringify(messages.map((message) => message?.source?.kind)),
  );
  check(
    '注入正文带上记忆内容与锚点提示',
    String(memoryNotice?.content?.[0]?.text ?? '').includes('深蓝外套') &&
      String(memoryNotice?.content?.[0]?.text ?? '').includes('参考锚点'),
    String(memoryNotice?.content?.[0]?.text ?? '').slice(0, 240),
  );

  const again = await host.emit(
    'agent/pre-step',
    { agent: { session: { header: { id: dshSessionId } } } },
    async () => ({
      kind: 'enter',
      messages: [
        {
          id: 'msg-user-2',
          role: 'user',
          content: [{ type: 'text', text: '再来' }],
          source: { kind: 'user' },
        },
      ],
    }),
  );
  const againMessages = Array.isArray(again?.messages) ? again.messages : [];
  const duplicated = againMessages.filter((message) =>
    String(message?.content?.[0]?.text ?? '').includes('画布项目记忆'),
  );
  check('同一份记忆不会每回合重复注入', duplicated.length === 0, `count=${duplicated.length}`);
}

// ---------------------------------------------------------------- 7. 无运行时错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('记忆/一致性链路全程无运行时错误', errors.length === 0, errors.map((entry) => entry.message).join(' | ') || '(none)');

  const status = (await host.hostApi('GET', '/status')).json();
  check(
    '/status 报出记忆与长任务计数',
    status.memory?.entries >= 1 && status.jobs && typeof status.jobs.created === 'number',
    JSON.stringify({ memory: status.memory?.entries, jobs: status.jobs?.created }),
  );
}

try {
  handle.dispose();
} catch {
  /* 卸载失败不影响结论 */
}
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
