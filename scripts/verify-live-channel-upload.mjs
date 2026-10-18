/**
 * 真机联调（不进回归、**不花额度**）：只验 FisherAI 参考素材那一步 ——
 * 「画布素材 → 本机字节 → POST {base}/files/upload → 公网直链」。
 *
 * 为什么单独一条：v1.30 起这条路是生成前的必经步骤，而它**偶发会被链路掐断**
 * （2026-10-17 用户截图：「上传参考素材到通道「Fisher」失败：fetch failed（ECONNRESET）」）。
 * 上传本身免费、可安全重放，所以这条探针也免费：
 *   - 用真实的 work-fisher 通道 + 真实的素材字节（缺省取素材库里最新的一张图）；
 *   - 提交时故意用一个**不存在的模型 ID** —— 对端一律 503「No available channel for model」，
 *     一分钱都不扣；能走到这一步就说明「上传已经成功、链接已经拿到」。
 *
 * 用法：node scripts/verify-live-channel-upload.mjs [参考图路径]
 * 退出码：0 = 上传这一步通了；1 = 上传没通（看打印的原因）。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { startHost } from './lib/canvas-harness.mjs';

const REAL_ROOT = join(
  process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'),
  'storages',
  'dsh-aifisher-canvas',
);
const stored = JSON.parse(readFileSync(join(REAL_ROOT, 'cloud-channels.json'), 'utf8'));
const isFisher = (channel) => {
  try {
    const host = new URL(String(channel.baseUrl ?? '')).hostname.toLowerCase();
    return host === 'work-fisher.com' || host.endsWith('.work-fisher.com');
  } catch {
    return false;
  }
};
const channel = (stored.channels ?? []).find(isFisher);
if (!channel) {
  console.error('cloud-channels.json 里没有 work-fisher 通道 —— 先到「设置 → 闭源服务」加一条 FisherAI。');
  process.exit(1);
}

/** 命令行给的路径优先；否则取素材库里最新的一张图（真机报障用的就是它）。 */
function latestLibraryImage() {
  const mediaDir = join(REAL_ROOT, 'media');
  if (!existsSync(mediaDir)) return null;
  let best = null;
  for (const project of readdirSync(mediaDir)) {
    const imagesDir = join(mediaDir, project, 'images');
    if (!existsSync(imagesDir)) continue;
    for (const name of readdirSync(imagesDir)) {
      if (!/\.(png|jpe?g|webp)$/i.test(name)) continue;
      const file = join(imagesDir, name);
      const info = statSync(file);
      if (!best || info.mtimeMs > best.mtimeMs) best = { file, mtimeMs: info.mtimeMs };
    }
  }
  return best?.file ?? null;
}
const referenceFile = process.argv.slice(2).find((item) => !item.startsWith('--')) ?? latestLibraryImage();
if (!referenceFile || !existsSync(referenceFile)) {
  console.error('找不到参考图：命令行给一个路径，或先在画布上生成/上传一张图。');
  process.exit(1);
}
const bytes = readFileSync(referenceFile);
const extension = extname(referenceFile).toLowerCase();
const mime = extension === '.webp' ? 'image/webp' : extension === '.png' ? 'image/png' : 'image/jpeg';
console.log(`通道：${channel.label}（${channel.baseUrl}）`);
console.log(
  `参考图：${referenceFile}（${(bytes.length / 1024 / 1024).toFixed(2)}MB，${mime}）`,
);

const host = await startHost({ env: { ARK_API_KEY: null } });
const label = '真机上传探针';
const probeModel = 'aifisher-canvas-upload-probe';
const saved = await host.hostApi('POST', '/cloud-channels', {
  action: 'save',
  channel: {
    id: 'live-upload-probe',
    label,
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    // 本机测的是「上传那一步」，方言写死成 workfisher，别受地址自动判定影响
    dialect: 'workfisher',
    models: [{ id: probeModel, kind: 'image' }],
  },
});
if (saved.status !== 200) {
  console.error(`存探针通道失败：HTTP ${saved.status} ${saved.body.slice(0, 200)}`);
  process.exit(1);
}

const started = Date.now();
const generated = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
  projectId: 'verify-live-upload',
  prompt: '只验上传这一步（不会真的出图）',
  imageModel: `${label} · ${probeModel}`,
  resolution: '1K',
  aspectRatio: '1:1',
  imageBase64: [`data:${mime};base64,${bytes.toString('base64')}`],
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);
let body = {};
try {
  body = JSON.parse(generated.body);
} catch {
  body = { raw: String(generated.body).slice(0, 400) };
}
console.log(`链路：HTTP ${generated.status} in ${seconds}s code=${body.code ?? '(none)'}`);
if (body.error) console.log(`回执：${String(body.error).slice(0, 300)}`);
if (body.hint) console.log(`提示：${String(body.hint).slice(0, 200)}`);

const uploadFailed = body.code === 'CHANNEL_UPLOAD_UNREACHABLE' || body.code === 'CHANNEL_UPLOAD_REJECTED';
console.log(
  uploadFailed
    ? '\nFAIL：参考素材上传这一步没通（看上面的原因与「试了几次」；若一直是 ECONNRESET，' +
        '优先查这台机器到该域名的代理/VPN）。'
    : `\nPASS：参考素材已经传成公网直链（${seconds}s 内走完了 /files/upload）。` +
        '后面那条「No available channel for model」是探针故意用的假模型，零成本、预期之内。',
);
await host.stop?.();
rmSync(host.fakeHome, { recursive: true, force: true });
process.exit(uploadFailed ? 1 : 0);
