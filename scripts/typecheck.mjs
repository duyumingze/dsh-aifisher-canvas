/**
 * 类型门禁（`pnpm typecheck`）：只对 **本仓库 src/** 报错。
 *
 * 为什么不直接 `tsc -p`：tsconfig 的 `include` 只有 src，但 src 会 import
 * `vendor/aifisher`（模型清单、画布协议、shadcn 的上游配置…），于是 vendor 会被
 * 拉进 program。vendor 是上游源码树（构建期整树复制 + 打补丁，**不在本仓库手改**），
 * 它自己有若干与插件无关的类型错误（three 替身、上游遗留写法）；这些不该让插件的
 * 类型门禁变红，也不该被修（改了下次 `pnpm vendor` 就被覆盖）。
 *
 * 所以这里用 TypeScript 编译器 API 跑同一份 tsconfig，把诊断按
 * `src/` 与 `vendor/` 分开：src 有任何一条就 exit 1，vendor 只打印计数。
 *
 * 在进程内跑（不起子进程）：workspace-write 沙箱下 Node 的 spawn 管道会被拒
 * （EPERM），进程内 API 不受影响。
 */
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'tsconfig.typecheck.json');

const read = ts.readConfigFile(configPath, ts.sys.readFile);
if (read.error) {
  console.error(ts.formatDiagnostics([read.error], formatHost()));
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath);
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: parsed.options,
  projectReferences: parsed.projectReferences,
});
const diagnostics = ts.getPreEmitDiagnostics(program);

const srcPrefix = join(root, 'src') + sep;
const isSrc = (diagnostic) =>
  Boolean(diagnostic.file) && resolve(diagnostic.file.fileName).startsWith(srcPrefix);
const configDiagnostics = diagnostics.filter((diagnostic) => !diagnostic.file);
const srcDiagnostics = diagnostics.filter(isSrc);
const vendorDiagnostics = diagnostics.filter(
  (diagnostic) => diagnostic.file && !isSrc(diagnostic),
);

for (const diagnostic of [...configDiagnostics, ...srcDiagnostics]) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost()) + '\n');
}

console.log(
  `typecheck: src ${srcDiagnostics.length} error(s)` +
    `, vendor ${vendorDiagnostics.length} ignored` +
    `（vendor 是上游源码，不进门禁）`,
);
process.exit(configDiagnostics.length + srcDiagnostics.length === 0 ? 0 : 1);

function formatHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  };
}
