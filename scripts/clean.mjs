/**
 * clean.mjs —— 构建前清空 lib/。
 *
 * 为什么不用 tsdown 的 `clean: true`：三个入口是并行构建的，
 * 其中一个入口的「清目录」会把另一个入口刚写出来的文件删掉（竞态）。
 * 所以统一在构建前清一次，各入口都设 clean: false。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(REPO, 'lib');

if (!target.startsWith(REPO)) {
  console.error(`[clean] 拒绝删除仓库外的路径：${target}`);
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
console.log(`[clean] 已清空 ${path.relative(REPO, target)}/`);
