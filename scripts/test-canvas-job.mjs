/**
 * 画布助手 P1 · 后台长任务编排回归（v1.59）。
 *
 * 背景（路线图 P1）：「一次对话提交『做完整短片』，plan 执行、失败重试、审批点不变」。
 *
 * 本套件验证（真画布 + 真路由，除生成端点故意指向不可达地址）：
 *   1. `action:"job"` 一次调用：建镜头节点 → 准备批次 → **立刻**返回快照（不等生成）；
 *   2. 画布右下角出现确认卡（审批仍然只在 UI）；job 状态停在 awaiting-approval；
 *   3. 点确认 → 生成失败 → 任务自动**再准备一批重试**（不自动提交、不花钱），
 *      确认卡再出现，job.retry.attempts=1；
 *   4. 重试批次再失败且次数用尽 → 任务 completed（带失败统计）并把结论推回会话；
 *   5. `op:"status"/"list"/"cancel"` 正常；取消后不再继续等；
 *   6. `prepare:false` 只建节点，不准备生成。
 *
 * 用法：node scripts/test-canvas-job.mjs   （需要先 build）
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

async function waitFor(predicate, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await settle(60);
  }
  return false;
}

const host = await startHost({
  chat: true,
  chatAutoReply: false,
  env: {
    AIFISHER_EVENTS_FLUSH_MS: '30',
    AIFISHER_EVENTS_MIN_GAP_MS: '0',
    AIFISHER_EVENTS_IDLE_FLUSH_MS: '600',
  },
});
const projectId = 'job-proj';

// 一个「必然失败」的云端通道：baseUrl 指向本机 1 端口（连接被拒）
{
  const dataDir = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'cloud-channels.json'),
    JSON.stringify({
      version: 1,
      channels: [
        {
          id: 'job-channel',
          label: '评测通道',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'sk-test-only',
          paths: {},
          timeoutMs: 5_000,
          models: [{ id: 'job-image-model', kind: 'image', label: '评测图模型' }],
        },
      ],
    }),
    'utf8',
  );
  await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '长任务验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(1600);

const tool = host.tool('canvas_control');
const sessionId = 'sess-job';
const run = (args) => tool.execute(args, { agent: { session: { id: sessionId } } });

// ---------------------------------------------------------------- 1. 提交长任务

let jobId = '';
{
  const created = await run({
    action: 'job',
    job: {
      op: 'create',
      name: '雨夜短片',
      shots: [
        { title: '镜头 1', prompt: '雨夜街口，霓虹反光，广角' },
        { title: '镜头 2', prompt: '同一街口，特写，雨滴落在伞面' },
      ],
      retry: { enabled: true, maxAttempts: 1 },
    },
  });
  jobId = String(created.result?.job?.id ?? '');
  check(
    'action:"job" 一次调用就返回任务快照',
    created.ok === true && Boolean(jobId),
    JSON.stringify(created).slice(0, 220),
  );
  check(
    '任务里有固定流水线的步骤（read/shots/lock/prepare/await/retry/report）',
    Array.isArray(created.result?.job?.steps) &&
      ['read', 'shots', 'lock', 'prepare', 'await', 'retry', 'report'].every((id) =>
        created.result.job.steps.some((step) => step.id === id),
      ),
    JSON.stringify(created.result?.job?.steps?.map((step) => step.id)),
  );
}

// ---------------------------------------------------------------- 2. 建节点 + 准备批次 + 等确认

{
  const arrived = await waitFor(async () => {
    const status = await run({ action: 'job', job: { op: 'status', id: jobId } });
    return status.result?.job?.state === 'awaiting-approval';
  }, 10000);
  check('任务走到 awaiting-approval（等用户确认）', arrived, '');

  const status = await run({ action: 'job', job: { op: 'status', id: jobId } });
  const job = status.result?.job;
  check(
    '镜头节点已建好并记录了 id',
    job?.shotNodeIds?.length === 2,
    JSON.stringify(job?.shotNodeIds),
  );
  check(
    '没有锚点时 lock 步骤如实跳过',
    job?.steps?.find((step) => step.id === 'lock')?.state === 'skipped',
    JSON.stringify(job?.steps?.find((step) => step.id === 'lock')),
  );
  check(
    'prepare 步骤拿到批次 id',
    job?.steps?.find((step) => step.id === 'prepare')?.state === 'done' && job?.planIds?.length === 1,
    JSON.stringify(job?.planIds),
  );

  const card = window.document.querySelector('[data-fisherai-generation-batches="true"]');
  check(
    '确认卡出现在画布右下角（审批只在 UI）',
    Boolean(card) && String(card.textContent).includes('确认本批生成与费用'),
    String(card?.textContent ?? '').slice(0, 160),
  );

  const read = await run({ action: 'read' });
  const nodes = Array.isArray(read.result?.nodes) ? read.result.nodes : [];
  check('画布上真的多了两个镜头节点', nodes.filter((node) => node.type === 'Image').length === 2, String(nodes.length));
}

// ---------------------------------------------------------------- 3. 确认 → 失败 → 自动准备重试

{
  const before = (await host.hostApi('GET', `/jobs?projectId=${projectId}`)).json();
  check('/jobs 路由列得出这个任务', before.jobs?.some((job) => job.id === jobId), JSON.stringify(before.jobs?.map((job) => job.id)));

  const approve = window.document.querySelector('[data-fisherai-generation-approve]');
  approve?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const retried = await waitFor(async () => {
    const status = await run({ action: 'job', job: { op: 'status', id: jobId } });
    const job = status.result?.job;
    return job?.retry?.attempts === 1 && job?.state === 'awaiting-approval' && job?.planIds?.length === 2;
  }, 20000);
  const status = await run({ action: 'job', job: { op: 'status', id: jobId } });
  const job = status.result?.job;
  check('第一批失败后任务自动准备了重试批次（仍是 awaiting-approval）', retried, JSON.stringify({ state: job?.state, attempts: job?.retry?.attempts, plans: job?.planIds?.length }));
  check(
    'await 步骤记下了这一轮的成败',
    /成功.*失败/.test(String(job?.steps?.find((step) => step.id === 'await')?.detail ?? '')),
    String(job?.steps?.find((step) => step.id === 'await')?.detail ?? ''),
  );
  check(
    'retry 步骤说明重试批次在等确认',
    job?.steps?.find((step) => step.id === 'retry')?.state === 'waiting',
    JSON.stringify(job?.steps?.find((step) => step.id === 'retry')),
  );

  const card = window.document.querySelector('[data-fisherai-generation-batches="true"]');
  check(
    '重试批次也回到确认卡（没有自动提交花钱）',
    Boolean(card) && String(card.textContent).includes('确认本批生成与费用'),
    String(card?.textContent ?? '').slice(0, 120),
  );
}

// ---------------------------------------------------------------- 4. 重试也失败 → 收口 + 推回会话

{
  const approve = window.document.querySelector('[data-fisherai-generation-approve]');
  approve?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const finished = await waitFor(async () => {
    const status = await run({ action: 'job', job: { op: 'status', id: jobId } });
    return status.result?.job?.state === 'completed';
  }, 20000);
  const status = await run({ action: 'job', job: { op: 'status', id: jobId } });
  const job = status.result?.job;
  check('重试用尽 → 任务收口为 completed（带失败统计）', finished, JSON.stringify({ state: job?.state, summary: job?.summary }));
  check(
    '收口摘要说清「成功 / 仍失败 / 重试几次」',
    /\/2 成功/.test(String(job?.summary ?? '')) &&
      String(job?.summary ?? '').includes('仍失败') &&
      String(job?.summary ?? '').includes('已重试 1 次'),
    String(job?.summary ?? ''),
  );

  const delivered = await waitFor(
    () => host.chat.prompts.some((item) => String(item.content?.[0]?.text ?? '').includes('画布长任务')),
    6000,
  );
  const texts = host.chat.prompts.map((item) => String(item.content?.[0]?.text ?? '')).join('\n');
  check('任务结论推回发起会话（不是用户发言）', delivered && texts.includes('画布长任务'), texts.slice(-200));
}

// ---------------------------------------------------------------- 5. 只建节点 / 取消

{
  const created = await run({
    action: 'job',
    job: {
      op: 'create',
      name: '只摆镜头',
      shots: [{ title: '镜头 1', prompt: 'a' }, { title: '镜头 2', prompt: 'b' }],
      prepare: false,
    },
  });
  const id = String(created.result?.job?.id ?? '');
  const completed = await waitFor(async () => {
    const status = await run({ action: 'job', job: { op: 'status', id } });
    return ['completed', 'failed'].includes(String(status.result?.job?.state ?? ''));
  }, 8000);
  const status = await run({ action: 'job', job: { op: 'status', id } });
  check(
    'prepare:false 只建节点、不准备生成',
    completed &&
      status.result?.job?.state === 'completed' &&
      status.result?.job?.steps?.find((step) => step.id === 'prepare')?.state === 'skipped',
    JSON.stringify({ state: status.result?.job?.state, prepare: status.result?.job?.steps?.find((step) => step.id === 'prepare')?.state }),
  );

  const second = await run({
    action: 'job',
    job: { op: 'create', name: '要被取消的', shots: [{ title: '镜头 1', prompt: 'c' }] },
  });
  const cancelId = String(second.result?.job?.id ?? '');
  const cancelled = await run({ action: 'job', job: { op: 'cancel', id: cancelId } });
  check(
    'op:"cancel" 立即把任务标成 cancelled',
    cancelled.ok === true && cancelled.result?.job?.state === 'cancelled',
    JSON.stringify({ state: cancelled.result?.job?.state }),
  );
  const listed = await run({ action: 'job', job: { op: 'list' } });
  check('op:"list" 能看到全部任务', Array.isArray(listed.result?.jobs) && listed.result.jobs.length >= 3, String(listed.result?.jobs?.length));
}

// ---------------------------------------------------------------- 6. 诊断

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('长任务链路全程无运行时错误', errors.length === 0, errors.map((entry) => entry.message).join(' | ') || '(none)');

  const status = (await host.hostApi('GET', '/status')).json();
  check(
    '/status 报出长任务计数（created/completed/retried）',
    status.jobs?.created >= 3 && status.jobs?.retried >= 1,
    JSON.stringify(status.jobs),
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
