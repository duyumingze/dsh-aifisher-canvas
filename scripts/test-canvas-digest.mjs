/**
 * 项目摘要（view:"digest"）回归（v1.54）：验证画布助手能一次调用看懂项目全貌。
 *
 * 背景（2026-10-20「更智能的画布助手」规划 P0 第一项）：
 *   read 默认返回节点列表（正文截断到 240 字），39 个节点仍要模型自己数类型、
 *   数连线、判断哪些节点缺提示词。digest 把这些直接算好，模型不再做统计工作。
 *
 * 本套件验证：
 *   1. view:"digest" 返回 counts / edgeCount / groups / selectedNodeIds / hints；
 *   2. digest 节点条目不带正文，只带 promptChars / textChars；
 *   3. hints 能点出「缺提示词」「孤立节点」；
 *   4. 默认 read 行为不变（仍有 textContent 且截断）；
 *   5. digest 之后照常 edit（revision 在顶层，可直接用）。
 *
 * 用法：node scripts/test-canvas-digest.mjs   （需要先 build）
 */
import { mountCanvasApp, createCanvasDom, seedResume, settle, startHost, ROOT } from './lib/canvas-harness.mjs';
import { rmSync } from 'node:fs';

void ROOT;
const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const host = await startHost();
const projectId = 'digest-proj';

{
  const save = await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '项目摘要验证',
    nodes: [],
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
const run = (args) => tool.execute(args, { agent: { session: { id: 'sess-digest' } } });

const longText = '雨夜便利店。'.repeat(100); // 600 字

// ---------------------------------------------------------------- 准备画布：文本 + 两张图 + 连线 + 分组

{
  const edit = await run({
    action: 'edit',
    operations: [
      { kind: 'create', ref: 'text', type: 'Text', x: 0, y: 0, title: '剧本', text: longText },
      { kind: 'create', ref: 'img1', type: 'Image', x: 500, y: 0, title: '镜头1', prompt: '雨夜便利店，暖黄灯光' },
      { kind: 'create', ref: 'img2', type: 'Image', x: 900, y: 0, title: '镜头2' },
      { kind: 'connect', sourceId: 'text', targetId: 'img1' },
      { kind: 'group', ref: 'g', nodeIds: ['text', 'img1'], label: '第一组' },
    ],
  });
  check('预置节点/连线/分组成功', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 260));
}

// ---------------------------------------------------------------- 1. digest 统计与结构

{
  const read = await run({ action: 'read', view: 'digest' });
  const result = read.result ?? {};
  const digest = result.digest ?? {};
  check('digest 视图返回 view:"digest"', result.view === 'digest', JSON.stringify(result.view));
  check(
    'digest 统计节点数与类型',
    digest.counts?.nodes === 3 && digest.counts?.byType?.Text === 1 && digest.counts?.byType?.Image === 2,
    JSON.stringify(digest.counts),
  );
  check('digest 统计连线数', digest.edgeCount === 1, JSON.stringify(digest.edgeCount));
  check(
    'digest 带出分组',
    Array.isArray(digest.groups) && digest.groups.length === 1 && digest.groups[0].label === '第一组',
    JSON.stringify(digest.groups),
  );
  check(
    'digest 带出选中节点数组',
    Array.isArray(digest.selectedNodeIds),
    JSON.stringify(digest.selectedNodeIds),
  );
  check(
    'digest 不返回原始 nodes/groups（避免全量正文回传）',
    result.nodes === undefined && result.groups === undefined,
    JSON.stringify({ nodes: Array.isArray(result.nodes), groups: Array.isArray(result.groups) }),
  );
  check(
    'digest 节点条目不带正文，只有 promptChars/textChars',
    Array.isArray(digest.nodes) &&
      digest.nodes.every((node) => !('textContent' in node) && !('prompt' in node)) &&
      digest.nodes.find((node) => node.title === '剧本')?.textChars === longText.length,
    JSON.stringify(digest.nodes?.map((node) => [node.title, node.textChars, node.promptChars])),
  );
  check(
    'digest 顶部提示去 view:"nodes" 看细节',
    typeof digest.hint === 'string' && digest.hint.includes('view:"nodes"'),
    JSON.stringify(digest.hint),
  );
}

// ---------------------------------------------------------------- 2. hints 能指出缺提示词与孤立节点

{
  const read = await run({ action: 'read', view: 'digest' });
  const hints = read.result?.digest?.hints ?? [];
  check(
    'hints 指出有生成节点缺提示词',
    hints.some((hint) => hint.includes('提示词')),
    JSON.stringify(hints),
  );
  check(
    'hints 指出孤立节点',
    hints.some((hint) => hint.includes('孤立')),
    JSON.stringify(hints),
  );
}

// ---------------------------------------------------------------- 3. 默认 read 行为不变

{
  const read = await run({ action: 'read' });
  const nodes = Array.isArray(read.result?.nodes) ? read.result.nodes : [];
  const text = nodes.find((node) => node.title === '剧本');
  check('默认 read 仍返回节点列表', nodes.length === 3, JSON.stringify(nodes.length));
  check(
    '默认 read 仍保留正文并截断到约 240 字',
    typeof text?.textContent === 'string' &&
      text.textContent.length <= 241 &&
      text.textTruncated === true,
    String(text?.textContent?.length),
  );
  check('默认 read 不带 digest 字段', read.result?.digest === undefined, JSON.stringify(read.result?.digest));
}

// ---------------------------------------------------------------- 4. digest 之后照常 edit

{
  const read = await run({ action: 'read', view: 'digest' });
  const revision = read.result?.revision;
  const edit = await run({
    action: 'edit',
    revision,
    operations: [{ kind: 'create', ref: 'img3', type: 'Image', x: 1300, y: 0, title: '镜头3', prompt: '空镜' }],
  });
  check('digest 返回的 revision 可直接用于 edit', edit.ok === true && edit.result?.ok === true, JSON.stringify(edit).slice(0, 200));
  const after = await run({ action: 'read', view: 'digest' });
  check('edit 后 digest 统计同步更新', after.result?.digest?.counts?.nodes === 4, JSON.stringify(after.result?.digest?.counts));
}

// ---------------------------------------------------------------- 5. 无运行时错误

{
  const diag = (await host.hostApi('GET', '/diagnostics?limit=100')).json();
  const errors = (diag.entries ?? []).filter((entry) => entry.level === 'error');
  check('摘要链路全程无运行时错误', errors.length === 0, errors.map((entry) => entry.message).join(' | ') || '(none)');
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
