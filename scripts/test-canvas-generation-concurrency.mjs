/**
 * 生成并发（v1.90）：一批生成同时跑 1–3 路，而不是一个一个等。
 *
 * 用户 2026-11-05 原话：「生成并发 2–3 路」。
 *
 * 上游的 batch approve 是 `for (const [index, item] of batch.items.entries())` 逐个 await ——
 * 一批 8 张要串 8 次等。v1.90 用整文件覆盖（scripts/patches/aifisher/.../canvasCreationControl.ts）
 * 把提交段换成有界并发池，语义只改「同时跑几条」：
 *   - 同时最多 N 条（N=1–3，默认 2，设置页可改，存 localStorage 同一个键）；
 *   - dependsOn 的条目仍然等上游成功后再跑（请求要按新结果重新准备）；
 *   - 任一条失败立刻停止派发新条目，在飞的跑完为止（不额外花钱），其余标 stopped。
 *
 * 本套件验证：
 *   1. 并发池本体：上限、依赖门控、失败即停、blocked 收尾；
 *   2. 并发数的读写与夹取（两端共用一个 localStorage 键，默认 2、范围 1–3）；
 *   3. 确认卡把「并发 N 路」显示出来；
 *   4. 真画布集成：3 个节点一批、并发 2 → 同时只有 2 个生成请求在飞，失败后第 3 个不再提交。
 *
 * 用法：node scripts/test-canvas-generation-concurrency.mjs   （需要先 build）
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (probe, timeout = 15000, step = 50) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await probe()) return true;
    await sleep(step);
  }
  return false;
};

const KEY = 'dsh-aifisher-canvas.generation-concurrency';
const projectId = 'conc-proj';

const host = await startHost();
const dataDir = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas');
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  join(dataDir, 'cloud-channels.json'),
  JSON.stringify({
    version: 1,
    channels: [
      {
        id: 'conc-channel',
        label: '并发评测通道',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'sk-test-only',
        paths: {},
        timeoutMs: 30_000,
        models: [{ id: 'conc-image-model', kind: 'image', label: '并发图模型' }],
      },
    ],
  }),
  'utf8',
);
await host.hostApi('POST', '/workflows', {
  id: projectId,
  revision: 0,
  title: '并发验证',
  nodes: [],
  groups: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});

const { window } = await createCanvasDom({ dispatch: host.dispatch });
window.localStorage.setItem(KEY, '2');
seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(1600);

const pool = window.__FISHERAI_CANVAS_BATCH_POOL__;

// ---------------------------------------------------------------- 1) 并发数读写
check('画布侧拿到并发池（localStorage 同一个键）', Boolean(pool) && typeof pool.run === 'function');
check('没设置时默认 2', pool?.limit?.() === 2, String(pool?.limit?.()));
window.localStorage.setItem(KEY, '3');
check('写 3 → 读到 3', pool?.limit?.() === 3, String(pool?.limit?.()));
window.localStorage.setItem(KEY, '9');
check('超过上限夹到 3', pool?.limit?.() === 3, String(pool?.limit?.()));
window.localStorage.setItem(KEY, '0');
check('低于下限夹到 1', pool?.limit?.() === 1, String(pool?.limit?.()));
window.localStorage.setItem(KEY, 'abc');
check('脏值回默认 2', pool?.limit?.() === 2, String(pool?.limit?.()));
window.localStorage.setItem(KEY, '2');

// ---------------------------------------------------------------- 2) 并发池本体
{
  let active = 0;
  let peak = 0;
  let finished = 0;
  const started = Date.now();
  await pool.run({
    indexes: [0, 1, 2, 3, 4],
    limit: 3,
    ready: () => 'ready',
    blocked: () => {},
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(40);
      active -= 1;
      finished += 1;
      return true;
    },
  });
  check(
    '并发池：5 条任务、上限 3 → 同时在飞正好 3，且全部跑完',
    peak === 3 && finished === 5 && Date.now() - started < 300,
    `peak=${peak} finished=${finished} ms=${Date.now() - started}`,
  );
}
{
  const order = [];
  let upstreamDone = false;
  await pool.run({
    indexes: [0, 1, 2],
    limit: 3,
    ready: (index) => (index === 0 || upstreamDone ? 'ready' : 'waiting'),
    blocked: () => {},
    run: async (index) => {
      order.push(index);
      if (index === 0) {
        await sleep(40);
        upstreamDone = true;
      }
      return true;
    },
  });
  check(
    '并发池：有依赖的条目等上游成功才开始',
    order.length === 3 && order[0] === 0,
    order.join(','),
  );
}
{
  const blocked = [];
  const ran = [];
  await pool.run({
    indexes: [0, 1, 2, 3],
    limit: 2,
    ready: () => 'ready',
    blocked: (index) => blocked.push(index),
    run: async (index) => {
      ran.push(index);
      if (index === 1) return false;
      await sleep(30);
      return true;
    },
  });
  check(
    '并发池：一条失败立刻停止派发新条目（后两条标 blocked，不提交）',
    !ran.includes(3) && blocked.length >= 1 && blocked.includes(3),
    `ran=${ran.join(',')} blocked=${blocked.join(',')}`,
  );
}

// ---------------------------------------------------------------- 3) 真画布：准备一批 3 个节点
const tool = host.tool('canvas_control');
const sessionId = 'sess-concurrency';
const run = (args) => tool.execute(args, { agent: { session: { id: sessionId } } });

const created = await run({
  action: 'edit',
  operations: [
    { kind: 'create', ref: 'a', type: 'Image', x: 0, y: 0, title: '并发A', prompt: '雨夜街口' },
    { kind: 'create', ref: 'b', type: 'Image', x: 400, y: 0, title: '并发B', prompt: '雾中天台' },
    { kind: 'create', ref: 'c', type: 'Image', x: 800, y: 0, title: '并发C', prompt: '雪后巷子' },
  ],
});
const nodeIds = (created?.result?.created ?? []).map((node) => String(node.id));
check('真画布里建了 3 个 Image 节点', nodeIds.length === 3, nodeIds.join(','));

const read = await run({ action: 'read' });
const prepared = await run({
  action: 'prepareGeneration',
  revision: read?.result?.revision,
  nodeIds,
});
const planId = String(prepared?.result?.generationPlanId ?? '');
check(
  '三个独立节点准备成一批（awaiting-approval）',
  prepared?.ok === true && prepared?.result?.generationState === 'awaiting-approval',
  JSON.stringify(prepared).slice(0, 220),
);

const card = window.document.querySelector('[data-fisherai-generation-batches="true"]');
check(
  '确认卡把并发路数显示出来（并发 2 路）',
  Boolean(card) &&
    card.getAttribute('data-fisherai-generation-concurrency') === '2' &&
    String(card.textContent).includes('并发 2 路'),
  `${card?.getAttribute('data-fisherai-generation-concurrency')} / ${String(card?.textContent ?? '').slice(0, 80)}`,
);

// ---------------------------------------------------------------- 4) 真画布：确认 → 观察并发
const originalFetch = window.fetch.bind(window);
const ResponseCtor = window.Response ?? globalThis.Response;
let inFlight = 0;
let peak = 0;
const starts = [];
window.fetch = (url, init) => {
  const href = String(url);
  if (href.includes('/generate-image') || href.includes('/generate-video') || href.includes('/generate-text')) {
    starts.push({ at: Date.now(), href });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight -= 1;
        resolve(
          new ResponseCtor(
            JSON.stringify({ success: false, error: { message: '并发桩失败' }, code: 'STUB_FAIL' }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          ),
        );
      }, 250);
    });
  }
  return originalFetch(url, init);
};

const approve = card?.querySelector('[data-fisherai-generation-approve]');
approve?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const finished = await waitFor(() => {
  const snapshot = window.__FISHERAI_CANVAS_GENERATION_BATCHES__?.getSnapshot?.() ?? [];
  const batch = snapshot.find((item) => item.id === planId);
  return batch?.state === 'finished';
}, 20000);
check('点确认后这一批跑到 finished', finished, `plan=${planId}`);

const batch = (window.__FISHERAI_CANVAS_GENERATION_BATCHES__?.getSnapshot?.() ?? []).find(
  (item) => item.id === planId,
);
const states = (batch?.items ?? []).map((item) => item.state);
check(
  '同时最多 2 个生成请求在飞（并发 2 路真的生效）',
  peak === 2,
  `peak=${peak} starts=${starts.length}`,
);
check(
  '失败即停：第 3 个节点没有再被提交（总共只发 2 次请求）',
  starts.length === 2,
  `starts=${starts.length}`,
);
check(
  '收尾状态：2 个 failed + 1 个 stopped',
  states.filter((state) => state === 'failed').length === 2 &&
    states.filter((state) => state === 'stopped').length === 1,
  states.join(','),
);

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
