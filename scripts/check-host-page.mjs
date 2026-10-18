/**
 * 宿主页自检：把 `scripts/browser-check.mjs` 里那段 `HOST_PAGE` 模板**求值**出来，
 * 抽出其中的 `<script type="module">` 再交给 `node --check`。
 *
 * 为什么需要它（真踩过两次）：browser-check 那个宿主页是一整段模板字符串，
 * 页面脚本里的注释/文案只要多一个反引号或 `${`，外层模板就会提前闭合 —— 整页 SyntaxError，
 * 而现象只是「没收到页面探针」（browser-check 报 FAIL，看日志完全看不出原因）。
 * `DUMP_HOST_PAGE=1` 写出的是整份 HTML，`node --check` 吃不了；这里只抽脚本部分。
 *
 * 用法：
 *   node scripts/check-host-page.mjs
 *   node --check .dsh-tmp/host-page-cooked.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = new URL('.', import.meta.url);
const TMP = new URL('../.dsh-tmp/', HERE);
const source = readFileSync(new URL('./browser-check.mjs', HERE), 'utf8');
const lines = source.split('\n');
const start = lines.findIndex((line) => line.includes('const HOST_PAGE = `'));
const end = lines.findIndex((line, index) => index > start && line.trim() === '</html>`;');
if (start < 0 || end < 0) {
  console.error('找不到 HOST_PAGE 的范围', { start, end });
  process.exit(1);
}
const body = lines.slice(start, end + 1).join('\n');
const literal = body.slice(body.indexOf('`'));
// 求值这段模板串（里面的 `${ORIGIN}` 之类只是拼 URL，替换掉即可）
const cooked = Function('return ' + literal.replace(/\$\{[^}]*\}/g, 'X'))();
const script = cooked.split('<script type="module">')[1].split('</script>')[0];
mkdirSync(TMP, { recursive: true });
const out = new URL('./host-page-cooked.mjs', TMP);
writeFileSync(out, script, 'utf8');
let backticks = 0;
for (const [index, line] of lines.entries()) {
  if (index >= start && index <= end && line.includes('`')) backticks += 1;
}
console.log(
  `[check-host-page] HOST_PAGE 行 ${start + 1}..${end + 1}；页面脚本 ${script.length} 字节；` +
    `模板内反引号行数=${backticks}（只允许首尾两行）；写出 ${fileURLToPath(out)}`,
);
