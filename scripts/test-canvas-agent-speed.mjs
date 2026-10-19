/**
 * agent 提速回归（v1.52）：验证「对话控制画布」的四个减负点真的生效。
 *
 * 背景（2026-10-20 用户反馈「用对话控制画布太慢，效果不理想」）：
 *   - 每次操作要 read→edit→read 三次工具调用，模型往返太多；
 *   - read 回传全量节点（39 节点约 40KB），每轮都要重读；
 *   - 自配 OpenAI 通道不在 /generation/sources 里，prepareGeneration 恒 UNAVAILABLE。
 *
 * 本套件验证：
 *   1. edit 可以不带 revision（host 自动补），一次调用完成「读+改」；
 *   2. edit 成功回带精简 snapshot（省掉验证用的 read）；
 *   3. read 默认截断长正文并提示 detail:"full"；带 detail:"full" 时原样返回；
 *   4. /generation/sources 带上自配通道 block（模型名 = 画布显示名、configured=true、
 *      且不暴露密钥输入）；**审批仍然只在画布 UI**（本套件不碰 approve）。
 *
 * 用法：node scripts/test-canvas-agent-speed.mjs   （需要先 build）
 */
import { mountCanvasApp, createCanvasDom, seedResume, settle, startHost, ROOT } from './lib/canvas-harness.mjs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

void ROOT;
const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const host = await startHost();
const projectId = 'agent-speed-proj';

{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: 'agent 提速验证',
    nodes: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, JSON.stringify(save.json()).slice(0, 160));
}

// 自配通道：写一份通道表，验证 /generation/sources 会把它合成只读 block。
{
  const dataDir = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'cloud-channels.json'),
    JSON.stringify({
      version: 1,
      channels: [
        {
          id: 'speed-channel',
          label: '测速通道',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test-only',
          paths: {},
          timeoutMs: 900000,
          models: [{ id: 'speed-image-model', kind: 'image', label: '测速图模型' }],
        },
      ],
    }),
    'utf8',
  );
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(1500);

const tool = host.tool('canvas_control');
check('canvas_control 工具已注册', Boolean(tool));
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-speed' } } });

// ---------------------------------------------------------------- 1. edit 免 revision + 回带 snapshot

const longText = '雨夜便利店。'.repeat(100); // 600 字
let nodeId = '';
{
  const edit = await run({
    action: 'edit',
    operations: [
      { kind: 'create', ref: 'long', type: 'Text', x: 100, y: 100, title: '长文本', text: longText },
    ],
  });
  check(
    'edit 允许省略 revision（host 自动补）',
    edit.ok === true && edit.result?.ok === true,
    JSON.stringify(edit).slice(0, 260),
  );
  nodeId = String((edit.result?.created ?? []).find((item) => item.ref === 'long')?.id ?? '');
  check('edit 回带 created 映射', Boolean(nodeId), JSON.stringify(edit.result?.created));
  check(
    'edit 成功回带 snapshot（省掉验证 read）',
    Array.isArray(edit.result?.snapshot?.nodes) && edit.result.snapshot.nodes.length === 1,
    JSON.stringify(edit.result?.snapshot?.nodes?.length),
  );
  const snapshotNode = (edit.result?.snapshot?.nodes ?? []).find((node) => node.id === nodeId);
  check(
    'snapshot 里的长正文已截断',
    typeof snapshotNode?.textContent === 'string' &&
      snapshotNode.textContent.length <= 161 &&
      snapshotNode.textTruncated === true,
    String(snapshotNode?.textContent?.length),
  );
}

// ---------------------------------------------------------------- 2. read 默认减重

{
  const read = await run({ action: 'read' });
  const node = (read.result?.nodes ?? []).find((item) => item.id === nodeId);
  check(
    'read 默认把长正文截断到约 240 字',
    typeof node?.textContent === 'string' &&
      node.textContent.length <= 241 &&
      node.textTruncated === true,
    String(node?.textContent?.length),
  );
  check(
    'read 顶部提示可用 detail:"full" 读全文',
    typeof read.result?.readSummary?.hint === 'string' &&
      read.result.readSummary.hint.includes('detail:"full"'),
    JSON.stringify(read.result?.readSummary).slice(0, 160),
  );
}

// ---------------------------------------------------------------- 3. detail:"full" 读全文

{
  const read = await run({ action: 'read', detail: 'full' });
  const node = (read.result?.nodes ?? []).find((item) => item.id === nodeId);
  check('read detail:"full" 返回完整正文', node?.textContent === longText, String(node?.textContent?.length));
  check('read detail:"full" 不带 readSummary 截断提示', read.result?.readSummary === undefined, JSON.stringify(read.result?.readSummary));
}

// ---------------------------------------------------------------- 4. /generation/sources 带上自配通道

{
  const sources = (await host.hostApi('GET', '/generation/sources')).json();
  const blocks = Array.isArray(sources?.blocks) ? sources.blocks : [];
  const channel = blocks.find((block) => block.source === 'channel:speed-channel');
  check('生成来源里出现自配通道 block', Boolean(channel), JSON.stringify(blocks.map((block) => block.source)));
  const imageModels =
    (channel?.media ?? []).find((media) => media.kind === 'image')?.models ?? [];
  const model = imageModels.find((item) => item.name === '测速图模型');
  check(
    '通道 block 的模型名是画布显示名且 configured',
    model?.configured === true,
    JSON.stringify(imageModels).slice(0, 200),
  );
  check(
    '通道 block 不暴露密钥输入（accountManaged + 空 secrets）',
    channel?.accountManaged === true && Array.isArray(channel?.secrets) && channel.secrets.length === 0,
    JSON.stringify({ accountManaged: channel?.accountManaged, secrets: channel?.secrets }),
  );
  check(
    '方舟 block 仍在（没有被通道替换掉）',
    blocks.some((block) => block.source === 'ark'),
    JSON.stringify(blocks.map((block) => block.source)),
  );
}

// ---------------------------------------------------------------- 全程无运行时错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('提速链路全程无运行时错误', errors.length === 0, errors.map((entry) => entry.message).join(' | ') || '(none)');
}

try {
  handle.dispose();
} catch {
  /* 卸载失败不影响本套件结论 */
}
rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
