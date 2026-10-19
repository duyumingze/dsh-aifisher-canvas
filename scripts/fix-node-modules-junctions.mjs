/**
 * fix-node-modules-junctions.mjs
 *
 * 背景：pnpm 在 Windows 上把 node_modules 里的每个包做成 junction，目标写的是**绝对路径**。
 * 仓库一换盘符 / 换目录（G: ↔ E:、或把整个文件夹搬走），这些 junction 就全部悬空：
 * node 解析不到 tsdown/jsdom/react，`pnpm build` / `pnpm test` 直接 ERR_MODULE_NOT_FOUND。
 *
 * 做法：扫描**当前仓库**的 node_modules，把每个 junction 的目标按「`\node_modules\` 之后的
 * 相对路径」映射到当前仓库根，例如：
 *   E:\旧位置\node_modules\.pnpm\foo\node_modules\bar
 *     → <当前仓库>\node_modules\.pnpm\foo\node_modules\bar
 * 映射后的目标必须真实存在才改。不碰 .pnpm 里的真实文件，也不碰普通文件/目录；
 * 已经在当前仓库内、且目标可用的 junction 原样不动（可反复跑）。
 *
 * 用法：node scripts/fix-node-modules-junctions.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(REPO, 'node_modules');
const DRY = process.argv.includes('--dry');
const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;

let scanned = 0;
let relinked = 0;
let alreadyOk = 0;
let missingTarget = 0;
let external = 0;
const failures = [];

/** 把 junction 目标里的「node_modules 之后那段」接到当前仓库根上。 */
function mapTarget(target) {
  if (!path.isAbsolute(target)) return null;
  // 取**第一个** `\node_modules\`：pnpm 的目标形如
  // `X:\...\node_modules\.pnpm\pkg@1\node_modules\pkg`，外层那个才是仓库级入口。
  const at = target.toLowerCase().indexOf(NODE_MODULES_SEGMENT.toLowerCase());
  if (at < 0) return null;
  return path.join(ROOT, target.slice(at + NODE_MODULES_SEGMENT.length));
}

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
      const next = mapTarget(target);
      if (!next) {
        external += 1;
        continue;
      }
      const insideRepo = target.toLowerCase().startsWith(`${REPO.toLowerCase()}${path.sep}`);
      if (insideRepo && fs.existsSync(target)) {
        alreadyOk += 1;
        continue;
      }
      if (!fs.existsSync(next)) {
        missingTarget += 1;
        failures.push(`target missing ${full} -> ${next}`);
        continue;
      }
      if (DRY) {
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
  `SUMMARY scanned=${scanned} relinked=${relinked} skipped=${alreadyOk} external=${external} ` +
    `missingTarget=${missingTarget} failures=${failures.length}${DRY ? ' (dry-run)' : ''}`,
);
for (const line of failures.slice(0, 20)) console.log(`  ! ${line}`);
