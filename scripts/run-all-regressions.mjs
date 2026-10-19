/**
 * 全量回归：逐套跑，判绿只看 SUMMARY 行（`fail=0` 或 `SUMMARY PASS`）。
 * 用法：node .dsh-tmp/run-all-regressions.mjs
 * 说明：比 E: 的旧版多一套 test-canvas-workflow-library（v1.28 新增），
 *       再加 test-canvas-stack（v1.37：叠图切换）、test-canvas-outpaint（v1.38/v1.39：扩图）
 *       与 test-canvas-last-model（v1.40：新节点默认用上一次的模型），共 27 套。
 *       v1.41 没有新增套件（任务队列的层级护栏并进 test-canvas-task-queue，
 *       会话栏输入区贴底并进 test-canvas-chat-dock）。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const node = process.execPath;
const order = [
  'smoke-contract.mjs',
  'test-canvas-backend.mjs',
  'test-canvas-render.mjs',
  'test-panel-exit.mjs',
  'test-canvas-chat-dock.mjs',
  'test-canvas-agent.mjs',
  'test-canvas-agent-chat.mjs',
  'test-canvas-agent-speed.mjs',
  'test-canvas-placement.mjs',
  'test-canvas-digest.mjs',
  'test-canvas-recipe.mjs',
  'test-canvas-preview.mjs',
  'test-canvas-events.mjs',
  'test-canvas-references.mjs',
  'test-canvas-generation.mjs',
  'test-media-editing.mjs',
  'test-canvas-library.mjs',
  'test-custom-workflows.mjs',
  'test-canvas-workflow-config.mjs',
  'test-canvas-local-workflows.mjs',
  'test-cloud-generation.mjs',
  'test-ark-generation.mjs',
  'test-cloud-channels.mjs',
  'test-canvas-cloud-generation.mjs',
  'test-canvas-ui-services.mjs',
  'test-canvas-grid.mjs',
  'test-canvas-node-search.mjs',
  'test-canvas-stack.mjs',
  'test-canvas-knife.mjs',
  'test-canvas-outpaint.mjs',
  'test-canvas-last-model.mjs',
  'test-project-archive.mjs',
  'test-canvas-data-dir.mjs',
  'test-canvas-task-queue.mjs',
  'test-canvas-workflow-library.mjs',
  'test-canvas-shadcn-ui.mjs',
  'verify-canvas-ui.mjs',
];

const present = new Set(readdirSync('scripts'));
let totalPass = 0;
let bad = 0;
const badNames = [];
for (const name of order) {
  if (!present.has(name)) {
    console.log(`MISSING ${name}`);
    bad += 1;
    continue;
  }
  const result = spawnSync(node, [`scripts/${name}`], {
    encoding: 'utf8',
    timeout: 900000,
  });
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const summaryLine = text
    .split(/\r?\n/)
    .reverse()
    .find((line) => /SUMMARY/.test(line));
  const summary = (summaryLine ?? '').trim();
  const numeric = /pass=(\d+) fail=(\d+)/.exec(summary);
  const custom = /SUMMARY PASS\s+(\d+)\/(\d+)/.exec(summary);
  let pass = 0;
  let fail = -1;
  if (numeric) {
    pass = Number(numeric[1]);
    fail = Number(numeric[2]);
  } else if (custom) {
    pass = Number(custom[1]);
    fail = Number(custom[2]) - Number(custom[1]);
  }
  totalPass += pass;
  const ok = fail === 0;
  if (!ok) {
    bad += 1;
    badNames.push(name);
    console.log(`BAD  ${name.padEnd(34)} ${summary || `(exit ${result.status})`}`);
    const tail = text.trim().split(/\r?\n/).slice(-25).join('\n');
    console.log(tail);
  } else {
    console.log(`OK   ${name.padEnd(34)} ${summary}`);
  }
}
console.log(`\nTOTAL pass=${totalPass} suites=${order.length} bad=${bad}${badNames.length ? ` (${badNames.join(', ')})` : ''}`);
