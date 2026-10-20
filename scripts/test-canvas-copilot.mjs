/**
 * 画布助手 P1 · 主动副驾回归（v1.59）。
 *
 * 背景：路线图 P1「主动副驾：发现空节点/失败任务时给建议（低打扰、可关）」。
 *
 * 本套件验证：
 *   1. 建议引擎的排序与内容：失败节点 > 缺提示词 > 一致性缺口 > 记忆空白 > 孤立节点 > 长任务，
 *      最多 5 条；没有锚点、有锚点但没接、锚点全接上三种状态各自说对话；
 *   2. `GET /copilot` 把建议 / 记忆 / 一致性 / 长任务一起回给界面；
 *   3. 真画布：有失败节点时左下角出现「副驾 N」胶囊，点开后能看到那条建议；
 *   4. 「不再提示」写进 localStorage 且胶囊立刻消失（可关）；
 *   5. 没有建议时不渲染任何东西（低打扰）。
 *
 * 用法：node scripts/test-canvas-copilot.mjs   （需要先 build）
 */
import { buildCopilotSuggestions, copilotSummary } from './lib/plugin-exports.mjs';
import { mountCanvasApp, createCanvasDom, seedResume, settle, startHost } from './lib/canvas-harness.mjs';
import { rmSync } from 'node:fs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const memoryEmpty = { projectId: 'p', entries: [], anchors: [], updatedAt: '' };

// ---------------------------------------------------------------- 1. 建议引擎

{
  const nodes = [
    { id: 'shot-1', type: 'Image', title: '镜头 1', prompt: '雨夜', status: 'success', parentIds: [] },
    { id: 'shot-2', type: 'Image', title: '镜头 2', prompt: '', status: 'error' },
    { id: 'shot-3', type: 'Image', title: '镜头 3', prompt: '黄昏', status: 'idle' },
  ];
  const suggestions = buildCopilotSuggestions({ nodes, memory: memoryEmpty });
  check(
    '失败节点排第一条（high）',
    suggestions[0]?.id === 'failed-nodes' && suggestions[0]?.level === 'high',
    JSON.stringify(suggestions.map((item) => `${item.level}:${item.id}`)),
  );
  check(
    '缺提示词的节点被点名（medium）',
    suggestions.some((item) => item.id === 'missing-prompt' && item.level === 'medium'),
    JSON.stringify(suggestions.map((item) => item.id)),
  );
  check(
    '多个镜头没有锚点时建议「设个锚点」',
    suggestions.some((item) => item.id === 'no-anchors'),
    JSON.stringify(suggestions.map((item) => item.id)),
  );
  check(
    '没有记忆时建议把画风记下来',
    suggestions.some((item) => item.id === 'memory-empty'),
    JSON.stringify(suggestions.map((item) => item.id)),
  );
  check(
    '每条建议都带「问助手」话术或明确为纯提示',
    suggestions.every((item) => typeof item.detail === 'string' && item.detail.length > 0),
    '',
  );
  check('最多 5 条（低打扰）', suggestions.length <= 5, String(suggestions.length));
  check('摘要给出一句话结论', typeof copilotSummary(suggestions) === 'string' && copilotSummary(suggestions).length > 0, copilotSummary(suggestions));

  const withAnchor = buildCopilotSuggestions({
    nodes: [
      { id: 'anchor', type: 'Image', title: '角色定妆', resultUrl: '/a.png' },
      { id: 'shot-1', type: 'Image', title: '镜头 1', prompt: 'x', parentIds: ['anchor'] },
      { id: 'shot-2', type: 'Image', title: '镜头 2', prompt: 'y', parentIds: [] },
    ],
    memory: { projectId: 'p', entries: [], anchors: [{ nodeId: 'anchor', title: '角色定妆', role: 'character' }], updatedAt: '' },
  });
  check(
    '有锚点但没接全 → 一致性缺口建议',
    withAnchor.some((item) => item.id === 'consistency-gap' && item.level === 'medium'),
    JSON.stringify(withAnchor.map((item) => item.id)),
  );

  const allLocked = buildCopilotSuggestions({
    nodes: [
      { id: 'anchor', type: 'Image', title: '角色定妆', resultUrl: '/a.png' },
      { id: 'shot-1', type: 'Image', title: '镜头 1', prompt: 'x', parentIds: ['anchor'] },
      { id: 'shot-2', type: 'Image', title: '镜头 2', prompt: 'y', parentIds: ['anchor'] },
    ],
    memory: {
      projectId: 'p',
      entries: [{ id: 'm1', kind: 'style', text: '黄昏海边', importance: 2, source: 'agent', createdAt: '', updatedAt: '' }],
      anchors: [{ nodeId: 'anchor', title: '角色定妆', role: 'character' }],
      updatedAt: '',
    },
  });
  check(
    '锚点全接上 + 有记忆 → 不再提一致性/记忆',
    !allLocked.some((item) => item.id === 'consistency-gap' || item.id === 'no-anchors' || item.id === 'memory-empty'),
    JSON.stringify(allLocked.map((item) => item.id)),
  );

  const withJob = buildCopilotSuggestions({
    nodes: [{ id: 'n1', type: 'Image', title: '镜头 1', prompt: 'x' }],
    memory: memoryEmpty,
    openJobs: [{ id: 'job-1', name: '短片 A', state: 'awaiting-approval' }],
  });
  check(
    '有长任务时给出「等确认」的建议',
    withJob.some((item) => item.id === 'job-job-1' && item.detail.includes('确认本批生成与费用')),
    JSON.stringify(withJob.map((item) => item.id)),
  );
}

// ---------------------------------------------------------------- 2. HTTP /copilot

const host = await startHost();
const projectId = 'copilot-proj';
{
  await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '副驾验证',
    nodes: [
      { id: 'bad-node', type: 'Image', x: 0, y: 0, title: '失败镜头', prompt: '雨夜', status: 'error' },
      { id: 'ok-node', type: 'Image', x: 500, y: 0, title: '镜头 2', prompt: '黄昏', status: 'idle' },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  const response = await host.hostApi('GET', `/copilot?projectId=${projectId}`);
  const body = response.json();
  check(
    'GET /copilot 回建议 + 记忆 + 一致性 + 长任务',
    response.status === 200 &&
      Array.isArray(body.suggestions) &&
      body.suggestions.some((item) => item.id === 'failed-nodes') &&
      body.memory &&
      body.consistency &&
      Array.isArray(body.jobs),
    JSON.stringify({ suggestions: body.suggestions?.length, consistency: body.consistency?.summary }).slice(0, 240),
  );
  check('缺少 projectId 时 422', (await host.hostApi('GET', '/copilot')).status === 422, '');

  /**
   * 2026-10-20 真机检查翻车点：`GET /copilot` 走 bridge 去问「活画布」，
   * 画布已经关了/在重载时那一问要等满超时 —— 页面卡住、探针一条都发不出去。
   * 现在的口径：**后台轮询读磁盘文档**（快、确定性），只有 `live=1`（用户真打开面板）才问活画布。
   *
   * 这里先注册一个「只 list 过、不再轮询」的假客户端复现那个现场：
   * 不带 live 必须**立刻**回（说明没碰 bridge），带 live 也必须在超时兜底后回（不能挂死）。
   */
  await host.hostApi('POST', '/agent/external/list', { clientId: 'ghost-client', projectId });
  const startedAt = Date.now();
  const plain = await host.hostApi('GET', `/copilot?projectId=${projectId}`);
  const plainMs = Date.now() - startedAt;
  check(
    '有画布客户端但没在轮询时，GET /copilot 不碰 bridge（<500ms 回磁盘文档）',
    plain.status === 200 && plainMs < 500 && plain.json().nodes === 2,
    `${plainMs}ms nodes=${plain.json().nodes}`,
  );
  const liveStartedAt = Date.now();
  const live = await host.hostApi('GET', `/copilot?projectId=${projectId}&live=1`);
  const liveMs = Date.now() - liveStartedAt;
  check(
    'live=1 问不到活画布时按超时兜底回磁盘文档（不会挂死）',
    live.status === 200 && live.json().nodes === 2 && liveMs < 5_000,
    `${liveMs}ms nodes=${live.json().nodes}`,
  );
}

// ---------------------------------------------------------------- 3. 真画布：胶囊与面板

{
  const { window } = await createCanvasDom({ dispatch: host.dispatch });
  seedResume(window, projectId);
  const { handle } = await mountCanvasApp(window);
  await settle(2200);

  const pill = window.document.querySelector('[data-fisherai-copilot-pill="true"]');
  check(
    '有失败节点 → 左下角出现「副驾 N」胶囊',
    Boolean(pill) && String(pill.textContent).includes('副驾'),
    String(pill?.textContent ?? '(没有胶囊)').slice(0, 80),
  );

  pill?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(200);
  const panel = window.document.querySelector('[data-fisherai-copilot="true"]');
  check('点胶囊打开副驾面板', Boolean(panel), '');
  check(
    '面板里列出的就是失败节点那条建议',
    Boolean(panel) &&
      String(panel.textContent).includes('生成失败') &&
      Boolean(panel.querySelector('[data-fisherai-copilot-suggestion="failed-nodes"]')),
    String(panel?.textContent ?? '').slice(0, 200),
  );

  const dismiss = [...(panel?.querySelectorAll('button') ?? [])].find((button) =>
    String(button.textContent).includes('不再提示'),
  );
  dismiss?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(200);
  check(
    '「不再提示」写进 localStorage（可关）',
    window.localStorage.getItem('aifisher.copilot.enabled') === '0',
    String(window.localStorage.getItem('aifisher.copilot.enabled')),
  );
  check(
    '关掉之后胶囊与面板都消失',
    window.document.querySelector('[data-fisherai-copilot-pill="true"]') === null &&
      window.document.querySelector('[data-fisherai-copilot="true"]') === null,
    '',
  );

  try {
    handle.dispose();
  } catch {
    /* 卸载失败不影响结论 */
  }
}

rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
