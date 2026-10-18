/**
 * 真机联调（不进回归）：走 **host 链路**真的用 FisherAI（api.work-fisher.com）出图。
 *
 * 为什么必须单独跑一次真机：这套方言有三处**配错不报错**的地方，单测只能钉住我们发出去的形状 ——
 *   ① 路径 `/image/generations`（单数）：写错是网关 404，报错里看不出是路径问题；
 *   ② 尺寸是 `size:"16:9"` + `resolution:"1k"` 两件套，不是 `1024x576` 像素串；
 *   ③ 参考图**只收公网直链**：data URL / base64 传过去会被当没传，输出跟纯文生图一模一样。
 * 第 ③ 条只能靠颜色量：同一 prompt 配一张纯红参考图（prompt 里一个字不提颜色），
 * 输出若以红通道为主 → 参考图真的到了上游；否则说明上传那一步没生效。
 *
 * 会消耗端点额度（默认 2 次：一次纯文生图 + 一次带参考图的编辑）。
 * 只写临时 DSH_HOME，不动真实数据目录。
 *
 * 用法：node scripts/verify-live-workfisher.mjs [模型 ID]
 *       （模型 ID 缺省 = 本机 work-fisher 通道里第一条 image 模型）
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startHost } from './lib/canvas-harness.mjs';
import { decodePngRgb, encodeSolidPng, rgbStats } from './lib/png.mjs';

const REAL_CHANNELS = join(
  process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'),
  'storages',
  'dsh-aifisher-canvas',
  'cloud-channels.json',
);
const stored = JSON.parse(readFileSync(REAL_CHANNELS, 'utf8'));
const channels = stored.channels ?? [];
/** 优先挑 work-fisher 那条，否则用第一条（脚本会自己把方言写死成 workfisher）。 */
const isFisher = (channel) => {
  try {
    const host = new URL(String(channel.baseUrl ?? '')).hostname.toLowerCase();
    return host === 'work-fisher.com' || host.endsWith('.work-fisher.com');
  } catch {
    return false;
  }
};
const channel = channels.find(isFisher) ?? channels[0] ?? {};
const baseUrl = String(channel.baseUrl ?? '').trim();
const apiKey = String(channel.apiKey ?? '').trim();
const modelId =
  process.argv.slice(2).find((item) => !item.startsWith('--')) ??
  (channel.models ?? []).find((item) => item.kind === 'image')?.id ??
  'workfisher-image-g-v2.5-lowprice';
if (!baseUrl || !apiKey) {
  console.error(
    `cloud-channels.json 里没有可用通道（读的是 ${REAL_CHANNELS}）—— ` +
      '请先到「设置 → 闭源服务 → OpenAI 通道」里加一条 FisherAI 通道。',
  );
  process.exit(1);
}
console.log(`端点：${baseUrl}（通道「${channel.label ?? channel.id ?? '未命名'}」）`);
console.log(`模型：${modelId}`);

const RED = [235, 20, 20];
const reference = `data:image/png;base64,${encodeSolidPng(512, 512, RED).toString('base64')}`;
const host = await startHost({ env: { ARK_API_KEY: null } });
const api = (method, path, body) => host.hostApi(method, path, body);
const label = '真机 FisherAI';

const saved = await api('POST', '/cloud-channels', {
  action: 'save',
  channel: {
    id: 'live-workfisher',
    label,
    baseUrl,
    apiKey,
    // 方言写死：本机假通道的地址不是 work-fisher 域名，靠自动判定会落成 openai
    dialect: 'workfisher',
    models: [{ id: modelId, kind: 'image' }],
  },
});
console.log(`存通道：HTTP ${saved.status}`);

function dominant(stats) {
  const [r, g, b] = stats.mean;
  const ranked = [
    ['R', r],
    ['G', g],
    ['B', b],
  ].sort((a, b2) => b2[1] - a[1]);
  return { channel: ranked[0][0], margin: ranked[0][1] - ranked[1][1] };
}

async function runCase(input) {
  const { name, prompt, withReference, aspectRatio } = input;
  console.log(`\n============ ${name} ============`);
  const started = Date.now();
  const generated = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: 'verify-live-workfisher',
    prompt,
    imageModel: `${label} · ${modelId}`,
    resolution: '1K',
    aspectRatio,
    ...(withReference ? { imageBase64: [reference] } : {}),
  });
  const body = JSON.parse(generated.body);
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `生成：HTTP ${generated.status}，用了 ${seconds}s | channelDialect=${body.channelDialect} ` +
      `model=${body.model ?? '(none)'}`,
  );
  if (generated.status !== 200 || !body.resultUrl) {
    console.log(`回执原文：${generated.body.slice(0, 400)}`);
    return { name, ok: false, detail: generated.body.slice(0, 240) };
  }
  const rel = decodeURIComponent(
    String(body.resultUrl).split('?')[0].replace('/api/aifisher/canvas/media/', ''),
  );
  const file = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', ...rel.split('/'));
  if (!existsSync(file)) return { name, ok: false, detail: `结果没落盘：${file}` };
  const bytes = readFileSync(file);
  const isPng = bytes.subarray(0, 4).toString('hex') === '89504e47';
  console.log(`结果落盘：${file}（${bytes.length} 字节，${isPng ? 'PNG' : '非 PNG'}）`);
  if (!isPng) return { name, ok: true, seconds, top: null, stats: null, file };
  const stats = rgbStats(decodePngRgb(file));
  const top = dominant(stats);
  console.log(
    `平均 RGB=${JSON.stringify(stats.mean)} 主色=${top.channel}（领先 ${top.margin}）` +
      ` 近红=${stats.nearRed} 近绿=${stats.nearGreen}`,
  );
  return { name, ok: true, seconds, stats, top, file };
}

const results = [];
results.push(
  await runCase({
    name: '文生图（1K · 16:9）',
    prompt: 'A red ceramic teapot on a white table, product photo',
    withReference: false,
    aspectRatio: '16:9',
  }),
);
results.push(
  await runCase({
    // prompt 一个字都不提颜色：输出的颜色只能来自参考图
    name: '参考图编辑（纯红参考图）',
    prompt: '保持这张图片的内容、构图与颜色完全不变，原样输出',
    withReference: true,
    aspectRatio: '1:1',
  }),
);

console.log('\n================ 台账 ================');
let failed = false;
for (const item of results) {
  if (!item.ok) {
    console.log(`${item.name}  ${item.detail}`);
    failed = true;
    continue;
  }
  const follows = item.top ? item.top.channel === 'R' && item.top.margin >= 20 : null;
  const verdict = item.top
    ? item.name.includes('参考图')
      ? follows
        ? '颜色跟着参考图（上传直链这一步生效了）'
        : '颜色没跟着参考图 ← 判 FAIL'
      : '出图成功（纯文生图，不判颜色）'
    : '非 PNG，跳过颜色判定';
  console.log(
    `${item.name}  ${item.seconds}s  ` +
      (item.top ? `主色=${item.top.channel}（领先 ${item.top.margin}）→ ${verdict}` : verdict),
  );
  // 只有参考图那一例是硬判据（文生图那例只证明通道通、结果能落盘）
  if (item.name.includes('参考图') && follows === false) failed = true;
}
console.log(
  failed
    ? '\nFAIL：FisherAI 通道没走通（看上面 HTTP 码与回执原文：路径 /image/generations、' +
        'resolution 1k、参考图 /files/upload 三步里哪一步断的）。'
    : '\nPASS：FisherAI 通道在 host 链路上出图成功，且参考图真的到了上游' +
        '（纯红参考图把输出带成了红色）。',
);
rmSync(host.fakeHome, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
