/**
 * 真机联调（不进回归）：走 **host 链路**真的用魔搭（ModelScope）出图，并证明
 * 「画布挂的参考图真的被用上了」。
 *
 * 为什么需要它：魔搭的图像端点对参考图字段**静默挑剔** —— 用 OpenAI 形状的 `image` 时它不报错、
 * 不回 400，直接把参考图丢掉按纯文生图跑完。这种故障在日志里一个字都看不出来，只能靠**颜色**量。
 *
 * 判据（**配对**，不是绝对阈值 —— 2026-10-17 实测发现「保持原样」这类 prompt 偶尔会被模型重画，
 * 单看一次输出的红色比例会抖）：
 *   同一个 prompt（一个字都不提颜色）配两张参考图，一张纯红、一张纯绿，都走魔搭方言：
 *     - 参考图被用上 → 红那张的输出以红通道为主、绿那张以绿通道为主（各自领先 ≥ 20）；
 *     - 参考图被丢掉 → 两张都是「按 prompt 纯文生图」的同一分布，不可能各自跟着自己的参考图。
 *   画布送参考图的方式正是**本站素材内联成 data URL**（外部端点访问不到我们的素材 URL），
 *   所以这里也照那个形状送。
 *
 * 只写临时 DSH_HOME，不动真实数据目录；会消耗端点额度（默认 3 次：红 + 绿 + 一次 openai 方言对照）。
 * 用法：node scripts/verify-live-modelscope.mjs [模型 ID] [--no-control]
 *       （模型 ID 缺省 = 本机通道里第一条 image 模型，再缺省 Qwen/Qwen-Image-2.1-Turbo）
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
/** 优先挑魔搭那条（baseUrl 里带 modelscope），否则用第一条。 */
const channel =
  channels.find((item) => /modelscope\.cn$/i.test(new URL(item.baseUrl).hostname)) ?? channels[0] ?? {};
const baseUrl = String(channel.baseUrl ?? '').trim();
const apiKey = String(channel.apiKey ?? '').trim();
const args = process.argv.slice(2).filter((item) => !item.startsWith('--'));
const withControl = !process.argv.includes('--no-control');
const modelId =
  args[0] ??
  (channel.models ?? []).find((item) => item.kind === 'image')?.id ??
  'Qwen/Qwen-Image-2.1-Turbo';
if (!baseUrl || !apiKey) {
  console.error(
    `cloud-channels.json 里没有可用通道（读的是 ${REAL_CHANNELS}）—— ` +
      '请先到「设置 → 闭源服务 → OpenAI 通道」里加一条魔搭通道。',
  );
  process.exit(1);
}
console.log(`端点：${baseUrl}（通道「${channel.label ?? channel.id ?? '未命名'}」）`);
console.log(`模型：${modelId}`);

/** 一个字都不提颜色的 prompt：输出的颜色只能来自参考图。 */
const PROMPT = '保持这张图片的内容、构图与颜色完全不变，原样输出';
const RED = [235, 20, 20];
const GREEN = [20, 200, 60];
const referenceOf = (color) =>
  `data:image/png;base64,${encodeSolidPng(512, 512, color).toString('base64')}`;
console.log(`参考图：纯色 512×512 的 data URL（${referenceOf(RED).length} 字符）`);

const host = await startHost({ env: { ARK_API_KEY: null } });
const api = (method, path, body) => host.hostApi(method, path, body);
const label = '真机魔搭';

/** 输出里最强的通道与它的领先幅度（纯粹看「颜色跟没跟着参考图走」）。 */
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
  const { dialect, color, name, expect } = input;
  const saved = await api('POST', '/cloud-channels', {
    action: 'save',
    channel: {
      id: 'live-modelscope',
      label,
      baseUrl,
      apiKey,
      dialect,
      models: [{ id: modelId, kind: 'image' }],
    },
  });
  console.log(`\n============ 方言 = ${dialect} · 参考图 = ${name} ============`);
  console.log(`存通道：HTTP ${saved.status}`);
  const started = Date.now();
  const generated = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
    projectId: 'verify-live-modelscope',
    prompt: PROMPT,
    imageModel: `${label} · ${modelId}`,
    resolution: '512',
    aspectRatio: '1:1',
    imageBase64: [referenceOf(color)],
  });
  const body = JSON.parse(generated.body);
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`生成：HTTP ${generated.status}，用了 ${seconds}s | 回执 channelDialect=${body.channelDialect}`);
  if (generated.status !== 200 || !body.resultUrl) {
    console.log(`回执原文：${generated.body.slice(0, 240)}`);
    return { dialect, name, expect, ok: false, detail: generated.body.slice(0, 200) };
  }
  const rel = decodeURIComponent(
    String(body.resultUrl).split('?')[0].replace('/api/aifisher/canvas/media/', ''),
  );
  const file = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', ...rel.split('/'));
  if (!existsSync(file)) return { dialect, name, expect, ok: false, detail: `结果没落盘：${file}` };
  const stats = rgbStats(decodePngRgb(file));
  const top = dominant(stats);
  console.log(
    `结果落盘：${file}\n平均 RGB=${JSON.stringify(stats.mean)} 主色=${top.channel}（领先 ${top.margin}）` +
      ` 近红=${stats.nearRed} 近绿=${stats.nearGreen}`,
  );
  return { dialect, name, expect, ok: true, seconds, stats, top, file };
}

const cases = [
  { dialect: 'modelscope', color: RED, name: '红', expect: 'R' },
  { dialect: 'modelscope', color: GREEN, name: '绿', expect: 'G' },
  ...(withControl ? [{ dialect: 'openai', color: RED, name: '红', expect: 'R' }] : []),
];
const results = [];
for (const item of cases) results.push(await runCase(item));

console.log('\n================ 台账 ================');
let failed = false;
for (const item of results) {
  if (!item.ok) {
    console.log(`${item.dialect.padEnd(11)} ${item.name}  ${item.detail}`);
    failed = true;
    continue;
  }
  const followed = item.top.channel === item.expect && item.top.margin >= 20;
  // 只有魔搭方言那两条是硬判据；openai 那条是**对照**（它本该丢掉参考图）
  const hard = item.dialect === 'modelscope';
  if (hard && !followed) failed = true;
  console.log(
    `${item.dialect.padEnd(11)} ${item.name}  主色=${item.top.channel}（领先 ${item.top.margin}）` +
      `  平均RGB=${JSON.stringify(item.stats.mean)}  ${item.seconds}s` +
      `  → ${followed ? '颜色跟着参考图' : '颜色没跟着参考图'}` +
      `${hard ? (followed ? '' : ' ← 判 FAIL') : '（对照，不计成败）'}`,
  );
}
const msCases = results.filter((item) => item.dialect === 'modelscope');
console.log(
  failed || msCases.length < 2
    ? '\nFAIL：魔搭通道没有把画布的参考图送到位（检查 host 半是否已重建、通道方言是否被写成了 openai）。'
    : '\nPASS：魔搭通道在 host 链路上把画布的参考图正确送进了 image_url ——' +
        '两张不同颜色的参考图各自把输出带成了自己的颜色（图生图有效）。',
);
rmSync(host.fakeHome, { recursive: true, force: true });
process.exit(failed ? 1 : 0);