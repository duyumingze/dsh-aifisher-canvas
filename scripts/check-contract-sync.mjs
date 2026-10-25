/**
 * check-contract-sync.mjs —— 「工具表面 / 契约文档 / 逃生舱白名单」三处对账。
 *
 * 为什么需要它：v1.70 之前这三处靠人记（enum 里四个动作只回一句「请改用 command」、
 * 契约从头到尾没写 command），漂移没人拦。这个脚本把「能机器判的」都判掉，
 * 给 CI 和本地提交前用：
 *   1. 工具 enum 里的每个动作，契约文档都得有名字（`action:"x"` 或表格里的 `x`）；
 *   2. 契约里提到的 `action:"x"`，必须在 enum 或逃生舱白名单里（拒绝表除外）；
 *   3. 工具描述有长度预算（≤ 3000 字符）——它注入的是**每一个** DSH 会话；
 *   4. 逃生舱白名单必须放行 media/workflow/product，拒绝表必须含 runGeneration；
 *   5. README 顶部版本号与 package.json 一致。
 *
 * 不需要构建：只读源码与文档，所以能放进公开 CI（构建本身依赖上游源码树）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const lines = [];
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const indexTs = read('src/host/index.ts');
const contract = read('docs/canvas-agent-contract.md');
const mappingTs = read('src/host/canvas/commandMapping.ts');
const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');

// ---------------------------------------------------------------- 1. enum
const actionBlock = indexTs.slice(indexTs.indexOf("action: {"));
const enumMatch = actionBlock.match(/enum:\s*\[([\s\S]*?)\]/);
if (!enumMatch) {
  console.error('找不到 canvas_control 的 action enum');
  process.exit(1);
}
const enumActions = [...enumMatch[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
check('enum 动作数在 20~30 之间', enumActions.length >= 20 && enumActions.length <= 30, String(enumActions.length));
check('enum 含逃生舱占位 action:"command"', enumActions.includes('command'));
for (const legacy of ['runGeneration', 'media', 'workflow', 'product']) {
  check(`enum 不再有一等参数 ${legacy}`, !enumActions.includes(legacy));
}

// ---------------------------------------------------------------- 2. 契约覆盖
// 文档里有三种写法：`action:"x"`、JSON 块里的 `"action": "x"`、以及表格里的 `x`。
const documented = (name) =>
  contract.includes(`action:"${name}"`) ||
  new RegExp(`"action"\\s*:\\s*"${name}"`).test(contract) ||
  contract.includes(`\`${name}\``) ||
  new RegExp(`\\|\\s*\`?${name}\`?\\s*\\|`).test(contract);
const missing = enumActions.filter((name) => name !== 'command' && !documented(name));
check('enum 里每个动作都在契约文档出现', missing.length === 0, missing.join(',') || '(none)');

const mentioned = new Set(
  [...contract.matchAll(/"?action"?\s*:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
);

// ---------------------------------------------------------------- 3. 逃生舱白名单
const allowBlock = mappingTs.match(/AGENT_COMMAND_ACTIONS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
const allowed = new Set(
  allowBlock ? [...allowBlock[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]) : [],
);
const refusedBlock = mappingTs.match(/REFUSED_COMMAND_ACTIONS[^=]*=\s*\{([\s\S]*?)\};/);
const refused = new Set(
  refusedBlock ? [...refusedBlock[1].matchAll(/^\s*([a-zA-Z]+)\s*:/gm)].map((m) => m[1]) : [],
);

check('逃生舱白名单非空', allowed.size > 0, String(allowed.size));
for (const name of ['media', 'workflow', 'product', 'prepareGeneration']) {
  check(`白名单放行 ${name}`, allowed.has(name));
}
for (const name of ['runGeneration', 'prepareBudget', 'revokeBudget']) {
  check(`拒绝表包含 ${name}`, refused.has(name));
  check(`白名单不包含 ${name}`, !allowed.has(name));
}

const unknownMentioned = [...mentioned].filter(
  (name) => !enumActions.includes(name) && !allowed.has(name) && !refused.has(name),
);
check('契约提到的动作都在 enum / 白名单 / 拒绝表里', unknownMentioned.length === 0, unknownMentioned.join(',') || '(none)');

// ---------------------------------------------------------------- 4. 描述预算
const start = indexTs.indexOf('Operate the active AIFISHER');
const end = indexTs.indexOf('docs/canvas-agent-contract.md.', start);
const descStart = start < 0 ? -1 : indexTs.lastIndexOf('description:', start);
if (start < 0 || end < 0 || descStart < 0) {
  check('能在源码里定位工具描述', false);
} else {
  // 末尾多切 8 个字符：最后一段字符串以 `docs/canvas-agent-contract.md.` 开头，
  // 它的收尾引号落在定位点之后，不补就会被截断（实测会少数 348 字符）。
  const literal = indexTs.slice(descStart, end + 'docs/canvas-agent-contract.md.'.length + 8);
  const chars = [...literal.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('').length;
  check('工具描述 ≤ 3000 字符（每会话都要付）', chars > 0 && chars <= 3000, `${chars} 字符`);
}

// ---------------------------------------------------------------- 5. 版本
check(
  'README 版本号与 package.json 一致',
  readme.includes(`**Version**: v${pkg.version.split('.').slice(0, 2).join('.')}`),
  `package ${pkg.version}`,
);

// ---------------------------------------------------------------- 输出
for (const line of lines) console.log(line);
const pass = lines.length - failures;
console.log(`\nSUMMARY pass=${pass} fail=${failures}`);
if (failures > 0) process.exit(1);
