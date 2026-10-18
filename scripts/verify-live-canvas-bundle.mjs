/**
 * 真机核对：正在跑的 DSH 下发的画布产物，是不是刚构建的那一份。
 *
 * 为什么要单独一条：画布半（`lib/canvas/canvas-app.js`）是 host 挂在
 * `/api/aifisher/canvas-app/canvas-app.js` 上、带 `no-store` 现读现给的，
 * **改完刷新页面就生效，不用重启 DSH**。但「刷新就好」这句话得证明给人看：
 * 这里取本机授权 cookie，直接问正在跑的服务要这份字节，跟磁盘上的构建产物比 sha256。
 *
 * 两个候选目录都认：开发工作区与已装插件（desktop profile 用 junction 挂 D:，DSH 加载的是
 * 后者）。两处各自构建时 lightningcss 对 `rounded-full` 的取整写法不同
 * （`3.40282e38px` vs `2147483647px`，都是「无穷大圆角」，视觉等价），所以 sha 不等时
 * 还会再做一次「把这两串归一化后再比」的等价判定。
 *
 * 用法：node scripts/verify-live-canvas-bundle.mjs
 * 退出码：0 = 一致（或仅差 rounded-full 取整写法）；1 = 取不到或不一致。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localAuthCookie } from './lib/dsh-live-auth.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REL = join('lib', 'canvas', 'canvas-app.js');
const INSTALL_ROOT =
  process.env.AIFISHER_CANVAS_INSTALL ?? 'D:/AllAssets/DSH插件/dsh-aifisher-canvas';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
/** 两处构建链对 `rounded-full` 的取整写法不同，视觉等价；比等价时先归一化。 */
const normalize = (text) =>
  text.replaceAll('3.40282e38px', 'ROUNDED_FULL').replaceAll('2147483647px', 'ROUNDED_FULL');

const candidates = [ROOT, INSTALL_ROOT].filter((dir) => existsSync(join(dir, REL)));
if (!candidates.length) {
  console.error(`[verify-live-bundle] 没有构建产物：${REL}（先跑构建链）`);
  process.exit(1);
}

const auth = localAuthCookie();
if (!auth) {
  console.error('[verify-live-bundle] 拿不到本机授权 cookie（$DSH_HOME/.credentials.yaml 或运行记录缺失）');
  process.exit(1);
}

const url = `${auth.url}/api/aifisher/canvas-app/canvas-app.js`;
let served;
try {
  const response = await fetch(url, { headers: { cookie: `${auth.name}=${auth.value}` } });
  if (!response.ok) {
    console.error(`[verify-live-bundle] ${url} → HTTP ${response.status}`);
    process.exit(1);
  }
  served = Buffer.from(await response.arrayBuffer());
} catch (error) {
  console.error(`[verify-live-bundle] 取不到 ${url}：${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const servedSha = sha256(served);
const servedText = served.toString('utf8');
console.log(`[verify-live-bundle] 服务：${auth.url}`);
console.log(`[verify-live-bundle] 下发：${served.byteLength}B sha256=${servedSha}`);

let verdict = null;
for (const dir of candidates) {
  const disk = readFileSync(join(dir, REL));
  const diskSha = sha256(disk);
  const exact = diskSha === servedSha;
  const equivalent = !exact && normalize(disk.toString('utf8')) === normalize(servedText);
  console.log(
    `[verify-live-bundle] 磁盘：${dir} ${disk.byteLength}B sha256=${diskSha}` +
      ` → ${exact ? '完全一致' : equivalent ? '等价（只差 rounded-full 取整写法）' : '不一致'}`,
  );
  if (exact) verdict = { dir, exact: true };
  else if (equivalent && !verdict) verdict = { dir, exact: false };
}

if (verdict) {
  console.log(
    `[verify-live-bundle] PASS —— 刷新画布页拿到的就是 ${verdict.dir} 这份构建产物` +
      (verdict.exact ? '' : '（rounded-full 取整写法差异，视觉等价）'),
  );
  process.exit(0);
}
console.log('[verify-live-bundle] FAIL —— 服务端下发的不是磁盘上任何一份构建产物');
process.exit(1);
