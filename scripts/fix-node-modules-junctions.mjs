/**
 * fix-node-modules-junctions.mjs
 *
 * 背景：这台机器的盘符从 G: 变成了 E:（同一个盘），但 node_modules 里 1995 个
 * junction 保存的是绝对路径 G:\开源项目\dsh-aifisher-canvas\node_modules\...，
 * 于是全部悬空：node 解析不到 tsdown/jsdom，构建与回归都跑不起来。
 *
 * 做法：把 E:\...\node_modules 下所有指向 G:\开源项目\dsh-aifisher-canvas\... 的
 * junction 原地重建为指向 E:\开源项目\dsh-aifisher-canvas\...（目标必须真实存在才改）。
 * 不触碰 .pnpm 里的真实文件，也不碰非 junction 的普通文件/目录。
 *
 * 用法：node .dsh-tmp/fix-node-modules-junctions.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const OLD = 'G:\\开源项目\\dsh-aifisher-canvas';
const NEW = 'E:\\开源项目\\dsh-aifisher-canvas';
const ROOT = path.join(NEW, 'node_modules');
const dry = process.argv.includes('--dry');

let scanned = 0;
let relinked = 0;
let alreadyOk = 0;
let missingTarget = 0;
const failures = [];

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    failures.push(`readdir ${dir}: ${error.code}`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    scanned += 1;
    if (entry.isSymbolicLink()) {
      let target = '';
      try {
        target = fs.readlinkSync(full);
      } catch (error) {
        failures.push(`readlink ${full}: ${error.code}`);
        continue;
      }
      if (!target.startsWith(OLD)) {
        alreadyOk += 1;
        continue;
      }
      const next = NEW + target.slice(OLD.length);
      if (!fs.existsSync(next)) {
        missingTarget += 1;
        failures.push(`target missing ${full} -> ${next}`);
        continue;
      }
      if (dry) {
        relinked += 1;
        continue;
      }
      try {
        fs.unlinkSync(full);
      } catch (error) {
        failures.push(`unlink ${full}: ${error.code}`);
        continue;
      }
      try {
        fs.symlinkSync(next, full, 'junction');
        relinked += 1;
      } catch (error) {
        failures.push(`symlink ${full} -> ${next}: ${error.code}`);
      }
      continue;
    }
    if (entry.isDirectory()) walk(full);
  }
}

walk(ROOT);
console.log(
  `SUMMARY scanned=${scanned} relinked=${relinked} skipped=${alreadyOk} missingTarget=${missingTarget} failures=${failures.length}${dry ? ' (dry-run)' : ''}`,
);
for (const line of failures.slice(0, 20)) console.log(`  ! ${line}`);
