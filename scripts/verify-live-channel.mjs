/**
 * 真机联调（不进回归）：拿本机 `cloud-channels.json` 里**第一条真实通道**（端点 + 密钥），
 * 用 host 半的通道链路走一遍「读模型列表 → 存通道 → 生成一张图 → 结果落素材库」，
 * 验证请求翻译与**异步任务轮询**真的通。
 *
 * 只写临时 DSH_HOME，不动真实数据目录；会消耗端点的一次额度
 * （2026-10-16 实测魔搭：36 个模型，Qwen/Qwen-Image 约 30 秒出图）。
 * v1.13 起旧版单端点（cloud-keys.json 里的 AIFISHER_CLOUD_BASE_URL）已移除，所以这里改读通道表。
 *
 * 用法：node scripts/verify-live-channel.mjs [模型 ID]
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startHost } from './lib/canvas-harness.mjs';

const REAL_CHANNELS = join(
  process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'),
  'storages',
  'dsh-aifisher-canvas',
  'cloud-channels.json',
);
const stored = JSON.parse(readFileSync(REAL_CHANNELS, 'utf8'));
const channel = (stored.channels ?? [])[0] ?? {};
const baseUrl = String(channel.baseUrl ?? '').trim();
const apiKey = String(channel.apiKey ?? '').trim();
const firstImageModel = (channel.models ?? []).find((item) => item.kind === 'image')?.id;
const modelId = process.argv[2] ?? firstImageModel ?? 'Qwen/Qwen-Image';
if (!baseUrl || !apiKey) {
  console.error(
    `cloud-channels.json 里第一条通道缺 baseUrl / apiKey（读的是 ${REAL_CHANNELS}）——` +
      '请先到「设置 → 闭源服务 → OpenAI 通道」里建一条通道。',
  );
  process.exit(1);
}
console.log(`端点：${baseUrl}（通道「${channel.label ?? channel.id ?? '未命名'}」）`);
console.log(`模型：${modelId}`);

const host = await startHost({ env: { ARK_API_KEY: null } });
const api = (method, path, body) => host.hostApi(method, path, body);

const probe = await api('POST', '/cloud-channels', { action: 'probe', baseUrl, apiKey });
const probeBody = probe.json();
console.log(`\n读模型列表：HTTP ${probe.status}，${probeBody.models?.length ?? 0} 个模型`);
if (!(probeBody.models ?? []).includes(modelId)) {
  console.log(`（清单里没有 ${modelId}，仍然试一发）`);
}

const label = '真机联调通道';
const saved = await api('POST', '/cloud-channels', {
  action: 'save',
  channel: {
    label,
    baseUrl,
    apiKey,
    models: [{ id: modelId, kind: 'image' }],
  },
});
console.log(`存通道：HTTP ${saved.status} ${saved.text.slice(0, 160)}`);

const startedAt = Date.now();
const generated = await host.dispatch('POST', '/api/aifisher/canvas/generate-image', {
  projectId: 'verify-live',
  prompt: '一只戴帽子的橘猫，扁平插画风，纯色背景',
  imageModel: `${label} · ${modelId}`,
  resolution: '1K',
  aspectRatio: '1:1',
});
const body = JSON.parse(generated.body);
console.log(`\n生成：HTTP ${generated.status}，用了 ${Math.round((Date.now() - startedAt) / 1000)}s`);
console.log(generated.body.slice(0, 400));
if (body.resultUrl) {
  const rel = decodeURIComponent(
    String(body.resultUrl).split('?')[0].replace('/api/aifisher/canvas/media/', ''),
  );
  const file = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', ...rel.split('/'));
  console.log(`结果落盘：${existsSync(file) ? '是' : '否'} → ${file}`);
}
rmSync(host.fakeHome, { recursive: true, force: true });
process.exit(generated.status === 200 ? 0 : 1);
