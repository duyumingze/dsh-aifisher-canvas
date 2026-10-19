/**
 * preview（视觉回读）回归（v1.56）：验证 agent 能拿到生成结果的本机文件路径。
 *
 * 背景（2026-10-20「更智能的画布助手」P0 第三项）：
 *   生成完成后 agent 只能看到节点状态，看不到画面。preview 把节点上的
 *   resultUrl/resultUrls（媒体库 URL）解析成本机绝对路径，agent 再用 read_image 看图。
 *
 * 本套件验证：
 *   1. 有 resultUrl 的节点返回 kind:"file" + 绝对路径，且路径真实存在；
 *   2. 没有结果的节点不出现在列表里；
 *   3. nodeIds 过滤生效（只回指定节点）；
 *   4. 指向不存在文件的 URL 返回 kind:"missing"；
 *   5. preview 不改画布（节点数不变）。
 *
 * 用法：node scripts/test-canvas-preview.mjs   （需要先 build）
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
const projectId = 'preview-proj';

// 预置一张"生成结果"：媒体库目录里放真实文件，节点上挂 resultUrl
const mediaDir = join(host.fakeHome, 'storages', 'dsh-aifisher-canvas', 'media', projectId, 'images');
mkdirSync(mediaDir, { recursive: true });
const resultFile = join(mediaDir, 'result-a.png');
writeFileSync(resultFile, Buffer.from('fake-png-bytes'));
const resultUrl = `/api/aifisher/canvas/media/${projectId}/images/result-a.png`;
const missingUrl = `/api/aifisher/canvas/media/${projectId}/images/not-there.png`;

{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '预览验证',
    nodes: [
      {
        id: 'node-result',
        type: 'Image',
        x: 0,
        y: 0,
        title: '结果节点',
        status: 'success',
        resultUrl,
        resultUrls: [resultUrl],
      },
      {
        id: 'node-missing',
        type: 'Image',
        x: 500,
        y: 0,
        title: '丢失节点',
        status: 'success',
        resultUrl: missingUrl,
      },
      { id: 'node-empty', type: 'Image', x: 1000, y: 0, title: '空节点', status: 'idle' },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置项目已写入本地后端', save.status === 200, JSON.stringify(save.json()).slice(0, 160));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(1500);

const tool = host.tool('canvas_control');
check('canvas_control 工具已注册', Boolean(tool));
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-preview' } } });

// ---------------------------------------------------------------- 1. 解析结果文件

{
  const preview = await run({ action: 'preview' });
  check('preview 调用成功', preview.ok === true, JSON.stringify(preview).slice(0, 220));
  const nodes = Array.isArray(preview.result?.nodes) ? preview.result.nodes : [];
  check('有结果的节点出现在列表里（空节点被跳过）', nodes.length === 2, JSON.stringify(nodes.map((node) => node.nodeId)));
  const result = nodes.find((node) => node.nodeId === 'node-result');
  const media = result?.media?.[0];
  check(
    '结果节点返回 kind:"file" 与真实存在的绝对路径',
    media?.kind === 'file' && media?.path === resultFile && media?.type === 'images',
    JSON.stringify(media),
  );
  const missing = nodes.find((node) => node.nodeId === 'node-missing')?.media?.[0];
  check('指向不存在文件的 URL 返回 kind:"missing"', missing?.kind === 'missing', JSON.stringify(missing));
}

// ---------------------------------------------------------------- 2. nodeIds 过滤

{
  const preview = await run({ action: 'preview', nodeIds: ['node-empty'] });
  const nodes = Array.isArray(preview.result?.nodes) ? preview.result.nodes : [];
  check('nodeIds 过滤后无结果节点返回空列表', preview.ok === true && nodes.length === 0, JSON.stringify(nodes));

  const only = await run({ action: 'preview', nodeIds: ['node-result'] });
  const filtered = Array.isArray(only.result?.nodes) ? only.result.nodes : [];
  check('nodeIds 过滤只回指定节点', filtered.length === 1 && filtered[0].nodeId === 'node-result', JSON.stringify(filtered));
}

// ---------------------------------------------------------------- 3. preview 不改画布

{
  const read = await run({ action: 'read' });
  const nodes = Array.isArray(read.result?.nodes) ? read.result.nodes : [];
  check('preview 之后画布节点数不变', nodes.length === 3, `nodes=${nodes.length}`);
}

// ---------------------------------------------------------------- 4. 无运行时错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('预览链路全程无运行时错误', errors.length === 0, errors.map((entry) => entry.message).join(' | ') || '(none)');
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
