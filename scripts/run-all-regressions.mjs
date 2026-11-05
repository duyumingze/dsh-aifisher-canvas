/**
 * 全量回归：逐套跑，判绿只看 SUMMARY 行（`fail=0` 或 `SUMMARY PASS`）。
 *
 * 用法：
 *   node scripts/run-all-regressions.mjs          # 本机全量（58 套；有 Chrome 的话收口再跑 browser-check）
 *   node scripts/run-all-regressions.mjs --ci     # 只跑 CI 标了 ci:true 的那几套（公开 runner 用）
 *
 * 套件清单只有一份：`scripts/suites.mjs`。以前这里自带一份硬编码顺序、package.json 又一份、
 * CI 再一份，三份漂移之后 v1.88 的 `test-canvas-skin` 谁都没跑（2026-11-04 发现）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SUITES } from './suites.mjs';

const node = process.execPath;
const ciOnly = process.argv.includes('--ci');
const order = SUITES.filter((suite) => (ciOnly ? suite.ci === true : true));

let totalPass = 0;
let bad = 0;
const badNames = [];
for (const suite of order) {
  const file = suite.file;
  const name = file.replace(/^scripts\//, '');
  if (!existsSync(file)) {
    console.log(`MISSING ${name}`);
    bad += 1;
    badNames.push(name);
    continue;
  }
  const result = spawnSync(node, [file], {
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
console.log(
  `\nTOTAL pass=${totalPass} suites=${order.length}${ciOnly ? ' (ci)' : ''} bad=${bad}` +
    `${badNames.length ? ` (${badNames.join(', ')})` : ''}`,
);
process.exitCode = bad === 0 ? 0 : 1;
